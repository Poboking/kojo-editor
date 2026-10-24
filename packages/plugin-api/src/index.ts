/**
 * @kojo/plugin-api —— 内核与插件之间的唯一公共契约。
 *
 * 规则（对应架构文档 §6）：
 * - 插件之间禁止直接 import，只能通过本包的类型 + 内核服务（DI）交互；
 * - 本包只含类型与纯常量，不含实现、不依赖任何运行时（含 React）；
 * - 版本化：向后兼容新增走 minor，破坏性变更走 major。
 */

export type { Disposable, Logger, Unsubscribe } from './base';

export { KERNEL_EVENT_NAMES, KERNEL_EVENT_CLASSIFICATION_GUARD, STICKY_EVENT_NAMES } from './events';
export type {
  AnyEventMap,
  CustomEventKey,
  DiffViewSide,
  EventBus,
  FileChangeKind,
  FileChangedEvent,
  FileWatchStateEvent,
  FileWatchStatus,
  KernelEventMap,
  KernelEventName,
  PluginEventMap,
  StickyEventName,
} from './events';

export type {
  Plugin,
  PluginContext,
  PluginStateRecord,
  PluginStatus,
  ServiceKey,
} from './plugin';

export type {
  BatchFileStat,
  DirEntry,
  FileEncoding,
  FileStat,
  PlatformBridge,
  RawFileRead,
  RemoteDownload,
  RemoteDownloadOptions,
  RemoteExtractEntry,
  RemoteExtractLimits,
  RemoteExtractResult,
  RemotePublishOptions,
  RemoteService,
  RemoteText,
  RemoteTextOptions,
  WalkOptions,
  WatchCallback,
  WatchFailure,
  WatchReport,
  WatchReportCallback,
} from './platform';

export type { ScopedStorage, StorageService } from './storage';

export { WriteNotAllowedError } from './io';
export type { BackupVersion, EolStyle, FileIO, TextFile, TrashEntry, WriteTextOptions } from './io';
export type { FilePickFilter } from './platform';

/* ---- 批操作 journal（1016 undo 批独占追加区块；勿在他处重排） ---- */
export type { OpEntryView, OpJournal, OpsMaintenance, OpRecord } from './journal';

export {
  MARKET_SCHEMA_VERSION,
  MARKET_PACK_KINDS,
  MARKET_MANIFEST_FILE,
  MARKET_CONTENT_DIR,
  MARKET_DIR_NAME,
  MARKET_INDEX_FILE,
  MARKET_PACKS_DIR,
  MARKET_STAGING_DIR,
  MARKET_ZIP_SUFFIX,
  MARKET_UNPACKED_SUFFIX,
  MARKET_DEFAULT_INDEX_URL,
  /* ---- 发布通道（1016 发布通道批独占追加区块；勿在他处重排） ---- */
  MARKET_DEFAULT_PUBLISH_URL,
  MARKET_MAX_CONTAINER_UPLOAD_BYTES,
  marketPublishTimeoutMs,
  MARKET_MAX_FILE_ENTRIES,
  MARKET_MAX_PATH_DEPTH,
  MARKET_MAX_UNPACKED_BYTES,
  MARKET_MAX_INDEX_BYTES,
  MARKET_INDEX_TIMEOUT_MS,
  MARKET_INDEX_TTL_MS,
  MARKET_DOWNLOAD_TIMEOUT_BASE_MS,
  MARKET_DOWNLOAD_TIMEOUT_MS_PER_MIB,
  PACK_ID_RE,
  PACK_VERSION_RE,
  VERSION_SEG_RE,
  SHA256_HEX_RE,
  MARKET_SERVICE_KEY,
  MarketError,
  marketDownloadTimeoutMs,
  packEntryPathProblem,
  packFilesProblem,
  packIdKindConflicts,
  compareVersions,
  coreVersion,
  minAppVersionSatisfied,
  endpointProblem,
  packContainerName,
  packUnpackedName,
  packStagingName,
  packStagingNames,
  packStaleName,
  MARKET_STALE_SUFFIX,
  packUpdateCheck,
  /* ---- 封面字段（批次十一 R3 · additive；勿与他批混排） ---- */
  MARKET_MAX_COVER_URL_CHARS,
  MARKET_MAX_COVER_BYTES,
  marketCoverProblem,
} from './market';
export type {
  InstalledPack,
  MarketCover,
  MarketDownloadProgress,
  MarketIndex,
  MarketIndexEntry,
  MarketIndexRefresh,
  MarketIndexState,
  MarketPublishManifestSummary,
  MarketPublishOutcome,
  MarketPublishProgress,
  MarketPublishRejection,
  MarketPublishVerified,
  MarketRejectCode,
  MarketService,
  PackFileEntry,
  PackKind,
  PackManifest,
  PackRef,
  PackUpdateCheck,
  PackUpdateState,
} from './market';

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
  ConventionProjectPartition,
  ConventionProjectUnitEntry,
  ConventionReport,
  ConventionRunIncomplete,
  ConventionRunOptions,
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
  ScaffoldResult,
  StateLinePreset,
  VariableDictionaryStatus,
  VariableInfo,
  VariableSchema,
  VariableSource,
} from './game';
// 「谁是当前激活的 adapter」这条判据的唯一实现（原先 14 个消费方各手写一遍）。
export { activeGameAdapter } from './game';

