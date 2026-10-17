import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  subscribeFullscreen,
  toggleFullscreen,
  type FullscreenWindow,
  type WindowBackend,
} from '../src/ui/window-fullscreen';

/**
 * 全屏窗口接线的判据（零 Tauri 依赖）：
 * 浏览器 dev 必须安全 no-op；真壳里"读态再翻转"；订阅先推初始值、resize 再重查；
 * 任何 API 抛错都只 warn，不把异常漏给调用方。
 */

/** 假窗口：每枚方法都是 vi.fn，个别用例按需覆盖 */
function fakeWindow(patch: Partial<FullscreenWindow> = {}): FullscreenWindow {
  const win: FullscreenWindow = {
    isFullscreen: vi.fn(async () => false),
    setFullscreen: vi.fn(async () => {}),
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onResized: vi.fn(async () => () => {}),
  };
  return Object.assign(win, patch);
}

function backendOf(getWindow: () => Promise<FullscreenWindow>, isShell = true): WindowBackend {
  return { isShell: () => isShell, getWindow: vi.fn(getWindow) };
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

  it('subscribeFullscreen 立即拿到空退订，回调不触发', async () => {
    const getWindow = vi.fn(async () => fakeWindow());
    const onChange = vi.fn();
    const off = await subscribeFullscreen(onChange, backendOf(getWindow, false));
    expect(getWindow).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(() => off()).not.toThrow();
  });
});

describe('toggleFullscreen · 读当前态再翻转', () => {
  it('当前是全屏 → 退出', async () => {
    const win = fakeWindow({ isFullscreen: vi.fn(async () => true) });
    await toggleFullscreen(backendOf(async () => win));
    expect(win.setFullscreen).toHaveBeenCalledWith(false);
  });

  it('当前是窗口态 → 进入全屏', async () => {
    const win = fakeWindow({ isFullscreen: vi.fn(async () => false) });
    await toggleFullscreen(backendOf(async () => win));
    expect(win.setFullscreen).toHaveBeenCalledWith(true);
  });

  it('isFullscreen 抛错：只 warn，不调 setFullscreen、不向外抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const win = fakeWindow({
      isFullscreen: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(toggleFullscreen(backendOf(async () => win))).resolves.toBeUndefined();
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
});

describe('subscribeFullscreen · 初始值 + resize 重查 + 退订', () => {
  it('先推一次当前态；resize 后重查并再推；退订透传给 onResized', async () => {
    const captured: { resize: (() => void) | null } = { resize: null };
    let fullscreen = false;
    const unlisten = vi.fn();
    const win = fakeWindow({
      isFullscreen: vi.fn(async () => fullscreen),
      onResized: vi.fn(async (handler: () => void) => {
        captured.resize = handler;
        return unlisten;
      }),
    });
    const seen: boolean[] = [];
    const off = await subscribeFullscreen((v) => seen.push(v), backendOf(async () => win));

    expect(seen).toEqual([false]);

    fullscreen = true;
    expect(captured.resize).not.toBeNull();
    captured.resize?.();
    await vi.waitFor(() => expect(seen).toEqual([false, true]));

    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('isFullscreen 抛错：不推值、只 warn，仍返回可用的退订', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unlisten = vi.fn();
    const win = fakeWindow({
      isFullscreen: vi.fn(async () => {
        throw new Error('boom');
      }),
      onResized: vi.fn(async () => unlisten),
    });
    const onChange = vi.fn();
    const off = await subscribeFullscreen(onChange, backendOf(async () => win));

    expect(onChange).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('取窗口抛错：返回空退订，回调不触发', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onChange = vi.fn();
    const off = await subscribeFullscreen(
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
