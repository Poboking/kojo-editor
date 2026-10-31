/**
 * Peek / 引用列表面板在**升糖预览面**上报屏幕上那一行（2026-10-20 投影折回批）。
 *
 * 缺陷形态：糖面上按 `Shift+F12`，`monaco/find-references.ts` 按 `filePath` 把同文件的引用点
 * 解到**原文那份 model** 上 ⇒ 树里列的是存档行号、落点也跳到另一面。用户在投影里看到
 * "隔壁文件第 87 行"这种不属于当前屏幕的坐标。而 `EditorPane.applyReveal` 里那次折回只服务
 * 事件通道（`editor.revealLocation`）——Peek 树里那一枚走的是 Monaco 的**同 model 就地跳**，
 * 一条事件都不发 ⇒ 那一跳没人接。
 *
 * 判据（与读类腿同一套纪律，一条都不许自建）：
 * ① 同文件 ⇒ 折回**预览行**、URI 就是屏幕上这份投影 model、列收到行首、区间不留；
 * ② 折不回的那一枚**整条不给**（绝不给猜的行号），台账读数与树里的行数同源；
 * ③ 跨文件原样（那是另一份文件，与这一面的映射无关），未打开文件那条腿与 opener 反查表照旧；
 * ④ 原文面（`sugarModelRef` 为 null）**逐字零改动**——同一批输入一条不丢、列与区间照旧；
 * ⑤ 映射缺席（空表）⇒ 同文件一条都不给（换算无从谈起），跨文件照给；
 * ⑥ 折回只认 model 身份：同一实例挂着投影、问的却是原文那份 model ⇒ 一个字段都不折。
 *
 * 面与映射都由 `composeSugarDoc` 真拼出来（不是手抄表）：整条判据骑在"文本与映射同批产出"上。
 * monaco 运行时不进 node，桩 monaco / 桩 model 照 `find-references.test.ts` 那一套。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { EditorSymbolLocation } from '@kojo/plugin-api';
import { composeSugarDoc, sourceLineToSugar, type SugarSegmentInput } from '../src/ui/sugar-view';
import { livePanes, type PaneCtx } from '../src/ui/editor-pane-registry';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { createReferenceLanding, installReferenceProvider } from '../src/monaco/find-references';
import { localLegPointOf } from '../src/monaco/erb-dim-navigation';
import { erbDimReferencesAt } from '@kojo/plugin-erb-parser';

/** 生产路径的**同构合成**（LAU-4 引用腿）：宿主位点换算 → 插件判据（宿主已无本地腿） */
function dimRefsAt(model: Monaco.editor.ITextModel, position: Monaco.Position): EditorSymbolLocation[] {
  const at = localLegPointOf(model, position);
  return at === null ? [] : erbDimReferencesAt(at.text, at.line, at.column, at.path);
}

/**
 * monaco 运行时不进 node（本池 `environment: 'node'`）：引用链上任何一环吃到装配模块
 * `ui/editor-global-providers`（它 value-import `monaco/entry`）就会在 `window is not defined` 上炸整个文件，
 * 桩法照 `sugar-provider-line-map.test.ts` / `ps4-provider-seams.test.ts`。
 */
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

/* ============================== 夹具 ============================== */

/** 存档那份（`#DIM` 声明在第 7 行、两处引用 8 / 9） */
const ARCHIVE = 'C:/game/投影面.ERB';
/** 别处那份（跨文件腿用；开着的与没开的两种情形都钉） */
const OTHER = 'C:/game/别处.ERB';

const SOURCE = [
  '@MAIN',
  'IF A',
  'PRINTFORMW 她点头',
  'ENDIF',
  'CALL FOO',
  'X = 1',
  '#DIM 好感度',
  '好感度 = 1',
  '好感度 = 2',
  'RETURN',
];

/**
 * 两段投影：`1..2` 压成一行**没有源**的引子（⇒ 存档第 1、2 行折不回任何预览行，②号判据的落点），
 * `5..6` 两源行压成一行糖（⇒ 存档第 6 行只能"停在包住它的那一段"，退化口径）。
 */
