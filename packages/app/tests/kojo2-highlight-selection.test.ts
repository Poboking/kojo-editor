// @vitest-environment happy-dom
/**
 * B3f · Kojo 2.0 **同符号高亮 / 结构化扩选的宿主翻译层**闸（判据已整块搬进
 * `@kojo/kojo-lang/highlight` / `/selection-range`）。
 *
 * 判据本体（三档识别 / 位置门 / 扩选层级）在 `packages/kojo-lang/tests/highlight.test.ts`
 * 与 `selection-range.test.ts`；供方的三态在 `packages/plugins/kojo-lang/tests/
 * highlight-selection.test.ts`。本文件只钉宿主自己那一格：
 *
 * 1. **契约 → Monaco**：高亮单行区间 + 三档 `DocumentHighlightKind` 映射；扩选链按
 *    0.57 摊平成"每位点一个数组"（内 → 外）；
 * 2. **逐位点独立**：某位点 `null`（空链）⇒ 该位点 `[]`，别的位点一格不动；
 * 3. **三态不混**：无人应答 ⇒ provider 交 **`undefined`**（Monaco 对高亮按"第一应答"
 *    裁决，空数组会顶掉下一家）；有人答空 ⇒ `[]`；异常 ⇒ `[]`；
 * 4. **注册**：两枚都经 `registerForLanguageServices` 带能力名挂上（descriptor 点名
 *    `documentHighlight` / `selectionRange`），dispose 幂等；源码里没有直挂
 *    `KOJO2_LANGUAGE_ID` 的原生注册形状、也不读切流开关。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorLanguageServiceContribution, EditorSelectionChain } from '@kojo/plugin-api';
import type * as Monaco from '../src/monaco/entry';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import { languageDescriptors } from '../src/monaco/language-registry';
import { setGlobalKernel } from '../src/ui/editor-pane-registry';
import {
  installKojo2HighlightProvider,
  kojo2HighlightKindToMonaco,
} from '../src/monaco/kojo2-highlight';
import { installKojo2SelectionRangeProvider } from '../src/monaco/kojo2-selection-range';

const HERE = import.meta.dirname;
const HIGHLIGHT_SOURCE = readFileSync(
  path.resolve(HERE, '..', 'src', 'monaco', 'kojo2-highlight.ts'),
  'utf8',
);
const SELECTION_SOURCE = readFileSync(
  path.resolve(HERE, '..', 'src', 'monaco', 'kojo2-selection-range.ts'),
  'utf8',
);

/* ============================== 共享收口的期望 selector ============================== */

const HIGHLIGHT_SELECTORS = languageDescriptors()
  .filter(
    (descriptor) =>
      descriptor.languageServices === true ||
      descriptor.slotServices?.includes('documentHighlight') === true,
  )
  .map((descriptor) => descriptor.id);

const SELECTION_SELECTORS = languageDescriptors()
  .filter(
    (descriptor) =>
      descriptor.languageServices === true ||
      descriptor.slotServices?.includes('selectionRange') === true,
  )
  .map((descriptor) => descriptor.id);

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

