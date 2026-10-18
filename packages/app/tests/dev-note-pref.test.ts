/**
 * 「开发者的碎碎念」纸条的"只看一次"单测（用户反馈 2，2026-10-18）。
 *
 * 钉三件事：
 * 1. **首次**（无记录）⇒ 该弹（`loadDevNoteSeen() === false`）；
 * 2. **看过一次之后** ⇒ 永不重弹（写 '1' 后读回 true）；
 * 3. 存储不可用（无 window / getItem·setItem 抛错）⇒ 读回"没看过"且**绝不抛**——
 *    一句开发者问候不该变成启动路径上的故障源（fail-safe 是刻意选择：宁可多提示一次）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { loadDevNoteSeen, markDevNoteSeen } from '../src/ui/dev-note-pref';

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

const w = globalThis as unknown as { localStorage?: unknown };
afterEach(() => {
  delete w.localStorage;
});

describe('「开发者的碎碎念」只看一次', () => {
  it('无 localStorage（测试环境 / 非浏览器）→ 视为没看过，且写不抛', () => {
    expect(loadDevNoteSeen()).toBe(false);
    expect(() => markDevNoteSeen()).not.toThrow();
  });

  it('首次（无记录）⇒ 该弹；写过之后就永不重弹', () => {
    const f = fakeWindow();
    w.localStorage = f.localStorage;
    expect(loadDevNoteSeen(), '首次进编辑器：纸条必须弹').toBe(false);

    markDevNoteSeen();
    expect(f.bag.get('kojo.ui.devNoteSeen.v1'), '看过标记落在壳层惯例键名上').toBe('1');
    expect(loadDevNoteSeen(), '看过之后：不再打扰').toBe(true);
  });

  it('坏值（非 1，如 abc）→ 当作没看过（脏值不阻塞提示路径）', () => {
    w.localStorage = fakeWindow({ 'kojo.ui.devNoteSeen.v1': 'abc' }).localStorage;
    expect(loadDevNoteSeen()).toBe(false);
  });

  it('localStorage 抛错（隐私模式 / 配额满）→ 读回"没看过"、写不抛', () => {
    w.localStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadDevNoteSeen()).toBe(false);
    expect(() => markDevNoteSeen()).not.toThrow();
  });
});
