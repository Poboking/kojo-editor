/**
 * 条件抽取结果快照（2026-10-12「体感丝滑」批 →「快照瘦身」批 →「按文件增量」批）。
 *
 * ## 为什么存在
 * 全量抽取在真实语料上实测 **11.3 s**（95,333 函数 / 493,712 谓词 / 164,910 依赖），
 * 而插件在 `kojo.functionChanged` 上**自动催动**——每次开项目都重跑一遍。抽取是逐文件的
 * 纯函数：某个文件的正文没变 ⇒ 该文件的产出必相同。
 *
 * ## 三版演进（每一版都是量出来的，不是猜的）
 * - **v1** 整项目 JSON：45.86 MB，判据 = 全库 ERB 指纹。
 * - **v2** 字典 + 元组：schema 标签全库只有 1,832 种却重复写 164,910 次、`filePath` 只对应
 *   2,285 个文件、`normalizedName` 就是 map 键 ⇒ 剥掉后 12.47 MB。
 * - **v3 按文件分桶**：v1/v2 的判据是"任一文件变 ⇒ 全库作废"，而**作者天天只改几个文件**，
 *   真实工作流里每次开项目都要重付 4 s。现在按文件存桶 + 逐文件 mtime 比对，
 *   只重算变过的那几个；磁盘与结构开销同 v2 一个量级。
 *
 * ## 两层失效判据（分工明确）
 * - **全局层**（判不符 ⇒ 整包弃用）：项目根 / `adapterId` / `inputDigest` / 格式版本。
 *   `inputDigest` 是 adapter 在 `loadProject` 吃进的非 ERB 输入摘要——eraTW 的变量字典由
 *   `CSV/*.csv` 驱动，抽取结果里的 `StateDependency.schema` 标签正是它给的
 *   （2026-10-12 自查发现：只看 ERB 指纹时，改一行 `CFLAG.csv` 描述会让快照继续吐旧标签）。
 * - **逐文件层**（判不符 ⇒ 只重算该文件）：桶里存的 `mtimeMs` 与 `ErbIndex.fileMtimes` 比对；
 *   任一侧为 `null`（取不到 stat）⇒ 该文件永不复用。
 *   磁盘上消失的文件不在本次 walk 顺序里 ⇒ 天然收尸，快照不会越攒越大。
 *
 * ## 纪律
 * **fail-closed**：全局判据或结构任一不符 ⇒ 整包 null；元组是**位置契约**，
 * `FunctionConditions`/`StateDependency` 增删字段必须同步改编解码并 bump
 * `EXTRACT_SNAPSHOT_FORMAT`，漏改由 `snapshot.test.ts` 的「字段清单哨兵」测试拦下。
 * 存储键是**固定槽位名**（版本在 payload 里）：换格式后旧文件被读出→判不符→删除→覆盖，
 * 不留永远读不到的孤儿。
 */
import type {
  ConditionComparison,
  ConditionIndex,
  ErbIndex,
  FunctionConditions,
  GameProject,
  StateDependency,
  VariableInfo,
} from '@kojo/plugin-api';

/** 快照格式版本；改 `FunctionConditions`/`StateDependency` 语义或抽取口径时 +1 */
export const EXTRACT_SNAPSHOT_FORMAT = 3;

/** 存储键 = 固定槽位名（版本在 payload 里，换格式时旧文件读出即判死并被覆盖） */
export const EXTRACT_STORE_KEY = 'extract-snapshot-v1';

/** 单文件贡献的统计（`ConditionIndex.stats` 五项都可按文件相加） */
export type FileStats = ConditionIndex['stats'];

/** 一个文件的结果桶 */
export interface FileBucket {
  readonly mtimeMs: number | null;
  readonly stats: FileStats;
  readonly conds: FunctionConditions[];
}

/** 全局判据（逐文件那层由桶里的 mtime 负责） */
export interface ExtractExpect {
  readonly projectRoot: string;
  readonly adapterId: string;
  readonly inputDigest: string;
}

/** `[key, name, indices, count, firstLine, comparisons, schemaIdx]`；`schemaIdx = -1` 表示无 */
type DependencyTuple = [string, string, string[], number, number, ComparisonTuple[], number];
/** `[op, value, 原文]` */
type ComparisonTuple = [string, number | string, string];
/** `[归一化名, startLine, predicateCount, unparsedCount, deps]`；`filePath` 由桶键给出 */
type CondTuple = [string, number, number, number, DependencyTuple[]];
/** `[mtimeMs, 该文件统计, 函数桶]` */
type BucketTuple = [number | null, [number, number, number, number, number], CondTuple[]];

/** 落盘形态（v3） */
export interface StoredConditionIndex {
  readonly format: number;
  readonly projectRoot: string;
  readonly adapterId: string;
  readonly inputDigest: string;
  readonly savedAt: number;
  readonly schemas: readonly (VariableInfo | null)[];
  readonly buckets: Readonly<Record<string, BucketTuple>>;
}

