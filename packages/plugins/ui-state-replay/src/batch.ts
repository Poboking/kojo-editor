/**
 * 状态回放**批量体检**（纯逻辑：零 React、零 IO、零服务依赖）。
 *
 * 单函数回放回答的是「这一段在当前存档下走不走」；但作者真正要问的常常是
 * 「这个档、我这个角色，**哪些段落我判不出来**」。本模块提供批量回放编排：
 * 逐个 `await` 回放一组函数名（**串行**——不把主线程 / 引擎服务打爆），
 * 边跑边报进度、可取消、可限额，最后汇总成三档分布 + 「最该看的段落」列表。
 *
 * 口径（写清楚，免得消费方各自解读）：
 *
 * - **计数语义**（`summarizeBatch`）：`exact / partial / unknown` 按
 *   `FunctionReplay.confidence` **原样**计数（不重算、不修正——判定权在引擎）；
 *   `totalPredicates` / `unknownPredicates` 分别是各行 `stats.total` / `stats.unknown`
 *   之和；`unknownRatio = total > 0 ? unknown / total : 0`（无谓词的函数按 0 处理，
 *   与契约「total = 0 → exact」同向）。
 * - **行上的名字**一律是**请求名**（作者输入 / 索引给出的那个），不回填
 *   `replay.normalizedName`：回填后调用方拿它再回放可能对不上同一把索引键。
 * - **`rows` 是最该看的、不是全量**：按 `unknownRatio` 降序 → `unknown` 数降序 →
 *   名字升序（code point）排序后**截断 30 条**。`unknown = 0` 的行**不剔除**——
 *   「这些段落可判」本身也是作者要的信息；它们只是排序靠后，行数富余时才会入选。
 *   全量口径看 `scanned` / 各计数，别拿 `rows.length` 当已扫描数。
 * - **取消 / 上限 / 空列表 / 全部 null 都不抛错**：各自给出显式结果。
 * - **上限**（`cap`，缺省 1500）只回放前 N 个名字；未回放的差额记在
 *   `summary.remaining`，`requested` 仍是**请求数**（不是实际回放数）。
 */

import type { FunctionReplay } from '@kojo/plugin-api';

/** 「最该看的段落」列表长度上限（排序后截断；为省渲染，不是数据丢失） */
export const BATCH_WORST_LIMIT = 30;

/** 每处理多少个函数让出一次事件循环（缺省；不受控实现会卡住 UI） */
export const BATCH_DEFAULT_YIELD_EVERY = 25;

/** 单次体检回放的函数数上限（缺省；超出只回放前 N 个） */
export const BATCH_DEFAULT_CAP = 1500;

/** 一行体检结果（一个函数名 + 一次成功回放的摘要投影） */
export interface BatchRow {
  /** 请求名（作者输入 / 索引键；见模块头「行上的名字」口径） */
  readonly name: string;
  /** 引擎给的置信度三档，原样透传 */
  readonly confidence: FunctionReplay['confidence'];
  /** 该函数谓词总数（`stats.total`） */
  readonly total: number;
  /** 命中数（`stats.hit`） */
  readonly hit: number;
  /** 未命中数（`stats.miss`） */
  readonly miss: number;
  /** 判不出数（`stats.unknown`） */
  readonly unknown: number;
  /** 判不出占比 = `total > 0 ? unknown / total : 0` */
  readonly unknownRatio: number;
}

/**
 * 全部已扫描行的聚合计数（`summarizeBatch` 的口径）。
 *
 * 单独成类型是为了让调用方能**预聚合**：例如上层只把「最该看的 30 条」交给
 * `summarizeBatch` 渲染，却仍要全量计数时，用 `summaryOf` 传进来覆盖。
 */
export interface BatchTally {
  /** 实际回放成功数（= 全量行数） */
  readonly scanned: number;
  readonly exact: number;
  readonly partial: number;
  readonly unknown: number;
  /** 全量 `stats.total` 之和 */
  readonly totalPredicates: number;
  /** 全量 `stats.unknown` 之和 */
  readonly unknownPredicates: number;
}

