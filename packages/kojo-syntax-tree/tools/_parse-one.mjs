#!/usr/bin/env node
/**
 * _parse-one.mjs —— 单子进程解析器（被 parse-corpus.mjs 逐文件调用）。
 *
 * 为什么单独成进程：web-tree-sitter 在同一进程里连续解析多个大文件会把 wasm 线性内存推到高水位，
 * 进程退出时（V8 DisposeIsolate）触发 tree-sitter "Zone" OOM——单次解析退出正常，累积才炸。
 * 每文件一个进程 ⇒ 解析量固定小 ⇒ 干净退出。本 worker 打印一行 JSON 供父进程聚合。
 *
 * 用法：node _parse-one.mjs <wasm 绝对路径> <.kojo 绝对路径>
 */
import { readFileSync } from 'node:fs';
import { Parser, Language } from 'web-tree-sitter';

const wasmPath = process.argv[2];
const filePath = process.argv[3];

const out = { file: filePath, crash: 0, errors: 0, missing: 0, topCount: 0, errRows: [], types: {} };

await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(wasmPath));

let tree;
try {
  tree = parser.parse(readFileSync(filePath, 'utf8'));
} catch (e) {
  out.crash = 1;
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

const stack = [tree.rootNode];
while (stack.length) {
  const n = stack.pop();
  if (n.isMissing) {
    out.missing++;
    out.errRows.push(n.startPosition.row);
  } else if (n.type === 'ERROR') {
    out.errors++;
    out.errRows.push(n.startPosition.row);
  }
  for (const c of n.children) stack.push(c);
}
for (const c of tree.rootNode.namedChildren) {
  out.topCount++;
  out.types[c.type] = (out.types[c.type] || 0) + 1;
}
tree.delete();
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(0);
