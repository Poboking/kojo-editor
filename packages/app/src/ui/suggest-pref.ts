import { useSyncExternalStore } from 'react';
/**
 * 补全偏好（SUGGEST-2B / QSUG-2，2026-10-18）：延迟 + 「输入时自动弹出」+「文档词」三个开关；
 * 零 React 纯逻辑 + 极小 React 钩子，可单测。
 *
 * 存法照 `semantic-color-pref.ts` / `font-size-pref.ts` 先例 —— localStorage 真源 + 订阅表，
 * **不新造第二套偏好机制**；设置页一翻、编辑器下一次排程就按新值走（观察者每次现取，
 * 不在安装时定死），不用重开文件。
 *
 * ## 默认 0ms = 现有"打字即弹"的体感
 *
 * 主动触发观察者（`suggest-context-trigger.ts`）自 1017 批起以 0ms 合并同拍事件；偏好落地
 * 那天不改变任何人的现有手感。作者只有在手动调高之后才看到"停手多久才弹"。
 *
 * ## 取值范围
 *
 * 0–1000ms、设置页每档 100ms。观察者侧另有一道 0–2000ms 的硬夹取（防手改 localStorage
 * 造出几十分钟的定时器）；本模块只对作者可调区间负责，两处夹取都**绝不抛进渲染链**。
 *
 * ## 为什么读数不做"单一快照缓存"
 *
 * `loadSuggestDelayPref` 每次现读 localStorage：真源只有一份，devtools / 另一窗口改了也立即生效；
 * 读取失败（隐私模式 / node 测试环境）静默回默认。单次是微秒级的小字符串读取，不构成每击键的
 * 可见开销；真壳复跑读数（千次 getItem 均值 + 击键到弹窗可见的 p50/p95）见本批交付回执。
 */

/** 偏好键（localStorage） */
const PREF_KEY = 'kojo.ui.suggestDelay.v1';
/** 输入时自动弹出补全（quickSuggestions） */
const QUICK_KEY = 'kojo.ui.quickSuggestions.v1';
/** 文档词补全（语义对位 Monaco 的 wordBasedSuggestions，但走语言侧位置门） */
const WORD_KEY = 'kojo.ui.wordBasedSuggestions.v1';

/** 缺省 = 0ms：保持"打字即弹"的现有体感，设置后才变慢 */
export const SUGGEST_DELAY_DEFAULT = 0;
/** 设置页可调下限（= 立即） */
export const SUGGEST_DELAY_MIN = 0;
/** 设置页可调上限 */
export const SUGGEST_DELAY_MAX = 1000;
/** 设置页每档（− / ＋） */
export const SUGGEST_DELAY_STEP = 100;

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响补全） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 夹到可调区间；非有限数回默认（损坏口径，绝不把 NaN 交给 setTimeout） */
export function clampSuggestDelay(ms: number): number {
  if (!Number.isFinite(ms)) return SUGGEST_DELAY_DEFAULT;
  return Math.min(SUGGEST_DELAY_MAX, Math.max(SUGGEST_DELAY_MIN, Math.round(ms)));
}

/**
 * 读偏好：没存过 / 存坏 / 读抛错一律回默认。
 *
 * `Number()` 严格口径（`'12ms'` / 空串 / 文字都算损坏；与 `font-size-pref` 同一口径），
 * 越界值夹到区间两端（手改过的 localStorage 不给渲染链留下定时器炸弹）。
 */
export function loadSuggestDelayPref(): number {
  const s = storage();
  if (!s) return SUGGEST_DELAY_DEFAULT;
  try {
    const raw = s.getItem(PREF_KEY);
    if (raw === null) return SUGGEST_DELAY_DEFAULT;
    const trimmed = raw.trim();
    const n = trimmed === '' ? Number.NaN : Number(trimmed);
    return clampSuggestDelay(n);
  } catch {
    return SUGGEST_DELAY_DEFAULT;
  }
}