function fakeModel(source: string): FakeModel {
  let broken = false;
  const model = {
    getValue: () => {
      if (broken) throw new Error('桩：模型已释放');
      return source;
    },
    getLanguageId: () => KOJO2_LANGUAGE_ID,
    getVersionId: () => 7,
    uri: { scheme: 'file', path: '/proj/a.kojo', fsPath: '/proj/a.kojo' },
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

/** 取回某一门语言上的某一枚 provider（没挂上直接抛：证据缺席不许静默） */
function providerOf(
  kind: ProviderKind,
  selectors: readonly string[],
): Record<string, unknown> {
  const fake = fakeMonaco();
  if (kind === 'highlight') installKojo2HighlightProvider(fake.monaco);
  else installKojo2SelectionRangeProvider(fake.monaco);
  const provider = fake.registrations.find((entry) => entry.selector === selectors[0])?.provider;
  if (provider === undefined) throw new Error(`${kind} 上没有挂 provider（selector=${selectors[0]}）`);
  return provider as Record<string, unknown>;
}

/** 高亮 provider 的"问一次" */
function askHighlight(
  model: Monaco.editor.ITextModel,
  line = 3,
  column = 6,
): Monaco.languages.DocumentHighlight[] | undefined {
  const provider = providerOf('highlight', HIGHLIGHT_SELECTORS) as unknown as
    Monaco.languages.DocumentHighlightProvider;
  return provider.provideDocumentHighlights(model, position(line, column), TOKEN) as
    | Monaco.languages.DocumentHighlight[]
    | undefined;
}

/** 扩选 provider 的"问一次" */
function askSelection(
  model: Monaco.editor.ITextModel,
  positions: ReadonlyArray<Monaco.Position>,
): Monaco.languages.SelectionRange[][] | undefined {
  const provider = providerOf('selection', SELECTION_SELECTORS) as unknown as
    Monaco.languages.SelectionRangeProvider;
  return provider.provideSelectionRanges(model, [...positions], TOKEN) as
    | Monaco.languages.SelectionRange[][]
    | undefined;
}

const SOURCE = '# 变量 心情 整数\n! 增加(心情)\n';

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
    expect(kojo2HighlightKindToMonaco(fake.monaco, 'text')).toBe(HIGHLIGHT_KINDS.Text);
    expect(kojo2HighlightKindToMonaco(fake.monaco, 'read')).toBe(HIGHLIGHT_KINDS.Read);
    expect(kojo2HighlightKindToMonaco(fake.monaco, 'write')).toBe(HIGHLIGHT_KINDS.Write);
  });

  it('高亮：line / 起止列 → 同行 IRange，kind 逐条翻', () => {
    installKernel([
      highlightContribution([
        { line: 1, startColumn: 6, endColumn: 8, kind: 'write' },
        { line: 2, startColumn: 6, endColumn: 8, kind: 'read' },
        { line: 9, startColumn: 3, endColumn: 5, kind: 'text' },
      ]),
    ]);
    const result = askHighlight(fakeModel(SOURCE).model)!;
    expect(result.map((hit) => [flatIRange(hit.range), hit.kind])).toEqual([
      [[1, 6, 1, 8], HIGHLIGHT_KINDS.Write],
      [[2, 6, 2, 8], HIGHLIGHT_KINDS.Read],
      [[9, 3, 9, 5], HIGHLIGHT_KINDS.Text],
    ]);
  });

  it('请求带身份三格 + 全文 + 位点 + 项目（宿主只搬运）', () => {
    let seen:
      | { path?: string; text?: string; line?: number; column?: number; languageId?: string; version?: number; project?: unknown }
      | undefined;
    installKernel([
      contributionOf((request) => {
        seen = request as typeof seen;
        return { kind: 'documentHighlight', highlights: [] };
      }),
    ]);
    askHighlight(fakeModel(SOURCE).model, 2, 6);
    expect(seen).toBeDefined();
    expect(seen!.path).toBe('/proj/a.kojo');
    expect(seen!.text).toBe(SOURCE);
    expect(seen!.line).toBe(2);
    expect(seen!.column).toBe(6);
    expect(seen!.languageId).toBe(KOJO2_LANGUAGE_ID);
    expect(seen!.version).toBe(7);
    expect(seen!.project).toEqual({ adapterId: 'proj-a' });
  });

  it('扩选：嵌套链摊平成 0.57 的"每位点一个数组"（内 → 外）', () => {
    installKernel([
      selectionContribution([
        {
          range: { startLine: 1, startColumn: 6, endLine: 1, endColumn: 8 },
          parent: {
            range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 20 },
            parent: { range: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 12 } },
          },
        },
      ]),
    ]);
    const result = askSelection(fakeModel(SOURCE).model, [position(1, 6)])!;
    expect(result).toHaveLength(1);
    expect(result[0]!.map((node) => flatIRange(node.range))).toEqual([
      [1, 6, 1, 8],
      [1, 1, 1, 20],
      [1, 1, 2, 12],
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
    askSelection(fakeModel(SOURCE).model, [position(2, 5), position(1, 1)]);
    expect(seen!.positions).toEqual([
      { line: 2, column: 5 },
      { line: 1, column: 1 },
    ]);
    expect(seen!.text).toBe(SOURCE);
  });
});

/* ============================== ② 逐位点独立 ============================== */

