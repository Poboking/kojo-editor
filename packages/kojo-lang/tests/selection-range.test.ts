/**
 * K2-LSP-HILITE-SELECT · Kojo 2.0 **选择范围**的判据闸（B3f 起判据住 `@kojo/kojo-lang`）。
 *
 * 本文件的断言是**整块搬来的**（原 `packages/app/tests/kojo2-highlight-selection.test.ts`
 * ⑤⑥⑦ 三组，一条没减）；只测 Monaco 0.57 摊平形状的那几条留在宿主
 * `packages/app/tests/kojo2-highlight-selection.test.ts`。
 *
 * 覆盖：层级（词 → 行 → 块 → 幕 → 全文）、`?` 链按分支、`@原生` 整块一级、
 * `# 机` 体（无幕时）、幕之后的文件级声明不被收进幕、空 / 越界 / 多光标 /
 * 行末光标 / CRLF 确定性，外加 B3f 新增的对齐版入口（同长 + 逐位点 `null`）。
 */
import { describe, expect, it } from 'vitest';
import type { Kojo2SymbolPosition, Kojo2SymbolRange } from '../src/symbols';
import {
  kojo2SelectionRangeAt,
  kojo2SelectionRangeChainsAt,
  type Kojo2SelectionRange,
} from '../src/selection-range';

/* ============================== 夹具 ============================== */

/**
 * 扩选夹具：两幕 + 表 / 池（两条 `?` 分支）/ 函 / 顶层 `@原生` / 幕间空行。
 * 幕 1 的 AST 区间到第 23 行（最后一个叙事节点），第 25 行起的第二幕不并进来。
 */
const SELECT = [
  '# 幕 神社清晨', // 1
  '# 视 灵梦', // 2
  '# 机 指令 310', // 3
  '# 变量 心情 整数 = 0 存档', // 4
  '# 表 心情表 由 心情', // 5
  '    0..99 疏远', // 6
  '    100..499 平常', // 7
  '    否 未知', // 8
  '', // 9
  '# 池 早安问候', // 10
  '    ? 心情 >= 100', // 11
  '        「心情不错。」', // 12
  '    ? 否', // 13
  '        「早安。」', // 14
  '', // 15
  '@函 增加(数值)', // 16
  '    心情 = 心情 + 数值', // 17
  '    ! 早安问候', // 18
  '', // 19
  '@原生', // 20
  '    CALL 心情', // 21
  '', // 22（围栏内的空行归原生块）
  '> 正文', // 23
  '', // 24
  '# 幕 神社黄昏', // 25
  '> 夕阳。', // 26
].join('\n');

/* ============================== 小工具 ============================== */

function splitLines(source: string): string[] {
  return source.split(/\r\n|\r|\n/);
}

function lineText(source: string, line: number): string {
  return splitLines(source)[line - 1] ?? '';
}

