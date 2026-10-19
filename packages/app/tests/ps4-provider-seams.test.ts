/**
 * PS-4（2026-10-18 性能批）· provider 缝的判据钉子。
 *
 * 钉的是**缝本身**（`ui/editor-global-providers.ts` 里那几条大文档腿 + `monaco/kojo-format-range.ts`
 * 的窗口腿 + `monaco/kojo-inlay-hints.ts` 的区间交回 + `ui/selection-status.ts` 的档位），
 * 每条都对着一个真实缺陷：
 * ① 折叠没有档位（一次停笔 = 整篇 copy + 两遍扫描，Monaco 每次内容变化都重问）；
 * ② 💡 在每次光标移动 / 每次波浪线刷新时 copy 整篇并让插件重跑整篇结构体检，
 *    而**零波浪线的方言请求本来一条动作都产不出**；
 * ③ on-type 格式化为了产一行编辑把整篇算一遍；
 * ④ 行内提示无视 Monaco 递来的区间（每次滚动为全篇每条提示重建装饰器）、签名取整篇；
 * ⑤ 选区字符数按**每次光标事件** O(选中行数) 逐行物化文本。
 *
 * 三类断言反复出现，各有理由：
 * - **「一次都没叫」**（`getValueCalls` / 供方 `provide` 次数）——性能改动只有把"省掉的那次"
 *   钉成断言才算数，不然下一次改回来没人知道；
 * - **「与老路逐字同结果」**（等价性对照）——省成本的前提是不改语义，`.kojo` 的改写动作、
 *   跨行签名、窗口格式化都拿这个判据过；
 * - **「档位线与既有那一条同源」**——不许出现第二个 5000 / 第二个 2000。
 *
 * 1020 止血批在这一族上加的两条判据（都曾**编进过测试**，所以改动就发生在测试里）：
 * - 折叠的档位**必须等于档位表上 `folding` 那一格**（缝上自立 5,000 行那条线把 5k–50k 档
 *   的折叠削成了"有折痕、折不动"，而这一档正是档位批自己写的"不值这一刀"）；
 * - 折叠超额**按数量截 + 把截了多少说出去**（对标 VSCode `FoldingLimitReporter`），
 *   不许用"交回空表"表示"太大了"。
 *
 * monaco 运行时不进 node（本池 environment = node），照 `editor-global-providers-tables.test.ts`
 * 的做法 `vi.mock` 掉 `../src/monaco/entry`，只给它真的用到的那几个桶。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type {
  EditorCodeActionContribution,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  KojoCallProtocol,
  KojoCallSlot,
  LineDecoration,
} from '@kojo/plugin-api';
import type { Kernel } from '@kojo/kernel';
import { computeFormatEdits, type FormatEdit } from '@kojo/plugin-kojo-sugar';
import { FULLWIDTH_SPACE } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { LARGE_FILE_LINES, HUGE_FILE_LINES, editorOptionsForLineCount } from '../src/ui/editor-options';
import { installRangeFormatter } from '../src/monaco/kojo-format-range';
import { toMonacoInlayHints } from '../src/monaco/kojo-inlay-hints';
import { resolveSignatureInText } from '../src/monaco/kojo-signature';
import {
  SELECTION_CHAR_COUNT_MAX_LINES,
  selectionCharCountAffordable,
  selectionStatusText,
  type SelModelLike,
  type SelRangeLike,
} from '../src/ui/selection-status';
import { livePanes, type PaneCtx } from '../src/ui/editor-pane-registry';

const stub = vi.hoisted(() => {
  const invoke = (path: string): unknown => {
    if (path === 'monaco.Range') return function Range(...args: number[]) { return args; };
    return { dispose: () => undefined };
  };
  const universal = (path: string): unknown =>
    new Proxy(function kojoMonacoStub() {}, {
      get: (_t, key) => (typeof key === 'symbol' || key === 'then' ? undefined : universal(`${path}.${String(key)}`)),
      apply: (_t, _this, args) => (args.length === 0 ? invoke(path) : invoke(path)),
      construct: () => ({ stubConstructed: path }),
    });
  return { universal };
});

vi.mock('../src/monaco/entry', () => ({
  editor: stub.universal('monaco.editor'),
  languages: stub.universal('monaco.languages'),
  Uri: stub.universal('monaco.Uri'),
  Range: stub.universal('monaco.Range'),
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
}));

// 动态 import：保证桩先就位（接线层 import 期就会碰 monaco 运行时）
const seam = await import('../src/ui/editor-global-providers');
const {
  foldingAffordable,
  foldingRangesFor,
  foldingCapNoticeFor,
  onFoldingCapChanged,
  FOLDING_MAX_RANGES,
  inlayHintsFor,
  codeLensesFor,
  signatureHelpAt,
  formatRequestWindowFor,
  provideCodeActionsFor,
} = seam;

const FW = FULLWIDTH_SPACE;

/* ============================== 假 model / 假 kernel ============================== */

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
  /** 整篇 copy 被叫了几次（`getValue`）——性能改动的正判据就钉在这里 */
  readonly getValueCalls: () => number;
  readonly getValueInRangeCalls: () => number;
  readonly bump: () => void;
}

/**
 * 只实现这几条腿真用到的那几个方法。
 * `lineCount` 与 `lines` 分开给：档位判的是行数，夹具不想为此造五万行文本。
 */
function fakeModel(
  lines: readonly string[],
  opts: { languageId?: string; lineCount?: number } = {},
): FakeModel {
  const lineCount = opts.lineCount ?? lines.length;
  const state = { versionId: 1, fullCopies: 0, windows: 0 };
  const model = {
    getLanguageId: () => opts.languageId ?? ERB_LANGUAGE_ID,
    getLineCount: () => lineCount,
    getLineMaxColumn: (l: number) => (lines[l - 1] ?? '').length + 1,
    getLineContent: (l: number) => lines[l - 1] ?? '',
    getValue: () => {
      state.fullCopies += 1;
      return lines.join('\n');
    },
    getValueInRange: (range: Monaco.IRange) => {
      state.windows += 1;
      return lines.slice(range.startLineNumber - 1, range.endLineNumber).join('\n');
    },
    getAlternativeVersionId: () => state.versionId,
  };
  return {
    model: model as unknown as Monaco.editor.ITextModel,
    getValueCalls: () => state.fullCopies,
    getValueInRangeCalls: () => state.windows,
    bump: () => {
      state.versionId += 1;
    },
  };
}

/** `ui.editor.languageService` 的贡献方桩：记账"被问了什么文本"，答案由调用方给 */
function languageServiceStub(
  kind: 'foldingRange' | 'codeLens' | 'inlayHint',
  answer: unknown,
  asks: { text: string; lineCount?: number }[],
): EditorLanguageServiceContribution {
  return {
    id: `ps4-${kind}`,
    order: 10,
    provide: (request: LanguageServiceRequest) => {
      if (request.kind !== kind) return undefined;
      asks.push({ text: request.text, lineCount: request.lineCount });
      return answer as never;
    },
  } as unknown as EditorLanguageServiceContribution;
}

