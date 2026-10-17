/**
 * 装饰热路径（2026-10-16「PERF-4 装饰器池化 + 版本缓存 + 切文件减负」批）。
 *
 * ## 它管什么
 *
 * `EditorPane.refreshMarkers` 的**调度与记账**部分被抽到这儿：谁同步跑、谁异步跑、
 * 结果什么时候允许上屏、同一份内容第二次触发要不要重算。Monaco / problem-store
 * 的**发布形状**仍由宿主握着（本模块只交出去一份合并好的 `LineDecoration[]`），
 * 所以这里零 Monaco、零内核依赖、可单测。
 *
 * ## 三条语义
 *
 * 1. **分层派发**：贡献未声明 `offloadKind` → 与改动前逐字一致（同步、就地）；
 *    声明了的 → 请出同步装饰轮，进 `compute.runLatest`（同文件**尾缘合并**背压、
 *    交互档）。其中 kind 在 worker 表里的（判据 = 装配层 `hasWorkerTask`）走
 *    `compute.offload`（真并行，主线程只装配）；不在表里的（实现要吃插件内注入的
 *    服务，worker 复现不了）**异步就地**——照样脱离同步轮，只是 CPU 仍在本线程。
 *    "哪些 kind 只能就地"不是靠猜：那张表就是 `compute-tasks.ts`，读得到就说得清。
 *
 * 2. **陈旧即丢**：异步结果落地前必须确认"还是发起那一份 model"——版本号**和**世代号
 *    都对上才算（`#F6`：新 model 的版本号从 1 重新数，只比版本号会让关→重开的在途结果
 *    以 `1 === 1` 蒙混过关，把旧装饰发布进新 model 并写进缓存 = 缓存投毒）。
 *    打字期间版本一直在涨，迟到的旧结果一旦上屏就是"波浪线指着已经改掉的行"——
 *    那是假缺陷农场，比没有波浪线糟得多。丢弃计入 `stats().discarded`，不静默。
 *
 * 3. **同版本零重算**：`(项目判据, 路径, versionId, 贡献签名)` → 每路装饰结果。
 *    切回未改动的标签 / 保存后 / 外部改动重载……只要版本没变，第二次触发**一次
 *    装饰计算都不做**，直接发布缓存。判据缺 `inputDigest` 就不缓存（与
 *    `condition-extractor/snapshot.ts` 同一条纪律：判据不全 ⇒ 不猜）。
 *    缓存只收**完整**条目（异步那几路都回来了才写），半条缓存会让重装饰永远缺席。
 *
 * 合并顺序 = `kernel.slots.query('ui.editor.decorator')` 给的顺序（宿主传进来的
 * `contributors()` 快照），与改动前"按槽位顺序 push"逐字一致 ⇒ 问题面板的行序不变。
 *
 * ## PS-5 加的第四条：**体量越界就整轮不办，并且说出来**
 *
 * `sizeOf`（可选，O(1) 读数）+ `markerValidationPaused`（纯判据）+ `pauseChanged`（跨界通知）。
 * 判据与实测代价都在下面那节常量旁边；**不接 `sizeOf` 时行为与改前逐字一致**。
 * 通知只在跨界时发一次，且进入暂停时把这一份文件的旧结果撤一次——
 * 面板继续显示上一份内容的波浪线，等于宣称一个已经不成立的真相（铁律 4）。
 */

import type { ComputePool, EditorDecoratePayload, GameProject, LineDecoration } from '@kojo/plugin-api';

/** 一路装饰贡献的最小面（宿主从槽位贡献映射出来，本模块不认识槽位） */
export interface MarkerContributor {
  readonly id: string;
  /** 契约 additive 字段：声明了它，本路就被请出同步装饰轮 */
  readonly offloadKind?: string;
  /** 就地执行（未声明 offloadKind 者 = 唯一走法；声明了者 = 异步就地回退走法） */
  decorate(payload: { path: string; text: string; project: GameProject | null }): LineDecoration[];
}

