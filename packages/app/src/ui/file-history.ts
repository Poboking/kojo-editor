import type { BackupVersion, FileIO, OpEntryView, OpJournal, OpRecord, TrashEntry } from '@kojo/plugin-api';
import {errorText,  basename, isPathUnder, join, pathKey } from '@kojo/plugin-api';
import { AUTOSAVE_DIR_NAME, readAutosaveView, type AutosaveSnapshotInfo } from './autosave-journal';
import { opKindLabel } from './ops-history';
import { peekRecoveredContent } from './recovery-store';

/**
 * 本地时间线（F2）的宿主纯逻辑（2026-10-15 历史批；W11 回收站可见批扩成「四本账一条时间线」）。
 *
 * 版本数据全部来自**既有落点**：写前自动备份（`listBackups`）、回收站（`listTrash`）、
 * 批操作 journal（`OpJournal.list` + `entriesOf`）、未保存快照（`{appData}/autosave` 的
 * manifest + 进程内恢复件）。本层只做**取数、合并、排序、去重与人读文案**——
 * 刻意不发明第二套备份/回收站/快照约定，也**一条写盘通道都不碰**：
 * 每条时间线条目的动作都指回那本账自己既有的恢复链路。
 */

/** ui.overlay 贡献 id（宿主注册；命令 run 里发 `ui.overlay.open`） */
export const FILE_HISTORY_OVERLAY_ID = 'kojo.fileHistory';

/** editor.command 贡献 id（命令面板条目：「显示当前文件的历史版本」） */
export const SHOW_FILE_HISTORY_COMMAND_ID = 'kojo.showFileHistory';

