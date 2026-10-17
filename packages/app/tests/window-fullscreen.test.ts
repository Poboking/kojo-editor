import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exitFullscreen,
  subscribeFullscreen,
  toggleFullscreen,
  type FullscreenWindow,
  type WindowBackend,
} from '../src/ui/window-fullscreen';

/**
 * 全屏窗口接线的判据（零 Tauri 依赖）：
 * 浏览器 dev 必须安全 no-op；真壳里「读态再翻转」且外框跟随进出全屏；
 * 订阅先推初始值、resize 重查，但只在全屏态真变化时才改 decorations；
 * 任何 API 抛错都只 warn，不把异常漏给调用方，并尽量把窗口恢复成可用态。
 */

/** 假窗口：每枚方法都是 vi.fn，个别用例按需覆盖 */
function fakeWindow(patch: Partial<FullscreenWindow> = {}): FullscreenWindow {
  const win: FullscreenWindow = {
    isFullscreen: vi.fn(async () => false),
    setFullscreen: vi.fn(async () => {}),
    setDecorations: vi.fn(async () => {}),
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

/** 取某个 vi.fn 的调用顺序号（判「先摘外框、再全屏」） */
function orderOf(fn: unknown): number {
  return (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0] ?? -1;
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
  it('当前是全屏 → 退出：先 setFullscreen(false)，再恢复外框', async () => {
    const win = fakeWindow({ isFullscreen: vi.fn(async () => true) });
    await toggleFullscreen(backendOf(async () => win));
    expect(win.setFullscreen).toHaveBeenCalledWith(false);
    expect(win.setDecorations).toHaveBeenCalledWith(true);
    expect(orderOf(win.setFullscreen)).toBeLessThan(orderOf(win.setDecorations));
  });

  it('当前是窗口态 → 进入：先收外框、再全屏', async () => {
    const win = fakeWindow({ isFullscreen: vi.fn(async () => false) });
    await toggleFullscreen(backendOf(async () => win));
    expect(win.setDecorations).toHaveBeenCalledWith(false);
    expect(win.setFullscreen).toHaveBeenCalledWith(true);
    expect(orderOf(win.setDecorations)).toBeLessThan(orderOf(win.setFullscreen));
  });

  it('isFullscreen 抛错：只 warn，不碰外框 / 全屏、不向外抛', async () => {
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
});

describe('toggleFullscreen · 外框失败兜底', () => {
  it('进入时 setFullscreen(true) 抛错：把外框装回去，只 warn，不留在无边框残态', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const decorations: boolean[] = [];
    const win = fakeWindow({
      setFullscreen: vi.fn(async () => {
        throw new Error('boom');
      }),
      setDecorations: vi.fn(async (decorated: boolean) => {
        decorations.push(decorated);
      }),
    });
    await expect(toggleFullscreen(backendOf(async () => win))).resolves.toBeUndefined();
    expect(decorations).toEqual([false, true]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('进入时 setDecorations(false) 抛错：仍进全屏（退化为旧行为），只 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const win = fakeWindow({
      isFullscreen: vi.fn(async () => false),
      setDecorations: vi.fn(async () => {
        throw new Error('no permission');
      }),
    });
    await expect(toggleFullscreen(backendOf(async () => win))).resolves.toBeUndefined();
    expect(win.setFullscreen).toHaveBeenCalledWith(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('退出时 setFullscreen(false) 抛错：窗口多半仍全屏，不动外框，只 warn', async () => {
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

  it('退出时恢复外框失败：全屏已退出，仍只 warn 不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const win = fakeWindow({
      isFullscreen: vi.fn(async () => true),
      setDecorations: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(toggleFullscreen(backendOf(async () => win))).resolves.toBeUndefined();
    expect(win.setFullscreen).toHaveBeenCalledWith(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('exitFullscreen 走同一条退出路径（无 isFullscreen 往返）', async () => {
    const win = fakeWindow({ isFullscreen: vi.fn(async () => true) });
    await exitFullscreen(backendOf(async () => win));
    expect(win.isFullscreen).not.toHaveBeenCalled();
    expect(win.setFullscreen).toHaveBeenCalledWith(false);
    expect(win.setDecorations).toHaveBeenCalledWith(true);
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
    const off = await subscribeFullscreen(onChange, backendOf(async () => win));

    expect(onChange).not.toHaveBeenCalled();
    expect(win.setDecorations).not.toHaveBeenCalled();
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

describe('subscribeFullscreen · decorations 随全屏态收敛', () => {
  function subscribed(fullscreen: () => boolean) {
    const captured: { resize: (() => void) | null } = { resize: null };
    const unlisten = vi.fn();
    const win = fakeWindow({
      isFullscreen: vi.fn(async () => fullscreen()),
      onResized: vi.fn(async (handler: () => void) => {
        captured.resize = handler;
        return unlisten;
      }),
    });
    return { captured, unlisten, win };
  }

  it('初次同步即对齐：初始全屏 → setDecorations(false) 一次', async () => {
    let fullscreen = true;
    const { win } = subscribed(() => fullscreen);
    const seen: boolean[] = [];
    await subscribeFullscreen((v) => seen.push(v), backendOf(async () => win));

    expect(seen).toEqual([true]);
    expect(win.setDecorations).toHaveBeenCalledTimes(1);
    expect(win.setDecorations).toHaveBeenCalledWith(false);
    fullscreen = false;
  });

  it('初始非全屏也下发一次 setDecorations(true)（从任意残态归位）', async () => {
    const { win } = subscribed(() => false);
    await subscribeFullscreen(() => {}, backendOf(async () => win));

    expect(win.setDecorations).toHaveBeenCalledTimes(1);
    expect(win.setDecorations).toHaveBeenCalledWith(true);
  });

  it('全屏态没变的 resize：不重复下发 decorations（不闪外框）', async () => {
    const { captured, win } = subscribed(() => false);
    await subscribeFullscreen(() => {}, backendOf(async () => win));
    expect(win.setDecorations).toHaveBeenCalledTimes(1);

    captured.resize?.();
    captured.resize?.();
    captured.resize?.();
    // 给三轮 sync 都留出完成机会
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(win.setDecorations).toHaveBeenCalledTimes(1);
  });

  it('外部进 / 出全屏：变化时各下发一次，重复 resize 不叠加', async () => {
    let fullscreen = false;
    const { captured, win } = subscribed(() => fullscreen);
    const seen: boolean[] = [];
    await subscribeFullscreen((v) => seen.push(v), backendOf(async () => win));
    expect(win.setDecorations).toHaveBeenLastCalledWith(true);

    fullscreen = true;
    captured.resize?.();
    captured.resize?.();
    await vi.waitFor(() => expect(seen).toEqual([false, true]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(win.setDecorations).toHaveBeenCalledTimes(2);
    expect(win.setDecorations).toHaveBeenLastCalledWith(false);
    expect(vi.mocked(win.setDecorations).mock.calls.filter(([v]) => v === false)).toHaveLength(1);

    fullscreen = false;
    captured.resize?.();
    await vi.waitFor(() => expect(seen).toEqual([false, true, false]));
    expect(win.setDecorations).toHaveBeenCalledTimes(3);
    expect(win.setDecorations).toHaveBeenLastCalledWith(true);
  });

  it('同步 decorations 失败：只 warn、回调照常、退订可用', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unlisten = vi.fn();
    const win = fakeWindow({
      isFullscreen: vi.fn(async () => true),
      setDecorations: vi.fn(async () => {
        throw new Error('no permission');
      }),
      onResized: vi.fn(async () => unlisten),
    });
    const seen: boolean[] = [];
    const off = await subscribeFullscreen((v) => seen.push(v), backendOf(async () => win));

    expect(seen).toEqual([true]);
    expect(warn).toHaveBeenCalledTimes(1);
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
