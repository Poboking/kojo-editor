/**
 * `$` 标签腿在**升糖预览面**上问的是**原文**（2026-10-20 中文谓词批）。
 *
 * 缺口原形（线上改前的形状）：`labelScopeAt` 只认原文形状——`$NAME` 的前缀、`JUMP/GOTO/TRYJUMP/
 * TRYGOTO` 的行首记号（`packages/plugins/erb-parser/src/symbols.ts`）。而预览把**行首那串原生记号**
 * 换成了中文谓词（`GOTO NEXT` → `跳到 NEXT`、`$NEXT` → `标签 NEXT`，
 * `packages/plugins/kojo-sugar/src/native-display/control.ts`）。拿译稿去对原稿的页码 ⇒
 * **恒 `null`**：作者明知屏幕上那一行就是标签，F12 / Shift+F12 一声不吭。
 * 本文件第一件事就是把"恒空"钉在**投影文本**上（下面那格 `labelScopeAt(糖文…) = null`），
 * 这样"改回拿投影文本发问"这个动作本身会立刻显形。
 *
 * 钉五条：
 * ① 中文谓词行（`跳到 NAME` / `标签 NAME`）上的光标 ⇒ 标签腿**给出作用域**；
 * ② 交回的出现点是**存档坐标**（存档行 + 源行自己的真列真区间——那份作用域生在存档侧，
 *    再折一次行号就是折两遍；与 `#DIM` 两腿"列收到行首"的形状刻意不同，裁决书点名接受）；
 * ③ **原文面逐字不变**：同一份文本走 `mountPlain`，腿的读数与直接问解析器**完全同一**；
 * ④ 原文 model 取不到 ⇒ 整腿不给，且**一次都没问成投影文本**（取文计数为 0）；
 * ⑤ 投影退化（空映射表）/ 光标那一格没有源行 ⇒ 不给。
 *
 * 面与映射由 `composeSugarDoc` **真拼**（行号、文本同批产出），不手抄表；夹具形状照
 * `sugar-local-legs-source-coords.test.ts`（测试文件之间不互相 import 夹具）。
 * monaco 运行时不进 node ⇒ 桩 model / 桩 monaco。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { labelScopeAt } from '@kojo/plugin-erb-parser';
import { composeSugarDoc, type SugarSegmentInput } from '../src/ui/sugar-view';
import { livePanes, type PaneCtx } from '../src/ui/editor-pane-registry';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { installDefinitionProvider } from '../src/monaco/kojo-definition';
import { derivedLegSurfaceOf, mergeSymbolLocations } from '../src/monaco/erb-dim-navigation';
import {
  labelDefinitionLocations,
  labelReferenceLocations,
  resolveErbLabelScopeAt,
} from '../src/monaco/erb-label-navigation';

/* ============================== 夹具 ============================== */

const ARCHIVE = 'C:/game/投影乙.ERB';

/**
 * 存档 12 行：`$NAME` 在 8、`GOTO NAME` 在 11；`#DIM 计数`（6）与注释行（10）是**对照组**——
 * 前者走"透传档"，后者是解析器一律屏蔽的那一档。
 */
const SOURCE = [
  '@MAIN',
  '  PRINTL 起手',
  '  IF X',
  '    CALLFOO',
  '  ENDIF',
  '  #DIM 计数',
  '  计数 = 1',
  '$NAME',
  '  PRINTL 中段',
  '; 注释里也写着 NAME',
  '  GOTO NAME',
  'RETURN',
];

/**
 * 三枚段，每一枚都**动了行首那串原生记号**（投影给中文谓词、载荷逐字带走）：
 * - `IF/CALLFOO/ENDIF` 三行压成两行 ⇒ 从此预览行号与存档行号分叉；
 * - `$NAME` 摊成两行，且**装饰行那一格没有源行**（`0`）；
 * - `GOTO NAME` 换成 `跳到 NAME`（行数不变，行号也已经与存档不等）。
 */
