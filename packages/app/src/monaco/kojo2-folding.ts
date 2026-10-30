/**
 * Kojo 2.0 的**折叠事实预取**（B3h，2026-10-30）：把结构 worker 的 `folds` 提前算好，缓存成
 * 供给方**同步**取用的快照。
 *
 * ## 为什么不在 provider 里等
 *
 * 折叠区间只有结构 worker 算得出（`queries/v2/folds.scm` 的 `(block) @fold`），而
 * `ui.editor.languageService` 槽的 `provide(request)` **是同步的**——worker 的事实塞不进去。
 * B3h 起折叠改走共享收口（`kojo-folding.ts` 那一枚 provider，kojo2 由 descriptor 的
 * `slotServices: ['foldingRange']` 点名），供方是插件 `kojo2-foldingRange`；本文件只做三件事：
 *
 * 1. **预取**：model 打开 / 内容变更（防抖）时问一次 worker，整篇只问一次；
 * 2. **缓存**：键 = model 身份 + **版本号**（同版本重复问直接命中；版本变了才把上一版
 *    `treeId` 交回 worker 增量重解）。`WeakMap` 键，模型释放后自然可回收；
 * 3. **交快照**：请求构造时（{@link kojo2FoldsSnapshotFor}）把**这一版**的契约区间递进
 *    `EditorFoldingRangeRequest.folds`，供方负责裁与答。
 *
 * ## 缓存未命中 ⇒ 空结果，绝不异步等待
 *
 * 槽内不许 await（供方是纯同步插件），所以 provider 被问而快照还没到 ⇒ 这一轮交空、
 * 并把预取踢进后台；**下一版内容变化 / 下一次预取后可见**（Monaco 在停笔与折叠态变化时
 * 都会重问）。头注这一句是口径，不是借口：作者打字一次就够了，而"在槽里 await"会让整条
 * 语言服务从同步变异步，那是另一场改造。
 *
 * ## 失败面：一律空快照，绝不抛
 *
 * worker 不可用 / 超时 / 崩溃 / `folds.scm` 缺席（`query-unavailable`）⇒ 存**空快照**并
 * `warn` 一次（同一 reason 只刷一条）。折叠是只读呈现面：失败不该变成问题面板里的噪音，
 * 也不该让编辑器抛异常。失败若带 `treeId`（查询失败但树已解出）仍留着，下一版继续增量。
 *
 * ## `@原生` 注入（LAU-6）
 *
 * 子树折叠（体内 IF/ENDIF 一类）与主树折叠**并集**；宿主节点账由语义面那一趟写下，这里按
 * **model + 版本号**取回（`injection.ts::recallInjectionHosts`），取不回就只给主树折叠。
 *
 * ## 注册
 *
 * 本文件**不注册任何 Monaco provider**（原生注册形状已清零）：折叠的注册在
 * `kojo-folding.ts` 的共享收口，预取的驱动在 `ui/editor-global-providers.ts` 那一段
 * 2.0 模型事件里（与项目索引同一处，见 `installKojo2FoldsCache` 的调用点）。
 */
import type * as Monaco from './entry';
import type { EditorFoldingRange } from '@kojo/plugin-api';
import { kojo2FoldingRangesFromWorkerFolds } from '@kojo/kojo-lang/folding';
import { KOJO2_INJECTIONS, KOJO2_LANGUAGE_ID } from './kojo2-language';
import { reportStructureDegradation } from './tree-sitter/fallback';
import type {
  Kojo2FoldRange,
  Kojo2FoldsReply,
  Kojo2WorkerResult,
} from './tree-sitter/kojo2-worker-protocol';
import type { InjectionSpec } from './tree-sitter/structure-runtime';
import type { InjectionHost, InjectionOutcome, InjectionRunRequest } from './tree-sitter/injection';

/**
 * 折叠区间上限不变式：唯一的上限是 Monaco 的 `foldingMaximumRegions`，宿主把它设成
 * `FOLDING_MAX_RANGES`（20,000；2026-10-28 之前吃的是 Monaco 自己的缺省 5,000）。
 * **本路自己不截**——原注释还写着"worker 侧已按 4,000 截过"，2026-10-28 全仓查无那处代码，
 * 不再复述（真要截，宁可截在宿主那条可见提示上，别静默）。超过上限由 Monaco 静默丢，
 * 所以上限必须与宿主同源，见 `editor-options.ts` 的 `foldingMaximumRegions`。
 */
