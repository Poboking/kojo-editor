#!/usr/bin/env node
/**
 * 启动器真壳冒烟（车道 GATE，2026-10-26）——把「启动器判据在真壳里的插入点」变成可执行脚本。
 *
 * 通道：只认**真桌面壳**（`node tools/debug-cli.mjs shell` 的会话：CDP + `?kojo-debug=api`）。
 * 页内 `__kojoDebug.invoke` 在 shell 形态下走**真 Tauri IPC**（= 产品同一条路）；web 调试宿
 * （`serve`）**没有**镜像 launcher_* 的 36 条命令，所以本工具在 web 会话上只 SKIP 并说明。
 *
 * 本批驱动的面（只读三条 + 两条负向 + L9 夹具批次）：
 * - 只读三条：`launcher_instance_list` / `launcher_process_list` / `launcher_task_list`——
 *   断言返回**数组**（空表 = 合法读数，不是错误）；
 * - 负向两条：`launcher_start` 给不存在的 instanceId ⇒ 结构化错误（带 `code`，不是 panic）；
 *   `launcher_instance_create` 缺 `profile` ⇒ **参数错误**（Tauri 反序列化层拒收，不是业务错误码）；
 * - 副作用：只读三组探针前后 `launcher_instance_list` 长度不变（证明"只读"不是口号）；
 * - **L9 夹具批次**（`runFixtureProbes`）：在**隔离 appData** 里播种两个夹具实例（已信任 / 未信任），
 *   游戏根是 `os.tmpdir()` 下的临时目录（`cmd.exe` 的两个副本；执行参数全走 cmd 内置命令，
 *   不调外部程序、不碰网络、不弹窗），然后真起真停：
 *   1. 能起（`lifecycle`）：`launcher_start` → `state=running` + pid 非 0 + `launcher_process_list`
 *      同 pid 在列；
 *   2. 能停（`lifecycle`）：`launcher_stop` → `exited` / pid 清空 / `running.lock` 清掉 /
 *      `tasklist` 里夹具 pid 与**孙进程镜像名**双双清零（停之前先证明树真的起过——否则
 *      "没有残留"是句空话）；孙进程镜像名全场唯一，按名过滤即可证明整棵树被 Job 收干净；
 *   3. 信任（`trust`）：未信任夹具 ⇒ `LAUNCHER_TRUST_REQUIRED` + `retryable` + 中文人话；
 *      信任记录的 sha256 **只搬宿主算的那份**（`launcher_instance_get` 的 `executable.sha256`），
 *      `approvedBy` 写 `fixture-seed:launcher-smoke`（可辨认，绝不冒充 native-dialog）；
 *      **不调** `launcher_trust_executable`——它有原生对话框，无人值守会挂；
 *   4. 日志泵（`logs`）：`launcher_log_sessions` 有本场会话、`launcher_log_tail` 尾段含夹具
 *      打印的标记串（base64 原始字节 → 文本双解对拍），收尾后 `endedAt` / `stdoutBytes` 有值；
 *   5. 人话（`platform`）：本机 Windows 上进程闸不可达 ⇒ **SKIP 并说明**（不改判成绿），
 *      只经 overlay 闸核 `LAUNCHER_PLATFORM_UNSUPPORTED` 的报文形状（码 / 中文 message /
 *      `retryable` 字段在）；非 Windows 上才真打进程闸；
 *   6. 清场（`cleanup`）：删夹具实例目录 + 临时游戏根 + 注册表条目（`--keep` 保留），
 *      并把「实例表回到播种前长度」对拍成断言。
 *
 * 隔离（铁律 5 / PITFALLS）：不写任何游戏目录；真壳必须带 `--isolate`——这是 `debug-cli shell`
 * 既有的隔离方式（identifier 换成 `<原 identifier>.smoke`，宿主 appData 落在 `%APPDATA%\<id>.smoke`；
 * debug-cli 没有把 appData 搬进 `KOJO_DEBUG_HOME` 的能力，故本工具只认这一条）。会话自己的产物
 * （session.json / 本工具的读数 JSON）仍在 `<KOJO_DEBUG_HOME>/sessions/<树哈希>/`。
 * 会话没开隔离 ⇒ **直接 SKIP 并说明**，绝不「先跑跑看」。夹具批次的写入只有两处：隔离 appData
 * 与 `os.tmpdir()` 夹具目录（`cleanupPlan` 对这两个根做删除守卫，其它路径一律拒删）。
 * `--start` 会把 TMP/TEMP/TMPDIR 换成 Windows 形态再起壳（Git-Bash 的 `TMP=/tmp` 会让 link.exe
 * 报 LNK1104，PITFALLS 既有条目），并挑一个空闲 vite 端口（1420 被占时不抢别人的 dev server）。
 *
 * 命名对齐（按宿主真实命令名，不按契约草案名）：契约草案里的 `launcher_instance_inspect`
 * 在 Rust 侧叫 **`launcher_instance_get`**（`InspectionDto`），日志尾段叫 `launcher_log_tail`
 * （`launcher_log_read` 走 sessionId）。
 *
 * 用法：`node tools/launcher-smoke.mjs --attach`（默认；驱动当期会话）
 *       `node tools/launcher-smoke.mjs --start`（自己起一台 `shell --isolate` 再驱动，收工自己收）
 *       `--keep` 不清场 / `--boot-ms N` 起壳预算（默认 600s）/ `--out <json>` 读数落盘
 *       `--verbose` 透传真壳日志 / `--help`
 * 退出码：0 = 断言全绿；1 = 有断言红（附分组与归类）；2 = 通道不可用（SKIP，原因可抄）。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, cdpPage, portOpen, sessionDir, sleep, waitFor } from './debug-lib.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const SESS_DIR = sessionDir(REPO);
const SESSION_FILE = process.env.KOJO_DEBUG_SESSION ?? path.join(SESS_DIR, 'session.json');
const CLI = path.join(REPO, 'tools', 'debug-cli.mjs');
const IS_WINDOWS = process.platform === 'win32';

/* ------------------------------------------------------------------ *
 * 纯函数面（`tools/tests/launcher-smoke.test.ts` 逐条钉住）
 * ------------------------------------------------------------------ */

/** 只读三条（P0 命令面的只读子集）：空表是合法读数，不是错误 */
export const READONLY_PROBES = Object.freeze([
  { cmd: 'launcher_instance_list', label: '实例表' },
  { cmd: 'launcher_process_list', label: '进程表' },
  { cmd: 'launcher_task_list', label: '任务表' },
]);

/** 一个不存在的实例 id（形态合法、必然查无此物；不含任何真实目录） */
export const MISSING_INSTANCE_ID = 'gate-smoke-nonexistent-instance';

export const EXPECTED_CODES = Object.freeze({
  startMissing: 'LAUNCHER_INSTANCE_NOT_FOUND',
  platformUnsupported: 'LAUNCHER_PLATFORM_UNSUPPORTED',
});

const PANIC_RE = /panicked at|thread '[^']*' panicked|RUST_BACKTRACE/;
const ARG_ERROR_RE = /invalid args|missing required key|missing field|invalid type|failed to deserialize/i;

/**
 * 页内 invoke 表达式：**在页面里**把 rejection 收成值（CDP 的 exceptionDetails 会丢掉
 * 结构化错误对象，只有页内 catch 才能把 `{code,message,retryable}` 原样带回来）。
 * 表达式里的命令与参数一律走 JSON.stringify 嵌入，调用方不拼字符串。
 */
export function buildInvokeExpression(cmd, args = {}) {
  return `(async () => {
  try {
    const value = await window.__kojoDebug.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})});
    return { ok: true, value };
  } catch (e) {
    let code = null;
    let message = '';
    let detail = null;
    let retryable = null;
    let raw = '';
    if (e && typeof e === 'object') {
      code = typeof e.code === 'string' ? e.code : null;
      message = typeof e.message === 'string' ? e.message : '';
      detail = typeof e.detail === 'string' ? e.detail : null;
      retryable = typeof e.retryable === 'boolean' ? e.retryable : null;
      try { raw = JSON.stringify(e); } catch { raw = String(e); }
    } else {
      message = String(e);
      raw = message;
    }
    return { ok: false, error: { code, message, detail, retryable, raw } };
  }
})()`;
}

/** 错误归类：`launcher-code`（宿主结构化错误）/ `arg`（IPC 参数层）/ `string` / `unknown` */
export function normalizeError(raw) {
  const out = { code: null, message: '', detail: null, retryable: null, kind: 'unknown', panic: false, raw: '' };
  if (raw === null || raw === undefined) return out;
  if (typeof raw === 'string') {
    out.message = raw;
    out.raw = raw;
    out.kind = ARG_ERROR_RE.test(raw) ? 'arg' : 'string';
  } else if (typeof raw === 'object') {
    out.code = typeof raw.code === 'string' && raw.code.trim().length > 0 ? raw.code.trim() : null;
    out.message = typeof raw.message === 'string' ? raw.message : '';
    out.detail = typeof raw.detail === 'string' ? raw.detail : null;
    // `retryable` 在三处都有：契约 `LauncherError.retryable` 恒有 ⇒ 拿不到真值就记 null
    // 而不是 false（"没有这个字段"与"明确不可重试"是两件事，别混）。
    out.retryable = typeof raw.retryable === 'boolean' ? raw.retryable : null;
    try {
      out.raw = JSON.stringify(raw);
    } catch {
      out.raw = String(raw);
    }
    out.kind = out.code !== null ? 'launcher-code' : ARG_ERROR_RE.test(out.message) ? 'arg' : 'object';
  } else {
    out.message = String(raw);
    out.raw = out.message;
  }
  out.panic = PANIC_RE.test(out.message) || PANIC_RE.test(out.raw);
  return out;
}

/** 页内信封归一化：认不出形状的应答按协议错处理（不猜成功） */
export function normalizeEnvelope(raw) {
  if (raw !== null && typeof raw === 'object' && raw.ok === true) return { ok: true, value: raw.value };
  if (raw !== null && typeof raw === 'object' && raw.ok === false) {
    return { ok: false, error: normalizeError(raw.error) };
  }
  return {
    ok: false,
    error: normalizeError({ message: `页内应答形状不可识别：${JSON.stringify(raw)?.slice(0, 200)}` }),
  };
}

function check(id, group, ok, detail) {
  return { id, group, ok: ok === true, detail: String(detail ?? '') };
}

