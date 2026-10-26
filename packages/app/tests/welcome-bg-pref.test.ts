/**
 * 欢迎页背景档单测（2026-10-26 用户反馈批）。契约照 `glass-pref.test.ts`：
 * ①缺省 = 素雅；②未知值 / 读抛错一律回缺省，绝不把脏值写进 `data-welcome-bg`；
 * ③生效路径唯一（写根元素属性，无根元素时安全跳过）；④写档即落属性并广播。
 * 单测环境是 node（无 window / document），用假 localStorage 与假根元素驱动。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WELCOME_BG_DEFAULT,
  WELCOME_BG_IDS,
  applyWelcomeBgPref,
  loadWelcomeBgPref,
  normalizeWelcomeBg,
  resetWelcomeBgPref,
  setWelcomeBgPref,
  subscribeWelcomeBg,
  type WelcomeBgRoot,
} from '../src/ui/welcome-bg-pref';

const KEY = 'kojo.ui.welcome.background.v1';

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

function stubRoot(): WelcomeBgRoot & { attrs: Record<string, string> } {
  const attrs: Record<string, string> = {};
  return { attrs, setAttribute: (n, v) => void (attrs[n] = v) };
}

afterEach(() => vi.unstubAllGlobals());

describe('缺省与归一化', () => {
  it('缺省 = 素雅；三档 id 固定为 quiet / aurora / plain', () => {
    expect(WELCOME_BG_DEFAULT).toBe('quiet');
    expect([...WELCOME_BG_IDS]).toEqual(['quiet', 'aurora', 'plain']);
  });

  it('没 window / 无 localStorage / 键缺席 ⇒ 缺省（不抛）', () => {
    stubWindow(undefined);
    expect(loadWelcomeBgPref()).toBe(WELCOME_BG_DEFAULT);
    stubWindow(fakeStorage());
    expect(loadWelcomeBgPref()).toBe(WELCOME_BG_DEFAULT);
  });

  it('未知值 / 空串 / 非字符串一律回缺省（脏值绝不进 data-welcome-bg）', () => {
    for (const junk of ['', 'Aurora', 'fancy', 'null', 'quiet ']) {
      expect(normalizeWelcomeBg(junk), junk).toBe(WELCOME_BG_DEFAULT);
    }
    expect(normalizeWelcomeBg(undefined)).toBe(WELCOME_BG_DEFAULT);
    expect(normalizeWelcomeBg(3)).toBe(WELCOME_BG_DEFAULT);
    for (const good of WELCOME_BG_IDS) expect(normalizeWelcomeBg(good)).toBe(good);
  });

  it('读抛错 ⇒ 回缺省，绝不抛到渲染链', () => {
    const boom = {
      getItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    stubWindow(boom);
    expect(loadWelcomeBgPref()).toBe(WELCOME_BG_DEFAULT);
  });
});

describe('set / reset · 存储、落属性与广播', () => {
  it('写档：归一化后存盘、当场落根属性、广播一次', () => {
    const storage = fakeStorage();
    stubWindow(storage);
    const root = stubRoot();
    // 模块级 apply 用缺省 root（document.documentElement，node 下缺席）；这里换掉全局后再点一次
    vi.stubGlobal('document', { documentElement: root });
    const seen = vi.fn();
    const off = subscribeWelcomeBg(seen);
    setWelcomeBgPref('aurora');
    expect(storage.getItem(KEY)).toBe('aurora');
    expect(root.attrs['data-welcome-bg']).toBe('aurora');
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    setWelcomeBgPref('plain');
    expect(seen).toHaveBeenCalledTimes(1);
    expect(root.attrs['data-welcome-bg']).toBe('plain');
  });

  it('非法入参也只会落缺省档（存储与属性同源）', () => {
    const storage = fakeStorage();
    stubWindow(storage);
    const root = stubRoot();
    vi.stubGlobal('document', { documentElement: root });
    setWelcomeBgPref('nonsense' as never);
    expect(storage.getItem(KEY)).toBe(WELCOME_BG_DEFAULT);
    expect(root.attrs['data-welcome-bg']).toBe(WELCOME_BG_DEFAULT);
  });

  it('reset 回缺省；写盘抛错也照样落属性并广播（本次会话仍生效）', () => {
    const boom = {
      setItem: () => {
        throw new Error('quota');
      },
    } as unknown as Storage;
    stubWindow(boom);
    const root = stubRoot();
    vi.stubGlobal('document', { documentElement: root });
    const seen = vi.fn();
    subscribeWelcomeBg(seen);
    resetWelcomeBgPref();
    expect(root.attrs['data-welcome-bg']).toBe(WELCOME_BG_DEFAULT);
    expect(seen).toHaveBeenCalled();
  });
});

describe('applyWelcomeBgPref · 唯一生效路径', () => {
  it('把归一化后的档位写到 root 的 data-welcome-bg', () => {
    const root = stubRoot();
    applyWelcomeBgPref('aurora', root);
    expect(root.attrs['data-welcome-bg']).toBe('aurora');
    applyWelcomeBgPref('nonsense' as never, root);
    expect(root.attrs['data-welcome-bg']).toBe(WELCOME_BG_DEFAULT);
  });

  it('root 为 null / node 无 document 时安全跳过', () => {
    expect(() => applyWelcomeBgPref('aurora', null)).not.toThrow();
    expect(typeof document).toBe('undefined');
    expect(() => applyWelcomeBgPref('aurora')).not.toThrow();
  });
});
