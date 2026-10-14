/**
 * 面板偏好单测（2026-10-14 面板偏好批）。
 *
 * 钉死「长列表视口化」这条宿主侧半边的三件事：**默认关、可开启、选择被记住**，
 * 外加脏数据 / 无 window / 隐私模式一律**回落到保守值（false）**——这是设置页开关
 * 能安全下传给面板的前提（面板按 `uiPrefs.panelVirtualize` 缺省即 false 编写）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  PANEL_VIRTUALIZE_DEFAULT,
  loadPanelVirtualize,
  setPanelVirtualize,
  subscribePanelVirtualize,
} from '../src/ui/panel-prefs';

/** 假 localStorage：只是键值袋，够测"记忆"这一件事（与 direct-mode.test.ts 同款） */
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

describe('长列表视口化 / 偏好', () => {
  it('无 window（测试环境 / 非浏览器）→ 回默认关（且不抛）', () => {
    expect(loadPanelVirtualize()).toBe(PANEL_VIRTUALIZE_DEFAULT);
    expect(PANEL_VIRTUALIZE_DEFAULT).toBe(false);
    expect(() => setPanelVirtualize(true)).not.toThrow();
  });

  it('无记录 → 默认关；写过之后按记录走（1 开 / 0 关）', () => {
    const f = fakeWindow();
    w.window = f;
    expect(loadPanelVirtualize()).toBe(false);

    setPanelVirtualize(true);
    expect(f.bag.get('kojo.ui.panelVirtualize.v1')).toBe('1');
    expect(loadPanelVirtualize()).toBe(true);

    setPanelVirtualize(false);
    expect(f.bag.get('kojo.ui.panelVirtualize.v1')).toBe('0');
    expect(loadPanelVirtualize()).toBe(false);
  });

  it('坏值（非 0/1，如 yes）→ 回落默认关（脏偏好不阻塞启动）', () => {
    w.window = fakeWindow({ 'kojo.ui.panelVirtualize.v1': 'yes' });
    expect(loadPanelVirtualize()).toBe(PANEL_VIRTUALIZE_DEFAULT);
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
    expect(loadPanelVirtualize()).toBe(PANEL_VIRTUALIZE_DEFAULT);
    expect(() => setPanelVirtualize(true)).not.toThrow();
  });
});

describe('长列表视口化 / 订阅', () => {
  it('setPanelVirtualize 触发监听；取消订阅后不再触发', () => {
    w.window = fakeWindow();
    let hits = 0;
    const un = subscribePanelVirtualize(() => hits++);

    setPanelVirtualize(true);
    expect(hits).toBe(1);

    un();
    setPanelVirtualize(false);
    expect(hits).toBe(1);
    expect(loadPanelVirtualize()).toBe(false);
  });
});
