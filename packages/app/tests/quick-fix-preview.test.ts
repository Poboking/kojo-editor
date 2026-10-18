/**
 * P2-14 两件事的宿主侧单测。
 *
 * ① quick fix 预览（`src/ui/quick-fix-preview.ts`）：
 *    - `previewTextFor` 与宿主 `applyTextEdits` 的**对拍**——硬判据是「预览看到的」
 *      必须等于「落下的」。`applyTextEdits` 落在 Monaco model 上，monaco 运行时不进
 *      node（`environment: 'node'`），故 `../src/monaco/entry` 用 `vi.mock` 桩掉
 *      （`Range` 给真类——`applyTextEdits` 构造的 range 要带真实行号字段；
 *      其余命名空间给万能代理桩），editor 给一份「按行 splice」的假实现——它与
 *      Monaco `executeEdits` 在**整行替换 + LF model** 语义下逐字等价（仓内既有做法，
 *      见 `kojo-fix-all.test.ts` 的 fakeDoc 与 `editor-global-providers-tables.test.ts`
 *      的 vi.hoisted + 动态 import）。
 *    - pending 注册表的认领 / 取消 / 顶掉 / 去向账。
 *
 * ② 格式化规则开关（`packages/plugins/kojo-sugar/src/formatter.ts` 的 additive 选项参）：
 *    规则本体的用例本该住在插件包，但本批文件权限只授权这一个新测试文件，
 *    故借住于此（`computeFormatEdits` 经 `@kojo/plugin-kojo-sugar` 公共面导入，
 *    与 `kojo-format-range.test.ts` 同一条 import 路径）。证三条：
 *    缺省 = 全开 = 显式传全开（逐字等价，既有测试零改动即通过的那条根）；
 *    关 fullWidthSpace = U+3000 原样保留；关 indent = 行首写法不动。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FULLWIDTH_SPACE } from '@kojo/plugin-api';
import { computeFormatEdits } from '@kojo/plugin-kojo-sugar';
import type { EditorTextEdit } from '@kojo/plugin-api';

/* ------------------------------ ① previewTextFor 纯函数 ------------------------------ */

import {
  cancelPreview,
  peekPreview,
  previewTextFor,
  pushPreview,
  quickFixPreviewTitle,
  resetQuickFixPreviews,
  takePreview,
} from '../src/ui/quick-fix-preview';

const edit = (fromLine: number, toLine: number, newText: string): EditorTextEdit => ({ fromLine, toLine, newText });

describe('previewTextFor · 行替换纯函数', () => {
  it('空 edits ⇒ 原文逐字返回', () => {
    expect(previewTextFor('a\nb\nc', [])).toBe('a\nb\nc');
  });

  it('单行整行替换 + 多行 newText', () => {
    expect(previewTextFor('a\nb\nc', [edit(2, 2, 'X\nY')])).toBe('a\nX\nY\nc');
  });

  it('区间替换（2..3 一并吃掉）', () => {
    expect(previewTextFor('a\nb\nc\nd', [edit(2, 3, 'Z')])).toBe('a\nZ\nd');
  });

  it('越界行号夹进 1..行数（0 与 999 都不崩）', () => {
    expect(previewTextFor('a\nb\nc', [edit(0, 0, '头')])).toBe('头\nb\nc');
    expect(previewTextFor('a\nb\nc', [edit(99, 99, '尾')])).toBe('a\nb\n尾');
  });

  it('倒置区间夹到 from 之后（to < from 不扩大破坏面）', () => {
    expect(previewTextFor('a\nb\nc', [edit(2, 1, 'Z')])).toBe('a\nZ\nc');
  });

  it('NaN / 小数行号：trunc 落整、NaN 落回 1 / from（与宿主同一口径）', () => {
    expect(previewTextFor('a\nb\nc', [edit(Number.NaN, Number.NaN, '头')])).toBe('头\nb\nc');
    expect(previewTextFor('a\nb\nc\nd', [edit(2.9, 3.9, 'Z')])).toBe('a\nZ\nd');
  });

  it('多条 edits 按最大行号起应用（前面的行号不位移）', () => {
    expect(previewTextFor('1\n2\n3\n4\n5', [edit(1, 1, '一'), edit(4, 4, '四')])).toBe('一\n2\n3\n四\n5');
  });
});

