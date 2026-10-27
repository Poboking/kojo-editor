import { useSyncExternalStore } from 'react';

/**
 * 内联补全（幽灵文本）偏好（IC 批 A 车道，2026-10-27）。
 *
 * 存法照 `suggest-pref.ts` / `code-lens-pref.ts` 先例 —— **localStorage 真源 + 订阅表 +
 * `useSyncExternalStore`**，零 React 纯逻辑可单测，不新造第二套偏好机制。
 *
 * ## 为什么这三个数是**宿主**的（不在契约里）
 *
 * `plugin-api/inline-completion.ts` 刻意一个常量都没有：候选上限、时间预算、上下文窗宽
 * 都是"握着 model、握着用户偏好、也是唯一截断点"那一侧的策略。契约里放一个数字，等于
 * 邀请第二个地方读它、第三个地方抄它。⇒ 本模块就是那**唯一一处**。
 *
 * ## 默认 on（组长的裁决）
 *
 * 默认关 = 这条功能对作者等于不存在；而本线的风险（抢键）由两道兜住：
 * ① IME / Tab 归属护栏（`suggest-context-trigger.ts` 的那一副），
 * ② "无候选时不改任何行为"——候选源弃权 / 没货 ⇒ 交回空批次，Monaco 的
 *    `inlineSuggestionVisible` 不成立 ⇒ Tab / Esc 键位根本不激活。
 * 关掉之后行为与**接线前**逐字一致：本模块的值只被两处消费（Monaco 的 `inlineSuggest`
 * 选项、provider 自己的那道闸），别处不认识它。
 *
 * ## 取值口径
 *
 * - `enabled`：布尔，缺省开；只有明确存过 `'0'` 才算关（与 `suggest-pref` 的布尔档同法）。
 * - `minShowDelay`：**停顿多久才弹**（毫秒，0–1000、每档 100）。这一位直接写进 Monaco 的
 *   `editor.inlineSuggest.minShowDelay`（vendor `editorOptions.js` 的 `InlineEditorSuggest`：
 *   默认 0、上限 10000）；作者可调区间收窄到与「补全弹出延迟」同一档，免得两把尺。
 * - `maxCandidates`：**最多几条候选**（1–20，缺省 5）。宿主在把候选交给 Monaco **之前**截断，
 *   所以这是"上屏条数"的真上限；`order` 序不改（截的是尾巴，不是重排）。
 *
 * 三处的损坏口径一律**静默回落默认 + 夹取**，绝不把 NaN / 负数交给定时器，也绝不抛进渲染链
 * （`suggest-pref.ts` 的同一条纪律）。
 */

/** 总开关（localStorage 键） */
const ENABLED_KEY = 'kojo.ui.inlineCompletion.enabled.v1';
/** 停顿多久才弹（毫秒） */
const MIN_DELAY_KEY = 'kojo.ui.inlineCompletion.minShowDelay.v1';
/** 最多几条候选 */
const MAX_CANDIDATES_KEY = 'kojo.ui.inlineCompletion.maxCandidates.v1';

/** 幽灵文本总开关默认**开**（理由见文件头「默认 on」） */
export const INLINE_COMPLETION_DEFAULT = true;

/** 停顿延迟缺省 = 0ms：与 Monaco 的 `inlineSuggest.minShowDelay` 缺省逐字同值 ⇒ 默认档零行为改动 */
export const INLINE_MIN_SHOW_DELAY_DEFAULT = 0;
/** 设置页可调下限（= 立即） */
export const INLINE_MIN_SHOW_DELAY_MIN = 0;
/** 设置页可调上限（与「补全弹出延迟」同一档；vendor 上限是 10000，这里刻意更保守） */
export const INLINE_MIN_SHOW_DELAY_MAX = 1000;
/** 设置页每档（− / ＋） */
export const INLINE_MIN_SHOW_DELAY_STEP = 100;

/** 候选上限缺省 = 5（第 0 条是接受键拿到的那一条，其余是"逐候选切换"的池） */
export const INLINE_MAX_CANDIDATES_DEFAULT = 5;
/** 下限 = 1：0 条的偏好等于关掉功能，那由总开关负责，不由这条数值负责 */
export const INLINE_MAX_CANDIDATES_MIN = 1;
/** 上限 = 20：幽灵文本一次只上一屏那一条，再多也只是切换池；与宿主的时间预算无关 */
export const INLINE_MAX_CANDIDATES_MAX = 20;
/** 设置页每档（− / ＋） */
export const INLINE_MAX_CANDIDATES_STEP = 1;

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响补全） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 夹到可调区间；非有限数回默认（损坏口径，绝不把 NaN 交给 setTimeout） */
export function clampInlineMinShowDelay(ms: number): number {
  if (!Number.isFinite(ms)) return INLINE_MIN_SHOW_DELAY_DEFAULT;
  return Math.min(
    INLINE_MIN_SHOW_DELAY_MAX,
    Math.max(INLINE_MIN_SHOW_DELAY_MIN, Math.round(ms)),
  );
}

