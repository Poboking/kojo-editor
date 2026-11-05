/**
 * 状态回放**整档扫描**（纯逻辑：零 React、零 IO、零服务依赖）。
 *
 * `batch.ts` 回答的是「这个角色的这批段落哪些判不出」；本模块把它抬到**整份存档**：
 * 按 `characters` 顺序遍历全部角色，逐段回放、逐角色汇总，最后按「未知占比」排序，
 * 让作者一眼看出「这套口在这档上到底哪些角色 / 段落最判不出」。
 *
 * ## 口径（与 `batch.ts` 同源，不另立）
 *
 * - 每段一行 {@link BatchRow} 由 `rowFromReplay` 投影；每角色的 `exact / partial /
 *   unknown` 计数直接取 `summarizeBatch` 的 tally（按 `FunctionReplay.confidence`
 *   原样计数，不重算、不修正）。
 * - `worst` 就是 `summarizeBatch` 返回的 `rows`——它内部已按 `compareBatchRows`
 *   排序并截断 `BATCH_WORST_LIMIT`（30 条），本模块不另写比较器。
 * - 本模块的 `total` 是**实际回放的段数**（不是谓词数）：成功回放的段数 + 抛错
 *   记 `unknown` 的段数；`exact + partial + unknown === total` 恒成立。
 * - `replayFor` 返回 `null`（函数不存在 / 无索引）**不计入** `total` 与各档计数，
 *   与 `batch.ts` 的 `missing` 口径同向；但它照常**消耗预算、推进进度**，并记在
 *   `row.missing`（additive 可选字段，方便消费方显示「回放不了 N 段」）。
 * - `replayFor` 抛错 → 该段记 `unknown` 并继续（不中断整档）；它没有 `BatchRow`，
 *   因此不进 `worst`，只进计数。
 *
 * ## 预算（顺序耗尽）
 *
 * 先按 `perCharCap`（缺省 20）把每个角色截到「前 N 段」，再按 `totalCap`
 * （缺省 2000）**顺序耗尽**：按 `characters` 给定顺序逐角色回放，轮到谁就用剩下
 * 的预算，用完即止——**不做跨角色均摊**。理由：均摊会让「角色多 → 每角色只扫
 * 一两段」，整档扫描最该先看的恰恰是排在前面的角色；顺序耗尽语义单一、可预测，
 * 且与 `characters` 的展示顺序一致。完全没轮到的角色数记在 `skippedChars`。
 * `cap = min(totalCap, totalFunctions)` 是本次**实际生效**的总预算，也是进度条的
 * `total`（不会停在 x/2000 的假进度）。
 *
 * 「前 N 段」按 `namesFor` 返回的**名字顺序**取前 N：本模块拿不到「状态依赖」信息，
 * 重排会让「这次扫了哪几段」随实现变化而漂移，作者无法复现。要优先扫某几段，
 * 由调用方在 `namesFor` 里决定顺序。
 *
 * ## 排序
 *
 * `rows` 按**未知占比降序**（`total > 0 ? unknown / total : 0`；注意是**段级**占比，
 * 不是谓词级）→ `charaNo` 升序（同分稳定）→ 名字升序（code point，与
 * `compareBatchRows` 同一口径）。没有段落的角色占比按 0 处理、排最后。
 *
 * ## 取消 / 异常 / 性能
 *
 * - 取消：**每段开始前**读一次 `shouldCancel()`；为真则不再发起新回放，已扫部分
 *   照常汇总并置 `cancelled: true`（未轮到的角色计入 `skippedChars`）。
 * - 进度：每 `yieldEvery` 段回调一次 `onProgress(done, total, charaNo)`，**最后
 *   一段必发**；取消收尾时补发一次，保证进度条停在真实位置（序列单调不减）。
 * - 每 `yieldEvery` 段让出一次宏任务（Node：`setImmediate`；浏览器：`MessageChannel`；
 *   兜底 `setTimeout 0`），让浏览器能画进度。不用 `setTimeout` 当主路径：部分环境
 *   有 4–15ms 的定时器地板，1000 段 × 每 25 段让出一次会被硬生生拖慢几百毫秒。
 * - 全程线性：每角色只对自己的行排序一次（`summarizeBatch`，O(m log m)，m ≤ cap），
 *   1000 段量级无 O(n²)。
 * - `elapsedMs` 用注入的 `now()` 取（缺省 `Date.now`），测试可确定性断言。
 */

