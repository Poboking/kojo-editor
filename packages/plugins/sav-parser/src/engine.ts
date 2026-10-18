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
import { basename, pathKey } from '@kojo/plugin-api';
import { assembleArchiveFile, assertPayloadNonEmpty } from './container';
import { getFidelity } from './fidelity';
import { parseArchive } from './parse';
import { serializePayload } from './serialize';
import { ArchiveParseError } from './binary';
import { verifyOverrides, verifyReadbackBytes } from './verify';

/**
 * 深解析记忆上限（2026-10-18 性能批；同批修复批改为**按完整判据分格**）。
 *
 * 一条深解析档案 = 解压后的正文 + 全部变量/cell 对象，真实档实测 MB 级。
 * 消费者有三种选项形态（**同一路径、三份并存、互不逐出**——此前按 path 单格存放，
 * 形态之间互相挤掉，面板一切换记忆就失效，且注释里的"两侧各留一份"名不副实）：
 * 1. 回放腿默认形态（`ui-state-replay`，不带选项）；
 * 2. 注入面板深形态（`keepArrayCells + keepRaw`）；
 * 3. 归档浏览器轻形态（`keepArrayCells:false + maxCellsPerArray:0`）。
 * 上限取 6 = 三形态 × 两份近期档（切换选档时每形态各留最近一档），再超从队首削。
 * 0 = 关闭记忆（逐次读盘 + 解析，2026-10-18 之前的行为，测试用它做 A/B 对照）。
 */
const PARSE_MEMO_MAX = 6;

/** 失效判据中的"盘上版本"部分（mtime + size，与快照 / 索引逐文件判据同源）。
 * **只是"没检测到过期"的兜底，不是失效的唯一来源**：本仓的编辑器自写路径
 * （撤销注入 / 恢复备份 / 注入）会重写同一判据下的字节（注入原地改值 ⇒ 字节数不变，
 * 粗粒度介质上 mtime 也同值）⇒ 写侧经 `file.changed` 事件驱动 `invalidate()` 逐出，
 * mtime/size 判据只作外部改盘的第二道防线。**不做内容哈希**——IO 路径上的逐文件
 * 内容哈希曾在 1016 批被实测量成 24.4s 的账（见 PITFALLS §73）。 */
interface ArchiveStamp {
  readonly mtimeMs: number;
  readonly size: number;
}

interface MemoEntry {
  /** 路径折叠键（`pathKey` 形态；事件带着另一种写法来也要逐得掉） */
  readonly pathId: string;
  /** 版本判据（pathId + mtime + size）；同路径不同版本的残格在写入新格时清掉 */
  readonly stampKey: string;
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
   * 深解析记忆（完整判据串 → 产物）。Map 插入序即 FIFO 序：重击=删除后重新入队尾，
   * 超尺从队首削（与 `kernel/src/io.ts` 的文本缓存同一形状）。
   * 键 = `pathId\0mtime\0size\0选项指纹` ⇒ 同一路径的三种选项形态各占一格、互不逐出。
   */
  private readonly memo = new Map<string, MemoEntry>();
  /** 同判据的并发深解析共享一次（两条面板同时问同一个档 ⇒ 只解压一遍） */
  private readonly memoFlight = new Map<string, Promise<SnapshotArchive>>();
  /**
   * 每路径的失效纪元（`invalidate` 递增）：在途解析完成时比对——纪元变了说明
   * 读取发生在"已知作废"之前 ⇒ 结果**不落记忆**（撤销注入 / 恢复备份与慢解析赛跑的窗口）。
   */
  private readonly pathEpoch = new Map<string, number>();
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

  /**
   * 显式失效某路径的全部深解析记忆（**不等 mtime/size 判据生效**）。
   *
   * 谁该调它：**知道盘被改了的一方**。生产装配里由 `index.ts` 订阅内核广播的
   * `file.changed` 转接（撤销注入 / 恢复备份 / 注入等写路径由内核 io 发事件，
   * 文件监视器对"盘外之手"兜底投同一条事件）——判据可以同值（注入原地改值 ⇒ 字节数不变；
   * FAT32/SMB/OneDrive 的 mtime 粒度 1–2s ⇒ 撤销可落在同一 tick），事件不会说谎。
   *
   * 做三件事：逐出该路径全部形态的记忆格；摘掉该路径的在途解析（新请求不再共享
   * "改动前读到的字节"）；递增纪元——已在途的解析完成时**不回填**记忆。
   */
  invalidate(path: string): void {
    const pathId = pathKey(path);
    this.pathEpoch.set(pathId, this.epochOf(pathId) + 1);
    for (const [key, entry] of this.memo) {
      if (entry.pathId === pathId) this.memo.delete(key);
    }
    const prefix = `${pathId}\u0000`;
    for (const key of this.memoFlight.keys()) {
      if (key.startsWith(prefix)) this.memoFlight.delete(key);
    }
  }

