/**
 * MCP 真源腿 · 检索墙的可续取分片面 `resumeBySlice`（B16 批，LaneZ，2026-11-06）。
 *
 * 一句话判性（**真引擎实测**，用例见 `packages/app/src-tauri/src/search_tests.rs` 的
 * `wall_*` 九条断言 + 一枚 `#[ignore]` 探针，探针把全部读数原样打出来）：
 * 引擎单次调用封顶 `SEARCH_HARD_CAP = 5000` 条命中（10,000 条的夹具实测只回 5,350、
 * `filesScanned 107/200`），且**闸下的选择是调度产物**（同参复跑 8 次出现 2 种集合：
 * 7 次 5,350、1 次 5,300；单线程与八线程的闸下集合差 350）⇒ 闸下那批命中不是任何
 * 全序的前缀，旧面的游标在它上面根本无从续。
 * 但**按互不相交的目录 / 文件分组分片**拼接，实测与解析式真值逐条相等
 * （8 片 × 1,250 条 = 10,000：重复 0、缺 0、多 0，每片 `truncated:false`）
 * ⇒ 「超过 5,000 条命中」这件事第一次有了可自证无重无漏的续取路。**判性成立**。
 *
 * 实测同时钉死实现侧六条硬约束（每条一个用例，不靠推理）：
 * 1. **跨调用没有去重**（`wall_no_dedup_across_calls_so_slices_must_be_disjoint`：同一片
 *    拼两次 1,300 条只剩 650 唯一）⇒ 分片计划必须两两不相交；本腿建划时逐条排除
 *    嵌套根 / 相交子目录（一次调用内部给重叠根引擎会按绝对路径小写键去重，但那次调用
 *    的账目本身就被闸切过，救不了跨调用）。
 * 2. **不触墙的片可复现到顺序**（`wall_non_truncated_slice_is_reproducible_in_order`）
 *    ⇒ 片内沿用 B1 那套「已消费前缀指纹」游标，不造第二套格式。
 * 3. **分片形状不影响命中集合**，且 `roots` 允许给文件路径
 *    （`wall_slice_shape_does_not_change_the_hit_set_and_file_roots_work`；
 *    `wall_encoding_shapes_are_slice_invariant` 把 CRLF / GBK / shift_jis / md / 二进制
 *    混样在「全量 / 子目录片 + 根上散文件片 / 逐文件」三种形状下对拍到同一个集合）
 *    ⇒ 目录切到切不动的稠密扁平树还能按文件继续切。
 * 4. **单文件 `SEARCH_PER_FILE_CAP`(500) 那堵墙分片修不掉**
 *    （`wall_per_file_cap_is_not_fixable_by_slicing`：1,200 条命中只回 500 并报 truncated）
 *    ⇒ 一片只剩一个文件仍触墙时**显式说明仍不完整**并把逐文件 `fs.readFile` 分页指路。
 * 5. **B18 起，结论四那堵墙可由「续取凭据」越过（不是放宽闸）**：引擎新增
 *    `options.resumeAfterMatches`（对每个文件丢弃前 N 条命中，**每次调用每文件仍 ≤500**）
 *    与回显 `resumeAppliedMatches`。本腿只在「一片只剩一个文件根」时把**片内偏移**当作
 *    该文件的命中序号，写进既有 B1 游标的下标（`片序号 × 进制 + 片内偏移`）——
 *    **零新增 MCP 入参**，旧调用方请求体逐字不变。三条边界都出声、不静默：
 *    ① 回显不等于请求值（老宿主不认这个键 / 文件命中数已少于续取起点）⇒ 丢弃该响应并按墙
 *    收口，绝不把重复页端上桌；② 多文件片（目录片）的偏移是若干文件的拼接，**不能**当单文件
 *    序号（那会把同片别的文件的命中一起丢掉）⇒ 仍按结论四点名 `fs.readFile`；
 *    ③ 游标进制 8192 是硬上界（偏移 ≥ 进制就指到下一片去）⇒ 单条文件片至多续到
 *    `MCP_SEARCH_FILE_RESUME_MAX_SEGMENTS × 每文件上限`（16 × 500 ＝ 8,000）条，越界显式停住。
 * 6. **隐藏条目必须从建划里排除**（`wall_hidden_entries_leak_in_when_named_as_file_roots`：
 *    一次全量扫给 1 条、把 `.gitignore` 点名成文件根给 2 条 ⇒ 引擎遍历按 `is_hidden_name`
 *    跳过隐藏条目，但**文件根不经这一跳**）。不排除 ⇒ 拼接会比一次全量扫**多出**命中，
 *    「无重无漏」当场破掉；建划因此逐条排除点开头名字（判据同尺 `is_hidden_name`）。
 *    符号链接不需要同款特判：链接根本来就不被跟随（`wall_symlink_roots_are_not_followed_either_way`）。
 *
 * 闸一根没放宽：Rust `SEARCH_HARD_CAP`、本面 `SEARCH_ENGINE_HARD_CAP`、`max_results` 的
 * clamp 一字未动；每片仍走调用方传入的同一条 `searchWindow(offset, limit)`
 * ＝ `min(5000, offset + limit)`。每片都是**一次既有 `search_text` 调用**
 * ⇒ 零新 Rust 命令、零新写通道、零热路径改动（枚举只走 `kernel.io.walkDir`，与 `fs.tree` 同一条读腿）。
 *
 * 开关形状：可选新入参 `resumeBySlice:true`，**缺省零行为变化**。旧面 `search.all` /
 * `workspace.searchAll` / `tasks.start(kind:search)` 的既有语义逐字不动，包括「触墙即
 * `hasMore:false` + `engineWallReached` + `knownTotal:false` + note」那一套（锚＝既有回归
 * `mcp-pagination-completeness.test.ts` 判据 4）。为什么不自动接管：一次性检索的返回体
 * 形状不告诉调用方「这是墙下前缀还是全集」，拿返回体猜要不要分片会把旧面的账改掉。
 *
 * 游标（还是 B1 的 `^[0-9a-f]{8}:\\d{1,10}$` 编解码，一格装两件事）：
 * - 指纹 = `pageFingerprint([...分片计划 key, ...本片已消费前缀 key])`：计划里任何目录
 *   增删文件、或本片已消费前缀的内容变了 ⇒ 显式 `changedDuringPaging:true` 并从**第 0 片
 *   第 0 条**重来（绝不盲切旧偏移冒充连续）；
 * - 下标 = `片序号 × MCP_SEARCH_SLICE_CURSOR_STRIDE + 片内偏移`；进制取严格大于引擎单次
 *   上限 5,000 的 2 的幂 ⇒ 片内偏移不可能进位到下一片；
 * - **判不了的就说判不了**（铁律 4）：游标没有累加器 ⇒ 已消费完的**别片**总量本腿报不出，
 *   `knownTotal` 在这种形状下继续 false 并带 `knownTotalReason`；真总量＝客户端逐页
 *   `sliceTotal` 相加（走完时 `walkComplete:true` 交代这件事）。同理，别片「只改正文
 *   不改文件清单」的变化本腿不重扫、察觉不到 ⇒ 每页都带 `prefixReverified` 写明重扫了什么。
 *
 * 硬上限三枚（常量 + 依据；超限**显式报错并给分批指引**，绝不静默少一片，口径照
 * `fs.readMany` 的 64 条硬上限）：
 * - `MCP_SEARCH_SLICE_MAX_SLICES = 64`：一片＝一次 `search_text`（一趟多线程盘扫），
 *   与 `fs.readMany` 单次 64 条同尺；
 * - `MCP_SEARCH_SLICE_MAX_GROUP_FILES = 64`：一条文件根片的批大小（也是单个目录里散文件
 *   超过多少就再切一片），与 `fs.readMany` 的 64 条同尺；64 × 路径闸 512 字符 ＝ 32KiB，
 *   仍压在宿主不可信串闸 64Ki 之下；
 * - `MCP_SEARCH_SLICE_MAX_CHILD_ENTRIES = 5000`：建划只做深度 1 枚举，与 `fs.tree` /
 *   `io.listDir` 的既有单页上限同尺（这两个闸值本批一个没动）。
 *
 * ps10 纪律：与 `real-sources-io.ts` 同侧，只被动态 import 的 MCP 装载链拉起，不进开机图。
 * 依赖注入形状照 `batch-read-leg.ts`：只 `import type` 那些形状，不反向 import 运行时。
 */
