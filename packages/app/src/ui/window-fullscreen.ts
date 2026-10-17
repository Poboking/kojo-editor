/**
 * 窗口全屏的宿主接线（用户反馈第 2 条：全屏化后系统标题栏消失，需要自定义顶栏）。
 *
 * 零 React、零插件依赖，只做三件事：读一次全屏态 / 订阅它的变化 / 切一下。
 * Tauri 面经 `WindowBackend` 注入（与 `window-close-guard.ts` 同一形态的 seam）：
 * 只有缺省实现才动态 import `@tauri-apps/api/window`，node 测试喂假实现即可跑。
 *
 * 浏览器 dev（无壳）一律安全 no-op：不碰 Tauri API、不抛错、顶栏自然不出现。
 */

import { isTauri } from '../bridge/invoke';

/** 本模块用到的最小窗口面（`getCurrentWindow()` 的结构子集） */
export interface FullscreenWindow {
  isFullscreen(): Promise<boolean>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  /** 监听窗口尺寸变化（进出全屏在 Windows 上表现为一次 resize） */
  onResized(handler: () => void): Promise<() => void>;
}

/** Tauri 依赖注入 seam（缺省 = 真壳；测试 = 假实现） */
export interface WindowBackend {
  isShell(): boolean;
  getWindow(): Promise<FullscreenWindow>;
}

/** 缺省后端：动态 import 让浏览器 dev 完全不碰 Tauri 运行时 */
export const TAURI_WINDOW_BACKEND: WindowBackend = {
  isShell: isTauri,
  getWindow: async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow();
  },
};

/** 失败只留一句 warn：不弹窗、不把异常漏进 React 事件循环 / effect */
function warn(action: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[window-fullscreen] ${action}失败：${reason}`);
}

/**
 * 对当前窗口执行一次动作。
 * 非壳环境直接返回；取窗口或动作本身失败都只 warn（保持调用方无分支）。
 */
async function runWindowAction(
  backend: WindowBackend,
  action: string,
  work: (win: FullscreenWindow) => Promise<void>,
): Promise<void> {
  if (!backend.isShell()) return;
  try {
    await work(await backend.getWindow());
  } catch (error: unknown) {
    warn(action, error);
  }
}

/** F11 / 命令面板入口：先读当前态再翻转 */
export async function toggleFullscreen(backend: WindowBackend = TAURI_WINDOW_BACKEND): Promise<void> {
  await runWindowAction(backend, '切换全屏', async (win) => {
    await win.setFullscreen(!(await win.isFullscreen()));
  });
}

/** 顶栏「退出全屏」按钮 */
export async function exitFullscreen(backend: WindowBackend = TAURI_WINDOW_BACKEND): Promise<void> {
  await runWindowAction(backend, '退出全屏', async (win) => {
    await win.setFullscreen(false);
  });
}

/** 顶栏「最小化」按钮 */
export async function minimizeWindow(backend: WindowBackend = TAURI_WINDOW_BACKEND): Promise<void> {
  await runWindowAction(backend, '最小化窗口', (win) => win.minimize());
}

/** 双击顶栏 = 最大化 / 还原（全屏下由系统决定是否生效） */
export async function toggleMaximize(backend: WindowBackend = TAURI_WINDOW_BACKEND): Promise<void> {
  await runWindowAction(backend, '切换最大化', (win) => win.toggleMaximize());
}

/** 顶栏「关闭」按钮：走原生 close（App 侧的关窗守卫照常拦脏修改） */
export async function closeWindow(backend: WindowBackend = TAURI_WINDOW_BACKEND): Promise<void> {
  await runWindowAction(backend, '关闭窗口', (win) => win.close());
}

/**
 * 订阅全屏状态：先查一次（给初始值），再挂 resize 重查（进出全屏都会改窗口尺寸）。
 * 返回退订函数；非壳环境 / 订阅失败返回空退订，调用方无需分支。
 */
export async function subscribeFullscreen(
  onChange: (fullscreen: boolean) => void,
  backend: WindowBackend = TAURI_WINDOW_BACKEND,
): Promise<() => void> {
  if (!backend.isShell()) return () => {};
  let win: FullscreenWindow;
  try {
    win = await backend.getWindow();
  } catch (error: unknown) {
    warn('订阅全屏状态', error);
    return () => {};
  }
  const sync = async (): Promise<void> => {
    try {
      onChange(await win.isFullscreen());
    } catch (error: unknown) {
      warn('读取全屏状态', error);
    }
  };
  await sync();
  try {
    return await win.onResized(() => {
      void sync();
    });
  } catch (error: unknown) {
    warn('监听窗口尺寸', error);
    return () => {};
  }
}
