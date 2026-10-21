/**
 * 表达式 AST 公共入口（K2-EXPR-AST）：
 * `tokenize` 词法 → `parse` 文法 → `print` 规范文本 → `parity` 与 v1 管线对拍。
 *
 * 本目录是 `KojoExprText`（源切片）的结构化升级：`ast.ts` 的节点类型是唯一定义，
 * 其余文件只消费它。零 IO / 零 Monaco / 不认识任何游戏；对 v1 的复用是**语义级**
 * （优先级表与词法判据逐条复刻），不 import 插件——v1 管线由 `parity` 的 oracle 注入。
 *
 * 接线：`src/index.ts` 尚未 re-export 本 barrel（本批不改已有文件）；宿主 / sema 接入时
 * 加一行 `export * from './expr/index.js';` 即可，导出名（`Expr*` / `parseExpr` /
 * `printExpr` / `exprAstParity`）与现有导出无冲突。
 */
export * from './ast.js';
export * from './tokenize.js';
export * from './parse.js';
export * from './print.js';
export * from './parity.js';
