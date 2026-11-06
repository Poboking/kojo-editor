/**
 * MCP 真源腿 · 启动器族（B4 批：`launcher_*` 具名工具登记，2026-11-06）。
 *
 * 真源 = `kernel.launcherHost`（`@kojo/plugin-api` 的 `LauncherHostBridge` 透传面，
 * 实现见 `packages/kernel/src/launcher.ts` → `packages/app/src/bridge/launcher-bridge.ts`
 * → Rust `launcher/commands.rs`）。**一个方法 = 一条 Rust 命令**，本层不拼路径、不做持久化、
 * 不解释限额（那是桥与宿主的分层纪律），所以这里的每一腿也只是「取参 → 调一个方法 → 投影回包」。
 *
 * 三条铁律在这一族的落法（改之前先读）：
 *
 * 1. **档位与授权面零放宽**：工具名一律保持 `launcher_<族>_<动词>` 下划线形态——
 *    Rust `mcp::protocol::is_launcher_tool()` 与 WebView `approval-ui.tsx` 的
 *    `PRIVILEGED_TOOL_PREFIXES` 都按 `launcher_` **前缀**判 privileged；换成点号形态
 *    （`launcher.instance.list`）就不命中前缀判定，会掉进「未知名字按 read 放行」的后门。
 *    第四张表对 privileged 只认**精确名**（通配 `launcher_*` 不构成批准），这一条判据本批零改动。
 * 2. **第三张表复验一律留在宿主**：实例 × `rootId` 的逐根写授权只由原生目录对话框写
 *    `launcher/approvals.json`（`launcher/paths.rs::APPROVALS_FILE`），复验点在
 *    `content.rs` / `saves.rs`。本批**没有任何一腿**替模型拿落点决定权：
 *    不收写目标路径、不调 `launcher_pick_*`、不把游戏根写进内核 `writablePaths`；
 *    需要「人选中一个输入件」的那几条（`launcher_content_plan` / `launcher_save_import` /
 *    `launcher_project_extract`）**刻意不登记**，逐条判性写进
 *    `@kojo/mcp-host` 的 `MCP_DEFERRED_GAP_NOTES`（铁律 4：缺席必须可见，不静默）。
 * 3. **返回值原样透传 + 形状照宿主真形**：宿主 DTO 全部是 camelCase，本层不抄第二份改名表；
 *    与契约不一致的五处差异（`launcher_save_list` 的 `{entries,roots,warnings}`、
 *    `launcher_content_diagnose` 多报的 `orphan-file`/`load-order` 等）一律照**宿主真形**投影，
 *    并在 `tools/list` 的 description 里写清楚。
 *
 * 不静默（铁律 4）的三条口径：
 * - 启动器面缺席（浏览器宿 / 内核未到场 / 老宿主没有这条 P1 命令）⇒ 显式 `NOT_WIRED` 带理由，
 *   **绝不返回空数组冒充「没有实例」**；
 * - 宿主结构化错误（`LauncherBridgeError` 形态：`code` + `message` + `detail` + `retryable`）
 *   ⇒ 原样进 `TOOL_EXECUTION_FAILED` 的 message（码、可重试位、详情都在，模型据此分流）；
 * - 可能超界的读数一律复用 **B1 分页面**（`paginateByCursor` / `paginateText`：`limit` + `cursor`
 *   + `{total, offset, limit, truncated, hasMore, nextCursor, fingerprint}`，快照变化
 *   `changedDuringPaging` 出声），单页上限一律**压在本批之前的闸之下**（日志页更是主动收紧：
 *   宿主默认 1 MiB/流，本面压到 40 KiB/流，见 `MAX_LOG_PAGE_BYTES`），一个没放宽。
 *
 * 与 `kojo://tasks` 的关系（`real-sources-tasks.ts:31-34` 已判性）：启动器任务表
 * （`launcher_task_list` / `launcher_task_cancel`）**另有主人**——第三张表 + 宿主任务中心，
 * 刻意不并入 `kojo://tasks`。本批登记这两枚时保持独立面：生命周期动作的回包给**任务行 id +
 * 可查（`launcher_task_list`）可撤（`launcher_task_cancel`）口径**，不冒充统一任务表。
 */
import { McpFailure, paginateByCursor } from '@kojo/mcp-host';
import type { McpIoDeps } from './real-sources-io';

/* ------------------------------- 真源形状（最窄投影） ------------------------------- */

/**
 * `LauncherHostBridge` 的**最窄结构投影**（B4 批只用这些方法）。
 *
 * 为什么不 `import type { LauncherHostBridge }`：那是把整份契约类型（含事件订阅、对话框、
 * 导出等本批刻意不接的面）拖进 MCP 腿模块；本面要的只是「这几条命令有没有真源」，
 * 返回值统一按 `unknown` 收，投影在腿里逐字段做（宿主回包本就该当不可信输入处理）。
 * 可选方法 = 契约里标 P1 的命令；**缺席 ⇒ 显式 `NOT_WIRED`**（不降级、不造假数据）。
 */
