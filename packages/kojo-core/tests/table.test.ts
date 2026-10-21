/**
 * `# 表` 静态校验 + 降糖计划单测（§6 / §11.3）。
 *
 * 钉的判据：静态非重叠（闭/开/精确同一套判交）、`否` 最后且非空、
 * 值列同类型、端点只能是十进制字面量/整数常量、静态可证 from>to、
 * 落点 selectcase/if、隐藏槽 `__kojo_table_*`、有 error 不产半成品 plan。
 */
import { describe, expect, it } from 'vitest';
import type { KojoConstDecl, KojoExprText, KojoLiteral, KojoSpan, KojoTableDecl, KojoTableRow } from '../src/ast.js';
import { collectIntegerConstants, tableSlotName, validateTable } from '../src/table.js';

const span = (line: number, column = 1): KojoSpan => ({
  start: { line, column },
  end: { line, column: column + 8 },
});

const expr = (text: string, line = 1): KojoExprText => ({
  text,
  span: { start: { line, column: 1 }, end: { line, column: 1 + text.length } },
});

const row = (from: string | null, to: string | null, value: KojoLiteral, line: number): KojoTableRow => ({
  from: from === null ? null : expr(from, line),
  to: to === null ? null : expr(to, line),
  value,
  span: span(line),
});

function table(rows: readonly KojoTableRow[], name = '心情'): KojoTableDecl {
  return {
    kind: 'table',
    name,
    subject: expr('恋慕', 1),
    rows,
    span: { start: { line: 1, column: 1 }, end: { line: 1 + rows.length + 1, column: 1 } },
  };
}

const codes = (result: ReturnType<typeof validateTable>): readonly string[] =>
  result.diagnostics.map((d) => d.code);

