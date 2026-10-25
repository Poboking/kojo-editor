import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOKMARKS_STORAGE_KEY,
  applyContentChanges,
  bookmarkCountOf,
  bookmarkFileCount,
  bookmarkLinesOf,
  bookmarksVersion,
  clearAllBookmarks,
  clearFileBookmarks,
  hasBookmark,
  nextBookmark,
  prevBookmark,
  sanitizeBookmarks,
  shiftBookmarkLines,
  subscribeBookmarks,
  toggleBookmark,
  type BookmarkChange,
} from '../src/ui/bookmarks';

/**
 * 文档内书签纯逻辑（1026 编辑器体感 C 批）。
 *
 * 钉的是四件事：①集合形态（1 基、升序去重、坏行号拒绝）；②持久化清洗与读回
 * （脏数据丢弃、`pathKey` 归一合并、存储不可写不炸）；③跳转语义（严格大于/小于 + 回绕，
 * 空集合答 `null`）；④**行号漂移**——本批最易出 bug 的点，逐条把口径钉成断言。
 */

/** 行锚视图（旧坐标 + 行数差）的构造糖 */
const CH = (startLine: number, endLine: number, lineDelta: number): BookmarkChange => ({
  startLine,
  endLine,
  lineDelta,
});

beforeEach(() => {
  clearAllBookmarks();
});

describe('集合形态（1 基 + 升序去重 + 非法行拒绝）', () => {
  it('toggle 增删；集合恒升序（乱序加入也归一）', () => {
    expect(toggleBookmark('/a.erb', 10)).toBe(true);
    expect(toggleBookmark('/a.erb', 3)).toBe(true);
    expect(toggleBookmark('/a.erb', 7)).toBe(true);
    expect(bookmarkLinesOf('/a.erb')).toEqual([3, 7, 10]);
    expect(toggleBookmark('/a.erb', 7)).toBe(false);
    expect(bookmarkLinesOf('/a.erb')).toEqual([3, 10]);
    expect(hasBookmark('/a.erb', 3)).toBe(true);
    expect(hasBookmark('/a.erb', 7)).toBe(false);
    expect(bookmarkCountOf('/a.erb')).toBe(2);
  });

  it('非法行号 / 空路径一律 no-op（坏数据不进集合）', () => {
    expect(toggleBookmark('/a.erb', 0)).toBe(false);
    expect(toggleBookmark('/a.erb', -1)).toBe(false);
    expect(toggleBookmark('/a.erb', 2.5)).toBe(false);
    expect(toggleBookmark('/a.erb', Number.NaN)).toBe(false);
    expect(toggleBookmark('', 3)).toBe(false);
    expect(bookmarkCountOf('/a.erb')).toBe(0);
  });

  it('查询返回副本（外部改不动真源）', () => {
    toggleBookmark('/a.erb', 5);
    const snapshot = bookmarkLinesOf('/a.erb') as number[];
    snapshot.push(99);
    expect(bookmarkLinesOf('/a.erb')).toEqual([5]);
  });

  it('清空：clearFile 返回条数；clearAll 汇总条数；空集合不广播', () => {
    toggleBookmark('/a.erb', 1);
    toggleBookmark('/a.erb', 2);
    toggleBookmark('/b.erb', 9);
    expect(bookmarkFileCount()).toBe(2);
    expect(clearFileBookmarks('/a.erb')).toBe(2);
    expect(bookmarkCountOf('/a.erb')).toBe(0);
    expect(bookmarkCountOf('/b.erb')).toBe(1);

    const listener = vi.fn();
    const off = subscribeBookmarks(listener);
    expect(clearFileBookmarks('/a.erb')).toBe(0); // 本来就没有 ⇒ 不广播
    expect(listener).not.toHaveBeenCalled();
    expect(clearAllBookmarks()).toBe(1);
    expect(bookmarkFileCount()).toBe(0);
    off();
  });

  it('pathKey 归一：两种写法是同一份书签', () => {
    toggleBookmark('C:\\notes\\A.ERB', 4);
    expect(hasBookmark('c:/notes/a.erb', 4)).toBe(true);
    expect(bookmarkCountOf('C:\\notes\\a.erb')).toBe(1);
  });
});

