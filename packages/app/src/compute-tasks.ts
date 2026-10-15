/**
 * 并行计算任务表（**装配层单一真源**；2026-10-12「内核优化」批 · 2026-10-16 装饰热路径批扩充）。
 *
 * "传数据不传函数"要求两侧各自持有 kind → 实现的映射：宿主侧由各插件
 * `activate` 时 `registerTask`（本地实现/回退路径），worker 侧由本表提供。
 * 两处都**引用同一份插件导出的任务表**，所以不存在"kind 写错"的漂移风险。
 *
 * 新增可并行任务时：插件导出自己的任务表 → 在这里并入。
 *
 * ## 2026-10-16：装饰器也进这张表
 *
 * `ui.editor.decorator` 贡献声明的 `offloadKind` 若**在这张表里**，宿主就走
 * `compute.offload`（真 worker，主线程只装配）；**不在表里**的（实现要吃插件内
 * 注入的项目服务，worker 复现不了）宿主只把它请出同步装饰轮、异步就地执行。
 * 于是"这条装饰能不能进 worker"这件事只有一个判据——在不在本表——不静默、可核对
 * （判据函数 `hasWorkerTask`）。
 *
 * `erb.exprSyntaxDecorations` 是**跨插件合成**的任务（骨架扫描住在 erb-parser、
 * 表达式诊断住在 condition-extractor）。插件之间不许 cross-import（审计 C 项），
 * 而装配层是唯一被允许同时看见两者的地方——所以由这里把纯扫描器交给插件的造表器，
 * 两侧（宿主 `registerTask` / worker 入口）拿到的仍是同一份填好的表。
 */
import type { ComputeTaskTable } from '@kojo/plugin-api';
import { conditionExtractorTasks } from '@kojo/plugin-condition-extractor';
import { erbParserTasks, scanControlFlow } from '@kojo/plugin-erb-parser';

export const computeTasks: ComputeTaskTable = {
  ...erbParserTasks,
  ...conditionExtractorTasks(scanControlFlow),
};

/** 该 kind 是否在 worker 侧有实现（宿主据此在 `offload` 与"异步就地"之间二选一） */
export function hasWorkerTask(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(computeTasks, kind);
}
