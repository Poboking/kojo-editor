import { useSyncExternalStore } from 'react';
/**
 * 自动保存偏好（A6，2026-10-20）：零 React 纯逻辑 + 极小 React 钩子，可单测。
 *
 * 存法照 `font-size-pref.ts` 先例——localStorage 唯一真源 + 订阅表，**不新造第二套偏好机制**。
 * monaco 的 `editor.autoSave` 只管 model 标记不管宿主写盘，所以本功能的写盘全部复用
 * EditorPane 既有 save 路径（同一函数、同一互斥、同一写允许域闸门）——这里只存"开不开"。
 *
 * 形态首版只有 `off | afterDelay`（闲置窗口 `AUTOSAVE_IDLE_MS` 后触发）；onBlur /
 * onFocusChange 未接线，故不进类型（进了就是 UI 上的假承诺）。
 */

export type AutosaveMode = 'off' | 'afterDelay';

const AUTOSAVE_KEY = 'kojo.ui.autosave.v1';

/** 默认关：这个编辑器的盘写有安全姿态（游戏目录是部署目标），静默写盘必须是显式选择 */
export const AUTOSAVE_MODE_DEFAULT: AutosaveMode = 'off';
/** 活动标签最后一次输入后闲置多久触发（与装饰去抖同一族口径，独立一根线） */
export const AUTOSAVE_IDLE_MS = 1000;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 解析：非在册档位（含损坏串）一律回默认——绝不让坏值把默认行为翻成"开" */
export function parseAutosaveMode(raw: string | null): AutosaveMode {
  return raw === 'off' || raw === 'afterDelay' ? raw : AUTOSAVE_MODE_DEFAULT;
}

export function loadAutosavePref(): AutosaveMode {
  const s = storage();
  let raw: string | null = null;
  if (s) {
    try {
      raw = s.getItem(AUTOSAVE_KEY);
    } catch {
      raw = null;
    }
  }
  return parseAutosaveMode(raw);
}

const listeners = new Set<() => void>();

/** 订阅变化（返回取消函数；设置页与编辑器接线都只读投影，真源只有 localStorage） */
export function subscribeAutosavePref(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setAutosavePref(mode: AutosaveMode): void {
  const s = storage();
  if (s) {
    try {
      s.setItem(AUTOSAVE_KEY, mode);
    } catch {
      /* 隐私模式 / 配额满：本次会话内仍是你的选择 */
    }
  }
  for (const listener of listeners) listener();
}

/** React 读数（设置页开关行用） */
export function useAutosavePref(): AutosaveMode {
  return useSyncExternalStore(subscribeAutosavePref, loadAutosavePref);
}

/* ------------------------------ 护栏判定（纯函数） ------------------------------ */

/** 到点时刻的现场读数（EditorPane tick 现取现算，判定不碰 DOM/React） */
export interface AutosaveGateInput {
  readonly mode: AutosaveMode;
  /** 活动标签当前仍脏（到点时可能已被撤销回干净） */
  readonly dirty: boolean;
  /** 全局保存互斥被占（手动 Ctrl+S / 全部保存在途） */
  readonly saving: boolean;
  /** needs-choice：保存告警确认框未决 */
  readonly saveWarningPending: boolean;
  /** 外部改动与本地脏冲突、尚未被用户处置 */
  readonly externalChangePending: boolean;
  /** 糖视图挂着（派生显示，不落盘） */
  readonly sugarView: boolean;
  /** 写允许域口径与保存按钮一致（不可写就**不触发**，避免自动弹授权框骚扰） */
  readonly writable: boolean;
}

export type AutosaveDecision =
  | 'run'
  | 'off'
  | 'clean'
  | 'saving'
  | 'needs-choice'
  | 'external-change'
  | 'sugar-view'
  | 'readonly';

/**
 * 自动保存的唯一判据（跳过原因如实可辨，不静默——铁律 4 的"该不该动"侧）。
 * 顺序即优先级：开关 → 有没有东西可存 → 互斥 → 三条数据护栏 → 写权限。
 */
export function decideAutosave(input: AutosaveGateInput): AutosaveDecision {
  if (input.mode !== 'afterDelay') return 'off';
  if (!input.dirty) return 'clean';
  if (input.saving) return 'saving';
  if (input.saveWarningPending) return 'needs-choice';
  if (input.externalChangePending) return 'external-change';
  if (input.sugarView) return 'sugar-view';
  if (!input.writable) return 'readonly';
  return 'run';
}
