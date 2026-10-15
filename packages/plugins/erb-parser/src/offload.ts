/**
 * 可搬运任务（并行运输层；2026-10-12「内核优化」批 · 例 1 之"首次加载也要快"）。
 *
 * ## 为什么
 *
 * 索引构建的墙钟时间由**纯 CPU 的解析**主导：真实语料 2,317 文件 / 362 万行，
 * `parseErbText` 串行耗时实测约 **2.6 s**（探针：读盘+解析 4,290 ms，其中读盘为
 * `readFileSync` 串行）。切片让路只能改善"卡不卡"，改不了"要等多久"——
 * **要真提速必须多线程并行**。
 *
 * ## 分工（铁律：IO 不搬）
 *
 * - 主线程：`walkDir` + `stat` + `readText`（Tauri IPC 留主线程——worker 内 invoke
 *   的可用性未经本仓库验证，不值得赌；见 `docs/archive/PERF-REVIEW-2026-10-11.md` §四）；
 * - 并行通道：**只搬纯解析**（`text` → `ErbFile`，纯数据进、纯数据出）。
 *
 * ## 单一真源
 *
 * 任务表由本模块导出，**宿主侧 `registerTask`（本地实现/回退）与 worker 入口
 * （`handleComputeRequest`）共用同一份**——避免两侧映射漂移（kind 写错会静默退化为
 * "unknown compute task kind"）。
 */
import type {
  ComputeTaskTable,
  ControlFlowStatement,
  EditorDecoratePayload,
  LineDecoration,
} from '@kojo/plugin-api';
import { isErbDialectPath } from '@kojo/plugin-api';
import { parseErbText, scanControlFlow } from './scanner';
import { checkControlFlowStructure } from './structure';
import { structureDiagnostic } from './structure-fix';

/** 任务 kind：纯解析一个 ERB 文件 */
export const PARSE_FILE_TASK = 'erb.parseFile';
/** 任务 kind：控制流骨架扫描（条件抽取的 CPU 主段） */
export const SCAN_FLOW_TASK = 'erb.scanControlFlow';
/**
 * 任务 kind（2026-10-16 装饰热路径批）：**结构波浪线整条链**（全文体检 + 诊断成形）。
 *
 * 这是 `ui.editor.decorator`（id `erb-structure`）的可搬运实现——编辑器每 250ms 停顿
 * 就把整份文件重扫一遍，纯 CPU、纯数据，正是该搬进 worker 的那一类。
 */
export const STRUCTURE_DECORATIONS_TASK = 'erb.structureDecorations';

export interface ParseFilePayload {
  text: string;
  path: string;
}

export interface ScanFlowPayload {
  text: string;
}

/**
 * 结构波浪线的**单一真源**（契约 `ui.editor.decorator` 的 `decorate` 与任务实现共用它）。
 *
 * 两处各写一遍必然漂移——漂移的表现是"有并行通道时波浪线一种、通道挂了另一种"，
 * 那种不一致比慢十倍更糟。适用性判据（方言扩展名 / 空文本）也在这一份里。
 */
export function erbStructureDecorations({ path, text }: EditorDecoratePayload): LineDecoration[] {
  if (!isErbDialectPath(path) || text.length === 0) return [];
  // 逐字段的形状只住在 `structureDiagnostic` 一处：💡 那边给出的"我修的是哪条诊断"
  // 用的就是同一个函数 ⇒ 波浪线与快速修复不可能对不上（B9 的关联键全靠它）
  return checkControlFlowStructure(text).map(structureDiagnostic);
}

/** 本插件导出的可搬运任务表（宿主与 worker 侧共用） */
export const erbParserTasks: ComputeTaskTable = {
  [PARSE_FILE_TASK]: ((payload: ParseFilePayload) => parseErbText(payload.text, payload.path)) as never,
  [SCAN_FLOW_TASK]: ((payload: ScanFlowPayload): ControlFlowStatement[] => scanControlFlow(payload.text)) as never,
  [STRUCTURE_DECORATIONS_TASK]: ((payload: EditorDecoratePayload): LineDecoration[] =>
    erbStructureDecorations(payload)) as never,
};