/** 第 `line` 行第 `occurrence` 个 `needle` 的首列（1 基） */
function at(
  source: string,
  line: number,
  needle: string,
  occurrence = 1,
): Kojo2SymbolPosition {
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

/** 1 基区间 → `[行, 列, 行, 列]`（比较用） */
function flat(range: Kojo2SymbolRange): [number, number, number, number] {
  return [range.startLine, range.startColumn, range.endLine, range.endColumn];
}

/** 扩选链（最内层在前）→ 1 基区间数组 */
function chainOf(source: string, position: Kojo2SymbolPosition): Kojo2SymbolRange[] {
  const node = kojo2SelectionRangeAt(source, [position])[0];
  const out: Kojo2SymbolRange[] = [];
  let cursor: Kojo2SelectionRange | undefined = node;
  while (cursor !== undefined) {
    out.push(cursor.range);
    cursor = cursor.parent;
  }
  return out;
}

/* ============================== ① 层级 ============================== */

describe('扩选：词 → 行 → 块 → 幕 → 全文', () => {
  it('函数体里的变量：词 / 行 / 函块 / 幕 / 全文 五级', () => {
    const chain = chainOf(SELECT, at(SELECT, 17, '心情'));
    expect(chain).toHaveLength(5);
    expect(chain.map((range) => range.startLine)).toEqual([17, 17, 16, 1, 1]);
    expect(flat(chain[0]!)).toEqual([17, 5, 17, 7]);
    expect(flat(chain[1]!)).toEqual([17, 1, 17, lineText(SELECT, 17).length + 1]);
    expect(flat(chain[2]!)).toEqual([16, 1, 18, lineText(SELECT, 18).length + 1]);
    expect(flat(chain[3]!)).toEqual([1, 1, 23, lineText(SELECT, 23).length + 1]);
    expect(flat(chain[4]!)).toEqual([1, 1, 26, lineText(SELECT, 26).length + 1]);
  });

  it('行级恒为整行（含缩进；起列 1、终列行长 + 1）', () => {
    const chain = chainOf(SELECT, at(SELECT, 17, '心情'));
    const line = chain[1]!;
    expect(line.startColumn).toBe(1);
    expect(line.endColumn).toBe(lineText(SELECT, 17).length + 1);
  });

  it('表行整行：词 / 行 / 表体（声明体）/ 幕 / 全文，不切单元格', () => {
    const chain = chainOf(SELECT, at(SELECT, 6, '疏远'));
    expect(chain).toHaveLength(5);
    expect(flat(chain[1]!)).toEqual([6, 1, 6, lineText(SELECT, 6).length + 1]);
    expect(flat(chain[2]!)).toEqual([5, 1, 8, lineText(SELECT, 8).length + 1]);
    expect(chain[3]!.startLine).toBe(1);
    expect(chain[4]!.endLine).toBe(26);
  });

  it('`?` 链按分支：分支体到分支正文末行，下一条分支不并进来', () => {
    const chain = chainOf(SELECT, at(SELECT, 11, '心情'));
    expect(chain.map((range) => range.startLine)).toEqual([11, 11, 11, 10, 1, 1]);
    expect(flat(chain[2]!)).toEqual([11, 1, 12, lineText(SELECT, 12).length + 1]);
    expect(chain[2]!.endLine).toBe(12);
    // 池声明体（声明体一级：11 的分支 ⊂ 池）
    expect(flat(chain[3]!)).toEqual([10, 1, 14, lineText(SELECT, 14).length + 1]);
  });

  it('第二条 `? 否` 分支自成一块（13–14 行），不含上一条分支', () => {
    const chain = chainOf(SELECT, at(SELECT, 14, '早安'));
    expect(flat(chain[2]!)).toEqual([13, 1, 14, lineText(SELECT, 14).length + 1]);
  });

  it('`@原生` 整块一级：头行到围栏末个非空行，原生体不再细分', () => {
    const chain = chainOf(SELECT, at(SELECT, 21, '心情'));
    expect(chain.map((range) => range.startLine)).toEqual([21, 21, 20, 1, 1]);
    expect(flat(chain[2]!)).toEqual([20, 1, 21, lineText(SELECT, 21).length + 1]);
    expect(chain[3]!.startLine).toBe(1);
  });

  it('`@原生` 写在 `@函` 体里：原生块仍完整落在函块内（尾随空行不吃掉外层）', () => {
    const nested = ['# 幕 一', '@函 甲()', '    @原生', '        CALL X', '> 正文'].join('\n');
    const chain = chainOf(nested, at(nested, 4, 'CALL'));
    expect(chain.map((range) => range.startLine)).toEqual([4, 4, 3, 2, 1]);
    expect(flat(chain[2]!)).toEqual([3, 1, 4, lineText(nested, 4).length + 1]);
    expect(flat(chain[3]!)).toEqual([2, 1, 4, lineText(nested, 4).length + 1]);
  });

  it('`# 幕` 头行：词 / 行 / 幕 / 全文（单行声明不再出块级）', () => {
    const chain = chainOf(SELECT, at(SELECT, 1, '神社清晨'));
    expect(chain.map((range) => range.startLine)).toEqual([1, 1, 1, 1]);
    expect(flat(chain[2]!)).toEqual([1, 1, 23, lineText(SELECT, 23).length + 1]);
    expect(chain[3]!.endLine).toBe(26);
  });

  it('第二幕正文只给第二幕，不串到第一幕', () => {
    const chain = chainOf(SELECT, at(SELECT, 26, '夕阳'));
    expect(flat(chain[2]!)).toEqual([25, 1, 26, lineText(SELECT, 26).length + 1]);
    expect(chain[3]!.endLine).toBe(26);
  });

  it('幕之后的文件级声明不被幕收进去（`@织` 在幕外）', () => {
    const outside = ['# 幕 一', '> 正文', '@织 指令 之前', '    > 监听'].join('\n');
    const chain = chainOf(outside, at(outside, 4, '监听'));
    // 幕 1–2，织块 3–4，全文 1–4
    expect(chain.map((range) => range.startLine)).toEqual([4, 4, 3, 1]);
    expect(flat(chain[2]!)).toEqual([3, 1, 4, lineText(outside, 4).length + 1]);
    expect(chain[3]!.endLine).toBe(4);
  });
});

/* ============================== ② `# 机` 体 / 无幕 ============================== */

describe('扩选：没有 `# 幕` 时 `# 机` 体是一级', () => {
  const machineOnly = ['# 机 指令 310', '# 变量 甲 整数', '> 正文', '', ''].join('\n');

  it('机体 = 机声明行到最后一个非空行（规范 §3.7）', () => {
    const chain = chainOf(machineOnly, at(machineOnly, 3, '正文'));
    expect(chain.map((range) => range.startLine)).toEqual([3, 3, 1, 1]);
    expect(flat(chain[2]!)).toEqual([1, 1, 3, lineText(machineOnly, 3).length + 1]);
    expect(chain[3]!.endLine).toBe(5);
  });

  it('有机体时表体嵌在机体内（机体 → 表 → 行 → 词）', () => {
    const source = ['# 机 指令 310', '# 表 甲 由 乙', '    0..9 丙', '', ''].join('\n');
    const chain = chainOf(source, at(source, 3, '丙'));
    expect(chain.map((range) => range.startLine)).toEqual([3, 3, 2, 1, 1]);
    expect(flat(chain[2]!)).toEqual([2, 1, 3, lineText(source, 3).length + 1]);
  });

  it('声明区写在首个幕之前：没有幕父（词 / 行 / 全文）', () => {
    const source = ['# 变量 甲 整数', '# 幕 开场', '> 正文'].join('\n');
    const chain = chainOf(source, at(source, 1, '甲'));
    expect(chain.map((range) => range.startLine)).toEqual([1, 1, 1]);
    expect(chain[2]!.endLine).toBe(3);
  });
});

/* ============================== ③ 空 / 越界 / 多光标 ============================== */

describe('扩选：空文件、越界、多光标、确定性', () => {
  it('空串 / 纯空白 / 空位点数组 ⇒ []', () => {
    expect(kojo2SelectionRangeAt('', [{ line: 1, column: 1 }])).toEqual([]);
    expect(kojo2SelectionRangeAt('   \n\t\n', [{ line: 1, column: 1 }])).toEqual([]);
    expect(kojo2SelectionRangeAt(SELECT, [])).toEqual([]);
  });

  it('越界行 / 越界列 / 非法坐标 ⇒ 该位点显式空（不夹取）', () => {
    expect(kojo2SelectionRangeAt(SELECT, [{ line: 9_999, column: 1 }])).toEqual([]);
    expect(kojo2SelectionRangeAt(SELECT, [{ line: 1, column: 0 }])).toEqual([]);
    expect(kojo2SelectionRangeAt(SELECT, [{ line: 1, column: 999 }])).toEqual([]);
    expect(kojo2SelectionRangeAt(SELECT, [{ line: Number.NaN, column: 1 }])).toEqual([]);
    expect(kojo2SelectionRangeAt(SELECT, [{ line: 1, column: Number.POSITIVE_INFINITY }])).toEqual(
      [],
    );
  });

  it('多光标：结果与输入同序、各自一条链', () => {
    const positions = [at(SELECT, 17, '心情'), at(SELECT, 6, '疏远'), at(SELECT, 14, '早安')];
    const chains = kojo2SelectionRangeAt(SELECT, positions);
    expect(chains).toHaveLength(3);
    expect(chainOf(SELECT, positions[0]!)[0]!.startLine).toBe(17);
    expect(chainOf(SELECT, positions[1]!)[0]!.startLine).toBe(6);
    expect(chainOf(SELECT, positions[2]!)[0]!.startLine).toBe(14);
  });

  it('行末光标取左侧词（行尾列可停靠）', () => {
    const end = { line: 3, column: lineText(SELECT, 3).length + 1 };
    const chain = chainOf(SELECT, end);
    expect(chain[0]!.startColumn).toBe(lineText(SELECT, 3).indexOf('310') + 1);
    expect(chain[0]!.endColumn).toBe(lineText(SELECT, 3).length + 1);
  });

  it('空行位点：没有词级，行 → 全文（不猜块）', () => {
    const chain = chainOf(SELECT, { line: 24, column: 1 });
    expect(chain.map((range) => range.startLine)).toEqual([24, 1]);
    expect(flat(chain[0]!)).toEqual([24, 1, 24, 1]);
    expect(chain[1]!.endLine).toBe(26);
  });

  it('CRLF 与 LF 同结果', () => {
    const crlf = SELECT.replace(/\n/g, '\r\n');
    const lfChain = chainOf(SELECT, at(SELECT, 11, '心情'));
    expect(chainOf(crlf, at(crlf, 11, '心情'))).toEqual(lfChain);
  });

  it('中文名字整词（不按字节切）', () => {
    const chain = chainOf(SELECT, at(SELECT, 1, '神社清晨'));
    expect(flat(chain[0]!)).toEqual([1, 5, 1, 9]);
  });
});

/* ============================== ④ 对齐版入口（B3f） ============================== */

describe('B3f 对齐版：同长数组 + 逐位点显式空链（供方作答契约用）', () => {
  it('有效位点给链、越界位点给 null，顺序与输入一致', () => {
    const chains = kojo2SelectionRangeChainsAt(SELECT, [
      at(SELECT, 17, '心情'),
      { line: 9_999, column: 1 },
      at(SELECT, 6, '疏远'),
    ]);
    expect(chains).toHaveLength(3);
    expect(chains[0]?.range.startLine).toBe(17);
    expect(chains[1]).toBeNull();
    expect(chains[2]?.range.startLine).toBe(6);
  });

  it('空文件 / 纯空白 ⇒ 与输入同长的全 null（不是空数组）', () => {
    expect(kojo2SelectionRangeChainsAt('', [{ line: 1, column: 1 }])).toEqual([null]);
    expect(kojo2SelectionRangeChainsAt('  \n', [{ line: 1, column: 1 }, { line: 2, column: 1 }])).toEqual([
      null,
      null,
    ]);
  });

  it('空位点数组 ⇒ []（没有位点就没有链，同长 = 0）', () => {
    expect(kojo2SelectionRangeChainsAt(SELECT, [])).toEqual([]);
  });

  it('过滤版与对齐版同源：非 null 项逐字相等', () => {
    const positions = [at(SELECT, 11, '心情'), { line: 0, column: 0 }, at(SELECT, 1, '神社清晨')];
    const aligned = kojo2SelectionRangeChainsAt(SELECT, positions).filter(
      (chain): chain is Kojo2SelectionRange => chain !== null,
    );
    expect(aligned).toEqual(kojo2SelectionRangeAt(SELECT, positions));
  });
});
