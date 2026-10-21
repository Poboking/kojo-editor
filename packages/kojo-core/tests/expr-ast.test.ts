/**
 * K2-EXPR-AST：core 表达式 AST（tokenize / parse / print / parity）单测。
 *
 * 语料锚点：
 * - 结构性正例来自 `tests/fixtures/**` 里真实出现的表达式形态（逐条注明文件:行）；
 * - 对拍真源 = `@kojo/plugin-condition-extractor` 的 `parseExpression`（v1 管线），
 *   仅测试注入；core 源码不 import 插件；
 * - 另补 v1 真实语料里的硬形态（`p` 指数 / 括号索引 / 下标调用 / 尾逗号）。
 *
 * 红线：本文件只测新目录，不改任何既有文件。
 */
import { describe, expect, it } from 'vitest';
import { parseExpression as parseV1Expression } from '@kojo/plugin-condition-extractor';
import type { ExprError, KojoExpr } from '../src/expr/ast.js';
import { EXPR_ERROR_CODES } from '../src/expr/ast.js';
import type { ExprParityOracle } from '../src/expr/parity.js';
import { compareParity, exprAstParity, legacyToParity, newToParity, parityEqual } from '../src/expr/parity.js';
import { parseExpr } from '../src/expr/parse.js';
import { exprEquivalent, printExpr } from '../src/expr/print.js';
import { tokenizeExpr } from '../src/expr/tokenize.js';

/** v1 管线注入（只有测试接线；生产由 sema / 宿主注入） */
const v1Oracle: ExprParityOracle = { parse: (source: string) => parseV1Expression(source) };

function ok(source: string): KojoExpr {
  const result = parseExpr(source);
  if (!result.ok) throw new Error(`期望解析成功：「${source}」→ ${result.error.code}@${result.error.offset}`);
  return result.node;
}

function failure(source: string): ExprError {
  const result = parseExpr(source);
  if (result.ok) throw new Error(`期望解析失败：「${source}」`);
  return result.error;
}

/** parse → print → parse：同源等价 + 打印文本稳定 */
function roundTrip(source: string): KojoExpr {
  const first = ok(source);
  const printed = printExpr(first);
  const second = parseExpr(printed);
  if (!second.ok) throw new Error(`打印产物不可解析：「${printed}」→ ${second.error.code}@${second.error.offset}`);
  expect(exprEquivalent(first, second.node)).toBe(true);
  expect(printExpr(second.node)).toBe(printed);
  return first;
}

/* ============================== 词法 ============================== */

describe('tokenize · 词法判据', () => {
  it('数字四形态：十进制 / 0x / 0b / p 二进制指数 / e 十进制指数', () => {
    const scanned = tokenizeExpr('42 0x10 0b101 1p3 2e3');
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    const values = scanned.tokens.filter((token) => token.kind === 'int').map((token) => (token.kind === 'int' ? token.value : NaN));
    expect(values).toEqual([42, 16, 5, 8, 2000]);
  });

  it('普通串：反斜杠只转义下一字符（`\\"` 不闭合）', () => {
    const scanned = tokenizeExpr('"他说：\\"好\\""');
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    const string = scanned.tokens[0];
    expect(string).toMatchObject({ kind: 'string', value: '他说："好"' });
  });

  it('逐字串 `@"…"`：插值里的引号不关闭外层串', () => {
    const scanned = tokenizeExpr('@"%TEXTS("…")%…"');
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.tokens[0]).toMatchObject({ kind: 'verbatim-string', value: '%TEXTS("…")%…' });
  });

  it('`[[词]]` 是独立 token（trim 后供 nameValue 节点）', () => {
    const scanned = tokenizeExpr('[[ 琪斯美 ]]');
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.tokens[0]).toMatchObject({ kind: 'nameValue', value: '琪斯美' });
  });

  it('BOM U+FEFF 按空白跳过（核心边界：不炸整条表达式）', () => {
    const scanned = tokenizeExpr('\uFEFF恋慕\uFEFF>= 500\uFEFF');
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.tokens.map((token) => token.kind)).toEqual(['ident', 'op', 'int', 'eof']);
  });

  it('未闭合的 `[[` 报 unterminated-name，offset 指向起点', () => {
    const scanned = tokenizeExpr('[[abc');
    expect(scanned.ok).toBe(false);
    if (scanned.ok) return;
    expect(scanned.error).toMatchObject({ code: 'expr/lex/unterminated-name', offset: 0 });
  });
});

