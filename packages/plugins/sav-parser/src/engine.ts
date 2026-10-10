/**
 * 快照来源引擎（游戏无关）：扫描项目存档目录 → 浅解析列档 → 服务化。
 *
 * 稳健性（对齐项目既有引擎惯例）：
 * - 无项目 / 无存档目录 → 空结果（显式呈现，不报错）；
 * - 单档解析失败 → 进该条目 `error`（不中断其余档，不静默）；
 * - 扫描结束项目已切换 → 不提交（代际保护：拿到过期结果比拿不到更糟）。
 */

import type {
  ArchiveParseOptions,
  DirEntry,
  FileStat,
  GameProject,
  Logger,
  SnapshotArchive,
  SnapshotArchiveEntry,
  SnapshotScanResult,
  SnapshotSourceService,
} from '@kojo/plugin-api';
import { parseArchive } from './parse';

/** 存档文件扩展名过滤 */
const ARCHIVE_EXT = /\.sav$/i;

/** 扫描并发（单档为 IO + 解压 + 浅解析混合型，4 路足够） */
const SCAN_CONCURRENCY = 4;

export interface SnapshotEngineDeps {
  log: Logger;
  /** 当前打开的项目（未打开时 null） */
  getProject(): GameProject | null;
  /** 读二进制文件（内核 io） */
  readBytes(path: string): Promise<Uint8Array>;
  /** 非递归列目录（内核 io） */
  listDir(path: string): Promise<DirEntry[]>;
  /** 文件元信息（内核 io） */
  stat(path: string): Promise<FileStat | null>;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

function emptyResult(dir = ''): SnapshotScanResult {
  return { dir, entries: [], scannedAt: Date.now(), durationMs: 0 };
}

export class SnapshotSourceEngine implements SnapshotSourceService {
  private last: SnapshotScanResult | null = null;
  private inFlight: Promise<SnapshotScanResult> | null = null;
  private readonly listeners = new Set<(result: SnapshotScanResult | null) => void>();
  /** 代际号：项目切换时作废过期扫描的结果 */
  private generation = 0;

  constructor(private readonly deps: SnapshotEngineDeps) {}

  current(): SnapshotScanResult | null {
    return this.last;
  }

  subscribe(cb: (result: SnapshotScanResult | null) => void): () => void {
    this.listeners.add(cb);
    cb(this.last);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private notify(): void {
    for (const cb of this.listeners) cb(this.last);
  }

  /** 项目关闭 / 重置：清空并通知订阅者（旧在途扫描由代际号作废） */
  clear(): void {
    this.generation++;
    this.inFlight = null;
    this.last = null;
    this.notify();
  }

  scan(): Promise<SnapshotScanResult> {
    if (this.inFlight) return this.inFlight;
    const p = this.doScan().finally(() => {
      if (this.inFlight === p) this.inFlight = null;
    });
    this.inFlight = p;
    return p;
  }

  private async doScan(): Promise<SnapshotScanResult> {
    const t0 = Date.now();
    const gen = this.generation;
    const project = this.deps.getProject();
    const dir = project?.savDir ?? '';

    if (!dir) {
      // 项目无存档目录：显式空结果（面板可呈现"该项目没有存档概念"）
      const empty = emptyResult('');
      this.last = empty;
      this.notify();
      return empty;
    }

    let entries: DirEntry[];
    try {
      entries = await this.deps.listDir(dir);
    } catch (err) {
      this.deps.log.warn(`Snapshot scan: cannot list archive directory ${dir}: ${String(err)}`);
      entries = [];
    }
    const files = entries.filter((e) => !e.isDirectory && ARCHIVE_EXT.test(e.name));

    const scanned = await mapLimit(files, SCAN_CONCURRENCY, async (entry): Promise<SnapshotArchiveEntry> => {
      let size = 0;
      let mtimeMs: number | null = null;
      try {
        const st = await this.deps.stat(entry.path);
        if (st) {
          size = st.size;
          mtimeMs = st.mtimeMs;
        }
      } catch {
        // stat 失败不致命：size 由实际读到的字节数回填
      }

      const out: SnapshotArchiveEntry = { path: entry.path, fileName: entry.name, size, mtimeMs, meta: null };
      try {
        const bytes = await this.deps.readBytes(entry.path);
        out.size = bytes.length;
        out.meta = await parseArchive(bytes, entry.path, { headerOnly: true });
      } catch (err) {
        out.error = err instanceof Error ? err.message : String(err);
      }
      return out;
    });

    // 代际保护：扫描期间项目已切换 → 不提交
    if (gen !== this.generation) {
      this.deps.log.info('Snapshot scan finished after project switch; result discarded');
      return emptyResult();
    }

    const result: SnapshotScanResult = {
      dir,
      entries: scanned,
      scannedAt: Date.now(),
      durationMs: Date.now() - t0,
    };
    this.last = result;
    this.notify();
    this.deps.log.info(`Snapshot scan: ${scanned.length} archive(s) in ${result.durationMs}ms (${dir})`);
    return result;
  }

  async parse(path: string, opts?: ArchiveParseOptions): Promise<SnapshotArchive> {
    const bytes = await this.deps.readBytes(path);
    return parseArchive(bytes, path, opts);
  }
}
