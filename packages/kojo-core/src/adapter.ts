/**
 * `GameAdapter` 2.0 契约 —— adapter-sdk 层（设计稿 §1.1 / §10.1–§10.10）。
 *
 * 分层铁律：
 * - **本文件零游戏名词**：这里只有"契约形状"，任何具体游戏的事件名、变量族名、
 *   引擎打印指令、颜色字面量都不许出现；游戏事实全部住在各 adapter 包的冻结数据里。
 * - **纯数据、只读、零 IO**：adapter 是"数据表 + 策略"，不是回调；core 不 import 插件。
 * - **判别联合 + readonly**：所有字段只读；运行期用 `freezeAdapter` 深冻结一次即可，
 *   之后查表零构造开销。
 * - **不静默**：校验函数一律返回 `KojoDiagnostic`，缺 profile / 未知事件 / 未知符号 /
 *   未声明 presentation·feature·storage 都是 error（`core/options/pending` 除外——
 *   它按码表固定为 warning）。
 *
 * 诊断码口径（§10.6 / §11.3）：
 * - 有 core 码的走 core 码（缺 profile、未知说话人/符号、未声明能力、未声明存储期…）；
 * - adapter 专属的结构自检走命名空间码（`unit/*` `event/*` `symbol/*`），
 *   命名空间取自 `diagnostics.ts` 的闭集，不新增字符串表。
 */
import type { KojoSpan, KojoValueType, KojoVarStorage } from './ast.js';
import type {
  AdapterDiagnosticCode,
  AdapterDiagnosticNamespace,
  DiagnosticCode,
  KojoDiagnostic,
} from './diagnostics.js';
import { severityOf } from './diagnostics.js';
import type { ForeachDeclarations } from './lower/expand/foreach.js';
import { validateForeachDeclarations } from './lower/expand/foreach.js';
/* 能力闸单源（K2-FEATURE-GATE-UNIFY）：键表唯一真源在 feature-gate，查询面委托它的统一入口 */
import { PROGRAM_FEATURE_KEYS, checkFeature, resolveProgramFeatures } from './lower/feature-gate.js';

/* ============================== 1. 契约总表 ============================== */

/**
 * 一个游戏的 2.0 适配器（字段顺序 = 设计稿 §10.1 总表）。
 *
 * adapter 只声明**事实与策略**；core 决定语法与降糖顺序。任何字段缺失都不猜：
 * 使用对应构造时报错，而不是静默降级。
 */
export interface GameAdapter {
  /** adapter 标识（日志/存储域后缀用；与游戏名解耦，建议小写短横线） */
  readonly id: string;
  /** adapter 契约版本（不是游戏版本；游戏版本走 `gameFingerprint`） */
  readonly version: string;
  /** 换盘/换汉化检测：引擎、CSV、ERH、本地化版本的一致指纹 */
  readonly gameFingerprint: GameFingerprint;
  /** 事件目录：`# 机` / `@织` 的合法事件、参数形状、调用与优先级模型、守卫、强制位 */
  readonly eventCatalog: EventCatalog;
  /** 域符号：我/你/她、角色属性、名字函数、说话人来源、未知符号策略 */
  readonly domainSymbols: DomainSymbols;
  /** profile：取色、等待、池/随机落点、extension 白名单 */
  readonly profile: AdapterProfile;
  /** 演出面：`(心形)` / `@着色` / `@颜绘` / `选项`；未声明即"当前 adapter 不支持" */
  readonly presentation: AdapterPresentation;
  /** 存储期落点：场景 / 存档 / 会话 */
  readonly storageClasses: StorageClasses;
  /** 程序层细粒度开关：arrays / while / goto / recursion / foreach / repeat */
  readonly programFeatures: ProgramFeatures;
  /**
   * `@巡` 的集合声明（additive；K2-FOREACH）：命名集合 + 作者数组规则。
   *
   * `null` = 本 adapter 不支持 `@巡`（老 adapter 传 null 即可，零改动）；
   * 声明事实全在 adapter，**数组事实**（作者 `# 变量 名 类型[N]`）由 core 从源码收集后
   * 经 `ForeachPlanOptions.arrays` 注入——adapter 不预列作者变量。
   */
  readonly foreachCollections: ForeachDeclarations | null;
  /** Unit 编码/EOL 策略（按文件保留，不归一化） */
  readonly encodingPolicy: EncodingPolicy;
  /** 同名/同层多定义判定：unique / shared-hook / overlay */
  readonly layerPolicy: LayerPolicy;
  /** adapter 专属诊断命名空间与码声明（additive，不覆盖 core 码） */
  readonly diagnosticNamespace: DiagnosticNamespacePolicy;
  /** 安全边界：是否执行代码、文件/网络/写盘能力、完整性校验 */
  readonly capability: Capability;
  /** source map 契约：至少行级，事件头/模板/池/原生/随机槽的映射开关 */
  readonly sourceMap: SourceMapPolicy;
  /** 一致性套件：golden + differential + smoke + encoding */
  readonly conformanceSuite: ConformanceSuite;
}

/* ============================== 2. 指纹 ============================== */

/** 指纹组成项；`csv`/`erh` 任一变化都意味着变量表/位表可能错位。 */
export type FingerprintKind = 'engine' | 'csv' | 'erh' | 'locale';

export interface FingerprintEntry {
  readonly kind: FingerprintKind;
  /** 版本/摘要原文（如引擎版号、CSV 结构摘要、汉化包标识） */
  readonly value: string;
}

/**
 * 游戏指纹：换盘 = 指纹不匹配，必须报错（或按 adapter 策略 warning），不能继续读写旧槽。
 */
export interface GameFingerprint {
  /** 稳定摘要（adapter 自定算法；要求同一盘稳定、换盘必变） */
  readonly digest: string;
  readonly entries: readonly FingerprintEntry[];
}

/* ============================== 3. 事件目录 ============================== */

/** 事件调用方式：引擎分发 / 标签分发 / 钩子（adapter 事实，core 只读） */
export type EventDispatchModel = 'engine-dispatch' | 'label-dispatch' | 'hook';

/** 优先级模型；`emuera-buckets` 时 `@织 之前/之后/接管` 才有落点（§8.6） */
export type EventPriorityModel = 'emuera-buckets' | 'load-order' | 'none';

/** 事件参数形状（`# 机 指令 310` 的 310 就是一枚 int 参数） */
export interface EventArgumentSpec {
  readonly name: string;
  readonly kind: 'int' | 'string' | 'any';
  readonly required: boolean;
}

/** 事件守卫：守卫表达式的**引擎原文**（core 不解释，只要求非空） */
export interface EventGuard {
  readonly text: string;
}

export interface EventSpec {
  /** 源端事件名（`# 机 <事件>` / `@织 <事件>` 里写的那个词） */
  readonly event: string;
  /** 引擎侧落点（事件常量/函数名；属于游戏事实，只住 adapter） */
  readonly engine: string;
  readonly args: readonly EventArgumentSpec[];
  readonly dispatch: EventDispatchModel;
  readonly priority: EventPriorityModel;
  /** 需要守卫时为守卫产物；`null` = 无守卫 */
  readonly guard: EventGuard | null;
  /** 强制事件：引擎保证触发（如新游戏首帧、回合收尾），编辑器可据此标"必填" */
  readonly forced: boolean;
  /** 可否被 `@织` 监听 */
  readonly weavable: boolean;
}

export interface EventCatalog {
  readonly events: readonly EventSpec[];
  /** 该 adapter 的缺省事件（`# 机` 省略事件名时？2.0 不省略；留作投影/补全提示） */
  readonly defaultEvent: string | null;
}

/* ============================== 4. 域符号 ============================== */

/** 代词角色（`# 视` 表写死的三列；符号落点由 adapter 决定） */
export type PersonRole = 'me' | 'you' | 'her';

