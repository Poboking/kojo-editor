/**
 * 数组单元编辑行（从 `index.ts` 原样迁出；DOM 结构与 className 逐字不变）。
 * 组件只渲染窗口与草稿，parse 校验 / 入清单语义留在面板层。
 *
 * 两条渲染路径同 `var-list.ts`（PS-7 回收行）：偏好开了且量到几何就只挂视口 ± 缓冲，
 * 否则沿用改动前的「追加式窗口 + 显示更多」。
 *
 * 键盘：行壳是 `div`，可聚焦的是行内输入框 ⇒ ↑↓ 漫游把焦点落在**下一行的输入框**
 * （`focusInside`）。左右键留给光标，不改写输入框里的行为。
 *
 * ## 这一列是**录入面**：正在输入的行不能被摘
 *
 * `.inj-cells` 只有 200px 高（≈ 9 行可见 + 上下各 6 行缓冲）⇒ 七行滚轮就把焦点所在
 * 的 `<input>` 卸载掉：日文**尚未上屏的合成串**随之静默丢弃（草稿只存上屏后的值），
 * 之后 Tab / ↑↓ 只能从文档顶部重来。这里按 VSCode `WorkbenchList` 的口径处理
 * （它复用 DOM 但只维持一个托管焦点，且正在编辑的行不会从编辑器底下被回收走）：
 * - 输入法合成期间**冻结窗口**（`onCompositionStart` / `onCompositionEnd`）⇒ 合成串必然活到上屏；
 * - 平时把焦点行**钉在窗口内**（扩窗代价有上限）；
 * - 钉不住（超限）就先把该行的光标选区记进账，等它重新进窗把焦点与选区放回去。
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
  /**
   * 允许回收行（宿主偏好 `uiPrefs.panelVirtualize` 的投影；**缺省 / false = 改动前的追加式路径**）。
   * 这一列是打字录入的地方，窗口化会动到"正在输入的行还在不在"，故默认保守地不回收。
   */
  readonly virtualize?: boolean;
}

export function CellRows(props: CellRowsProps): ReactElement {
  const { cells } = props;
  // 数据集身份 = cells 引用（选中变量 / 换档才换；打字改草稿不动它 ⇒ 不会把滚动弹回顶部）
  const rw = useRowWindow(cells.length, '.inj-cell-row', cells, ' .inj-input', props.virtualize === true);
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
      // 焦点记账（钉窗 + 回窗落焦的输入）与输入法合成闸（合成中绝不缩窗）
      onFocus: rw.onFocusIn,
      onBlur: rw.onFocusOut,
      onCompositionStart: rw.onCompositionStart,
      onCompositionEnd: rw.onCompositionEnd,
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
