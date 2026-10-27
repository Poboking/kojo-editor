/**
 * 工作区根模型的**React 接线**（WS-04，2026-10-27）。
 *
 * 纯判据住在 `workspace-folders.ts`；这里只补一件 React 需要的东西：**变化信号**。
 *
 * 为什么需要信号：作者在工作区里新建 / 导入作品时，作品目录是经平台命令写进内核的
 * （没有"根变了"的总线事件）。而写盘会发 `file.changed` ⇒ 在既有时刻现读
 * `workspace.projectDirs()` 并比对（`pathKey` 拼接），真的变了才换 state。
 * 换 state 的后果是**监视 / 树 / Ctrl+P / 检索 / 诊断一起跟上**——它们都从同一个模型派生。
 *
 * 为什么不在模型里读内核：那会把纯函数变成带环境的判据（单测得再造一个假内核），
 * 而"活读"这件事本来就有既有的收口点（`workspace-roots.ts` 的 `projectDirs` 注释）。
 */

import { useEffect, useMemo, useState } from 'react';
import type { Kernel } from '@kojo/kernel';
import type { GameProject } from '@kojo/plugin-api';
import { pathKey } from '@kojo/plugin-api';
import { buildWorkspaceFolders, type WorkspaceFolder } from './workspace-folders';
import { workspaceProjectDirsOf } from './workspace-roots';

/** 作品目录清单的**身份串**（判"这份清单变了没有"；写法变体不算变） */
function signatureOf(dirs: readonly string[]): string {
  return dirs.map((d) => pathKey(d)).join('\n');
}

/**
 * 当前项目的工作区根模型（项目为空 ⇒ 空数组）。
 *
 * 作品目录变化只在**既有时刻**现读：挂载、`file.changed`（新建 / 导入作品落盘）、
 * `project.opened`（换项目后内核那份注册表可能变了）。
 */
export function useWorkspaceFolders(
  kernel: Pick<Kernel, 'workspaces' | 'bus'> | null,
  project: GameProject | null,
  extraRoots: readonly string[] | undefined,
): WorkspaceFolder[] {
  const [authorDirs, setAuthorDirs] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!kernel) {
      setAuthorDirs((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const read = (): void => {
      const next = workspaceProjectDirsOf(kernel);
      setAuthorDirs((prev) => (signatureOf(prev) === signatureOf(next) ? prev : next));
    };
    read();
    const uns = [kernel.bus.on('file.changed', read), kernel.bus.on('project.opened', read)];
    return () => {
      for (const un of uns) un();
    };
  }, [kernel]);

  return useMemo(
    () =>
      project === null
        ? []
        : buildWorkspaceFolders({
            projectRoot: project.rootDir,
            kojoPaths: project.kojoPaths,
            savDir: project.savDir,
            authorDirs,
            extraRoots: extraRoots ?? [],
          }),
    [project, authorDirs, extraRoots],
  );
}
