/**
 * 整项目诊断扫描的**装配 + 调度**（接线批，2026-10-20）。
 *
 * 上一批把采集器（`project-diagnostics.ts`）与分簇账（`problem-store.ts`）做成了纯逻辑，
 * 但没有任何一处叫它 ⇒ 项目级那一格永远 `idle`，用户看到的仍是旧世界。本模块补的就是
 * "谁在什么时机叫 `run()`"这半条腿，并把它收在**唯一一处**：
 *
 * - **调度判据只许一份**：所有触发都收在 `mountProjectScan` 这一处，挂在六条既有通路上
 *   （内核总线 `project.opened` / `project.closed` / `kojo.functionChanged` / `file.changed` /
 *   `editor.cursorMoved` / `editor.documentChanged`）加问题账自己的订阅；别处（App / EditorPane /
 *   各面板）一律不许再写 `setTimeout` 轮询或另立触发条件；
 * - **进度不另造状态**：跑了多少、跑不完、失败，全部由采集器写 `setProjectScanCoverage`，
 *   面板那句话（`PROBLEM_SCOPE`）即取该读数——本模块不持有第二份进度；
 * - **只读**：采集链路里没有任何写路径（`kernel.io.readText` + `walkDir`，一个字节都不写）；
 * - **顺带喂索引**：扫描是唯一知道"未打开文件"原文的腿，读到的 `.kojo2` 原文经本模块的
 *   喂养通道（`onKojo2ProjectFileFeed` / `resetKojo2ProjectFileFeeds`）排队、分拍交给
 *   `kojo2ProjectIndex`；索引实例与 Monaco 归编辑器侧，本模块不订阅、不写盘。
 *
 * ## 三条触发点（缺一不可）与它们挂在哪些既有事件上
 *
 * ① **项目加载完成 + ErbIndex 就绪**：`project.opened` 只负责清账与重新装配（此时索引还没
 *    建好，抢跑就是和索引抢 CPU）；真正的第一轮等 `kojo.functionChanged`（解析器每次索引
 *    构建完成都广播，首建也算），并延后到首帧之后。索引永不就绪的项目（构建失败）由
 *    `INDEX_WAIT_MS` 那一发兜底轮带起来 ⇒ 退化到 `walkDir` 清单，覆盖面照样上屏。
 * ② **复核队列非空**：问题账（`problem-store.subscribe`）变更时读 `rescanPendingCount()`——
 *    关标签 / 卸载由 store 自己记账，这里只读、不清、不轮询。账上本来就没东西的文件关掉时
 *    store 不发通知（没有内容变化），那条也不会漏：每一发整轮都把队列并进自己的清单
 *    （`extraPaths`），所以队列的增长最多活到下一轮，不靠这里补一发轮询。
 * ③ **换项目 / 关项目**：`project.opened`（根变了）与 `project.closed` 都先 `clearProjectScan()`
 *    再重新装配。**`clearAllProblems` 不当项目级清账用**——它只清编辑器那一簇，拿它清项目
 *    会连带抹掉正开着的那些标签的诊断。
 *
 * ## 节流（假时钟可测）
 *
 * 时钟与定时器全从外面递（`now` / `schedule` / `afterFrame`），所以"合批一次""≥60s 一轮"
 * "打字静默期"这些判据都在单测里按假时钟点表跑，不挂真定时器。
 * 整轮请求唯一入口 `requestFullRound`：索引首轮豁免间隔，其余一律 `max(合批窗口, 距上一轮满 60s)`，
 * 且同名定时器只留一发（后到的请求合批进来，不排队、不叠加）。
 * 正在跑时再 `run()` = 新轮**取代**旧轮（世代语义在采集器里）；**唯一的例外**是复核那一轮：
 * 它撞在整轮在跑时只等、不抢——抢了会把整轮剩下的覆盖面冒充成"复核 64/64 已完成"，
 * 那正是假真相（铁律 4）。
 */

