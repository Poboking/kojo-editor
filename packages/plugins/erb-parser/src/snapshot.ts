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
 * 按**项目根**把 `{ path → (mtimeMs, size, textLength, ErbFile) }` 存进本插件的存储域
 * （`{appData}/store/erb-parser/<key>.json`）。重新打开项目时：
 *
 * ```
 * walkDir（1 次，顺带 mtime+size）→ 与快照比对：mtime 与 size 都一致 → **直接复用**
 *   → 不一致/缺失/任一侧取不到 → 只重扫这些文件
 *   → 按本次 walk 顺序聚合（与全量重建的 byName 顺序逐位一致）
 *   → 广播 kojo.functionChanged（消费方无感）→ 异步落盘新快照
 * ```
 *
 * ## 纪律
 *
 * - **fail-closed**：快照结构/版本/项目根任一不符 → 整体弃用 + 删除 + 全量重建
 *   （绝不"修"快照——解析错误的结果比慢更危险）。校验是**急**的（decode 时逐元组查完），
 *   懒的只是**还原成对象**这一步；
 * - **保守失效**：mtime 或 size 任一侧为 null（平台未提供/读失败）→ 视为过期；
 * - **顺序确定**：聚合永远按本次 walkDir 的顺序进行，快照只替换"来源"，
 *   不改变 `byName` 的聚合顺序（消费方对顺序的任何假设都不受影响）；
 * - **零游戏知识**：本模块只认识"文件与函数边界"，不认识任何命名约定。
 */
import type { ErbDim, ErbFile, ErbFunction, ErbFunctionRef, ErbLabel, ErbParam, FileStat } from '@kojo/plugin-api';
import type { FileRefs, RefRun } from './references';

/**
 * 快照格式版本（结构不兼容时整体弃用重建）。
 *
 * **v1 → v2**（用户反馈 9）：`ErbFunction` 新增 `docComment`（函数上方紧邻注释块）。
 * 旧快照里没有这个字段，若继续复用会让函数树悬停**静默空白**且无从察觉——
 * 与其悄悄降级，不如按 `coerceSnapshot` 的 fail-closed 语义整体弃用、一次重建。
 * 代价：升级后首次开项目多等一段索引时间（此后照常走快照）。
 *
 * **v2 → v3**（2026-10-12「快照瘦身」）：真实语料实测 v2 = **44.40 MB / 99,104 函数**，
 * 其中 **16.65 MB（38%）是可派生字段**——`function.filePath`(13.34) 与 `file.path`(0.30)
 * 都等于条目键，`function.normalizedName`(3.02) 就是 `name.toUpperCase()`
 * （scanner.ts:263 唯一定义处）；再加**函数对象的键名本身 9.75 MB**。
 * v3 把这三样从盘上去掉（加载时回填），条目与函数改用位置元组 ⇒ 预计降到 ~18 MB，
 * 热启动 `storage.get`（v2 实测 253 ms）应随之等比下降。
 *
 * **v3 → v4**（2026-10-15 H2 反向索引批）：条目追加第 7 位 `refs`
 * （`[归一化名, 行, 列, 种类旗标]` 流水）。反向引用必须在**读盘解析段**顺手产出
 * （文本不许整份留驻），热复用若无盘上 refs 就得二次读全部文件 ⇒ 快照不存等于白热。
 * v3 快照没有 refs ⇒ 版本 bump ⇒ fail-closed 整体弃用、一次冷重建（此后照常热）。
 *
 * **v4 → v5**（2026-10-16 PERF-7 快照批）：两处改动，都是行为修正/信号增强：
 * - 条目追加 `size`（文件**字节数**，与 walkDir/stat 同源）。原失效判据只看 mtime——
 *   "保留时间戳的替换"（拷贝/工具改写）会被静默复用；mtime+size 双判据把它兜住。
 *   注意：**不能拿 `textLength` 当 size 用**——它是解码后的 UTF-16 码元数，与盘上
 *   字节数在 CJK 语料里差 3 倍，直接比会把几乎每份文件判过期（全量重扫）。
 *   `textLength` 保留为惰性还原前的冗余校验位。
 * - 还原改为**两段**：decode 只做校验 + 建"轻外壳"（ErbFile 视图的 `functions`/`dims`
 *   是惰性 getter，refs 直接别名盘上元组数组、零拷贝），重字段在**首次真正消费时**
 *   才建对象。热开时条件抽取/校验只吃 `files` 的路径与统计、编辑器面板按需拉取 ⇒
 *   100k 级函数对象的构造从"开项目"这一班岗上撤下。
 *   v4 快照没有 size ⇒ 版本 bump ⇒ fail-closed 整体弃用、一次冷重建（此后照常热）。
 *
 * **v5 → v6**（2026-10-16 语言服务批）：`ErbFile` 新增 `labels`（函数内 `$` 标签，
 * `$` 标签转定义的数据面）。条目追加第 9 位 `labels`（`[名, 行, 所属函数定义行]` 元组，
 * **恒在**——v4 收 refs 位的同款先例；内存里无标签 = 缺省不挂，与解析器同形）。
 * v5 快照没有 labels ⇒ 版本 bump ⇒ fail-closed 整体弃用、一次冷重建（此后照常热）。
 */
