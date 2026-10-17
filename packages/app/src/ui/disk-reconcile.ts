import { isPathUnder } from '@kojo/plugin-api';

/**
 * 文件树盘上操作的纯逻辑（B1 标签收尾 + 删除/重命名守门）。
 *
 * 状态单源在 App，本模块只做「给定路径 / 集合 → 下一集合」的无副作用换算——
 * App 与测试共用同一份口径（照 `project-switch.ts` 的先例）。
 *
 * 这里的「删除命中」谓词（相等或位于被删目录之下，含 rename 换键）与 `omitPaths`
 * 那种「按路径精确剔除」是两件事，**不许合并**：递归删目录会把子路径一起带走，
 * 关标签只端走恰好在集合里的那一条。
 */

/** 路径是否被某个「已删除目标」命中：自身相等，或位于被删目录之下（递归删除是大刀） */
export function pathGoneByDelete(deleted: readonly string[], p: string): boolean {
  return deleted.some((d) => p === d || isPathUnder(d, p));
}

/**
 * 删除/重命名的守门：涉及**打开中且有未保存修改**的文件就拦下，给一句人话。
 * 目录同样拦——脏文件在被删目录之下时，"删目录"会把它一起带走（递归删除是大刀）。
 */
export function fileOpGuardMessage(
  paths: readonly string[],
  dirtyPaths: ReadonlySet<string>,
): string | null {
  for (const target of paths) {
    for (const p of dirtyPaths) {
      if (p === target || isPathUnder(target, p)) {
        const name = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
        return `文件「${name}」有未保存修改，请先保存或关闭它，再进行删除/重命名。`;
      }
    }
  }
  return null;
}

/**
 * 盘上事实变更后的路径集合收尾（脏态与固定态同一份口径）：被删的（含被删目录下的
 * 子路径）退出、被改名的换新路径——不留悬空旧路径。没命中时返回**同一个引用**，
 * 不给 React 制造无谓的重渲染。
 */
export function reconcilePathsAfterDiskChange(
  prev: ReadonlySet<string>,
  deleted: readonly string[],
  renamed: ReadonlyArray<{ from: string; to: string }>,
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const d of deleted) {
    for (const p of prev) {
      if (p === d || isPathUnder(d, p)) {
        next ??= new Set(prev);
        next.delete(p);
      }
    }
  }
  // 改名的脏标签不该出现（守门拦了），但真发生时也不能留出悬空旧路径
  for (const r of renamed) {
    if (prev.has(r.from)) {
      next ??= new Set(prev);
      next.delete(r.from);
      next.add(r.to);
    }
  }
  return next ?? prev;
}
