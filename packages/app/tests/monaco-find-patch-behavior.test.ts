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

interface FindModule {
  CommonFindController: new (...args: unknown[]) => Controller;
  getSelectionSearchString: (ed: unknown, seed?: string, fromNonEmpty?: boolean) => string | null;
}

/**
 * 真 monaco 图的装载放在**模块顶层**（collection 期只做一次，不吃用例的 testTimeout）：
 * 这段 import 本机单跑 5–10s（真 monaco 全图，不是桩），全量 604 文件并发下可涨到 60s 以上。
 * 2026-10-21 审阅批实测：装载放在用例里 ⇒ 首个用例被判超时、后续用例继续等同一段装载，
 * 连锁 4 条 timed out（全量三跑三红，同文件单跑却 6/6 绿）；顶到顶层后用例本体只剩 1–2ms。
 * 断言一条不动。
 *
 * findWidget.js 顶层装载同理（widget 半边 PERSIST-B）：测的是安装产物里那枚**真 FindWidget**
 * ——补丁没打上 ⇒ 构造期不回填输入框 ⇒ 判据①当场红。
 */
const monoFind = (await import(pathToFileURL(monacoFindModulePath()).href)) as FindModule;

const FIND_WIDGET_JS = 'editor/contrib/find/browser/findWidget.js';

function monacoFindWidgetModulePath(): string {
  for (const base of [`${repoRoot()}/packages/app/node_modules`, `${repoRoot()}/node_modules`]) {
    const p = `${base}/monaco-editor/esm/vs/${FIND_WIDGET_JS}`;
    if (existsSync(p)) return p;
  }
  throw new Error('monaco-editor findWidget.js 产物不可达：pnpm install 没跑？');
}

interface FindWidgetInstance {
  getDomNode(): HTMLElement;
  dispose(): void;
}

interface WidgetModule {
  FindWidget: new (...args: unknown[]) => FindWidgetInstance;
}

const monoWidget = (await import(pathToFileURL(monacoFindWidgetModulePath()).href)) as WidgetModule;

/**
 * 起一枚真控制器：只喂它构造期与静默路径真的会用到的最小接口。
 * `selectionEmpty=true` ⇒ 选区退化为"光标压词"（PERSIST-B 三档 seed 用例用）；默认保持旧行为。
 * 后半组方法是真 FindWidget 构造期要碰的那几枚（overlay/事件/getOption 的 find 字段），
 * 对旧用例（纯控制器路径）零影响——只是接口变宽。
 */
