/**
 * 「保存时整理空白」偏好单测（E2）。存法与契约照 `motion-pref.ts`：
 * ①读不到 / 抛错一律回默认，绝不把保存链路卡死；②默认**关**（新功能默认关）。
 * 单测环境是 `node`（无 window），故用假 localStorage 驱动。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FORMAT_ON_SAVE_DEFAULT, loadFormatOnSavePref, saveFormatOnSavePref } from '../src/ui/format-pref';

const KEY = 'kojo.ui.formatOnSave.v1';

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

describe('loadFormatOnSavePref · 缺省与回落', () => {
  it('默认是关', () => {
    expect(FORMAT_ON_SAVE_DEFAULT).toBe(false);
  });

  it('没 window / 没 localStorage / 键不存在 ⇒ 都是关（不抛）', () => {
    stubWindow(undefined);
    expect(loadFormatOnSavePref()).toBe(false);
    stubWindow(fakeStorage());
    expect(loadFormatOnSavePref()).toBe(false);
  });

  it('只有存过 "on" 才算开；别的值（含 "true"/空串/脏值）按默认关', () => {
    for (const v of ['true', '1', '', 'off', 'on-on']) {
      stubWindow(fakeStorage({ [KEY]: v }));
      expect(loadFormatOnSavePref(), `值=${JSON.stringify(v)}`).toBe(false);
    }
    stubWindow(fakeStorage({ [KEY]: 'on' }));
    expect(loadFormatOnSavePref()).toBe(true);
  });

  it('getItem 抛错（隐私模式）⇒ 回默认，不抛', () => {
    const s = fakeStorage();
    s.getItem = () => {
      throw new Error('boom');
    };
    stubWindow(s);
    expect(loadFormatOnSavePref()).toBe(false);
  });
});

describe('saveFormatOnSavePref · 写入与降级', () => {
  it('开 = 存 "on"；关 = 清掉键（存储里不留"关"的第二种写法）', () => {
    const s = fakeStorage();
    stubWindow(s);
    saveFormatOnSavePref(true);
    expect(s.getItem(KEY)).toBe('on');
    expect(loadFormatOnSavePref()).toBe(true);
    saveFormatOnSavePref(false);
    expect(s.getItem(KEY)).toBeNull();
    expect(loadFormatOnSavePref()).toBe(false);
  });

  it('写不进去不算错（配额满 / 隐私模式）：本次会话仍按内存值走，不外抛', () => {
    const s = fakeStorage();
    s.setItem = () => {
      throw new Error('quota');
    };
    s.removeItem = () => {
      throw new Error('quota');
    };
    stubWindow(s);
    expect(() => saveFormatOnSavePref(true)).not.toThrow();
    expect(() => saveFormatOnSavePref(false)).not.toThrow();
  });

  it('无 window（node / worker）⇒ 静默跳过，读仍是默认', () => {
    stubWindow(undefined);
    expect(() => saveFormatOnSavePref(true)).not.toThrow();
    expect(loadFormatOnSavePref()).toBe(false);
  });
});
