import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearViewStates,
  flushViewStates,
  getViewState,
  setViewState,
  withFind,
  type SerializedFind,
  type ViewSlice,
} from '../src/ui/view-state-store';
import {
  FIND_CONTROLLER_ID,
  isPristineFind,
  readFindState,
  subscribeFindState,
  writeFindState,
} from '../src/monaco/find-state-sync';
import type * as Monaco from '../src/monaco/entry';

/**
 * FIND-STATE-PERSIST 覆盖修复（真壳读数：停机前记 PERSIST2ND，重启后**一开项目同一个 key 就全空**）。
 * 两道闸、各一条"回退即红"：
 * - ① 无可写闸（本会话没动过查找 且 当前值全默认空 ⇒ 这一拍不落 find；setViewState 入参
 *   不带 find 时保留既有条目的 find）——下面行为用例直接调真 store / 真 sync，回退任一半都红；
 * - ② 恢复次序（读拍在 setModel 之前、写拍在之后且恢复自身触发一次写存）——②全在
 *   EditorPane 组件拍里，钉法沿用 `monaco-find-patch.test.ts` 的源码级钉子，回退次序即红。
 */

const KEY = 'kojo.viewState.v1';
const ROOT = 'C:\\Projects\\era';
const FILE = 'C:\\Projects\\era\\data\\a.erb';

const PRISTINE: SerializedFind = {
  searchString: '',
  replaceString: '',
  isRegex: false,
  wholeWord: false,
  matchCase: false,
};
const PERSISTED: SerializedFind = {
  searchString: 'PERSIST2ND',
  replaceString: '',
  isRegex: true,
  wholeWord: true,
  matchCase: true,
};

const sliceOf = (line = 3): ViewSlice => ({
  selections: [{ startLineNumber: line, startColumn: 2, endLineNumber: line, endColumn: 9 }],
  scrollTop: 120,
  scrollLeft: 0,
  folds: [],
});

/** localStorage 替身（换引用 ⇒ store cache 自动重读；同 find-state-persist.test.ts 口径） */
function installStorage(initial: Record<string, string> = {}): void {
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
}

/** 打过补丁的控制器替身：getFindStateSilently 对没碰过的 widget 也回结构完整的值（真补丁口径） */
type FindChange = Monaco.editor.IFindStateChangeEvents & { searchScope?: boolean };

