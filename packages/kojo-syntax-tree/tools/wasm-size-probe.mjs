#!/usr/bin/env node
/**
 * wasm-size-probe.mjs —— tree-sitter wasm「体积 + 冷解析」三档对比读数（可复跑）。
 *
 * 干什么：
 *   1) 用仓库里最大的真实 `.kojo` 夹具**拼**出一个 5,000 行量级的性能档（写进 `tmp/perf-5000.txt`，
 *      拼装清单与行数原样打印，不藏口径）；
 *      ⚠ 落盘后缀刻意用 `.txt` 不用 `.kojo`：本仓库有六处递归 `endsWith('.kojo')` 的采集器
 *        （parse-corpus / fold-report / error-recovery / cst-classifyline-parity / monarch-ab /
 *        formatter.invariants），一条 5,000 行档混进去会把别人的分母与耗时一起改掉（多 agent 同树事故）。
 *   2) 对每一档 wasm 报：原始字节 / gzip(level 9) 字节 / 冷全量解析 p50 / p95。
 *
 * 解析一律在**子进程**里（`tools/_wasm-perf-child.mjs`）：见 PITFALLS 138——
 * web-tree-sitter 0.27 + Node 24 (Win) 解过一次大档后进程退出必 Zone OOM 中止。
 * ⇒ 本父进程**零 wasm**、只读子进程 stdout 的 JSON、**不看子进程退出码**（拿不到合法 JSON 才算崩）。
 *
 * 采样纪律（PITFALLS 72）：三档在**同一时间窗内轮转交替**采样（每轮顺序左旋），
 * 避免"某一档独占一段安静时间片"造成的假差值；统计量取 p50/p95（nearest-rank）。
 *
 * 用法（包目录）：
 *   node tools/wasm-size-probe.mjs [--rounds N] [标签=路径 ...]
 * 默认 N=15、三档 = 出货 wasm + tmp/w-Oz.wasm + tmp/w-O3.wasm。
 * 本脚本**不触发任何构建**：wasm 变体由 tools/README 之外的一次性 wasm-opt 后处理产出，
 * 缺文件就明确报错让人去生成，绝不去联网编。
 */
import { readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // packages/kojo-syntax-tree/tools
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const tmp = join(pkgRoot, 'tmp');
const child = join(here, '_wasm-perf-child.mjs');
const PERF_FILE = join(tmp, 'perf-5000.txt');

/** 性能档配方：真实夹具按顺序拼接（都是各自闭合的完整 `.kojo`，拼接不跨块）。 */
const RECIPE = [
  'packages/plugins/kojo-sugar/tests/goldens/corpus-k12-lumia-daily.kojo',
  'packages/plugins/kojo-sugar/tests/goldens/corpus-k12-lumia-climax.kojo',
  'fixtures/sugar/release-check.kojo',
];

function ensurePerfDoc() {
  const countLines = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  if (!existsSync(PERF_FILE)) {
    const parts = RECIPE.map((rel) => {
      const abs = join(repoRoot, rel);
      if (!existsSync(abs)) throw new Error(`真实夹具不在位：${rel}`);
      const text = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
      return { rel, lines: countLines(text), text };
    });
    writeFileSync(PERF_FILE, parts.map((p) => p.text).join('\n'));
    console.log('== 性能档构造（tmp/perf-5000.txt，真实夹具拼接）==');
    for (const p of parts) console.log(`   ${String(p.lines).padStart(5)} 行  ${p.rel}`);
    console.log(`   合计 ${parts.reduce((a, p) => a + p.lines, 0)} 行 → ${PERF_FILE.replace(repoRoot + '/', '')}`);
  } else {
    console.log(
      `== 性能档已存在：${PERF_FILE.replace(repoRoot + '/', '')}（${countLines(readFileSync(PERF_FILE, 'utf8'))} 行）；` +
        `配方=${RECIPE.join(' + ')}`,
    );
  }
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let rounds = 15;
  const vars = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rounds') rounds = Number(argv[++i]);
    else if (argv[i].includes('=')) {
      const k = argv[i].indexOf('=');
      vars.push({ label: argv[i].slice(0, k), path: resolve(pkgRoot, argv[i].slice(k + 1)) });
    }
  }
  if (!vars.length) {
    vars.push(
      { label: '现档(-Os)', path: join(pkgRoot, 'tree-sitter-kojo.wasm') },
      { label: '-Oz', path: join(tmp, 'w-Oz.wasm') },
      { label: '-O3', path: join(tmp, 'w-O3.wasm') },
    );
  }
  return { rounds, vars };
}

