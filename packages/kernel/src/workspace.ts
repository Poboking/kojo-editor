import type {
  DirEntry,
  FileIO,
  Logger,
  PlatformBridge,
  TextFile,
  WorkspaceArtifact,
  WorkspaceArtifactInput,
  WorkspaceProject,
  WorkspaceService,
} from '@kojo/plugin-api';
import { WORKSPACE_MANIFEST_FILE, isAbsolute, isPathUnder, join } from '@kojo/plugin-api';

/**
 * 作者工作区服务实现（内核 `kernel.workspaces`）。
 *
 * 布局：`<appDataDir>/workspaces/<projectId>/workspace.json` + 制品子目录。
 * 注册表 = 扫描根目录读各 manifest（免索引文件——索引即目录，崩溃不漂移）。
 *
 * 安全：
 * - 初始化时把根目录登记为 io 的**常驻可写根**（`setAppWritableRoots`）——
 *   工作区恒可写，独立于游戏目录写授权的开闭周期；写盘仍走内核 io 双闸；
 * - 一切相对路径经 `resolveIn` 校验（拒绝对路径 / `..` 逃逸），
 *   项目 id / 制品目录名强制单层 segment。
 *
 * 降级：无平台数据目录（浏览器环境）时 `init` 捕获并记因，
 * 全部操作抛带原因的结构化错误——不静默、不连累内核启动。
 */

export interface WorkspaceServiceDeps {
  bridge: PlatformBridge;
  io: FileIO;
  log: Logger;
}

function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 单层目录段校验（拒绝分隔符 / 点段 / 空串 / manifest 占用名） */
function assertSegment(value: string, what: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    /[\\/]/.test(value) ||
    value === WORKSPACE_MANIFEST_FILE
  ) {
    throw new Error(`Invalid ${what}: '${value}' (must be a single directory segment)`);
  }
}

/** manifest 最小形状校验（扫描时对损坏项跳过，不靠异常控制流） */
function asProject(raw: unknown): WorkspaceProject | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Partial<WorkspaceProject>;
  if (typeof p.id !== 'string' || typeof p.name !== 'string') return null;
  if (typeof p.createdAt !== 'number' || typeof p.updatedAt !== 'number') return null;
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    artifacts: Array.isArray(p.artifacts) ? (p.artifacts as WorkspaceArtifact[]) : [],
    meta: typeof p.meta === 'object' && p.meta !== null ? (p.meta as Record<string, unknown>) : {},
  };
}

export class WorkspaceServiceImpl implements WorkspaceService {
  private root: string | null = null;

  constructor(private readonly deps: WorkspaceServiceDeps) {}

  /** 初始化（createKernel 时调用）：解析根 → 登记常驻可写根 → 确保根存在 */
  async init(): Promise<void> {
    const appData = await this.deps.bridge.appDataDir();
    this.root = join(appData, 'workspaces');
    this.deps.io.setAppWritableRoots([this.root]);
    await this.deps.io.ensureDir(this.root);
    this.deps.log.info(`Workspace root: ${this.root}`);
  }

  /** 服务不可用时抛出带原因的错误（面板捕获后自解释呈现） */
  private requireRoot(): string {
    if (this.root === null) {
      throw new Error('Workspace service is unavailable (no platform data directory)');
    }
    return this.root;
  }

  rootDir(): string {
    return this.requireRoot();
  }

  projectDir(projectId: string): string {
    assertSegment(projectId, 'project id');
    return join(this.requireRoot(), projectId);
  }

  private manifestPath(projectId: string): string {
    return join(this.projectDir(projectId), WORKSPACE_MANIFEST_FILE);
  }

  /** 相对路径 → 项目内绝对路径（拒绝对路径与一切 `..` 段；isPathUnder 兜底） */
  private resolveIn(projectId: string, relPath: string): string {
    const base = this.projectDir(projectId);
    if (isAbsolute(relPath)) throw new Error(`Absolute path not allowed here: ${relPath}`);
    if (relPath.split(/[\\/]/).includes('..')) {
      throw new Error(`Path escapes the project directory: ${relPath}`);
    }
    const target = join(base, relPath);
    if (!isPathUnder(base, target)) throw new Error(`Path escapes the project directory: ${relPath}`);
    return target;
  }

  private async readManifest(projectId: string): Promise<WorkspaceProject | null> {
    const path = this.manifestPath(projectId);
    if (!(await this.deps.io.exists(path))) return null;
    try {
      const tf = await this.deps.io.readText(path);
      return asProject(JSON.parse(tf.text));
    } catch (err) {
      this.deps.log.warn(`Corrupt workspace manifest (skipped): ${path} — ${String(err)}`);
      return null;
    }
  }

