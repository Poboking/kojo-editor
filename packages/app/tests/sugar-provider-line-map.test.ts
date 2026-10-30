/**
 * 升糖预览面上的**只读**语言动作：位点先换算到原文、结果再折回预览行
 * （`ui/editor-global-providers.ts` 的 `read*` 一族腿 + 那两条写类闸）。
 *
 * 分界线只有一条：**这个动作最终会不会写盘**。
 * - 会写盘的（格式化窗口腿 / 💡 落地）在糖面上继续一律否决——糖是派生物，改一个字节都是事故；
 * - 只读的（定义 / 大纲 / 签名 / 折叠 / 注解 / 行内提示 / 光标符号上报）照旧应答，
 *   只是问的是**原文**（契约写的是"真文件的文本"，供方按 `text` 的行号取光标行，
 *   拿投影文本配源行号问的就是隔壁一行），交回的行号再按 `sugarLineMapRef` 折回预览面。
 *
 * 四条判据各自有钉：
 * ① **往返相等**：预览行 → 源行 → 折回预览行必须逐行回到出发那一行；
 * ② **折不回 = 不给**：映射缺席（空表）/ 那一行没有源行 / 结果落在折不回的行上 ⇒ 不给那一条，
 *    绝不给一个猜的行号（"不许把作者导到不存在的位置"）；
 * ③ **列不折算**：预览行与源行的行内列不对应（连文本都不是同一串），跨面一律落到行首；
 * ④ **不折两遍**：落点（定义目标、注解 `target`）留在**源坐标**——换算那一跳住在 `applyReveal`。
 *
 * 面与映射都由 `composeSugarDoc` 真拼出来（不是手抄表）：绕开拼装箱就是绕开"文本与映射同批产出"
 * 这条前提，而整条换算都骑在它上面。
 *
 * monaco 运行时不进 node（本池 environment = node），照 `ps4-provider-seams.test.ts` 桩掉 entry。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type {
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  KojoCallProtocol,
  KojoCallSlot,
} from '@kojo/plugin-api';
import type { Kernel } from '@kojo/kernel';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { resolveSignatureInText } from '../src/monaco/kojo-signature';
import { composeSugarDoc, sourceLineToSugar, type SugarSegmentInput } from '../src/ui/sugar-view';
import { livePanes, setGlobalKernel, type PaneCtx } from '../src/ui/editor-pane-registry';
import { readJumpProbe, setJumpProbe } from '../src/ui/jump-to-state';
import { pushPreview, resetQuickFixPreviews } from '../src/ui/quick-fix-preview';

const stub = vi.hoisted(() => {
  const invoke = (path: string): unknown => {
    if (path === 'monaco.Range') return function Range(...args: number[]) { return args; };
    // B4：组合根挂载会问"哪些语言已认领"（语言面只落给认领过的语言）——替身答空表。
    if (path === 'monaco.languages.getLanguages') return [];
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

const seam = await import('../src/ui/editor-global-providers');
const {
  readDefinitionTargets,
  readReferences,
  readDocumentSymbols,
  readFoldingRanges,
  readCodeLenses,
  readInlayHints,
  readSignatureHelp,
  signatureHelpAt,
  formatRequestWindowFor,
  applyQuickFixEdits,
  previewSourcePathOf,
  ensureGlobalProviders,
  disposeGlobalProviders,
} = seam;

/* ============================== 夹具 ============================== */

interface FakeDoc {
  readonly model: Monaco.editor.ITextModel;
  readonly lines: readonly string[];
  readonly getValueCalls: () => number;
}

function fakeDoc(lines: readonly string[], languageId = ERB_LANGUAGE_ID): FakeDoc {
  const state = { fullCopies: 0 };
  const model = {
    getLanguageId: () => languageId,
    getLineCount: () => lines.length,
    getLineMaxColumn: (l: number) => (lines[l - 1] ?? '').length + 1,
    getLineContent: (l: number) => lines[l - 1] ?? '',
    getValue: () => {
      state.fullCopies += 1;
      return lines.join('\n');
    },
    getValueInRange: (range: Monaco.IRange) =>
      lines.slice(range.startLineNumber - 1, range.endLineNumber).join('\n'),
    getAlternativeVersionId: () => 1,
    getVersionId: () => 1,
  };
  return { model: model as unknown as Monaco.editor.ITextModel, lines, getValueCalls: () => state.fullCopies };
}

/** 一面糖投影：原文 model + `composeSugarDoc` 真拼出来的预览 model 与行映射 */
interface Surface {
  readonly source: FakeDoc;
  readonly preview: FakeDoc;
  readonly lineMap: readonly number[];
  readonly path: string;
  /** 投影 model 的 URI 路径（`EditorPane` 挂的是 `inmemory://sugar/<组>/<编码路径>`） */
  readonly projectionUri: string;
}

