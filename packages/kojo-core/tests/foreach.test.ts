/**
 * `@巡` 集合声明校验 + 索引循环计划（K2-FOREACH）。
 *
 * 覆盖：
 * - 角色集合（`{角}` / `{名}`）与数组（`{值}` / `{下标}`）的槽/绑定事实；
 * - 数组规则 + 作者 `# 设` 事实（`@巡 队伍状态`）；
 * - 空集合 → `skeleton.empty = 'skip'`；未声明集合 / feature 关闭 / 声明不自洽 → 不产 plan；
 * - 槽名按块头行号（嵌套循环不互撞）、`slotPrefix` 覆盖、纯函数稳定性。
 */
import { describe, expect, it } from 'vitest';

import type { KojoForEachLoop } from '../src/ast.js';
import { parseSource } from '../src/parser.js';
import type {
  ForeachCollectionDecl,
  ForeachDeclarations,
  ForeachLoopPlan,
  ForeachPlanResult,
} from '../src/lower/expand/foreach.js';
import { foreachBindingSlot, planForEachLoop } from '../src/lower/expand/foreach.js';

/* ============================== 夹具与助手 ============================== */

function loopSource(collection: string): string {
  return ['# 机 初见', '', `@巡 ${collection}`, '    > 一'].join('\n');
}

/** 角色集合用例（含两端绑定与条件体） */
const TEAM_SOURCE = ['# 机 初见', '', '@巡 队伍', '    ? {角}的体力 <= 0', '        > {名}看起来累坏了。'].join('\n');

/** 数组用例（含 `# 设 … [N]` 声明） */
const ARRAY_SOURCE = [
  '# 机 初见',
  '# 设 队伍状态 字符串[4]',
  '',
  '@巡 队伍状态',
  '    > 第{下标 + 1}位。',
].join('\n');

const TEAM: ForeachCollectionDecl = {
  name: '队伍',
  kind: 'characters',
  elementType: 'character',
  base: 1,
  keyType: null,
  length: { kind: 'engine', counter: 'CHARANUM', minus: 1 },
  bindings: ['角', '名'],
  nameAccessor: 'CALLNAME',
};

const TEAM_STATE: ForeachCollectionDecl = {
  name: '队伍状态',
  kind: 'array',
  elementType: 'string',
  base: 0,
  keyType: null,
  length: { kind: 'declared', size: 4 },
  bindings: ['值', '下标'],
  nameAccessor: null,
};

function declarations(...collections: readonly ForeachCollectionDecl[]): ForeachDeclarations {
  return { collections, arrayRule: null };
}

