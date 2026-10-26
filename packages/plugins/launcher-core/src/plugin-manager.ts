/**
 * 游戏插件门禁（契约 §6.7 `PluginManager`；规格 §10.1 / §10.2 / §10.3 / §10.4；ADR-0009）。
 *
 * ## 一条落盘管线、两个入口
 *
 * 插件与内容包共用**宿主**的同一条写盘管线（`launcher_content_plan / apply / uninstall /
 * set_enabled / set_order / diagnose`，§7.2 明写「游戏插件复用同一组宿主命令」）。本层不碰盘：
 * 解包、暂存、写临时 + rename、备份、逆序回滚、`ownership.json` 全在宿主。
 *
 * 本层的活是**逻辑变更门禁**——内容包没有的那五道闸（§10.4）：
 * 1. 能力解析：`PluginCapability` 与本游戏 `GamePluginRules.roots` 的支持面比对；
 * 2. 版本兼容：adapter 的 `isCompatible` 优先，否则只按清单声明判，并用 `checkedBy` 说清是谁判的；
 * 3. 函数级冲突：adapter 的 `analyzeFunctions` 产物按 `normalizedName` 与既有索引比对，
 *    「有意重复」只认 adapter 的 `conventionPolicy`（与 `erb.duplicate-function` 同一判据）；
 * 4. 存档影响：清单缺省取 `pluginRules.saveImpact`；非 `none` ⇒ 装前备份，备份不成就拒；
 * 5. 风险分级 + 信任：只由「清单能力 + 实际落点」推导，`unknown` 必须逐项确认。
 *
 * ## 从 `ContentManager` 复用了哪些、为什么
 *
 * - `list` / `uninstall` / `setEnabled` / `setOrder` / `diagnose` **整条委托**内容包管线：
 *   卸载时的「只撤本包独占的 ownership 记录」、启停/卸载前的停游戏顺序、排序的
 *   「只接受已装 id 的排列」、宿主诊断的透传——这些与包类型无关，重写一遍只会产生第二套口径；
 * - **不复用** `planInstall` / `applyInstall`：`ContentManagerImpl` 对 `kind === 'plugin'`
 *   的包在预检处显式拒绝（「需走插件安装通道」），且它的 `planId → 计划` 台账是私有的；
 *   插件计划必须先在它之上叠五道闸，落盘才有意义。故本层自己持计划台账与任务认领
 *   （与 `ContentManagerImpl.runTask` 同构，**不重写任何写盘/回滚**），宿主的 `contentApply`
 *   仍是唯一落盘入口。
 *
 * ## 与内容管线共用**同一把**每实例单飞锁（`instance-lock.ts`）
 *
 * 两边的门禁不同、落点相同（同一棵游戏根、同一份 `ownership.json`），故「同一实例只许
 * 一条写盘链」的判据只有一份：组合根把同一个 `InstanceLock` 同时交给本层与内容管线。
 * 本层自己**不持锁表**；`uninstall` / `setEnabled` / `setOrder` 三条委托路径也不在本层
 * 抢票——被委托的内容管线在它自己的 `runTask` / `setOrder` 里落票，一张票覆盖整段临界区。
 * 进程侧的单实例锁（「能不能起进程」）**不并入**，边界见 `instance-lock.ts` 文件头。
 *
 * ## 已知契约缺口（已逐条上报，未擅自扩 `plugin-api`）
 *
 * 1. `PluginManager` 契约**没有** `trust` / `untrust` / `compatibility`：本层作为实现类的
 *    加性方法提供（`PluginManager` 的结构未变，旧消费方零改动）；
 * 2. `PluginTrust` 没有 `approvedBy`：本层的记录类型加性补上（值恒 `'native-dialog'`，
 *    弹框在宿主/应用侧发生，本层只记「已批/未批」），`state` 恒 `'unverified'`——
 *    首版没有验签，不拿 `verified` 假装有；
 * 3. `PluginCompatibilityContext.gameVersion` 无从取得：`LauncherInstance` 没有游戏版本字段，
 *    宿主也没有对应命令。本层留 `gameVersionOf` 注入口（组合根可接 adapter 的工程载荷），
 *    缺席即 `null` 并在 `reasons` 里说明「未校验」，不猜版本；
 * 4. `pluginRules` **没有**能力支持面清单：支持面由 `pluginRules.roots[].kind` 推导
 *    （见 `CAPABILITY_ROOT_KINDS`）。能力无处落地时没有专用错误码，落
 *    `LAUNCHER_PLATFORM_UNSUPPORTED`（「当前平台未提供该能力」）；
 * 5. 函数级 `skip` 无法只切一个函数：宿主按「整份文件」写/跳过，所以函数冲突选 `skip`
 *    会**把该函数所在文件整份跳过**（登记里逐条留痕并写进任务结果）；
 *    `replace` 的前置备份也只能复用宿主的文件级快照（旧定义所在文件若是别的插件的，
 *    本层无法单独备份它）。两处都如实登记，不做假承诺；
 * 6. 插件状态（risk / order / trust / functionIndex）目前只活在本层内存：宿主没有
 *    `launcher_plugin_state_*` 命令，重启后按 `content.list` 重建，`risk` 退化为
 *    `unknown`（按最高风险展示，宁可多问一次），并如实显示为未受信。
 */

import type {
  ConflictResolution,
  ContentConflict,
  ContentFileRef,
  ContentManager,
  ContentPackManifest,
  ContentRootSpec,
  ConventionPolicy,
  FunctionConflict,
  GamePluginRules,
  InstalledContent,
  InstalledPlugin,
  InstallPlanOptions,
  LauncherErrorCode,
  LauncherInstance,
  LauncherTask,
  PluginApplyOptions,
  PluginCapability,
  PluginCompatibility,
  PluginCompatibilityContext,
  PluginConflictResolution,
  PluginDiagnosis,
  PluginInstallPlan,
  PluginManager,
  PluginRisk,
  PluginTrust,
  ProcessSupervisor,
  SaveBackup,
  SaveBackupRequest,
  SaveManager,
  ScriptFunctionDefinition,
  TaskCenter,
  ZipContractLimits,
} from '@kojo/plugin-api';
import { ZIP_EXTRACT_LIMITS, zipEntryContractProblem } from '@kojo/plugin-api';
import type { ZipContractCode } from '@kojo/plugin-api';
import type { HostContentConflict, HostContentPlan } from './content-manager';
import type { LauncherHostBridge } from './host';
import { launcherError, normalizeLauncherError } from './errors';
import { InstanceLock } from './instance-lock';
import { isTerminalTaskState } from './task-center';

/* ══════════════════════════════════════════════════════════════════════════════
 * 宿主命令面（插件与内容包共用同一组命令；插件多要两样东西，见缺口 5/6）
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 插件的**暂存视图**：函数级分析必须看见解包后的 payload，而本层不拼绝对路径
 * （§7.1 的路径纪律），只能由宿主把它解包时的落点与逐文件暂存路径交上来。
 *
 * 缺席 = 宿主还没接通这一格：本层**拒绝**预检（`LAUNCHER_PLATFORM_UNSUPPORTED`），
 * 而不是把 `functionConflicts` 交成空数组假装「没有冲突」。
 */
export interface HostPluginStaging {
  /** 暂存根（宿主解包落点；绝对路径，只交给 adapter 的回调，本层不解释） */
  readonly dir: string;
  /** `rootId/path`（清单口径）→ 暂存目录内的相对路径（posix） */
  readonly files: Readonly<Record<string, string>>;
}

/** 宿主插件计划：文件级计划（`HostContentPlan`）+ 暂存视图 */
export interface HostPluginPlan extends HostContentPlan {
  readonly staging?: HostPluginStaging;
}

/**
 * 本层用到的两条宿主命令（其余走 `ContentManager`，见文件头）。
 *
 * 这两条在契约 `LauncherHostBridge` 上是**可选**的（§7.4 的 P1），本接口只是把它们收成
 * 非可选供调用点探测；与契约的唯一差别是 `contentPlan` 的返回多一层插件暂存视图
 * （`HostPluginPlan.staging`，宿主只对插件包报），所以仍是本包自己的窄化形状——缺席即如实拒绝。
 */
export interface PluginHostCommands {
  contentPlan(
    instanceId: string,
    archivePath: string,
    opts: { readonly limits: ZipContractLimits },
  ): Promise<HostPluginPlan>;
  contentApply(planId: string, resolutions?: readonly ConflictResolution[]): Promise<LauncherTask>;
}

/** 方法名 → 宿主命令名（报缺失时点名，不让用户对着「未提供该能力」猜） */
const PLUGIN_HOST_COMMAND_NAMES: Readonly<Record<keyof PluginHostCommands, string>> = {
  contentPlan: 'launcher_content_plan',
  contentApply: 'launcher_content_apply',
};

/* ══════════════════════════════════════════════════════════════════════════════
 * 报告与状态形状（契约形状 + 加性字段）
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 插件诊断报告。`issues` 严格守契约码表（消费方的 `switch` 不会撞到未知码）；
 * `warnings` / `untrusted` / `checkedAt` 是**加性**附加（结构上仍是 `PluginDiagnosis`）：
 * 契约没有「未受信」这一档码（那是信任链的事，不是文件问题），只能放到机器可判的并列字段里。
 */
export interface PluginDiagnosisReport extends PluginDiagnosis {
  /** 人话汇总（一条 issue 一行；UI 可直接贴） */
  readonly warnings: readonly string[];
  /** 风险无法归类且未获确认的插件 id（装前必须逐项确认） */
  readonly untrusted: readonly string[];
  readonly checkedAt: string;
}

/** 信任记录：`approvedBy` 只有「原生确认框」这一条来源（契约缺口 2） */
export interface PluginTrustRecord extends PluginTrust {
  readonly approvedBy?: 'native-dialog';
  readonly approvedAt?: string;
}

/** 已装插件的一条（`trust` 收窄到本层记录，UI 才看得见「谁批的、什么时候批的」） */
export interface PluginInstalledView extends InstalledPlugin {
  readonly trust: PluginTrustRecord;
  /** 装 / 升级时逐条落账的冲突决议（「我当时同意过什么」的唯一可查记录） */
  readonly decisions: readonly PluginDecision[];
}

/** 一条冲突决议的落账（谁在哪一步被怎么处理；升级时保留历史） */
export interface PluginDecision {
  readonly kind: 'file' | 'function';
  readonly action: 'skip' | 'overwrite' | 'replace';
  readonly rootId?: string;
  readonly path?: string;
  readonly functionName?: string;
  readonly at: string;
}

/** 本层记住的已装插件（契约 `InstalledPlugin` 的本地真相：宿主只给文件与 ownership） */
interface PluginState {
  readonly manifest: ContentPackManifest;
  enabled: boolean;
  order: number;
  readonly risk: PluginRisk;
  readonly requiresRestart: boolean;
  readonly status: 'ok' | 'incompatible';
  readonly installedAt: string;
  readonly sourceProjectId: string | null;
  readonly saveImpact: 'none' | 'possible' | 'unknown';
  /** 装/升级时算好的函数索引（路径相对 `gameRoot`；诊断与启用前复检用它） */
  readonly functionIndex: readonly ScriptFunctionDefinition[];
  readonly decisions: readonly PluginDecision[];
}

