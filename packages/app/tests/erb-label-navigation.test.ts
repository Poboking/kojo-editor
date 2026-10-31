/**
 * `$` 标签导航（W-2，2026-10-19）：宿主侧作用域读数 + F12 / Shift+F12 接线。
 *
 * 数据源是**当前缓冲区文本**（脏缓冲也正确）：标签是函数局部事实，不依赖项目索引。
 * 覆盖：定义自跳、跳转目标、CJK 名、大小写不敏感、跨函数隔离、`.kojo` 不答、
 * 桩 model 无路径 fail-open，以及两条 provider 的落点区间（span → Monaco Range）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import {
  isErbDefinitionPath,
  labelDefinitionLocations,
  labelReferenceLocations,
  labelScopeAt,
  provideErbDefinition,
  type ErbLabelScope,
} from '@kojo/plugin-erb-parser';
import { livePanes } from '../src/ui/editor-pane-registry';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { installDefinitionProvider } from '../src/monaco/kojo-definition';
import { createReferenceLanding, installReferenceProvider } from '../src/monaco/find-references';
import { derivedLegSurfaceOf, isDerivedModelUri, localLegPointOf } from '../src/monaco/erb-dim-navigation';

/**
 * 生产路径的**同构合成**（LAU-4 引用腿，2026-10-31）：`$` 标签的判据已在解析器插件
 * （`labelScopeAt`），宿主只剩投影面位点换算（`localLegPointOf`）。
 */
function resolveErbLabelScopeAt(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): ErbLabelScope | null {
  const at = localLegPointOf(model, position);
  // 方言闸与供方逐字同源（`erbReferencesAt` 里那条 `isErbDefinitionPath`）
  if (at === null || !isErbDefinitionPath(at.path)) return null;
  return labelScopeAt(at.text, at.path, at.line, at.column);
}

const PATH = String.raw`c:\proj\erb\label.erb`;

/** 3 `$NEXT`｜5 `GOTO NEXT`｜7 `CALL NEXT`（函数调用不是标签）｜8 `@OTHER`｜9 另一函数的 `$NEXT` */
const TEXT = ['@MAIN', '  PRINTL A', '$NEXT', '  PRINTL B', '  GOTO NEXT', '  PRINTL C', '  CALL NEXT', '@OTHER', '$NEXT', '  GOTO NEXT'].join('\n');

function fakeModel(text: string, path: string | null): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  return {
    uri:
      path === null
        ? { toString: () => 'inmemory://model/1' }
        : { fsPath: path, path, toString: () => 'file:///label.erb' },
    getValue: () => text,
    getLineCount: () => lines.length,
    getLineMaxColumn: (n: number) => (lines[n - 1]?.length ?? 0) + 1,
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getWordAtPosition: () => ({ startColumn: 2, endColumn: 6 }),
  } as unknown as Monaco.editor.ITextModel;
}

const at = (lineNumber: number, column: number): Monaco.Position =>
  ({ lineNumber, column }) as Monaco.Position;

describe('$ 标签作用域 · 宿主读数', () => {
  const model = fakeModel(TEXT, PATH);

  it('跳转目标：给出定义与本函数的全部跳转（跨函数同名不混入）', () => {
    const scope = resolveErbLabelScopeAt(model, at(5, 8))!;
    expect(scope.normalizedName).toBe('NEXT');
    expect(scope.occurrences.map((o) => [o.line, o.kind])).toEqual([
      [3, 'definition'],
      [5, 'jump'],
    ]);
    expect(scope.occurrences[0]!.column).toBe(2);
    expect(scope.occurrences[0]!.endColumn).toBe(6);
    expect(scope.occurrences[1]!.column).toBe(8);
    expect(scope.occurrences[1]!.endColumn).toBe(12);
  });

  it('定义行入口：光标在名字内 / 词尾都算；`$` 自身不算', () => {
    expect(resolveErbLabelScopeAt(model, at(3, 2))?.occurrences.length).toBe(2);
    expect(resolveErbLabelScopeAt(model, at(3, 6))?.occurrences.length).toBe(2);
    expect(resolveErbLabelScopeAt(model, at(3, 1))).toBeNull();
  });

  it('非标签入口：CALL 同名 / 字符串 / 注释 / `.kojo` / 无路径 ⇒ null', () => {
    expect(resolveErbLabelScopeAt(model, at(7, 8))).toBeNull();
    expect(resolveErbLabelScopeAt(model, at(2, 4))).toBeNull();
    expect(resolveErbLabelScopeAt(fakeModel(TEXT, 'C:/proj/erb/label.kojo'), at(5, 8))).toBeNull();
    expect(resolveErbLabelScopeAt(fakeModel(TEXT, null), at(5, 8))).toBeNull();
  });

  it('CJK 标签名与大小写不敏感', () => {
    const cjk = fakeModel('@F\n$开始\n\tGOTO 开始\n', PATH);
    expect(resolveErbLabelScopeAt(cjk, at(3, 7))?.normalizedName).toBe('开始');
    const lower = fakeModel('@F\n$Next\n\tgoto next\n', PATH);
    expect(resolveErbLabelScopeAt(lower, at(3, 7))?.occurrences.map((o) => o.name)).toEqual(['Next', 'next']);
  });

  it('落点投影：定义带 kind=definition；跳转记 mention（不是 call）且带 span', () => {
    const scope = resolveErbLabelScopeAt(model, at(5, 8))!;
    expect(labelDefinitionLocations(scope)).toEqual([
      { filePath: PATH, line: 3, column: 2, span: { columnStart: 2, columnEnd: 6 }, kind: 'definition' },
    ]);
    expect(labelReferenceLocations(scope)).toEqual([
      { filePath: PATH, line: 3, column: 2, span: { columnStart: 2, columnEnd: 6 }, kind: 'definition' },
      { filePath: PATH, line: 5, column: 8, span: { columnStart: 8, columnEnd: 12 }, kind: 'mention' },
    ]);
  });
});

