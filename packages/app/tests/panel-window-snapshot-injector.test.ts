/**
 * 状态注入面板 · 变量目录（VarList）与单元编辑列表（CellRows）的窗口化 DOM 行数上界证据
 * （2026-10-16 窗口批）。
 *
 * 为什么住 app 侧：react-dom（SSR）只有 app 包依赖；断言对象是 ui-snapshot-injector
 * 插件的两个模块级组件（相对导入其 src——与 vitest alias 同源）。
 *
 * 口径（照 face-list-render.test.ts）：初开 ≤ INITIAL / 触底每步 +STEP / 窗口 ≥ total
 * 哨兵消失（旧实现是变量列表硬截 200、单元列表硬截 120 + 「显示前 N」——其余不可达）。
 */

import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CellRows } from '../../plugins/ui-snapshot-injector/src/cell-rows';
import { VarList } from '../../plugins/ui-snapshot-injector/src/var-list';
import {
  CELL_WINDOW_INITIAL,
  CELL_WINDOW_STEP,
  VAR_WINDOW_INITIAL,
  VAR_WINDOW_STEP,
  type VarRow,
} from '../../plugins/ui-snapshot-injector/src/panel-logic';

function vrow(i: number): VarRow {
  return { key: `V${i}`, type: 'int', kind: 'scalar', preview: `${i}`, scalarValue: i };
}
const vrows = (n: number): VarRow[] => Array.from({ length: n }, (_, i) => vrow(i + 1));

const cell = (i: number): { index: number[]; value: number } => ({ index: [i], value: i * 10 });
const cells = (n: number): { index: number[]; value: number }[] => Array.from({ length: n }, (_, i) => cell(i + 1));

const count = (markup: string, sub: string): number => (markup.split(sub).length - 1);

function renderVars(list: VarRow[], limit: number | undefined): string {
  return renderToStaticMarkup(
    h(VarList, { rows: list, selectedKey: null, schema: undefined, limit, onGrow: () => {}, onSelect: () => {} }),
  );
}
function renderCells(list: { index: number[]; value: number }[], limit: number | undefined): string {
  return renderToStaticMarkup(
    h(CellRows, {
      cells: list,
      varKey: 'V1',
      schema: undefined,
      drafts: {},
      limit,
      onGrow: () => {},
      onDraft: () => {},
      onSubmit: () => {},
    }),
  );
}

describe('VarList · 变量目录窗口的 DOM 行数上界', () => {
  it('10k 个：初开只挂 INITIAL 行 + 一个哨兵（旧实现要挂 200 行且其余不可达）', () => {
    const html = renderVars(vrows(10_000), undefined);
    expect(count(html, 'inj-var-row')).toBe(VAR_WINDOW_INITIAL);
    expect(count(html, 'inj-more-btn')).toBe(1);
    expect(html).toContain(`显示更多（还剩 ${10_000 - VAR_WINDOW_INITIAL}）`);
  });

  it('窗口按 STEP 生长：每步只多挂 STEP 行；到 total 后哨兵消失', () => {
    const htmlStep = renderVars(vrows(10_000), VAR_WINDOW_INITIAL + VAR_WINDOW_STEP);
    expect(count(htmlStep, 'inj-var-row')).toBe(VAR_WINDOW_INITIAL + VAR_WINDOW_STEP);
    expect(htmlStep).toContain(`显示更多（还剩 ${10_000 - VAR_WINDOW_INITIAL - VAR_WINDOW_STEP}）`);

    const htmlFull = renderVars(vrows(10_000), 10_000);
    expect(count(htmlFull, 'inj-var-row')).toBe(10_000);
    expect(count(htmlFull, 'inj-more-btn')).toBe(0);
  });

  it('小目录（≤ INITIAL）：无哨兵、行数 = total；空目录保留原空态', () => {
    const small = renderVars(vrows(20), undefined);
    expect(count(small, 'inj-var-row')).toBe(20);
    expect(count(small, 'inj-more-btn')).toBe(0);

    const empty = renderVars([], undefined);
    expect(empty).toContain('该作用域没有变量');
    expect(count(empty, 'inj-more-btn')).toBe(0);
  });

  it('行为语义不丢：选中/禁用类名与悬停 title（数组未完整读取的显式标记）', () => {
    const rows: VarRow[] = [
      vrow(1),
      { key: 'ARR', type: 'int-array-1d', kind: 'array', preview: '3 个非空单元', cellsTruncated: true },
      { key: 'XML', type: 'xml', kind: 'other', preview: '<…>' },
    ];
    const html = renderToStaticMarkup(
      h(VarList, { rows, selectedKey: 'V1', schema: undefined, limit: undefined, onGrow: () => {}, onSelect: () => {} }),
    );
    expect(html).toContain('inj-var-row active');
    expect(html).toContain('inj-var-row disabled');
    expect(html).toContain('title="该数组未能完整读取，无法改写"');
    expect(html).toContain('未完整读取');
  });
});

describe('CellRows · 单元编辑列表窗口的 DOM 行数上界', () => {
  it('10k 个非空单元：初开只挂 INITIAL 行 + 一个哨兵（旧实现硬截 120 且其余不可达）', () => {
    const html = renderCells(cells(10_000), undefined);
    expect(count(html, 'inj-cell-row')).toBe(CELL_WINDOW_INITIAL);
    expect(count(html, 'inj-more-btn')).toBe(1);
    expect(html).toContain(`显示更多（还剩 ${10_000 - CELL_WINDOW_INITIAL}）`);
  });

  it('窗口按 STEP 生长：每步只多挂 STEP 行；到 total 后哨兵消失', () => {
    const htmlStep = renderCells(cells(10_000), CELL_WINDOW_INITIAL + CELL_WINDOW_STEP);
    expect(count(htmlStep, 'inj-cell-row')).toBe(CELL_WINDOW_INITIAL + CELL_WINDOW_STEP);

    const htmlFull = renderCells(cells(10_000), 10_000);
    expect(count(htmlFull, 'inj-cell-row')).toBe(10_000);
    expect(count(htmlFull, 'inj-more-btn')).toBe(0);
  });

  it('小数组（≤ INITIAL）：无哨兵、行数 = total；旧值原样上屏', () => {
    const html = renderCells(cells(6), undefined);
    expect(count(html, 'inj-cell-row')).toBe(6);
    expect(count(html, 'inj-more-btn')).toBe(0);
    expect(html).toContain('[1]');
    expect(html).toContain('inj-cell-old">10<');
  });

  it('行为语义不丢：草稿非空且与旧值不同才启用「加入清单」', () => {
    const list = cells(2);
    const drafts = { '1': '99', '2': '20' }; // [1] 改了；[2] 与旧值相同 → 未变
    const html = renderToStaticMarkup(
      h(CellRows, {
        cells: list,
        varKey: 'V1',
        schema: undefined,
        drafts,
        limit: undefined,
        onGrow: () => {},
        onDraft: () => {},
        onSubmit: () => {},
      }),
    );
    expect(count(html, '>加入清单<')).toBe(1);
    expect(html).toContain('value="99"');
  });
});