describe('跳转（严格大于/小于 + 回绕）', () => {
  beforeEach(() => {
    for (const line of [3, 7, 12]) toggleBookmark('/a.erb', line);
  });

  it('next：取 fromLine 之后的第一枚；越过末尾回绕到第一枚', () => {
    expect(nextBookmark('/a.erb', 3)).toBe(7);
    expect(nextBookmark('/a.erb', 7)).toBe(12);
    expect(nextBookmark('/a.erb', 12)).toBe(3); // 回绕
    expect(nextBookmark('/a.erb', 0)).toBe(3);
  });

  it('prev：取 fromLine 之前的最后一枚；越过开头回绕到最后一枚', () => {
    expect(prevBookmark('/a.erb', 12)).toBe(7);
    expect(prevBookmark('/a.erb', 5)).toBe(3);
    expect(prevBookmark('/a.erb', 3)).toBe(12); // 回绕
    expect(prevBookmark('/a.erb', 100)).toBe(12);
  });

  it('没有书签的文件答 null（命令侧据此出声，不静默）', () => {
    expect(nextBookmark('/empty.erb', 1)).toBeNull();
    expect(prevBookmark('/empty.erb', 1)).toBeNull();
  });
});

describe('行号漂移：shiftBookmarkLines（口径 = 行号锚）', () => {
  it('变更完全在书签下方 ⇒ 只平移其上的', () => {
    expect(shiftBookmarkLines([5, 10], CH(8, 8, 2))).toEqual([5, 12]);
  });

  it('变更完全在书签上方 ⇒ 整段平移', () => {
    expect(shiftBookmarkLines([5, 10], CH(2, 2, 3))).toEqual([8, 13]);
  });

  it('区间之外的行内编辑（lineDelta 0）⇒ 原样', () => {
    expect(shiftBookmarkLines([5, 10], CH(7, 7, 0))).toEqual([5, 10]);
  });

  it('书签行被行内编辑 ⇒ 钉在原行', () => {
    expect(shiftBookmarkLines([5, 10], CH(5, 5, 0))).toEqual([5, 10]);
  });

  it('书签行被整行删除 ⇒ 钉到变更起点（不静默消失）', () => {
    expect(shiftBookmarkLines([5, 10], CH(5, 5, -1))).toEqual([5, 9]);
  });

  it('被编辑区间跨越书签 ⇒ 区间内的钉到起点，其上方的整段平移', () => {
    expect(shiftBookmarkLines([5, 10], CH(4, 8, 3))).toEqual([4, 13]);
  });

  it('maxLine 给出时夹取（删除文档末尾那段时不过界）', () => {
    expect(shiftBookmarkLines([5], CH(2, 2, 3), 5)).toEqual([5]);
  });

  it('空集合恒空', () => {
    expect(shiftBookmarkLines([], CH(1, 1, 1))).toEqual([]);
  });

  it('多枚书签被钉到同一行时去重', () => {
    expect(shiftBookmarkLines([5, 6], CH(3, 9, -4))).toEqual([3]);
  });
});