function makeSurface(path: string, sourceLines: readonly string[], segments: readonly SugarSegmentInput[]): Surface {
  const composed = composeSugarDoc([...sourceLines], segments);
  const preview = fakeDoc(composed.text.split('\n'), KOJO_LANGUAGE_ID);
  // 真壳里那份投影是内存 model，URI 不是文件；本地腿（`#DIM` / `$`）会把这份 URI 当路径交回来，
  // 所以夹具也得带上它，剔除幻影落点那一条才测得到东西
  const projectionUri = `/sugar/pane-1/${encodeURIComponent(path)}`;
  (preview.model as unknown as { uri: { fsPath: string; path: string } }).uri = {
    fsPath: projectionUri,
    path: projectionUri,
  };
  return {
    path,
    projectionUri,
    source: fakeDoc(sourceLines),
    preview,
    lineMap: composed.lineMap,
  };
}

/**
 * 挂上投影的 pane 档案。`entriesRef` 里必须有原文 model —— 读类腿取的文本与行数都从那份来；
 * 没有它就没有原文可依，退化成"不给结果"（那条退化本身也钉在这里）。
 */
function mount(surface: Surface, cursorLine = 1, lineMap?: readonly number[]): PaneCtx {
  const entries = new Map<string, { model: Monaco.editor.ITextModel }>();
  entries.set(surface.path, { model: surface.source.model });
  const editor = {
    getModel: () => surface.preview.model,
    getPosition: () => ({ lineNumber: cursorLine, column: 1 }),
  };
  const pane = {
    paneId: `sugar-${surface.path}`,
    filePathRef: { current: surface.path },
    pendingActionsRef: { current: new Map<string, never>() },
    actionSeqRef: { current: 0 },
    editorRef: { current: editor as unknown as Monaco.editor.IStandaloneCodeEditor },
    sugarModelRef: { current: surface.preview.model },
    sugarLineMapRef: { current: lineMap ?? surface.lineMap },
    entriesRef: { current: entries as never },
    crumbTreeCacheRef: { current: null },
  } as unknown as PaneCtx;
  livePanes.set(pane.paneId, pane);
  return pane;
}

function mountPlain(surface: Surface): PaneCtx {
  const editor = { getModel: () => surface.source.model, getPosition: () => ({ lineNumber: 1, column: 1 }) };
  const pane = {
    paneId: `plain-${surface.path}`,
    filePathRef: { current: surface.path },
    pendingActionsRef: { current: new Map<string, never>() },
    actionSeqRef: { current: 0 },
    editorRef: { current: editor as unknown as Monaco.editor.IStandaloneCodeEditor },
    sugarModelRef: { current: null },
    sugarLineMapRef: { current: [] },
    entriesRef: { current: new Map<string, never>() },
    crumbTreeCacheRef: { current: null },
  } as unknown as PaneCtx;
  livePanes.set(pane.paneId, pane);
  return pane;
}

const SLOTS: readonly KojoCallSlot[] = [
  { index: 3, kind: 'int', label: '事件子参数' },
  { index: 4, kind: 'int', label: '日期偏移' },
];
/** 只认 `F`：其余名字一律"协议不认识 ⇒ 不应答"（与 B5 的口径同源） */
const protocolStub: KojoCallProtocol = { slotsFor: (name) => (name === 'F' ? SLOTS : null) };

function fakeKernel(contributions: readonly EditorLanguageServiceContribution[]): Kernel {
  return {
    // `adapterId` 与 adapter 的 `gameId` 对上：`callProtocol` 只在**匹配到 adapter** 那一路给出
    // （静态三张表才是无项目也照给的那一支），签名那条腿没它就整条零产出
    project: { current: () => ({ adapterId: 'eraTW' }) },
    slots: {
      query: (slot: string) =>
        slot === 'ui.editor.languageService'
          ? contributions
          : slot === 'game.adapter'
            ? [{ id: 'sugar-adapter', adapter: { gameId: 'eraTW', kojoCallProtocol: protocolStub } }]
            : [],
    },
    services: { tryGet: () => undefined },
    bus: { emit: () => undefined },
    io: { isWritable: () => false, readText: () => '', writeText: () => undefined },
  } as unknown as Kernel;
}

/** 记账型贡献方：`kind` 那一路由 `answer` 现场作答，并把**它收到的请求**照抄进 `asks` */
function serviceStub(
  kind: EditorLanguageServiceRequest['kind'],
  answer: (request: EditorLanguageServiceRequest) => unknown,
  asks: EditorLanguageServiceRequest[],
): EditorLanguageServiceContribution {
  return {
    id: `sugar-${kind}`,
    order: 10,
    provide: (request: EditorLanguageServiceRequest) => {
      if (request.kind !== kind) return undefined;
      asks.push(request);
      return answer(request) as never;
    },
  } as unknown as EditorLanguageServiceContribution;
}

const position = (lineNumber: number, column = 1): Monaco.Position =>
  ({ lineNumber, column }) as unknown as Monaco.Position;

/** 请求里的 `line`（只有带位点的那几员有；本文件只问 definition） */
const askedLineOf = (request: EditorLanguageServiceRequest): number =>
  (request as unknown as { line: number }).line;

