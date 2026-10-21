/**
 * `@kojo/kojo-core` —— Kojo 2.0 语言核心（零游戏名词 / 零 IO / 零 Monaco）。
 *
 * 分层（设计稿 §1.1）：
 *   core（本包）：词法、文法、AST、降糖、诊断、source map；
 *   adapter-sdk：GameAdapter 契约与 fixture（本包 `adapter.ts`，不依赖具体游戏）；
 *   eratw adapter：游戏事实（在 `packages/plugins/eratw-adapter`）；
 *   宿主：Monaco/tree-sitter 接线（在 `packages/app`）。
 *
 * 本文件是唯一公共入口：新增导出必须在这里登记，禁止消费方深路径 import。
 */
export * from './ast.js';
export * from './diagnostics.js';
export * from './positions.js';