export interface PronounSymbol {
  readonly role: PersonRole;
  /** 源端代词（不含花括号，如"我"）；由 adapter 声明，core 不内置 */
  readonly pronoun: string;
  /** 引擎落点原文（如 `%CALLNAME:…%` 一类引用模板；含游戏事实） */
  readonly engineRef: string;
  /** 是否要求当前文件有 `# 视`（没有则报未知/未声明） */
  readonly requiresView: boolean;
  /** 是否绑定 `# 视` 的目标（`# 视 目标` 时与本角色重合） */
  readonly viewBound: boolean;
  /** 引擎变量族（用于字符串族/数值族的打印与求值口径） */
  readonly family: string;
}

/** 角色属性（好感/恋慕一类）：名字 → 引擎族 + 编号；编号属于游戏事实 */
export interface AttributeSymbol {
  readonly name: string;
  readonly family: string;
  readonly index: number;
  readonly valueKind: KojoValueType;
  readonly readonly: boolean;
  readonly description: string;
}

/**
 * 域符号**变量**（additive；K2-SEMA-DOMAIN-VARIABLES）：adapter 外部世界里**不由作者文件声明**
 * 的全局标量（引擎 / 游戏自己的变量），作者可以直接读它、也可能可以写它。
 *
 * 为什么需要这一面：2.0 禁止对未声明名字赋值（§3.4.5），而这类变量**永远不会**出现在作者的
 * `# 变量` 里 ⇒ 没有这一面时 `名字 = 值` 只能被判成 `core/expr/unknown-symbol`（假阳）。
 *
 * 口径（写死，别扩）：
 * - `name` 是**作者在源端写的名字**（不是引擎落点；落点由各 adapter 的表达式管线负责）；
 * - `valueKind` 只允许三种**叶子**类型（`unknown` 无意义：adapter 既然声明了变量，就说明它
 *   知道类型；要"动态类型"就别声明，让它继续报未声明）；
 * - `readonly` 缺省 = 可写；`true` = 只读（作者可读、写则报既有 `core/expr/readonly-target`）；
 * - 这一面**只**参与名字解析与类型/只读判定，不参与 lowering（产物仍原样写作者名字）。
 */
export interface DomainVariableSymbol {
  readonly name: string;
  readonly valueKind: 'int' | 'string' | 'character';
  readonly readonly?: boolean;
}

/** 名字函数（"角色文本"一类）：源名 → 引擎调用 + 形参名 */
export interface NameFunctionSymbol {
  readonly name: string;
  readonly engine: string;
  readonly args: readonly string[];
  readonly returns: 'string';
}

/**
 * 说话人来源：
 * - `closed`：adapter 能穷举的说话人名表（fixture / 小型游戏）；
 * - `project`：名字来自工程数据表（如角色 CSV），SDK 层不猜、交给项目级分析。
 */
export type SpeakerSource =
  | { readonly kind: 'closed'; readonly names: readonly string[] }
  | { readonly kind: 'project'; readonly table: string; readonly key: string };

export interface DomainSymbols {
  readonly pronouns: readonly PronounSymbol[];
  readonly attributes: readonly AttributeSymbol[];
  readonly nameFunctions: readonly NameFunctionSymbol[];
  /**
   * 域符号变量（additive；**可缺省**）：
   * - 省略 / `undefined` = 本 adapter 没有外部变量面（**旧 adapter 零改动**，sema 行为与今天
   *   逐字节一致：仍按 `core/expr/unknown-symbol` 报未声明）；
   * - 名字空间与 `pronouns` / `attributes` / `nameFunctions` **互斥**（撞名 = 装载期
   *   `unit/adapter-inconsistent`，一个名字只能有一个解析面）。
   */
  readonly variables?: readonly DomainVariableSymbol[];
  readonly speakers: SpeakerSource;
  /** 未知符号策略：`error` = 报错（默认）；`raw` = 原样放行（糖视图无法表达的走 raw） */
  readonly unknown: 'error' | 'raw';
}

/* ============================== 5. profile ============================== */

/** `>` 旁白取色策略：作者色 / 默认色 / 自动（§4.7，不默认"默认色"） */
export type NarrationColorPolicy = 'author' | 'default' | 'auto';
/** `角色：` 台词取色策略 */
export type DialogueColorPolicy = 'author' | 'default';
/** 无 `续` 时的等待策略；没有全局值，来自 adapter profile */
export type WaitDefault = 'wait' | 'continue';
/** `D` 系打印是否可用（D 系会忽略颜色指令：上色必须走非 D 变体） */
export type ColorMode = 'D' | 'plain';
/** `# 池` 的条件选择落点；`selectcase` 只是等值优化，不是语义 */
export type PoolStyle = 'if' | 'selectcase';
/** `@随机` 文本落点；控制流/副作用强制 `rand-selectcase` */
export type RandStyle = 'printdata' | 'printdatal' | 'rand-selectcase';

/** extension 白名单（§10.2 `features`；program 粗开关 + 细粒度在 programFeatures） */
export type ExtensionFeature =
  | 'program'
  | 'functions'
  | 'loops'
  | 'arrays'
  | 'goto'
  | 'recursion'
  | 'foreach'
  | 'repeat';

export interface AdapterProfile {
  readonly narrationColor: NarrationColorPolicy;
  readonly dialogueColor: DialogueColorPolicy;
  readonly waitDefault: WaitDefault;
  readonly colorMode: ColorMode;
  readonly poolStyle: PoolStyle;
  readonly randStyle: RandStyle;
  readonly features: readonly ExtensionFeature[];
}

/* ============================== 6. 演出面 ============================== */

/** 可声明的演出面；未声明的面在使用时报"当前 adapter 不支持"（§10.10） */
export type PresentationFeature = 'heart' | 'color' | 'face' | 'options';

/** `(心形)` 的打印模式：台词/旁白 × 等待/不等待 四象限（§4.8） */
export type HeartMode = 'w' | 'l' | 'dw' | 'dl';

export interface HeartPresentation {
  /** 引擎打印函数原文（游戏事实） */
  readonly engine: string;
  /** 台词：等待 / 续 */
  readonly dialogue: { readonly wait: HeartMode; readonly continue: HeartMode };
  /** 旁白：等待 / 续 */
  readonly narration: { readonly wait: HeartMode; readonly continue: HeartMode };
}

export interface ColorPresentation {
  /** 进入 `@着色` 块的引擎指令（只写指令名，参数由 core 拼接） */
  readonly setColor: string;
  /** 离开块/控制转移时的复原指令 */
  readonly resetColor: string;
  /** 颜色字面量前缀（如 `0x`） */
  readonly hexPrefix: string;
}

export type FaceObject = 'me' | 'you';

/** `@颜绘` 的对象 → 引擎调用与接收者参数 */
export interface FaceCall {
  readonly object: FaceObject;
  /** 引擎调用名（游戏事实，由 adapter 填） */
  readonly call: string;
  /** 接收者实参原文（游戏事实，由 adapter 填） */
  readonly receiverArg: string;
}

export interface FacePresentation {
  /** 表情省略时补齐的默认表情（含游戏事实） */
  readonly defaultExpression: string;
  readonly calls: readonly FaceCall[];
  /** 参数上限（对象之外的表情/服装/差分/特效） */
  readonly maxArgs: number;
  /** 跳过前一格时使用的占位字面量 */
  readonly placeholder: string;
}

export interface OptionsPresentation {
  /** 2.0 里 `选项` 仍是待定 API；adapter 只声明落点，core 用 warning */
  readonly status: 'pending';
  readonly button: string;
  readonly input: string;
  /**
   * 输入读回槽（additive；引擎事实由 adapter 数据声明）：按钮输入把玩家选择写回的
   * 变量名（如按钮输入系读回 `RESULTS`）。落点关键词只从这份数据来，backend 不写死。
   */
  readonly result: string;
  /** 单场景最多选项块数（§7.5：一个场景最多一个） */
  readonly maxPerScene: number;
}

