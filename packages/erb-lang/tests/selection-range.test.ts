/**
 * `@kojo/erb-lang/selection-range` 的判据闸（LAU-4 第一步：判据从宿主整块搬进包）。
 *
 * 三组断言，各自防一种真实退化：
 * 1. **层级**：词 → 行 → 分支段 → 标签块（多级）→ 函数块 → 全文，父恒完整包住子；
 * 2. **边界**：死区不扩、空行没有词级、无函数头时块与全文同级只留一级、行末光标取左侧词；
 * 3. **两个出口**：过滤版（旧语义，越界整条滤掉）与对齐版（与位点同序同长，越界给 `null`）
 * 回答同一件事——对齐版多出来的那几格，正是供方出口要的形状。
 *
 * 夹具与断言**逐条承接宿主批（ERB-HIGHLIGHT-SELECT，batch-9）**；链的形状从 Monaco
 * `IRange` 换成本包的 `ErbRange`（字段名不同、数值口径逐字相同）。
 */
import { describe, expect, it } from 'vitest';
import type { ErbPosition, ErbRange } from '../src/highlight';
import {
  erbSelectionRangeAt,
  erbSelectionRangeChainsAt,
  type ErbSelectionChain,
} from '../src/selection-range';

/* ============================== 夹具 ============================== */

/** 扩选主夹具：两层控制块（IF ⊃ SELECTCASE）+ 一个分支段 + 两个函数 */
const SELECT: string = [
  '; 头部',
  '@FUNC(A)',
  '    IF A',
  '        SELECTCASE A',
  '            CASE 1',
  '                PRINTL 一',
  '        ENDSELECT',
  '    ENDIF',
  '@OTHER()',
  '    CALL FUNC(1)',
].join('\n');

/** `ELSE` 分支段夹具（IF 块里只有一条分支） */
const BRANCH: string = [
  '@FUNC(A, B)',
  '    IF A AND B',
  '        PRINTL "字符串"',
  '    ELSE',
  '        CALL FUNC(B)',
  '    ENDIF',
  '@OTHER()',
  '    CALL FUNC(1)',
].join('\n');

/** 死区夹具：`[SKIPSTART]` 里还写着 `IF B`（不解析、不扩选） */
const DEAD: string = [
  '@FUNC(A)',
  '    IF A',
  '        [SKIPSTART]',
  '        IF B',
  '        [SKIPEND]',
  '    ENDIF',
].join('\n');

/** 空行落在函数块里（没有词级，但函数 / 全文仍在） */
const BLANK: string = ['@FUNC(A)', '', '    PRINTL 一', '@OTHER()', '    PRINTL 二'].join('\n');

/** 没有函数头的顶层块（没有函数级，块与全文同级时只留一级） */
const TOPLEVEL: string = ['IF A', '    PRINTL 一', 'ENDIF'].join('\n');

