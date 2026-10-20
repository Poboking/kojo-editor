/**
 * CTX-SUGGEST · 「光标刚落到名字位 ⇒ 主动弹一次补全」的单测（**手写桩 monaco**，零真运行时）。
 *
 * 口径与 `kojo-completion.test.ts` / `erb-completion.test.ts` 同款：桩 `editor` 只实现观察者用到的
 * 公开面（两条事件 + `getModel/getPosition/getSelection(s)/hasTextFocus/getRawOptions/
 * getContribution/getAction/trigger`），断言只看一件事——`editor.action.triggerSuggest` 被按了几次。
 * 桩的 `type()` 逐字复现 Monaco 的打字事件序（单字符纯插入的内容事件 → reason=NotSet 的光标事件）。
 *
 * 覆盖：打字进槽（半角/全角空格、`@`、`CALL `、`调用 `）必弹；无空白的块头、名字字符本身、
 * 字符串、注释、只读、派生视图、widget 已开、多光标、粘贴/IME 成串上字、纯移动光标、
 * 撤销、卸载 —— 一律不弹；同一位置签名重复只弹一次。
 * 输入法合成期（IME 批）：合成会话内 typed / compositionend 提交内容一律不弹；Enter/Tab/Esc
 * 只 stopPropagation、不 preventDefault；非合成期三枚键原样放行。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  CONTEXT_TRIGGER_SOURCE,
  ERB_NAME_SLOTS,
  KOJO_NAME_SLOTS,
  SUGGEST_ACTION_ID,
  SUGGEST_WIDGET_KEYS,
  installSuggestContextTrigger,
  isImeOwnedSuggestKey,
  isSlotOpeningChar,
  isSuggestWidgetKey,
  shouldTriggerContextSuggest,
} from '../src/monaco/suggest-context-trigger';
import { kojoVariableNameSlot } from '../src/monaco/kojo-completion-variables';
import { timingFaceSlot } from '../src/monaco/kojo-completion-faces';
import { erbLabelSlot } from '../src/monaco/erb-completion-context';
import { erbVariableSlotAt } from '../src/monaco/erb-completion-variables';

/** 桩编辑器的可控事实（默认全绿：可写、有焦点、widget 关着、单选、真文件） */
interface StubState {
  languageId: string;
  line: string;
  lineNumber: number;
  column: number;
  readOnly: boolean;
  focus: boolean;
  selectionCount: number;
  selectionEmpty: boolean;
  /** `SuggestModel.state`：0 = Idle（widget 不可见） */
  suggestState: number;
}

/** 桩的可控环境项（不属于"光标/文本"的那些） */
interface StubEnv {
  /** 当前文件路径；空串 = 没有打开文件 */
  path: string;
  /** 派生视图（糖预览） */
  derivedView: boolean;
  /** `editor.trigger` 抛错（模拟动作缺席 / 命令面炸） */
  throwOnTrigger: boolean;
  /** 旧 host 的静态防抖窗口（缺省 0） */
  debounceMs: number;
  /** 新 host 的现取防抖窗口（给了就优先于静态值） */
  getDebounceMs?: () => number;
}

/** 一次按键的替身结果（观察者的护栏只应 stopPropagation，永远不该 preventDefault） */
interface StubKeyResult {
  stopped: boolean;
  prevented: boolean;
}

/**
 * 编辑器容器的替身：观察者在 **capture** 段挂 keydown（要赶在 Monaco textarea 的
 * `preventDefault` 之前），所以这里只记录 capture 监听；`stopped` 之后不再往下送。
 */
interface StubDomNode {
  readonly captureCount: number;
  addEventListener(type: string, cb: (e: unknown) => void, capture?: boolean): void;
  removeEventListener(type: string, cb: (e: unknown) => void, capture?: boolean): void;
  dispatchKeydown(input: { key: string; keyCode: number; isComposing?: boolean }): StubKeyResult;
}

function stubDomNode(): StubDomNode {
  const keydownCapture: ((e: unknown) => void)[] = [];
  return {
    get captureCount() {
      return keydownCapture.length;
    },
    addEventListener(type, cb, capture) {
      if (type === 'keydown' && capture === true) keydownCapture.push(cb);
    },
    removeEventListener(type, cb, capture) {
      if (type !== 'keydown' || capture !== true) return;
      const i = keydownCapture.indexOf(cb);
      if (i >= 0) keydownCapture.splice(i, 1);
    },
    dispatchKeydown(input) {
      const result: StubKeyResult = { stopped: false, prevented: false };
      const event = {
        key: input.key,
        keyCode: input.keyCode,
        isComposing: input.isComposing ?? false,
        stopPropagation: () => {
          result.stopped = true;
        },
        preventDefault: () => {
          result.prevented = true;
        },
      };
      for (const cb of [...keydownCapture]) {
        cb(event);
        if (result.stopped) break; // capture 段已截住 ⇒ 事件到不了 textarea / 容器 bubble
      }
      // 模拟 Monaco textarea 的 target 段：Escape **无条件** preventDefault（防 IE 的 keypress，
      // vendor `textAreaEditContextInput.js`）。capture 截住 ⇒ target 不跑——这正是"Esc 先取消
      // 合成"必须走 capture 的理由：否则输入法的取消动作会和 widget 关闭一起被吞。
      if (!result.stopped && input.key === 'Escape') result.prevented = true;
      return result;
    },
  };
}

