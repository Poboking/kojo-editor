/**
 * 启动器视图的**纯函数层**（L5 骨架批 + L10 创建/信任/启动流）。
 *
 * 为什么单独一枚文件：视图（`LauncherView.tsx`）只做渲染与订阅，凡是「把读数变成人话」
 * 的判断都住这里——纯函数、零 React、零 IO，单测可以直接点名每一条分支。
 * 本层**不重复造第二份真源**：
 * - 状态机的「是什么」由契约 `@kojo/plugin-api` 的联合类型给出，这里只做**展示词**；
 * - 错误的中文话术由 `launcher-core/errors.ts`（`LauncherError.message`）给出，
 *   本层只补**下一步建议**（hint）与「未分类错误」的兜底包装，不改写码、不改写原文；
 * - L10 的三步向导（`wizard*`）是**纯状态迁移**：输入是对话框回执 / 探测结果 / 用户输入，
 *   输出是下一态；视图不自己拼路径、不猜程序名。
 *
 * 视觉档位（`LauncherTone`）只表达语义，配色在 `launcher.css` 里落 token
 * （`--green` / `--amber` / `--red` / `--fg-dim`），本层不产生任何颜色字面量。
 */

import type {
  CreateInstanceRequest,
  InstanceInspection,
  InstanceState,
  IsolationMode,
  LauncherInstance,
  LauncherTask,
  LaunchCandidate,
  ProcessState,
  ProcessStatus,
  ProcessSupervisor,
  TaskKind,
  TaskState,
  Unsubscribe,
} from '@kojo/plugin-api';
import { byCodePoint } from '../ui/commands';

/* ══════════════════════════════════════════════════════════════════════════════
 * 展示档位
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 状态点的语义档（绿=可用 / 蓝=进行中 / 琥珀=要注意 / 灰=静息），配色住 CSS */
export type LauncherTone = 'ok' | 'busy' | 'warn' | 'idle';

