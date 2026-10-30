#!/usr/bin/env node
/**
 * heap-aggregate.mjs —— **堆快照的离线归因尺子**（MEM 批，2026-10-29）。
 *
 * ## 为什么要单独一个工具
 *
 * `tools/mem-shell.mjs` 的 `--aggregate` 只按 **node type** 分桶（`string` / `object` /
 * `array` / `native`…）。那组数只够回答"哪一类在涨"，不够回答"**是谁**在占"：
 * 热载 200.9 MB 里 `object` 一项就 72 MB，而 `object` 底下可能是 61 万个引用对象、
 * 也可能是 4 千个文件壳，处置办法完全不同。这里补上**构造器名**这一维
 * （快照 `nodes[i].name` 是指向 `strings` 的下标，对 object 就是构造器名）。
 *
 * ## 用法
 *
 * ```
 * node tools/heap-aggregate.mjs <x.heapsnapshot> [--top 40] [--type object] [--min 100]
 * ```
 *
 * - `--type` 只看某一类（`object` / `string` / `array` / `code` / `native` / `hidden`）；
 * - `--min` 过滤掉元素数少于 N 的构造器（默认 0，全出）；
 * - 输出两段：① 按类型总账；② 按构造器 top N（含计数与平均 self_size）。
 *
 * ## 快照怎么来
 *
 * `node tools/mem-readings.mjs --warm --snapshot-after <f>`（热载稳态）、
 * `node tools/mem-shell.mjs --snapshot <f>`（真壳页内）。两份都很大（150–330 MB），
 * 读进内存 `JSON.parse` 大约吃 1.5 GB——够用，但别在低内存机器上同时开两个。
 *
 * ## 两个格式坑（都是实拍踩过的）
 *
 * 1. `meta.node_types[0]` 是**扁平数组**（`["hidden","array","string",…]`），不是每字段
 *    一组；`node_types[1..]` 才是 `"string"` / `"number"` 这种标量声明。按 `type` 取名字
 *    要用 `node_types[0][typeIdx]`。
 * 2. 遍历时必须**逐节点**读 `type`，不能拿"上一节点的 type"当默认值——快照里节点按类型
 *    分块排列，用残留值会把整块报成 `undefined`（PITFALLS 256 的同款错误）。
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const pick = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : dflt;
};
if (!file) {
  console.error('用法：node tools/heap-aggregate.mjs <x.heapsnapshot> [--top 40] [--type object] [--min 100]');
  process.exit(2);
}
const TOP = Number(pick('--top', '40'));
const ONLY_TYPE = pick('--type', null);
const MIN_COUNT = Number(pick('--min', '0'));

const t0 = Date.now();
const snap = JSON.parse(readFileSync(file, 'utf8'));
// V8 的快照是 `{ snapshot: { meta, node_count, edge_count }, nodes, edges, strings }`
// —— meta 在 `snapshot.meta` 里，不在顶层（写成顶层会拿到 undefined 然后崩在 node_fields）
const meta = snap.snapshot.meta;
const strings = snap.strings;
const nodes = snap.nodes;
const edges = snap.edges;
const nf = meta.node_fields;
const stride = nf.length;
const iType = nf.indexOf('type');
const iName = nf.indexOf('name');
const iSize = nf.indexOf('self_size');
const typeNames = meta.node_types[iType]; // 扁平数组，见头注坑 1
const mb = (n) => (n / 1048576).toFixed(1);

const byType = new Map();
const byCtor = new Map();
/**
 * 名字要截断：字符串节点的 `name` 就是**串内容本身**（真语料里最长的一份正文 11 MB），
 * 原样打进日志会把一行变成一屏（实测 26 行输出里 20 行是正文）。
 */
const clean = (s) => {
  if (typeof s !== 'string') return String(s);
  const flat = s.replace(/\s+/g, ' ');
  return flat.length > 56 ? `${flat.slice(0, 56)}…(${flat.length} 字符)` : flat;
};
for (let i = 0; i < nodes.length; i += stride) {
  const type = typeNames[nodes[i + iType]]; // 逐节点读，见头注坑 2
  const name = strings[nodes[i + iName]];
  const size = nodes[i + iSize];
  const t = byType.get(type) ?? { count: 0, size: 0 };
  t.count++;
  t.size += size;
  byType.set(type, t);
  if (ONLY_TYPE !== null && type !== ONLY_TYPE) continue;
  // 构造器键带上类型：同名的 "Array" 与 "array" 桶不混
  const key = `${type}\u0000${name}`;
  const c = byCtor.get(key) ?? { type, name, count: 0, size: 0 };
  c.count++;
  c.size += size;
  byCtor.set(key, c);
}

