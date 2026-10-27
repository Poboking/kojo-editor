import type { ScopedStorage } from '@kojo/plugin-api';
import { isAbsolute, pathKey } from '@kojo/plugin-api';
import { restoreGroups, sanitizeSplitSizes, type EditorGroupState, type EditorGroupsState } from './editor-groups';

/**
 * 会话恢复的持久层（2026-10-16 退出/崩溃守护批）：每个项目一份标签集，
 * 存进 kernel 全局存储（`{appData}/store/_global/session-tabs-v1.json`），
 * 与 recent-projects 同一条 KV 通道。零 React 零 kernel 类型耦合——
 * 存取面 `SessionKv` 只要求 get/set，node 测试用内存替身即可。
 *
 * 口径：
 * - 键按 `pathKey(rootDir)` 归一（Windows 大小写/分隔符折叠，与全仓路径判等同尺）；
 * - `lastRoot` = 最近一次打开的项目根：欢迎页「继续上次会话」的目标；
 * - 关项目**不清**记录（重启后一键回标签集靠它）；标签全关再关项目 = 空标签集，
 *   重开不凭空造标签（**唯一例外**：附加根还在时记录保留，见 `extraRoots`）；
 * - 恢复时 pinned 与 tabs 取交集（记录可能比盘上事实旧——文件被删/移动）；
 * - `groups`（MM-9 编辑器组布局）：**additive 扩展**——老记录没有该字段，sanitize
 *   直接跳过、零影响（v 保持 1 不变）；新记录存 `serializeGroups` 形状的快照，
 *   合法性由 `restoreGroups` 判，非法即当没有；
 * - `splitSizes` / `extraRoots`（WS-06 / WS-08）：同为 additive——老记录没有就不补键，
 *   新记录里非法的条目一律丢弃（长度不符的分屏比例、非绝对的附加根）。
 */

export const SESSION_KEY = 'session-tabs-v1';
/** 会话标签集落盘的防抖（与 view-state-store 的 flush 节奏同族） */
export const SESSION_FLUSH_DEBOUNCE_MS = 600;
/** 单个项目记住的会话级附加根上限（再多就不叫"临时挂几个文件夹"了） */
export const SESSION_EXTRA_ROOTS_LIMIT = 32;

export interface SessionProjectRecord {
  tabs: string[];
  active: string | null;
  pinned: string[];
  /**
   * 编辑器组态快照（MM-9 分屏布局持久化；形状 = `serializeGroups` 产物）。
   * **additive 扩展**：老记录没有该字段，sanitize 直接跳过、零影响；
   * 非法形态（乱值/损坏）在 sanitize 时被当作没有——合法性判据在
   * `restoreGroups`（editor-groups 的纯函数，零依赖不成环）。
   */
  groups?: unknown;
  /**
   * 分屏比例（WS-06）：长度 = `groups 的组数 - 1`，每条是前 n-1 组各占的份额
   * （末组吃剩余；口径与判据见 `split-sizes.ts`）。**additive**：没有 `groups`
   * 或长度对不上就整体丢弃——宁可均分，也不把旧比例套到别的组结构上。
   */
  splitSizes?: number[];
  /**
   * 会话级附加根（WS-08）：作者挂进来的浏览/检索/监视根。**additive**：
   * 绝对路径、去重（`pathKey` 判等）、最多 `SESSION_EXTRA_ROOTS_LIMIT` 条；
   * 项目根自身剔除（它就是主根，挂进去只会多一个重复分组头）。
   */
  extraRoots?: string[];
}

export interface SessionRecord {
  v: 1;
  lastRoot: string | null;
  /** 键 = pathKey(rootDir) */
  projects: Record<string, SessionProjectRecord>;
}

/** 最小存取面（ScopedStorage 的 get/set 子集） */
export type SessionKv = Pick<ScopedStorage, 'get' | 'set'>;

export function emptySessionRecord(): SessionRecord {
  return { v: 1, lastRoot: null, projects: {} };
}

function stringList(raw: unknown, limit: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item === '') continue;
    if (out.includes(item)) continue;
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 附加根清单的清洗（WS-08）：只留绝对路径、`pathKey` 去重、剔除项目根自身、
 * 截到上限。损坏容忍——非数组 / 条目类型不对一律跳过，绝不抛。
 */
export function sanitizeExtraRoots(
  raw: unknown,
  projectRoot?: string,
  limit: number = SESSION_EXTRA_ROOTS_LIMIT,
): string[] {
  if (!Array.isArray(raw)) return [];
  const rootKey = projectRoot !== undefined && projectRoot !== '' ? pathKey(projectRoot) : null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item === '') continue;
    if (!isAbsolute(item)) continue;
    const k = pathKey(item);
    if (rootKey !== null && k === rootKey) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/** 损坏容忍：任何不合法形态回空记录（会话数据丢了可以重开，绝不能炸启动） */
