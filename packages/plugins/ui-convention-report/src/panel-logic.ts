/**
 * 约定校验结果面板纯逻辑（零 React，可单测）：条目列表的渲染窗口。
 *
 * 面板组件只做状态搬运（订阅报告、展开/收起、窗口增长），窗口的数值口径住在这里；
 * 分组构造在 `view.ts`、归属判据在 `ownership.ts`——三者职责互不重叠。
 *
 * 窗口**数学**（`windowSize` / `nextWindow`）住在契约层 `sugar-panels`，与两块糖面板
 * 同一把尺；本文件只声明本面板的**窗口参数**（取值未动：80/160）。
 */

import { nextWindow, windowSize, type RenderWindow } from '@kojo/plugin-api';

/**
 * 单组条目列表的渲染窗口（触底增窗）。
 *
 * 旧实现是「每组硬截 300 条 + 一键显示全部」两阶段：前者第 301 条起不可达，后者
 * 一次把整组挂上 DOM（上万行时直接拖垮面板）。窗口化后 INITIAL 是首帧 DOM 上界，
 * 滚动触底或点击「显示更多」按 STEP 增长，全量可达且单步增量有界。
 * 取值：条目行单行 ~20px（与函数树行同高），沿用 80 / 160 的 1:2 节奏。
 */
export const ISSUE_WINDOW: RenderWindow = { initial: 80, step: 160 };
/** 初始窗口行数（旧导出名，测试与面板都按它钉首帧行数） */
export const ISSUE_WINDOW_INITIAL = ISSUE_WINDOW.initial;
/** 每次追加的行数（旧导出名） */
export const ISSUE_WINDOW_STEP = ISSUE_WINDOW.step;

/** 当前窗口应渲染的行数（纯函数）：[0, min(total, limit ?? INITIAL)] */
export function issueWindowSize(total: number, limit: number | undefined): number {
  return windowSize(total, limit, ISSUE_WINDOW);
}

/**
 * 窗口下一步（纯函数）：min(total, max(INITIAL, 当前 + STEP))。
 * 单调不减、单步增量 ≤ STEP、终值 = total——「显示更多」与触底自动加载共用。
 */
export function nextIssueWindow(current: number | undefined, total: number): number {
  return nextWindow(current, total, ISSUE_WINDOW);
}
