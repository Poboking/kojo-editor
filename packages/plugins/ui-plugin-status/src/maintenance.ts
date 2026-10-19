import type { OpJournal, OpsMaintenance } from '@kojo/plugin-api';

/**
 * ops journal 维护态读数（面板侧的唯一口径，纯函数 + 一次巡检，零 React、零内核）。
 *
 * 为什么住插件里而不是内核：内核已经把这些残留 warn 进日志了（`kernel/journal.ts` 的
 * 巡检），但"看得见"要求的是**面板上的一个数**——把五项压成一个总数、以及"读不出该显什么"
 * 是呈现口径，归消费方面板；内核只出原始计数。
 *
 * 铁律 4（不许静默）在本文件的落点：`readOpsMaintenance` **永不抛错**，读不出就如实返回
 * `known: false` + 原因，面板据此显示「未知」而不是把整行省掉。
 */

/** 残留五项（互不重叠，合计即面板上那个 N；`checkedAt` 是时间戳，不计入） */
export function opsMaintenanceTotal(m: OpsMaintenance): number {
  return (
    m.openOrphanDocs + m.rollbackFailedDocs + m.unreadableDocs + m.orphanSnapshotDirs + m.cleanupFailures
  );
}

/** 明细（面板挂到 title 上；顺序与总账一致，别在这里发明新词） */
export function opsMaintenanceDetail(m: OpsMaintenance): string {
  return (
    `open 残留 ${m.openOrphanDocs} · 回滚失败 ${m.rollbackFailedDocs} · ` +
    `不可读文档 ${m.unreadableDocs} · 孤儿快照目录 ${m.orphanSnapshotDirs} · ` +
    `清理失败 ${m.cleanupFailures} · 巡检于 ${new Date(m.checkedAt).toISOString()}`
  );
}

/** 一次巡检的读数：`known=false` 时必须显示「未知 + 原因」，不许整行消失 */
export interface OpsMaintenanceRead {
  readonly known: boolean;
  readonly total: number;
  /** known=true ⇒ 明细；known=false ⇒ 读不出的原因 */
  readonly detail: string;
}

const UNKNOWN_NO_METHOD: OpsMaintenanceRead = {
  known: false,
  total: 0,
  detail: '旧内核未提供维护记录读数接口，条数读不出',
};

/**
 * 巡检一次并读数：先 `list()`（**残留计数只在 `list()` 巡检时刷新**，见 `kernel/journal.ts`），
 * 再取 `maintenanceReport()`。`maintenanceReport` 是契约里的**可选**方法，缺席或巡检抛错
 * 都降级成 `known: false`（读数不许假装是 0）。
 */
export async function readOpsMaintenance(journal: OpJournal): Promise<OpsMaintenanceRead> {
  if (typeof journal.maintenanceReport !== 'function') return UNKNOWN_NO_METHOD;
  try {
    await journal.list();
  } catch (err) {
    return { known: false, total: 0, detail: `巡检失败：${String(err)}` };
  }
  let report: OpsMaintenance;
  try {
    report = journal.maintenanceReport();
  } catch (err) {
    return { known: false, total: 0, detail: `读数失败：${String(err)}` };
  }
  return { known: true, total: opsMaintenanceTotal(report), detail: opsMaintenanceDetail(report) };
}

/** 读数三态（面板据此上色；`unknown` 与"干净"必须一眼分得开） */
export type OpsMaintenanceTone = 'residue' | 'clean' | 'unknown';

/** 巡检还没回来也算 unknown（不许用空值冒充 0） */
export function opsMaintenanceTone(read: OpsMaintenanceRead | null): OpsMaintenanceTone {
  if (!read || !read.known) return 'unknown';
  return read.total > 0 ? 'residue' : 'clean';
}

/**
 * 面板那一行的文字（唯一口径；单测钉死它——残留不许被写成 `0`，也不许整行消失）。
 * 面向普通作者一律中文人话，内部术语（ops journal 等）不再出现在这一行；
 * 明细（五项分别多少 + 巡检时间）挂 `title` 与折叠体，见 `opsMaintenanceDetail`。
 */
export function opsMaintenanceText(read: OpsMaintenanceRead | null): string {
  if (!read || !read.known) {
    return `维护记录：未知 — ${read?.detail ?? '巡检尚未完成，稍后自动刷新'}`;
  }
  return read.total > 0
    ? `维护记录：${read.total} 条待处理（崩溃或回滚留下的文件，需人工处置）`
    : `维护记录：${read.total} 条`;
}
