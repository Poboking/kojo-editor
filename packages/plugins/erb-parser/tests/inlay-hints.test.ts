/**
 * 实参位行内提示（`inlay-hints.ts`）单测——**纯函数**，文本 + 槽名查询进、提示出。
 *
 * 钉死四件事：
 * (a) 对位正确性——第 j 个实参 = 第 j 个声明槽（括号形 / 逗号形 / 全角逗号 / 嵌套括号）；
 * (b) 可证明边界——被调名不在索引、声明槽为零、形参表分歧、声明槽比实参少、
 *     FORM 动态拼接、成员访问占槽、注释尾、字符串里的逗号，一律不给（不猜）；
 * (c) 坐标口径——1 基列指向实参首字符（跳过前导空白，字符串实参落在引号上）；
 * (d) 标签口径——具名槽 `名:`、ARG 式槽原样（槽位坐标本身就是信息）。
 */

import { functionLookupOf } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import type { ErbIndex } from '@kojo/plugin-api';
import { callArgumentHints, inlaySlotsOf } from '../src/inlay-hints';

/** 槽名查询桩：Map 缺席 = null */
const slotsOf = (table: Record<string, readonly string[]>) => (name: string) => table[name] ?? null;

const hintAt = (hints: ReturnType<typeof callArgumentHints>, line: number) =>
  hints.filter((h) => h.line === line);

describe('callArgumentHints · 对位与坐标', () => {
  it('逗号形：实参列对准实参首字符（1 基）', () => {
    const text = 'CALL CHANGE_CFLAG, 5, TARGET, 1\n';
    const hints = callArgumentHints(
      text,
      slotsOf({ CHANGE_CFLAG: ['変動フラグ', '対象', '変動数'] }),
    );
    expect(hintAt(hints, 1)).toEqual([
      { line: 1, column: 20, label: '変動フラグ:', tooltip: '第 1 参：変動フラグ' },
      { line: 1, column: 23, label: '対象:', tooltip: '第 2 参：対象' },
      { line: 1, column: 31, label: '変動数:', tooltip: '第 3 参：変動数' },
    ]);
  });

  it('括号形与缩进：跳过前导空白对准实参', () => {
    const text = '\tCALL FOO( 12 , x )\n';
    const hints = callArgumentHints(text, slotsOf({ FOO: ['甲', '乙'] }));
    expect(hintAt(hints, 1)).toEqual([
      { line: 1, column: 12, label: '甲:', tooltip: '第 1 参：甲' },
      { line: 1, column: 17, label: '乙:', tooltip: '第 2 参：乙' },
    ]);
  });

  it('ARG 式槽：标签原样（CALL 参数槽 ↔ ARG:0/ARG:1 对位）', () => {
    const text = 'CALL MESSAGE_TALK, 3, 12\n';
    const hints = callArgumentHints(text, slotsOf({ MESSAGE_TALK: ['ARG', 'ARG:1', 'ARG:2'] }));
    expect(hintAt(hints, 1).map((h) => h.label)).toEqual(['ARG', 'ARG:1']);
  });

  it('字符串实参落在引号上；字符串里的逗号与全角逗号不分隔', () => {
    const text = 'CALL COLORMESSAGE("a,b，c", 3)\n';
    const hints = callArgumentHints(text, slotsOf({ COLORMESSAGE: ['内容', '色'] }));
    expect(hintAt(hints, 1)).toHaveLength(2);
    expect(hintAt(hints, 1)[0]!.column).toBe(19); // " 的位置
  });

  it('嵌套括号：深度内的逗号不切分', () => {
    const text = 'CALL FOO((A+B)*2, C)\n';
    const hints = callArgumentHints(text, slotsOf({ FOO: ['甲', '乙'] }));
    expect(hintAt(hints, 1)).toHaveLength(2);
    expect(hintAt(hints, 1)[1]!.column).toBe(19);
  });

  it('空槽占位：`CALL FOO, a,,b` 里 b 是第 3 实参（对丙槽）', () => {
    const text = 'CALL FOO, a,,b\n';
    const hints = callArgumentHints(text, slotsOf({ FOO: ['甲', '乙', '丙', '丁'] }));
    expect(hintAt(hints, 1).map((h) => h.label)).toEqual(['甲:', '丙:']);
  });
});

