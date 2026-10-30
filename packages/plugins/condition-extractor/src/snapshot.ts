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
 * ## v6 列式依赖表（MEM-5，2026-10-29）：懒还原救不了"壳还在"
 * v5 把**对象**的构造推后了，但把**元组**留在了内存里——`dependencies` 的 getter 闭包
 * 捕获着 `deps: DependencyTuple[]`，而稳态下没人读它 ⇒ 整份解码结果原地常驻。
 * 热载稳态实测（eraTW 4.980 / 3,971 文件 / 110,073 函数 / 603,340 谓词 / 211,985 依赖）：
 * 全插件 **272.4 MB**，去掉本插件 **166.6 MB** ⇒ **本插件独占 105.8 MB**，是当时最大的单块。
 * 堆快照（`tools/heap-aggregate.mjs`）把构成摊开：`Array` 头 50.0 MB / 163.8 万个、
 * 元素区 76.2 MB / 134.8 万个；属于本快照的是 21.2 万个 `DependencyTuple` + 21.2 万个
 * `indices` 数组 + 18.4 万个比较式数组 + 18.4 万个 `ComparisonTuple`（≈ **79 万个 JSArray**）。
 * 元组里的字符串**几乎全可去重**（`JSON.parse` 的运行时串 V8 不 intern，同 PITFALLS 258）：
 * `op` 只有 **6** 种却存 18.4 万份（`==` 一种就 154,949 份 / 3.5 MB）、`text` 只有 **5,707**
 * 种（3.1%）却存 18.4 万份、`indices` 只有 **3,446** 种却存 21.3 万份（`恋慕` 20,194 份）。
 *
 * 于是把解码结果换成**一张列式表**：依赖级 8 列 + 比较式级 5 列 + 索引池，全是 TypedArray
 * （15 个数组实测合计 **11.4 MB**）；字符串进 4 个池（`ops` / `texts` / `indices` / 比较式
 * 字符串值；`names` 字典原本就是去重的）。本插件常驻 **105.8 → 36.5 MB**。
 * **盘上格式一个字节没动**（`EXTRACT_SNAPSHOT_FORMAT` 不 bump）：改的只是"读回来之后留在
 * 内存里的形态"，`dependencies` 物化出来的对象与改前**逐字段相同**——用真实语料整份快照
 * 新旧对拍验过（3,971 桶 / 52,435 条件 / 211,985 依赖 / 183,807 比较式 / 140,487 带 schema，
 * 含键序与值类型；物化耗时旧 249 ms / 新 256 ms）。代价是装载 **591 → 748 ms**（一次开项目
 * 付一次，拆解见 PITFALLS 262）。
 *
 * ## v6.1 壳的形状（MEM-11，2026-10-30）：22.4 MB 是"建壳这一步"付的，不是"读一次"付的
 * 真实堆里 52,424 枚条件壳是字典态、各挂一枚 453 B 的 `(object properties)` 块（22.4 MB）。
 * MEM-8 把 `defineProperty(cond,'dependencies',{value})` 删掉之后**读数一点没动**——因为真凶
 * 是**字面量里那个 `get dependencies()`**：V8 快路径只给"共享的常量访问器"留位置，每枚一枚
 * 闭包的访问器只能进字典。真实快照上 decode 完（一条依赖都没读）就是 **52,435/52,435 字典态**。
 * 修法：数据属性字面量 + `defineProperty` 补访问器 + **一次 decode 共用一枚**访问器，
 * 每枚的区间放 WeakMap（见 `lazyConditions` 头注）。真实快照隔离探针：decode 后 heapUsed
 * **46.6 → 21.8 MB**、读完全部 21.2 万条依赖 **115.9 → 90.3 MB**，壳 0 枚字典态；
 * 堆快照里 `object:Object` 的字典块 **52,721 枚 / 22.75 MB → 291 枚 / 0.35 MB**（剩下的是引擎自身的）。
 * 盘上格式、`FunctionConditions` 字段清单、`Object.keys` / `JSON.stringify` / `toEqual` 口径全不动。
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

