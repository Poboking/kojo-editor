import {
  ERB_BODY_EXTENSIONS,
  KOJO_LEGACY_SOURCE_EXTENSION,
  KOJO_SOURCE_EXTENSION,
  isPathUnder,
  pathKey,
  type FileStat,
} from '@kojo/plugin-api';
import type { SessionKv } from './session-store';

/**
 * 最近打开的口上作品（工作区项目）列表的持久层（P0-6 欢迎页一键重开批）。
 *
 * 数据面是欢迎页「最近打开的口上作品」区块，存进 kernel 全局存储
 * （`{appData}/store/_global/recent-workspace-projects-v1.json`），与
 * recent-projects / recent-files / session-tabs 同一条 KV 通道。零 React、
 * 只要求 get/set（node 测试用内存替身即可）。
 *
 * 口径：
 * - 主键 = `projectId`（内核工作区项目的唯一 id）；同一项目重开只刷新时间戳，
 *   绝不产生重复行；
 * - 队首 = 最近打开（openedAt 最大）；上限 8 条，超出淘汰队尾（最旧）；
 * - 损坏容忍：盘上任何不合法形态回空列表（列表丢了可以重开项目，绝不能炸启动）；
 * - `dir` = 项目目录绝对路径（只读事实：用于呈现与「文件夹是否还在」探测，
 *   **不是**写路径参数）；
 * - `gameRoot` = 记录时所在的游戏项目根（可选，仅历史数据）。KW4C 段③ 起一键重开
 *   **不再**依赖它：口上作品住作者自己的工作区（常驻可写根），点一枚作品直接进
 *   作品会话（`openWorkspaceSession`）；「先打开游戏目录」那两句劝退话已撤——
 *   作者碰自己的作品不该需要先有一个游戏现场（S 级缺陷的入口半边）。
 */

export const RECENT_WORKSPACE_PROJECTS_KEY = 'recent-workspace-projects-v1';
/** 持久化条数上限（比展示上限宽两格：偶尔多留几条不会挤掉马上要用的） */
export const RECENT_WORKSPACE_PROJECTS_LIMIT = 8;
/** 欢迎页展示上限（一屏放得下；更早的用面板自己翻） */
export const RECENT_WORKSPACE_PROJECTS_DISPLAY_LIMIT = 6;

export interface RecentWorkspaceProject {
  projectId: string;
  name: string;
  /** 项目目录绝对路径（只读事实，不是写路径参数） */
  dir: string;
  openedAt: number;
  /** 记录时所在的游戏项目根；null/缺省 = 没留下可回去的工作现场 */
  gameRoot?: string;
}

/** 损坏容忍：任何不合法形态回空列表（绝不抛）；过滤缺字段、按 openedAt 降序、去重、截断 */
export function sanitizeRecentWorkspaceProjects(raw: unknown): RecentWorkspaceProject[] {
  if (!Array.isArray(raw)) return [];
  const valid: RecentWorkspaceProject[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.projectId !== 'string' || r.projectId === '') continue;
    if (typeof r.name !== 'string' || r.name === '') continue;
    if (typeof r.dir !== 'string' || r.dir === '') continue;
    if (typeof r.openedAt !== 'number' || !Number.isFinite(r.openedAt)) continue;
    valid.push({
      projectId: r.projectId,
      name: r.name,
      dir: r.dir,
      openedAt: r.openedAt,
      ...(typeof r.gameRoot === 'string' && r.gameRoot !== '' ? { gameRoot: r.gameRoot } : {}),
    });
  }
  valid.sort((a, b) => b.openedAt - a.openedAt);
  // 先排再去重：同一 projectId 只留 openedAt 最大的一条（排序后第一条）
  const seen = new Set<string>();
  const out: RecentWorkspaceProject[] = [];
  for (const r of valid) {
    if (seen.has(r.projectId)) continue;
    seen.add(r.projectId);
    out.push(r);
    if (out.length >= RECENT_WORKSPACE_PROJECTS_LIMIT) break;
  }
  return out;
}