const total = [...byType.values()].reduce((a, b) => a + b.size, 0);
console.log(`[heap] ${file}`);
console.log(`[heap] 解析 ${Date.now() - t0}ms  节点 ${(nodes.length / stride).toLocaleString()} 个  合计 ${mb(total)} MB`);
console.log('[heap] ── 按类型 ──');
for (const [type, v] of [...byType.entries()].sort((a, b) => b[1].size - a[1].size)) {
  console.log(`[heap] ${type.padEnd(10)} ${mb(v.size).padStart(9)} MB  ${String(v.count).padStart(10)} 个`);
}

const rows = [...byCtor.values()]
  .filter((r) => r.count >= MIN_COUNT)
  .sort((a, b) => b.size - a.size)
  .slice(0, TOP);
console.log(`[heap] ── 按构造器 top ${TOP}${ONLY_TYPE ? `（只看 ${ONLY_TYPE}）` : ''} ──`);
for (const r of rows) {
  const avg = r.size / r.count;
  console.log(
    `[heap] ${r.type.padEnd(8)} ${mb(r.size).padStart(9)} MB  ${String(r.count).padStart(10)} 个` +
      `  均 ${avg.toFixed(0).padStart(6)} B  ${clean(r.name)}`,
  );
}

/**
 * `--arrays`：把数组按「**谁持有它** + 数组长度」分组。
 *
 * 为什么需要：构造器名对数组毫无区分度（1,036,587 个数组全叫 `Array`），而"谁是持有者、
 * 长度几位"直接决定处置办法——10 万个长度 1 的数组是 `byName` 的值槽（可以换成惰性/内联），
 * 10 万个长度 7 的数组是快照元组（可以扁平化成数值），两者不是一个改法。
 *
 * 快照的 `edges` 是**按 from 节点顺序排列、不带 from 字段**的，必须靠每个节点的
 * `edge_count` 顺序消费才能还原"这条边从谁来"（见 PITFALLS 256 同类坑：别指望数组自带下标）。
 *
 * ## 槽数怎么数（PITFALLS 269，2026-10-30 实拍纠正）
 *
 * 这里原先只数 `element` 边，结果 **66 万个数组全报"长度 0"**——因为这一代 V8 把
 * **FixedArray 的槽位发成 `internal` 边、名字是十进制下标字符串**（`"0"`、`"1"`、`"12"`…），
 * 而不是 `element` 边。`element` 边只从 **JSArray** 出发（1,465,420 条，指向值），
 * `(object elements)` / `(object properties)` 这些 FixedArray 节点一条都没有。
 *
 * 两条都要数，而且 `internal` 那条只认**纯数字名**（`map` / `elements` / `properties`
 * 这些是结构边，不是槽）。只数 `element` 的后果是"每个数组都是空的"——一个**不报错、
 * 也不像错**的假读数，按它下结论会把 5 万个"槽 9"的对象属性块当成"零长数组"。
 */
if (argv.includes('--arrays')) {
  const ef = meta.edge_fields;
  const estride = ef.length;
  const iEtype = ef.indexOf('type');
  const iEto = ef.indexOf('to_node');
  const iEname = ef.indexOf('name_or_index');
  const edgeTypes = meta.edge_types[iEtype];
  const iEdgeCount = nf.indexOf('edge_count');
  const nodeCount = nodes.length / stride;
  const isDigits = (s) => {
    if (typeof s !== 'string' || s.length === 0 || s.length > 9) return false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 48 || c > 57) return false;
    }
    return true;
  };

  // 槽数 = 从它**出发**的 element 边数 + 纯数字名的 internal 边数
  // （不是指向它的——指向它的那条边只是"被谁装着"）
  const arrLen = new Map(); // nodeIdx → 长度
  const arrOwner = new Map(); // nodeIdx → `${ownerType}\u0000${ownerCtor}`
  const isArray = new Uint8Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) {
    if (typeNames[nodes[n * stride + iType]] === 'array') isArray[n] = 1;
  }
  let ei = 0;
  for (let n = 0; n < nodeCount; n++) {
    const ec = nodes[n * stride + iEdgeCount];
    const fromKey = `${typeNames[nodes[n * stride + iType]]}\u0000${strings[nodes[n * stride + iName]]}`;
    for (let k = 0; k < ec; k++, ei += estride) {
      const et = edgeTypes[edges[ei + iEtype]];
      const to = edges[ei + iEto] / stride;
      const isSlot = et === 'element' || (et === 'internal' && isDigits(strings[edges[ei + iEname]]));
      if (isSlot) {
        if (isArray[n] === 1) arrLen.set(n, (arrLen.get(n) ?? 0) + 1);
        continue;
      }
      // 非槽位的指向 = "被谁装着"。只认第一条，多个持有者时取先到的那条
      if (isArray[to] === 1 && !arrOwner.has(to)) arrOwner.set(to, fromKey);
    }
  }

  const groups = new Map();
  for (let n = 0; n < nodeCount; n++) {
    if (isArray[n] !== 1) continue;
    const len = arrLen.get(n) ?? 0;
    const owner = arrOwner.get(n) ?? '（无持有者：栈/寄存器/原生）';
    const key = `${owner}\u0000${len}`;
    const g = groups.get(key) ?? { owner, len, count: 0, size: 0 };
    g.count++;
    g.size += nodes[n * stride + iSize];
    groups.set(key, g);
  }
  console.log('[heap] ── 数组按「持有者 + 长度」top 24 ──');
  for (const g of [...groups.values()].sort((a, b) => b.size - a.size).slice(0, 24)) {
    const [otype, octor] = g.owner.split('\u0000');
    console.log(
      `[heap] ${mb(g.size).padStart(9)} MB  ${String(g.count).padStart(8)} 个  长度 ${String(g.len).padStart(3)}` +
        `  ← ${otype}/${clean(octor)}`,
    );
  }
}