export const SNAPSHOT_VERSION = 6;

/** 单个文件的快照条目 */
export interface SnapshotEntry {
  /** 构建该条目时的文件 mtime（`readText`/`stat` 同源口径）；null = 平台未提供 → 恒视为过期 */
  readonly mtimeMs: number | null;
  /** 构建该条目时的文件**字节数**（walkDir 顺带 / stat 兜底同源）；null = 取不到 → 恒视为过期 */
  readonly size: number | null;
  /** 冗余校验位：条目文本长度（UTF-16 码元数；**不可与 `size` 混用**——单位不同） */
  readonly textLength: number;
  /**
   * 该文件的解析结果。**懒还原**：`functions` / `dims` 是 getter，首次被读时才建对象；
   * 在此之前只持有盘上元组。消费方读到的值与直接 `parseErbText` 逐字段相同。
   */
  readonly file: ErbFile;
  /**
   * 该文件的反向引用流水（见 `./references` 的 `FileRefs`）。
   * v4 起恒在（缺失 = 结构不符 ⇒ 整体弃用）；构建序 = 行、列升序，聚合序因此确定。
   * **零拷贝**：direct 别名盘上元组的第 7 位（RefTuple 与 RefRun 同形，decode 已逐条验过）。
   */
  readonly refs?: FileRefs;
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

/* ---------------------------------------------------------------------------
 * v3 起盘上形态：位置元组（只在存储边界使用）
 * ------------------------------------------------------------------------- */

/** `[形参名, 是否有默认值(0|1)]` */
type ParamTuple = [string, 0 | 1];
/** `[原名, 起始行, 结束行, 形参, 位标, 注释块?]`；位标 bit0 = 表达式函数 */
type FunctionTuple = [string, number, number, ParamTuple[], number, string?];
/** `[变量名, 声明指令, 行号]` */
type DimTuple = [string, string, number];
/** `[归一化名, 行, 列, 种类旗标(0=定义 1=调用 2=提及)]` */
type RefTuple = [string, number, number, 0 | 1 | 2];
/** `[标签名, 行, 所属函数定义行]`（v6 起；无标签 = 空数组） */
type LabelTuple = [string, number, number];
/** `[mtimeMs, size, textLength, 行数, 有#FUNCTION(0|1), 函数, 声明变量, 引用流水, 标签]` */
type EntryTuple = [number | null, number | null, number, number, 0 | 1, FunctionTuple[], DimTuple[], RefTuple[], LabelTuple[]];

const FLAG_EXPRESSION = 1;

/**
 * 懒还原的原始元组句柄（Symbol ⇒ 不进 `Object.keys`/JSON/spread）。
 * `aggregateIndex` 凭它直接从元组建 `byName`，不经过 ErbFunction 对象。
 */
const RAW = Symbol('kojo.erb.snapshot.raw');

interface RawCarrier {
  [RAW]?: EntryTuple;
}

/** 惰性还原的一个字段：读一次建对象，随后换成普通值属性（再次读写零开销） */
function materialize<T>(obj: object, key: string, build: () => T): T {
  const built = build();
  Object.defineProperty(obj, key, { value: built, enumerable: true, writable: true, configurable: true });
  return built;
}

/**
 * 把内存条目压成盘上元组：剥掉三样可派生数据（`file.path`、`function.filePath`
 * 都等于条目键；`function.normalizedName` = `name.toUpperCase()`），并把键名换成位置。
 *
 * **快路径**：decode 产出的懒外壳（元组原样、refs 零拷贝、functions/dims 未被动过）直接
 * 复用盘上元组，不重建 100k 级函数元组——落盘路径（改一个文件也要存全库）因此也是
 * "改谁编码谁"。被动过的条目（如 `attachRefs` 换过 refs）走逐字段重建，语义不变。
 *
 * ⚠ **位置契约**：`ErbFile` / `ErbFunction` 增删字段时，这里必须同步改并
 * **bump `SNAPSHOT_VERSION`**——元组不会自动兼容新字段。哨兵测试
 * （`snapshot.test.ts` 的「字段清单哨兵」）会在漏改时直接失败，不靠人记。
 */
export function encodeEntries(entries: Readonly<Record<string, SnapshotEntry>>): Record<string, EntryTuple> {
  const out: Record<string, EntryTuple> = {};
  for (const [path, e] of Object.entries(entries)) {
    const raw = (e.file as RawCarrier)[RAW];
    if (
      raw !== undefined &&
      raw[0] === e.mtimeMs &&
      raw[1] === e.size &&
      raw[2] === e.textLength &&
      raw[7] === (e.refs as unknown) &&
      // functions/dims 仍是 accessor = 惰性外壳未被消费方动过 ⇒ 元组即真相
      Object.getOwnPropertyDescriptor(e.file, 'functions')?.get !== undefined &&
      Object.getOwnPropertyDescriptor(e.file, 'dims')?.get !== undefined
    ) {
      out[path] = raw;
      continue;
    }
    const fns: FunctionTuple[] = e.file.functions.map((f): FunctionTuple => {
      const flags = f.isExpressionFunction ? FLAG_EXPRESSION : 0;
      const params: ParamTuple[] = f.params.map((p): ParamTuple => [p.name, p.hasDefault ? 1 : 0]);
      const fn: FunctionTuple = [f.name, f.startLine, f.endLine, params, flags];
      if (f.docComment !== undefined) fn.push(f.docComment);
      return fn;
    });
    const dims: DimTuple[] = e.file.dims.map((d): DimTuple => [d.name, d.directive, d.line]);
    // refs 与 LabelTuple 同理（懒外壳是别名，重扫结果本来就是同形元组）——不再逐条复制
    const refs = (e.refs ?? []) as unknown as RefTuple[];
    const labels = (e.file.labels ?? []).map((l): LabelTuple => [l.name, l.line, l.functionStartLine]);
    out[path] = [
      e.mtimeMs,
      e.size,
      e.textLength,
      e.file.lineCount,
      e.file.hasFunctionDirective ? 1 : 0,
      fns,
      dims,
      refs,
      labels,
    ];
  }
  return out;
}

function isEntryTuple(t: unknown): t is EntryTuple {
  if (!Array.isArray(t) || t.length !== 9) return false;
  if (t[0] !== null && typeof t[0] !== 'number') return false;
  if (t[1] !== null && typeof t[1] !== 'number') return false;
  return typeof t[2] === 'number' && typeof t[3] === 'number' && (t[4] === 0 || t[4] === 1) &&
    Array.isArray(t[5]) && Array.isArray(t[6]) && Array.isArray(t[7]) && Array.isArray(t[8]);
}

function isRefTuple(t: unknown): t is RefTuple {
  return (
    Array.isArray(t) && t.length === 4 && typeof t[0] === 'string' && typeof t[1] === 'number' &&
    typeof t[2] === 'number' && (t[3] === 0 || t[3] === 1 || t[3] === 2)
  );
}

function isLabelTuple(t: unknown): t is LabelTuple {
  return Array.isArray(t) && t.length === 3 && typeof t[0] === 'string' && typeof t[1] === 'number' && typeof t[2] === 'number';
}

function isFunctionTuple(t: unknown): t is FunctionTuple {
  if (!Array.isArray(t) || (t.length !== 5 && t.length !== 6)) return false;
  if (typeof t[0] !== 'string' || typeof t[1] !== 'number' || typeof t[2] !== 'number') return false;
  if (typeof t[4] !== 'number' || !Array.isArray(t[3])) return false;
  if (t.length === 6 && typeof t[5] !== 'string') return false;
  return (t[3] as unknown[]).every(
    (p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && (p[1] === 0 || p[1] === 1),
  );
}

function toFunction(path: string, [name, startLine, endLine, params, flags, doc]: FunctionTuple): ErbFunction {
  return {
    name,
    normalizedName: name.toUpperCase(),
    params: params.map(([pname, hasDefault]): ErbParam => ({ name: pname, hasDefault: hasDefault === 1 })),
    startLine,
    endLine,
    filePath: path,
    // scanner 对每个函数都显式写这个布尔（false 也在），还原必须同样显式，不能缺键
    isExpressionFunction: (flags & FLAG_EXPRESSION) !== 0,
    ...(doc === undefined ? {} : { docComment: doc }),
  };
}

/**
 * 建懒还原的 ErbFile 视图：字段与 `parseErbText` 的产物同形同值，但 `functions`/`dims`
 * 是 getter（首次读才建对象）。`aggregateIndex` 见到 RAW 标记就直接吃元组，
 * 因此"热开时的聚合"不必先把 100k 级函数对象建出来。
 */
function lazyFile(path: string, tuple: EntryTuple): ErbFile {
  const [, , , lineCount, hasDirective, fns, dims, , labels] = tuple;
  const file: ErbFile = {
    path,
    hasFunctionDirective: hasDirective === 1,
    lineCount,
    // 无标签 = 缺省不挂（与 parseErbText 同形同值：不给空数组）
    ...(labels.length > 0
      ? { labels: labels.map(([name, line, fnLine]): ErbLabel => ({ name, line, functionStartLine: fnLine })) }
      : {}),
    get functions(): ErbFunction[] {
      return materialize(file, 'functions', () => fns.map((t) => toFunction(path, t)));
    },
    get dims(): ErbDim[] {
      return materialize(file, 'dims', () => dims.map(([name, directive, line]): ErbDim => ({ name, directive, line })));
    },
  };
  Object.defineProperty(file, RAW, { value: tuple, enumerable: false });
  return file;
}

/**
 * 还原盘上元组为内存条目；结构任一不符 ⇒ null（整体弃用，全量重建）。
 * 键即路径 ⇒ 回填 `file.path` 与 `function.filePath`；`normalizedName` 按 scanner 的
 * 唯一定义（`name.toUpperCase()`）回填（惰性，在 `toFunction` / `aggregateIndex` 里）。
 *
 * **校验急、还原懒**：每个函数元组 / 声明元组 / 引用元组在 decode 时逐条查完
 * （fail-closed 不打折），查过之后对象构造才推迟。
 */
export function decodeEntries(raw: unknown): Record<string, SnapshotEntry> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const out: Record<string, SnapshotEntry> = {};
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isEntryTuple(value)) return null;
    const [mtimeMs, size, textLength, , , fns, dims, refs, labels] = value;
    if (!fns.every(isFunctionTuple)) return null;
    if (!dims.every((d) => Array.isArray(d) && d.length === 3 && typeof d[0] === 'string' && typeof d[1] === 'string' && typeof d[2] === 'number')) {
      return null;
    }
    if (!refs.every(isRefTuple)) return null;
    if (!labels.every(isLabelTuple)) return null;
    out[path] = {
      mtimeMs,
      size,
      textLength,
      file: lazyFile(path, value),
      refs: refs as unknown as FileRefs, // 同形零拷贝（见 SnapshotEntry.refs 注）
    };
  }
  return out;
}