/** 请求里的 `path` / `text`（联合里不是每一员都有这两格；本文件只问带这两格的那几员） */
const pathOf = (request: EditorLanguageServiceRequest): string =>
  (request as unknown as { path: string }).path;
const textOf = (request: EditorLanguageServiceRequest): string =>
  (request as unknown as { text: string }).text;

/** 源侧自定义：把"问的那一源行"原样当定义位交回（往返钉就骑在这一位上） */
const selfDefinitionLocations = (request: EditorLanguageServiceRequest) => {
  const line = askedLineOf(request);
  return [{ filePath: pathOf(request), line, column: 7, span: { columnStart: 7, columnEnd: 12 } }];
};
const selfDefinition = (request: EditorLanguageServiceRequest) => ({
  kind: 'definition',
  locations: selfDefinitionLocations(request),
});

/** 供方收到的那份文本（= **原文**）的行号清单：整篇类腿按每行给一条结果，折回判据才好钉 */
const sourceLineNumbers = (request: EditorLanguageServiceRequest): number[] => {
  const lineCount = (request as unknown as { lineCount?: number }).lineCount ?? textOf(request).split('\n').length;
  return Array.from({ length: lineCount }, (_, i) => i + 1);
};

const symbolPerLine = (request: EditorLanguageServiceRequest) => ({
  kind: 'documentSymbol',
  symbols: sourceLineNumbers(request).map((line) => ({
    name: `第 ${line} 行`,
    kind: 'declaration' as const,
    startLine: line,
    endLine: line,
  })),
});

/** 引用腿的自证答复：把**原文每一源行**都当引用点交回（带列与区间，折回后才能看穿"折几遍"） */
const referencesPerSourceLine = (request: EditorLanguageServiceRequest) => ({
  kind: 'references',
  locations: sourceLineNumbers(request).map((line) => ({
    filePath: pathOf(request),
    line,
    column: 9,
    span: { columnStart: 9, columnEnd: 14 },
  })),
});

/* 面 A：源 12 行，其中第 2..4 行压成 4 行糖（**最后一行没有源**）⇒ 预览 13 行、映射不是恒等 */
const A_PATH = 'C:/game/面甲.ERB';
const A_SOURCE = [
  '@调用口上',
  'IF A',
  'PRINTFORMW 她点头',
  'ENDIF',
  ';注释',
  'CALL BAR',
  'X = 1',
  'IF B',
  'ENDIF',
  'PRINT 2',
  'CALL BAZ',
  'RETURN',
];
const A_SEGMENTS: readonly SugarSegmentInput[] = [
  { fromLine: 2, toLine: 4, sugarText: '如果 A：\n  她点头。\n结束：\n（收束）', sourceLines: [2, 3, 4, 0] },
];
/** 源行 → 面 A 的预览行（折回后的期望序列；1 基，越界走表尾退化） */
const FOLD_A = (sourceLine: number): number | null => sourceLineToSugar([1, 2, 3, 4, 0, 5, 6, 7, 8, 9, 10, 11, 12], sourceLine);

/* 面 B：段首两行糖**都没有源行** ⇒ 源第 1、2 行折不回任何预览行（②号判据的落点） */
const B_PATH = 'C:/game/面乙.ERB';
const B_SOURCE = ['@头', 'IF A', 'PRINT X', 'ENDIF', 'CALL B', 'RETURN'];
const B_SEGMENTS: readonly SugarSegmentInput[] = [
  { fromLine: 1, toLine: 2, sugarText: '（引子）', sourceLines: [0] },
];

afterEach(() => {
  livePanes.clear();
  setJumpProbe(null);
  disposeGlobalProviders();
  resetQuickFixPreviews();
});

