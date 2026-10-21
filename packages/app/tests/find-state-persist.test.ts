import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampSlice,
  clearViewStates,
  flushViewStates,
  getViewState,
  sanitizeFind,
  setViewState,
  viewStateKey,
  withFind,
  type SerializedFind,
  type ViewSlice,
} from '../src/ui/view-state-store';
import {
  FIND_CONTROLLER_ID,
  findControllerOf,
  readFindState,
  subscribeFindState,
  writeFindState,
} from '../src/monaco/find-state-sync';
import type * as Monaco from '../src/monaco/entry';

/**
 * FIND-STATE-PERSIST A（持久半边）：查找词与三开关按文件往返，字段挂在这份 store 上
 * （**additive，照 folds 先例不 bump 版本、不改键**——不新造第三套持久化）。
 */

const KEY = 'kojo.viewState.v1';
const ROOT = 'C:\\Projects\\era';
const FILE = 'C:\\Projects\\era\\data\\a.erb';

const sliceOf = (line = 3): ViewSlice => ({
  selections: [{ startLineNumber: line, startColumn: 2, endLineNumber: line, endColumn: 9 }],
  scrollTop: 120,
  scrollLeft: 0,
  folds: [],
});

const FIND: SerializedFind = {
  searchString: '$chara[3].koujo',
  replaceString: '半角',
  isRegex: true,
  wholeWord: false,
  matchCase: true,
};

/** localStorage 替身（node 环境没有；换引用 ⇒ store 的 cache 自动重读） */
function installStorage(initial: Record<string, string> = {}): Map<string, string> {
  const m = new Map<string, string>(Object.entries(initial));
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    },
    configurable: true,
    writable: true,
  });
  return m;
}

describe('find 字段的清洗（全有或全无，与 folds 一样不许半条入库）', () => {
  it('五字段齐全 ⇒ 原样；缺开关 / 类型不对 ⇒ null（整个字段丢，条目留下）', () => {
    expect(sanitizeFind(FIND)).toEqual(FIND);
    expect(sanitizeFind({ ...FIND, wholeWord: undefined })).toBeNull();
    expect(sanitizeFind({ ...FIND, isRegex: 'yes' })).toBeNull();
    expect(sanitizeFind({ searchString: '只有词' })).toBeNull();
    expect(sanitizeFind(null)).toBeNull();
  });

  it('空串合法（作者清空过查找框）；不 trim（带空格的正则串是作者本意）；超长视作损坏', () => {
    expect(sanitizeFind({ ...FIND, searchString: '', replaceString: '' })).toEqual({ ...FIND, searchString: '', replaceString: '' });
    expect(sanitizeFind({ ...FIND, searchString: '  带空格  ' })!.searchString).toBe('  带空格  ');
    expect(sanitizeFind({ ...FIND, searchString: 'x'.repeat(513) })).toBeNull();
  });

  it('withFind：合法就挂上，非法/缺字段原样返回（绝不写 find: undefined 进去）', () => {
    const base = sliceOf();
    expect(withFind(base, FIND).find).toEqual(FIND);
    const untouched = withFind(base, null);
    expect(untouched.find).toBeUndefined();
    expect('find' in untouched).toBe(false);
  });
});

