/**
 * 具名常量候选单测（P4，面板可用性批；零 React、零 IO）。
 *
 * 覆盖两半：
 * - `parseConstDeclarations`：四种指令（`#DIM` / `#DIMS` / `#DIMSTR` / `#DEFINE`）、
 *   修饰词任意顺序与多个、十进制/负数/十六进制/字符串值、行尾 `;` 注释截断、字符串内
 *   `;` 不截断、`[SKIPSTART]…[SKIPEND]` 区间（含 `;!;` 前缀与未闭合）、同名后声明覆盖先
 *   声明、大小写归一、非法值一律跳过；
 * - `resolveConstCandidates`：`ARGS == OPR_X` 出真实字符串、`ARG:1 == CONST_N` 出数字串、
 *   非 ARG/ARGS 槽不参与、六种比较符、动态下标与带下标常量跳过、递归（binary / ternary /
 *   call / unary）、`nameValue`（`[[词]]`）形态、去重与每槽 20 上限、只回有候选的槽。
 */
import { describe, expect, it } from 'vitest';
import type { ConditionExpr, FunctionPredicate, PredicateSourceKind } from '@kojo/plugin-api';
import {
  MAX_CONST_CANDIDATES,
  parseConstDeclarations,
  resolveConstCandidates,
} from '../src/const-candidates';

const L = (...lines: string[]): string => lines.join('\n');

function refExpr(name: string, indices: string[] = []): ConditionExpr {
  return { kind: 'ref', name, indices, text: indices.length > 0 ? `${name}:${indices.join(':')}` : name };
}

function literal(value: number | string): ConditionExpr {
  return { kind: 'literal', value, text: typeof value === 'string' ? `"${value}"` : String(value) };
}

function binary(op: string, left: ConditionExpr, right: ConditionExpr): ConditionExpr {
  return { kind: 'binary', op, left, right };
}

function predicate(expr: ConditionExpr, kind: PredicateSourceKind = 'CASE'): FunctionPredicate {
  return { kind, text: 'expr', expr, line: 1, depth: 0 };
}

