/**
 * PS-4（2026-10-18 性能批）· 大文档 provider 缝的 before / after 读数。
 *
 * 尺子 = 真实语料之最那篇 **52,601 行 / 2.35 MB** 的 ERB（`docs/STATE.md` §二），
 * 这里用**合成文档**复刻同一体量（2.35 MB 量级、IF/ENDIF 成对、含注释行与全角空格行），
 * 因为要量的是「整篇 copy + 整篇扫一遍」这一族成本，它只跟行数与字节数有关。
 *
 * 钉的是四条腿各自的「改前那一刀」与「改后这一刀」：
 * - 折叠：改前 = 每次请求 `getValue()` + 整篇两遍扫描，
 *   改后 = 档位判在取文之前（`LARGE_FILE_LINES`），一次都不 copy；
 * - 💡 快速修复：改前 = 先 copy 整篇再问供方（零波浪线时供方必然答零条，白花），
 *   改后 = 零波浪线直接交回空表；
 * - 打字规范化：改前 = 一次击键把整篇算一遍再裁一行，改后 = 只取触发行那一行；
 * - 选区读数：改前 = 每次光标事件按选中行数逐行物化文本，改后 = 跨档只报行数。
 *
 * 断言口径（`docs/PITFALLS.md` §72）：**比值 + 宽松系数 + 绝对上界**，绝不钉死绝对毫秒。
 * 比值用中位数（min 是重尾统计量，一条腿抢到干净时间片另一条没抢到就翻线），
 * 系数取 5（真实差距在 100–1000 倍量级，余量三个数量级）；绝对上界取 20 ms——
 * 它比新腿实测（0.002–0.007 ms）高三个数量级，却仍能在"有人把整篇扫描改回来"时立刻红
 * （那一刀本机两轮实测中位 72–226 ms，满载更慢）。
 *
 * 供方这一侧叫的是 erb-parser **自己的纯函数**：折叠那一刀 = `parseErbText` + `scanControlFlow`
 * 两遍整篇扫描（供方本体 `plugins/erb-parser/src/plugin.ts:746` 就是这两遍，见下面
 * {@link foldingCost} 的理由），💡 那一刀 = `buildStructureFixes` 的整篇体检。
 * 不是自造的替身：这样"改前那一刀"的耗时就是插件真会付的那一刀。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { buildStructureFixes, parseErbText, scanControlFlow } from '@kojo/plugin-erb-parser';
import { computeFormatEdits } from '@kojo/plugin-kojo-sugar';
import type {
  EditorCodeActionContribution,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import type { Kernel } from '@kojo/kernel';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { installErbOnTypeFormatter } from '../src/monaco/kojo-format-range';
import { LARGE_FILE_LINES } from '../src/ui/editor-options';
import type { PaneCtx } from '../src/ui/editor-pane-registry';
import {
  SELECTION_CHAR_COUNT_MAX_LINES,
  selectionCharCount,
  selectionStatusText,
  type SelRangeLike,
} from '../src/ui/selection-status';

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

// 动态 import：接线层 import 期就会碰 monaco 运行时，桩得先就位
const seam = await import('../src/ui/editor-global-providers');
const { foldingRangesFor, provideCodeActionsFor } = seam;

/* ============================== 合成大文档 ============================== */

/** 语料之最的体量（行 / 字节），`docs/STATE.md` §二 */
const BIG_LINES = 52_601;
/** 选区读数那一档按 50,000 行量（题目口径），与上面的行数同量级、少一次取文的尾差 */
const SEL_LINES = 50_000;

/**
 * 一行的真实形态混合：控制流行（成对）、台词行（含全角空格）、注释行、`@` 函数头。
 * 折叠与结构体检的代价由"扫了多少行"决定，所以形态只要覆盖这几族就够了。
 */
function erbLineAt(i: number): string {
  const m = i % 9;
  if (m === 0) return 'IF C[10] > 0';
  if (m === 1) return 'PRINTFORMW 　台词「呀」 C[10]';
  if (m === 2) return 'ENDIF';
  if (m === 3) return ';　注释行：这一段不参与着色与折叠';
  if (m === 4) return 'CALL F, 1, 2';
  if (m === 5) return ' 　　';
  if (m === 6) return 'IF C[20] == 0';
  if (m === 7) return '  PRINTFORMW 分支';
  return 'ENDIF';
}