describe('validateTable · 合法表 → 纯数据 plan', () => {
  it('闭区间 + 常量端点 + 否 兜底：落 if（有开放区间），槽名 __kojo_table_*', () => {
    const constants = new Map([['亲近线', 500]]);
    const result = validateTable(
      table([
        row('0', '99', '疏远', 4),
        row('100', '499', '平常', 5),
        row('亲近线', null, '亲近', 6),
        row(null, null, '未知', 7),
      ]),
      { integerConstants: constants },
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    const plan = result.plan!;
    expect(plan.slot).toBe('__kojo_table_心情');
    expect(plan.name).toBe('心情');
    expect(plan.valueType).toBe('string');
    expect(plan.defaultRow).toBe(3);
    expect(plan.landing).toBe('if'); // `亲近线..` 是开放区间 ⇒ IF 链
    expect(plan.rows.map((r) => r.shape)).toEqual(['closed', 'closed', 'at-least', 'default']);
    expect(plan.rows[2]).toMatchObject({ from: 500, to: null });
  });

  it('全闭区间/精确值 → 落 selectcase', () => {
    const result = validateTable(
      table([
        row('0', '99', 1, 3),
        row('100', '100', 2, 4),
        row(null, null, 0, 5),
      ]),
    );
    expect(result.ok).toBe(true);
    expect(result.plan!.landing).toBe('selectcase');
    expect(result.plan!.rows.map((r) => r.shape)).toEqual(['closed', 'exact', 'default']);
  });

  it('精确值 = 两端同值的退化闭区间；类型同质（整数）', () => {
    const result = validateTable(table([row('5', '5', 10, 3), row(null, null, 0, 4)]));
    expect(result.ok).toBe(true);
    expect(result.plan!.valueType).toBe('int');
    expect(result.plan!.rows[0]).toMatchObject({ shape: 'exact', from: 5, to: 5 });
  });

  it('相邻端点不算重叠；allow 空洞', () => {
    const result = validateTable(
      table([row('0', '99', '甲', 3), row('100', '199', '乙', 4), row(null, null, '丙', 5)]),
    );
    expect(result.ok).toBe(true);
  });

  it('自定义隐藏槽前缀', () => {
    const result = validateTable(table([row('0', '1', '甲', 3), row(null, null, '乙', 4)]), { slotPrefix: '__x_' });
    expect(result.plan!.slot).toBe('__x_心情');
    expect(tableSlotName('甲')).toBe('__kojo_table_甲');
  });
});

describe('validateTable · 重叠（闭/开/精确统一判交）', () => {
  const overlapOf = (rows: readonly KojoTableRow[]): number => codes(validateTable(table(rows))).filter((c) => c === 'core/table/overlap').length;

  it('闭区间重叠', () => {
    expect(overlapOf([row('0', '100', '甲', 3), row('50', '150', '乙', 4), row(null, null, '丙', 5)])).toBe(1);
  });

  it('端点相等也重叠（闭区间共享端点）', () => {
    expect(overlapOf([row('0', '100', '甲', 3), row('100', '200', '乙', 4), row(null, null, '丙', 5)])).toBe(1);
  });

  it('开放区间与闭区间重叠', () => {
    expect(overlapOf([row('0', '100', '甲', 3), row('50', null, '乙', 4), row(null, null, '丙', 5)])).toBe(1);
    expect(overlapOf([row(null, '100', '甲', 3), row('50', '150', '乙', 4), row(null, null, '丙', 5)])).toBe(1);
  });

  it('精确值落在区间内也是重叠；落在区间外不重叠', () => {
    expect(overlapOf([row('0', '100', '甲', 3), row('50', '50', '乙', 4), row(null, null, '丙', 5)])).toBe(1);
    expect(overlapOf([row('0', '100', '甲', 3), row('150', '150', '乙', 4), row(null, null, '丙', 5)])).toBe(0);
  });

  it('两个开放区间互相重叠', () => {
    expect(overlapOf([row('100', null, '甲', 3), row('500', null, '乙', 4), row(null, null, '丙', 5)])).toBe(1);
    expect(overlapOf([row(null, '100', '甲', 3), row(null, '50', '乙', 4), row(null, null, '丙', 5)])).toBe(1);
  });

  it('重叠诊断指向后出现的那行，消息列出两段源写法', () => {
    const result = validateTable(table([row('0', '100', '甲', 3), row('50', '150', '乙', 4), row(null, null, '丙', 5)]));
    const overlap = result.diagnostics.find((d) => d.code === 'core/table/overlap')!;
    expect(overlap.span?.start.line).toBe(4);
    expect(overlap.message).toContain('0..100');
    expect(overlap.message).toContain('50..150');
    expect(result.plan).toBeNull();
    expect(result.ok).toBe(false);
  });

  it('诊断按源顺序稳定排列（作者写什么顺序，诊断就按什么顺序）', () => {
    const result = validateTable(
      table([row('0', '100', '甲', 3), row('50', '150', '乙', 4), row('10', '20', '丙', 5)]),
    );
    expect(result.diagnostics.map((d) => d.span?.start.line)).toEqual([1, 4, 5]);
  });
});

describe('validateTable · 否 / 值 / 类型 / 端点', () => {
  it('缺 否 → missing-default', () => {
    const result = validateTable(table([row('0', '99', '甲', 3)]));
    expect(codes(result)).toContain('core/table/missing-default');
    expect(result.plan).toBeNull();
  });

  it('否 不在最后 → default-not-last', () => {
    const result = validateTable(table([row(null, null, '甲', 3), row('0', '99', '乙', 4)]));
    expect(codes(result)).toContain('core/table/default-not-last');
  });

  it('重复 否 → default-not-last', () => {
    const result = validateTable(table([row('0', '99', '甲', 3), row(null, null, '乙', 4), row(null, null, '丙', 5)]));
    expect(codes(result).filter((c) => c === 'core/table/default-not-last').length).toBe(1);
  });

  it('否 为空值 → empty-default', () => {
    const result = validateTable(table([row('0', '99', '甲', 3), row(null, null, '', 4)]));
    expect(codes(result)).toContain('core/table/empty-default');
  });

  it('普通行空值 → value-empty', () => {
    const result = validateTable(table([row('0', '99', '', 3), row(null, null, '乙', 4)]));
    expect(codes(result)).toContain('core/table/value-empty');
  });

  it('值类型混用 → type-mismatch', () => {
    const result = validateTable(table([row('0', '99', '甲', 3), row('100', '199', 2, 4), row(null, null, '丙', 5)]));
    expect(codes(result)).toContain('core/table/type-mismatch');
    expect(result.plan).toBeNull();
  });

  it('端点不是字面量/整数常量（变量、函数调用、算术）→ dynamic-endpoint', () => {
    for (const end of ['恋慕', 'len(1)', '1 + 2', '0x10']) {
      const result = validateTable(table([row(end, '99', '甲', 3), row(null, null, '乙', 4)]));
      expect(codes(result), end).toContain('core/table/dynamic-endpoint');
    }
  });

  it('标识符但不在常量表 → dynamic-endpoint；在常量表 → 可求值', () => {
    const decl: KojoTableDecl = table([row('亲近线', '99', '甲', 3), row(null, null, '乙', 4)]);
    expect(codes(validateTable(decl))).toContain('core/table/dynamic-endpoint');
    expect(validateTable(decl, { integerConstants: new Map([['亲近线', 10]]) }).ok).toBe(true);
  });

  it('超出安全整数范围 → dynamic-endpoint（不静默舍入）', () => {
    const result = validateTable(table([row('99999999999999999999', '99999999999999999999', '甲', 3), row(null, null, '乙', 4)]));
    expect(codes(result)).toContain('core/table/dynamic-endpoint');
  });

  it('静态可证 from > to → bad-range（不是 overlap）', () => {
    const result = validateTable(table([row('100', '0', '甲', 3), row(null, null, '乙', 4)]));
    expect(codes(result)).toContain('core/table/bad-range');
    expect(codes(result)).not.toContain('core/table/overlap');
  });

  it('没有数据行 → no-rows', () => {
    const result = validateTable(table([]));
    expect(codes(result)).toEqual(['core/table/no-rows']);
    expect(result.plan).toBeNull();
  });
});

describe('table 辅助', () => {
  it('collectIntegerConstants：只收整数常量，字符串/非安全整数不收', () => {
    const decls: Pick<KojoConstDecl, 'name' | 'valueType' | 'value'>[] = [
      { name: '甲', valueType: 'int', value: 10 },
      { name: '乙', valueType: 'string', value: '10' },
      { name: '丙', valueType: 'int', value: Number.MAX_SAFE_INTEGER + 10 },
    ];
    const map = collectIntegerConstants(decls);
    expect([...map.entries()]).toEqual([['甲', 10]]);
  });
});
