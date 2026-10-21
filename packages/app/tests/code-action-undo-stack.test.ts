// @vitest-environment happy-dom
/**
 * CODEACTION-UNDO-STACK（2026-10-21）：💡 快速修复 / code action 的落地通道必须**前后各一颗停点**。
 *
 * ## 缺陷（真壳读数，改前）
 * `ui/editor-global-providers.ts` 的 `applyTextEdits` 只有**后停点**：
 * ```
 * ed.executeEdits('kojo.codeAction', ops);
 * ed.pushUndoStop();
 * ```
 * monaco-editor 0.57.0 里 `executeEdits` 这条路**全程不 `pushStackElement`**
 * （`esm/vs/editor/standalone/browser/standaloneCodeEditor.js`→`codeEditorWidget.js:937`
 * → `viewModelImpl.js:962` → `cursor.js:371`；带停点的只有 `_executeEditOperation`，
 * `cursor.js:286/308`）⇒ 作者上一次打字那格还"开着"，`EditStack` 的 `canAppend` 把机器改写
 * **并进同一格**：作者按一次 Ctrl+Z 同时退掉"自己刚打的字 + 机器改写"。
 *
 * ## 本批口径
 * 只在**这条 5 个消费方共用的开口**上补前停点（事后那颗保留），口径照 `disk-text-sync.applyDiskText`
 * （前后各一次停点）。消费方零改动即全批受益：同文件 `kojo.codeAction.run`（经预览 →
 * `applyQuickFixEdits`）／预览「应用修复」`applyQuickFixEdits`／一键修复 `runFixAll` 的**每一轮**
 * （`EditorPane.tsx:2138` 的 `apply: (edits) => applyTextEdits(ed, edits)`）／
 * `problem-fix-apply.ts:41`／`shell-overlays.ts:201`。
 *
 * ## 证据分工（沿用 `save-warning-undo.test.ts`）
 * ①②③④＝**真 monaco model 的撤销栈行为**：栈（`EditStack`）住在 model 上，故 editor 给一层
 * 转发桩即可——`executeEdits`→`model.pushEditOperations`（与真路同为"不推停点"）、
 * `pushUndoStop`→`model.pushStackElement`（与真路 `viewModelImpl.pushUndoStop` 同一调用）。
 * 文本落点因此也是真 monaco 的区间语义，不靠假件 splice。
 * ⑤＝`applyTextEdits` **接线**截源码断言（钉"前停点在 executeEdits 之前"这条结构，删掉即红）。
 * 真壳未验（本批不起桌面壳）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as monaco from '../src/monaco/entry';
import { applyTextEdits } from '../src/ui/editor-global-providers';
import type { EditorTextEdit } from '@kojo/plugin-api';

const SOURCE = readFileSync(
  path.resolve(import.meta.dirname, '..', 'src', 'ui', 'editor-global-providers.ts'),
  'utf8',
);

const edit = (fromLine: number, toLine: number, newText: string): EditorTextEdit => ({ fromLine, toLine, newText });

/** 作者初始文本（第 2 行是机器改写的靶子行） */
const BASE = '甲\n乙\n丙';

const models: monaco.editor.ITextModel[] = [];
let seq = 0;
function makeModel(text: string): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(
    text,
    'plaintext',
    monaco.Uri.parse(`inmemory://code-action-undo-stack/${++seq}`),
  );
  models.push(model);
  return model;
}

/**
 * editor 转发桩：只把 `applyTextEdits` 真用的三个方法接到**真 model** 上。
 * 撤销栈由 model 持有 ⇒ 格数/并格行为与真编辑器同一条路（真路同样不调 `pushStackElement`）。
 */
function editorOf(model: monaco.editor.ITextModel): Parameters<typeof applyTextEdits>[0] {
  return {
    getModel: () => model,
    executeEdits: (_source: string, operations: monaco.editor.IIdentifiedSingleEditOperation[]) =>
      model.pushEditOperations(null, operations, () => null) !== null,
    pushUndoStop: () => model.pushStackElement(),
  } as unknown as Parameters<typeof applyTextEdits>[0];
}