/** 只读面断言：必须是数组；空表通过（空 ≠ 错误），非空只记条数 */
export function checkListReading(probe, envelope) {
  const { cmd, label } = probe;
  if (envelope.ok === true) {
    const value = envelope.value;
    if (!Array.isArray(value)) {
      return [
        check(`${cmd}:array`, 'readonly', false, `${label}不是数组（实际 ${value === null ? 'null' : typeof value}）`),
      ];
    }
    return [check(`${cmd}:array`, 'readonly', true, `${label} ${value.length} 条${value.length === 0 ? '（空表合法）' : ''}`)];
  }
  const error = envelope.error;
  return [
    check(
      `${cmd}:array`,
      'readonly',
      false,
      `只读面报错：code=${error?.code ?? 'null'} message=${(error?.message ?? '').slice(0, 160)}`,
    ),
  ];
}

/**
 * 负向一：`launcher_start` 打不存在的实例。期望**结构化错误**（带 code）而不是 panic。
 * 非 Windows 上平台闸先于查表 ⇒ 允许 PLATFORM_UNSUPPORTED（本仓库首版只认 Windows）。
 */
export function checkStartMissingInstance(envelope, { platform = process.platform } = {}) {
  const id = 'negative-start';
  const expected = platform === 'win32' ? [EXPECTED_CODES.startMissing] : [EXPECTED_CODES.platformUnsupported, EXPECTED_CODES.startMissing];
  if (envelope.ok === true) {
    return [check(id, id, false, `对不存在的实例返回了成功：${JSON.stringify(envelope.value)?.slice(0, 160)}`)];
  }
  const error = envelope.error;
  return [
    check(`${id}:rejected`, id, true, '已拒绝（没有假装启动成功）'),
    check(
      `${id}:code`,
      id,
      typeof error?.code === 'string' && error.code.length > 0,
      `code=${error?.code ?? 'null'}（期望 ${expected.join(' | ')}）`,
    ),
    check(
      `${id}:code-expected`,
      id,
      expected.includes(error?.code),
      `实际 ${error?.code ?? 'null'}`,
    ),
    check(
      `${id}:message-human`,
      id,
      typeof error?.message === 'string' && error.message.trim().length > 0,
      `message=${(error?.message ?? '').slice(0, 120)}`,
    ),
    check(`${id}:no-panic`, id, error?.panic !== true, error?.panic ? '命中 panic 特征（宿主崩溃而非返回错误）' : '无 panic 特征'),
  ];
}

/**
 * 负向二：`launcher_instance_create` 缺 `profile`。期望**参数层**拒收（Tauri 反序列化），
 * 即不是业务错误码——业务错误码意味着宿主收到了半截参数，那才是真问题。
 */
export function checkCreateMissingProfile(envelope) {
  const id = 'negative-create';
  if (envelope.ok === true) {
    return [check(id, id, false, `缺 profile 竟然创建成功：${JSON.stringify(envelope.value)?.slice(0, 160)}`)];
  }
  const error = envelope.error;
  return [
    check(`${id}:rejected`, id, true, '已拒绝'),
    check(
      `${id}:profile-named`,
      id,
      error?.kind === 'arg' && /profile/i.test(`${error?.message ?? ''} ${error?.raw ?? ''}`),
      `kind=${error?.kind} message=${(error?.message ?? '').slice(0, 160)}`,
    ),
    check(`${id}:not-business-code`, id, error?.code === null, `code=${error?.code ?? 'null'}（参数错不该带业务码）`),
    check(`${id}:no-panic`, id, error?.panic !== true, error?.panic ? '命中 panic 特征' : '无 panic 特征'),
  ];
}

/** 隔离判据：真壳必须 `--isolate`（identifier 以 .smoke 结尾 + appData 落在该身份目录） */
export function isIsolatedSession({ mode, identifier, appDataDir } = {}) {
  if (mode !== 'shell') {
    return {
      ok: false,
      reason:
        `当前会话 mode=${mode ?? '未知'}，不是真桌面壳。launcher_* 的 36 条命令只在真壳里（web 调试宿未镜像）；` +
        '先 node tools/debug-cli.mjs shell --isolate，或本工具加 --start 自己起',
    };
  }
  const id = typeof identifier === 'string' ? identifier : '';
  if (!id.endsWith('.smoke')) {
    return {
      ok: false,
      reason: `真壳没有开隔离（identifier=${id || '未知'}）——会碰真 appData；重起为 shell --isolate（本工具的 --start 默认带）`,
    };
  }
  const dir = typeof appDataDir === 'string' ? appDataDir : '';
  if (!/\.smoke(\\|\/|$)/i.test(dir)) {
    return { ok: false, reason: `app_data_dir 不是隔离身份目录（${dir || '未知'}）——拒绝在真 appData 上跑探针` };
  }
  return { ok: true, reason: `隔离身份 ${id} → ${dir}` };
}

/** 只读副作用判据：探针前后实例表必须同长（且不新增 id） */
export function checkNoSideEffect(before, after) {
  const a = Array.isArray(before) ? before : null;
  const b = Array.isArray(after) ? after : null;
  if (a === null || b === null) {
    return [check('side-effect:list', 'side-effect', false, `前后读数不是数组（${a === null ? '前' : ''}${b === null ? '后' : ''}）`)];
  }
  const ids = (list) =>
    list
      .map((entry) => (entry && typeof entry === 'object' ? entry.id ?? entry.instanceId ?? null : null))
      .filter((value) => typeof value === 'string');
  const added = ids(b).filter((value) => !ids(a).includes(value));
  return [
    check('side-effect:count', 'side-effect', a.length === b.length, `${a.length} → ${b.length}`),
    check('side-effect:no-new-id', 'side-effect', added.length === 0, added.length === 0 ? '无新增实例' : `新增：${added.join(',')}`),
  ];
}

/* ------------------------------------------------------------------ *
 * L9 联调批：夹具实例（隔离 appData 里播种 → 真进程起停 → 收工清场）
 *
 * 为什么必须「播种」而不是走产品建实例链路：`launcher_instance_create` 要求源根先经
 * **原生目录对话框**批准（`store::is_source_approved`），无人值守点不了那个框。夹具因此
 * 直接按 `store.rs` 的真实字段形状写 `instance.json` + `registry.json`；唯一"手工"的东西
 * 是**信任记录**——它的 sha256 必须先由宿主自己算（`launcher_instance_get` 的
 * `executable.sha256`），JS 只做搬运，`approvedBy` 写成可辨认的夹具值（绝不冒充 native-dialog）。
 * 信任框本身（`launcher_trust_executable`）有 dialogs，无人值守会挂 ⇒ 本工具**不调它**，
 * 改用另一颗"不写 trust"的实例去打 `LAUNCHER_TRUST_REQUIRED`（那才是那条命令的可测半边）。
 *
 * 写入落点只有两处：隔离 appData（`%APPDATA%\<identifier>.smoke\launcher\…`）与
 * `os.tmpdir()` 下的临时游戏根。真游戏目录一个字节都不碰。
 * ------------------------------------------------------------------ */

/** 夹具游戏根目录名的统一前缀（`cleanupPlan` 的删除守卫也认它） */
export const FIXTURE_PREFIX = 'kojo-launcher-smoke-';
/** 夹具往 stdout 打印的标记串（纯 ASCII：cmd 的 OEM 代码页下同样逐字可读） */
export const FIXTURE_MARKER = 'launcher-fixture-started';
/** 播种信任记录里的 approvedBy：一眼可辨「夹具种的，不是用户点过原生框」 */
export const FIXTURE_APPROVED_BY = 'fixture-seed:launcher-smoke';
/** 宿主支持的 windowMode（`plugin-api/src/launcher.ts`：auto / visible / hidden） */
export const SUPPORTED_WINDOW_MODES = Object.freeze(['auto', 'visible', 'hidden']);
/** 夹具取隐藏档：`process.rs` 见 "hidden" 才加 `CREATE_NO_WINDOW`（不弹窗） */
export const FIXTURE_WINDOW_MODE = 'hidden';
/** 结构版本（`store.rs` 的 `SCHEMA_VERSION` / `INSTANCE_SCHEMA_VERSION`，两边必须逐字相等） */
export const REGISTRY_SCHEMA_VERSION = 1;
export const INSTANCE_SCHEMA_VERSION = 1;
/** 夹具实例的 adapterId / gameId：宿主不理解语义，只要非空 */
export const FIXTURE_ADAPTER_ID = 'launcher-smoke';

/**
 * 一次运行的夹具标识（同进程内唯一）：同时进实例 id、可执行文件名与标记串——
 * 并发另一轮 launcher-smoke 因此不可能撞名（`tasklist` 按镜像名找孙进程全靠它）。
 */
export function fixtureToken({ now = Date.now(), pid = process.pid } = {}) {
  const raw = `${Math.floor(now).toString(36)}${(pid % 46_656).toString(36)}`;
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-10);
}

/** token → 本轮的名字全集（实例 id / 两个可执行文件名 / 标记串 / 游戏根目录名） */
export function fixtureNames(token) {
  const t = String(token ?? '');
  if (!/^[a-z0-9]{1,10}$/.test(t)) throw new Error(`夹具 token 形状非法：${token}`);
  return {
    token: t,
    ids: { trusted: `l9s-${t}-a`, untrusted: `l9s-${t}-b` },
    exe: `l9fx-${t}-a.exe`,
    childExe: `l9fx-${t}-b.exe`,
    marker: `${FIXTURE_MARKER} ${t}`,
    gameRootName: `${FIXTURE_PREFIX}${t}`,
  };
}

/**
 * 夹具的执行参数：`cmd /c "echo <标记> & <孙进程> /c for /l %i in (1,1,<N>) do @rem"`。
 *
 * - `echo` 立刻给日志泵一行（标记串）；
 * - 孙进程 = 同一份 cmd.exe 的**另一个副本名**，跑纯**内置**的 `for /l` 空转 ≈20 s
 *   （实测本机 ≈1M 次/秒，3M 次 3.0 s）。为什么不用 `ping 127.0.0.1` 那套老办法：
 *   L9 实测**宿主起的 cmd 里 `ping` 会立刻死在 DNS 上**（stderr 为「DNS 服务器对区域没有权威。」，
 *   同一组参数由 node 起是正常的），fixture 不该赌外部程序可达；内置循环不碰网络、不依赖 PATH、
 *   也不受本机 DNS / 安全软件影响，且**一样是个真子进程**（Job 杀树的判据不受影响）；
 * - 孙进程的镜像名全场唯一 ⇒ `tasklist` 按名过滤就能证明"树真的起过、且一个不剩"。
 */
export const FIXTURE_LOOP_COUNT = 20_000_000;

export function fixtureArgs(childExe, marker) {
  if (typeof childExe !== 'string' || !/\.exe$/i.test(childExe)) throw new Error(`夹具孙进程必须是 .exe：${childExe}`);
  if (typeof marker !== 'string' || marker.length === 0) throw new Error('夹具标记串不能为空');
  return ['/c', `echo ${marker} & ${childExe} /c for /l %i in (1,1,${FIXTURE_LOOP_COUNT}) do @rem`];
}