export interface MarkerRunnerDeps {
  /** 计算池（只用 offload / runLatest / yieldToMain 三个语义） */
  compute: Pick<ComputePool, 'offload' | 'runLatest' | 'yieldToMain'>;
  /** 该 kind 在 worker 侧是否有实现（装配层 `compute-tasks.ts` 的判据） */
  workerHasTask: (kind: string) => boolean;
  /** 槽位贡献快照（**顺序即发布顺序**） */
  contributors: () => readonly MarkerContributor[];
  /** 当前项目（传给就地装饰器；同时是缓存判据的来源） */
  project: () => GameProject | null;
  /**
   * 该路径当前 model 的版本号；model 已 dispose / 标签已关 → undefined。
   * **版本号不认 model**：新 model 从 1 重新数，所以它还要求宿主在关标签时调用
   * `dropPath`（世代号由此递增，见实现处的 #F6 注释）。
   */
  versionOf: (path: string) => number | undefined;
  /** 发布一份**整档**装饰（宿主：Monaco markers + problem-store 全量替换） */
  publish: (path: string, decorations: LineDecoration[]) => void;
  /** 探针（宿主 perf.record）；`markers.total` 口径 = 同步装饰轮的主线程成本 */
  record?: (name: string, ms: number, note?: string) => void;
  /** LRU 容量（完整条目数）；缺省 64 */
  cacheSize?: number;
  /**
   * PS-5 校验暂停闸的**体量读数**（可选；不接 = 永不暂停，与接闸前逐字一致）。
   *
   * 必须是**不复制文本**的 O(1) 读数（宿主用 `model.getValueLength()` +
   * `getLineCount()`）：这条腿的作用就是"在取那一份整篇文本之前先决定是否根本不取"，
   * 拿 `getValue().length` 当判据等于把要省的开销先付一遍。
   */
  sizeOf?: (path: string) => DocSize | undefined;
  /**
   * 暂停状态**翻转**时通知宿主（可选）。只在跨界时叫一次，不是每次刷新都叫——
   * 宿主据此把"这一轮没算、为什么没算"说给作者听（铁律 4：降级不许静默）。
   * 本模块不认识 React，也不写文案：可见性归宿主，判据归这里。
   */
  pauseChanged?: (path: string, paused: boolean) => void;
  now?: () => number;
}

export interface MarkerRunnerStats {
  /** 同版本重触发命中缓存的次数（命中 = 装饰计算 0 次） */
  hits: number;
  /** 需要真正计算的次数 */
  misses: number;
  /** 异步派发次数（每次 = 一轮 runLatest 尾缘合并后的实跑） */
  dispatched: number;
  /** 因版本已变而丢弃的异步结果次数（陈旧防护生效） */
  discarded: number;
  /** 就地执行（未 offload / worker 无此 kind）的装饰次数 */
  inline: number;
  /** 进 worker 通道的装饰次数 */
  worker: number;
  /** 当前缓存条目数 */
  cached: number;
  /** PS-5：因体量越界而**整轮不办**的刷新次数（暂停态的每一次触发都计一次） */
  paused: number;
}

/** 一路贡献的结果表（键 = 贡献 id；发布时按 contributors 顺序合并） */
type PerSource = Map<string, LineDecoration[]>;

/* ───────────────────────── PS-5 校验暂停闸（体量判据） ───────────────────────── */

/** 一份文档的**体量读数**（两者都必须能不复制文本取到） */
export interface DocSize {
  readonly units: number;
  readonly lineCount: number;
}

/**
 * 文本长度上限（UTF-16 码元，`model.getValueLength()` 的口径）。
 *
 * 尺子取自本机实测（合成盘 = 真语料最大那份的尺度 52,601 行；两路装饰器都是真实现）：
 * | 规模 | 码元 | structure | expr | 整篇复制 + structured-clone |
 * |---|---|---|---|---|
 * | 6,000 行 | 0.10 M | 8.9 ms | 94.5 ms | 0.33 ms |
 * | 52,601 行 | 0.93 M | 88.5 ms | 689 ms | 1.65 ms |
 * | 200,000 行 | 3.60 M | 268 ms | 2,508 ms | 7.27 ms |
 *
 * 两件事要说清（都跟"以为的账"不一样）：
 * ① **复制不是主项**：一份 3.6 M 码元的正文复制 + 克隆进 worker 一共 7.3 ms，
 *    同一轮里装饰计算是 2.8 s。所以这一闸真正省下的是**整轮计算**（worker 也是这台机器的 CPU，
 *    它排队时波浪线的延迟就是这几秒），复制那两份只是顺带（`readText` 一次都不调 ⇒ 零分配）。
 * ② 阈值按"最大真实文件一律放行"倒推：真语料最大单文件 2.35 MB（UTF-8 字节），
 *    而**码元数上限就是字节数**（全 ASCII 时 1 字节 = 1 码元）⇒ 2.35 MB 那份最多 2.35 M 码元。
 *    取 3,000,000 让它在任何编码密度下都不越界（语料每一份都照常校验），
 *    越界的只有"比最大真实文件还大一截"那种盘（按 ① 那张表，那一轮已经是秒级计算）。
 */
