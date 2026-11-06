/**
 * MCP 外部写盘感知（Wave4 余项 ③）：把「盘上这份还是不是刚读到的那份」变成可见事实。
 *
 * 判性（先量清真实现状，再选档）：
 * - 传输层是**无状态单请求** HTTP（`POST /mcp`，一次请求一条应答；SSE 只服务当次请求），
 *   所以 MCP 协议级 `notifications/resources/updated` **推不出去**。能力面因此继续说真话：
 *   `resources.subscribe:false` / `listChanged:false` **不抬**（`tools/mcp-conformance.mjs`
 *   P5 边界仍在断言这两条）。本批选的是**on-request 标注**那一档：失效事实只在你读取时给。
 * - 真实现状（改前）：`file.changed` 只进宿主 UI 与 MCP 的通用事件环（相对 `performance.now()`
 *   时刻、fire-and-forget、无路径判定），`file.watchState` 是 **KERNEL_ONLY** 事件，压根不进
 *   MCP 事件环 ⇒ 客户端读出任何一条只读应答，都无法判断「我刚读的资源可能已不是盘上那份」。
 *
 * 真源（全部现成，本模块只做「订阅 + 有界短账 + 如实标注」，不新建写通道、不碰写语义）：
 * - `kernel.fileWatch.state()` → `FileWatchStateEvent{status, roots, failures}`：
 *   内核 `start_watch` 回执的宿主侧形态，**「哪些根没监视上、为什么」正在这里**；
 * - 总线 `file.watchState`（KERNEL_ONLY，本模块直接 `bus.on` 订阅，不经插件白名单）：
 *   `state()` 不可用时的次级真源 + 状态跃迁计数；
 * - 总线 `file.changed{kind,path}`（内核监视器去抖后的原样路径）：改动时刻与类别；
 * - 本模块自身的自写记账（`noteSelfWrite`，与写腿 `emitFileChanged` 同一调用栈 ⇒ 精确归因）。
 *
 * 铁律 4「不静默」的落点：
 * - `stale` 三值：`true` / `false` / `null`；**`null` 必带 `staleReason`** 说明缺的是哪一环
 *   （监视不可用 / 路径不在监视域 / 会话内没有上一次读取可比 / 账本截断到该条之前）。
 *   绝不用乐观的 `false`、绝不用空串或默认值假装有；
 * - 两张账都有容量与 `dropped` 计数：溢出即 `truncated:true` + `dropped:n`，
 *   并且**溢出会反过来降低判定强度**（被判掉的条目不再支持 `stale:false`，改判 `null`）；
 * - 订阅本身是否接上、`state()` 是否存在，一律进 `sources` 逐条可见。
 *
 * 纪律：只被 MCP 运行时装载（`real-sources*.ts` 动态 import 链内），不进 ps10 开机静态图；
 * 顶层只 import `@kojo/plugin-api` 的纯路径工具与 `@kojo/mcp-host` 的类型/文本闸。
 *
 * B8（2026-11-06，BOARD 卡 MCP-WAVE4-RESIDUE-C）：**按需 mtime 复核**，收口一处在册假阴性。
 * - 现状（本批之前）：自写后 `SELF_WRITE_ECHO_WINDOW_MS` 回声窗内，同路径的**真实外部写**
 *   会被 `onChangeEvent` 并条、**不推序号**（同一事实不重复计数的必然代价）⇒ 下一次读它
 *   谎报 `stale:false`，其实盘上已经变了；
 * - 出路：窗内且路径命中时多走**一趟真 stat**（`@kojo/plugin-api` FileIO 契约的
 *   `stat` / `statFiles`：只读、不受写允许域约束、N 个路径一趟）把「序号没推」这件事证伪
 *   或证实；`mtime`/`size` 晚于或不同于自写回声基线 ⇒ 那笔外部写**推进改动账**并如实归因
 *   `unattributed`（证明不了是谁写的），判定 `stale:true`；
 * - 判不了就 `stale:null` + `staleReason`：seam 缺席 / stat 抛错 / `mtimeMs:null` /
 *   「取不到与不存在合一」（Rust `metadata(...).ok()` 两态不分离）/ 复核在途 ⇒ 一律 null，
 *   **绝不乐观 `false`、绝不 `true` 乱报**；
 * - 成本：窗外 / 非同路径 / 判定已 `true` 或已 `null` ⇒ **零额外 syscall**；一次读数里
 *   多路径命中 ⇒ **只发一趟** `statFiles`（候选集 = 窗内自写回声记忆，按窗裁剪、不扫全量）；
 * - 有界：复核侧自己一张账（容量沿用 `CHANGE_LEDGER_CAPACITY`，溢出 `dropped`/`truncated`
 *   可见），两张旧账的容量与溢出降档口径**一字不变**；能力面真值不动
 *   （`subscribe:false` / `listChanged:false`，推不出去这件事与本批无关）。
 * - 两条入口：`verdictOf` / `listingOf`（同步，今日只读腿在用）在窗内**不再乐观 false**，
 *   改为「发起复核 + 本档 `stale:null`（在途）」，结论落账后下一次读即定档；
 *   `verdictOfRechecked` / `listingOfRechecked` / `verdictsOfRechecked`（异步，批量一趟）
 *   在同一次读数里就把结论给出来——只读腿改用异步入口要动 `real-sources-io.ts` 的
 *   `fsFreshnessField` / `fsFreshnessListing`（每处一个 `await`），本批不越他线文件边界。
 */
import { isPathUnder, pathKey } from '@kojo/plugin-api';
import type { McpSessionScope } from '@kojo/mcp-host';

/* ------------------------------- 容量（有界，别无限增长） ------------------------------- */

/** 改动账容量：按「最近改过的路径」保留，超出即整条淘汰并记账。 */
export const CHANGE_LEDGER_CAPACITY = 2000;
/** 读取账容量：按「会话 × 路径」保留最近一次经本宿主读到的盘态。 */
export const READ_LEDGER_CAPACITY = 2000;
/** 淘汰键位记忆容量（用于把「无法判定」说准，而不是假称「没读过」）。 */
export const EVICTED_KEY_LIMIT = 512;
/**
 * 自写回声窗口：写腿广播是同步的（精确归因走调用栈），但内核监视器约 200ms 去抖后会
 * **再报一次同一路径**。窗口内同路径的事件标注为 `mcp-write-echo` 并归给原写会话；
 * 窗口外一律 `unattributed`（无法证明是谁写的，可能是外部进程 / 真人保存）。
 *
 * B8：窗口本身一字未改（值 = 依据「监视器去抖 ~200ms + 一次写的事件余量」，改它要给新依据）。
 * 改的是**窗内的判据强度**：窗内同路径并条不推序号 ⇒ 旧实现到此为止就报 `stale:false`，
 * 现在窗内命中必须过一趟 mtime 复核才允许给 false（复核做不了 ⇒ `null` + 理由）。
 */
export const SELF_WRITE_ECHO_WINDOW_MS = 5_000;
/**
 * 复核账容量：**沿用** `CHANGE_LEDGER_CAPACITY`（不另立旋钮），只是第三张账的名字。
 * 存「最近一次 mtime 复核观察到的盘态指纹」，用于①同一笔外部写只记一条、②两次窗内读数
 * 之间的漂移检测；溢出与另两张账同口径可见（`dropped` / `truncated`）。
 */
export const RECHECK_LEDGER_CAPACITY = CHANGE_LEDGER_CAPACITY;

/* ------------------------------- 对外形状 ------------------------------- */

export type FsChangeOrigin = 'mcp-write' | 'mcp-write-echo' | 'unattributed';

/** 监视覆盖视图（真源 = `kernel.fileWatch.state()`，次源 = 总线 `file.watchState`）。 */
export interface FsWatchCoverage {
  /** 监视此刻是否可信：只有 `watching` / `partial` 才算可信覆盖。 */
  readonly usable: boolean;
  /** `watching|partial|unavailable|reconnecting|stopped|unknown`（未知 = 真源缺席）。 */
  readonly status: string;
  /** 真源出处（缺席即 `absent`，绝不当成「监视正常」）。 */
  readonly source: 'kernel.fileWatch.state' | 'bus.file.watchState' | 'absent';
  /** 实际监视中的根（绝对路径，原样来自回执）。 */
  readonly roots: readonly string[];
  /** 没监视上的根与原因（`start_watch` 回执的 `failed[]` 形态）。 */
  readonly unwatchedRoots: readonly { readonly root: string; readonly reason: string }[];
  /** 真源缺席 / 不可信时的白话理由（`usable` 为假时必给）。 */
  readonly reason: string | null;
}

/** 一张账的有界读数（截断必须可见）。 */
export interface FsLedgerCounters {
  readonly capacity: number;
  readonly size: number;
  readonly dropped: number;
  readonly truncated: boolean;
}

/**
 * mtime 复核的盘态探针读数（`FileStat` / `BatchFileStat` 的共同子集，契约真源
 * `@kojo/plugin-api` io.ts:185/199）。字段一律可缺 / 可 null：**取不到就是取不到**，
 * 不拿 0 兜底（与内核文本缓存的新鲜度判据同尺 = `mtimeMs` + `size` 双等）。
 */
export interface FsFreshnessProbe {
  /** 批量面（`BatchFileStat`）给这个字段；单路径面靠「返回 null」表达不在位。 */
  readonly exists?: boolean;
  readonly mtimeMs?: number | null;
  readonly size?: number | null;
}

