/**
 * @kojo/plugin-api —— 内核与插件之间的唯一公共契约。
 *
 * 规则（对应架构文档 §6）：
 * - 插件之间禁止直接 import，只能通过本包的类型 + 内核服务（DI）交互；
 * - 本包只含类型与纯常量，不含实现、不依赖任何运行时（含 React）；
 * - 版本化：向后兼容新增走 minor，破坏性变更走 major。
 */

export type { Disposable, Logger, Unsubscribe } from './base';

export { KERNEL_EVENT_NAMES, KERNEL_EVENT_CLASSIFICATION_GUARD } from './events';
export type {
  AnyEventMap,
  CustomEventKey,
  EventBus,
  FileChangeKind,
  FileChangedEvent,
  KernelEventMap,
  KernelEventName,
  PluginEventMap,
} from './events';

export type {
  Plugin,
  PluginContext,
  PluginStateRecord,
  PluginStatus,
  ServiceKey,
} from './plugin';

export type {
  DirEntry,
  FileEncoding,
  FileStat,
  PlatformBridge,
  WalkOptions,
  WatchCallback,
} from './platform';

export type { ScopedStorage, StorageService } from './storage';

export { WriteNotAllowedError } from './io';
export type { EolStyle, FileIO, TextFile, WriteTextOptions } from './io';

export { ProjectDetectionError } from './project';
export type { ProjectService, RecentProject } from './project';

export { WORKSPACE_MANIFEST_FILE } from './workspace';
export type {
  WorkspaceArtifact,
  WorkspaceArtifactInput,
  WorkspaceImportInput,
  WorkspaceProject,
  WorkspaceService,
} from './workspace';

export { CONVENTION_SEVERITY_ORDER } from './conventions';
export type {
  ConventionCheckContext,
  ConventionIssue,
  ConventionLinterService,
  ConventionReport,
  ConventionRule,
  ConventionRuleFailure,
  ConventionRuleScope,
  ConventionSeverity,
} from './conventions';

export { dependencyKey } from './conditions';
export type {
  ConditionComparison,
  ConditionExpr,
  ConditionExtractorService,
  ConditionIndex,
  FunctionAssignment,
  FunctionConditions,
  FunctionPredicate,
  FunctionPredicates,
  FunctionReturn,
  PredicateSourceKind,
  StateDependency,
  VariableRef,
} from './conditions';

export type {
  BranchChainKind,
  BranchChainOutcome,
  FunctionReplay,
  PredicateReplay,
  ReplayCallContext,
  ReplayFunctionOptions,
  ReplayOutcome,
  ReplayStateView,
  ReplayUnknown,
  ReplayUnknownCode,
  ReplayValue,
  StateReplayService,
} from './replay';

export type {
  ArchiveArrayCell,
  ArchiveArrayType,
  ArchiveArrayVariable,
  ArchiveCellPatch,
  ArchiveCharacterBlock,
  ArchiveContainerFormat,
  ArchiveDataTableVariable,
  ArchiveFileType,
  ArchiveMapVariable,
  ArchiveMeta,
  ArchiveOverrides,
  ArchiveOverrideValue,
  ArchiveParseOptions,
  ArchiveScalarVariable,
  ArchiveVariable,
  ArchiveXmlVariable,
  SnapshotArchive,
  SnapshotArchiveEntry,
  SnapshotInjectionResult,
  SnapshotScanResult,
  SnapshotSourceService,
  SnapshotWriteService,
} from './snapshot';

export type {
  CharaInfo,
  FamilyIndexRule,
  FamilyMatch,
  FamilyParseKind,
  GameAdapter,
  GameProject,
  KojoCallProtocol,
  KojoCallSlot,
  KojoFaceTable,
  KojoFaceTemplate,
  ScaffoldOptions,
  ScaffoldResult,
  StateModel,
  VariableInfo,
  VariableSchema,
} from './game';

export type {
  ContributionBase,
  EditorCodeAction,
  EditorCodeActionContribution,
  EditorCommandContext,
  EditorCommandContribution,
  EditorDecoratorContribution,
  EditorLiftPreviewContribution,
  EditorLiftPreviewItem,
  EditorSaveChoices,
  EditorSaveHandlerContribution,
  EditorSaveOutcome,
  EditorSaveRequest,
  EditorSaveWarning,
  EditorTextEdit,
  ExportOptions,
  ExportResult,
  ExportTargetContribution,
  GameAdapterContribution,
  LineDecoration,
  OverlayContribution,
  PanelLocation,
  SlotMap,
  SlotName,
  SlotRegistrar,
  SlotRegistry,
  StatusbarContribution,
  ToolbarContribution,
  UIPanelComponent,
  UIPanelContribution,
  UIPanelProps,
} from './slots';

