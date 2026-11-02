import type { Notify, NoticeInput } from './NotificationCenter';
import type { ReferenceWritePlan } from './reference-utils';
import type { FileWritableArea } from './file-area';

/**
 * F2 重命名的**改动清单上屏**（KW-12，2026-11-03）——「改之前看得见改哪里」那一格。
 *
 * ## 它补的是哪一条哑
 *
 * 改前这条链上，多文件改名在按下回车**之前**没有任何清单：Monaco 的 standalone rename
 * 控制器（0.57）没有预览面，`provideRenameEdits` 一返回就把 `WorkspaceEdit` 糊进已开的标签，
 * 未打开文件更是在 provider 内部就直接经内核 io 写回磁盘。只读落点那条分支今天**不静默**
 * （`erb-rename` 整次取消），但只说得出「n 个文件只读未纳入」——不说是哪几个、各几处，
 * 也不说是因为落在游戏目录还是压根不在写允许域。同一趟里还有三处降级（陈旧索引跳过 /
 * 散文位跳过 / 闭文件写失败）只进 `console.warn`。⇒ 本模块把这几样变成作者看得见的东西。
 *
 * ## 三条口径
 *
 * 1. **可写性只有一把尺子**：清单里「可写 / 不可写」逐字取自 `planReferenceWrites`
 *    （闸门 = 内核 io `isWritable`，与保存按钮同源，见 `editor-editability.ts` 头注）。
 *    本模块**不判**能不能写——它只把已经判好的结果排成清单。
 * 2. **只解释、不判定**：`unwritableReasonOf` 把「为什么写不进去」按**区域分野**
 *    （`file-area.ts` 那把尺子：工作区 / 口上区 / 其余）说一句人话。区域只回答"在哪一区"，
 *    它永远是在 `isWritable` 已经判为不可写之后才被问的，所以构不成第二套可写性判定。
 * 3. **形态照 `format-notice-ledger.ts`**：呈现走既有通知中心（标题 + 一行摘要 + 展开原文），
 *    不新造面板体系；差异只有一处——**不去重**。格式化让路是同一处反复撞，一次会话说一句就够；
 *    而 F2 是逐次动作，第二次改名同样需要清单 ⇒ 每次按 F2 都发一条，去重等于把"看得见"
 *    重新关掉。同屏上限与淘汰仍由 `notice-queue.ts` 兜。
 *
 * ## 分层
 *
 * 纯函数（`renamePlanFilesOf` / `renamePreviewNotice` / `renameLandedNotice` / `unwritableReasonOf`）
 * 零 Monaco、零内核，node 单测直接跑；订阅表与上屏（`subscribeRenameNotices` /
 * `reportRenamePreview`）住这一族，装配层只递数据 + 一枚区域读数（`describeArea`）。
 * 本模块整条挂在 `editor-global-providers → monaco 装配` 的**懒边**之下（开机图 201 文件顶格，
 * 见 `tests/ps10-eager-graph.test.ts`）⇒ 新增文件不进图，前提是没有首屏静态引它。
 */

/* ============================== 清单的行 ============================== */

/** 一份落点文件在清单里的一行（处数 = 这一份上的出现点数，不是编辑数） */
export interface RenamePlanFile {
  readonly path: string;
  readonly occurrences: number;
  /** 逐字取自写计划（内核 io `isWritable`）；本模块不改写它 */
  readonly writable: boolean;
  /** 有没有开标签：开着的走编辑器（撤销步 / 脏标记现成），没开的走内核 io 直接落盘 */
  readonly opened: boolean;
  /** 不可写的「为什么」（{@link unwritableReasonOf} 现算；可写行不带） */
  readonly reason?: string;
  /** 语言侧（台账的 `language` 轴：方言面 / 糖源面），给清单标一句"这一份是哪一侧" */
  readonly language?: string;
}

/** 写计划 → 逐文件清单（**纯函数**；`openedFor` = "这份开没开标签"，由宿主给） */
export function renamePlanFilesOf(
  plan: ReferenceWritePlan,
  openedFor: (path: string) => boolean,
  describeUnwritable?: (path: string) => string,
): RenamePlanFile[] {
  const rows: RenamePlanFile[] = plan.writable.map((group) => ({
    path: group.path,
    occurrences: group.occurrences.length,
    writable: true,
    opened: openedFor(group.path),
    language: group.language,
  }));
  for (const file of plan.readOnlyDetail) {
    rows.push({
      path: file.path,
      occurrences: file.occurrences,
      writable: false,
      opened: openedFor(file.path),
      language: file.language,
      ...(describeUnwritable === undefined ? {} : { reason: describeUnwritable(file.path) }),
    });
  }
  return rows;
}

