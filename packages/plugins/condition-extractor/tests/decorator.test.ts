import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement } from '@kojo/plugin-api';
import { collectExprSyntaxDecorations } from '../src/decorator';

/** 手造一条控制流语句（只填本测试关心的字段；depth 与过滤无关，恒 0）。 */
function stmt(kind: string, expression: string, line: number): ControlFlowStatement {
  return { kind, expression, depth: 0, line };
}

/**
 * 假扫描器：无视文本、直接返回预置语句表。
 * 本测试只验 `collectExprSyntaxDecorations` 的**过滤 / 排序 / 去重**口径，
 * 骨架扫描本身由 erb-parser 的测试覆盖——所以这里不打桩那个真实实现。
 */
function fakeScan(
  statements: readonly ControlFlowStatement[],
): (text: string) => readonly ControlFlowStatement[] {
  return () => statements;
}

describe('collectExprSyntaxDecorations · 过滤口径', () => {
  it('IF/ELSEIF/SIF/WHILE/SELECTCASE 上的非法表达式 → 报（warning 语义）', () => {
    // 非法样例照 expr.ts 的实际语法构造：非法字符（A $ B）/ 括号不闭合（(A）
    // 注意：行尾悬空运算符（`A &&`）自 2026-10-19 起按续行 fail-open（见 expr-diagnostic.test.ts）
    const out = collectExprSyntaxDecorations(
      'x',
      fakeScan([
        stmt('IF', 'A $ B', 1),
        stmt('ELSEIF', '(A', 2),
        stmt('SIF', '(A', 3),
        stmt('WHILE', 'A $ B', 4),
        stmt('SELECTCASE', 'A $ B', 5),
      ]),
    );
    expect(out.map((d) => d.line)).toEqual([1, 2, 3, 4, 5]);
    for (const d of out) {
      expect(d.message.length).toBeGreaterThan(0);
      expect(d.code).toMatch(/^erb\.expr-(lexical|syntax)$/);
    }
  });

  it('CASE / PRINTDATA 等（逗号列表 / 范围写法）→ 不报', () => {
    const out = collectExprSyntaxDecorations(
      'x',
      fakeScan([stmt('CASE', 'A $ B', 1), stmt('PRINTDATA', 'A $ B', 2)]),
    );
    expect(out).toEqual([]);
  });

  it('expression 为空 / 只有空白 → 不报', () => {
    const out = collectExprSyntaxDecorations(
      'x',
      fakeScan([stmt('IF', '', 1), stmt('WHILE', '   ', 2), stmt('SIF', '\t', 3)]),
    );
    expect(out).toEqual([]);
  });

  it('合法条件 → 不报', () => {
    const out = collectExprSyntaxDecorations(
      'x',
      fakeScan([
        stmt('IF', 'CFLAG:2 >= 500', 1),
        stmt('ELSEIF', 'TALENT:恋慕', 2),
        stmt('WHILE', 'A && B', 3),
        stmt('SELECTCASE', 'GROUPMATCH(ARGS, "COMMAND", "COM")', 4),
      ]),
    );
    expect(out).toEqual([]);
  });

  it('文本为空 → 返回 []', () => {
    expect(collectExprSyntaxDecorations('', fakeScan([stmt('IF', 'A $ B', 1)]))).toEqual([]);
  });

  it('返回按行号升序（与语句扫描顺序无关）', () => {
    const out = collectExprSyntaxDecorations(
      'x',
      fakeScan([stmt('IF', '(A', 9), stmt('IF', '(A', 3), stmt('WHILE', '(A', 7)]),
    );
    expect(out.map((d) => d.line)).toEqual([3, 7, 9]);
  });

  it('同一行多条 → 只留第一条', () => {
    const out = collectExprSyntaxDecorations(
      'x',
      fakeScan([stmt('IF', 'A $ B', 5), stmt('SIF', '(A', 5)]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.line).toBe(5);
  });

  it('列区间：表达式内偏移 + 行内起点 → 1 基 UTF-16 半开区间', () => {
    const text = 'PRINTL 甲\n\tSIF A $ B\n';
    const out = collectExprSyntaxDecorations(text, fakeScan([stmt('SIF', 'A $ B', 2)]));
    expect(out).toHaveLength(1);
    // 行 = `\tSIF A $ B`：表达式 `A $ B` 从 0 基 5 起，`$` 在表达式内偏移 2 ⇒ 起点列 8
    expect(out[0]!.startColumn).toBe(8);
    expect(out[0]!.endColumn).toBe(9);
  });

  it('定位不到表达式（假扫描器给的行号不在文本里）→ 不给列号，退回整行', () => {
    const out = collectExprSyntaxDecorations('x', fakeScan([stmt('IF', 'A $ B', 9)]));
    expect(out).toHaveLength(1);
    expect(out[0]!.startColumn).toBeUndefined();
    expect(out[0]!.endColumn).toBeUndefined();
  });

  it('反证：真错 `IF (1 + ) == 0` 仍报（装饰链不许把诊断整体关掉）', () => {
    const out = collectExprSyntaxDecorations(
      'IF (1 + ) == 0\n',
      fakeScan([stmt('IF', '(1 + ) == 0', 1)]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe('erb.expr-syntax');
    // 多出来的 `)` 在表达式内偏移 5；`IF ` 占 3 列 ⇒ 1 基列 9
    expect(out[0]!.startColumn).toBe(9);
  });

  it('扫描器抛错 → 不抛错、返回 []（本函数不得抛错）', () => {
    const boom = (): readonly ControlFlowStatement[] => {
      throw new Error('boom');
    };
    expect(collectExprSyntaxDecorations('x', boom)).toEqual([]);
  });
});
