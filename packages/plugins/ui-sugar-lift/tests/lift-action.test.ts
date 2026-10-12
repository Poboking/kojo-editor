/**
 * 「💡 改为语法糖写法」纯逻辑单测（2026-10-12 语法糖视图批）。
 *
 * 这条路径**改的是源文件**（写进 `.kojo`），所以钉死的三件事都是"改坏了怎么办"：
 * - **缩进必须补回原层级**：候选给的是相对缩进，源行可能嵌在任意深度；
 * - **空行不补空白**：补了会造出"只含空白的行"（保存时还要触发全角空格告警）；
 * - **`alias` 不参与**：它没有区间，💡 对它没有意义（不该出现一个点了没反应的灯泡）。
 */

import { describe, expect, it } from 'vitest';
import type { SugarLiftCandidate } from '@kojo/plugin-api';
import { actionTitle, leadingWhitespace, pickCandidate, toSugarEdit } from '../src/lift-action';

function cand(over: Partial<SugarLiftCandidate> & { fromLine: number; toLine: number }): SugarLiftCandidate {
  return {
    kind: 'print-message',
    sugarSource: '糖',
    confidence: 'verified',
    narrationColor: '默认',
    roundTrip: { verified: true, originalText: '原', generatedText: '糖' },
    reason: '测试用',
    ...over,
  };
}

describe('💡 改写 / 挑候选（pickCandidate）', () => {
  it('命中覆盖该行的候选（含区间端点）', () => {
    const list = [cand({ fromLine: 5, toLine: 9 })];
    expect(pickCandidate(list, 5)).toBeDefined();
    expect(pickCandidate(list, 7)).toBeDefined();
    expect(pickCandidate(list, 9)).toBeDefined();
    expect(pickCandidate(list, 4)).toBeUndefined();
    expect(pickCandidate(list, 10)).toBeUndefined();
  });

  it('`alias` 不参与（没有行区间，也不是"把这段换成糖"）', () => {
    expect(pickCandidate([cand({ fromLine: 1, toLine: 1, kind: 'alias' })], 1)).toBeUndefined();
  });

  it('多候选覆盖同一行 → 取最先出现（升糖器已按区间升序，父块在前）', () => {
    const outer = cand({ fromLine: 1, toLine: 20, kind: 'if-block' });
    const inner = cand({ fromLine: 3, toLine: 5, kind: 'if-block' });
    expect(pickCandidate([outer, inner], 4)).toBe(outer);
  });
});

describe('💡 改写 / 生成编辑（toSugarEdit）', () => {
  it('单行：补回原缩进', () => {
    const edit = toSugarEdit(cand({ fromLine: 3, toLine: 3, sugarSource: '「甲」' }), [
      '时机 指令 310：',
      '    IF LOCAL',
      '\t\tPRINTFORMDW 甲。',
    ]);
    expect(edit).toEqual({ fromLine: 3, toLine: 3, newText: '\t\t「甲」' });
  });

  it('多行块：**每一行**都补原基准缩进，相对缩进保持不变', () => {
    const edit = toSugarEdit(
      cand({
        fromLine: 2,
        toLine: 4,
        kind: 'if-block',
        sugarSource: '如果 A：\n    甲\n否则：\n    乙',
      }),
      ['@FUNC', '\tIF A', ''],
    );
    expect(edit.newText).toBe('\t如果 A：\n\t    甲\n\t否则：\n\t    乙');
    // 相对缩进（4 空格一级）原样保留
    expect(edit.newText.split('\n')[1]).toBe('\t    甲');
  });

  it('段内空行不补空白（否则会造出"只含空白的行"）', () => {
    const edit = toSugarEdit(
      cand({ fromLine: 1, toLine: 1, sugarSource: '甲\n\n乙' }),
      ['\tPRINTFORMDW 甲'],
    );
    expect(edit.newText).toBe('\t甲\n\n\t乙');
  });

  it('越界行号（供给与执行之间用户又编辑过）→ 不崩，缩进按空串', () => {
    const edit = toSugarEdit(cand({ fromLine: 99, toLine: 99, sugarSource: '甲' }), ['x']);
    expect(edit.newText).toBe('甲');
  });
});

describe('💡 改写 / 文案与空白', () => {
  it('标题说清"改什么、可撤销"', () => {
    expect(actionTitle(cand({ fromLine: 1, toLine: 1 }))).toContain('可 Ctrl+Z 撤回');
    expect(actionTitle(cand({ fromLine: 1, toLine: 5, kind: 'if-block' }))).toContain('条件块');
    expect(actionTitle(cand({ fromLine: 1, toLine: 5, kind: 'selectcase' }))).toContain('分派块');
  });

  it('前导空白识别三种空白（空格 / TAB / 全角空格）', () => {
    expect(leadingWhitespace('\t\tPRINT')).toBe('\t\t');
    expect(leadingWhitespace('    PRINT')).toBe('    ');
    expect(leadingWhitespace('\u3000PRINT')).toBe('\u3000');
    expect(leadingWhitespace('PRINT')).toBe('');
  });
});
