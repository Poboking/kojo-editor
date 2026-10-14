// 统一验收 CLI：注册表驱动，只编排不改写（每个检查 = spawn 既有命令）。
// 用法: node tools/verify.mjs <检查名> [透传参数...]   |   --list（或无参数）看注册表
//   检查名: unit / typecheck / audit / erbcheck / engine / corpus / dom / ipc / measure / all
//   全局开关: --json  （每检查一行 JSON：{name,status,durationMs,note}，不打人话摘要行）
// 前置依赖: engine 需 KOJO_CLIDBG_DIR（默认 C:/DSH/vendor/clidbg-probe）内含引擎 exe 或 KOJO_CLIDBG_EXE 指到实体；
//   corpus 需 KOJO_SMOKE_PROJECT 指向真实语料目录（该闸仍显式 opt-in，见下）；ipc/dom 需桌面环境；缺依赖一律 SKIP 不算 FAIL。
//   loadtest 的语料目录**认内容不认名**（tools/corpus.mjs：--corpus > KOJO_CORPUS_DIR > 扫 C:/game/* 筛 ERB/+CSV/）；
//   KOJO_CORPUS_DIR 设了但不成立 = 硬失败（列盘上候选、非零退出），不静默换版本。
// all 取舍: 只跑无需额外参数的检查（unit/typecheck/audit/erbcheck + 条件可跑的 corpus），
//   dom/ipc/measure 属桌面冒烟（分钟级、单实例）不进 all；
//   engine 在 all 中为显式 opt-in——须同时满足 KOJO_VERIFY_ENGINE=1 且引擎沙盒存在，
//   届时对仓库 golden（kojo-sugar/tests/goldens/corpus-k12-lumia-sekumara.kojo）跑全链路。
// 退出码: 失败检查数（封顶 9）；未知子命令 → 用法 + 退出码 2。
'use strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCorpusDir, corpusHint, CorpusError } from './corpus.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = 'packages/plugins/kojo-sugar/tests/goldens/corpus-k12-lumia-sekumara.kojo';

// ── spawn 帮助：顺序执行、stdio 继承、env 原样透传；pnpm 条目在 win32 走 shell ──
function shNode(args, extraEnv) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: REPO, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
    p.on('close', (c) => resolve(c ?? 1));
    p.on('error', () => resolve(1));
  });
}
function sh(cmd, args) {
  return new Promise((resolve) => {
    // win32 走 shell（pnpm 是 .cmd）；拼成单命令串以免 DEP0190 警告刷屏。
    const p = process.platform === 'win32'
      ? spawn([cmd, ...args].join(' '), { cwd: REPO, stdio: 'inherit', env: process.env, shell: true })
      : spawn(cmd, args, { cwd: REPO, stdio: 'inherit', env: process.env });
    p.on('close', (c) => resolve(c ?? 1));
    p.on('error', () => resolve(1));
  });
}

function engineExePath() {
  if (process.env.KOJO_CLIDBG_EXE) return process.env.KOJO_CLIDBG_EXE;
  const dir = process.env.KOJO_CLIDBG_DIR || 'C:/DSH/vendor/clidbg-probe';
  return path.join(dir, 'Emuera_skiaV16_x64.exe');
}
const exitToResult = (code) => (code === 0 ? { status: 'PASS' } : { status: 'FAIL', exit: code });

// 语料前置检查：precheck 返回 string = SKIP（缺依赖），返回 { hardFail } = FAIL（env 指错了不许装作没看见），null = 就绪。
// quiet=true 只判定不打印（真正的选择说明由被 spawn 的子进程打一次，避免同一条刷两遍）。
function corpusPrecheck(quiet = false) {
  try {
    const dir = resolveCorpusDir({ print: !quiet, label: 'verify' });
    return dir ? null : `未发现符合内容条件的语料目录（需 ERB/ 与 CSV/）；${corpusHint()}`;
  } catch (e) {
    return { hardFail: e instanceof CorpusError ? e.message : String(e) };
  }
}

