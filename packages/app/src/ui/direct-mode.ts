/**
 * 直连模式开关（direct-mode.ts）—— 2026-10-14 直连模式批。
 *
 * ## 这个功能干什么（一句话）
 *
 * 纪要 §4-2：「项目模式为默认（显式部署），保留『直连模式』兼容就地编辑」。
 * 补上那枚**全局模式开关**：开启后，游戏目录里**已获写权限**（`kernel.io.isWritable`
 * 为 true，即用户已批准 writablePaths）的 `.ERB` 视为**可直接编辑**（编辑器
 * readOnly=false），省掉逐个文件会话解锁（轴二 `unlockedPathsRef`）的仪式。
 *
 * ## 写保护铁律不破（关键）
 *
 * 直连模式**只影响编辑器的 readOnly 门**；真正落盘仍走内核 io 写白名单
 * （`isWritable`）。直连模式**不扩权**——白名单外的文件一律仍只读（保存时照旧走
 * 既有的拒绝 + 去授权流程）。它是"省事"，不是"放权"。
 *
 * ## 与糖视图互斥（ADR-0005）
 *
 * 可编辑 ⟹ 糖视图不可用（糖视图靠"原文让位"工作，可编辑的原文必须始终看得见）。
 * 故直连可编辑的游戏目录 ERB 不放糖视图。
 *
 * ## 纪律（与 sealed.ts / sugar-view.ts 同款）
 *
 * 这是**壳层私事**（写 WebView localStorage，`kojo.ui.directMode.v1`，不进内核
 * 存储域）；无 `window`（测试 / 非浏览器）→ 回默认、绝不抛；不做模块级缓存——
 * 读 localStorage 是幂等的布尔投影，缓存只添失效面。
 *
 * ## 封存（默认不渲染）
 *
 * 按项目约定「新增功能默认经封存总闸控制」：设置页这枚开关默认**不渲染**，
 * 只在 `!sealed`（勾选"显示已封存功能"）后才出现（sealed 轴见 `sealed.ts`）。
 *
 * ## 键与默认值语义
 *
 * `'1'` = 开；`'0'` = 关；缺省 / 坏值 = 关（`DIRECT_MODE_DEFAULT`）。
 * 脏数据的失败方向必须是"少露"（默认只读），与 sealed 的失败方向一致。
 */

import { useSyncExternalStore } from 'react';

/** 偏好键：`'1'` = 开；`'0'` = 关（缺省 / 读不到 = 关） */
const PREF_KEY = 'kojo.ui.directMode.v1';

/**
 * 默认**关**。
 *
 * 直连模式是"就地编辑游戏目录"的可选工作流，不是默认姿态——默认仍走"逐个文件
 * 会话解锁"的仪式，让写保护默认保持在最保守的方向上。想用的人在设置页勾一下
 * 即可，且**选择会被记住**。
 */
export const DIRECT_MODE_DEFAULT = false;

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响本会话） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读偏好（缺省 / 坏值 = `DIRECT_MODE_DEFAULT`；读不到也回默认，绝不抛） */
export function loadDirectMode(): boolean {
  const s = storage();
  if (!s) return DIRECT_MODE_DEFAULT;
  try {
    const raw = s.getItem(PREF_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    // 缺省 / 坏值（手改 localStorage 等）→ 回默认：脏数据的失败方向必须是"少露"，不是"多露"
    return DIRECT_MODE_DEFAULT;
  } catch {
    return DIRECT_MODE_DEFAULT;
  }
}

/**
 * 命令式读取"此刻"的开关值（回调 / 事件监听里用——`useDirectMode` 之外的场合，
 * 如 `EditorPane` 的 `directEditable` 与糖视图可用门）。
 */
export function isDirectMode(): boolean {
  return loadDirectMode();
}

/** 变更订阅表（`useSyncExternalStore` 的 subscribe；`setDirectMode` 后逐一声明变化） */
const listeners = new Set<() => void>();

/**
 * 写偏好 + 通知订阅者。
 *
 * 写不进去静默降级（隐私模式 / 配额满）：只影响下次启动的默认值，不影响本次会话
 * ——通知照发，本次会话仍然立即生效。
 */
export function setDirectMode(v: boolean): void {
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

/** 订阅开关变化（React 之外也可用；返回取消订阅函数） */
export function subscribeDirectMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React 读写开关（`useSyncExternalStore`：订阅 `subscribeDirectMode`、快照 `loadDirectMode`）。
 *
 * 快照是 localStorage 的幂等布尔投影（无缓存），所以任何一处 `setDirectMode` 之后
 * 全壳层立即看到一致的新值。
 */
export function useDirectMode(): boolean {
  return useSyncExternalStore(subscribeDirectMode, loadDirectMode);
}
