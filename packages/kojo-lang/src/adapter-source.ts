/**
 * **2.0 adapter 事实的来源**（模块级登记表）。
 *
 * ## 为什么需要它
 *
 * 2.0 语言面有几条腿要用游戏事实（`@巡 <集合>` 的命名集合、`# 机` 的事件目录）。
 * 这些事实住在 `GameAdapter` 上，而 adapter 对象**只有宿主组合根手里有**：
 * - `game.adapter` **槽**里那枚是 v1 契约对象（`gameId` / `displayName` / `kojo*` 表），
 *   **没有** 2.0 的 `eventCatalog` / `domainSymbols` / `kojo2.foreachCollections`；
 * - `game.adapter` **服务**键在契约里存在，但全仓**没有任何插件 provide 过它**——
 *   所以插件 `ctx.tryInject('game.adapter')` 拿到的是 `undefined`。
 *
 * 于是插件（`@kojo/plugin-kojo-lang`）在"要 adapter 事实"这件事上无路可走。这一层就是那条路：
 * 宿主组合根在装配时**登记一枚 getter**，插件在**请求时**问一次。
 *
 * ## 为什么是模块级登记表，而不是服务
 *
 * 与 `expand-compile.ts` 同一个理由：服务只能由**插件** provide，而这两样东西的持有者是
 * **宿主**（组合根 / 编辑器面板）。为它们硬造一个宿主侧插件，等于为了走服务而先撒一个谎。
 * 登记表是纯数据、零 IO、零 Monaco，天然属于语言面库。
 *
 * 模块同一性：宿主与插件引的是**同一个文件**（`@kojo/kojo-lang/adapter-source`），
 * 打包器按解析后的 id 去重 ⇒ 一张表、一份实例。这一点由 `tests/adapter-source.test.ts`
 * 钉住（登记后立刻能读到）。
 *
 * ## 口径
 *
 * - **零登记零行为**：没人登记 ⇒ `null` ⇒ 语言面退化成"只用本文件能证明的事实"（不猜）；
 * - **请求时现取**：getter 每次调用都重新求值——项目开闭会换人，缓存会把上一个项目的
 *   事实带过来；
 * - **getter 抛错 = 这一轮没有 adapter**（不抛给调用方）：语言面是只读呈现，不能因为
 *   组合根那一刻状态不对就整片哑掉。
 */
import type { GameAdapter } from '@kojo/kojo-core';

/** 取当前 2.0 adapter 的 getter（`null` / `undefined` = 此刻没有） */
export type Kojo2AdapterSource = () => GameAdapter | null | undefined;

/** 登记顺序 = 查询顺序的逆序（后登记的优先：最新装配的那一份才是当前的） */
const sources: Kojo2AdapterSource[] = [];

/**
 * 登记一枚 getter；返回**只撤自己**的注销函数（重复调用幂等）。
 *
 * 宿主在全局 provider 装配处登记一次；测试直接登记桩。
 */
export function registerKojo2AdapterSource(source: Kojo2AdapterSource): () => void {
  sources.push(source);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const at = sources.lastIndexOf(source);
    if (at >= 0) sources.splice(at, 1);
  };
}

/**
 * 此刻的 2.0 adapter（没有登记 / getter 抛错 / 返回非对象 ⇒ `null`）。
 *
 * **不按 `project.adapterId` 过滤**：那件事归调用方——本函数只回答"组合根现在给的是谁"，
 * 而"这份请求是不是它的活"要看请求自带的项目身份。混进来会让这个函数同时承担两件事。
 */
export function kojo2AdapterNow(): GameAdapter | null {
  for (let index = sources.length - 1; index >= 0; index--) {
    const source = sources[index]!;
    let adapter: GameAdapter | null | undefined;
    try {
      adapter = source();
    } catch {
      continue; // 这一枚取不出（组合根正在重建等）⇒ 问下一枚，不把异常带出去
    }
    if (adapter === null || adapter === undefined) continue;
    if (typeof adapter !== 'object') continue;
    return adapter;
  }
  return null;
}

/** 当前登记了几枚（观测面：测试钉"注销不留登记"） */
export function kojo2AdapterSourceCount(): number {
  return sources.length;
}