export interface AdapterPresentation {
  readonly heart: HeartPresentation | null;
  readonly color: ColorPresentation | null;
  readonly face: FacePresentation | null;
  readonly options: OptionsPresentation | null;
}

/* ============================== 7. 存储期 ============================== */

/** 存储期（与 AST 的 `# 变量` 存储期同源，不另抄一份） */
export type StoragePeriod = KojoVarStorage;

/** 初始化时机：进入事件/监听、开新游戏、进程启动 */
export type StorageInit = 'on-entry' | 'on-new-game' | 'on-process-start';

export interface StorageClassSpec {
  readonly period: StoragePeriod;
  /** 引擎落点（如局部区/存档区/会话区；含游戏事实） */
  readonly engine: string;
  readonly init: StorageInit;
  /** 是否随存档持久化（场景/会话为 false） */
  readonly persisted: boolean;
  /** 槽位前缀：必须 `__` 开头，保证与作者名字空间隔离 */
  readonly slotPrefix: string;
  readonly description: string;
}

export interface StorageClasses {
  readonly classes: readonly StorageClassSpec[];
  /** 槽位稳定性：跨构建不搬槽（project-stable）还是每次重排 */
  readonly slotStability: 'project-stable' | 'per-build';
}

/* ============================== 8. 程序层 / Unit / Layer ============================== */

export type ProgramFeatureKey = 'arrays' | 'while' | 'goto' | 'recursion' | 'foreach' | 'repeat';

export type ProgramFeatures = Readonly<Record<ProgramFeatureKey, boolean>>;

/**
 * 程序层键的**唯一真源**（校验与补全按它遍历，不另写一份字符串表）。
 *
 * K2-FEATURE-GATE-UNIFY 后表本身住在 `lower/feature-gate.ts`（能力闸单源），这里只再导出：
 * 公开面不变，消费方仍从这里取。
 */
export { PROGRAM_FEATURE_KEYS };

/** 源文件/产物编码（每个 Unit 独立保留，§10.4） */
export type TextEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le-bom';
export type EolPolicy = 'crlf' | 'lf' | 'mixed';

export interface EncodingPolicy {
  readonly defaultEncoding: TextEncoding;
  readonly allowedEncodings: readonly TextEncoding[];
  readonly eol: EolPolicy;
  readonly preserveBom: boolean;
  /** 写死 false：保存时不得全仓归一化（类型层就堵死） */
  readonly normalizeOnSave: false;
  readonly fingerprintMismatch: 'error' | 'warn';
}

/** 层模式：同层同名 error / 共享钩子合法 / 覆盖层合法（§10.5） */
export type LayerMode = 'unique' | 'shared-hook' | 'overlay';
export type LayerTarget = 'function' | 'event-hook' | 'kojo-overlay';

export interface LayerRule {
  readonly target: LayerTarget;
  readonly mode: LayerMode;
}

export interface LayerPolicy {
  readonly defaultMode: LayerMode;
  readonly rules: readonly LayerRule[];
}

/* ============================== 9. 安全 / source map / 一致性 ============================== */

export interface DiagnosticNamespacePolicy {
  /** adapter 允许使用的命名空间（additive；core 码仍由 core 独占） */
  readonly namespaces: readonly AdapterDiagnosticNamespace[];
  /** 本次适配器实际声明的专属码；必须落在自己声明的命名空间里 */
  readonly codes: readonly AdapterDiagnosticCode[];
}

export type FileAccessScope = 'none' | 'read-project' | 'read-write-approved';

export interface Capability {
  /** 是否执行 adapter 自带代码（数据型 adapter = false） */
  readonly executesCode: boolean;
  readonly fileAccess: FileAccessScope;
  readonly networkAccess: 'none' | 'declared';
  readonly writablePaths: 'none' | 'user-approved';
  /** 代码型 adapter 必须声明完整性校验（§10.8） */
  readonly integrity: 'none' | 'checksum';
}

export interface SourceMapPolicy {
  readonly granularity: 'line' | 'line+column';
  /** 包装/伴生函数映射到事件头 */
  readonly mapsEventHeader: boolean;
  /** 模板展开同时指向调用处与模板定义行 */
  readonly mapsTemplateExpansion: boolean;
  /** 池展开同时指向调用处与池定义行 */
  readonly mapsPoolExpansion: boolean;
  /** `@原生` 逐行映射 */
  readonly mapsNativeLines: boolean;
  /** `@随机` 隐藏槽映射到块头 */
  readonly mapsRandomSlots: boolean;
}

export type ConformanceKind = 'golden' | 'differential' | 'smoke' | 'encoding';

export interface ConformanceCase {
  readonly kind: ConformanceKind;
  readonly name: string;
  /** fixture 标识（符号引用；SDK 层零 IO，不读盘） */
  readonly fixture: string;
}

export interface ConformanceSuite {
  readonly cases: readonly ConformanceCase[];
  /** 必须有产物的验收面（golden / differential / smoke / encoding） */
  readonly required: readonly ConformanceKind[];
}

/* ============================== 10. 常量集合 ============================== */

const NARRATION_COLORS: readonly NarrationColorPolicy[] = Object.freeze(['author', 'default', 'auto'] as const);
const DIALOGUE_COLORS: readonly DialogueColorPolicy[] = Object.freeze(['author', 'default'] as const);
const WAIT_DEFAULTS: readonly WaitDefault[] = Object.freeze(['wait', 'continue'] as const);
const COLOR_MODES: readonly ColorMode[] = Object.freeze(['D', 'plain'] as const);
const POOL_STYLES: readonly PoolStyle[] = Object.freeze(['if', 'selectcase'] as const);
const RAND_STYLES: readonly RandStyle[] = Object.freeze(['printdata', 'printdatal', 'rand-selectcase'] as const);
const EXTENSION_FEATURES: readonly ExtensionFeature[] = Object.freeze([
  'program',
  'functions',
  'loops',
  'arrays',
  'goto',
  'recursion',
  'foreach',
  'repeat',
] as const);
const TEXT_ENCODINGS: readonly TextEncoding[] = Object.freeze(['utf-8', 'utf-8-bom', 'utf-16le-bom'] as const);
const EOL_POLICIES: readonly EolPolicy[] = Object.freeze(['crlf', 'lf', 'mixed'] as const);
const LAYER_MODES: readonly LayerMode[] = Object.freeze(['unique', 'shared-hook', 'overlay'] as const);
const LAYER_TARGETS: readonly LayerTarget[] = Object.freeze(['function', 'event-hook', 'kojo-overlay'] as const);
const DISPATCH_MODELS: readonly EventDispatchModel[] = Object.freeze([
  'engine-dispatch',
  'label-dispatch',
  'hook',
] as const);
const PRIORITY_MODELS: readonly EventPriorityModel[] = Object.freeze(['emuera-buckets', 'load-order', 'none'] as const);
const CONFORMANCE_KINDS: readonly ConformanceKind[] = Object.freeze([
  'golden',
  'differential',
  'smoke',
  'encoding',
] as const);
const ADAPTER_NAMESPACES: readonly AdapterDiagnosticNamespace[] = Object.freeze([
  'unit',
  'event',
  'symbol',
  'text',
  'variant',
  'overlay',
  'raw',
] as const);
/** 域符号变量允许的值类型（叶子；`unknown` 不登记——声明了变量就等于声明了类型） */
const DOMAIN_VARIABLE_KINDS: readonly DomainVariableSymbol['valueKind'][] = Object.freeze([
  'int',
  'string',
  'character',
] as const);

/** 存储期源端写法（core 语言词；仅用于诊断文案） */
const STORAGE_LABELS: Readonly<Record<StoragePeriod, string>> = Object.freeze({
  scene: '场景',
  save: '存档',
  session: '会话',
});