export const MARKER_VALIDATE_MAX_UNITS = 3_000_000;

/**
 * 行数上限（与码元数**并判**，任一越界即停）。
 *
 * 为什么码元数还不够：两路装饰都是**逐行**状态机，代价随行数走（上面那张表：
 * expr ≈ 13 ms/千行、structure ≈ 1.7 ms/千行，两档规模同斜率），同一份字节数摊到
 * 更多行就更贵（每行还有行首匹配 + 配对栈 + 结果数组的一格固定开销）。
 * 200,000 行 = 最大真实文件（52,601 行）的 3.8 倍，那一轮的实测代价 **≈2.8 秒**。
 */
export const MARKER_VALIDATE_MAX_LINES = 200_000;

/**
 * 这一轮该不该**整体不办**（纯函数，判据在此、文案在宿主）。
 *
 * 停的是**整轮**（同步档 + 异步档一起），不是某一路：留半档装饰上屏会更糟——面板与
 * 波浪线各自显示"一部分真相"，读者无法判断眼前这份是全的还是残的。
 * 省下的是什么（按上面那张实测表）：一轮 0.8–2.8 s 的装饰计算（worker 也跑在同一台机器上，
 * 它排队 = 波浪线迟到几秒）+ 每停笔一次的**两次整篇文本复制**（`getValue()` 一份、
 * 进 worker 的 structured-clone 一份，后者在 `markers:${path}` 那条 runLatest 键上还会
 * 被尾缘合并重复触发）。丢下的是一段时间内的波浪线，所以宿主**必须**把"已暂停"显示出来
 * （`pauseChanged`），否则就是铁律 4 禁止的静默降级。
 */
export function markerValidationPaused(size: DocSize): boolean {
  return size.units > MARKER_VALIDATE_MAX_UNITS || size.lineCount > MARKER_VALIDATE_MAX_LINES;
}

/**
 * 暂停期间的旧结果要不要留在屏上（纯函数；宿主与 runner 共用同一把尺子）。
 *
 * 留 = 面板继续宣称"这就是这份文件的问题"，而它对应的是**暂停之前**的内容。
 * 所以跨界进入暂停时清空一次（清空本身由 `pauseChanged` 同步说明），
 * 跨界退出时不需要特判：下一次刷新自然重算。
 */
export const MARKER_PAUSE_CLEARS_DECORATIONS = true;

/** 就地执行时的载荷（槽契约形状：多一个 `project`，可搬运任务只吃 `{path,text}`） */
type InlinePayload = Parameters<MarkerContributor['decorate']>[0];

const DEFAULT_CACHE_SIZE = 64;

/** 默认计时源：有 performance 就用它（与 perf.ts 同一口径） */
const defaultNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * 缓存的**项目判据**。
 *
 * `inputDigest` = adapter 在 `loadProject` 里吃进的非 ERB 输入摘要（字典 / CSV 名表……）。
 * `.kojo` 的转译诊断正是靠它才成立 ⇒ 缺它就不许缓存（判据不全就不猜，同抽取快照纪律）。
 * 返回 null = 本次不缓存。
 */
function projectKeyOf(project: GameProject | null): string | null {
  if (project === null) return null;
  if (!project.inputDigest) return null;
  return `${project.adapterId}\u0000${project.rootDir}\u0000${project.inputDigest}`;
}

/** 贡献签名：槽位增减（插件激活 / 项目切换）或 offloadKind 变化都要作废缓存 */
function signatureOf(list: readonly MarkerContributor[]): string {
  return list.map((c) => `${c.id}:${c.offloadKind ?? '-'}`).join('\u0001');
}