const CHECKS = [
  {
    name: 'unit',
    describe: '全量单元测试（pnpm test）',
    precheck: () => null,
    run: async () => exitToResult(await sh('pnpm', ['test'])),
  },
  {
    name: 'typecheck',
    describe: '双 typecheck：root tsc + @kojo/app（两者都必须过）',
    precheck: () => null,
    run: async () => {
      const root = await sh('pnpm', ['typecheck']);
      if (root !== 0) return { status: 'FAIL', exit: root };
      return exitToResult(await sh('pnpm', ['--filter', '@kojo/app', 'typecheck']));
    },
  },
  {
    name: 'audit',
    describe: '解耦审计 A–D（tools/audit-decoupling.mjs）',
    precheck: () => null,
    run: async () => exitToResult(await shNode(['tools/audit-decoupling.mjs'])),
  },
  {
    name: 'erbcheck',
    describe: 'ERB 真实语料对拍冒烟（erbcheck.smoke.test.ts）',
    precheck: () => null,
    // pnpm test:erbcheck 的内联 env 写法（KOJO_ERB_CHECK=1 ...）在 win32 cmd 下必挂；
    // 按 AGENTS.md 惯例改经 node vitest.mjs 起并注入 env——语义同该脚本，不改脚本本身。
    run: async () =>
      exitToResult(await shNode(
        ['node_modules/vitest/vitest.mjs', 'run', 'packages/plugins/kojo-sugar/tests/erbcheck.smoke.test.ts'],
        { KOJO_ERB_CHECK: '1' },
      )),
  },
  {
    name: 'engine',
    describe: 'kojo→ERB→真引擎全链路（clidbg-run.cjs，参数透传）',
    precheck: () => {
      const exe = engineExePath();
      return fs.existsSync(exe) ? null : `引擎沙盒缺失: ${exe}（可用 KOJO_CLIDBG_DIR / KOJO_CLIDBG_EXE 覆盖）`;
    },
    run: async (argv) => {
      if (argv.length === 0) return { status: 'SKIP', note: '用法: pnpm verify engine <文件.kojo> [函数名...]' };
      return exitToResult(await shNode(['tools/clidbg-run.cjs', ...argv]));
    },
  },
  {
    name: 'engine-setup',
    describe: 'CliDebug 引擎重建安装（engine-setup.mjs：dotnet 检查→clone→publish→安装→冒烟；分钟级，不进 all）',
    precheck: () => {
      const exe = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
      const found = (process.env.PATH || '').split(path.delimiter)
        .some((d) => { try { return d && fs.existsSync(path.join(d, exe)); } catch { return false; } });
      return found ? null : '缺 dotnet SDK（winget install Microsoft.DotNet.SDK.8；工具本身缺 SDK 会退出码 2 并打印提示）';
    },
    run: async (argv) => exitToResult(await shNode(['tools/engine-setup.mjs', ...argv])),
  },
  {
    name: 'loadtest',
    describe: '整包加载实测（engine-loadtest.mjs，硬链接镜像 + 双跑增量警告对拍；分钟级，不进 all）',
    precheck: () => {
      const exe = engineExePath();
      if (!fs.existsSync(exe)) return `引擎 exe 缺失: ${exe}（可用 KOJO_CLIDBG_DIR / KOJO_CLIDBG_EXE 覆盖）`;
      return corpusPrecheck(true) ?? null;
    },
    run: async (argv) => exitToResult(await shNode(['tools/engine-loadtest.mjs', ...argv])),
  },
  {
    name: 'scene',
    describe: '场景级台词断言（scene-run.cjs <场景.json…>，状态注入+正则断言+sourceMap 回映；不传参=跑 tools/scenes/ 全套）',
    precheck: () => {
      const exe = engineExePath();
      return fs.existsSync(exe) ? null : `引擎 exe 缺失: ${exe}（可用 KOJO_CLIDBG_DIR / KOJO_CLIDBG_EXE 覆盖）`;
    },
    run: async (argv) => exitToResult(await shNode(['tools/scene-run.cjs', ...argv])),
  },
  {
    name: 'corpus',
    describe: '真实语料集成冒烟（integration-plugins.test.ts）',
    precheck: () => {
      const p = process.env.KOJO_SMOKE_PROJECT;
      if (p && fs.existsSync(p)) return null;
      // 仍要显式 KOJO_SMOKE_PROJECT（跑全量不许带它，见 AGENTS.md §三）；这里只把「现在能指向哪」打出来。
      const found = (() => { try { return resolveCorpusDir({ print: false }); } catch { return null; } })();
      return `需 KOJO_SMOKE_PROJECT 指向真实语料目录${found ? `（按内容发现的候选: ${found}）` : ''}`;
    },
    run: async () =>
      exitToResult(await shNode(['node_modules/vitest/vitest.mjs', 'run', 'packages/kernel/tests/integration-plugins.test.ts'])),
  },
  {
    name: 'dom',
    describe: '桌面壳 DOM 冒烟（smoke-tauri-dom.mjs）',
    precheck: () => null,
    run: async () => exitToResult(await shNode(['tools/smoke-tauri-dom.mjs'])),
  },
  {
    name: 'ipc',
    describe: '真实 IPC 双闸冒烟（smoke-tauri-ipc.mjs，需游戏目录参数）',
    precheck: () => null,
    run: async (argv) => {
      if (argv.length === 0) return { status: 'SKIP', note: '用法: pnpm verify ipc <游戏目录>' };
      return exitToResult(await shNode(['tools/smoke-tauri-ipc.mjs', ...argv]));
    },
  },
  {
    name: 'measure',
    describe: 'UI 测量报告（ui-measure.mjs <out.json>，报告型：退出码定过）',
    precheck: () => null,
    run: async (argv) => exitToResult(await shNode(['tools/ui-measure.mjs', ...argv])),
  },
];

