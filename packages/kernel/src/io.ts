import type {
  BackupVersion,
  DirEntry,
  FileEncoding,
  FileIO,
  FileStat,
  Logger,
  PlatformBridge,
  TextFile,
  WalkOptions,
  WriteTextOptions,
} from '@kojo/plugin-api';
import { WriteNotAllowedError } from '@kojo/plugin-api';
import { applyEol, detectEol, normalizeEol, probeEncoding } from './encoding';
import { basename, isPathUnder, join, pathKey } from '@kojo/plugin-api';

/**
 * 文件 IO 服务实现。
 *
 * 安全模型（架构文档 §3.4 "游戏目录整体只读假设"）：
 * - 写路径白名单：默认空（一切拒绝）；项目打开并由用户批准后 setWritableRoots 放行；
 * - 越权写入抛 WriteNotAllowedError——写保护是内核级不变量，不依赖调用方自觉；
 * - 写前自动备份（{appDataDir}/backup/，按文件保留最近 N 版）+ 原子写（平台桥保证）；
 * - 编码保持：读时探测并缓存，写时默认 'preserve'（一次保存毁半库是历史教训）；
 * - **双闸并存**（v0.2 第十四批，审阅 M3）：本层白名单是第一道闸（判定域 = 用户批准的
 *   writablePaths，是项目根的子集）；Tauri 宿主 Rust 侧另有写允许域第二道闸
 *   （判定域 = 项目根整体 + appDataDir，project.opened 注册 / project.closed 清除）。
 *   两闸语义以更严者为准；本层契约与行为不变。
 */

const BACKUP_KEEP_PER_FILE = 20;

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/** 备份版本文件名（timestamp() 的唯一合法形态；列举与恢复都按此认，别放宽） */
export const BACKUP_VERSION_RE = /^\d{8}-\d{6}-\d{3}\.bak$/;

/** 备份桶目录段名（backup() 的落点；哈希段才是身份，前缀只是人读便利） */
export function backupBucketName(absPath: string): string {
  return `${basename(absPath).slice(0, 40).replace(/[^A-Za-z0-9._-]/g, '_')}-${backupHashOf(absPath)}`;
}

/**
 * 文件 → 备份桶哈希（身份尺：`pathKey` 折叠大小写与分隔符）。
 * 列举/恢复**按哈希后缀找桶**而不是重拼段名——写侧段名取的是当时的 basename 原样，
 * 同一个文件 "事件.ERB / 事件.erb" 两种写法会落进两个前缀；只认哈希才读得回全部版本。
 */
export function backupHashOf(absPath: string): string {
  return fnv1a(pathKey(absPath));
}