interface KernelOpts {
  readonly languageService?: readonly EditorLanguageServiceContribution[];
  readonly codeAction?: readonly EditorCodeActionContribution[];
  readonly project?: unknown;
  readonly adapter?: { kojoCallProtocol?: KojoCallProtocol };
}

/** `ui.editor.languageService` 槽的请求形状（从契约上取，不手抄字段：契约改了这里跟着红） */
type LanguageServiceRequest = EditorLanguageServiceRequest;
/** `ui.editor.codeAction` 槽的请求形状（同上） */
type CodeActionFile = Parameters<EditorCodeActionContribution['provideActions']>[0];

/** 三条腿共用的一张假槽表：`query` 按槽名取，缺席就是空表（该路自然不应答） */
function fakeKernel(opts: KernelOpts & { projectRef?: { current: unknown } }): {
  kernel: Kernel;
  setProject: (project: unknown) => void;
  setLanguageService: (contributions: readonly EditorLanguageServiceContribution[]) => void;
} {
  const state: {
    project: unknown;
    languageService: readonly EditorLanguageServiceContribution[];
    codeAction: readonly EditorCodeActionContribution[];
    adapter: { kojoCallProtocol?: KojoCallProtocol; gameId: string };
  } = {
    project: opts.projectRef?.current ?? opts.project ?? null,
    languageService: opts.languageService ?? [],
    codeAction: opts.codeAction ?? [],
    // `gameId` 恒给：`editorTables` 按 `project.adapterId === adapter.gameId` 精确匹配，
    // 匹配不上就走"只给静态面"那一路（`callProtocol` 会被判成缺席，签名那条腿白测）
    adapter: { gameId: 'eraTW', ...opts.adapter },
  };
  const kernel = {
    project: { current: () => state.project },
    slots: {
      query: (slot: string) =>
        slot === 'ui.editor.languageService'
          ? state.languageService
          : slot === 'ui.editor.codeAction'
            ? state.codeAction
            : slot === 'game.adapter'
              ? [{ id: 'ps4-adapter', adapter: state.adapter }]
              : [],
    },
    services: { tryGet: () => undefined },
    bus: { emit: () => undefined },
  } as unknown as Kernel;
  return {
    kernel,
    setProject: (project) => {
      state.project = project;
    },
    setLanguageService: (contributions) => {
      state.languageService = contributions;
    },
  };
}

const SLOTS: readonly KojoCallSlot[] = [
  { index: 3, kind: 'int', label: '事件子参数' },
  { index: 4, kind: 'int', label: '日期偏移' },
];

/** 只认 `F`：其余名字一律"协议不认识 ⇒ 不应答"（与 B5 的口径同源） */
const protocolStub: KojoCallProtocol = { slotsFor: (name) => (name === 'F' ? SLOTS : null) };

/**
 * 一次 pane 档案。💡 那条腿（`provideCodeActionsFor`）只要 `filePathRef` / `pendingActionsRef` /
 * `actionSeqRef`——接线层用 `owningPaneOf(model)` 拿到 ctx 再递进来；而窗口取文那条腿
 * （`formatRequestWindowFor`）走的是 `owningPanePathOf(model)`，**必须由注册表反查到 model**
 * （`owningPaneOf` 只认 `editorRef.current.getModel()`，糖 model 那条腿判无主）。
 * 所以这里给得出 model 的用例都要把 model 挂上，否则测的是「反查不到」而不是「不该应答」。
 *
 * `sugarLineMapRef` 恒给空表：糖投影的「预览行 → 源行」表与 `sugarModelRef` 同批换上，
 * 读类腿拿不到表就应当退化（换算批的口径钉在 `sugar-provider-line-map.test.ts`）。
 */
function fakePane(
  path: string,
  shown?: Monaco.editor.ITextModel,
  sugarOf?: Monaco.editor.ITextModel,
  lineMap: readonly number[] = [],
): PaneCtx {
  return {
    paneId: `ps4-${path}`,
    filePathRef: { current: path },
    pendingActionsRef: { current: new Map<string, unknown>() },
    actionSeqRef: { current: 0 },
    editorRef: {
      current: shown
        ? ({ getModel: () => shown } as unknown as Monaco.editor.IStandaloneCodeEditor)
        : null,
    },
    sugarModelRef: { current: sugarOf ?? null },
    sugarLineMapRef: { current: lineMap },
    entriesRef: { current: new Map<string, never>() },
    crumbTreeCacheRef: { current: null },
  } as unknown as PaneCtx;
}

const marker = (line: number, code: string, message: string): Monaco.editor.IMarkerData =>
  ({
    severity: 8,
    message,
    startLineNumber: line,
    startColumn: 1,
    endLineNumber: line,
    endColumn: 5,
    code,
  }) as unknown as Monaco.editor.IMarkerData;

const context = (markers: readonly Monaco.editor.IMarkerData[]): Monaco.languages.CodeActionContext =>
  ({ markers, only: undefined, trigger: 1 }) as unknown as Monaco.languages.CodeActionContext;

const rangeAt = (line: number): Monaco.Range =>
  ({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }) as unknown as Monaco.Range;

const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

beforeEach(() => {
  warn.mockClear();
});

afterEach(() => {
  livePanes.clear();
});

/* ============================== ① 折叠：档位 + 版本记忆化 + 数量封顶 ============================== */