const ALL_NAMES = ['unit', 'typecheck', 'audit', 'erbcheck', 'engine', 'corpus'];

// precheck 返回值三态：null=就绪 / string=缺依赖(SKIP) / {hardFail}=前置指错了(FAIL)。
const preNote = (reason) => (typeof reason === 'object' && reason !== null ? reason.hardFail : reason);

function printList() {
  const width = Math.max(...CHECKS.map((c) => c.name.length));
  console.log('检查注册表（node tools/verify.mjs <名字> [参数...]）:');
  for (const c of CHECKS) {
    const reason = c.precheck();
    const note = preNote(reason);
    console.log(`  ${c.name.padEnd(width)}  ${note ? (typeof reason === 'object' && reason !== null ? `前置有误: ${note}` : `缺依赖: ${note}`) : '依赖就绪'}  —  ${c.describe}`);
  }
  console.log(`  ${'all'.padEnd(width)}  聚合: ${ALL_NAMES.join(', ')}（engine 需 KOJO_VERIFY_ENGINE=1，见文件头）`);
}

async function runCheck(check, argv, json) {
  const t0 = performance.now();
  const reason = check.precheck();
  const hardFail = typeof reason === 'object' && reason !== null;
  const result = hardFail
    ? { status: 'FAIL', exit: 2, note: reason.hardFail }
    : reason ? { status: 'SKIP', note: reason } : await check.run(argv);
  const durationMs = Math.round(performance.now() - t0);
  if (json) {
    console.log(JSON.stringify({ name: check.name, status: result.status, durationMs, note: result.note ?? '' }));
  } else if (result.status === 'PASS') {
    console.log(`PASS  ${check.name}  ${(durationMs / 1000).toFixed(1)}s`);
  } else if (result.status === 'FAIL') {
    console.log(`FAIL  ${check.name}  exit=${result.exit}  ${result.note ? result.note + '  ' : ''}(see log above)`);
  } else {
    console.log(`SKIP  ${check.name}  ${result.note}`);
  }
  return result.status;
}

const raw = process.argv.slice(2);
const json = raw.includes('--json');
const args = raw.filter((a) => a !== '--json');
const [cmd, ...rest] = args;

let passed = 0;
let failed = 0;
let skipped = 0;
const tally = (s) => (s === 'PASS' ? passed++ : s === 'FAIL' ? failed++ : skipped++);

if (!cmd || cmd === '--list') {
  printList();
  process.exit(0);
}

if (cmd === 'all') {
  for (const name of ALL_NAMES) {
    const check = CHECKS.find((c) => c.name === name);
    if (name === 'engine') {
      // engine 在 all 中显式 opt-in（见文件头取舍）：跑仓库 golden。
      const opted = process.env.KOJO_VERIFY_ENGINE === '1';
      const reason = !opted
        ? 'all 中 engine 为 opt-in：设 KOJO_VERIFY_ENGINE=1 后随 all 跑 golden，或单独 pnpm verify engine <文件>'
        : check.precheck();
      tally(reason ? SKIP_LINE(json, 'engine', reason) : await runCheck(check, [GOLDEN], json));
    } else {
      tally(await runCheck(check, [], json));
    }
  }
  for (const name of ['dom', 'ipc', 'measure']) tally(SKIP_LINE(json, name, 'all 不含桌面冒烟，单独跑'));
} else {
  const check = CHECKS.find((c) => c.name === cmd);
  if (!check) {
    console.error(`未知检查: ${cmd}`);
    printList();
    process.exit(2);
  }
  tally(await runCheck(check, rest, json));
}

function SKIP_LINE(json, name, note) {
  if (json) console.log(JSON.stringify({ name, status: 'SKIP', durationMs: 0, note }));
  else console.log(`SKIP  ${name}  ${note}`);
  return 'SKIP';
}

if (!json) console.log(`verify: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(Math.min(failed, 9));
