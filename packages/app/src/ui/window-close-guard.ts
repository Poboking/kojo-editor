/**
 * Alt+F4 / 关窗守卫（2026-10-16 深审 A2）。
 *
 * 旧现状：全 src 没有 onCloseRequested/beforeunload——任一标签脏时按 Alt+F4，
 * EditorPane 卸载 dispose 全部 model，修改静默丢弃。
 *
 * Tauri v2 语义：`onCloseRequested` 的 handler 不调 `event.preventDefault()`
 * 窗口就直接关。守卫对每一次关闭请求做三态分流：
 * - 已批准（`isApproved()`：确认框走完、关项目完成后的主动 `close()`）→ 不拦，
 *   原生关闭继续 = 应用退出；
 * - 无脏 → 放行原生关闭即退出（没有可丢失的东西）；**但**给了 `beforeClose` 就
 *   先拦下、等它走完、再由守卫主动 `close()`（E·R6：等索引快照那笔 fire-and-forget 的写）；
 * - 有脏且未批准 → `preventDefault()` 拦下 + `onConfirm()`（调用方弹关项目
 *   确认框；批准后关项目 → 置放行 → 主动 `close()` 走本 handler 的放行支）。
 *
 * 退出通道刻意不用 `@tauri-apps/api/process`（v2 核心无此模块，process 是独立
 * 插件），而是「放行原生 close」——零 Rust 改动，capabilities 只加一行
 * `core:window:allow-close`（JS 主动 close 的最小授权）。
 *
 * Tauri 依赖经 `WindowCloseBridge` 注入：本模块零 @tauri-apps/api 导入，node 侧
 * 可独立单测（接线语义与分流判据都在这里，React 侧只剩装配）。
 */
export interface WindowCloseEvent {
  preventDefault(): void;
}

export interface WindowCloseBridge {
  /** 注册"窗口即将被关闭"监听；返回退订函数（同步或包在 Promise 里均可） */
  onCloseRequested(handler: (event: WindowCloseEvent) => void | Promise<void>): Promise<() => void> | (() => void) | void;
  /**
   * 主动关闭窗口（E·R6：放行前要等落盘，等完由守卫自己再关一次）。
   * 缺这条 = 不做放行前动作，按老行为直接放行原生关闭。
   */
  close?(): Promise<void> | void;
}

export type WindowCloseVerdict = 'pass' | 'confirm';

/** 分流判据：已批准或无脏 → 放行原生关闭；有脏且未批准 → 拦下弹确认 */
export function classifyWindowClose(approved: boolean, hasDirty: boolean): WindowCloseVerdict {
  return approved || !hasDirty ? 'pass' : 'confirm';
}

export interface WindowCloseDeps {
  isApproved(): boolean;
  hasDirty(): boolean;
  onConfirm(): void;
  /**
   * 放行前的最后一道活（E·R6：等在途存储写落地，见 `Kernel.flushStorage`）。
   *
   * 有它就一定走"拦下 → 等 → 自己再 close 一次"这条路：写盘窗口实测 0.7s 起，
   * 不等这一下，整轮索引的产物会随进程一起消失。等多久由这条函数自己封顶
   * （守卫不设第二道上限——上限属于业务，见 `CLOSE_FLUSH_BUDGET_MS`）。
   * 抛错也照旧放行：关不掉的窗口比丢一次缓存严重得多。
   */
  beforeClose?(): Promise<void> | void;
}

/** 安装关窗守卫，返回退订函数（组件卸载时调用） */
export async function installWindowCloseGuard(
  bridge: WindowCloseBridge,
  deps: WindowCloseDeps,
): Promise<() => void> {
  const handler = (event: WindowCloseEvent): void => {
    if (classifyWindowClose(deps.isApproved(), deps.hasDirty()) === 'confirm') {
      event.preventDefault();
      deps.onConfirm();
      return;
    }
    // 已批准（确认框走完 / 关项目完成后的主动 close）→ 立刻放行，且不再做任何事：
    // 否则 beforeClose 会在同一次退出里跑第二遍。
    if (deps.isApproved()) return;
    if (!deps.beforeClose || !bridge.close) return; // 老行为：放行原生关闭
    event.preventDefault();
    void Promise.resolve()
      .then(() => deps.beforeClose!())
      .catch(() => undefined)
      .finally(() => {
        void bridge.close!();
      });
  };
  const unlisten = await bridge.onCloseRequested(handler);
  return typeof unlisten === 'function' ? unlisten : () => {};
}