export function sanitizeSessionRecord(raw: unknown): SessionRecord {
  if (typeof raw !== 'object' || raw === null) return emptySessionRecord();
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.projects !== 'object' || r.projects === null) return emptySessionRecord();
  const projects: Record<string, SessionProjectRecord> = {};
  for (const [k, v] of Object.entries(r.projects as Record<string, unknown>)) {
    if (typeof k !== 'string' || k === '' || typeof v !== 'object' || v === null) continue;
    const t = v as Record<string, unknown>;
    const tabs = stringList(t.tabs, 64);
    // WS-08：附加根是独立于标签的会话态——标签全关但还挂着文件夹时记录必须留住
    const extraRoots = sanitizeExtraRoots(t.extraRoots, k);
    if (tabs.length === 0 && extraRoots.length === 0) continue; // 空会话不入库（重开不造标签）
    const active = typeof t.active === 'string' && tabs.includes(t.active) ? t.active : tabs[0] ?? null;
    const entry: SessionProjectRecord = { tabs, active, pinned: stringList(t.pinned, 64).filter((p) => tabs.includes(p)) };
    // groups（MM-9 additive）：老记录没这个字段 ⇒ 直接跳过；有则过 restoreGroups
    // 预校验，非法即当没有（键都不补，保持旧记录的逐字形状）
    const groups = t.groups === undefined ? null : restoreGroups(t.groups);
    if (groups !== null) {
      entry.groups = t.groups;
      // splitSizes（WS-06 additive）：长度必须等于组数 - 1，否则整份丢弃
      const sizes = sanitizeSplitSizes(t.splitSizes, groups.groups.length);
      if (sizes !== null) entry.splitSizes = sizes;
    }
    if (extraRoots.length > 0) entry.extraRoots = extraRoots;
    projects[k] = entry;
  }
  return {
    v: 1,
    lastRoot: typeof r.lastRoot === 'string' && r.lastRoot !== '' ? r.lastRoot : null,
    projects,
  };
}

export function sessionProjectKey(rootDir: string): string {
  return pathKey(rootDir);
}

export function sessionProjectOf(rec: SessionRecord, rootDir: string): SessionProjectRecord | null {
  return rec.projects[sessionProjectKey(rootDir)] ?? null;
}

/** upsert 一个项目的会话态并顺手把 lastRoot 指向它（返回新对象，不改入参） */
export function upsertSessionProject(
  rec: SessionRecord,
  rootDir: string,
  data: {
    tabs: readonly string[];
    active: string | null;
    pinned: readonly string[];
    groups?: unknown;
    /** WS-06：分屏比例（未给 = 这次不写这一格；本仓调用方每次都传） */
    splitSizes?: readonly number[];
    /** WS-08：会话级附加根（未给 = 这次不写这一格；本仓调用方每次都传） */
    extraRoots?: readonly string[];
  },
): SessionRecord {
  const tabs = [...new Set(data.tabs)];
  const extraRoots = data.extraRoots === undefined ? undefined : sanitizeExtraRoots(data.extraRoots, rootDir);
  const next: SessionRecord = {
    v: 1,
    lastRoot: rootDir,
    projects: { ...rec.projects },
  };
  if (tabs.length === 0 && (extraRoots === undefined || extraRoots.length === 0)) {
    // 空标签集 + 无附加根 = 这个项目没有会话内容：删记录（重开不凭空造标签）。
    // 反过来说，**只挂着附加根**的项目要留记录（WS-08：重启后根还在）。
    delete next.projects[sessionProjectKey(rootDir)];
    return next;
  }
  const pinned = [...new Set(data.pinned)].filter((p) => tabs.includes(p));
  const active = data.active !== null && tabs.includes(data.active) ? data.active : tabs[0] ?? null;
  const entry: SessionProjectRecord = { tabs, active, pinned };
  // groups（MM-9 additive）：传入即存，但先过 restoreGroups 预校验——非法不存
  // （存了也恢复不出，只会让下次 sanitize 再滤一遍，不如这里就挡住）
  const groups = data.groups === undefined ? null : restoreGroups(data.groups);
  if (groups !== null) {
    entry.groups = data.groups;
    // splitSizes（WS-06）：长度必须对上这份快照的组数；对不上宁可不存（恢复时均分）
    const sizes = sanitizeSplitSizes(data.splitSizes, groups.groups.length);
    if (sizes !== null) entry.splitSizes = sizes;
  }
  if (extraRoots !== undefined && extraRoots.length > 0) entry.extraRoots = extraRoots;
  next.projects[sessionProjectKey(rootDir)] = entry;
  return next;
}

export async function loadSessionRecord(kv: SessionKv): Promise<SessionRecord> {
  return sanitizeSessionRecord(await kv.get<unknown>(SESSION_KEY));
}