export interface McpLauncherHostLike {
  readonly instanceList: () => Promise<unknown>;
  readonly instanceInspect: (instanceId: string) => Promise<unknown>;
  readonly instanceUpdate: (instanceId: string, patch: Record<string, unknown>) => Promise<unknown>;
  readonly instanceRemove: (
    instanceId: string,
    opts: { readonly deleteFiles: boolean; readonly keepBackups?: boolean | null },
  ) => Promise<unknown>;
  readonly instanceDuplicate: (instanceId: string, name?: string | null) => Promise<unknown>;
  readonly start: (instanceId: string) => Promise<unknown>;
  readonly stop: (
    instanceId: string,
    opts?: { readonly force?: boolean; readonly timeoutMs?: number } | null,
  ) => Promise<unknown>;
  readonly processStatus: (instanceId: string) => Promise<unknown>;
  readonly processList: () => Promise<unknown>;
  readonly logTail: (instanceId: string, query?: Record<string, unknown> | null) => Promise<unknown>;
  readonly logSessions: (instanceId: string) => Promise<unknown>;
  readonly logRead: (sessionId: string, query?: Record<string, unknown> | null) => Promise<unknown>;
  readonly taskList: () => Promise<unknown>;
  readonly taskCancel: (taskId: string) => Promise<unknown>;
  // ---- P1（宿主可能没有 ⇒ 逐条可选）----
  readonly contentList?: (instanceId: string) => Promise<unknown>;
  readonly contentApply?: (
    planId: string,
    resolutions?: readonly Record<string, unknown>[] | null,
  ) => Promise<unknown>;
  readonly contentUninstall?: (
    instanceId: string,
    packId: string,
    files?: readonly { rootId: string; path: string }[],
  ) => Promise<unknown>;
  readonly contentSetEnabled?: (instanceId: string, packId: string, enabled: boolean) => Promise<unknown>;
  readonly contentSetOrder?: (instanceId: string, packIds: readonly string[]) => Promise<unknown>;
  readonly contentDiagnose?: (instanceId: string) => Promise<unknown>;
  readonly saveList?: (instanceId: string) => Promise<unknown>;
  readonly saveBackups?: (instanceId: string) => Promise<unknown>;
  readonly saveBackup?: (instanceId: string, req: Record<string, unknown>) => Promise<unknown>;
  readonly saveRestore?: (
    instanceId: string,
    backupId: string,
    opts?: Record<string, unknown> | null,
  ) => Promise<unknown>;
  readonly saveDeleteBackup?: (instanceId: string, backupId: string) => Promise<unknown>;
  readonly saveApplyImport?: (
    planId: string,
    resolutions?: readonly Record<string, unknown>[] | null,
  ) => Promise<unknown>;
  readonly projectHash?: (input: {
    projectDir: string;
    artifactDir: string;
    entries: readonly string[];
  }) => Promise<unknown>;
}

/** 腿表条目：`(args, scope) => 回包`（与 `ioTools` 同形，盘点脚本按这张表判 wired）。 */
export type McpLauncherLeg = (args: Record<string, unknown>, scope: unknown) => Promise<unknown>;

/**
 * 本批登记的 27 枚具名工具（只读 13 + 生命周期/写 14）。
 * 这张名单就是腿表的键类型：`noUncheckedIndexedAccess` 下按键取腿不会是 `undefined`，
 * 而名单外的名字（C 组）在类型层就进不了腿表 ⇒「刻意不登记」有类型闸兜着。
 */
export type McpLauncherLegName =
  | 'launcher_instance_list'
  | 'launcher_instance_get'
  | 'launcher_instance_update'
  | 'launcher_instance_remove'
  | 'launcher_instance_duplicate'
  | 'launcher_content_list'
  | 'launcher_content_diagnose'
  | 'launcher_content_apply'
  | 'launcher_content_uninstall'
  | 'launcher_content_set_enabled'
  | 'launcher_content_set_order'
  | 'launcher_process_list'
  | 'launcher_process_status'
  | 'launcher_task_list'
  | 'launcher_task_cancel'
  | 'launcher_save_list'
  | 'launcher_save_backups'
  | 'launcher_save_backup'
  | 'launcher_save_restore'
  | 'launcher_save_delete_backup'
  | 'launcher_save_apply_import'
  | 'launcher_log_sessions'
  | 'launcher_log_tail'
  | 'launcher_log_read'
  | 'launcher_project_hash'
  | 'launcher_start'
  | 'launcher_stop';

export interface McpLauncherDeps {
  readonly getLauncher?: () => McpLauncherHostLike | null;
  readonly getKernel: McpIoDeps['getKernel'];
}

/* ------------------------------- 闸值（一个都不放宽） ------------------------------- */

/** 列举面单页默认 / 上限（与既有 IO 面同档：默认 50、上限 200，绝不越过 `RESOURCE_ITEM_LIMIT`）。 */
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;
/** 存档条目面：宿主本来就按 saveRoot 逐根列，页大小同档。 */
const SAVE_ENTRY_DEFAULT_LIMIT = 100;
const SAVE_ENTRY_MAX_LIMIT = 200;
/**
 * 日志页的字节闸：宿主 `DEFAULT_MAX_BYTES` 是 **1 MiB/流**（base64 后约 1.4 MiB 字符），
 * 直接回给模型会撞宿主不可信串闸（64 KiB/串）并被再切一刀，账就假了。
 * 本面**主动收紧**到 40 KiB/流（base64 ≈ 54.6 K 字符 < 65 536 闸），并在 description 里写明。
 */
export const MAX_LOG_PAGE_BYTES = 40 * 1024;
const LOG_CHUNK_DEFAULT_LIMIT = 2;
const LOG_CHUNK_MAX_LIMIT = 4;

const INSTANCE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const COMPONENT_ID_RE = /^(?!\.)[A-Za-z0-9._-]{1,64}$/;

/* ------------------------------- 小工具 ------------------------------- */

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asFinite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 必填 id 参数：形状与宿主同尺（非法 ⇒ INVALID_ARGS，绝不夹带给宿主去猜）。 */
function requireId(args: Record<string, unknown>, key: string, re: RegExp, label: string): string {
  const raw = args[key];
  if (typeof raw !== 'string' || raw === '') {
    throw new McpFailure('INVALID_ARGS', `${label} 缺少必填参数 ${key}（非空字符串）`);
  }
  if (!re.test(raw)) {
    throw new McpFailure(
      'INVALID_ARGS',
      `${label} 的 ${key} 形状非法：${raw.slice(0, 80)}（期望与宿主同尺的 ${re.source}）`,
    );
  }
  return raw;
}

/** 可选字符串参数（长度闸与宿主同档，绝不无界）。 */
function optionalString(args: Record<string, unknown>, key: string, max: number): string | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new McpFailure('INVALID_ARGS', `参数 ${key} 须是字符串`);
  }
  if (raw.length > max) {
    throw new McpFailure('INVALID_ARGS', `参数 ${key} 过长（${raw.length} > ${max}）`);
  }
  return raw;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'boolean') throw new McpFailure('INVALID_ARGS', `参数 ${key} 须是布尔值`);
  return raw;
}