/* ============================== provider 接线（桩 monaco） ============================== */

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

describe('$ 标签导航 · provider 接线', () => {
  const model = fakeModel(TEXT, PATH);

  // 宿主不再有本地标签腿（LAU-4 第二步）：定义一律经槽，这里把槽腿直接接成插件供方。
  const slotOf =
    (m: Monaco.editor.ITextModel) =>
    (p: Monaco.Position) =>
      provideErbDefinition(
        { kind: 'definition', path: PATH, text: m.getValue(), line: p.lineNumber, column: p.column, project: null } as never,
        null,
      )!.locations.slice();

  it('F12 在 `$NEXT` 定义名上 → 定义自跳（经槽：供方是插件）', () => {
    const { monaco, definitions } = stubMonaco();
    installDefinitionProvider(monaco, { resolve: (m, p) => slotOf(m)(p), navigate: () => undefined, openModelFor: () => model });
    const provider = definitions.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    const links = provider.provideDefinition(model, at(3, 2), {} as Monaco.CancellationToken) as Monaco.languages.LocationLink[];
    expect(links.map((l) => [l.targetSelectionRange!.startLineNumber, l.targetSelectionRange!.startColumn])).toEqual([[3, 2]]);
  });

  it('F12 在 CJK 跳转目标上 → 槽腿认不出也照样跳到定义（宿主标签腿兜底）', () => {
    const cjk = fakeModel('@F\n$开始\n\tGOTO 开始\n', PATH);
    const { monaco, definitions } = stubMonaco();
    installDefinitionProvider(monaco, {
      resolve: (m, p) =>
        provideErbDefinition(
          { kind: 'definition', path: PATH, text: m.getValue(), line: p.lineNumber, column: p.column, project: null } as never,
          null,
        )!.locations.slice(),
      navigate: () => undefined,
      openModelFor: () => cjk,
    });
    const provider = definitions.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    const links = provider.provideDefinition(cjk, at(3, 7), {} as Monaco.CancellationToken) as Monaco.languages.LocationLink[];
    expect(links.map((l) => l.targetSelectionRange!.startLineNumber)).toEqual([2]);
  });

  it('Shift+F12 → 定义 + 本函数全部跳转（区间来自 span；判据在插件，落点通道在宿主）', () => {
    const { monaco } = stubMonaco();
    // LAU-4 之后宿主不再有本地标签腿、LAU-DUALLEG 车 3 之后宿主腿整条让位（ERB 点名 references）：
    // 判据仍是插件那份（`labelScopeAt`），本用例钉的是剩下的那一半——落点通道。
    const landing = createReferenceLanding(monaco, {
      navigate: () => undefined,
      openModelFor: () => model,
    });
    const locations = landing.land(
      model,
      labelReferenceLocations(resolveErbLabelScopeAt(model, at(5, 8)) ?? { occurrences: [] }),
    );
    expect(locations.map((l) => [l.range.startLineNumber, l.range.startColumn, l.range.endColumn])).toEqual([
      [3, 2, 6],
      [5, 8, 12],
    ]);
    landing.dispose();
  });

  it('fail-open：桩 model 没有路径 ⇒ 两条腿都零贡献，且不抛', () => {
    const bare = fakeModel(TEXT, null);
    const { monaco, definitions, references } = stubMonaco();
    installDefinitionProvider(monaco, { resolve: () => [], navigate: () => undefined, openModelFor: () => bare });
    // 车 3：宿主引用腿不再挂 ERB（点名 ⇒ 让位），接线判据随之下移到通道
    installReferenceProvider(monaco, { resolve: () => [], navigate: () => undefined, openModelFor: () => bare });
    expect(references.map((r) => r.languageId)).not.toContain(ERB_LANGUAGE_ID);
    const landing = createReferenceLanding(monaco, { navigate: () => undefined, openModelFor: () => bare });
    const def = definitions.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    expect(() => def.provideDefinition(bare, at(5, 8), {} as Monaco.CancellationToken)).not.toThrow();
    expect(def.provideDefinition(bare, at(5, 8), {} as Monaco.CancellationToken)).toBeUndefined();
    expect(() => landing.land(bare, [])).not.toThrow();
    expect(landing.land(bare, [])).toEqual([]);
    landing.dispose();
  });
});