/** 用户对某个插件 id 的批准（原生确认框返回之后才写；含批时的版本） */
interface Approval {
  readonly approvedAt: string;
  readonly approvedBy: 'native-dialog';
  readonly version: string | null;
}

interface PlanRecord {
  readonly instanceId: string;
  readonly plan: PluginInstallPlan;
  /** 函数归一化名 → 落点文件（函数级 `skip` 只能整份文件跳过，见缺口 5） */
  readonly functionTargets: ReadonlyMap<string, ContentFileRef>;
  /** 计划里的函数索引（落盘成功后登记；路径已换算成 `gameRoot` 相对） */
  readonly functionIndex: readonly ScriptFunctionDefinition[];
  /** 兼容性不满足 ⇒ apply 需显式 `allowIncompatible` */
  readonly compatible: boolean;
  /** 风险无法归类 ⇒ apply 需已获批准 */
  readonly trustRequired: boolean;
}

interface Decisions {
  /** 交给宿主的文件级决议（函数级 `skip` 折成该文件的 `skip`） */
  readonly hostResolutions: readonly ConflictResolution[];
  readonly ledger: readonly PluginDecision[];
}

/** 契约诊断码表里的一条（映射落点；本层不改写码值） */
type PluginIssue = PluginDiagnosis['issues'][number];

/* ══════════════════════════════════════════════════════════════════════════════
 * 能力面 / 风险分级（纯数据；判定规则见 ADR-0009 §5）
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 契约的五种能力（运行期集合：清单来自不可信的包，必须逐值核） */
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set<PluginCapability>([
  'add-content',
  'override-functions',
  'add-commands',
  'modify-data',
  'replace-resources',
]);

/** 清单缺字段时的缺省（契约 §5.4：最保守的一档） */
const DEFAULT_CAPABILITIES: readonly PluginCapability[] = ['add-content'];

/**
 * 能力 → 需要的内容根类别。
 *
 * `plugin` 根是 adapter 声明的**插件专用根**：包里放脚本 / 数据 / 资源都由 adapter 决定，
 * 本层不认识根内结构，故对任何一种能力它都算「可以落地」（否则只有单一插件根的游戏
 * 会被判成不支持任何能力）。判定只认 adapter 声明的字段，不认游戏名。
 */
const CAPABILITY_ROOT_KINDS: Readonly<Record<PluginCapability, readonly ContentRootSpec['kind'][]>> = {
  'add-content': ['script', 'data', 'resource', 'plugin'],
  'add-commands': ['script', 'plugin'],
  'override-functions': ['script', 'plugin'],
  'modify-data': ['data', 'plugin'],
  'replace-resources': ['resource', 'plugin'],
};

/** 能力 → 风险档（1 = content-only，2 = extends-logic，3 = overrides-logic） */
const CAPABILITY_TIER: Readonly<Record<PluginCapability, 1 | 2 | 3>> = {
  'add-content': 1,
  'add-commands': 2,
  'modify-data': 2,
  'override-functions': 3,
  'replace-resources': 3,
};

const TIER_RISK: readonly PluginRisk[] = ['content-only', 'content-only', 'extends-logic', 'overrides-logic'];

/**
 * 「有意重复」的判据 id：与 `convention-linter` 的 `erb.duplicate-function` **同一字符串**
 * （ADR-0009 §3 要求同源；跨插件 import 被审计 C 项禁止，故此处只留字面量，不另立宽容表）。
 */
const DUPLICATE_FUNCTION_RULE_ID = 'erb.duplicate-function';

/** 内容侧会把「启用顺序异常」折进 `conflict`（见 `content-manager.ts` 缺口 2），这里按同一前缀剥回 */
const CONTENT_ORDER_MESSAGE_PREFIX = '启用顺序异常';

const NOT_RUNNING_CODES: ReadonlySet<LauncherErrorCode> = new Set<LauncherErrorCode>([
  'LAUNCHER_INSTANCE_NOT_FOUND',
  'LAUNCHER_INSTANCE_NOT_READY',
]);

const ESCAPE_PATH_CODES: ReadonlySet<ZipContractCode> = new Set<ZipContractCode>([
  'path-dotdot',
  'path-absolute',
  'path-drive',
]);

/* ══════════════════════════════════════════════════════════════════════════════
 * 依赖面
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 任务中心的写入面（`TaskCenterImpl` 结构上满足；只声明用到的三件） */
export interface PluginTaskSink extends TaskCenter {
  adopt(
    task: LauncherTask,
    channel?: { readonly onCancel?: () => void | Promise<void> },
  ): LauncherTask;
}

/**
 * 存档备份能力（§10.4 的存档闸）。`SaveManagerImpl` 结构上满足；
 * 缺席 = 本装配没有备份通道 ⇒ 任何 `saveImpact != 'none'` 的插件在**预检**阶段就被拒，
 * 不制造「先装上再说」的路径。
 */
export type PluginSaveGuard = Pick<SaveManager, 'backup' | 'backups'>;

export interface PluginManagerOptions {
  /** 内容包管线（`list` / `uninstall` / `setEnabled` / `setOrder` / `diagnose` 全部委托它） */
  readonly content: ContentManager;
  /** 宿主桥：只探 `launcher_content_plan` / `launcher_content_apply` 两条（其余在上面那条线上） */
  readonly host: LauncherHostBridge;
  readonly tasks: PluginTaskSink;
  readonly processes: ProcessSupervisor;
  /** 取实例快照（组合根接实例库；取不到 = `LAUNCHER_INSTANCE_NOT_FOUND`） */
  readonly getInstance: (instanceId: string) => Promise<LauncherInstance | null>;
  /** adapter 的插件规则；缺席 = 该游戏禁用插件（内容包仍可用） */
  readonly pluginRulesOf?: (adapterId: string) => GamePluginRules | undefined;
  /** adapter 的约定静默策略（「有意重复」的唯一判据来源；缺席 = 一律按真冲突算） */
  readonly conventionPolicyOf?: (adapterId: string) => ConventionPolicy | undefined;
  /** 基础游戏函数索引（可选注入口；缺席时函数冲突只比对已装插件，并写进 warnings） */
  readonly baseFunctionIndexOf?: (
    instance: LauncherInstance,
  ) => Promise<readonly ScriptFunctionDefinition[]>;
  /** 实例的游戏版本（契约缺口 3；缺席 = `null`，声明版本只展示不拦） */
  readonly gameVersionOf?: (
    instance: LauncherInstance,
  ) => Promise<string | null> | string | null;
  /** 存档备份通道（缺席 = 存档影响非 none 的插件一律拒装） */
  readonly saves?: PluginSaveGuard;
  /** 打开插件源码项目（工作区）；缺席 = `openSource` 在有源码时如实拒绝 */
  readonly openProject?: (projectId: string) => Promise<void>;
  /**
   * 每实例写盘单飞锁：**与 `ContentManagerImpl` 必须是同一个实例**（组合根只建一把）。
   * 这里没有缺省值：本层自建一把就等于「两把锁」，那正是本批要消掉的缺口。
   */
  readonly lock: InstanceLock;
  readonly now?: () => number;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 实现
 * ══════════════════════════════════════════════════════════════════════════════ */

export class PluginManagerImpl implements PluginManager {
  private readonly content: ContentManager;
  private readonly host: LauncherHostBridge;
  private readonly tasks: PluginTaskSink;
  private readonly processes: ProcessSupervisor;
  private readonly getInstance: (instanceId: string) => Promise<LauncherInstance | null>;
  private readonly pluginRulesOf: (adapterId: string) => GamePluginRules | undefined;
  private readonly conventionPolicyOf: (adapterId: string) => ConventionPolicy | undefined;
  private readonly baseFunctionIndexOf:
    | ((instance: LauncherInstance) => Promise<readonly ScriptFunctionDefinition[]>)
    | undefined;
  private readonly gameVersionOf:
    | ((instance: LauncherInstance) => Promise<string | null> | string | null)
    | undefined;
  private readonly saves: PluginSaveGuard | undefined;
  private readonly openProject: ((projectId: string) => Promise<void>) | undefined;
  private readonly now: () => number;

  private readonly plans = new Map<string, PlanRecord>();
  /** 每实例单飞（与内容管线同一把 `InstanceLock`，本层不持锁表） */
  private readonly lock: InstanceLock;
  /** instance → pluginId → 本地真相 */
  private readonly states = new Map<string, Map<string, PluginState>>();
  /** instance → pluginId → 用户批准记录 */
  private readonly approvals = new Map<string, Map<string, Approval>>();
  /** 异步终态的一次性订阅（`dispose` 时一并撤） */
  private readonly watchers = new Set<() => void>();

  constructor(options: PluginManagerOptions) {
    this.content = options.content;
    this.host = options.host;
    this.tasks = options.tasks;
    this.processes = options.processes;
    this.getInstance = options.getInstance;
    this.pluginRulesOf = options.pluginRulesOf ?? (() => undefined);
    this.conventionPolicyOf = options.conventionPolicyOf ?? (() => undefined);
    this.baseFunctionIndexOf = options.baseFunctionIndexOf;
    this.gameVersionOf = options.gameVersionOf;
    this.saves = options.saves;
    this.openProject = options.openProject;
    this.lock = options.lock;
    this.now = options.now ?? Date.now;
  }

  /* ------------------------------ 查询面 ------------------------------ */

  /**
   * 已装插件。宿主只报文件与 ownership，`risk` / `trust` / `sourceProjectId` 是本层的账；
   * 账上没有（重启后 / 用户手放进去的）⇒ `risk='unknown'`（按最高风险展示）+ 未受信，
   * 不做「不知道就当安全」的处理。
   */
  async list(instanceId: string): Promise<readonly PluginInstalledView[]> {
    // 先探能力再问实例：宿主根本没有内容命令时，「实例不存在」是误导性结论（与内容管线同口径）
    const packs = await this.listInstalled(instanceId);
    const instance = await this.requireInstance(instanceId);
    const rules = this.pluginRulesOf(instance.adapterId);
    return packs.map((pack) => {
      const state = this.states.get(instanceId)?.get(pack.manifest.id);
      return {
        manifest: pack.manifest,
        // 启停与顺序以本层的账为准（它由委托内容管线写入、升级时保留）；账上没有（重启后）
        // 才回落到宿主的读数——两处由同一批命令维护，不会各说各话。
        enabled: state?.enabled ?? pack.enabled,
        order: state?.order ?? pack.order,
        installedAt: pack.installedAt,
        ownedFiles: pack.ownedFiles,
        risk: state?.risk ?? 'unknown',
        requiresRestart: state?.requiresRestart ?? rules?.requiresRestart ?? false,
        status: statusOf(pack, state),
        sourceProjectId: state?.sourceProjectId ?? null,
        trust: this.trustRecord(instanceId, pack.manifest.id, pack.manifest.author ?? null),
        decisions: state?.decisions ?? [],
      };
    });
  }