const SEGMENTS: readonly SugarSegmentInput[] = [
  { fromLine: 3, toLine: 5, sugarText: '如果 X：\n结束：', sourceLines: [3, 5] },
  { fromLine: 8, toLine: 8, sugarText: '标签 NAME\n（标签位）', sourceLines: [8, 0] },
  { fromLine: 11, toLine: 11, sugarText: '跳到 NAME', sourceLines: [11] },
];

const COMPOSED = composeSugarDoc([...SOURCE], SEGMENTS);
const PREVIEW = COMPOSED.text.split('\n');
const LINE_MAP = COMPOSED.lineMap;
const SOURCE_TEXT = SOURCE.join('\n');
const PROJECTION_URI = `/sugar/pane-1/${encodeURIComponent(ARCHIVE)}`;

/** 桩 model：带取文计数（④"一次都没问成"就断言这两个计数） */
function fakeModel(
  lines: readonly string[],
  uriPath: string,
  scheme: string,
  counters?: { getValue: number; getLineContent: number },
): Monaco.editor.ITextModel {
  const owned = counters ?? { getValue: 0, getLineContent: 0 };
  modelCounters.set(uriPath, owned);
  return {
    uri: { scheme, fsPath: uriPath, path: uriPath, toString: () => `${scheme}://${uriPath}` },
    getValue: () => {
      owned.getValue++;
      return lines.join('\n');
    },
    getLineCount: () => lines.length,
    getLineMaxColumn: (n: number) => (lines[n - 1]?.length ?? 0) + 1,
    getLineContent: (n: number) => {
      owned.getLineContent++;
      return lines[n - 1] ?? '';
    },
    getWordAtPosition: () => ({ startColumn: 3, endColumn: 6 }),
  } as unknown as Monaco.editor.ITextModel;
}

const modelCounters = new Map<string, { getValue: number; getLineContent: number }>();

const ARCHIVE_MODEL = fakeModel(SOURCE, ARCHIVE, 'file');
const PREVIEW_MODEL = fakeModel(PREVIEW, PROJECTION_URI, 'inmemory');

const pos = (lineNumber: number, column: number): Monaco.Position =>
  ({ lineNumber, column }) as unknown as Monaco.Position;

/** 屏上挂着投影的那个实例档案；`sourceModel = null` = 那份原文 model 不在登记表里 */
function mountProjection(
  lineMap: readonly number[] = LINE_MAP,
  sourceModel: Monaco.editor.ITextModel | null = ARCHIVE_MODEL,
): PaneCtx {
  const entries = new Map<string, { model: Monaco.editor.ITextModel }>();
  if (sourceModel) entries.set(ARCHIVE, { model: sourceModel });
  const pane = {
    paneId: 'label-source-text',
    filePathRef: { current: ARCHIVE },
    editorRef: { current: { getModel: () => PREVIEW_MODEL } as unknown as Monaco.editor.IStandaloneCodeEditor },
    sugarModelRef: { current: PREVIEW_MODEL },
    sugarLineMapRef: { current: lineMap },
    entriesRef: { current: entries as never },
    pendingActionsRef: { current: new Map<string, never>() },
    actionSeqRef: { current: 0 },
    crumbTreeCacheRef: { current: null },
  } as unknown as PaneCtx;
  livePanes.set(pane.paneId, pane);
  return pane;
}

/** 原文面：同一批文本挂成 `file:` model，**没有投影**挂在屏上（逐字不变的对照组） */
function mountPlain(lines: readonly string[]): Monaco.editor.ITextModel {
  livePanes.clear();
  return fakeModel(lines, ARCHIVE, 'file');
}

afterEach(() => {
  livePanes.clear();
});

/* ============================== 夹具自证 ============================== */

