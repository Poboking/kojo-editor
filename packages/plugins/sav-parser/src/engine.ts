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
import { verifyOverrides, verifyReadbackBytes } from './verify';

/**
 * 深解析记忆上限（2026-10-18 性能批）。
 *
 * 一条深解析档案 = 解压后的正文 + 全部变量/cell 对象，真实档实测 MB 级；
 * 消费者只有两只面板（`.kojo 转译检查` 的回放腿、归档浏览器），同一轮里问的都是
 * **同一个路径** ⇒ 上限取 2（切换选档时两侧各留一份），再多就是拿常驻内存换零收益。
 * 0 = 关闭记忆（逐次读盘 + 解析，2026-10-18 之前的行为，测试用它做 A/B 对照）。
 */
const PARSE_MEMO_MAX = 2;

/** 失效判据（仓库口径＝mtime + size，与快照 / 索引逐文件判据同源；**不做内容哈希**——
 *  IO 路径上的逐文件内容哈希曾在 1016 批被实测量成 24.4s 的账，见 PITFALLS §73） */
interface ArchiveStamp {
  readonly mtimeMs: number;
  readonly size: number;
}

interface MemoEntry {
  /** 完整判据（路径 + mtime + size + 解析选项指纹）；与本次不符即作废 */
  readonly key: string;
  readonly archive: SnapshotArchive;
}

/** 解析选项指纹：记忆**必须**按选项分格——`headerOnly` / `keepRaw` / `keepArrayCells` /
 *  `maxCellsPerArray` 产出的是完全不同的对象，串格会把浅解析当深解析交给消费者 */