import type { FunctionReplay } from '@kojo/plugin-api';
import { rowFromReplay, summarizeBatch, type BatchRow } from './batch';

/** 每角色最多回放多少段（缺省；按 `namesFor` 的名字顺序取前 N） */
export const ARCHIVE_SCAN_DEFAULT_PER_CHAR_CAP = 20;

/** 整档一次扫描的总预算上限（缺省；按 `characters` 顺序耗尽） */
export const ARCHIVE_SCAN_DEFAULT_TOTAL_CAP = 2000;

/** 每处理多少段让出一次事件循环 / 回调一次进度（缺省） */
export const ARCHIVE_SCAN_DEFAULT_YIELD_EVERY = 25;

/**
 * 单段回放超时（缺省 2s；2026-11-05 边界批）。
 *
 * 为什么必须有：真机冒烟在整档体检上撞到过「300s 只推进 25 段」——某个角色的视图
 * 或某段回放**不 resolve**（病态函数 / 存档里没有该角色），串行扫描就被一段拖死。
 * 超时后该段记 `unknown`（与抛错同口径）并继续；同一角色连续超时两次即放弃该角色
 * 剩余段落（视图坏掉时不必再等 N 次超时）。
 */
export const ARCHIVE_SCAN_DEFAULT_SEGMENT_TIMEOUT_MS = 2000;

/** 整档扫描的墙钟上限（缺省 120s；到点收尾并标 `stoppedReason:'deadline'`） */
export const ARCHIVE_SCAN_DEFAULT_DEADLINE_MS = 120_000;

/** 同一角色连续超时多少次就放弃它剩下的段落（缺省 2） */
export const ARCHIVE_SCAN_MAX_CONSECUTIVE_TIMEOUTS = 2;

/** 整档扫描里的一个角色（`charaNo` 为游戏侧角色号，`name` 为显示名） */
export interface ArchiveScanCharacter {
  charaNo: number;
  name: string;
}

/** 整档扫描的一行（一个角色的回放汇总） */
export interface ArchiveScanRow {
  charaNo: number;
  name: string;
  /** 实际回放的段数（= 成功 + 抛错记 unknown；返回 null 的段不计入） */
  total: number;
  /** 置信度 `exact` 的段数 */
  exact: number;
  /** 置信度 `partial` 的段数 */
  partial: number;
  /** 置信度 `unknown` 的段数（含 `replayFor` 抛错的段） */
  unknown: number;
  /** 该角色最该看的段落（`summarizeBatch` 口径：排序后前 30 条） */
  worst: BatchRow[];
  /** 该角色本档段落总数（已被 `perCharCap` 截断） */
  functionCount: number;
  /**
   * 该角色里 `replayFor` 返回 null 的段数（additive 可选：不存在 / 无索引）。
   * 不计入 `total`，也不消耗 `worst` 名额。
   */
  missing?: number;
  /** 该角色里超时的段数（additive 可选；超时按 `unknown` 计入 `total`） */
  timedOut?: number;
}

/** 整档扫描汇总 */
export interface ArchiveScanSummary {
  /** 按未知占比降序（同分按 `charaNo` 升序） */
  rows: ArchiveScanRow[];
  /** 实际轮到的角色数（含没有段落的角色；`scannedChars + skippedChars === characters.length`） */
  scannedChars: number;
  /** 完全没轮到的角色数（总预算耗尽 / 取消） */
  skippedChars: number;
  /** 实际回放的段数（含返回 null 与抛错的段——它们都占预算、推进进度） */
  replayedFunctions: number;
  /** 参与角色的段落总数（按 `perCharCap` 截断后求和；含被总预算跳过的角色） */
  totalFunctions: number;
  /** 实际生效的总预算 = `min(totalCap, totalFunctions)` */
  cap: number;
  /** 本次扫描耗时（毫秒；用注入的 `now()`） */
  elapsedMs: number;
  /** 是否被取消（`true` = 提前收尾，已扫部分照常汇总） */
  cancelled: boolean;
  /** 超时段数（含抛错之外的"不 resolve"段；它们都按 unknown 计入 `total`） */
  timedOut: number;
  /**
   * 收尾原因：`'cancelled'` = 作者点了取消；`'deadline'` = 撞到墙钟上限；
   * `null` = 正常跑完（或预算耗尽）。消费方据此显示"已取消 / 已达时间上限"。
   */
  stoppedReason: 'cancelled' | 'deadline' | null;
}

