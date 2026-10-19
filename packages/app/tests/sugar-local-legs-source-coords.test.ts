/**
 * 三条**缓冲区本地腿**（`#DIM` 定义 / `#DIM` 引用 / `$` 标签）在升糖预览面上按**存档坐标**作答
 * （2026-10-20 源坐标批）。
 *
 * 本地腿读的是屏幕上那份缓冲区文本——投影面上就是 `inmemory://sugar/…` 里那串糖。文本没读错，
 * 错的是**交出去的坐标**：投影 URI 上没有文件、预览行号不属于存档，而
 * `mergeSymbolLocations` 把本地腿排在最前、`planDefinitionJump` 的事件通道兜底只取第一枚，
 * 于是"看着对、其实指向派生面"的那一枚把真算出来的源落点顶掉，作者按 F12 得到一次没反应的跳转。
 *
 * 钉四条：
 * ① **换算得出来才交**：投影行 → 存档行 + 存档路径；映射缺席 / 那一格没有源行 ⇒ 这一枚**不交**
 *    （不猜行号，也不留一枚幻影）；
 * ② **列不折算**：投影行与存档行连文本都不是同一串 ⇒ 跨面一律落到行首（`column: 1`、不给 span），
 *    与糖面读类腿（`readDefinitionTargets`）同一个形状，两条腿的去重键才认得出同一处；
 * ③ **原文面逐字不变**：同一份判据在没有投影的那一面一个字段都不碰（列与区间照旧）；
 * ④ **幻影不许从缝里溜出来**：登记簿查不到归属实例的派生 model（实例已退册 / 迟到的请求）⇒ 不应答。
 *
 * 面与映射都由 `composeSugarDoc` 真拼出来（不是手抄表）——整条换算都骑在"文本与映射同批产出"
 * 这条前提上，绕开拼装箱就是绕开它。monaco 运行时不进 node，桩 model / 桩 monaco 照
 * `erb-dim-navigation.test.ts` 那一套。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { EditorSymbolLocation } from '@kojo/plugin-api';
import { composeSugarDoc, type SugarSegmentInput } from '../src/ui/sugar-view';
import { livePanes, type PaneCtx } from '../src/ui/editor-pane-registry';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { installDefinitionProvider } from '../src/monaco/kojo-definition';
import { installReferenceProvider } from '../src/monaco/find-references';
import {
  derivedLegSurfaceOf,
  resolveErbDimDefinition,
  resolveErbDimDefinitionAt,
  resolveErbDimReferencesAt,
  toArchiveCoords,
} from '../src/monaco/erb-dim-navigation';
import {
  labelDefinitionLocations,
  labelReferenceLocations,
  resolveErbLabelScopeAt,
} from '../src/monaco/erb-label-navigation';

/* ============================== 夹具 ============================== */

/** 存档路径（真文件后缀：本地腿的方言闸在投影面上走的就是**这一条**后缀） */
const ARCHIVE = 'C:/game/投影甲.ERB';

/**
 * 存档 12 行：`#DIM` 声明在第 6 行、两处引用 7 / 8、`$NEXT` 在 9、`GOTO NEXT` 在 10。
 */
const SOURCE = [
  '@MAIN',
  '  PRINTL 起手',
  '  IF A',
  '    CALLFOO',
  '  ENDIF',
  '  #DIM 好感度',
  '  好感度 = 1',
  '  好感度 = 2',
  '$NEXT',
  '  GOTO NEXT',
  '  PRINTL 尾巴',
  'RETURN',
];

/**
 * 两段投影：`2..5` 压成 2 行（存档第 3、4 行被吃掉 ⇒ 声明起预览面整体错位），
 * `9..9` 摊成 2 行且**糖行 `$NEXT` 那一格没有源行**（幻影就生在那一行上——
 * 换算不出来的那一枚必须被丢掉，而不是交回投影 URI）。
 */
const SEGMENTS: readonly SugarSegmentInput[] = [
  { fromLine: 2, toLine: 5, sugarText: '如果 A：\n结束：', sourceLines: [2, 5] },
  { fromLine: 9, toLine: 9, sugarText: '$NEXT\n（标签注）', sourceLines: [0, 9] },
];

const COMPOSED = composeSugarDoc([...SOURCE], SEGMENTS);
const PREVIEW = COMPOSED.text.split('\n');
const LINE_MAP = COMPOSED.lineMap;
/** 投影 model 的 URI 路径（`EditorPane` 挂的是 `inmemory://sugar/<组>/<编码路径>`） */
const PROJECTION_URI = `/sugar/pane-1/${encodeURIComponent(ARCHIVE)}`;

