/**
 * 插件源码项目（契约 §6.8 `PluginProjectService`；规格 §10.5 / ADR-0010）。
 *
 * ## 这个服务管什么
 *
 * 管**作者工作区的源**：项目目录、`plugin/plugin.json`、`build/`。它**不认识实例里的
 * 已装产物**（那是 `PluginManager` 的地盘），也**不认识游戏目录**——装配到实例只有
 * `build → plugins.planInstall → applyInstall` 一条路（§10.5.5）。
 *
 * ## 四条不变量（破了任何一条，本服务就不该被装配）
 *
 * 1. **不造第二套项目存储**：项目 = `kernel.workspaces` 里 `meta.kind = 'game-plugin'`
 *    的工作区项目；制品 = 项目内一个子目录（首版 `plugin`）。新建 / 改名 / 删除 / 列举
 *    与口上项目共用同一套服务与同一份 `workspace.json`。
 * 2. **源与产物分离**：源 `plugin.json` 里**没有**哈希（手写 `files[]` / `sha256` 即非法）；
 *    哈希只在构建时由宿主 `launcher_project_hash` 逐文件流式算出。
 * 3. **三条写边界**：①源码只写工作区项目目录；②产物只写 `{projectDir}/build/`
 *    （路径由本层拼死，没有 `outRelPath` 之类的参数）；③安装只经内容包管线（宿主命令）。
 * 4. **确定性由消费侧保证**：读文件 → 先按 POSIX 目标路径排序 → 传固定 `date` →
 *    `zip.ts::buildZip(entries, { contract: 'extractable' })`。同内容两次构建**逐字节相同**。
 *
 * ## 与契约的两处已知缺口（已在交付回执里逐条上报，不擅自扩 `plugin-api`）
 *
 * 1. `PluginProjectService` 没有「项目不存在 / 项目非法」的专用错误码，本层用
 *    `LAUNCHER_PLUGIN_PROJECT_INVALID`（人话 message 覆盖）+ `LAUNCHER_PATH_ESCAPE`（越界）；
 * 2. `InstalledPlugin` 没有 `buildSha256`，`inspectDrift` 因此只能比版本 + 来源项目 id
 *    （不是不判，是宿主没有这条读数）；`LauncherInstance` 也没有 `gameVersion` 字段，
 *    创建时 `gameVersion` 恒 `null`。
 */

import type {
  ContentFileEntry,
  ContentFileRef,
  ContentPackManifest,
  FileIO,
  FileStamp,
  GamePluginRules,
  LauncherInstance,
  PluginBuildOptions,
  PluginBuildResult,
  PluginBuildSummary,
  PluginCapability,
  PluginExtractOptions,
  PluginInstalledRef,
  PluginManager,
  PluginProject,
  PluginProjectArtifact,
  PluginProjectCreateInput,
  PluginProjectDrift,
  PluginProjectInstallPlan,
  PluginProjectMeta,
  PluginProjectService,
  PluginScaffoldResult,
  PluginSourceManifest,
  PluginSourceRootMap,
  WorkspaceArtifact,
  WorkspaceProject,
  WorkspaceService,
  ZipContractLimits,
} from '@kojo/plugin-api';
import {
  ZIP_CONTAINER_NAME_MAX,
  ZIP_EXTRACT_LIMITS,
  buildZip,
  foldDigest,
  isAbsolute,
  isPathUnder,
  join,
  projectFingerprintOf,
  stableHash,
  zipContainerNameProblem,
  zipEntryContractProblem,
} from '@kojo/plugin-api';
import type { LauncherHostBridge } from './host';
import { launcherError, normalizeLauncherError } from './errors';
import { builtinTemplate } from './plugin-project-template';

/* ══════════════════════════════════════════════════════════════════════════════
 * 常量与本地类型
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 识别「这是插件项目」的唯一判据（工作区 `meta.kind`） */
export const PLUGIN_PROJECT_KIND = 'game-plugin';

/** 首版制品目录名（单层；向导可换，服务不认第二套） */
export const DEFAULT_PLUGIN_ARTIFACT_DIR = 'plugin';

/** 源清单文件名（制品根内；唯一真源） */
export const PLUGIN_SOURCE_MANIFEST_FILE = 'plugin.json';

/** 项目根 `.gitignore`（恒排除 `build/`；构建产物不进版本控制、不参与下次构建） */
export const PLUGIN_PROJECT_GITIGNORE = 'build/\n';

/**
 * 构建产物的统一时间戳：**本地** 2020-01-01 00:00:00。
 *
 * 为什么取本地分量而不是 `Date.UTC`：`zip.ts::dosDateTime` 用 `getFullYear/getMonth/
 * getHours` 读的是**本地**时间，取 UTC 毫秒会让不同时区写出不同的 DOS 时间戳
 * （同一份源在两个时区构建出两个字节不同的包）。按本地分量构造 ⇒ 任何时区都落到
 * 2020-01-01 00:00，逐字节可复现。
 */
const FIXED_ZIP_DATE = (): number => new Date(2020, 0, 1, 0, 0, 0).getTime();

/** `pluginId` 字符集与长度（§10.5.2：3–80、不得以 `-` / `.` 开头结尾） */
const PLUGIN_ID_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;
const PLUGIN_ID_MIN = 3;
const PLUGIN_ID_MAX = 80;

const CAPABILITIES: ReadonlySet<string> = new Set<PluginCapability>([
  'add-content',
  'override-functions',
  'add-commands',
  'modify-data',
  'replace-resources',
]);

const SAVE_IMPACTS = new Set(['none', 'possible', 'unknown']);

/** 宿主 `launcher_project_hash` 的逐文件读数（§7.2：`{ projectDir, artifactDir, entries }` → `FileDigest[]`） */
export interface HostFileDigest {
  /** 入参里那条**相对 `artifactDir`** 的路径（原样回显，本层按它配对） */
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface HostProjectHashInput {
  /** 项目根绝对路径（宿主复核它在写允许域内） */
  readonly projectDir: string;
  /** 制品目录名（单层；条目解析后不得逃逸它） */
  readonly artifactDir: string;
  /** 相对 `artifactDir` 的文件路径（POSIX） */
  readonly entries: readonly string[];
}

/**
 * 构建期唯一的宿主能力面：**只回答「这批字节的哈希是多少」**。
 * 打包不在宿主（ADR-0010 决策 3：双打包器必漂）。
 */
export interface ProjectHashHost {
  projectHash(input: HostProjectHashInput): Promise<readonly HostFileDigest[]>;
}

/** `launcher_project_extract` 的一条暂存读数（宿主解包后的逐条目形状） */
export interface HostProjectExtractEntry {
  /** 包内路径（`{rootId}/{path}`；宿主已解到 `stagingDir` 下同名相对路径） */
  readonly path: string;
  /** 条目类型：符号链接与目录**一律拒绝**（首版只搬普通文件） */
  readonly kind: 'file' | 'symlink' | 'directory';
  readonly size: number;
}

/** `launcher_project_extract` 的返回（宿主暂存目录 + 包内清单 + 逐条目读数） */
export interface HostProjectExtractResult {
  /** 宿主解包落点（读侧；本层只读不写，也不删——暂存由宿主 TTL 清理） */
  readonly stagingDir: string;
  readonly manifest: ContentPackManifest;
  readonly entries: readonly HostProjectExtractEntry[];
}

/**
 * 「把压缩包反解成源码项目」的宿主能力面（本包**不在 JS 里解 zip**）。
 *
 * 真实宿主尚未提供这条命令（`launcher_content_plan` 是实例侧的，且不交字节），
 * 因此这里是**可选能力**：缺席时 `extractArchive` 如实拒绝并点名缺哪条命令。
 */
export interface ProjectExtractHost {
  projectExtract(
    archivePath: string,
    opts: { readonly limits: ZipContractLimits },
  ): Promise<HostProjectExtractResult>;
}

/** 项目元数据的持久化形状（`meta` 是 `Record<string, unknown>`，这里只做读侧校验） */
interface ProjectMetaRaw {
  kind: typeof PLUGIN_PROJECT_KIND;
  adapterId: string;
  gameId: string;
  gameVersion: string | null;
  targetInstanceId: string | null;
  lastBuild: PluginBuildSummary | null;
  installedTarget: PluginInstalledRef | null;
  extractedFrom?: NonNullable<PluginProjectMeta['extractedFrom']>;
  /** `source` 持久化（契约 `PluginProject.source` 的持久面；`created` 为缺省） */
  source?: 'created' | 'extracted';
}

interface LoadedProject {
  readonly workspace: WorkspaceProject;
  readonly projectDir: string;
  readonly artifactDirName: string;
  readonly manifest: PluginSourceManifest | null;
  readonly manifestText: string | null;
  readonly meta: ProjectMetaRaw;
}

/** 构建收集到的一条待打包文件 */
interface CollectedFile {
  /** 相对制品根的 POSIX 路径（宿主摘要的入参） */
  readonly artifactRel: string;
  readonly rootId: string;
  /** 目标根内相对路径（`pack.json` 的 `files[].path`） */
  readonly target: string;
  /** 包内路径 = `{rootId}/{target}`（宿主安装管线只认这个布局，见 `content.rs`） */
  readonly zipPath: string;
  readonly fromAbs: string;
}

export interface PluginProjectServiceOptions {
  /** 内核工作区服务（`kernel.workspaces`）；缺席时每个方法如实拒绝 */
  readonly workspaces?: WorkspaceService | null;
  /** 内核 IO（`kernel.io`）；源文件与 `build/` 的字节读写都经它（写闸照常生效） */
  readonly io?: FileIO | null;
  /** 启动器宿主桥（只探 `launcher_project_hash` / `launcher_project_extract` 两条） */
  readonly host?: LauncherHostBridge | null;
  /** 插件管理器（`planInstall` 与「已装插件的提取」读它；缺席即如实拒绝） */
  readonly plugins?: PluginManager | null;
  /** 实例库（只读取 adapter / gameId / gameRoot；不写游戏目录） */
  readonly getInstance?: (instanceId: string) => Promise<LauncherInstance | null>;
  /** adapter 的插件规则（模板 / 根清单；缺席 = 允许的根取实例声明的 contentRoots） */
  readonly pluginRulesOf?: (adapterId: string) => GamePluginRules | undefined;
  readonly now?: () => number;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 纯工具（路径 / glob / 规范化文本）
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 绝对路径的父目录（纯字符串；不解析符号链接） */
function parentOf(abs: string): string {
  const idx = Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'));
  return idx <= 0 ? abs : abs.slice(0, idx);
}

function posixJoin(...parts: readonly string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    for (const seg of part.split('/')) {
      if (seg === '' || seg === '.') continue;
      out.push(seg);
    }
  }
  return out.join('/');
}

/** 绝对路径差出相对 POSIX 路径（`walkDir` 输出 → 包内路径那一侧） */
function relPosix(baseAbs: string, abs: string): string {
  const rel = abs.slice(baseAbs.length).replace(/^[\\/]+/, '');
  return rel.split(/[\\/]+/).filter((s) => s !== '').join('/');
}

/** 单层目录段校验（项目 id / 制品目录名；拒绝分隔符 / 点段 / 空串 / 盘符 / UNC） */
function assertSegment(value: string, what: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    isAbsolute(value)
  ) {
    fail(
      'LAUNCHER_PLUGIN_PROJECT_INVALID',
      `${what}不合法：「${String(value)}」只能是一个目录名（不能带路径分隔符、不能是空名或点段）。`,
    );
  }
  return value;
}