/** 复核结论的出处档（`recheck` 字段自述这格判定是谁给的）。 */
export type FsFreshnessRecheckBasis =
  /** 复核已完成并给了结论（`stale:false` 由它作证，不是「监视没报到」）。 */
  | 'mtime-recheck'
  /** 同步判定器发起了复核但本次读数等不到结论 ⇒ 本次一律 `stale:null`。 */
  | 'recheck-pending'
  /** 复核做不了（注入面没有 stat 通道 / 复核队列已满）⇒ 本次 `stale:null`。 */
  | 'recheck-unavailable';

export type FsFreshnessRecheckOutcome = 'unchanged' | 'changed' | 'unknown' | 'pending';

/** 单个复核目标的读数（逐条可见，别让「复核过」成为一个不可审计的黑盒）。 */
export interface FsFreshnessRecheckProbe {
  readonly path: string;
  readonly exists: boolean;
  readonly mtimeMs: number | null;
  readonly size: number | null;
  readonly outcome: Exclude<FsFreshnessRecheckOutcome, 'pending'>;
  /** 这一条为什么是这个结论（`changed` 时即「凭什么说盘上又动了」）。 */
  readonly reason: string | null;
}

/**
 * 一次读数里的按需 mtime 复核读数（`FsFreshnessVerdict.recheck`）。
 * `null` = 本次判定**没走**复核：窗外 / 非同路径 / 判定已 `true` 或已 `null`
 * （复核只钉「并条可能谎报没变」这一档，不接管「监视不可信」那条欠账）。
 */
export interface FsFreshnessRecheck {
  /** 复核是否已经给出结论（同步档的「在途」= `false`）。 */
  readonly performed: boolean;
  readonly basis: FsFreshnessRecheckBasis | null;
  readonly outcome: FsFreshnessRecheckOutcome;
  /** 本次读数在窗内命中的路径笔数（= 候选集大小，0 时不会有 recheck 字段）。 */
  readonly targets: number;
  /** 为这次读数发出的 `stat` / `statFiles` **趟数**（批量一趟 = 1；窗外的读数 = 0）。 */
  readonly trips: number;
  /** 多目标是否并进了同一趟 `statFiles`（没有批量通道时如实 `false` = 逐条付）。 */
  readonly batched: boolean;
  /** 复核所依据的自写回声基线时刻（窗内最早那笔；无自写记忆 ⇒ `null`，理论上不进入复核）。 */
  readonly selfWriteAtMs: number | null;
  /** 结论白话：`unchanged` 说清凭什么、`changed` 说清是哪条、`unknown` / `pending` 说清缺哪一环。 */
  readonly reason: string | null;
  readonly probes: readonly FsFreshnessRecheckProbe[];
}

/** 一次失效判定的完整标注（挂进只读应答的 `fsFreshness` 字段）。 */
export interface FsFreshnessVerdict {
  /** 判定器本身是否装上了（假件 / 未装配宿主 ⇒ `false` + `reason`）。 */
  readonly available: boolean;
  /** `true`=你上一次从这里读到的那份之后盘上又动了；`false`=覆盖可信且无后续改动；`null`=判不了。 */
  readonly stale: boolean | null;
  /** `stale:null` 时**必给**：缺的是哪一环（不静默）。 */
  readonly staleReason: string | null;
  /** 判定目标（项目根内相对路径；根外/无根时为原样路径，不编造相对形态）。 */
  readonly target: string;
  /** 判定粒度：单文件读取 / 目录列举（含检索与文件树）。 */
  readonly granularity: 'file' | 'listing';
  /** 本次应答的墙钟：给出的内容就是这一刻的盘态（`stale` 说的是**上一次**那份）。 */
  readonly atMs: number;
  /** 本会话上一次经本宿主读到该目标的墙钟（无记录 ⇒ `null`）。 */
  readonly previousReadAtMs: number | null;
  /** 该目标最近一次被观测到的改动时刻（账里没有 ⇒ `null`，不是「没改过」）。 */
  readonly changedAtMs: number | null;
  readonly changeKind: string | null;
  readonly changeOrigin: FsChangeOrigin | null;
  /** 监视域是否覆盖该目标（`roots` 逐条 `isPathUnder`）。 */
  readonly tracked: boolean;
  readonly watched: boolean;
  readonly watchStatus: string;
  readonly watchStateSource: FsWatchCoverage['source'];
  readonly unwatchedRoots: readonly { readonly root: string; readonly reason: string }[];
  /** 覆盖不足的具体一环：目标落在「没监视上的根」里时给出来自回执的原话。 */
  readonly unwatchedRootMatch: { readonly root: string; readonly reason: string } | null;
  /** 事件/真源接入面逐条可见（铁律 4：「事件没接上」本身是读数）。 */
  readonly sources: {
    readonly fileChangedSubscribed: boolean;
    readonly watchStateSubscribed: boolean;
    readonly fileWatchStateApi: boolean;
  };
  readonly changedSincePreviousRead: number;
  readonly ledger: {
    readonly changes: FsLedgerCounters;
    readonly reads: FsLedgerCounters;
  };
  /**
   * B8 按需 mtime 复核的读数（缺席 = 本次判定没走复核，判据回到事件流；
   * 有值 = 这格 `stale` 是复核给/否掉的，客户端由此区分「监视证明没变」与「复核证明没变」）。
   */
  readonly recheck: FsFreshnessRecheck | null;
}

/** `kojo://project/fs-freshness` 的账本读数（判定 + 三张账 + 能力面自述）。 */
export interface FsFreshnessReport {
  readonly generatedAtMs: number;
  readonly push: {
    readonly notificationsResourcesUpdated: false;
    readonly subscribe: false;
    readonly listChanged: false;
    readonly mode: 'on-request';
    readonly reason: string;
  };
  readonly watch: FsWatchCoverage;
  readonly sources: FsFreshnessVerdict['sources'];
  readonly counters: {
    readonly changeEventsSeen: number;
    readonly watchStateEventsSeen: number;
    readonly selfWritesSeen: number;
    readonly readsRecorded: number;
    readonly seq: number;
    /** B8：此刻仍在回声窗内的自写记忆笔数（复核候选集的上界，按窗裁剪）。 */
    readonly selfWritesInWindow: number;
    /** B8：发起过的复核**批次数**（一次读数的多路径 = 1 批次）。 */
    readonly mtimeRecheckRuns: number;
    /** B8：发出的 `stat` / `statFiles` **趟数**（成本判据的总账；窗外读数不涨这一格）。 */
    readonly mtimeRecheckStatCalls: number;
    /** B8：被探针核过的路径笔数（批次的逐条计数）。 */
    readonly mtimeRecheckProbedPaths: number;
    /** B8：复核核出并被推进改动账的真实外部写笔数。 */
    readonly mtimeRecheckChangesRecorded: number;
    /** B8：复核做不了的次数（seam 缺席 / stat 抛错 / mtime 取不到 / 队列满）。 */
    readonly mtimeRecheckUnavailable: number;
    /** B8：此刻在途的复核批次数（同步判定器发起后尚未落账）。 */
    readonly mtimeRecheckPending: number;
  };
  readonly ledger: {
    readonly changes: FsLedgerCounters & {
      readonly listed: number;
      readonly evictedHighSeq: number;
      readonly entries: readonly Record<string, unknown>[];
    };
    readonly reads: FsLedgerCounters & {
      readonly listed: number;
      readonly evictedHighSeq: number;
      readonly entries: readonly Record<string, unknown>[];
    };
    /** B8 复核侧的记忆（第三张账：容量沿用 `CHANGE_LEDGER_CAPACITY`，两张旧账口径一字不变）。 */
    readonly rechecks: FsLedgerCounters & {
      readonly listed: number;
      readonly evictedHighSeq: number;
      readonly entries: readonly Record<string, unknown>[];
    };
    readonly evictedKeys: {
      readonly changes: number;
      readonly reads: number;
      readonly rechecks: number;
      readonly truncated: boolean;
    };
  };
  readonly annotatedTools: readonly string[];
  readonly notAnnotated: readonly { readonly target: string; readonly reason: string }[];
}

/* ------------------------------- 注入面 ------------------------------- */

/**
 * B8 复核用的只读 stat 通道（真源 = `@kojo/plugin-api` `FileIO` 契约的 `stat` / `statFiles`：
 * io.ts:185 单路径、:199 批量「N 个路径一趟」，:196 明确只读操作**不受写允许域约束**）。
 * 这里按结构取两枚方法的最小子集（`FileStat` / `BatchFileStat` 都能塞进来），
 * 假件与精简桥可缺席 ⇒ 窗内读数落到 `stale:null` +「注入面没有 stat 通道」，绝不乐观 false。
 */
export interface FsFreshnessStatIo {
  /**
   * 宿主侧 `io` 投影的其余成员（本模块**不碰**）。声明它只为让这份投影与真
   * `McpKernelLike.io` 同构可赋值——`bindFsFreshness(kernel)` 那条调用点在
   * `real-sources.ts`（他线文件），本批不为了接探针去改它的类型口径。
   */
  readonly walkDir?: (path: string, opts?: Record<string, unknown>) => Promise<unknown[]>;
  readonly stat?: (path: string) => Promise<FsFreshnessProbe | null> | FsFreshnessProbe | null;
  readonly statFiles?: (
    paths: readonly string[],
  ) => Promise<readonly (FsFreshnessProbe | null)[]> | readonly (FsFreshnessProbe | null)[];
}

