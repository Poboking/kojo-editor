/**
 * eraTW `@巡` 集合声明 + 索引循环发射（K2-FOREACH）。
 *
 * 两层：
 * 1) **数据面**：`ERATW_FOREACH_DECLARATIONS` 冻结、角色集合（`{角}/{名}`）与数组规则
 *    （`{值}/{下标}`）的形状；
 * 2) **发射面**：core `planForEachLoop` 的真实计划 → `emitEratwForEachLoop` 的
 *    `FOR/NEXT` 逐行产物；空集合零轮、未声明/关闭 feature 不产计划、键值集合与表达式
 *    端口失败一律 fail-closed（不产半成品）。
 */
import { describe, expect, it } from 'vitest';

import type { EmitFailure, EmitResult, KojoExprText, KojoForEachLoop } from '@kojo/kojo-core';
import { isEmitFailure, parseSource } from '@kojo/kojo-core';

import type {
  ForeachCollectionDecl,
  ForeachLoopPlan,
  ForeachPlanResult,
} from '../../../../kojo-core/src/lower/expand/foreach.js';
import { planForEachLoop } from '../../../../kojo-core/src/lower/expand/foreach.js';

import {
  ERATW_FOREACH_ARRAY_RULE,
  ERATW_FOREACH_COLLECTIONS,
  ERATW_FOREACH_DECLARATIONS,
} from '../../src/kojo2/collections.js';
import { emitEratwForEachLoop } from '../../src/kojo2/foreach-emit.js';

/* ============================== 助手 ============================== */

const TEAM_SOURCE = ['# 机 初见', '', '@巡 队伍', '    ? {角}的体力 <= 0', '        > {名}看起来累坏了。'].join('\n');

const ARRAY_SOURCE = [
  '# 机 初见',
  '# 设 队伍状态 字符串[4]',
  '',
  '@巡 队伍状态',
  '    > 第{下标 + 1}位。',
].join('\n');

/** 确定性表达式端口：本测试只看循环骨架，集合名原样进产物 */
const compileIdentity = (expr: KojoExprText): string => expr.text;

function loopSource(collection: string): string {
  return ['# 机 初见', '', `@巡 ${collection}`, '    > 一'].join('\n');
}

