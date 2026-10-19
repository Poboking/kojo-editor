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

/**
 * 单元格工具提示：其贡献函数的比较合并去重（无比较或无响应 → '无'）。
 * 按 cell 对象记忆（矩阵存活期内 cell 身份稳定）：滚动帧重渲染可见行时不再
 * 为每格重建 Set/数组——万级表格里这是每帧几千次分配的来源之一。
 */
const CELL_TITLE_CACHE = new WeakMap<MatrixCell, string>();
export function cellComparisons(cell: MatrixCell): string {
  const hit = CELL_TITLE_CACHE.get(cell);
  if (hit !== undefined) return hit;
  const seen = new Set<string>();
  for (const f of cell.functions) for (const c of f.comparisons) seen.add(c);
  const out = seen.size > 0 ? [...seen].join('、') : '无';
  CELL_TITLE_CACHE.set(cell, out);
  return out;
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
  /**
   * 本行被选入填空草稿的列（无选中传同一个空集合常量，memo 才不会被每帧新 Set 打破）。
   * 填空模式本身**不进 props**：红色打勾与底色由 `.cm-scroll.cm-fill` 父级 class 驱动，
   * 进入/退出模式时行 memo 全部跳过；只有选中集真的变了的那一行才重渲。
   */
  readonly fillColumns: ReadonlySet<string>;
  readonly rowIndex: number;
  readonly onCell: (
    rowKey: string,
    columnKey: string,
    target: RevealTarget | null,
    present: boolean,
  ) => void;
}

/**
 * 单行渲染（`memo`）：选中态只在「选中行 ↔ 取消选中行」两行间变化，其余行 props 不变 → 跳过重渲。
 * 格子带 `data-r`/`data-c`（渲染序索引）供网格方向键导航定位。
 */
export const MatrixRowView = memo(function MatrixRowView(props: MatrixRowViewProps): ReactNode {
  const { row, groups, foldedFaces, selectedColumn, cursorColumn, fillColumns, rowIndex, onCell } = props;
  const cells: ReactNode[] = [];
  let c = 0;
  for (const group of groups) {
    const folded = foldedFaces.has(group.face);
    if (folded) {
      // 折叠组：整组收成**一只跨列占位**，不再为每个折叠列造 td/button。
      // 旧实现每行仍按原列数铺隐藏格（276 列 × 每行 200+ 个 td），折叠了也不减少
      // DOM——大表滚动/切模式依旧整表重渲。colSpan 保持列对齐与表头几何，折叠格
      // 不给 data-r/data-c（沿用「折叠组不参与方向键导航」的原口径）。
      cells.push(
        createElement(
          'td',
          { key: group.face, colSpan: group.columns.length },
          createElement('button', { className: 'cm-cell off cm-hid', 'aria-hidden': 'true' }, '·'),
        ),
      );
      continue;
    }
    for (const col of group.columns) {
      const cell = row.cells[col.key];
      const dataC = c++;
      if (!cell || !cell.present) {
        // 空白格：这个时机还没有针对该状态写过的反应（点击不导航）。
        // 文本只保留「· / ✓」两态；填空模式的红色打勾与底色由父级 `.cm-fill` CSS 提供，
        // 模式开关不再触发整窗行重渲（旧实现每行都收 fillMode prop）。
        const isFillSel = fillColumns.has(col.key);
        cells.push(
          createElement(
            'td',
            { key: col.key },
            createElement(
              'button',
              {
                className: 'cm-cell off' + (isFillSel ? ' fill-sel' : ''),
                title: isFillSel
                  ? '已选入填空——再点一次取消'
                  : '空缺：点击选中；开启「填格子」后可批量生成模板',
                'aria-label': isFillSel ? '已选入填空，点击取消' : '空缺，点击选中',
                'aria-pressed': isFillSel || undefined,
                'data-r': rowIndex,
                'data-c': dataC,
                onClick: () => onCell(row.key, col.key, null, false),
              },
              isFillSel ? '✓' : '·',
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
                  true,
                );
              },
            },
            String(cell.count),
          ),
        ),
      );
    }
  }
  const gapTitle =
    row.gapCount > 0
      ? `${row.key} · 还有 ${row.gapCount} 个时机空缺（已填 ${row.totalCount} 处响应）`
      : `${row.key} · 所有可见时机都有响应`;
  return createElement(
    'tr',
    { className: rowIndex % 2 === 1 ? 'cm-even' : undefined },
    createElement(
      'th',
      { className: 'cm-rowhead', title: gapTitle },
      createElement(
        'span',
        { className: 'cm-row-main' },
        createElement('span', { className: 'cm-row-name' }, row.label ?? row.key),
        row.label ? createElement('span', { className: 'cm-row-key dim' }, row.key) : null,
      ),
      row.gapCount > 0
        ? createElement(
            'span',
            { className: 'cm-row-gap', 'aria-label': `${row.gapCount} 个时机空缺` },
            String(row.gapCount),
          )
        : null,
      // 列宽拖拽把手（HK-25）：**整列**每一行的行头右缘都放一枚，使「状态 \ 时机」列
      // 在任意行都能拉伸（不再只有表头角格可抓）。事件由 .cm-scroll 委派，此处不挂 handler。
      createElement('div', { className: 'cm-corner-resize', 'aria-hidden': 'true' }),
    ),
    ...cells,
  );
});