describe('糖面读类腿 · ①往返钉（预览行 → 源行 → 折回预览行）', () => {
  it('大纲：源侧整篇结果折回后**逐行回到出发那一行**（无源行的那格预览上没有符号）', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mount(surface);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([serviceStub('documentSymbol', symbolPerLine, asks)]);
    const folded = readDocumentSymbols(surface.preview.model, kernel);
    expect(folded.map((s) => s.startLine)).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13]);
    for (const symbol of folded) {
      const sourceLine = Number(/第 (\d+) 行/.exec(symbol.name)![1]);
      expect(symbol.startLine, `源第 ${sourceLine} 行`).toBe(FOLD_A(sourceLine));
      expect(symbol.endLine).toBe(symbol.startLine);
    }
    // 反方向也闭合：每个"带源行的预览行"上都坐着它自己那一条结果（预览第 5 行没有源 ⇒ 那一格空）
    const byPreview = new Map(folded.map((s) => [s.startLine, s]));
    for (let previewLine = 1; previewLine <= surface.lineMap.length; previewLine++) {
      const sourceLine = surface.lineMap[previewLine - 1]!;
      const landed = byPreview.get(previewLine);
      if (sourceLine === 0) {
        // 那一格是段尾收束装饰；源第 5 行折回时也停在它身上（退化口径），所以只判"装饰格上不许有源 0 的符号"
        expect(landed === undefined || /第 \d+ 行/.test(landed!.name)).toBe(true);
        continue;
      }
      expect(landed, `预览第 ${previewLine} 行`).toBeDefined();
      expect(Number(/第 (\d+) 行/.exec(landed!.name)![1])).toBe(sourceLine);
    }
  });

  it('定义：预览行 → 源行交出去，落点与列都按供方原样（判据已进插件，宿主不再改列）', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mount(surface);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([serviceStub('definition', (request) => selfDefinition(request), asks)]);
    for (const previewLine of [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13]) {
      const sourceLine = surface.lineMap[previewLine - 1]!;
      const at = readDefinitionTargets(surface.preview.model, position(previewLine, 9), kernel);
      expect(asks.at(-1)!.kind).toBe('definition');
      expect(askedLineOf(asks.at(-1)!)).toBe(sourceLine);
      // LAU-4 定义腿之后请求带**换算后的源列**（插件按列取名字记号；宿主的"一律收到行首"
      // 随本地腿一起退役）：期望值按同一口径（行尾对齐：源行比预览行多出的宽度 + 光标列，
      // 夹在 `[1, 源行长度 + 1]`）现算，不手抄公式。
      const row = A_SOURCE[sourceLine - 1]!;
      const shown = surface.preview.model.getLineContent(previewLine);
      const expectedColumn = Math.min(Math.max(row.length - shown.length + 9, 1), row.length + 1);
      expect((asks.at(-1) as unknown as { column: number }).column).toBe(expectedColumn);
      // 落点仍在存档侧、列收到行首（`foldLocationsToPreview` 的跨面纪律未变）
      expect(at).toHaveLength(1);
      expect(at[0]!.line).toBe(sourceLine);
      expect(FOLD_A(sourceLine)).toBe(previewLine);
      expect(at[0]!.column).toBe(1);
      expect(at[0]!.span).toBeUndefined();
    }
  });

  it('供方拿到的是**原文**那份文本与原文行数，投影一次都没被 copy', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mount(surface);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([
      serviceStub('documentSymbol', symbolPerLine, asks),
      serviceStub('foldingRange', (request) => ({
        kind: 'foldingRange',
        ranges: sourceLineNumbers(request).map((line) => ({ startLine: line, endLine: line + 1 })),
      }), asks),
    ]);
    readDocumentSymbols(surface.preview.model, kernel);
    readFoldingRanges(surface.preview.model, kernel);
    expect(asks).toHaveLength(2);
    for (const ask of asks) {
      expect(textOf(ask)).toBe(A_SOURCE.join('\n'));
      expect(pathOf(ask)).toBe(A_PATH);
      expect(ask).toMatchObject({ lineCount: A_SOURCE.length });
    }
    expect(surface.preview.getValueCalls()).toBe(0);
  });

  it('折叠 / 行内提示：交回预览面后与大纲落在同一批预览行上', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mount(surface);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([
      serviceStub('foldingRange', (request) => ({
        kind: 'foldingRange',
        ranges: sourceLineNumbers(request).map((line) => ({ startLine: line, endLine: line })),
      }), asks),
      serviceStub('inlayHint', (request) => ({
        kind: 'inlayHint',
        hints: sourceLineNumbers(request).map((line) => ({ line, column: 14, label: `槽 ${line}` })),
      }), asks),
    ]);
    const expected = [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13];
    expect(readFoldingRanges(surface.preview.model, kernel).map((r) => r.startLine)).toEqual(expected);
    expect(readInlayHints(surface.preview.model, kernel).map((h) => h.line)).toEqual(expected);
  });
});

