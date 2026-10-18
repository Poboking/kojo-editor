/**
 * 矩阵面板的**详情区**（选中格 → 展开内容；React + 结构化事件类型）。
 *
 * 三态：
 *   - 已填格：行标签 / 键 + 时机 + 响应函数清单（名称 / 比较串 / 落点，点击跳转）；
 *   - 空缺格：说明「这个口上包在该时机还没有针对此状态的响应」并列出**全角色**
 *     的参考条件（别的口上包怎么写这一行）；
 *   - 未选中：图例 + 操作引导。
 *
 * 填空模式只影响文案与「已选入草稿」标记；详情区不直接改写选择（选择归格子点击，
 * 判据全在面板），避免同一个动作两条入口。
 */

import { createElement, type ReactNode } from 'react';
import { shortPath } from '@kojo/plugin-api';
import type { ConditionMatrix } from './matrix-logic';
import { faceLabel } from './matrix-logic';
import { orderByLine, type RevealTarget } from './row-view';

export function renderDetail(opts: {
  matrix: ConditionMatrix | null;
  selected: { readonly rowKey: string; readonly columnKey: string } | null;
  faceLabels: () => Readonly<Record<string, string>> | undefined;
  detailH: number | null;
  detailRef: { current: { clientHeight: number } | null };
  emitReveal: (target: RevealTarget) => void;
  fillMode: boolean;
  fillSelected: boolean;
}): ReactNode {
  const {
    matrix,
    selected,
    faceLabels,
    detailH,
    detailRef,
    emitReveal,
    fillMode,
    fillSelected,
  } = opts;
  const detailProps = {
    className: 'cm-detail',
    ref: detailRef,
    style: detailH === null ? undefined : { height: detailH, maxHeight: detailH },
  };
  const selRow = selected && matrix ? matrix.rows.find((r) => r.key === selected.rowKey) ?? null : null;
  const selCell = selRow && selected ? selRow.cells[selected.columnKey] : undefined;
  const selColumn = selected && matrix ? matrix.columns.find((c) => c.key === selected.columnKey) ?? null : null;
  const selColumnLabel = selColumn ? selColumn.label : selected ? faceLabel(selected.columnKey, faceLabels()) : '';

  if (selRow && selCell && selCell.present) {
    const fns = orderByLine(selCell.functions);
    const comps = [...new Set(fns.flatMap((f) => f.comparisons))];
    return createElement(
      'div',
      detailProps,
      createElement(
        'div',
        { className: 'cm-detail-head' },
        createElement(
          'span',
          { className: 'cm-detail-title' },
          createElement('span', { className: 'cm-detail-key' }, selRow.label ?? selRow.key),
          selRow.label ? createElement('code', { className: 'cm-detail-rowkey dim' }, selRow.key) : null,
        ),
        createElement('span', { className: 'cm-detail-sep dim' }, '·'),
        createElement('span', { className: 'cm-detail-col' }, selColumnLabel),
        createElement(
          'span',
          { className: 'cm-detail-count' },
          `${selCell.count} 处响应`,
        ),
        fillMode
          ? createElement('span', { className: 'cm-detail-fillhint dim' }, '已有响应 · 不参与填空')
          : null,
      ),
      comps.length > 0
        ? createElement(
            'div',
            { className: 'cm-detail-comps-row' },
            ...comps.map((comp) => createElement('span', { key: comp, className: 'cm-comp-chip' }, comp)),
          )
        : null,
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
                title: `打开 ${f.filePath}:${f.startLine}`,
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
  }

  if (selRow && selected) {
    const comps = selRow.comparisons.length > 0 ? selRow.comparisons : selRow.universeComparisons;
    return createElement(
      'div',
      detailProps,
      createElement(
        'div',
        { className: 'cm-detail-head' },
        createElement(
          'span',
          { className: 'cm-detail-title' },
          createElement('span', { className: 'cm-detail-key' }, selRow.label ?? selRow.key),
          selRow.label ? createElement('code', { className: 'cm-detail-rowkey dim' }, selRow.key) : null,
        ),
        createElement('span', { className: 'cm-detail-sep dim' }, '·'),
        createElement('span', { className: 'cm-detail-col' }, selColumnLabel),
        createElement('span', { className: 'cm-detail-gap' }, '空缺'),
        fillSelected
          ? createElement('span', { className: 'cm-detail-filled' }, '已选入填空')
          : null,
      ),
      createElement(
        'div',
        { className: 'cm-detail-gap-note dim' },
        fillMode
          ? '这个口上包在该时机还没有针对此状态的响应。已选入的格会一起生成模板；点格子可取消。'
          : '这个口上包在该时机还没有针对此状态的响应。开启「填格」后点它即可选中。',
      ),
      comps.length > 0
        ? createElement(
            'div',
            { className: 'cm-detail-hint-row' },
            createElement('span', { className: 'dim' }, '全角色参考条件'),
            ...comps.map((comp) => createElement('span', { key: comp, className: 'cm-comp-chip' }, comp)),
          )
        : null,
    );
  }

  return createElement(
    'div',
    detailProps,
    createElement(
      'div',
      { className: 'cm-detail-guide' },
      createElement('span', { className: 'cm-detail-guide-title' }, '点击格子查看细节'),
      createElement(
        'span',
        { className: 'dim' },
        fillMode
          ? '空白格已变为可勾选：点一下选中、再点取消；选好后在下方生成模板。'
          : '已填色的格可看到响应函数与比较条件；开启「填格」后可勾选空白格生成模板。',
      ),
      createElement(
        'div',
        { className: 'cm-legend' },
        createElement('span', { className: 'cm-legend-item' }, createElement('span', { className: 'cm-legend-swatch on' }), '有响应'),
        createElement('span', { className: 'cm-legend-item' }, createElement('span', { className: 'cm-legend-swatch off' }), '空缺'),
        createElement('span', { className: 'cm-legend-item' }, createElement('span', { className: 'cm-legend-swatch cur' }), '光标所在函数的格'),
      ),
    ),
  );
}
