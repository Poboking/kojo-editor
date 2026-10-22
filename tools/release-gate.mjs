#!/usr/bin/env node
/**
 * K2-RELEASE-GATE · 发布门槛的一次性真跑器（零新依赖、不写盘）。
 *
 * 设计稿 §16.10 R9.1–R9.6 的机器可跑面：把「双 typecheck / 解耦审计 / conformance /
 * 两池测试 / 可选 app build」串成一条命令，逐项记录读数，最后统一给 `RESULT: PASS|FAIL`。
 *
 * 两条硬纪律：
 * - **失败不被洗成 warning**：任何一项 `rc !== 0`（或超时）都进 `failed`，最终 exit 1；
 * - **失败隔离**：一项红了继续跑后面的（`--fail-fast` 才提前停），这样一次就能拿到全量账。
 *
 * K2-RELEASE-CI 加的三个**可选项**（默认不跑，缺前置记 SKIP 并写清原因，绝不静默）：
 * - `corpus`：先 `node tools/corpus.mjs --print` 探语料在不在位；**缺语料 = SKIP 不是 FAIL**
 *   （CI/无游戏机的常态），但 `KOJO_CORPUS_DIR` 指了坏路径（探针 rc=2）仍按硬失败算；
 * - `smoke-dom` / `smoke-ipc`：桌面壳 DOM / 真实 IPC 冒烟（`--shell` 或 `--only` 才跑），
 *   需桌面会话 + WebView2，CI 上必然跑不起来。
 * 这三项都**不改变**核心 4+2 项的默认账：CI 快速档就是 `--skip-tests`，全量档只多两池。
 *
 * 结构：
 * - `createReleaseGate({ run })` = 纯执行编排（runner 注入，单测用假 runner）；
 * - `createProcessRunner()` = 真 spawn + 超时杀进程树 + 捕获 stdout/stderr；
 * - 读数是**解析真实输出**得到的（tsc 错误数 / 审计插件数 / conformance JSON / vitest 汇总），
 *   解析失败只标 `parsed:false`，绝不因此把失败洗白（判定始终以 rc 为准）。
 *
 * 用法与退出码见 `USAGE`；`node tools/release-gate.mjs --help`。
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE = process.execPath;
const IS_WINDOWS = process.platform === 'win32';

/** 每项最多保留的输出行数（JSON 报告里的 `tail`） */
export const TAIL_LINES = 40;
/** 单个流最多缓存的字符数；超出保留尾部（汇总行总在最后） */
const MAX_CAPTURE_CHARS = 4 * 1024 * 1024;

const TIMEOUT = Object.freeze({
  typecheck: 5 * 60 * 1000,
  audit: 3 * 60 * 1000,
  conformance: 5 * 60 * 1000,
  tests: 30 * 60 * 1000,
  build: 10 * 60 * 1000,
  corpusProbe: 60 * 1000,
  corpus: 30 * 60 * 1000,
  smoke: 10 * 60 * 1000,
});

const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;

/** 去掉 ANSI，统一换行；读数与 tail 都走这里 */
export function stripAnsi(text = '') {
  return String(text).replace(ANSI, '').replace(/\r\n?/g, '\n');
}

function lastLines(text, limit = TAIL_LINES) {
  const lines = stripAnsi(text)
    .split('\n')
    .filter((line) => line.trim().length > 0);
  return lines.slice(-limit).join('\n');
}

function readAll(raw) {
  return `${raw?.stdout ?? ''}\n${raw?.stderr ?? ''}`;
}

/** tsc：数 `error TSxxxx`，并按 `file(line,col): error` 去重文件 */
export function parseTypecheckOutput(text = '') {
  const clean = stripAnsi(text);
  const errors = [...clean.matchAll(/error TS\d+/g)].length;
  const files = new Set();
  for (const match of clean.matchAll(/^(.+?)\(\d+,\d+\):\s+error TS\d+/gm)) files.add(match[1].trim());
  return { errors, files: files.size };
}

