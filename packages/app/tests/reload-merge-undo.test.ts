// @vitest-environment happy-dom
/**
 * RELOAD-MERGE-UNDO · 合并腿保撤销栈（看板 RELOAD-MERGE-UNDO 行判据逐字对齐）。
 *
 * ## 取证（改前代码事实）
 * `packages/app/src/ui/EditorPane.tsx` 的 `reloadFromDisk` 里，`decision.kind === 'merge'` 那条腿
 * （作者有未保存改动 + 两侧各改各的）落地走 `live.model.setValue(decision.text)`；
 * monaco-editor 0.57.0 `esm/vs/editor/common/model/textModel.js:343`（`_setValueFromTextBuffer`）
 * 明写 `this._commandManager.clear()` ⇒ 整条撤销栈就地销毁：作者的未保存历史（本次合并前的全部打字）
 * 一次合并全清光，且这条腿**故意不落基线**（合并结果仍"未保存"），撤不回去＝数据丢失级。
 * RELOAD-UNDO-KEEP（`f2738ad7`）只换了干净重载那条腿，merge 那条在其交付正文里被点名为残余。
 *
 * ## 本批口径
 * 只换"怎么写进 model"：合并结果的算法（`decideExternalChange` / `mergeExternalChange` /
 * `openExternalChangeDiff`）与通知文案**一字不动**；落地改走 `applyDiskText`（与重载腿同一停点口径：
 * 合并结果在栈上恰好占**一个**元素，一次 Ctrl+Z 回到作者改动）。
 *
 * 证据分工沿用 `reload-undo-keep.test.ts`：①②＝真 monaco model 行为；③④＝`EditorPane` 接线截源码断言
 * （本仓 React 组件无法在 happy-dom 渲染）；⑤＝机理取证（setValue 必清栈）。
 * 真壳未验（并发抢 9222，本批按组长闸协议由单测/桩证明）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as monaco from '../src/monaco/entry';
import { applyDiskText } from '../src/ui/disk-text-sync';
import { decideExternalChange, mergeExternalChange } from '../src/ui/external-change';

const SOURCE = readFileSync(
  path.resolve(import.meta.dirname, '..', 'src', 'ui', 'EditorPane.tsx'),
  'utf8',
);

/** 截 `start` 到其后第一次出现的 `end`（找不到即测试失败，绝不静默给空串） */
function sliceBetween(start: string, end: string, source = SOURCE): string {
  const from = source.indexOf(start);
  expect(from, `找不到起点：${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `找不到终点：${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

/** merge 那条腿的闭包体（从分支头到冲突计数为止；与重载腿 applyReload 互不重叠） */
const MERGE_BRANCH = sliceBetween(
  "if (typeof decision === 'object' && decision.kind === 'merge')",
  '\n      const clashCount',
);

/**
 * 纯代码面（剥掉整行注释与块注释）：源码针只钉**代码**——注释里说明"改前这里是 setValue"
 * 不该把"不许再用 setValue"这条针弄红。
 */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}
const MERGE_BRANCH_CODE = codeOf(MERGE_BRANCH);

/** 保存基线（作者 Ctrl+S 成功那一刻的盘上内容） */
const BASE = '头行\n乙\n丙\n丁\n';
/** 盘上真相：外部程序只改了第 1 行 */
const DISK = '外部程序改写\n乙\n丙\n丁\n';

const models: monaco.editor.ITextModel[] = [];
let seq = 0;
function makeModel(text: string, eol?: monaco.editor.EndOfLineSequence): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(
    text,
    'plaintext',
    monaco.Uri.parse(`inmemory://reload-merge-undo/${++seq}`),
  );
  if (eol !== undefined) model.setEOL(eol);
  models.push(model);
  return model;
}
/** 作者打字的 model 层等价通道（真壳里是编辑器键入，落栈同一条路） */
function authorTyping(model: monaco.editor.ITextModel, line: number, column: number, typed: string): void {
  model.pushEditOperations(
    null,
    [{ range: new monaco.Range(line, column, line, column), text: typed }],
    () => null,
  );
}

afterEach(() => {
  for (const model of models.splice(0)) if (!model.isDisposed()) model.dispose();
});

describe('①merge 后一次 Ctrl+Z 回到作者改动（判据 1）', () => {
  it('决策仍是 merge（两侧各改各的 ⇒ 不许退化成 conflict），落地后屏上＝合并结果', () => {
    const model = makeModel(BASE);
    authorTyping(model, 4, 2, 'AUTH_A1'); // 作者在第 4 行末打字（未保存）
    const authorText = model.getValue();
    const decision = decideExternalChange(authorText, DISK, true, BASE);
    expect(decision).toEqual({ kind: 'merge', text: expect.any(String) });
    if (typeof decision === 'object' && decision.kind === 'merge') {
      expect(applyDiskText(model, decision.text)).toBe(1);
      expect(model.getValue()).toBe(decision.text);
      // 两份改动都还在（合并结果的不变量，防"磁盘赢"把作者改动洗掉）
      expect(model.getValue()).toContain('AUTH_A1');
      expect(model.getValue()).toContain('外部程序改写');
    }
  });

  it('一次撤销＝只退合并，退回作者改动（改前：撤销栈已被 setValue 清空）', () => {
    const model = makeModel(BASE);
    authorTyping(model, 4, 2, 'AUTH_A1');
    const authorText = model.getValue();
    const decision = decideExternalChange(authorText, DISK, true, BASE);
    if (typeof decision !== 'object' || decision.kind !== 'merge') throw new Error('决策树口径变了');
    applyDiskText(model, decision.text);

    expect(model.canUndo()).toBe(true);
    model.undo(); // 判据：只按一次
    expect(model.getValue()).toBe(authorText);
    expect(model.getValue()).toContain('AUTH_A1');
    expect(model.getValue()).not.toContain('外部程序改写');
  });

  it('合并在栈上只占一个元素：第二次撤销才动到作者打字（不留两段）', () => {
    const model = makeModel(BASE);
    authorTyping(model, 4, 2, 'AUTH_A1');
    const authorText = model.getValue();
    const decision = decideExternalChange(authorText, DISK, true, BASE);
    if (typeof decision !== 'object' || decision.kind !== 'merge') throw new Error('决策树口径变了');
    applyDiskText(model, decision.text);

    model.undo();
    expect(model.getValue()).toBe(authorText);
    expect(model.canUndo()).toBe(true);
    model.undo(); // 这才轮到作者自己的打字
    expect(model.getValue()).toBe(BASE);
  });

  it('作者打字前栈顶已封口（编辑器打过停点）⇒ 停点不造空元素，一次撤销仍只退合并', () => {
    const model = makeModel(BASE);
    authorTyping(model, 4, 2, 'AUTH_A1');
    model.pushStackElement();
    const authorText = model.getValue();
    const decision = decideExternalChange(authorText, DISK, true, BASE);
    if (typeof decision !== 'object' || decision.kind !== 'merge') throw new Error('决策树口径变了');
    applyDiskText(model, decision.text);
    model.undo();
    expect(model.getValue()).toBe(authorText);
  });

  it('合并结果与当前内容逐字相等 ⇒ 零编辑、栈一位都不多占（不白占撤销格）', () => {
    const model = makeModel(DISK);
    expect(applyDiskText(model, DISK)).toBe(0);
    expect(model.canUndo()).toBe(false);
  });
});

describe('②合并结果逐字等于原决策树产出（判据 2：只换落地，不换算分法）', () => {
  it('applyDiskText 落地结果与 model.setValue(同一段文本) 逐字同果（含 EOL 归一）', () => {
    const model = makeModel(BASE);
    authorTyping(model, 4, 2, 'AUTH_A1');
    const authorText = model.getValue();
    const decision = decideExternalChange(authorText, DISK, true, BASE);
    if (typeof decision !== 'object' || decision.kind !== 'merge') throw new Error('决策树口径变了');

    const baseline = makeModel(authorText); // 改前那条腿：setValue 落地
    baseline.setValue(decision.text);
    applyDiskText(model, decision.text); // 改后这条腿：差量落地

    expect(model.getValue()).toBe(baseline.getValue());
    expect(model.getValue()).toBe(decision.text);
    expect(model.getEOL()).toBe(baseline.getEOL());
  });

  it('CRLF model / LF 盘：差量落地与 setValue 同果，行尾一个字节都不差', () => {
    const crlfBase = BASE.replace(/\n/g, '\r\n');
    const crlfDisk = DISK.replace(/\n/g, '\r\n');
    const model = makeModel(crlfBase, monaco.editor.EndOfLineSequence.CRLF);
    authorTyping(model, 4, 2, 'AUTH_A1');
    const authorText = model.getValue();
    const decision = decideExternalChange(authorText, crlfDisk, true, crlfBase);
    if (typeof decision !== 'object' || decision.kind !== 'merge') throw new Error('决策树口径变了');

    const baseline = makeModel(authorText, monaco.editor.EndOfLineSequence.CRLF);
    baseline.setValue(decision.text);
    applyDiskText(model, decision.text);
    expect(model.getValue()).toBe(baseline.getValue());
    // 未混入裸 LF：每个 \n 前面都必须跟着 \r（model EOL 约定与 setValue 同果）
    const newlines = model.getValue().split('\n').length - 1;
    const crlf = model.getValue().split('\r\n').length - 1;
    expect(newlines).toBe(crlf);
  });

  it('决策树本身零改动：merge 文本仍等于 mergeExternalChange(base, disk, memory)', () => {
    const memory = BASE.replace('丁\n', '丁AUTH_A1\n');
    const merged = mergeExternalChange(BASE, DISK, memory);
    const decision = decideExternalChange(memory, DISK, true, BASE);
    expect(merged).not.toBeNull();
    if (merged && merged.ok && typeof decision === 'object' && decision.kind === 'merge') {
      expect(decision.text).toBe(merged.text);
    }
    // 逐字相等的盘（自身保存回声）仍判 noop；干净 model 仍判 reload —— 决策语义零改动
    expect(decideExternalChange(memory, memory, false, BASE)).toBe('noop');
    expect(decideExternalChange(memory, DISK, false, BASE)).toBe('reload');
  });
});

describe('③干净重载那条腿不回退（f2738ad7 已钉，判据 3）', () => {
  it('接线：applyReload 仍走 applyDiskText，整条 reloadFromDisk 里一个 setValue 都不留', () => {
    const applyReload = sliceBetween('const applyReload = (): void => {', '\n      if (decision ===');
    expect(applyReload).toContain('applyDiskText(live.model, text)');
    const reloadRegion = codeOf(sliceBetween(
      'const reloadFromDisk = useCallback(',
      '\n  reloadFromDiskRef.current = reloadFromDisk;',
    ));
    expect(reloadRegion).not.toMatch(/\.setValue\(/);
  });

  it('真 model：干净重载 → 一次 Ctrl+Z 仍回到作者改动（与 merge 腿同一停点口径）', () => {
    const model = makeModel(BASE);
    authorTyping(model, 4, 2, 'AUTH_A1');
    const authorText = model.getValue();
    expect(decideExternalChange(authorText, DISK, false, BASE)).toBe('reload');
    expect(applyDiskText(model, DISK)).toBe(1);
    expect(model.getValue()).toBe(DISK);
    model.undo();
    expect(model.getValue()).toBe(authorText);
  });

  it('接线：merge 腿仍不钉基线、不进 reloadingRef（合并结果必须照旧上报"仍未保存"）', () => {
    expect(MERGE_BRANCH).toContain('editorModelPool.setSavedBase(path, text)');
    expect(MERGE_BRANCH_CODE).not.toMatch(/setBaseline/);
    expect(MERGE_BRANCH_CODE).not.toMatch(/reloadingRef/);
    expect(MERGE_BRANCH).toContain("setStatus('已合并磁盘改动与你的未保存改动（还没写入磁盘）'");
  });
});

describe('④接线：merge 落地已换成差量（反向自证：改回 setValue 必红在这里）', () => {
  it('MERGE 分支调用 applyDiskText(live.model, decision.text) 且不含 setValue', () => {
    expect(MERGE_BRANCH).toContain('applyDiskText(live.model, decision.text)');
    expect(MERGE_BRANCH_CODE).not.toMatch(/\.setValue\(/);
  });

  it('差量通道 import 仍在位（三条腿共用同一模块，不许各自抄一份）', () => {
    expect(SOURCE).toMatch(/import \{[^}]*applyDiskText[^}]*\} from '\.\/disk-text-sync'/);
    // 组长返工（2026-10-21 合流时）：原写法把 `applyDiskText(` 钉成恰好 2 处，
    // FIX-ALL-UNDO-STACK 落地全角替换那处（第 3 条腿）后必红——计数钉的是数量不是通道。
    // 改成按参数点名三条腿 + 禁 `setValue` 复发：再多一条合法腿也不会误红，也不许谁退回旧路。
    expect(SOURCE).toContain('applyDiskText(live.model, text)'); // 重载腿
    expect(SOURCE).toContain('applyDiskText(live.model, decision.text)'); // merge 腿
    expect(SOURCE).toContain('applyDiskText(model, fixed)'); // 全角替换腿（FIX-ALL-UNDO-STACK）
    expect(SOURCE).not.toMatch(/\.setValue\(/);
  });

  it('机理取证：同一段合并结果用 setValue 落地会清空整条栈（本批换掉的正是它）', () => {
    const model = makeModel(BASE);
    authorTyping(model, 4, 2, 'AUTH_A1');
    const decision = decideExternalChange(model.getValue(), DISK, true, BASE);
    if (typeof decision !== 'object' || decision.kind !== 'merge') throw new Error('决策树口径变了');
    model.setValue(decision.text);
    expect(model.getValue()).toBe(decision.text);
    expect(model.canUndo()).toBe(false); // = 数据丢失级缺陷的成因
  });
});