function loopOf(source: string): KojoForEachLoop {
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

function teamDecl(): ForeachCollectionDecl {
  const team = ERATW_FOREACH_COLLECTIONS.find((collection) => collection.name === '队伍');
  if (team === undefined) throw new Error('eraTW 集合声明缺少「队伍」');
  return team;
}

function failureOf(result: EmitResult): EmitFailure {
  if (!isEmitFailure(result)) throw new Error(`expected EmitFailure, got ${JSON.stringify(result)}`);
  return result;
}

/* ============================== 数据面 ============================== */

describe('eraTW @巡 集合声明（冻结数据）', () => {
  it('整套声明/清单/规则都已冻结', () => {
    expect(Object.isFrozen(ERATW_FOREACH_DECLARATIONS)).toBe(true);
    expect(Object.isFrozen(ERATW_FOREACH_DECLARATIONS.collections)).toBe(true);
    expect(Object.isFrozen(ERATW_FOREACH_COLLECTIONS)).toBe(true);
    expect(Object.isFrozen(ERATW_FOREACH_ARRAY_RULE)).toBe(true);
    expect(ERATW_FOREACH_DECLARATIONS.arrayRule).toBe(ERATW_FOREACH_ARRAY_RULE);
    expect(Object.isFrozen(teamDecl())).toBe(true);
  });

  it('角色集合「队伍」：1 号起、CHARANUM-1 长度、{角}/{名}、CALLNAME 名字访问器', () => {
    const team = teamDecl();

    expect(team).toMatchObject({
      name: '队伍',
      kind: 'characters',
      elementType: 'character',
      base: 1,
      keyType: null,
      bindings: ['角', '名'],
      nameAccessor: 'CALLNAME',
    });
    expect(team.length).toEqual({ kind: 'engine', counter: 'CHARANUM', minus: 1 });
  });

  it('数组规则：0 基、{值}/{下标}（元素类型/长度由 # 设 事实给）', () => {
    expect(ERATW_FOREACH_ARRAY_RULE).toEqual({ base: 0, bindings: ['值', '下标'] });
  });
});

/* ============================== 发射面 ============================== */

describe('eraTW @巡 索引循环（FOR / NEXT）', () => {
  it('角色集合：下标 + 角色号 + 名字槽逐轮填充，体按一级缩进嵌入', () => {
    const plan = planOf(planForEachLoop(loopOf(TEAM_SOURCE), ERATW_FOREACH_DECLARATIONS));
    const result = emitEratwForEachLoop(plan, ['PRINTFORMW 「……好。」'], {
      compileExpression: compileIdentity,
    });

    expect(result).toEqual([
      'FOR __kojo_foreach_3_i, 0, CHARANUM - 1',
      '    __kojo_foreach_3_e = __kojo_foreach_3_i + 1',
      '    __kojo_foreach_3_n = CALLNAME:(__kojo_foreach_3_e)',
      '    PRINTFORMW 「……好。」',
      'NEXT',
    ]);
  });

  it('数组：值槽 = 集合[下标]，长度取声明值（结束值不含 ⇒ 恰好 N 轮）', () => {
    const plan = planOf(
      planForEachLoop(loopOf(ARRAY_SOURCE), ERATW_FOREACH_DECLARATIONS, {
        arrays: [{ name: '队伍状态', elementType: 'string', size: 4 }],
      }),
    );
    const result = emitEratwForEachLoop(plan, ['PRINTFORMW 第%TARGET%位。'], {
      compileExpression: compileIdentity,
    });

    expect(result).toEqual([
      'FOR __kojo_foreach_4_i, 0, 4',
      '    __kojo_foreach_4_e = 队伍状态:(__kojo_foreach_4_i)',
      '    PRINTFORMW 第%TARGET%位。',
      'NEXT',
    ]);
  });

  it('空集合：`FOR i, 0, 0` = 零轮（不先跑一轮空体）', () => {
    const plan = planOf(
      planForEachLoop(loopOf(loopSource('队伍状态')), ERATW_FOREACH_DECLARATIONS, {
        arrays: [{ name: '队伍状态', elementType: 'int', size: 0 }],
      }),
    );

    expect(plan.skeleton.empty).toBe('skip');
    const result = emitEratwForEachLoop(plan, ['PRINTFORMW 不该出现'], {
      compileExpression: compileIdentity,
    });
    expect(result).toEqual([
      'FOR __kojo_foreach_3_i, 0, 0',
      '    __kojo_foreach_3_e = 队伍状态:(__kojo_foreach_3_i)',
      '    PRINTFORMW 不该出现',
      'NEXT',
    ]);
  });

  it('声明了 {角} 但没声明 {名}：不生成名字派生行', () => {
    const angleOnly: ForeachCollectionDecl = { ...teamDecl(), bindings: ['角'] };
    const plan = planOf(planForEachLoop(loopOf(TEAM_SOURCE), { collections: [angleOnly], arrayRule: null }));
    const result = emitEratwForEachLoop(plan, ['PRINTFORMW 「嗯。」'], {
      compileExpression: compileIdentity,
    });

    expect(result).toEqual([
      'FOR __kojo_foreach_3_i, 0, CHARANUM - 1',
      '    __kojo_foreach_3_e = __kojo_foreach_3_i + 1',
      '    PRINTFORMW 「嗯。」',
      'NEXT',
    ]);
  });

  it('循环体空行原样保留（不塞缩进空白）', () => {
    const plan = planOf(planForEachLoop(loopOf(TEAM_SOURCE), ERATW_FOREACH_DECLARATIONS));
    const result = emitEratwForEachLoop(plan, ['PRINTFORMW 甲', '', 'PRINTFORMW 乙'], {
      compileExpression: compileIdentity,
    });

    expect(result).toEqual([
      'FOR __kojo_foreach_3_i, 0, CHARANUM - 1',
      '    __kojo_foreach_3_e = __kojo_foreach_3_i + 1',
      '    __kojo_foreach_3_n = CALLNAME:(__kojo_foreach_3_e)',
      '    PRINTFORMW 甲',
      '',
      '    PRINTFORMW 乙',
      'NEXT',
    ]);
  });
});

/* ============================== fail-closed ============================== */

describe('eraTW @巡：不可声明/不可落点一律 fail-closed', () => {
  it('未声明集合 → core/expr/unknown-symbol（不产计划，也就不会调用 emit）', () => {
    const result = planForEachLoop(loopOf('# 机 初见\n\n@巡 不存在\n    > 一'), ERATW_FOREACH_DECLARATIONS);

    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['core/expr/unknown-symbol']);
    expect(result.diagnostics[0]?.message).toContain('队伍');
  });

  it('feature 关闭 → core/control/unsupported', () => {
    const result = planForEachLoop(loopOf(TEAM_SOURCE), ERATW_FOREACH_DECLARATIONS, { enabled: false });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['core/control/unsupported']);
  });

  it('键值集合（{项}/{键}）：core 可出计划，eraTW emit 明确拒绝', () => {
    const records: ForeachCollectionDecl = {
      name: '记录表',
      kind: 'records',
      elementType: 'int',
      base: 0,
      keyType: 'string',
      length: { kind: 'declared', size: 2 },
      bindings: ['项', '键'],
      nameAccessor: null,
    };
    const plan = planOf(planForEachLoop(loopOf('# 机 初见\n\n@巡 记录表\n    > 一'), { collections: [records], arrayRule: null }));
    const failure = failureOf(
      emitEratwForEachLoop(plan, ['PRINTFORMW 不该出现'], { compileExpression: compileIdentity }),
    );

    expect(failure.diagnostics[0]?.code).toBe('unit/backend-incomplete');
    expect(failure.diagnostics[0]?.message).toContain('键值集合');
  });

  it('表达式端口失败原样上抛（不吞诊断、不产半成品行）', () => {
    const plan = planOf(
      planForEachLoop(loopOf(ARRAY_SOURCE), ERATW_FOREACH_DECLARATIONS, {
        arrays: [{ name: '队伍状态', elementType: 'string', size: 4 }],
      }),
    );
    const portFailure: EmitFailure = {
      diagnostics: [
        {
          code: 'unit/expression-unavailable',
          severity: 'error',
          message: '表达式管线不可用',
          span: null,
        },
      ],
    };
    const result = emitEratwForEachLoop(plan, ['PRINTFORMW 一'], {
      compileExpression: () => portFailure,
    });

    expect(result).toBe(portFailure);
  });

  it('集合表达式编译成非单一变量名 → 自己 fail-closed（不拼下标链）', () => {
    const plan = planOf(
      planForEachLoop(loopOf(ARRAY_SOURCE), ERATW_FOREACH_DECLARATIONS, {
        arrays: [{ name: '队伍状态', elementType: 'string', size: 4 }],
      }),
    );
    const failure = failureOf(
      emitEratwForEachLoop(plan, ['PRINTFORMW 一'], { compileExpression: () => '队伍状态 + 1' }),
    );

    expect(failure.diagnostics[0]?.code).toBe('unit/backend-incomplete');
    expect(failure.diagnostics[0]?.message).toContain('单一变量名');
  });

  it('集合表达式编译成空串 → 自己 fail-closed（不生成 `[i]` 这种残行）', () => {
    const plan = planOf(
      planForEachLoop(loopOf(ARRAY_SOURCE), ERATW_FOREACH_DECLARATIONS, {
        arrays: [{ name: '队伍状态', elementType: 'string', size: 4 }],
      }),
    );
    const failure = failureOf(
      emitEratwForEachLoop(plan, ['PRINTFORMW 一'], { compileExpression: () => '   ' }),
    );

    expect(failure.diagnostics[0]?.code).toBe('unit/backend-incomplete');
    expect(failure.diagnostics[0]?.message).toContain('空串');
  });
});
