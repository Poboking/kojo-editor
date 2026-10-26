/**
 * 启动器 · 实例详情的「内容包」面板 —— **纯函数层**（UI-CONTENT 车道）。
 *
 * 分工与 `./model.ts` 同一条纪律：视图（`content-panel.tsx`）只做渲染、订阅与命令调用，
 * 凡是「把读数变成人话」的判断都住这里——纯函数、零 React、零 IO、零磁盘知识。
 *
 * 本层**不造第二份真源**：
 * - 冲突的合法决议由 `launcher-core/content-manager.ts::resolveConflicts` 定：
 *   `other-pack` 只接受 `skip` / `replace`（`overwrite` 不转移归属 ⇒ 会被拒）、
 *   `base-file` 只接受 `skip` / `overwrite`（`replace` 没有「从谁手里拿」的对象）。
 *   本层只把这套规则**投影成按钮**，不另立宽容口径；
 * - 任务进度 / 字节格式 / 通用错误建议复用 `./model.ts`（`taskProgressView` /
 *   `formatBytes` / `launcherErrorHint`），这里只补「三态收尾话术」；
 * - 诊断的四组（缺失 / 篡改 / 孤儿 / 顺序异常）是**契约码表 + 固定人话前缀**的投影：
 *   契约 `ContentDiagnosis.issues[].code` 只有四项，`orphan-file` / `load-order` 被
 *   `launcher-core` 折进 `conflict` 并用「孤儿文件：」「启用顺序异常：」前缀区分
 *   （见该文件「已知契约缺口 2」）。本层按同一前缀归组；对不上的一条进「其它冲突」组，
 *   不静默丢弃。
 *
 * 视觉档位（`LauncherTone`）只表达语义，配色住 `launcher.css` 的 token，本层零颜色字面量。
 */

import type {
  ConflictResolution,
  ContentConflict,
  ContentDiagnosis,
  ContentInstallPlan,
  ContentPackKind,
  InstalledContent,
  LauncherTask,
  TaskCenter,
  TaskState,
  Unsubscribe,
} from '@kojo/plugin-api';
import { formatBytes, launcherErrorHint, taskProgressView, type LauncherTone } from './model';

/* ══════════════════════════════════════════════════════════════════════════════
 * 名词 → 中文
 * ══════════════════════════════════════════════════════════════════════════════ */

const PACK_KIND_LABELS: Readonly<Record<ContentPackKind, string>> = {
  script: '脚本',
  resource: '资源',
  data: '数据',
  plugin: '插件',
  bundle: '整合包',
};

/** 包类型的人话；未知值回显原值（宿主给了新版没登记的 kind 时要看得见） */
export function packKindLabel(kind: string): string {
  return PACK_KIND_LABELS[kind as ContentPackKind] ?? `未知类型（${kind}）`;
}

/** 码点序比较（不用 `localeCompare`：中文顺序随宿主 ICU 漂移） */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 已装列表：一行一个包（名称 / 版本 / kind / 启用态 / 顺序 / 状态徽标）
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface ContentRowView {
  readonly packId: string;
  readonly name: string;
  readonly version: string;
  readonly kindLabel: string;
  /** 宿主记的加载序号（`state.json` 的 `loadOrder`） */
  readonly order: number;
  /** 展示位次（1 起，按 order 排序后的位置；与 `order` 分开，避免「0 号」这种读法） */
  readonly rank: number;
  readonly enabled: boolean;
  readonly enabledLabel: string;
  readonly enabledTone: LauncherTone;
  readonly statusLabel: string;
  readonly statusTone: LauncherTone;
  readonly fileCount: number;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}

const STATUS_LABELS: Readonly<Record<InstalledContent['status'], { label: string; tone: LauncherTone }>> = {
  ok: { label: '正常', tone: 'ok' },
  conflict: { label: '有冲突', tone: 'warn' },
  broken: { label: '已损坏', tone: 'warn' },
};

