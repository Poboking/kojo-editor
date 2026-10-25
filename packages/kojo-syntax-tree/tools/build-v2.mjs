#!/usr/bin/env node
/**
 * build-v2.mjs —— Kojo 2.0（kojo2）tree-sitter 语法的一键构建（**原子**：全绿才换货）。
 *
 * 四步，产物路径全部带 v2 名，**绝不覆盖 v1 的 grammar.js / src/parser.c / wasm**：
 *   1. `tree-sitter generate` → 落到 `tmp/v2-gen/`；生成物先抄进 `tmp/v2-out/`，
 *      **此时一个字节都不写 `src/`**；
 *   2. 在 `tmp/v2-build/` 铺一个一次性 grammar 目录（parser.c + scanner.c + tree_sitter 头
 *      + package.json 的 tree-sitter 配置），`tree-sitter build --wasm` 的 `-Os` 产物也落在
 *      `tmp/v2-out/`（`tree-sitter-kojo2.os.wasm`）——**不直接覆盖出货 wasm**；
 *   3. `wasm-opt -Oz` 从 `-Os` 临时件读、写**另一个**临时件（`tree-sitter-kojo2.wasm`），
 *      绝不就地覆写。binaryen 找不到 ⇒ **构建失败**（`-Oz` 是体积棘轮的出货口径，
 *      "静默出货更大的 -Os 产物"等于让棘轮对不上账）；`-Oz` rc≠0 同样失败。
 *      首次运行会由 CLI 自己下载 wasi-sdk / binaryen 到用户缓存目录；网络需要代理时
 *      在 shell 里先设 HTTPS_PROXY/HTTP_PROXY，本脚本不写死任何代理；
 *   4. **发布 = 最后一次 rename**：四件产物（`src/parser.v2.c` / `src/grammar.v2.json` /
 *      `src/node-types.v2.json` / `tree-sitter-kojo2.wasm`）在临时目录全部就绪、验过
 *      非空与 wasm 魔数之后，才逐个 `rename` 到位（同盘 rename 是原子的：要么旧文件、
 *      要么新文件，绝无半截）。
 *
 * 为什么不是"边生成边落盘"（2026-10-26 改）：旧版先把三件 src 产物 copy 进 `src/`，再编
 * wasm——编译一失败就留下"新 parser.c + 旧 wasm"的半套；`wasm-opt -Oz` 还就地覆写出货
 * wasm，rc≠0 时文件已被截断，"保留 -Os 产物"是假的。
 *
 * 用法（本包目录，或仓库根加包路径）：
 *   node tools/build-v2.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..', '..');
const cliJs = join(repoRoot, 'node_modules', 'tree-sitter-cli', 'cli.js');
const genDir = join(pkgRoot, 'tmp', 'v2-gen');
const stageDir = join(pkgRoot, 'tmp', 'v2-build');
const outDir = join(pkgRoot, 'tmp', 'v2-out');
const srcDir = join(pkgRoot, 'src');
const outWasm = join(pkgRoot, 'tree-sitter-kojo2.wasm');

if (!existsSync(cliJs)) {
  console.error(`缺 tree-sitter CLI：${cliJs}（本包 devDeps 已声明，勿再 install）`);
  process.exit(1);
}

/** 跑 tree-sitter CLI（经 node 起，Windows 下也稳）；失败即停（此时 src/ 与出货 wasm 原封不动）。 */
function ts(args, cwd = pkgRoot) {
  console.log(`\n$ tree-sitter ${args.join(' ')}`);
  const r = spawnSync(process.execPath, [cliJs, ...args], { cwd, stdio: 'inherit', env: process.env });
  if (r.status !== 0) {
    console.error(`tree-sitter ${args[0]} 失败（rc=${r.status}）——出货产物未改动`);
    process.exit(r.status ?? 1);
  }
}

function rmrf(p) {
  rmSync(p, { recursive: true, force: true });
}

