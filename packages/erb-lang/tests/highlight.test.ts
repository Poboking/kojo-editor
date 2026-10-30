/**
 * `@kojo/erb-lang/highlight` 的判据闸（LAU-4 第一步：判据从宿主整块搬进包）。
 *
 * 三组断言，各自防一种真实退化：
 * 1. **控制流块配对**：开块 write / 分支 text / 收束 read；孤儿与未闭合不猜；
 * 2. **函数名与 `$` 标签**：声明写 / `CALL` 与跳转读 / 代码面同名提及 text；
 * 3. **不误报**：字符串 / 整行注释 / `[SKIPSTART]` 死区 / 无符号位置 / 越界坐标 ⇒ `[]`。
 *
 * 夹具与断言**逐条承接宿主批（ERB-HIGHLIGHT-SELECT，batch-9）**：判据搬家不许带走
 * 一条断言——这里缺的那几条只在宿主翻译层留（`DocumentHighlightKind` 映射 / provider
 * 三态），判据侧一条不少。
 */
import { describe, expect, it } from 'vitest';
import {
  erbDocumentHighlights,
  erbStructureOf,
  type ErbDocumentHighlight,
  type ErbHighlightKind,
  type ErbPosition,
  type ErbRange,
} from '../src/highlight';

/* ============================== 夹具 ============================== */

/**
 * 高亮主夹具（每行都按内容定位）。埋伏的陷阱：
 * - 第 1 行注释里写满 `IF` / `CALL FUNC` / `$LOOP`；
 * - 第 6 行字符串里有 `IF` 与 `FUNC`；
 * - 第 9 行是没有 `CALL` 的散文式同名提及（⇒ text 档）；
 * - 第 10 行 `SIF` 是单行语句（没有配对块）；
 * - 第 15–18 行是 `[SKIPSTART]` 死区，里面还有一枚 `IF` 与一处 `CALL FUNC`；
 * - 第 20 行的 `IF` 在函数边界（第 22 行）前没有收束。
 */
const HILITE: string = [
  '; 顶部注释：IF / CALL FUNC / $LOOP 都不是符号',
  '#DIM CNT, 10',
  '@FUNC(A, B)',
  '    $LOOP',
  '    IF A AND B',
  '        PRINTL "字符串里的 IF 与 FUNC"',
  '        CALL OTHER(1)',
  '        CALL FUNC(A)',
  '        PRINTL FUNC について',
  '        SIF A > 1',
  '        PRINTLX',
  '    ELSE',
  '        CALL FUNC(B)',
  '    ENDIF',
  '    [SKIPSTART]',
  '    IF A',
  '    CALL FUNC(A)',
  '    [SKIPEND]',
  '    JUMP LOOP',
  '    IF A',
  '        PRINTL 未闭合',
  '@OTHER()',
  '    CALL FUNC(1)',
].join('\n');

/** 大小写 / CJK：`if` / `endif` 小写形态与中文函数名 */
const CJK: string = [
  '@中文函(A)',
  '    CALL 中文函(A)',
  '    if A > 1',
  '        PRINTL A',
  '    endif',
].join('\n');

/** `TRYCCALL` 既是 try 开块、又把函数名放在名字槽里（引擎同一语句两种身份） */
const TRY: string = [
  '@T()',
  '    TRYCCALL 靶(1)',
  '        CALL 靶(2)',
  '    CATCH',
  '        PRINTL 捕',
  '    ENDCATCH',
].join('\n');

/** 跳转目标带 `$` / `*` 前缀（引擎两种写法都认） */
const LABEL: string = [
  '@L()',
  '    $NEXT',
  '    JUMP $NEXT',
  '    GOTO NEXT',
].join('\n');

/* ============================== 小工具 ============================== */

function splitLines(source: string): string[] {
  return source.split(/\r\n|\r|\n/);
}

function lineText(source: string, line: number): string {
  return splitLines(source)[line - 1] ?? '';
}

/** 第 `line` 行第 `occurrence` 个 `needle` 的首列（1 基） */
function at(source: string, line: number, needle: string, occurrence = 1): ErbPosition {
  const text = lineText(source, line);
  let index = -1;
  let from = 0;
  for (let i = 0; i < occurrence; i++) {
    index = text.indexOf(needle, from);
    if (index < 0) throw new Error(`第 ${line} 行没有第 ${i + 1} 个「${needle}」`);
    from = index + 1;
  }
  return { line, column: index + 1 };
}

/** 1 基区间 → `[行, 列, 行, 列]` */
function flat(range: ErbRange): [number, number, number, number] {
  return [range.startLine, range.startColumn, range.endLine, range.endColumn];
}

/** 高亮结果 → `[行, 起列, 行, 终列, 档位]`（便于整表对拍） */
function hitsOf(
  source: string,
  at_: ErbPosition,
): Array<[number, number, number, number, ErbHighlightKind]> {
  return erbDocumentHighlights(source, at_).map(
    (hit) => [...flat(hit.range), hit.kind] as [number, number, number, number, ErbHighlightKind],
  );
}

/* ============================== ① 高亮：控制流关键字配对 ============================== */

