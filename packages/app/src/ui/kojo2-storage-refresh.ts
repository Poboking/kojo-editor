/**
 * K2-STORAGE-RECYCLED-UI（缺口②）：**会话内 `.kojo2` 声明变更 → 防抖 → 重算槽位账本**。
 *
 * ## 为什么需要这一层
 *
 * 账本原先只在项目打开时提交：会话里新增/改名一份 `.kojo2`，要关掉项目再打开才落账。
 * 这里听宿主既有的 `file.changed`（由 `App.tsx` 把事件路径递进 {@link Kojo2DeclRefresh.noteChange}），
 * 只对 `.kojo2` 起表，窗口内的多条改动合并成一次 `refreshDeclarations`。
 *
 * ## 三条纪律
 *
 * 1. **零 React / 零 IO**：路径判据、文档列举、计时器全由宿主注入；node 测试用假时钟
 *    钉住「debounce 合并 / 离开项目不触发」。
 * 2. **不自己重开机**：重算走服务的 `refreshDeclarations`——那条路 fail-closed 且
 *    **失败不拆已 opened 实例**（见服务注释）；这里绝不调 `openProject`/`closeProject`。
 * 3. **离开项目即停机**：`dispose()` 取消挂起的窗口；已经开始 collect 的那一拍在 await
 *    之后检查 `disposed`，迟到的刷新一个字节都不会写。
 *
 * `collect` 的失败（走目录读不动等）只通过 `onFailure` 上屏一次，不抛给事件总线；服务
 * 自己的失败面（入参/水合/规划/recycled）仍由服务照既有路径上屏，本模块不重复弹。
 */
import type { Kojo2StorageDocument } from './kojo2-storage-registry';
import { isKojo2Path as defaultIsKojo2Path } from './kojo2-open';

/** 一次重算需要的文档事实（与 `Kojo2StorageRefreshInput` 同形） */
export interface Kojo2DeclRefreshBatch {
  readonly documents: readonly Kojo2StorageDocument[];
  readonly documentsComplete: boolean;
}

/** 本模块对服务的唯一依赖面（结构上是 `Kojo2StorageService` 的子集） */
export interface Kojo2DeclRefreshService {
  refreshDeclarations(input: {
    readonly documents: readonly Kojo2StorageDocument[];
    readonly documentsComplete?: boolean;
  }): Promise<{ readonly kind: string }>;
}

/** 计时器端口（缺省 `globalThis`；测试注入手动调度器或配合假时钟） */
export interface Kojo2DeclRefreshScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Kojo2DeclRefreshOptions {
  readonly service: Kojo2DeclRefreshService;
  /** 按项目口上根 ∪ 会话附加根重列 `.kojo2` 并读文本（宿主既有 io 口径） */
  readonly collect: () => Promise<Kojo2DeclRefreshBatch> | Kojo2DeclRefreshBatch;
  /** 路径判据（缺省 `isKojo2Path`，与语言层 descriptor 同一条） */
  readonly isKojo2Path?: (path: string) => boolean;
  /** 防抖窗口（缺省 {@link KOJO2_DECL_REFRESH_DEBOUNCE_MS}；负值归 0，非数回缺省） */
  readonly debounceMs?: number;
  readonly scheduler?: Kojo2DeclRefreshScheduler;
  /** collect / 服务调用抛错时的人话通道（缺省 console.error；只报一次） */
  readonly onFailure?: (message: string) => void;
}

export interface Kojo2DeclRefreshSnapshot {
  readonly disposed: boolean;
  /** 防抖窗口里是否有一次待跑 */
  readonly pending: boolean;
  /** 是否正在 collect / 提交 */
  readonly inFlight: boolean;
  /** 收到过多少条相关 `.kojo2` 变更（非 2.0 路径不计） */
  readonly changeCount: number;
  /** 真正发起过多少次刷新（以服务返回为准，抛错不算） */
  readonly refreshCount: number;
  /** 最近一次服务结果 kind（null = 还没跑过） */
  readonly lastKind: string | null;
}

export interface Kojo2DeclRefresh {
  /** 一条 `file.changed` 路径：非 `.kojo2` / 已 dispose ⇒ 零动作；否则重置防抖窗口 */
  noteChange(path: string): void;
  /** 立即跑掉挂起的那一拍（离开项目收尾 / 测试）；返回是否真的发起了一次刷新 */
  flushNow(): Promise<boolean>;
  /**
   * 等当前这一拍结束（**永不 reject**）。`dispose()` 不取消已经发出的服务调用
   * （服务是异步的），宿主关项目前必须等它落地，否则 `closeProject` 会拿到 busy。
   */
  whenIdle(): Promise<void>;
  /** 取消挂起窗口并永久停机（离开项目） */
  dispose(): void;
  getSnapshot(): Kojo2DeclRefreshSnapshot;
}

/** 声明变更合并窗口：与 `file.changed` 消费方（文件树 400ms）同量级，不抢跑 */
export const KOJO2_DECL_REFRESH_DEBOUNCE_MS = 300;