  /**
   * 兼容性判定（查询方法；契约没有，见缺口 1）。判定来源如实写进 `checkedBy`：
   * adapter 回调 / 仅清单声明 / 未判定——UI 据此决定要不要显示「未校验」。
   */
  async compatibility(
    instanceId: string,
    manifest: ContentPackManifest,
  ): Promise<PluginCompatibility> {
    const instance = await this.requireInstance(instanceId);
    return this.computeCompatibility(instance, manifest, await this.resolveGameVersion(instance));
  }

  /* ------------------------------ 预检 ------------------------------ */

  /**
   * 只读预检：宿主出**文件级**计划（解到暂存，不碰 `game/`），本层在其上叠五道闸。
   *
   * 拒绝面（按判定顺序，先便宜后昂贵）：
   * 宿主能力 → 实例存在 → 该游戏是否禁用插件 → 宿主文件级计划 → 包类型/游戏一致 →
   * 计划过期 → 限额 → 插件根 / shared 授权 / 路径闸 / 包内碰撞 → 计划与清单逐条对账 →
   * 能力支持面 → 依赖与声明冲突 → 函数级冲突（adapter 回调）→ 存档备份通道。
   *
   * 兼容性不满足与「风险无法归类」**不在预检抛错**：它们的解是 UI 上的两个显式勾选
   * （`allowIncompatible` / 原生确认框），预检只如实标出，由 `applyInstall` 判定。
   */
  async planInstall(
    instanceId: string,
    archivePath: string,
    opts?: InstallPlanOptions,
  ): Promise<PluginInstallPlan> {
    const planCommand = this.cmd('contentPlan');
    const instance = await this.requireInstance(instanceId);
    const rules = this.requireRules(instance);
    const limits = opts?.limits ?? ZIP_EXTRACT_LIMITS;

    let raw: HostPluginPlan;
    try {
      raw = await planCommand(instanceId, archivePath, { limits });
    } catch (err) {
      throw normalizeLauncherError(err, {
        fallbackCode: 'LAUNCHER_ARCHIVE_INVALID',
        detail: '插件包预检失败',
      });
    }

    const manifest = raw.manifest;
    if (!manifest || typeof manifest !== 'object') {
      throw launcherError('LAUNCHER_ARCHIVE_INVALID', { detail: '计划里没有清单' });
    }
    if (manifest.kind !== 'plugin') {
      throw launcherError('LAUNCHER_PLATFORM_UNSUPPORTED', {
        message: '该包不是游戏插件，请走内容包安装通道',
        detail: `${manifest.id} 的 kind 为 ${manifest.kind}`,
      });
    }
    if (manifest.gameId !== instance.gameId) {
      throw launcherError('LAUNCHER_ARCHIVE_INVALID', {
        message: '插件声明的游戏与实例不一致，已拒绝',
        detail: `包 ${manifest.gameId} / 实例 ${instance.gameId}`,
      });
    }
    this.assertPlanFresh(raw.expiresAt, raw.planId);

    const roots = resolvePluginRoots(instance, rules);
    gateFilePlan(instance, manifest, roots, limits);
    assertPlanMatchesManifest(raw);
    const conflicts = mapConflicts(raw.conflicts);
    const warnings: string[] = [...raw.warnings, ...caseCollisionWarnings(raw.conflicts)];
    const capabilities = resolveCapabilities(manifest.capabilities);
    assertCapabilitiesSupported(capabilities, rules);

    const gameVersion = await this.resolveGameVersion(instance);
    const compatibility = this.computeCompatibility(instance, manifest, gameVersion);
    if (!compatibility.ok) {
      warnings.push(
        `兼容性不满足：${compatibility.reasons.join('；')}（强制安装需显式勾选，插件会被标为「不兼容」）`,
      );
    } else if (compatibility.reasons.length > 0) {
      warnings.push(...compatibility.reasons);
    }

    const saveImpact = manifest.saveImpact ?? rules.saveImpact;
    // 风险只由「清单能力 + 实际**覆盖**的落点」推导：纯追加不升档（ADR-0009 §5）
    const overwrittenKinds = [...raw.overwrites, ...raw.conflicts].map(
      (ref) => roots.get(ref.rootId)?.pluginRoot.kind ?? 'script',
    );
    const riskResult = classifyRisk(manifest.capabilities, overwrittenKinds);
    if (riskResult.mismatch) {
      warnings.push(
        `声明与实际落点不一致：能力面声明为 ${capabilities.join('、')}，却覆盖了既有文件，` +
          `已按实际升为「${riskResult.risk}」`,
      );
    }
    if (riskResult.risk === 'unknown') {
      warnings.push('风险无法归类：按最高风险处理，安装前必须在系统确认框里逐项确认');
    }

    const installed = await this.listInstalled(instanceId);
    const missingRequirements = missingRequirementsOf(manifest, installed);
    assertNoDeclaredConflicts(manifest, installed);
    if (missingRequirements.length > 0) {
      warnings.push(`依赖未满足：${missingRequirements.join('、')}（安装会被拒绝，首版不自动下载依赖）`);
    }
    assertOrderSource(rules, warnings);

    const analyzed = await this.analyzeFunctionConflicts({
      instance,
      rules,
      raw,
      manifest,
      roots,
      conflicts,
      installed,
      warnings,
    });

    if (rules.requiresRestart) {
      warnings.push('安装 / 启停后需重启游戏才生效');
    }
    if (saveImpact !== 'none' && !this.saves) {
      throw launcherError('LAUNCHER_PLUGIN_SAVE_RISK', {
        message: '该插件可能影响存档，而当前装配没有存档备份能力，已拒绝预检',
        detail: `${manifest.id} ${manifest.version}：saveImpact=${saveImpact}`,
      });
    }
    if (saveImpact !== 'none') {
      warnings.push('该插件可能影响存档：安装前会自动备份存档（reason=pre-plugin），备份失败即中止');
    }
    if (riskResult.risk === 'unknown' && !this.isApproved(instanceId, manifest.id, manifest.version)) {
      warnings.push('该插件风险无法归类且尚未获得确认：安装会被拒绝，请先在确认框里批准');
    }

    const existing = installed.find((pack) => pack.manifest.id === manifest.id);
    if (existing) {
      warnings.push(
        `同 id 插件已安装 ${existing.manifest.version}，本次按升级处理（保留启停状态与加载顺序）`,
      );
    }

    const plan: PluginInstallPlan = {
      planId: raw.planId,
      mode: existing ? 'upgrade' : 'install',
      manifest,
      targets: raw.targets,
      additions: raw.additions,
      overwrites: raw.overwrites,
      conflicts,
      functionConflicts: analyzed.conflicts,
      missingRequirements,
      compatibility,
      saveImpact,
      risk: riskResult.risk,
      requiresRestart: rules.requiresRestart,
      warnings,
      expiresAt: raw.expiresAt,
    };

    this.prunePlans();
    this.plans.set(plan.planId, {
      instanceId,
      plan,
      functionTargets: analyzed.targets,
      functionIndex: analyzed.index,
      compatible: compatibility.ok,
      trustRequired: riskResult.risk === 'unknown',
    });
    return plan;
  }

  /* ------------------------------ 应用 ------------------------------ */

  /**
   * 真落盘。**只认未过期的计划**，**每实例单飞**；写盘委托宿主的 `contentApply`
   * （回滚是宿主的逆序逐文件核对，本层不重写），本层在此基础上登记插件状态。
   *
   * 门禁顺序：计划有效 → 实例在 → 单飞 → 兼容（需 `allowIncompatible`）→ 信任
   * （`unknown` 风险需已批准）→ 依赖 → 冲突逐条决断 → **先备份存档** → 停游戏 → 落盘。
   */
  async applyInstall(
    planId: string,
    resolutions?: readonly PluginConflictResolution[],
    opts?: PluginApplyOptions,
  ): Promise<LauncherTask> {
    const record = this.plans.get(planId);
    if (!record) {
      throw launcherError('LAUNCHER_INTERNAL', {
        message: '安装计划不存在或已失效，请重新预检',
        detail: `planId=${planId}`,
      });
    }
    this.assertPlanFresh(record.plan.expiresAt, planId);
    await this.requireInstance(record.instanceId);
    // 前段先看一眼（失败得快）；真正落票在 `runTask` 里、发宿主命令之前
    this.lock.assertFree(record.instanceId, 'plugin', { planId, action: '插件安装' });

    const plan = record.plan;
    if (!record.compatible && opts?.allowIncompatible !== true) {
      throw launcherError('LAUNCHER_PLUGIN_INCOMPATIBLE', {
        message: '插件与当前游戏版本或插件接口版本不兼容，已拒绝安装',
        detail: `${plan.manifest.id} ${plan.manifest.version}：${plan.compatibility.reasons.join('；')}`,
      });
    }
    if (record.trustRequired && !this.isApproved(record.instanceId, plan.manifest.id, plan.manifest.version)) {
      throw launcherError('LAUNCHER_PLUGIN_UNTRUSTED', {
        message: '该插件风险无法归类，尚未获得你的确认，已拒绝安装',
        detail: `${plan.manifest.id} ${plan.manifest.version}（risk=${plan.risk}）`,
      });
    }
    if (plan.missingRequirements.length > 0) {
      throw launcherError('LAUNCHER_PLUGIN_DEPENDENCY', {
        message: '插件声明的依赖未满足，已拒绝安装',
        detail: plan.missingRequirements.join('、'),
      });
    }

    const decisions = resolveConflictDecisions(plan, record.functionTargets, resolutions, this.now());
    const backupId = await this.ensureSaveBackup(record.instanceId, plan, opts);
    const apply = this.cmd('contentApply');

    const settled = await this.runTask({
      instanceId: record.instanceId,
      planId,
      fallbackCode: 'LAUNCHER_PLUGIN_CONFLICT',
      context: '插件安装失败',
      onSucceeded: () => this.registerInstalled(record, decisions, opts),
      start: async () => {
        // 计划一次性消费：宿主一旦被叫到，这条 planId 就不再可用（陈旧 applies 的唯一防线）
        this.plans.delete(planId);
        // §10.1：装插件前必须停游戏（改的是盘上文件，运行中的进程不该同时在被读）
        await this.stopGame(record.instanceId);
        return apply(planId, decisions.hostResolutions.length === 0 ? undefined : decisions.hostResolutions);
      },
    });
    if (settled.state !== 'succeeded') return settled;
    return {
      ...settled,
      result: {
        ...(settled.result ?? {}),
        pluginId: plan.manifest.id,
        risk: plan.risk,
        requiresRestart: plan.requiresRestart,
        decisions: decisions.ledger,
        ...(backupId === null ? {} : { backupId }),
      },
    };
  }

  /* ------------------------------ 卸载 / 启停 / 排序 ------------------------------ */

