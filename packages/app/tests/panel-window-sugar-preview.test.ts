/**
 * 糖预览面板 · 逐行映射（RowsSection）与诊断区（DiagSection）的窗口化 DOM 行数上界证据
 * （2026-10-16 窗口批）。
 *
 * 为什么住 app 侧：react-dom（SSR）只有 app 包依赖；断言对象是 ui-sugar-preview 插件的
 * 两个模块级组件（相对导入其 src——与 vitest alias 同源）。
 *
 * 口径（照 face-list-render.test.ts）：初开 ≤ INITIAL / 触底每步 +STEP / 窗口 ≥ total
 * 哨兵消失（旧实现是硬截 400 行 / 100 条 + 「其余 N 未显示」——那 N 条不可达）。
 */

import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiagSection, RowsSection } from '../../plugins/ui-sugar-preview/src/index';
import {
  DIAG_WINDOW_INITIAL,
  DIAG_WINDOW_STEP,
  ROW_WINDOW_INITIAL,
  ROW_WINDOW_STEP,
  type DiagnosticRow,
  type PreviewRow,
} from '../../plugins/ui-sugar-preview/src/panel-logic';

function prow(i: number): PreviewRow {
  return {
    key: `L${i}`,
    sourceLine: i,
    sourceText: `${i} = 0x01`,
    blank: false,
    generatedLines: [i * 2],
    generatedLabel: `L${i * 2}`,
    messageBlocks: [],
    reach: { reachable: 0, unreachable: 0, unknown: 0 },
    reachClass: 'none',
    reachLabel: '',
    hasFullwidthSpace: false,
  };
}
const prows = (n: number): PreviewRow[] => Array.from({ length: n }, (_, i) => prow(i + 1));

function drow(i: number): DiagnosticRow {
  return { key: `D${i}`, severity: 'warning', code: 'W001', message: `诊断 ${i}`, line: i, column: 1 };
}
const drows = (n: number): DiagnosticRow[] => Array.from({ length: n }, (_, i) => drow(i + 1));

const count = (markup: string, sub: string): number => (markup.split(sub).length - 1);

function renderRows(list: PreviewRow[], limit: number | undefined): string {
  return renderToStaticMarkup(h(RowsSection, { rows: list, limit, onGrow: () => {}, onReveal: () => {} }));
}
function renderDiags(list: DiagnosticRow[], limit: number | undefined): string {
  return renderToStaticMarkup(h(DiagSection, { diags: list, limit, onGrow: () => {}, onReveal: () => {} }));
}

describe('RowsSection · 逐行映射窗口的 DOM 行数上界', () => {
  it('10k 行：初开只挂 INITIAL 行 + 一个哨兵（旧实现要挂 400 行且其余不可达）', () => {
    const html = renderRows(prows(10_000), undefined);
    expect(count(html, 'pv-row"')).toBe(ROW_WINDOW_INITIAL);
    expect(count(html, 'pv-more-btn')).toBe(1);
    expect(html).toContain(`显示更多（还剩 ${10_000 - ROW_WINDOW_INITIAL}）`);
    expect(html).toContain('逐行映射（10000 行）');
  });

  it('窗口按 STEP 生长：每步只多挂 STEP 行；到 total 后哨兵消失', () => {
    const htmlStep = renderRows(prows(10_000), ROW_WINDOW_INITIAL + ROW_WINDOW_STEP);
    expect(count(htmlStep, 'pv-row"')).toBe(ROW_WINDOW_INITIAL + ROW_WINDOW_STEP);
    expect(htmlStep).toContain(`显示更多（还剩 ${10_000 - ROW_WINDOW_INITIAL - ROW_WINDOW_STEP}）`);

    const htmlFull = renderRows(prows(10_000), 10_000);
    expect(count(htmlFull, 'pv-row"')).toBe(10_000);
    expect(count(htmlFull, 'pv-more-btn')).toBe(0);
  });

  it('小文件（≤ INITIAL）：无哨兵、行数 = total（与旧实现的常见路径同构）', () => {
    const html = renderRows(prows(42), undefined);
    expect(count(html, 'pv-row"')).toBe(42);
    expect(count(html, 'pv-more-btn')).toBe(0);
  });

  it('行为语义不丢：行带点击定位 title 与源行号', () => {
    const html = renderRows(prows(3), undefined);
    expect(count(html, 'title="点击定位到该源行"')).toBe(3);
    expect(html).toContain('1 = 0x01');
  });
});

describe('DiagSection · 诊断窗口的 DOM 行数上界', () => {
  it('10k 条：初开只挂 INITIAL 条 + 一个哨兵（旧实现硬截 100 且其余不可达）', () => {
    const html = renderDiags(drows(10_000), undefined);
    expect(count(html, 'pv-diag ')).toBe(DIAG_WINDOW_INITIAL);
    expect(count(html, 'pv-more-btn')).toBe(1);
    expect(html).toContain(`显示更多（还剩 ${10_000 - DIAG_WINDOW_INITIAL}）`);
    expect(html).toContain('诊断（10000）');
  });

  it('窗口按 STEP 生长：每步只多挂 STEP 条；到 total 后哨兵消失', () => {
    const htmlStep = renderDiags(drows(10_000), DIAG_WINDOW_INITIAL + DIAG_WINDOW_STEP);
    expect(count(htmlStep, 'pv-diag ')).toBe(DIAG_WINDOW_INITIAL + DIAG_WINDOW_STEP);

    const htmlFull = renderDiags(drows(10_000), 10_000);
    expect(count(htmlFull, 'pv-diag ')).toBe(10_000);
    expect(count(htmlFull, 'pv-more-btn')).toBe(0);
  });

  it('空诊断：原样保留「无诊断」空态（无哨兵）', () => {
    const html = renderDiags([], undefined);
    expect(html).toContain('无诊断');
    expect(count(html, 'pv-more-btn')).toBe(0);
  });
});
