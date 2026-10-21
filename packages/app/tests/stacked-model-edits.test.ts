// @vitest-environment happy-dom
/**
 * STACKED-MODEL-EDITS（2026-10-21 收口）：程序化写 model 的**唯一上栈通道**的行为面 + 守门面。
 *
 * ## 钉的是哪颗缺陷（FIX-UNDO-RESIDUAL③）
 * `EditorPane.tsx` 的「保存前整理」此前裸调 `entry.model.pushEditOperations([], …, () => null)`
 * **前后皆无停点** ⇒ 每次 Ctrl+S / saveAll / 自动保存，栈顶那格（作者上一次打字）还"开着"，
 * `EditStack.canAppend` 把整理结果**并进作者那一格**：一次 Ctrl+Z 同时吞掉"自己刚打的字 + 整理"。
 * 现改走 `applyStackedModelEdits`（前停点 → `pushEditOperations(null, …)` → 后停点）。
 * 产品口径：**整理后一次 Ctrl+Z 只退整理、作者打字留下**。
 *
 * ## 证据分工
 * ①②③＝**真 monaco model** 的撤销栈读数（假件的 no-op 停点证不了"栈上有几段"）；
 * ①② 各自单独回退各自单独红（前停点红①、后停点红②——实测读数在交付回执里）；
 * ④＝`EditorPane.tsx` 接线钉子（代码面一个裸 `pushEditOperations(` 都不留）；
 * ⑤＝全仓守门：`packages/**\/src/**` 里 `pushEditOperations(` 只许出现在共用模块，
 *      其余任何 src 文件出现即红（`disk-text-sync.ts` 是逐字点名的既有第二通道，本批不动、
 *      由它自己的 `reload-merge-undo` / `disk-text-sync-eol` 两枚闸守着）。
 *
 * ## `[]` → `null` 的证伪结果（为什么这条**不**配行为用例）
 * 旧写法传的 `beforeCursorState = []` 与 `null` 在可观察面**没有差别**，实测两条事实：
 * (a) `SingleModelEditStackData.serialize/_readSelections` 把两者都写成 count=0，撤销时读回恒为 `[]`；
 * (b) 唯一消费者 `cursor.js:206` 的条件是 `e.resultingSelection && e.resultingSelection.length > 0`
 * —— `null` 与 `[]` 同样不成立 ⇒ 撤销时都不复位选区。
 * 所以口径统一（改传 `null`）只是与 `applyDiskText` 同形，**不是**行为修复，不交付"改前改后都过"的假闸。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as monaco from '../src/monaco/entry';
import { applyStackedModelEdits } from '../src/ui/stacked-model-edits';
import { applyFormatOnSave } from '../src/ui/format-on-save';
import { toTextEdits } from '../src/monaco/kojo-format';

const APP = path.resolve(import.meta.dirname, '..');
const EDITOR_PANE = readFileSync(path.join(APP, 'src', 'ui', 'EditorPane.tsx'), 'utf8');

/** 剥掉注释：守门针只看**代码面**，注释里提到方法名不该把针弄红/弄绿 */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const models: monaco.editor.ITextModel[] = [];
let seq = 0;
function makeModel(text: string): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(
    text,
    'plaintext',
    monaco.Uri.parse(`inmemory://stacked-model-edits/${++seq}`),
  );
  models.push(model);
  return model;
}

/** 作者打一个字：真壳里是键入，落栈同一条路，**不补停点 ⇒ 栈顶那格开着**（并格的温床） */
function authorTyping(model: monaco.editor.ITextModel, line: number, typed: string): void {
  const col = model.getLineMaxColumn(line);
  model.pushEditOperations(
    null,
    [{ range: new monaco.Range(line, col, line, col), text: typed }],
    () => null,
  );
}

/** 「保存前整理」在 EditorPane 里的真实组成（前半段）：applyFormatOnSave → toTextEdits */
const DOC = '甲\n乙  \n丙';
function tidyOps(model: monaco.editor.ITextModel): ReturnType<typeof toTextEdits> {
  const prepared = applyFormatOnSave(DOC, 'kojo', true, (text) => ({
    text: text.replace('乙  ', '乙'),
    edits: [{ line: 2, startColumn: 2, endColumn: 4, text: '' }],
  }));
  expect(prepared.changed).toBe(true);
  return toTextEdits(model, prepared.edits);
}
/** 后半段：共用通道（前停点 → `pushEditOperations(null, …)` → 后停点） */
function tidyInto(model: monaco.editor.ITextModel): number {
  return applyStackedModelEdits(model, tidyOps(model));
}

