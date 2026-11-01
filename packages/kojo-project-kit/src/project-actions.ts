/**
 * 项目行动作的纯函数半边（2026-11-02 重命名 / 复制批）。
 *
 * 这里只回答两个问题：**这个名字能不能用**、**副本该叫什么**。
 * 真正的写盘与同根重名判定住内核（`kernel.workspaces`），本层不碰磁盘——
 * 面板拿到的名字先过这里，给作者即时反馈；内核仍会再判一次（防并发 / 跨入口）。
 */

import { dirname, pathKey, type WorkspaceProject } from '@kojo/plugin-api';

/** 名称校验结果：null = 可用；string = 中文原因（原样显示给作者） */
export function projectNameProblem(
  raw: string,
  existingNames: readonly string[],
): string | null {
  const name = raw.trim();
  if (name.length === 0) return '项目名不能为空。';
  if (existingNames.some((n) => n === name)) {
    return `这个位置已经有同名项目：「${name}」。换一个名字再试（同一个文件夹里不能有两个同名项目）。`;
  }
  return null;
}

/** 建议的副本名：「<原名> 副本」；已被占用时顺延「副本 2」「副本 3」… */
export function suggestDuplicateName(name: string, existingNames: readonly string[]): string {
  const base = `${name} 副本`;
  if (!existingNames.includes(base)) return base;
  let n = 2;
  while (existingNames.includes(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/**
 * 与某项目**同一个落点根**下的其它项目名（排序按名称，口径与目录列举一致）。
 *
 * 面板只有一张扁平项目列表，同根判定只能靠目录路径：`dirOf(id)` 给出项目目录，
 * 其父目录即落点根；Windows 分隔符 / 大小写差异经 `pathKey` 折平。
 */
export function sameRootProjectNames(
  projects: readonly WorkspaceProject[],
  projectId: string,
  dirOf: (id: string) => string,
): string[] {
  let root: string;
  try {
    root = pathKey(dirname(dirOf(projectId)));
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const p of projects) {
    if (p.id === projectId) continue;
    let other: string;
    try {
      other = pathKey(dirname(dirOf(p.id)));
    } catch {
      continue;
    }
    if (other === root) names.push(p.name);
  }
  return names;
}