/**
 * `--strings`：字符串按「**谁持有**」+ 大小分布归因。
 *
 * 为什么需要：`string` 桶常常是最大的一项（热载 133.4 MB / 105 万个），但"105 万个字符串"
 * 里既有 100 万个 40 字节的函数名，也可能有几份**整篇正文**被某个插件顺手留住了——
 * 后者的处置办法是"别留"，前者是"换表示"，混在一个总数里看不出来。
 */
if (argv.includes('--strings')) {
  const ef = meta.edge_fields;
  const estride = ef.length;
  const iEtype = ef.indexOf('type');
  const iEto = ef.indexOf('to_node');
  const edgeTypes = meta.edge_types[iEtype];
  const iEdgeCount = nf.indexOf('edge_count');
  const nodeCount = nodes.length / stride;
  const parent = new Int32Array(nodeCount).fill(-1);
  let ei = 0;
  for (let n = 0; n < nodeCount; n++) {
    const ec = nodes[n * stride + iEdgeCount];
    for (let k = 0; k < ec; k++, ei += estride) {
      // element 只是"数组装着它"，真正有信息的是 property / internal / context 这类命名边
      if (edgeTypes[edges[ei + iEtype]] === 'element') continue;
      const to = edges[ei + iEto] / stride;
      if (parent[to] === -1) parent[to] = n;
    }
  }
  const label = (n) =>
    typeNames[nodes[n * stride + iType]] === 'object'
      ? strings[nodes[n * stride + iName]]
      : `${typeNames[nodes[n * stride + iType]]}/${strings[nodes[n * stride + iName]]}`;

  const buckets = [
    { min: 1 << 20, name: '≥1 MB' },
    { min: 1 << 17, name: '128 KB–1 MB' },
    { min: 1 << 13, name: '8–128 KB' },
    { min: 1 << 7, name: '128 B–8 KB' },
    { min: 0, name: '<128 B' },
  ].map((b) => ({ ...b, count: 0, size: 0 }));
  const tops = [];
  for (let n = 0; n < nodeCount; n++) {
    if (typeNames[nodes[n * stride + iType]] !== 'string') continue;
    const size = nodes[n * stride + iSize];
    const b = buckets.find((x) => size >= x.min);
    b.count++;
    b.size += size;
    if (size >= 1 << 13) {
      const p = parent[n];
      tops.push({ size, owner: p < 0 ? '（根/栈）' : label(p), text: strings[nodes[n * stride + iName]] });
    }
  }
  console.log('[heap] ── 字符串按大小分布 ──');
  for (const b of buckets) console.log(`[heap] ${b.name.padEnd(12)} ${mb(b.size).padStart(9)} MB  ${String(b.count).padStart(9)} 个`);
  console.log('[heap] ── ≥8 KB 的字符串 top 16（持有者） ──');
  for (const t of tops.sort((a, b) => b.size - a.size).slice(0, 16)) {
    console.log(`[heap] ${(t.size / 1024).toFixed(0).padStart(7)} KB  ← ${clean(t.owner).slice(0, 40)}  「${clean(t.text).slice(0, 44)}」`);
  }
}
