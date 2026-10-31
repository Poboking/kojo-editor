/**
 * 调试工具链一次性体检（2026-10-30 第三批）。
 *
 * 背景：`debug-cli` / `debug-server` / `debug-lib` 出问题时的症状高度相似——会话文件写一半、
 * 端口被上一次的壳占着、vite 预构建缓存与 lockfile 对不上、pid 记着但进程已经死了。
 * 以前每次都要 `cat session.json`、`netstat`、`ls node_modules/.vite` 逐个看；这里把七类
 * 判据一次跑完，给出 PASS/WARN/FAIL 与可复制的处置命令。
 *
 * 设计约束：
 *  ① **零依赖**（Node 内置 + 与 tools 其余脚本同口径的 ESM），Node ≥ 22；
 *  ② **每条检查都是纯函数**：fs / 端口探测 / 进程判活 / node 版本全部走注入，
 *     单测可以在 `mkdtemp` 的假仓库上跑，绝不碰真端口、真进程；
 *  ③ 只读：不删缓存、不杀进程、不写任何文件（fix 只给命令，由人决定执行）。
 *
 * 退出码：任一 FAIL ⇒ 1，否则 0（WARN 不算失败——它们都是「慢一点 / 需要人看一眼」，
 * 不是「现在就跑不起来」）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sessionDir } from './debug-lib.mjs';

/** 固定键序（--json 的消费方与单测都按这个顺序对账） */
export const CHECK_IDS = [
  'node-version',
  'repo-root',
  'session-file',
  'host-port',
  'cdp-port',
  'dist-build',
  'vite-cache',
  'stale-procs',
];

const NODE_MIN_MAJOR = 22;
const PORT_TIMEOUT_MS = 500;
const STOP_CMD = 'node tools/debug-cli.mjs stop';
const SERVE_CMD = 'node tools/debug-cli.mjs serve';

/** 统一构造检查项，键序固定为 id → level → detail → fix（无 fix 时**不写**该键） */
function check(id, level, detail, fix) {
  return fix ? { id, level, detail, fix } : { id, level, detail };
}

/** 把 Windows 反斜杠折成正斜杠，便于把路径塞进 shell 命令（fix 是给人复制的） */
function shellPath(p) {
  return String(p).replace(/\\/g, '/');
}

/* ------------------------------ 1. node-version ------------------------------ */

/**
 * 为什么是 FAIL：工具链（serve/shell/冒烟）已经在用 Node 22 的原生 WebSocket / `AbortSignal.timeout`，
 * 低于 22 不是「慢一点」，而是启动即抛 TypeError——所以低于门槛直接判死。
 */
export function checkNodeVersion(version) {
  const v = String(version ?? '').trim();
  const major = Number.parseInt(v.split('.')[0], 10);
  if (!Number.isFinite(major)) {
    return check('node-version', 'FAIL', `读不到 Node 版本（process.versions.node=${JSON.stringify(v)}）`);
  }
  if (major < NODE_MIN_MAJOR) {
    return check('node-version', 'FAIL', `当前 Node v${v}，要求 >= ${NODE_MIN_MAJOR}`);
  }
  return check('node-version', 'PASS', `v${v}（>= ${NODE_MIN_MAJOR}）`);
}

/* ------------------------------- 2. repo-root ------------------------------- */

/**
 * 为什么是 FAIL：`--repo` 指错目录时，后面每一项都会给出「看起来像环境坏了」的假异常；
 * 入口文件缺一件就说明这不是这套工具链的仓库，继续体检没有意义。
 */
export function checkRepoRoot(repo, { exists } = {}) {
  const required = ['package.json', 'tools/debug-cli.mjs'];
  const missing = required.filter((rel) => !exists(path.join(repo, rel)));
  if (missing.length > 0) {
    return check('repo-root', 'FAIL', `${repo} 下缺少：${missing.join('、')}`);
  }
  return check('repo-root', 'PASS', 'package.json 与 tools/debug-cli.mjs 都在');
}

/* ----------------------------- 3. session-file ----------------------------- */

/**
 * 会话文件查找顺序：
 *  ① `KOJO_DEBUG_SESSION`（显式指定，最高优先，与 debug-cli 同口径）；
 *  ② `<repo>/.kojo-debug/session.json`（历史形态 / 手工放置）；
 *  ③ `<tmp>/kojo-debug/sessions/<工作树哈希>/session.json`（**当前 debug-cli 的真实落点**，
 *     走 debug-lib.sessionDir，按工作树隔离）。
 *
 * ②③ 都查是有意的：手册里写的是 ②，代码实际写 ③（debug-cli 顶部注释也还是 ②）。
 * 只查 ② 的 doctor 会在「serve 明明在跑」时谎报「还没起过 serve」——体检工具的可信度
 * 就没了。detail 里始终写清实际命中的是哪一个。
 */