type FoldRange = Kojo2FoldRange;

/** 空快照（"这一版没有折叠"；不 new 数组，消费方只读） */
const EMPTY_SNAPSHOT: readonly EditorFoldingRange[] = Object.freeze([]);

/**
 * 本文件对 worker 客户端的最小依赖面（结构类型：真 `Kojo2WorkerClient` 与测试替身都满足）。
 * 只要一个 `folds`：树怎么解、查询怎么跑，全在 worker 里。
 */
export interface Kojo2FoldingWorkerClient {
  folds(text: string, version: number, oldTreeId?: string): Promise<Kojo2WorkerResult<Kojo2FoldsReply>>;
}

/** 一次性告警表（同一 reason 只刷一条；与 `kojo2-semantic.ts` 同纪律） */
const warned = new Set<string>();

function warnOnce(warn: (message: string) => void, key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  warn(message);
}

/** 依赖注入缝（测试用；生产全部走缺省） */
export interface Kojo2FoldsCacheDeps {
  /**
   * 取 worker 客户端（缺省 = 动态 import `kojo2-worker-runtime` 的单例）。
   * 动态 import 让**主线程静态图里连薄客户端都不出现**：没人要结构层时，
   * `?worker` 入口与协议模块一个字节都不装载。
   */
  readonly getClient?: () => Kojo2FoldingWorkerClient | Promise<Kojo2FoldingWorkerClient>;
  /** 告警出口（缺省 `console.warn`；测试可收账） */
  readonly warn?: (message: string) => void;
  /** `@原生` 注入声明（LAU-6；缺省 = `KOJO2_INJECTIONS`）。空数组 = 不合并子树折叠。 */
  readonly injections?: readonly InjectionSpec[];
  /** 取回宿主节点账（测试注入缝；缺省 = 动态 import `injection.ts`） */
  readonly recallInjectionHosts?: (
    model: Monaco.editor.ITextModel,
    version: number,
  ) => Promise<readonly InjectionHost[] | null>;
  /** 子 parse 执行器（测试注入缝；缺省 = 动态 import `injection.ts`，与语义面共用同一趟） */
  readonly runInjection?: (model: Monaco.editor.ITextModel, request: InjectionRunRequest) => Promise<InjectionOutcome>;
}

/** 缺省客户端：懒到第一次真折叠才把 worker 模块拉进来 */
async function defaultWorkerClient(): Promise<Kojo2FoldingWorkerClient> {
  const module = await import('./tree-sitter/kojo2-worker-runtime');
  return module.getKojo2WorkerClient();
}

/** 缺省宿主节点账：动态 import 注入模块（静态图上限，理由同语义面） */
async function defaultRecallInjectionHosts(
  model: Monaco.editor.ITextModel,
  version: number,
): Promise<readonly InjectionHost[] | null> {
  const module = await import('./tree-sitter/injection');
  return module.recallInjectionHosts(model, version);
}

/** 缺省子 parse 执行器：与语义面**共用同一趟**（`runInjectionForModel` 的 model+版本缓存） */
async function defaultRunInjection(
  model: Monaco.editor.ITextModel,
  request: InjectionRunRequest,
): Promise<InjectionOutcome> {
  const module = await import('./tree-sitter/injection');
  return module.runInjectionForModel(model, request);
}

/** 一版快照（缓存条目；`versionId` 对不上 = 陈旧，不许交给请求） */
interface SnapshotEntry {
  readonly versionId: number;
  /** worker 交回的树号（下一版的增量基准；`null` = 上次失败且 worker 没交出可用的树） */
  readonly treeId: string | null;
  readonly ranges: readonly EditorFoldingRange[];
}

/** 预取器：**只做预取与缓存**，不注册、不翻译 Monaco 形状 */
export interface Kojo2FoldsCache {
  /**
   * 同步取**这一版**的快照；陈旧 / 未命中 ⇒ `undefined`，顺带把预取踢进后台（不等待）。
   *
   * 非 kojo2 模型在这里早退（`prefetch` 的语言门）——共享折叠 provider 对 ERB / kojo1 也会问，
   * 不能因为"被问了一次"就让 kojo2 的 worker 去解一份 ERB。
   */
  snapshotFor(model: Monaco.editor.ITextModel): readonly EditorFoldingRange[] | undefined;
  /** 显式预取（模型事件 / 测试用）。同版本同一份在飞时复用同一个 promise，不重发请求。 */
  prefetch(model: Monaco.editor.ITextModel): Promise<void>;
  /** 丢掉一份 model 的缓存（model 释放时调；幂等） */
  forget(model: Monaco.editor.ITextModel): void;
  /** 幂等：丢弃全部缓存，之后的 `prefetch` 变空操作（在飞的那次结果也不再落账） */
  dispose(): void;
}

