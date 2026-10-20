#!/usr/bin/env node
/**
 * parse-corpus.mjs —— ERB 结构语法在**真实语料**上的全量解析读数。
 *
 * 判据（BOARD ERB-TS-STRUCTURE）：合法文件 ERROR / MISSING 为 0；不支持的构造要么修语法，
 * 要么进白名单钉住。本工具只读语料盘，不写任何文件。
 *
 * 用法（仓库根）：
 *   node packages/erb-syntax-tree/tools/parse-corpus.mjs
 *   node packages/erb-syntax-tree/tools/parse-corpus.mjs --corpus <语料根>
 *   node packages/erb-syntax-tree/tools/parse-corpus.mjs --limit 200 --json
 *
 * 语料定位走仓库统一口径 `tools/corpus.mjs`（KOJO_CORPUS_DIR > 自动发现）。
 */
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const wasmPath = join(pkgRoot, 'tree-sitter-erb.wasm');
const worker = join(here, '_corpus-worker.mjs');
const BATCH = 100;

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const json = args.includes('--json');
const limit = Number(opt('--limit') ?? 0);

function findDir(root, name) {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.toLowerCase() === name.toLowerCase()) return join(root, e.name);
  }
  return null;
}

function collect(dir, out) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (/\.(erb|erh)$/i.test(e.name)) out.push(p);
  }
  return out;
}

let corpus;
try {
  const { resolveCorpusDir } = await import(pathToFileURL(join(repoRoot, 'tools', 'corpus.mjs')).href);
  corpus = resolveCorpusDir({ explicit: opt('--corpus'), label: 'erb-parse' });
} catch (e) {
  console.error(`[erb-parse] ${e?.message ?? e}`);
  process.exit(2);
}
if (!corpus) {
  console.error('[erb-parse] 未发现语料；设 KOJO_CORPUS_DIR=<语料目录> 后重跑');
  process.exit(2);
}
const erbDir = findDir(corpus, 'erb');
if (!erbDir) {
  console.error(`[erb-parse] 语料根下没有 ERB/：${corpus}`);
  process.exit(2);
}

const files = collect(erbDir, []).sort();
const selected = limit > 0 ? files.slice(0, limit) : files;

const results = [];
for (let i = 0; i < selected.length; i += BATCH) {
  const chunk = selected.slice(i, i + BATCH);
  const r = spawnSync(process.execPath, [worker, wasmPath, 'parse', ...chunk], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  if (lines.length !== chunk.length) {
    console.error(`[erb-parse] 批次 ${i / BATCH + 1} 输出不完整（${lines.length}/${chunk.length}）stderr=${(r.stderr || '').slice(0, 300)}`);
  }
  for (let j = 0; j < chunk.length; j++) {
    let parsed = null;
    try {
      parsed = JSON.parse(lines[j] ?? '');
    } catch {
      /* 该文件按崩溃计 */
    }
    results.push(parsed ?? { file: chunk[j], crash: 1, errors: 0, missing: 0, errRows: ['worker 无输出'], ms: 0 });
  }
  if (!json) {
    process.stdout.write(`\r[erb-parse] ${Math.min(i + BATCH, selected.length)}/${selected.length}`);
  }
}
if (!json) process.stdout.write('\n');

const crashed = results.filter((r) => r.crash);
const faulty = results.filter((r) => !r.crash && r.errors + r.missing > 0);
const totalErr = results.reduce((n, r) => n + (r.errors || 0), 0);
const totalMissing = results.reduce((n, r) => n + (r.missing || 0), 0);
const totalMs = results.reduce((n, r) => n + (r.ms || 0), 0);
const msList = results.map((r) => r.ms || 0).sort((a, b) => a - b);
const pct = (p) => msList.length === 0 ? 0 : msList[Math.min(msList.length - 1, Math.floor(msList.length * p))];

const summary = {
  corpus,
  files: selected.length,
  totalFiles: files.length,
  lines: results.reduce((n, r) => n + (r.lines || 0), 0),
  crashed: crashed.length,
  faultyFiles: faulty.length,
  errors: totalErr,
  missing: totalMissing,
  parseMs: Math.round(totalMs),
  p50Ms: Math.round(pct(0.5) * 100) / 100,
  p95Ms: Math.round(pct(0.95) * 100) / 100,
  slowest: [...results].sort((a, b) => (b.ms || 0) - (a.ms || 0)).slice(0, 5).map((r) => ({ file: r.file, ms: r.ms, lines: r.lines, errors: r.errors, missing: r.missing })),
  offenders: faulty.slice(0, 20).map((r) => ({ file: r.file, errors: r.errors, missing: r.missing, at: r.errRows })),
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`语料          : ${corpus}`);
  console.log(`文件          : ${summary.files}${summary.totalFiles !== summary.files ? `（限 ${summary.files}/${summary.totalFiles}）` : ''} / ${summary.lines} 行`);
  console.log(`崩溃          : ${summary.crashed}`);
  console.log(`ERROR 节点    : ${summary.errors}`);
  console.log(`MISSING 节点  : ${summary.missing}`);
  console.log(`有残留的文件  : ${summary.faultyFiles}`);
  console.log(`解析墙钟      : ${summary.parseMs}ms（p50 ${summary.p50Ms} / p95 ${summary.p95Ms}ms）`);
  console.log(`最慢 5 份     : ${summary.slowest.map((r) => `${r.file.split(/[\\/]/).pop()} ${r.ms}ms/${r.lines}行`).join('，')}`);
  if (summary.offenders.length > 0) {
    console.log('残留样本      :');
    for (const r of summary.offenders) console.log(`  ${r.file} :: ERROR=${r.errors} MISSING=${r.missing} @ ${r.at.join(',')}`);
  }
}

process.exit(summary.crashed === 0 && summary.errors === 0 && summary.missing === 0 ? 0 : 1);
