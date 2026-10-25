/**
 * 文件树**按节点订阅诊断**的视图层（PERF 批：把"诊断版本变了"与"这个节点变了"分开）。
 *
 * 病根（真壳实测，切一次标签 `problem-store` 的版本号必 +1）：版本一换，
 * `summarizeProblems` 就按新的输入数组重建 ⇒ `byKey` 与聚合表整份换引用。旧写法把这两张表
 * 当**值**穿进树（`probs` / `probMarks` 是引用型 props）⇒ 树本体必须订阅版本号，一次切标签
 * 就要把整棵树（组头 + 全部可见行）重画一遍。可实际变的东西通常只有"活动文件那一格"，
 * 其余 99% 的格子一个数都没动。
 *
 * 这里的做法：宿主**不再订阅版本号**，改成每个徽标节点自己订阅，快照取**原始值**
 * （`"错误:警告:提示"` 字符串）——内容没变的节点拿到的快照逐字相等 ⇒ React 不为它排重渲染。
 * 于是"版本 +1"的真实代价 = 一次 O(有诊断的文件数) 建表 + 每节点一次 Map 查表。
 *
 * 为什么快照必须是原始值：`useSyncExternalStore` 用 `Object.is` 判"要不要重渲染"，
 * 返回对象的话每次都是新引用 ⇒ 等于没订阅（正是旧写法的病）。数字 / 字符串天生稳定。
 *
 * 为什么建表而不是每次查 `byKey`：行路径来自索引 / 磁盘列举，`byKey` 的键是 `pkey` 归一值，
 * 逐行现算 `pkey`（两次正则 + 一次小写）在两千多行的语料上是白付的钱。所以
 *
 * - 行：`pkey(path)` 由 `useMemo` 按行路径算一次，之后每次通知只做 `Map.get`；
 * - 节点：整张聚合表连同快照串按 **(分组引用, 汇总引用)** 缓存，一版本只算一遍。
 */
import { useMemo, useSyncExternalStore } from 'react';
import {
  snapshot as problemSnapshot,
  subscribe as subscribeProblems,
  summarizeProblems,
  type ProblemFileCounts,
  type ProblemSummary,
} from './problem-store';
import { baseName } from './file-tree-model';
import { packageKey } from './file-tree-reveal';
import { pkey } from './file-tree-ops';
import type { Group } from './file-tree-types';

/** 组 / 包 tooltip 里点名的一个文件（形状即 `TreeProbMark` 的输入，不另造第二份） */
export interface ProbFile {
  readonly name: string;
  readonly error: number;
  readonly warning: number;
}

/** 一个树节点（角色组 / 作者包）折到的诊断量 */
export interface ProblemsAtNode {
  readonly error: number;
  readonly warning: number;
  /** 该节点下**有错误/警告**的文件（错误多的在前，超出上限的折进 `more`） */
  readonly files: readonly ProbFile[];
  readonly more: number;
}

export interface ProblemsByNode {
  /** 键 = 角色组标签（`Group.label`） */
  readonly groups: ReadonlyMap<string, ProblemsAtNode>;
  /** 键 = 作者包键（`packageKey(组, 包)`） */
  readonly packages: ReadonlyMap<string, ProblemsAtNode>;
}

const EMPTY_MARKS: ProblemsByNode = { groups: new Map(), packages: new Map() };

/** 节点 tooltip 最多点名几个文件，其余折成「另 n 个」（展开的作者包动辄几十份文件） */
const MARK_FILE_CAP = 6;

/**
 * 把「已打开文件的诊断汇总」折到树的**两层节点标题**上（纯函数，可单测）。
 *
 * 数据源是 `problem-store.summarizeProblems`——与状态栏那颗、面板表头、面板组头、
 * **单条文件行**徽标**同一次遍历的同一份结果**（工包 E 判据：不许两处各算一套）。查表走
 * `byKey`（`pkey` 归一）：树里这一行的路径来自索引/磁盘列举，与注册表键可能差个
 * 分隔符方向或大小写，按字面比对就会漏标（同一个文件两种写法 ≠ 两个文件）。
 *
 * 只折错误 / 警告两档：只报了 `info` 的文件不在树上说话。
 */
export function treeProblemMarks(groups: readonly Group[], summary: ProblemSummary): ProblemsByNode {
  if (summary.files.length === 0) return EMPTY_MARKS;
  interface MutableMark {
    error: number;
    warning: number;
    files: ProbFile[];
  }
  const byGroup = new Map<string, MutableMark>();
  const byPackage = new Map<string, MutableMark>();
  const bump = (m: MutableMark, f: ProblemFileCounts): void => {
    m.error += f.error;
    m.warning += f.warning;
    m.files.push({ name: baseName(f.path), error: f.error, warning: f.warning });
  };
  const slot = (map: Map<string, MutableMark>, key: string): MutableMark => {
    let m = map.get(key);
    if (m === undefined) {
      m = { error: 0, warning: 0, files: [] };
      map.set(key, m);
    }
    return m;
  };
  for (const g of groups) {
    for (const s of g.subs) {
      const pkgKey = s.label === null ? null : packageKey(g.label, s.label);
      for (const file of s.files) {
        const hit = summary.byKey.get(pkey(file));
        if (hit === undefined || hit.error + hit.warning === 0) continue;
        bump(slot(byGroup, g.label), hit);
        if (pkgKey !== null) bump(slot(byPackage, pkgKey), hit);
      }
    }
  }
  const freeze = (map: ReadonlyMap<string, MutableMark>): ReadonlyMap<string, ProblemsAtNode> => {
    const out = new Map<string, ProblemsAtNode>();
    for (const [key, m] of map) {
      // 错误多 → 警告多 → 名字码位序（不用 localeCompare：CJK 分区域，钉值会变红）
      const sorted = [...m.files].sort(
        (a, b) => b.error - a.error || b.warning - a.warning || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );
      out.set(key, {
        error: m.error,
        warning: m.warning,
        files: sorted.slice(0, MARK_FILE_CAP),
        more: Math.max(0, sorted.length - MARK_FILE_CAP),
      });
    }
    return out;
  };
  return { groups: freeze(byGroup), packages: freeze(byPackage) };
}

