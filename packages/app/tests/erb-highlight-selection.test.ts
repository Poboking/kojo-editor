// @vitest-environment happy-dom
/**
 * LAU-4 · ERB **同符号高亮 / 结构化扩选的宿主翻译层**闸（判据已整块搬进
 * `@kojo/erb-lang/highlight` / `/selection-range`，供方是插件 `@kojo/plugin-erb-lang`）。
 *
 * 判据本体（三档识别 / 位置门 / 扩选层级）在 `packages/erb-lang/tests/highlight.test.ts`
 * 与 `selection-range.test.ts`；供方的三态与**双向弃权**在 `packages/plugins/erb-lang/tests/
 * highlight-selection.test.ts`。本文件只钉宿主自己那一格：
 *
 * 1. **契约 → Monaco**：高亮单行区间 + 三档 `DocumentHighlightKind` 映射；扩选链按
 *    0.57 摊平成"每位点一个数组"（内 → 外）；
 * 2. **逐位点独立**：某位点 `null`（空链）⇒ 该位点 `[]`，别的位点一格不动；
 * 3. **三态不混**：无人应答 ⇒ provider 交 **`undefined`**（Monaco 对高亮按"第一应答"
 *    裁决，空数组会顶掉下一家）；有人答空 ⇒ `[]`；异常 ⇒ `[]`；
 * 4. **注册**：两枚都经 `registerForLanguageServices` 挂上，但 **DOUBLE-LEG-1032** 起
 *    带 `excludeNamed`——点名了该 kind 的语言（ERB / kojo2）由共享槽腿应答，本腿只留
 *    没点名的旧桥语言（`.kojo1`），dispose 幂等；源码里没有直挂 `ERB_LANGUAGE_ID`
 *    的原生注册形状、也不读切流开关；
 * 5. **与 kojo2 同一条槽**：两家真供方同时在槽里时，ERB 请求**只有 ERB 那家作答**
 *    （换哪一家在前都一样），kojo2 请求则由 kojo2 那家作答。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorLanguageServiceContribution, EditorSelectionChain } from '@kojo/plugin-api';
import type * as Monaco from '../src/monaco/entry';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import { languageDescriptors } from '../src/monaco/language-registry';
import { setGlobalKernel } from '../src/ui/editor-pane-registry';
import {
  installErbHighlightProvider,
  erbHighlightKindToMonaco,
} from '../src/monaco/erb-highlight';
import { installErbSelectionRangeProvider } from '../src/monaco/erb-selection-range';
import { ERB_LANGUAGE_IDS } from '@kojo/erb-lang/constants';
import { erbStructureOf } from '@kojo/erb-lang/highlight';
import {
  createErbLangPlugin,
  provideDocumentHighlights as provideErbHighlights,
  provideSelectionRanges as provideErbSelections,
} from '@kojo/plugin-erb-lang';
import { createKojoLangPlugin, provideDocumentHighlights as provideKojo2Highlights } from '@kojo/plugin-kojo-lang';

const HERE = import.meta.dirname;
const HIGHLIGHT_SOURCE = readFileSync(
  path.resolve(HERE, '..', 'src', 'monaco', 'erb-highlight.ts'),
  'utf8',
);
const SELECTION_SOURCE = readFileSync(
  path.resolve(HERE, '..', 'src', 'monaco', 'erb-selection-range.ts'),
  'utf8',
);

/* ============================== 共享收口的期望 selector ============================== */

/**
 * DOUBLE-LEG-1032（2026-10-31）：两枚安装器改带 `excludeNamed` 后，挂载面 = 旧桥语言里
 * **没点名**这一格的那些（今天只剩 `.kojo1`）；点名者（ERB / kojo2）由共享槽腿单独应答，
 * ERB 每一 kind 恰一枚 provider。判据仍是 descriptor 声明表，不写语言 id。
 */
const selectorsFor = (kind: 'documentHighlight' | 'selectionRange'): string[] =>
  languageDescriptors()
    .filter(
      (descriptor) =>
        descriptor.languageServices === true &&
        descriptor.slotServices?.includes(kind) !== true,
    )
    .map((descriptor) => descriptor.id);

const HIGHLIGHT_SELECTORS = selectorsFor('documentHighlight');
const SELECTION_SELECTORS = selectorsFor('selectionRange');