/** upsert 一条记录并返回新数组（不改入参）：同 projectId 提前到队首并刷新全部字段 */
export function upsertRecentWorkspaceProject(
  list: readonly RecentWorkspaceProject[],
  rec: Omit<RecentWorkspaceProject, 'openedAt'> & { now: number },
): RecentWorkspaceProject[] {
  const next: RecentWorkspaceProject[] = [
    {
      projectId: rec.projectId,
      name: rec.name,
      dir: rec.dir,
      openedAt: rec.now,
      ...(rec.gameRoot !== undefined && rec.gameRoot !== '' ? { gameRoot: rec.gameRoot } : {}),
    },
  ];
  for (const r of list) {
    if (r.projectId === rec.projectId) continue;
    next.push(r);
    if (next.length >= RECENT_WORKSPACE_PROJECTS_LIMIT) break;
  }
  return next;
}

/** 按 projectId 摘除（未命中 = 原样新数组） */
export function removeRecentWorkspaceProject(
  list: readonly RecentWorkspaceProject[],
  projectId: string,
): RecentWorkspaceProject[] {
  return list.filter((r) => r.projectId !== projectId);
}

/* -------------------- 欢迎页一键重开（KW4C 段③：直接进作品会话） -------------------- */

/** 作品会话的最小形状（与 `use-project-session.ts` 的 `WorkspaceSession` 同构，这里不 import React 侧） */
export interface WorkspaceLaunchSession {
  projectId: string;
  /** 落点 = `projectDirOf(projectId)`（内核工作区服务现读），**不是**记录里的自由路径 */
  dir: string;
  name: string;
}

export type WorkspaceLaunchPlan =
  | { kind: 'enter'; session: WorkspaceLaunchSession }
  | { kind: 'notify'; message: string };

/**
 * 「点一枚最近作品 → 进哪」的判据（纯函数，KW4C 段③）。
 *
 * 口径：
 * - 作品**现在还在**工作区清单里 ⇒ `enter`：会话的 `dir` 一律取内核
 *   `projectDirOf(id)` 的现读值（记录里的 `dir` 只是旧照片，拿它当会话根等于信一份
 *   可能过期的自由路径）；名字同样现读（改过名的作品回屏上是新名字）；
 * - 不在清单里（被删 / 被移动）⇒ `notify` 一句人话。**绝不静默返回 null**——
 *   点了没反应正是本批要消灭的缺陷（铁律 4）；
 * - `gameRoot` 不参与判据：作品会话不认游戏现场，回到那次的工作现场这件事已经作废。
 */
export function planRecentWorkspaceOpen(
  rec: Pick<RecentWorkspaceProject, 'projectId' | 'name'>,
  projects: readonly { id: string; name: string }[],
  projectDirOf: (projectId: string) => string,
): WorkspaceLaunchPlan {
  const hit = projects.find((p) => p.id === rec.projectId);
  if (hit === undefined) {
    return {
      kind: 'notify',
      message: `「${rec.name}」已不在工作区列表里，可能已被删除或移动。`,
    };
  }
  return { kind: 'enter', session: { projectId: hit.id, name: hit.name, dir: projectDirOf(hit.id) } };
}

/**
 * 文件路径 → 所属工作区 projectId（「从面板打开作品」的折算判据）。
 *
 * 只认落在某个作品目录之下的文件；嵌套时取**最深**的那条（最具体的归属），
 * 不在任何作品里 ⇒ null。归属判定走契约的 `isPathUnder`（Windows 折大小写、
 * 两种分隔符同一口径），不在这里另写一套前后缀比较。
 */
export function workspaceProjectIdForPath(
  list: readonly Pick<RecentWorkspaceProject, 'projectId' | 'dir'>[],
  filePath: string,
): string | null {
  let best: { projectId: string; dirLength: number } | null = null;
  for (const r of list) {
    if (!isPathUnder(r.dir, filePath)) continue;
    if (best === null || r.dir.length > best.dirLength) {
      best = { projectId: r.projectId, dirLength: r.dir.length };
    }
  }
  return best?.projectId ?? null;
}

/** 行渲染态：unknown = 尚未探测 / 探测不可用（不标记）；missing = 目录或清单不在 */
export type WorkspaceRowState = 'ok' | 'missing' | 'unknown';

/**
 * 「目录探测 + workspace.json 探测」→ 行渲染态。
 *
 * - 任一侧 `undefined` = 探测不可用（浏览器壳等）⇒ unknown，行内不标记；
 * - 目录 `null` ⇒ missing（所在文件夹已不在）；
 * - 目录在、清单 `null` ⇒ missing（文件里没有 workspace.json：删了 / 改名了）；
 * - 两侧都有 ⇒ ok。
 */
