/**
 * `@kojo/erb-lang` —— **ERB 语言面库**：编辑器要知道的判据，纯函数纯数据。
 *
 * ## 这个包回答什么问题
 *
 * ERB 是宿主的一等语言（`.erb` / `.erm` / `.erh`），但"编辑器要知道的判据"此前全住在
 * 宿主 `packages/app/src/monaco/erb-*.ts` 里。LAU-4 第一步把其中**两条腿**的判据整块搬进来：
 *
 * | 叶子 | 判据 | 供方 |
 * | --- | --- | --- |
 * | `@kojo/erb-lang/highlight` | 同符号高亮（write / read / text 三档 + 位置门） | 插件 `@kojo/plugin-erb-lang` 的 `erb-documentHighlight` |
 * | `@kojo/erb-lang/selection-range` | 结构化扩选（词 → 行 → 分支段 → 标签块 → 函数块 → 全文） | 插件 `@kojo/plugin-erb-lang` 的 `erb-selectionRange` |
 *
 * 这与 kojo2 在 B3f 批走的路**逐字同形**（判据进包 → 供方进插件 → 宿主只剩请求 / 翻译 /
 * 注册）：两门语言从此用同一条槽 `ui.editor.languageService`、同一份契约、同一套三态。
 *
 * ## 硬约束（与 `@kojo/kojo-lang` 同一套，后续批不许破）
 *
 * - **零 `monaco-editor`**：包一旦 import 它，就只能被宿主用，插件化立刻倒退。翻
 *   `Monaco.IRange` / `DocumentHighlightKind` / 0.57 的扁平 `SelectionRange[]` 的那一半
 *   留在宿主（`app/src/monaco/erb-highlight.ts` / `erb-selection-range.ts`）；
 * - **零 React / 零 DOM / 零 IO**：不读盘、不碰 `window`、不发事件；
 * - **零 adapter / 零游戏名词**：本包不认识任何一部具体游戏。
 *
 * ## 桶 + 叶子
 *
 * 两条腿的消费方各取所需：宿主与插件都只引**叶子**（`/highlight` / `/selection-range`），
 * 桶留给"要整块"的调用方与测试。`tsconfig` 的 `@kojo/erb-lang/*` 与两份 vite 配置的
 * 别名表逐条对应 `package.json` 的 `exports`——三处漂了，PS-10 的走图器会当场报
 * "解析不到"（它读的就是 vite 的别名表）。
 *
 * ## 唯一的外部依赖
 *
 * `@kojo/erb-vocab/control-flow`：ERB 控制流**配对表**的单一真源（`ERB_CONTROL_STATEMENTS` +
 * `classifyControlFlow`，逐条对齐引擎 `FunctionIdentifier.cs` 的 `funcMatch`）。高亮与扩选
 * 都要问"这个词是不是控制词、是哪一档"，那张表不能在这里抄第二份（抄了就必然漂移，
 * 漂移的表现是"高亮指错的块"）。
 *
 * 2026-10-30（ERB-VOCAB 批）之前这条依赖指向**插件** `@kojo/plugin-erb-parser`——库包引
 * 插件包是分层倒置。表已上提到非插件库包 `@kojo/erb-vocab`（与 `@kojo/kojo-vocab` 同性质），
 * 插件 `@kojo/plugin-erb-parser` 改为 re-export 它、宿主 `monaco/erb-enter.ts` 经插件照旧读
 * 同一张表：**三方并列读者**，谁也不引谁，单一真源一格未动。
 */
export * from './constants';
export * from './highlight';
export * from './selection-range';

/**
 * ## 补全判据已出本包（LAU-4 补全腿第二批，2026-10-31）
 *
 * 本包曾经持有五枚补全叶子（`completion-bits` / `completion-context` / `completion-families` /
 * `completion-item` / `completion-members` / `completion-variables`）。它们被整块搬进**常驻
 * 解析器插件** `@kojo/plugin-erb-parser` 的 `src/completion.ts`，理由只有一条：判据要由槽
 * （`ui.editor.languageService` 的 `completion`）的**供方**回答，而供方是本包**不许依赖**的
 * 插件；反过来插件静态引本包的补全叶子会把 2.0 补全词表链（9 枚模块 / 约 113 KB）拽进开机
 * 静态图，撞碎 ps10 的 199 文件闸（实测 199 ⇒ 208）。
 *
 * 搬走的口径一字未改（九态位置门 / 名字槽 / 标签位 / 变量段 / 位坑 / 成员位 / 白名单），
 * 唯一变化是地基三枚：空白类改引契约层 `ERB_BLANK_CLASS_STR`（`@kojo/plugin-api`）、名字字符集
 * 改引同层的 `MODEL_TOKEN_CLASS`、引擎族表照旧引 `@kojo/kojo-vocab/engine`。
 *
 * 本包此后只剩**两条腿**（高亮 / 扩选）——它们不由槽的供方驱动（供方在 `@kojo/plugin-erb-lang`，
 * 那座插件是**懒装载**的，不占开机图），所以留在这里是对的。
 */
