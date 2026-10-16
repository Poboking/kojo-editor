/**
 * 文件树编辑能力（B1/B2/B4 文件树编辑批）的纯逻辑：菜单可见性、名称校验、
 * 删除确认文案、相对路径、定位计算。零 React、零 IO——组件只管接线，
 * 判据放这里才可单测（与 file-tree-reveal 同一形态）。
 *
 * 用户可见文案的纪律：全部人话，不出现内部术语（writablePaths / 域 / 脏 model 之类不上屏）。
 */

/* ------------------------------ 菜单可见性 ------------------------------ */

/** 右键菜单作用域的轻量形态（只保留可见性判定需要的字段；与 FileTree.MenuScope 对应） */
export type MenuScopeKind = 'file' | 'dir' | 'package';

export type MenuItemId =
  | 'open'
  | 'copy-path'
  | 'copy-rel-path'
  | 'reveal'
  | 'new-file'
  | 'new-dir'
  | 'rename'
  | 'delete'
  | 'import';

export interface MenuItemSpec {
  readonly id: MenuItemId;
  readonly label: string;
  /** 在这一项**之前**画一条分隔线（首项的分隔线由渲染侧吞掉） */
  readonly dividerBefore?: boolean;
}

/** 能力开关：某条通道不存在时对应菜单项**整项不显示**（灰着不说话 = 违反铁律 4） */
export interface MenuCapability {
  /** 内核文件 IO：新建/重命名/删除这些盘上动作的落地面 */
  hasIo: boolean;
  /** 「在资源管理器中显示」通道（桌面壳才有；浏览器壳没有就整项不显示） */
  canReveal: boolean;
  /** 导入作者包通道（既有 P-F 口径） */
  canImport: boolean;
}

/**
 * 文件 / 目录 / 包三种作用域的菜单项清单（纯函数，可单测）。
 *
 * 顺序与分组：文件 = 打开 | 复制路径、复制相对路径、显示 | 重命名、删除；
 * 目录/包 = [导入] | 新建文件、新建文件夹 | 复制路径、显示 | 重命名、删除。
 * 角色组与根两个作用域沿用既有实现（全展开开关），不在此列。
 */
export function menuItemsFor(scope: MenuScopeKind, cap: MenuCapability): MenuItemSpec[] {
  if (scope === 'file') {
    const items: MenuItemSpec[] = [
      { id: 'open', label: '打开' },
      { id: 'copy-path', label: '复制路径' },
      { id: 'copy-rel-path', label: '复制相对路径' },
    ];
    if (cap.canReveal) items.push({ id: 'reveal', label: '在资源管理器中显示', dividerBefore: true });
    if (cap.hasIo) items.push({ id: 'rename', label: '重命名', dividerBefore: true }, { id: 'delete', label: '删除' });
    return items;
  }
  const items: MenuItemSpec[] = [];
  if (scope === 'package' && cap.canImport) items.push({ id: 'import', label: '导入为我的口上项目' });
  if (cap.hasIo) {
    items.push({ id: 'new-file', label: '新建文件', dividerBefore: items.length > 0 }, { id: 'new-dir', label: '新建文件夹' });
  }
  items.push({ id: 'copy-path', label: '复制路径', dividerBefore: items.length > 0 });
  if (cap.canReveal) items.push({ id: 'reveal', label: '在资源管理器中显示' });
  if (cap.hasIo) items.push({ id: 'rename', label: '重命名', dividerBefore: true }, { id: 'delete', label: '删除' });
  return items;
}

/* ------------------------------ 名称校验 ------------------------------ */

/**
 * Windows 保留设备名（Win32 文件名判据，与扩展名组合同样保留：`CON.txt` 也建不出来）。
 * PRN / AUX / CLOCK$ 一并拦下——盘上真抛出来的是一串英文错误，正是这道门要替作者挡掉的。
 */
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 新建 / 重命名的文件名合法性（纯函数）。返回**人话错误说明**，null = 合法。
 *
 * 锚的是 Windows 文件名的硬约束（Rust/NTFS 侧会拒绝的字符与形态）——
 * 在 UI 这层先拦下，错误信息才说得清「改哪里」，而不是等盘上抛一串英文。
 */
