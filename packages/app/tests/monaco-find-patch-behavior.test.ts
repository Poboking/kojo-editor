// @vitest-environment happy-dom
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * FIND-STATE-PERSIST A（行为半边）：在**真 monaco 控制器实例**上验证补丁的静默语义。
 *
 * 装载的是安装产物里那枚打过补丁的 `findController.js`（不是复刻、不是桩）：
 * `CommonFindController` 由包自己导出，`FindReplaceState` 是它构造时 new 的真状态机，
 * 所以这里的断言测的就是补丁代码本身。**补丁没打上 ⇒ `setFindStateSilently` 不存在 ⇒ 当场红。**
 *
 * 路径一律从仓库根算（happy-dom 下 `import.meta.url` 不是 file: 协议，`fileURLToPath` 会抛；
 * 且 hoisted 布局下 app 局部没有 monaco 符号链接——同 PITFALLS 116，两条候选都试）。
 */

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(`${dir}/pnpm-workspace.yaml`)) return dir;
    const parent = `${dir}/..`;
    if (dir === parent) break;
    dir = parent;
  }
  return process.cwd();
}

const FIND_JS = 'editor/contrib/find/browser/findController.js';

function monacoFindModulePath(): string {
  for (const base of [`${repoRoot()}/packages/app/node_modules`, `${repoRoot()}/node_modules`]) {
    const p = `${base}/monaco-editor/esm/vs/${FIND_JS}`;
    if (existsSync(p)) return p;
  }
  throw new Error('monaco-editor 产物不可达：pnpm install 没跑？');
}

interface FindStateView {
  searchString: string;
  replaceString: string;
  isRegex: boolean;
  wholeWord: boolean;
  matchCase: boolean;
  isRevealed: boolean;
  actualIsRegex: boolean;
  actualWholeWord: boolean;
  actualMatchCase: boolean;
}

interface Controller {
  getState(): FindStateView;
  setFindStateSilently(s: Record<string, unknown>): void;
  getFindStateSilently(): Record<string, unknown>;
  onDidChangeFindState(l: (e: unknown) => void): { dispose(): void };
  dispose(): void;
}

const REC = () => ({ focusCalls: 0, contextKeySets: [] as unknown[] });

/** 起一枚真控制器：只喂它构造期与静默路径真的会用到的最小接口 */
async function newController(cursorWord = '恢复词') {
  const rec = REC();
  const model = {
    getValueInRange: () => cursorWord,
    getValueLengthInRange: () => cursorWord.length,
  };
  const selection = {
    startLineNumber: 1,
    endLineNumber: 1,
    startColumn: 3,
    endColumn: 3 + cursorWord.length,
    isEmpty: () => cursorWord.length === 0,
    getStartPosition: () => ({ lineNumber: 1, column: 3 }),
  };
  const editor = {
    hasModel: () => true,
    getModel: () => model,
    getSelection: () => selection,
    getSelections: () => [selection],
    getConfiguredWordAtPosition: () => ({ word: cursorWord, startColumn: 3, endColumn: 3 + cursorWord.length }),
    getOption: () => ({ globalFindClipboard: false, loop: true, autoFindInSelection: 'never' }),
    onDidChangeModel: () => ({ dispose: () => {} }),
    focus: () => {
      rec.focusCalls += 1;
    },
  };
  // 查找框可见性上下文键：一旦被 set(true) 就说明 widget 亮过（判据②的抓手）
  const contextKeyService = {
    createKey: () => ({
      set: (v: unknown) => rec.contextKeySets.push(v),
      reset: () => rec.contextKeySets.push(false),
    }),
  };
  const storageService = {
    getBoolean: (_k: string, _s: number, def: boolean) => def,
    get: (_k: string, _s: number, def?: string) => def,
    store: () => {},
    remove: () => {},
  };
  const clipboardService = { readFindText: async () => '', writeFindText: () => {} };
  const mod = (await import(pathToFileURL(monacoFindModulePath()).href)) as {
    CommonFindController: new (...args: unknown[]) => Controller;
    getSelectionSearchString: (ed: unknown, seed?: string, fromNonEmpty?: boolean) => string | null;
  };
  const controller = new mod.CommonFindController(
    editor,
    contextKeyService,
    storageService,
    clipboardService,
    {}, // notificationService：静默路径不碰通知
    {}, // hoverService：同上
  );
  return { controller, rec, mod, editor };
}

const SNAPSHOT = {
  searchString: '$foo',
  replaceString: 'bar',
  isRegex: true,
  wholeWord: false,
  matchCase: true,
};

