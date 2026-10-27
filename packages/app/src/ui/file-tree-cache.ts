/**
 * 目录缓存的**淘汰判据**（WS-12；零 React、零 IO，可单测）。
 *
 * 改前的账：`applyDirUpdates` 超上界时只看 `subOpen` 一件——于是
 * ① 已点开「真实文件夹内容」的作者包目录（键是包键，不在 `subOpen` 里）会被当成"没在用"淘汰，
 * ② 当前焦点行 / 多选集合所在的那一层也会被淘汰。
 * 两种都会把**正显示着的**目录挤成空白（缓存没了 ⇒ `DirRows` 一行都不画），
 * 而那正是上一批"展开态是作者的现场，缓存不许把它挤成空白"要避免的事——只是当时只护住了半张现场。
 *
 * 口径：
 * - **保护集 = 正在显示的层**（展开的子目录 ∪ 已点开的包目录 ∪ 焦点行所在层 ∪ 多选行所在层 ∪ 正在编辑的层）；
 * - **顺序可预测**：Map 的插入序 = 首次列举的先后 ⇒ 先淘汰最早那一份**未被保护**的条目；
 * - **护满就不淘汰**：全部条目都在保护集里时原样保留（宁可缓存超一档，也不把作者眼前的目录抹掉）。
 */
import { parentDir } from './file-tree-ops';

/** 缓存条目的淘汰计划（返回要删掉的键；空数组 = 不淘汰） */
export function planDirCacheEviction(
  keys: readonly string[],
  size: number,
  limit: number,
  protect: ReadonlySet<string>,
): string[] {
  if (size <= limit) return [];
  let left = size - limit;
  const out: string[] = [];
  for (const key of keys) {
    if (left <= 0) break;
    if (protect.has(key)) continue;
    out.push(key);
    left--;
  }
  return out;
}

/** 现场信号 → 该保护的目录集合（祖先层也一起保：它的列表没了，子树根本挂不出来） */
export function protectedDirKeysOf(input: {
  subOpen: ReadonlySet<string>;
  openPackageDirs: Iterable<string>;
  focusPath: string | null;
  selectedPaths: readonly string[];
  editingDir?: string | null;
}): Set<string> {
  const out = new Set<string>(input.subOpen);
  for (const dir of input.openPackageDirs) out.add(dir);
  if (input.editingDir) out.add(input.editingDir);
  const protectPath = (path: string): void => {
    let dir = parentDir(path);
    while (dir !== '' && dir !== path) {
      out.add(dir);
      path = dir;
      dir = parentDir(dir);
    }
  };
  if (input.focusPath) protectPath(input.focusPath);
  for (const path of input.selectedPaths) protectPath(path);
  return out;
}
