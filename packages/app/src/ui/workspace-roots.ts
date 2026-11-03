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
import { type GameProject, isPathUnder, pathKey } from '@kojo/plugin-api';

/** 全部工作区根（服务不可用 = 空列表，不抛） */
export function workspaceRootsOf(kernel: Pick<Kernel, 'workspaces'>): string[] {
  try {
    return kernel.workspaces.roots();
  } catch {
    return [];
  }
}

/**
 * 常驻**可写**目录（2026-10-27 收窄批）：默认根 + 已解析的作品目录，
 * **不含**自选项目位置根的根身。判定"这份文件是不是作者可写区"只能用这一份。
 *
 * 为什么不是 `roots()`：自选根可能是游戏目录（作者把它选成"项目位置"），
 * 用 `roots()` 判定会把游戏目录下的 ERB 判成"工作区可写"，于是编辑器拿掉只读、
 * 状态栏亮绿——与写闸的实况打脸。`roots()` 保留给"可在哪里新建作品"。
 *
 * 服务不可用（无平台数据目录，如浏览器开发壳）时吞成**空数组**（= 没有可写区），
 * 绝不抛穿渲染路径。
 */
export function workspaceProjectDirsOf(kernel: Pick<Kernel, 'workspaces'>): string[] {
  try {
    return kernel.workspaces.projectDirs();
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

/**
 * 「作品位置」清单的行模型（2026-11-03 默认工作区批；纯函数，node 侧直测）。
 *
 * 三枚标记各说一件事，设置页那一行才说得清「是哪一条」：
 * - `isBuiltin`：出厂就有的软件数据目录（不可撤销，选它 = 清除默认设定）；
 * - `isDefault`：**此刻**新建作品真正落在的那一条（= `defaultRoot()`）；
 * - `available`：`false` 只有一种来路——作者设定过的默认位置当前不在授权名单里
 *   （移动硬盘没插 / 授权被撤）。这条必须照列（铁律 4：失效不许静默），
 *   但它**不是**生效默认，所以点不中、也不给撤销钮。
 */
export interface WorkspaceLocationRow {
  readonly path: string;
  readonly isBuiltin: boolean;
  readonly isDefault: boolean;
  readonly available: boolean;
}

export function workspaceLocationRows(args: {
  readonly roots: readonly string[];
  readonly builtinRoot: string | null;
  readonly defaultRoot: string | null;
  readonly customDefaultRoot: string | null;
}): WorkspaceLocationRow[] {
  const builtinKey = args.builtinRoot === null ? null : pathKey(args.builtinRoot);
  const defaultKey = args.defaultRoot === null ? null : pathKey(args.defaultRoot);
  const rows: WorkspaceLocationRow[] = args.roots.map((path) => ({
    path,
    isBuiltin: builtinKey !== null && pathKey(path) === builtinKey,
    isDefault: defaultKey !== null && pathKey(path) === defaultKey,
    available: true,
  }));
  const saved = args.customDefaultRoot;
  if (saved !== null && !rows.some((r) => pathKey(r.path) === pathKey(saved))) {
    rows.push({ path: saved, isBuiltin: false, isDefault: false, available: false });
  }
  return rows;
}

/**
 * 「作品位置」目录对话框的**禁选根**（2026-11-03 默认工作区批；与向导那条同一判据）。
 *
 * 选到游戏目录（或它的上级）当作品位置，等于把整个游戏目录圈进落点名单，所以把当前
 * 项目的**根目录 / 口上域 / 存档目录**都递过去，由平台侧在**登记之前**做双向包含判定。
 * 这里只负责「取干净」：非字符串、空串丢掉，按 `pathKey` 去重。
 * 没有打开项目 ⇒ 空数组 ⇒ 平台行为与历史逐字一致。
 *
 * 与向导那一条（`kojo-project-kit` 的 `gameRootsForbiddingLocation`）判据逐字相同；
 * 之所以不 import 那份：`@kojo/kojo-project-kit` 不在 app 的依赖里（它是 adapter 的共用件），
 * 而这条防护住在设置页这一侧。两处各一份、由本文件的单测钉住判据。
 */
export function locationForbidRoots(project: GameProject | null): string[] {
  if (project === null) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [project.rootDir, ...project.kojoPaths, project.savDir]) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const k = pathKey(raw);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(raw);
  }
  return out;
}

/* ------------------------------ 会话级附加根（D1，对标 VSCode Add Folder to Workspace） ------------------------------ */

/**
 * 「添加文件夹到工作区」的计划（纯函数，可单测）。
 *
 * 会话级附加根 = 只在**当前项目会话**里生效的浏览/检索/监视根（不进写允许域），
 * 与上面的**作者作品落点根**（`workspaces.roots()`）语义不同、互不替代。
 * WS-08 起随会话记录一起持久化（按项目记，重启后回到同一组根），但关项目 /
 * 换项目仍整体清空——绝不把上一个项目的根带进下一个。
 *
 * 判等一律走 `pathKey`（折叠分隔符与大小写）：同一目录的两种写法不算两个根。
 */
export interface AddExtraRootPlan {
  /** 计划落定后的附加根列表（拒绝时原样返回，绝不半改） */
  readonly roots: readonly string[];
  /** 拒绝时的一句人话（null = 添加成功，无需出声） */
  readonly note: string | null;
}

export function planAddExtraRoot(
  existing: readonly string[],
  dir: string,
  projectRoot?: string,
): AddExtraRootPlan {
  const k = pathKey(dir);
  if (projectRoot !== undefined && pathKey(projectRoot) === k) {
    return { roots: [...existing], note: '这个文件夹就是当前项目所在的位置，不用再加进工作区。' };
  }
  if (existing.some((r) => pathKey(r) === k)) {
    return { roots: [...existing], note: '这个文件夹已经在工作区里了，不用重复添加。' };
  }
  return { roots: [...existing, dir], note: null };
}

/** 「从工作区移除文件夹」的计划（WS-08；纯函数，可单测） */
export interface RemoveExtraRootPlan {
  /** 计划落定后的附加根列表（没命中时原样返回，绝不半改） */
  readonly roots: readonly string[];
  /** 是否真的移除了 */
  readonly removed: boolean;
  /** 给出声的人话（移除成功 / 本来就不在，两种都出声——按下去必须有响，铁律 4） */
  readonly note: string;
}

export function planRemoveExtraRoot(existing: readonly string[], dir: string): RemoveExtraRootPlan {
  const k = pathKey(dir);
  const kept = existing.filter((r) => pathKey(r) !== k);
  if (kept.length === existing.length) {
    return {
      roots: [...existing],
      removed: false,
      note: '这个文件夹不在工作区里，无需移除。',
    };
  }
  const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
  return { roots: kept, removed: true, note: `已从工作区移除：${name}` };
}
