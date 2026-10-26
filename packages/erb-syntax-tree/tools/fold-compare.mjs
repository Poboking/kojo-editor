#!/usr/bin/env node
/**
 * fold-compare.mjs —— tree-sitter 折叠区间与现有 ERB 折叠服务**逐项对拍**（真实语料）。
 *
 * 两侧口径：
 *   · 服务侧 = `erbFoldingRanges(text)` 的 1 基行（函数块 + 控制流整块 + 分支段）；
 *   · 语法侧 = `folds.scm` 的 0 基行 +1（function_block / 各配对 block / branch_block / skip_block /
 *     continuation_block）。
 *
 * 判据（BOARD ERB-TS-STRUCTURE「折叠区间与服务逐项对拍」）：
 *   合法文件（0 ERROR / 0 MISSING）上，**服务侧的每个区间都必须被语法侧原样给出或被其包含**——
 *   语法侧可以多给（`[SKIPSTART]` 块、`{`…`}` 行连接块、块头段由整块覆盖），但不能比现有服务少折。
 *   服务侧多在「块头段」（开块行 → 首个分支前一行）：语法侧没有对应节点，由整块区间包含即可。
 *   `--gate`：存在未被包含的服务区间或崩溃时退 1（默认只读数）。
 *
 * **基线不是绿的**：A2 之前 erafl 就有 19 条，其中 5 条与文法无关（4 条空函数体 + 1 条函数尾部空行，
 * 服务侧给区间、语法侧按零跨度滤掉）。看 A2/B 有没有引入回归要看**集合包含**，不看总数（PITFALLS 227）。
 *
 * 用法（仓库根）：
 *   node packages/erb-syntax-tree/tools/fold-compare.mjs
 *   node packages/erb-syntax-tree/tools/fold-compare.mjs --limit 300 --gate --json
 */
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readErbText } from './text-read.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
// KOJO_ERB_WASM：A/B 对拍用（指向另一份 wasm，例如 HEAD 版），平时不设。
const wasmPath = process.env.KOJO_ERB_WASM ?? join(pkgRoot, 'tree-sitter-erb.wasm');
const worker = join(here, '_corpus-worker.mjs');
const BATCH = 100;

// 真源模块用无扩展名相对导入（`./scanner`）；Node 类型擦除只认显式 .ts，这里补一条解析钩子。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$|\.json$/i.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        /* 落回原 specifier，让 Node 报真实错误 */
      }
    }
    return nextResolve(specifier, context);
  },
});

const { erbFoldingRanges } = await import(
  pathToFileURL(join(repoRoot, 'packages', 'plugins', 'erb-parser', 'src', 'folding.ts')).href
);

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const json = args.includes('--json');
const gate = args.includes('--gate');
const limit = Number(opt('--limit') ?? 0);
const sampleSize = Number(opt('--sample') ?? 8);

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
  corpus = resolveCorpusDir({ explicit: opt('--corpus'), label: 'erb-fold' });
} catch (e) {
  console.error(`[erb-fold] ${e?.message ?? e}`);
  process.exit(2);
}
if (!corpus) {
  console.error('[erb-fold] 未发现语料；设 KOJO_CORPUS_DIR=<语料目录> 后重跑');
  process.exit(2);
}
const erbDir = findDir(corpus, 'erb');
if (!erbDir) {
  console.error(`[erb-fold] 语料根下没有 ERB/：${corpus}`);
  process.exit(2);
}
const all = collect(erbDir, []).sort();
const files = limit > 0 ? all.slice(0, limit) : all;
const key = (r) => `${r.startLine}:${r.endLine}`;

