/**
 * `#DIM` 声明导航（2026-10-19）：转到定义（F12）与查找引用（Shift+F12）的宿主侧单测。
 *
 * 数据源是**当前缓冲区文本**（不是项目索引）：同文件声明 / 同文件引用都能在脏缓冲上答，
 * 且不依赖项目开闭。覆盖：
 * - 同文件中文名定义命中**列位置**、修饰形（CONST / SAVEDATA / GLOBAL）、数组后缀；
 * - 注释 / 字符串内的同名记号 ⇒ 空数组（非变量位置，不猜）；
 * - 引用列表 = 声明行 + 声明行之外的 2 处（字符串 / 注释不计）；
 * - 路径归一（`String.raw` 的 Windows 反斜杠 vs 正斜杠大写）在合并去重时生效；
 * - provider 接线：F12 返回 `LocationLink`、Shift+F12 返回 `Location[]`，桩 model 无路径 ⇒ fail-open
 *   （LAU-DUALLEG 车 3 之后 ERB 的 `references` 由槽腿应答，宿主这一侧的接线判据就是落点通道
 *   `createReferenceLanding` —— 判据仍是插件那份 `erbDimReferencesAt`，两半的分工在这里测）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { EditorSymbolLocation } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { installDefinitionProvider } from '../src/monaco/kojo-definition';
import { createReferenceLanding, installReferenceProvider } from '../src/monaco/find-references';
import {
  dimDeclarationOf,
  mergeNavigationLegs,
  mergeSymbolLocations,
  resolveErbDimDefinition,
} from '../src/monaco/erb-dim-navigation';
// LAU-4 引用腿（2026-10-31）：判据在插件，宿主的 provider 只翻形状
import { erbDimReferencesAt as resolveErbDimReferences } from '@kojo/plugin-erb-parser';

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

/**
 * F12-TOKEN（2026-10-19）③：**同一位置多条腿的优先序只住在一枚函数里**。
 *
 * 取词尺放宽到 Unicode 之后，"中文 `#DIM` 声明名"与"中文函数名"第一次会在**同一个点位**
 * 上各自答出一份（语料里 `充填率` / `睡眠時間` 这类名字既是基础库函数、也常被作者拿来当
 * 声明名）。此前这条序是两条宿主腿各写两遍 `if`（definition 与 find-references 各一份
 * 嵌套），漏改一处就会让 F12 与 `Shift+F12` 对同一个点位给出不同的第一落点。
 * 现在序 = `mergeNavigationLegs(标签, 声明, 槽)`，两条腿共用水这一枚函数。
 */
