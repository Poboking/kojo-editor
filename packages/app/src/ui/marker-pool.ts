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
}

/** 一路贡献的结果表（键 = 贡献 id；发布时按 contributors 顺序合并） */
type PerSource = Map<string, LineDecoration[]>;

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
      for (const key of [...cache.keys()]) if (key.includes(`\u0000${path}\u0000`)) cache.delete(key);
      counters.cached = cache.size;
    },

    clear(): void {
      cache.clear();
      // 整体作废（换项目 / 重装）：推进基线，所有路径的在途结果一起失配
      invalidateAllModels();
      counters.cached = 0;
    },

    stats(): MarkerRunnerStats {
      counters.cached = cache.size;
      return { ...counters };
    },
  };
}