/**
 * 组装全局判据。**只需要 `inputDigest`**：ERB 正文的变化由逐文件 mtime 负责，
 * 用整项目指纹会把"改一个文件"放大成"重算全库"。缺 `inputDigest` ⇒ null ⇒ 不缓存。
 */
export function extractExpect(args: {
  project: Pick<GameProject, 'rootDir' | 'adapterId' | 'inputDigest'>;
}): ExtractExpect | null {
  if (!args.project.inputDigest) return null;
  return {
    projectRoot: args.project.rootDir,
    adapterId: args.project.adapterId,
    inputDigest: args.project.inputDigest,
  };
}

function emptyStats(): FileStats {
  return { functions: 0, functionsWithDeps: 0, predicates: 0, unparsed: 0, dependencies: 0 };
}

/**
 * 把按文件桶编成盘上形态。
 *
 * 入口是**桶**而不是 `ConditionIndex`：桶自带逐文件统计——`stats.functions` 数的是"扫过的函数"
 * （含没有谓词的），而 `byFunction` 只收有谓词的，事后从索引反推不回来。
 * 顺序 = 传入的迭代顺序（引擎按本次 walk 顺序构造）⇒ 与全量重建同序。
 */
export function encodeBuckets(args: {
  buckets: ReadonlyMap<string, FileBucket>;
  expect: ExtractExpect;
  savedAt?: number;
}): StoredConditionIndex {
  const schemas: (VariableInfo | null)[] = [];
  const schemaIdx = new Map<string, number>();

  const indexOfSchema = (s: VariableInfo): number => {
    const id = JSON.stringify([s.name, s.index ?? null, s.resolvedIndex ?? null, s.description ?? null]);
    let i = schemaIdx.get(id);
    if (i === undefined) {
      i = schemas.length;
      schemas.push(s);
      schemaIdx.set(id, i);
    }
    return i;
  };

  const out: Record<string, BucketTuple> = {};
  for (const [path, b] of args.buckets) {
    const conds: CondTuple[] = b.conds.map((c): CondTuple => [
      c.normalizedName,
      c.startLine,
      c.predicateCount,
      c.unparsedCount,
      c.dependencies.map((d): DependencyTuple => [
        d.key,
        d.name,
        d.indices,
        d.count,
        d.firstLine,
        d.comparisons.map((cmp): ComparisonTuple => [cmp.op, cmp.value, cmp.text]),
        d.schema === undefined ? -1 : indexOfSchema(d.schema),
      ]),
    ]);
    const s = b.stats;
    out[path] = [b.mtimeMs, [s.functions, s.functionsWithDeps, s.predicates, s.unparsed, s.dependencies], conds];
  }

  return {
    format: EXTRACT_SNAPSHOT_FORMAT,
    projectRoot: args.expect.projectRoot,
    adapterId: args.expect.adapterId,
    inputDigest: args.expect.inputDigest,
    savedAt: args.savedAt ?? Date.now(),
    schemas,
    buckets: out,
  };
}

function isComparisonTuple(t: unknown): t is ComparisonTuple {
  return (
    Array.isArray(t) &&
    t.length === 3 &&
    typeof t[0] === 'string' &&
    (typeof t[1] === 'number' || typeof t[1] === 'string') &&
    typeof t[2] === 'string'
  );
}

function isDependencyTuple(t: unknown, schemaCount: number): t is DependencyTuple {
  if (!Array.isArray(t) || t.length !== 7) return false;
  const [key, name, indices, count, firstLine, comparisons, sIdx] = t as unknown[];
  if (typeof key !== 'string' || typeof name !== 'string') return false;
  if (!Array.isArray(indices) || !indices.every((i) => typeof i === 'string')) return false;
  if (typeof count !== 'number' || typeof firstLine !== 'number' || typeof sIdx !== 'number') return false;
  if (!Array.isArray(comparisons) || !comparisons.every(isComparisonTuple)) return false;
  return sIdx === -1 || (Number.isInteger(sIdx) && sIdx >= 0 && sIdx < schemaCount);
}

function isCondTuple(t: unknown): t is CondTuple {
  if (!Array.isArray(t) || t.length !== 5) return false;
  const [name, startLine, pred, unparsed, deps] = t as unknown[];
  return (
    typeof name === 'string' &&
    typeof startLine === 'number' &&
    typeof pred === 'number' &&
    typeof unparsed === 'number' &&
    Array.isArray(deps)
  );
}

function isBucketTuple(t: unknown): t is BucketTuple {
  if (!Array.isArray(t) || t.length !== 3) return false;
  const [mtime, stats, conds] = t as unknown[];
  if (mtime !== null && typeof mtime !== 'number') return false;
  if (!Array.isArray(stats) || stats.length !== 5 || !stats.every((n) => typeof n === 'number')) return false;
  return Array.isArray(conds) && conds.every(isCondTuple);
}

/**
 * 还原为按文件桶；**全局判据**（格式 / 项目根 / 适配器 / `inputDigest`）或结构任一不符 ⇒ null。
 * 逐文件是否可用交给 `planReuse`（比 mtime）。
 */
