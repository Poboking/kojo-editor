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
