/**
 * 工作区**根集合的单一模型**（WS-04，2026-10-27）。
 *
 * 改前的形状：文件监视 / 全文检索 / Ctrl+P / 文件树 / 整项目诊断**各自拼根**，
 * 五份根集合互相对不上。账单写得出来：作者工作区（`workspaces.projectDirs()`）里的
 * 文件「搜索能搜到、监视能收到，但树里没有、Ctrl+P 找不到」——因为树只认口上域，
 * Ctrl+P 的源清单也只认口上域。根多一份副本，可见性就多一处裂缝。
 *
 * 本模块只做一件事：把「游戏根 / 口上域 / 存档 / 作者作品目录 / 会话附加根」折成
 * 一张**带能力的表**（{@link WorkspaceFolder}），五条消费者一律从这张表派生根清单，
 * 不再各写一遍「根 = A ∪ B」。判据全在这里、纯函数、可单测：
 *
 * - **去重**走 `pathKey`（折叠大小写与分隔符）：同一目录的两种写法是一个根；
 * - **同路径多角色**取**更具体**的那个（author > game > extra）：同一目录既是作品目录
 *   又是附加根时，它当然是可写的，不该被只读口径盖住；
 * - **去嵌套**：整根落在另一根之内、且能力被完全覆盖时只留外层（`isPathUnder` 的
 *   分隔符边界语义，`<根>-备份` 这类同前缀邻居不算命中）。`sav` 落在游戏根里 ⇒ 折掉；
 *   口上域虽然也在游戏根之内，但它多一条 `quickOpen`（游戏根整盘不进 Ctrl+P）⇒ 保留；
 * - **按能力取根**（`watchRootsOf` / `quickOpenRootsOf` / ...）再做一次**覆盖折叠**：
 *   外层已经按同一能力覆盖到的根不再重复交出去（否则同一批文件被走两遍）。
 *
 * 零游戏名词（铁律 1）：这里只有泛型路径与角色，不认识任何具体游戏的目录名。
 */

import type { GameProject } from '@kojo/plugin-api';
import { isPathUnder, pathKey } from '@kojo/plugin-api';
import type { Kernel } from '@kojo/kernel';
import { workspaceProjectDirsOf } from './workspace-roots';

/** 根的角色：游戏根 / 作者作品目录 / 会话附加根 */
export type WorkspaceFolderRole = 'game' | 'author' | 'extra';

/**
 * 一个工作区根及其**能力**（谁能看见它）。
 *
 * 能力是布尔事实，不设"档位"：消费者按自己那一条腿取（监视取 `watch`、Ctrl+P 取
 * `quickOpen`、检索取 `search`、树取 `browsable`），不许跨腿借用别人的判断。
 */
export interface WorkspaceFolder {
  /** 绝对路径（原样保留首次出现的写法，判等一律 `pathKey`） */
  readonly path: string;
  readonly role: WorkspaceFolderRole;
  /** 人话标签：项目根 / 口上域 / 存档 / 作品目录末段 / 附加文件夹末段 */
  readonly label: string;
  /** 作者可写区（只有 `author` 为真；写闸仍在内核，这里只是"这一格是不是你的作品"） */
  readonly writable: boolean;
  /** 文件树（含文件系统视图）可以浏览 */
  readonly browsable: boolean;
  /** Ctrl+P 候选源（枚举方言文件的根） */
  readonly quickOpen: boolean;
  /** 全文检索 / 糖源枚举（按目录递归读文本的根） */
  readonly search: boolean;
  /** 文件监视 */
  readonly watch: boolean;
}

/** `buildWorkspaceFolders` 的输入：五类根各自的原样来源（缺省 = 这一类没有根） */
export interface WorkspaceFolderInput {
  /** 游戏根（`project.rootDir`） */
  readonly projectRoot: string;
  /** 口上域（`project.kojoPaths`） */
  readonly kojoPaths?: readonly string[] | undefined;
  /** 存档目录（`project.savDir`；可能在、也可能没有） */
  readonly savDir?: string | null | undefined;
  /**
   * 作者作品目录（`workspaceProjectDirsOf(kernel)`，**活读**）。
   *
   * 为什么由调用方传而不是在这里读内核：本模块是纯函数面，读服务会把它变成
   * "带环境的判据"；`workspaceFoldersOf` 那一层才是接线（并且照样每次现读）。
   */
  readonly authorDirs?: readonly string[] | undefined;
  /** 会话级附加根（D1；只读：可浏览/检索/Ctrl+P/监视，不进写允许域） */
  readonly extraRoots?: readonly string[] | undefined;
}

