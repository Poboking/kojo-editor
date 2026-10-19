#!/usr/bin/env node
/**
 * parse-corpus.mjs —— kojo 语法层「一遍可复现读数」命令。
 *
 * 逐文件解析仓库内每一个 `.kojo`，打印：文件数、ERROR/MISSING 总数、崩溃数，
 * 并单列故意残缺 fixtures 的错误定位与"后续仍解析"证据。本批两条硬闸：
 *   1) 真实语料（kojo-sugar 金样 + fixtures）必须 **0 ERROR**；
 *   2) 故意残缺的 fixtures 必须**可定位** ERROR/MISSING，且不崩溃、后续行仍正常解析（错误被限制）。
 *
 * 每文件在**独立子进程**里解析（见 tools/_parse-one.mjs 头注）——同一进程连续解析多个大文件会在
 * 退出时触发 web-tree-sitter 的 "Zone" OOM；拆进程后单次解析量小、干净退出。本父进程不碰 wasm，rc 稳定。
 *
 * 用法（仓库根）：node packages/kojo-syntax-tree/tools/parse-corpus.mjs
 */
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // packages/kojo-syntax-tree/tools
const pkgRoot = resolve(here, '..'); // packages/kojo-syntax-tree
const repoRoot = resolve(pkgRoot, '..', '..'); // 仓库根
const wasmPath = join(pkgRoot, 'tree-sitter-kojo.wasm');
const worker = join(here, '_parse-one.mjs');
const BROKEN_DIR = join(pkgRoot, 'tests', 'fixtures');

/** 递归收集 `.kojo`，跳过 node_modules，可排除某目录前缀。 */
function collect(dir, out, exclude) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (exclude && (p === exclude || p.startsWith(exclude + '/'))) continue;
    if (e.isDirectory()) collect(p, out, exclude);
    else if (e.name.endsWith('.kojo')) out.push(p);
  }
  return out;
}

/**
 * 在子进程里解析单文件，返回聚合结果。
 * 注意：web-tree-sitter 0.27 在 Node 24 下**退出时**（V8 DisposeIsolate）会抛 "Zone" OOM——
 * 但解析与 stdout 输出都在崩溃前正常完成，崩溃只污染 stderr 与退出码。故以 stdout 的 JSON 为准，
 * 不看退出码；只有拿不到合法 JSON 才判为崩溃。
 */
function parseOne(file) {
  const r = spawnSync(process.execPath, [worker, wasmPath, file], { encoding: 'utf8' });
  const line = (r.stdout || '').trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch {
    return { file, crash: 1, errors: 0, missing: 0, topCount: 0, errRows: [] };
  }
}

// ---- 1) 真实语料（排除本包 tests/fixtures 下的残缺样本）----
const realCorpus = [];
for (const top of ['packages', 'fixtures']) collect(join(repoRoot, top), realCorpus, BROKEN_DIR);

let crash = 0;
let totalErr = 0;
let totalMissing = 0;
const offenders = [];
for (const file of realCorpus) {
  const res = parseOne(file);
  crash += res.crash;
  totalErr += res.errors;
  totalMissing += res.missing;
  if (res.crash || res.errors + res.missing > 0) {
    offenders.push([file.replace(repoRoot + '\\', ''), res.crash ? 'CRASH' : `ERROR=${res.errors} MISSING=${res.missing}`]);
  }
}

console.log('== 真实语料（reference corpus）==');
console.log(`文件数         : ${realCorpus.length}`);
console.log(`崩溃           : ${crash}`);
console.log(`ERROR 节点总数 : ${totalErr}`);
console.log(`MISSING 节点总数: ${totalMissing}`);
console.log(offenders.length ? '!! 非零残留：\n' + offenders.map(([f, m]) => `   ${f} :: ${m}`).join('\n') : '✔ 全部 0 ERROR / 0 MISSING');

// ---- 2) 故意残缺 fixtures（须可定位、不崩溃、后续仍解析）----
const broken = [];
collect(BROKEN_DIR, broken, null);
console.log('\n== 故意残缺 fixtures（错误恢复验证）==');
let brokenCrash = 0;
let brokenErr = 0;
for (const file of broken) {
  const res = parseOne(file);
  brokenCrash += res.crash;
  brokenErr += res.errors + res.missing;
  const rows = res.errRows.slice(0, 3).join(',');
  console.log(`${file.replace(BROKEN_DIR + '\\', '')}: ERROR=${res.errors} MISSING=${res.missing} @行[${rows}] 顶层节点数=${res.topCount}`);
}
console.log(`残缺 fixtures  : ${broken.length} / 崩溃 ${brokenCrash} / 错误可定位总数 ${brokenErr}`);

const pass = crash === 0 && totalErr === 0 && totalMissing === 0 && brokenCrash === 0 && brokenErr > 0;
console.log('\n结论:', pass ? 'PASS — 真实语料零 ERROR，残缺样本错误可定位且不崩溃' : 'FAIL（看上方残留）');
process.exit(pass ? 0 : 1);