/** 快照格式版本；改 `FunctionConditions`/`StateDependency` 语义或抽取口径时 +1
 *  （W8-C2：CASE 值列表接入 `{`…`}` 行连接门，抽取读数变化 ⇒ 7→8 作废旧快照；
 *   2026-10-25 ERB 语法缺口批：文本内联三元 `\@…?…#…\@` / `{…?…#…}` 纳入谓词 ⇒ 8→9，
 *   谓词数与依赖面都变，旧桶必须整体作废） */
export const EXTRACT_SNAPSHOT_FORMAT = 9;

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
 * 字典标签的**内容键**（拼接形，取代 `JSON.stringify`）。
 *
 * 口径与改前逐字一致：只看 `[name, index, resolvedIndex, description]` 四个字段
 * （`source` / `bits` 不参与判等 ⇒ 首份定义胜出，这是既有行为，一条没动）。
 * 分隔符取 `\u0000`：变量名与描述里都不可能出现 NUL（CSV / `.ERH` 文本域），
 * 而"缺字段"用 `\u0001` 单独占位——`index: 0`、`index: '0'`、`index: undefined`
 * 三种形态必须落到三个不同的键上，否则两条不同的槽位会共用一个字典条目（还原后互相盖描述）。
 *
 * 为什么换掉 `JSON.stringify`：真实语料 164,910 条依赖 ⇒ **每条**在落盘时都要建一次这个键，
 * 1016 批实测 123ms，同口径拼接 89ms。
 */
/** 拼接键的三个占位前缀：缺字段 / 数字 / 字符串各占一格（`0` 与 `'0'` 与"没有"互不相吞） */
const SLOT_NONE = '\u0001';
const SLOT_NUM = '\u0002n';
const SLOT_STR = '\u0002s';

/** 一个可选字段的键位（模块级函数：164,910 次调用绝不该每条依赖现造一个闭包） */
function slotOf(v: number | string | undefined | null): string {
  if (v === undefined || v === null) return SLOT_NONE;
  return typeof v === 'number' ? `${SLOT_NUM}${v}` : `${SLOT_STR}${v}`;
}

function schemaKey(s: VariableInfo): string {
  return `${s.name}\u0000${slotOf(s.index)}\u0000${slotOf(s.resolvedIndex)}\u0000${slotOf(s.description)}`;
}

/**
 * **本模块自己算出 key 的**依赖对象（`lazyConditions` 还原路径）。
 *
 * `encodeBuckets` 的派生前提守门对它们**必然成立**——`key` 就是上一行 `dependencyKey(...)`
 * 现算出来的，再验一遍是把 164,910 次字符串拼接花在"确认自己刚写的赋值"上。
 * 新抽取（`extract.ts` 产出）的依赖不在集合内 ⇒ 守门照常一条不漏（口径不变）。
 */
const keyDerivedOnDecode = new WeakSet<StateDependency>();

/**
 * 把按文件桶编成盘上形态。
 *
 * 入口是**桶**而不是 `ConditionIndex`：桶自带逐文件统计——`stats.functions` 数的是"扫过的函数"
 * （含没有谓词的），而 `byFunction` 只收有谓词的，事后从索引反推不回来。
 * 顺序 = 传入的迭代顺序（引擎按本次 walk 顺序构造）⇒ 与全量重建同序。
 *
 * @throws 若某条**新抽取**依赖的 `key` 不再等于 `dependencyKey(name, indices)`——派生前提破了就**宁可不缓存**
 *   （调用方是 fire-and-forget 的 `save`，异常会变成一条 warn 日志），也绝不留下一个
 *   "还原出的 key 与算出来的不一样"的快照。真实语料实测 164,910 条依赖 0 例外。
 *   唯一豁免：本模块 `lazyConditions` 还原出来的依赖（`key` 是它自己上一行现算的，
 *   再验一遍纯属自我确认；见 `keyDerivedOnDecode`）。
 */