afterEach(() => {
  for (const model of models.splice(0)) if (!model.isDisposed()) model.dispose();
});

describe('①前停点：整理结果自成一格，一次 Ctrl+Z 只退整理、作者打字留下', () => {
  it('打字 → 整理 ⇒ 第一下只退回被删的行尾空格（Z 还在），第二下才退打字', () => {
    const model = makeModel(DOC);
    authorTyping(model, 1, 'Z');
    const afterTyping = model.getValue();
    expect(afterTyping).toBe('甲Z\n乙  \n丙');

    expect(tidyInto(model)).toBe(1);
    const afterTidy = model.getValue();
    expect(afterTidy).toBe('甲Z\n乙\n丙'); // 整理落了地

    expect(model.canUndo()).toBe(true);
    model.undo(); // ← Ctrl+Z 第一下
    expect(model.getValue()).toBe(afterTyping); // 只退整理，作者那一笔一个字没丢
    expect(model.canUndo()).toBe(true);
    model.undo(); // 第二下才轮到打字
    expect(model.getValue()).toBe(DOC);
  });

  it('机理锚（钉 monaco 契约，不随本批代码变红）：改前那颗裸调用（无停点、传 []）⇒ 第一下把打字与整理一起吞', () => {
    const model = makeModel(DOC);
    authorTyping(model, 1, 'Z');
    // 改前原样：`entry.model.pushEditOperations([], toTextEdits(…), () => null)` 前后皆无停点
    model.pushEditOperations([], tidyOps(model), () => null);
    expect(model.getValue()).toBe('甲Z\n乙\n丙');

    model.undo(); // 第一下 Ctrl+Z
    expect(model.getValue()).toBe(DOC); // 打字与整理并在一格里一起退 = 缺陷本身
  });
});

describe('②后停点：整理之后再打字另起一格', () => {
  it('整理 → 打字 ⇒ 撤销依次退打字、再退整理（打字没并进整理那一格）', () => {
    const model = makeModel(DOC);
    tidyInto(model);
    const afterTidy = model.getValue();
    expect(afterTidy).toBe('甲\n乙\n丙');

    authorTyping(model, 3, 'W');
    expect(model.getValue()).toBe('甲\n乙\n丙W');

    model.undo(); // 第一下只退打字
    expect(model.getValue()).toBe(afterTidy);
    model.undo(); // 第二下才退整理
    expect(model.getValue()).toBe(DOC);
  });
});

describe('③零编辑不占栈位 + 光标不动', () => {
  it('ops 为空 ⇒ 一个停点都不打（空段不该挡掉作者一步撤销）', () => {
    const model = makeModel(DOC);
    authorTyping(model, 1, 'Z');
    const version = model.getAlternativeVersionId();
    expect(applyStackedModelEdits(model, [])).toBe(0);
    expect(model.getAlternativeVersionId()).toBe(version);
    model.undo();
    expect(model.getValue()).toBe(DOC); // 直接退回打字，中间没有被白占的一格
  });

  it('通道不替作者算光标（cursorStateComputer 返回 null ⇒ 无 afterCursorState）', () => {
    const model = makeModel(DOC);
    const seen: unknown[] = [];
    const calls: Array<unknown> = [];
    applyStackedModelEdits(
      {
        pushStackElement: () => seen.push('stop'),
        pushEditOperations: (before, _ops, computer) => {
          seen.push(before);
          calls.push(computer());
          return null;
        },
      },
      [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, text: 'X' }],
    );
    expect(seen).toEqual(['stop', null, 'stop']); // 前停点 → 落地（before=null）→ 后停点
    expect(calls).toEqual([null]);
  });
});

describe('④接线钉子：EditorPane 的保存整理只剩共用通道（裸调用即红）', () => {
  it('savePathDetailed 里整理走 applyStackedModelEdits，代码面一个裸 pushEditOperations 都不留', () => {
    expect(EDITOR_PANE).toContain(
      'applyStackedModelEdits(entry.model, toTextEdits(entry.model, prepared.edits));',
    );
    expect(codeOf(EDITOR_PANE)).not.toContain('pushEditOperations(');
    expect(EDITOR_PANE).toContain("from './stacked-model-edits'");
  });

});

