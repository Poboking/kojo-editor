#!/usr/bin/env node
/**
 * perf-probe.mjs —— ERB 结构语法的大文件读数：首解 / 每击键增量重解 p95 / 内存。
 *
 * 口径：
 *   · 首解 = `Language.load` + `parser.parse(全文)`（wasm 初始化单列）；
 *   · 每击键 = 在轮换的行首插入一个空格，`tree.edit` + 增量 `parse(text, tree)` 的墙钟；
 *     p50 / p95 / max 取 N 次增量重解（默认 60 次，避开首解冷启动）；
 *   · 内存 = 首解后 / 增量轮后的 `process.memoryUsage()`（rss / heapUsed / external）。
 *
 * 用法（仓库根）：
 *   node packages/erb-syntax-tree/tools/perf-probe.mjs --file "C:/.../BIG.ERB"
 *   node packages/erb-syntax-tree/tools/perf-probe.mjs            # 自动选语料里最大的文件
 *   node packages/erb-syntax-tree/tools/perf-probe.mjs --edits 120 --json
 */
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Parser, Language } from 'web-tree-sitter';
import { compileQuery, parseStructureText } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const wasmPath = join(pkgRoot, 'tree-sitter-erb.wasm');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const json = args.includes('--json');
const edits = Number(opt('--edits') ?? 60);

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

let file = opt('--file') ? resolve(opt('--file')) : null;
if (!file) {
  let corpus = opt('--corpus');
  if (!corpus) {
    const { resolveCorpusDir } = await import(pathToFileURL(join(repoRoot, 'tools', 'corpus.mjs')).href);
    try {
      corpus = resolveCorpusDir({ label: 'erb-perf' });
    } catch (e) {
      console.error(`[erb-perf] ${e?.message ?? e}`);
      process.exit(2);
    }
  }
  if (!corpus) {
    console.error('[erb-perf] 未发现语料；用 --file 指定文件，或设 KOJO_CORPUS_DIR=<语料目录>');
    process.exit(2);
  }
  const erbDir = findDir(corpus, 'erb');
  if (!erbDir) {
    console.error(`[erb-perf] 语料根下没有 ERB/：${corpus}`);
    process.exit(2);
  }
  const files = collect(erbDir, []);
  files.sort((a, b) => statSync(b).size - statSync(a).size);
  file = files[0];
  console.log(`[erb-perf] 自动选最大文件：${file}（${(statSync(file).size / 1024 / 1024).toFixed(2)} MB）`);
}

const mem = (u) => ({
  rssMB: Math.round((u.rss / 1024 / 1024) * 10) / 10,
  heapMB: Math.round((u.heapUsed / 1024 / 1024) * 10) / 10,
  externalMB: Math.round((u.external / 1024 / 1024) * 10) / 10,
});

let text = readFileSync(file, 'utf8');
if (!text.endsWith('\n')) text += '\n'; // 与 parseStructureText 同口径，行首坐标不受影响
const lineStarts = [0];
for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);

const tInit = performance.now();
await Parser.init();
const language = await Language.load(wasmPath);
const initMs = performance.now() - tInit;

const parser = new Parser();
parser.setLanguage(language);
const query = compileQuery(language, readFileSync(join(pkgRoot, 'queries', 'folds.scm'), 'utf8'));

const tFirst = performance.now();
let tree = parseStructureText(parser, text);
const firstParseMs = performance.now() - tFirst;

let errors = 0;
let missing = 0;
const stack = [tree.rootNode];
while (stack.length) {
  const n = stack.pop();
  if (n.isMissing) missing++;
  else if (n.type === 'ERROR') errors++;
  for (const c of n.children) stack.push(c);
}
const folds = query.matches(tree.rootNode).reduce((n, m) => n + m.captures.filter((c) => c.name === 'fold').length, 0);
const memAfterFirst = mem(process.memoryUsage());

const samples = [];
let lineCursor = Math.max(1, Math.floor(lineStarts.length / 3));
for (let i = 0; i < edits; i++) {
  lineCursor = 1 + ((lineCursor + 7919) % Math.max(1, lineStarts.length - 1));
  const offset = lineStarts[lineCursor];
  const row = lineCursor;
  text = `${text.slice(0, offset)} ${text.slice(offset)}`;
  // 行首插入后，本行起点不变、后续行起点全部 +1。
  for (let k = lineCursor + 1; k < lineStarts.length; k++) lineStarts[k] += 1;

  tree.edit({
    startIndex: offset,
    oldEndIndex: offset,
    newEndIndex: offset + 1,
    startPosition: { row, column: 0 },
    oldEndPosition: { row, column: 0 },
    newEndPosition: { row, column: 1 },
  });
  const t0 = performance.now();
  const next = parser.parse(text, tree); // 增量：带旧树，测的才是每击键重解
  samples.push(performance.now() - t0);
  tree.delete();
  tree = next;
}
const memAfterEdits = mem(process.memoryUsage());

const sorted = [...samples].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const round = (n) => Math.round(n * 100) / 100;
const summary = {
  file,
  lines: lineStarts.length,
  bytes: Buffer.byteLength(text, 'utf8'),
  initMs: round(initMs),
  firstParseMs: round(firstParseMs),
  errors,
  missing,
  folds,
  edits,
  editP50Ms: round(pct(0.5)),
  editP95Ms: round(pct(0.95)),
  editMaxMs: round(sorted[sorted.length - 1] ?? 0),
  memAfterFirst,
  memAfterEdits,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`文件            : ${file}`);
  console.log(`规模            : ${summary.lines} 行 / ${(summary.bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`wasm 初始化     : ${summary.initMs}ms`);
  console.log(`首解            : ${summary.firstParseMs}ms（ERROR ${errors} / MISSING ${missing} / @fold ${folds}）`);
  console.log(`每击键增量重解  : p50 ${summary.editP50Ms}ms / p95 ${summary.editP95Ms}ms / max ${summary.editMaxMs}ms（${edits} 次）`);
  console.log(`内存（首解后）  : rss ${memAfterFirst.rssMB}MB / heap ${memAfterFirst.heapMB}MB / external ${memAfterFirst.externalMB}MB`);
  console.log(`内存（增量后）  : rss ${memAfterEdits.rssMB}MB / heap ${memAfterEdits.heapMB}MB / external ${memAfterEdits.externalMB}MB`);
}

tree.delete();
parser.delete();
process.exit(errors + missing === 0 ? 0 : 1);