describe('parseConstDeclarations · 声明形态', () => {
  it('四种指令都收：`#DIM` / `#DIMS` / `#DIMSTR` / `#DEFINE`', () => {
    const consts = parseConstDeclarations(
      L(
        '#DIM CONST NUM = 42',
        '#DIMS CONST STR = "战斗前"',
        '#DIMSTR CONST STR2 = "文本"',
        '#DEFINE FLAG 7',
      ),
    );
    expect(consts.size).toBe(4);
    expect(consts.get('NUM')).toEqual({ name: 'NUM', value: 42 });
    expect(consts.get('STR')).toEqual({ name: 'STR', value: '战斗前' });
    expect(consts.get('STR2')).toEqual({ name: 'STR2', value: '文本' });
    expect(consts.get('FLAG')).toEqual({ name: 'FLAG', value: 7 });
  });

  it('修饰词顺序任意、可叠加多个；`#DIM` 与名字之间任意空白（含 tab）', () => {
    const consts = parseConstDeclarations(
      L(
        '#DIM CONST SAVEDATA A = 1',
        '#DIM SAVEDATA CONST B = -2',
        '#DIM GLOBAL DYNAMIC CONST C = 0x1F',
        '#DIM\tCONST\tTABBED = 9',
      ),
    );
    expect(consts.get('A')?.value).toBe(1);
    expect(consts.get('B')?.value).toBe(-2);
    expect(consts.get('C')?.value).toBe(31); // 0x1F
    expect(consts.get('TABBED')?.value).toBe(9);
  });

  it('值形态：正整数 / 负数 / 零 / 十六进制 / 空字符串（类型分别保留 number、string）', () => {
    const consts = parseConstDeclarations(
      L(
        '#DIM CONST POS = 7',
        '#DIM CONST NEG = -7',
        '#DIM CONST ZERO = 0',
        '#DIM CONST HEX = 0x39E639',
        '#DIMS CONST EMPTY = ""',
        '#DIMS CONST PLAIN = "原样;保留"',
      ),
    );
    expect(consts.get('POS')).toEqual({ name: 'POS', value: 7 });
    expect(consts.get('NEG')).toEqual({ name: 'NEG', value: -7 });
    expect(consts.get('ZERO')).toEqual({ name: 'ZERO', value: 0 });
    expect(consts.get('HEX')).toEqual({ name: 'HEX', value: 0x39e639 });
    expect(consts.get('EMPTY')).toEqual({ name: 'EMPTY', value: '' });
    expect(consts.get('PLAIN')).toEqual({ name: 'PLAIN', value: '原样;保留' });
  });

  it('行尾 `;` 注释先截断；整行注释不算声明', () => {
    const consts = parseConstDeclarations(
      L(
        '#DEFINE DAILY_写真撮影をする 190 ;290',
        '#DIM CONST X = 42 ;コメント',
        '#DIM CONST Y = 43;无空格的分号也截',
        '; #DIM CONST GHOST = 1',
        '   ; #DEFINE GHOST2 2',
      ),
    );
    expect(consts.size).toBe(3);
    expect(consts.get('DAILY_写真撮影をする')?.value).toBe(190);
    expect(consts.get('X')?.value).toBe(42);
    expect(consts.get('Y')?.value).toBe(43);
    expect(consts.has('GHOST')).toBe(false);
    expect(consts.has('GHOST2')).toBe(false);
  });

  it('字符串内的 `;` 不当作注释起点（与 scanner.sliceExpression 同口径）', () => {
    const consts = parseConstDeclarations(
      L(
        '#DIMS CONST S1 = "a;b"',
        '#DIMS CONST S2 = "a;b" ; 尾巴注释',
        '#DIMS CONST S3 = "切;断" ; "第二段"',
      ),
    );
    expect(consts.get('S1')?.value).toBe('a;b');
    expect(consts.get('S2')?.value).toBe('a;b');
    expect(consts.get('S3')?.value).toBe('切;断');
  });

  it('`[SKIPSTART]…[SKIPEND]` 区间跳过；嵌套的 SKIPSTART 不叠层；未闭合开到文末', () => {
    const consts = parseConstDeclarations(
      L(
        '#DIM CONST BEFORE = 1',
        '[SKIPSTART]',
        '#DIM CONST DEAD = 2',
        '[SKIPSTART]', // 区内再来一枚不算新层（与 scanner 同判）
        '#DIM CONST DEAD2 = 3',
        '[SKIPEND]',
        '#DIM CONST AFTER = 4',
        '[SKIPSTART]',
        '#DIM CONST TAIL = 5', // 未闭合 → 到文末都是死区
        '#DIM CONST TAIL2 = 6',
      ),
    );
    expect(consts.has('BEFORE')).toBe(true);
    expect(consts.has('AFTER')).toBe(true);
    expect(consts.has('DEAD')).toBe(false);
    expect(consts.has('DEAD2')).toBe(false);
    expect(consts.has('TAIL')).toBe(false);
    expect(consts.has('TAIL2')).toBe(false);
  });

  it('`;!;` / `;#;` 代码前缀先剥再判屏蔽标记（`;!;[SKIPSTART]` 真开死区）', () => {
    const consts = parseConstDeclarations(
      L(
        ';!;[SKIPSTART]',
        '#DIM CONST DEAD = 1',
        '[SKIPEND]',
        ';#;[SKIPSTART]',
        '#DIM CONST DEAD2 = 2',
        '[SKIPEND]',
        '#DIM CONST ALIVE = 3',
        ';!;#DIM CONST NOT_PREPROCESSOR = 4', // 前缀之后是语句，不是行首 `#` 声明
      ),
    );
    expect(consts.has('DEAD')).toBe(false);
    expect(consts.has('DEAD2')).toBe(false);
    expect(consts.has('NOT_PREPROCESSOR')).toBe(false);
    expect(consts.get('ALIVE')?.value).toBe(3);
  });

  it('同名后声明覆盖先声明（引擎按文件序解释）；大小写不敏感地归一', () => {
    const consts = parseConstDeclarations(
      L(
        '#DIM CONST Same = 1',
        '#DIM CONST SAME = 2',
        '#DEFINE Same 3',
        '#DIM CONST DUPLICATE = 10',
        '#DIM CONST DUPLICATE = 20',
      ),
    );
    expect(consts.get('SAME')?.value).toBe(3);
    expect(consts.get('DUPLICATE')?.value).toBe(20);
  });

  it('指令与名字大小写归一（`#dim const` / `#define` 也认）', () => {
    const consts = parseConstDeclarations(
      L('#dim const lower = 1', '#Dims Const Mixed = "值"', '#define DEF 2'),
    );
    expect(consts.get('LOWER')).toEqual({ name: 'lower', value: 1 });
    expect(consts.get('MIXED')).toEqual({ name: 'Mixed', value: '值' });
    expect(consts.get('DEF')).toEqual({ name: 'DEF', value: 2 });
  });

  it('非法 / 不可证明的值一律跳过（不猜）', () => {
    const consts = parseConstDeclarations(
      L(
        '#DIM CONST EXPR = 0x44 + 1', // 表达式
        '#DIM CONST ALIAS = 既成事実&1p0', // 常量别名表达式
        '#DIM CONST VARNAME = OTHER', // 变量名
        '#DIM CONST LIST = 0, 100, 500', // 数组列表
        '#DIMS CONST SLIST = "a", "b"', // 字符串列表
        '#DIM CONST ARR[3] = 1', // 数组声明
        '#DIM CONST REF ONLY_REF', // 无值（REF 引用声明）
        '#DIM NO_CONST = 351', // 无 CONST ⇒ 可写变量
        '#DIM CONST NOVALUE =', // `=` 后空
        '#DEFINE NOVAL', // 无值
        '#DIMF CONST F = 1', // DIMF 不在解析面
        '#DIMCONST WEIRD = 1', // 未知指令
        '#DIM CONST BIG = 99999999999999999999', // 超安全整数
        '#DIM CONST UNCLOSED = "abc', // 引号未收尾
        '#DIM CONST TRAIL = "a"x', // 引号后还有残留
      ),
    );
    expect(consts.size).toBe(0);
  });

  it('空文本 / 只有无关行 → 空 Map；BOM 与 CRLF 不影响解析', () => {
    expect(parseConstDeclarations('').size).toBe(0);
    expect(parseConstDeclarations(L('@FUNC', 'IF X == 1', 'ENDIF')).size).toBe(0);
    const consts = parseConstDeclarations('\uFEFF#DIM CONST BOM = 1\r\n#DEFINE T 2\r\n');
    expect(consts.get('BOM')?.value).toBe(1);
    expect(consts.get('T')?.value).toBe(2);
  });
});

