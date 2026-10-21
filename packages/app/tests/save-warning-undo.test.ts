// @vitest-environment happy-dom
/**
 * FIX-ALL-UNDO-STACK（2026-10-21）：「替换为半角空格并保存」这类**程序化修复**必须自成一撤销格。
 *
 * 真壳读数（改前）：打字 `AUTH_B` → 保存含 U+3000 的文件 → 弹「保存提醒」→ 点「替换为半角空格
 * 并保存」→ **第一次 Ctrl+Z 撤掉整篇替换的同时把作者自己的打字一并吞掉**（屏盘不一致）。
 * 成因与 RELOAD-UNDO-KEEP 不同源：这条走 `EditorPane.decideSaveWarning` 的 `executeEdits`，
 * 只补了**后停点**（`pushUndoStop`）、缺**前停点** ⇒ monaco `EditStack._getOrCreateEditStackElement`
 * 见栈顶那格还"开着"（`canAppend`）就把机器编辑并进作者打字里。
 *
 * 正解口径＝照 `disk-text-sync.applyDiskText`（前后各一次 `pushStackElement`）落地，不另起第二套。
 *
 * 证据分工（沿用 `reload-undo-keep.test.ts` 口径）：
 * - ①②③＝**真 monaco model** 撤销栈行为；
 * - ④＝`EditorPane.tsx` **接线**截源码断言（钉住"换了停点口径、弹窗语义与保存闸门原样"）；
 * - 真壳 §2 f/g 那格未验（本批不起壳，端口 9222 撞）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FULLWIDTH_SPACE } from '@kojo/plugin-api';
import * as monaco from '../src/monaco/entry';
import { applyDiskText } from '../src/ui/disk-text-sync';

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

/** 保存告警处置那一段（decideSaveWarning 闭包体，到下一条 useCallback 为止） */
const DECIDE = sliceBetween('const decideSaveWarning = useCallback', '\n  // 动作句柄注册');

const FW = FULLWIDTH_SPACE; // U+3000
const BASE = ['角色: 12', '时机 指令 310：', `${FW}${FW}「呀。」`].join('\n');

const models: monaco.editor.ITextModel[] = [];
let seq = 0;
function makeModel(text: string): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(text, 'plaintext', monaco.Uri.parse(`inmemory://save-warning-undo/${++seq}`));
  models.push(model);
  return model;
}
/** 作者打字的 model 层等价通道（真壳里是编辑器键入，落栈同一条路；不补停点＝栈顶格开着） */
function authorTyping(model: monaco.editor.ITextModel, line: number, column: number, typed: string): void {
  model.pushEditOperations(
    null,
    [{ range: new monaco.Range(line, column, line, column), text: typed }],
    () => null,
  );
}
/** 被撤掉的那条旧通道的等价模拟：整篇替换 + **只有后停点**（改前写法的行为面） */
function legacyFixWithoutFrontStop(model: monaco.editor.ITextModel, text: string): void {
  model.pushEditOperations(null, [{ range: model.getFullModelRange(), text }], () => null);
  model.pushStackElement(); // 只有 after：作者那格没封口 ⇒ 机器编辑并进同一格
}

afterEach(() => {
  for (const model of models.splice(0)) if (!model.isDisposed()) model.dispose();
});

describe('①修复前打字 ⇒ 修复自成一格（撤修复不撤打字）', () => {
  it('打字 AUTH_B → 半角替换 → 一次撤销只退替换，打字原样仍在（改前＝一起消失）', () => {
    const model = makeModel(BASE);
    authorTyping(model, 1, 7, 'AUTH_B'); // 第 1 行末打字（真壳同款序列）
    const authorText = model.getValue();
    expect(authorText).toContain('AUTH_B');

    const fixed = model.getValue().split(FW).join(' ');
    expect(applyDiskText(model, fixed)).toBe(1);
    expect(model.getValue()).toBe(fixed); // 磁盘赢：屏上＝替换后文本（判据 3 口径）

    model.undo(); // 第一次 Ctrl+Z
    expect(model.getValue()).toBe(authorText); // 只退替换；作者的打字仍在
    expect(model.getValue()).toContain('AUTH_B');
    expect(model.getValue()).toContain(FW);
  });

  it('取证机理（反向自证锚）：缺前停点的旧通道 ⇒ 一次撤销连作者打字一起吞', () => {
    const model = makeModel(BASE);
    authorTyping(model, 1, 7, 'AUTH_B');
    const fixed = model.getValue().split(FW).join(' ');
    legacyFixWithoutFrontStop(model, fixed);
    model.undo(); // 改前真壳读数：第一次 Ctrl+Z 把打字和替换一并撤掉
    expect(model.getValue()).not.toContain('AUTH_B'); // 并格 ⇒ 打字没了 = 缺陷本身被钉住
  });
});

