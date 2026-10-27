/**
 * `@kojo/kojo-sdk` —— **第三方语言包作者**的入口（SDK B5a）。
 *
 * ## 这个包解决什么
 *
 * "再接一门 era 系游戏"今天只有一条路：在宿主里改源码。语言面（补全 / 悬停 / 折叠 /
 * 词法 / 主题 / 结构解析）已经全部包化，但**作者要写一个语言包，得认识三类东西**：
 *
 * 1. 游戏侧契约（`GameAdapter` 及它下面的每一格事实）——住 `@kojo/kojo-core`；
 * 2. 编辑器侧契约（`ui.monaco.language` / `ui.editor.languageService`）——住 `@kojo/plugin-api`；
 * 3. 语言面常量（语义角色表 / 主题规则形状 / 结构 worker 协议版本）——**过去散在库里**，
 *    作者要么 import 一个实现包、要么在包里重抄字符串。
 *
 * 本包把这三类**收成一份导出面**：`import type { GameAdapter } from '@kojo/kojo-sdk'`
 * 就是"我要写一个语言包"的完整声明，不必知道它们原先住哪。
 *
 * ## 四条硬口径（`tests/purity.test.ts` 钉死）
 *
 * 1. **零 Monaco / 零 React / 零 DOM / 零 IO**（连 `import type` 也不算例外）——
 *    这条与 `@kojo/kojo-lang` 同源：插件一旦 import monaco，SDK 这条路就断
 *    （`HANDOFF-kojo2-sdk-packages.md` §5 红线 3）；
 * 2. **零游戏名词**：本包不认识任何一部具体游戏（`tests/purity.test.ts` 扫全树，注释也算）；
 * 3. **只依赖两枚**：`@kojo/kojo-core`（语言事实的契约真源）与 `@kojo/plugin-api`
 *    （插件与槽位的契约真源）。多一枚都要在测试里显式改名单并写清理由；
 * 4. **导出面是契约**：多一个 / 少一个导出都要显式改 `tests/export-surface.test.ts`
 *    （不是"到处能 import 就算数"）。
 *
 * ## 与 `@kojo/kojo-lang` 的分工（别混）
 *
 * | 包 | 是什么 | 谁引 |
 * |---|---|---|
 * | `@kojo/kojo-sdk` | **契约 + 常量**（形状、角色名、协议版本号） | 语言包作者 / 各实现包 |
 * | `@kojo/kojo-lang` | **实现**（符号树怎么摆、缩进阶梯怎么算、Monarch 怎么建） | 编辑器面插件 / 宿主 |
 *
 * 依赖方向单向：`kojo-lang → kojo-sdk → kojo-core`。角色表住 SDK（架构 §7 约束 2：
 * "角色表住 SDK，不住 app"），`kojo-lang` 只是它的**消费者**。
 *
 * ## 桶的纪律（与 `@kojo/kojo-lang` 逐字同一条）
 *
 * 本文件的桶会把整份契约面 re-export 出去（含 core 的桶）。**进首屏的代码只许引叶子**
 * （`@kojo/kojo-sdk/semantic-roles` 这种）——守卫在
 * `packages/app/tests/ps10-eager-graph.test.ts` 的「开机图里对语言面库的引用必须是叶子」。
 */

/* ---------- 契约面（形状；运行时零字节） ---------- */
export type * from './contracts';

/* ---------- 结构 worker 协议（v4：形状 + 版本常量） ---------- */
export * from './structure-protocol';

/* ---------- 语义角色表与主题规则形状（架构 §7 约束 2 的法定落点） ---------- */
export * from './semantic-roles';