/** 数组参数：宿主契约要数组的地方一律显式校验（缺失/非数组 ⇒ INVALID_ARGS，不猜空数组）。 */
function requireArray(args: Record<string, unknown>, key: string, label: string): readonly unknown[] {
  const raw = args[key];
  if (!Array.isArray(raw)) {
    throw new McpFailure('INVALID_ARGS', `${label} 的 ${key} 须是数组（空数组也要显式给出）`);
  }
  return raw;
}

/** 宿主回包里的数组读数：非数组 ⇒ 显式失败（不静默当空集）。 */
function expectArray(raw: unknown, label: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(raw)) {
    throw new McpFailure(
      'TOOL_EXECUTION_FAILED',
      `${label} 未返回数组读数（宿主形状与契约不符，不静默、不编造空列表）`,
    );
  }
  return raw.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
}

function expectObject(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new McpFailure(
      'TOOL_EXECUTION_FAILED',
      `${label} 未返回对象读数（宿主形状与契约不符，不静默、不编造）`,
    );
  }
  return raw as Record<string, unknown>;
}

/** 分页账的结构形状（与 `@kojo/mcp-host` 的 `paginateByCursor` 返回体逐字段同形）。 */
interface PageResultLike {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly truncated: boolean;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly fingerprint: string;
  readonly changedDuringPaging?: true;
}

function pageAccount(p: PageResultLike): Record<string, unknown> {
  return {
    total: p.total,
    offset: p.offset,
    limit: p.limit,
    truncated: p.truncated,
    hasMore: p.hasMore,
    nextCursor: p.nextCursor,
    fingerprint: p.fingerprint,
    ...(p.changedDuringPaging === true ? { changedDuringPaging: true } : {}),
  };
}

/** id 序列的稳定分页指纹（游标里的下标按这条序列解释）。 */
function keyByField(field: string) {
  return (item: Record<string, unknown>, index: number): string => {
    const base = asString(item[field]);
    return base === '' ? `#${index}` : base;
  };
}

/**
 * 拒绝值 → `McpFailure`。
 *
 * 认形状不认类：桥的 `LauncherBridgeError`（`code` + `message` + `detail` + `retryable`）是
 * 消费方分流修法的判据，压成一句英文原文 = 让模型只能猜。`McpFailure` 原样上抛。
 */
function toMcpFailure(label: string, err: unknown): McpFailure {
  if (err instanceof McpFailure) return err;
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown; detail?: unknown; retryable?: unknown };
    if (typeof e.code === 'string' && typeof e.message === 'string') {
      const detail = typeof e.detail === 'string' && e.detail !== '' ? `；detail=${e.detail.slice(0, 300)}` : '';
      return new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `宿主启动器拒绝（${label}）：code=${e.code} retryable=${e.retryable === true}${detail} message=${e.message.slice(0, 400)}`,
      );
    }
    if (typeof e.message === 'string') {
      return new McpFailure('TOOL_EXECUTION_FAILED', `启动器调用失败（${label}）：${e.message.slice(0, 400)}`);
    }
  }
  return new McpFailure(
    'TOOL_EXECUTION_FAILED',
    `启动器调用失败（${label}）：${String(err).slice(0, 400)}`,
  );
}

/* ------------------------------- 腿工厂 ------------------------------- */