/** 隔离 appData 下与本实例相关的全部落点（镜像 `paths.rs` 的 LauncherLayout） */
export function fixtureLayout(appDataDir, id) {
  const launcherDir = path.join(String(appDataDir ?? ''), 'launcher');
  const instancesDir = path.join(launcherDir, 'instances');
  const instanceRoot = path.join(instancesDir, String(id ?? ''));
  return {
    launcherDir,
    instancesDir,
    registryFile: path.join(launcherDir, 'registry.json'),
    instanceRoot,
    manifestFile: path.join(instanceRoot, 'instance.json'),
    lockFile: path.join(instanceRoot, 'running.lock'),
    logsDir: path.join(instanceRoot, 'logs'),
  };
}

/**
 * `instance.json` 的播种形状（逐字段对齐 `store::StoredInstance`，camelCase）。
 * 形参非法一律抛错：宁可脚本当场挂，也别写一份宿主读不出的清单。
 */
export function buildFixtureInstance(input) {
  const {
    id,
    name = id,
    gameRoot,
    relativePath,
    args = [],
    windowMode = FIXTURE_WINDOW_MODE,
    now = new Date().toISOString(),
    notes = 'launcher-smoke 夹具（L9）；收工即删',
  } = input ?? {};
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error(`夹具实例 id 形状非法：${id}`);
  if (typeof gameRoot !== 'string' || !path.isAbsolute(gameRoot)) throw new Error(`夹具游戏根必须是绝对路径：${gameRoot}`);
  if (typeof relativePath !== 'string' || !/\.exe$/i.test(relativePath)) throw new Error(`夹具可执行只能是 .exe：${relativePath}`);
  if (!SUPPORTED_WINDOW_MODES.includes(windowMode)) throw new Error(`windowMode 不在宿主支持档内：${windowMode}`);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('夹具 args 必须是字符串数组');
  return {
    schemaVersion: INSTANCE_SCHEMA_VERSION,
    id,
    name,
    adapterId: FIXTURE_ADAPTER_ID,
    gameId: FIXTURE_ADAPTER_ID,
    createdAt: now,
    updatedAt: now,
    sourceRoot: gameRoot,
    isolation: 'shared',
    state: 'ready',
    executable: { relativePath, args: [...args], env: {}, windowMode, sha256: null },
    runtimeId: null,
    locale: null,
    encoding: null,
    saveRoots: [],
    contentRoots: [],
    executableTrust: null,
    launchCount: 0,
    lastLaunchedAt: null,
    lastExit: null,
    notes,
    tags: ['launcher-smoke-fixture'],
  };
}

/** 清单里与注册表索引共有的那七个字段（`store::RegistryEntry`） */
export function instanceRegistryEntry(instance) {
  return {
    id: instance.id,
    name: instance.name,
    adapterId: instance.adapterId,
    gameId: instance.gameId,
    isolation: instance.isolation,
    state: instance.state,
    updatedAt: instance.updatedAt,
  };
}

/**
 * 把夹具条目并进现有注册表。**读不懂就 fail-closed**（不静默用空表覆盖别人的库）。
 * 返回 `{ ok, registry, reason }`；不存在（首次运行）按空表起步。
 */
export function mergeFixtureRegistry(raw, entries = []) {
  const base = raw === null || raw === undefined ? { schemaVersion: REGISTRY_SCHEMA_VERSION, rev: 0, instances: [] } : raw;
  if (typeof base !== 'object' || base === null || !Array.isArray(base.instances)) {
    return { ok: false, registry: null, reason: '现有 registry.json 形状不对（instances 不是数组）——fail-closed，不覆盖' };
  }
  const incoming = entries.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string');
  const incomingIds = new Set(incoming.map((entry) => entry.id));
  const kept = base.instances.filter((entry) => !(entry !== null && typeof entry === 'object' && incomingIds.has(entry.id)));
  const rev = Number.isFinite(Number(base.rev)) ? Number(base.rev) : 0;
  return {
    ok: true,
    reason: '',
    registry: { schemaVersion: REGISTRY_SCHEMA_VERSION, rev: rev + 1, instances: [...kept, ...incoming] },
  };
}

/** 从注册表里摘掉夹具条目（清场用）；`raw` 不存在 ⇒ `registry: null`（调用方据此删文件） */
export function stripFixtureRegistry(raw, ids = []) {
  if (raw === null || raw === undefined) return { ok: true, registry: null, reason: '' };
  if (typeof raw !== 'object' || !Array.isArray(raw.instances)) {
    return { ok: false, registry: null, reason: '现有 registry.json 形状不对（instances 不是数组）——不覆盖' };
  }
  const drop = new Set(ids);
  const kept = raw.instances.filter((entry) => !(entry !== null && typeof entry === 'object' && drop.has(entry.id)));
  const rev = Number.isFinite(Number(raw.rev)) ? Number(raw.rev) : 0;
  return { ok: true, reason: '', registry: { schemaVersion: REGISTRY_SCHEMA_VERSION, rev: rev + 1, instances: kept } };
}

/**
 * 把**宿主算出的**摘要写成信任记录（`store::StoredTrust` 的四个字段）。
 * sha256 只接受 64 位小写十六进制——这不是"自己算哈希"，是把宿主的读数搬进清单。
 */
export function attachTrust(instance, { sha256, size, approvedAt = new Date().toISOString(), approvedBy = FIXTURE_APPROVED_BY } = {}) {
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`信任记录的 sha256 必须是宿主算出的 64 位小写十六进制：${sha256}`);
  }
  if (!Number.isInteger(size) || size <= 0) throw new Error(`信任记录的 size 不合法：${size}`);
  if (typeof approvedBy !== 'string' || approvedBy.trim().length === 0) throw new Error('approvedBy 不能为空');
  return {
    ...instance,
    executable: { ...instance.executable, sha256 },
    executableTrust: { sha256, size, approvedAt, approvedBy },
  };
}

/* ---------------- 读数解析（tasklist / 日志块） ---------------- */

/**
 * `tasklist /FO CSV /NH` → `[{ image, pid }]`。
 * 只认引号开头的行：无匹配时 tasklist 打一行本地化提示（不带引号），自然被跳过。
 */
export function parseTasklistCsv(text) {
  const rows = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('"')) continue;
    const cells = [];
    const re = /"([^"]*)"/g;
    let match = re.exec(trimmed);
    while (match !== null) {
      cells.push(match[1]);
      match = re.exec(trimmed);
    }
    if (cells.length < 2) continue;
    const pid = Number(cells[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ image: cells[0], pid });
  }
  return rows;
}

/** 按镜像名（大小写不敏感）挑行 */
export function rowsByImage(rows, image) {
  const wanted = String(image ?? '').toLowerCase();
  return (Array.isArray(rows) ? rows : []).filter(
    (row) => row !== null && typeof row === 'object' && String(row.image ?? '').toLowerCase() === wanted,
  );
}

/**
 * 日志块（`LogChunkDto[]`，宿主只回 base64 原始字节）→ 文本。
 * 夹具标记串是 ASCII，故 utf8 / latin1 两种解都至少有一路逐字命中；但夹具**失败**时
 * cmd / ping 打的是本机 OEM 代码页的中文（zh-CN = GBK）⇒ 多给一路 `gbk` 只为让红变得可读
 * （`TextDecoder('gbk')` 在 Node 的 full-icu 构建里可用；拿不到就记 null，不影响断言）。
 */
export function logTextOf(chunks) {
  const list = Array.isArray(chunks) ? chunks : [];
  const buffers = list.map((chunk) => Buffer.from(String(chunk?.bytesBase64 ?? ''), 'base64'));
  const all = Buffer.concat(buffers);
  let gbk = null;
  try {
    gbk = new TextDecoder('gbk', { fatal: false }).decode(all);
  } catch {
    gbk = null;
  }
  return {
    bytes: all.length,
    streams: list.map((chunk) => String(chunk?.stream ?? '?')),
    utf8: all.toString('utf8'),
    latin1: all.toString('latin1'),
    gbk,
  };
}

/* ---------------- 断言：播种 / 信任 / 起 / 停 / 日志 / 失败路径 / 清场 ---------------- */

/** 播种落地：两个夹具都进实例表，且长度恰好 +2 */
export function checkFixtureSeeded({ baseline, afterSeed, ids = [] } = {}) {
  const before = Array.isArray(baseline) ? baseline : null;
  const after = Array.isArray(afterSeed) ? afterSeed : null;
  if (before === null || after === null) {
    return [check('fixture:seed-list', 'fixture', false, `播种前后读数不是数组（前=${before === null ? '非数组' : before.length}，后=${after === null ? '非数组' : after.length}）`)];
  }
  const present = after
    .map((entry) => (entry !== null && typeof entry === 'object' ? entry.id ?? null : null))
    .filter((id) => typeof id === 'string' && ids.includes(id));
  return [
    check('fixture:seed-present', 'fixture', present.length === ids.length, `播种后可见 ${present.length}/${ids.length}：${present.join(',') || '无'}`),
    check('fixture:seed-count', 'fixture', after.length === before.length + ids.length, `实例表 ${before.length} → ${after.length}`),
  ];
}

/** 播种后的第一次检视：摘要必须由宿主算（这就是后面写信任记录的唯一来源） */
export function checkManifestDigest(envelope) {
  const group = 'fixture';
  if (envelope?.ok !== true || envelope.value === null || typeof envelope.value !== 'object') {
    const error = envelope?.error ?? {};
    return [check('fixture:inspect', group, false, `launcher_instance_get 失败：code=${error.code ?? 'null'} message=${String(error.message ?? '').slice(0, 140)}`)];
  }
  const value = envelope.value;
  const exe = value.executable ?? {};
  const instance = value.instance ?? {};
  const digest = typeof exe.sha256 === 'string' ? exe.sha256 : '';
  return [
    check('fixture:inspect', group, true, `absolutePath=${String(exe.absolutePath ?? '').slice(0, 160)}`),
    check('fixture:exists', group, exe.exists === true, `executable.exists=${exe.exists ?? '缺字段'}`),
    check('fixture:digest-host', group, /^[0-9a-f]{64}$/.test(digest), `宿主算的 sha256=${digest ? `${digest.slice(0, 16)}…（${digest.length} 位）` : '缺失'}`),
    check(
      'fixture:untrusted-before',
      group,
      exe.trusted === false && (instance.executableTrust ?? null) === null,
      `trusted=${exe.trusted ?? '缺字段'} executableTrust=${instance.executableTrust === undefined ? '缺字段' : JSON.stringify(instance.executableTrust)}`,
    ),
  ];
}

