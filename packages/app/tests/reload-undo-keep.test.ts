// @vitest-environment happy-dom
/**
 * RELOAD-UNDO-KEEP · 磁盘重载保撤销栈（判据逐字对齐看板 RELOAD-STATE-KEEP 行 + 本批 6 条）。
 *
 * 真壳读数（改前，2026-10-21 run4）：打字 → Ctrl+S → 外部改盘 → 屏上跟上盘上内容、光标 4:22 保住
 * → **连按 5 次 Ctrl+Z 零变化**（栈被 `model.setValue` 清空＝数据丢失级）。
 * 本批正解＝差量走 `pushEditOperations`（monaco「the preferred way of editing the model.
 * The edit operations will land on the undo stack」），一次重载在栈上只占**一个**元素。
 *
 * 两份证据各有分工：
 * - ①②④＝**真 monaco model** 行为（happy-dom 下 `createModel` 可用，同 `status-eol-switch.test.ts` 口径）；
 * - ②③⑤＝`EditorPane` **接线**取证（本仓 React 组件无法在此环境渲染，沿用 `editor-pane-dataflow.test.ts`
 *   / `ps5-editor-pane-wiring.test.ts` 的截源码断言，钉住"两条路没被并成一条"）；
 * - 屏上 4:22 与 Ctrl+Z 的最终裁决在真壳探针 `.local/reload-state-keep-probe.mjs`（读数进提交信息）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as monaco from '../src/monaco/entry';
import { applyDiskText, diskSyncEdits, type DiskSyncModel } from '../src/ui/disk-text-sync';
import { decideExternalChange } from '../src/ui/external-change';

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

/** 重载落地那一段（applyReload 闭包体） */
const APPLY_RELOAD = sliceBetween('const applyReload = (): void => {', '\n      if (decision ===');

const DISK = '外部程序改写\n乙\n丙\n丁';
const AUTHOR_BASE = '头行\n乙\n丙\n丁';

/* ---------------- 真 monaco model：撤销栈与光标 ---------------- */

const models: monaco.editor.ITextModel[] = [];
let seq = 0;
function makeModel(text: string): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(text, 'plaintext', monaco.Uri.parse(`inmemory://reload-undo-keep/${++seq}`));
  models.push(model);
  return model;
}
/** 作者打字的 model 层等价通道（真壳里是编辑器键入，落栈同一条路） */
function authorTyping(model: monaco.editor.ITextModel, atLine: number, atColumn: number, typed: string): void {
  model.pushEditOperations(
    null,
    [{ range: new monaco.Range(atLine, atColumn, atLine, atColumn), text: typed }],
    () => null,
  );
}

afterEach(() => {
  for (const model of models.splice(0)) if (!model.isDisposed()) model.dispose();
});

describe('①重载 ⇒ 一次 Ctrl+Z 回到作者上一次的改动', () => {
  it('差量落地后屏上＝盘上逐字相等，且重载之前的作者编辑仍撤得回来（改前 = 撤不回）', () => {
    const model = makeModel(AUTHOR_BASE);
    authorTyping(model, 4, 2, 'AUTH_A1'); // 第 4 行末打字（真壳同款序列）
    const authorText = model.getValue();
    expect(authorText).toContain('AUTH_A1');

    expect(applyDiskText(model, DISK)).toBe(1);
    // 磁盘赢：屏上内容与盘上内容逐字相等（判据 1 / 2）
    expect(model.getValue()).toBe(DISK);
    // 一次撤销回到作者上一次的改动（判据 1 / 6：只按一次，不是两次）
    expect(model.canUndo()).toBe(true);
    model.undo();
    expect(model.getValue()).toBe(authorText);
    expect(model.getValue()).not.toBe(DISK);
  });

  it('重载在栈上只占一个元素：第二次撤销才动到作者打字（不许留两段）', () => {
    const model = makeModel(AUTHOR_BASE);
    authorTyping(model, 4, 2, 'AUTH_A1');
    const afterTyping = model.getAlternativeVersionId();
    applyDiskText(model, DISK);

    model.undo(); // 第一段：只退重载
    expect(model.getValue()).not.toBe(DISK);
    expect(model.getValue()).toContain('AUTH_A1');
    expect(model.canUndo()).toBe(true);
    model.undo(); // 第二段：这才轮到作者自己的打字
    expect(model.getValue()).toBe(AUTHOR_BASE);
    expect(model.getAlternativeVersionId()).not.toBe(afterTyping);
  });

  it('栈顶已封口（作者那格早已 close）⇒ 停点不造空元素：一次撤销仍只退重载', () => {
    const model = makeModel(AUTHOR_BASE);
    authorTyping(model, 4, 2, 'AUTH_A1');
    model.pushStackElement(); // 模拟编辑器已经打过停点（栈顶关闭）
    const authorText = model.getValue();
    applyDiskText(model, DISK);
    model.undo();
    expect(model.getValue()).toBe(authorText);
  });

  it('取证机理：setValue 清整条栈（本批要换掉的正是它），差量落地不清', () => {
    const model = makeModel(AUTHOR_BASE);
    authorTyping(model, 4, 2, 'AUTH_A1');
    model.setValue(DISK); // 改前写法：monaco `_setValueFromTextBuffer` ⇒ `_commandManager.clear()`
    expect(model.getValue()).toBe(DISK);
    expect(model.canUndo()).toBe(false); // 撤销栈没了 = 数据丢失级缺陷的成因
  });

  it('无差量 ⇒ 零编辑、栈一位都不多占', () => {
    const model = makeModel(DISK);
    expect(applyDiskText(model, DISK)).toBe(0);
    expect(model.canUndo()).toBe(false);
    expect(model.getValue()).toBe(DISK);
  });
});

