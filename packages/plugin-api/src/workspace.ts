import type { TextFile } from './io';
import type { DirEntry } from './platform';

/**
 * 作者工作区服务契约（内核 `kernel.workspaces`）。
 *
 * 定位（讨论纪要 §2）：工作区项目与游戏工程是**对偶 + 引用**关系——
 * 工作区是作者的可写权威区（新建 / 编辑 / 组织 / 导出），游戏目录只是部署目标。
 *
 * 模型刻意通用（内核零游戏知识）：只有 `project / artifact` 两层——
 * 一个项目 = 一个目录 + 一份 manifest（`workspace.json`）；
 * 一个制品 = 项目内一个子目录 + 提供方自定义元数据。
 * 「制品是什么」（角色包 / 皮肤 / 任何文件组）由消费方（适配器插件）解释，
 * 内核不感知。
 *
 * 写安全（2026-10-27 收窄批）：常驻可写根 = 默认根 + **已解析的作品目录**（`projectDirs()`），
 * 自选项目位置根的**根身本身不再进写允许域**——作者把游戏目录选成"项目位置"时，游戏目录
 * 下的一切文件曾经连带可写；现在只有真正落在其下的作品目录可写。
 * 一切写盘仍走内核 io 双闸。授权根的名单只从平台读回（对话框即授权），
 * 契约侧没有"给路径就放行"的入口；反过来**收窄**授权（`revokeRoot`）是允许的。
 */

/** 项目清单文件名（位于项目目录根部） */
export const WORKSPACE_MANIFEST_FILE = 'workspace.json';

/** 工作区制品引用（一个制品 = 项目内一个子目录 + 元数据） */
export interface WorkspaceArtifact {
  /** 制品 id（项目内唯一，创建时生成） */
  id: string;
  /** 显示名 */
  name: string;
  /** 项目内的子目录名（单层；制品的全部文件住在这里） */
  dirName: string;
  /** 提供方自定义元数据（内核原样透传，不解释） */
  meta: Record<string, unknown>;
  createdAt: number;
}

/** 工作区项目（manifest 持久化形态） */
export interface WorkspaceProject {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  artifacts: WorkspaceArtifact[];
  /** 提供方自定义元数据（内核原样透传，不解释） */
  meta: Record<string, unknown>;
}

/** 新建制品输入：文件集 = 相对路径（posix 分隔符）→ 文本内容 */
export interface WorkspaceArtifactInput {
  name: string;
  /** 制品目录名（单层、不得含分隔符；冲突时抛错） */
  dirName: string;
  files: Record<string, string>;
  meta?: Record<string, unknown>;
}

/** 导入外部目录为制品的输入（字节级逐文件复制；源只读、落点在项目内） */
export interface WorkspaceImportInput {
  name: string;
  /** 制品目录名（单层、不得含分隔符；冲突时抛错） */
  dirName: string;
  /** 源目录绝对路径（不存在时抛错） */
  sourceDir: string;
  meta?: Record<string, unknown>;
}