describe('夹具 · 中文谓词与行号分叉', () => {
  it('行首原生记号在两面上**不是同一串**，行号也处处不等（否则这面测不到本批）', () => {
    expect(LINE_MAP).toEqual([1, 2, 3, 5, 6, 7, 8, 0, 9, 10, 11, 12]);
    expect(PREVIEW[6]).toBe('标签 NAME'); // 预览第 7 行 ⇄ 存档第 8 行 `$NAME`
    expect(PREVIEW[7]).toBe('（标签位）'); // 预览第 8 行：没有源行
    expect(PREVIEW[10]).toBe('跳到 NAME'); // 预览第 11 行 ⇄ 存档第 11 行 `  GOTO NAME`
    expect(PREVIEW.length).toBe(LINE_MAP.length);
    expect(SOURCE[7]).toBe('$NAME');
    expect(SOURCE[10]).toBe('  GOTO NAME');
  });

  it('缺口的显形位：把**投影文本**交给解析器，恒 `null`（改前这条腿就是这么问的）', () => {
    expect(labelScopeAt(COMPOSED.text, ARCHIVE, 7, 4)).toBeNull(); // `标签 NAME`
    expect(labelScopeAt(COMPOSED.text, ARCHIVE, 11, 4)).toBeNull(); // `跳到 NAME`
  });
});

/* ============================== ① 中文谓词行给出作用域 ============================== */

describe('标签腿 · 投影面拿原文发问', () => {
  it('光标停在中文 `跳到 NAME` 上 ⇒ 给出作用域（改前恒空）', () => {
    mountProjection();
    const scope = resolveErbLabelScopeAt(PREVIEW_MODEL, pos(11, 4))!;
    expect(scope).not.toBeNull();
    expect(scope.normalizedName).toBe('NAME');
  });

  it('光标停在中文 `标签 NAME` 上 ⇒ 同样给出作用域（定义腿那一形）', () => {
    mountProjection();
    expect(resolveErbLabelScopeAt(PREVIEW_MODEL, pos(7, 4))?.normalizedName).toBe('NAME');
  });

  it('光标落在**中文谓词**本身（不是载荷）⇒ 不给：换算落不到入口就是落不到', () => {
    mountProjection();
    expect(resolveErbLabelScopeAt(PREVIEW_MODEL, pos(11, 1))).toBeNull(); // `跳`
    expect(resolveErbLabelScopeAt(PREVIEW_MODEL, pos(7, 1))).toBeNull(); // `标`
  });

  it('列换算落点自证：投影 col 4 的 `跳到 NAME` ⇄ 源行 col 8 的 `  GOTO NAME`（行尾对齐那一步）', () => {
    mountProjection();
    // 源行里 NAME 占第 8 列起；拿源侧同一枚位点直接问解析器，读数必须与派生面**完全同一**
    const asked = labelScopeAt(SOURCE_TEXT, ARCHIVE, 11, 8);
    expect(asked?.normalizedName).toBe('NAME');
    expect(resolveErbLabelScopeAt(PREVIEW_MODEL, pos(11, 4))).toEqual(asked);
  });
});

/* ============================== ② 出现点 = 存档坐标 ============================== */