describe('②重载不破光标：不替作者算新光标位，差量也不碰光标所在行', () => {
  it('pushEditOperations 收到 beforeCursorState=null、cursorStateComputer 返回 null（前后各一次停点）', () => {
    const seen: { before: unknown; edits: number; computer: unknown; stops: number; order: string[] } = {
      before: 'unset',
      edits: -1,
      computer: 'unset',
      stops: 0,
      order: [],
    };
    const stub: DiskSyncModel = {
      getValue: () => AUTHOR_BASE,
      getPositionAt: (offset) => ({ lineNumber: AUTHOR_BASE.slice(0, offset).split('\n').length, column: 1 }),
      getEOL: () => '\n',
      setEOL: () => {
        seen.order.push('eol'); // DISK 是纯 LF ⇒ 多数派口径不该触发换档
      },
      pushStackElement: () => {
        seen.stops += 1;
        seen.order.push('stop');
      },
      pushEditOperations: (before, edits, computer) => {
        seen.before = before;
        seen.edits = edits.length;
        seen.computer = computer();
        seen.order.push('edit');
        return null;
      },
    };
    expect(applyDiskText(stub, DISK)).toBe(1);
    expect(seen.before).toBeNull();
    expect(seen.computer).toBeNull();
    expect(seen.edits).toBe(1);
    expect(seen.stops).toBe(2); // 前封口（作者那格）+ 后封口（重载这格）
    expect(seen.order).toEqual(['stop', 'edit', 'stop']); // 同档 ⇒ 换档一步都没多走
  });

  it('头部改行 ⇒ 差量区间整个落在作者光标行之前（第 4 行不动）', () => {
    const edits = diskSyncEdits(AUTHOR_BASE, DISK);
    expect(edits).toHaveLength(1);
    const edit = edits[0]!;
    const cursorLineStart = AUTHOR_BASE.split('\n').slice(0, 3).join('\n').length + 1; // 第 4 行行首偏移
    expect(edit.end).toBeLessThanOrEqual(cursorLineStart);
    // RELOAD-EOL-PIN 起按行分段：差量含行尾（'头行\n'），区间上界仍 <= 光标行行首
    expect(AUTHOR_BASE.slice(edit.start, edit.end)).toBe('头行\n');
  });

  it('接线：saveViewState / restoreViewState 仍一前一后包住差量落地（前手量到 4:22 的那条路不许断）', () => {
    expect(APPLY_RELOAD).toContain('ed.saveViewState()');
    expect(APPLY_RELOAD).toMatch(/const vs = isActive && ed \? ed\.saveViewState\(\) : null;/);
    expect(APPLY_RELOAD).toContain('ed.restoreViewState(vs)');
    const saveAt = APPLY_RELOAD.indexOf('saveViewState()');
    const applyAt = APPLY_RELOAD.indexOf('applyDiskText(live.model, text)');
    const restoreAt = APPLY_RELOAD.indexOf('restoreViewState(vs)');
    expect(applyAt).toBeGreaterThan(saveAt);
    expect(restoreAt).toBeGreaterThan(applyAt);
  });
});

