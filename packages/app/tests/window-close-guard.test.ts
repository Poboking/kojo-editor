import { describe, expect, it, vi } from 'vitest';
import {
  classifyWindowClose,
  installWindowCloseGuard,
  type WindowCloseBridge,
  type WindowCloseEvent,
} from '../src/ui/window-close-guard';

/**
 * A2 关窗守卫的判据（零 Tauri 依赖）：三态分流语义 + 接线契约
 * （退订函数必须透传给卸载清理；只有"有脏且未批准"才拦截）。
 */

describe('classifyWindowClose · 三态分流', () => {
  it('有脏且未批准 → 拦下弹确认', () => {
    expect(classifyWindowClose(false, true)).toBe('confirm');
  });

  it('无脏 → 放行（原生关闭即退出，没有可丢失的东西）', () => {
    expect(classifyWindowClose(false, false)).toBe('pass');
  });

  it('已批准 → 放行（确认框走完后的主动 close() 必须直达原生关闭）', () => {
    expect(classifyWindowClose(true, true)).toBe('pass');
    expect(classifyWindowClose(true, false)).toBe('pass');
  });
});

describe('installWindowCloseGuard · onCloseRequested 接线', () => {
  function makeBridge(): {
    bridge: WindowCloseBridge;
    fire: () => { preventDefault: ReturnType<typeof vi.fn> };
  } {
    let handler: ((event: WindowCloseEvent) => void | Promise<void>) | null = null;
    const bridge: WindowCloseBridge = {
      onCloseRequested: vi.fn(async (h: (event: WindowCloseEvent) => void | Promise<void>) => {
        handler = h;
        return () => {};
      }),
    };
    return {
      bridge,
      fire(): { preventDefault: ReturnType<typeof vi.fn> } {
        expect(handler, '监听尚未注册').not.toBeNull();
        const preventDefault = vi.fn();
        handler!({ preventDefault });
        return { preventDefault };
      },
    };
  }

  it('有脏且未批准：preventDefault + onConfirm（旧缺陷的拦截点）', async () => {
    const { bridge, fire } = makeBridge();
    const onConfirm = vi.fn();
    await installWindowCloseGuard(bridge, { isApproved: () => false, hasDirty: () => true, onConfirm });
    const { preventDefault } = fire();
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('无脏：不拦（原生关闭即退出）', async () => {
    const { bridge, fire } = makeBridge();
    const onConfirm = vi.fn();
    await installWindowCloseGuard(bridge, { isApproved: () => false, hasDirty: () => false, onConfirm });
    const { preventDefault } = fire();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('已批准：不拦（放行支 = 退出通道）', async () => {
    const { bridge, fire } = makeBridge();
    const onConfirm = vi.fn();
    await installWindowCloseGuard(bridge, { isApproved: () => true, hasDirty: () => true, onConfirm });
    const { preventDefault } = fire();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('onCloseRequested 的退订函数被透传（组件卸载清理用）', async () => {
    const unlisten = vi.fn();
    const bridge: WindowCloseBridge = {
      onCloseRequested: vi.fn(async () => unlisten),
    };
    const cleanup = await installWindowCloseGuard(bridge, {
      isApproved: () => false,
      hasDirty: () => false,
      onConfirm: vi.fn(),
    });
    expect(cleanup).toBe(unlisten);
  });
});