/* ============================== 字面量与基础节点 ============================== */

describe('parse · 字面量 / 标识符 / 空表达式', () => {
  it('整数：value + 原文 + 1 基半开 span', () => {
    const node = ok('500');
    expect(node.kind).toBe('int');
    if (node.kind !== 'int') return;
    expect(node.value).toBe(500);
    expect(node.raw).toBe('500');
    expect(node.span).toEqual({ start: 1, end: 4 });
  });

  it('进制 / 指数形态都归一成同一个数值 AST', () => {
    for (const [source, value] of [
      ['0x10', 16],
      ['0b101', 5],
      ['1p3', 8],
      ['1P3', 8],
      ['2e3', 2000],
      ['1p1', 2],
      ['10p1', 20],
    ] as const) {
      const node = ok(source);
      expect(node.kind).toBe('int');
      if (node.kind === 'int') expect(node.value).toBe(value);
    }
  });

  it('中文字符串 + 转义引号：value 是解码后内容', () => {
    const node = ok('心情快照 == "亲近"');
    expect(node.kind).toBe('binary');
    if (node.kind !== 'binary') return;
    const right = node.right;
    expect(right.kind).toBe('string');
    if (right.kind !== 'string') return;
    expect(right.value).toBe('亲近');
    expect(right.form).toBe('plain');
    expect(right.span).toEqual({ start: 9, end: 13 });

    const escaped = ok('STR == "say \\"hi\\""');
    expect(escaped.kind).toBe('binary');
    if (escaped.kind !== 'binary' || escaped.right.kind !== 'string') return;
    expect(escaped.right.value).toBe('say "hi"');
  });

  it('逐字串保留 form=verbatim 与原文内容', () => {
    const node = ok('@"50% OFF"');
    expect(node).toMatchObject({ kind: 'string', form: 'verbatim', value: '50% OFF' });
  });

  it('空切片 / 纯空白 = 合法 empty（不是错误）', () => {
    for (const source of ['', '   ', '\t\u3000\uFEFF']) {
      const node = ok(source);
      expect(node.kind).toBe('empty');
      expect(node.span).toEqual({ start: 1, end: 1 });
      expect(printExpr(node)).toBe('');
    }
  });

  it('BOM 边界：标识符 span 相对切片起点、打印去掉 BOM', () => {
    const node = ok('\uFEFF恋慕 >= 500\uFEFF');
    expect(node.kind).toBe('binary');
    if (node.kind !== 'binary') return;
    expect(node.left.kind).toBe('ident');
    if (node.left.kind === 'ident') expect(node.left.span).toEqual({ start: 2, end: 4 });
    expect(node.span).toEqual({ start: 2, end: 11 });
    expect(printExpr(node)).toBe('恋慕 >= 500');
  });

  it('`{ … }` 解壳：节点 span 仍相对原切片（列不前移）', () => {
    const node = ok('{ 恋慕 >= 500 }');
    expect(node.kind).toBe('binary');
    if (node.kind !== 'binary') return;
    expect(node.left.kind).toBe('ident');
    if (node.left.kind === 'ident') expect(node.left.span).toEqual({ start: 3, end: 5 });
    expect(node.span).toEqual({ start: 3, end: 12 });
    expect(printExpr(node)).toBe('恋慕 >= 500');
  });

  it('`{}` 解壳成空表达式', () => {
    const node = ok('{}');
    expect(node.kind).toBe('empty');
    expect(node.span).toEqual({ start: 2, end: 2 });
  });
});

/* ============================== 后缀链 ============================== */