export function sessionCandidates(repo, env = process.env) {
  const list = [];
  if (env.KOJO_DEBUG_SESSION) list.push(path.resolve(env.KOJO_DEBUG_SESSION));
  list.push(path.join(repo, '.kojo-debug', 'session.json'));
  list.push(path.join(sessionDir(repo), 'session.json'));
  return [...new Set(list)];
}

export function loadSession(repo, { exists, readFile }, env = process.env) {
  const candidates = sessionCandidates(repo, env);
  const found = candidates.find((p) => exists(p));
  if (!found) return { kind: 'none', path: candidates[0], candidates };
  let raw;
  try {
    raw = readFile(found);
  } catch (err) {
    return { kind: 'bad', path: found, candidates, error: `读取失败：${err?.message ?? err}` };
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('顶层不是对象');
    }
    return { kind: 'ok', path: found, candidates, data };
  } catch (err) {
    return { kind: 'bad', path: found, candidates, error: err?.message ?? String(err) };
  }
}

/**
 * 为什么「没有 session」是 WARN 而不是 FAIL：从没起过 serve 的干净仓库本来就该通过体检，
 * 这不是故障。为什么「解析失败」是 FAIL：这是历史坑——serve 在 host/vite/browser 就绪时
 * 各覆写一次 session.json，进程被杀就留下半截文件，之后 status/stop/open 全被 JSON.parse
 * 卡死，属于「现在确实用不了」，必须当场红。
 */
export function checkSessionFile(session, { repo, exists, readFile } = {}, env = process.env) {
  const state = session ?? loadSession(repo, { exists, readFile }, env);
  if (state.kind === 'none') {
    return check(
      'session-file',
      'WARN',
      `还没起过 serve（${shellPath(state.path)} 不存在；真实落点也查过 ${shellPath(
        state.candidates?.[state.candidates.length - 1] ?? '',
      )}）`,
    );
  }
  if (state.kind === 'bad') {
    return check(
      'session-file',
      'FAIL',
      `session.json 无法解析（${state.error}）：${shellPath(state.path)}`,
      `rm -f "${shellPath(state.path)}" && ${SERVE_CMD}`,
    );
  }
  return check('session-file', 'PASS', `session.json 可解析：${shellPath(state.path)}`);
}

/* ------------------------- 4. host-port / cdp-port ------------------------- */

/**
 * 端口连通也算「当前状态」：session 在、端口不通，说明进程已经没了但残会话还在，
 * 后续每条 CLI 子命令都会撞 ECONNREFUSED——判 FAIL 且给出 stop 命令。
 * 没有 session 时无法知道该探哪个端口，只能 WARN 跳过（不猜默认端口，免得探到别人的进程）。
 */
export async function checkPorts(session, { probe } = {}) {
  const skip = (id) =>
    check(
      id,
      'WARN',
      session && session.kind === 'ok'
        ? '会话里没有记录该端口（serve 可能还没就绪）'
        : '没有 session，跳过端口探测',
    );
  if (!session || session.kind !== 'ok') return [skip('host-port'), skip('cdp-port')];

  const probeOnce = async (port) => {
    if (!Number.isInteger(port) || port <= 0) return null;
    if (typeof probe !== 'function') return null;
    try {
      return await probe(port);
    } catch {
      return false;
    }
  };
  const entry = async (id, label, port) => {
    const open = await probeOnce(port);
    if (open === null) return check(id, 'WARN', `会话里没有记录 ${label} 端口，跳过`);
    if (open) return check(id, 'PASS', `${label} :${port} 可连通`);
    return check(id, 'FAIL', `${label} :${port} 连不上（${PORT_TIMEOUT_MS}ms 超时）——残会话或进程已退`, STOP_CMD);
  };
  return [
    await entry('host-port', '调试宿', session.data.serverPort),
    await entry('cdp-port', 'CDP', session.data.cdpPort),
  ];
}

/* ------------------------------- 5. dist-build ------------------------------ */

