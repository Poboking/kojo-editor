/**
 * `@kojo/kojo-core` —— Kojo 2.0 语言核心（零游戏名词 / 零 IO / 零 Monaco）。
 *
 * 分层（设计稿 §1.1）：
 *   core（本包）：词法、文法、AST、降糖、诊断、source map、项目级分析；
 *   adapter-sdk：GameAdapter 契约与 fixture（`adapter.ts` / `fixture-adapter.ts`）；
 *   eratw adapter：游戏事实（`packages/plugins/eratw-adapter/src/kojo2`）；
 *   宿主：Monaco / tree-sitter 接线（`packages/app`）。
 *
 * 本文件是唯一公共入口：新增导出必须在这里登记，禁止消费方深路径 import。
 * 顺序按数据流：契约 → 词法/文法 → 降糖 → 适配 → 项目层。
 */
/* 共享契约 */
export * from './ast.js';
export * from './diagnostics.js';
export * from './positions.js';
/* 前端：词法 + 文法 */
export * from './tokens.js';
export * from './lexer.js';
export * from './parser.js';
/* 降糖：字面量 / 表 / source map / lowering */
export * from './literal.js';
export * from './table.js';
export * from './source-map.js';
export * from './lower/index.js';
export * from './compile.js';
/* 适配层契约与 fixture */
export * from './adapter.js';
export * from './fixture-adapter.js';
/* 项目级：冲突/Layer/接管 + 存储期分配 */
export * from './project/index.js';
/* 迁移：v1 源码 → 2.0 源码（M7） */
export * from './migrate/index.js';
