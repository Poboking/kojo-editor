import { useSyncExternalStore } from 'react';
/**
 * 「结构解析器辅助」偏好（TSIT-M1 接线；批次十 TS-DEFAULT：**默认开**）。
 *
 * 存法照 `semantic-color-pref.ts` / `code-lens-pref.ts` 先例 —— localStorage 真源 +
 * 订阅表，**不新造第二套偏好机制**；设置页一翻，`monaco/tree-sitter/providers.ts`
 * 那枚单例就挂/卸 provider，不重开文件、不重开编辑器。
 *
 * ## 为什么现在默认开（原先"默认关"的三条理由都已被后续批次消解）
 *
 * 1. 结构层是**叠层不是替换**：着色只在真有结果时覆盖区间，折叠是增量，缩进只在真的
 *    给出规则时才写；拿不到结果一律 `null` / `[]`，Monarch 与转译器那一路逐字不变。
 * 2. **失败不静默**：worker 起不来 / 超时 / 解析抛错都经 `tree-sitter/fallback.ts`
 *    台账说一次再回落（`tests/tree-sitter-default.test.ts` 钉这条）。
 * 3. **大文件的闸按面分**（2026-10-28）：着色 / 缩进超过 `LARGE_FILE_LINES` 让路（那一面要在
 *    主线程把 token 编出来），**折叠不让**——它整趟都在 worker 里，24,197 行实测 210 ms，
 *    比着色那一路还便宜（见 `providers.ts` 的 `resolveStructureFoldsEnabled`）。
 *
 * 资源仍按需装配：`providers.ts` 在 `activate()` 里动态 import，worker 与 wasm 只在
 * 真的被问到一篇文档时才起——默认开不等于开机就 spawn 线程。
 *
 * ## 关掉的方向
 *
 * 只有**明确存过 `off`** 才算关；没存过 / 读不到 / 抛错一律回默认（开）。
 * 脏数据的方向是"多露"而不是"少露"——作者显式关掉的那次必须真的关。
 *
 * ## 作者面文案不许出现机器词
 *
 * 本模块的标识符（`treeSitter` / `TREE_SITTER_KEY`）是机器面的协议名，与 Monaco 文档对得上；
 * 上屏的中文一律写「结构解析器 / 折叠」，不写 tree-sitter、不写 semantic token
 * （口径同 `semantic-color-pref.ts`：机器面留原名，作者面说效果）。
 */

/** 偏好键（localStorage；与 `kojo.ui.*.v1` 同一套命名） */
const PREF_KEY = 'kojo.ui.treeSitter.v1';

/** 缺省 = 开（见模块头「为什么现在默认开」；只有显式 `off` 才算关） */
export const TREE_SITTER_DEFAULT = true;

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响编辑器） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读偏好（只有明确存过 `off` 才算关；没存过 / 读不到 / 抛错一律回默认开） */
export function loadTreeSitterPref(): boolean {
  const s = storage();
  if (!s) return TREE_SITTER_DEFAULT;
  try {
    return s.getItem(PREF_KEY) !== 'off';
  } catch {
    return TREE_SITTER_DEFAULT;
  }
}

/** 变更订阅表（`set` 后逐一通知；设置页与结构层单例都订这一张表） */
const listeners = new Set<() => void>();

/** 写偏好 + 通知订阅者（写不进去静默降级：只影响下次启动的默认值，本次会话仍然立即生效） */
export function setTreeSitterPref(on: boolean): void {
  const s = storage();
  if (s) {
    try {
      // 两个方向都显式落值：缺省是开，只有写下的 `off` 才能跨重启保持关
      s.setItem(PREF_KEY, on ? 'on' : 'off');
    } catch {
      /* 隐私模式 / 配额满：按"本次会话有效"降级 */
    }
  }
  for (const listener of listeners) listener();
}

/** 订阅开关变化（返回取消订阅函数） */
export function subscribeTreeSitterPref(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React 读开关（`useSyncExternalStore`：订阅 `subscribeTreeSitterPref`、快照 `loadTreeSitterPref`） */
export function useTreeSitterPref(): boolean {
  return useSyncExternalStore(subscribeTreeSitterPref, loadTreeSitterPref);
}
