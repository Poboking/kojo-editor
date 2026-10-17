/**
 * 条件矩阵的**单行渲染件**（从 `index.ts` 原样迁出，DOM 结构与文案逐字不变）。
 *
 * `memo` 的理由留在原处：选中态只在「选中行 ↔ 取消选中行」两行间变化，其余行 props
 * 不变 → 整表跳过重渲。折叠组仍渲染**同形占位 DOM**（td + button，只加 `.cm-hid`），
 * 这是为零重排调出来的口径，改一次 class 写法就可能把 ~583ms 的样式重算请回来。
 *
 * 两个纯助手（`orderByLine` / `cellComparisons`）与行视图同进同退：前者供详情区与
 * 「取最早贡献函数」，后者是格子的工具提示文案（无比较或无响应 → '无'）。
 * 判据（建表 / 视口窗口 / 光标命中）仍在 `matrix-logic.ts`，本模块不复制。
 */

import { createElement, memo, type ReactNode } from 'react';
import type { MatrixCell, MatrixCellFunction, MatrixColumnGroup, MatrixRow } from './matrix-logic';
/** 按「行号升序、同号按路径」排序（详情展示 / 取最早贡献函数） */
export function orderByLine(fns: readonly MatrixCellFunction[]): MatrixCellFunction[] {
  return [...fns].sort((a, b) => a.startLine - b.startLine || a.filePath.localeCompare(b.filePath));
}

/** 单元格工具提示：其贡献函数的比较合并去重（无比较或无响应 → '无'） */
export function cellComparisons(cell: MatrixCell): string {
  const seen = new Set<string>();
  for (const f of cell.functions) for (const c of f.comparisons) seen.add(c);
  return seen.size > 0 ? [...seen].join('、') : '无';
}

/** 跳转意图载荷（`editor.revealLocation` 消费） */
export interface RevealTarget {
  readonly filePath: string;
  readonly line: number;
  readonly source: string;
}

/* --------------------------- 行视图（memo：选中/折叠只重渲受影响行） --------------------------- */

export interface MatrixRowViewProps {
  readonly row: MatrixRow;
  readonly groups: readonly MatrixColumnGroup[];
  readonly foldedFaces: ReadonlySet<string>;
  /** 本行含选中格则为其列键，否则 null（非选中行传同一原始值，memo 得以整表跳过重渲） */
  readonly selectedColumn: string | null;
  /** 本行含「光标所在函数」贡献的格则为其列键，否则 null（C1 反向联动；与 selectedColumn 同款 memo 口径） */
  readonly cursorColumn: string | null;
  readonly rowIndex: number;
  readonly onCell: (rowKey: string, columnKey: string, target: RevealTarget | null) => void;
}

/**
 * 单行渲染（`memo`）：选中态只在「选中行 ↔ 取消选中行」两行间变化，其余行 props 不变 → 跳过重渲。
 * 格子带 `data-r`/`data-c`（渲染序索引）供网格方向键导航定位。
 */
export const MatrixRowView = memo(function MatrixRowView(props: MatrixRowViewProps): ReactNode {
  const { row, groups, foldedFaces, selectedColumn, cursorColumn, rowIndex, onCell } = props;
  const cells: ReactNode[] = [];
  let c = 0;
  for (const group of groups) {
    const folded = foldedFaces.has(group.face);
    for (const col of group.columns) {
      if (folded) {
        // 折叠组：占位格**保留同形 DOM**（td + button），只给按钮加 `.cm-hid`（visibility:hidden）。
        // 实测（10224 格 / 276 列）：卡顿主因有两份——①浏览器样式重算，其中「改动 td 的 class」
        // 一份就占 ~583ms、「只动 button 的 class」仅 ~134ms；②`table-layout:auto` 的整表重排
        // （清空 subth 标签 / `display:none` 改内容尺寸都会触发，~1.8s）。故：td **不改 class**、
        // 按钮只加 `.cm-hid`（visibility 不改布局、保留盒子）、表头 subth 标签照常渲染
        // （由既有 `.cm-subth.folded{opacity:.3}` 弱化）——全流程只改非布局属性 ⇒ 只重绘不重排。
        // 折叠格不给 data-r/data-c（沿用「折叠组不参与方向键导航」的原口径）。
        cells.push(
          createElement(
            'td',
            { key: col.key },
            createElement('button', { className: 'cm-cell off cm-hid', 'aria-hidden': 'true' }, '·'),
          ),
        );
        continue;
      }
      const cell = row.cells[col.key];
      const dataC = c++;
      if (!cell || !cell.present) {
        // 空白格：这个时机还没有针对该状态写过的反应（点击不导航）
        cells.push(
          createElement(
            'td',
            { key: col.key },
            createElement(
              'button',
              { className: 'cm-cell off', title: '无', 'data-r': rowIndex, 'data-c': dataC },
              '·',
            ),
          ),
        );
        continue;
      }
      const isSel = selectedColumn === col.key;
      // C1 反向联动：光标所在函数贡献的格描一圈亮环（.cur；与 .sel 的白色内环互不覆盖）
      const isCur = cursorColumn === col.key;
      cells.push(
        createElement(
          'td',
          { key: col.key },
          createElement(
            'button',
            {
              className: 'cm-cell on' + (isSel ? ' sel' : '') + (isCur ? ' cur' : ''),
              title: cellComparisons(cell),
              'data-r': rowIndex,
              'data-c': dataC,
              onClick: () => {
                const earliest = orderByLine(cell.functions)[0];
                onCell(
                  row.key,
                  col.key,
                  earliest
                    ? { filePath: earliest.filePath, line: earliest.startLine, source: earliest.name }
                    : null,
                );
              },
            },
            String(cell.count),
          ),
        ),
      );
    }
  }
  return createElement(
    'tr',
    null,
    createElement(
      'th',
      { className: 'cm-rowhead', title: row.key },
      createElement('span', { className: 'cm-row-name' }, row.label ?? row.key),
      row.label ? createElement('span', { className: 'cm-row-key dim' }, row.key) : null,
      // 列宽拖拽把手（HK-25）：**整列**每一行的行头右缘都放一枚，使「状态 \ 时机」列
      // 在任意行都能拉伸（不再只有表头角格可抓）。事件由 .cm-scroll 委派，此处不挂 handler。
      createElement('div', { className: 'cm-corner-resize', 'aria-hidden': 'true' }),
    ),
    ...cells,
  );
});