/** 造一份 N 行的文档（行数组 + 整篇文本）；末行补一个换行符贴近真实文件的 2.35 MB */
function makeDoc(lineCount: number): { lines: string[]; text: string } {
  const lines = Array.from({ length: lineCount }, (_, i) => erbLineAt(i));
  return { lines, text: `${lines.join('\n')}\n` };
}

/**
 * 假 model：`getValue()` 每次**真的重Join 一遍**（这就是"整篇 copy"那一刀，Monaco 侧
 * 同样要物化一份 JS 字符串）；`getValueInRange` 只切窗口；计数用来证明"一次都没叫"。
 */
function bigModel(lines: readonly string[], languageId = ERB_LANGUAGE_ID) {
  const state = { fullCopies: 0, windows: 0, lineReads: 0, versionId: 1 };
  const model = {
    getLanguageId: () => languageId,
    getLineCount: () => lines.length,
    getLineMaxColumn: (l: number) => (lines[l - 1] ?? '').length + 1,
    getLineContent: (l: number) => {
      state.lineReads += 1;
      return lines[l - 1] ?? '';
    },
    getValue: () => {
      state.fullCopies += 1;
      return lines.join('\n');
    },
    getValueInRange: (r: Monaco.IRange) => {
      state.windows += 1;
      return lines.slice(r.startLineNumber - 1, r.endLineNumber).join('\n');
    },
    getAlternativeVersionId: () => state.versionId,
    getVersionId: () => state.versionId,
  };
  return {
    model: model as unknown as Monaco.editor.ITextModel,
    stats: state,
  };
}

/**
 * 折叠供方的代价本体（`plugins/erb-parser/src/plugin.ts:746` → `folding.ts:116` 的
 * `erbFoldingRanges`）= 整篇 `parseErbText` + 整篇 `scanControlFlow` **两遍线性扫描**；
 * 其后的 `controlFlowFoldingRanges` 只是把两遍的结果配对（O(区间数)，不碰文本）。
 * `erbFoldingRanges` 是包私产（不在 `@kojo/plugin-erb-parser` 的出口上，宿主侧够不到），
 * 所以这里照供方那样"取整篇 → 扫两遍"——**扫的就是真会付的那两遍**。
 */
function foldingCost(text: string): number {
  return parseErbText(text).functions.length + scanControlFlow(text).length;
}

/** 真供方的替身**判据**、真供方的**代价**：直接叫 erb-parser 的纯函数 */
function realCostLanguageService(asks: { text: string }[]): EditorLanguageServiceContribution {
  return {
    id: 'ps4-perf-erb-folding',
    order: 10,
    provide: (request: EditorLanguageServiceRequest) => {
      if (request.kind !== 'foldingRange') return undefined;
      asks.push({ text: request.text });
      const functions = parseErbText(request.text).functions;
      const flow = scanControlFlow(request.text);
      // 区间配对按供方同族口径给个可数的结果（读数口径是那两遍扫描，见 `foldingCost`）
      return { kind: 'foldingRange', ranges: functions.map((fn) => ({ startLine: fn.startLine, endLine: fn.endLine })).slice(0, flow.length) };
    },
  } as unknown as EditorLanguageServiceContribution;
}

/** `provideActions` 的请求形状（从契约上取，不手抄字段） */
type CodeActionFile = Parameters<EditorCodeActionContribution['provideActions']>[0];

function realCostCodeAction(asks: { text: string }[]): EditorCodeActionContribution {
  return {
    id: 'ps4-perf-erb-structure-fix',
    order: 30,
    provideActions: (file: CodeActionFile) => {
      asks.push({ text: file.text });
      return buildStructureFixes(file.text, file.line, file.diagnostics).map((fix) => ({
        title: fix.title,
        kind: 'quickfix' as const,
        edits: fix.edits,
        run: () => undefined,
      }));
    },
  } as unknown as EditorCodeActionContribution;
}

function fakeKernel(languageService: readonly EditorLanguageServiceContribution[], codeAction: readonly EditorCodeActionContribution[]): Kernel {
  return {
    project: { current: () => null },
    slots: {
      query: (slot: string) => (slot === 'ui.editor.languageService' ? languageService : slot === 'ui.editor.codeAction' ? codeAction : []),
    },
    services: { tryGet: () => undefined },
    bus: { emit: () => undefined },
  } as unknown as Kernel;
}

