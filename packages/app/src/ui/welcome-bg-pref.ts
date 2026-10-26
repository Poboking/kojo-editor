import { useSyncExternalStore } from 'react';

/**
 * 欢迎页背景档（2026-10-26 用户反馈批）：「素雅（默认）/ 极光 / 纯色」三档。
 *
 * 存法与生效链照 `glass-pref.ts` / `motion-pref.ts` 先例：localStorage 真源 + 订阅表，
 * 生效是把值写到根元素的 `data-welcome-bg`，由 `welcome.css` 读取（设置页一改，
 * 下次回到欢迎页就是新背景；项目态里本页不渲染，没有"当场重绘整页"的负担）。
 *
 * ## 为什么不进开机图
 *
 * 欢迎页只认 CSS 属性，不需要 React 读数：开机时由 `main.tsx` 动态 import 播种一次
 * （与字体档位那条同法），设置页（懒挂载）改档时再写一次。模块因此不占 PS-10 开机图
 * 文件预算——首屏为此多背一个模块不值得，而缺省档（素雅）本来就是首帧默认。
 *
 * ## 三档的分工
 *
 * - `quiet`（缺省）：细点阵 + 一枚极淡 accent 光晕。静态、零动画，颜色全部从 `--fg` /
 *   `--accent` 派生（light / mint 自动翻相），和深色主题的中性面同族；
 * - `aurora`：原三团呼吸光斑（主题 accent 派生），保留为选项；
 * - `plain`：只剩主题底色，一点装饰都不画。
 */

/** 偏好键（localStorage） */
const WELCOME_BG_KEY = 'kojo.ui.welcome.background.v1';

/** 三档的登记 id（写进 `data-welcome-bg` 的就是这些字面量） */
export const WELCOME_BG_IDS = ['quiet', 'aurora', 'plain'] as const;
export type WelcomeBgPref = (typeof WELCOME_BG_IDS)[number];

/**
 * 缺省 = 素雅：用户反馈「背景过于花哨」，同时要求「简约但仍有辨识度」——
 * 点阵纸 + 一枚远光晕正是这个刻度；极光降为可选项，不再替所有人做决定。
 */
export const WELCOME_BG_DEFAULT: WelcomeBgPref = 'quiet';

/** localStorage 访问器（node 测试 / 隐私模式都可能没有或抛错——都不该影响本会话） */
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
    return s.getItem(WELCOME_BG_KEY);
  } catch {
    return null;
  }
}

function writeRaw(value: string): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(WELCOME_BG_KEY, value);
  } catch {
    /* 隐私模式 / 配额满：本次会话仍按内存值生效 */
  }
}

/** 归一化（未知值 / 空串 / 非字符串一律回缺省；绝不把脏值写进 `data-welcome-bg`） */
export function normalizeWelcomeBg(raw: unknown): WelcomeBgPref {
  return typeof raw === 'string' && (WELCOME_BG_IDS as readonly string[]).includes(raw)
    ? (raw as WelcomeBgPref)
    : WELCOME_BG_DEFAULT;
}

/** 读当前档（读不到 / 非法值回缺省，绝不抛） */
export function loadWelcomeBgPref(): WelcomeBgPref {
  return normalizeWelcomeBg(readRaw());
}

const listeners = new Set<() => void>();

export function subscribeWelcomeBg(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyWelcomeBg(): void {
  for (const listener of listeners) listener();
}

/** 写档位（先归一化再存）+ 立刻落根属性 + 通知订阅者 */
export function setWelcomeBgPref(value: WelcomeBgPref): void {
  const normalized = normalizeWelcomeBg(value);
  writeRaw(normalized);
  applyWelcomeBgPref(normalized);
  notifyWelcomeBg();
}

/** 回缺省档 */
export function resetWelcomeBgPref(): void {
  setWelcomeBgPref(WELCOME_BG_DEFAULT);
}

/** 根元素最小接口（与 `GlassRoot` 同款：node 里喂一枚假元素即可钉死生效路径） */
export interface WelcomeBgRoot {
  setAttribute(name: string, value: string): void;
}

/**
 * 生效的唯一入口：把档位写到根元素的 `data-welcome-bg`。
 * 缺省 `document.documentElement`；无 `document` 环境（SSR / 单测）安全跳过。
 */
export function applyWelcomeBgPref(
  value: WelcomeBgPref = loadWelcomeBgPref(),
  root: WelcomeBgRoot | null = typeof document === 'undefined'
    ? null
    : (document.documentElement as unknown as WelcomeBgRoot),
): void {
  if (!root) return;
  root.setAttribute('data-welcome-bg', normalizeWelcomeBg(value));
}

/** React 读数（设置页分段控件用） */
export function useWelcomeBgPref(): WelcomeBgPref {
  return useSyncExternalStore(subscribeWelcomeBg, loadWelcomeBgPref);
}