import type { Kernel } from '@kojo/kernel';
import type { ErbIndex, ErbParserService, GameProject } from '@kojo/plugin-api';
import { isQuickOpenSourcePath } from './commands';
import { pkey } from './file-tree-ops';
import { isKojo2Path } from './kojo2-open';
import {
  SCAN_MAX_FILES_PER_RUN,
  createProjectScanner,
  filterInsideRoots,
  type ProjectScannerDeps,
  type ScanContributor,
} from './project-diagnostics';
import type { Kojo2ProjectPassOptions } from './kojo2-project-analysis';
import {
  clearProjectScan,
  rescanPendingCount,
  setProjectScanCoverage,
  setProjectScanProblems,
  subscribe as subscribeProblemStore,
  takeRescanPaths,
} from './problem-store';
import { workspaceRootsOf } from './workspace-roots';

/** 装配需要的内核面（测试给假 kernel 只需这几枚；整包 `Kernel` 不该是判据） */
export type ScanKernel = Pick<Kernel, 'bus' | 'io' | 'slots' | 'services' | 'project' | 'compute' | 'workspaces'>;

/** 采集器句柄（类型即采集器的返回形状；测试包一层就得到 run/cancel 的记账面） */
export type ProjectScanRunner = ReturnType<typeof createProjectScanner>;

/** 唯一的延时通道：登记一次延时并交出撤销函数（假时钟测试据此点表） */
export type ScanScheduler = (fn: () => void, ms: number) => () => void;

/** 同一项目两次整轮的最小间隔 */
export const SCAN_FULL_ROUND_MIN_MS = 60_000;
/** 事件风暴的合批窗口：窗口内的多次请求只留一轮 */
export const SCAN_EVENT_COALESCE_MS = 2_000;
/** 复核队列的合批窗口（连续关几张标签只跑一趟） */
export const SCAN_RESCAN_COALESCE_MS = 1_000;
/** 编辑器活跃之后多久才允许起整轮（打字期间不抢主线程） */
export const SCAN_TYPING_QUIET_MS = 2_500;
/** 项目打开之后最多等多久索引广播自己；超时就用退化清单跑第一轮 */
export const SCAN_INDEX_WAIT_MS = 15_000;
/** 一轮从复核队列最多取多少个（剩下的留给下一轮，不一次吞整条队列） */
export const SCAN_RESCAN_TAKE_LIMIT = 64;
/**
 * 项目索引喂养的每拍上限（份）：扫描读到的 `.kojo2` 原文先进队列，
 * 一拍只把这么多份喂给索引（`lex + parse` 的代价），剩下的下一拍再来——
 * 大项目一次喂几千份会把主线程按住，扫描的"不可阻塞 UI"就成空话。
 */
export const KOJO2_INDEX_FEED_CHUNK = 8;

/* ============================== 项目扫描 → 2.0 项目索引：喂养通道 ============================== */

/**
 * 一份文件事实（`text === null` = 文件删除 / 离开项目）。
 *
 * 扫描侧只交它**读到的原文**；"打开中的 model 有未保存文本时以 model 为准"归订阅者
 * （`ui/editor-global-providers.ts` 的 2.0 装配段），本模块不碰 Monaco。
 */
export type Kojo2ProjectFileFeed = (path: string, text: string | null) => void;

const fileFeedListeners = new Set<Kojo2ProjectFileFeed>();
const feedResetListeners = new Set<() => void>();

/** 订阅扫描侧的文件事实；返回退订（订阅方在 2.0 装配段 dispose 时摘掉） */
export function onKojo2ProjectFileFeed(listener: Kojo2ProjectFileFeed): () => void {
  fileFeedListeners.add(listener);
  return () => {
    fileFeedListeners.delete(listener);
  };
}

/** 订阅"旧项目的索引整份作废"（换项目 / 关项目 / 装配卸载）；返回退订 */
export function onKojo2ProjectFileFeedReset(listener: () => void): () => void {
  feedResetListeners.add(listener);
  return () => {
    feedResetListeners.delete(listener);
  };
}

