/**
 * 批量删除的**执行层**（WS-13 2c 车；零 React、零 DOM，IO 全部注入）。
 *
 * ## 分工照 2a 车那两条腿
 *
 * 判据住 `file-delete-plan.ts`（纯函数：哪几条真删、哪几条随目录走、哪几条删不了、
 * 文案怎么逐条点名）；这一层只负责"怎么删、删完东西去了哪、怎么拿回来"，
 * 并聚合成一句真话。上屏与收尾（重列目录、关标签、通知索引）由宿主（文件树）做——
 * 本层不弹任何 UI。
 *
 * ## 五条硬口径
 *
 * 1. **删除就是移进回收站**：内核 `removeFile` / `removeDir`（2026-10-16 undo 批起）把东西
 *    搬进 `{appData}/trash/<id>/`，原路径写进 manifest。本层**不自己搬**，也不另立一套回收站
 *    约定——只做一件新事：删完用 `listTrash({ forPath })` 把这一批的条目 id 对上号，
 *    于是"撤销"有一条能执行的腿。
 * 2. **对不上号就如实说**：宿主没有 `listTrash` 这条腿、或条目没列出来 ⇒ 那几份进 `untracked`，
 *    回执明写"撤销不包括它们"，绝不给一个点了没反应的"可撤销"假承诺（铁律 4）。
 * 3. **写允许域逐条判**：`blockedOf`（宿主接内核 `io.isWritable`）判下来的条目进计划的
 *    `rejected`，**一个 IO 都不发**，但仍在确认框里逐条点名"这几条删不了，会原样留下"。
 *    回收站落在应用数据目录那侧，游戏目录里一个字节都不留（铁律 5 / 6：不新增任意目标的域外通道）。
 * 4. **脏只问一次**：`dirtyOf` 复用 `disk-reconcile.dirtyNamesIn` 那份投影（全仓只有这一处
 *    "哪几份是脏的"的定义），命中就在**逐条点名的删除确认之后**再问一句，答"不"整批作废。
 * 5. **撤销不做覆盖的替代**：`restoreFromTrash` 的既有纪律原样透出——原位站着文件时内核先把
 *    现状写进本地历史再放回，原位站着目录时内核直接拒绝并把原话交上来，本层逐条点名进回执，
 *    **不放回的条目留在台账里可以再试**（一次撤销失败不该把整批的退路烧掉）。
 *
 * ## 为什么不动 `holdTrash`
 *
 * `holdTrash` 是**整替**语义，那份"谁在引用哪些条目"的归属台账住在 `ui/file-history.ts`
 * （`declareTrashHold(io, owner, ids)`）。删除批在这里直插一次 `io.holdTrash` 会把时间线那侧的
 * 引用整份挤掉——那是越界。何况用不上：自动清理只动**超 30 天**的条目，刚删的这批离那档还远，
 * 字节超限那一档也是**从最旧**起裁。
 */
import type { TrashEntry } from '@kojo/plugin-api';
import { errorText } from '@kojo/plugin-api';
import type { DirtyGate } from './file-ops-exec';
import { pkey } from './file-tree-ops';
import {
  buildDeletePlan,
  deleteBatchConfirmText,
  deleteBatchReceiptText,
  undoDeleteReceiptText,
  type DeleteEntry,
  type DeletePlan,
  type DeletePlanItem,
} from './file-delete-plan';

/**
 * 删除与撤销需要的**最小 IO 面**（结构类型：内核 `FileIO` 直接可传）。
 *
 * `listTrash` / `restoreFromTrash` 刻意是**可选**的：纯浏览器宿主与旧夹具没有这两格时，
 * 删除照做、撤销如实不可用——"这条腿不存在"必须是一种能听见的状态，而不是一个假按钮。
 */
export interface FileDeleteIo {
  removeFile(path: string): Promise<void>;
  removeDir(path: string): Promise<void>;
  listTrash?(opts?: { forPath?: string }): Promise<readonly TrashEntry[]>;
  restoreFromTrash?(id: string): Promise<string>;
}

/** 一条"删掉的东西在回收站里的凭据"（撤销只认它） */
export interface DeleteRecord {
  readonly trashId: string;
  readonly path: string;
  readonly name: string;
  readonly isDir: boolean;
}

/** 一次可撤销的删除批（会话内台账；不落盘，与剪贴板同一条生命周期） */
export interface DeleteBatch {
  readonly records: readonly DeleteRecord[];
  readonly atMs: number;
}