/** 未声明 presentation 时的 core 诊断码（§4.8 / §8.2 / §8.3 / §7.5） */
const PRESENTATION_UNSUPPORTED_CODES: Readonly<Record<PresentationFeature, DiagnosticCode>> = Object.freeze({
  // 码表没有独立的"心形"码：近义落在 feature/unsupported（说话人能力面）
  heart: 'core/feature/unsupported',
  color: 'core/color/unsupported',
  face: 'core/face/unsupported',
  // `选项` 是 2.0 待定 UI（pending warning 由 lowering 出），但**未声明 = error**：
  // 没有按钮落点就不能生成有效产物 ⇒ 与 lowering 的能力闸同码同级别（fail-closed）。
  options: 'core/feature/unsupported',
});

/** adapter 自检码（命名空间闭集；校验函数与测试共用这一份字符串源） */
export const ADAPTER_VALIDATION_CODES = Object.freeze({
  incomplete: 'unit/adapter-incomplete',
  inconsistent: 'unit/adapter-inconsistent',
  fingerprint: 'unit/fingerprint-missing',
  encoding: 'unit/encoding-policy',
  storage: 'unit/storage-inconsistent',
  namespace: 'unit/diagnostic-namespace',
  capability: 'unit/capability-integrity',
  sourceMap: 'unit/source-map-incomplete',
  conformance: 'unit/conformance-incomplete',
  eventEmpty: 'event/catalog-empty',
  eventDuplicate: 'event/duplicate',
  eventArgument: 'event/argument',
  eventDefault: 'event/default-missing',
  eventUnknown: 'event/unknown',
  symbolDuplicate: 'symbol/duplicate',
  speakerDuplicate: 'symbol/speaker',
} as const satisfies Readonly<Record<string, AdapterDiagnosticCode>>);

/* ============================== 11. 诊断构造 ============================== */

function diagnostic(code: DiagnosticCode, message: string, span: KojoSpan | null = null): KojoDiagnostic {
  return Object.freeze({ code, severity: severityOf(code), message, span });
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/**
 * 域符号的**其它三张脸**（代词 / 角色属性 / 名字函数）→ `名字 → 中文标签`。
 *
 * 只服务 `domainSymbols.variables` 的撞名自检：一个名字在名字解析链里只能落到一个面，
 * 否则"读它是什么类型"就得靠猜（本仓不许猜）。防御性写法：坏形状的条目跳过、不抛。
 */
function symbolFaceNames(symbols: Partial<DomainSymbols>): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const add = (name: unknown, label: string): void => {
    if (isText(name) && !out.has(name)) out.set(name, label);
  };
  if (Array.isArray(symbols.pronouns)) for (const item of symbols.pronouns) add(item?.pronoun, '代词');
  if (Array.isArray(symbols.attributes)) for (const item of symbols.attributes) add(item?.name, '角色属性');
  if (Array.isArray(symbols.nameFunctions)) for (const item of symbols.nameFunctions) add(item?.name, '名字函数');
  return out;
}

/* ============================== 12. 校验：adapter 自检 ============================== */

/**
 * adapter 装载时的**全量自检**（§8.6 第 5 条：参数冲突在 adapter 装载时校验，
 * 不把歧义留到用户文件）。返回空数组 = 契约自洽。
 *
 * 这一层只查"契约自洽性"，不查用户源码；用户源码侧的未知事件/未声明能力走下面的
 * `check*` 系列。
 */
