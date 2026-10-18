import type {
  EolStyle,
  FileEncoding,
  FileIO,
  Logger,
  OpEntryView,
  OpJournal,
  OpRecord,
  OpsMaintenance,
  PlatformBridge,
} from '@kojo/plugin-api';
import { join, pathKey } from '@kojo/plugin-api';
import { detectEol, decodeWithProbe } from './encoding';
import { timestamp } from './io';

/**
 * 批操作 journal（2026-10-16 undo 批；契约 `plugin-api/journal.ts`）。
 *
 * 落盘结构（`{appData}/ops/`；内容快照可能大，刻意不走 KV storage）：
 *
 *   ops/op-<ts>-<rand>.json    操作文档（id/kind/label/status/entries）
 *   ops/op-<ts>-<rand>/        before 字节快照目录（0.before、1.before …）
 *
 * 关键取舍：
 * - 快照是**字节级**拷贝（bridge 原语直写 appData，与 `io.backup` 同先例——内核
 *   自有管理域不经写允许域）；undo 写回用户文件**必走** `io.writeBytes`/
 *   `io.removeFile`（第一道闸 + 平台第二道闸 + 会话缓存失效，一条不少）；
 * - record 同路径去重以**第一次**为准：undo 恢复"操作开始前"，不是中间态；
 * - 崩溃残留 / 回滚失败的 open 态 json **不进 list**（entries 可能不完整，半批回滚比不回滚更险），
 *   但**绝不静默**：`list()` 每次巡检都把它们计入 `maintenanceReport()` 并 warn 一次
 *   （口径同 `file.watchState`：状态自己说话，面板/日志读得到）；
 * - undo 本身也是一次 op（kind=`undo:<原kind>`，entries=回滚前状态）——
 *   对已撤销操作再撤销 = 重做，重做能力由此**免费**获得，不另造 redo 栈。
 */

const OP_DOC_SUFFIX = '.json';

/** op id 形态（`op-<ts>-<rand6>`；读写只认它，不放宽——路径不可逃逸出 ops 根） */
export const OP_ID_RE = /^op-\d{8}-\d{6}-\d{3}-[a-z0-9]{6}$/;

/** 抓取"本 op 创建的目录链"时的向上步数上限（防路径畸形导致死循环） */
const MAX_DIR_ANCESTORS = 64;

/**
 * journal 目录维护状态的契约类型住在 `@kojo/plugin-api/journal.ts`（契约 = 唯一真相源）；
 * 内核这里只做原位 re-export，让 `kernel/journal` 的老引用点零改动。
 * 语义见契约文档：残留**不进 `list()`、不响应 `undo()`**，只在 `maintenanceReport()` 里报数。
 */
export type { OpsMaintenance } from '@kojo/plugin-api';

interface JournalEntryRec {
  path: string;
  /** 相对 op 快照目录的文件名；null = 操作内新建 */
  beforePath: string | null;
  encoding: FileEncoding | null;
  eol: EolStyle | null;
  /**
   * record 时刻**尚不存在**的祖先目录（深→浅）——即本 op 将要创建的目录。
   * 只有"文件是新建"（beforePath=null）时才抓取；撤销/abort 只清理这里列出的目录，
   * **本 op 之前就存在的父目录永不被删**（2026-10-17 修复 undo 删掉既有空目录）。
   * 旧文档缺该字段 ⇒ 视为"没有可清理目录"（宁可留空壳，不可删错）。
   */
  createdDirs?: string[];
}

interface OpDoc {
  v: 1;
  id: string;
  kind: string;
  label: string;
  status: 'open' | 'committed' | 'undone';
  startedAt: number;
  finishedAt: number | null;
  entries: JournalEntryRec[];
  /**
   * abort 回滚半途失败的留痕：此时快照**刻意不删**（删了就没第二次机会），
   * 文档停在 open 态并由维护提示点名。
   */
  rollbackError?: string;
  /**
   * 本 op 已落快照字节累计（2026-10-18 字节上限批）：record 写快照时累加，
   * 超过 {@link OP_SNAPSHOT_MAX_PER_OP_BYTES} 即拒记（调用方 fail-safe 跳过该文件）。
   * 旧文档缺该字段 ⇒ 从 0 起算（软闸；总量档 sweep 用实算值兜底，不依赖这字段）。
   */
  snapshotBytes?: number;
}

