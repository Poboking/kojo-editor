/**
 * Kojo 2.0 的 **Monaco 折叠 provider**（K2-FOLD-INDENT 批）：worker 的 `folds` 查询 →
 * `FoldingRange`。
 *
 * ## 数据链（每一层只回答一件事）
 *
 * `getKojo2WorkerClient()`（主线程薄客户端）→ `folds(text, version, oldTreeId?)`
 * （worker 内 `queries/v2/folds.scm` 的 `(block) @fold` 已经跑完）→
 * `foldsFromCaptures`（worker 侧：只留跨行、去重、排序，**0 基行**）→ 本文件的
 * {@link toMonacoFoldingRanges}（**0 基 → 1 基**，过滤越界 / 倒置 / 重复）→ Monaco。
 *
 * 本文件**不碰 wasm、不读查询、不懂 tree-sitter 节点**：它只认 worker 回复里的 `treeId`
 * （与 `kojo2-semantic.ts` 同一条所有权口径）——上一版交回去，worker 就能增量重解；本文件
 * 从不 `delete()` 树（树活在那条线程里，由 worker 的 LRU 收账）。
 *
 * ## 版本缓存（与语义着色同一条纪律，理由不同一条）
 *
 * 缓存键是 **model 版本号 + worker 交回的 `treeId`**。折叠 provider 被 Monaco 在**每次停笔 /
 * 每次折叠态变化**后重问；同一版本重复问直接命中（不重发请求），版本变了才把上一版 `treeId`
 * 交给 worker（否则 worker 每次都要整篇重解一棵树，纯属白烧）。失败那一版同样进缓存
 * （同版本不反复重试），但 `treeId` 只在 worker 明确交回时才留。
 *
 * 与 `kojo2-semantic.ts` 的一处刻意不同：**不做 `serialize` 队列**。语义着色的并发会让
 * "哪一版上屏"不可预测（同一批 token 被两份回复抢），而折叠每条回复都自带版本号、
 * 每个 model 只认自己那一格缓存，先后到达不改变任何已定的答案；worker 侧本来也按到达序
 * 串行处理。多一条队列只会让折叠比作者的编辑慢一拍。
 *
 * ## 失败面：一律 `[]`，绝不抛、绝不写 markers
 *
 * worker 不可用 / 超时 / 崩溃 / `folds.scm` 缺席（`query-unavailable`）⇒ 返回 `[]`（"这一轮
 * 没有折叠"），并 `warn` 一次（同一 reason 只刷一条）。折叠是只读呈现面：失败不该变成问题
 * 面板里的噪音，也不该让编辑器抛异常——Monaco 把 provider 的 throw 吞成"折叠突然没了"，
 * 作者看不到任何原因。
 *
 * ## 注册
 *
 * {@link installKojo2FoldingProvider} 只给 `kojo2` 语言 id 注册（v1 的 `.kojo` / `.erb` 面由
 * `kojo-folding.ts` 各挂各的，两边不重叠）；**flag 关时零注册**（调用点在
 * `ui/editor-global-providers.ts` 的 2.0 段里，本函数自身也再挡一次，因为它是导出的）。
 * disposal 幂等：先撤 provider 注册，再丢本 provider 的版本缓存（worker 客户端是共享单例，
 * **不**在这里 dispose）。
 */
import type * as Monaco from './entry';
import { KOJO2_LANGUAGE_ID } from './kojo2-language';
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';
import type {
  Kojo2FoldRange,
  Kojo2FoldsReply,
  Kojo2WorkerResult,
} from './tree-sitter/kojo2-worker-protocol';

/** 折叠区间上限不变式：Monaco 的 `foldingMaximumRegions` 缺省 5,000，worker 侧已按 4,000 截过 */
type FoldRange = Kojo2FoldRange;

/** 空结果（"这一轮没有折叠"；不 new 数组，Monaco 只读） */
const EMPTY_RANGES: Monaco.languages.FoldingRange[] = [];