describe('补丁行为①：静默设置后 FindReplaceState 逐字段等（三开关全传）', () => {
  it('五字段逐个相等；读回入口与状态本体同源', async () => {
    const { controller } = await newController();
    try {
      controller.setFindStateSilently(SNAPSHOT);
      const s = controller.getState();
      expect(s.searchString).toBe('$foo');
      expect(s.replaceString).toBe('bar');
      expect(s.isRegex).toBe(true);
      expect(s.wholeWord).toBe(false);
      expect(s.matchCase).toBe(true);
      expect(controller.getFindStateSilently()).toEqual(SNAPSHOT);
    } finally {
      controller.dispose();
    }
  });

  it('开关取 actual* 真值（不经 override），三枚都能独立生效', async () => {
    const { controller } = await newController();
    try {
      const combos = [
        { isRegex: true, wholeWord: true, matchCase: true },
        { isRegex: true, wholeWord: false, matchCase: false },
        { isRegex: false, wholeWord: true, matchCase: false },
        { isRegex: false, wholeWord: false, matchCase: true },
      ];
      for (const c of combos) {
        controller.setFindStateSilently({ searchString: 'x', replaceString: '', ...c });
        const s = controller.getState();
        expect([s.actualIsRegex, s.actualWholeWord, s.actualMatchCase]).toEqual([c.isRegex, c.wholeWord, c.matchCase]);
        expect(controller.getFindStateSilently()).toEqual({
          searchString: 'x',
          replaceString: '',
          isRegex: c.isRegex,
          wholeWord: c.wholeWord,
          matchCase: c.matchCase,
        });
      }
    } finally {
      controller.dispose();
    }
  });
});

describe('补丁行为②：设置过程不打开查找框、不劫持焦点', () => {
  it('isRevealed 全程 false；可见性上下文键从没被 set(true)；editor.focus() 零次', async () => {
    const { controller, rec } = await newController();
    try {
      expect(controller.getState().isRevealed).toBe(false);
      controller.setFindStateSilently(SNAPSHOT);
      expect(controller.getState().isRevealed).toBe(false);
      expect(rec.contextKeySets).not.toContain(true);
      expect(rec.focusCalls).toBe(0);
    } finally {
      controller.dispose();
    }
  });

  it('变更订阅会响一次（宿主据此写存）；同值重复设置不重复响（防回环可依赖）', async () => {
    const { controller } = await newController();
    try {
      let fired = 0;
      const sub = controller.onDidChangeFindState(() => {
        fired += 1;
      });
      controller.setFindStateSilently(SNAPSHOT);
      expect(fired).toBe(1);
      controller.setFindStateSilently(SNAPSHOT);
      expect(fired).toBe(1);
      sub.dispose();
    } finally {
      controller.dispose();
    }
  });
});

describe('补丁行为④：选区 / 光标压词不覆盖已放回的状态（根因钉子）', () => {
  it('光标压在「光标词」上时恢复词逐字不变——且 seed 路径对同一份状态确实会取出光标词', async () => {
    const { controller, rec, editor, mod } = await newController('光标词');
    try {
      controller.setFindStateSilently({
        searchString: '恢复词',
        replaceString: 'replacement',
        isRegex: false,
        wholeWord: false,
        matchCase: false,
      });
      // 前提自证：少了这一条，下面的断言就是空断言（改坏了也绿）——
      // `seedSearchStringFromSelection: 'always'`（editor-options.ts 钉着的那格）走的就是这个 helper。
      expect(mod.getSelectionSearchString(editor, 'single', false)).toBe('光标词');
      // 补丁路径不吃 seed：状态仍是恢复词，且查找框没开、焦点没动
      expect(controller.getState().searchString).toBe('恢复词');
      expect(controller.getState().isRevealed).toBe(false);
      expect(rec.focusCalls).toBe(0);
    } finally {
      controller.dispose();
    }
  });

  it('空串也是合法状态（作者清空过查找框 ⇒ 恢复要把"空"放回去，不是跳过）', async () => {
    const { controller } = await newController();
    try {
      controller.setFindStateSilently({ searchString: '先有词', replaceString: 'x', isRegex: false, wholeWord: false, matchCase: false });
      controller.setFindStateSilently({ searchString: '', replaceString: '', isRegex: false, wholeWord: false, matchCase: false });
      expect(controller.getState().searchString).toBe('');
    } finally {
      controller.dispose();
    }
  });
});