  /**
   * 卸载。整条委托内容包管线：停游戏、只撤**本包独占**的 ownership 记录、
   * 恢复 `original/` 里的基础文件快照（§10.3 的「不整目录删」也在那边的口径里）。
   *
   * 插件多一件：`saveImpact != 'none'` 时在任务结果里给出「旧存档可能读不出」的提示
   * ——**不删存档**（删的是玩家的进度，不是插件的数据）。
   */
  async uninstall(instanceId: string, pluginId: string): Promise<LauncherTask> {
    const instance = await this.requireInstance(instanceId);
    const packs = await this.listInstalled(instanceId);
    const target = packs.find((pack) => pack.manifest.id === pluginId);
    if (!target) {
      throw launcherError('LAUNCHER_CONTENT_BROKEN', {
        message: '该插件未安装，或安装记录已损坏',
        detail: `pluginId=${pluginId}`,
      });
    }
    // 本层不抢票：被委托的内容管线在它自己的 `runTask` 里落票（一张票覆盖整段临界区）
    this.lock.assertFree(instanceId, 'plugin', { action: '插件卸载' });
    const state = this.states.get(instanceId)?.get(pluginId);
    const rules = this.pluginRulesOf(instance.adapterId);
    const saveImpact =
      state?.saveImpact ?? target.manifest.saveImpact ?? rules?.saveImpact ?? 'unknown';

    let task: LauncherTask;
    try {
      task = await this.content.uninstall(instanceId, pluginId);
    } catch (err) {
      throw normalizeLauncherError(err, {
        fallbackCode: 'LAUNCHER_CONTENT_BROKEN',
        detail: '插件卸载失败',
      });
    }
    this.whenSucceeded(task, () => {
      this.states.get(instanceId)?.delete(pluginId);
    });

    if (saveImpact === 'none') return task;
    return {
      ...task,
      result: {
        ...(task.result ?? {}),
        pluginId,
        saveImpact,
        saveImpactHint:
          '该插件声明过存档影响：旧存档可能无法在无插件环境下读取（pre-plugin 备份已保留，未删除任何存档）',
      },
    };
  }

  /**
   * 启停。委托内容包管线（停游戏 → 应用/撤下同一事务）。
   * **启用前重跑冲突检查**：装的时候不冲突，不代表同时启用不冲突（§10.3）。
   */
  async setEnabled(instanceId: string, pluginId: string, enabled: boolean): Promise<LauncherTask> {
    const instance = await this.requireInstance(instanceId);
    const packs = await this.listInstalled(instanceId);
    const target = packs.find((pack) => pack.manifest.id === pluginId);
    if (!target) {
      throw launcherError('LAUNCHER_CONTENT_BROKEN', {
        message: '该插件未安装，无法切换启停',
        detail: `pluginId=${pluginId}`,
      });
    }
    if (enabled) await this.assertEnableConflicts(instance, packs, pluginId);

    // 同卸载：票由被委托的内容管线落，本层只做前置快判
    this.lock.assertFree(instanceId, 'plugin', { action: enabled ? '启用插件' : '停用插件' });
    let task: LauncherTask;
    try {
      task = await this.content.setEnabled(instanceId, pluginId, enabled);
    } catch (err) {
      throw normalizeLauncherError(err, {
        fallbackCode: 'LAUNCHER_CONTENT_BROKEN',
        detail: enabled ? '启用插件失败' : '停用插件失败',
      });
    }
    this.whenSucceeded(task, () => {
      const state = this.states.get(instanceId)?.get(pluginId);
      if (state) state.enabled = enabled;
    });
    return task;
  }

  /**
   * 调整插件加载顺序。
   *
   * 只接 `orderSource = 'manifest'` 的游戏：`directory` / `filename` 两条路线下顺序由
   * **游戏自己**扫描目录/文件名决定，启动器改一个数字只会产生「UI 说这个顺序、游戏不认」的假象。
   * 落账时把非插件包按当前相对次序排在前面、插件按用户给的次序接在后面
   * ——宿主看到的是**全量排列**（内容管线的口径），插件之间的相对次序原样保留。
   */
  async setOrder(instanceId: string, pluginIds: readonly string[]): Promise<void> {
    const instance = await this.requireInstance(instanceId);
    const rules = this.requireRules(instance);
    if (rules.orderSource !== 'manifest') {
      throw launcherError('LAUNCHER_PLATFORM_UNSUPPORTED', {
        message: '该游戏的插件顺序由游戏自己按目录 / 文件名扫描决定，启动器不接管',
        detail: `orderSource=${rules.orderSource}`,
      });
    }
    const packs = await this.content.list(instanceId);
    const plugins = packs.filter(isPluginPack);
    assertPermutation(pluginIds, plugins.map((pack) => pack.manifest.id));
    const others = packs
      .filter((pack) => !isPluginPack(pack))
      .sort((a, b) => a.order - b.order)
      .map((pack) => pack.manifest.id);

    // 票由被委托的内容管线 `setOrder` 落（那边与内容包排序是同一条临界区）
    this.lock.assertFree(instanceId, 'plugin', { action: '调整插件加载顺序' });
    try {
      await this.content.setOrder(instanceId, [...others, ...pluginIds]);
    } catch (err) {
      throw normalizeLauncherError(err, {
        fallbackCode: 'LAUNCHER_CONTENT_BROKEN',
        detail: '调整插件加载顺序失败',
      });
    }
    const map = this.states.get(instanceId);
    pluginIds.forEach((pluginId, index) => {
      const state = map?.get(pluginId);
      if (state) state.order = index;
    });
  }

  /* ------------------------------ 诊断 ------------------------------ */