/* ============================== 假 Monaco / 假 model / 假内核 ============================== */

type ProviderKind = 'highlight' | 'selection';

const HIGHLIGHT_KINDS = { Text: 0, Read: 1, Write: 2 } as const;

interface Registration {
  readonly kind: ProviderKind;
  readonly selector: unknown;
  readonly provider: unknown;
}

function fakeMonaco(): {
  readonly monaco: typeof Monaco;
  readonly registrations: Registration[];
  readonly disposeCalls: () => number;
} {
  const registrations: Registration[] = [];
  let disposeCalls = 0;
  const register = (kind: ProviderKind) => (selector: unknown, provider: unknown) => {
    registrations.push({ kind, selector, provider });
    return {
      dispose: () => {
        disposeCalls += 1;
      },
    };
  };
  const fake = {
    languages: {
      DocumentHighlightKind: HIGHLIGHT_KINDS,
      registerDocumentHighlightProvider: register('highlight'),
      registerSelectionRangeProvider: register('selection'),
    },
  };
  return {
    monaco: fake as unknown as typeof Monaco,
    registrations,
    disposeCalls: () => disposeCalls,
  };
}

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
  readonly breakGetValue: () => void;
}

function fakeModel(source: string, languageId: string = ERB_LANGUAGE_ID): FakeModel {
  let broken = false;
  const model = {
    getValue: () => {
      if (broken) throw new Error('桩：模型已释放');
      return source;
    },
    getLanguageId: () => languageId,
    getVersionId: () => 11,
    uri: { scheme: 'file', path: '/proj/a.erb', fsPath: '/proj/a.erb' },
  } as unknown as Monaco.editor.ITextModel;
  return { model, breakGetValue: () => (broken = true) };
}

type KernelLike = Parameters<typeof setGlobalKernel>[0];

function installKernel(
  contributions: readonly EditorLanguageServiceContribution[],
  project: unknown = { adapterId: 'proj-a' },
): void {
  setGlobalKernel({
    slots: {
      query: (slot: string) => (slot === 'ui.editor.languageService' ? contributions : []),
    },
    project: { current: () => project },
  } as unknown as KernelLike);
}

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

function position(lineNumber: number, column: number): Monaco.Position {
  return { lineNumber, column } as unknown as Monaco.Position;
}

/** 一条贡献（`provide` 的返回由用例决定） */
function contributionOf(
  provide: EditorLanguageServiceContribution['provide'],
  id = 'stub-leg',
): EditorLanguageServiceContribution {
  return { id, provide };
}

/** 只答 `documentHighlight` 的贡献 */
function highlightContribution(
  highlights: ReadonlyArray<{
    line: number;
    startColumn: number;
    endColumn: number;
    kind: 'text' | 'read' | 'write';
  }>,
  id = 'stub-highlight',
): EditorLanguageServiceContribution {
  return contributionOf(
    (request) => (request.kind === 'documentHighlight' ? { kind: 'documentHighlight', highlights } : undefined),
    id,
  );
}

/** 只答 `selectionRange` 的贡献 */
function selectionContribution(
  selections: ReadonlyArray<EditorSelectionChain | null>,
  id = 'stub-selection',
): EditorLanguageServiceContribution {
  return contributionOf(
    (request) => (request.kind === 'selectionRange' ? { kind: 'selectionRange', selections } : undefined),
    id,
  ) as EditorLanguageServiceContribution;
}

/**
 * 取回本腿那枚 provider（没挂上直接抛：证据缺席不许静默）。
 * DOUBLE-LEG-1032 后锚点是 `kojo-legacy`（ERB 已点名让位，本腿不再挂 ERB）；
 * provider 是同一个对象，按 model 的 languageId 搬运/弃权的行为不因锚点而变。
 */
function providerOf(kind: ProviderKind): Record<string, unknown> {
  const fake = fakeMonaco();
  if (kind === 'highlight') installErbHighlightProvider(fake.monaco);
  else installErbSelectionRangeProvider(fake.monaco);
  const provider = fake.registrations.find((entry) => entry.selector === KOJO_LANGUAGE_ID)?.provider;
  if (provider === undefined) throw new Error(`${kind} 上没挂 provider（selector=${KOJO_LANGUAGE_ID}）`);
  return provider as Record<string, unknown>;
}

