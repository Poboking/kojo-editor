/**
 * 文件树「当前活动文件」的**行级订阅点**（PERF 批：切标签不再整树重渲染）。
 *
 * 为什么需要它：`activeFile` 一旦作为 prop 穿进 `FileRows` / `DirRows`，宿主每换一次
 * 活动文件，那些组件的 `memo` 就按浅比较**必然放行** —— 整组行重新 `createElement` +
 * 逐行 `probs.get(pkey(f))`，成本随文件数线性涨（真语料 2,325 文件时一次切标签就是
 * 一帧几十毫秒）。把"谁是活动文件"从 props 里拿出来、改成**行自己订阅**，父级就与
 * 选中态彻底解耦：换选中时只有**旧行与新行**两枚 `getSnapshot` 结果翻转，其余行零工作。
 *
 * 口径（与 memo 前提同族）：
 * - 快照是**布尔**（`path === activePath`）⇒ 引用天然稳定，`useSyncExternalStore`
 *   不会因为"每次新对象"空转；
 * - 写入幂等（同值不通知）⇒ 宿主可以每次渲染都同步一遍，不必自己判重；
 * - 模块级单例：同一时刻只会有一棵树在显示（`FileTree` 由宿主以稳定组件身份注入），
 *   卸载**不**清空——清空会把下一个挂载者的首帧变成"无选中"闪一下，由后挂载者覆盖即可。
 *
 * 纯数据、零 React import（SSR / 单测可直接读写）。
 */

type RowListener = () => void;
type PathListener = (path: string | null) => void;

let activePath: string | null = null;
const rowListeners = new Set<RowListener>();
const pathListeners = new Set<PathListener>();

/** 当前活动文件（未打开任何文件 = null） */
export function getActivePath(): string | null {
  return activePath;
}

/**
 * 改选中。同值直接返回：宿主每次渲染都会同步一遍（`FileTree` 的桥），
 * 幂等是那条写法的前提。
 */
export function setActivePath(next: string | null): void {
  if (next === activePath) return;
  activePath = next;
  // 先通知行（谁的两态翻转了谁自己重画），再通知"变化"订阅者（自动定位那条腿）。
  // 两批各拷一份：通知期间有人退订也不会漏掉本轮其余订阅者。
  for (const l of [...rowListeners]) l();
  for (const l of [...pathListeners]) l(next);
}

/** 行级订阅（`useSyncExternalStore` 的第一个参数） */
export function subscribeSelection(listener: RowListener): () => void {
  rowListeners.add(listener);
  return () => {
    rowListeners.delete(listener);
  };
}

/** 「选中换了」订阅（自动定位用：它要的是**事件**，不是当前值——读值会把自己变成渲染依赖） */
export function subscribeActivePath(listener: PathListener): () => void {
  pathListeners.add(listener);
  return () => {
    pathListeners.delete(listener);
  };
}

/**
 * 某一行是否被选中。**专供 `useSyncExternalStore` 的 getSnapshot**：
 * 返回布尔 ⇒ 无关行拿到的快照值不变 ⇒ React 不会为它们排重渲染。
 */
export function isRowActive(path: string): boolean {
  return activePath === path;
}

/** 测试用：把单例复位（生产不留"清空"入口——见模块头的卸载口径） */
export function resetSelectionForTest(): void {
  activePath = null;
  rowListeners.clear();
  pathListeners.clear();
}