/** 写回信任记录后，宿主自己复算并认账（trusted=true 是宿主得出的结论，不是我们自说自话） */
export function checkTrustSeeded(envelope) {
  const group = 'trust';
  if (envelope?.ok !== true || envelope.value === null || typeof envelope.value !== 'object') {
    const error = envelope?.error ?? {};
    return [check('trust:inspect', group, false, `写信任后复检失败：code=${error.code ?? 'null'} message=${String(error.message ?? '').slice(0, 140)}`)];
  }
  const exe = envelope.value.executable ?? {};
  const trust = envelope.value.instance?.executableTrust ?? null;
  return [
    check('trust:host-confirms', group, exe.trusted === true, `宿主复检 trusted=${exe.trusted ?? '缺字段'}（摘要与记录逐字相等）`),
    check('trust:changed-flag', group, exe.changedSinceTrust === false, `changedSinceTrust=${exe.changedSinceTrust ?? '缺字段'}`),
    check(
      'trust:approved-by',
      group,
      trust !== null && trust.approvedBy === FIXTURE_APPROVED_BY,
      `approvedBy=${trust?.approvedBy ?? '缺失'}（可辨认的夹具值，不冒充 native-dialog）`,
    ),
    check('trust:sha-recorded', group, trust !== null && trust.sha256 === exe.sha256, `记录 sha256 ${trust?.sha256 ? `${String(trust.sha256).slice(0, 12)}…` : '缺失'} / 现算 ${exe.sha256 ? `${String(exe.sha256).slice(0, 12)}…` : '缺失'}`),
  ];
}

/** 能起：返回 running + pid + sessionId，且进程表里同一 pid 在列 */
export function checkStartRunning(envelope, { instanceId, processList = null } = {}) {
  const group = 'lifecycle';
  if (envelope?.ok !== true || envelope.value === null || typeof envelope.value !== 'object') {
    const error = envelope?.error ?? {};
    return [check('lifecycle:start-ok', group, false, `launcher_start 失败：code=${error.code ?? 'null'} message=${String(error.message ?? '').slice(0, 160)}`)];
  }
  const value = envelope.value;
  const pid = value.pid;
  const entries = Array.isArray(processList) ? processList.filter((entry) => entry?.instanceId === instanceId) : [];
  const listed = entries.find((entry) => entry.pid === pid) ?? null;
  return [
    check('lifecycle:start-ok', group, true, `state=${value.state ?? '?'} pid=${pid ?? '—'}`),
    check('lifecycle:start-state', group, value.state === 'running', `state=${value.state ?? '缺字段'}（期望 running）`),
    check('lifecycle:start-pid', group, Number.isInteger(pid) && pid > 0, `pid=${pid ?? '空'}（期望正整数，0/空 = 没真起）`),
    check('lifecycle:start-session', group, typeof value.sessionId === 'string' && value.sessionId.length > 0, `sessionId=${value.sessionId ?? '缺字段'}`),
    check(
      'lifecycle:start-listed',
      group,
      listed !== null && listed.state === 'running',
      Array.isArray(processList)
        ? `process_list 里 ${entries.length} 条本实例；同 pid 条目=${listed ? `state=${listed.state}` : '无'}`
        : '进程表不可读',
    ),
  ];
}

/** 树真的起过（否则"没有孙进程残留"是空话）：夹具孙进程镜像名在 tasklist 里至少一条 */
export function checkTreeAlive({ taskList, imageName, pid } = {}) {
  const group = 'lifecycle';
  const rows = rowsByImage(taskList, imageName);
  const own = (Array.isArray(taskList) ? taskList : []).filter((row) => row?.pid === pid);
  return [
    check('lifecycle:tree-alive', group, rows.length >= 1, `孙进程 ${imageName} 在 tasklist 里 ${rows.length} 条（pid=${rows.map((row) => row.pid).join(',') || '—'}）`),
    check('lifecycle:fixture-pid-alive', group, own.length === 1, `夹具 pid=${pid ?? '空'} 在 tasklist 里 ${own.length} 条`),
  ];
}

/** 能停：exited + pid 清空 + 锁文件清掉 + 进程树一个不剩 */
export function checkStopClean({ envelope, pid, lockExists, taskList, imageName } = {}) {
  const group = 'lifecycle';
  const base = [];
  if (envelope?.ok !== true || envelope.value === null || typeof envelope.value !== 'object') {
    const error = envelope?.error ?? {};
    base.push(check('lifecycle:stop-ok', group, false, `launcher_stop 失败：code=${error.code ?? 'null'} message=${String(error.message ?? '').slice(0, 160)}`));
  } else {
    base.push(check('lifecycle:stop-ok', group, true, `state=${envelope.value.state ?? '?'} exitReason=${envelope.value.exitReason ?? '—'} exitCode=${envelope.value.exitCode ?? '—'}`));
    base.push(check('lifecycle:stop-state', group, envelope.value.state === 'exited', `state=${envelope.value.state ?? '缺字段'}（期望 exited）`));
    base.push(check('lifecycle:stop-pid-cleared', group, envelope.value.pid === null || envelope.value.pid === undefined, `pid=${envelope.value.pid ?? '空'}（收尸后应为空）`));
    base.push(
      check(
        'lifecycle:stop-exit-reason',
        group,
        typeof envelope.value.exitReason === 'string' && envelope.value.exitReason.length > 0,
        `exitReason=${envelope.value.exitReason ?? '缺字段'}（killed = 走杀树那条路；user = WM_CLOSE 后自退）`,
      ),
    );
  }
  const rows = Array.isArray(taskList) ? taskList : [];
  const stillThere = rows.filter((row) => row?.pid === pid);
  base.push(check('lifecycle:stop-pid-gone', group, rows.length > 0 && stillThere.length === 0, `tasklist ${rows.length} 行，夹具 pid=${pid ?? '空'} 命中 ${stillThere.length} 条`));
  const leftovers = rowsByImage(rows, imageName);
  base.push(
    check(
      'lifecycle:stop-tree-gone',
      group,
      rows.length > 0 && leftovers.length === 0,
      leftovers.length === 0 ? `孙进程 ${imageName} 已清零（${rows.length} 行全表可见）` : `孙进程残留：${leftovers.map((row) => row.pid).join(',')}`,
    ),
  );
  base.push(check('lifecycle:stop-lock-cleared', group, lockExists === false, `running.lock ${lockExists ? '仍在盘上' : '已清'}`));
  return base;
}

/** 日志泵：会话表里有本场会话（且属于本实例） */
export function checkLogSessions(envelope, { sessionId, instanceId } = {}) {
  const group = 'logs';
  if (envelope?.ok !== true || !Array.isArray(envelope.value)) {
    const error = envelope?.error ?? {};
    return [check('logs:sessions', group, false, `launcher_log_sessions 失败：code=${error.code ?? 'null'} message=${String(error.message ?? '').slice(0, 140)}`)];
  }
  const sessions = envelope.value;
  const found = sessions.find((session) => session?.id === sessionId) ?? null;
  return [
    check('logs:sessions', group, sessions.length > 0, `${sessions.length} 场会话`),
    check('logs:session-present', group, found !== null, `sessionId=${sessionId ?? '空'} ${found === null ? '不在会话表里' : '在列'}`),
    check('logs:session-instance', group, found !== null && found.instanceId === instanceId, `会话归属 instanceId=${found?.instanceId ?? '缺字段'}`),
  ];
}

/** 日志泵：尾段有块、且内容含夹具打印的标记串 */
export function checkLogContent({ tailEnvelope, marker } = {}) {
  const group = 'logs';
  if (tailEnvelope?.ok !== true || tailEnvelope.value === null || typeof tailEnvelope.value !== 'object') {
    const error = tailEnvelope?.error ?? {};
    return [check('logs:tail', group, false, `launcher_log_tail 失败：code=${error.code ?? 'null'} message=${String(error.message ?? '').slice(0, 140)}`)];
  }
  const page = tailEnvelope.value;
  const text = logTextOf(page.chunks);
  const hit =
    text.utf8.includes(String(marker)) || text.latin1.includes(String(marker)) || (text.gbk ?? '').includes(String(marker));
  // 诊断样本优先用 GBK（cmd / ping 的中文错误串是 OEM 代码页），退回 utf8
  const sample = (text.gbk ?? text.utf8).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 160);
  return [
    check('logs:chunks', group, Array.isArray(page.chunks) && page.chunks.length > 0, `chunks=${Array.isArray(page.chunks) ? page.chunks.length : 0} 路=${text.streams.join('/') || '—'} bytes=${text.bytes}`),
    check('logs:marker', group, hit, `标记「${marker}」${hit ? '命中' : '未命中'}；样本=${sample || '(空)'}`),
  ];
}

/** 日志泵收尾：本场会话已记结束时间 + stdout 字节数 > 0（泵在进程退出后把最后一块写完） */
export function checkLogPumpFinished(envelope, { sessionId } = {}) {
  const group = 'logs';
  if (envelope?.ok !== true || !Array.isArray(envelope.value)) {
    const error = envelope?.error ?? {};
    return [check('logs:finished', group, false, `收尾复检失败：code=${error.code ?? 'null'} message=${String(error.message ?? '').slice(0, 140)}`)];
  }
  const session = envelope.value.find((item) => item?.id === sessionId) ?? null;
  return [
    check('logs:finished-ended', group, session !== null && typeof session.endedAt === 'string' && session.endedAt.length > 0, `endedAt=${session?.endedAt ?? '缺'}（泵已收尾）`),
    check('logs:finished-bytes', group, session !== null && Number(session.stdoutBytes) > 0, `stdoutBytes=${session?.stdoutBytes ?? '缺'} stderrBytes=${session?.stderrBytes ?? '缺'}`),
  ];
}

/** 未信任夹具：start 必须报 `LAUNCHER_TRUST_REQUIRED`（信任只能由宿主对话框给出） */
export function checkTrustRequired(envelope) {
  const group = 'trust';
  const id = 'trust-required';
  if (envelope?.ok === true) {
    return [check(`${id}:rejected`, group, false, `未信任实例竟然启动成功：${JSON.stringify(envelope.value)?.slice(0, 160)}`)];
  }
  const error = envelope?.error ?? {};
  return [
    check(`${id}:rejected`, group, true, '已拒绝（没有绕过信任）'),
    check(`${id}:code`, group, error.code === 'LAUNCHER_TRUST_REQUIRED', `code=${error.code ?? 'null'}（期望 LAUNCHER_TRUST_REQUIRED）`),
    check(`${id}:retryable`, group, error.retryable === true, `retryable=${error.retryable === undefined ? '缺字段' : error.retryable}（信任可重新确认 ⇒ 应为 true）`),
    check(`${id}:message-human`, group, typeof error.message === 'string' && /[\u4e00-\u9fa5]/.test(error.message), `message=${String(error.message ?? '').slice(0, 120)}`),
    check(`${id}:no-panic`, group, error.panic !== true, error.panic ? '命中 panic 特征' : '无 panic 特征'),
  ];
}