import { McpFailure, decodePageCursor, encodePageCursor, pageFingerprint } from '@kojo/mcp-host';
import type { McpKernelLike, McpSearchRequestLike, McpSearchResultLike } from './real-sources-io';

/** 一次续取最多多少片（超限显式 INVALID_ARGS；与 `fs.readMany` 的 64 条同尺）。 */
export const MCP_SEARCH_SLICE_MAX_SLICES = 64;
/**
 * 一条文件根片的批大小，也是「一个目录的文件多到多少就不再按目录成片」的阈值（64）：
 * 与 `fs.readMany` 单次 64 条同尺；64 × 路径闸 `MAX_PATH_CHARS`(512) ＝ 32KiB，
 * 压在宿主不可信串闸 64Ki 之下（文件根清单是**请求侧**数组，走同一条 IPC 载荷判据）。
 * ⇒ 一趟续取最多覆盖 `64 × 64 = 4,096` 个文件，再大的树显式 INVALID_ARGS 分批。
 */
export const MCP_SEARCH_SLICE_MAX_GROUP_FILES = 64;
/** 建划那一趟枚举超过这个数 ⇒ 显式 RESOURCE_UNAVAILABLE（与 fs.tree / io.listDir 单页同尺）。 */
export const MCP_SEARCH_SLICE_MAX_CHILD_ENTRIES = 5000;
/** 建划枚举的深度上限（与 `fs.tree` 的 `maxDepth` 上限同尺＝16，本批不动那个闸）。 */
export const MCP_SEARCH_SLICE_MAX_DEPTH = 16;
/** 游标里「片内偏移」的进制：严格大于引擎单次上限 5000 的 2 的幂（8192）。 */
export const MCP_SEARCH_SLICE_CURSOR_STRIDE = 8192;
/**
 * **单文件逐段续取**的段数上限（B18，本批新墙的唯一有界出口）：16 段 × 500 条 ＝ 8,000 条。
 *
 * 为什么必须是 16 而不是"随便多大"：续取凭据**不新增游标位**（B1 的游标仍是
 * `指纹:片序号 × 进制 + 片内偏移`，`packages/mcp-host` 那侧一个字没改），
 * 所以「片内偏移」必须永远留在自己的进制格子里 ——
 * `MCP_SEARCH_FILE_RESUME_MAX_SEGMENTS × 单文件上限 < MCP_SEARCH_SLICE_CURSOR_STRIDE`
 * （16 × 500 = 8,000 < 8,192）。越过这一格就是**进位串片**：偏移会被读成下一片的位置，
 * 无重无漏当场破掉。这一条不变量有用例直接钉死（`mcp-search-file-resume.test.ts`）。
 *
 * 到达上限仍触墙 ⇒ 当场按墙出声（`blockedSlice.reason:'file-resume-segments-exhausted'`），
 * 绝不静默少一段，也不改游标格式。出路只有 `fs.readFile` 逐页读全文（话术里点名）。
 */
export const MCP_SEARCH_FILE_RESUME_MAX_SEGMENTS = 16;

/** 注入形状：内核 seam + 与一次性检索**同源**的根算法 / 窗口口径 / 路径投影。 */
export interface SearchSliceDeps {
  readonly getKernel: () => McpKernelLike | null;
  readonly requireProject: (kernel: McpKernelLike | null) => Record<string, unknown>;
  /** 与一次性检索同一个根算法（`searchRootsOf`）：本腿绝不另起一套根的取法。 */
  readonly searchRootsOf: (
    project: Record<string, unknown>,
    rootDir: string,
    sourcesOnly: boolean,
  ) => readonly string[];
  readonly searchInFiles: (request: McpSearchRequestLike) => Promise<McpSearchResultLike>;
  readonly nextSearchId: () => number;
  readonly toRelativePath: (abs: string, rootDir: string) => string;
  /** 既有窗口口径（`min(SEARCH_ENGINE_HARD_CAP, offset + limit)`）——逐字复用，不放宽。 */
  readonly searchWindow: (offset: number, limit: number) => number;
  /** 引擎单次封顶（由调用方注入，避免同一个闸在 TS 侧出现第二个常数）。 */
  readonly engineCap: number;
  /**
   * 引擎**单文件**命中上限（与 Rust `SEARCH_PER_FILE_CAP` 同尺，由调用方注入——
   * 同一个闸在 TS 侧只留一处常数）。B18 的逐段续取以它为段长：一段最多回这么多条，
   * 段号 × 段长就是续取凭据（`resumeAfterMatches`）。本批不放宽它。
   */
  readonly perFileCap: number;
}

/** 一条分片：`roots` = 一次既有 `search_text` 调用的根集合（目录根或文件根，两两不相交）。 */
interface Slice {
  readonly kind: 'dir' | 'files';
  readonly roots: readonly string[];
  readonly label: string;
}