export interface OpsJournalDeps {
  bridge: PlatformBridge;
  /** undo/abort 回滚用户文件的唯一通道（过闸）；backup 用于回滚前兜底存现状 */
  io: Pick<FileIO, 'writeBytes' | 'removeFile' | 'backup'>;
  log: Logger;
}

export class OpsJournalImpl implements OpJournal {
  /** 进行中的 op（begin→commit/abort 周期；单用户桌面应用按串行操作设计，不做并发防护） */
  private readonly open = new Map<string, OpDoc>();
  /** 清理残留失败的累计次数（跨巡检保留——盘上的东西不会因为我们删不动就消失） */
  private cleanupFailures = 0;
  private maintenance: OpsMaintenance = {
    openOrphanDocs: 0,
    rollbackFailedDocs: 0,
    unreadableDocs: 0,
    orphanSnapshotDirs: 0,
    cleanupFailures: 0,
    checkedAt: 0,
  };

  constructor(private readonly deps: OpsJournalDeps) {}

  /**
   * 最近一次 `list()` 巡检得到的维护状态（崩溃残留 / 回滚失败留痕 / 孤儿快照目录）。
   * 未巡检过就是全零。
   */
  maintenanceReport(): OpsMaintenance {
    return { ...this.maintenance };
  }

  private async root(): Promise<string> {
    return join(await this.deps.bridge.appDataDir(), 'ops');
  }

  private async opDocPath(id: string): Promise<string> {
    if (!OP_ID_RE.test(id)) throw new Error(`无效的操作 id：${id}`);
    return join(await this.root(), `${id}${OP_DOC_SUFFIX}`);
  }

  private async snapshotDir(id: string): Promise<string> {
    if (!OP_ID_RE.test(id)) throw new Error(`无效的操作 id：${id}`);
    return join(await this.root(), id);
  }

  private async writeDoc(doc: OpDoc): Promise<void> {
    const path = await this.opDocPath(doc.id);
    await this.deps.bridge.writeFileBytes(path, new TextEncoder().encode(JSON.stringify(doc, null, 2)));
  }