export function encodeBuckets(args: {
  buckets: ReadonlyMap<string, FileBucket>;
  expect: ExtractExpect;
  savedAt?: number;
}): StoredConditionIndex {
  const schemas: (VariableInfo | null)[] = [];
  const schemaIdx = new Map<string, number>();
  /**
   * 身份快道：适配器 `lookup()` 每次现造对象 ⇒ 新抽取的依赖走内容键；
   * 而**复用的桶**（热路径的绝大多数：改 3 棵 / 2,325 棵）还原出的 `schema` 是同一个对象，
   * 身份一眼命中，连键都不建。去重口径仍是"内容判等"，产出与改前逐字相同。
   */
  const schemaIdentity = new Map<VariableInfo, number>();
  const names: string[] = [];
  const nameSlot = new Map<string, number>();

  const indexOfSchema = (s: VariableInfo): number => {
    const byIdentity = schemaIdentity.get(s);
    if (byIdentity !== undefined) return byIdentity;
    const id = schemaKey(s);
    let i = schemaIdx.get(id);
    if (i === undefined) {
      i = schemas.length;
      schemas.push(s);
      schemaIdx.set(id, i);
    }
    schemaIdentity.set(s, i);
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
        if (!keyDerivedOnDecode.has(d) && d.key !== dependencyKey({ name: d.name, indices: d.indices })) {
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

/**
 * 依赖元组校验（fail-closed 的判据本体）。
 *
 * 下标直读 + `for` 而不是 `.every` + 数组解构：后者每次调用现造一枚闭包，`const [a,b,…] = t`
 * 还要按迭代器协议多分配一枚 ArrayIterator。**如实记账：换掉这两笔之后解码耗时没有变化**
 * （190 → 191 ms，见 PITFALLS 262——真正的成本是那趟遍历本身，21.2 万个异构数组的取值）。
 * 保留这个写法的理由只剩一条：不再逐条元组产生两枚短命对象，解码期的 GC 压力更小。
 */
function isDependencyTuple(t: unknown, schemaCount: number, nameCount: number): t is DependencyTuple {
  if (!Array.isArray(t) || t.length !== 6) return false;
  const nameIx = t[0] as unknown;
  if (typeof nameIx !== 'number' || !Number.isInteger(nameIx) || nameIx < 0 || nameIx >= nameCount) return false;
  const indices = t[1] as unknown;
  if (!Array.isArray(indices)) return false;
  for (let i = 0; i < indices.length; i++) if (typeof indices[i] !== 'string') return false;
  if (typeof t[2] !== 'number' || typeof t[3] !== 'number' || typeof t[5] !== 'number') return false;
  const comparisons = t[4] as unknown;
  if (!Array.isArray(comparisons)) return false;
  for (let i = 0; i < comparisons.length; i++) if (!isComparisonTuple(comparisons[i])) return false;
  const sIdx = t[5] as number;
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

/* ------------------------------------------------------------------------- *
 * 解码后的列式依赖表（MEM-5，读数见文件头 v6）
 * ------------------------------------------------------------------------- */

/**
 * 整份快照共用的一张**列式表**（不按文件分：3,971 个桶各建一套 TypedArray 反而多出
 * 6 万个数组头）。下标语义：
 * - 依赖级列（长度 = 依赖总数 D）：`nameIx` 指向 `names` 字典，`schemaIx = -1` 表示无；
 *   `idxStart/idxLen` 指向 `idxPool`，`cmpStart/cmpLen` 指向比较式级列；
 * - 比较式级列（长度 = 比较式总数 C）：`cmpOp` 指向 `ops`，`cmpText` 指向 `texts`，
 *   `cmpValKind = 0` ⇒ 值在 `cmpValNum`，`= 1` ⇒ 值在 `cmpValStr`（指向 `valStrings`）。
 */
interface DependencyTable {
  readonly names: readonly string[];
  readonly schemas: readonly (VariableInfo | null)[];
  readonly nameIx: Int32Array;
  readonly count: Int32Array;
  readonly firstLine: Int32Array;
  readonly schemaIx: Int32Array;
  readonly idxStart: Int32Array;
  readonly idxLen: Int32Array;
  readonly cmpStart: Int32Array;
  readonly cmpLen: Int32Array;
  /** `indices` 逐元素压平后的池下标（真实语料 213,059 个元素 / 3,446 种） */
  readonly idxPool: Int32Array;
  readonly idxStrings: readonly string[];
  readonly cmpOp: Int32Array;
  readonly cmpText: Int32Array;
  readonly cmpValKind: Uint8Array;
  readonly cmpValNum: Float64Array;
  readonly cmpValStr: Int32Array;
  readonly ops: readonly string[];
  readonly texts: readonly string[];
  readonly valStrings: readonly string[];
}

/**
 * 字符串池。`slot` 只在建表期用，建成后即丢弃（表里只留 `items`）。
 *
 * 为什么带一格"上一次命中"备忘：解码实测 180 ms 里有 ~100 ms 花在 60 万次 `Map.get` 上
 * （`indices` 21.3 万 + `op` 18.4 万 + `text` 18.4 万 + 字符串值 2.6 万）。而语料里重复是
 * **成簇**的（同一个函数的谓词反复落在同一个变量上：`恋慕` 20,194 份、`text = "1"` 30,186 份）
 * ⇒ 一格备忘就能吃掉大部分查找，且不改变任何产出。
 */
interface StringPool {
  readonly items: string[];
  readonly slot: Map<string, number>;
  last: string;
  lastIx: number;
}

function newPool(): StringPool {
  return { items: [], slot: new Map(), last: '', lastIx: -1 };
}

function intern(pool: StringPool, value: string): number {
  // `lastIx >= 0` 这一半不能省：备忘初始值是 `last = ''` / `lastIx = -1`，而**空串是合法取值**
  // （真实语料里 `comparisons[].value` 有 `''`）——少了这一半，第一个空串会"命中"到 -1。
  if (value === pool.last && pool.lastIx >= 0) return pool.lastIx;
  const hit = pool.slot.get(value);
  if (hit !== undefined) {
    pool.last = value;
    pool.lastIx = hit;
    return hit;
  }
  const i = pool.items.length;
  pool.items.push(value);
  pool.slot.set(value, i);
  pool.last = value;
  pool.lastIx = i;
  return i;
}

/**
 * 比较运算符池：真实语料只有 **6** 种（`==` 一种占 84%），为 18.4 万次查找建一张哈希表
 * 不如直接线性扫 6 个短串（V8 先比长度，2 码元的串几乎零成本）。
 */
interface OpPool {
  readonly items: string[];
}

function internOp(pool: OpPool, value: string): number {
  const items = pool.items;
  for (let i = 0; i < items.length; i++) if (items[i] === value) return i;
  items.push(value);
  return items.length - 1;
}

/**
 * 两遍建表。**为什么必须两遍**：列式表要先知道总长度才能分配 TypedArray。
 *
 * 第一遍**只量长度**（形状只做"能不能安全读 `.length`"的最低限度判断），全量校验放在第二遍
 * 边填边判——两遍都做完整校验等于把 21.2 万条依赖走三遍（实测多花 ~40 ms），而 fail-closed
 * 的口径不变：任一元组不合规 ⇒ 整个 `null`，已写进去的数组随返回值一起丢弃。
 *
 * 返回表 + 逐条件函数的依赖区间（两个 Int32Array，顺序 = `entries` × 桶内 `conds` 顺序）。
 * 不用 `{start, len}` 小对象：5.2 万枚对象在稳态里是纯开销（8 字节信息，40 字节壳）。
 */
function packTable(
  entries: readonly (readonly [string, unknown])[],
  names: readonly string[],
  schemas: readonly (VariableInfo | null)[],
): { table: DependencyTable; condDepStart: Int32Array; condDepLen: Int32Array } | null {
  // ── 第一遍：量长度 ──
  let depTotal = 0;
  let cmpTotal = 0;
  let idxTotal = 0;
  let condTotal = 0;
  for (const [, tuple] of entries) {
    if (!isBucketTuple(tuple)) return null;
    for (const c of tuple[3]) {
      condTotal += 1;
      for (const d of c[4]) {
        // 只判"能不能读长度"；完整校验在第二遍
        if (!Array.isArray(d) || !Array.isArray(d[1]) || !Array.isArray(d[4])) return null;
        depTotal += 1;
        idxTotal += d[1].length;
        cmpTotal += d[4].length;
      }
    }
  }

  const nameIx = new Int32Array(depTotal);
  const count = new Int32Array(depTotal);
  const firstLine = new Int32Array(depTotal);
  const schemaIx = new Int32Array(depTotal);
  const idxStart = new Int32Array(depTotal);
  const idxLen = new Int32Array(depTotal);
  const cmpStart = new Int32Array(depTotal);
  const cmpLen = new Int32Array(depTotal);
  const idxPool = new Int32Array(idxTotal);
  const cmpOp = new Int32Array(cmpTotal);
  const cmpText = new Int32Array(cmpTotal);
  const cmpValKind = new Uint8Array(cmpTotal);
  const cmpValNum = new Float64Array(cmpTotal);
  const cmpValStr = new Int32Array(cmpTotal);
  const condDepStart = new Int32Array(condTotal);
  const condDepLen = new Int32Array(condTotal);

  const idxStrings = newPool();
  const ops: OpPool = { items: [] };
  const texts = newPool();
  const valStrings = newPool();

  let d = 0;
  let k = 0;
  let p = 0;
  let ci = 0;
  // ── 第二遍：校验 + 填充 ──
  for (const [, tuple] of entries) {
    // 第一遍已判过形状（`isBucketTuple` 收窄不到这里，故显式断言）
    const conds = (tuple as BucketTuple)[3];
    for (const c of conds) {
      const start = d;
      for (const dep of c[4]) {
        if (!isDependencyTuple(dep, schemas.length, names.length)) return null;
        // 下标直读（不走数组解构的迭代器协议；见 `isDependencyTuple` 头注）
        const nIx = dep[0];
        const indices = dep[1];
        const comparisons = dep[4];
        nameIx[d] = nIx;
        count[d] = dep[2];
        firstLine[d] = dep[3];
        schemaIx[d] = dep[5];
        idxStart[d] = k;
        idxLen[d] = indices.length;
        for (let i = 0; i < indices.length; i++) idxPool[k + i] = intern(idxStrings, indices[i]!);
        k += indices.length;
        cmpStart[d] = p;
        cmpLen[d] = comparisons.length;
        for (const cmp of comparisons) {
          // `isDependencyTuple` 已逐个判过 `isComparisonTuple`
          cmpOp[p] = internOp(ops, cmp[0]);
          cmpText[p] = intern(texts, cmp[2]);
          if (typeof cmp[1] === 'number') {
            cmpValKind[p] = 0;
            cmpValNum[p] = cmp[1];
          } else {
            cmpValKind[p] = 1;
            cmpValStr[p] = intern(valStrings, cmp[1]);
          }
          p += 1;
        }
        d += 1;
      }
      condDepStart[ci] = start;
      condDepLen[ci] = d - start;
      ci += 1;
    }
  }

  return {
    table: {
      names,
      schemas,
      nameIx,
      count,
      firstLine,
      schemaIx,
      idxStart,
      idxLen,
      cmpStart,
      cmpLen,
      idxPool,
      idxStrings: idxStrings.items,
      cmpOp,
      cmpText,
      cmpValKind,
      cmpValNum,
      cmpValStr,
      ops: ops.items,
      texts: texts.items,
      valStrings: valStrings.items,
    },
    condDepStart,
    condDepLen,
  };
}

/**
 * 从列式表物化一个函数的状态依赖（`key` 按**同一个** `dependencyKey` 现算——它必须与
 * `extract.ts` 产出的键逐字节相同，否则徽章/依赖分组会在"冷算 vs 还原"两条路上分叉）。
 *
 * 字段顺序与改前逐字相同（`key, name, indices, count, comparisons, firstLine`）：
 * 有消费方对 `JSON.stringify` 的结果做比对，顺序也算契约。
 */
function materializeDependencies(table: DependencyTable, start: number, len: number): StateDependency[] {
  const out: StateDependency[] = new Array(len);
  for (let j = 0; j < len; j++) {
    const i = start + j;
    const name = table.names[table.nameIx[i]!]!;
    const il = table.idxLen[i]!;
    const indices: string[] = new Array(il);
    const is = table.idxStart[i]!;
    for (let n = 0; n < il; n++) indices[n] = table.idxStrings[table.idxPool[is + n]!]!;
    const cl = table.cmpLen[i]!;
    const comparisons: ConditionComparison[] = new Array(cl);
    const cs = table.cmpStart[i]!;
    for (let n = 0; n < cl; n++) {
      const q = cs + n;
      const value = table.cmpValKind[q] === 0 ? table.cmpValNum[q]! : table.valStrings[table.cmpValStr[q]!]!;
      comparisons[n] = { op: table.ops[table.cmpOp[q]!]!, value, text: table.texts[table.cmpText[q]!]! };
    }
    const dep: StateDependency = {
      key: dependencyKey({ name, indices }),
      name,
      indices,
      count: table.count[i]!,
      comparisons,
      firstLine: table.firstLine[i]!,
    };
    const sIdx = table.schemaIx[i]!;
    if (sIdx >= 0) dep.schema = table.schemas[sIdx] as VariableInfo;
    // key 就是上一行现算的 ⇒ 登记给 `encodeBuckets` 的守门看（见 `keyDerivedOnDecode`）
    keyDerivedOnDecode.add(dep);
    out[j] = dep;
  }
  return out;
}

/**
 * 每枚壳的惰性状态：**区间**（`start * RANGE_SCALE + len` 打包成一个数）或**已物化的数组**。
 *
 * 为什么状态不能放在壳上、也不能放在闭包里（两条都实测过，都会退回字典态）：
 * 自有属性会改变 `Object.keys` / `toEqual` 的口径（Symbol 槽也一样——vitest 的 `toEqual`
 * 比的是"自有**可枚举**符号键"）；闭包则要求"每枚一枚函数"，访问器不共享。
 * WeakMap 是唯一既不碰对象形状、又能让访问器共享的放法；代价约 **42 B/枚**（20 万枚实测
 * 242 vs 200 B/枚），换回的是每枚 453 B 的属性块。
 */
const lazyState = new WeakMap<FunctionConditions, number | StateDependency[]>();
/** 区间打包的进制：`len < 2^26` 且 `start * 2^26 < 2^53`（真实语料 211,985 条依赖，远在界内） */
const RANGE_SCALE = 2 ** 26;

/**
 * 建**惰性**函数条件壳：`dependencies` 首次被读时才从列式表物化成 `StateDependency[]`。
 *
 * 校验（`isDependencyTuple` / `isComparisonTuple` / 下标越界）在 decode 时**已逐条做完**
 * （fail-closed 不打折），这里只是把"造 21 万级对象"这一步推迟到首个真正的消费方：
 * 开项目级联只吃桶级 stats 与 `normalizedName`，不该替一次查看面板的点击买单。
 *
 * ## 为什么访问器不能写在字面量里（MEM-11，2026-10-30 归因）
 *
 * 真实堆里 **52,424 枚条件壳是字典态、各挂一枚 453 B 的 `(object properties)` 块（22.4 MB）**，
 * 而 MEM-8 删掉 `defineProperty(cond,'dependencies',{value})` 之后**读数一点没动**。
 * 真凶不是那句 `defineProperty`，而是**壳的构造形态**：V8 的快路径只能给"**共享**的常量访问器"
 * 留位置（访问器对存在描述符里），而"每枚一枚闭包"的访问器必须按对象存 `AccessorPair`
 * ⇒ 只能 `NormalizeProperties` 转字典态。
 *
 * 实测（node 22，`%HasFastProperties` + 堆快照，6 万枚壳）：
 * - 字面量里写 `get dependencies()`：**59,999/60,000 字典态**，+39.5 MB；
 * - 先建"纯数据属性字面量"、再 `defineProperty` 补访问器，但**每枚现造闭包**：
 *   只有第一枚是快路径，其余照样转字典（访问器不共享）；
 * - 访问器**按"一次 decode 一枚"共享**（闭包只捕获本次的列式表）：**0 枚字典态**，+9.3 MB。
 * ⇒ 这就是"合成复现没复现出来"的第三因素：不是某一步 mutate，而是**建壳这一步本身**。
 * 消费侧（`applySchemaLookup` 读 `dependencies`）一枚都没碰，decode 完就已经是 100% 字典态。
 *
 * 物化出来的数组与区间都放 `lazyState`：没人读 `dependencies` 时**只有区间那一格**
 * （谁问谁付，与 v5 的懒还原同一条纪律）。
 */
function lazyConditions(
  path: string,
  c: CondTuple,
  getDependencies: (this: FunctionConditions) => StateDependency[],
  depStart: number,
  depLen: number,
): FunctionConditions {
  const [normalizedName, startLine, predicateCount, unparsedCount] = c;
  // 先建**全数据属性**的字面量（V8 快路径），`dependencies` 用 `defineProperty` 补在后面
  const cond: FunctionConditions = {
    normalizedName,
    filePath: path,
    startLine,
    predicateCount,
    unparsedCount,
  } as FunctionConditions;
  Object.defineProperty(cond, 'dependencies', { get: getDependencies, enumerable: true, configurable: true });
  lazyState.set(cond, depStart * RANGE_SCALE + depLen);
  return cond;
}

/**
 * 一次 decode 一枚**共享**访问器：闭包只捕获列式表（每枚各造一枚闭包就会退回字典态）。
 * `lazyState` 里这一枚的格子给出"从哪读、读几条"，读一次就换成物化好的数组。
 */
function dependenciesGetter(table: DependencyTable): (this: FunctionConditions) => StateDependency[] {
  return function (this: FunctionConditions): StateDependency[] {
    const state = lazyState.get(this);
    if (typeof state !== 'number') return state as StateDependency[];
    const built = materializeDependencies(table, Math.floor(state / RANGE_SCALE), state % RANGE_SCALE);
    lazyState.set(this, built);
    return built;
  };
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
  const entries = Object.entries(s.buckets as Record<string, unknown>);

  const packed = packTable(entries, names, schemas);
  if (packed === null) return null;
  const { table, condDepStart, condDepLen } = packed;

  const out: Record<string, FileBucket> = {};
  /** 整次 decode 共用一枚访问器（每枚各造一枚闭包 ⇒ 字典态，见 `lazyConditions` 头注） */
  const depGetter = dependenciesGetter(table);
  let spanAt = 0;
  for (const [path, tuple] of entries) {
    // 第一遍已判过：这里形状一定成立（`packTable` 对同一个 `entries` 走过两遍）
    const [mtimeMs, size, st, conds] = tuple as BucketTuple;
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
      conds: conds.map((c) =>
        lazyConditions(path, c, depGetter, condDepStart[spanAt]!, condDepLen[spanAt++]!),
      ),
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
