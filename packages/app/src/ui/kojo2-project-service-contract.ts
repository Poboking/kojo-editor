/**
 * Kojo 2.0 编辑器接入：**项目级 Application Service 的契约面**（纯类型 + 常量，零实现）。
 *
 * 分层（本阶段架构决定）：
 * - UI（App / 面板 / 命令）只调 `Kojo2ProjectService`，不直接碰 Project IR / LinkedProject /
 *   Runtime Matcher / 组装纯函数；
 * - Service 负责**项目生命周期、编译协调、快照缓存、诊断汇总、最终组装与发布门禁**；
 * - 游戏事实（adapter / registry / backend / selectors / capability / sourceMap）由组合根
 *   （`bootstrap.ts` 的 2.0 编译登记面）按当前项目提供，UI/Service 不静态 import 任何插件。
 *
 * 本文件只定义类型，避免实现车与接线车互相等待。
 */
import type {
  Capability,
  DispatchPlanDiagnostic,
  DispatchSelectors,
  GameAdapter,
  GameFingerprint,
  KojoDiagnostic,
  KojoEmitBackend,
  KojoExprText,
  ProjectAssemblyDiagnostic,
  ProjectBuildProvenance,
  ProjectCompileResult,
  ProjectDiagnostic,
  ProjectDispatchPlan,
  ProjectErbAssembly,
  ProjectErbAssemblyPlan,
  RuntimeSelection,
  RuntimeSelectionRequest,
  SourceMapPolicy,
  TargetRegistry,
} from '@kojo/kojo-core';
import type { EmitFailure } from '@kojo/kojo-core';
import type { GameProject } from '@kojo/plugin-api';
import type {
  Kojo2FunctionNameContextResolver,
  Kojo2ProjectDocument,
} from './kojo2-project-analysis';

/* ============================== 组合根提供的编译事实 ============================== */

/**
 * 一个游戏（adapter）的 2.0 编译事实包。
 *
 * 由 `bootstrap.ts` 的 2.0 编译登记面按 `project.adapterId` 提供；Service/Hook 只按当前项目
 * 现取，拿不到 = 该游戏没有 2.0 编译面（明确降级，绝不回落到某默认 adapter）。
 */
export interface Kojo2CompileBundle {
  /** 自证 id（必须等于 project.adapterId，登记面负责对账）。 */
  readonly adapterId: string;
  readonly adapter: GameAdapter;
  readonly registry: TargetRegistry;
  readonly gameFingerprint: GameFingerprint;
  /** 项目级后端（不注入 charNo；函数名由 TargetRegistry 解析）。 */
  readonly createBackend: (deps: Kojo2BackendFactoryDeps) => KojoEmitBackend;
  /** 运行时 dispatch selector（eraTW: `ERATW_DISPATCH_SELECTORS`）；null = 该游戏没有。 */
  readonly dispatchSelectors: DispatchSelectors | null;
  readonly capability: Capability;
  readonly sourceMapPolicy: SourceMapPolicy;
}

export interface Kojo2BackendFactoryDeps {
  readonly compileExpression: (expr: KojoExprText) => string | EmitFailure;
  /** M1 legacy 路径需要；项目路径不传。 */
  readonly charNo?: string;
  readonly familySegment?: string;
}

/** 宿主表达式编译端口（组合根注入；预览/波浪线/项目编译共用同一份）。 */
export type Kojo2CompileExpression = (expr: KojoExprText) => string | EmitFailure;

/* ============================== 快照 / 端口 ============================== */

/** 一次编译所需的完整快照（Service 不读盘，全部由 Host 端口现取）。 */
export interface Kojo2ProjectSnapshot {
  /** 项目身份（rootDir / projectId；用于世代与诊断落点）。 */
  readonly projectId: string;
  readonly project: GameProject;
  readonly documents: readonly Kojo2ProjectDocument[];
  readonly bundle: Kojo2CompileBundle;
  /** 文件级函数名上下文（charNo / familySegment）——与分析装配面同一注入。 */
  readonly contextOf: Kojo2FunctionNameContextResolver;
  /**
   * M1 legacy 单文件编译端口：按文档产出一份 legacy ERB。
   *
   * 返回 `null` = 这条 legacy 文件编译失败（Service 记可见诊断，不静默）。
   */
  readonly compileLegacy: (document: Kojo2ProjectDocument) => string | null;
}