export function validateGameAdapter(adapter: GameAdapter): readonly KojoDiagnostic[] {
  const out: KojoDiagnostic[] = [];
  const push = (code: DiagnosticCode, message: string): void => {
    out.push(diagnostic(code, message));
  };

  /* --- 标识与指纹 --- */
  if (!isText(adapter.id)) push(ADAPTER_VALIDATION_CODES.incomplete, 'adapter 缺少 id：adapter 必须有稳定标识。');
  if (!isText(adapter.version)) push(ADAPTER_VALIDATION_CODES.incomplete, 'adapter 缺少 version：契约版本不能留空。');

  const fingerprint: Partial<GameFingerprint> | undefined = adapter.gameFingerprint;
  if (fingerprint === undefined || !isText(fingerprint.digest)) {
    push(ADAPTER_VALIDATION_CODES.fingerprint, 'adapter 缺少 gameFingerprint.digest：换盘无法检测。');
  } else if (!Array.isArray(fingerprint.entries) || fingerprint.entries.length === 0) {
    push(ADAPTER_VALIDATION_CODES.fingerprint, 'gameFingerprint.entries 为空：指纹必须列出组成项。');
  } else if (fingerprint.entries.some((entry) => !isText(entry.value))) {
    push(ADAPTER_VALIDATION_CODES.fingerprint, 'gameFingerprint.entries 含空值：每个组成项都要有版本/摘要。');
  }

  /* --- profile（缺字段一律 error，不静默选） --- */
  const profile: Partial<AdapterProfile> | undefined = adapter.profile;
  if (profile === undefined) {
    push('core/profile/missing', 'adapter 缺少 profile：取色/等待/池与随机落点没有默认值。');
  } else {
    if (!isOneOf(profile.narrationColor, NARRATION_COLORS)) {
      push('core/profile/missing', 'profile.narrationColor 缺失或非法（author / default / auto）。');
    }
    if (!isOneOf(profile.dialogueColor, DIALOGUE_COLORS)) {
      push('core/profile/missing', 'profile.dialogueColor 缺失或非法（author / default）。');
    }
    if (profile.waitDefault === undefined || !isOneOf(profile.waitDefault, WAIT_DEFAULTS)) {
      push('core/wait/no-profile', 'profile.waitDefault 缺失或非法（wait / continue）：等待不能猜。');
    }
    if (!isOneOf(profile.colorMode, COLOR_MODES)) {
      push('core/profile/missing', 'profile.colorMode 缺失或非法（D / plain）。');
    }
    if (!isOneOf(profile.poolStyle, POOL_STYLES)) {
      push('core/profile/missing', 'profile.poolStyle 缺失或非法（if / selectcase）。');
    }
    if (!isOneOf(profile.randStyle, RAND_STYLES)) {
      push('core/profile/missing', 'profile.randStyle 缺失或非法（printdata / printdatal / rand-selectcase）。');
    }
    if (!Array.isArray(profile.features) || profile.features.some((f) => !isOneOf(f, EXTENSION_FEATURES))) {
      push('core/profile/missing', 'profile.features 不是合法的 extension 白名单。');
    }

    /* --- programFeatures 与 features 的一致性 --- */
    const features = profile.features;
    if (Array.isArray(features)) {
      const anyProgram = PROGRAM_FEATURE_KEYS.some((key) => adapter.programFeatures?.[key] === true);
      if (anyProgram && !features.includes('program')) {
        push(
          ADAPTER_VALIDATION_CODES.inconsistent,
          'programFeatures 开启了程序层能力，但 profile.features 没有声明 program。',
        );
      }
    }
  }

  /* --- foreachCollections（additive；null/缺省 = 不支持，不报错） --- */
  const foreachCollections: ForeachDeclarations | null | undefined = adapter.foreachCollections;
  if (foreachCollections !== null && foreachCollections !== undefined) {
    if (typeof foreachCollections !== 'object') {
      push(ADAPTER_VALIDATION_CODES.incomplete, 'foreachCollections 必须是对象或 null（null = 不支持 @巡）。');
    } else {
      const rawCollections: unknown = foreachCollections.collections;
      const hasArrayRule = foreachCollections.arrayRule !== null && foreachCollections.arrayRule !== undefined;
      if (!Array.isArray(rawCollections)) {
        push(ADAPTER_VALIDATION_CODES.incomplete, 'foreachCollections.collections 必须是数组（可为空）。');
      } else if (rawCollections.length === 0 && !hasArrayRule) {
        push(
          ADAPTER_VALIDATION_CODES.incomplete,
          'foreachCollections 既没有命名集合也没有数组规则：`@巡` 没有任何可解析的落点（要么给声明，要么给 null）。',
        );
      }
      // 声明自洽性：语言层规则只有一份（foreach.ts），这里只把消息挂到既有 adapter 码表
      for (const message of validateForeachDeclarations(foreachCollections)) {
        push(ADAPTER_VALIDATION_CODES.inconsistent, message);
      }
    }
  }

  /* --- eventCatalog --- */
  const catalog: Partial<EventCatalog> | undefined = adapter.eventCatalog;
  if (catalog === undefined || !Array.isArray(catalog.events) || catalog.events.length === 0) {
    push(ADAPTER_VALIDATION_CODES.eventEmpty, 'eventCatalog 为空：adapter 至少要声明一个可挂载事件。');
  } else {
    const seen = new Set<string>();
    for (const spec of catalog.events) {
      const label = spec?.event ?? '(空事件名)';
      if (!isText(spec?.event)) {
        push(ADAPTER_VALIDATION_CODES.eventEmpty, 'eventCatalog 含空事件名。');
        continue;
      }
      if (seen.has(spec.event)) push(ADAPTER_VALIDATION_CODES.eventDuplicate, `eventCatalog 事件名重复：“${spec.event}”。`);
      seen.add(spec.event);
      if (!isText(spec.engine)) push(ADAPTER_VALIDATION_CODES.inconsistent, `事件“${label}”缺少引擎落点。`);
      if (!isOneOf(spec.dispatch, DISPATCH_MODELS)) {
        push(ADAPTER_VALIDATION_CODES.inconsistent, `事件“${label}”的 dispatch 模型非法。`);
      }
      if (!isOneOf(spec.priority, PRIORITY_MODELS)) {
        push(ADAPTER_VALIDATION_CODES.inconsistent, `事件“${label}”的 priority 模型非法。`);
      }
      const argNames = new Set<string>();
      for (const arg of spec.args ?? []) {
        if (!isText(arg.name)) push(ADAPTER_VALIDATION_CODES.eventArgument, `事件“${label}”含空参数名。`);
        else if (argNames.has(arg.name)) {
          push(ADAPTER_VALIDATION_CODES.eventArgument, `事件“${label}”参数名重复：“${arg.name}”。`);
        } else argNames.add(arg.name);
      }
    }
    if (catalog.defaultEvent !== null && catalog.defaultEvent !== undefined) {
      const known = catalog.events.some((spec) => spec.event === catalog.defaultEvent);
      if (!known) {
        push(
          ADAPTER_VALIDATION_CODES.eventUnknown,
          `eventCatalog.defaultEvent“${catalog.defaultEvent}”不在事件表里。可用事件：${eventNames(adapter).join('、')}。`,
        );
      }
    }
  }

  /* --- domainSymbols --- */
  const symbols: Partial<DomainSymbols> | undefined = adapter.domainSymbols;
  if (symbols === undefined) {
    push('core/expr/unknown-symbol', 'adapter 缺少 domainSymbols：代词/属性/名字函数都无处解析。');
  } else {
    if (!Array.isArray(symbols.pronouns) || symbols.pronouns.length === 0) {
      push('core/expr/unknown-symbol', 'domainSymbols.pronouns 为空：`{我}` / `{你}` / `{她}` 无落点。');
    } else {
      const roles = new Set<PersonRole>();
      const words = new Set<string>();
      for (const pronoun of symbols.pronouns) {
        if (!isText(pronoun?.pronoun)) push('core/expr/unknown-symbol', 'domainSymbols.pronouns 含空代词。');
        else if (words.has(pronoun.pronoun)) {
          push(ADAPTER_VALIDATION_CODES.symbolDuplicate, `代词“${pronoun.pronoun}”重复声明。`);
        } else words.add(pronoun.pronoun);
        if (roles.has(pronoun.role)) {
          push(ADAPTER_VALIDATION_CODES.symbolDuplicate, `代词角色“${pronoun.role}”重复声明。`);
        } else roles.add(pronoun.role);
        if (!isText(pronoun.engineRef)) {
          push('core/expr/unknown-symbol', `代词“${pronoun.pronoun ?? '?'}”缺少引擎落点。`);
        }
      }
    }

    if (!Array.isArray(symbols.attributes)) {
      push('core/expr/unknown-symbol', 'domainSymbols.attributes 必须是数组（可为空）。');
    } else {
      const names = new Set<string>();
      for (const attribute of symbols.attributes) {
        if (!isText(attribute?.name)) push('core/expr/unknown-symbol', 'domainSymbols.attributes 含空名。');
        else if (names.has(attribute.name)) {
          push(ADAPTER_VALIDATION_CODES.symbolDuplicate, `角色属性“${attribute.name}”重复声明。`);
        } else names.add(attribute.name);
        if (!isText(attribute.family) || !isInteger(attribute.index) || attribute.index < 0) {
          push('core/expr/unknown-symbol', `角色属性“${attribute.name ?? '?'}”的落点（族/编号）非法。`);
        }
      }
    }

    if (!Array.isArray(symbols.nameFunctions)) {
      push('core/expr/unknown-symbol', 'domainSymbols.nameFunctions 必须是数组（可为空）。');
    } else {
      const names = new Set<string>();
      for (const fn of symbols.nameFunctions) {
        if (!isText(fn?.name)) push('core/expr/unknown-symbol', 'domainSymbols.nameFunctions 含空名。');
        else if (names.has(fn.name)) {
          push(ADAPTER_VALIDATION_CODES.symbolDuplicate, `名字函数“${fn.name}”重复声明。`);
        } else names.add(fn.name);
        if (!isText(fn.engine)) {
          push('core/expr/unknown-symbol', `名字函数“${fn.name ?? '?'}”缺少引擎调用名。`);
        }
      }
    }

    /*
     * 域符号变量（additive；缺省 = 空 ⇒ 旧 adapter 零诊断）。
     * 形状坏 → incomplete；重名 / 与既有符号面撞名 → inconsistent（都取既有码，不新造）。
     */
    const rawVariables: unknown = symbols.variables;
    if (rawVariables !== undefined) {
      if (!Array.isArray(rawVariables)) {
        push(ADAPTER_VALIDATION_CODES.incomplete, 'domainSymbols.variables 必须是数组（可省略：省略 = 没有外部变量面）。');
      } else {
        const otherFaces = symbolFaceNames(symbols);
        const variableNames = new Set<string>();
        for (const raw of rawVariables as readonly unknown[]) {
          const variable = raw as Partial<DomainVariableSymbol> | null;
          if (variable === null || typeof variable !== 'object') {
            push(ADAPTER_VALIDATION_CODES.incomplete, 'domainSymbols.variables 含非对象条目。');
            continue;
          }
          if (!isText(variable.name)) {
            push(ADAPTER_VALIDATION_CODES.incomplete, 'domainSymbols.variables 含空名。');
            continue;
          }
          const name = variable.name;
          if (!isOneOf(variable.valueKind, DOMAIN_VARIABLE_KINDS)) {
            push(
              ADAPTER_VALIDATION_CODES.incomplete,
              `域符号变量“${name}”的 valueKind 非法（int / string / character）。`,
            );
          }
          if (variable.readonly !== undefined && typeof variable.readonly !== 'boolean') {
            push(
              ADAPTER_VALIDATION_CODES.incomplete,
              `域符号变量“${name}”的 readonly 必须是布尔值（缺省 = 可写）。`,
            );
          }
          if (variableNames.has(name)) {
            push(ADAPTER_VALIDATION_CODES.inconsistent, `域符号变量“${name}”重复声明。`);
            continue;
          }
          variableNames.add(name);
          const face = otherFaces.get(name);
          if (face !== undefined) {
            push(
              ADAPTER_VALIDATION_CODES.inconsistent,
              `域符号变量“${name}”与已声明的${face}撞名：一个名字只能有一个解析面。`,
            );
          }
        }
      }
    }

    const speakers = symbols.speakers;
    if (speakers === undefined) {
      push('core/narrative/unknown-speaker', 'domainSymbols.speakers 缺失：说话人无法解析。');
    } else if (speakers.kind === 'closed') {
      if (!Array.isArray(speakers.names) || speakers.names.length === 0) {
        push('core/narrative/unknown-speaker', 'domainSymbols.speakers 为 closed 但名表为空。');
      } else {
        const seen = new Set<string>();
        for (const name of speakers.names) {
          if (!isText(name)) push('core/narrative/unknown-speaker', '说话人名表含空名。');
          else if (seen.has(name)) push(ADAPTER_VALIDATION_CODES.speakerDuplicate, `说话人“${name}”重复声明。`);
          else seen.add(name);
        }
      }
    } else if (speakers.kind === 'project') {
      if (!isText(speakers.table) || !isText(speakers.key)) {
        push('core/narrative/unknown-speaker', 'domainSymbols.speakers 为 project 但缺少表名/键名。');
      }
    } else {
      push('core/narrative/unknown-speaker', 'domainSymbols.speakers 的 kind 非法。');
    }

    if (symbols.unknown !== 'error' && symbols.unknown !== 'raw') {
      push('core/expr/unknown-symbol', 'domainSymbols.unknown 必须是 error 或 raw。');
    }
  }

  /* --- presentation --- */
  const presentation: Partial<AdapterPresentation> | undefined = adapter.presentation;
  if (presentation === undefined) {
    push(ADAPTER_VALIDATION_CODES.incomplete, 'adapter 缺少 presentation：adapter 至少要声明哪些演出面可用（全部 null 也算声明）。');
  } else {
    if (presentation.heart !== null && presentation.heart !== undefined) {
      const heart = presentation.heart;
      if (!isText(heart.engine)) push('core/feature/unsupported', 'presentation.heart 缺少引擎打印函数。');
      const modes: readonly HeartMode[] = ['w', 'l', 'dw', 'dl'];
      const quads = [heart.dialogue?.wait, heart.dialogue?.continue, heart.narration?.wait, heart.narration?.continue];
      if (quads.some((mode) => !isOneOf(mode, modes))) {
        push(ADAPTER_VALIDATION_CODES.inconsistent, 'presentation.heart 的 w/l/dw/dl 四象限不完整。');
      }
    }
    if (presentation.color !== null && presentation.color !== undefined) {
      const color = presentation.color;
      if (!isText(color.setColor) || !isText(color.resetColor)) {
        push('core/color/unsupported', 'presentation.color 缺少进入/复原指令。');
      }
      if (!isText(color.hexPrefix)) push(ADAPTER_VALIDATION_CODES.inconsistent, 'presentation.color.hexPrefix 为空。');
    }
    if (presentation.face !== null && presentation.face !== undefined) {
      const face = presentation.face;
      if (!isText(face.defaultExpression)) {
        push('core/face/unsupported', 'presentation.face 缺少默认表情。');
      }
      if (!Array.isArray(face.calls) || face.calls.length === 0) {
        push('core/face/unsupported', 'presentation.face.calls 为空：颜绘没有落点。');
      } else {
        const objects = new Set<FaceObject>();
        for (const call of face.calls) {
          if (objects.has(call.object)) {
            push(ADAPTER_VALIDATION_CODES.inconsistent, `presentation.face 对对象“${call.object}”重复声明调用。`);
          } else objects.add(call.object);
          if (!isText(call.call) || !isText(call.receiverArg)) {
            push('core/face/unsupported', `presentation.face 对象“${call.object}”缺少调用名/接收者。`);
          }
        }
        for (const required of ['me', 'you'] as const) {
          if (!objects.has(required)) {
            push('core/face/unsupported', `presentation.face 缺少对象“${required}”的调用声明。`);
          }
        }
      }
      if (!isInteger(face.maxArgs) || face.maxArgs < 0) {
        push('core/face/args', 'presentation.face.maxArgs 非法。');
      }
      if (!isText(face.placeholder)) push(ADAPTER_VALIDATION_CODES.inconsistent, 'presentation.face.placeholder 为空。');
    }
    if (presentation.options !== null && presentation.options !== undefined) {
      const options = presentation.options;
      if (!isText(options.button) || !isText(options.input)) {
        push('core/options/pending', 'presentation.options 缺少按钮/输入落点。');
      }
      // 读回槽 additive：缺了就不能把玩家选择分派回按钮（emitter 会 fail-closed，这里先报）
      if (!isText(options.result)) {
        push('core/options/pending', 'presentation.options 缺少按钮输入的读回槽（result）。');
      }
      if (presentation.options.status !== 'pending') {
        push('core/options/pending', 'presentation.options.status 只能是 pending（2.0 待定 API）。');
      }
      if (!isInteger(options.maxPerScene) || options.maxPerScene < 1) {
        push(ADAPTER_VALIDATION_CODES.inconsistent, 'presentation.options.maxPerScene 必须是正整数。');
      }
    }
  }

  /* --- storageClasses --- */
  const storage: Partial<StorageClasses> | undefined = adapter.storageClasses;
  const rawClasses: unknown = storage?.classes;
  if (!Array.isArray(rawClasses) || rawClasses.length === 0) {
    push('core/decl/unknown-storage', 'storageClasses 为空：场景/存档/会话没有落点。');
  } else {
    const periods = new Set<StoragePeriod>();
    for (const spec of rawClasses as readonly (Partial<StorageClassSpec> | undefined)[]) {
      const period = spec?.period;
      if (spec === undefined || period === undefined || !(period in STORAGE_LABELS)) {
        push('core/decl/unknown-storage', 'storageClasses 含未知存储期。');
        continue;
      }
      const label = STORAGE_LABELS[period];
      if (periods.has(period)) push('core/decl/unknown-storage', `存储期“${label}”重复声明。`);
      periods.add(period);
      if (!isText(spec.engine)) push('core/decl/unknown-storage', `存储期“${label}”缺少引擎落点。`);
      if (!isText(spec.slotPrefix) || !spec.slotPrefix.startsWith('__')) {
        push(ADAPTER_VALIDATION_CODES.storage, `存储期“${label}”的槽前缀必须 "__" 开头（作者名字空间隔离）。`);
      }
      // 持久化口径：场景/会话不随存档，存档必须随存档
      if (period === 'save' ? spec.persisted !== true : spec.persisted === true) {
        push(
          ADAPTER_VALIDATION_CODES.storage,
          `存储期“${label}”的 persisted=${String(spec.persisted)} 与语义不符（存档=true，场景/会话=false）。`,
        );
      }
      const expectedInit: Record<StoragePeriod, StorageInit> = {
        scene: 'on-entry',
        save: 'on-new-game',
        session: 'on-process-start',
      };
      if (spec.init !== expectedInit[period]) {
        push('core/decl/unknown-storage', `存储期“${label}”的初始化时机应为 ${expectedInit[period]}。`);
      }
    }
    if (storage.slotStability !== 'project-stable' && storage.slotStability !== 'per-build') {
      push(ADAPTER_VALIDATION_CODES.storage, 'storageClasses.slotStability 非法。');
    }
  }

  /* --- encodingPolicy --- */
  const encoding: Partial<EncodingPolicy> | undefined = adapter.encodingPolicy;
  if (encoding === undefined) {
    push(ADAPTER_VALIDATION_CODES.encoding, 'adapter 缺少 encodingPolicy：Unit 编码/EOL 不能猜。');
  } else {
    if (!isOneOf(encoding.defaultEncoding, TEXT_ENCODINGS)) {
      push(ADAPTER_VALIDATION_CODES.encoding, 'encodingPolicy.defaultEncoding 非法。');
    }
    if (!Array.isArray(encoding.allowedEncodings) || encoding.allowedEncodings.length === 0) {
      push(ADAPTER_VALIDATION_CODES.encoding, 'encodingPolicy.allowedEncodings 为空。');
    } else if (
      isOneOf(encoding.defaultEncoding, TEXT_ENCODINGS) &&
      !encoding.allowedEncodings.includes(encoding.defaultEncoding)
    ) {
      push(ADAPTER_VALIDATION_CODES.encoding, '缺省编码不在 allowedEncodings 里。');
    }
    if (!isOneOf(encoding.eol, EOL_POLICIES)) {
      push(ADAPTER_VALIDATION_CODES.encoding, 'encodingPolicy.eol 非法（crlf / lf / mixed）。');
    }
    if (encoding.normalizeOnSave !== false) {
      push(ADAPTER_VALIDATION_CODES.encoding, 'encodingPolicy.normalizeOnSave 必须为 false：保存不得归一化。');
    }
    if (encoding.fingerprintMismatch !== 'error' && encoding.fingerprintMismatch !== 'warn') {
      push(ADAPTER_VALIDATION_CODES.encoding, 'encodingPolicy.fingerprintMismatch 非法。');
    }
  }

  /* --- layerPolicy --- */
  const layer: Partial<LayerPolicy> | undefined = adapter.layerPolicy;
  if (layer === undefined) {
    push(ADAPTER_VALIDATION_CODES.incomplete, 'adapter 缺少 layerPolicy：同名多定义无法判定。');
  } else {
    if (!isOneOf(layer.defaultMode, LAYER_MODES)) {
      push(ADAPTER_VALIDATION_CODES.incomplete, 'layerPolicy.defaultMode 非法（unique / shared-hook / overlay）。');
    }
    const targets = new Set<LayerTarget>();
    for (const rule of layer.rules ?? []) {
      if (!isOneOf(rule?.target, LAYER_TARGETS)) {
        push(ADAPTER_VALIDATION_CODES.incomplete, 'layerPolicy.rules 含未知 target。');
        continue;
      }
      if (targets.has(rule.target)) push(ADAPTER_VALIDATION_CODES.incomplete, `layerPolicy 对“${rule.target}”重复声明规则。`);
      else targets.add(rule.target);
      if (!isOneOf(rule.mode, LAYER_MODES)) {
        push(ADAPTER_VALIDATION_CODES.incomplete, `layerPolicy 规则“${rule.target}”的 mode 非法。`);
      }
    }
  }

  /* --- diagnosticNamespace --- */
  const namespace: Partial<DiagnosticNamespacePolicy> | undefined = adapter.diagnosticNamespace;
  if (namespace === undefined) {
    push(ADAPTER_VALIDATION_CODES.namespace, 'adapter 缺少 diagnosticNamespace：专属码必须带命名空间。');
  } else {
    const declared = new Set<AdapterDiagnosticNamespace>();
    if (!Array.isArray(namespace.namespaces) || namespace.namespaces.length === 0) {
      push(ADAPTER_VALIDATION_CODES.namespace, 'diagnosticNamespace.namespaces 为空。');
    } else {
      for (const name of namespace.namespaces) {
        if (!isOneOf(name, ADAPTER_NAMESPACES)) {
          push(ADAPTER_VALIDATION_CODES.namespace, `diagnosticNamespace 含未登记的命名空间“${String(name)}”。`);
        } else declared.add(name);
      }
    }
    if (Array.isArray(namespace.codes)) {
      for (const code of namespace.codes) {
        const prefix = typeof code === 'string' ? code.split('/', 1)[0] : '';
        if (typeof code !== 'string' || !code.includes('/') || !declared.has(prefix as AdapterDiagnosticNamespace)) {
          push(ADAPTER_VALIDATION_CODES.namespace, `adapter 专属码“${String(code)}”不在已声明的命名空间里。`);
        }
      }
    }
  }

  /* --- capability --- */
  const capability: Partial<Capability> | undefined = adapter.capability;
  if (capability === undefined) {
    push(ADAPTER_VALIDATION_CODES.capability, 'adapter 缺少 capability：安全边界必须显式声明。');
  } else {
    if (capability.executesCode === true && capability.integrity === 'none') {
      push(ADAPTER_VALIDATION_CODES.capability, 'capability.executesCode 为 true 时必须声明 integrity 校验。');
    }
    const access = capability.fileAccess;
    if (access !== 'none' && access !== 'read-project' && access !== 'read-write-approved') {
      push(ADAPTER_VALIDATION_CODES.capability, 'capability.fileAccess 非法。');
    }
    if (capability.networkAccess !== 'none' && capability.networkAccess !== 'declared') {
      push(ADAPTER_VALIDATION_CODES.capability, 'capability.networkAccess 非法。');
    }
    if (capability.writablePaths !== 'none' && capability.writablePaths !== 'user-approved') {
      push(ADAPTER_VALIDATION_CODES.capability, 'capability.writablePaths 非法。');
    }
    if (capability.integrity !== 'none' && capability.integrity !== 'checksum') {
      push(ADAPTER_VALIDATION_CODES.capability, 'capability.integrity 非法。');
    }
  }

  /* --- sourceMap --- */
  const sourceMap: Partial<SourceMapPolicy> | undefined = adapter.sourceMap;
  if (sourceMap === undefined) {
    push(ADAPTER_VALIDATION_CODES.sourceMap, 'adapter 缺少 sourceMap：回滚/预览无法定位。');
  } else {
    if (sourceMap.granularity !== 'line' && sourceMap.granularity !== 'line+column') {
      push(ADAPTER_VALIDATION_CODES.sourceMap, 'sourceMap.granularity 非法（至少 line）。');
    }
    if (sourceMap.mapsEventHeader !== true) {
      push(ADAPTER_VALIDATION_CODES.sourceMap, 'sourceMap.mapsEventHeader 必须为 true（包装/伴生函数映射事件头）。');
    }
  }

  /* --- conformanceSuite --- */
  const suite: Partial<ConformanceSuite> | undefined = adapter.conformanceSuite;
  if (suite === undefined || !Array.isArray(suite.cases) || suite.cases.length === 0) {
    push(ADAPTER_VALIDATION_CODES.conformance, 'adapter 缺少 conformanceSuite：至少要有 golden/differential/smoke/encoding。');
  } else {
    const required = new Set<ConformanceKind>();
    for (const kind of suite.required ?? []) {
      if (!isOneOf(kind, CONFORMANCE_KINDS)) {
        push(ADAPTER_VALIDATION_CODES.conformance, `conformanceSuite.required 含未知验收面“${String(kind)}”。`);
      } else required.add(kind);
    }
    for (const kind of CONFORMANCE_KINDS) {
      if (!required.has(kind)) {
        push(ADAPTER_VALIDATION_CODES.conformance, `conformanceSuite.required 缺少“${kind}”验收面。`);
      }
    }
    for (const item of suite.cases) {
      if (!isOneOf(item?.kind, CONFORMANCE_KINDS)) {
        push(ADAPTER_VALIDATION_CODES.conformance, 'conformanceSuite.cases 含未知验收面。');
        continue;
      }
      if (!isText(item.name) || !isText(item.fixture)) {
        push(ADAPTER_VALIDATION_CODES.conformance, `验收面“${item.kind}”的用例缺少名字/fixture 标识。`);
      }
      if (!required.has(item.kind)) {
        push(ADAPTER_VALIDATION_CODES.conformance, `验收用例“${item.name}”的 kind 不在 required 里。`);
      }
    }
  }

  return Object.freeze(out);
}

