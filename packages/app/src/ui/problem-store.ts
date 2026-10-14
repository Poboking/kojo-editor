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

export interface EditorProblem {
  /** 文件路径（原样保留，跳源行与分组都靠它） */
  path: string;
  /** 1 基行号 */
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** 可选诊断码（工具提示 / 过滤用；游戏无关的稳定标识） */
  code?: string;
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

function notify(): void {
  for (const l of listeners) l();
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

/** 扁平化 + 排序后的只读快照（每次调用都重新算，从不缓存旧引用） */
export function snapshot(): readonly EditorProblem[] {
  const out: EditorProblem[] = [];
  for (const items of registry.values()) out.push(...items);
  return sortProblems(out);
}

/** 订阅变更（变更即通知）；返回退订函数 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