interface StubEditor {
  editor: Monaco.editor.IStandaloneCodeEditor;
  state: StubState;
  /** 编辑器容器替身（capture 键护栏挂在这里） */
  dom: StubDomNode;
  /** 观察者实际按下的触发（source + 动作 id） */
  triggers: { source: string; id: string }[];
  /** 打一枚字符：内容事件（单字符纯插入）+ reason=NotSet 的光标事件，与 Monaco 同序 */
  type(ch: string): void;
  /** 退一格（纯删除：rangeLength=1、text=''） */
  backspace(): void;
  /** 一次插入多枚（粘贴 / IME 成串上字） */
  insertMany(text: string): void;
  /** 撤销腿（isUndoing=true） */
  undo(line: string, column: number): void;
  /** 纯移动光标（reason=Explicit=3：点击 / 方向键） */
  moveTo(column: number): void;
  /** 输入法合成开始 / 结束（Monaco 的 public composition 事件） */
  compositionStart(): void;
  compositionEnd(): void;
  /** 按下一枚键（走容器 capture 段；记录 stopPropagation / preventDefault） */
  keydown(input: { key: string; keyCode: number; isComposing?: boolean }): StubKeyResult;
  /** 等 debounce 跑完（缺省等一拍宏任务；可加长以验证非零延迟） */
  settle(ms?: number): Promise<void>;
  dispose(): void;
}