describe('parse · 下标 / 调用 / 成员', () => {
  it('方括号下标：`队列[0]`', () => {
    const node = ok('队列[0]');
    expect(node).toMatchObject({ kind: 'index', style: 'bracket', span: { start: 1, end: 6 } });
    if (node.kind !== 'index') return;
    expect(node.object).toMatchObject({ kind: 'ident', name: '队列', span: { start: 1, end: 3 } });
    expect(node.index).toMatchObject({ kind: 'int', value: 0, span: { start: 4, end: 5 } });
  });

  it('成员访问：`队列.长度`，可与下标串联', () => {
    const member = ok('队列.长度');
    expect(member).toMatchObject({ kind: 'member', name: '长度', span: { start: 1, end: 6 } });

    const chained = ok('队列[0].长度');
    expect(chained.kind).toBe('member');
    if (chained.kind !== 'member') return;
    expect(chained.object.kind).toBe('index');
    expect(printExpr(chained)).toBe('队列[0].长度');
  });

  it('冒号下标链：`TALENT:[[琪斯美]]:恋慕`（v1 ref 形态）', () => {
    const node = ok('TALENT:[[琪斯美]]:恋慕');
    expect(node.kind).toBe('index');
    if (node.kind !== 'index') return;
    expect(node.style).toBe('colon');
    expect(node.index).toMatchObject({ kind: 'ident', name: '恋慕' });
    expect(printExpr(node)).toBe('TALENT:[[琪斯美]]:恋慕');
  });

  it('冒号段接调用：`CHARISMA_TENDENCY:NOW_PERIOD()`', () => {
    const node = ok('CHARISMA_TENDENCY:NOW_PERIOD()');
    expect(node.kind).toBe('index');
    if (node.kind !== 'index') return;
    expect(node.index).toMatchObject({ kind: 'call', args: [] });
    expect(printExpr(node)).toBe('CHARISMA_TENDENCY:NOW_PERIOD()');
  });

  it('冒号段括号表达式：`YOGORE:(GET_CHARAHOME(TARGET)) < 1000`', () => {
    const node = ok('YOGORE:(GET_CHARAHOME(TARGET)) < 1000');
    expect(node.kind).toBe('binary');
    if (node.kind !== 'binary') return;
    const left = node.left;
    expect(left.kind).toBe('index');
    if (left.kind !== 'index') return;
    expect(left.index.kind).toBe('paren');
    expect(printExpr(left)).toBe('YOGORE:(GET_CHARAHOME(TARGET))');
  });

  it('调用实参：空槽与尾逗号被跳过，不进 AST', () => {
    const node = ok('F(a, , , 1)');
    expect(node.kind).toBe('call');
    if (node.kind !== 'call') return;
    expect(node.args).toHaveLength(2);
    expect(node.args.map((arg) => (arg.kind === 'int' ? arg.value : arg.kind))).toEqual(['ident', 1]);
    expect(node.span).toEqual({ start: 1, end: 12 });
    expect(printExpr(node)).toBe('F(a, 1)');

    expect(ok('f()')).toMatchObject({ kind: 'call', args: [] });
    expect(ok('f(,)')).toMatchObject({ kind: 'call', args: [] });
  });
});

/* ============================== 优先级 / 结合性 ============================== */