/** 作者打一个字：真壳里是键入，落栈同一条路，**不补停点 ⇒ 栈顶那格开着** */
function authorTyping(model: monaco.editor.ITextModel, typed: string, line = 1): void {
  model.pushEditOperations(
    null,
    [{ range: new monaco.Range(line, model.getLineMaxColumn(line), line, model.getLineMaxColumn(line)), text: typed }],
    () => null,
  );
}

/**
 * 改前那条旧通道的等价模拟：整批改写 + **只有后停点**（本批不保留、只作机理取证）。
 * 用途＝反向自证锚：证明"缺前停点 ⇒ 机器改写并进作者那格"这个机理本身在真 model 上成立，
 * 于是①的红确实是前停点带来的，不是假件凑的。
 */
function legacyChannelWithoutFrontStop(
  model: monaco.editor.ITextModel,
  operations: monaco.editor.IIdentifiedSingleEditOperation[],
): void {
  model.pushEditOperations(null, operations, () => null);
  model.pushStackElement(); // 只有 after：作者那格没封口 ⇒ 机器编辑并进同一格
}

afterEach(() => {
  for (const model of models.splice(0)) if (!model.isDisposed()) model.dispose();
});

describe('①一次 Ctrl+Z 只退机器改写（前停点的行为面）', () => {
  it('打字 → applyTextEdits ⇒ 第一次撤销只退改写、作者那一笔仍在屏上；第二次才退作者', async () => {
    const model = makeModel(BASE);
    const ed = editorOf(model);

    authorTyping(model, 'Z');
    const afterTyping = model.getValue();
    expect(afterTyping).toBe('甲Z\n乙\n丙');

    expect(applyTextEdits(ed, [edit(2, 2, '二')])).toBe(true);
    const afterMachine = model.getValue();
    expect(afterMachine).toBe('甲Z\n二\n丙');

    await model.undo(); // 第一次 Ctrl+Z
    expect(model.getValue()).toBe(afterTyping); // 只退机器改写
    expect(model.getValue()).toContain('Z'); // 作者那一笔完好 = 缺陷不再复发

    await model.undo(); // 第二次才轮到作者自己
    expect(model.getValue()).toBe(BASE);
    expect(model.getValue()).not.toContain('Z');
  });

  it('机理取证（反向自证锚）：缺前停点的旧通道 ⇒ 第一次撤销连作者打字一起吞', async () => {
    const model = makeModel(BASE);
    authorTyping(model, 'Z');
    expect(model.getValue()).toBe('甲Z\n乙\n丙');

    legacyChannelWithoutFrontStop(model, [
      { range: new monaco.Range(2, 1, 2, model.getLineMaxColumn(2)), text: '二' },
    ]);
    expect(model.getValue()).toBe('甲Z\n二\n丙');

    await model.undo(); // 改前真壳读数：一次 Ctrl+Z 把打字和改写一并撤掉
    expect(model.getValue()).not.toContain('Z'); // 并格 ⇒ 打字没了 = 缺陷本身被钉住
  });
});

describe('②一键修复的每一轮各占一格（runFixAll 多轮不互相吞）', () => {
  it('打字 → 第 1 轮 → 第 2 轮 ⇒ 撤销三次依次退第 2 轮 / 第 1 轮 / 打字，一轮都不并', async () => {
    const model = makeModel(BASE);
    const ed = editorOf(model);

    authorTyping(model, 'Z', 3);
    const typed = model.getValue();
    expect(typed).toBe('甲\n乙\n丙Z');

    expect(applyTextEdits(ed, [edit(2, 2, '二')])).toBe(true); // 第 1 轮
    const round1 = model.getValue();
    expect(round1).toBe('甲\n二\n丙Z');

    expect(applyTextEdits(ed, [edit(1, 1, '壹'), edit(3, 3, '三')])).toBe(true); // 第 2 轮（多段＝一次撤销步）
    const round2 = model.getValue();
    expect(round2).toBe('壹\n二\n三');

    await model.undo();
    expect(model.getValue()).toBe(round1); // 只退第 2 轮，且第 2 轮内部两段一起退（单次 executeEdits 不变）
    await model.undo();
    expect(model.getValue()).toBe(typed); // 这才退第 1 轮；打字仍完好
    expect(model.getValue()).toContain('Z');
    await model.undo();
    expect(model.getValue()).toBe(BASE); // 打字自己的格最后才动
  });
});