function disposablesOf<T>(list: T[], cb: T) {
  return {
    dispose: () => {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
  };
}

function stubEditor(init: Partial<StubState> & Partial<StubEnv> = {}): StubEditor {
  const env: StubEnv = {
    path: init.path ?? (init.languageId === ERB_LANGUAGE_ID ? '/x/a.ERB' : '/x/a.kojo'),
    derivedView: init.derivedView ?? false,
    throwOnTrigger: init.throwOnTrigger ?? false,
    debounceMs: init.debounceMs ?? 0,
    getDebounceMs: init.getDebounceMs,
  };
  const state: StubState = {
    languageId: init.languageId ?? KOJO_LANGUAGE_ID,
    line: init.line ?? '',
    lineNumber: 1,
    column: init.column ?? (init.line ?? '').length + 1,
    readOnly: init.readOnly ?? false,
    focus: init.focus ?? true,
    selectionCount: init.selectionCount ?? 1,
    selectionEmpty: init.selectionEmpty ?? true,
    suggestState: init.suggestState ?? 0,
  };
  const triggers: { source: string; id: string }[] = [];
  const contentCbs: ((e: unknown) => void)[] = [];
  const cursorCbs: ((e: unknown) => void)[] = [];
  const modelCbs: ((e: unknown) => void)[] = [];
  const compositionStartCbs: (() => void)[] = [];
  const compositionEndCbs: (() => void)[] = [];
  const dom = stubDomNode();
  let version = 1;

  const fireContent = (change: { rangeLength: number; text: string }, flags: Partial<{ isUndoing: boolean; isRedoing: boolean; isFlush: boolean }> = {}) => {
    const event = {
      changes: [{ range: { startLineNumber: 1, endLineNumber: 1, startColumn: state.column, endColumn: state.column }, rangeOffset: 0, rangeLength: change.rangeLength, text: change.text }],
      eol: '\n',
      versionId: ++version,
      isUndoing: flags.isUndoing ?? false,
      isRedoing: flags.isRedoing ?? false,
      isFlush: flags.isFlush ?? false,
      isEolChange: false,
      detailedReasonsChangeLengths: [1],
    };
    for (const cb of [...contentCbs]) cb(event);
  };
  const fireCursor = (reason: number, source: string) => {
    const event = {
      position: { lineNumber: state.lineNumber, column: state.column },
      secondaryPositions: [],
      reason,
      source,
    };
    for (const cb of [...cursorCbs]) cb(event);
  };

  const model = {
    getLanguageId: () => state.languageId,
    getLineContent: (n: number) => (n === state.lineNumber ? state.line : ''),
  };
  const selectionOf = () => ({ isEmpty: () => state.selectionEmpty });
  const editor = {
    getModel: () => model,
    getPosition: () => ({ lineNumber: state.lineNumber, column: state.column }),
    getSelection: selectionOf,
    getSelections: () => Array.from({ length: state.selectionCount }, selectionOf),
    hasTextFocus: () => state.focus,
    // **生产语义**：Monaco 0.57 的 `hasWidgetFocus()` 跟踪的是"焦点在编辑器容器 / overflow 区"
    // （`view.js` 的 CodeEditorWidgetFocusTracker），**打字时恒为 true**、与补全弹窗是否可见无关。
    // 桩按真实值返回 ⇒ 旧实现（拿它当"widget 可见"）会在这里全红，回归钉不留假绿。
    hasWidgetFocus: () => true,
    getRawOptions: () => ({ readOnly: state.readOnly }),
    getContribution: (id: string) =>
      id === 'editor.contrib.suggestController' ? { model: { state: state.suggestState }, dispose: () => undefined } : null,
    getAction: (id: string) => (id === SUGGEST_ACTION_ID ? { id } : null),
    trigger: (source: string, handlerId: string) => {
      if (env.throwOnTrigger) throw new Error('命令面炸了');
      triggers.push({ source, id: handlerId });
    },
    onDidChangeModelContent: (cb: (e: unknown) => void) => {
      contentCbs.push(cb);
      return disposablesOf(contentCbs, cb);
    },
    onDidChangeCursorPosition: (cb: (e: unknown) => void) => {
      cursorCbs.push(cb);
      return disposablesOf(cursorCbs, cb);
    },
    onDidChangeModel: (cb: (e: unknown) => void) => {
      modelCbs.push(cb);
      return disposablesOf(modelCbs, cb);
    },
    // 键护栏挂在容器 DOM 的 capture 段（真实 Monaco 的 `getContainerDomNode()` 是同一节点）
    getContainerDomNode: () => dom as unknown as HTMLElement,
    // 真实 Monaco 的两条 public composition 事件（观察者的合成会话就挂在这里）
    onDidCompositionStart: (cb: () => void) => {
      compositionStartCbs.push(cb);
      return disposablesOf(compositionStartCbs, cb);
    },
    onDidCompositionEnd: (cb: () => void) => {
      compositionEndCbs.push(cb);
      return disposablesOf(compositionEndCbs, cb);
    },
  };

  const api: StubEditor = {
    editor: editor as unknown as Monaco.editor.IStandaloneCodeEditor,
    state,
    dom,
    triggers,
    type(ch: string) {
      const col0 = state.column - 1;
      state.line = state.line.slice(0, col0) + ch + state.line.slice(col0);
      state.column = col0 + 2;
      fireContent({ rangeLength: 0, text: ch });
      fireCursor(0, 'keyboard');
    },
    backspace() {
      const col0 = state.column - 1;
      state.line = state.line.slice(0, col0 - 1) + state.line.slice(col0);
      state.column = col0;
      fireContent({ rangeLength: 1, text: '' });
      fireCursor(0, 'deleteLeft');
    },
    insertMany(text: string) {
      const col0 = state.column - 1;
      state.line = state.line.slice(0, col0) + text + state.line.slice(col0);
      state.column = col0 + text.length + 1;
      fireContent({ rangeLength: 0, text });
      fireCursor(0, 'keyboard');
    },
    undo(line: string, column: number) {
      state.line = line;
      state.column = column;
      fireContent({ rangeLength: 0, text: '' }, { isUndoing: true });
      fireCursor(5, 'api'); // CursorChangeReason.Undo = 5
    },
    moveTo(column: number) {
      state.column = column;
      fireCursor(3, 'mouse'); // CursorChangeReason.Explicit = 3
    },
    compositionStart() {
      for (const cb of [...compositionStartCbs]) cb();
    },
    compositionEnd() {
      for (const cb of [...compositionEndCbs]) cb();
    },
    keydown(input) {
      return dom.dispatchKeydown(input);
    },
    async settle(ms = 5) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    dispose() {
      handle.dispose();
    },
  };
  const handle = installSuggestContextTrigger(api.editor, {
    getPath: () => env.path,
    isDerivedView: () => env.derivedView,
    debounceMs: env.debounceMs,
    ...(env.getDebounceMs === undefined ? {} : { getDebounceMs: env.getDebounceMs }),
  });
  return api;
}

/** 只数"按了补全动作"的次数（忽略别的 source） */
const fired = (s: StubEditor) => s.triggers.filter((t) => t.id === SUGGEST_ACTION_ID).length;

describe('CTX-SUGGEST · 打字进名字位 ⇒ 主动弹一次', () => {
  // 2026-10-18 真壳实机回归钉：Monaco 0.57 的 `hasWidgetFocus()` 是**容器焦点**（打字时恒 true），
  // 不是"补全弹窗可见"。桩按生产真值返回 ⇒ 谁再把它接回闸门⑥，这组用例立刻全红。
  it('`hasWidgetFocus` 恒 true（生产语义）不抑制触发——弹窗可见只认 suggest controller state', async () => {
    const s = stubEditor({ line: '时机' });
    expect((s.editor as { hasWidgetFocus?: () => boolean }).hasWidgetFocus?.()).toBe(true);
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(1);
  });

  it('`时机` 后半角空格 ⇒ 触发一次 editor.action.triggerSuggest（source 可识别）', async () => {
    const s = stubEditor({ line: '时机' });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(1);
    expect(s.triggers[0]?.source).toBe(CONTEXT_TRIGGER_SOURCE);
    expect(s.triggers[0]?.id).toBe(SUGGEST_ACTION_ID);
  });

  it('`时机` 后全角空格 U+3000 ⇒ 同样触发（空白类走 lexer 单源，不是 `[ \\t]`）', async () => {
    const s = stubEditor({ line: '时机' });
    s.type('\u3000');
    await s.settle();
    expect(fired(s)).toBe(1);
  });

  it('`调用` 后空格（`.kojo` 项目函数名槽）⇒ 触发', async () => {
    const s = stubEditor({ line: '调用' });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(1);
  });

  it('`CALL` 后空格（`.erb` 直系调用位）⇒ 触发', async () => {
    const s = stubEditor({ languageId: ERB_LANGUAGE_ID, line: 'CALL' });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(1);
  });

  it('行首 `@`（`.erb` 定义位）⇒ 触发', async () => {
    const s = stubEditor({ languageId: ERB_LANGUAGE_ID, line: '' });
    s.type('@');
    await s.settle();
    expect(fired(s)).toBe(1);
  });

  it('`时机 本番` 后空格 = 编号位 ⇒ 触发（分野位之后仍继续给）', async () => {
    const s = stubEditor({ line: '时机 本番' });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(1);
  });

  it('非打字事件（纯移动光标，reason=Explicit）⇒ 不弹', async () => {
    const s = stubEditor({ line: '时机 ', column: 4 });
    s.moveTo(3);
    s.moveTo(4);
    await s.settle();
    expect(fired(s)).toBe(0);
  });

  it('撤销腿（isUndoing + reason=Undo）⇒ 不弹', async () => {
    const s = stubEditor({ line: '时机' });
    s.undo('时机 ', 4);
    await s.settle();
    expect(fired(s)).toBe(0);
  });

  it('粘贴 / IME 成串上字（一次插入多枚）⇒ 不弹', async () => {
    const s = stubEditor({ line: '' });
    s.insertMany('时机 ');
    await s.settle();
    expect(fired(s)).toBe(0);
  });

  it('名字字符本身不重复扳机（widget 已开时 Monaco 自己过滤）', async () => {
    const s = stubEditor({ line: '时机' });
    s.type(' ');
    await s.settle();
    s.state.suggestState = 1; // 手动模拟"widget 开着"，避免下一拍被 state 之外的判据误挡
    s.type('本');
    await s.settle();
    expect(fired(s)).toBe(1);
  });
});

describe('CTX-SUGGEST · 不弹的落点（判据本身不认）', () => {
  it('`时机本番：`（词后无空白 = 不是这一位）+ 行尾空格 ⇒ 不弹', async () => {
    const s = stubEditor({ line: '时机本番：' });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(0);
  });

  it('普通台词行打空格 ⇒ 不弹（两门语言的锚都不在行首命中）', async () => {
    const s = stubEditor({ languageId: ERB_LANGUAGE_ID, line: 'PRINTL 你好' });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(0);
  });

  it('`.kojo` 行中的 `@` 不是原生块起点（只有行首 `@` 才算，§3.10）', async () => {
    const s = stubEditor({ languageId: KOJO_LANGUAGE_ID, line: '文本' });
    s.type('@');
    await s.settle();
    expect(fired(s)).toBe(0);
  });
});

describe('CTX-SUGGEST · 抑制条件逐条', () => {
  it('字符串内 ⇒ 不弹（编号位判据本会命中，只有串内判据拦得住）', async () => {
    const s = stubEditor({ line: '时机 "本' });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(0);
  });

  it('注释内 ⇒ 不弹（`;` 起至行尾不是代码视野）', async () => {
    const s = stubEditor({ line: '时机 ;本' });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(0);
  });

  it('只读（`erbReadOnlyGate` 设进 Monaco 的 `readOnly`）⇒ 不弹', async () => {
    const s = stubEditor({ line: '时机', readOnly: true });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(0);
  });

  it('补全 widget 已可见 ⇒ 不重弹', async () => {
    const s = stubEditor({ line: '时机', suggestState: 1 });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(0);
  });

  it('多光标 ⇒ 不弹（一次弹给谁不清楚）', async () => {
    const s = stubEditor({ line: '时机', selectionCount: 2 });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(0);
  });

  it('有选区 ⇒ 不弹（作者正在选，不是正在写）', async () => {
    const s = stubEditor({ line: '时机 ', selectionEmpty: false });
    s.state.column = 4;
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(0);
  });

  it('编辑器失焦 ⇒ 不弹（分屏里不打扰另一组）', async () => {
    const s = stubEditor({ line: '时机', focus: false });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(0);
  });

  it('同一位置签名连续两拍 ⇒ 只弹一次（删掉空格再敲回同一处不重弹）', async () => {
    const s = stubEditor({ line: '时机' });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(1);
    s.backspace(); // 纯删除：本身不弹，也撤销待排的一拍
    await s.settle();
    expect(fired(s)).toBe(1);
    s.type(' '); // 回到完全相同的 `{行, 列, 光标前文}` ⇒ 同签名
    await s.settle();
    expect(fired(s)).toBe(1);
  });

  it('卸载后事件仍到达 ⇒ 不再弹（listener 全释放）', async () => {
    const s = stubEditor({ line: '时机' });
    s.dispose();
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(0);
  });

  it('派生视图（糖预览 model）⇒ 观察者也拦得住（不依赖只读这一条腿）', async () => {
    const s = stubEditor({ line: '时机', derivedView: true });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(0);
  });

  it('没打开文件（空编辑器）⇒ 不弹', async () => {
    const s = stubEditor({ line: '时机', path: '' });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(0);
  });

  it('触发抛错 ⇒ 不崩、留一行可见痕迹，且不记位置签名（下一拍还会再试）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = stubEditor({ line: '时机', throwOnTrigger: true });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(0);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes(CONTEXT_TRIGGER_SOURCE))).toHaveLength(1);
    s.backspace();
    s.type(' ');
    await s.settle();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes(CONTEXT_TRIGGER_SOURCE))).toHaveLength(1);
    warn.mockRestore();
  });

  it('派生视图（糖预览 model）⇒ 不弹（纯函数闸门，逐条可测）', () => {
    const base = {
      languageId: KOJO_LANGUAGE_ID,
      line: '时机 ',
      column: 4,
      typedChar: ' ',
      hasPath: true,
      readOnly: false,
      derivedView: false,
      focused: true,
      multiCursor: false,
      selectionActive: false,
      widgetVisible: false,
    };
    expect(shouldTriggerContextSuggest(base)).toBe(true); // 闸门全绿 ⇒ 弹（本轮候选由候选源自己认）
    expect(shouldTriggerContextSuggest({ ...base, derivedView: true })).toBe(false);
    expect(shouldTriggerContextSuggest({ ...base, hasPath: false })).toBe(false);
    expect(shouldTriggerContextSuggest({ ...base, languageId: 'plaintext' })).toBe(false);
    // SUGGEST-2B：gate ⑦ 只要求"刚敲下一枚字符"——名字字符落在名字位同样算（不再看字符白名单）
    expect(shouldTriggerContextSuggest({ ...base, typedChar: '本' })).toBe(true);
    expect(shouldTriggerContextSuggest({ ...base, typedChar: null })).toBe(false);
    // QSUG-2 gate ⑪：设置页关掉「输入时自动弹出补全」⇒ 本观察者也不替作者触发
    expect(shouldTriggerContextSuggest({ ...base, quickSuggestionsEnabled: false })).toBe(false);
    expect(shouldTriggerContextSuggest({ ...base, quickSuggestionsEnabled: true })).toBe(true);
  });
});