/** 真源所需的内核投影（比 `McpKernelLike` 更窄，便于假件与单测）。 */
export interface FsFreshnessKernelLike {
  readonly bus: {
    readonly on?: (name: string, cb: (payload: unknown) => void) => (() => void) | void;
  };
  readonly fileWatch?: {
    readonly state?: () => {
      status: string;
      roots: readonly string[];
      failures: readonly { root: string; reason: string }[];
    };
  };
  /** B8 按需 mtime 复核的只读探针通道（见 `FsFreshnessStatIo`）。 */
  readonly io?: FsFreshnessStatIo;
}

/** 判定入参（文件级 = 目标绝对路径；目录级 = 目录绝对路径 + `granularity:'listing'`）。 */
export interface FsFreshnessReadInput {
  readonly abs: string;
  readonly rel: string;
  readonly scope: McpSessionScope | null | undefined;
  readonly granularity?: 'file' | 'listing';
}

export interface FsFreshnessTracker {
  /**
   * 单文件读取的标注（同时把本次读取写进读取账，作为下次的基线）。
   * B8：窗内自写回声命中时**发起**复核但本次等不到结论 ⇒ 该档给 `stale:null` +
   * 「复核在途」，不再乐观 `false`；要同一次读数拿到定档请用 `verdictOfRechecked`。
   */
  verdictOf(input: FsFreshnessReadInput): FsFreshnessVerdict;
  /** 目录/检索级标注：覆盖期内该目录下任何路径被动过即 `stale:true`（窗内同上一条同步档口径）。 */
  listingOf(input: {
    readonly dirAbs: string;
    readonly dirRel: string;
    readonly scope: McpSessionScope | null | undefined;
  }): FsFreshnessVerdict;
  /**
   * B8 **读时复核版**（异步）：窗内命中即多核一趟盘态，本次读数直接定档
   * （复核证明没变 ⇒ `stale:false` 且 `recheck.basis:'mtime-recheck'`；核出真实外部写 ⇒
   * `stale:true` 并把那笔写推进改动账；做不了 ⇒ `stale:null` + 理由）。
   */
  verdictOfRechecked(input: FsFreshnessReadInput): Promise<FsFreshnessVerdict>;
  /** 目录/检索级的读时复核版（候选集 = 窗内自写回声且落在该目录下的路径）。 */
  listingOfRechecked(input: {
    readonly dirAbs: string;
    readonly dirRel: string;
    readonly scope: McpSessionScope | null | undefined;
  }): Promise<FsFreshnessVerdict>;
  /**
   * 一次读数里多个目标的批量定档：**N 个路径命中窗内 ⇒ 只发一趟 `statFiles`**
   * （契约 io.ts:197「单路径请继续用 stat」的反面读法：多条就该批量）。
   * 返回值与入参一一对应（含同一目标的重复入参，各自算各自的基线）。
   */
  verdictsOfRechecked(inputs: readonly FsFreshnessReadInput[]): Promise<FsFreshnessVerdict[]>;
  /**
   * 等在途复核落账（同步判定器发出的那批）。只等结论、不产生新基线：
   * 测试与自检用它把「本档 null ⇒ 下一档定档」这条路钉成确定性读数。
   */
  settlePendingRechecks(): Promise<void>;
  /** 写腿广播同一调用栈里的自写记账（不改写腿应答形状，不碰写语义）。 */
  noteSelfWrite(input: {
    readonly abs: string;
    readonly kind: string;
    readonly scope: McpSessionScope | null | undefined;
  }): void;
  coverage(): FsWatchCoverage;
  /**
   * 会话视图：本会话此前经本宿主读过的目标，**现在**是否已过期（纯读，不产生新基线）。
   * 这是「我刚 read 的资源还是不是盘上那份」的直接答案；不可判定一律 `stale:null` + 理由。
   */
  sessionView(
    sessionId: string | null | undefined,
    maxEntries?: number,
  ): {
    readonly sessionKey: string;
    readonly capacity: number;
    readonly knownTargets: number;
    readonly listed: number;
    readonly truncated: boolean;
    readonly watchStatus: string;
    readonly watched: boolean;
    readonly entries: readonly Record<string, unknown>[];
    readonly note: string;
  };
  report(input?: { readonly maxEntries?: number; readonly maxListChars?: number }): FsFreshnessReport;
  dispose(): void;
}

/* ------------------------------- 内部条目 ------------------------------- */

interface ChangeEntry {
  key: string;
  path: string;
  kind: string;
  atMs: number;
  seq: number;
  origin: FsChangeOrigin;
  /** 自写归属的会话（仅 `mcp-write*` 有值：自写不该让自己看起来「过期」）。 */
  bySessionKey: string | null;
  events: number;
}

interface ReadEntry {
  sessionKey: string;
  key: string;
  /** 判定基准的绝对路径（目录级需要它做前缀包含）。 */
  abs: string;
  /** 给客户端看的目标（项目根内相对路径；根外为原样路径）。 */
  rel: string;
  atMs: number;
  seq: number;
  granularity: 'file' | 'listing';
  reads: number;
}

/**
 * 自写回声记忆（B8 起多带 `kind` / `path` 两个字段）：
 * `kind` 用来区分「我们写进去一份」（`add` / `change`）与「我们把它移走」（`unlink`）——
 * 后者的期望盘态本来就是不在位；`path` 让目录级复核能按前缀筛候选而不必重算路径。
 */
interface SelfWriteMemo {
  atMs: number;
  sessionKey: string;
  kind: string;
  path: string;
}

/** 复核观察到的盘态指纹（第三张账的条目；`null` 数值 = 探针给不出，不拿 0 兜底）。 */
interface RecheckEntry {
  key: string;
  path: string;
  exists: boolean;
  mtimeMs: number | null;
  size: number | null;
  atMs: number;
  seq: number;
  /** 这一条复核结论（淘汰后仍可从账目读出当时是怎么判的）。 */
  outcome: Exclude<FsFreshnessRecheckOutcome, 'pending'>;
}

/** 一个复核目标：路径 + 触发它的那笔自写回声记忆。 */
interface RecheckTarget {
  key: string;
  path: string;
  memo: SelfWriteMemo;
}

/** 探针的三类读数：核到盘态 / 通道做不了（抛错、缺通道、字段不齐）。 */
type ProbeReading = {
  readonly state: 'read';
  readonly exists: boolean;
  readonly mtimeMs: number | null;
  readonly size: number | null;
};
type ProbeResult = ProbeReading | { readonly state: 'unavailable'; readonly reason: string };

/** 一个目标的复核结论。 */
interface TargetOutcome {
  readonly target: RecheckTarget;
  readonly status: Exclude<FsFreshnessRecheckOutcome, 'pending'>;
  readonly reading: ProbeReading | null;
  readonly changeKind: string | null;
  readonly reason: string | null;
}

/** 一趟复核的产出（`trips` = 实际发出的 stat/statFiles 趟数；`batched` = 多目标并进同一趟）。 */
interface RecheckRun {
  readonly outcomes: readonly TargetOutcome[];
  readonly trips: number;
  readonly batched: boolean;
}

const ANNOTATED_TOOLS = [
  'fs.readFile',
  'fs.stat',
  'fs.statFiles（逐项）',
  // B2 批（LaneT，2026-11-06）：结构化批读面按同族口径**逐项**标注（成功位与失败位都带）。
  'fs.readMany（逐项）',
  'io.listDir',
  'projectFileTree / kojo://project/file-tree',
  'workspace.searchAll / io.searchAll',
  'kojo://project/snapshot',
  'kojo://project/fs-freshness',
] as const;

/** 未标注之处必须点名（铁律 4：缺席可见，别让客户端以为「没有字段＝没有变化」）。 */
const NOT_ANNOTATED = [
  {
    target: 'document.active / editor.info / editor.cursor',
    reason: '读的是编辑器缓冲，不是盘上那份；缓冲与盘的差由编辑器自己说，本批不冒充盘态判定',
  },
  {
    target: 'kojo://project/active-document',
    reason: '@kojo/mcp-host 的 slimActiveDocument 固定字段投影会丢掉新增字段；要看活动文档是否过期请配 fs.stat / fs.readFile 的 fsFreshness',
  },
  {
    target: 'notifications/resources/updated 推送',
    reason: '传输层是无状态单请求 HTTP/SSE，推不出去 ⇒ 能力面保持 subscribe:false / listChanged:false，本账只在读取时给',
  },
] as const;

function sessionKeyOf(scope: McpSessionScope | null | undefined): string {
  const id = scope && typeof scope.sessionId === 'string' ? scope.sessionId : '';
  return id === '' ? 'unattributed' : id;
}

function isTrustedStatus(status: string): boolean {
  return status === 'watching' || status === 'partial';
}

function underAny(roots: readonly string[], abs: string): boolean {
  for (const root of roots) {
    if (root !== '' && isPathUnder(root, abs)) return true;
  }
  return false;
}

