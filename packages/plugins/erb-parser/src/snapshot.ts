/**
 * 索引快照（2026-10-12「内核优化」批 · 例 1：第二次开项目不用再等）。
 *
 * ## 问题
 *
 * `erb-parser` 的索引是纯内存态：每次 `project.opened` 都全量 walkDir → 逐文件
 * readText + parseErbText（2,317 个文件 / 362 万行 ≈ 2.9 s）。而**文件没变时，
 * 解析结果必然不变**——这是纯函数的定义所保证的。
 *
 * ## 方案
 *
 * 按**项目根**把 `{ path → (mtimeMs, textLength, ErbFile) }` 存进本插件的存储域
 * （`{appData}/store/erb-parser/<key>.json`，实测全量 JSON 约 10–20 MB、
 * `JSON.parse` 约 100–200 ms，满足 HANDOFF §十一 的"<500 ms"门槛）。重新打开项目时：
 *
 * ```
 * walkDir（1 次）→ 逐文件 stat 取 mtime（并发 IPC）
 *   → 与快照比对：mtime 一致 → **直接复用**解析结果（零读盘零解析）
 *              → 不一致/缺失 → 只重扫这些文件
 *   → 按本次 walk 顺序聚合（与全量重建的 byName 顺序逐位一致）
 *   → 广播 kojo.functionChanged（消费方无感）→ 异步落盘新快照
 * ```
 *
 * ## 纪律
 *
 * - **fail-closed**：快照结构/版本/项目根任一不符 → 整体弃用 + 删除 + 全量重建
 *   （绝不"修"快照——解析错误的结果比慢更危险）；
 * - **保守失效**：mtime 任一侧为 null（平台未提供/读失败）→ 视为过期；
 * - **顺序确定**：聚合永远按本次 walkDir 的顺序进行，快照只替换"来源"，
 *   不改变 `byName` 的聚合顺序（消费方对顺序的任何假设都不受影响）；
 * - **零游戏知识**：本模块只认识"文件与函数边界"，不认识任何命名约定。
 */
import type { ErbFile, ErbFunctionRef, FileStat } from '@kojo/plugin-api';

/**
 * 快照格式版本（结构不兼容时整体弃用重建）。
 *
 * **v1 → v2**（用户反馈 9）：`ErbFunction` 新增 `docComment`（函数上方紧邻注释块）。
 * 旧快照里没有这个字段，若继续复用会让函数树悬停**静默空白**且无从察觉——
 * 与其悄悄降级，不如按 `coerceSnapshot` 的 fail-closed 语义整体弃用、一次重建。
 * 代价：升级后首次开项目多等一段索引时间（此后照常走快照）。
 */
export const SNAPSHOT_VERSION = 2;

/** 单个文件的快照条目 */
export interface SnapshotEntry {
  /** 构建该条目时的文件 mtime（`readText`/`stat` 同源口径）；null = 平台未提供 → 恒视为过期 */
  readonly mtimeMs: number | null;
  /** 冗余校验位：条目文本长度（UTF-16 码元数；将来可升级为失效判据） */
  readonly textLength: number;
  /** 该文件的完整解析结果（纯数据，JSON 安全） */
  readonly file: ErbFile;
}

/** 索引快照（按项目根一份） */
export interface IndexSnapshot {
  readonly version: number;
  /** 快照所属项目根（加载时不匹配即弃用——换盘符/移动项目不复用） */
  readonly rootDir: string;
  readonly savedAt: number;
  readonly entries: Readonly<Record<string, SnapshotEntry>>;
}

/**
 * 快照存储键（FNV-1a 32 位 → 8 位十六进制）。
 *
 * 存储域 key 必须是安全段（`[A-Za-z0-9_][A-Za-z0-9._-]{0,119}`），而项目根是
 * 任意文件系统路径，故只存**哈希**；真实 rootDir 记录在快照值里，加载时校验。
 */