/** 批量体检汇总（面板顶部读数 / “最该看的段落”列表的来源） */
export interface BatchSummary {
  /** 请求回放的函数数（= `names.length`，含被 cap 截掉的） */
  readonly requested: number;
  /** 实际回放成功数（replay 返回非 null 的个数） */
  readonly scanned: number;
  /** 回放返回 null / 抛错的函数数（不存在 / 无索引 / 单次失败） */
  readonly missing: number;
  /** 置信度 `exact` 的函数数 */
  readonly exact: number;
  /** 置信度 `partial` 的函数数 */
  readonly partial: number;
  /** 置信度 `unknown` 的函数数 */
  readonly unknown: number;
  /** 各成功行 `stats.total` 之和 */
  readonly totalPredicates: number;
  /** 各成功行 `stats.unknown` 之和 */
  readonly unknownPredicates: number;
  /** 「最该看的段落」：排序后截断 {@link BATCH_WORST_LIMIT} 条（口径见模块头） */
  readonly rows: readonly BatchRow[];
  /** 是否被取消（`true` = 提前收尾，已扫描部分照常汇总） */
  readonly cancelled: boolean;
  /** 因 `cap` 未回放的函数数（0 = 没有截断） */
  readonly remaining: number;
}

/** `summarizeBatch` 的附加输入（requested / missing / cancelled 由编排层提供） */
export interface BatchSummaryExtra {
  /** 请求回放的函数数 */
  readonly requested: number;
  /** 回放返回 null / 抛错的函数数 */
  readonly missing: number;
  /** 是否被取消 */
  readonly cancelled: boolean;
  /** 因 cap 未回放的函数数（缺省 0） */
  readonly remaining?: number;
  /**
   * 全量计数覆盖：`rows` 只是「最该看的」子集、而计数要覆盖全部已扫描行时用。
   * 缺省 = 从传入的 `rows` 现算。
   */
  readonly summaryOf?: BatchTally;
}

/** `runBatchReplay` 的依赖（全部注入 ⇒ 纯编排，单测用合成 replay 即可） */
export interface BatchRunDeps {
  /** 要体检的函数名（按给定顺序回放；cap 只取前 N 个） */
  readonly names: readonly string[];
  /** 单函数回放（返回 null = 不存在 / 无索引；抛错按 null 处理，不中断整批） */
  replay(name: string): Promise<FunctionReplay | null>;
  /** 每处理完一个函数调用一次（含失败 / 抛错的那个；取消前已处理的都会报） */
  onProgress?(done: number, total: number): void;
  /** 是否已被取消（为真时**当前循环收尾**并置 `cancelled: true`） */
  isCancelled?(): boolean;
  /** 每处理多少个让出一次事件循环（缺省 {@link BATCH_DEFAULT_YIELD_EVERY}） */
  readonly yieldEvery?: number;
  /** 单次回放上限（缺省 {@link BATCH_DEFAULT_CAP}；超出只回放前 N 个） */
  readonly cap?: number;
}

/* ------------------------------- 工具 ------------------------------- */

/** 正整数下限（非法 / 0 / 负数 → 缺省值） */
function positiveIntOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n >= 1 ? n : fallback;
}

/** cap 归一：非法 → 缺省；负数 → 0（明确“一个都不回放”，而不是偷偷回退到缺省） */
function capOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/** 让出一次事件循环（宏任务；比 `queueMicrotask` 更能让出渲染帧） */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** 单行投影（请求名 + 引擎结果的只读投影；不重算任何判定） */
export function rowFromReplay(name: string, replay: FunctionReplay): BatchRow {
  const { total, hit, miss, unknown } = replay.stats;
  return {
    name,
    confidence: replay.confidence,
    total,
    hit,
    miss,
    unknown,
    unknownRatio: total > 0 ? unknown / total : 0,
  };
}

/** 从一组行现算全量计数 */
function tallyRows(rows: readonly BatchRow[]): BatchTally {
  let exact = 0;
  let partial = 0;
  let unknown = 0;
  let totalPredicates = 0;
  let unknownPredicates = 0;
  for (const row of rows) {
    if (row.confidence === 'exact') exact += 1;
    else if (row.confidence === 'partial') partial += 1;
    else unknown += 1;
    totalPredicates += row.total;
    unknownPredicates += row.unknown;
  }
  return { scanned: rows.length, exact, partial, unknown, totalPredicates, unknownPredicates };
}