describe('applyContentChanges（折进真实集合）', () => {
  it('多个变更按 startLine 降序应用（旧坐标基准不被后方平移污染）', () => {
    for (const line of [5, 10]) toggleBookmark('/a.erb', line);
    expect(applyContentChanges('/a.erb', [CH(3, 3, 1), CH(8, 9, -2)])).toBe(true);
    expect(bookmarkLinesOf('/a.erb')).toEqual([6, 9]);
  });

  it('折完与原来一样 ⇒ 返回 false 且不广播（编辑热路径零开销）', () => {
    toggleBookmark('/a.erb', 5);
    const listener = vi.fn();
    const off = subscribeBookmarks(listener);
    const before = bookmarksVersion();
    expect(applyContentChanges('/a.erb', [CH(3, 3, 0)])).toBe(false);
    expect(bookmarksVersion()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it('没有书签的文件 / 空变更数组 ⇒ 直接 false', () => {
    expect(applyContentChanges('/none.erb', [CH(1, 1, 1)])).toBe(false);
    toggleBookmark('/a.erb', 5);
    expect(applyContentChanges('/a.erb', [])).toBe(false);
  });

  it('maxLine 夹取在集成路径上生效', () => {
    toggleBookmark('/a.erb', 5);
    applyContentChanges('/a.erb', [CH(1, 1, 10)], 6);
    expect(bookmarkLinesOf('/a.erb')).toEqual([6]);
  });
});

describe('持久化（localStorage 清洗与读回）', () => {
  /** node 环境没有 localStorage：装一个假的并按需重装模块，才走得到启动那一次的清洗 */
  function useLocalStorage(seed: unknown): Map<string, string> {
    const store = new Map<string, string>();
    if (seed !== undefined) store.set(BOOKMARKS_STORAGE_KEY, JSON.stringify(seed));
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    });
    return store;
  }

  const freshInstance = async () => {
    vi.resetModules();
    return await import('../src/ui/bookmarks');
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('sanitizeBookmarks：坏形态回空表，坏行号丢弃，归一键合并', () => {
    const out = sanitizeBookmarks({
      'C:\\notes\\A.ERB': [5, 1, 5, 0, -3, 'x', 2.5],
      'c:/notes/a.erb': [7],
      bad: 'nope',
      '': [9],
    });
    expect(out.size).toBe(1);
    // `pathKey` 在 win32 形态下统一分隔符（`/` → `\`）并折叠大小写
    expect(out.get('c:\\notes\\a.erb')).toEqual([1, 5, 7]);
    expect(sanitizeBookmarks(null).size).toBe(0);
    expect(sanitizeBookmarks([1, 2]).size).toBe(0);
    expect(sanitizeBookmarks('{}').size).toBe(0);
  });

  it('启动读回：坏数据丢弃、好值按归一键合并', async () => {
    useLocalStorage({
      'C:\\notes\\A.ERB': [5, 0, 9],
      'c:/notes/a.erb': [2],
      junkFile: 42,
    });
    const mod = await freshInstance();
    expect(mod.bookmarkLinesOf('c:/NOTES/a.erb')).toEqual([2, 5, 9]);
    expect(mod.bookmarkFileCount()).toBe(1);
  });

  it('写盘往返：改完重载仍是同一份（归一键落盘）', async () => {
    const store = useLocalStorage(undefined);
    const first = await freshInstance();
    expect(first.toggleBookmark('C:\\notes\\a.erb', 7)).toBe(true);
    expect(first.toggleBookmark('C:\\notes\\a.erb', 3)).toBe(true);
    expect(JSON.parse(store.get(BOOKMARKS_STORAGE_KEY)!)).toEqual({ 'c:\\notes\\a.erb': [3, 7] });

    vi.resetModules();
    const again = await freshInstance();
    expect(again.bookmarkLinesOf('c:/notes/a.erb')).toEqual([3, 7]);
    expect(again.hasBookmark('C:\\notes\\a.erb', 7)).toBe(true);
  });

  it('盘上是坏 JSON ⇒ 回空表，不抛', async () => {
    const store = new Map<string, string>();
    store.set(BOOKMARKS_STORAGE_KEY, '{not json');
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    });
    const mod = await freshInstance();
    expect(mod.bookmarkFileCount()).toBe(0);
  });
});

describe('订阅广播', () => {
  it('变更即广播；退订后不再收到', () => {
    const listener = vi.fn();
    const off = subscribeBookmarks(listener);
    toggleBookmark('/a.erb', 1);
    expect(listener).toHaveBeenCalledTimes(1);
    clearFileBookmarks('/a.erb');
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    toggleBookmark('/a.erb', 2);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});