describe('③既有语义零改动（夹取 / 降序 / 空差量不占格）', () => {
  it('陈旧行号照样夹取不崩、多段仍合成一个撤销步', async () => {
    const model = makeModel(BASE);
    const ed = editorOf(model);
    expect(applyTextEdits(ed, [edit(99, 99, '尾'), edit(0, 0, '头')])).toBe(true);
    expect(model.getValue()).toBe('头\n乙\n尾'); // 前停点没动行号口径：降序 + 夹取原样
    await model.undo();
    expect(model.getValue()).toBe(BASE); // 两段一起退 = 仍是一格
  });

  it('空 edits / 无 model ⇒ 返回 false 且不占栈位（前停点不在这里白推）', () => {
    const model = makeModel(BASE);
    const ed = editorOf(model);
    const undoableBefore = model.canUndo();
    expect(applyTextEdits(ed, [])).toBe(false);
    expect(model.canUndo()).toBe(undoableBefore); // 一条格都没多
    expect(
      applyTextEdits({ getModel: () => null } as unknown as Parameters<typeof applyTextEdits>[0], [edit(1, 1, '一')]),
    ).toBe(false);
    expect(model.canUndo()).toBe(undoableBefore);
    expect(model.getValue()).toBe(BASE);
  });
});

describe('④预览「应用修复」那条腿拿的是同一个开口（消费方不抄第二套）', () => {
  it('problem-fix-apply / shell-overlays / EditorPane 的一键修复都落到 applyTextEdits', () => {
    const read = (rel: string) => codeOf(readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8'));
    expect(read('src/ui/problem-fix-apply.ts')).toContain('applyTextEdits(ed, planned)');
    expect(read('src/ui/shell-overlays.ts')).toContain('m.applyQuickFixEdits(actionId)');
    expect(read('src/ui/EditorPane.tsx')).toContain('apply: (edits) => applyTextEdits(ed, edits)');
    // 开口只有一个：applyQuickFixEdits 与 code action 落地腿都指向 applyTextEdits，不另起 executeEdits
    const providers = codeOf(SOURCE);
    expect(providers.match(/ed\.executeEdits\(/g)?.length).toBe(1);
    expect(providers).toContain('return applyTextEdits(ed, entry.edits);');
  });
});

describe('⑤接线钉子：前停点在 executeEdits **之前**（删掉即红）', () => {
  it('applyTextEdits 体内 pushUndoStop 出现两次，且第一次先于 executeEdits', () => {
    const body = sliceBetween('export function applyTextEdits(', '\n}\n', SOURCE);
    const first = body.indexOf('ed.pushUndoStop()');
    const editsAt = body.indexOf("ed.executeEdits('kojo.codeAction'");
    const last = body.lastIndexOf('ed.pushUndoStop()');
    expect(first, 'applyTextEdits 里没有前停点').toBeGreaterThanOrEqual(0);
    expect(editsAt).toBeGreaterThan(first); // 前停点确在改写之前
    expect(last).toBeGreaterThan(editsAt); // 后停点保留（事后封口不许丢）
    expect(body.match(/ed\.pushUndoStop\(\)/g)?.length).toBe(2);
  });
});

/** 截 `start` 到其后第一次出现的 `end`（找不到即测试失败，绝不静默给空串） */
function sliceBetween(start: string, end: string, source: string): string {
  const from = source.indexOf(start);
  expect(from, `找不到起点：${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `找不到终点：${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

/** 纯代码面（剥掉整行注释与块注释）：源码针只钉**代码**，注释里提到方法名不该把针弄红/弄绿 */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}
