/**
 * 三值求值器单测（纯函数；合成读取器注入）。
 *
 * 覆盖：字面量 / 引用 / 比较 / 算术（C# 截断除法）/ 位运算（64 位 BigInt）/
 * 逻辑 Kleene 三值 / 字符串比较 / 能力边界降级（call / opaque / rename）/
 * 三元 / 条件判定（非零真值）。
 */
import { describe, expect, it } from 'vitest';
import type { ConditionExpr, ReplayValue, VariableRef } from '@kojo/plugin-api';
import { parseExpression } from '@kojo/plugin-condition-extractor';
import { evaluateExpr, judgeCondition, type ValueReader } from '../src/evaluate';

/** 合成读取器：values 命中 → 值；unknownRefs 命中 → unknown；其余 → 0 */
function makeReader(
  values: Record<string, number | string> = {},
  unknownRefs: Record<string, { code: string; message: string }> = {},
): ValueReader {
  return (ref: VariableRef): ReplayValue => {
    const key = ref.indices.length > 0 ? `${ref.name}:${ref.indices.join(':')}` : ref.name;
    if (key in values) return { kind: 'value', value: values[key]! };
    if (key in unknownRefs) {
      const u = unknownRefs[key]!;
      return { kind: 'unknown', unknown: { code: u.code as never, message: u.message } };
    }
    return { kind: 'value', value: 0 };
  };
}

const ev = (text: string, reader: ValueReader): ReplayValue => evaluateExpr(parseExpression(text), { read: reader });
const val = (v: ReplayValue): number | string => {
  if (v.kind !== 'value') throw new Error(`expected value, got unknown: ${JSON.stringify(v)}`);
  return v.value;
};

describe('evaluateExpr：基础', () => {
  it('字面量与引用', () => {
    const r = makeReader({ 'CFLAG:2': 800 });
    expect(val(ev('123', r))).toBe(123);
    expect(val(ev('-45', r))).toBe(-45);
    expect(val(ev('CFLAG:2', r))).toBe(800);
  });

  it('比较运算', () => {
    const r = makeReader({ 'CFLAG:2': 800 });
    expect(val(ev('CFLAG:2 >= 500', r))).toBe(1);
    expect(val(ev('CFLAG:2 < 800', r))).toBe(0);
    expect(val(ev('500 <= CFLAG:2', r))).toBe(1); // 字面量在左（翻转比较）
    expect(val(ev('CFLAG:2 == 800', r))).toBe(1);
    expect(val(ev('CFLAG:2 != 800', r))).toBe(0);
  });

  it('算术：C# long 截断除法', () => {
    const r = makeReader({});
    expect(val(ev('7 / 2', r))).toBe(3);
    expect(val(ev('-7 / 2', r))).toBe(-3); // 截断（非 floor）
    expect(val(ev('7 % 2', r))).toBe(1);
    expect(val(ev('2 + 3 * 4', r))).toBe(14);
  });

  it('算术：除零 → unknown', () => {
    const r = makeReader({});
    const v = ev('5 / 0', r);
    expect(v.kind).toBe('unknown');
    if (v.kind === 'unknown') expect(v.unknown.code).toBe('divide-by-zero');
  });

  it('位运算：64 位 BigInt 语义（JS 32 位陷阱）', () => {
    const r = makeReader({});
    expect(val(ev('1 << 40', r))).toBe(1099511627776); // 32 位会得 256
    expect(val(ev('~0', r))).toBe(-1);
    expect(val(ev('4294967296 & 4294967296', r))).toBe(4294967296); // 2^32
    expect(val(ev('1024 >> 2', r))).toBe(256);
  });

  it('位运算：移位计数按 C# long 语义 &63 掩码，绝不抛错（2026-10-16 修复）', () => {
    const r = makeReader({});
    // 负位移：C# count&63 → 1 << -1 ≡ 1 << 63 = Int64.MIN；旧实现裸 BigInt 位移抛 RangeError
    expect(val(ev('1 << -1', r))).toBe(-9223372036854775808);
    expect(val(ev('8 >> -1', r))).toBe(0); // 8 >> 63 = 0
    // 巨量位移：&63 后只做一次小位移，不分配巨量内存（999999999 & 63 = 63）
    expect(val(ev('1 << 999999999', r))).toBe(-9223372036854775808);
    expect(val(ev('1 << 64', r))).toBe(1); // 64 & 63 = 0
    expect(val(ev('1 << 65', r))).toBe(2); // 65 & 63 = 1
    // 结果包回 Int64：1 << 63 = Int64.MIN（不爆域）
    expect(val(ev('-1 >> 63', r))).toBe(-1); // 算术右移，符号保持
  });

  it('单目运算', () => {
    const r = makeReader({ 'CFLAG:2': 5 });
    expect(val(ev('!CFLAG:2', r))).toBe(0);
    expect(val(ev('!0', r))).toBe(1);
    expect(val(ev('-CFLAG:2', r))).toBe(-5);
  });
});