const SEGMENTS: readonly SugarSegmentInput[] = [
  { fromLine: 1, toLine: 2, sugarText: '（引子）', sourceLines: [0] },
  { fromLine: 5, toLine: 6, sugarText: '调用了 FOO。', sourceLines: [5] },
];

const COMPOSED = composeSugarDoc([...SOURCE], SEGMENTS);
const PREVIEW = COMPOSED.text.split('\n');
const LINE_MAP = COMPOSED.lineMap;
/** 投影 model 的 URI 路径（`EditorPane` 挂的是 `inmemory://sugar/<组>/<编码路径>`） */
const PROJECTION_URI = `/sugar/pane-1/${encodeURIComponent(ARCHIVE)}`;

function fakeModel(lines: readonly string[], uriPath: string, scheme: string): Monaco.editor.ITextModel {
  return {
    uri: { scheme, fsPath: uriPath, path: uriPath, toString: () => `${scheme}://${uriPath}` },
    getValue: () => lines.join('\n'),
    getLineCount: () => lines.length,
    getLineMaxColumn: (n: number) => (lines[n - 1]?.length ?? 0) + 1,
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getWordAtPosition: () => ({ startColumn: 1, endColumn: 2 }),
  } as unknown as Monaco.editor.ITextModel;
}

const ARCHIVE_MODEL = fakeModel(SOURCE, ARCHIVE, 'file');
const PREVIEW_MODEL = fakeModel(PREVIEW, PROJECTION_URI, 'inmemory');
/** 跨文件那份：给足 100 行、每行 20 字符，第 87 行的列与区间才不会被夹掉 */
const OTHER_MODEL = fakeModel(Array.from({ length: 100 }, () => 'X'.repeat(20)), OTHER, 'file');

function panePaneId(name: string): string {
  return `peek-${name}`;
}

function mount(ctx: {
  name: string;
  shown: Monaco.editor.ITextModel;
  sugar: Monaco.editor.ITextModel | null;
  lineMap: readonly number[];
}): PaneCtx {
  const entries = new Map<string, { model: Monaco.editor.ITextModel }>();
  entries.set(ARCHIVE, { model: ARCHIVE_MODEL });
  entries.set(OTHER, { model: OTHER_MODEL });
  const pane = {
    paneId: panePaneId(ctx.name),
    filePathRef: { current: ARCHIVE },
    editorRef: { current: { getModel: () => ctx.shown } as unknown as Monaco.editor.IStandaloneCodeEditor },
    sugarModelRef: { current: ctx.sugar },
    sugarLineMapRef: { current: ctx.lineMap },
    entriesRef: { current: entries as never },
    pendingActionsRef: { current: new Map<string, never>() },
    actionSeqRef: { current: 0 },
    crumbTreeCacheRef: { current: null },
  } as unknown as PaneCtx;
  livePanes.set(pane.paneId, pane);
  return pane;
}

/** 屏上挂着投影的那个实例 */
function mountProjection(lineMap: readonly number[] = LINE_MAP): PaneCtx {
  return mount({ name: 'sugar', shown: PREVIEW_MODEL, sugar: PREVIEW_MODEL, lineMap });
}

/** 原文面：`sugarModelRef` 为 null、映射空表 ⇒ 折回段一行都不执行 */
function mountPlain(): PaneCtx {
  return mount({ name: 'plain', shown: ARCHIVE_MODEL, sugar: null, lineMap: [] });
}

const pos = (lineNumber: number, column: number): Monaco.Position =>
  ({ lineNumber, column }) as unknown as Monaco.Position;

/** 树里一行的可读形状：`[URI, 起行, 起列, 止行, 止列]` */
const rowOf = (location: Monaco.languages.Location): [string, number, number, number, number] => [
  location.uri.toString(),
  location.range.startLineNumber,
  location.range.startColumn,
  location.range.endLineNumber,
  location.range.endColumn,
];

