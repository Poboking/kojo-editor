#!/usr/bin/env node
/**
 * tauri dev 干净启动器：一条命令把「远端主线 → 旧进程 → 旧缓存/旧构建物 → 依赖」全部归位后再起壳。
 *
 * 解决的实际问题（docs/PITFALLS §27/§29/§70）：
 *   - 上一轮 tauri dev 退出不干净：旧 vite 占着 1420（或旧桌面实例占着 exe / WebView2 profile），
 *     新一轮窗口看起来还是旧 UI；
 *   - 跨 merge 的 node_modules/.vite 预打包缓存过期，壳起来白屏或样式不更新；
 *   - agent 只把提交推到了远端，本地工作树还是旧提交；
 *   - 本地是游离 HEAD / 落后 origin/master，不能直接 pull；
 *   - 运行时热更新不会帮你换掉已加载的旧 CSS，必须真的重启壳。
 *
 * 安全边界：
 *   - 只自动终止「本工作树」的 vite/tauri/cargo 残留（不碰桌面 app）；
 *   - 任何 kojo-editor.exe（可能含未保存内容）与别的 worktree 的进程，都先征求确认，--yes 才代劳；
 *   - 冒烟/探针（tools/smoke-*、boot-*、ui-measure）正在跑时直接退出，绝不抢 1420；
 *   - git 只做 fetch + ff-only，脏树/分叉/未完成操作一律不动，提示手动处理；
 *   - 缓存只删 Vite 生成目录；--clean 才删 dist 与 debug exe。不动用户数据/WebView2 profile。
 *
 * 用法：
 *   pnpm tauri:fresh                 # 默认：拉主线 + 清场 + 起壳
 *   pnpm tauri:fresh -- --clean      # 强制清 Vite 缓存 / dist / debug exe（顽固旧 UI）
 *   pnpm tauri:fresh -- --no-pull    # 只测当前 HEAD，不做主线快进
 *   pnpm tauri:fresh -- --yes        # 自动关闭需要确认的旧实例/其它 worktree 进程
 *   node tools/tauri-dev-fresh.mjs --dry-run
 *
 * 退出码：0 = 已启动/预检通过；1 = 前置失败；2 = 端口或实例被占用且未处理；130 = Ctrl+C。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(import.meta.dirname, '..');
const IS_WIN = process.platform === 'win32';
const STAMP = path.join(ROOT, '.local', 'tauri-dev-fresh.json');
const ROOT_NORM = norm(ROOT);
const PROBE_RE = /tools[\\/](?:smoke-[\w.-]+|boot-[\w.-]+|ui-measure)\.mjs/i;
const VITE_CMD_RE = /(?:^|[\\/])vite[\\/](?:bin[\\/])?vite(?:\.js)?(?:["'\s]|$)|[\\/]vite\.js(?:["'\s]|$)|[\\/]\.bin[\\/]vite(?:\.cmd|\.ps1)?(?:["'\s]|$)|@vitejs[\\/]plugin-react/i;
const TAURI_CLI_CMD_RE = /@tauri-apps[\\/]cli(?:[\\/"\s]|$)|@tauri-apps\+cli(?:@|[\\/"]|\s)|[\\/]tauri\.js(?:["'\s]|$)/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let opt;
try {
  // pnpm 11 会把命令行里的分隔符 `--` 原样传给脚本；先剥掉，避免它被当成位置参数。
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === '--') rawArgs.shift();
  ({ values: opt } = parseArgs({
    args: rawArgs,
    options: {
      help: { type: 'boolean', short: 'h' },
      'dry-run': { type: 'boolean' },
      clean: { type: 'boolean' },
      'no-fetch': { type: 'boolean' },
      'no-pull': { type: 'boolean' },
      'no-install': { type: 'boolean' },
      install: { type: 'boolean' },
      'no-kill': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      'no-launch': { type: 'boolean' },
      ref: { type: 'string', default: 'origin/master' },
      verbose: { type: 'boolean', short: 'v' },
    },
    strict: true,
    allowPositionals: false,
  }));
} catch (error) {
  console.error(`[fresh] 参数错误：${error.message}`);
  printHelp();
  process.exit(1);
}

if (opt.help) {
  printHelp();
  process.exit(0);
}
if (opt.install && opt['no-install']) {
  console.error('[fresh] --install 与 --no-install 不能同时使用');
  process.exit(1);
}

let CONFIG;
let activeChild = null;

class AbortError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = 'AbortError';
    this.code = code;
  }
}

const log = (...parts) => console.log('[fresh]', ...parts);
const warn = (...parts) => console.warn('[fresh] 警告:', ...parts);

process.on('exit', cleanupActiveChild);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    cleanupActiveChild();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}

main().catch((error) => {
  if (error instanceof AbortError) {
    console.error(`[fresh] ${error.message}`);
    process.exitCode = error.code;
  } else {
    console.error('[fresh] 未预期错误：');
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
});

async function main() {
  log('kojo-editor 干净启动器');
  log(`工作树：${ROOT}`);

  const gitState = syncMainline();
  CONFIG = loadConfig();
  log(`devUrl：${CONFIG.devUrl}（端口 ${CONFIG.port}）`);
  if (process.env.CARGO_TARGET_DIR) log(`CARGO_TARGET_DIR：${CONFIG.targetDir}`);
  if (opt.verbose) log(`进程快照：读取中…`);

  const processes = snapshotProcesses();
  if (processes) {
    if (opt.verbose) log(`进程快照：${processes.length} 条`);
    const plan = await analyzeProcesses(processes, CONFIG);
    await applyProcessPlan(plan, CONFIG);
  } else {
    warn('读取完整进程表失败，改用保守检查（只认端口与同名 exe）');
    await fallbackProcessGuard(CONFIG);
  }

  const deps = depsStatus();
  const installReason = !deps.ok
    ? '关键依赖未安装'
    : gitState.depsChanged
      ? '远端更新了 package.json / 锁文件'
      : opt.install
        ? '按 --install'
        : '';
  if (installReason && opt['no-install'] && !opt['dry-run']) {
    throw new AbortError(`依赖需要安装（${installReason}），但指定了 --no-install。先执行 pnpm install，或去掉该参数。`, 1);
  }

  const cache = prepareCaches(gitState);
  if (installReason) {
    if (opt['dry-run']) log(`dry-run：将执行 pnpm install --frozen-lockfile（${installReason}）`);
    else await installDeps(installReason);
  }

  log(`Vite 缓存：${cache.cleared ? '本次已清理' : cache.existing ? '命中，复用' : '无旧缓存'}`);
  if (!opt['dry-run'] && !depsStatus().ok) {
    throw new AbortError('依赖仍不完整（vite 或 @tauri-apps/cli 缺失）；请检查 pnpm install 输出。', 1);
  }

  if (opt['dry-run']) {
    log('dry-run：预检结束，未安装、未删除、未启动。');
    return;
  }
  if (opt['no-launch']) {
    log('已按 --no-launch 停在启动前。');
    return;
  }

  await finalGuard(CONFIG);
  await launch();
}

// ---------------------------------------------------------------------------
// git：远端主线 → ff-only 快进
// ---------------------------------------------------------------------------

function syncMainline() {
  const state = {
    ref: opt.ref,
    ahead: 0,
    behind: 0,
    fetchOk: null,
    pulled: false,
    depsChanged: false,
    oldHead: '',
    head: '',
    targetSha: '',
  };

  const headResult = git(['rev-parse', 'HEAD']);
  if (headResult.code !== 0) {
    throw new AbortError(`当前目录不是可用的 git 工作树：${tail(headResult.err || headResult.out, 500)}`, 1);
  }
  state.oldHead = headResult.out.trim();

  if (!opt['no-fetch']) {
    log(`同步远端：git fetch --prune origin（目标 ${state.ref}）`);
    const fetched = git(['fetch', '--prune', 'origin'], {
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (fetched.code === 0) {
      state.fetchOk = true;
      log('远端引用已刷新');
    } else {
      state.fetchOk = false;
      warn(`git fetch 失败（rc=${fetched.code}），继续使用本地已知的 ${state.ref}。`);
      const detail = tail(fetched.err || fetched.out, 600);
      if (detail) warn(detail);
    }
  } else {
    log('按 --no-fetch：不联网，也不自动快进');
  }

  const refResult = git(['rev-parse', '--verify', '--quiet', state.ref]);
  if (refResult.code !== 0) {
    warn(`找不到目标 ref「${state.ref}」，跳过主线同步`);
    printHead(state);
    return state;
  }
  state.targetSha = refResult.out.trim();

  const counts = git(['rev-list', '--left-right', '--count', `HEAD...${state.ref}`]);
  if (counts.code !== 0) {
    warn(`无法比较 HEAD 与 ${state.ref}：${tail(counts.err, 400)}`);
    printHead(state);
    return state;
  }
  const [ahead, behind] = counts.out.trim().split(/\s+/).map(Number);
  state.ahead = ahead || 0;
  state.behind = behind || 0;

  if (state.behind === 0) {
    if (state.ahead > 0) log(`当前 HEAD 领先 ${state.ref} ${state.ahead} 个提交（测试的是本地提交）`);
    else log(`当前 HEAD 已同步 ${state.ref}`);
    printHead(state);
    return state;
  }

  warn(`当前 HEAD 落后 ${state.ref} ${state.behind} 个提交。`);
  if (opt['no-pull'] || opt['no-fetch']) {
    warn(`${opt['no-fetch'] ? '--no-fetch' : '--no-pull'}：保持旧 HEAD，本次测试的不是远端最新代码`);
    if (state.ahead > 0) warn(`另有 ${state.ahead} 个本地提交不在 ${state.ref}`);
    printHead(state);
    return state;
  }
  if (state.ahead > 0) {
    throw new AbortError(
      `HEAD 与 ${state.ref} 已分叉（本地 ${state.ahead} / 远端 ${state.behind}）。` +
        `不会自动 rebase；先手动 git rebase ${state.ref}，或用 --no-pull 测试当前树。`,
      1,
    );
  }

  const gitDirResult = git(['rev-parse', '--absolute-git-dir']);
  if (gitDirResult.code === 0) {
    for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      if (existsSync(path.join(gitDirResult.out.trim(), marker))) {
        throw new AbortError(`检测到未完成的 git 操作（${marker}）。先处理完再启动。`, 1);
      }
    }
  }

  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty.code !== 0) {
    throw new AbortError(`读取工作树状态失败：${tail(dirty.err, 400)}`, 1);
  }
  const dirtyLines = dirty.out.split(/\r?\n/).filter(Boolean);
  if (dirtyLines.length > 0) {
    throw new AbortError(
      `工作树有 ${dirtyLines.length} 个未提交的已跟踪改动，拒绝自动快进（避免把本地改动混进本轮测试）。` +
        `先提交/还原，或加 --no-pull 测试当前树。`,
      1,
    );
  }

  if (opt['dry-run']) {
    log(`dry-run：将快进 ${state.oldHead.slice(0, 7)} → ${state.targetSha.slice(0, 7)}（${state.ref}）`);
    printHead(state);
    return state;
  }

  log(`快进 HEAD：${state.oldHead.slice(0, 7)} → ${state.targetSha.slice(0, 7)} …`);
  const merged = git(['merge', '--ff-only', state.ref]);
  if (merged.code !== 0) {
    throw new AbortError(
      `ff-only 快进失败（rc=${merged.code}），未做任何强制操作。` +
        `${tail(merged.err || merged.out, 600)}`,
      1,
    );
  }
  state.pulled = true;
  state.head = git(['rev-parse', 'HEAD']).out.trim();

  const changed = git(['diff', '--name-only', state.oldHead, state.head]);
  if (changed.code !== 0) state.depsChanged = true;
  else {
    state.depsChanged = changed.out
      .split(/\r?\n/)
      .filter(Boolean)
      .some((file) => /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(file));
  }
  if (state.depsChanged) log('上游改动包含 package.json / 锁文件，稍后会刷新依赖');
  printHead(state);
  return state;
}

function printHead(state) {
  const head = state.head || git(['rev-parse', 'HEAD']).out.trim() || state.oldHead;
  if (!head) return;
  state.head = head;
  const branch = git(['branch', '--show-current']).out.trim() || '游离 HEAD';
  const subject = git(['log', '-1', '--format=%s', head]).out.trim();
  log(`测试提交：${head.slice(0, 7)}（${branch}）${subject}`);
  if (state.targetSha && state.targetSha !== head) {
    log(`目标 ${state.ref}：${state.targetSha.slice(0, 7)}（本次未合并）`);
  }
}

function git(args, extra = {}) {
  return run('git', args, extra);
}

// ---------------------------------------------------------------------------
// 前置配置
// ---------------------------------------------------------------------------

function loadConfig() {
  const appDir = path.join(ROOT, 'packages', 'app');
  const tauriConfPath = path.join(appDir, 'src-tauri', 'tauri.conf.json');
  if (!existsSync(tauriConfPath)) {
    throw new AbortError(`找不到 ${path.relative(ROOT, tauriConfPath)}，无法确定 devUrl。`, 1);
  }
  let conf;
  try {
    conf = JSON.parse(readFileSync(tauriConfPath, 'utf8'));
  } catch (error) {
    throw new AbortError(`解析 tauri.conf.json 失败：${error.message}`, 1);
  }

  let devUrl;
  try {
    devUrl = new URL(conf.build?.devUrl ?? 'http://localhost:1420');
  } catch (error) {
    throw new AbortError(`tauri.conf.json 的 devUrl 无效：${error.message}`, 1);
  }
  const port = Number(devUrl.port || (devUrl.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0) {
    throw new AbortError(`tauri.conf.json 的 devUrl 没有可用端口：${conf.build?.devUrl}`, 1);
  }

  const productName = String(conf.productName ?? 'kojo-editor');
  let cargoName = productName;
  const cargoPath = path.join(appDir, 'src-tauri', 'Cargo.toml');
  if (existsSync(cargoPath)) {
    const matched = readFileSync(cargoPath, 'utf8').match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (matched) cargoName = matched[1];
  }
  const names = [...new Set([productName, cargoName])];
  const exeNames = names.map((name) => (IS_WIN ? `${name}.exe` : name));
  const appBaseNames = new Set(names.map((name) => name.toLowerCase().replace(/\.exe$/i, '')));

  const vitePath = path.join(appDir, 'vite.config.ts');
  if (existsSync(vitePath)) {
    const viteText = readFileSync(vitePath, 'utf8');
    const portMatch = viteText.match(/\bport\s*:\s*(\d+)/);
    if (portMatch && Number(portMatch[1]) !== port) {
      warn(`配置不一致：tauri devUrl 是 ${port}，vite.config 却写 ${portMatch[1]}`);
    }
    if (!/strictPort\s*:\s*true/.test(viteText)) {
      warn('vite strictPort 没有写死 true；端口被占时可能悄悄换端口，Tauri 会继续加载旧页面');
    }
  }

  const cargoDir = path.join(appDir, 'src-tauri');
  const targetDir = process.env.CARGO_TARGET_DIR
    ? path.resolve(cargoDir, process.env.CARGO_TARGET_DIR)
    : path.join(cargoDir, 'target');
  const debugDir = path.join(targetDir, 'debug');

  return {
    appDir,
    port,
    devUrl: devUrl.href,
    productName,
    cargoName,
    names,
    exeNames,
    appBaseNames,
    targetDir,
    debugDir,
    targetNorm: norm(targetDir),
  };
}

// ---------------------------------------------------------------------------
// 进程清场
// ---------------------------------------------------------------------------

async function analyzeProcesses(processes, config) {
  const map = new Map(processes.map((proc) => [proc.pid, proc]));
  const protectedPids = new Set([process.pid]);
  for (const ancestor of ancestors(process.pid, map)) protectedPids.add(ancestor.pid);

  const auto = new Map();
  const consent = new Map();
  const probes = new Map();
  const blockers = [];

  const addAuto = (item) => {
    if (protectedPids.has(item.proc.pid) || consent.has(item.proc.pid)) return;
    if (!auto.has(item.proc.pid)) auto.set(item.proc.pid, item);
  };
  const addConsent = (item) => {
    if (protectedPids.has(item.proc.pid)) return;
    auto.delete(item.proc.pid);
    if (!consent.has(item.proc.pid)) consent.set(item.proc.pid, item);
  };
  const noteProbe = (proc, probe) => {
    if (!probes.has(probe.pid)) probes.set(probe.pid, { probe, child: proc });
  };

  for (const proc of processes) {
    if (protectedPids.has(proc.pid) || !isAppProcess(proc, config)) continue;
    const probe = probeAncestor(proc.pid, map);
    if (probe) {
      noteProbe(proc, probe);
      continue;
    }
    addConsent({
      proc,
      kind: 'app',
      why: isOwnExe(proc.exe, config)
        ? '本工作树路径下的桌面实例（可能有未保存内容）'
        : '非本工作树的桌面实例（同 identifier 会撞 WebView2）',
    });
  }

  for (const proc of processes) {
    if (protectedPids.has(proc.pid) || isAppProcess(proc, config)) continue;
    const kind = devKind(proc, config);
    if (!kind || !hasPathRoot(proc)) continue;
    const probe = probeAncestor(proc.pid, map);
    if (probe) {
      noteProbe(proc, probe);
      continue;
    }
    addAuto({ proc, kind, why: '本工作树残留的 dev 进程' });
  }

  const listeners = portListeners(config.port);
  for (const pid of listeners) {
    if (protectedPids.has(pid)) continue;
    const proc = map.get(pid);
    if (!proc) {
      blockers.push(`端口 ${config.port} 被 PID ${pid} 占用，但读不到进程详情（可能权限不足）`);
      continue;
    }
    const probe = probeAncestor(pid, map);
    if (probe) {
      noteProbe(proc, probe);
      continue;
    }
    if (isAppProcess(proc, config)) {
      addConsent({ proc, kind: 'app', why: `桌面实例监听 ${config.port}（异常）` });
      continue;
    }
    const kind = devKind(proc, config);
    if (!kind) {
      blockers.push(`端口 ${config.port} 被非 kojo dev 进程占用：${proc.name || '?'}（PID ${pid}）`);
      continue;
    }
    if (hasPathRoot(proc)) addAuto({ proc, kind, why: `本工作树的 dev server 占用 ${config.port}` });
    else addConsent({ proc, kind, why: `别的工作树/来源的 ${kind} 占用 ${config.port}` });
  }

  // 杀掉子进程不等于杀掉上位 CLI；把 dev 链上还能识别的父进程一并纳入清场。
  for (const [category, bucket] of [
    ['auto', auto],
    ['consent', consent],
  ]) {
    for (const item of [...bucket.values()]) {
      for (const pid of devAncestorsOf(item.proc.pid, map, config, protectedPids)) {
        const proc = map.get(pid);
        if (!proc) continue;
        const kind = devKind(proc, config);
        if (!kind) continue;
        if (category === 'auto') addAuto({ proc, kind, why: '上位 dev 进程' });
        else addConsent({ proc, kind, why: '上位 dev 进程' });
      }
    }
  }

  if (await isPortOpen(config.port) && listeners.length === 0) {
    blockers.push(`端口 ${config.port} 可连接，但 netstat 没有给出监听 PID`);
  }

  return {
    map,
    protectedPids,
    auto: [...auto.values()],
    consent: [...consent.values()],
    probes: [...probes.values()],
    blockers,
    listeners,
  };
}

async function applyProcessPlan(plan, config) {
  if (plan.probes.length > 0) {
    const lines = plan.probes.map(
      ({ probe, child }) =>
        `PID ${probe.pid} ${probe.name || '?'}（${tail(probe.cmd || probe.exe, 220)}）→ 子进程 ${child.name} PID ${child.pid}`,
    );
    throw new AbortError(
      `检测到正在运行的冒烟/探针，它会占用端口或同名桌面实例，本脚本不会抢：\n  ${lines.join('\n  ')}\n` +
        `等它自行结束（或到对应会话处理）后再启动。`,
      2,
    );
  }
  if (plan.blockers.length > 0) {
    throw new AbortError(`${plan.blockers.join('\n')}\n先处理端口占用后再启动。`, 2);
  }

  const all = [...plan.auto, ...plan.consent];
  if (all.length === 0) {
    if (plan.listeners.length > 0) {
      throw new AbortError(`端口 ${config.port} 仍被 PID ${plan.listeners.join(',')} 占用。`, 2);
    }
    return;
  }

  log('发现需要处理的旧进程：');
  for (const item of plan.auto) log(`  自动清理：${describe(item)}`);
  for (const item of plan.consent) log(`  需确认：${describe(item)}`);

  if (opt['dry-run']) {
    log('dry-run：未终止任何进程。');
    return;
  }
  if (opt['no-kill']) {
    throw new AbortError('按 --no-kill 不清理进程；先手动关闭上面的实例，或去掉该参数。', 2);
  }

  if (plan.consent.length > 0) {
    const approved = await confirm(
      `\n需要关闭 ${plan.consent.length} 个进程（含桌面实例/其它工作树，未保存内容可能丢失）。继续？[y/N] `,
    );
    if (!approved) {
      throw new AbortError('已取消，未终止任何进程。先手动关闭对应实例，或加 --yes。', 2);
    }
  }

  const killSet = new Set(
    all.map((item) => item.proc.pid).filter((pid) => !plan.protectedPids.has(pid)),
  );
  const roots = topmostKillRoots(killSet, plan.map);
  for (const pid of roots) {
    const proc = plan.map.get(pid);
    log(`终止 PID ${pid}（${proc?.name || '?'}）…`);
    await killTree(pid, plan.map);
  }

  await sleep(600);
  const free = await waitPortFree(config.port, 8_000);
  const left = portListeners(config.port);
  if (!free || left.length > 0) {
    throw new AbortError(`清理后端口 ${config.port} 仍被占用（PID ${left.join(',') || '未知'}），本次不启动。`, 2);
  }

  const after = snapshotProcesses();
  if (after) {
    const survivors = after.filter(
      (proc) => killSet.has(proc.pid) && !plan.protectedPids.has(proc.pid),
    );
    if (survivors.length > 0) {
      const lines = survivors.map((proc) => `PID ${proc.pid} ${proc.name || '?'}`).join(', ');
      throw new AbortError(`以下进程未能退出：${lines}。请手动关闭后重试。`, 2);
    }
    const apps = after.filter(
      (proc) => isAppProcess(proc, config) && !plan.protectedPids.has(proc.pid),
    );
    if (apps.length > 0) {
      const lines = apps.map((proc) => `PID ${proc.pid} ${proc.exe || proc.cmd || proc.name}`).join('\n  ');
      throw new AbortError(`仍有桌面实例在运行（会撞 WebView2）：\n  ${lines}\n先关闭后再试。`, 2);
    }
  }
  log('旧实例/端口已清场');
}

function describe(item) {
  const proc = item.proc;
  const location = item.kind === 'app' ? proc.exe || proc.cmd : proc.cmd || proc.exe;
  return `PID ${proc.pid} ${proc.name || '?'} — ${item.why}${location ? `\n       ${tail(location, 240)}` : ''}`;
}

function fallbackProcessGuard(config) {
  return (async () => {
    const listeners = portListeners(config.port);
    if (listeners.length > 0 || (await isPortOpen(config.port))) {
      throw new AbortError(
        `无法读取进程归属，但端口 ${config.port} 已被占用（PID ${listeners.join(',') || '未知'}）。` +
          `请手动关闭对应实例后再试。`,
        2,
      );
    }
    if (IS_WIN) {
      for (const name of config.exeNames) {
        const result = spawnSync(
          'tasklist',
          ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'],
          { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
        );
        if (result.stdout && result.stdout.toLowerCase().includes(name.toLowerCase())) {
          throw new AbortError(
            `检测到 ${name} 正在运行，但读不到它的路径/归属。请先手动关闭桌面实例再试。`,
            2,
          );
        }
      }
    }
  })();
}

function snapshotProcesses() {
  try {
    if (IS_WIN) return snapshotWindows();
    return snapshotPosix();
  } catch (error) {
    warn(`读取进程表失败：${error.message}`);
    return null;
  }
}

function snapshotWindows() {
  const script = [
    "$ErrorActionPreference='Stop'",
    '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding=[Console]::OutputEncoding',
    '$ps=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine)',
    'ConvertTo-Json -InputObject $ps -Compress -Depth 3',
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || '').trim() || `powershell rc=${result.status}`);
  }
  const raw = (result.stdout || '').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .map((proc) => ({
      pid: Number(proc.ProcessId),
      ppid: Number(proc.ParentProcessId),
      name: String(proc.Name || '').toLowerCase(),
      exe: String(proc.ExecutablePath || ''),
      cmd: String(proc.CommandLine || ''),
    }))
    .filter((proc) => Number.isFinite(proc.pid) && proc.pid > 0);
}

function snapshotPosix() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,args='], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || '').trim() || `ps rc=${result.status}`);
  const list = [];
  for (const line of (result.stdout || '').split(/\r?\n/)) {
    const matched = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!matched) continue;
    const cmd = matched[3];
    const first = cmd.trim().split(/\s+/)[0] || '';
    list.push({
      pid: Number(matched[1]),
      ppid: Number(matched[2]),
      name: path.basename(first).toLowerCase(),
      exe: '',
      cmd,
    });
  }
  return list;
}

function devKind(proc, config) {
  if (isAppProcess(proc, config)) return 'app';
  const base = proc.name.replace(/\.exe$/i, '');
  if ((base === 'node' || base === 'nodejs') && VITE_CMD_RE.test(proc.cmd)) return 'vite';
  if ((base === 'node' || base === 'nodejs') && TAURI_CLI_CMD_RE.test(proc.cmd)) return 'tauri-cli';
  if (base === 'cargo' || base === 'rustc') {
    if (hasPathRoot(proc) || /src-tauri[\\/](?:Cargo\.toml|target)|[\\/]\.cargo[\\/]|[\\/]cargo[\\/]/i.test(norm(proc.cmd))) {
      return 'cargo';
    }
  }
  return null;
}

function isAppProcess(proc, config) {
  const base = proc.name.replace(/\.exe$/i, '').toLowerCase();
  return config.appBaseNames.has(base) || config.exeNames.some((name) => name.toLowerCase() === proc.name);
}

function isOwnExe(exe, config) {
  if (!exe) return false;
  const normalized = norm(exe);
  return isUnder(normalized, ROOT_NORM) || isUnder(normalized, config.targetNorm);
}

function hasPathRoot(proc) {
  return containsPath(proc.exe, ROOT_NORM) || containsPath(proc.cmd, ROOT_NORM);
}

function probeAncestor(pid, map) {
  for (const ancestor of ancestors(pid, map)) {
    const base = ancestor.name.replace(/\.exe$/i, '');
    if ((base === 'node' || base === 'nodejs') && PROBE_RE.test(ancestor.cmd)) return ancestor;
  }
  return null;
}

function devAncestorsOf(pid, map, config, protectedPids) {
  const result = [];
  for (const ancestor of ancestors(pid, map)) {
    if (protectedPids.has(ancestor.pid)) break;
    if (!devKind(ancestor, config)) break;
    result.push(ancestor.pid);
  }
  return result;
}

function ancestors(pid, map) {
  const result = [];
  const seen = new Set([pid]);
  let current = map.get(pid);
  while (current) {
    const parent = map.get(current.ppid);
    if (!parent || seen.has(parent.pid)) break;
    seen.add(parent.pid);
    result.push(parent);
    current = parent;
  }
  return result;
}

function topmostKillRoots(killSet, map) {
  const roots = [];
  for (const pid of killSet) {
    let covered = false;
    for (const ancestor of ancestors(pid, map)) {
      if (killSet.has(ancestor.pid)) {
        covered = true;
        break;
      }
    }
    if (!covered) roots.push(pid);
  }
  return roots;
}

async function killTree(pid, map) {
  if (IS_WIN) {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
    if (result.error) warn(`taskkill PID ${pid} 失败：${result.error.message}`);
    else if (result.status !== 0 && result.status !== 128) {
      warn(`taskkill PID ${pid} rc=${result.status}：${tail((result.stderr || result.stdout || '').trim(), 300)}`);
    }
    return;
  }

  const ids = descendants(pid, map);
  for (const id of [...ids].reverse()) {
    try {
      process.kill(id, 'SIGTERM');
    } catch {}
  }
  await sleep(600);
  for (const id of ids) {
    try {
      process.kill(id, 'SIGKILL');
    } catch {}
  }
}

function descendants(pid, map) {
  const result = [pid];
  const seen = new Set(result);
  for (let index = 0; index < result.length; index += 1) {
    for (const proc of map.values()) {
      if (proc.ppid === result[index] && !seen.has(proc.pid)) {
        seen.add(proc.pid);
        result.push(proc.pid);
      }
    }
  }
  return result;
}

function portListeners(port) {
  if (IS_WIN) {
    const result = run('netstat', ['-ano'], { timeout: 15_000 });
    if (result.code !== 0) return [];
    const pids = new Set();
    for (const line of result.out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const local = parts[1] || '';
      const pid = Number(parts[parts.length - 1]);
      const matched = local.match(/:(\d+)$/);
      if (matched && Number(matched[1]) === port && Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  }

  const lsof = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  if (lsof.code === 0) {
    return [...new Set(lsof.out.split(/\s+/).filter((part) => /^\d+$/.test(part)).map(Number))];
  }
  const ss = run('ss', ['-ltnp', `sport = :${port}`]);
  if (ss.code === 0) {
    const pids = new Set();
    for (const matched of ss.out.matchAll(/\bpid=(\d+)/g)) pids.add(Number(matched[1]));
    return [...pids];
  }
  return [];
}

function tryConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(600);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

async function isPortOpen(port) {
  const [v4, v6] = await Promise.all([tryConnect('127.0.0.1', port), tryConnect('::1', port)]);
  return v4 || v6;
}

async function waitPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return true;
    await sleep(300);
  }
  return false;
}

async function confirm(question) {
  if (opt.yes) return true;
  if (!process.stdin.isTTY) {
    warn('当前不是交互终端，无法询问；如需自动处理请加 --yes');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^(?:y|yes|是)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function cleanupActiveChild() {
  const child = activeChild;
  if (!child || !child.pid || child.exitCode !== null) return;
  try {
    if (IS_WIN) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 10_000,
      });
    } else {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {}
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// 依赖 / 缓存 / 旧构建物
// ---------------------------------------------------------------------------

function depsStatus() {
  const rootNM = path.join(ROOT, 'node_modules');
  const appNM = path.join(CONFIG.appDir, 'node_modules');
  const hasBin = (dir, name) =>
    [name, `${name}.cmd`, `${name}.ps1`].some((file) => existsSync(path.join(dir, '.bin', file)));
  const hasVite =
    existsSync(path.join(rootNM, 'vite')) ||
    existsSync(path.join(appNM, 'vite')) ||
    hasBin(rootNM, 'vite') ||
    hasBin(appNM, 'vite');
  const hasTauri =
    existsSync(path.join(appNM, '@tauri-apps', 'cli')) ||
    existsSync(path.join(rootNM, '@tauri-apps', 'cli')) ||
    hasBin(appNM, 'tauri') ||
    hasBin(rootNM, 'tauri');
  return { ok: hasVite && hasTauri, hasVite, hasTauri };
}

async function installDeps(reason) {
  log(`安装依赖（${reason}）：pnpm install --frozen-lockfile`);
  await runChild('pnpm', ['install', '--frozen-lockfile']);
  if (!depsStatus().ok) {
    throw new AbortError(
      'pnpm install 成功退出，但 vite / @tauri-apps/cli 仍不可用。' +
        '若 pnpm 报 workspace 链接缺失，见 docs/PITFALLS.md 的布局坑。',
      1,
    );
  }
  log('依赖已就绪');
}

function runChild(command, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnPortable(command, args, {
        cwd: ROOT,
        stdio: 'inherit',
        windowsHide: false,
        env: { ...process.env },
      });
    } catch (error) {
      reject(new AbortError(`无法启动 ${command}：${error.message}`, 1));
      return;
    }
    activeChild = child;
    child.once('error', (error) => {
      if (activeChild === child) activeChild = null;
      reject(new AbortError(`无法启动 ${command}：${error.message}`, 1));
    });
    child.once('close', (code, signal) => {
      if (activeChild === child) activeChild = null;
      if (code === 0) resolve();
      else reject(new AbortError(`${command} 退出（code=${code ?? signal}）`, 1));
    });
  });
}

function prepareCaches(gitState) {
  const hash = cacheHash();
  const stamp = readStamp();
  const cacheRels = ['packages/app/node_modules/.vite', 'node_modules/.vite'];
  const tempRels = ['packages/app/node_modules/.vite-temp', 'node_modules/.vite-temp'];
  const existing = cacheRels.filter((rel) => existsSync(path.join(ROOT, rel)));
  const reasons = [];

  if (opt.clean) reasons.push('--clean');
  else if (existing.length > 0) {
    if (!stamp) reasons.push('旧 Vite 缓存没有本工具的标记');
    else if (stamp.hash !== hash) reasons.push('锁文件 / package.json / Vite 配置已变化');
  }

  if (reasons.length > 0) {
    if (opt['dry-run']) log(`dry-run：将清理 Vite 缓存（${reasons.join('；')}）`);
    else {
      for (const rel of [...cacheRels, ...tempRels]) removeGenerated(rel);
      log(`已清理 Vite 缓存（${reasons.join('；')}）`);
    }
  }

  const artifactPaths = new Set();
  if (opt.clean) {
    artifactPaths.add(path.join(CONFIG.appDir, 'dist'));
    for (const exeName of CONFIG.exeNames) {
      artifactPaths.add(path.join(CONFIG.debugDir, exeName));
      if (IS_WIN) {
        artifactPaths.add(path.join(CONFIG.debugDir, exeName.replace(/\.exe$/i, '.pdb')));
      }
    }
  }

  let removedArtifacts = 0;
  for (const artifact of artifactPaths) {
    if (!existsSync(artifact)) continue;
    removedArtifacts += 1;
    if (opt['dry-run']) log(`dry-run：将删除旧构建物 ${displayPath(artifact)}`);
    else {
      removeGeneratedAbs(artifact);
      log(`已删除旧构建物 ${displayPath(artifact)}`);
    }
  }
  if (opt.clean && removedArtifacts === 0) log('没有需要删除的旧构建物');

  if (!opt['dry-run']) writeStamp(hash, gitState);
  return { hash, cleared: reasons.length > 0, existing: existing.length > 0 };
}

function cacheHash() {
  const inputs = [
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package.json',
    'packages/app/package.json',
    'packages/app/vite.config.ts',
    'packages/app/src-tauri/tauri.conf.json',
  ];
  const hash = createHash('sha256');
  for (const rel of inputs) {
    hash.update(rel);
    hash.update('\0');
    try {
      hash.update(readFileSync(path.join(ROOT, rel)));
    } catch {
      hash.update('<missing>');
    }
    hash.update('\0');
  }
  hash.update(`${process.platform}\0${process.arch}\0${process.versions.node}`);
  return hash.digest('hex');
}

function readStamp() {
  try {
    return JSON.parse(readFileSync(STAMP, 'utf8'));
  } catch {
    return null;
  }
}

function writeStamp(hash, gitState) {
  try {
    mkdirSync(path.dirname(STAMP), { recursive: true });
    const commit = gitState?.head || git(['rev-parse', 'HEAD']).out.trim() || '';
    writeFileSync(
      STAMP,
      `${JSON.stringify(
        { hash, commit: commit.slice(0, 12), at: new Date().toISOString() },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch (error) {
    warn(`写入缓存标记失败：${error.message}`);
  }
}

function removeGenerated(rel) {
  const abs = path.resolve(ROOT, rel);
  if (!isUnder(norm(abs), ROOT_NORM) || abs === ROOT) {
    throw new AbortError(`拒绝删除工作树之外的路径：${abs}`, 1);
  }
  if (!existsSync(abs)) return;
  try {
    rmSync(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    throw new AbortError(`清理 ${displayPath(abs)} 失败（可能仍被进程占用）：${error.message}`, 1);
  }
}

function removeGeneratedAbs(abs) {
  const normalized = norm(abs);
  const allowed = isUnder(normalized, ROOT_NORM) || isUnder(normalized, CONFIG.targetNorm);
  if (!allowed || normalized === ROOT_NORM) {
    throw new AbortError(`拒绝删除工作树/构建目录之外的路径：${abs}`, 1);
  }
  if (!existsSync(abs)) return;
  try {
    const info = statSync(abs);
    if (info.isDirectory()) {
      if (!isUnder(normalized, norm(CONFIG.appDir))) {
        throw new AbortError(`拒绝递归删除非 app 目录：${abs}`, 1);
      }
      rmSync(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } else {
      rmSync(abs, { force: true, maxRetries: 5, retryDelay: 200 });
    }
  } catch (error) {
    if (error instanceof AbortError) throw error;
    throw new AbortError(`删除 ${displayPath(abs)} 失败（可能仍被进程占用）：${error.message}`, 1);
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function finalGuard(config) {
  const listeners = portListeners(config.port);
  if (listeners.length > 0 || (await isPortOpen(config.port))) {
    throw new AbortError(
      `启动前检查：端口 ${config.port} 又被占用（PID ${listeners.join(',') || '未知'}）。` +
        `可能有另一个实例刚起来；关闭它后重跑。`,
      2,
    );
  }

  const processes = snapshotProcesses();
  if (!processes) {
    warn('启动前无法读取进程表，跳过桌面实例复核');
    return;
  }
  const apps = processes.filter((proc) => isAppProcess(proc, config));
  if (apps.length > 0) {
    const lines = apps.map((proc) => `PID ${proc.pid} ${proc.exe || proc.cmd || proc.name}`).join('\n  ');
    throw new AbortError(
      `启动前仍有桌面实例在运行（同 identifier 会撞 WebView2）：\n  ${lines}\n先关闭后再试。`,
      2,
    );
  }
}

async function launch() {
  const hostPath = path.join(CONFIG.debugDir, CONFIG.exeNames[0]);
  log(`启动：pnpm --filter @kojo/app tauri dev`);
  log(`宿主产物：${displayPath(hostPath)}`);
  log('本轮是新起 Vite + 新起壳；窗口里仍是旧样式时按 Ctrl+R 强刷，或下次加 --clean');

  const env = { ...process.env };
  if (IS_WIN) {
    env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = appendFlag(
      env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
      '--disable-http-cache',
    );
  }

  const child = spawnPortable('pnpm', ['--filter', '@kojo/app', 'tauri', 'dev'], {
    cwd: ROOT,
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: false,
    env,
  });
  activeChild = child;

  const names = [...CONFIG.names].map(escapeRegExp).join('|');
  const hostRe = new RegExp(`Running\\s+\`[^\`]*(?:${names})(?:\\.exe)?[^\`]*\``, 'i');
  const hintRules = [
    {
      re: /Port\s+\d+\s+is\s+already\s+in\s+use|EADDRINUSE/i,
      message: 'dev 端口被占用。先确认没有别的实例，或重跑本脚本清场。',
    },
    {
      re: /beforeDevCommand|Failed to run.*dev/i,
      message: '前端 dev server 启动失败，先看上面的 Vite 原始报错。',
    },
    {
      re: /0x8007139F|WebView2.*(?:失败|错误|fail|error)/i,
      message: 'WebView2 实例冲突：同 identifier 的桌面实例还在跑。关闭它，或加 --yes 让脚本清理。',
    },
    {
      re: /os error 5|Access is denied|拒绝访问/i,
      message: '旧进程仍锁着 exe/构建目录；关闭实例后重跑。',
    },
    {
      re: /error while attempting to connect to the server/i,
      message: 'Tauri 连不上 devUrl；检查 tauri.conf.json 与 Vite 端口是否一致。',
    },
    {
      re: /error\[E\d+\]|could not compile/i,
      message: 'Rust 编译失败，上面有 rustc 原始报错。',
    },
  ];

  let viteReady = false;
  let hostLaunched = false;
  let scanBuffer = '';
  const shownHints = new Set();

  const scan = (chunk) => {
    scanBuffer = (scanBuffer + chunk).slice(-12_000);
    if (!viteReady && /VITE v\d|ready in\s+\d+\s*ms|\bLocal:\s+http:\/\//i.test(scanBuffer)) {
      viteReady = true;
      log(`Vite 已就绪：${CONFIG.devUrl}`);
    }
    if (!hostLaunched && hostRe.test(scanBuffer)) {
      hostLaunched = true;
      log('宿主进程已启动');
    }
    for (const rule of hintRules) {
      if (!shownHints.has(rule.message) && rule.re.test(scanBuffer)) {
        shownHints.add(rule.message);
        warn(rule.message);
      }
    }
  };

  const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');
  child.stdout.on('data', (data) => {
    process.stdout.write(data);
    scan(stripAnsi(data.toString()));
  });
  child.stderr.on('data', (data) => {
    process.stderr.write(data);
    scan(stripAnsi(data.toString()));
  });

  const outcome = await new Promise((resolve) => {
    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ error });
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    });
  });

  if (activeChild === child) activeChild = null;
  if (outcome.error) {
    throw new AbortError(`无法启动 pnpm：${outcome.error.message}`, 1);
  }
  const code = outcome.code ?? (outcome.signal ? 1 : 0);
  if (code === 0) log('tauri dev 已退出（code=0）');
  else warn(`tauri dev 退出（code=${code}${outcome.signal ? `，signal=${outcome.signal}` : ''}）`);
  process.exitCode = code;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * Windows 下 Node 24 的 shell:true + args 数组会触发 DEP0190；这里只传常量命令串。
 * 调用方都不把用户输入拼进 args，因此没有注入面。
 */