const defaultScheduler: Kojo2DeclRefreshScheduler = {
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function freezeBatch(batch: Kojo2DeclRefreshBatch): Kojo2DeclRefreshBatch {
  return Object.freeze({
    documents: Object.freeze([...batch.documents]),
    documentsComplete: batch.documentsComplete === true,
  });
}

/**
 * 装配一个防抖刷新器（一个实例 = 一个项目会话；`dispose` 后不可复活）。
 *
 * 同一时刻最多一次刷新在飞：飞行中又来变更只记 `rerun`，等这一拍结束后重新进防抖窗口
 * （不并发调服务——服务本来也会回 busy，但在这里合掉可以少一条「无事发生」）。
 */
export function createKojo2DeclRefresh(
  options: Kojo2DeclRefreshOptions,
): Kojo2DeclRefresh {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('Kojo 2.0 声明刷新：createKojo2DeclRefresh 需要 options 对象');
  }
  if (typeof options.collect !== 'function') {
    throw new TypeError('Kojo 2.0 声明刷新：options.collect 必须是函数');
  }
  if (options.service === null || typeof options.service !== 'object') {
    throw new TypeError('Kojo 2.0 声明刷新：options.service 必须是槽位账本服务');
  }
  const service = options.service;
  const collect = options.collect;
  const isKojo2Path = options.isKojo2Path ?? defaultIsKojo2Path;
  const debounceMs =
    options.debounceMs === undefined
      ? KOJO2_DECL_REFRESH_DEBOUNCE_MS
      : Number.isFinite(options.debounceMs)
        ? Math.max(0, options.debounceMs)
        : KOJO2_DECL_REFRESH_DEBOUNCE_MS;
  const scheduler = options.scheduler ?? defaultScheduler;
  const onFailure = options.onFailure;

  let timer: unknown = null;
  let disposed = false;
  let inFlight = false;
  let rerun = false;
  /** 当前这一拍（`dispose` 不取消它；宿主关项目前用 `whenIdle` 等它落地） */
  let running: Promise<boolean> | null = null;
  let changeCount = 0;
  let refreshCount = 0;
  let lastKind: string | null = null;

  function fail(error: unknown): void {
    const message =
      `Kojo 2.0 槽位账本：会话内声明刷新失败（已打开的账本原样保留）：${errorText(error)}`;
    if (onFailure !== undefined) {
      try {
        onFailure(message);
        return;
      } catch (nested) {
        console.error('[kojo2-storage-refresh] 失败通道自身抛错：', nested);
      }
    }
    console.error('[kojo2-storage-refresh]', message);
  }

  function schedule(): void {
    if (disposed) return;
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = scheduler.setTimeout(() => {
      timer = null;
      void start();
    }, debounceMs);
  }

  /** 实际跑一拍；不负责 rerun 调度（那是 {@link start} 的事） */
  async function run(): Promise<boolean> {
    if (disposed) return false;
    inFlight = true;
    try {
      const batch = freezeBatch(await collect());
      // 离开项目 / 迟到的 collect：不再写账本
      if (disposed) return false;
      const result = await service.refreshDeclarations({
        documents: batch.documents,
        documentsComplete: batch.documentsComplete,
      });
      if (disposed) return false;
      refreshCount += 1;
      lastKind = result.kind;
      return true;
    } catch (error) {
      fail(error);
      return false;
    } finally {
      inFlight = false;
    }
  }

  /**
   * 单飞：同一时刻只有一拍在飞；飞行中再触发只记 `rerun`，结束后重新进防抖窗口。
   * 返回的是「这一拍」的 promise（飞行中触发时不会另起一次并发调用）。
   */
  function start(): Promise<boolean> {
    if (running !== null) {
      rerun = true;
      return running.then(
        () => false,
        () => false,
      );
    }
    const current = run().finally(() => {
      if (running === current) running = null;
      if (!disposed && rerun) {
        rerun = false;
        schedule();
      }
    });
    running = current;
    return current;
  }

  function noteChange(path: string): void {
    if (disposed) return;
    if (typeof path !== 'string' || !isKojo2Path(path)) return;
    changeCount += 1;
    schedule();
  }

  async function flushNow(): Promise<boolean> {
    if (disposed) return false;
    if (timer === null && running === null) return false; // 没有挂起的一拍：不凭空刷一次
    if (timer !== null) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
    if (running !== null) {
      rerun = true;
      return false;
    }
    return start();
  }

  async function whenIdle(): Promise<void> {
    const current = running;
    if (current === null) return;
    await current.then(
      () => undefined,
      () => undefined,
    );
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (timer !== null) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
    rerun = false;
  }

  return Object.freeze({
    noteChange,
    flushNow,
    whenIdle,
    dispose,
    getSnapshot(): Kojo2DeclRefreshSnapshot {
      return Object.freeze({
        disposed,
        pending: timer !== null,
        inFlight,
        changeCount,
        refreshCount,
        lastKind,
      });
    },
  });
}
