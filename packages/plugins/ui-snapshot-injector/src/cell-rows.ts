/**
 * 数组单元编辑行（从 `index.ts` 原样迁出；DOM 结构与 className 逐字不变）。
 * 组件只渲染窗口与草稿，parse 校验 / 入清单语义留在面板层。
 */

import { createElement, type ReactElement } from 'react';
import type { VariableSchema } from '@kojo/plugin-api';
import { cellLabel, cellWindowSize } from './panel-logic';
import { MoreRow } from './more-row';

/** 数组单元编辑行（窗口化渲染；模块级组件 ⇒ 可独立 SSR 单测 DOM 行数上界） */
export interface CellRowsProps {
  readonly cells: ReadonlyArray<{ index: number[]; value: number | string }>;
  /** 单元语义标签查询的变量键（适配器 variableSchema 透传） */
  readonly varKey: string;
  readonly schema: VariableSchema | undefined;
  /** 草稿（键 = 下标 join(',')；状态归面板层，保证换变量即清） */
  readonly drafts: Readonly<Record<string, string>>;
  /** 当前渲染窗口行数（undefined = 初始窗口） */
  readonly limit: number | undefined;
  /** 触底 / 点击「显示更多」→ 追加一窗（新值由 growWindow(prev, total, CELL_WINDOW) 计算） */
  readonly onGrow: (total: number) => void;
  readonly onDraft: (cellKey: string, value: string) => void;
  /** 「加入清单」（parse 校验 / 入清单语义留在面板层） */
  readonly onSubmit: (index: number[], draft: string, oldValue: number | string) => void;
}

export function CellRows(props: CellRowsProps): ReactElement {
  const { cells } = props;
  const win = cellWindowSize(cells.length, props.limit);
  return createElement(
    'div',
    { className: 'inj-cells' },
    ...cells.slice(0, win).map((c) => {
      const ik = c.index.join(',');
      const draft = props.drafts[ik] ?? '';
      const changed = draft.trim() !== '' && draft !== String(c.value);
      const cellLbl = cellLabel(props.schema, props.varKey, c.index);
      return createElement(
        'div',
        { key: ik, className: 'inj-cell-row' },
        createElement('span', { className: 'inj-cell-index' }, `[${ik}]`),
        cellLbl ? createElement('span', { className: 'inj-var-label' }, cellLbl) : null,
        createElement('span', { className: 'inj-cell-old' }, String(c.value)),
        createElement('input', {
          className: 'inj-input inj-cell-input',
          value: draft,
          placeholder: '新值',
          onChange: (e: { target: { value: string } }) => props.onDraft(ik, e.target.value),
        }),
        createElement(
          'button',
          {
            className: 'ghost small',
            disabled: !changed,
            onClick: () => props.onSubmit(c.index, draft, c.value),
          },
          changed ? '加入清单' : '—',
        ),
      );
    }),
    cells.length > win
      ? createElement(MoreRow, {
          key: 'more',
          remaining: cells.length - win,
          onMore: () => props.onGrow(cells.length),
        })
      : null,
  );
}
