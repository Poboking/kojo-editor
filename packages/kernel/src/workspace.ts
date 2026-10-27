import type {
  DirEntry,
  FileIO,
  Logger,
  OpJournal,
  PlatformBridge,
  TextFile,
  WorkspaceArtifact,
  WorkspaceArtifactInput,
  WorkspaceImportInput,
  WorkspaceProject,
  WorkspaceService,
} from '@kojo/plugin-api';
import { WORKSPACE_MANIFEST_FILE, isAbsolute, isPathUnder, join } from '@kojo/plugin-api';

/**
 * 作者工作区服务实现（内核 `kernel.workspaces`）。
 *
 * 布局：`<落点根>/<projectId>/workspace.json` + 制品子目录。
 * 落点根 = 默认根 `<appDataDir>/workspaces`（恒在首位）∪ 用户自选并常驻授权的项目位置根
 * （2026-10-14 批；`roots()`）。注册表 = 扫描各根目录读 manifest（免索引文件——索引即目录，崩溃不漂移）。
 *
 * 安全（2026-10-27 收窄批）：
 * - 常驻可写根 = **默认根 + 已解析的作品目录**（`projectDirs()`）。自选项目位置根的
 *   **根身本身不再登记**：作者把游戏目录选成"项目位置"时，游戏目录下的一切文件曾经连带
 *   可写（收窄前 `setAppWritableRoots([root, ...extraRoots])`）；现在只有真正落在其下的
 *   作品目录可写，游戏目录保持只读。写盘仍走内核 io 双闸；
 * - 额外根只读自平台（`listWorkspaceRoots`），而平台侧那份授权的唯一来源是
 *   目录对话框（`chooseWorkspaceRoot`：对话框与登记绑在同一个命令内）。
 *   本服务**不接受**任何"给个路径就放行"的入口：`create` 的 `rootDir` 必须命中已知根；
 * - 收窄授权（`revokeRoot`）是允许的：那是路径参数，但它只能让写允许域变小（铁律 6 管"扩大"）；
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
  /** 批操作 journal（2026-10-16 undo 批，additive）：createArtifact 的半成品治理 + 操作历史 */
  journal?: OpJournal | null;
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
    throw new Error(`${what}不合法：「${value}」只能是一个目录名（不能带路径分隔符、不能是空名或系统占用名）。`);
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
    // 只登记默认根 + 已解析作品目录（此刻还没有 ⇒ 只有默认根）：自选根根身不进写允许域
    this.syncWritableRoots();
    await this.deps.io.ensureDir(this.root);
    this.deps.log.info(
      `Workspace root: ${this.root}` +
        (this.extraRoots.length > 0 ? `（另有 ${this.extraRoots.length} 个自选项目位置）` : ''),
    );
    // 有外部根 ⇒ 必须先扫一次，否则 projectDir() 把它们的项目全解析回默认根
    // （get/update/remove 会找不到项目）。没有外部根时保持零额外扫描：默认根下
    // `join(root, id)` 就是唯一真相，init 再扫一遍纯属重复面板的那一次 list。
    // `list()` 末尾会再同步一次常驻可写根（把扫到的作品目录纳入）。
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

  /**
   * 常驻**可写**目录：默认根（恒在首位）+ 已解析的作品目录。
   *
   * 刻意**不含自选根根身**（2026-10-27 收窄批）：`roots()` 回答"能在哪里新建作品"，
   * 这里是"此刻哪些目录可写"。自选根如果是游戏目录，根身可写 = 游戏目录可写，
   * 那正是本批要收掉的面。只收 `dirById` 里落在某个自选根之下的目录
   * （默认根下的项目已被默认根整体覆盖）。
   */
  projectDirs(): string[] {
    const root = this.requireRoot();
    const out = [root];
    for (const dir of this.dirById.values()) {
      if (!this.extraRoots.some((r) => isPathUnder(r, dir))) continue;
      if (out.some((d) => isSameRoot(d, dir))) continue;
      out.push(dir);
    }
    return out;
  }

  /** 把 `projectDirs()` 同步进 io 第一道闸（整替语义：只许收窄或按作品目录放宽） */
  private syncWritableRoots(): void {
    this.deps.io.setAppWritableRoots(this.projectDirs());
  }

  projectDir(projectId: string): string {
    assertSegment(projectId, '项目名');
    const known = this.dirById.get(projectId);
    if (known !== undefined) return known;
    return join(this.requireRoot(), projectId);
  }

  /**
   * 解析项目目录，必要时扫一次盘（`projectDir` 的异步半边，专供"必须先知道在哪个根"
   * 才能做对的动作，如删除——删错目录是静默失败：不存在 → 幂等成功 → 项目还在）。
   */
  private async locateProjectDir(projectId: string): Promise<string> {
    // 段级校验先行（2026-10-16 修复批）：join 会归一化折叠 '..'，
    // '../../backup' 类 id 能把写闸外的备份域整目录删掉——删错目录是静默失败。
    assertSegment(projectId, '项目名');
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
    // fail-closed（2026-10-17 修复批）：找不到绝不回落默认根。外部根离线/被收回时，
    // 回落 + removeDir 的幂等成功 = 「项目看着被删了，其实还在原处」的静默失败；
    // 目录真被手动删过时这个错误也是如实答案，不是误报。
    throw new Error(
      `Project directory not found in any authorized root (root offline or already removed?): ${projectId}`,
    );
  }

  private manifestPath(projectId: string): string {
    return join(this.projectDir(projectId), WORKSPACE_MANIFEST_FILE);
  }

  /** 相对路径 → 项目内绝对路径（拒绝对路径与一切 `..` 段；isPathUnder 兜底） */
  private resolveIn(projectId: string, relPath: string): string {
    const base = this.projectDir(projectId);
    if (isAbsolute(relPath)) throw new Error(`这个位置不接受绝对路径：${relPath}`);
    if (relPath.split(/[\\/]/).includes('..')) {
      throw new Error(`路径越出了当前项目目录：${relPath}`);
    }
    const target = join(base, relPath);
    if (!isPathUnder(base, target)) throw new Error(`路径越出了当前项目目录：${relPath}`);
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
   * `init` 时读到的那份里，故落盘授权后重读一次。
   *
   * **不再把根身登记进 io**（2026-10-27 收窄批）：新根之下的既有作品目录要靠一次
   * `list()` 解析出来（`list` 末尾同步常驻可写根），自选根根身本身始终不写。
   */
  private async refreshAuthorizedRoots(): Promise<void> {
    const fresh = await this.readAuthorizedRoots();
    let added = false;
    for (const r of fresh) {
      if (this.extraRoots.some((e) => isSameRoot(e, r))) continue;
      this.extraRoots.push(r);
      added = true;
      this.deps.log.info(`项目位置授权已生效：${r}（只登记其下的作品目录）`);
    }
    if (added) await this.list();
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
    // 扫完即同步常驻可写根：自选根下的作品目录刚刚被解析出来
    // （2026-10-27 收窄批——收窄后这是"作品可写"的唯一来源）
    this.syncWritableRoots();
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
    if (name.length === 0) throw new Error('项目名不能为空。');
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
    // 再同步可写根：新作品目录此刻才进 `projectDirs()`，随后 ensureDir / 写 manifest 才过得去
    this.syncWritableRoots();
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
    if (!project) throw new Error(`找不到这个工作区项目：${projectId}`);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.length === 0) throw new Error('项目名不能为空。');
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
    // 删除必须过 io 写闸（双闸第一道，2026-10-16 修复批）：直调 bridge.removeDir
    // 绕开 assertWritable——常驻根被收回或路径出域时照样删盘。
    await this.deps.io.removeDir(dir);
    this.dirById.delete(projectId);
    // 作品没了 ⇒ 它的目录也别再留在常驻可写根里（只收窄，不放宽）
    this.syncWritableRoots();
    this.deps.log.info(`Workspace project removed: ${projectId}`);
  }

  /**
   * 撤销一个自选项目位置根（2026-10-27 撤销批）。
   *
   * 顺序是刻意的：先核对"这个根下还有没有作品"，再动平台侧清单——反过来做的话，
   * 一次被拒的撤销也已经把授权撤了一半（作品当场变只读，而 UI 上写着"撤销失败"）。
   */
  async revokeRoot(root: string): Promise<void> {
    const defaultRoot = this.requireRoot();
    if (isSameRoot(root, defaultRoot)) {
      throw new Error(
        `默认工作区不能撤销：${defaultRoot} 就是作者作品的常驻位置（撤销会把里面的作品锁成只读）。`,
      );
    }
    // 名单要重读：本会话刚经对话框授权的根不在 init 那份里
    await this.refreshAuthorizedRoots();
    const hit = this.extraRoots.find((r) => isSameRoot(r, root));
    if (hit === undefined) {
      throw new Error(`这个位置不在已授权的项目位置清单里：${root}（可能已经撤销过）`);
    }
    // 必须扫一次：`dirById` 只由 list()/create 填充，问不出"还有没有作品"就撤销 = 作品变只读
    await this.list();
    const busy = [...this.dirById.entries()].filter(([, dir]) => isPathUnder(hit, dir));
    if (busy.length > 0) {
      const names = busy.slice(0, 3).map(([id]) => id).join('、');
      throw new Error(
        `这个位置里还有 ${busy.length} 个作品${names.length > 0 ? `（${names}${busy.length > 3 ? '…' : ''}）` : ''}：` +
          '先把它们移走或删除，再撤销——否则撤销后这些作品会变成只读。',
      );
    }
    await this.deps.bridge.revokeWorkspaceRoot(hit);
    this.extraRoots = this.extraRoots.filter((r) => !isSameRoot(r, hit));
    this.syncWritableRoots();
    this.deps.log.info(`项目位置授权已撤销：${hit}`);
  }

  async createArtifact(projectId: string, input: WorkspaceArtifactInput): Promise<WorkspaceArtifact> {
    const project = await this.readManifest(projectId);
    if (!project) throw new Error(`找不到这个工作区项目：${projectId}`);
    const name = input.name.trim();
    if (name.length === 0) throw new Error('制品名不能为空。');
    assertSegment(input.dirName, '制品目录名');

    // 冲突判定以 manifest 登记为准（空文件集的制品不落目录，磁盘判定会漏）
    if (
      project.artifacts.some((a) => a.dirName === input.dirName) ||
      (await this.deps.io.exists(join(this.projectDir(projectId), input.dirName)))
    ) {
      throw new Error(`这个制品目录已经存在：${input.dirName}（换一个名字，或先删掉旧的）。`);
    }

    // 先落全部文件（任一越界在写前校验阶段就抛，不产半成品目录登记）。
    // 注意：段校验必须对**原始**相对路径做——join 会先归一化把 `pkg/../x` 折叠掉。
    const entries = Object.entries(input.files);
    const targets = entries.map(([rel]) => {
      if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
        throw new Error(`路径越出了制品目录：${rel}`);
      }
      return this.resolveIn(projectId, join(input.dirName, rel));
    });
    // 批操作 journal（2026-10-16 undo 批）：逐文件 record→write，任一失败 abort
    // 回滚已写文件（旧形态中途失败留半成品目录，重试撞 already exists——本批治理）；
    // 成功 commit 进操作历史（操作历史 overlay 可整批撤销，manifest 登记一并回退）。
    const journal = this.deps.journal ?? null;
    const opId = journal ? await journal.begin('scaffold', `创建制品：${name}`) : null;
    try {
      for (let i = 0; i < entries.length; i++) {
        if (opId !== null) await journal!.record(opId, targets[i]!);
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
      // manifest 一并进 journal：撤销时登记同步回退（否则文件删了、面板还挂着空制品）
      if (opId !== null) await journal!.record(opId, this.manifestPath(projectId));
      await this.writeManifest(project);
      if (opId !== null) await journal!.commit(opId);
      this.deps.log.info(`Artifact created: ${name} in project ${projectId}`);
      return artifact;
    } catch (err) {
      if (opId !== null) {
        try {
          await journal!.abort(opId); // 失败即回滚：已写文件恢复/删除，零残留
        } catch (rollbackErr) {
          this.deps.log.warn(
            `createArtifact: 半成品回滚失败（保留现场）：${String(rollbackErr)}`,
          );
        }
      }
      throw err;
    }
  }

  async importDirectory(projectId: string, input: WorkspaceImportInput): Promise<WorkspaceArtifact> {
    const project = await this.readManifest(projectId);
    if (!project) throw new Error(`找不到这个工作区项目：${projectId}`);
    const name = input.name.trim();
    if (name.length === 0) throw new Error('制品名不能为空。');
    assertSegment(input.dirName, '制品目录名');

    // 冲突判定以 manifest 登记为准（与 createArtifact 同口径；不覆盖既有包）
    if (
      project.artifacts.some((a) => a.dirName === input.dirName) ||
      (await this.deps.io.exists(join(this.projectDir(projectId), input.dirName)))
    ) {
      throw new Error(`这个制品目录已经存在：${input.dirName}（换一个名字，或先删掉旧的）。`);
    }

    const sourceStat = await this.deps.io.stat(input.sourceDir);
    if (!sourceStat || !sourceStat.isDirectory) {
      throw new Error(`要复制的源目录不存在：${input.sourceDir}`);
    }

    // 枚举源目录文件（只读，不改动源）；**字节级**复制保持原编码（一次转码毁半库）
    const entries = await this.deps.io.walkDir(input.sourceDir, { includeFiles: true });
    const targets: Array<{ from: string; to: string }> = [];
    for (const e of entries) {
      if (e.isDirectory) continue;
      const rel = e.path.slice(input.sourceDir.length).replace(/^[\\/]+/, '');
      // 纵深防御：拒绝一切逃逸段（walkDir 输出结构安全，但不信任输入侧）
      if (rel.split(/[\\/]/).includes('..')) {
        throw new Error(`路径越出了源目录：${rel}`);
      }
      targets.push({ from: e.path, to: this.resolveIn(projectId, join(input.dirName, rel)) });
    }

    // 每文件**一趟**服务端复制：字节不过 JS、父目录由平台侧顺手建（见契约 `FileIO.copyFile`）。
    // 旧形态是 `ensureDir` + `readBytes` + `writeBytes` 三趟串行往返，且写侧字节还要
    // base64 过界；导入是"用户点一次就付一次钱"的面，N 个文件就是 3N 次 IPC。
    // 闸的口径没变：`to` 恒由 `resolveIn` 落在项目目录（常驻可写根）内，越权照样
    // `WriteNotAllowedError`；`from` 是只读源，读不受写允许域约束（这正是导入的常态）。
    // 复制中途失败不留半成品（2026-10-16 修复批，rebase 合入 PERF-10b④ 的 copyFile 形态）：
    // 已建目录整体清掉、manifest 未登记，重试不再撞 already exists；
    // 清理自身失败要出声（不吞），真因必须原样上抛不被顶替。
    try {
      for (const t of targets) {
        await this.deps.io.copyFile(t.from, t.to);
      }
    } catch (err) {
      const artifactDir = join(this.projectDir(projectId), input.dirName);
      try {
        await this.deps.io.removeDir(artifactDir);
      } catch (cleanupErr) {
        this.deps.log.warn(
          `importDirectory: 清理半成品制品目录失败（保留现场）：${artifactDir} — ${String(cleanupErr)}`,
        );
      }
      throw err;
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
    if (!project) throw new Error(`找不到这个工作区项目：${projectId}`);
    const idx = project.artifacts.findIndex((a) => a.id === artifactId);
    if (idx < 0) throw new Error(`找不到这个制品：${artifactId}`);
    const artifact = project.artifacts[idx]!;
    // manifest 里的 dirName 是持久化数据（可能被手改/损坏）：join 会归一化折叠 '..'，
    // '../../backup' 类值能把写闸外的备份域整目录删掉——删除前强制单层段复验；
    // 同根内的段级跳跃（../neighbor）写闸拦不住，只有段校验能拦（2026-10-16 修复批）。
    assertSegment(artifact.dirName, '制品目录名');
    // 删除必须过 io 写闸（与 remove 同口径）。
    await this.deps.io.removeDir(join(this.projectDir(projectId), artifact.dirName));
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
