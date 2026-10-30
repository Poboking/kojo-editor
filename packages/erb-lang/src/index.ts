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
 * `@kojo/plugin-erb-parser`：ERB 控制流**配对表**的单一真源（`ERB_CONTROL_STATEMENTS` +
 * `classifyControlFlow`，逐条对齐引擎 `FunctionIdentifier.cs` 的 `funcMatch`）。高亮与扩选
 * 都要问"这个词是不是控制词、是哪一档"，那张表不能在这里抄第二份（抄了就必然漂移，
 * 漂移的表现是"高亮指错的块"）。宿主 `monaco/erb-enter.ts` 读的是同一张表——本包与宿主
 * 是并列的两个读者，不是谁引谁。
 */
export * from './constants';
export * from './highlight';
export * from './selection-range';