/** 角色优先级（同路径多角色时的裁决顺序：越具体越优先） */
const ROLE_RANK: Record<WorkspaceFolderRole, number> = { author: 3, game: 2, extra: 1 };

/** 游戏根：可浏览、可搜、可监视；**整盘不进 Ctrl+P**（扩展名族与体量都不该被卷进来） */
const GAME_ROOT_CAPS = { writable: false, browsable: true, quickOpen: false, search: true, watch: true } as const;
/** 口上域：多一条 Ctrl+P（这是作者真正要按名找的地方） */
const KOJO_CAPS = { writable: false, browsable: true, quickOpen: true, search: true, watch: true } as const;
/** 存档：只看不搜（存档是游戏写的数据面，不是作者找源文件的地方） */
const SAV_CAPS = { writable: false, browsable: true, quickOpen: false, search: false, watch: true } as const;
/** 作者作品目录：可写，其余能力全给 */
const AUTHOR_CAPS = { writable: true, browsable: true, quickOpen: true, search: true, watch: true } as const;
/** 会话附加根：只读，其余能力全给（加进工作区就是为了能被看到 / 找到 / 搜到） */
const EXTRA_CAPS = { writable: false, browsable: true, quickOpen: true, search: true, watch: true } as const;

/** 路径末段（标签用；空串 / 尾分隔符都按目录名处理） */
function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

/**
 * 外层是否**完全覆盖**内层的能力（去嵌套的唯一判据）。
 *
 * 判据是逐个能力"内层有 ⇒ 外层必须有"：有了它，`sav` 折进游戏根（能力是子集），
 * 而口上域**不**折（它多一条 `quickOpen`，折掉就丢了 Ctrl+P 的源根）。
 */
function covers(parent: WorkspaceFolder, child: WorkspaceFolder): boolean {
  return (
    (!child.writable || parent.writable) &&
    (!child.browsable || parent.browsable) &&
    (!child.quickOpen || parent.quickOpen) &&
    (!child.search || parent.search) &&
    (!child.watch || parent.watch)
  );
}

/** 同一个根能不能折进另一根：不是自己、且外层覆盖内层的全部能力 */
function foldable(parent: WorkspaceFolder, child: WorkspaceFolder): boolean {
  return pathKey(parent.path) !== pathKey(child.path) && isPathUnder(parent.path, child.path) && covers(parent, child);
}

function folderOf(
  path: string,
  role: WorkspaceFolderRole,
  label: string,
  caps: Omit<WorkspaceFolder, 'path' | 'role' | 'label'>,
): WorkspaceFolder {
  return { path, role, label, ...caps };
}

/**
 * 根集合 → 模型（去重 + 同路径取更具体角色 + 去嵌套）。
 *
 * 顺序稳定：游戏根 → 口上域 → 存档 → 作品目录 → 附加根（与"外层在前"一致，
 * 消费者拿到的根序不会因输入里根的位置抖动）。
 */
export function buildWorkspaceFolders(input: WorkspaceFolderInput): WorkspaceFolder[] {
  const candidates: WorkspaceFolder[] = [];
  const push = (path: unknown, role: WorkspaceFolderRole, label: string, caps: Omit<WorkspaceFolder, 'path' | 'role' | 'label'>): void => {
    if (typeof path !== 'string' || path.length === 0) return; // 空根 = 没有这个根，不许把遍历带成"根为空"
    candidates.push(folderOf(path, role, label, caps));
  };
  push(input.projectRoot, 'game', '项目根', GAME_ROOT_CAPS);
  for (const root of input.kojoPaths ?? []) push(root, 'game', '口上域', KOJO_CAPS);
  push(input.savDir, 'game', '存档', SAV_CAPS);
  for (const dir of input.authorDirs ?? []) push(dir, 'author', lastSegment(dir) || '作品目录', AUTHOR_CAPS);
  for (const dir of input.extraRoots ?? []) push(dir, 'extra', lastSegment(dir) || '附加文件夹', EXTRA_CAPS);

  // ① 精确去重：同一路径只留更具体的角色（位置取首次出现的那一处，顺序不因裁决而搬）
  const byKey = new Map<string, WorkspaceFolder>();
  for (const folder of candidates) {
    const key = pathKey(folder.path);
    const prev = byKey.get(key);
    if (prev === undefined || ROLE_RANK[folder.role] > ROLE_RANK[prev.role]) byKey.set(key, folder);
  }

  // ② 去嵌套：整根落在另一根之内且能力被覆盖 ⇒ 只留外层
  const unique = [...byKey.values()];
  return unique.filter((child) => !unique.some((parent) => foldable(parent, child)));
}

