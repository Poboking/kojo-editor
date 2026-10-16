import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_PREF_DEFAULT,
  applyThemePref,
  loadThemePref,
  normalizeTheme,
  setThemePref,
} from '../src/ui/theme-pref';

/**
 * 主题偏好单测（2026-10-17 主题系统）。环境是 node（无 window / document），
 * 用假 localStorage + 假根元素钉死两条与 glass/motion 同款契约：
 * ①读不到/非法/抛错一律回默认 dark、绝不抛；②applyThemePref 只写根元素一个 data-theme 属性。
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

function stubWindow(storage: Storage | undefined): void {
  vi.stubGlobal('window', storage === undefined ? {} : { localStorage: storage });
}

afterEach(() => vi.unstubAllGlobals());

describe('normalizeTheme：非法值归一', () => {
  it('三档原样，其余（含 null/未知串）→ dark', () => {
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('mint-dark')).toBe('mint-dark');
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('solar')).toBe('dark');
    expect(normalizeTheme('')).toBe('dark');
    expect(normalizeTheme(null)).toBe('dark');
    expect(normalizeTheme(undefined)).toBe('dark');
  });
});

describe('loadThemePref：缺省与回落', () => {
  it('缺省是 dark（不替用户默认换主题）', () => {
    expect(THEME_PREF_DEFAULT).toBe('dark');
  });

  it('无 window / 无 localStorage / 空存储 → 回 dark，不抛', () => {
    vi.unstubAllGlobals();
    expect(loadThemePref()).toBe('dark');
    stubWindow(undefined);
    expect(loadThemePref()).toBe('dark');
    stubWindow(fakeStorage());
    expect(loadThemePref()).toBe('dark');
  });

  it('存了合法值读到该值；未知值 → dark', () => {
    stubWindow(fakeStorage({ 'kojo.ui.theme.v1': 'light' }));
    expect(loadThemePref()).toBe('light');
    stubWindow(fakeStorage({ 'kojo.ui.theme.v1': 'mint-dark' }));
    expect(loadThemePref()).toBe('mint-dark');
    stubWindow(fakeStorage({ 'kojo.ui.theme.v1': 'weird' }));
    expect(loadThemePref()).toBe('dark');
  });

  it('getItem 抛错（隐私模式）→ 回 dark，不抛', () => {
    stubWindow({
      getItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage);
    expect(loadThemePref()).toBe('dark');
  });
});

describe('setThemePref：写入、归一与往返', () => {
  it('写入后能被 load 读回；非法值先归一再存', () => {
    stubWindow(fakeStorage());
    setThemePref('light');
    expect(loadThemePref()).toBe('light');
    setThemePref('mint-dark');
    expect(loadThemePref()).toBe('mint-dark');
    // 越界值经 set 归一为 dark 落盘（不往存储里塞脏值）
    stubWindow(fakeStorage());
    setThemePref('nope' as never);
    expect(loadThemePref()).toBe('dark');
  });

  it('setItem 抛错 / localStorage 不可用时静默降级，不向上抛', () => {
    stubWindow({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    } as unknown as Storage);
    expect(() => setThemePref('light')).not.toThrow();
    stubWindow(undefined);
    expect(() => setThemePref('light')).not.toThrow();
  });
});

describe('applyThemePref：只写根元素的 data-theme', () => {
  it('在给定根元素上设置 data-theme，且非法值先归一', () => {
    const root = { setAttribute: vi.fn() };
    applyThemePref('light', root);
    expect(root.setAttribute).toHaveBeenCalledWith('data-theme', 'light');
    applyThemePref('nope' as never, root);
    expect(root.setAttribute).toHaveBeenLastCalledWith('data-theme', 'dark');
  });

  it('根元素为 null / node 无 document → 安全跳过，不抛', () => {
    expect(() => applyThemePref('light', null)).not.toThrow();
    expect(typeof document).toBe('undefined');
    expect(() => applyThemePref('light')).not.toThrow();
  });
});
