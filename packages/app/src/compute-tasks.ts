/**
 * 并行计算任务表（**装配层单一真源**；2026-10-12「内核优化」批）。
 *
 * "传数据不传函数"要求两侧各自持有 kind → 实现的映射：宿主侧由各插件
 * `activate` 时 `registerTask`（本地实现 / 回退路径），worker 侧由本表提供。
 * 两处都**引用同一份插件导出的任务表**，所以不存在"kind 写错"的漂移风险。
 *
 * 新增可并行任务时：插件导出自己的任务表 → 在这里并入。
 */
import type { ComputeTaskTable } from '@kojo/plugin-api';
import { erbParserTasks } from '@kojo/plugin-erb-parser';

export const computeTasks: ComputeTaskTable = {
  ...erbParserTasks,
};