export { WellKnownCommands } from './slots';
export type { WellKnownCommandId } from './slots';

export { KernelServices, WellKnownServices } from './services';
export type { KernelServiceKey, PluginRegistry, WellKnownServiceKey } from './services';
export type {
  ComputePayload,
  ComputePool,
  ComputePoolStats,
  ComputePriority,
  ComputeRunOptions,
  ComputeTaskStat,
  ComputeTransport,
} from './compute';
// 并行运输层（协议 + 两侧实现；零平台依赖，供宿主与 worker 入口共用）
export {
  createWorkerTransport,
  handleComputeRequest,
  type ComputeRequest,
  type ComputeResponse,
  type ComputeTaskTable,
  type ComputeWorkerLike,
} from './compute-worker';

export type {
  ControlFlowStatement,
  ErbDim,
  ErbFile,
  ErbFunction,
  ErbFunctionRef,
  ErbIndex,
  ErbParam,
  ErbParserService,
} from './erb';

export {
  hasArchive,
  hasCandidates,
  hasGenerated,
  isCharacterAlias,
  isConditionalInterpolation,
  isExprNode,
  isHeartLine,
  isNumberAlias,
  isRawNode,
  isReachableBlock,
  isReadonlyAlias,
  isStringAlias,
  isTextLine,
  isTopLevelNode,
  isValueInterpolation,
  isVariableAlias,
  isVerifiedCandidate,
  isWritableAlias,
  FULLWIDTH_SPACE,
  fullwidthSpaceLines,
  resolveSugarTarget,
  SugarApplyError,
  SugarCompileError,
} from './sugar';
export type {
  AliasDecl,
  AliasValue,
  AliasValueKind,
  ChoiceBlock,
  ChoiceItem,
  ColorBlock,
  HeartLine,
  IfBlock,
  IfBranch,
  IfExpr,
  Interpolation,
  RandomBlock,
  RandomInline,
  RawFunctionBlock,
  RawLine,
  SugarCompileEncoding,
  SugarCompileOptions,
  SugarCompileResult,
  SugarCompilerDeps,
  SugarDiagnostic,
  SugarDiagnosticCode,
  SugarDoc,
  SugarExprNode,
  SugarFrontMatter,
  SugarLiftCandidate,
  SugarLiftConfidence,
  SugarLiftApplyPreview,
  SugarLiftApplyRequest,
  SugarLiftApplyResult,
  SugarLiftApplyService,
  SugarLiftDiffHunk,
  SugarLiftKind,
  SugarLiftRequest,
  SugarLiftResult,
  SugarLiftRoundTrip,
  SugarLiftService,
  SugarLiftSkip,
  SugarLiftSkipReason,
  SugarProjectNativeReason,
  SugarProjectRequest,
  SugarProjectResult,
  SugarProjectSegment,
  SugarProjectStats,
  SugarNode,
  SugarPosition,
  SugarPreviewArchive,
  SugarPreviewDegradeReason,
  SugarPreviewFunctionReplay,
  SugarPreviewLine,
  SugarPreviewMessageBlock,
  SugarPreviewRequest,
  SugarPreviewResult,
  SugarPreviewService,
  PreviewReachability,
  SugarSaveBlockReason,
  SugarSavePlan,
  SugarSavePlanRequest,
  SugarSeverity,
  SugarSourceMapEntry,
  SugarSourceSpan,
  CommentLine,
  SugarStatement,
  SugarTopLevelNode,
  SugarTranspileOptions,
  SugarTranspileResult,
  SugarTranspileService,
  TextLine,
  TimingBlock,
  TimingMessageCheck,
  TimingNamedParam,
  WhenBlock,
  WhenBranch,
  WhenCaseValue,
  WhenExpr,
} from './sugar';

export {
  projectFingerprintOf,
  combineDigests,
  foldDigest,
  stableHash,
  type FileStamp,
  type CacheExpect,
} from './fingerprint';
export {
  pathStyle,
  sepOf,
  isAbsolute,
  normalize,
  join,
  dirname,
  basename,
  extname,
  isPathUnder,
  pathKey,
  type PathStyle,
} from './paths';
