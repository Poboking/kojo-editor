import type {
  DirEntry,
  FileIO,
  Logger,
  PlatformBridge,
  TextFile,
  WorkspaceArtifact,
  WorkspaceArtifactInput,
  WorkspaceImportInput,
  WorkspaceProject,
  WorkspaceService,
} from '@kojo/plugin-api';
import { WORKSPACE_MANIFEST_FILE, dirname, isAbsolute, isPathUnder, join } from '@kojo/plugin-api';

/**
 * 作者工作区服务实现（内核 `kernel.workspaces`）。
 *
 * 布局：`<落点根>/<projectId>/workspace.json` + 制品子目录。
 * 落点根 = 默认根 `<appDataDir>/workspaces`（恒在首位）∪ 用户自选并常驻授权的项目位置根
 * （2026-10-14 批；`roots()`）。注册表 = 扫描各根目录读 manifest（免索引文件——索引即目录，崩溃不漂移）。
 *
 * 安全：
 * - 初始化时把**全部根**登记为 io 的**常驻可写根**（`setAppWritableRoots`）——
 *   工作区恒可写，独立于游戏目录写授权的开闭周期；写盘仍走内核 io 双闸；
 * - 额外根只读自平台（`listWorkspaceRoots`），而平台侧那份授权的唯一来源是
 *   目录对话框（`chooseWorkspaceRoot`：对话框与登记绑在同一个命令内）。
 *   本服务**不接受**任何"给个路径就放行"的入口：`create` 的 `rootDir` 必须命中已知根；
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

/** 同一个目录的两种写法（大小写 / 尾分隔符）算同一个根：互相包含才相等 */
function isSameRoot(a: string, b: string): boolean {
  return isPathUnder(a, b) && isPathUnder(b, a);
}

export class WorkspaceServiceImpl implements WorkspaceService {
  private root: string | null = null;
  /**
   * 用户经系统对话框自选、由平台常驻授权的**项目位置根**（默认根之外）。
   * 授权不来自路径参数（铁律 6）：这份列表只读自 `bridge.listWorkspaceRoots()`，
   * 而那条命令的另一半是"弹目录对话框 + 在同一命令内登记授权"。
   */
  private extraRoots: string[] = [];
  /**
   * `projectId → 项目目录绝对路径`（init（有额外根时）/ `list` / `create` 三处填充）。
   * `projectDir()` 必须是同步的（面板/部署链路到处在用它），而"项目在哪个根下"只能靠
   * 扫盘知道 ⇒ 外部根里的项目**要经一次 `list()` 才能解析**；未命中一律回落默认根。
   */
  private readonly dirById = new Map<string, string>();

  constructor(private readonly deps: WorkspaceServiceDeps) {}

