/**
 * 约定校验引擎（游戏无关）。
 *
 * 职责：装配规则 → **按 `scope` 分流**运行 → 归一化/去重/排序 → 汇总报告 → 通知订阅者。
 * 规则来源：
 *   - 内置通用规则（本插件自带，零游戏知识）；
 *   - 当前适配器的 `conventions`（游戏知识，注入回调提供）。
 *
 * 两档粒度（2026-10-12「按文件增量」批）：
 *   - `scope:'project'`（缺省）：判定依赖跨文件事实 → 每次整项目重算；
 *   - `scope:'file'`：判定只看单文件 → 引擎按 `ErbIndex.fileMtimes` **逐文件复用上次结论**，
 *     作者改一个 ERB 只重算那一个文件。
 *   逐规则计时实测（真实语料）显示 55% 的成本在一条**纯逐文件**规则上，这就是切分的依据。
 *
 * 稳健性原则（对应内核「不静默」铁律）：
 *   - 单条规则抛错不中断全局 → 记入 `failedRules`，报告中显式呈现；
 *   - 抛错的规则/文件**不进快照**：坏一次不能永久缓存坏结果；
 *   - 声明 `scope:'file'` 却没实现 `checkFile` ⇒ 显式记失败，不静默跳过；
 *   - 文件读取失败 → 记入日志并跳过该规则本次对该文件的判定（不伪造结果）。
 *
 * 可中断（ZH-F4b）：取消只有**一种表达**——调度层在取下一个文件单元前掷 `LintCancelled`。
 * 池子那条路与本地兜底那条路共用这一颗哨兵，所以"收摊"不可能在两处各写各的；
 * `runOnce` 是唯一接住它的地方，接住后照常装配半轮结论并给报告打上 `incomplete`
 * （不写快照、不覆盖订阅者那份完整报告）。
 */

import type {
  CacheExpect,
  ComputePool,
  ConventionCheckContext,
  ConventionIssue,
  ConventionLinterService,
  ConventionPolicy,
  ConventionProjectUnitEntry,
  ConventionReport,
  ConventionRule,
  ConventionRunOptions,
  ConventionSeverity,
  ErbFile,
  ErbIndex,
  GameProject,
  Logger,
} from '@kojo/plugin-api';
import { CONVENTION_SEVERITY_ORDER, isLibraryOnlyPath } from '@kojo/plugin-api';
import { duplicateFunctionRule } from './rules/duplicate-function';
import { sugarStaticConventionsRule } from './rules/sugar-conventions';
import type { LintCache, LintFileBucket, LintUnitEntry } from './snapshot';

/**
 * 逐文件规则的并发上限（沿用规则内部原来的 `mapLimit(…, 12, …)` 口径）。
 * 现在由**引擎**驱动这个循环：桶归引擎持有，规则只描述"一个文件怎么判"。
 */
const LINT_FILE_CONCURRENCY = 12;

/**
 * 分区规则的内存态（PERF-12b）：全局判据 `expect.fingerprint` + 外部输入摘要
 * `partition.key()` 双门，逐文件分区按 `fileMtimes` 复用（与逐文件桶同族判据）。
 * 任一门不符 ⇒ 该规则分区整体弃用重算（fail-closed，绝不拿旧分区配新判据）。
 */
interface RuleUnitState {
  expectFingerprint: string;
  key: string;
  byPath: Map<string, LintUnitEntry>;
}

/** 一条分区规则本轮的执行计划 */
interface PartitionPlan {
  rule: ConventionRule;
  state: RuleUnitState;
  stale: ErbFile[];
  unitsReused: number;
  unitsTotal: number;
  /** 本轮**真算出结论**的文件贡献数（被叫停的一轮用它凑 `incomplete.unitsDone`） */
  unitsComputed: number;
}

/**
 * 让路片预算（ZH-F4）：一轮校验连续占住主线程这么久就交还一次事件循环。
 *
 * 为什么必须是 **macrotask**：`mapLimit` 里每个 `await` 拿到的多是**已 resolve** 的 promise
 * （本轮正文已被批量预取），而微任务链永不交还事件循环 ⇒ 改造前实测（600 棵）整轮 751 ms
 * **一次探针都跑不到**，最长一次占用 = 整轮时长——作者那边就是"界面冻住、按键全排队"。
 *
 * 判据取**时长**而非"每 N 个文件"：文件大小与机器速度都在几百倍范围内漂，数文件等于拿一个
 * 假设去定卡顿。装了内核计算池（生产装配一律装）时这个数由池子执行，缺池才用本地兜底。
 */
const LINT_SLICE_BUDGET_MS = 8;

/** 交还事件循环一次（`setTimeout` 而非微任务：微任务不产生能让输入事件插进来的空隙） */
const yieldToEventLoop = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * 取消的唯一表达（ZH-F4b）：一颗哨兵异常。
 * 掷点在**调度层取下一个单元之前**（见 `makeFileRunner`）⇒ 正在算的那一棵照常算完，
 * 之后的单元一个都不起；业务回调里的 `try/catch`（规则失败口径）碰不到它。
 */
class LintCancelled extends Error {
  constructor() {
    super('本轮校验被叫停');
    this.name = 'LintCancelled';
  }
}

/**
 * 片间取消闸。`signal` 缺席时返回恒不掷哨兵的函数 ⇒ 旧调用（不传取消位）走的分支
 * 与本批之前逐字相同，只是每次取单元前多读一个布尔。
 */
function makeCancelGate(signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  return () => {
    if (signal.aborted) throw new LintCancelled();
  };
}