/** 桩 model：`scheme` 是真的（`file:` 才有文件可依；`inmemory` 是派生面） */
function fakeModel(lines: readonly string[], uriPath: string, scheme: string): Monaco.editor.ITextModel {
  return {
    uri: {
      scheme,
      fsPath: uriPath,
      path: uriPath,
      toString: () => `${scheme}://${uriPath}`,
    },
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

/** 屏上挂着投影的那个实例档案（`sugarModelRef` / `sugarLineMapRef` / `filePathRef` 全是判据来源） */
function mountProjection(lineMap: readonly number[] = LINE_MAP): PaneCtx {
  const entries = new Map<string, { model: Monaco.editor.ITextModel }>();
  entries.set(ARCHIVE, { model: ARCHIVE_MODEL });
  const pane = {
    paneId: 'sugar-legs',
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

/* ============================== 夹具自证：这面真的不是恒等映射 ============================== */

describe('夹具 · 投影面与映射', () => {
  it('声明 / 标签在预览面上的行号与存档**处处不等**（否则这批钉子测不到换算）', () => {
    expect(LINE_MAP).toEqual([1, 2, 5, 6, 7, 8, 0, 9, 10, 11, 12]);
    expect(PREVIEW[3]).toBe('  #DIM 好感度'); // 预览第 4 行 ⇄ 存档第 6 行
    expect(PREVIEW[6]).toBe('$NEXT'); // 预览第 7 行：**没有源行**
    expect(PREVIEW[8]).toBe('  GOTO NEXT'); // 预览第 9 行 ⇄ 存档第 10 行
    expect(PREVIEW.length).toBe(LINE_MAP.length);
  });
});

/* ============================== 换算判据本身 ============================== */

describe('derivedLegSurfaceOf / toArchiveCoords · 判据只有一份', () => {
  it('原文面 = `null`（直通，一个字段都不碰）；判据认的是 **model 身份**，不是路径', () => {
    // 同一实例正挂着投影，问的却是原文那份 model ⇒ 不许顺手把它也当成派生面折一遍
    mountProjection();
    expect(derivedLegSurfaceOf(ARCHIVE_MODEL)).toBeNull();
    const raw: EditorSymbolLocation[] = [{ filePath: ARCHIVE, line: 6, column: 8, span: { columnStart: 8, columnEnd: 11 } }];
    expect(toArchiveCoords(raw, null)).toEqual(raw);
  });

  it('投影面 = 存档路径 + 「投影行 → 存档行」；映射缺席的那一格回 `null`', () => {
    mountProjection();
    const surface = derivedLegSurfaceOf(PREVIEW_MODEL)!;
    expect(surface.path).toBe(ARCHIVE);
    expect(surface.lineOf(4)).toBe(6);
    expect(surface.lineOf(7)).toBeNull(); // 那一格是投影自己造出来的行
    expect(surface.lineOf(9)).toBe(10);
  });

  it('折不过去的那一枚**整枚丢**，折得过去的分类（`kind`）跟着过桥', () => {
    mountProjection();
    const surface = derivedLegSurfaceOf(PREVIEW_MODEL)!;
    const out = toArchiveCoords(
      [
        { filePath: PROJECTION_URI, line: 4, column: 8, span: { columnStart: 8, columnEnd: 11 }, kind: 'definition' },
        { filePath: PROJECTION_URI, line: 7, column: 2, kind: 'mention' },
        { filePath: PROJECTION_URI, line: 9, column: 8, span: { columnStart: 8, columnEnd: 12 }, kind: 'mention' },
      ],
      surface,
    );
    expect(out).toEqual([
      { filePath: ARCHIVE, line: 6, column: 1, kind: 'definition' },
      { filePath: ARCHIVE, line: 10, column: 1, kind: 'mention' },
    ]);
    expect(out.some((l) => l.filePath === PROJECTION_URI)).toBe(false);
  });

  it('映射缺席（空表）⇒ 一枚都不剩', () => {
    mountProjection([]);
    const surface = derivedLegSurfaceOf(PREVIEW_MODEL)!;
    expect(surface.lineOf(4)).toBeNull();
    expect(toArchiveCoords([{ filePath: PROJECTION_URI, line: 4, column: 1 }], surface)).toEqual([]);
  });
});

/* ============================== 腿①：`#DIM` 声明名的定义腿 ============================== */

describe('#DIM 定义腿 · 投影面按存档坐标作答', () => {
  it('读投影文本、交存档坐标：路径 + 行 + 行首列，没有 span', () => {
    mountProjection();
    expect(resolveErbDimDefinitionAt(PREVIEW_MODEL, pos(5, 3))).toEqual([
      { filePath: ARCHIVE, line: 6, column: 1 },
    ]);
  });

  it('原文面逐字不变：与纯函数的读数**完全同一**（列与区间照旧）', () => {
    const text = SOURCE.join('\n');
    expect(resolveErbDimDefinitionAt(ARCHIVE_MODEL, pos(7, 3))).toEqual(
      resolveErbDimDefinition(text, 7, 3, ARCHIVE),
    );
    expect(resolveErbDimDefinitionAt(ARCHIVE_MODEL, pos(7, 3))[0]!.span).toEqual({
      columnStart: 8,
      columnEnd: 11,
    });
  });

  it('映射缺席 / 那一格没有源行 ⇒ 不交这一枚（绝不落回投影 URI）', () => {
    mountProjection([]);
    expect(resolveErbDimDefinitionAt(PREVIEW_MODEL, pos(5, 3))).toEqual([]);
  });

  it('登记簿查不到归属实例的派生 model ⇒ 一声不吭（幻影不许从这条缝里溜出来）', () => {
    expect(resolveErbDimDefinitionAt(PREVIEW_MODEL, pos(5, 3))).toEqual([]);
    expect(resolveErbDimReferencesAt(PREVIEW_MODEL, pos(4, 8))).toEqual([]);
    expect(resolveErbLabelScopeAt(PREVIEW_MODEL, pos(9, 8))).toBeNull();
  });
});

/* ============================== 腿②：`#DIM` 引用腿 ============================== */

describe('#DIM 引用腿 · 同一条换算，分类不丢', () => {
  it('声明 + 两处引用全折到存档行，`definition` / `mention` 各自跟着过桥', () => {
    mountProjection();
    expect(resolveErbDimReferencesAt(PREVIEW_MODEL, pos(4, 8))).toEqual([
      { filePath: ARCHIVE, line: 6, column: 1, kind: 'definition' },
      { filePath: ARCHIVE, line: 7, column: 1, kind: 'mention' },
      { filePath: ARCHIVE, line: 8, column: 1, kind: 'mention' },
    ]);
  });

  it('原文面逐字不变：行、列、区间与 `kind` 全是投影前那一套', () => {
    const out = resolveErbDimReferencesAt(ARCHIVE_MODEL, pos(6, 8));
    expect(out.map((l) => [l.line, l.column, l.kind])).toEqual([
      [6, 8, 'definition'],
      [7, 3, 'mention'],
      [8, 3, 'mention'],
    ]);
    expect(out[0]!.span).toEqual({ columnStart: 8, columnEnd: 11 });
  });
});

/* ============================== 腿③：`$` 标签腿 ============================== */

describe('$ 标签腿 · 作用域出口就在存档那一侧', () => {
  it('定义落在没有源行的那一格 ⇒ 整枚丢；跳转点照折到存档行（列收到行首、零宽不发 span）', () => {
    mountProjection();
    const scope = resolveErbLabelScopeAt(PREVIEW_MODEL, pos(9, 8))!;
    expect(labelDefinitionLocations(scope)).toEqual([]);
    expect(labelReferenceLocations(scope)).toEqual([
      { filePath: ARCHIVE, line: 10, column: 1, kind: 'mention' },
    ]);
  });

  it('定义行自己也没有源行 ⇒ F12 什么都不交（一次原地不动的假跳转比不跳更坏）', () => {
    mountProjection();
    const scope = resolveErbLabelScopeAt(PREVIEW_MODEL, pos(7, 2))!;
    expect(scope.normalizedName).toBe('NEXT');
    expect(labelDefinitionLocations(scope)).toEqual([]);
  });

  it('原文面逐字不变：出现点的列与区间一个字节都没动', () => {
    const scope = resolveErbLabelScopeAt(ARCHIVE_MODEL, pos(10, 8))!;
    expect(labelDefinitionLocations(scope)).toEqual([
      { filePath: ARCHIVE, line: 9, column: 2, span: { columnStart: 2, columnEnd: 6 }, kind: 'definition' },
    ]);
    expect(labelReferenceLocations(scope)).toEqual([
      { filePath: ARCHIVE, line: 9, column: 2, span: { columnStart: 2, columnEnd: 6 }, kind: 'definition' },
      { filePath: ARCHIVE, line: 10, column: 8, span: { columnStart: 8, columnEnd: 12 }, kind: 'mention' },
    ]);
  });
});

/* ============================== 装配点：幻影不再顶掉真落点 ============================== */

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

describe('装配点 · 投影面上 F12 / Shift+F12 的落点', () => {
  it('本地腿那一枚排在最前，且 URI 与行号都是**存档那一侧**（Peek 落在原文 model 的第 6 行）', () => {
    mountProjection();
    const { monaco, definitions } = stubMonaco();
    installDefinitionProvider(monaco, {
      resolve: () => [],
      navigate: () => undefined,
      openModelFor: (filePath) => (filePath === ARCHIVE ? ARCHIVE_MODEL : undefined),
    });
    const provider = definitions.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    const links = provider.provideDefinition(
      PREVIEW_MODEL,
      pos(5, 3),
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.LocationLink[];
    expect(links).toHaveLength(1);
    expect(links[0]!.uri.toString()).toBe(ARCHIVE_MODEL.uri.toString());
    expect(links[0]!.uri.toString()).not.toContain('sugar');
    expect(links[0]!.targetSelectionRange).toEqual({
      startLineNumber: 6,
      startColumn: 1,
      endLineNumber: 6,
      endColumn: 1,
    });
  });

  it('两条腿在存档坐标上合流：槽腿与本地腿指同一处 ⇒ 去重成一枚（去重键都落在列 1）', () => {
    mountProjection();
    const { monaco, definitions } = stubMonaco();
    installDefinitionProvider(monaco, {
      resolve: () => [{ filePath: ARCHIVE, line: 6, column: 1 }],
      navigate: () => undefined,
      openModelFor: (filePath) => (filePath === ARCHIVE ? ARCHIVE_MODEL : undefined),
    });
    const provider = definitions.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    const links = provider.provideDefinition(
      PREVIEW_MODEL,
      pos(5, 3),
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.LocationLink[];
    expect(links).toHaveLength(1);
  });

  it('没接 `openModelFor` ⇒ 事件通道兜底取的那**第一枚**是存档路径 + 存档行（不是 inmemory）', () => {
    mountProjection();
    const navigated: EditorSymbolLocation[] = [];
    const { monaco, definitions } = stubMonaco();
    installDefinitionProvider(monaco, {
      resolve: () => [],
      navigate: (location) => navigated.push(location),
    });
    const provider = definitions.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    expect(
      provider.provideDefinition(PREVIEW_MODEL, pos(5, 3), {} as Monaco.CancellationToken),
    ).toBeUndefined();
    expect(navigated).toEqual([{ filePath: ARCHIVE, line: 6, column: 1 }]);
  });

  it('Shift+F12 的本地腿同样交存档坐标（`find-references` 一行没改，Peek 就落在原文 model 上）', () => {
    mountProjection();
    const { monaco, references } = stubMonaco();
    installReferenceProvider(monaco, {
      resolve: () => [],
      navigate: () => undefined,
      openModelFor: (filePath) => (filePath === ARCHIVE ? ARCHIVE_MODEL : undefined),
    });
    const provider = references.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    const locations = provider.provideReferences!(
      PREVIEW_MODEL,
      pos(4, 8),
      {} as Monaco.languages.ReferenceContext,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.Location[];
    expect(locations.map((l) => [l.uri.toString(), l.range.startLineNumber, l.range.startColumn])).toEqual([
      [ARCHIVE_MODEL.uri.toString(), 6, 1],
      [ARCHIVE_MODEL.uri.toString(), 7, 1],
      [ARCHIVE_MODEL.uri.toString(), 8, 1],
    ]);
  });

  it('原文面逐字不变：同一条装配腿仍交声明名的**那一列**', () => {
    const { monaco, definitions } = stubMonaco();
    installDefinitionProvider(monaco, {
      resolve: () => [],
      navigate: () => undefined,
      openModelFor: () => ARCHIVE_MODEL,
    });
    const provider = definitions.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    const links = provider.provideDefinition(
      ARCHIVE_MODEL,
      pos(7, 3),
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.LocationLink[];
    expect(links[0]!.targetSelectionRange).toEqual({
      startLineNumber: 6,
      startColumn: 8,
      endLineNumber: 6,
      endColumn: 11,
    });
  });
});