export function snapshotKeyFor(rootDir: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < rootDir.length; i++) {
    h ^= rootDir.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `index-v${SNAPSHOT_VERSION}-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * 聚合为索引（`files` + `byName`）。
 *
 * 从 `plugin.ts` 的内联循环抽出：**全量重建**与**快照复用**必须走同一份聚合代码，
 * 否则两条路径会悄悄分叉。顺序 = 传入顺序 = 本次 walkDir 顺序。
 */
export function aggregateIndex(files: Iterable<ErbFile>): {
  files: Map<string, ErbFile>;
  byName: Map<string, ErbFunctionRef[]>;
} {
  const fileMap = new Map<string, ErbFile>();
  const byName = new Map<string, ErbFunctionRef[]>();
  for (const file of files) {
    fileMap.set(file.path, file);
    for (const fn of file.functions) {
      const refs = byName.get(fn.normalizedName) ?? [];
      refs.push({
        name: fn.name,
        normalizedName: fn.normalizedName,
        filePath: fn.filePath,
        startLine: fn.startLine,
        endLine: fn.endLine,
        ...(fn.docComment !== undefined ? { docComment: fn.docComment } : {}),
      });
      byName.set(fn.normalizedName, refs);
    }
  }
  return { files: fileMap, byName };
}

/** 快照比对结果 */
export interface SnapshotDiff {
  /** mtime 一致、可直接复用解析结果的文件 */
  readonly reusable: string[];
  /** 需要重新读盘解析的文件（缺失 / mtime 变了 / mtime 不可判） */
  readonly stale: string[];
}

/**
 * 比对快照与当前文件清单（**纯函数**）。
 *
 * `stats` 取自 `io.stat`——与 `readText` 的 `mtimeMs` 同源（内核 readText 内部就是
 * stat），口径一致才可比。任一侧为 null（平台未提供 / stat 失败）一律判过期。
 */
export function diffSnapshot(
  snapshot: IndexSnapshot,
  paths: readonly string[],
  stats: ReadonlyMap<string, FileStat | null>,
): SnapshotDiff {
  const reusable: string[] = [];
  const stale: string[] = [];
  for (const p of paths) {
    const entry = snapshot.entries[p];
    const st = stats.get(p) ?? null;
    const fresh =
      entry !== undefined && entry.mtimeMs !== null && st !== null && st.mtimeMs === entry.mtimeMs;
    (fresh ? reusable : stale).push(p);
  }
  return { reusable, stale };
}

/** 校验未知数据是否为**本项目**的合法快照；任一不符返回 null（整体弃用） */
export function coerceSnapshot(raw: unknown, rootDir: string): IndexSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== SNAPSHOT_VERSION) return null;
  if (r.rootDir !== rootDir) return null;
  if (typeof r.savedAt !== 'number' || !Number.isFinite(r.savedAt)) return null;
  if (typeof r.entries !== 'object' || r.entries === null) return null;
  const entries: Record<string, SnapshotEntry> = {};
  for (const [p, v] of Object.entries(r.entries as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) return null;
    const e = v as Record<string, unknown>;
    if (typeof e.textLength !== 'number' || !Number.isFinite(e.textLength)) return null;
    if (e.mtimeMs !== null && typeof e.mtimeMs !== 'number') return null;
    const f = e.file as ErbFile | undefined;
    if (typeof f !== 'object' || f === null) return null;
    if (f.path !== p) return null; // 键与内容不一致 = 结构被手改过，不可信
    if (!Array.isArray(f.functions) || typeof f.lineCount !== 'number') return null;
    entries[p] = { mtimeMs: e.mtimeMs as number | null, textLength: e.textLength as number, file: f };
  }
  return { version: SNAPSHOT_VERSION, rootDir, savedAt: r.savedAt, entries };
}

/**
 * 合并出新快照的 entries：本次重扫的用新结果，其余沿用旧条目；
 * **已从磁盘消失的文件不保留**（快照不收尸就会越攒越大）。
 */
export function mergeEntries(
  prev: IndexSnapshot | null,
  paths: readonly string[],
  fresh: ReadonlyMap<string, SnapshotEntry>,
): Record<string, SnapshotEntry> {
  const out: Record<string, SnapshotEntry> = {};
  for (const p of paths) {
    const f = fresh.get(p);
    if (f) {
      out[p] = f;
      continue;
    }
    const old = prev?.entries[p];
    if (old) out[p] = old;
  }
  return out;
}