/** audit-decoupling：成功行给插件数，失败行给违规数；认不出就 null（不猜 0） */
export function parseAuditOutput(text = '') {
  const clean = stripAnsi(text);
  const plugins = /插件（(\d+)\s*个）/.exec(clean);
  const violations = /发现\s*(\d+)\s*处违规/.exec(clean);
  return {
    plugins: plugins ? Number(plugins[1]) : null,
    violations: violations ? Number(violations[1]) : /全部通过/.test(clean) ? 0 : null,
  };
}

/** conformance CLI 的 `--json` 报告（只取发布门槛关心的读数） */
export function parseConformanceJson(text = '') {
  const clean = stripAnsi(text);
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) return { parsed: false };
  let report;
  try {
    report = JSON.parse(clean.slice(start, end + 1));
  } catch {
    return { parsed: false };
  }
  const cases = Array.isArray(report.cases) ? report.cases : [];
  return {
    parsed: true,
    adapter: typeof report.adapter === 'string' ? report.adapter : null,
    files: Array.isArray(report.files) ? report.files.length : 0,
    cases: cases.length,
    passed: cases.filter((item) => item?.ok === true).length,
    failed: cases.filter((item) => item?.ok !== true).length,
    failures: Array.isArray(report.failures) ? report.failures.length : 0,
    contractOk: report.readings?.contract?.ok ?? null,
  };
}

/** vitest 汇总行：`Test Files 667 passed | 21 skipped (688)` / `Tests ...` */
export function parseVitestSummary(text = '') {
  const clean = stripAnsi(text);
  const filesLine = clean.match(/^\s*Test Files\s+(.+)$/m)?.[1] ?? null;
  const testsLine = clean.match(/^\s*Tests\s+(.+)$/m)?.[1] ?? null;
  if (filesLine === null && testsLine === null) return { parsed: false };

  const parseLine = (line) => {
    const counts = { passed: 0, failed: 0, skipped: 0, todo: 0 };
    for (const match of line.matchAll(/(\d+)\s+(passed|failed|skipped|todo)/g)) {
      counts[match[2]] = Number(match[1]);
    }
    const total = /\((\d+)\)/.exec(line);
    return { ...counts, total: total ? Number(total[1]) : null };
  };
  const duration = /^\s*Duration\s+([\d.]+)\s*(ms|s)\b/m.exec(clean);
  const durationMs = duration ? Number(duration[1]) * (duration[2] === 's' ? 1000 : 1) : null;
  return {
    parsed: true,
    files: filesLine === null ? null : parseLine(filesLine),
    tests: testsLine === null ? null : parseLine(testsLine),
    durationMs: durationMs === null ? null : Math.round(durationMs),
  };
}

/** vite build：`✓ built in 26.5s` + 产物条数（dist/ 行） */
export function parseBuildOutput(text = '') {
  const clean = stripAnsi(text);
  const built = /built in\s+([\d.]+)\s*(ms|s)/.exec(clean);
  const assets = clean.split('\n').filter((line) => /\bdist[\\/]/.test(line)).length;
  if (built === null) return { parsed: false, assets };
  return {
    parsed: true,
    builtInMs: Math.round(Number(built[1]) * (built[2] === 's' ? 1000 : 1)),
    assets,
  };
}

/**
 * 桌面壳冒烟（`smoke-tauri-dom.mjs` / `smoke-tauri-ipc.mjs`）的读数。
 * 两者口径不同，认得出哪种就记哪种（认不出返回 parsed:false，不猜绿）：
 * - DOM：`[smoke] checks: {...} exited=false` + 结尾 `✅ tauri DOM smoke passed` / `❌ … failed`；
 * - IPC：`================ 冒烟汇总 ================` + `共 N 项；FAIL M` + 同款 ✅/❌ 结尾行。
 * 判定仍以 rc 为准（✅ 只用于读数，不能把 rc=1 洗成 PASS）。
 */
