/**
 * Kojo 2.0 槽位账本的**宿主服务**（K2-STORAGE-SERVICE）：把「项目打开」这一个动作
 * 编排成一条**有唯一顺序、失败必上屏**的流水线，并持有当前项目的唯一宿主实例。
 *
 * ## 为什么还要一层（已有 host / registry / persist 三件套）
 *
 * 那三件都是**纯判据 + 显式端口**，谁都可以按自己的顺序调用；但"按什么顺序调"本身是
 * 判据：`hydrate → loadPreviousSnapshot → registry → plan 闸 → commit → flush` 错一步，
 * 轻则把坏账当首启覆盖，重则拿没读过盘的镜像去落账。本模块把顺序写死在一处，并且
 * **每一条非 `committed` / 非 `ok` 的分支都必须落到问题面板 + 一条通知**（铁律 4：
 * 存储面不静默）。宿主（`App.tsx`）只需要在三件事上叫它：项目打开、会话内声明刷新
 * （`file.changed` 防抖后）、项目关闭。
 *
 * ## 顺序（写死，测试逐条钉住）
 *
 * ```
 * ① 开关 / 并发 / 入参前置闸（零端口调用）
 * ② 旧实例 flush + 丢弃（换项目隔离；旧实例的 flush 失败照样上屏）
 * ③ host.hydrate()                     —— 读不动 / 读不懂 ⇒ 阻断，零写
 * ④ host.loadPreviousSnapshot()        —— invalid ⇒ 阻断（不把"还原不了"当首启）
 * ⑤ createKojo2StorageRegistry(...)    —— 装配失败 ⇒ 阻断，零写
 * ⑥ registry.storagePlan.ok === true   —— false ⇒ 阻断（不调 commit）
 * ⑦ host.commit({ registry, fingerprint }) —— recycled ⇒ 阻断 + 可显式重试
 * ⑧ host.flush()                       —— 写盘失败逐个上屏；实例仍算"已打开"
 * ```
 *
 * ## 失败面（全部可判别，绝不静默）
 *
 * - `disabled`：2.0 开关关着。**零实例、零读写、零监听、零通知**（连 problem-store 都不碰）。
 * - `busy`：同一服务上重入（open/close/retry 任一在飞）——返回 `busy`，不排队、不吞。
 * - `blocked`：在某一阶段被挡下（`stage` 说得出是哪一段），`problems` 是
 *   `kojo2StorageProblemOf` 的原样结果（宿主码，绝不伪造 `core/storage/*`）。
 * - `recycled`：本次装配回收了槽位（旧存档字节仍躺在那个槽里）。零写阻断；
 *   作者确认后调 {@link Kojo2StorageService.retryWithRecycledAllowed} 才放行。
 * - `skipped`：本轮没有可落账的文档（`no-documents`），或文档清单**不完整**
 *   （`documents-incomplete`，有文件没读到 / 被截断）。后者必须零写：把"读不到"
 *   当成"已删除"会回收它的槽位，等文件回来就串值了。两种情况都不写账本。
 * - `opened`：`commit.kind === 'committed'`。`flush` 失败不改变这个结论（内存镜像已提交），
 *   但失败条目会进 `problems` 并上屏；下次打开以盘为准，账上差额如实可见。
 * - `refreshed`（会话内刷新成功）：新账本提交 + flush 之后才换实例；`commit.changed=false`
 *   表示同声明幂等命中、盘面零写。刷新失败（上面的 blocked / recycled / skipped）**不拆**
 *   已 opened 实例，只把失败上屏——作者改好文件会再触发一次。
 * - `nothing-to-refresh`：当前没有已打开实例可刷新（首轮未开成 / 已关闭）。零写零通知。
 *
 * ## 回收槽位的可操作出口（K2-STORAGE-RECYCLED-UI）
 *
 * `recycled` 的那条 error 通知带 `action`（「放行回收并重试」），点它 = 调
 * {@link Kojo2StorageService.retryWithRecycledAllowed}；成功路径清 `kojo2:storage` 问题簇
 * 并补**一条** info 通知，失败路径照上面的 blocked 面（问题簇 + 一条 error）上屏。
 * 通知中心原生支持 action（`NotificationCenter.NoticeAction`），本模块不 import React、
 * 也不新造通知系统。命令表另有同一动作的二次入口（`kojo2-storage-retry-command.ts`），
 * 给 toast 已被关掉的作者留路。
 *
 * ## 与 kernel 的关系
 *
 * 本模块**不静态 import kernel**：`kernel` 是一个结构化端口（`storage.global()`），
 * 真实 `Kernel` 结构上直接满足；单测给假端口即可。React / Monaco / DOM 一概不碰。
 *
 * ## 问题落点
 *
 * 宿主级存储问题没有单一源文件可指，统一落在虚拟路径
 * {@link KOJO2_STORAGE_SERVICE_PROBLEM_PATH}（`kojo2:storage`）的**编辑器簇**：
 * 项目级分析那一簇（`kojo2:project`）属于另一条流水线，两簇互不清账。项目下一次打开时
 * 先清这一格（旧项目的存储问题不该跟着新项目跑）。
 */
import type { SlotClassSpec } from '@kojo/kojo-core';
import {
  KOJO2_STORAGE_HOST_PROBLEM_CODES,
  createKojo2StorageHost,
  kojo2StorageProblemOf,
  type Kojo2StorageHost,
  type Kojo2StorageHostFlushResult,
  type Kojo2StorageHostProblem,
  type Kojo2StorageHostQueueFailure,
  type Kojo2StorageHostStorage,
  type Kojo2StorageRecycledEntry,
} from './kojo2-storage-adapter';
import {
  createKojo2StorageRegistry,
  type Kojo2StorageDocument,
  type Kojo2StorageKeyInput,
  type Kojo2StorageRegistry,
} from './kojo2-storage-registry';
import type { Kojo2StorageCommitSuccess } from './kojo2-storage-persist';
import { isKojo2CutoverEnabled } from './kojo2-flag';
import { setProblems, type EditorProblem } from './problem-store';

/* ============================== 公开常量 ============================== */

/**
 * 宿主级存储问题的虚拟落点（问题面板里的“文件”一格）。
 *
 * 与 `kojo2:project`（core 存储诊断 / 项目级分析）刻意分开：那是"稿子里的槽位规划"，
 * 这里是"账本/队列/盘"；混在一格会让两簇互相压掉（`problem-store` 同一路径只出示一簇）。
 */