describe('evaluateExpr：逻辑 Kleene 三值', () => {
  const unknown = { 'X:0': { code: 'missing-var', message: '未知' } };

  it('false && unknown = false（短路确定）', () => {
    const r = makeReader({ 'CFLAG:2': 100 }, unknown);
    expect(val(ev('CFLAG:2 >= 500 && X:0 > 0', r))).toBe(0);
  });

  it('true || unknown = true（短路确定）', () => {
    const r = makeReader({ 'CFLAG:2': 800 }, unknown);
    expect(val(ev('CFLAG:2 >= 500 || X:0 > 0', r))).toBe(1);
  });

  it('unknown && false = false（右侧确定）', () => {
    const r = makeReader({ 'CFLAG:2': 100 }, unknown);
    expect(val(ev('X:0 > 0 && CFLAG:2 >= 500', r))).toBe(0);
  });

  it('true && unknown = unknown（传播）', () => {
    const r = makeReader({ 'CFLAG:2': 800 }, unknown);
    const v = ev('CFLAG:2 >= 500 && X:0 > 0', r);
    expect(v.kind).toBe('unknown');
  });

  it('!& / !| 的 Kleene 组合', () => {
    const r = makeReader({ 'CFLAG:2': 0 }, unknown);
    expect(val(ev('X:0 > 0 !& CFLAG:2 != 0', r))).toBe(1); // !(unknown && false) = 1
    expect(val(ev('X:0 > 0 !| CFLAG:2 >= 0', r))).toBe(0); // !(unknown || true) = 0
  });

  it('^^ 含 unknown → unknown', () => {
    const r = makeReader({ 'CFLAG:2': 1 }, unknown);
    const v = ev('CFLAG:2 >= 0 ^^ X:0 > 0', r);
    expect(v.kind).toBe('unknown');
  });

  it('全确定时逻辑输出 0/1', () => {
    const r = makeReader({});
    expect(val(ev('1 && 2', r))).toBe(1);
    expect(val(ev('0 && 2', r))).toBe(0);
    expect(val(ev('0 || 3', r))).toBe(1);
    expect(val(ev('1 ^^ 0', r))).toBe(1);
    expect(val(ev('1 !& 0', r))).toBe(1);
    expect(val(ev('0 !| 0', r))).toBe(1);
  });
});

describe('evaluateExpr：字符串与能力边界', () => {
  it('字符串 == / !=', () => {
    const r = makeReader({ ARGS: 'COM' });
    expect(val(ev('ARGS == "COM"', r))).toBe(1);
    expect(val(ev('ARGS == "com"', r))).toBe(0); // Ordinal 大小写敏感
    expect(val(ev('ARGS != "SCOM"', r))).toBe(1);
  });

  it('字符串序比较 → unknown(string-compare)', () => {
    const r = makeReader({ ARGS: 'COM' });
    const v = ev('ARGS > "ABC"', r);
    expect(v.kind).toBe('unknown');
    if (v.kind === 'unknown') expect(v.unknown.code).toBe('string-compare');
  });

  it('类型不匹配 → unknown(type)', () => {
    const r = makeReader({ ARGS: 'COM' });
    const v = ev('ARGS == 5', r);
    expect(v.kind).toBe('unknown');
    if (v.kind === 'unknown') expect(v.unknown.code).toBe('type');
  });

  it('函数调用 → unknown(call)', () => {
    const r = makeReader({});
    const v = ev('CHK_DATENOW() == 1', r);
    expect(v.kind).toBe('unknown');
    if (v.kind === 'unknown') expect(v.unknown.code).toBe('call');
  });

  it('rename 词 → unknown(rename)', () => {
    const r = makeReader({});
    const v = ev('[[呼び名]] == 1', r);
    expect(v.kind).toBe('unknown');
    if (v.kind === 'unknown') expect(v.unknown.code).toBe('rename');
  });

  it('逻辑运算要求数值（字符串参与）', () => {
    const r = makeReader({ ARGS: 'COM' });
    const v = ev('ARGS && 1', r);
    expect(v.kind).toBe('unknown');
    if (v.kind === 'unknown') expect(v.unknown.code).toBe('non-numeric');
  });
});

describe('evaluateExpr：三元', () => {
  it('条件确定 → 分支', () => {
    const r = makeReader({ 'CFLAG:2': 800 });
    expect(val(ev('CFLAG:2 >= 500 ? 10 : 20', r))).toBe(10);
    expect(val(ev('CFLAG:2 < 500 ? 10 : 20', r))).toBe(20);
  });

  it('条件 unknown 但两分支相等 → 该值', () => {
    const r = makeReader({}, { 'X:0': { code: 'missing-var', message: '未知' } });
    expect(val(ev('X:0 > 0 ? 7 : 7', r))).toBe(7);
  });

  it('条件 unknown 且分支不等 → unknown', () => {
    const r = makeReader({}, { 'X:0': { code: 'missing-var', message: '未知' } });
    const v = ev('X:0 > 0 ? 7 : 8', r);
    expect(v.kind).toBe('unknown');
  });
});

describe('judgeCondition：三值判定', () => {
  it('数值非零为真 / 零为假', () => {
    const r = makeReader({ 'CFLAG:2': 1 });
    expect(judgeCondition(parseExpression('CFLAG:2'), { read: r }).kind).toBe('true');
    expect(judgeCondition(parseExpression('0'), { read: r }).kind).toBe('false');
    expect(judgeCondition(parseExpression('1 - 1'), { read: r }).kind).toBe('false');
    expect(judgeCondition(parseExpression('-1'), { read: r }).kind).toBe('true');
  });

  it('字符串条件 → unknown(non-numeric)', () => {
    const r = makeReader({ ARGS: 'COM' });
    const o = judgeCondition(parseExpression('ARGS'), { read: r });
    expect(o.kind).toBe('unknown');
    if (o.kind === 'unknown') expect(o.unknown.code).toBe('non-numeric');
  });

  it('未知引用传播', () => {
    const r = makeReader({}, { 'X:0': { code: 'missing-var', message: '未知' } });
    const o = judgeCondition(parseExpression('X:0 == 1'), { read: r });
    expect(o.kind).toBe('unknown');
  });
});
