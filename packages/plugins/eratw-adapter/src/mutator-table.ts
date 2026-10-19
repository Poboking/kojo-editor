/**
 * eraTW「数值增减」族表 —— **游戏知识，只住 adapter**（1016 批）。
 *
 * 「族 → 目标函数 + 参数序」是游戏知识：作者写 `族:对象:槽` 时，把"改这一族某个槽"
 * 降成哪条 `CALL`、三个实参怎么排，只有游戏侧知道。糖层（kojo-sugar）只查本表、不解释。
 *
 * ## 语料实证（`個人口上` / `口上関連` 内）
 * - `CALL CHANGE_CFLAG(<槽>, <对象>, <增量>)` —— 槽 = CFLAG 下标（数字，如 `2`/`4`）；
 *   体内 `CFLAG:对象:槽 = MAX(CFLAG:对象:槽 + 增量, 0)` + `CALL COLORMESSAGE(...)`（记账/上色）。
 * - `CALL BUFF_BASE(<对象>, <槽>, <增量>)` —— 槽 = BASE 下标（数字**或名**，如 `BASE_体力`）；
 *   体内同改 `MAXBASE/BASE/BUFF` 三处 + 钳制 + 可选消息。
 *
 * 两族的**参数序不同**（槽在前 / 对象在前），故必须按族声明；变量槽取值形态也不同：
 * CFLAG 只接受数字下标（写名时工程内取不到"名 → 编号"的映射 ⇒ fail-closed，绝不猜）；
 * BASE 接受名（语料直接传 `BASE_体力`）⇒ 原样传。
 *
 * 与 `library-table.ts` 同形（同一 seam：adapter 建纯数据表、糖层只查）。查不到的族一律
 * `undefined`（**绝不猜**，规范 §5.3 精神）；未登记族由糖层 fail-closed 报诊断。
 */

import type { KojoMutatorSpec, KojoMutatorTable } from '@kojo/plugin-api';

/** 族头 → 增减规格（单一真源；手工维护，随实测增补）。 */
export const ERATW_MUTATOR_FAMILIES: ReadonlyMap<string, KojoMutatorSpec> = new Map<string, KojoMutatorSpec>([
  // CFLAG 族：`CALL CHANGE_CFLAG(<槽>, <对象>, <增量>)`；槽 = CFLAG 下标（数字）。
  ['CFLAG', { form: 'call', engine: 'CHANGE_CFLAG', argOrder: ['slot', 'object', 'delta'], slotMode: 'number' }],
  // BASE 族：`CALL BUFF_BASE(<对象>, <槽>, <增量>)`；槽 = BASE 下标（名或数字，原样传）。
  ['BASE', { form: 'call', engine: 'BUFF_BASE', argOrder: ['object', 'slot', 'delta'], slotMode: 'name-or-number' }],
]);

/** 由「族头 → 规格」映射构建查询面（纯数据，无 IO）。 */
export function createEratwMutatorTable(map: ReadonlyMap<string, KojoMutatorSpec>): KojoMutatorTable {
  const byFamily = new Map(map);
  return {
    hasTable: byFamily.size > 0,
    lookupByFamily: (family) => byFamily.get(family),
  };
}

/** 空表实例（无表时返回它；`hasTable=false`，查啥都 undefined）。 */
export const EMPTY_MUTATOR_TABLE: KojoMutatorTable = createEratwMutatorTable(new Map());