/* ------------------------------ ① 与 applyTextEdits 对拍 ------------------------------ */

const monacoStub = vi.hoisted(() => {
  /** 真 Range：`applyTextEdits` 构造后，假 editor 要读它的行号字段 */
  class Range {
    constructor(
      readonly startLineNumber: number,
      readonly startColumn: number,
      readonly endLineNumber: number,
      readonly endColumn: number,
    ) {}
  }
  /** 万能代理桩：任意属性链可调用 / 可 new（与 tables 测试同款，只是不记账） */
  const callable = (path: string): unknown =>
    new Proxy(function kojoMonacoStub() {}, {
      get: (_t, key) => (typeof key === 'symbol' || key === 'then' ? undefined : callable(`${path}.${String(key)}`)),
      apply: () => ({ dispose: () => undefined }),
      construct: () => ({ stubConstructed: path }),
    });
  return { Range, callable };
});

vi.mock('../src/monaco/entry', () => ({
  Range: monacoStub.Range,
  editor: monacoStub.callable('monaco.editor'),
  languages: monacoStub.callable('monaco.languages'),
  Uri: monacoStub.callable('monaco.Uri'),
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
}));

// 动态 import：保证桩先就位（本模块 import 期就碰 monaco 运行时）
const { applyTextEdits } = await import('../src/ui/editor-global-providers');

/**
 * 假 editor：按行 splice 落 `executeEdits` 的 ops——与 Monaco 在**整行替换 + LF model**
 * 语义下逐字等价（`applyTextEdits` 传来的 range 已是夹取 + 降序后的结果）。
 */
function fakeEditor(text: string): { ed: Parameters<typeof applyTextEdits>[0]; value(): string } {
  const lines = text.length === 0 ? [''] : text.split('\n');
  const model = {
    getLineCount: () => lines.length,
    getLineMaxColumn: (line: number) => (lines[line - 1]?.length ?? 0) + 1,
    getValue: () => lines.join('\n'),
  };
  const ed = {
    getModel: () => model,
    executeEdits: (_src: string, ops: { range: { startLineNumber: number; endLineNumber: number }; text: string }[]) => {
      for (const op of ops) {
        const from = Math.min(Math.max(1, op.range.startLineNumber), lines.length);
        const to = Math.min(Math.max(from, op.range.endLineNumber), lines.length);
        lines.splice(from - 1, to - from + 1, ...op.text.split('\n'));
      }
      return true;
    },
    pushUndoStop: () => undefined,
  } as unknown as Parameters<typeof applyTextEdits>[0];
  return { ed, value: () => lines.join('\n') };
}

describe('对拍 · previewTextFor(原文, edits) === applyTextEdits 落下的', () => {
  /** 同一组输入分别走两条路，逐字相等才算数（预览看到的 = 落下的） */
  function duel(text: string, edits: EditorTextEdit[]): { preview: string; landed: string; ok: boolean } {
    const preview = previewTextFor(text, edits);
    const { ed, value } = fakeEditor(text);
    applyTextEdits(ed, edits);
    return { preview, landed: value(), ok: preview === value() };
  }

  it('常规：两条不相交的整行改写', () => {
    const r = duel('一行\n二行\n三行\n四行', [edit(1, 1, '壹'), edit(3, 4, '叁\n肆')]);
    expect(r.ok).toBe(true);
    expect(r.preview).toBe('壹\n二行\n叁\n肆');
  });

  it('脏坐标：越界 / 倒置 / NaN / 小数同一路夹取，两边仍逐字相等', () => {
    const r = duel('a\nb\nc\nd', [edit(0, 9, '头尾'), edit(3, 2, 'Z'), edit(Number.NaN, Number.NaN, 'N'), edit(2.7, 2.7, 'W')]);
    expect(r.ok).toBe(true);
  });

  it('区间删除语义：to > from 一并吃掉再插入', () => {
    const r = duel('1\n2\n3\n4\n5', [edit(2, 4, 'X')]);
    expect(r.ok).toBe(true);
    expect(r.preview).toBe('1\nX\n5');
  });
});