export type {
  ContributionBase,
  EditorCodeAction,
  EditorCodeActionContribution,
  EditorCodeLens,
  EditorCodeLensRequest,
  EditorCodeLensResult,
  EditorCommandContext,
  EditorCommandContribution,
  EditorDecoratePayload,
  EditorDecoratorContribution,
  EditorDefinitionRequest,
  EditorDefinitionResult,
  EditorDocumentSymbol,
  EditorDocumentSymbolKind,
  EditorDocumentSymbolRequest,
  EditorDocumentSymbolResult,
  EditorFoldingRange,
  EditorFoldingRangeRequest,
  EditorFoldingRangeResult,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorLanguageServiceResult,
  EditorLiftPreviewContribution,
  EditorLiftPreviewItem,
  EditorReferencesRequest,
  EditorReferencesResult,
  EditorRenameEdit,
  EditorRenameRequest,
  EditorRenameResult,
  EditorSaveChoices,
  EditorSaveHandlerContribution,
  EditorSaveOutcome,
  EditorSaveRequest,
  EditorSaveWarning,
  EditorSymbolLocation,
  EditorTextEdit,
  EditorWorkspaceSymbol,
  EditorWorkspaceSymbolRequest,
  EditorWorkspaceSymbolResult,
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
  IconSizeTier,
} from './slots';

export { WellKnownCommands } from './slots';
export type { WellKnownCommandId } from './slots';

/* ---- 插件面板右键菜单契约（1023 右键覆盖面 WP5.1 独占追加区块；勿在他处重排） ---- */
export { copyTextToClipboard, hasCjkLabel, requestPluginMenu } from './context-menu';
export type {
  PluginContextMenuAnchor,
  PluginContextMenuCapability,
  PluginContextMenuItem,
  PluginContextMenuRequest,
} from './context-menu';

/* ---- 插件面板的「界面面登记」（1023 右键覆盖面 WP5.4；插件不可 import 宿主注册表） ---- */
export {
  declarePluginContextSurface,
  getPluginContextSurface,
  listPluginContextSurfaces,
  resetPluginContextSurfaces,
} from './context-surface';
export type {
  PluginContextSurfaceArea,
  PluginContextSurfaceBuildContext,
  PluginContextSurfaceBuildResult,
  PluginContextSurfaceMenu,
  PluginContextSurfaceSpec,
  PluginContextSurfaceTarget,
} from './context-surface';

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
  ERB_BODY_PRIMARY_EXTENSION,
  ERB_DECLARATION_EXTENSIONS,
  ERB_DIALECT_EXTENSIONS,
  ERB_ENGINE_RESERVED_EXTENSIONS,
  erbMonacoExtensions,
  isErbBodyPath,
  isErbDeclarationPath,
  isErbDialectPath,
} from './erb-ext';
export type { ErbDialectExtension } from './erb-ext';

// 口上 XML 契约（2026-10-24 eraFL 适配批）：声明式口上文件的结构模型 + `kojo.xml` 服务。
// 属性枚举 / com 编号 / kojoPlace 取值域**不在本契约**——那些是游戏知识，归 adapter。
// `preview()` 那三枚（条件 / 上下文 / 结果）是预览的**渲染面**：宿主拿到结构化结果直接画，
// 记号语义与条件属性名同样归 adapter 解释。
export type {
  KojoPreviewContext,
  KojoPreviewResult,
  KojoXmlAttributeSpec,
  KojoXmlCommand,
  KojoXmlComSpec,
  KojoXmlCondition,
  KojoXmlDiagnostic,
  KojoXmlEncoding,
  KojoXmlFile,
  KojoXmlFormat,
  KojoXmlIndex,
  KojoXmlPosition,
  KojoXmlSchema,
  KojoXmlService,
  KojoXmlSeverity,
  KojoXmlSpan,
} from './kojo-xml';

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
// 反向引用索引契约（2026-10-15 additive，H2 批独占追加）
export type { ErbReference, ErbReferenceIndex, ErbReferenceKind } from './erb';
// $ 标签定义（2026-10-16 additive，语言服务批独占追加）
export type { ErbLabel } from './erb';
// 索引状态事实（2026-10-19 additive，IDX-STATE 批独占追加）
export type {
  ErbIndexCoverage,
  ErbIndexFileFailure,
  ErbIndexPhase,
  ErbIndexState,
  ErbScanSourceFact,
  ErbScanSourceKind,
} from './erb';

