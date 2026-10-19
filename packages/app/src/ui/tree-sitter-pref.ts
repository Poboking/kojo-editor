import { useSyncExternalStore } from 'react';
/**
 * 「结构解析器辅助」偏好（TSIT-M1，2026-10-19 结构层接线批）：**默认关**。
 *
 * 存法照 `semantic-color-pref.ts` / `code-lens-pref.ts` 先例 —— localStorage 真源 +
 * 订阅表，**不新造第二套偏好机制**；设置页一翻，`monaco/tree-sitter/providers.ts`
 * 那枚单例就挂/卸 provider，不重开文件、不重开编辑器。
 *
 * ## 为什么必须默认关（三条都在纸上，不是"新功能都关一遍"的惯性）
 *
 * 1. 它**换的是着色与折叠的判据**：同开时结构层的档位会盖在词法层上（Monaco 的语义
 *    token 在覆盖区间优先），作者看惯的配色会跟着动——与「定义与调用的名字分色」同一条理由。
 * 2. 语法层（`@kojo/kojo-syntax-tree`）此刻还在补覆盖与错误恢复，规则表未收口；
 *    判据没稳之前不该成为任何人的默认视图。
 * 3. 载入的是**另一枚 WASM + 一枚 worker**：关着时不该有一字节进主线程静态图，
 *    也不该 spawn 任何线程（装配点用动态 import 守这条，见 `monaco/entry.ts`）。
 *
 * ## 作者面文案不许出现机器词
 *
 * 本模块的标识符（`treeSitter` / `TREE_SITTER_KEY`）是机器面的协议名，与 Monaco 文档对得上；
 * 上屏的中文一律写「结构解析器 / 折叠」，不写 tree-sitter、不写 semantic token
 * （口径同 `semantic-color-pref.ts`：机器面留原名，作者面说效果）。
 */

/** 偏好键（localStorage；与 `kojo.ui.*.v1` 同一套命名） */
const PREF_KEY = 'kojo.ui.treeSitter.v1';

/** 缺省 = 关（见模块头「为什么必须默认关」） */
export const TREE_SITTER_DEFAULT = false;

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响编辑器） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读偏好（只有明确存过 `on` 才算开；读不到 / 抛错一律回默认，绝不抛进渲染链） */
export function loadTreeSitterPref(): boolean {
  const s = storage();
  if (!s) return TREE_SITTER_DEFAULT;
  try {
    return s.getItem(PREF_KEY) === 'on';
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
      if (on) s.setItem(PREF_KEY, 'on');
      else s.removeItem(PREF_KEY);
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