/* ------------------------------ ① pending 注册表 ------------------------------ */

const entryOf = (paneId: string, actionId: string) => ({
  paneId,
  actionId,
  title: `修复预览：动作 ${actionId}`,
  languageId: 'erb',
  originalText: 'a\nb',
  previewText: 'A\nb',
  edits: [edit(1, 1, 'A')],
});

describe('quick fix pending 注册表 · 认领 / 取消 / 顶掉', () => {
  beforeEach(() => resetQuickFixPreviews());

  it('push → peek 拿得到（peek 不认领，可反复看）；take 认领走即删', () => {
    pushPreview(entryOf('pane-1', 'pane-1:act-1'));
    expect(peekPreview('pane-1')?.actionId).toBe('pane-1:act-1');
    expect(peekPreview('pane-1')?.actionId).toBe('pane-1:act-1');
    expect(takePreview('pane-1:act-1')).toMatchObject({ kind: 'taken' });
    expect(peekPreview('pane-1')).toBeNull();
  });

  it('同一 pane 重复 push = 新顶旧，旧条目进去向账（superseded）', () => {
    pushPreview(entryOf('pane-1', 'pane-1:old'));
    pushPreview(entryOf('pane-1', 'pane-1:new'));
    expect(peekPreview('pane-1')?.actionId).toBe('pane-1:new');
    expect(takePreview('pane-1:old')).toMatchObject({ kind: 'missing', reason: 'superseded' });
    expect(takePreview('pane-1:new')).toMatchObject({ kind: 'taken' });
  });

  it('take 两次：第二次说得出原因（claimed），不静默', () => {
    pushPreview(entryOf('p', 'p:one'));
    takePreview('p:one');
    expect(takePreview('p:one')).toMatchObject({ kind: 'missing', reason: 'claimed' });
  });

  it('取消：条目消失、edits 一个不落；取消后再 take 说出 cancelled', () => {
    pushPreview(entryOf('p', 'p:x'));
    expect(cancelPreview('p:x')).toBe(true);
    expect(peekPreview('p')).toBeNull();
    expect(takePreview('p:x')).toMatchObject({ kind: 'missing', reason: 'cancelled' });
    expect(cancelPreview('p:x')).toBe(false);
  });

  it('从未存在的 actionId ⇒ missing(unknown)；按 paneId 认领的语义 = entry 自带归属', () => {
    expect(takePreview('nowhere:none')).toMatchObject({ kind: 'missing', reason: 'unknown' });
    pushPreview(entryOf('pA', 'pA:a'));
    pushPreview(entryOf('pB', 'pB:b'));
    expect(peekPreview('pA')?.actionId).toBe('pA:a');
    expect(peekPreview('pB')?.actionId).toBe('pB:b');
    takePreview('pB:b');
    expect(peekPreview('pA')?.actionId).toBe('pA:a');
  });

  it('reset 清整表：条目与去向账一并清（拆毁路径不许留悬账）', () => {
    pushPreview(entryOf('p', 'p:r'));
    takePreview('p:r');
    resetQuickFixPreviews();
    expect(peekPreview('p')).toBeNull();
    expect(takePreview('p:r')).toMatchObject({ kind: 'missing', reason: 'unknown' });
  });
});

describe('quickFixPreviewTitle · 中文标题', () => {
  it('带上动作自身的标题（作者面能认出这是哪个修复）', () => {
    expect(quickFixPreviewTitle({ title: '改为语法糖写法' })).toBe('修复预览：改为语法糖写法');
  });
});