describe('高亮：控制流关键字块配对', () => {
  const IF_BLOCK: Array<[number, number, number, number, ErbHighlightKind]> = [
    [5, 5, 5, 7, 'write'],
    [12, 5, 12, 9, 'text'],
    [14, 5, 14, 10, 'read'],
  ];

  it('光标在开块 `IF` 上：开块 write + 分支 text + 收束 read', () => {
    expect(hitsOf(HILITE, at(HILITE, 5, 'IF'))).toEqual(IF_BLOCK);
  });

  it('光标在收束 `ENDIF` 上：给出同一条块（对称）', () => {
    expect(hitsOf(HILITE, at(HILITE, 14, 'ENDIF'))).toEqual(IF_BLOCK);
  });

  it('光标在分支 `ELSE` 上：给出它所属那一条块', () => {
    expect(hitsOf(HILITE, at(HILITE, 12, 'ELSE'))).toEqual(IF_BLOCK);
  });

  it('死区里的 `IF` 不开块 ⇒ `[]`（引擎不编译那些行）', () => {
    expect(erbDocumentHighlights(HILITE, at(HILITE, 16, 'IF'))).toEqual([]);
  });

  it('函数边界前的未闭合 `IF`：配对缺席时只给自己的那一枚（不猜收束）', () => {
    expect(hitsOf(HILITE, at(HILITE, 20, 'IF'))).toEqual([[20, 5, 20, 7, 'write']]);
  });

  it('`SIF` 是单行语句（没有配对块）⇒ `[]`', () => {
    expect(erbDocumentHighlights(HILITE, at(HILITE, 10, 'SIF'))).toEqual([]);
  });

  it('`TRYCCALL … CATCH … ENDCATCH`：开块 write + 分支 text + 收束 read', () => {
    expect(hitsOf(TRY, at(TRY, 2, 'TRYCCALL'))).toEqual([
      [2, 5, 2, 13, 'write'],
      [4, 5, 4, 10, 'text'],
      [6, 5, 6, 13, 'read'],
    ]);
  });

  it('结构事实：死区行不是控制行，未闭合的开块不产块', () => {
    const structure = erbStructureOf(HILITE);
    expect(structure.controlByLine.has(16)).toBe(false);
    expect(structure.controlByLine.has(17)).toBe(false);
    expect(structure.blocks).toHaveLength(1);
    expect(structure.blocks[0]!.open.line).toBe(5);
    expect(structure.blocks[0]!.close?.line).toBe(14);
  });
});

/* ============================== ② 高亮：函数名与 `$` 标签 ============================== */

describe('高亮：函数名（声明写 / 调用读 / 提及弱）', () => {
  const FUNC_HITS: Array<[number, number, number, number, ErbHighlightKind]> = [
    [3, 2, 3, 6, 'write'],
    [8, 14, 8, 18, 'read'],
    [9, 16, 9, 20, 'text'],
    [13, 14, 13, 18, 'read'],
    [23, 10, 23, 14, 'read'],
  ];

  it('`@FUNC` 声明 + 两处 `CALL` 名字槽 + 一处散文提及（text）', () => {
    expect(hitsOf(HILITE, at(HILITE, 3, 'FUNC'))).toEqual(FUNC_HITS);
  });

  it('光标停在 `@` 上也解析到同一枚声明（与正文面同一条符号）', () => {
    expect(hitsOf(HILITE, { line: 3, column: 1 })).toEqual(FUNC_HITS);
  });

  it('死区里的 `CALL FUNC` 不进结果（第 17 行缺席）', () => {
    expect(FUNC_HITS.some(([line]) => line === 17)).toBe(false);
  });

  it('字符串里的同名 `FUNC` 不进结果（第 6 行缺席）', () => {
    expect(FUNC_HITS.some(([line]) => line === 6)).toBe(false);
  });

  it('声明之外的第二枚函数：声明 + 它自己的调用点', () => {
    expect(hitsOf(HILITE, at(HILITE, 22, 'OTHER'))).toEqual([
      [7, 14, 7, 19, 'read'],
      [22, 2, 22, 7, 'write'],
    ]);
  });

  it('`CALL` 关键字本身不是符号 ⇒ `[]`', () => {
    expect(erbDocumentHighlights(HILITE, at(HILITE, 7, 'CALL'))).toEqual([]);
  });

  it('`CALLFORM` 的参数不是名字槽（未声明的名字 ⇒ `[]`，判窄不判宽）', () => {
    const source = ['@F()', '    CALLFORM UNDECLARED'].join('\n');
    expect(
      erbDocumentHighlights(source, {
        line: 2,
        column: source.split('\n')[1]!.indexOf('UNDECLARED') + 1,
      }),
    ).toEqual([]);
  });

  it('`TRYCCALL` 的目标同时是名字槽（既是 try 开块又按名调用）', () => {
    expect(hitsOf(TRY, at(TRY, 3, '靶'))).toEqual([
      [2, 14, 2, 15, 'read'],
      [3, 14, 3, 15, 'read'],
    ]);
  });
});