/** 版本时刻的人读文本（文件名时间戳优先——mtime 会被复制/同步改写，文件名不会说谎） */
export function formatVersionTime(v: Pick<BackupVersion, 'takenAtMs' | 'mtimeMs'>): string {
  const ms = v.takenAtMs ?? v.mtimeMs;
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 字节数人读（阈值 1024，一档到位；历史列表不需要三位小数） */
export function formatVersionSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/* ------------------------------ 状态单源 ------------------------------ */

let target: string | null = null;
const listeners = new Set<() => void>();

export function getFileHistoryTarget(): string | null {
  return target;
}

export function setFileHistoryTarget(next: string | null): void {
  target = next;
  for (const cb of [...listeners]) cb();
}

export function subscribeFileHistory(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/* ==================== 一条时间线，四本账（W11 回收站可见批） ==================== */

/**
 * 同一个文件的"过去"散在四本账里，而四本账**互不相认**：写前备份（`{appData}/backup`）、
 * 批操作快照（`{appData}/ops`）、回收站（`{appData}/trash`）、未保存快照
 * （`{appData}/autosave` + 进程内恢复件）。作者对着同一个文件问"恢复"能拿到四种互相矛盾
 * 的答案；而回收站那本账此前**连读面都没有**——删了就是看不见、也回不来。
 *
 * 本层只做一件事：**四本账并成一条按时刻排序的时间线**，每条写清楚
 * ①它来自哪本账 ②恢复它意味着什么 ③跨账的坑（整批回滚 / 目录级恢复 / 编辑器里还有更新的
 * 一份 / 写允许域已收回）。**不新增第五个列表**，也不新增写盘通道。
 */

/** 账本身份（`recovery` = autosave 账的"已装载进恢复通道、尚未被编辑器领走"形态） */
export type TimelineAccount = 'backup' | 'ops' | 'trash' | 'autosave' | 'recovery';

export const TIMELINE_ACCOUNT_LABEL: Record<TimelineAccount, string> = {
  backup: '写前备份',
  ops: '批操作快照',
  trash: '回收站',
  autosave: '未保存快照',
  recovery: '崩溃恢复件',
};

/**
 * 同一时刻**必须有全序**，否则两次渲染的行序会漂（React key 跟着漂 = 列表闪）。
 * 序按"离此刻多近"：进程内恢复件 > 未保存快照 > 回收站 > 批操作 > 写前备份。
 */
const ACCOUNT_TIE_ORDER: readonly TimelineAccount[] = ['recovery', 'autosave', 'trash', 'ops', 'backup'];

/** 恢复动作的分派标识（组件按它走**那本账既有**的通道；本层不碰写盘） */
export type TimelineActionKind = 'restoreBackup' | 'undoOp' | 'restoreTrash' | 'writeBackSnapshot';

export interface TimelineAction {
  kind: TimelineActionKind;
  /** 传给通道的句柄：备份版本号 / op id / 回收站条目 id / 快照落点路径 */
  id: string;
  label: string;
}

export interface TimelineItem {
  /** 去重与 React key 的身份 = `<account>:<id>`（同账同 id 只留一条） */
  key: string;
  account: TimelineAccount;
  /** 账本内身份（备份版本号 / op id / 回收站条目 id / 快照所属文件路径） */
  id: string;
  /** 时刻（ms）；null = 这本账说不清它是什么时候的（沉底，不猜） */
  atMs: number | null;
  /** 这一条是什么（账本名之外的人读标题） */
  title: string;
  /** 恢复它意味着什么（含跨账后果；说人话） */
  meaning: string;
  size: number | null;
  /** 可以交给 diff 的盘上路径（null = 这一条没有"单个可比对文件"的形态） */
  diffPath: string | null;
  /** 恢复动作（null = 只能看不能动；`meaning` 与 `warnings` 已写了为什么） */
  action: TimelineAction | null;
  /** 跨账互斥 / 期限提醒（逐条渲染在行下——作者是在"挑哪一版"时需要这些话） */
  warnings: string[];
  /** 回收站条目：剩余保留天数（向下取整；负数 = 已过保留期，随时可能被顺手收走） */
  keepDaysLeft: number | null;
  /**
   * 取数那一刻（= 建本时间线时用的 `nowMs`）——**剩余天数的锚**。
   *
   * `keepDaysLeft` 是按这个锚算出来的静态值。UI 若每秒拿 `Date.now()` 重算，
   * 时钟一过整日边界就会算出负数，进而把"过期"提示与恢复按钮在用户眼前悄悄改掉
   * （返工实录：判据跟着墙钟漂 = 同一屏两次渲染两种说法）。
   * 正确姿势只有一条：**漂移超过一天就重新取数**，不在原地改判据。
   */
  savedAtMs: number;
}

/** 批操作账里与本文件有关的那一条（`OpJournal.list` + `entriesOf` 的投影） */
export interface OpFileSnapshot {
  opId: string;
  kind: string;
  label: string;
  startedAt: number;
  status: OpRecord['status'];
  /** 该批涉及的文件总数——撤销是**整批**动作，这个数字必须出现在文案里 */
  fileCount: number;
  /** 操作前本文件就有内容（false = 这一批新建了它，撤销 = 删掉它） */
  hasBefore: boolean;
}

/** 未保存快照账里的一条（盘上 autosave 清单 与 进程内恢复件 合成同一形状） */
export interface SnapshotEntry {
  /** 通道：recovery = 进程内那份还没被编辑器领走（内容在内存里，没有盘上路径可读） */
  account: 'autosave' | 'recovery';
  /** 快照属于哪个文件 */
  path: string;
  /** 时刻；null = 这本账说不清（该行标"时刻不明"并沉底——**绝不拿 0 冒充 1970 年**） */
  atMs: number | null;
  /** 快照内容的盘上路径（recovery 形态 = null） */
  filePath: string | null;
  /** 快照字节数（拿不到 = null，不拿 0 兜底） */
  size: number | null;
}

/** 四本账的输入切片（结构型：单测拿假账本直喂，不必起真盘） */
export interface FileTimelineInput {
  path: string;
  /** 磁盘此刻有没有这个文件（决定"原位"这件事怎么说） */
  existsOnDisk: boolean;
  /** 第一道闸此刻放行吗（`io.isWritable`）——不放行则四本账全都只能看不能动 */
  writable: boolean;
  backups: readonly BackupVersion[];
  trash: readonly TrashEntry[];
  ops: readonly OpFileSnapshot[];
  snapshots: readonly SnapshotEntry[];
  nowMs?: number;
}

export interface FileTimeline {
  items: TimelineItem[];
  /** 挂在时间线顶部的整屏说明（闸已收回 / 整目录 shadow / 扫描范围……条目级装不下的那些） */
  notes: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 写允许域已收回时的整屏说明（条目级复用同一句话，别处不再写一遍） */
export const NOT_WRITABLE_NOTE =
  '这个路径此刻不在写允许域内（项目未打开 / 授权已收回；游戏目录整体只读）：四本账都读得到，恢复一个也做不了。先打开对应项目或授权工作区再回来。';

/** 排序：时刻新在前（null 沉底）→ 同刻按账本优先级 → 同账同刻按 id（全序，杜绝抖动） */
export function compareTimelineItems(a: TimelineItem, b: TimelineItem): number {
  if (a.atMs !== b.atMs) {
    if (a.atMs === null) return 1;
    if (b.atMs === null) return -1;
    return b.atMs - a.atMs;
  }
  const at = ACCOUNT_TIE_ORDER.indexOf(a.account);
  const bt = ACCOUNT_TIE_ORDER.indexOf(b.account);
  if (at !== bt) return at - bt;
  return a.id.localeCompare(b.id);
}

/** 未保存快照"同一份内容"的身份：同路径 + 同时刻（盘上那份与进程内那份就是这么撞车的） */
const snapshotIdentity = (i: TimelineItem): string => `${i.atMs ?? 'null'}|${i.id}`;

/**
 * 合并 = **去重 + 全序**，两件事都不猜：
 * - 同 `<account>:<id>` 只留**第一条**（同一条 .bak 从两个写法不同的备份桶里各出现一次
 *   就是这一形——同一份字节，不是两个版本）；唯一例外是第一条时刻说不清、后一条给得出时刻，
 *   那种降级项不该占着位置；
 * - `autosave` 与 `recovery` 落在**同一路径同一时刻** ⇒ 只留 `recovery`（进程内那份是活的，
 *   盘上那份只是它的副本；并排摆着会让人以为有两种不同的恢复）；
 * - 之后按 `compareTimelineItems` 排出全序。
 */
export function mergeTimeline(items: readonly TimelineItem[]): TimelineItem[] {
  const byKey = new Map<string, TimelineItem>();
  for (const item of items) {
    const existing = byKey.get(item.key);
    if (existing === undefined) {
      byKey.set(item.key, item);
      continue;
    }
    if (existing.atMs === null && item.atMs !== null) byKey.set(item.key, item);
  }
  const out = [...byKey.values()];
  const live = new Set(out.filter((i) => i.account === 'recovery').map(snapshotIdentity));
  return out
    .filter((i) => !(i.account === 'autosave' && live.has(snapshotIdentity(i))))
    .sort(compareTimelineItems);
}

/** 祖先判定（同删除侧的 `pathKey` 尺；相等不算祖先——"同一个东西"是另一条判据） */
function isAncestorOf(ancestor: string, other: string): boolean {
  return pathKey(ancestor) !== pathKey(other) && isPathUnder(ancestor, other);
}

const msToText = (ms: number): string => formatVersionTime({ takenAtMs: ms, mtimeMs: ms });

/** 账本的"能不能动手"：写允许域已收回时四本账一律只读（按钮不亮，理由在 warnings 里） */
function gate(writable: boolean, action: TimelineAction): TimelineAction | null {
  return writable ? action : null;
}

/**
 * 四本账 → 一条时间线。**纯函数**：全部判据与文案来自入参，不读盘、不问内核，
 * 所以拿假账本就能把排序 / 去重 / 跨账互斥提示钉死（见 `packages/app/tests/file-history.test.ts`）。
 */
export function buildFileTimeline(input: FileTimelineInput): FileTimeline {
  const nowMs = input.nowMs ?? Date.now();
  const items: TimelineItem[] = [];
  const target = pathKey(input.path);

  // 整目录被删 ⇒ 本文件此刻"在回收站里"而不是在磁盘上（最要紧的一种跨账冲突）
  const shadow = input.trash.find((e) => e.kind === 'dir' && isAncestorOf(e.originalPath, input.path));

  const newestSnapshotMs = input.snapshots.reduce<number | null>(
    (acc, s) => {
      if (s.atMs === null) return acc; // 时刻说不清的那份不参与"谁更新"的判定（不拿 0 装最旧）
      return acc === null || s.atMs > acc ? s.atMs : acc;
    },
    null,
  );
  const newestOp = input.ops.reduce<OpFileSnapshot | null>(
    (acc, o) => (acc === null || o.startedAt > acc.startedAt ? o : acc),
    null,
  );

  /* ---------------- 账一：写前自动备份 ---------------- */
  for (const v of input.backups) {
    const warnings: string[] = [];
    if (shadow !== undefined) warnings.push(shadowNote(shadow));
    if (newestSnapshotMs !== null && v.takenAtMs !== null && v.takenAtMs < newestSnapshotMs) {
      warnings.push(
        `编辑器里还有一份 ${msToText(newestSnapshotMs)} 的未保存内容比这一版新：恢复只改磁盘、不动编辑器，随后一次保存会把恢复结果盖掉。先保存、或者先放弃编辑器里的内容。`,
      );
    }
    if (newestOp !== null && v.takenAtMs !== null && v.takenAtMs < newestOp.startedAt) {
      warnings.push(
        `这一版之后还有一次批操作（${msToText(newestOp.startedAt)}「${opLabel(newestOp)}」）动过本文件：用备份恢复不会撤销那一批留下的其他文件。`,
      );
    }
    if (!input.writable) warnings.push(NOT_WRITABLE_NOTE);
    items.push({
      key: `backup:${v.id}`,
      account: 'backup',
      id: v.id,
      atMs: v.takenAtMs ?? v.mtimeMs,
      title: '磁盘内容（保存前的自动备份）',
      meaning:
        '用它覆盖磁盘当前内容。覆盖前，磁盘当前内容会先自动备份进本时间线——恢复不会吃掉现状（内核写盘双闸，字节级零转码）。',
      size: v.size,
      diffPath: v.path,
      action: gate(input.writable, { kind: 'restoreBackup', id: v.id, label: '恢复这一版' }),
      warnings,
      keepDaysLeft: null,
      savedAtMs: nowMs,
    });
  }

  /* ---------------- 账二：批操作 journal ---------------- */
  for (const o of input.ops) {
    const undoable = o.status === 'committed';
    const warnings: string[] = [];
    if (shadow !== undefined) warnings.push(shadowNote(shadow));
    if (o.fileCount > 1) warnings.push(`撤销是整批动作：那一批共涉及 ${o.fileCount} 个文件，不只本文件。`);
    warnings.push(
      '回滚不动编辑器的撤销栈：游戏目录里的文件按外部改动口径自动重载，工作区里的文件（如 .kojo 源）请重新打开该标签查看。',
    );
    if (!input.writable) warnings.push(NOT_WRITABLE_NOTE);
    items.push({
      key: `ops:${o.opId}`,
      account: 'ops',
      id: o.opId,
      atMs: o.startedAt,
      title: undoable ? `批操作「${opLabel(o)}」` : `批操作「${opLabel(o)}」（已撤销）`,
      meaning: undoable
        ? o.hasBefore
          ? '撤销 = 本文件回到那一批开始前的内容。现状不会丢：撤销前内核会把回滚前的内容再记一批快照，同样出现在本时间线上。'
          : '那一批新建了本文件，撤销 = 把它删掉；删除的落点是回收站，之后还能从本时间线放回原位。'
        : '这一批已经被撤销；对它再撤销一次 = 重做原操作（同样回滚整批）。',
      size: null,
      diffPath: null,
      action: gate(input.writable, { kind: 'undoOp', id: o.opId, label: undoable ? '撤销这一批' : '重做这一批' }),
      warnings,
      keepDaysLeft: null,
      savedAtMs: nowMs,
    });
  }

  /* ---------------- 账三：回收站 ---------------- */
  for (const e of input.trash) {
    const extra = trashExtraNotes(e, input.trash);
    if (e.kind === 'dir' && pathKey(e.originalPath) !== target && isAncestorOf(e.originalPath, input.path)) {
      extra.push('本文件在当时那个目录里：这一条放回的是整个目录（含本文件），不会只放出本文件一个。');
    }
    if (e.kind === 'file' && pathKey(e.originalPath) === target && input.existsOnDisk) {
      extra.push('原位此刻又站着一个文件：放回前它会先被备份进本时间线（不吃掉现状），随后被这份旧字节换掉。');
    }
    items.push(trashTimelineItem(e, { writable: input.writable, nowMs, extraWarnings: extra }));
  }

  /* ---------------- 账四：未保存快照（盘上 autosave + 进程内恢复件） ---------------- */
  for (const s of input.snapshots) {
    const warnings: string[] = [];
    if (shadow !== undefined) warnings.push(shadowNote(shadow));
    if (!input.writable) warnings.push(NOT_WRITABLE_NOTE);
    items.push({
      key: `${s.account}:${s.path}`,
      account: s.account,
      id: s.path,
      atMs: s.atMs,
      title: s.account === 'recovery' ? '崩溃前的未保存内容' : '编辑器未保存快照',
      meaning:
        s.account === 'recovery'
          ? '写回磁盘 = 把上次崩溃留下、还没被编辑器领走的那份内容落到原路径（磁盘现状先自动备份进本时间线）。写回不会把它从恢复通道里取走。'
          : '写回磁盘 = 把这份防抖快照落到原路径（磁盘现状先自动备份进本时间线，编码/EOL 按盘上文件自己保）。它不会替换编辑器此刻的内存内容——若编辑器里更新，随后一次保存会盖掉这次恢复。',
      size: s.size,
      diffPath: s.filePath,
      action: gate(input.writable, { kind: 'writeBackSnapshot', id: s.filePath ?? s.path, label: '写回磁盘' }),
      warnings,
      keepDaysLeft: null,
      savedAtMs: nowMs,
    });
  }

  /* ---------------- 整屏说明（条目级装不下的那些） ---------------- */
  const notes: string[] = [];
  if (!input.writable) notes.push(NOT_WRITABLE_NOTE);
  if (shadow !== undefined && !input.existsOnDisk) {
    notes.push(
      `本文件此刻不在原位——它随「${basename(shadow.originalPath)}」在 ${msToText(shadow.deletedAtMs)} 一起进了回收站。先把那个目录放回原位，再谈恢复下面这些版本：否则磁盘上会出现两份彼此不认识的同名文件。`,
    );
  }
  if (input.existsOnDisk && items.length === 0) {
    notes.push('这四本账都没有本文件的条目：保存过一次才会有写前备份；批操作、删除、崩溃快照各记各的。');
  }
  return { items: mergeTimeline(items), notes };
}

/**
 * 回收站条目**跨条目**的提示（两屏共用一份算法：某个文件的时间线 / 全局那一屏）：
 * - 整目录条目：写明"放回原位动的是整棵子树"，不是某一个文件；
 * - 同一原路径上站着多份条目（删了、又新建、又删）：写明共几份、最新一份的时刻——
 *   不写这一条，用户挑中的很可能就是最旧那一份，而恢复按钮上什么提示都没有。
 *
 * `ofPath` 用 `pathKey` 折叠（同删除侧一把尺）：Windows 两种写法是同一份东西。
 */
export function trashExtraNotes(entry: TrashEntry, all: readonly TrashEntry[]): string[] {
  const notes: string[] = [];
  const same = all.filter((e) => pathKey(e.originalPath) === pathKey(entry.originalPath));
  if (entry.kind === 'dir') {
    notes.push('整目录条目：放回原位动的是整棵子树，不是某一个文件；原位已有同名目录时这一步会被拒绝。');
  }
  if (same.length > 1) {
    const newest = Math.max(...same.map((e) => e.deletedAtMs));
    notes.push(`同一路径在回收站里有 ${same.length} 份条目，最新一份是 ${msToText(newest)}——挑错一份就换错一份内容。`);
  }
  return notes;
}

/** 整目录 shadow 的条目级提示（同一个话术住一处，别处别再写一遍） */
function shadowNote(shadow: TrashEntry): string {
  return `本文件在 ${msToText(shadow.deletedAtMs)} 随目录「${basename(shadow.originalPath)}」进了回收站，此刻不在原位：先把那个目录放回原位，再恢复这一版。`;
}

/** 剩余保留天数的人读（锚 = 取数那一刻；见 `TimelineItem.savedAtMs` 的坑说明） */
export function keepText(item: TimelineItem): string {
  if (item.keepDaysLeft === null) return '';
  if (item.keepDaysLeft < 0) return '已过保留期';
  if (item.keepDaysLeft === 0) return '今天到期';
  return `剩 ${item.keepDaysLeft} 天`;
}

/* ==================== 两版互比（P2-15：任意两个历史版本互相比） ==================== */

/**
 * 这一条能不能参与「两版互比」（**纯判据**，overlay 只画不判）：
 * - 盘上有一个可读文件可比（`diffPath`：写前备份 / 回收站 / 未保存快照都是这一形态）；
 * - 或进程内恢复件读得到（`recovery` 账的内容在内存里，没有盘上路径——
 *   `diffPath` 为 null，但 `peekRecoveredContent` 取得到，diff 视图的 `text` 侧接得住）。
 *
 * 其余条目（批操作快照没有"单个可比对文件"的形态）⇒ 不可选，且 UI 必须说清为什么
 * （铁律 4：不静默——禁用一个看不见原因的控件等于没这个功能）。
 */
export function diffableTimelineItem(item: TimelineItem): boolean {
  return item.diffPath !== null || item.account === 'recovery';
}

/**
 * 两版互比的左右次序（**纯判据**）：**旧版在左**（original = 参照侧）、新版在右
 * （modified = 对照侧）——与既有的「与磁盘当前内容对比」同向（磁盘当前内容恒在右），
 * 一屏之内只有一种"哪边是新"的说法，不随作者勾选顺序漂。
 *
 * 时刻可比重置；缺失或相等 ⇒ 按传入序（调用方传列表序，而列表是新→旧排的，
 * 于是直观形态仍是"旧在左"）。
 */
export function orderDiffPair(
  first: TimelineItem,
  second: TimelineItem,
): { original: TimelineItem; modified: TimelineItem } {
  if (first.atMs !== null && second.atMs !== null && first.atMs !== second.atMs) {
    return first.atMs > second.atMs ? { original: second, modified: first } : { original: first, modified: second };
  }
  return { original: first, modified: second };
}

/**
 * 「对比两版」按钮的启用态与**禁用理由**（纯判据；0 / 1 / >2 各说一句话，不静默）：
 * 恰好 2 版才启用。选多了**禁用**而不是"自动取前两条"——时间线按时刻排，
 * 前两条不一定是作者想比的那两版；替作者做选择比让他多取消一次更危险。
 */
export function diffPairButtonState(selectedCount: number): { enabled: boolean; reason: string } {
  if (selectedCount === 2) return { enabled: true, reason: '在对比视图里逐行对比选中的这两版（旧版在左、新版在右）' };
  if (selectedCount === 0) return { enabled: false, reason: '先勾选两个版本（每行前面的框）' };
  if (selectedCount === 1) return { enabled: false, reason: '再勾选一个版本：两版互比需要恰好两条' };
  return { enabled: false, reason: `只能两版互比：请取消到只剩两条（当前选了 ${selectedCount} 条）` };
}

/** 某个具体落点不在写允许域时的条目级说明（逐条给出落点——全局那一屏每条的去向都不同） */
export function writableNote(target: string): string {
  return `${target} 此刻不在写允许域内（项目未打开 / 授权已收回；游戏目录整体只读）：这一条只能看，放回原位会被内核拒绝。`;
}

/**
 * 回收站条目 → 时间线行（**两条屏共用这一份构造**：某个文件的时间线、以及全局的
 * 操作历史+回收站那一屏）。口径只有一处：标题、恢复含义、剩余天数、过期提示。
 * 调用方追加自己那一屏才看得出的坑（整目录 shadow / 本文件有多份条目……）。
 */
export function trashTimelineItem(
  e: TrashEntry,
  opts: { writable: boolean; nowMs: number; extraWarnings?: readonly string[] },
): TimelineItem {
  const warnings: string[] = [];
  if (e.expiresAtMs <= opts.nowMs) {
    warnings.push('已过保留期：下一次删除动作就可能顺手把它收走（本时间线正引用着它，能多撑一会儿，但不是永久）。');
  }
  warnings.push(...(opts.extraWarnings ?? []));
  if (!opts.writable) warnings.push(writableNote(e.originalPath));
  const item: TimelineItem = {
    key: `trash:${e.id}`,
    account: 'trash',
    id: e.id,
    atMs: e.deletedAtMs,
    title: e.kind === 'dir' ? `删除整目录 · ${basename(e.originalPath)}` : `删除文件 · ${basename(e.originalPath)}`,
    meaning:
      e.kind === 'file'
        ? '放回原位 = 把这份被删的字节写回原路径。原位此刻若站着另一个文件，它会先被备份进本时间线再被换掉（不吃掉现状）。'
        : '放回原位 = 整棵目录树回到被删时的样子。回收站不覆盖任何东西：原位已有同名目录时这一步会被拒绝。',
    size: e.bytes,
    diffPath: e.kind === 'file' ? e.payloadPath : null,
    action: opts.writable ? { kind: 'restoreTrash', id: e.id, label: '放回原位' } : null,
    warnings,
    keepDaysLeft: Math.floor((e.expiresAtMs - opts.nowMs) / DAY_MS),
    savedAtMs: opts.nowMs,
  };
  return item;
}

function opLabel(o: OpFileSnapshot): string {
  return o.label || opKindLabel(o.kind);
}

/* ==================== 取数（四本账的读面；一条写面都不碰） ==================== */

/**
 * 批操作账的扫描上限：`OpJournal` 只有全局 `list()` + 逐批 `entriesOf()`，
 * "按文件挑出相关批次"是一次 fan-out（每批一趟读）。60 批是"开一屏历史等得起"的量级，
 * 也是**如实告知**的前提——扫了多少、一共多少会写进 notes，不装作扫全了。
 */
export const OPS_SCAN_LIMIT = 60;

export interface OpsScanResult {
  snapshots: OpFileSnapshot[];
  totalRecords: number;
  scanned: number;
}

/** 从批操作账里挑出与本文件有关的批次（`pathKey` 折叠大小写/分隔符，与记录侧同一把尺） */
export async function scanOpsForPath(ops: OpJournal, path: string, limit = OPS_SCAN_LIMIT): Promise<OpsScanResult> {
  const records = await ops.list();
  const scope = records.slice(0, limit);
  const target = pathKey(path);
  const views = await Promise.all(
    scope.map(async (rec) => ({ rec, entries: await ops.entriesOf(rec.id).catch(() => [] as OpEntryView[]) })),
  );
  const snapshots: OpFileSnapshot[] = [];
  for (const { rec, entries } of views) {
    const entry = entries.find((e) => pathKey(e.path) === target);
    if (entry === undefined) continue;
    snapshots.push({
      opId: rec.id,
      kind: rec.kind,
      label: rec.label,
      startedAt: rec.startedAt,
      status: rec.status,
      fileCount: rec.fileCount,
      hasBefore: entry.hasBefore,
    });
  }
  return { snapshots, totalRecords: records.length, scanned: scope.length };
}

/** manifest 清单里属于本文件的那几条快照（同 `pathKey` 尺：两种写法共用一份快照） */
export function snapshotsForPath(view: { snapshots: AutosaveSnapshotInfo[] }, path: string): AutosaveSnapshotInfo[] {
  const target = pathKey(path);
  return view.snapshots.filter((s) => pathKey(s.path) === target);
}

export interface FileTimelineBundle extends FileTimeline {
  /** 本屏引用的回收站条目 id（已登记给 `FileIO.holdTrash`：正看着的不能被顺手清掉） */
  trashIds: string[];
  /** 批操作账是否参与（false = 内核 `kernel.ops` 不在位，已写进 notes） */
  opsAvailable: boolean;
  /** 整屏的取数锚（= 本次 `nowMs`；空屏也照样有锚，靠它判"该不该重取"） */
  savedAtMs: number;
}

/**
 * 一本账读不动时的整屏说明（**只降级那一本**并出声）。
 * Error 取 message：`Error: xxx` 这种前缀在面板上是噪音，原话才是用户能行动的东西。
 */
const readFailNote = (account: string, err: unknown): string =>
  `${account}读不到：${errorText(err)}`;

/* ---------------- 回收站引用登记的**归属合并**（会话软保护的单源） ---------------- */

/** 「某个文件的四本账」那一屏的引用归属名 */
export const TRASH_HOLD_FILE_OWNER = 'file-history';
/** 「操作与回收站时间线」那一屏的引用归属名 */
export const TRASH_HOLD_OPS_OWNER = 'ops-history';

/**
 * 内核的 `holdTrash` 是**整替**语义：它只认一份权威清单，后写覆盖先写（这条口径不许动——
 * 整替正是"软保护不会叠加成永久豁免"的保证）。但宿主**可以同时开着两把时间线**：
 * 某个文件的四本账、以及操作历史那一屏。若两屏各自整替，后取数的一屏会把先取数那一屏
 * **正引用着的条目**从名单里挤掉；紧接着一次删除的顺手清扫就会在仍然开着的那一屏脚下把人
 * 的条目收走，用户点「放回原位」只拿到"回收站条目不存在或已失效"。
 *
 * 解法不改内核口径，只在宿主侧把**归属**记清：每一屏按自己的 owner 报一份引用的 id，
 * 本表取并集后**整替下发**给内核；某一屏退场只撤自己那一份，别人的照旧受保护。
 */
const heldByOwner = new Map<string, readonly string[]>();

/** 把「本会话此刻被时间线引用的条目」按归属重新登记，并把并集整替下发给内核 */
export function declareTrashHold(io: FileIO | null, owner: string, ids: readonly string[]): void {
  heldByOwner.set(owner, [...new Set(ids)]);
  pushTrashHold(io);
}

/** 某一屏退场：只撤它自己那一份引用（别屏的照旧挡清扫）；并集空了就下发空数组 */
export function releaseTrashHold(io: FileIO | null, owner: string): void {
  if (heldByOwner.delete(owner)) pushTrashHold(io);
}

/** 本表当前并集（只读，供测试与诊断；下发内核的是它的排序副本） */
export function heldTrashIds(): string[] {
  const union: string[] = [];
  for (const ids of heldByOwner.values()) for (const id of ids) if (!union.includes(id)) union.push(id);
  return union.sort();
}

function pushTrashHold(io: FileIO | null): void {
  if (io === null) return;
  io.holdTrash(heldTrashIds());
}

/**
 * 把四本账**读**齐并合并（全程只读）。任何一本账读失败只降级那一本并**出声进 notes**，
 * 不让整屏变成一条错误——"历史读不到"和"历史是空的"是两件事，必须分开呈现。
 */
export async function collectFileTimeline(
  io: FileIO,
  ops: OpJournal | null,
  path: string,
  nowMs = Date.now(),
  holdOwner: string = TRASH_HOLD_FILE_OWNER,
): Promise<FileTimelineBundle> {
  const notes: string[] = [];
  const [backups, trash, existsOnDisk, appData] = await Promise.all([
    io.listBackups(path).catch((err: unknown) => {
      notes.push(readFailNote('写前备份', err));
      return [] as BackupVersion[];
    }),
    io.listTrash({ forPath: path }).catch((err: unknown) => {
      notes.push(readFailNote('回收站', err));
      return [] as TrashEntry[];
    }),
    io.exists(path).catch(() => false),
    io.appDataDir().catch(() => null),
  ]);

  let opSnapshots: OpFileSnapshot[] = [];
  if (ops === null) {
    notes.push('批操作账未接入这条时间线（内核没有交出批操作记录）：这里没有批操作那本账。');
  } else {
    try {
      const scan = await scanOpsForPath(ops, path);
      opSnapshots = scan.snapshots;
      if (scan.scanned < scan.totalRecords) {
        notes.push(`批操作账只核对了最近 ${scan.scanned} 批（共 ${scan.totalRecords} 批）：更早的批次请用「操作历史」查。`);
      }
    } catch (err: unknown) {
      notes.push(readFailNote('批操作账', err));
    }
  }

  const snapshots: SnapshotEntry[] = [];
  if (appData === null) {
    notes.push('未保存快照账读不到：拿不到应用数据目录。');
  } else {
    const dir = join(appData, AUTOSAVE_DIR_NAME);
    try {
      const view = await readAutosaveView(
        {
          readTextFile: async (p: string) => await io.readText(p).then((f) => f.text).catch(() => undefined),
        },
        dir,
      );
      for (const s of snapshotsForPath(view, path)) {
        const size = await io
          .stat(s.filePath)
          .then((st) => (st === null ? null : st.size))
          .catch(() => null);
        snapshots.push({ account: 'autosave', path: s.path, atMs: s.savedAt, filePath: s.filePath, size });
      }
    } catch (err: unknown) {
      notes.push(readFailNote('未保存快照账', err));
    }
  }
  const recovered = peekRecoveredContent(path);
  if (recovered !== null) {
    snapshots.push({
      account: 'recovery',
      path,
      // 恢复通道里那份没带时刻就如实给 null（该行"时刻不明"沉底）；
      // 写 0 会在屏上摆一个"1970-01-01"的假时刻，还会让它去抢"谁更新"的判定
      atMs: recovered.savedAt ?? null,
      filePath: null,
      size: recovered.text.length,
    });
  }

  const timeline = buildFileTimeline({
    path,
    existsOnDisk,
    writable: io.isWritable(path),
    backups,
    trash,
    ops: opSnapshots,
    snapshots,
    nowMs,
  });
  const trashIds = timeline.items.filter((i) => i.account === 'trash').map((i) => i.id);
  // 引用登记：正被这一屏展示的回收站条目，本会话内不许被顺手超期清扫抽走
  // （按归属登记，另一屏的引用不会把自己挤掉——见 `declareTrashHold`）
  declareTrashHold(io, holdOwner, trashIds);
  return { ...timeline, notes: [...notes, ...timeline.notes], trashIds, opsAvailable: ops !== null, savedAtMs: nowMs };
}

/** 时间线取数锚点的重取阈值（一天）——见 `TimelineItem.savedAtMs` 的坑说明 */
const RESTALE_MS = DAY_MS;

/** 取数状态（`error` = 整条线读不动；单本账读不动走 `notes` 出声，不进这里） */
export type TimelineFetchState =
  | { kind: 'loading' }
  | { kind: 'ready'; bundle: FileTimelineBundle }
  | { kind: 'error'; reason: string };

/**
 * 锚点是否已经过期到**必须重取**的程度。
 *
 * 为什么需要它：剩余保留天数按取数那一刻（`savedAtMs`）算，是个静态值。若在渲染里
 * 拿墙钟逐秒倒推，时钟一过整日边界，同一屏里"还剩 1 天"会自己变成"已过保留期"，
 * 连带过期提示与恢复按钮跟着改口径（判据跟着墙钟漂 = 两次渲染两种说法）。
 * 只有一条正确姿势：**锚点过期就重新取数**，让所有判据回到同一个"此刻"。
 */
export function isTimelineStale(savedAtMs: number, nowMs: number): boolean {
  return nowMs - savedAtMs >= RESTALE_MS;
}

/* ==================== 账本句柄中转站（宿主装配用；形态照 recovery-store） ==================== */

/**
 * `OpJournal` / `FileIO` 句柄的进程内中转站：宿主注册这两只 overlay 时把它们放进来，
 * 另一侧取用——「某个文件的时间线」要批操作账，「操作历史」那一屏要回收站账，
 * 而装配点 `App.tsx` 本批刻意不动（旧消费方零改动）。
 *
 * 句柄缺席时两屏都**如实写明**少了哪本账（notes 里出声），绝不静默少一本——
 * "内核不静默"这条纪律在宿主侧同样成立。
 */
let opsJournalHandle: OpJournal | null = null;
let historyIoHandle: FileIO | null = null;

export function registerOpsJournal(ops: OpJournal | null): void {
  opsJournalHandle = ops;
}

export function getOpsJournal(): OpJournal | null {
  return opsJournalHandle;
}

export function registerHistoryIo(io: FileIO | null): void {
  historyIoHandle = io;
}

export function getHistoryIo(): FileIO | null {
  return historyIoHandle;
}

/* ==================== 全局那一屏：批操作 + 回收站并一条时间线 ==================== */

/**
 * 「操作历史」那一屏没有"目标文件"，所以它的合并线是**两本全局账**：
 * 批操作记录 + 回收站条目（写前备份与未保存快照都是按文件的账，属于某个文件的时间线）。
 *
 * 这一屏的存在是为了堵另一个坑：作者删掉**整个目录**时，那个目录里可能一个文件都没开着
 * ——按文件的时间线根本无从指向它，回收站又会变回"看不见"。判据、排序、文案与按文件那一屏
 * 共用同一份构造（`trashTimelineItem` + `mergeTimeline`），两屏不可能说出两种话。
 */
export function buildGlobalTimeline(
  records: readonly OpRecord[],
  trash: readonly TrashEntry[],
  opts: { writableOf: (path: string) => boolean; nowMs?: number },
): FileTimeline {
  const nowMs = opts.nowMs ?? Date.now();
  const items: TimelineItem[] = [];
  for (const rec of records) {
    const undoable = rec.status === 'committed';
    items.push({
      key: `ops:${rec.id}`,
      account: 'ops',
      id: rec.id,
      atMs: rec.startedAt,
      title: `${undoable ? '批操作' : '批操作（已撤销）'}「${rec.label || opKindLabel(rec.kind)}」`,
      meaning: undoable
        ? `撤销 = 整批 ${rec.fileCount} 个文件一起回到操作前（新建的那些会被删掉，删除落点是回收站，仍能从这条线上放回原位）。`
        : '这一批已经被撤销；对它再撤销一次 = 重做原操作（同样回滚整批）。',
      size: null,
      diffPath: null,
      action: { kind: 'undoOp', id: rec.id, label: undoable ? '撤销这一批' : '重做这一批' },
      warnings:
        rec.fileCount > 1
          ? [`撤销是整批动作：这一批共涉及 ${rec.fileCount} 个文件，不能只挑其中一个。`]
          : [],
      keepDaysLeft: null,
      savedAtMs: nowMs,
    });
  }
  for (const e of trash) {
    items.push(
      trashTimelineItem(e, {
        writable: opts.writableOf(e.originalPath),
        nowMs,
        extraWarnings: trashExtraNotes(e, trash),
      }),
    );
  }
  return {
    items: mergeTimeline(items),
    notes:
      trash.length === 0
        ? []
        : [
            '回收站里的东西不会自己回来：这一屏就是它唯一的入口。恢复走内核原路（第一道闸照过、原位有东西就让路给写前备份），过期的条目由下一次删除动作顺手收走。',
          ],
  };
}

/** 全局时间线取数（批操作账 + 回收站账；拿不到的那本如实出声） */
export async function collectGlobalTimeline(
  io: FileIO | null,
  ops: OpJournal | null,
  nowMs = Date.now(),
  holdOwner: string = TRASH_HOLD_OPS_OWNER,
): Promise<FileTimeline & { trashIds: string[]; records: OpRecord[]; savedAtMs: number }> {
  const notes: string[] = [];
  const records: OpRecord[] = [];
  const trash: TrashEntry[] = [];
  if (ops === null) notes.push('批操作账未接入（内核没有交出批操作记录）：这条线上没有批操作。');
  if (io === null) notes.push('回收站账未接入（宿主没有交出文件读写通道）：这条线上没有回收站条目。');
  if (ops !== null) {
    try {
      records.push(...(await ops.list()));
    } catch (err: unknown) {
      notes.push(readFailNote('批操作账', err));
    }
  }
  if (io !== null) {
    try {
      trash.push(...(await io.listTrash()));
    } catch (err: unknown) {
      notes.push(readFailNote('回收站', err));
    }
  }
  const timeline = buildGlobalTimeline(records, trash, {
    writableOf: io === null ? () => false : (p: string) => io.isWritable(p),
    nowMs,
  });
  const trashIds = timeline.items.filter((i) => i.account === 'trash').map((i) => i.id);
  // 正被这一屏展示的条目：本会话内不许被顺手超期清扫抽走（归属登记，见 `declareTrashHold`）
  declareTrashHold(io, holdOwner, trashIds);
  return { ...timeline, notes: [...notes, ...timeline.notes], trashIds, records, savedAtMs: nowMs };
}
