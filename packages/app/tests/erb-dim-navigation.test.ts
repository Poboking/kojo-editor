/**
 * `#DIM` 声明导航（2026-10-19）：转到定义（F12）与查找引用（Shift+F12）的宿主侧单测。
 *
 * 数据源是**当前缓冲区文本**（不是项目索引）：同文件声明 / 同文件引用都能在脏缓冲上答，
 * 且不依赖项目开闭。覆盖：
 * - 同文件中文名定义命中**列位置**、修饰形（CONST / SAVEDATA / GLOBAL）、数组后缀；
 * - 注释 / 字符串内的同名记号 ⇒ 空数组（非变量位置，不猜）；
 * - 引用列表 = 声明行 + 声明行之外的 2 处（字符串 / 注释不计）；
 * - 路径归一（`String.raw` 的 Windows 反斜杠 vs 正斜杠大写）在合并去重时生效；
 * - provider 接线：F12 返回 `LocationLink`、Shift+F12 返回 `Location[]`，桩 model 无路径 ⇒ fail-open。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { EditorSymbolLocation } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { installDefinitionProvider } from '../src/monaco/kojo-definition';
import { installReferenceProvider } from '../src/monaco/find-references';
import {
  dimDeclarationOf,
  mergeSymbolLocations,
  resolveErbDimDefinition,
  resolveErbDimReferences,
} from '../src/monaco/erb-dim-navigation';

/** 真实语料里的形态：Windows 反斜杠路径（`String.raw` 防 `\\` 被吞） */
const PATH = String.raw`c:\proj\erb\dim.erb`;

/**
 * 行号（1 基）与关键列：
 * 3 `  #DIM 好感度`（名字列 8）      4 `  #DIM CONST 名前 = 1`（14）
 * 5 `  #DIM SAVEDATA 保存値`（17）   6 `  #DIM GLOBAL 全体値`（15）
 * 7 `  好感度 = 1`（3）              8 `  IF 好感度 >= 50`（6）
 * 9 `  PRINTL "好感度"`（字符串内）   10 `  ; 好感度 只在注释里`（注释内）
 */
const TEXT = [
  '; 头注释：好感度 不是变量',
  '@MAIN',
  '  #DIM 好感度',
  '  #DIM CONST 名前 = 1',
  '  #DIM SAVEDATA 保存値',
  '  #DIM GLOBAL 全体値',
  '  好感度 = 1',
  '  IF 好感度 >= 50',
  '  PRINTL "好感度"',
  '  ; 好感度 只在注释里',
  '  名前 = 2',
  '  保存値 = 3',
  '  全体値 = 4',
  '  未知 = 9',
  '@END',
].join('\n');

describe('#DIM 转到定义 · 同文件优先', () => {
  it('中文名：正文里的名字 → 声明行 + 声明名的列位置（不是行首）', () => {
    const out = resolveErbDimDefinition(TEXT, 7, 3, PATH);
    expect(out).toEqual([
      {
        filePath: PATH,
        line: 3,
        column: 8,
        span: { columnStart: 8, columnEnd: 11 },
      },
    ]);
  });

  it('修饰形 `#DIM CONST` / `#DIM SAVEDATA` / `#DIM GLOBAL` 都命中，列越过修饰词', () => {
    expect(resolveErbDimDefinition(TEXT, 11, 3, PATH)).toEqual([
      { filePath: PATH, line: 4, column: 14, span: { columnStart: 14, columnEnd: 16 } },
    ]);
    expect(resolveErbDimDefinition(TEXT, 12, 3, PATH)).toEqual([
      { filePath: PATH, line: 5, column: 17, span: { columnStart: 17, columnEnd: 20 } },
    ]);
    expect(resolveErbDimDefinition(TEXT, 13, 3, PATH)).toEqual([
      { filePath: PATH, line: 6, column: 15, span: { columnStart: 15, columnEnd: 18 } },
    ]);
  });

  it('`#DIMS` 数组后缀（`名字[10]`）不并入名字：光标在 `名字` 上仍命中声明', () => {
    const text = ['  #DIM 配列[10]', '  配列[0] = 1'].join('\n');
    expect(resolveErbDimDefinition(text, 2, 3, PATH)).toEqual([
      { filePath: PATH, line: 1, column: 8, span: { columnStart: 8, columnEnd: 10 } },
    ]);
    expect(dimDeclarationOf('  #DIM 配列[10]')).toEqual({ directive: 'DIM', name: '配列', nameStart: 7 });
  });

  it('名字不存在 ⇒ 空数组（不猜、不抛）', () => {
    expect(resolveErbDimDefinition(TEXT, 14, 3, PATH)).toEqual([]);
    expect(resolveErbDimDefinition(TEXT, 999, 3, PATH)).toEqual([]);
    expect(resolveErbDimDefinition(TEXT, 0, 3, PATH)).toEqual([]);
  });

  it('非变量位置：字符串内 / 注释内 / 被注释掉的声明 ⇒ 空数组', () => {
    expect(resolveErbDimDefinition(TEXT, 9, 11, PATH)).toEqual([]); // PRINTL "好感度"
    expect(resolveErbDimDefinition(TEXT, 10, 5, PATH)).toEqual([]); // ; 好感度 只在注释里
    const commented = ['  ; #DIM 幽灵', '  幽灵 = 1'].join('\n');
    expect(resolveErbDimDefinition(commented, 2, 3, PATH)).toEqual([]);
  });

  it('fail-open：路径缺席 / `.kojo` / 空文本 ⇒ 空数组', () => {
    expect(resolveErbDimDefinition(TEXT, 7, 3, null)).toEqual([]);
    expect(resolveErbDimDefinition(TEXT, 7, 3, 'C:/proj/erb/dim.kojo')).toEqual([]);
    expect(resolveErbDimDefinition('', 1, 1, PATH)).toEqual([]);
  });
});