export const KOJO2_STORAGE_SERVICE_PROBLEM_PATH = 'kojo2:storage';

/** 面板里“这条是谁报的” */
export const KOJO2_STORAGE_SERVICE_PROBLEM_SOURCE = 'kojo2-storage';

/**
 * 本层独有的诊断码（**仍然带 `kojo2/storage-host/` 前缀**，与 adapter 的宿主码同族；
 * 不进 `KOJO2_STORAGE_HOST_PROBLEM_CODES` 是因为那一张表属 adapter，本层不改它的接口）。
 */
export const KOJO2_STORAGE_SERVICE_PROBLEM_CODES = Object.freeze({
  /** 本轮文档清单不完整（有文件没读到 / 截断）：零写，避免把读不到的文件当删除 */
  documentsIncomplete: 'kojo2/storage-host/documents-incomplete',
  /** 内部未预期异常：零写兜底（绝不把异常吞成“成功”） */
  unexpected: 'kojo2/storage-host/unexpected',
});

/* ============================== 端口（结构化类型，不 import kernel） ============================== */

/** 本层需要的 kernel 面（真实 `Kernel` 结构上直接满足） */
export interface Kojo2StorageServiceKernel {
  readonly storage: {
    global(): Kojo2StorageHostStorage;
  };
}

/**
 * 通知动作（K2-STORAGE-RECYCLED-UI）。
 *
 * 结构上是 `NotificationCenter` 的 `NoticeAction`（`label` + `run`），本模块不 import
 * React/tsx。`run` 允许返回 promise：测试可以 `await notice.action.run()` 等重试落地；
 * 真实通知中心按「点完先关 toast、再执行」处理，不等 promise（既有语义一字未改）。
 */
export interface Kojo2StorageServiceAction {
  readonly label: string;
  /** 返回值由测试 await 用；真实通知中心「点完先关 toast、再执行」，不等返回值 */
  readonly run: () => unknown;
}

/**
 * 通知端口（与 `NotificationCenter.Notify` 结构兼容；本模块不 import React/tsx）。
 *
 * `action` 是 additive：旧消费方不读它 ⇒ 只是少一个可点的出口，文案与失败面原样；
 * 新消费方（App 的 `useNotify`）把整条 notice 透传即可拿到「放行重试」按钮。
 */
export type Kojo2StorageServiceNotify = (notice: {
  readonly kind: 'info' | 'error';
  readonly message: string;
  readonly detail?: string;
  readonly action?: Kojo2StorageServiceAction;
}) => void;

/** 问题面板写入口（缺省 = `problem-store.setProblems`；测试注入假 sink） */
export type Kojo2StorageProblemSink = (
  path: string,
  items: readonly EditorProblem[],
) => void;

/**
 * 槽位账本需要的 **adapter 事实**（只取三格，不把整个 `GameAdapter` 拖进来）。
 *
 * `storageClasses` 必填：A3.6 的“未声明即报错”。这里不做“缺省回预览区段”的兜底——
 * 预览区段（`KOJO2_STORAGE_DEFAULT_CLASSES`）只是宿主当前还没有 adapter 数值区段时的
 * 显式选择，必须由调用方写出来（见 `App.tsx` 的接线注释）。
 */
export interface Kojo2StorageServiceAdapter {
  /** 游戏指纹（换盘/换汉化检测；空串视为未声明） */
  readonly gameFingerprint: string;
  /** 各类存储期的槽位区段（A3.6）；空数组视为未声明 */
  readonly storageClasses: readonly SlotClassSpec[];
  /** 声明键（缺省 = 注册表的位置键；真项目应由 adapter/账本注入稳定键） */
  readonly declarationKey?: (input: Kojo2StorageKeyInput) => string;
}

export interface Kojo2StorageServiceOptions {
  readonly kernel: Kojo2StorageServiceKernel;
  /** 人话通道（一次失败只发一条；问题面板另有完整列表） */
  readonly notify?: Kojo2StorageServiceNotify;
  /** 启用判据（缺省 = 既有 2.0 开关 `isKojo2CutoverEnabled`；false ⇒ 本模块零动作） */
  readonly isEnabled?: () => boolean;
  /** 问题写入口（缺省 `problem-store.setProblems`） */
  readonly writeProblems?: Kojo2StorageProblemSink;
  /** 时钟（透传宿主；缺省 `new Date().toISOString()`） */
  readonly now?: () => string;
  /** 项目键 → 存储键后缀（透传宿主；缺省内置稳定 hash） */
  readonly hash?: (projectKey: string) => string;
}

export interface Kojo2StorageOpenInput {
  readonly projectKey: string;
  /** 参与槽位分配的全部 `.kojo2` 文档（URI 必须唯一） */
  readonly documents: readonly Kojo2StorageDocument[];
  readonly adapter: Kojo2StorageServiceAdapter;
  /**
   * 本轮文档清单是否**完整**（缺省 true）。
   *
   * `false` = 有文件没读到 / 列表被截断：本层**零写跳过**——账本把“这次没出现的声明”
   * 当成删除，会回收槽位；文件回来时新声明就会读到旧存档字节。宁可這一轮不写。
   */
  readonly documentsComplete?: boolean;
}

/**
 * 会话内声明刷新入口（K2-STORAGE-RECYCLED-UI 缺口②）。
 *
 * 只递新文档清单：项目键 / adapter / 账本键都沿用**当前已打开**的实例。刷新失败
 * （语法错误 / 规划失败 / 回收阻断 / 清单不完整）**不拆已 opened 实例**——fail-closed
 * 但状态保留，作者改好文件再触发一次即可；只有新账本真正提交成功才换实例。
 */
export interface Kojo2StorageRefreshInput {
  /** 重新读到的全部 `.kojo2` 文档（URI 必须唯一） */
  readonly documents: readonly Kojo2StorageDocument[];
  /** 与 {@link Kojo2StorageOpenInput.documentsComplete} 同义；缺省 true */
  readonly documentsComplete?: boolean;
}

/* ============================== 结果 ============================== */

/** 被挡在哪一段（`unexpected` = 内部兜底异常） */
export type Kojo2StorageOpenStage =
  | 'input'
  | 'hydrate'
  | 'previous-snapshot'
  | 'registry'
  | 'plan'
  | 'commit'
  | 'unexpected';

