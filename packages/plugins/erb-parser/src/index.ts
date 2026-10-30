/**
 * @kojo/plugin-erb-parser
 *
 * ERB 结构感知解析器（服务 `erb.parser`）。
 * 零游戏知识——命名约定与家族识别属于 game.adapter。
 */
export { createErbParserPlugin, provideErbCallHierarchy, provideErbDefinition } from './plugin';
export {
  ERB_CONTROL_STATEMENTS,
  classifyControlFlow,
  parseErbText,
  parseFunctionDefinition,
  parseParams,
  parseDimDeclaration,
  splitTopLevel,
  scanControlFlow,
} from './scanner';
// 结构体检（2026-10-13 反馈 7；纯函数，配对表仍单源于 scanner.ts）
export { MAX_STRUCTURE_ISSUES, checkControlFlowStructure, checkPreprocStructure, checkStructure, preprocRoleOf } from './structure';
// `.ERH` 头文件形态体检（A4 / P1-4 第七条：只允许 #DIM / #DIMS / #DEFINE；判据对 ErhLoader）
export { ERH_ALLOWED_DIRECTIVES, checkHeaderIssues } from './erh';
// 预处理条件块的「被裁支」区间（A5 / P0-3 尾巴：分支变灰；判据逐条对 Emuera PPState）
export {
  collectPreprocDeadRanges,
  preprocMarkerAt,
  type PreprocDeadRange,
  type PreprocMarkerRead,
} from './structure';
// 内建式中函数静态签名表（exmeth）与实参诊断（A1；静态数据，不进索引契约）
export {
  BUILTIN_ARGS_CODE,
  BUILTIN_ARG_TYPE_CODE,
  BUILTIN_FUNCTION_NAMES,
  BUILTIN_SIGNATURES,
  builtinSignatureLabel,
  builtinSignatureOf,
  collectBuiltinArgDiagnostics,
  type BuiltinArgDiagnosticsInput,
  type BuiltinParam,
  type BuiltinParamType,
  type BuiltinSignature,
} from './builtins';
// 实参个数（用户函数；纯函数，目录查询）
export { ARITY_MISMATCH_CODE, arityParamsOf, collectArityDiagnostics, erbCallSitesOf, type ArityCatalog, type ArityInput, type ArgSpan, type ErbCallSite } from './arity';
// 引擎指令名全集（A3；出处 = Emuera `enum FunctionCode`，静态数据，不进索引契约）
export { ERB_INSTRUCTION_NAMES, isInstructionName } from './instructions';
export { checkDeclarationIssues, parseDimLine, dimLineViolations, type DimLine } from './declarations';
export {
  ERB_CODE_PREFIXES,
  ERB_CODE_PREFIX_LENGTH,
  erbCodeBodyOf,
  erbCodePrefixLength,
  isErbCommentLine,
} from './scanner';
export {
  applyStructureFix,
  buildStructureFixes,
  structureDiagnostic,
  type ErbStructureFix,
} from './structure-fix';
// 位置 → 符号（B0，2026-10-15 语言服务批；纯函数，索引为唯一真源）
export {
  definitionTargetsAt,
  functionAt,
  labelEntryAt,
  labelScopeAt,
  type ErbLabelEntry,
  type ErbLabelOccurrence,
  type ErbLabelScope,
} from './symbols';
// 可搬运任务表（并行运输层；宿主与 worker 入口共用同一份，避免映射漂移）
export {
  PARSE_FILE_TASK,
  SCAN_FLOW_TASK,
  SCAN_REFS_TASK,
  STRUCTURE_DECORATIONS_TASK,
  erbParserTasks,
  erbStructureDecorations,
  scanRefsBatch,
  type ParseFilePayload,
  type ParseFileWire,
  type ScanFlowPayload,
  type ScanRefsPayload,
} from './offload';
// 索引快照（纯函数；增量复扫的判据与合并逻辑）
export {
  SNAPSHOT_VERSION,
  aggregateIndex,
  coerceSnapshot,
  countEntries,
  diffSnapshot,
  mergeEntries,
  nameSetDigest,
  projectRootKey,
  refsAreReusable,
  sameProjectRoot,
  salvageEntries,
  salvageSnapshot,
  snapshotKeyCandidatesFor,
  snapshotKeyFor,
  verifiedNamesDigest,
  type IndexSnapshot,
  type SalvagedSnapshot,
  type SnapshotEntry,
} from './snapshot';

// 结构化着色（B6，2026-10-16；纯函数，缓冲区文本 + 可空索引进、着色 span 出）
export { erbSemanticTokens } from './semantic-tokens';
// 索引扫描根的合成与签名（IDX-ROOT，2026-10-19；纯函数，零 IO）
export { planScanRoots, rootsSignature, type ScanRootPlan } from './index-roots';

// 本地名字（`#DIM` / `$` 标签）的落点判据（LAU-4 第二步定稿批）：供方在本插件，宿主悬停 /
// 补全 / 查引用读同一批函数（不留在语言面库是因为整包会进首屏，见 `symbols.ts` 段头）。
export {
  dimDeclarationOf,
  dimDeclarationsOf,
  isErbDefinitionPath,
  isErbDimNameChar,
  labelDefinitionLocations,
  labelReferenceLocations,
  mergeNavigationLegs,
  mergeSymbolLocations,
  normalizePathKey,
  resolveErbDimDefinition,
  type ErbDimDeclaration,
} from './symbols';

// 调用层级判据（LAU-4 调用层级腿，2026-10-31；纯函数 + 槽供方形状，宿主只翻面板形状）。
// 与改名判据同住 `symbols.ts`：整包进首屏，另开文件只多一份模块壳（ps10 记账）。
export {
  callHierarchySymbolOf,
  incomingCalls,
  outgoingCalls,
  resolveEnclosingFunction,
  type ErbFunctionAtResolver,
} from './symbols';
// 改名判据（LAU-4 改名腿，2026-10-30；纯函数 + 槽供方形状，宿主只翻 Monaco 形状）。
// 与本地名字落点判据同住 `symbols.ts`：整包进首屏，另开文件只多一份模块壳（ps10 记账）。
export {
  kojoLabelMentions,
  labelRenameRejection,
  planErbRename,
  provideRename,
  provideRenameTarget,
  resolveErbRenameAt,
  resolveRenameName,
  wordAtColumn,
  type ErbRenameResolution,
  type RenameNameTarget,
} from './symbols';

