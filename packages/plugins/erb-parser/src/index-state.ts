/**
 * 索引状态事实的合成（IDX-STATE，2026-10-19）。
 *
 * 这一模块存在的理由：`currentIndex()` 只能答"有没有索引"，答不出**为什么没有**、
 * **扫了哪几个位置**、**这一轮是不是少扫了一类位置**。铁律 4 要求 inactive 可见，
 * 而"工作区根读不到"那条降级此前只有一声 console `warn`——作者侧零落点。
 *
 * 两条纪律：
 * 1. **形状判据只住这里**（`coverageOf()` 一枚函数）。"只扫了口上根的那棵树"与
 *    "扫全了的那棵树"必须**不同形**，而这个"不同形"由谁判只能有一处——提供方。
 *    消费方（函数树 / 未来的其它面板）读的是 `coverage` 那枚 tag，不许再抄一次
 *    `roots.length === 0` / `available` 的形状比较（`ui-kojo-navigator/tests/
 *    index-state-single-source.test.ts` 按处数守死）。
 * 2. **阶段由数据判出，不由调用方的猜测决定**：`outcome` 只说"这一轮到哪一步了"，
 *    `nothing-to-scan` 与 `ready` 的分界取自 `coverageOf()` 的结果——所以"没扫到位置"
 *    永远不可能被误报成"扫完了"，哪怕两个时刻的 `filesScanned` 都是 0。
 *
 * 零游戏名词（铁律 1）：这里只有泛型来源与计数。
 */

import type {
  ErbIndexCoverage,
  ErbIndexFileFailure,
  ErbIndexPhase,
  ErbIndexState,
  ErbScanSourceFact,
  ErbScanSourceKind,
} from '@kojo/plugin-api';

/** 构建这一轮到了哪一步（**生命周期时刻**，不含形状判断——形状一律问 `coverageOf()`） */
export type IndexOutcome = 'idle' | 'scanning' | 'settled' | 'failed';

/** 提供方内部用的一手读数：一类位置本轮交出了什么（`null` = 读不到） */
export interface SourceReading {
  readonly kind: ErbScanSourceKind;
  /** 读到的根清单；`null` = 本轮读不到这一类位置（服务键缺席 / `roots()` 自己抛） */
  readonly roots: readonly string[] | null;
  /** 读不到时的原始原因（逐字进悬停，不当第一眼） */
  readonly reason?: string;
}

/**
 * 读数 → 事实（把"读不到"写成**事实**而不是 0）。
 * 输入顺序即输出顺序，故 `sources` 与调用方陈述的顺序一致（project 在前）。
 */
export function sourceFactsOf(readings: readonly SourceReading[]): ErbScanSourceFact[] {
  return readings.map((r) =>
    r.roots === null
      ? { source: r.kind, offered: 0, available: false, ...(r.reason === undefined ? {} : { reason: r.reason }) }
      : { source: r.kind, offered: r.roots.length, available: true },
  );
}

/**
 * **唯一的形状判据**（本模块的存在理由）：降级与成功必须不同形，且这一处就是"那一枚函数"。
 *
 * - `rootsWalked <= 0` ⇒ `none`：本轮一个可扫描的位置都没走到（不是"扫完了发现是空的"）；
 * - 有根可走、但**至少一类位置本轮读不到** ⇒ `partial`：这棵树比它能扫的少一类位置；
 * - 其余 ⇒ `full`：该读的都读到了（某来源读到"空清单"不算降级——那就是作者的盘上事实）。
 *
 * 判的是**可用性**而不是条数：`available && offered === 0`（工作区里确实一条根都没授权）
 * 是事实、不是缺席，把它判成降级会把"作者没授权"污蔑成"编辑器读不到"。
 */
export function coverageOf(sources: readonly ErbScanSourceFact[], rootsWalked: number): ErbIndexCoverage {
  if (!(rootsWalked > 0)) return 'none';
  return sources.some((s) => !s.available) ? 'partial' : 'full';
}

/** 合成一枚事实的入参（生命周期时刻 + 提供方在那一刻读到的全部原始数） */
export interface IndexStateSeed {
  readonly outcome: IndexOutcome;
  readonly sources: readonly ErbScanSourceFact[];
  readonly rootsWalked: number;
  readonly filesScanned: number;
  readonly functions: number;
  /**
   * 本轮**走到、但没读进来/没解析出来**的文件全表（IDX-SILENT）。
   * 对外事实的**条数与样本都从这一份派生**（`filesFailed` = 长度，`failures` = 前若干条）——
   * 分两处各记一个数就会漂移成"说 3 个失败、列出 2 条"的假账。
   * 缺省 = 本轮没有失败（在途/未起扫的笔数不该继承上一轮）。
   */
  readonly failures?: readonly ErbIndexFileFailure[];
  readonly error?: string;
}

/**
 * 对外事实里失败样本的**上限**（`ErbIndexState.failures`）。
 * 磁盘级故障会让全树失败（真语料 2,300+ 文件），契约面只带前几条路径供作者定位，
 * 完整条数由 `filesFailed` 承担——这不违铁律 4：**条数一个不少，路径是定位样本**。
 */
export const INDEX_FAILURE_SAMPLES = 5;

/**
 * 裁决（**三态判据的唯一出处**，与 {@link coverageOf} 一道住在本模块）：
 * 收尾那一轮分成三条不同的事实，切分只用提供方手里的读数，消费方一律查表：
 * - 一个根都没走到 ⇒ `nothing-to-scan`（**没地方可扫**）；
 * - 走到了根、名录里 0 条 ⇒ `empty`（**扫了，确实一个函数都没有**）；
 * - 其余 ⇒ `ready`。
 *
 * 前两条在 `filesScanned` 上可能都是 0，却是两句不同的话——这正是"恒显占位文案"
 * 说谎的那个位置，所以这一刀必须由数据形状判出，不能留给调用方猜。
 */
export function phaseOf(outcome: IndexOutcome, coverage: ErbIndexCoverage, functions: number): ErbIndexPhase {
  if (outcome !== 'settled') return outcome;
  if (coverage === 'none') return 'nothing-to-scan';
  return functions > 0 ? 'ready' : 'empty';
}

/**
 * 合成对外事实（提供方**唯一**的构造出口）。
 * 纯函数：同样的输入永远得到同样的输出，落盘/时序都不在这里。
 */
export function indexStateOf(seed: IndexStateSeed): ErbIndexState {
  const coverage = coverageOf(seed.sources, seed.rootsWalked);
  const failures = seed.failures ?? [];
  return {
    phase: phaseOf(seed.outcome, coverage, seed.functions),
    sources: seed.sources,
    rootsWalked: seed.rootsWalked,
    filesScanned: seed.filesScanned,
    functions: seed.functions,
    coverage,
    // 失败面（IDX-SILENT）：条数从全表派生，样本只切前几条——两处同源，不许各记一份
    filesFailed: failures.length,
    ...(failures.length === 0 ? {} : { failures: failures.slice(0, INDEX_FAILURE_SAMPLES) }),
    ...(seed.error === undefined ? {} : { error: seed.error }),
  };
}

/** 还没有过任何一轮扫描（插件刚激活 / 项目关闭后复位） */
export function idleIndexState(): ErbIndexState {
  return indexStateOf({ outcome: 'idle', sources: [], rootsWalked: 0, filesScanned: 0, functions: 0 });
}
