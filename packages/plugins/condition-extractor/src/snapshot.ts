/**
 * 条件抽取结果快照（2026-10-12「体感丝滑」批）。
 *
 * ## 为什么
 * 全量抽取在真实语料上实测 **11.3 s**（95,333 函数 / 493,712 谓词），而插件在
 * `kojo.functionChanged` 上**自动催动**——每次开项目都重跑一遍。抽取是整项目粒度的
 * 纯函数：文件没变 ⇒ 产出必相同。所以整块落盘、下次直接还原。
 *
 * ## 失效判据
 * 存储键是**固定常量**，快照本体自带 `CacheExpect` 三重判据（项目根 / 适配器 /
 * 项目体量指纹）。指纹来自索引构建顺手已有的 stat 结果 ⇒ **不额外读盘**；
 * `EXTRACT_SNAPSHOT_FORMAT` 是语义版本 salt——**改抽取口径必须 bump**，
 * 否则"文件没变但代码变了"会误命中旧结果。
 *
 * ## 纪律（与索引快照同款）
 * **fail-closed**：格式版本 / 项目根 / 指纹 / adapterId / 结构 任一不符 ⇒ 返回 null，
 * 调用方全量重算（并顺手删除坏快照），绝不"修"快照。抽取结果直接喂给条件矩阵与
 * 回放徽章——错一次的代价远大于多等十秒。
 */
import type { CacheExpect, ConditionIndex, FunctionConditions } from '@kojo/plugin-api';

/** 快照格式版本；改 `FunctionConditions`/`StateDependency` 语义或抽取口径时 +1 */
export const EXTRACT_SNAPSHOT_FORMAT = 1;

/** 存储键（固定：判据在快照本体里，变化即覆盖，不留历史垃圾） */
export const EXTRACT_STORE_KEY = 'extract-snapshot-v1';

/** 落盘形态（JSON 安全；Map 以条目数组保存，保留计算序） */
export interface StoredConditionIndex {
  readonly format: number;
  readonly projectRoot: string;
  readonly adapterId: string;
  readonly fingerprint: string;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly stats: ConditionIndex['stats'];
  readonly entries: ReadonlyArray<readonly [string, FunctionConditions]>;
}

export function encodeConditionIndex(args: {
  index: ConditionIndex;
  expect: CacheExpect;
}): StoredConditionIndex {
  return {
    format: EXTRACT_SNAPSHOT_FORMAT,
    projectRoot: args.expect.projectRoot,
    adapterId: args.expect.adapterId,
    fingerprint: args.expect.fingerprint,
    finishedAt: args.index.finishedAt,
    durationMs: args.index.durationMs,
    stats: args.index.stats,
    entries: [...args.index.byFunction.entries()],
  };
}

function isFunctionConditions(v: unknown): v is FunctionConditions {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.normalizedName === 'string' &&
    typeof o.filePath === 'string' &&
    typeof o.startLine === 'number' &&
    typeof o.predicateCount === 'number' &&
    typeof o.unparsedCount === 'number' &&
    Array.isArray(o.dependencies)
  );
}

/** 还原快照；三重判据或结构任一不符 ⇒ null（调用方全量重算） */
export function decodeConditionIndex(raw: unknown, expect: CacheExpect): ConditionIndex | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Partial<StoredConditionIndex>;
  if (s.format !== EXTRACT_SNAPSHOT_FORMAT) return null;
  if (s.projectRoot !== expect.projectRoot) return null;
  if (s.adapterId !== expect.adapterId) return null;
  if (s.fingerprint !== expect.fingerprint) return null;
  if (!Array.isArray(s.entries)) return null;
  if (typeof s.stats !== 'object' || s.stats === null) return null;

  const byFunction = new Map<string, FunctionConditions>();
  for (const row of s.entries) {
    if (!Array.isArray(row) || row.length !== 2) return null;
    const [name, cond] = row as [unknown, unknown];
    if (typeof name !== 'string' || !isFunctionConditions(cond)) return null;
    byFunction.set(name, cond);
  }
  return {
    projectRoot: s.projectRoot,
    finishedAt: s.finishedAt ?? 0,
    durationMs: s.durationMs ?? 0,
    byFunction,
    stats: s.stats,
  };
}
