/**
 * `local-no-write` 的四族判性钉据（KW-15E 1103；游戏无关；本插件私有）。
 *
 * 这批不新增判定、不放宽任何一条：真语料（K49 × save03）上那 191 枚逐枚归类后，
 * **可静态证明的子集是 0 枚**，所以这里全部是"不许硬收"的反向闸 + 文案写实。
 * 归类读数与逐族例子见批次提交信息。
 *
 * 四种事实（`locals.ts` 的 `noWriteReason`）：
 * ① 别支里的赋值（分支路径不同）② 循环量由 `FOR` 头逐轮写入
 * ③ `RESULT`/`RESULTS` = 引擎命令返回值寄存器 ④ 函数内只在使用点之后才赋值。
 */
import { describe, expect, it } from 'vitest';
import type {
  ControlFlowStatement,
  FunctionAssignment,
  FunctionPredicates,
  ReplayValue,
  VariableRef,
} from '@kojo/plugin-api';
import { parseExpression } from '@kojo/plugin-condition-extractor';
import { createFunctionOverlay, type OverlayPosition } from '../src/locals';

const ref = (name: string, indices: string[] = []): VariableRef => ({
  name,
  indices,
  text: indices.length ? `${name}:${indices.join(':')}` : name,
});

function assignment(
  name: FunctionAssignment['name'],
  index: number,
  rhs: string,
  line: number,
  context: string[],
): FunctionAssignment {
  return { name, index, expr: parseExpression(rhs), text: rhs, line, context };
}

function stmt(kind: string, line: number, depth: number, expression = ''): ControlFlowStatement {
  return { kind, line, depth, expression };
}

function makeDetail(
  assignments: FunctionAssignment[],
  statements: ControlFlowStatement[] = [],
): FunctionPredicates {
  return {
    normalizedName: 'TEST',
    filePath: 'a.erb',
    startLine: 1,
    endLine: 200,
    statements,
    assignments,
    predicates: [],
    returns: [],
  };
}

const baseRead = (_r: VariableRef): ReplayValue => ({ kind: 'unknown', unknown: { code: 'missing-var', message: 'no' } });

/** 取未知原因的文案（判定形态本身也一并钉住） */
function unknownText(v: ReplayValue): string {
  if (v.kind !== 'unknown') throw new Error(`期望 unknown，实际 ${v.kind}`);
  return `${v.unknown.code} ${v.unknown.message}`;
}

describe('local-no-write · ①别支赋值：不许当必得', () => {
  it('赋值在兄弟分支里 → 仍未知，且说清"不同分支路径"（不是说没人写）', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 3, '36', 3829, ['s1', 's48'])]),
      baseRead,
    })!;
    const at: OverlayPosition = { line: 3843, context: ['s1', 's51'] };
    const v = overlay(ref('LOCAL', ['3']), at)!;
    expect(v.kind).toBe('unknown');
    const text = unknownText(v);
    expect(text).toContain('local-no-write');
    expect(text).toContain('不同的分支路径');
    expect(text).toContain('3829');
    // 文案不许把这一族说成"没有赋值语句"（真语料里这一族 97 枚）
    expect(text).not.toContain('该槽位没有赋值语句');
  });

  it('每条分支都有赋值、甚至带兜底 ELSE，也不许折叠分支当成必得（12 枚的形状）', () => {
    // IF 一支写 1、ELSE 一支写 2，使用点在链闭合之后：任何一支都可能走，
    // 且"走哪一支"的分支条件本身就可能是 RAND 那类未知 → 只能保持未知。
    const overlay = createFunctionOverlay({
      detail: makeDetail(
        [
          assignment('LOCAL', 1, '1', 329, ['s1', 's10', 's13']),
          assignment('LOCAL', 1, '2', 336, ['s1', 's10', 's15']),
        ],
        [
          stmt('IF', 323, 2, 'ABL:5 >= 5 && !RAND:6'),
          stmt('ELSE', 330, 2),
          stmt('ENDIF', 375, 2),
        ],
      ),
      baseRead,
    })!;
    const at: OverlayPosition = { line: 378, context: ['s1', 's10', 's25'] };
    const v = overlay(ref('LOCAL', ['1']), at)!;
    expect(v.kind).toBe('unknown');
    const text = unknownText(v);
    expect(text).toContain('local-no-write');
    expect(text).toContain('不折叠分支');
    expect(text).toContain('329');
    expect(text).toContain('336');
  });

  it('两条分支都写同一个值，本叠加层也照样不吃（当前口径的边界自证）', () => {
    // 这一枚"看起来能收"：IF / ELSE 两支各写 1，结构上必有一支执行。
    // 本叠加层的可达性只有一条前缀规则，不折叠分支——真语料上"全分支都有赋值"的
    // 12 枚取值**互不相同**（各支 1..6，且分支条件含 !RAND:6 那类未知），
    // 折叠分支这套东西今天没有可证的落点，所以不加。
    // 将来若要放宽，前置条件必须三件齐：①链必进入（带兜底支且闭合在使用点前）
    // ②各支"最后一条"顶层赋值取值一致 ③链头到使用点之间该槽位无其它搅动写法。
    const overlay = createFunctionOverlay({
      detail: makeDetail(
        [assignment('LOCAL', 1, '1', 329, ['s1', 's10', 's13']), assignment('LOCAL', 1, '1', 336, ['s1', 's10', 's15'])],
        [stmt('IF', 323, 2, 'ABL:5 >= 5'), stmt('ELSE', 330, 2), stmt('ENDIF', 375, 2)],
      ),
      baseRead,
    })!;
    const v = overlay(ref('LOCAL', ['1']), { line: 378, context: ['s1', 's10', 's25'] })!;
    expect(v.kind).toBe('unknown');
    expect(unknownText(v)).toContain('local-no-write');
  });

  it('链没有兜底支（IF 无 ELSE）时全假路径上一支都不走 ⇒ 更不许收', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 0, '7', 20, ['s1'])], [stmt('IF', 19, 0, 'X'), stmt('ENDIF', 30, 0)]),
      baseRead,
    })!;
    const v = overlay(ref('LOCAL'), { line: 40, context: [] })!;
    expect(v.kind).toBe('unknown');
    expect(unknownText(v)).toContain('不同的分支路径');
  });
});

