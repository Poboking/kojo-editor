/**
 * 启动器视图的**纯函数层**（L5 骨架批）。
 *
 * 为什么单独一枚文件：视图（`LauncherView.tsx`）只做渲染与订阅，凡是「把读数变成人话」
 * 的判断都住这里——纯函数、零 React、零 IO，单测可以直接点名每一条分支。
 * 本层**不重复造第二份真源**：
 * - 状态机的「是什么」由契约 `@kojo/plugin-api` 的联合类型给出，这里只做**展示词**；
 * - 错误的中文话术由 `launcher-core/errors.ts`（`LauncherError.message`）给出，
 *   本层只补**下一步建议**（hint）与「未分类错误」的兜底包装，不改写码、不改写原文。
 *
 * 视觉档位（`LauncherTone`）只表达语义，配色在 `launcher.css` 里落 token
 * （`--green` / `--amber` / `--red` / `--fg-dim`），本层不产生任何颜色字面量。
 */

import type {
  InstanceInspection,
  InstanceState,
  IsolationMode,
  LauncherInstance,
  ProcessState,
  ProcessStatus,
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
 * 按钮可用态由**进程态 + 本地在飞动作**两件事决定：
 * - 过渡态（starting / stopping）与本地在飞的命令一律锁死两颗按钮（防双击重复下发）；
 * - running 只给「停止」，其余（idle / exited / crashed）只给「启动」。
 */
export function startStopControls(
  processState: string,
  pending: 'start' | 'stop' | null,
): StartStopControls {
  const transitional = processState === 'starting' || processState === 'stopping';
  const locked = pending !== null || transitional;
  const effectiveBusy =
    pending === 'start'
      ? '正在启动…'
      : pending === 'stop'
        ? '正在停止…'
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

/** 视图里会失败的六条腿（标题按动作分，不合并成一句「出错了」） */
export type LauncherAction = 'service' | 'initialize' | 'list' | 'inspect' | 'start' | 'stop';

const ACTION_TITLES: Readonly<Record<LauncherAction, string>> = {
  service: '启动器服务不可用',
  initialize: '启动器初始化失败',
  list: '读取实例库失败',
  inspect: '读取实例详情失败',
  start: '启动失败',
  stop: '停止失败',
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
