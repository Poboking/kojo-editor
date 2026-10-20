import { describe, expect, it } from 'vitest';
import { parseExpression, splitTopLevelCommas, walkExpr } from '../src/expr';

describe('parseExpression · 基本形式', () => {
  it('变量引用与数字比较', () => {
    expect(parseExpression('CFLAG:2 >= 500')).toEqual({
      kind: 'binary',
      op: '>=',
      left: { kind: 'ref', name: 'CFLAG', indices: ['2'], text: 'CFLAG:2' },
      right: { kind: 'literal', value: 500, text: '500' },
    });
  });

  it('多段索引（角色变量 CFLAG:ARG:口上セレクタ）', () => {
    const e = parseExpression('CFLAG:ARG:口上セレクタ == 1');
    expect(e).toEqual({
      kind: 'binary',
      op: '==',
      left: { kind: 'ref', name: 'CFLAG', indices: ['ARG', '口上セレクタ'], text: 'CFLAG:ARG:口上セレクタ' },
      right: { kind: 'literal', value: 1, text: '1' },
    });
  });

  it('日文具名索引与变量名（真实语料）', () => {
    const e = parseExpression('BASE:酒気 > (MAXBASE:酒気 / 10) * 8');
    expect(e.kind).toBe('binary');
    const refs: string[] = [];
    walkExpr(e, (n) => {
      if (n.kind === 'ref') refs.push(n.text);
    });
    expect(refs).toEqual(['BASE:酒気', 'MAXBASE:酒気']);
  });

  it('无索引变量（LOCAL / FLAG:70）', () => {
    expect(parseExpression('LOCAL')).toEqual({ kind: 'ref', name: 'LOCAL', indices: [], text: 'LOCAL' });
    expect(parseExpression('FLAG:70')).toEqual({ kind: 'ref', name: 'FLAG', indices: ['70'], text: 'FLAG:70' });
  });

  it('逻辑与算术优先级（引擎权威表：* 90 > + 80 > > 65 > && 40）', () => {
    const e = parseExpression('A + 1 * 2 > B && C');
    // 期望 ((A + (1*2)) > B) && C
    expect(e).toEqual({
      kind: 'binary',
      op: '&&',
      left: {
        kind: 'binary',
        op: '>',
        left: {
          kind: 'binary',
          op: '+',
          left: { kind: 'ref', name: 'A', indices: [], text: 'A' },
          right: {
            kind: 'binary',
            op: '*',
            left: { kind: 'literal', value: 1, text: '1' },
            right: { kind: 'literal', value: 2, text: '2' },
          },
        },
        right: { kind: 'ref', name: 'B', indices: [], text: 'B' },
      },
      right: { kind: 'ref', name: 'C', indices: [], text: 'C' },
    });
  });

  it('|| 与 && 同优先级（40）左结合（引擎语义）', () => {
    const e = parseExpression('A || B && C');
    // (A || B) && C —— 同优先级左结合
    expect(e).toMatchObject({ kind: 'binary', op: '&&', left: { kind: 'binary', op: '||' } });
  });

  it('一元 ! / 负号', () => {
    expect(parseExpression('!KOJO_VALID')).toEqual({
      kind: 'unary',
      op: '!',
      operand: { kind: 'ref', name: 'KOJO_VALID', indices: [], text: 'KOJO_VALID' },
    });
    expect(parseExpression('-3')).toEqual({ kind: 'unary', op: '-', operand: { kind: 'literal', value: 3, text: '3' } });
  });

  it('函数调用（GROUPMATCH / 嵌套）', () => {
    const e = parseExpression('GROUPMATCH(ARGS, "COMMAND", "COM")');
    expect(e).toEqual({
      kind: 'call',
      name: 'GROUPMATCH',
      args: [
        { kind: 'ref', name: 'ARGS', indices: [], text: 'ARGS' },
        { kind: 'literal', value: 'COMMAND', text: '"COMMAND"' },
        { kind: 'literal', value: 'COM', text: '"COM"' },
      ],
    });
  });

  it('字符串字面量：含转义与分号原样', () => {
    expect(parseExpression('STR == "a;b"')).toMatchObject({
      right: { kind: 'literal', value: 'a;b' },
    });
    expect(parseExpression('STR == "say \\"hi\\""')).toMatchObject({
      right: { kind: 'literal', value: 'say "hi"' },
    });
  });

  it('0x 十六进制字面量', () => {
    expect(parseExpression('X & 0x10')).toMatchObject({ right: { kind: 'literal', value: 16, text: '0x10' } });
  });

  it('括号改变结合', () => {
    const e = parseExpression('(A || B) && C');
    expect(e).toMatchObject({ kind: 'binary', op: '&&', left: { kind: 'binary', op: '||' } });
  });

  it('三元（? :）', () => {
    const e = parseExpression('A ? 1 : 2');
    expect(e).toMatchObject({ kind: 'ternary', cond: { name: 'A' } });
  });

  it('位运算与移位（引擎优先级）', () => {
    const e = parseExpression('GETBIT(FLAG:99, 0) && !GETBIT(CFLAG:526, 0)');
    expect(e).toMatchObject({ kind: 'binary', op: '&&' });
    const e2 = parseExpression('X << 2 & 0xff');
    // << (70) 高于 & (50)： (X << 2) & 0xff
    expect(e2).toMatchObject({ kind: 'binary', op: '&', left: { kind: 'binary', op: '<<' } });
  });

  it('rename 语法 [[词]]：索引段保留原文（真实语料）', () => {
    // TALENT:[[琪斯美]]:恋慕 —— 双括号段保留原文
    expect(parseExpression('TALENT:[[琪斯美]]:恋慕')).toEqual({
      kind: 'ref',
      name: 'TALENT',
      indices: ['[[琪斯美]]', '恋慕'],
      text: 'TALENT:[[琪斯美]]:恋慕',
    });
  });

  it('[[词]] 作为独立值与函数参数', () => {
    expect(parseExpression('FLAG:デート相手 == [[依姫]]')).toEqual({
      kind: 'binary',
      op: '==',
      left: { kind: 'ref', name: 'FLAG', indices: ['デート相手'], text: 'FLAG:デート相手' },
      right: { kind: 'nameValue', name: '依姫', text: '[[依姫]]' },
    });
    expect(parseExpression('IS_HERE([[蓮子]])')).toEqual({
      kind: 'call',
      name: 'IS_HERE',
      args: [{ kind: 'nameValue', name: '蓮子', text: '[[蓮子]]' }],
    });
  });

  it('括号索引段：原文切片保留（YOGORE:(...) 真实语料）', () => {
    const e = parseExpression('YOGORE:(GET_CHARAHOME(TARGET)) < 1000');
    expect(e).toEqual({
      kind: 'binary',
      op: '<',
      left: { kind: 'ref', name: 'YOGORE', indices: ['(GET_CHARAHOME(TARGET))'], text: 'YOGORE:(GET_CHARAHOME(TARGET))' },
      right: { kind: 'literal', value: 1000, text: '1000' },
    });
    // TALENT:(NO:30):恋慕
    expect(parseExpression('TALENT:(NO:30):恋慕')).toMatchObject({
      kind: 'ref',
      indices: ['(NO:30)', '恋慕'],
    });
  });
});