/** 按贡献顺序合并成整档装饰（顺序与改动前的 push 顺序一致 ⇒ 面板行序不变） */
function merge(list: readonly MarkerContributor[], results: PerSource): LineDecoration[] {
  const out: LineDecoration[] = [];
  for (const c of list) {
    const part = results.get(c.id);
    if (part) out.push(...part);
  }
  return out;
}

export function createMarkerRunner(deps: MarkerRunnerDeps): {
  /**
   * 触发一次装饰刷新。
   *
   * `readText` 是**惰性的**：同版本命中缓存时一次都不调用它（切回未改动的标签
   * 连整份文本的取值拷贝都省掉——这才是"切文件减负"的那一半）。
   */
  refresh(path: string, readText: () => string): void;
  dropPath(path: string): void;
  clear(): void;
  stats(): MarkerRunnerStats;
} {
  const now = deps.now ?? defaultNow;
  const cacheLimit = Math.max(1, Math.floor(deps.cacheSize ?? DEFAULT_CACHE_SIZE));
  /** LRU：Map 的插入序就是使用序（命中时 delete+set 顶到最新，超容量淘汰最旧） */
  const cache = new Map<string, PerSource>();
  const counters: MarkerRunnerStats = {
    hits: 0,
    misses: 0,
    dispatched: 0,
    discarded: 0,
    inline: 0,
    worker: 0,
    cached: 0,
    paused: 0,
  };

  const record = (name: string, ms: number, note?: string): void => deps.record?.(name, ms, note);

  /* ---------------- model 世代（#F6：close→reopen 的同版本号竞态） ----------------
   *
   * `versionOf` 给的是 Monaco 的 model 内版本，**换一份 model 就从 1 重新数**。
   * 于是这条竞态能过陈旧闸：发起异步刷新（版本 1）→ 关标签（在途结果还在跑）
   * → 立刻重开同一文件（新 model，版本又是 1）→ 结果回来 `1 === 1` 通过 →
   * 把**上一份内容**的装饰发布进新 model，还按版本 1 写进缓存（此后命中零重算 = 缓存投毒）。
   *
   * 版本号那把尺子分辨不出"同版本号的两份 model"，所以再加一把**与 model 身份绑定**的世代号：
   * 只在"这份 model 不再是那一份"时推进 —— `dropPath`（宿主关标签必调）与 `clear`
   * （换项目 / 重装，整体推进）。异步结果落地时两把尺子都必须对上，任一不符即丢弃：
   * 宁可多算一轮，绝不让陈旧装饰上屏。发布形状不变（仍是一次整档替换，owner 键控）。
   */
  const modelGen = new Map<string, number>();
  /** 世代表软上限：到顶就整体作废一次（只会让在途结果多被丢弃，方向安全） */
  const MODEL_GEN_SOFT_CAP = 4096;
  /** 整体作废的基线（clear / 裁剪时推进，让所有在途捕获同时失配） */
  let modelGenBase = 0;
  const genOf = (path: string): number => modelGenBase + (modelGen.get(path) ?? 0);
  const invalidateAllModels = (): void => {
    modelGenBase += 1;
    modelGen.clear();
  };
  const advanceGen = (path: string): void => {
    modelGen.set(path, (modelGen.get(path) ?? 0) + 1);
    if (modelGen.size > MODEL_GEN_SOFT_CAP) invalidateAllModels();
  };

  const cacheKey = (projectKey: string, path: string, versionId: number, signature: string): string =>
    `${projectKey}\u0000${path}\u0000${versionId}\u0000${signature}`;

  /* ---------------- PS-5 校验暂停闸（跨界才通知，静默是禁止的） ----------------
   *
   * 位置在**缓存查询之前**：命中缓存同样是一次"把整档装饰发布上屏"，暂停态下发它
   * 就等于"嘴上说停了、手上还在显示"。反之退出暂停不必特判——下一次刷新按正常流程
   * 重算（缓存里那些条目本来就是暂停前算的，版本判据自会决定复用还是重算）。
   */
  const pausedPaths = new Set<string>();
  const syncPause = (path: string, paused: boolean): void => {
    if (paused === pausedPaths.has(path)) return;
    if (paused) {
      pausedPaths.add(path);
      if (MARKER_PAUSE_CLEARS_DECORATIONS) deps.publish(path, []); // 旧结果对应旧内容：撤下并说明
    } else pausedPaths.delete(path);
    deps.pauseChanged?.(path, paused);
  };

  function cacheGet(key: string): PerSource | undefined {
    const hit = cache.get(key);
    if (!hit) return undefined;
    cache.delete(key);
    cache.set(key, hit); // 顶到最新
    return hit;
  }

  function cachePut(key: string, results: PerSource): void {
    cache.set(key, results);
    while (cache.size > cacheLimit) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
    counters.cached = cache.size;
  }

  /** 同步档：就地执行并计时（未声明 offloadKind 的贡献——与改动前完全一致） */
  function runInline(list: readonly MarkerContributor[], payload: InlinePayload): PerSource {
    return runList(list, payload, false);
  }

  function runList(list: readonly MarkerContributor[], payload: InlinePayload, deferred: boolean): PerSource {
    const results: PerSource = new Map();
    for (const c of list) {
      const d0 = now();
      let decorations: LineDecoration[] = [];
      try {
        // 单个装饰器失败不影响其余（错误上报由该插件自己负责，宿主不静默吞掉整轮）
        decorations = c.decorate(payload) ?? [];
      } catch {
        decorations = [];
      }
      record(`markers.decorate:${c.id}`, now() - d0, deferred ? 'inline-deferred' : undefined);
      if (deferred) counters.inline++;
      results.set(c.id, decorations);
    }
    return results;
  }

  /** 异步档：worker 通道优先，worker 没这条 kind 就就地执行（仍在异步轮里） */
  async function runOffloaded(
    list: readonly MarkerContributor[],
    payload: EditorDecoratePayload,
    project: GameProject | null,
  ): Promise<PerSource> {
    // 宏任务边界：把当前这一轮（输入 / 渲染 / 同步装饰装配）让干净，重计算落在下一轮
    await deps.compute.yieldToMain();
    const results: PerSource = new Map();
    for (const c of list) {
      const kind = c.offloadKind!;
      const worker = deps.workerHasTask(kind);
      const d0 = now();
      let decorations: LineDecoration[] | undefined;
      try {
        decorations = worker
          ? ((await deps.compute.offload<LineDecoration[]>(kind, payload)) ?? [])
          : (c.decorate({ ...payload, project }) ?? []);
        if (worker) counters.worker++;
        else counters.inline++;
      } catch {
        // 通道与本地实现都失败 = 这一路今天没有波浪线；同步档同口径（退化可见、不炸编辑器）
        decorations = [];
      }
      record(`markers.decorate:${c.id}`, now() - d0, worker ? 'worker' : 'inline-deferred');
      results.set(c.id, decorations);
    }
    return results;
  }

  return {
    refresh(path: string, readText: () => string): void {
      const versionId = deps.versionOf(path);
      if (versionId === undefined) return; // 标签已关 / model 已 dispose：什么都不做
      // PS-5：体量越界 ⇒ 整轮不办（一次文本都不取、一条贡献都不跑、不进缓存）
      const size = deps.sizeOf?.(path);
      if (size !== undefined && markerValidationPaused(size)) {
        counters.paused++;
        syncPause(path, true);
        record(
          'markers.paused',
          0,
          `${path} · ${size.lineCount} 行 / ${size.units} 码元（阈值 ${MARKER_VALIDATE_MAX_LINES} 行 / ${MARKER_VALIDATE_MAX_UNITS} 码元）`,
        );
        return;
      }
      syncPause(path, false);
      // 发起时刻的 model 世代（与 versionId 一起构成"哪一份 model"的身份）
      const generation = genOf(path);

      const contributors = deps.contributors();
      const project = deps.project();
      const projectKey = projectKeyOf(project);
      const signature = signatureOf(contributors);

      // ① 同版本重触发（切回标签 / 保存后 / 外部改动重载）→ 零重算，直接发布
      if (projectKey !== null) {
        const hit = cacheGet(cacheKey(projectKey, path, versionId, signature));
        if (hit) {
          counters.hits++;
          const t0 = now();
          deps.publish(path, merge(contributors, hit));
          record('markers.total', now() - t0, `${path} · 缓存命中（版本 ${versionId}）`);
          return;
        }
      }
      counters.misses++;

      // 走到这里才取文本（命中缓存的路径连这次拷贝都不发生）
      const text = readText();
      const sync = contributors.filter((c) => !c.offloadKind);
      const deferred = contributors.filter((c) => c.offloadKind);
      const inlinePayload = { path, text, project };

      // ② 同步档：本轮就把轻的挂上（改动前"三路全同步"里那一路不重的体验不回退）
      const results: PerSource = runInline(sync, inlinePayload);
      const t0 = now();
      if (deferred.length === 0) {
        if (projectKey !== null) cachePut(cacheKey(projectKey, path, versionId, signature), results);
        deps.publish(path, merge(contributors, results));
        record('markers.total', now() - t0, `${contributors.length} 路 / 全同步`);
        return;
      }
      // 半档也先发一次：轻的那几路的波浪线不必等 worker 回来（发布语义不变 = 整档替换，
      // 只是此刻重的那几路还是空）。异步结果回来后按 id 补进同一张 Map ⇒ 顺序仍由槽位定
      if (sync.length > 0) deps.publish(path, merge(contributors, results));
      record('markers.total', now() - t0, `${sync.length} 路同步 / ${deferred.length} 路已派发（异步）`);

      // ③ 异步档：同 key 尾缘合并（打字期间只跑最新那一次），交互档优先
      counters.dispatched++;
      const dispatchedAt = now();
      const payload: EditorDecoratePayload = { path, text };
      void deps.compute
        .runLatest(`markers:${path}`, { priority: 'interactive', label: 'markers.offload' }, () =>
          runOffloaded(deferred, payload, project),
        )
        .then((deferredResults) => {
          // **陈旧即丢**：发起后版本又涨了（打字 / 重载）**或 model 已换过一份**
          // （关标签→重开，版本号会从 1 重新数 ⇒ 单比版本号会 `1 === 1` 放行旧内容）
          // → 这份结果已经不对应任何可见内容，既不许上屏也不许进缓存
          const nowVersion = deps.versionOf(path);
          if (nowVersion !== versionId || genOf(path) !== generation) {
            counters.discarded++;
            record(
              'markers.stale',
              0,
              `${path} · 丢弃版本 ${versionId}（现为 ${nowVersion ?? 'gone'}，世代 ${generation}→${genOf(path)}）`,
            );
            return;
          }
          const full: PerSource = new Map(results);
          for (const [id, part] of deferredResults) full.set(id, part);
          if (projectKey !== null) cachePut(cacheKey(projectKey, path, versionId, signature), full);
          const t1 = now();
          deps.publish(path, merge(contributors, full));
          // 墙钟（含排队 / 让路 / worker 往返）——主线程成本不看这条，看 `markers.total`
          record('markers.asyncWall', now() - dispatchedAt, `${path} · 版本 ${versionId}`);
          record('markers.publish', now() - t1, path);
        })
        .catch(() => {
          // runLatest 本身出错（不该发生：每一路各自兜底）——整档不发布，同步那半档仍在屏上
          record('markers.async.error', 0, path);
        });
    },

    dropPath(path: string): void {
      // 关标签 = 这一份 model 到此为止：推进世代，让它在途的异步结果一律作废（#F6）
      advanceGen(path);
      // 暂停态随文件一起销账：留着会让"这一份文件已停"的提示粘在别的文件上
      if (pausedPaths.delete(path)) deps.pauseChanged?.(path, false);
      for (const key of [...cache.keys()]) if (key.includes(`\u0000${path}\u0000`)) cache.delete(key);
      counters.cached = cache.size;
    },

    clear(): void {
      cache.clear();
      // 整体作废（换项目 / 重装）：推进基线，所有路径的在途结果一起失配
      invalidateAllModels();
      for (const path of [...pausedPaths]) {
        pausedPaths.delete(path);
        deps.pauseChanged?.(path, false);
      }
      counters.cached = 0;
    },

    stats(): MarkerRunnerStats {
      counters.cached = cache.size;
      return { ...counters };
    },
  };
}