async function newController(cursorWord = '恢复词', selectionEmpty = false) {
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
    isEmpty: () => selectionEmpty,
    getStartPosition: () => ({ lineNumber: 1, column: 3 }),
  };
  const editor = {
    hasModel: () => true,
    getModel: () => model,
    getSelection: () => selection,
    getSelections: () => [selection],
    getConfiguredWordAtPosition: () => ({ word: cursorWord, startColumn: 3, endColumn: 3 + cursorWord.length }),
    getOption: () => ({
      globalFindClipboard: false,
      loop: true,
      autoFindInSelection: 'never',
      addExtraSpaceOnTop: false,
      findOnType: false,
      history: 'never',
      replaceHistory: 'never',
      seedSearchStringFromSelection: 'never',
    }),
    onDidChangeModel: () => ({ dispose: () => {} }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    onDidChangeCursorSelection: () => ({ dispose: () => {} }),
    onDidFocusEditorWidget: () => ({ dispose: () => {} }),
    onDidScrollChange: () => ({ dispose: () => {} }),
    onDidLayoutChange: () => ({ dispose: () => {} }),
    addOverlayWidget: (w: FindWidgetInstance) => {
      document.body.appendChild(w.getDomNode());
    },
    removeOverlayWidget: (w: FindWidgetInstance) => {
      w.getDomNode().remove();
    },
    getLayoutInfo: () => ({ width: 600, height: 400, contentWidth: 560 }),
    // widget 构造尾段（addExtraSpaceOnTop 判定那路）会伸 viewZones：给一枚静默假面
    changeViewZones: (cb: (z: { addZone: () => number; removeZone: () => void; layoutZone: () => void }) => void) => {
      cb({ addZone: () => 0, removeZone: () => {}, layoutZone: () => {} });
    },
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
  const mod = monoFind;
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

// ---------------------------------------------------------------------------
// PERSIST-B（widget 半边）：真壳 run6 残红的根因钉子。
// find widget 是懒创建的（findController.js 首开才 _createFindWidget），而未打补丁的 findWidget.js
// 构造期（_buildDomNode）只把 _state 喂给三枚开关（setRegex/setCaseSensitive/setWholeWords），
// **没有 setValue**；输入框的值只由 _onStateChanged 的 `this._findInput.setValue(this._state.searchString)`
// 推。⇒ "先 setFindStateSilently、之后才第一次开框"这条路词进得了状态进不了框
// （run6 读数：value:""、inputCls:"input empty"，而三开关 aria-checked=true）。
// 下面断言一律取 widget DOM 里 find 输入框的**实际值**，不是控制器状态（状态本来就是对的）。
// ---------------------------------------------------------------------------

/** 控制器持有的就是真 FindReplaceState（widget 构造期要的第三参）；change 是 monaco 正常 seed 通道 */
interface FindState extends FindStateView {
  change(opts: Record<string, unknown>, reveal: boolean, updateHistory?: boolean): void;
}

/** ContextScopedFindInput 要 createScoped（返回可 dispose 的同一枚）；键面只需 set/reset/get */
function fakeContextKeyService(): Record<string, unknown> {
  const svc: Record<string, unknown> = {
    createKey: () => ({ set: () => {}, reset: () => {}, get: () => false }),
    onDidChange: () => ({ dispose: () => {} }),
    context: {},
    queryContext: () => true,
    dispose: () => {},
  };
  svc.createScoped = () => svc;
  return svc;
}

function newWidget(controller: Controller, editor: unknown): FindWidgetInstance {
  const state = controller.getState() as FindState;
  return new monoWidget.FindWidget(
    editor,
    controller,
    state,
    {}, // contextViewProvider：构造期不碰（只被 hover 类路径惰性用）
    { appendKeybinding: (_l: string, _id: string) => '', getUserBinding: () => undefined }, // keybindingService
    fakeContextKeyService(), // contextKeyService（widget 与 scoped history 共用一枚）
    { setupDelayedHover: () => ({ dispose: () => {} }) }, // hoverService：SimpleButton 构造期就 setupDelayedHover 挂 tooltip
    new Set<string>(), // 查找历史上拉（构造期只判引用）
    new Set<string>(), // 替换历史
    { getValue: () => false }, // configurationService
    {}, // accessibilityService
  );
}

/** 取 widget DOM 里查找输入框（非测量用 unusedInput/unusedTextArea）的实际值集合 */
function findInputDomValues(widget: FindWidgetInstance): string[] {
  const root = widget.getDomNode().querySelector('.monaco-findInput');
  if (!root) throw new Error('widget DOM 里没有 .monaco-findInput');
  const els = Array.from(root.querySelectorAll('input, textarea')).filter(
    (el) => !el.classList.contains('unusedInput') && !el.classList.contains('unusedTextArea'),
  );
  if (els.length === 0) throw new Error('查找输入框的 input/textarea 一个都没摸到');
  return els.map((el) => (el as HTMLInputElement).value);
}

describe('补丁行为⑤（PERSIST-B）：先静默写状态、之后才第一次开框 ⇒ 框内值＝持久词', () => {
  it('setFindStateSilently 后构造 widget：find 输入框 DOM 实际值逐字等于持久词，且不回写状态、不开框不夺焦', async () => {
    const { controller, rec, editor } = await newController('光标词');
    let fired = 0;
    const sub = controller.onDidChangeFindState(() => {
      fired += 1;
    });
    controller.setFindStateSilently({
      searchString: 'PERSIST2ND',
      replaceString: '',
      isRegex: true,
      wholeWord: false,
      matchCase: true,
    });
    expect(fired).toBe(1); // 静默设置那拍
    const widget = newWidget(controller, editor);
    expect(fired).toBe(1); // 构造期回填不许把 _state 再改一遍（不回环）
    try {
      expect(new Set(findInputDomValues(widget))).toEqual(new Set(['PERSIST2ND']));
      // 三开关同批回填（run6 里开关本来就回得来，这条钉住"补值不弄坏开关"）
      const aria = Array.from(widget.getDomNode().querySelectorAll('[aria-checked="true"]')).length;
      expect(aria).toBe(2); // isRegex + matchCase
      expect(controller.getState().isRevealed).toBe(false);
      expect(rec.focusCalls).toBe(0);
    } finally {
      sub.dispose();
      widget.dispose();
      controller.dispose();
    }
  });

  it('构造期回填不盖后续 seed：_state.change 之后 _onStateChanged 仍把框值覆盖成新词（monaco 正常路径顺序不变）', async () => {
    const { controller, editor } = await newController('光标词');
    controller.setFindStateSilently({ searchString: 'PERSIST2ND', replaceString: '', isRegex: false, wholeWord: false, matchCase: false });
    const widget = newWidget(controller, editor);
    try {
      expect(new Set(findInputDomValues(widget))).toEqual(new Set(['PERSIST2ND']));
      // 这正是 _start seed 分支的调用形态：change ⇒ _onStateChanged ⇒ setValue 覆盖
      (controller.getState() as FindState).change({ searchString: '选区seed' }, false);
      expect(new Set(findInputDomValues(widget))).toEqual(new Set(['选区seed']));
    } finally {
      widget.dispose();
      controller.dispose();
    }
  });
});

describe('补丁行为⑥（PERSIST-B）：三档 seedSearchStringFromSelection 语义一字不动', () => {
  /** 逐字镜像 findController 开框动作里的档位闸门（getOption(find).seedSearchStringFromSelection） */
  const seedArgsFor = (tier: 'selection' | 'always' | 'never') => ({
    seed: tier === 'never' ? ('none' as const) : ('single' as const),
    fromNonEmpty: tier === 'selection',
  });

  async function openedWidget(cursorWord: string, selectionEmpty: boolean) {
    const h = await newController(cursorWord, selectionEmpty);
    h.controller.setFindStateSilently({ searchString: 'PERSIST2ND', replaceString: '', isRegex: false, wholeWord: false, matchCase: false });
    return { ...h, widget: newWidget(h.controller, h.editor) };
  }

  it('selection 档：光标压词（空选区）取不到 seed ⇒ 不劫持已恢复的词，框里仍是持久词', async () => {
    const { controller, mod, editor, widget } = await openedWidget('光标词', true);
    try {
      const { seed, fromNonEmpty } = seedArgsFor('selection');
      expect(seed).toBe('single');
      expect(mod.getSelectionSearchString(editor, seed, fromNonEmpty)).toBeNull();
      expect(new Set(findInputDomValues(widget))).toEqual(new Set(['PERSIST2ND']));
    } finally {
      widget.dispose();
      controller.dispose();
    }
  });

  it('selection 档：真选中（非空选区）即选即查——seed 经 _state.change 覆盖构造期回填值', async () => {
    const { controller, mod, editor, widget } = await openedWidget('选中词', false);
    try {
      const { seed, fromNonEmpty } = seedArgsFor('selection');
      expect(mod.getSelectionSearchString(editor, seed, fromNonEmpty)).toBe('选中词');
      (controller.getState() as FindState).change({ searchString: '选中词' }, false);
      expect(new Set(findInputDomValues(widget))).toEqual(new Set(['选中词']));
    } finally {
      widget.dispose();
      controller.dispose();
    }
  });

  it('always 档（single, false）：光标压词仍种光标词，回填值让位于 seed', async () => {
    const { controller, mod, editor, widget } = await openedWidget('光标词', true);
    try {
      const { seed, fromNonEmpty } = seedArgsFor('always');
      expect(mod.getSelectionSearchString(editor, seed, fromNonEmpty)).toBe('光标词');
      (controller.getState() as FindState).change({ searchString: '光标词' }, false);
      expect(new Set(findInputDomValues(widget))).toEqual(new Set(['光标词']));
    } finally {
      widget.dispose();
      controller.dispose();
    }
  });

  it('never 档：闸门给 none，seed helper 根本不参与 ⇒ 框里只用持久词', async () => {
    const { controller, widget } = await openedWidget('光标词', true);
    try {
      expect(seedArgsFor('never').seed).toBe('none');
      expect(new Set(findInputDomValues(widget))).toEqual(new Set(['PERSIST2ND']));
      expect(controller.getState().searchString).toBe('PERSIST2ND');
    } finally {
      widget.dispose();
      controller.dispose();
    }
  });
});