export function parseSmokeOutput(text = '') {
  const clean = stripAnsi(text);
  const total = /共\s*(\d+)\s*项[；;]\s*FAIL\s*(\d+)/.exec(clean);
  const domChecks = /\[smoke\] checks:\s*\{/.test(clean);
  const green = /✅\s*tauri\s*(?:DOM|IPC)\s*(?:smoke\s+passed|冒烟全部通过)/.test(clean);
  const red = /❌\s*tauri\s*(?:DOM|IPC)\s*(?:smoke\s+failed|冒烟存在失败项)/.test(clean);
  if (!green && !red && total === null && !domChecks) return { parsed: false };
  let failedChecks = total ? Number(total[2]) : null;
  let checks = null;
  const json = /\[smoke\] checks:\s*(\{[^}]*\})\s*exited=/.exec(clean);
  if (json) {
    try {
      const parsed = JSON.parse(json[1]);
      checks = Object.keys(parsed).length;
      if (failedChecks === null) failedChecks = Object.values(parsed).filter((value) => value === false).length;
    } catch {
      checks = null;
    }
  }
  return {
    parsed: true,
    verdict: green ? 'passed' : red ? 'failed' : null,
    checks,
    total: total ? Number(total[1]) : null,
    failed: failedChecks,
  };
}

function firstLine(text, limit = 220) {
  const line = stripAnsi(text)
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)[0] ?? '';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

function nodeItem(id, rel, args, kind, timeoutMs, parse, extra = {}) {
  return {
    id,
    kind,
    cmd: `node ${rel}${args.length > 0 ? ` ${args.join(' ')}` : ''}`,
    command: NODE,
    args: [path.join(ROOT, rel), ...args],
    shell: false,
    timeoutMs,
    parse,
    ...extra,
  };
}

/** Windows 上 pnpm 只有 .cmd/.ps1 垫片：经 cmd.exe 起，避免 Node `shell:true` 的 DEP0190 */
function pnpmInvocation(args) {
  if (!IS_WINDOWS) return { command: 'pnpm', args: [...args] };
  const quoted = args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg));
  return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `pnpm ${quoted.join(' ')}`] };
}

function pnpmItem(id, args, kind, timeoutMs, parse, extra = {}) {
  const invocation = pnpmInvocation(args);
  return {
    id,
    kind,
    cmd: `pnpm ${args.join(' ')}`,
    command: invocation.command,
    args: invocation.args,
    shell: false,
    timeoutMs,
    parse,
    ...extra,
  };
}

/** AGENTS §三 的真实语料集成冒烟（语料由 `KOJO_SMOKE_PROJECT` 指路，测试文件自身 skipIf 守门） */
export const CORPUS_INTEGRATION = 'packages/kernel/tests/integration-plugins.test.ts';

/**
 * 语料前置探针：`node tools/corpus.mjs --print`（AGENTS §三 的取值口径）。
 * 返回三态，**调用方必须区分「缺」与「坏」**：
 * - `{ skip }`  = 盘上无符合内容条件的语料（corpus.mjs rc=1）或打印为空 ⇒ SKIP，不是 FAIL；
 * - `{ fail }`  = 探针超时 / 起不来 / `KOJO_CORPUS_DIR` 指了坏路径（rc=2，corpus.mjs 自己定的硬失败）；
 * - `{ env, readings }` = 在位 ⇒ 把目录塞进 `KOJO_SMOKE_PROJECT`，读数记下选了哪份。
 */
