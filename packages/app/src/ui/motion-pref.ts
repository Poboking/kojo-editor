/**
 * 动效偏好（2026-10-14 HK-4 UI 批 UI-5「动效可关」）：零 React 纯逻辑，可单测。
 *
 * ## 为什么还要一个应用内开关
 *
 * 系统级的 `prefers-reduced-motion` 只反映**操作系统**的设置：用户的系统开着动效、
 * 却只想让这一个编辑器安静，就没有入口。于是本模块在应用内另开一条偏好，落到
 * `<html data-motion>` 属性上，由样式表读取（见 styles.css 的
 * `:root[data-motion='reduced']` 块——与原 `@media (prefers-reduced-motion: reduce)`
 * 等效但条件不同，两条各自独立生效）。
 *
 * ## 纪律
 *
 * - **纯逻辑**：读写 / 应用属性都在这里，React 交互留在 `ShellLayout`（与
 *   `sugar-view.ts` 同款分层，便于单测钉死「读不到就回默认、绝不抛」）。
 * - **壳层私事**：localStorage，与布局同款——不进内核存储域。
 */

/** 动效偏好：`full` = 保留过渡与入场动画；`reduced` = 压到近似零 */
export type MotionPref = 'full' | 'reduced';

/** 偏好键（localStorage） */
const PREF_KEY = 'kojo.ui.motion.v1';

/**
 * 缺省**完整动效**。
 *
 * 减弱动效是「用户主动选择」的降噪，而不是默认替用户做主——默认关掉等于让绝大多数
 * 没被系统设置覆盖到的用户，先失去界面里本就克制的过渡。系统级偏好另有 CSS 兜底。
 */
export const MOTION_PREF_DEFAULT: MotionPref = 'full';

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响本会话） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读偏好（缺省 = `MOTION_PREF_DEFAULT`；读不到 / 非法值也回默认，绝不抛） */
export function loadMotionPref(): MotionPref {
  const s = storage();
  if (!s) return MOTION_PREF_DEFAULT;
  try {
    return s.getItem(PREF_KEY) === 'reduced' ? 'reduced' : MOTION_PREF_DEFAULT;
  } catch {
    return MOTION_PREF_DEFAULT;
  }
}

/** 写偏好（写不进去不算错：只影响下次启动的默认值，不影响本次会话） */
export function saveMotionPref(p: MotionPref): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(PREF_KEY, p);
  } catch {
    /* 隐私模式 / 配额满：静默降级为"本次会话有效" */
  }
}

/**
 * 把偏好写到根元素的 `data-motion` 属性上，供 CSS `:root[data-motion=…]` 读取。
 *
 * `root` 可注入（缺省 `document.documentElement`）——既方便单测在 node 环境用假元素
 * 验证，也让非浏览器环境（无 `document`）安全跳过（同理无 `HTMLElement` 时由类型可选）。
 */
export function applyMotionPref(
  p: MotionPref,
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): void {
  if (!root) return;
  root.setAttribute('data-motion', p);
}

/**
 * 此刻是否「动效已被压平」——应用内开关 **或** 系统偏好，任一成立即为真。
 *
 * ## 为什么 JS 侧也要问这一句
 *
 * CSS 那两条全局规则（`styles.css` 的 `:root[data-motion='reduced']` 与
 * `@media (prefers-reduced-motion: reduce)`）只把 `animation/transition` 的 duration
 * 压到 0.01ms——**动画没了，等待还在**：浮层要等 200ms 才卸、侧栏要等 120ms 才摘
 * DOM、toast 要等 200ms 才消失。开着「减弱动效」的作者换来的是一段什么都没有的空窗
 * （点一下，小半秒后界面才变）。**时序归 JS，动画归 CSS，两边都得知道。**
 *
 * ## 为什么必须只有这一份
 *
 * 1026 动效批两条线各自写过一个同义函数（`overlay-chrome.motionIsFlat` 与
 * `NotificationCenter.skipsExitMotion`），在「无 `document` 时算什么」这个边界上当场
 * 分叉：一个回 true（当压平）、一个回 false（当要动画）。后者靠下游"时长读到 0 就走
 * 同步分支"擦屁股才没出事——那是运气，不是设计。同一条判据不许有第二份实现。
 *
 * 无 `document`（node / happy-dom 裸环境 / SSR）⇒ 回 `true`：没有 DOM 就没有动画可看，
 * 让调用方走同步分支，比让它等一个永远不会到的 `animationend` 安全。
 */
export function motionIsReduced(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.documentElement.getAttribute('data-motion') === 'reduced') return true;
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}
