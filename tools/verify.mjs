// 统一验收 CLI：注册表驱动，只编排不改写（每个检查 = spawn 既有命令）。
// 用法: node tools/verify.mjs <检查名> [透传参数...]   |   --list（或无参数）看注册表
//   检查名: unit / typecheck / audit / erbcheck / engine / corpus / dom / ipc / measure / all
//   全局开关: --json  （每检查一行 JSON：{name,status,durationMs,note}，不打人话摘要行）
// 前置依赖: engine 需 KOJO_CLIDBG_DIR（默认 C:/DSH/vendor/clidbg-probe）内含引擎 exe 或 KOJO_CLIDBG_EXE 指到实体；
//   corpus 需 KOJO_SMOKE_PROJECT 指向真实语料目录；ipc/dom 需桌面环境；缺依赖一律 SKIP 不算 FAIL。
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
    name: 'corpus',
    describe: '真实语料集成冒烟（integration-plugins.test.ts）',
    precheck: () => {
      const p = process.env.KOJO_SMOKE_PROJECT;
      if (!p || !fs.existsSync(p)) return '需 KOJO_SMOKE_PROJECT 指向真实语料目录';
      return null;
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

function printList() {
  const width = Math.max(...CHECKS.map((c) => c.name.length));
  console.log('检查注册表（node tools/verify.mjs <名字> [参数...]）:');
  for (const c of CHECKS) {
    const reason = c.precheck();
    console.log(`  ${c.name.padEnd(width)}  ${reason ? `缺依赖: ${reason}` : '依赖就绪'}  —  ${c.describe}`);
  }
  console.log(`  ${'all'.padEnd(width)}  聚合: ${ALL_NAMES.join(', ')}（engine 需 KOJO_VERIFY_ENGINE=1，见文件头）`);
}

async function runCheck(check, argv, json) {
  const t0 = performance.now();
  const reason = check.precheck();
  const result = reason ? { status: 'SKIP', note: reason } : await check.run(argv);
  const durationMs = Math.round(performance.now() - t0);
  if (json) {
    console.log(JSON.stringify({ name: check.name, status: result.status, durationMs, note: result.note ?? '' }));
  } else if (result.status === 'PASS') {
    console.log(`PASS  ${check.name}  ${(durationMs / 1000).toFixed(1)}s`);
  } else if (result.status === 'FAIL') {
    console.log(`FAIL  ${check.name}  exit=${result.exit}  (see log above)`);
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