  /**
   * 只读汇总。宿主报的「缺文件 / 哈希不符 / 文件冲突」经内容管线透传（那些码与内容侧同名）；
   * 本层补四件它看不见的事：函数覆盖（启用集内的同名定义）、兼容性、加载顺序、未受信。
   */
  async diagnose(instanceId: string): Promise<PluginDiagnosisReport> {
    const instance = await this.requireInstance(instanceId);
    const packs = await this.listInstalled(instanceId);
    const pluginIds = new Set(packs.map((pack) => pack.manifest.id));
    const rules = this.pluginRulesOf(instance.adapterId);
    const issues: PluginIssue[] = [];
    const seen = new Set<string>();
    const push = (issue: PluginIssue): void => {
      const key = `${issue.pluginId}|${issue.code}|${issue.path ?? ''}|${issue.functionName ?? ''}|${issue.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      issues.push(issue);
    };

    const base = await this.content.diagnose(instanceId);
    for (const issue of base.issues) {
      if (!pluginIds.has(issue.packId)) continue;
      // 内容侧把「启用顺序异常」折进 conflict（它没有 load-order 码）；这里按前缀剥回，
      // 顺序异常由下面的 load-order 一处统一报，避免同一件事两个码。
      if (issue.message.startsWith(CONTENT_ORDER_MESSAGE_PREFIX)) continue;
      push({
        pluginId: issue.packId,
        code: issue.code,
        ...(issue.path === undefined ? {} : { path: issue.path }),
        message: issue.message,
      });
    }

    const policy = this.conventionPolicyOf(instance.adapterId);
    const baseIndex = this.baseFunctionIndexOf ? await this.baseFunctionIndexOf(instance) : null;
    const enabled = packs.filter((pack) => pack.enabled);
    const index = new Map<string, { pluginId: string | null; def: ScriptFunctionDefinition }[]>();
    const add = (pluginId: string | null, def: ScriptFunctionDefinition): void => {
      const key = normalizeName(def.normalizedName);
      const group = index.get(key) ?? [];
      group.push({ pluginId, def });
      index.set(key, group);
    };
    for (const def of baseIndex ?? []) add(null, def);
    for (const pack of [...enabled].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))) {
      for (const def of this.states.get(instanceId)?.get(pack.manifest.id)?.functionIndex ?? []) {
        add(pack.manifest.id, def);
      }
    }
    for (const [normalizedName, group] of index) {
      if (group.length < 2) continue;
      if (matchSuppression(policy, normalizedName) !== undefined) continue;
      const [first, ...rest] = group;
      for (const entry of rest) {
        if (entry.pluginId === null) continue;
        push({
          pluginId: entry.pluginId,
          code: 'function-override',
          ...(entry.def.path === '' ? {} : { path: entry.def.path }),
          functionName: entry.def.name,
          message:
            `函数覆盖：「${entry.def.name}」同时定义于 ${first?.def.path ?? '基础游戏'} 第 ` +
            `${first?.def.line ?? 0} 行与本插件 ${entry.def.path} 第 ${entry.def.line} 行`,
        });
      }
    }

    const gameVersion = await this.resolveGameVersion(instance);
    for (const pack of packs) {
      const compatibility = this.computeCompatibility(instance, pack.manifest, gameVersion);
      if (compatibility.ok) continue;
      push({
        pluginId: pack.manifest.id,
        code: 'incompatible',
        message: `兼容性不满足：${compatibility.reasons.join('；')}`,
      });
    }

    if (rules && rules.orderSource === 'manifest') {
      const byOrder = new Map<number, string[]>();
      for (const pack of enabled) {
        const order = this.states.get(instanceId)?.get(pack.manifest.id)?.order ?? pack.order;
        if (!Number.isInteger(order) || order < 0) {
          push({
            pluginId: pack.manifest.id,
            code: 'load-order',
            message: `加载顺序异常：order 必须是 ≥0 的整数（当前 ${String(order)}）`,
          });
          continue;
        }
        const group = byOrder.get(order) ?? [];
        group.push(pack.manifest.id);
        byOrder.set(order, group);
      }
      for (const [order, ids] of byOrder) {
        if (ids.length < 2) continue;
        for (const id of ids) {
          push({
            pluginId: id,
            code: 'load-order',
            message: `加载顺序异常：与 ${ids.filter((other) => other !== id).join('、')} 并列在 ${order}，加载次序不确定`,
          });
        }
      }
    }

    const untrusted = packs
      .filter(
        (pack) =>
          (this.states.get(instanceId)?.get(pack.manifest.id)?.risk ?? 'unknown') === 'unknown' &&
          !this.isApproved(instanceId, pack.manifest.id, pack.manifest.version),
      )
      .map((pack) => pack.manifest.id);

    const sorted = [...issues].sort(
      (a, b) =>
        a.pluginId.localeCompare(b.pluginId) ||
        a.code.localeCompare(b.code) ||
        (a.path ?? '').localeCompare(b.path ?? '') ||
        a.message.localeCompare(b.message),
    );
    const warningLines = sorted.map((issue) => `${issue.pluginId}：${issue.message}`);
    const untrustedLines = untrusted.map(
      (id) => `${id}：风险无法归类且未获确认，下次安装 / 升级会被拒绝`,
    );
    const report: PluginDiagnosisReport = {
      instanceId,
      issues: sorted,
      warnings:
        warningLines.length + untrustedLines.length === 0
          ? []
          : [
              ...(warningLines.length === 0 ? [] : [`共检出 ${warningLines.length} 项插件问题`]),
              ...warningLines,
              ...untrustedLines,
            ],
      untrusted,
      checkedAt: new Date(this.now()).toISOString(),
    };
    return report;
  }

  /* ------------------------------ 信任 / 源码 ------------------------------ */

  /**
   * 记下「用户已在原生确认框里批准该插件」。
   *
   * **只接受原生确认框这一条来源**：本方法不接受 `approvedBy` 之类的参数，记录里的来源
   * 恒为 `'native-dialog'`（弹框在宿主/应用侧，返回值即授权）。`state` 恒 `'unverified'`
   * ——首版没有发布者验签，不拿 `verified` 假装有。
   *
   * `version` 给 `null` = 只认这个 id（不绑版本）；给具体版本 = 升级到别的版本要重新确认。
   */
  async trust(instanceId: string, pluginId: string, version?: string | null): Promise<PluginTrustRecord> {
    await this.requireInstance(instanceId);
    const installed = (await this.listInstalled(instanceId)).find(
      (pack) => pack.manifest.id === pluginId,
    );
    const map = this.approvals.get(instanceId) ?? new Map<string, Approval>();
    this.approvals.set(instanceId, map);
    map.set(pluginId, {
      approvedAt: new Date(this.now()).toISOString(),
      approvedBy: 'native-dialog',
      version: version === undefined ? (installed?.manifest.version ?? null) : version,
    });
    return this.trustRecord(instanceId, pluginId, installed?.manifest.author ?? null);
  }

  /** 撤销批准（不卸载、不删文件；下次「风险无法归类」的安装会再次被拒） */
  async untrust(instanceId: string, pluginId: string): Promise<void> {
    await this.requireInstance(instanceId);
    this.approvals.get(instanceId)?.delete(pluginId);
  }

  /**
   * 打开插件源码项目。`sourceProjectId === null` = 纯二进制/外部安装，**提示而不是报错**
   * （没有可开的源不是故障）；有源但组合根没接打开通道 ⇒ 如实拒绝并点名缺哪一段。
   */
  async openSource(instanceId: string, pluginId: string): Promise<void> {
    await this.requireInstance(instanceId);
    const sourceProjectId = this.states.get(instanceId)?.get(pluginId)?.sourceProjectId ?? null;
    if (sourceProjectId === null) return;
    if (!this.openProject) {
      throw launcherError('LAUNCHER_PLATFORM_UNSUPPORTED', {
        message: '当前宿主未提供打开插件源码项目的通道',
        detail: `插件 ${pluginId} 的来源项目 ${sourceProjectId} 无法在工作区里打开`,
      });
    }
    await this.openProject(sourceProjectId);
  }

  /**
   * 断订阅（任务快照保留，供 UI 收尾）；计划台账一并清空。
   * 单飞锁**不在这里 dispose**：它与内容管线共用、归组合根所有（`index.ts` 的 shutdown）。
   */
  dispose(): void {
    for (const off of [...this.watchers]) off();
    this.watchers.clear();
    this.plans.clear();
  }

  /* ------------------------------ 内部：计划裁决 ------------------------------ */

  /** 兼容性判定：adapter 回调优先，其次只按清单声明（`checkedBy` 说清是谁判的） */
  private computeCompatibility(
    instance: LauncherInstance,
    manifest: ContentPackManifest,
    gameVersion: string | null,
  ): PluginCompatibility {
    const rules = this.pluginRulesOf(instance.adapterId);
    const requiredGameVersion = manifest.gameVersion ?? null;
    const apiVersion = manifest.apiVersion ?? null;
    const reasons: string[] = [];

    if (rules?.isCompatible) {
      const ctx: PluginCompatibilityContext = {
        gameVersion,
        pluginGameVersion: requiredGameVersion,
        pluginApiVersion: apiVersion,
        gameId: instance.gameId,
      };
      let ok: boolean;
      try {
        ok = rules.isCompatible(ctx);
      } catch (err) {
        throw launcherError('LAUNCHER_PLUGIN_INCOMPATIBLE', {
          message: '插件兼容性判定失败，已中止',
          detail: errText(err),
        });
      }
      if (!ok) {
        reasons.push(
          `适配器判定不兼容（游戏版本 ${gameVersion ?? '未知'} / 插件要求 ${requiredGameVersion ?? '未声明'} / ` +
            `接口版本 ${apiVersion ?? '未声明'}）`,
        );
      }
      return {
        ok,
        gameVersion,
        requiredGameVersion,
        apiVersion,
        checkedBy: 'adapter',
        reasons,
      };
    }

    if (requiredGameVersion === null && apiVersion === null) {
      return {
        ok: true,
        gameVersion,
        requiredGameVersion: null,
        apiVersion: null,
        checkedBy: 'none',
        reasons,
      };
    }

    let ok = true;
    if (requiredGameVersion !== null) {
      if (gameVersion === null) {
        reasons.push('实例未记录游戏版本，插件声明的游戏版本未校验');
      } else if (requiredGameVersion !== '*' && requiredGameVersion !== gameVersion) {
        ok = false;
        reasons.push(`游戏版本 ${gameVersion} 与插件要求的 ${requiredGameVersion} 不一致`);
      }
    }
    if (apiVersion !== null) {
      reasons.push(`插件接口版本 ${apiVersion} 未经适配器校验（本游戏未提供判定回调）`);
    }
    return { ok, gameVersion, requiredGameVersion, apiVersion, checkedBy: 'declared', reasons };
  }

  /**
   * 函数级冲突：incoming 由 adapter 对**暂存 payload** 解析，existing 来自「已装插件的
   * 函数索引 + 可选的基础游戏索引」。
   *
   * 三条不变量：
   * - 比对键只用 `normalizedName`（大小写无关引擎拿原样名比会漏报）；
   * - 「有意重复」只认 adapter 的 `conventionPolicy`，命中即收敛并**留一行汇总**；
   * - 解析失败必须抛错——空数组等于「没有冲突」，那是最危险的假绿。
   */
  private async analyzeFunctionConflicts(input: {
    readonly instance: LauncherInstance;
    readonly rules: GamePluginRules;
    readonly raw: HostPluginPlan;
    readonly manifest: ContentPackManifest;
    readonly roots: ReadonlyMap<string, PluginRoot>;
    readonly conflicts: readonly ContentConflict[];
    readonly installed: readonly InstalledContent[];
    readonly warnings: string[];
  }): Promise<{
    readonly conflicts: readonly FunctionConflict[];
    readonly targets: ReadonlyMap<string, ContentFileRef>;
    readonly index: readonly ScriptFunctionDefinition[];
  }> {
    const { instance, rules, raw, manifest, roots, conflicts, installed, warnings } = input;
    const empty = { conflicts: [] as readonly FunctionConflict[], targets: new Map<string, ContentFileRef>(), index: [] as readonly ScriptFunctionDefinition[] };
    const analyze = rules.analyzeFunctions;
    const scriptFiles = manifest.files.filter((file) => {
      const kind = roots.get(file.rootId)?.pluginRoot.kind;
      return kind === 'script' || kind === 'plugin';
    });
    if (scriptFiles.length === 0) return empty;
    if (!analyze) {
      warnings.push('本游戏不做函数级冲突分析（adapter 未提供 analyzeFunctions）：本次只做了文件级比对');
      return empty;
    }

    const staging = raw.staging;
    if (!staging || typeof staging.dir !== 'string' || staging.dir === '') {
      throw launcherError('LAUNCHER_PLATFORM_UNSUPPORTED', {
        message: '宿主未提供插件包的暂存目录，无法做函数级冲突分析',
        detail: `planId=${raw.planId}（launcher_content_plan 尚未回传 staging）`,
      });
    }
    const byStaging = new Map<string, { ref: ContentFileRef; installedPath: string }>();
    const stagingPaths: string[] = [];
    for (const file of scriptFiles) {
      const key = `${file.rootId}/${file.path}`;
      const stagingPath = staging.files[key];
      if (typeof stagingPath !== 'string' || stagingPath === '') {
        throw launcherError('LAUNCHER_PLATFORM_UNSUPPORTED', {
          message: '宿主未提供该文件的暂存路径，无法做函数级冲突分析',
          detail: key,
        });
      }
      stagingPaths.push(stagingPath);
      const root = roots.get(file.rootId);
      byStaging.set(posix(stagingPath), {
        ref: { rootId: file.rootId, path: file.path },
        installedPath: joinRelative(root?.instanceRoot.relativePath ?? file.rootId, file.path),
      });
    }

    let parsed: readonly ScriptFunctionDefinition[];
    try {
      parsed = await analyze(staging.dir, stagingPaths);
    } catch (err) {
      throw launcherError('LAUNCHER_PLUGIN_CONFLICT', {
        message: '插件函数索引解析失败，安装已中止（解析失败不能当作「没有函数」）',
        detail: errText(err),
      });
    }
    if (!Array.isArray(parsed)) {
      throw launcherError('LAUNCHER_PLUGIN_CONFLICT', {
        message: '插件函数索引的返回形状不合法，安装已中止',
        detail: `analyzeFunctions 返回了 ${typeof parsed}`,
      });
    }

    const incoming = parsed.map((def) => {
      const hit = byStaging.get(posix(def.path));
      return {
        def,
        ref: hit?.ref ?? null,
        installedPath: hit?.installedPath ?? def.path,
      };
    });

    const existing: { pluginId: string | null; def: ScriptFunctionDefinition }[] = [];
    const baseIndex = this.baseFunctionIndexOf ? await this.baseFunctionIndexOf(instance) : null;
    if (baseIndex === null) {
      warnings.push('未提供基础游戏函数索引：函数级冲突只比对已装插件');
    } else {
      for (const def of baseIndex) existing.push({ pluginId: null, def });
    }
    const others = [...installed]
      .filter((pack) => pack.enabled && pack.manifest.id !== manifest.id)
      .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    for (const pack of others) {
      for (const def of this.states.get(instance.id)?.get(pack.manifest.id)?.functionIndex ?? []) {
        existing.push({ pluginId: pack.manifest.id, def });
      }
    }
    const byName = new Map<string, { pluginId: string | null; def: ScriptFunctionDefinition }>();
    for (const entry of existing) {
      const key = normalizeName(entry.def.normalizedName);
      if (!byName.has(key)) byName.set(key, entry);
    }

    const policy = this.conventionPolicyOf(instance.adapterId);
    const fileConflictKeys = new Set(conflicts.map((conflict) => refKey(conflict)));
    const found: FunctionConflict[] = [];
    const targets = new Map<string, ContentFileRef>();
    const suppressed = new Map<string, number>();
    for (const item of incoming) {
      const key = normalizeName(item.def.normalizedName);
      if (targets.has(key) || found.some((conflict) => normalizeName(conflict.functionName) === key)) {
        continue;
      }
      // 文件冲突不重复计函数冲突（ADR-0009 §3）：用户已经在文件层面决定替换整份文件
      if (item.ref !== null && fileConflictKeys.has(refKey(item.ref))) continue;
      const hit = byName.get(key);
      if (!hit) continue;
      // 原位覆盖：既有定义就在这次要写的那份文件里，按文件口径处理
      if (posix(hit.def.path) === posix(item.installedPath)) continue;
      const suppression = matchSuppression(policy, key);
      if (suppression !== undefined) {
        suppressed.set(suppression.reason, (suppressed.get(suppression.reason) ?? 0) + 1);
        continue;
      }
      found.push({
        functionName: item.def.name,
        existing: { pluginId: hit.pluginId, path: hit.def.path, line: hit.def.line },
        incoming: { path: item.installedPath, line: item.def.line },
        resolution: 'abort',
      });
      if (item.ref !== null) targets.set(key, item.ref);
    }

    for (const [reason, count] of suppressed) {
      warnings.push(`已按适配器约定策略收敛 ${count} 处预期重复：${reason}`);
    }
    if (found.length > 0) {
      warnings.push(
        `检出 ${found.length} 处函数级冲突：默认中止，需逐条决定保留既有定义（skip）或覆盖（replace）`,
      );
    }

    return {
      conflicts: found,
      targets,
      index: incoming.map((item) => ({
        name: item.def.name,
        normalizedName: item.def.normalizedName,
        path: item.installedPath,
        line: item.def.line,
      })),
    };
  }

  /** 存档闸：确认 → 备份（`reason='pre-plugin'`）→ **备份落账才算过**（失败即中止） */
  private async ensureSaveBackup(
    instanceId: string,
    plan: PluginInstallPlan,
    opts: PluginApplyOptions | undefined,
  ): Promise<string | null> {
    if (plan.saveImpact === 'none') return null;
    if (opts?.acknowledgeSaveImpact !== true) {
      throw launcherError('LAUNCHER_PLUGIN_SAVE_RISK', {
        message: '该插件可能影响存档，需先确认影响并完成备份',
        detail: `${plan.manifest.id} ${plan.manifest.version}：saveImpact=${plan.saveImpact}`,
      });
    }
    const saves = this.saves;
    if (!saves) {
      throw launcherError('LAUNCHER_PLUGIN_SAVE_RISK', {
        message: '当前装配没有存档备份能力，无法满足安装前备份，已中止安装',
        detail: `${plan.manifest.id} ${plan.manifest.version}`,
      });
    }

    const request: SaveBackupRequest = {
      reason: 'pre-plugin',
      label: `安装插件前自动备份（${plan.manifest.id} ${plan.manifest.version}）`,
    };
    let task: LauncherTask;
    try {
      task = await saves.backup(instanceId, request);
    } catch (err) {
      throw launcherError('LAUNCHER_PLUGIN_SAVE_RISK', {
        message: '安装前备份存档失败，已中止安装',
        detail: errText(err),
      });
    }
    const backupId = task.result?.['backupId'];
    if (task.state !== 'succeeded' || typeof backupId !== 'string' || backupId === '') {
      throw launcherError('LAUNCHER_PLUGIN_SAVE_RISK', {
        message: '安装前备份存档没有成功完成，已中止安装',
        detail: `备份任务 ${task.id} 状态 ${task.state}`,
      });
    }
    let backups: readonly SaveBackup[];
    try {
      backups = await saves.backups(instanceId);
    } catch (err) {
      throw launcherError('LAUNCHER_PLUGIN_SAVE_RISK', {
        message: '无法确认备份是否落账，已中止安装',
        detail: errText(err),
      });
    }
    if (!backups.some((backup) => backup.id === backupId)) {
      throw launcherError('LAUNCHER_PLUGIN_SAVE_RISK', {
        message: '安装前备份没有落账，已中止安装（没有回退点的改动不做）',
        detail: `backupId=${backupId}`,
      });
    }
    return backupId;
  }

  /** 启用前复检：两条已启用插件的同名定义（未被约定策略收敛）不许静默同时生效 */
  private async assertEnableConflicts(
    instance: LauncherInstance,
    packs: readonly InstalledContent[],
    pluginId: string,
  ): Promise<void> {
    const self = this.states.get(instance.id)?.get(pluginId);
    if (!self || self.functionIndex.length === 0) return;
    const policy = this.conventionPolicyOf(instance.adapterId);
    const taken = new Map<string, string>();
    const remember = (plugin: string | null, def: ScriptFunctionDefinition): void => {
      const key = normalizeName(def.normalizedName);
      if (taken.has(key)) return;
      taken.set(key, plugin ?? '基础游戏');
    };
    const baseIndex = this.baseFunctionIndexOf ? await this.baseFunctionIndexOf(instance) : null;
    for (const def of baseIndex ?? []) remember(null, def);
    for (const pack of [...packs].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))) {
      if (pack.manifest.id === pluginId || !pack.enabled) continue;
      for (const def of this.states.get(instance.id)?.get(pack.manifest.id)?.functionIndex ?? []) {
        remember(pack.manifest.id, def);
      }
    }
    const hits: string[] = [];
    for (const def of self.functionIndex) {
      const key = normalizeName(def.normalizedName);
      const owner = taken.get(key);
      if (owner === undefined) continue;
      if (matchSuppression(policy, key) !== undefined) continue;
      hits.push(`${def.name}（与 ${owner} 重名）`);
    }
    if (hits.length === 0) return;
    throw launcherError('LAUNCHER_PLUGIN_CONFLICT', {
      message: '启用后会出现函数级冲突，已拒绝启用',
      detail: `${pluginId}：${hits.join('、')}`,
    });
  }

  /** 落盘成功后的账：enabled / order / risk / functionIndex / 决议逐条留痕 */
  private registerInstalled(
    record: PlanRecord,
    decisions: Decisions,
    opts: PluginApplyOptions | undefined,
  ): void {
    const plan = record.plan;
    const map = this.states.get(record.instanceId) ?? new Map<string, PluginState>();
    this.states.set(record.instanceId, map);
    const previous = map.get(plan.manifest.id);
    map.set(plan.manifest.id, {
      manifest: plan.manifest,
      enabled: previous?.enabled ?? true,
      order: previous?.order ?? plan.manifest.loadOrder,
      risk: plan.risk,
      requiresRestart: plan.requiresRestart,
      status: plan.compatibility.ok ? 'ok' : 'incompatible',
      installedAt: previous?.installedAt ?? new Date(this.now()).toISOString(),
      sourceProjectId: opts?.sourceProjectId ?? previous?.sourceProjectId ?? null,
      saveImpact: plan.saveImpact,
      functionIndex: record.functionIndex,
      decisions: [...(previous?.decisions ?? []), ...decisions.ledger],
    });
  }

  private trustRecord(
    instanceId: string,
    pluginId: string,
    publisher: string | null,
  ): PluginTrustRecord {
    const approval = this.approvals.get(instanceId)?.get(pluginId);
    return {
      state: 'unverified',
      publisher,
      signedAt: null,
      ...(approval === undefined
        ? {}
        : { approvedBy: approval.approvedBy, approvedAt: approval.approvedAt }),
    };
  }

  private isApproved(instanceId: string, pluginId: string, version: string): boolean {
    const approval = this.approvals.get(instanceId)?.get(pluginId);
    if (!approval) return false;
    return approval.version === null || approval.version === version;
  }

  private async resolveGameVersion(instance: LauncherInstance): Promise<string | null> {
    const provider = this.gameVersionOf;
    if (!provider) return null;
    try {
      const value = await provider(instance);
      return typeof value === 'string' && value !== '' ? value : null;
    } catch {
      // 版本探测失败 ≠ 版本不兼容：如实落 null（兼容性判定里会写「未校验」），不让一次读盘失败拦死安装
      return null;
    }
  }

  /* ------------------------------ 内部：任务与单飞 ------------------------------ */

  private async runTask(input: {
    readonly instanceId: string;
    readonly planId: string | null;
    readonly fallbackCode: LauncherErrorCode;
    readonly context: string;
    readonly onSucceeded?: () => void;
    readonly start: () => Promise<LauncherTask>;
  }): Promise<LauncherTask> {
    // 落票在**发宿主命令之前**；与内容包同一把锁（`instance-lock.ts`），本层不持锁表
    const hold = this.lock.acquire(input.instanceId, 'plugin', { planId: input.planId });

    let task: LauncherTask;
    try {
      task = await input.start();
    } catch (err) {
      // 失败路径：宿主命令直接抛错 ⇒ 立刻还票
      this.lock.release(hold);
      throw normalizeLauncherError(err, {
        fallbackCode: input.fallbackCode,
        detail: input.context,
      });
    }

    // 任务 id 记到票上：异步终态（成功 / 失败 / 取消）到达时按它释放
    this.lock.attachTask(hold, task.id);
    this.tasks.adopt(task, {
      onCancel: () => this.cancelHostTask(input.planId, task.id, task),
    });

    const settled = this.tasks.get(task.id) ?? task;
    if (isTerminalTaskState(settled.state)) this.lock.release(hold);
    if (settled.state === 'failed') {
      // 宿主给的码原样透传（`normalizeLauncherError` 只补 detail，不改码）
      throw normalizeLauncherError(settled.error ?? launcherError(input.fallbackCode), {
        detail: input.context,
      });
    }
    if (input.onSucceeded) this.whenSucceeded(settled, input.onSucceeded);
    return settled;
  }

  /**
   * 取消：先让宿主回滚，再把任务落 `cancelled`。
   * **本层不落插件状态**（登记只挂在 `succeeded` 上），所以「取消后插件显示已装」不可能
   * 发生在这里；宿主的终态快照也不会把 `cancelled` 拉回 `succeeded`（终态冻结在任务中心）。
   * 票由锁的终态订阅按 `taskId` 收回（紧接在 `adopt` 落 `cancelled` 的那次广播里）。
   */
  private async cancelHostTask(
    planId: string | null,
    taskId: string,
    snapshot: LauncherTask,
  ): Promise<void> {
    await this.host.taskCancel(taskId);
    const latest = this.tasks.get(taskId) ?? snapshot;
    if (isTerminalTaskState(latest.state)) return;
    this.tasks.adopt({
      ...latest,
      state: 'cancelled',
      endedAt: new Date(this.now()).toISOString(),
    });
    if (planId !== null) this.plans.delete(planId);
    this.lock.releaseByTask(taskId);
  }

  /** 终态一次性订阅：任务异步完成时再登记插件状态（宿主可能先返回 `running`） */
  private whenSucceeded(task: LauncherTask, run: () => void): void {
    if (task.state === 'succeeded') {
      run();
      return;
    }
    if (isTerminalTaskState(task.state)) return;
    const off = this.tasks.subscribe((update) => {
      if (update.id !== task.id || !isTerminalTaskState(update.state)) return;
      off();
      this.watchers.delete(off);
      if (update.state === 'succeeded') run();
    });
    this.watchers.add(off);
  }

  private assertPlanFresh(expiresAt: string, planId: string): void {
    const deadline = Date.parse(expiresAt);
    if (Number.isNaN(deadline)) {
      throw launcherError('LAUNCHER_INTERNAL', {
        message: '安装计划缺少有效的过期时间，请重新预检',
        detail: `planId=${planId} expiresAt=${String(expiresAt)}`,
      });
    }
    if (deadline <= this.now()) {
      throw launcherError('LAUNCHER_INTERNAL', {
        message: '安装计划已过期，请重新预检',
        detail: `planId=${planId} 过期于 ${expiresAt}`,
      });
    }
  }

  private prunePlans(): void {
    const now = this.now();
    for (const [planId, record] of [...this.plans]) {
      if (Date.parse(record.plan.expiresAt) <= now) this.plans.delete(planId);
    }
  }

  private async listInstalled(instanceId: string): Promise<readonly InstalledContent[]> {
    const packs = await this.content.list(instanceId);
    return packs.filter(isPluginPack);
  }

  /**
   * 停游戏。`ProcessSupervisor.stop` 对已停状态本就幂等；宿主明确报「没在运行 / 实例没登记」
   * 时继续，其余错误照抛（不猜「大概停了吧」）。
   */
  private async stopGame(instanceId: string): Promise<void> {
    try {
      await this.processes.stop(instanceId);
    } catch (err) {
      const error = normalizeLauncherError(err);
      if (NOT_RUNNING_CODES.has(error.code)) return;
      throw error;
    }
  }

  private requireRules(instance: LauncherInstance): GamePluginRules {
    const rules = this.pluginRulesOf(instance.adapterId);
    if (!rules) {
      throw launcherError('LAUNCHER_PLATFORM_UNSUPPORTED', {
        message: '该游戏暂不支持安装插件',
        detail: `适配器 ${instance.adapterId} 未声明 pluginRules（内容包仍可用）`,
      });
    }
    return rules;
  }

  private async requireInstance(instanceId: string): Promise<LauncherInstance> {
    const instance = await this.getInstance(instanceId);
    if (!instance) {
      throw launcherError('LAUNCHER_INSTANCE_NOT_FOUND', { detail: `实例 ${instanceId} 不存在` });
    }
    return instance;
  }

  private cmd<K extends keyof PluginHostCommands>(name: K): PluginHostCommands[K] {
    const fn = (this.host as Partial<PluginHostCommands>)[name];
    if (typeof fn !== 'function') {
      throw launcherError('LAUNCHER_PLATFORM_UNSUPPORTED', {
        message: '当前宿主未提供插件安装能力',
        detail: `宿主缺少 ${PLUGIN_HOST_COMMAND_NAMES[name]}（P1 命令尚未接通）`,
      });
    }
    return fn.bind(this.host) as PluginHostCommands[K];
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 纯函数（根解析 / 文件闸 / 风险 / 冲突决议 / 约定策略）
 * ══════════════════════════════════════════════════════════════════════════════ */

interface PluginRoot {
  /** 实例快照里的同名根（shared 可写授权、accepts 由它说） */
  readonly instanceRoot: ContentRootSpec;
  /** adapter 的插件根声明（kind 决定能力支持面与风险档） */
  readonly pluginRoot: ContentRootSpec;
}

/** 插件根 = 实例内容根 ∩ adapter 的插件根（缺一不可：前者管授权，后者管「是不是插件落点」） */
function resolvePluginRoots(
  instance: LauncherInstance,
  rules: GamePluginRules,
): ReadonlyMap<string, PluginRoot> {
  const instanceRoots = new Map(instance.contentRoots.map((root) => [root.id, root]));
  const out = new Map<string, PluginRoot>();
  for (const pluginRoot of rules.roots) {
    const instanceRoot = instanceRoots.get(pluginRoot.id);
    if (!instanceRoot) continue;
    out.set(pluginRoot.id, { instanceRoot, pluginRoot });
  }
  return out;
}

/** 文件级闸：根归属 / shared 写授权 / 根接受的包类型 / 路径 / 大小 / 包内大小写碰撞 / 总量 */
function gateFilePlan(
  instance: LauncherInstance,
  manifest: ContentPackManifest,
  roots: ReadonlyMap<string, PluginRoot>,
  limits: ZipContractLimits,
): void {
  if (manifest.files.length > limits.maxEntries) {
    throw launcherError('LAUNCHER_ARCHIVE_LIMIT', {
      message: '插件的条目数超出限额，已中止',
      detail: `${manifest.files.length} > ${limits.maxEntries}`,
    });
  }
  const seen = new Set<string>();
  const folded = new Map<string, string>();
  let totalBytes = 0;
  for (const file of manifest.files) {
    const entry = roots.get(file.rootId);
    if (!entry) {
      throw launcherError('LAUNCHER_SOURCE_NOT_APPROVED', {
        message: '插件要写入的根不在该游戏的插件安装根内，已拒绝',
        detail: `${file.rootId}/${file.path}`,
      });
    }
    if (!entry.pluginRoot.accepts.includes('plugin')) {
      throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
        message: '插件根不接受插件类型的包，已拒绝',
        detail: `${entry.pluginRoot.id} 接受 [${entry.pluginRoot.accepts.join('、')}]`,
      });
    }
    if (instance.isolation === 'shared' && !entry.instanceRoot.writableInShared) {
      throw launcherError('LAUNCHER_SOURCE_NOT_APPROVED', {
        message: '该插件根在共享实例下未声明可写，需先逐根授权',
        detail: `${entry.instanceRoot.id}（${entry.instanceRoot.label}）：${file.path}`,
      });
    }
    assertEntryPath(file.rootId, file.path, limits);
    if (!Number.isInteger(file.size) || file.size < 0) {
      throw launcherError('LAUNCHER_ARCHIVE_INVALID', {
        message: '清单里的文件大小不合法，已拒绝',
        detail: `${file.rootId}/${file.path}：${String(file.size)}`,
      });
    }
    const exact = `${file.rootId}/${file.path}`;
    if (seen.has(exact)) {
      throw launcherError('LAUNCHER_ARCHIVE_INVALID', {
        message: '清单里同一路径声明了两次，已拒绝',
        detail: exact,
      });
    }
    seen.add(exact);
    const key = refKey(file);
    const previous = folded.get(key);
    if (previous !== undefined && previous !== file.path) {
      throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
        message: '包内存在仅大小写不同的路径，无法安全落盘',
        detail: `${previous} / ${file.path}（大小写不敏感的文件系统上等价）`,
      });
    }
    folded.set(key, file.path);
    totalBytes += file.size;
  }
  if (totalBytes > limits.maxUnpackedBytes) {
    throw launcherError('LAUNCHER_ARCHIVE_LIMIT', {
      message: '插件解压后的总体积超出限额，已中止',
      detail: `${totalBytes} > ${limits.maxUnpackedBytes}`,
    });
  }
}

/** 与内容管线同一口径的逐条对账：计划要写的文件必须与清单一一对应 */
function assertPlanMatchesManifest(raw: HostPluginPlan): void {
  const expected = new Map(
    raw.manifest.files.map((file) => [refKey(file), `${file.rootId}/${file.path}`]),
  );
  const planned = [...raw.additions, ...raw.overwrites, ...raw.conflicts];
  const actual = new Set<string>();
  for (const ref of planned) {
    const key = refKey(ref);
    if (!expected.has(key)) {
      throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
        message: '安装计划要写入清单之外的文件，已拒绝',
        detail: `${ref.rootId}/${ref.path}`,
      });
    }
    if (actual.has(key)) {
      throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
        message: '安装计划里同一文件出现了多次，已拒绝',
        detail: `${ref.rootId}/${ref.path}`,
      });
    }
    actual.add(key);
  }
  if (actual.size !== expected.size) {
    const missing = [...expected.entries()]
      .filter(([key]) => !actual.has(key))
      .map(([, label]) => label);
    throw launcherError('LAUNCHER_CONTENT_CONFLICT', {
      message: '安装计划与清单不一致，已拒绝',
      detail: `清单里这些文件没有出现在计划中：${missing.join('、')}`,
    });
  }
}

/** 宿主冲突 → 契约冲突（`case-collision` 折进二分，与内容管线同一处置） */
function mapConflicts(raw: readonly HostContentConflict[]): readonly ContentConflict[] {
  return raw.map((conflict) => ({
    rootId: conflict.rootId,
    path: conflict.path,
    kind: classifyConflict(conflict),
    existingPackId: conflict.existingPackId,
    resolution: conflict.resolution,
  }));
}

function classifyConflict(conflict: HostContentConflict): ContentConflict['kind'] {
  if (conflict.kind === 'case-collision') {
    return conflict.existingPackId ? 'other-pack' : 'base-file';
  }
  if (conflict.kind === 'other-pack') {
    return conflict.existingPackId ? 'other-pack' : 'base-file';
  }
  return 'base-file';
}

/** 大小写碰撞折叠成二分之后仍要留痕（契约码表没有这一档，见 `content-manager.ts` 缺口 1） */
function caseCollisionWarnings(raw: readonly HostContentConflict[]): readonly string[] {
  return raw
    .filter((conflict) => conflict.kind === 'case-collision')
    .map(
      (conflict) =>
        `大小写碰撞：${conflict.rootId}/${conflict.path} 与既有 ` +
        `${conflict.existingPath ?? '同名条目'} 在大小写不敏感的文件系统上等价` +
        (conflict.existingPackId ? `（属于 ${conflict.existingPackId}）` : ''),
    );
}

/** 清单能力面的运行期归一（不可信的包：未知值不许被当成 `add-content` 吞掉） */
function resolveCapabilities(raw: readonly string[] | undefined): readonly string[] {
  return raw === undefined ? DEFAULT_CAPABILITIES : [...raw];
}

/** 能力支持面：每种能力都要有一个可落地的插件根，否则「装完了也用不上」 */
function assertCapabilitiesSupported(
  capabilities: readonly string[],
  rules: GamePluginRules,
): void {
  const rootKinds = new Set(rules.roots.map((root) => root.kind));
  const unsupported = capabilities.filter((capability) => {
    if (!KNOWN_CAPABILITIES.has(capability)) return false; // 未知值走「风险无法归类」
    const wanted = CAPABILITY_ROOT_KINDS[capability as PluginCapability];
    return !wanted.some((kind) => rootKinds.has(kind));
  });
  if (unsupported.length === 0) return;
  throw launcherError('LAUNCHER_PLATFORM_UNSUPPORTED', {
    message: '该游戏不提供此插件能力所需的安装根，已拒绝',
    detail:
      `插件声明：${unsupported.join('、')}；本游戏的插件根类别：` +
      `${[...rootKinds].join('、') || '无'}`,
  });
}

/**
 * 风险分级：只由「清单能力 + 实际落点」推导，core 不读脚本内容（ADR-0009 §5）。
 * 声明与实际不一致 ⇒ **按实际升档**（不信任声明）；无法归类 ⇒ `unknown`（按最高档展示）。
 */
function classifyRisk(
  declaredRaw: readonly string[] | undefined,
  touched: readonly ContentRootSpec['kind'][],
): { readonly risk: PluginRisk; readonly mismatch: boolean } {
  if (declaredRaw !== undefined && (declaredRaw.length === 0 || declaredRaw.some((c) => !KNOWN_CAPABILITIES.has(c)))) {
    return { risk: 'unknown', mismatch: false };
  }
  const declared = declaredRaw ?? DEFAULT_CAPABILITIES;
  const declaredTier = declared.reduce<1 | 2 | 3>(
    (max, capability) => Math.max(max, CAPABILITY_TIER[capability as PluginCapability] ?? 3) as 1 | 2 | 3,
    1,
  );
  // 落点档：数据根 = 扩展逻辑；脚本 / 资源 / 插件根 = 覆盖逻辑（插件根内是什么由 adapter 定，
  // 不认识 ⇒ 按最坏情况算覆盖）
  const landingTier = touched.reduce<1 | 2 | 3>(
    (max, kind) => Math.max(max, kind === 'data' ? 2 : 3) as 1 | 2 | 3,
    1,
  );
  const tier = Math.max(declaredTier, landingTier) as 1 | 2 | 3;
  return { risk: TIER_RISK[tier] ?? 'unknown', mismatch: landingTier > declaredTier };
}

function missingRequirementsOf(
  manifest: ContentPackManifest,
  installed: readonly InstalledContent[],
): readonly string[] {
  const byId = new Map(installed.map((pack) => [pack.manifest.id, pack.manifest]));
  const missing: string[] = [];
  for (const requirement of manifest.requires ?? []) {
    const found = byId.get(requirement.id);
    if (!found) {
      missing.push(`${requirement.id} ${requirement.version}`);
      continue;
    }
    if (requirement.version !== '*' && found.version !== requirement.version) {
      missing.push(`${requirement.id} ${requirement.version}（已装 ${found.version}）`);
    }
  }
  return missing;
}

/** 声明 `conflicts` 命中已装插件 = 硬中止（首版不自动卸载别人） */
function assertNoDeclaredConflicts(
  manifest: ContentPackManifest,
  installed: readonly InstalledContent[],
): void {
  const hits = (manifest.conflicts ?? []).filter((id) =>
    installed.some((pack) => pack.manifest.id === id),
  );
  if (hits.length === 0) return;
  throw launcherError('LAUNCHER_PLUGIN_DEPENDENCY', {
    message: '该插件声明与已安装插件冲突，已拒绝安装',
    detail: `${manifest.id} 声明与 ${hits.join('、')} 冲突（先卸载对方再试）`,
  });
}

function assertOrderSource(rules: GamePluginRules, warnings: string[]): void {
  if (rules.orderSource === 'manifest') return;
  warnings.push(
    `该游戏的插件顺序由游戏自己按${rules.orderSource === 'directory' ? '目录名' : '文件名'}扫描决定：` +
      '清单里的 loadOrder 只作展示，启动器不接管排序',
  );
}

/**
 * 逐条决议。漏一条即整包拒绝（一半决议一半没决议 = 「看起来装上了、其实少了一半」）；
 * 配对口径与内容管线一致（`other-pack` 只能用 `replace`，`base-file` 不能用 `replace`）。
 *
 * 函数级 `skip` 折成**该文件整份跳过**：宿主与 adapter 都没有「只跳过一个函数」的写盘能力，
 * 假装可以就会写出半个文件。折法写进决议台账，让用户在任务结果里看得见。
 */
function resolveConflictDecisions(
  plan: PluginInstallPlan,
  functionTargets: ReadonlyMap<string, ContentFileRef>,
  resolutions: readonly PluginConflictResolution[] | undefined,
  nowMs: number,
): Decisions {
  const given = new Map<string, { readonly resolution: PluginConflictResolution; readonly label: string }>();
  for (const resolution of resolutions ?? []) {
    const key = decisionKey(resolution);
    if (given.has(key)) {
      throw launcherError('LAUNCHER_PLUGIN_CONFLICT', {
        message: '同一个冲突给了多条决议，已拒绝',
        detail: decisionLabel(resolution),
      });
    }
    given.set(key, { resolution, label: decisionLabel(resolution) });
  }

  const files = new Map<string, ConflictResolution>();
  const ledger: PluginDecision[] = [];
  const at = new Date(nowMs).toISOString();
  for (const conflict of plan.conflicts) {
    const key = `file|${refKey(conflict)}`;
    const decision = given.get(key)?.resolution;
    if (decision === undefined) {
      throw launcherError('LAUNCHER_PLUGIN_CONFLICT', {
        message: '还有文件冲突没有决断，已中止安装',
        detail: `${conflict.rootId}/${conflict.path}（${conflict.kind}）`,
      });
    }
    if (conflict.kind === 'other-pack' && decision.action === 'overwrite') {
      throw launcherError('LAUNCHER_PLUGIN_CONFLICT', {
        message: '覆盖别的插件写过的文件需用 replace（转移归属）',
        detail: `${conflict.rootId}/${conflict.path}`,
      });
    }
    if (conflict.kind === 'base-file' && decision.action === 'replace') {
      throw launcherError('LAUNCHER_PLUGIN_CONFLICT', {
        message: '基础游戏文件只能用 overwrite 或 skip',
        detail: `${conflict.rootId}/${conflict.path}`,
      });
    }
    files.set(refKey(conflict), {
      rootId: conflict.rootId,
      path: conflict.path,
      action: decision.action,
    });
    ledger.push({
      kind: 'file',
      action: decision.action,
      rootId: conflict.rootId,
      path: conflict.path,
      at,
    });
    given.delete(key);
  }

  for (const conflict of plan.functionConflicts) {
    const normalized = normalizeName(conflict.functionName);
    const key = `function|${normalized}`;
    const decision = given.get(key)?.resolution;
    if (decision === undefined) {
      throw launcherError('LAUNCHER_PLUGIN_CONFLICT', {
        message: '还有函数冲突没有决断，已中止安装',
        detail: conflict.functionName,
      });
    }
    if (decision.action === 'overwrite') {
      throw launcherError('LAUNCHER_PLUGIN_CONFLICT', {
        message: '函数冲突只能用 skip（保留既有定义）或 replace（覆盖）',
        detail: conflict.functionName,
      });
    }
    const target = functionTargets.get(normalized);
    if (decision.action === 'skip' && target !== undefined) {
      // 整份文件跳过（`skip` 压倒同文件的任何 replace/overwrite：少写一个文件比多写安全）
      files.set(refKey(target), { rootId: target.rootId, path: target.path, action: 'skip' });
      ledger.push({
        kind: 'function',
        action: 'skip',
        functionName: conflict.functionName,
        rootId: target.rootId,
        path: target.path,
        at,
      });
    } else {
      ledger.push({
        kind: 'function',
        action: 'replace',
        functionName: conflict.functionName,
        path: conflict.incoming.path,
        at,
      });
    }
    given.delete(key);
  }

  if (given.size > 0) {
    throw launcherError('LAUNCHER_PLUGIN_CONFLICT', {
      message: '决议里有计划之外的冲突项，已拒绝',
      detail: [...given.values()].map((entry) => entry.label).join('、'),
    });
  }
  // 函数级 skip 只动文件：最终交给宿主的是**文件级**决议表
  return { hostResolutions: [...files.values()], ledger };
}

function decisionKey(resolution: PluginConflictResolution): string {
  if (resolution.functionName !== undefined && resolution.functionName !== '') {
    return `function|${normalizeName(resolution.functionName)}`;
  }
  return `file|${(resolution.rootId ?? '').toLowerCase()}/${(resolution.path ?? '').toLowerCase()}`;
}

/** 决议项的人话标签（报错时不让用户对着 `file|a/b` 这种内部键猜） */
function decisionLabel(resolution: PluginConflictResolution): string {
  if (resolution.functionName !== undefined && resolution.functionName !== '') {
    return resolution.functionName;
  }
  return `${resolution.rootId ?? '?'}/${resolution.path ?? '?'}`;
}

/** 约定策略命中：与 `convention-linter` 的 `erb.duplicate-function` 同一判据（名字集 + 正则） */
function matchSuppression(
  policy: ConventionPolicy | undefined,
  normalizedName: string,
): { readonly reason: string } | undefined {
  const specs = (policy ?? []).filter((spec) => spec.ruleId === DUPLICATE_FUNCTION_RULE_ID);
  for (const spec of specs) {
    const names = new Set((spec.names ?? []).map((name) => name.toUpperCase()));
    if (names.has(normalizedName)) return { reason: spec.reason };
    if (spec.namePattern !== undefined) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(spec.namePattern, 'i');
      } catch {
        continue; // 坏正则不是「命中」，也不是「收敛」——按真冲突继续
      }
      if (pattern.test(normalizedName)) return { reason: spec.reason };
    }
  }
  return undefined;
}

function normalizeName(name: string): string {
  return name.toUpperCase();
}

/** 排序参数必须是已装插件 id 的**排列**：不多、不少、不重 */
function assertPermutation(pluginIds: readonly string[], installed: readonly string[]): void {
  const wanted = new Set<string>();
  for (const id of pluginIds) {
    if (wanted.has(id)) {
      throw launcherError('LAUNCHER_PLUGIN_CONFLICT', {
        message: '加载顺序里同一个插件出现了两次，已拒绝',
        detail: id,
      });
    }
    wanted.add(id);
  }
  const known = new Set(installed);
  const unknown = [...wanted].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw launcherError('LAUNCHER_PLUGIN_CONFLICT', {
      message: '加载顺序里有未安装的插件，已拒绝',
      detail: unknown.join('、'),
    });
  }
  const missing = installed.filter((id) => !wanted.has(id));
  if (missing.length > 0) {
    throw launcherError('LAUNCHER_PLUGIN_CONFLICT', {
      message: '加载顺序漏掉了已安装的插件，已拒绝',
      detail: missing.join('、'),
    });
  }
}

function statusOf(
  pack: InstalledContent,
  state: PluginState | undefined,
): InstalledPlugin['status'] {
  if (pack.status === 'broken') return 'broken';
  if (state?.status === 'incompatible') return 'incompatible';
  if (pack.status === 'conflict') return 'conflict';
  return 'ok';
}

function isPluginPack(pack: InstalledContent): boolean {
  return pack.manifest.kind === 'plugin';
}

function assertEntryPath(rootId: string, path: string, limits: ZipContractLimits): void {
  const problem = zipEntryContractProblem(path, limits.maxDepth);
  if (problem === null) return;
  const detail = `${rootId}/${path}（${problem}）`;
  if (problem === 'path-depth') {
    throw launcherError('LAUNCHER_ARCHIVE_LIMIT', {
      message: '包内路径层级超出限额，已中止',
      detail,
    });
  }
  if (ESCAPE_PATH_CODES.has(problem)) {
    throw launcherError('LAUNCHER_PATH_ESCAPE', {
      message: '包内路径越出了目标根，已拒绝',
      detail,
    });
  }
  throw launcherError('LAUNCHER_ARCHIVE_INVALID', {
    message: '包内路径不合法，已拒绝',
    detail,
  });
}

function refKey(ref: ContentFileRef): string {
  return `${ref.rootId.toLowerCase()}/${ref.path.toLowerCase()}`;
}

function posix(path: string): string {
  return path.replaceAll('\\', '/');
}

function joinRelative(base: string, path: string): string {
  const left = posix(base).replace(/\/+$/, '');
  if (left === '' || left === '.') return posix(path);
  return `${left}/${posix(path)}`;
}

function errText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err !== null && typeof err === 'object') {
    const dto = err as { detail?: unknown; message?: unknown; code?: unknown };
    if (typeof dto.detail === 'string' && dto.detail !== '') return dto.detail;
    if (typeof dto.message === 'string' && dto.message !== '') return dto.message;
    if (typeof dto.code === 'string' && dto.code !== '') return dto.code;
  }
  return String(err);
}