export interface BatchDeleteInput {
  readonly io: FileDeleteIo;
  /** 宾语（宿主现读：多选集或焦点行；种类必须在删除之前定下来） */
  readonly entries: readonly DeleteEntry[];
  /** 目录连带规模（宿主用 `walkDir` 现算；读不到就别给，文案会如实退化） */
  readonly sizeOf?: (path: string) => { files?: number; dirs?: number } | undefined;
  /** 逐条可写性（宿主接内核 `io.isWritable`）；不可写的进 `rejected` 并点名，一个 IO 都不发 */
  readonly blockedOf?: (path: string) => string | null;
  /** 脏闸（`dirtyOf` = `dirtyNamesIn` 那份投影；`askDirty('delete', …)` 只问一次） */
  readonly dirty?: DirtyGate;
  /**
   * 确认框：文案由判据层逐条点名备好（`deleteBatchConfirmText`），这里只拿"删/不删"。
   * 不给 = 不询问（调用侧已经问过了；单测与脚本走这一格）。
   */
  readonly confirm?: (plan: DeletePlan, text: string) => boolean | Promise<boolean>;
}

export interface BatchDeleteOutcome {
  /** 作者答"不" ⇒ 一个字节都没动 */
  readonly aborted: boolean;
  readonly plan: DeletePlan;
  /** 删成且在回收站对上号的（撤销的宾语） */
  readonly deleted: readonly DeleteRecord[];
  /** 删成但没对上号的名字（撤销不包括它们） */
  readonly untracked: readonly DeletePlanItem[];
  readonly failed: ReadonlyArray<{ name: string; reason: string }>;
  /** 进会话台账的那一批（没有可撤销的东西 ⇒ null） */
  readonly batch: DeleteBatch | null;
  readonly resultText: string;
}

/** 一句人话的不可写理由（与搬运执行层那句同一形态；上屏不许出现 writablePaths 这种内部词） */
export const READONLY_BLOCK_REASON = '这一处在只读范围内，不能删除——要先在「只读」徽章那里批准写权限。';

/* ------------------------------ 会话台账 ------------------------------ */

/**
 * 最近一次可撤销的删除批（模块级：命令面板那条腿拿不到树的实例，与剪贴板同一个理由）。
 *
 * 刻意**不落盘**：里面是绝对路径，跨重启既没有意义（项目可能已经关了），
 * 又会把"上次删了什么"变成一台机器上的隐私面。换项目由宿主清（`clearDeleteBatchLedger`）。
 */
let lastBatch: DeleteBatch | null = null;

export function getLastDeleteBatch(): DeleteBatch | null {
  return lastBatch;
}

export function clearDeleteBatchLedger(): void {
  lastBatch = null;
}

/** 台账写入（`runBatchDelete` / `undoDeleteBatch` 自己维护；宿主只在换项目时清） */
export function rememberDeleteBatch(batch: DeleteBatch | null): void {
  lastBatch = batch;
}

/* ------------------------------ 回收站对号 ------------------------------ */

/**
 * 从 `listTrash({forPath})` 的结果里挑出**这一条自己**的条目。
 *
 * 三条判据：原路径归一相等（`forPath` 的筛子还会放过祖先与后代，必须自己再收一次）、
 * 种类相符、**新在前 ⇒ 取第一条**（同名路径可能被删过不止一次，撤销要拿最近那一份）。
 * 宿主没有这条腿 ⇒ null（调用侧如实报"对不上号"）。
 */
async function trashIdFor(
  io: FileDeleteIo,
  item: { path: string; isDir: boolean },
): Promise<string | null> {
  if (typeof io.listTrash !== 'function') return null;
  let entries: readonly TrashEntry[];
  try {
    entries = await io.listTrash({ forPath: item.path });
  } catch {
    return null; // 读不出回收站 = 对不上号（调用侧如实报"撤销不包括它"），不硬撑成"删失败了"
  }
  const want = pkey(item.path);
  const kind = item.isDir ? 'dir' : 'file';
  for (const e of entries) {
    if (e.kind !== kind) continue;
    if (pkey(e.originalPath) !== want) continue;
    return e.id;
  }
  return null;
}

/* ------------------------------ 删除 ------------------------------ */

/**
 * 执行一次批量删除（唯一入口）。
 *
 * 顺序：计划（含逐条可写判定）→ 确认（逐条点名）→ 脏闸（只问一次）→ 逐条落盘 → 回收站对号 → 回执。
 * 前三步任何一步拦下都是一个字节都不碰。
 */