  /** 初始化（createKernel 时调用）：解析默认根 + 读回授权根 → 登记常驻可写根 → 确保默认根存在 */
  async init(): Promise<void> {
    const appData = await this.deps.bridge.appDataDir();
    this.root = join(appData, 'workspaces');
    this.extraRoots = await this.readAuthorizedRoots();
    this.deps.io.setAppWritableRoots([this.root, ...this.extraRoots]);
    await this.deps.io.ensureDir(this.root);
    this.deps.log.info(
      `Workspace root: ${this.root}` +
        (this.extraRoots.length > 0 ? `（另有 ${this.extraRoots.length} 个自选项目位置）` : ''),
    );
    // 有外部根 ⇒ 必须先扫一次，否则 projectDir() 把它们的项目全解析回默认根
    // （get/update/remove 会找不到项目）。没有外部根时保持零额外扫描：默认根下
    // `join(root, id)` 就是唯一真相，init 再扫一遍纯属重复面板的那一次 list。
    if (this.extraRoots.length > 0) await this.list();
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

  /** 全部落点根：默认根恒在首位 + 对话框授权根（授权序） */
  roots(): string[] {
    const root = this.requireRoot();
    return [root, ...this.extraRoots.filter((r) => !isSameRoot(r, root))];
  }

  projectDir(projectId: string): string {
    assertSegment(projectId, 'project id');
    const known = this.dirById.get(projectId);
    if (known !== undefined) return known;
    return join(this.requireRoot(), projectId);
  }

  /**
   * 解析项目目录，必要时扫一次盘（`projectDir` 的异步半边，专供"必须先知道在哪个根"
   * 才能做对的动作，如删除——删错目录是静默失败：不存在 → 幂等成功 → 项目还在）。
   */
  private async locateProjectDir(projectId: string): Promise<string> {
    const cached = this.dirById.get(projectId);
    if (cached !== undefined) return cached;
    // 名单要重读一次：本会话刚经对话框授权的根不在 init 那份里
    await this.refreshAuthorizedRoots();
    for (const root of this.roots()) {
      const dir = join(root, projectId);
      if (await this.deps.io.exists(join(dir, WORKSPACE_MANIFEST_FILE))) {
        this.dirById.set(projectId, dir);
        return dir;
      }
    }
    return this.projectDir(projectId);
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

  private async readManifestAt(projectDir: string): Promise<WorkspaceProject | null> {
    const path = join(projectDir, WORKSPACE_MANIFEST_FILE);
    if (!(await this.deps.io.exists(path))) return null;
    try {
      const tf = await this.deps.io.readText(path);
      return asProject(JSON.parse(tf.text));
    } catch (err) {
      this.deps.log.warn(`Corrupt workspace manifest (skipped): ${path} — ${String(err)}`);
      return null;
    }
  }

  private async readManifest(projectId: string): Promise<WorkspaceProject | null> {
    return this.readManifestAt(this.projectDir(projectId));
  }

  private async writeManifest(project: WorkspaceProject): Promise<void> {
    await this.deps.io.writeText(this.manifestPath(project.id), JSON.stringify(project, null, 2), {
      encoding: 'utf-8',
      backup: false,
    });
  }

  /**
   * 读回平台侧的常驻授权根，并把不可用的项**出声剔除**（读不到 / 不存在 / 相对路径）。
   * 任何一条坏根都不连累启动，也不连累其余根生效——静默的授权列表比没有授权列表更坏。
   */
  private async readAuthorizedRoots(): Promise<string[]> {
    let raw: string[];
    try {
      raw = await this.deps.bridge.listWorkspaceRoots();
    } catch (err) {
      this.deps.log.warn(`读取自选项目位置失败（只用默认根）：${String(err)}`);
      return [];
    }
    const out: string[] = [];
    for (const candidate of raw) {
      if (typeof candidate !== 'string' || candidate.length === 0) {
        this.deps.log.warn(`忽略无效的项目位置授权项：${String(candidate)}`);
        continue;
      }
      if (!isAbsolute(candidate)) {
        this.deps.log.warn(`忽略非绝对路径的项目位置授权项：${candidate}`);
        continue;
      }
      if (this.root !== null && isSameRoot(candidate, this.root)) continue; // 默认根本就在，不重复登记
      let present = false;
      try {
        present = await this.deps.io.exists(candidate);
      } catch (err) {
        this.deps.log.warn(`检查项目位置失败（跳过）：${candidate} — ${String(err)}`);
        continue;
      }
      if (!present) {
        this.deps.log.warn(`已授权的项目位置不存在，跳过：${candidate}`);
        continue;
      }
      if (out.some((r) => isSameRoot(r, candidate))) continue;
      out.push(candidate);
    }
    return out;
  }

  /**
   * 刷新授权根（`create` 前调用）：本会话里刚经对话框新增的根不会出现在
   * `init` 时读到的那份里，故落盘授权后重读一次并同步进 io 第一道闸（追加，不收回既有授权）。
   */
  private async refreshAuthorizedRoots(): Promise<void> {
    const fresh = await this.readAuthorizedRoots();
    for (const r of fresh) {
      if (this.extraRoots.some((e) => isSameRoot(e, r))) continue;
      this.extraRoots.push(r);
      this.deps.io.addAppWritableRoot(r);
      this.deps.log.info(`项目位置授权已生效：${r}`);
    }
  }

  async list(): Promise<WorkspaceProject[]> {
    const out: WorkspaceProject[] = [];
    const seenAt = new Map<string, string>(); // projectId → 命中根（跨根去重用）
    for (const root of this.roots()) {
      const entries = await this.deps.io.listDir(root);
      for (const e of entries) {
        if (!e.isDirectory) continue;
        const dir = join(root, e.name);
        const p = await this.readManifestAt(dir);
        if (p === null) continue;
        const previous = seenAt.get(p.id);
        if (previous !== undefined) {
          // 同一个 id 出现在两个根：保留**先扫到的**那个（`roots()` 默认根恒在首位），
          // 并把冲突出声——两处都留着的清单会变成"改一个、另一个还看得见"
          this.deps.log.warn(
            `Workspace project id '${p.id}' found under both ${previous} and ${dir} — keeping ${previous}`,
          );
          continue;
        }
        seenAt.set(p.id, root);
        this.dirById.set(p.id, dir);
        out.push(p);
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(projectId: string): Promise<WorkspaceProject | null> {
    return this.readManifest(projectId);
  }

  async create(input: {
    name: string;
    meta?: Record<string, unknown>;
    rootDir?: string;
  }): Promise<WorkspaceProject> {
    const name = input.name.trim();
    if (name.length === 0) throw new Error('Project name must not be empty');
    let root = this.requireRoot();
    if (input.rootDir !== undefined) {
      // 落点只能命中**已授权的根**（默认根 / 对话框自选根）。这里刻意不做
      // "路径合法就放行"：授权的唯一来源是平台目录对话框（铁律 6），本层只核对名单。
      await this.refreshAuthorizedRoots();
      const hit = this.roots().find((r) => isSameRoot(r, input.rootDir!));
      if (hit === undefined) {
        throw new Error(
          `项目位置未获得授权：${input.rootDir}（只能在默认工作区或「自选…」对话框里选定的文件夹内新建）`,
        );
      }
      root = hit;
    }
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
    this.dirById.set(id, join(root, id)); // 先登记，manifest 才写得到正确的根
    await this.deps.io.ensureDir(join(root, id));
    await this.writeManifest(project);
    this.deps.log.info(`Workspace project created: ${name} (${id}) @ ${root}`);
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
    // 走 locateProjectDir：外部根里的项目若未 `list()` 过，`projectDir()` 会回落默认根，
    // 而删一个不存在的目录是**幂等成功**（静默失败：项目看着被删了，其实还在原处）
    const dir = await this.locateProjectDir(projectId);
    await this.deps.bridge.removeDir(dir);
    this.dirById.delete(projectId);
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

  async importDirectory(projectId: string, input: WorkspaceImportInput): Promise<WorkspaceArtifact> {
    const project = await this.readManifest(projectId);
    if (!project) throw new Error(`Workspace project not found: ${projectId}`);
    const name = input.name.trim();
    if (name.length === 0) throw new Error('Artifact name must not be empty');
    assertSegment(input.dirName, 'artifact directory name');

    // 冲突判定以 manifest 登记为准（与 createArtifact 同口径；不覆盖既有包）
    if (
      project.artifacts.some((a) => a.dirName === input.dirName) ||
      (await this.deps.io.exists(join(this.projectDir(projectId), input.dirName)))
    ) {
      throw new Error(`Artifact directory already exists: ${input.dirName}`);
    }

    const sourceStat = await this.deps.io.stat(input.sourceDir);
    if (!sourceStat || !sourceStat.isDirectory) {
      throw new Error(`Source directory does not exist: ${input.sourceDir}`);
    }

    // 枚举源目录文件（只读，不改动源）；**字节级**复制保持原编码（一次转码毁半库）
    const entries = await this.deps.io.walkDir(input.sourceDir, { includeFiles: true });
    const targets: Array<{ from: string; to: string }> = [];
    for (const e of entries) {
      if (e.isDirectory) continue;
      const rel = e.path.slice(input.sourceDir.length).replace(/^[\\/]+/, '');
      // 纵深防御：拒绝一切逃逸段（walkDir 输出结构安全，但不信任输入侧）
      if (rel.split(/[\\/]/).includes('..')) {
        throw new Error(`Path escapes the source directory: ${rel}`);
      }
      targets.push({ from: e.path, to: this.resolveIn(projectId, join(input.dirName, rel)) });
    }

    for (const t of targets) {
      await this.deps.io.ensureDir(dirname(t.to));
      const bytes = await this.deps.io.readBytes(t.from);
      await this.deps.io.writeBytes(t.to, bytes);
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
    this.deps.log.info(`Artifact imported: ${name} (${targets.length} files) from ${input.sourceDir}`);
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
