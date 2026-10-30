/**
 * 本地名字落点判据的单测（LAU-4 第二步；2026-10-30 定稿批从 `@kojo/erb-lang/definition`
 * 折回本插件的 `src/symbols.ts`，用例逐条跟过来、期望值一字未改）。
 *
 * 数据源是**文本**而不是项目索引——同文件声明 / 引用在脏缓冲上也答，且与项目开闭无关。覆盖：
 * - 同文件中文名定义命中**列位置**、修饰形（CONST / SAVEDATA / GLOBAL）、数组后缀；
 * - 注释 / 字符串内的同名记号 ⇒ 空数组（非变量位置，不猜）；
 * - 查找引用那条腿（`resolveErbDimReferences`）随 Shift+F12 装配留在宿主，其用例在
 *   `packages/app/tests/erb-dim-navigation.test.ts`；
 * - `$` 标签**落点投影**（出现 → 落点；作用域读数在 `definition-locals.test.ts`）；
 * - 路径归一（Windows 反斜杠 vs 正斜杠大写）在合并去重时生效；
 * - 合并优先序（标签 > 声明 > 槽）只住一枚函数。
 */

import { describe, expect, it } from 'vitest';
import type { EditorSymbolLocation } from '@kojo/plugin-api';
import {
  dimDeclarationOf,
  labelDefinitionLocations,
  labelReferenceLocations,
  mergeNavigationLegs,
  mergeSymbolLocations,
  resolveErbDimDefinition,
} from '../src/symbols';

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

/**
 * `$` 标签的**落点投影**（作用域读数在解析器插件，本包只做出现 → 落点这一层）。
 *
 * 这里直接给出结构形状（不 import 插件）：`labelDefinitionLocations` /
 * `labelReferenceLocations` 的入参只要 `occurrences`，解析器作用域是它的超集。
 */
describe('$ 标签落点投影 · 出现 → 落点', () => {
  const LABEL_PATH = String.raw`c:\proj\erb\label.erb`;
  const scope = {
    occurrences: [
      { filePath: LABEL_PATH, line: 3, column: 2, endColumn: 6, kind: 'definition' as const },
      { filePath: LABEL_PATH, line: 5, column: 8, endColumn: 12, kind: 'jump' as const },
    ],
  };

  it('定义带 kind=definition；跳转记 mention（不是 call）且带 span', () => {
    expect(labelDefinitionLocations(scope)).toEqual([
      { filePath: LABEL_PATH, line: 3, column: 2, span: { columnStart: 2, columnEnd: 6 }, kind: 'definition' },
    ]);
    expect(labelReferenceLocations(scope)).toEqual([
      { filePath: LABEL_PATH, line: 3, column: 2, span: { columnStart: 2, columnEnd: 6 }, kind: 'definition' },
      { filePath: LABEL_PATH, line: 5, column: 8, span: { columnStart: 8, columnEnd: 12 }, kind: 'mention' },
    ]);
  });

  it('零宽出现（`column === endColumn`）不给假区间', () => {
    expect(
      labelDefinitionLocations({
        occurrences: [{ filePath: LABEL_PATH, line: 2, column: 2, endColumn: 2, kind: 'definition' }],
      }),
    ).toEqual([{ filePath: LABEL_PATH, line: 2, column: 2, kind: 'definition' }]);
  });
});

describe('位置合并 · 路径归一', () => {
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
 * F12-TOKEN（2026-10-19）：**同一位置多条腿的优先序只住在一枚函数里**。
 *
 * 取词尺放宽到 Unicode 之后，"中文 `#DIM` 声明名"与"中文函数名"第一次会在**同一个点位**
 * 上各自答出一份（语料里 `充填率` / `睡眠時間` 这类名字既是基础库函数、也常被作者拿来当
 * 声明名）。此前这条序是两条宿主腿各写两遍 `if`（definition 与 find-references 各一份
 * 嵌套），漏改一处就会让 F12 与 `Shift+F12` 对同一个点位给出不同的第一落点。
 * 现在序 = `mergeNavigationLegs(标签, 声明, 槽)`，两条腿共用这一枚函数。
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
});
