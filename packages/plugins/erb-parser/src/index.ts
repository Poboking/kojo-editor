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
// 可搬运任务表（并行运输层；宿主与 worker 入口共用同一份，避免映射漂移）
export { PARSE_FILE_TASK, erbParserTasks, type ParseFilePayload } from './offload';
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
