import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clampSlice,
  clearViewStates,
  extractViewSlice,
  flushViewStates,
  getViewState,
  MAX_ENTRIES,
  setViewState,
  viewStateKey,
  type ViewSlice,
} from '../src/ui/view-state-store';

/**
 * 视图状态持久层单测：round-trip、路径键归一化、损坏清洗、LRU 上限、钳制、防抖。
 * localStorage 在 node 环境不可用 ⇒ 照 layout.test.ts 的桩风格注入替身。
 */

const KEY = 'kojo.viewState.v1';
const ROOT = 'C:\\Projects\\era';
const FILE = 'C:\\Projects\\era\\data\\a.erb';

const sliceOf = (line: number, scrollTop = 100): ViewSlice => ({
  selections: [{ startLineNumber: line, startColumn: 2, endLineNumber: line, endColumn: 9 }],
  scrollTop,
  scrollLeft: 0,
});

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

function installStorage(s: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', { value: s, configurable: true, writable: true });
}

/** 把当前 storage 原样复制到一份新替身（模拟"重启进程，从序列化数据重新读"） */
function cloneCurrentStorage(): Storage {
  const c = fakeStorage();
  const cur = globalThis.localStorage;
  for (let i = 0; i < cur.length; i++) {
    const k = cur.key(i);
    if (k !== null) c.setItem(k, cur.getItem(k) ?? '');
  }
  return c;
}

afterEach(() => {
  vi.useRealTimers();
  flushViewStates(); // 取消在途防抖，避免跨测试写入
  installStorage(fakeStorage());
});

describe('round-trip', () => {
  it('set → flush → 重新装载后按原值读回', () => {
    installStorage(fakeStorage());
    const s = sliceOf(42, 1234.5);
    setViewState(ROOT, FILE, s);
    flushViewStates();
    expect(globalThis.localStorage.getItem(KEY)).not.toBeNull();
    installStorage(cloneCurrentStorage()); // 新引用 ⇒ 模块必须从序列化数据重载
    expect(getViewState(ROOT, FILE)).toEqual(s);
  });

  it('未 flush 前不落盘；防抖窗口到点自动落盘', () => {
    vi.useFakeTimers();
    installStorage(fakeStorage());
    setViewState(ROOT, FILE, sliceOf(1));
    expect(globalThis.localStorage.getItem(KEY)).toBeNull();
    vi.advanceTimersByTime(600);
    expect(globalThis.localStorage.getItem(KEY)).not.toBeNull();
  });

  it('scrollTop/Left 负数与非数值在写入时清洗为 0', () => {
    installStorage(fakeStorage());
    setViewState(ROOT, FILE, {
      selections: [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }],
      scrollTop: -8,
      scrollLeft: Number.NaN,
    });
    flushViewStates();
    installStorage(cloneCurrentStorage());
    expect(getViewState(ROOT, FILE)).toEqual({
      selections: [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }],
      scrollTop: 0,
      scrollLeft: 0,
    });
  });

  it('无选区的 slice 一律不落盘（宁可丢这次，不存坏数据）', () => {
    installStorage(fakeStorage());
    setViewState(ROOT, FILE, { selections: [], scrollTop: 5, scrollLeft: 5 });
    flushViewStates();
    expect(getViewState(ROOT, FILE)).toBeNull();
  });
});

describe('路径键归一化', () => {
  it('Windows 大小写与分隔符折叠：不同写法命中同一条目', () => {
    installStorage(fakeStorage());
    setViewState('C:\\Game\\Dir', 'C:\\Game\\Dir\\Sub\\A.ERB', sliceOf(7));
    expect(getViewState('c:/game/dir', 'C:/GAME/dir/sub/a.erb')?.selections[0]?.startLineNumber).toBe(7);
  });

  it('不同根目录互不串键（同相对路径不同项目是两条）', () => {
    installStorage(fakeStorage());
    setViewState('C:\\A', 'C:\\A\\x.erb', sliceOf(3));
    setViewState('C:\\B', 'C:\\B\\x.erb', sliceOf(8));
    expect(getViewState('C:\\A', 'C:\\A\\x.erb')?.selections[0]?.startLineNumber).toBe(3);
    expect(getViewState('C:\\B', 'C:\\B\\x.erb')?.selections[0]?.startLineNumber).toBe(8);
  });
});

