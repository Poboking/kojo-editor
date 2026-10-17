import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeWindow,
  exitFullscreen,
  minimizeWindow,
  subscribeWindowState,
  toggleFullscreen,
  toggleMaximize,
  type WindowBackend,
  type WindowState,
  type WindowSurface,
} from '../src/ui/window-fullscreen';

/**
 * 窗口控制接线的判据（零 Tauri 依赖；用户反馈第 9 条「永久无边框」）。
 *
 * 硬口径：普通 / 最大化 / 全屏**任何状态都不得把原生外框装回去**——
 * `setDecorations(true)` 一次都不许出现；订阅只在首次同步与全屏态变化时
 * 各断言一次 false。另钉住读态再翻转、按钮转发、错误只 warn、
 * 以及 `isMaximized` 读失败时保留上一次已知值的行为。
 */

/** 假窗口：每枚方法都是 vi.fn，个别用例按需覆盖 */
function fakeWindow(patch: Partial<WindowSurface> = {}): WindowSurface {
  const win: WindowSurface = {
    isFullscreen: vi.fn(async () => false),
    isMaximized: vi.fn(async () => false),
    setFullscreen: vi.fn(async () => {}),
    setDecorations: vi.fn(async () => {}),
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onResized: vi.fn(async () => () => {}),
  };
  return Object.assign(win, patch);
}

function backendOf(getWindow: () => Promise<WindowSurface>, isShell = true): WindowBackend {
  return { isShell: () => isShell, getWindow: vi.fn(getWindow) };
}

