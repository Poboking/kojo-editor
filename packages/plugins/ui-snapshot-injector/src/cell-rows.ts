/**
 * 数组单元编辑行（从 `index.ts` 原样迁出；DOM 结构与 className 逐字不变）。
 * 组件只渲染窗口与草稿，parse 校验 / 入清单语义留在面板层。
 *
 * 两条渲染路径同 `var-list.ts`（PS-7 回收行）：量到几何就只挂视口 ± 缓冲，
 * 量不到就沿用改动前的「追加式窗口 + 显示更多」。
 *
 * 键盘：行壳是 `div`，可聚焦的是行内输入框 ⇒ ↑↓ 漫游把焦点落在**下一行的输入框**
 * （`focusInside`）。左右键留给光标，不改写输入框里的行为。
 */

import { createElement, type ReactElement } from 'react';
import type { ArchiveArrayCell, VariableSchema } from '@kojo/plugin-api';
import { cellLabel, cellWindowSize } from './panel-logic';
import { listSpacer, useRowWindow } from './list-window';
import { MoreRow } from './more-row';

/** 数组单元编辑行（窗口化渲染；模块级组件 ⇒ 可独立 SSR 单测 DOM 行数上界） */
export interface CellRowsProps {
  /** **引用深解析结果的单元表**（零拷贝；本组件只读） */
  readonly cells: readonly ArchiveArrayCell[];
  /** 单元语义标签查询的变量键（适配器 variableSchema 透传） */
  readonly varKey: string;
  readonly schema: VariableSchema | undefined;
  /** 草稿（键 = 下标 join(',')；状态归面板层，保证换变量即清） */
  readonly drafts: Readonly<Record<string, string>>;
  /** 当前渲染窗口行数（undefined = 初始窗口；仅**回落路径**用） */
  readonly limit: number | undefined;
  /** 触底 / 点击「显示更多」→ 追加一窗（仅回落路径用） */
  readonly onGrow: (total: number) => void;
  readonly onDraft: (cellKey: string, value: string) => void;
  /** 「加入清单」（parse 校验 / 入清单语义留在面板层；下标按引用传入） */
  readonly onSubmit: (index: readonly number[], draft: string, oldValue: number | string) => void;
}

export function CellRows(props: CellRowsProps): ReactElement {
  const { cells } = props;
  // 数据集身份 = cells 引用（选中变量 / 换档才换；打字改草稿不动它 ⇒ 不会把滚动弹回顶部）
  const rw = useRowWindow(cells.length, '.inj-cell-row', cells, ' .inj-input');
  const virt = rw.win;
  const appendWin = cellWindowSize(cells.length, props.limit);
  const start = virt ? virt.start : 0;
  const shown = virt ? cells.slice(virt.start, virt.end) : cells.slice(0, appendWin);
  return createElement(
    'div',
    {
      className: 'inj-cells',
      ref: rw.setHost,
      onScroll: rw.onScroll,
      onKeyDown: rw.onKeyDown,
    },
    virt ? listSpacer(virt.topPad, 'pad-top') : null,
    ...shown.map((c, i) => {
      const ik = c.index.join(',');
      const draft = props.drafts[ik] ?? '';
      const changed = draft.trim() !== '' && draft !== String(c.value);
      const cellLbl = cellLabel(props.schema, props.varKey, c.index);
      return createElement(
        'div',
        { key: ik, className: 'inj-cell-row', 'data-row': start + i },
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
    virt ? listSpacer(virt.bottomPad, 'pad-bottom') : null,
    !virt && cells.length > appendWin
      ? createElement(MoreRow, {
          key: 'more',
          remaining: cells.length - appendWin,
          onMore: () => props.onGrow(cells.length),
        })
      : null,
  );
}