export async function runBatchDelete(input: BatchDeleteInput): Promise<BatchDeleteOutcome> {
  const { io, entries } = input;
  const plan = buildDeletePlan(entries, {
    ...(input.sizeOf !== undefined ? { sizeOf: input.sizeOf } : {}),
    ...(input.blockedOf !== undefined ? { blockedOf: input.blockedOf } : {}),
  });
  const trashReadable = typeof io.listTrash === 'function';
  // 计划层的拒绝（读不出名字 + 只读范围）本来就一条都不发，回执里逐条点名
  const refusedFromPlan = plan.rejected.map((r) => ({ name: r.name, reason: r.reason ?? '这一条不能删除。' }));

  if (plan.targets.length === 0) {
    return {
      aborted: false,
      plan,
      deleted: [],
      untracked: [],
      failed: refusedFromPlan,
      batch: null,
      resultText: deleteBatchReceiptText({
        done: [],
        failed: refusedFromPlan,
        trashReadable,
      }),
    };
  }

  if (input.confirm !== undefined && !(await input.confirm(plan, deleteBatchConfirmText(plan)))) {
    return {
      aborted: true,
      plan,
      deleted: [],
      untracked: [],
      failed: refusedFromPlan,
      batch: null,
      resultText: '已取消——一个字节都没动。',
    };
  }

  // 脏闸：与 2a 车同一条投影、同一份问句模块（"删了之后编辑器里那份改动也没了"要说清）
  const gate = input.dirty ?? {};
  if (gate.dirtyOf !== undefined && gate.askDirty !== undefined) {
    const names = gate.dirtyOf(plan.items.map((i) => i.path));
    if (names.length > 0 && !(await gate.askDirty('delete', names))) {
      return {
        aborted: true,
        plan,
        deleted: [],
        untracked: [],
        failed: refusedFromPlan,
        batch: null,
        resultText: '已取消：那些文件还有未保存的修改，先存一下或关掉再删。',
      };
    }
  }

  const deleted: DeleteRecord[] = [];
  const untracked: DeletePlanItem[] = [];
  const failed: Array<{ name: string; reason: string }> = [...refusedFromPlan];

  for (const item of plan.targets) {
    try {
      if (item.isDir) await io.removeDir(item.path);
      else await io.removeFile(item.path);
    } catch (e: unknown) {
      failed.push({ name: item.name, reason: errorText(e) });
      continue;
    }
    const trashId = await trashIdFor(io, item);
    if (trashId === null) untracked.push(item);
    else deleted.push({ trashId, path: item.path, name: item.name, isDir: item.isDir });
  }

  const batch = deleted.length > 0 ? { records: deleted, atMs: Date.now() } : null;
  rememberDeleteBatch(batch);
  return {
    aborted: false,
    plan,
    deleted,
    untracked,
    failed,
    batch,
    resultText: deleteBatchReceiptText({
      done: [...deleted.map((d) => ({ name: d.name, isDir: d.isDir })), ...untracked.map((u) => ({ name: u.name, isDir: u.isDir }))],
      failed,
      untracked: untracked.map((u) => u.name),
      carriedCount: plan.carried.length,
      trashReadable,
    }),
  };
}

/* ------------------------------ 撤销 ------------------------------ */

export interface UndoDeleteInput {
  readonly io: FileDeleteIo;
  readonly batch: DeleteBatch;
}

export interface UndoDeleteOutcome {
  readonly restored: readonly DeleteRecord[];
  readonly failed: ReadonlyArray<{ name: string; reason: string }>;
  /** 没放回原位的那些（仍留在台账里，可以再试一次） */
  readonly remaining: readonly DeleteRecord[];
  readonly resultText: string;
}

/**
 * 把一批删除放回原路径（撤销 = 逐条 `restoreFromTrash`，不发明第二条恢复通道）。
 *
 * 台账里的条目彼此**不嵌套**（父子同批时子已被折叠成 `carried`），故放回顺序不影响结果。
 * 失败的两类都来自内核原话，本层不改写：越权（项目关了、写允许域收回）与"原位置已存在"
 * ——后者恰好是"不许静默丢"的那一档：拒绝就是拒绝，绝不为了"撤销成功"把原位那份新内容吃掉。
 */
export async function undoDeleteBatch(input: UndoDeleteInput): Promise<UndoDeleteOutcome> {
  const { io, batch } = input;
  if (typeof io.restoreFromTrash !== 'function') {
    const failed = batch.records.map((r) => ({ name: r.name, reason: '这个环境没有"从回收站放回原位"的通道。' }));
    return { restored: [], failed, remaining: batch.records, resultText: undoDeleteReceiptText({ restored: [], failed }) };
  }
  const restored: DeleteRecord[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  const remaining: DeleteRecord[] = [];
  for (const record of batch.records) {
    try {
      await io.restoreFromTrash(record.trashId);
      restored.push(record);
    } catch (e: unknown) {
      const reason =
        e instanceof Error && e.name === 'WriteNotAllowedError'
          ? '这一处现在又在只读范围内，放回需要先在「只读」徽章那里批准写权限。'
          : errorText(e);
      failed.push({ name: record.name, reason });
      remaining.push(record);
    }
  }
  rememberDeleteBatch(remaining.length > 0 ? { records: remaining, atMs: batch.atMs } : null);
  return {
    restored,
    failed,
    remaining,
    resultText: undoDeleteReceiptText({ restored: restored.map((r) => r.name), failed }),
  };
}