describe('parseExpression · p 指数位标志字面量（引擎 ReadInt64：ApN = A×2^N）', () => {
  it('1p3 = 8：位与运算（真实语料残余形态）', () => {
    expect(parseExpression('1p3')).toEqual({ kind: 'literal', value: 8, text: '1p3' });
    expect(parseExpression('FLAG:甲斐性無 & 1p3')).toMatchObject({
      kind: 'binary',
      op: '&',
      left: { kind: 'ref', name: 'FLAG' },
      right: { kind: 'literal', value: 8, text: '1p3' },
    });
  });

  it('参与比较：括号位与后 != 0', () => {
    const e = parseExpression('(CFLAG:2 & 1p4) != 0');
    expect(e).toMatchObject({
      kind: 'binary',
      op: '!=',
      left: { kind: 'binary', op: '&', right: { kind: 'literal', value: 16 } },
      right: { kind: 'literal', value: 0 },
    });
  });

  it('多位标志或 / 通用底数 ApN', () => {
    // 引擎语义不限于 1：readDigits 的全部位作 significand
    expect(parseExpression('FLAG:9 & (1p0 | 2p3)')).toMatchObject({
      right: { kind: 'binary', op: '|', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 16 } },
    });
    expect(parseExpression('1p1 == 2')).toMatchObject({
      left: { kind: 'literal', value: 2, text: '1p1' },
    });
    expect(parseExpression('10p1')).toEqual({ kind: 'literal', value: 20, text: '10p1' });
  });

  it('大小写（引擎读 p 也读 P）', () => {
    expect(parseExpression('1P3')).toEqual({ kind: 'literal', value: 8, text: '1P3' });
  });

  it('降级口径不变：p 后无数字 / 超出 64 位范围 / 非数字尾巴 → opaque', () => {
    expect(parseExpression('1p')).toEqual({ kind: 'opaque', text: '1p' });
    expect(parseExpression('1p63')).toEqual({ kind: 'opaque', text: '1p63' }); // 2^63 > Int64.MaxValue
    expect(parseExpression('1p100')).toEqual({ kind: 'opaque', text: '1p100' });
    expect(parseExpression('1pABC')).toEqual({ kind: 'opaque', text: '1pABC' });
    expect(parseExpression('1abc')).toEqual({ kind: 'opaque', text: '1abc' });
  });

  it('p 指数与 e 指数不串味', () => {
    // e 仍是十进制指数（既有口径），p 段不抢
    expect(parseExpression('2e3')).toEqual({ kind: 'literal', value: 2000, text: '2e3' });
  });
});

