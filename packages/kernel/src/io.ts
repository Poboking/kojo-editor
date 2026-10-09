import type {
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
import { basename, isPathUnder, join, pathKey } from './paths';

/**
 * 文件 IO 服务实现。
 *
 * 安全模型（架构文档 §3.4 "游戏目录整体只读假设"）：
 * - 写路径白名单：默认空（一切拒绝）；项目打开并由用户批准后 setWritableRoots 放行；
 * - 越权写入抛 WriteNotAllowedError——写保护是内核级不变量，不依赖调用方自觉；
 * - 写前自动备份（{appDataDir}/backup/，按文件保留最近 N 版）+ 原子写（平台桥保证）；
 * - 编码保持：读时探测并缓存，写时默认 'preserve'（一次保存毁半库是历史教训）。
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

export class FileIOServiceImpl implements FileIO {
  private writableRoots: string[] = [];
  private readonly encodingCache = new Map<string, FileEncoding>();
  private readonly eolCache = new Map<string, 'crlf' | 'lf'>();

  constructor(
    private readonly bridge: PlatformBridge,
    private readonly log?: Logger,
  ) {}

  /* ------------------------------ 读 ------------------------------ */

  async readText(path: string): Promise<TextFile> {
    const bytes = await this.bridge.readFileBytes(path);
    const encoding = probeEncoding(bytes);
    const raw = await this.bridge.decode(bytes, encoding);
    const eol = detectEol(raw);
    const text = normalizeEol(raw);
    this.encodingCache.set(pathKey(path), encoding);
    this.eolCache.set(pathKey(path), eol);
    const st = await this.bridge.stat(path);
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

  isWritable(path: string): boolean {
    return this.writableRoots.some((root) => isPathUnder(root, path));
  }

  private assertWritable(path: string): void {
    if (!this.isWritable(path)) {
      throw new WriteNotAllowedError(path, [...this.writableRoots]);
    }
  }

  /* ------------------------------ 备份 ------------------------------ */

  async backup(path: string): Promise<string | null> {
    if (!(await this.bridge.exists(path))) return null;
    const appData = await this.bridge.appDataDir();
    // 目录结构：backup/{sanitized-prefix-hash}/{basename}/{timestamp}.bak
    const norm = pathKey(path);
    const safePrefix = `${basename(path).slice(0, 40).replace(/[^A-Za-z0-9._-]/g, '_')}-${fnv1a(norm)}`;
    const dir = join(appData, 'backup', safePrefix);
    await this.bridge.ensureDir(dir);
    const target = join(dir, `${timestamp()}.bak`);
    await this.bridge.copyFile(path, target);
    await this.pruneBackups(dir);
    this.log?.debug(`Backup created: ${target}`);
    return target;
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

  /** 调试/测试辅助：当前缓存状态 */
  debugCaches(): { encoding: Map<string, FileEncoding>; eol: Map<string, 'crlf' | 'lf'> } {
    return { encoding: this.encodingCache, eol: this.eolCache };
  }
}