describe('CTX-SUGGEST · 「打开名字位」的字符集', () => {
  it('空白（半角 / 全角 / 制表）、`@` / `,` / `，` / 半角 `:` / `的` 算；名字字符、全角 `：` 与换行不算', () => {
    expect(
      [' ', '\u3000', '\t', '@', ',', '，', ':', '的'].map(isSlotOpeningChar),
    ).toEqual([true, true, true, true, true, true, true, true]);
    // 全角 `：` 刻意不在集合：两门语言都把它挂在 Monaco `triggerCharacters`（原生触发路径），
    // 本观察者不重开一条（见 `isSlotOpeningChar` 注释）
    expect(['本', '1', '(', '：', '\n'].map(isSlotOpeningChar)).toEqual([false, false, false, false, false]);
  });
});

describe('CTX-SUGGEST · 探针清单（①③⑤⑥ 触发链：宿主零抄本的名单面）', () => {
  it('`.kojo` 七枚 / `.erb` 四枚，成分 = 候选源白名单', () => {
    expect(KOJO_NAME_SLOTS).toHaveLength(7);
    expect(ERB_NAME_SLOTS).toHaveLength(4);
    // 命中直接挂的那几枚（身份可比对）；boolean 签名两枚已折 true/null、只做行为面断言（下一条）
    expect(KOJO_NAME_SLOTS).toContain(timingFaceSlot);
    expect(KOJO_NAME_SLOTS).toContain(kojoVariableNameSlot);
    expect(ERB_NAME_SLOTS).toContain(erbLabelSlot);
    expect(ERB_NAME_SLOTS).toContain(erbVariableSlotAt);
  });

  it('探针契约 `!== null`：非命中位所有探针回 `null`，绝不回 `false`（false 会被当命中 ⇒ 恒触发）', () => {
    // 直接挂 boolean 探针会让本循环收到 `false`：折 `true/null` 的接线契约钉在这里
    for (const probe of KOJO_NAME_SLOTS) expect(probe('随便一句台词。', 7)).toBeNull();
    for (const probe of ERB_NAME_SLOTS) expect(probe('PRINTL 你好', 10)).toBeNull();
  });

  it('命中面逐枚非空（弹了有货）：`成否:` / `{她的` / `[[她的` / `GOTO ` / `CFLAG:` / `GETBIT(HOLD,)`', () => {
    expect(KOJO_NAME_SLOTS.some((p) => p('时机 指令 310 成否:', 14) !== null)).toBe(true);
    expect(KOJO_NAME_SLOTS.some((p) => p('{她的', 4) !== null)).toBe(true);
    expect(KOJO_NAME_SLOTS.some((p) => p('    [[她的', 9) !== null)).toBe(true);
    expect(ERB_NAME_SLOTS.some((p) => p('GOTO ', 6) !== null)).toBe(true);
    expect(ERB_NAME_SLOTS.some((p) => p('CFLAG:', 7) !== null)).toBe(true);
    expect(ERB_NAME_SLOTS.some((p) => p('GETBIT(HOLD,)', 13) !== null)).toBe(true);
  });

  it('位槽探针的 `)` 依赖（`autoClosingPairs` 植入）：`GETBIT(HOLD,)` 命中；缺 `)` 的半成品不猜', () => {
    // 打字当拍 `)` 已由 `erb-language.ts` 的 autoClosingPairs 放进模型（`GETBIT(` → `GETBIT()`），
    // 逗号落下后光标正在 `,` 与 `)` 之间 ⇒ 命中；`matchingParen` 未闭合半成品一律 null（不猜）
    expect(ERB_NAME_SLOTS.some((p) => p('GETBIT(HOLD,)', 13) !== null)).toBe(true);
    expect(ERB_NAME_SLOTS.some((p) => p('GETBIT(HOLD, ', 14) !== null)).toBe(false);
  });
});

