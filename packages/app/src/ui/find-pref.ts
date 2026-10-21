import { useSyncExternalStore } from 'react';
/**
 * 「查找词优先」偏好（FIND-STATE-PERSIST-B，2026-10-21）：按 Ctrl+F 时查找框先填哪个词，三档。
 * 存法照 `layout-pref.ts` / `suggest-pref.ts` 先例 —— localStorage 真源 + 订阅表 +
 * 严格枚举校验（非法值 / 缺键 / 读抛错一律回落缺省，绝不抛进渲染链），**不新造第二套偏好机制**。
 *
 * ## 默认 'selection'（用户 2026-10-21 拍板）
 *
 * 取证（FIND-STATE-PERSIST A/B，monaco 0.57）：A 的静默持久化只保证"放回那一刻"恢复词不被顶掉；
 * 作者随后按 Ctrl+F 时，vendor 的 `seedSearchStringFromSelection` 内建 `'always'` 仍会拿
 * **光标所在词**盖掉恢复词。'selection' 档只在**真选中**时播种，光标压在词上不再劫持；
 * 'never' 档则连选中也不取，查找框恒为上次记住的词（A 的按文件恢复因此完整生效）。
 *
 * ## 生效路径只有一条
 *
 * `editor-options.ts` 的 {@link findPrefPatch}：create options、`applySizeTier` 的切文件路径、
 * 本模块订阅回调（`use-editor-preferences.ts`）三条写选项的路都从这里取同一份偏好——
 * 档位表（`FIND_BASELINE`）不读 localStorage，偏好层叠在它之后，两份真相各管各的轴
 * （P2-16 排版偏好叠层同一条纪律）。补丁**恒带全整组 find 字段**：monaco 的 `find` 是一枚
 * 对象选项，只传部分字段时其余字段由内建缺省兜底（`EditorFind.validate` 逐字段
 * `boolean/ stringSet(input.x, this.defaultValue.x, …)`）——带着基线全量再改一位，就不给
 * "打回内建默认"留缝；实测快照见 `tests/find-pref.test.ts`。
 */

/**
 * 三档取值 = Monaco 0.57 登记名（`monaco.d.ts` 的
 * `seedSearchStringFromSelection?: 'never' | 'always' | 'selection'`）——偏好里不另造
 * 词汇，落到编辑器选项零翻译（同 `layout-pref.ts` 的 multiCursorModifier 口径）。
 */
export type FindSeedPref = 'always' | 'selection' | 'never';

/** 偏好键（localStorage；与 `kojo.ui.*.v1` 同一套命名） */
const PREF_KEY = 'kojo.ui.findSeedPref.v1';

/** 默认档 = 仅用选中文字（见模块头） */
export const FIND_SEED_DEFAULT: FindSeedPref = 'selection';

const FIND_SEED_VALUES: readonly FindSeedPref[] = ['always', 'selection', 'never'];

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响查找） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 严格口径读枚举（同 `layout-pref.ts` 的 readEnum）：只有登记值算数，别的回落缺省 */
function readEnum(raw: string | null): FindSeedPref {
  return raw !== null && (FIND_SEED_VALUES as readonly string[]).includes(raw)
    ? (raw as FindSeedPref)
    : FIND_SEED_DEFAULT;
}

/** 读偏好：没存过 / 存坏 / 读抛错一律回默认（原始值快照，Object.is 直接可比） */
export function loadFindSeedPref(): FindSeedPref {
  const s = storage();
  if (!s) return FIND_SEED_DEFAULT;
  try {
    return readEnum(s.getItem(PREF_KEY));
  } catch {
    return FIND_SEED_DEFAULT;
  }
}

/** 变更订阅表（同一张表：设置页与编辑器实例的偏好订阅都订这里） */
const listeners = new Set<() => void>();

/**
 * 写偏好 + 通知订阅者（三档都是真选择，'selection' 缺省档也落键——口径同折行三选一的 'tier'）。
 * 写不进去（隐私模式 / 配额满）静默降级：只丢掉这一次选择，**绝不抛进渲染链**。
 */
export function saveFindSeedPref(value: FindSeedPref): void {
  const s = storage();
  if (s) {
    try {
      s.setItem(PREF_KEY, value);
    } catch {
      /* 隐私模式 / 配额满：本次会话按内存里的已存值继续走 */
    }
  }
  for (const listener of listeners) listener();
}

/** 订阅偏好变化（返回取消订阅函数；调用方卸载时必须取消，否则闭包攥着已 dispose 的编辑器） */
export function subscribeFindSeedPref(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React 读数（设置页三选一分段） */
export function useFindSeedPref(): FindSeedPref {
  return useSyncExternalStore(subscribeFindSeedPref, loadFindSeedPref);
}