describe('标签腿 · 交出去的每一枚都属于存档', () => {
  it('定义与跳转都是**存档行号 + 源行自己的真列真区间**（生在存档侧，不再折第二遍）', () => {
    mountProjection();
    const scope = resolveErbLabelScopeAt(PREVIEW_MODEL, pos(11, 4))!;
    expect(scope.functionStartLine).toBe(1); // 源侧 `@MAIN`，不是"投影第一行"的巧合
    expect(labelDefinitionLocations(scope)).toEqual([
      { filePath: ARCHIVE, line: 8, column: 2, span: { columnStart: 2, columnEnd: 6 }, kind: 'definition' },
    ]);
    expect(labelReferenceLocations(scope)).toEqual([
      { filePath: ARCHIVE, line: 8, column: 2, span: { columnStart: 2, columnEnd: 6 }, kind: 'definition' },
      { filePath: ARCHIVE, line: 11, column: 8, span: { columnStart: 8, columnEnd: 12 }, kind: 'mention' },
    ]);
  });

  it(`一行没有源行（\`0\` 那一格）⇒ 不发问、不给结果`, () => {
    mountProjection();
    expect(resolveErbLabelScopeAt(PREVIEW_MODEL, pos(8, 1))).toBeNull(); // `（标签位）`
  });

  it('注释行上的同记号不参与（解析器那把尺子原样生效，本层不放宽）', () => {
    mountProjection();
    expect(resolveErbLabelScopeAt(PREVIEW_MODEL, pos(10, 8))).toBeNull(); // `; 注释里也写着 NAME`
  });

  it('派生面交出的路径**没有一枚**是投影 URI（幻影不许顶掉真落点）', () => {
    mountProjection();
    const scope = resolveErbLabelScopeAt(PREVIEW_MODEL, pos(11, 4))!;
    for (const location of labelReferenceLocations(scope)) {
      expect(location.filePath).toBe(ARCHIVE);
      expect(location.filePath).not.toContain('sugar');
    }
  });
});

/* ============================== ③ 原文面逐字不变 ============================== */

describe('标签腿 · 原文面一个字节都不碰', () => {
  it('同一份原文挂成 `file:` model ⇒ 腿的读数与**直接问解析器**完全同一', () => {
    const plain = mountPlain(SOURCE);
    expect(resolveErbLabelScopeAt(plain, pos(11, 8))).toEqual(labelScopeAt(SOURCE_TEXT, ARCHIVE, 11, 8));
    expect(resolveErbLabelScopeAt(plain, pos(8, 2))).toEqual(labelScopeAt(SOURCE_TEXT, ARCHIVE, 8, 2));
  });

  it('中文谓词行在**原文面**上照样不是入口（判据没动、也没在 app 层补第二条）', () => {
    const plain = mountPlain(PREVIEW); // 把糖文当真实文件内容
    expect(derivedLegSurfaceOf(plain)).toBeNull(); // `file:` ⇒ 不是派生面
    expect(resolveErbLabelScopeAt(plain, pos(11, 4))).toBeNull(); // `跳到 NAME` 在原文面上不是 GOTO 行
    expect(resolveErbLabelScopeAt(plain, pos(7, 4))).toBeNull(); // `标签 NAME` 不是 `$` 行
  });

  it('原文面走的是 model 自己的取文那条腿（本批一个字没改：`getValue` / `getLineContent` 照旧被问）', () => {
    const counters = { getValue: 0, getLineContent: 0 };
    const plain = fakeModel(SOURCE, 'C:/game/投影乙原文.ERB', 'file', counters);
    expect(derivedLegSurfaceOf(plain)).toBeNull();
    resolveErbLabelScopeAt(plain, pos(11, 8));
    expect(counters.getLineContent).toBe(1); // 前置闸问的是屏幕上这一行
    expect(counters.getValue).toBe(1); // 发问的文本就是这份 model 自己
  });
});

/* ============================== ④ 取不到原文 ⇒ 不给，且不拿投影凑 ============================== */

describe('标签腿 · 没有原文就没有答案', () => {
  it('原文 model 不在登记表里 ⇒ 整腿 `null`，且**投影文本一次都没被问成**', () => {
    mountProjection(LINE_MAP, null);
    expect(derivedLegSurfaceOf(PREVIEW_MODEL)).toBeNull();
    const before = modelCounters.get(PROJECTION_URI)!;
    const askedBefore = before.getValue;
    expect(resolveErbLabelScopeAt(PREVIEW_MODEL, pos(11, 4))).toBeNull();
    // 派生面一旦拿不到原文，本腿连"读投影文本"这一步都不许走（走了就是拿译稿对页码）
    expect(modelCounters.get(PROJECTION_URI)!.getValue).toBe(askedBefore);
    expect(modelCounters.get(PROJECTION_URI)!.getLineContent).toBe(0);
  });

  it('原文 model 是空文件 ⇒ 同样不给（空串切分会凭空多出一行，那是一枚假行号）', () => {
    const empty = fakeModel([''], ARCHIVE, 'file');
    mountProjection(LINE_MAP, empty);
    expect(derivedLegSurfaceOf(PREVIEW_MODEL)).toBeNull();
    expect(resolveErbLabelScopeAt(PREVIEW_MODEL, pos(11, 4))).toBeNull();
  });

  it('登记簿里压根没有这个实例 ⇒ 不给', () => {
    expect(derivedLegSurfaceOf(PREVIEW_MODEL)).toBeNull();
    expect(resolveErbLabelScopeAt(PREVIEW_MODEL, pos(11, 4))).toBeNull();
  });
});

