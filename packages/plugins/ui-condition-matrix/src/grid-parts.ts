/**
 * 矩阵表格的**呈现件**（从 `index.ts` 的面板组件里原样迁出，DOM 结构与文案逐字不变）。
 *
 * 三件都是纯搬运：输入进来、`createElement` 出去，不持有状态、不订阅事件。
 * 判据（分组 / 列 / 视口窗口 / 光标命中）仍全在 `matrix-logic.ts`，折叠状态与
 * 图标桥（`ic`）由面板传入 —— 于是「表头怎么长」可单测，「谁点了一下」仍归面板。
 */

import { createElement, type ReactNode } from 'react';
import type { MatrixColumnGroup } from './matrix-logic';
import type { ColSnap } from './dom-shims';

// 两行表头：第一行 = 大时机类（可点折叠，跨该组子列）；第二行 = 子列头。
// 折叠组仍渲染占位格（空白）以维持列对齐，只是不渲染其内容。
export function renderGridHead(opts: {
  groups: readonly MatrixColumnGroup[];
  foldedFaces: ReadonlySet<string>;
  onToggleFace: (face: string) => void;
  ic: (name: string, size: number, fallback: string) => ReactNode;
  cornerRef: { current: unknown };
}): ReactNode {
  const { groups, foldedFaces, onToggleFace, ic, cornerRef } = opts;
  return createElement(
    'thead',
    { key: 'hd' },
    createElement(
      'tr',
      null,
      createElement(
        'th',
        { className: 'cm-corner', rowSpan: 2, ref: cornerRef },
        '状态 \\ 时机',
        // 首列列宽拖拽把手（HK-25）：右缘一枚竖条，静息隐形、悬停 / 拖拽中亮起；
        // 角格 sticky ⇒ 纵向滚动时随表头常驻，横向滚动时首列钉在 left:0 不漂移。
        // 事件在 .cm-scroll 上委派（见 onColDown），此处只放标记。
        createElement('div', {
          className: 'cm-corner-resize',
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': '拖动调整状态列宽',
          title: '拖动调整状态列宽',
        }),
      ),
      ...groups.map((group) => {
        const folded = foldedFaces.has(group.face);
        const gaps = group.columns.reduce((n, col) => n + col.gapCount, 0);
        const missing = group.columns.filter((col) => col.universeFunctions.length > 0 && col.functions.length === 0).length;
        const title =
          `${group.label}（${group.face}）` +
          (gaps > 0 ? ` · ${gaps} 个空缺` : ' · 无空缺') +
          (missing > 0 ? ` · ${missing} 个时机本包整列未写` : '');
        return createElement(
          'th',
          {
            key: group.face,
            className: 'cm-group-th' + (folded ? ' folded' : ''),
            colSpan: group.columns.length,
            title,
            'aria-expanded': !folded,
            onClick: () => onToggleFace(group.face),
          },
          createElement('span', { className: 'cm-fold', 'aria-hidden': 'true' }, ic(folded ? 'chevron-right' : 'chevron-down', 12, folded ? '▸' : '▾')),
          createElement('span', { className: 'cm-group-label' }, group.label),
          gaps > 0
            ? createElement(
                'span',
                { className: 'cm-gap-badge', 'aria-label': `${gaps} 个空缺` },
                String(gaps),
              )
            : createElement('span', { className: 'cm-gap-clear', 'aria-hidden': 'true' }, '✓'),
        );
      }),
    ),
    createElement(
      'tr',
      null,
      ...groups.flatMap((group) => {
        const folded = foldedFaces.has(group.face);
        // 非指令的单列组：第二行留空（避免与第一行重复）。
        // 折叠**不再清空标签**——清空会让该列固有宽度塌陷、逼 `table-layout:auto` 重排全表
        // （实测折叠一次卡 ~1.8s + 整列闪白）；改由 `.cm-subth.folded{opacity:.3}` 弱化。
        const blank = group.columns.length === 1 && group.columns[0]?.instructionNo === null;
        return group.columns.map((col) => {
          const missing = col.universeFunctions.length > 0 && col.functions.length === 0;
          const title =
            `${col.label}（${col.key}）` +
            (col.gapCount > 0 ? ` · ${col.gapCount} 个状态未响应` : ' · 无空缺') +
            (missing ? ' · 本包在这个时机还没有函数（生成器会写完整骨架）' : '');
          return createElement(
            'th',
            {
              key: col.key,
              className:
                'cm-subth' +
                (folded ? ' folded' : '') +
                (missing ? ' cm-col-missing' : '') +
                (col.gapCount === 0 ? ' cm-col-full' : ''),
              title,
            },
            blank ? null : col.label,
            !blank && col.gapCount > 0
              ? createElement(
                  'span',
                  { className: 'cm-sub-gap', 'aria-label': `${col.gapCount} 个状态空缺` },
                  String(col.gapCount),
                )
              : null,
          );
        });
      }),
    ),
  );
}

/** 占位块：单个 td 跨全部列、钉死高度撑出滚动条（视口化路径专用） */
export const spacerRow = (h: number, key: string, colSpan: number): ReactNode =>
  h > 0
    ? createElement(
        'tr',
        { key, className: 'cm-spacer', 'aria-hidden': 'true', style: { height: h } },
        createElement('td', { colSpan, style: { height: h } }),
      )
    : null;

// 定宽接管：每列一条 `<col>`（第 0 条 = 首列，宽度跟 rowheadW；其余为快照的自然列宽）
export function buildColgroup(
  activeSnap: ColSnap | null,
  rowheadW: number | null,
  colRef: { current: unknown },
): ReactNode {
  return activeSnap
    ? createElement(
        'colgroup',
        { key: 'cg' },
        createElement('col', {
          key: 'col-0',
          ref: colRef,
          style: { width: `${rowheadW ?? activeSnap.widths[0]}px` },
        }),
        ...activeSnap
          .widths.slice(1)
          .map((w, i) => createElement('col', { key: `col-${i + 1}`, style: { width: `${w}px` } })),
      )
    : null;
}
