/**
 * `@kojo/plugin-kojo-lang` 的入口。
 *
 * 只导出**一个**工厂 + 供方（供测试直调）。不导出 `SYMBOL_KIND` 之类内部表：
 * 类别映射是这一层对契约的承诺，别人拿它去"顺便也用一下"就是让第二处开始按符号种类
 * 分支——而契约的中性类别本来就是为了**不让**上层认识语法结构。
 *
 * `KOJO2_MONACO_LANGUAGE_SURFACE` 同样导给外面用：宿主的装配闸（`monaco-language-surface`
 * 那几条测试）要把**这一枚对象**喂进登记表，不能自己按字段抄一遍——抄了就是第二份判据。
 */
export { createKojoLangPlugin } from './plugin';
export { provideCompletion } from './completion';
export { provideDefinition } from './definition';
export { provideHover } from './hover';
export { provideReferences } from './references';
export { provideRename } from './rename';
export { provideDocumentHighlights } from './highlight';
export { provideSelectionRanges } from './selection-range';
export { provideSignatureHelp } from './signature';
export { provideFormatting } from './format';
export { provideDocumentSymbols, symbolFactsToTree } from './symbols';
export { provideInlayHints, toEditorInlayHints } from './inlay';
export { isKojo2Request } from './request';
export { KOJO2_MONACO_LANGUAGE_SURFACE } from './monaco-language';