/**
 * 限并发执行（结果写进调用方的 Map；装配仍按 walk 顺序取 ⇒ 输出与完成顺序无关）。
 * 每个 worker 按 `LINT_SLICE_BUDGET_MS` 让路；只改调度节奏，不改判定与产出顺序。
 *
 * 收摊用 `allSettled` 而不是 `all`：`all` 会在第一个哨兵那里就把还悬着的 worker 丢成
 * 游离 promise ⇒ 它们往 `fresh` 里的写入落在装配之后（同一轮两次读数能给出不同结果）。
 * 等它们把**手上那一棵**算完再抛 ⇒ 已算完的单元一定进这一轮，未起的一定量不进。
 */
async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  gate: () => void,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    let sliceStart = Date.now();
    for (;;) {
      gate();
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i]!);
      if (Date.now() - sliceStart >= LINT_SLICE_BUDGET_MS) {
        await yieldToEventLoop();
        sliceStart = Date.now();
      }
    }
  });
  const settled = await Promise.allSettled(workers);
  const first = settled.find((s) => s.status === 'rejected');
  if (first) throw (first as PromiseRejectedResult).reason;
}

/** 逐文件循环的调度（生产 = 内核计算池的 `runSliced`；缺池时用上面的本地兜底） */
type FileLoop = (items: readonly ErbFile[], fn: (file: ErbFile) => Promise<void>) => Promise<void>;

function makeFileRunner(compute: ComputePool | undefined, gate: () => void): FileLoop {
  if (!compute) return (items, fn) => mapLimit(items, LINT_FILE_CONCURRENCY, gate, fn);
  return (items, fn) =>
    compute
      .runSliced(items, {
        concurrency: LINT_FILE_CONCURRENCY,
        sliceMs: LINT_SLICE_BUDGET_MS,
        priority: 'background',
        label: 'convention.lint',
      }, async (file) => {
        gate();
        await fn(file);
      })
      .then(() => undefined);
}

export interface ConventionEngineDeps {
  log: Logger;
  /**
   * 内核计算池（服务键 `kernel.compute`；ZH-F4，additive 可选）。
   *
   * 给出时逐文件/分区循环由池子按 `sliceMs` 分片并**在片间让出主线程**，同时吃
   * `priority: 'background'` 的仲裁（波浪线 / 补全这类交互档在跑时校验主动让路）。
   * 缺省（纯单测 / 无内核装配）⇒ 退化为本地限并发循环，让路口径同一条。
   */
  compute?: ComputePool;
  /** 当前打开的项目（未打开时 null） */
  getProject(): GameProject | null;
  /** 当前已构建的索引（未就绪时 null） */
  getIndex(): ErbIndex | null;
  /** 读文件纯文本（引擎在一次运行内记忆化） */
  readFile(path: string): Promise<string>;
  /**
   * 批量读文件纯文本（2026-10-16 批量 IO 批；可选）。
   *
   * 提供时：`runOnce` 在跑逐文件规则**之前**把本 run 全部 stale 文件的并集
   * 一次性批量取回（内核 `io.readTexts`——批内一趟 IPC + 会话缓存，
   * 跨 run/跨插件重复校验零读盘），规则循环里 `ctx.readFile` 直接命中预取表。
   * 返回与入参一一对应，失败位为 `null`（不入预取表 ⇒ 落 `readFile` 兜底重试，
   * 再失败即抛错 ⇒ 该文件不留桶——与旧语义逐条一致）。
   * 缺省 / 批量通道整体失败 ⇒ 逐文件 `readFile`（旧行为）。
   */
  readFiles?(paths: readonly string[]): Promise<Array<string | null>>;
  /** 当前激活适配器提供的规则（按 project.adapterId 过滤后的结果） */
  getAdapterRules(): readonly ConventionRule[];
  /** 当前激活适配器的通用规则静默策略（缺省 = 不静默） */
  getAdapterPolicy(): ConventionPolicy | undefined;
  /**
   * 结果快照端口（2026-10-12「体感丝滑」批 →「按文件增量」批；缺省 = 不缓存）。
   *
   * 三层判据各管各的粒度（详见 `./snapshot.ts`）：全局层由插件组装（引擎不懂 adapter 吃了
   * 哪些非 ERB 输入），整项目层比 `ErbIndex.fingerprint`，逐文件层比 `ErbIndex.fileMtimes`。
   * `save` 收到的是**本次实际拿到的结果**（复用 + 新算），且**不含**任何抛错规则/文件的结论。
   */
  snapshot?: {
    expectFor(args: {
      project: GameProject;
      rules: readonly ConventionRule[];
      policy?: ConventionPolicy;
    }): CacheExpect | null;
    load(expect: CacheExpect): Promise<LintCache | null>;
    save(cache: LintCache, expect: CacheExpect): void;
    /**
     * 分区贡献的**独立存储端口**（PERF-12c，additive 可选）。
     *
     * 提供时：盘上的逐文件贡献**不随 `LintCache.projectUnits` 整份装载**——引擎只在
     * "某条分区规则本轮真要建计划"时按 ruleId 懒取那一条；写盘同样按规则分键，
     * 本轮没建计划的规则不碰盘（整包复用轮 ⇒ 贡献零 IO）。`prune` 收到**当前规则集里
     * 所有声明了 `partition` 的 ruleId**（不是本轮建过计划的那批），用于清掉规则改名/
     * 适配器换游戏后留下的孤儿键。
     *
     * 缺省时：沿用 v3 同键形态（贡献随主快照读写），老装配零改动。
     */
    units?: {
      load(ruleId: string, expect: CacheExpect): Promise<{ key: string; units: Record<string, LintUnitEntry> } | null>;
      save(
        ruleId: string,
        state: { key: string; units: Record<string, LintUnitEntry> },
        expect: CacheExpect,
      ): void;
      prune(keepRuleIds: readonly string[]): void;
    };
  };
}

