import type { ScopedStorage } from '@kojo/plugin-api';
import { pathKey } from '@kojo/plugin-api';

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
 *   重开不凭空造标签；
 * - 恢复时 pinned 与 tabs 取交集（记录可能比盘上事实旧——文件被删/移动）。
 */

export const SESSION_KEY = 'session-tabs-v1';
/** 会话标签集落盘的防抖（与 view-state-store 的 flush 节奏同族） */
export const SESSION_FLUSH_DEBOUNCE_MS = 600;

export interface SessionProjectRecord {
  tabs: string[];
  active: string | null;
  pinned: string[];
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
    if (tabs.length === 0) continue; // 空标签集不入库（重开不造标签）
    const active = typeof t.active === 'string' && tabs.includes(t.active) ? t.active : tabs[0] ?? null;
    projects[k] = { tabs, active, pinned: stringList(t.pinned, 64).filter((p) => tabs.includes(p)) };
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

/** upsert 一个项目的标签集并顺手把 lastRoot 指向它（返回新对象，不改入参） */
export function upsertSessionProject(
  rec: SessionRecord,
  rootDir: string,
  data: { tabs: readonly string[]; active: string | null; pinned: readonly string[] },
): SessionRecord {
  const tabs = [...new Set(data.tabs)];
  const next: SessionRecord = {
    v: 1,
    lastRoot: rootDir,
    projects: { ...rec.projects },
  };
  if (tabs.length === 0) {
    delete next.projects[sessionProjectKey(rootDir)];
    return next;
  }
  const pinned = [...new Set(data.pinned)].filter((p) => tabs.includes(p));
  const active = data.active !== null && tabs.includes(data.active) ? data.active : tabs[0] ?? null;
  next.projects[sessionProjectKey(rootDir)] = { tabs, active, pinned };
  return next;
}

export async function loadSessionRecord(kv: SessionKv): Promise<SessionRecord> {
  return sanitizeSessionRecord(await kv.get<unknown>(SESSION_KEY));
}

export async function saveSessionRecord(kv: SessionKv, rec: SessionRecord): Promise<void> {
  await kv.set(SESSION_KEY, rec);
}