/** 拒绝之后进程表里不许出现"假装在跑"的本实例 */
export function checkNoRunAfterRefusal(envelope, instanceId) {
  const group = 'trust';
  if (envelope?.ok !== true || !Array.isArray(envelope.value)) {
    return [check('trust:no-run', group, false, '进程表不可读')];
  }
  const entry = envelope.value.find((item) => item?.instanceId === instanceId) ?? null;
  const running = entry !== null && entry.state === 'running';
  return [
    check('trust:no-run', group, !running && (entry === null || entry.pid === null || entry.pid === undefined), entry === null ? '进程表里没有本实例（干净）' : `state=${entry.state} pid=${entry.pid ?? '空'}`),
  ];
}

/**
 * `LAUNCHER_PLATFORM_UNSUPPORTED` 的报文形状（码 + 中文人话 + retryable 字段在）。
 * 本机 Windows 上进程闸恒放行，故经 overlay 闸取这份形状（见 `platformUnsupportedReading`）。
 */
export function checkPlatformErrorShape(envelope) {
  const id = 'platform-shape';
  if (envelope?.ok === true) {
    return [check(`${id}:rejected`, id, false, 'overlay 隔离竟然创建成功（P2 未落地却放行）')];
  }
  const error = envelope?.error ?? {};
  return [
    check(`${id}:code`, id, error.code === EXPECTED_CODES.platformUnsupported, `code=${error.code ?? 'null'}（期望 ${EXPECTED_CODES.platformUnsupported}）`),
    check(`${id}:message-human`, id, typeof error.message === 'string' && /[\u4e00-\u9fa5]/.test(error.message), `message=${String(error.message ?? '').slice(0, 120)}`),
    check(`${id}:retryable-field`, id, typeof error.retryable === 'boolean', `retryable=${error.retryable === undefined ? '缺字段' : error.retryable}（字段必须存在）`),
    check(`${id}:no-panic`, id, error.panic !== true, error.panic ? '命中 panic 特征' : '无 panic 特征'),
  ];
}

/** 夹具批次能不能在本机跑（cmd.exe 复制 + CREATE_NO_WINDOW + Job 杀树 ⇒ 只有 Windows） */
export function platformFixturePlan({ platform = process.platform } = {}) {
  if (platform === 'win32') return { run: true, skipReason: null };
  return {
    run: false,
    skipReason: `本机 ${platform}：夹具要复制 cmd.exe、走 CREATE_NO_WINDOW 与 Job 杀树语义，只有 Windows 这条通道；夹具批次 SKIP（不伪造）`,
  };
}

/** "平台不支持的人话"这条判据在本机是否可测（Windows 上进程闸不可达 ⇒ SKIP 并说明） */
export function platformUnsupportedReading({ platform = process.platform } = {}) {
  if (platform !== 'win32') return { verdict: 'check', reason: null };
  return {
    verdict: 'skip',
    reason:
      '本机是 Windows：process.rs 的 platform_gate 恒放行，LAUNCHER_PLATFORM_UNSUPPORTED（进程托管）在本机不可达；' +
      '只用 overlay 闸核同一码的报文形状，不伪造平台',
  };
}

