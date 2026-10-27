/**
 * 文件树的**类型面**（零 React、零 IO；FE-REF ⑤ 自 `FileTree.tsx` 逐字搬出）。
 *
 * `Props` 是宿主（ProjectView）注入的能力清单——每个可选字段都对应「缺省则该动作
 * 整组不显示」的口径（铁律 4：没有能力的东西不许以灰态出现），改字段前先读注释。
 * 其余四型是树的结构：分组（角色 → 作者包）、目录缓存态、右键菜单作用域、行内编辑态。
 */
import type { DirEntry, ErbIndex, FileIO, GameProject, WalkOptions } from '@kojo/plugin-api';
import type { OpenFileOptions } from './tabs-ops';
import type { WorkspaceFolder } from './workspace-folders';

export interface Props {
  project: GameProject;
  index: ErbIndex | null;
  activeFile: string | null;
  /** 打开文件（第二参是**方式**：`{preview:true}` 单击浏览、缺省永久打开） */
  onOpenFile: (path: string, opts?: OpenFileOptions) => void;
  /** 目录列举（真实文件夹视图用；宿主注入内核 io，浏览器环境可能抛错——调用侧已兜底） */
  listDir?: (path: string) => Promise<DirEntry[]>;
  /**
   * 递归列举（冷开快照用；宿主注入内核 io — 与 erb-parser 的索引 walk 同一条桥）。
   *
   * 动机（2026-10-16 树即时批）：索引要 7.5s 才就绪，这期间左栏全空。冷开时对
   * `project.kojoPaths` 各做**一次** `walkDir` 就能拿全口上域的方言文件清单（角色归属
   * 来自 `charaIndex`，打开项目即已可用），按同一分组结构先出树；索引就绪后按同一
   * 构建函数切回索引路径（同一文件集 ⇒ 不重排）。缺省 → 退回旧行为（等索引）。
   */
  walkDir?: (path: string, opts?: WalkOptions) => Promise<DirEntry[]>;
  /** 导入作者包为工作区项目（口上项目批 P-F；缺省 → 不显示导入菜单项） */
  onImportPackage?: (pkg: { dir: string; label: string }) => void;
  /**
   * 内核文件 IO（文件树编辑批 B1/B2）：新建 / 重命名 / 删除的落地面。
   * 缺省 → 这三类菜单项**整组不显示**（没有能力的动作灰着不说话 = 违反铁律 4）。
   * 写允许域由 io.isWritable 预检——不可行的位置给一句人话，绝不绕闸也绝不静默失败。
   */
  io?: FileIO;
  /**
   * 「在资源管理器中显示」（B3 的 UI 侧预留；桌面壳才有这能力）。
   * 缺省 → 菜单项不显示（浏览器壳没有这能力，灰着不说话 = 违反铁律 4）。
   */
  onRevealInExplorer?: (path: string) => void;
  /**
   * 脏标签守门（删除/重命名前先问宿主）：返回第一份拦下操作的**人话理由**；null = 放行。
   *
   * 落法理由（welcome 批先例）：openTabs / dirtyPaths 的状态单源在宿主（App），
   * 所以"这份文件现在能不能动"也由宿主裁决——树只发意图，不持有标签状态的影子副本。
   * 宿主同时拦「精确命中」与「打开中的脏文件位于被删/改名目录之下」两种形态。
   */
  guardFileOp?: (paths: readonly string[]) => string | null;
  /**
   * 盘上操作成功后通知宿主收尾：关掉被删文件的干净标签、改写被重命名文件的标签路径。
   * 与 guardFileOp 同理落在宿主——标签列表是它的 state，树侧只报告事实（谁没了/搬去哪）。
   */
  onFilesGone?: (deleted: readonly string[], renamed: ReadonlyArray<{ from: string; to: string }>) => void;
  /**
   * 目录缓存失效信号（HK-5，2026-10-13）：宿主在口上域发生外部改动时递增。
   * 值本身没有意义，**变化**才是事件——用 nonce 而不是布尔，是因为连续两次改动
   * 都必须各刷新一次（布尔会在第二次被 React 合并掉）。
   */
  refreshNonce?: number;
  /**
   * 名称显示对照（缺省 = 原样）：消费方据日文→中文词典把作者包目录名 / 目录名 / 文件名
   * 渲染为「日文（中文）」。**只改显示文本**——title / path / key 一律用原名。
   */
  gloss?: (name: string) => string;
  /**
   * 会话级附加根（D1，对标 VSCode Add Folder to Workspace）：fs 视图根层与项目根
   * 并列显示的额外根。缺省 → fs 视图维持单根（零视觉扰动）；非空 → 根层每根一个
   * 分组头（复用 subOpen 折叠 + dirCache 惰性列举）。
   */
  extraRoots?: readonly string[];
  /** 「添加文件夹…」入口（对话框与去重都在宿主 App；缺省 → 按钮不显示） */
  onAddFolder?: () => void;
  /**
   * 工作区根模型（WS-04）：`author` / `extra` 根在语义视图里各占一个**独立顶层分组**
   * （组头标明可写 / 只读），文件系统视图的根层也从这里取。
   *
   * 缺省 ⇒ 退回旧行为（fs 视图根 = 项目根 ∪ `extraRoots`，语义视图不显示这些分组）——
   * 契约演进的 additive 纪律：宿主没接就不多画一层。
   */
  workspaceFolders?: readonly WorkspaceFolder[];
  /**
   * 盘上条目新增 / 删除 / 改名的收尾（WS-05）：索引增量更新的宿主接线
   * （`erb-index-sync.ts`）。树侧只报告事实，谁去更新索引归宿主。
   *
   * 缺省 ⇒ 什么都不报（旧行为：索引等下一次整扫/换根才跟上）。
   */
  onDiskEntriesChanged?: (delta: { readonly changed: readonly string[]; readonly removed: readonly string[] }) => void;
  /**
   * 「比较已选文件」（D 批）：在多选集恰为两个文件、且右击的行在其中时，菜单项出现，
   * 落地交给宿主——由它把 `ui.diffView.open` 发进总线（树不认识 diff 视图，也不读盘）。
   *
   * 缺省 → 该项整项不显示（没有落地通道就不摆一个点了没反应的项，铁律 4）。
   */
  onCompareFiles?: (left: string, right: string) => void;
}

