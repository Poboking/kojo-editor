import { useSyncExternalStore } from 'react';
/**
 * 「双击 Shift 呼出全局搜索」偏好（体验对等批）。
 *
 * 存法照 `tree-sitter-pref.ts` / `autosave-pref.ts` 先例——localStorage 唯一真源 + 订阅表，
 * **不新造第二套偏好机制**。缺省**开**：这条腿是本批交付的主入口（对标 IDEA），
 * 关掉它是降噪逃生门而不是保守默认——与「结构解析器」那种实验特性方向相反。
 *
 * 关掉后 `workbench.searchEverywhere` 命令**仍在**（面板仍可从命令面板/快捷键进），
 * 只是全局键盘上那条双击判定不再响应（判定本体在 `search-everywhere-trigger.ts`，
 * 这里只管开关读数）。
 */

/** 偏好键（`kojo.ui.*` 一族命名；键名中性，零游戏名词） */
const PREF_KEY = 'kojo.ui.searchEverywhere.doubleShift.v1';

/** 缺省 = 开（只有显式存过 `off` 才算关；脏数据的方向是"多露"不是"少露"，同 tree-sitter 纪律） */
export const DOUBLE_SHIFT_DEFAULT = true;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读开关（读不到 / 抛错一律回默认开） */
export function loadDoubleShiftPref(): boolean {
  const s = storage();
  if (!s) return DOUBLE_SHIFT_DEFAULT;
  try {
    return s.getItem(PREF_KEY) !== 'off';
  } catch {
    return DOUBLE_SHIFT_DEFAULT;
  }
}

const listeners = new Set<() => void>();

/** 写开关 + 通知订阅者（写不进去静默降级：本次会话仍然立即生效） */
export function setDoubleShiftPref(on: boolean): void {
  const s = storage();
  if (s) {
    try {
      s.setItem(PREF_KEY, on ? 'on' : 'off');
    } catch {
      /* 隐私模式 / 配额满：按"本次会话有效"降级 */
    }
  }
  for (const listener of listeners) listener();
}

export function subscribeDoubleShiftPref(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React 读开关（`useSyncExternalStore`：订阅 `subscribeDoubleShiftPref`、快照 `loadDoubleShiftPref`）。
 *  第三参 = 服务端快照（node SSR 渲染设置页通用节时要它，照 `panel-visibility.ts` 先例——
 *  node 里 `loadDoubleShiftPref` 无 window 自然回默认，两侧快照同值不抖）。 */
export function useDoubleShiftPref(): boolean {
  return useSyncExternalStore(subscribeDoubleShiftPref, loadDoubleShiftPref, loadDoubleShiftPref);
}