/* ============================== ⑤ 投影退化 ============================== */

describe('标签腿 · 投影退化就不给', () => {
  it('空映射表（投影装配不出来）⇒ 一律 `null`', () => {
    mountProjection([]);
    expect(resolveErbLabelScopeAt(PREVIEW_MODEL, pos(11, 4))).toBeNull();
    expect(resolveErbLabelScopeAt(PREVIEW_MODEL, pos(7, 4))).toBeNull();
  });

  it('映射表比屏幕行数短 ⇒ 越界那一行不发问', () => {
    mountProjection([1, 2, 3]);
    expect(resolveErbLabelScopeAt(PREVIEW_MODEL, pos(11, 4))).toBeNull();
  });
});

/* ============================== 装配点 ============================== */

function stubMonaco(): {
  monaco: typeof Monaco;
  definitions: { languageId: string; provider: Monaco.languages.DefinitionProvider }[];
} {
  const definitions: { languageId: string; provider: Monaco.languages.DefinitionProvider }[] = [];
  const monaco = {
    Uri: { file: (p: string) => ({ toString: () => `file:///${p}`, fsPath: p }) },
    languages: {
      registerDefinitionProvider: (languageId: string, provider: Monaco.languages.DefinitionProvider) => {
        definitions.push({ languageId, provider });
        return { dispose: () => undefined };
      },
      registerReferenceProvider: () => ({ dispose: () => undefined }),
    },
    editor: { registerEditorOpener: () => ({ dispose: () => undefined }) },
  };
  return { monaco: monaco as unknown as typeof Monaco, definitions };
}

describe('装配点 · 中文标签行上的 F12', () => {
  it('槽腿给的就是存档坐标：跳到**存档第 8 行**、带源行那一列的区间', () => {
    mountProjection();
    const { monaco, definitions } = stubMonaco();
    installDefinitionProvider(monaco, {
      resolve: () => [{ filePath: ARCHIVE, line: 8, column: 2, span: { columnStart: 2, columnEnd: 6 } }],
      navigate: () => undefined,
      openModelFor: (filePath) => (filePath === ARCHIVE ? ARCHIVE_MODEL : undefined),
    });
    const provider = definitions.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    const links = provider.provideDefinition(
      PREVIEW_MODEL,
      pos(11, 4),
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.LocationLink[];
    expect(links).toHaveLength(1);
    expect(links[0]!.uri.toString()).toBe(ARCHIVE_MODEL.uri.toString());
    expect(links[0]!.targetSelectionRange).toEqual({
      startLineNumber: 8,
      startColumn: 2,
      endLineNumber: 8,
      endColumn: 6,
    });
  });

  it(`与槽腿在存档坐标上合并去重（本批只多了一枚**真落点**，没有多第二枚）`, () => {
    mountProjection();
    const merged = mergeSymbolLocations(
      labelDefinitionLocations(resolveErbLabelScopeAt(PREVIEW_MODEL, pos(11, 4))!),
      [{ filePath: ARCHIVE, line: 8, column: 2, span: { columnStart: 2, columnEnd: 6 }, kind: 'definition' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.line).toBe(8);
  });
});