/* ---------------- 节点层：聚合表 + 快照串，按 (分组, 汇总) 身份缓存 ---------------- */

/** 节点快照串：计数 + 点名串。内容没变 ⇒ 字符串逐字相等 ⇒ 该节点不重渲染 */
function nodeSnapshot(mark: ProblemsAtNode): string {
  return `${mark.error}|${mark.warning}|${mark.more}|${mark.files
    .map((f) => `${f.name}:${f.error}:${f.warning}`)
    .join(',')}`;
}

interface NodeCache {
  /** 键 = 角色组标签 / 作者包键；值 = 该节点的快照串 */
  readonly groups: ReadonlyMap<string, string>;
  readonly packages: ReadonlyMap<string, string>;
}

const EMPTY_NODE_CACHE: NodeCache = { groups: new Map(), packages: new Map() };

let cachedGroups: readonly Group[] | null = null;
let cachedSummary: ProblemSummary | null = null;
let cachedMarks: ProblemsByNode = EMPTY_MARKS;
let cachedSnaps: NodeCache = EMPTY_NODE_CACHE;

/**
 * 让缓存跟上当前诊断版本（内容没变就原样返回）。
 *
 * 两者都由上游稳定：`groups` 来自宿主的 `useMemo`，`summary` 来自 `summarizeProblems`
 * 的输入身份缓存 ⇒ 同一诊断版本内反复调用都命中缓存，`getSnapshot` 不会每次造新表
 * （那等于没订阅）。一次重建的成本 = 扫一遍分组（O(全部文件) 次 `pkey`）+ 排序有诊断的那些，
 * 与旧 `treeProblemMarks` 同量级，但**只付一次**（旧写法每帧付）。
 */
function refreshNodeCache(groups: readonly Group[]): void {
  const summary = summarizeProblems(problemSnapshot());
  if (groups === cachedGroups && summary === cachedSummary) return;
  cachedGroups = groups;
  cachedSummary = summary;
  cachedMarks = treeProblemMarks(groups, summary);
  const g = new Map<string, string>();
  const p = new Map<string, string>();
  for (const [key, mark] of cachedMarks.groups) g.set(key, nodeSnapshot(mark));
  for (const [key, mark] of cachedMarks.packages) p.set(key, nodeSnapshot(mark));
  cachedSnaps = { groups: g, packages: p };
}

/**
 * 组 / 包标题行的诊断量（行自己订阅：版本号变了但这一格没变 ⇒ 不重渲染）。
 *
 * `kind` 决定查哪一层：角色组用 `group`，作者包用 `package`（键 = `packageKey`）。
 */
export function useNodeProblems(
  groups: readonly Group[],
  kind: 'group' | 'package',
  key: string,
): ProblemsAtNode | undefined {
  const layer = kind === 'group' ? 'groups' : 'packages';
  const getSnapshot = (): string => {
    refreshNodeCache(groups);
    return (layer === 'groups' ? cachedSnaps.groups : cachedSnaps.packages).get(key) ?? '';
  };
  const snap = useSyncExternalStore(subscribeProblems, getSnapshot, getSnapshot);
  if (snap === '') return undefined;
  return (layer === 'groups' ? cachedMarks.groups : cachedMarks.packages).get(key);
}

/* ---------------- 行层：整张"归一键 → 快照串"表，按汇总引用缓存 ---------------- */

const EMPTY_ROW_SNAPS: ReadonlyMap<string, string> = new Map();

let cachedRowSummary: ProblemSummary | null = null;
let cachedRowSnaps: ReadonlyMap<string, string> = EMPTY_ROW_SNAPS;

function rowSnapshots(): ReadonlyMap<string, string> {
  const summary = summarizeProblems(problemSnapshot());
  if (summary === cachedRowSummary) return cachedRowSnaps;
  cachedRowSummary = summary;
  if (summary.files.length === 0) {
    cachedRowSnaps = EMPTY_ROW_SNAPS;
    return cachedRowSnaps;
  }
  const next = new Map<string, string>();
  for (const [key, v] of summary.byKey) {
    // 只有 info 的文件按既有口径**不开口**（那一档面板表头本来就在说）
    if (v.error + v.warning === 0) continue;
    next.set(key, `${v.error}:${v.warning}:${v.info}`);
  }
  cachedRowSnaps = next;
  return next;
}

/**
 * 单条文件行的诊断量（快照 = `"错误:警告:提示"`，只有 info 的文件返回 `undefined`）。
 *
 * `pkey` 只在行路径变化时算一次（`useMemo`）：每次诊断通知只剩一次 `Map.get`。
 * 归一键查表的口径与 `skip` / 组包聚合同源——行路径来自索引 / 磁盘列举，注册表键来自
 * 编辑器，Windows 两种写法是同一个文件，字面比对会漏标。
 */
export function useRowProblems(path: string): ProblemFileCounts | undefined {
  const key = useMemo(() => pkey(path), [path]);
  const getSnapshot = (): string => rowSnapshots().get(key) ?? '';
  const snap = useSyncExternalStore(subscribeProblems, getSnapshot, getSnapshot);
  if (snap === '') return undefined;
  const [error, warning, info] = snap.split(':').map(Number) as [number, number, number];
  return { path, error, warning, info };
}