export function createLauncherLegs(deps: McpLauncherDeps): Record<McpLauncherLegName, McpLauncherLeg> {
  /** 真源缺席 ⇒ 显式 NOT_WIRED（铁律 4：没有启动器面就不装出实例来）。 */
  function hostOf(label: string): McpLauncherHostLike {
    const injected = deps.getLauncher?.();
    const raw =
      injected ??
      (deps.getKernel() as unknown as { launcherHost?: unknown } | null)?.launcherHost ??
      null;
    if (!raw || typeof raw !== 'object') {
      throw new McpFailure(
        'NOT_WIRED',
        `启动器面未接线（${label}）：真源 = kernel.launcherHost → 桌面壳 launcher_* 命令；` +
          '浏览器宿 / 内核未到场时没有这一面，不返回空列表冒充「没有实例」',
      );
    }
    return raw as McpLauncherHostLike;
  }

  /** P1 可选方法缺席 ⇒ 显式 NOT_WIRED（宿主没有编进这条命令，不降级、不造假读数）。 */
  function methodOf<K extends keyof McpLauncherHostLike>(
    host: McpLauncherHostLike,
    key: K,
    label: string,
  ): NonNullable<McpLauncherHostLike[K]> {
    const fn = host[key];
    if (typeof fn !== 'function') {
      throw new McpFailure(
        'NOT_WIRED',
        `启动器方法未接线（${label}）：当前宿主没有 ${String(key)} 这条 P1 命令（不静默、不空返回冒充成功）`,
      );
    }
    return fn as NonNullable<McpLauncherHostLike[K]>;
  }

  async function call<T>(label: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      throw toMcpFailure(label, err);
    }
  }

  /** 生命周期动作共用的「任务行 + 可查可撤口径」回包（任务族另有主人，不并入 kojo://tasks）。 */
  function taskReply(raw: unknown, label: string): Record<string, unknown> {
    if (raw === undefined || raw === null) {
      // 宿主这条命令的返回本来就是 void（set_order / delete_backup / cancel / instance_remove）
      return { executed: true, resultKind: 'void', label };
    }
    const task = expectObject(raw, label);
    return {
      executed: true,
      resultKind: 'task',
      label,
      task,
      taskRowId: asString(task['id']),
      taskState: asString(task['state']),
      taskCancellable: task['cancellable'] === true,
      queryFace: 'launcher_task_list',
      cancelFace: 'launcher_task_cancel',
      note:
        '任务行属于启动器任务中心（第三张表那一族），刻意不在 kojo://tasks 里——' +
        '查进度用 launcher_task_list，叫停用 launcher_task_cancel（两者都是独立面）。',
    };
  }

  /** 日志页：原始块 + 字节闸 + 分页账（解码与字符集判定归 launcher-core，本层不猜）。 */
  async function logPage(
    label: string,
    run: (query: Record<string, unknown>) => Promise<unknown>,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const query: Record<string, unknown> = {};
    const stream = args['stream'];
    if (stream !== undefined && stream !== null) {
      if (stream !== 'stdout' && stream !== 'stderr' && stream !== 'all') {
        throw new McpFailure('INVALID_ARGS', `stream 取值非法：${String(stream)}（期望 stdout|stderr|all）`);
      }
      query['stream'] = stream;
    }
    const wantedBytes = asFinite(args['maxBytes'], MAX_LOG_PAGE_BYTES);
    if (wantedBytes < 1) {
      throw new McpFailure('INVALID_ARGS', `maxBytes 须 >= 1 字节（给了 ${String(args['maxBytes'])}）`);
    }
    // 收紧不放宽：宿主默认 1 MiB/流，本面最多 40 KiB/流（base64 后仍在不可信串闸之下）。
    query['maxBytes'] = Math.min(Math.floor(wantedBytes), MAX_LOG_PAGE_BYTES);
    const page = expectObject(await call(label, () => run(query)), label);
    const chunks = expectArray(page['chunks'], `${label}.chunks`);
    const p = paginateByCursor(chunks, (c, i) => `${asString(c['stream'])}:${asFinite(c['ts'], i)}`, args, {
      defaultLimit: LOG_CHUNK_DEFAULT_LIMIT,
      maxLimit: LOG_CHUNK_MAX_LIMIT,
    });
    const payload = p.page.map((c) => {
      const b64 = asString(c['bytesBase64']);
      const overGate = b64.length > 65_000;
      // base64 的等号补位决定真实字节数：整组 4 字符 = 3 字节，末尾 1 个 '=' 少 1 字节、2 个少 2 字节。
      const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
      return {
        stream: asString(c['stream']),
        ts: typeof c['ts'] === 'number' ? c['ts'] : null,
        byteLength: Math.max(0, Math.floor(b64.length / 4) * 3 - pad),
        truncated: c['truncated'] === true,
        // 形状照宿主真形：原始块（base64），本层不解码——字符集判定是 launcher-core 的活，
        // 在这里猜 UTF-8/CP932 = 第二份判据。逐页拼接后整串解码才是正确用法。
        bytesBase64: overGate ? b64.slice(0, 65_000) : b64,
        payloadBase64Chars: b64.length,
        ...(overGate ? { payloadBase64Truncated: true } : {}),
      };
    });
    return {
      session: page['session'] ?? null,
      // 宿主的字节截断读数单独立一个名字：下面 pageAccount 的 `truncated` 说的是「本页没含全部块」，
      // 两件事不许挤在同一位上（挤在一起 = 宿主说截断却被分页账覆盖成 false，静默失真）。
      truncatedByBytes: page['truncated'] === true,
      hostTruncatedNote:
        'truncatedByBytes 是宿主的读数（该流因 maxBytes 被截，尾部还有字节没给）；' +
        '本页的账（块级）见 offset/limit/truncated/hasMore/nextCursor，两者不是一回事',
      chunks: payload,
      ...pageAccount(p),
      decodeNote:
        '字节块未经解码：字符集与行切分由启动器核心（launcher-core 的日志服务）判定，' +
        '本面不猜编码。请把各页的 bytesBase64 按 nextCursor 顺序拼回后再解码。',
    };
  }

  const launcherInstanceList: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_instance_list');
    const raw = await call('launcher_instance_list', () => host.instanceList());
    const list = expectArray(raw, 'launcher_instance_list');
    const p = paginateByCursor(list, keyByField('id'), args, {
      defaultLimit: LIST_DEFAULT_LIMIT,
      maxLimit: LIST_MAX_LIMIT,
    });
    return { instances: p.page, ...pageAccount(p) };
  };

  const launcherInstanceGet: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_instance_get');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_instance_get');
    const raw = await call('launcher_instance_get', () => host.instanceInspect(instanceId));
    return expectObject(raw, 'launcher_instance_get');
  };

  const launcherInstanceUpdate: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_instance_update');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_instance_update');
    // 白名单只收「描述性」字段：跑什么（可执行路径 / 启动参数 / 环境变量）留给人的决定，
    // 本批刻意不收 —— 这是收紧，不是新权限（宿主白名单本身仍是判据真源）。
    const patch: Record<string, unknown> = {};
    for (const key of ['name', 'notes', 'tags'] as const) {
      const raw = args[key];
      if (raw === undefined || raw === null) continue;
      if (key === 'tags') {
        if (!Array.isArray(raw) || raw.some((t) => typeof t !== 'string')) {
          throw new McpFailure('INVALID_ARGS', 'tags 须是字符串数组');
        }
        if (raw.length > 32) throw new McpFailure('INVALID_ARGS', 'tags 最多 32 条');
        patch[key] = raw.map((t) => (t as string).slice(0, 64));
      } else {
        patch[key] = optionalString(args, key, key === 'name' ? 120 : 2000);
      }
    }
    if (Object.keys(patch).length === 0) {
      throw new McpFailure(
        'INVALID_ARGS',
        'launcher_instance_update 至少给一个可改字段（name / notes / tags）；' +
          '可执行路径、启动参数与环境变量刻意不收（跑什么由人定）',
      );
    }
    const raw = await call('launcher_instance_update', () => host.instanceUpdate(instanceId, patch));
    return expectObject(raw, 'launcher_instance_update');
  };

  const launcherInstanceRemove: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_instance_remove');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_instance_remove');
    const deleteFiles = optionalBoolean(args, 'deleteFiles');
    const keepBackups = optionalBoolean(args, 'keepBackups');
    if (deleteFiles === undefined) {
      throw new McpFailure(
        'INVALID_ARGS',
        'launcher_instance_remove 必须显式给 deleteFiles（true=连实例目录一起删，false=只清登记）：不给即拒绝，不猜默认值',
      );
    }
    const raw = await call('launcher_instance_remove', () =>
      host.instanceRemove(instanceId, { deleteFiles, keepBackups: keepBackups ?? null }),
    );
    return taskReply(raw, 'launcher_instance_remove');
  };

  const launcherInstanceDuplicate: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_instance_duplicate');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_instance_duplicate');
    const name = optionalString(args, 'name', 120);
    const raw = await call('launcher_instance_duplicate', () => host.instanceDuplicate(instanceId, name ?? null));
    const created = expectObject(raw, 'launcher_instance_duplicate');
    return {
      ...created,
      note: 'copy 隔离的实例后台复制走任务行（task 非空 = 还在复制）；用 launcher_task_list 查、launcher_task_cancel 撤',
    };
  };

  const launcherContentList: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_content_list');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_content_list');
    const fn = methodOf(host, 'contentList', 'launcher_content_list');
    const raw = await call('launcher_content_list', () => fn.call(host, instanceId));
    const list = expectArray(raw, 'launcher_content_list');
    const p = paginateByCursor(
      list,
      (c, i) => {
        const manifest = (c['manifest'] ?? {}) as Record<string, unknown>;
        const id = asString(manifest['id']);
        return id === '' ? `#${i}` : id;
      },
      args,
      { defaultLimit: LIST_DEFAULT_LIMIT, maxLimit: LIST_MAX_LIMIT },
    );
    return { contents: p.page, ...pageAccount(p) };
  };

  const launcherContentDiagnose: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_content_diagnose');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_content_diagnose');
    const fn = methodOf(host, 'contentDiagnose', 'launcher_content_diagnose');
    const raw = await call('launcher_content_diagnose', () => fn.call(host, instanceId));
    const page = expectObject(raw, 'launcher_content_diagnose');
    const issues = expectArray(page['issues'], 'launcher_content_diagnose.issues');
    const p = paginateByCursor(
      issues,
      (it, i) => `${asString(it['packId'])}|${asString(it['code'])}|${asString(it['path'])}|${i}`,
      args,
      { defaultLimit: LIST_DEFAULT_LIMIT, maxLimit: LIST_MAX_LIMIT },
    );
    return {
      instanceId: asString(page['instanceId']) || instanceId,
      issues: p.page,
      // 宿主比领域契约多报两档（只有看见磁盘才判得出），照真形原样给，不折码、不藏。
      codeNote:
        "issues[].code 的取值含宿主独有的 'orphan-file' / 'load-order'（领域码表没有这两档）；" +
        '本面不把它们悄悄折成 conflict —— 孤儿文件与启用顺序异常必须可见',
      ...pageAccount(p),
    };
  };

  const launcherProcessList: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_process_list');
    const raw = await call('launcher_process_list', () => host.processList());
    const list = expectArray(raw, 'launcher_process_list');
    const p = paginateByCursor(list, keyByField('instanceId'), args, {
      defaultLimit: LIST_DEFAULT_LIMIT,
      maxLimit: LIST_MAX_LIMIT,
    });
    return { processes: p.page, ...pageAccount(p) };
  };

  const launcherProcessStatus: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_process_status');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_process_status');
    const raw = await call('launcher_process_status', () => host.processStatus(instanceId));
    return expectObject(raw, 'launcher_process_status');
  };

  const launcherTaskList: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_task_list');
    const raw = await call('launcher_task_list', () => host.taskList());
    const list = expectArray(raw, 'launcher_task_list');
    const p = paginateByCursor(list, keyByField('id'), args, {
      defaultLimit: LIST_DEFAULT_LIMIT,
      maxLimit: LIST_MAX_LIMIT,
    });
    return {
      tasks: p.page,
      ...pageAccount(p),
      faceNote:
        '启动器任务中心自己的表：与 kojo://tasks（长任务面：检索 / 校验）是两套独立面，' +
        '刻意不并表（并表会替第三张表那族任务造第二份主人）',
    };
  };

  const launcherTaskCancel: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_task_cancel');
    const taskId = requireId(args, 'taskId', COMPONENT_ID_RE, 'launcher_task_cancel');
    const raw = await call('launcher_task_cancel', () => host.taskCancel(taskId));
    const reply = taskReply(raw, 'launcher_task_cancel');
    return { ...reply, cancelledTaskId: taskId };
  };

  const launcherSaveList: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_save_list');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_save_list');
    const fn = methodOf(host, 'saveList', 'launcher_save_list');
    const raw = await call('launcher_save_list', () => fn.call(host, instanceId));
    // 宿主真形：{entries, roots, warnings}，**不是裸 SaveEntry[]**（roots[].approved 是写回门禁）。
    const listing = expectObject(raw, 'launcher_save_list');
    const entries = expectArray(listing['entries'], 'launcher_save_list.entries');
    const roots = expectArray(listing['roots'] ?? [], 'launcher_save_list.roots');
    const p = paginateByCursor(
      entries,
      (e, i) => `${asString(e['rootId'])}|${asString(e['path'])}|${i}`,
      args,
      { defaultLimit: SAVE_ENTRY_DEFAULT_LIMIT, maxLimit: SAVE_ENTRY_MAX_LIMIT },
    );
    return {
      entries: p.page,
      roots,
      warnings: Array.isArray(listing['warnings']) ? listing['warnings'] : [],
      rootsNote:
        'roots[].approved=false = 该根尚未获得逐根写授权（第三张表由原生目录对话框写入，MCP 面拿不到）：' +
        '此时恢复 / 导入一类的写回会被宿主显式拒绝，不是本工具的缺陷',
      ...pageAccount(p),
    };
  };

  const launcherSaveBackups: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_save_backups');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_save_backups');
    const fn = methodOf(host, 'saveBackups', 'launcher_save_backups');
    const raw = await call('launcher_save_backups', () => fn.call(host, instanceId));
    const list = expectArray(raw, 'launcher_save_backups');
    const p = paginateByCursor(list, keyByField('id'), args, {
      defaultLimit: LIST_DEFAULT_LIMIT,
      maxLimit: LIST_MAX_LIMIT,
    });
    return { backups: p.page, ...pageAccount(p) };
  };

  const launcherSaveBackup: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_save_backup');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_save_backup');
    const fn = methodOf(host, 'saveBackup', 'launcher_save_backup');
    const req: Record<string, unknown> = {};
    const label = optionalString(args, 'label', 120);
    if (label !== undefined) req['label'] = label;
    const reason = args['reason'];
    if (reason !== undefined && reason !== null) {
      if (reason !== 'manual' && reason !== 'pre-restore' && reason !== 'pre-plugin') {
        throw new McpFailure(
          'INVALID_ARGS',
          `reason 取值非法：${String(reason)}（本面只收 manual|pre-restore|pre-plugin；'auto' 是宿主内部策略位）`,
        );
      }
      req['reason'] = reason;
    }
    const entries = args['entries'];
    if (entries !== undefined && entries !== null) {
      if (!Array.isArray(entries)) throw new McpFailure('INVALID_ARGS', 'entries 须是数组');
      if (entries.length > SAVE_ENTRY_MAX_LIMIT) {
        throw new McpFailure('INVALID_ARGS', `entries 最多 ${SAVE_ENTRY_MAX_LIMIT} 条（本面不收无界清单）`);
      }
      req['entries'] = entries.map((e, i) => {
        if (!e || typeof e !== 'object') throw new McpFailure('INVALID_ARGS', `entries[${i}] 须是对象`);
        const it = e as Record<string, unknown>;
        const rootId = asString(it['rootId']);
        const path = asString(it['path']);
        if (!INSTANCE_ID_RE.test(rootId) && !COMPONENT_ID_RE.test(rootId)) {
          throw new McpFailure('INVALID_ARGS', `entries[${i}].rootId 形状非法：${rootId.slice(0, 80)}`);
        }
        if (path === '' || path.length > 512 || path.includes(':') || path.startsWith('\\\\')) {
          throw new McpFailure('INVALID_ARGS', `entries[${i}].path 非法（须是 saveRoot 内的相对路径）`);
        }
        return { rootId, path };
      });
    }
    const raw = await call('launcher_save_backup', () => fn.call(host, instanceId, req));
    const reply = taskReply(raw, 'launcher_save_backup');
    const task = reply['task'] as Record<string, unknown> | undefined;
    const result = task && (task['result'] ?? null);
    return {
      ...reply,
      backupId:
        result && typeof result === 'object' ? asString((result as Record<string, unknown>)['backupId']) : '',
      backupIdNote: 'backupId 读自任务行的 result.backupId（宿主真读数）；空串 = 这一轮任务没带这个读数',
    };
  };

  const launcherSaveRestore: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_save_restore');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_save_restore');
    const backupId = requireId(args, 'backupId', COMPONENT_ID_RE, 'launcher_save_restore');
    const fn = methodOf(host, 'saveRestore', 'launcher_save_restore');
    const backupCurrent = optionalBoolean(args, 'backupCurrent');
    // 宿主缺省 backupCurrent=true（恢复前必然先自动备份当前）。这里不给 false 留后门：
    // 只有显式 false 才关掉，且回包里把这一位原样说出。
    const opts = backupCurrent === undefined ? null : { backupCurrent };
    const raw = await call('launcher_save_restore', () => fn.call(host, instanceId, backupId, opts));
    return {
      ...taskReply(raw, 'launcher_save_restore'),
      backupCurrent: backupCurrent ?? true,
      note:
        '宿主在恢复前**必然**先自动备份当前存档（backupCurrent 缺省 true，本面照宿主默认走）；' +
        '写回仍受第三张表逐根授权约束，未授权的根由宿主显式拒绝',
    };
  };

  const launcherSaveDeleteBackup: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_save_delete_backup');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_save_delete_backup');
    const backupId = requireId(args, 'backupId', COMPONENT_ID_RE, 'launcher_save_delete_backup');
    const fn = methodOf(host, 'saveDeleteBackup', 'launcher_save_delete_backup');
    const raw = await call('launcher_save_delete_backup', () => fn.call(host, instanceId, backupId));
    return { ...taskReply(raw, 'launcher_save_delete_backup'), deletedBackupId: backupId };
  };

  const launcherSaveApplyImport: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_save_apply_import');
    const planId = requireId(args, 'planId', COMPONENT_ID_RE, 'launcher_save_apply_import');
    const fn = methodOf(host, 'saveApplyImport', 'launcher_save_apply_import');
    const resolutions = readResolutions(args, 'launcher_save_apply_import');
    const raw = await call('launcher_save_apply_import', () => fn.call(host, planId, resolutions));
    return {
      ...taskReply(raw, 'launcher_save_apply_import'),
      planId,
      note:
        'planId 一次性消费且会过期（预检由界面侧的导入向导产出；本批刻意不把 ' +
        'launcher_save_import 登记成模型可调用工具，见 MCP_DEFERRED_GAP_NOTES）。' +
        '计划不存在 / 已过期 ⇒ 宿主显式拒绝，不静默重开一份计划',
    };
  };

  const launcherContentApply: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_content_apply');
    const planId = requireId(args, 'planId', COMPONENT_ID_RE, 'launcher_content_apply');
    const fn = methodOf(host, 'contentApply', 'launcher_content_apply');
    const resolutions = readResolutions(args, 'launcher_content_apply');
    const raw = await call('launcher_content_apply', () => fn.call(host, planId, resolutions));
    return {
      ...taskReply(raw, 'launcher_content_apply'),
      planId,
      note:
        '两阶段的第二半：planId 由预检产出（一次性 + 会过期）且必须由界面侧向导给出——' +
        'launcher_content_plan 收绝对路径的输入件参数，本批刻意不登记成模型可调用工具' +
        '（见 MCP_DEFERRED_GAP_NOTES）。落盘只写已授权根，未授权的根由宿主显式拒绝',
    };
  };

  const launcherContentSetEnabled: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_content_set_enabled');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_content_set_enabled');
    const packId = requireId(args, 'packId', COMPONENT_ID_RE, 'launcher_content_set_enabled');
    const enabled = args['enabled'];
    if (typeof enabled !== 'boolean') {
      throw new McpFailure('INVALID_ARGS', 'launcher_content_set_enabled.enabled 须是布尔值');
    }
    const fn = methodOf(host, 'contentSetEnabled', 'launcher_content_set_enabled');
    const raw = await call('launcher_content_set_enabled', () =>
      fn.call(host, instanceId, packId, enabled),
    );
    return { ...taskReply(raw, 'launcher_content_set_enabled'), packId, enabled };
  };

  const launcherContentSetOrder: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_content_set_order');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_content_set_order');
    const packIds = requireArray(args, 'packIds', 'launcher_content_set_order').map((id, i) => {
      if (typeof id !== 'string' || !COMPONENT_ID_RE.test(id)) {
        throw new McpFailure('INVALID_ARGS', `packIds[${i}] 形状非法：${String(id).slice(0, 80)}`);
      }
      return id;
    });
    if (packIds.length > LIST_MAX_LIMIT) {
      throw new McpFailure('INVALID_ARGS', `packIds 最多 ${LIST_MAX_LIMIT} 条（本面不收无界清单）`);
    }
    if (new Set(packIds).size !== packIds.length) {
      throw new McpFailure('INVALID_ARGS', 'packIds 不得有重复项（排列必须是已装包 id 的排列）');
    }
    const fn = methodOf(host, 'contentSetOrder', 'launcher_content_set_order');
    const raw = await call('launcher_content_set_order', () => fn.call(host, instanceId, packIds));
    return { ...taskReply(raw, 'launcher_content_set_order'), packIds };
  };

  /**
   * `launcher_content_uninstall`：`files` 是「本包独占」快照。
   *
   * 快照**不交给模型编**：本腿用宿主自己的 `launcher_content_list` 读数现算
   * （本包 ownedFiles 减去其它包 ownedFiles 的并集），与界面侧同一份判据来源；
   * 宿主仍然拿 `ownership.json` 复核（快照只是纵深防御的一层，不是删文件的唯一凭据）。
   */
  const launcherContentUninstall: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_content_uninstall');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_content_uninstall');
    const packId = requireId(args, 'packId', COMPONENT_ID_RE, 'launcher_content_uninstall');
    const listFn = methodOf(host, 'contentList', 'launcher_content_uninstall（独占清单的判据来源）');
    const listing = expectArray(
      await call('launcher_content_uninstall.contentList', () => listFn.call(host, instanceId)),
      'launcher_content_uninstall.contentList',
    );
    const target = listing.find((c) => packIdOf(c) === packId);
    if (!target) {
      throw new McpFailure(
        'RESOURCE_UNAVAILABLE',
        `内容包 ${packId} 不在实例 ${instanceId} 的已装清单里（宿主读数）：卸载整批拒绝，不猜包、不空删`,
      );
    }
    // 卸载方法的存在性判在「包确实装着」之后：包都不在时先给真读数理由，而不是先报命令缺席。
    const fn = methodOf(host, 'contentUninstall', 'launcher_content_uninstall');
    const others = new Set<string>();
    for (const c of listing) {
      if (c === target || packIdOf(c) === packId) continue;
      for (const f of ownedRefs(c)) others.add(`${f.rootId}|${f.path}`);
    }
    const owned = ownedRefs(target);
    const files = owned.filter((f) => !others.has(`${f.rootId}|${f.path}`));
    const raw = await call('launcher_content_uninstall', () => fn.call(host, instanceId, packId, files));
    return {
      ...taskReply(raw, 'launcher_content_uninstall'),
      packId,
      ownedFileCount: owned.length,
      exclusiveFileCount: files.length,
      sharedFileCount: owned.length - files.length,
      filesBasis:
        '独占清单由本腿按宿主 launcher_content_list 的 ownership 读数现算（本包 ownedFiles 减去其它包并集），' +
        '不收模型编造的文件清单；宿主仍以 ownership.json 复核',
    };
  };

  /** 宿主 `launcher_project_hash`：只读输入根，宿主复核它在写允许域内（§7.1 唯一例外）。 */
  const launcherProjectHash: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_project_hash');
    const fn = methodOf(host, 'projectHash', 'launcher_project_hash');
    const projectDir = asString(args['projectDir']);
    if (projectDir === '' || projectDir.length > 512 || projectDir.includes('\u0000')) {
      throw new McpFailure(
        'INVALID_ARGS',
        'projectDir 须是非空绝对路径字符串（≤512）；本面不做路径拼接，落点复核在宿主',
      );
    }
    const artifactDir = asString(args['artifactDir']);
    if (!COMPONENT_ID_RE.test(artifactDir)) {
      throw new McpFailure('INVALID_ARGS', `artifactDir 须是单层目录名（${COMPONENT_ID_RE.source}）`);
    }
    const entries = requireArray(args, 'entries', 'launcher_project_hash').map((p, i) => {
      if (typeof p !== 'string' || p === '' || p.length > 512 || p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) {
        throw new McpFailure(
          'INVALID_ARGS',
          `entries[${i}] 须是相对 artifactDir 的 POSIX 相对路径（不收绝对路径 / 盘符）：${String(p).slice(0, 80)}`,
        );
      }
      return p;
    });
    if (entries.length === 0) {
      throw new McpFailure('INVALID_ARGS', 'entries 不能为空数组（空清单的摘要读数没有任何意义）');
    }
    if (entries.length > 2000) {
      throw new McpFailure('INVALID_ARGS', `entries 最多 2000 条（本面不收无界清单）`);
    }
    const raw = await call('launcher_project_hash', () =>
      fn.call(host, { projectDir, artifactDir, entries }),
    );
    const digests = expectArray(raw, 'launcher_project_hash');
    const p = paginateByCursor(digests, keyByField('path'), args, {
      defaultLimit: LIST_DEFAULT_LIMIT,
      maxLimit: LIST_MAX_LIMIT,
    });
    return {
      projectDir,
      artifactDir,
      requestedEntries: entries.length,
      digests: p.page,
      ...pageAccount(p),
      note:
        '只读摘要：projectDir 是**输入根**，宿主复核它落在已登记的写允许域内（appData / 用户批准的工作区根），' +
        '条目解析后不得逃逸 artifactDir。本面不拼路径、不规范化条目，也不因此获得任何写权限',
    };
  };

  const launcherStart: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_start');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_start');
    const raw = await call('launcher_start', () => host.start(instanceId));
    return {
      ...expectObject(raw, 'launcher_start'),
      lifecycleNote:
        '校验链（实例就绪 → 程序合法 → 信任哈希 → 运行时 → 每实例锁）全在宿主；' +
        '可执行文件信任只能由人经原生确认框授予（launcher_trust_executable 刻意不登记）',
    };
  };

  const launcherStop: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_stop');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_stop');
    const force = optionalBoolean(args, 'force');
    const timeoutMsRaw = args['timeoutMs'];
    let timeoutMs: number | undefined;
    if (timeoutMsRaw !== undefined && timeoutMsRaw !== null) {
      timeoutMs = asFinite(timeoutMsRaw, Number.NaN);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000) {
        throw new McpFailure('INVALID_ARGS', `timeoutMs 须在 0..120000（给了 ${String(timeoutMsRaw)}）`);
      }
    }
    const opts: Record<string, unknown> = {};
    if (force !== undefined) opts['force'] = force;
    if (timeoutMs !== undefined) opts['timeoutMs'] = timeoutMs;
    const raw = await call('launcher_stop', () =>
      host.stop(instanceId, Object.keys(opts).length > 0 ? opts : null),
    );
    return { ...expectObject(raw, 'launcher_stop'), forceRequested: force === true };
  };

  const launcherLogTail: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_log_tail');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_log_tail');
    return logPage('launcher_log_tail', (query) => host.logTail(instanceId, query), args);
  };

  const launcherLogRead: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_log_read');
    const sessionId = requireId(args, 'sessionId', COMPONENT_ID_RE, 'launcher_log_read');
    return logPage('launcher_log_read', (query) => host.logRead(sessionId, query), args);
  };

  const launcherLogSessions: McpLauncherLeg = async (args) => {
    const host = hostOf('launcher_log_sessions');
    const instanceId = requireId(args, 'instanceId', INSTANCE_ID_RE, 'launcher_log_sessions');
    const raw = await call('launcher_log_sessions', () => host.logSessions(instanceId));
    const list = expectArray(raw, 'launcher_log_sessions');
    const p = paginateByCursor(list, keyByField('id'), args, {
      defaultLimit: LIST_DEFAULT_LIMIT,
      maxLimit: LIST_MAX_LIMIT,
    });
    return { sessions: p.page, ...pageAccount(p) };
  };

  return {
    launcher_instance_list: launcherInstanceList,
    launcher_instance_get: launcherInstanceGet,
    launcher_instance_update: launcherInstanceUpdate,
    launcher_instance_remove: launcherInstanceRemove,
    launcher_instance_duplicate: launcherInstanceDuplicate,
    launcher_content_list: launcherContentList,
    launcher_content_diagnose: launcherContentDiagnose,
    launcher_content_apply: launcherContentApply,
    launcher_content_uninstall: launcherContentUninstall,
    launcher_content_set_enabled: launcherContentSetEnabled,
    launcher_content_set_order: launcherContentSetOrder,
    launcher_process_list: launcherProcessList,
    launcher_process_status: launcherProcessStatus,
    launcher_task_list: launcherTaskList,
    launcher_task_cancel: launcherTaskCancel,
    launcher_save_list: launcherSaveList,
    launcher_save_backups: launcherSaveBackups,
    launcher_save_backup: launcherSaveBackup,
    launcher_save_restore: launcherSaveRestore,
    launcher_save_delete_backup: launcherSaveDeleteBackup,
    launcher_save_apply_import: launcherSaveApplyImport,
    launcher_log_sessions: launcherLogSessions,
    launcher_log_tail: launcherLogTail,
    launcher_log_read: launcherLogRead,
    launcher_project_hash: launcherProjectHash,
    launcher_start: launcherStart,
    launcher_stop: launcherStop,
  };
}