export function workspaceRowState(
  dirStat: FileStat | null | undefined,
  manifestStat: FileStat | null | undefined,
): WorkspaceRowState {
  if (dirStat === undefined || manifestStat === undefined) return 'unknown';
  if (dirStat === null || manifestStat === null) return 'missing';
  return 'ok';
}

/** 失效原因（给行内文案用；null = 没有失效） */
export type WorkspaceMissingReason = 'dir' | 'manifest' | null;

export function workspaceMissingReason(
  dirStat: FileStat | null | undefined,
  manifestStat: FileStat | null | undefined,
): WorkspaceMissingReason {
  if (dirStat === undefined || manifestStat === undefined) return null;
  if (dirStat === null) return 'dir';
  if (manifestStat === null) return 'manifest';
  return null;
}

/**
 * 探测缓存键：pathKey(directory) + openedAt——重开过 ⇒ 时间戳变 ⇒ 重扫；
 * 同一目录两种写法（大小写 / 分隔符）折成同一个键，不重复探测。
 */
export function workspaceProjectStatKey(
  r: Pick<RecentWorkspaceProject, 'dir' | 'openedAt'>,
): string {
  return `${pathKey(r.dir)}\u0000${r.openedAt}`;
}

/* -------------------- 首文件挑选（正文优先） -------------------- */

/**
 * 正文扩展名的优先级（全部来自契约单源，折叠小写比较）：
 * `.kojo` / `.kojo1` / `.ERB` / `.erm`。
 */
const BODY_EXTENSION_ORDER: readonly string[] = [
  KOJO_SOURCE_EXTENSION,
  KOJO_LEGACY_SOURCE_EXTENSION,
  ...ERB_BODY_EXTENSIONS,
].map((e) => e.toLowerCase());

/** 取文件名末段扩展名（小写，含点）；无扩展名回空串 */
function lowerExtname(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * 只挑**正文文件**：按 `.kojo → .kojo1 → .ERB → .erm` 的优先级找，同档取字典序最小；
 * 没有正文 ⇒ null（调用方可据此再往制品目录找，而不是先把 README 交出去）。
 */
export function pickFirstBodyName(names: readonly string[]): string | null {
  for (const ext of BODY_EXTENSION_ORDER) {
    const hit = names
      .filter((n) => n.length > 0 && lowerExtname(n) === ext)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))[0];
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * 从文件名清单里挑「打开哪一枚」（app 本地规则，与 `kojo-project-kit` 的
 * `pickFirstOpenName` 同一判据，但宿主不能反向 import 插件包 ⇒ 在这里留一份纯函数）：
 * 1. **正文文件**：见 {@link pickFirstBodyName}；
 * 2. 没有正文时退回第一枚非 README、非 `workspace.json` 的文件；
 * 3. 只剩 README 时退回 README；清单为空 ⇒ null。
 *
 * 为什么先认扩展名：口上作品的根上常有角色表 / 说明 / 清单，按位置挑会把作者
 * 送到一张数据表，而不是他刚想写的正文。
 */
export function pickFirstEditableName(names: readonly string[]): string | null {
  const files = names.filter((n) => n.length > 0);
  const body = pickFirstBodyName(files);
  if (body !== null) return body;
  const nonMeta = files
    .filter((n) => n !== 'README.md' && n !== 'README.MD' && n !== 'workspace.json')
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))[0];
  if (nonMeta !== undefined) return nonMeta;
  const readme = files.find((n) => n === 'README.md' || n === 'README.MD');
  return readme ?? null;
}

/* -------------------- 存取 -------------------- */

export async function loadRecentWorkspaceProjects(kv: SessionKv): Promise<RecentWorkspaceProject[]> {
  return sanitizeRecentWorkspaceProjects(await kv.get<unknown>(RECENT_WORKSPACE_PROJECTS_KEY));
}

export async function saveRecentWorkspaceProjects(
  kv: SessionKv,
  list: readonly RecentWorkspaceProject[],
): Promise<void> {
  await kv.set(RECENT_WORKSPACE_PROJECTS_KEY, [...list]);
}

/** 两份列表是否逐条等值（有变化才落盘） */
export function sameRecentWorkspaceProjects(
  a: readonly RecentWorkspaceProject[],
  b: readonly RecentWorkspaceProject[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.projectId !== y.projectId ||
      x.name !== y.name ||
      x.dir !== y.dir ||
      x.openedAt !== y.openedAt ||
      x.gameRoot !== y.gameRoot
    ) {
      return false;
    }
  }
  return true;
}