/** 发布前的最后一道验：存在、非空（防 0 字节/半截蒙过去）。 */
function assertArtifact(path, what) {
  if (!existsSync(path)) {
    console.error(`${what} 没产出：${path}——出货产物未改动`);
    process.exit(1);
  }
  const size = statSync(path).size;
  if (size === 0) {
    console.error(`${what} 是 0 字节：${path}——出货产物未改动`);
    process.exit(1);
  }
  return size;
}

// ---- 0) 清临时区（src/ 与出货 wasm 此刻仍原封不动）----------------------
rmrf(genDir);
rmrf(outDir);
mkdirSync(genDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

// ---- 1) generate → tmp，生成物只暂存到 tmp/v2-out -------------------------
ts(['generate', '-o', genDir, join(pkgRoot, 'grammar.v2.js')]);

const stagedParserC = join(outDir, 'parser.v2.c');
const stagedGrammar = join(outDir, 'grammar.v2.json');
const stagedNodeTypes = join(outDir, 'node-types.v2.json');
copyFileSync(join(genDir, 'parser.c'), stagedParserC);
copyFileSync(join(genDir, 'grammar.json'), stagedGrammar);
copyFileSync(join(genDir, 'node-types.json'), stagedNodeTypes);
console.log('\n生成物已暂存 tmp/v2-out/（尚未动 src/）');

// ---- 2) build --wasm（-Os）→ tmp/v2-out --------------------------------
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

const osWasm = join(outDir, 'tree-sitter-kojo2.os.wasm');
ts(['build', '--wasm', '-o', osWasm, stageDir]);
const osBytes = assertArtifact(osWasm, 'wasm（-Os 档）');

// ---- 3) wasm-opt -Oz：读临时件、写另一个临时件（绝不就地覆写）---------------
const wasmOpt = findWasmOpt();
if (!wasmOpt) {
  console.error(
    '\n未找到 wasm-opt（binaryen）⇒ 构建失败：`-Oz` 是出货体积口径（tests/v2-wasm-size.test.ts 的棘轮），' +
      '缺它就等于静默出货更大的 -Os 产物。装 binaryen 或设 TREE_SITTER_BINARYEN_PATH 后重跑；' +
      '出货产物未改动。',
  );
  process.exit(1);
}
const ozWasm = join(outDir, 'tree-sitter-kojo2.wasm');
console.log(`\n$ wasm-opt -Oz（${wasmOpt}）`);
const r = spawnSync(wasmOpt, [osWasm, '-Oz', '-o', ozWasm], { stdio: 'inherit', env: process.env });
if (r.status !== 0) {
  console.error(`wasm-opt -Oz 失败（rc=${r.status}）——构建失败，出货产物未改动（不拿 -Os 顶 -Oz）`);
  process.exit(r.status ?? 1);
}
const ozBytes = assertArtifact(ozWasm, 'wasm（-Oz 档）');
// 魔数验一遍：wasm-opt 写坏了能被棘轮之外的所有测试继承，这里先拦。
const magic = [...readFileSync(ozWasm).subarray(0, 4)];
if (magic.join(',') !== '0,97,115,109') {
  console.error(`-Oz 产物不是 wasm（魔数 ${magic.join(',')}）——出货产物未改动`);
  process.exit(1);
}
console.log(`体积：${osBytes} B（-Os）→ ${ozBytes} B（-Oz）`);

// ---- 4) 发布：四件产物一次 rename（同盘 rename 原子）--------------------
const plan = [
  [stagedParserC, join(srcDir, 'parser.v2.c'), 'src/parser.v2.c'],
  [stagedGrammar, join(srcDir, 'grammar.v2.json'), 'src/grammar.v2.json'],
  [stagedNodeTypes, join(srcDir, 'node-types.v2.json'), 'src/node-types.v2.json'],
  [ozWasm, outWasm, 'tree-sitter-kojo2.wasm'],
];
// 先把四件全部验完再动第一个 rename：任何一件不合规都不发布。
for (const [from, , what] of plan) assertArtifact(from, what);
console.log('\n发布（rename）：');
for (const [from, to, what] of plan) {
  renameSync(from, to);
  console.log(`  ${what} ← tmp（${statSync(to).size} B）`);
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
