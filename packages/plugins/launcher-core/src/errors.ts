/**
 * 宿主错误 DTO → `LauncherError` 的**纯函数**归一。
 *
 * 三条纪律（对应契约 §5.6 的注释）：
 * 1. **码不改写**：宿主给的是合集里的码就原样带出——上层按码分支，改写会让「同一个
 *    故障在不同路径上长得不一样」。只有集合外的码才降级成 `LAUNCHER_INTERNAL`，并把
 *    原码留在 `detail` 里（不静默丢信息）。
 * 2. **中文话术表归本层**：契约层连一个 `const` 都不许有（本体 `launcher.ts` 是开机图
 *    成员），中文默认话术因此住这里，一张表、一处维护。
 * 3. **禁止透传 OS 英文串**：宿主给的 message 若是纯 ASCII/英文（典型如
 *    `Access is denied. (os error 5)`），改用本码的中文默认话术，原文压进 `detail`
 *    供排障——用户看到的人话永远是中文。
 *
 * `retryable` 的判定顺序：宿主显式给了布尔值就用它（真源在宿主，它知道步骤），
 * 没给才落回本层的码级默认。
 */

import type { LauncherError, LauncherErrorCode } from '@kojo/plugin-api';

/** 每枚错误码的中文默认话术（**唯一**运行期表；契约层刻意不含） */
export const LAUNCHER_ERROR_MESSAGES: Record<LauncherErrorCode, string> = {
  LAUNCHER_INSTANCE_NOT_FOUND: '实例不存在，可能已被删除',
  LAUNCHER_INSTANCE_BUSY: '该实例正在启动或停止，请等当前操作结束',
  LAUNCHER_INSTANCE_NOT_READY: '实例尚未就绪，暂时不能启动',
  LAUNCHER_TRUST_REQUIRED: '首次启动前需要确认目标程序（会弹出系统确认框）',
  LAUNCHER_TRUST_CHANGED: '目标程序在确认之后被修改，需重新确认才能启动',
  LAUNCHER_EXECUTABLE_INVALID: '目标程序不合法：必须是游戏目录内的可执行文件',
  LAUNCHER_RUNTIME_MISSING: '缺少启动所需的运行时',
  LAUNCHER_SOURCE_NOT_APPROVED: '该目录尚未被批准写入，需通过目录对话框逐根授权',
  LAUNCHER_PATH_ESCAPE: '路径越出了允许的目录范围，已拒绝',
  LAUNCHER_ARCHIVE_INVALID: '压缩包不合法或已损坏',
  LAUNCHER_ARCHIVE_LIMIT: '压缩包超出条目数或体积限额，已中止',
  LAUNCHER_CONTENT_CONFLICT: '内容包与已安装文件冲突，需逐条决定如何处理',
  LAUNCHER_CONTENT_BROKEN: '已安装内容缺失或被篡改',
  LAUNCHER_PLUGIN_CONFLICT: '插件与既有文件或函数冲突，需逐条决定如何处理',
  LAUNCHER_PLUGIN_INCOMPATIBLE: '插件与当前游戏版本或插件接口版本不兼容',
  LAUNCHER_PLUGIN_DEPENDENCY: '插件的依赖或冲突声明未满足',
  LAUNCHER_PLUGIN_SAVE_RISK: '插件可能影响存档，需先确认并完成备份',
  LAUNCHER_PLUGIN_UNTRUSTED: '插件发布者不在信任链中',
  LAUNCHER_PLUGIN_PROJECT_INVALID: '插件源清单或项目结构不合法',
  LAUNCHER_PLUGIN_PROJECT_EXISTS: '同一工作区里已有相同插件 id 的项目',
  LAUNCHER_PLUGIN_BUILD_FAILED: '插件构建失败',
  LAUNCHER_PLUGIN_EXTRACT_FAILED: '从已安装插件提取源码项目失败',
  LAUNCHER_SAVE_RESTORE_FAILED: '存档恢复失败',
  LAUNCHER_DOWNLOAD_REJECTED: '下载被拒绝：来源不可信或校验不通过',
  LAUNCHER_TASK_CANCELLED: '任务已取消',
  LAUNCHER_TASK_BUSY: '任务正在执行，当前不可取消',
  LAUNCHER_SCHEMA_UNSUPPORTED: '实例清单版本高于本版本支持的范围',
  LAUNCHER_PLATFORM_UNSUPPORTED: '当前平台未提供该能力',
  LAUNCHER_INTERNAL: '启动器内部错误',
};

/**
 * 码级默认可重试（宿主没给 `retryable` 时使用）。
 *
 * 判据：**用户或环境做一点事之后重试同一操作就可能成功**的码。程序被篡改
 * （`TRUST_CHANGED`）、授权缺失（`SOURCE_NOT_APPROVED`）、运行时缺失、实例忙
 * 都属于这一类；路径逃逸、归档不合法这类是确定性拒绝，重试没有意义。
 */
const RETRYABLE_BY_DEFAULT: ReadonlySet<LauncherErrorCode> = new Set<LauncherErrorCode>([
  'LAUNCHER_INSTANCE_BUSY',
  'LAUNCHER_TRUST_REQUIRED',
  'LAUNCHER_TRUST_CHANGED',
  'LAUNCHER_RUNTIME_MISSING',
  'LAUNCHER_SOURCE_NOT_APPROVED',
  'LAUNCHER_PLUGIN_SAVE_RISK',
  'LAUNCHER_TASK_BUSY',
  'LAUNCHER_INTERNAL',
]);