/** 发布产物写出端口（法定通道 = `kernel.io.exportFile`，对话框即授权）。 */
export type Kojo2ExportArtifact = (
  fileName: string,
  bytes: Uint8Array,
) => Promise<string | null>;

/* ============================== 诊断（Service 领域形状） ============================== */

export type Kojo2ProjectProblemChannel =
  | 'build'
  | 'dispatch'
  | 'dispatch-backend'
  | 'assembly'
  | 'runtime';

export type Kojo2ProjectProblemSeverity = 'error' | 'warning';

/**
 * Service 汇总后的项目问题（UI 只消费这一种；不直接看 core 的四种诊断形状）。
 *
 * `path/line/column` 有就给（能跳文件），没有就落项目级虚拟落点，**不猜文件**。
 */
export interface Kojo2ProjectProblem {
  readonly channel: Kojo2ProjectProblemChannel;
  readonly code: string;
  readonly severity: Kojo2ProjectProblemSeverity;
  readonly message: string;
  readonly path: string | null;
  /** 1 基行号；null = 只有项目级信息。 */
  readonly line: number | null;
  /** 1 基列号；null = 行级即可。 */
  readonly column: number | null;
  readonly fileId: string | null;
  readonly canonicalId: string | null;
  readonly functionName: string | null;
  readonly candidateTheaterIds: readonly string[];
}

/* ============================== Service 状态 ============================== */

export type Kojo2ProjectServicePhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'failed'
  | 'stale';

export interface Kojo2ProjectServiceStats {
  readonly documentCount: number;
  readonly theaterCount: number;
  readonly groupCount: number;
  readonly compileMs: number;
  readonly assemblyMs: number;
  readonly cacheHit: boolean;
}

/** 上一次成功（complete）的产物快照：失败时只作只读展示，永不可发布。 */
export interface Kojo2ProjectLastGood {
  readonly projectId: string;
  readonly plan: ProjectErbAssemblyPlan;
  readonly assembly: ProjectErbAssembly;
  readonly at: number;
}

export interface Kojo2ProjectServiceState {
  readonly phase: Kojo2ProjectServicePhase;
  readonly projectId: string | null;
  /** 世代：换项目/重编译递增；迟到的结果按世代丢弃。 */
  readonly generation: number;
  /** 当前源码的编译结果（失败时也可能是诊断视图）。 */
  readonly result: ProjectCompileResult | null;
  readonly plan: ProjectErbAssemblyPlan | null;
  /** 当前源码的组装结果（可能 incomplete；publish 只看它）。 */
  readonly assembly: ProjectErbAssembly | null;
  readonly lastGood: Kojo2ProjectLastGood | null;
  readonly problems: readonly Kojo2ProjectProblem[];
  readonly stats: Kojo2ProjectServiceStats;
  readonly publishable: boolean;
  readonly publishBlockReason: string | null;
  readonly error: string | null;
}

/** 运行时选择预览结果（Service 包装 core matcher，不让 UI 直接吃 LinkedProject）。 */
export interface Kojo2RuntimePreview {
  readonly selection: RuntimeSelection;
  readonly problems: readonly Kojo2ProjectProblem[];
}

/* ============================== Service 依赖 / 接口 ============================== */

export type Kojo2ProjectRefreshReason = 'open' | 'manual' | 'scan' | 'publish';