/**
 * 为什么缺 dist 是 WARN：`serve` 走 vite dev（不读 dist），只有真壳 / 静态产物模式才需要它。
 * 缺了只影响一条通道，不该让整套体检判死；但要说清「只影响 shell 模式」，免得有人拿它当绿灯。
 */
export function checkDist(repo, { exists } = {}) {
  const file = path.join(repo, 'packages', 'app', 'dist', 'index.html');
  if (exists(file)) return check('dist-build', 'PASS', `packages/app/dist/index.html 存在`);
  return check(
    'dist-build',
    'WARN',
    '缺少 packages/app/dist/index.html（只影响 shell / 静态产物模式；serve 走 vite dev 不受影响）',
  );
}

/* ------------------------------- 6. vite-cache ------------------------------ */

/**
 * 为什么缓存缺失 / 过期都是 WARN：vite 会自行重建，正确性不受影响（只是首屏慢）。
 * 为什么**不能**在这里真删：删缓存会把别人正在跑的 dev server 打断，体检必须只读。
 */
export function checkViteCache(repo, { exists, readFile, stat } = {}) {
  const candidates = [
    path.join(repo, 'node_modules', '.vite', 'deps', '_metadata.json'),
    path.join(repo, 'packages', 'app', 'node_modules', '.vite', 'deps', '_metadata.json'),
  ];
  const meta = candidates.find((p) => exists(p));
  if (!meta) {
    return check('vite-cache', 'WARN', '没有 vite 预构建缓存（首次 serve 会现建：慢，但不会错）');
  }
  const depsDir = path.dirname(meta);
  try {
    JSON.parse(readFile(meta));
  } catch (err) {
    return check(
      'vite-cache',
      'WARN',
      `vite 缓存元数据无法解析（${err?.message ?? err}），vite 会重建`,
    );
  }

  const lock = path.join(repo, 'pnpm-lock.yaml');
  if (!exists(lock)) return check('vite-cache', 'PASS', `缓存可解析：${shellPath(meta)}（没有 pnpm-lock.yaml，跳过新旧比对）`);
  const lockMs = stat(lock).mtimeMs;
  const metaMs = stat(meta).mtimeMs;
  if (Number.isFinite(lockMs) && Number.isFinite(metaMs) && lockMs > metaMs) {
    return check(
      'vite-cache',
      'WARN',
      `pnpm-lock.yaml 比缓存新（锁 ${new Date(lockMs).toISOString()} > 缓存 ${new Date(metaMs).toISOString()}），缓存可能过期`,
      `rm -rf "${shellPath(depsDir)}" && ${SERVE_CMD}`,
    );
  }
  return check('vite-cache', 'PASS', `缓存可解析且不早于 pnpm-lock.yaml：${shellPath(meta)}`);
}

/* ------------------------------ 7. stale-procs ------------------------------ */

/**
 * 为什么死 pid 是 WARN 而不是 FAIL：pid 死了本身不阻塞下一次 serve（端口若被占会在
 * host-port 那项红）；但它会让 status 的读数失真、stop 的行为变得难预期，所以必须提示，
 * 并给出「一次收干净」的命令。pid 复用的极端情况下这里可能误报，所以只提示、不代杀。
 */
export function checkStaleProcs(session, { isAlive } = {}) {
  if (!session || session.kind !== 'ok') return check('stale-procs', 'WARN', '没有 session，跳过 pid 判活');
  const s = session.data;
  // vite 也一起看：serve 的 vite 子进程同样会留尸，症状（端口占用 / 缓存被锁）与 host 一致。
  const tracked = [
    ['host', s.serverPid],
    ['vite', s.vitePid],
    ['shell', s.shellPid],
    ['browser', s.browserPid],
  ].filter(([, pid]) => Number.isInteger(pid) && pid > 0);

  if (tracked.length === 0) return check('stale-procs', 'WARN', '会话里没有记录任何 pid（serve 可能没起完）');
  if (typeof isAlive !== 'function') return check('stale-procs', 'WARN', '没有提供判活函数，跳过');

  const dead = tracked.filter(([, pid]) => !isAlive(pid));
  if (dead.length === 0) return check('stale-procs', 'PASS', `记录的 ${tracked.length} 个 pid 都还活着`);
  return check(
    'stale-procs',
    'WARN',
    `有已退出的进程：${dead.map(([name, pid]) => `${name}(pid ${pid})`).join('、')}`,
    STOP_CMD,
  );
}

/* --------------------------------- 入口 ---------------------------------- */

