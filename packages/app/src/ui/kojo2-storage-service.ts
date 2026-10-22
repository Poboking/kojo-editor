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
 * 存储面不静默）。宿主（`App.tsx`）只需要在两件事上叫它：项目打开、项目关闭。
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

/** 通知端口（与 `NotificationCenter.Notify` 结构兼容；本模块不 import React/tsx） */
export type Kojo2StorageServiceNotify = (notice: {
  readonly kind: 'info' | 'error';
  readonly message: string;
  readonly detail?: string;
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
  | { readonly kind: 'nothing-to-retry' };

/** 可判别读数（宿主 / 测试据此核对「到底有没有实例、账本落在哪个键」） */
export interface Kojo2StorageServiceSnapshot {
  readonly phase: 'idle' | 'opening' | 'open' | 'closing' | 'disabled';
  readonly projectKey: string | null;
  readonly ledgerKey: string | null;
  /** 累计成功打开次数（`opened` 才算；blocked / skipped 不计） */
  readonly openCount: number;
  /** 累计落账提交次数（`commit.kind === 'committed'` 才算；幂等命中也算一次） */
  readonly commitCount: number;
}

export interface Kojo2StorageService {
  /** 项目打开：全序装配 + 落账。**永不抛**（异常折成 `blocked`/`unexpected`）。 */
  openProject(input: Kojo2StorageOpenInput): Promise<Kojo2StorageOpenResult>;
  /** 项目关闭：flush 后丢弃实例；flush 失败照样上屏。 */
  closeProject(): Promise<Kojo2StorageCloseResult>;
  /**
   * 对上一次 `recycled` 的装配**显式放行**槽位回收（`allowRecycledSlots: true`）后重跑。
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
  'Kojo 2.0 槽位账本上已有一次打开/关闭/重试在飞：本次被拒绝（不排队、不并发写同一账本）。' +
  '等上一次结束后再调。';

interface OpenedInstance {
  readonly projectKey: string;
  readonly host: Kojo2StorageHost;
}

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
  /** 被 recycled 挡下、可以显式放行的那一次装配 */
  let pendingRetry: Kojo2StorageOpenInput | null = null;
  let inFlight: 'open' | 'close' | null = null;
  let phase: Kojo2StorageServiceSnapshot['phase'] = 'idle';
  let openCount = 0;
  let commitCount = 0;

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
   */
  function surface(problems: readonly Kojo2StorageHostProblem[]): void {
    if (problems.length === 0) return;
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
      notify({ kind: 'error', message: `${first.message}${extra}` });
    } catch (error) {
      console.error('[kojo2-storage] 槽位账本通知失败：', error);
    }
  }

  /** 项目开头的清账：上一轮 / 上一个项目留在这一格的问题不该跟过来 */
  function clearSurface(): void {
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
   * 真正的全序装配。`allowRecycledSlots` 只由 `retryWithRecycledAllowed` 传 true；
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

    // ③ 文档清单完整性：不完整 ⇒ 零写跳过（把读不到当删除会回收槽位）
    if (input.documentsComplete === false) {
      const problems = freezeProblems([
        problemOf(
          KOJO2_STORAGE_SERVICE_PROBLEM_CODES.documentsIncomplete,
          '本轮 .kojo2 文档清单不完整（有文件没读到或被截断）：槽位账本这一轮零写，' +
            '旧账本原样保留——把读不到的文件当成删除会回收它的槽位，等文件恢复后新声明会读到旧存档字节。',
          'warning',
        ),
      ]);
      surface(problems);
      return Object.freeze({
        kind: 'skipped',
        reason: 'documents-incomplete',
        projectKey,
        detail: '文档清单不完整，零写跳过。',
        problems,
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
      return blocked('input', projectKey, null, [
        problemOf(
          KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidInput,
          `槽位账本宿主创建失败：${errorText(error)}——已拒绝（零写）。`,
        ),
      ]);
    }

    // ⑤ 水合：读不动 / 读不懂 / 版本不认识 ⇒ 阻断（绝不把“没读成”当首启）
    const hydration = await host.hydrate();
    if (hydration.kind !== 'ok' && hydration.kind !== 'absent') {
      return blocked('hydrate', projectKey, host.ledgerKey, kojo2StorageProblemOf(hydration));
    }

    // ⑥ 上一份快照：absent = 首启/旧账无形状事实（继续，null）；invalid = 阻断
    const previous = host.loadPreviousSnapshot();
    if (previous.kind === 'invalid' || previous.kind === 'not-hydrated') {
      return blocked(
        'previous-snapshot',
        projectKey,
        host.ledgerKey,
        kojo2StorageProblemOf(previous),
      );
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
      return blocked('registry', projectKey, host.ledgerKey, [
        problemOf(
          KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidInput,
          `槽位注册表装配失败：${errorText(error)}——已拒绝（零写）。`,
        ),
      ]);
    }

    // ⑧ 规划闸：`ok !== true` 时绝不调 commit（core 已经给出失败明细）
    const plan = registry.storagePlan;
    if (plan.ok !== true || plan.nextSnapshot === null) {
      const failures = plan.failures.map((failure) => ({
        kind: failure.kind,
        code: failure.diagnostic.code,
        message: failure.message,
      }));
      return blocked('plan', projectKey, host.ledgerKey, kojo2StorageProblemOf({
        kind: 'plan-not-ok',
        ok: false,
        failures,
        detail: `槽位规划失败（${failures.length} 条）`,
      }));
    }

    // ⑨ 两阶段提交（recycled 默认零写阻断）
    const commit = host.commit({ registry, fingerprint: input.adapter.gameFingerprint });
    if (commit.kind === 'recycled-slots') {
      pendingRetry = input;
      const problems = freezeProblems(kojo2StorageProblemOf(commit));
      surface(problems);
      return Object.freeze({
        kind: 'recycled',
        projectKey,
        ledgerKey: host.ledgerKey,
        total: commit.total,
        entries: commit.entries,
        detail: commit.detail,
        problems,
      });
    }
    if (commit.kind !== 'committed') {
      return blocked('commit', projectKey, host.ledgerKey, kojo2StorageProblemOf(commit));
    }

    // ⑩ 等队列真正落盘：失败如实上屏，但实例仍算“已打开”（内存镜像已提交）
    const flush = await host.flush();
    const problems = freezeProblems(
      flush.failures.flatMap((failure) => kojo2StorageProblemOf(failure)),
    );
    surface(problems);

    instance = Object.freeze({
      projectKey,
      host,
    });
    pendingRetry = null;
    openCount += 1;
    commitCount += 1;
    phase = 'open';

    return Object.freeze({
      kind: 'opened',
      projectKey,
      ledgerKey: host.ledgerKey,
      registry,
      commit,
      flush,
      problems,
    });
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
      const result = await openWith(pending, true);
      if (result.kind !== 'recycled') pendingRetry = null;
      return result;
    } catch (error) {
      return unexpected(pending.projectKey, instance?.host.ledgerKey ?? null, error);
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
    closeProject,
    retryWithRecycledAllowed,
    host(): Kojo2StorageHost | null {
      return instance?.host ?? null;
    },
    getSnapshot,
  });
}
