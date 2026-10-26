/**
 * 插件项目测试基座：**真实临时目录** + 假宿主。
 *
 * 三件事各有分工，不互相冒充：
 * - `TempIO`：`FileIO` 的 Node 实现（只实现本服务会碰的那些方法）——文件真的落盘，
 *   断言读的是盘上的字节，不是内存里的副本；
 * - `FakeWorkspaces`：`kernel.workspaces` 的最小替身（项目 → 制品 → 文件 + `workspace.json`），
 *   语义照内核那一份（单层段校验 / 制品冲突 / `projectDir` 未 list 时回落默认根），
 *   因为本包**不能** import 内核（审计 B）；
 * - `FakeProjectHost`：`LauncherHostBridge` 之上只多一条 `launcher_project_hash`
 *   （真宿主还没有这条命令，子类化是为了让「缺命令」那档能用母公司测出来）。
 *
 * 哈希用 `node:crypto`：**测试里的对拍 oracle**，不是第二份校验锚（生产侧唯一实现住
 * `kojo-market/src/digest.ts`，本包只经宿主取摘要）。
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type {
  DirEntry,
  FileIO,
  GamePluginRules,
  InstalledPlugin,
  LauncherInstance,
  PluginInstallPlan,
  PluginManager,
  TextFile,
  WorkspaceArtifact,
  WorkspaceArtifactInput,
  WorkspaceProject,
  WorkspaceService,
} from '@kojo/plugin-api';
import { WORKSPACE_MANIFEST_FILE, isAbsolute, isPathUnder, join } from '@kojo/plugin-api';
import { FakeHost, makeInstance } from './fake-host';
import type { HostFileDigest, HostProjectHashInput } from '../../src/plugin-project';
import { PluginProjectServiceImpl } from '../../src/plugin-project';

/* ══════════════════════════════════════════════════════════════════════════════
 * 真临时目录上的 FileIO
 * ══════════════════════════════════════════════════════════════════════════════ */

export class TempIO {
  /** 写失败注入（路径匹配即抛）；用于「构建失败清理半截产物」「创建回滚」 */
  failWrite: ((abs: string) => boolean) | null = null;
  readonly writes: string[] = [];

  private guard(abs: string): void {
    if (this.failWrite !== null && this.failWrite(abs)) {
      throw new Error(`模拟写入失败：${abs}`);
    }
    this.writes.push(abs);
  }

  async readText(path: string): Promise<TextFile> {
    const text = await fs.readFile(path, 'utf8');
    const stat = await fs.stat(path);
    return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: stat.mtimeMs };
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(path));
  }

  async readBytesMany(paths: readonly string[]): Promise<Array<Uint8Array | null>> {
    const out: Array<Uint8Array | null> = [];
    for (const path of paths) {
      try {
        out.push(new Uint8Array(await fs.readFile(path)));
      } catch {
        out.push(null);
      }
    }
    return out;
  }

  async writeText(path: string, text: string): Promise<void> {
    this.guard(path);
    await fs.mkdir(nodePath.dirname(path), { recursive: true });
    await fs.writeFile(path, text, 'utf8');
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    this.guard(path);
    await fs.mkdir(nodePath.dirname(path), { recursive: true });
    await fs.writeFile(path, data);
  }

  async ensureDir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string) {
    try {
      const stat = await fs.stat(path);
      return { size: stat.size, mtimeMs: stat.mtimeMs, isDirectory: stat.isDirectory() };
    } catch {
      return null;
    }
  }

  async listDir(path: string): Promise<DirEntry[]> {
    let entries;
    try {
      entries = await fs.readdir(path, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.map((entry) => ({
      name: entry.name,
      path: nodePath.join(path, entry.name),
      isDirectory: entry.isDirectory(),
    }));
  }

  async walkDir(path: string, opts: { includeFiles?: boolean; includeDirs?: boolean; withMetadata?: boolean } = {}): Promise<DirEntry[]> {
    const out: DirEntry[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (opts.includeDirs === true) out.push({ name: entry.name, path: abs, isDirectory: true });
          await walk(abs);
        } else if (opts.includeFiles === true) {
          const item: DirEntry = { name: entry.name, path: abs, isDirectory: false };
          if (opts.withMetadata === true) {
            const stat = await fs.stat(abs);
            item.mtimeMs = stat.mtimeMs;
            item.size = stat.size;
          }
          out.push(item);
        }
      }
    };
    await walk(path);
    return out;
  }

  async removeDir(path: string): Promise<void> {
    await fs.rm(path, { recursive: true, force: true });
  }

  async removeFile(path: string): Promise<void> {
    await fs.rm(path, { force: true });
  }

  async appDataDir(): Promise<string> {
    throw new Error('测试替身不提供 appDataDir');
  }
}

