/**
 * 变量目录列表（从 `index.ts` 原样迁出；DOM 结构与 className 逐字不变）。
 * 组件只渲染窗口，过滤 / 选中 / 草稿语义留在面板层。
 *
 * 两条渲染路径（PS-7 回收行）：
 * - **开了回收且量到几何**（宿主偏好 `uiPrefs.panelVirtualize` + 容器有高度 + 行高量到 +
 *   确实超过一屏）⇒ 只渲染视口 ± 缓冲，上下各一块占位撑出同样的滚动条；滚出即撤、
 *   滚入即建，**全部行仍靠键盘可达**（↑↓ 会跳过禁用行、会把窗口外的行滚进来再落焦）；
 * - **其余一切**（偏好没开 / SSR / 首帧 / 无 ResizeObserver / 短到不足一屏）⇒ 沿用改动前的
 *   「追加式窗口 + 显示更多」，一行不多一行不少。
 * 回落不是静默降级：两条路径都能到底，只是回收路径不必把看过的行一直背在 DOM 里。
 *
 * 键盘分工（回收批的裁决，改这里前先读）：**↑↓ = 列表漫游**（本层接管，跨窗唯一通道）、
 * **Tab / Shift+Tab = 浏览器原生焦点顺序**（只在已渲染行之间移动，本层不接管）、
 * **←→ 不给行**（留给行内控件）。禁用行（`kind === 'other'`）拿不到焦点 ⇒ 漫游**跳过**它，
 * 那个方向没有可落焦的行时**不拦键**，绝不出现"按了没反应"。
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
  /**
   * 允许回收行（宿主偏好 `uiPrefs.panelVirtualize` 的投影；**缺省 / false = 改动前的
   * 追加式路径**）。面板是数据录入面，窗口化会改键盘可达与输入态的存续，
   * 按契约「缺省 = 最保守值」必须由用户在设置页显式开。
   */
  readonly virtualize?: boolean;
}

export function VarList(props: VarListProps): ReactElement {
  const { rows } = props;
  // 数据集身份 = rows 引用（面板侧按 档案 × 作用域 × 过滤词 记忆化 ⇒ 只在真换数据时重置）
  const rw = useRowWindow(rows.length, '.inj-var-row', rows, '', props.virtualize === true);
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
      // 焦点记账 + 合成冻结（行是按钮：只有前两条用得上，仍一并挂上 = 与单元行同一套口径）
      onFocus: rw.onFocusIn,
      onBlur: rw.onFocusOut,
      onCompositionStart: rw.onCompositionStart,
      onCompositionEnd: rw.onCompositionEnd,
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
