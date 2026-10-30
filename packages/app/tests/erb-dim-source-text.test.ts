/**
 * `#DIM` 两条**缓冲区本地腿**（定义 / 引用）在升糖预览面上问的是**原文**（DIM-1，2026-10-20）。
 *
 * 缺口原形：投影把 `#DIM 好感度` 显示成 `声明数组 好感度`
 * （`packages/plugins/kojo-sugar/src/native-display/control.ts` 的 `PREPROCESSORS`），
 * 改前两条腿拿**投影文本**去 `dimDeclarationOf` / 声明扫描 ⇒ 永远 0 命中；而投影列与原列
 * 不同源（`声明数组` 与 `#DIM` 宽度不同），把投影列套到原文那一行就是拿中文面的尺子量原稿。
 * 改法照 `$` 标签腿（`sugar-label-source-text.test.ts`）：派生面只拿"这个位置对应哪一条源行"
 * 与行尾对齐的存档位点，发问与取词全部回到**原文缓冲**，出口就是源坐标。
 *
 * 钉六条：
 * ① 缺口显形：把投影文本交给两条纯函数 ⇒ 0 命中（改前这条腿就是这么问的）；
 * ② 定义腿：投影引用行上的光标 ⇒ 命中**原文声明行**，列是源列 `8`（不是投影列 `6`）、带真区间；
 * ③ 引用腿：投影声明行 `声明数组 好感度` 的名字上 ⇒ 声明 + 两处引用，行/列/区间全是源坐标；
 * ④ **不猜**：光标停在中文谓词（`声明数组`）上 ⇒ 两条腿都不给；
 * ⑤ **没有原文就没有答案**：映射缺席 / 那一格没有源行 / 原文 model 取不到 ⇒ 不给；
 * ⑥ 原文面逐字不变：同一份文本挂成 `file:` model ⇒ 与纯函数读数完全同一。
 *
 * 面与映射由 `composeSugarDoc` 真拼（行号、文本同批产出），不手抄表；monaco 运行时不进 node，
 * 桩 model / 桩 monaco 照 `sugar-local-legs-source-coords.test.ts` 那一套。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { composeSugarDoc, type SugarSegmentInput } from '../src/ui/sugar-view';
import { livePanes, type PaneCtx } from '../src/ui/editor-pane-registry';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { installDefinitionProvider } from '../src/monaco/kojo-definition';
import { installReferenceProvider } from '../src/monaco/find-references';
import {
  derivedLegSurfaceOf,
  localLegPointOf,
  resolveErbDimDefinition,
  resolveErbDimDefinitionAt,
} from '../src/monaco/erb-dim-navigation';
// LAU-4 引用腿（2026-10-31）：判据在插件；宿主只做投影面位点换算（同构合成见下方测试助手）
import { erbDimReferencesAt as resolveErbDimReferences } from '@kojo/plugin-erb-parser';
import type { EditorSymbolLocation } from '@kojo/plugin-api';

/**
 * 生产路径的**同构合成**：宿主位点换算（`localLegPointOf`，与定义腿同一枚）→ 插件判据
 * （`erbDimReferencesAt`）。`find-references.ts` 里已没有本地腿，这里测的就是那两段。
 */
function resolveErbDimReferencesAt(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): EditorSymbolLocation[] {
  const at = localLegPointOf(model, position);
  return at === null ? [] : resolveErbDimReferences(at.text, at.line, at.column, at.path);
}

/* ============================== 夹具 ============================== */

/** 存档路径（真文件后缀：投影面的方言闸走的是**这一条**后缀） */
const ARCHIVE = 'C:/game/投影丙.ERB';

/**
 * 存档 9 行：`#DIM 好感度` 在 2、`IF 好感度 >= 50` 在 4、两处引用 7 / 8。
 */
const SOURCE = [
  '@MAIN',
  '  #DIM 好感度',
  '  PRINTL 起手',
  '  IF 好感度 >= 50',
  '    PRINTL 高',
  '  ENDIF',
  '  好感度 = 1',
  '  好感度 = 2',
  'RETURN',
];

/**
 * 两段投影，两处都动了行首记号：
 * - `#DIM 好感度` → `声明数组 好感度`（载荷 `好感度` 逐字带走、停在行尾）；
 * - `IF … / PRINTL … / ENDIF` 三行压成 `如果 …` + `结束：` 两行（行号从此与存档分叉）。
 */
