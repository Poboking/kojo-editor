/**
 * 糖判定面板 · 诊断列表（VerdictDiagList）的窗口化 DOM 行数上界证据（2026-10-16 窗口批）。
 *
 * 为什么住 app 侧：react-dom（SSR）只有 app 包依赖；断言对象是 ui-sugar-editor 插件的
 * `VerdictDiagList`（相对导入其 src——与 vitest alias 同源）。
 *
 * 口径（照 face-list-render.test.ts）：
 * - 初开 ≤ DIAG_WINDOW_INITIAL 行（旧实现硬截 200，且首帧就要挂最多 200 行）；
 * - 触底每步 +DIAG_WINDOW_STEP（增量挂载，不存在"一次挂整表"）；
 * - 窗口 ≥ total 时哨兵消失——与旧「其余 N 条未显示」的语义差异是**全量可达**
 *   （滚动即自然加载），这正是任务允许的"窗口版的自然结果"。
 */

import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VerdictDiagList } from '../../plugins/ui-sugar-editor/src/index';
import {
  DIAG_WINDOW_INITIAL,
  DIAG_WINDOW_STEP,
  type VerdictRow,
} from '../../plugins/ui-sugar-editor/src/panel-logic';

function row(i: number): VerdictRow {
  return {
    key: `K${i}`,
    severity: i % 3 === 0 ? 'error' : 'warning',
    code: 'C001',
    line: i,
    column: 1,
    message: `诊断 ${i}`,
  };
}
const rows = (n: number): VerdictRow[] => Array.from({ length: n }, (_, i) => row(i + 1));
const count = (markup: string, sub: string): number => (markup.split(sub).length - 1);

function render(list: VerdictRow[], limit: number | undefined): string {
  return renderToStaticMarkup(
    h(VerdictDiagList, { rows: list, limit, onGrow: () => {}, onReveal: () => {} }),
  );
}

describe('VerdictDiagList · 诊断窗口的 DOM 行数上界', () => {
  it('10k 条：初开只挂 INITIAL 行 + 一个哨兵（旧实现要挂 200 行且其余不可达）', () => {
    const html = render(rows(10_000), undefined);
    expect(count(html, 'sv-row ')).toBe(DIAG_WINDOW_INITIAL);
    expect(count(html, 'sv-more-btn')).toBe(1);
    expect(html).toContain(`显示更多（还剩 ${10_000 - DIAG_WINDOW_INITIAL}）`);
  });

  it('窗口按 STEP 生长：每步只多挂 STEP 行；到 total 后哨兵消失', () => {
    const html240 = render(rows(10_000), DIAG_WINDOW_INITIAL + DIAG_WINDOW_STEP);
    expect(count(html240, 'sv-row ')).toBe(DIAG_WINDOW_INITIAL + DIAG_WINDOW_STEP);
    expect(html240).toContain(`显示更多（还剩 ${10_000 - DIAG_WINDOW_INITIAL - DIAG_WINDOW_STEP}）`);

    const htmlFull = render(rows(10_000), 10_000);
    expect(count(htmlFull, 'sv-row ')).toBe(10_000);
    expect(count(htmlFull, 'sv-more-btn')).toBe(0);
  });

  it('小列表（≤ INITIAL）：无哨兵、行数 = total（与旧实现的常见路径同构）', () => {
    const html = render(rows(30), undefined);
    expect(count(html, 'sv-row ')).toBe(30);
    expect(count(html, 'sv-more-btn')).toBe(0);
  });

  it('行为语义不丢：可定位行仍带点击定位 title 与严重度类名', () => {
    const html = render(rows(3), undefined);
    expect(count(html, 'title="点击定位到源行"')).toBe(3);
    expect(html).toContain('sv-row error');
    expect(html).toContain('诊断 1');
  });
});
