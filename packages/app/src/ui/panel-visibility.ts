/**
 * 可选面板的显隐（panel-visibility.ts）—— 2026-10-27 用户反馈 5。
 *
 * ## 一句话
 *
 * 有些面板**缺省不进活动栏**（不进任何容器），用户在设置页勾一下才请它出来。
 *
 * ## 为什么要有这一层（而不是干脆把插件关掉）
 *
 * `ui-kojo-xml` 那枚面板只在「口上被搬进 XML」的那类工程里才有内容；别的工程里它是一条
 * **空视图**，却和「口上文件 / 我的口上项目」并排占着活动栏最上面几位。用户原话：
 * 「删除口上XML按钮，默认关闭，需要在设置里显示开启」。关插件不行——那会让另一类工程
 * 连面板都拿不到；壳层按**面板 id** 收着它，才是"位置"的事，不是"能力"的事。
 *
 * ## 纪律（与 `sealed.ts` / `panel-prefs.ts` 同款）
 *
 * - **壳层私事**：写 WebView localStorage，`kojo.ui.panelVisible.<面板 id>.v1`，
 *   不进内核存储域（与 `kojo.ui.layout.v1` / `kojo.ui.sealed.v1` 同族）；
 * - **只做减法**：缺省只看 `HIDDEN_BY_DEFAULT_PANEL_IDS` 这一张 id 表；不在这张表上的
 *   面板一律照旧显示——否则将来每加一个插件面板都要回来改这里（第二张白名单）；
 * - **脏数据的失败方向是"少露"**：读不到 / 坏值 → 回缺省；
 * - **绝不抛**：无 `window`（测试 / 非浏览器）/ 隐私模式 / 配额满都不影响本会话；
 * - **快照缓存只为引用稳定**：`useSyncExternalStore` 要求 `getSnapshot()` 在没变时返回
 *   同一个引用，故按 id 表算出的那份对象缓起来，`setPanelVisible` 时作废。
 */

import { useSyncExternalStore } from 'react';

/**
 * 缺省**不显示**的面板 id（壳层编排时整只滤掉；见 `filterHiddenPanels`）。
 *
 * 为什么按面板 id 而不是插件 id：壳层零业务知识，它只认 `ui.panel` 贡献 id 这张已定契约
 * （与 `SEALED_PANEL_IDS` 同一口径）。
 *
 * `kojo-xml` = 插件 `ui-kojo-xml` 的「口上 XML」面板（`location:'sidebar'`、无 group ⇒
 * 独占一枚活动栏图标）。
 */
export const HIDDEN_BY_DEFAULT_PANEL_IDS: readonly string[] = ['kojo-xml'];

/** 偏好键前缀（后缀是 `.v1`，一个面板一枚键——互不牵连，坏一枚不拖累别人） */
const PREF_PREFIX = 'kojo.ui.panelVisible.';
const PREF_SUFFIX = '.v1';

/** 该面板在不在"缺省收起"那张表里（纯函数；设置页据此决定要不要给这一行） */
export function isOptionalPanelId(id: string): boolean {
  return HIDDEN_BY_DEFAULT_PANEL_IDS.includes(id);
}

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响本会话） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 读某个面板是否**显示**。
 *
 * 缺省值来自 id 表：表内的面板缺省 `false`（不显示），表外的一律 `true`。
 * `'1'` = 显示、`'0'` = 不显示；坏值回落缺省。
 */
export function loadPanelVisible(id: string): boolean {
  const dflt = !isOptionalPanelId(id);
  const s = storage();
  if (!s) return dflt;
  try {
    const raw = s.getItem(`${PREF_PREFIX}${id}${PREF_SUFFIX}`);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return dflt;
  } catch {
    return dflt;
  }
}

/** 快照缓存（`useSyncExternalStore` 的引用稳定；`setPanelVisible` 时作废） */
let snapshotCache: Record<string, boolean> | null = null;

/** 变更订阅表 */
const listeners = new Set<() => void>();

/**
 * 当前显隐快照：`面板 id → 是否显示`（只含 `HIDDEN_BY_DEFAULT_PANEL_IDS` 那几只）。
 *
 * 没变就返回同一个对象——这是 `useSyncExternalStore` 的硬要求，否则每次渲染都判定
 * "外部变了"，整壳无限重渲。
 */
export function readPanelVisibility(): Record<string, boolean> {
  if (snapshotCache !== null) return snapshotCache;
  const next: Record<string, boolean> = {};
  for (const id of HIDDEN_BY_DEFAULT_PANEL_IDS) next[id] = loadPanelVisible(id);
  snapshotCache = next;
  return next;
}

/**
 * 写偏好 + 通知订阅者。
 *
 * 写不进去静默降级（隐私模式 / 配额满）：只影响下次启动的默认值，本次会话仍然立即生效
 * ——通知照发，开关一翻面板立刻进出活动栏。
 */
export function setPanelVisible(id: string, visible: boolean): void {
  const s = storage();
  if (s) {
    try {
      s.setItem(`${PREF_PREFIX}${id}${PREF_SUFFIX}`, visible ? '1' : '0');
    } catch {
      /* 静默降级为"本次会话有效" */
    }
  }
  snapshotCache = null;
  for (const listener of listeners) listener();
}

/** 订阅显隐变化（React 之外也可用；返回取消订阅函数） */
export function subscribePanelVisibility(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React 读显隐快照（订阅 + 幂等快照 + SSR 快照）。
 *
 * 第三个参数 `getServerSnapshot` 不是可选项：设置页的结构守门用 `renderToString` 铺一遍
 * 首屏（`tests/settings-panel-lazy-sections.test.ts`），缺了它 React 当场抛
 * 「Missing getServerSnapshot」，整页渲染不出来。服务端没有 `window`，
 * `readPanelVisibility` 走的就是各面板的缺省值——与"盘上一片空白"逐字等价，故复用同一枚函数。
 */
export function usePanelVisibility(): Record<string, boolean> {
  return useSyncExternalStore(subscribePanelVisibility, readPanelVisibility, readPanelVisibility);
}

/**
 * 编排前的闸：把"缺省收起且用户没打开"的面板整只滤掉；其余面板原样返回（含顺序）。
 *
 * 抽成纯函数的理由与 `filterSealedPanels` 一样：这条"只作用于 id 表内那几只"的口径
 * 需要能被单测正面证明（表内那枚消失、别的一枚不动），而它在壳层里本来嵌在一句 useMemo 里。
 */
export function filterHiddenPanels<T extends { id: string }>(
  panels: readonly T[],
  visible: Readonly<Record<string, boolean>>,
): T[] {
  return panels.filter((p) => !isOptionalPanelId(p.id) || visible[p.id] !== false);
}
