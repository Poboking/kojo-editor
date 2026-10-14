/**
 * 封存总闸（sealed.ts）—— 2026-10-13 试用反馈批。
 *
 * ## 为什么需要它（一句话）
 *
 * 试用反馈：「把那些没用的功能，都给我封存了！只留一个开关放在设置页面」。
 * 被点名**整体封存**的两件都是插件面板：
 * 1. **糖预览面板**（插件 `ui-sugar-preview`，面板 id `sugar-preview`，aux）；
 * 2. **归档浏览器面板**（插件 `ui-archive-browser`，面板 id `archive-browser`，aux）。
 *
 * 第三件被点名的"语法糖视图（现效果）"**已交付为常态功能（2026-10-14）**，
 * 因此 2026-10-14 起退出本总闸的管辖：它的可用门（`sugar-view.ts` `sugarViewAllowed`）
 * 不再读 `sealed`，入口（工具条按钮 / 命令 / 设置项 / 首次询问）也不再被总闸收起。
 *
 * ## 语义
 *
 * - **封存 = 默认**（`SEALED_DEFAULT`）：新用户 / 新会话看不到这两只面板，设置页只留
 *   一个总开关（「显示已封存功能」）；
 * - **封存不是删除**：底层代码一行全保留（两个插件的面板都还在），只是入口被总闸挡住——
 *   勾选开关可临时恢复，随时可以再关；
 * - **只管面板**：本总闸不再过问任何宿主自身的功能；`SEALED_PANEL_IDS` 是它唯一的管辖清单。
 *
 * ## 纪律
 *
 * 与 `sugar-view.ts` 同款：这是**壳层私事**（写 WebView localStorage，
 * `kojo.ui.sealed.v1`，不进内核存储域）；无 `window`（测试 / 非浏览器）→ 回默认、
 * 绝不抛；不做模块级缓存——读 localStorage 是幂等的布尔投影，缓存只添失效面。
 */

import { useSyncExternalStore } from 'react';

/** 偏好键：`'1'` = 封存中；`'0'` = 显示已封存功能（缺省 / 读不到 = 封存） */
const PREF_KEY = 'kojo.ui.sealed.v1';

/**
 * 默认**封存**。
 *
 * 这两只面板是试用反馈判定"暂不投入"的——默认关掉让设置页保持干净（用户口径：
 * "只留一个开关"）。想看的人在设置页勾一下即可，且**选择会被记住**。
 */
export const SEALED_DEFAULT = true;

/**
 * 被封存的**面板** id 全集（壳层编排 `ui.panel` 贡献时整只滤掉；见 `filterSealedPanels`）。
 *
 * 为什么按面板 id 而不是按插件：壳层零业务知识，它只认面板贡献 id 这张已定契约。
 */
export const SEALED_PANEL_IDS: ReadonlySet<string> = new Set(['sugar-preview', 'archive-browser']);

/**
 * 封存态把 `SEALED_PANEL_IDS` 里的面板整只滤掉；非封存态原样返回。
 *
 * 抽成纯函数的理由只有一个：这条"封存只作用于面板集合"的口径需要能被单测**正面证明**
 * （封着的两块确实消失、其余一块不动），而它在壳层里本来嵌在一句 useMemo 里。
 */
export function filterSealedPanels<T extends { id: string }>(panels: readonly T[], sealed: boolean): T[] {
  return sealed ? panels.filter((p) => !SEALED_PANEL_IDS.has(p.id)) : [...panels];
}

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响本会话） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读偏好（缺省 / 坏值 = `SEALED_DEFAULT`；读不到也回默认，绝不抛） */
export function loadSealed(): boolean {
  const s = storage();
  if (!s) return SEALED_DEFAULT;
  try {
    const raw = s.getItem(PREF_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    // 缺省 / 坏值（手改 localStorage 等）→ 回封存：脏数据的失败方向必须是"少露"，不是"多露"
    return SEALED_DEFAULT;
  } catch {
    return SEALED_DEFAULT;
  }
}

/**
 * 命令式读取"此刻"的闸门值（回调 / 事件监听里用——`useSealed` 之外的场合，
 * 如 `EditorPane` 里只在解锁弹窗的**文案口径**上用到它）。
 */
export function isSealed(): boolean {
  return loadSealed();
}

/** 变更订阅表（`useSyncExternalStore` 的 subscribe；`setSealed` 后逐一声明变化） */
const listeners = new Set<() => void>();

/**
 * 写偏好 + 通知订阅者。
 *
 * 写不进去静默降级（隐私模式 / 配额满）：只影响下次启动的默认值，不影响本次会话
 * ——通知照发，本次会话仍然立即生效。
 */
export function setSealed(v: boolean): void {
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

/** 订阅闸门变化（React 之外也可用；返回取消订阅函数） */
export function subscribeSealed(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React 读写闸门（`useSyncExternalStore`：订阅 `subscribeSealed`、快照 `loadSealed`）。
 *
 * 快照是 localStorage 的幂等布尔投影（无缓存），所以任何一处 `setSealed` 之后
 * 全壳层立即看到一致的新值。
 */
export function useSealed(): boolean {
  return useSyncExternalStore(subscribeSealed, loadSealed);
}
