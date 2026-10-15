/**
 * 条件抽取结果快照（2026-10-12「体感丝滑」批 →「快照瘦身」批 →「按文件增量」批）。
 *
 * ## 为什么存在
 * 全量抽取在真实语料上实测 **11.3 s**（95,333 函数 / 493,712 谓词 / 164,910 依赖），
 * 而插件在 `kojo.functionChanged` 上**自动催动**——每次开项目都重跑一遍。抽取是逐文件的
 * 纯函数：某个文件的正文没变 ⇒ 该文件的产出必相同。
 *
 * ## 五版演进（每一版都是量出来的，不是猜的）
 * - **v1** 整项目 JSON：45.86 MB，判据 = 全库 ERB 指纹。
 * - **v2** 字典 + 元组：schema 标签全库只有 1,832 种却重复写 164,910 次、`filePath` 只对应
 *   2,285 个文件、`normalizedName` 就是 map 键 ⇒ 剥掉后 12.47 MB。
 * - **v3 按文件分桶**：v1/v2 的判据是"任一文件变 ⇒ 全库作废"，而**作者天天只改几个文件**，
 *   真实工作流里每次开项目都要重付 4 s。现在按文件存桶 + 逐文件 mtime 比对，
 *   只重算变过的那几个；磁盘与结构开销同 v2 一个量级。
 * - **v4 删派生字段**：`key` 是 `dependencyKey(name, indices)` 的**纯派生值**（164,910 条依赖
 *   逐条验 0 例外）却占盘上 18%，`name` 全库只有 1,176 种也被逐条写一遍 ⇒ 删前者、后者进字典。
 *   体积 **12.31 MB → 9.01 MB（实测 −26.8%）**，但**热路径没有变快**（366ms，v3 为 349–363ms）：
 *   时间花在 `JSON.parse`（138ms）和还原成对象（126ms）上，不在字节数上。见下方"v4 的读数"。
 * - **v5 懒还原 + size 判据**（2026-10-16 PERF-7）：桶追加 `size`；`conds` 的 `dependencies`
 *   改成惰性 getter（校验照旧急做，fail-closed 不打折）。
 *
 * ## v4 的读数：体积真降了 27%，水位一点没动（如实记录）
 * 逐字段量过字节构成（探针，真实语料 164,910 条依赖）：依赖固定槽 **57.4%**、
 * 函数头固定槽 15.0%、比较式 15.1%、schemas 字典 0.9%。删除派生 `key` + `name` 进字典后
 * 实测 **12.31 MB → 9.01 MB**，且**内容指纹与 v3 逐字相同**（`keysDigest` / `contentDigest` /
 * `tagged` 三项一致）⇒ 编码是等价的，砍掉的确实全是冗余字节。
 *
 * 但热路径抽取段 **366ms**（v3 三次读数 349–363ms）——落在噪声之上一点，不是提速。
 * 分段成本把这解释清楚了：读盘 36ms / `JSON.parse` **138ms** / 还原成 `FunctionConditions`
 * 对象 **126ms**。也就是说 366ms 里约 **72% 是"解析 + 造对象"**，字节数只买得到读盘那 36ms。
 * **压体积不等于提速**——v5 的刀就落在这条读数上：对象构造按"谁问谁付"拆两段。
 *
 * 两个被实测**否掉**的想法（记下来免得有人再试）：
 * - 把 `indices` 拼成 `a:b` 字符串省括号：语料里**有 361 个索引本身就含 `:`**，拼回来自带歧义，
 *   为 2.7pp 体积换一条"索引不许含冒号"的隐式约束不值；
 * - 比较式原文进字典：原文平均 4.3 B，换成下标几乎不省（3.2pp），不值多一层字典与一处越界判据。
 *
 * ## 两层失效判据（分工明确）
 * - **全局层**（判不符 ⇒ 整包弃用）：项目根 / `adapterId` / `inputDigest` / 格式版本。
 *   `inputDigest` 是 adapter 在 `loadProject` 吃进的非 ERB 输入摘要——eraTW 的变量字典由
 *   `CSV/*.csv` 驱动，抽取结果里的 `StateDependency.schema` 标签正是它给的
 *   （2026-10-12 自查发现：只看 ERB 指纹时，改一行 `CFLAG.csv` 描述会让快照继续吐旧标签）。
 * - **逐文件层**（判不符 ⇒ 只重算该文件）：桶里存的 `mtimeMs` 与 `ErbIndex.fileMtimes` 比对；
 *   任一侧为 `null`（取不到 stat）⇒ 该文件永不复用。
 *   **v5 起再叠 size 判据**（PERF-7）：两侧都有数时要求与桶里存的字节数相等——
 *   "mtime 同值替换"（保留时间戳的拷贝 / 工具改写）只有 size 兜得住；任一侧没数
 *   （索引提供方未建 `fileSizes` / stat 取不到）就退回纯 mtime 判据（不伪造信号）。
 *   磁盘上消失的文件不在本次 walk 顺序里 ⇒ 天然收尸，快照不会越攒越大。
 *
 * ## v5 的读数（PERF-7 快照热载瘦身）
 * 还原两段化：decode 只做校验 + 建桶壳，`conds[i].dependencies` 是**惰性 getter**——
 * 聚合（`mergeBuckets` 只吃 `normalizedName` 与桶级 stats）与开项目路径不再构造
 * 16 万级 `StateDependency` 对象；谁问谁付（条件矩阵按函数拉取、落盘路径一次性编码）。
 * 合成 2,000 文件口径（28k 函数桶 / 168k 依赖）实测见提交信息。
 *
 * ## 纪律
 * **fail-closed**：全局判据或结构任一不符 ⇒ 整包 null；元组是**位置契约**，
 * `FunctionConditions`/`StateDependency` 增删字段必须同步改编解码并 bump
 * `EXTRACT_SNAPSHOT_FORMAT`，漏改由 `snapshot.test.ts` 的「字段清单哨兵」测试拦下。
 * 存储键是**固定槽位名**（版本在 payload 里）：换格式后旧文件被读出→判不符→删除→覆盖，
 * 不留永远读不到的孤儿。
 */