/** 扫描侧投放一份文件事实（无订阅者 = 无人消费，零动作；逐订阅者隔离） */
export function feedKojo2ProjectFile(path: string, text: string | null): void {
  for (const listener of [...fileFeedListeners]) {
    try {
      listener(path, text);
    } catch {
      /* 索引只是增强面：一枚订阅者失手不影响扫描与其它订阅者 */
    }
  }
}

/** 扫描侧宣告旧项目的索引作废（换项目 / 关项目 / 装配卸载） */
export function resetKojo2ProjectFileFeeds(): void {
  for (const listener of [...feedResetListeners]) {
    try {
      listener();
    } catch {
      /* 同上：清空失败不许把项目开闭路径拖炸 */
    }
  }
}

/** 编辑器"从未活跃"的锚：拿 0 当锚会让假时钟（从 0 起算）一开场就被判成"刚打过字" */
const NEVER_ACTIVE_AT = Number.NEGATIVE_INFINITY;

/** `erb.parser` 的服务键（宿主既有取用点，App.tsx 的索引同步 effect 同一把钥匙） */
const ERB_PARSER_SERVICE = 'erb.parser';

export interface MountProjectScanOptions {
  kernel: ScanKernel;
  /** 采集器装配缝（默认真采集器；单测在这里包一层就同时拿到真行为与 run/cancel 记账） */
  createScanner?: (deps: ProjectScannerDeps) => ProjectScanRunner;
  /** 会话级附加根（D1）：根集合与文件监视那条同口径，附加根下的文件也该上账 */
  extraRoots?: () => readonly string[];
  now?: () => number;
  schedule?: ScanScheduler;
  /** 延后到首帧之后（默认 `requestAnimationFrame`，无则 0ms） */
  afterFrame?: (fn: () => void) => void;
  /** 打字判定（默认 = 编辑器活跃台账；单测可直接注入） */
  isTyping?: () => boolean;
  /** 覆盖读数之外的另一句人话（列举整批读炸这种"本轮失败"以外的降级） */
  onNotice?: (message: string) => void;
  /**
   * Kojo 2.0 项目级分析的装配面（**additive**；缺省 = 不跑）。
   *
   * 生产由宿主经 `kojo2ProjectFactory`（LAU-1a 起的按项目形态；旧 `kojo2Project` 一格
   * 仍支持，两者都给时以静态那份为准）注入；惰性 adapter 不进开机静态图。
   * 本模块只**原样透传**给采集器（`scannerDeps`），不读它的字段、不另立默认值——
   * 启用判据 / adapter 形态 / 降级口径都归 `kojo2-project-analysis`。
   */
  kojo2Project?: Kojo2ProjectPassOptions;
  /**
   * 2.0 装配面的**按项目工厂**（additive，LAU-1a；与 {@link MountProjectScanOptions.kojo2Project}
   * 二选一，两者都给时以静态那份为准——既有消费方零改动）。
   *
   * 存在的理由：分析侧把 adapter 解析结果按 **getter 函数实例**缓存（一次装配只装载一次）。
   * adapter 事实改为"按当前项目现取"之后，静态注入的一份装配面会把第一个项目的事实
   * 带到换后的项目上——那正是本批要修的错事实。工厂在每次 `armProject` 时新建装配面
   * ⇒ 新 getter 实例 ⇒ 换项目自然重解析。
   */
  kojo2ProjectFactory?: () => Kojo2ProjectPassOptions;
  /**
   * 项目扫描 → 2.0 项目索引的**喂养口**（additive；缺省 = 模块级通道
   * `feedKojo2ProjectFile`，由编辑器侧的 2.0 装配段订阅并写索引）。
   *
   * 扫描读到的 `.kojo2` 原文、`file.changed` 的增量重读、`unlink` 的删除都经这里；
   * 单测注入 spy / 假索引即可在虚拟文件系统上钉住"未打开文件也进索引"。
   */
  kojo2IndexFeed?: Kojo2ProjectFileFeed;
}

export interface ProjectScanHandle {
  dispose(): void;
  /** 当前装配的项目根（null = 未装配；单测与回报用它核对"装配了几次"） */
  armedRoot(): string | null;
}

