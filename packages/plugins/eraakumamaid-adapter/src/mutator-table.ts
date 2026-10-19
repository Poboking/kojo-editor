/**
 * eraAkumaMaid「数值增减」族表 —— **游戏知识，只住 adapter**。
 *
 * 与 eraTW 的**根本差异**（本表存在的理由）：eraTW 有「增减封装函数」
 * （`CHANGE_CFLAG` / `BUFF_BASE`），所以它的增减糖降成一条 `CALL …(…)`；
 * **本游戏一个都没有**——口上域里增减全是**直写** `族:对象:槽 += n`。
 * 因此本表声明的是契约的 `form: 'assign'` 形态：产物 = `<template> <运算符> <增量>`，
 * 不经过任何函数调用。
 *
 * ## 语料实证（`ERB/EVENT_K/`，558 份 `.ERB`）
 * | 族 | 三段写法 | 三段调用点 | 二段写法（`族:槽`，走当前 TARGET） |
 * |---|---|---|---|
 * | `CFLAG` | `CFLAG:TARGET:好感度 +=` / `CFLAG:MASTER:勉強時間 +=` | 24 | 598 |
 * | `BASE`  | `BASE:MASTER:体力 -= 100` / `BASE:ACTOR:魂 += 100` | 101 | 93 |
 * | `EXP`   | `EXP:PLAYER:拘束経験 +=` / `EXP:MASTER:ラホ経験 +=` | 16 | 256 |
 * | `PALAM` | `PALAM:TARGET:反感 +=` | 17 | 25 |
 * | `ABL`   | `ABL:MASTER:…` / `ABL:TARGET:…` | 183 | 18 |
 * （二段写法是引擎的"省略对象 = 当前 TARGET"糖；三层结构确实存在，见三段列。）
 *
 * ## 为什么只这五族
 * - `JUEL`（51 处）/ `SOURCE`（11 处）是**一维**数组（`JUEL:欲情`），没有「对象」这一段
 *   ⇒ 三段式 `族:对象:槽` 在本游戏里根本拼不出对应左值，硬收会让作者写出编不过的行。
 * - `TALENT`（10 处）是**位标志**，改动语义是"置/清某一位"而不是加减
 *   （语料里 `TALENT:… +=` 的用法是位掩码并集）⇒ 用 `增减` 表达会产出语义错误的行。
 * - 其余 `CSTR` / `MARK` 同理：一维或非算术。
 * 这四条都在 `variable-schema.ts` 的 `ENGINE_FAMILIES` 里有对应族，是**"该族存在但没有
 * 加减语义"**，不是"不知道有这一族"。
 *
 * ## 槽形态
 * 五个族的槽都是**名字**（`体力` / `魂` / `好感度` / `拘束経験` / `反感`），语料里没有
 * 纯数字下标的口上写法 ⇒ 一律 `'name-or-number'`（名原样透传；数字也不拦）。
 * 对象段同样原样透传——语料里它可以是表达式（`EXP:FIND_COND("真")`、`CFLAG:ARG`），
 * 对 `FIND_COND` 这类调用做降糖会误报 `unknown-identifier`。
 *
 * 查不到的族一律 `undefined`（**绝不猜**）；未登记族由糖层 fail-closed 报诊断。
 */

import type { KojoMutatorSpec, KojoMutatorTable } from '@kojo/plugin-api';

/** 族头 → 直写规格（单一真源；手工维护，随实测增补）。 */
export const AM_MUTATOR_FAMILIES: ReadonlyMap<string, KojoMutatorSpec> = new Map<string, KojoMutatorSpec>([
  // 五个族的原生族头就是作者写的族头，模板因此不出现 `{family}`（写死原生名，
  // 将来若要加中文族头别名，改模板即可、不必动糖层）。
  ['CFLAG', { form: 'assign', template: 'CFLAG:{object}:{slot}', slotMode: 'name-or-number' }],
  ['BASE', { form: 'assign', template: 'BASE:{object}:{slot}', slotMode: 'name-or-number' }],
  ['EXP', { form: 'assign', template: 'EXP:{object}:{slot}', slotMode: 'name-or-number' }],
  ['PALAM', { form: 'assign', template: 'PALAM:{object}:{slot}', slotMode: 'name-or-number' }],
  ['ABL', { form: 'assign', template: 'ABL:{object}:{slot}', slotMode: 'name-or-number' }],
]);

/** 由「族头 → 规格」映射构建查询面（纯数据，无 IO）。 */
export function createErakumamaidMutatorTable(map: ReadonlyMap<string, KojoMutatorSpec>): KojoMutatorTable {
  const byFamily = new Map(map);
  return {
    hasTable: byFamily.size > 0,
    lookupByFamily: (family) => byFamily.get(family),
  };
}