/** 相对目录守卫（`roots[].from` / `to`）：复用 ZIP 条目闸那一套字面规则 */
function assertRelDir(value: string, what: string): string {
  const problem = zipEntryContractProblem(value, Number.MAX_SAFE_INTEGER);
  if (problem !== null) {
    fail('LAUNCHER_PLUGIN_PROJECT_INVALID', `${what}不是合法的项目内相对路径：「${value}」（${problem}）`);
  }
  if (value.endsWith('/')) {
    fail('LAUNCHER_PLUGIN_PROJECT_INVALID', `${what}不能以分隔符结尾：「${value}」`);
  }
  return value;
}

function assertRelativeFile(value: string, what: string): string {
  const problem = zipEntryContractProblem(value, ZIP_EXTRACT_LIMITS.maxDepth);
  if (problem !== null) {
    fail('LAUNCHER_PLUGIN_PROJECT_INVALID', `${what}不是合法的项目内相对路径：「${value}」（${problem}）`);
  }
  return value;
}

function assertPluginId(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < PLUGIN_ID_MIN ||
    value.length > PLUGIN_ID_MAX ||
    !PLUGIN_ID_RE.test(value)
  ) {
    fail(
      'LAUNCHER_PLUGIN_PROJECT_INVALID',
      `插件 id 不合法：「${String(value)}」（要求 ${PLUGIN_ID_MIN}–${PLUGIN_ID_MAX} 位，字符集 [a-z0-9._-]，且不以 - 或 . 开头结尾）。`,
    );
  }
  return value;
}

function assertVersion(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('LAUNCHER_PLUGIN_PROJECT_INVALID', '版本不能为空。');
  }
  if (/[\s\\/:*?"<>|]/.test(value)) {
    fail('LAUNCHER_PLUGIN_PROJECT_INVALID', `版本不能含空白或路径分隔符：「${value}」`);
  }
  return value;
}

function fail(code: Parameters<typeof launcherError>[0], message: string, detail?: string): never {
  throw launcherError(code, { message, ...(detail === undefined ? {} : { detail }) });
}

/** 简单 glob（`*` 单段、`**` 跨段、`?` 单字符）；够 `include/exclude` 用，不引第三方 */
export function globMatch(pattern: string, value: string): boolean {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$+.[\]{}()|'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`${out}$`, 'i').test(value);
}

function isDocFile(rel: string): boolean {
  const name = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
  return /^(readme|license|licence|changelog|copying)(\..*)?$/.test(name);
}

/** `workspaceRoot` 比同一目录的两种写法（大小写 / 尾分隔符） */
function isSameDir(a: string, b: string): boolean {
  return isPathUnder(a, b) && isPathUnder(b, a);
}

/** 源清单的**规范文本**（固定键序：同一份清单永远序列化成同一串） */
export function canonicalManifestText(manifest: PluginSourceManifest): string {
  const ordered: Record<string, unknown> = {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    kind: manifest.kind,
    gameId: manifest.gameId,
    capabilities: manifest.capabilities,
    loadOrder: manifest.loadOrder,
  };
  for (const key of ['gameVersion', 'apiVersion', 'requires', 'conflicts', 'author', 'license', 'homepage', 'description', 'saveImpact', 'entrypoints'] as const) {
    const value = manifest[key];
    if (value !== undefined) ordered[key] = value;
  }
  ordered.roots = manifest.roots.map((root) => {
    const out: Record<string, unknown> = { rootId: root.rootId, from: root.from };
    if (root.to !== undefined && root.to !== '') out.to = root.to;
    if (root.include !== undefined) out.include = root.include;
    if (root.exclude !== undefined) out.exclude = root.exclude;
    return out;
  });
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** 制品清单（`pack.json`）的规范文本（键序固定；`files[]` 已按路径排序） */
export function canonicalPackText(manifest: ContentPackManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 源清单校验（创建后自证、构建前权威校验、提取的项目再校验，同一条）
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface SourceManifestExpect {
  /** 必须与项目 / 实例的 gameId 一致 */
  readonly gameId?: string | null;
  /** 允许的根 id 全集（adapter 的 pluginRules.roots 或实例 contentRoots） */
  readonly rootIds?: readonly string[] | null;
}

/** 逐条问题（空数组 = 合法）；自证闭环与测试都直接读它 */
export function sourceManifestProblems(
  raw: unknown,
  expect: SourceManifestExpect = {},
): string[] {
  const problems: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return ['清单必须是 JSON 对象'];
  }
  const o = raw as Record<string, unknown>;

  // 手写哈希 = 非法（防伪造验收：安装门禁只信构建时算出的 pack.json）
  const forbidden: string[] = [];
  const scan = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => scan(item, `${path}[${i}]`));
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'files' || key === 'sha256') forbidden.push(`${path === '' ? '' : `${path}.`}${key}`);
      scan(child, `${path === '' ? '' : `${path}.`}${key}`);
    }
  };
  scan(o, '');
  if (forbidden.length > 0) {
    problems.push(`源清单不许手写哈希 / 文件清单（出现在 ${forbidden.join('、')}）——哈希只在构建时算`);
  }

  if (o.schemaVersion !== 1) problems.push('schemaVersion 必须是字面量 1');
  if (typeof o.id !== 'string' || o.id.length < PLUGIN_ID_MIN || o.id.length > PLUGIN_ID_MAX || !PLUGIN_ID_RE.test(o.id)) {
    problems.push(`id 不合法（要求 ${PLUGIN_ID_MIN}–${PLUGIN_ID_MAX} 位、字符集 [a-z0-9._-]、不以 - 或 . 开头结尾）`);
  }
  if (typeof o.name !== 'string' || o.name.trim().length === 0) problems.push('name 不能为空');
  if (typeof o.version !== 'string' || o.version.trim().length === 0) {
    problems.push('version 不能为空');
  } else if (/[\s\\/:*?"<>|]/.test(o.version)) {
    problems.push(`version 不能含空白或路径分隔符：「${o.version}」`);
  }
  if (o.kind !== 'plugin') problems.push("kind 必须是 'plugin'（内容包没有源码项目形态）");
  if (typeof o.gameId !== 'string' || o.gameId.trim().length === 0) problems.push('gameId 不能为空');
  else if (expect.gameId != null && o.gameId !== expect.gameId) {
    problems.push(`gameId「${o.gameId}」与项目 / 实例的「${expect.gameId}」不一致`);
  }
  if (!Array.isArray(o.capabilities) || o.capabilities.length === 0) {
    problems.push('capabilities 至少一项（缺省按最保守的 add-content）');
  } else {
    for (const cap of o.capabilities) {
      if (typeof cap !== 'string' || !CAPABILITIES.has(cap)) problems.push(`未知能力：${String(cap)}`);
    }
  }
  if (typeof o.loadOrder !== 'number' || !Number.isFinite(o.loadOrder)) problems.push('loadOrder 必须是数字');
  if (o.saveImpact !== undefined && (typeof o.saveImpact !== 'string' || !SAVE_IMPACTS.has(o.saveImpact))) {
    problems.push(`saveImpact 只能是 none / possible / unknown（收到 ${String(o.saveImpact)}）`);
  }
  if (o.entrypoints !== undefined) {
    if (!Array.isArray(o.entrypoints)) problems.push('entrypoints 必须是数组');
    else {
      for (const ep of o.entrypoints) {
        if (typeof ep !== 'string' || zipEntryContractProblem(ep) !== null) {
          problems.push(`entrypoints 里的路径不合法：「${String(ep)}」`);
        }
      }
    }
  }

  if (!Array.isArray(o.roots) || o.roots.length === 0) {
    problems.push('roots 至少一条映射');
  } else {
    const allowed = expect.rootIds ?? null;
    o.roots.forEach((rawRoot, index) => {
      const where = `roots[${index}]`;
      if (typeof rawRoot !== 'object' || rawRoot === null) {
        problems.push(`${where} 必须是对象`);
        return;
      }
      const root = rawRoot as Record<string, unknown>;
      if (typeof root.rootId !== 'string' || root.rootId.trim().length === 0) {
        problems.push(`${where}.rootId 不能为空`);
      } else if (allowed !== null && !allowed.includes(root.rootId)) {
        problems.push(`${where}.rootId「${root.rootId}」不在允许的根（${allowed.join('、') || '无'}）里`);
      }
      if (typeof root.from !== 'string' || root.from.length === 0) {
        problems.push(`${where}.from 不能为空`);
      } else if (root.from.endsWith('/') || zipEntryContractProblem(root.from, Number.MAX_SAFE_INTEGER) !== null) {
        problems.push(`${where}.from 不是合法的相对目录：「${root.from}」`);
      }
      if (root.to !== undefined && typeof root.to !== 'string') {
        problems.push(`${where}.to 必须是字符串`);
      } else if (typeof root.to === 'string' && root.to.length > 0 && (root.to.endsWith('/') || zipEntryContractProblem(root.to, Number.MAX_SAFE_INTEGER) !== null)) {
        problems.push(`${where}.to 不是合法的相对目录：「${root.to}」`);
      }
      for (const key of ['include', 'exclude'] as const) {
        const value = root[key];
        if (value === undefined) continue;
        if (!Array.isArray(value) || value.some((g) => typeof g !== 'string' || g.length === 0)) {
          problems.push(`${where}.${key} 必须是非空字符串数组`);
        }
      }
    });
  }
  return problems;
}