export {
  hasArchive,
  hasCandidates,
  hasGenerated,
  isCharacterAlias,
  isConditionalAlias,
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
  kojoMonacoExtensions,
  KOJO_SOURCE_EXTENSION,
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
  AskItem,
  AskMBlock,
  AskYNBlock,
  CallStatement,
  ChoiceBlock,
  ChoiceItem,
  ColorBlock,
  ConstDecl,
  CustomCommandBlock,
  FunctionBlock,
  GroupBlock,
  HeartLine,
  IfBlock,
  IfBranch,
  IfExpr,
  Interpolation,
  MenuBlock,
  OnceBlock,
  RandomBlock,
  RandomInline,
  RawFunctionBlock,
  RawLine,
  ReturnStatement,
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
  SingleIfStatement,
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
  SwitchBlock,
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
  shortPath,
  type PathStyle,
} from './paths';
export {
  buildZip,
  crc32,
  deflateRaw,
  dosDateTime,
  normalizeEntryName,
  // 往返契约（W14）：写侧守的这套闸与宿主 `market.rs` 的解包侧同源，共享表见
  // `packages/plugin-api/fixtures/zip-roundtrip/contract.json`
  readZipContainer,
  inflateZipEntry,
  verifyZipRoundtrip,
  zipContainerNameProblem,
  zipEntryContractProblem,
  zipContainerContractProblem,
  ZIP_FLAG_UTF8,
  ZIP_MAX_NAME_BYTES,
  ZIP_CONTAINER_NAME_MAX,
  ZIP_EXTRACT_LIMITS,
  ZipContainerStructureError,
  type ZipContractCode,
  type ZipContractLimits,
  type ZipContainer,
  type ZipContainerEntry,
  type ZipExpectation,
  type ZipEntry,
  type ZipOptions,
} from './zip';

/* ---- S6 列级源映射（1015 独占追加区块；勿在他处重排） ---- */
export type { SugarColumnRun } from './sugar';

/* ---- 数值增减族表（1016 独占追加区块；勿在他处重排） ---- */
// 2026-10-19（AM-1 P5）：`KojoMutatorSpec` 由单接口改为 **call / assign 二形态判别联合**
// （有封装函数的游戏降 `CALL`，把增减直写在变量上的游戏降赋值）。新增两个成员接口与
// `MutatorSlotMode` 别名；`MutatorArgRole` 仅 call 形态消费。
export type {
  KojoMutatorAssignSpec,
  KojoMutatorCallSpec,
  KojoMutatorSpec,
  KojoMutatorTable,
  MutatorArgRole,
  MutatorSlotMode,
} from './game';

/* ---- 计数器值域表（1016 独占追加区块；勿在他处重排） ---- */
export type { KojoCounterTable } from './game';

/* ---- C3 领域限定检索（1016 独占追加区块；勿在他处重排） ---- */
export type { SearchScopeContribution, SearchScopeOption } from './slots';

/* ---- 语义着色判别成员（1016 独占追加区块；勿在他处重排） ---- */
export { EDITOR_SEMANTIC_TOKEN_TYPES, EDITOR_SEMANTIC_TOKEN_MODIFIERS } from './slots';
export type {
  EditorSemanticTokenModifier,
  EditorSemanticTokenRequest,
  EditorSemanticTokenResult,
  EditorSemanticTokenSpan,
  EditorSemanticTokenType,
} from './slots';
export type {
  EditorInlayHint,
  EditorInlayHintKind,
  EditorInlayHintRequest,
  EditorInlayHintResult,
} from './slots';
export { MODEL_TOKEN_CLASS, locateIdentifier, modelLineAt, splitModelLines, unicodeTokenAt } from './semantic-locate';

/* ---- 编辑器面第二批（LS-B0 独占追加区块；勿在他处重排）：4 个新 kind 的请求/响应 ---- */
export type {
  EditorCompletionItem,
  EditorCompletionItemKind,
  EditorCompletionRequest,
  EditorCompletionResult,
  EditorFormattingRequest,
  EditorFormattingResult,
  EditorHoverRequest,
  EditorHoverResult,
  EditorRangeEdit,
  EditorSignature,
  EditorSignatureHelpRequest,
  EditorSignatureHelpResult,
} from './slots';

/* ---- W7 NAV-SCOPE 独占追加区块（勿在他处重排）：行→归属 / 范围归属 / 候选排序与预算 ---- */
export {
  candidateRank,
  enclosingAt,
  enclosingChainAt,
  filterByScope,
  pathInScope,
  pickEnclosing,
} from './semantic-locate';
export type { EnclosingMode, LineSpan } from './semantic-locate';
export { CANDIDATE_BUDGETS, NAV_SCOPE_EVENT, SCOPED_QUERY_FACTOR, candidateBudget } from './erb';
export type { CandidateBudgetTier, ErbScopeStamp } from './erb';

