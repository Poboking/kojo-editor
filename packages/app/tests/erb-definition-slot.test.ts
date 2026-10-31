/**
 * **经槽拿到 ERB 定义**：宿主读类腿 → `ui.editor.languageService` 槽 → 插件供方 → 落点
 * （LAU-4 第二步，2026-10-30）。
 *
 * 这一条是"宿主不再有 ERB 本地定义腿"的正向判据：`installDefinitionProvider` 注入的
 * `resolve` 就是 `readDefinitionTargets`，而它**只查槽**——`#DIM` 声明名与 `$` 标签名能跳，
 * 只可能是因为插件 `@kojo/plugin-erb-parser` 的 `erb-definition` 供方答了
 * （`provideErbDefinition`：标签作用域在解析器、`#DIM` 纯判据在语言面库）。
 *
 * 钉六条：
 * 1. 原文面：`#DIM` 正文里的名字 → 声明行 + **名字那一列**；`$` 标签 → 定义行；
 * 2. 优先序：同一记号声明与函数索引都给 ⇒ 声明在前、函数腿在后（供方内部次序，不是槽序）；
 * 3. 投影面（升糖预览）：发问位点按**行尾对齐**换成存档列（不是收行首），落点仍是存档坐标；
 * 4. 投影面的中文谓词行（`跳到 开始`）：槽腿的 ASCII 记号集认不出，插件照样答得出；
 * 5. 源码卫生：宿主 `monaco/kojo-definition.ts` 不再 import 那两条本地腿；
 * 6. （LAU-DUALLEG 第二车）实现腿的覆盖自证：`readImplementationTargets` 发的是自己的 `kind`，
 *    而同一枚供方交回的落点与 `definition` 逐字相同 ⇒ "ERB 两 kind 已齐"这一条在这里有正向
 *    证据，`language-parity.test.ts` 的 DOUBLE-LEG-1032B 组才判得下"不收敛"。
 *
 * monaco 运行时不进 node ⇒ `../src/monaco/entry` 用 `vi.mock` 桩掉（形状照
 * `editor-global-providers-tables.test.ts`：任意属性链都是可调用的代理，调用即回一枚可拆的
 * 假 disposable）。登记簿 / 糖面拼装 / 桩 model 照 `erb-dim-source-text.test.ts` 那一套。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { functionLookupOf } from '@kojo/plugin-api';
import type { EditorLanguageServiceContribution, EditorLanguageServiceRequest, ErbIndex } from '@kojo/plugin-api';
import { provideErbDefinition } from '@kojo/plugin-erb-parser';
import { composeSugarDoc, type SugarSegmentInput } from '../src/ui/sugar-view';
import { livePanes, type PaneCtx } from '../src/ui/editor-pane-registry';

const stub = vi.hoisted(() => {
  /** 万能桩：任意属性链都是「可调用 / 可 new」的代理；调用回一枚可拆的假 disposable */
  const universal = (path: string): unknown =>
    new Proxy(function kojoMonacoStub() {}, {
      get: (_target, key) =>
        typeof key === 'symbol' || key === 'then' ? undefined : universal(`${path}.${String(key)}`),
      apply: () => ({ dispose: () => undefined }),
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

// 动态 import：保证上面的桩先就位（本模块 import 期就会碰 monaco 运行时）
const { readDefinitionTargets, readImplementationTargets } = await import('../src/ui/editor-global-providers');

/* ============================== 夹具 ============================== */

const ARCHIVE = 'C:/game/经槽.ERB';

/** 存档 9 行：`#DIM 好感度` 在 2、声明名第 8 列；`$开始` 在 6；引用行 3 / 4 / 7 / 8 */
const SOURCE = [
  '@MAIN',
  '  #DIM 好感度',
  '  好感度 = 1',
  '  IF 好感度 >= 50',
  '    PRINTL 高',
  '  ENDIF',
  '$开始',
  '  GOTO 开始',
  'RETURN',
];

/**
 * 两段投影（`composeSugarDoc` 真拼，不手抄表）：
 * - `2..2` → `声明数组 好感度`（`#DIM` 被中文谓词换掉 ⇒ 拿投影文本扫声明恒 0 命中）；
 * - `7..8` → `标签 开始` + `跳到 开始`（`$` / `GOTO` 也被换掉 ⇒ `labelScopeAt` 同理）。
 */
const SEGMENTS: readonly SugarSegmentInput[] = [
  { fromLine: 2, toLine: 2, sugarText: '声明数组 好感度', sourceLines: [2] },
  { fromLine: 4, toLine: 4, sugarText: '如果 好感度 >= 50', sourceLines: [4] },
  { fromLine: 7, toLine: 8, sugarText: '标签 开始\n跳到 开始', sourceLines: [7, 8] },
];

const COMPOSED = composeSugarDoc([...SOURCE], SEGMENTS);
const PREVIEW = COMPOSED.text.split('\n');
const LINE_MAP = COMPOSED.lineMap;
const PROJECTION_URI = `/sugar/pane-1/${encodeURIComponent(ARCHIVE)}`;

/** 桩 model：`scheme` 是真的；`getLanguageId` / `getVersionId` 必须给（PITFALLS 157） */
function fakeModel(
  lines: readonly string[],
  uriPath: string,
  scheme: string,
  languageId = 'kojo-erb',
): Monaco.editor.ITextModel {
  return {
    uri: { scheme, fsPath: uriPath, path: uriPath, toString: () => `${scheme}://${uriPath}` },
    getValue: () => lines.join('\n'),
    getLineCount: () => lines.length,
    getLineMaxColumn: (n: number) => (lines[n - 1]?.length ?? 0) + 1,
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getWordAtPosition: () => ({ startColumn: 3, endColumn: 6 }),
    getLanguageId: () => languageId,
    getVersionId: () => 7,
  } as unknown as Monaco.editor.ITextModel;
}

const ARCHIVE_MODEL = fakeModel(SOURCE, ARCHIVE, 'file');
const PREVIEW_MODEL = fakeModel(PREVIEW, PROJECTION_URI, 'inmemory');

const pos = (lineNumber: number, column: number): Monaco.Position =>
  ({ lineNumber, column }) as unknown as Monaco.Position;

/** 屏上挂着投影的那个实例档案（映射与原文全靠它） */
function mountProjection(): PaneCtx {
  return mountPane(PREVIEW_MODEL, LINE_MAP);
}

/** 原文面：同一实例屏上挂的是**原文** model，没有投影（`sugarModelRef` = null） */
function mountRaw(): PaneCtx {
  return mountPane(null, []);
}

function mountPane(shown: Monaco.editor.ITextModel | null, lineMap: readonly number[]): PaneCtx {
  const entries = new Map<string, { model: Monaco.editor.ITextModel }>([[ARCHIVE, { model: ARCHIVE_MODEL }]]);
  const pane = {
    paneId: 'definition-slot',
    filePathRef: { current: ARCHIVE },
    editorRef: {
      current: { getModel: () => (shown ?? ARCHIVE_MODEL) } as unknown as Monaco.editor.IStandaloneCodeEditor,
    },
    sugarModelRef: { current: shown },
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

/** 真插件里那条贡献（`order = 20`，与生产同权；`definitionTargetsAt` 只读 `byName`） */
function contributions(
  asks: EditorLanguageServiceRequest[],
  index: ErbIndex | null = null,
): EditorLanguageServiceContribution[] {
  return [
    {
      id: 'erb-definition',
      order: 20,
      provide: (request: EditorLanguageServiceRequest) => {
        asks.push(request);
        return provideErbDefinition(request, index);
      },
    } as unknown as EditorLanguageServiceContribution,
  ];
}

/** 只带 `byName` 的函数索引（`definitionTargetsAt` 的函数腿只读这一格） */
function indexWith(name: string, filePath: string, startLine: number, column?: number): ErbIndex {
  return {
    byName: functionLookupOf([
      [
        name.toUpperCase(),
        [{ name, normalizedName: name.toUpperCase(), filePath, startLine, endLine: startLine, ...(column === undefined ? {} : { nameColumn: column }) }],
      ],
    ]),
  } as unknown as ErbIndex;
}

const kernelOf = (items: EditorLanguageServiceContribution[]) =>
  ({
    project: { current: () => null },
    slots: { query: () => items },
  }) as never;

/* ============================== 夹具自证 ============================== */

describe('夹具 · 投影把两处原生记号都换成了中文谓词', () => {
  it('`#DIM` / `$` / `GOTO` 在投影上一次都不出现，行号与存档分叉', () => {
    expect(SOURCE[1]).toBe('  #DIM 好感度');
    expect(SOURCE[3]).toBe('  IF 好感度 >= 50');
    expect(PREVIEW[1]).toBe('声明数组 好感度'); // 预览第 2 行 ⇄ 存档第 2 行
    expect(PREVIEW[3]).toBe('如果 好感度 >= 50'); // 预览第 4 行 ⇄ 存档第 4 行
    expect(PREVIEW[6]).toBe('标签 开始'); // 预览第 7 行 ⇄ 存档第 7 行
    expect(PREVIEW[7]).toBe('跳到 开始'); // 预览第 8 行 ⇄ 存档第 8 行
    expect(COMPOSED.text).not.toContain('#DIM');
    expect(COMPOSED.text).not.toContain('GOTO');
    expect(PREVIEW.length).toBe(LINE_MAP.length);
  });
});

/* ============================== ① 原文面 ============================== */

describe('经槽拿定义 · 原文面', () => {
  it('`#DIM` 正文里的名字 → 声明行 + 名字那一列（供方是插件，宿主没本地腿）', () => {
    mountRaw();
    const asks: EditorLanguageServiceRequest[] = [];
    const at = readDefinitionTargets(ARCHIVE_MODEL, pos(3, 3), kernelOf(contributions(asks)));
    expect(at).toEqual([
      { filePath: ARCHIVE, line: 2, column: 8, span: { columnStart: 8, columnEnd: 11 } },
    ]);
    expect(asks.map((r) => r.kind)).toEqual(['definition']);
  });

  it('`$` 标签跳转目标（CJK） → 定义行（槽腿的 ASCII 记号集认不出中文）', () => {
    mountRaw();
    const at = readDefinitionTargets(ARCHIVE_MODEL, pos(8, 8), kernelOf(contributions([])));
    expect(at).toEqual([
      { filePath: ARCHIVE, line: 7, column: 2, span: { columnStart: 2, columnEnd: 4 }, kind: 'definition' },
    ]);
  });

  it('同名 `#DIM` 与函数索引都存在 ⇒ 声明排在函数之前（供方内部序：标签 → 声明 → 函数）', () => {
    mountRaw();
    const at = readDefinitionTargets(
      ARCHIVE_MODEL,
      pos(3, 3),
      kernelOf(contributions([], indexWith('好感度', ARCHIVE, 9, 1))),
    );
    expect(at.map((l) => l.line)).toEqual([2, 9]);
  });

  /**
   * **实现腿的覆盖自证**（LAU-DUALLEG 第二车，2026-10-31）：这一格是"两 kind 是否已齐"的证据，
   * 不是第二份判据。`Ctrl+F12` 与 `F12` 各发自己的判别式（宿主不替语言决定"实现"是什么），
   * 而 ERB 的**同一枚** `provideErbDefinition` 答两个 kind ⇒ 落点与优先序必须逐字相同：
   * 只要这一条成立，宿主就没有"让位给一枚没供方的腿"可收（分叉才是必须收敛的病）。
   */
  it('`implementation` 由同一枚供方作答：请求各发各的 kind，落点与 `definition` 逐字相同', () => {
    mountRaw();
    const asks: EditorLanguageServiceRequest[] = [];
    const kernel = kernelOf(contributions(asks, indexWith('好感度', ARCHIVE, 9, 1)));
    const definition = readDefinitionTargets(ARCHIVE_MODEL, pos(3, 3), kernel);
    const implementation = readImplementationTargets(ARCHIVE_MODEL, pos(3, 3), kernel);
    expect(asks.map((r) => r.kind)).toEqual(['definition', 'implementation']);
    expect(implementation).toEqual(definition);
    // 三条腿的序也在实现腿上成立（标签 → `#DIM` 声明 → 函数索引）
    expect(implementation.map((l) => l.line)).toEqual([2, 9]);
  });
});

/* ============================== ② 投影面 ============================== */

describe('经槽拿定义 · 投影面按行尾对齐换列', () => {
  it('预览的引用行 ⇒ 发问位点是**存档列**（不是行首），落点仍是存档行', () => {
    mountProjection();
    const asks: EditorLanguageServiceRequest[] = [];
    const at = readDefinitionTargets(PREVIEW_MODEL, pos(4, 4), kernelOf(contributions(asks)));
    // `如果 好感度` 第 4 列 ⇄ `  IF 好感度` 第 6 列：按"离行尾多远"对齐
    const aligned = SOURCE[3]!.length - PREVIEW[3]!.length + 4;
    expect(aligned).toBe(6);
    expect(asks.at(-1)).toMatchObject({ line: 4, column: aligned });
    // 同文件的落点经 `foldLocationsToPreview` 折到预览面（列收行首，行仍是存档行）
    expect(at).toEqual([{ filePath: ARCHIVE, line: 2, column: 1 }]);
  });

  it('中文谓词行（`跳到 开始`）⇒ 插件照样答得出，折回后是存档第 7 行', () => {
    mountProjection();
    const asks: EditorLanguageServiceRequest[] = [];
    const at = readDefinitionTargets(PREVIEW_MODEL, pos(8, 4), kernelOf(contributions(asks)));
    // `跳到 开始` 第 4 列 ⇄ 存档第 7 行 `  GOTO 开始` 第 8 列（同样是行尾对齐）
    const aligned = SOURCE[7]!.length - PREVIEW[7]!.length + 4;
    expect(aligned).toBe(8);
    expect(asks.at(-1)).toMatchObject({ line: 8, column: aligned });
    expect(at).toEqual([{ filePath: ARCHIVE, line: 7, column: 1, kind: 'definition' }]);
  });

  it('光标停在中文谓词上 ⇒ 位点对不到名字，一枚都不给（不猜）', () => {
    mountProjection();
    const at = readDefinitionTargets(PREVIEW_MODEL, pos(2, 2), kernelOf(contributions([])));
    expect(at).toEqual([]);
  });
});

/* ============================== ③ 源码卫生 ============================== */

/** 读仓库内源码（`fileURLToPath`：中文路径的 checkout 必须还原，见 PITFALLS 172） */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const sourceOf = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('源码卫生 · 宿主定义 provider 不再持有 ERB 本地腿', () => {
  it('`monaco/kojo-definition.ts` 不 import `erb-dim-navigation` / `erb-label-navigation`', () => {
    const src = sourceOf('packages/app/src/monaco/kojo-definition.ts');
    expect(src).not.toMatch(/from\s+'\.\/erb-dim-navigation'/);
    expect(src).not.toMatch(/from\s+'\.\/erb-label-navigation'/);
    // 反向自证：同一份源码里确实还有那条"只查槽"的腿（判据不是空匹配）
    expect(src).toMatch(/provideLocations\(handlers, findModel, model, position\)/);
  });
});