/** 空报告（未打开项目 / 索引未就绪时返回，保证 UI 有稳定数据形状） */
function emptyReport(adapterId: string): ConventionReport {
  const now = Date.now();
  return {
    adapterId,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    issues: [],
    counts: { error: 0, warning: 0, info: 0 },
    ruleCount: 0,
    failedRules: [],
  };
}

function compareIssues(a: ConventionIssue, b: ConventionIssue): number {
  const s = CONVENTION_SEVERITY_ORDER[a.severity] - CONVENTION_SEVERITY_ORDER[b.severity];
  if (s !== 0) return s;
  const r = a.ruleId.localeCompare(b.ruleId);
  if (r !== 0) return r;
  const f = (a.filePath ?? '').localeCompare(b.filePath ?? '');
  if (f !== 0) return f;
  return (a.line ?? 0) - (b.line ?? 0);
}

export class ConventionEngine implements ConventionLinterService {
  private readonly builtinRules: readonly ConventionRule[] = [
    duplicateFunctionRule,
    sugarStaticConventionsRule,
  ];
  private last: ConventionReport | null = null;
  /** 在途运行（自动触发与面板手动重跑叠跑 = 白跑两遍 3.1 s，故共享同一次） */
  private inFlight: Promise<ConventionReport> | null = null;
  private readonly listeners = new Set<(report: ConventionReport | null) => void>();
  /** 分区规则的内存态（ruleId → 状态）；判据不符即弃，见 `RuleUnitState` */
  private readonly unitStates = new Map<string, RuleUnitState>();
  /**
   * 上一轮的 mtime 快照（PERF-12b）：**同引擎实例内**连续运行时用来投机预取——
   * mtime 变过/新增的文件几乎必然就是本轮的 stale 集，让批量读盘与快照装载并行。
   * 只是提前量热，**过期判定仍按装载后的盘上结论**；漏猜的文件走装载后的批量兜底，语义不变。
   * 取不到（新页面 / 新内核 / 判据变了）⇒ 本轮**不投机**，绝不让候选退化成"全库都要重读"
   * （PERF-12c：真语料 2,325 棵上那一退就是每轮 4.1 s 白读，而同轮 reuse 显示零重算）。
   */
  private lastRun: { fingerprint: string; mtimes: Map<string, number | null> } | null = null;
  /**
   * 热缓存（PERF-12b）：本引擎**上一次实际装载/产出**的 `LintCache`（内存镜像，键 =
   * 全局判据）。同一内核里连续运行（开项目→改一棵→重校验）不必再走一趟
   * `snapshot.load` 的异步往返——2,000 棵盘上那次装载在事件循环里被抽取段挤到
   * 数百毫秒。落盘照旧（重启后的冷开仍从盘还原）；`force` 与判据变化一律绕过热缓存。
   */
  private hotCache: { expectFingerprint: string; cache: LintCache } | null = null;

  constructor(private readonly deps: ConventionEngineDeps) {}

  rules(): readonly ConventionRule[] {
    return [...this.builtinRules, ...this.deps.getAdapterRules()];
  }

  report(): ConventionReport | null {
    return this.last;
  }