describe('callArgumentHints · 可证明边界（不猜）', () => {
  it('被调名不在索引 / 无声明槽 ⇒ 整行不给', () => {
    const text = 'CALL NOPE, 1\nCALL BARE, 1\n';
    const hints = callArgumentHints(text, slotsOf({ BARE: [] }));
    expect(hints).toHaveLength(0);
  });

  it('声明槽比实参少：多出的实参不标（引擎语义未核验）', () => {
    const text = 'CALL FOO, 1, 2, 3\n';
    const hints = callArgumentHints(text, slotsOf({ FOO: ['甲'] }));
    expect(hintAt(hints, 1)).toHaveLength(1);
  });

  it('FORM 动态拼接（名字与关键字之间有非空白）⇒ 不给', () => {
    const text = 'CALLFORM FOO\nCALL FOO+"X", 1\n';
    const hints = callArgumentHints(text, slotsOf({ FOO: ['甲'], 'FOO+"X"': [] }));
    expect(hints).toHaveLength(0);
  });

  it('成员访问占槽（CALL FLAG:X）⇒ 不给', () => {
    const text = 'CALL FLAG:X, 1\n';
    const hints = callArgumentHints(text, slotsOf({ FLAG: ['甲'] }));
    expect(hints).toHaveLength(0);
  });

  it('行内注释尾之后的逗号不参与切分', () => {
    const text = 'CALL FOO, 1 ; 备注, 带逗号\n';
    const hints = callArgumentHints(text, slotsOf({ FOO: ['甲'] }));
    expect(hintAt(hints, 1)).toHaveLength(1);
  });

  it('[SKIPSTART] 死代码区与注释行不给', () => {
    const text = '[SKIPSTART]\nCALL FOO, 1\n[SKIPEND]\n; CALL FOO, 2\n';
    expect(callArgumentHints(text, slotsOf({ FOO: ['甲'] }))).toHaveLength(0);
  });

  it('TRYCALL 直系族同样应答，CALLFORM 不应答', () => {
    const text = 'TRYCALL FOO, 1\nCALLFORM FOO, 2\n';
    const hints = callArgumentHints(text, slotsOf({ FOO: ['甲'] }));
    expect(hintAt(hints, 1)).toHaveLength(1);
    expect(hintAt(hints, 2)).toHaveLength(0);
  });

  it('名字槽单独一行（无实参）⇒ 不给', () => {
    const text = 'CALL FOO\n';
    expect(callArgumentHints(text, slotsOf({ FOO: ['甲'] }))).toHaveLength(0);
  });
});

describe('inlaySlotsOf · 多处定义的对账', () => {
  const indexWith = (defs: Array<{ file: string; startLine: number; params: string[] }>): ErbIndex => {
    const files = new Map(
      defs.map((d) => [
        d.file,
        {
          path: d.file,
          functions: [
            {
              name: 'FOO',
              normalizedName: 'FOO',
              params: d.params.map((p) => ({ name: p, hasDefault: false })),
              startLine: d.startLine,
              endLine: d.startLine + 1,
              filePath: d.file,
            },
          ],
          dims: [],
          hasFunctionDirective: false,
          lineCount: 10,
        },
      ]),
    );
    return {
      files,
      byName: functionLookupOf(new Map([
        [
          'FOO',
          defs.map((d) => ({
            name: 'FOO',
            normalizedName: 'FOO',
            filePath: d.file,
            startLine: d.startLine,
            endLine: d.startLine + 1,
          })),
        ],
      ])),
    } as unknown as ErbIndex;
  };

  it('单处定义给槽名表', () => {
    expect(inlaySlotsOf(indexWith([{ file: 'a.ERB', startLine: 1, params: ['甲', '乙'] }]), 'FOO')).toEqual([
      '甲',
      '乙',
    ]);
  });

  it('多处定义逐名一致（大小写不敏感）⇒ 给首处的原样名', () => {
    const idx = indexWith([
      { file: 'a.ERB', startLine: 1, params: ['Arg'] },
      { file: 'b.ERB', startLine: 5, params: ['ARG'] },
    ]);
    expect(inlaySlotsOf(idx, 'FOO')).toEqual(['Arg']);
  });

  it('多处定义分歧 ⇒ null（证明不了作者调的是哪一个）', () => {
    const idx = indexWith([
      { file: 'a.ERB', startLine: 1, params: ['甲'] },
      { file: 'b.ERB', startLine: 5, params: ['甲', '乙'] },
    ]);
    expect(inlaySlotsOf(idx, 'FOO')).toBeNull();
  });

  it('名字不在索引 ⇒ null', () => {
    expect(inlaySlotsOf(indexWith([]), 'NOPE')).toBeNull();
  });
});