import { dependencyKey } from '@kojo/plugin-api';
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
export const EXTRACT_SNAPSHOT_FORMAT = 5;

/** 存储键 = 固定槽位名（版本在 payload 里，换格式时旧文件读出即判死并被覆盖） */
export const EXTRACT_STORE_KEY = 'extract-snapshot-v1';

/** 单文件贡献的统计（`ConditionIndex.stats` 五项都可按文件相加） */
export type FileStats = ConditionIndex['stats'];

/** 一个文件的结果桶 */
export interface FileBucket {
  readonly mtimeMs: number | null;
  /** 构建该桶时的文件**字节数**（与 `ErbIndex.fileSizes` 同源）；null = 取不到 ⇒ 退回纯 mtime 判据 */
  readonly size: number | null;
  readonly stats: FileStats;
  readonly conds: FunctionConditions[];
}

/** 全局判据（逐文件那层由桶里的 mtime 负责） */
export interface ExtractExpect {
  readonly projectRoot: string;
  readonly adapterId: string;
  readonly inputDigest: string;
}

/**
 * `[nameIdx, indices, count, firstLine, comparisons, schemaIdx]`；`schemaIdx = -1` 表示无。
 * **v4 不再存 `key`**：它是 `dependencyKey(name, indices)` 的纯派生值（真实语料 164,910 条依赖
 * 逐条验过 0 例外），存下来等于每条依赖多写 13.4 字节 ⇒ 占快照 18%。还原时现算即可。
 */
type DependencyTuple = [number, string[], number, number, ComparisonTuple[], number];
/** `[op, value, 原文]` */
type ComparisonTuple = [string, number | string, string];
/** `[归一化名, startLine, predicateCount, unparsedCount, deps]`；`filePath` 由桶键给出 */
type CondTuple = [string, number, number, number, DependencyTuple[]];
/** `[mtimeMs, size, 该文件统计, 函数桶]`（v5 起第 2 位是 size） */
type BucketTuple = [number | null, number | null, [number, number, number, number, number], CondTuple[]];

