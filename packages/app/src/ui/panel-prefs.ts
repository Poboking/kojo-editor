/**
 * 面板偏好（panel-prefs.ts）—— 2026-10-14 面板偏好批。
 *
 * ## 这个模块管什么（一句话）
 *
 * 设置页里那些**容器语义**的面板渲染偏好。本批只有一件：「长列表视口化」
 * （`panelVirtualize`）——开启后面板内长列表只渲染可见窗口（滚出即撤、滚入即建），
 * 大角色首次打开不再有一次性全量渲染的卡顿；关掉则一次全渲染（改动前行为）。
 *
 * ## 与「面板私有开关」的分界
 *
 * 这里住的是**宿主下传的容器偏好**（`plugin-api` 的 `UiPrefs`，见 `UIPanelProps.uiPrefs`）
 * ——面板不自己持久化它，由宿主统一持有、即时下传。某个面板自己的私有配置不属于这里。
 *
 * ## 纪律（与 direct-mode.ts / sealed.ts 同款）
 *
 * - **壳层私事**：写 WebView localStorage，`kojo.ui.panelVirtualize.v1`，不进内核存储域
 *   （模块名 `panel-prefs` 是"面板偏好"这个桶，每个偏好各配一枚 `kojo.ui.<特性>.v1` 键，
 *   与既有的 `kojo.ui.directMode.v1` / `kojo.ui.sealed.v1` 同款）；
 * - **默认关（false）**：视口化是"给大列表省一次卡顿"的优化，不是默认替用户做主——
 *   默认全量渲染 = 改动前行为；脏数据的失败方向也必须是"保守"（回 false）；
 * - **绝不抛**：无 `window`（测试 / 非浏览器）/ 隐私模式 / 坏值 → 一律回默认；
 * - **不做模块级缓存**：读 localStorage 是幂等的布尔投影，缓存只添失效面。
 *
 * ## 键与默认值语义
 *
 * `'1'` = 开（视口化）；`'0'` = 关（全量渲染）；缺省 / 坏值 = 关（`PANEL_VIRTUALIZE_DEFAULT`）。
 */

import { useSyncExternalStore } from 'react';

/** 偏好键：`'1'` = 视口化开；`'0'` = 关（缺省 / 读不到 = 关） */
const PREF_KEY = 'kojo.ui.panelVirtualize.v1';

/**
 * 默认**关**（`false` = 全量渲染 = 改动前行为）。
 *
 * 视口化只在长列表上省掉一次性全量渲染的卡顿；对短列表反而多一层窗口计算，
 * 故默认保守地走旧路径，想用的人在设置页勾一下，且**选择会被记住**。
 */
export const PANEL_VIRTUALIZE_DEFAULT = false;

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响本会话） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读偏好（缺省 / 坏值 = `PANEL_VIRTUALIZE_DEFAULT`；读不到也回默认，绝不抛） */
export function loadPanelVirtualize(): boolean {
  const s = storage();
  if (!s) return PANEL_VIRTUALIZE_DEFAULT;
  try {
    const raw = s.getItem(PREF_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    // 缺省 / 坏值（手改 localStorage 等）→ 回默认：脏数据的失败方向必须是"保守"，不是"激进"
    return PANEL_VIRTUALIZE_DEFAULT;
  } catch {
    return PANEL_VIRTUALIZE_DEFAULT;
  }
}

/** 变更订阅表（`useSyncExternalStore` 的 subscribe；`setPanelVirtualize` 后逐一声明变化） */
const listeners = new Set<() => void>();

/**
 * 写偏好 + 通知订阅者。
 *
 * 写不进去静默降级（隐私模式 / 配额满）：只影响下次启动的默认值，不影响本次会话
 * ——通知照发，本次会话仍然立即生效（开关一翻，面板立即以新偏好重渲染）。
 */
export function setPanelVirtualize(v: boolean): void {
  const s = storage();
  if (s) {
    try {
      s.setItem(PREF_KEY, v ? '1' : '0');
    } catch {
      /* 静默降级为"本次会话有效" */
    }
  }
  for (const listener of listeners) listener();
}

/** 订阅偏好变化（React 之外也可用；返回取消订阅函数） */
export function subscribePanelVirtualize(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React 读写偏好（`useSyncExternalStore`：订阅 `subscribePanelVirtualize`、快照 `loadPanelVirtualize`）。
 *
 * 快照是 localStorage 的幂等布尔投影（无缓存），所以任何一处 `setPanelVirtualize` 之后
 * 全壳层立即看到一致的新值，并把它作为 `uiPrefs.panelVirtualize` 重新下传给面板。
 */
export function usePanelVirtualize(): boolean {
  return useSyncExternalStore(subscribePanelVirtualize, loadPanelVirtualize);
}
