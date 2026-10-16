import { useSyncExternalStore } from 'react';
/**
 * 编辑器字号与文字缩放偏好（A1，2026-10-18）：零 React 纯逻辑 + 极小 React 钩子，可单测。
 *
 * 存法照 `semantic-color-pref.ts` 先例——localStorage 真源 + 订阅表，**不新造第二套偏好机制**。
 * 两条轴分开存：字号是绝对值（px），缩放是倍率档（每档 ±10%，走 Monaco 原生 `editor.EditorZoom`）。
 */

const FONT_SIZE_KEY = 'kojo.ui.fontSize.v1';
const FONT_ZOOM_KEY = 'kojo.ui.fontZoom.v1';

/** 缺省 = 原硬编码值（14px）：偏好落地那天，没人看到界面变化 */
export const FONT_SIZE_DEFAULT = 14;
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 28;

/** 档位钳制与 Monaco `EditorZoom.setZoomLevel` 的内部闸一致（-5..20 ⇒ 50%..300%），两处不许漂移 */
export const FONT_ZOOM_DEFAULT = 0;
export const FONT_ZOOM_MIN = -5;
export const FONT_ZOOM_MAX = 20;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读原始存储值（window 缺席 / 抛错 ⇒ null，即"没存过"） */
function readRaw(key: string): string | null {
  const s = storage();
  if (!s) return null;
  try {
    return s.getItem(key);
  } catch {
    return null;
  }
}

/** 写原始存储值；写不进去静默降级为"本次会话有效" */
function writeRaw(key: string, value: string): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(key, value);
  } catch {
    /* 隐私模式 / 配额满 */
  }
}

/** 解析并钳制（非数字串 / 非有限数 ⇒ 回默认；整数档四舍五入，`Number()` 严格口径：'12px' 也算损坏） */
function parseClamped(raw: string | null, fallback: number, min: number, max: number, integer: boolean): number {
  if (raw === null) return fallback;
  const trimmed = raw.trim();
  const n = trimmed === '' ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, integer ? Math.round(n) : n));
}

export function loadFontSizePref(): number {
  return parseClamped(readRaw(FONT_SIZE_KEY), FONT_SIZE_DEFAULT, FONT_SIZE_MIN, FONT_SIZE_MAX, false);
}

export function loadFontZoomPref(): number {
  return parseClamped(readRaw(FONT_ZOOM_KEY), FONT_ZOOM_DEFAULT, FONT_ZOOM_MIN, FONT_ZOOM_MAX, true);
}

export function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, px));
}

export function clampFontZoom(level: number): number {
  if (!Number.isFinite(level)) return FONT_ZOOM_DEFAULT;
  return Math.min(FONT_ZOOM_MAX, Math.max(FONT_ZOOM_MIN, Math.round(level)));
}

const listeners = new Set<() => void>();

/** 订阅变化（返回取消函数；编辑器卸载时必须取消，否则闭包攥着已 dispose 的编辑器） */
export function subscribeFontSizePref(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyFontSizePref(): void {
  for (const listener of listeners) listener();
}

export function setFontSizePref(px: number): void {
  writeRaw(FONT_SIZE_KEY, String(clampFontSize(px)));
  notifyFontSizePref();
}

/** 步进一档（+1px）；越界由 setFontSizePref 的钳制接住 */
export function stepFontSizePref(delta: number): void {
  setFontSizePref(loadFontSizePref() + delta);
}

export function setFontZoomPref(level: number): void {
  writeRaw(FONT_ZOOM_KEY, String(clampFontZoom(level)));
  notifyFontSizePref();
}

/** 缩放步进：以上一次**持久化**的档位为基准（与 Monaco 内部闸同区间，不会互相顶掉） */
export function stepFontZoomPref(delta: number): void {
  setFontZoomPref(loadFontZoomPref() + delta);
}

export function resetFontZoomPref(): void {
  setFontZoomPref(FONT_ZOOM_DEFAULT);
}

/** 字号生效的唯一入口：Monaco `updateOptions({ fontSize })`（同款结构化最小接口） */
export interface FontSizeTarget {
  updateOptions(options: { fontSize?: number }): void;
}

export function applyFontSizePref(target: FontSizeTarget | null | undefined, px: number = loadFontSizePref()): void {
  if (!target) return;
  target.updateOptions({ fontSize: clampFontSize(px) });
}

/**
 * 缩放生效的唯一入口：写 Monaco 原生 `editor.EditorZoom` 单例（0.57 公开 API）。
 * 参数取结构化最小接口——本模块不依赖 Monaco 类型，node 里用假对象即可钉死生效路径。
 */
export interface FontZoomTarget {
  getZoomLevel(): number;
  setZoomLevel(level: number): void;
}

export function applyFontZoomPref(target: FontZoomTarget | null | undefined, level: number = loadFontZoomPref()): void {
  if (!target) return;
  target.setZoomLevel(clampFontZoom(level));
}

/** React 读数（设置页与快捷键反馈共用） */
export function useFontSizePref(): number {
  return useSyncExternalStore(subscribeFontSizePref, loadFontSizePref);
}

export function useFontZoomPref(): number {
  return useSyncExternalStore(subscribeFontSizePref, loadFontZoomPref);
}