describe('foldingAffordable · 档位判据与编辑器选项是**同一份表**（1020 止血批）', () => {
  it('5,000–49,999 这一档照旧算"折得起"——这一条就是被削掉的那个功能', () => {
    // 改前缝上自己按 LARGE_FILE_LINES（5,000）让路，而档位表写的是「折叠留到 huge 才关」：
    // 两份判据对不上 ⇒ 注册了供给器之后 Monaco 不再退回缩进折叠（vendor folding.js:67），
    // 面上留着折痕、一处也折不动。现在这一档必须判"值"。
    expect(foldingAffordable(LARGE_FILE_LINES - 1)).toBe(true);
    expect(foldingAffordable(LARGE_FILE_LINES)).toBe(true);
    expect(foldingAffordable(12_000)).toBe(true);
    expect(foldingAffordable(HUGE_FILE_LINES - 1)).toBe(true);
  });

  it('只有 huge 档让路；**逐点等于档位表上 folding 那一格**（判据只许有一份）', () => {
    expect(foldingAffordable(HUGE_FILE_LINES)).toBe(false);
    // 真实语料之最那篇 52,601 行：落在 huge ⇒ 让路，但**选项那边同一拍就把折叠槽整条撤了**
    // （看得见的是"没有折痕"，不是"有折痕折不动"）
    expect(foldingAffordable(52_601)).toBe(false);
    expect(foldingAffordable(990_000)).toBe(false);
    for (const n of [1, 4_999, LARGE_FILE_LINES, 12_000, HUGE_FILE_LINES - 1, HUGE_FILE_LINES, 52_601, 990_000]) {
      expect(foldingAffordable(n), `${n} 行：缝上与档位表对不上`).toBe(editorOptionsForLineCount(n).folding !== false);
    }
  });

  it('非有限的行数不算档内（ NaN / Infinity 不许蒙过去）', () => {
    expect(foldingAffordable(Number.NaN)).toBe(false);
    expect(foldingAffordable(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('foldingRangesFor · 让路可见、重问不重扫', () => {
  const smallDoc = ['@FOO', 'IF X', 'ENDIF'];

  it('档外（huge）：一次都不 copy 整篇、一次都不问供方，并**报出一条降级**（铁律 4：不许静默）', () => {
    const asks: { text: string; lineCount: number }[] = [];
    const { kernel } = fakeKernel({ languageService: [languageServiceStub('foldingRange', { kind: 'foldingRange', ranges: [] }, asks)] });
    const doc = fakeModel(smallDoc, { lineCount: 52_601 });
    const path = 'C:/erb/ps4-折叠档外.ERB';
    expect(foldingRangesFor(doc.model, path, kernel)).toEqual([]);
    expect(asks).toHaveLength(0);
    expect(doc.getValueCalls()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(path);
    // 同一篇再问一次不许再报（每 (能力, 文件) 一次；去重表若失效就是每次滚动都刷屏）
    foldingRangesFor(doc.model, path, kernel);
    expect(warn).toHaveBeenCalledTimes(1);
    // 这一档的折叠压根没问供方 ⇒ "截了尾巴"那句说法也不许留着（没有折痕的面上挂一句超额 = 谎话）
    expect(foldingCapNoticeFor(path)).toBeNull();
  });

  it('5,000–49,999 档（语料里约 6% 的文件在这一档）：供方**照旧被问到**、整篇照旧 copy 一次', () => {
    // 回归钉子：这一档改前直接交回空表（功能没了），现在必须走到底
    const asks: { text: string; lineCount: number }[] = [];
    const ranges = [{ startLine: 2, endLine: 3 }];
    const { kernel } = fakeKernel({ languageService: [languageServiceStub('foldingRange', { kind: 'foldingRange', ranges }, asks)] });
    const doc = fakeModel(smallDoc, { lineCount: LARGE_FILE_LINES });
    const path = 'C:/erb/ps4-折叠5k档.ERB';
    expect(foldingRangesFor(doc.model, path, kernel)).toEqual(ranges);
    expect(asks).toHaveLength(1);
    expect(doc.getValueCalls()).toBe(1);
    expect(asks[0]!.lineCount).toBe(LARGE_FILE_LINES);
    expect(warn).not.toHaveBeenCalled();
    expect(foldingCapNoticeFor(path)).toBeNull();
  });

  it('档内：内容没变被反复问，供方只被问一次、整篇只 copy 一次', () => {
    const asks: { text: string; lineCount: number }[] = [];
    const ranges = [{ startLine: 2, endLine: 3 }];
    const { kernel } = fakeKernel({ languageService: [languageServiceStub('foldingRange', { kind: 'foldingRange', ranges }, asks)] });
    const doc = fakeModel(smallDoc);
    const path = 'C:/erb/ps4-折叠记忆化.ERB';
    const first = foldingRangesFor(doc.model, path, kernel);
    const again = foldingRangesFor(doc.model, path, kernel);
    const third = foldingRangesFor(doc.model, path, kernel);
    expect(first).toEqual(ranges);
    expect(again).toEqual(ranges);
    expect(third).toEqual(ranges);
    expect(asks).toHaveLength(1);
    expect(doc.getValueCalls()).toBe(1);
    expect(asks[0]!.text).toBe(smallDoc.join('\n'));
    expect(asks[0]!.lineCount).toBe(smallDoc.length);
  });

  it('键的四项任一项变都必须重算——少一项就是一次"把上一份的结论搬到这一份上"', () => {
    const asks: { text: string; lineCount: number }[] = [];
    // 第二张桩另记一本账：`asks` 只记**轮数**（一轮问两条贡献方 = 两条目，会把轮数读成条数）
    const extraAsks: { text: string; lineCount: number }[] = [];
    const { kernel, setProject, setLanguageService } = fakeKernel({
      languageService: [languageServiceStub('foldingRange', { kind: 'foldingRange', ranges: [] }, asks)],
    });
    const doc = fakeModel(smallDoc);
    const path = 'C:/erb/ps4-折叠键.ERB';
    foldingRangesFor(doc.model, path, kernel);
    expect(asks).toHaveLength(1);
    // ① 版本变了（用户改了字）
    doc.bump();
    foldingRangesFor(doc.model, path, kernel);
    expect(asks).toHaveLength(2);
    // ② 项目换了（同一个 model、同一版本，但上一个项目的索引不能带过来）
    setProject({ adapterId: 'game-b' });
    foldingRangesFor(doc.model, path, kernel);
    expect(asks).toHaveLength(3);
    // ③ 贡献方条数变了（插件启停 ⇒ 并集口径变了，缓存里那份是"上一套注册"的答案）
    setLanguageService([
      languageServiceStub('foldingRange', { kind: 'foldingRange', ranges: [] }, asks),
      languageServiceStub('foldingRange', { kind: 'foldingRange', ranges: [] }, extraAsks),
    ]);
    foldingRangesFor(doc.model, path, kernel);
    expect(asks).toHaveLength(4);
    expect(extraAsks).toHaveLength(1);
    // ④ 换了另一份 model（键相同也不许共用答案：WeakMap 以 model 为键）
    const other = fakeModel(smallDoc);
    foldingRangesFor(other.model, path, kernel);
    expect(asks).toHaveLength(5);
    expect(other.getValueCalls()).toBe(1);
  });

  it('没有折叠供方应答时：答案照旧是空表，且这条腿照样只问一次', () => {
    const { kernel } = fakeKernel({ languageService: [] });
    const doc = fakeModel(smallDoc);
    const path = 'C:/erb/ps4-折叠无供方.ERB';
    expect(foldingRangesFor(doc.model, path, kernel)).toEqual([]);
    expect(foldingRangesFor(doc.model, path, kernel)).toEqual([]);
  });
});

/**
 * 折叠**超额**那一格（1020 止血批补的机制，对标 VSCode 的 `FoldingLimitReporter`）。
 *
 * 判据形状：大文件上**不许**把折叠整条没收（那是"少给了但没人说"），而是按数量截尾巴 +
 * 把截了多少说成宿主工具条上的一句人话。数量线取 vendor 自己那条（`foldingMaximumRegions`
 * 缺省 5,000，取证见 `ps5-editor-tiers.test.ts` 的 vendor 段），所以这一档
 * **不比 Monaco 少给任何东西**，只多了一句人话。
 */
describe('foldingRangesFor · 超额按数量封顶并把超额说出来', () => {
  /** 从后往前给的 total 条区间（**故意乱序**：留下的必须是按行号最靠前的那些，不是"先算出来的"） */
  const manyRanges = (total: number) =>
    Array.from({ length: total }, (_, i) => ({ startLine: total - i, endLine: total - i + 1 }));

  const cappedKernel = (total: number) => {
    const asks: { text: string; lineCount: number }[] = [];
    const { kernel } = fakeKernel({
      languageService: [languageServiceStub('foldingRange', { kind: 'foldingRange', ranges: manyRanges(total) }, asks)],
    });
    return { kernel, asks };
  };

  it('超额：交回恰是上限条、且是最靠前的那批；超额的那部分记成一条可见说法', () => {
    const total = FOLDING_MAX_RANGES + 3;
    const { kernel } = cappedKernel(total);
    const doc = fakeModel(['@FOO'], { lineCount: 1_000 });
    const path = 'C:/erb/ps4-折叠超额.ERB';
    const out = foldingRangesFor(doc.model, path, kernel);
    expect(out).toHaveLength(FOLDING_MAX_RANGES);
    expect(out[0]).toEqual({ startLine: 1, endLine: 2 });
    expect(out[FOLDING_MAX_RANGES - 1]).toEqual({ startLine: FOLDING_MAX_RANGES, endLine: FOLDING_MAX_RANGES + 1 });
    expect(foldingCapNoticeFor(path)).toEqual({ shownRanges: FOLDING_MAX_RANGES, droppedRanges: 3 });
  });

  it('通知只在状态**真变了**时发一次（折叠每次停笔都被重问，超额那句不许刷屏）', () => {
    const { kernel } = cappedKernel(FOLDING_MAX_RANGES + 1);
    const doc = fakeModel(['@FOO'], { lineCount: 1_000 });
    const path = 'C:/erb/ps4-折叠超额去重.ERB';
    const seen: (string | null)[] = [];
    const off = onFoldingCapChanged((p, notice) => {
      if (p === path) seen.push(notice === null ? null : `drop:${notice.droppedRanges}`);
    });
    try {
      foldingRangesFor(doc.model, path, kernel);
      foldingRangesFor(doc.model, path, kernel);
      foldingRangesFor(doc.model, path, kernel);
      expect(seen).toEqual(['drop:1']);
      // 改小一回档（不再超额）⇒ 那句话必须**撤掉**，不能留在面上说假话
      doc.bump();
      const { kernel: small } = cappedKernel(FOLDING_MAX_RANGES);
      foldingRangesFor(doc.model, path, small);
      expect(seen).toEqual(['drop:1', null]);
      foldingRangesFor(doc.model, path, small);
      expect(seen).toEqual(['drop:1', null]);
    } finally {
      off();
    }
  });

  it('上限之内一条都不截、也不挂任何说法（判据是"超额"，不是"文件大"）', () => {
    const { kernel, asks } = cappedKernel(FOLDING_MAX_RANGES);
    const doc = fakeModel(['@FOO'], { lineCount: 1_000 });
    const path = 'C:/erb/ps4-折叠刚好.ERB';
    expect(foldingRangesFor(doc.model, path, kernel)).toHaveLength(FOLDING_MAX_RANGES);
    expect(asks).toHaveLength(1);
    expect(foldingCapNoticeFor(path)).toBeNull();
  });
});

/* ============================== ② 💡：零波浪线的闸 + 同请求照抄 ============================== */

/** 一张"按波浪线应答"的贡献方桩：真实结构修复的判据形状（有诊断才有条目） */
function structureLikeContribution(asks: { text: string; diagnostics: unknown[]; line?: number }[]): EditorCodeActionContribution {
  return {
    id: 'ps4-structure-fix',
    order: 30,
    provideActions: (file: CodeActionFile) => {
      asks.push({ text: file.text, diagnostics: [...(file.diagnostics ?? [])], ...(file.line !== undefined ? { line: file.line } : {}) });
      return (file.diagnostics ?? []).map((d: LineDecoration) => ({
        title: `补回（第 ${d.line} 行）`,
        kind: 'quickfix' as const,
        edits: [{ fromLine: d.line, toLine: d.line, newText: 'ENDIF' }],
        run: () => undefined,
      }));
    },
  } as unknown as EditorCodeActionContribution;
}

describe('provideCodeActionsFor · 零波浪线那道闸', () => {
  it('ERB + 零波浪线 ⇒ 一条都不问、整篇一次都不 copy（改前改后都是零条动作，不减能力）', () => {
    const asks: { text: string; diagnostics: unknown[]; line?: number }[] = [];
    const { kernel } = fakeKernel({ codeAction: [structureLikeContribution(asks)] });
    const doc = fakeModel(['@FOO', 'IF X']);
    const pane = fakePane('C:/erb/ps4-零波浪线.ERB');
    const out = provideCodeActionsFor(doc.model, rangeAt(2), context([]), pane, kernel);
    expect(out.actions).toEqual([]);
    expect(asks).toHaveLength(0);
    expect(doc.getValueCalls()).toBe(0);
  });

  it('`.kojo` + 零波浪线 ⇒ 同样一条都不问（LIFT-2 后 `.kojo` 上不再有不依赖诊断的动作）', () => {
    const asks: { text: string; diagnostics: unknown[]; line?: number }[] = [];
    const { kernel } = fakeKernel({ codeAction: [structureLikeContribution(asks)] });
    const doc = fakeModel(['函数 甲', '  若 X'], { languageId: KOJO_LANGUAGE_ID });
    const pane = fakePane('C:/kojo/ps4-零波浪线.kojo');
    const out = provideCodeActionsFor(doc.model, rangeAt(2), context([]), pane, kernel);
    expect(out.actions).toEqual([]);
    expect(asks).toHaveLength(0);
    expect(doc.getValueCalls()).toBe(0);
  });

  it('有波浪线时逐字照旧：marker 翻成诊断递给贡献方，动作带 command 反查 id', () => {
    const asks: { text: string; diagnostics: unknown[]; line?: number }[] = [];
    const { kernel } = fakeKernel({ codeAction: [structureLikeContribution(asks)] });
    const doc = fakeModel(['@FOO', 'IF X', 'PRINT 1']);
    const pane = fakePane('C:/erb/ps4-有波浪线.ERB');
    const out = provideCodeActionsFor(
      doc.model,
      rangeAt(2),
      context([marker(2, 'erb.unclosed-open', 'IF 未闭合')]),
      pane,
      kernel,
    );
    expect(asks).toHaveLength(1);
    expect(asks[0]!.diagnostics).toEqual([
      expect.objectContaining({ line: 2, severity: 'error', message: 'IF 未闭合', code: 'erb.unclosed-open' }),
    ]);
    expect(out.actions.map((a) => a.title)).toEqual(['补回（第 2 行）']);
    const command = out.actions[0]!.command!;
    expect(command.id).toBe('kojo.codeAction.run');
    const actionId = (command.arguments as string[])[0]!;
    expect(pane.pendingActionsRef.current.has(actionId)).toBe(true);
  });

  it('同一篇同一行同一组波浪线被反复问（光标移动 / 波浪线重发布）⇒ 只问供方一次，且**动作仍执行得了**', () => {
    const asks: { text: string; diagnostics: unknown[]; line?: number }[] = [];
    const { kernel } = fakeKernel({ codeAction: [structureLikeContribution(asks)] });
    const doc = fakeModel(['@FOO', 'IF X']);
    const pane = fakePane('C:/erb/ps4-照抄上次.ERB');
    const markers = [marker(2, 'erb.unclosed-open', 'IF 未闭合')];
    const first = provideCodeActionsFor(doc.model, rangeAt(2), context(markers), pane, kernel);
    const actionId = (first.actions[0]!.command!.arguments as string[])[0]!;
    // 反查表被超阈值整体清过——命中缓存时要把 id → 动作**重新挂回去**，不然点了没反应
    pane.pendingActionsRef.current.clear();
    const again = provideCodeActionsFor(doc.model, rangeAt(2), context(markers), pane, kernel);
    expect(asks).toHaveLength(1);
    expect(doc.getValueCalls()).toBe(1);
    expect(again.actions).toEqual(first.actions);
    const sameId = (again.actions[0]!.command!.arguments as string[])[0]!;
    expect(sameId).toBe(actionId);
    expect(pane.pendingActionsRef.current.has(sameId)).toBe(true);
  });

  it('请求变一点就重算：行号不同 / 波浪线不同 / 内容改了，各算一次新请求', () => {
    const asks: { text: string; diagnostics: unknown[]; line?: number }[] = [];
    const { kernel } = fakeKernel({ codeAction: [structureLikeContribution(asks)] });
    const doc = fakeModel(['@FOO', 'IF X', 'ENDIF']);
    const pane = fakePane('C:/erb/ps4-重算.ERB');
    const m2 = [marker(2, 'erb.unclosed-open', 'IF 未闭合')];
    provideCodeActionsFor(doc.model, rangeAt(2), context(m2), pane, kernel);
    provideCodeActionsFor(doc.model, rangeAt(2), context(m2), pane, kernel);
    expect(asks).toHaveLength(1);
    // 换行（同一条波浪线问的是另一个位置）
    provideCodeActionsFor(doc.model, rangeAt(3), context(m2), pane, kernel);
    expect(asks).toHaveLength(2);
    // 波浪线换了（消息 / 码 / 条数任一不同都是另一次请求）
    provideCodeActionsFor(doc.model, rangeAt(3), context([marker(2, 'erb.unclosed-open', 'IF 没闭合')]), pane, kernel);
    expect(asks).toHaveLength(3);
    provideCodeActionsFor(doc.model, rangeAt(3), context([m2[0]!, marker(3, 'erb.expr', '表达式')]), pane, kernel);
    expect(asks).toHaveLength(4);
    // 内容改了
    doc.bump();
    provideCodeActionsFor(doc.model, rangeAt(3), context([m2[0]!, marker(3, 'erb.expr', '表达式')]), pane, kernel);
    expect(asks).toHaveLength(5);
  });

  it('💡 是**写**类出口：没有路径的标签 ⇒ 零动作、零 copy', () => {
    // 分界判据 = "这个动作最终会不会写盘"。💡 / quickfix 会在原文上落笔 ⇒ 糖面上继续否决，
    // 那道闸在注册处（`owningPaneOf(糖 model)` 判无主）与落地处（`applyQuickFixEdits` 见糖 model
    // 就返回 false）各一次，两条都在 `sugar-provider-line-map.test.ts` 里钉着。
    const asks: { text: string; diagnostics: unknown[]; line?: number }[] = [];
    const { kernel } = fakeKernel({ codeAction: [structureLikeContribution(asks)] });
    const doc = fakeModel(['@FOO']);
    const pane = fakePane('');
    expect(provideCodeActionsFor(doc.model, rangeAt(1), context([marker(1, 'c', 'm')]), pane, kernel).actions).toEqual([]);
    expect(asks).toHaveLength(0);
  });
});

/* ============================== ③ 签名：窗口取代整篇 ============================== */

describe('signatureHelpAt · 只取回看窗口那几行', () => {
  const oldWay = (lines: readonly string[], line: number, column: number) =>
    resolveSignatureInText(lines.join('\n'), line, column, protocolStub, () => null);

  it('光标行往上 `SIGNATURE_LOOKBACK_LINES` 行就够：整篇一次都不 copy', () => {
    // 垫行用**注释行**（`stripInlineComment` 截成空串）：`PRINT 236` 这类垫行拼进 middle 后
    // 会贴着调用名（`…PRINT 239F(` ⇒ 被当成标识符 `239F`），把"协议不认识"混进来，
    // 这一档要量的是「窗口够不够长」，不是「名字认不认得出」。
    const lines = Array.from({ length: 400 }, (_, i) => (i === 300 ? 'F(1, 2' : `;垫行 ${i}`));
    const { kernel } = fakeKernel({ adapter: { kojoCallProtocol: protocolStub }, project: { adapterId: 'eraTW' } });
    const doc = fakeModel(lines);
    const hit = signatureHelpAt(doc.model, { lineNumber: 301, column: 5 } as Monaco.Position, kernel);
    expect(hit?.callee).toBe('F');
    expect(hit?.signature.activeParameter).toBe(1);
    // 与整篇视角同答案（两条路的行集合逐字相同：向上收行本来就封顶在回看上限）
    expect(hit).toEqual(oldWay(lines, 301, 5));
    expect(doc.getValueCalls()).toBe(0);
    expect(doc.getValueInRangeCalls()).toBe(1);
  });

  it('与整篇视角逐字同结果：跨行深度、最内层括号、窗口边界、超出回看上限那几例一律一致', () => {
    const cases: readonly (readonly string[])[] = [
      ['F(1, 2)'],
      ['F(', '1,', '2)'],
      ['PRINT 0', 'G(F(1,', '2), 3)', 'X = 4'],
      [';F(1, 2)'],
      ['F("甲,乙", 2)'],
      ['A = F(1，2'], // 全角逗号
      ['F(', 'G(', 'H(', '1, 2)'],
    ];
    const { kernel } = fakeKernel({ adapter: { kojoCallProtocol: protocolStub }, project: { adapterId: 'eraTW' } });
    for (const lines of cases) {
      for (let line = 1; line <= lines.length; line++) {
        for (const column of [1, 2, lines[line - 1]!.length, lines[line - 1]!.length + 1]) {
          const doc = fakeModel(lines);
          expect(signatureHelpAt(doc.model, { lineNumber: line, column } as Monaco.Position, kernel)).toEqual(
            oldWay(lines, line, column),
          );
        }
      }
    }
    // 深窗口形态：光标离调用起点超过回看上限 ⇒ 两条路都必须"认不出这个调用"（不许窗口版更乐观）
    const deep = Array.from({ length: 300 }, (_, i) => (i === 0 ? 'F(' : i === 299 ? '1, 2)' : `PRINT ${i}`));
    const deepDoc = fakeModel(deep);
    const at = { lineNumber: 299, column: 3 } as Monaco.Position;
    expect(signatureHelpAt(deepDoc.model, at, kernel)).toEqual(oldWay(deep, 299, 3));
    expect(oldWay(deep, 299, 3)).toBeNull();
  });

  it('第一行往上不出界（文档比回看窗口还短）；越界行号不应答', () => {
    const { kernel } = fakeKernel({ adapter: { kojoCallProtocol: protocolStub }, project: { adapterId: 'eraTW' } });
    const doc = fakeModel(['F(1, 2)']);
    expect(signatureHelpAt(doc.model, { lineNumber: 1, column: 6 } as Monaco.Position, kernel)?.callee).toBe('F');
    expect(signatureHelpAt(doc.model, { lineNumber: 9, column: 1 } as Monaco.Position, kernel)).toBeNull();
    expect(signatureHelpAt(doc.model, { lineNumber: 0, column: 1 } as Monaco.Position, kernel)).toBeNull();
  });

  it('协议表缺席（没开项目 / adapter 不给调用协议）⇒ 不应答，也不 copy 整篇', () => {
    const { kernel } = fakeKernel({});
    const doc = fakeModel(['F(1, 2)']);
    expect(signatureHelpAt(doc.model, { lineNumber: 1, column: 6 } as Monaco.Position, kernel)).toBeNull();
    expect(doc.getValueCalls()).toBe(0);
  });
});

/* ============================== ③ 格式化：窗口腿与其等价性 ============================== */

describe('formatRequestWindowFor · 窗口取文的应答判据', () => {
  it('ERB：只交回要算的那几行，整篇不 copy', () => {
    const doc = fakeModel([`${FW}IF X`, 'PRINTFORMW 　「呀」', ';　注释　文', `${FW}${FW}`, 'ENDIF']);
    livePanes.set('ps4', fakePane('C:/erb/ps4-窗口.ERB', doc.model));
    const request = formatRequestWindowFor(doc.model, 3, 3);
    expect(request).not.toBeNull();
    expect(request!.text).toBe(';　注释　文');
    expect(request!.dialect).toBe('erb');
    expect(doc.getValueCalls()).toBe(0);
  });

  it('`.kojo` 一律交回 `null`：缩进单位探测与原生块状态是文档级判据，窗口视角会数错', () => {
    const doc = fakeModel(['函数 甲', '  若 X'], { languageId: KOJO_LANGUAGE_ID });
    // 挂上 model：这条测的是**方言判据**，不是「反查不到归属实例」（那一条下面单测）
    livePanes.set('ps4', fakePane('C:/kojo/ps4-窗口.kojo', doc.model));
    expect(formatRequestWindowFor(doc.model, 2, 2)).toBeNull();
    expect(doc.getValueInRangeCalls()).toBe(0);
    expect(doc.getValueCalls()).toBe(0);
  });

  it('格式化是**写**类出口：糖视图派生 model ⇒ `null`，一次取文都不做', () => {
    // 换算批把"糖 model ⇒ 整条静默"拆成了两条判据：**会写盘的**（格式化 / 💡 / 改名 / 搜索替换）
    // 在糖面上继续一律否决（改一个字节都是事故），**只读的**换算到原文再折回预览行。
    // 读类那半的口径钉在 `sugar-provider-line-map.test.ts`，本处只钉写类这半。
    const doc = fakeModel([`${FW}IF X`]);
    // ① 还没有路径的标签
    livePanes.set('ps4', fakePane('', doc.model));
    expect(formatRequestWindowFor(doc.model, 1, 1)).toBeNull();
    // ② 糖视图：注册表认得这份 model，但格式化要落笔的是原文 ⇒ 写类闸把它拦下
    livePanes.set('ps4', fakePane('C:/erb/ps4-糖视图.ERB', doc.model, doc.model, [1]));
    expect(formatRequestWindowFor(doc.model, 1, 1)).toBeNull();
    // ③ 根本不挂在任何活动标签上
    livePanes.clear();
    expect(formatRequestWindowFor(doc.model, 1, 1)).toBeNull();
    expect(doc.getValueCalls()).toBe(0);
    expect(doc.getValueInRangeCalls()).toBe(0);
  });

  it('陈旧 / 越界行号一律夹取（provider 与用户编辑之间没有锁）', () => {
    const doc = fakeModel(['A', 'B', 'C']);
    livePanes.set('ps4', fakePane('C:/erb/ps4-夹取.ERB', doc.model));
    expect(formatRequestWindowFor(doc.model, 9, 12)!.text).toBe('C');
    expect(formatRequestWindowFor(doc.model, 0, 0)!.text).toBe('A');
    expect(formatRequestWindowFor(doc.model, 3, 1)!.text).toBe('C');
  });
});

describe('installRangeFormatter · 窗口腿 ≡ 整篇腿（逐字节）', () => {
  const DOC_LINES = [`${FW}IF X`, `PRINTFORMW 　「呀」`, `;　注释　文`, `${FW}${FW}`, 'ENDIF'];
  const DOC = `${DOC_LINES.join('\n')}\n`;

  interface Registered {
    kind: 'range' | 'onType';
    provider: Monaco.languages.DocumentRangeFormattingEditProvider &
      Partial<Monaco.languages.OnTypeFormattingEditProvider>;
  }

  function stubMonaco() {
    const registered: Registered[] = [];
    const monaco = {
      languages: {
        registerDocumentRangeFormattingEditProvider(_id: string, provider: unknown) {
          registered.push({ kind: 'range', provider: provider as Registered['provider'] });
          return { dispose: () => undefined };
        },
        registerOnTypeFormattingEditProvider(_id: string, provider: unknown) {
          registered.push({ kind: 'onType', provider: provider as Registered['provider'] });
          return { dispose: () => undefined };
        },
      },
    } as unknown as typeof Monaco;
    return { monaco, registered };
  }

  /** 与生产接线同款的两条腿：`resolve` = 整篇，`resolveRange` = 窗口 */
  const handlers = () => ({
    resolve: (m: Monaco.editor.ITextModel) => ({ text: m.getValue(), dialect: 'erb' as const }),
    resolveRange: (m: Monaco.editor.ITextModel, start: number, end: number) => ({
      text: m.getValueInRange({
        startLineNumber: start,
        startColumn: 1,
        endLineNumber: end,
        endColumn: m.getLineMaxColumn(end),
      }),
      dialect: 'erb' as const,
    }),
  });

  const wholeOnly = (m: Monaco.editor.ITextModel) => ({ text: m.getValue(), dialect: 'erb' as const });

  const asEdits = (out: readonly unknown[]): FormatEdit[] =>
    (out as Monaco.languages.TextEdit[]).map((e) => ({
      line: e.range.startLineNumber,
      startColumn: e.range.startColumn,
      endColumn: e.range.endColumn,
      text: e.text,
    }));

  it('每个行区间上，窗口腿与整篇腿产出的编辑逐字节相同（全区间扫描）', () => {
    const { monaco, registered } = stubMonaco();
    installRangeFormatter(monaco, handlers());
    const range = registered.find((r) => r.kind === 'range')!.provider;
    const lineCount = DOC_LINES.length + 1; // 末行是文件尾的空行
    for (let start = 1; start <= lineCount; start++) {
      for (let end = start; end <= lineCount; end++) {
        const withWindow = asEdits(
          range.provideDocumentRangeFormattingEdits(
            fakeModel([...DOC_LINES, ''], { lineCount }).model,
            { startLineNumber: start, endLineNumber: end } as unknown as Monaco.Range,
            {} as Monaco.languages.FormattingOptions,
            {} as Monaco.CancellationToken,
          ) as Monaco.languages.TextEdit[],
        );
        const wholeDoc = computeFormatEdits(DOC, 'erb').filter((e) => e.line >= start && e.line <= end);
        expect(withWindow).toEqual(wholeDoc);
      }
    }
  });

  it('on-type 一次击键：走窗口腿时整篇一次都不 copy，结果与整篇腿同一条编辑', () => {
    const { monaco, registered } = stubMonaco();
    installRangeFormatter(monaco, handlers());
    const onType = registered.find((r) => r.kind === 'onType')!.provider;
    const doc = fakeModel([...DOC_LINES, '']);
    const out = onType.provideOnTypeFormattingEdits!(
      doc.model,
      { lineNumber: 3, column: 2 } as Monaco.Position,
      FW,
      {} as Monaco.languages.FormattingOptions,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.TextEdit[];
    expect(out).toHaveLength(1);
    expect(out[0]!.range.startLineNumber).toBe(3);
    expect(out[0]!.text).toBe('; 注释 文');
    expect(doc.getValueCalls()).toBe(0);
    // 2 次窗口取文 = 要算的那一行 + **窗口之前的那段前缀**（`kojo-format-range.ts` 的 `windowAnchor`：
    // ERB 形有了跨行块状态之后，切片真想改字节就得先问"起点在不在区里"）。
    // PS-4 要钉的那一条没变：**整篇一次都不 copy**；零编辑的击键仍然只取一行（免检通道）。
    expect(doc.getValueInRangeCalls()).toBe(2);
  });

  it('CRLF 与"最后一行"两个易错点：窗口文本切行后行号平移仍逐字对', () => {
    const { monaco, registered } = stubMonaco();
    installRangeFormatter(monaco, handlers());
    const range = registered.find((r) => r.kind === 'range')!.provider;
    const crlf = [`${FW}甲`, `${FW}乙`];
    // 假 model 的行内容不含行尾，窗口腿拿到的分隔由 `getValueInRange` 决定；这里换一枚 CRLF 版
    const model = {
      getLanguageId: () => ERB_LANGUAGE_ID,
      getLineCount: () => crlf.length,
      getLineMaxColumn: (l: number) => crlf[l - 1]!.length + 1,
      getValue: () => crlf.join('\r\n'),
      getValueInRange: (r: Monaco.IRange) => crlf.slice(r.startLineNumber - 1, r.endLineNumber).join('\r\n'),
      getAlternativeVersionId: () => 1,
    } as unknown as Monaco.editor.ITextModel;
    const second = asEdits(
      range.provideDocumentRangeFormattingEdits(
        model,
        { startLineNumber: 2, endLineNumber: 2 } as unknown as Monaco.Range,
        {} as Monaco.languages.FormattingOptions,
        {} as Monaco.CancellationToken,
      ) as Monaco.languages.TextEdit[],
    );
    expect(second).toEqual(computeFormatEdits(crlf.join('\r\n'), 'erb').filter((e) => e.line === 2));
    expect(second).toHaveLength(1);
  });

  it('宿主没给窗口腿 ⇒ 老路逐字不变（既有调用方零改动）', () => {
    const { monaco, registered } = stubMonaco();
    installRangeFormatter(monaco, { resolve: (m) => wholeOnly(m) });
    const onType = registered.find((r) => r.kind === 'onType')!.provider;
    const doc = fakeModel([...DOC_LINES, '']);
    const out = onType.provideOnTypeFormattingEdits!(
      doc.model,
      { lineNumber: 3, column: 2 } as Monaco.Position,
      FW,
      {} as Monaco.languages.FormattingOptions,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.TextEdit[];
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('; 注释 文');
    expect(doc.getValueCalls()).toBe(1);
  });
});

/* ============================== ④ 行内提示：区间交回 + 版本记忆化 ============================== */

describe('inlayHintsFor · 重问不重扫', () => {
  it('同一篇没改过被反复问（Monaco 每次滚动都问）：供方只被问一次、整篇只 copy 一次', () => {
    const asks: { text: string; lineCount: number }[] = [];
    const hints = [{ line: 2, column: 8, label: 'ARG:1' }];
    const { kernel } = fakeKernel({ languageService: [languageServiceStub('inlayHint', { kind: 'inlayHint', hints }, asks)] });
    const doc = fakeModel(['@FOO', 'CALL F, 1']);
    const path = 'C:/erb/ps4-行内提示.ERB';
    expect(inlayHintsFor(doc.model, path, kernel)).toEqual(hints);
    expect(inlayHintsFor(doc.model, path, kernel)).toEqual(hints);
    expect(asks).toHaveLength(1);
    expect(doc.getValueCalls()).toBe(1);
    // 改一个字 ⇒ 必须重算（记忆化不许把旧提示钉在屏幕上）
    doc.bump();
    expect(inlayHintsFor(doc.model, path, kernel)).toEqual(hints);
    expect(asks).toHaveLength(2);
  });

  it('档外（≥ `LARGE_FILE_LINES`）：一次都不问供方、一次都不 copy', () => {
    const asks: { text: string; lineCount: number }[] = [];
    const { kernel } = fakeKernel({ languageService: [languageServiceStub('inlayHint', { kind: 'inlayHint', hints: [] }, asks)] });
    const doc = fakeModel(['@FOO', 'CALL F, 1'], { lineCount: LARGE_FILE_LINES });
    expect(inlayHintsFor(doc.model, 'C:/erb/ps4-行内提示档外.ERB', kernel)).toEqual([]);
    expect(asks).toHaveLength(0);
    expect(doc.getValueCalls()).toBe(0);
  });
});

describe('toMonacoInlayHints · 只交回 Monaco 点名的那一段', () => {
  const monaco = { languages: { InlayHintKind: { Parameter: 1, Type: 2, Other: 0 } } } as unknown as typeof Monaco;
  // 200 行：三条提示都**落在文档内**（越界那一档另测），这样筛掉的只可能是「区间外的」
  const model = {
    getLineCount: () => 200,
    getLineMaxColumn: (l: number) => 21,
  } as unknown as Monaco.editor.ITextModel;
  const hints = [
    { line: 2, column: 3, label: '甲:' },
    { line: 40, column: 3, label: '乙:' },
    { line: 100, column: 3, label: '丙:' },
  ];

  it('给了 range ⇒ 区间外的行一条不交（每次滚动不再为全篇每条提示挂装饰器）', () => {
    const out = toMonacoInlayHints(monaco, model, hints, { startLineNumber: 1, startColumn: 1, endLineNumber: 40, endColumn: 1 });
    expect(out.map((h) => h.position.lineNumber)).toEqual([2, 40]);
  });

  it('不给 range ⇒ 整篇照旧交回（老的直接调用方零改动）', () => {
    expect(toMonacoInlayHints(monaco, model, hints).map((h) => h.position.lineNumber)).toEqual([2, 40, 100]);
  });

  it('越界行仍然丢弃，区间参数不许把"文档里根本没有的行"放回来', () => {
    const out = toMonacoInlayHints(monaco, model, [...hints, { line: 201, column: 1, label: '丁:' }], {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 300,
      endColumn: 1,
    });
    expect(out.map((h) => h.position.lineNumber)).toEqual([2, 40, 100]);
  });
});

/* ============================== ④ 行上注解：版本记忆化 ============================== */

describe('codeLensesFor · 重问不重扫（档位与预算照旧）', () => {
  it('内容没变被反复问：供方只问一次；档位判在取文之前', () => {
    const asks: { text: string; lineCount: number }[] = [];
    const lenses = [{ line: 1, label: '被 3 处用到' }];
    const { kernel } = fakeKernel({ languageService: [languageServiceStub('codeLens', { kind: 'codeLens', lenses }, asks)] });
    // 8 行 / 1 条：过得了 `CODE_LENS_MAX_DENSITY` 那道密度档（预算判据由既有测试钉着）
    const doc = fakeModel(['@FOO', 'IF X', 'PRINT 1', 'PRINT 2', 'PRINT 3', 'ENDIF', 'PRINT 4', 'PRINT 5']);
    const path = 'C:/erb/ps4-注解记忆化.ERB';
    expect(codeLensesFor(doc.model, path, kernel)).toEqual(lenses);
    expect(codeLensesFor(doc.model, path, kernel)).toEqual(lenses);
    expect(asks).toHaveLength(1);
    expect(doc.getValueCalls()).toBe(1);
    // 档外：判在取文之前（`withinCodeLensBudget` 那条"整篇不给"的口径由既有测试钉着）
    const big = fakeModel(['@FOO'], { lineCount: LARGE_FILE_LINES });
    expect(codeLensesFor(big.model, path, kernel)).toEqual([]);
    expect(big.getValueCalls()).toBe(0);
    expect(asks).toHaveLength(1);
  });
});

/* ============================== ⑤ 选区读数：档外只报行数并说明 ============================== */

describe('selectionStatusText · 超大选区只报行数', () => {
  /** 逐行取文被叫了几次 = 这条链的单价（挂在每一次光标事件上） */
  function countingModel(lineContent: string): { model: SelModelLike; calls: () => number } {
    let calls = 0;
    return {
      model: {
        getLineContent: () => {
          calls += 1;
          return lineContent;
        },
      },
      calls: () => calls,
    };
  }

  const sel = (startLineNumber: number, endLineNumber: number): SelRangeLike =>
    ({ startLineNumber, startColumn: 1, endLineNumber, endColumn: 1 });
  const oneLine = (endColumn: number): SelRangeLike =>
    ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn });

  it('档线就是 `SELECTION_CHAR_COUNT_MAX_LINES`（不许出现第二个数字）', () => {
    expect(selectionCharCountAffordable(sel(1, SELECTION_CHAR_COUNT_MAX_LINES))).toBe(true);
    expect(selectionCharCountAffordable(sel(1, SELECTION_CHAR_COUNT_MAX_LINES + 1))).toBe(false);
  });

  it('档外：只报行数并把"没算字符"写在文案里，逐行取文一次都不叫', () => {
    const { model, calls } = countingModel('PRINTFORMW 台词');
    const text = selectionStatusText(model, sel(1, 52_601), { line: 52_601, column: 1 });
    expect(text).toBe('选中 52601行 · 未计字符');
    expect(calls()).toBe(0);
  });

  it('档内：文案与改前逐字相同（一行 / 多行 / 卡在档线那档三种形态）', () => {
    const { model } = countingModel('abc');
    expect(selectionStatusText(model, oneLine(4), { line: 1, column: 4 })).toBe('选中 3字符');
    expect(selectionStatusText(model, sel(1, 3), { line: 3, column: 1 })).toBe('选中 3行 × 6字符');
    // 末行只取到列 1 ⇒ 那一行不计字符：档线整档仍然照算（降级只在**跨过**档线时发生）
    expect(selectionStatusText(model, sel(1, SELECTION_CHAR_COUNT_MAX_LINES), { line: 2, column: 1 })).toBe(
      `选中 ${SELECTION_CHAR_COUNT_MAX_LINES}行 × ${(SELECTION_CHAR_COUNT_MAX_LINES - 1) * 3}字符`,
    );
    expect(selectionStatusText(model, sel(1, SELECTION_CHAR_COUNT_MAX_LINES + 1), { line: 2, column: 1 })).toBe(
      `选中 ${SELECTION_CHAR_COUNT_MAX_LINES + 1}行 · 未计字符`,
    );
  });

  it('空选区仍退回光标读数（档位不参与判断）', () => {
    const { model, calls } = countingModel('abc');
    expect(selectionStatusText(model, null, { line: 9, column: 2 })).toBe('9:2');
    expect(calls()).toBe(0);
  });
});