describe('糖面读类腿 · ②折不回就不给', () => {
  it('映射缺席（空表）⇒ 六条腿一律空结果，一次都不问供方、一次都不 copy', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mount(surface, 1, []);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([
      serviceStub('definition', (request) => selfDefinition(request), asks),
      serviceStub('documentSymbol', symbolPerLine, asks),
      serviceStub('foldingRange', () => ({ kind: 'foldingRange', ranges: [] }), asks),
      serviceStub('codeLens', () => ({ kind: 'codeLens', lenses: [] }), asks),
      serviceStub('inlayHint', () => ({ kind: 'inlayHint', hints: [] }), asks),
    ]);
    expect(readDefinitionTargets(surface.preview.model, position(2), kernel)).toEqual([]);
    expect(readDocumentSymbols(surface.preview.model, kernel)).toEqual([]);
    expect(readFoldingRanges(surface.preview.model, kernel)).toEqual([]);
    expect(readCodeLenses(surface.preview.model, kernel)).toEqual([]);
    expect(readInlayHints(surface.preview.model, kernel)).toEqual([]);
    expect(readSignatureHelp(surface.preview.model, position(2), kernel)).toBeNull();
    expect(asks).toHaveLength(0);
    expect(surface.source.getValueCalls()).toBe(0);
  });

  it('原文 model 不在标签表里（没有可问的文本）⇒ 同样空结果，不拿投影文本凑', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    const pane = mount(surface);
    pane.entriesRef.current.clear();
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([serviceStub('documentSymbol', symbolPerLine, asks)]);
    expect(readDocumentSymbols(surface.preview.model, kernel)).toEqual([]);
    expect(asks).toHaveLength(0);
  });

  it('这一行压根没有源行 ⇒ 位点类腿空结果（不猜一个"最像"的源位点）', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mount(surface);
    expect(surface.lineMap[4]).toBe(0);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([serviceStub('definition', (request) => selfDefinition(request), asks)]);
    expect(readDefinitionTargets(surface.preview.model, position(5, 3), kernel)).toEqual([]);
    expect(asks).toHaveLength(0);
  });

  it('段首糖行没有源 ⇒ 源前两行的结果整条丢弃（大纲 / 折叠 / 注解 / 提示四条都认这一位）', () => {
    const surface = makeSurface(B_PATH, B_SOURCE, B_SEGMENTS);
    mount(surface);
    expect(sourceLineToSugar(surface.lineMap, 1)).toBeNull();
    expect(sourceLineToSugar(surface.lineMap, 2)).toBeNull();
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([
      serviceStub('documentSymbol', symbolPerLine, asks),
      serviceStub('foldingRange', (request) => ({
        kind: 'foldingRange',
        ranges: sourceLineNumbers(request).map((line) => ({ startLine: line, endLine: line })),
      }), asks),
      serviceStub('codeLens', () => ({ kind: 'codeLens', lenses: [{ line: 1, label: '被 1 处用到' }] }), asks),
      serviceStub('inlayHint', () => ({
        kind: 'inlayHint',
        hints: [
          { line: 1, column: 9, label: '甲' },
          { line: 5, column: 4, label: '乙' },
        ],
      }), asks),
    ]);
    expect(readDocumentSymbols(surface.preview.model, kernel).map((s) => s.startLine)).toEqual([2, 3, 4, 5]);
    expect(readFoldingRanges(surface.preview.model, kernel).map((r) => r.startLine)).toEqual([2, 3, 4, 5]);
    expect(readCodeLenses(surface.preview.model, kernel)).toEqual([]);
    expect(readInlayHints(surface.preview.model, kernel).map((h) => h.line)).toEqual([4]);
  });

  it('跨文件的定义落点原样交回（那是另一份文件，与这一面的映射无关）', () => {
    const surface = makeSurface(B_PATH, B_SOURCE, B_SEGMENTS);
    mount(surface);
    const kernel = fakeKernel([
      serviceStub('definition', (request) => ({
        kind: 'definition',
        locations: [
          ...selfDefinitionLocations(request),
          { filePath: 'C:/game/别处.ERB', line: 1, column: 5, span: { columnStart: 5, columnEnd: 9 } },
        ],
      }), []),
    ]);
    const at = readDefinitionTargets(surface.preview.model, position(2), kernel);
    const other = at.find((l) => l.filePath === 'C:/game/别处.ERB');
    expect(other).toMatchObject({ line: 1, column: 5 });
    expect(other!.span).toEqual({ columnStart: 5, columnEnd: 9 });
    expect(at.find((l) => l.filePath === B_PATH)).toMatchObject({ line: 3, column: 1 });
  });

  it('指向投影自身 URI 的落点被剔除（幻影不许把真算出来的源落点挤掉）', () => {
    // `#DIM` / `$` 标签那两条**缓冲区本地腿**读的是屏幕上这份 model，交回的 `filePath` 就是那份
    // `inmemory://sugar/…` 的 URI 路径——上面没有文件，而 `mergeSymbolLocations` 把它们排在最前、
    // `planDefinitionJump` 的事件通道兜底只取第一枚 ⇒ 不剔就是"按了没反应"顶替了一次正确的跳转。
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mount(surface);
    const kernel = fakeKernel([
      serviceStub('definition', (request) => ({
        kind: 'definition',
        locations: [
          { filePath: surface.projectionUri, line: 2, column: 6 },
          ...selfDefinitionLocations(request),
        ],
      }), []),
    ]);
    const at = readDefinitionTargets(surface.preview.model, position(3), kernel);
    expect(at).toHaveLength(1);
    expect(at[0]).toMatchObject({ filePath: A_PATH, line: 3, column: 1 });
  });
});