/** 校验并**窄化**成 `PluginSourceManifest`（不合法直接抛结构化错误，不返回半份） */
export function parseSourceManifest(raw: unknown, expect: SourceManifestExpect = {}): PluginSourceManifest {
  const problems = sourceManifestProblems(raw, expect);
  if (problems.length > 0) {
    fail(
      'LAUNCHER_PLUGIN_PROJECT_INVALID',
      '插件源清单不合法，已拒绝。',
      problems.map((p, i) => `${i + 1}) ${p}`).join('；'),
    );
  }
  return raw as PluginSourceManifest;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 实现
 * ══════════════════════════════════════════════════════════════════════════════ */

export class PluginProjectServiceImpl implements PluginProjectService {
  private readonly workspaces: WorkspaceService | null;
  private readonly io: FileIO | null;
  private readonly host: LauncherHostBridge | null;
  private readonly plugins: PluginManager | null;
  private readonly getInstance: ((instanceId: string) => Promise<LauncherInstance | null>) | null;
  private readonly pluginRulesOf: ((adapterId: string) => GamePluginRules | undefined) | null;
  private readonly now: () => number;

  constructor(options: PluginProjectServiceOptions = {}) {
    this.workspaces = options.workspaces ?? null;
    this.io = options.io ?? null;
    this.host = options.host ?? null;
    this.plugins = options.plugins ?? null;
    this.getInstance = options.getInstance ?? null;
    this.pluginRulesOf = options.pluginRulesOf ?? null;
    this.now = options.now ?? (() => Date.now());
  }

  /* ------------------------------ 列表面 ------------------------------ */

  async list(): Promise<readonly PluginProject[]> {
    const ws = this.requireWorkspaces();
    const projects = await ws.list();
    const out: PluginProject[] = [];
    for (const project of projects) {
      const meta = readMeta(project.meta);
      if (meta === null) continue; // 不是插件项目（口上项目等）——静默跳过是分类，不是吞错
      const loaded = await this.loadFromWorkspace(project, meta, ws);
      out.push(toView(loaded));
    }
    return out;
  }

  async get(projectId: string): Promise<PluginProject | null> {
    const loaded = await this.loadOrNull(projectId);
    return loaded === null ? null : toView(loaded);
  }

  /** 首版恒一条；留成方法是为了让消费方不必自己拆 `artifacts[0]`（契约外的便利位） */
  async artifact(projectId: string): Promise<PluginProjectArtifact> {
    const project = await this.requireProject(projectId);
    const artifact = project.artifacts[0];
    if (artifact === undefined) {
      fail('LAUNCHER_PLUGIN_PROJECT_INVALID', `项目 ${projectId} 没有插件制品（项目结构不完整）。`);
    }
    return artifact;
  }

  /* ------------------------------ 创建 ------------------------------ */

  async create(input: PluginProjectCreateInput): Promise<PluginProject> {
    const ws = this.requireWorkspaces();
    const io = this.requireIo();
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length === 0) fail('LAUNCHER_PLUGIN_PROJECT_INVALID', '项目名不能为空。');
    const pluginId = assertPluginId(input.pluginId);
    const version = assertVersion(input.version);
    const artifactDirName = assertSegment(
      input.artifactDirName ?? DEFAULT_PLUGIN_ARTIFACT_DIR,
      '制品目录名',
    );
    const capabilities = [...new Set(input.capabilities ?? [])];
    if (capabilities.length === 0) {
      fail('LAUNCHER_PLUGIN_PROJECT_INVALID', '至少声明一项能力（capabilities 为空等于没有声明能不能做的事）。');
    }
    for (const cap of capabilities) {
      if (!CAPABILITIES.has(cap)) {
        fail('LAUNCHER_PLUGIN_PROJECT_INVALID', `未知能力：${String(cap)}`);
      }
    }
    const saveImpact = input.saveImpact ?? 'unknown';
    if (!SAVE_IMPACTS.has(saveImpact)) {
      fail('LAUNCHER_PLUGIN_PROJECT_INVALID', `saveImpact 只能是 none / possible / unknown（收到 ${String(saveImpact)}）`);
    }
    if (typeof input.displayName !== 'string' || input.displayName.trim().length === 0) {
      fail('LAUNCHER_PLUGIN_PROJECT_INVALID', '显示名不能为空。');
    }
    const roots = normalizeRootMaps(input.roots);
    if (roots.length === 0) {
      fail('LAUNCHER_PLUGIN_PROJECT_INVALID', '至少给一条根映射（roots）：没有映射就没有任何文件能进包。');
    }

    // ADR-0010 决策 6：目录解析前必须先扫一遍（自选授权根里的项目靠 list 填缓存）
    await this.list();
    const rootsNow = ws.roots();
    if (input.workspaceRoot !== undefined) {
      if (!rootsNow.some((r) => isSameDir(r, input.workspaceRoot!))) {
        fail(
          'LAUNCHER_PLUGIN_PROJECT_INVALID',
          `项目位置未获得授权：${input.workspaceRoot}（只能在默认工作区或「自选…」对话框里选定的文件夹内新建）`,
        );
      }
    }

    const instance = await this.requireInstance(input.instanceId);
    const rules = this.pluginRulesOf?.(instance.adapterId);
    const allowedRootIds = (rules?.roots ?? instance.contentRoots).map((r) => r.id);
    for (const root of roots) {
      if (!allowedRootIds.includes(root.rootId)) {
        fail(
          'LAUNCHER_PLUGIN_PROJECT_INVALID',
          `根 id「${root.rootId}」不在该游戏声明的根里（可选：${allowedRootIds.join('、') || '无'}）。`,
        );
      }
    }

    const existing = (await this.list()).find((p) =>
      p.artifacts.some((a) => a.pluginId === pluginId),
    );
    if (existing !== undefined) {
      fail(
        'LAUNCHER_PLUGIN_PROJECT_EXISTS',
        `同一工作区里已有插件 id「${pluginId}」的项目：${existing.name}`,
        existing.projectId,
      );
    }

    // 模板先算（纯生成、不写盘）：给不出骨架就在这里失败，不留下半个项目
    const scaffold = await this.scaffoldFor(input, instance, rules);
    const entrypoints = entrypointsOf(scaffold, roots[0]!.from);

    const manifest = buildSourceManifest(input, version, capabilities, saveImpact, roots, entrypoints, instance);
    parseSourceManifest(manifest, { gameId: instance.gameId, rootIds: allowedRootIds });

    const meta = {
      kind: PLUGIN_PROJECT_KIND,
      adapterId: instance.adapterId,
      gameId: instance.gameId,
      gameVersion: null, // `LauncherInstance` 没有版本字段（缺口 2），如实留空
      targetInstanceId: instance.id,
      lastBuild: null,
      installedTarget: null,
      source: 'created',
    } satisfies ProjectMetaRaw;

    const project = await ws.create({
      name,
      meta: meta as unknown as Record<string, unknown>,
      ...(input.workspaceRoot === undefined ? {} : { rootDir: input.workspaceRoot }),
    });
    const projectDir = ws.projectDir(project.id);

    const written: string[] = [];
    const createdDirs: string[] = [];
    let artifactId: string | null = null;
    try {
      const manifestRel = join(artifactDirName, PLUGIN_SOURCE_MANIFEST_FILE);
      const artifact = await ws.createArtifact(project.id, {
        name,
        dirName: artifactDirName,
        files: { [PLUGIN_SOURCE_MANIFEST_FILE]: canonicalManifestText(manifest) },
        meta: { kind: 'plugin', pluginId, template: input.template },
      });
      artifactId = artifact.id;
      written.push(join(projectDir, manifestRel));

      // 模板文件：adapter 的 `scaffold` 优先（整块顶替内置），路径逐条守卫、不得覆盖清单
      for (const [rel, text] of Object.entries(scaffold.files)) {
        const safe = assertRelativeFile(normalizeScaffoldPath(rel), '模板文件路径');
        if (safe === PLUGIN_SOURCE_MANIFEST_FILE) {
          fail('LAUNCHER_PLUGIN_PROJECT_INVALID', '模板不得生成 plugin.json（清单由本服务按向导输入生成，避免双真源）。');
        }
        written.push(await this.writeProjectText(ws, io, project.id, projectDir, join(artifactDirName, safe), text, createdDirs));
      }
      for (const [rel, bytes] of Object.entries(scaffold.binaryFiles ?? {})) {
        const safe = assertRelativeFile(normalizeScaffoldPath(rel), '模板二进制路径');
        if (safe === PLUGIN_SOURCE_MANIFEST_FILE) {
          fail('LAUNCHER_PLUGIN_PROJECT_INVALID', '模板不得生成 plugin.json。');
        }
        const abs = join(projectDir, artifactDirName, safe);
        await io.ensureDir(parentOf(abs));
        await io.writeBytes(abs, bytes);
        written.push(abs);
      }

      await ws.writeText(project.id, '.gitignore', PLUGIN_PROJECT_GITIGNORE);
      written.push(join(projectDir, '.gitignore'));
      const buildDir = join(projectDir, 'build');
      await io.ensureDir(buildDir);
      createdDirs.push(buildDir);

      // 自证闭环：刚写下的清单必须能被**同一个校验器**接受
      const back = await ws.readText(project.id, manifestRel);
      parseSourceManifest(JSON.parse(back.text), { gameId: instance.gameId, rootIds: allowedRootIds });
    } catch (err) {
      await this.failWithRollback(err, project.id, written, createdDirs, artifactId, projectDir);
    }

    return this.requireProject(project.id);
  }

  /* ------------------------------ 改名 / 删除 / 目录 ------------------------------ */

  async update(projectId: string, patch: { readonly name?: string }): Promise<PluginProject> {
    const ws = this.requireWorkspaces();
    await this.load(projectId); // 存在性 + 类型 + 写落点复验
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.length === 0) fail('LAUNCHER_PLUGIN_PROJECT_INVALID', '项目名不能为空。');
      await ws.update(projectId, { name });
    }
    return this.requireProject(projectId);
  }

  async remove(projectId: string): Promise<void> {
    const ws = this.requireWorkspaces();
    await this.load(projectId); // 先解析出真实目录，再删（外部根里的项目未 list 会回落默认根）
    await ws.remove(projectId);
  }

  async projectDir(projectId: string): Promise<string> {
    const loaded = await this.load(projectId);
    return loaded.projectDir;
  }

  /* ------------------------------ 构建 ------------------------------ */

  async build(projectId: string, opts: PluginBuildOptions = {}): Promise<PluginBuildResult> {
    const ws = this.requireWorkspaces();
    const io = this.requireIo();
    const loaded = await this.load(projectId);
    const manifest = loaded.manifest;
    if (manifest === null) {
      fail('LAUNCHER_PLUGIN_PROJECT_INVALID', `项目 ${projectId} 缺少 ${PLUGIN_SOURCE_MANIFEST_FILE}，无法构建。`);
    }
    const allowedRootIds = (this.pluginRulesOf?.(loaded.meta.adapterId)?.roots ?? []).map((r) => r.id);
    parseSourceManifest(manifest, {
      gameId: loaded.meta.gameId,
      rootIds: allowedRootIds.length === 0 ? null : allowedRootIds,
    });

    const version = assertVersion(opts.version ?? manifest.version);
    const warnings: string[] = [];
    const collected = await this.collect(loaded, manifest, opts, warnings);
    if (collected.length === 0) {
      fail('LAUNCHER_PLUGIN_BUILD_FAILED', '没有任何文件命中 roots 映射，拒绝产出一个空包。');
    }
    if (collected.length > ZIP_EXTRACT_LIMITS.maxEntries) {
      fail(
        'LAUNCHER_PLUGIN_BUILD_FAILED',
        `待打包文件数 ${collected.length} 超过平台限额 ${ZIP_EXTRACT_LIMITS.maxEntries}，拒绝出包。`,
      );
    }
    const artifactRels = collected.map((f) => f.artifactRel);
    const absPaths = collected.map((f) => join(loaded.projectDir, loaded.artifactDirName, f.artifactRel));

    const buildDir = join(loaded.projectDir, 'build');
    const stagingDir = join(buildDir, 'staging');
    let zipPath: string | null = null;
    let reportPath: string | null = null;

    try {
      // [5] 逐文件摘要（宿主流式；不整包读进 JS）
      const digests = await this.digestFiles(loaded.projectDir, loaded.artifactDirName, artifactRels);
      const missing = artifactRels.filter((rel) => !digests.has(rel));
      if (missing.length > 0) {
        fail(
          'LAUNCHER_PLUGIN_BUILD_FAILED',
          '宿主没有返回全部文件的摘要，构建中止。',
          `缺摘要：${missing.slice(0, 5).join('、')}${missing.length > 5 ? ' …' : ''}`,
        );
      }
      const bytes = await io.readBytesMany(absPaths);

      const files: ContentFileEntry[] = [];
      const zipEntries: Array<{ name: string; data: Uint8Array }> = [];
      let totalBytes = 0;
      for (let i = 0; i < collected.length; i++) {
        const file = collected[i]!;
        const digest = digests.get(file.artifactRel)!;
        const data = bytes[i];
        if (data === null || data === undefined) {
          fail('LAUNCHER_PLUGIN_BUILD_FAILED', `读不到源文件：${file.artifactRel}`);
        }
        if (data.length !== digest.size) {
          fail(
            'LAUNCHER_PLUGIN_BUILD_FAILED',
            `源文件在摘要与打包之间被改动：${file.artifactRel}`,
            `摘要声明 ${digest.size} 字节，实际读到 ${data.length} 字节`,
          );
        }
        totalBytes += data.length;
        if (totalBytes > ZIP_EXTRACT_LIMITS.maxUnpackedBytes) {
          fail(
            'LAUNCHER_PLUGIN_BUILD_FAILED',
            `打包内容超过体积限额（${ZIP_EXTRACT_LIMITS.maxUnpackedBytes} 字节），拒绝出包。`,
          );
        }
        files.push({ rootId: file.rootId, path: file.target, sha256: digest.sha256, size: digest.size });
        zipEntries.push({ name: file.zipPath, data });
      }
      // [4] 同一 rootId 下同一目标路径被两条映射命中 ⇒ 失败（上一步已查重）；这里的排序是
      // **确定性的一环**：`buildZip` 只按收到顺序落盘，排序必须由消费侧做。
      files.sort((a, b) => comparePosix(`${a.rootId}/${a.path}`, `${b.rootId}/${b.path}`));
      zipEntries.sort((a, b) => comparePosix(a.name, b.name));

      const pack: ContentPackManifest = buildPackManifest(manifest, version, files, collected, warnings);
      // [7] 暂存 pack.json → 用它自己的 sha256 当 `buildId`（规范文本 + 逐文件摘要都在里面，
      // 与构建时间无关；同内容两次构建得到同一个 id）
      await io.ensureDir(stagingDir);
      const stagingPack = join(stagingDir, 'pack.json');
      await io.writeText(stagingPack, canonicalPackText(pack));
      const packDigests = await this.digestFiles(loaded.projectDir, 'build', ['staging/pack.json']);
      const packDigest = packDigests.get('staging/pack.json');
      if (packDigest === undefined) {
        fail('LAUNCHER_PLUGIN_BUILD_FAILED', '宿主没有返回 pack.json 的摘要，构建中止。');
      }
      const buildId = packDigest.sha256;
      // buildId 会直接变成报告文件名：形态必须收窄，否则宿主的坏读数能把报告写到 build/ 之外
      if (!/^[0-9a-f]{32,64}$/i.test(buildId)) {
        fail(
          'LAUNCHER_PLUGIN_BUILD_FAILED',
          '宿主返回的 pack.json 摘要形态非法，构建中止。',
          `buildId=${String(buildId).slice(0, 80)}`,
        );
      }

      // [8] 确定性打包：pack.json 与全部文件一起，按 POSIX 路径排序、固定时间戳
      const zipBytes = await buildZip(
        [{ name: 'pack.json', data: utf8(canonicalPackText(pack)) }, ...zipEntries],
        { contract: 'extractable', date: FIXED_ZIP_DATE() },
      );

      // [8b] 复核：摘要与打包必须是同一批字节（两次摘要不一致 ⇒ 中途被改过）
      const recheck = await this.digestFiles(loaded.projectDir, loaded.artifactDirName, artifactRels);
      for (const rel of artifactRels) {
        if (recheck.get(rel)?.sha256 !== digests.get(rel)?.sha256) {
          fail(
            'LAUNCHER_PLUGIN_BUILD_FAILED',
            `源文件在构建过程中被改动：${rel}`,
            '两次摘要不一致；请重试，产物未落盘。',
          );
        }
      }

      const zipName = zipFileName(manifest.id, version, warnings);
      zipPath = join(buildDir, zipName);
      await io.ensureDir(buildDir);
      await io.writeBytes(zipPath, zipBytes);

      // ZIP 自身的哈希同样由宿主算（本层没有第二份 SHA-256 实现）
      const zipDigests = await this.digestFiles(loaded.projectDir, 'build', [zipName]);
      const zipDigest = zipDigests.get(zipName);
      if (zipDigest === undefined) {
        fail('LAUNCHER_PLUGIN_BUILD_FAILED', '宿主没有返回产物的摘要，构建中止。');
      }

      const sourceFingerprint = await this.fingerprintOf(loaded, manifest);
      const builtAt = new Date(this.now()).toISOString();
      const summary: PluginBuildSummary = {
        buildId,
        version,
        bytes: zipDigest.size,
        sha256: zipDigest.sha256,
        sourceFingerprint,
        builtAt,
      };

      // [9] 报告最后写（失败不会留下一份指向不存在 ZIP 的报告）
      reportPath = join(buildDir, `${buildId}.json`);
      await io.writeText(
        reportPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            buildId,
            pluginId: manifest.id,
            version,
            builtAt,
            sourceFingerprint,
            zip: { file: zipName, bytes: zipDigest.size, sha256: zipDigest.sha256 },
            manifest: pack,
            sourceFiles: collected.map((f) => ({ path: f.artifactRel, zipPath: f.zipPath })),
            warnings,
          },
          null,
          2,
        )}\n`,
      );

      await this.patchMeta(ws, projectId, { lastBuild: summary });

      return {
        buildId,
        zipPath,
        reportPath,
        manifest: pack,
        bytes: zipDigest.size,
        sha256: zipDigest.sha256,
        sourceFingerprint,
        warnings,
        builtAt,
      };
    } catch (err) {
      // 构建失败清理半截产物：先删报告、再删 ZIP、最后清暂存（倒序）
      for (const path of [reportPath, zipPath]) {
        if (path === null) continue;
        try {
          await io.removeFile(path);
        } catch {
          /* 半截产物本来就可能没写出来；清理失败不掩盖真因 */
        }
      }
      try {
        await io.removeDir(stagingDir);
      } catch {
        /* 同上 */
      }
      if (isLauncherError(err)) throw err;
      throw normalizeLauncherError(err, {
        fallbackCode: 'LAUNCHER_PLUGIN_BUILD_FAILED',
        detail: '构建中止（产物已清理）',
      });
    }
  }

  /** 「构建并安装」前半段：build + `plugins.planInstall`（一次调用内完成，避免中间被改） */
  async planInstall(
    projectId: string,
    instanceId: string,
    opts: PluginBuildOptions = {},
  ): Promise<PluginProjectInstallPlan> {
    const plugins = this.requirePlugins();
    const loaded = await this.load(projectId);
    const instance = await this.requireInstance(instanceId);
    if (loaded.manifest !== null && loaded.manifest.gameId !== instance.gameId) {
      fail(
        'LAUNCHER_PLUGIN_INCOMPATIBLE',
        `插件面向的游戏「${loaded.manifest.gameId}」与实例「${instance.gameId}」不一致，拒绝安装。`,
      );
    }
    const build = await this.build(projectId, opts);
    try {
      const plan = await plugins.planInstall(instanceId, build.zipPath, {});
      return { build, plan };
    } catch (err) {
      throw normalizeLauncherError(err, {
        fallbackCode: 'LAUNCHER_PLUGIN_CONFLICT',
        detail: `已构建 ${build.buildId}，安装预检失败`,
      });
    }
  }

  /* ------------------------------ 提取 ------------------------------ */

  /**
   * 把**已安装插件**提取成源码项目（§10.5.6）：只复制 `ownedFiles`，逐文件字节级写入。
   *
   * 读侧用 `io.readBytes`（实例根可读，写侧仍是工作区常驻可写根）；
   * 本层不写实例、不碰游戏目录里的其他文件。
   */
  async extract(
    instanceId: string,
    pluginId: string,
    opts: PluginExtractOptions = {},
  ): Promise<PluginProject> {
    const plugins = this.requirePlugins();
    const ws = this.requireWorkspaces();
    assertPluginId(pluginId);
    await this.list();
    const instance = await this.requireInstance(instanceId);
    const installed = (await plugins.list(instanceId)).find((p) => p.manifest.id === pluginId);
    if (installed === undefined) {
      fail(
        'LAUNCHER_PLUGIN_PROJECT_INVALID',
        `实例 ${instanceId} 里没有安装插件「${pluginId}」，没有可提取的内容。`,
      );
    }
    const files = installed.ownedFiles ?? [];
    if (files.length === 0) {
      fail('LAUNCHER_PLUGIN_EXTRACT_FAILED', `插件「${pluginId}」没有登记任何归属文件，无法提取。`);
    }
    // 归属路径闸先行：坏路径（.. / 绝对 / 盘符 / UNC / 反斜杠 / ADS）在**建项目之前**就拒绝，
    // 不让它进到清单生成那一步（那时错误会变成「清单不合法」，说不清是哪个文件）
    for (const ref of files) {
      const problem = zipEntryContractProblem(ref.path, ZIP_EXTRACT_LIMITS.maxDepth);
      if (problem !== null) {
        fail(
          'LAUNCHER_PLUGIN_EXTRACT_FAILED',
          `插件登记的文件路径非法，已拒绝提取：${ref.rootId}/${ref.path}`,
          problem,
        );
      }
      if (!instance.contentRoots.some((root) => root.id === ref.rootId)) {
        fail(
          'LAUNCHER_PLUGIN_EXTRACT_FAILED',
          `插件登记的内容根不在实例里：${ref.rootId}（${ref.path}）`,
        );
      }
    }

    const rootsNow = ws.roots();
    if (opts.workspaceRoot !== undefined && !rootsNow.some((r) => isSameDir(r, opts.workspaceRoot!))) {
      fail('LAUNCHER_PLUGIN_PROJECT_INVALID', `项目位置未获得授权：${opts.workspaceRoot}`);
    }

    const groupIds = [...new Set(files.map((f) => f.rootId))].sort();
    const manifest = manifestFromInstalled(installed.manifest, groupIds, files);
    parseSourceManifest(manifest, {
      gameId: instance.gameId,
      rootIds: instance.contentRoots.map((root) => root.id),
    });

    const name = (opts.projectName ?? `${installed.manifest.name}（提取）`).trim();
    if (name.length === 0) fail('LAUNCHER_PLUGIN_PROJECT_INVALID', '项目名不能为空。');
    const meta: ProjectMetaRaw = {
      kind: PLUGIN_PROJECT_KIND,
      adapterId: instance.adapterId,
      gameId: instance.gameId,
      gameVersion: null,
      targetInstanceId: instance.id,
      lastBuild: null,
      installedTarget: null,
      source: 'extracted',
      extractedFrom: {
        instanceId,
        pluginId,
        version: installed.manifest.version,
        at: new Date(this.now()).toISOString(),
      },
    };

    return this.materializeProject({
      name,
      meta,
      manifest,
      refs: files,
      workspaceRoot: opts.workspaceRoot,
      readFile: async (ref) => this.readInstalledFile(instance, ref),
    });
  }

  /**
   * 把**压缩包**反解成源码项目（附加能力，契约尚无对应成员）。
   *
   * **本包不解 zip**：解包、路径闸与限额全在宿主的 `archive_guard` 语义里；本层只拿
   * 暂存目录的逐条目读数，做第二道路径 / 符号链接 / 限额闸，然后按 `{rootId}/{path}`
   * 重新分组写进工作区。
   */
  async extractArchive(
    archivePath: string,
    opts: PluginExtractOptions & { readonly instanceId?: string; readonly adapterId?: string } = {},
  ): Promise<PluginProject> {
    if (typeof archivePath !== 'string' || archivePath.trim().length === 0 || archivePath.includes('\0')) {
      fail('LAUNCHER_ARCHIVE_INVALID', '没有给出有效的压缩包路径。');
    }
    const host = this.projectExtractHost();
    if (host === null) {
      fail(
        'LAUNCHER_PLATFORM_UNSUPPORTED',
        '当前平台未提供把压缩包解成源码项目的能力。',
        '宿主未提供 launcher_project_extract（本层不解 zip，暂存与解包守卫必须由宿主完成）',
      );
    }
    let staged: HostProjectExtractResult;
    try {
      staged = await host.projectExtract(archivePath, { limits: ZIP_EXTRACT_LIMITS });
    } catch (err) {
      throw normalizeLauncherError(err, {
        fallbackCode: 'LAUNCHER_PLUGIN_EXTRACT_FAILED',
        detail: `解包失败：${archivePath}`,
      });
    }

    const entries = staged.entries ?? [];
    if (entries.length > ZIP_EXTRACT_LIMITS.maxEntries) {
      fail(
        'LAUNCHER_ARCHIVE_LIMIT',
        `包内条目数 ${entries.length} 超过上限 ${ZIP_EXTRACT_LIMITS.maxEntries}，已中止提取。`,
      );
    }
    let total = 0;
    const files: Array<{ ref: ContentFileRef; stagedPath: string }> = [];
    for (const entry of entries) {
      const problem = zipEntryContractProblem(entry.path, ZIP_EXTRACT_LIMITS.maxDepth);
      if (problem !== null) {
        fail(
          'LAUNCHER_PLUGIN_EXTRACT_FAILED',
          `包内条目路径非法，已中止提取：${entry.path}`,
          problem,
        );
      }
      if (entry.kind !== 'file') {
        fail(
          'LAUNCHER_PLUGIN_EXTRACT_FAILED',
          `包内条目不是普通文件（${entry.kind}），已中止提取：${entry.path}`,
          '首版只提取普通文件：符号链接 / 目录条目一律拒绝',
        );
      }
      total += Math.max(0, entry.size);
      if (total > ZIP_EXTRACT_LIMITS.maxUnpackedBytes) {
        fail(
          'LAUNCHER_ARCHIVE_LIMIT',
          `解压总字节超过上限 ${ZIP_EXTRACT_LIMITS.maxUnpackedBytes}，已中止提取。`,
        );
      }
      const slash = entry.path.indexOf('/');
      if (slash <= 0 || slash === entry.path.length - 1) {
        fail(
          'LAUNCHER_PLUGIN_EXTRACT_FAILED',
          `包内条目必须是 {rootId}/{path} 形态：${entry.path}`,
        );
      }
      files.push({
        ref: { rootId: entry.path.slice(0, slash), path: entry.path.slice(slash + 1) },
        stagedPath: entry.path,
      });
    }
    if (files.length === 0) {
      fail('LAUNCHER_PLUGIN_EXTRACT_FAILED', '压缩包里没有可提取的文件。');
    }

    const instance = opts.instanceId === undefined ? null : await this.requireInstance(opts.instanceId);
    const groupIds = [...new Set(files.map((f) => f.ref.rootId))].sort();
    const manifest = manifestFromPack(staged.manifest, groupIds, files.map((f) => f.ref));
    parseSourceManifest(manifest, {
      gameId: staged.manifest.gameId,
      rootIds: null,
    });
    const adapterId = opts.adapterId ?? instance?.adapterId ?? '';
    const meta: ProjectMetaRaw = {
      kind: PLUGIN_PROJECT_KIND,
      adapterId,
      gameId: staged.manifest.gameId,
      gameVersion: staged.manifest.gameVersion ?? null,
      targetInstanceId: instance?.id ?? null,
      lastBuild: null,
      installedTarget: null,
      source: 'extracted',
    };
    const stagingDir = staged.stagingDir;
    return this.materializeProject({
      name: (opts.projectName ?? `${staged.manifest.name}（提取）`).trim(),
      meta,
      manifest,
      refs: files.map((f) => f.ref),
      workspaceRoot: opts.workspaceRoot,
      readFile: async (ref) => {
        const entry = files.find((f) => f.ref.rootId === ref.rootId && f.ref.path === ref.path);
        if (entry === undefined) throw new Error(`包内没有这个条目：${ref.rootId}/${ref.path}`);
        const abs = join(stagingDir, entry.stagedPath);
        if (!isPathUnder(stagingDir, abs)) {
          throw new Error(`暂存条目越出了暂存目录：${entry.stagedPath}`);
        }
        return this.io!.readBytes(abs);
      },
    });
  }

  /* ------------------------------ 漂移 ------------------------------ */

  async inspectDrift(projectId: string, instanceId: string): Promise<PluginProjectDrift> {
    const plugins = this.requirePlugins();
    const loaded = await this.load(projectId);
    const manifest = loaded.manifest;
    if (manifest === null) {
      fail('LAUNCHER_PLUGIN_PROJECT_INVALID', `项目 ${projectId} 缺少 ${PLUGIN_SOURCE_MANIFEST_FILE}，无法判定漂移。`);
    }
    await this.requireInstance(instanceId);
    const fingerprint = await this.fingerprintOf(loaded, manifest);
    const last = loaded.meta.lastBuild;
    const installed = (await plugins.list(instanceId)).find((p) => p.manifest.id === manifest.id) ?? null;

    if (installed === null) {
      return {
        state: 'not-installed',
        sourceVersion: manifest.version,
        lastBuildVersion: last?.version ?? null,
        installedVersion: null,
        reasons: [`实例 ${instanceId} 里没有安装插件「${manifest.id}」`],
      };
    }

    const sourceReasons: string[] = [];
    if (last === null) {
      sourceReasons.push('这个项目还没有构建过（没有上次构建记录）');
    } else {
      if (last.version !== manifest.version) {
        sourceReasons.push(`源版本 ${manifest.version} 与上次构建 ${last.version} 不同`);
      }
      if (last.sourceFingerprint !== fingerprint) {
        sourceReasons.push('源文件在上次构建之后被改动（源指纹不一致）');
      }
    }
    if (sourceReasons.length > 0) {
      return {
        state: 'source-changed',
        sourceVersion: manifest.version,
        lastBuildVersion: last?.version ?? null,
        installedVersion: installed.manifest.version,
        reasons: sourceReasons,
      };
    }

    const installedReasons: string[] = [];
    if (installed.manifest.version !== last!.version) {
      installedReasons.push(
        `实例里装的版本 ${installed.manifest.version} 与上次构建 ${last!.version} 不同`,
      );
    }
    if (installed.sourceProjectId !== null && installed.sourceProjectId !== projectId) {
      installedReasons.push(`实例里这个插件是由项目 ${installed.sourceProjectId} 安装的，不是本项目`);
    }
    if (installedReasons.length > 0) {
      return {
        state: 'installed-differs',
        sourceVersion: manifest.version,
        lastBuildVersion: last!.version,
        installedVersion: installed.manifest.version,
        reasons: installedReasons,
      };
    }
    return {
      state: 'in-sync',
      sourceVersion: manifest.version,
      lastBuildVersion: last!.version,
      installedVersion: installed.manifest.version,
      reasons: [],
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 内部：项目装载与视图
   * ══════════════════════════════════════════════════════════════════════════ */

  private requireWorkspaces(): WorkspaceService {
    if (this.workspaces === null) {
      fail(
        'LAUNCHER_PLATFORM_UNSUPPORTED',
        '插件项目管理需要工作区服务。',
        '缺少 kernel.workspaces（本服务不造第二套项目存储）',
      );
    }
    return this.workspaces;
  }

  private requireIo(): FileIO {
    if (this.io === null) {
      fail('LAUNCHER_PLATFORM_UNSUPPORTED', '插件项目读写需要内核 IO。', '缺少 kernel.io');
    }
    return this.io;
  }

  private requirePlugins(): PluginManager {
    if (this.plugins === null) {
      fail('LAUNCHER_PLATFORM_UNSUPPORTED', '该操作需要启动器的插件管理面。', '缺少 launcher.plugins');
    }
    return this.plugins;
  }

  private async requireInstance(instanceId: string): Promise<LauncherInstance> {
    if (this.getInstance === null) {
      fail('LAUNCHER_PLATFORM_UNSUPPORTED', '该操作需要实例库。', '缺少实例库（组合根未接 getInstance）');
    }
    const instance = await this.getInstance(instanceId);
    if (instance === null) {
      fail('LAUNCHER_INSTANCE_NOT_FOUND', `找不到实例：${instanceId}`);
    }
    return instance;
  }

  private async loadOrNull(projectId: string): Promise<LoadedProject | null> {
    const ws = this.requireWorkspaces();
    assertSegment(projectId, '项目 id');
    await ws.list(); // ADR-0010 决策 6：解析目录前必须先扫一遍
    const workspace = await ws.get(projectId);
    if (workspace === null) return null;
    const meta = readMeta(workspace.meta);
    if (meta === null) return null;
    return this.loadFromWorkspace(workspace, meta, ws);
  }

  private async load(projectId: string): Promise<LoadedProject> {
    const loaded = await this.loadOrNull(projectId);
    if (loaded === null) {
      fail('LAUNCHER_PLUGIN_PROJECT_INVALID', `找不到这个插件项目：${projectId}`);
    }
    return loaded;
  }

  private async requireProject(projectId: string): Promise<PluginProject> {
    const loaded = await this.load(projectId);
    return toView(loaded);
  }

  private async loadFromWorkspace(
    workspace: WorkspaceProject,
    meta: ProjectMetaRaw,
    ws: WorkspaceService,
  ): Promise<LoadedProject> {
    const projectDir = ws.projectDir(workspace.id);
    // 前缀复验（本层做一次，判据来自 kernel.workspaces 的 roots()）：
    // 项目目录必须落在某个**已登记**的工作区根内，否则一律拒绝写
    if (!ws.roots().some((root) => isPathUnder(root, projectDir))) {
      fail(
        'LAUNCHER_PATH_ESCAPE',
        `插件项目目录不在任何已授权的工作区根内，已拒绝：${projectDir}`,
        `roots: ${ws.roots().join('、')}`,
      );
    }
    const artifactDirName = assertSegment(
      workspace.artifacts[0]?.dirName ?? DEFAULT_PLUGIN_ARTIFACT_DIR,
      '制品目录名',
    );
    let manifestText: string | null = null;
    let manifest: PluginSourceManifest | null = null;
    try {
      const file = await ws.readText(workspace.id, join(artifactDirName, PLUGIN_SOURCE_MANIFEST_FILE));
      manifestText = file.text;
      manifest = JSON.parse(file.text) as PluginSourceManifest;
    } catch {
      // 清单缺失 / 损坏：列表仍然要能列出这个项目（面板要能提示「项目结构不完整」），
      // 构建 / 漂移这类必须读清单的动作各自抛错，不在这里吞掉
      manifest = null;
    }
    return { workspace, projectDir, artifactDirName, manifest, manifestText, meta };
  }

  /** 项目元数据整体回写（只存指针；`workspaces.update` 的 `meta` 是整替语义） */
  private async patchMeta(
    ws: WorkspaceService,
    projectId: string,
    patch: Partial<ProjectMetaRaw>,
  ): Promise<void> {
    const workspace = await ws.get(projectId);
    if (workspace === null) {
      fail('LAUNCHER_PLUGIN_PROJECT_INVALID', `写入项目元数据时找不到项目：${projectId}`);
    }
    await ws.update(projectId, { meta: { ...workspace.meta, ...patch } });
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 内部：创建 / 提取共用的落盘 + 回滚
   * ══════════════════════════════════════════════════════════════════════════ */

  private async scaffoldFor(
    input: PluginProjectCreateInput,
    instance: LauncherInstance,
    rules: GamePluginRules | undefined,
  ): Promise<PluginScaffoldResult> {
    const options = {
      template: input.template,
      pluginId: input.pluginId,
      displayName: input.displayName,
      gameId: instance.gameId,
      capabilities: [...input.capabilities],
      gameVersion: null as string | null,
    };
    if (rules?.scaffold !== undefined) {
      try {
        return await rules.scaffold(options);
      } catch (err) {
        throw normalizeLauncherError(err, {
          fallbackCode: 'LAUNCHER_PLUGIN_PROJECT_INVALID',
          detail: `模板 ${input.template} 生成失败`,
        });
      }
    }
    // adapter 没有 scaffold ⇒ 用本包的游戏无关内置模板（保证「新建即能构建」）
    return builtinTemplate(options, normalizeRootMaps(input.roots)[0]?.from ?? 'src');
  }

  /** 写一段项目内文本（绝对路径由 projects 目录拼出；先 ensureDir 再写） */
  private async writeProjectText(
    ws: WorkspaceService,
    io: FileIO,
    projectId: string,
    projectDir: string,
    relPath: string,
    text: string,
    createdDirs: string[],
  ): Promise<string> {
    const rel = assertRelativeFile(relPath, '模板文件路径');
    const abs = join(projectDir, rel);
    if (!isPathUnder(projectDir, abs)) {
      fail('LAUNCHER_PATH_ESCAPE', `模板文件越出了项目目录：${relPath}`);
    }
    const parent = parentOf(abs);
    if (parent.length > projectDir.length) {
      await io.ensureDir(parent);
      createdDirs.push(parent);
    }
    await ws.writeText(projectId, rel, text);
    return abs;
  }

  /**
   * 按本次写入清单倒序回滚（ADR-0010 决策 5）。
   *
   * **不调 `workspaces.remove` 当回滚**：那是「连同目录全部内容删除」，
   * 会把用户在失败后已手动放进项目的东西一起删掉。这里只删**本批写出的路径**，
   * 项目目录只在「除本批产物外空无一物」时才整目录清掉。
   */
  private async rollback(
    projectId: string,
    written: readonly string[],
    createdDirs: readonly string[],
    artifactId: string | null,
    projectDir: string,
  ): Promise<string[]> {
    const ws = this.workspaces;
    const io = this.io;
    if (ws === null || io === null) return [];
    const leftovers: string[] = [];
    for (const path of [...written].reverse()) {
      try {
        await io.removeFile(path);
      } catch {
        leftovers.push(path);
      }
    }
    if (artifactId !== null) {
      try {
        await ws.removeArtifact(projectId, artifactId);
      } catch (err) {
        leftovers.push(`制品登记（${artifactId}）：${String(err)}`);
      }
    }
    for (const dir of [...createdDirs].reverse()) {
      try {
        await io.removeDir(dir);
      } catch {
        /* 空目录删不掉不算残留，下方只报文件 */
      }
    }
    // 项目目录：只有当它只剩 workspace.json / .gitignore / build 这三样本批写出的东西时才清掉
    try {
      const entries = await io.listDir(projectDir);
      const ours = new Set(['workspace.json', '.gitignore', 'build']);
      if (entries.every((e) => ours.has(e.name))) {
        await io.removeFile(join(projectDir, 'workspace.json')).catch(() => undefined);
        await io.removeDir(projectDir).catch(() => undefined);
      } else {
        leftovers.push(`项目目录里仍有非本批内容：${entries.map((e) => e.name).join('、')}`);
      }
    } catch {
      /* 目录读不到就不猜 */
    }
    return leftovers;
  }

  /** 失败收尾：先按清单回滚，再把「原始错误 + 残留」一起抛出来（回滚失败不静默） */
  private async failWithRollback(
    err: unknown,
    projectId: string,
    written: readonly string[],
    createdDirs: readonly string[],
    artifactId: string | null,
    projectDir: string,
  ): Promise<never> {
    const leftovers = await this.rollback(projectId, written, createdDirs, artifactId, projectDir);
    const base = isLauncherError(err)
      ? (err as ReturnType<typeof launcherError>)
      : normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_PLUGIN_PROJECT_INVALID' });
    if (leftovers.length === 0) throw base;
    throw launcherError(base.code, {
      message: base.message,
      detail: `${base.detail === undefined ? '' : `${base.detail} · `}回滚残留：${leftovers.join('、')}`,
      retryable: base.retryable,
    });
  }

  /** 创建空项目 + 制品 + 逐文件写入 + 收尾（create / extract / extractArchive 共用） */
  private async materializeProject(input: {
    readonly name: string;
    readonly meta: ProjectMetaRaw;
    readonly manifest: PluginSourceManifest;
    /** 要写入的归属文件（按 `rootId/path` 定位；字节由 `readFile` 取） */
    readonly refs: readonly ContentFileRef[];
    readonly workspaceRoot?: string;
    readonly readFile: (ref: ContentFileRef) => Promise<Uint8Array>;
  }): Promise<PluginProject> {
    const ws = this.requireWorkspaces();
    const io = this.requireIo();
    const name = input.name.length === 0 ? '（提取）' : input.name;
    const project = await ws.create({
      name,
      meta: input.meta as unknown as Record<string, unknown>,
      ...(input.workspaceRoot === undefined ? {} : { rootDir: input.workspaceRoot }),
    });
    const projectDir = ws.projectDir(project.id);
    const artifactDirName = DEFAULT_PLUGIN_ARTIFACT_DIR;
    const written: string[] = [];
    const createdDirs: string[] = [];
    let artifactId: string | null = null;
    try {
      const artifact = await ws.createArtifact(project.id, {
        name: input.manifest.name,
        dirName: artifactDirName,
        files: {},
        meta: { kind: 'plugin', pluginId: input.manifest.id },
      });
      artifactId = artifact.id;
      for (const ref of input.refs) {
        const rel = assertRelativeFile(`${artifactDirName}/content/${ref.rootId}/${ref.path}`, '提取文件路径');
        const abs = join(projectDir, rel);
        if (!isPathUnder(projectDir, abs)) {
          fail('LAUNCHER_PATH_ESCAPE', `提取文件越出了项目目录：${ref.rootId}/${ref.path}`);
        }
        const bytes = await input.readFile(ref);
        await io.ensureDir(parentOf(abs));
        await io.writeBytes(abs, bytes);
        written.push(abs);
      }
      const manifestRel = join(artifactDirName, PLUGIN_SOURCE_MANIFEST_FILE);
      await ws.writeText(project.id, manifestRel, canonicalManifestText(input.manifest));
      written.push(join(projectDir, manifestRel));
      await ws.writeText(project.id, '.gitignore', PLUGIN_PROJECT_GITIGNORE);
      written.push(join(projectDir, '.gitignore'));
      const buildDir = join(projectDir, 'build');
      await io.ensureDir(buildDir);
      createdDirs.push(buildDir);
      const back = await ws.readText(project.id, manifestRel);
      parseSourceManifest(JSON.parse(back.text), { gameId: input.manifest.gameId, rootIds: null });
    } catch (err) {
      await this.failWithRollback(err, project.id, written, createdDirs, artifactId, projectDir);
    }
    return this.requireProject(project.id);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 内部：构建
   * ══════════════════════════════════════════════════════════════════════════ */

  private projectHashHost(): ProjectHashHost | null {
    const candidate = this.host as unknown as Record<string, unknown> | null;
    if (candidate === null) return null;
    return typeof candidate.projectHash === 'function' ? (this.host as unknown as ProjectHashHost) : null;
  }

  private projectExtractHost(): ProjectExtractHost | null {
    const candidate = this.host as unknown as Record<string, unknown> | null;
    if (candidate === null) return null;
    return typeof candidate.projectExtract === 'function'
      ? (this.host as unknown as ProjectExtractHost)
      : null;
  }

  /** 宿主逐文件摘要（缺失该命令时如实拒绝，不降级成「算不出来就跳过」） */
  private async digestFiles(
    projectDir: string,
    artifactDir: string,
    entries: readonly string[],
  ): Promise<Map<string, HostFileDigest>> {
    const host = this.projectHashHost();
    if (host === null) {
      fail(
        'LAUNCHER_PLATFORM_UNSUPPORTED',
        '当前平台未提供构建所需的文件摘要能力。',
        '宿主未提供 launcher_project_hash（逐文件流式摘要；本层不算第二份 SHA-256）',
      );
    }
    let raw: readonly HostFileDigest[];
    try {
      raw = await host.projectHash({ projectDir, artifactDir, entries });
    } catch (err) {
      throw normalizeLauncherError(err, {
        fallbackCode: 'LAUNCHER_PLUGIN_BUILD_FAILED',
        detail: 'launcher_project_hash 失败',
      });
    }
    const map = new Map<string, HostFileDigest>();
    for (const digest of raw) {
      if (typeof digest.path !== 'string' || typeof digest.sha256 !== 'string' || digest.sha256.length === 0) {
        continue;
      }
      map.set(digest.path.replaceAll('\\', '/'), digest);
    }
    return map;
  }

  /** 按 `roots[]` 收集待打包文件（路径守卫 / include-exclude / 目标冲突都在这里） */
  private async collect(
    loaded: LoadedProject,
    manifest: PluginSourceManifest,
    opts: PluginBuildOptions,
    warnings: string[],
  ): Promise<CollectedFile[]> {
    const io = this.requireIo();
    const collected: CollectedFile[] = [];
    const seenTargets = new Map<string, string>();
    const allInArtifact = new Set<string>();

    const artifactAbs = join(loaded.projectDir, loaded.artifactDirName);
    try {
      const walkedAll = await io.walkDir(artifactAbs, { includeFiles: true });
      for (const entry of walkedAll) {
        if (!entry.isDirectory) allInArtifact.add(`${loaded.artifactDirName}/${relPosix(artifactAbs, entry.path)}`);
      }
    } catch {
      /* 未打包文件清单是加分项：列不到就不报，不影响构建 */
    }

    for (const map of manifest.roots) {
      const from = assertRelDir(map.from, '根映射的源目录');
      const to = map.to === undefined ? '' : map.to.length === 0 ? '' : assertRelDir(map.to, '根映射的目标目录');
      const fromAbs = join(loaded.projectDir, loaded.artifactDirName, from);
      if (!isPathUnder(loaded.projectDir, fromAbs)) {
        fail('LAUNCHER_PATH_ESCAPE', `根映射越出了项目目录：${from}`);
      }
      const stat = await io.stat(fromAbs);
      if (stat === null || !stat.isDirectory) {
        fail('LAUNCHER_PLUGIN_PROJECT_INVALID', `根映射的源目录不存在或不是目录：${from}`);
      }
      const walked = await io.walkDir(fromAbs, { includeFiles: true });
      for (const entry of walked) {
        if (entry.isDirectory) continue;
        const rel = relPosix(fromAbs, entry.path);
        if (rel.length === 0) continue;
        if (map.include !== undefined && map.include.length > 0 && !map.include.some((g) => globMatch(g, rel))) {
          continue;
        }
        if (map.exclude !== undefined && map.exclude.some((g) => globMatch(g, rel))) continue;
        const target = posixJoin(to, rel);
        const problem = zipEntryContractProblem(target);
        if (problem !== null) {
          fail(
            'LAUNCHER_PLUGIN_PROJECT_INVALID',
            `映射出的目标路径非法，构建中止：${target}`,
            `${problem}（来源 ${from}/${rel}）`,
          );
        }
        if (opts.includeDocs === false && isDocFile(rel)) continue;
        if (
          opts.exclude !== undefined &&
          opts.exclude.some((g) => globMatch(g, rel) || globMatch(g, target))
        ) {
          continue;
        }
        const artifactRel = posixJoin(from, rel);
        const key = `${map.rootId}\u0000${target.toLowerCase()}`;
        const previous = seenTargets.get(key);
        if (previous !== undefined) {
          fail(
            'LAUNCHER_PLUGIN_BUILD_FAILED',
            `同一个根里两个源文件映射到了同一个目标路径，拒绝隐式覆盖：${map.rootId}/${target}`,
            `来源：${previous} 与 ${artifactRel}`,
          );
        }
        seenTargets.set(key, artifactRel);
        collected.push({
          artifactRel,
          rootId: map.rootId,
          target,
          zipPath: `${map.rootId}/${target}`,
          fromAbs: entry.path,
        });
      }
    }

    // 未打包文件：作者「明明放了却没生效」的静默失败，构建结果里必须列出来
    for (const rel of allInArtifact) {
      const insideArtifact = rel.startsWith(`${loaded.artifactDirName}/`)
        ? rel.slice(loaded.artifactDirName.length + 1)
        : rel;
      if (insideArtifact === PLUGIN_SOURCE_MANIFEST_FILE) continue;
      if (collected.some((f) => f.artifactRel === insideArtifact)) continue;
      warnings.push(`未打包文件：${insideArtifact}（不在任何 roots 映射里）`);
    }
    return collected;
  }

  /** 源指纹：规范清单文本 + 映射文件 `(路径, size, mtimeMs)`（不重算内容哈希） */
  private async fingerprintOf(
    loaded: LoadedProject,
    manifest: PluginSourceManifest,
  ): Promise<string> {
    const io = this.requireIo();
    const stamps: FileStamp[] = [];
    for (const map of manifest.roots) {
      const fromAbs = join(loaded.projectDir, loaded.artifactDirName, map.from);
      let walked: Awaited<ReturnType<FileIO['walkDir']>> = [];
      try {
        walked = await io.walkDir(fromAbs, { includeFiles: true, withMetadata: true });
      } catch {
        stamps.push({ path: `${map.from}/?`, mtimeMs: null, size: null });
        continue;
      }
      for (const entry of walked) {
        if (entry.isDirectory) continue;
        const rel = `${loaded.artifactDirName}/${relPosix(fromAbs, entry.path)}`;
        let mtimeMs = entry.mtimeMs ?? null;
        let size = entry.size ?? null;
        if (mtimeMs === null || size === null) {
          const stat = await io.stat(entry.path);
          mtimeMs = stat?.mtimeMs ?? null;
          size = stat?.size ?? null;
        }
        stamps.push({ path: rel, mtimeMs, size });
      }
    }
    const stampDigest =
      projectFingerprintOf(stamps) ??
      foldDigest(stamps.map((s) => `${s.path}\u0000${s.size ?? '?'}\u0000${s.mtimeMs ?? '?'}`));
    return stableHash(`${canonicalManifestText(manifest)}\u0000${stampDigest}`);
  }

  /** 从实例根读一个归属文件（路径闸 + 缺失判定；不写实例） */
  private async readInstalledFile(instance: LauncherInstance, ref: ContentFileRef): Promise<Uint8Array> {
    const io = this.requireIo();
    const problem = zipEntryContractProblem(ref.path, ZIP_EXTRACT_LIMITS.maxDepth);
    if (problem !== null) {
      fail(
        'LAUNCHER_PLUGIN_EXTRACT_FAILED',
        `插件登记的文件路径非法，已拒绝提取：${ref.path}`,
        problem,
      );
    }
    const spec = instance.contentRoots.find((root) => root.id === ref.rootId);
    if (spec === undefined) {
      fail(
        'LAUNCHER_PLUGIN_EXTRACT_FAILED',
        `插件登记的内容根不在实例里：${ref.rootId}`,
      );
    }
    if (typeof spec.relativePath !== 'string' || isAbsolute(spec.relativePath) || spec.relativePath.split(/[\\/]/).includes('..')) {
      fail('LAUNCHER_PATH_ESCAPE', `实例的内容根路径非法：${ref.rootId}`);
    }
    const abs = join(instance.gameRoot, spec.relativePath, ref.path);
    if (!isPathUnder(instance.gameRoot, abs)) {
      fail('LAUNCHER_PATH_ESCAPE', `归属文件越出了实例的游戏根：${ref.rootId}/${ref.path}`);
    }
    const stat = await io.stat(abs);
    if (stat === null) {
      fail(
        'LAUNCHER_PLUGIN_EXTRACT_FAILED',
        `已装插件的文件缺失，提取中止：${ref.rootId}/${ref.path}`,
      );
    }
    if (stat.isDirectory) {
      fail(
        'LAUNCHER_PLUGIN_EXTRACT_FAILED',
        `归属路径不是普通文件（符号链接 / 目录），拒绝提取：${ref.rootId}/${ref.path}`,
      );
    }
    return io.readBytes(abs);
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 视图 / 清单构造（纯函数）
 * ══════════════════════════════════════════════════════════════════════════════ */

function readMeta(raw: Record<string, unknown>): ProjectMetaRaw | null {
  if (raw === null || typeof raw !== 'object') return null;
  if (raw.kind !== PLUGIN_PROJECT_KIND) return null;
  if (typeof raw.adapterId !== 'string' || typeof raw.gameId !== 'string') return null;
  const extracted = raw.extractedFrom;
  const extractedFrom =
    typeof extracted === 'object' &&
    extracted !== null &&
    typeof (extracted as Record<string, unknown>).instanceId === 'string' &&
    typeof (extracted as Record<string, unknown>).pluginId === 'string' &&
    typeof (extracted as Record<string, unknown>).version === 'string' &&
    typeof (extracted as Record<string, unknown>).at === 'string'
      ? (extracted as NonNullable<PluginProjectMeta['extractedFrom']>)
      : undefined;
  return {
    kind: PLUGIN_PROJECT_KIND,
    adapterId: raw.adapterId,
    gameId: raw.gameId,
    gameVersion: typeof raw.gameVersion === 'string' ? raw.gameVersion : null,
    targetInstanceId: typeof raw.targetInstanceId === 'string' ? raw.targetInstanceId : null,
    lastBuild: isBuildSummary(raw.lastBuild) ? raw.lastBuild : null,
    installedTarget: isInstalledRef(raw.installedTarget) ? raw.installedTarget : null,
    ...(extractedFrom === undefined ? {} : { extractedFrom }),
    ...(raw.source === 'extracted' || raw.source === 'created' ? { source: raw.source } : {}),
  };
}

function isBuildSummary(value: unknown): value is PluginBuildSummary {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.buildId === 'string' &&
    typeof v.version === 'string' &&
    typeof v.bytes === 'number' &&
    typeof v.sha256 === 'string' &&
    typeof v.sourceFingerprint === 'string' &&
    typeof v.builtAt === 'string'
  );
}

function isInstalledRef(value: unknown): value is PluginInstalledRef {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.instanceId === 'string' &&
    typeof v.pluginId === 'string' &&
    typeof v.version === 'string' &&
    typeof v.installedAt === 'string' &&
    (v.buildSha256 === null || typeof v.buildSha256 === 'string')
  );
}

function toView(loaded: LoadedProject): PluginProject {
  const manifest = loaded.manifest;
  const artifacts: PluginProjectArtifact[] = loaded.workspace.artifacts.map((artifact: WorkspaceArtifact) => ({
    artifactId: artifact.id,
    dirName: artifact.dirName,
    pluginId: manifest?.id ?? '',
    version: manifest?.version ?? '',
    capabilities: manifest?.capabilities ?? [],
    manifestPath: posixJoin(artifact.dirName, PLUGIN_SOURCE_MANIFEST_FILE),
  }));
  const meta: PluginProjectMeta = {
    kind: PLUGIN_PROJECT_KIND,
    adapterId: loaded.meta.adapterId,
    gameId: loaded.meta.gameId,
    gameVersion: loaded.meta.gameVersion,
    targetInstanceId: loaded.meta.targetInstanceId,
    lastBuild: loaded.meta.lastBuild,
    installedTarget: loaded.meta.installedTarget,
    ...(loaded.meta.extractedFrom === undefined ? {} : { extractedFrom: loaded.meta.extractedFrom }),
  };
  return {
    projectId: loaded.workspace.id,
    name: loaded.workspace.name,
    rootDir: join(loaded.projectDir, '..'),
    projectDir: loaded.projectDir,
    meta,
    source: loaded.meta.source ?? (loaded.meta.extractedFrom === undefined ? 'created' : 'extracted'),
    artifacts,
    lastBuild: loaded.meta.lastBuild,
    installedTarget: loaded.meta.installedTarget,
  };
}

function normalizeRootMaps(roots: readonly PluginSourceRootMap[] | undefined): PluginSourceRootMap[] {
  if (!Array.isArray(roots)) return [];
  const out: PluginSourceRootMap[] = [];
  for (const raw of roots) {
    if (typeof raw !== 'object' || raw === null) {
      fail('LAUNCHER_PLUGIN_PROJECT_INVALID', 'roots 里有一条不是对象。');
    }
    const rootId = typeof raw.rootId === 'string' ? raw.rootId.trim() : '';
    if (rootId.length === 0) fail('LAUNCHER_PLUGIN_PROJECT_INVALID', 'roots[].rootId 不能为空。');
    const from = assertRelDir(typeof raw.from === 'string' ? raw.from : '', 'roots[].from');
    const to = raw.to === undefined ? '' : raw.to.length === 0 ? '' : assertRelDir(raw.to, 'roots[].to');
    out.push({
      rootId,
      from,
      ...(to === '' ? {} : { to }),
      ...(raw.include === undefined ? {} : { include: raw.include }),
      ...(raw.exclude === undefined ? {} : { exclude: raw.exclude }),
    });
  }
  return out;
}

function buildSourceManifest(
  input: PluginProjectCreateInput,
  version: string,
  capabilities: readonly PluginCapability[],
  saveImpact: 'none' | 'possible' | 'unknown',
  roots: readonly PluginSourceRootMap[],
  entrypoints: readonly string[],
  instance: LauncherInstance,
): PluginSourceManifest {
  const optional: Record<string, unknown> = {};
  if (input.author !== undefined) optional.author = input.author;
  if (input.license !== undefined) optional.license = input.license;
  if (input.homepage !== undefined) optional.homepage = input.homepage;
  if (input.description !== undefined) optional.description = input.description;
  return {
    schemaVersion: 1,
    id: input.pluginId,
    name: input.displayName,
    version,
    kind: 'plugin',
    gameId: instance.gameId,
    capabilities,
    loadOrder: Number.isFinite(input.loadOrder) ? input.loadOrder : 0,
    ...(entrypoints.length === 0 ? {} : { entrypoints }),
    saveImpact,
    ...(optional as { author?: string; license?: string; homepage?: string; description?: string }),
    roots,
  };
}

function entrypointsOf(scaffold: PluginScaffoldResult, rootFrom: string): string[] {
  const files = Object.keys(scaffold.files ?? {}).sort();
  const entry = files.find((path) => !isDocFile(path) && !path.endsWith('.md'));
  if (entry === undefined) return [];
  // adapter 的 scaffold 直接给制品相对路径；内置模板也已把 `rootFrom/` 前缀算进去
  void rootFrom;
  return [entry.replaceAll('\\', '/')];
}

function normalizeScaffoldPath(path: string): string {
  return posixJoin(path.replaceAll('\\', '/'));
}

function buildPackManifest(
  source: PluginSourceManifest,
  version: string,
  files: ContentFileEntry[],
  collected: readonly CollectedFile[],
  warnings: string[],
): ContentPackManifest {
  const refs: ContentFileRef[] = [];
  for (const entry of source.entrypoints ?? []) {
    const artifactRel = posixJoin(entry);
    const hit = collected.find((file) => file.artifactRel === artifactRel);
    if (hit === undefined) {
      fail(
        'LAUNCHER_PLUGIN_PROJECT_INVALID',
        `entrypoints 指向的文件不在任何根映射的产出里：${entry}`,
        '入口指向不存在的文件等于装完不生效，构建拒绝出包。',
      );
    }
    refs.push({ rootId: hit.rootId, path: hit.target });
  }
  const pack: ContentPackManifest = {
    schemaVersion: 1,
    id: source.id,
    name: source.name,
    version,
    kind: 'plugin',
    gameId: source.gameId,
    files,
    loadOrder: source.loadOrder,
    ...(source.requires === undefined ? {} : { requires: source.requires }),
    ...(source.conflicts === undefined ? {} : { conflicts: source.conflicts }),
    ...(source.author === undefined ? {} : { author: source.author }),
    ...(source.license === undefined ? {} : { license: source.license }),
    ...(source.homepage === undefined ? {} : { homepage: source.homepage }),
    ...(source.description === undefined ? {} : { description: source.description }),
    capabilities: source.capabilities,
    ...(source.gameVersion === undefined ? {} : { gameVersion: source.gameVersion }),
    ...(source.apiVersion === undefined ? {} : { apiVersion: source.apiVersion }),
    ...(source.saveImpact === undefined ? {} : { saveImpact: source.saveImpact }),
    ...(refs.length === 0 ? {} : { entrypoints: refs }),
  };
  if (files.length === 0) warnings.push('包内没有任何文件（只有 pack.json）');
  return pack;
}

function zipFileName(pluginId: string, version: string, warnings: string[]): string {
  const raw = `${pluginId}-${version}.zip`;
  if (zipContainerNameProblem(raw) === null) return raw;
  const base = `${pluginId}-${version}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '');
  const trimmed = (base.slice(0, ZIP_CONTAINER_NAME_MAX - 4) || 'plugin').replace(/[.-]+$/, '');
  const name = `${trimmed}.zip`;
  if (zipContainerNameProblem(name) !== null) {
    fail('LAUNCHER_PLUGIN_BUILD_FAILED', `无法从「${pluginId}-${version}」派生合法的产物文件名。`);
  }
  warnings.push(`产物文件名已规范化：${raw} → ${name}`);
  return name;
}