/** `runArchiveScan` 的依赖（全部注入 ⇒ 纯编排，单测用合成 replay 即可） */
export interface ArchiveScanOptions {
  /** 要扫描的角色（按给定顺序耗尽预算） */
  characters: readonly ArchiveScanCharacter[];
  /** 取某角色的全部段落名（顺序即回放顺序；`perCharCap` 取前 N） */
  namesFor: (charaNo: number) => readonly string[];
  /** 单段回放（返回 null = 不存在 / 无索引；抛错按 unknown 记，不中断整档） */
  replayFor: (charaNo: number, name: string) => Promise<FunctionReplay | null>;
  /** 每角色最多回放多少段（缺省 {@link ARCHIVE_SCAN_DEFAULT_PER_CHAR_CAP}；0 = 一段都不扫） */
  perCharCap?: number;
  /** 总预算上限（缺省 {@link ARCHIVE_SCAN_DEFAULT_TOTAL_CAP}；0 = 一段都不扫） */
  totalCap?: number;
  /** 每 N 段让出一次宏任务并回调一次进度（缺省 {@link ARCHIVE_SCAN_DEFAULT_YIELD_EVERY}） */
  yieldEvery?: number;
  /** 进度回调（每 `yieldEvery` 段一次 + 末段必发；`charaNo` = 刚处理的那一段所属角色） */
  onProgress?: (done: number, total: number, charaNo: number) => void;
  /** 是否已被取消（为真时**当前段开始前**收尾并置 `cancelled: true`） */
  shouldCancel?: () => boolean;
  /** 注入时钟（缺省 `Date.now`；单测可确定性断言 `elapsedMs`） */
  now?: () => number;
  /** 单段回放超时（缺省 {@link ARCHIVE_SCAN_DEFAULT_SEGMENT_TIMEOUT_MS}；0/非法 = 不超时） */
  segmentTimeoutMs?: number;
  /** 墙钟上限（缺省 {@link ARCHIVE_SCAN_DEFAULT_DEADLINE_MS}；0/非法 = 不限） */
  deadlineMs?: number;
}

/* ------------------------------- 工具 ------------------------------- */

/** 正整数下限（非法 / 0 / 负数 → 缺省值） */
function positiveIntOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n >= 1 ? n : fallback;
}

/** cap 归一：非法 → 缺省；负数 → 0（明确“一个都不扫”，而不是偷偷回退到缺省） */
function capOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/** 让出一次事件循环（宏任务；比 `queueMicrotask` 更能让出渲染帧）。 */
function yieldToEventLoop(): Promise<void> {
  // Node（单测）：setImmediate 是宏任务且无 setTimeout 的定时器地板
  // （本机 Node 24 实测 setTimeout(0) ≈ 15ms/跳，40 跳就能把 1000 段拖慢 600ms）。
  if (typeof setImmediate === 'function') {
    return new Promise<void>((resolve) => setImmediate(resolve));
  }
  // 浏览器：MessageChannel 是宏任务、不被 4ms 钳制（React scheduler 同款让出手段），
  // 浏览器会在两个宏任务之间给渲染机会，进度条照常能画。
  //
  // **必须用 `onmessage`（或显式 `port1.start()`）**：只挂 `addEventListener` 时
  // MessagePort 不进入 active 状态、永不投递，Promise 永不 resolve ⇒ 整档体检在真机
  // 第 25 段第一次让出就永久卡死（Node 单测走 setImmediate 分支，单测全绿而真机死——
  // 2026-11-05 真机冒烟实测：进度停在 25/2000 段，300s 不动）。
  if (typeof MessageChannel === 'function') {
    return new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.addEventListener('message', () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      });
      // 显式 start()：只挂监听不 start，端口不投递（这正是真机卡死的根因）
      channel.port1.start();
      channel.port2.postMessage(0);
    });
  }
  // 兜底：极旧环境
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** 段级未知占比（`total = 0` → 0，与 `BatchRow.unknownRatio` 同向） */
function unknownRatioOf(row: ArchiveScanRow): number {
  return row.total > 0 ? row.unknown / row.total : 0;
}