export interface Kojo2StorageOpened {
  readonly kind: 'opened';
  readonly projectKey: string;
  readonly ledgerKey: string;
  readonly registry: Kojo2StorageRegistry;
  readonly commit: Kojo2StorageCommitSuccess;
  /** 落盘判据：`ok=false` 时 `problems` 非空（内存已提交、盘上可能还是旧账） */
  readonly flush: Kojo2StorageHostFlushResult;
  /** 已上屏的问题（空 = 全程干净）；同一条也在 `problem-store` 里 */
  readonly problems: readonly Kojo2StorageHostProblem[];
}

export interface Kojo2StorageRecycled {
  readonly kind: 'recycled';
  readonly projectKey: string;
  readonly ledgerKey: string;
  readonly total: number;
  readonly entries: readonly Kojo2StorageRecycledEntry[];
  readonly detail: string;
  readonly problems: readonly Kojo2StorageHostProblem[];
}

export interface Kojo2StorageBlocked {
  readonly kind: 'blocked';
  readonly stage: Kojo2StorageOpenStage;
  readonly projectKey: string;
  /** 已创建 host 的阶段才有账本键（入参/文档阶段为 null） */
  readonly ledgerKey: string | null;
  readonly detail: string;
  readonly problems: readonly Kojo2StorageHostProblem[];
}

export interface Kojo2StorageSkipped {
  readonly kind: 'skipped';
  readonly reason: 'no-documents' | 'documents-incomplete';
  readonly projectKey: string;
  readonly detail: string;
  readonly problems: readonly Kojo2StorageHostProblem[];
}

export interface Kojo2StorageDisabled {
  readonly kind: 'disabled';
}

export interface Kojo2StorageBusy {
  readonly kind: 'busy';
  readonly detail: string;
}

export type Kojo2StorageOpenResult =
  | Kojo2StorageOpened
  | Kojo2StorageRecycled
  | Kojo2StorageBlocked
  | Kojo2StorageSkipped
  | Kojo2StorageDisabled
  | Kojo2StorageBusy;

export type Kojo2StorageCloseResult =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly detail: string }
  | {
      readonly kind: 'closed';
      readonly projectKey: string;
      readonly ledgerKey: string;
      readonly flush: Kojo2StorageHostFlushResult;
      readonly problems: readonly Kojo2StorageHostProblem[];
    };

export type Kojo2StorageRetryResult =
  | Kojo2StorageOpenResult
  | Kojo2StorageRefreshResult
  | { readonly kind: 'nothing-to-retry' };

/** 会话内刷新成功：账本已按新声明提交（`commit.changed=false` = 幂等命中、零写） */
export interface Kojo2StorageRefreshed {
  readonly kind: 'refreshed';
  readonly projectKey: string;
  readonly ledgerKey: string;
  readonly commit: Kojo2StorageCommitSuccess;
  /** 落盘判据：`ok=false` 时 `problems` 非空（内存已提交、盘上可能还是旧账） */
  readonly flush: Kojo2StorageHostFlushResult;
  /** 已上屏的问题（空 = 全程干净）；同一条也在 `problem-store` 里 */
  readonly problems: readonly Kojo2StorageHostProblem[];
}

/** 没有已打开的实例可刷新（flag 关 / 项目没开成 / 已关闭）：零写、零上屏 */
export interface Kojo2StorageNothingToRefresh {
  readonly kind: 'nothing-to-refresh';
  readonly detail: string;
}

export type Kojo2StorageRefreshResult =
  | Kojo2StorageRefreshed
  | Kojo2StorageRecycled
  | Kojo2StorageBlocked
  | Kojo2StorageSkipped
  | Kojo2StorageDisabled
  | Kojo2StorageBusy
  | Kojo2StorageNothingToRefresh;

/** 可判别读数（宿主 / 测试据此核对「到底有没有实例、账本落在哪个键」） */
export interface Kojo2StorageServiceSnapshot {
  readonly phase: 'idle' | 'opening' | 'open' | 'closing' | 'disabled';
  readonly projectKey: string | null;
  readonly ledgerKey: string | null;
  /** 累计成功打开次数（`opened` 才算；refresh / blocked / skipped 不计） */
  readonly openCount: number;
  /** 累计落账提交次数（`commit.kind === 'committed'` 才算；幂等命中与 refresh 也算一次） */
  readonly commitCount: number;
}

export interface Kojo2StorageService {
  /** 项目打开：全序装配 + 落账。**永不抛**（异常折成 `blocked`/`unexpected`）。 */
  openProject(input: Kojo2StorageOpenInput): Promise<Kojo2StorageOpenResult>;
  /**
   * 会话内声明刷新：按新文档清单重算落账，**失败不拆已 opened 实例**（fail-closed 但
   * 状态保留）。幂等命中（同槽位 + 同形状）零写，与 `openProject` 共用同一提交/世代语义。
   * 没有实例 → `nothing-to-refresh`（不伪造一次开盘）。
   */
  refreshDeclarations(input: Kojo2StorageRefreshInput): Promise<Kojo2StorageRefreshResult>;
  /** 项目关闭：flush 后丢弃实例；flush 失败照样上屏。 */
  closeProject(): Promise<Kojo2StorageCloseResult>;
  /**
   * 对上一次 `recycled` 的装配**显式放行**槽位回收（`allowRecycledSlots: true`）后重跑。
   * 打开被挡下的重跑打开、刷新被挡下的重跑刷新；成功后清 `kojo2:storage` 并 toast 一次。
   * 没有待重试的装配 → `nothing-to-retry`（不伪造一次"成功"）。
   */
  retryWithRecycledAllowed(): Promise<Kojo2StorageRetryResult>;
  /** 当前实例（null = 未打开 / flag 关；测试与接线自检用） */
  host(): Kojo2StorageHost | null;
  getSnapshot(): Kojo2StorageServiceSnapshot;
}

/* ============================== 内部工具 ============================== */

const NO_PROBLEMS: readonly Kojo2StorageHostProblem[] = Object.freeze([]);

const BUSY_DETAIL =
  'Kojo 2.0 槽位账本上已有一次打开/刷新/关闭/重试在飞：本次被拒绝（不排队、不并发写同一账本）。' +
  '等上一次结束后再调。';

interface OpenedInstance {
  readonly projectKey: string;
  readonly host: Kojo2StorageHost;
  /** 打开时的 adapter 事实：会话内刷新沿用它（换 adapter = 换项目/换盘，不在刷新里猜） */
  readonly adapter: Kojo2StorageServiceAdapter;
}

