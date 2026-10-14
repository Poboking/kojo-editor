/**
 * 直连模式开关单测（2026-10-14 直连模式批）。
 *
 * 钉死的是"默认关、可开启、选择被记住"三件事——这是用户口径「保留『直连模式』兼容
 * 就地编辑」的宿主侧半边；另一半（编辑器 readOnly 门 + 糖视图互斥）在 `EditorPane`。
 *
 * 注意：写保护铁律**不测在本文件**——可写性完全来自 `kernel.io.isWritable`（内核 io
 * 写白名单），本开关只影响编辑器 readOnly 门；直连模式不扩权。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DIRECT_MODE_DEFAULT,
  loadDirectMode,
  setDirectMode,
  subscribeDirectMode,
} from '../src/ui/direct-mode';

/** 假 localStorage：只是键值袋，够测"记忆"这一件事（与 sealed.test.ts 同款） */
function fakeWindow(seed: Record<string, string> = {}) {
  const bag = new Map(Object.entries(seed));
  return {
    localStorage: {
      getItem: (k: string) => bag.get(k) ?? null,
      setItem: (k: string, v: string) => void bag.set(k, v),
      removeItem: (k: string) => void bag.delete(k),
      clear: () => bag.clear(),
      key: () => null,
      length: 0,
    },
    bag,
  };
}

const w = globalThis as unknown as { window?: unknown };
afterEach(() => {
  delete w.window;
});

describe('直连模式 / 偏好', () => {
  it('无 window（测试环境 / 非浏览器）→ 回默认关（且不抛）', () => {
    expect(loadDirectMode()).toBe(DIRECT_MODE_DEFAULT);
    expect(DIRECT_MODE_DEFAULT).toBe(false);
    expect(() => setDirectMode(true)).not.toThrow();
  });

  it('无记录 → 默认关；写过之后按记录走（1 开 / 0 关）', () => {
    const f = fakeWindow();
    w.window = f;
    expect(loadDirectMode()).toBe(false);

    setDirectMode(true);
    expect(f.bag.get('kojo.ui.directMode.v1')).toBe('1');
    expect(loadDirectMode()).toBe(true);

    setDirectMode(false);
    expect(f.bag.get('kojo.ui.directMode.v1')).toBe('0');
    expect(loadDirectMode()).toBe(false);
  });

  it('坏值（非 0/1，如 abc）→ 回落默认关（脏偏好不阻塞启动）', () => {
    w.window = fakeWindow({ 'kojo.ui.directMode.v1': 'abc' });
    expect(loadDirectMode()).toBe(DIRECT_MODE_DEFAULT);
  });

  it('localStorage 抛错（隐私模式 / 配额满）→ 读回默认、写不抛', () => {
    w.window = {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      },
    };
    expect(loadDirectMode()).toBe(DIRECT_MODE_DEFAULT);
    expect(() => setDirectMode(true)).not.toThrow();
  });
});

describe('直连模式 / 订阅', () => {
  it('setDirectMode 触发监听；取消订阅后不再触发', () => {
    w.window = fakeWindow();
    let hits = 0;
    const un = subscribeDirectMode(() => hits++);

    setDirectMode(true);
    expect(hits).toBe(1);

    un();
    setDirectMode(false);
    expect(hits).toBe(1);
    expect(loadDirectMode()).toBe(false);
  });
});
