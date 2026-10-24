/**
 * 窗口控制的宿主接线（用户反馈第 9 条：窗口从启动起永久无原生装饰）。
 *
 * 硬口径：`tauri.conf.json` 里窗口就是 `decorations: false`，本模块**永不**把原生外框装回去。
 * 普通 / 最大化 / 全屏三种状态都是无装饰的整窗客户区，窗口框架（标题栏 + 自绘 1px 边框）
 * 由常驻的 `WindowChrome` 负责。tao 在 `decorations:false + resizable:true` 时已经支持
 * 四边 / 四角拖拽缩放（WM_NCHITTEST），最大化按 monitor rcWork 裁剪、不盖任务栏，
 * 因此这里只剩三件事：读状态 / 订阅状态变化 / 转发窗口动作。
 *
 * 为什么还保留 `setDecorations(false)`：配置文件是声明式兜底，但 dev 热重载、历史窗口
 * 实例、以及「未来某个窗口忘记继承配置」都可能让外框回来。订阅首次同步与全屏态每次
 * 变化时各断言一次 false（**绝不 true**，失败只 warn），把任意残态收敛回无边框。
 *
 * 零 React、零插件依赖。Tauri 面经 `WindowBackend` 注入（与 `window-close-guard.ts`
 * 同一形态的 seam）：只有缺省实现才动态 import `@tauri-apps/api/window`，node 测试喂
 * 假实现即可跑；浏览器 dev（无壳）一律安全 no-op。
 */

import { isTauri } from '../bridge/invoke';

/** 窗口状态投影：标题栏按钮序列与自绘边框选择都只看这两枚布尔 */
export interface WindowState {
  fullscreen: boolean;
  maximized: boolean;
}

