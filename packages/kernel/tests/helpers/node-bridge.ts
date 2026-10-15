import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import iconv from 'iconv-lite';
import type {
  BatchFileStat,
  DirEntry,
  FileChangeKind,
  FileEncoding,
  FileStat,
  PlatformBridge,
  RawFileRead,
  Unsubscribe,
  WalkOptions,
  WatchCallback,
  WatchFailure,
  WatchReportCallback,
} from '@kojo/plugin-api';

/**
 * Node 平台桥（测试与 CLI 用）。
 * 生产环境由 Tauri 壳的 Rust 侧提供同接口实现（encoding_rs + notify + rfd）。
 */

/** 本桥原子写的临时文件名（`.{name}.{pid}.{ms}.tmp`）——与 Rust 侧同口径过滤掉 */
function isAtomicWriteTemp(relativePath: string): boolean {
  const name = relativePath.split(/[\\/]/).pop() ?? '';
  return name.startsWith('.') && name.endsWith('.tmp');
}

const DECODE_LABEL: Record<FileEncoding, string> = {
  'utf-8': 'utf-8',
  'utf-8-bom': 'utf-8',
  shift_jis: 'shift_jis',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
};

/** 批量原语的并行度（与 Rust 侧 `BATCH_READ_THREADS` 同量级：读并行 8） */
const BATCH_IO_CONCURRENCY = 8;