function stubMonaco(): {
  monaco: typeof Monaco;
  provider: Monaco.languages.ReferenceProvider;
  registered: Array<{ languageId: string; provider: Monaco.languages.ReferenceProvider }>;
  opener: Monaco.editor.ICodeEditorOpener | undefined;
  openers: Monaco.editor.ICodeEditorOpener[];
} {
  const registered: Array<{ languageId: string; provider: Monaco.languages.ReferenceProvider }> = [];
  const openers: Monaco.editor.ICodeEditorOpener[] = [];
  let openerRef: Monaco.editor.ICodeEditorOpener | undefined;
  const monaco = {
    Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file:///${p.replace(/\\/g, '/')}` }) },
    languages: {
      registerReferenceProvider: (languageId: string, provider: Monaco.languages.ReferenceProvider) => {
        registered.push({ languageId, provider });
        return { dispose: () => undefined };
      },
    },
    editor: {
      registerEditorOpener: (opener: Monaco.editor.ICodeEditorOpener) => {
        openerRef = opener;
        openers.push(opener);
        return { dispose: () => undefined };
      },
    },
  };
  return {
    monaco: monaco as unknown as typeof Monaco,
    // LAU-DUALLEG 车 3：宿主腿只挂**没**点名 references 的旧桥语言 ⇒ 现在只有一枚注册，
    // 取第一枚即可（屏幕上那份投影带的就是这一门的语言 id）
    get provider() {
      return registered[0]!.provider;
    },
    registered,
    openers,
    get opener() {
      return openerRef;
    },
  };
}

/** `installReferenceProvider` + 立刻问一次引用（handlers 由用例给） */
function peekAt(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  handlers: Parameters<typeof installReferenceProvider>[1],
): Monaco.languages.Location[] {
  const stub = stubMonaco();
  installReferenceProvider(stub.monaco, handlers);
  const out = stub.provider.provideReferences!(
    model,
    position,
    {} as Monaco.languages.ReferenceContext,
    {} as Monaco.CancellationToken,
  ) as Monaco.languages.Location[];
  return out;
}

/** 引用腿只在**屏幕上这一面**问；位点刻意选在两条本地腿都不命中的那一行 */
const CURSOR_ON_PREVIEW = pos(2, 1); // 预览第 2 行 = `PRINTFORMW 她点头`
const CURSOR_ON_ARCHIVE = pos(3, 1); // 同一行文本在存档的第 3 行

afterEach(() => {
  livePanes.clear();
});

/* ============================== 夹具自证：这面真的不是恒等映射 ============================== */

describe('夹具 · 投影面与映射', () => {
  it('映射非恒等：有一格没有源、有源行折不回、有源行只能停在包住它的那段糖', () => {
    expect(LINE_MAP).toEqual([0, 3, 4, 5, 7, 8, 9, 10]);
    expect(PREVIEW[0]).toBe('（引子）');
    expect(PREVIEW[4]).toBe('#DIM 好感度'); // 预览第 5 行 ⇄ 存档第 7 行
    expect(PREVIEW.length).toBe(LINE_MAP.length);
    expect(sourceLineToSugar(LINE_MAP, 1)).toBeNull(); // 存档第 1 行：压根没有对应的预览行
    expect(sourceLineToSugar(LINE_MAP, 2)).toBeNull();
    expect(sourceLineToSugar(LINE_MAP, 6)).toBe(4); // 被折进糖段：停在包住它的那一行
    expect(sourceLineToSugar(LINE_MAP, 7)).toBe(5);
    expect(sourceLineToSugar(LINE_MAP, 10)).toBe(8);
  });
});

/* ============================== 判据①：同文件折回预览行 ============================== */