/** 码全集（运行期集合；判据 = 话术表的键，不另抄一份名单） */
const ALL_CODES: ReadonlySet<string> = new Set(Object.keys(LAUNCHER_ERROR_MESSAGES));

/** `unknown` → 是不是合集里的码（`isLauncherErrorCode` 的名称即语义） */
export function isLauncherErrorCode(value: unknown): value is LauncherErrorCode {
  return typeof value === 'string' && ALL_CODES.has(value);
}

/** 是否已经是结构化错误（幂等归一用） */
export function isLauncherError(value: unknown): value is LauncherError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return isLauncherErrorCode(v.code) && typeof v.message === 'string' && typeof v.retryable === 'boolean';
}

export interface LauncherErrorOptions {
  /** 面向排障的细节（与宿主 detail 并列，不覆盖） */
  readonly detail?: string;
  /** 覆盖码级默认可重试（宿主判定优先时用） */
  readonly retryable?: boolean;
  /** 覆盖中文默认话术（仅用于本层自造的错误，文案更具体时） */
  readonly message?: string;
}

/** 本层自造错误的唯一入口（码必须在合集内，`detail` 说明是哪一步） */
export function launcherError(code: LauncherErrorCode, options: LauncherErrorOptions = {}): LauncherError {
  const detail = normalizeDetail(options.detail);
  return {
    code,
    message: options.message ?? LAUNCHER_ERROR_MESSAGES[code],
    ...(detail === undefined ? {} : { detail }),
    retryable: options.retryable ?? RETRYABLE_BY_DEFAULT.has(code),
  };
}

export interface NormalizeErrorOptions {
  /** 主体没有可用码时的兜底码（缺省 `LAUNCHER_INTERNAL`） */
  readonly fallbackCode?: LauncherErrorCode;
  /** 本层补充的上下文（如「第几步」），与宿主 detail 并列 */
  readonly detail?: string;
}

/**
 * 把任意抛出物（宿主 DTO / `Error` / 字符串 / 已有的 `LauncherError`）归一成
 * `LauncherError`。纯函数：不读环境、不打日志、不抛。
 *
 * **幂等**：对已经是 `LauncherError` 的输入逐字段还原成等值对象。刻意**不做**
 * 「形状像就直接原样返回」的短路——宿主 DTO 的形状与本结构逐字相同（§5.6），
 * 短路会把宿主漏过来的英文 OS 串原样放行，那条纪律就形同虚设。
 */
export function normalizeLauncherError(err: unknown, options: NormalizeErrorOptions = {}): LauncherError {
  const fallbackCode = options.fallbackCode ?? 'LAUNCHER_INTERNAL';
  const dto = asRecord(err);
  const rawCode = dto?.code;
  const code: LauncherErrorCode = isLauncherErrorCode(rawCode) ? rawCode : fallbackCode;

  const parts: string[] = [];
  const hostDetail = normalizeDetail(dto?.detail);
  if (hostDetail !== undefined) parts.push(hostDetail);

  const hostMessage = typeof dto?.message === 'string' ? dto.message.trim() : '';
  // 纯英文/ASCII 的话术不透传（契约 §5.6：禁止把 OS 英文串直接给用户）
  if (hostMessage !== '' && !containsCjk(hostMessage)) {
    parts.push(`宿主原文：${hostMessage}`);
  }

  // 合集外的码：降级为兜底码，但原码必须留在 detail（排障时不丢）
  if (rawCode !== undefined && !isLauncherErrorCode(rawCode)) {
    parts.push(`宿主错误码：${String(rawCode)}`);
  }

  if (rawCode === undefined && hostMessage === '' && err !== undefined && err !== null && dto === null) {
    // 不是对象也不是结构化 DTO：字符串 / 数字这类，原样留证
    const text = String(err).trim();
    if (text !== '') parts.push(text);
  }

  const extra = normalizeDetail(options.detail);
  if (extra !== undefined) parts.push(extra);

  const message =
    hostMessage !== '' && containsCjk(hostMessage) ? hostMessage : LAUNCHER_ERROR_MESSAGES[code];
  const retryable =
    typeof dto?.retryable === 'boolean' ? dto.retryable : RETRYABLE_BY_DEFAULT.has(code);

  const detail = dedupeDetail(parts);
  return { code, message, ...(detail === undefined ? {} : { detail }), retryable };
}

/** 「该能力本批未装配」的统一错误（桩服务与可选宿主方法共用） */
export function notAssembled(label: string): LauncherError {
  return launcherError('LAUNCHER_PLATFORM_UNSUPPORTED', {
    detail: `${label}未在本批装配（P0 只到实例 / 进程 / 日志 / 任务）`,
  });
}

/* ------------------------------ 内部工具 ------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** 是否含 CJK 字符（中文话术的判据；纯 ASCII 视为「宿主原文」） */
function containsCjk(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (
      (cp >= 0x3040 && cp <= 0x30ff) || // 假名
      (cp >= 0x3400 && cp <= 0x9fff) || // 汉字（含扩展 A）
      (cp >= 0xf900 && cp <= 0xfaff) || // 兼容汉字
      (cp >= 0xff01 && cp <= 0xff60) // 全角标点
    ) {
      return true;
    }
  }
  return false;
}

function normalizeDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

/** 细节拼装：去掉完全重复的段（幂等归一不制造 `x · x`） */
function dedupeDetail(parts: readonly string[]): string | undefined {
  const out: string[] = [];
  for (const part of parts) {
    const text = part.trim();
    if (text === '' || out.includes(text)) continue;
    out.push(text);
  }
  return out.length === 0 ? undefined : out.join(' · ');
}