export async function probeCorpus({ run, cwd = ROOT } = {}) {
  if (typeof run !== 'function') throw new TypeError('probeCorpus 需要注入 run({id,command,args,...})');
  const started = Date.now();
  let raw;
  try {
    raw = await run({
      id: 'corpus-probe',
      command: NODE,
      args: [path.join(ROOT, 'tools/corpus.mjs'), '--print'],
      cwd,
      timeoutMs: TIMEOUT.corpusProbe,
      shell: false,
    });
  } catch (error) {
    return {
      fail: {
        rc: 127,
        tail: `[release-gate] 语料探针抛错：${errorText(error)}`,
        readings: { phase: 'corpus-probe', corpusPresent: null, probeMs: Date.now() - started },
      },
    };
  }
  const timedOut = raw?.timedOut === true;
  // runner 没回报结果 ⇒ 不能当成「缺语料」（那会静默降级成 SKIP）
  if (raw === undefined || raw === null) {
    return {
      fail: {
        rc: 127,
        tail: '[release-gate] 语料探针 runner 未返回结果',
        readings: { phase: 'corpus-probe', corpusPresent: null, probeMs: Date.now() - started },
      },
    };
  }
  const rc = timedOut ? 124 : normalizeRc(raw?.rc);
  const stdout = String(raw?.stdout ?? '');
  const stderr = String(raw?.stderr ?? '');
  const probeMs = Math.max(0, Date.now() - started);
  const dir = stripAnsi(stdout).trim();

  if (timedOut) {
    return {
      fail: {
        rc,
        tail: `${stdout}\n${stderr}`,
        readings: { phase: 'corpus-probe', corpusPresent: null, probeMs, timeout: true },
      },
    };
  }
  // rc=1 = 盘上确实没有（CI / 无游戏机的常态）⇒ SKIP；不许把「缺」当失败，也不许静默。
  if (rc === 1) {
    return {
      skip: `语料不在位（node tools/corpus.mjs --print rc=1）：${firstLine(stderr) || '盘上未发现符合内容条件的语料目录'}`,
    };
  }
  // rc=2 = KOJO_CORPUS_DIR / --corpus 指了不成立的路径：这是配置错，不是缺，按硬失败算。
  if (rc !== 0) {
    return {
      fail: {
        rc,
        tail: `${stdout}\n${stderr}`,
        readings: { phase: 'corpus-probe', corpusPresent: null, probeMs },
      },
    };
  }
  if (dir.length === 0) {
    return { skip: '语料探针 rc=0 但 --print 未打印目录（tools/corpus.mjs 输出异常）' };
  }
  return {
    env: { KOJO_SMOKE_PROJECT: dir },
    readings: { phase: 'corpus-probe', corpusPresent: true, corpusDir: dir, probeMs },
  };
}

/** 语料集成项：先探位，在位才跑 AGENTS §三 那条 vitest（缺位记 SKIP，不记 FAIL） */
function corpusItem() {
  const args = ['run', CORPUS_INTEGRATION];
  return {
    id: 'corpus',
    kind: 'test',
    optional: 'corpus',
    skipReason: '可选：需真实语料（未传 --corpus / --only=corpus）',
    cmd: `KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)" node node_modules/vitest/vitest.mjs ${args.join(' ')}`,
    command: NODE,
    args: [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), ...args],
    shell: false,
    timeoutMs: TIMEOUT.corpus,
    parse: (text) => parseVitestSummary(text),
    preflight: ({ run, cwd }) => probeCorpus({ run, cwd }),
  };
}

/**
 * 项清单 = 发布门槛的全部机器面。顺序即执行顺序（前 6 项是默认账，后 4 项可选）。
 * 可选性由 `optional` 声明（= 解锁开关名：build / corpus / shell），
 * `skipReason` 是默认不跑时写进报告的原因（SKIP 必须可解释）。
 * `smoke-dom` / `smoke-ipc` 需桌面会话 + WebView2，`corpus` 需真实游戏目录：
 * 三者在 CI / 无游戏机上「没得跑」而不是「跑挂了」，故只 SKIP。
 */