export interface WorkspaceService {
  /** 工作区**默认**根目录（绝对路径）；服务不可用（无平台数据目录）时抛错 */
  rootDir(): string;
  /**
   * 全部可用落点根：默认根（**恒在首位**）∪ 用户经目录对话框自选并常驻授权的项目位置根
   * （2026-10-14 新建项目自选位置批）。服务不可用时抛错，口径同 `rootDir()`。
   *
   * 授权根的唯一来源是平台侧「对话框即授权」通道（`io.chooseWorkspaceRoot`）；
   * 本契约**没有**任何"接受一个路径就扩大写允许域"的方法。
   */
  roots(): string[];
  /**
   * 常驻**可写**的目录清单（2026-10-27 收窄批，additive）：默认根（恒在首位）∪
   * 已解析的**作品目录**（`dirById` 里位于自选根之下的那些）。
   *
   * 与 `roots()` 的区别是这一句：**自选项目位置根的根身不在其中**。
   * `roots()` 回答"能在哪里新建作品"（自选根整体是候选落点），
   * `projectDirs()` 回答"此刻哪些目录可写"——把游戏目录选成项目位置时，
   * 前者仍含游戏目录（要能往里建作品），后者只含建出来的作品目录。
   *
   * 服务的常驻可写根登记（`io.setAppWritableRoots`）与文件区域 / 监视 / 检索判定
   * 都只认这一份。服务不可用时抛错，口径同 `rootDir()`。
   */
  projectDirs(): string[];
  /** 列出全部项目（扫描**所有**根目录读 manifest；损坏项跳过并记日志，不静默。
   * 同一 id 出现在两处 → 保留默认根那份并记 warn） */
  list(): Promise<WorkspaceProject[]>;
  get(projectId: string): Promise<WorkspaceProject | null>;
  /**
   * 新建项目（创建目录 + manifest）。
   * `rootDir` 缺省 = 默认根（行为与历史逐字一致）；给了它则**必须命中 `roots()` 里的某一条**
   * （默认根或已授权的自选位置），否则抛错——落点不是自由参数，授权来自目录对话框。
   */
  create(input: {
    name: string;
    meta?: Record<string, unknown>;
    rootDir?: string;
  }): Promise<WorkspaceProject>;
  /**
   * 撤销一个**自选**项目位置根的常驻授权（2026-10-27 撤销批，additive）。
   *
   * 语义：平台侧（Rust `revoke_workspace_root`）把该目录从常驻授权根与准入根两份清单里
   * 移除并落盘，本服务同步把它从内存名单里摘掉、重建常驻可写根。
   * **收窄授权不需要对话框**（铁律 6 管的是"扩大"）：这是个普通路径参数，
   * 但它只能让写允许域**变小**。
   *
   * 两条硬拒绝（都给人话原因）：
   * - 默认根（`rootDir()`）不可撤销——它就是作者工作区的常驻位置；
   * - 该根下**仍有作品目录**时拒绝撤销（先移走或删除作品），
   *   否则撤销后那些作品会被写闸锁成只读。
   *
   * 撤销后是否需要刷新列表由调用方决定（作品被拒撤时根本撤不掉）。
   */
  revokeRoot(root: string): Promise<void>;
  /** 更新名称 / 元数据（updatedAt 自动刷新） */
  update(
    projectId: string,
    patch: { name?: string; meta?: Record<string, unknown> },
  ): Promise<WorkspaceProject>;
  /** 删除项目（连同目录全部内容） */
  remove(projectId: string): Promise<void>;
  /**
   * 项目目录绝对路径（同步）。
   *
   * **限制（必须知道再调用）**：默认根下的项目恒可解析（`<默认根>/<id>`）；
   * 落在**自选授权根**里的项目要靠 `id → 目录` 缓存，而缓存只由 `list()`
   * （以及服务初始化时存在授权根的那次扫描）填充。
   * 因此：**外部根里的项目要经一次 `list()` 才能解析**，未命中时本方法回落默认根。
   */
  projectDir(projectId: string): string;
  /** 在项目中创建制品：写入文件集并登记 manifest */
  createArtifact(projectId: string, input: WorkspaceArtifactInput): Promise<WorkspaceArtifact>;
  /**
   * 导入外部目录为制品（2026-10-12 口上项目批 P-F）：walkDir 枚举 +
   * readBytes/writeBytes **字节级**逐文件复制（保编码——一次转码毁半库）。
   * 源目录只读不改动；目标已存在同名目录时抛错不覆盖。
   */
  importDirectory(projectId: string, input: WorkspaceImportInput): Promise<WorkspaceArtifact>;
  /** 删除制品（目录 + manifest 登记） */
  removeArtifact(projectId: string, artifactId: string): Promise<void>;
  /** 列项目内某相对目录（缺省 = 项目根） */
  listDir(projectId: string, relDir?: string): Promise<DirEntry[]>;
  /** 读项目内文本文件（相对项目根；越界拒绝） */
  readText(projectId: string, relPath: string): Promise<TextFile>;
  /** 写项目内文本文件（相对项目根；越界拒绝；内核 io 双闸照常生效） */
  writeText(projectId: string, relPath: string, text: string): Promise<void>;
}
