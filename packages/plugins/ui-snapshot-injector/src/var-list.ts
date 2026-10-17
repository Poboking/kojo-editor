/**
 * 变量目录列表（从 `index.ts` 原样迁出；DOM 结构与 className 逐字不变）。
 * 组件只渲染窗口，过滤 / 选中 / 草稿语义留在面板层。
 */

import { createElement, type ReactElement } from 'react';
import type { VariableSchema } from '@kojo/plugin-api';
import { varLabel, varWindowSize, type VarRow } from './panel-logic';
import { MoreRow } from './more-row';

/** 变量目录（窗口化渲染；模块级组件 ⇒ 可独立 SSR 单测 DOM 行数上界） */
export interface VarListProps {
  /** 已过滤（过滤语义在面板层，组件只渲染窗口） */
  readonly rows: readonly VarRow[];
  readonly selectedKey: string | null;
  /** 变量语义标签查询（适配器 variableSchema 透传；undefined = 无标签，照常渲染） */
  readonly schema: VariableSchema | undefined;
  /** 当前渲染窗口行数（undefined = 初始窗口） */
  readonly limit: number | undefined;
  /** 触底 / 点击「显示更多」→ 追加一窗（新值由 growWindow(prev, total, VAR_WINDOW) 计算） */
  readonly onGrow: (total: number) => void;
  /** 选中变量（选中 / 清空编辑草稿语义留在面板层） */
  readonly onSelect: (key: string) => void;
}

export function VarList(props: VarListProps): ReactElement {
  const { rows } = props;
  const win = varWindowSize(rows.length, props.limit);
  return createElement(
    'div',
    { className: 'inj-vars' },
    ...rows.slice(0, win).map((r) => {
      const label = varLabel(props.schema, r.key);
      return createElement(
        'button',
        {
          key: r.key,
          className: `inj-var-row${props.selectedKey === r.key ? ' active' : ''}${r.kind === 'other' ? ' disabled' : ''}`,
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
    rows.length > win
      ? createElement(MoreRow, {
          key: 'more',
          remaining: rows.length - win,
          onMore: () => props.onGrow(rows.length),
        })
      : null,
    rows.length === 0 ? createElement('div', { className: 'dim inj-empty' }, '该作用域没有变量') : null,
  );
}