/**
 * 被 recycled 挡下的那一次装配：打开与刷新都要能放行重试，所以记下**它本来要做什么**。
 * 重试必须重跑同一件事（刷新重跑刷新，不会退化成一次全量打开）。
 */
type PendingRetry =
  | { readonly kind: 'open'; readonly input: Kojo2StorageOpenInput }
  | { readonly kind: 'refresh'; readonly input: Kojo2StorageRefreshInput };

/** 装配结果（不含状态迁移 / 不含上屏）：open 与 refresh 共用同一条全序流水线 */
type Kojo2StorageAssembly =
  | {
      readonly kind: 'assembled';
      readonly projectKey: string;
      readonly ledgerKey: string;
      readonly host: Kojo2StorageHost;
      readonly registry: Kojo2StorageRegistry;
      readonly commit: Kojo2StorageCommitSuccess;
      readonly flush: Kojo2StorageHostFlushResult;
      readonly problems: readonly Kojo2StorageHostProblem[];
    }
  | {
      readonly kind: 'recycled';
      readonly projectKey: string;
      readonly ledgerKey: string;
      readonly host: Kojo2StorageHost;
      readonly total: number;
      readonly entries: readonly Kojo2StorageRecycledEntry[];
      readonly detail: string;
      readonly problems: readonly Kojo2StorageHostProblem[];
    }
  | {
      readonly kind: 'blocked';
      readonly stage: Kojo2StorageOpenStage;
      readonly projectKey: string;
      readonly ledgerKey: string | null;
      readonly problems: readonly Kojo2StorageHostProblem[];
    }
  | {
      readonly kind: 'skipped';
      readonly reason: 'no-documents' | 'documents-incomplete';
      readonly projectKey: string;
      readonly detail: string;
      readonly problems: readonly Kojo2StorageHostProblem[];
    };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function problemOf(
  code: string,
  message: string,
  severity: 'error' | 'warning' = 'error',
): Kojo2StorageHostProblem {
  return Object.freeze({ code, severity, message });
}

function freezeProblems(
  problems: readonly Kojo2StorageHostProblem[],
): readonly Kojo2StorageHostProblem[] {
  return problems.length === 0 ? NO_PROBLEMS : Object.freeze([...problems]);
}

/** 结果 → 问题面板条目（**码 / 文案原样**；落点统一为虚拟项目路径） */
function editorProblemsOf(
  problems: readonly Kojo2StorageHostProblem[],
): EditorProblem[] {
  return problems.map((problem) => ({
    path: KOJO2_STORAGE_SERVICE_PROBLEM_PATH,
    line: 1,
    severity: problem.severity,
    message: problem.message,
    code: problem.code,
    source: KOJO2_STORAGE_SERVICE_PROBLEM_SOURCE,
  }));
}

/* ============================== 工厂 ============================== */

/**
 * 创建槽位账本服务（一个实例 = 一个宿主接线点；同一时刻只持有一个项目实例）。
 *
 * 生命周期与 `App.tsx` 的项目 effect 同拍：项目打开 → `openProject`，项目关闭 / 换项目 →
 * `closeProject`。换项目在同一个服务上调用也可以（本模块先关旧再开新，账本按
 * `projectKey` 隔离，绝不串账）。
 */
