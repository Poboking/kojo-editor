/**
 * 项目层入口（`@kojo/kojo-core/project`）：冲突/Layer/接管分析 + 存储期槽位分配。
 *
 * 分层纪律：本目录只依赖 `../ast.js` / `../diagnostics.js` / `../positions.js`（共享契约）
 * 与同目录的 `ordering.ts`；**不** import parser / lowering / adapter / 任何插件。
 * 纯函数 + 端口注入，零 IO、零 Monaco、零游戏名词。
 */
export * from './analysis.js';
export * from './storage.js';