describe('糖面读类腿 · ③列与④落点', () => {
  it('行内提示的源列一律收到行首；同一预览行上的同一句话并成一条', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mount(surface);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([
      serviceStub('inlayHint', (request) => ({
        kind: 'inlayHint',
        hints: sourceLineNumbers(request).flatMap((line) => [
          { line, column: 14, label: '槽' },
          { line, column: 20, label: '槽' },
        ]),
      }), asks),
    ]);
    const hints = readInlayHints(surface.preview.model, kernel);
    expect(hints.map((h) => h.line)).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(hints.every((h) => h.column === 1)).toBe(true);
  });

  it('注解的 `target` 留在**源坐标**：点击走 `editor.revealLocation`，那条腿已经换算过一次', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mount(surface);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([
      serviceStub('codeLens', () => ({
        kind: 'codeLens',
        lenses: [
          {
            line: 3,
            label: '被 3 处用到',
            target: { filePath: A_PATH, line: 3, column: 6, span: { columnStart: 6, columnEnd: 9 } },
          },
        ],
      }), asks),
    ]);
    const lenses = readCodeLenses(surface.preview.model, kernel);
    expect(lenses).toHaveLength(1);
    expect(lenses[0]!.line).toBe(3);
    expect(lenses[0]!.target).toMatchObject({ filePath: A_PATH, line: 3, column: 6 });
    expect(lenses[0]!.target!.span).toEqual({ columnStart: 6, columnEnd: 9 });
  });

  it('大纲子树一起折；父节点折不回时连子树一起不给（父在预览面上没有落点）', () => {
    const surface = makeSurface(B_PATH, B_SOURCE, B_SEGMENTS);
    mount(surface);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([
      serviceStub('documentSymbol', () => ({
        kind: 'documentSymbol',
        symbols: [
          {
            name: '被丢的父',
            kind: 'function',
            startLine: 1,
            endLine: 6,
            children: [{ name: '孩子', kind: 'block', startLine: 3, endLine: 3 }],
          },
          {
            name: '留下的父',
            kind: 'function',
            startLine: 3,
            endLine: 6,
            detail: '两段之间',
            children: [{ name: '孩子', kind: 'block', startLine: 4, endLine: 4 }],
          },
        ],
      }), asks),
    ]);
    const tree = readDocumentSymbols(surface.preview.model, kernel);
    expect(tree.map((s) => s.name)).toEqual(['留下的父']);
    expect(tree[0]).toMatchObject({ startLine: 2, endLine: 5, detail: '两段之间' });
    expect(tree[0]!.children?.[0]).toMatchObject({ name: '孩子', startLine: 3 });
  });
});

describe('糖面引用腿 · 位点换算问原文，列表留**源坐标**', () => {
  it('预览行换算到原文问一次：交回的 `path` 是源路径，列表行号一格不折', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mount(surface);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([serviceStub('references', referencesPerSourceLine, asks)]);
    // 预览第 6 行 = 源第 5 行；列一律收到行首（纪律②）
    const read = readReferences(surface.preview.model, position(6, 11), kernel);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      kind: 'references',
      path: A_PATH,
      text: A_SOURCE.join('\n'),
      line: 5,
      column: 1,
      lineCount: A_SOURCE.length,
    });
    expect(surface.preview.getValueCalls()).toBe(0);
    // 列表留在**源坐标**：面板列的是存档里的位置，回到预览面那一跳住在 `applyReveal`（④号判据）
    expect(read!.path).toBe(A_PATH);
    expect(read!.locations.map((l) => l.line)).toEqual(A_SOURCE.map((_, i) => i + 1));
    for (const location of read!.locations) {
      expect(location.filePath).toBe(A_PATH);
      expect(location.column).toBe(1);
      expect(location.span).toBeUndefined();
      expect(sourceLineToSugar(surface.lineMap, location.line)).not.toBeNull();
    }
  });

  it('四类落点各归各：幻影剔除 / 折不回丢弃 / 同文件抹列 / 跨文件原样', () => {
    const surface = makeSurface(B_PATH, B_SOURCE, B_SEGMENTS);
    mount(surface);
    const kernel = fakeKernel([
      serviceStub('references', () => ({
        kind: 'references',
        locations: [
          // 本地腿交回的投影自身 URI：那条路径上没有文件，留着就是"按了没反应"顶替一次正确跳转
          { filePath: surface.projectionUri, line: 2, column: 6 },
          // 面乙的段首糖行没有源 ⇒ 源前两行折不回预览面，这一条整枚不给
          { filePath: B_PATH, line: 1, column: 3 },
          { filePath: B_PATH, line: 4, column: 3, span: { columnStart: 3, columnEnd: 8 } },
          { filePath: 'C:/game/别处.ERB', line: 1, column: 5, span: { columnStart: 5, columnEnd: 9 } },
        ],
      }), []),
    ]);
    const read = readReferences(surface.preview.model, position(3), kernel);
    expect(read!.path).toBe(B_PATH);
    expect(read!.locations).toEqual([
      { filePath: B_PATH, line: 4, column: 1 },
      { filePath: 'C:/game/别处.ERB', line: 1, column: 5, span: { columnStart: 5, columnEnd: 9 } },
    ]);
  });

  it('映射缺席（空表）⇒ `null`：一次都不问供方、一次都不 copy 原文', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mount(surface, 1, []);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([serviceStub('references', referencesPerSourceLine, asks)]);
    expect(readReferences(surface.preview.model, position(2), kernel)).toBeNull();
    expect(asks).toHaveLength(0);
    expect(surface.source.getValueCalls()).toBe(0);
  });

  it('这一行压根没有源行 ⇒ `null`（不猜一个"最像"的源位点去问引用）', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mount(surface);
    expect(surface.lineMap[4]).toBe(0);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([serviceStub('references', referencesPerSourceLine, asks)]);
    expect(readReferences(surface.preview.model, position(5, 3), kernel)).toBeNull();
    expect(asks).toHaveLength(0);
  });

  it('无主的投影（不在登记簿上）⇒ `null`', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    const kernel = fakeKernel([serviceStub('references', referencesPerSourceLine, [])]);
    expect(readReferences(surface.preview.model, position(2), kernel)).toBeNull();
  });

  it('原文面逐字照旧：列与区间原样交回，`path` = 那份 model 自己的路径', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mountPlain(surface);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([serviceStub('references', referencesPerSourceLine, asks)]);
    const read = readReferences(surface.source.model, position(3, 8), kernel);
    expect(askedLineOf(asks[0]!)).toBe(3);
    expect((asks[0] as unknown as { column: number }).column).toBe(8);
    expect(read!.path).toBe(A_PATH);
    expect(read!.locations[2]).toEqual({ filePath: A_PATH, line: 3, column: 9, span: { columnStart: 9, columnEnd: 14 } });
  });
});

