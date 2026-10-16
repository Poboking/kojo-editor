import { useSyncExternalStore } from 'react';
/**
 * 「定义与调用的名字分色」偏好（B6，2026-10-16 结构化着色批）。
 *
 * 存法照 `format-pref.ts` / `direct-mode.ts` 先例 —— localStorage + 设置页一个开关，
 * **不新造第二套偏好机制**；变更走订阅表、React 钩子与 `useDirectMode` 同处一个文件
 * （本仓既有做法：极小组件与纯逻辑同文件，测试只打纯逻辑那一半）。
 * 设置页一翻、编辑器立即生效，不用重开文件。
 *
 * 作者面的文案**不许出现**「语义 / semantic / token」这类黑话（本仓口径见
 * 「保存时整理空白」「.kojo 预览」两行）；机器面（本模块与 `kojo-semantic-tokens.ts`）
 * 保留协议原名，便于对着 Monaco 文档读。
 *
 * ## 默认关
 *
 * 本仓既定口径「改视觉面的新功能默认关」。这里还多一条领域理由：着色会**顶掉**词法
 * 已经给定的颜色（Monaco 在覆盖区间上让语义 token 优先），等于替作者改了他看惯的
 * 配色；而且每条 span 的代价压在输入路径上（三条贡献方各一遍全文扫描）。
 * 没有人提出这个需求时，编辑器不该先动作者的界面。
 *
 * ## 开关落在 Monaco 自己的配置项上
 *
 * `applySemanticColorPref` 写的就是 `editor.semanticHighlighting.enabled`。
 * standalone 的着色特性监听这条配置并在开/关时逐个 model 挂卸着色器 —— 关着的时候
 * **一次 provider 调用都不会发生**（零开销），而不是"调用了再丢弃"。
 * 所以本模块不额外做二次门禁：真源只有一份（localStorage），生效路径也只有一条。
 */

/** 偏好键（localStorage） */
const PREF_KEY = 'kojo.ui.nameColor.v1';

/** 缺省 = 关（见模块头「默认关」） */
export const NAME_COLOR_DEFAULT = false;

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响着色） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读偏好（只有明确存过 `on` 才算开；读不到 / 抛错一律回默认，绝不抛到编辑器链路） */
export function loadNameColorPref(): boolean {
  const s = storage();
  if (!s) return NAME_COLOR_DEFAULT;
  try {
    return s.getItem(PREF_KEY) === 'on';
  } catch {
    return NAME_COLOR_DEFAULT;
  }
}

/**
 * 把开关落到编辑器上。
 *
 * 参数取**结构化最小接口**（只要求 `updateOptions`）：本模块因此不依赖 Monaco 类型，
 * 在 node 里用一枚假编辑器就能钉死「开 → true / 关 → false」这条唯一生效路径。
 */
export interface NameColorTarget {
  updateOptions(options: { 'semanticHighlighting.enabled'?: true | false | 'configuredByTheme' }): void;
}

export function applyNameColorPref(target: NameColorTarget | null | undefined, on: boolean = loadNameColorPref()): void {
  if (!target) return;
  target.updateOptions({ 'semanticHighlighting.enabled': on });
}

/** 变更订阅表（`set` 后逐一通知；编辑器与设置页都订这一张表） */
const listeners = new Set<() => void>();

/** 写偏好 + 通知订阅者（写不进去静默降级：只影响下次启动的默认值，本次会话仍然立即生效） */
export function setNameColorPref(on: boolean): void {
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

/** 订阅开关变化（返回取消订阅函数；编辑器卸载时必须取消，否则闭包攥着已 dispose 的编辑器） */
export function subscribeNameColorPref(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React 读开关（`useSyncExternalStore`：订阅 `subscribeNameColorPref`、快照 `loadNameColorPref`） */
export function useNameColorPref(): boolean {
  return useSyncExternalStore(subscribeNameColorPref, loadNameColorPref);
}
