import { describe, expect, it } from 'vitest';
import { diagnoseExpression, parseExpression } from '../src/expr';

describe('diagnoseExpression · 合法条件 → null', () => {
  it('比较与逻辑运算', () => {
    expect(diagnoseExpression('CFLAG:2 >= 500 && TALENT:恋慕')).toBeNull();
  });

  it('含括号 / 三元 / 字符串', () => {
    expect(diagnoseExpression('(A || B) && C')).toBeNull();
    expect(diagnoseExpression('A ? 1 : 2')).toBeNull();
    expect(diagnoseExpression('GROUPMATCH(ARGS, "COMMAND", "COM")')).toBeNull();
    expect(diagnoseExpression('STR == "a;b"')).toBeNull();
    expect(diagnoseExpression('STR == "say \\"hi\\""')).toBeNull();
  });

  it('rename 语法与具名索引（真实语料）', () => {
    expect(diagnoseExpression('TALENT:[[琪斯美]]:恋慕')).toBeNull();
    expect(diagnoseExpression('BASE:酒気 > (MAXBASE:酒気 / 10) * 8')).toBeNull();
  });

  it('空串 / 纯空白（含全角空格）→ null', () => {
    expect(diagnoseExpression('')).toBeNull();
    expect(diagnoseExpression('   ')).toBeNull();
    expect(diagnoseExpression('\u3000\t ')).toBeNull();
  });
});

describe('diagnoseExpression · 词法错 → lexical', () => {
  it('未知字符', () => {
    expect(diagnoseExpression('A $ B')).toMatchObject({ kind: 'lexical' });
  });

  it('字符串引号未闭合', () => {
    expect(diagnoseExpression('STR == "abc')).toMatchObject({ kind: 'lexical' });
  });

  it('[[ 未闭合', () => {
    expect(diagnoseExpression('TALENT:[[琪斯美')).toMatchObject({ kind: 'lexical' });
  });

  it('非法数字（小数点不受支持）', () => {
    expect(diagnoseExpression('12.5')).toMatchObject({ kind: 'lexical' });
  });
});

describe('diagnoseExpression · 语法错 → syntax', () => {
  it('悬空运算符 / 缺操作数', () => {
    expect(diagnoseExpression('A &&')).toMatchObject({ kind: 'syntax' });
    expect(diagnoseExpression('A && * B')).toMatchObject({ kind: 'syntax' });
  });

  it('括号不配对', () => {
    expect(diagnoseExpression('(A B)')).toMatchObject({ kind: 'syntax' });
    expect(diagnoseExpression('FUNC(A B)')).toMatchObject({ kind: 'syntax' });
    expect(diagnoseExpression('YOGORE:(A')).toMatchObject({ kind: 'syntax' });
  });

  it('多余右括号 / 多余 token', () => {
    expect(diagnoseExpression('A)')).toMatchObject({ kind: 'syntax' });
    expect(diagnoseExpression('A B')).toMatchObject({ kind: 'syntax' });
    expect(diagnoseExpression('1abc')).toMatchObject({ kind: 'syntax' });
  });

  it('三元缺少中间的冒号', () => {
    expect(diagnoseExpression('A ? 1 2')).toMatchObject({ kind: 'syntax' });
  });

  it('冒号后索引写法不对', () => {
    expect(diagnoseExpression('FLAG:=')).toMatchObject({ kind: 'syntax' });
  });
});

describe('diagnoseExpression · message 为面向作者的中文', () => {
  it('词法 / 语法各有可读措辞', () => {
    expect(diagnoseExpression('A $ B')?.message).toContain('字符');
    expect(diagnoseExpression('STR == "abc')?.message).toContain('引号');
    expect(diagnoseExpression('A &&')?.message.length).toBeGreaterThan(0);
    expect(diagnoseExpression('A)')?.message).toBe('多了一个右括号');
  });

  it('绝不抛错（对任意输入）', () => {
    for (const s of ['\u0000', ')(', '?', ':::', '"', '[[', '   X   ']) {
      expect(() => diagnoseExpression(s)).not.toThrow();
    }
  });
});

describe('回归 · parseExpression 仍降级 opaque、绝不抛错', () => {
  const inputs = [
    '',
    'A &&',
    'A $ B',
    'A B',
    '1abc',
    'STR == "abc',
    'A)',
    '(A B)',
    'FUNC(A B)',
    'A ? 1 2',
    'TALENT:[[琪斯美',
    '12.5',
    'A && * B',
    'FLAG:=',
    'YOGORE:(A',
  ];

  it('同一批输入全部返回 opaque 且不抛', () => {
    for (const s of inputs) {
      expect(() => parseExpression(s)).not.toThrow();
      expect(parseExpression(s)).toEqual({ kind: 'opaque', text: s });
    }
  });
});