/**
 * 整档行的排序键（纯函数、全序比较）：
 * 未知占比降序 → `charaNo` 升序 → 名字升序（code point，不用 `localeCompare`）。
 * `charaNo` 已能定序；名字只作同一 `charaNo` 重复出现时的兜底，保证结果确定。
 */
export function compareArchiveScanRows(a: ArchiveScanRow, b: ArchiveScanRow): number {
  const ratioA = unknownRatioOf(a);
  const ratioB = unknownRatioOf(b);
  if (ratioA !== ratioB) return ratioB - ratioA;
  if (a.charaNo !== b.charaNo) return a.charaNo - b.charaNo;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/* ------------------------------ 编排 ------------------------------ */

/**
 * 给一个 Promise 套墙钟超时（`ms <= 0` = 不超时）。
 * 返回 `'timeout'` 标记而不是抛错：调用方要把它记成 `unknown` 继续扫，不是中断整档。
 * 超时后原 Promise 仍会跑完（无法取消），但其结果被丢弃——整档体检是只读的，安全。
 */
async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 整档扫描编排（串行 + 可取消 + 双预算）。
 *
 * 逐段 `await replayFor(charaNo, name)`：一次只压一个回放请求，避免把引擎服务 /
 * 主线程打爆。每个角色扫完立刻用 `summarizeBatch` 汇总（计数 + `worst`），
 * 最后统一排序返回。
 *
 * @returns 汇总结果；**空角色表 / 空段落 / 预算 0 都有明确结果**。
 */
export async function runArchiveScan(opts: ArchiveScanOptions): Promise<ArchiveScanSummary> {
  const clock = opts.now ?? Date.now;
  const startedAt = clock();
  const perCharCap = capOr(opts.perCharCap, ARCHIVE_SCAN_DEFAULT_PER_CHAR_CAP);
  const totalCap = capOr(opts.totalCap, ARCHIVE_SCAN_DEFAULT_TOTAL_CAP);
  const yieldEvery = positiveIntOr(opts.yieldEvery, ARCHIVE_SCAN_DEFAULT_YIELD_EVERY);
  const segmentTimeoutMs =
    opts.segmentTimeoutMs === undefined || !Number.isFinite(opts.segmentTimeoutMs) || opts.segmentTimeoutMs <= 0
      ? ARCHIVE_SCAN_DEFAULT_SEGMENT_TIMEOUT_MS
      : Math.floor(opts.segmentTimeoutMs);
  const deadlineMs =
    opts.deadlineMs === undefined || !Number.isFinite(opts.deadlineMs) || opts.deadlineMs <= 0
      ? ARCHIVE_SCAN_DEFAULT_DEADLINE_MS
      : Math.floor(opts.deadlineMs);

  // 名字只取一次并按 perCharCap 截断（顺序 = namesFor 给的顺序，取前 N）
  const allNames = opts.characters.map((ch) => opts.namesFor(ch.charaNo));
  const namesByChar = allNames.map((names) => names.slice(0, perCharCap));
  let totalFunctions = 0;
  for (const names of namesByChar) totalFunctions += names.length;
  const cap = Math.min(totalCap, totalFunctions);

  const rows: ArchiveScanRow[] = [];
  let replayed = 0;
  let scannedChars = 0;
  let cancelled = false;
  /** 撞墙钟上限（与作者取消区分；收尾原因写进 summary） */
  let stoppedReason: 'deadline' | null = null;
  let lastReported = -1;
  let lastCharaNo = 0;

  for (let ci = 0; ci < opts.characters.length; ci += 1) {
    const ch = opts.characters[ci]!;
    const names = namesByChar[ci]!;
    // 预算耗尽：本角色（还有段落的话）及之后全部没轮到。没有段落的角色不花预算，
    // 仍算“轮到”（见下方 scannedChars 口径）。`perCharCap = 0` 时所有有段落的
    // 角色都会走到这里（cap = 0），与 `totalCap = 0` 同义：一段都不扫。
    if (allNames[ci]!.length > 0 && replayed >= cap) break;

    const take = Math.min(names.length, cap - replayed);
    const charRows: BatchRow[] = [];
    let attempted = 0;
    let missing = 0;
    let failed = 0;
    let timedOut = 0;
    let consecutiveTimeouts = 0;

    for (let i = 0; i < take; i += 1) {
      if (opts.shouldCancel?.() === true) {
        cancelled = true;
        break;
      }
      // 墙钟上限：到点收尾（病态段落靠单段超时兜，但角色/视图层面还有整批慢的形态）
      if (clock() - startedAt >= deadlineMs) {
        stoppedReason = 'deadline';
        break;
      }
      const name = names[i]!;
      attempted += 1;
      replayed += 1;
      lastCharaNo = ch.charaNo;

      let replay: FunctionReplay | null = null;
      let threw = false;
      try {
        const raced = await raceTimeout(opts.replayFor(ch.charaNo, name), segmentTimeoutMs);
        if (raced === 'timeout') {
          // 单段超时：记 unknown（与抛错同口径），继续扫下一段
          threw = true;
          timedOut += 1;
          consecutiveTimeouts += 1;
        } else {
          replay = raced;
          consecutiveTimeouts = 0;
        }
      } catch {
        // 单段失败（解析炸 / 服务抖动）不拖垮整档：记 unknown，进度照走
        threw = true;
        consecutiveTimeouts = 0;
      }
      if (threw) {
        failed += 1;
      } else if (replay === null || replay === undefined) {
        missing += 1;
      } else {
        charRows.push(rowFromReplay(name, replay));
      }

      const done = replayed;
      // 每 yieldEvery 段回调一次；末段（done === cap）必发，避免进度条停在中间
      if (done === cap || done % yieldEvery === 0) {
        opts.onProgress?.(done, cap, ch.charaNo);
        lastReported = done;
      }
      if (done < cap && done % yieldEvery === 0) await yieldToEventLoop();

      // 同一角色连续超时 N 次 = 该角色的视图/引擎通道坏了：剩下的段不必再等 N 次超时
      if (consecutiveTimeouts >= ARCHIVE_SCAN_MAX_CONSECUTIVE_TIMEOUTS) break;
    }

    // 只有「真的尝试过至少一段」或「本角色没有段落」才算轮到；取消恰好落在首段前
    // 的角色不算（它一段都没扫，归入 skippedChars）。
    if (attempted > 0 || names.length === 0) {
      const tally = summarizeBatch(charRows, { requested: attempted, missing: 0, cancelled: false });
      rows.push({
        charaNo: ch.charaNo,
        name: ch.name,
        total: tally.scanned + failed,
        exact: tally.exact,
        partial: tally.partial,
        unknown: tally.unknown + failed,
        // summarizeBatch 的 rows 即 compareBatchRows 排序 + BATCH_WORST_LIMIT 截断的结果
        worst: [...tally.rows],
        functionCount: names.length,
        missing,
        timedOut,
      });
      scannedChars += 1;
    }

    if (cancelled || stoppedReason !== null) break;
  }

  // 取消 / 到点收尾补发一次进度（单调不减；已发过末段就不重复）
  if ((cancelled || stoppedReason !== null) && replayed > 0 && lastReported < replayed) {
    opts.onProgress?.(replayed, cap, lastCharaNo);
  }

  const elapsedMs = Math.max(0, clock() - startedAt);
  rows.sort(compareArchiveScanRows);
  let timedOutTotal = 0;
  for (const r of rows) timedOutTotal += r.timedOut ?? 0;
  return {
    rows,
    scannedChars,
    skippedChars: opts.characters.length - scannedChars,
    replayedFunctions: replayed,
    totalFunctions,
    cap,
    elapsedMs,
    cancelled,
    timedOut: timedOutTotal,
    stoppedReason: cancelled ? 'cancelled' : stoppedReason,
  };
}