  private epochOf(pathId: string): number {
    return this.pathEpoch.get(pathId) ?? 0;
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

  /** 项目关闭 / 重置：清空并通知订阅者（旧在途扫描由代际号作废；在途深解析由同一代际号**禁止回填**） */
  clear(): void {
    this.generation++;
    this.inFlight = null;
    this.last = null;
    this.memo.clear();
    this.memoFlight.clear();
    this.pathEpoch.clear();
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
   * **判据＝mtime + size（第二道防线）+ 事件驱动的显式失效（第一道防线）**：
   * 用户在盘上改了存档 ⇒ 下一次解析必然重做（`parse-memo.test.ts` 钉这条）；
   * **编辑器自己写的盘**（撤销注入 / 恢复备份 / 注入）经 `file.changed` → `invalidate()`
   * 逐出——注入原地改值字节数不变、粗粒度介质上 mtime 还可同值，判据单独靠不住，
   * 这正是 tsserver 单文件失效 / 文件监视 `onFileChanged` 的口径：**知情的写入方告诉缓存**。
   *
   * **不静默**（内核规则 4）：读盘 / 解析失败一律原样上抛，与加记忆之前同一条路径；
   * 拿不到 stat（旧宿主 / 取不到元信息 / 目录）时**退回每次重解析**，绝不拿"没信号"当"没变"。
   */
  async parse(path: string, opts?: ArchiveParseOptions): Promise<SnapshotArchive> {
    if (this.memoMax <= 0) return this.parseFresh(path, opts);
    const stamp = await this.stampOf(path);
    if (stamp === null) return this.parseFresh(path, opts); // 无判据 ⇒ 不记忆（行为与改前逐字相同）

    const pathId = pathKey(path);
    const stampKey = `${pathId}\u0000${stamp.mtimeMs}\u0000${stamp.size}`;
    const key = `${stampKey}\u0000${optionsFingerprint(opts)}`;
    const hit = this.memo.get(key);
    if (hit) {
      this.memoHits++;
      this.memo.delete(key); // 重新入队尾（FIFO：热的那条留在后面）
      this.memo.set(key, hit);
      return hit.archive;
    }
    this.memoMisses++;

    const flight = this.memoFlight.get(key);
    if (flight) return flight;

    // 回填闸门：解析期间发生过 `invalidate()`（纪元变）或项目关闭/重置（代际变）
    // ⇒ 这份字节读于改动之前，**绝不落进记忆**（否则过期结果在 clear 之后复活，
    // 带着 keepRaw 视图把整档 MB 级内存留到项目之外）。
    const epochAtStart = this.epochOf(pathId);
    const genAtStart = this.generation;
    const task = (async (): Promise<SnapshotArchive> => {
      const archive = await this.parseFresh(path, opts);
      if (this.epochOf(pathId) === epochAtStart && this.generation === genAtStart) {
        this.remember(key, pathId, stampKey, archive);
      }
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

  /**
   * 入记忆（FIFO 超尺从队首削；解析失败不会走到这里 ⇒ 坏档永不入记忆）。
   * 先清同一路径**旧盘上版本**的残格（mtime/size 变了 ⇒ 旧版本的所有形态都不再可达，
   * 留着只是 MB 级死内存）；同版本的其他选项形态原样共存——这是 bug 2 的正解。
   */
  private remember(key: string, pathId: string, stampKey: string, archive: SnapshotArchive): void {
    for (const [k, e] of this.memo) {
      if (e.pathId === pathId && e.stampKey !== stampKey) this.memo.delete(k);
    }
    this.memo.delete(key);
    this.memo.set(key, { pathId, stampKey, archive });
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
        // 自己刚改过盘 ⇒ 这条路径的记忆与在途解析**已知作废**，显式逐出并禁止回填
        // （不等 mtime/size 判据：注入原地改值字节数不变，粗粒度介质上 mtime 还可同值）
        this.invalidate(path);
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