describe('悬停身份腿 `previewSourcePathOf` · 只换算归属', () => {
  it('投影面 ⇒ 背后那份**源文件路径**（索引查的是文件，不是 `inmemory://sugar/…`）', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mount(surface);
    expect(previewSourcePathOf(surface.preview.model)).toBe(A_PATH);
  });

  it('投影面但档案没有路径（新建未落盘的糖视图）⇒ `null` = 不改判据', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    const pane = mount(surface);
    pane.filePathRef.current = '';
    expect(previewSourcePathOf(surface.preview.model)).toBeNull();
  });

  it('原文面 ⇒ `null`（沿用 `model.uri`，本批对原文悬停零改动）', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mountPlain(surface);
    expect(previewSourcePathOf(surface.source.model)).toBeNull();
  });

  it('身份换算不要求映射已装配：投影退化成空表时声明行悬停照样是真话', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mount(surface, 1, []);
    expect(previewSourcePathOf(surface.preview.model)).toBe(A_PATH);
  });
});

describe('糖面签名腿 · 窗口取的是原文', () => {
  const SIG_PATH = 'C:/game/签名.ERB';
  const SIG_SOURCE = [';头', 'F(', '1, 2)'];
  // 面：源 1..3 被一段糖盖住，**糖面上没有那对括号**（投影视角判不出这次调用）
  const SIG_SEGMENTS: readonly SugarSegmentInput[] = [
    { fromLine: 1, toLine: 3, sugarText: '这里没有调用\n参数在上面\n（同一处）', sourceLines: [0, 0, 3] },
  ];

  it('源侧第 3 行往上数得到未闭合的 `F(` ⇒ 糖行照样应答', () => {
    const surface = makeSurface(SIG_PATH, SIG_SOURCE, SIG_SEGMENTS);
    mount(surface);
    const kernel = fakeKernel([]);
    setGlobalKernel(kernel);
    const hit = readSignatureHelp(surface.preview.model, position(3, 7), kernel);
    expect(hit?.callee).toBe('F');
    // 同一位点若按**投影文本**判就什么都没有 ⇒ 这一条正是"文本必须取原文"的自证
    expect(resolveSignatureInText(surface.preview.lines.join('\n'), 3, 1, protocolStub, () => null)).toBeNull();
  });

  it('无源行的那一格预览 ⇒ 不应答', () => {
    const surface = makeSurface(SIG_PATH, SIG_SOURCE, SIG_SEGMENTS);
    mount(surface);
    const kernel = fakeKernel([]);
    setGlobalKernel(kernel);
    expect(surface.lineMap[0]).toBe(0);
    expect(readSignatureHelp(surface.preview.model, position(1, 4), kernel)).toBeNull();
  });

  it('原文面上 = 直接问那一份 model（与本批前逐字同路）', () => {
    const surface = makeSurface(SIG_PATH, SIG_SOURCE, SIG_SEGMENTS);
    mountPlain({ ...surface, path: SIG_PATH });
    const kernel = fakeKernel([]);
    setGlobalKernel(kernel);
    expect(readSignatureHelp(surface.source.model, position(3, 4), kernel)).toEqual(
      signatureHelpAt(surface.source.model, position(3, 4), kernel),
    );
  });
});

describe('糖面**写**类腿 · 一律否决', () => {
  it('格式化窗口腿：糖 model ⇒ `null`（格式化改的不是原文，一个字节都不落）', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mount(surface);
    expect(formatRequestWindowFor(surface.preview.model, 1, 2)).toBeNull();
    expect(surface.source.getValueCalls()).toBe(0);
  });

  it('💡 落地：糖 model ⇒ `false`（待确认条目不认领、投影一个字符都不改）', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    const pane = mount(surface);
    pushPreview({
      paneId: pane.paneId,
      actionId: 'sugar-write-1',
      title: '补上 ENDIF',
      languageId: KOJO_LANGUAGE_ID,
      originalText: surface.preview.lines.join('\n'),
      previewText: surface.preview.lines.join('\n'),
      edits: [{ fromLine: 1, toLine: 1, newText: 'PRINT 0' }],
    });
    expect(applyQuickFixEdits('sugar-write-1')).toBe(false);
  });
});

