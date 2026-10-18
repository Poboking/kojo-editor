/**
 * 条件矩阵行视图的 DOM 结构回归（CM-4 体感二轮）。
 *
 * 为什么住 app 侧：react-dom（SSR）只有 app 包依赖它；断言对象是矩阵插件的
 * `MatrixRowView`（相对导入其 src，与 face-list-render 同口径）。
 *
 * 两条判据：
 * - 折叠的面在行内只收成**一只跨列占位**（旧实现仍按原列数铺隐藏格，折叠不降 DOM）；
 * - 填格模式不再经 props 换文案（`+` 由 `.cm-scroll.cm-fill` 的 CSS 提供），
 *   行组件只在选中集变化时重渲。
 */

import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MatrixRowView } from '../../plugins/ui-condition-matrix/src/row-view';
import type { MatrixColumnGroup, MatrixRow } from '../../plugins/ui-condition-matrix/src/matrix-logic';

function group(face: string, n: number): MatrixColumnGroup {
  return {
    face,
    label: face,
    columns: Array.from({ length: n }, (_, i) => ({
      key: `${face}#${i}`,
      face,
      label: `#${i}`,
      instructionNo: i,
      functions: [],
      universeFunctions: [],
      fillCount: 0,
      gapCount: 0,
    })),
  };
}

const row: MatrixRow = {
  key: 'CFLAG:318',
  name: 'CFLAG',
  indices: ['318'],
  label: '好感',
  totalCount: 0,
  comparisons: [],
  universeComparisons: [],
  cells: {},
  gapCount: 8,
};

const groups = [group('A', 5), group('B', 3)];

function render(folded: readonly string[], fillColumns: ReadonlySet<string> = new Set()): string {
  return renderToStaticMarkup(
    h(MatrixRowView, {
      row,
      groups,
      foldedFaces: new Set(folded),
      selectedColumn: null,
      cursorColumn: null,
      fillColumns,
      rowIndex: 0,
      onCell: () => {},
    }),
  );
}

const count = (markup: string, pattern: RegExp): number => (markup.match(pattern) ?? []).length;

describe('MatrixRowView（折叠 / 填格模式）', () => {
  it('折叠整面：该组只渲染一只 colspan 占位，不是每列一只隐藏格', () => {
    const markup = render(['A']);
    // B 组 3 只真实格 + A 组 1 只跨列占位
    expect(count(markup, /<td/g)).toBe(4);
    expect(markup.toLowerCase()).toContain('colspan="5"');
    expect(count(markup, /cm-hid/g)).toBe(1);
  });

  it('全部展开：每列一只数据格，与列数一致', () => {
    const markup = render([]);
    expect(count(markup, /<td/g)).toBe(8);
    expect(markup).not.toContain('colspan');
  });

  it('填格模式不写进行 props：空缺文本仍是 ·，+ 交给父级 class 的 CSS', () => {
    const markup = render([]);
    expect(markup).toContain('空缺：点击选中');
    expect(markup).not.toContain('cm-cell off gap');
    expect(markup).not.toContain('>+<');
  });

  it('选中格只在 fillColumns 真的含它时出现 ✓ 与 fill-sel', () => {
    const markup = render([], new Set(['A#2']));
    expect(markup).toContain('cm-cell off fill-sel');
    expect(count(markup, /✓/g)).toBe(1);
    expect(count(markup, /aria-pressed="true"/g)).toBe(1);
  });
});
