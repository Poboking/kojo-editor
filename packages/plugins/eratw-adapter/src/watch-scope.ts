/**
 * 外部改动落在作者工作区的哪一层（2026-10-13 看板 HK-6；纯函数，可单测）。
 *
 * 背景：§5.91 把**工作区根**加进了监视根（`App.tsx` 的 `fileWatch.start`），
 * 于是作者用资源管理器往包里丢一个文件、或直接在磁盘上改包名，都会以
 * `file.changed` 到达面板——但面板的 `wsDirCache` 此前只被**本插件自己的动作**失效
 * （`createItem → refreshDir` / `invalidateWs`）。期望是那一批制造的，收口也该是它。
 *
 * 判据只有一条形状：**"某个目录的内容变了" ≡ 改动条目的父目录要重列**。
 * 再往上就什么都不做——列在缓存里的目录才值得重列（没缓存的等展开时惰性取，
 * 那是新数据），所以这里只回答"该重列谁"，不回答"要不要重列"（那是接线侧看缓存）。
 *
 * 零游戏知识：只认路径形状，不认 `.ERB` / `.kojo` / 口上目录。
 */

import { dirname, isPathUnder, pathKey } from '@kojo/plugin-api';

export interface WorkspaceChange {
  /**
   * 内容变了、需要重列的那个目录（改动条目的父目录）。
   * 不在工作区内（例如游戏目录那半边的改动）→ null。
   */
  dirToRefresh: string | null;
  /**
   * 改动落在工作区根的**直接子层**——项目目录本身被建/删/改名，
   * 项目列表（扫根目录读 manifest 得来）必须重拉。
   */
  projectListChanged: boolean;
}

/**
 * @param path 改动条目路径（内核已归一化）
 * @param roots 工作区**全部**落点根（默认根 + 作者自选并常驻授权的项目位置根）；
 *              空数组（服务不可用 = 无平台数据目录的环境）⇒ 一律不响应
 *
 * 命中多个根时取**最长前缀**（最深）那个做相对定位：两个根互为前缀时
 * （`D:\作品` 与 `D:\作品\子库`）只有按更深的那个算，`dirname` 出来的目录才对得上
 * 真实住着的包，否则刷新的目录会指错一层。
 */
export function workspaceChangeOf(path: string, roots: readonly string[]): WorkspaceChange {
  if (roots.length === 0) return noChange();
  let hit: string | null = null;
  for (const root of roots) {
    if (!isPathUnder(root, path)) continue;
    // 更深（被前一个包含）的根赢；相等（同一目录两种写法）保留先出现的
    if (hit === null || isPathUnder(hit, root)) hit = root;
  }
  if (hit === null) return noChange();
  const parent = dirname(path);
  // 根自己那一层（path 直接住在根下）→ 父目录就是根：项目列表变了
  const atRoot = pathKey(parent) === pathKey(hit);
  return { dirToRefresh: parent, projectListChanged: atRoot };
}

function noChange(): WorkspaceChange {
  return { dirToRefresh: null, projectListChanged: false };
}
