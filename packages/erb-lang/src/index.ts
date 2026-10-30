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
export * from './completion-bits';
/**
 * `completion-context` **逐名导出**（不用 `export *`）：它与 `./highlight` 各有一枚
 * `erbCodeViewOf` ——高亮那枚是"整行视野"（`(line) => string`），补全门这枚是"到光标为止的
 * 视野"（`(line, col0) => 'code' | 'string' | 'comment'`）。两者不是同一个判据，名字相撞
 * 只是历史；桶里先留补全门这枚（宿主与测试的既有 import 面），高亮那枚仍从
 * `@kojo/erb-lang/highlight` 叶子取。**不许**为了消除歧义把其中一枚改成语义不同的别名。
 */
export {
  DEF_RE,
  ERB_CALL_SLOT_BY_KEYWORD,
  ERB_CALL_STATEMENTS,
  ERB_GATE_SOURCE_WHITELIST,
  ERB_JUMP_KEYWORDS,
  NAME_CHAR_RE,
  erbCallKeywords,
  erbCallStatementRe,
  erbCodeViewOf,
  erbCompletionGate,
  erbInterpRegionAt,
  erbLabelSlot,
  parseErbNameSlot,
} from './completion-context';
export type {
  ErbCallSlotKind,
  ErbCallStatement,
  ErbCodeView,
  ErbCompletionGate,
  ErbLabelSlot,
  ErbNameSlot,
} from './completion-context';
export * from './completion-families';
export * from './completion-item';
export * from './completion-variables';
export * from './highlight';
export * from './selection-range';