/** flag 关时交回的句柄（调用方照常 `dispose()`，什么也不会发生） */
const NOOP_DISPOSABLE: Monaco.IDisposable = { dispose: () => undefined };

/* ============================== 0 基 → 1 基 ============================== */

/**
 * worker 的折叠区间（**0 基行**，`endRow > startRow` 才存在）→ Monaco `FoldingRange`
 * （**1 基行**，`end > start` 才可折）。
 *
 * 四道过滤，每道都是"陈旧的回复不许画到当下的文本上"：
 * - 非有限数 / 非整数 ⇒ 丢（worker 不该发，但 provider 是最后一道闸）；
 * - `start < 0` 或 `end >= lineCount` ⇒ 丢（**越界不夹取**：回复可能对应上一版文本，
 *   夹到边界会折错行；不折比折错好）；
 * - `end <= start` ⇒ 丢（没有可隐藏的行，留着只会让 gutter 出一个折不动的假箭头）；
 * - 重复区间 ⇒ 只留第一枚（worker 已去重；这里是防直接调用方）。
 *
 * 排序与 worker / v1 `toMonacoFoldingRanges` 同口径：起点升序、同起点终点降序（外层块在前）。
 */
export function toMonacoFoldingRanges(
  folds: readonly FoldRange[] | null | undefined,
  lineCount: number,
): Monaco.languages.FoldingRange[] {
  if (!Array.isArray(folds)) return [];
  const limit = Number.isFinite(lineCount) ? Math.trunc(lineCount) : 0;
  if (limit < 1) return [];
  const out: Monaco.languages.FoldingRange[] = [];
  const seen = new Set<string>();
  for (const fold of folds) {
    if (fold === null || typeof fold !== 'object') continue;
    const startRow = fold.startRow;
    const endRow = fold.endRow;
    if (!Number.isFinite(startRow) || !Number.isFinite(endRow)) continue;
    if (!Number.isInteger(startRow) || !Number.isInteger(endRow)) continue;
    if (startRow < 0 || endRow >= limit) continue;
    const start = startRow + 1;
    const end = endRow + 1;
    if (end <= start) continue;
    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ start, end });
  }
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  return out;
}

/* ============================== provider ============================== */

/**
 * 本 provider 对 worker 客户端的最小依赖面（结构类型：真 `Kojo2WorkerClient` 与测试替身都满足）。
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
export interface Kojo2FoldingProviderDeps {
  /**
   * 取 worker 客户端（缺省 = 动态 import `kojo2-worker-runtime` 的单例）。
   * 动态 import 让**主线程静态图里连薄客户端都不出现**：flag 关 / 没人要结构层时，
   * `?worker` 入口与协议模块一个字节都不装载。
   */
  readonly getClient?: () => Kojo2FoldingWorkerClient | Promise<Kojo2FoldingWorkerClient>;
  /** 告警出口（缺省 `console.warn`；测试可收账） */
  readonly warn?: (message: string) => void;
}

/** 缺省客户端：懒到第一次真折叠才把 worker 模块拉进来 */
async function defaultWorkerClient(): Promise<Kojo2FoldingWorkerClient> {
  const module = await import('./tree-sitter/kojo2-worker-runtime');
  return module.getKojo2WorkerClient();
}

/** provider + 它自己的资源账（Monaco 的 provider 接口没有 dispose 位） */
export interface Kojo2FoldingProviderHandle {
  readonly provider: Monaco.languages.FoldingRangeProvider;
  /** 幂等：丢掉本 provider 的版本缓存（worker 客户端是共享单例，不归这里管） */
  dispose(): void;
}

interface ModelCacheEntry {
  readonly versionId: number;
  /** worker 交回的树号（下一版的增量基准；`null` = 上次失败且 worker 没交出可用的树） */
  readonly treeId: string | null;
  readonly ranges: Monaco.languages.FoldingRange[];
}

