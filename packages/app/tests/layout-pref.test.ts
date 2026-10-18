/**
 * 排版偏好单测（P2-16）。存法与契约照 `format-pref.ts` / `motion-pref.ts`：
 * ①读不到 / 抛错一律回缺省，绝不抛到编辑器链路；②三个缺省值 = 今天的行为
 * （折行跟随体量档 / 修饰键 ctrlCmd / 列选择关）。
 * 单测环境是 `node`（无 window），故用假 localStorage 驱动。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COLUMN_SELECTION_DEFAULT,
  LAYOUT_PREF_DEFAULT,
  MULTI_CURSOR_MODIFIER_DEFAULT,
  WORD_WRAP_DEFAULT,
  loadLayoutPref,
  saveColumnSelectionPref,
  saveMultiCursorModifierPref,
  saveWordWrapPref,
  subscribeLayoutPref,
} from '../src/ui/layout-pref';

const WORD_WRAP_KEY = 'kojo.ui.layout.wordWrap.v1';
const MULTI_CURSOR_KEY = 'kojo.ui.layout.multiCursorModifier.v1';
const COLUMN_SELECTION_KEY = 'kojo.ui.layout.columnSelection.v1';

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

describe('loadLayoutPref · 缺省 trio（P2-16 硬判据：缺省 = 今天的行为）', () => {
  it('三个缺省值：折行跟随体量档 / 修饰键 ctrlCmd / 列选择关', () => {
    expect(WORD_WRAP_DEFAULT).toBe('tier');
    expect(MULTI_CURSOR_MODIFIER_DEFAULT).toBe('ctrlCmd');
    expect(COLUMN_SELECTION_DEFAULT).toBe(false);
    expect(LAYOUT_PREF_DEFAULT).toEqual({
      wordWrap: 'tier',
      multiCursorModifier: 'ctrlCmd',
      columnSelection: false,
    });
  });

  it('没 window / 没 localStorage / 键都不存在 ⇒ 回缺省（不抛）', () => {
    stubWindow(undefined);
    expect(loadLayoutPref()).toEqual(LAYOUT_PREF_DEFAULT);
    stubWindow(fakeStorage());
    expect(loadLayoutPref()).toEqual(LAYOUT_PREF_DEFAULT);
  });

  it('折行只认三个登记值；脏值（大小写变体 / 空串 / 别的字符串）回落「跟随体量档」', () => {
    for (const v of ['', 'ON', 'Off', 'tier ', 'on-on', 'wordWrapColumn']) {
      stubWindow(fakeStorage({ [WORD_WRAP_KEY]: v }));
      expect(loadLayoutPref().wordWrap, `值=${JSON.stringify(v)}`).toBe('tier');
    }
    for (const v of ['tier', 'on', 'off'] as const) {
      stubWindow(fakeStorage({ [WORD_WRAP_KEY]: v }));
      expect(loadLayoutPref().wordWrap).toBe(v);
    }
  });

  it('修饰键只认 ctrlCmd / alt；"altKey"（Monaco 内部名）不算登记值，回落 ctrlCmd', () => {
    for (const v of ['', 'Alt', 'shift', 'altKey', 'metaKey']) {
      stubWindow(fakeStorage({ [MULTI_CURSOR_KEY]: v }));
      expect(loadLayoutPref().multiCursorModifier, `值=${JSON.stringify(v)}`).toBe('ctrlCmd');
    }
    stubWindow(fakeStorage({ [MULTI_CURSOR_KEY]: 'alt' }));
    expect(loadLayoutPref().multiCursorModifier).toBe('alt');
    stubWindow(fakeStorage({ [MULTI_CURSOR_KEY]: 'ctrlCmd' }));
    expect(loadLayoutPref().multiCursorModifier).toBe('ctrlCmd');
  });

  it('列选择同 suggest-pref 布尔口径：只有 "1" 算开', () => {
    for (const v of ['0', '', 'true', 'yes', '2']) {
      stubWindow(fakeStorage({ [COLUMN_SELECTION_KEY]: v }));
      expect(loadLayoutPref().columnSelection, `值=${JSON.stringify(v)}`).toBe(false);
    }
    stubWindow(fakeStorage({ [COLUMN_SELECTION_KEY]: '1' }));
    expect(loadLayoutPref().columnSelection).toBe(true);
  });

  it('三键互不串读：只存一个，另外两个仍是缺省', () => {
    stubWindow(fakeStorage({ [WORD_WRAP_KEY]: 'off' }));
    expect(loadLayoutPref()).toEqual({
      wordWrap: 'off',
      multiCursorModifier: 'ctrlCmd',
      columnSelection: false,
    });
  });

  it('getItem 抛错（隐私模式）⇒ 整份回缺省，不抛', () => {
    const s = fakeStorage();
    s.getItem = () => {
      throw new Error('boom');
    };
    stubWindow(s);
    expect(loadLayoutPref()).toEqual(LAYOUT_PREF_DEFAULT);
  });
});

describe('save*Pref · 写入、降级与订阅', () => {
  it('三个键各自写各自的值，读回来逐字一致', () => {
    const s = fakeStorage();
    stubWindow(s);
    saveWordWrapPref('off');
    saveMultiCursorModifierPref('alt');
    saveColumnSelectionPref(true);
    expect(s.getItem(WORD_WRAP_KEY)).toBe('off');
    expect(s.getItem(MULTI_CURSOR_KEY)).toBe('alt');
    expect(s.getItem(COLUMN_SELECTION_KEY)).toBe('1');
    expect(loadLayoutPref()).toEqual({
      wordWrap: 'off',
      multiCursorModifier: 'alt',
      columnSelection: true,
    });
    saveWordWrapPref('tier');
    saveColumnSelectionPref(false);
    expect(s.getItem(WORD_WRAP_KEY)).toBe('tier');
    expect(s.getItem(COLUMN_SELECTION_KEY)).toBe('0');
  });

  it('写不进去不算错（配额满 / 隐私模式）：不外抛，订阅者照样收到通知', () => {
    const s = fakeStorage();
    s.setItem = () => {
      throw new Error('quota');
    };
    stubWindow(s);
    let notified = 0;
    const unsub = subscribeLayoutPref(() => {
      notified += 1;
    });
    expect(() => saveWordWrapPref('on')).not.toThrow();
    expect(notified).toBe(1);
    unsub();
    saveWordWrapPref('off');
    expect(notified).toBe(1); // 退订之后不再通知
  });

  it('无 window（node / worker）⇒ 静默跳过，读仍是缺省', () => {
    stubWindow(undefined);
    expect(() => saveWordWrapPref('on')).not.toThrow();
    expect(() => saveColumnSelectionPref(true)).not.toThrow();
    expect(loadLayoutPref()).toEqual(LAYOUT_PREF_DEFAULT);
  });
});

describe('loadLayoutPref · 快照引用稳定（useSyncExternalStore 的 getSnapshot 契约）', () => {
  it('存储没变 ⇒ 连续读返回同一个对象引用（React 判"快照在变"会死循环重渲染）', () => {
    stubWindow(fakeStorage());
    const a = loadLayoutPref();
    const b = loadLayoutPref();
    expect(b).toBe(a);
    // 经 save* 写回同值，引用也不必换
    saveWordWrapPref('tier');
    expect(loadLayoutPref()).toBe(a);
  });

  it('值变了 ⇒ 返回新引用且新值可见；外部（绕过 save*）改存储同样被下一次读看见', () => {
    stubWindow(fakeStorage());
    const before = loadLayoutPref();
    saveWordWrapPref('off');
    const after = loadLayoutPref();
    expect(after).not.toBe(before);
    expect(after.wordWrap).toBe('off');
    // 模拟 devtools / 另一窗口直改 localStorage
    const s = fakeStorage();
    s.setItem(MULTI_CURSOR_KEY, 'alt');
    stubWindow(s);
    const external = loadLayoutPref();
    expect(external).not.toBe(after);
    expect(external.multiCursorModifier).toBe('alt');
  });

  it('回缺省（脏值 / 无 window）同样引用稳定', () => {
    stubWindow(fakeStorage({ [WORD_WRAP_KEY]: 'garbage' }));
    const a = loadLayoutPref();
    expect(a).toEqual(LAYOUT_PREF_DEFAULT);
    expect(loadLayoutPref()).toBe(a);
    stubWindow(undefined);
    expect(loadLayoutPref()).toBe(a); // 同为缺省三字段 ⇒ 复用引用
  });
});