/** 落盘形态（v4） */
export interface StoredConditionIndex {
  readonly format: number;
  readonly projectRoot: string;
  readonly adapterId: string;
  readonly inputDigest: string;
  readonly savedAt: number;
  readonly schemas: readonly (VariableInfo | null)[];
  /** 变量名去重表（真实语料 1,176 种名字被写 164,910 次）；依赖元组的第 0 位是它的下标 */
  readonly names: readonly string[];
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
 *
 * @throws 若某条依赖的 `key` 不再等于 `dependencyKey(name, indices)`——派生前提破了就**宁可不缓存**
 *   （调用方是 fire-and-forget 的 `save`，异常会变成一条 warn 日志），也绝不留下一个
 *   "还原出的 key 与算出来的不一样"的快照。真实语料实测 164,910 条依赖 0 例外。
 */
export function encodeBuckets(args: {
  buckets: ReadonlyMap<string, FileBucket>;
  expect: ExtractExpect;
  savedAt?: number;
}): StoredConditionIndex {
  const schemas: (VariableInfo | null)[] = [];
  const schemaIdx = new Map<string, number>();
  const names: string[] = [];
  const nameSlot = new Map<string, number>();

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
  const indexOfName = (n: string): number => {
    let i = nameSlot.get(n);
    if (i === undefined) {
      i = names.length;
      names.push(n);
      nameSlot.set(n, i);
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
      c.dependencies.map((d): DependencyTuple => {
        if (d.key !== dependencyKey({ name: d.name, indices: d.indices })) {
          throw new Error(
            `StateDependency.key 不再是 dependencyKey(name, indices) 的派生值：` +
              `${path} / ${c.normalizedName} key=${d.key} name=${d.name} ⇒ 停止缓存抽取快照`,
          );
        }
        return [
          indexOfName(d.name),
          d.indices,
          d.count,
          d.firstLine,
          d.comparisons.map((cmp): ComparisonTuple => [cmp.op, cmp.value, cmp.text]),
          d.schema === undefined ? -1 : indexOfSchema(d.schema),
        ];
      }),
    ]);
    const s = b.stats;
    out[path] = [
      b.mtimeMs,
      b.size,
      [s.functions, s.functionsWithDeps, s.predicates, s.unparsed, s.dependencies],
      conds,
    ];
  }