describe('高亮：`$` 标签（定义写 / 跳转读）', () => {
  it('`$LOOP` 定义 + `JUMP LOOP` 目标', () => {
    expect(hitsOf(HILITE, at(HILITE, 4, 'LOOP'))).toEqual([
      [4, 6, 4, 10, 'write'],
      [19, 10, 19, 14, 'read'],
    ]);
  });

  it('跳转目标可带 `$` 前缀（两种写法都是同一枚标签）', () => {
    expect(hitsOf(LABEL, at(LABEL, 2, 'NEXT'))).toEqual([
      [2, 6, 2, 10, 'write'],
      [3, 11, 3, 15, 'read'],
      [4, 10, 4, 14, 'read'],
    ]);
  });

  it('纯数字跳转目标是行号不是标签名（不产标签符号）', () => {
    const source = ['@L()', '    GOTO 123'].join('\n');
    expect(erbDocumentHighlights(source, { line: 2, column: 10 })).toEqual([]);
  });
});

/* ============================== ③ 高亮：不误报 / 边界 ============================== */

describe('高亮：字符串 / 注释 / 死区 / 无符号', () => {
  it('字符串内容不出符号（光标落在串里的 `IF`）', () => {
    expect(erbDocumentHighlights(HILITE, at(HILITE, 6, 'IF'))).toEqual([]);
  });

  it('字符串内容不出符号（光标落在串里的 `FUNC`）', () => {
    expect(erbDocumentHighlights(HILITE, at(HILITE, 6, 'FUNC'))).toEqual([]);
  });

  it('整行注释不出符号', () => {
    expect(erbDocumentHighlights(HILITE, at(HILITE, 1, 'CALL'))).toEqual([]);
    expect(erbDocumentHighlights(HILITE, at(HILITE, 1, 'LOOP'))).toEqual([]);
  });

  it('死区里的 `CALL FUNC` 不出符号', () => {
    expect(erbDocumentHighlights(HILITE, at(HILITE, 17, 'FUNC'))).toEqual([]);
  });

  it('空白 / 数字 / 未知词 / `#DIM` 指令行 ⇒ `[]`', () => {
    expect(erbDocumentHighlights(HILITE, { line: 2, column: 6 })).toEqual([]); // #DIM CNT
    expect(erbDocumentHighlights(HILITE, at(HILITE, 10, '1'))).toEqual([]); // 条件里的数字
    expect(erbDocumentHighlights(HILITE, at(HILITE, 21, 'PRINTL'))).toEqual([]); // 未声明词
  });

  it('越界行 / 越界列 / 非法坐标 / 空文件 / 非字符串 ⇒ `[]`（不抛）', () => {
    expect(erbDocumentHighlights(HILITE, { line: 9_999, column: 1 })).toEqual([]);
    expect(erbDocumentHighlights(HILITE, { line: 3, column: 999 })).toEqual([]);
    expect(erbDocumentHighlights(HILITE, { line: 0, column: 1 })).toEqual([]);
    expect(erbDocumentHighlights(HILITE, { line: 1, column: 0 })).toEqual([]);
    expect(erbDocumentHighlights(HILITE, { line: Number.NaN, column: 1 })).toEqual([]);
    expect(erbDocumentHighlights('', { line: 1, column: 1 })).toEqual([]);
    expect(erbDocumentHighlights(null as unknown as string, { line: 1, column: 1 })).toEqual([]);
  });
});

describe('高亮：确定性、CRLF、大小写、CJK', () => {
  it('同输入两次逐字相等', () => {
    expect(erbDocumentHighlights(HILITE, at(HILITE, 3, 'FUNC'))).toEqual(
      erbDocumentHighlights(HILITE, at(HILITE, 3, 'FUNC')),
    );
  });

  it('CRLF 与 LF 同结果（列口径不受行尾影响）', () => {
    const crlf = HILITE.replace(/\n/g, '\r\n');
    expect(erbDocumentHighlights(crlf, at(crlf, 3, 'FUNC'))).toEqual(
      erbDocumentHighlights(HILITE, at(HILITE, 3, 'FUNC')),
    );
  });

  it('关键字大小写不敏感：小写 `if` 配对小写 `endif`', () => {
    expect(hitsOf(CJK, at(CJK, 3, 'if'))).toEqual([
      [3, 5, 3, 7, 'write'],
      [5, 5, 5, 10, 'read'],
    ]);
  });

  it('中文函数名整词（声明 + 调用）', () => {
    expect(hitsOf(CJK, at(CJK, 1, '中文函'))).toEqual([
      [1, 2, 1, 5, 'write'],
      [2, 10, 2, 13, 'read'],
    ]);
  });

  it('三档都真出现过（write / read / text 一格不塌）', () => {
    // 塌档的表现是"声明与引用同色"：这里从主夹具一次取回全部出现处，逐档点名
    const hits: ErbDocumentHighlight[] = erbDocumentHighlights(HILITE, at(HILITE, 3, 'FUNC'));
    expect(new Set(hits.map((hit) => hit.kind))).toEqual(new Set(['write', 'read', 'text']));
  });
});