export function createKojo2StorageService(
  options: Kojo2StorageServiceOptions,
): Kojo2StorageService {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('Kojo 2.0 槽位账本服务：createKojo2StorageService 需要 options 对象');
  }
  const kernel = options.kernel;
  if (
    kernel === null ||
    typeof kernel !== 'object' ||
    kernel.storage === null ||
    typeof kernel.storage !== 'object' ||
    typeof kernel.storage.global !== 'function'
  ) {
    throw new TypeError('Kojo 2.0 槽位账本服务：kernel 必须提供 storage.global()');
  }

  const isEnabled = options.isEnabled ?? isKojo2CutoverEnabled;
  const notify = options.notify;
  const writeProblems = options.writeProblems ?? setProblems;
  const now = options.now;
  const hash = options.hash;

  let instance: OpenedInstance | null = null;
  /** 被 recycled 挡下、可以显式放行的那一次装配（打开或刷新） */
  let pendingRetry: PendingRetry | null = null;
  let inFlight: 'open' | 'refresh' | 'close' | null = null;
  let phase: Kojo2StorageServiceSnapshot['phase'] = 'idle';
  let openCount = 0;
  let commitCount = 0;
  /** 问题簇里是否还挂着本服务写过的条目（会话内刷新无错时不必反复写空表） */
  let surfacedProblems = false;

  /** 开关读数（读炸 = 关：失败方向永远是“少露”） */
  function readEnabled(): boolean {
    try {
      return isEnabled() === true;
    } catch {
      return false;
    }
  }

  /**
   * 上屏（问题面板 + 一次通知）。**一次失败只调一次**：多阶段失败会被调用点合并成
   * 一个 `problems` 列表再进来；这里不做去重（去重会让两条同码不同文的失败少一条）。
   *
   * `action`（K2-STORAGE-RECYCLED-UI）：只有 recycled 阻断会带「放行重试」按钮；
   * 其余失败照旧纯文案。通知中心已有 action 支持，本模块不新造通知系统。
   */
  function surface(
    problems: readonly Kojo2StorageHostProblem[],
    action?: Kojo2StorageServiceAction,
  ): void {
    if (problems.length === 0) return;
    surfacedProblems = true;
    try {
      writeProblems(KOJO2_STORAGE_SERVICE_PROBLEM_PATH, editorProblemsOf(problems));
    } catch (error) {
      // 上屏通道本身坏掉时：不让它把存储流程带崩，但也不能一声不吭。
      console.error('[kojo2-storage] 槽位账本问题上屏失败：', error);
    }
    if (notify === undefined) return;
    const first = problems[0];
    if (first === undefined) return;
    const extra =
      problems.length > 1 ? `（另有 ${problems.length - 1} 条，详见问题面板）` : '';
    try {
      notify({
        kind: 'error',
        message: `${first.message}${extra}`,
        ...(action === undefined ? {} : { action }),
      });
    } catch (error) {
      console.error('[kojo2-storage] 槽位账本通知失败：', error);
    }
  }

  /** recycled 的唯一动作出口：文案固定，执行 = 显式放行后重跑同一件事（打开或刷新） */
  const RECYCLED_ACTION_LABEL = '放行回收并重试';
  function recycledAction(): Kojo2StorageServiceAction {
    return Object.freeze({
      label: RECYCLED_ACTION_LABEL,
      run: async () => {
        const result = await retryWithRecycledAllowed();
        // 陈旧动作（toast 还在、项目已关 / 已有人重试过）不能点了没反应：
        // 成功 / 失败已有各自的上屏路径，这里只补「其实没有可做的事」这一格。
        if (notify !== undefined && result.kind !== 'opened' && result.kind !== 'refreshed') {
          if (result.kind === 'nothing-to-retry' || result.kind === 'disabled') {
            try {
              notify({
                kind: 'info',
                message: '当前没有待放行的回收槽位（项目可能已关闭，或 Kojo 2.0 开关已关）。',
              });
            } catch (error) {
              console.error('[kojo2-storage] 槽位账本动作回执失败：', error);
            }
          }
        }
        return result;
      },
    });
  }

  /** 放行重试成功后的唯一庆功通知（问题簇已清，作者看得到「真的落账了」） */
  function announceRecovered(): void {
    if (notify === undefined) return;
    try {
      notify({
        kind: 'info',
        message: '已放行回收槽位并重试：槽位账本已提交，问题面板里的存储问题已清。',
      });
    } catch (error) {
      console.error('[kojo2-storage] 槽位账本成功通知失败：', error);
    }
  }

  /** flush 病态抛错 → 一条可上屏的队列失败（刷新时带进本次结果，不静默） */
  function queueFailureProblem(
    key: string,
    error: unknown,
  ): Kojo2StorageHostProblem {
    const failure: Kojo2StorageHostQueueFailure = Object.freeze({
      kind: 'write-failed',
      key,
      detail: errorText(error),
    });
    return kojo2StorageProblemOf(failure)[0] ?? problemOf(
      KOJO2_STORAGE_HOST_PROBLEM_CODES.writeBehindFailed,
      `槽位账本写盘队列失败：${errorText(error)}`,
    );
  }

  /** 项目开头的清账：上一轮 / 上一个项目留在这一格的问题不该跟过来 */
  function clearSurface(): void {
    surfacedProblems = false;
    try {
      writeProblems(KOJO2_STORAGE_SERVICE_PROBLEM_PATH, []);
    } catch (error) {
      console.error('[kojo2-storage] 槽位账本问题清账失败：', error);
    }
  }

  /**
   * 阻断结果：先上屏，再交回带同一份 problems 的结果。所有 `blocked` 必须从这里出，
   * 保证「结果里有几条 = 面板上有几条 = 通知只发一次」。
   */
  function blocked(
    stage: Kojo2StorageOpenStage,
    projectKey: string,
    ledgerKey: string | null,
    problems: readonly Kojo2StorageHostProblem[],
  ): Kojo2StorageBlocked {
    const frozen = freezeProblems(problems);
    surface(frozen);
    const first = frozen[0];
    return Object.freeze({
      kind: 'blocked',
      stage,
      projectKey,
      ledgerKey,
      detail: first?.message ?? `在「${stage}」阶段被挡下（未落账）`,
      problems: frozen,
    });
  }

  function busy(): Kojo2StorageBusy {
    return Object.freeze({ kind: 'busy', detail: BUSY_DETAIL });
  }

  const DISABLED: Kojo2StorageDisabled = Object.freeze({ kind: 'disabled' });

  /**
   * 关闭当前实例：flush（写盘失败上屏）→ 丢弃 → 清待重试。
   *
   * **不检查开关**：开关在打开之后被关掉时，已打开的账本仍然要 flush 掉再丢，
   * 否则队列里的写会跟着实例一起蒸发（那才是真正的静默丢数据）。
   */
  async function flushAndDiscard(): Promise<Kojo2StorageCloseResult> {
    const current = instance;
    pendingRetry = null;
    if (current === null) return Object.freeze({ kind: 'idle' });
    phase = 'closing';
    let flush: Kojo2StorageHostFlushResult;
    try {
      flush = await current.host.flush();
    } catch (error) {
      // 病态端口：flush 本不该抛（队列已兜错）。兜成一条可上屏的失败，照样丢弃实例。
      const failure: Kojo2StorageHostQueueFailure = Object.freeze({
        kind: 'write-failed',
        key: current.host.ledgerKey,
        detail: errorText(error),
      });
      const problems = freezeProblems(kojo2StorageProblemOf(failure));
      surface(problems);
      instance = null;
      return Object.freeze({
        kind: 'closed',
        projectKey: current.projectKey,
        ledgerKey: current.host.ledgerKey,
        flush: Object.freeze({ ok: false, failures: Object.freeze([failure]) }),
        problems,
      });
    }
    const problems = freezeProblems(
      flush.failures.flatMap((failure) => kojo2StorageProblemOf(failure)),
    );
    surface(problems);
    instance = null;
    return Object.freeze({
      kind: 'closed',
      projectKey: current.projectKey,
      ledgerKey: current.host.ledgerKey,
      flush,
      problems,
    });
  }

  /** 入参前置闸（纯读，零端口调用）；通过返回 null */
  function inputProblemOf(input: Kojo2StorageOpenInput): Kojo2StorageHostProblem | null {
    if (input === null || typeof input !== 'object') {
      return problemOf(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidInput,
        '槽位账本打开参数不是对象——已拒绝（零写）。',
      );
    }
    if (typeof input.projectKey !== 'string' || input.projectKey.length === 0) {
      return problemOf(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidInput,
        '槽位账本打开参数 projectKey 必须是非空字符串（账本按项目隔离的唯一依据）——已拒绝（零写）。',
      );
    }
    if (!Array.isArray(input.documents)) {
      return problemOf(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidInput,
        '槽位账本打开参数 documents 必须是数组——已拒绝（零写）。',
      );
    }
    const adapter = input.adapter;
    if (adapter === null || typeof adapter !== 'object') {
      return problemOf(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidInput,
        '槽位账本打开参数 adapter 必须是对象——已拒绝（零写）。',
      );
    }
    if (typeof adapter.gameFingerprint !== 'string' || adapter.gameFingerprint.length === 0) {
      return problemOf(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidInput,
        'adapter 未声明 gameFingerprint（空串 / 非字符串）：换盘检测会失效——已拒绝（零写），不猜。',
      );
    }
    if (!Array.isArray(adapter.storageClasses) || adapter.storageClasses.length === 0) {
      return problemOf(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidInput,
        'adapter 未声明 storageClasses（场景/存档/会话的槽位区段）：adapter 契约要求未声明即报错——' +
          '已拒绝（零写），不回退到预览区段。',
      );
    }
    return null;
  }

  /**
   * 全序装配（③–⑩）：**只算不落地**——不迁移 `instance`、不清问题簇、不上屏。
   *
   * 拆出来的理由：项目打开与会话内刷新共用同一条判据流水线，但状态迁移完全不同——
   * 打开成功才换实例；刷新失败必须保住已 opened 实例（fail-closed 但可见）。上屏由调用
   * 方合并「旧实例 flush 失败（carried）」后一次发出，避免同一次刷新弹两条。
   *
   * `allowRecycledSlots` 只由 `retryWithRecycledAllowed` 传 true；调用方负责 inFlight/phase。
   */
  async function assemble(
    input: Kojo2StorageOpenInput,
    allowRecycledSlots: boolean,
  ): Promise<Kojo2StorageAssembly> {
    const projectKey = input.projectKey;

    // ③ 文档清单完整性：不完整 ⇒ 零写跳过（把读不到当删除会回收槽位）
    if (input.documentsComplete === false) {
      return Object.freeze({
        kind: 'skipped',
        reason: 'documents-incomplete',
        projectKey,
        detail: '文档清单不完整，零写跳过。',
        problems: freezeProblems([
          problemOf(
            KOJO2_STORAGE_SERVICE_PROBLEM_CODES.documentsIncomplete,
            '本轮 .kojo2 文档清单不完整（有文件没读到或被截断）：槽位账本这一轮零写，' +
              '旧账本原样保留——把读不到的文件当成删除会回收它的槽位，等文件恢复后新声明会读到旧存档字节。',
            'warning',
          ),
        ]),
      });
    }
    if (input.documents.length === 0) {
      return Object.freeze({
        kind: 'skipped',
        reason: 'no-documents',
        projectKey,
        detail:
          '本项目本轮没有可参与槽位分配的 .kojo2 文档（首启 / 空工程）：零写，旧账本原样保留。',
        problems: NO_PROBLEMS,
      });
    }

    // ④ 建宿主（配置错误在这里抛，折成可判别失败）
    let host: Kojo2StorageHost;
    try {
      host = createKojo2StorageHost({
        storage: kernel.storage.global(),
        projectKey,
        ...(now === undefined ? {} : { now }),
        ...(hash === undefined ? {} : { hash }),
        ...(allowRecycledSlots ? { allowRecycledSlots: true } : {}),
      });
    } catch (error) {
      return Object.freeze({
        kind: 'blocked',
        stage: 'input',
        projectKey,
        ledgerKey: null,
        problems: freezeProblems([
          problemOf(
            KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidInput,
            `槽位账本宿主创建失败：${errorText(error)}——已拒绝（零写）。`,
          ),
        ]),
      });
    }

    // ⑤ 水合：读不动 / 读不懂 / 版本不认识 ⇒ 阻断（绝不把“没读成”当首启）
    const hydration = await host.hydrate();
    if (hydration.kind !== 'ok' && hydration.kind !== 'absent') {
      return Object.freeze({
        kind: 'blocked',
        stage: 'hydrate',
        projectKey,
        ledgerKey: host.ledgerKey,
        problems: freezeProblems(kojo2StorageProblemOf(hydration)),
      });
    }

    // ⑥ 上一份快照：absent = 首启/旧账无形状事实（继续，null）；invalid = 阻断
    const previous = host.loadPreviousSnapshot();
    if (previous.kind === 'invalid' || previous.kind === 'not-hydrated') {
      return Object.freeze({
        kind: 'blocked',
        stage: 'previous-snapshot',
        projectKey,
        ledgerKey: host.ledgerKey,
        problems: freezeProblems(kojo2StorageProblemOf(previous)),
      });
    }
    const previousSnapshot = previous.kind === 'ok' ? previous.snapshot : null;

    // ⑦ 注册表（纯 core）：装配失败 = 入参/文档问题，零写
    let registry: Kojo2StorageRegistry;
    try {
      registry = createKojo2StorageRegistry({
        documents: input.documents,
        storageClasses: input.adapter.storageClasses,
        gameFingerprint: input.adapter.gameFingerprint,
        previousSnapshot,
        ...(input.adapter.declarationKey === undefined
          ? {}
          : { declarationKey: input.adapter.declarationKey }),
      });
    } catch (error) {
      return Object.freeze({
        kind: 'blocked',
        stage: 'registry',
        projectKey,
        ledgerKey: host.ledgerKey,
        problems: freezeProblems([
          problemOf(
            KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidInput,
            `槽位注册表装配失败：${errorText(error)}——已拒绝（零写）。`,
          ),
        ]),
      });
    }

    // ⑧ 规划闸：`ok !== true` 时绝不调 commit（core 已经给出失败明细）
    const plan = registry.storagePlan;
    if (plan.ok !== true || plan.nextSnapshot === null) {
      const failures = plan.failures.map((failure) => ({
        kind: failure.kind,
        code: failure.diagnostic.code,
        message: failure.message,
      }));
      return Object.freeze({
        kind: 'blocked',
        stage: 'plan',
        projectKey,
        ledgerKey: host.ledgerKey,
        problems: freezeProblems(kojo2StorageProblemOf({
          kind: 'plan-not-ok',
          ok: false,
          failures,
          detail: `槽位规划失败（${failures.length} 条）`,
        })),
      });
    }

    // ⑨ 两阶段提交（recycled 默认零写阻断）
    const commit = host.commit({ registry, fingerprint: input.adapter.gameFingerprint });
    if (commit.kind === 'recycled-slots') {
      return Object.freeze({
        kind: 'recycled',
        projectKey,
        ledgerKey: host.ledgerKey,
        host,
        total: commit.total,
        entries: commit.entries,
        detail: commit.detail,
        problems: freezeProblems(kojo2StorageProblemOf(commit)),
      });
    }
    if (commit.kind !== 'committed') {
      return Object.freeze({
        kind: 'blocked',
        stage: 'commit',
        projectKey,
        ledgerKey: host.ledgerKey,
        problems: freezeProblems(kojo2StorageProblemOf(commit)),
      });
    }

    // ⑩ 等队列真正落盘：失败如实上屏，但实例仍算“已打开”（内存镜像已提交）
    const flush = await host.flush();
    return Object.freeze({
      kind: 'assembled',
      projectKey,
      ledgerKey: host.ledgerKey,
      host,
      registry,
      commit,
      flush,
      problems: freezeProblems(
        flush.failures.flatMap((failure) => kojo2StorageProblemOf(failure)),
      ),
    });
  }

  /**
   * 项目打开的全序（①–⑩）。`allowRecycledSlots` 只由 `retryWithRecycledAllowed` 传 true；
   * 调用方负责 `inFlight` / `phase`。
   */
  async function openWith(
    input: Kojo2StorageOpenInput,
    allowRecycledSlots: boolean,
  ): Promise<Kojo2StorageOpenResult> {
    // ① 入参闸：不碰端口，也不动旧实例（参数写错不该把已开的项目踢掉）
    const inputProblem = inputProblemOf(input);
    if (inputProblem !== null) {
      return blocked('input', String(input?.projectKey ?? ''), null, [inputProblem]);
    }
    const projectKey = input.projectKey;

    // ② 清旧账 + 关旧实例：换项目隔离；旧实例的 flush 失败照样上屏
    clearSurface();
    await flushAndDiscard();

    // ③–⑩ 装配：与刷新共用
    const assembly = await assemble(input, allowRecycledSlots);
    switch (assembly.kind) {
      case 'skipped':
        surface(assembly.problems);
        return Object.freeze({
          kind: 'skipped',
          reason: assembly.reason,
          projectKey,
          detail: assembly.detail,
          problems: assembly.problems,
        });
      case 'blocked':
        return blocked(assembly.stage, projectKey, assembly.ledgerKey, assembly.problems);
      case 'recycled':
        pendingRetry = Object.freeze({ kind: 'open', input });
        surface(assembly.problems, recycledAction());
        return Object.freeze({
          kind: 'recycled',
          projectKey,
          ledgerKey: assembly.ledgerKey,
          total: assembly.total,
          entries: assembly.entries,
          detail: assembly.detail,
          problems: assembly.problems,
        });
      case 'assembled':
        surface(assembly.problems);
        instance = Object.freeze({
          projectKey,
          host: assembly.host,
          adapter: input.adapter,
        });
        pendingRetry = null;
        openCount += 1;
        commitCount += 1;
        phase = 'open';
        return Object.freeze({
          kind: 'opened',
          projectKey,
          ledgerKey: assembly.ledgerKey,
          registry: assembly.registry,
          commit: assembly.commit,
          flush: assembly.flush,
          problems: assembly.problems,
        });
    }
  }

  /**
   * 会话内声明刷新（不进门闸；调用方负责 inFlight/phase）。核心纪律：
   * **旧实例只在「新账本提交 + flush」成功之后才被替换**；任何失败（清单不完整 / 注册表
   * 装配失败 / 规划失败 / recycled / 水合坏账）都原样保留已 opened 实例，失败本身照样上屏。
   *
   * 幂等：同槽位 + 同形状时 persister 返回 `changed=false` 并**零写**；这里照样返回
   * `refreshed`（commitCount 记一次），但盘面一个字节不动。
   */
  async function refreshWith(
    input: Kojo2StorageRefreshInput,
    allowRecycledSlots: boolean,
  ): Promise<Kojo2StorageRefreshResult> {
    const current = instance;
    if (current === null) {
      return Object.freeze({
        kind: 'nothing-to-refresh',
        detail:
          '当前没有已打开的槽位账本（项目未开成 / 首轮被挡下 / 已关闭）：本次刷新零动作。',
      });
    }
    if (input === null || typeof input !== 'object' || !Array.isArray(input.documents)) {
      return blocked('input', current.projectKey, current.host.ledgerKey, [
        problemOf(
          KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidInput,
          '槽位账本刷新参数 documents 必须是数组——已拒绝（零写），已打开的账本原样保留。',
        ),
      ]);
    }
    // 新一轮刷新 = 新判据：上一次 recycled 的待重试输入已经过期，先销账；只有本次又
    // recycled 才重新记下（否则陈旧动作会拿旧文档清单重跑，跟作者刚改的文件对不上）。
    if (pendingRetry !== null && pendingRetry.kind === 'refresh') pendingRetry = null;

    // 旧实例的写队列先排空：可能还攒着上次 flush 失败的写。失败带进本次结果（不静默），
    // 但**不阻断刷新**——盘上判据由下面新宿主重新水合，尽量把该写的补写掉。
    const carried: Kojo2StorageHostProblem[] = [];
    try {
      const flushed = await current.host.flush();
      carried.push(...flushed.failures.flatMap((failure) => kojo2StorageProblemOf(failure)));
    } catch (error) {
      carried.push(queueFailureProblem(current.host.ledgerKey, error));
    }

    const assembly = await assemble(
      {
        projectKey: current.projectKey,
        documents: input.documents,
        adapter: current.adapter,
        ...(input.documentsComplete === undefined
          ? {}
          : { documentsComplete: input.documentsComplete }),
      },
      allowRecycledSlots,
    );

    switch (assembly.kind) {
      case 'assembled': {
        const problems = freezeProblems([...assembly.problems, ...carried]);
        // 只有走到这里才换实例：提交与 flush 都已完成，旧实例的队列也已排空
        instance = Object.freeze({
          projectKey: current.projectKey,
          host: assembly.host,
          adapter: current.adapter,
        });
        pendingRetry = null;
        commitCount += 1;
        phase = 'open';
        // 刷新成功只在「这一簇真的挂着本服务的旧条目」时清账，避免每次击键都写一次空表
        if (problems.length > 0) surface(problems);
        else if (surfacedProblems) clearSurface();
        return Object.freeze({
          kind: 'refreshed',
          projectKey: current.projectKey,
          ledgerKey: assembly.ledgerKey,
          commit: assembly.commit,
          flush: assembly.flush,
          problems,
        });
      }
      case 'recycled': {
        const problems = freezeProblems([...assembly.problems, ...carried]);
        pendingRetry = Object.freeze({ kind: 'refresh', input });
        surface(problems, recycledAction());
        return Object.freeze({
          kind: 'recycled',
          projectKey: current.projectKey,
          ledgerKey: assembly.ledgerKey,
          total: assembly.total,
          entries: assembly.entries,
          detail: assembly.detail,
          problems,
        });
      }
      case 'blocked': {
        // 失败不拆已 opened 状态：instance 原样（宿主与账本键都不动）
        const problems = freezeProblems([...assembly.problems, ...carried]);
        return blocked(assembly.stage, current.projectKey, assembly.ledgerKey, problems);
      }
      case 'skipped': {
        const problems = freezeProblems([...assembly.problems, ...carried]);
        surface(problems);
        return Object.freeze({
          kind: 'skipped',
          reason: assembly.reason,
          projectKey: current.projectKey,
          detail: assembly.detail,
          problems,
        });
      }
    }
  }

  /** 会话内刷新的公开门面：开关 / 并发 / 有无实例三道闸；异常折成可上屏 blocked */
  async function refreshDeclarations(
    input: Kojo2StorageRefreshInput,
  ): Promise<Kojo2StorageRefreshResult> {
    const enabled = readEnabled();
    if (!enabled) {
      phase = 'disabled';
      return DISABLED;
    }
    if (inFlight !== null) return busy();
    if (instance === null) {
      return Object.freeze({
        kind: 'nothing-to-refresh',
        detail:
          '当前没有已打开的槽位账本（项目未开成 / 首轮被挡下 / 已关闭）：本次刷新零动作。',
      });
    }
    const current = instance;
    inFlight = 'refresh';
    phase = 'opening';
    try {
      return await refreshWith(input, false);
    } catch (error) {
      return unexpected(current.projectKey, current.host.ledgerKey, error);
    } finally {
      inFlight = null;
      phase = instance === null ? (enabled ? 'idle' : 'disabled') : 'open';
    }
  }

  /** 内部兜底：任何未预期异常都折成可上屏的 `blocked`，绝不漏进渲染链 */
  function unexpected(
    projectKey: string,
    ledgerKey: string | null,
    error: unknown,
  ): Kojo2StorageBlocked {
    return blocked('unexpected', projectKey, ledgerKey, [
      problemOf(
        KOJO2_STORAGE_SERVICE_PROBLEM_CODES.unexpected,
        `槽位账本装配出现未预期异常：${errorText(error)}——本次零写，账本原样保留。`,
      ),
    ]);
  }

  async function openProject(
    input: Kojo2StorageOpenInput,
  ): Promise<Kojo2StorageOpenResult> {
    const enabled = readEnabled();
    if (!enabled) {
      phase = 'disabled';
      return DISABLED;
    }
    if (inFlight !== null) return busy();
    const projectKey =
      input !== null && typeof input === 'object' && typeof input.projectKey === 'string'
        ? input.projectKey
        : '';
    inFlight = 'open';
    phase = 'opening';
    try {
      return await openWith(input, false);
    } catch (error) {
      return unexpected(projectKey, instance?.host.ledgerKey ?? null, error);
    } finally {
      inFlight = null;
      phase = instance === null ? (enabled ? 'idle' : 'disabled') : 'open';
    }
  }

  async function closeProject(): Promise<Kojo2StorageCloseResult> {
    const enabled = readEnabled();
    // 在飞先答：此时报 disabled 会让调用方以为"没东西可关"，而这一次 open 可能正要落账。
    if (inFlight !== null) return busy();
    // 没有实例且开关关着 ⇒ 本模块从未参与（零动作）
    if (instance === null && !enabled) {
      phase = 'disabled';
      return DISABLED;
    }
    inFlight = 'close';
    phase = 'closing';
    const closing = instance;
    try {
      return await flushAndDiscard();
    } catch (error) {
      // flushAndDiscard 自带 flush 兜底；这一层只防“上报/清账”本身出病态错。
      // 实例无论如何都要丢（关项目不能因为一条通知通道坏掉就留住旧队列）。
      instance = null;
      pendingRetry = null;
      const failure: Kojo2StorageHostQueueFailure = Object.freeze({
        kind: 'write-failed',
        key: closing?.host.ledgerKey ?? '',
        detail: errorText(error),
      });
      const problems = freezeProblems(kojo2StorageProblemOf(failure));
      surface(problems);
      return Object.freeze({
        kind: 'closed',
        projectKey: closing?.projectKey ?? '',
        ledgerKey: closing?.host.ledgerKey ?? '',
        flush: Object.freeze({ ok: false, failures: Object.freeze([failure]) }),
        problems,
      });
    } finally {
      inFlight = null;
      phase = instance === null ? (enabled ? 'idle' : 'disabled') : 'open';
    }
  }

  async function retryWithRecycledAllowed(): Promise<Kojo2StorageRetryResult> {
    const enabled = readEnabled();
    if (!enabled) {
      phase = 'disabled';
      return DISABLED;
    }
    if (inFlight !== null) return busy();
    const pending = pendingRetry;
    if (pending === null) {
      return Object.freeze({ kind: 'nothing-to-retry' });
    }
    inFlight = 'open';
    phase = 'opening';
    try {
      // 同一件事重跑：打开被挡下的重跑打开，刷新被挡下的重跑刷新（不降级/不升级）
      const result =
        pending.kind === 'open'
          ? await openWith(pending.input, true)
          : await refreshWith(pending.input, true);
      if (result.kind !== 'recycled') pendingRetry = null;
      // 成功 = 问题簇已被成功路径清掉（openWith 开头清账 / refreshWith 成功后清账）；
      // 只有「真的没有残留失败」才报喜，flush 失败仍按失败面上屏。
      if (
        (result.kind === 'opened' || result.kind === 'refreshed') &&
        result.problems.length === 0
      ) {
        announceRecovered();
      }
      return result;
    } catch (error) {
      const projectKey =
        pending.kind === 'open' ? pending.input.projectKey : instance?.projectKey ?? '';
      return unexpected(projectKey, instance?.host.ledgerKey ?? null, error);
    } finally {
      inFlight = null;
      phase = instance === null ? (enabled ? 'idle' : 'disabled') : 'open';
    }
  }

  function getSnapshot(): Kojo2StorageServiceSnapshot {
    return Object.freeze({
      phase,
      projectKey: instance?.projectKey ?? null,
      ledgerKey: instance?.host.ledgerKey ?? null,
      openCount,
      commitCount,
    });
  }

  return Object.freeze({
    openProject,
    refreshDeclarations,
    closeProject,
    retryWithRecycledAllowed,
    host(): Kojo2StorageHost | null {
      return instance?.host ?? null;
    },
    getSnapshot,
  });
}