describe('resolveConstCandidates · 槽位候选', () => {
  const consts = parseConstDeclarations(
    L(
      '#DIM CONST CONST_N = 42',
      '#DIM CONST ZERO = 0',
      '#DIMS CONST OPR_战斗前 = "战斗前"',
      '#DIMS CONST OPR_战斗后 = "战斗后"',
      '#DIMS CONST OPR_自慰 = "自慰"',
      '#DIMS CONST EMPTY = ""',
      '#DIMS CONST WITH_SEMI = "a;b"',
    ),
  );

  it('`ARGS == OPR_X`（ref 侧）→ 真实字符串候选（str:0）', () => {
    const got = resolveConstCandidates(
      [predicate(binary('==', refExpr('ARGS'), refExpr('OPR_战斗前')))],
      consts,
    );
    expect(got).toEqual(new Map([['str:0', ['战斗前']]]));
  });

  it('`ARGS:1 == OPR_X` → str:1；比较对象在左也认（双向）', () => {
    const got = resolveConstCandidates(
      [
        predicate(binary('==', refExpr('ARGS', ['1']), refExpr('OPR_战斗前'))),
        predicate(binary('==', refExpr('OPR_战斗后'), refExpr('ARGS', ['2']))),
      ],
      consts,
    );
    expect(got.get('str:1')).toEqual(['战斗前']);
    expect(got.get('str:2')).toEqual(['战斗后']);
  });

  it('`ARG:1 == CONST_N` → 数字常量转字符串候选（int:1）；裸 `ARG` ≡ `ARG:0`', () => {
    const got = resolveConstCandidates(
      [
        predicate(binary('==', refExpr('ARG', ['1']), refExpr('CONST_N'))),
        predicate(binary('==', refExpr('ARG'), refExpr('ZERO'))),
      ],
      consts,
    );
    expect(got.get('int:1')).toEqual(['42']);
    expect(got.get('int:0')).toEqual(['0']);
  });

  it('非 ARG/ARGS 槽不参与（CFLAG:2 / LOCAL:0 / 裸名 CONST 比较）', () => {
    const got = resolveConstCandidates(
      [
        predicate(binary('==', refExpr('CFLAG', ['2']), refExpr('CONST_N'))),
        predicate(binary('==', refExpr('LOCAL', ['0']), refExpr('CONST_N'))),
        predicate(binary('==', refExpr('OPR_战斗前'), refExpr('OPR_战斗前'))),
      ],
      consts,
    );
    expect(got.size).toBe(0);
  });

  it('六种比较符都算候选；非比较运算符不参与', () => {
    for (const op of ['==', '!=', '<', '<=', '>', '>=']) {
      const got = resolveConstCandidates([predicate(binary(op, refExpr('ARG', ['1']), refExpr('CONST_N')))], consts);
      expect(got.get('int:1'), `比较符 ${op}`).toEqual(['42']);
    }
    const logical = resolveConstCandidates(
      [
        predicate(binary('&&', refExpr('ARG', ['1']), refExpr('CONST_N'))),
        predicate(binary('+', refExpr('ARGS'), refExpr('OPR_战斗前'))),
      ],
      consts,
    );
    expect(logical.size).toBe(0);
  });

  it('动态下标跳过（`ARG:ARG:0` / `ARGS:RESULT`）；带下标的常量引用不当常量值', () => {
    const got = resolveConstCandidates(
      [
        predicate(binary('==', refExpr('ARG', ['ARG:0']), refExpr('CONST_N'))),
        predicate(binary('==', refExpr('ARGS', ['RESULT']), refExpr('OPR_战斗前'))),
        predicate(binary('==', refExpr('ARGS'), refExpr('OPR_战斗前', ['1']))),
      ],
      consts,
    );
    expect(got.size).toBe(0);
  });

  it('递归：ternary / call 参数 / unary / 嵌套 binary（`&&` 里的比较也算）', () => {
    const ternary: ConditionExpr = {
      kind: 'ternary',
      cond: literal(1),
      then: binary('==', refExpr('ARGS'), refExpr('OPR_战斗前')),
      else: literal('x'),
    };
    const call: ConditionExpr = { kind: 'call', name: 'ABS', args: [binary('==', refExpr('ARG', ['2']), refExpr('CONST_N'))] };
    const unary: ConditionExpr = { kind: 'unary', op: '!', operand: binary('==', refExpr('ARGS', ['3']), refExpr('OPR_战斗后')) };
    const nested = binary(
      '&&',
      binary('==', refExpr('ARGS'), refExpr('OPR_自慰')),
      binary('||', binary('!=', refExpr('ARG', ['4']), refExpr('ZERO')), literal(1)),
    );
    const got = resolveConstCandidates(
      [predicate(ternary), predicate(call), predicate(unary), predicate(nested)],
      consts,
    );
    expect(got.get('str:0')).toEqual(['战斗前', '自慰']);
    expect(got.get('int:2')).toEqual(['42']);
    expect(got.get('str:3')).toEqual(['战斗后']);
    expect(got.get('int:4')).toEqual(['0']);
  });

  it('`nameValue`（`[[词]]`）形态也算常量引用', () => {
    const nameValue: ConditionExpr = { kind: 'nameValue', name: 'OPR_战斗前', text: '[[OPR_战斗前]]' };
    const got = resolveConstCandidates([predicate(binary('==', refExpr('ARGS'), nameValue))], consts);
    expect(got.get('str:0')).toEqual(['战斗前']);
  });

  it('字符串常量值原样（含 `;`）；空串值不产出候选；不在表里的名字不产出', () => {
    const got = resolveConstCandidates(
      [
        predicate(binary('==', refExpr('ARGS'), refExpr('WITH_SEMI'))),
        predicate(binary('==', refExpr('ARGS', ['1']), refExpr('EMPTY'))),
        predicate(binary('==', refExpr('ARGS', ['2']), refExpr('NOT_DECLARED'))),
      ],
      consts,
    );
    expect(got.get('str:0')).toEqual(['a;b']);
    expect(got.has('str:1')).toBe(false);
    expect(got.has('str:2')).toBe(false);
  });

  it('去重按首次出现序；每槽上限 20（MAX_CONST_CANDIDATES）', () => {
    const lines: string[] = [];
    for (let i = 0; i < 25; i += 1) lines.push(`#DIMS CONST C${i} = "v${i}"`);
    const many = parseConstDeclarations(L(...lines));
    const preds: FunctionPredicate[] = [];
    // 前两条重复同一个常量，验证去重不动顺序
    for (const i of [0, 0, ...Array.from({ length: 25 }, (_, k) => k)]) {
      preds.push(predicate(binary('==', refExpr('ARGS'), refExpr(`C${i}`))));
    }
    const got = resolveConstCandidates(preds, many);
    const list = got.get('str:0')!;
    expect(list.length).toBe(MAX_CONST_CANDIDATES);
    expect(list[0]).toBe('v0');
    expect(list[MAX_CONST_CANDIDATES - 1]).toBe('v19');
    expect(new Set(list).size).toBe(list.length);
  });

  it('常量表为空 → 空 Map；只返回有候选的槽', () => {
    const preds = [predicate(binary('==', refExpr('ARGS'), refExpr('OPR_战斗前')))];
    expect(resolveConstCandidates(preds, new Map()).size).toBe(0);
    const got = resolveConstCandidates(preds, consts);
    expect(got.has('int:0')).toBe(false);
    expect(got.has('str:1')).toBe(false);
    expect([...got.keys()]).toEqual(['str:0']);
  });
});

