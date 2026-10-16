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
  ArchiveOverrides,
  DirEntry,
  FileStat,
  GameProject,
  Logger,
  OpJournal,
  SnapshotArchive,
  SnapshotArchiveEntry,
  SnapshotInjectionResult,
  SnapshotScanResult,
  SnapshotSourceService,
  SnapshotWriteService,
} from '@kojo/plugin-api';
import { basename } from '@kojo/plugin-api';
import { assembleArchiveFile, assertPayloadNonEmpty } from './container';
import { getFidelity } from './fidelity';
import { parseArchive } from './parse';
import { serializePayload } from './serialize';
import { ArchiveParseError } from './binary';
import { verifyOverrides } from './verify';

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
  /** 原子写字节（内核 io；writablePaths 第一道闸 + 宿主写允许域第二道闸在此强制） */
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  /** 写前备份（内核 io；复制到 {appData}/backup/，返回备份路径；原文件不存在时 null） */
  backup(path: string): Promise<string | null>;
  /**
   * 批操作 journal（2026-10-16 undo 批，additive 可选）：注入链路进操作历史，
   * 失败（含回读验证失败）时 abort 回滚原档——比"指个备份路径让用户自己救"强一档。
   * 旧内核无 `kernel.ops` 时缺席，行为退回原样。
   */
  journal?: Pick<OpJournal, 'begin' | 'record' | 'commit' | 'abort'>;
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

export class SnapshotSourceEngine implements SnapshotSourceService, SnapshotWriteService {
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

  /**
   * 改槽注入（v0.2 第十五批，SnapshotWriteService 实现）。
   *
   * 链路：读原档 → 深解析（keepRaw + 全量 cells）→ serializePayload
   * （未修变量 passthrough；Int64 守卫显式抛错）→ 容器组装（沿用原档
   * gzip/raw 格式）→ **先备份后覆盖**（内核 io backup + writeBytes，
   * 双闸在 io 与宿主层强制）→ 回读解析逐条断言覆盖值落盘。
   *
   * 顺序即安全语义：
   * - 守卫（Int64 / 协议）在备份**之前**抛——损坏输入不落盘也不产生无谓备份；
   * - 越权写（WriteNotAllowedError）抛出时备份已存在（无副作用覆盖）；
   * - 回读验证失败 = 致命错误，显式抛错并携带备份位置，绝不静默。
   */
  async inject(path: string, overrides: ArchiveOverrides): Promise<SnapshotInjectionResult> {
    const t0 = Date.now();
    // 操作 journal（2026-10-16 undo 批，additive）：写链路整体进一次批操作；
    // 任何失败（含回读验证失败）abort 回滚原档，成功 commit 供操作历史整批撤销。
    const journal = this.deps.journal ?? null;
    const opId = journal ? await journal.begin('snapshot-inject', `注入存档变量：${basename(path)}`) : null;
    try {
      const original = await this.deps.readBytes(path);
      const archive = await parseArchive(original, path, { keepArrayCells: true, keepRaw: true });
      const payload = serializePayload(archive, { overrides });
      assertPayloadNonEmpty(payload);
      // 保真旁路：保留头部字段 [12..16] 原样回写（未修字节逐字节还原）
      const full = await assembleArchiveFile(payload, archive.format, getFidelity(archive)?.reservedHeader);

      // record 先于一切盘上动作（此刻的字节快照才是"操作前"）；
      // 守卫（Int64/协议）抛错走 abort——空 op 回滚无副作用，语义干净
      if (opId !== null) await journal!.record(opId, path);

      const backupPath = await this.deps.backup(path);
      try {
        await this.deps.writeBytes(path, full);
      } catch (err) {
        this.deps.log.warn(
          `Snapshot inject: write failed for ${path}${backupPath ? ` (backup at ${backupPath})` : ''}: ${String(err)}`,
        );
        throw err;
      }

      // 回读验证（强制：注入的价值建立在"值确实落盘"上）
      const reread = await this.deps.readBytes(path);
      const reparsed = await parseArchive(reread, path, { keepArrayCells: true });
      const report = verifyOverrides(reparsed, overrides);
      if (report.mismatches.length > 0) {
        throw new ArchiveParseError(
          `注入回读验证失败（${report.mismatches.length} 项不匹配）` +
            (backupPath ? `——原档已备份于 ${backupPath}` : '（原档无备份）') +
            `：${report.mismatches.join('；')}`,
          0,
        );
      }

      if (opId !== null) await journal!.commit(opId);
      this.deps.log.info(
        `Snapshot inject: ${path} — ${report.checked} override(s) verified, ${full.length}B written` +
          `${backupPath ? `, backup ${backupPath}` : ''} (${Date.now() - t0}ms)`,
      );
      return { path, backupPath, byteSize: full.length, verifiedCount: report.checked };
    } catch (err) {
      if (opId !== null) {
        // abort 回滚原档（回读验证失败时已写内容恢复原样）；回滚失败不出声——
        // 原始错误才是用户要看见的，backupPath 那条兜底信息仍在错误文本里
        try {
          await journal!.abort(opId);
        } catch (rollbackErr) {
          this.deps.log.warn(`Snapshot inject: journal abort failed: ${String(rollbackErr)}`);
        }
      }
      throw err;
    }
  }
}
