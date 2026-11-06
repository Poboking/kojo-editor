/**
 * 整项目扫描的**诊断增量缓存**（MCP-PERF-S7，2026-11-07）。
 *
 * ## 它断的是哪一种浪费
 *
 * 「每改一行跑全项目＝浪费」——真源在整项目扫描链（`project-scan-schedule` →
 * `createProjectScanner` → `decorateScanFile`）：每一轮把计划内全部文件**重新读盘 +
 * 重新问全部装饰贡献**（R4a 批量诊断 400 文件那条；MCP 的 `semantic.diagnostics` /
 * `problems.diagnostics` 只是 Monaco marker 的只读投影，零重算，与本缓存无关）。
 * 本模块给这条链补 (mtime,size) 输入指纹缓存 + 脏集增量：未变文件回缓存条目
 * （不读盘、不重算），变过的文件重跑。
 *
 * ## 判据（全部钉在 project-scan-diag-cache.test.ts）
 *
 * - **键 = 盘上事实**：per-file (mtimeMs, size)，与索引 `fileMtimes`/`fileSizes` 同源
 *   （生产走 `kernel.io.statFiles` 现取，比索引快照更新鲜——索引增量是去抖的，
 *   扫描轮跑在它前后都可能）。**编辑器缓冲永远不参与**：缓冲是活的，逐键都变，
 *   拿它当键就等于没有缓存；缓存只对盘上事实成立。stamp 取不到（stat 失败 /
 *   不存在）⇒ 不命中且不入缓存，保守重算。
 * - **换代即整体失效**：跨文件诊断（未定义名 / 实参个数 / 重复定义）的事实面是
 *   **别的文件的声明**，逐文件指纹看不见它——所以换代事实单独一层：声明面指纹
 *   （`declarationSurfaceFingerprint`，全项目 (路径, 归一名, 参数个数) 布局）或
 *   贡献方名单（适配器 / 插件换装 = 换规则）变了 ⇒ 整份清空。声明面未变的索引
 *   换代（纯函数体编辑的增量轮）⇒ 条目存活，保存后的下一轮才能"恰一文件重算"。
 *   换代事实取不到（索引未就绪 / 指纹算不出）⇒ 该轮不缓存（保守）。
 * - **有界**：≤ {@link DIAG_CACHE_MAX_ENTRIES}（2,000）条，溢出**最旧先出（FIFO）**。
 *   选 FIFO 不选 LRU 的理由：本缓存的访问形态是**批量轮询**（一轮把计划内文件逐个
 *   问一遍，命中与否只看 stamp，与"最近有没有被访问"无关）；LRU 的频度信号在
 *   轮询形态下恒为噪声，FIFO 同样有界、确定性、实现零歧义。
 * - **可见**：命中 / 未命中 / 清空次数都在 `stats()`；每轮回执账上
 *   `cached` / `recomputed` 两个计数（`ScanOutcome` / `ProjectScanCoverage`）。
 *
 * ## 条目内容的"完整"指什么
 *
 * 一格 = 该文件在本轮的全部结论：`problems`（逐贡献方合并 + `toEditorProblem`
 * 映射后的**完整诊断**，含 erb-semantics 把 failedRules 折成的
 * `ERB_DIAGNOSTICS_RULE_FAILED` 诊断）+ `failedContributors`（**完整性标记**：
 * 哪几路贡献方抛错被跳过——扫描链的"failedRules"就是它，命中回放时 degraded
 * 账照记，不许静默洗白）。截断标记不在此层：扫描产物是整档结果，页截断住在
 * MCP 投影那层（未动）。
 *
 * ## 已知窗口（如实声明）
 *
 * 指纹在本轮开头一次性批量取（一趟 `statFiles`）：文件在"取指纹之后、它被读到
 * （或被命中跳过）之前"落盘改动的极端窗口里，本轮给的是旧结论——下一次
 * `file.changed` 触发的轮会拿新指纹重算它。这是与既有 60s 节流同量级的窗口，
 * 不新增失效模式；逐文件现 stat 会把一趟 IPC 拆成几百趟，得不偿失。
 *
 * 本模块只经**动态 import** 进程序（`project-scan-schedule.ts` 懒装载）：开机
 * 静态图 197 文件顶格，新文件静态进图即破 ps10 闸。
 */

import type { EditorProblem } from './problem-store';

/** 盘上指纹：与索引 `fileMtimes`/`fileSizes` 同源的两元组（皆有限数字才有资格缓存） */
export interface DiagStamp {
  readonly mtimeMs: number;
  readonly size: number;
}

/**
 * 换代事实（每轮开跑时问一次）：
 * - `indexVersion`：`ErbIndex.version`（整扫与增量各 +1）；取不到 = null。
 * - `declSurface`：全项目声明面指纹（见 {@link declarationSurfaceFingerprint}）；取不到 = null。
 */
export interface DiagGen {
  readonly indexVersion: number | null;
  readonly declSurface: string | null;
  /** 本轮参与合并的装饰贡献方 id（顺序无关）；缺席 = 不比对该维 */
  readonly contributorIds?: readonly string[];
}

/** 一格缓存：某文件在某一轮的完整结论（诊断 + 完整性标记） */
export interface DiagCacheEntry {
  readonly problems: readonly EditorProblem[];
  readonly failedContributors: readonly string[];
}

/** 条目上限：真实口上域 2,000+ 文件一档（SCAN_MAX_FILES_PER_RUN=400 的 5 倍），再留换项目余量 */
export const DIAG_CACHE_MAX_ENTRIES = 2_000;

export interface DiagCacheStats {
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
  readonly flushedGenerations: number;
}