/**
 * 「最该看的」排序键（纯函数、全序比较）：
 * `unknownRatio` 降序 → `unknown` 数降序 → 名字升序（code point，不用
 * `localeCompare`——体检结果不该随系统语言变顺序）。
 */
export function compareBatchRows(a: BatchRow, b: BatchRow): number {
  if (a.unknownRatio !== b.unknownRatio) return b.unknownRatio - a.unknownRatio;
  if (a.unknown !== b.unknown) return b.unknown - a.unknown;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/**
 * 汇总一组体检行（纯函数）。
 *
 * - 计数从**传入的全部 rows** 现算（不因截断而丢口径），也可用
 *   `extra.summaryOf` 覆盖（见 {@link BatchTally}）；
 * - 输出 `rows` 是 {@link compareBatchRows} 排序后的前 {@link BATCH_WORST_LIMIT} 条；
 * - `remaining` / `cancelled` 原样透传。
 */
export function summarizeBatch(rows: readonly BatchRow[], extra: BatchSummaryExtra): BatchSummary {
  const tally = extra.summaryOf ?? tallyRows(rows);
  const worst = [...rows].sort(compareBatchRows).slice(0, BATCH_WORST_LIMIT);
  return {
    requested: extra.requested,
    scanned: tally.scanned,
    missing: extra.missing,
    exact: tally.exact,
    partial: tally.partial,
    unknown: tally.unknown,
    totalPredicates: tally.totalPredicates,
    unknownPredicates: tally.unknownPredicates,
    rows: worst,
    cancelled: extra.cancelled,
    remaining: extra.remaining ?? 0,
  };
}

/* ------------------------------ 编排 ------------------------------ */

/**
 * 批量回放编排（串行 + 可取消 + 可限额）。
 *
 * 逐条 `await replay(name)`：一次只压一个回放请求，避免把引擎服务 / 主线程打爆。
 * 每个函数处理完（**无论成功、返回 null 还是抛错**）都调一次 `onProgress`；
 * 每处理 `yieldEvery` 个让出一次宏任务（缺省 25）——一次性 1500 个串行
 * `await` 虽不阻塞，但连续同步投影 + 面板重渲染仍需给浏览器喘息。
 *
 * 取消在**每个函数开始前**检查：`isCancelled()` 为真则不再发起新的回放，
 * 已完成的照常汇总并置 `cancelled: true`。单个函数抛错只算 `missing`，不中断。
 *
 * @returns 汇总结果；**任何输入都不抛错**（空列表 / cap = 0 / 全部 null 均有明确结果）。
 */
export async function runBatchReplay(deps: BatchRunDeps): Promise<BatchSummary> {
  const requested = deps.names.length;
  const cap = capOr(deps.cap, BATCH_DEFAULT_CAP);
  const target = Math.min(requested, cap);
  const yieldEvery = positiveIntOr(deps.yieldEvery, BATCH_DEFAULT_YIELD_EVERY);
  const rows: BatchRow[] = [];
  let missing = 0;
  let cancelled = false;

  for (let i = 0; i < target; i += 1) {
    if (deps.isCancelled?.() === true) {
      cancelled = true;
      break;
    }
    const name = deps.names[i]!;
    let replay: FunctionReplay | null = null;
    try {
      replay = await deps.replay(name);
    } catch {
      // 单函数失败（不存在 / 解析炸 / 服务抖动）不拖垮整批：记 missing，进度照走
      replay = null;
    }
    if (replay === null || replay === undefined) {
      missing += 1;
    } else {
      rows.push(rowFromReplay(name, replay));
    }
    const done = i + 1;
    // 进度 total 用「本次实际会回放的上限数」：cap 截断时不会停在 x/2000 的假进度
    deps.onProgress?.(done, target);
    if (done < target && done % yieldEvery === 0) await yieldToEventLoop();
  }

  return summarizeBatch(rows, {
    requested,
    missing,
    cancelled,
    remaining: requested - target,
  });
}