describe('parse · 优先级与结合性（照 v1 管线口径）', () => {
  it('`A + 1 * 2 > B && C`：&& 最松、* 最紧', () => {
    const node = ok('A + 1 * 2 > B && C');
    expect(node.kind).toBe('binary');
    if (node.kind !== 'binary') return;
    expect(node.op).toBe('&&');
    expect(node.span).toEqual({ start: 1, end: 19 });
    const compare = node.left;
    expect(compare.kind).toBe('binary');
    if (compare.kind !== 'binary') return;
    expect(compare.op).toBe('>');
    expect(compare.left.kind).toBe('binary');
    if (compare.left.kind !== 'binary') return;
    expect(compare.left.op).toBe('+');
    expect(compare.left.right).toMatchObject({ kind: 'binary', op: '*' });
  });

  it('`A || B && C`：逻辑运算符同优先级（40）左结合（引擎口径，不发明第二套）', () => {
    const node = ok('A || B && C');
    expect(node.kind).toBe('binary');
    if (node.kind !== 'binary') return;
    expect(node.op).toBe('&&');
    expect(node.left).toMatchObject({ kind: 'binary', op: '||' });
    expect(node.right).toMatchObject({ kind: 'ident', name: 'C' });
  });

  it('`X << 2 & 0xff`：移位高于按位与', () => {
    const node = ok('X << 2 & 0xff');
    expect(node.kind).toBe('binary');
    if (node.kind !== 'binary') return;
    expect(node.op).toBe('&');
    expect(node.left).toMatchObject({ kind: 'binary', op: '<<' });
    expect(node.right).toMatchObject({ kind: 'int', value: 255 });
  });

  it('`(A || B) && C`：显式括号保留为 paren 节点', () => {
    const node = ok('(A || B) && C');
    expect(node.kind).toBe('binary');
    if (node.kind !== 'binary') return;
    expect(node.left.kind).toBe('paren');
    expect(printExpr(node)).toBe('(A || B) && C');
  });

  it('`1 - 2 - 3`：二元一律左结合', () => {
    const node = ok('1 - 2 - 3');
    expect(node.kind).toBe('binary');
    if (node.kind !== 'binary') return;
    expect(node.op).toBe('-');
    expect(node.left).toMatchObject({ kind: 'binary', op: '-' });
    expect(node.right).toMatchObject({ kind: 'int', value: 3 });
  });

  it('一元：`-3` / `!A && B` / 前缀 `++LOCAL:1` / 后缀 `LOCAL:3++`', () => {
    expect(ok('-3')).toMatchObject({ kind: 'unary', op: '-', position: 'prefix' });

    const notAnd = ok('!A && B');
    expect(notAnd.kind).toBe('binary');
    if (notAnd.kind !== 'binary') return;
    expect(notAnd.op).toBe('&&');
    expect(notAnd.left).toMatchObject({ kind: 'unary', op: '!', position: 'prefix' });

    const prefix = ok('++LOCAL:1');
    expect(prefix).toMatchObject({ kind: 'unary', op: '++', position: 'prefix' });

    const postfix = ok('LOCAL:3++ == 0');
    expect(postfix.kind).toBe('binary');
    if (postfix.kind !== 'binary') return;
    expect(postfix.left).toMatchObject({ kind: 'unary', op: '++', position: 'postfix' });
  });

  it('三元：`? :` 与 v1 的 `? #` 同义；else 分支右结合', () => {
    const simple = ok('A ? 1 : 2');
    expect(simple).toMatchObject({ kind: 'ternary' });
    expect(printExpr(simple)).toBe('A ? 1 : 2');

    expect(ok('A ? B # C')).toMatchObject({ kind: 'ternary' });
    expect(printExpr(ok('A ? B # C'))).toBe('A ? B : C');

    const nested = ok('A ? B : C ? D : E');
    expect(nested.kind).toBe('ternary');
    if (nested.kind !== 'ternary') return;
    expect(nested.else.kind).toBe('ternary');
    expect(printExpr(nested)).toBe('A ? B : C ? D : E');
  });

  it('then 分支是标识符时，`:` 按三元分隔符解（唯一歧义裁决）', () => {
    const node = ok('A ? B : C');
    expect(node).toMatchObject({ kind: 'ternary' });
    expect(printExpr(node)).toBe('A ? B : C');
    // v1 会把 `B : C` 吃成 ref B:C → 整条 opaque；新管线把这条歧义解释成三元
    expect(exprAstParity('A ? B : C', v1Oracle).status).toBe('new-only');
    // then 分支里真要写冒号下标时加括号（括号内重新允许 ref）
    const parened = ok('A ? (B:C) : D');
    expect(parened).toMatchObject({ kind: 'ternary' });
    expect(printExpr(parened)).toBe('A ? (B:C) : D');
    expect(exprAstParity('A ? (B:C) : D', v1Oracle).status).toBe('equal');
  });

  it('`1p100`：p 指数越界回退旧口径 → 语法错（不造超大值）', () => {
    const error = failure('1p100');
    expect(error.code).toBe('expr/syntax/trailing');
    expect(error.offset).toBe(1);
  });

  it('`{…}` 解壳后可含三元（插值里的真实形态）', () => {
    const node = ok('{恋慕 >= 亲近线 ? "你最近……有点不一样。" : "今天也一起加油吧。"}');
    expect(node.kind).toBe('ternary');
    expect(printExpr(node)).toBe('恋慕 >= 亲近线 ? "你最近……有点不一样。" : "今天也一起加油吧。"');
  });
});