export interface StatusLine {
  /** 中文状态词（与颜色**双编码**：只靠颜色读不出状态） */
  readonly label: string;
  readonly tone: LauncherTone;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 名词 → 中文
 * ══════════════════════════════════════════════════════════════════════════════ */

const ISOLATION_LABELS: Readonly<Record<IsolationMode, string>> = {
  shared: '共享目录',
  copy: '独立副本',
  overlay: '覆盖层',
};

/**
 * 隔离模式的人话。
 * 未知值**不吞**：回显原值，让「宿主给了个新版没登记的模式」在界面上看得见，
 * 而不是悄悄显示成某一个已知档。
 */
export function isolationLabel(mode: string): string {
  return ISOLATION_LABELS[mode as IsolationMode] ?? `未知模式（${mode}）`;
}

const INSTANCE_STATE_LABELS: Readonly<Record<InstanceState, string>> = {
  preparing: '准备中',
  ready: '就绪',
  broken: '已损坏',
  removing: '移除中',
};

/** 实例自身（磁盘/配置）状态的人话；未知值回显原值 */
export function instanceStateLabel(state: string): string {
  return INSTANCE_STATE_LABELS[state as InstanceState] ?? `未知状态（${state}）`;
}

const PROCESS_STATE_LABELS: Readonly<Record<ProcessState, string>> = {
  idle: '未运行',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  exited: '已退出',
  crashed: '异常退出',
};

/** 进程状态的人话；未知值回显原值 */
export function processStateLabel(state: string): string {
  return PROCESS_STATE_LABELS[state as ProcessState] ?? `未知状态（${state}）`;
}

/**
 * 列表/详情共用的**一行状态**：进程态优先（它才是用户此刻最关心的「跑没跑」），
 * 进程静息时再看实例自身的状态（准备中 / 已损坏 / 移除中）。
 *
 * `ready + idle` 读作「未运行」而不是「就绪」：两者都真，但前者回答的是
 * 「现在能不能点启动」这个问题，后者是配置事实，放在详情里说。
 */
export function instanceStatusLine(instanceState: string, processState: string): StatusLine {
  switch (processState) {
    case 'running':
      return { label: '运行中', tone: 'ok' };
    case 'starting':
      return { label: '启动中', tone: 'busy' };
    case 'stopping':
      return { label: '停止中', tone: 'busy' };
    case 'crashed':
      return { label: '异常退出', tone: 'warn' };
    case 'exited':
      return { label: '已退出', tone: 'idle' };
    default:
      break;
  }
  switch (instanceState) {
    case 'ready':
      return { label: '未运行', tone: 'idle' };
    case 'preparing':
      return { label: '准备中', tone: 'busy' };
    case 'broken':
      return { label: '已损坏', tone: 'warn' };
    case 'removing':
      return { label: '移除中', tone: 'busy' };
    default:
      return { label: `未知状态（${instanceState}）`, tone: 'warn' };
  }
}

/**
 * 上次启动的相对时间（`null` = 从未启动）。
 *
 * 超过 30 天回**ISO 日期前 10 位**而不是本地化日期：后者随机器时区/区域设置漂移，
 * 同一份数据在两台机器上显示不同、测试也只能在一台机器上绿（`byCodePoint` 的同族理由）。
 */
export function lastLaunchedText(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (iso === null || iso === undefined || iso === '') return '从未启动';
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return '时间未知';
  const delta = nowMs - stamp;
  if (delta < 60_000) return '刚刚'; // 含轻微时钟偏差（未来时间也算「刚刚」，不编造「-3 分钟前」）
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return iso.slice(0, 10);
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 过滤 / 排序
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 搜索过滤：名字 / 游戏 id / 适配器 id / 隔离模式人话，大小写不敏感子串。
 * 空查询返回**整份副本**（调用方可能排序，不给原数组交出去）。
 */
export function filterInstances(
  instances: readonly LauncherInstance[],
  query: string,
): LauncherInstance[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...instances];
  return instances.filter((instance) => {
    const haystack = `${instance.name}\n${instance.gameId}\n${instance.adapterId}\n${isolationLabel(
      instance.isolation,
    )}`.toLowerCase();
    return haystack.includes(needle);
  });
}

function launchStamp(instance: LauncherInstance): number {
  if (instance.lastLaunchedAt === null) return Number.NEGATIVE_INFINITY;
  const stamp = Date.parse(instance.lastLaunchedAt);
  return Number.isFinite(stamp) ? stamp : Number.NEGATIVE_INFINITY;
}

/**
 * 排序：最近启动的在前，从未启动的垫底；同档按名字码点序（不用 `localeCompare`——
 * 中文排序随宿主 ICU 漂移，作者记住的位置就不可靠）。
 */
export function sortInstances(instances: readonly LauncherInstance[]): LauncherInstance[] {
  return [...instances].sort((a, b) => {
    const ta = launchStamp(a);
    const tb = launchStamp(b);
    if (ta !== tb) return tb > ta ? 1 : -1;
    const byName = byCodePoint(a.name, b.name);
    return byName !== 0 ? byName : byCodePoint(a.id, b.id);
  });
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 启动 / 停止按钮的可用态
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface StartStopControls {
  readonly canStart: boolean;
  readonly canStop: boolean;
  /** 进行中的动作；非空时界面上一律显示它（忙碌态不许「按了没反应」） */
  readonly busyText: string | null;
}

/**
 * 详情页在飞的动作。
 *
 * `trust` 是「信任并启动」的第一步（宿主原生确认框）：它算**忙碌**——
 * 确认框开着的时候再点一次启动会开出第二个框，用户会以为第一次没生效。
 */
export type LauncherPending = 'start' | 'stop' | 'trust' | null;

/**
 * 按钮可用态由**进程态 + 本地在飞动作**两件事决定：
 * - 过渡态（starting / stopping）与本地在飞的命令一律锁死两颗按钮（防双击重复下发）；
 * - running 只给「停止」，其余（idle / exited / crashed）只给「启动」。
 */
export function startStopControls(
  processState: string,
  pending: LauncherPending,
): StartStopControls {
  const transitional = processState === 'starting' || processState === 'stopping';
  const locked = pending !== null || transitional;
  const effectiveBusy =
    pending === 'start'
      ? '正在启动…'
      : pending === 'stop'
        ? '正在停止…'
        : pending === 'trust'
          ? '正在等待系统确认…'
          : processState === 'starting'
            ? '正在启动…'
            : processState === 'stopping'
              ? '正在停止…'
              : null;
  return {
    canStart: !locked && processState !== 'running',
    canStop: !locked && processState === 'running',
    busyText: effectiveBusy,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 错误：码不动、原文不动，只补「下一步做什么」
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 错误码 → **下一步建议**（不是话术翻译）。
 *
 * 话术真源是 `launcher-core` 的 `LauncherError.message`（一张表、一处维护）；
 * 本层只说「你现在该做什么」，因此两件事都不许在这里重抄：默认话术、可重试默认值。
 */
const NEXT_STEP_BY_CODE: Readonly<Record<string, string>> = {
  LAUNCHER_INSTANCE_NOT_FOUND: '这个实例可能已被删除；回到列表点「刷新」重新读取实例库。',
  LAUNCHER_INSTANCE_BUSY: '等当前操作结束（状态点变成「运行中」或「未运行」）再点一次。',
  LAUNCHER_INSTANCE_NOT_READY: '看下方的详情：实例可能还在复制，或已被标记为「已损坏」。',
  LAUNCHER_TRUST_REQUIRED: '按弹出的系统确认框批准这个程序，然后再启动。',
  LAUNCHER_TRUST_CHANGED: '程序在确认之后被改动过；先重新确认，再启动。',
  LAUNCHER_EXECUTABLE_INVALID: '启动目标必须是游戏目录内的可执行文件；到实例设置里换回正确目标。',
  LAUNCHER_RUNTIME_MISSING: '先安装或登记所需的运行时，再启动。',
  LAUNCHER_SOURCE_NOT_APPROVED: '到授权入口逐根批准这个目录，再执行需要写入的操作。',
  LAUNCHER_PATH_ESCAPE: '这是确定性拒绝，重试无效；检查实例目录是否被手动改动。',
  LAUNCHER_PLATFORM_UNSUPPORTED: '这一版还没接入这一步所需的宿主能力；可以先在编辑器里继续工作。',
  LAUNCHER_SCHEMA_UNSUPPORTED: '这个实例由更新版本创建；升级编辑器后再打开。',
};

const DEFAULT_NEXT_STEP = '把错误码连同上面的说明一起反馈给开发者。';

/** 错误码 → 人话建议（未知码/null 给通用一句，不冒充「知道原因」） */
export function launcherErrorHint(code: string | null | undefined): string {
  if (code === null || code === undefined) {
    return '这条错误没有带错误码，无法给出针对性建议；把原文和操作步骤一起反馈给开发者。';
  }
  return NEXT_STEP_BY_CODE[code] ?? DEFAULT_NEXT_STEP;
}

/** 视图里会失败的九条腿（标题按动作分，不合并成一句「出错了」） */
export type LauncherAction =
  | 'service'
  | 'initialize'
  | 'list'
  | 'inspect'
  | 'start'
  | 'stop'
  | 'trust'
  | 'create'
  | 'wizard';

const ACTION_TITLES: Readonly<Record<LauncherAction, string>> = {
  service: '启动器服务不可用',
  initialize: '启动器初始化失败',
  list: '读取实例库失败',
  inspect: '读取实例详情失败',
  start: '启动失败',
  stop: '停止失败',
  trust: '确认目标程序失败',
  create: '创建实例失败',
  wizard: '新建实例向导失败',
};

/** 一份可渲染的失败读数：码原样、话原样，另加标题与建议 */
export interface FailureView {
  readonly title: string;
  /** 契约错误码**原样**回显；没有码就是 null（不伪造 `LAUNCHER_INTERNAL`） */
  readonly code: string | null;
  readonly message: string;
  readonly detail: string | null;
  readonly retryable: boolean;
  readonly hint: string;
}

interface LauncherErrorShape {
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
  readonly retryable: boolean;
}

function asLauncherErrorShape(value: unknown): LauncherErrorShape | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== 'string' || typeof record.message !== 'string') return null;
  const detail = typeof record.detail === 'string' ? record.detail : undefined;
  return {
    code: record.code,
    message: record.message,
    ...(detail === undefined ? {} : { detail }),
    retryable: record.retryable === true,
  };
}

/**
 * 任意抛出物 → 失败读数。
 *
 * 三条刻意：
 * 1. **不改写码**：`launcher-core` 的 `LauncherError` 已经归一并给了中文话术，
 *    这里原样呈现（码 + 原文），只补标题与建议；
 * 2. **不吞原文**：非结构化异常显示 `Error.message` 原文，不用「出错了」盖掉；
 * 3. **不假装可重试**：没有 `retryable` 读数的异常一律按不可重试呈现。
 */
export function describeFailure(error: unknown, action: LauncherAction): FailureView {
  const title = ACTION_TITLES[action];
  const shaped = asLauncherErrorShape(error);
  if (shaped !== null) {
    return {
      title,
      code: shaped.code,
      message: shaped.message,
      detail: shaped.detail ?? null,
      retryable: shaped.retryable,
      hint: launcherErrorHint(shaped.code),
    };
  }
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return {
    title,
    code: null,
    message: raw.trim() === '' ? '没有附带任何错误信息（未分类异常）。' : raw,
    detail: null,
    retryable: false,
    hint: launcherErrorHint(null),
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 服务缺席：说清「缺哪一块」，不许一句「不可用」了事
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 插件表里 `launcher-core` 的读数（取不到记录就是 null） */
export interface LauncherPluginGap {
  readonly status: string | null;
  readonly missing: readonly string[];
  readonly error: string | null;
}

/** L4 插件声明的宿主服务键（`KernelServices.LauncherHost`）；缺席 = 特权面还没接 */
const LAUNCHER_HOST_KEY = 'kernel.launcher';

/**
 * 「拿不到 `launcher.service`」的人话。
 *
 * 分档按**可见事实**而不是猜：插件没进表 / 激活报错 / 缺依赖（尤其宿主桥）/ 未激活。
 * 缺宿主服务时直接把「这一版还没有这条命令」说出来——那是当前版本的真相，
 * 不是「请稍后重试」能糊过去的事。
 */
export function describeServiceGap(gap: LauncherPluginGap | null): string {
  if (gap === null) {
    return '启动器核心插件（launcher-core）不在插件表里：装载可能被跳过，这一版看不到实例库。';
  }
  if (gap.error !== null && gap.error !== '') {
    return `启动器核心插件激活失败：${gap.error}`;
  }
  if (gap.missing.includes(LAUNCHER_HOST_KEY)) {
    return '宿主未就绪：启动器的进程与实例命令（服务键 kernel.launcher）还没接入这一版，实例库只能看不能建。';
  }
  if (gap.missing.length > 0) {
    return `启动器核心插件缺少依赖服务：${gap.missing.join('、')}。`;
  }
  return `启动器核心插件没有激活（状态：${gap.status ?? '未知'}）。`;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 列表行 / 详情三块（只读事实）
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 列表一行的投影（渲染只读这个，不再自己拼文案） */
export interface InstanceRowView {
  readonly id: string;
  readonly name: string;
  readonly gameId: string;
  readonly isolation: string;
  readonly status: StatusLine;
  readonly lastLaunched: string;
  readonly process: string;
}

export function instanceRowView(
  instance: LauncherInstance,
  status: ProcessStatus | undefined,
  nowMs: number = Date.now(),
): InstanceRowView {
  return {
    id: instance.id,
    name: instance.name,
    gameId: instance.gameId,
    isolation: isolationLabel(instance.isolation),
    status: instanceStatusLine(instance.state, status?.state ?? 'idle'),
    lastLaunched: lastLaunchedText(instance.lastLaunchedAt, nowMs),
    process: processStateLabel(status?.state ?? 'idle'),
  };
}

/** 详情里的一行只读事实 */
export interface FactRow {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly tone?: LauncherTone;
}

/** 详情骨架的三块（L5 只读占位；P1 再往上长内容/插件/存档页） */
export interface DetailFacts {
  readonly paths: readonly FactRow[];
  readonly runtime: readonly FactRow[];
  readonly trust: readonly FactRow[];
}

function shortHash(hash: string | null): string {
  if (hash === null || hash === '') return '未记录';
  return `${hash.slice(0, 12)}…`;
}

/**
 * 详情三块：路径 / 运行时 / 信任。
 *
 * `inspection` 缺席（还没读到 / 读取失败）时**退回实例快照并明说「未读取」**——
 * 空白格会被读成「这里就是空的」，那是另一种撒谎。
 */
export function detailFacts(
  instance: LauncherInstance,
  inspection: InstanceInspection | null,
): DetailFacts {
  const paths: FactRow[] = [
    { label: '游戏目录', value: inspection?.paths.gameRoot ?? instance.gameRoot },
    { label: '实例目录', value: inspection?.paths.instanceRoot ?? instance.instanceRoot },
    { label: '启动目标', value: instance.executable.relativePath },
    {
      label: '存档根',
      value:
        inspection === null
          ? '未读取（详情读数缺席）'
          : inspection.paths.saveRoots.length === 0
            ? '未声明存档根'
            : inspection.paths.saveRoots.join('\n'),
    },
  ];

  const required = inspection?.runtime.required ?? null;
  const resolved = inspection?.runtime.resolved ?? null;
  const verified = resolved?.verified ?? null;
  const runtime: FactRow[] = [
    {
      label: '指定运行时',
      value: instance.runtimeId ?? '跟随实例（未指定）',
      hint: required === null ? undefined : `适配器要求：${required.kind}${required.versionRange ? ` ${required.versionRange}` : ''}`,
    },
    {
      label: '解析结果',
      value:
        inspection === null
          ? '未读取（详情读数缺席）'
          : resolved === null
            ? '尚未解析'
            : `${resolved.kind} ${resolved.version}（${resolved.arch}）`,
      tone: inspection !== null && resolved === null ? 'warn' : undefined,
    },
    {
      label: '完整性校验',
      value:
        verified === null
          ? '未校验'
          : verified.ok
            ? '通过'
            : `未通过：缺 ${verified.missing.length} 项、不匹配 ${verified.mismatched.length} 项`,
      tone: verified !== null && !verified.ok ? 'warn' : undefined,
    },
  ];

  const trustRecord = instance.executableTrust;
  const trust: FactRow[] = [
    {
      label: '确认状态',
      value: trustRecord === null ? '尚未确认（首次启动会弹系统确认框）' : '已通过系统对话框确认',
      tone: trustRecord === null ? 'warn' : 'ok',
    },
    { label: '程序哈希', value: shortHash(trustRecord?.sha256 ?? null) },
    { label: '确认时间', value: trustRecord?.approvedAt ?? '未记录' },
    {
      label: '当前程序',
      value:
        inspection === null
          ? '未读取（详情读数缺席）'
          : !inspection.executable.exists
            ? '文件不存在'
            : inspection.executable.changedSinceTrust
              ? '确认后被改动，需重新确认'
              : inspection.executable.trusted
                ? '与确认时一致'
                : '尚未确认',
      tone:
        inspection !== null && (!inspection.executable.exists || inspection.executable.changedSinceTrust)
          ? 'warn'
          : undefined,
    },
  ];

  return { paths, runtime, trust };
}

/**
 * 详情页的一句「现在能不能启动」：把实例态、进程态、信任态三条读数收成一行。
 * 仅用于详情头部，与按钮可用态（`startStopControls`）同源判断，不另立规则。
 */
export function detailHeadline(instance: LauncherInstance, status: ProcessStatus | undefined): string {
  if (status?.state === 'running') return '游戏正在运行，停止后可以继续编辑。';
  if (instance.state === 'preparing') return '实例正在准备（可能需要复制文件），完成前不能启动。';
  if (instance.state === 'broken') return '实例已损坏：先修复目录或重新创建，再启动。';
  if (instance.executableTrust === null) return '首次启动前需要确认目标程序（会弹系统确认框）。';
  return '可以启动。';
}

/* ══════════════════════════════════════════════════════════════════════════════
 * L10 · 新建实例向导（三步状态机，纯函数）
 *
 * 三步：选来源目录 → 选启动程序 → 起名与隔离。
 * 为什么进纯函数：向导的每条迁移（前进 / 后退 / 取消 / 目录对话框取消）都是一条分支，
 * 写在视图里就只能靠点击测；抽出来之后**逐态断言**，视图只负责渲染与调命令。
 *
 * 边界（与铁律 5/6 对齐）：
 * - 目录只能来自原生对话框（`host.pickSourceRoot`）⇒ 本层收的是**回执**，
 *   没有「拼一个路径」的入口；
 * - 候选只能来自 adapter 的 `probe` ⇒ 本层收的是**探测结果**，不猜程序名。
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 向导三步（顺序即界面顺序；`wizardStepIndex` 是唯一序号真源） */
export const WIZARD_STEPS = ['source', 'candidate', 'details'] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];

export const WIZARD_STEP_TITLES: Readonly<Record<WizardStep, string>> = {
  source: '选来源目录',
  candidate: '选启动程序',
  details: '起名与隔离',
};

export interface WizardState {
  readonly step: WizardStep;
  /** 原生目录对话框确认过的来源根；`null` = 还没选（或用户取消了） */
  readonly sourceRoot: string | null;
  /** 选中的候选（复合键 `adapterId::candidateId`；`null` = 还没选） */
  readonly candidateKey: string | null;
  readonly name: string;
  /** 契约里 `shared` / `copy` / `overlay` 三档；向导只开前两档（`overlay` 无宿主落点） */
  readonly isolation: 'shared' | 'copy';
  readonly includeSaves: boolean;
}

export function wizardStepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

/** 初始态：第一步、什么都没选（换目录 / 重来时都从这一份起） */
export function wizardStart(): WizardState {
  return {
    step: 'source',
    sourceRoot: null,
    candidateKey: null,
    name: '',
    isolation: 'shared',
    includeSaves: false,
  };
}

/** 取消 / 关闭向导：整份草稿丢弃（宿主侧此时没有任何写入发生） */
export function wizardCancel(): WizardState {
  return wizardStart();
}

export type PickOutcome =
  | { readonly kind: 'cancelled'; readonly state: WizardState }
  | { readonly kind: 'picked'; readonly state: WizardState };

/**
 * 目录对话框回执 → 下一步。
 *
 * `root === null`（用户取消）**不是错误**：停在原步，什么都不改（实例库 / 授权表都没动）。
 * 返回 `cancelled` 让视图只说一句「已取消」，而不是弹错误条。
 */
export function wizardApplyPickedRoot(state: WizardState, root: string | null): PickOutcome {
  const trimmed = root === null ? '' : root.trim();
  if (trimmed === '') return { kind: 'cancelled', state };
  return {
    kind: 'picked',
    state: { ...state, step: 'candidate', sourceRoot: trimmed, candidateKey: null, name: '' },
  };
}

/** 向导要判断「下一步能不能走」，只需要候选数量这一条外部读数 */
export interface WizardContext {
  readonly candidateCount: number;
}

/** 当前步为什么不能前进（`null` = 可以） */
export function wizardBlockedReason(state: WizardState, context: WizardContext): string | null {
  switch (state.step) {
    case 'source':
      return state.sourceRoot === null ? '还没有选来源目录：先点「选择游戏目录」。' : null;
    case 'candidate':
      if (context.candidateCount === 0) {
        return '这个目录没有可启动的候选：换一个目录，或先确认游戏本体完整。';
      }
      return state.candidateKey === null ? '先选一个要启动的程序。' : null;
    case 'details':
      return state.name.trim() === '' ? '实例需要一个名字（列表里靠它认）。' : null;
    default:
      return null;
  }
}

export type WizardMove =
  | { readonly kind: 'moved'; readonly state: WizardState; readonly reason: null }
  | { readonly kind: 'blocked'; readonly state: WizardState; readonly reason: string };

/** 前进一步（不满足条件就原地不动并给出原因，不静默） */
export function wizardAdvance(state: WizardState, context: WizardContext): WizardMove {
  if (state.step === 'details') {
    return { kind: 'blocked', state, reason: '已经在最后一步：点「创建实例」提交。' };
  }
  const reason = wizardBlockedReason(state, context);
  if (reason !== null) return { kind: 'blocked', state, reason };
  const step = WIZARD_STEPS[wizardStepIndex(state.step) + 1];
  return { kind: 'moved', state: step === undefined ? state : { ...state, step }, reason: null };
}

/**
 * 后退一步。
 *
 * 从候选步退回来源步时**清掉候选**：换了目录，旧候选的 id 不一定还成立
 * （`probe` 的结果是按目录现算的）——留着它就是在界面上藏一个死引用。
 */
export function wizardRetreat(state: WizardState): WizardState {
  const index = wizardStepIndex(state.step);
  if (index <= 0) return state;
  const step = WIZARD_STEPS[index - 1];
  if (step === undefined) return state;
  return step === 'source' ? { ...state, step, candidateKey: null } : { ...state, step };
}

/** 选一个候选；名字还空着时用游戏显示名兜底（用户可以改） */
export function wizardSelectCandidate(
  state: WizardState,
  card: CandidateCard,
): WizardState {
  return {
    ...state,
    candidateKey: card.key,
    name: state.name.trim() === '' ? card.gameName : state.name,
  };
}

/** 候选卡片（`probe` 一条结果在界面上的一行） */
export interface CandidateCard {
  /** 复合键：`adapterId::candidateId`（多适配器时两个 id 可能撞车） */
  readonly key: string;
  readonly adapterId: string;
  readonly gameId: string;
  /** 游戏显示名（adapter 的 `displayName`） */
  readonly gameName: string;
  readonly candidateId: string;
  readonly label: string;
  /** 证据：可执行体相对 `gameRoot` 的路径（契约没有「证据」位，见文件头缺口） */
  readonly relativePath: string;
  readonly arch: string | null;
  readonly notes: string | null;
  /**
   * 推荐位。
   *
   * **契约缺口**：`LaunchCandidate` 没有 `recommended` 字段；adapter 侧（eraTW）用
   * 「顺序 = 推荐顺序」表达（`launch.ts` 文件头缺口 1）。这里只认**第一条**，
   * 并且只在有多个候选时才标——把「唯一候选」也叫「推荐」是噪声。
   */
  readonly recommended: boolean;
}

export function candidateKey(adapterId: string, candidateId: string): string {
  return `${adapterId}::${candidateId}`;
}

export function candidateCards(
  adapterId: string,
  gameId: string,
  gameName: string,
  candidates: readonly LaunchCandidate[],
): CandidateCard[] {
  const ranked = candidates.length > 1;
  return candidates.map((candidate, index) => ({
    key: candidateKey(adapterId, candidate.id),
    adapterId,
    gameId,
    gameName,
    candidateId: candidate.id,
    label: candidate.label,
    relativePath: candidate.executableRelativePath,
    arch: candidate.arch ?? null,
    notes: candidate.notes ?? null,
    recommended: ranked && index === 0,
  }));
}

/** 零候选的人话：标题 + 逐条原因（不猜「可能是 x」，只说看得见的事实） */
export interface EmptyProbeNotice {
  readonly title: string;
  readonly reasons: readonly string[];
}

export function emptyProbeNotice(
  failures: readonly { readonly adapterId: string; readonly message: string }[],
): EmptyProbeNotice {
  const reasons: string[] = [
    '一个候选都没有的目录不能作为实例：启动器不会去猜哪个文件是游戏本体。',
  ];
  for (const failure of failures) {
    reasons.push(`适配器 ${failure.adapterId} 探测时出错：${failure.message}`);
  }
  if (failures.length === 0) {
    reasons.push('适配器在这个目录的根层没有找到它能启动的程序。');
  }
  return { title: '这个目录不能作为实例', reasons };
}

/**
 * 「没有 adapter 启动面」的分档提示（保留）。
 *
 * 与「宿主未就绪」是两件事：宿主命令齐了、但槽位里没有任何带 `launch` 的 adapter
 * ⇒ 本游戏只能编辑、不能启动（契约 §6.1 的缺省语义）。按钮因此照样能点开向导，
 * 但第二步会如实说「没有启动面」而不是空转。
 */
export const NO_LAUNCH_SURFACE_TEXT =
  '这一版没有提供启动面的适配器（game.adapter 槽位里没有 launch）：实例只能编辑，不能启动。';

/* ------------------------------ 隔离模式 ------------------------------ */

export interface IsolationChoice {
  readonly mode: 'shared' | 'copy';
  readonly label: string;
  readonly hint: string;
}

/**
 * 向导只开两档（`overlay` 契约里有形状、宿主没有落点）。
 * `copy` 的体积提示**不给具体数字**：探测结果里没有目录体积读数，
 * 编一个「约 x GB」就是撒谎（缺口已上报：`probe` / `InstanceCreation` 都不带预估体积）。
 */
export const ISOLATION_CHOICES: readonly IsolationChoice[] = [
  {
    mode: 'shared',
    label: '共享目录（默认）',
    hint: '不复制文件：直接使用你选的那个游戏目录，改动立刻生效。',
  },
  {
    mode: 'copy',
    label: '独立副本',
    hint: '把整个游戏目录复制到实例目录：可能数百 MB 到数 GB、耗时长；复制期间实例停在「准备中」，不能启动。',
  },
];

export function isolationChoiceLabel(mode: string): string {
  return ISOLATION_CHOICES.find((choice) => choice.mode === mode)?.label ?? isolationLabel(mode);
}

/** 「包含存档」这一项的说明随隔离模式变（共享模式下了它也不生效） */
export function includeSavesHint(mode: 'shared' | 'copy'): string {
  return mode === 'copy'
    ? '把现有存档一起复制到副本（不勾选 = 副本从全新存档开始）。'
    : '共享模式直接用原目录的存档，这一项不生效。';
}

/* ------------------------------ 提交 ------------------------------ */

export interface WizardSubmission {
  readonly request: CreateInstanceRequest | null;
  readonly problem: string | null;
}

/**
 * 草稿 → `CreateInstanceRequest`。
 *
 * 只放**用户能作主的字段**：`adapterId` / `gameId` / `candidateId` 全部来自探测结果，
 * `sourceRoot` 来自对话框回执。`includeSaves` 只在 copy 档下发（shared 档传了也没意义，
 * 传了反而让「这人选了包含存档」成为一句假话）。
 */
export function wizardCreateRequest(
  state: WizardState,
  card: CandidateCard | null,
): WizardSubmission {
  if (state.sourceRoot === null) {
    return { request: null, problem: '还没有来源目录：回到第一步重新选。' };
  }
  if (card === null || card.key !== state.candidateKey) {
    return { request: null, problem: '还没有选定启动程序：回到上一步选一个候选。' };
  }
  const name = state.name.trim();
  if (name === '') return { request: null, problem: '实例需要一个名字（列表里靠它认）。' };
  return {
    request: {
      name,
      sourceRoot: state.sourceRoot,
      adapterId: card.adapterId,
      gameId: card.gameId,
      candidateId: card.candidateId,
      isolation: state.isolation,
      ...(state.isolation === 'copy' ? { includeSaves: state.includeSaves } : {}),
    },
    problem: null,
  };
}

/** 最后一步的只读摘要（创建前让人看清「将要建什么」） */
export function wizardSummaryRows(state: WizardState, card: CandidateCard | null): readonly FactRow[] {
  return [
    { label: '游戏', value: card?.gameName ?? '未选' },
    {
      label: '程序',
      value: card === null ? '未选' : `${card.relativePath}${card.arch === null ? '' : `（${card.arch}）`}`,
    },
    { label: '来源目录', value: state.sourceRoot ?? '未选' },
    { label: '隔离模式', value: isolationChoiceLabel(state.isolation) },
    {
      label: '存档',
      value:
        state.isolation === 'copy'
          ? state.includeSaves
            ? '随副本复制现有存档'
            : '副本从全新存档开始'
          : '使用原目录存档',
    },
  ];
}

/* ══════════════════════════════════════════════════════════════════════════════
 * L10 · 信任流：什么时候「启动」变成「信任并启动」
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface LaunchPlan {
  /** 按钮文案：未信任 / 确认后又被改动 ⇒「信任并启动」 */
  readonly label: string;
  readonly needsTrust: boolean;
  /** 连点都不该给的原因（实例没就绪 / 程序不在位）；`null` = 可以点 */
  readonly blockedReason: string | null;
}

/**
 * 启动按钮的形态。
 *
 * 信任态以**详情读数**为准（`inspection.executable.trusted` 是宿主现算的），
 * 只在详情还没读到时退回实例快照的 `executableTrust === null`——
 * 两处读数不一致时以「更接近磁盘真相」的那一份（inspection）为准。
 */
export function launchPlan(
  instance: LauncherInstance,
  inspection: InstanceInspection | null,
): LaunchPlan {
  if (instance.state !== 'ready') {
    return {
      label: '启动',
      needsTrust: false,
      blockedReason: `实例当前是「${instanceStateLabel(instance.state)}」，不能启动。`,
    };
  }
  if (inspection !== null && !inspection.executable.exists) {
    return {
      label: '启动',
      needsTrust: false,
      blockedReason: '目标程序不在位（可能被改名、移动或删除）：先修复目录，再启动。',
    };
  }
  const needsTrust =
    inspection === null
      ? instance.executableTrust === null
      : !inspection.executable.trusted || inspection.executable.changedSinceTrust;
  return { label: needsTrust ? '信任并启动' : '启动', needsTrust, blockedReason: null };
}

/**
 * 原生确认框被取消 / 信任命令失败时的一行说明。
 *
 * **契约缺口**：取消语义没有专用错误码（宿主在对话框取消时回什么没写死）。
 * 所以这里两条都认：码里带 `CANCEL` 视为取消，其余把原文带出来。
 * 两种情况共同的下一步一样——**不启动、不自动重试**（重试只会再弹一次框）。
 */
export interface TrustInterruption {
  readonly cancelled: boolean;
  readonly note: string;
}

export function describeTrustInterruption(error: unknown): TrustInterruption {
  const shaped = asLauncherErrorShape(error);
  const raw = shaped !== null ? shaped.message : error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const cancelled = (shaped !== null && /CANCEL/i.test(shaped.code)) || /取消/.test(raw);
  const detail = raw.trim() === '' ? '' : `（${raw.trim()}）`;
  return {
    cancelled,
    note: cancelled
      ? '已取消系统确认框：目标程序仍未确认，这次没有启动游戏，也不会自动重试。'
      : `信任没有完成${detail}：目标程序仍未确认，这次没有启动游戏。确认后可以再点一次。`,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * L10 · 后台任务进度（创建 copy 实例 = 一个复制任务）
 * ══════════════════════════════════════════════════════════════════════════════ */

const TASK_KIND_LABELS: Readonly<Record<string, string>> = {
  'instance-copy': '复制实例目录',
  'instance-duplicate': '复制实例',
  'content-install': '安装内容包',
  'save-restore': '恢复存档',
};

export function taskKindLabel(kind: TaskKind | string): string {
  return TASK_KIND_LABELS[kind] ?? `后台任务（${kind}）`;
}

/** 字节数 → 人话（1 位小数；单位到 GB 为止，再大也读作 GB） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export interface TaskProgressView {
  /** 一句话（「正在复制实例目录…」/「复制实例目录完成」） */
  readonly headline: string;
  /** 进度读数（没有进度时明说「没有进度读数」，不留空白） */
  readonly detail: string;
  readonly percent: number | null;
  readonly tone: LauncherTone;
  readonly terminal: boolean;
  readonly cancellable: boolean;
  /** 失败时的原文（不改写；成功 / 进行中为 null） */
  readonly errorText: string | null;
}

const TASK_STATE_TONE: Readonly<Record<TaskState, LauncherTone>> = {
  queued: 'busy',
  running: 'busy',
  succeeded: 'ok',
  failed: 'warn',
  cancelled: 'idle',
};

const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'succeeded',
  'failed',
  'cancelled',
]);

/**
 * 任务读数 → 可渲染进度。
 *
 * 「复制任务非空 ⇒ 实例还没就绪」这条判断**不由本函数负责**（它只看任务），
 * 视图据 `creation.task !== null` 决定显示进度而非就绪详情——两者一起才构成
 * 「不要假装立刻 ready」。
 */
export function taskProgressView(task: LauncherTask): TaskProgressView {
  const kind = taskKindLabel(task.kind);
  const headline =
    task.state === 'queued'
      ? `排队等待：${kind}`
      : task.state === 'running'
        ? `正在${kind}…`
        : task.state === 'succeeded'
          ? `${kind}完成`
          : task.state === 'failed'
            ? `${kind}失败`
            : `${kind}已取消`;
  const progress = task.progress;
  const detail =
    progress === null
      ? '这个任务没有进度读数。'
      : `${
          progress.unit === 'bytes'
            ? `${formatBytes(progress.done)} / ${formatBytes(progress.total)}`
            : progress.unit === 'files'
              ? `${progress.done} / ${progress.total} 个文件`
              : `${progress.done} / ${progress.total} 步`
        }${progress.message.trim() === '' ? '' : ` · ${progress.message}`}`;
  const percent =
    progress === null || progress.total <= 0
      ? null
      : Math.max(0, Math.min(100, Math.round((progress.done / progress.total) * 100)));
  return {
    headline,
    detail,
    percent,
    tone: TASK_STATE_TONE[task.state],
    terminal: TERMINAL_TASK_STATES.has(task.state),
    cancellable: task.cancellable && !TERMINAL_TASK_STATES.has(task.state),
    errorText: task.error === null ? null : task.error.message,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * L10 · 启动后的进程读数：订阅优先，轮询兜底
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 兜底轮询间隔（宿主/服务没有推送能力时；3 s——比宿主事件粗，但够看清「跑起来了没」） */
export const PROCESS_POLL_INTERVAL_MS = 3_000;

export interface ProcessWatchTimer {
  readonly setInterval: typeof setInterval;
  readonly clearInterval: typeof clearInterval;
}

const DEFAULT_PROCESS_TIMER: ProcessWatchTimer = { setInterval, clearInterval };

/**
 * 盯住一个实例的进程读数。**优先订阅**（`processes.subscribe`：事件带 `seq`，
 * 是宿主推来的真相）；服务没有订阅能力时**退化为 3 s 轮询** `processes.status`。
 *
 * 为什么还要这一层：视图已经有一份全局订阅（列表用），但「启动后到底跑没跑」是
 * 详情页最要紧的一条读数——服务没实现订阅时，只靠全局订阅会永远停在 `starting`。
 * 两份监听不会打架：都是同一形状的快照，后到的覆盖先到的。
 */
export function watchProcessStatus(
  processes: Pick<ProcessSupervisor, 'status' | 'subscribe'>,
  instanceId: string,
  onStatus: (status: ProcessStatus) => void,
  timer: ProcessWatchTimer = DEFAULT_PROCESS_TIMER,
): Unsubscribe {
  const subscribe = (processes as { subscribe?: unknown }).subscribe;
  if (typeof subscribe === 'function') {
    return processes.subscribe(onStatus);
  }
  // 退化路径：契约里 `subscribe` 是必填，但宿主桥可能只实现了读——轮询是唯一能动的形态
  const handle = timer.setInterval(() => {
    onStatus(processes.status(instanceId));
  }, PROCESS_POLL_INTERVAL_MS);
  return () => {
    timer.clearInterval(handle);
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * L10 · 四类启动错误的「人话 + 下一步」
 *
 * 与 `launcherErrorHint` 的分工：那张表按**码**给一句下一步（覆盖全部码）；
 * 这张表只覆盖启动链上最常撞的四类，给出**为什么**（解释）+ 具体动作，
 * 渲染成错误条里的一段。码与原文照旧原样显示，这里一个字都不改写。
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface LaunchErrorAdvice {
  readonly heading: string;
  readonly explanation: string;
  readonly nextStep: string;
}

const LAUNCH_ADVICE_BY_CODE: Readonly<Record<string, LaunchErrorAdvice>> = {
  LAUNCHER_TRUST_CHANGED: {
    heading: '目标程序在确认之后被改动过',
    explanation:
      '系统只信任你确认过的那一份程序：文件一变，旧的确认就作废（这是防替换的第一道闸）。',
    nextStep: '点「信任并启动」重新走一次系统确认框；确认通过后才会启动。',
  },
  LAUNCHER_EXECUTABLE_INVALID: {
    heading: '启动目标不合法',
    explanation:
      '启动目标必须是游戏目录内的可执行文件（相对路径、不含 ..、以 .exe 结尾）；启动器不接受任意路径。',
    nextStep: '如果目录里的程序被改名或移动过：回到「新建实例」重新选一个候选。',
  },
  LAUNCHER_ALREADY_RUNNING: {
    heading: '这个实例已经在运行',
    explanation: '同一实例同一时刻只允许一个进程；重复启动会被拒绝，避免两个游戏同时写同一份存档。',
    nextStep: '要重开就先点「停止」，等状态变成「未运行」再启动。',
  },
  LAUNCHER_INSTANCE_BUSY: {
    heading: '这个实例正忙（启动 / 停止 / 复制还没结束）',
    explanation: '同一实例的操作是串行的：上一个动作没落定之前，新的命令会被拒绝。',
    nextStep: '等状态点变成「运行中」或「未运行」再操作；复制期间请等任务进度走完。',
  },
  LAUNCHER_PLATFORM_UNSUPPORTED: {
    heading: '这一版还没有这条宿主能力',
    explanation: '需要的能力（例如实例复制、逐根写授权）还没接入当前桌面壳，走不到下一步。',
    nextStep: '可以先继续编辑；要创建实例请用「共享目录」档，或等宿主命令补齐后再试。',
  },
};

export function launchErrorAdvice(code: string | null | undefined): LaunchErrorAdvice | null {
  if (code === null || code === undefined) return null;
  return LAUNCH_ADVICE_BY_CODE[code] ?? null;
}

/** 任意抛出物 → 一句原文（结构化错误取 `message`，其余取 `Error.message` / 字面量） */
export function thrownMessage(error: unknown): string {
  const shaped = asLauncherErrorShape(error);
  if (shaped !== null) return shaped.message;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '没有附带任何错误信息（未分类异常）。';
}