function askHighlight(
  model: Monaco.editor.ITextModel,
  line = 5,
  column = 6,
): Monaco.languages.DocumentHighlight[] | undefined {
  const provider = providerOf('highlight') as unknown as Monaco.languages.DocumentHighlightProvider;
  return provider.provideDocumentHighlights(model, position(line, column), TOKEN) as
    | Monaco.languages.DocumentHighlight[]
    | undefined;
}

function askSelection(
  model: Monaco.editor.ITextModel,
  positions: ReadonlyArray<Monaco.Position>,
): Monaco.languages.SelectionRange[][] | undefined {
  const provider = providerOf('selection') as unknown as Monaco.languages.SelectionRangeProvider;
  return provider.provideSelectionRanges(model, [...positions], TOKEN) as
    | Monaco.languages.SelectionRange[][]
    | undefined;
}

const SOURCE = ['@FUNC(A)', '    IF A', '        PRINTL 一', '    ENDIF'].join('\n');

function flatIRange(range: Monaco.IRange): [number, number, number, number] {
  return [range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn];
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ============================== ① 契约 → Monaco ============================== */

describe('①契约 → Monaco：单行区间 + 三档映射', () => {
  it('三档 → DocumentHighlightKind（唯一映射表）', () => {
    const fake = fakeMonaco();
    expect(erbHighlightKindToMonaco(fake.monaco, 'text')).toBe(HIGHLIGHT_KINDS.Text);
    expect(erbHighlightKindToMonaco(fake.monaco, 'read')).toBe(HIGHLIGHT_KINDS.Read);
    expect(erbHighlightKindToMonaco(fake.monaco, 'write')).toBe(HIGHLIGHT_KINDS.Write);
  });

  it('高亮：line / 起止列 → 同行 IRange，kind 逐条翻', () => {
    installKernel([
      highlightContribution([
        { line: 1, startColumn: 2, endColumn: 6, kind: 'write' },
        { line: 2, startColumn: 5, endColumn: 7, kind: 'read' },
        { line: 3, startColumn: 9, endColumn: 15, kind: 'text' },
      ]),
    ]);
    const result = askHighlight(fakeModel(SOURCE).model)!;
    expect(result.map((hit) => [flatIRange(hit.range), hit.kind])).toEqual([
      [[1, 2, 1, 6], HIGHLIGHT_KINDS.Write],
      [[2, 5, 2, 7], HIGHLIGHT_KINDS.Read],
      [[3, 9, 3, 15], HIGHLIGHT_KINDS.Text],
    ]);
  });

  it('请求带身份三格 + 全文 + 位点 + 项目（宿主只搬运）', () => {
    let seen:
      | {
          path?: string;
          text?: string;
          line?: number;
          column?: number;
          languageId?: string;
          version?: number;
          project?: unknown;
        }
      | undefined;
    installKernel([
      contributionOf((request) => {
        seen = request as typeof seen;
        return { kind: 'documentHighlight', highlights: [] };
      }),
    ]);
    askHighlight(fakeModel(SOURCE).model, 2, 6);
    expect(seen).toBeDefined();
    expect(seen!.path).toBe('/proj/a.erb');
    expect(seen!.text).toBe(SOURCE);
    expect(seen!.line).toBe(2);
    expect(seen!.column).toBe(6);
    expect(seen!.languageId).toBe(ERB_LANGUAGE_ID);
    expect(seen!.version).toBe(11);
    expect(seen!.project).toEqual({ adapterId: 'proj-a' });
  });

  it('扩选：嵌套链摊平成 0.57 的"每位点一个数组"（内 → 外）', () => {
    installKernel([
      selectionContribution([
        {
          range: { startLine: 2, startColumn: 5, endLine: 2, endColumn: 7 },
          parent: {
            range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 10 },
            parent: { range: { startLine: 1, startColumn: 1, endLine: 4, endColumn: 11 } },
          },
        },
      ]),
    ]);
    const result = askSelection(fakeModel(SOURCE).model, [position(2, 5)])!;
    expect(result).toHaveLength(1);
    expect(result[0]!.map((node) => flatIRange(node.range))).toEqual([
      [2, 5, 2, 7],
      [2, 1, 2, 10],
      [1, 1, 4, 11],
    ]);
  });

  it('扩选请求把 Monaco 位点折成 1 基行列（原样、不排序）', () => {
    let seen: { positions?: unknown; text?: string } | undefined;
    installKernel([
      contributionOf((request) => {
        seen = request as typeof seen;
        return { kind: 'selectionRange', selections: [] };
      }),
    ]);
    askSelection(fakeModel(SOURCE).model, [position(3, 9), position(1, 1)]);
    expect(seen!.positions).toEqual([
      { line: 3, column: 9 },
      { line: 1, column: 1 },
    ]);
    expect(seen!.text).toBe(SOURCE);
  });
});