  private async writeManifest(project: WorkspaceProject): Promise<void> {
    await this.deps.io.writeText(this.manifestPath(project.id), JSON.stringify(project, null, 2), {
      encoding: 'utf-8',
      backup: false,
    });
  }

  async list(): Promise<WorkspaceProject[]> {
    const entries = await this.deps.io.listDir(this.requireRoot());
    const out: WorkspaceProject[] = [];
    for (const e of entries) {
      if (!e.isDirectory) continue;
      const p = await this.readManifest(e.name);
      if (p) out.push(p);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(projectId: string): Promise<WorkspaceProject | null> {
    return this.readManifest(projectId);
  }

  async create(input: { name: string; meta?: Record<string, unknown> }): Promise<WorkspaceProject> {
    const name = input.name.trim();
    if (name.length === 0) throw new Error('Project name must not be empty');
    const root = this.requireRoot();
    let id = newId('p');
    while (await this.deps.io.exists(join(root, id))) id = newId('p');

    const now = Date.now();
    const project: WorkspaceProject = {
      id,
      name,
      createdAt: now,
      updatedAt: now,
      artifacts: [],
      meta: input.meta ?? {},
    };
    await this.deps.io.ensureDir(join(root, id));
    await this.writeManifest(project);
    this.deps.log.info(`Workspace project created: ${name} (${id})`);
    return project;
  }

  async update(
    projectId: string,
    patch: { name?: string; meta?: Record<string, unknown> },
  ): Promise<WorkspaceProject> {
    const project = await this.readManifest(projectId);
    if (!project) throw new Error(`Workspace project not found: ${projectId}`);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.length === 0) throw new Error('Project name must not be empty');
      project.name = name;
    }
    if (patch.meta !== undefined) project.meta = patch.meta;
    project.updatedAt = Date.now();
    await this.writeManifest(project);
    return project;
  }

  async remove(projectId: string): Promise<void> {
    await this.deps.bridge.removeDir(this.projectDir(projectId));
    this.deps.log.info(`Workspace project removed: ${projectId}`);
  }

  async createArtifact(projectId: string, input: WorkspaceArtifactInput): Promise<WorkspaceArtifact> {
    const project = await this.readManifest(projectId);
    if (!project) throw new Error(`Workspace project not found: ${projectId}`);
    const name = input.name.trim();
    if (name.length === 0) throw new Error('Artifact name must not be empty');
    assertSegment(input.dirName, 'artifact directory name');

    // 冲突判定以 manifest 登记为准（空文件集的制品不落目录，磁盘判定会漏）
    if (
      project.artifacts.some((a) => a.dirName === input.dirName) ||
      (await this.deps.io.exists(join(this.projectDir(projectId), input.dirName)))
    ) {
      throw new Error(`Artifact directory already exists: ${input.dirName}`);
    }

    // 先落全部文件（任一越界在写前校验阶段就抛，不产半成品目录登记）。
    // 注意：段校验必须对**原始**相对路径做——join 会先归一化把 `pkg/../x` 折叠掉。
    const entries = Object.entries(input.files);
    const targets = entries.map(([rel]) => {
      if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
        throw new Error(`Path escapes the artifact directory: ${rel}`);
      }
      return this.resolveIn(projectId, join(input.dirName, rel));
    });
    for (let i = 0; i < entries.length; i++) {
      await this.deps.io.writeText(targets[i]!, entries[i]![1]);
    }

    const artifact: WorkspaceArtifact = {
      id: newId('a'),
      name,
      dirName: input.dirName,
      meta: input.meta ?? {},
      createdAt: Date.now(),
    };
    project.artifacts.push(artifact);
    project.updatedAt = Date.now();
    await this.writeManifest(project);
    this.deps.log.info(`Artifact created: ${name} in project ${projectId}`);
    return artifact;
  }

  async removeArtifact(projectId: string, artifactId: string): Promise<void> {
    const project = await this.readManifest(projectId);
    if (!project) throw new Error(`Workspace project not found: ${projectId}`);
    const idx = project.artifacts.findIndex((a) => a.id === artifactId);
    if (idx < 0) throw new Error(`Artifact not found: ${artifactId}`);
    const artifact = project.artifacts[idx]!;
    await this.deps.bridge.removeDir(join(this.projectDir(projectId), artifact.dirName));
    project.artifacts.splice(idx, 1);
    project.updatedAt = Date.now();
    await this.writeManifest(project);
  }

  async listDir(projectId: string, relDir?: string): Promise<DirEntry[]> {
    return this.deps.io.listDir(this.resolveIn(projectId, relDir ?? '.'));
  }

  async readText(projectId: string, relPath: string): Promise<TextFile> {
    return this.deps.io.readText(this.resolveIn(projectId, relPath));
  }

  async writeText(projectId: string, relPath: string, text: string): Promise<void> {
    return this.deps.io.writeText(this.resolveIn(projectId, relPath), text);
  }
}