function patchedEditor(initial: SerializedFind) {
  const listeners = new Set<(e: FindChange) => void>();
  const state = { ...initial };
  const controller = {
    setFindStateSilently: vi.fn((s: SerializedFind) => {
      const before = { ...state };
      Object.assign(state, s);
      // monaco 的 `findState.change()` 只在**值真变**时才发事件，且事件按变更字段打标记；
      // 换 model 那一头发的是 `{ searchScope: true }`（不是作者动作，由下面的 fire 单独模拟）。
      const ev: FindChange = {};
      for (const key of ['searchString', 'replaceString', 'isRegex', 'wholeWord', 'matchCase'] as const) {
        if (before[key] !== state[key]) (ev as Record<string, unknown>)[key] = true;
      }
      if (Object.keys(ev).length > 0) listeners.forEach((l) => l(ev));
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
  /** 模拟 monaco 内部打一发事件（换 model 的 searchScope 那发走这条路） */
  const fire = (e: FindChange): void => void listeners.forEach((l) => l(e));
  return { ed, state, fire };
}

describe('① 读侧无可写闸：全默认空 且 本会话没动过查找 ⇒ 这一拍无可写', () => {
  it('从未登记 + 全默认空 ⇒ readFindState 返回 null（旧口径返回结构完整的空记录，正是覆盖源）', () => {
    const { ed } = patchedEditor({ ...PRISTINE });
    expect(isPristineFind(PRISTINE)).toBe(true);
    expect(readFindState(ed)).toBeNull();
  });

  it('从未登记 + 非默认值（如开关被 workspace 存储带回 true）⇒ 照原样返回，不误伤真记录', () => {
    const { ed } = patchedEditor({ ...PRISTINE, matchCase: true });
    expect(readFindState(ed)).toEqual({ ...PRISTINE, matchCase: true });
  });

  it('动过之后（订阅事件）⇒ 清空回落全空也是合法记录，照常返回（不许把"作者清空查找框"判成无可写）', () => {
    const { ed } = patchedEditor({ ...PRISTINE });
    const sub = subscribeFindState(ed, () => {});
    expect(sub).not.toBeNull();
    writeFindState(ed, { ...PRISTINE, searchString: '拨过一次' });
    expect(readFindState(ed)!.searchString).toBe('拨过一次');
    writeFindState(ed, { ...PRISTINE }); // 清回全默认空：已登记 ⇒ 这次空串是真意图
    expect(readFindState(ed)).toEqual(PRISTINE);
  });

  it('writeFindState 成功即登记（不依赖事件是否真发）：放回值之后的快照拍必须可写', () => {
    const { ed } = patchedEditor({ ...PRISTINE });
    writeFindState(ed, { ...PRISTINE }); // 同值写：monaco 真实现不发变更事件，登记不能只靠事件回环
    expect(readFindState(ed)).toEqual(PRISTINE);
  });

  it('换 model 的 searchScope 事件整条丢掉：既不回调宿主，也**不许替作者登记**（两闸合流处）', () => {
    const { ed, fire } = patchedEditor({ ...PRISTINE });
    const cb = vi.fn();
    expect(subscribeFindState(ed, cb)).not.toBeNull();
    fire({ searchScope: true }); // setModel 同步打的那一发
    expect(cb).toHaveBeenCalledTimes(0);
    expect(readFindState(ed)).toBeNull(); // 没登记 ⇒ 空值闸照旧拦着（若这里登记了，作者从没动过查找也会被洗条）
    fire({ matchCase: true }); // 真作者动作才登记
    expect(cb).toHaveBeenCalledTimes(1);
    expect(readFindState(ed)).toEqual(PRISTINE);
  });
});

describe('① 写侧保留闸：setViewState 入参不带 find ⇒ 保留既有条目的 find（其余字段仍整条覆盖）', () => {
  beforeEach(() => {
    installStorage();
    clearViewStates();
  });

  it('入参无 find：find 原样保留、行列照新值整条覆盖', () => {
    setViewState(ROOT, FILE, withFind(sliceOf(), PERSISTED));
    setViewState(ROOT, FILE, sliceOf(9));
    const got = getViewState(ROOT, FILE)!;
    expect(got.find).toEqual(PERSISTED);
    expect(got.selections[0]!.startLineNumber).toBe(9);
  });

  it('入参带 find：整条替换（作者改词/清词的正常通道不受保留闸影响）', () => {
    setViewState(ROOT, FILE, withFind(sliceOf(), PERSISTED));
    setViewState(ROOT, FILE, withFind(sliceOf(), { ...PERSISTED, searchString: '换新词' }));
    expect(getViewState(ROOT, FILE)!.find!.searchString).toBe('换新词');
    setViewState(ROOT, FILE, withFind(sliceOf(), PRISTINE)); // 作者清空查找框 = 合法的全空 find，能真落
    expect(getViewState(ROOT, FILE)!.find).toEqual(PRISTINE);
  });

  it('既有条目本来没有 find ⇒ 不无中生有', () => {
    setViewState(ROOT, FILE, sliceOf());
    setViewState(ROOT, FILE, sliceOf(4));
    expect('find' in getViewState(ROOT, FILE)!).toBe(false);
  });

  it('入参 find 非法（超长）⇒ 维持"非法即整条丢 find"原口径：本拍不写，既有 find 保留', () => {
    setViewState(ROOT, FILE, withFind(sliceOf(), PERSISTED));
    setViewState(ROOT, FILE, withFind(sliceOf(), { ...PERSISTED, searchString: 'x'.repeat(513) }));
    expect(getViewState(ROOT, FILE)!.find).toEqual(PERSISTED);
  });
});

describe('① 真壳读数全链路复现：重启后开项目的首拍不得洗掉已记录的词', () => {
  beforeEach(() => {
    installStorage();
    clearViewStates();
  });

  it('停机记录 → 重启引用 → 开机首拍快照 → 恢复读拍 → 恢复后正常写存，词全程不丢', () => {
    setViewState(ROOT, FILE, withFind(sliceOf(), PERSISTED));
    flushViewStates();
    const persistedRaw = globalThis.localStorage.getItem(KEY)!;
    installStorage({ [KEY]: persistedRaw }); // 换引用 = 重启
    // 开机首拍：widget 从没被碰过，光标/滚动驱动的快照拍走 persistEditorSlice 同款接线
    const { ed } = patchedEditor({ ...PRISTINE });
    subscribeFindState(ed, () => {});
    setViewState(ROOT, FILE, withFind(sliceOf(9), readFindState(ed))); // ①任一半回退 ⇒ 下面红
    flushViewStates();
    expect(getViewState(ROOT, FILE)!.find).toEqual(PERSISTED);
    // 恢复拍（读在 setModel 前、写在后）拿回真词并放回 widget
    const restoreTarget = getViewState(ROOT, FILE)?.find;
    expect(restoreTarget).toEqual(PERSISTED);
    writeFindState(ed, restoreTarget!);
    // 恢复之后作者动过 ⇒ 快照拍照常把现值写存（不许把恢复后的会话锁成永不写）
    setViewState(ROOT, FILE, withFind(sliceOf(11), readFindState(ed)));
    flushViewStates();
    expect(getViewState(ROOT, FILE)!.find).toEqual(PERSISTED);
    expect(getViewState(ROOT, FILE)!.selections[0]!.startLineNumber).toBe(11);
  });
});

describe('② 恢复次序的源码钉子（读拍先于 setModel、写拍殿后且自带一次纠偏写存）', () => {
  const pane = readFileSync(fileURLToPath(new URL('../src/ui/EditorPane.tsx', import.meta.url)), 'utf8');
  const setModel = pane.indexOf('ed.setModel(entry.model);');
  const read = pane.indexOf('getViewState(persistedFindRoot, filePath)');
  const restore = pane.indexOf('writeFindState(ed, persistedFind)');
  const writeback = pane.indexOf('persistEditorSlice(ed, filePath)', restore);

  it('读拍排在 setModel **之前**（否则开项目/换标签的首拍已把记录洗掉，读到的是别人的词）', () => {
    expect(setModel).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(setModel);
  });

  it('写拍仍在 if/else 之后（monaco 换 model 那拍重置开关，放早了被盖）；恢复自身触发一次写存纠偏', () => {
    expect(restore).toBeGreaterThan(setModel);
    expect(pane.indexOf('if (vs) ed.restoreViewState(vs);')).toBeLessThan(restore);
    expect(writeback).toBeGreaterThan(restore);
    expect(pane.match(/persistEditorSlice\(ed, filePath\)/g)?.length).toBe(1);
    // 热点文件接线面钉子：写存读点仍只有一处 readFindState(ed)
    expect(pane.match(/readFindState\(ed\)/g)?.length).toBe(1);
    expect(pane.match(/writeFindState\(ed, persistedFind\)/g)?.length).toBe(1);
  });
});

describe('② 跨文件拍模型：前导快照洗条 + 预读 + 纠偏写存 ⇒ 后开文件的词不被前文件的词顶掉', () => {
  beforeEach(() => {
    installStorage();
    clearViewStates();
  });

  it('A 用词 XA、B 记着 XB：B 的首拍（widget 还挂着 XA）洗条后，恢复拍的预读值与纠偏写存把它救回', () => {
    const A = 'C:\\Projects\\era\\data\\a.erb';
    const B = 'C:\\Projects\\era\\data\\b.erb';
    const XA: SerializedFind = { ...PERSISTED, searchString: 'XA' };
    const XB: SerializedFind = { ...PERSISTED, searchString: 'XB' };
    setViewState(ROOT, B, withFind(sliceOf(), XB)); // B 的重启前记录
    const { ed } = patchedEditor({ ...PRISTINE });
    subscribeFindState(ed, () => {});
    writeFindState(ed, XA); // 作者在 A 上动过查找 ⇒ 已登记（①的空值闸此后不再拦 B 的首拍）
    setViewState(ROOT, A, withFind(sliceOf(), readFindState(ed)));
    // —— 切到 B：组件的真实拍序 = 预读 → setModel（同步触发快照拍）→ 写回 → 纠偏写存 ——
    const preRead = getViewState(ROOT, B)?.find; // 读拍在 setModel 前：拿到 XB
    expect(preRead).toEqual(XB);
    setViewState(ROOT, B, withFind(sliceOf(7), readFindState(ed))); // 快照拍：widget 还是 XA ⇒ 洗条
    expect(getViewState(ROOT, B)!.find).toEqual(XA); // 洗条确实发生（这正是真壳竞态的机理）
    writeFindState(ed, preRead!); // 写拍（setModel 之后）：XB 放回 widget
    setViewState(ROOT, B, withFind(sliceOf(7), readFindState(ed))); // 恢复自身的纠偏写存
    flushViewStates();
    expect(getViewState(ROOT, B)!.find).toEqual(XB); // 若"读拍在 setModel 后"，此处读回的是 XA ⇒ 红
    expect(ed.getContribution<Monaco.editor.IFindController>(FIND_CONTROLLER_ID)!.getFindStateSilently()).toEqual(XB);
  });
});
