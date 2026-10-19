#!/usr/bin/env node
/**
 * _wasm-perf-child.mjs —— wasm 体积账的**子进程测量执行体**（父进程 = tools/wasm-size-probe.mjs）。
 *
 * 为什么必须有这个进程（照 PITFALLS 138 的条例）：
 *   web-tree-sitter 0.27 + Node 24（Win）只要在同一进程里解过一次大 `.kojo`，
 *   进程退出时（V8 DisposeIsolate）必报 `Fatal process out of memory: Zone` 并以 0x80000003 中止。
 *   ⇒ 父进程**零 wasm**，只读本进程 stdout 的那一行 JSON，**不看退出码**
 *     （崩溃只污染 stderr；stdout 在崩溃前已同步写完）。同 `_parse-one.mjs` 一条手法。
 *
 * 每进程只解**一次** ⇒ 量到的就是"冷全量解析"（没有旧树、没有增量、没有热页缓存的第二次 pass）。
 *
 * 用法：node _wasm-perf-child.mjs <wasm 绝对路径> <.kojo 绝对路径>
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Parser, Language } from 'web-tree-sitter';

const wasmPath = process.argv[2];
const filePath = process.argv[3];
const out = { wasm: wasmPath, bytes: 0, ms: 0, coldMs: 0, errors: 0, missing: 0, nodes: 0, crash: 0 };

try {
  out.bytes = readFileSync(wasmPath).length;
  const text = readFileSync(filePath, 'utf8');

  // 冷口径 A：连 init + Language.load 一起算（整个"从磁盘到 CST"的冷启）。
  const t0 = performance.now();
  await Parser.init();
  const lang = await Language.load(wasmPath);
  const parser = new Parser();
  parser.setLanguage(lang);
  out.coldMs = performance.now() - t0;

  // 冷口径 B（主读数）：只算 parser.parse 这一段，文档已就绪、引擎已装载 ⇒ 纯解析成本。
  const t1 = performance.now();
  const tree = parser.parse(text);
  out.ms = performance.now() - t1;

  const stack = [tree.rootNode];
  while (stack.length) {
    const n = stack.pop();
    out.nodes++;
    if (n.isMissing) out.missing++;
    else if (n.type === 'ERROR') out.errors++;
    for (const c of n.children) stack.push(c);
  }
  tree.delete();
  lang.delete();
  parser.delete();
} catch (e) {
  out.crash = 1;
  out.error = String(e && e.message ? e.message : e);
}

process.stdout.write(JSON.stringify(out) + '\n');
process.exit(0);
