import { useSyncExternalStore } from 'react';
/**
 * 毛玻璃透明度偏好（2026-10-17 教程打磨批）：零 React 纯逻辑 + 极小 React 钩子，可单测。
 *
 * 存法照 `font-size-pref.ts` / `semantic-color-pref.ts` 先例——localStorage 真源 + 订阅表，
 * **不新造第二套偏好机制**。生效路径照 `motion-pref.ts`：把值写到根元素上（一个 CSS 自定义
 * 属性 + 一个 `data-glass` 属性），由样式表读取，翻完设置页当场见效、不用重开浮层。
 *
 * ## 为什么是"透明度"而不是"模糊半径"
 *
 * 磨砂玻璃有两根轴：模糊（`--glass-blur`，样式里的常量）与填充不透明度（`--glass-alpha`）。
 * 暴露给用户的只需一根——**透明度**：它同时决定"能透出多少背后的虚化"，是从"实心"到"通透"
 * 最直觉的一根滑块。模糊半径留在样式里当设计常量，不做成第二个要用户理解的量纲。
 *
 * 旋钮值 = 透明度百分比（0=实心 … 60=通透），落到根元素时换算成填充不透明度
 * `--glass-alpha = (100 - T) / 100`。0% 另落 `data-glass='solid'`，样式据此**撤掉** backdrop-filter
 * 回到改动前的实心面（省电，也给不喜欢毛玻璃的人一个干净出口）。
 *
 * ## 纪律
 *
 * - **纯逻辑**：读写 / 换算 / 应用属性都在这里，React 交互留在 `ShellLayout`（与 `motion-pref.ts`
 *   同款分层，便于单测钉死「读不到就回默认、绝不抛」）。
 * - **壳层私事**：localStorage，与布局 / 动效同款——不进内核存储域。
 */

/** 偏好键（localStorage） */
const GLASS_KEY = 'kojo.ui.glassTransparency.v1';

/**
 * 缺省 15%：一点克制的通透，够让浮层与背后拉开层次，又不至于把长文阅读面透花。
 * 教程是"读"的界面——默认值偏保守是本仓「改视觉面的新功能克制默认」的一贯口径。
 */
export const GLASS_TRANSPARENCY_DEFAULT = 15;
export const GLASS_TRANSPARENCY_MIN = 0;
export const GLASS_TRANSPARENCY_MAX = 60;
/** 每档 5%：百分比旋钮用 ±1 太碎、±10 太跳，5% 一档刚好够细又能几步走完全程 */
export const GLASS_TRANSPARENCY_STEP = 5;

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响本会话） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读原始存储值（window 缺席 / 抛错 ⇒ null，即"没存过"） */
function readRaw(): string | null {
  const s = storage();
  if (!s) return null;
  try {
    return s.getItem(GLASS_KEY);
  } catch {
    return null;
  }
}

/** 写原始存储值；写不进去静默降级为"本次会话有效" */
function writeRaw(value: string): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(GLASS_KEY, value);
  } catch {
    /* 隐私模式 / 配额满 */
  }
}

/** 纯钳制（非有限数 ⇒ 回默认；小数四舍五入到整数档，NaN 绝不进渲染链） */
export function clampGlassTransparency(t: number): number {
  if (!Number.isFinite(t)) return GLASS_TRANSPARENCY_DEFAULT;
  return Math.min(GLASS_TRANSPARENCY_MAX, Math.max(GLASS_TRANSPARENCY_MIN, Math.round(t)));
}

/** 解析存储串（空串 / 文字 / '12%' 都算损坏 ⇒ 回默认，口径同 font-size-pref 的 `Number()` 严格档） */
function parseClamped(raw: string | null): number {
  if (raw === null) return GLASS_TRANSPARENCY_DEFAULT;
  const trimmed = raw.trim();
  const n = trimmed === '' ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(n)) return GLASS_TRANSPARENCY_DEFAULT;
  return clampGlassTransparency(n);
}

/** 读透明度百分比（缺省 = `GLASS_TRANSPARENCY_DEFAULT`；读不到 / 非法值也回默认，绝不抛） */
export function loadGlassTransparencyPref(): number {
  return parseClamped(readRaw());
}

/**
 * 透明度百分比 → CSS 填充不透明度（`--glass-alpha`）。
 *
 * 单拎出来是为了让"旋钮值"与"样式真正吃的那个数"之间的换算只有一处、可单测钉死：
 * 0% → 1（实心）、15% → 0.85、60% → 0.4。整数档换算天然是干净的两位小数。
 */
export function glassAlphaFromTransparency(t: number): number {
  return (100 - clampGlassTransparency(t)) / 100;
}

const listeners = new Set<() => void>();

/** 订阅变化（返回取消函数） */
export function subscribeGlassPref(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyGlassPref(): void {
  for (const listener of listeners) listener();
}

/** 写透明度（先钳制再存）+ 通知订阅者 */
export function setGlassTransparencyPref(t: number): void {
  writeRaw(String(clampGlassTransparency(t)));
  notifyGlassPref();
}

/** 步进一档（dir=±1，一档 = `GLASS_TRANSPARENCY_STEP` %）；越界由 set 的钳制接住 */
export function stepGlassTransparencyPref(dir: number): void {
  setGlassTransparencyPref(loadGlassTransparencyPref() + dir * GLASS_TRANSPARENCY_STEP);
}

/** 回到缺省（15%） */
export function resetGlassTransparencyPref(): void {
  setGlassTransparencyPref(GLASS_TRANSPARENCY_DEFAULT);
}

/**
 * 应用生效的唯一入口：把透明度换算成 `--glass-alpha` 写到根元素的 style 上，
 * 并按"是否实心"落 `data-glass`（供样式在 0% 时撤掉 backdrop-filter）。
 *
 * `root` 取**结构化最小接口**（只要求 `setAttribute` 与 `style.setProperty`）：本模块因此不依赖
 * DOM 类型，node 里用一枚假元素即可钉死生效路径；缺省 `document.documentElement`，无 `document`
 * 环境（SSR / 单测）安全跳过。
 */
export interface GlassRoot {
  setAttribute(name: string, value: string): void;
  style: { setProperty(name: string, value: string): void };
}

export function applyGlassPref(
  t: number = loadGlassTransparencyPref(),
  root: GlassRoot | null = typeof document === 'undefined' ? null : (document.documentElement as unknown as GlassRoot),
): void {
  if (!root) return;
  const clamped = clampGlassTransparency(t);
  root.style.setProperty('--glass-alpha', String(glassAlphaFromTransparency(clamped)));
  // 0% = 实心档：样式据此关掉磨砂，回到不透明面（一个干净的"关"出口）
  root.setAttribute('data-glass', clamped === GLASS_TRANSPARENCY_MIN ? 'solid' : 'on');
}

/** React 读数（设置页旋钮用） */
export function useGlassTransparencyPref(): number {
  return useSyncExternalStore(subscribeGlassPref, loadGlassTransparencyPref);
}