export const DEFAULT_ITEMS = Object.freeze([
  pnpmItem('typecheck-root', ['typecheck'], 'core', TIMEOUT.typecheck, (text) => parseTypecheckOutput(text)),
  pnpmItem('typecheck-app', ['--filter', '@kojo/app', 'typecheck'], 'core', TIMEOUT.typecheck, (text) =>
    parseTypecheckOutput(text),
  ),
  nodeItem('audit', 'tools/audit-decoupling.mjs', [], 'core', TIMEOUT.audit, (text) => parseAuditOutput(text)),
  nodeItem('conformance', 'tools/kojo-conformance.mjs', ['check', '--suite', '--json'], 'core', TIMEOUT.conformance, (text) =>
    parseConformanceJson(text),
  ),
  nodeItem('test-unit', 'node_modules/vitest/vitest.mjs', ['run', '--config', 'vitest.config.ts'], 'test', TIMEOUT.tests, (text) =>
    parseVitestSummary(text),
  ),
  nodeItem('test-perf', 'node_modules/vitest/vitest.mjs', ['run', '--config', 'vitest.perf.config.ts'], 'test', TIMEOUT.tests, (text) =>
    parseVitestSummary(text),
  ),
  pnpmItem(
    'build-app',
    ['--filter', '@kojo/app', 'build'],
    'build',
    TIMEOUT.build,
    (text) => parseBuildOutput(text),
    { optional: 'build', skipReason: '可选：未传 --build' },
  ),
  corpusItem(),
  nodeItem(
    'smoke-dom',
    'tools/smoke-tauri-dom.mjs',
    [],
    'shell',
    TIMEOUT.smoke,
    (text) => parseSmokeOutput(text),
    { optional: 'shell', skipReason: '可选：需桌面壳（未传 --shell / --only=smoke-dom）' },
  ),
  nodeItem(
    'smoke-ipc',
    'tools/smoke-tauri-ipc.mjs',
    [],
    'shell',
    TIMEOUT.smoke,
    (text) => parseSmokeOutput(text),
    { optional: 'shell', skipReason: '可选：需桌面壳（未传 --shell / --only=smoke-ipc）' },
  ),
]);

export const ITEM_IDS = Object.freeze(DEFAULT_ITEMS.map((item) => item.id));

export const USAGE = [
  '用法：node tools/release-gate.mjs [选项]',
  '',
  '选项：',
  '  --json             stdout 只输出机器可读 JSON（schemaVersion=1），不含人类文本',
  '  --only=<id,...>    只跑指定项（按项清单顺序执行，不是参数顺序；点名的可选项照跑）',
  '  --skip-tests       跳过 test-unit / test-perf / corpus（快速档；显式 --only 点名的仍会跑）',
  '  --fail-fast        首项失败后不再执行后续项（默认失败隔离：一项红继续跑）',
  '  --build            追加 build-app（默认不跑，构建耗时且非每次发布门槛必需）',
  '  --corpus           追加 corpus（先探语料在不在位；缺语料记 SKIP，不当失败）',
  '  --shell            追加 smoke-dom / smoke-ipc 两项桌面壳冒烟（需桌面会话 + WebView2）',
  '  -h, --help         显示本帮助',
  '',
  `项：${ITEM_IDS.join(', ')}`,
  '可选四项默认 SKIP 并记原因：build-app(--build) / corpus(--corpus) / smoke-dom,smoke-ipc(--shell)。',
  '',
  '退出码：0 = 全绿；1 = 有失败（含超时 / runner 异常）；2 = 用法错误',
].join('\n');

function addOnly(options, raw, errors) {
  const ids = String(raw)
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) {
    errors.push('--only= 需要至少一个项 id');
    return;
  }
  for (const id of ids) if (!options.only.includes(id)) options.only.push(id);
}

/** argv 只做解析，不执行；未知参数进 errors（调用方决定 exit 2） */
export function parseArgs(argv = []) {
  const options = {
    json: false,
    skipTests: false,
    failFast: false,
    build: false,
    corpus: false,
    shell: false,
    only: [],
    help: false,
  };
  const errors = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--skip-tests') options.skipTests = true;
    else if (arg === '--fail-fast') options.failFast = true;
    else if (arg === '--build') options.build = true;
    else if (arg === '--corpus') options.corpus = true;
    else if (arg === '--shell') options.shell = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--only') {
      const value = argv[index + 1];
      if (value === undefined) errors.push('--only 需要一个值');
      else {
        addOnly(options, value, errors);
        index += 1;
      }
    } else if (arg.startsWith('--only=')) addOnly(options, arg.slice('--only='.length), errors);
    else errors.push(`未知参数：${arg}`);
  }
  return { options, errors };
}