/* ============================== 13. 校验：用户源码侧查询 ============================== */

/** 事件名列表（诊断文案与补全共用） */
export function eventNames(adapter: GameAdapter): readonly string[] {
  return adapter.eventCatalog.events.map((spec) => spec.event);
}

/** 查找事件（adapter 事件表很小，线性扫描即可；热路径不在这里） */
export function findEvent(adapter: GameAdapter, event: string): EventSpec | undefined {
  return adapter.eventCatalog.events.find((spec) => spec.event === event);
}

/**
 * 未知事件 → `event/unknown` error；可用事件列在文案里（§3.5：列出当前 adapter 的
 * 事件，而不是内置枚举）。
 */
export function checkEvent(adapter: GameAdapter, event: string, span: KojoSpan | null = null): KojoDiagnostic | null {
  if (findEvent(adapter, event) !== undefined) return null;
  return diagnostic(
    ADAPTER_VALIDATION_CODES.eventUnknown,
    `当前 adapter 没有事件“${event}”。可用事件：${eventNames(adapter).join('、') || '(无)'}。`,
    span,
  );
}

/**
 * `# 机` / `@织` 的参数形状校验（个数、必填、int 形状）。
 * 未知事件只报一条 `event/unknown`，不再叠参数错误。
 */
export function checkEventArgs(
  adapter: GameAdapter,
  event: string,
  args: readonly string[],
  span: KojoSpan | null = null,
): readonly KojoDiagnostic[] {
  const spec = findEvent(adapter, event);
  if (spec === undefined) return Object.freeze([checkEvent(adapter, event, span)!]);

  const out: KojoDiagnostic[] = [];
  const required = spec.args.filter((arg) => arg.required).length;
  if (args.length < required) {
    out.push(
      diagnostic(
        ADAPTER_VALIDATION_CODES.eventArgument,
        `事件“${event}”需要至少 ${required} 个参数，实际 ${args.length} 个。`,
        span,
      ),
    );
  }
  if (args.length > spec.args.length) {
    out.push(
      diagnostic(
        ADAPTER_VALIDATION_CODES.eventArgument,
        `事件“${event}”最多 ${spec.args.length} 个参数，实际 ${args.length} 个。`,
        span,
      ),
    );
  }
  spec.args.forEach((argSpec, index) => {
    const value = args[index];
    if (value === undefined) return;
    if (argSpec.kind === 'int' && !/^-?(?:0|[1-9]\d*)$/.test(value)) {
      out.push(
        diagnostic(
          ADAPTER_VALIDATION_CODES.eventArgument,
          `事件“${event}”的参数 ${index + 1}（${argSpec.name}）必须是整数，实际“${value}”。`,
          span,
        ),
      );
    }
  });
  return Object.freeze(out);
}