export async function saveSessionRecord(kv: SessionKv, rec: SessionRecord): Promise<void> {
  await kv.set(SESSION_KEY, rec);
}

/* ------------ 防抖落盘调度（S2 #4：关项目强刷不丢最后一拍） ------------ */

/**
 * 一份待落盘的会话写（调度即快照）：回调 write 所需的全部信息都在这里，
 * 强刷时**不再回读现场**——关项目那一拍 resetProjectUiState 已把标签态清空，
 * 现场值只剩"已拆的"，快照才是关项目前最后一份真值。
 */
export interface SessionFlushPayload {
  root: string;
  kv: SessionKv;
  tabs: readonly string[];
  active: string | null;
  pinned: readonly string[];
  /** WS-06：分屏比例（与 groups 快照同源；缺省 = 老调用方只有标签） */
  splitSizes?: readonly number[];
  /** WS-08：会话级附加根（缺省 = 老调用方没有附加根） */
  extraRoots?: readonly string[];
}

export interface SessionFlushScheduler {
  /** 稳态变更：覆盖待写快照并重置计时器（窗口内只留最新一份，旧定时器作废） */
  schedule(payload: SessionFlushPayload): void;
  /**
   * 强制落盘（关项目 / kernel 更替 / 卸载收尾）：有待写就**同步**执行 write；
   * 无待写（计时器已到点、或从未排过）即 no-op。pending 先清后写 = 幂等，
   * 计时器到点与强刷两条路对同一份待写最多写一次，绝不双写。
   */
  flushNow(): void;
}

/**
 * 会话落盘的防抖调度器（零 React；计时器可注入，node 测试用假钟钉死时序）。
 * 默认 debounce = SESSION_FLUSH_DEBOUNCE_MS，走宿主 globalThis 计时器。
 */
export function createSessionFlushScheduler(deps: {
  write: (payload: SessionFlushPayload) => void;
  debounceMs?: number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): SessionFlushScheduler {
  const debounceMs = deps.debounceMs ?? SESSION_FLUSH_DEBOUNCE_MS;
  const setTimer = deps.setTimer ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
  const clearTimer =
    deps.clearTimer ??
    ((timer: unknown) => {
      globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>);
    });
  let pending: SessionFlushPayload | null = null;
  let timer: unknown = null;
  const clearPendingTimer = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };
  const flushNow = () => {
    clearPendingTimer();
    const payload = pending;
    if (!payload) return;
    pending = null; // 先清后写：再进一次的 flushNow（或迟到的计时器）都是 no-op
    deps.write(payload);
  };
  return {
    schedule(payload) {
      pending = payload;
      clearPendingTimer();
      timer = setTimer(flushNow, debounceMs);
    },
    flushNow,
  };
}

/* ================= 会话恢复的判据（WS-06：恢复前逐条校验文件还在） =================
 *
 * 背景：会话记录可能比盘上事实旧——作者在别处删了 / 移走了一些口上文件，重开项目时
 * 旧实现直接信任记录，于是标签栏里挂着一排点了没反应（或打开即报错）的幽灵标签。
 * 这里把「记录 × 盘上事实 × 崩溃恢复件 ⇒ 一份可恢复的标签/组态计划」收成**纯函数**
 * （`exists` 注入，node 侧给假的就是完整单测），异步探针只负责"有界并发地问一遍"。
 *
 * 为什么住在本文件：它读写的是同一份会话记录的形状，且恢复判据与记录清洗共用
 * "读不到 ≠ 没有"的门风；单开模块会多一枚文件进开机静态图（文件闸顶格零余量）。
 *
 * 口径（每条都有单测钉着）：
 * - 记录标签 ∪ 崩溃恢复件，去重保序；逐条过 `exists`，不存在即剔除；
 * - 探针本身出错（IO 瞬态）**按存在处理**——"读不到"不等于"没有"，宁可多留一条，
 *   也不凭一次读失败就把作者的东西从会话里抹掉；
 * - 激活标签：恢复件首条优先（原行为）→ 记录的 active（须仍在）→ 首个存活标签；
 * - 组态：快照里每组各自过滤，空组剔除；整份都空 ⇒ 不恢复布局（`null`）；
 *   布局/orientation 与标签存活与否无关，只要还有存活标签就照旧恢复；
 * - 剔除数量给一句人话（0 ⇒ null，不出声）。
 */
export interface SessionRestoreInput {
  /** 会话记录里的标签集（焦点组那一份） */
  readonly tabs: readonly string[];
  readonly active: string | null;
  readonly pinned: readonly string[];
  /** 记录里的组态快照（已过 `restoreGroups`；null = 没有合法快照） */
  readonly groups: EditorGroupsState | null;
  /** 崩溃恢复件（欢迎页点「恢复」时给出），优先打开 */
  readonly recovered: readonly string[];
  /** 盘上存在性判据（**同步读探针结果**：异步探针由 `probeExistingPaths` 先跑完） */
  readonly exists: (path: string) => boolean;
}

