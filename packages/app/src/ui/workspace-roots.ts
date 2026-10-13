/**
 * 工作区**全部**落点根的读取（2026-10-14 新建项目自选位置批的收口）。
 *
 * 背景：作者可以在向导里用系统目录对话框选一个文件夹当作品落点，于是"工作区"不再是
 * 一个目录而是若干个（默认根 `<appDataDir>/workspaces` + 授权自选根）。任何还按
 * "单一根"写的判定都会把自选根里的作品当成工作区外的东西。
 *
 * 为什么不缓存返回值（本模块的形态就是为此而定的）：`roots()` 是同步读内存数组、零 IO，
 * 缓存它**没有任何收益**，反而会把"本会话刚自选的那个新根"永远排除在外——缓存一次定死，
 * 之后新建/新授权的位置落在自选根里就一路判成"不在工作区"。
 *
 * 降级：服务不可用（无平台数据目录，如浏览器开发壳）时 `roots()` 抛错，这里吞成**空数组**
 * =「没有工作区」：判定一律为假，但**绝不抛穿渲染路径**。
 */

import type { Kernel } from '@kojo/kernel';
import { isPathUnder } from '@kojo/plugin-api';

/** 全部工作区根（服务不可用 = 空列表，不抛） */
export function workspaceRootsOf(kernel: Pick<Kernel, 'workspaces'>): string[] {
  try {
    return kernel.workspaces.roots();
  } catch {
    return [];
  }
}

/**
 * p 是否落在**任一根**之内（组件级判定：`<根>-备份` 这类同前缀的邻居目录不算命中，
 * 该语义由 `isPathUnder` 的分隔符边界给出）。空根列表 ⇒ false。
 */
export function isUnderAnyRoot(roots: readonly string[], p: string): boolean {
  return roots.some((root) => isPathUnder(root, p));
}
