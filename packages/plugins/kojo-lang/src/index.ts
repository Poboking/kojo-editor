/**
 * `@kojo/plugin-kojo-lang` 的入口。
 *
 * 只导出**一个**工厂 + 两个供方（供测试直调）。不导出 `SYMBOL_KIND` 之类内部表：
 * 类别映射是这一层对契约的承诺，别人拿它去"顺便也用一下"就是让第二处开始按符号种类
 * 分支——而契约的中性类别本来就是为了**不让**上层认识语法结构。
 */
export { createKojoLangPlugin } from './plugin';
export { provideDefinition } from './definition';
export { provideDocumentSymbols, symbolFactsToTree } from './symbols';
export { isKojo2Request } from './request';