function spawnPortable(command, args, options) {
  if (IS_WIN) {
    return spawn([command, ...args].join(' '), { ...options, shell: true });
  }
  return spawn(command, args, { ...options, shell: false });
}

function run(command, args = [], options = {}) {
  try {
    const result = spawnSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      ...options,
    });
    if (result.error) return { code: -1, out: '', err: result.error.message };
    return { code: result.status ?? -1, out: result.stdout ?? '', err: result.stderr ?? '' };
  } catch (error) {
    return { code: -1, out: '', err: error?.message || String(error) };
  }
}

function norm(value) {
  return String(value ?? '')
    .replace(/\//g, '\\')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isUnder(value, base) {
  return value === base || value.startsWith(`${base}\\`) || value.startsWith(`${base}/`);
}

function containsPath(text, target) {
  const haystack = norm(text);
  if (!haystack.includes(target)) return false;
  let index = haystack.indexOf(target);
  while (index !== -1) {
    const next = haystack[index + target.length];
    if (next === undefined || next === '\\' || next === '"' || next === "'" || /\s/.test(next)) {
      return true;
    }
    index = haystack.indexOf(target, index + 1);
  }
  return false;
}

function displayPath(abs) {
  const rel = path.relative(ROOT, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return abs;
}

function tail(text, length) {
  const value = String(text ?? '').trim();
  return value.length > length ? value.slice(-length) : value;
}

function appendFlag(value, flag) {
  const current = String(value ?? '').trim();
  if (current.split(/\s+/).includes(flag)) return current;
  return current ? `${current} ${flag}` : flag;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function printHelp() {
  console.log(
    [
      'tauri dev 干净启动器（kojo-editor）',
      '',
      '用法：',
      '  pnpm tauri:fresh',
      '  pnpm tauri:fresh -- --clean',
      '  node tools/tauri-dev-fresh.mjs [选项]',
      '',
      '默认流程：',
      '  1. git fetch origin；本地是 origin/master 的祖先且工作树干净时，ff-only 快进；',
      '     脏树、分叉、rebase/merge 未完成、detached HEAD 下的本地提交都不会被强改。',
      '  2. 清理本工作树上一轮的 vite/tauri/cargo 残留；桌面实例与别的工作树进程先确认；',
      '     tools/smoke-*、boot-*、ui-measure 探针在跑时直接退出，不抢 1420。',
      '  3. 依据锁文件/配置指纹清理过期 node_modules/.vite；--clean 额外删 dist 与 debug exe。',
      '  4. 缺依赖或上游 package.json/锁文件变化时执行 pnpm install --frozen-lockfile。',
      '  5. 复核 1420 与桌面实例后启动 pnpm --filter @kojo/app tauri dev。',
      '',
      '选项：',
      '  --clean          清 Vite 缓存、dist、target/debug 下的 exe/pdb（顽固旧 UI 用）',
      '  --no-fetch       不联系远端（同时不自动快进；仍显示本地 origin/master 的落后量）',
      '  --no-pull        只 fetch 不自动快进，测试当前 HEAD',
      '  --no-install     依赖缺失/锁文件变化时不安装，直接失败',
      '  --install        即使已安装也重跑 pnpm install --frozen-lockfile',
      '  --no-kill        发现旧实例时只报告不终止',
      '  -y, --yes        自动确认关闭桌面实例/其它工作树进程（未保存内容可能丢失）',
      '  --no-launch      完成同步、清场、缓存和依赖检查后停在启动前',
      '  --dry-run        只预检并打印计划，不删除、不安装、不终止、不启动',
      '  --ref <ref>      主线 ref，默认 origin/master',
      '  -v, --verbose    打印进程快照数量',
      '  -h, --help       显示本帮助',
      '',
      '退出码：0=已启动/预检通过；1=前置失败；2=端口或实例被占用且未处理；130=Ctrl+C。',
      '',
      '说明：脚本不会清 WebView2 用户数据/工作区数据；它只处理 dev 生成物。',
      '      pnpm 传选项需要 `--`：pnpm tauri:fresh -- --clean',
    ].join('\n'),
  );
}