/** 一次清单的合计读数（消息那一行的数字，全部由行求和得来，不另数一遍） */
export interface RenamePlanTotals {
  readonly files: number;
  readonly occurrences: number;
  readonly unwritableFiles: number;
  readonly unwritableOccurrences: number;
  readonly openedFiles: number;
}

export function renamePlanTotalsOf(files: readonly RenamePlanFile[]): RenamePlanTotals {
  let occurrences = 0;
  let unwritableFiles = 0;
  let unwritableOccurrences = 0;
  let openedFiles = 0;
  for (const file of files) {
    occurrences += file.occurrences;
    if (!file.writable) {
      unwritableFiles++;
      unwritableOccurrences += file.occurrences;
    }
    if (file.opened) openedFiles++;
  }
  return {
    files: files.length,
    occurrences,
    unwritableFiles,
    unwritableOccurrences,
    openedFiles,
  };
}

/* ============================== 「为什么不能写」的句子 ============================== */

/** 区域分野之外的一档：写允许域没覆盖这一份，连区域都答不出（项目未批准 / 落在别处） */
const AREA_REASON: Record<FileWritableArea | 'unknown', string> = {
  'game-erb': '落在游戏目录（口上区）——游戏目录整体只读，这一份没进用户批准的写入目录',
  workspace: '落在工作项目区，但内核的写允许域此刻没覆盖它（写入未批准）',
  other: '不在任何已批准的写入目录内（写权限未批准）',
  unknown: '不在任何已批准的写入目录内（写权限未批准）',
};

/**
 * 不可写落点的一句"为什么"（**纯查表**，零判定）。
 *
 * `area` 由装配层现取（`fileWritableArea(kernel, path)`——状态栏胶囊与编辑器只读门同一把尺子）；
 * 它回答的是"这一份落在哪一区"，**不回答**"能不能写"——后者只由内核 io `isWritable` 判过，
 * 本函数只在判完不可写之后被调用（拿它编第二把可写性尺子就是本仓反过的第二真源）。
 */
export function unwritableReasonOf(area: FileWritableArea | undefined): string {
  return AREA_REASON[area ?? 'unknown'];
}

/* ============================== 上屏的两条通知 ============================== */

/** 预览（按下 F2 那一刻，输入框还没弹出来） */
export interface RenamePreviewInput {
  readonly oldName: string;
  readonly files: readonly RenamePlanFile[];
  /**
   * `true` = 这份清单只覆盖**方言面**（`.erb` / `.erm`）。
   *
   * 糖源（`.kojo1`）腿要在按下回车后才取数——`collectKojoLeg` 要枚举并读回全项目糖源，
   * 拿它填 F2 输入框弹出的那一拍会把输入框卡住。预览如实写"这一腿稍后并入"，
   * 落地那条通知再交全表（**不假装预览是全的**）。
   */
  readonly deferred?: boolean;
}

/** 落地（改动真的送达之后） */
export interface RenameLandedInput extends RenamePreviewInput {
  readonly newName: string;
  /** 经内核 io 写回磁盘的未打开文件数 */
  readonly landedClosedFiles: number;
  /** 进 `WorkspaceEdit`（编辑器里待应用）的处数 */
  readonly tabEdits: number;
  /** 陈旧索引（现文本对不上坐标）跳过合计——绝不按陈旧坐标硬写 */
  readonly stale: number;
  /** 「改名不重写散文」跳过的处数 */
  readonly proseSkipped: number;
  /** 闭文件 io 写失败（逐条原文） */
  readonly failures: readonly string[];
}

/** 一行一个文件（展开态与悬停都吃它；顺序 = 清单序 = 台账序，不重排） */
function fileLines(files: readonly RenamePlanFile[]): string {
  return files
    .map(
      (file) =>
        `${file.writable ? '可写' : '不可写'} · ${file.opened ? '已开标签（编辑器内改）' : '未打开（直接落盘）'} · '${file.path}'（${file.occurrences} 处）` +
        (file.writable ? '' : file.reason === undefined ? '' : `：${file.reason}`),
    )
    .join('\n');
}

