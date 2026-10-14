import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MOTION_PREF_DEFAULT,
  applyMotionPref,
  loadMotionPref,
  saveMotionPref,
} from '../src/ui/motion-pref';

/**
 * 动效偏好单测（2026-10-14 HK-4 UI 批 UI-5）。
 *
 * 单测环境是 `node`（无 window / document），所以这里用假 localStorage 与假根元素
 * 把两条契约钉死：①**读不到一律回默认、绝不抛**（隐私模式 / 无浏览器 / 存储丢值都
 * 不能把开关卡死）；②**应用偏好只改根元素的一个属性**（不改别的、无根元素时安全跳过）。
 */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
}

/** 以假 window 替换全局（只带 localStorage 一件我们真正用到的能力） */
function stubWindow(storage: Storage | undefined): void {
  vi.stubGlobal('window', storage === undefined ? {} : { localStorage: storage });
}

afterEach(() => vi.unstubAllGlobals());

describe('loadMotionPref：缺省与回落', () => {
  it('缺省是 "full"（不替用户默认减弱动效）', () => {
    expect(MOTION_PREF_DEFAULT).toBe('full');
  });

  it('无 window（非浏览器）→ 回默认，不抛', () => {
    // node 环境本就没有 window；这里显式兜一层语义断言
    vi.unstubAllGlobals();
    expect(typeof window).toBe('undefined');
    expect(loadMotionPref()).toBe('full');
  });

  it('window 存在但 localStorage 不可用 → 回默认，不抛', () => {
    stubWindow(undefined);
    expect(loadMotionPref()).toBe('full');
  });

  it('空存储 → 回默认', () => {
    stubWindow(fakeStorage());
    expect(loadMotionPref()).toBe('full');
  });

  it('存了 "reduced" → 读到 reduced；其它未知值 → 回默认', () => {
    stubWindow(fakeStorage({ 'kojo.ui.motion.v1': 'reduced' }));
    expect(loadMotionPref()).toBe('reduced');
    stubWindow(fakeStorage({ 'kojo.ui.motion.v1': 'weird' }));
    expect(loadMotionPref()).toBe('full');
  });

  it('getItem 抛错（隐私模式）→ 回默认，不抛', () => {
    stubWindow({
      getItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage);
    expect(loadMotionPref()).toBe('full');
  });
});

describe('saveMotionPref：写入与静默降级', () => {
  it('写入后能被 load 读回（reduced / full 往返一致）', () => {
    stubWindow(fakeStorage());
    saveMotionPref('reduced');
    expect(loadMotionPref()).toBe('reduced');
    saveMotionPref('full');
    expect(loadMotionPref()).toBe('full');
  });

  it('setItem 抛错时静默降级，不向上抛（本次会话仍可用）', () => {
    stubWindow({
      setItem: () => {
        throw new Error('quota');
      },
    } as unknown as Storage);
    expect(() => saveMotionPref('reduced')).not.toThrow();
  });

  it('localStorage 不可用时不抛（只影响下次启动）', () => {
    stubWindow(undefined);
    expect(() => saveMotionPref('reduced')).not.toThrow();
  });
});

describe('applyMotionPref：只写到根元素的 data-motion', () => {
  it('在给定根元素上设置 data-motion="reduced" / "full"', () => {
    const root = { setAttribute: vi.fn() } as unknown as HTMLElement;
    applyMotionPref('reduced', root);
    expect(root.setAttribute).toHaveBeenCalledWith('data-motion', 'reduced');
    applyMotionPref('full', root);
    expect(root.setAttribute).toHaveBeenLastCalledWith('data-motion', 'full');
  });

  it('根元素为 null 时安全跳过（无 document 环境不抛）', () => {
    expect(() => applyMotionPref('reduced', null)).not.toThrow();
  });

  it('缺省 root：node 环境无 document → 直接 no-op，不抛', () => {
    expect(typeof document).toBe('undefined');
    expect(() => applyMotionPref('reduced')).not.toThrow();
  });
});
