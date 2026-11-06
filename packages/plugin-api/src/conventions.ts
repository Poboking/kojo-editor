/**
 * 约定校验器契约（v0.2）——**运行时面**。
 *
 * 设计分层（"一切皆插件"）：
 * - **契约**（本文件，游戏无关）：规则形状、运行上下文、问题、报告、服务接口；
 * - **引擎**（`convention-linter` 插件）：收集规则 → 依次运行 → 汇总报告 → 订阅广播；
 * - **规则实现**：游戏知识类规则住在 game adapter（`adapter.conventions`），
 *   引擎通用类规则住在引擎插件自身（如"函数重名"）。
 *
 * 关键设计：
 * - 规则是**纯函数**（输入上下文 → 输出问题数组），便于单测与复用；
 * - 上下文只暴露通用能力（项目 / 索引 / 读文件 / 日志）——**零游戏知识**；
 * - 单条规则抛错不中断全局，但**绝不静默**（进入 report.failedRules）；
 * - 一轮可以被叫停（`run({signal})`），但"这一轮算完了没有"只在**引擎一处**判定
 *   （报告带 `incomplete` 与否），驱动方与 UI 只搬运那个事实，不各写一套取消口径。
 *
 * 类型面（规则 / 问题 / 报告 / 服务接口形状）已整块拆到 `./conventions-types`
 * （2026-11-07 MCP-PERF-S17）：类型经 `import type` / `export type` 擦除、不进开机图。
 */

import type { ConventionSeverity } from './conventions-types';

/** 类型面已拆到 ./conventions-types（图外文件）：这里 re-export 只为保持旧的 ./conventions 导入路径可用。
 *  `export type *` 会被擦除，不产生运行时面，也不把类型文件拽回图。 */
export type * from './conventions-types';


/** 严重度排序权重（error 最前） */
export const CONVENTION_SEVERITY_ORDER: Readonly<Record<ConventionSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};