  subscribe(cb: (report: ConventionReport | null) => void): () => void {
    this.listeners.add(cb);
    cb(this.last);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * 执行全部规则并返回报告（**完整的一轮**才覆盖缓存并通知订阅者）。
   *
   * `force` = **一定真重算**：面板「重新校验」按钮是用户的显式意图，
   * 不该被结果缓存糊住（命中与否都由本次运行落盘最新快照）。
   * `signal` = 叫停这一轮：`run` **照常返回**（不抛）带 `incomplete` 的半轮报告，
   * 既不落盘也不覆盖 `report()`/订阅者手里那份完整结论。
   * 在途合流时后来者的取消位不起作用——那一轮是别人起的（面板那侧由 `driveLintRun`
   * 的"在途不起第二轮"保证同一时刻只有一个取消位）。
   */
  run(opts: ConventionRunOptions = {}): Promise<ConventionReport> {
    if (this.inFlight) return this.inFlight;
    const p = this.runOnce(opts).finally(() => {
      if (this.inFlight === p) this.inFlight = null;
    });
    this.inFlight = p;
    return p;
  }

  private async runOnce(opts: ConventionRunOptions): Promise<ConventionReport> {
    const project = this.deps.getProject();
    const index = this.deps.getIndex();
    if (!project || !index) {
      // 项目关闭不清内存态：重开同一项目（全局判据相同）正是"改一棵"复用的主场；
      // 判据不符的路径由 `expect.fingerprint` 门自然作废（见 `hotCache`/`lastRun` 注释）。
      const rep = emptyReport(project?.adapterId ?? '');
      this.commit(rep);
      return rep;
    }

    const startedAt = Date.now();
    const rules = this.rules();
    const force = opts.force === true;
    /** 取消闸：掷点在调度层（池子与本地兜底共用这一颗哨兵，见 `makeFileRunner`） */
    const gate = makeCancelGate(opts.signal);
    const runFiles = makeFileRunner(this.deps.compute, gate);

    /**
     * 按声明粒度分流。`scope` 缺省 = `'project'`（跨文件语义，只能整项目重算）。
     * 声明 `'file'` 却没实现 `checkFile` 的规则**显式记失败**，不静默跳过——
     * 否则"加了 scope 忘了改实现"会表现成"这条规则什么都没报"，正是本项目的铁律禁止的形态。
     */
    const projectRules = rules.filter((r) => r.scope !== 'file' && typeof r.check === 'function');
    const fileRules = rules.filter((r) => r.scope === 'file');
    const runnableFileRules = fileRules.filter((r) => typeof r.checkFile === 'function');
    const failedRules: { ruleId: string; error: string }[] = rules
      .filter((r) => (r.scope === 'file' ? typeof r.checkFile !== 'function' : typeof r.check !== 'function'))
      .map((r) => ({
        ruleId: r.id,
        error: `scope='${r.scope ?? 'project'}' 但缺 ${r.scope === 'file' ? 'checkFile' : 'check'} 实现（已跳过）`,
      }));

    // 一次运行内的文件读取记忆化：多条规则共享同一份文本（避免重复读 2k+ 文件）
    const textCache = new Map<string, Promise<string>>();
    const checkCtx: ConventionCheckContext = {
      project,
      index,
      readFile: (path: string): Promise<string> => {
        let p = textCache.get(path);
        if (!p) {
          p = this.deps.readFile(path);
          textCache.set(path, p);
        }
        return p;
      },
      log: this.deps.log,
      policy: this.deps.getAdapterPolicy(),
    };

    /** 全局判据（不含 ERB 指纹）；null ⇒ 既不还原也不落盘 */
    const expect = this.deps.snapshot
      ? this.deps.snapshot.expectFor({
          project,
          rules,
          policy: this.deps.getAdapterPolicy(),
        })
      : null;
    // 约定校验面向**作者范围**：基座库（整棵 ERB）虽进了语言服务索引，
    // 但它只读、且常带游戏自带的重复定义/风格差异，逐文件规则不该替它出报告。
    const files = [...index.files.values()].filter((f) => !isLibraryOnlyPath(project, f.path));

    /**
     * 投机预取（PERF-12b → PERF-12c 收窄）：与快照装载**并行**发出批量读盘。
     *
     * 候选**只**取"与本引擎上一轮（`lastRun`）的 mtime 快照相比变过/新增的文件"。
     * `lastRun` 缺失（新载入的页面 / 新内核 / 判据变了）时**一律不投机**——旧写法在这里
     * 退化成"全库候选"，真语料 2,325 棵上每轮白读 4.1 s，而同轮的 `lint reuse` 显示
     * 整条复用 7/7（本轮压根不需要任何正文）。不投机不等于不读：真正要重算的文件
     * 仍由装载后算出的 stale 并集（`restPaths`）一次批取，覆盖面一字未减。
     */
    const specPaths = new Set<string>();
    const warmRun = !force && expect ? this.lastRun : null;
    const specBase = warmRun && expect && warmRun.fingerprint === expect.fingerprint ? warmRun : null;
    if (this.deps.readFiles && specBase && index.fileMtimes) {
      for (const f of files) {
        const mtime = index.fileMtimes.get(f.path) ?? null;
        if (specBase.mtimes.get(f.path) === mtime) continue;
        specPaths.add(f.path);
      }
    }
    const prefetchInto = (paths: readonly string[], tag: string): Promise<void> => {
      if (!this.deps.readFiles || paths.length === 0) return Promise.resolve();
      return this.deps.readFiles(paths).then(
        (texts) => {
          for (let i = 0; i < paths.length; i++) {
            const t = texts[i];
            if (typeof t === 'string') textCache.set(paths[i]!, Promise.resolve(t));
          }
        },
        (err: unknown) => {
          this.deps.log.warn(`Convention ${tag} batch prefetch failed; falling back to per-file reads: ${String(err)}`);
        },
      );
    };
    const specPromise = prefetchInto([...specPaths], 'speculative');

    // 热缓存优先（PERF-12b）：判据相同 ⇒ 不再走一次异步装载（见 `hotCache` 注释）。
    const hot = !force && expect && this.hotCache && this.hotCache.expectFingerprint === expect.fingerprint
      ? this.hotCache.cache
      : null;
    const stored = hot ?? (this.deps.snapshot && expect && !force ? await this.deps.snapshot.load(expect) : null);
    if (stored && expect && !hot) this.hotCache = { expectFingerprint: expect.fingerprint, cache: stored };

    /**
     * 整项目层能否复用：**必须**本次索引带 `fingerprint` 且与缓存里那条相等。
     * 逐文件层不看它，只看桶里的 mtime（见下）——把两件事合成一个判据就是
     * "改一个文件重算全库"的由来（§5.70 同一课）。
     */
    const canReuseProject = !force && !!stored && !!index.fingerprint && stored.erbFingerprint === index.fingerprint;
    const tLoad = Date.now();

    const ruleTimings: {
      ruleId: string;
      ms: number;
      issues: number;
      reused: boolean;
      /** 分区规则的本轮贡献复用读数（PERF-12b）；非分区规则缺省 */
      cross?: { reused: number; total: number };
    }[] = [];
    const projectResults: Record<string, ConventionIssue[]> = {};

    /**
     * 分区计划（PERF-12b，2026-10-16）：声明了 `partition` 的跨文件规则不再"整包重算"——
     * 每文件的结构化贡献按 **mtime（与逐文件桶同族判据）+ 外部输入摘要 `key()`**
     * 双门复用，每轮只重算 mtime 变了的那些文件，合并本身只看贡献。
     * 判据任一不符 ⇒ 该规则分区整体弃用重算（fail-closed）；`force` ⇒ 全文件重算
     * （用户的显式意图不被分区糊住），算完照常回填缓存。
     */
    const partitionPlans = new Map<string, PartitionPlan>();
    const partitionSkipped = new Set<string>();
    const unitsPort = this.deps.snapshot?.units;
    /** 本轮懒取盘上贡献的读数（`lint units` 行）：次数 / 命中次数 */
    let unitsLazyLoads = 0;
    let unitsLazyHits = 0;
    for (const rule of projectRules) {
      if (!rule.partition) continue;
      if (canReuseProject && stored!.projectResults[rule.id]) continue; // 整包复用更快，不必分区
      const partition = rule.partition;
      let gateKey: string;
      try {
        gateKey = partition.key ? String(await partition.key(checkCtx)) : '';
      } catch (err) {
        // key() 失败 = 外部输入读不出 ⇒ 判据不全：该规则本次**没有结论**（不拿旧分区凑）
        failedRules.push({
          ruleId: rule.id,
          error: `分区判据 key() 失败：${err instanceof Error ? err.message : String(err)}`,
        });
        partitionSkipped.add(rule.id);
        this.deps.log.warn(`Convention rule '${rule.id}' partition key failed: ${String(err)}`);
        continue;
      }
      const gateFp = expect ? expect.fingerprint : '';
      let state = gateFp ? this.unitStates.get(rule.id) : undefined;
      if (!state || state.expectFingerprint !== gateFp || state.key !== gateKey) {
        state = { expectFingerprint: gateFp, key: gateKey, byPath: new Map() };
        if (gateFp) this.unitStates.set(rule.id, state);
        /**
         * 盘上贡献的来源（PERF-12c）：装了独立端口 ⇒ **只有这条规则本轮要建计划**才懒取
         * 它那一条键（整包复用轮根本不走到这里）；没装 ⇒ v3 同键形态，从主快照里拿。
         */
        let storedUnits: Record<string, LintUnitEntry> | undefined;
        let storedUnitsKey = '';
        if (!force && expect) {
          if (unitsPort) {
            unitsLazyLoads++;
            const blob = await unitsPort.load(rule.id, expect);
            if (blob) {
              storedUnits = blob.units;
              storedUnitsKey = blob.key;
              unitsLazyHits++;
            }
          } else {
            storedUnits = stored?.projectUnits?.[rule.id];
            storedUnitsKey = stored?.partitionKeys?.[rule.id] ?? '';
          }
        }
        if (storedUnits && storedUnitsKey === gateKey) {
          let bad = false;
          for (const [path, e] of Object.entries(storedUnits)) {
            if (partition.isUnit && !partition.isUnit(e.unit)) {
              bad = true;
              break;
            }
            state.byPath.set(path, e);
          }
          if (bad) {
            state.byPath.clear();
            this.deps.log.warn(
              `Convention partition units for '${rule.id}' failed structure check; recomputing all (fail-closed)`,
            );
          }
        }
      }
      const stale: ErbFile[] = [];
      for (const f of files) {
        if (!force) {
          const mtime = index.fileMtimes?.get(f.path) ?? null;
          const e = state.byPath.get(f.path);
          if (e && e.mtimeMs !== null && mtime !== null && e.mtimeMs === mtime) continue;
        }
        stale.push(f);
      }
      partitionPlans.set(rule.id, {
        rule,
        state,
        stale,
        unitsReused: files.length - stale.length,
        unitsTotal: files.length,
        unitsComputed: 0,
      });
    }

    /**
     * 逐文件层：按本次索引顺序（= walk 顺序）决定"复用桶"还是"只算这个文件"。
     * 任一侧 mtime 取不到 ⇒ 该文件判过期（保守重算），别的路径不受影响。
     *
     * stale 清单**先算齐**（判据一字未动）：批量预取需要全部规则 stale 的并集。
     */
    const tUnits = Date.now();
    const prevByRule = new Map<string, Record<string, LintFileBucket>>();
    const staleByRule = new Map<string, ErbFile[]>();
    const prefetchPaths: string[] = [];
    const prefetchSeen = new Set<string>();
    for (const rule of runnableFileRules) {
      const prev = stored?.buckets[rule.id] ?? {};
      prevByRule.set(rule.id, prev);
      const stale = files.filter((f) => {
        const mtime = index.fileMtimes?.get(f.path) ?? null;
        const b = prev[f.path];
        return !(b && b.mtimeMs !== null && mtime !== null && b.mtimeMs === mtime);
      });
      staleByRule.set(rule.id, stale);
      for (const f of stale) {
        if (prefetchSeen.has(f.path)) continue;
        prefetchSeen.add(f.path);
        prefetchPaths.push(f.path);
      }
    }
    // 分区规则的 stale 文件并入同一批预取（贡献可能要读正文——如糖侧静态扫描）
    for (const plan of partitionPlans.values()) {
      for (const f of plan.stale) {
        if (prefetchSeen.has(f.path)) continue;
        prefetchSeen.add(f.path);
        prefetchPaths.push(f.path);
      }
    }

    /**
     * 批量预取（2026-10-16 批量 IO 批 → PERF-12b 投机化）：本 run 全部 stale 文件
     * 一次批取（批内一趟 IPC + 会话缓存命中——索引/抽取段刚读过的正文在这里零读盘；
     * 跨 run 的同文件重复校验同样命中会话缓存）。投机批（装载开始前已并行发出）覆盖到
     * 的路径不再重取；失败项不入 textCache ⇒ 落 `readFile` 兜底重试（会再失败 ⇒ 规则
     * 抛错 ⇒ 不留桶）。语义不变，只把"装载→预取"的串行等待并成 max。
     */
    const restPaths = prefetchPaths.filter((p) => !specPaths.has(p));
    await Promise.all([specPromise, prefetchInto(restPaths, 'stale')]);
    const tPrefetch = Date.now();

    /**
     * 本轮计划要现算的**文件判定单元**总数（逐文件桶与分区贡献同一把尺；按 mtime 复用来的
     * 结论不在内）。`incomplete` 的分母必须与分子同一次计划算出来，不能事后编。
     */
    const unitsTotal =
      [...staleByRule.values()].reduce((n, s) => n + s.length, 0) +
      [...partitionPlans.values()].reduce((n, p) => n + p.stale.length, 0);

    /**
     * 计算段。被叫停只从这里以 `LintCancelled` 出来，`runOnce` 是唯一接住它的地方。
     * 逐文件规则的 `fresh` **先登记再算** ⇒ 叫停落在某条规则中途时，那条规则已算完的单元
     * 仍进得了下面的装配；没算的那些压根不在表里（于是既不进这一轮的结论，也不被记成"没问题"）。
     */
    const freshByRule = new Map<string, Map<string, LintFileBucket>>();
    const fileRuleMs = new Map<string, number>();
    let unitsDone = 0;
    let concludedFileRules = 0;
    let interrupted = false;
    try {
      for (const rule of projectRules) {
        gate(); // 整项目规则是一次长调用 ⇒ 只能在规则之间收摊（文件层的粒度由调度段的闸管）
        const t0 = Date.now();
        const cached = canReuseProject ? stored!.projectResults[rule.id] : undefined;
        if (cached) {
          projectResults[rule.id] = cached;
          ruleTimings.push({ ruleId: rule.id, ms: Date.now() - t0, issues: cached.length, reused: true });
          continue;
        }
        if (partitionSkipped.has(rule.id)) {
          ruleTimings.push({ ruleId: rule.id, ms: Date.now() - t0, issues: 0, reused: false });
          continue;
        }
        const plan = partitionPlans.get(rule.id);
        if (plan) {
          const outcome = await this.runPartitionedRule(plan, checkCtx, files, runFiles);
          if (!outcome.ok) {
            // 分区/合并不全 ⇒ 整条规则本次**没有结论**（跨文件结论绝不带洞拼造）；不写 projectResults
            failedRules.push({ ruleId: rule.id, error: outcome.error });
            ruleTimings.push({
              ruleId: rule.id,
              ms: Date.now() - t0,
              issues: 0,
              reused: false,
              cross: { reused: plan.unitsReused, total: plan.unitsTotal },
            });
          } else {
            projectResults[rule.id] = outcome.issues;
            ruleTimings.push({
              ruleId: rule.id,
              ms: Date.now() - t0,
              issues: outcome.issues.length,
              reused: false,
              cross: { reused: plan.unitsReused, total: plan.unitsTotal },
            });
          }
          continue;
        }
        try {
          const produced = (await rule.check!(checkCtx)) ?? [];
          projectResults[rule.id] = produced;
          ruleTimings.push({ ruleId: rule.id, ms: Date.now() - t0, issues: produced.length, reused: false });
        } catch (err) {
          // 抛错的规则**不写 projectResults** ⇒ 下次必然重算它（坏一次不能永久缓存坏结果）
          failedRules.push({ ruleId: rule.id, error: err instanceof Error ? err.message : String(err) });
          this.deps.log.warn(`Convention rule '${rule.id}' failed: ${String(err)}`);
          ruleTimings.push({ ruleId: rule.id, ms: Date.now() - t0, issues: 0, reused: false });
        }
      }

      for (const rule of runnableFileRules) {
        const t0 = Date.now();
        const fresh = new Map<string, LintFileBucket>();
        freshByRule.set(rule.id, fresh);
        const stale = staleByRule.get(rule.id)!;
        let ruleFailed = false;
        await runFiles(stale, async (file) => {
          try {
            const produced = (await rule.checkFile!(checkCtx, file)) ?? [];
            fresh.set(file.path, { mtimeMs: index.fileMtimes?.get(file.path) ?? null, issues: produced });
            unitsDone++;
          } catch (err) {
            // 抛错的文件**不留桶**：下次重算它，而不是把"这次没结论"当成永久结论
            ruleFailed = true;
            this.deps.log.warn(`Convention rule '${rule.id}' failed on ${file.path}: ${String(err)}`);
          }
        });
        if (ruleFailed) {
          failedRules.push({ ruleId: rule.id, error: `逐文件判定失败 ${stale.length - fresh.size} 个文件（详见日志）` });
        }
        fileRuleMs.set(rule.id, Date.now() - t0);
        concludedFileRules++;
      }
    } catch (err) {
      if (!(err instanceof LintCancelled)) throw err; // 别的异常照原样往上抛（口径不在这里改）
      interrupted = true;
    }

    /**
     * 装配（**半轮也走同一条路**：桶里只有"有结论的单元"，缺项 = 下一轮必重算那一棵）。
     * 按 walk 顺序 ⇒ 增量与全量同序（与索引/抽取段同一份纪律）。
     */
    const buckets: Record<string, Record<string, LintFileBucket>> = {};
    let recomputedFiles = 0;
    for (const rule of runnableFileRules) {
      const fresh = freshByRule.get(rule.id) ?? new Map<string, LintFileBucket>();
      const prev = prevByRule.get(rule.id)!;
      const stale = staleByRule.get(rule.id)!;
      recomputedFiles += fresh.size;
      const out: Record<string, LintFileBucket> = {};
      let count = 0;
      for (const file of files) {
        const b = fresh.get(file.path) ?? prev[file.path];
        if (!b) continue; // 这次没结论（读失败 / 索引换了 / 这一轮被叫停没排到） ⇒ 不伪造
        out[file.path] = b;
        count += b.issues.length;
      }
      buckets[rule.id] = out;
      ruleTimings.push({
        ruleId: rule.id,
        ms: fileRuleMs.get(rule.id) ?? 0,
        issues: count,
        reused: stale.length === 0,
      });
    }

    // 汇总：整项目结论在前、逐文件结论按 (规则, walk 顺序) 在后，再统一去重 + 排序
    const issues: ConventionIssue[] = [];
    const seen = new Set<string>();
    const push = (raw: ConventionIssue, fallbackRuleId: string, severity: ConventionSeverity): void => {
      const normalized: ConventionIssue = {
        ...raw,
        ruleId: raw.ruleId || fallbackRuleId,
        severity: raw.severity ?? severity,
      };
      const key =
        normalized.key ??
        `${normalized.ruleId}|${normalized.filePath ?? ''}|${normalized.line ?? 0}|${normalized.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      issues.push({ ...normalized, key });
    };
    for (const rule of projectRules) {
      for (const raw of projectResults[rule.id] ?? []) push(raw, rule.id, rule.severity);
    }
    for (const rule of runnableFileRules) {
      for (const path of Object.keys(buckets[rule.id] ?? {})) {
        for (const raw of buckets[rule.id]![path]!.issues) push(raw, rule.id, rule.severity);
      }
    }

    issues.sort(compareIssues);
    const counts: Record<ConventionSeverity, number> = { error: 0, warning: 0, info: 0 };
    for (const i of issues) counts[i.severity]++;

    const finishedAt = Date.now();
    const executed = projectRules.length + runnableFileRules.length;
    /**
     * 半轮的读数口径：`ruleCount` 只报**有完整结论**的那几条（没跑到的规则既不算参与、
     * 更不算通过），`incomplete` 的分子分母都取本轮那份计划（含分区贡献）。
     */
    const unitsSettled =
      unitsDone + [...partitionPlans.values()].reduce((n, p) => n + p.unitsComputed, 0);
    const report: ConventionReport = {
      adapterId: project.adapterId,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      issues,
      counts,
      ruleCount: interrupted ? Object.keys(projectResults).length + concludedFileRules : executed,
      failedRules,
      ...(interrupted ? { incomplete: { unitsDone: unitsSettled, unitsTotal } } : {}),
    };
    this.deps.log.info(
      `Convention lint: ${issues.length} issue(s) ` +
        `(error ${counts.error} / warning ${counts.warning} / info ${counts.info}) ` +
        `in ${report.durationMs}ms across ${executed} rule(s)` +
        (failedRules.length ? `, ${failedRules.length} rule(s) failed` : '') +
        (interrupted ? `, 被叫停（${unitsSettled}/${unitsTotal} 文件单元，本轮不落盘）` : ''),
    );
    // 规则顺序 = 执行顺序（确定性）；`复用` 标记是"增量到底命中没有"的读数，
    // `分复用 a/b` = 分区规则本轮按 mtime 复用的文件贡献数（PERF-12b 判据读数）
    this.deps.log.info(
      `  lint breakdown: ${ruleTimings
        .map(
          (t) =>
            `${t.ruleId} ${t.ms}ms/${t.issues}项` +
            (t.reused ? '(复用)' : t.cross ? `分复用 ${t.cross.reused}/${t.cross.total}` : ''),
        )
        .join(' · ')}` +
        ` ｜ 逐文件重算 ${recomputedFiles} 个文件` +
        ` ｜ 规则外：装载 ${tLoad - startedAt}ms · 预取 ${tPrefetch - tLoad}ms · 装配 ${Date.now() - tPrefetch}ms`,
    );
    // 复用总闸单独成行：breakdown 那行很长，壳侧日志单行截断会把行尾吃掉（PITFALLS 86）
    {
      const reusedRules = ruleTimings.filter((t) => t.reused).length;
      let crossReused = 0;
      let crossTotal = 0;
      for (const t of ruleTimings) {
        crossReused += t.cross?.reused ?? 0;
        crossTotal += t.cross?.total ?? 0;
      }
      this.deps.log.info(
        `  lint reuse: 整条复用 ${reusedRules}/${ruleTimings.length} · 分区 ${crossReused}/${crossTotal} · 逐文件重算 ${recomputedFiles}` +
          ` · 装载 ${tLoad - startedAt}ms 预取 ${tPrefetch - tLoad}ms 装配 ${Date.now() - tPrefetch}ms`,
      );
      // 单独成行（PITFALLS 86：壳侧单行 170 字符）：贡献懒取的命中与预取覆盖面归因
      this.deps.log.info(
        `  lint units: 懒取 ${unitsLazyLoads} 键命中 ${unitsLazyHits} · 判据段 ${tUnits - tLoad}ms` +
          ` · 投机候选 ${specPaths.size} 补取 ${restPaths.length}`,
      );
    }
    // 记下本轮 mtime ⇒ 同引擎下一轮的投机预取候选（判据变了/新引擎 ⇒ 本轮不投机）
    this.lastRun = expect && index.fileMtimes
      ? { fingerprint: expect.fingerprint, mtimes: new Map(index.fileMtimes) }
      : null;
    /**
     * 半轮**不覆盖订阅面**：波浪线那一层只看 `issues`，把没扫到的文件画成"没有线"就是
     * 拿沉默冒充结论（铁律 4）。这一轮的真相只交给叫停它的那一手（`run` 的返回值），
     * 面上留的还是上一次跑完的那一份——由 `lint-run` 的读数说明白。
     */
    if (!interrupted) this.commit(report);

    /**
     * 落盘：只在真算过东西时写（全命中再刷一遍是纯浪费）。
     * `index.fingerprint` 缺失时存空串——下次 `canReuseProject` 仍判假，保守不命中。
     * 分区贡献随本轮实际状态写盘（键 = 本轮 `key()`；ruleId 缺项 = 下次该规则全量重算分区）。
     *
     * 装了独立端口（PERF-12c）时贡献**不进主快照**：逐规则各写各的键，本轮没建计划的规则
     * **不碰盘**（它那条键还带着自己的 `key` 门，下次懒取时照常自证是否过期）；
     * `prune` 的保留集是**当前规则集里所有声明 partition 的 ruleId**——规则改名/换适配器
     * 留下的孤儿键在这里清掉，不是只清"本轮没算的那几条"。
     */
    if (
      this.deps.snapshot &&
      expect &&
      (interrupted || recomputedFiles > 0 || ruleTimings.some((t) => !t.reused) || stored?.droppedUnits === true)
    ) {
      const projectUnits: Record<string, Record<string, LintUnitEntry>> = {};
      const partitionKeys: Record<string, string> = {};
      const unitsByRule = new Map<string, Record<string, LintUnitEntry>>();
      for (const plan of partitionPlans.values()) {
        const byPath: Record<string, LintUnitEntry> = {};
        for (const f of files) {
          const e = plan.state.byPath.get(f.path);
          if (e) byPath[f.path] = e; // 只留本次索引里还活着的文件（与桶同纪律：快照不越攒越大）
        }
        if (unitsPort) unitsByRule.set(plan.rule.id, byPath);
        else {
          projectUnits[plan.rule.id] = byPath;
          partitionKeys[plan.rule.id] = plan.state.key;
        }
      }
      // 本轮走整包复用、没建计划的分区规则：把上次盘上的分区原样带走（判据仍由 key+mtime 把关）
      // —— 独立端口下这条键本来就在盘上、自带判据，无需搬运，搬运就是每轮多写 4 MB
      if (!unitsPort && canReuseProject && stored?.projectUnits) {
        for (const rule of projectRules) {
          if (!rule.partition || projectUnits[rule.id]) continue;
          const prev = stored.projectUnits[rule.id];
          if (!prev) continue;
          const byPath: Record<string, LintUnitEntry> = {};
          for (const f of files) {
            const e = prev[f.path];
            if (e) byPath[f.path] = e;
          }
          projectUnits[rule.id] = byPath;
          partitionKeys[rule.id] = stored.partitionKeys?.[rule.id] ?? '';
        }
      }
      const freshCache: LintCache = {
        erbFingerprint: index.fingerprint ?? '',
        projectResults,
        buckets,
        ...(unitsPort ? {} : { projectUnits, partitionKeys }),
      };
      this.hotCache = { expectFingerprint: expect.fingerprint, cache: freshCache };
      if (interrupted) {
        /**
         * 被叫停的一轮**一个字节都不落盘**：下一轮开项目级联会把那半份残影当成真相。
         * 只留在内存的 `hotCache` 里——已算完的那棵下轮按 mtime 命中，没算的那棵在桶/贡献里
         * **没有条目** ⇒ 必重算（"缺项 = 重算"本就是这套缓存的纪律，所以半份不会说谎）。
         */
        return report;
      }
      this.deps.snapshot.save(freshCache, expect);
      if (unitsPort) {
        for (const plan of partitionPlans.values()) {
          unitsPort.save(plan.rule.id, { key: plan.state.key, units: unitsByRule.get(plan.rule.id)! }, expect);
        }
        unitsPort.prune(projectRules.filter((r) => r.partition).map((r) => r.id));
      }
    }
    return report;
  }

  /**
   * 分区路径执行一条规则（PERF-12b）。
   *
   * 纪律与桶同族但**更严**：跨文件结论绝不带洞拼造——任一文件的贡献算不出来（抛错）
   * ⇒ **整条规则本次没有结论**（记 `failedRules`，不写 `projectResults`）；
   * 规则自己声明"本文件无结论"（`fileUnit` 返回 `undefined`，如读盘失败的跳过口径）
   * ⇒ 该文件不入合并、不缓存，其余照常（与改造前的逐文件跳过语义逐条一致）。
   */
  private async runPartitionedRule(
    plan: PartitionPlan,
    ctx: ConventionCheckContext,
    files: readonly ErbFile[],
    runFiles: FileLoop,
  ): Promise<{ ok: true; issues: ConventionIssue[] } | { ok: false; error: string }> {
    const { rule, state, stale } = plan;
    const partition = rule.partition!;
    const fresh = new Map<string, unknown>();
    let failedUnits = 0;
    await runFiles(stale, async (file) => {
      const mtime = ctx.index.fileMtimes?.get(file.path) ?? null;
      try {
        const produced = await partition.fileUnit(ctx, file);
        if (produced === undefined) {
          state.byPath.delete(file.path); // 规则声明"无结论"：不缓存、不入合并
          return;
        }
        fresh.set(file.path, produced);
        plan.unitsComputed++;
        if (mtime !== null) state.byPath.set(file.path, { mtimeMs: mtime, unit: produced });
        else state.byPath.delete(file.path); // mtime 判据不可得 ⇒ 算了也不缓存（保守）
      } catch (err) {
        failedUnits++;
        state.byPath.delete(file.path);
        this.deps.log.warn(`Convention rule '${rule.id}' partition failed on ${file.path}: ${String(err)}`);
      }
    });
    if (failedUnits > 0) {
      return { ok: false, error: `分区计算失败 ${failedUnits} 个文件（详见日志）——跨文件结论不带洞拼造` };
    }
    const entries: ConventionProjectUnitEntry[] = [];
    for (const file of files) {
      if (fresh.has(file.path)) entries.push({ file, unit: fresh.get(file.path) });
      else if (state.byPath.has(file.path)) entries.push({ file, unit: state.byPath.get(file.path)!.unit });
      // 都没有 ⇒ 本文件这轮无结论（规则自己声明的跳过口径），绝不伪造
    }
    try {
      const produced = (await partition.combine(ctx, entries)) ?? [];
      return { ok: true, issues: produced };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private commit(report: ConventionReport): void {
    this.last = report;
    for (const cb of [...this.listeners]) {
      try {
        cb(report);
      } catch (err) {
        this.deps.log.warn(`Convention listener threw: ${String(err)}`);
      }
    }
  }
}
