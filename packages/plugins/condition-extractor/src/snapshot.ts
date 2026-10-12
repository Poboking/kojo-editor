/**
 * 条件抽取结果快照（2026-10-12「体感丝滑」批 +「快照瘦身」批）。
 *
 * ## 为什么
 * 全量抽取在真实语料上实测 **11.3 s**（95,333 函数 / 493,712 谓词 / 164,910 依赖），而插件在
 * `kojo.functionChanged` 上**自动催动**——每次开项目都重跑一遍。抽取是整项目粒度的
 * 纯函数：文件没变 ⇒ 产出必相同。所以整块落盘、下次直接还原。
 *
 * ## 失效判据
 * 存储键是**固定槽位名**（版本在 payload 里：换格式 ⇒ 旧 payload 被判不符 ⇒ 删除并覆盖，
 * 不会留下永远读不到的孤儿文件）。快照本体自带 `CacheExpect` 三重判据
 * （项目根 / 适配器 / 项目体量指纹）。指纹来自索引构建顺手已有的 stat 结果 ⇒ **不额外读盘**；
 * `EXTRACT_SNAPSHOT_FORMAT` 是语义版本 salt——**改抽取代码必须 bump**，
 * 否则"文件没变但代码变了"会误命中旧结果。
 *
 * ## v1 → v2（瘦身，实测驱动）
 * v1 快照 **45.86 MB**，逐字段拆完发现三类纯重复：
 * - `schema` 语义标签 **8.41 MB**，但全语料只有 **1,832 种**——被重复写了 164,910 次 ⇒ 改去重表 + 存下标；
 * - `filePath` **6.42 MB**，实际只对应 2,285 个文件 ⇒ 改文件字典 + 存下标；
 * - `normalizedName` **2.00 MB**，而它**就是 map 键**（`byFunction.set(cond.normalizedName, cond)`）⇒ 值里不再写；
 * 再把依赖与比较改成**位置元组**，键名开销（≈2.4 MB）一并消失。
 * 依赖的 `name` / `indices` **不从 `key` 反解**：`dependencyKey` 用 `:` 连接索引段，
 * 含冒号的字符串索引段会有歧义（既有设计属性），缓存层不该悄悄依赖它。
 *
 * ## 纪律
 * **fail-closed**：格式版本 / 项目根 / 指纹 / adapterId / 结构 任一不符 ⇒ 返回 null，
 * 调用方全量重算并删除坏快照。抽取结果直接喂给条件矩阵与回放徽章，错一次比慢十秒危险得多。
 * 元组是**位置契约**——`FunctionConditions`/`StateDependency` 增删字段必须同步改编解码并 bump
 * 版本；漏改由 `snapshot.test.ts` 的「字段清单哨兵」测试拦下，不靠人记。
 */
import type {
  CacheExpect,
  ConditionComparison,
  ConditionIndex,
  ErbIndex,
  FunctionConditions,
  GameProject,
  StateDependency,
  VariableInfo,
} from '@kojo/plugin-api';
import { combineDigests } from '@kojo/plugin-api';

/** 快照格式版本；改 `FunctionConditions`/`StateDependency` 语义或抽取口径时 +1 */
export const EXTRACT_SNAPSHOT_FORMAT = 2;

/** 存储键 = 固定槽位名（版本在 payload 里，换格式时旧文件会被读出→判不符→删除→覆盖） */
export const EXTRACT_STORE_KEY = 'extract-snapshot-v1';

/** 依赖项：`[key, name, indices, count, firstLine, comparisons, schemaIdx]`；`schemaIdx = -1` 表示无 */
type DependencyTuple = [string, string, string[], number, number, ComparisonTuple[], number];
/** 比较项：`[op, value, 原文]` */
type ComparisonTuple = [string, number | string, string];
/** 函数项：`[fileIdx, startLine, predicateCount, unparsedCount, dependencies]` */
type FunctionTuple = [number, number, number, number, DependencyTuple[]];

/** 落盘形态（v2）：Map 以 `[键, 元组]` 数组保存，保留计算序；两张字典消掉重复大字段 */
export interface StoredConditionIndex {
  readonly format: number;
  readonly projectRoot: string;
  readonly adapterId: string;
  readonly fingerprint: string;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly stats: ConditionIndex['stats'];
  readonly files: readonly string[];
  readonly schemas: readonly (VariableInfo | null)[];
  readonly entries: ReadonlyArray<readonly [string, FunctionTuple]>;
}

/**
 * 组装本次抽取的命中判据。
 *
 * **两路输入都齐才允许缓存**：
 * - `index.fingerprint` —— ERB 正文的体量指纹（抽取吃的是正文与控制流骨架）；
 * - `project.inputDigest` —— adapter 在 `loadProject` 里吃进的**非 ERB 输入**。
 *   eraTW 的变量字典由 `CSV/*.csv` 驱动，抽取结果里的 `StateDependency.schema` 标签正是它给的
 *   （2026-10-12 自查发现：只看 ERB 指纹时，改一行 `CFLAG.csv` 描述会让快照继续吐旧标签）。
 *
 * 缺任一路 ⇒ null ⇒ 全量重算。少缓存一次只是慢，错缓存一次是拿错的语义标注喂 UI。
 */