/* ------------------------------ 按能力取根（五条消费者的唯一入口） ------------------------------ */

/** 同一能力下，外层已覆盖的内层根不再重复交出（避免同一批文件走两遍） */
function rootsCoveredOnce(folders: readonly WorkspaceFolder[], flag: 'browsable' | 'quickOpen' | 'search' | 'watch'): string[] {
  const picked = folders.filter((f) => f[flag]);
  const out: string[] = [];
  for (const folder of picked) {
    if (out.some((kept) => pathKey(kept) !== pathKey(folder.path) && isPathUnder(kept, folder.path))) continue;
    out.push(folder.path);
  }
  return out;
}

/** 文件监视根（游戏根 + 口上域 + 存档 + 作品目录 + 附加根） */
export function watchRootsOf(folders: readonly WorkspaceFolder[]): string[] {
  return rootsCoveredOnce(folders, 'watch');
}

/** 文件树 / 文件系统视图的浏览根 */
export function browsableRootsOf(folders: readonly WorkspaceFolder[]): string[] {
  return rootsCoveredOnce(folders, 'browsable');
}

/** Ctrl+P 候选源根（口上域 + 作品目录 + 附加根；**不含**整盘游戏根） */
export function quickOpenRootsOf(folders: readonly WorkspaceFolder[]): string[] {
  return rootsCoveredOnce(folders, 'quickOpen');
}

/** 全文检索 / 糖源枚举根（游戏根 + 口上域 + 作品目录 + 附加根） */
export function searchRootsOf(folders: readonly WorkspaceFolder[]): string[] {
  return rootsCoveredOnce(folders, 'search');
}

/**
 * 整项目诊断 / 索引的扫描根 = 口上域 + 作品目录 + 附加根。
 *
 * 与 `quickOpenRootsOf` 同一集合不是巧合：**能按名找得到的地方，就是整项目诊断要扫的地方**
 * （扫整盘游戏根是另一件事——那会连引擎与素材一起读进来）。
 */
export function scanRootsOf(folders: readonly WorkspaceFolder[]): string[] {
  return quickOpenRootsOf(folders);
}

/** 命中某路径的**最深**那个根（文件树给"这一格属于谁"上屏用；没有命中 ⇒ undefined） */
export function folderOfPath(folders: readonly WorkspaceFolder[], path: string): WorkspaceFolder | undefined {
  let hit: WorkspaceFolder | undefined;
  for (const folder of folders) {
    if (!isPathUnder(folder.path, path)) continue;
    if (hit === undefined || folder.path.length > hit.path.length) hit = folder;
  }
  return hit;
}

/**
 * 接线版：从内核工作区服务**活读**作品目录后建模型（每次现读，缓存会把本会话刚
 * 新建的作品永久排除在外，口径同 `workspace-roots.ts`）。
 *
 * 非 React 的消费者（整项目扫描、糖源枚举）直接调它；React 侧走
 * `use-workspace-folders.ts`（同一份判据 + 一个变化信号）。
 */
export function workspaceFoldersOf(
  kernel: Pick<Kernel, 'workspaces'>,
  project: GameProject | null,
  extraRoots?: readonly string[],
): WorkspaceFolder[] {
  if (project === null) return [];
  return buildWorkspaceFolders({
    projectRoot: project.rootDir,
    kojoPaths: project.kojoPaths,
    savDir: project.savDir,
    authorDirs: workspaceProjectDirsOf(kernel),
    extraRoots,
  });
}