/* ---- 诊断码中文显示名（ZH-D2 独占追加区块；勿在他处重排） ---- */
export {
  DIAGNOSTIC_LABELS,
  DIAGNOSTIC_CODE_EXCLUSIONS,
  SUGAR_DIAGNOSTIC_CODES,
  NATIVE_STRUCTURE_CODES,
  NATIVE_EXPR_CODES,
  KOJO_STRUCTURE_SYNTAX_CODES,
  diagnosticDisplay,
  type DiagnosticCodeKey,
  type DiagnosticDisplay,
  type DiagnosticLabel,
} from './diagnostic-copy';

/* ---- 归档读取单源（W13 ARCHIVE-READ 独占追加区块；勿在他处重排） ---- */
export {
  ArchiveServices,
  ArchiveExtractError,
  ARCHIVE_EXTRACT_DIR,
  formatBytes,
  archiveEntryFileName,
  archiveEntryLabel,
  assertArchiveEntryName,
  archiveExtractFileName,
  archiveWorkspaceLanding,
  isArchiveLandingAllowed,
} from './archive';
export type {
  ArchiveExtractOutcome,
  ArchiveExtractRefusal,
  ArchiveExtractRequest,
  ArchiveReaderIo,
  ArchiveReaderService,
} from './archive';

/* ---- W12 ENC-SRC 解码判据单源（独占追加区块；勿在他处重排） ---- */
export { DECODE_LABEL, DECODE_PROBE_POLICY } from './platform';
export type { DecodeBomRule, DecodeProbePolicy } from './platform';

/* ---- 糖面板共享核（W4 PANEL-DEDUP 独占追加区块；勿在他处重排） ---- */
export {
  isKojoFile,
  createLiveTextPool,
  createPanelTruthController,
  degradeText,
  degradeForActiveFile,
  buildPanelDiagnosticRows,
  DIAG_WINDOW,
  ROW_WINDOW,
  DIAG_WINDOW_INITIAL,
  DIAG_WINDOW_STEP,
  ROW_WINDOW_INITIAL,
  ROW_WINDOW_STEP,
  windowSize,
  nextWindow,
  growWindow,
  diagWindowSize,
  nextDiagWindow,
  rowWindowSize,
  nextRowWindow,
  attachGrowSentinel,
  MORE_ROW_STYLE,
  MORE_ROW_TITLE,
  moreRowLabel,
} from './sugar-panels';
export type {
  LiveTextPool,
  PanelDegrade,
  PanelDiagnosticRow,
  PanelTruthController,
  PanelTruthHandlers,
  RenderWindow,
} from './sugar-panels';

/* ---- 编译闸收口：糖编辑类型走 barrel（additive，勿在他处重排） ---- */
export type { SugarEdit } from './sugar';

/* ---- 内容判等核（W17 DIFF-EQ 独占追加区块；勿在他处重排） ---- */
export { compareContent, linesEqualOf, splitContentLines } from './content-equality';
export type { ContentEquality, ContentSide } from './content-equality';

/* ---- 索引槽口径（IX-1 独占追加区块；勿在他处重排） ---- */
export { kojoIndexCandidates, kojoIndexNameOf, resolveKojoIndexName } from './index-slot';
export type { KojoIndexCandidate, KojoIndexResolution, KojoIndexTables } from './index-slot';
export type { KojoIndexKind } from './game';

/* ---- 错误摘要（FE-REF ⑨ 独占追加区块；勿在他处重排） ---- */
export { errorText } from './errors';

/* ---- 「发布口上」草案契约（用户反馈 4 批；独占追加区块，勿在他处重排） ---- */
export type {
  MarketPackDraft,
  MarketPackDraftFile,
  MarketPublishPackOpts,
  MarketZipFile,
  MarketZipInspection,
} from './market';

/* ---- 口上项目脚手架共享骨架（AM-1 P4 独占追加区块；勿在他处重排） ---- */
export {
  assembleScaffold,
  assertScaffoldIdentity,
  buildScaffoldDirName,
  buildScaffoldFaceStub,
  buildScaffoldReadme,
  faceTemplateExample,
  sanitizePathSegment,
} from './scaffold';
export type {
  ScaffoldFaceCase,
  ScaffoldFaceSpec,
  ScaffoldFileSet,
  ScaffoldIdentity,
  ScaffoldMetaRow,
  ScaffoldParts,
  ScaffoldReadmeSpec,
  ScaffoldStubSpec,
  ScaffoldTemplateHint,
} from './scaffold';