/** 变更订阅表（同一张表：设置页 + 观察者各自的读取方都订这里） */
const listeners = new Set<() => void>();

/**
 * 写偏好 + 通知订阅者。
 *
 * 写不进去（隐私模式 / 配额满）静默降级：只丢掉这一次选择，读取方下次拿到的仍是旧值/默认，
 * 但**绝不抛进渲染链**（与 `semantic-color-pref` 同一条兜底口径）。订阅者照样收到通知。
 */
export function saveSuggestDelayPref(ms: number): void {
  const s = storage();
  if (s) {
    try {
      s.setItem(PREF_KEY, String(clampSuggestDelay(ms)));
    } catch {
      /* 隐私模式 / 配额满：本次会话的读取方仍按已存值走，这里只是不落盘 */
    }
  }
  for (const listener of listeners) listener();
}

/** 订阅偏好变化（返回取消订阅函数；组件卸载时必须取消） */
export function subscribeSuggestDelayPref(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React 读数（`useSyncExternalStore`：订阅 `subscribeSuggestDelayPref`、快照 `loadSuggestDelayPref`） */
export function useSuggestDelayPref(): number {
  return useSyncExternalStore(subscribeSuggestDelayPref, loadSuggestDelayPref);
}

/* ============================== 两枚布尔开关（QSUG-2） ============================== */

/**
 * 「输入时自动弹出补全」默认**开**：对标 VS Code / IDEA，写到代码位就边打边弹；
 * 台词 / 旁白 / 注释 / 字符串与只读 / 预览由位置门与编辑器选项各自挡住，不靠关总闸降噪。
 */
export const QUICK_SUGGESTIONS_DEFAULT = true;

/** 「文档词补全」默认**开**：当前文件里同前缀的词也进候选（位置门与候选源同一条纪律）。 */
export const WORD_BASED_SUGGESTIONS_DEFAULT = true;

function loadBooleanPref(key: string, fallback: boolean): boolean {
  const s = storage();
  if (!s) return fallback;
  try {
    const raw = s.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function saveBooleanPref(key: string, on: boolean, listeners: Set<() => void>): void {
  const s = storage();
  if (s) {
    try {
      s.setItem(key, on ? '1' : '0');
    } catch {
      /* 隐私模式 / 配额满：只丢掉这一次选择，绝不抛进渲染链 */
    }
  }
  for (const listener of listeners) listener();
}

function subscribe(listeners: Set<() => void>, listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const quickListeners = new Set<() => void>();
const wordListeners = new Set<() => void>();

export function loadQuickSuggestionsPref(): boolean {
  return loadBooleanPref(QUICK_KEY, QUICK_SUGGESTIONS_DEFAULT);
}

export function saveQuickSuggestionsPref(on: boolean): void {
  saveBooleanPref(QUICK_KEY, on, quickListeners);
}

export function subscribeQuickSuggestionsPref(listener: () => void): () => void {
  return subscribe(quickListeners, listener);
}

/** React 读数（设置页开关） */
export function useQuickSuggestionsPref(): boolean {
  return useSyncExternalStore(subscribeQuickSuggestionsPref, loadQuickSuggestionsPref);
}

export function loadWordBasedSuggestionsPref(): boolean {
  return loadBooleanPref(WORD_KEY, WORD_BASED_SUGGESTIONS_DEFAULT);
}

export function saveWordBasedSuggestionsPref(on: boolean): void {
  saveBooleanPref(WORD_KEY, on, wordListeners);
}

export function subscribeWordBasedSuggestionsPref(listener: () => void): () => void {
  return subscribe(wordListeners, listener);
}

/** React 读数（设置页开关） */
export function useWordBasedSuggestionsPref(): boolean {
  return useSyncExternalStore(subscribeWordBasedSuggestionsPref, loadWordBasedSuggestionsPref);
}