describe('CTX-SUGGEST · 批①③⑤⑥ 新探针：打字当拍直弹', () => {
  it('`的`：`{她` 处敲 `的`（widget 已被过滤死）⇒ 重触发一轮拿变量全量', async () => {
    const s = stubEditor({ line: '{她', column: 3 });
    s.type('的');
    await s.settle();
    expect(fired(s)).toBe(1);
    expect(s.triggers[0]?.source).toBe(CONTEXT_TRIGGER_SOURCE);
  });

  it('`的`：台词行里敲 `的` ⇒ 不弹（变量名位探针不认普通文本）', async () => {
    const s = stubEditor({ line: '这是她', column: 4 });
    s.type('的');
    await s.settle();
    expect(fired(s)).toBe(0);
  });

  it('`:`：`.erb` 变量族冒号位（`CFLAG` 后敲冒号）⇒ 弹变量族候选', async () => {
    const s = stubEditor({ languageId: ERB_LANGUAGE_ID, line: 'CFLAG', column: 6 });
    s.type(':');
    await s.settle();
    expect(fired(s)).toBe(1);
  });

  it('`:`：`.kojo` 时机头命名参数键冒号位（`成否` 后敲冒号）⇒ 弹取值候选', async () => {
    const s = stubEditor({ line: '时机 指令 310 成否', column: 13 });
    s.type(':');
    await s.settle();
    expect(fired(s)).toBe(1);
  });

  it('空白：跳转家族关键字之后（`GOTO ` / `JUMP `）⇒ 弹标签候选', async () => {
    for (const kw of ['GOTO', 'JUMP']) {
      const s = stubEditor({ languageId: ERB_LANGUAGE_ID, line: kw, column: kw.length + 1 });
      s.type(' ');
      await s.settle();
      expect(fired(s), kw).toBe(1);
    }
  });

  it('`,`：位原语第二实参坑（`GETBIT(HOLD,` 刚敲逗号）⇒ 弹；普通调用 `CALL FOO,` ⇒ 不弹', async () => {
    // 括号由 Monaco `autoClosingPairs` 自带（`erb-language.ts`）：模型里 `)` 已在逗号之后
    const bit = stubEditor({ languageId: ERB_LANGUAGE_ID, line: 'GETBIT(HOLD)', column: 12 });
    bit.type(',');
    await bit.settle();
    expect(fired(bit)).toBe(1);

    const call = stubEditor({ languageId: ERB_LANGUAGE_ID, line: 'CALL FOO', column: 9 });
    call.type(',');
    await call.settle();
    expect(fired(call)).toBe(0);
  });

  it('纯闸门对拍：探针命中 ⇒ true；台词 / 非位槽 ⇒ false', () => {
    const base = {
      languageId: KOJO_LANGUAGE_ID,
      line: '',
      column: 1,
      typedChar: null as string | null,
      hasPath: true,
      readOnly: false,
      derivedView: false,
      focused: true,
      multiCursor: false,
      selectionActive: false,
      widgetVisible: false,
    };
    // `.kojo` 命中面
    expect(shouldTriggerContextSuggest({ ...base, line: '{她的', column: 4, typedChar: '的' })).toBe(true);
    expect(shouldTriggerContextSuggest({ ...base, line: '时机 指令 310 成否:', column: 14, typedChar: ':' })).toBe(true);
    // 台词行：`这是她的书|` —— `的` 在普通文本里不打开任何名字位
    expect(shouldTriggerContextSuggest({ ...base, line: '这是她的书', column: 6, typedChar: '的' })).toBe(false);
    // `.erb` 命中面
    const erb = { ...base, languageId: ERB_LANGUAGE_ID };
    expect(shouldTriggerContextSuggest({ ...erb, line: 'CFLAG:', column: 7, typedChar: ':' })).toBe(true);
    expect(shouldTriggerContextSuggest({ ...erb, line: 'GOTO ', column: 6, typedChar: ' ' })).toBe(true);
    expect(shouldTriggerContextSuggest({ ...erb, line: 'JUMP ', column: 6, typedChar: ' ' })).toBe(true);
    expect(shouldTriggerContextSuggest({ ...erb, line: 'GETBIT(HOLD,)', column: 13, typedChar: ',' })).toBe(true);
    expect(shouldTriggerContextSuggest({ ...erb, line: 'CALL FOO,', column: 10, typedChar: ',' })).toBe(false);
  });
});

