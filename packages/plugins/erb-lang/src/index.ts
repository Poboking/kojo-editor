/**
 * `@kojo/plugin-erb-lang` 的入口。
 *
 * 只导出**一个**工厂 + 两枚供方（供测试直调）+ 请求分派谓词。不导出判据本身：
 * 判据住 `@kojo/erb-lang`，从插件转出去等于给它开第二条进入路径（有人会从"插件"引"判据"，
 * 然后以为插件能脱离语言面库单独发布）。
 *
 * 2026-10-30（定义判据归位批）：`definition` 供方已撤回本插件——它需要解析器的标签作用域
 * （`labelScopeAt`），住在解析器插件自己的 `erb-definition` 贡献里；本插件只供高亮 / 扩选。
 */
export { createErbLangPlugin } from './plugin';
export { provideDocumentHighlights } from './highlight';
export { provideSelectionRanges } from './selection-range';
export { isErbRequest } from './request';
