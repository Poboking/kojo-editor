#!/usr/bin/env node
/**
 * build-v2.mjs —— Kojo 2.0（kojo2）tree-sitter 语法的一键构建。
 *
 * 三步，产物路径全部带 v2 名，**绝不覆盖 v1 的 grammar.js / src/parser.c / wasm**：
 *   1. `tree-sitter generate` → 落到 `tmp/v2-gen/`，再把三件生成物搬成
 *      `src/parser.v2.c` / `src/grammar.v2.json` / `src/node-types.v2.json`；
 *   2. 在 `tmp/v2-build/` 铺一个一次性 grammar 目录（parser.c + scanner.c + tree_sitter 头
 *      + package.json 的 tree-sitter 配置），`tree-sitter build --wasm` 编译成
 *      `tree-sitter-kojo2.wasm`（首次运行会由 CLI 自己下载 wasi-sdk / binaryen 到用户缓存目录；
 *      网络需要代理时在 shell 里先设 HTTPS_PROXY/HTTP_PROXY，本脚本不写死任何代理）；
 *   3. 若机器上能找到 binaryen 的 `wasm-opt`（CLI 缓存或 `TREE_SITTER_BINARYEN_PATH`），
 *      再跑一遍 `-Oz`（CLI 自带的是 `-Os`）把体积压到最小档——这就是本包体积棘轮的出货口径。
 *
 * 用法（本包目录，或仓库根加包路径）：
 *   node tools/build-v2.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..', '..');
const cliJs = join(repoRoot, 'node_modules', 'tree-sitter-cli', 'cli.js');
const genDir = join(pkgRoot, 'tmp', 'v2-gen');
const stageDir = join(pkgRoot, 'tmp', 'v2-build');
const srcDir = join(pkgRoot, 'src');
const outWasm = join(pkgRoot, 'tree-sitter-kojo2.wasm');

if (!existsSync(cliJs)) {
  console.error(`缺 tree-sitter CLI：${cliJs}（本包 devDeps 已声明，勿再 install）`);
  process.exit(1);
}

/** 跑 tree-sitter CLI（经 node 起，Windows 下也稳）；失败即停。 */
function ts(args, cwd = pkgRoot) {
  console.log(`\n$ tree-sitter ${args.join(' ')}`);
  const r = spawnSync(process.execPath, [cliJs, ...args], { cwd, stdio: 'inherit', env: process.env });
  if (r.status !== 0) {
    console.error(`tree-sitter ${args[0]} 失败（rc=${r.status}）`);
    process.exit(r.status ?? 1);
  }
}

function rmrf(p) {
  rmSync(p, { recursive: true, force: true });
}

// ---- 1) generate ---------------------------------------------------------
rmrf(genDir);
mkdirSync(genDir, { recursive: true });
ts(['generate', '-o', genDir, join(pkgRoot, 'grammar.v2.js')]);

copyFileSync(join(genDir, 'parser.c'), join(srcDir, 'parser.v2.c'));
copyFileSync(join(genDir, 'grammar.json'), join(srcDir, 'grammar.v2.json'));
copyFileSync(join(genDir, 'node-types.json'), join(srcDir, 'node-types.v2.json'));
console.log('\n生成物 → src/parser.v2.c / src/grammar.v2.json / src/node-types.v2.json');

// ---- 2) build --wasm -----------------------------------------------------
rmrf(stageDir);
mkdirSync(join(stageDir, 'src'), { recursive: true });
copyFileSync(join(genDir, 'parser.c'), join(stageDir, 'src', 'parser.c'));
copyFileSync(join(genDir, 'grammar.json'), join(stageDir, 'src', 'grammar.json'));
copyFileSync(join(genDir, 'node-types.json'), join(stageDir, 'src', 'node-types.json'));
cpSync(join(genDir, 'tree_sitter'), join(stageDir, 'src', 'tree_sitter'), { recursive: true });
copyFileSync(join(srcDir, 'scanner.v2.c'), join(stageDir, 'src', 'scanner.c'));
copyFileSync(join(pkgRoot, 'grammar.v2.js'), join(stageDir, 'grammar.js'));
writeFileSync(
  join(stageDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'kojo2',
      version: '0.0.0',
      private: true,
      'tree-sitter': [{ scope: 'source.kojo2', language: 'kojo2', 'file-types': ['kojo2'] }],
    },
    null,
    2,
  )}\n`,
);

ts(['build', '--wasm', '-o', outWasm, stageDir]);

// ---- 3) -Oz 等价后处理（binaryen）---------------------------------------
const wasmOpt = findWasmOpt();
if (wasmOpt) {
  const before = statSync(outWasm).size;
  console.log(`\n$ wasm-opt -Oz（${wasmOpt}）`);
  const r = spawnSync(wasmOpt, [outWasm, '-Oz', '-o', outWasm], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) {
    console.error(`wasm-opt -Oz 失败（rc=${r.status}）——保留 CLI 的 -Os 产物`);
  } else {
    console.log(`体积：${before} B（-Os）→ ${statSync(outWasm).size} B（-Oz）`);
  }
} else {
  console.log('\n未找到 wasm-opt（binaryen）⇒ 保留 CLI 的 -Os 产物；-Oz 档只在体积账里备注');
}

const bytes = statSync(outWasm).size;
const gzipBytes = (await import('node:zlib')).gzipSync(readFileSync(outWasm), { level: 9 }).length;
console.log(`\n出货 wasm：${outWasm}`);
console.log(`  原始 ${bytes} B / gzip(9) ${gzipBytes} B`);
console.log('体积棘轮在 tests/v2-wasm-size.test.ts：只降不升，涨体积要重对账并改常量。');

/** 找 wasm-opt：显式 env > tree-sitter CLI 的缓存目录（与 CLI 自己的下载落点一致）。 */
function findWasmOpt() {
  const exe = process.platform === 'win32' ? 'wasm-opt.exe' : 'wasm-opt';
  const candidates = [];
  if (process.env.TREE_SITTER_BINARYEN_PATH) {
    candidates.push(join(process.env.TREE_SITTER_BINARYEN_PATH, 'bin', exe));
  }
  const cacheRoots = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'tree-sitter'),
    process.env.XDG_CACHE_HOME && join(process.env.XDG_CACHE_HOME, 'tree-sitter'),
    process.env.HOME && join(process.env.HOME, '.cache', 'tree-sitter'),
  ].filter(Boolean);
  for (const root of cacheRoots) candidates.push(join(root, 'binaryen', 'bin', exe));
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}