describe('多条腿的优先序 · mergeNavigationLegs（标签 > 声明 > 槽）', () => {
  const loc = (line: number, column: number, kind: 'definition' | 'call' | 'mention'): EditorSymbolLocation => ({
    filePath: PATH,
    line,
    column,
    span: { columnStart: column, columnEnd: column + 3 },
    kind,
  });
  const label = loc(3, 8, 'definition');
  const dim = loc(4, 8, 'definition');
  const slot = [loc(3, 8, 'definition'), loc(9, 6, 'call')];

  it('三腿齐给 ⇒ 标签在前、声明次之、槽腿在后（事件通道兜底跳的就是第一枚）', () => {
    expect(mergeNavigationLegs([label], [dim], slot).map((l) => `${l.line}:${l.column}`)).toEqual([
      '3:8',
      '4:8',
      '9:6',
    ]);
  });

  it('标签与槽腿指的是同一处（路径两种写法）⇒ 折成一枚并保住区间；不同处两枚都在', () => {
    const merged = mergeNavigationLegs(
      [loc(3, 8, 'definition')],
      [],
      [
        { filePath: 'C:/PROJ/ERB/DIM.ERB', line: 3, column: 8 },
        { filePath: 'C:/PROJ/ERB/DIM.ERB', line: 9, column: 6 },
      ],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]!.span).toEqual({ columnStart: 8, columnEnd: 11 }); // 同处取带区间的那一枚
    expect(merged[1]!.line).toBe(9); // 另一处不许被"优先序"折掉
  });

  it('两条本地腿都零贡献 ⇒ 槽腿原样交付（优先序不许吞掉项目索引的结果）', () => {
    expect(mergeNavigationLegs([], [], slot)).toEqual(slot);
    expect(mergeNavigationLegs([], [], [])).toEqual([]);
  });

  it('provider 端到端：槽腿把声明腿排在函数索引腿之前 ⇒ 两枚都在、顺序由供方定', () => {
    const { monaco, definitions } = stubMonaco();
    // 供方（插件）的返回序就是槽的返回序：声明在前、函数索引腿在后
    const slotFromIndex: EditorSymbolLocation[] = [
      { filePath: PATH, line: 3, column: 8, span: { columnStart: 8, columnEnd: 11 }, kind: 'definition' },
      { filePath: PATH, line: 12, column: 2, span: { columnStart: 2, columnEnd: 5 }, kind: 'definition' },
    ];
    installDefinitionProvider(monaco, {
      resolve: () => slotFromIndex,
      navigate: () => undefined,
      openModelFor: () => fakeModel(PATH),
    });
    const provider = definitions.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    // 第 7 行 `  好感度 = 1`：本文件 `#DIM` 声明腿命中，槽腿也给一份 ⇒ 声明在前
    const links = provider.provideDefinition(
      fakeModel(PATH),
      { lineNumber: 7, column: 3 } as Monaco.Position,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.LocationLink[];
    expect(links.map((l) => l.targetSelectionRange?.startLineNumber)).toEqual([3, 12]);
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
      // 定义一律经槽（宿主没有本地腿）：这里接插件供方在原位点上的答案
      resolve: () => [{ filePath: PATH, line: 3, column: 8, span: { columnStart: 8, columnEnd: 11 }, kind: 'definition' }],
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

  it('Shift+F12：同一条管线返回 3 处（声明 + 2 处引用；判据在插件，落点通道在宿主）', () => {
    const { monaco } = stubMonaco();
    // LAU-4 之后宿主不再有本地腿、LAU-DUALLEG 车 3 之后宿主腿整条让位（ERB 点名 references）：
    // ERB 的引用由槽腿应答，而"引用点 → 屏幕上那一行"这一半是宿主通道
    // （生产装配点把它同时接到槽腿的 `SlotServiceHost.landReferences`）。
    const landing = createReferenceLanding(monaco, {
      navigate: () => undefined,
      openModelFor: () => model,
    });
    const locations = landing.land(
      model,
      // 判据仍是插件那份（与生产路径逐字同源）：`resolveErbDimReferences` = `erbReferencesAt` 的声明腿
      resolveErbDimReferences(TEXT, 3, 8, PATH),
    );
    expect(locations.map((l) => l.range.startLineNumber)).toEqual([3, 7, 8]);
    expect(locations.map((l) => l.range.startColumn)).toEqual([8, 3, 6]);
    landing.dispose();
  });

  it('fail-open：桩 model 没有 fsPath / path ⇒ 两条腿都零贡献，且不抛', () => {
    const { monaco, definitions, references } = stubMonaco();
    installDefinitionProvider(monaco, { resolve: () => [], navigate: () => undefined, openModelFor: () => model });
    // 车 3 之后宿主腿不再挂 ERB ⇒ 引用那一侧的接线判据落在通道上（同一条 fail-open 判据）
    installReferenceProvider(monaco, { resolve: () => [], navigate: () => undefined });
    expect(references.map((r) => r.languageId)).not.toContain(ERB_LANGUAGE_ID);
    const landing = createReferenceLanding(monaco, { navigate: () => undefined, openModelFor: () => model });
    const bare = fakeModel(null);
    const def = definitions.find((r) => r.languageId === ERB_LANGUAGE_ID)!.provider;
    expect(() => def.provideDefinition(bare, position, {} as Monaco.CancellationToken)).not.toThrow();
    expect(def.provideDefinition(bare, position, {} as Monaco.CancellationToken)).toBeUndefined();
    expect(() => landing.land(bare, [])).not.toThrow();
    expect(landing.land(bare, [])).toEqual([]);
    landing.dispose();
  });
});
