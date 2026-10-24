/**
 * 「谁是当前激活的 adapter」的判据（单源实现）。
 *
 * ## 为什么这个函数不住 `game.ts`
 *
 * 它是 `game.ts` 唯一的**值**导出消费点：`index.ts` 的桶一旦 `export { … } from './game'`，
 * 开机图里任何一枚对桶的值引用（`WellKnownServices` / `createWorkerTransport` …）都会把
 * 整个 `game.ts`（45 KB 的 v1 契约面）透传进欢迎页——和 B1 记的「`@kojo/kojo-lang`
 * 桶 re-export 整包，读数 +82 KB」是同一条教训：**值导出决定模块图，type 导出不会**。
 * 拆成独立文件后，桶改指本模块，开机图只为这三行循环付费（约 1 KB），`game.ts` 回到
 * 「只剩 type 导出 ⇒ 编译后擦除」的形态。
 *
 * 判据本身从 `game.ts` 原样搬来（行为逐字不变；14 个消费方的 import 路径
 * `from '@kojo/plugin-api'` 一律不动，单源性不受影响）。
 *
 * 依赖方向：只 type-only import `GameAdapter`（编译后擦除）——「挑适配器」不需要懂
 * 「适配器怎么注册进槽」（那是 `slots.ts` 的事），单向依赖守住。
 */
import type { GameAdapter } from './game.js';

/**
 * 从 `game.adapter` 槽位的查询结果里挑出**当前激活**的那一枚适配器。
 *
 * 槽语义是「同一项目同一时刻只有一个激活实现」（见 `GameAdapter` 首段），
 * 而内核只把结果写成 `GameProject.adapterId` ——「谁是当前那枚」这个判据的
 * 唯一形态就是 `contribution.adapter.gameId === project.adapterId`。
 *
 * ## 为什么值得一个具名函数
 *
 * 这条判据原先被 14 个消费方各手写一遍（条件抽取 / 约定校验 / 糖层 / 状态回放 /
 * 条件矩阵 / 约定报告 / 口上导航 / 快照注入 / 回放面板 / 新建文件向导 / 词典备注
 * 台账 / Monaco 全局表 / 项目视图）。手写一份的代价不是那三行循环，是**每处都能
 * 悄悄长出一点差异**：有的先判 `project` 有无、有的忘了判、有的在循环里 `return`
 * 有的 `continue`、有的取整枚 adapter 有的只取一个字段。判据一旦分叉，症状是
 * 「A 面板认得出这个游戏、B 面板认不出」——而且没有任何门禁拦得住。
 *
 * 现在差异只剩一种：调用方拿整枚 adapter 还是拿其中某个字段。取字段就是
 * `activeGameAdapter(...)?.variableSchema`，缺省语义自然落在 `undefined` 上
 * （消费方本来就该显式降级，绝不猜）。
 *
 * `adapterId` 收 `null | undefined` 是为了贴合调用点的真实形状：没开项目时
 * `project.current()?.adapterId` 就是 `undefined`，不必每个调用方先写一次卫语句。
 *
 * 参数是**查询结果**而不是 `SlotRegistry`，两个理由：
 * - **依赖方向**：`slots.ts` 已经 import `game.ts` 的 `GameAdapter`（`GameAdapterContribution`）。
 *   `GameAdapter` 回答的是「一个适配器是什么」，`SlotRegistry` 回答的是「插件怎么注册与
 *   查询」——让前者依赖后者，等于说「定义一个 adapter 需要懂槽机制」，不成立。两个都是
 *   type-only import，编译后都会擦除、不会炸运行时，但概念上的单向依赖要守住。
 * - **纯函数更好用**：收数组就能用字面量直接测；且「什么时候查、查几次」的决定权留在
 *   调用方——`editorTables` 就是同一份 contributions 既挑当前那枚、又喂给 `staticTablesFor`。
 */
export function activeGameAdapter<T extends { readonly adapter: GameAdapter }>(
  contributions: readonly T[],
  adapterId: string | null | undefined,
): GameAdapter | undefined {
  if (!adapterId) return undefined;
  for (const contribution of contributions) {
    if (contribution.adapter.gameId === adapterId) return contribution.adapter;
  }
  return undefined;
}
