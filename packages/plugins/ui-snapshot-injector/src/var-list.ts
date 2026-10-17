/**
 * 变量目录列表（从 `index.ts` 原样迁出；DOM 结构与 className 逐字不变）。
 * 组件只渲染窗口，过滤 / 选中 / 草稿语义留在面板层。
 *
 * 两条渲染路径（PS-7 回收行）：
 * - **量到几何**（容器有高度、行高量到了、而且确实超过一屏）⇒ 只渲染视口 ± 缓冲，
 *   上下各一块占位撑出同样的滚动条；滚出即撤、滚入即建，全部行仍靠滚动可达；
 * - **量不到**（SSR / 首帧 / 无 ResizeObserver / 短到不足一屏）⇒ 沿用改动前的
 *   「追加式窗口 + 显示更多」，一行不多一行不少。
 * 回落不是静默降级：两条路径都能到底，只是回收路径不必把看过的行一直背在 DOM 里。
 */

import { createElement, type ReactElement } from 'react';
import type { VariableSchema } from '@kojo/plugin-api';
import { varLabel, varWindowSize, type VarRow } from './panel-logic';
import { listSpacer, useRowWindow } from './list-window';
import { MoreRow } from './more-row';

/** 变量目录（窗口化渲染；模块级组件 ⇒ 可独立 SSR 单测 DOM 行数上界） */
export interface VarListProps {
  /** 已过滤（过滤语义在面板层，组件只渲染窗口） */
  readonly rows: readonly VarRow[];
  readonly selectedKey: string | null;
  /** 变量语义标签查询（适配器 variableSchema 透传；undefined = 无标签，照常渲染） */
  readonly schema: VariableSchema | undefined;
  /** 当前渲染窗口行数（undefined = 初始窗口；仅**回落路径**用） */
  readonly limit: number | undefined;
  /** 触底 / 点击「显示更多」→ 追加一窗（仅回落路径用；回收路径靠滚动到达全部行） */
  readonly onGrow: (total: number) => void;
  /** 选中变量（选中 / 清空编辑草稿语义留在面板层） */
  readonly onSelect: (key: string) => void;
}

export function VarList(props: VarListProps): ReactElement {
  const { rows } = props;
  // 数据集身份 = rows 引用（面板侧按 档案 × 作用域 × 过滤词 记忆化 ⇒ 只在真换数据时重置）
  const rw = useRowWindow(rows.length, '.inj-var-row', rows);
  const virt = rw.win;
  const appendWin = varWindowSize(rows.length, props.limit);
  const start = virt ? virt.start : 0;
  const shownRows = virt ? rows.slice(virt.start, virt.end) : rows.slice(0, appendWin);
  return createElement(
    'div',
    {
      className: 'inj-vars',
      ref: rw.setHost,
      onScroll: rw.onScroll,
      onKeyDown: rw.onKeyDown,
    },
    virt ? listSpacer(virt.topPad, 'pad-top') : null,
    ...shownRows.map((r, i) => {
      const label = varLabel(props.schema, r.key);
      return createElement(
        'button',
        {
          key: r.key,
          className: `inj-var-row${props.selectedKey === r.key ? ' active' : ''}${r.kind === 'other' ? ' disabled' : ''}`,
          // data-row = **绝对行号**（窗口外的行不存在，行号仍与数据序一致 ⇒ ↑↓ 据此平移）
          'data-row': start + i,
          disabled: r.kind === 'other',
          title: r.cellsTruncated ? '该数组未能完整读取，无法改写' : r.preview,
          onClick: () => props.onSelect(r.key),
        },
        createElement('span', { className: 'inj-var-key' }, r.key),
        label ? createElement('span', { className: 'inj-var-label' }, label) : null,
        createElement('span', { className: 'inj-var-preview dim' }, r.preview),
        r.cellsTruncated ? createElement('span', { className: 'inj-warn' }, '未完整读取') : null,
      );
    }),
    virt ? listSpacer(virt.bottomPad, 'pad-bottom') : null,
    // 哨兵只在回落路径出现：回收路径下滚动本身就够到达全部行，再挂按钮就是第二套口径
    !virt && rows.length > appendWin
      ? createElement(MoreRow, {
          key: 'more',
          remaining: rows.length - appendWin,
          onMore: () => props.onGrow(rows.length),
        })
      : null,
    rows.length === 0 ? createElement('div', { className: 'dim inj-empty' }, '该作用域没有变量') : null,
  );
}