export interface DiagScanCache {
  /** 每轮开跑宣告换代事实；null = 这轮换代事实取不到 ⇒ get/put 全部 no-op（保守不缓存） */
  beginRound(gen: DiagGen | null): void;
  /** 未变文件回缓存条目；stamp 缺席 / 换代后无此键 ⇒ null（调用方重算） */
  get(path: string, stamp: DiagStamp | null | undefined): DiagCacheEntry | null;
  /** 存本轮结论；stamp 缺席不入（保守）。溢出按最旧先出 */
  put(path: string, stamp: DiagStamp | null | undefined, entry: DiagCacheEntry): void;
  stats(): DiagCacheStats;
}

/** FNV-1a 32 位（与 kernel io 的桶身份尺同族；这里自持一份，模块零依赖） */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 全项目**声明面**指纹：跨文件诊断（未定义名查 `byName`、实参个数查声明参数表、
 * 重复定义看跨文件配对）消费的事实 = 「哪个文件声明了什么名字、几个参数」的布局。
 * 布局没变 ⇒ 这些诊断的跨文件输入没变 ⇒ 逐文件指纹可以放行；布局变了 ⇒ 整份清空。
 *
 * 入参刻意收宽成 `unknown`（懒装载边界上宿主传 `ErbIndex.files`，本模块不 import
 * plugin-api，形状在函数内自证）；迭代序不保证 ⇒ 收进扁平表后排序再哈希（同一布局
 * 必得同一指纹）。空集 / 结构不像 ⇒ null（取不到 = 保守，换代即清）。
 */
export function declarationSurfaceFingerprint(files: unknown): string | null {
  if (files === null || typeof files !== 'object') return null;
  if (typeof (files as { entries?: unknown }).entries !== 'function') return null;
  const parts: string[] = [];
  for (const [path, file] of files as ReadonlyMap<string, { readonly functions?: unknown }>) {
    if (typeof path !== 'string') return null;
    const fns = file?.functions;
    if (!Array.isArray(fns)) {
      parts.push(`${path}\u001f-`);
      continue;
    }
    for (const fn of fns) {
      const holder = fn as { readonly normalizedName?: unknown; readonly params?: unknown } | null | undefined;
      const name = typeof holder?.normalizedName === 'string' ? holder.normalizedName : '';
      const arity = Array.isArray(holder?.params) ? holder.params.length : -1;
      parts.push(`${path}\u001f${name}\u001f${arity}`);
    }
  }
  if (parts.length === 0) return null; // 空面没有"面"可言：交给保守（反正没有可命中的键）
  parts.sort();
  return fnv1a(parts.join('\u001e'));
}

/** 一条缓存记录（指纹 + 结论 + FIFO 入场序由 Map 插入序表达） */
interface CacheRecord {
  readonly stamp: DiagStamp;
  readonly entry: DiagCacheEntry;
}

export function createDiagScanCache(opts?: { maxEntries?: number }): DiagScanCache {
  const maxEntries = Math.max(1, Math.floor(opts?.maxEntries ?? DIAG_CACHE_MAX_ENTRIES));
  const map = new Map<string, CacheRecord>();
  let bound: { readonly gen: DiagGen } | null = null;
  /** 本轮是否可缓存（换代事实缺席 = false ⇒ get/put no-op） */
  let roundOpen = false;
  let hits = 0;
  let misses = 0;
  let flushed = 0;

  const contributorFpOf = (gen: DiagGen): string | null =>
    gen.contributorIds === undefined ? null : [...gen.contributorIds].sort().join('\u0001');

  return {
    beginRound(gen) {
      if (gen === null) {
        roundOpen = false; // 换代事实取不到：这轮不缓存（既有条目保留——不是清空，是跳过）
        return;
      }
      if (bound !== null) {
        const prev = bound.gen;
        const prevFp = contributorFpOf(prev);
        const nextFp = contributorFpOf(gen);
        // 名单可比（任一侧给过）且不等 ⇒ 规则变了：清空。缺席⇄在场的形状跳变同样算变（保守）。
        const contributorChanged = (prevFp !== null || nextFp !== null) && prevFp !== nextFp;
        // 声明面两侧都拿得到且相等 ⇒ 跨文件输入未变（纯函数体编辑的增量轮）⇒ 放行；
        // 其余（变了 / 任一侧取不到）⇒ 保守清空。
        const surfacesEqual =
          gen.declSurface !== null && prev.declSurface !== null && gen.declSurface === prev.declSurface;
        if (contributorChanged || !surfacesEqual) {
          map.clear();
          flushed++;
        }
      }
      bound = { gen };
      roundOpen = true;
    },

    get(path, stamp) {
      if (!roundOpen || bound === null) {
        misses++;
        return null;
      }
      const record = map.get(path);
      if (record === undefined || stamp === null || stamp === undefined) {
        misses++;
        return null;
      }
      if (record.stamp.mtimeMs !== stamp.mtimeMs || record.stamp.size !== stamp.size) {
        misses++; // 脏文件永远重算
        return null;
      }
      hits++;
      return record.entry;
    },

    put(path, stamp, entry) {
      if (!roundOpen || bound === null) return;
      if (stamp === null || stamp === undefined) return; // 取不到 = 不缓存（保守）
      if (!Number.isFinite(stamp.mtimeMs) || !Number.isFinite(stamp.size)) return;
      map.delete(path); // 重存 = 刷新 FIFO 位（刚验证过的事实最年轻）
      map.set(path, { stamp, entry });
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },

    stats: () => ({ size: map.size, hits, misses, flushedGenerations: flushed }),
  };
}