/** 本模块用到的最小窗口面（`getCurrentWindow()` 的结构子集） */
export interface WindowSurface {
  isFullscreen(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  /** 原生标题栏与边框开关；本应用恒为 false（仅作为残态兜底断言） */
  setDecorations(decorated: boolean): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  /** 监听窗口尺寸变化（进出全屏 / 最大化在 Windows 上表现为一次 resize） */
  onResized(handler: () => void): Promise<() => void>;
}

/** Tauri 依赖注入 seam（缺省 = 真壳；测试 = 假实现） */
export interface WindowBackend {
  isShell(): boolean;
  getWindow(): Promise<WindowSurface>;
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
  work: (win: WindowSurface) => Promise<void>,
): Promise<void> {
  if (!backend.isShell()) return;
  try {
    await work(await backend.getWindow());
  } catch (error: unknown) {
    warn(action, error);
  }
}

/** 断言一次「无原生装饰」；失败只 warn（窗口可用性优先，外框兜底不值得打断流程） */
async function ensureUndecorated(win: WindowSurface): Promise<void> {
  try {
    await win.setDecorations(false);
  } catch (error: unknown) {
    warn('确保无原生窗口边框', error);
  }
}

/**
 * 进全屏：只切全屏。装饰恒 false 由配置与订阅兜底，这里**不再**动 decorations——
 * 早先「退出全屏时恢复外框」的旧口径正是原生白色标题栏反复出现的根因。
 */
async function enterFullscreen(win: WindowSurface): Promise<void> {
  await win.setFullscreen(true);
}

/** 退全屏：只切全屏（同样不碰 decorations） */
async function leaveFullscreen(win: WindowSurface): Promise<void> {
  await win.setFullscreen(false);
}

/** F11 / 命令面板入口：先读当前态再翻转 */
export async function toggleFullscreen(backend: WindowBackend = TAURI_WINDOW_BACKEND): Promise<void> {
  await runWindowAction(backend, '切换全屏', async (win) => {
    if (await win.isFullscreen()) await leaveFullscreen(win);
    else await enterFullscreen(win);
  });
}

/** 标题栏「退出全屏」按钮 */
export async function exitFullscreen(backend: WindowBackend = TAURI_WINDOW_BACKEND): Promise<void> {
  await runWindowAction(backend, '退出全屏', (win) => leaveFullscreen(win));
}

/** 标题栏「最小化」按钮 */
export async function minimizeWindow(backend: WindowBackend = TAURI_WINDOW_BACKEND): Promise<void> {
  await runWindowAction(backend, '最小化窗口', (win) => win.minimize());
}

/** 标题栏「最大化 / 还原」按钮与双击标题栏共用（全屏下由系统决定是否生效） */
export async function toggleMaximize(backend: WindowBackend = TAURI_WINDOW_BACKEND): Promise<void> {
  await runWindowAction(backend, '切换最大化', (win) => win.toggleMaximize());
}

/** 标题栏「关闭」按钮：走原生 close（App 侧的关窗守卫照常拦脏修改） */
export async function closeWindow(backend: WindowBackend = TAURI_WINDOW_BACKEND): Promise<void> {
  await runWindowAction(backend, '关闭窗口', (win) => win.close());
}

/**
 * 订阅窗口状态：先查一次（给初始值），再挂 resize 重查（进出全屏 / 最大化都改尺寸）。
 *
 * decorations 在这一层收敛：首次同步 + 全屏态**变化**时各断言一次 false。普通 resize
 * 不重复下发（避免闪边框），也**绝不**下发 true——外框一旦装上就会在最大化 / 普通态
 * 重新长出一条原生白标题栏，正是用户连报三轮的问题。
 *
 * 读态是异步的：用 `syncSeq` 只让最新一轮落值，避免快进快出时旧读数后到、把状态写反。
 * `isMaximized` 读失败时保留上一次已知值（不全盘丢弃本次 fullscreen 读数）；两枚都读
 * 失败 / 取窗口失败 / 订阅失败都只 warn，返回可用的（或空）退订函数。
 */
export async function subscribeWindowState(
  onChange: (state: WindowState) => void,
  backend: WindowBackend = TAURI_WINDOW_BACKEND,
): Promise<() => void> {
  if (!backend.isShell()) return () => {};
  let win: WindowSurface;
  try {
    win = await backend.getWindow();
  } catch (error: unknown) {
    warn('订阅窗口状态', error);
    return () => {};
  }

  /** 上一次已处理的全屏态；null = 尚未处理（首次同步必断言一次无边框） */
  let lastFullscreen: boolean | null = null;
  /** 最大化读失败时的回退值（初值 false 与未被最大化的启动态一致） */
  let lastMaximized = false;
  /** 只让最新一轮 sync 落值（旧读数后到不许覆盖新状态） */
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
    let maximized: boolean;
    try {
      maximized = await win.isMaximized();
      lastMaximized = maximized;
    } catch (error: unknown) {
      warn('读取最大化状态', error);
      maximized = lastMaximized;
    }
    if (seq !== syncSeq) return;
    onChange({ fullscreen, maximized });
    if (fullscreen === lastFullscreen) return;
    lastFullscreen = fullscreen;
    await ensureUndecorated(win);
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

/* ============================================================================
   窗口几何两态（2026-10-25 启动弹窗批）：欢迎弹窗（卡片核心区大小） ↔ 编辑器窗口。

   用户反馈：启动到欢迎页之间不要露出整块编辑器窗口，只出现一个与「欢迎页最中间那块
   核心区域」同尺寸的无边框弹窗；加载完成后欢迎页本身也住在这个弹窗里，进项目才扩成
   编辑器窗口。放在本文件而不另开模块，是为了守住 PS-10 开机图文件数预算（不能为这个
   交互多背两个模块）。

   弹窗高度 = 欢迎卡自然高度（真壳实测 0 项目 450 / 1–2 项目 509 / 3+ 项目 626），
   所以这里只给纯函数 `clampWelcomeWindowSize`，由 App 量完卡片再交给窗口；
   `WELCOME_WINDOW_DEFAULT_HEIGHT` 只兜首帧（内联扫光层）的底。
   ============================================================================ */

export interface WindowSize {
  readonly width: number;
  readonly height: number;
}

/** 欢迎卡核心区宽度（= welcome.css `.welcome-stage` 的 min(1120px, 100%)） */
export const WELCOME_WINDOW_WIDTH = 1120;
/** 首帧兜底高度：量卡之前的窗口高度；量完会收成卡片自然高度（真壳 1–2 项目 ≈ 509） */
export const WELCOME_WINDOW_DEFAULT_HEIGHT = 510;
/** 弹窗态窗口下限（只是兜底，弹窗本身设成不可缩放） */
export const WELCOME_MIN_SIZE: WindowSize = { width: 320, height: 200 };
/** 编辑器窗口：与 tauri.conf.json 的既有默认尺寸一致 */
export const EDITOR_WINDOW_SIZE: WindowSize = { width: 1280, height: 840 };
/** 编辑器窗口下限：与改动前 tauri.conf.json 的 minWidth/minHeight 一致 */
export const EDITOR_MIN_SIZE: WindowSize = { width: 960, height: 620 };
/** 窗口与屏幕边缘的最小留白（避免弹窗贴边 / 超出工作区） */
export const SCREEN_EDGE_MARGIN = 24;

/**
 * 把卡片核心区尺寸夹进「可用的屏幕工作区」。
 * 纯函数：App 传入屏幕 `availWidth/availHeight`，node 用例直接喂数。
 */
export function clampWelcomeWindowSize(core: WindowSize, screen: WindowSize): WindowSize {
  const maxWidth = Math.max(WELCOME_MIN_SIZE.width, Math.round(screen.width) - SCREEN_EDGE_MARGIN);
  const maxHeight = Math.max(WELCOME_MIN_SIZE.height, Math.round(screen.height) - SCREEN_EDGE_MARGIN);
  return {
    width: Math.min(Math.max(Math.round(core.width), WELCOME_MIN_SIZE.width), maxWidth),
    height: Math.min(Math.max(Math.round(core.height), WELCOME_MIN_SIZE.height), maxHeight),
  };
}

/** 本模块用到的最小窗口面（`getCurrentWindow()` 的结构子集） */
export interface WelcomeWindowSurface {
  isFullscreen(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  unmaximize(): Promise<void>;
  setResizable(resizable: boolean): Promise<void>;
  setMaximizable(maximizable: boolean): Promise<void>;
  setSize(size: WindowSize): Promise<void>;
  setMinSize(size: WindowSize): Promise<void>;
  center(): Promise<void>;
}

/** Tauri 依赖注入 seam（缺省 = 真壳；测试 = 假实现） */
export interface WelcomeWindowBackend {
  isShell(): boolean;
  getWindow(): Promise<WelcomeWindowSurface>;
}

/** 缺省后端：动态 import 让浏览器 dev 完全不碰 Tauri 运行时 */
export const TAURI_WELCOME_WINDOW_BACKEND: WelcomeWindowBackend = {
  isShell: isTauri,
  getWindow: async () => {
    const [{ getCurrentWindow }, { LogicalSize }] = await Promise.all([
      import('@tauri-apps/api/window'),
      import('@tauri-apps/api/dpi'),
    ]);
    const win = getCurrentWindow();
    return {
      isFullscreen: () => win.isFullscreen(),
      isMaximized: () => win.isMaximized(),
      setFullscreen: (fullscreen) => win.setFullscreen(fullscreen),
      unmaximize: () => win.unmaximize(),
      setResizable: (resizable) => win.setResizable(resizable),
      setMaximizable: (maximizable) => win.setMaximizable(maximizable),
      setSize: (size) => win.setSize(new LogicalSize(size.width, size.height)),
      setMinSize: (size) => win.setMinSize(new LogicalSize(size.width, size.height)),
      center: () => win.center(),
    };
  },
};

/** 失败只留一句 warn：窗口几何不值得打断启动 / 开项目 */
function warnGeometry(action: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[welcome-window] ${action}失败：${reason}`);
}

/**
 * 对当前窗口执行一次几何动作。
 * 非壳环境直接返回；取窗口或动作失败都只 warn（调用方无分支，失败不挡启动）。
 */
async function runWindowGeometry(
  backend: WelcomeWindowBackend,
  action: string,
  work: (win: WelcomeWindowSurface) => Promise<void>,
): Promise<void> {
  if (!backend.isShell()) return;
  try {
    await work(await backend.getWindow());
  } catch (error: unknown) {
    warnGeometry(action, error);
  }
}

/**
 * 先退全屏 / 取消最大化再改尺寸：最大化窗口上的 `setSize` 会被系统忽略或先还原，
 * 结果尺寸不稳定。两步都尽力而为——读态失败也继续走后面的尺寸设置。
 */
async function leaveMaximized(win: WelcomeWindowSurface): Promise<void> {
  try {
    if (await win.isFullscreen()) await win.setFullscreen(false);
  } catch {
    // 读不到全屏态不挡尺寸设置
  }
  try {
    if (await win.isMaximized()) await win.unmaximize();
  } catch {
    // 同上
  }
}

/** `applyWelcomeWindow` 的可选行为 */
export interface WelcomeWindowOptions {
  /**
   * 是否居中。**进入**弹窗时居中；已停在弹窗里、只是内容变高变矮（删一条最近项目 /
   * 错误条出现）时传 false，保住作者自己拖到的位置。
   */
  readonly center?: boolean;
}

/**
 * 进入欢迎弹窗：退出全屏/最大化 → 不可缩放/不可最大化 → 下限降到弹窗允许值 →
 * 设为卡片核心区尺寸 → 居中（可关）。顺序是硬约束：**下限必须先降**，否则高度会被
 * 编辑器的 620 下限夹住。
 */
export async function applyWelcomeWindow(
  size: WindowSize,
  options: WelcomeWindowOptions = {},
  backend: WelcomeWindowBackend = TAURI_WELCOME_WINDOW_BACKEND,
): Promise<void> {
  await runWindowGeometry(backend, '切换到欢迎弹窗', async (win) => {
    await leaveMaximized(win);
    await win.setResizable(false);
    await win.setMaximizable(false);
    await win.setMinSize(WELCOME_MIN_SIZE);
    await win.setSize(size);
    if (options.center !== false) await win.center();
  });
}

/**
 * 进入编辑器窗口：可缩放/可最大化 → 下限恢复 960×620 → 1280×840 → 居中。
 * 顺序同 `applyWelcomeWindow`：下限与可缩放先落，再改尺寸。
 */
export async function applyEditorWindow(
  backend: WelcomeWindowBackend = TAURI_WELCOME_WINDOW_BACKEND,
): Promise<void> {
  await runWindowGeometry(backend, '切换到编辑器窗口', async (win) => {
    await leaveMaximized(win);
    await win.setResizable(true);
    await win.setMaximizable(true);
    await win.setMinSize(EDITOR_MIN_SIZE);
    await win.setSize(EDITOR_WINDOW_SIZE);
    await win.center();
  });
}