describe('损坏数据清洗', () => {
  it('整库 JSON 损坏：静默清空回退，flush 后以干净数据覆写', () => {
    const s = fakeStorage();
    s.setItem(KEY, '{ 这不是 JSON');
    installStorage(s);
    expect(getViewState(ROOT, FILE)).toBeNull();
    flushViewStates();
    expect(JSON.parse(globalThis.localStorage.getItem(KEY) ?? '{}').entries).toEqual({});
  });

  it('schema 版本不符 ⇒ 整库视空（不迁移、不抛）', () => {
    const s = fakeStorage();
    s.setItem(KEY, JSON.stringify({ v: 99, entries: { [viewStateKey(ROOT, FILE)]: sliceOf(1) } }));
    installStorage(s);
    expect(getViewState(ROOT, FILE)).toBeNull();
  });

  it('条目级损坏：坏条目摘除、好条目存活', () => {
    const s = fakeStorage();
    s.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        entries: {
          [viewStateKey(ROOT, 'C:\\Projects\\era\\good.erb')]: sliceOf(5),
          [viewStateKey(ROOT, 'C:\\Projects\\era\\noselections.erb')]: { scrollTop: 1, scrollLeft: 0 },
          [viewStateKey(ROOT, 'C:\\Projects\\era\\badline.erb')]: {
            selections: [{ startLineNumber: 0, startColumn: 1, endLineNumber: 1, endColumn: 1 }],
            scrollTop: 1,
            scrollLeft: 0,
          },
        },
      }),
    );
    installStorage(s);
    expect(getViewState(ROOT, 'C:\\Projects\\era\\good.erb')?.selections[0]?.startLineNumber).toBe(5);
    expect(getViewState(ROOT, 'C:\\Projects\\era\\noselections.erb')).toBeNull();
    expect(getViewState(ROOT, 'C:\\Projects\\era\\badline.erb')).toBeNull();
  });
});

describe('LRU 上限', () => {
  it('超限淘汰最久未用者；读写 touch 过的条目免于淘汰', () => {
    installStorage(fakeStorage());
    for (let i = 1; i <= MAX_ENTRIES; i++) setViewState(ROOT, `C:\\P\\f${i}.erb`, sliceOf(i));
    expect(getViewState(ROOT, 'C:\\P\\f1.erb')).not.toBeNull(); // touch f1 ⇒ 刷到最近端
    setViewState(ROOT, 'C:\\P\\new.erb', sliceOf(9));
    expect(getViewState(ROOT, 'C:\\P\\f1.erb')).not.toBeNull(); // 被 touch 过：不该是淘汰对象
    expect(getViewState(ROOT, 'C:\\P\\f2.erb')).toBeNull(); // f2 才是最久未用
    expect(getViewState(ROOT, 'C:\\P\\f3.erb')).not.toBeNull();
    expect(getViewState(ROOT, 'C:\\P\\new.erb')).not.toBeNull();
  });

  it('落盘重载后仍受上限约束（超限手工数据自愈）', () => {
    const s = fakeStorage();
    const entries: Record<string, ViewSlice> = {};
    for (let i = 1; i <= MAX_ENTRIES + 10; i++) entries[viewStateKey(ROOT, `C:\\P\\f${i}.erb`)] = sliceOf(i);
    s.setItem(KEY, JSON.stringify({ v: 1, entries }));
    installStorage(s);
    flushViewStates();
    const written = JSON.parse(globalThis.localStorage.getItem(KEY) ?? '{"entries":{}}').entries as Record<
      string,
      ViewSlice
    >;
    expect(Object.keys(written).length).toBe(MAX_ENTRIES);
  });
});