/* ============================== SUGGEST-2B · 停手即弹（任意单字符） ============================== */

describe('CTX-SUGGEST · 名字槽内继续打字 / 过滤到零后恢复', () => {
  it('名字槽里继续打任意字符（widget 未开）⇒ 每个新位置都排程触发', async () => {
    const s = stubEditor({ line: '时机' });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(1);
    // 真壳里 widget 开着时由 gate ⑥ 挡住；这里模拟"上一轮已被过滤到零、widget 自动关闭"。
    s.type('本');
    await s.settle();
    expect(fired(s)).toBe(2);
    s.type('番');
    await s.settle();
    expect(fired(s)).toBe(3);
  });

  it('过滤到零 ⇒ Monaco 关掉 widget ⇒ 再打名字字符重开一轮（gate ⑥ 只看当下状态）', async () => {
    const s = stubEditor({ line: '时机' });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(1);
    s.state.suggestState = 1; // widget 开着：Monaco 自己边打字边过滤，宿主不许重置选择
    s.type('本');
    await s.settle();
    expect(fired(s)).toBe(1);
    s.state.suggestState = 0; // 过滤到零 ⇒ 自动关闭
    s.type('番');
    await s.settle();
    expect(fired(s)).toBe(2);
  });

  it('widget 已开（含 Loading 态）时任意字符都不重弹', async () => {
    const s = stubEditor({ line: '时机 ', suggestState: 2 });
    s.type('本');
    await s.settle();
    expect(fired(s)).toBe(0);
  });

  it('删除 / 粘贴 / 撤销仍然撤拍（不因放松 gate ⑦ 而变多）', async () => {
    const s = stubEditor({ line: '时机 ', column: 4 });
    s.backspace();
    await s.settle();
    s.insertMany('本番');
    await s.settle();
    s.undo('时机 ', 4);
    await s.settle();
    expect(fired(s)).toBe(0);
  });
});

describe('CTX-SUGGEST · 放松 gate ⑦ 后台词 / 普通文本零骚扰（逐列证明）', () => {
  /** 典型台词 / 旁白（`.kojo` 表层）与普通命令行（`.erb`）：没有任何名字位探针该认的锚 */
  const KOJO_ORDINARY = ['「今天也来训练了？」', '她微微一笑，转过身去。', '旁白：天气真好', '这是她的书'];
  const ERB_ORDINARY = ['PRINTL 你好', 'PRINTFORMDW 「她笑了」', '; 注释：随便写', 'ENDIF', 'RETURN 1'];

  it('`.kojo` 普通行：任意列上六枚探针全不认（弹了没货的位置从一开始就不在名单里）', () => {
    for (const line of KOJO_ORDINARY) {
      for (let column = 1; column <= line.length + 1; column++) {
        expect(KOJO_NAME_SLOTS.some((probe) => probe(line, column) !== null), `${line}@${column}`).toBe(false);
      }
    }
  });

  it('`.erb` 普通行：任意列上四枚探针全不认', () => {
    for (const line of ERB_ORDINARY) {
      for (let column = 1; column <= line.length + 1; column++) {
        expect(ERB_NAME_SLOTS.some((probe) => probe(line, column) !== null), `${line}@${column}`).toBe(false);
      }
    }
  });

  it('纯闸门逐列对拍：普通行任意位置 + 任意字符都 false（gate ⑩ 兜底，不靠字符白名单）', () => {
    const base = {
      typedChar: '好' as string | null,
      hasPath: true,
      readOnly: false,
      derivedView: false,
      focused: true,
      multiCursor: false,
      selectionActive: false,
      widgetVisible: false,
    };
    for (const line of KOJO_ORDINARY) {
      for (let column = 1; column <= line.length + 1; column++) {
        expect(
          shouldTriggerContextSuggest({ ...base, languageId: KOJO_LANGUAGE_ID, line, column }),
          `${line}@${column}`,
        ).toBe(false);
      }
    }
    for (const line of ERB_ORDINARY) {
      for (let column = 1; column <= line.length + 1; column++) {
        expect(
          shouldTriggerContextSuggest({ ...base, languageId: ERB_LANGUAGE_ID, line, column }),
          `${line}@${column}`,
        ).toBe(false);
      }
    }
  });

  it('观察者层：台词行 / 普通文本里打任意字符 ⇒ 0 次触发', async () => {
    const kojo = stubEditor({ line: '「今天也来训练了？」', column: 4 });
    kojo.type('也');
    await kojo.settle();
    expect(fired(kojo)).toBe(0);

    const erb = stubEditor({ languageId: ERB_LANGUAGE_ID, line: 'PRINTL 你好', column: 4 });
    erb.type('你');
    await erb.settle();
    expect(fired(erb)).toBe(0);
  });
});

