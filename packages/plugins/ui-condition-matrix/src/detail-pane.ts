/**
 * 矩阵面板的**详情区**（从 `index.ts` 的面板组件里原样迁出，DOM 结构与文案逐字不变）。
 *
 * 「选了哪一格」由面板持有（它是交互状态），「那一格展开成什么」在这里：
 * 行标签 + 选中列标签 + 按行号排序的贡献函数清单（名称 / 比较串 / 落点），
 * 没选中或该格为空时回一句引导语。跳转仍是一条意图（`emitReveal`），
 * 落地归宿主 —— 本模块不认识 `editor.revealLocation` 这个事件名。
 */

import { createElement, type ReactNode } from 'react';
import { shortPath } from '@kojo/plugin-api';
import type { ConditionMatrix } from './matrix-logic';
import { faceLabel } from './matrix-logic';
import { orderByLine, type RevealTarget } from './row-view';

/** 选中格 → 详情区。参数全部显式传入：跳转意图由调用方发，本模块不碰事件名。 */
export function renderDetail(opts: {
  matrix: ConditionMatrix | null;
  selected: { readonly rowKey: string; readonly columnKey: string } | null;
  faceLabels: () => Readonly<Record<string, string>> | undefined;
  detailH: number | null;
  detailRef: { current: { clientHeight: number } | null };
  emitReveal: (target: RevealTarget) => void;
}): ReactNode {
  const { matrix, selected, faceLabels, detailH, detailRef, emitReveal } = opts;
  // ---- 详情 ----
  // 拖过分隔线后按拖拽高度固定（inline height+maxHeight 覆盖样式默认的 max-height），未拖过走样式默认
  const detailProps = {
    className: 'cm-detail',
    ref: detailRef,
    style: detailH === null ? undefined : { height: detailH, maxHeight: detailH },
  };
  let detail: ReactNode;
  const selRow = selected && matrix ? matrix.rows.find((r) => r.key === selected.rowKey) ?? null : null;
  const selCell = selRow && selected ? selRow.cells[selected.columnKey] : undefined;
  /** 选中列的显示名（列标签；找不到则回退面标签） */
  const selColumn = selected && matrix ? matrix.columns.find((c) => c.key === selected.columnKey) ?? null : null;
  const selColumnLabel = selColumn ? selColumn.label : selected ? faceLabel(selected.columnKey, faceLabels()) : '';
  if (selRow && selCell && selCell.present) {
    const fns = orderByLine(selCell.functions);
    detail = createElement(
      'div',
      detailProps,
      createElement(
        'div',
        { className: 'cm-detail-head' },
        createElement('span', { className: 'cm-detail-key' }, selRow.label ?? selRow.key),
        createElement(
          'span',
          { className: 'dim' },
          ` · ${selColumnLabel} · ${selCell.count} 处响应`,
        ),
      ),
      createElement(
        'ul',
        { className: 'cm-detail-list' },
        ...fns.map((f, i) =>
          createElement(
            'li',
            { key: `${f.filePath}:${f.startLine}:${i}` },
            createElement(
              'button',
              {
                className: 'cm-detail-btn',
                title: `${f.filePath}:${f.startLine}`,
                onClick: () =>
                  emitReveal({
                    filePath: f.filePath,
                    line: f.startLine,
                    source: f.name,
                  }),
              },
              createElement('span', { className: 'cm-detail-name' }, f.name),
              f.comparisons.length > 0
                ? createElement('span', { className: 'cm-detail-comps dim' }, f.comparisons.join('、'))
                : null,
              createElement('span', { className: 'cm-detail-loc dim' }, `${shortPath(f.filePath)}:${f.startLine}`),
            ),
          ),
        ),
      ),
    );
  } else {
    detail = createElement(
      'div',
      detailProps,
      createElement('div', { className: 'cm-empty dim' }, '点击一个已填色的格子，查看其对应的口上函数'),
    );
  }

  return detail;
}
