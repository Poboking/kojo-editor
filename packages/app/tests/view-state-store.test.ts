import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathKey } from '@kojo/plugin-api';
import {
  clampSlice,
  clearViewStates,
  extractViewSlice,
  foldRestoreState,
  flushViewStates,
  getViewState,
  MAX_ENTRIES,
  MAX_FOLDS_PER_FILE,
  MAX_TOTAL_FOLDS,
  renameViewStates,
  setViewState,
  viewStateKey,
  type SerializedFold,
  type ViewSlice,
} from '../src/ui/view-state-store';

/**
 * 视图状态持久层单测：round-trip、路径键归一化、损坏清洗、LRU 上限、钳制、防抖、折叠预算。
 * localStorage 在 node 环境不可用 ⇒ 照 layout.test.ts 的桩风格注入替身。
 */

const KEY = 'kojo.viewState.v1';
const ROOT = 'C:\\Projects\\era';
const FILE = 'C:\\Projects\\era\\data\\a.erb';

const sliceOf = (line: number, scrollTop = 100): ViewSlice => ({
  selections: [{ startLineNumber: line, startColumn: 2, endLineNumber: line, endColumn: 9 }],
  scrollTop,
  scrollLeft: 0,
  folds: [],
});

const foldOf = (start: number, end: number, extra: Partial<SerializedFold> = {}): SerializedFold => ({
  startLineNumber: start,
  endLineNumber: end,
  ...extra,
});

const selectionOf = (line: number): ViewSlice['selections'][number] => ({
  startLineNumber: line,
  startColumn: 2,
  endLineNumber: line,
  endColumn: 9,
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
      folds: [],
    });
  });

  it('无选区的 slice 一律不落盘（宁可丢这次，不存坏数据）', () => {
    installStorage(fakeStorage());
    setViewState(ROOT, FILE, { selections: [], scrollTop: 5, scrollLeft: 5 });
    flushViewStates();
    expect(getViewState(ROOT, FILE)).toBeNull();
  });
});

