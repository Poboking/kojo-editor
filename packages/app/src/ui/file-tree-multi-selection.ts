/**
 * 文件树「多选集」的**模块级订阅点**（D 批 · 双文件比较）。
 *
 * 与 `file-tree-selection`（活动文件 = 单值）是一对兄弟，但语义不同：
 *
 * - `file-tree-selection` 回答"哪一份正被编辑器打开"（单值，换选中惊动两行）；
 * - 本模块回答"作者在这棵树里勾了哪几份文件"（一个有序集合，用于 Compare Selected）。
 *
 * ## 为什么是模块级 + 行自己订阅
 *
 * 与 PERF 批那条教训同源：勾选态一旦作为 prop 穿进 `FileRows` / `DirRows`，每勾一个文件
 * 就把整棵树的 JSX 重造一遍（真语料 2,325 行）。放成模块级状态、行自己订阅一个**布尔**
 * 快照（`isRowSelected`），勾选的代价就只剩"旧行与新行两枚快照翻转"。
 *
 * ## 口径（都可单测）
 *
 * - **只有文件行参与**：目录行 / 角色组 / 作者包不勾选——"比较两个源文件"要的是两份文件，
 *   目录进集合只会让判据含混。判据因此可写成"集合里每一项都是文件"。
 * - **插入序 = 选中顺序**：比较时左侧取先勾的那一份（与 VSCode "第一个选中当原侧"同感），
 *   不排序——排一次序就再也说不出"作者先选的是谁"。
 * - **写入幂等**：同值不通知（宿主可每帧同步一遍），与 `file-tree-selection` 同一条。
 * - 判等按 `pkey`（分隔符 / 大小写归一）：同一份文件在口上视图与文件系统视图下交替出现，
 *   两种写法不能被当成两个不同项。
 *
 * 纯数据、零 React import（SSR / 单测可直接读写）。
 */
import { pkey } from './file-tree-ops';

type Listener = () => void;

let selected: readonly string[] = [];
const listeners = new Set<Listener>();

/** 当前多选集（有序快照；未勾选 = 空数组） */
export function getSelectedPaths(): readonly string[] {
  return selected;
}

/** 某一行是否被勾选。**专供 `useSyncExternalStore` 的 getSnapshot**：布尔 ⇒ 无关行不重渲 */
export function isRowSelected(path: string): boolean {
  const key = pkey(path);
  return selected.some((p) => pkey(p) === key);
}

function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (pkey(a[i]!) !== pkey(b[i]!)) return false;
  return true;
}

function notify(): void {
  for (const l of [...listeners]) l();
}

/** 整体替换多选集（单值选中 / 右键后的现场同步）。按 `pkey` 去重、保持首次出现的顺序。 */
export function setSelected(paths: readonly string[]): void {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const p of paths) {
    const key = pkey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(p);
  }
  if (sameSelection(next, selected)) return;
  selected = next;
  notify();
}

/**
 * 切换一个文件行的勾选（Ctrl / Cmd + 单击）。
 *
 * 已在集合里 ⇒ 移出；不在 ⇒ 追加到末尾（插在末尾 = 后勾的那份当比较的右/对照侧）。
 */
export function toggleSelected(path: string): void {
  const key = pkey(path);
  const exists = selected.some((p) => pkey(p) === key);
  selected = exists ? selected.filter((p) => pkey(p) !== key) : [...selected, path];
  notify();
}

/** 清空（换项目 / 树卸载）。同值不通知。 */
export function clearSelected(): void {
  if (selected.length === 0) return;
  selected = [];
  notify();
}

/** 行级订阅（`useSyncExternalStore` 的第一个参数） */
export function subscribeMultiSelection(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试用：把单例复位（生产不留"清空"入口——见模块头） */
export function resetMultiSelectionForTest(): void {
  selected = [];
  listeners.clear();
}