/* ------------------------------ ② 格式化规则开关（additive 选项参） ------------------------------ */

const U3000 = FULLWIDTH_SPACE;
/** 样例：全角缩进台词行 / 全角注释行 / 仅含全角空白的行 / 顶层原生直通行（一个字符不许动） */
const RULE_DOC = [
  `　　「早上好。」`, // 行首 2 个 U+3000 → 折成 4 半角
  `;　这是注释`, // 注释区 1 个 U+3000 → 折成 1 半角
  `　`, // 仅含 U+3000 的空白行 → 清空
  `@ISFUNC`, // `@` 起的原生块：整块逐字节进产物，格式化本来就不动
].join('\n');

/** 缩进归一样例：多数派 4 空格 + 一条 tab 缩进（`@` 行会让整块进原生直行区，故不用） */
const MIXED_DOC = ['IF X', '    ; 一', '    ; 二', '\t\t; 三', 'ENDIF'].join('\n');

describe('computeFormatEdits · 规则开关（P2-14 ②）', () => {
  it('缺省 = 显式全开 = 传空对象：三种调用逐字等价（既有测试零改动的根）', () => {
    const a = computeFormatEdits(RULE_DOC, 'kojo');
    const b = computeFormatEdits(RULE_DOC, 'kojo', {});
    const c = computeFormatEdits(RULE_DOC, 'kojo', { fullWidthSpace: true, indent: true });
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a.length).toBeGreaterThan(0); // 样例确实有活干（全角折算 + 空白行清空）
  });

  it('关 fullWidthSpace：含 U+3000 的行一律原样保留（缩进 / 注释 / 全角空白行）', () => {
    const edits = computeFormatEdits(RULE_DOC, 'kojo', { fullWidthSpace: false });
    const lines = RULE_DOC.split('\n');
    // 没有任何一条 edit 碰到含 U+3000 的行
    for (const e of edits) {
      expect(lines[e.line - 1]).not.toContain(U3000);
    }
    // 不含 U+3000 的行的行为与缺省一致（折算关不影响别的规则）
    expect(edits).toEqual(computeFormatEdits(RULE_DOC, 'kojo', { fullWidthSpace: false, indent: true }));
  });

  it('关 fullWidthSpace：半角空白行照旧清空（那不是全角问题）', () => {
    const doc = ['「好。」', '   '].join('\n');
    const edits = computeFormatEdits(doc, 'kojo', { fullWidthSpace: false });
    expect(edits).toEqual([{ line: 2, startColumn: 1, endColumn: 4, text: '' }]);
  });

  it('开 indent（缺省）：少数派 tab 缩进按多数派单位重排', () => {
    const on = computeFormatEdits(MIXED_DOC, 'kojo');
    expect(on).toEqual([{ line: 4, startColumn: 1, endColumn: 6, text: '        ; 三' }]);
  });

  it('关 indent：行首空白写法一个字符不动（少数派 tab 也原样）', () => {
    const off = computeFormatEdits(MIXED_DOC, 'kojo', { indent: false });
    expect(off).toEqual([]);
  });

  it('全关：只含全角空白与缩进差异的文档 ⇒ 零 edits（一个字符都不动）', () => {
    expect(computeFormatEdits(RULE_DOC, 'kojo', { fullWidthSpace: false, indent: false })).toEqual([]);
    expect(computeFormatEdits(MIXED_DOC, 'kojo', { fullWidthSpace: false, indent: false })).toEqual([]);
  });

  it('ERB 形：关 indent 行为不变（ERB 本就没有缩进归一这条）', () => {
    const doc = `PRINTL 甲\n${U3000}${U3000}PRINTL 乙`;
    expect(computeFormatEdits(doc, 'erb', { indent: false })).toEqual(computeFormatEdits(doc, 'erb', {}));
  });
});
