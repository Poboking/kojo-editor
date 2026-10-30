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
export { provideCodeLenses } from './codelens';
// B3h（2026-10-30）：折叠区间的供方（结构快照 → 契约区间；判据在 `@kojo/kojo-lang/folding`）。
export { provideFoldingRanges } from './folding';
// B3 语义收口（2026-10-30）：结构化着色的供方（捕获快照 → 契约区间；判据在
// `@kojo/kojo-lang/semantic`）。
export { provideSemanticTokens } from './semantic';
export { provideSignatureHelp } from './signature';
export { provideFormatting } from './format';
// B3j（2026-10-30）：槽 `ui.editor.codeAction` 的供方（一键迁移）。
export { provideCodeActions, coreDiagnosticsOf, type Kojo2CodeActionFile } from './code-actions';
export { provideDocumentSymbols, symbolFactsToTree } from './symbols';
export { provideInlayHints, toEditorInlayHints } from './inlay';
export { isKojo2Request } from './request';
export { KOJO2_MONACO_LANGUAGE_SURFACE } from './monaco-language';
// B3 收口最后一格（2026-10-30）：文档级诊断的供方（槽 `ui.editor.decorator`；判据在
// `@kojo/kojo-lang/diagnostics`）。导出给测试直调，也导出贡献工厂让宿主按 id 认这一家。
export {
  createKojo2DiagnosticsContribution,
  isKojo2DiagnosticsPath,
  provideKojo2Diagnostics,
  toLineDecoration,
  type Kojo2DiagnosticsFile,
} from './diagnostics';