describe('③ 持久化往返：写回后再读，词与三开关逐字同', () => {
  beforeEach(() => {
    installStorage();
    clearViewStates();
  });

  it('同一 store 实例内往返（LRU 命中）', () => {
    setViewState(ROOT, FILE, withFind(sliceOf(), FIND));
    flushViewStates();
    expect(getViewState(ROOT, FILE)!.find).toEqual(FIND);
  });

  it('落盘后换一份 localStorage 引用再读 ⇒ 逐字同（重启等价路径）', () => {
    setViewState(ROOT, FILE, withFind(sliceOf(7), FIND));
    flushViewStates();
    const persistedRaw = globalThis.localStorage.getItem(KEY)!;
    installStorage(); // 换引用（并且这次是空的）⇒ store 的 cache 必须失效重读
    const raw = JSON.parse(persistedRaw);
    expect(raw.v).toBe(1); // **没有 bump 版本**（additive 纪律）
    expect(raw.entries[viewStateKey(ROOT, FILE)].find).toEqual(FIND);
    installStorage({ [KEY]: persistedRaw });
    expect(getViewState(ROOT, FILE)!.find).toEqual(FIND);
    expect(getViewState(ROOT, FILE)!.selections[0]!.startLineNumber).toBe(7);
  });

  it('两枚文件各存各的词（切标签不共用一词）；钳制只动行列、find 原样透传', () => {
    const other = 'C:\\Projects\\era\\data\\b.erb';
    setViewState(ROOT, FILE, withFind(sliceOf(), FIND));
    setViewState(ROOT, other, withFind(sliceOf(), { ...FIND, searchString: '另一个词', isRegex: false }));
    flushViewStates();
    expect(getViewState(ROOT, FILE)!.find!.searchString).toBe(FIND.searchString);
    expect(getViewState(ROOT, other)!.find!.searchString).toBe('另一个词');
    const clamped = clampSlice(getViewState(ROOT, FILE)!, 2, () => 5);
    expect(clamped.find).toEqual(FIND);
    expect(clamped.selections[0]!.startLineNumber).toBe(2);
  });

  it('旧条目（没有 find 字段）读入不炸、也读不到 find ⇒ 恢复整拍跳过（不拿空串覆盖）', () => {
    const legacy = {
      v: 1,
      entries: { [viewStateKey(ROOT, FILE)]: { selections: sliceOf().selections, scrollTop: 5, scrollLeft: 0 } },
    };
    installStorage({ [KEY]: JSON.stringify(legacy) });
    const got = getViewState(ROOT, FILE);
    expect(got).not.toBeNull();
    expect(got!.find).toBeUndefined();
    expect(got!.folds).toEqual([]);
  });

  it('find 字段损坏只丢 find，selections 仍有效（与 folds 同一条降级纪律）', () => {
    installStorage();
    setViewState(ROOT, FILE, withFind(sliceOf(), FIND));
    flushViewStates();
    const raw = JSON.parse(installStorage().get(KEY) ?? '{}');
    void raw;
    const broken = {
      v: 1,
      entries: {
        [viewStateKey(ROOT, FILE)]: { ...sliceOf(), find: { searchString: '坏', isRegex: '不是布尔' } },
      },
    };
    installStorage({ [KEY]: JSON.stringify(broken) });
    const got = getViewState(ROOT, FILE);
    expect(got!.selections[0]!.startLineNumber).toBe(3);
    expect(got!.find).toBeUndefined();
  });
});