describe('②扩选：null 位点给空数组，别的位点一格不动', () => {
  it('第 2 个位点 null ⇒ `[]`；第 1 位点整条链照旧', () => {
    installKernel([
      selectionContribution([
        { range: { startLine: 1, startColumn: 6, endLine: 1, endColumn: 8 } },
        null,
      ]),
    ]);
    const result = askSelection(fakeModel(SOURCE).model, [position(1, 6), position(9_999, 1)])!;
    expect(result).toHaveLength(2);
    expect(result[0]!.map((node) => flatIRange(node.range))).toEqual([[1, 6, 1, 8]]);
    expect(result[1]).toEqual([]);
  });

  it('与输入同序：位置越界与否不影响位次', () => {
    installKernel([
      selectionContribution([
        null,
        { range: { startLine: 2, startColumn: 6, endLine: 2, endColumn: 8 } },
      ]),
    ]);
    const result = askSelection(fakeModel(SOURCE).model, [position(9_999, 1), position(2, 6)])!;
    expect(result[0]).toEqual([]);
    expect(flatIRange(result[1]![0]!.range)).toEqual([2, 6, 2, 8]);
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

  it('高亮：第一家作答说了算（不并集）', () => {
    const second = vi.fn<EditorLanguageServiceContribution['provide']>(() => ({
      kind: 'documentHighlight',
      highlights: [{ line: 2, startColumn: 1, endColumn: 2, kind: 'read' }],
    }));
    installKernel([
      highlightContribution([{ line: 1, startColumn: 6, endColumn: 8, kind: 'write' }], 'first'),
      contributionOf(second, 'second'),
    ]);
    const result = askHighlight(fakeModel(SOURCE).model)!;
    expect(result).toHaveLength(1);
    expect(flatIRange(result[0]!.range)).toEqual([1, 6, 1, 8]);
    expect(second).not.toHaveBeenCalled();
  });

  it('扩选：无人应答 ⇒ `undefined`（不伪造"没有扩选"）', () => {
    installKernel([contributionOf(() => undefined)]);
    expect(askSelection(fakeModel(SOURCE).model, [position(1, 6)])).toBeUndefined();
  });

  it('取文失败（模型已释放）⇒ `[]`（不抛进 Monaco）', () => {
    installKernel([highlightContribution([{ line: 1, startColumn: 6, endColumn: 8, kind: 'write' }])]);
    const broken = fakeModel(SOURCE);
    broken.breakGetValue();
    expect(askHighlight(broken.model)).toEqual([]);
    expect(askSelection(broken.model, [position(1, 6)])).toEqual([]);
  });
});

/* ============================== ④ 注册与源码卫生 ============================== */

describe('④注册：共享收口带能力名、dispose 幂等、原生注册形状归零', () => {
  it('两枚都挂到 descriptor 点名的语言上（含 kojo2），且只挂一次', () => {
    const fake = fakeMonaco();
    installKojo2HighlightProvider(fake.monaco);
    installKojo2SelectionRangeProvider(fake.monaco);
    const highlightSelectors = fake.registrations
      .filter((entry) => entry.kind === 'highlight')
      .map((entry) => entry.selector);
    const selectionSelectors = fake.registrations
      .filter((entry) => entry.kind === 'selection')
      .map((entry) => entry.selector);
    expect(highlightSelectors).toEqual(HIGHLIGHT_SELECTORS);
    expect(selectionSelectors).toEqual(SELECTION_SELECTORS);
    expect(highlightSelectors).toContain(KOJO2_LANGUAGE_ID);
    expect(selectionSelectors).toContain(KOJO2_LANGUAGE_ID);
    expect(new Set(highlightSelectors).size).toBe(highlightSelectors.length);
  });

  it('dispose 幂等：两次只撤一轮', () => {
    const fake = fakeMonaco();
    const highlight = installKojo2HighlightProvider(fake.monaco);
    const selection = installKojo2SelectionRangeProvider(fake.monaco);
    const before = fake.disposeCalls();
    highlight.dispose();
    highlight.dispose();
    selection.dispose();
    selection.dispose();
    // 每枚注册只撤一次：两次安装 × 各自 selector 数量，重复 dispose 不再加账
    expect(fake.disposeCalls() - before).toBe(HIGHLIGHT_SELECTORS.length + SELECTION_SELECTORS.length);
  });

  it('安装器不读切流开关；Monaco 只许 type-only 引入', () => {
    for (const source of [HIGHLIGHT_SOURCE, SELECTION_SOURCE]) {
      expect(source).not.toMatch(/isKojo2CutoverEnabled/);
      expect(source).toMatch(/import type \* as Monaco from '\.\/entry'/);
      expect(source).not.toMatch(/import \* as Monaco from/);
      expect(source).not.toMatch(/from 'monaco-editor'/);
    }
  });

  it('原生注册形状归零：直挂 KOJO2_LANGUAGE_ID 的两条写法一处都不许有', () => {
    expect(HIGHLIGHT_SOURCE).not.toMatch(/registerDocumentHighlightProvider\(\s*KOJO2_LANGUAGE_ID/);
    expect(SELECTION_SOURCE).not.toMatch(/registerSelectionRangeProvider\(\s*KOJO2_LANGUAGE_ID/);
    // 反向钉住收口形状确实在（否则上面两条"没出现"是空匹配）
    expect(HIGHLIGHT_SOURCE).toMatch(
      /registerForLanguageServices\([\s\S]{0,400}?registerDocumentHighlightProvider/,
    );
    expect(SELECTION_SOURCE).toMatch(
      /registerForLanguageServices\([\s\S]{0,400}?registerSelectionRangeProvider/,
    );
  });

  it('宿主不再留判据：不高亮函数名 / 扩选函数名都不在本层', () => {
    expect(HIGHLIGHT_SOURCE).not.toMatch(/kojo2DocumentHighlights/);
    expect(SELECTION_SOURCE).not.toMatch(/kojo2SelectionRangeAt|kojo2SelectionRangeChainsAt/);
  });
});