describe('越界钳制（clampSlice）', () => {
  it('行号钳进 [1, lineCount]，列号钳进该行 maxColumn', () => {
    const slice: ViewSlice = {
      selections: [{ startLineNumber: 50, startColumn: 30, endLineNumber: 60, endColumn: 1 }],
      scrollTop: 99999,
      scrollLeft: 0,
    };
    // 文件只剩 20 行；每行最大列 = 行号 × 2
    const out = clampSlice(slice, 20, (l) => l * 2);
    expect(out.selections[0]).toEqual({ startLineNumber: 20, startColumn: 30, endLineNumber: 20, endColumn: 1 });
    expect(out.scrollTop).toBe(99999); // 滚动值不在这钳：monaco 自行钳，不许抛即够
  });

  it('行数为 0/坏值时按 1 行处理；越下界的行列抬回下界', () => {
    const slice: ViewSlice = {
      selections: [{ startLineNumber: 0, startColumn: -5, endLineNumber: -3, endColumn: 7 }],
      scrollTop: 0,
      scrollLeft: 0,
    };
    const out = clampSlice(slice, 0, () => 4);
    expect(out.selections[0]).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 });
  });
});

describe('extractViewSlice（Monaco 视图状态 → 子集）', () => {
  it('现行形态 { cursorState: [{ modelState: { selection } }] } 正常抽取', () => {
    const monacoLike = {
      cursorState: [
        {
          modelState: {
            selectionStart: { startLineNumber: 7, startColumn: 15, endLineNumber: 7, endColumn: 15 },
            position: { lineNumber: 7, column: 2 },
            selection: { startLineNumber: 7, startColumn: 2, endLineNumber: 7, endColumn: 15 },
          },
          viewState: null,
        },
      ],
      viewState: { scrollLeft: 0, firstPosition: { lineNumber: 5, column: 1 }, firstPositionDeltaTop: 3 },
      contributionsState: {},
    };
    expect(extractViewSlice(monacoLike, 1234, 56)).toEqual({
      selections: [{ startLineNumber: 7, startColumn: 2, endLineNumber: 7, endColumn: 15 }],
      scrollTop: 1234,
      scrollLeft: 56,
    });
  });

  it('仅有 position 时合成坍缩选区；兼容裸 { selection } 形态', () => {
    const byPos = extractViewSlice({ cursorState: [{ modelState: { position: { lineNumber: 3, column: 4 } } }] }, 0, 0);
    expect(byPos?.selections).toEqual([{ startLineNumber: 3, startColumn: 4, endLineNumber: 3, endColumn: 4 }]);
    const legacy = extractViewSlice({ cursorState: [{ selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 } }] }, 10, 20);
    expect(legacy?.selections[0]?.endLineNumber).toBe(2);
  });

  it('取不到合法选区 ⇒ null（不存坏数据）', () => {
    expect(extractViewSlice(null, 0, 0)).toBeNull();
    expect(extractViewSlice({}, 0, 0)).toBeNull();
    expect(extractViewSlice({ cursorState: [] }, 0, 0)).toBeNull();
    expect(extractViewSlice({ cursorState: [{ modelState: { position: { lineNumber: 'x', column: 1 } } }] }, 0, 0)).toBeNull();
  });

  it('滚动读数负值/非数值清洗为 0', () => {
    const out = extractViewSlice(
      { cursorState: [{ selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } }] },
      -40,
      Number.NaN,
    );
    expect(out).toEqual({
      selections: [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }],
      scrollTop: 0,
      scrollLeft: 0,
    });
  });
});

describe('clearViewStates', () => {
  it('传 root 只清该项目；不传清整库', () => {
    installStorage(fakeStorage());
    setViewState('C:\\A', 'C:\\A\\x.erb', sliceOf(1));
    setViewState('C:\\B', 'C:\\B\\y.erb', sliceOf(2));
    clearViewStates('c:/a');
    expect(getViewState('C:\\A', 'C:\\A\\x.erb')).toBeNull();
    expect(getViewState('C:\\B', 'C:\\B\\y.erb')).not.toBeNull();
    clearViewStates();
    expect(getViewState('C:\\B', 'C:\\B\\y.erb')).toBeNull();
  });
});
