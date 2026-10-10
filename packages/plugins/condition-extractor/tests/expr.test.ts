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