describe('parseExpression · 顶层行尾逗号（引擎 ReduceArguments(EoL)：行尾逗号静默容忍）', () => {
  it('真实语料残余形态 `SIF FLAG:甲斐性無,` → 条件即 FLAG:甲斐性無', () => {
    expect(parseExpression('FLAG:甲斐性無,')).toEqual({
      kind: 'ref',
      name: 'FLAG',
      indices: ['甲斐性無'],
      text: 'FLAG:甲斐性無',
    });
    expect(parseExpression('TALENT:恋慕 && CFLAG:2 >= 500,')).toMatchObject({
      kind: 'binary',
      op: '&&',
      right: { kind: 'binary', op: '>=' },
    });
  });

  it('逗号后还有内容（`A, B`）引擎报引数过多 → 照旧 opaque', () => {
    expect(parseExpression('A, B')).toEqual({ kind: 'opaque', text: 'A, B' });
    expect(parseExpression('A,,B')).toEqual({ kind: 'opaque', text: 'A,,B' });
  });
});

describe('parseExpression · 包容降级（绝不抛错）', () => {
  it('赋值形式 → opaque', () => {
    expect(parseExpression('X = 1')).toEqual({ kind: 'opaque', text: 'X = 1' });
  });

  it('空串 / 残缺 / 非法字符 → opaque', () => {
    expect(parseExpression('')).toEqual({ kind: 'opaque', text: '' });
    expect(parseExpression('A &&')).toEqual({ kind: 'opaque', text: 'A &&' });
    expect(parseExpression('A $ B')).toEqual({ kind: 'opaque', text: 'A $ B' });
    expect(parseExpression('1abc')).toEqual({ kind: 'opaque', text: '1abc' });
  });

  it('未闭合字符串 → opaque', () => {
    expect(parseExpression('STR == "abc')).toEqual({ kind: 'opaque', text: 'STR == "abc' });
  });

  it('多余 token（trailing）→ opaque', () => {
    expect(parseExpression('A B')).toEqual({ kind: 'opaque', text: 'A B' });
  });
});

describe('splitTopLevelCommas', () => {
  it('基础切分与引号/括号感知', () => {
    expect(splitTopLevelCommas('1, 2, 3')).toEqual(['1', ' 2', ' 3']);
    expect(splitTopLevelCommas('"a,b", c')).toEqual(['"a,b"', ' c']);
    expect(splitTopLevelCommas('FUNC(1, 2), X')).toEqual(['FUNC(1, 2)', ' X']);
  });

  it('无逗号单值', () => {
    expect(splitTopLevelCommas('10 TO 20')).toEqual(['10 TO 20']);
  });
});