/* ------------------------------- 共用小段 ------------------------------- */

/** `InstalledContent.manifest.id` 的安全取法（宿主回包一律按不可信输入处理）。 */
function packIdOf(content: Record<string, unknown>): string {
  const manifest = content['manifest'];
  if (!manifest || typeof manifest !== 'object') return '';
  return asString((manifest as Record<string, unknown>)['id']);
}

/** `InstalledContent.ownedFiles` → `{rootId,path}` 读数（脏条目整条丢弃，不编造）。 */
function ownedRefs(content: Record<string, unknown>): readonly { rootId: string; path: string }[] {
  const raw = Array.isArray(content['ownedFiles']) ? content['ownedFiles'] : [];
  const out: { rootId: string; path: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    const rootId = asString(it['rootId']);
    const path = asString(it['path']);
    if (rootId === '' || path === '') continue;
    out.push({ rootId, path });
  }
  return out;
}

/**
 * 冲突裁决参数（两阶段写面的 `resolutions`）。
 *
 * 只认 `{rootId, path, action:'skip'|'overwrite'|'replace'}` 三键、逐条形状校验；
 * 没给 ⇒ 显式 `null`（宿主按「有冲突即中止」走，绝不替模型默认覆盖）。
 */
function readResolutions(
  args: Record<string, unknown>,
  label: string,
): readonly Record<string, unknown>[] | null {
  const raw = args['resolutions'];
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw new McpFailure('INVALID_ARGS', `${label}.resolutions 须是数组`);
  if (raw.length > LIST_MAX_LIMIT) {
    throw new McpFailure('INVALID_ARGS', `${label}.resolutions 最多 ${LIST_MAX_LIMIT} 条`);
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') {
      throw new McpFailure('INVALID_ARGS', `${label}.resolutions[${i}] 须是对象`);
    }
    const it = item as Record<string, unknown>;
    const rootId = asString(it['rootId']);
    const path = asString(it['path']);
    const action = asString(it['action']);
    if (rootId === '' || path === '' || path.length > 512) {
      throw new McpFailure('INVALID_ARGS', `${label}.resolutions[${i}] 缺 rootId / path（或 path 过长）`);
    }
    if (action !== 'skip' && action !== 'overwrite' && action !== 'replace') {
      throw new McpFailure(
        'INVALID_ARGS',
        `${label}.resolutions[${i}].action 取值非法：${action || '(空)'}（期望 skip|overwrite|replace）`,
      );
    }
    return { rootId, path, action };
  });
}