/**
 * 选项目：缺省 = 6 个核心项（其余 4 个可选，默认 SKIP 并带原因）。
 * - `--skip-tests` 去掉测试池（test-unit / test-perf / corpus），但**显式点名**的优先
 *   （`--only=test-unit --skip-tests` 仍跑，便于只跑单池）；
 * - `optional` 声明的开关（build / corpus / shell）打开才收可选段；`--only` 点名的**无视开关**
 *   （`--only=smoke-dom` 不带 `--shell` 也跑，便于单点复跑）。
 * 返回的 skipped 记录未跑项与原因，JSON/human 都直接消费。
 */
export function resolveSelectedItems({ only = [], skipTests = false, build = false, corpus = false, shell = false } = {}) {
  const unknown = only.filter((id) => !ITEM_IDS.includes(id));
  if (unknown.length > 0) {
    return { error: `未知项：${unknown.join(', ')}（可用项：${ITEM_IDS.join(', ')}）` };
  }
  const explicit = new Set(only);
  const unlocked = { build, corpus, shell };
  let selected = DEFAULT_ITEMS.filter((item) => only.length === 0 || explicit.has(item.id));
  if (skipTests) selected = selected.filter((item) => item.kind !== 'test' || explicit.has(item.id));
  selected = selected.filter((item) => explicit.has(item.id) || item.optional === undefined || unlocked[item.optional] === true);

  if (selected.length === 0) return { error: '没有可执行的项（检查 --only / --skip-tests）' };

  const skipped = DEFAULT_ITEMS.filter((item) => !selected.includes(item)).map((item) => ({
    id: item.id,
    reason:
      item.kind === 'test' && skipTests
        ? '--skip-tests'
        : item.optional !== undefined && unlocked[item.optional] !== true
          ? item.skipReason
          : '--only 未选中',
  }));
  return { items: selected, skipped };
}

function normalizeRc(value) {
  const rc = Number(value);
  return Number.isInteger(rc) && rc >= 0 ? rc : 1;
}