/** 大小写 / CJK：中文函数名 */
const CJK: string = [
  '@中文函(A)',
  '    CALL 中文函(A)',
  '    if A > 1',
  '        PRINTL A',
  '    endif',
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

function flat(range: ErbRange): [number, number, number, number] {
  return [range.startLine, range.startColumn, range.endLine, range.endColumn];
}

/** 扩选链（最内层在前）→ 1 基区间数组 */
function chainOf(source: string, at_: ErbPosition): ErbRange[] {
  const node = erbSelectionRangeAt(source, [at_])[0];
  const out: ErbRange[] = [];
  let cursor: ErbSelectionChain | undefined = node;
  while (cursor !== undefined) {
    out.push(cursor.range);
    cursor = cursor.parent;
  }
  return out;
}

function chainFlats(source: string, at_: ErbPosition): Array<[number, number, number, number]> {
  return chainOf(source, at_).map(flat);
}

/* ============================== ① 层级 ============================== */

describe('扩选：词 → 行 → 分支段 → 块（多级）→ 函数 → 全文', () => {
  it('嵌套块：词 / 行 / CASE 段 / SELECTCASE 块 / IF 块 / 函数 / 全文 七级', () => {
    expect(chainFlats(SELECT, at(SELECT, 6, 'PRINTL'))).toEqual([
      [6, 17, 6, 23],
      [6, 1, 6, 25],
      [5, 1, 6, 25],
      [4, 1, 7, 18],
      [3, 1, 8, 10],
      [2, 1, 8, 10],
      [1, 1, 10, 17],
    ]);
  });

  it('行级恒为整行（含缩进；起列 1、终列行长 + 1）', () => {
    const chain = chainOf(SELECT, at(SELECT, 6, 'PRINTL'));
    expect(chain[1]!.startColumn).toBe(1);
    expect(chain[1]!.endColumn).toBe(lineText(SELECT, 6).length + 1);
  });

  it('`ELSE` 分支段：兄弟分支不并进来，段尾 = 收束前一行', () => {
    expect(chainFlats(BRANCH, at(BRANCH, 5, 'FUNC'))).toEqual([
      [5, 14, 5, 18],
      [5, 1, 5, 21],
      [4, 1, 5, 21],
      [2, 1, 6, 10],
      [1, 1, 6, 10],
      [1, 1, 8, 17],
    ]);
  });

  it('函数块不跨到下一个 `@`（`@OTHER` 之后的内容归 OTHER）', () => {
    expect(chainFlats(SELECT, at(SELECT, 10, 'FUNC'))).toEqual([
      [10, 10, 10, 14],
      [10, 1, 10, 17],
      [9, 1, 10, 17],
      [1, 1, 10, 17],
    ]);
  });

  it('死区不扩：词 → 行 → 全文（块 / 函数边界在那里没有判据）', () => {
    expect(chainFlats(DEAD, at(DEAD, 4, 'B'))).toEqual([
      [4, 12, 4, 13],
      [4, 1, 4, 13],
      [1, 1, 6, 10],
    ]);
  });

  it('死区标记行本身也不扩（`[SKIPSTART]` 行）', () => {
    expect(chainFlats(DEAD, at(DEAD, 3, 'SKIPSTART'))).toEqual([
      [3, 10, 3, 19],
      [3, 1, 3, 20],
      [1, 1, 6, 10],
    ]);
  });

  it('空行位点：没有词级，行 → 函数 → 全文', () => {
    expect(chainFlats(BLANK, { line: 2, column: 1 })).toEqual([
      [2, 1, 2, 1],
      [1, 1, 3, 13],
      [1, 1, 5, 13],
    ]);
  });

  it('没有函数头时链只有 词 / 行 / 块（块与全文同级只留一级）', () => {
    expect(chainFlats(TOPLEVEL, at(TOPLEVEL, 2, 'PRINTL'))).toEqual([
      [2, 5, 2, 11],
      [2, 1, 2, 13],
      [1, 1, 3, 6],
    ]);
  });

  it('全文区间 = 1:1 到末行末列', () => {
    const chain = chainOf(SELECT, at(SELECT, 6, 'PRINTL'));
    expect(flat(chain[chain.length - 1]!)).toEqual([
      1,
      1,
      splitLines(SELECT).length,
      lineText(SELECT, splitLines(SELECT).length).length + 1,
    ]);
  });
});

/* ============================== ② 空 / 越界 / 多光标 ============================== */

describe('扩选：空文件、越界、多光标、确定性', () => {
  it('空串 / 纯空白 / 空位点数组 ⇒ `[]`', () => {
    expect(erbSelectionRangeAt('', [{ line: 1, column: 1 }])).toEqual([]);
    expect(erbSelectionRangeAt('   \n\t\n', [{ line: 1, column: 1 }])).toEqual([]);
    expect(erbSelectionRangeAt(SELECT, [])).toEqual([]);
  });

  it('越界行 / 越界列 / 非法坐标 ⇒ 该位点显式空（不夹取）', () => {
    expect(erbSelectionRangeAt(SELECT, [{ line: 9_999, column: 1 }])).toEqual([]);
    expect(erbSelectionRangeAt(SELECT, [{ line: 1, column: 0 }])).toEqual([]);
    expect(erbSelectionRangeAt(SELECT, [{ line: 1, column: 999 }])).toEqual([]);
    expect(erbSelectionRangeAt(SELECT, [{ line: Number.NaN, column: 1 }])).toEqual([]);
    expect(
      erbSelectionRangeAt(SELECT, [{ line: 1, column: Number.POSITIVE_INFINITY }]),
    ).toEqual([]);
  });

  it('多光标：结果与输入同序、各自一条链', () => {
    const positions = [at(SELECT, 6, 'PRINTL'), at(BRANCH, 5, 'FUNC')];
    const chains = erbSelectionRangeAt(SELECT, positions);
    expect(chains).toHaveLength(2);
    expect(chainOf(SELECT, positions[0]!)[0]!.startLine).toBe(6);
    expect(chainOf(SELECT, positions[1]!)[0]!.startLine).toBe(5);
  });

  it('行末光标取左侧词（行尾列可停靠）', () => {
    const end = { line: 3, column: lineText(SELECT, 3).length + 1 };
    const chain = chainOf(SELECT, end);
    expect(flat(chain[0]!)).toEqual([3, 8, 3, 9]);
  });

  it('中文名字整词（不按字节切）', () => {
    expect(flat(chainOf(CJK, at(CJK, 1, '中文函'))[0]!)).toEqual([1, 2, 1, 5]);
  });

  it('CRLF 与 LF 同结果', () => {
    const crlf = SELECT.replace(/\n/g, '\r\n');
    expect(chainFlats(crlf, at(crlf, 6, 'PRINTL'))).toEqual(
      chainFlats(SELECT, at(SELECT, 6, 'PRINTL')),
    );
  });
});

/* ============================== ③ 对齐版出口 ============================== */

describe('扩选：对齐版 `erbSelectionRangeChainsAt`（供方出口形状）', () => {
  it('与位点同序同长；越界 / 非法位点给 `null`（不夹取、不猜）', () => {
    const chains = erbSelectionRangeChainsAt(SELECT, [
      at(SELECT, 6, 'PRINTL'),
      { line: 9_999, column: 1 },
      { line: 1, column: 0 },
      at(SELECT, 10, 'FUNC'),
    ]);
    expect(chains).toHaveLength(4);
    expect(chains[1]).toBeNull();
    expect(chains[2]).toBeNull();
    expect(chains[0]).not.toBeNull();
    expect(chains[3]).not.toBeNull();
    // 某一格空链不缩短别的位点：第一条仍是完整的七级链
    expect(flat(chains[0]!.range)).toEqual([6, 17, 6, 23]);
  });

  it('空文件 / 纯空白 ⇒ 全部 `null`（同长，不是空数组）', () => {
    expect(erbSelectionRangeChainsAt('', [{ line: 1, column: 1 }, { line: 2, column: 2 }])).toEqual([
      null,
      null,
    ]);
    expect(erbSelectionRangeChainsAt('   \n\t\n', [{ line: 1, column: 1 }])).toEqual([null]);
  });

  it('空位点数组 ⇒ `[]`（没有位点就没有格）', () => {
    expect(erbSelectionRangeChainsAt(SELECT, [])).toEqual([]);
  });

  it('过滤版与对齐版在位点全合法时给出同一条链（两个出口不是两套判据）', () => {
    const positions = [at(SELECT, 6, 'PRINTL'), at(BRANCH, 5, 'FUNC')];
    const filtered = erbSelectionRangeAt(SELECT, positions).map((chain) => chain.range);
    const aligned = erbSelectionRangeChainsAt(SELECT, positions).map((chain) => chain!.range);
    expect(aligned).toEqual(filtered);
  });
});
