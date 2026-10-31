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

/**
 * E·R6：放行前的那一道活（2026-10-31）。
 *
 * 关窗这一拍原来直接把原生关闭放走——插件的写是 fire-and-forget（索引快照 42.7M 码元 /
 * 写窗口 0.7s 起），进程一走，整轮索引白算。判据：拦下 → 等 → **守卫自己再关一次**；
 * 等失败也照关（关不掉的窗口比丢一次缓存严重）；已批准那次不许再跑一遍。
 */
describe('installWindowCloseGuard · beforeClose（E·R6 落盘屏障）', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  function makeBridge(): {
    bridge: WindowCloseBridge;
    fire: () => { preventDefault: ReturnType<typeof vi.fn> };
    closeCalls: () => number;
  } {
    let handler: ((event: WindowCloseEvent) => void | Promise<void>) | null = null;
    let closed = 0;
    const bridge: WindowCloseBridge = {
      onCloseRequested: vi.fn(async (h: (event: WindowCloseEvent) => void | Promise<void>) => {
        handler = h;
        return () => {};
      }),
      close: vi.fn(async () => {
        closed += 1;
      }),
    };
    return {
      bridge,
      closeCalls: () => closed,
      fire(): { preventDefault: ReturnType<typeof vi.fn> } {
        expect(handler, '监听尚未注册').not.toBeNull();
        const preventDefault = vi.fn();
        handler!({ preventDefault });
        return { preventDefault };
      },
    };
  }

  it('无脏 ⇒ 先拦下、等屏障走完、再由守卫自己 close（顺序不许反）', async () => {
    const { bridge, fire, closeCalls } = makeBridge();
    const order: string[] = [];
    await installWindowCloseGuard(bridge, {
      isApproved: () => false,
      hasDirty: () => false,
      onConfirm: vi.fn(),
      beforeClose: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('before');
      },
    });

    const { preventDefault } = fire();
    expect(preventDefault).toHaveBeenCalledTimes(1); // 拦下来了，窗口还在
    expect(closeCalls()).toBe(0); // 屏障没走完，绝不先关
    order.push('sync-return');
    await new Promise((r) => setTimeout(r, 20));
    order.push('closed');
    expect(closeCalls()).toBe(1);
    expect(order).toEqual(['sync-return', 'before', 'closed']);
  });

  it('屏障抛错 ⇒ 照关（关不掉的窗口比丢一次缓存严重）', async () => {
    const { bridge, fire, closeCalls } = makeBridge();
    await installWindowCloseGuard(bridge, {
      isApproved: () => false,
      hasDirty: () => false,
      onConfirm: vi.fn(),
      beforeClose: async () => Promise.reject(new Error('写盘炸了')),
    });

    fire();
    await tick();
    await tick();
    expect(closeCalls()).toBe(1);
  });

  it('已批准那一次不跑屏障（否则同一次退出跑两遍）', async () => {
    const { bridge, fire } = makeBridge();
    const beforeClose = vi.fn(async () => {});
    await installWindowCloseGuard(bridge, {
      isApproved: () => true,
      hasDirty: () => false,
      onConfirm: vi.fn(),
      beforeClose,
    });

    const { preventDefault } = fire();
    await tick();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(beforeClose).not.toHaveBeenCalled();
  });

  it('有脏且未批准 ⇒ 走确认框那条路，屏障一步都不跑（用户还没决定）', async () => {
    const { bridge, fire } = makeBridge();
    const beforeClose = vi.fn(async () => {});
    const onConfirm = vi.fn();
    await installWindowCloseGuard(bridge, { isApproved: () => false, hasDirty: () => true, onConfirm, beforeClose });

    const { preventDefault } = fire();
    await tick();
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(beforeClose).not.toHaveBeenCalled();
  });

  it('桥没有 close（浏览器 / 老替身）⇒ 不做屏障，维持"放行原生关闭"', async () => {
    let handler: ((event: WindowCloseEvent) => void | Promise<void>) | null = null;
    const bridge: WindowCloseBridge = {
      onCloseRequested: vi.fn(async (h: (event: WindowCloseEvent) => void | Promise<void>) => {
        handler = h;
        return () => {};
      }),
    };
    const beforeClose = vi.fn(async () => {});
    await installWindowCloseGuard(bridge, { isApproved: () => false, hasDirty: () => false, onConfirm: vi.fn(), beforeClose });

    const preventDefault = vi.fn();
    handler!({ preventDefault });
    await tick();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(beforeClose).not.toHaveBeenCalled();
  });
});