function fakePane(path: string): PaneCtx {
  return {
    paneId: `ps4-perf-${path}`,
    filePathRef: { current: path },
    pendingActionsRef: { current: new Map<string, never>() },
    actionSeqRef: { current: 0 },
    editorRef: { current: null },
    sugarModelRef: { current: null },
    entriesRef: { current: new Map<string, never>() },
    crumbTreeCacheRef: { current: null },
  } as unknown as PaneCtx;
}

/* ============================== 读数工具（同 completion-perf 口径） ============================== */

/** 中位数（ms）；runs 次同一动作 */
function medianMs(runs: number, fn: () => unknown): number {
  const ds: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ds.push(performance.now() - t0);
  }
  ds.sort((a, b) => a - b);
  return ds[Math.floor(ds.length / 2)]!;
}

const ms = (v: number): string => `${v.toFixed(3)} ms`;

/** 宽松系数：真实差距在 100–1000 倍量级（`docs/PITFALLS.md` §72 要求跨窗比值留足余量） */
const SAFETY = 5;
/** 新腿的绝对上界（ms）：比实测高三个数量级，却仍能钉住"整篇扫描被改回来"（实测 30–140 ms） */
const NEW_LEG_CEILING_MS = 20;

/* ============================== ① 折叠 ============================== */

describe('PS-4 读数 · 折叠（52,601 行）', () => {
  const { lines } = makeDoc(BIG_LINES);
  const { model, stats } = bigModel(lines);
  const kernel = fakeKernel([realCostLanguageService([])], []);
  const path = 'C:/erb/ps4-perf-折叠.ERB';

  it('改前那一刀 = 整篇 copy + 两遍扫描；改后 = 档位判在取文之前，一次都不 copy', () => {
    const before = medianMs(9, () => foldingCost(model.getValue()));    // 改前那一刀自己就 copy 了 9 次，所以判据取**增量**：新腿跑完一次都不许多 copy
    const copiesBeforeNewLeg = stats.fullCopies;
    const after = medianMs(41, () => foldingRangesFor(model, path, kernel));
    console.info(`[PS-4 折叠] 52,601 行：改前中位 ${ms(before)}（整篇 copy ${copiesBeforeNewLeg} 次）→ 改后中位 ${ms(after)}（新腿 copy ${stats.fullCopies - copiesBeforeNewLeg} 次）`);
    expect(stats.fullCopies).toBe(copiesBeforeNewLeg);
    expect(after).toBeLessThan(Math.max(NEW_LEG_CEILING_MS, before / SAFETY));
    expect(before).toBeGreaterThan(after * SAFETY);
  });

  it('档内那一档（4,999 行）：内容没变被反复问 ⇒ 第二次只付缓存的代价', () => {
    const small = makeDoc(LARGE_FILE_LINES - 1);
    const { model: doc, stats: docStats } = bigModel(small.lines);
    const asks: { text: string }[] = [];
    const kernel2 = fakeKernel([realCostLanguageService(asks)], []);
    const cold = medianMs(1, () => foldingRangesFor(doc, 'C:/erb/ps4-perf-档内.ERB', kernel2));
    const warm = medianMs(41, () => foldingRangesFor(doc, 'C:/erb/ps4-perf-档内.ERB', kernel2));
    console.info(`[PS-4 折叠] ${LARGE_FILE_LINES - 1} 行：首次（含整篇解析）${ms(cold)} → 稳态命中 ${ms(warm)}（供方被问 ${asks.length} 次、整篇 copy ${docStats.fullCopies} 次）`);
    expect(asks).toHaveLength(1);
    expect(docStats.fullCopies).toBe(1);
    expect(warm).toBeLessThan(Math.max(NEW_LEG_CEILING_MS, cold / SAFETY));
  });
});

/* ============================== ② 💡 零波浪线那道闸 ============================== */

