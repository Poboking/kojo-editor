/**
 * 看板的**作用域分组**（口上包域；零 React、零 IO）。
 *
 * 口径与 `ui-condition-matrix/matrix-scope.ts` 同形（同一份「作者包 = 口上根下第一层
 * 子目录」的产品语义，各自私有持有——插件间禁交叉 import），但作用面是**整棵索引**：
 * - 作者口上树（`GameProject.kojoPaths` 各根）：第一层子目录 = 一个口上包；
 *   直接挂根上的文件 = 口上根散文件；
 * - 只读基座库（`libraryPaths`）：整域一档「基座库」（作者树之外，浏览但不改）；
 * - 两者都匹配不上：索引外文件。
 *
 * 这就是「查看自己的 / 当前项目的 / 某某口上包的」的数据骨架：作者树域 =
 * 当前项目，包 = 口上包，基座库域 = 游戏自带的那部分。
 */

import type { PackSummary } from './panel-logic';

/** 口上根散文件的包键（直接挂在口上根下，不再分作者包） */
export const PACK_ROOT = '';

/** 只读基座库域（libraryPaths 命中；与作者树分开一档） */
export const PACK_LIBRARY = '\u0000library';

/** 索引根之外的文件 */
export const PACK_EXTERNAL = '\u0000external';

/** 路径分段（去掉空段，保留原样大小写——显示要用磁盘上的原样） */
function segmentsOf(path: string): string[] {
  return path.split(/[\\/]+/).filter((s) => s.length > 0);
}

/** `path` 相对 `root` 的分段（根不匹配 → null）；判等 Windows 折叠大小写 */
export function relativeSegments(path: string, root: string): string[] | null {
  const ps = segmentsOf(path);
  const rs = segmentsOf(root);
  if (rs.length === 0 || rs.length > ps.length) return null;
  // 整条路径的风格同判：单看一段会被误判成 POSIX，漏掉 Windows 折叠
  const isWin = /^[a-zA-Z]:[\\/]/.test(path) || path.includes('\\') || root.includes('\\');
  const same = (a: string, b: string): boolean => (isWin ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (let i = 0; i < rs.length; i++) {
    if (!same(ps[i]!, rs[i]!)) return null;
  }
  return ps.slice(rs.length);
}

/** 文件路径 → 包键（kojoPaths 各根优先，其次基座库，其余 = 索引外） */
export function packKeyOfPath(
  filePath: string,
  kojoPaths: readonly string[],
  libraryPaths: readonly string[] = [],
): string {
  for (const root of kojoPaths) {
    const rel = relativeSegments(filePath, root);
    if (rel) return rel.length <= 1 ? PACK_ROOT : rel[0]!;
  }
  for (const root of libraryPaths) {
    if (relativeSegments(filePath, root)) return PACK_LIBRARY;
  }
  return PACK_EXTERNAL;
}

export function packLabel(key: string): string {
  if (key === PACK_ROOT) return '（口上根散文件）';
  if (key === PACK_LIBRARY) return '（只读基座库）';
  if (key === PACK_EXTERNAL) return '（索引外）';
  return key;
}

/** 从一批文件路径聚合包清单（计数文件数；顺序 = 首次出现序，稳定） */
export function collectPacks(
  filePaths: readonly string[],
  kojoPaths: readonly string[],
  libraryPaths: readonly string[] = [],
): PackSummary[] {
  const byKey = new Map<string, { files: Set<string>; order: number }>();
  filePaths.forEach((p, order) => {
    const key = packKeyOfPath(p, kojoPaths, libraryPaths);
    let e = byKey.get(key);
    if (!e) {
      e = { files: new Set<string>(), order };
      byKey.set(key, e);
    }
    e.files.add(p);
  });
  return [...byKey.entries()]
    .map(([key, e]) => ({ key, label: packLabel(key), fileCount: e.files.size, order: e.order }))
    .sort((a, b) => a.order - b.order)
    .map(({ key, label, fileCount }) => ({ key, label, fileCount, functionCount: 0 }));
}

/** 包键是否可选（外部文件档只在有内容时出现；空域不渲染空壳） */
export function isSelectablePack(key: string): boolean {
  return key !== PACK_EXTERNAL;
}