/**
 * 造一个 2.0 折叠 provider（不注册；注册见 {@link installKojo2FoldingProvider}）。
 *
 * 失败面全部收在内部：任何异常都回空数组，调用方（Monaco）永远看不到 throw。
 */
export function createKojo2FoldingProvider(
  deps: Kojo2FoldingProviderDeps = {},
): Kojo2FoldingProviderHandle {
  const getClient = deps.getClient ?? defaultWorkerClient;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  /** model → 上一版的树号与区间（`WeakMap`：标签关掉、model 释放后自然可回收） */
  let cache = new WeakMap<Monaco.editor.ITextModel, ModelCacheEntry>();
  let disposed = false;

  const compute = async (model: Monaco.editor.ITextModel): Promise<Monaco.languages.FoldingRange[]> => {
    if (disposed) return EMPTY_RANGES;
    const versionId = model.getVersionId();
    const cached = cache.get(model);
    if (cached?.versionId === versionId) return cached.ranges;
    if (model.isDisposed()) {
      cache.delete(model);
      return EMPTY_RANGES;
    }

    const text = model.getValue();
    const client = await getClient();
    if (disposed) return EMPTY_RANGES;
    const result = await client.folds(text, versionId, cached?.treeId ?? undefined);
    if (disposed) return EMPTY_RANGES;
    if (model.isDisposed()) {
      cache.delete(model);
      return EMPTY_RANGES;
    }
    if (!result.ok) {
      warnOnce(
        warn,
        `worker:${result.reason}`,
        `[kojo2-folding] 结构解析不可用（${result.reason}）：${result.message} ⇒ 本轮不提供折叠区间`,
      );
      // worker 明确交回了树号（查询失败但树已解出）⇒ 下一版继续增量；否则归零。
      cache.set(model, { versionId, treeId: result.treeId ?? null, ranges: EMPTY_RANGES });
      return EMPTY_RANGES;
    }
    const ranges = toMonacoFoldingRanges(result.value.folds, model.getLineCount());
    cache.set(model, { versionId, treeId: result.value.treeId, ranges });
    return ranges;
  };

  const provider: Monaco.languages.FoldingRangeProvider = {
    provideFoldingRanges(model) {
      if (disposed || model.isDisposed()) return EMPTY_RANGES;
      return compute(model).then(
        (ranges) => ranges,
        (error: unknown) => {
          // 最后一道兜底：compute 内部已逐段降级，走到这里说明是缓存/映射层的意外。
          warnOnce(
            warn,
            `internal:${error instanceof Error ? error.message : String(error)}`,
            `[kojo2-folding] 折叠内部异常（本轮没有折叠，编辑器不受影响）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return EMPTY_RANGES;
        },
      );
    },
  };

  return {
    provider,
    dispose() {
      if (disposed) return;
      disposed = true;
      cache = new WeakMap();
    },
  };
}

/**
 * 为 `kojo2` 语言注册折叠 provider（**flag 关 = 零注册**）。
 *
 * 返回的 disposable 幂等：撤掉 Monaco 注册，再丢 provider 的版本缓存（worker 客户端是
 * 共享单例，留给其它结构层消费方，不在这里 dispose）。
 */
export function installKojo2FoldingProvider(
  monaco: typeof Monaco,
  deps: Kojo2FoldingProviderDeps = {},
): Monaco.IDisposable {
  if (!isKojo2CutoverEnabled()) {
    return NOOP_DISPOSABLE;
  }
  const handle = createKojo2FoldingProvider(deps);
  let registration: Monaco.IDisposable;
  try {
    registration = monaco.languages.registerFoldingRangeProvider(KOJO2_LANGUAGE_ID, handle.provider);
  } catch (error) {
    // 注册失败 = 这一枚根本没挂上；把 provider 自己的账先收了再外抛，
    // 由 `ensureGlobalProviders` 的"全有或全无"统一回滚（错误不许在这里吞掉）。
    handle.dispose();
    throw error;
  }
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        registration.dispose();
      } finally {
        handle.dispose();
      }
    },
  };
}