describe('PS-4 读数 · 快速修复（52,601 行，零波浪线）', () => {
  const { lines } = makeDoc(BIG_LINES);
  const { model, stats } = bigModel(lines);
  const path = 'C:/erb/ps4-perf-快速修复.ERB';

  it('改前 = 先 copy 整篇再做结构体检；改后 = 零波浪线直接交回空表（结果都是零条动作）', () => {
    const asks: { text: string }[] = [];
    const kernel = fakeKernel([], [realCostCodeAction(asks)]);
    const ctx = fakePane(path);
    const range = { startLineNumber: 40_000, startColumn: 1, endLineNumber: 40_000, endColumn: 1 } as unknown as Monaco.Range;
    const emptyContext = { markers: [], only: undefined, trigger: 1 } as unknown as Monaco.languages.CodeActionContext;
    // 改前那一刀：接线层无条件 `getValue()` + 供方 `buildStructureFixes`（整篇 split + 体检）
    const before = medianMs(9, () => buildStructureFixes(model.getValue(), 40_000, []));
    // 不减能力：改前那一刀本来也产不出动作（零诊断 ⇒ 供方按 `code` + 行精确匹配必然空表），
    // 所以那 200+ ms 是纯白付的；改后交回的空表与它逐字同结果。
    // 这一条取证放在增量基线**之前**：它自己也要 copy 一次整篇。
    expect(buildStructureFixes(model.getValue(), 40_000, [])).toEqual([]);
    const copiesBeforeNewLeg = stats.fullCopies;
    const asksBeforeNewLeg = asks.length;
    const after = medianMs(41, () => provideCodeActionsFor(model, range, emptyContext, ctx, kernel));
    console.info(`[PS-4 快速修复] 52,601 行零波浪线：改前中位 ${ms(before)}（整篇 copy ${copiesBeforeNewLeg} 次）→ 改后中位 ${ms(after)}（新腿 copy ${stats.fullCopies - copiesBeforeNewLeg} 次、问供方 ${asks.length - asksBeforeNewLeg} 次）`);
    expect(provideCodeActionsFor(model, range, emptyContext, ctx, kernel).actions).toEqual([]);
    expect(asks).toHaveLength(asksBeforeNewLeg);
    expect(stats.fullCopies).toBe(copiesBeforeNewLeg);
    expect(after).toBeLessThan(Math.max(NEW_LEG_CEILING_MS, before / SAFETY));
    expect(before).toBeGreaterThan(after * SAFETY);
  });
});

/* ============================== ③ 打字规范化：一次击键 ============================== */

describe('PS-4 读数 · on-type 格式化（52,601 行，一次击键）', () => {
  const { lines, text } = makeDoc(BIG_LINES);
  const { model, stats } = bigModel(lines);

  function install(): Monaco.languages.OnTypeFormattingEditProvider {
    let provider: Monaco.languages.OnTypeFormattingEditProvider | null = null;
    const monaco = {
      languages: {
        registerDocumentRangeFormattingEditProvider: () => ({ dispose: () => undefined }),
        registerOnTypeFormattingEditProvider: (_id: string, p: Monaco.languages.OnTypeFormattingEditProvider) => {
          provider = p;
          return { dispose: () => undefined };
        },
      },
    } as unknown as typeof Monaco;
    // 与生产接线同款的两条腿：`resolve` = 整篇，`resolveRange` = 只给触发行那一行
    installErbOnTypeFormatter(monaco, {
      resolve: (m) => ({ text: m.getValue(), dialect: 'erb' }),
      resolveRange: (m, start, end) => ({
        text: m.getValueInRange({ startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: m.getLineMaxColumn(end) }),
        dialect: 'erb',
      }),
    });
    if (!provider) throw new Error('on-type 供方没注册上');
    return provider;
  }

  it('同一击键：改前整篇算一遍再裁一行，改后只取那一行；产出的编辑逐字节相同', () => {
    const onType = install();
    // 触发行取**文档后段**第一条会被规则改写的行（深在文档里才像真打字现场）
    let triggerLine = 0;
    for (let i = 30_000; i < lines.length; i++) {
      if (computeFormatEdits(lines[i]!, 'erb').length > 0) {
        triggerLine = i + 1;
        break;
      }
    }
    expect(triggerLine).toBeGreaterThan(30_000);
    const position = { lineNumber: triggerLine, column: 2 } as Monaco.Position;
    const runNew = () =>
      onType.provideOnTypeFormattingEdits(
        model,
        position,
        ';',
        {} as Monaco.languages.FormattingOptions,
        {} as Monaco.CancellationToken,
      ) as readonly Monaco.languages.TextEdit[];
    const wholeEdits = computeFormatEdits(text, 'erb');
    // 改前那一刀 = 整篇 `computeFormatEdits` 再裁这一行（老 `provideOnTypeFormattingEdits` 逐字如此）
    const before = medianMs(9, () => computeFormatEdits(model.getValue(), 'erb').filter((e) => e.line === triggerLine));
    const copiesBeforeNewLeg = stats.fullCopies;
    const windowsBeforeNewLeg = stats.windows;
    const AFTER_RUNS = 41;
    const after = medianMs(AFTER_RUNS, runNew);
    console.info(
      `[PS-4 打字规范化] 52,601 行一次击键（第 ${triggerLine} 行）：改前中位 ${ms(before)}（整篇 copy ${copiesBeforeNewLeg} 次）→ 改后中位 ${ms(after)}（新腿 copy ${stats.fullCopies - copiesBeforeNewLeg} 次、窗口取文 ${stats.windows - windowsBeforeNewLeg} 次、整篇编辑 ${wholeEdits.length} 条）`,
    );
    expect(stats.fullCopies).toBe(copiesBeforeNewLeg);
    // **一次击键 = 窗口取文 1 次**（只有触发行；前缀行直读 `model.getLineContent`，不再取 2.35 MB
    // 前缀串）。量的是"取文次数"这条观测断言：改前这里每次击键是 2 次窗口取文。
    expect(stats.windows - windowsBeforeNewLeg).toBe(AFTER_RUNS);
    // 逐字节等价：新路给出的编辑 = 老路裁到这一行的编辑（行号 / 列 / 文本三样都对得上）
    expect(runNew().map((e) => `${e.range.startLineNumber}:${e.range.startColumn}:${e.range.endColumn}:${e.text}`)).toEqual(
      wholeEdits
        .filter((e) => e.line === triggerLine)
        .map((e) => `${e.line}:${e.startColumn}:${e.endColumn}:${e.text}`),
    );
    expect(after).toBeLessThan(Math.max(NEW_LEG_CEILING_MS, before / SAFETY));
    expect(before).toBeGreaterThan(after * SAFETY);
  });
});

