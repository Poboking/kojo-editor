/**
 * 存档面板的**纯函数层**（车道 UI-SAVES · 启动器实例详情「存档」页）。
 *
 * 与 `model.ts` 同一分工：视图（`saves-panel.tsx`）只做取数、订阅与渲染，
 * 凡是「把读数变成人话」「这道门该不该开」的判断都住这里——纯函数、零 React、零 IO，
 * 单测可以逐条点名每一条分支。
 *
 * ## 三条纪律（与仓里既有口径一致）
 *
 * 1. **不造第二份真源**：
 *    - 字节格式化复用 `model.formatBytes`，任务进度复用 `model.taskProgressView`；
 *    - 错误的话术真源是 `launcher-core` 的 `LauncherError.message`，本层**原样**呈现码与原文，
 *      只补标题与「下一步」（`launcherErrorHint` 覆盖其余码，本层只加存档这条能力面最常撞的四类）；
 *    - 时间只走本地 `Intl.DateTimeFormat`（不引日期库，也不手拼 `toISOString` 的前 10 位：
 *      后者是 UTC，用户按本地时间对不上）。
 * 2. **缺读数就说「未记录」**：`SaveEntry.mtimeMs` / `bytes` 缺席或被上游归一成 0 时，
 *    显示「未记录」而不是 `1970-01-01`；宁可承认没这个数，也不编一个。
 * 3. **保守门禁**：`shared` 实例的写回是逐根授权的，而契约层**没有**读授权的接口
 *    （见下方「契约缺口」）。本层按「列表里一条都没有的声明根 = 需要先确认授权」处理：
 *    宁可先不给按钮，也不在没把握的时候放行写回（铁律 5/6）。
 *
 * ## 契约缺口（已上报，不擅自扩 `plugin-api`）
 *
 * - `SaveManager` 没有 approvals 读数：`list()` 在 shared 下**把未授权根的条目直接滤掉**
 *   （`launcher-core/save-manager.ts` §9.1），所以「这个根未授权」与「这个根里还没存档」
 *   在契约面上不可区分。本层把两种都读作 `needs-approval`，文案如实写成
 *   「还没被批准（也可能只是还没存过档）」，并让用户用目录对话框确认一次。
 * - `SaveManager.list()` 装不下警告 ⇒ `launcher-core` 在实现上外挂了 `warnings(instanceId)`。
 *   本层用**结构探测**读它（`savesWarnings`），读不到就当没有警告，不假装看过。
 * - `SaveImportPlan` 没有 `expiresAt` / `entryCount` / `totalBytes`：条目数与字节数由 core
 *   写进 `warnings` 的人话里，本层原样带出，不自己再算一遍（包里还没解开，算了也是猜）。
 * - `SaveImportPlan.overwrites` 只有路径、没有 `rootId`：覆盖清单按路径展示，够用，不补根。
 */

import type {
  LauncherTask,
  RestoreOptions,
  SaveBackup,
  SaveEntry,
  SaveImportPlan,
  SaveManager,
  SaveRootSpec,
  TaskState,
} from '@kojo/plugin-api';
import { byCodePoint } from '../ui/commands';
import {
  describeFailure,
  formatBytes,
  taskProgressView,
  type FailureView,
  type LauncherTone,
} from './model';

/* ══════════════════════════════════════════════════════════════════════════════
 * 名词
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 面板只认这两档（`overlay` 与 shared 同一口径，但本面板按组长接线的契约只收这两档） */
export type SavesIsolation = 'shared' | 'copy';

/** 缺失读数的统一说法：一处定义，条目 / 备份 / 计划三处共用 */
export const MISSING_VALUE = '未记录';

/* ══════════════════════════════════════════════════════════════════════════════
 * 格式化：大小 / 时间
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 字节数 → 人话。
 *
 * 与 `formatBytes` 的差别只有一处：**缺失值说「未记录」**（`formatBytes` 对非法数是
 * 「未知大小」）。`0` 是合法读数（空文件），照实显示 `0 B`，不当成缺失。
 */
export function saveSizeText(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return MISSING_VALUE;
  return formatBytes(bytes);
}

const TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
};

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(locale: string | undefined): Intl.DateTimeFormat {
  const key = locale ?? '\u0000default';
  const hit = timeFormatters.get(key);
  if (hit !== undefined) return hit;
  let made: Intl.DateTimeFormat;
  try {
    made = new Intl.DateTimeFormat(locale, TIME_FORMAT_OPTIONS);
  } catch {
    // 非法 locale 不该把界面打断：退回默认 locale（读数还是真的，只是语言变了）
    made = new Intl.DateTimeFormat(undefined, TIME_FORMAT_OPTIONS);
  }
  timeFormatters.set(key, made);
  return made;
}

/** 数值 = epoch 毫秒（`SaveEntry.mtimeMs`）；字符串 = ISO-8601（`SaveBackup.createdAt`） */
function toStamp(value: string | number | null | undefined): Date | null {
  if (typeof value === 'number') {
    // 0 / 负数 = 上游把缺失归一成了 0（`launcher-core` 的 `nonNegative`）⇒ 别显示 1970 年
    if (!Number.isFinite(value) || value <= 0) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

/**
 * 时间 → 本地化人话（`YYYY/MM/DD HH:mm` 一族的本地格式）。
 *
 * 缺失 / 不可解析 ⇒「未记录」；`locale` 只给测试固定语言用，产品里走默认 locale
 * （作者看到的是自己系统的时间格式，与文件管理器一致）。
 */
export function saveTimeText(
  value: string | number | null | undefined,
  locale?: string,
): string {
  const stamp = toStamp(value);
  if (stamp === null) return MISSING_VALUE;
  return formatterFor(locale).format(stamp);
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 存档列表：按根分组
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 一个根的可写性判断。
 *
 * - `copy`：写的是实例内副本，不需要逐根授权；
 * - `readable`：这个根有条目（shared 下 ⇒ 已被批准，否则 core 不会列出来）；
 * - `needs-approval`：shared 下声明了却一条都没有 ⇒ 未批准 / 空目录（契约面不可区分）。
 */
export type SavesRootAccess = 'copy' | 'readable' | 'needs-approval';

export interface SaveEntryView {
  /** 稳定渲染键（`rootId + '/' + path`）：同一根里路径唯一 */
  readonly key: string;
  readonly name: string;
  /** 相对所属存档根的 posix 路径 */
  readonly path: string;
  readonly size: string;
  readonly time: string;
}

export interface SaveRootGroup {
  readonly rootId: string;
  /** adapter 声明的根标签；未声明的根退化为根 id（不编一个名字） */
  readonly label: string;
  /** 相对游戏目录的路径；未声明的根为 null */
  readonly relativePath: string | null;
  /** 是否在实例声明的 `saveRoots` 里 */
  readonly declared: boolean;
  readonly entries: readonly SaveEntryView[];
  readonly totalBytes: number;
  readonly access: SavesRootAccess;
}

export function saveEntryView(entry: SaveEntry, locale?: string): SaveEntryView {
  return {
    key: `${entry.rootId}/${entry.path}`,
    name: entry.name.trim() === '' ? entry.path : entry.name,
    path: entry.path,
    size: saveSizeText(entry.bytes),
    time: saveTimeText(entry.mtimeMs, locale),
  };
}

/** 缺失时间垫底（`-Infinity`），合法时间新的在前 */
function entryStamp(entry: SaveEntry): number {
  return Number.isFinite(entry.mtimeMs) && entry.mtimeMs > 0 ? entry.mtimeMs : Number.NEGATIVE_INFINITY;
}

function compareEntries(a: SaveEntry, b: SaveEntry): number {
  const ta = entryStamp(a);
  const tb = entryStamp(b);
  if (ta !== tb) return tb > ta ? 1 : -1;
  // 同一时刻按路径码点序：不用 localeCompare（中文排序随宿主 ICU 漂移，位置就不可复现）
  return byCodePoint(a.path, b.path);
}

function totalOf(entries: readonly SaveEntry[]): number {
  return entries.reduce(
    (sum, entry) => sum + (Number.isFinite(entry.bytes) && entry.bytes > 0 ? entry.bytes : 0),
    0,
  );
}

function accessOf(isolation: SavesIsolation, entryCount: number): SavesRootAccess {
  if (isolation === 'copy') return 'copy';
  return entryCount > 0 ? 'readable' : 'needs-approval';
}

/**
 * 按根分组。
 *
 * 顺序 = 实例声明的 `saveRoots` 顺序（adapter 声明的顺序就是界面上认得的顺序）；
 * 宿主报回来但实例没声明的根**不丢**：单独成组、标签退化为根 id 排在末尾，
 * 让「多了一个没见过的根」这件事在界面上看得见，而不是被悄悄滤掉。
 * 组内条目：修改时间新的在前，同刻按路径码点序。
 */
export function groupSaves(
  roots: readonly SaveRootSpec[],
  entries: readonly SaveEntry[],
  isolation: SavesIsolation,
  locale?: string,
): readonly SaveRootGroup[] {
  const declared = new Set(roots.map((root) => root.id));
  const buckets = new Map<string, SaveEntry[]>();
  for (const entry of entries) {
    const bucket = buckets.get(entry.rootId);
    if (bucket === undefined) buckets.set(entry.rootId, [entry]);
    else bucket.push(entry);
  }

  const groups: SaveRootGroup[] = [];
  for (const root of roots) {
    const bucket = [...(buckets.get(root.id) ?? [])].sort(compareEntries);
    const views = bucket.map((entry) => saveEntryView(entry, locale));
    groups.push({
      rootId: root.id,
      label: root.label.trim() === '' ? root.id : root.label,
      relativePath: root.relativePath,
      declared: true,
      entries: views,
      totalBytes: totalOf(bucket),
      access: accessOf(isolation, views.length),
    });
  }
  const extraIds = [...buckets.keys()].filter((rootId) => !declared.has(rootId)).sort(byCodePoint);
  for (const rootId of extraIds) {
    const bucket = [...(buckets.get(rootId) ?? [])].sort(compareEntries);
    const views = bucket.map((entry) => saveEntryView(entry, locale));
    groups.push({
      rootId,
      label: rootId,
      relativePath: null,
      declared: false,
      entries: views,
      totalBytes: totalOf(bucket),
      access: accessOf(isolation, views.length),
    });
  }
  return groups;
}

/** 一条都没读到的空态说明（`null` = 有东西可看，不要打扰） */
export function savesEmptyText(
  roots: readonly SaveRootSpec[],
  groups: readonly SaveRootGroup[],
): string | null {
  const total = groups.reduce((sum, group) => sum + group.entries.length, 0);
  if (total > 0) return null;
  if (roots.length === 0) {
    return '这个实例没有声明存档根（适配器未提供存档布局）：没有可列出的存档，备份也做不了。';
  }
  return '各个存档根里都没有条目：可能还没开始玩，也可能目录是空的。存档一出现点「刷新」就能列出来。';
}

/** 备份能不能点（没有声明存档根 ⇒ core 会以 `LAUNCHER_PLATFORM_UNSUPPORTED` 拒，先在这里说清） */
export function backupBlockedReason(roots: readonly SaveRootSpec[]): string | null {
  return roots.length === 0
    ? '这个实例没有声明存档根：备份不可用（启动器无从知道要打包哪个目录）。'
    : null;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 备份：来源归类 / 排序 / 投影
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 备份来源只分两类（用户主动 / 启动器自动），具体理由另给一句人话 */
export type BackupOriginKind = 'manual' | 'auto' | 'unknown';

export interface BackupOrigin {
  readonly kind: BackupOriginKind;
  /** 徽章上的两个字：手动 / 自动 */
  readonly label: string;
  readonly detail: string;
}

/**
 * `SaveBackup.reason` → 来源。
 *
 * 契约给了四档：`manual`（用户手点）、`auto`（配额内的自动备份）、`pre-restore` /
 * `pre-plugin`（安全回退点，不占用户配额）。后三档在界面上都属于「自动」，但**要说清
 * 是哪一次自动**——用户找的是「恢复前那份」，只写「自动」等于没写。
 * 未知值不吞：回显原文，并声明它只影响显示。
 */
export function backupOrigin(reason: SaveBackup['reason'] | string): BackupOrigin {
  switch (reason) {
    case 'manual':
      return { kind: 'manual', label: '手动', detail: '你主动新建的备份' };
    case 'auto':
      return { kind: 'auto', label: '自动', detail: '启动器自动做的备份（受配额清理）' };
    case 'pre-restore':
      return { kind: 'auto', label: '自动', detail: '恢复前自动备份（写回失败时用它回滚）' };
    case 'pre-plugin':
      return { kind: 'auto', label: '自动', detail: '装插件前自动备份（装失败时用它回滚）' };
    default:
      return {
        kind: 'unknown',
        label: `未知来源（${String(reason)}）`,
        detail: '这个来源标签不在契约的四档里：只影响显示，不影响恢复',
      };
  }
}

function backupStamp(backup: SaveBackup): number {
  const parsed = Date.parse(backup.createdAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** 备份列表：新的在前；时间不可解析的垫底，同刻按 id 码点序（稳定、可复现） */
export function sortBackups(backups: readonly SaveBackup[]): SaveBackup[] {
  return [...backups].sort((a, b) => {
    const ta = backupStamp(a);
    const tb = backupStamp(b);
    if (ta !== tb) return tb > ta ? 1 : -1;
    return byCodePoint(a.id, b.id);
  });
}

export interface BackupView {
  readonly id: string;
  readonly label: string;
  readonly time: string;
  readonly size: string;
  readonly entryCount: string;
  readonly origin: BackupOrigin;
}

/** 没写理由的备份：给一句稳定显示名，不留空白格 */
export function backupLabel(backup: SaveBackup): string {
  return backup.label.trim() === '' ? '未命名备份' : backup.label;
}

export function backupView(backup: SaveBackup, locale?: string): BackupView {
  return {
    id: backup.id,
    label: backupLabel(backup),
    time: saveTimeText(backup.createdAt, locale),
    size: saveSizeText(backup.bytes),
    entryCount:
      Number.isFinite(backup.entryCount) && backup.entryCount >= 0
        ? `${Math.trunc(backup.entryCount)} 个条目`
        : '条目数未记录',
    origin: backupOrigin(backup.reason),
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 写回门禁：shared 未授权根
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 需要先确认授权的根标签（顺序同分组顺序，去重） */
export function unapprovedRootLabels(groups: readonly SaveRootGroup[]): readonly string[] {
  const labels: string[] = [];
  for (const group of groups) {
    if (group.access !== 'needs-approval') continue;
    if (labels.includes(group.label)) continue;
    labels.push(group.label);
  }
  return labels;
}

/** 单个未授权根的人话（措辞是产品口径：**不给「强行」这条路**） */
export function unapprovedRootText(label: string): string {
  return `这个存档根还没被批准（要用目录对话框逐根授权）：「${label}」。先到实例设置里批准它，再回来点「刷新」；恢复与导入都会被这道门挡住。`;
}

/** 多个未授权根：逐枚点名（不合并成一个「某些根」） */
export function unapprovedRootsText(labels: readonly string[]): string {
  if (labels.length === 0) return '';
  if (labels.length === 1) return unapprovedRootText(labels[0] ?? '');
  return `这些存档根还没被批准（要用目录对话框逐根授权）：${labels.join('、')}。先逐个批准，再回来点「刷新」；恢复与导入都会被这道门挡住。`;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 恢复：二次确认
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface RestoreConfirmView {
  readonly title: string;
  /** 三步顺序说明（第一句必须写清「先自动备份当前存档，再覆盖」） */
  readonly steps: readonly string[];
  /** 「不保留当前存档」勾选框的说明（默认不勾） */
  readonly skipLine: string;
  readonly note: string;
  /** 非 null = 不给确认按钮（只给原因与「取消」） */
  readonly blockedReason: string | null;
}

/**
 * 恢复确认面板的读数。
 *
 * `backupCurrent` 的缺省是 **true**（契约 `RestoreOptions` 的默认），所以确认面板必须
 * 把「先自动备份当前存档，再覆盖」写成第一句；跳过备份那条要用户**额外**勾选才下发
 * （见 `restoreOptions`）。
 */
export function restoreConfirm(
  backup: SaveBackup,
  groups: readonly SaveRootGroup[],
): RestoreConfirmView {
  const blocked = unapprovedRootLabels(groups);
  return {
    title: `恢复备份「${backupLabel(backup)}」`,
    steps: [
      '先自动备份当前存档，再覆盖：目标备份里的文件会逐条写回各自的存档根。',
      '如果游戏正在运行，启动器会先停掉这次会话再写回（不一边写一边读）。',
      '写回失败时，用刚才那份「恢复前自动备份」逆序回滚，并把回滚结果一并告诉你。',
    ],
    skipLine:
      '只有额外勾选「不保留当前存档」才会跳过那份自动备份：当前存档被直接覆盖、失败时没有回退点。默认不勾。',
    note: 'shared 实例的写回是逐根授权的：列表里一条存档都没有的根，本面板按「还没批准」保守处理（也可能只是还没存过档）——两种情况都请先用目录对话框确认一次。',
    blockedReason: blocked.length === 0 ? null : unapprovedRootsText(blocked),
  };
}

/**
 * 勾选框 → `RestoreOptions`。
 *
 * **不勾 = 不传这个字段**（而不是传 `{ backupCurrent: true }`）：缺省语义归契约，
 * 本层不把默认值抄一遍；只有用户额外勾了「不保留当前存档」才传 `false`。
 */
export function restoreOptions(skipCurrentBackup: boolean): RestoreOptions | undefined {
  return skipCurrentBackup ? { backupCurrent: false } : undefined;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 导入：预检结果
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface ImportPlanView {
  readonly title: string;
  /** 预检「不写盘」的事实（一遍读得懂，不用猜） */
  readonly preview: string;
  readonly rows: readonly { readonly label: string; readonly value: string; readonly tone?: LauncherTone }[];
  readonly warnings: readonly string[];
  /** 非 null = 不给「确认导入」按钮（shared 未授权根） */
  readonly blockedReason: string | null;
}

/**
 * 预检 → 可渲染读数。
 *
 * `SaveImportPlan` 只有 `overwrites` / `warnings` / `backupId` 三个字段：
 * 条目数与总字节由 core 写在 `warnings` 的人话里（`导入包包含 N 个条目、合计 B 字节`），
 * 本层**原样**列出，不自己再从包里数一遍（包里还没解开，数出来就是猜）。
 */
export function importPlanView(
  plan: SaveImportPlan,
  groups: readonly SaveRootGroup[],
): ImportPlanView {
  const overwrites = plan.overwrites.filter((path) => path.trim() !== '');
  const blocked = unapprovedRootLabels(groups);
  const rows: { label: string; value: string; tone?: LauncherTone }[] = [
    {
      label: '覆盖',
      value:
        overwrites.length === 0
          ? '没有同名存档：这次全是新增'
          : `${overwrites.length} 个同名存档会被覆盖`,
      ...(overwrites.length === 0 ? {} : { tone: 'warn' as LauncherTone }),
    },
  ];
  if (overwrites.length > 0) {
    rows.push({ label: '覆盖清单', value: overwrites.join('\n') });
  }
  rows.push({
    label: '回滚快照',
    value:
      plan.backupId.trim() === ''
        ? '预检没有给出回滚快照：应用导入会因为缺少回退点被拒'
        : `预检期已做好（${plan.backupId}）：应用失败会用它写回`,
  });
  return {
    title: '导入预检结果',
    preview:
      '预检是只读的：导入包只被解到暂存目录、算好覆盖清单，**还没有写回任何存档**。点「确认导入」才真正落盘（并先用上面那份快照兜底）。' +
      '预检计划有有效期：过期后「确认导入」会被拒（码与原文会照实显示），重新选包预检一次即可。',
    rows,
    warnings: plan.warnings.filter((line) => line.trim() !== ''),
    blockedReason: blocked.length === 0 ? null : unapprovedRootsText(blocked),
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 导出
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 导出按钮旁的一句说明：导什么、落点由谁定 */
export function exportNote(groups: readonly SaveRootGroup[]): string {
  const entries = groups.reduce((sum, group) => sum + group.entries.length, 0);
  if (groups.length === 0) {
    return '没有可导出的存档根：导出会是一个空包，先确认这个实例声明了存档目录。';
  }
  return `导出会把全部 ${groups.length} 个存档根的 ${entries} 个条目打成一个包；落点由系统保存对话框决定。`;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 任务：三态文案
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 任务三态（界面一句话只看这三档；细粒度进度由 `detail` 给） */
export type SavesTaskPhase = 'pending' | 'succeeded' | 'failed' | 'cancelled';

const PHASE_LABELS: Readonly<Record<SavesTaskPhase, string>> = {
  pending: '进行中',
  succeeded: '完成',
  failed: '失败',
  cancelled: '已取消',
};

export function savesTaskPhase(state: TaskState): SavesTaskPhase {
  switch (state) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

/** 三态人话；`queued` 单说「排队中」（它确实在等，不是在做） */
export function savesTaskPhaseLabel(state: TaskState): string {
  return state === 'queued' ? '排队中' : PHASE_LABELS[savesTaskPhase(state)];
}

/**
 * 存档任务的标题。
 *
 * 为什么本层自己有一张：`model.taskKindLabel` 只登记了恢复（`save-restore`），备份 /
 * 导入会掉进「后台任务（save-backup）」这种给排障看的兜底串里，不该出现在用户界面。
 * 表只覆盖这条能力面的三个 kind，别的一律回落 `model` 的兜底（不重复登记全表）。
 */
const SAVE_TASK_TITLES: Readonly<Record<string, string>> = {
  'save-backup': '备份存档',
  'save-restore': '恢复存档',
  'save-import': '导入存档',
};

export function savesTaskTitle(kind: string): string {
  return SAVE_TASK_TITLES[kind] ?? `存档任务（${kind}）`;
}

export interface SavesTaskBanner {
  readonly title: string;
  readonly phase: SavesTaskPhase;
  readonly phaseLabel: string;
  readonly tone: LauncherTone;
  readonly detail: string;
  readonly percent: number | null;
  readonly terminal: boolean;
  readonly errorText: string | null;
  readonly cancellable: boolean;
}

/**
 * 任务读数 → 横幅。
 *
 * 标题与三态文案本层给（存档名词 + 三态），细粒度进度 / 百分比 / 失败原文**复用**
 * `taskProgressView`：进度单位怎么读、终态怎么判只有一份实现。
 */
export function savesTaskBanner(task: LauncherTask): SavesTaskBanner {
  const progress = taskProgressView(task);
  return {
    title: savesTaskTitle(task.kind),
    phase: savesTaskPhase(task.state),
    phaseLabel: savesTaskPhaseLabel(task.state),
    tone: progress.tone,
    detail: progress.detail,
    percent: progress.percent,
    terminal: progress.terminal,
    errorText: progress.errorText,
    cancellable: progress.cancellable,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 错误：码与原样不动，只补「为什么 + 下一步」
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 存档页里会失败的八条腿（标题按动作分，不合并成一句「出错了」） */
export type SavesAction =
  | 'list'
  | 'backups'
  | 'backup'
  | 'restore'
  | 'pick-archive'
  | 'plan-import'
  | 'apply-import'
  | 'export';

const SAVES_ACTION_TITLES: Readonly<Record<SavesAction, string>> = {
  list: '读取存档列表失败',
  backups: '读取备份列表失败',
  backup: '新建备份失败',
  restore: '恢复存档失败',
  'pick-archive': '选择导入包失败',
  'plan-import': '导入预检失败',
  'apply-import': '应用导入失败',
  export: '导出存档失败',
};

export interface SavesErrorAdvice {
  readonly heading: string;
  readonly explanation: string;
  readonly nextStep: string;
}

/**
 * 存档能力面最常撞的四类错误：**为什么**（码背后的机制）+ 具体下一步。
 *
 * 与 `launcherErrorHint` 的分工同 `model.launchErrorAdvice`：那张表按码给一句下一步、
 * 覆盖全部码；这张表只对这四类多说一层原因。码与原文照旧原样显示，这里一个字都不改写。
 */
const SAVES_ADVICE_BY_CODE: Readonly<Record<string, SavesErrorAdvice>> = {
  LAUNCHER_SOURCE_NOT_APPROVED: {
    heading: '这个存档根还没被批准写入',
    explanation:
      'shared 实例写回的是你原来的游戏目录，所以每个存档根都要单独授权；授权只由原生目录对话框写入，启动器不接受手填或自动放行的路径。',
    nextStep: '到实例设置里用目录对话框逐根批准存档根，回到存档页点「刷新」后再操作。',
  },
  LAUNCHER_TASK_BUSY: {
    heading: '上一件存档操作还没结束',
    explanation:
      '同一实例的备份 / 恢复 / 导入是串行的：同时写同一份存档会互相踩，所以后到的命令会被直接拒绝。',
    nextStep: '看上面的任务横幅，等它走到「完成」或「失败」再点一次；不要连点。',
  },
  LAUNCHER_PATH_ESCAPE: {
    heading: '路径被判成越界，已经拒绝',
    explanation:
      '存档写回只认「根 id + 相对名」：出现盘符、`..` 或多层分隔符一律拒（这是确定性拒绝，重试不会变好）。',
    nextStep: '检查这份备份 / 导入包里有没有异常文件名；必要时重做一份备份再试。',
  },
  LAUNCHER_PLATFORM_UNSUPPORTED: {
    heading: '这一版还没有存档相关的宿主能力',
    explanation:
      '要么桌面壳还没接入这条存档命令，要么这个游戏没有声明存档目录（适配器未提供存档布局）——两种都走不到写盘那一步。',
    nextStep: '先继续编辑；存档页只显示能确认的读数，不会假装成功。',
  },
};

export function savesErrorAdvice(code: string | null | undefined): SavesErrorAdvice | null {
  if (code === null || code === undefined) return null;
  return SAVES_ADVICE_BY_CODE[code] ?? null;
}

/** 失败读数 = `model.FailureView` + 本层的四类建议（码与原文仍由 `describeFailure` 原样带出） */
export interface SavesFailure extends FailureView {
  readonly advice: SavesErrorAdvice | null;
}

/**
 * 任意抛出物 → 存档页可渲染的失败读数。
 *
 * 解析与「下一步」表全部复用 `model.describeFailure`（一处解析、一处兜底话术），
 * 本层只换标题（按动作）并补四类原因说明——不重抄码表，也不改写 message / detail。
 */
export function describeSavesFailure(error: unknown, action: SavesAction): SavesFailure {
  const base = describeFailure(error, 'list');
  return { ...base, title: SAVES_ACTION_TITLES[action], advice: savesErrorAdvice(base.code) };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 契约缺口的读取面：`launcher-core` 外挂的 `warnings(instanceId)`
 * ══════════════════════════════════════════════════════════════════════════════ */

interface SaveManagerWarnings {
  readonly warnings?: (instanceId: string) => readonly string[];
}

/**
 * 读实现侧外挂的警告（契约 `list()` 装不下它们，见文件头缺口）。
 *
 * 结构探测而不是类型断言到 `LauncherService`：别的实现没有这条方法时返回空数组，
 * 界面就少一行说明——**不伪造**「没有警告」之外的任何结论。
 */
export function savesWarnings(saves: SaveManager, instanceId: string): readonly string[] {
  const probe = (saves as SaveManagerWarnings).warnings;
  if (typeof probe !== 'function') return [];
  try {
    const value = probe.call(saves, instanceId);
    if (!Array.isArray(value)) return [];
    return value.filter((line): line is string => typeof line === 'string' && line.trim() !== '');
  } catch {
    // 警告通道自己炸了不该把面板打断：列表已经读到了，这只是补充说明
    return [];
  }
}