/** 探针返回形态归一：契约里「取不到」有两条写法（单路径 `null` / 批量 `exists:false`）。 */
function toProbeResult(raw: FsFreshnessProbe | null | undefined): ProbeResult {
  if (raw === null || raw === undefined) return { state: 'read', exists: false, mtimeMs: null, size: null };
  if (raw.exists === false) return { state: 'read', exists: false, mtimeMs: null, size: null };
  const mtimeMs = typeof raw.mtimeMs === 'number' && Number.isFinite(raw.mtimeMs) ? raw.mtimeMs : null;
  const size = typeof raw.size === 'number' && Number.isFinite(raw.size) ? raw.size : null;
  if (mtimeMs === null) {
    // 契约口径：`mtimeMs` 可为 null（取不到时间戳），此时新鲜度判据缺一条腿 ⇒ 判不了，不拿 0 兜底
    return { state: 'unavailable', reason: 'mtime 取不到（契约里 mtimeMs 可为 null，判据不拿 0 兜底）' };
  }
  return { state: 'read', exists: true, mtimeMs, size };
}

/** 指纹双等判据（与内核文本缓存同尺：mtime + size；size 缺腿时只比 mtime 并如实说明）。 */
function sameFingerprint(a: ProbeReading, b: { exists: boolean; mtimeMs: number | null; size: number | null }): boolean {
  if (a.exists !== b.exists) return false;
  if (!a.exists) return true;
  return a.mtimeMs === b.mtimeMs && (a.size === b.size || a.size === null || b.size === null);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------- 账本（有界 + 淘汰可见） ------------------------------- */

class BoundedLedger<K, V> {
  private readonly map = new Map<K, V>();
  private readonly evictedKeys = new Set<K>();
  dropped = 0;
  evictedHighSeq = 0;
  evictedKeysTruncated = false;

  constructor(readonly capacity: number) {}

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  /** 追加/刷新到队尾；超出容量即淘汰队首并记 `dropped`（键位另存一份以区分「没读过」与「被挤掉」）。 */
  push(key: K, value: V, seqOf: (v: V) => number): void {
    this.map.delete(key);
    this.map.set(key, value);
    this.evictedKeys.delete(key);
    if (this.map.size <= this.capacity) return;
    const oldestKey = this.map.keys().next().value as K | undefined;
    if (oldestKey === undefined) return;
    const oldest = this.map.get(oldestKey);
    this.map.delete(oldestKey);
    if (oldest !== undefined) this.evictedHighSeq = Math.max(this.evictedHighSeq, seqOf(oldest));
    if (this.evictedKeys.size >= EVICTED_KEY_LIMIT) this.evictedKeysTruncated = true;
    else this.evictedKeys.add(oldestKey);
    this.dropped += 1;
  }

  evicted(key: K): boolean {
    return this.evictedKeys.has(key);
  }

  evictedKeyCount(): number {
    return this.evictedKeys.size;
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  counters(): FsLedgerCounters {
    return {
      capacity: this.capacity,
      size: this.map.size,
      dropped: this.dropped,
      truncated: this.dropped > 0,
    };
  }

  clear(): void {
    this.map.clear();
    this.evictedKeys.clear();
    this.dropped = 0;
    this.evictedHighSeq = 0;
    this.evictedKeysTruncated = false;
  }
}

/* ------------------------------- 装配 ------------------------------- */

/**
 * 建一份失效短账并订阅既有事件（幂等绑定由调用方 `bindFsFreshness` 负责）。
 * `kernel === null` 也返回判定器：所有标注如实落到 `available:false` + 理由，绝不静默消失。
 */
export function createFsFreshnessTracker(kernel: FsFreshnessKernelLike | null): FsFreshnessTracker {
  const changes = new BoundedLedger<string, ChangeEntry>(CHANGE_LEDGER_CAPACITY);
  const reads = new BoundedLedger<string, ReadEntry>(READ_LEDGER_CAPACITY);
  /** B8 复核侧第三张账（容量沿用 `CHANGE_LEDGER_CAPACITY`，溢出同口径可见）。 */
  const rechecks = new BoundedLedger<string, RecheckEntry>(RECHECK_LEDGER_CAPACITY);
  const selfWrites = new Map<string, SelfWriteMemo>();

  let seq = 0;
  let changeEventsSeen = 0;
  let watchStateEventsSeen = 0;
  let selfWritesSeen = 0;
  // B8 复核成本与结论的总账（读数口径：trips 只统计**实际发出**的 stat/statFiles 调用）
  let recheckRuns = 0;
  let recheckStatCalls = 0;
  let recheckProbedPaths = 0;
  let recheckChangesRecorded = 0;
  let recheckUnavailable = 0;
  let lastBusCoverage: FsWatchCoverage | null = null;
  const unsubs: (() => void)[] = [];

  /** 在途复核批次（按目标路径去重：同一目标在结论落账前只发一趟 syscall）。 */
  const pendingRechecks = new Map<string, { readonly promise: Promise<RecheckRun>; readonly keys: readonly string[] }>();
  let disposed = false;

  let fileChangedSubscribed = false;
  let watchStateSubscribed = false;

  const recordChange = (
    rawPath: string,
    kind: string,
    origin: FsChangeOrigin,
    bySessionKey: string | null,
    atMs: number,
  ): void => {
    const key = pathKey(rawPath);
    seq += 1;
    const previous = changes.get(key);
    changes.push(key, {
      key,
      path: rawPath,
      kind,
      atMs,
      seq,
      origin,
      bySessionKey,
      events: (previous?.events ?? 0) + 1,
    }, (e) => e.seq);
  };

  const onChangeEvent = (payload: unknown): void => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const rawPath = typeof p['path'] === 'string' ? p['path'] : '';
    if (rawPath === '') return; // 无路径的事件不进账（否则与「没有改动」混淆）
    changeEventsSeen += 1;
    const now = Date.now();
    const kind = typeof p['kind'] === 'string' ? p['kind'] : 'unknown';
    const key = pathKey(rawPath);
    const memo = selfWrites.get(key);
    if (memo && now - memo.atMs <= SELF_WRITE_ECHO_WINDOW_MS) {
      // 本宿主刚写过这条路径：紧随其后的事件按**同一事实**并入（不推序号，否则一次改动
      // 会被读成两次），归因仍记 `mcp-write`；窗口对不上才降级成 `mcp-write-echo` 新条目。
      const existing = changes.get(key);
      if (existing && existing.origin === 'mcp-write' && now - existing.atMs <= SELF_WRITE_ECHO_WINDOW_MS) {
        existing.events += 1;
        existing.path = rawPath;
        existing.kind = kind;
        return;
      }
      recordChange(rawPath, kind, 'mcp-write-echo', memo.sessionKey, now);
      return;
    }
    recordChange(rawPath, kind, 'unattributed', null, now);
  };

  const onWatchStateEvent = (payload: unknown): void => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const status = typeof p['status'] === 'string' ? p['status'] : 'unknown';
    const roots = Array.isArray(p['roots']) ? (p['roots'] as unknown[]).filter((r): r is string => typeof r === 'string') : [];
    const failures = Array.isArray(p['failures'])
      ? (p['failures'] as unknown[]).filter(
          (f): f is { root: string; reason: string } =>
            !!f && typeof f === 'object' && typeof (f as Record<string, unknown>)['root'] === 'string',
        )
      : [];
    watchStateEventsSeen += 1;
    lastBusCoverage = {
      usable: isTrustedStatus(status),
      status,
      source: 'bus.file.watchState',
      roots,
      unwatchedRoots: failures,
      reason: isTrustedStatus(status)
        ? null
        : `总线自述监视状态为 ${status}：该状态下同「监视停摆」同一判级，失效判定不可信`,
    };
  };

  const bus = kernel?.bus;
  if (bus && typeof bus.on === 'function') {
    try {
      const off1 = bus.on('file.changed', onChangeEvent);
      if (typeof off1 === 'function') unsubs.push(off1);
      fileChangedSubscribed = true;
    } catch {
      fileChangedSubscribed = false;
    }
    try {
      const off2 = bus.on('file.watchState', onWatchStateEvent);
      if (typeof off2 === 'function') unsubs.push(off2);
      watchStateSubscribed = true;
    } catch {
      watchStateSubscribed = false;
    }
  }

  const coverage = (): FsWatchCoverage => {
    const watch = kernel?.fileWatch;
    const state = watch?.state;
    if (typeof state === 'function' && watch !== undefined) {
      try {
        const raw = state.call(watch) as Record<string, unknown> | null | undefined;
        const status = typeof raw?.['status'] === 'string' ? (raw['status'] as string) : 'unknown';
        const roots: string[] = [];
        const rawRoots = raw?.['roots'];
        if (Array.isArray(rawRoots)) {
          for (const r of rawRoots) if (typeof r === 'string') roots.push(r);
        }
        const failures: { root: string; reason: string }[] = [];
        const rawFailures = raw?.['failures'];
        if (Array.isArray(rawFailures)) {
          for (const f of rawFailures) {
            if (!f || typeof f !== 'object') continue;
            const o = f as Record<string, unknown>;
            if (typeof o['root'] !== 'string') continue;
            failures.push({
              root: o['root'],
              reason: typeof o['reason'] === 'string' ? o['reason'] : '(回执未给原因)',
            });
          }
        }
        return {
          usable: isTrustedStatus(status),
          status,
          source: 'kernel.fileWatch.state',
          roots,
          unwatchedRoots: failures,
          reason: isTrustedStatus(status)
            ? null
            : `kernel.fileWatch.state() 自述 ${status}：自动重载机制此刻不可信，缺席一律可见`,
        };
      } catch {
        // state() 抛错：降级到次级真源（总线自述），出处字段会如实写出用的是哪一条
      }
    }
    if (lastBusCoverage) return lastBusCoverage;
    return {
      usable: false,
      status: 'unknown',
      source: 'absent',
      roots: [],
      unwatchedRoots: [],
      reason: '既没有 kernel.fileWatch.state()，也没收到总线 file.watchState：监视覆盖面未知（不当成「已监视」）',
    };
  };

  interface Decision {
    readonly stale: boolean | null;
    readonly staleReason: string | null;
    readonly tracked: boolean;
    readonly unwatchedMatch: { root: string; reason: string } | null;
    readonly changedSince: number;
  }

  /**
   * 纯判定（不写账）：`build` 与 `sessionView` 共用同一条判据，避免两套语义。
   * 判定顺序即「缺哪一环」的归因顺序（先真源缺席，再覆盖，再基线，最后才是账本自身）。
   */
  const decide = (
    abs: string,
    key: string,
    sKey: string,
    readKey: string,
    granularity: 'file' | 'listing',
    baseline: ReadEntry | null,
    cov: FsWatchCoverage,
  ): Decision => {
    const entry = changes.get(key) ?? null;
    const tracked = cov.roots.length > 0 && underAny(cov.roots, abs);
    const unwatchedMatch =
      !tracked && cov.unwatchedRoots.some((f) => f.root !== '' && isPathUnder(f.root, abs))
        ? (cov.unwatchedRoots.find((f) => f.root !== '' && isPathUnder(f.root, abs)) ?? null)
        : null;

    // 基线之后、且不是本会话自己写的改动条数（目录级 = 该目录下的路径，逐条计数）。
    let changedSince = 0;
    if (baseline !== null) {
      const sinceSeq = baseline.seq;
      if (granularity === 'listing') {
        for (const [, item] of changes.entries()) {
          if (item.seq <= sinceSeq) continue;
          if (item.origin !== 'unattributed' && item.bySessionKey === sKey) continue;
          if (isPathUnder(abs, item.path)) changedSince += 1;
        }
      } else if (entry && entry.seq > sinceSeq) {
        changedSince = entry.origin !== 'unattributed' && entry.bySessionKey === sKey ? 0 : 1;
      }
    }

    if (!cov.usable) {
      return {
        stale: null,
        staleReason: cov.reason ?? '监视覆盖不可用：无事件流即无法证明「没改过」',
        tracked,
        unwatchedMatch,
        changedSince,
      };
    }
    if (!tracked) {
      return {
        stale: null,
        staleReason: unwatchedMatch
          ? `目标落在没监视上的根里（${unwatchedMatch.root}：${unwatchedMatch.reason}）`
          : '目标不在任何已监视的根内：事件流永远不会覆盖它，无法判定',
        tracked,
        unwatchedMatch,
        changedSince,
      };
    }
    if (baseline === null) {
      return {
        stale: null,
        staleReason: reads.evicted(readKey)
          ? '本会话此前读过该目标，但读取账已溢出淘汰该条：无从比对（不是「没读过」）'
          : reads.counters().truncated
            ? '读取账已发生淘汰：无法确认本会话是否有更早的基线'
            : '本会话（无会话号时为 unattributed）此前没有读过该目标：没有可比的上一次读数',
        tracked,
        unwatchedMatch,
        changedSince,
      };
    }
    if (baseline.seq < changes.evictedHighSeq) {
      return {
        stale: null,
        staleReason: `改动账在基线之前已淘汰过条目（最后淘汰序号 ${changes.evictedHighSeq} > 基线 ${baseline.seq}）：无法证明「之后没改过」`,
        tracked,
        unwatchedMatch,
        changedSince,
      };
    }
    return {
      stale: changedSince > 0,
      staleReason: null,
      tracked,
      unwatchedMatch,
      changedSince,
    };
  };

  /**
   * 自写回声记忆按窗裁剪（FIFO 顺序 ≈ `atMs` 升序，遇到未过窗的即停）：
   * 让复核候选集只装「最近 5 秒真的写过的那几笔」，目录级扫描不必遍历全量，
   * 也不会无界增长（原实现靠 `CHANGE_LEDGER_CAPACITY` 硬顶，本批收紧到按窗）。
   */
  const pruneSelfWrites = (now: number): void => {
    for (const [k, memo] of selfWrites) {
      if (now - memo.atMs > SELF_WRITE_ECHO_WINDOW_MS) selfWrites.delete(k);
      else break;
    }
  };

  const countSelfWritesInWindow = (now: number): number => {
    let n = 0;
    for (const memo of selfWrites.values()) if (now - memo.atMs <= SELF_WRITE_ECHO_WINDOW_MS) n += 1;
    return n;
  };

  /**
   * 本次读数的复核候选集：只装「窗内自写回声命中的路径」。
   * 文件级 = 该路径自己的自写记忆；目录级 = 落在这个目录内、仍在窗内的自写路径。
   * 窗外 / 没写过 ⇒ 空集 ⇒ 一次 syscall 都不许多付（本批的成本判据）。
   */
  const recheckTargetsFor = (
    abs: string,
    key: string,
    granularity: 'file' | 'listing',
    now: number,
  ): RecheckTarget[] => {
    pruneSelfWrites(now);
    if (granularity !== 'listing') {
      const memo = selfWrites.get(key);
      if (!memo || now - memo.atMs > SELF_WRITE_ECHO_WINDOW_MS) return [];
      return [{ key, path: abs, memo }];
    }
    const out: RecheckTarget[] = [];
    for (const [k, memo] of selfWrites) {
      if (now - memo.atMs > SELF_WRITE_ECHO_WINDOW_MS) continue;
      if (isPathUnder(abs, memo.path)) out.push({ key: k, path: memo.path, memo });
    }
    return out;
  };

  /** 计划趟数判据（与 `probeTargets` 实际发法一致：单条走 stat，多条走一趟 statFiles）。 */
  const plannedTrips = (targets: readonly RecheckTarget[]): number => {
    if (targets.length === 0) return 0;
    const stat = kernel?.io?.stat;
    const statFiles = kernel?.io?.statFiles;
    if (targets.length === 1) return typeof stat === 'function' ? 1 : 0;
    if (typeof statFiles === 'function') return 1;
    return typeof stat === 'function' ? targets.length : 0;
  };

  const NO_CHANNEL_REASON = '注入面没有 stat/statFiles 通道（FsFreshnessKernelLike.io 未给探针）：无从复核';

  /** 逐条探针（单路径通道；异常按该条如实降级，不抛给判定器调用方）。 */
  const probeSingle = async (path: string): Promise<ProbeResult> => {
    const io = kernel?.io;
    const stat = io?.stat;
    if (typeof stat !== 'function' || io === undefined) return { state: 'unavailable', reason: NO_CHANNEL_REASON };
    recheckStatCalls += 1;
    try {
      return toProbeResult(await stat.call(io, path));
    } catch (err) {
      return { state: 'unavailable', reason: `stat 失败（${errMsg(err)}）` };
    }
  };

  const probeTargets = async (
    targets: readonly RecheckTarget[],
  ): Promise<{ readings: ProbeResult[]; trips: number; batched: boolean }> => {
    if (targets.length === 0) return { readings: [], trips: 0, batched: false };
    const paths = targets.map((t) => t.path);
    const io = kernel?.io;
    const statFiles = io?.statFiles;
    const stat = io?.stat;
    if (targets.length > 1 && typeof statFiles === 'function' && io !== undefined) {
      // 单趟原则：N 个路径一趟批量（契约 io.ts:190「差异只有一条：N 个路径一趟」）
      recheckStatCalls += 1;
      try {
        const raw = await statFiles.call(io, paths);
        const readings = paths.map<ProbeResult>((_p, i) => {
          const item = (raw as readonly (FsFreshnessProbe | null)[] | undefined)?.[i];
          if (item === undefined) {
            // 结果条数与入参不对应 = 契约破坏，判不了（不猜、不拿后一条顶上来）
            return { state: 'unavailable', reason: '批量 stat 未回显该条（结果与入参不一一对应）' };
          }
          return toProbeResult(item);
        });
        return { readings, trips: 1, batched: true };
      } catch (err) {
        return {
          readings: paths.map<ProbeResult>(() => ({ state: 'unavailable', reason: `statFiles 失败（${errMsg(err)}）` })),
          trips: 1,
          batched: true,
        };
      }
    }
    if (typeof stat === 'function') {
      // 单条 ⇒ 一趟 stat（契约 io.ts:197「一条不值得走批量命令」）；多条且没批量通道 ⇒ 逐条付、如实计数
      const readings: ProbeResult[] = [];
      for (const p of paths) readings.push(await probeSingle(p));
      return { readings, trips: paths.length, batched: false };
    }
    return {
      readings: paths.map<ProbeResult>(() => ({ state: 'unavailable', reason: NO_CHANNEL_REASON })),
      trips: 0,
      batched: false,
    };
  };

  /**
   * 单条结论（判据顺序即「凭什么」的顺序）：
   * ① 通道做不了 ⇒ `unknown`；② 不在位 ⇒ 自写本就是删除时 `unchanged`，
   * 否则契约的「取不到/不存在」合一态（Rust `metadata(...).ok()`）分不开 ⇒ `unknown`（不猜外部删除）；
   * ③ mtime 取不到 ⇒ `unknown`；④ 与上一次复核观察到的同一份 ⇒ `unchanged`；
   * ⑤ mtime 晚于自写回声基线 ⇒ `changed`（这就是被并条藏起来的那笔真写）；
   * ⑥ 与上次复核的指纹不一致 ⇒ `changed`（mtime 没越过基线也照认，尺寸变了就是变了）；
   * ⑦ 其余 ⇒ `unchanged`。
   */
  const classifyTarget = (t: RecheckTarget, reading: ProbeResult, now: number): TargetOutcome => {
    if (reading.state === 'unavailable') {
      recheckUnavailable += 1;
      return { target: t, status: 'unknown', reading: null, changeKind: null, reason: `${t.path}：${reading.reason}` };
    }
    if (!reading.exists) {
      if (t.memo.kind === 'unlink') {
        return {
          target: t,
          status: 'unchanged',
          reading,
          changeKind: null,
          reason: `复核证明没变：本次自写是删除/改名移走（${t.path}），盘上确实不在位`,
        };
      }
      recheckUnavailable += 1;
      return {
        target: t,
        status: 'unknown',
        reading,
        changeKind: null,
        reason: `${t.path}：探针只拿到「取不到与不存在合一」这一态（Rust metadata(...).ok() 不分离两态），` +
          '可能是外部删除也可能是 stat 失败——判不了，既不乐观 false 也不乱报 true',
      };
    }
    if (reading.mtimeMs === null) {
      recheckUnavailable += 1;
      return {
        target: t,
        status: 'unknown',
        reading: null,
        changeKind: null,
        reason: `${t.path}：mtime 取不到（契约里 mtimeMs 可为 null）`,
      };
    }
    const prev = rechecks.get(t.key) ?? null;
    if (prev !== null && sameFingerprint(reading, prev)) {
      return {
        target: t,
        status: 'unchanged',
        reading,
        changeKind: null,
        reason: `复核证明没变：盘上 mtime/size 与上一次复核观察到的同一份一致（${t.path}）`,
      };
    }
    if (reading.mtimeMs > t.memo.atMs) {
      return {
        target: t,
        status: 'changed',
        reading,
        changeKind: prev !== null && !prev.exists ? 'add' : 'change',
        reason: `mtime ${reading.mtimeMs} 晚于自写回声基线 ${t.memo.atMs}：窗内确有后续写（${t.path}）`,
      };
    }
    if (prev !== null && !sameFingerprint(reading, prev)) {
      return {
        target: t,
        status: 'changed',
        reading,
        changeKind: 'change',
        reason: `盘态 mtime/size 与上一次复核观察到的那份不一致（${t.path}）`,
      };
    }
    return {
      target: t,
      status: 'unchanged',
      reading,
      changeKind: null,
      reason: `复核证明没变：盘上 mtime ${reading.mtimeMs} 不晚于本次自写时刻 ${t.memo.atMs}（${t.path}）`,
    };
  };

  /** 复核结论落账：核出的真实外部写推进改动账（归因 unattributed），并收掉那笔回声记忆。 */
  const commitTargetOutcome = (o: TargetOutcome, now: number): void => {
    if (o.reading !== null) {
      seq += 1;
      rechecks.push(o.target.key, {
        key: o.target.key,
        path: o.target.path,
        exists: o.reading.exists,
        mtimeMs: o.reading.mtimeMs,
        size: o.reading.size,
        atMs: now,
        seq,
        outcome: o.status,
      }, (e) => e.seq);
    }
    if (o.status !== 'changed') return;
    recordChange(o.target.path, o.changeKind ?? 'change', 'unattributed', null, o.reading?.mtimeMs ?? now);
    // 这笔自写的回声窗使命到此为止：之后的事件不许再并成「我们写的」（那是同一处假阴性的另一半）
    selfWrites.delete(o.target.key);
    recheckChangesRecorded += 1;
  };

  /** 一趟复核的执行体（同步/异步两条入口共用，成本计数只有一个真源）：探针 ⇒ 判条 ⇒ 落账。 */
  const executeRecheck = async (targets: readonly RecheckTarget[], now: number): Promise<RecheckRun> => {
    recheckRuns += 1;
    if (disposed || targets.length === 0) return { outcomes: [], trips: 0, batched: false };
    recheckProbedPaths += targets.length;
    const { readings, trips, batched } = await probeTargets(targets);
    const outcomes = targets.map(
      (t, i) => classifyTarget(t, readings[i] ?? { state: 'unavailable', reason: NO_CHANNEL_REASON }, now),
    );
    if (!disposed) for (const o of outcomes) commitTargetOutcome(o, now);
    return { outcomes, trips, batched };
  };

  /** 发起一趟复核并登记在途（同步判定器用这条：本次读数等不到结论，如实给「在途」档）。 */
  const startRecheckJob = (targets: readonly RecheckTarget[], now: number): void => {
    if (disposed || targets.length === 0) return;
    const job = {
      promise: executeRecheck(targets, now),
      keys: targets.map((t) => t.key),
    };
    for (const t of targets) pendingRechecks.set(t.key, job);
    void job.promise
      .catch(() => undefined)
      .finally(() => {
        for (const k of job.keys) if (pendingRechecks.get(k) === job) pendingRechecks.delete(k);
      });
  };

  const outcomeToProbeRow = (o: TargetOutcome): FsFreshnessRecheckProbe => ({
    path: o.target.path,
    exists: o.reading?.exists ?? false,
    mtimeMs: o.reading?.mtimeMs ?? null,
    size: o.reading?.size ?? null,
    outcome: o.status,
    reason: o.reason,
  });

  /** 把一趟的产出投影成「本次读数」的复核读数（逐输入各自一条描述，别让批量互相冒名）。 */
  const describeRecheck = (
    own: readonly RecheckTarget[],
    outcomes: readonly TargetOutcome[] | null,
    trips: number,
    batched: boolean,
  ): FsFreshnessRecheck => {
    const selfWriteAtMs = own.length > 0 ? Math.min(...own.map((t) => t.memo.atMs)) : null;
    if (outcomes === null) {
      // 同步档：本次读数等不到结论。三种缺席原因分别说清（在途 / 同路径已在途 / 没通道）
      const reason =
        trips > 0
          ? `窗内自写回声的 mtime 复核在途：已发起 ${trips} 趟（${own.length} 条路径），本次读数等不到结论 ⇒ ` +
            '不乐观判 false，结论落账后下一次读即定档'
          : `同路径的 mtime 复核已在途（本次读数不重复发 syscall）⇒ 结论未落账前不乐观判 false`
      return {
        performed: false,
        basis: trips > 0 ? 'recheck-pending' : 'recheck-unavailable',
        outcome: 'pending',
        targets: own.length,
        trips,
        batched,
        selfWriteAtMs,
        reason,
        probes: [],
      };
    }
    const keys = new Set(own.map((t) => t.key));
    const mine = outcomes.filter((o) => keys.has(o.target.key));
    const changed = mine.filter((o) => o.status === 'changed');
    const unknown = mine.filter((o) => o.status === 'unknown');
    const outcome: FsFreshnessRecheckOutcome = changed.length > 0 ? 'changed' : unknown.length > 0 ? 'unknown' : 'unchanged';
    const allNoChannel = mine.length > 0 && mine.every((o) => o.status === 'unknown' && o.reason !== null && o.reason.includes('没有 stat'));
    const reason =
      changed.length > 0
        ? `复核核出窗内确有后续写：${changed.map((o) => o.reason).join('；')}`
        : unknown.length > 0
          ? `复核判不了：${unknown.map((o) => o.reason).join('；')}`
          : `复核证明没变（mtime/size 与自写回声基线及上一次复核观察一致）：${mine.map((o) => o.reason).join('；')}`;
    return {
      performed: true,
      basis: trips === 0 || allNoChannel ? 'recheck-unavailable' : 'mtime-recheck',
      outcome,
      targets: own.length,
      trips,
      batched,
      selfWriteAtMs,
      reason,
      probes: mine.map(outcomeToProbeRow),
    };
  };

  /**
   * 读时复核的公共前置：只在「事件流这一档判出 `stale:false`」时才要复核
   * （复核钉的是「并条有没有谎报没变」这一件事；已 `true` 或已 `null` 的那两档不多付 syscall）。
   */
  const planRecheck = (
    abs: string,
    scope: McpSessionScope | null | undefined,
    granularity: 'file' | 'listing',
    cov: FsWatchCoverage,
    now: number,
  ): { key: string; sKey: string; readKey: string; baseline: ReadEntry | null; pre: Decision; own: RecheckTarget[] } => {
    const key = pathKey(abs);
    const sKey = sessionKeyOf(scope);
    const readKey = `${sKey}\u0000${key}`;
    const baseline = reads.get(readKey) ?? null;
    const pre = decide(abs, key, sKey, readKey, granularity, baseline, cov);
    const own = pre.stale === false ? recheckTargetsFor(abs, key, granularity, now) : [];
    return { key, sKey, readKey, baseline, pre, own };
  };

  /** 同步档：发起（去重）不等结论；没有探针通道时当场定档为「判不了」（不占在途队列）。 */
  const scheduleRecheck = (own: readonly RecheckTarget[], now: number): FsFreshnessRecheck => {
    const fresh = own.filter((t) => !pendingRechecks.has(t.key));
    const trips = plannedTrips(fresh);
    if (fresh.length > 0 && trips > 0 && pendingRechecks.size < CHANGE_LEDGER_CAPACITY) startRecheckJob(fresh, now);
    if (fresh.length > 0 && trips === 0) {
      // 通道缺席 ⇒ 本档不是「在途」而是「做不了」：逐条挂 unavailable 结论，理由指名缺哪一环
      recheckUnavailable += fresh.length;
      const unknowns = fresh.map<TargetOutcome>((t) => ({
        target: t,
        status: 'unknown',
        reading: null,
        changeKind: null,
        reason: `${t.path}：${NO_CHANNEL_REASON}`,
      }));
      return describeRecheck(own, unknowns, 0, false);
    }
    if (fresh.length > 0 && pendingRechecks.size >= CHANGE_LEDGER_CAPACITY) {
      // 在途队列已满（极端并发）：如实说清没发起，绝不因此乐观判 false
      recheckUnavailable += fresh.length;
      return {
        ...describeRecheck(own, null, 0, false),
        basis: 'recheck-unavailable',
        reason: `mtime 复核在途队列已满（上限 ${CHANGE_LEDGER_CAPACITY} 条）：本批目标未发起复核，` +
          '本档不乐观判 false（溢出反向降档为可见，与两张账同口径）',
      };
    }
    return describeRecheck(own, null, trips, fresh.length > 1);
  };

  /** 一趟批量复核的共享执行结果投影到单个读数（一次读数的多路径共用同一趟，逐条各自描述）。 */
  const describeForInput = (
    own: readonly RecheckTarget[],
    byKey: ReadonlyMap<string, TargetOutcome>,
    trips: number,
    batched: boolean,
  ): FsFreshnessRecheck => {
    const outcomes = [...byKey.values()];
    const missing = own.filter((t) => !byKey.has(t.key));
    if (missing.length > 0) {
      // 目标既没在本次批次里也没在途结论里 ⇒ 这一条判不了，如实挂到 unknown（不默认「没变」）
      for (const t of missing) outcomes.push({ target: t, status: 'unknown', reading: null, changeKind: null, reason: `${t.path}：复核批次未回显该条` });
    }
    return describeRecheck(own, outcomes, trips, batched);
  };

  const build = (
    abs: string,
    rel: string,
    scope: McpSessionScope | null | undefined,
    granularity: 'file' | 'listing',
    recheck: FsFreshnessRecheck | null = null,
    planned?: { cov: FsWatchCoverage; now: number; key: string; sKey: string; readKey: string; baseline: ReadEntry | null; decision: Decision },
  ): FsFreshnessVerdict => {
    const cov = planned?.cov ?? coverage();
    const now = planned?.now ?? Date.now();
    const key = pathKey(abs);
    const sKey = planned?.sKey ?? sessionKeyOf(scope);
    const readKey = planned?.readKey ?? `${sKey}\u0000${key}`;
    const baseline = planned?.baseline ?? reads.get(readKey) ?? null;
    const entry = changes.get(key) ?? null;
    const sources = {
      fileChangedSubscribed,
      watchStateSubscribed,
      fileWatchStateApi: typeof kernel?.fileWatch?.state === 'function',
    };
    const ledger = { changes: changes.counters(), reads: reads.counters() };
    // 走过复核 ⇒ 必须重算：核出的那笔外部写已经推进改动账，目录级判定还会看到别条目的变化。
    // 没走复核 ⇒ 用前置判定的结论（省掉目录级那次 O(改动账) 扫描的重复）。
    const decision = recheck !== null || planned === undefined
      ? decide(abs, key, sKey, readKey, granularity, baseline, cov)
      : planned.decision;

    /**
     * 窗内复核接管「事件流判出的 false」这一档：结论未定 ⇒ 降为 `stale:null` + 理由
     * （本批要收口的就是这一格的假阴性；已 `true` / 已 `null` 的两档不被复核改写）。
     */
    let stale = decision.stale;
    let staleReason = decision.staleReason;
    if (recheck !== null && decision.stale === false && recheck.outcome !== 'unchanged') {
      if (recheck.outcome === 'changed') {
        stale = true;
        staleReason = null;
      } else {
        stale = null;
        staleReason = `自写回声窗内的 mtime 复核未定档：${recheck.reason ?? '复核没有给出结论'}`;
      }
    }

    // 本次读取进账（基线取记录之前的值）：下一次判定才有可比对象。
    seq += 1;
    reads.push(readKey, {
      sessionKey: sKey,
      key,
      abs,
      rel,
      atMs: now,
      seq,
      granularity,
      reads: (baseline?.reads ?? 0) + 1,
    }, (r) => r.seq);

    return {
      available: true,
      stale,
      staleReason,
      target: rel,
      granularity,
      atMs: now,
      previousReadAtMs: baseline?.atMs ?? null,
      changedAtMs: entry?.atMs ?? null,
      changeKind: entry?.kind ?? null,
      changeOrigin: entry?.origin ?? null,
      tracked: decision.tracked,
      watched: cov.usable,
      watchStatus: cov.status,
      watchStateSource: cov.source,
      unwatchedRoots: cov.unwatchedRoots,
      unwatchedRootMatch: decision.unwatchedMatch,
      sources,
      changedSincePreviousRead: decision.changedSince,
      ledger,
      recheck,
    };
  };

  /** 同步判定器入口（今日只读腿在用）：窗内命中 ⇒ 发起复核、本档如实给「在途」。 */
  const buildSync = (
    abs: string,
    rel: string,
    scope: McpSessionScope | null | undefined,
    granularity: 'file' | 'listing',
  ): FsFreshnessVerdict => {
    const cov = coverage();
    const now = Date.now();
    const plan = planRecheck(abs, scope, granularity, cov, now);
    const recheck = disposed || plan.own.length === 0 ? null : scheduleRecheck(plan.own, now);
    return build(abs, rel, scope, granularity, recheck, {
      cov,
      now,
      key: plan.key,
      sKey: plan.sKey,
      readKey: plan.readKey,
      baseline: plan.baseline,
      decision: plan.pre,
    });
  };

  /** 异步判定器入口（读时复核版）：一次调用的多路径命中并进同一趟 syscall，本档即定档。 */
  const buildSettled = async (
    inputs: readonly FsFreshnessReadInput[],
  ): Promise<FsFreshnessVerdict[]> => {
    if (inputs.length === 0) return [];
    const cov = coverage();
    const now = Date.now();
    const plans = inputs.map((inp) => planRecheck(inp.abs, inp.scope, inp.granularity ?? 'file', cov, now));
    // 全局候选集（按路径去重）⇒ 一次读数只发一趟；逐条描述仍按各自候选集投影，不互相冒名
    const union = new Map<string, RecheckTarget>();
    for (const p of plans) for (const t of p.own) if (!union.has(t.key)) union.set(t.key, t);
    const byKey = new Map<string, TargetOutcome>();
    let trips = 0;
    let batched = false;
    if (!disposed && union.size > 0) {
      const callsBefore = recheckStatCalls;
      const run = await executeRecheck([...union.values()], now);
      trips = recheckStatCalls - callsBefore;
      batched = run.batched;
      for (const o of run.outcomes) byKey.set(o.target.key, o);
    }
    return inputs.map((inp, i) => {
      const plan = plans[i]!;
      const recheck = disposed || plan.own.length === 0 ? null : describeForInput(plan.own, byKey, trips, batched);
      return build(inp.abs, inp.rel, inp.scope, inp.granularity ?? 'file', recheck, {
        cov,
        now,
        key: plan.key,
        sKey: plan.sKey,
        readKey: plan.readKey,
        baseline: plan.baseline,
        decision: plan.pre,
      });
    });
  };

  return {
    verdictOf: ({ abs, rel, scope, granularity = 'file' }) => buildSync(abs, rel, scope, granularity),

    listingOf: ({ dirAbs, dirRel, scope }) => buildSync(dirAbs, dirRel, scope, 'listing'),

    verdictOfRechecked: async (input) => (await buildSettled([input]))[0]!,

    listingOfRechecked: async ({ dirAbs, dirRel, scope }) =>
      (await buildSettled([{ abs: dirAbs, rel: dirRel, scope, granularity: 'listing' }]))[0]!,

    verdictsOfRechecked: (inputs) => buildSettled(inputs),

    settlePendingRechecks: async () => {
      // 只等在途结论落账，不产生新基线：同步判定器的「本档 null ⇒ 下档定档」由此成为确定读数
      for (let guard = 0; guard < 64; guard += 1) {
        const jobs = [...new Set(pendingRechecks.values())];
        if (jobs.length === 0 || disposed) return;
        for (const job of jobs) {
          try {
            await job.promise;
          } catch {
            /* 复核批次自己把失败降成 unknown 读数；这里不把它抛给等待方 */
          }
        }
      }
    },

    noteSelfWrite: ({ abs, kind, scope }) => {
      const now = Date.now();
      const key = pathKey(abs);
      const sKey = sessionKeyOf(scope);
      selfWritesSeen += 1;
      selfWrites.set(key, { atMs: now, sessionKey: sKey, kind, path: abs });
      // 按窗裁剪（B8）：回声窗对判定与复核都只在这 5 秒内有效 ⇒ 过窗条目直接不留
      pruneSelfWrites(now);
      if (selfWrites.size > CHANGE_LEDGER_CAPACITY) {
        const oldest = selfWrites.keys().next().value as string | undefined;
        if (oldest !== undefined && oldest !== key) selfWrites.delete(oldest);
      }
      recordChange(abs, kind, 'mcp-write', sKey, now);
      // 自写即「本会话已经知道这份新内容」：把该会话的基线推到本次写之后。
      // `rel` 用原样绝对路径：写腿应答自己回显 relPath，账本这里只保判定基准与可见目标，
      // 不猜根、不编造相对形态（ReadEntry.rel 的约定：根外/无基准时即原样路径）。
      const selfReadKey = `${sKey}\u0000${key}`;
      reads.push(selfReadKey, {
        sessionKey: sKey,
        key,
        abs,
        rel: abs,
        atMs: now,
        seq,
        granularity: 'file',
        reads: (reads.get(selfReadKey)?.reads ?? 0) + 1,
      }, (r) => r.seq);
    },

    coverage,

    sessionView: (sessionId, maxEntries = 50) => {
      const cov = coverage();
      const now = Date.now();
      const sKey = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'unattributed';
      const rows: Record<string, unknown>[] = [];
      let known = 0;
      for (const [, r] of reads.entries()) {
        if (r.sessionKey !== sKey) continue;
        known += 1;
        const decision = decide(r.abs, r.key, sKey, `${sKey}\u0000${r.key}`, r.granularity, r, cov);
        const entry = changes.get(r.key) ?? null;
        // B8：窗内自写回声 + 事件流判出 false ⇒ 这一格正是假阴性那一格；sessionView 是纯读，
        // 不发 syscall 冒充复核 ⇒ 如实降为 null（要看定档请用 verdictOfRechecked / 等复核落账）。
        const memo = selfWrites.get(r.key);
        const inEchoWindow = memo !== undefined && now - memo.atMs <= SELF_WRITE_ECHO_WINDOW_MS && decision.stale === false;
        rows.push({
          target: r.rel,
          granularity: r.granularity,
          readAtMs: r.atMs,
          reads: r.reads,
          stale: inEchoWindow ? null : decision.stale,
          staleReason: inEchoWindow
            ? 'B8：该目标在自写回声窗内且事件流判出「没变」——这正是并条可能掩盖真实外部写的那一格；' +
              '会话视图是纯读（不发 mtime 复核的 syscall），故不乐观判 false'
            : decision.staleReason,
          tracked: decision.tracked,
          changedSinceThisRead: decision.changedSince,
          changedAtMs: entry?.atMs ?? null,
          changeKind: entry?.kind ?? null,
          changeOrigin: entry?.origin ?? null,
          inSelfWriteEchoWindow: inEchoWindow,
        });
      }
      const cap = Math.max(0, Math.floor(maxEntries));
      const listed = rows.slice(0, cap);
      return {
        sessionKey: sKey,
        capacity: READ_LEDGER_CAPACITY,
        knownTargets: known,
        listed: listed.length,
        truncated: rows.length > listed.length,
        watchStatus: cov.status,
        watched: cov.usable,
        entries: listed,
        note:
          '本视图是对读取账的**现算**（不产生新基线、不推送、不发 syscall）：stale:false 只在监视覆盖可信时成立；' +
          'stale:null 表示这一环缺真源（原因见 staleReason），不是「没改过」。' +
          'B8：自写回声窗内的目标在这里一律不乐观判 false（inSelfWriteEchoWindow 逐条点名），' +
          '定档要读 fs.stat / fs.readFile 的 fsFreshness.recheck。',
      };
    },

    report: ({ maxEntries = 50 }: { readonly maxEntries?: number; readonly maxListChars?: number } = {}) => {
      const cov = coverage();
      const changeRows: Record<string, unknown>[] = [];
      for (const [, e] of changes.entries()) {
        changeRows.push({
          path: e.path,
          kind: e.kind,
          changedAtMs: e.atMs,
          seq: e.seq,
          origin: e.origin,
          ...(e.bySessionKey !== null ? { bySessionKey: e.bySessionKey } : {}),
          events: e.events,
        });
      }
      changeRows.sort((a, b) => Number(b['seq']) - Number(a['seq']));
      const keptChanges = changeRows.slice(0, maxEntries);
      const readRows: Record<string, unknown>[] = [];
      for (const [, r] of reads.entries()) {
        readRows.push({
          sessionKey: r.sessionKey,
          target: r.rel,
          pathKey: r.key,
          granularity: r.granularity,
          readAtMs: r.atMs,
          seq: r.seq,
          reads: r.reads,
        });
      }
      readRows.sort((a, b) => Number(b['seq']) - Number(a['seq']));
      const recheckRows: Record<string, unknown>[] = [];
      for (const [, e] of rechecks.entries()) {
        recheckRows.push({
          path: e.path,
          exists: e.exists,
          mtimeMs: e.mtimeMs,
          size: e.size,
          checkedAtMs: e.atMs,
          seq: e.seq,
          outcome: e.outcome,
        });
      }
      recheckRows.sort((a, b) => Number(b['seq']) - Number(a['seq']));
      const keptRechecks = recheckRows.slice(0, maxEntries);
      const keptReads = readRows.slice(0, maxEntries);
      return {
        generatedAtMs: Date.now(),
        push: {
          notificationsResourcesUpdated: false,
          subscribe: false,
          listChanged: false,
          mode: 'on-request',
          reason:
            '传输层是无状态单请求 HTTP（SSE 只服务当次请求），notifications/resources/updated 推不出去 ⇒ ' +
            '能力面继续报 subscribe:false / listChanged:false，失效事实只随只读应答给（on-request 标注）',
        },
        watch: cov,
        sources: {
          fileChangedSubscribed,
          watchStateSubscribed,
          fileWatchStateApi: typeof kernel?.fileWatch?.state === 'function',
        },
        counters: {
          changeEventsSeen,
          watchStateEventsSeen,
          selfWritesSeen,
          readsRecorded: reads.size,
          seq,
          selfWritesInWindow: countSelfWritesInWindow(Date.now()),
          mtimeRecheckRuns: recheckRuns,
          mtimeRecheckStatCalls: recheckStatCalls,
          mtimeRecheckProbedPaths: recheckProbedPaths,
          mtimeRecheckChangesRecorded: recheckChangesRecorded,
          mtimeRecheckUnavailable: recheckUnavailable,
          mtimeRecheckPending: pendingRechecks.size,
        },
        ledger: {
          changes: {
            ...changes.counters(),
            listed: keptChanges.length,
            evictedHighSeq: changes.evictedHighSeq,
            entries: keptChanges,
          },
          reads: {
            ...reads.counters(),
            listed: keptReads.length,
            evictedHighSeq: reads.evictedHighSeq,
            entries: keptReads,
          },
          // B8 复核侧第三张账：容量沿用 CHANGE_LEDGER_CAPACITY，溢出照旧反向降档为可见
          rechecks: {
            ...rechecks.counters(),
            listed: keptRechecks.length,
            evictedHighSeq: rechecks.evictedHighSeq,
            entries: keptRechecks,
          },
          evictedKeys: {
            changes: changes.evictedKeyCount(),
            reads: reads.evictedKeyCount(),
            rechecks: rechecks.evictedKeyCount(),
            truncated: changes.evictedKeysTruncated || reads.evictedKeysTruncated || rechecks.evictedKeysTruncated,
          },
        },
        annotatedTools: ANNOTATED_TOOLS,
        notAnnotated: NOT_ANNOTATED,
      };
    },

    dispose: () => {
      disposed = true;
      pendingRechecks.clear();
      for (const off of unsubs) {
        try {
          off();
        } catch {
          /* 退订失败不改判定：账本仍在，句柄由内核生命周期兜住 */
        }
      }
      unsubs.length = 0;
      changes.clear();
      reads.clear();
      rechecks.clear();
      selfWrites.clear();
    },
  };
}

