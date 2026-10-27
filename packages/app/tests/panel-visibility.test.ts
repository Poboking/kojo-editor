/**
 * 可选面板显隐（`panel-visibility.ts`）的判据 —— 用户 2026-10-27 反馈 5：
 * 「删除「口上XML」按钮，默认关闭，需要在设置里显示开启」。
 *
 * 只证四件事，别的（设置页怎么排版、活动栏怎么画）不在这里重复：
 * ① 缺省按 id 表：表内的面板**不显示**，表外的一律照旧显示；
 * ② 开关落 localStorage 且重读得到原值，订阅者收得到一次通知；
 * ③ 脏值 / 无存储的失败方向是"少露"（回缺省），绝不抛；
 * ④ 编排闸只作用于表内那几只（表内那枚消失、别的一枚不动）。
 *
 * 挂 `node` 环境（app 池默认）：偏好模块只在调用时摸 `window.localStorage`，
 * 给一份最小存储垫片即可跑纯逻辑。
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HIDDEN_BY_DEFAULT_PANEL_IDS,
  filterHiddenPanels,
  isOptionalPanelId,
  loadPanelVisible,
  readPanelVisibility,
  setPanelVisible,
  subscribePanelVisibility,
} from '../src/ui/panel-visibility';

/** 最小 localStorage 垫片（node 池没有 window；偏好模块的读取面就是这几条） */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  } as Storage;
}

const FIRST = HIDDEN_BY_DEFAULT_PANEL_IDS[0]!;

beforeAll(() => {
  (globalThis as { window?: { localStorage: Storage } }).window = { localStorage: memoryStorage() };
});

beforeEach(() => {
  // 快照缓存是模块级的：先经 setter 走一遍把它作废，再清盘 ⇒ 下一读回到"从没存过"
  setPanelVisible(FIRST, false);
  window.localStorage.clear();
});

describe('缺省口径：表内收起、表外照旧', () => {
  it('「口上 XML」（kojo-xml）缺省不显示；表外面板缺省显示', () => {
    expect(isOptionalPanelId('kojo-xml')).toBe(true);
    expect(isOptionalPanelId('kojo-explorer')).toBe(false);
    expect(loadPanelVisible(FIRST)).toBe(false);
    expect(loadPanelVisible('kojo-explorer')).toBe(true);
  });

  it('存过就照存的来：开 → 重读 true，关 → 重读 false', () => {
    setPanelVisible('kojo-xml', true);
    expect(loadPanelVisible('kojo-xml')).toBe(true);
    setPanelVisible('kojo-xml', false);
    expect(loadPanelVisible('kojo-xml')).toBe(false);
    expect(window.localStorage.getItem('kojo.ui.panelVisible.kojo-xml.v1')).toBe('0');
  });

  it('脏值回缺省（表内 = 收起）；写不进去也不抛', () => {
    window.localStorage.setItem('kojo.ui.panelVisible.kojo-xml.v1', 'oops');
    expect(loadPanelVisible('kojo-xml')).toBe(false);
    expect(() => setPanelVisible('kojo-xml', true)).not.toThrow();
  });
});

describe('订阅与快照', () => {
  it('改值广播一次；退订后不再收到', () => {
    let hits = 0;
    const off = subscribePanelVisibility(() => {
      hits += 1;
    });
    setPanelVisible('kojo-xml', true);
    off();
    setPanelVisible('kojo-xml', false);
    expect(hits).toBe(1);
  });

  it('快照在没变时是同一个引用（useSyncExternalStore 的硬要求），变了一次就换新', () => {
    const a = readPanelVisibility();
    expect(readPanelVisibility()).toBe(a);
    setPanelVisible('kojo-xml', true);
    const b = readPanelVisibility();
    expect(b).not.toBe(a);
    expect(b['kojo-xml']).toBe(true);
  });
});

describe('编排闸：只作用于表内那几只', () => {
  it('收起态滤掉表内面板、其余顺序不变；打开后原样回来', () => {
    const panels = [{ id: 'kojo-explorer' }, { id: 'kojo-xml' }, { id: 'kojo-outline' }];
    const hidden = filterHiddenPanels(panels, { 'kojo-xml': false });
    expect(hidden.map((p) => p.id)).toEqual(['kojo-explorer', 'kojo-outline']);
    const shown = filterHiddenPanels(panels, { 'kojo-xml': true });
    expect(shown.map((p) => p.id)).toEqual(['kojo-explorer', 'kojo-xml', 'kojo-outline']);
  });

  it('快照里没记到的表外面板一律留下（本模块只做减法，不做第二张白名单）', () => {
    expect(filterHiddenPanels([{ id: 'kojo-market' }], {}).map((p) => p.id)).toEqual(['kojo-market']);
  });
});