/* ============================== 行窗口（R1，2026-10-28） ============================== */

/**
 * 窗口化是**少答**，不是"换个判据"——所以这里不写"窗口应该给什么"的新期望值，
 * 只钉一条恒等式：
 *
 *   `callArgumentHints(text, slots, {from, to})`  ≡  `callArgumentHints(text, slots)`
 *                                              按行过滤到 [from, to]
 *
 * 全篇那一侧是**旧路径**（`splitErbLines` + 整篇判读），窗口那一侧是新路径
 * （原文上逐行走到窗口）。两边逐条相等 ⇒ 判据没漂、`[SKIPSTART]` 跨行状态没丢、
 * CRLF 的行边界没错位。
 */
describe('callArgumentHints · 行窗口（窗口 = 全篇按行过滤）', () => {
  const slots = slotsOf({ F: ['甲', '乙', '丙'] });

  /** 语料形态：定义行 / 调用行 / 注释 / 屏蔽区 / 代码前缀 / CRLF 变体 */
  const LINES = [
    '@F(甲, 乙, 丙)',
    'CALL F, 1, 2, 3',
    '; 注释行',
    '[SKIPSTART]',
    'CALL F, 甲, 乙', // 屏蔽区内：全篇视角下一条都不给
    'CALL F, 9, 9',
    '[SKIPEND]',
    'CALL F, 1, 2',
    '  ;!; CALL F, 4, 5', // 代码前缀之后是真代码
    'CALL  , 1, 2', // 名字槽空
    'CALL F(1, 2)',
    'IF C[1] > 0',
    '[DIM 10]',
    '$LABEL',
    'CALL TRYCCALLLIST, 1',
    'CALL F, "a,b", ; 尾注释',
    '@G(甲)',
    '[SKIPSTART]',
    'CALL F, 7, 8',
  ];
  const LF = LINES.join('\n');
  const CRLF = LINES.join('\r\n');
  /** 末行没有换行符的形态（split 的最后一格是非空行） */
  const NO_TRAILING_NL = LINES.join('\n');

  const fullOf = (text: string) => callArgumentHints(text, slots);
  const windowOf = (text: string, from: number, to: number) => callArgumentHints(text, slots, { from, to });
  const expectSame = (text: string, label: string) => {
    const full = fullOf(text);
    expect(full.length, `${label}：全篇至少要有几条，否则这条恒等式是空转`).toBeGreaterThan(4);
    for (let from = 1; from <= LINES.length + 1; from++) {
      for (let to = from; to <= LINES.length + 2; to++) {
        expect(windowOf(text, from, to), `${label} 窗口 ${from}..${to}`).toEqual(
          full.filter((h) => h.line >= from && h.line <= to),
        );
      }
    }
  };

  it('LF：所有窗口都等于全篇按行过滤（含屏蔽区与代码前缀）', () => {
    expectSame(LF, 'LF');
  });

  it('CRLF：行边界按 `\\r\\n` 算，结果与 LF 逐条相同', () => {
    expectSame(CRLF, 'CRLF');
    expect(fullOf(CRLF)).toEqual(fullOf(LF));
  });

  it('末行无换行符 / 空文本 / 越界窗口', () => {
    expectSame(NO_TRAILING_NL, '末行无换行');
    expect(callArgumentHints('', slots, { from: 1, to: 10 })).toEqual([]);
    // 窗口整个落在文末之外 ⇒ 没有行可判，不是"整篇"
    expect(windowOf(LF, 100, 200)).toEqual([]);
    // 空区间 / NaN 窗口 ⇒ 空（不猜全篇）
    expect(windowOf(LF, 5, 4)).toEqual([]);
    expect(callArgumentHints(LF, slots, { from: Number.NaN, to: 5 })).toEqual([]);
    // `to = Infinity` 合法：走到文末
    expect(callArgumentHints(LF, slots, { from: 15, to: Number.POSITIVE_INFINITY })).toEqual(
      fullOf(LF).filter((h) => h.line >= 15),
    );
  });

  it('屏蔽区里一行都不给：整篇与任何覆盖它的窗口都一致（跨行状态没丢）', () => {
    const full = fullOf(LF);
    expect(full.some((h) => h.line >= 4 && h.line <= 7), '屏蔽区内不该有条目').toBe(false);
    for (let to = 4; to <= 7; to++) expect(windowOf(LF, 4, to)).toEqual([]);
  });

  /* ---------------- 起点偏移（R1 第二刀，2026-10-28） ----------------
   *
   * `fromOffset` 让供方跳过"数换行走位"（52,601 行文件上那是 2.2 ms），但它是**调用方
   * 递进来的坐标**——错了必须退回走位，绝不能静默按错的起点给答案。
   */

  const lineStartsOf = (text: string): number[] => {
    const out = [0];
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) out.push(at + 1);
    return out;
  };

  it('带上正确的起点偏移 ⇒ 与不带偏移逐条相同（LF / CRLF）', () => {
    for (const [text, label] of [
      [LF, 'LF'],
      [CRLF, 'CRLF'],
    ] as const) {
      const full = fullOf(text);
      const starts = lineStartsOf(text);
      for (let from = 1; from <= LINES.length + 1; from++) {
        for (let to = from; to <= LINES.length + 2; to++) {
          const window = { from, to, fromOffset: starts[from - 1] };
          expect(callArgumentHints(text, slots, window), `${label} 窗口 ${from}..${to}（带偏移）`).toEqual(
            full.filter((h) => h.line >= from && h.line <= to),
          );
        }
      }
    }
  });

  it('偏移给错就退回走位：行中间 / 不自洽 / 越界 / 指向 `\\n` 本身', () => {
    const full = fullOf(LF);
    const expected = (from: number, to: number) => full.filter((h) => h.line >= from && h.line <= to);
    const starts = lineStartsOf(LF);
    const at = (from: number, to: number, fromOffset: number) => callArgumentHints(LF, slots, { from, to, fromOffset });

    // 行中间（第 5 行行首再往后 3 个字符）：采信了就会把半行当整行
    expect(at(5, 12, starts[4]! + 3), '行中间').toEqual(expected(5, 12));
    // 与 from 不自洽：指向文首却声称第 9 行
    expect(at(9, 12, 0), '与 from 不自洽').toEqual(expected(9, 12));
    expect(at(5, 12, LF.length + 1), '越界').toEqual(expected(5, 12));
    expect(at(5, 12, -1), '负数').toEqual(expected(5, 12));
    expect(at(5, 12, Number.NaN), 'NaN').toEqual(expected(5, 12));
    expect(at(5, 12, Number.POSITIVE_INFINITY), 'Infinity').toEqual(expected(5, 12));
    // CRLF：指向 `\n` 本身（它前一个字符是 `\r`，不是行首）
    const crlfFull = fullOf(CRLF);
    expect(callArgumentHints(CRLF, slots, { from: 5, to: 12, fromOffset: lineStartsOf(CRLF)[4]! - 1 })).toEqual(
      crlfFull.filter((h) => h.line >= 5 && h.line <= 12),
    );
    // 第一行 + 偏移 0 是合法组合
    expect(at(1, 3, 0), '首行').toEqual(expected(1, 3));
  });
});