export interface SessionRestorePlan {
  /** 恢复出的组态（id 沿用快照里重新分配的那份）；null = 没有合法快照，调用方保持现状 */
  readonly groups: EditorGroupsState | null;
  /** 合并后的焦点组标签集（记录 ∪ 恢复件，已按存在性过滤） */
  readonly focusTabs: string[];
  readonly active: string | null;
  /** 固定标签 ∩ 存活标签（保序） */
  readonly pinned: string[];
  /** 因盘上不存在被剔除的标签（去重保序） */
  readonly missing: string[];
  /** 剔除数量的说明（0 ⇒ null） */
  readonly note: string | null;
}

/** 保序去重 */
function unique(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || p === '') continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

function safeExists(exists: (path: string) => boolean, path: string): boolean {
  try {
    return exists(path);
  } catch {
    return true; // 探针抛错 ≠ 文件不存在（见模块头注释第 2 条）
  }
}

/** 剔除说明的人话（数量为 0 不出声） */
export function droppedTabsNote(missing: number): string | null {
  if (!Number.isFinite(missing) || missing <= 0) return null;
  return `有 ${missing} 个上次打开的标签在磁盘上已找不到（可能被删除或移动），已从会话里跳过。`;
}

/** 组态快照逐组过滤（空组剔除；整份都空 ⇒ null） */
function filterGroups(
  groups: EditorGroupsState,
  exists: (path: string) => boolean,
): EditorGroupsState | null {
  const kept: EditorGroupState[] = [];
  for (const g of groups.groups) {
    const tabs = g.tabs.filter((p) => safeExists(exists, p));
    if (tabs.length === 0) continue;
    const active = g.active !== null && tabs.includes(g.active) ? g.active : tabs[0]!;
    kept.push({ id: g.id, tabs, active, ...(g.preview ? { preview: g.preview } : {}) });
  }
  if (kept.length === 0) return null;
  const activeGroupId = kept.some((g) => g.id === groups.activeGroupId)
    ? groups.activeGroupId
    : kept[0]!.id;
  return { groups: kept, activeGroupId, orientation: groups.orientation };
}

/**
 * 会话恢复计划（纯函数）。调用方拿到后：`groups !== null` 就整态换成它，
 * 再把 `focusTabs` / `active` 贴到它的焦点组上（与既有恢复语义逐字一致）。
 */
export function planSessionRestore(input: SessionRestoreInput): SessionRestorePlan {
  const exists = (p: string): boolean => safeExists(input.exists, p);
  const merged = unique([...input.tabs, ...input.recovered]);
  const focusTabs = merged.filter(exists);
  // 剔除计数要把**组态里另外几组**的标签也算上：那些标签不在 `tabs`（焦点组那一份）里，
  // 但它们同样因为盘上没了而消失——少报会让"有 N 个标签被跳过"这句话撒谎。
  const allTabs = unique([...(input.groups?.groups.flatMap((g) => g.tabs) ?? []), ...merged]);
  const missing = allTabs.filter((p) => !exists(p));
  const keptSet = new Set(focusTabs);
  const recoveredFirst = input.recovered.find((p) => keptSet.has(p)) ?? null;
  const active =
    recoveredFirst ??
    (input.active !== null && keptSet.has(input.active) ? input.active : null) ??
    focusTabs[0] ??
    null;
  return {
    groups: input.groups === null ? null : filterGroups(input.groups, exists),
    focusTabs,
    active,
    pinned: unique(input.pinned).filter((p) => keptSet.has(p)),
    missing,
    note: droppedTabsNote(missing.length),
  };
}

/**
 * 有界并发的存在性探针。
 *
 * 为什么要有界：恢复一个会话可能一次问几十条（多组标签并集），无节制地并发打 IPC
 * 只会把启动那一拍堆成一场雪崩。缺省 8 条一窗，够快也够稳。
 *
 * **失败语义**：某条探针 reject ⇒ 该条按"存在"收进结果集（与 `planSessionRestore`
 * 的 safeExists 同一条口径：读不到 ≠ 没有）。
 */
export async function probeExistingPaths(
  paths: readonly string[],
  exists: (path: string) => Promise<boolean>,
  concurrency = 8,
): Promise<Set<string>> {
  const list = [...new Set(paths.filter((p) => typeof p === 'string' && p !== ''))];
  const hit = new Set<string>();
  const limit = Math.max(1, Math.min(32, Math.floor(concurrency) || 1));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      const p = list[i]!;
      try {
        if (await exists(p)) hit.add(p);
      } catch {
        hit.add(p); // 瞬态失败按存在处理（见上）
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, () => worker()));
  return hit;
}
