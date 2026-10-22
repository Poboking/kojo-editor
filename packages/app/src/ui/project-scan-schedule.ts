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
 * - **只读**：采集链路里没有任何写路径（`kernel.io.readText` + `walkDir`，一个字节都不写）。
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
   * 生产由宿主经 `installKojo2ProjectScan()` 注入（惰性 adapter，不进开机静态图）；
   * 本模块只**原样透传**给采集器（`scannerDeps`），不读它的字段、不另立默认值——
   * 启用判据 / adapter 形态 / 降级口径都归 `kojo2-project-analysis`。
   */
  kojo2Project?: Kojo2ProjectPassOptions;
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
    return {
      listFiles: listScanFiles,
      roots: rootsOf,
      project: projectOf,
      contributors: contributorsOf,
      // 只读：整条采集链路没有任何写路径（游戏目录整体只读，铁律 5）
      readFile: (p) => kernel.io.readText(p).then((t) => t.text),
      publish: setProjectScanProblems,
      onCoverage: setProjectScanCoverage,
      extraPaths: () => takeRescanPaths(SCAN_RESCAN_TAKE_LIMIT),
      pendingRescanCount: () => rescanPendingCount(),
      yieldBetween: () => kernel.compute.yieldToMain(),
      maxFiles: SCAN_MAX_FILES_PER_RUN,
      // 原样透传：装配面缺席 ⇒ 采集器连 `.kojo2` 判据都不调（v1 行为逐字不变）
      ...(opts.kojo2Project === undefined ? {} : { kojo2Project: opts.kojo2Project }),
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
      if (ev.kind === 'unlink') setProjectScanProblems(ev.path, []);
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
    },
    armedRoot(): string | null {
      return armed;
    },
  };
}