describe('③脏冲突路径零改动（防把两条路并成一条）', () => {
  it('决策面：model 脏 + 盘变 ⇒ 仍不静默落地（reload 只给干净 model）', () => {
    const memory = '头行\n乙\n丙\n丁AUTH_A1';
    const disk = '外部程序改过的头行\n乙\n丙\n丁AUTH_B2'; // 两侧都改第 4 行 ⇒ 撞车
    expect(decideExternalChange(memory, disk, false, AUTHOR_BASE)).toBe('reload');
    expect(decideExternalChange(memory, disk, true, AUTHOR_BASE)).toEqual({
      kind: 'merge-conflict',
      conflicts: expect.any(Array),
    });
    // base 缺失（恢复件首开 / 老会话）⇒ 逐字退回两方 conflict，照旧交给作者
    expect(decideExternalChange(memory, disk, true)).toBe('conflict');
  });

  it('接线：applyReload 仍只由 `decision === \'reload\' || forced` 触发；冲突通知与「重新加载（放弃我的修改）」原样', () => {
    expect(SOURCE).toMatch(/if \(decision === 'reload' \|\| forced\) \{\n\s+applyReload\(\);/);
    expect(SOURCE).toContain('label: ' + "'重新加载（放弃我的修改）'");
    expect(SOURCE).toContain('setStatus(' + "'已从磁盘重新加载（文件在外部被修改）'");
  });

  it('接线：合并分支已被 RELOAD-MERGE-UNDO 并入同一差量口径（本批不 revert 它）', () => {
    const mergeBranch = sliceBetween("if (typeof decision === 'object' && decision.kind === 'merge')", '\n      const clashCount');
    // 改前这里是 `live.model.setValue(decision.text)`（撤销栈照旧被清）；
    // RELOAD-MERGE-UNDO 起两条腿共用 `applyDiskText`，行为用例见 `reload-merge-undo.test.ts`。
    expect(mergeBranch).toContain('applyDiskText(live.model, decision.text)');
    expect(mergeBranch).not.toMatch(/\.setValue\(/);
  });
});

describe('④差量口径：公共前后缀之外恰好一段', () => {
  it('逐字相等 = 空数组；整篇不同 = 一条覆盖全区间', () => {
    expect(diskSyncEdits('甲\n乙', '甲\n乙')).toEqual([]);
    expect(diskSyncEdits('', '新内容')).toEqual([{ start: 0, end: 0, text: '新内容' }]);
    expect(diskSyncEdits('甲', '')).toEqual([{ start: 0, end: 1, text: '' }]);
    expect(diskSyncEdits('完全不同的内容', '另一份内容')).toEqual([{ start: 0, end: 7, text: '另一份内容' }]); // 按行：无行尾段=整行替换
  });

  it('前后缀都对齐：中段一处改动 = 一段差量，落地逐字相等（含 CRLF 盘上文本）', () => {
    const oldText = '一\n二\n三\n四\n五\n';
    const newText = '一\n二\n改\n四\n五\n';
    expect(diskSyncEdits(oldText, newText)).toEqual([{ start: 4, end: 6, text: '改\n' }]); // 行级分段：段=内容+行尾

    const model = makeModel('a\r\nb\r\nc');
    expect(applyDiskText(model, 'a\r\nB2\r\nc')).toBe(1);
    expect(model.getValue()).toBe('a\nB2\nc'.replace(/\n/g, model.getEOL())); // EOL 由 monaco 归一，与 setValue 同源
  });

  it('两处改动（头行 + 尾行）⇒ 仍是一个元素、一次撤销全退回', () => {
    const model = makeModel('头\n中\n尾');
    authorTyping(model, 2, 2, 'Z');
    const authorText = model.getValue();
    applyDiskText(model, '头改\n中\n尾改');
    expect(model.getValue()).toBe('头改\n中\n尾改');
    model.undo();
    expect(model.getValue()).toBe(authorText);
  });
});