/** `TempIO` → `FileIO`（只实现本服务会碰的面；未实现的方法调用时会 TypeError，测试即红） */
export function asFileIO(io: TempIO): FileIO {
  return io as unknown as FileIO;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * `kernel.workspaces` 的最小替身（语义照内核那一份）
 * ══════════════════════════════════════════════════════════════════════════════ */

function assertSegment(value: string, what: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    /[\\/]/.test(value) ||
    value === WORKSPACE_MANIFEST_FILE
  ) {
    throw new Error(`${what}不合法：「${value}」`);
  }
}

function sameDir(a: string, b: string): boolean {
  return isPathUnder(a, b) && isPathUnder(b, a);
}

export class FakeWorkspaces implements WorkspaceService {
  /** 命中外部根时按 id 缓存（未命中回落默认根——与内核同一条纪律） */
  private readonly dirById = new Map<string, string>();
  private seq = 0;
  readonly calls: string[] = [];

  constructor(
    private readonly io: TempIO,
    private readonly defaultRoot: string,
    private readonly extraRoots: readonly string[] = [],
  ) {}

  rootDir(): string {
    return this.defaultRoot;
  }

  roots(): string[] {
    return [this.defaultRoot, ...this.extraRoots];
  }

  async list(): Promise<WorkspaceProject[]> {
    const out: WorkspaceProject[] = [];
    for (const root of this.roots()) {
      for (const entry of await this.io.listDir(root)) {
        if (!entry.isDirectory) continue;
        const project = await this.readManifestAt(nodePath.join(root, entry.name));
        if (project === null) continue;
        this.dirById.set(project.id, nodePath.join(root, entry.name));
        out.push(project);
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(projectId: string): Promise<WorkspaceProject | null> {
    return this.readManifestAt(this.projectDir(projectId));
  }

  projectDir(projectId: string): string {
    assertSegment(projectId, '项目名');
    return this.dirById.get(projectId) ?? nodePath.join(this.defaultRoot, projectId);
  }

  async create(input: { name: string; meta?: Record<string, unknown>; rootDir?: string }): Promise<WorkspaceProject> {
    const name = input.name.trim();
    if (name.length === 0) throw new Error('项目名不能为空。');
    let root = this.defaultRoot;
    if (input.rootDir !== undefined) {
      const hit = this.roots().find((candidate) => sameDir(candidate, input.rootDir!));
      if (hit === undefined) throw new Error(`项目位置未获得授权：${input.rootDir}`);
      root = hit;
    }
    this.seq += 1;
    const id = `p${this.seq}`;
    const now = Date.now();
    const project: WorkspaceProject = {
      id,
      name,
      createdAt: now,
      updatedAt: now,
      artifacts: [],
      meta: input.meta ?? {},
    };
    this.dirById.set(id, nodePath.join(root, id));
    await this.io.ensureDir(nodePath.join(root, id));
    await this.writeManifest(project);
    return project;
  }

  async update(projectId: string, patch: { name?: string; meta?: Record<string, unknown> }): Promise<WorkspaceProject> {
    const project = await this.get(projectId);
    if (project === null) throw new Error(`找不到这个工作区项目：${projectId}`);
    if (patch.name !== undefined) project.name = patch.name.trim();
    if (patch.meta !== undefined) project.meta = patch.meta;
    project.updatedAt = Date.now();
    await this.writeManifest(project);
    return project;
  }

  async remove(projectId: string): Promise<void> {
    const dir = this.projectDir(projectId);
    await this.io.removeDir(dir);
    this.dirById.delete(projectId);
  }

  async createArtifact(projectId: string, input: WorkspaceArtifactInput): Promise<WorkspaceArtifact> {
    const project = await this.get(projectId);
    if (project === null) throw new Error(`找不到这个工作区项目：${projectId}`);
    assertSegment(input.dirName, '制品目录名');
    if (
      project.artifacts.some((a) => a.dirName === input.dirName) ||
      (await this.io.exists(nodePath.join(this.projectDir(projectId), input.dirName)))
    ) {
      throw new Error(`这个制品目录已经存在：${input.dirName}`);
    }
    for (const [rel, text] of Object.entries(input.files)) {
      if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
        throw new Error(`路径越出了制品目录：${rel}`);
      }
      await this.io.writeText(nodePath.join(this.projectDir(projectId), input.dirName, rel), text);
    }
    this.seq += 1;
    const artifact: WorkspaceArtifact = {
      id: `a${this.seq}`,
      name: input.name,
      dirName: input.dirName,
      meta: input.meta ?? {},
      createdAt: Date.now(),
    };
    project.artifacts.push(artifact);
    project.updatedAt = Date.now();
    await this.writeManifest(project);
    return artifact;
  }

  async removeArtifact(projectId: string, artifactId: string): Promise<void> {
    const project = await this.get(projectId);
    if (project === null) throw new Error(`找不到这个工作区项目：${projectId}`);
    const index = project.artifacts.findIndex((a) => a.id === artifactId);
    if (index < 0) throw new Error(`找不到这个制品：${artifactId}`);
    const artifact = project.artifacts[index]!;
    await this.io.removeDir(nodePath.join(this.projectDir(projectId), artifact.dirName));
    project.artifacts.splice(index, 1);
    project.updatedAt = Date.now();
    await this.writeManifest(project);
  }

  async importDirectory(): Promise<WorkspaceArtifact> {
    throw new Error('测试替身未实现 importDirectory');
  }

  async listDir(projectId: string, relDir = '.'): Promise<DirEntry[]> {
    return this.io.listDir(nodePath.join(this.projectDir(projectId), relDir));
  }

  async readText(projectId: string, relPath: string): Promise<TextFile> {
    return this.io.readText(this.resolveIn(projectId, relPath));
  }

  async writeText(projectId: string, relPath: string, text: string): Promise<void> {
    return this.io.writeText(this.resolveIn(projectId, relPath), text);
  }

  private resolveIn(projectId: string, relPath: string): string {
    if (isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) {
      throw new Error(`路径越出了当前项目目录：${relPath}`);
    }
    const base = this.projectDir(projectId);
    const target = join(base, relPath);
    if (!isPathUnder(base, target)) throw new Error(`路径越出了当前项目目录：${relPath}`);
    return target;
  }

  private async readManifestAt(dir: string): Promise<WorkspaceProject | null> {
    const path = nodePath.join(dir, WORKSPACE_MANIFEST_FILE);
    if (!(await this.io.exists(path))) return null;
    try {
      return JSON.parse(await fs.readFile(path, 'utf8')) as WorkspaceProject;
    } catch {
      return null;
    }
  }

  private async writeManifest(project: WorkspaceProject): Promise<void> {
    await this.io.writeText(
      nodePath.join(this.projectDir(project.id), WORKSPACE_MANIFEST_FILE),
      JSON.stringify(project, null, 2),
    );
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 假宿主：只有 `launcher_project_hash`（真宿主还没有这条命令）
 * ══════════════════════════════════════════════════════════════════════════════ */

export class FakeProjectHost extends FakeHost {
  /** 摘要请求记录（「构建确实走了宿主摘要」的判据） */
  readonly hashRequests: HostProjectHashInput[] = [];
  /** 从第 N 次摘要请求起改坏返回（模拟「两步之间文件被换过」）；`Infinity` = 不改 */
  corruptFrom = Number.POSITIVE_INFINITY;

  async projectHash(input: HostProjectHashInput): Promise<readonly HostFileDigest[]> {
    const requestIndex = this.hashRequests.length;
    this.hashRequests.push(input);
    const corrupt = requestIndex >= this.corruptFrom;
    const out: HostFileDigest[] = [];
    for (const entry of input.entries) {
      const abs = nodePath.join(input.projectDir, input.artifactDir, entry);
      if (!isPathUnder(nodePath.join(input.projectDir, input.artifactDir), abs)) {
        throw new Error(`条目越出了制品目录：${entry}`);
      }
      const data = await fs.readFile(abs);
      const sha256 = createHash('sha256').update(data).digest('hex');
      out.push({
        path: entry,
        sha256: corrupt ? 'f'.repeat(64) : sha256,
        size: data.length,
      });
    }
    return out;
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 假插件管理器（只给 planInstall / list 两条）
 * ══════════════════════════════════════════════════════════════════════════════ */

export class FakePlugins {
  installed: InstalledPlugin[] = [];
  readonly planRequests: Array<{ instanceId: string; archivePath: string }> = [];

  asManager(): PluginManager {
    return this as unknown as PluginManager;
  }

  async list(): Promise<readonly InstalledPlugin[]> {
    return this.installed;
  }

  async planInstall(instanceId: string, archivePath: string): Promise<PluginInstallPlan> {
    this.planRequests.push({ instanceId, archivePath });
    return {
      planId: `plan-${this.planRequests.length}`,
      mode: 'install',
      manifest: this.installed[0]?.manifest ?? ({} as PluginInstallPlan['manifest']),
      targets: [],
      additions: [],
      overwrites: [],
      conflicts: [],
      functionConflicts: [],
      missingRequirements: [],
      compatibility: {
        ok: true,
        gameVersion: null,
        requiredGameVersion: null,
        apiVersion: null,
        checkedBy: 'none',
        reasons: [],
      },
      saveImpact: 'none',
      risk: 'content-only',
      requiresRestart: false,
      warnings: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 组合基座
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface ProjectHarness {
  readonly tempDir: string;
  readonly defaultRoot: string;
  readonly extraRoot: string;
  readonly io: TempIO;
  readonly ws: FakeWorkspaces;
  readonly host: FakeHost;
  readonly plugins: FakePlugins;
  readonly instance: LauncherInstance;
  readonly service: PluginProjectServiceImpl;
  /** 造一条测试用的假（不落盘） */
  addFile(abs: string, text: string): Promise<void>;
  /** 直接读盘上的字节 */
  read(abs: string): Promise<Uint8Array>;
  cleanup(): Promise<void>;
}

export interface ProjectHarnessOptions {
  readonly plugins?: PluginManager;
  readonly host?: FakeHost;
  readonly withWorkspaces?: boolean;
  readonly withIo?: boolean;
  /** adapter 的 pluginRules（`scaffold` / `roots`）；缺省 = 实例自带的两个根、无 scaffold */
  readonly pluginRules?: GamePluginRules;
  /** 自选根未授权时用（默认给 extraRoot 授权） */
  readonly extraRoots?: readonly string[];
}

/** 建一次带临时目录 / 工作区 / 假宿主的测试基座 */
export async function makeProjectHarness(options: ProjectHarnessOptions = {}): Promise<ProjectHarness> {
  const tempDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'kojo-l7b-'));
  const defaultRoot = nodePath.join(tempDir, 'workspaces');
  const extraRoot = nodePath.join(tempDir, 'extra');
  await fs.mkdir(defaultRoot, { recursive: true });
  await fs.mkdir(extraRoot, { recursive: true });

  const io = new TempIO();
  const ws = new FakeWorkspaces(io, defaultRoot, options.extraRoots ?? [extraRoot]);
  const host = (options.host as FakeProjectHost | undefined) ?? new FakeProjectHost();
  const plugins = new FakePlugins();
  const instance = makeInstance({
    id: 'i1',
    adapterId: 'demo-adapter',
    gameId: 'demo',
    gameRoot: nodePath.join(tempDir, 'game'),
    instanceRoot: nodePath.join(tempDir, 'instances', 'i1'),
    contentRoots: [
      {
        id: 'script',
        label: '脚本',
        relativePath: 'ERB',
        kind: 'script',
        accepts: ['plugin', 'script'],
        writableInShared: true,
      },
      {
        id: 'data',
        label: '数据',
        relativePath: 'data',
        kind: 'data',
        accepts: ['plugin', 'script'],
        writableInShared: true,
      },
    ],
  });
  await fs.mkdir(instance.gameRoot, { recursive: true });

  const service = new PluginProjectServiceImpl({
    workspaces: options.withWorkspaces === false ? null : ws,
    io: options.withIo === false ? null : asFileIO(io),
    host: options.host ?? host,
    plugins: options.plugins ?? plugins.asManager(),
    getInstance: async (id) => (id === instance.id ? instance : null),
    pluginRulesOf: () =>
      options.pluginRules ?? {
        roots: instance.contentRoots,
        manifestNames: ['pack.json'],
        orderSource: 'manifest',
        requiresRestart: true,
        saveImpact: 'possible',
      },
    now: () => Date.parse('2026-10-26T12:00:00.000Z'),
  });

  return {
    tempDir,
    defaultRoot,
    extraRoot,
    io,
    ws,
    host,
    plugins,
    instance,
    service,
    async addFile(abs: string, text: string): Promise<void> {
      await fs.mkdir(nodePath.dirname(abs), { recursive: true });
      await fs.writeFile(abs, text, 'utf8');
    },
    async read(abs: string): Promise<Uint8Array> {
      return new Uint8Array(await fs.readFile(abs));
    },
    async cleanup(): Promise<void> {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

/** 一条最小的创建输入（`template: 'blank'`，根映射 `src → ''`） */
export function makeCreateInput(
  overrides: Partial<Parameters<PluginProjectServiceImpl['create']>[0]> = {},
): Parameters<PluginProjectServiceImpl['create']>[0] {
  return {
    name: '示例插件',
    instanceId: 'i1',
    pluginId: 'demo.example',
    displayName: '示例插件',
    version: '1.0.0',
    capabilities: ['add-content'],
    saveImpact: 'none',
    loadOrder: 10,
    template: 'blank',
    roots: [{ rootId: 'script', from: 'src' }],
    ...overrides,
  };
}