  private async readDoc(id: string): Promise<OpDoc> {
    const path = await this.opDocPath(id);
    let raw: unknown;
    try {
      const bytes = await this.deps.bridge.readFileBytes(path);
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch (err) {
      throw new Error(`操作记录不可读：${id} — ${String(err)}`);
    }
    const doc = raw as Partial<OpDoc>;
    if (
      doc.v !== 1 ||
      typeof doc.id !== 'string' ||
      typeof doc.kind !== 'string' ||
      typeof doc.label !== 'string' ||
      !Array.isArray(doc.entries) ||
      (doc.status !== 'open' && doc.status !== 'committed' && doc.status !== 'undone')
    ) {
      throw new Error(`操作记录形态不对：${id}`);
    }
    return doc as OpDoc;
  }

  async begin(kind: string, label: string): Promise<string> {
    // 尾部必须恒为 6 位 [a-z0-9]：Math.random().toString(36) 常不足 6 位（尾零被吞），
    // 裸 slice(2,8) 会造出过不了自家 OP_ID_RE 的 id ⇒ begin 自拒「无效的操作 id」。补零固定长度。
    const id = `op-${timestamp()}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
    const doc: OpDoc = {
      v: 1,
      id,
      kind,
      label,
      status: 'open',
      startedAt: Date.now(),
      finishedAt: null,
      entries: [],
    };
    this.open.set(id, doc);
    await this.writeDoc(doc);
    return id;
  }

  async record(opId: string, path: string): Promise<void> {
    const doc = this.open.get(opId);
    if (!doc) throw new Error(`操作不在进行中（commit/abort 之后）：${opId}`);
    const key = pathKey(path);
    if (doc.entries.some((e) => pathKey(e.path) === key)) return; // 以第一次为准（见模块头注）

    let beforePath: string | null = null;
    let encoding: FileEncoding | null = null;
    let eol: EolStyle | null = null;
    let createdDirs: string[] | undefined;
    try {
      const bytes = await this.deps.bridge.readFileBytes(path);
      // 单 op 字节上限（2026-10-18）：超限**拒记**——记不了账的文件由调用方 fail-safe 不写
      // （绝不静默落一个"写得出却撤不回"的文件）。此刻快照未写、entry 未 push，op 状态干净。
      const carried = doc.snapshotBytes ?? 0;
      if (carried + bytes.length > OP_SNAPSHOT_MAX_PER_OP_BYTES) {
        throw new Error(
          `本操作的字节快照将超过单操作上限（已 ${carried}B + 本文件 ${bytes.length}B > ` +
            `${OP_SNAPSHOT_MAX_PER_OP_BYTES}B）：${path} 未记账，调用方应跳过该文件并如实报告`,
        );
      }
      beforePath = `${doc.entries.length}.before`;
      const dir = await this.snapshotDir(opId);
      await this.deps.bridge.writeFileBytes(join(dir, beforePath), bytes);
      doc.snapshotBytes = carried + bytes.length;
      const probe = decodeWithProbe(bytes);
      encoding = probe.encoding;
      eol = detectEol(probe.text);
    } catch (err) {
      // 读不动 ≠ 不存在：存在但读不出快照是盘上真错，绝不降级成"新建"（那会让 undo 删掉它）
      if (await this.deps.bridge.exists(path)) throw err;
      // 确认是"操作内新建"：把此刻**还不存在的祖先目录**记下来——
      // 撤销时只有它们有被清空的资格（之前就存在的目录永远不许 undo 删）。
      createdDirs = await this.missingAncestors(path);
    }
    doc.entries.push({ path, beforePath, encoding, eol, ...(createdDirs ? { createdDirs } : {}) });
    await this.writeDoc(doc);
  }

  async commit(opId: string): Promise<void> {
    const doc = this.open.get(opId);
    if (!doc) throw new Error(`操作不在进行中（commit/abort 之后）：${opId}`);
    doc.status = 'committed';
    doc.finishedAt = Date.now();
    await this.writeDoc(doc);
    this.open.delete(opId);
    // 保留期收口（2026-10-17 修复批）：op-<id>/ 字节快照此前永不清理（removeOpArtifacts
    // 只在 abort 成功与 undo 失败路径调），重编码全库级的快照会永久占满 appData。
    // undo 依赖快照 ⇒ 只按 startedAt 保留最近 N 个已完结 op，超限连文档带快照整体清掉。
    await this.sweepSnapshotRetention();
  }

  async abort(opId: string): Promise<void> {
    const doc = this.open.get(opId);
    if (!doc) throw new Error(`操作不在进行中（commit/abort 之后）：${opId}`);
    this.open.delete(opId);
    let rollbackErr: unknown = null;
    try {
      await this.rollbackEntries(doc.id, doc.entries);
    } catch (err) {
      rollbackErr = err;
    }
    if (rollbackErr === null) {
      // 回滚即撤销：op 文档与快照目录整体清掉（半批态不留痕）。
      // 清理失败不炸调用方，但必须出声并计入维护提示（残留看得见）。
      await this.removeOpArtifacts(opId);
      return;
    }
    // 回滚半途失败：**绝不清快照**——盘上是半批态，快照是唯一还能救命的东西。
    // 文档停在 open 态（不进 list、不可 undo）+ 打 rollbackError 留痕，
    // 由 list() 的维护提示点名；错误照常上抛给调用方（不静默）。
    doc.rollbackError = errorSummary(rollbackErr);
    try {
      await this.writeDoc(doc);
    } catch (err) {
      this.deps.log.warn(`ops journal：回滚失败留痕写不进文档：${opId} — ${String(err)}`);
    }
    this.deps.log.warn(
      `ops journal：abort 回滚失败，快照与文档已保留待人工处置：${opId}（${doc.rollbackError}）`,
    );
    throw rollbackErr;
  }

  /** 删掉 op 的快照目录与文档；任一失败 ⇒ warn + 计入 cleanupFailures（不抛，交由维护提示） */
  private async removeOpArtifacts(opId: string): Promise<void> {
    const dir = await this.snapshotDir(opId);
    await this.removeQuietly('dir', dir);
    await this.removeQuietly('file', await this.opDocPath(opId));
  }

  private async removeQuietly(kind: 'dir' | 'file', path: string): Promise<void> {
    try {
      if (kind === 'dir') await this.deps.bridge.removeDir(path);
      else await this.deps.bridge.removeFile(path);
    } catch (err) {
      this.cleanupFailures++;
      this.deps.log.warn(`ops journal：清理残留${kind === 'dir' ? '目录' : '文件'}失败（仍在盘上）：${path} — ${String(err)}`);
    }
  }

  /**
   * 保留期清扫：已完结（committed/undone）op 按 `startedAt` 只留最近
   * {@link OP_SNAPSHOT_RETENTION_MAX} 个；此后若快照字节总量仍超
   * {@link OP_SNAPSHOT_MAX_TOTAL_BYTES}，再从**最旧**的已完结 op 起继续裁到预算内
   * （2026-10-18 字节上限批——只有个数上限时，单个大 op 就能把 appData 占满）。
   * 三种东西**绝不**在这里动：在途 op（正在写快照）；open 态残留（崩溃/回滚失败留痕，
   * 快照是唯一还能救命的东西，模块头注口径）；不可读文档（list() 的维护提示在管）。
   * 字节用 `walkDir(withMetadata)` **实算**（doc 里的 snapshotBytes 是软闸累计，undo op
   * 与旧文档都会让它失真，裁剪判据不依赖它）。清理失败走 removeQuietly（warn +
   * cleanupFailures 计数），不清账不炸调用方；**裁了多少必须出声**（铁律 4）。
   */
  private async sweepSnapshotRetention(): Promise<void> {
    const root = await this.root();
    const entries = await this.deps.bridge.listDir(root).catch(() => []);
    const docs: Array<{ id: string; startedAt: number; status: 'open' | 'committed' | 'undone' }> = [];
    for (const e of entries) {
      if (e.isDirectory || !e.name.endsWith(OP_DOC_SUFFIX)) continue;
      const id = e.name.slice(0, -OP_DOC_SUFFIX.length);
      if (!OP_ID_RE.test(id) || this.open.has(id)) continue;
      try {
        const doc = await this.readDoc(id);
        docs.push({ id, startedAt: doc.startedAt, status: doc.status });
      } catch {
        // 不可读文档交给维护提示，不在保留期里动它
      }
    }
    docs.sort((a, b) => b.startedAt - a.startedAt);
    const expired = docs.slice(OP_SNAPSHOT_RETENTION_MAX).filter((d) => d.status !== 'open');
    for (const doc of expired) await this.removeOpArtifacts(doc.id);
    if (expired.length > 0) {
      this.deps.log.warn(
        `ops journal：保留期收口，清理超限快照 ${expired.length} 个（上限 ${OP_SNAPSHOT_RETENTION_MAX}，按 startedAt 留最近）`,
      );
    }

    // ---- 字节总量档：保留集（前 OP_SNAPSHOT_RETENTION_MAX 个已完结 op）从最旧起累计 ----
    const kept = docs
      .slice(0, OP_SNAPSHOT_RETENTION_MAX)
      .filter((d) => d.status !== 'open');
    const sized: Array<{ id: string; bytes: number }> = [];
    let total = 0;
    for (const d of kept) {
      const bytes = await this.snapshotBytesOf(d.id);
      sized.push({ id: d.id, bytes });
      total += bytes;
    }
    if (total <= OP_SNAPSHOT_MAX_TOTAL_BYTES) return;
    // kept 按新→旧排；从最旧（尾部）开始裁，直到总量进预算。被裁的 op 不可再 undo
    // （undo() 的保留期护栏会显式拒绝并提示走备份时间线），不猜、不半裁。
    let over = total;
    const victims: string[] = [];
    for (let i = sized.length - 1; i >= 0 && over > OP_SNAPSHOT_MAX_TOTAL_BYTES; i--) {
      const v = sized[i]!;
      victims.push(v.id);
      over -= v.bytes;
    }
    for (const id of victims) await this.removeOpArtifacts(id);
    this.deps.log.warn(
      `ops journal：快照字节总量超限（实算 ${total}B > 上限 ${OP_SNAPSHOT_MAX_TOTAL_BYTES}B），` +
        `按最旧先裁清理 ${victims.length} 个操作的快照（裁后约 ${over}B；被裁操作不可再撤销，可从备份时间线恢复）`,
    );
  }

  /** 某 op 快照目录的实算字节数（目录不在位 / 枚举失败 ⇒ 0——它本来就不占盘） */
  private async snapshotBytesOf(opId: string): Promise<number> {
    const dir = await this.snapshotDir(opId);
    const files = await this.deps.bridge.walkDir(dir, { includeFiles: true, withMetadata: true }).catch(() => null);
    if (files === null) return 0;
    let sum = 0;
    for (const f of files) {
      if (f.isDirectory) continue;
      sum += f.size ?? 0;
    }
    return sum;
  }

  async list(): Promise<OpRecord[]> {
    const root = await this.root();
    const entries = await this.deps.bridge.listDir(root).catch(() => []);
    const out: OpRecord[] = [];
    let openOrphanDocs = 0;
    let rollbackFailedDocs = 0;
    let unreadableDocs = 0;
    const docIds = new Set<string>();

    for (const e of entries) {
      if (e.isDirectory || !e.name.endsWith(OP_DOC_SUFFIX)) continue;
      const id = e.name.slice(0, -OP_DOC_SUFFIX.length);
      if (!OP_ID_RE.test(id)) continue;
      docIds.add(id);
      let doc: OpDoc;
      try {
        doc = await this.readDoc(id);
      } catch (err) {
        unreadableDocs++;
        this.deps.log.warn(`ops journal：操作文档不可读（跳过）：${e.name} — ${String(err)}`);
        continue;
      }
      if (doc.status === 'open') {
        // 进行中 / 崩溃残留 / 回滚失败留痕（模块头注的取舍）：不列进历史，但必须计数并出声
        if (!this.open.has(doc.id)) openOrphanDocs++;
        if (doc.rollbackError !== undefined) rollbackFailedDocs++;
        continue;
      }
      out.push({
        id: doc.id,
        kind: doc.kind,
        label: doc.label,
        startedAt: doc.startedAt,
        finishedAt: doc.finishedAt,
        status: doc.status,
        fileCount: doc.entries.length,
      });
    }

    // 快照目录侧巡检：没有对应文档（或文档不可读）的 op-<id>/ 就是占盘孤儿
    let orphanSnapshotDirs = 0;
    for (const e of entries) {
      if (!e.isDirectory || !OP_ID_RE.test(e.name)) continue;
      if (!docIds.has(e.name)) orphanSnapshotDirs++;
    }

    this.maintenance = {
      openOrphanDocs,
      rollbackFailedDocs,
      unreadableDocs,
      orphanSnapshotDirs,
      cleanupFailures: this.cleanupFailures,
      checkedAt: Date.now(),
    };
    if (openOrphanDocs + rollbackFailedDocs + unreadableDocs + orphanSnapshotDirs + this.cleanupFailures > 0) {
      this.deps.log.warn(
        `ops journal 维护提示：崩溃/回滚失败残留 open 文档 ${openOrphanDocs}（其中回滚失败 ${rollbackFailedDocs}）、` +
          `不可读文档 ${unreadableDocs}、孤儿快照目录 ${orphanSnapshotDirs}、清理失败 ${this.cleanupFailures}；` +
          '它们不进入历史也不响应 undo，占盘待人工处置',
      );
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  async entriesOf(opId: string): Promise<OpEntryView[]> {
    const doc = await this.readDoc(opId);
    return doc.entries.map((e) => ({
      path: e.path,
      hasBefore: e.beforePath !== null,
      encoding: e.encoding,
      eol: e.eol,
    }));
  }

  async undo(opId: string): Promise<string> {
    const doc = await this.readDoc(opId);
    if (doc.status === 'open') throw new Error(`操作仍在进行中，不能撤销：${opId}`);
    if (doc.entries.length === 0) throw new Error(`操作没有记录任何文件，无从撤销：${opId}`);
    // 保留期护栏（2026-10-17 修复批）：要回滚的 `${i}.before` 快照住在 op 的快照目录里，
    // 目录被按上限清掉后再 undo 会在回滚半途爆炸（半批态）。这里先行核验、显式拒绝——
    // 不猜、不半撤销；只在确有快照依赖时才拦（纯新建 op 的撤销不读快照，不受保留期约束）。
    if (
      doc.entries.some((e) => e.beforePath !== null) &&
      !(await this.deps.bridge.exists(await this.snapshotDir(opId)))
    ) {
      throw new Error(`操作快照已按保留上限清理，无法撤销：${opId}（可从备份时间线恢复需要的版本）`);
    }
    // 撤销也进历史：先抓"回滚前"快照（此刻盘上=回滚前状态），再逆序回滚
    const undoId = await this.begin(`undo:${doc.kind}`, `撤销：${doc.label}`);
    const undoDoc = this.open.get(undoId)!;
    let rolledBack = false; // 是否已动过盘（动过 ⇒ 快照是唯一救命稻草，不许删）
    try {
      for (let i = doc.entries.length - 1; i >= 0; i--) {
        await this.record(undoId, doc.entries[i]!.path);
      }
      rolledBack = true;
      await this.rollbackEntries(doc.id, doc.entries);
      await this.commit(undoId);
    } catch (err) {
      this.open.delete(undoId);
      if (rolledBack) {
        // 与 abort 同一口径：半批态下**保留** undo op 的快照与文档并留痕（见 maintenanceReport）
        undoDoc.rollbackError = errorSummary(err);
        try {
          await this.writeDoc(undoDoc);
        } catch (writeErr) {
          this.deps.log.warn(`ops journal：undo 回滚失败留痕写不进文档：${undoId} — ${String(writeErr)}`);
        }
        this.deps.log.warn(
          `ops journal：undo 回滚失败，撤销前快照已保留待人工处置：${undoId}（${undoDoc.rollbackError}）`,
        );
      } else {
        // 抓快照阶段就失败：盘还没动 ⇒ undo op 自身按失败清理，无痕
        await this.removeOpArtifacts(undoId);
      }
      // 原 op 状态不动（下次可再试）
      throw err;
    }
    doc.status = 'undone';
    doc.finishedAt = Date.now();
    await this.writeDoc(doc);
    return undoId;
  }

  /** 逆序回滚（abort 与 undo 共用的唯一回滚实现） */
  private async rollbackEntries(opId: string, entries: JournalEntryRec[]): Promise<void> {
    const createdDirs = new Set<string>();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.beforePath === null) {
        // 操作内新建的文件：删掉（removeFile 过闸；移入回收站兜底，不真丢）。
        // 连带登记**record 时刻确认尚不存在**的祖先目录（= 本 op 自己创建的），
        // 空了才有资格被清；之前就存在的父目录永不出现在这个集合里。
        if (await this.deps.bridge.exists(e.path)) {
          for (const dir of e.createdDirs ?? []) createdDirs.add(dir);
          await this.deps.io.removeFile(e.path);
        }
        continue;
      }
      const bytes = await this.deps.bridge.readFileBytes(join(await this.snapshotDir(opId), e.beforePath));
      // 回滚前把"现状"备份一把（尽力而为）：undo 写错也比 undo 丢数据好
      await this.deps.io.backup(e.path).catch((err: unknown) => {
        this.deps.log.warn(`ops journal：回滚前备份失败（继续回滚）：${e.path} — ${String(err)}`);
      });
      await this.deps.io.writeBytes(e.path, bytes);
    }
    await this.cleanupCreatedDirs(createdDirs);
  }

  private async parentOf(path: string): Promise<string> {
    const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return i > 0 ? path.slice(0, i) : path;
  }

  /**
   * 从给定路径向上收集**此刻不存在**的祖先目录（深→浅，遇到第一个存在的即停）。
   * record 时机调用：这些目录是本 op 将要创建的 ⇒ 撤销时才有被清空的资格。
   */
  private async missingAncestors(filePath: string): Promise<string[]> {
    const out: string[] = [];
    let dir = await this.parentOf(filePath);
    for (let guard = 0; guard < MAX_DIR_ANCESTORS; guard++) {
      if (!dir) break;
      if (await this.deps.bridge.exists(dir)) break;
      out.push(dir);
      const parent = await this.parentOf(dir);
      if (!parent || parent === dir) break; // 到根（`C:` 之类）为止
      dir = parent;
    }
    return out;
  }

  /**
   * 新建文件删掉后，只含它们的目录会残留空壳——空制品目录会让 createArtifact 的
   * exists 判定误判 already exists。清**确实空了**的目录，且**只清候选集里的**
   * （候选 = record 时刻不存在、即本 op 自己创建的目录）：
   * 本 op 之前就存在的空父目录绝不被撤销删掉（2026-10-17 修复，不向父目录外扩）。
   */
  private async cleanupCreatedDirs(dirs: Set<string>): Promise<void> {
    // 深→浅：子目录先删，父目录才有机会变空
    const depth = (p: string): number => (p.match(/[/\\]/g)?.length ?? 0);
    const sorted = [...dirs].sort((a, b) => depth(b) - depth(a) || b.length - a.length);
    for (const dir of sorted) {
      const entries = await this.deps.bridge.listDir(dir).catch(() => null);
      if (entries === null) {
        this.deps.log.warn(`ops journal：空目录巡检读不出，跳过清理：${dir}`);
        continue;
      }
      if (entries.length > 0) continue; // 非空自然停（别人的东西不许动）
      await this.removeQuietly('dir', dir);
    }
  }
}

function errorSummary(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * ops 快照保留上限（按 `startedAt` 计的**已完结** op 数）：超出即连文档带快照目录
 * 整体清掉。没有这条上限，op-<id>/ 字节快照只增不减——重编码全库级的快照会把
 * appData 永久占满。open 态残留（崩溃/回滚失败留痕）不参与保留期计数（见 sweep）。
 */
export const OP_SNAPSHOT_RETENTION_MAX = 20;
/**
 * 单个 op 的字节快照上限（2026-10-18 字节上限批）：record 时累计校验，超限**拒记**
 * （抛错给调用方 ⇒ fail-safe 跳过该文件并如实报告——绝不落一个"写得出却撤不回"的
 * 文件，也不静默吞掉上限）。取值依据 STATE §W 尺子：全盘 603MB、最大单文件 2.35MB，
 * 全库级替换（4,000 文件 × 平均 ~60KB ≈ 240MB）在预算内；512MB 给足余量同时把
 * "单个 op 占满 appData"的量级封死。
 */
export const OP_SNAPSHOT_MAX_PER_OP_BYTES = 512 * 1024 * 1024;

/**
 * ops 快照目录字节总量上限：commit 后的 sweep 实算全部已完结 op 快照字节数，超限从
 * **最旧**起裁（先过个数档、再过字节档；被裁 op 不可再 undo，undo 的护栏会显式拒绝
 * 并提示走备份时间线）。与备份账（1GB）、回收站账（2GB）合计给 appData 封一个
 * 有界的顶（~4GB），"大批部署+删除短时占满 appData"由此封死。
 */
export const OP_SNAPSHOT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