describe('口上真实形态 · SELECTCASE/ARG 分派一键填', () => {
  it('同文件顶部的 `#DIMS CONST OPR_*` → `SELECTCASE ARGS` 各 CASE 的槽候选', () => {
    const text = L(
      '@M_KOJO_K1_开场',
      '#DIMS CONST OPR_战斗前 = "战斗前"',
      '#DIMS CONST OPR_战斗后 = "战斗后"',
      '#DIMS CONST OPR_自慰 = "自慰"',
      '#DIM CONST OPR_NONE = 0',
      'SELECTCASE ARGS',
      'CASE OPR_战斗前',
      'CASE OPR_战斗后',
      'CASE OPR_自慰',
      'ENDSELECT',
    );
    const consts = parseConstDeclarations(text);
    // CASE 展开形：每条 = `subject == 常量`
    const preds = ['OPR_战斗前', 'OPR_战斗后', 'OPR_自慰'].map((n) =>
      predicate(binary('==', refExpr('ARGS'), refExpr(n)), 'CASE'),
    );
    preds.push(predicate(binary('==', refExpr('ARG'), refExpr('OPR_NONE')), 'CASE'));
    const got = resolveConstCandidates(preds, consts);
    expect(got.get('str:0')).toEqual(['战斗前', '战斗后', '自慰']);
    expect(got.get('int:0')).toEqual(['0']);
  });
});