describe('宿主包装层：find-state-sync（补丁未生效必须显式退化，不许假装成功）', () => {
  /**
   * 事件形状：补丁的 `IFindStateChangeEvents` 不含 `searchScope`（补丁 d.ts 是冻结件，不改），
   * 但 monaco 内部换 model 时真会发 `{ searchScope: true }`——替身按**运行时的真实形状**打。
   */
  type FindChange = Monaco.editor.IFindStateChangeEvents & { searchScope?: boolean };
  /** 打过补丁的控制器替身：只需 getContribution 回三枚方法齐的对象 */
  const patchedEditor = (state: SerializedFind) => {
    const listeners = new Set<(e: FindChange) => void>();
    const controller = {
      setFindStateSilently: vi.fn((s: SerializedFind) => {
        Object.assign(state, s);
        listeners.forEach((l) => l({ matchCase: true }));
      }),
      getFindStateSilently: () => ({ ...state }),
      onDidChangeFindState: (l: (e: FindChange) => void) => {
        listeners.add(l);
        return { dispose: () => listeners.delete(l) };
      },
    };
    const ed = {
      getContribution: (id: string) => (id === FIND_CONTROLLER_ID ? controller : null),
    } as unknown as Monaco.editor.IStandaloneCodeEditor;
    /** 模拟 monaco 内部一次状态变更（换 model 的 searchScope 事件也走这条路） */
    const fire = (e: FindChange): void => listeners.forEach((l) => l(e));
    return { ed, controller, state, fire };
  };

  it('读写走类型化入口：写进去的值就是控制器里的值，读回来的逐字同', () => {
    const { ed, controller, state } = patchedEditor({ ...FIND });
    expect(writeFindState(ed, { ...FIND, searchString: '换成这个' })).toBe(true);
    expect(controller.setFindStateSilently).toHaveBeenCalledWith({
      searchString: '换成这个',
      replaceString: FIND.replaceString,
      isRegex: FIND.isRegex,
      wholeWord: FIND.wholeWord,
      matchCase: FIND.matchCase,
    });
    expect(state.searchString).toBe('换成这个');
    expect(readFindState(ed)).toEqual(state);
  });

  it('订阅：状态一变就回调（宿主拿它写存）', () => {
    const { ed } = patchedEditor({ ...FIND });
    const cb = vi.fn();
    const sub = subscribeFindState(ed, cb);
    expect(sub).not.toBeNull();
    writeFindState(ed, { ...FIND, matchCase: false });
    expect(cb).toHaveBeenCalledTimes(1);
    sub!.dispose();
    writeFindState(ed, { ...FIND, matchCase: true });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('换 model 打出的 searchScope 事件一律不回调（那不是作者改词：写存会把上一个文件的词串进新文件）', () => {
    const { ed, fire } = patchedEditor({ ...FIND });
    const cb = vi.fn();
    const sub = subscribeFindState(ed, cb);
    expect(sub).not.toBeNull();
    fire({ searchScope: true });
    expect(cb).toHaveBeenCalledTimes(0);
    fire({ matchCase: true });
    expect(cb).toHaveBeenCalledTimes(1);
    sub!.dispose();
    fire({ matchCase: false });
    expect(cb).toHaveBeenCalledTimes(1); // 退订后不再回调
  });

  it('补丁没打上（贡献缺方法 / 贡献取不到）⇒ 三枚入口一律返回 null/false，绝不抛', () => {
    const halfPatched = {
      getContribution: () => ({ getFindStateSilently: () => ({}) }), // 只有读、没有写
    } as unknown as Monaco.editor.IStandaloneCodeEditor;
    expect(findControllerOf(halfPatched)).toBeNull();
    expect(readFindState(halfPatched)).toBeNull();
    expect(writeFindState(halfPatched, FIND)).toBe(false);
    expect(subscribeFindState(halfPatched, () => {})).toBeNull();

    const noContribution = { getContribution: () => null } as unknown as Monaco.editor.IStandaloneCodeEditor;
    expect(findControllerOf(noContribution)).toBeNull();
    expect(writeFindState(noContribution, FIND)).toBe(false);
  });
});

/* ---------------- 宿主接线（源码级：本仓 React 组件无法在此环境渲染） ---------------- */

const SOURCE = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'ui', 'EditorPane.tsx'), 'utf8');

/** 截 `start` 到其后第一次出现的 `end`（找不到即测试失败，绝不静默给空串） */
function sliceBetween(start: string, end: string, source = SOURCE): string {
  const from = source.indexOf(start);
  expect(from, `找不到起点：${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `找不到终点：${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('换文件这一拍不许写存（setModel 同步打出的 find 事件会把上一个文件的词/1:1 空视图盖进新文件）', () => {
  it('switchingModelRef 在 setModel 之前置 true、find 读回之后 finally 复位；snapshotActiveView 里有该 ref 的早退', () => {
    const armAt = SOURCE.indexOf('switchingModelRef.current = true;');
    const setModelAt = SOURCE.indexOf('ed.setModel(entry.model);');
    expect(armAt, '找不到 switchingModelRef.current = true（换 model 的写存闸没了）').toBeGreaterThanOrEqual(0);
    expect(setModelAt, '找不到 ed.setModel(entry.model)').toBeGreaterThanOrEqual(0);
    expect(
      armAt,
      'switchingModelRef.current = true 必须早于 ed.setModel(entry.model)：setModel 会同步触发 find 的 searchScope 事件',
    ).toBeLessThan(setModelAt);

    const writeAt = SOURCE.indexOf('writeFindState(ed, persistedFind)');
    expect(writeAt, '找不到 find 读回写回点 writeFindState(ed, persistedFind)').toBeGreaterThanOrEqual(0);
    const tail = SOURCE.slice(writeAt);
    const finallyAt = tail.indexOf('finally');
    const resetAt = tail.indexOf('switchingModelRef.current = false;');
    expect(finallyAt, 'writeFindState(ed, persistedFind) 之后必须有 finally 复位写存闸').toBeGreaterThanOrEqual(0);
    expect(resetAt, 'finally 里必须把 switchingModelRef.current 复位为 false（否则之后永远不写存）').toBeGreaterThan(
      finallyAt,
    );

    const snapshot = sliceBetween('const snapshotActiveView = (): void => {', 'const applyPersistedView');
    expect(snapshot, 'snapshotActiveView 缺 switchingModelRef 早退：换 model 那一拍仍会写存').toContain(
      'if (switchingModelRef.current) return;',
    );
  });
});