/**
 * 聚合为索引（`files` + `byName`）。
 *
 * 从 `plugin.ts` 的内联循环抽出：**全量重建**与**快照复用**必须走同一份聚合代码，
 * 否则两条路径会悄悄分叉。顺序 = 传入顺序 = 本次 walkDir 顺序。
 *
 * `sources` 可混装：本次重扫的 `ErbFile` 与快照懒外壳（带 RAW 标记）。后者直接
 * 从元组建 `byName`（`name.toUpperCase()` 与 `toFunction` 同一条口径）⇒ 聚合阶段
 * 不触发任何 ErbFunction 对象的构造；`files` 里存的就是那个懒视图，消费方读
 * `functions` 时才按文件补齐。
 */
export function aggregateIndex(sources: Iterable<ErbFile>): {
  files: Map<string, ErbFile>;
  byName: Map<string, ErbFunctionRef[]>;
} {
  const fileMap = new Map<string, ErbFile>();
  const byName = new Map<string, ErbFunctionRef[]>();
  for (const file of sources) {
    const path = file.path;
    fileMap.set(path, file);
    const raw = (file as RawCarrier)[RAW];
    if (raw !== undefined) {
      for (const t of raw[5]) {
        const name = t[0];
        const normalizedName = name.toUpperCase();
        const refs = byName.get(normalizedName) ?? [];
        refs.push({
          name,
          normalizedName,
          filePath: path,
          startLine: t[1],
          endLine: t[2],
          ...(t[5] === undefined ? {} : { docComment: t[5] }),
        });
        byName.set(normalizedName, refs);
      }
      continue;
    }
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

/**
 * 索引快照的存储键形态（`snapshotKeyFor` 的产出）：`index-v<版本>-<8 位十六进制>`。
 * 清理时用它识别"确实是索引快照"，绝不误删同域里的其它文件。
 */
const SNAPSHOT_KEY_RE = /^index-v\d+-[0-9a-f]{8}$/;

/**
 * 该删掉的旧快照键（**纯函数**，可单测）。
 *
 * 语义（2026-10-16 PERF-7 批修订）：**保留 = 本会话工作集**
 * （`keepKeys` = 本会话已构建过的各项目键），其余索引快照键（含格式升级遗留的
 * `index-v1-*` / `v2-*` 孤儿）一律清理。
 *
 * 为什么不是"只留当前项目那一份"（上一版语义）：那会让**交替开两个游戏目录**
 * 演变成"每次切换都全冷重建"——A 存盘即删 B 的键，回头开 B 又全冷……
 * 实测（合成 2,000 文件口径）交替 3 轮 6 次全冷。作者拿两三个版本对拍是真实工作流
 * （本仓 STATE 就挂着三盘语料），每次切换付一次冷索引（真语料 ~2.3 s）不是可接受的代价。
 *
 * 为什么不是"全部保留"：开过的项目越多攒得越多、永不回收（v3 每份约 12 MB），
 * 单文件覆盖式（抽取/校验两段）的初衷就是用**有界**换"不留无上限的磁盘口子"。
 * 本会话工作集给两条约束一个交点：常用项目的来回切换落在工作集内（热），
 * 工作集之外的旧键在下次构建时回收（界 = 一次会话摸过的项目数）。
 * 代价说清楚：跨会话首次打开别的项目仍可能清掉未入工作集的旧键——那一次是冷的。
 */
export function pruneSnapshotKeys(keys: readonly string[], keepKeys: string | readonly string[]): string[] {
  const keep = typeof keepKeys === 'string' ? new Set([keepKeys]) : new Set(keepKeys);
  return keys.filter((k) => SNAPSHOT_KEY_RE.test(k) && !keep.has(k));
}

/** 快照比对结果 */
export interface SnapshotDiff {
  /** mtime 与 size 都一致、可直接复用解析结果的文件 */
  readonly reusable: string[];
  /** 需要重新读盘解析的文件（缺失 / mtime 或 size 变了 / 任一侧不可判） */
  readonly stale: string[];
}

/**
 * 比对快照与当前文件清单（**纯函数**）。
 *
 * 判据 = **mtimeMs 与 size 双等**。`stats` 取自 walkDir 顺带 / `io.stat` 兜底
 * ——与构建条目时同源（内核 readText 内部就是 stat），口径一致才可比。
 * 任一侧为 null（平台未提供 / stat 失败）一律判过期：size 是"mtime 同值替换"
 * （保留时间戳的拷贝/工具改写）的唯一防线，取不到就不敢复用。
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
      entry !== undefined &&
      entry.mtimeMs !== null &&
      entry.size !== null &&
      st !== null &&
      st.mtimeMs === entry.mtimeMs &&
      st.size === entry.size;
    (fresh ? reusable : stale).push(p);
  }
  return { reusable, stale };
}

/** 校验未知数据是否为**本项目**的 v5 快照；任一不符返回 null（整体弃用） */
export function coerceSnapshot(raw: unknown, rootDir: string): IndexSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== SNAPSHOT_VERSION) return null;
  if (r.rootDir !== rootDir) return null;
  if (typeof r.savedAt !== 'number' || !Number.isFinite(r.savedAt)) return null;
  // 条目结构（元组长度 / 类型 / 形参与注释位）由 decodeEntries 逐条校验，不符 ⇒ 整体弃用
  const entries = decodeEntries(r.entries);
  if (entries === null) return null;
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

/**
 * 把引用流水挂回快照条目（H2 批）。
 *
 * 为什么单独一步而不是并进 `mergeEntries`：`refs` 要等**全项目 `byName` 建好**才能扫
 * （判据是全局名字表），而 `mergeEntries` 发生在解析段。挂接是纯函数重建条目对象，
 * 不原地改——`SnapshotEntry` 的 readonly 纪律不破。
 */
export function attachRefs(
  entries: Record<string, SnapshotEntry>,
  refsByPath: ReadonlyMap<string, FileRefs>,
): Record<string, SnapshotEntry> {
  const out: Record<string, SnapshotEntry> = {};
  for (const [path, e] of Object.entries(entries)) {
    const refs = refsByPath.get(path);
    out[path] = refs === undefined ? e : { ...e, refs };
  }
  return out;
}