/* ============================== ② 逐位点独立 ============================== */

describe('②扩选：null 位点给空数组，别的位点一格不动', () => {
  it('第 2 个位点 null ⇒ `[]`；第 1 位点整条链照旧', () => {
    installKernel([
      selectionContribution([{ range: { startLine: 2, startColumn: 5, endLine: 2, endColumn: 7 } }, null]),
    ]);
    const result = askSelection(fakeModel(SOURCE).model, [position(2, 5), position(9_999, 1)])!;
    expect(result).toHaveLength(2);
    expect(result[0]!.map((node) => flatIRange(node.range))).toEqual([[2, 5, 2, 7]]);
    expect(result[1]).toEqual([]);
  });

  it('与输入同序：位置越界与否不影响位次', () => {
    installKernel([
      selectionContribution([
        null,
        { range: { startLine: 2, startColumn: 5, endLine: 2, endColumn: 7 } },
      ]),
    ]);
    const result = askSelection(fakeModel(SOURCE).model, [position(9_999, 1), position(2, 5)])!;
    expect(result[0]).toEqual([]);
    expect(flatIRange(result[1]![0]!.range)).toEqual([2, 5, 2, 7]);
  });
});

/* ============================== ③ 三态不混 ============================== */

describe('③三态：无人应答 ⇒ undefined（不顶掉别家）；答空 ⇒ []；异常 ⇒ []', () => {
  it('高亮：槽里无人应答 ⇒ provider 交 `undefined`（空数组会按"第一应答"顶掉下一家）', () => {
    installKernel([contributionOf(() => undefined)]);
    expect(askHighlight(fakeModel(SOURCE).model)).toBeUndefined();
  });

  it('高亮：有人答空表 ⇒ `[]`，且不再问下一家（空结果也是作答）', () => {
    const second = vi.fn<EditorLanguageServiceContribution['provide']>(() => undefined);
    installKernel([highlightContribution([], 'first'), contributionOf(second, 'second')]);
    expect(askHighlight(fakeModel(SOURCE).model)).toEqual([]);
    expect(second).not.toHaveBeenCalled();
  });

  it('扩选：无人应答 ⇒ `undefined`（不伪造"没有扩选"）', () => {
    installKernel([contributionOf(() => undefined)]);
    expect(askSelection(fakeModel(SOURCE).model, [position(2, 5)])).toBeUndefined();
  });

  it('取文失败（模型已释放）⇒ `[]`（不抛进 Monaco）', () => {
    installKernel([highlightContribution([{ line: 1, startColumn: 2, endColumn: 6, kind: 'write' }])]);
    const broken = fakeModel(SOURCE);
    broken.breakGetValue();
    expect(askHighlight(broken.model)).toEqual([]);
    expect(askSelection(broken.model, [position(2, 5)])).toEqual([]);
  });
});

/* ============================== ④ 注册与源码卫生 ============================== */

