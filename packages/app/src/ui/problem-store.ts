/**
 * 编辑器「问题」汇总（壳层私有，2026-10-14 看板 HK-4 · UI-6）。
 *
 * 为什么单独成文件（不写在 ProblemPanel 里）：这是**数据判据**，不是渲染细节。
 * 上线前 `erb-parser`（结构类，error）与 `condition-extractor`（表达式类，warning）
 * 两层波浪线**只画在 Monaco 里**，没有可展开的列表——本模块把两层的 `LineDecoration`
 * 汇总成一份可订阅的注册表，再抽成纯函数才能被单测钉住（与 §5.105 把布局 reducer
 * 搬到 `layout.ts`、把通知淘汰规则放进 `notice-queue.ts` 同一做法）。
 *
 * 键 = 文件路径。装饰器的唯一计算点在 `EditorPane.refreshMarkers`，那里逐文件整份重发；
 * 标签关闭 / 卸载即清键——避免切走的文件留下「幽灵诊断」。
 */

import type { KernelEventMap } from '@kojo/plugin-api';

/** 落点区间（契约 `editor.revealLocation.span` 反推；面板不自立形状） */
export type ProblemSpan = NonNullable<KernelEventMap['editor.revealLocation']['span']>;

export interface EditorProblem {
  /** 文件路径（原样保留，跳源行与分组都靠它） */
  path: string;
  /** 1 基行号 */
  line: number;
  /**
   * 波浪线盖住的**列区间**（1 基、UTF-16 码元、终点不含）——W9 落点 span 批补上的一环：
   * 装饰器本来就带 `startColumn` / `endColumn`，此前汇总到面板时被整条丢掉，
   * 于是"点问题跳过去落在行首、同一个位置按 F12 落在名字那一列"。
   * 缺席 = 这一条只有行级信息（退化判据唯一，住在 `monaco/reveal-position.ts`，面板不许自算）。
   */
  span?: ProblemSpan;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** 可选诊断码（工具提示 / 过滤用；游戏无关的稳定标识） */
  code?: string;
  /**
   * 诊断码的**可读来源标签**（additive，DIAG-LINK 2026-10-18）：`LineDecoration.source`
   * 原样带到面板行——多来源发布后，同一个 `code` 可能住在几条流水线上，面板要说得出
   * "这条是谁报的"，而 `code` 是稳定标识、不许带来源限定词（改名即断链）。
   * 缺省 = 旧行为（面板只显示 `code`）。
   */
  source?: string;
}

/** 严重度排序权重（error 最靠前；越小越先出） */
const SEVERITY_RANK: Record<EditorProblem['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * 扁平列表的排序口径（导出供单测钉死）：
 * severity（error > warning > info）→ path 升序 → line 升序。
 *
 * 不修改入参（返回新数组）——React state 依赖引用不变性。
 */
export function sortProblems(items: readonly EditorProblem[]): EditorProblem[] {
  return [...items].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });
}

/** 模块级注册表：path → 该文件的全部问题（整份替换语义，不做增量） */
const registry = new Map<string, EditorProblem[]>();
const listeners = new Set<() => void>();

/**
 * 版本号 + 脏标记（PS-15）：`notify` 只置脏加版本，`snapshot` 只在**脏时**重算——
 * 同一版本内多次 `snapshot()` 返回**同一引用**（订阅回调 / 渲染 / 计数三方都来问时
 * 扁平化 + 排序只算一次），干净时零分配零排序。`version()` 供消费方做 memo 依赖
 * （数字比较，不持有数组引用也能知道"变没变"）。
 */
let version = 0;
let dirty = true;
let cached: readonly EditorProblem[] = [];

function notify(): void {
  dirty = true;
  version++;
  for (const l of listeners) l();
}

/** 当前版本号（每次实际变更 +1；消费方做 cheap 比较用） */
export function currentVersion(): number {
  return version;
}

/** 整份替换某文件的诊断；空数组即删除该键（该文件已无问题） */
export function setProblems(path: string, items: readonly EditorProblem[]): void {
  if (items.length === 0) {
    if (registry.delete(path)) notify();
    return;
  }
  registry.set(path, [...items]);
  notify();
}

/** 清掉某文件的诊断（标签关闭 / 卸载时调，防残留） */
export function clearProblems(path: string): void {
  if (registry.delete(path)) notify();
}

/** 清空全部（编辑器整体卸载时调） */
export function clearAllProblems(): void {
  if (registry.size === 0) return;
  registry.clear();
  notify();
}

/**
 * 扁平化 + 排序后的只读快照（**脏时重算，干净时返回同一引用**——同一版本内幂等，
 * 这是 `useSyncExternalStore` 形态的消费方不无限重渲的前提；见 `currentVersion`）。
 */
export function snapshot(): readonly EditorProblem[] {
  if (!dirty) return cached;
  const out: EditorProblem[] = [];
  for (const items of registry.values()) out.push(...items);
  cached = sortProblems(out);
  dirty = false;
  return cached;
}

/** 订阅变更（变更即通知）；返回退订函数 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