/* ============================== ④ 选区读数（50,000 行） ============================== */

describe('PS-4 读数 · 状态栏选区（50,000 行选区，每次光标事件）', () => {
  const { lines } = makeDoc(SEL_LINES);
  const { model, stats } = bigModel(lines);
  const selOf = (endLineNumber: number): SelRangeLike =>
    ({ startLineNumber: 1, startColumn: 1, endLineNumber, endColumn: 1 });
  const asSelModel = model as unknown as Parameters<typeof selectionCharCount>[0];

  it('档线那两档的实测单价：2,000 行仍是一次光标事件的量级，50,000 行已是全篇扫描', () => {
    const atThreshold = medianMs(41, () => selectionCharCount(asSelModel, selOf(SELECTION_CHAR_COUNT_MAX_LINES)));
    const at50k = medianMs(9, () => selectionCharCount(asSelModel, selOf(SEL_LINES)));
    const degraded = medianMs(41, () => selectionStatusText(asSelModel, selOf(SEL_LINES), { line: SEL_LINES, column: 1 }));
    console.info(
      `[PS-4 选区读数] ${SELECTION_CHAR_COUNT_MAX_LINES} 行逐行计数中位 ${ms(atThreshold)} / ${SEL_LINES} 行中位 ${ms(at50k)} → 跨档只报行数 ${ms(degraded)}（整行取文 ${stats.lineReads} 次）`,
    );
    // 档位定在 2,000 行的判据：那一档的单价与一次光标事件本来的重排量级同一档（< 5 ms）
    expect(atThreshold).toBeLessThan(5);
    // 跨档 ⇒ 一次都不逐行取文，且文案把"没算字符"说出来（铁律 4：降级不许静默）
    expect(selectionStatusText(asSelModel, selOf(SEL_LINES), { line: SEL_LINES, column: 1 })).toBe(`选中 ${SEL_LINES}行 · 未计字符`);
    const lineReadsBefore = stats.lineReads;
    selectionStatusText(asSelModel, selOf(SEL_LINES), { line: SEL_LINES, column: 1 });
    expect(stats.lineReads).toBe(lineReadsBefore);
    expect(degraded).toBeLessThan(Math.max(NEW_LEG_CEILING_MS, at50k / SAFETY));
  });
});
