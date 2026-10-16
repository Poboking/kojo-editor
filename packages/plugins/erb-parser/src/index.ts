/**
 * @kojo/plugin-erb-parser
 *
 * ERB 结构感知解析器（服务 `erb.parser`）。
 * 零游戏知识——命名约定与家族识别属于 game.adapter。
 */
export { createErbParserPlugin } from './plugin';
export {
  parseErbText,
  parseFunctionDefinition,
  parseParams,
  parseDimDeclaration,
  splitTopLevel,
  scanControlFlow,
} from './scanner';
// 结构体检（2026-10-13 反馈 7；纯函数，配对表仍单源于 scanner.ts）
export { MAX_STRUCTURE_ISSUES, checkControlFlowStructure } from './structure';
export {
  applyStructureFix,
  buildStructureFixes,
  structureDiagnostic,
  type ErbStructureFix,
} from './structure-fix';
// 位置 → 符号（B0，2026-10-15 语言服务批；纯函数，索引为唯一真源）
export { definitionTargetsAt, functionAt } from './symbols';
// 可搬运任务表（并行运输层；宿主与 worker 入口共用同一份，避免映射漂移）
export {
  PARSE_FILE_TASK,
  SCAN_FLOW_TASK,
  STRUCTURE_DECORATIONS_TASK,
  erbParserTasks,
  erbStructureDecorations,
  type ParseFilePayload,
  type ScanFlowPayload,
} from './offload';
// 索引快照（纯函数；增量复扫的判据与合并逻辑）
export {
  SNAPSHOT_VERSION,
  aggregateIndex,
  coerceSnapshot,
  diffSnapshot,
  mergeEntries,
  snapshotKeyFor,
  type IndexSnapshot,
  type SnapshotEntry,
} from './snapshot';

// 结构化着色（B6，2026-10-16；纯函数，缓冲区文本 + 可空索引进、着色 span 出）
export { erbSemanticTokens } from './semantic-tokens';
