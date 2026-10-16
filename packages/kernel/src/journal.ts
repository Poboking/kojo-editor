import type {
  EolStyle,
  FileEncoding,
  FileIO,
  Logger,
  OpEntryView,
  OpJournal,
  OpRecord,
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
 * journal 目录维护状态（`list()` 巡检时刷新；铁律 #4——残留必须看得见）。
 * 不进 `OpJournal` 契约（那是给插件的历史面），只经 `OpsJournalImpl.maintenanceReport()`
 * 与内核日志呈现，避免契约消费方误把它当可 undo 的操作。
 */
export interface OpsMaintenance {
  /** 崩溃残留 / 回滚失败保留的 open 态操作文档（不列历史、不响应 undo） */
  openOrphanDocs: number;
  /** 其中 abort 回滚失败、快照被刻意保留待人工处置的文档数 */
  rollbackFailedDocs: number;
  /** 读不出或形态不对的操作文档 */
  unreadableDocs: number;
  /** 没有对应可提交文档的快照目录（op-&lt;id&gt; 残留，占盘） */
  orphanSnapshotDirs: number;
  /** 清理残留时 removeDir/removeFile 失败的次数（盘上仍在，下次巡检仍会计数） */
  cleanupFailures: number;
  /** 本次巡检时间戳 */
  checkedAt: number;
}

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
      beforePath = `${doc.entries.length}.before`;
      const dir = await this.snapshotDir(opId);
      await this.deps.bridge.writeFileBytes(join(dir, beforePath), bytes);
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