export interface Kojo2ProjectServiceDeps {
  /** 现取快照（Host 端口：项目/文档/编译事实/M1 legacy 编译）。 */
  readonly load: () => Promise<Kojo2ProjectSnapshot | null>;
  /** 发布写出端口；缺省 = 不可发布（比静默写盘安全）。 */
  readonly exportArtifact?: Kojo2ExportArtifact;
  /** 发布文件名（缺省 `kojo2-project.ERB`）。 */
  readonly artifactFileName?: string;
  readonly now?: () => number;
  readonly onState?: (state: Kojo2ProjectServiceState) => void;
  /**
   * 表达式编译端口（生产由 Host 注入；缺省 = 恒等透传，仅供测试/诊断）。
   *
   * 已知缺口：v1 `lowerExpression` 尚未接进 2.0 面（见 `kojo2-problem-wiring.ts` 头注），
   * 恒等透传只保证结构/诊断成立；发布产物需在接入真实管线后复验表达式形状。
   */
  readonly compileExpression?: Kojo2CompileExpression;
  /** 测试注入：core 项目编译。 */
  readonly compile?: (input: import('@kojo/kojo-core').ProjectCompileInput) => ProjectCompileResult;
}

export interface Kojo2ProjectPublishResult {
  readonly ok: boolean;
  /** 成功时 = exportFile 返回的落点（用户取消 = null ⇒ ok=false）。 */
  readonly path: string | null;
  /** 失败原因（人话）。 */
  readonly reason: string | null;
  /** 成功时写出的 unit 数。 */
  readonly unitCount: number;
}

export interface Kojo2ProjectService {
  state(): Kojo2ProjectServiceState;
  subscribe(listener: () => void): () => void;
  /** 重新取快照并编译；同快照命中缓存（cacheHit=true）。 */
  refresh(reason: Kojo2ProjectRefreshReason): Promise<Kojo2ProjectServiceState>;
  /** 编辑器内容变了：只标脏，不按键重编译。 */
  markStale(paths?: readonly string[]): void;
  /** 运行时选择预览（基于当前 LinkedProject；无结果返回 null）。 */
  previewRuntime(request: RuntimeSelectionRequest): Kojo2RuntimePreview | null;
  /** 发布前组装（含 M1 legacy 字节）；返回当前源码的 assembly。 */
  assemble(): ProjectErbAssembly | null;
  /** 发布：仅 `assembly.status==='complete'` 且当前源码 succeeded 时可写。 */
  publish(): Promise<Kojo2ProjectPublishResult>;
  /** 纯数据：发布 bundle 文本（测试/预览用，不写盘）。 */
  publishBundle(): { readonly fileName: string; readonly text: string; readonly unitCount: number } | null;
  /** 换项目 / 关项目：清空当前结果与诊断，回到 idle（保留/清空 lastGood 由实现定，文档写清）。 */
  reset(): void;
  dispose(): void;
}

export type Kojo2ProjectServiceFactory = (
  deps: Kojo2ProjectServiceDeps,
) => Kojo2ProjectService;

/* ============================== Host 工作流（命令 + 生命周期） ============================== */

/**
 * 工作流挂载依赖（UI 侧只给这三个：内核、额外根、通知）。
 *
 * 挂载模块负责：按项目取 2.0 编译事实（组合根登记面）、读写文档（kernel.io）、
 * 生成命令、把 Service 诊断汇总后上问题面板、订阅 project/file 事件。
 * **App.tsx 不再承载九步调用流程**，只 `import()` 本模块并把 commands 塞进命令表。
 */
export interface Kojo2ProjectWorkflowDeps {
  readonly kernel: import('@kojo/kernel').Kernel;
  /** 口上域之外的附加扫描根（会话级可变；每次取现）。 */
  readonly extraRoots?: () => readonly string[];
  readonly notify: (notice: { readonly kind: 'info' | 'error'; readonly message: string }) => void;
  /** 2.0 总开关（缺省 true；关时零动作、不注册命令面）。 */
  readonly enabled?: () => boolean;
  readonly now?: () => number;
}

export interface Kojo2ProjectWorkflowHandle {
  readonly commands: readonly import('./commands').ShellCommandSpec[];
  readonly service: Kojo2ProjectService;
  dispose(): void;
}

export type Kojo2ProjectWorkflowMount = (
  deps: Kojo2ProjectWorkflowDeps,
) => Kojo2ProjectWorkflowHandle;