/** 夹到候选区间；非有限数回默认（同上，损坏值不抛） */
export function clampInlineMaxCandidates(count: number): number {
  if (!Number.isFinite(count)) return INLINE_MAX_CANDIDATES_DEFAULT;
  return Math.min(INLINE_MAX_CANDIDATES_MAX, Math.max(INLINE_MAX_CANDIDATES_MIN, Math.round(count)));
}

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

function loadNumberPref(key: string, fallback: number, clamp: (n: number) => number): number {
  const s = storage();
  if (!s) return fallback;
  try {
    const raw = s.getItem(key);
    if (raw === null) return fallback;
    const trimmed = raw.trim();
    // `Number()` 严格口径（`'12ms'` / 空串 / 文字都算损坏；与 `suggest-pref` 同一把尺）
    const n = trimmed === '' ? Number.NaN : Number(trimmed);
    return Number.isFinite(n) ? clamp(n) : fallback;
  } catch {
    return fallback;
  }
}

/* ============================== 三格各自的订阅表 ============================== */

const enabledListeners = new Set<() => void>();
const minDelayListeners = new Set<() => void>();
const maxCandidatesListeners = new Set<() => void>();

function notify(listeners: Set<() => void>): void {
  for (const listener of listeners) listener();
}

function subscribe(listeners: Set<() => void>, listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 写布尔偏好（写不进去 = 只丢这一次选择，绝不抛进渲染链；订阅者照样收到通知） */
function saveBooleanPref(key: string, on: boolean, listeners: Set<() => void>): void {
  const s = storage();
  if (s) {
    try {
      s.setItem(key, on ? '1' : '0');
    } catch {
      /* 隐私模式 / 配额满：读取方下次拿到的仍是旧值/默认 */
    }
  }
  notify(listeners);
}

/** 写数值偏好（先夹取再落盘：手改出来的越界值不会留在盘上） */
function saveNumberPref(
  key: string,
  value: number,
  clamp: (n: number) => number,
  listeners: Set<() => void>,
): void {
  const s = storage();
  if (s) {
    try {
      s.setItem(key, String(clamp(value)));
    } catch {
      /* 同上：静默降级，不抛 */
    }
  }
  notify(listeners);
}

/* ============================== ① 总开关 ============================== */

export function loadInlineCompletionPref(): boolean {
  return loadBooleanPref(ENABLED_KEY, INLINE_COMPLETION_DEFAULT);
}

export function saveInlineCompletionPref(on: boolean): void {
  saveBooleanPref(ENABLED_KEY, on, enabledListeners);
}

export function subscribeInlineCompletionPref(listener: () => void): () => void {
  return subscribe(enabledListeners, listener);
}

/** React 读数（设置页那一格） */
export function useInlineCompletionPref(): boolean {
  return useSyncExternalStore(subscribeInlineCompletionPref, loadInlineCompletionPref);
}

/* ============================== ② 停顿多久才弹 ============================== */

export function loadInlineMinShowDelayPref(): number {
  return loadNumberPref(
    MIN_DELAY_KEY,
    INLINE_MIN_SHOW_DELAY_DEFAULT,
    clampInlineMinShowDelay,
  );
}

export function saveInlineMinShowDelayPref(ms: number): void {
  saveNumberPref(MIN_DELAY_KEY, ms, clampInlineMinShowDelay, minDelayListeners);
}

export function subscribeInlineMinShowDelayPref(listener: () => void): () => void {
  return subscribe(minDelayListeners, listener);
}

/** React 读数（设置页那一格） */
export function useInlineMinShowDelayPref(): number {
  return useSyncExternalStore(subscribeInlineMinShowDelayPref, loadInlineMinShowDelayPref);
}

/* ============================== ③ 最多几条候选 ============================== */

export function loadInlineMaxCandidatesPref(): number {
  return loadNumberPref(
    MAX_CANDIDATES_KEY,
    INLINE_MAX_CANDIDATES_DEFAULT,
    clampInlineMaxCandidates,
  );
}

export function saveInlineMaxCandidatesPref(count: number): void {
  saveNumberPref(MAX_CANDIDATES_KEY, count, clampInlineMaxCandidates, maxCandidatesListeners);
}

export function subscribeInlineMaxCandidatesPref(listener: () => void): () => void {
  return subscribe(maxCandidatesListeners, listener);
}

/** React 读数（设置页那一格） */
export function useInlineMaxCandidatesPref(): number {
  return useSyncExternalStore(subscribeInlineMaxCandidatesPref, loadInlineMaxCandidatesPref);
}