function errorText(error) {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/**
 * 纯执行编排：runner 由调用方注入（真跑用 `createProcessRunner()`，单测用假函数）。
 * runner 契约：`async ({ id, command, args, cwd, timeoutMs, shell, env? }) =>
 *   ({ rc, stdout, stderr, timedOut?, ms? })`。
 * runner 抛错 = rc 127；超时 = rc 124；两者都 FAIL，且不中断后续项（除 failFast）。
 *
 * 前置探针（`item.preflight`）跑在该项之前，能把一项**变成 SKIP**（缺前置）或**变成 FAIL**
 * （前置坏了）——两种都由项自己说清原因，编排层不改口径：
 *   `{ skip: reason }` / `{ fail: { rc, tail, readings } }` / `{ env, readings }`。
 */
export function createReleaseGate({ run, now = () => Date.now() } = {}) {
  if (typeof run !== 'function') throw new TypeError('createReleaseGate 需要注入 run({id,command,args,...})');

  async function preflightItem(item, cwd) {
    if (typeof item.preflight !== 'function') return null;
    try {
      return await item.preflight({ run, cwd });
    } catch (error) {
      return {
        fail: {
          rc: 127,
          tail: `[release-gate] 前置探针抛错：${errorText(error)}`,
          readings: { phase: 'preflight', preflightError: true },
        },
      };
    }
  }

  async function executeItem(item, cwd = ROOT) {
    const started = now();
    const prepared = await preflightItem(item, cwd);
    if (prepared !== null && typeof prepared === 'object') {
      if (typeof prepared.skip === 'string' && prepared.skip.length > 0) {
        return { skip: { id: item.id, reason: prepared.skip } };
      }
      if (prepared.fail !== undefined) {
        const failRc = normalizeRc(prepared.fail?.rc);
        const failReadings =
          prepared.fail?.readings !== null && typeof prepared.fail?.readings === 'object' ? prepared.fail.readings : {};
        return {
          result: {
            id: item.id,
            cmd: item.cmd,
            rc: failRc,
            ms: Math.max(0, now() - started),
            readings: { ...failReadings },
            tail: lastLines(String(prepared.fail?.tail ?? '')),
          },
          ok: false,
        };
      }
    }

    let raw;
    const request = {
      id: item.id,
      command: item.command,
      args: [...item.args],
      cwd,
      timeoutMs: item.timeoutMs,
      shell: item.shell,
    };
    if (prepared?.env !== undefined && prepared.env !== null) request.env = { ...prepared.env };
    try {
      raw = await run(request);
    } catch (error) {
      raw = { rc: 127, stdout: '', stderr: `[release-gate] runner 抛错：${errorText(error)}`, timedOut: false };
    }

    const timedOut = raw?.timedOut === true;
    const rc = timedOut ? 124 : normalizeRc(raw?.rc);
    const stdout = String(raw?.stdout ?? '');
    const stderr = String(raw?.stderr ?? '');
    let readings;
    try {
      readings = item.parse ? item.parse(readAll({ stdout, stderr }), rc) : {};
    } catch (error) {
      readings = { parsed: false, parseError: error instanceof Error ? error.message : String(error) };
    }
    if (readings === null || typeof readings !== 'object' || Array.isArray(readings)) readings = {};
    // 探针读数（如语料目录）垫在下面：命令自己的读数优先，但探针信息不许丢。
    if (prepared?.readings !== null && typeof prepared?.readings === 'object') {
      readings = { ...prepared.readings, ...readings };
    }
    if (timedOut) readings = { ...readings, timeout: true };

    const measured = Number(raw?.ms);
    const ms = Number.isFinite(measured) ? Math.max(0, Math.round(measured)) : Math.max(0, now() - started);
    return {
      result: { id: item.id, cmd: item.cmd, rc, ms, readings, tail: lastLines(`${stdout}\n${stderr}`) },
      ok: rc === 0 && !timedOut,
    };
  }

  async function execute(items, { cwd = ROOT, failFast = false } = {}) {
    const results = [];
    const failed = [];
    const skipped = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const outcome = await executeItem(item, cwd);
      // 前置不满足 ⇒ SKIP（不是 FAIL，也不静默：原因一路带到报告里）
      if (outcome.skip !== undefined) {
        skipped.push(outcome.skip);
        continue;
      }
      results.push(outcome.result);
      if (!outcome.ok) {
        failed.push(item.id);
        if (failFast && index + 1 < items.length) {
          for (const rest of items.slice(index + 1)) skipped.push({ id: rest.id, reason: '--fail-fast' });
          break;
        }
      }
    }
    return { items: results, failed, skipped };
  }

  return { executeItem, execute };
}

/** 真 runner：spawn + 超时杀进程树 + 捕获输出（不落盘）。`env` 为附加环境变量（语料项用） */
export function createProcessRunner({ spawnImpl = spawn, killTree, maxCaptureChars = MAX_CAPTURE_CHARS } = {}) {
  return function run({ command, args = [], cwd = ROOT, timeoutMs = 0, shell = false, env }) {
    return new Promise((resolve) => {
      const started = Date.now();
      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let settled = false;
      let timer = null;
      let graceTimer = null;

      const push = (stream, chunk) => {
        const text = String(chunk);
        if (stream === 'stdout') {
          stdout += text;
          if (stdout.length > maxCaptureChars) {
            stdout = stdout.slice(-maxCaptureChars);
            stdoutTruncated = true;
          }
        } else {
          stderr += text;
          if (stderr.length > maxCaptureChars) {
            stderr = stderr.slice(-maxCaptureChars);
            stderrTruncated = true;
          }
        }
      };

      const finish = (rc) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (graceTimer !== null) clearTimeout(graceTimer);
        resolve({
          rc,
          stdout,
          stderr,
          timedOut,
          ms: Date.now() - started,
          stdoutTruncated,
          stderrTruncated,
        });
      };

      let child;
      try {
        child = spawnImpl(command, args, {
          cwd,
          shell,
          windowsHide: true,
          detached: !IS_WINDOWS,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...(env ?? {}) },
        });
      } catch (error) {
        finish(127);
        return;
      }

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => push('stdout', chunk));
      child.stderr?.on('data', (chunk) => push('stderr', chunk));
      child.on('error', (error) => {
        push('stderr', `[release-gate] spawn 失败：${errorText(error)}\n`);
        finish(127);
      });
      child.on('close', (code) => finish(timedOut ? 124 : normalizeRc(code ?? 1)));

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            (killTree ?? defaultKillTree)(child.pid);
          } catch {
            /* 杀不动也要收尾：下面的 grace 会兜底 resolve */
          }
          graceTimer = setTimeout(() => finish(124), 3000);
        }, timeoutMs);
      }
    });
  };
}

