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
 * - 无脏 → 不拦，原生关闭即退出（没有可丢失的东西）；
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
}

export type WindowCloseVerdict = 'pass' | 'confirm';

/** 分流判据：已批准或无脏 → 放行原生关闭；有脏且未批准 → 拦下弹确认 */
export function classifyWindowClose(approved: boolean, hasDirty: boolean): WindowCloseVerdict {
  return approved || !hasDirty ? 'pass' : 'confirm';
}

/** 安装关窗守卫，返回退订函数（组件卸载时调用） */
export async function installWindowCloseGuard(
  bridge: WindowCloseBridge,
  deps: { isApproved(): boolean; hasDirty(): boolean; onConfirm(): void },
): Promise<() => void> {
  const handler = (event: WindowCloseEvent): void => {
    if (classifyWindowClose(deps.isApproved(), deps.hasDirty()) === 'pass') return;
    event.preventDefault();
    deps.onConfirm();
  };
  const unlisten = await bridge.onCloseRequested(handler);
  return typeof unlisten === 'function' ? unlisten : () => {};
}
