#!/usr/bin/env node
/**
 * 启动器真壳冒烟（车道 GATE，2026-10-26）——把「启动器判据在真壳里的插入点」变成可执行脚本。
 *
 * 通道：只认**真桌面壳**（`node tools/debug-cli.mjs shell` 的会话：CDP + `?kojo-debug=api`）。
 * 页内 `__kojoDebug.invoke` 在 shell 形态下走**真 Tauri IPC**（= 产品同一条路）；web 调试宿
 * （`serve`）**没有**镜像 launcher_* 的 36 条命令，所以本工具在 web 会话上只 SKIP 并说明。
 *
 * 本批驱动的面（全部只读，或只碰隔离 appData）：
 * - 只读三条：`launcher_instance_list` / `launcher_process_list` / `launcher_task_list`——
 *   断言返回**数组**（空表 = 合法读数，不是错误）；
 * - 负向两条：`launcher_start` 给不存在的 instanceId ⇒ 结构化错误（带 `code`，不是 panic）；
 *   `launcher_instance_create` 缺 `profile` ⇒ **参数错误**（Tauri 反序列化层拒收，不是业务错误码）；
 * - 副作用：全部探针前后 `launcher_instance_list` 长度不变（证明"只读"不是口号）。
 *
 * 隔离（铁律 5 / PITFALLS）：不写任何游戏目录；真壳必须带 `--isolate`——这是 `debug-cli shell`
 * 既有的隔离方式（identifier 换成 `<原 identifier>.smoke`，宿主 appData 落在 `%APPDATA%\<id>.smoke`；
 * debug-cli 没有把 appData 搬进 `KOJO_DEBUG_HOME` 的能力，故本工具只认这一条）。会话自己的产物
 * （session.json / 本工具的读数 JSON）仍在 `<KOJO_DEBUG_HOME>/sessions/<树哈希>/`。
 * 会话没开隔离 ⇒ **直接 SKIP 并说明**，绝不「先跑跑看」；探针全在只读面与两条必然被拒的负向上，
 * 另用「实例表前后等长」对拍证明没有落地副作用。
 * `--start` 会把 TMP/TEMP/TMPDIR 换成 Windows 形态再起壳（Git-Bash 的 `TMP=/tmp` 会让 link.exe
 * 报 LNK1104，PITFALLS 既有条目），并挑一个空闲 vite 端口（1420 被占时不抢别人的 dev server）。
 *
 * 启动器判据的真壳插入点清单（本批只驱动「只读面 + 两条负向」；下面 5 件都要造夹具实例 + 起真进程）：
 * 1. 能起：ready + 已信任 ⇒ `launcher_start` 返回 running，`launcher_process_list` 出现 pid；
 * 2. 能停：`launcher_stop` 收尸到 exited、锁文件清掉、孙进程不残留（日志泵随进程退出）；
 * 3. 信任框：未信任 exe ⇒ `LAUNCHER_TRUST_REQUIRED`；信任框由**宿主**弹，JS 不能跳过；
 * 4. 日志泵：`launcher_log_sessions` / `launcher_log_tail` 有行、编码探测不破坏内容；
 * 5. 平台不支持时的人话：`LAUNCHER_PLATFORM_UNSUPPORTED` + 中文 message + `retryable` 存在。
 * （代码里的插入点 = `runProbes` 末尾那段 `L9 联调批插入点` 注释；5 件事各补一条断言即可。）
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
    let raw = '';
    if (e && typeof e === 'object') {
      code = typeof e.code === 'string' ? e.code : null;
      message = typeof e.message === 'string' ? e.message : '';
      try { raw = JSON.stringify(e); } catch { raw = String(e); }
    } else {
      message = String(e);
      raw = message;
    }
    return { ok: false, error: { code, message, raw } };
  }
})()`;
}

/** 错误归类：`launcher-code`（宿主结构化错误）/ `arg`（IPC 参数层）/ `string` / `unknown` */
export function normalizeError(raw) {
  const out = { code: null, message: '', kind: 'unknown', panic: false, raw: '' };
  if (raw === null || raw === undefined) return out;
  if (typeof raw === 'string') {
    out.message = raw;
    out.raw = raw;
    out.kind = ARG_ERROR_RE.test(raw) ? 'arg' : 'string';
  } else if (typeof raw === 'object') {
    out.code = typeof raw.code === 'string' && raw.code.trim().length > 0 ? raw.code.trim() : null;
    out.message = typeof raw.message === 'string' ? raw.message : '';
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

/** 失败归类（报告里「红在哪一层」）：channel / contract / negative / side-effect / runner */
export function classifyFailure(assertion) {
  const group = String(assertion?.group ?? '');
  if (group === 'channel') return 'channel';
  if (group === 'readonly') return 'contract';
  if (group === 'negative-start' || group === 'negative-create') return 'negative';
  if (group === 'side-effect') return 'side-effect';
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
    if (session !== null && session.mode === 'shell') {
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

/**
 * 顺序执行四组探针，返回断言表 + 频道读数。**写动作一条都不发**：
 * 两条负向都在「不可能落地」的路径上（查无实例 / 缺参数被 IPC 层拒收）。
 */
async function runProbes(cdp, { appDataDir }) {
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

  /* ---- L9 联调批插入点（夹具实例 + 真进程就位后，把文件头那 5 件事各写成一条断言接在这里）----
   * 1 能起：launcher_start(夹具实例) → state=running，process_list 里 pid 非 0；
   * 2 能停：launcher_stop → state=exited，再 process_list 不含它，锁文件已清；
   * 3 信任框：未信任夹具 ⇒ code=LAUNCHER_TRUST_REQUIRED（信任只能由宿主对话框给出）；
   * 4 日志泵：log_sessions 有本实例会话，log_read 首行非空且编码回读与盘上对拍；
   * 5 人话：platform_unsupported / retryable 字段齐全（非 Windows 或 overlay 场景）。
   * 断言组沿用 'negative-*' / 新增 'lifecycle'（classifyFailure 已把未知组归 runner，新增组须同时补归类）。
   */

  return { assertions, readings };
}

function printAssertions(assertions) {
  for (const entry of assertions) {
    const mark = entry.ok ? 'ok  ' : 'FAIL';
    console.log(`  [${mark}] ${entry.group}/${entry.id} — ${entry.detail}`);
  }
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

    const probed = await runProbes(cdp, { appDataDir });
    assertions.push(...probed.assertions);
    cdp.close();
    cdp = null;

    const tally = groupAssertions(assertions);
    printAssertions(assertions);
    const rc = tally.failed === 0 ? 0 : 1;
    const line = summarizeRun({ command: commandText, rc, elapsedMs: Date.now() - started, tally, mode, bootMs });
    console.log(
      `[launcher-smoke] 读数：instance/process/task = ${probed.readings.lists.launcher_instance_list ?? '?'}/` +
        `${probed.readings.lists.launcher_process_list ?? '?'}/${probed.readings.lists.launcher_task_list ?? '?'}；` +
        `appData=${appDataDir}`,
    );
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
