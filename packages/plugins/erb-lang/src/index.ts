/**
 * `@kojo/plugin-erb-lang` 的入口。
 *
 * 只导出**一个**工厂 + 四枚供方（供测试直调）+ 请求分派谓词。不导出判据本身：
 * 判据住 `@kojo/erb-lang` / `@kojo/kojo-vocab`，从插件转出去等于给它开第二条进入路径
 * （有人会从"插件"引"判据"，然后以为插件能脱离语言面库单独发布）。
 *
 * 2026-10-30（定义判据归位批）：`definition` 供方已撤回本插件——它需要解析器的标签作用域
 * （`labelScopeAt`），住在解析器插件自己的 `erb-definition` 贡献里；本插件只供高亮 / 扩选。
 *
 * 2026-10-31（LAU-DUALLEG 车 5）：`signatureHelp` 供方进本插件（判据在
 * `@kojo/kojo-vocab/signature`，与 `.kojo1` 那条宿主腿同一把尺子）；`erbParamsOf` 一并
 * 导出只为让单测直接钉"按归一化名 + 定义行回找形参原文"这一条查表口径。
 */
export { createErbLangPlugin } from './plugin';
export { provideDocumentHighlights } from './highlight';
export { provideFormatting } from './formatting';
export { provideSelectionRanges } from './selection-range';
export { erbParamsOf, provideErbSignatureHelp } from './signature';
export { isErbRequest } from './request';
