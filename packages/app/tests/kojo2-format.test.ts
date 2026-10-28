// @vitest-environment happy-dom
/**
 * B3d · Kojo 2.0 格式化的**宿主翻译层**闸（判据已整块搬进 `@kojo/kojo-lang/format`）。
 *
 * 规则本体（缩进归一 / 空行呼吸 / 行尾空白 / EOL 保留 / 幂等 / 区间裁剪）在
 * `packages/kojo-lang/tests/format.test.ts`；本文件只钉宿主自己那一格，四件事：
 * 1. **契约 → Monaco 翻译**：`EditorRangeEdit` 的行列缺省口径（`startColumn` 缺省 1、
 *    `endColumn` 缺省行尾）与 `text` 原样；
 * 2. **两条请求**：整篇那条**不带** `lineRange`（缺省 = 整篇，与加这一格之前逐字相同）；
 *    区间那条只递行号（不切串、不折列）；
 * 3. **三态**：无人应答（`undefined`）/ 有人答空表（`[]`）⇒ 宿主都交 `[]`；
 *    有编辑 ⇒ 同数量、同顺序（升序由取数腿保证）的 `TextEdit[]`；
 * 4. **注册**：两枚 provider 都经 `registerForLanguageServices(..., 'formatting')`
 *    挂到"全铺语言 + descriptor 点名了这枚能力"的语言上；dispose 幂等、半途抛错回滚。
 *
 * 桩 monaco 只实现被真正用到的那几格；`applyKojo2Format` 已随批删除（无生产消费方——
 * 保存链路本来就不接它），它那组落地/撤销测试同批移除。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorLanguageServiceContribution, EditorRangeEdit } from '@kojo/plugin-api';
import type * as Monaco from '../src/monaco/entry';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import { languageDescriptors } from '../src/monaco/language-registry';
import { setGlobalKernel } from '../src/ui/editor-pane-registry';
import {
  installKojo2DocumentFormatter,
  installKojo2RangeFormatter,
} from '../src/monaco/kojo2-format';

const HERE = import.meta.dirname;
const LAYER_SOURCE = readFileSync(
  path.resolve(HERE, '..', 'src', 'monaco', 'kojo2-format.ts'),
  'utf8',
);

/* ============================== 共享收口的期望 selector ============================== */

const FORMAT_SELECTORS = languageDescriptors()
  .filter(
    (descriptor) =>
      descriptor.languageServices === true ||
      descriptor.slotServices?.includes('formatting') === true,
  )
  .map((descriptor) => descriptor.id);

/* ============================== 假 Monaco / 假 model / 假内核 ============================== */

type ProviderKind = 'document' | 'range';

interface Registration {
  readonly kind: ProviderKind;
  readonly selector: unknown;
  readonly provider: unknown;
}