function defaultKillTree(pid) {
  if (!pid) return;
  if (IS_WINDOWS) {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
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

/** 稳定 JSON：顶层与每项的键序固定，测试与 CI 可直接断言结构 */
export function formatReport(report, { json = false } = {}) {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  const lines = [];
  lines.push(
    `kojo release gate · ${report.items.length} 项 · ${report.result} · ${(report.durationMs / 1000).toFixed(1)}s`,
  );
  report.items.forEach((item, index) => {
    lines.push(
      `[${index + 1}/${report.items.length}] ${item.id} — ${item.rc === 0 ? 'PASS' : 'FAIL'} · ${item.ms}ms · rc=${item.rc}`,
    );
    if (Object.keys(item.readings).length > 0) lines.push(`      readings: ${JSON.stringify(item.readings)}`);
    if (item.rc !== 0 && item.tail.length > 0) {
      for (const line of item.tail.split('\n')) lines.push(`      | ${line}`);
    }
  });
  for (const entry of report.skipped) lines.push(`SKIP ${entry.id}（${entry.reason}）`);
  lines.push(`RESULT: ${report.result}`);
  if (report.failed.length > 0) lines.push(`failed: ${report.failed.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

/**
 * CLI 级入口（可测、不碰 process.exitCode）：解析 argv → 选项目 → 执行 → 格式化。
 * 返回 `{ code, report, text }`；帮助 `code=0`，用法错误 `code=2`（report=null）。
 */
export async function runReleaseGate({
  argv = [],
  run,
  cwd = ROOT,
  now = () => Date.now(),
  writeOut = (text) => void process.stdout.write(text),
  writeErr = (text) => void process.stderr.write(text),
} = {}) {
  const parsed = parseArgs(argv);
  if (parsed.options.help) {
    const text = `${USAGE}\n`;
    writeOut(text);
    return { code: 0, report: null, text };
  }
  if (parsed.errors.length > 0) {
    const text = `${parsed.errors.join('\n')}\n\n${USAGE}\n`;
    writeErr(text);
    return { code: 2, report: null, text };
  }

  const selected = resolveSelectedItems(parsed.options);
  if (selected.error) {
    const text = `${selected.error}\n\n${USAGE}\n`;
    writeErr(text);
    return { code: 2, report: null, text };
  }

  const runner = run ?? createProcessRunner();
  const gate = createReleaseGate({ run: runner, now });
  const started = now();
  const execution = await gate.execute(selected.items, { cwd, failFast: parsed.options.failFast });
  const durationMs = Math.max(0, Math.round(now() - started));
  const report = {
    tool: 'release-gate',
    schemaVersion: 1,
    result: execution.failed.length === 0 ? 'PASS' : 'FAIL',
    exitCode: execution.failed.length === 0 ? 0 : 1,
    durationMs,
    items: execution.items,
    failed: execution.failed,
    skipped: [...selected.skipped, ...execution.skipped],
  };
  const text = formatReport(report, { json: parsed.options.json });
  writeOut(text);
  return { code: report.exitCode, report, text };
}

function isDirectInvocation() {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  return path.resolve(invoked) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectInvocation()) {
  runReleaseGate({ argv: process.argv.slice(2) })
    .then(({ code }) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[release-gate] 未捕获异常：${errorText(error)}`);
      process.exitCode = 1;
    });
}