/** `@织 之前/之后/接管` 是否可用：事件必须声明 `emuera-buckets` 优先级模型（§8.6） */
export function checkWeavePriority(
  adapter: GameAdapter,
  event: string,
  span: KojoSpan | null = null,
): KojoDiagnostic | null {
  const spec = findEvent(adapter, event);
  if (spec === undefined) return checkEvent(adapter, event, span);
  if (spec.priority === 'emuera-buckets') return null;
  return diagnostic(
    'core/weave/unsupported',
    `事件“${event}”没有声明 emuera-buckets 优先级模型：之前 / 之后 / 接管 不可用。`,
    span,
  );
}

/** 说话人是否可解析：代词 / closed 名表 / project 表（后者交给项目级分析，SDK 不猜） */
export function checkSpeaker(adapter: GameAdapter, speaker: string, span: KojoSpan | null = null): KojoDiagnostic | null {
  const symbols = adapter.domainSymbols;
  if (symbols.pronouns.some((symbol) => symbol.pronoun === speaker)) return null;
  const source = symbols.speakers;
  if (source.kind === 'project') return null;
  if (source.names.includes(speaker)) return null;
  return diagnostic(
    'core/narrative/unknown-speaker',
    `说话人“${speaker}”解析不到：当前 adapter 的 domainSymbols 没有声明该角色符号。`,
    span,
  );
}