/** 判定结果 → 应答里的 `fsFreshness` 载荷（JSON 化的形状，字段名即契约）。 */
export function fsFreshnessPayload(verdict: FsFreshnessVerdict): Record<string, unknown> {
  return { ...verdict };
}

/** 判定器缺席时的显式标注（假件 / 未装配的宿主：字段仍在，值如实为 null + 理由）。 */
export function fsFreshnessAbsentPayload(target: string, granularity: 'file' | 'listing'): Record<string, unknown> {
  return {
    available: false,
    stale: null,
    staleReason: '本宿主未装配失效判定器（fs-freshness 未接线）：无法判断盘态是否与上一次读取一致（不静默、不冒充 false）',
    target,
    granularity,
    sources: {
      fileChangedSubscribed: false,
      watchStateSubscribed: false,
      fileWatchStateApi: false,
    },
    // B8：判定器都没装，复核更无从谈起——字段照样在场（客户端一条判据：recheck:null = 没复核）
    recheck: null,
  };
}

/* ------------------------------- 幂等绑定（与事件环同一策略） ------------------------------- */

let tracker: FsFreshnessTracker | null = null;
let boundTo: FsFreshnessKernelLike | null | undefined;

/** 绑定 / 复用失效判定器（同一内核重复调用不重复订阅；换内核先退订旧的）。 */
export function bindFsFreshness(kernel: FsFreshnessKernelLike | null): FsFreshnessTracker {
  if (boundTo !== undefined && kernel === boundTo && tracker !== null) return tracker;
  tracker?.dispose();
  boundTo = kernel;
  tracker = createFsFreshnessTracker(kernel);
  return tracker;
}

/** 当前判定器（未绑定 ⇒ null：调用方一律落到 `fsFreshnessAbsentPayload`，绝不静默缺字段）。 */
export function getFsFreshnessTracker(): FsFreshnessTracker | null {
  return tracker;
}

/** 测试/退出用：解绑并清空两张账。 */
export function resetFsFreshnessForTest(): void {
  tracker?.dispose();
  tracker = null;
  boundTo = undefined;
}