function optionsFingerprint(opts: ArchiveParseOptions | undefined): string {
  if (!opts) return '';
  return `k${opts.keepArrayCells === false ? 0 : 1}r${opts.keepRaw === true ? 1 : 0}h${opts.headerOnly === true ? 1 : 0}m${opts.maxCellsPerArray ?? ''}`;
}

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
  /**
   * 深解析记忆上限（2026-10-18 性能批；可选）。
   *
   * 缺省 = `PARSE_MEMO_MAX`；`0` = 完全关闭记忆（每次 `parse()` 都读盘 + 解压 + 解析，
   * 即本批之前的行为）。测试用这条开关在同一实例上做「有记忆 / 无记忆」的 A/B 对照，
   * 生产装配层不传（走默认）。
   */
  parseMemoMax?: number;
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
  /**
   * 深解析记忆（path → 判据 + 产物）。Map 插入序即 FIFO 序：重击=删除后重新入队尾，
   * 超尺从队首削（与 `kernel/src/io.ts` 的文本缓存同一形状）。
   */
  private readonly memo = new Map<string, MemoEntry>();
  /** 同判据的并发深解析共享一次（两条面板同时问同一个档 ⇒ 只解压一遍） */
  private readonly memoFlight = new Map<string, Promise<SnapshotArchive>>();
  private readonly memoMax: number;
  /** 记忆读数（命中 / 未命中 / 关闭原因）；面板与测试用来自证"记忆在不在工作" */
  private memoHits = 0;
  private memoMisses = 0;

  constructor(private readonly deps: SnapshotEngineDeps) {
    this.memoMax = deps.parseMemoMax ?? PARSE_MEMO_MAX;
  }

  /** 深解析记忆读数（只观察、不改行为；`max` 即生效上限） */
  parseMemoStats(): { readonly entries: number; readonly hits: number; readonly misses: number; readonly max: number } {
    return { entries: this.memo.size, hits: this.memoHits, misses: this.memoMisses, max: this.memoMax };
  }

  /** 逐出全部深解析记忆（下次 `parse` 必重新读盘解析） */
  clearParseMemo(): void {
    this.memo.clear();
  }

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
    this.memo.clear();
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

  /**
   * 深解析单个档案（带记忆）。
   *
   * **为什么要记忆**（2026-10-18 性能批的头号账）：`.kojo 转译检查` 面板每敲一键都会走
   * `ui-sugar-preview → sugar.preview → state.replay.createView → 这里`，
   * 无记忆时等于**每次击键把整档重新读盘 + 解压 + 逐 cell 解析一遍**（真实档 MB 级、
   * 主线程同步段），而档根本没动。
   *
   * **判据＝mtime + size**（仓库既有口径，与抽取快照 / ERB 索引逐文件判据同源）：
   * 用户在盘上改了存档 ⇒ 下一次解析必然重做（`parse-memo.test.ts` 钉这条）。
   * 残余风险如实写明：同 mtime 且同 size 的**同值替换**（保留时间戳的拷贝）兜不住——
   * 这是本仓所有 mtime 判据共同的边界，不为它引入内容哈希（见上方注释）。
   *
   * **不静默**（内核规则 4）：读盘 / 解析失败一律原样上抛，与加记忆之前同一条路径；
   * 拿不到 stat（旧宿主 / 取不到元信息 / 目录）时**退回每次重解析**，绝不拿"没信号"当"没变"。
   */
  async parse(path: string, opts?: ArchiveParseOptions): Promise<SnapshotArchive> {
    if (this.memoMax <= 0) return this.parseFresh(path, opts);
    const stamp = await this.stampOf(path);
    if (stamp === null) return this.parseFresh(path, opts); // 无判据 ⇒ 不记忆（行为与改前逐字相同）

    const key = `${path}\u0000${stamp.mtimeMs}\u0000${stamp.size}\u0000${optionsFingerprint(opts)}`;
    const hit = this.memo.get(path);
    if (hit && hit.key === key) {
      this.memoHits++;
      this.memo.delete(path); // 重新入队尾（FIFO：热的那条留在后面）
      this.memo.set(path, hit);
      return hit.archive;
    }
    this.memoMisses++;

    const flight = this.memoFlight.get(key);
    if (flight) return flight;

    const task = (async (): Promise<SnapshotArchive> => {
      const archive = await this.parseFresh(path, opts);
      this.remember(path, key, archive);
      return archive;
    })();
    this.memoFlight.set(key, task);
    try {
      return await task;
    } finally {
      if (this.memoFlight.get(key) === task) this.memoFlight.delete(key);
    }
  }

  /** 不带记忆的读盘 + 解析（失败原样上抛；`inject` 链路用它之外的独立解析口径，不经这里） */
  private async parseFresh(path: string, opts?: ArchiveParseOptions): Promise<SnapshotArchive> {
    const bytes = await this.deps.readBytes(path);
    return parseArchive(bytes, path, opts);
  }

  /** 取 mtime + size 判据；取不到（null / 抛 / 目录 / 非有限数）一律 null = 不记忆 */
  private async stampOf(path: string): Promise<ArchiveStamp | null> {
    let st: FileStat | null;
    try {
      st = await this.deps.stat(path);
    } catch (err) {
      this.deps.log.debug(`Archive parse memo disabled for ${path}: stat failed — ${String(err)}`);
      return null;
    }
    if (!st || st.isDirectory || !Number.isFinite(st.mtimeMs) || !Number.isFinite(st.size)) return null;
    return { mtimeMs: st.mtimeMs, size: st.size };
  }

  /** 入记忆（FIFO 超尺从队首削；解析失败不会走到这里 ⇒ 坏档永不入记忆） */
  private remember(path: string, key: string, archive: SnapshotArchive): void {
    this.memo.delete(path);
    this.memo.set(path, { key, archive });
    while (this.memo.size > this.memoMax) {
      const oldest = this.memo.keys().next().value;
      if (oldest === undefined) break;
      this.memo.delete(oldest);
    }
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
        // 自己刚改过盘 ⇒ 这条路径的记忆**已知作废**，逐出（不等 mtime/size 判据生效；
        // 系统 mtime 粒度粗时判据本身可能同值）
        this.memo.delete(path);
      } catch (err) {
        this.deps.log.warn(
          `Snapshot inject: write failed for ${path}${backupPath ? ` (backup at ${backupPath})` : ''}: ${String(err)}`,
        );
        throw err;
      }

      // 回读验证（强制：注入的价值建立在"值确实落盘"上）
      const reread = await this.deps.readBytes(path);
      // 字节态先判：写出的字节与重读的字节必须逐字节相同（W17 判等核，与文件历史同源）
      const byteCheck = verifyReadbackBytes(full, reread);
      const reparsed = await parseArchive(reread, path, { keepArrayCells: true });
      const report = verifyOverrides(reparsed, overrides);
      const mismatches = [...byteCheck.mismatches, ...report.mismatches];
      if (mismatches.length > 0) {
        throw new ArchiveParseError(
          `注入回读验证失败（${mismatches.length} 项不匹配）` +
            (backupPath ? `——原档已备份于 ${backupPath}` : '（原档无备份）') +
            `：${mismatches.join('；')}`,
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