  return {
    format: EXTRACT_SNAPSHOT_FORMAT,
    projectRoot: args.expect.projectRoot,
    adapterId: args.expect.adapterId,
    inputDigest: args.expect.inputDigest,
    savedAt: args.savedAt ?? Date.now(),
    schemas,
    names,
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

function isDependencyTuple(t: unknown, schemaCount: number, nameCount: number): t is DependencyTuple {
  if (!Array.isArray(t) || t.length !== 6) return false;
  const [nameIx, indices, count, firstLine, comparisons, sIdx] = t as unknown[];
  if (typeof nameIx !== 'number' || !Number.isInteger(nameIx) || nameIx < 0 || nameIx >= nameCount) return false;
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
  if (!Array.isArray(t) || t.length !== 4) return false;
  const [mtime, size, stats, conds] = t as unknown[];
  if (mtime !== null && typeof mtime !== 'number') return false;
  if (size !== null && typeof size !== 'number') return false;
  if (!Array.isArray(stats) || stats.length !== 5 || !stats.every((n) => typeof n === 'number')) return false;
  return Array.isArray(conds) && conds.every(isCondTuple);
}

/**
 * 建**惰性**函数条件壳：`dependencies` 首次被读时才把盘上元组还原成 `StateDependency[]`
 * （`key` 按**同一个** `dependencyKey` 现算——它必须与 `extract.ts` 产出的键逐字节相同，
 * 否则徽章/依赖分组会在"冷算 vs 还原"两条路上分叉）。
 *
 * 校验（`isDependencyTuple` / `isComparisonTuple` / 下标越界）在 decode 时**已逐条做完**
 * （fail-closed 不打折），这里只是把"造 16 万级对象"这一步推迟到首个真正的消费方：
 * 开项目级联只吃桶级 stats 与 `normalizedName`，不该替一次查看面板的点击买单。
 */
function lazyConditions(
  path: string,
  c: CondTuple,
  names: readonly string[],
  schemas: readonly (VariableInfo | null)[],
): FunctionConditions {
  const [normalizedName, startLine, predicateCount, unparsedCount, deps] = c;
  const cond: FunctionConditions = {
    normalizedName,
    filePath: path,
    startLine,
    predicateCount,
    unparsedCount,
    get dependencies(): StateDependency[] {
      const built = deps.map((d): StateDependency => {
        const [nameIx, indices, count, firstLine, comparisons, sIdx] = d;
        const name = names[nameIx]!;
        const dep: StateDependency = {
          key: dependencyKey({ name, indices }),
          name,
          indices,
          count,
          comparisons: comparisons.map((cmp): ConditionComparison => ({ op: cmp[0], value: cmp[1], text: cmp[2] })),
          firstLine,
        };
        if (sIdx >= 0) dep.schema = schemas[sIdx] as VariableInfo;
        return dep;
      });
      // 读一次建对象，随后换成普通值属性（再次读写零开销；`toEqual` 深比照常走通）
      Object.defineProperty(cond, 'dependencies', { value: built, enumerable: true, writable: true, configurable: true });
      return built;
    },
  };
  return cond;
}

/**
 * 还原为按文件桶；**全局判据**（格式 / 项目根 / 适配器 / `inputDigest`）或结构任一不符 ⇒ null。
 * 逐文件是否可用交给 `planReuse`（比 mtime + size）。
 * 校验急、还原懒：引用元组的形状/下标在 decode 时全查过，函数条件对象的 `dependencies` 才惰性。
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
  if (!Array.isArray(s.names) || !s.names.every((v) => typeof v === 'string')) return null;
  const names = s.names as readonly string[];
  const schemas = s.schemas as readonly (VariableInfo | null)[];

  const out: Record<string, FileBucket> = {};
  for (const [path, tuple] of Object.entries(s.buckets as Record<string, unknown>)) {
    if (!isBucketTuple(tuple)) return null;
    const [mtimeMs, size, st, conds] = tuple;
    const depsOk = conds.every((c) =>
      c[4].every((d) => isDependencyTuple(d, schemas.length, names.length)),
    );
    if (!depsOk) return null;
    out[path] = {
      mtimeMs,
      size,
      stats: {
        functions: st[0],
        functionsWithDeps: st[1],
        predicates: st[2],
        unparsed: st[3],
        dependencies: st[4],
      },
      conds: conds.map((c) => lazyConditions(path, c, names, schemas)),
    };
  }
  return { buckets: out, schemas };
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
 * 判据：桶里的 `mtimeMs` 与本次索引的 `fileMtimes` **逐位相等**且都不为 null；
 * 若两侧**都**带 size（`ErbIndex.fileSizes` / 桶里的构建期字节数），再要求二者相等——
 * "mtime 同值替换"只有 size 兜得住。size 是 additive 信号：任一侧没数（索引提供方
 * 未建 `fileSizes` / stat 取不到）就退回纯 mtime 判据，不伪造判据也不把没信号当"过期"。
 * 快照里没有该文件、文件消失、mtime 变了、任一侧取不到 mtime ⇒ 进 `stale`（或不进结果）。
 * 顺序：`files` 传入顺序 = 本次 walkDir 顺序 ⇒ 合并结果与全量重建同序。
 */
export function planReuse(
  buckets: Readonly<Record<string, FileBucket>> | null,
  files: readonly { path: string; mtimeMs: number | null; size?: number | null }[],
): ReusePlan {
  const reusable = new Map<string, FileBucket>();
  const stale: string[] = [];
  for (const f of files) {
    const b = buckets?.[f.path];
    const sizeOk =
      typeof b?.size === 'number' && typeof f.size === 'number' ? b.size === f.size : true;
    if (b && b.mtimeMs !== null && f.mtimeMs !== null && b.mtimeMs === f.mtimeMs && sizeOk) {
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