/** nearest-rank 百分位（1..n 取第 ceil(p*n) 个）。 */
function pct(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function runChild(wasmPath, docPath) {
  const r = spawnSync(process.execPath, [child, wasmPath, docPath], { encoding: 'utf8' });
  const line = (r.stdout || '').trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch {
    return null; // 拿不到合法 JSON 才算真崩（退出码非零不算——见头注）
  }
}

const { rounds, vars } = parseArgs();
for (const v of vars) {
  if (!existsSync(v.path)) throw new Error(`wasm 变体缺失：${v.path}（先用 wasm-opt 生成，本脚本不构建）`);
  if (!statSync(v.path).size) throw new Error(`wasm 变体是空文件：${v.path}`);
}
ensurePerfDoc();

console.log('\n== 体积 ==');
const sizeRows = vars.map((v) => {
  const buf = readFileSync(v.path);
  return { label: v.label, bytes: buf.length, gzip: gzipSync(buf, { level: 9 }).length };
});
for (const r of sizeRows) {
  console.log(`${r.label.padEnd(12)} 原始 ${String(r.bytes).padStart(8)} B   gzip ${String(r.gzip).padStart(7)} B`);
}

console.log(`\n== 冷全量解析（每子进程解一次；每档 ${rounds} 轮，同窗轮转）==`);
const samples = Object.fromEntries(vars.map((v) => [v.label, []]));
const integrity = Object.fromEntries(vars.map((v) => [v.label, { err: 0, miss: 0, crash: 0, nodes: 0 }]));
for (let round = 0; round < rounds; round++) {
  for (let i = 0; i < vars.length; i++) {
    const v = vars[(round + i) % vars.length]; // 每轮顺序左旋：交替采样消窗差
    const res = runChild(v.path, PERF_FILE);
    if (!res) {
      integrity[v.label].crash++;
      continue;
    }
    samples[v.label].push(res.ms);
    integrity[v.label].err += res.errors;
    integrity[v.label].miss += res.missing;
    integrity[v.label].nodes = res.nodes;
  }
}
const table = vars.map((v) => {
  const s = samples[v.label].slice().sort((a, b) => a - b);
  const base = integrity[v.label];
  return {
    label: v.label,
    bytes: sizeRows.find((r) => r.label === v.label).bytes,
    gzip: sizeRows.find((r) => r.label === v.label).gzip,
    p50: pct(s, 0.5),
    p95: pct(s, 0.95),
    min: s[0],
    max: s[s.length - 1],
    n: s.length,
    ...base,
  };
});
for (const t of table) {
  console.log(
    `${t.label.padEnd(12)} p50 ${t.p50.toFixed(2)}ms  p95 ${t.p95.toFixed(2)}ms  ` +
      `[min ${t.min.toFixed(1)} / max ${t.max.toFixed(1)}，n=${t.n}]  ` +
      `ERROR=${t.err} MISSING=${t.miss} 崩溃=${t.crash} CST节点=${t.nodes}`,
  );
}

const ref = table[0];
console.log('\n== 相对现档（正数=更差/更大）==');
for (const t of table.slice(1)) {
  console.log(
    `${t.label.padEnd(12)} 体积 ${(t.bytes >= ref.bytes ? '+' : '') + (t.bytes - ref.bytes)} B ` +
      `(${((t.bytes / ref.bytes - 1) * 100).toFixed(2)}%)  gzip ${(t.gzip >= ref.gzip ? '+' : '') + (t.gzip - ref.gzip)} B  ` +
      `p50 ${((t.p50 / ref.p50 - 1) * 100).toFixed(1)}%  p95 ${((t.p95 / ref.p95 - 1) * 100).toFixed(1)}%`,
  );
}
