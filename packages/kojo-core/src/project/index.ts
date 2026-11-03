/**
 * 项目层入口（`@kojo/kojo-core/project`）：冲突/Layer/接管分析 + 存储期槽位分配 +
 * M2-P1 Project IR 事实层。
 *
 * 分层纪律：分析 / 身份 / IR 构造只吃纯数据与注入事实，零 IO、零 Monaco、零游戏名词。
 * Project IR 可以引用既有 AST / TheaterLoweringUnit / SourceMapData；不复制第二套 AST，
 * 也不把带方法的运行时 SourceMap 塞进 IR。
 */
export * from './analysis.js';
export * from './storage.js';
/* `@织` 层冲突 / 被压监听（K2-WEAVE-LAYER）：纯数据事实，码取既有 weave 码表 */
export * from './weave-layers.js';
/* M2-P1：文件 / Theater 身份与 Project IR 构造（不实现 TargetRegistry / Linker） */
export * from './identity.js';
export * from './ir.js';
export * from './target-registry.js';
export * from './linker.js';
export * from './compile-project.js';
export * from './runtime-matcher.js';