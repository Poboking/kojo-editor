/**
 * C1 反向下行批：光标位点广播纯逻辑单测（零 React、零 DOM）。
 *
 * 钉三件事：
 * 1. **载荷形状**：1 基模型坐标直通；无文件 / 无光标一律折成
 *    `{ filePath: null, line: 1, column: 1, derivedView: false }`（"无位点"是事实，不是错误）；
 * 2. **derivedView 直通**：糖视图标志原样带上——消费方靠它清高亮；
 * 3. **连续相同载荷去重**（切文件时 setModel→恢复视图→定位会连着发数次），
 *    但只要任一字段变了就必须发（含派生视图翻转）。
 */
import { describe, expect, it } from 'vitest';
import {
  createCursorBroadcaster,
  cursorMovedPayload,
  sameCursorPayload,
  type CursorMovedPayload,
} from '../src/ui/cursor-broadcast';

describe('cursorMovedPayload — 位点事实折成载荷', () => {
  it('有文件有光标：line/column 用 1 基模型坐标直通，derivedView 原样带', () => {
    expect(
      cursorMovedPayload({
        filePath: 'C:/game/kojo/a.ERB',
        position: { lineNumber: 12, column: 7 },
        derivedView: false,
      }),
    ).toEqual({ filePath: 'C:/game/kojo/a.ERB', line: 12, column: 7, derivedView: false });
    expect(
      cursorMovedPayload({
        filePath: 'C:/game/kojo/a.kojo',
        position: { lineNumber: 3, column: 1 },
        derivedView: true,
      }).derivedView,
    ).toBe(true);
  });

  it('探针缺席 / 无文件 / 无光标 → 显式无位点（不是错误）', () => {
    const none: CursorMovedPayload = { filePath: null, line: 1, column: 1, derivedView: false };
    expect(cursorMovedPayload(null)).toEqual(none);
    expect(cursorMovedPayload({ filePath: null, position: { lineNumber: 9, column: 9 }, derivedView: true })).toEqual(
      none,
    );
    expect(cursorMovedPayload({ filePath: '/p/a.ERB', position: null, derivedView: true })).toEqual(none);
  });
});

describe('createCursorBroadcaster — 连续相同载荷不发', () => {
  it('同一载荷重复 publish 只发一次', () => {
    const seen: CursorMovedPayload[] = [];
    const b = createCursorBroadcaster((p) => seen.push(p));
    const p: CursorMovedPayload = { filePath: '/p/a.ERB', line: 3, column: 1, derivedView: false };
    expect(b.publish(p)).toBe(true);
    expect(b.publish({ ...p })).toBe(false);
    expect(b.publish({ ...p })).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('任一字段变化即发（含 derivedView 翻转与列级移动）', () => {
    const seen: CursorMovedPayload[] = [];
    const b = createCursorBroadcaster((p) => seen.push(p));
    const base: CursorMovedPayload = { filePath: '/p/a.ERB', line: 3, column: 1, derivedView: false };
    b.publish(base);
    b.publish({ ...base, line: 4 });
    b.publish({ ...base, line: 4, column: 2 });
    b.publish({ ...base, line: 4, column: 2, derivedView: true }); // 糖视图翻转
    b.publish({ filePath: null, line: 4, column: 2, derivedView: true }); // 无文件
    b.publish({ filePath: null, line: 1, column: 1, derivedView: true }); // 回原位（文件仍无）
    expect(seen.map((p) => [p.filePath, p.line, p.column, p.derivedView])).toEqual([
      ['/p/a.ERB', 3, 1, false],
      ['/p/a.ERB', 4, 1, false],
      ['/p/a.ERB', 4, 2, false],
      ['/p/a.ERB', 4, 2, true],
      [null, 4, 2, true],
      [null, 1, 1, true],
    ]);
  });

  it('去重只看"上一份"：A→B→A 三次都发（面板需要知道回来了）', () => {
    const seen: CursorMovedPayload[] = [];
    const b = createCursorBroadcaster((p) => seen.push(p));
    const a: CursorMovedPayload = { filePath: '/p/a.ERB', line: 1, column: 1, derivedView: false };
    const c: CursorMovedPayload = { filePath: '/p/a.ERB', line: 2, column: 1, derivedView: false };
    b.publish(a);
    b.publish(c);
    b.publish({ ...a });
    expect(seen).toHaveLength(3);
  });
});

describe('sameCursorPayload — 逐字段判等', () => {
  it('四个字段全同才算同', () => {
    const p: CursorMovedPayload = { filePath: '/p/a.ERB', line: 3, column: 1, derivedView: false };
    expect(sameCursorPayload(p, { ...p })).toBe(true);
    expect(sameCursorPayload(p, { ...p, filePath: null })).toBe(false);
    expect(sameCursorPayload(p, { ...p, line: 4 })).toBe(false);
    expect(sameCursorPayload(p, { ...p, column: 2 })).toBe(false);
    expect(sameCursorPayload(p, { ...p, derivedView: true })).toBe(false);
  });
});