/**
 * 造一个预取器（不注册、不挂监听；驱动见 {@link installKojo2FoldsCache}）。
 *
 * 失败面全部收在内部：任何异常都落空快照，调用方永远看不到 throw。
 */
export function createKojo2FoldsCache(deps: Kojo2FoldsCacheDeps = {}): Kojo2FoldsCache {
  const getClient = deps.getClient ?? defaultWorkerClient;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const injectionSpecs = deps.injections ?? KOJO2_INJECTIONS;
  const recallInjectionHosts = deps.recallInjectionHosts ?? defaultRecallInjectionHosts;
  const runInjection = deps.runInjection ?? defaultRunInjection;
  /** model → 上一版的树号与快照（`WeakMap`：标签关掉、model 释放后自然可回收） */
  let cache = new WeakMap<Monaco.editor.ITextModel, SnapshotEntry>();
  /** model → 在飞的那一次（同版本复用；版本变了就换人） */
  let inflight = new WeakMap<Monaco.editor.ITextModel, { versionId: number; promise: Promise<void> }>();
  let disposed = false;

  const compute = async (model: Monaco.editor.ITextModel, versionId: number): Promise<void> => {
    const cached = cache.get(model);
    if (model.isDisposed()) {
      cache.delete(model);
      return;
    }
    const text = model.getValue();
    const lineCount = model.getLineCount();
    const store = (treeId: string | null, folds: readonly FoldRange[] | null): void => {
      if (disposed || model.isDisposed()) {
        if (model.isDisposed()) cache.delete(model);
        return;
      }
      const ranges =
        folds === null ? EMPTY_SNAPSHOT : kojo2FoldingRangesFromWorkerFolds(folds, lineCount);
      cache.set(model, { versionId, treeId, ranges });
    };

    let client: Kojo2FoldingWorkerClient;
    try {
      client = await getClient();
    } catch (error: unknown) {
      warnOnce(
        warn,
        'client:load',
        `[kojo2-folding] 结构客户端装载失败（本轮不提供折叠区间）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      store(null, null);
      return;
    }
    if (disposed) return;
    let result: Kojo2WorkerResult<Kojo2FoldsReply>;
    try {
      result = await client.folds(text, versionId, cached?.treeId ?? undefined);
    } catch (error: unknown) {
      // 最后一道兜底：client 自己抛（而不是回 `ok:false`）时也不许穿到模型事件循环里。
      warnOnce(
        warn,
        'client:throw',
        `[kojo2-folding] 结构客户端抛错（本轮不提供折叠区间）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      store(null, null);
      return;
    }
    if (disposed) return;
    if (!result.ok) {
      warnOnce(
        warn,
        `worker:${result.reason}`,
        `[kojo2-folding] 结构解析不可用（${result.reason}）：${result.message} ⇒ 本轮不提供折叠区间`,
      );
      // worker 明确交回了树号（查询失败但树已解出）⇒ 下一版继续增量；否则归零。
      store(result.treeId ?? null, null);
      return;
    }
    let folds: readonly FoldRange[] = result.value.folds;
    // LAU-6：子树折叠（体内 IF/ENDIF 一类）与主树折叠**并集**。宿主节点账来自语义面那一趟
    // （同一 model 同一版本）；取不回就只给主树折叠——不为了折叠再问一遍 kojo2 worker。
    if (injectionSpecs.length > 0) {
      try {
        const hosts = await recallInjectionHosts(model, versionId);
        if (hosts !== null && hosts.length > 0) {
          const outcome = await runInjection(model, { text, version: versionId, specs: injectionSpecs, hosts });
          if (outcome.ok) {
            folds = [...folds, ...outcome.folds];
          } else {
            warnOnce(
              warn,
              `injection:${outcome.reason}`,
              `[kojo2-folding] 注入子解析不可用（${outcome.reason}）：${outcome.message} ⇒ 只给主树折叠`,
            );
            reportStructureDegradation({
              capability: 'folds',
              stage: 'parse',
              message: `@原生 体内的子解析这次没顶上（${outcome.reason}）：${outcome.message}`,
              code: 'core/injection/child-failed',
            });
          }
        }
      } catch (error: unknown) {
        warnOnce(
          warn,
          'injection:internal',
          `[kojo2-folding] 注入折叠内部异常（本轮只给主树折叠）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    store(result.value.treeId, folds);
  };

  const prefetch = (model: Monaco.editor.ITextModel): Promise<void> => {
    if (disposed || model.isDisposed()) return Promise.resolve();
    // 只认 2.0：共享折叠 provider 对 ERB / kojo1 也会问，别让 kojo2 的 worker 去解别人的文本。
    if (model.getLanguageId() !== KOJO2_LANGUAGE_ID) return Promise.resolve();
    const versionId = model.getVersionId();
    const hit = cache.get(model);
    if (hit !== undefined && hit.versionId === versionId) return Promise.resolve();
    const running = inflight.get(model);
    if (running !== undefined && running.versionId === versionId) return running.promise;
    const promise = compute(model, versionId)
      .catch((error: unknown) => {
        // `compute` 内部已逐段降级；走到这里说明是缓存层的意外（取文 / 取行数）。
        warnOnce(
          warn,
          `internal:${error instanceof Error ? error.message : String(error)}`,
          `[kojo2-folding] 预取内部异常（本轮没有折叠，编辑器不受影响）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        const current = inflight.get(model);
        if (current !== undefined && current.promise === promise) inflight.delete(model);
      });
    inflight.set(model, { versionId, promise });
    return promise;
  };

  return {
    snapshotFor(model) {
      if (disposed || model.isDisposed()) return undefined;
      const hit = cache.get(model);
      if (hit !== undefined && hit.versionId === model.getVersionId()) return hit.ranges;
      // 未命中 / 陈旧：这一轮答空，预取踢进后台（下一次被问、下一版内容变化后可见）。
      void prefetch(model);
      return undefined;
    },
    prefetch,
    forget(model) {
      cache.delete(model);
      inflight.delete(model);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cache = new WeakMap();
      inflight = new WeakMap();
    },
  };
}

/* ============================== 装配：全局那一枚 ============================== */

/**
 * 当前生效的预取器（组合根挂一枚；`null` = 没装，折叠腿照旧走"没有快照 ⇒ 空"）。
 *
 * 为什么是模块单例而不是参数一路传：折叠的请求构造点在 `ui/editor-global-providers.ts`
 * 的 `readFoldingRanges`（共享收口那一枚 provider 的回调），它拿不到组合根的局部变量；
 * 而要传进来就得把 `installFoldingRangeProvider` 的签名长出第二套，ERB 那一路跟着改。
 */
let activeCache: Kojo2FoldsCache | null = null;

/**
 * 装一枚全局预取器（装配点调一次；返回的句柄把账收干净）。
 *
 * **本函数不注册任何 provider**：注册在 `kojo-folding.ts` 的共享收口（按 descriptor 铺
 * 语言，kojo2 由 `slotServices: ['foldingRange']` 点名）。模型事件的驱动在装配点那一段
 * 2.0 模型监听里（与项目索引同一处）——那边已经有"只认 kojo2 model"的判据，不在这里
 * 另造第二份名单。
 */
export function installKojo2FoldsCache(deps: Kojo2FoldsCacheDeps = {}): Monaco.IDisposable {
  const cache = createKojo2FoldsCache(deps);
  const previous = activeCache;
  activeCache = cache;
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (activeCache === cache) activeCache = previous;
      cache.dispose();
    },
  };
}

/**
 * **预取口**（模型事件驱动用）：打开 / 改动后踢一次，不等待、不抛。
 *
 * 只认 2.0 model（判定在 `prefetch` 里，装配点不需要第二份名单）。
 */
export function prefetchKojo2Folds(model: Monaco.editor.ITextModel): void {
  const cache = activeCache;
  if (cache === null) return;
  void cache.prefetch(model);
}

/**
 * **请求构造点**用的取快照口：这一版有快照就给，否则 `undefined`（并踢一次预取）。
 *
 * 没装预取器（测试 / 旧装配）⇒ `undefined`：折叠腿答空，一切照旧。
 */
export function kojo2FoldsSnapshotFor(
  model: Monaco.editor.ITextModel,
): readonly EditorFoldingRange[] | undefined {
  const cache = activeCache;
  if (cache === null) return undefined;
  return cache.snapshotFor(model);
}