/**
 * 查一条域符号变量（additive 面；旧 adapter 没声明 ⇒ 恒 `undefined`——**不猜、不造空表**）。
 *
 * 单一查询点：sema 的名字解析与 `checkSymbol` 都走它，避免两处各自 `.find` 出两套口径。
 */
export function findDomainVariable(adapter: GameAdapter, name: string): DomainVariableSymbol | undefined {
  return adapter.domainSymbols.variables?.find((item) => item.name === name);
}

/** 域符号是否可解析（代词 / 角色属性 / 名字函数 / 域符号变量）；`unknown = raw` 时放行 */
export function checkSymbol(adapter: GameAdapter, symbol: string, span: KojoSpan | null = null): KojoDiagnostic | null {
  const symbols = adapter.domainSymbols;
  if (symbols.pronouns.some((item) => item.pronoun === symbol)) return null;
  if (symbols.attributes.some((item) => item.name === symbol)) return null;
  if (symbols.nameFunctions.some((item) => item.name === symbol)) return null;
  if (symbols.variables?.some((item) => item.name === symbol) === true) return null;
  if (symbols.unknown === 'raw') return null;
  return diagnostic(
    'core/expr/unknown-symbol',
    `域符号“${symbol}”未声明：当前 adapter 的 domainSymbols 里没有它。`,
    span,
  );
}

/** 演出面是否声明；未声明 → 该面的 core 码（四项一律 error；`选项` 的 pending warning 只来自 lowering） */
export function checkPresentation(
  adapter: GameAdapter,
  feature: PresentationFeature,
  span: KojoSpan | null = null,
): KojoDiagnostic | null {
  if (adapter.presentation[feature] !== null) return null;
  const label = PRESENTATION_LABELS[feature];
  return diagnostic(
    PRESENTATION_UNSUPPORTED_CODES[feature],
    `当前 adapter 没有声明“${label}”演出（presentation.${feature} = null）。`,
    span,
  );
}

const PRESENTATION_LABELS: Readonly<Record<PresentationFeature, string>> = Object.freeze({
  heart: '心形',
  color: '着色',
  face: '颜绘',
  options: '选项',
});

/**
 * programFeatures 细粒度开关；关闭 = error，并指出可替代写法（§10.10）。
 *
 * K2-FEATURE-GATE-UNIFY：**委托统一入口**（`lower/feature-gate.ts::checkFeature`）。
 * 查询/补全面手上没有 backend（落点面），所以按"只有声明面"解析——
 * 与主链同一个判定函数、同一份码、同一份文案（不再另写一套）。
 */
export function checkProgramFeature(
  adapter: GameAdapter,
  feature: ProgramFeatureKey,
  span: KojoSpan | null = null,
): KojoDiagnostic | null {
  return checkFeature(resolveProgramFeatures(adapter, null), feature, span).diagnostic;
}

/** 存储期是否声明；未声明 = error（不能猜落点） */
export function checkStoragePeriod(
  adapter: GameAdapter,
  period: StoragePeriod,
  span: KojoSpan | null = null,
): KojoDiagnostic | null {
  const label = STORAGE_LABELS[period];
  if (adapter.storageClasses.classes.some((spec) => spec.period === period)) return null;
  return diagnostic(
    'core/decl/unknown-storage',
    `存储期“${label}”未声明。当前 adapter 的 storageClasses 没有“${label}”；请换存储期或补 adapter 契约。`,
    span,
  );
}

/* ============================== 14. 深冻结 ============================== */

/**
 * 深冻结 adapter（只走对象与数组；契约里没有 Map/Set，故按键递归即可）。
 * adapter 模块装载时调一次，之后查表零构造开销；已冻结的子树直接跳过。
 */
export function freezeAdapter<T extends GameAdapter>(adapter: T): T {
  return deepFreeze(adapter);
}

/** 通用深冻结：adapter 的附带数据（如 emit backend 的常量对象）也可复用同一口径 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