/* ============================== 错误定位 ============================== */

describe('parse · 失败可判别（code / message / offset，不抛）', () => {
  const cases = [
    ['1 +', 'expr/syntax/missing-operand', 3],
    ['1 2', 'expr/syntax/trailing', 2],
    ['A,,B', 'expr/syntax/trailing', 3],
    ['f(', 'expr/syntax/missing-operand', 2],
    ['a[1', 'expr/syntax/unclosed-bracket', 3],
    ['a[1,2]', 'expr/syntax/unclosed-bracket', 3],
    ['a.', 'expr/syntax/member-name', 2],
    ['a ? b', 'expr/syntax/missing-ternary-separator', 5],
    ['"abc', 'expr/lex/unterminated-string', 0],
    ['[[abc', 'expr/lex/unterminated-name', 0],
    ['a $ b', 'expr/lex/unexpected-char', 2],
    ['@', 'expr/lex/unexpected-char', 0],
    ['0x', 'expr/lex/bad-number', 0],
    ['0b', 'expr/lex/bad-number', 0],
    ['1.5e-2', 'expr/lex/bad-number', 0],
    ['[0]', 'expr/syntax/unexpected-token', 0],
    ['(', 'expr/syntax/missing-operand', 1],
    ['A ? B :', 'expr/syntax/missing-operand', 7],
  ] as const;

  it.each(cases)('「%s」→ %s @ %i', (source, code, offset) => {
    const error = failure(source);
    expect(error.code).toBe(code);
    expect(error.offset).toBe(offset);
    expect(error.message.length).toBeGreaterThan(0);
  });

  it('所有失败 offset 都落在 [0, source.length] 且错误码在闭集里', () => {
    const nasty = ['', ' ', '?', '??', '1 +', '1 2', 'f(', 'f(a', 'a[', 'a[]', 'a.', 'a..b', 'a ?', 'a ? : b', '[[', '[[a', '"', '"a', "'a'", 'a $ b', '0x', '1abc', '/*x*/', 'a/*x*/', ',,,', '@x', 'a:b:', 'a:(b', '{{a}}'];
    for (const source of nasty) {
      const result = parseExpr(source);
      if (result.ok) continue;
      expect(EXPR_ERROR_CODES).toContain(result.error.code);
      expect(result.error.offset).toBeGreaterThanOrEqual(0);
      expect(result.error.offset).toBeLessThanOrEqual(source.length);
    }
  });

  it('绝不抛：任意输入（含非法 UTF-16 代理项）都返回结果对象', () => {
    const inputs = ['\uD800', 'a\uDC00b', '\u0000', '\n', '\r\n', 'a\nb', '\t'.repeat(3) + '1'];
    for (const source of inputs) {
      expect(() => parseExpr(source)).not.toThrow();
      const result = parseExpr(source);
      expect(typeof result.ok).toBe('boolean');
    }
  });
});

/* ============================== 打印 ============================== */