export function validateEntryName(rawName: string): string | null {
  const name = rawName.trim();
  if (name.length === 0) return '名称不能为空';
  if (name === '.' || name === '..') return '不能用「.」或「..」作名称';
  if (/[\\/]/.test(name)) return '名称里不能有斜杠（/ 或 \\）';
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) return '名称里不能有这些字符：< > : " | ? *';
  if (/[. ]$/.test(name)) return '名称结尾不能是空格或点';
  if (RESERVED_DEVICE_NAME.test(name))
    return `「${name}」是系统保留的设备名称，换一个（如 CON / NUL / AUX / COM1 / LPT1 这类）`;
  return null;
}

/* ------------------------------ 路径小工具 ------------------------------ */

/** 路径归一键（与 FileTree.pkey 同口径：分隔符折叠 + 小写；独立实现以免组件依赖倒挂） */
function pkey(p: string): string {
  return p.replace(/[\\/]+/g, '/').toLowerCase();
}

/** 目录 + 文件名拼子路径（dir 尾部分隔符先折叠，避免出现双斜杠） */
export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${name}`;
}

/** 父目录（取末段之前的部分；没有分隔符 = 无父，返回空串） */
export function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(0, i) : '';
}

/** path 是否落在 root 之内（含 root 本身；分隔符与大小写归一后比较） */
export function isUnderPath(root: string, path: string): boolean {
  const r = pkey(root).replace(/\/+$/, '');
  const p = pkey(path).replace(/\/+$/, '');
  return p === r || p.startsWith(`${r}/`);
}

/**
 * 相对项目根的显示路径（复制相对路径用）。不在根下（工作区外拖入等）→ 原样返回完整路径：
 * 拷一个半截路径给出去只会误导收的人。
 */
export function relativeToRoot(path: string, root: string): string {
  const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const r = norm(root);
  const p = norm(path);
  const lower = p.toLowerCase();
  const rLower = r.toLowerCase();
  if (rLower.length > 0 && lower.startsWith(`${rLower}/`)) return p.slice(r.length + 1);
  if (lower === rLower) return path;
  return path;
}

/* ------------------------------ 删除确认文案 ------------------------------ */

/**
 * 删除确认的量级提示（纯函数，可单测）。
 *
 * 递归删除是把大刀：目录必须让用户看清刀多大——「将同时删除其中的 N 个文件」。
 * N 现算失败（walkDir 抛）时退化为无数字，但"全部内容都会被删除"的警示语必须保留。
 */
export function deleteConfirmText(target: { name: string; isDir: boolean; fileCount?: number }): string {
  if (!target.isDir) return `确定删除文件「${target.name}」吗？此操作无法撤销。`;
  return typeof target.fileCount === 'number'
    ? `确定删除文件夹「${target.name}」吗？将同时删除其中的 ${target.fileCount} 个文件，此操作无法撤销。`
    : `确定删除文件夹「${target.name}」吗？其中的全部内容（含子文件夹）都会被删除，此操作无法撤销。`;
}

/* ------------------------------ B4：定位当前文件 ------------------------------ */

/** 定位计算的最小组型（与 FileTree 的 Group/PackageGroup 同构，避免组件依赖倒挂） */
export interface LocateGroup {
  readonly label: string;
  readonly prefix: string;
  readonly subs: readonly { readonly label: string | null; readonly files: readonly string[] }[];
}

export interface LocatePlan {
  /** 需要展开的角色组标签（并进 opened） */
  readonly groupLabel: string;
  /** 文件所在包（并进 pkgFolder + ensureDir）；根散文件 = null */
  readonly pkg: { readonly key: string; readonly dir: string } | null;
  /** 目标行：文件绝对路径（DOM 里 data-locate 匹配用） */
  readonly targetPath: string;
}

/**
 * activeFile → 定位计划（纯函数，可单测）。
 *
 * 只算**结构展开**（组 + 包两层）：嵌套子目录的真身住在磁盘列举里，groups 不知道——
 * 目标行多半已在包的平铺列表里，子目录深处的文件靠包层展开后的真实文件夹视图兜底。
 * 找不到（未归属 / 不在索引里）→ null，调用侧安静放弃。
 * 路径匹配按归一键（分隔符/大小写折叠），Windows 两种写法都能命中。
 */
export function locatePlanOf(
  groups: readonly LocateGroup[],
  activeFile: string,
  pkgDirOf: (prefix: string, pkgLabel: string) => string,
): LocatePlan | null {
  const target = pkey(activeFile);
  for (const g of groups) {
    for (const s of g.subs) {
      if (!s.files.some((f) => pkey(f) === target)) continue;
      const pkg =
        s.label === null
          ? null
          : { key: `${g.label}::${s.label}`, dir: pkgDirOf(g.prefix, s.label) };
      return { groupLabel: g.label, pkg, targetPath: activeFile };
    }
  }
  return null;
}

/* ------------------------------ B5：文件系统视图的定位 ------------------------------ */

/**
 * 文件系统视图（B5）的定位计划（纯函数，可单测）。
 *
 * 文件系统视图没有「角色组 / 作者包」两层语义（那是 `locatePlanOf` 的口径），定位退化为
 * **从根到 activeFile 逐级展开**：返回需要展开的祖先目录（绝对路径，由浅到深、不含根自身）。
 * 根层直挂文件 → `[]`（无需展开，等根层列举回来即可滚）；不在项目根下 / 根自身 → `null`，
 * 调用侧安静放弃。
 * 路径匹配按归一口径（isUnderPath：分隔符/大小写折叠），Windows 两种写法都能命中。
 */
export function fsLocatePlanOf(rootDir: string, activeFile: string): string[] | null {
  if (!isUnderPath(rootDir, activeFile)) return null;
  const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const root = norm(rootDir);
  const file = norm(activeFile);
  if (file.toLowerCase() === root.toLowerCase()) return null; // 根自身没有可展开的祖先
  const rel = file.slice(root.length + 1);
  if (!rel) return null;
  const dirs: string[] = [];
  let cur = root;
  for (const seg of rel.split('/').slice(0, -1)) {
    cur = `${cur}/${seg}`;
    dirs.push(cur);
  }
  return dirs;
}

/** 多根文件系统视图（D1）的定位计划：包含根 + 从该根到目标的祖先链 */
export interface FsLocatePlanRoots {
  /** 目标文件所属的根（多根嵌套时取最长前缀，避免误归属到外层根） */
  readonly root: string;
  /** 需要展开的祖先目录（绝对路径，由浅到深、不含根自身） */
  readonly dirs: readonly string[];
}

/**
 * 多根文件系统视图的定位（纯函数，可单测；D1 会话级附加根批）。
 *
 * 与 `fsLocatePlanOf` 同一套祖先算法，多出来的只有一步「目标归哪个根」：
 * 落在多个根内时取**归一后最长前缀**的根（附加根在项目根之下时，才能定位进附加根
 * 而不是被项目根抢先）。都不包含 / 命中的是根本身 → `null`，调用侧安静放弃。
 */
export function fsLocatePlanOfRoots(
  roots: readonly string[],
  activeFile: string,
): FsLocatePlanRoots | null {
  const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const hit = roots
    .filter((r) => isUnderPath(r, activeFile))
    .sort((a, b) => norm(b).length - norm(a).length)[0];
  if (hit === undefined) return null;
  const dirs = fsLocatePlanOf(hit, activeFile);
  return dirs === null ? null : { root: hit, dirs };
}