describe('投影面 Peek · ①同文件的引用点折回屏幕上那一行', () => {
  it('URI = 这份投影 model、行 = 预览行、列收到行首且区间不留（`openModelFor` 那一跳不再解到原文）', () => {
    mountProjection();
    const out = peekAt(PREVIEW_MODEL, CURSOR_ON_PREVIEW, {
      resolve: () => [
        { filePath: ARCHIVE, line: 3, column: 9, span: { columnStart: 9, columnEnd: 14 } },
        { filePath: ARCHIVE, line: 7, column: 6 },
        { filePath: ARCHIVE, line: 10, column: 2, span: { columnStart: 2, columnEnd: 6 } },
      ],
      navigate: () => undefined,
      // 原文那份 model 是"开着"的：折回批之前正是这一跳把列表与落点摆到原文那一面
      openModelFor: () => ARCHIVE_MODEL,
    });
    expect(out.map(rowOf)).toEqual([
      [PREVIEW_MODEL.uri.toString(), 2, 1, 2, 1],
      [PREVIEW_MODEL.uri.toString(), 5, 1, 5, 1],
      [PREVIEW_MODEL.uri.toString(), 8, 1, 8, 1],
    ]);
    expect(out.some((l) => l.uri.toString() === ARCHIVE_MODEL.uri.toString())).toBe(false);
  });

  it('源行没有独立成行 ⇒ 停在"包住它的那一段糖"（与 `applyReveal` 同一个 `sourceLineToSugar`，不是第二份判据）', () => {
    mountProjection();
    const out = peekAt(PREVIEW_MODEL, CURSOR_ON_PREVIEW, {
      resolve: () => [
        { filePath: ARCHIVE, line: 5, column: 1 },
        { filePath: ARCHIVE, line: 6, column: 1 },
      ],
      navigate: () => undefined,
      openModelFor: () => ARCHIVE_MODEL,
    });
    expect(out.map((l) => l.range.startLineNumber)).toEqual([4, 4]);
  });

  it('折回判据**只有一份**：`.kojo` 面吃宿主腿那一枚注册，槽腿那一趟经同一枚通道出同一批行', () => {
    mountProjection();
    const stub = stubMonaco();
    // LAU-DUALLEG 车 3：ERB 点名 `references` ⇒ 宿主腿不再挂它（第三参给成 kind 就会重新挂上，
    // 那一坑由 `language-parity` 的 1032C 钉着）。屏幕上这份投影带的是 `.kojo`，
    // 仍然由本模块那一枚应答；而 ERB 那一面改由槽腿应答，两侧**共用同一枚落点通道**
    // ——折回判据因此不可能按语言 id 分叉（比"两面同一枚 provider"更强的形状）。
    const landing = createReferenceLanding(stub.monaco, {
      navigate: () => undefined,
      openModelFor: () => ARCHIVE_MODEL,
    });
    // 落点三格（怎么落地 / 哪些标签开着 / 读数交给谁）整块住在通道里：
    // 类型上堵掉了"宿主腿再交一份"，那会是第二枚全局 opener。
    installReferenceProvider(stub.monaco, {
      resolve: () => [{ filePath: ARCHIVE, line: 7, column: 6 }],
      landing,
    });
    expect(stub.registered.map((r) => r.languageId)).toEqual([KOJO_LANGUAGE_ID]);
    const sugar = stub.registered[0]!.provider.provideReferences!(
      PREVIEW_MODEL,
      CURSOR_ON_PREVIEW,
      {} as Monaco.languages.ReferenceContext,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.Location[];
    expect(sugar.map(rowOf)).toEqual([[PREVIEW_MODEL.uri.toString(), 5, 1, 5, 1]]);
    // 槽腿那一趟（生产 = `SlotServiceHost.landReferences`）：同一枚通道、同一批输入 ⇒ 逐字同一批行
    expect(landing.land(PREVIEW_MODEL, [{ filePath: ARCHIVE, line: 7, column: 6 }]).map(rowOf))
      .toEqual(sugar.map(rowOf));
    // 只此一枚 opener（两枚 = 两张反查表抢答，点击落到没人登记过的那张上就是"按了没反应"）
    expect(stub.openers).toHaveLength(1);
    landing.dispose();
  });

  it('端到端：`#DIM` 本地腿 + 真投影 ⇒ 声明与两处引用全列在预览行上（原文那一面一次都不出现）', () => {
    mountProjection();
    const navigated: EditorSymbolLocation[] = [];
    const out = peekAt(PREVIEW_MODEL, pos(5, 8), {
      // LAU-4 之后宿主不再有本地腿：接的是"位点换算 + 插件判据"这一对（与生产路径同构）
      resolve: (model, position) => dimRefsAt(model, position),
      navigate: (location) => navigated.push(location),
      openModelFor: (filePath) => (filePath === ARCHIVE ? ARCHIVE_MODEL : undefined),
    });
    // 存档 7 / 8 / 9 三处 ⇒ 预览 5 / 6 / 7 三行；本地腿交回的是存档坐标，折回就发生在本模块
    expect(out.map(rowOf)).toEqual([
      [PREVIEW_MODEL.uri.toString(), 5, 1, 5, 1],
      [PREVIEW_MODEL.uri.toString(), 6, 1, 6, 1],
      [PREVIEW_MODEL.uri.toString(), 7, 1, 7, 1],
    ]);
    expect(navigated).toEqual([]);
  });

  it('投影 URI 不进未打开文件的反查表：树里那一枚由 Monaco 就地跳，点击不该被路由成一次开文件', () => {
    mountProjection();
    const stub = stubMonaco();
    const navigated: EditorSymbolLocation[] = [];
    installReferenceProvider(stub.monaco, {
      resolve: () => [{ filePath: ARCHIVE, line: 7, column: 6 }],
      navigate: (location) => navigated.push(location),
      openModelFor: (filePath) => (filePath === ARCHIVE ? ARCHIVE_MODEL : undefined),
    });
    const out = stub.provider.provideReferences!(
      PREVIEW_MODEL,
      CURSOR_ON_PREVIEW,
      {} as Monaco.languages.ReferenceContext,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.Location[];
    expect(out.map(rowOf)).toEqual([[PREVIEW_MODEL.uri.toString(), 5, 1, 5, 1]]);
    expect(stub.opener!.openCodeEditor(
      { getModel: () => PREVIEW_MODEL } as unknown as Monaco.editor.ICodeEditor,
      PREVIEW_MODEL.uri,
      { lineNumber: 5, column: 1 },
    )).toBe(false);
    expect(navigated).toEqual([]);
  });
});

/* ============================== 判据②：折不回就不给 ============================== */

describe('投影面 Peek · ②折不回的那一枚整条不给', () => {
  it('没有对应预览行的两枚被丢掉；台账读数与树里的行数同源（表头那枚 N 不说谎）', () => {
    mountProjection();
    const seen: Array<[number, number]> = [];
    const out = peekAt(PREVIEW_MODEL, CURSOR_ON_PREVIEW, {
      resolve: () => [
        { filePath: ARCHIVE, line: 1, column: 2 }, // 折不回
        { filePath: ARCHIVE, line: 2, column: 2, kind: 'call' }, // 折不回
        { filePath: ARCHIVE, line: 3, column: 9, kind: 'mention' },
        { filePath: ARCHIVE, line: 9, column: 3, kind: 'call' },
      ],
      navigate: () => undefined,
      openModelFor: () => ARCHIVE_MODEL,
      onTally: (tally) => seen.push([tally.total, tally.f12Count]),
    });
    expect(out.map((l) => l.range.startLineNumber)).toEqual([2, 7]);
    expect(seen).toEqual([[2, 2]]); // 台账读的是折回之后剩下的那两枚，不是折之前的全集
  });

  it('源行比表尾还靠后 ⇒ 走 `sourceLineToSugar` 的退化口径停在最后一行（不猜、也不瞎一个都不给）', () => {
    mountProjection();
    const out = peekAt(PREVIEW_MODEL, CURSOR_ON_PREVIEW, {
      resolve: () => [{ filePath: ARCHIVE, line: SOURCE.length + 9, column: 4 }],
      navigate: () => undefined,
      openModelFor: () => ARCHIVE_MODEL,
    });
    expect(out.map((l) => l.range.startLineNumber)).toEqual([LINE_MAP.length]);
  });

  it('映射缺席（空表）⇒ 同文件一条都不给、跨文件照给；读数同步收敛', () => {
    mountProjection([]);
    const seen: number[] = [];
    const out = peekAt(PREVIEW_MODEL, CURSOR_ON_PREVIEW, {
      resolve: () => [
        { filePath: ARCHIVE, line: 3, column: 9, span: { columnStart: 9, columnEnd: 14 } },
        { filePath: OTHER, line: 87, column: 4, span: { columnStart: 4, columnEnd: 9 } },
      ],
      navigate: () => undefined,
      openModelFor: (filePath) => (filePath === OTHER ? OTHER_MODEL : ARCHIVE_MODEL),
      onTally: (tally) => seen.push(tally.total),
    });
    expect(out.map(rowOf)).toEqual([[OTHER_MODEL.uri.toString(), 87, 4, 87, 9]]);
    expect(seen).toEqual([1]);
  });
});

/* ============================== 判据③：跨文件原样 ============================== */

describe('投影面 Peek · ③跨文件的引用点原样交付', () => {
  it('已开的别处那份：行、列、区间一个字段都不动（那是另一份文件，与这一面的映射无关）', () => {
    mountProjection();
    const out = peekAt(PREVIEW_MODEL, CURSOR_ON_PREVIEW, {
      resolve: () => [
        { filePath: OTHER, line: 87, column: 4, span: { columnStart: 4, columnEnd: 9 } },
        { filePath: ARCHIVE, line: 7, column: 6 },
      ],
      navigate: () => undefined,
      openModelFor: (filePath) => (filePath === OTHER ? OTHER_MODEL : ARCHIVE_MODEL),
    });
    expect(out.map(rowOf)).toEqual([
      [OTHER_MODEL.uri.toString(), 87, 4, 87, 9],
      [PREVIEW_MODEL.uri.toString(), 5, 1, 5, 1],
    ]);
  });

  it('没开的别处那份：仍发 file URI 并进 opener 反查表，点击落回 `navigate`（未打开那条腿没被折回段抢走）', () => {
    mountProjection();
    const stub = stubMonaco();
    const navigated: EditorSymbolLocation[] = [];
    installReferenceProvider(stub.monaco, {
      resolve: () => [
        { filePath: OTHER, line: 87, column: 4, span: { columnStart: 4, columnEnd: 9 } },
        { filePath: ARCHIVE, line: 7, column: 6 },
      ],
      navigate: (location) => navigated.push(location),
      // 一份 model 都不"开着"：同文件那一枚仍该落在屏幕上这一面（折回段根本不问 `openModelFor`）
      openModelFor: () => undefined,
    });
    const out = stub.provider.provideReferences!(
      PREVIEW_MODEL,
      CURSOR_ON_PREVIEW,
      {} as Monaco.languages.ReferenceContext,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.Location[];
    expect(out.map(rowOf)).toEqual([
      ['file:///C:/game/别处.ERB', 87, 4, 87, 9],
      [PREVIEW_MODEL.uri.toString(), 5, 1, 5, 1],
    ]);
    expect(stub.opener!.openCodeEditor(
      { getModel: () => PREVIEW_MODEL } as unknown as Monaco.editor.ICodeEditor,
      out[0]!.uri,
      { startLineNumber: 87, startColumn: 4, endLineNumber: 87, endColumn: 9 },
    )).toBe(true);
    expect(navigated).toEqual([
      { filePath: OTHER, line: 87, column: 4, span: { columnStart: 4, columnEnd: 9 } },
    ]);
  });
});

/* ============================== 判据④：原文面逐字零改动 ============================== */

describe('原文面 · 折回批零改动（同一批输入一条不丢、列与区间照旧）', () => {
  it('`sugarModelRef` 为 null ⇒ 行 = 存档行、列 = 存档列与区间；折不回那两枚照给（那就是屏幕上的一行）', () => {
    mountPlain();
    const out = peekAt(ARCHIVE_MODEL, CURSOR_ON_ARCHIVE, {
      resolve: () => [
        { filePath: ARCHIVE, line: 1, column: 2 },
        { filePath: ARCHIVE, line: 3, column: 9, span: { columnStart: 9, columnEnd: 14 } },
        { filePath: ARCHIVE, line: 6, column: 1 },
        { filePath: OTHER, line: 87, column: 4, span: { columnStart: 4, columnEnd: 9 } },
      ],
      navigate: () => undefined,
      openModelFor: (filePath) => (filePath === OTHER ? OTHER_MODEL : ARCHIVE_MODEL),
    });
    expect(out.map(rowOf)).toEqual([
      [ARCHIVE_MODEL.uri.toString(), 1, 2, 1, 2],
      [ARCHIVE_MODEL.uri.toString(), 3, 9, 3, 14],
      [ARCHIVE_MODEL.uri.toString(), 6, 1, 6, 1],
      [OTHER_MODEL.uri.toString(), 87, 4, 87, 9],
    ]);
  });

  it('判据认的是 **model 身份**：同一实例正挂着投影，问的却是原文那份 model ⇒ 一个字段都不折', () => {
    mountProjection();
    mountPlain();
    const out = peekAt(ARCHIVE_MODEL, CURSOR_ON_ARCHIVE, {
      resolve: () => [{ filePath: ARCHIVE, line: 3, column: 9, span: { columnStart: 9, columnEnd: 14 } }],
      navigate: () => undefined,
      openModelFor: () => ARCHIVE_MODEL,
    });
    expect(out.map(rowOf)).toEqual([[ARCHIVE_MODEL.uri.toString(), 3, 9, 3, 14]]);
  });

  it('登记簿查不到归属实例的派生 model ⇒ 不折（没有可认的屏幕，就没有可言的映射）', () => {
    const out = peekAt(PREVIEW_MODEL, CURSOR_ON_PREVIEW, {
      resolve: () => [{ filePath: ARCHIVE, line: 3, column: 9, span: { columnStart: 9, columnEnd: 14 } }],
      navigate: () => undefined,
      openModelFor: () => ARCHIVE_MODEL,
    });
    expect(out.map(rowOf)).toEqual([[ARCHIVE_MODEL.uri.toString(), 3, 9, 3, 14]]);
  });
});

/* ============================== 反证：真拼出来的面与手抄表不可能漂 ============================== */

describe('折回判据不复制', () => {
  it('树里的每一枚都等于 `sourceLineToSugar` 自己算出来的那一行（映射只有那一份，折不回的两枚少掉）', () => {
    const ctx = mountProjection();
    // 存档每一行都报一条引用：能落回屏幕的都该在，落不回的（第 1、2 行）该少
    const out = peekAt(PREVIEW_MODEL, CURSOR_ON_PREVIEW, {
      resolve: () => SOURCE.map((_, i) => ({ filePath: ARCHIVE, line: i + 1, column: 6 })),
      navigate: () => undefined,
      openModelFor: () => ARCHIVE_MODEL,
    });
    const expected = SOURCE.map((_, i) => sourceLineToSugar(LINE_MAP, i + 1)).filter(
      (line): line is number => line !== null,
    );
    expect(expected).toHaveLength(SOURCE.length - 2);
    expect(out.map((l) => l.range.startLineNumber)).toEqual(expected);
    for (const location of out) {
      expect(location.uri.toString()).toBe(PREVIEW_MODEL.uri.toString());
      expect(location.range.startColumn).toBe(1);
      // 落点那一格必须真的带着源行（不是收束/装饰行），且指回的就是这一枚引用
      const source = ctx.sugarLineMapRef.current[location.range.startLineNumber - 1]!;
      expect(source > 0, `预览第 ${location.range.startLineNumber} 行`).toBe(true);
    }
  });
});