function isInsideOrEqual(root, target, platform = process.platform) {
  const norm = (value) => {
    const resolved = path.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const base = norm(root);
  const full = norm(target);
  return full === base || full.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`);
}

/**
 * 清场清单（删什么、以及**拒绝删什么**）。
 * 两条守卫：实例目录必须在隔离 appData 的 `launcher/instances/` 之下；游戏根必须在
 * `os.tmpdir()` 之下且目录名带夹具前缀。任一条不满足 ⇒ `ok:false`，调用方按红处理且不删。
 */
export function cleanupPlan({ appDataDir, instanceIds = [], gameRoot = null, keep = false, tmpRoot = os.tmpdir() } = {}) {
  if (keep) return { ok: true, kept: true, targets: [], reason: '--keep：夹具与临时游戏根留在现场（排查用）' };
  const instancesDir = path.join(String(appDataDir ?? ''), 'launcher', 'instances');
  const targets = [];
  for (const id of instanceIds) {
    const dir = path.join(instancesDir, String(id ?? ''));
    if (!isInsideOrEqual(instancesDir, dir)) {
      return { ok: false, kept: false, targets: [], reason: `实例目录不在隔离 appData 的 instances 目录之下（${dir}）——拒绝删除` };
    }
    targets.push({ kind: 'instance', path: dir });
  }
  if (gameRoot !== null && gameRoot !== undefined) {
    const resolved = path.resolve(gameRoot);
    if (!isInsideOrEqual(tmpRoot, resolved)) {
      return { ok: false, kept: false, targets: [], reason: `游戏根不在临时目录内（${resolved}，tmp=${tmpRoot}）——拒绝删除` };
    }
    if (!path.basename(resolved).startsWith(FIXTURE_PREFIX)) {
      return { ok: false, kept: false, targets: [], reason: `游戏根目录名不是夹具前缀（${path.basename(resolved)}）——拒绝删除` };
    }
    targets.push({ kind: 'game-root', path: resolved });
  }
  return { ok: true, kept: false, targets, reason: '' };
}

/** 清场落到盘上的证据（`exists` 可注入，纯函数面才好测） */
export function checkDiskGone({ targets = [], exists = (p) => fs.existsSync(p) } = {}) {
  const group = 'cleanup';
  const list = Array.isArray(targets) ? targets : [];
  if (list.length === 0) return [check('cleanup:gone', group, false, '清场清单是空的（没有可证明的东西）')];
  return list.map((target) =>
    check(
      `cleanup:gone:${target.kind}:${path.basename(String(target.path))}`,
      group,
      exists(target.path) !== true,
      `${target.kind} ${target.path} ${exists(target.path) === true ? '仍在盘上' : '已删除'}`,
    ),
  );
}

/** 实例表回到播种前：长度相等且不再含夹具 id */
export function checkCleanup({ baseline, after, ids = [] } = {}) {
  const group = 'cleanup';
  const before = Array.isArray(baseline) ? baseline : null;
  const list = Array.isArray(after) ? after : null;
  if (before === null || list === null) {
    return [check('cleanup:list', group, false, `清场后读数不是数组（基线=${before === null ? '非数组' : before.length}，清场后=${list === null ? '非数组' : list.length}）`)];
  }
  const leftovers = list
    .map((entry) => (entry !== null && typeof entry === 'object' ? entry.id ?? null : null))
    .filter((id) => typeof id === 'string' && ids.includes(id));
  return [
    check('cleanup:count', group, list.length === before.length, `实例表 ${before.length} → ${list.length}（播种前 → 清场后）`),
    check('cleanup:no-fixture', group, leftovers.length === 0, leftovers.length === 0 ? '夹具 id 已从实例表消失' : `残留：${leftovers.join(',')}`),
  ];
}

/** 失败归类（报告里「红在哪一层」）：channel / contract / negative / side-effect / fixture / lifecycle / logs / trust / platform / cleanup / runner */
export function classifyFailure(assertion) {
  const group = String(assertion?.group ?? '');
  if (group === 'channel') return 'channel';
  if (group === 'readonly') return 'contract';
  if (group === 'negative-start' || group === 'negative-create') return 'negative';
  if (group === 'side-effect') return 'side-effect';
  if (group === 'fixture' || group === 'trust' || group === 'lifecycle' || group === 'logs' || group === 'platform' || group === 'cleanup') {
    return group;
  }
  return 'runner';
}

/** 分组统计 + 失败清单（报告与读数行都从这一处取数） */
export function groupAssertions(assertions = []) {
  const list = Array.isArray(assertions) ? assertions : [];
  const groups = [];
  for (const entry of list) {
    let group = groups.find((item) => item.group === entry.group);
    if (group === undefined) {
      group = { group: entry.group, total: 0, passed: 0 };
      groups.push(group);
    }
    group.total += 1;
    if (entry.ok === true) group.passed += 1;
  }
  const failing = list
    .filter((entry) => entry.ok !== true)
    .map((entry) => ({
      id: entry.id,
      group: entry.group,
      bucket: classifyFailure(entry),
      detail: entry.detail,
    }));
  const passed = list.filter((entry) => entry.ok === true).length;
  return { total: list.length, passed, failed: list.length - passed, groups, failing };
}

/** 一行可抄进状态文件的读数（命令 / rc / 耗时 / 断言数） */
export function summarizeRun({ command, rc, elapsedMs, tally, mode = '?', bootMs = null } = {}) {
  const t = tally ?? { total: 0, passed: 0, failed: 0 };
  const boot = typeof bootMs === 'number' && bootMs >= 0 ? ` boot=${Math.round(bootMs)}ms` : '';
  return (
    `[launcher-smoke] cmd="${command ?? '?'}" rc=${rc} elapsed=${Math.round(elapsedMs ?? 0)}ms ` +
    `assertions=${t.total} passed=${t.passed} failed=${t.failed} mode=${mode}${boot}`
  );
}

/** 解析读数行（release-gate 的 `parse` 复用这一处，不在两处手抄正则） */
export function parseReadingLine(text = '') {
  const match =
    /\[launcher-smoke\]\s+cmd="([^"]*)"\s+rc=(\d+)\s+elapsed=(\d+)ms\s+assertions=(\d+)\s+passed=(\d+)\s+failed=(\d+)\s+mode=(\S+?)(?:\s+boot=(\d+)ms)?\s*$/.exec(
      String(text),
    );
  if (match === null) return { parsed: false };
  return {
    parsed: true,
    command: match[1],
    rc: Number(match[2]),
    elapsedMs: Number(match[3]),
    assertions: Number(match[4]),
    passed: Number(match[5]),
    failed: Number(match[6]),
    mode: match[7],
    bootMs: match[8] === undefined ? null : Number(match[8]),
  };
}

/** 解析 SKIP 行（rc=2 的原因；release-gate 用它把「通道不可用」改判成 SKIP） */
export function parseSkipLine(text = '') {
  const match = /\[launcher-smoke\] SKIP reason=(.+)$/m.exec(String(text));
  return match === null ? null : match[1].trim();
}

/* ------------------------------------------------------------------ *
 * 通道层（真壳会话 / CDP / 起壳与收尾）
 * ------------------------------------------------------------------ */

function readSessionFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    return raw !== null && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function identifierFromConfig(session) {
  const file = session?.tauriConfigTemp;
  if (typeof file !== 'string' || file.length === 0) return null;
  try {
    const conf = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return typeof conf.identifier === 'string' ? conf.identifier : null;
  } catch {
    return null;
  }
}

async function pickVitePort() {
  if (!(await portOpen(1420))) return 1420;
  for (let port = 1430; port < 1500; port += 1) if (!(await portOpen(port))) return port;
  return 1420;
}

function killTree(pid) {
  if (typeof pid !== 'number' || pid <= 0) return;
  if (IS_WINDOWS) spawnSync(`taskkill /PID ${pid} /T /F`, { shell: true, stdio: 'ignore' });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }
}

/** `--start`：后台起一台 `debug-cli shell --isolate`，等会话文件出现（= CDP 就绪 + 调试面在场） */
async function startShell({ budgetMs, verbose }) {
  const vitePort = await pickVitePort();
  const tail = [];
  const tmp = os.tmpdir();
  const child = spawn(process.execPath, [CLI, 'shell', '--isolate'], {
    cwd: REPO,
    // TMP/TEMP/TMPDIR 换 Windows 形态：Git-Bash 的 `/tmp` 会让 MSVC link.exe 报 LNK1104
    env: {
      ...process.env,
      TMP: tmp,
      TEMP: tmp,
      TMPDIR: tmp,
      KOJO_SMOKE_VITE_PORT: String(vitePort),
      KOJO_DEBUG_SHELL_BOOT_MS: String(budgetMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const eat = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const text = line.trim();
      if (text.length === 0) continue;
      tail.push(text);
      if (tail.length > 60) tail.shift();
      if (verbose) console.error(`[shell] ${text}`);
    }
  };
  child.stdout.on('data', eat);
  child.stderr.on('data', eat);
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    if (exited !== null) {
      return { ok: false, child, reason: `真壳在就绪前退出（code=${exited.code} signal=${exited.signal ?? '-'}）`, tail };
    }
    const session = readSessionFile();
    // 会话文件出现 ≠ 壳还活着：debug-cli 的 `exit` 处理也会落一份 session.json（壳刚死时那扇门
    // 还在），2026-10-26 实测过一次"5.6 s 就绪 + CDP fetch failed"的假就绪 ⇒ 再验一次 CDP 端口。
    if (session !== null && session.mode === 'shell' && (await portOpen(Number(session.cdpPort)))) {
      return { ok: true, child, session, bootMs: Date.now() - started, vitePort };
    }
    await sleep(500);
  }
  return { ok: false, child, reason: `真壳 ${Math.round(budgetMs / 1000)}s 内没就绪（CDP 上没出现本 vite 端口的页面）`, tail };
}

async function stopShellIfStarted(child, keep) {
  // 先让 debug-cli 按会话收（pid 树 + 端口兜底 + killProcessesMarked 本会话目录）
  const session = readSessionFile();
  if (session !== null) {
    spawnSync(process.execPath, [CLI, 'stop'], { cwd: REPO, stdio: 'ignore', windowsHide: true });
  }
  if (!keep && child !== null) killTree(child.pid);
}

/* ------------------------------------------------------------------ *
 * 探针编排
 * ------------------------------------------------------------------ */

async function probeInvoke(cdp, cmd, args = {}) {
  const raw = await cdp.evalJs(buildInvokeExpression(cmd, args), 30000);
  return normalizeEnvelope(raw);
}

/* ------------------------- 夹具的磁盘面（只在隔离 appData / 临时目录） ------------------------- */

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

/** 读 JSON：不存在 ⇒ `{ text:null, value:null, missing:true }`；存在但读/解析失败 ⇒ `error` 非空（fail-closed） */
function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { text: null, value: null, missing: true, error: null };
    return { text: null, value: null, missing: false, error: String(err?.message ?? err) };
  }
  try {
    return { text, value: JSON.parse(text), missing: false, error: null };
  } catch (err) {
    return { text, value: null, missing: false, error: `JSON 解析失败：${String(err?.message ?? err)}` };
  }
}

/** 临时游戏根 + 两个 cmd.exe 副本（真游戏盘一个字节都不碰） */
function seedFixtureFiles(names) {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const source = path.join(systemRoot, 'System32', 'cmd.exe');
  const gameRoot = path.join(os.tmpdir(), names.gameRootName);
  if (!fs.existsSync(source)) throw new Error(`找不到夹具母本：${source}`);
  fs.rmSync(gameRoot, { recursive: true, force: true });
  fs.mkdirSync(gameRoot, { recursive: true });
  const copies = [names.exe, names.childExe].map((name) => {
    const dest = path.join(gameRoot, name);
    fs.copyFileSync(source, dest);
    return { name, dest, size: fs.statSync(dest).size };
  });
  return { gameRoot, source, copies };
}

/** `tasklist` 全表（一次拿齐，之后按 pid / 镜像名做纯过滤） */
function readTaskList() {
  if (!IS_WINDOWS) return { ok: false, rows: [], detail: '非 Windows 没有 tasklist' };
  const out = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], {
    encoding: 'utf-8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const rows = parseTasklistCsv(out.stdout ?? '');
  return {
    ok: out.status === 0 && rows.length > 0,
    rows,
    detail: out.status === 0 ? `${rows.length} 行` : `rc=${out.status} ${String(out.stderr ?? '').slice(0, 160)}`,
  };
}

/** 轮询到 `check` 真为止（返回最后一次读数；超时也返回，不抛——红由断言负责） */
async function pollUntil(read, check, { timeoutMs = 10_000, intervalMs = 300 } = {}) {
  const started = Date.now();
  let last = await read();
  while (Date.now() - started < timeoutMs) {
    if (check(last) === true) return last;
    await sleep(intervalMs);
    last = await read();
  }
  return last;
}

/**
 * L9 联调批：夹具实例播种 → 真进程起停 → 日志泵 → 失败路径 → 清场。
 *
 * 全程只写两个地方：隔离 appData（实例清单 / 注册表 / 日志 / 锁）与 `os.tmpdir()` 下的
 * 临时游戏根。清场放在 `finally` 里：中途任何一步炸了，夹具与临时目录照样删干净
 * （`--keep` 除外，那是排查用的显式保留）。
 */
async function runFixtureProbes(cdp, { appDataDir, keep = false, baseline = null } = {}) {
  const assertions = [];
  const skips = [];
  const readings = {
    platform: process.platform,
    token: null,
    ids: null,
    gameRoot: null,
    exe: null,
    pid: null,
    sessionId: null,
    logSample: null,
    treeBeforeStop: null,
    lockAfterStop: null,
    instanceCounts: { baseline: Array.isArray(baseline) ? baseline.length : null, afterSeed: null, afterCleanup: null },
  };

  const fixturePlan = platformFixturePlan();
  if (!fixturePlan.run) {
    skips.push({ id: 'fixture:platform', group: 'fixture', reason: fixturePlan.skipReason });
    return { assertions, readings, skips };
  }
  if (!Array.isArray(baseline)) {
    skips.push({
      id: 'fixture:baseline',
      group: 'fixture',
      reason: '实例表基线不是数组——播种 / 清场没有对拍基准，夹具整批 SKIP（readonly 那条已经红了，先修它）',
    });
    return { assertions, readings, skips };
  }

  const token = fixtureToken();
  const names = fixtureNames(token);
  const ids = [names.ids.trusted, names.ids.untrusted];
  const [trustedId, untrustedId] = ids;
  const trusted = fixtureLayout(appDataDir, trustedId);
  const untrusted = fixtureLayout(appDataDir, untrustedId);
  readings.token = token;
  readings.ids = names.ids;

  // 注册表的原始字节：清场时要么还原条目、要么（本来不存在）删掉文件恢复"首次运行"
  const registryOriginal = readJsonFile(trusted.registryFile);
  let gameRoot = null;
  let cleanupDone = false;

  const cleanup = async () => {
    if (cleanupDone) return null;
    cleanupDone = true;
    const plan = cleanupPlan({ appDataDir, instanceIds: ids, gameRoot, keep });
    const result = { plan, removed: [], errors: [], kept: keep };
    if (!plan.ok) {
      result.errors.push(plan.reason);
      return result;
    }
    if (plan.kept) {
      skips.push({ id: 'cleanup:keep', group: 'cleanup', reason: plan.reason });
      return result;
    }
    // 先摘注册表条目再删目录：反过来一旦删一半失败，会留下"注册表指向不存在清单"的库
    const fresh = readJsonFile(trusted.registryFile);
    const stripped = stripFixtureRegistry(fresh.value, ids);
    if (!stripped.ok) {
      result.errors.push(stripped.reason);
    } else if (stripped.registry === null || registryOriginal.missing) {
      try {
        fs.rmSync(trusted.registryFile, { force: true });
        result.removed.push(trusted.registryFile);
      } catch (err) {
        result.errors.push(`删注册表失败：${String(err?.message ?? err)}`);
      }
    } else {
      try {
        writeJsonFile(trusted.registryFile, stripped.registry);
      } catch (err) {
        result.errors.push(`写回注册表失败：${String(err?.message ?? err)}`);
      }
    }
    for (const target of plan.targets) {
      try {
        fs.rmSync(target.path, { recursive: true, force: true });
        result.removed.push(target.path);
      } catch (err) {
        result.errors.push(`删 ${target.path} 失败：${String(err?.message ?? err)}`);
      }
    }
    return result;
  };

  try {
    /* ---- 1) 夹具文件 + 清单播种 ---- */
    const files = seedFixtureFiles(names);
    gameRoot = files.gameRoot;
    readings.gameRoot = gameRoot;
    readings.exe = names.exe;
    assertions.push(
      check(
        'fixture:exe-copies',
        'fixture',
        files.copies.every((copy) => copy.size > 0),
        `${files.copies.map((copy) => `${copy.name}=${copy.size}B`).join('，')}（母本 ${files.source}）`,
      ),
    );

    if (registryOriginal.error !== null) {
      assertions.push(check('fixture:registry-readable', 'fixture', false, `隔离 appData 的 registry.json 读不懂：${registryOriginal.error}——不覆盖，整批作废`));
      throw new Error('registry.json 不可读，放弃播种');
    }

    const now = new Date().toISOString();
    const args = fixtureArgs(names.childExe, names.marker);
    const instanceTrusted = buildFixtureInstance({ id: trustedId, name: `夹具-已信任-${token}`, gameRoot, relativePath: names.exe, args, now });
    const instanceUntrusted = buildFixtureInstance({ id: untrustedId, name: `夹具-未信任-${token}`, gameRoot, relativePath: names.exe, args, now });
    writeJsonFile(trusted.manifestFile, instanceTrusted);
    writeJsonFile(untrusted.manifestFile, instanceUntrusted);

    const merged = mergeFixtureRegistry(registryOriginal.value, [instanceRegistryEntry(instanceTrusted), instanceRegistryEntry(instanceUntrusted)]);
    if (!merged.ok) {
      assertions.push(check('fixture:registry-merge', 'fixture', false, merged.reason));
      throw new Error(merged.reason);
    }
    writeJsonFile(trusted.registryFile, merged.registry);
    assertions.push(check('fixture:registry-write', 'fixture', true, `registry.json rev=${merged.registry.rev}，实例 ${merged.registry.instances.length} 条`));

    const seedList = await probeInvoke(cdp, 'launcher_instance_list');
    readings.instanceCounts.afterSeed = Array.isArray(seedList.value) ? seedList.value.length : null;
    assertions.push(...checkFixtureSeeded({ baseline, afterSeed: seedList.value, ids }));
    if (Array.isArray(seedList.value) && ids.some((id) => !seedList.value.some((entry) => entry?.id === id))) {
      // 播种没生效 ⇒ 后面每条都在测空气（实例表读不出清单时宿主会整体报错）
      throw new Error(`播种未生效：实例表里没有 ${ids.join(' / ')}`);
    }

    /* ---- 2) 信任记录：哈希只认宿主算的那份 ---- */
    const inspected = await probeInvoke(cdp, 'launcher_instance_get', { instanceId: trustedId });
    assertions.push(...checkManifestDigest(inspected));
    const absolutePath = inspected.ok ? String(inspected.value?.executable?.absolutePath ?? '') : '';
    const hostDigest = inspected.ok ? String(inspected.value?.executable?.sha256 ?? '') : '';
    if (!/^[0-9a-f]{64}$/.test(hostDigest) || absolutePath.length === 0) {
      throw new Error('宿主没有给出可用摘要，无法播种信任记录');
    }
    const size = fs.statSync(absolutePath).size;
    const trustedInstance = attachTrust(instanceTrusted, { sha256: hostDigest, size, approvedAt: now });
    writeJsonFile(trusted.manifestFile, trustedInstance);
    const reInspected = await probeInvoke(cdp, 'launcher_instance_get', { instanceId: trustedId });
    assertions.push(...checkTrustSeeded(reInspected));

    /* ---- 3) 能起 ---- */
    const started = await probeInvoke(cdp, 'launcher_start', { instanceId: trustedId });
    const pid = started.ok ? started.value?.pid : null;
    readings.pid = typeof pid === 'number' ? pid : null;
    readings.sessionId = started.ok ? (started.value?.sessionId ?? null) : null;
    const processListAfterStart = await probeInvoke(cdp, 'launcher_process_list');
    assertions.push(...checkStartRunning(started, { instanceId: trustedId, processList: processListAfterStart.value }));
    if (readings.pid === null || readings.sessionId === null) {
      throw new Error('启动没有给出 pid / sessionId，后面的停止与日志没有靶子');
    }

    /* ---- 4) 日志泵（会话 + 尾段含标记串） ---- */
    const sessionsEnvelope = await probeInvoke(cdp, 'launcher_log_sessions', { instanceId: trustedId });
    assertions.push(...checkLogSessions(sessionsEnvelope, { sessionId: readings.sessionId, instanceId: trustedId }));
    const tailEnvelope = await pollUntil(
      async () => probeInvoke(cdp, 'launcher_log_tail', { instanceId: trustedId, query: { sessionId: readings.sessionId } }),
      (envelope) => {
        if (envelope?.ok !== true) return false;
        const text = logTextOf(envelope.value?.chunks);
        return text.utf8.includes(names.marker) || text.latin1.includes(names.marker);
      },
      { timeoutMs: 10_000 },
    );
    assertions.push(...checkLogContent({ tailEnvelope, marker: names.marker }));
    if (tailEnvelope.ok) {
      const text = logTextOf(tailEnvelope.value?.chunks);
      readings.logSample = text.utf8.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120);
      // 失败分诊用：OEM（GBK）解出来的那份中文，红的时候能直接读因
      readings.logSampleGbk = (text.gbk ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 240);
    }

    /* ---- 5) 树真的起过（孙进程在场），然后能停 ---- */
    const treeBefore = await pollUntil(
      () => readTaskList(),
      (table) => rowsByImage(table.rows, names.childExe).length >= 1,
      { timeoutMs: 8_000 },
    );
    readings.treeBeforeStop = {
      ok: treeBefore.ok,
      detail: treeBefore.detail,
      child: rowsByImage(treeBefore.rows, names.childExe).map((row) => row.pid),
    };
    assertions.push(...checkTreeAlive({ taskList: treeBefore.rows, imageName: names.childExe, pid: readings.pid }));

    const stopped = await probeInvoke(cdp, 'launcher_stop', { instanceId: trustedId, force: false });
    const treeAfter = await pollUntil(
      () => readTaskList(),
      (table) => rowsByImage(table.rows, names.childExe).length === 0 && !table.rows.some((row) => row.pid === readings.pid),
      { timeoutMs: 8_000 },
    );
    const lockAfterStop = fs.existsSync(trusted.lockFile);
    readings.lockAfterStop = lockAfterStop;
    readings.treeAfterStop = {
      ok: treeAfter.ok,
      detail: treeAfter.detail,
      child: rowsByImage(treeAfter.rows, names.childExe).map((row) => row.pid),
      fixturePid: treeAfter.rows.filter((row) => row.pid === readings.pid).length,
    };
    assertions.push(
      ...checkStopClean({
        envelope: stopped,
        pid: readings.pid,
        lockExists: lockAfterStop,
        taskList: treeAfter.rows,
        imageName: names.childExe,
      }),
    );

    const sessionsAfterStop = await pollUntil(
      async () => probeInvoke(cdp, 'launcher_log_sessions', { instanceId: trustedId }),
      (envelope) => {
        const session = Array.isArray(envelope?.value) ? envelope.value.find((item) => item?.id === readings.sessionId) : null;
        return session !== null && Number(session.stdoutBytes) > 0 && typeof session.endedAt === 'string';
      },
      { timeoutMs: 8_000 },
    );
    assertions.push(...checkLogPumpFinished(sessionsAfterStop, { sessionId: readings.sessionId }));

    /* ---- 6) 失败路径 A：未信任夹具 ⇒ TRUST_REQUIRED ---- */
    const refused = await probeInvoke(cdp, 'launcher_start', { instanceId: untrustedId });
    assertions.push(...checkTrustRequired(refused));
    const processListAfterRefusal = await probeInvoke(cdp, 'launcher_process_list');
    assertions.push(...checkNoRunAfterRefusal(processListAfterRefusal, untrustedId));

    /* ---- 7) 失败路径 B：平台不支持（本机不可达 ⇒ SKIP；只核报文形状） ---- */
    const platformReading = platformUnsupportedReading();
    if (platformReading.verdict === 'skip') {
      skips.push({ id: 'platform:start-gate', group: 'platform', reason: platformReading.reason });
      const overlayCreate = await probeInvoke(cdp, 'launcher_instance_create', {
        request: {
          name: `夹具-overlay-${token}`,
          sourceRoot: gameRoot,
          adapterId: FIXTURE_ADAPTER_ID,
          gameId: FIXTURE_ADAPTER_ID,
          isolation: 'overlay',
        },
        profile: { executable: { relativePath: names.exe, args: [], windowMode: FIXTURE_WINDOW_MODE } },
      });
      assertions.push(...checkPlatformErrorShape(overlayCreate));
    } else {
      const startOnUnsupported = await probeInvoke(cdp, 'launcher_start', { instanceId: MISSING_INSTANCE_ID });
      assertions.push(...checkPlatformErrorShape(startOnUnsupported));
    }
  } catch (error) {
    assertions.push(check('fixture:batch', 'fixture', false, `夹具批次中断：${String(error?.message ?? error).slice(0, 300)}`));
  } finally {
    const result = await cleanup();
    if (result !== null) {
      readings.cleanup = result;
      if (result.errors.length > 0) assertions.push(check('cleanup:run', 'cleanup', false, result.errors.join('；')));
      else if (!result.kept) {
        assertions.push(
          check(
            'cleanup:run',
            'cleanup',
            result.removed.length > 0,
            result.removed.length === 0 ? '没有任何东西被删除' : `已删 ${result.removed.length} 项（实例目录 ${ids.length} + 临时游戏根 + 注册表条目）`,
          ),
        );
        assertions.push(...checkDiskGone({ targets: result.plan.targets }));
      }
      const afterList = await probeInvoke(cdp, 'launcher_instance_list').catch(() => ({ ok: false, value: null }));
      readings.instanceCounts.afterCleanup = Array.isArray(afterList.value) ? afterList.value.length : null;
      if (result.kept) {
        skips.push({ id: 'cleanup:assert', group: 'cleanup', reason: '--keep：实例表未回基线，清场对拍不适用' });
      } else {
        assertions.push(...checkCleanup({ baseline, after: afterList.value, ids }));
      }
    }
  }

  return { assertions, readings, skips };
}

/**
 * 顺序执行探针，返回断言表 + 频道读数。前四组**写动作一条都不发**（两条负向都在
 * 「不可能落地」的路径上）；第五组是 L9 夹具批次，写入只落隔离 appData 与临时游戏根。
 */
async function runProbes(cdp, { appDataDir, keep = false }) {
  const assertions = [];
  const readings = { appDataDir, lists: {} };

  const before = await probeInvoke(cdp, 'launcher_instance_list');
  assertions.push(...checkListReading(READONLY_PROBES[0], before));
  readings.lists.launcher_instance_list = Array.isArray(before.value) ? before.value.length : null;

  for (const probe of READONLY_PROBES.slice(1)) {
    const envelope = await probeInvoke(cdp, probe.cmd);
    assertions.push(...checkListReading(probe, envelope));
    readings.lists[probe.cmd] = Array.isArray(envelope.value) ? envelope.value.length : null;
  }

  const startEnvelope = await probeInvoke(cdp, 'launcher_start', { instanceId: MISSING_INSTANCE_ID });
  assertions.push(...checkStartMissingInstance(startEnvelope));
  readings.startMissingInstance = startEnvelope.ok ? null : startEnvelope.error;

  // 缺 profile：request 指向隔离 appData 下的空目录（就算真被处理也落不到游戏根，且缺参数必被拒）
  const createEnvelope = await probeInvoke(cdp, 'launcher_instance_create', {
    request: {
      name: 'gate-smoke',
      sourceRoot: path.join(appDataDir, 'gate-smoke-source-probe'),
      adapterId: 'gate-smoke',
      gameId: 'gate-smoke',
      isolation: 'shared',
    },
  });
  assertions.push(...checkCreateMissingProfile(createEnvelope));
  readings.createMissingProfile = createEnvelope.ok ? null : createEnvelope.error;

  const after = await probeInvoke(cdp, 'launcher_instance_list');
  assertions.push(...checkNoSideEffect(before.value, after.value));

  /* ---- L9 联调批：夹具实例 + 真进程生命周期（文件头 5 件事各落到断言组）----
   * 1 能起（lifecycle）：launcher_start → state=running + pid 非 0 + process_list 同 pid 在列；
   * 2 能停（lifecycle）：launcher_stop → exited / pid 清空 / running.lock 清掉 / tasklist 里
   *   夹具 pid 与孙进程镜像名双双清零（停之前先证明树真的起过，否则"没有残留"是空话）；
   * 3 信任（trust）：未信任夹具 ⇒ LAUNCHER_TRUST_REQUIRED + retryable + 中文人话；
   * 4 日志泵（logs）：log_sessions 有本场会话、log_tail 尾段含夹具打印的标记串、
   *   收尾后 endedAt 与 stdoutBytes 都有值；
   * 5 人话（platform）：本机 Windows 上进程闸不可达 ⇒ SKIP 并说明，只经 overlay 闸核
   *   LAUNCHER_PLATFORM_UNSUPPORTED 的报文形状（码 / 中文 message / retryable 字段）。
   */
  const fixture = await runFixtureProbes(cdp, { appDataDir, keep, baseline: before.value });
  assertions.push(...fixture.assertions);
  readings.fixture = fixture.readings;

  return { assertions, readings, skips: fixture.skips };
}

function printAssertions(assertions) {
  for (const entry of assertions) {
    const mark = entry.ok ? 'ok  ' : 'FAIL';
    console.log(`  [${mark}] ${entry.group}/${entry.id} — ${entry.detail}`);
  }
}

/**
 * SKIP 条目（**不计入断言、不影响 rc**，但也绝不混进 pass 数里假装绿）。
 * 单独一行一行的 `[SKIP]`：读数行格式受 `parseReadingLine` 钉住，不能塞进去。
 */
function printSkips(skips = []) {
  for (const item of skips) console.log(`  [SKIP] ${item.group}/${item.id} — ${item.reason}`);
}

async function writeReport(report, outPath) {
  const dest = path.resolve(outPath);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, JSON.stringify(report, null, 2), 'utf-8');
  return dest;
}

function usage() {
  return [
    '用法：node tools/launcher-smoke.mjs [--attach | --start] [选项]',
    '',
    '  --attach           驱动当期真壳会话（默认；先 node tools/debug-cli.mjs shell --isolate）',
    '  --start            自己起一台 shell --isolate（起完驱动，收工自己 stop；--keep 保留现场）',
    '  --keep             不清场（排查用）',
    '  --boot-ms <n>      起壳预算毫秒（默认 600000；冷 cargo 构建会久）',
    '  --out <json>       读数落盘路径（默认 <会话目录>/launcher-smoke.json）',
    '  --verbose          透传真壳日志',
    '',
    '退出码：0 全绿 / 1 断言红 / 2 通道不可用（SKIP，原因随行打印）',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

function parseFlags(argv = []) {
  const flags = { start: false, attach: false, keep: false, verbose: false, help: false, bootMs: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--start') flags.start = true;
    else if (arg === '--attach') flags.attach = true;
    else if (arg === '--keep') flags.keep = true;
    else if (arg === '--verbose') flags.verbose = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--boot-ms') flags.bootMs = Number(argv[++i]);
    else if (arg === '--out') flags.out = argv[++i];
    else if (arg.startsWith('--boot-ms=')) flags.bootMs = Number(arg.slice('--boot-ms='.length));
    else if (arg.startsWith('--out=')) flags.out = arg.slice('--out='.length);
  }
  if (!Number.isFinite(flags.bootMs) || flags.bootMs <= 0) {
    flags.bootMs = Number(process.env.KOJO_LAUNCHER_SMOKE_BOOT_MS ?? 600000);
    if (!Number.isFinite(flags.bootMs) || flags.bootMs <= 0) flags.bootMs = 600000;
  }
  return flags;
}

export async function main(argv = process.argv.slice(2), { command = null } = {}) {
  const started = Date.now();
  const flags = parseFlags(argv);
  const commandText = command ?? `node tools/launcher-smoke.mjs ${argv.join(' ')}`.trim();

  if (flags.help) {
    console.log(usage());
    return 0;
  }

  const assertions = [];
  let child = null;
  let bootMs = null;
  let session = null;
  let cdp = null;

  const skip = async (reason, mode = '?') => {
    console.error(`[launcher-smoke] SKIP reason=${reason}`);
    const tally = groupAssertions(assertions);
    if (assertions.length > 0) printAssertions(assertions);
    const line = summarizeRun({ command: commandText, rc: 2, elapsedMs: Date.now() - started, tally, mode, bootMs });
    console.log(line);
    await writeReport(
      {
        tool: 'launcher-smoke',
        ranAt: new Date().toISOString(),
        repoRoot: REPO,
        result: 'SKIP',
        reason,
        mode,
        bootMs,
        assertions,
        tally,
        reading: line,
      },
      flags.out ?? path.join(SESS_DIR, 'launcher-smoke.json'),
    ).catch(() => {});
    return 2;
  };

  try {
    if (flags.start) {
      const booted = await startShell({ budgetMs: flags.bootMs, verbose: flags.verbose });
      child = booted.child;
      bootMs = booted.ok ? booted.bootMs : null;
      if (!booted.ok) {
        const tail = booted.tail.slice(-8).join(' | ');
        return await skip(`${booted.reason}${tail ? `；日志尾：${tail}` : ''}`);
      }
      session = booted.session;
      console.log(`[launcher-smoke] 真壳就绪：${Math.round(bootMs)}ms（mode=shell，CDP :${session.cdpPort}）`);
    } else {
      session = readSessionFile();
      if (session === null) {
        return await skip(`本工作树没有在跑的会话（${SESSION_FILE}）——先 shell --isolate，或用 --start`);
      }
    }

    const mode = session.mode ?? 'web';
    if (mode !== 'shell') return await skip(`mode=${mode}（launcher_* 只在真壳）`, mode);

    let page = null;
    try {
      page = await cdpPage(session.cdpPort, session.vitePort);
    } catch (error) {
      return await skip(`CDP :${session.cdpPort} 不可达（${String(error?.message ?? error).slice(0, 160)}）`, mode);
    }
    if (page === null) return await skip(`CDP :${session.cdpPort} 上没有本 vite 端口（${session.vitePort}）的页面`, mode);

    cdp = await new Cdp(page.webSocketDebuggerUrl).connect();
    try {
      await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 15000, label: '__kojoDebug' });
    } catch {
      cdp.close();
      return await skip('页面里没有调试面（是不是用 --no-debug-api 起的 pristine boot？）', mode);
    }
    const pageMode = await cdp.evalJs('__kojoDebug.mode');
    assertions.push(check('channel:page-mode', 'channel', pageMode === 'shell', `page mode=${pageMode}`));

    const appDataEnvelope = await probeInvoke(cdp, 'app_data_dir');
    const appDataDir = appDataEnvelope.ok && typeof appDataEnvelope.value === 'string' ? appDataEnvelope.value : '';
    const identifier = identifierFromConfig(session);
    const isolation = isIsolatedSession({ mode, identifier, appDataDir });
    assertions.push(check('channel:isolated-appdata', 'channel', isolation.ok, isolation.reason));
    if (!isolation.ok) {
      cdp.close();
      return await skip(isolation.reason, mode);
    }
    assertions.push(check('channel:cdp', 'channel', true, `${page.url.slice(0, 120)}`));

    const probed = await runProbes(cdp, { appDataDir, keep: flags.keep });
    assertions.push(...probed.assertions);
    const skips = Array.isArray(probed.skips) ? probed.skips : [];
    cdp.close();
    cdp = null;

    const tally = groupAssertions(assertions);
    printAssertions(assertions);
    printSkips(skips);
    const rc = tally.failed === 0 ? 0 : 1;
    const line = summarizeRun({ command: commandText, rc, elapsedMs: Date.now() - started, tally, mode, bootMs });
    const fixture = probed.readings.fixture ?? {};
    console.log(
      `[launcher-smoke] 读数：instance/process/task = ${probed.readings.lists.launcher_instance_list ?? '?'}/` +
        `${probed.readings.lists.launcher_process_list ?? '?'}/${probed.readings.lists.launcher_task_list ?? '?'}；` +
        `appData=${appDataDir}`,
    );
    if (typeof fixture.token === 'string') {
      console.log(
        `[launcher-smoke] 夹具：token=${fixture.token} pid=${fixture.pid ?? '—'} session=${fixture.sessionId ?? '—'} ` +
          `实例表 baseline/afterSeed/afterCleanup = ${fixture.instanceCounts?.baseline ?? '?'}/` +
          `${fixture.instanceCounts?.afterSeed ?? '?'}/${fixture.instanceCounts?.afterCleanup ?? '?'}` +
          `；skip=${skips.length}`,
      );
    }
    if (tally.failed > 0) {
      for (const item of tally.failing) console.log(`  ✗ [${item.bucket}] ${item.id} — ${item.detail}`);
    }
    console.log(line);
    await writeReport(
      {
        tool: 'launcher-smoke',
        ranAt: new Date().toISOString(),
        repoRoot: REPO,
        result: rc === 0 ? 'PASS' : 'FAIL',
        mode,
        bootMs,
        session: { cdpPort: session.cdpPort, vitePort: session.vitePort, identifier, appDataDir },
        readings: probed.readings,
        assertions,
        skips,
        tally,
        reading: line,
      },
      flags.out ?? path.join(SESS_DIR, 'launcher-smoke.json'),
    ).catch(() => {});
    return rc;
  } catch (error) {
    const tally = groupAssertions(assertions);
    const line = summarizeRun({ command: commandText, rc: 1, elapsedMs: Date.now() - started, tally, mode: session?.mode ?? '?', bootMs });
    console.error(`[launcher-smoke] 未捕获异常：${String(error?.stack ?? error).slice(0, 1200)}`);
    console.log(line);
    return 1;
  } finally {
    if (cdp !== null) {
      try {
        cdp.close();
      } catch {
        /* 已断 */
      }
    }
    if (flags.start) await stopShellIfStarted(child, flags.keep);
  }
}

function isDirectInvocation() {
  if (process.argv[1] === undefined) return false;
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectInvocation()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[launcher-smoke] 入口异常：${String(error?.stack ?? error)}`);
      process.exitCode = 1;
    });
}