describe('local-no-write · ②循环量：值由 FOR 头逐轮写入', () => {
  const loopStmts = [stmt('FOR', 3820, 0, 'LOCAL:2,1,CHARANUM'), stmt('NEXT', 3900, 0)];

  it('使用点在体内、函数内没有直线赋值 → 文案指到循环头那一行', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 0, '1', 10, [])], loopStmts),
      baseRead,
    })!;
    const v = overlay(ref('LOCAL', ['2']), { line: 3826, context: ['s1'] })!;
    expect(v.kind).toBe('unknown');
    const text = unknownText(v);
    expect(text).toContain('local-no-write');
    expect(text).toContain('FOR 循环量');
    expect(text).toContain('第 3820 行');
    expect(text).not.toContain('没有赋值语句');
  });

  it('循环头在使用点之后 / 配对不上 NEXT ⇒ 不宣称循环量（退回第四族文案）', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 2, '5', 90, [])], [stmt('FOR', 80, 0, 'LOCAL:2,1,3')]),
      baseRead,
    })!;
    const v = overlay(ref('LOCAL', ['2']), { line: 50, context: [] })!;
    expect(unknownText(v)).toContain('只在使用点之后');
  });
});

describe('local-no-write · ③命令返回值寄存器', () => {
  for (const name of ['RESULT', 'RESULTS'] as const) {
    it(`${name} 无直线赋值 → 说"引擎动词行写入"，不再谎称只剩进入函数时的残留`, () => {
      const overlay = createFunctionOverlay({
        detail: makeDetail([assignment('LOCAL', 0, '1', 10, [])]),
        baseRead,
      })!;
      const v = overlay(ref(name), { line: 596, context: [] })!;
      expect(v.kind).toBe('unknown');
      const text = unknownText(v);
      expect(text).toContain('local-no-write');
      expect(text).toContain('命令返回值寄存器');
      expect(text).toContain('引擎动词行');
      expect(text).toContain('不建模');
    });
  }

  it('RESULT 被本函数直线赋值过时照旧取那个值（本批零判定改动）', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('RESULT', 0, '42', 10, [])]),
      baseRead,
    })!;
    expect(overlay(ref('RESULT'), { line: 20, context: [] })).toEqual({ kind: 'value', value: 42 });
  });
});

describe('local-no-write · ④只在更后面写 / 压根没写', () => {
  it('函数内该 LOCAL 槽位只有使用点之后的赋值 → 文案给出行号并说明取不到', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 2, '1', 6236, [])]),
      baseRead,
    })!;
    const v = overlay(ref('LOCAL', ['2']), { line: 6200, context: [] })!;
    expect(v.kind).toBe('unknown');
    const text = unknownText(v);
    expect(text).toContain('只在使用点之后');
    expect(text).toContain('6236');
  });

  it('函数内该 LOCAL 槽位一处赋值都没有 → 保持原判据（残留值不可知）', () => {
    const overlay = createFunctionOverlay({
      detail: makeDetail([assignment('LOCAL', 0, '1', 10, [])]),
      baseRead,
    })!;
    const text = unknownText(overlay(ref('LOCAL', ['7']), { line: 100, context: [] })!);
    expect(text).toContain('本函数内该槽位没有赋值语句，进入函数时的残留值不可知');
  });
});

describe('local-no-write · 呈现面：机器码一枚不加', () => {
  it('四族文案全部沿用 local-no-write（不新增码 ⇒ UI 白话表零同步压力）', () => {
    const cases: Array<readonly [FunctionAssignment[], ControlFlowStatement[], VariableRef, OverlayPosition]> = [
      // ①别支 ②循环量 ③命令返回值寄存器 ④只在使用点之后
      [[assignment('LOCAL', 3, '1', 20, ['s1'])], [], ref('LOCAL', ['3']), { line: 40, context: ['s2'] }],
      [
        [assignment('LOCAL', 0, '1', 10, [])],
        [stmt('FOR', 5, 0, 'LOCAL:1,1,CHARANUM'), stmt('NEXT', 40, 0)],
        ref('LOCAL', ['1']),
        { line: 20, context: ['s1'] },
      ],
      [[assignment('LOCAL', 0, '1', 10, [])], [], ref('RESULT'), { line: 20, context: [] }],
      [[assignment('LOCAL', 1, '1', 60, [])], [], ref('LOCAL', ['1']), { line: 20, context: [] }],
    ];
    for (const [assignments, statements, reference, at] of cases) {
      const overlay = createFunctionOverlay({ detail: makeDetail(assignments, statements), baseRead })!;
      const v = overlay(reference, at)!;
      if (v.kind === 'unknown') expect(v.unknown.code).toBe('local-no-write');
      else expect(`${reference.text} 不该收成 ${v.kind}`).toBe('unknown');
    }
  });
});