/** 预览通知：标题 + 一行摘要 + 逐文件明细（有不可写落点 = error 常驻，其余 info 六秒自走） */
export function renamePreviewNotice(input: RenamePreviewInput): NoticeInput {
  const totals = renamePlanTotalsOf(input.files);
  const blocked = totals.unwritableFiles > 0;
  const head = `重命名预览 ·「${input.oldName}」`;
  const summary = blocked
    ? `${totals.files} 个文件 ${totals.occurrences} 处，其中 ${totals.unwritableFiles} 个（${totals.unwritableOccurrences} 处）写不进去 —— 按回车会整次取消`
    : `${totals.files} 个文件 ${totals.occurrences} 处：${totals.openedFiles} 个在编辑器里改、${totals.files - totals.openedFiles} 个直接落盘`;
  return {
    kind: blocked ? 'error' : 'info',
    title: head,
    message: summary,
    detail: `${head}\n${fileLines(input.files)}${input.deferred === true ? '\n（这份清单只列方言面；生成它的 .kojo1 糖源在按下回车后并入，落地时另发一条全表）' : ''}`,
  };
}

/** 落地通知：读数逐条来自落盘那两通道（闭文件写盘 + 编辑器 `WorkspaceEdit`） */
export function renameLandedNotice(input: RenameLandedInput): NoticeInput {
  const totals = renamePlanTotalsOf(input.files);
  const head = `重命名落地 ·「${input.oldName}」→「${input.newName}」`;
  // 只有"该落地却没落地"的才算事故（陈旧坐标 / 写失败）；散文跳过是既定判据
  // （「改名不重写散文」），进摘要与明细，但不升级成常驻 error——假警报会把人训练成忽略 toast。
  const incident = input.failures.length > 0 || input.stale > 0;
  const skippedParts: string[] = [];
  if (input.stale > 0) skippedParts.push(`${input.stale} 处现文本对不上坐标跳过（索引陈旧，绝不硬写）`);
  if (input.proseSkipped > 0) skippedParts.push(`${input.proseSkipped} 处是台词散文未改`);
  if (input.failures.length > 0) skippedParts.push(`${input.failures.length} 个文件写入失败`);
  const skipped = skippedParts.length === 0 ? '' : ` · ${skippedParts.join(' · ')}`;
  return {
    kind: incident ? 'error' : 'info',
    title: head,
    message:
      `${input.landedClosedFiles} 个未打开文件已写盘 · 编辑器内 ${input.tabEdits} 处（未保存）· ` +
      `共 ${totals.files} 个文件 ${totals.occurrences} 处${skipped}`,
    detail:
      `${head}\n${fileLines(input.files)}` +
      `${input.deferred === true ? '\n（糖源腿未参与这一次判定）' : ''}` +
      (input.failures.length > 0 ? `\n写入失败逐条：\n${input.failures.join('\n')}` : ''),
  };
}

/* ============================== 订阅表（形态照 format-notice-ledger.ts） ============================== */

/**
 * 订阅者表：按 `notify` 的函数身份去重 + 引用计数（同一条通知中心，多标签各订一次只上屏一次）。
 */
const sinks = new Map<Notify, number>();

/** 一条清单上屏（呈现面抛错不许打断改名：每条订阅各自包一次） */
export function reportRenameNotice(notice: NoticeInput): boolean {
  for (const sink of [...sinks.keys()]) {
    try {
      sink(notice);
    } catch {
      /* 少一条 toast 不算事故：改名照旧走完 */
    }
  }
  return sinks.size > 0;
}

/** 预览拍上屏（装配层的接线只有这一行；本腿不判、不写盘） */
export function reportRenamePreview(input: RenamePreviewInput): boolean {
  return reportRenameNotice(renamePreviewNotice(input));
}

/** 落地拍上屏（同上；读数全部来自落盘那两通道） */
export function reportRenameLanded(input: RenameLandedInput): boolean {
  return reportRenameNotice(renameLandedNotice(input));
}

/** 把通知中心那枚 `notify` 订上清单（返回退订；同一枚 `notify` 订两次只上屏一次） */
export function subscribeRenameNotices(notify: Notify): () => void {
  sinks.set(notify, (sinks.get(notify) ?? 0) + 1);
  let alive = true;
  return () => {
    if (!alive) return;
    alive = false;
    const rest = (sinks.get(notify) ?? 1) - 1;
    if (rest <= 0) sinks.delete(notify);
    else sinks.set(notify, rest);
  };
}

/** 清订阅表（测试复位用） */
export function resetRenameNoticeSinks(): void {
  sinks.clear();
}
