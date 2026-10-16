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
      byName: new Map([
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
      ]),
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
