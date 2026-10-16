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
 * - 崩溃残留的 open 态 json 不进 list（entries 可能不完整，半批回滚比不回滚更险）；
 *   它们静静躺着（30 天后可考虑接入 trash purge 的口径，本批不做）；
 * - undo 本身也是一次 op（kind=`undo:<原kind>`，entries=回滚前状态）——
 *   对已撤销操作再撤销 = 重做，重做能力由此**免费**获得，不另造 redo 栈。
 */

const OP_DOC_SUFFIX = '.json';

/** op id 形态（`op-<ts>-<rand6>`；读写只认它，不放宽——路径不可逃逸出 ops 根） */
export const OP_ID_RE = /^op-\d{8}-\d{6}-\d{3}-[a-z0-9]{6}$/;

interface JournalEntryRec {
  path: string;
  /** 相对 op 快照目录的文件名；null = 操作内新建 */
  beforePath: string | null;
  encoding: FileEncoding | null;
  eol: EolStyle | null;
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

  constructor(private readonly deps: OpsJournalDeps) {}

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
    const id = `op-${timestamp()}-${Math.random().toString(36).slice(2, 8)}`;
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
    }
    doc.entries.push({ path, beforePath, encoding, eol });
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
    try {
      await this.rollbackEntries(doc.id, doc.entries);
    } finally {
      // 回滚即撤销：op 文档与快照目录整体清掉（半批态不留痕）。
      // 清理失败不出声——孤儿文档不进 list，无副作用面。
      const dir = await this.snapshotDir(opId);
      await this.deps.bridge.removeDir(dir).catch(() => undefined);
      await this.deps.bridge.removeFile(await this.opDocPath(opId)).catch(() => undefined);
    }
  }

  async list(): Promise<OpRecord[]> {
    const root = await this.root();
    const entries = await this.deps.bridge.listDir(root).catch(() => []);
    const out: OpRecord[] = [];
    for (const e of entries) {
      if (e.isDirectory || !e.name.endsWith(OP_DOC_SUFFIX)) continue;
      const id = e.name.slice(0, -OP_DOC_SUFFIX.length);
      if (!OP_ID_RE.test(id)) continue;
      let doc: OpDoc;
      try {
        doc = await this.readDoc(id);
      } catch (err) {
        this.deps.log.warn(`ops journal：操作文档不可读（跳过）：${e.name} — ${String(err)}`);
        continue;
      }
      if (doc.status === 'open') continue; // 进行中/崩溃残留（模块头注的取舍）
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
    try {
      for (let i = doc.entries.length - 1; i >= 0; i--) {
        await this.record(undoId, doc.entries[i]!.path);
      }
      await this.rollbackEntries(doc.id, doc.entries);
      await this.commit(undoId);
    } catch (err) {
      this.open.delete(undoId);
      // undo op 自己进入失败清理；原 op 状态不动（下次可再试）
      const dir = await this.snapshotDir(undoId);
      await this.deps.bridge.removeDir(dir).catch(() => undefined);
      await this.deps.bridge.removeFile(await this.opDocPath(undoId)).catch(() => undefined);
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
        // 操作内新建的文件：删掉（removeFile 过闸；移入回收站兜底，不真丢）
        if (await this.deps.bridge.exists(e.path)) {
          createdDirs.add(await this.parentOf(e.path));
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
    await this.cleanupEmptyDirs(createdDirs);
  }

  private async parentOf(path: string): Promise<string> {
    const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return i > 0 ? path.slice(0, i) : path;
  }

  /**
   * 新建文件删掉后，只含它们的父目录链会残留空壳——空制品目录会让
   * createArtifact 的 exists 判定误判 already exists。自深向浅清**确实空了**的
   * 目录（listDir 无条目才删；非空自然停——项目根上有 manifest，盘根/用户根不会空）。
   */
  private async cleanupEmptyDirs(dirs: Set<string>): Promise<void> {
    const queue = [...dirs];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const dir = queue.pop()!;
      const entries = await this.deps.bridge.listDir(dir).catch(() => null);
      if (entries === null || entries.length > 0) continue;
      await this.deps.bridge.removeDir(dir).catch(() => undefined);
      const parent = await this.parentOf(dir);
      if (parent && parent !== dir && !seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
}
