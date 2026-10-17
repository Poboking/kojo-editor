/**
 * 渲染窗口 ·「显示更多」哨兵（变量目录 / 单元列表共用；从 `index.ts` 原样迁出，
 * DOM 结构与 className 逐字不变）。
 */

import { createElement, useCallback, useEffect, useRef, type ReactElement } from 'react';
import { MORE_ROW_STYLE, MORE_ROW_TITLE, attachGrowSentinel, moreRowLabel } from '@kojo/plugin-api';

/**
 * 「显示更多」哨兵（变量目录 / 单元列表共用）。观察器行为核住在契约层
 * `sugar-panels` 的 `attachGrowSentinel`（进入滚动视口即自动追加下一窗；
 * 观察器不可用——SSR / 测试 / 旧环境——时返回空退订 ⇒ 退化为**纯点击按钮**，
 * 功能不丢）。外观三件套（样式 / 悬停提示 / 「显示更多（还剩 N）」）与其余面板同源
 * 同值，**className 仍是本面板自己的 `inj-more-btn`**（视觉口径不漂）。
 * ref 用稳定回调 ref 拿真实节点，避免每次渲染重挂 observer；回调只在**触发时**经
 * `onMoreRef` 取最新值（observer 只挂一次，捕获旧闭包 = 窗口行为静默改变）。
 */
export function MoreRow({ remaining, onMore }: { remaining: number; onMore: () => void }): ReactElement {
  const anchor = useRef<unknown>(null);
  const setAnchor = useCallback((node: unknown): void => {
    anchor.current = node;
  }, []);
  /** 最新回调引用（observer 只挂一次，不做重复挂卸） */
  const onMoreRef = useRef(onMore);
  onMoreRef.current = onMore;
  useEffect(() => attachGrowSentinel(anchor.current, () => onMoreRef.current()), []);
  return createElement(
    'button',
    {
      ref: setAnchor,
      className: 'ghost small dim inj-more-btn',
      style: MORE_ROW_STYLE,
      title: MORE_ROW_TITLE,
      onClick: () => onMore(),
    },
    moreRowLabel(remaining),
  );
}
