import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import iconv from 'iconv-lite';
import type {
  DirEntry,
  FileChangeKind,
  FileEncoding,
  FileStat,
  PlatformBridge,
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

export class NodeBridge implements PlatformBridge {
  constructor(private readonly dataDir: string) {}

  async readFileBytes(path: string): Promise<Uint8Array> {
    const buf = await fs.readFile(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
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

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > maxDepth) return;
      const entries = await this.listDir(dir);
      for (const entry of entries) {
        if (opts?.filter && !opts.filter(entry)) continue;
        if (entry.isDirectory) {
          if (includeDirs) out.push(entry);
          await walk(entry.path, depth + 1);
        } else if (includeFiles) {
          out.push(entry);
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

  async exportDirectory(): Promise<string | null> {
    // 导出依赖系统目录对话框（rfd），Node 桥无对话框能力 → 显式抛错不静默
    throw new Error('exportDirectory is not supported by NodeBridge');
  }

  async exportFile(): Promise<string | null> {
    // 同上：单文件导出依赖系统保存对话框
    throw new Error('exportFile is not supported by NodeBridge');
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
