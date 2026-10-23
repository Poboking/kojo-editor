/**
 * 面函数列表（**窗口化渲染**）与「显示更多」触底哨兵行。
 *
 * 从 `index.ts` 的「面行窗口」区块原样迁出：DOM 结构、`className`、文案逐字不变。
 * 模块级组件 ⇒ 可独立 SSR 单测 DOM 行数上界（`packages/app/tests/face-list-render.test.ts`）。
 * 窗口数学（初始/步长/单调性）不住这里，见 `tree.ts` 的 `faceWindowSize` / `nextFaceWindow`。
 */

import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from 'react';
import { MORE_ROW_TITLE, attachGrowSentinel } from '@kojo/plugin-api';
import type { PluginContextMenuAnchor } from '@kojo/plugin-api';
import { faceWindowSize, type FunctionNode } from './tree';

/* ------------------------------ 面行窗口 ------------------------------ */

/**
 * 「显示更多」哨兵行（面窗口触底器）。
 *
 * 观察器行为核住在契约层 `sugar-panels` 的 `attachGrowSentinel`（进入滚动视口即
 * 增窗一次；观察器不可用——SSR / 测试 / 旧环境——时返回空退订 ⇒ 退化为**纯点击
 * 按钮**，功能不丢）。本面板**自带 markup 与文案**：行壳是 `<li class="nav-more">`
 * 里的 `<button class="nav-more-btn">`、文案是「显示更多（其余 N 个）」，与谓词/变量
 * 那三块面板的 `…-more-btn` 按钮语言不同——**视觉口径不许被共享默认值带走**，
 * 这里只共享行为核（悬停 `title` 四处同文，故走 `MORE_ROW_TITLE`）。
 * ref 仍用**稳定回调 ref**（`useCallback` 空依赖）拿真实节点，避免每次渲染重挂 observer。
 */
function MoreRow({ remaining, onMore }: { remaining: number; onMore: () => void }): ReactElement {
  const anchor = useRef<unknown>(null);
  const setAnchor = useCallback((node: unknown): void => {
    anchor.current = node;
  }, []);
  /** 最新回调引用（observer 只挂一次，不做重复挂卸 ⇒ 回调必须在触发时才取） */
  const onMoreRef = useRef(onMore);
  onMoreRef.current = onMore;
  useEffect(() => attachGrowSentinel(anchor.current, () => onMoreRef.current()), []);
  return createElement(
    'li',
    { ref: setAnchor, className: 'nav-more' },
    createElement(
      'button',
      {
        className: 'nav-more-btn',
        title: MORE_ROW_TITLE,
        onClick: () => onMore(),
      },
      `显示更多（其余 ${remaining} 个）`,
    ),
  );
}

/** 面函数列表（窗口化渲染；模块级组件 ⇒ 可独立 SSR 单测 DOM 行数上界） */
export interface FaceListProps {
  /** 面窗口键（`chara|family|face`——`onGrow` 按它定位窗口） */
  readonly faceKey: string;
  readonly functions: readonly FunctionNode[];
  /** 当前渲染窗口行数（undefined = 初始窗口） */
  readonly limit: number | undefined;
  /** 请求扩大该面窗口（新值由 `nextFaceWindow` 计算） */
  readonly onGrow: (faceKey: string, total: number) => void;
  /** 行尾徽章（条件 / 回放；宿主闭包提供） */
  readonly badges: (fn: FunctionNode) => ReactNode[];
  /** 点击行 = 跳函数意图 */
  readonly onOpen: (fn: FunctionNode) => void;
  /** 悬停提示 */
  readonly tooltip: (fn: FunctionNode) => string;
  /**
   * 右键函数行（1023 批，可选）：交给宿主统一渲染的菜单。
   * 缺省 = 没有右键菜单（旧调用方与 SSR 判据零改动）。
   */
  readonly onMenu?: (fn: FunctionNode, event: PluginContextMenuAnchor) => void;
}

export function FaceList(props: FaceListProps): ReactElement {
  const { functions, limit } = props;
  const win = faceWindowSize(functions.length, limit);
  const rows = functions.slice(0, win);
  return createElement(
    'ul',
    { className: 'nav-funcs' },
    ...rows.map((fn) =>
      createElement(
        'li',
        {
          key: `${fn.filePath}:${fn.startLine}`,
          ...(props.onMenu === undefined
            ? {}
            : { onContextMenu: (e: PluginContextMenuAnchor) => props.onMenu?.(fn, e) }),
        },
        createElement(
          'button',
          {
            className: 'nav-func-btn',
            title: props.tooltip(fn),
            onClick: () => props.onOpen(fn),
          },
          createElement('span', { className: 'nav-func-name' }, fn.name),
          ...props.badges(fn),
        ),
      ),
    ),
    functions.length > win
      ? createElement(MoreRow, {
          key: 'more',
          remaining: functions.length - win,
          onMore: () => props.onGrow(props.faceKey, functions.length),
        })
      : null,
  );
}