const rows = [];
for (let i = 0; i < files.length; i += BATCH) {
  const chunk = files.slice(i, i + BATCH);
  const r = spawnSync(process.execPath, [worker, wasmPath, 'fold', ...chunk], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  if (lines.length !== chunk.length) {
    console.error(`[erb-fold] 批次 ${i / BATCH + 1} 输出不完整（${lines.length}/${chunk.length}）stderr=${(r.stderr || '').slice(0, 300)}`);
  }
  for (let j = 0; j < chunk.length; j++) {
    let parsed = null;
    try {
      parsed = JSON.parse(lines[j] ?? '');
    } catch {
      /* 下面补位 */
    }
    rows.push(parsed ?? { file: chunk[j], crash: 1, errRows: ['worker 无输出'] });
  }
  if (!json) process.stdout.write(`\r[erb-fold] ${Math.min(i + BATCH, files.length)}/${files.length}`);
}
if (!json) process.stdout.write('\n');

let tsTotal = 0;
let svcTotal = 0;
let exact = 0;
let tsOnly = 0;
let svcOnly = 0;
let svcBlankTail = 0;
let svcUncontained = 0;
let legalFiles = 0;
let illegalFiles = 0;
const uncontainedSamples = [];
const tsOnlySamples = [];
let filesExact = 0;

for (const row of rows) {
  if (row.crash) continue;
  const text = readErbText(row.file);
  const lines = text.split(/\r?\n/);
  const blank = (line) => /^[ \t\r]*$/.test(lines[line - 1] ?? '');
  const svc = erbFoldingRanges(text);
  const ts = (row.folds || []).map((f) => ({ startLine: f.startRow + 1, endLine: f.endRow + 1 }));
  const tsSet = new Set(ts.map(key));
  const svcSet = new Set(svc.map(key));
  tsTotal += ts.length;
  svcTotal += svc.length;
  if (row.errors + row.missing > 0) illegalFiles++;
  else legalFiles++;

  let fileExact = true;
  for (const s of svc) {
    if (tsSet.has(key(s))) {
      exact++;
      continue;
    }
    svcOnly++;
    fileExact = false;
    const contained = ts.some((t) => t.startLine <= s.startLine && t.endLine >= s.endLine);
    if (contained) continue;
    // 服务侧函数区间止于「下一条 @ 前一行」，会把尾部空行也算进折叠；语法侧停在最后一个结构行。
    // 结构相同、只多空行 ⇒ 归「空行尾巴」，不算少折。
    const blankTail = ts.some((t) => {
      if (t.startLine > s.startLine || t.endLine > s.endLine || t.endLine < s.startLine) return false;
      for (let line = t.endLine + 1; line <= s.endLine; line++) if (!blank(line)) return false;
      return true;
    });
    if (blankTail) {
      svcBlankTail++;
      continue;
    }
    svcUncontained++;
    if (uncontainedSamples.length < sampleSize) {
      uncontainedSamples.push({ file: row.file, range: s, err: row.errors + row.missing });
    }
  }
  for (const t of ts) {
    if (svcSet.has(key(t))) continue;
    tsOnly++;
    fileExact = false;
    if (tsOnlySamples.length < sampleSize) tsOnlySamples.push({ file: row.file, range: t });
  }
  if (fileExact) filesExact++;
}

const summary = {
  corpus,
  files: rows.length,
  legalFiles,
  illegalFiles,
  tsFolds: tsTotal,
  serviceFolds: svcTotal,
  exactPairs: exact,
  tsOnly,
  serviceOnly: svcOnly,
  serviceOnlyContained: svcOnly - svcBlankTail - svcUncontained,
  serviceOnlyBlankTail: svcBlankTail,
  serviceOnlyUncontained: svcUncontained,
  filesExact,
  tsOnlySamples,
  serviceOnlyUncontainedSamples: uncontainedSamples,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`语料                  : ${corpus}`);
  console.log(`文件                  : ${summary.files}（合法 ${legalFiles} / 有残留 ${illegalFiles}）`);
  console.log(`语法侧折叠区间        : ${tsTotal}`);
  console.log(`服务侧折叠区间        : ${svcTotal}`);
  console.log(`逐项相同              : ${exact}`);
  console.log(`语法侧多给            : ${tsOnly}`);
  console.log(
    `服务侧多给            : ${svcOnly}（被语法侧包含 ${summary.serviceOnlyContained} / 仅空行尾巴 ${svcBlankTail} / 未包含 ${svcUncontained}）`,
  );
  console.log(`两侧集合完全一致的文件: ${filesExact}/${summary.files}`);
  if (tsOnlySamples.length > 0) {
    console.log('语法侧多给样本        :');
    for (const s of tsOnlySamples) console.log(`  ${s.file} :: ${s.range.startLine}..${s.range.endLine}`);
  }
  if (uncontainedSamples.length > 0) {
    console.log('!! 服务侧未被包含样本  :');
    for (const s of uncontainedSamples) console.log(`  ${s.file} :: ${s.range.startLine}..${s.range.endLine}（ERROR+MISSING=${s.err}）`);
  }
}

const pass = rows.every((r) => !r.crash) && svcUncontained === 0;
if (gate) {
  console.log(`\n结论: ${pass ? 'PASS — 语法侧未少折任何服务区间' : 'FAIL — 存在未覆盖/崩溃'}`);
  process.exit(pass ? 0 : 1);
}
process.exit(0);
