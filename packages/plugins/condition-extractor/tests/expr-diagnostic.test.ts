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
  it('悬空运算符 / 缺操作数（行尾续写另见 fail-open）', () => {
    expect(diagnoseExpression('A && * B')).toMatchObject({ kind: 'syntax' });
    expect(diagnoseExpression('A + == B')).toMatchObject({ kind: 'syntax' });
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
    expect(diagnoseExpression('A && * B')?.message.length).toBeGreaterThan(0);
    expect(diagnoseExpression('A)')?.message).toBe('多了一个右括号');
  });

  it('绝不抛错（对任意输入）', () => {
    for (const s of ['\u0000', ')(', '?', ':::', '"', '[[', '   X   ']) {
      expect(() => diagnoseExpression(s)).not.toThrow();
    }
  });
});

describe('真实语料形态 · 零误报（2026-10-19 表达式层收口批）', () => {
  it('@"…" 逐字串：作实参 / 含 {}、%、逗号、反斜杠原样', () => {
    expect(diagnoseExpression('COLORMESSAGE(@"还保有初吻", C_YELLOW, 1)')).toBeNull();
    expect(diagnoseExpression('RM_RESOURCECHECK(@"bodyGraph_A_wing_{選択中キャラID}")')).toBeNull();
    expect(diagnoseExpression('RM_RESOURCECHECK(@"%strPrefix%_精液{cumThreshold:LOCAL}")')).toBeNull();
    expect(diagnoseExpression('STRCOUNT(SAVESTR:0, @"/{NG_ID}/")')).toBeNull();
    expect(diagnoseExpression('STR == @"a,b;c\\d"')).toBeNull();
  });

  it('三元 `? … # …`（Emuera 真形；`:` 仍兼容）', () => {
    expect(diagnoseExpression('A ? 1 # 2')).toBeNull();
    expect(diagnoseExpression('A ? 1 : 2')).toBeNull();
    // 真实语料：`Drus:ARG` 是变量下标，`*100` 在 then 分支里，`#0` 收 else
    expect(diagnoseExpression('ARG<800?Drus:ARG*100#0')).toBeNull();
    expect(diagnoseExpression('GETPERCENT(BASE:C_ID:BASE_ID - (BASE_ID == 0 ? 500 # 0), MAXBASE:C_ID:BASE_ID) < 50')).toBeNull();
  });

  it('函数实参空槽 / 尾逗号', () => {
    expect(diagnoseExpression('F(a, , , 1)')).toBeNull();
    expect(diagnoseExpression('F(x, "y",)')).toBeNull();
    expect(diagnoseExpression('F(, x)')).toBeNull();
    expect(diagnoseExpression('F( )')).toBeNull();
    expect(diagnoseExpression('DT_SELECT(A, @"x", , B)')).toBeNull();
  });

  it('数字：0b 二进制 / 十进制指数（裸小数仍不认）', () => {
    expect(diagnoseExpression('HOLD == 0b11111')).toBeNull();
    expect(diagnoseExpression('X > 2e3')).toBeNull();
    expect(diagnoseExpression('X == 19e3')).toBeNull();
    expect(diagnoseExpression('X > 1.5e-2')).toBeNull();
    expect(diagnoseExpression('X == 0b0')).toBeNull();
  });

  it('下标接调用（复用参数列表）', () => {
    expect(diagnoseExpression('CFLAG:TOINT(ARG) > 0')).toBeNull();
    expect(diagnoseExpression('CHARISMA_TENDENCY:NOW_PERIOD() != 前期筹码傾向')).toBeNull();
    expect(diagnoseExpression('CARD_RANK:CARD_CHECK("RANK", ARG)')).toBeNull();
    expect(diagnoseExpression('A:F(1, , 2):G() > 0')).toBeNull();
  });

  it('后缀 / 前缀 ++ / --', () => {
    expect(diagnoseExpression('LOCAL:3++ == 0')).toBeNull();
    expect(diagnoseExpression('LOCAL:3 -- > 0')).toBeNull();
    // 真实语料 `SIF (++LOCAL:1) % 4 == 0`（增量表达式作左值）
    expect(diagnoseExpression('(++LOCAL:1) % 4 == 0')).toBeNull();
  });

  it('行尾续写 fail-open：二元运算符 / { 收尾、单独成行的 {}', () => {
    expect(diagnoseExpression('A ||')).toBeNull();
    expect(diagnoseExpression('CURRENT_CLOTHES_SET([[魔理沙]]) == 111 &&')).toBeNull();
    for (const op of [
      '||', '&&', '^^', '!&', '!|', '==', '!=', '<=', '>=', '<<', '>>',
      '+', '-', '*', '/', '%', '<', '>', '&', '|', '^',
    ]) {
      expect(diagnoseExpression(`A ${op}`), op).toBeNull();
    }
    expect(diagnoseExpression('A && {')).toBeNull();
    expect(diagnoseExpression('{')).toBeNull();
    expect(diagnoseExpression('}')).toBeNull();
    expect(diagnoseExpression('  {  ')).toBeNull();
    // 行尾逗号 = 折行（真实语料 `SIF FLAG:甲斐性無,` / 多行函数调用）
    expect(diagnoseExpression('A,')).toBeNull();
    expect(diagnoseExpression('GROUPMATCH(A, "x",')).toBeNull();
  });

  it('反证：真错仍然报（不许把诊断整体关掉）', () => {
    expect(diagnoseExpression('(1 + ) == 0')).toMatchObject({ kind: 'syntax' });
    expect(diagnoseExpression('IF (1 + ) == 0')).toMatchObject({ kind: 'syntax' });
    expect(diagnoseExpression('FUNC(A B)')).toMatchObject({ kind: 'syntax' });
  });
});

describe('ExprDiagnostic.pos · 出错位置（0 基 UTF-16）', () => {
  it('词法 / 语法错都带偏移', () => {
    expect(diagnoseExpression('A $ B')).toMatchObject({ kind: 'lexical', pos: 2 });
    expect(diagnoseExpression('A)')).toMatchObject({ kind: 'syntax', pos: 1 });
    expect(diagnoseExpression('(1 + ) == 0')).toMatchObject({ kind: 'syntax', pos: 5 });
  });

  it('悬空二元运算符：罪名落在它自己身上，不推给后一个运算符', () => {
    expect(diagnoseExpression('A && * B')).toMatchObject({ kind: 'syntax', pos: 2 });
    expect(diagnoseExpression('A && * B')?.message).toContain('“&&”');
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