/** 位置比较（POSIX 路径按码元序；不用 `localeCompare`——它会随系统语言变） */
function comparePosix(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function isLauncherError(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && typeof v.message === 'string' && typeof v.retryable === 'boolean';
}

/** 已装插件 → 源清单（`roots[]` 按 rootId 重排，`entrypoints` 能反算的反算，不能的留空 + 警告） */
function manifestFromInstalled(
  pack: ContentPackManifest,
  rootIds: readonly string[],
  owned: readonly ContentFileRef[],
): PluginSourceManifest {
  const roots: PluginSourceRootMap[] = rootIds.map((rootId) => ({
    rootId,
    from: `content/${rootId}`,
  }));
  const entrypoints: string[] = [];
  for (const ref of pack.entrypoints ?? []) {
    if (!rootIds.includes(ref.rootId)) continue;
    if (!owned.some((f) => f.rootId === ref.rootId && f.path === ref.path)) continue;
    entrypoints.push(`content/${ref.rootId}/${ref.path}`);
  }
  return {
    schemaVersion: 1,
    id: pack.id,
    name: pack.name,
    version: pack.version,
    kind: 'plugin',
    gameId: pack.gameId,
    capabilities: pack.capabilities ?? ['add-content'],
    loadOrder: pack.loadOrder,
    ...(entrypoints.length === 0 ? {} : { entrypoints }),
    saveImpact: pack.saveImpact ?? 'unknown',
    ...(pack.gameVersion === undefined ? {} : { gameVersion: pack.gameVersion }),
    ...(pack.apiVersion === undefined ? {} : { apiVersion: pack.apiVersion }),
    ...(pack.requires === undefined ? {} : { requires: pack.requires }),
    ...(pack.conflicts === undefined ? {} : { conflicts: pack.conflicts }),
    ...(pack.author === undefined ? {} : { author: pack.author }),
    ...(pack.license === undefined ? {} : { license: pack.license }),
    ...(pack.homepage === undefined ? {} : { homepage: pack.homepage }),
    ...(pack.description === undefined ? {} : { description: pack.description }),
    roots,
  };
}

function manifestFromPack(
  pack: ContentPackManifest,
  rootIds: readonly string[],
  refs: readonly ContentFileRef[],
): PluginSourceManifest {
  return manifestFromInstalled(pack, rootIds, refs);
}