/* ============================== 原文面逐字不变（反证，2026-10-20 中文谓词批） ============================== */

/**
 * 这批的修法只许动**派生面**那一条分支。反证姿势：造一份 `scheme: 'file'` 的 model，
 * 让它**与投影夹具一样长、同一批行内容**，但登记表里没有挂着投影的那个实例（等价于
 * `derivedLegSurfaceOf` 回 `null` 的原文面）——于是同一枚位点必须走"读屏幕上这一行 +
 * 用 model 自己的文本 + 位置逐字直通"那条老路，读数与解析器直接问**完全同一**。
 */
describe('标签腿 · 原文面反证（派生面那一条分支一行都不许碰这里）', () => {
  afterEach(() => {
    livePanes.clear();
  });

  /** 与 `sugar-local-legs-source-coords.test.ts` 的投影**同一批行内容**（形状一致、身份不同） */
  const PLAIN_SHOWN = [
    '@MAIN',
    '  PRINTL 起手',
    '如果 A：',
    '  #DIM 好感度',
    '  好感度 = 1',
    '  好感度 = 2',
    '（标签注）',
    '$NEXT',
    '  GOTO NEXT',
    '  PRINTL 尾巴',
    'RETURN',
  ];
  const PLAIN_PATH = 'C:/game/原文面.ERB';
  const PLAIN_TEXT = PLAIN_SHOWN.join('\n');

  /** `scheme: 'file'` 的桩 model（派生面那一份是 `inmemory`，判据就认这一枚） */
  function mountPlain(lines: readonly string[], path: string): Monaco.editor.ITextModel {
    const uri = { scheme: 'file', fsPath: path, path, toString: () => `file:///${path}` };
    return {
      uri,
      getValue: () => lines.join('\n'),
      getLineCount: () => lines.length,
      getLineMaxColumn: (n: number) => (lines[n - 1]?.length ?? 0) + 1,
      getLineContent: (n: number) => lines[n - 1] ?? '',
      getWordAtPosition: () => ({ startColumn: 3, endColumn: 6 }),
    } as unknown as Monaco.editor.ITextModel;
  }

  it('原文面上每一枚位点的读数 = **直接问解析器**（文本 / 行 / 列逐字直通，没有第二份判据）', () => {
    const plain = mountPlain(PLAIN_SHOWN, PLAIN_PATH);
    expect(isDerivedModelUri(plain)).toBe(false);
    // 这一份没有投影挂在屏上 ⇒ 派生面那条分支根本不进（`derivedLegSurfaceOf` 回 `null`）
    expect(derivedLegSurfaceOf(plain)).toBeNull();
    for (const [line, column] of [
      [8, 2],
      [9, 8],
      [9, 12],
      [4, 8],
      [1, 1],
    ] as const) {
      expect(resolveErbLabelScopeAt(plain, at(line, column))).toEqual(
        labelScopeAt(PLAIN_TEXT, PLAIN_PATH, line, column),
      );
    }
  });

  it('原文面上 `$` 定义行照常给作用域（出现点的列与区间属于屏幕上这一行自己）', () => {
    const plain = mountPlain(PLAIN_SHOWN, PLAIN_PATH);
    const scope = resolveErbLabelScopeAt(plain, at(8, 2))!;
    expect(scope.normalizedName).toBe('NEXT');
    expect(labelDefinitionLocations(scope)).toEqual([
      { filePath: PLAIN_PATH, line: 8, column: 2, span: { columnStart: 2, columnEnd: 6 }, kind: 'definition' },
    ]);
    expect(scope.occurrences.some((o) => o.filePath === PLAIN_PATH)).toBe(true);
  });

  it('入口前置闸的名单**一字未改**：中文谓词在原文面上照样不是入口（也不许在 app 层补第二条）', () => {
    const CHINESE = ['@MAIN', '标签 NEXT', '  跳到 NEXT', 'RETURN'].join('\n');
    const plain = mountPlain(CHINESE.split('\n'), PLAIN_PATH);
    expect(resolveErbLabelScopeAt(plain, at(2, 4))).toBeNull(); // `标签 NEXT`
    expect(resolveErbLabelScopeAt(plain, at(3, 5))).toBeNull(); // `跳到 NEXT`
    // 同一个形状闸：`LABEL_ENTRY_RE` 只认原文记号，中文谓词过不了（本批一字未动 ⇒ 原文面行为不变）
    expect(/^\s*(?:\$|(?:JUMP|GOTO|TRYJUMP|TRYGOTO)\b)/i.test('标签 NEXT')).toBe(false);
    expect(labelScopeAt(CHINESE, PLAIN_PATH, 2, 4)).toBeNull();
    // 同一个形状换成原文记号，原文面上照常命中（证明"不答"来自形状，不来自这批的改动）
    const native = mountPlain(['@MAIN', '$NEXT', '  GOTO NEXT', 'RETURN'], PLAIN_PATH);
    expect(resolveErbLabelScopeAt(native, at(3, 8))?.normalizedName).toBe('NEXT');
  });
});