describe('②连续两次程序化修复各占一格（"一格"不是"全并一格"）', () => {
  it('打字 → 修复一 → 修复二 ⇒ 撤一次只退修复二，再撤才退修复一，打字最后才动', () => {
    const model = makeModel(BASE);
    authorTyping(model, 1, 7, 'AUTH_B');
    const typed = model.getValue();

    const fix1 = typed.split(FW).join(' ');
    expect(applyDiskText(model, fix1)).toBe(1);
    const fix2 = model.getValue().replace('指令', '命令'); // 第二次程序化修复（另一次整篇替换）
    expect(applyDiskText(model, fix2)).toBeGreaterThanOrEqual(1);
    expect(model.getValue()).toBe(fix2);

    model.undo();
    expect(model.getValue()).toBe(fix1); // 只退修复二
    model.undo();
    expect(model.getValue()).toBe(typed); // 这才退修复一；打字完好
    expect(model.getValue()).toContain('AUTH_B');
    model.undo();
    expect(model.getValue()).not.toContain('AUTH_B'); // 打字自己的格最后才动
  });
});

describe('③屏盘一致性与栈位：修复结果逐字落地，空差量不占格', () => {
  it('半角替换逐字生效：U+3000 清零、其余（含 CRLF 面交给 model EOL）不动', () => {
    const model = makeModel(BASE);
    const fixed = model.getValue().split(FW).join(' ');
    applyDiskText(model, fixed);
    expect(model.getValue()).toBe(fixed);
    expect(model.getValue()).not.toContain(FW);
    expect(model.getValue()).toContain('「呀。」');
  });

  it('无全角空格（零差量）⇒ 返回 0、栈一位都不多占（沿用 applyDiskText 口径）', () => {
    const model = makeModel('甲\n乙');
    expect(applyDiskText(model, '甲\n乙')).toBe(0);
    expect(model.canUndo()).toBe(false);
  });
});

describe('④接线：只换落地通道，弹窗语义与保存闸门一字不动', () => {
  it('decideSaveWarning 走 applyDiskText，旧 executeEdits/pushUndoStop 单点已摘除', () => {
    expect(DECIDE).toContain('applyDiskText(model, fixed)');
    expect(DECIDE).not.toContain('ed.executeEdits'); // 只掐调用形态（本批注释里提及旧 API 名是允许的说史）
    expect(DECIDE).not.toContain('ed.pushUndoStop');
    expect(SOURCE).not.toContain('kojo-fix-fullwidth');
  });

  it('三颗按钮的决策树原样：cancel 直接返回 / save-anyway 带确认重存 / fix-and-save 修后重存', () => {
    expect(DECIDE).toContain("if (action === 'cancel') return;");
    expect(DECIDE).toContain("void save({ acknowledgeFullwidthSpace: true });");
    expect(DECIDE).toMatch(/if \(action === 'fix-and-save'\)|const fixed = model\.getValue\(\)\.split\(FULLWIDTH_SPACE\)\.join\(' '\);/);
    expect(DECIDE).toContain('void save();');
    // 糖视图护栏原样：派生 model 不许被程序化改动
    expect(DECIDE).toContain('sugarModelRef.current ? null : ed?.getModel()');
  });

  it('写盘闸门没被放宽：保存仍只走同一条 save()（本批没碰闸门前置与写前备份那两段）', () => {
    expect(DECIDE.split('void save(').length - 1).toBe(2); // save-anyway 与 fix-and-save 各一条，没加第三条
  });
});
