/**
 * 封存总闸（sealed.ts）—— 2026-10-13 试用反馈批。
 *
 * ## 为什么需要它（一句话）
 *
 * 试用反馈：「把那些没用的功能，都给我封存了！只留一个开关放在设置页面」。
 * 三件被点名的功能**整体封存**：
 * 1. **语法糖视图（现效果）**—— EditorPane 里把游戏目录 ERB 投影成中文表层的显示；
 * 2. **糖预览面板**（插件 `ui-sugar-preview`，面板 id `sugar-preview`，aux）；
 * 3. **归档浏览器面板**（插件 `ui-archive-browser`，面板 id `archive-browser`，aux）。
 *
 * ## 语义
 *
 * - **封存 = 默认**（`SEALED_DEFAULT`）：新用户 / 新会话看不到这三件，设置页只留
 *   一个总开关（「显示已封存功能」）；
 * - **封存不是删除**：底层代码一行全保留（糖视图投影器、两个插件的面板都还在），
 *   只是入口被总闸挡住——勾选开关可临时恢复，随时可以再关；
 * - **封存优先于一切**：糖视图可用门（`sugar-view.ts` `sugarViewAllowed`）里它是
 *   最高优先级的一条轴；但**不动用户的底层偏好**——`editor.sugarView.set` 开关意图
 *   在封存态被直接忽略，不偷偷改写 `kojo.ui.sugarView.v1`，解封即按原偏好恢复。
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
 * 这三件是试用反馈判定"暂不投入"的——默认关掉让设置页保持干净（用户口径：
 * "只留一个开关"）。想看的人在设置页勾一下即可，且**选择会被记住**。
 */
export const SEALED_DEFAULT = true;

/**
 * 被封存的**面板** id 全集（壳层编排 `ui.panel` 贡献时整只滤掉）。
 *
 * 为什么按面板 id 而不是按插件：壳层零业务知识，它只认面板贡献 id 这张已定契约。
 * 糖视图（EditorPane 的现效果）不走面板，由宿主自身的三处入口单独挡
 * （见 `EditorPane` 的可用门 / 首次询问 / 开关监听）。
 */
export const SEALED_PANEL_IDS: ReadonlySet<string> = new Set(['sugar-preview', 'archive-browser']);

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
 * 如 `applySugarView` 与 `editor.sugarView.set` 监听）。
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