/** 从版本文件名解析本地时刻（ms）；形态不对返回 null（判据不猜） */
export function parseBackupTakenAtMs(id: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})\.bak$/.exec(id);
  if (!m) return null;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    Number(m[7]),
  );
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export class FileIOServiceImpl implements FileIO {
  private writableRoots: string[] = [];
  /** 应用自有常驻可写根（工作区等；不受 setWritableRoots([]) 收回影响） */
  private appWritableRoots: string[] = [];
  private readonly encodingCache = new Map<string, FileEncoding>();
  private readonly eolCache = new Map<string, 'crlf' | 'lf'>();

  constructor(
    private readonly bridge: PlatformBridge,
    private readonly log?: Logger,
  ) {}

  /* ------------------------------ 读 ------------------------------ */

  async readText(path: string): Promise<TextFile> {
    // 读字节与 stat **互不依赖**：一起发出，别再串行等一个 RTT（§5.117）。
    // 冷开一次要读 6,855 个文件（抽取 2,285 + 逐文件校验 4,570），每次都白等一趟。
    const bytesCall = this.bridge.readFileBytes(path);
    const statCall = this.bridge.stat(path);
    // 给 stat 分支一个"已处理"的落点，免得它在读路先失败时变成 unhandled rejection；
    // 真正的异常仍由下面 await 抛出，语义与串行版一致（不吞错）。
    statCall.catch(() => {});
    const bytes = await bytesCall;
    const encoding = probeEncoding(bytes);
    const raw = await this.bridge.decode(bytes, encoding);
    const eol = detectEol(raw);
    const text = normalizeEol(raw);
    this.encodingCache.set(pathKey(path), encoding);
    this.eolCache.set(pathKey(path), eol);
    const st = await statCall;
    return { path, text, encoding, eol, mtimeMs: st?.mtimeMs ?? null };
  }

  readBytes(path: string): Promise<Uint8Array> {
    return this.bridge.readFileBytes(path);
  }

  /* ------------------------------ 写 ------------------------------ */

  async writeText(path: string, text: string, opts?: WriteTextOptions): Promise<void> {
    this.assertWritable(path);

    const key = pathKey(path);
    let encoding: FileEncoding;
    if (opts?.encoding && opts.encoding !== 'preserve') {
      encoding = opts.encoding;
    } else {
      encoding = this.encodingCache.get(key) ?? (await this.probeOnDisk(path)) ?? 'utf-8-bom';
    }

    let eol: 'crlf' | 'lf';
    if (opts?.eol && opts.eol !== 'preserve') {
      eol = opts.eol;
    } else {
      eol = this.eolCache.get(key) ?? 'lf';
    }

    if (opts?.backup !== false) {
      await this.backup(path);
    }

    const body = applyEol(normalizeEol(text), eol);
    const bytes = await this.bridge.encode(body, encoding);
    await this.bridge.writeFileBytes(path, bytes);
    this.encodingCache.set(key, encoding);
    this.eolCache.set(key, eol);
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    this.assertWritable(path);
    await this.bridge.writeFileBytes(path, data);
  }

  private async probeOnDisk(path: string): Promise<FileEncoding | null> {
    if (!(await this.bridge.exists(path))) return null;
    const bytes = await this.bridge.readFileBytes(path);
    return probeEncoding(bytes);
  }

  /* ------------------------------ 目录 ------------------------------ */

  async ensureDir(path: string): Promise<void> {
    // 与 writeBytes 同闸：先建目录再写文件的链路里，目录创建同样不能越权
    // （否则会先在域外造出目录，违反"游戏目录整体只读"）。
    this.assertWritable(path);
    await this.bridge.ensureDir(path);
  }

  listDir(path: string): Promise<DirEntry[]> {
    return this.bridge.listDir(path);
  }

  walkDir(path: string, opts?: WalkOptions): Promise<DirEntry[]> {
    return this.bridge.walkDir(path, opts);
  }

  exists(path: string): Promise<boolean> {
    return this.bridge.exists(path);
  }

  stat(path: string): Promise<FileStat | null> {
    return this.bridge.stat(path);
  }

  /* --------------------------- 写白名单 --------------------------- */

  setWritableRoots(roots: string[]): void {
    this.writableRoots = roots.map((r) => r);
  }

  setAppWritableRoots(roots: string[]): void {
    this.appWritableRoots = roots.map((r) => r);
  }

  addAppWritableRoot(root: string): void {
    // 追加去重（整替语义留给 setAppWritableRoots，两者各有调用方，不混用）
    const key = pathKey(root);
    if (this.appWritableRoots.some((r) => pathKey(r) === key)) return;
    this.appWritableRoots.push(root);
  }

  /**
   * 自选「项目位置」根（2026-10-14 批）：**对话框即授权**——授权发生在平台命令内
   * （目录对话框与写进常驻根清单绑成一个原子动作），本层只负责把结果同步进第一道闸。
   * 与 `exportFile` 同族：刻意不接受路径入参，JS 侧没有"给个路径就放行"的入口。
   */
  async chooseWorkspaceRoot(opts?: { title?: string }): Promise<string | null> {
    const root = await this.bridge.chooseWorkspaceRoot(opts);
    if (root === null) return null; // 取消 = 什么都不改
    this.addAppWritableRoot(root);
    this.log?.info(`Project location authorized: ${root}`);
    return root;
  }

  isWritable(path: string): boolean {
    return [...this.writableRoots, ...this.appWritableRoots].some((root) => isPathUnder(root, path));
  }

  private assertWritable(path: string): void {
    if (!this.isWritable(path)) {
      throw new WriteNotAllowedError(path, [...this.writableRoots, ...this.appWritableRoots]);
    }
  }

  /* ------------------------------ 备份 ------------------------------ */

  /** 某文件当前写法下的备份桶目录（写侧：backup() 落点；路径写法归一后唯一） */
  private async bucketDirFor(path: string): Promise<string> {
    const appData = await this.bridge.appDataDir();
    return join(appData, 'backup', backupBucketName(path));
  }

  /** 某文件**全部**备份桶目录（读侧：按哈希后缀找，折叠历史写法造成的前缀差异） */
  private async findBucketDirs(path: string): Promise<string[]> {
    const appData = await this.bridge.appDataDir();
    const root = join(appData, 'backup');
    const suffix = `-${backupHashOf(path)}`;
    return (await this.bridge.listDir(root))
      .filter((e) => e.isDirectory && e.name.endsWith(suffix))
      .map((e) => e.path);
  }

  async backup(path: string): Promise<string | null> {
    if (!(await this.bridge.exists(path))) return null;
    // 目录结构：backup/{sanitized-prefix-hash}/{basename}/{timestamp}.bak
    const dir = await this.bucketDirFor(path);
    await this.bridge.ensureDir(dir);
    const target = join(dir, `${timestamp()}.bak`);
    await this.bridge.copyFile(path, target);
    await this.pruneBackups(dir);
    this.log?.debug(`Backup created: ${target}`);
    return target;
  }

  async listBackups(path: string): Promise<BackupVersion[]> {
    const out: BackupVersion[] = [];
    for (const dir of await this.findBucketDirs(path)) {
      const entries = (await this.bridge.listDir(dir)).filter(
        (e) => !e.isDirectory && BACKUP_VERSION_RE.test(e.name),
      );
      for (const e of entries) {
        const st: FileStat | null = await this.bridge.stat(e.path);
        if (st === null) {
          // stat 竞态失败（列完被删）：整条剔除并出声——宁可少一版，不给一版假的尺寸/时间
          this.log?.warn(`备份版本 stat 失败（跳过该条）：${e.path}`);
          continue;
        }
        out.push({
          id: e.name,
          path: e.path,
          takenAtMs: parseBackupTakenAtMs(e.name),
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      }
    }
    // 时间戳文件名字典序 = 时序；新在前（列表第一行就是"最近一版"）
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }

  async restoreBackup(path: string, versionId: string): Promise<void> {
    if (!BACKUP_VERSION_RE.test(versionId)) {
      throw new Error(`无效的历史版本号：${versionId}`);
    }
    // 第一道闸先行：只读的游戏目录在这里就可见拒绝（WriteNotAllowedError），不动盘也不读备份
    this.assertWritable(path);
    let src: string | null = null;
    for (const dir of await this.findBucketDirs(path)) {
      const candidate = join(dir, versionId);
      const st = await this.bridge.stat(candidate);
      if (st !== null && !st.isDirectory) {
        src = candidate;
        break;
      }
    }
    if (src === null) throw new Error(`历史版本不存在：${versionId}`);
    const bytes = await this.bridge.readFileBytes(src);
    await this.backup(path); // 写前自动备份：恢复不吃掉现状（与 writeText 同款时序）
    await this.bridge.writeFileBytes(path, bytes); // 字节级 + 平台原子写：零转码
    // 编码/EOL 缓存跟着版本走：否则下一次 writeText 的 preserve 会用"恢复前那一版"的编码
    const encoding = probeEncoding(bytes);
    const raw = await this.bridge.decode(bytes, encoding);
    this.encodingCache.set(pathKey(path), encoding);
    this.eolCache.set(pathKey(path), detectEol(raw));
    this.log?.info(`Backup restored: ${src} -> ${path}`);
  }

  private async pruneBackups(dir: string): Promise<void> {
    const entries = (await this.bridge.listDir(dir))
      .filter((e) => !e.isDirectory && e.name.endsWith('.bak'))
      .sort((a, b) => a.name.localeCompare(b.name));
    const excess = entries.length - BACKUP_KEEP_PER_FILE;
    for (let i = 0; i < excess; i++) {
      try {
        await this.bridge.removeFile(entries[i]!.path);
      } catch (err) {
        this.log?.warn(`Failed to prune backup ${entries[i]!.path}: ${String(err)}`);
      }
    }
  }

  /* ------------------------------ 导出 ------------------------------ */

  /**
   * 导出单个文件（导出批，ZIP 发布包）：**对话框即授权**——对话框与写盘都在平台命令内，
   * 内核不经手落点，故刻意不调 `assertWritable`（导出的意义正是落到白名单外，
   * 如桌面 / 发布目录）。字节由调用方（插件）备好，内核只搬运。
   */
  async exportFile(
    fileName: string,
    bytes: Uint8Array,
    opts?: { title?: string },
  ): Promise<string | null> {
    const target = await this.bridge.exportFile(fileName, bytes, opts);
    if (target !== null) this.log?.info(`File exported: ${fileName} -> ${target}`);
    return target;
  }

  /** 调试/测试辅助：当前缓存状态 */
  debugCaches(): { encoding: Map<string, FileEncoding>; eol: Map<string, 'crlf' | 'lf'> } {
    return { encoding: this.encodingCache, eol: this.eolCache };
  }
}