/* ============================== SUGGEST-2B · 可调延迟 ============================== */

describe('CTX-SUGGEST · 可调防抖（getDebounceMs 每次现取）', () => {
  it('默认 0ms：击键当拍不评估（同拍事件合并），下一拍才弹', async () => {
    const s = stubEditor({ line: '时机' });
    s.type(' ');
    expect(fired(s)).toBe(0); // 宁晚一拍，也不在内容事件里同步弹（widget 状态尚未落定）
    await s.settle();
    expect(fired(s)).toBe(1);
  });

  it('40ms 延迟：窗口内不弹，过窗才弹；改回 0 ⇒ 下一次击键立即生效（假时钟，钉边界）', async () => {
    vi.useFakeTimers();
    try {
      let delay = 40;
      const s = stubEditor({ line: '时机', getDebounceMs: () => delay });
      s.type(' ');
      await vi.advanceTimersByTimeAsync(39);
      expect(fired(s)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(fired(s)).toBe(1);

      delay = 0; // 设置页拨回「立即」：不需要重装观察者
      s.type('本');
      await vi.advanceTimersByTimeAsync(1);
      expect(fired(s)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('旧 host（只有静态 debounceMs）行为零改动：30ms 窗口照旧生效', async () => {
    vi.useFakeTimers();
    try {
      const s = stubEditor({ line: '时机', debounceMs: 30 });
      s.type(' ');
      await vi.advanceTimersByTimeAsync(29);
      expect(fired(s)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(fired(s)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('同时给静态值与 getter ⇒ getter 优先（每次现取）', async () => {
    const s = stubEditor({ line: '时机', debounceMs: 500, getDebounceMs: () => 0 });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(1);
  });

  it('脏值静默夹取：负值 / NaN ⇒ 0（立即），超大值 ⇒ 钳到 2000', async () => {
    const negative = stubEditor({ line: '时机', getDebounceMs: () => -50 });
    negative.type(' ');
    await negative.settle();
    expect(fired(negative)).toBe(1);

    const nan = stubEditor({ line: '时机', getDebounceMs: () => Number.NaN });
    nan.type(' ');
    await nan.settle();
    expect(fired(nan)).toBe(1);

    vi.useFakeTimers();
    try {
      const huge = stubEditor({ line: '时机', getDebounceMs: () => 99999 });
      huge.type(' ');
      await vi.advanceTimersByTimeAsync(1999);
      expect(fired(huge)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(fired(huge)).toBe(1);
      huge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('getter 抛错 ⇒ 回落静态 0，不把异常抛进 Monaco 事件链', async () => {
    const s = stubEditor({
      line: '时机',
      getDebounceMs: () => {
        throw new Error('偏好源炸了');
      },
    });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(1);
  });

  it('延迟窗口内卸载 ⇒ 定时器清掉，不再触发', async () => {
    vi.useFakeTimers();
    try {
      const s = stubEditor({ line: '时机', getDebounceMs: () => 200 });
      s.type(' ');
      s.dispose();
      await vi.advanceTimersByTimeAsync(300);
      expect(fired(s)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ============================== SUGGEST-2A · 原生区触发接线（gate ⑩ + nativeSlot） ============================== */

describe('CTX-SUGGEST · .kojo 原生区名字位 ⇒ 主动弹', () => {
  it('原生直通行 `GOTO ` ⇒ 空格当拍触发（纯原生槽，糖探针不认）', async () => {
    const s = stubEditor({ line: 'GOTO' });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(1);
  });

  it('行首 `@` = 原生块起点 ⇒ 当场触发', async () => {
    const s = stubEditor({ line: '' });
    s.type('@');
    await s.settle();
    expect(fired(s)).toBe(1);
  });

  it('原生 `CALL` 未跟空白 ⇒ 不提前弹空候选；空格当拍才弹一次', async () => {
    const s = stubEditor({ line: '' });
    for (const ch of ['C', 'A', 'L', 'L']) {
      s.type(ch);
      await s.settle();
    }
    expect(fired(s)).toBe(0); // 宽门 call-target 命中，但 erb-functions 的槽还不在
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(1);
  });

  it('糖行 `调用 ` 仍由糖探针触发（原生槽接线不抢糖位）', async () => {
    const s = stubEditor({ line: '调用' });
    s.type(' ');
    await s.settle();
    expect(fired(s)).toBe(1);
  });

  it('纯闸门：nativeSlot=true 能过 ⑩；false 时 `CALL ` 不算糖册名字位', () => {
    const base = {
      hasPath: true,
      readOnly: false,
      derivedView: false,
      focused: true,
      multiCursor: false,
      selectionActive: false,
      widgetVisible: false,
      typedChar: ' ' as string | null,
    };
    // `GOTO ` 是纯原生槽：糖册探针不认，只有 nativeSlot 这一票能放行
    const atGoto = { ...base, languageId: KOJO_LANGUAGE_ID, line: 'GOTO ', column: 6 };
    expect(shouldTriggerContextSuggest({ ...atGoto, nativeSlot: true })).toBe(true);
    expect(shouldTriggerContextSuggest({ ...atGoto, nativeSlot: false })).toBe(false);
  });
});

/* ============================== IME · 合成期与补全互斥 ============================== */

describe('CTX-SUGGEST · 输入法合成期：纯判据（复用 shell-keys 单源）', () => {
  const base = {
    languageId: KOJO_LANGUAGE_ID,
    line: '调用 ',
    column: 4,
    typedChar: ' ' as string | null,
    hasPath: true,
    readOnly: false,
    derivedView: false,
    focused: true,
    multiCursor: false,
    selectionActive: false,
    widgetVisible: false,
    quickSuggestionsEnabled: true,
  };

  it('gate ⑫：composing=true 一律不弹；false / 缺省与既有路径逐字一致', () => {
    expect(shouldTriggerContextSuggest(base)).toBe(true);
    expect(shouldTriggerContextSuggest({ ...base, composing: false })).toBe(true);
    expect(shouldTriggerContextSuggest({ ...base, composing: true })).toBe(false);
  });

  it('补全动作键清单 = Enter / Tab / Escape（`key` 缺席时 13 / 9 / 27 兜底）', () => {
    expect(SUGGEST_WIDGET_KEYS).toEqual(['Enter', 'Tab', 'Escape']);
    for (const key of SUGGEST_WIDGET_KEYS) expect(isSuggestWidgetKey({ key }), key).toBe(true);
    expect(isSuggestWidgetKey({ key: 'Esc' })).toBe(true);
    for (const keyCode of [13, 9, 27]) expect(isSuggestWidgetKey({ keyCode }), String(keyCode)).toBe(true);
    // `Process` / 229 不是"接受 / 关闭"动作键；Monaco 自己对它整拍不派发
    expect(isSuggestWidgetKey({ key: 'Process', keyCode: 229 })).toBe(false);
    expect(isSuggestWidgetKey({ key: 'a', keyCode: 65 })).toBe(false);
  });

  it.each([['Enter'], ['Tab'], ['Escape']])(
    '%s：三证（isComposing / keyCode 229 / 会话标志）任一成立 ⇒ 归输入法；全无 ⇒ 归编辑器',
    (key) => {
      expect(isImeOwnedSuggestKey({ key, isComposing: true }, false)).toBe(true);
      expect(isImeOwnedSuggestKey({ key, keyCode: 229, isComposing: false }, false)).toBe(true);
      expect(isImeOwnedSuggestKey({ key, isComposing: false }, true)).toBe(true);
      // 非合成期：作者真的在按这一枚键，补全行为逐字不变
      expect(isImeOwnedSuggestKey({ key, isComposing: false }, false)).toBe(false);
    },
  );

  it('非补全动作键不越权：合成期也不归本门管（Composition 命令面由 Monaco 自己整拍忽略）', () => {
    expect(isImeOwnedSuggestKey({ key: 'a', keyCode: 65, isComposing: true }, true)).toBe(false);
    expect(isImeOwnedSuggestKey({ key: 'ArrowDown', keyCode: 40 }, true)).toBe(false);
  });
});

describe('CTX-SUGGEST · 输入法合成期：观察者不弹、不接建议、不吞非合成键', () => {
  it('合成期键入（拼音逐字落进 model）⇒ 0 次触发；compositionend 后继续敲名字恢复', async () => {
    const s = stubEditor({ line: '调用 ' });
    s.compositionStart();
    s.type('n'); // 真 Monaco：compositionupdate 会把拼音写进 model
    await s.settle();
    s.type('i');
    await s.settle();
    expect(fired(s)).toBe(0);
    s.compositionEnd();
    await s.settle();
    expect(fired(s)).toBe(0); // 提交那一笔内容事件在 compositionend 之前到达，按合成期吞掉
    s.type('好'); // 合成结束后的真实击键：既有路径原样恢复
    await s.settle();
    expect(fired(s)).toBe(1);
  });

  it('排程后立刻进入合成 ⇒ 待发的一拍作废（合成期不许补弹）', async () => {
    vi.useFakeTimers();
    try {
      const s = stubEditor({ line: '调用 ', getDebounceMs: () => 40 });
      s.type(' ');
      s.compositionStart(); // compositionstart 早于定时器到点
      await vi.advanceTimersByTimeAsync(50);
      expect(fired(s)).toBe(0);
      s.compositionEnd();
      s.type('好');
      await vi.advanceTimersByTimeAsync(50);
      expect(fired(s)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('合成期 Enter / Tab / Escape 在 capture 段截住；护栏自身不调 preventDefault（Esc 的取消留给输入法）', () => {
    const s = stubEditor({ line: '调用 ' });
    s.compositionStart();
    for (const [key, keyCode] of [
      ['Enter', 13],
      ['Tab', 9],
      ['Escape', 27],
    ] as const) {
      const r = s.keydown({ key, keyCode });
      expect(r.stopped, key).toBe(true);
      expect(r.prevented, key).toBe(false);
    }
    s.compositionEnd();
    // 非合成期：三枚键原样放行（接受建议 / 关闭 widget 仍由 Monaco 自己处理）。
    // Escape 的 preventDefault 是 Monaco textarea 的既有行为（靶段模拟），不是本护栏加的。
    for (const [key, keyCode] of [
      ['Enter', 13],
      ['Tab', 9],
      ['Escape', 27],
    ] as const) {
      const r = s.keydown({ key, keyCode });
      expect(r.stopped, key).toBe(false);
      expect(r.prevented, key).toBe(key === 'Escape');
    }
  });

  it('单拍证据（isComposing / keyCode 229）即使会话标志未建立也挡；非动作键不越权', () => {
    const s = stubEditor({ line: '调用 ' });
    expect(s.keydown({ key: 'Enter', keyCode: 13, isComposing: true }).stopped).toBe(true);
    expect(s.keydown({ key: 'Tab', keyCode: 229 }).stopped).toBe(true);
    expect(s.keydown({ key: 'a', keyCode: 65, isComposing: true }).stopped).toBe(false);
  });

  it('卸载后合成 / 按键监听一并释放（capture 监听器清零，不再 stopPropagation）', () => {
    const s = stubEditor({ line: '调用 ' });
    expect(s.dom.captureCount).toBe(1); // 安装即挂上容器 capture 护栏
    s.compositionStart();
    s.dispose();
    expect(s.dom.captureCount).toBe(0);
    expect(s.keydown({ key: 'Enter', keyCode: 13 }).stopped).toBe(false);
  });
});
