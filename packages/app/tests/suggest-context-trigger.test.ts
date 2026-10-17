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
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  CONTEXT_TRIGGER_SOURCE,
  SUGGEST_ACTION_ID,
  installSuggestContextTrigger,
  isSlotOpeningChar,
  shouldTriggerContextSuggest,
} from '../src/monaco/suggest-context-trigger';

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
}

interface StubEditor {
  editor: Monaco.editor.IStandaloneCodeEditor;
  state: StubState;
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
  /** 等 debounce 跑完（debounceMs=0 ⇒ 一拍宏任务即可） */
  settle(): Promise<void>;
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
    hasWidgetFocus: () => false,
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
  };

  const api: StubEditor = {
    editor: editor as unknown as Monaco.editor.IStandaloneCodeEditor,
    state,
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
    async settle() {
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    dispose() {
      handle.dispose();
    },
  };
  const handle = installSuggestContextTrigger(api.editor, {
    getPath: () => env.path,
    isDerivedView: () => env.derivedView,
    debounceMs: 0,
  });
  return api;
}

/** 只数"按了补全动作"的次数（忽略别的 source） */
const fired = (s: StubEditor) => s.triggers.filter((t) => t.id === SUGGEST_ACTION_ID).length;

describe('CTX-SUGGEST · 打字进名字位 ⇒ 主动弹一次', () => {
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

  it('`.erb` 的 `@` 不在 `.kojo` 里算名字位（语言闸生效）', async () => {
    const s = stubEditor({ languageId: KOJO_LANGUAGE_ID, line: '' });
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
    expect(shouldTriggerContextSuggest({ ...base, typedChar: '本' })).toBe(false);
    expect(shouldTriggerContextSuggest({ ...base, typedChar: null })).toBe(false);
  });
});

describe('CTX-SUGGEST · 「打开名字位」的字符集', () => {
  it('空白（半角 / 全角 / 制表）与 `@` / `,` / `，` 算；名字字符与换行不算', () => {
    expect([' ', '\u3000', '\t', '@', ',', '，'].map(isSlotOpeningChar)).toEqual([true, true, true, true, true, true]);
    expect(['本', '1', '(', '：', '\n'].map(isSlotOpeningChar)).toEqual([false, false, false, false, false]);
  });
});
