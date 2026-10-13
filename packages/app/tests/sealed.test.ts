/**
 * 封存总闸单测（2026-10-13 试用反馈批）。
 *
 * 钉死的是"默认封存、可临时恢复、选择被记住"三件事——这是用户口径「把没用的功能
 * 封存了、只留一个开关放在设置页」的宿主侧半边；另一半（糖视图可用门的封存轴）
 * 在 `sugar-view.test.ts`。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { SEALED_DEFAULT, SEALED_PANEL_IDS, loadSealed, setSealed, subscribeSealed } from '../src/ui/sealed';

/** 假 localStorage：只是键值袋，够测"记忆"这一件事（与 sugar-view.test.ts 同款） */
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

describe('封存总闸 / 偏好', () => {
  it('无 window（测试环境 / 非浏览器）→ 回默认封存（且不抛）', () => {
    expect(loadSealed()).toBe(SEALED_DEFAULT);
    expect(SEALED_DEFAULT).toBe(true);
    expect(() => setSealed(false)).not.toThrow();
  });

  it('无记录 → 默认封存；写过之后按记录走（1 封存 / 0 显示）', () => {
    const f = fakeWindow();
    w.window = f;
    expect(loadSealed()).toBe(true);

    setSealed(false);
    expect(f.bag.get('kojo.ui.sealed.v1')).toBe('0');
    expect(loadSealed()).toBe(false);

    setSealed(true);
    expect(f.bag.get('kojo.ui.sealed.v1')).toBe('1');
    expect(loadSealed()).toBe(true);
  });

  it('坏值（非 0/1，如 abc）→ 回落默认封存（脏偏好不阻塞启动）', () => {
    w.window = fakeWindow({ 'kojo.ui.sealed.v1': 'abc' });
    expect(loadSealed()).toBe(SEALED_DEFAULT);
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
    expect(loadSealed()).toBe(SEALED_DEFAULT);
    expect(() => setSealed(false)).not.toThrow();
  });
});

describe('封存总闸 / 订阅', () => {
  it('setSealed 触发监听；取消订阅后不再触发', () => {
    w.window = fakeWindow();
    let hits = 0;
    const un = subscribeSealed(() => hits++);

    setSealed(false);
    expect(hits).toBe(1);

    un();
    setSealed(true);
    expect(hits).toBe(1);
    expect(loadSealed()).toBe(true);
  });
});

describe('封存总闸 / 封存清单', () => {
  it('两个封存面板 id 在册（糖预览 / 归档浏览器）', () => {
    expect(SEALED_PANEL_IDS.has('sugar-preview')).toBe(true);
    expect(SEALED_PANEL_IDS.has('archive-browser')).toBe(true);
  });
});
