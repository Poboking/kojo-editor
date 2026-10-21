// @vitest-environment happy-dom
/**
 * REPLACE-UNDO · 「替换 / 全部替换」落在**已打开文件**上必须进撤销栈（数据丢失级缺陷的正解）。
 *
 * 改前那两颗 `model.applyEdits(ops)`（`search-replace-exec.ts` 的全部替换腿与单条替换腿）按
 * monaco.d.ts 的原话是「Edit the model **without adding the edits to the undo stack**. This can
 * have dire consequences」——机器改动压根不在栈上：作者按一次 Ctrl+Z 退掉的是**自己上一次打字**，
 * 替换结果留在屏上撤不回。而旧注释写的「一次调用 = 一步撤销」是错的，交付按错口径发生。
 *
 * 正解＝`pushStackElement()` → `pushEditOperations(null, ops, () => null)` → `pushStackElement()`
 * （与 `disk-text-sync.applyDiskText` 同一条通道，2026-10-21 重载保栈那批的同款停点判据）。
 * 产品口径：**替换在栈上自成一段**——一次 Ctrl+Z 只退替换、作者的打字留下；
 * **不许**退化成「并进作者那一格」（少了 before 停点就会这样，`EditStack.canAppend` 判据）。
 *
 * 证据分工：①②③＝**真 monaco model** 的撤销栈读数（不是假件——假件只能证明"调了哪个方法"，
 * 证不了"栈上有几段"）；④＝机理反证，钉住改前那条路为什么必然红。
 * `search-replace-exec.test.ts` / `-xlang.test.ts` 那两枚假 model 上的停点计数只是同一条通道的
 * 接线取证，真身判据在本文件。
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as monaco from '../src/monaco/entry';
import { createFileReplaceRunner, type FileReplaceDeps } from '../src/ui/search-replace-exec';
import type { ReplaceRequest } from '../src/ui/search-store';

const PATH = 'C:/p/ERB/open.ERB';
/** 未替换的正文（作者打字前） */
const BASE = 'CALL FOO\nPRINTL FOO\n';

const models: monaco.editor.ITextModel[] = [];
let seq = 0;
function makeModel(text: string): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(text, 'plaintext', monaco.Uri.parse(`inmemory://replace-undo/${++seq}`));
  models.push(model);
  return model;
}

/** 作者打字的 model 层等价通道（真壳里是编辑器键入，落栈同一条路；同 reload-undo-keep 口径） */
function authorTyping(model: monaco.editor.ITextModel, line: number, column: number, typed: string): void {
  model.pushEditOperations(null, [{ range: new monaco.Range(line, column, line, column), text: typed }], () => null);
}

function ioOf(): FileReplaceDeps['io'] & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    isWritable: () => true,
    readText: async () => ({ text: BASE }),
    writeText: async (path: string) => {
      writes.push(path);
    },
  };
}

function runnerFor(model: monaco.editor.ITextModel, io: FileReplaceDeps['io']) {
  // 注入 modelFor ⇒ 本用例只验活面腿的落栈形态，不碰 Monaco 注册表（也不碰盘）
  return createFileReplaceRunner({ io, modelFor: (p) => (p === PATH ? model : undefined) });
}

const allRequest = (query = 'FOO'): ReplaceRequest =>
  ({
    query,
    replaceText: 'BAR',
    options: { isRegex: false, caseSensitive: false, wholeWord: true },
    mode: { kind: 'all' },
    files: [{ path: PATH, matches: [{ line: 1, column: 6, preview: 'CALL FOO', start: 5, end: 8 }] }],
  }) as ReplaceRequest;

const oneRequest: ReplaceRequest = {
  query: 'FOO',
  replaceText: 'BAR',
  options: { isRegex: false, caseSensitive: false, wholeWord: true },
  mode: { kind: 'one', target: { path: PATH, line: 1, column: 6 } },
  files: [{ path: PATH, matches: [{ line: 1, column: 6, preview: 'CALL FOO', start: 5, end: 8 }] }],
};

afterEach(() => {
  for (const model of models.splice(0)) if (!model.isDisposed()) model.dispose();
});