describe('#DIM 查找引用 · 只在本文件', () => {
  it('声明名上 Shift+F12：声明行 + 声明行之外的 2 处（字符串 / 注释不计）', () => {
    const out = resolveErbDimReferences(TEXT, 3, 8, PATH);
    expect(out.map((l) => l.line)).toEqual([3, 7, 8]);
    expect(out.map((l) => l.column)).toEqual([8, 3, 6]);
    expect(out.map((l) => l.kind)).toEqual(['definition', 'mention', 'mention']);
    expect(out[0]!.span).toEqual({ columnStart: 8, columnEnd: 11 });
  });

  it('光标不在声明名上 ⇒ 空数组（任意变量位置不猜引用）', () => {
    expect(resolveErbDimReferences(TEXT, 7, 3, PATH)).toEqual([]); // 正文里的同名引用
    expect(resolveErbDimReferences(TEXT, 3, 2, PATH)).toEqual([]); // `#DIM` 关键字上
    expect(resolveErbDimReferences(TEXT, 999, 8, PATH)).toEqual([]);
    expect(resolveErbDimReferences(TEXT, 3, 8, null)).toEqual([]);
  });

  it('成员访问（`FLAG:好感度`）不算变量引用', () => {
    const text = ['  #DIM 好感度', '  FLAG:好感度 = 1'].join('\n');
    expect(resolveErbDimReferences(text, 1, 8, PATH).map((l) => l.line)).toEqual([1]);
  });
});

describe('#DIM 位置合并 · 路径归一', () => {
  it('`c:\\proj\\erb\\dim.erb` 与 `C:/proj/ERB/DIM.ERB` 是同一处：只留一份', () => {
    const dim = (filePath: string): EditorSymbolLocation => ({
      filePath,
      line: 3,
      column: 8,
      span: { columnStart: 8, columnEnd: 11 },
      kind: 'definition',
    });
    expect(mergeSymbolLocations([dim(PATH)], [dim('C:/proj/ERB/DIM.ERB')])).toEqual([dim(PATH)]);
  });

  it('同处先到者没区间、后到者有时补上区间（与 definition / references 两条合并腿同口径）', () => {
    const merged = mergeSymbolLocations(
      [{ filePath: PATH, line: 3, column: 8 }],
      [{ filePath: 'C:/PROJ/ERB/DIM.ERB', line: 3, column: 8, span: { columnStart: 8, columnEnd: 11 } }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.span).toEqual({ columnStart: 8, columnEnd: 11 });
  });
});

/* ============================== provider 接线（桩 monaco） ============================== */

function fakeModel(path: string | null): Monaco.editor.ITextModel {
  const lines = TEXT.split('\n');
  return {
    uri: path === null ? { toString: () => 'inmemory://model/1' } : { fsPath: path, path: path, toString: () => 'file:///dim.erb' },
    getValue: () => TEXT,
    getLineCount: () => lines.length,
    getLineMaxColumn: (n: number) => (lines[n - 1]?.length ?? 0) + 1,
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getWordAtPosition: () => ({ startColumn: 3, endColumn: 6 }),
  } as unknown as Monaco.editor.ITextModel;
}

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

describe('#DIM 导航 · provider 接线', () => {
  const model = fakeModel(PATH);
  const position = { lineNumber: 7, column: 3 } as Monaco.Position;

  it('F12：返回真 `LocationLink`，选区落在声明名的列区间（同文件就地跳）', () => {
    const { monaco, definitions } = stubMonaco();
    installDefinitionProvider(monaco, {
      resolve: () => [],
      navigate: () => undefined,
      openModelFor: () => model,
    });
    const provider = definitions.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    const links = provider.provideDefinition(model, position, {} as Monaco.CancellationToken) as Monaco.languages.LocationLink[];
    expect(links).toHaveLength(1);
    expect(links[0]!.targetSelectionRange).toEqual({
      startLineNumber: 3,
      startColumn: 8,
      endLineNumber: 3,
      endColumn: 11,
    });
  });

  it('Shift+F12：同一条管线返回 3 处（声明 + 2 处引用）', () => {
    const { monaco, references } = stubMonaco();
    installReferenceProvider(monaco, {
      resolve: () => [],
      navigate: () => undefined,
      openModelFor: () => model,
    });
    const provider = references.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    const locations = provider.provideReferences!(
      model,
      { lineNumber: 3, column: 8 } as Monaco.Position,
      {} as Monaco.languages.ReferenceContext,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.Location[];
    expect(locations.map((l) => l.range.startLineNumber)).toEqual([3, 7, 8]);
    expect(locations.map((l) => l.range.startColumn)).toEqual([8, 3, 6]);
  });

  it('fail-open：桩 model 没有 fsPath / path ⇒ 两条腿都零贡献，且不抛', () => {
    const { monaco, definitions, references } = stubMonaco();
    installDefinitionProvider(monaco, { resolve: () => [], navigate: () => undefined, openModelFor: () => model });
    installReferenceProvider(monaco, { resolve: () => [], navigate: () => undefined, openModelFor: () => model });
    const bare = fakeModel(null);
    const def = definitions.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    const ref = references.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    expect(() => def.provideDefinition(bare, position, {} as Monaco.CancellationToken)).not.toThrow();
    expect(def.provideDefinition(bare, position, {} as Monaco.CancellationToken)).toBeUndefined();
    expect(
      ref.provideReferences!(bare, position, {} as Monaco.languages.ReferenceContext, {} as Monaco.CancellationToken),
    ).toEqual([]);
  });
});
