#!/usr/bin/env node
/**
 * retain-path.mjs —— 堆快照的**持有链回溯**（MEM 批，2026-10-30）。
 *
 * `tools/heap-aggregate.mjs` 只回答"哪一类/哪个构造器在占"，回答不了"**是谁攥着**"。
 * 追持有链要的是**反向边**：从目标节点出发，逐层找"谁有边指向我"，直到根。
 *
 * ## 用法
 *
 * ```
 * node --max-old-space-size=4096 tools/retain-path.mjs <x.heapsnapshot> --find <子串> [--depth 6] [--max 6]
 * node --max-old-space-size=4096 tools/retain-path.mjs <x.heapsnapshot> --min-size 8192 [--depth 5]
 * ```
 *
 * - `--find`：按字符串内容子串找目标节点（字符串节点的 `name` 就是内容）；
 * - `--min-size`：把"self_size ≥ N 的字符串"全部当目标（查"这一堆大串是谁的"）；
 * - `--depth`：回溯层数（默认 6）；`--max`：最多打印几条链（默认 6）。
 *
 * ## 做法
 *
 * 每一层都**全表扫一遍边**（2.4M 节点 / ~3.6M 边 ≈ 1.5 s 一遍），只记"指向当前层"的那些
 * ⇒ 不需要常驻一张反向索引（那要 3.6M 条记录），层数少时更省内存也更好读。
 * 边字段布局见快照 `meta.edge_fields`：`[type, name_or_index, to_node]`。
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const val = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const FIND = val('find', null);
const MIN_SIZE = Number(val('min-size', 0));
const DEPTH = Number(val('depth', 6));
const MAX = Number(val('max', 6));

const snap = JSON.parse(readFileSync(file, 'utf8'));
const meta = snap.snapshot.meta;
const nf = meta.node_fields;
const ef = meta.edge_fields;
const nTypes = meta.node_types[0];
const eTypes = meta.edge_types[0];
const iType = nf.indexOf('type');
const iName = nf.indexOf('name');
const iId = nf.indexOf('id');
const iSize = nf.indexOf('self_size');
const iEdgeCount = nf.indexOf('edge_count');
const NODE_STRIDE = nf.length;
const EDGE_STRIDE = ef.length;
const eTypeIx = ef.indexOf('type');
const eNameIx = ef.indexOf('name_or_index');
const eToIx = ef.indexOf('to_node');
const nodes = snap.nodes;
const edges = snap.edges;
const strings = snap.strings;
const nodeCount = nodes.length / NODE_STRIDE;

const typeOf = (n) => nTypes[nodes[n * NODE_STRIDE + iType]];
const nameOf = (n) => strings[nodes[n * NODE_STRIDE + iName]];
const sizeOf = (n) => nodes[n * NODE_STRIDE + iSize];

/** 每个节点的首条边下标（前缀和；快照的边按节点顺序连续排列） */
const edgeStart = new Uint32Array(nodeCount + 1);
for (let n = 0, e = 0; n < nodeCount; n++) {
  edgeStart[n] = e;
  e += nodes[n * NODE_STRIDE + iEdgeCount];
}
edgeStart[nodeCount] = edges.length / EDGE_STRIDE;

const trunc = (s) => (s.length > 60 ? `${s.slice(0, 60)}…` : s);

// ---- 选目标 ----
const targets = [];
for (let n = 0; n < nodeCount; n++) {
  if (typeOf(n) !== 'string') continue;
  const name = nameOf(n);
  if (typeof name !== 'string') continue;
  if (FIND !== null ? name.includes(FIND) : sizeOf(n) >= MIN_SIZE) targets.push(n);
}
console.log(`[retain] 目标 ${targets.length} 个（${FIND !== null ? `含「${FIND}」` : `self_size ≥ ${MIN_SIZE}`}）`);
if (targets.length === 0) process.exit(0);

// ---- 逐层反向 BFS ----
let frontier = new Set(targets);
/** 子 → [父, 边名]（第一条发现即记，够读就行；边名是"哪个属性攥着它"，比类型有用得多） */
const parents = new Map();
for (let d = 0; d < DEPTH && frontier.size > 0; d++) {
  const next = new Set();
  for (let n = 0; n < nodeCount; n++) {
    const start = edgeStart[n];
    const end = edgeStart[n + 1];
    for (let e = start; e < end; e++) {
      const to = edges[e * EDGE_STRIDE + eToIx] / NODE_STRIDE;
      if (!frontier.has(to) || parents.has(to)) continue;
      const raw = edges[e * EDGE_STRIDE + eNameIx];
      const eType = eTypes[edges[e * EDGE_STRIDE + eTypeIx]];
      // `element` / `hidden` 边没有名字，只有下标 ⇒ 用 `[i]` 表示
      const label = eType === 'element' || eType === 'hidden' ? `[${raw}]` : `${eType}:${strings[raw] ?? raw}`;
      parents.set(to, [n, label]);
      next.add(n);
    }
  }
  frontier = next;
  console.log(`[retain] 第 ${d + 1} 层：${next.size} 个持有者`);
}

// ---- 打印若干条链 ----
let shown = 0;
for (const t of targets) {
  if (shown >= MAX) break;
  const chain = [[t, '（目标）']];
  const seen = new Set([t]);
  let cur = t;
  // 环一定会有（`ErbFile 壳 ↔ getter 闭包` 就是），见到重复立刻停
  while (parents.has(cur)) {
    const [parent, label] = parents.get(cur);
    if (seen.has(parent)) {
      chain.push([parent, `${label}（环，止）`]);
      break;
    }
    seen.add(parent);
    chain.push([parent, label]);
    cur = parent;
  }
  console.log(`\n── 链 ${++shown} ──`);
  for (const [n, label] of chain) {
    const nm = nameOf(n);
    console.log(`   ${label.padEnd(24)} ${typeOf(n).padEnd(14)} ${String(sizeOf(n)).padStart(9)} B  ${trunc(typeof nm === 'string' ? nm : '')}`);
  }
}
