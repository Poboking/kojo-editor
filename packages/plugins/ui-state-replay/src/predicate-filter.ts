/**
 * 回放结果面板的谓词筛选与计数（纯逻辑：零 React / 零 IO / 不改入参）。
 *
 * 为什么要有这一枚：结果区把整个函数的谓词一次性铺出来，真语料里单函数能到
 * 3,732 条——作者除了「显示更多」一路滚，没法把范围收窄到自己要看的那些。
 * 本模块只回答两个问题：
 * - 「按某个筛选条件，该看哪几条」（`filterPredicates`，保持原顺序）；
 * - 「每档各有多少条 / 哪些档位值得给出来」（`countPredicates` / `availableFilters`）。
 * 选择器怎么画、状态放哪、滚到哪一条，全留在集成侧。
 *
 * 口径（与 `docs` 里的三值回放契约一致）：
 * - `unjudged` = `outcome.kind === 'unknown'`（能力边界的诚实呈现，不是错误）；
 * - `true` / `false` 对应 `outcome.kind`；
 * - `unknownCode` 是 `unjudged` 档的**子筛**，按 `outcome.unknown.code` 机器码逐字相等过滤
 *   （如 `'call-context'`）。其他档位下忽略——那些条目本来就没有 unknown 码，若在「全部」
 *   档还生效，点回「全部」就会莫名其妙只剩一小撮。
 */
import type { PredicateReplay, ReplayOutcome } from '@kojo/plugin-api';

/** 筛选档位（三值 + 全部） */
export type PredicateFilterKind = 'all' | 'unjudged' | 'true' | 'false';

/** 筛选条件（不可变；面板可整对象替换） */
export interface PredicateFilter {
  readonly kind: PredicateFilterKind;
  /**
   * 大小写不敏感子串，匹配 `text` + 未知文案（`outcome.unknown.message`，若有）+
   * 行号字符串（`String(line)`）。空串 = 不筛。**不做 trim**（面板要 trim 就在
   * 选择器那侧 trim，这里不悄悄改作者输入）。
   */
  readonly query: string;
  /**
   * `unjudged` 档的子筛：给非空值时只留 `outcome.unknown.code` 与之相等的条目；
   * 不给（`undefined` / 空串）等价于纯 `unjudged`。`kind !== 'unjudged'` 时忽略。
   */
  readonly unknownCode?: string;
}

/**
 * 档位中文标签（面板选择器直接用）。
 * `true` / `false` 取面板既有白话：`panel-logic` 的汇总行写的是「N 处成立 / M 处不成立」，
 * 不另造「判定为真 / 判定为假」这种新词。
 */
export const PREDICATE_FILTER_LABEL: Record<PredicateFilterKind, string> = {
  all: '全部',
  unjudged: '未判定',
  true: '成立',
  false: '不成立',
};

/** 档位固定顺序（选择器与 `availableFilters` 都照此输出，UI 不会跳来跳去） */
const FILTER_ORDER: readonly PredicateFilterKind[] = ['all', 'unjudged', 'true', 'false'];

/** 每档条数（`all` 恒等于入参长度） */
export interface PredicateCounts {
  readonly all: number;
  readonly unjudged: number;
  readonly true: number;
  readonly false: number;
}

/** 非 `all` 档 → 它要的 `outcome.kind`（穷尽表；加档位时 typecheck 会逼着补） */
const WANTED_OUTCOME: Record<Exclude<PredicateFilterKind, 'all'>, ReplayOutcome['kind']> = {
  unjudged: 'unknown',
  true: 'true',
  false: 'false',
};

/** 单条谓词是否落在该档（不看 query / unknownCode 子筛） */
function matchesKind(outcome: ReplayOutcome, kind: PredicateFilterKind): boolean {
  return kind === 'all' || outcome.kind === WANTED_OUTCOME[kind];
}

/**
 * query 子串匹配：`text` + 未知文案 + 行号字符串，大小写不敏感。
 * `needle` 由调用方预先小写（一趟筛只小写一次）。
 */
function matchesQuery(predicate: PredicateReplay, needle: string): boolean {
  if (needle.length === 0) return true;
  if (predicate.text.toLowerCase().includes(needle)) return true;
  if (String(predicate.line).includes(needle)) return true;
  return (
    predicate.outcome.kind === 'unknown' &&
    predicate.outcome.unknown.message.toLowerCase().includes(needle)
  );
}

/**
 * 按筛选条件取谓词（纯函数）：
 * - 保持入参顺序，入参不被修改，返回**新数组**（空数组 / 无匹配 → `[]`，不抛）；
 * - `unknownCode` 只在 `unjudged` 档生效，且是 `outcome.unknown.code` 的**逐字相等**，
 *   不是子串（机器码短且同前缀的不少，子串会误伤）。
 */
export function filterPredicates(
  predicates: readonly PredicateReplay[],
  filter: PredicateFilter,
): PredicateReplay[] {
  const needle = filter.query.toLowerCase();
  // 空串 = 未给（面板把「未选码」表示成 undefined 还是 '' 都接住）
  const code = filter.kind === 'unjudged' && filter.unknownCode ? filter.unknownCode : undefined;

  const out: PredicateReplay[] = [];
  for (const predicate of predicates) {
    if (!matchesKind(predicate.outcome, filter.kind)) continue;
    if (
      code !== undefined &&
      predicate.outcome.kind === 'unknown' &&
      predicate.outcome.unknown.code !== code
    ) {
      continue;
    }
    if (!matchesQuery(predicate, needle)) continue;
    out.push(predicate);
  }
  return out;
}

/** 一趟数完四档（只看 `outcome.kind`，不碰 `stats`——面板传入的可能只是谓词切片） */
export function countPredicates(predicates: readonly PredicateReplay[]): PredicateCounts {
  const counts = { all: 0, unjudged: 0, true: 0, false: 0 };
  for (const { outcome } of predicates) {
    counts.all++;
    if (outcome.kind === 'true') counts.true++;
    else if (outcome.kind === 'false') counts.false++;
    else counts.unjudged++;
  }
  return counts;
}

/**
 * 当前结果下值得显示的档位：`all` 恒在，其余仅 `count > 0`。
 * 顺序固定 `['all','unjudged','true','false']`（零计数只对非 all 生效）。
 */
export function availableFilters(
  counts: ReturnType<typeof countPredicates>,
): PredicateFilterKind[] {
  return FILTER_ORDER.filter((kind) => kind === 'all' || counts[kind] > 0);
}