function forEachLoopOf(source: string): KojoForEachLoop {
  const file = parseSource(source);
  expect(file.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  for (const scene of file.scenes) {
    for (const node of scene.items) {
      if (node.kind === 'forEachLoop') return node;
    }
  }
  throw new Error('fixture 里没有 @巡');
}

function planOf(result: ForeachPlanResult): ForeachLoopPlan {
  if (!result.ok) throw new Error(`unexpected diagnostics: ${JSON.stringify(result.diagnostics)}`);
  return result.plan;
}

function codesOf(result: ForeachPlanResult): readonly string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

/* ============================== 角色集合 ============================== */

describe('@巡 · 角色集合（{角} / {名}）', () => {
  it('产出下标 + 角色号 + 名字三个槽，绑定各就各位', () => {
    const loop = forEachLoopOf(TEAM_SOURCE);
    const plan = planOf(planForEachLoop(loop, declarations(TEAM)));

    expect(plan.kind).toBe('characters');
    expect(plan.elementType).toBe('character');
    expect(plan.collection).toBe('队伍');
    expect(plan.collectionExpr).toBe(loop.collection);
    expect(plan.base).toBe(1);
    expect(plan.nameAccessor).toBe('CALLNAME');
    expect(plan.span.start.line).toBe(3);
    // 体零拷贝：plan 不复制叙事节点
    expect(plan.body).toBe(loop.body);
  });

  it('槽名按块头行号，静态类型与角色号/名字一致', () => {
    const plan = planOf(planForEachLoop(forEachLoopOf(TEAM_SOURCE), declarations(TEAM)));

    expect(plan.index).toEqual({ name: '__kojo_foreach_3_i', role: 'index', valueType: 'int' });
    expect(plan.slots).toEqual([
      { name: '__kojo_foreach_3_i', role: 'index', valueType: 'int' },
      { name: '__kojo_foreach_3_e', role: 'element', valueType: 'int' },
      { name: '__kojo_foreach_3_n', role: 'name', valueType: 'string' },
    ]);
    expect(plan.bindings).toEqual([
      { name: '角', source: 'element', valueType: 'int', slot: '__kojo_foreach_3_e' },
      { name: '名', source: 'name', valueType: 'string', slot: '__kojo_foreach_3_n' },
    ]);
  });

  it('骨架 = 0 基 / 每轮 +1 / 空集合整块跳过 / 长度来自引擎计数器', () => {
    const plan = planOf(planForEachLoop(forEachLoopOf(TEAM_SOURCE), declarations(TEAM)));

    expect(plan.skeleton).toEqual({
      start: 0,
      step: 1,
      length: { kind: 'engine', counter: 'CHARANUM', minus: 1 },
      empty: 'skip',
    });
    expect(plan.length).toEqual({ kind: 'engine', counter: 'CHARANUM', minus: 1 });
  });
});

/* ============================== 数组 ============================== */

describe('@巡 · 数组（{值} / {下标}）', () => {
  it('命名数组声明：值槽承接元素类型，长度取声明值', () => {
    const plan = planOf(planForEachLoop(forEachLoopOf(ARRAY_SOURCE), declarations(TEAM_STATE)));

    expect(plan.kind).toBe('array');
    expect(plan.elementType).toBe('string');
    expect(plan.length).toEqual({ kind: 'declared', size: 4 });
    expect(plan.bindings).toEqual([
      { name: '值', source: 'element', valueType: 'string', slot: '__kojo_foreach_4_e' },
      { name: '下标', source: 'index', valueType: 'int', slot: '__kojo_foreach_4_i' },
    ]);
    expect(plan.slots.map((slot) => slot.role)).toEqual(['index', 'element']);
  });

  it('数组规则 + 作者数组事实：`# 设 队伍状态 整数[3]` 可巡', () => {
    const result = planForEachLoop(forEachLoopOf(loopSource('队伍状态')), {
      collections: [],
      arrayRule: { base: 0, bindings: ['值', '下标'] },
    }, {
      arrays: [{ name: '队伍状态', elementType: 'int', size: 3 }],
    });
    const plan = planOf(result);

    expect(plan.kind).toBe('array');
    expect(plan.elementType).toBe('int');
    expect(plan.length).toEqual({ kind: 'declared', size: 3 });
    expect(plan.bindings.find((binding) => binding.name === '值')).toMatchObject({
      source: 'element',
      valueType: 'int',
    });
  });

  it('键值集合：{项}/{键} 各自落槽，键类型取声明（core 只给事实，落点交 adapter）', () => {
    const records: ForeachCollectionDecl = {
      name: '记录表',
      kind: 'records',
      elementType: 'string',
      base: 0,
      keyType: 'int',
      length: { kind: 'declared', size: 2 },
      bindings: ['项', '键'],
      nameAccessor: null,
    };
    const plan = planOf(planForEachLoop(forEachLoopOf(loopSource('记录表')), declarations(records)));

    expect(plan.bindings).toEqual([
      { name: '项', source: 'element', valueType: 'string', slot: '__kojo_foreach_3_e' },
      { name: '键', source: 'key', valueType: 'int', slot: '__kojo_foreach_3_k' },
    ]);
    expect(plan.slots.map((slot) => slot.role)).toEqual(['index', 'element', 'key']);
    expect(plan.keyType).toBe('int');
  });

  it('空集合仍出计划，但事实写死"整块跳过"（长度 0 ⇒ 零轮）', () => {
    const result = planForEachLoop(forEachLoopOf(loopSource('队伍状态')), {
      collections: [],
      arrayRule: { base: 0, bindings: ['值', '下标'] },
    }, {
      arrays: [{ name: '队伍状态', elementType: 'int', size: 0 }],
    });
    const plan = planOf(result);

    expect(plan.skeleton.empty).toBe('skip');
    expect(plan.skeleton.length).toEqual({ kind: 'declared', size: 0 });
  });
});

/* ============================== 失败面 ============================== */

describe('@巡 · 不可声明（不产半成品）', () => {
  it('未声明集合 → core/expr/unknown-symbol，plan 为 null，文案列出可用集合', () => {
    const result = planForEachLoop(forEachLoopOf(loopSource('不存在')), declarations(TEAM));

    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(codesOf(result)).toEqual(['core/expr/unknown-symbol']);
    expect(result.diagnostics[0]?.message).toContain('不存在');
    expect(result.diagnostics[0]?.message).toContain('队伍');
  });

  it('数组规则在但没有该数组事实 → 仍按未声明报错', () => {
    const result = planForEachLoop(forEachLoopOf(loopSource('队伍状态')), {
      collections: [],
      arrayRule: { base: 0, bindings: ['值', '下标'] },
    });

    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(codesOf(result)).toEqual(['core/expr/unknown-symbol']);
    expect(result.diagnostics[0]?.message).toContain('数组');
  });

  it('feature 关闭 → core/control/unsupported（与 checkProgramFeature 同码，优先于集合解析）', () => {
    const result = planForEachLoop(forEachLoopOf(TEAM_SOURCE), declarations(TEAM), { enabled: false });

    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(codesOf(result)).toEqual(['core/control/unsupported']);
    expect(result.diagnostics[0]?.message).toContain('programFeatures.foreach');
  });

  it('同一集合重复声明 → symbol 错，不挑一条猜', () => {
    const result = planForEachLoop(forEachLoopOf(TEAM_SOURCE), declarations(TEAM, TEAM));

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toEqual(['core/expr/unknown-symbol']);
    expect(result.diagnostics[0]?.message).toContain('重复出现');
  });

  const invalid: readonly { readonly label: string; readonly declaration: ForeachCollectionDecl; readonly expected: string }[] = [
    {
      label: '角色集合不能声明 {值}',
      declaration: { ...TEAM, bindings: ['值'] },
      expected: '不能声明 {值}',
    },
    {
      label: '声明了 {名} 却没有 {角}',
      declaration: { ...TEAM, bindings: ['名'] },
      expected: '却没有 {角}',
    },
    {
      label: '声明了 {名} 却没有 nameAccessor',
      declaration: { ...TEAM, nameAccessor: null },
      expected: 'nameAccessor',
    },
    {
      label: 'base 不能为负',
      declaration: { ...TEAM, base: -1 },
      expected: 'base',
    },
    {
      label: '非键值集合的 keyType 必须为 null',
      declaration: { ...TEAM, keyType: 'string' },
      expected: 'keyType',
    },
    {
      label: '绑定不能重复',
      declaration: { ...TEAM, bindings: ['角', '名', '名'] },
      expected: '重复声明',
    },
    {
      label: '不能没有绑定',
      declaration: { ...TEAM, bindings: [] },
      expected: '没有声明任何绑定',
    },
    {
      label: '引擎长度必须有计数器',
      declaration: { ...TEAM, length: { kind: 'engine', counter: '  ', minus: 1 } },
      expected: '计数器',
    },
  ];

  for (const item of invalid) {
    it(`声明不自洽：${item.label}`, () => {
      const result = planForEachLoop(forEachLoopOf(loopSource('队伍')), declarations(item.declaration));

      expect(result.ok).toBe(false);
      expect(result.plan).toBeNull();
      expect(codesOf(result)).toEqual(['core/expr/unknown-symbol']);
      expect(result.diagnostics[0]?.message).toContain(item.expected);
    });
  }

  it('键值集合缺 keyType → symbol 错（键的静态类型不能猜）', () => {
    const records: ForeachCollectionDecl = {
      name: '记录表',
      kind: 'records',
      elementType: 'int',
      base: 0,
      keyType: null,
      length: { kind: 'declared', size: 2 },
      bindings: ['项', '键'],
      nameAccessor: null,
    };
    const result = planForEachLoop(forEachLoopOf(loopSource('记录表')), declarations(records));

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toEqual(['core/expr/unknown-symbol']);
    expect(result.diagnostics[0]?.message).toContain('keyType');
  });
});

/* ============================== 槽名与纯函数 ============================== */

describe('@巡 · 槽名与纯函数', () => {
  it('嵌套循环按各自块头行号取槽名，不互撞', () => {
    const source = ['# 机 初见', '', '@巡 队伍', '    @巡 队伍', '        > 内层'].join('\n');
    const outer = planOf(planForEachLoop(forEachLoopOf(source), declarations(TEAM)));
    const innerNode = outer.body[0];
    if (innerNode?.kind !== 'forEachLoop') throw new Error('内层不是 @巡');
    const inner = planOf(planForEachLoop(innerNode, declarations(TEAM)));

    expect(outer.index.name).toBe('__kojo_foreach_3_i');
    expect(inner.index.name).toBe('__kojo_foreach_4_i');
  });

  it('slotPrefix 可覆盖（模板展开复制同一块时的消歧口）', () => {
    const plan = planOf(
      planForEachLoop(forEachLoopOf(loopSource('队伍')), declarations(TEAM), {
        slotPrefix: '__kojo_foreach_tpl7',
      }),
    );

    expect(plan.index.name).toBe('__kojo_foreach_tpl7_i');
    expect(plan.slots[1]?.name).toBe('__kojo_foreach_tpl7_e');
  });

  it('foreachBindingSlot：绑定名 → 槽（walk 改写体的查表口）', () => {
    const plan = planOf(planForEachLoop(forEachLoopOf(TEAM_SOURCE), declarations(TEAM)));

    expect(foreachBindingSlot(plan, '角')).toBe('__kojo_foreach_3_e');
    expect(foreachBindingSlot(plan, '名')).toBe('__kojo_foreach_3_n');
    expect(foreachBindingSlot(plan, '下标')).toBeNull();
    expect(foreachBindingSlot(plan, '不存在')).toBeNull();
  });

  it('同输入同输出；plan 的槽/绑定数组只读', () => {
    const loop = forEachLoopOf(TEAM_SOURCE);
    const first = planOf(planForEachLoop(loop, declarations(TEAM)));
    const second = planOf(planForEachLoop(loop, declarations(TEAM)));

    expect(first).toEqual(second);
    expect(Object.isFrozen(first.slots)).toBe(true);
    expect(Object.isFrozen(first.bindings)).toBe(true);
    expect(first.body).toBe(loop.body);
  });
});