export function decodeBuckets(
  raw: unknown,
  expect: ExtractExpect,
): { buckets: Record<string, FileBucket>; schemas: readonly (VariableInfo | null)[] } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Partial<StoredConditionIndex>;
  if (s.format !== EXTRACT_SNAPSHOT_FORMAT) return null;
  if (s.projectRoot !== expect.projectRoot) return null;
  if (s.adapterId !== expect.adapterId) return null;
  if (s.inputDigest !== expect.inputDigest) return null;
  if (typeof s.buckets !== 'object' || s.buckets === null) return null;
  if (!Array.isArray(s.schemas) || !s.schemas.every((v) => v === null || typeof v === 'object')) return null;

  const out: Record<string, FileBucket> = {};
  for (const [path, tuple] of Object.entries(s.buckets as Record<string, unknown>)) {
    if (!isBucketTuple(tuple)) return null;
    const [mtimeMs, st, conds] = tuple;
    const depsOk = conds.every((c) => c[4].every((d) => isDependencyTuple(d, s.schemas!.length)));
    if (!depsOk) return null;
    out[path] = {
      mtimeMs,
      stats: {
        functions: st[0],
        functionsWithDeps: st[1],
        predicates: st[2],
        unparsed: st[3],
        dependencies: st[4],
      },
      conds: conds.map((c): FunctionConditions => {
        const [normalizedName, startLine, predicateCount, unparsedCount, deps] = c;
        const dependencies: StateDependency[] = deps.map((d): StateDependency => {
          const [key, name, indices, count, firstLine, comparisons, sIdx] = d;
          const dep: StateDependency = {
            key,
            name,
            indices,
            count,
            comparisons: comparisons.map((cmp): ConditionComparison => ({ op: cmp[0], value: cmp[1], text: cmp[2] })),
            firstLine,
          };
          if (sIdx >= 0) dep.schema = s.schemas![sIdx] as VariableInfo;
          return dep;
        });
        return { normalizedName, filePath: path, startLine, predicateCount, unparsedCount, dependencies };
      }),
    };
  }
  return { buckets: out, schemas: s.schemas };
}

/** 逐文件比对结果：可复用哪些桶、哪些文件要重算 */
export interface ReusePlan {
  readonly reusable: ReadonlyMap<string, FileBucket>;
  /** 需要重算的文件路径（含快照里没有的、mtime 变了的、任一侧 mtime 为 null 的） */
  readonly stale: string[];
  /** 全库命中（stale 为空）——日志与测试用 */
  readonly allHit: boolean;
}

/**
 * 决定哪些文件能复用（**纯函数**，可单测）。
 *
 * 判据：桶里的 `mtimeMs` 与本次索引的 `fileMtimes` **逐位相等**且都不为 null。
 * 快照里没有该文件、文件消失、mtime 变了、任一侧取不到 mtime ⇒ 进 `stale`（或不进结果）。
 * 顺序：`files` 传入顺序 = 本次 walkDir 顺序 ⇒ 合并结果与全量重建同序。
 */
export function planReuse(
  buckets: Readonly<Record<string, FileBucket>> | null,
  files: readonly { path: string; mtimeMs: number | null }[],
): ReusePlan {
  const reusable = new Map<string, FileBucket>();
  const stale: string[] = [];
  for (const f of files) {
    const b = buckets?.[f.path];
    if (b && b.mtimeMs !== null && f.mtimeMs !== null && b.mtimeMs === f.mtimeMs) {
      reusable.set(f.path, b);
    } else {
      stale.push(f.path);
    }
  }
  return { reusable, stale, allHit: stale.length === 0 && files.length > 0 };
}

/**
 * 按本次 walk 顺序把「复用的桶」与「新算的桶」拼成索引（**纯函数**）。
 *
 * 纪律与 `aggregateIndex` 同源：**全量重建与增量复用必须走同一份合并代码**，否则两条路径
 * 会悄悄分叉。统计按文件相加（`ConditionIndex.stats` 五项都是可加量）。
 */
export function mergeBuckets(
  files: readonly string[],
  reusable: ReadonlyMap<string, FileBucket>,
  computed: ReadonlyMap<string, FileBucket>,
): ConditionIndex {
  const byFunction = new Map<string, FunctionConditions>();
  const stats = emptyStats();
  for (const path of files) {
    const b = computed.get(path) ?? reusable.get(path);
    if (!b) continue; // 该文件本次没产出（读失败 / 扫描失败 ⇒ 已由日志显式记录）
    stats.functions += b.stats.functions;
    stats.functionsWithDeps += b.stats.functionsWithDeps;
    stats.predicates += b.stats.predicates;
    stats.unparsed += b.stats.unparsed;
    stats.dependencies += b.stats.dependencies;
    for (const c of b.conds) byFunction.set(c.normalizedName, c);
  }
  return {
    projectRoot: '',
    finishedAt: Date.now(),
    durationMs: 0,
    byFunction,
    stats,
  };
}