describe('①全部替换腿：在真 monaco model 上自成一段', () => {
  it('一次 Ctrl+Z 只退替换，作者打字留下；第二次才退到打字（改前 = 反过来了）', async () => {
    const model = makeModel(BASE);
    authorTyping(model, 1, 9, ' // 手记'); // 行尾打字（真壳里就是光标停在行尾敲的字）
    const beforeReplace = model.getValue();
    expect(beforeReplace).toBe('CALL FOO // 手记\nPRINTL FOO\n');

    const io = ioOf();
    const out = await runnerFor(model, io)(allRequest());
    expect(out.applied).toBe(2); // 全字匹配：两行各一处（现文本重扫，检索结果只是预览）
    expect(out.errors).toEqual([]);
    expect(model.getValue()).toBe('CALL BAR // 手记\nPRINTL BAR\n');
    expect(io.writes).toEqual([]); // 活面一条盘都不写

    expect(model.canUndo()).toBe(true);
    model.undo(); // ← 作者按下 Ctrl+Z 的那一下
    expect(model.getValue()).toBe(beforeReplace); // 退掉的只有替换
    expect(model.canUndo()).toBe(true);
    model.undo(); // 这才轮到作者自己的打字
    expect(model.getValue()).toBe(BASE);
  });

  it('替换段在栈上恰好一段：打字 → 替换 → 重打 → 三连撤销逐步退回，不多吞一段', async () => {
    const model = makeModel(BASE);
    authorTyping(model, 1, 9, 'A');
    const afterA = model.getValue();
    const io = ioOf();
    await runnerFor(model, io)(allRequest());
    const afterReplace = model.getValue();
    authorTyping(model, 2, 11, 'B');
    const afterB = model.getValue();

    model.undo();
    expect(model.getValue()).toBe(afterReplace); // 只退后打的字
    model.undo();
    expect(model.getValue()).toBe(afterA); // 只退替换（替换没并进 A 那一格，也没吞掉 A）
    model.undo();
    expect(model.getValue()).toBe(BASE); // 只退先打的字
  });

  it('零命中 ⇒ 一次编辑都不发、一个停点都不打（栈上不多占空段，一次撤销仍退回打字）', async () => {
    const model = makeModel(BASE);
    authorTyping(model, 1, 9, 'A');
    const afterTyping = model.getAlternativeVersionId();
    const io = ioOf();
    const out = await runnerFor(model, io)(allRequest('NOPE'));
    expect(out.applied).toBe(0);
    expect(model.getAlternativeVersionId()).toBe(afterTyping); // 版本号不动 = 压根没编辑
    expect(model.getValue()).toBe('CALL FOOA\nPRINTL FOO\n');
    model.undo();
    expect(model.getValue()).toBe(BASE); // 没有空段挡在中间
    expect(io.writes).toEqual([]);
  });
});

describe('②单条替换腿：同样必须上栈（同一条通道，不许漏第二颗）', () => {
  it('一次 Ctrl+Z 只退这一处替换；第二处 FOO 与作者打字都不动', async () => {
    const model = makeModel(BASE);
    authorTyping(model, 2, 11, '!');
    const beforeReplace = model.getValue();
    expect(beforeReplace).toBe('CALL FOO\nPRINTL FOO!\n');

    const io = ioOf();
    const out = await runnerFor(model, io)(oneRequest);
    expect(out).toMatchObject({ applied: 1, filesChanged: 1, stale: 0 });
    expect(model.getValue()).toBe('CALL BAR\nPRINTL FOO!\n'); // 只落点中的那一处
    expect(io.writes).toEqual([]);

    model.undo();
    expect(model.getValue()).toBe(beforeReplace); // 单条替换自成一段
    expect(model.canUndo()).toBe(true);
    model.undo();
    expect(model.getValue()).toBe(BASE);
  });
});

describe('③机理反证：applyEdits 为什么必然把作者打字退掉', () => {
  it('真 model 上 applyEdits 不进栈 ⇒ 一次 undo 退的是打字，机器改动留在屏上撤不回', () => {
    const model = makeModel('CALL FOO\n');
    authorTyping(model, 1, 9, 'ZZ');
    expect(model.getValue()).toBe('CALL FOOZZ\n');
    model.applyEdits([{ range: new monaco.Range(1, 6, 1, 9), text: 'BAR' }]); // 改前那条路
    expect(model.getValue()).toBe('CALL BARZZ\n');

    model.undo(); // 退掉的是自己的 ZZ
    expect(model.getValue()).toBe('CALL BAR\n');
    expect(model.canUndo()).toBe(false); // 机器改动压根不在栈上 = 撤不回（缺陷成因）
  });
});