describe('折叠存取（folds）', () => {
  it('存取往返：折叠数组逐字相等（顺序 + type/isCollapsed/source/checksum）', () => {
    installStorage(fakeStorage());
    const folds: SerializedFold[] = [
      { startLineNumber: 3, endLineNumber: 12, type: 'region', isCollapsed: true, source: 0, checksum: 123456 },
      { startLineNumber: 20, endLineNumber: 31, isCollapsed: true, source: 2 },
    ];
    setViewState(ROOT, FILE, { ...sliceOf(5), folds });
    flushViewStates();
    installStorage(cloneCurrentStorage()); // 真·序列化往返
    expect(getViewState(ROOT, FILE)?.folds).toEqual(folds);
  });

  it('旧 v1 条目没有 folds ⇒ 读入补 []（不迁移、不炸、光标照旧）', () => {
    const s = fakeStorage();
    s.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        entries: {
          [viewStateKey(ROOT, 'C:\\Projects\\era\\legacy.erb')]: {
            selections: [selectionOf(6)],
            scrollTop: 1,
            scrollLeft: 2,
          },
        },
      }),
    );
    installStorage(s);
    expect(getViewState(ROOT, 'C:\\Projects\\era\\legacy.erb')).toEqual({
      selections: [selectionOf(6)],
      scrollTop: 1,
      scrollLeft: 2,
      folds: [],
    });
  });

  it('条目内 folds 损坏：只清折叠、不丢光标；坏条摘除、好条存活', () => {
    const s = fakeStorage();
    s.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        entries: {
          [viewStateKey(ROOT, 'C:\\Projects\\era\\badfolds.erb')]: {
            selections: [selectionOf(4)],
            scrollTop: 0,
            scrollLeft: 0,
            folds: { nope: 1 },
          },
          [viewStateKey(ROOT, 'C:\\Projects\\era\\mixedfolds.erb')]: {
            selections: [selectionOf(8)],
            scrollTop: 0,
            scrollLeft: 0,
            folds: [foldOf(1, 3), { startLineNumber: 5, endLineNumber: 5 }, null, foldOf(7, 9)],
          },
        },
      }),
    );
    installStorage(s);
    const bad = getViewState(ROOT, 'C:\\Projects\\era\\badfolds.erb');
    expect(bad?.folds).toEqual([]);
    expect(bad?.selections).toEqual([selectionOf(4)]);
    expect(getViewState(ROOT, 'C:\\Projects\\era\\mixedfolds.erb')?.folds).toEqual([foldOf(1, 3), foldOf(7, 9)]);
  });

  it('单文件预算：超过 MAX_FOLDS_PER_FILE 截断，保留靠前折叠', () => {
    installStorage(fakeStorage());
    const many = Array.from({ length: MAX_FOLDS_PER_FILE + 25 }, (_, i) => foldOf(i * 2 + 1, i * 2 + 2));
    setViewState(ROOT, FILE, { ...sliceOf(1), folds: many });
    const got = getViewState(ROOT, FILE)?.folds ?? [];
    expect(got.length).toBe(MAX_FOLDS_PER_FILE);
    expect(got[0]).toEqual(many[0]);
    expect(got[MAX_FOLDS_PER_FILE - 1]).toEqual(many[MAX_FOLDS_PER_FILE - 1]);
  });

  it('全库预算：超了从最久未用条目起清空 folds、光标保留；新条目折叠优先保', () => {
    installStorage(fakeStorage());
    const perFile = 30;
    const fileCount = Math.ceil(MAX_TOTAL_FOLDS / perFile) + 5; // 总折叠 > 预算
    const foldsOf = (): SerializedFold[] => Array.from({ length: perFile }, (_, j) => foldOf(j * 2 + 1, j * 2 + 2));
    for (let i = 0; i < fileCount; i++) setViewState(ROOT, `C:\\P\\fold${i}.erb`, { ...sliceOf(i + 1), folds: foldsOf() });
    flushViewStates();
    installStorage(cloneCurrentStorage()); // 超预算约束在落盘重载后也必须成立

    let total = 0;
    for (let i = 0; i < fileCount; i++) total += getViewState(ROOT, `C:\\P\\fold${i}.erb`)?.folds?.length ?? 0;
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_FOLDS);

    const oldest = getViewState(ROOT, 'C:\\P\\fold0.erb');
    expect(oldest?.folds).toEqual([]); // 最久未用：折叠让位
    expect(oldest?.selections).toEqual([selectionOf(1)]); // 光标绝不被折叠挤掉
    expect(getViewState(ROOT, `C:\\P\\fold${fileCount - 1}.erb`)?.folds?.length).toBe(perFile);
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

  it('折叠随文件变短钳制：越尾两行折不掉就丢；位移过则丢 checksum；不抛', () => {
    const slice: ViewSlice = {
      selections: [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }],
      scrollTop: 0,
      scrollLeft: 0,
      folds: [
        foldOf(5, 15, { type: 'region', isCollapsed: true, source: 0, checksum: 99 }), // 5-15 → 5-10（位移）
        foldOf(40, 50), // 起点越过文件尾 ⇒ 钳成 10-10 ⇒ 丢
        foldOf(20, 30), // 整段越过文件尾 ⇒ 丢
        foldOf(8, 9, { checksum: 7 }), // 几何未变 ⇒ checksum 原样保留
      ],
    };
    const out = clampSlice(slice, 10, () => 80);
    expect(out.folds).toEqual([
      { startLineNumber: 5, endLineNumber: 10, type: 'region', isCollapsed: true, source: 0 },
      { startLineNumber: 8, endLineNumber: 9, checksum: 7 },
    ]);
    expect(out.selections).toEqual(slice.selections); // 折叠钳制不影响光标钳制
  });

  it('文件只有 1 行：所有折叠丢弃且不抛', () => {
    const out = clampSlice({ ...sliceOf(1), folds: [foldOf(1, 2), foldOf(3, 9)] }, 1, () => 1);
    expect(out.folds).toEqual([]);
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
      folds: [],
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
      folds: [],
    });
  });

  it('Monaco 0.57 现形：折叠在 contributionsState[editor.contrib.folding].collapsedRegions', () => {
    const monacoLike = {
      cursorState: [{ modelState: { position: { lineNumber: 7, column: 2 } } }],
      contributionsState: {
        'editor.contrib.folding': {
          collapsedRegions: [
            { startLineNumber: 2, endLineNumber: 9, isCollapsed: true, source: 0, checksum: 42 },
            { startLineNumber: 2, endLineNumber: 9 }, // 同区间去重
            { startLineNumber: 10, endLineNumber: 10 }, // 单行：不是折叠
            { startLineNumber: 12, endLineNumber: 8 }, // 倒序
            { startLineNumber: 'x', endLineNumber: 5 }, // 坏行号
            { startLineNumber: 20, endLineNumber: 30, checksum: -1, isCollapsed: 'yes', type: 42, junk: 'drop' }, // 坏字段丢字段、不丢条目
          ],
          lineCount: 100,
        },
        'editor.contrib.other': { whatever: true },
      },
      viewState: {},
    };
    expect(extractViewSlice(monacoLike, 10, 20)?.folds).toEqual([
      { startLineNumber: 2, endLineNumber: 9, isCollapsed: true, source: 0, checksum: 42 },
      { startLineNumber: 20, endLineNumber: 30 },
    ]);
  });

  it('兼容 viewState.folds 直挂形与旧版贡献直返数组形；缺失/非数组 ⇒ []', () => {
    const cursorState = [{ modelState: { position: { lineNumber: 1, column: 1 } } }];
    expect(extractViewSlice({ cursorState, folds: [foldOf(1, 4)] }, 0, 0)?.folds).toEqual([foldOf(1, 4)]);
    expect(
      extractViewSlice({ cursorState, contributionsState: { 'editor.contrib.folding': [foldOf(3, 8)] } }, 0, 0)?.folds,
    ).toEqual([foldOf(3, 8)]);
    expect(extractViewSlice({ cursorState }, 0, 0)?.folds).toEqual([]);
    expect(extractViewSlice({ cursorState, folds: 'nope' }, 0, 0)?.folds).toEqual([]);
  });

  it('折叠数量在抽取阶段就按文件预算截断', () => {
    const cursorState = [{ modelState: { position: { lineNumber: 1, column: 1 } } }];
    const folds = Array.from({ length: MAX_FOLDS_PER_FILE + 10 }, (_, i) => foldOf(i * 2 + 1, i * 2 + 2));
    expect(extractViewSlice({ cursorState, folds }, 0, 0)?.folds?.length).toBe(MAX_FOLDS_PER_FILE);
  });
});

