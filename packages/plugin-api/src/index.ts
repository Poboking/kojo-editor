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
  FileWatchStateEvent,
  FileWatchStatus,
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
  WatchFailure,
  WatchReport,
  WatchReportCallback,
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

export {
  readReplayDeterminability,
  replayUnknownReducibility,
} from './replay';
export type {
  BranchChainKind,
  BranchChainOutcome,
  FunctionReplay,
  PredicateReplay,
  ReplayCallContext,
  ReplayCallContextResolver,
  ReplayDeterminabilityReading,
  ReplayFunctionOptions,
  ReplayOutcome,
  ReplayStateView,
  ReplayUnknown,
  ReplayUnknownCode,
  ReplayUnknownReducibility,
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
  KojoInstructionTable,
  KojoLibraryTable,
  ScaffoldOptions,
  ScaffoldResult,
  StateModel,
  VariableInfo,
  VariableSchema,
  VariableSource,
} from './game';

export type {
  ContributionBase,
  EditorCodeAction,
  EditorCodeActionContribution,
  EditorCommandContext,
  EditorCommandContribution,
  EditorDecoratorContribution,
  EditorDefinitionRequest,
  EditorDefinitionResult,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorLanguageServiceResult,
  EditorLiftPreviewContribution,
  EditorLiftPreviewItem,
  EditorSaveChoices,
  EditorSaveHandlerContribution,
  EditorSaveOutcome,
  EditorSaveRequest,
  EditorSaveWarning,
  EditorSymbolLocation,
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

// 光标处标识符整串（跨插件共享的极小纯函数；解耦审计禁插件交叉 import，故住契约层）
export { symbolTokenAt } from './symbol-token';
export type { SymbolToken } from './symbol-token';

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

export {
  ERB_BODY_EXTENSIONS,
  ERB_DECLARATION_EXTENSIONS,
  ERB_DIALECT_EXTENSIONS,
  ERB_ENGINE_RESERVED_EXTENSIONS,
  erbMonacoExtensions,
  isErbBodyPath,
  isErbDeclarationPath,
  isErbDialectPath,
} from './erb-ext';
export type { ErbDialectExtension } from './erb-ext';

export type {
  ControlFlowStatement,
  ErbDim,
  ErbFile,
  ErbFunction,
  ErbFunctionRef,
  ErbIndex,
  ErbParam,
  ErbParserService,
  ErbStructureIssue,
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
  CustomCommandBlock,
  GroupBlock,
  HeartLine,
  IfBlock,
  IfBranch,
  IfExpr,
  Interpolation,
  RandomBlock,
  RandomInline,
  RawFunctionBlock,
  RawLine,
  SectionBlock,
  SugarCompileEncoding,
  SugarCompileOptions,
  SugarCompileResult,
  SugarCompiledBytes,
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
export {
  buildZip,
  crc32,
  deflateRaw,
  dosDateTime,
  normalizeEntryName,
  type ZipEntry,
  type ZipOptions,
} from './zip';