/** 命中身份：与 `pageSearchHits` 的 keyOf 逐字同尺（`path|line|preview`）。 */
export function sliceHitKey(h: Record<string, unknown>): string {
  return `${String(h['path'] ?? '')}|${String(h['line'] ?? '')}|${String(h['preview'] ?? '')}`;
}

/** 绝对路径的父目录（两种分隔符都认；根目录 / 无分隔符 ⇒ 空串）。 */
function parentDir(abs: string): string {
  const k = Math.max(abs.lastIndexOf('\\'), abs.lastIndexOf('/'));
  return k <= 0 ? '' : abs.slice(0, k);
}

/** `child` 是否落在 `parent` 之内（目录前缀比较，忽略大小写与分隔符形态——Windows 语料）。 */
export function isWithinDir(child: string, parent: string): boolean {
  const c = child.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const p = parent.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return p !== '' && c !== p && c.startsWith(`${p}/`);
}

/** 枚举条目（`kernel.io.walkDir` 的最窄投影）。 */
interface WalkEntry {
  readonly path: string;
  readonly isDirectory: boolean;
}

/**
 * 条目名是否隐藏（以 `.` 开头）——判据逐字取 Rust `is_hidden_name`（`lib.rs` 的
 * `name.starts_with('.')`），**不是**「VCS 目录名单」。为什么必须排除：
 * 引擎遍历时按 `is_hidden_name` 跳过隐藏条目，但**文件根**走的是 `collect_files` 的
 * seeds 分支，直接过 `walk_consider`，不经这一跳 ⇒ 把 `.gitignore` 当根递进去它就被扫，
 * 一次全量扫却不碰它 ⇒ 拼接会比全量**多出**命中。实测见
 * `search_tests.rs::wall_hidden_entries_leak_in_when_named_as_file_roots`
 * （全量 1 条 / 点名隐藏文件 2 条 / 排除隐藏条目后拼接 == 全量）。
 */
export function isHiddenEntryName(abs: string): boolean {
  const k = Math.max(abs.lastIndexOf('\\'), abs.lastIndexOf('/'));
  const name = k < 0 ? abs : abs.slice(k + 1);
  return name.startsWith('.');
}

/**
 * 相对某个扫描根的路径里是否含隐藏段——判据与引擎一致：**遍历时逐条条目名**判，
 * 根自身的名字不参与（`collect_files` 把根直接塞进队列，不过 `is_hidden_name`）。
 */
function hasHiddenSegmentUnder(root: string, abs: string): boolean {
  const rel = abs.slice(root.length).replace(/^[\\/]+/, '');
  return rel.split(/[\\/]+/).some((seg) => seg !== '' && seg.startsWith('.'));
}

/** 逐条路径的稳定序比较：**不用 localeCompare**（ICU / locale 一变，分片计划就变，
 *  跨调用可复现的游标当场失效）；按码位比是纯函数，走到哪台机器都同一个序。 */
function cmpPath(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * 一趟枚举（只读，走 `kernel.io.walkDir`——与 `fs.tree` 同一条列举腿，本腿不自己 walk）。
 * 深度 `MCP_SEARCH_SLICE_MAX_DEPTH`（与 fs.tree 的 maxDepth 上限同尺），条目数超过
 * `MCP_SEARCH_SLICE_MAX_CHILD_ENTRIES` ⇒ 显式 RESOURCE_UNAVAILABLE 带收窄指引，绝不静默截断。
 * 这一趟**同时**是分片计划指纹的输入：清单里任何目录增删一个文件，指纹就变
 * ⇒ 游标必须能抓到（否则「拼接 == 一次全量扫」这句话只覆盖到本片，是半句话）。
 */
async function walkInventory(kernel: McpKernelLike, root: string): Promise<readonly WalkEntry[]> {
  const raw = (await kernel.io.walkDir(root, {
    maxDepth: MCP_SEARCH_SLICE_MAX_DEPTH,
    includeFiles: true,
    includeDirs: true,
  })) as unknown[];
  const out: WalkEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const path = typeof e['path'] === 'string' ? e['path'] : '';
    if (path === '' || path === root) continue;
    if (typeof e['isDirectory'] !== 'boolean') {
      throw new McpFailure(
        'RESOURCE_UNAVAILABLE',
        `分片建划失败：枚举腿对 ${path} 没给 isDirectory 读数（不靠文件名猜目录 / 文件）。`,
      );
    }
    out.push({ path, isDirectory: e['isDirectory'] === true });
  }
  if (out.length > MCP_SEARCH_SLICE_MAX_CHILD_ENTRIES) {
    throw new McpFailure(
      'RESOURCE_UNAVAILABLE',
      `分片建划失败：${root} 这一趟枚举带回 ${out.length} 条，超过本面硬上限 ` +
        `${MCP_SEARCH_SLICE_MAX_CHILD_ENTRIES}（与 fs.tree / io.listDir 的单页上限同尺，本批未放宽）。` +
        '请改用 scope:"sources" 收窄根集合，或按目录逐片调用一次性检索。',
    );
  }
  return out;
}

/** 两两不相交的根：嵌套在外层根之内的那些逐条排除（实测跨调用无去重 ⇒ 相交就是重复）。 */
export function dropNestedRoots(roots: readonly string[]): {
  readonly kept: string[];
  readonly dropped: string[];
} {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const r of [...roots].sort(cmpPath)) {
    if (kept.some((k) => isWithinDir(r, k))) dropped.push(r);
    else kept.push(r);
  }
  return { kept, dropped };
}

/** 建划结果：分片计划 + **整棵树可见文件清单**（后者进游标指纹）。 */
export interface SlicePlan {
  readonly slices: readonly Slice[];
  readonly inventory: readonly string[];
  readonly droppedNestedRoots: readonly string[];
}

/** 一条文件路径相对扫描根的第一个目录段（不存在 ⇒ 该文件直接挂在根上）。 */
function depthOneDir(root: string, file: string): string | null {
  let cur = file;
  let par = parentDir(cur);
  while (par !== root && par !== '' && isWithinDir(cur, root)) {
    const next = parentDir(par);
    if (next === par) return null;
    // par 正好是根的直接子目录 ⇒ 分组键就是它（不是文件自己）
    if (next === root) return par;
    cur = par;
    par = next;
  }
  return null;
}

