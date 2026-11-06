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
 */
export const SELF_WRITE_ECHO_WINDOW_MS = 5_000;

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
}

/** `kojo://project/fs-freshness` 的账本读数（判定 + 两张账 + 能力面自述）。 */
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
    readonly evictedKeys: { readonly changes: number; readonly reads: number; readonly truncated: boolean };
  };
  readonly annotatedTools: readonly string[];
  readonly notAnnotated: readonly { readonly target: string; readonly reason: string }[];
}

/* ------------------------------- 注入面 ------------------------------- */

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
}

export interface FsFreshnessTracker {
  /** 单文件读取的标注（同时把本次读取写进读取账，作为下次的基线）。 */
  verdictOf(input: {
    readonly abs: string;
    readonly rel: string;
    readonly scope: McpSessionScope | null | undefined;
    readonly granularity?: 'file' | 'listing';
  }): FsFreshnessVerdict;
  /** 目录/检索级标注：覆盖期内该目录下任何路径被动过即 `stale:true`。 */
  listingOf(input: {
    readonly dirAbs: string;
    readonly dirRel: string;
    readonly scope: McpSessionScope | null | undefined;
  }): FsFreshnessVerdict;
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
  const selfWrites = new Map<string, { atMs: number; sessionKey: string }>();

  let seq = 0;
  let changeEventsSeen = 0;
  let watchStateEventsSeen = 0;
  let selfWritesSeen = 0;
  let lastBusCoverage: FsWatchCoverage | null = null;
  const unsubs: (() => void)[] = [];

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

  const build = (
    abs: string,
    rel: string,
    scope: McpSessionScope | null | undefined,
    granularity: 'file' | 'listing',
  ): FsFreshnessVerdict => {
    const cov = coverage();
    const now = Date.now();
    const key = pathKey(abs);
    const sKey = sessionKeyOf(scope);
    const readKey = `${sKey}\u0000${key}`;
    const baseline = reads.get(readKey) ?? null;
    const entry = changes.get(key) ?? null;
    const sources = {
      fileChangedSubscribed,
      watchStateSubscribed,
      fileWatchStateApi: typeof kernel?.fileWatch?.state === 'function',
    };
    const ledger = { changes: changes.counters(), reads: reads.counters() };
    const decision = decide(abs, key, sKey, readKey, granularity, baseline, cov);

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
      stale: decision.stale,
      staleReason: decision.staleReason,
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
    };
  };

  return {
    verdictOf: ({ abs, rel, scope, granularity = 'file' }) => build(abs, rel, scope, granularity),

    listingOf: ({ dirAbs, dirRel, scope }) => build(dirAbs, dirRel, scope, 'listing'),

    noteSelfWrite: ({ abs, kind, scope }) => {
      const now = Date.now();
      const key = pathKey(abs);
      const sKey = sessionKeyOf(scope);
      selfWritesSeen += 1;
      selfWrites.set(key, { atMs: now, sessionKey: sKey });
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
      const sKey = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'unattributed';
      const rows: Record<string, unknown>[] = [];
      let known = 0;
      for (const [, r] of reads.entries()) {
        if (r.sessionKey !== sKey) continue;
        known += 1;
        const decision = decide(r.abs, r.key, sKey, `${sKey}\u0000${r.key}`, r.granularity, r, cov);
        const entry = changes.get(r.key) ?? null;
        rows.push({
          target: r.rel,
          granularity: r.granularity,
          readAtMs: r.atMs,
          reads: r.reads,
          stale: decision.stale,
          staleReason: decision.staleReason,
          tracked: decision.tracked,
          changedSinceThisRead: decision.changedSince,
          changedAtMs: entry?.atMs ?? null,
          changeKind: entry?.kind ?? null,
          changeOrigin: entry?.origin ?? null,
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
          '本视图是对读取账的**现算**（不产生新基线、不推送）：stale:false 只在监视覆盖可信时成立；' +
          'stale:null 表示这一环缺真源（原因见 staleReason），不是「没改过」。',
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
            listed: readRows.slice(0, maxEntries).length,
            evictedHighSeq: reads.evictedHighSeq,
            entries: readRows.slice(0, maxEntries),
          },
          evictedKeys: {
            changes: changes.evictedKeyCount(),
            reads: reads.evictedKeyCount(),
            truncated: changes.evictedKeysTruncated || reads.evictedKeysTruncated,
          },
        },
        annotatedTools: ANNOTATED_TOOLS,
        notAnnotated: NOT_ANNOTATED,
      };
    },

    dispose: () => {
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