/** 排序键：先 `order`，同序号按包 id 码点序（并列 = 加载次序不确定，诊断会点名） */
function sortPacks(packs: readonly InstalledContent[]): InstalledContent[] {
  return [...packs].sort(
    (a, b) =>
      a.order - b.order ||
      byCodePoint(a.manifest.name, b.manifest.name) ||
      byCodePoint(a.manifest.id, b.manifest.id),
  );
}

/**
 * 已装列表的渲染投影。
 *
 * `canMoveUp` / `canMoveDown` 按**位次**判边界：上移/下移最终是给 `setOrder` 一个
 * 「已安装 id 的排列」，首尾再挪只会得到同一个排列——按钮该是灰的，而不是点了没反应。
 */
export function contentRows(packs: readonly InstalledContent[]): readonly ContentRowView[] {
  const sorted = sortPacks(packs);
  return sorted.map((pack, index) => {
    const status = STATUS_LABELS[pack.status] ?? {
      label: `未知状态（${String(pack.status)}）`,
      tone: 'warn' as LauncherTone,
    };
    return {
      packId: pack.manifest.id,
      name: pack.manifest.name,
      version: pack.manifest.version,
      kindLabel: packKindLabel(pack.manifest.kind),
      order: pack.order,
      rank: index + 1,
      enabled: pack.enabled,
      enabledLabel: pack.enabled ? '已启用' : '已停用',
      enabledTone: pack.enabled ? 'ok' : 'idle',
      statusLabel: status.label,
      statusTone: status.tone,
      fileCount: pack.ownedFiles.length,
      canMoveUp: index > 0,
      canMoveDown: index < sorted.length - 1,
    };
  });
}

/**
 * 上移 / 下移一位后的**完整 id 排列**（`null` = 已在边界，不做任何事）。
 *
 * 返回整份排列而不是「目标位置」：`ContentManager.setOrder` 只接受已安装 id 的排列
 * （漏项 / 多项 / 重复一律拒），UI 交整份最不容易出现「只挪了一侧」的半截状态。
 */