describe('print · 规范文本与幂等', () => {
  it('空白归一：`A+1*2` → `A + 1 * 2`', () => {
    expect(printExpr(ok('A+1*2'))).toBe('A + 1 * 2');
  });

  it('逗号 / 冒号 / 成员 / 下标：规范空格', () => {
    expect(printExpr(ok('f( a , b )'))).toBe('f(a, b)');
    expect(printExpr(ok('a [ 0 ] . 长度'))).toBe('a[0].长度');
    expect(printExpr(ok('FLAG : 70'))).toBe('FLAG:70');
  });

  it('数值归一成十进制（原文只在 AST.raw 里保留）', () => {
    expect(printExpr(ok('0x10'))).toBe('16');
    expect(printExpr(ok('1p3'))).toBe('8');
    expect(printExpr(ok('2e3'))).toBe('2000');
  });

  it('字符串按普通串规则重转义；逐字串原样回填', () => {
    expect(printExpr(ok('"a\\"b"'))).toBe('"a\\"b"');
    expect(printExpr(ok('@"50% OFF"'))).toBe('@"50% OFF"');
    expect(printExpr(ok('[[ 琪斯美 ]]'))).toBe('[[琪斯美]]');
  });

  it('显式括号保留；嵌套前缀一元之间插空格避免 `--`', () => {
    expect(printExpr(ok('A+(B*C)'))).toBe('A + (B * C)');
    expect(printExpr(ok('- -a'))).toBe('- -a');
    const node = ok('- -a');
    expect(node).toMatchObject({ kind: 'unary', op: '-' });
  });

  it('三元 / 解壳 / 空表达式', () => {
    expect(printExpr(ok('A?1:2'))).toBe('A ? 1 : 2');
    expect(printExpr(ok('{ a }'))).toBe('a');
    expect(printExpr(ok('{}'))).toBe('');
  });

  it.each([
    'A + 1 * 2 > B && C',
    'A || B && C',
    '(A || B) && C',
    '1 - 2 - 3',
    '-3',
    '!A && B',
    'A ? B : C ? D : E',
    'A ? (B ? C : D) : E',
    'F(a, 1)',
    '队列[0].长度',
    'TALENT:[[琪斯美]]:恋慕',
    'YOGORE:(GET_CHARAHOME(TARGET)) < 1000',
    'STR == "say \\"hi\\""',
    '@"50% OFF"',
    '@"%TEXTS("…")%…"',
    '1p3 & 0xff',
    'LOCAL:3++ == 0',
    '++LOCAL:1',
    '恋慕 >= 亲近线 ? "A" : "B"',
  ])('幂等：parse → print → parse 与原文等价（%s）', (source) => {
    roundTrip(source);
  });

  it('exprEquivalent 忽略 span / 原文 / 显式括号，但保留一元前后缀', () => {
    expect(exprEquivalent(ok('0x10'), ok('16'))).toBe(true);
    expect(exprEquivalent(ok('(A)'), ok('A'))).toBe(true);
    expect(exprEquivalent(ok('A++'), ok('++A'))).toBe(false);
    expect(exprEquivalent(ok('A + 1'), ok('A - 1'))).toBe(false);
  });
});

/* ============================== 与 v1 对拍 ============================== */