const SEGMENTS: readonly SugarSegmentInput[] = [
  { fromLine: 2, toLine: 2, sugarText: '声明数组 好感度', sourceLines: [2] },
  { fromLine: 4, toLine: 6, sugarText: '如果 好感度 >= 50\n结束：', sourceLines: [4, 6] },
];

const COMPOSED = composeSugarDoc([...SOURCE], SEGMENTS);
const PREVIEW = COMPOSED.text.split('\n');
const LINE_MAP = COMPOSED.lineMap;
const SOURCE_TEXT = SOURCE.join('\n');
/** 投影 model 的 URI 路径（`EditorPane` 挂的是 `inmemory://sugar/<组>/<编码路径>`） */
const PROJECTION_URI = `/sugar/pane-1/${encodeURIComponent(ARCHIVE)}`;

/** 桩 model：`scheme` 是真的（`file:` 才有文件可依；`inmemory` 是派生面） */
function fakeModel(lines: readonly string[], uriPath: string, scheme: string): Monaco.editor.ITextModel {
  return {
    uri: { scheme, fsPath: uriPath, path: uriPath, toString: () => `${scheme}://${uriPath}` },
    getValue: () => lines.join('\n'),
    getLineCount: () => lines.length,
    getLineMaxColumn: (n: number) => (lines[n - 1]?.length ?? 0) + 1,
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getWordAtPosition: () => ({ startColumn: 3, endColumn: 6 }),
  } as unknown as Monaco.editor.ITextModel;
}

const ARCHIVE_MODEL = fakeModel(SOURCE, ARCHIVE, 'file');
const PREVIEW_MODEL = fakeModel(PREVIEW, PROJECTION_URI, 'inmemory');

const pos = (lineNumber: number, column: number): Monaco.Position =>
  ({ lineNumber, column }) as unknown as Monaco.Position;

/** 屏上挂着投影的那个实例档案（`sugarModelRef` / `sugarLineMapRef` / `filePathRef` 全是判据来源）
 *  `sourceModel = null` = 登记表里没有那份**原文** model（派生面就此取不到归属） */