export function moveOrder(
  packs: readonly InstalledContent[],
  packId: string,
  direction: -1 | 1,
): readonly string[] | null {
  const ids = sortPacks(packs).map((pack) => pack.manifest.id);
  const index = ids.indexOf(packId);
  if (index < 0) return null;
  const target = index + direction;
  if (target < 0 || target >= ids.length) return null;
  const next = [...ids];
  const moved = ids[index] as string;
  const displaced = ids[target] as string;
  next[index] = displaced;
  next[target] = moved;
  return next;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 行内确认文案（危险动作二次确认；每颗按钮各自一条）
 * ══════════════════════════════════════════════════════════════════════════════ */

export type RowConfirmKind = 'uninstall' | 'disable' | 'enable' | 'order';

export interface RowConfirmInput {
  readonly kind: RowConfirmKind;
  readonly name: string;
  /** `kind = 'order'` 时的方向 */
  readonly direction?: 'up' | 'down';
  /** 本包写入的文件数（卸载确认里报数，避免「删了什么」说不清） */
  readonly fileCount?: number;
}

/**
 * 一次确认条的人话。
 *
 * 卸载必须说清**只删本包写入的文件**：宿主按 `ownership.json` 删，别的包或基础游戏
 * 写过的同名文件不在清单里（`launcher-core::splitOwnership` 把共有路径剔出来只记警告），
 * 游戏存档也不动。把这条写在确认条上，比事后再解释便宜得多。
 */
export function rowConfirmText(input: RowConfirmInput): string {
  const count = input.fileCount === undefined ? '本包写入的文件' : `本包写入的 ${input.fileCount} 个文件`;
  switch (input.kind) {
    case 'uninstall':
      return `卸载「${input.name}」？只删${count}；别的包或基础游戏写过的同名文件不动，游戏存档不受影响。`;
    case 'disable':
      return `停用「${input.name}」？本包写入的文件会被撤下、恢复安装前的原文件（下次启动游戏生效）。`;
    case 'enable':
      return `启用「${input.name}」？会重新写入本包的文件（下次启动游戏生效）。`;
    case 'order':
      return `把「${input.name}」${input.direction === 'up' ? '上移' : '下移'}一位？加载顺序会变，下次启动游戏生效。`;
    default:
      return `确认对「${input.name}」执行这项操作？`;
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 安装计划读数（条目数 / 字节 / 冲突 / 过期时刻）
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface PlanFactRow {
  readonly label: string;
  readonly value: string;
  readonly tone?: LauncherTone;
}

export interface PlanReadout {
  /** 「包名（版本）」 */
  readonly title: string;
  /** 一行副标题：包 id · 类型 · 目标根 */
  readonly subtitle: string;
  readonly rows: readonly PlanFactRow[];
  readonly entryCount: number;
  readonly byteTotal: number;
  readonly conflictCount: number;
  readonly expired: boolean;
  readonly expiresText: string;
}

/** 剩余时间的粗档（分钟级就够：计划的有效期是分钟量级，秒级读数会被时钟漂移骗） */
function durationText(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds} 秒` : `${minutes} 分 ${seconds} 秒`;
}

/**
 * 安装计划 → 可渲染读数。
 *
 * 三个数**逐条来自计划本体**（`manifest.files` / `additions` / `overwrites` / `conflicts`），
 * 不做任何估算：§10.1 要求「展示的数量与实际应用必须逐条对得上」，所以这里只搬运，不四舍五入。
 * `expiresAt` 读不出来按**已过期**处理（陈旧的 applies 是这条管线最贵的一种错）。
 */
export function planReadout(plan: ContentInstallPlan, nowMs: number = Date.now()): PlanReadout {
  const entryCount = plan.manifest.files.length;
  const byteTotal = plan.manifest.files.reduce(
    (sum, file) => sum + (Number.isFinite(file.size) && file.size > 0 ? file.size : 0),
    0,
  );
  const deadline = Date.parse(plan.expiresAt);
  const remaining = Number.isFinite(deadline) ? deadline - nowMs : Number.NaN;
  const expired = !Number.isFinite(remaining) || remaining <= 0;
  const expiresText = !Number.isFinite(remaining)
    ? '计划的过期时刻不可读：请重新预检'
    : expired
      ? `计划已过期（${plan.expiresAt}），需要重新预检`
      : `计划还有 ${durationText(remaining)} 到期（${plan.expiresAt}）`;

  const targets =
    plan.targets.length === 0
      ? '（无目标根）'
      : plan.targets.map((target) => target.rootId).join('、');

  const rows: PlanFactRow[] = [
    { label: '版本', value: plan.manifest.version },
    { label: '类型', value: packKindLabel(plan.manifest.kind) },
    { label: '条目', value: `${entryCount} 个文件` },
    { label: '体积', value: formatBytes(byteTotal) },
    { label: '新增', value: `${plan.additions.length} 个` },
    {
      label: '覆盖',
      value: `${plan.overwrites.length} 个`,
      ...(plan.overwrites.length > 0 ? { tone: 'warn' as LauncherTone } : {}),
    },
    {
      label: '冲突',
      value: `${plan.conflicts.length} 条`,
      ...(plan.conflicts.length > 0 ? { tone: 'warn' as LauncherTone } : {}),
    },
    { label: '过期', value: expiresText, ...(expired ? { tone: 'warn' as LauncherTone } : {}) },
  ];

  return {
    title: `${plan.manifest.name}（${plan.manifest.version}）`,
    subtitle: `${plan.manifest.id} · ${packKindLabel(plan.manifest.kind)} · 目标根 ${targets}`,
    rows,
    entryCount,
    byteTotal,
    conflictCount: plan.conflicts.length,
    expired,
    expiresText,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 冲突 → 选项（逐条决议；合法性口径与 launcher-core 同源）
 * ══════════════════════════════════════════════════════════════════════════════ */

export type ContentConflictAction = ConflictResolution['action'];

export interface ConflictOption {
  readonly action: ContentConflictAction;
  readonly label: string;
  readonly hint: string;
}

export interface ConflictRowView {
  /** 决议的比对键：`rootId/path`（与 `launcher-core::refKey` 的可读形态一致） */
  readonly key: string;
  readonly path: string;
  readonly kind: ContentConflict['kind'];
  readonly kindLabel: string;
  /** 这条冲突撞的是谁 */
  readonly ownerLabel: string;
  readonly options: readonly ConflictOption[];
}

export function conflictKey(ref: { readonly rootId: string; readonly path: string }): string {
  return `${ref.rootId}/${ref.path}`;
}

const SKIP_HINT = '保留磁盘上现有的那一份，本包这次不写这个文件（包里其余文件照常安装）。';
const REPLACE_HINT = '把这条路径的拥有权从那个包转到本包：那个包卸载时就不会再删它。';
const OVERWRITE_HINT = '这是基础游戏文件：会先备份原文件再覆盖，卸载时按备份恢复。';

/**
 * 一条冲突的法律选项。
 *
 * `other-pack` 只给 `replace`（转移归属）：`overwrite` 不转移拥有权，`launcher-core`
 * 会直接拒；`base-file` 只给 `overwrite`：`replace` 没有「从谁手里拿」的对象。
 * 顺序是「跳过 → 改盘」：默认（不选）什么都不写，安全的那个排前面。
 */
export function conflictOptions(conflict: ContentConflict): readonly ConflictOption[] {
  if (conflict.kind === 'other-pack') {
    return [
      { action: 'skip', label: '跳过', hint: SKIP_HINT },
      { action: 'replace', label: '替换（接管归属）', hint: REPLACE_HINT },
    ];
  }
  return [
    { action: 'skip', label: '跳过', hint: SKIP_HINT },
    { action: 'overwrite', label: '覆盖（先备份）', hint: OVERWRITE_HINT },
  ];
}

export function conflictRows(plan: Pick<ContentInstallPlan, 'conflicts'>): readonly ConflictRowView[] {
  return plan.conflicts.map((conflict) => ({
    key: conflictKey(conflict),
    path: conflictKey(conflict),
    kind: conflict.kind,
    kindLabel: conflict.kind === 'other-pack' ? '撞别的包' : '撞基础游戏文件',
    ownerLabel:
      conflict.existingPackId === null ? '现有这一份不属于任何已装包' : `现有这一份属于 ${conflict.existingPackId}`,
    options: conflictOptions(conflict),
  }));
}

export interface ResolutionBuild {
  /** 已决断的条目（顺序 = 计划里冲突的顺序，调用方不必再排） */
  readonly resolutions: readonly ConflictResolution[];
  /** 还没决断的冲突键（非空 ⇒ 不能 apply：`launcher-core` 会整份拒绝） */
  readonly pending: readonly string[];
}

/**
 * 用户选择 → `ConflictResolution[]`。
 *
 * 逐条收集而不是「全选同意」一把梭：契约没有 `abort`，取消整装走 UI 的「取消安装」；
 * 漏一条就会在 `apply` 时收到 `LAUNCHER_CONTENT_CONFLICT`（「还有冲突没有决断」），
 * 所以这里先把漏项算出来，让按钮在点之前就是灰的。
 */
export function buildResolutions(
  plan: Pick<ContentInstallPlan, 'conflicts'>,
  choices: Readonly<Record<string, ContentConflictAction>>,
): ResolutionBuild {
  const resolutions: ConflictResolution[] = [];
  const pending: string[] = [];
  for (const conflict of plan.conflicts) {
    const key = conflictKey(conflict);
    const action = choices[key];
    const legal = conflictOptions(conflict).some((option) => option.action === action);
    if (action === undefined || !legal) {
      pending.push(key);
      continue;
    }
    resolutions.push({ rootId: conflict.rootId, path: conflict.path, action });
  }
  return { resolutions, pending };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 任务 → 三态文案（安装 / 卸载 / 启停共用）
 * ══════════════════════════════════════════════════════════════════════════════ */

const CONTENT_TASK_LABELS: Readonly<Record<string, string>> = {
  'content-install': '安装内容包',
  'content-uninstall': '卸载内容包',
  'content-toggle': '切换内容包启停',
};

export interface ContentTaskView {
  readonly state: TaskState;
  readonly headline: string;
  readonly detail: string;
  readonly note: string;
  readonly tone: LauncherTone;
  readonly terminal: boolean;
  readonly cancellable: boolean;
  readonly errorText: string | null;
  readonly percent: number | null;
}

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'succeeded',
  'failed',
  'cancelled',
]);

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * 任务读数 → 可渲染进度 + **三态收尾话术**（成功 / 失败 / 已取消各自说清磁盘上发生了什么）。
 *
 * 进度条与字节格式复用 `model.taskProgressView`（那里已按 `unit` 分 bytes / files / steps）；
 * 这里只补「收尾之后」这一层，因为内容包的收尾不是「完成了」一句话：失败与取消都意味着
 * 宿主走了逆序回滚（`launcher-core` 从不写 ownership，取消后不会留下半落盘的包）。
 */
export function contentTaskView(task: LauncherTask): ContentTaskView {
  const base = taskProgressView(task);
  const label = CONTENT_TASK_LABELS[task.kind];
  const headline =
    label === undefined
      ? base.headline
      : task.state === 'queued'
        ? `排队等待：${label}`
        : task.state === 'running'
          ? `正在${label}…`
          : task.state === 'succeeded'
            ? `${label}完成`
            : task.state === 'failed'
              ? `${label}失败`
              : `${label}已取消`;
  const note =
    task.state === 'succeeded'
      ? '写盘完成：已装列表、启用状态与顺序以本面板刷新后的读数为准。'
      : task.state === 'failed'
        ? '宿主已按逆序回滚本次写入，磁盘上不应留下半成品；按上面的建议处理后可以重试。'
        : task.state === 'cancelled'
          ? '已取消：宿主已回滚，这次没有写入任何文件。'
          : task.state === 'queued'
            ? '排队中：同一实例同一时刻只跑一条写盘任务（单飞）。'
            : '进行中：可取消的任务会在下方给出取消入口。';
  return {
    state: task.state,
    headline,
    detail: base.detail,
    note,
    tone: base.tone,
    terminal: base.terminal,
    cancellable: base.cancellable,
    errorText: base.errorText,
    percent: base.percent,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 任务进度：订阅优先，轮询兜底（与 `model.watchProcessStatus` 同一取舍）
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 兜底轮询间隔（服务没有推送能力时；比事件粗，但够看清「还在跑 / 完了」） */
export const CONTENT_TASK_POLL_INTERVAL_MS = 800;

export interface ContentTaskTimer {
  readonly setInterval: typeof setInterval;
  readonly clearInterval: typeof clearInterval;
}

const DEFAULT_TASK_TIMER: ContentTaskTimer = { setInterval, clearInterval };

/** 进度从哪来（面板上如实写出来：订阅 vs 轮询，不让用户猜） */
export function taskWatchMode(tasks: Pick<TaskCenter, 'subscribe'>): 'subscribe' | 'poll' {
  return typeof (tasks as { subscribe?: unknown }).subscribe === 'function' ? 'subscribe' : 'poll';
}

/**
 * 盯住一条任务。**优先订阅** `tasks.subscribe`（宿主推来的快照才是真相）；
 * 服务没实现推送时退化为 `CONTENT_TASK_POLL_INTERVAL_MS` 轮询 `tasks.get`。
 *
 * 先读一次快照：任务可能在面板订阅之前就已经在跑、甚至已经结束——不补这一拍，
 * 界面会永远停在「进行中」。已在终态则直接返回空断订阅（不再挂定时器）。
 */
export function watchContentTask(
  tasks: Pick<TaskCenter, 'get' | 'subscribe'>,
  taskId: string,
  onTask: (task: LauncherTask) => void,
  timer: ContentTaskTimer = DEFAULT_TASK_TIMER,
): Unsubscribe {
  const snapshot = tasks.get(taskId);
  if (snapshot !== null) onTask(snapshot);
  if (snapshot !== null && isTerminalTaskState(snapshot.state)) return () => undefined;
  if (taskWatchMode(tasks) === 'subscribe') {
    return tasks.subscribe((task) => {
      if (task.id === taskId) onTask(task);
    });
  }
  const handle = timer.setInterval(() => {
    const latest = tasks.get(taskId);
    if (latest !== null) onTask(latest);
  }, CONTENT_TASK_POLL_INTERVAL_MS);
  return () => {
    timer.clearInterval(handle);
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 诊断 → 四组（缺失 / 篡改 / 孤儿 / 顺序异常）
 * ══════════════════════════════════════════════════════════════════════════════ */

export type DiagnosisGroupKey = 'missing' | 'tampered' | 'orphan' | 'order' | 'other';

export interface DiagnosisItemView {
  readonly key: string;
  readonly packId: string;
  readonly path: string | null;
  /** 原样的人话（`launcher-core` 已加「文件缺失：」这类前缀，这里一个字都不改写） */
  readonly message: string;
}

export interface DiagnosisGroupView {
  readonly key: DiagnosisGroupKey;
  readonly label: string;
  /** 这一组在说什么（人话） */
  readonly explanation: string;
  /** 这一组该怎么办 */
  readonly nextStep: string;
  readonly items: readonly DiagnosisItemView[];
}

export interface DiagnosisView {
  readonly ok: boolean;
  /** 一行总结（无问题 = 「未发现问题」） */
  readonly headline: string;
  readonly issueCount: number;
  readonly groups: readonly DiagnosisGroupView[];
}

const GROUP_ORDER: readonly DiagnosisGroupKey[] = ['missing', 'tampered', 'orphan', 'order'];

const GROUP_TEXT: Readonly<
  Record<DiagnosisGroupKey, { label: string; explanation: string; nextStep: string }>
> = {
  missing: {
    label: '缺失',
    explanation: '包声明要写的文件不在磁盘上：可能被删、被挪走，或安装记录里的依赖包没装。',
    nextStep: '重新安装这个包（会把缺的文件补回来）；缺依赖的先装上依赖包。',
  },
  tampered: {
    label: '篡改',
    explanation: '文件在安装之后被改动过，哈希与安装记录对不上（也可能是你自己改的）。',
    nextStep: '想保留改动就不动它；要回到安装时的样子就重新安装这个包（先备份你的改动）。',
  },
  orphan: {
    label: '孤儿',
    explanation: '磁盘上有本包写入的文件，安装记录里却没有它——通常是手工复制或半截安装留下的。',
    nextStep: '重新安装这个包让它重新登记，或卸载这个包清掉这些文件。',
  },
  order: {
    label: '顺序异常',
    explanation: '两个启用的包并列在同一个加载序号上，谁先谁后不确定；同序号会让覆盖结果随机。',
    nextStep: '在已装列表里用上移 / 下移把它们错开，再重跑一次诊断。',
  },
  other: {
    label: '其它冲突',
    explanation: '归属冲突或缺省归类：码表里没有更细的档位，原文见每一条。',
    nextStep: '按每条的原文处理；拿不准就把这一条连同包 id 反馈给开发者。',
  },
};

function groupOfIssue(issue: ContentDiagnosis['issues'][number]): DiagnosisGroupKey {
  switch (issue.code) {
    case 'missing-file':
    case 'missing-dependency':
      return 'missing';
    case 'hash-mismatch':
      return 'tampered';
    case 'conflict':
      // 契约码表装不下孤儿 / 顺序两档 ⇒ `launcher-core` 用固定人话前缀区分（缺口 2）
      if (issue.message.startsWith('孤儿文件')) return 'orphan';
      if (issue.message.startsWith('启用顺序异常')) return 'order';
      return 'other';
    default:
      return 'other';
  }
}

/**
 * 诊断读数 → 四组 + 计数。
 *
 * 四组**恒定存在**（哪怕 0 项）：用户要能一眼看出「哪些类别查过、哪些真有」。第五组
 * 「其它冲突」只在非空时出现——它是兜底，不该常驻占位。`ok` 只看 `issues` 是否为空，
 * 不看 `warnings`（那是 `launcher-core` 的加性字段，人话汇总）。
 */
export function diagnosisView(diagnosis: ContentDiagnosis): DiagnosisView {
  const buckets = new Map<DiagnosisGroupKey, DiagnosisItemView[]>();
  for (const key of [...GROUP_ORDER, 'other'] as DiagnosisGroupKey[]) buckets.set(key, []);
  for (const issue of diagnosis.issues) {
    const list = buckets.get(groupOfIssue(issue)) as DiagnosisItemView[];
    list.push({
      key: `${issue.packId}|${issue.code}|${issue.path ?? ''}|${issue.message}`,
      packId: issue.packId,
      path: issue.path ?? null,
      message: issue.message,
    });
  }
  const groups: DiagnosisGroupView[] = GROUP_ORDER.map((key) => ({
    key,
    label: GROUP_TEXT[key].label,
    explanation: GROUP_TEXT[key].explanation,
    nextStep: GROUP_TEXT[key].nextStep,
    items: buckets.get(key) as DiagnosisItemView[],
  }));
  const other = buckets.get('other') as DiagnosisItemView[];
  if (other.length > 0) {
    groups.push({
      key: 'other',
      label: GROUP_TEXT.other.label,
      explanation: GROUP_TEXT.other.explanation,
      nextStep: GROUP_TEXT.other.nextStep,
      items: other,
    });
  }
  const count = (key: DiagnosisGroupKey): number =>
    (buckets.get(key) as DiagnosisItemView[]).length;
  const issueCount = diagnosis.issues.length;
  const headline =
    issueCount === 0
      ? '未发现问题'
      : `共检出 ${issueCount} 项内容问题（缺失 ${count('missing')} · 篡改 ${count('tampered')} · 孤儿 ${count('orphan')} · 顺序 ${count('order')}${other.length > 0 ? ` · 其它 ${other.length}` : ''}）`;
  return { ok: issueCount === 0, headline, issueCount, groups };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 错误：码与原文都不改写，只补「为什么 + 下一步」
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface ContentAdvice {
  readonly heading: string;
  readonly explanation: string;
  readonly nextStep: string;
}

const ADVICE_BY_CODE: Readonly<Record<string, ContentAdvice>> = {
  LAUNCHER_CONTENT_CONFLICT: {
    heading: '文件冲突没有决断（或被冲突规则拒绝）',
    explanation:
      '装包会覆盖别的包或基础游戏写过的同名文件：每条冲突都必须逐条决定「跳过」还是「改盘」，漏一条整包都不落盘（一半决议 = 会少装一半文件）。',
    nextStep:
      '重新预检这个包，把每条冲突分别选「跳过」或「替换 / 覆盖」再点安装；不想动盘就点「取消安装」。',
  },
  LAUNCHER_TASK_BUSY: {
    heading: '这个实例正忙（同一时刻只许一条写盘任务）',
    explanation:
      '内容包与插件共用一把每实例写盘锁：上一个安装 / 卸载 / 启停放定之前，新的命令在发到宿主之前就被拒（不排队，否则连点两下会变成装两遍）。',
    nextStep: '等当前任务在进度里走完（或先取消），再点一次；期间别重复点按钮。',
  },
  LAUNCHER_SOURCE_NOT_APPROVED: {
    heading: '目标内容根还没被授权（或不在实例声明的根里）',
    explanation:
      '共享实例下写游戏目录要逐根批准（原生目录对话框即授权）；包要写进的根若不在批准表或不在实例的内容根清单里，一律拒绝。',
    nextStep: '用目录对话框逐根批准后再试；或改用「独立副本」实例装这个包。',
  },
  LAUNCHER_PLATFORM_UNSUPPORTED: {
    heading: '这一版还没有内容包的宿主能力',
    explanation:
      '内容包的解包、暂存、写盘、诊断都在宿主（launcher_content_* 命令）；当前载体没接这条命令，走不到下一步。',
    nextStep: '可以先继续编辑；等宿主命令补齐后再装。期间请手工复制文件时务必先备份。',
  },
};

export function contentErrorAdvice(code: string | null | undefined): ContentAdvice | null {
  if (code === null || code === undefined) return null;
  return ADVICE_BY_CODE[code] ?? null;
}

/** 面板里会失败的七条腿（标题按动作分，不合并成一句「出错了」） */
export type ContentAction = 'list' | 'plan' | 'apply' | 'uninstall' | 'toggle' | 'order' | 'diagnose';

const ACTION_TITLES: Readonly<Record<ContentAction, string>> = {
  list: '读取已装内容失败',
  plan: '安装预检失败',
  apply: '安装失败',
  uninstall: '卸载失败',
  toggle: '切换启停失败',
  order: '调整加载顺序失败',
  diagnose: '内容诊断失败',
};

export interface ContentFailure {
  readonly title: string;
  /** 契约错误码**原样**回显；没有码就是 null（不伪造 `LAUNCHER_INTERNAL`） */
  readonly code: string | null;
  readonly message: string;
  readonly detail: string | null;
  readonly retryable: boolean;
  /** 四类常见内容错误的「为什么 + 下一步」；其余码为 null（走通用 `hint`） */
  readonly advice: ContentAdvice | null;
  /** 通用下一步（`model.launcherErrorHint` 一张表覆盖全部码） */
  readonly hint: string;
}

function asLauncherErrorShape(
  value: unknown,
): { code: string; message: string; detail: string | null; retryable: boolean } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== 'string' || typeof record.message !== 'string') return null;
  return {
    code: record.code,
    message: record.message,
    detail: typeof record.detail === 'string' ? record.detail : null,
    retryable: record.retryable === true,
  };
}

/**
 * 任意抛出物 → 可渲染失败读数。
 *
 * 三条与 `model.describeFailure` 同源：不改写码、不吞原文、没有 `retryable` 读数就不假装可重试。
 * 差异只在标题按**内容包动作**分档，以及四类码额外带 `advice`（为什么 + 下一步）。
 */
export function describeContentFailure(error: unknown, action: ContentAction): ContentFailure {
  const shaped = asLauncherErrorShape(error);
  if (shaped !== null) {
    return {
      title: ACTION_TITLES[action],
      code: shaped.code,
      message: shaped.message,
      detail: shaped.detail,
      retryable: shaped.retryable,
      advice: contentErrorAdvice(shaped.code),
      hint: launcherErrorHint(shaped.code),
    };
  }
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return {
    title: ACTION_TITLES[action],
    code: null,
    message: raw.trim() === '' ? '没有附带任何错误信息（未分类异常）。' : raw,
    detail: null,
    retryable: false,
    advice: null,
    hint: launcherErrorHint(null),
  };
}