/** 保序限并发（结果按下标回位；node 侧无 IPC，等价于 Rust 侧的线程池读） */
async function mapLimitOrdered<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export class NodeBridge implements PlatformBridge {
  /**
   * @param dataDir 应用数据目录（等价 Rust 的 appDataDir）
   * @param authorizedRoots 假装"平台已常驻授权的项目位置根"（2026-10-14 自选位置批的测试面）：
   *   Node 侧弹不出目录对话框，多根链路靠这里喂名单。默认空 = 只有默认工作区根。
   */
  constructor(
    private readonly dataDir: string,
    private readonly authorizedRoots: string[] = [],
  ) {}

  async readFileBytes(path: string): Promise<Uint8Array> {
    const buf = await fs.readFile(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /**
   * 批量读（2026-10-16 批量 IO 批）：与 Tauri 侧同语义——逐文件失败不抛整批、
   * 三态归类（缺文件 = not-found、其余读错 = read-error）与 Rust 侧逐字对应、
   * **保序**且读并行（并发 8，与 Rust `BATCH_READ_THREADS` 同量级）。
   * node 侧无 IPC，直接 fs；行为以契约（`RawFileRead`）为准、与 tauri 侧对齐。
   */
  async readFilesRaw(paths: readonly string[]): Promise<RawFileRead[]> {
    return mapLimitOrdered(paths, BATCH_IO_CONCURRENCY, async (path): Promise<RawFileRead> => {
      try {
        const [buf, st] = [await fs.readFile(path), await fs.stat(path)];
        return {
          path,
          status: 'ok',
          mtimeMs: st.mtimeMs,
          size: st.size,
          data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return {
          path,
          status: code === 'ENOENT' ? 'not-found' : 'read-error',
          mtimeMs: null,
          size: null,
          data: new Uint8Array(0),
        };
      }
    });
  }

  async statFiles(paths: readonly string[]): Promise<BatchFileStat[]> {
    return mapLimitOrdered(paths, BATCH_IO_CONCURRENCY, async (path): Promise<BatchFileStat> => {
      try {
        const st = await fs.stat(path);
        return { path, exists: true, mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return { path, exists: false, mtimeMs: null, size: null };
      }
    });
  }

  async writeFileBytes(path: string, data: Uint8Array): Promise<void> {
    // 原子写：同目录临时文件 + rename
    const dir = nodePath.dirname(path);
    await fs.mkdir(dir, { recursive: true });
    const tmp = nodePath.join(dir, `.${nodePath.basename(path)}.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(tmp, Buffer.from(data));
    await fs.rename(tmp, path);
  }

  async ensureDir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true });
  }

  async listDir(path: string): Promise<DirEntry[]> {
    try {
      const entries = await fs.readdir(path, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        path: nodePath.join(path, e.name),
        isDirectory: e.isDirectory(),
      }));
    } catch {
      return [];
    }
  }

  async walkDir(root: string, opts?: WalkOptions): Promise<DirEntry[]> {
    const out: DirEntry[] = [];
    const maxDepth = opts?.maxDepth ?? Number.POSITIVE_INFINITY;
    const includeFiles = opts?.includeFiles ?? true;
    const includeDirs = opts?.includeDirs ?? false;
    const withMetadata = opts?.withMetadata ?? false;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > maxDepth) return;
      const entries = await this.listDir(dir);
      for (const entry of entries) {
        if (opts?.filter && !opts.filter(entry)) continue;
        if (entry.isDirectory) {
          if (includeDirs) out.push(entry);
          await walk(entry.path, depth + 1);
        } else if (includeFiles) {
          let filled = entry;
          if (withMetadata) {
            // 与 stat() 同源取值：mtimeMs/size 必须与逐文件 stat 一致，否则索引的体量指纹会漂
            try {
              const s = await fs.stat(entry.path);
              filled = { ...entry, mtimeMs: s.mtimeMs, size: s.size };
            } catch {
              filled = entry; // 取不到就留空 ⇒ 调用方退化回 stat，绝不伪造 0
            }
          }
          out.push(filled);
        }
      }
    };
    await walk(root, 0);
    return out;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const s = await fs.stat(path);
      return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
    } catch {
      return null;
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
  }

  async copyFile(from: string, to: string): Promise<void> {
    await fs.mkdir(nodePath.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }

  async removeFile(path: string): Promise<void> {
    await fs.unlink(path);
  }

  async removeDir(path: string): Promise<void> {
    await fs.rm(path, { recursive: true, force: true });
  }

  async watchDirs(
    paths: string[],
    onEvent: WatchCallback,
    onReport?: WatchReportCallback,
  ): Promise<Unsubscribe> {
    const watchers: Array<ReturnType<typeof import('node:fs').watch>> = [];
    const failures: WatchFailure[] = [];
    const watched: string[] = [];
    const { watch } = await import('node:fs');
    for (const p of paths) {
      try {
        const w = watch(p, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          // 与 Rust 侧 is_atomic_write_temp 同口径：本桥自己的原子写产物不算内容变更
          if (isAtomicWriteTemp(filename.toString())) return;
          const kind: FileChangeKind = eventType === 'rename' ? 'change' : 'change';
          onEvent(kind, nodePath.join(p, filename.toString()));
        });
        w.on('error', (err) => onReport?.({ type: 'error', reason: String(err) }));
        watchers.push(w);
        watched.push(p);
      } catch (err) {
        failures.push({ root: p, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    onReport?.({ type: 'started', watched, failures });
    return () => {
      for (const w of watchers) w.close();
    };
  }

  async chooseDirectory(): Promise<string | null> {
    throw new Error('chooseDirectory is not supported by NodeBridge');
  }

  async exportFile(): Promise<string | null> {
    // 同上：单文件导出依赖系统保存对话框
    throw new Error('exportFile is not supported by NodeBridge');
  }

  async chooseWorkspaceRoot(): Promise<string | null> {
    // 同上：自选项目位置依赖系统目录对话框（且授权登记发生在平台命令内）
    throw new Error('chooseWorkspaceRoot is not supported by NodeBridge');
  }

  async listWorkspaceRoots(): Promise<string[]> {
    // 生产侧由 Rust 从 `<appDataDir>/workspace_roots.txt` 读回；本桥用构造参数喂同一份名单
    return [...this.authorizedRoots];
  }

  appDataDir(): Promise<string> {
    return Promise.resolve(this.dataDir);
  }

  async decode(bytes: Uint8Array, encoding: FileEncoding): Promise<string> {
    const dec = new TextDecoder(DECODE_LABEL[encoding]);
    return dec.decode(bytes);
  }

  async encode(text: string, encoding: FileEncoding): Promise<Uint8Array> {
    if (encoding === 'shift_jis') {
      return new Uint8Array(iconv.encode(text, 'shift_jis'));
    }
    if (encoding === 'utf-16le') {
      return new Uint8Array(iconv.encode(text, 'utf-16le'));
    }
    if (encoding === 'utf-16be') {
      return new Uint8Array(iconv.encode(text, 'utf-16be'));
    }
    const body = encoding === 'utf-8-bom' ? `\uFEFF${text}` : text;
    return new TextEncoder().encode(body);
  }
}