function fakeMonaco(failAt = -1): {
  readonly monaco: typeof Monaco;
  readonly registrations: Registration[];
  readonly disposeCalls: () => number;
} {
  const registrations: Registration[] = [];
  let disposeCalls = 0;
  const register = (kind: ProviderKind) => (selector: unknown, provider: unknown) => {
    if (registrations.length === failAt) throw new Error('桩：注册抛错');
    registrations.push({ kind, selector, provider });
    return {
      dispose: () => {
        disposeCalls += 1;
      },
    };
  };
  const fake = {
    languages: {
      registerDocumentFormattingEditProvider: register('document'),
      registerDocumentRangeFormattingEditProvider: register('range'),
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

function fakeModel(source: string, languageId = KOJO2_LANGUAGE_ID): FakeModel {
  let broken = false;
  const rows = source.split('\n');
  const model = {
    getValue: () => {
      if (broken) throw new Error('桩：模型已释放');
      return source;
    },
    getLineMaxColumn: (line: number) => (rows[line - 1] ?? '').length + 1,
    getLanguageId: () => languageId,
    getVersionId: () => 3,
    uri: { scheme: 'file', path: '/proj/chara.kojo2', fsPath: '/proj/chara.kojo2' },
  } as unknown as Monaco.editor.ITextModel;
  return {
    model,
    breakGetValue: () => {
      broken = true;
    },
  };
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

const OPTIONS = {} as Monaco.languages.FormattingOptions;

/** 一条贡献（`provide` 的返回由用例决定） */
function contributionOf(
  provide: EditorLanguageServiceContribution['provide'],
  id = 'stub-format',
): EditorLanguageServiceContribution {
  return { id, provide };
}

/** 只认 `formatting`、答固定编辑的贡献 */
function formatContribution(
  edits: readonly EditorRangeEdit[],
  id = 'stub-format',
): EditorLanguageServiceContribution {
  return contributionOf(
    (request) => (request.kind === 'formatting' ? { kind: 'formatting', edits } : undefined),
    id,
  );
}

/** 取回某一门语言上的某一枚 provider（没挂上直接抛：证据缺席不许静默） */
function providerOf(
  selectors: readonly string[],
  kind: ProviderKind,
): Record<string, unknown> {
  const fake = fakeMonaco();
  if (kind === 'document') installKojo2DocumentFormatter(fake.monaco);
  else installKojo2RangeFormatter(fake.monaco);
  const provider = fake.registrations.find(
    (entry) => entry.kind === kind && entry.selector === selectors[0],
  )?.provider;
  if (provider === undefined) throw new Error(`${kind} 上没有挂格式化 provider`);
  return provider as Record<string, unknown>;
}

/** 整篇那条 provider 的"问一次" */
function formatDocument(
  model: Monaco.editor.ITextModel,
): Monaco.languages.TextEdit[] {
  const provider = providerOf(FORMAT_SELECTORS, 'document') as unknown as
    Monaco.languages.DocumentFormattingEditProvider;
  return provider.provideDocumentFormattingEdits(model, OPTIONS, TOKEN) as Monaco.languages.TextEdit[];
}

/** 区间那条 provider 的"问一次" */
function formatRange(
  model: Monaco.editor.ITextModel,
  range: Monaco.Range,
): Monaco.languages.TextEdit[] {
  const provider = providerOf(FORMAT_SELECTORS, 'range') as unknown as
    Monaco.languages.DocumentRangeFormattingEditProvider;
  return provider.provideDocumentRangeFormattingEdits(
    model,
    range,
    OPTIONS,
    TOKEN,
  ) as Monaco.languages.TextEdit[];
}

const SOURCE = '# 池 问候\n  ? 恋慕 < 100\n      「早。」\n  ? 否\n      我：「嗯。」\n';

const EDIT: EditorRangeEdit = { startLine: 3, endLine: 3, newText: '        「早。」' };

afterEach(() => {
  vi.restoreAllMocks();
});

/* ============================== ① 契约 → Monaco ============================== */

describe('①契约 → Monaco：行列缺省口径与 text 原样', () => {
  it('给了坐标 ⇒ 逐格搬运（行 1 基、闭区间；text 不改写）', () => {
    installKernel([
      formatContribution([
        { startLine: 2, startColumn: 3, endLine: 2, endColumn: 5, newText: 'X' },
      ]),
    ]);
    const edits = formatDocument(fakeModel(SOURCE).model);
    expect(edits).toEqual([
      {
        range: { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 5 },
        text: 'X',
      },
    ]);
  });

  it('`startColumn` 缺省 = 1；`endColumn` 缺省 = 该行行尾（Monaco 口径）', () => {
    installKernel([formatContribution([EDIT])]);
    const edits = formatDocument(fakeModel(SOURCE).model);
    // 行尾列 = 行内容长度 + 1（第 3 行 `      「早。」` 是 6 + 4 = 10 个字符）
    expect(edits).toEqual([
      {
        range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 11 },
        text: EDIT.newText,
      },
    ]);
    expect(edits[0]!.range.endColumn).toBe('      「早。」'.length + 1);
  });

  it('桩 model 没有 `getLineMaxColumn` ⇒ 列退成 1（补一个零宽位，不猜）', () => {
    installKernel([formatContribution([EDIT])]);
    const bare = {
      getValue: () => SOURCE,
      getLanguageId: () => KOJO2_LANGUAGE_ID,
    } as unknown as Monaco.editor.ITextModel;
    const edits = formatDocument(bare);
    expect(edits[0]!.range.endColumn).toBe(1);
  });

  it('多条编辑：顺序 = 取数腿给的升序（宿主不重排）', () => {
    const many: EditorRangeEdit[] = [
      { startLine: 2, endLine: 2, newText: 'a' },
      { startLine: 4, endLine: 4, newText: 'b' },
    ];
    installKernel([formatContribution(many)]);
    expect(formatDocument(fakeModel(SOURCE).model).map((edit) => edit.range.startLineNumber)).toEqual(
      [2, 4],
    );
  });
});

/* ============================== ② 两条请求 ============================== */

describe('②两条请求：整篇不带 `lineRange`；区间只递行号', () => {
  it('整篇：请求里**没有** `lineRange` 这个键（缺省 = 整篇，additive 逐字不变）', () => {
    let seen: { lineRange?: unknown; text?: string; lineCount?: number } | undefined;
    installKernel([
      contributionOf((request) => {
        seen = request as typeof seen;
        return { kind: 'formatting', edits: [EDIT] };
      }),
    ]);
    formatDocument(fakeModel(SOURCE).model);
    expect(seen).toBeDefined();
    expect('lineRange' in seen!).toBe(false);
    expect(seen!.text).toBe(SOURCE);
    expect(seen!.lineCount).toBe(6); // 5 行正文 + 结尾换行后那一格
  });

  it('区间：Monaco range 折成两枚行号（1 基闭区间），列一格都不递', () => {
    let seen: { lineRange?: unknown } | undefined;
    installKernel([
      contributionOf((request) => {
        seen = request as typeof seen;
        return { kind: 'formatting', edits: [EDIT] };
      }),
    ]);
    formatRange(fakeModel(SOURCE).model, {
      startLineNumber: 3,
      startColumn: 4,
      endLineNumber: 4,
      endColumn: 9,
    } as Monaco.Range);
    expect(seen!.lineRange).toEqual({ startLine: 3, endLine: 4 });
  });

  it('区间 provider 的编辑也只来自契约（选区外的行由供方保证不动）', () => {
    installKernel([formatContribution([EDIT])]);
    const edits = formatRange(fakeModel(SOURCE).model, {
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 9,
    } as Monaco.Range);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.range.startLineNumber).toBe(3);
    expect(edits[0]!.range.endLineNumber).toBe(3);
  });
});

/* ============================== ③ 三态 ============================== */

describe('③三态：弃权 / 空表 / 有编辑', () => {
  it('槽里无人应答 ⇒ `[]`（Monaco 读得懂的"这次没改"）', () => {
    installKernel([contributionOf(() => undefined)]);
    expect(formatDocument(fakeModel(SOURCE).model)).toEqual([]);
  });

  it('有人答空表 ⇒ `[]`，且**不再问下一家**（空结果也是作答）', () => {
    const second = vi.fn<EditorLanguageServiceContribution['provide']>(() => undefined);
    installKernel([formatContribution([], 'first'), contributionOf(second, 'second')]);
    expect(formatDocument(fakeModel(SOURCE).model)).toEqual([]);
    expect(second).not.toHaveBeenCalled();
  });

  it('有编辑 ⇒ 同数量的 `TextEdit[]`；**第一家**说了算', () => {
    const second = vi.fn<EditorLanguageServiceContribution['provide']>(() => undefined);
    installKernel([
      formatContribution([EDIT], 'first'),
      contributionOf(second, 'second'),
    ]);
    const edits = formatDocument(fakeModel(SOURCE).model);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toBe(EDIT.newText);
    expect(second).not.toHaveBeenCalled();
  });

  it('一家抛错只让这家缺席（warn 带贡献 id），下一家照答', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installKernel([
      contributionOf(() => {
        throw new Error('桩：供方炸了');
      }, 'boom'),
      formatContribution([EDIT], 'ok'),
    ]);
    expect(formatDocument(fakeModel(SOURCE).model)).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('boom');
  });

  it('取文抛错（模型已释放）⇒ `[]`，不抛进快捷键路径', () => {
    installKernel([formatContribution([EDIT])]);
    const broken = fakeModel(SOURCE);
    broken.breakGetValue();
    expect(formatDocument(broken.model)).toEqual([]);
  });

  it('非 formatting 的应答不算答（kind 不对 ⇒ 继续问下一家）', () => {
    installKernel([
      contributionOf(() => ({ kind: 'hover', contents: '不是排版' }) as never, 'wrong-kind'),
      formatContribution([EDIT], 'ok'),
    ]);
    expect(formatDocument(fakeModel(SOURCE).model)).toHaveLength(1);
  });
});

/* ============================== ④ 注册（共享收口） ============================== */

describe('④注册：两枚 provider 走共享收口 + 能力名 `formatting`（不读开关）', () => {
  it('两枚各自挂满 selector 清单（descriptor 现算：全铺语言 + 点名 `formatting` 的语言）', () => {
    const fake = fakeMonaco();
    installKojo2DocumentFormatter(fake.monaco);
    installKojo2RangeFormatter(fake.monaco);
    expect(fake.registrations.filter((entry) => entry.kind === 'document').map((e) => e.selector))
      .toEqual(FORMAT_SELECTORS);
    expect(fake.registrations.filter((entry) => entry.kind === 'range').map((e) => e.selector))
      .toEqual(FORMAT_SELECTORS);
    // 反证：kojo2 确实在列（descriptor 点名了这枚能力），且不止它一门
    expect(FORMAT_SELECTORS).toContain(KOJO2_LANGUAGE_ID);
    expect(FORMAT_SELECTORS).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID, KOJO2_LANGUAGE_ID]);
  });

  it('每一条能力挂的是**同一枚** provider；两枚安装器互不越界（整篇不注册区间，反之亦然）', () => {
    const fake = fakeMonaco();
    installKojo2DocumentFormatter(fake.monaco);
    const documentOnly = fake.registrations.filter((entry) => entry.kind === 'range');
    expect(documentOnly).toEqual([]);
    const providers = new Set(
      fake.registrations.filter((entry) => entry.kind === 'document').map((entry) => entry.provider),
    );
    expect(providers.size).toBe(1);

    const second = fakeMonaco();
    installKojo2RangeFormatter(second.monaco);
    expect(second.registrations.filter((entry) => entry.kind === 'document')).toEqual([]);
  });

  it('dispose 幂等（逐枚各撤一次，第二次零动作）', () => {
    const fake = fakeMonaco();
    const handle = installKojo2DocumentFormatter(fake.monaco);
    handle.dispose();
    expect(fake.disposeCalls()).toBe(FORMAT_SELECTORS.length);
    handle.dispose();
    expect(fake.disposeCalls()).toBe(FORMAT_SELECTORS.length);
  });

  it('半途抛错 ⇒ 已挂上的先撤回，错误原样外抛', () => {
    const fake = fakeMonaco(1);
    expect(() => installKojo2DocumentFormatter(fake.monaco)).toThrow(/桩：注册抛错/);
    expect(fake.registrations).toHaveLength(1);
    expect(fake.disposeCalls()).toBe(1);
  });

  it('源码钉子：共享收口 + 能力名；不读开关、不留第二套编辑机制、判据不在本层', () => {
    const code = codeOf(LAYER_SOURCE);
    expect(code.match(/registerForLanguageServices\(/g) ?? []).toHaveLength(2);
    expect(code.match(/'formatting',/g) ?? []).toHaveLength(2);
    // 原生自建注册（第一参写死 kojo2）已删干净——闸门按这两条形状 grep 归零
    expect(code).not.toMatch(/registerDocumentFormattingEditProvider\(\s*KOJO2_LANGUAGE_ID/);
    expect(code).not.toMatch(/registerDocumentRangeFormattingEditProvider\(\s*KOJO2_LANGUAGE_ID/);
    // 判据搬走了；落地/撤销也不在本层
    expect(code).not.toContain('isKojo2CutoverEnabled');
    expect(code).not.toContain('executeEdits');
    expect(code).not.toContain('pushUndoStop');
    expect(code).not.toContain('applyKojo2Format');
    expect(code).not.toContain('formatKojo2Source');
  });
});

/* ============================== 小工具 ============================== */

/** 纯代码面（剥掉整行注释与块注释）：源码针只钉**代码**，注释里提到方法名不该把针弄红/弄绿 */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}