describe('foldRestoreState（喂回 folding contribution）', () => {
  it('空/缺省 ⇒ null；非空 ⇒ { collapsedRegions } 深拷贝', () => {
    expect(foldRestoreState(undefined)).toBeNull();
    expect(foldRestoreState([])).toBeNull();
    const folds = [foldOf(1, 5, { isCollapsed: true, source: 0, checksum: 10 })];
    const state = foldRestoreState(folds);
    expect(state).toEqual({ collapsedRegions: folds });
    expect(state?.collapsedRegions).not.toBe(folds); // 不复用内部引用
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

/**
 * 改名迁移（WS-02）：目录改名后，其下文件的光标 / 折叠 / 查找状态不许丢，
 * 也不许继续挂在旧键上（下次打开新路径时恢复的是"没打开过"，等于白丢一次视图）。
 */
describe('renameViewStates（改名迁移）', () => {
  const ROOT_P = 'C:\\P';
  const DIR_RENAME = [{ from: 'C:\\P\\old', to: 'C:\\P\\new' }];

  it('目录下多层子路径迁到新键，slice 原样保留，旧键消失（结果已落盘）', () => {
    installStorage(fakeStorage());
    const a = 'C:\\P\\old\\a.ERB';
    const b = 'C:\\P\\old\\pkg\\deep\\b.ERB';
    setViewState(ROOT_P, a, sliceOf(11, 500));
    setViewState(ROOT_P, b, sliceOf(22, 600));
    flushViewStates();

    expect(renameViewStates(ROOT_P, DIR_RENAME)).toBe(true);
    expect(getViewState(ROOT_P, a)).toBeNull();
    expect(getViewState(ROOT_P, b)).toBeNull();
    expect(getViewState(ROOT_P, 'C:\\P\\new\\a.ERB')).toEqual(sliceOf(11, 500));
    expect(getViewState(ROOT_P, 'C:\\P\\new\\pkg\\deep\\b.ERB')).toEqual(sliceOf(22, 600));

    // 落盘一次：换一份 storage 替身从序列化数据重载，迁移结果仍在
    installStorage(cloneCurrentStorage());
    expect(getViewState(ROOT_P, 'C:\\P\\new\\a.ERB')).toEqual(sliceOf(11, 500));
    expect(getViewState(ROOT_P, 'C:\\P\\new\\pkg\\deep\\b.ERB')).toEqual(sliceOf(22, 600));
  });

  it('别的项目的条目原样不动；未命中返回 false 且不重写盘', () => {
    installStorage(fakeStorage());
    setViewState(ROOT_P, 'C:\\P\\keep.ERB', sliceOf(1));
    setViewState('C:\\Other', 'C:\\Other\\old\\y.ERB', sliceOf(2));
    flushViewStates();
    const before = globalThis.localStorage.getItem(KEY);

    expect(renameViewStates(ROOT_P, [{ from: 'C:\\P\\nope', to: 'C:\\P\\nope2' }])).toBe(false);
    expect(globalThis.localStorage.getItem(KEY)).toBe(before);
    expect(getViewState(ROOT_P, 'C:\\P\\keep.ERB')).toEqual(sliceOf(1));
    // 别项目里同名旧路径不被本项目改名波及
    expect(getViewState('C:\\Other', 'C:\\Other\\old\\y.ERB')).toEqual(sliceOf(2));
  });

  it('LRU 次序按原条目重建（改名不把条目顶到"最近使用"端）', () => {
    installStorage(fakeStorage());
    setViewState(ROOT_P, 'C:\\P\\old\\a.ERB', sliceOf(1));
    setViewState(ROOT_P, 'C:\\P\\b.ERB', sliceOf(2));
    setViewState(ROOT_P, 'C:\\P\\old\\c.ERB', sliceOf(3));
    flushViewStates();

    expect(renameViewStates(ROOT_P, DIR_RENAME)).toBe(true);
    flushViewStates();
    const parsed = JSON.parse(globalThis.localStorage.getItem(KEY) ?? '{}') as {
      entries?: Record<string, unknown>;
    };
    const files = Object.keys(parsed.entries ?? {}).map((k) => k.split('\u0000')[1]);
    expect(files).toEqual([pathKey('C:\\P\\new\\a.ERB'), pathKey('C:\\P\\b.ERB'), pathKey('C:\\P\\new\\c.ERB')]);
  });

  it('新键上已有旧条目：让位给改名后的那份（同键只留一条，位置取原名那条）', () => {
    installStorage(fakeStorage());
    setViewState(ROOT_P, 'C:\\P\\old\\a.ERB', sliceOf(1));
    setViewState(ROOT_P, 'C:\\P\\new\\a.ERB', sliceOf(9));
    flushViewStates();

    expect(renameViewStates(ROOT_P, DIR_RENAME)).toBe(true);
    flushViewStates();
    installStorage(cloneCurrentStorage());
    expect(getViewState(ROOT_P, 'C:\\P\\new\\a.ERB')).toEqual(sliceOf(1));
    expect(getViewState(ROOT_P, 'C:\\P\\old\\a.ERB')).toBeNull();
  });
});
