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
 * 写安全：工作区根目录在服务初始化时登记为**常驻可写根**（`io.setAppWritableRoots`，
 * 独立于项目写授权的开闭周期）；一切写盘仍走内核 io 双闸。
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

export interface WorkspaceService {
  /** 工作区根目录（绝对路径）；服务不可用（无平台数据目录）时抛错 */
  rootDir(): string;
  /** 列出全部项目（扫描根目录读 manifest；损坏项跳过并记日志，不静默） */
  list(): Promise<WorkspaceProject[]>;
  get(projectId: string): Promise<WorkspaceProject | null>;
  /** 新建项目（创建目录 + manifest） */
  create(input: { name: string; meta?: Record<string, unknown> }): Promise<WorkspaceProject>;
  /** 更新名称 / 元数据（updatedAt 自动刷新） */
  update(
    projectId: string,
    patch: { name?: string; meta?: Record<string, unknown> },
  ): Promise<WorkspaceProject>;
  /** 删除项目（连同目录全部内容） */
  remove(projectId: string): Promise<void>;
  /** 项目目录绝对路径 */
  projectDir(projectId: string): string;
  /** 在项目中创建制品：写入文件集并登记 manifest */
  createArtifact(projectId: string, input: WorkspaceArtifactInput): Promise<WorkspaceArtifact>;
  /** 删除制品（目录 + manifest 登记） */
  removeArtifact(projectId: string, artifactId: string): Promise<void>;
  /** 列项目内某相对目录（缺省 = 项目根） */
  listDir(projectId: string, relDir?: string): Promise<DirEntry[]>;
  /** 读项目内文本文件（相对项目根；越界拒绝） */
  readText(projectId: string, relPath: string): Promise<TextFile>;
  /** 写项目内文本文件（相对项目根；越界拒绝；内核 io 双闸照常生效） */
  writeText(projectId: string, relPath: string, text: string): Promise<void>;
}
