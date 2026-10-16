import { useSyncExternalStore } from 'react';
/**
 * 主题偏好（VSCode 精修批续·主题系统 2026-10-17）：零 React 纯逻辑 + 极小 React 钩子，可单测。
 *
 * 存法照 `glass-pref.ts` / `motion-pref.ts` 先例——localStorage 真源 + 订阅表，**不新造第二套
 * 偏好机制**；生效路径同款：把值写到根元素的 `data-theme` 属性上，由 `themes/*.css` 的
 * `:root[data-theme='…']` 块读取（换主题只翻 token 值，不动组件规则）。设置页一翻当场见效。
 *
 * ## 三档
 * - `dark`：**缺省**，本仓既有蓝灰深色（`styles.css` 的 `:root` 就是它，值一律不动）。
 * - `light`：中性浅色（`themes/light.css`），VSCode Light+ 气质、保留蓝灰身份。
 * - `mint-dark`：薄荷暗色（`themes/mint-dark.css`），参考 Qoder 薄荷暗色。
 *
 * ## 缺省 dark 的理由
 * 主题是**替用户做的全局视觉决定**，本仓一贯「改视觉面默认克制」——不擅自把默认色换成新主题。
 * dark 下 `:root` 基础 token 原样生效，主题文件里 `[data-theme='dark']` 不写任何覆盖即可
 * （缺省态由基础 `:root` 承担），故首屏 splash 的硬编码 `#1e2227` 在默认档仍与 `--bg` 相等
 * （`tools/smoke-tauri-dom.mjs` 断言①钉的那条不变量不破坏）。
 */

export type ThemePref = 'dark' | 'light' | 'mint-dark';

/** 偏好键（localStorage） */
const THEME_KEY = 'kojo.ui.theme.v1';

/** 缺省 = dark（既有蓝灰深色） */
export const THEME_PREF_DEFAULT: ThemePref = 'dark';

/** 全部合法主题（设置页选择器与 `applyThemePref` 校验共用这张表，单源不抄第二份） */
export const THEME_IDS: readonly ThemePref[] = ['dark', 'light', 'mint-dark'];

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响本会话） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readRaw(): string | null {
  const s = storage();
  if (!s) return null;
  try {
    return s.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function writeRaw(value: string): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(THEME_KEY, value);
  } catch {
    /* 隐私模式 / 配额满：静默降级为"本次会话有效" */
  }
}

/** 归一：非法/缺席一律回缺省 dark（绝不让脏值进 `data-theme`） */
export function normalizeTheme(raw: string | null | undefined): ThemePref {
  return raw === 'light' || raw === 'mint-dark' ? raw : THEME_PREF_DEFAULT;
}

/** 读主题偏好（缺省 dark；读不到 / 非法值也回默认，绝不抛） */
export function loadThemePref(): ThemePref {
  return normalizeTheme(readRaw());
}

const listeners = new Set<() => void>();

/** 订阅变化（返回取消函数） */
export function subscribeThemePref(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyThemePref(): void {
  for (const listener of listeners) listener();
}

/** 写主题（先归一再存）+ 通知订阅者 */
export function setThemePref(t: ThemePref): void {
  writeRaw(normalizeTheme(t));
  notifyThemePref();
}

/**
 * 应用生效的唯一入口：把主题写到根元素的 `data-theme` 属性上，供 `themes/*.css` 读取。
 *
 * `root` 取**结构化最小接口**（只要求 `setAttribute`）：本模块因此不依赖 DOM 类型，node 里用
 * 一枚假元素即可钉死生效路径；缺省 `document.documentElement`，无 `document` 环境安全跳过。
 */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
}

export function applyThemePref(
  t: ThemePref = loadThemePref(),
  root: ThemeRoot | null = typeof document === 'undefined' ? null : (document.documentElement as unknown as ThemeRoot),
): void {
  if (!root) return;
  root.setAttribute('data-theme', normalizeTheme(t));
}

/** React 读数（设置页选择器用） */
export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribeThemePref, loadThemePref);
}
