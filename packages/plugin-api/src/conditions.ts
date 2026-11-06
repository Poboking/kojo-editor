/**
 * 条件谓词抽取契约（v0.2 第三批）——**运行时面**。
 *
 * 设计分层（"一切皆插件"）：
 * - **契约**（本文件，游戏无关）：表达式 AST、函数级状态依赖、索引、服务接口；
 * - **引擎**（`condition-extractor` 插件）：控制流骨架 → 表达式解析 → 变量聚合；
 * - **语义标注**：变量的人类可读含义（如"哪个编号是好感度"）由 game adapter 的
 *   `variableSchema` 提供，引擎经槽位查询后**透传**——通用层不解释任何游戏常量。
 *
 * 稳健性原则：表达式解析**包容降级**——无法解析的片段成为 `opaque` 节点，
 * 绝不抛错中断（全量 99k 函数必须跑完）；未解析计数在结果中显式呈现（不静默）。
 *
 * 类型面（AST / 索引 / 服务接口形状）已整块拆到 `./conditions-types`
 * （2026-11-07 MCP-PERF-S17）：类型经 `import type` / `export type` 擦除、不进开机图，
 * 本文件只留运行时真源。旧导入路径不变——下方 `export type *` 原样转出全部类型。
 */

import type { VariableRef } from './conditions-types';

/** 类型面已拆到 ./conditions-types（图外文件）：这里 re-export 只为保持旧的 ./conditions 导入路径可用。
 *  `export type *` 会被擦除，不产生运行时面，也不把类型文件拽回图。 */
export type * from './conditions-types';

/** 规范化变量引用为依赖键（如 CFLAG:2 / TALENT:恋慕 / LOCAL） */
export function dependencyKey(ref: Pick<VariableRef, 'name' | 'indices'>): string {
  return ref.indices.length === 0 ? ref.name : `${ref.name}:${ref.indices.join(':')}`;
}