/**
 * 跑完整套体检。所有外部能力都可注入：
 *  - `fs.exists(p)` / `fs.readFile(p)` / `fs.stat(p)`：默认同步实现；
 *  - `probe(port) => Promise<boolean>`：TCP 连通性（入口给 500ms 超时实现）；
 *  - `isAlive(pid)`：进程判活。
 * 返回 `{ ok, repo, checks }`，键序固定，供 `--json` 直接序列化。
 */
export async function runDoctor({
  repo = process.cwd(),
  nodeVersion = process.versions.node,
  probe,
  isAlive,
  fs: fsDeps = createRealFs(),
  env = process.env,
} = {}) {
  const root = path.resolve(repo);
  const deps = { ...createRealFs(), ...fsDeps };
  const session = loadSession(root, deps, env);

  const checks = [];
  checks.push(checkNodeVersion(nodeVersion));
  checks.push(checkRepoRoot(root, deps));
  checks.push(checkSessionFile(session, { repo: root, ...deps }, env));
  checks.push(...(await checkPorts(session, { probe })));
  checks.push(checkDist(root, deps));
  checks.push(checkViteCache(root, deps));
  checks.push(checkStaleProcs(session, { isAlive }));

  // 键序稳定：id 集合与 CHECK_IDS 一一对应（顺序即体检的阅读顺序）
  const ok = checks.every((c) => c.level !== 'FAIL');
  return { ok, repo: root, checks };
}

export function exitCodeFor(result) {
  return result && result.ok ? 0 : 1;
}

/** 人类输出：一行一项；fix 附在同一行尾部（保持「一项一行」，方便 grep / 贴日志） */
export function formatHuman(result) {
  const icon = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL' };
  const lines = result.checks.map(
    (c) => `[${icon[c.level] ?? c.level}] ${c.id.padEnd(13)}${c.detail}${c.fix ? `  · fix: ${c.fix}` : ''}`,
  );
  const count = (level) => result.checks.filter((c) => c.level === level).length;
  lines.push(
    `-- ${result.checks.length} 项：PASS ${count('PASS')} / WARN ${count('WARN')} / FAIL ${count('FAIL')} ⇒ ${
      result.ok ? 'OK' : 'FAIL'
    }（退出码 ${exitCodeFor(result)}）`,
  );
  return lines.join('\n');
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { json: false, repo: process.cwd(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--repo') {
      const v = argv[++i];
      if (!v) throw new Error('--repo 需要一个路径');
      out.repo = path.resolve(v);
    } else if (a.startsWith('--repo=')) out.repo = path.resolve(a.slice('--repo='.length));
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

/** 真实 fs 的同步实现（体检是一次性读，不需要异步） */
function createRealFs() {
  return {
    exists: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, 'utf-8'),
    stat: (p) => statSync(p),
  };
}

/** 端口探测：先 127.0.0.1 再 ::1（Windows 上 vite 有时只绑 ::1），每次 500ms 超时 */
export function probePort(port, timeoutMs = PORT_TIMEOUT_MS) {
  const attempt = (host) =>
    new Promise((resolve) => {
      const socket = net.connect({ port, host });
      let settled = false;
      const finish = (open) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.destroy();
        } catch {}
        resolve(open);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
  return (async () => {
    for (const host of ['127.0.0.1', '::1']) {
      if (await attempt(host)) return true;
    }
    return false;
  })();
}

/** 判活：signal 0 只做权限/存在性检查，不真的发信号 */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      [
        '用法：node tools/debug-doctor.mjs [--json] [--repo <路径>]',
        '',
        '  八项检查：node-version / repo-root / session-file / host-port /',
        '            cdp-port / dist-build / vite-cache / stale-procs',
        '  退出码：任一 FAIL ⇒ 1，否则 0（WARN 不改变退出码）。',
      ].join('\n'),
    );
    return 0;
  }
  const result = await runDoctor({
    repo: args.repo,
    nodeVersion: process.versions.node,
    probe: (port) => probePort(port),
    isAlive: pidAlive,
    fs: createRealFs(),
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatHuman(result));
  return exitCodeFor(result);
}

// 只在直接执行时跑入口；被 import（单测）时保持纯粹
const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      // 体检自己出错也要是一行、可读、非零，不把栈糊在屏幕上（KOJO_DEBUG_TRACE=1 才给栈）
      console.error(`[FAIL] 体检自身出错：${err?.message ?? err}`);
      if (process.env.KOJO_DEBUG_TRACE === '1') console.error(err?.stack);
      process.exitCode = 1;
    });
}