/** 作者包子目录（角色目录下的一层子文件夹 = 作者版本号包目录） */
export interface PackageGroup {
  /** 包目录名；null = 直接挂在角色目录根下的散文件（如 159 先代 无包目录） */
  label: string | null;
  /** 包内 ERB 面文件（来自索引） */
  files: string[];
}

export interface Group {
  label: string;
  /** 角色目录前缀（计算包目录绝对路径用） */
  prefix: string;
  subs: PackageGroup[];
  total: number;
}

export type DirState = DirEntry[] | 'loading' | 'error';

/** 右键菜单作用域：单个角色 / 整棵树根 / 单个作者包（导入口径，P-F）/ 单个目录 / 单个文件 */
export type MenuScope =
  | { kind: 'group'; group: Group }
  | { kind: 'root' }
  | { kind: 'package'; dir: string; label: string }
  | { kind: 'dir'; path: string }
  | { kind: 'file'; path: string };

/**
 * 行内编辑态（B1/B2）：重命名与新建共用一个输入框。
 *
 * - `create`：在 `dir` 里新建；dir 的列举必须已展开（调用侧先开层），输入行插在该层最上；
 * - `rename`：把 path 那一行改画成输入框（同 VSCode；Esc 取消 / Enter 确认 / 失焦取消）。
 */
export type EditState =
  | { mode: 'create'; kind: 'file' | 'dir'; dir: string }
  | { mode: 'rename'; path: string; isDir: boolean };