/** 三态读数的可读形状（避免每个用例手拼对象字面量） */
function state(fullscreen: boolean, maximized: boolean): WindowState {
  return { fullscreen, maximized };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('非 Tauri（浏览器 dev）：安全 no-op', () => {
  it('toggleFullscreen 不取窗口、不抛错', async () => {
    const getWindow = vi.fn(async () => fakeWindow());
    await expect(toggleFullscreen(backendOf(getWindow, false))).resolves.toBeUndefined();
    expect(getWindow).not.toHaveBeenCalled();
  });

  it('subscribeWindowState 立即拿到空退订，回调不触发', async () => {
    const getWindow = vi.fn(async () => fakeWindow());
    const onChange = vi.fn();
    const off = await subscribeWindowState(onChange, backendOf(getWindow, false));
    expect(getWindow).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(() => off()).not.toThrow();
  });
});

describe('toggleFullscreen · 读当前态再翻转，不碰 decorations', () => {
  it('当前是全屏 → 退出：只 setFullscreen(false)，绝不 setDecorations(true)', async () => {
    const win = fakeWindow({ isFullscreen: vi.fn(async () => true) });
    await toggleFullscreen(backendOf(async () => win));
    expect(win.setFullscreen).toHaveBeenCalledWith(false);
    expect(win.setDecorations).not.toHaveBeenCalled();
  });

  it('当前是窗口态 → 进入：只 setFullscreen(true)，装饰保持配置里的无边框', async () => {
    const win = fakeWindow({ isFullscreen: vi.fn(async () => false) });
    await toggleFullscreen(backendOf(async () => win));
    expect(win.setFullscreen).toHaveBeenCalledWith(true);
    expect(win.setDecorations).not.toHaveBeenCalled();
  });

  it('isFullscreen 抛错：只 warn，不碰全屏 / 外框、不向外抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const win = fakeWindow({
      isFullscreen: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(toggleFullscreen(backendOf(async () => win))).resolves.toBeUndefined();
    expect(win.setDecorations).not.toHaveBeenCalled();
    expect(win.setFullscreen).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('取窗口抛错：只 warn，不向外抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const backend = backendOf(async () => {
      throw new Error('no window');
    });
    await expect(toggleFullscreen(backend)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('进入全屏 setFullscreen(true) 抛错：只 warn，不再“恢复外框”', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const win = fakeWindow({
      setFullscreen: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(toggleFullscreen(backendOf(async () => win))).resolves.toBeUndefined();
    expect(win.setDecorations).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('退出全屏 setFullscreen(false) 抛错：只 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const win = fakeWindow({
      isFullscreen: vi.fn(async () => true),
      setFullscreen: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(toggleFullscreen(backendOf(async () => win))).resolves.toBeUndefined();
    expect(win.setDecorations).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('exitFullscreen 走同一条退出路径（无 isFullscreen 往返，也不动 decorations）', async () => {
    const win = fakeWindow({ isFullscreen: vi.fn(async () => true) });
    await exitFullscreen(backendOf(async () => win));
    expect(win.isFullscreen).not.toHaveBeenCalled();
    expect(win.setFullscreen).toHaveBeenCalledWith(false);
    expect(win.setDecorations).not.toHaveBeenCalled();
  });
});

describe('标题栏按钮转发', () => {
  it('minimize / toggleMaximize / close 各走各的窗口方法', async () => {
    const win = fakeWindow();
    await minimizeWindow(backendOf(async () => win));
    await toggleMaximize(backendOf(async () => win));
    await closeWindow(backendOf(async () => win));
    expect(win.minimize).toHaveBeenCalledTimes(1);
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.setFullscreen).not.toHaveBeenCalled();
  });
});

describe('subscribeWindowState · 初始值 + resize 重查 + 退订', () => {
  it('先推普通态；resize 后推最大化态；退订透传给 onResized', async () => {
    const captured: { resize: (() => void) | null } = { resize: null };
    let maximized = false;
    const unlisten = vi.fn();
    const win = fakeWindow({
      isMaximized: vi.fn(async () => maximized),
      onResized: vi.fn(async (handler: () => void) => {
        captured.resize = handler;
        return unlisten;
      }),
    });
    const seen: WindowState[] = [];
    const off = await subscribeWindowState((v) => seen.push(v), backendOf(async () => win));

    expect(seen).toEqual([state(false, false)]);

    maximized = true;
    expect(captured.resize).not.toBeNull();
    captured.resize?.();
    await vi.waitFor(() => expect(seen).toEqual([state(false, false), state(false, true)]));

    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('isFullscreen 抛错：不推值、不碰外框、只 warn，仍返回可用的退订', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unlisten = vi.fn();
    const win = fakeWindow({
      isFullscreen: vi.fn(async () => {
        throw new Error('boom');
      }),
      onResized: vi.fn(async () => unlisten),
    });
    const onChange = vi.fn();
    const off = await subscribeWindowState(onChange, backendOf(async () => win));

    expect(onChange).not.toHaveBeenCalled();
    expect(win.setDecorations).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('isMaximized 抛错：只 warn 一次，仍推 fullscreen 读数并保留上次 maximized', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const win = fakeWindow({
      isMaximized: vi.fn(async () => {
        throw new Error('no permission');
      }),
    });
    const seen: WindowState[] = [];
    await subscribeWindowState((v) => seen.push(v), backendOf(async () => win));

    expect(seen).toEqual([state(false, false)]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(win.setDecorations).toHaveBeenCalledTimes(1);
    expect(win.setDecorations).toHaveBeenCalledWith(false);
  });

  it('取窗口抛错：返回空退订，回调不触发', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onChange = vi.fn();
    const off = await subscribeWindowState(
      onChange,
      backendOf(async () => {
        throw new Error('no window');
      }),
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => off()).not.toThrow();
  });
});

describe('subscribeWindowState · decorations 恒 false', () => {
  function subscribed(reading: () => { fullscreen: boolean; maximized: boolean }) {
    const captured: { resize: (() => void) | null } = { resize: null };
    const unlisten = vi.fn();
    const win = fakeWindow({
      isFullscreen: vi.fn(async () => reading().fullscreen),
      isMaximized: vi.fn(async () => reading().maximized),
      onResized: vi.fn(async (handler: () => void) => {
        captured.resize = handler;
        return unlisten;
      }),
    });
    return { captured, unlisten, win };
  }

  it('首次同步即断言无外框：初始普通态 → setDecorations(false) 一次', async () => {
    const { win } = subscribed(() => ({ fullscreen: false, maximized: false }));
    await subscribeWindowState(() => {}, backendOf(async () => win));

    expect(win.setDecorations).toHaveBeenCalledTimes(1);
    expect(win.setDecorations).toHaveBeenCalledWith(false);
  });

  it('初始全屏也断言 false（绝不 true）', async () => {
    const { win } = subscribed(() => ({ fullscreen: true, maximized: false }));
    const seen: WindowState[] = [];
    await subscribeWindowState((v) => seen.push(v), backendOf(async () => win));

    expect(seen).toEqual([state(true, false)]);
    expect(win.setDecorations).toHaveBeenCalledTimes(1);
    expect(win.setDecorations).toHaveBeenCalledWith(false);
  });

  it('最大化变化的 resize：只更新状态，不重复下发 decorations（不闪边框）', async () => {
    let maximized = false;
    const { captured, win } = subscribed(() => ({ fullscreen: false, maximized }));
    const seen: WindowState[] = [];
    await subscribeWindowState((v) => seen.push(v), backendOf(async () => win));
    expect(win.setDecorations).toHaveBeenCalledTimes(1);

    maximized = true;
    captured.resize?.();
    await vi.waitFor(() => expect(seen).toEqual([state(false, false), state(false, true)]));
    expect(win.setDecorations).toHaveBeenCalledTimes(1);

    captured.resize?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(win.setDecorations).toHaveBeenCalledTimes(1);
  });

  it('外部进 / 出全屏：每次变化断言一次 false，从不 true', async () => {
    let fullscreen = false;
    const { captured, win } = subscribed(() => ({ fullscreen, maximized: false }));
    const seen: WindowState[] = [];
    await subscribeWindowState((v) => seen.push(v), backendOf(async () => win));
    expect(win.setDecorations).toHaveBeenLastCalledWith(false);

    fullscreen = true;
    captured.resize?.();
    captured.resize?.();
    await vi.waitFor(() => expect(seen).toEqual([state(false, false), state(true, false)]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(win.setDecorations).toHaveBeenCalledTimes(2);
    expect(win.setDecorations).toHaveBeenLastCalledWith(false);

    fullscreen = false;
    captured.resize?.();
    await vi.waitFor(() => expect(seen).toEqual([state(false, false), state(true, false), state(false, false)]));
    expect(win.setDecorations).toHaveBeenCalledTimes(3);
    expect(vi.mocked(win.setDecorations).mock.calls.every(([decorated]) => decorated === false)).toBe(true);
  });

  it('断言无外框失败：只 warn、回调照常、退订可用', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unlisten = vi.fn();
    const win = fakeWindow({
      isFullscreen: vi.fn(async () => true),
      setDecorations: vi.fn(async () => {
        throw new Error('no permission');
      }),
      onResized: vi.fn(async () => unlisten),
    });
    const seen: WindowState[] = [];
    const off = await subscribeWindowState((v) => seen.push(v), backendOf(async () => win));

    expect(seen).toEqual([state(true, false)]);
    expect(warn).toHaveBeenCalledTimes(1);
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
