#!/usr/bin/env node
/**
 * TSIT4-B 归因批的**子进程执行体**（父进程 = `tests/kojo-ts-ab-attribution.test.ts`）。
 *
 * ## 为什么必须拆进程（不是把引擎搬进来，是把"解 CST 这件事"搬出去）
 *
 * `docs/PITFALLS.md` 第 138 条实测：web-tree-sitter 0.27 + Node 24（Windows）里，同一进程**只要解过
 * 一次**大 `.kojo`，退出时（V8 `DisposeIsolate`）必报 `Fatal process out of memory: Zone` 并以
 * 0x80000003 中止——用例全过、文件崩、进程退出码非零（既有 A/B 文件 `kojo-ts-vs-monarch-ab.test.ts`
 * 在本机就是这个形状：屏上 `4 passed`，`rc=3`）。⇒ 父进程（vitest worker）**绝不碰 wasm**，
 * 只按 `parse-corpus.mjs` / `tree-sitter-perf-child.mjs` 的既有条例做三件事：
 * ① 每份文件一个子进程（解析量固定小 ⇒ 干净退出）；② **以 stdout 最后一行 JSON 为准**；
 * ③ 不看子进程退出码（崩溃只污染 stderr）。父进程另外把"没吐出合法 JSON"判成崩溃，当场红。
 *
 * ## 本文件只供**事实**，不做任何判据
 *
 * 跑的是生产那枚 `queries/highlights.scm`（与 A/B 的 B 侧同一份文件、同一个 `Query.captures`
 * 调用，故捕获顺序与 A/B 逐条同序），把 `(捕获名, 节点名, 起止行列)` 原样摊出来交给父进程。
 * 档位表（`types.ts`）、削空白、拆行、比格、判档**全在父进程**用生产函数做——本文件不知道"档"这个字。
 *
 * ## 运行形态
 *
 * 纯 node 直跑（`node <本文件> <wasm> <scm> <.kojo>`）：只用 node 内置 + `web-tree-sitter`，
 * 不 import 仓库里任何 `.ts`（省掉解析钩子与跨包耦合，也避免把语法包的坐标面二次传染进宿主测试）。
 * 类型擦除依赖 Node 22.18+/24 的默认行为，与 `helpers/tree-sitter-perf-child.mjs` 同一前提。
 */
import { readFileSync } from 'node:fs';
import { Language, Parser, Query } from 'web-tree-sitter';

const wasmPath = process.argv[2];
const queryPath = process.argv[3];
const filePath = process.argv[4];
if (!wasmPath || !queryPath || !filePath) {
  process.stdout.write(`${JSON.stringify({ fatal: 'usage: node tsit4b-attribution-child.ts <wasm> <scm> <file>' })}\n`);
  process.exit(0);
}

await Parser.init();
const parser = new Parser();
const language = await Language.load(wasmPath);
parser.setLanguage(language);
const query = new Query(language, readFileSync(queryPath, 'utf8'));

const text = readFileSync(filePath, 'utf8');
const tree = parser.parse(text);
if (tree === null) {
  process.stdout.write(`${JSON.stringify({ file: filePath, fatal: 'no-tree' })}\n`);
  process.exit(0);
}

/** 字符串内联表：捕获名 / 节点名各存一份，逐条只回下标（19 份语料的 JSON 体积差一个数量级） */
const captureIds: string[] = [];
const nodeIds: string[] = [];
const captureIndex = new Map<string, number>();
const nodeIndex = new Map<string, number>();
const idOf = (table: string[], idx: Map<string, number>, value: string): number => {
  const hit = idx.get(value);
  if (hit !== undefined) return hit;
  const next = table.length;
  table.push(value);
  idx.set(value, next);
  return next;
};

/** `[捕获名下标, 节点名下标, 起行, 起列, 止行, 止列]`（0 基行列，列 = UTF-16 码元，与 `types.ts` 的坐标口径一致） */
const cells: number[][] = [];
for (const capture of query.captures(tree.rootNode)) {
  const node = capture.node;
  cells.push([
    idOf(captureIds, captureIndex, capture.name),
    idOf(nodeIds, nodeIndex, node.type),
    node.startPosition.row,
    node.startPosition.column,
    node.endPosition.row,
    node.endPosition.column,
  ]);
}

tree.delete();
query.delete();
process.stdout.write(
  `${JSON.stringify({ file: filePath, captureNames: captureIds, nodeTypes: nodeIds, cells })}\n`,
);
process.exit(0);