const defaultSchedule: ScanScheduler = (fn, ms) => {
  const id = globalThis.setTimeout(fn, Math.max(0, ms));
  return () => globalThis.clearTimeout(id);
};

const defaultAfterFrame = (fn: () => void): void => {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
  if (typeof raf === 'function') raf(() => fn());
  else globalThis.setTimeout(fn, 0);
};

export function mountProjectScan(opts: MountProjectScanOptions): ProjectScanHandle {
  const { kernel } = opts;
  const now = opts.now ?? ((): number => Date.now());
  const schedule = opts.schedule ?? defaultSchedule;
  const afterFrame = opts.afterFrame ?? defaultAfterFrame;
  const buildScanner = opts.createScanner ?? createProjectScanner;

  /* ---------------- 定时器：按名归一（同名只留一发 = 合批的本体） ---------------- */

  const timers = new Map<string, () => void>();
  const arm = (name: string, ms: number, fn: () => void): void => {
    timers.get(name)?.();
    timers.set(
      name,
      schedule(() => {
        timers.delete(name);
        fn();
      }, ms),
    );
  };
  const drop = (name: string): void => {
    timers.get(name)?.();
    timers.delete(name);
  };
  const dropAll = (): void => {
    for (const cancel of timers.values()) cancel();
    timers.clear();
  };

  /* ---------------- 2.0 项目索引喂养：节流队列（与扫描同一条假时钟） ---------------- */

  const feedIndex = opts.kojo2IndexFeed ?? feedKojo2ProjectFile;
  const usesDefaultFeed = opts.kojo2IndexFeed === undefined;
  /** 喂给索引之前先按路径归一键合批（同一份文件一拍只喂最后一次） */
  const feedQueue = new Map<string, { readonly path: string; readonly text: string | null }>();
  /** 本世代已经喂过 / 需要清掉的路径（归一键 → 原文路径；reset 时按这一份撤条） */
  const fedPaths = new Map<string, string>();
  /**
   * 代次：换项目 / 关项目 / 卸载时 +1。旧采集器迟到的读盘结果凭它丢弃，
   * 避免把上一个项目的文本灌进新项目的索引。
   */
  let feedEpoch = 0;

  const enqueueKojo2File = (path: string, text: string | null, epoch = feedEpoch): void => {
    if (epoch !== feedEpoch) return;
    if (typeof path !== 'string' || path.length === 0) return;
    if (!isKojo2Path(path)) return; // 索引只吃 2.0 文件：v1 源文不进这张表
    feedQueue.set(pkey(path), { path, text });
    arm('kojo2Feed', 0, flushKojo2Feed);
  };

  /** 一拍最多喂 {@link KOJO2_INDEX_FEED_CHUNK} 份；还有剩的下一拍接着来（不在同一拍吃完整项目） */
  function flushKojo2Feed(): void {
    let count = 0;
    for (const [key, item] of feedQueue) {
      if (count >= KOJO2_INDEX_FEED_CHUNK) break;
      feedQueue.delete(key);
      count++;
      if (item.text === null) fedPaths.delete(key);
      else fedPaths.set(key, item.path);
      try {
        feedIndex(item.path, item.text);
      } catch {
        /* 索引只是增强面：一次喂养失败不许把扫描链路拖炸 */
      }
    }
    if (feedQueue.size > 0) arm('kojo2Feed', 0, flushKojo2Feed);
  }

  /** `unlink`：排队中的同一路径先撤掉（否则迟到的原文会把删除又写回来） */
  const removeKojo2File = (path: string): void => {
    if (!isKojo2Path(path)) return;
    const key = pkey(path);
    feedQueue.delete(key);
    fedPaths.delete(key);
    try {
      feedIndex(path, null);
    } catch {
      /* 同上 */
    }
  };

  /** `file.changed` 的增量重读（保存 / 外部改动都在这一条；读失败等下一轮扫描） */
  const refillKojo2File = async (path: string): Promise<void> => {
    if (!isKojo2Path(path) || scanner === null) return;
    const epoch = feedEpoch;
    try {
      const text = (await kernel.io.readText(path)).text;
      enqueueKojo2File(path, text, epoch);
    } catch {
      /* 盘上读不到：真删了会另发 unlink；这里不猜 */
    }
  };

  /** 换 / 关项目：先把队列丢掉再宣告旧索引整份作废（迟到读盘结果由 `feedEpoch` 丢弃） */
  const resetKojo2Feed = (): void => {
    feedEpoch++;
    drop('kojo2Feed');
    feedQueue.clear();
    if (usesDefaultFeed) {
      fedPaths.clear();
      resetKojo2ProjectFileFeeds();
      return;
    }
    // 注入的喂养口未必订阅 reset 通道：按本世代喂过的路径逐条交 `null`。
    const paths = [...fedPaths.values()];
    fedPaths.clear();
    for (const path of paths) {
      try {
        feedIndex(path, null);
      } catch {
        /* 逐条隔离 */
      }
    }
  };

  /* ---------------- 宿主读数（全部现问现取，不留影子副本） ---------------- */

  const projectOf = (): GameProject | null => kernel.project.current();

  const indexOf = (): ErbIndex | null =>
    kernel.services.tryGet<ErbParserService>(ERB_PARSER_SERVICE)?.currentIndex() ?? null;

  /** 允许读的根 = 口上根 ∪ 工作区根 ∪ 会话附加根（与文件监视那条同口径；pkey 去重） */
  const rootsOf = (): string[] => {
    const p = projectOf();
    if (!p) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of [...p.kojoPaths, ...workspaceRootsOf(kernel), ...(opts.extraRoots?.() ?? [])]) {
      if (typeof r !== 'string' || r === '') continue;
      const k = pkey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out;
  };

  /**
   * 待扫文件集：索引就绪取索引，否则退化到 `walkDir`。
   *
   * 退化那一路**不复用** `commands.ts` 的 `listSourceFiles`：那条通道刻意把"某个根读不到"
   * 吞成少一批候选（快速打开退化成不全的清单是可接受的），而这里少一批文件会变成
   * "覆盖 1,200/1,200 已完成"的假真相。所以后缀判据仍取单源（`isQuickOpenSourcePath`），
   * 逐根失败自己数：部分失败出一句人话，全部失败**抛**（⇒ 本轮 `status:'failed'` 上屏）。
   */
  async function listScanFiles(): Promise<readonly string[]> {
    const idx = indexOf();
    if (idx !== null) return [...idx.files.keys()];
    const roots = rootsOf();
    const out: string[] = [];
    const failed: string[] = [];
    for (const root of roots) {
      try {
        const entries = await kernel.io.walkDir(root, {
          includeFiles: true,
          includeDirs: false,
          filter: (e) => e.isDirectory || isQuickOpenSourcePath(e.name),
        });
        for (const e of entries) if (!e.isDirectory && isQuickOpenSourcePath(e.name)) out.push(e.path);
      } catch {
        failed.push(root);
      }
    }
    if (failed.length === roots.length && roots.length > 0) {
      throw new Error(`索引未就绪且口上根全部读不到（${failed.length} 个）`);
    }
    if (failed.length > 0) opts.onNotice?.(`整项目扫描少读了 ${failed.length} 个目录：${failed.join('、')}`);
    return out;
  }

  /**
   * 这条路径落不落进**扫描的允许根**。判据直接取采集器那一份（`filterInsideRoots`，
   * 即 `file-tree-ops.isUnderPath` 的逐根判定）——触发侧与读取侧必须是同一把尺子，
   * 这里再 `roots.some(...)` 一遍就是第四份副本。
   */
  const insideScanRoots = (path: string): boolean => filterInsideRoots([path], rootsOf()).allowed.length > 0;

  /** 槽位贡献快照：顺序 = 槽位顺序 = 编辑器那一簇的合并顺序（同一把尺子，不另排） */
  const contributorsOf = (): ScanContributor[] =>
    kernel.slots.query('ui.editor.decorator').map((c) => ({ id: c.id, decorate: c.decorate.bind(c) }));

  function scannerDeps(): ProjectScannerDeps {
    // 本世代采集器的读盘归属：换项目后迟到的结果由 `enqueueKojo2File` 的 epoch 判据丢弃。
    const epoch = feedEpoch;
    // 2.0 装配面：静态那份优先（既有消费方零改动）；工厂形态**每次装配新建**，
    // 换项目 ⇒ 新 getter 实例 ⇒ 分析侧缓存自然重来（LAU-1a 的按项目现取，见字段注释）。
    const kojo2Pass = opts.kojo2Project ?? opts.kojo2ProjectFactory?.();
    return {
      listFiles: listScanFiles,
      roots: rootsOf,
      project: projectOf,
      contributors: contributorsOf,
      // 只读：整条采集链路没有任何写路径（游戏目录整体只读，铁律 5）
      readFile: async (p) => {
        const text = (await kernel.io.readText(p)).text;
        // 扫描是唯一知道"未打开文件"原文的腿：顺手喂给 2.0 项目索引（排队 + 分拍，不阻塞 UI）
        enqueueKojo2File(p, text, epoch);
        return text;
      },
      publish: setProjectScanProblems,
      onCoverage: setProjectScanCoverage,
      extraPaths: () => takeRescanPaths(SCAN_RESCAN_TAKE_LIMIT),
      pendingRescanCount: () => rescanPendingCount(),
      yieldBetween: () => kernel.compute.yieldToMain(),
      maxFiles: SCAN_MAX_FILES_PER_RUN,
      // 原样透传：装配面缺席 ⇒ 采集器连 `.kojo2` 判据都不调（v1 行为逐字不变）
      ...(kojo2Pass === undefined ? {} : { kojo2Project: kojo2Pass }),
    };
  }

  /* ---------------- 调度状态（世代与覆盖读数都在采集器里，这里只留"什么时候叫它"） ---------------- */

  let scanner: ProjectScanRunner | null = null;
  let armed: string | null = null;
  /** 上一次整轮的起点（本项目还没跑过时 = 负无穷 ⇒ 间隔算式自然退化成"只等合批窗口"） */
  let lastFullRoundAt = NEVER_ACTIVE_AT;
  let indexRoundDone = false;
  let lastEditorActivityAt = NEVER_ACTIVE_AT;
  const isTyping = opts.isTyping ?? ((): boolean => now() - lastEditorActivityAt < SCAN_TYPING_QUIET_MS);

  function startFullRound(): void {
    const s = scanner;
    if (s === null) return;
    // 打字中不抢主线程：静默期满再说（这一格延时同样走同名定时器，不叠加）
    if (isTyping()) {
      arm('full', SCAN_TYPING_QUIET_MS, startFullRound);
      return;
    }
    lastFullRoundAt = now();
    indexRoundDone = true;
    void s.run(); // 在跑 ⇒ 这一句就是"取代"（采集器的世代语义），不排队
  }

  /** 整轮请求的唯一入口：索引首轮只等首帧，其余一律"合批窗口"与"距上一轮满 60s"里取更晚的那个 */
  function requestFullRound(bypassInterval: boolean): void {
    if (scanner === null) return;
    if (bypassInterval) {
      afterFrame(() => arm('full', 0, startFullRound));
      return;
    }
    arm('full', Math.max(SCAN_EVENT_COALESCE_MS, SCAN_FULL_ROUND_MIN_MS - (now() - lastFullRoundAt)), startFullRound);
  }

  function startRescanRound(): void {
    const s = scanner;
    if (s === null || rescanPendingCount() === 0) return;
    // 整轮还在跑 ⇒ 这一轮只等不抢（判据见文件头：抢了就把整轮的缺口冒充成复核的"完整"）
    if (s.isRunning()) {
      arm('rescan', SCAN_RESCAN_COALESCE_MS, startRescanRound);
      return;
    }
    if (isTyping()) {
      arm('rescan', SCAN_TYPING_QUIET_MS, startRescanRound);
      return;
    }
    void s.run({ rescanOnly: true });
  }

  /** 编辑器活跃（光标动 / 缓冲变）= 用户在打字：立刻停轮，剩下的部分由覆盖读数自证不完整 */
  function onEditorActivity(): void {
    lastEditorActivityAt = now();
    const s = scanner;
    if (s === null || !s.isRunning()) return;
    s.cancel();
    requestFullRound(false);
  }

  /** 装配 = 先项目级清账再重造采集器（编辑器那一簇零改动） */
  function armProject(project: GameProject): void {
    clearProjectScan();
    dropAll();
    // 换项目（不是首次装配）：旧项目的索引条目整份作废，别让新项目查到上一位的文件
    if (armed !== null) resetKojo2Feed();
    scanner = buildScanner(scannerDeps());
    armed = project.rootDir;
    lastFullRoundAt = NEVER_ACTIVE_AT;
    indexRoundDone = false;
    lastEditorActivityAt = NEVER_ACTIVE_AT;
  }

  function onProjectAppeared(project: GameProject): void {
    if (armed === project.rootDir && scanner !== null) return;
    armProject(project);
    // 第一轮等索引广播自己（`kojo.functionChanged`）；到点没等到就用退化清单跑，覆盖面照样上屏
    arm('indexWait', SCAN_INDEX_WAIT_MS, () => requestFullRound(false));
  }

  const unsubs: (() => void)[] = [
    kernel.bus.on('project.opened', (ev) => onProjectAppeared(ev.project)),
    kernel.bus.on('project.closed', () => {
      scanner?.cancel();
      scanner = null;
      armed = null;
      dropAll();
      clearProjectScan();
      // 索引里的这一项目文件不再属于任何项目：整份撤条（含打开中 model 喂进去的那些）
      resetKojo2Feed();
    }),
    kernel.bus.on('kojo.functionChanged', (ev) => {
      if (scanner === null || ev.projectRoot !== armed) return; // 别的项目的迟到广播不算
      drop('indexWait');
      requestFullRound(!indexRoundDone);
    }),
    kernel.bus.on('file.changed', (ev) => {
      if (scanner === null) return;
      if (!insideScanRoots(ev.path)) return; // 与扫描根同口径：根外的改动不该起整轮
      // 盘上没了 ⇒ 那一格的旧结论就是幽灵诊断，就地销账（空数组 = 撤销扫描簇，store 的判据）
      if (ev.kind === 'unlink') {
        setProjectScanProblems(ev.path, []);
        // 索引同样就地撤条：等到下一轮整扫再删，中间那段时间跨文件引用会落到已删文件上
        removeKojo2File(ev.path);
      } else {
        // 保存 / 外部改动：增量重读这一份（不等 60s 整轮），排队后分拍喂索引
        void refillKojo2File(ev.path);
      }
      requestFullRound(false);
    }),
    kernel.bus.on('editor.cursorMoved', () => onEditorActivity()),
    kernel.bus.on('editor.documentChanged', () => onEditorActivity()),
    // 复核队列由问题账自己记（关标签 / 卸载时）；这里只读它，不轮询、不清空
    subscribeProblemStore(() => {
      if (scanner === null || rescanPendingCount() === 0) return;
      arm('rescan', SCAN_RESCAN_COALESCE_MS, startRescanRound);
    }),
  ];

  // 挂载补真相（与"面板挂载补真相批"同一判据）：项目可能早在订阅之前就开着了
  const already = projectOf();
  if (already) onProjectAppeared(already);

  return {
    dispose(): void {
      for (const un of unsubs) un();
      dropAll();
      scanner?.cancel();
      scanner = null;
      armed = null;
      clearProjectScan();
      // 装配卸载 = 这条喂腿退场：队列丢掉、旧条目撤掉（索引实例本身归编辑器侧清理）
      resetKojo2Feed();
    },
    armedRoot(): string | null {
      return armed;
    },
  };
}