/**
 * 建划：每个根一趟枚举 ⇒ 「文件数 ≤ 单片上限的子目录一片（按目录根）」+
 * 「超阈值的目录与根上散文件按 ≤64 个一条文件根片」。
 * - 序全部自定（按码位比小写路径，不用 localeCompare ⇒ 跨机器可复现），
 *   `walkDir` 的返回序不保证，而分片计划必须跨调用逐字可复现（游标靠它）；
 * - 隐藏条目（任一段以 `.` 开头）逐条排除 ⇒ 与一次全量扫同口径（实测结论八）；
 * - 相交排除是**双向**的：子目录里含别的根、或子目录本身在别的根之下，都不成片
 *   （实测结论五：跨调用没有去重，相交就是重复）。
 */
export async function buildSlicePlan(
  kernel: McpKernelLike,
  roots: readonly string[],
): Promise<SlicePlan> {
  const { kept, dropped } = dropNestedRoots(roots);
  const slices: Slice[] = [];
  const inventory: string[] = [];
  for (const root of kept) {
    const entries = await walkInventory(kernel, root);
    const files = entries
      .filter((c) => !c.isDirectory && !hasHiddenSegmentUnder(root, c.path))
      .map((c) => c.path)
      .sort(cmpPath);
    inventory.push(...files);
    const foreign = kept.filter((r) => r !== root);
    const owns = (p: string): boolean => !foreign.some((r) => isWithinDir(p, r) || isWithinDir(r, p));
    // 按「深度 1 目录」分组；挂在根上的散文件自成一组（key = null）
    const groups = new Map<string | null, string[]>();
    for (const f of files) {
      if (!owns(f)) continue;
      const key = depthOneDir(root, f);
      const bucket = groups.get(key);
      if (bucket) bucket.push(f);
      else groups.set(key, [f]);
    }
    for (const [dir, groupFiles] of groups) {
      if (dir !== null && groupFiles.length <= MCP_SEARCH_SLICE_MAX_GROUP_FILES) {
        slices.push({ kind: 'dir', roots: [dir], label: dir });
        continue;
      }
      for (let i = 0; i < groupFiles.length; i += MCP_SEARCH_SLICE_MAX_GROUP_FILES) {
        const chunk = groupFiles.slice(i, i + MCP_SEARCH_SLICE_MAX_GROUP_FILES);
        slices.push({ kind: 'files', roots: chunk, label: `${dir ?? root}#files@${i}` });
      }
    }
  }
  slices.sort((a, b) => cmpPath(a.label, b.label));
  return { slices, inventory: inventory.sort(cmpPath), droppedNestedRoots: dropped };
}

/** 一片的引擎返回 → MCP 命中投影（相对路径口径与旧面逐字一致）。 */
function projectHits(
  engine: McpSearchResultLike,
  deps: SearchSliceDeps,
  rootDir: string,
): Record<string, unknown>[] {
  const hits: Record<string, unknown>[] = [];
  for (const file of engine.files) {
    for (const match of file.matches) {
      hits.push({
        path: deps.toRelativePath(file.path, rootDir),
        line: match.line,
        preview: match.preview,
      });
    }
  }
  return hits;
}

/** 单次引擎调用（一片 / 一段）的账目。 */
interface SliceRun {
  readonly engine: McpSearchResultLike;
  readonly hits: Record<string, unknown>[];
  readonly window: number;
  /** 这次调用请求引擎丢掉的条数（0 = 不带凭据 = 旧面那一次调用，逐字不变）。 */
  readonly skip: number;
  /** 引擎**回显**的实际丢弃条数；这一位缺席 = 这台宿主根本不认识续取凭据。 */
  readonly applied: number | null;
  /** 这一页在**本次返回的窗口**里的下标（旧面 = 片内偏移；续取段 = 段内偏移）。 */
  readonly windowOffset: number;
}

/** 逐段续取的账（只在续取接管过时出现）。 */
interface FileResumeAccount {
  readonly segment: number;
  readonly skip: number;
  readonly inSegment: number;
  readonly applied: number | null;
  readonly honored: boolean;
  readonly advanced: boolean;
  readonly ceiling: boolean;
}

export interface SearchSliceCallContext {
  readonly args: Record<string, unknown>;
  readonly query: string;
  readonly project: Record<string, unknown>;
  readonly rootDir: string;
  readonly sourcesOnly: boolean;
  readonly limit: number;
  /** 裸 `offset`（无游标时才用；有游标 ⇒ 起点由游标里的「片序号 + 片内偏移」决定）。 */
  readonly offset: number;
  readonly hasCursor: boolean;
  readonly fsFreshness?: Record<string, unknown>;
}

/**
 * 分片续取主路。每次调用只跑 1 片（游标比对不过而需要从头重来时才会跑到 2 片），
 * 账目逐片可见：`slicesRun` / `perSliceTruncated` / `engineWallReached`（只在真触墙时出现）/
 * `knownTotal`（单片计划且未触墙才转 true，别的一律 false + `knownTotalReason`）。
 */
