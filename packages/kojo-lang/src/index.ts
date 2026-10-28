/**
 * `@kojo/kojo-lang` —— **Kojo 语言面库**：编辑器要知道的判据，纯函数纯数据。
 *
 * ## 这个包回答什么问题
 *
 * `@kojo/kojo-core` 管"这段文本**是什么**"（词法 / 语法 / 语义 / 编译 / 诊断码）；
 * 本包管"编辑器**要知道**什么"——符号树怎么摆、声明索引长什么样、编译产物与源怎么对位、
 * 一个字符算不算名字字符。两者的界线是**能不能在 node 里 import 就跑**：
 * core 的产出是 AST 与诊断，本包的产出是给编辑器面直接摆上屏的结构。
 *
 * ## 硬约束（B1 立的边界，后续批不许破）
 *
 * - **零 `monaco-editor`**：包一旦 import 它，就只能被宿主用，插件化立刻倒退。
 *   翻译成 `monaco.languages.*` 的那一半留在宿主（如 `app/src/monaco/kojo2-symbols.ts`）；
 * - **零 React / 零 DOM / 零 IO**：不读盘、不碰 `window`、不发事件；
 * - **零 adapter**：游戏事实一律由调用方递进来，本包不认识任何游戏名词。
 *
 * ## 桶 + 叶子（子路径导出为什么必须有）
 *
 * 两类消费方，量级差三个数量级：
 * - **要整块**：`kojo2-providers` / `kojo2-symbols` 这些编辑器面文件，本来就在懒 chunk 里，
 *   走桶（`@kojo/kojo-lang`）最省事；
 * - **只要一枚**：路由层要扩展名（`kojo2-cutover` / `kojo2-open` / `kojo2-open-paths`）、
 *   重挂层要语言 id、补全位置判据要字符集——**它们都在开机图里**。
 *
 * 实测（B1 第一版只有桶）：首屏读数 3,110 → 3,192 KB，整包 85 KB 全被拖进欢迎页。
 * PS-10 的体积闸当场红了——那正是它存在的意义。故 `exports` 逐模块开子路径，
 * 开机侧一律 import 叶子；判据很简单：**能进首屏的文件只许引叶子**。
 *
 * `tsconfig` 的 `@kojo/kojo-lang/*` 与 `vite.config.ts` 的别名表逐条对应本文件的
 * `exports`，三处漂了 PS-10 的走图器会当场报"解析不到"（它读的就是 vite 的别名表）。
 */
export * from './constants';
export * from './name-chars';
export * from './interpolation';
export * from './declarations';
export * from './sourcemap';
export * from './expand-view';
export * from './symbols';
export * from './definition';
export * from './inlay';
// B3c 车道 2：2.0 **补全与悬停的判据**整块从宿主 `monaco/kojo2-*.ts` 搬进本包
// （候选组装 / 块级 snippets / 悬停正文与 Markdown 措辞 / 事件挂点）。理由同 `definition`：
// 供方是插件，插件读不到宿主，判据留在宿主就会长出第二份。开机侧一律引叶子。
export * from './completion';
export * from './completion-snippets';
export * from './hover';
export * from './event-sites';
export * from './adapter-source';
export * from './expand-compile';
// B3d（2026-10-28）：2.0 **签名帮助与文档格式化的判据**整块从宿主 `monaco/kojo2-*.ts` 搬进来
// 两枚——`signature`（调用位 / 声明头 / `@巡` 集合签名）与 `format`（整篇 + 区间格式化规则）。
// 理由与 B3c 的补全 / 悬停逐字相同：供方是插件，插件读不到宿主，判据留在宿主就会长出第二份。
// 开机侧一律引叶子（`@kojo/kojo-lang/signature` / `/format`），桶只给"要整块"的消费方。
export * from './signature';
export * from './format';
// B3e（2026-10-29）：2.0 **查找引用与符号改名**的判据整块从宿主 `monaco/kojo2-*.ts` 搬进来
// 两枚——`references`（同文件 + 跨文件合并 / 500 引用上限 / 项目文件快照口）与 `rename`
// （prepare / 三道闸 / 64 文件·2000 编辑上限 / 快照 resolver）。理由与 B3c / B3d 逐字相同：
// 供方是插件，插件读不到宿主；开机侧一律引叶子（`@kojo/kojo-lang/references` / `/rename`）。
export * from './references';
export * from './rename';
// B4：角色表与角色调色板（架构 §7.2「角色表住 SDK 不住 app」）——**开机侧引叶子**，
// 这两枚进桶只是为了让"要整块"的消费方一次拿全。
export * from '@kojo/kojo-sdk/semantic-roles';
export * from './theme-rules';
// B4：2.0 的 Monaco 语言面本体（词表 / Monarch 状态机 / 语言配置 / 三套主题装配）。
// 供方是 `@kojo/plugin-kojo-lang`，宿主只把槽里的数据落进 Monaco。
export * from './lexicon';
export * from './monarch';
export * from './language-config';
export * from './monaco-theme';