describe('④注册：共享收口带能力名、dispose 幂等、原生注册形状归零', () => {
  it('只挂没点名这一格的旧桥语言（DOUBLE-LEG-1032：ERB / kojo2 点名让位），且只挂一次', () => {
    const fake = fakeMonaco();
    installErbHighlightProvider(fake.monaco);
    installErbSelectionRangeProvider(fake.monaco);
    const highlightSelectors = fake.registrations
      .filter((entry) => entry.kind === 'highlight')
      .map((entry) => entry.selector);
    const selectionSelectors = fake.registrations
      .filter((entry) => entry.kind === 'selection')
      .map((entry) => entry.selector);
    expect(highlightSelectors).toEqual(HIGHLIGHT_SELECTORS);
    expect(selectionSelectors).toEqual(SELECTION_SELECTORS);
    // 让位钉：点名了该 kind 的语言（ERB / kojo2）不再被本腿挂上——ERB 那一格今天
    // 恰一枚 provider（共享槽腿），这是 DOUBLE-LEG-1032 要钉的新事实。
    expect(highlightSelectors).not.toContain(ERB_LANGUAGE_ID);
    expect(selectionSelectors).not.toContain(ERB_LANGUAGE_ID);
    expect(highlightSelectors).not.toContain(KOJO2_LANGUAGE_ID);
    expect(selectionSelectors).not.toContain(KOJO2_LANGUAGE_ID);
    // 没点名的旧桥语言（`.kojo1`）照常挂到，糖视图投影面不空转。
    expect(highlightSelectors).toContain(KOJO_LANGUAGE_ID);
    expect(selectionSelectors).toContain(KOJO_LANGUAGE_ID);
    expect(new Set(highlightSelectors).size).toBe(highlightSelectors.length);
  });

  it('插件认的 id 清单里含宿主那枚 `ERB_LANGUAGE_ID`（两处真源对拍，改名即红）', () => {
    expect(ERB_LANGUAGE_IDS).toContain(ERB_LANGUAGE_ID);
  });

  it('dispose 幂等：两次只撤一轮', () => {
    const fake = fakeMonaco();
    const highlight = installErbHighlightProvider(fake.monaco);
    const selection = installErbSelectionRangeProvider(fake.monaco);
    const before = fake.disposeCalls();
    highlight.dispose();
    highlight.dispose();
    selection.dispose();
    selection.dispose();
    expect(fake.disposeCalls() - before).toBe(
      HIGHLIGHT_SELECTORS.length + SELECTION_SELECTORS.length,
    );
  });

  it('安装器不读切流开关 / 不碰结构层开关；Monaco 只许 type-only 引入', () => {
    for (const source of [HIGHLIGHT_SOURCE, SELECTION_SOURCE]) {
      expect(source).not.toMatch(/isKojo2CutoverEnabled/);
      expect(source).not.toMatch(/localStorage/);
      expect(source).not.toMatch(/from '\.\.?\/?(?:monaco\/)?tree-sitter/);
      expect(source).toMatch(/import type \* as Monaco from '\.\/entry'/);
      expect(source).not.toMatch(/import \* as Monaco from/);
      expect(source).not.toMatch(/from 'monaco-editor'/);
    }
  });

  it('原生注册形状归零：直挂 ERB_LANGUAGE_ID 的两条写法一处都不许有', () => {
    expect(HIGHLIGHT_SOURCE).not.toMatch(/registerDocumentHighlightProvider\(\s*ERB_LANGUAGE_ID/);
    expect(SELECTION_SOURCE).not.toMatch(/registerSelectionRangeProvider\(\s*ERB_LANGUAGE_ID/);
    // 反向钉住收口形状确实在（否则上面两条"没出现"是空匹配）
    expect(HIGHLIGHT_SOURCE).toMatch(
      /registerForLanguageServices\([\s\S]{0,400}?registerDocumentHighlightProvider/,
    );
    expect(SELECTION_SOURCE).toMatch(
      /registerForLanguageServices\([\s\S]{0,400}?registerSelectionRangeProvider/,
    );
  });

  it('宿主不再留判据（判据只在 `@kojo/erb-lang`）', () => {
    for (const source of [HIGHLIGHT_SOURCE, SELECTION_SOURCE]) {
      expect(source).not.toMatch(/erbDocumentHighlights|erbSelectionRangeAt|erbSelectionRangeChainsAt/);
      expect(source).not.toMatch(/from '@kojo\/erb-lang/);
      expect(source).not.toMatch(/from\s+['"]@kojo\/plugin-erb-lang/);
    }
  });
});

/* ============================== ⑤ 与 kojo2 同一条槽 ============================== */

describe('⑤同一条槽：ERB 请求只由 ERB 那家作答（两家同时在场，换顺序都一样）', () => {
  const ERB_TEXT = ['@FUNC(A)', '    CALL FUNC(A)'].join('\n');
  const KOJO2_TEXT = ['# 幕 一', '# 设 心情 整数 = 0 存档', '> 心情'].join('\n');

  /** 真供方（两家插件的贡献都经各自的 activate 取出） */
  function realContributions(): {
    erb: EditorLanguageServiceContribution[];
    kojo2: EditorLanguageServiceContribution[];
  } {
    const collect = (activate: (ctx: never) => void): EditorLanguageServiceContribution[] => {
      const out: EditorLanguageServiceContribution[] = [];
      const ctx = {
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        slots: {
          register: (slot: string, item: EditorLanguageServiceContribution) => {
            if (slot === 'ui.editor.languageService') out.push(item);
            return () => undefined;
          },
        },
      } as unknown as never;
      activate(ctx);
      return out;
    };
    return {
      erb: collect((ctx) => createErbLangPlugin().activate(ctx)),
      kojo2: collect((ctx) => createKojoLangPlugin().activate(ctx)),
    };
  }

  it('ERB 请求：不论哪家在前，作答都来自 erb 供方（kojo2 供方弃权）', () => {
    const both = realContributions();
    // 两家在槽里的顺序按 order 同档，宿主按注册顺序问 ⇒ 两种顺序都必须给出同一个答案
    for (const order of [
      [...both.erb, ...both.kojo2],
      [...both.kojo2, ...both.erb],
    ]) {
      installKernel(order);
      const result = askHighlight(fakeModel(ERB_TEXT).model, 1, 3)!;
      expect(result.map((hit) => hit.kind)).toEqual([HIGHLIGHT_KINDS.Write, HIGHLIGHT_KINDS.Read]);
    }
  });

  it('kojo2 请求：槽里两家同时在时只有 kojo2 供方作答（宿主那层由语言门弃权）', () => {
    const both = realContributions();
    const ask = {
      kind: 'documentHighlight',
      path: '/proj/a.kojo',
      text: KOJO2_TEXT,
      line: 2,
      column: 6,
      project: null,
      languageId: KOJO2_LANGUAGE_ID,
    } as never;
    const answers = [...both.erb, ...both.kojo2]
      .map((contribution) => contribution.provide(ask))
      .filter((result) => result !== undefined && result.kind === 'documentHighlight');
    expect(answers).toHaveLength(1);
    // 声明写 + 正文里的同名提及（text）：这是 kojo2 那家的判据形状（ERB 那家对 kojo2 请求
    // 弃权，若它作答则会多出第二份答案）
    expect(
      (answers[0] as { highlights: ReadonlyArray<{ kind: string }> }).highlights.map((hit) => hit.kind),
    ).toEqual(['write', 'text']);
  });

  it('供方层直接对拍：erb 供方对 kojo2 请求 `undefined`、kojo2 供方对 erb 请求 `undefined`', () => {
    const erbAsk = {
      kind: 'documentHighlight',
      path: '/proj/a.erb',
      text: ERB_TEXT,
      line: 1,
      column: 3,
      project: null,
      languageId: ERB_LANGUAGE_ID,
    } as never;
    const kojo2Ask = {
      kind: 'documentHighlight',
      path: '/proj/a.kojo',
      text: KOJO2_TEXT,
      line: 2,
      column: 6,
      project: null,
      languageId: KOJO2_LANGUAGE_ID,
    } as never;
    expect(provideErbHighlights(erbAsk)).toBeDefined();
    expect(provideErbHighlights(kojo2Ask)).toBeUndefined();
    // 反方向：kojo2 那家对 ERB 请求也弃权（B3f 立的判据，本批补上跨供方的这一条）
    expect(provideKojo2Highlights(kojo2Ask)).toBeDefined();
    expect(provideKojo2Highlights(erbAsk)).toBeUndefined();
    expect(
      provideErbSelections({
        ...(erbAsk as object),
        kind: 'selectionRange',
        positions: [{ line: 1, column: 3 }],
      } as never),
    ).toBeDefined();
  });
});

/* ============================== 宿主语言门（LAU-4 集成） ============================== */

describe('宿主语言门：本腿 provider 遇到 kojo2 model 必须弃权（不再挂 kojo2，语言门仍是第二道保险）', () => {
  it('kojo2 model ⇒ 高亮 / 扩选都交 `undefined`（不替 kojo2 那家作答，免得叠两份）', () => {
    const model = fakeModel(SOURCE, KOJO2_LANGUAGE_ID).model;
    expect(askHighlight(model)).toBeUndefined();
    expect(askSelection(model, [position(1, 1)])).toBeUndefined();
  });
});

/**
 * 结构缓存（LRU-1）的可观测证据。
 *
 * 为什么值得钉：`erbStructureOf` 的两个消费方（同符号高亮、扩选）在**每次光标移动**各问
 * 一次，真语料 `Lunatic Survival Scarlet.ERB`（19,033 行）实测 30.7ms/次。缓存把它降到
 * 0.0ms，而这件事唯一可观测的特征就是"同一份源文交回同一个对象"；语义要求仍是
 * "内容变了必须换一份"，所以两条都要断言。
 */
describe('erbStructureOf · 结构缓存（LRU-1）', () => {
  it('同一份源文重复问交回同一份；内容变一个字就换一份', () => {
    const source = '@A\nIF X\n  CALL B\nENDIF\n';
    const first = erbStructureOf(source);
    expect(erbStructureOf(source)).toBe(first);

    const changed = `${source}; 注释\n`;
    const after = erbStructureOf(changed);
    expect(after).not.toBe(first);
    // 语义不变：只是多了一行注释 ⇒ 行数 +1，函数仍是那一个
    expect(after.lines.length).toBe(first.lines.length + 1);
    expect(after.functions.map((f) => f.name)).toEqual(first.functions.map((f) => f.name));
  });

  it('超过体量上限的源文不进缓存，之后小文件照常命中', () => {
    const huge = 'X'.repeat(4 * 1024 * 1024 + 1);
    const a = erbStructureOf(huge);
    const b = erbStructureOf(huge);
    // 没被缓存 ⇒ 两次是两个对象（不吃那份内存），但结果逐项相同
    expect(b).not.toBe(a);
    expect(b.lines.length).toBe(a.lines.length);
    // 超大源文之后缓存不是脏状态：小文件仍走命中路
    const small = 'IF X\nENDIF\n';
    const s1 = erbStructureOf(small);
    expect(erbStructureOf(small)).toBe(s1);
  });
});

/**
 * 结构缓存（LRU-1）的可观测证据。
 *
 * 为什么值得钉：`erbStructureOf` 的两个消费方（同符号高亮、扩选）在**每次光标移动**各问
 * 一次，真语料 `Lunatic Survival Scarlet.ERB`（19,033 行）实测 30.7ms/次。缓存把它降到
 * 0.0ms，而这件事唯一可观测的特征就是"同一份源文交回同一个对象"；语义要求仍是
 * "内容变了必须换一份"，所以两条都要断言。
 */
describe('erbStructureOf · 结构缓存（LRU-1）', () => {
  it('同一份源文重复问交回同一份；内容变一个字就换一份', () => {
    const source = '@A\nIF X\n  CALL B\nENDIF\n';
    const first = erbStructureOf(source);
    expect(erbStructureOf(source)).toBe(first);

    const changed = `${source}; 注释\n`;
    const after = erbStructureOf(changed);
    expect(after).not.toBe(first);
    // 语义不变：只是多了一行注释 ⇒ 行数 +1，函数仍是那一个
    expect(after.lines.length).toBe(first.lines.length + 1);
    expect(after.functions.map((f) => f.name)).toEqual(first.functions.map((f) => f.name));
  });

  it('超过体量上限的源文不进缓存，之后小文件照常命中', () => {
    const huge = 'X'.repeat(4 * 1024 * 1024 + 1);
    const a = erbStructureOf(huge);
    const b = erbStructureOf(huge);
    // 没被缓存 ⇒ 两次是两个对象（不吃那份内存），但结果逐项相同
    expect(b).not.toBe(a);
    expect(b.lines.length).toBe(a.lines.length);
    // 超大源文之后缓存不是脏状态：小文件仍走命中路
    const small = 'IF X\nENDIF\n';
    const s1 = erbStructureOf(small);
    expect(erbStructureOf(small)).toBe(s1);
  });
});
