/**
 * @kojo/plugin-api —— 内核与插件之间的唯一公共契约。
 *
 * 规则（对应架构文档 §6）：
 * - 插件之间禁止直接 import，只能通过本包的类型 + 内核服务（DI）交互；
 * - 本包只含类型与纯常量，不含实现、不依赖任何运行时（含 React）；
 * - 版本化：向后兼容新增走 minor，破坏性变更走 major。
 */

export type { Disposable, Logger, Unsubscribe } from './base';

export type {
  AnyEventMap,
  CustomEventKey,
  EventBus,
  FileChangeKind,
  FileChangedEvent,
  KernelEventMap,
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

export type {
  CharaInfo,
  ConventionRule,
  FamilyIndexRule,
  FamilyMatch,
  FamilyParseKind,
  GameAdapter,
  GameProject,
  ScaffoldOptions,
  ScaffoldResult,
  StateModel,
  VariableInfo,
  VariableSchema,
} from './game';

export type {
  ContributionBase,
  EditorCommandContext,
  EditorCommandContribution,
  EditorDecoratorContribution,
  ExportOptions,
  ExportResult,
  ExportTargetContribution,
  GameAdapterContribution,
  LineDecoration,
  SlotMap,
  SlotName,
  SlotRegistrar,
  SlotRegistry,
  UIPanelComponent,
  UIPanelContribution,
  UIPanelProps,
} from './slots';

export { KernelServices, WellKnownServices } from './services';
export type { KernelServiceKey, PluginRegistry, WellKnownServiceKey } from './services';

export type {
  ErbDim,
  ErbFile,
  ErbFunction,
  ErbFunctionRef,
  ErbIndex,
  ErbParam,
  ErbParserService,
} from './erb';

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
