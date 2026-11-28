/**
 * `GETBIT` 位号值域诊断（`ERB_BUILTIN_ARG_RANGE`）——官方 `ArgIsOutOfRange` 口径。
 *
 * 真事故 CB-004 / CB-013：位号 64 / 150 直接抛 CodeEE；引擎硬限 0..63、不夹持
 * （1.824 `FunctionMethodCreator.cs:4785`、4.981 `Creator.Method.cs:5238-5247`）。
 * 只判**可证字面量**：变量 / 表达式不猜；整行注释与 `[SKIPSTART]` 死区由
 * `visibleCodeLines` 先滤掉——真语料那两处越界字面量恰好一个在死区、一个在注释里，
 * 故全量语料闸上本规则必须零命中。
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_ARG_RANGE_CODE, collectBuiltinArgDiagnostics } from '../src/builtins';

const run = (text: string, path = 'A.ERB', isUserFunction?: (name: string) => boolean) =>
  collectBuiltinArgDiagnostics({ path, text, ...(isUserFunction ? { isUserFunction } : {}) });

describe('GETBIT 位号值域（字面量）', () => {
  it('64 / 150 / -1 报 error，文案取引擎原话', () => {
    for (const bit of ['64', '150', '-1']) {
      const hit = run(`A = GETBIT(CFLAG:0, ${bit})\n`);
      expect(hit, bit).toHaveLength(1);
      expect(hit[0]!.severity).toBe('error');
      expect(hit[0]!.code).toBe(BUILTIN_ARG_RANGE_CODE);
      expect(hit[0]!.message).toContain(`GETBIT函数: 第2个参数(${bit})在从0到63的范围外`);
    }
  });

  it('边界 0 / 63 与动态位号不报', () => {
    for (const expr of ['0', '63', 'ARG', 'LOCAL + 1', 'CONST_BIT']) {
      expect(run(`A = GETBIT(CFLAG:0, ${expr})\n`), expr).toEqual([]);
    }
  });

  it('整行注释 / [SKIPSTART] 死区 / 非方言路径不报', () => {
    expect(run(';A = GETBIT(CFLAG:0, 64)\n')).toEqual([]);
    expect(run('[SKIPSTART]\nA = GETBIT(CFLAG:0, 64)\n[SKIPEND]\n')).toEqual([]);
    expect(run('A = GETBIT(CFLAG:0, 64)\n', 'A.kojo')).toEqual([]);
  });

  it('行内注释前的越界仍报，波浪线落在位号字面量上', () => {
    const hit = run('A = GETBIT(CFLAG:0, 64) ; 备注\n');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.startColumn).toBe(21); // 1 基：位号字面量 `64` 占第 21–22 列
    expect(hit[0]!.endColumn).toBe(23);   // 契约 end 不含
  });

  it('同名用户函数让位（影子）', () => {
    expect(run('A = GETBIT(CFLAG:0, 64)\n', 'A.ERB', (n) => n === 'GETBIT')).toEqual([]);
  });
});