describe('parity · fixtures 真实表达式（≥20 条，逐条注明出处）', () => {
  const fixtureExpressions: readonly (readonly [where: string, source: string])[] = [
    // packages/kojo-core/tests/fixtures/kojo2-canonical.kojo2
    ['kojo2-canonical.kojo2:4 常量初值', '500'],
    ['kojo2-canonical.kojo2:11 表主语', '恋慕'],
    ['kojo2-canonical.kojo2:12 区间端点', '0'],
    ['kojo2-canonical.kojo2:12 区间端点', '99'],
    ['kojo2-canonical.kojo2:13 区间端点', '100'],
    ['kojo2-canonical.kojo2:13 区间端点', '499'],
    ['kojo2-canonical.kojo2:14 区间端点', '亲近线'],
    ['kojo2-canonical.kojo2:18 池条件', '恋慕 < 100'],
    ['kojo2-canonical.kojo2:20 池条件', '恋慕 < 500'],
    ['kojo2-canonical.kojo2:34 条件', '数值 > 0'],
    ['kojo2-canonical.kojo2:40 织入条件', '天气 == 雨'],
    ['kojo2-canonical.kojo2:47 插值三元', '恋慕 >= 亲近线 ? "你最近……有点不一样。" : "今天也一起加油吧。"'],
    ['kojo2-canonical.kojo2:69 条件', '恋慕 >= 500'],
    ['kojo2-canonical.kojo2:83 条件', '心情快照 == "亲近"'],
    ['kojo2-canonical.kojo2:103 条件', '人数 == 1'],
    ['kojo2-canonical.kojo2:114 循环条件', '体力恢复 < 100'],
    ['kojo2-canonical.kojo2:116 条件', '体力恢复 == 50'],
    ['kojo2-canonical.kojo2:123 重复次数', '3'],
    ['kojo2-canonical.kojo2:127 巡条件', '值 == "受伤"'],
    ['kojo2-canonical.kojo2:128 插值算术', '下标 + 1'],
    ['kojo2-canonical.kojo2:35 返回值', '数值'],
    ['kojo2-canonical.kojo2:37 返回值', '0'],
    // packages/kojo-core/tests/fixtures/e2e/canonical.kojo2
    ['e2e/canonical.kojo2:30 条件', '恋慕 >= 亲近线'],
    ['e2e/canonical.kojo2:33 插值符号', '心情'],
    // packages/kojo-core/tests/fixtures/migrate/mechanical.kojo2
    ['migrate/mechanical.kojo2:25 条件', 'TFLAG:1'],
    // packages/kojo-core/tests/fixtures/migrate/semantic.kojo2
    ['migrate/semantic.kojo2:1 表主语', 'TFLAG:193'],
    ['migrate/semantic.kojo2:7 池条件', '她的好感度 >= 500'],
  ];

  it.each(fixtureExpressions)('%s：「%s」与 v1 等价', (_where, source) => {
    const report = exprAstParity(source, v1Oracle);
    expect(report.status).toBe('equal');
    expect(report.error).toBeNull();
    expect(report.selfCheck.idempotent).toBe(true);
    expect(parityEqual(report)).toBe(true);
  });

  it('fixtures 里只做了 2 条抽样核对总数（口径自检）', () => {
    expect(fixtureExpressions.length).toBeGreaterThanOrEqual(20);
  });
});

describe('parity · v1 真实语料硬形态', () => {
  const corpusExpressions = [
    'A + 1 * 2 > B && C',
    'A || B && C',
    '!KOJO_VALID',
    '-3',
    'GROUPMATCH(ARGS, "COMMAND", "COM")',
    'STR == "say \\"hi\\""',
    'X & 0x10',
    '(A || B) && C',
    'A ? 1 : 2',
    'A ? B # C',
    'GETBIT(FLAG:99, 0) && !GETBIT(CFLAG:526, 0)',
    'X << 2 & 0xff',
    'TALENT:[[琪斯美]]:恋慕',
    'FLAG:デート相手 == [[依姫]]',
    'IS_HERE([[蓮子]])',
    'YOGORE:(GET_CHARAHOME(TARGET)) < 1000',
    'TALENT:(NO:30):恋慕',
    '1p3',
    'FLAG:甲斐性無 & 1p3',
    '(CFLAG:2 & 1p4) != 0',
    'FLAG:9 & (1p0 | 2p3)',
    '1p1 == 2',
    '10p1',
    '1P3',
    '2e3',
    '@"%TEXTS("…")%…"',
    'FLAG:甲斐性無,',
    'TALENT:恋慕 && CFLAG:2 >= 500,',
    'BASE:酒気 > (MAXBASE:酒気 / 10) * 8',
    'CFLAG:ARG:口上セレクタ == 1',
    'CFLAG:2 >= 500',
    'LOCAL',
    'FLAG:70',
  ];

  it.each(corpusExpressions)('「%s」与 v1 等价且打印幂等', (source) => {
    const report = exprAstParity(source, v1Oracle);
    expect(report.status).toBe('equal');
    expect(report.selfCheck.idempotent).toBe(true);
  });
});

