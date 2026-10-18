import { pathKey } from '@kojo/plugin-api';
import type { SessionKv } from './session-store';

/**
 * 最近文件列表的持久层（MM-7/MV-8 编辑器肌肉记忆批）：欢迎页「最近文件」区的
 * 数据面，存进 kernel 全局存储（`{appData}/store/_global/recent-files-v1.json`），
 * 与 recent-projects / session-tabs 同一条 KV 通道。零 React 零 kernel 类型耦合——
 * 存取面 `SessionKv` 只要求 get/set，node 测试用内存替身即可。
 *
 * 口径：
 * - 键按 `pathKey(path)` 归一（Windows 大小写/分隔符折叠，与全仓路径判等同尺）；
 * - 队首 = 最近打开（openedAt 最大）；重开已存在的文件 ⇒ 提前到队首并刷新时间戳，
 *   绝不产生重复行（重复行会让作者以为同一个文件有两份历史）；
 * - 上限 RECENT_FILES_LIMIT：超出淘汰队尾（最旧）；
 * - 损坏容忍：盘上任何不合法形态回空列表（最近文件丢了可以重开文件，绝不能炸启动）；
 * - `rootDir` = 打开时所属的项目根：欢迎页无项目态点一条记录，据此决定
 *   「直接开文件」还是「先开项目再开文件」。
 */

export const RECENT_FILES_KEY = 'recent-files-v1';
/** 最近文件条数上限（欢迎页一屏放得下；再老的文件用快速打开/文件树找） */
export const RECENT_FILES_LIMIT = 20;

export interface RecentFileRecord {
  path: string;
  rootDir: string;
  openedAt: number;
}

/** 损坏容忍：任何不合法形态回空列表（绝不抛）；过滤缺字段条目、按 openedAt 降序稳定排序、去重、截断到上限 */
export function sanitizeRecentFiles(raw: unknown): RecentFileRecord[] {
  if (!Array.isArray(raw)) return [];
  const valid: RecentFileRecord[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.path !== 'string' || r.path === '') continue;
    if (typeof r.rootDir !== 'string' || r.rootDir === '') continue;
    if (typeof r.openedAt !== 'number' || !Number.isFinite(r.openedAt)) continue;
    valid.push({ path: r.path, rootDir: r.rootDir, openedAt: r.openedAt });
  }
  // 降序 = 队首最新；同 openedAt 保输入次序（sort 稳定，V8 引擎保证）
  valid.sort((a, b) => b.openedAt - a.openedAt);
  // 先排再去重：重复 path（盘上脏数据/手改）只留排序后的第一条（= openedAt 最大者）
  const seen = new Set<string>();
  const out: RecentFileRecord[] = [];
  for (const r of valid) {
    const key = pathKey(r.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= RECENT_FILES_LIMIT) break;
  }
  return out;
}

/**
 * upsert 一条最近文件并返回新数组（不改入参）。
 *
 * 同 path（pathKey 归一）已存在 ⇒ 提前到队首并刷新 openedAt/rootDir（换过项目
 * 归属就以新归属为准）；否则插入队首。截断到上限——被挤出去的是最旧的一条。
 */
export function upsertRecentFile(
  list: readonly RecentFileRecord[],
  rec: { path: string; rootDir: string; now: number },
): RecentFileRecord[] {
  const key = pathKey(rec.path);
  const next: RecentFileRecord[] = [{ path: rec.path, rootDir: rec.rootDir, openedAt: rec.now }];
  for (const r of list) {
    if (pathKey(r.path) === key) continue; // 命中旧纪录：丢弃，队首放新的
    next.push(r);
    if (next.length >= RECENT_FILES_LIMIT) break;
  }
  return next;
}

/** 按 pathKey 归一摘除（文件被删 / 改名时用；未命中 = 原样新数组） */
export function removeRecentFiles(list: readonly RecentFileRecord[], paths: readonly string[]): RecentFileRecord[] {
  if (paths.length === 0) return [...list];
  const gone = new Set(paths.map(pathKey));
  return list.filter((r) => !gone.has(pathKey(r.path)));
}

export async function loadRecentFiles(kv: SessionKv): Promise<RecentFileRecord[]> {
  return sanitizeRecentFiles(await kv.get<unknown>(RECENT_FILES_KEY));
}

export async function saveRecentFiles(kv: SessionKv, list: readonly RecentFileRecord[]): Promise<void> {
  await kv.set(RECENT_FILES_KEY, [...list]);
}