export function extractExpect(args: {
  index: Pick<ErbIndex, 'fingerprint'>;
  project: Pick<GameProject, 'rootDir' | 'adapterId' | 'inputDigest'>;
}): CacheExpect | null {
  const fingerprint = combineDigests([args.index.fingerprint, args.project.inputDigest]);
  if (!fingerprint) return null;
  return { projectRoot: args.project.rootDir, adapterId: args.project.adapterId, fingerprint };
}

export function encodeConditionIndex(args: {
  index: ConditionIndex;
  expect: CacheExpect;
}): StoredConditionIndex {
  const files: string[] = [];
  const fileIdx = new Map<string, number>();
  const schemas: (VariableInfo | null)[] = [];
  const schemaIdx = new Map<string, number>();
  const indexOfFile = (path: string): number => {
    let i = fileIdx.get(path);
    if (i === undefined) {
      i = files.length;
      files.push(path);
      fileIdx.set(path, i);
    }
    return i;
  };
  const indexOfSchema = (s: VariableInfo): number => {
    // 同一 (name,index,resolvedIndex,description) 的标签在语料里重复十几万次，去重后只剩千级
    const id = JSON.stringify([s.name, s.index ?? null, s.resolvedIndex ?? null, s.description ?? null]);
    let i = schemaIdx.get(id);
    if (i === undefined) {
      i = schemas.length;
      schemas.push(s);
      schemaIdx.set(id, i);
    }
    return i;
  };

  const entries: [string, FunctionTuple][] = [];
  for (const [name, c] of args.index.byFunction.entries()) {
    const deps: DependencyTuple[] = c.dependencies.map((d): DependencyTuple => [
      d.key,
      d.name,
      d.indices,
      d.count,
      d.firstLine,
      d.comparisons.map((cmp): ComparisonTuple => [cmp.op, cmp.value, cmp.text]),
      d.schema === undefined ? -1 : indexOfSchema(d.schema),
    ]);
    entries.push([name, [indexOfFile(c.filePath), c.startLine, c.predicateCount, c.unparsedCount, deps]]);
  }

  return {
    format: EXTRACT_SNAPSHOT_FORMAT,
    projectRoot: args.expect.projectRoot,
    adapterId: args.expect.adapterId,
    fingerprint: args.expect.fingerprint,
    finishedAt: args.index.finishedAt,
    durationMs: args.index.durationMs,
    stats: args.index.stats,
    files,
    schemas,
    entries,
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
  if (typeof count !== 'number' || typeof firstLine !== 'number') return false;
  if (!Array.isArray(comparisons) || !comparisons.every(isComparisonTuple)) return false;
  if (typeof sIdx !== 'number') return false;
  return sIdx === -1 || (Number.isInteger(sIdx) && sIdx >= 0 && sIdx < schemaCount);
}

function isFunctionTuple(t: unknown, fileCount: number): t is FunctionTuple {
  if (!Array.isArray(t) || t.length !== 5) return false;
  const [fileI, startLine, pred, unparsed, deps] = t as unknown[];
  if (!Number.isInteger(fileI) || (fileI as number) < 0 || (fileI as number) >= fileCount) return false;
  if (typeof startLine !== 'number' || typeof pred !== 'number' || typeof unparsed !== 'number') return false;
  return Array.isArray(deps);
}

/** 还原快照；三重判据或结构任一不符 ⇒ null（调用方全量重算，绝不"修"快照） */
export function decodeConditionIndex(raw: unknown, expect: CacheExpect): ConditionIndex | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Partial<StoredConditionIndex>;
  if (s.format !== EXTRACT_SNAPSHOT_FORMAT) return null;
  if (s.projectRoot !== expect.projectRoot) return null;
  if (s.adapterId !== expect.adapterId) return null;
  if (s.fingerprint !== expect.fingerprint) return null;
  if (!Array.isArray(s.entries) || !Array.isArray(s.files) || !Array.isArray(s.schemas)) return null;
  if (typeof s.stats !== 'object' || s.stats === null) return null;
  const files = s.files as unknown[];
  const schemas = s.schemas as unknown[];
  if (!files.every((f) => typeof f === 'string') || !schemas.every((v) => v === null || typeof v === 'object')) {
    return null;
  }

  const byFunction = new Map<string, FunctionConditions>();
  for (const row of s.entries as unknown[]) {
    if (!Array.isArray(row) || row.length !== 2) return null;
    const [name, tup] = row as [unknown, unknown];
    if (typeof name !== 'string' || !isFunctionTuple(tup, files.length)) return null;
    const [fileI, startLine, predicateCount, unparsedCount, deps] = tup;
    if (!deps.every((d) => isDependencyTuple(d, schemas.length))) return null;
    const dependencies: StateDependency[] = deps.map((d): StateDependency => {
      const [key, dName, indices, count, firstLine, comparisons, sIdx] = d;
      const out: StateDependency = {
        key,
        name: dName,
        indices,
        count,
        comparisons: comparisons.map((cmp): ConditionComparison => ({ op: cmp[0], value: cmp[1], text: cmp[2] })),
        firstLine,
      };
      if (sIdx >= 0) out.schema = schemas[sIdx] as VariableInfo;
      return out;
    });
    byFunction.set(name, {
      normalizedName: name, // 键即归一化名（engine 里 byFunction.set(cond.normalizedName, cond)）
      filePath: files[fileI] as string,
      startLine,
      predicateCount,
      unparsedCount,
      dependencies,
    });
  }

  return {
    projectRoot: s.projectRoot,
    finishedAt: s.finishedAt ?? 0,
    durationMs: s.durationMs ?? 0,
    byFunction,
    stats: s.stats,
  };
}
