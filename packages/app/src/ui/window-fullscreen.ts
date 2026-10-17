/**
 * 窗口全屏的宿主接线（用户反馈第 2 条：全屏化后系统标题栏消失，需要自定义顶栏）。
 *
 * 零 React、零插件依赖，只做四件事：读一次全屏态 / 订阅它的变化 / 切一下 / 顺手摘掉原生外框。
 * Tauri 面经 `WindowBackend` 注入（与 `window-close-guard.ts` 同一形态的 seam）：
 * 只有缺省实现才动态 import `@tauri-apps/api/window`，node 测试喂假实现即可跑。
 *
 * 为什么还要动 decorations：Windows 上 `setFullscreen(true)` 只切窗口样式；tao 的
 * WM_NCCALCSIZE 在 `MARKER_DECORATIONS` 仍为真时继续交给 DefWindowProc，只有无边框分支
 * 才返回整窗客户区。样式里残留的 sizing / 系统菜单位在某些窗口态（最大化、DPI 缩放）下
 * 会折算出一条原生标题栏白带，正好压在自定义顶栏上方。显式 `setDecorations(false)` 让
 * NCCALCSIZE 走无边框分支、再触发一次边框重算，才是干净的整窗客户区；退出时反过来把外框
 * 装回去，否则窗口态会变成没有标题栏的残态。
 *
 * 浏览器 dev（无壳）一律安全 no-op：不碰 Tauri API、不抛错、顶栏自然不出现。
 */

import { isTauri } from '../bridge/invoke';

/** 本模块用到的最小窗口面（`getCurrentWindow()` 的结构子集） */
export interface FullscreenWindow {
  isFullscreen(): Promise<boolean>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  /** 显示 / 收起原生标题栏与边框（外框）；全屏前收起、退出后恢复 */
  setDecorations(decorated: boolean): Promise<void>;
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

/** 收 / 放原生外框；失败只 warn，不打断全屏本身（外框是锦上添花，窗口可用性优先） */
async function setDecorationsSafely(
  win: FullscreenWindow,
  decorated: boolean,
  action: string,
): Promise<void> {
  try {
    await win.setDecorations(decorated);
  } catch (error: unknown) {
    warn(action, error);
  }
}

/**
 * 进全屏：先摘外框、再全屏（顺序理由见文件头）。
 * `setFullscreen(true)` 失败时把外框装回去，绝不把窗口留在「无边框但非全屏」的残态。
 */
async function enterFullscreen(win: FullscreenWindow): Promise<void> {
  await setDecorationsSafely(win, false, '隐藏原生窗口边框');
  try {
    await win.setFullscreen(true);
  } catch (error: unknown) {
    await setDecorationsSafely(win, true, '恢复原生窗口边框');
    throw error;
  }
}

/** 退全屏：先回窗口态、再恢复外框；`setFullscreen(false)` 失败时窗口多半仍全屏，不动外框 */
async function leaveFullscreen(win: FullscreenWindow): Promise<void> {
  await win.setFullscreen(false);
  await setDecorationsSafely(win, true, '恢复原生窗口边框');
}

/** F11 / 命令面板入口：先读当前态再翻转 */
export async function toggleFullscreen(backend: WindowBackend = TAURI_WINDOW_BACKEND): Promise<void> {
  await runWindowAction(backend, '切换全屏', async (win) => {
    if (await win.isFullscreen()) await leaveFullscreen(win);
    else await enterFullscreen(win);
  });
}

/** 顶栏「退出全屏」按钮 */
export async function exitFullscreen(backend: WindowBackend = TAURI_WINDOW_BACKEND): Promise<void> {
  await runWindowAction(backend, '退出全屏', (win) => leaveFullscreen(win));
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
 *
 * decorations 在这一层收敛：F11 之外的路径（系统快捷键、外部脚本、从全屏里被系统踢出）
 * 只会表现成一次 resize，不补这一步就会留下「全屏了但外框还在」。只在全屏态**变化**时
 * 调一次 setDecorations，普通 resize 不重复下发（避免闪边框）；初次同步同样对齐。
 * 返回退订函数；非壳环境 / 订阅失败 / 单次读写失败都只 warn，调用方无需分支。
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

  /** 上一次已处理的全屏态；null = 尚未处理（首次同步必下发一次） */
  let lastFullscreen: boolean | null = null;
  /** 读态是异步的：只让最新一轮 sync 落值，避免快进快出时旧读数后到、把外框写反 */
  let syncSeq = 0;

  const sync = async (): Promise<void> => {
    const seq = ++syncSeq;
    let fullscreen: boolean;
    try {
      fullscreen = await win.isFullscreen();
    } catch (error: unknown) {
      warn('读取全屏状态', error);
      return;
    }
    if (seq !== syncSeq) return;
    onChange(fullscreen);
    if (fullscreen === lastFullscreen) return;
    lastFullscreen = fullscreen;
    try {
      await win.setDecorations(!fullscreen);
    } catch (error: unknown) {
      warn('同步原生窗口边框', error);
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