function mountProjection(
  lineMap: readonly number[] = LINE_MAP,
  sourceModel: Monaco.editor.ITextModel | null = ARCHIVE_MODEL,
): PaneCtx {
  const entries = new Map<string, { model: Monaco.editor.ITextModel }>();
  if (sourceModel) entries.set(ARCHIVE, { model: sourceModel });
  const pane = {
    paneId: 'dim-source-text',
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

afterEach(() => {
  livePanes.clear();
});

/* ============================== 夹具自证 ============================== */

describe('夹具 · 声明行换了词，行号也不再相等', () => {
  it('原文 `#DIM 好感度` / 投影 `声明数组 好感度` 是同一行；投影处处不含 `#DIM`', () => {
    expect(LINE_MAP).toEqual([1, 2, 3, 4, 6, 7, 8, 9]);
    expect(SOURCE[1]).toBe('  #DIM 好感度');
    expect(PREVIEW[1]).toBe('声明数组 好感度'); // 预览第 2 行 ⇄ 存档第 2 行
    expect(PREVIEW[3]).toBe('如果 好感度 >= 50'); // 预览第 4 行 ⇄ 存档第 4 行
    expect(COMPOSED.text).not.toContain('#DIM');
    expect(PREVIEW.length).toBe(LINE_MAP.length);
  });

  it('缺口显形：把**投影文本**交给两条纯函数，恒 0 命中（改前这条腿就是这么问的）', () => {
    expect(resolveErbDimDefinition(COMPOSED.text, 4, 4, ARCHIVE)).toEqual([]); // `如果 好感度 …`
    expect(resolveErbDimReferences(COMPOSED.text, 2, 6, ARCHIVE)).toEqual([]); // `声明数组 好感度`
  });
});

/* ============================== 腿①：定义腿 ============================== */

describe('#DIM 定义腿 · 投影面问原文、交源坐标', () => {
  it('光标在投影的引用行（中文谓词行）⇒ 命中**原文声明行**：源列 8、真区间（不是投影列 6）', () => {
    mountProjection();
    expect(resolveErbDimDefinitionAt(PREVIEW_MODEL, pos(4, 4))).toEqual([
      { filePath: ARCHIVE, line: 2, column: 8, span: { columnStart: 8, columnEnd: 11 } },
    ]);
  });

  it('光标直接停在 `声明数组 好感度` 的名字上 ⇒ 同样自跳到原文声明名', () => {
    mountProjection();
    expect(resolveErbDimDefinitionAt(PREVIEW_MODEL, pos(2, 6))).toEqual([
      { filePath: ARCHIVE, line: 2, column: 8, span: { columnStart: 8, columnEnd: 11 } },
    ]);
  });
});

/* ============================== 腿②：引用腿 ============================== */

describe('#DIM 引用腿 · 投影面问原文、交源坐标', () => {
  it('投影声明行的名字上 Shift+F12 ⇒ 声明 + 两处引用，行/列/区间全是源坐标', () => {
    mountProjection();
    const out = resolveErbDimReferencesAt(PREVIEW_MODEL, pos(2, 6));
    expect(out).toEqual([
      { filePath: ARCHIVE, line: 2, column: 8, span: { columnStart: 8, columnEnd: 11 }, kind: 'definition' },
      { filePath: ARCHIVE, line: 4, column: 6, span: { columnStart: 6, columnEnd: 9 }, kind: 'mention' },
      { filePath: ARCHIVE, line: 7, column: 3, span: { columnStart: 3, columnEnd: 6 }, kind: 'mention' },
      { filePath: ARCHIVE, line: 8, column: 3, span: { columnStart: 3, columnEnd: 6 }, kind: 'mention' },
    ]);
    // 列是源行自己的宽度：声明名在原文第 8 列，投影上它从第 6 列开始
    expect(out[0]!.column).toBe(8);
    expect(PREVIEW[1]!.indexOf('好感度') + 1).toBe(6);
  });
});

/* ============================== 不猜 / 没有原文就没有答案 ============================== */

describe('两条腿 · 命中不了就不给（fail-visible）', () => {
  it('光标停在中文谓词 `声明数组` 上 ⇒ 映射出的原文位点不是名字：两条腿都不给', () => {
    mountProjection();
    expect(resolveErbDimDefinitionAt(PREVIEW_MODEL, pos(2, 2))).toEqual([]);
    expect(resolveErbDimReferencesAt(PREVIEW_MODEL, pos(2, 2))).toEqual([]);
  });

  it('映射缺席（空表）⇒ 两条腿都不给', () => {
    mountProjection([]);
    expect(resolveErbDimDefinitionAt(PREVIEW_MODEL, pos(4, 4))).toEqual([]);
    expect(resolveErbDimReferencesAt(PREVIEW_MODEL, pos(2, 6))).toEqual([]);
  });

  it('那一格没有源行（`0`）⇒ 两条腿都不给', () => {
    mountProjection([1, 2, 3, 4, 0, 7, 8, 9]);
    expect(resolveErbDimDefinitionAt(PREVIEW_MODEL, pos(5, 2))).toEqual([]);
    expect(resolveErbDimReferencesAt(PREVIEW_MODEL, pos(5, 2))).toEqual([]);
  });

  it('原文 model 取不到 ⇒ 两条腿都不给，且派生面识别本身回 `null`', () => {
    mountProjection(LINE_MAP, null);
    expect(derivedLegSurfaceOf(PREVIEW_MODEL)).toBeNull();
    expect(resolveErbDimDefinitionAt(PREVIEW_MODEL, pos(4, 4))).toEqual([]);
    expect(resolveErbDimReferencesAt(PREVIEW_MODEL, pos(2, 6))).toEqual([]);
  });

  it('登记簿里压根没有这个实例 ⇒ 不给（不拿投影文本凑一个形状）', () => {
    expect(derivedLegSurfaceOf(PREVIEW_MODEL)).toBeNull();
    expect(resolveErbDimDefinitionAt(PREVIEW_MODEL, pos(4, 4))).toEqual([]);
    expect(resolveErbDimReferencesAt(PREVIEW_MODEL, pos(2, 6))).toEqual([]);
  });
});

/* ============================== 原文面逐字不变 ============================== */

describe('原文面 · 一个字节都不碰', () => {
  it('同一份文本挂成 `file:` model ⇒ 两条腿与直接问纯函数**完全同一**', () => {
    expect(derivedLegSurfaceOf(ARCHIVE_MODEL)).toBeNull();
    expect(resolveErbDimDefinitionAt(ARCHIVE_MODEL, pos(7, 3))).toEqual(
      resolveErbDimDefinition(SOURCE_TEXT, 7, 3, ARCHIVE),
    );
    expect(resolveErbDimReferencesAt(ARCHIVE_MODEL, pos(2, 8))).toEqual(
      resolveErbDimReferences(SOURCE_TEXT, 2, 8, ARCHIVE),
    );
  });
});

/* ============================== 装配点 ============================== */

function stubMonaco(): {
  monaco: typeof Monaco;
  definitions: { languageId: string; provider: Monaco.languages.DefinitionProvider }[];
  references: { languageId: string; provider: Monaco.languages.ReferenceProvider }[];
} {
  const definitions: { languageId: string; provider: Monaco.languages.DefinitionProvider }[] = [];
  const references: { languageId: string; provider: Monaco.languages.ReferenceProvider }[] = [];
  const monaco = {
    Uri: { file: (p: string) => ({ toString: () => `file:///${p}`, fsPath: p }) },
    languages: {
      registerDefinitionProvider: (languageId: string, provider: Monaco.languages.DefinitionProvider) => {
        definitions.push({ languageId, provider });
        return { dispose: () => undefined };
      },
      registerReferenceProvider: (languageId: string, provider: Monaco.languages.ReferenceProvider) => {
        references.push({ languageId, provider });
        return { dispose: () => undefined };
      },
    },
    editor: { registerEditorOpener: () => ({ dispose: () => undefined }) },
  };
  return { monaco: monaco as unknown as typeof Monaco, definitions, references };
}

describe('装配点 · 投影面上的 F12 / Shift+F12', () => {
  it('F12：链接落在**原文 model 的源行**，选区是声明名自己的列区间（8..11）', () => {
    mountProjection();
    const { monaco, definitions } = stubMonaco();
    installDefinitionProvider(monaco, {
      // LAU-4 第二步（d0c9c388）之后，`#DIM` / `$` 两条本地腿的判据住在常驻解析器插件，
      // 宿主 provider 只查 `resolve`（生产装配＝`readDefinitionTargets` → 槽）。本用例用
      // 本地腿的投影包装当槽的替身：它交回的正是插件会给出的**源坐标**。
      resolve: (model, position) => resolveErbDimDefinitionAt(model, position),
      navigate: () => undefined,
      openModelFor: (filePath) => (filePath === ARCHIVE ? ARCHIVE_MODEL : undefined),
    });
    const provider = definitions.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    const links = provider.provideDefinition(
      PREVIEW_MODEL,
      pos(4, 4),
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.LocationLink[];
    expect(links).toHaveLength(1);
    expect(links[0]!.uri.toString()).toBe(ARCHIVE_MODEL.uri.toString());
    expect(links[0]!.targetSelectionRange).toEqual({
      startLineNumber: 2,
      startColumn: 8,
      endLineNumber: 2,
      endColumn: 11,
    });
  });

  it('Shift+F12：本地腿交源坐标，`find-references` 折回屏幕上那几行（列仍收行首）', () => {
    mountProjection();
    const { monaco, references } = stubMonaco();
    installReferenceProvider(monaco, {
      // LAU-4 之后宿主不再有本地腿：接的是"位点换算 + 插件判据"这一对（与生产路径同构）
      resolve: (model, position) => resolveErbDimReferencesAt(model, position),
      navigate: () => undefined,
      openModelFor: (filePath) => (filePath === ARCHIVE ? ARCHIVE_MODEL : undefined),
    });
    const provider = references.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    const locations = provider.provideReferences!(
      PREVIEW_MODEL,
      pos(2, 6),
      {} as Monaco.languages.ReferenceContext,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.Location[];
    expect(locations.map((l) => [l.uri.toString(), l.range.startLineNumber, l.range.startColumn])).toEqual([
      [PREVIEW_MODEL.uri.toString(), 2, 1],
      [PREVIEW_MODEL.uri.toString(), 4, 1],
      [PREVIEW_MODEL.uri.toString(), 6, 1],
      [PREVIEW_MODEL.uri.toString(), 7, 1],
    ]);
  });
});