describe('原文面 · 换算批零改动（没有投影时同一批腿逐字照旧）', () => {
  it('大纲行号直通；定义的列原样交给供方、落点原样交回（不折不回不抹）', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mountPlain(surface);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([
      serviceStub('documentSymbol', symbolPerLine, asks),
      serviceStub('definition', (request) => selfDefinition(request), asks),
    ]);
    expect(readDocumentSymbols(surface.source.model, kernel).map((s) => s.startLine)).toEqual(
      A_SOURCE.map((_, i) => i + 1),
    );
    const at = readDefinitionTargets(surface.source.model, position(3, 8), kernel);
    expect(at).toEqual([{ filePath: A_PATH, line: 3, column: 7, span: { columnStart: 7, columnEnd: 12 } }]);
    expect(askedLineOf(asks.at(1)!)).toBe(3);
    expect((asks.at(1) as unknown as { column: number }).column).toBe(8);
  });
});

describe('「源行 → 预览行」快表 · 判据必须等于 `sourceLineToSugar`', () => {
  it('压缩段 + 装饰行 + 表尾越界：逐条结果与参考实现一致（快表只是它的一次建表）', () => {
    const source = Array.from({ length: 60 }, (_, i) => `行${i + 1}`);
    const surface = makeSurface('C:/game/快表.ERB', source, [
      { fromLine: 5, toLine: 9, sugarText: '五源行压成一', sourceLines: [5] },
      { fromLine: 30, toLine: 31, sugarText: '（无源）\n两源行压成一', sourceLines: [0, 30] },
    ]);
    mount(surface);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([serviceStub('documentSymbol', symbolPerLine, asks)]);
    const folded = readDocumentSymbols(surface.preview.model, kernel);
    expect(folded).toHaveLength(source.length);
    folded.forEach((symbol, index) => {
      const sourceLine = index + 1;
      expect(symbol.startLine, `源第 ${sourceLine} 行`).toBe(sourceLineToSugar(surface.lineMap, sourceLine));
    });
    // 表尾越界（供方拿着旧快照）也走同一条退化口径：停在最后一行，而不是不答
    expect(sourceLineToSugar(surface.lineMap, source.length + 7)).toBe(surface.lineMap.length);
  });

  it('表非单调（外部数据不许假定算准了）⇒ 放弃快表，判据一条都不变', () => {
    const source = Array.from({ length: 6 }, (_, i) => `行${i + 1}`);
    const surface = makeSurface('C:/game/乱表.ERB', source, []);
    mount(surface, 1, [5, 1]);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([serviceStub('documentSymbol', symbolPerLine, asks)]);
    expect(readDocumentSymbols(surface.preview.model, kernel).map((s) => s.startLine)).toEqual(
      source.map((_, i) => sourceLineToSugar([5, 1], i + 1)).filter((line): line is number => line !== null),
    );
  });
});

describe('光标符号上报（G1 探针）· 糖面交源坐标', () => {
  it('投影在屏 + 有映射 ⇒ 交**源路径与源行**、符号树是原文那一棵、`derivedView=false`', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mount(surface, 6);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([serviceStub('documentSymbol', symbolPerLine, asks)]);
    setGlobalKernel(kernel);
    ensureGlobalProviders();
    const probe = readJumpProbe();
    // 预览第 6 行 = 源第 5 行；面板与调用层级要的都是"存档里那一行"
    expect(probe).toMatchObject({ path: A_PATH, line: 5, derivedView: false });
    expect(probe!.symbols!.map((s) => s.startLine)).toEqual(A_SOURCE.map((_, i) => i + 1));
    // 缓存留在**源空间**（撤下预览后同一份仍然正确，不会留下预览坐标的树）
    expect(asks).toHaveLength(1);
    ensureGlobalProviders();
    expect(readJumpProbe()!.symbols!.map((s) => s.startLine)).toEqual(A_SOURCE.map((_, i) => i + 1));
    expect(asks).toHaveLength(1);
  });

  it('光标停在无源行那一格 ⇒ 照旧如实标派生、不给符号（按了必须有反应，但不是假反应）', () => {
    const surface = makeSurface(A_PATH, A_SOURCE, A_SEGMENTS);
    mount(surface, 5);
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = fakeKernel([serviceStub('documentSymbol', symbolPerLine, asks)]);
    setGlobalKernel(kernel);
    ensureGlobalProviders();
    expect(readJumpProbe()).toMatchObject({ line: 5, symbols: null, derivedView: true });
    expect(asks).toHaveLength(0);
  });
});