describe('parity · 分类（new-only / both-reject / mismatch / v1-only / unavailable）', () => {
  it('2.0 扩展形态：`队列[0]` / `队列.长度` / 空切片 / `{}` → new-only', () => {
    for (const source of ['队列[0]', '队列.长度', '', '{}']) {
      const report = exprAstParity(source, v1Oracle);
      expect(report.status).toBe('new-only');
      expect(report.newForm).not.toBeNull();
      expect(report.v1Form).toBeNull();
    }
  });

  it('两边都拒绝 → equal（`A &&` / `1abc` / `a $ b`）', () => {
    for (const source of ['A &&', '1abc', 'a $ b']) {
      const report = exprAstParity(source, v1Oracle);
      expect(report.status).toBe('equal');
      expect(report.ast).toBeNull();
      expect(report.error).not.toBeNull();
    }
  });

  it('mismatch 可检出：oracle 返回错误 AST', () => {
    const badOracle: ExprParityOracle = { parse: () => ({ kind: 'literal', value: 1, text: '1' }) };
    const report = exprAstParity('A + 1', badOracle);
    expect(report.status).toBe('mismatch');
    expect(report.differences.length).toBeGreaterThan(0);
    expect(parityEqual(report)).toBe(false);
  });

  it('v1-only 可检出：新管线拒绝、v1 接受', () => {
    const looseOracle: ExprParityOracle = {
      parse: (source) => ({ kind: 'ref', name: 'X', indices: [], text: source }),
    };
    const report = exprAstParity('1 +', looseOracle);
    expect(report.status).toBe('v1-only');
    expect(report.error?.code).toBe('expr/syntax/missing-operand');
    expect(report.differences[0]).toContain('v1 接受');
  });

  it('未注入 oracle：unavailable，但仍做打印幂等自检', () => {
    const report = exprAstParity('A + 1');
    expect(report.status).toBe('unavailable');
    expect(report.selfCheck).toEqual({ printed: 'A + 1', idempotent: true });
    expect(report.differences).toEqual([]);
  });

  it('oracle 抛错按 opaque 收口（不把异常泄漏给调用方）', () => {
    const throwingOracle: ExprParityOracle = {
      parse: () => {
        throw new Error('v1 boom');
      },
    };
    const report = exprAstParity('A + 1', throwingOracle);
    expect(report.status).toBe('new-only');
  });
});

/* ============================== 归一化工具 ============================== */

describe('parity · 归一化形态', () => {
  it('冒号下标合并回 v1 ref；数值段保留原文', () => {
    expect(newToParity(ok('FLAG:0x10'))).toEqual({ k: 'ref', name: 'FLAG', segs: ['0x10'] });
    expect(newToParity(ok('FLAG:70'))).toEqual({ k: 'ref', name: 'FLAG', segs: ['70'] });
    expect(newToParity(ok('LOCAL'))).toEqual({ k: 'ref', name: 'LOCAL', segs: [] });
  });

  it('方括号 / 成员保持 2.0 形态（不冒充 ref）', () => {
    expect(newToParity(ok('队列[0]')).k).toBe('index');
    expect(newToParity(ok('队列.长度')).k).toBe('member');
  });

  it('v1 AST 归一化：ref/call 名字大写、字符串下标按解码值', () => {
    const legacy = parseV1Expression('CFLAG:2 >= 500');
    expect(legacyToParity(legacy)).toEqual({
      k: 'binary',
      op: '>=',
      l: { k: 'ref', name: 'CFLAG', segs: ['2'] },
      r: { k: 'int', v: 500 },
    });

    const call = parseV1Expression('f(1, "x")');
    expect(legacyToParity(call)).toEqual({
      k: 'call',
      name: 'F',
      args: [
        { k: 'int', v: 1 },
        { k: 'str', v: 'x' },
      ],
    });
  });

  it('compareParity：同形相等 / 种类不同给出差异', () => {
    expect(compareParity({ k: 'int', v: 1 }, { k: 'int', v: 1 })).toEqual({ equal: true, differences: [] });
    const differ = compareParity({ k: 'int', v: 1 }, { k: 'str', v: '1' });
    expect(differ.equal).toBe(false);
    expect(differ.differences[0]).toContain('节点种类不同');
  });
});