export function createSearchSliceRunner(deps: SearchSliceDeps) {
  return async (ctx: SearchSliceCallContext): Promise<Record<string, unknown>> => {
    const kernel = deps.getKernel();
    if (!kernel) {
      throw new McpFailure('RESOURCE_UNAVAILABLE', '内核未到场：分片续取没有枚举腿可用（不静默、不退回全量）');
    }
    const roots = deps.searchRootsOf(ctx.project, ctx.rootDir, ctx.sourcesOnly);
    if (roots.length === 0) {
      throw new McpFailure(
        'RESOURCE_UNAVAILABLE',
        '分片续取拒绝执行：根集合为空（sourcesOnly 给了但不是合法目录清单）。' +
          '一次性检索的既有语义仍照发（旧面零回退），但分片续取没有根可扫就不许装出「在续」。',
      );
    }
    const built = await buildSlicePlan(kernel, roots);
    const plan = built.slices;
    if (plan.length === 0) {
      throw new McpFailure(
        'RESOURCE_UNAVAILABLE',
        `分片建划结果为空：${roots.join(' | ')} 一层没有任何可扫条目（没有一棵树被静默当成「搜完了」）。`,
      );
    }
    if (plan.length > MCP_SEARCH_SLICE_MAX_SLICES) {
      throw new McpFailure(
        'INVALID_ARGS',
        `分片数 ${plan.length} 超过本面硬上限 ${MCP_SEARCH_SLICE_MAX_SLICES}` +
          '（一片＝一次既有 search_text 调用，与 fs.readMany 的单次 64 条硬上限同尺；闸不放宽）。' +
          '请分批：用 scope:"sources" 收窄根集合，或按目录逐片调用一次性检索。' +
          '本腿绝不静默少扫第 65 片以后的目录。',
      );
    }

    // 指纹输入：整棵树的可见文件清单 + 分片计划本身（任一处变了都算「盘态变了」）。
    const planKeys = ['inv', ...built.inventory, ...plan.map((s) => `${s.kind}:${s.roots.join('|')}`)];
    const decoded = ctx.hasCursor ? decodePageCursor(ctx.args['cursor']) : null;
    if (ctx.hasCursor && decoded === null) {
      // 形状非法在调用方的 pageParamsFor 就已 INVALID_ARGS；走到这里只有「合法但没意义」
      throw new McpFailure('INVALID_ARGS', 'resumeBySlice 的 cursor 无法解析（必须是上一页 nextCursor 的原样回传）');
    }

    /**
     * 取一片（或一片里的一段）。
     * - `skip === 0` ⇒ **与旧面逐字同一次调用**：不带续取凭据这个键，窗口口径一字不动；
     * - `skip > 0` ⇒ 带 `options.resumeAfterMatches = skip`（Rust `search_text` 的 additive 入参，
     *   B18）：引擎在该文件里先丢掉 `skip` 条，再按**原有三闸**收口 ⇒ 每段每文件返回仍 ≤ 单文件上限。
     * 回显 `resumeAppliedMatches` 缺席 = 这台宿主根本不认识这个键（旧宿主 / 调试宿 Node 镜像），
     * 由 `resumeHonored` 判出，绝不把「它回吐的前 500 条」当成新一页。
     */
    async function fetchWindow(index: number, skip: number, windowOffset: number): Promise<SliceRun> {
      const slice = plan[index] as Slice;
      const window = deps.searchWindow(windowOffset, ctx.limit);
      const engine = await deps.searchInFiles({
        searchId: deps.nextSearchId(),
        roots: slice.roots,
        query: ctx.query,
        // 检索开关与旧面逐字一致（本批不新增任何检索语义；也不放宽任何一格闸）
        options: {
          isRegex: false,
          caseSensitive: false,
          wholeWord: false,
          extensions: [],
          maxResults: window,
          ...(skip > 0 ? { resumeAfterMatches: skip } : {}),
        },
      });
      const echoed = engine.resumeAppliedMatches;
      return {
        engine,
        hits: projectHits(engine, deps, ctx.rootDir),
        window,
        skip,
        applied: typeof echoed === 'number' ? echoed : null,
        windowOffset,
      };
    }

    /** 旧面那一次调用（不带凭据）——缺省路形状，B16 的每一格账都从这里出。 */
    async function runSlice(index: number, localOffset: number): Promise<SliceRun> {
      return fetchWindow(index, 0, localOffset);
    }

    /**
     * 游标指纹的可复现形态（两把尺，按位置判该用哪把）：
     * - **旧面尺**：`planKeys + 本片窗口已消费前缀`——B16 原样，一个字符没动；
     * - **续取段尺**：旧面尺再加一格 `resume@{skip}`——续取页的窗口不再从 0 开始，
     *   整段前缀不在手里，能重算的只有「本段已消费的那一截 + 段起点」。
     * 段起点是**位置**不是内容 ⇒ 计划里少一条目录、清单变一个名字，两种尺都会失配
     * （`planKeys` 在两边都在），不会出现「换个计划就假装前缀没问题」。
     */
    function fingerprintForms(r: SliceRun, consumedInWindow: number): string[] {
      const head = r.hits.slice(0, consumedInWindow).map(sliceHitKey);
      const plain = pageFingerprint([...planKeys, ...head]);
      if (r.skip === 0) return [plain];
      return [pageFingerprint([...planKeys, `resume@${r.skip}`, ...head]), plain];
    }

    /** 续取凭据是否被这台宿主真的执行了（回显存在且等于请求值；请求 0 不需要回显）。 */
    function resumeHonored(r: SliceRun): boolean {
      if (r.skip === 0) return true;
      return r.applied !== null && r.applied === r.skip;
    }

    let sliceIndex = 0;
    let localOffset = ctx.hasCursor ? 0 : Math.max(0, Math.floor(ctx.offset));
    let changedDuringPaging = false;
    if (decoded) {
      const coarse = Math.floor(decoded.index / MCP_SEARCH_SLICE_CURSOR_STRIDE);
      const rest = decoded.index % MCP_SEARCH_SLICE_CURSOR_STRIDE;
      // 下标落在计划外（旧面的裸偏移游标 / 计划缩短）⇒ 不猜语义，按「从头重来」出声处理。
      if (coarse >= plan.length) {
        sliceIndex = 0;
        localOffset = 0;
        changedDuringPaging = true;
      } else {
        sliceIndex = coarse;
        localOffset = rest;
      }
    }

    /* ---------------- B18：单文件上限的逐段续取（只接管「一片只剩一个文件根」） ---------------- */
    const cap = deps.perFileCap;
    const resumeOffsetLimit = MCP_SEARCH_FILE_RESUME_MAX_SEGMENTS * cap;
    /**
     * 续取资格 = **计划形状**，不是返回体形状：一条文件根片且只有这一条根。
     * 为什么不用「引擎这次只回了一个文件」来判：目录片的窗口本来就能合法地超过 500
     * （60 文件 × 200 条 = 12,000 条那片就该走墙），拿返回体猜会把 B16 已经绿的
     * 「多文件片触 5,000 条墙」那一档整条改道（实测挂的就是 `mcp-search-slice-resume` 判据 3-4）。
     * 于是这一批的形状判据与 B16 的 `irreducible` 同一把尺：**分不动**的那些片才交给逐段续取。
     */
    const resumableSlice = plan[sliceIndex] as Slice;
    const singleFilePlan = resumableSlice.kind === 'files' && resumableSlice.roots.length === 1;
    /** 游标声称的单文件命中总数（= 段号 × 段长 + 段内偏移）；超过 8,000 就是进制要串片，不收。 */
    const claimedOffset = localOffset;
    const resumeSegment = singleFilePlan && cap > 0 ? Math.floor(claimedOffset / cap) : 0;
    let resume: FileResumeAccount | null = null;
    let run: SliceRun;
    if (resumeSegment === 0) {
      run = await runSlice(sliceIndex, localOffset);
    } else {
      const skip = resumeSegment * cap;
      const inSegment = claimedOffset - skip;
      if (claimedOffset >= resumeOffsetLimit) {
        // 段数上限：不取页、不带游标出门，当场按墙出声（绝不进位串片）。
        // 这里**不发引擎调用**——凭据深度已经越出进制格子，任何调用都只会给出没法记账的位置，
        // 于是交出一只明示的空窗（`synthetic:true` 在下面那本账里看得见）。
        resume = { segment: resumeSegment, skip, inSegment, applied: null, honored: false, advanced: true, ceiling: true };
        run = {
          engine: {
            files: [],
            totalMatches: 0,
            truncated: true,
            filesScanned: 0,
            elapsedMs: 0,
            skipped: { binary: 0, tooLarge: 0, unreadable: 0, filtered: 0, excluded: 0 },
          },
          hits: [],
          window: 0,
          skip,
          applied: null,
          windowOffset: 0,
        };
      } else {
        // ② 取本页所在段
        run = await fetchWindow(sliceIndex, skip, inSegment);
        // ① 前缀对账：两把尺各管一格，**不叠加**（叠加会把段界那一格永远判成失配 ⇒ 无限从头重发）
        //    · 段内偏移 > 0 ⇒ 上一页就在**本段**里，本段窗口自己就带它的已消费前缀，能重算；
        //    · 段内偏移 == 0 ⇒ 上一页在**上一段**，本段窗口里一格前缀都没有，必须回头读上一段。
        let verified = !decoded;
        if (decoded && inSegment > 0) {
          verified = fingerprintForms(run, inSegment).includes(decoded.fingerprint);
        } else if (decoded && inSegment === 0) {
          const prev = await fetchWindow(sliceIndex, (resumeSegment - 1) * cap, cap);
          verified = fingerprintForms(prev, prev.hits.length).includes(decoded.fingerprint);
        }
        if (!verified) {
          // 前缀对不上 / 上一段的账读不回 ⇒ 与旧面同一条处置：从第 0 片第 0 条重发，绝不盲切
          changedDuringPaging = true;
          sliceIndex = 0;
          localOffset = 0;
          run = await runSlice(0, 0);
        } else if (!resumeHonored(run)) {
          // 旧宿主：认不出这个键（回显缺席）⇒ 判得出「没续上」，退回旧面那一次调用与旧面那本账
          resume = { segment: resumeSegment, skip, inSegment, applied: run.applied, honored: false, advanced: false, ceiling: false };
          run = await runSlice(sliceIndex, localOffset);
        } else {
          resume = {
            segment: resumeSegment,
            skip,
            inSegment,
            applied: run.applied,
            honored: true,
            advanced: true,
            ceiling: false,
          };
        }
      }
    }
    let slicesRun = 1;
    if (decoded && !changedDuringPaging && resumeSegment === 0) {
      // 游标指纹锁的是「计划 + 本片已消费前缀」；两者任一对不上 ⇒ 从第 0 片第 0 条重来。
      const expected = pageFingerprint([...planKeys, ...run.hits.slice(0, localOffset).map(sliceHitKey)]);
      if (decoded.fingerprint !== expected) {
        changedDuringPaging = true;
        sliceIndex = 0;
        localOffset = 0;
        run = await runSlice(0, 0);
        slicesRun = 2;
      }
    }
    let keys = run.hits.map(sliceHitKey);
    /** 这一页在**本次窗口**里的下标：旧面尺 = 片内偏移；续取段尺 = 段内偏移（segment 0 时两者同值）。 */
    let pageIndex = resume !== null && resume.honored && !resume.ceiling ? resume.inSegment : localOffset;
    if (pageIndex > keys.length) pageIndex = keys.length; // 裸 offset 越界：夹住，不空转
    if (resume === null && localOffset > keys.length) localOffset = keys.length; // 旧面的夹住口径逐字保留

    /**
     * 跨片交界：游标落在「本片已见底」这一格（上一片的 nextCursor 报的偏移恰是它的条数）
     * ⇒ 前进到下一片再取。这一步必须真的把游标往前推——否则会出现「空页 + hasMore:true」
     * 的死循环，客户端拿到零条却被要求继续翻（本批第一轮自测就是这么挂的）。
     * 只在「本片确实扫完了（引擎没说被切）」时才前进；说被切 ⇒ 那是墙，交给下面的账。
     * 续取接管过（`resume !== null`）就**不许**串片：那一格是「这个文件还有下一段」，不是见底。
     */
    while (pageIndex >= keys.length && !run.engine.truncated && sliceIndex < plan.length - 1) {
      sliceIndex += 1;
      localOffset = 0;
      pageIndex = 0;
      resume = null;
      run = await runSlice(sliceIndex, 0);
      keys = run.hits.map(sliceHitKey);
      slicesRun += 1;
    }

    const page = run.hits.slice(pageIndex, pageIndex + ctx.limit);
    const pageIndexNext = pageIndex + page.length;
    /**
     * 游标里那一格「片内偏移」：
     * - 旧面（含「判出旧宿主后退回旧面」的页）⇒ 逐字仍是窗口下标；
     * - 续取段 ⇒ 段起点 + 段内下标 = **该文件已消费到的条数**（永远 ≤ 16×500 = 8,000 < 进制 8,192）。
     */
    const activeResume = resume !== null && resume.honored && !resume.ceiling ? resume : null;
    const resumed = activeResume !== null;
    const nextLocal = activeResume !== null ? activeResume.skip + pageIndexNext : pageIndexNext;
    const fingerprint = activeResume !== null
      ? pageFingerprint([...planKeys, `resume@${activeResume.skip}`, ...keys.slice(0, pageIndexNext)])
      : pageFingerprint([...planKeys, ...keys.slice(0, pageIndexNext)]);

    /* ---------------- 三本账（哪一格判不了都单独出声） ---------------- */
    // 真触墙＝窗口已经给到引擎上限、引擎仍说被切；窗口没给满时的 truncated 只是「本片还有下一页」。
    const sliceAtWall = run.engine.truncated && run.window >= deps.engineCap;
    const sliceExhausted = !run.engine.truncated && pageIndexNext >= keys.length;
    const isLastSlice = sliceIndex === plan.length - 1;
    const walkComplete = sliceExhausted && isLastSlice;
    const resumeCeiling = resume !== null && resume.ceiling;
    /**
     * 走不动（stalled）：这一页一条新命中都没拿到，但整趟又没走完。
     * 形状来自引擎的**单文件 500 条上限**：一片里第一个文件就被按条 clipped，窗口再抬也
     * 只带回那 500 条 ⇒ 偏移追不上窗口。这种页**绝不许**带 `hasMore:true` 出门
     * （空页还能续 = 让客户端原地转圈），当场按「墙」出声并给出出路。
     * B18 之后这一档只剩两种成因：①这台宿主的引擎不回显续取凭据（旧宿主）；
     * ②这一段真的没新高了。段数上限用尽另立一档（`file-resume-segments-exhausted`），
     * **不与上面两态混淆**。
     */
    const stalled = page.length === 0 && !walkComplete && !sliceAtWall;
    const blocked = sliceAtWall || stalled || resumeCeiling;
    const hasMore = blocked ? false : pageIndexNext < keys.length || run.engine.truncated || !isLastSlice;
    const singleSlice = plan.length === 1;
    // 片内只剩一个文件根还触墙 ⇒ 单文件 500 条上限那一堵墙（B18 能续；旧宿主仍卡在这）。
    const slice = plan[sliceIndex] as Slice;
    const irreducible = slice.kind === 'files' && slice.roots.length === 1;
    /**
     * **只有单片计划**才许转 `knownTotal:true`。
     * 多片计划即使走完也一样判不了总量：本腿游标里没有跨片的命中累加器，`run.engine.totalMatches`
     * 只是**本片**的账（`walkComplete` 只交代「片都走完了、每片都没触墙 ⇒ 命中集可自证无重无漏」，
     * 不等于「总量已知」）。把别片的 total 相加冒充 knownTotal:true 是一句过度声明
     * ——每片各自可能带自己的截断/窗口口径，相加不是引擎会给出的真值（判性实测：闸下集合是
     * 调度产物）。真总量的法定拿法是客户端逐页 `sliceTotal` 相加，`walkComplete:true` 就是这句
     * 话的凭证；本腿自己不知道，就照铁律 4 说不知道。
     * B18 加的同一条尺子：**续取段的 `totalMatches` 只是那一段的账**（前几段根本不在手里），
     * 所以只要接管过逐段续取（`resumed`）就一律 false——把各段相加冒充总量是同一刀。
     */
    const knownTotal = singleSlice && !resumed && !run.engine.truncated && isLastSlice;

    const relRoots = slice.roots.map((r) => deps.toRelativePath(r, ctx.rootDir) || r);
    const out: Record<string, unknown> = {
      hits: page,
      // 本片的账：`total` 字段名沿用旧面，但标尺写明（totalScope），全项目总量判不了就判不了。
      total: run.engine.totalMatches,
      totalScope: knownTotal ? 'project' : 'slice',
      knownTotal,
      // 「这一页没把全项目装下」＝旧面同一口径（旧面写的是 page.length < allHits.length）；
      // 续取段的尺子换成「本段窗口里还有没发的」（前几段不在这次的窗口里，比 `page.length` 准）。
      truncated: resumed
        ? run.engine.truncated || pageIndexNext < keys.length || !isLastSlice
        : run.engine.truncated || page.length < keys.length || !isLastSlice,
      offset: nextLocal,
      sliceOffset: nextLocal,
      limit: ctx.limit,
      hasMore,
      nextCursor: hasMore
        ? encodePageCursor(fingerprint, sliceIndex * MCP_SEARCH_SLICE_CURSOR_STRIDE + nextLocal)
        : null,
      fingerprint,
      planSlices: plan.length,
      sliceIndex,
      sliceKind: slice.kind,
      sliceRoots: relRoots,
      sliceTotal: run.engine.totalMatches,
      slicesRun,
      perSliceTruncated: [
        {
          slice: sliceIndex,
          truncated: run.engine.truncated,
          window: run.window,
          totalMatches: run.engine.totalMatches,
          filesScanned: run.engine.filesScanned,
          // 这一趟调用带没带续取凭据、引擎回显了多少（不发调用的那格显式写 attempted:false）
          resumeAttempted: resume !== null,
          resumeRequestedSkip: resume?.skip ?? 0,
          resumeAppliedEcho: resume?.applied ?? null,
          ...(resumeCeiling ? { syntheticWindowNotFetched: true } : {}),
        },
      ],
      filesScanned: run.engine.filesScanned,
      elapsedMs: run.engine.elapsedMs,
      skipped: run.engine.skipped,
      droppedNestedRoots: built.droppedNestedRoots.map((r) => deps.toRelativePath(r, ctx.rootDir) || r),
      maxSlicesPerWalk: MCP_SEARCH_SLICE_MAX_SLICES,
      maxGroupFilesPerSlice: MCP_SEARCH_SLICE_MAX_GROUP_FILES,
      maxChildEntriesPerDir: MCP_SEARCH_SLICE_MAX_CHILD_ENTRIES,
      cursorStride: MCP_SEARCH_SLICE_CURSOR_STRIDE,
      engineCapPerSlice: deps.engineCap,
      engineCapPerFile: cap,
      maxSegmentsPerFile: MCP_SEARCH_FILE_RESUME_MAX_SEGMENTS,
      walkComplete,
      // 「重扫了什么」必须可见：清单（含别片增删文件）每次都重枚举并进指纹，但**正文**
      // 只重扫本片 ⇒ 别片「只改正文不改清单」的变化本腿察觉不到（判不了就说判不了）。
      // 续取接管过 ⇒ 尺子更小：连本片也只重扫了**这一段**（前几段不在这次窗口里）。
      prefixReverified: resumed ? 'inventory+current-segment' : 'inventory+current-slice',
    };
    /**
     * 逐段续取的账。**只剩一个文件根的片**从第 0 段起就带这本账（`advanced:false` 明说
     * 「这一页还没真用过凭据」），别的片只在**接管过续取**的那一页起才出现——缺席 = 这一页
     * 走的就是旧面，一眼可分。四格必须同时可见，否则「续到哪」与「还有没有」都说不清：
     * 段号 / 该文件消费到哪儿 / 每段条数 / 段数上限。
     */
    const accountSegment = cap > 0 ? Math.floor(localOffset / cap) : 0;
    const account: FileResumeAccount | null =
      resume !== null
        ? resume
        : irreducible
          ? {
              segment: accountSegment,
              skip: accountSegment * cap,
              inSegment: localOffset - accountSegment * cap,
              applied: null,
              honored: true,
              advanced: false,
              ceiling: false,
            }
          : null;
    if (account !== null) {
      out['fileResumeSegment'] = account.segment;
      out['fileResumeConsumedMatches'] = account.ceiling ? claimedOffset : nextLocal;
      out['fileResumeSegmentMatches'] = keys.length;
      out['fileResumeSegmentLimit'] = MCP_SEARCH_FILE_RESUME_MAX_SEGMENTS;
      out['fileResume'] = {
        segment: account.segment,
        requestedSkipMatches: account.skip,
        engineEchoMatches: account.applied,
        honored: account.honored,
        // 这一页到底走的是哪条取页路：false = 旧面那一次调用（不带凭据），true = 段调用
        credentialUsedInThisCall: resumed || account.ceiling,
        inSegmentOffset: account.inSegment,
        segmentMatches: keys.length,
        consumedMatches: account.ceiling ? claimedOffset : nextLocal,
        maxSegments: MCP_SEARCH_FILE_RESUME_MAX_SEGMENTS,
        perFileCap: cap,
        ceilingReached: account.ceiling,
        // 这一段之后引擎还说被切 ⇒ 该文件没穷尽；false ⇒ 这个文件到此为止（穷尽）
        fileTruncated: run.engine.truncated,
        fileExhausted: !run.engine.truncated,
        // 段界那一格专门交代：上一段的账有没有真的读回来
        previousSegmentVerified: account.inSegment === 0 && account.segment > 0 ? !changedDuringPaging : null,
      };
    }
    if (!knownTotal) {
      out['knownTotalReason'] = resumed
        ? '游标里没有跨段（也没有跨片）的命中累加器：这一页的 total 只是**本段**的账，' +
          '前面几段已经消费掉的条数本腿报不出——把它们相加冒充总量正是 B16 挨那一刀的地方。' +
          '逐页 fileResumeConsumedMatches 与 sliceTotal 相加即该文件的真值；' +
          'fileExhausted:true 是「这个文件到头了」的凭证（不是「总量已知」的凭证）。'
        : '游标里没有跨片的命中累加器：已消费完的别片总量本腿报不出（要重扫整棵树才知道，' +
          '那正是闸要防的 IPC 载荷）。逐页 sliceTotal 相加即真总量——走完时 walkComplete:true 会说这件事。';
    }
    if (changedDuringPaging) {
      out['changedDuringPaging'] = true;
      out['note'] =
        '分片计划或本片已消费前缀与上一页的游标指纹不一致：本次从**第 0 片第 0 条**重发，' +
        '不可与旧页拼接（旧行为会静默错位）。';
    } else if (blocked) {
      out['engineWallReached'] = true;
      out['blockedSlice'] = {
        index: sliceIndex,
        kind: slice.kind,
        roots: relRoots,
        reason: resumeCeiling
          ? 'file-resume-segments-exhausted'
          : sliceAtWall
            ? 'slice-over-engine-cap'
            : 'no-forward-progress',
      };
      out['note'] = resumeCeiling
        ? `第 ${sliceIndex} 片那一个文件已逐段续到段数上限（${MCP_SEARCH_FILE_RESUME_MAX_SEGMENTS} 段 × 每文件上限 ${cap} 条 = ${resumeOffsetLimit} 条）` +
          `，引擎仍说被切：再续就要把游标偏移顶进下一片的进制格子里（cursor 仍是「片序号 × ${MCP_SEARCH_SLICE_CURSOR_STRIDE} + 片内偏移」` +
          '那一格，本批**不加新位**，所以到此为止，绝不进位串片）。这一页起不再取引擎调用、不再给游标' +
          `（syntheticWindowNotFetched:true 就是这一格）。已消费的 ${claimedOffset} 条照拼、无重；` +
          `出路只有对该文件走 fs.readFile 分页（该面拼接可自证完整）：fs.readFile { relPath: "${String(relRoots[0] ?? '')}", limit, cursor }。`
        : irreducible
          ? `第 ${sliceIndex} 片只剩一个文件根，仍撞在引擎单文件上限（SEARCH_PER_FILE_CAP＝${cap} 条）上：` +
            '这一片分不动了，续取到此为止（不静默跳过、不假称完整）。请对该文件改用 fs.readFile 分页读全文' +
            `（该面拼接可自证完整）：fs.readFile { relPath: "${String(relRoots[0] ?? '')}", limit, cursor }。` +
            (resume !== null && !resume.honored
              ? `本批的逐段续取已向这台宿主请求过凭据（resumeAfterMatches=${resume.skip}），` +
                '但它**未回显**续取凭据（回显位缺席或对不上请求值）⇒ 判定这台宿主的引擎不认这一位，' +
                '按旧面那堵墙收口：绝不把它回吐的前若干条当成新一页（那会造成整段重复）。'
              : '')
          : stalled
            ? `第 ${sliceIndex} 片（${String(relRoots[0] ?? '')}）在窗口还没抬到引擎上限时就**一条新命中也拿不出来**：` +
              '这是引擎单文件上限（SEARCH_PER_FILE_CAP＝500 条）在这一片里先生效的形状——' +
              '窗口继续抬只会带回同一批前 500 条，偏移追不上窗口。绝不允许「空页 + hasMore:true」出门' +
              '（那等于让客户端原地转圈），当场按墙出声。出路：对本片文件逐文件走 fs.readFile 分页' +
              '（片内文件清单见 sliceRoots），或缩 query / 用 scope:"sources" 让这一片变小。' +
              '前面的片已可自证无重无漏，照拼。'
            : `第 ${sliceIndex} 片（${String(relRoots[0] ?? '')}）单独就超过引擎单次上限 ${deps.engineCap} 条：` +
              '本腿不静默跳过、也不假称能续。前面的片已可自证无重无漏，照拼；这一片的出路只有两条——' +
              '①缩 query（本面不收落点参数，收窄只能靠查询词与 scope:"sources"）；' +
              '②对本片里的文件逐文件走 fs.readFile 分页（该面拼接可自证完整，片内文件清单见 sliceRoots）。' +
              '片的划分必须跨调用可复现，按命中密度再切需要页间历史 ⇒ 本面不做，不装作能消除。';
    } else {
      out['note'] = walkComplete
        ? '分片续取走完：逐页 hits 拼接即全项目命中集（每片都不触墙 ⇒ 无重无漏可自证）；' +
          '各页 sliceTotal 相加＝真总量（本腿游标无累加器，故 knownTotal 只在单片计划时转 true）。'
        : '分片续取中：本片未触墙，游标可续。已消费完的别片若只改正文不改文件清单，本腿不重扫 ⇒ ' +
          '该风险逐页可见（prefixReverified:"inventory+current-slice"），不装作没有。';
      if (activeResume !== null && !walkComplete) {
        out['note'] =
          `第 ${sliceIndex} 片那一个文件正在逐段续取：本段是第 ${activeResume.segment} 段` +
          `（每段上限 ${cap} 条，段数上限 ${MCP_SEARCH_FILE_RESUME_MAX_SEGMENTS} 段），已消费 ${nextLocal} 条。` +
          '窗口口径与旧面同源，闸一格没放宽；拼接可自证无重无漏的尺子见 fileResume 那本账' +
          '（prefixReverified:"inventory+current-segment" = 连前几段的正文都没重扫）。';
      }
    }
    if (ctx.fsFreshness !== undefined) out['fsFreshness'] = ctx.fsFreshness;
    return out;
  };
}
