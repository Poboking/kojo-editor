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
 * node tools/heap-aggregate.mjs <x.heapsnapshot> --arrays
 * node tools/heap-aggregate.mjs <x.heapsnapshot> --owners --owners-of "(object properties)" --owners-hops 2
 * ```
 *
 * - `--type` 只看某一类（`object` / `string` / `array` / `code` / `native` / `hidden`）；
 * - `--min` 过滤掉元素数少于 N 的构造器（默认 0，全出）；
 * - 输出两段：① 按类型总账；② 按构造器 top N（含计数与平均 self_size）。
 * - `--owners`：反向边归因（谁持有目标节点），见文件末「--owners」段。
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
  console.error(
    '用法：node tools/heap-aggregate.mjs <x.heapsnapshot> [--top 40] [--type object] [--min 100]\n' +
      '      [--arrays] [--strings]\n' +
      '      [--owners --owners-of "(object properties)" [--owners-hops 2] [--owners-top 20]]',
  );
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

/**
 * `--owners`：**反向边归因** —— 给定"目标节点集合"，回答"**谁持有它们**"。
 *
 * ## 为什么要在 `--arrays` / `--strings` 之外再加这一段
 *
 * 那两段把"持有者"压成一行标签（只留首条边、只认 element 之外的第一条），够回答"这一堆是谁的"，
 * 不够回答"**为什么**是这个形状"。真实持有链常常是**两级**：`system/Context → object:Object →
 * (object properties)`——只做一层反查会把 24.8 MB 的字典态属性块全记到"某个 Object"头上，
 * 而 Object 本身是几字节的空壳，处置办法（改闭包变量 / 改对象形状）完全不同。所以这里支持
 * `--owners-hops 2` 逐层走，每层各出一张表。
 *
 * ## 用法
 *
 * ```
 * # 谁持有 (object properties) 块，再往上走一层（→ 闭包 Context / 条目元组）
 * node --max-old-space-size=4096 tools/heap-aggregate.mjs <snap> --owners \
 *   --owners-of "(object properties)" --owners-hops 2 --owners-top 10
 * # 谁持有 ArrayBuffer 的底层
 * node --max-old-space-size=4096 tools/heap-aggregate.mjs <snap> --owners \
 *   --owners-of "JSArrayBufferData" --owners-min 1024
 * # 谁持有"只有 1 个槽的数组"（闭包 TDZ 槽的嫌疑对象）
 * node --max-old-space-size=4096 tools/heap-aggregate.mjs <snap> --owners \
 *   --owners-type array --owners-slots 1 --owners-top 10
 * ```
 *
 * - `--owners-of <名字>`：按**节点名精确**匹配目标（`(object properties)` / `JSArrayBufferData`…）；
 * - `--owners-like <子串>`：按子串匹配（名字不确定时用）；
 * - `--owners-type <type>`：再按节点类型收窄（`array` / `object` / `native`…）；
 * - `--owners-min <字节>`：只要 self_size ≥ N 的目标（默认 0）；
 * - `--owners-slots <N>`：只要"**槽数恰为 N**"的目标——槽的口径与 `--arrays` 完全一致
 *   （`element` 边 + 纯数字名的 `internal` 边，见 PITFALLS 269；只数 `element` 会把所有
 *   FixedArray 报成"长度 0"）；
 * - `--owners-hops <N>`：往上走几层（默认 1，最多 3）。第 N+1 层的目标 = 第 N 层记下的**父节点**；
 * - `--owners-edge kind`：把 `internal:0` / `internal:12` 折成 `internal[slot]`。槽位下标是
 *   "第几格"不是"谁"——不折时 hop 2 会被切成上万个一行组，真正的持有者反而看不见；
 * - `--owners-top <N>`：每层打印多少行（默认 20）。
 *
 * ## 输出怎么读
 *
 * ```
 * [heap] ── 持有者 hop 1（目标 52,424 枚 / 24.8 MB / 均 448 B）──
 * [heap]      22.4 MB   52,424 枚  均 448 B  ← object:Object  边 internal:properties
 * ```
 *
 * 「枚」是**去重的目标节点数**（同一枚被两处持有 ⇒ 两行各记一次，这正是要看的），
 * 「均」是这些目标的 self_size 均值。`← 空` 说明没有任何边指向它（栈 / 寄存器 / 原生根）。
 */
if (argv.includes('--owners')) {
  const ef = meta.edge_fields;
  const estride = ef.length;
  const iEtype = ef.indexOf('type');
  const iEto = ef.indexOf('to_node');
  const iEname = ef.indexOf('name_or_index');
  const edgeTypes = meta.edge_types[iEtype];
  const iEdgeCount = nf.indexOf('edge_count');
  const nodeCount = nodes.length / stride;

  const OF = pick('--owners-of', null);
  const LIKE = pick('--owners-like', null);
  const ONLY_OTYPE = pick('--owners-type', null);
  const OMIN = Number(pick('--owners-min', '0'));
  const SLOTS_ARG = pick('--owners-slots', null);
  const SLOTS = SLOTS_ARG === null ? null : Number(SLOTS_ARG);
  const HOPS = Math.min(3, Math.max(1, Number(pick('--owners-hops', '1'))));
  const OTOP = Number(pick('--owners-top', '20'));
  const MERGE_EDGE = pick('--owners-edge', 'full') === 'kind';
  if (OF === null && LIKE === null && SLOTS === null) {
    console.error('[heap] --owners 需要 --owners-of <名字> / --owners-like <子串> / --owners-slots <N> 之一');
    process.exit(2);
  }

  const typeOf = (n) => typeNames[nodes[n * stride + iType]];
  const nameOf = (n) => strings[nodes[n * stride + iName]];
  const sizeOf = (n) => nodes[n * stride + iSize];

  // 槽数只在 `--owners-slots` 时才算（全表扫一遍边，2.4M 节点 ≈ 1 s）
  let slotCount = null;
  if (SLOTS !== null) {
    const isDigits = (s) => {
      if (typeof s !== 'string' || s.length === 0 || s.length > 9) return false;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 48 || c > 57) return false;
      }
      return true;
    };
    slotCount = new Uint32Array(nodeCount);
    let ei = 0;
    for (let n = 0; n < nodeCount; n++) {
      const ec = nodes[n * stride + iEdgeCount];
      for (let k = 0; k < ec; k++, ei += estride) {
        const et = edgeTypes[edges[ei + iEtype]];
        if (et === 'element' || (et === 'internal' && isDigits(strings[edges[ei + iEname]]))) slotCount[n]++;
      }
    }
  }

  // ---- 选目标 ----
  let targets = new Uint8Array(nodeCount);
  let tCount = 0;
  let tBytes = 0;
  for (let n = 0; n < nodeCount; n++) {
    if (ONLY_OTYPE !== null && typeOf(n) !== ONLY_OTYPE) continue;
    if (sizeOf(n) < OMIN) continue;
    if (SLOTS !== null && slotCount[n] !== SLOTS) continue;
    if (OF !== null || LIKE !== null) {
      const nm = nameOf(n);
      if (typeof nm !== 'string') continue;
      if (OF !== null ? nm !== OF : !nm.includes(LIKE)) continue;
    }
    targets[n] = 1;
    tCount++;
    tBytes += sizeOf(n);
  }
  const desc = [
    OF !== null ? `名=「${clean(OF)}」` : null,
    LIKE !== null ? `名含「${clean(LIKE)}」` : null,
    ONLY_OTYPE !== null ? `type=${ONLY_OTYPE}` : null,
    SLOTS !== null ? `槽数=${SLOTS}` : null,
    OMIN > 0 ? `self_size≥${OMIN}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  console.log(`[heap] ── owners 目标：${desc} ⇒ ${tCount.toLocaleString()} 枚 / ${mb(tBytes)} MB ──`);
  if (tCount === 0) process.exit(0);

  const edgeLabel = (et, raw) => {
    if (et === 'element' || et === 'hidden') return MERGE_EDGE ? et : `[${raw}]`;
    const nm = strings[raw] ?? raw;
    // `--owners-edge=kind`：把 `internal:0` / `internal:12` 折成 `internal[slot]`。
    // 槽位下标是"第几格"，不是"谁"——不折的话 hop 2 会被切成上万个 1 行组
    // （每个下标一组），真正的持有者反而看不见。
    if (MERGE_EDGE && et === 'internal' && /^\d+$/.test(String(nm))) return 'internal[slot]';
    return `${et}:${nm}`;
  };

  /**
   * **按字节归属**（不是按"父节点自己多大"）。
   *
   * hop 1 的 `size` 就是目标的 self_size；从 hop 2 起，父节点往往是 32 B 的 JSArray 头，
   * 拿它自己的 self_size 记账会把 26 MB 的底层块报成"3.4 MB 的持有者"——那正是
   * "谁持有这 26 MB"这个问题要避免的假账。所以每一层都把**原始目标的字节**带上去：
   * `weight(p) += weight(t)`，同一枚被两处持有时两行各记一次（要看的正是这个）。
   */
  let weight = new Float64Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) if (targets[n] === 1) weight[n] = sizeOf(n);

  /**
   * **同一段包含关系在快照里有两条边**（PITFALLS 269 的背面）：
   * `Array --element--> 子` 与 `(object elements) --internal:"3"--> 子` 指的是同一格。
   * 不折的话 hop 2 会把同一笔字节报两遍（实测 `object/Array` 22.1 MB 与
   * `array/(object elements)` 22.1 MB 是同一批 206,751 段关系），一眼看去像"翻倍"。
   *
   * 折法：`element` 边只从 JSArray 出发、且**每个槽都有一条** ⇒ 凡是"源节点是某个
   * Array 的 elements 块"的 `internal:<下标>` 边都跳过，只留 `element` 那条。
   * 属性块 / 元组（没有 `element` 对应边）的下标边照常保留。
   */
  const elemBlockOwner = new Int32Array(nodeCount).fill(-1);
  {
    let ei = 0;
    for (let n = 0; n < nodeCount; n++) {
      const ec = nodes[n * stride + iEdgeCount];
      for (let k = 0; k < ec; k++, ei += estride) {
        if (edgeTypes[edges[ei + iEtype]] !== 'internal') continue;
        if (strings[edges[ei + iEname]] !== 'elements') continue;
        elemBlockOwner[edges[ei + iEto] / stride] = n;
      }
    }
  }
  const isDigitName = (s) => typeof s === 'string' && s.length > 0 && s.length <= 9 && !/[^0-9]/.test(s);

  for (let hop = 1; hop <= HOPS; hop++) {
    const next = new Uint8Array(nodeCount);
    const nextW = new Float64Array(nodeCount);
    const agg = new Map(); // `${父type}\0${父名}\0${边}` → { count, size, seen }
    let ei = 0;
    for (let n = 0; n < nodeCount; n++) {
      const ec = nodes[n * stride + iEdgeCount];
      for (let k = 0; k < ec; k++, ei += estride) {
        const to = edges[ei + iEto] / stride;
        if (targets[to] !== 1) continue;
        const et = edgeTypes[edges[ei + iEtype]];
        // elements 块的下标边与所属 Array 的 element 边是同一格，只留后者（见上面的注释）
        if (et === 'internal' && elemBlockOwner[n] !== -1 && isDigitName(strings[edges[ei + iEname]])) continue;
        const label = edgeLabel(et, edges[ei + iEname]);
        const key = `${typeOf(n)}\u0000${nameOf(n)}\u0000${label}`;
        let a = agg.get(key);
        if (a === undefined) {
          a = { type: typeOf(n), name: nameOf(n), label, size: 0, seen: new Set() };
          agg.set(key, a);
        }
        // 去重：同一枚目标被同一个父的同一类边指两次（少见）只记一次，别把"枚"数虚增
        if (!a.seen.has(to)) {
          a.seen.add(to);
          a.size += weight[to];
        }
        next[n] = 1;
        nextW[n] += weight[to];
      }
    }
    const rows = [...agg.values()].sort((a, b) => b.size - a.size);
    console.log(
      `[heap] ── 持有者 hop ${hop}（${hop === 1 ? '目标' : '承上'} ${tCount.toLocaleString()} 枚 / 归属 ${mb(tBytes)} MB）top ${OTOP} ──`,
    );
    if (rows.length === 0) console.log('[heap]   （无持有者：栈 / 寄存器 / 原生根）');
    for (const r of rows.slice(0, OTOP)) {
      console.log(
        `[heap] ${mb(r.size).padStart(9)} MB  ${String(r.seen.size).padStart(9)} 枚  均 ${(r.size / r.seen.size).toFixed(0).padStart(6)} B` +
          `  ← ${r.type}/${clean(r.name).slice(0, 40)}  边 ${r.label}`,
      );
    }
    if (rows.length > OTOP) console.log(`[heap]   …另有 ${rows.length - OTOP} 组（--owners-top 抬高可看全）`);

    // 下一层：目标换成这一层记下的父节点，字节按上面的 `weight` 逐层带上去
    targets = next;
    weight = nextW;
    tCount = 0;
    tBytes = 0;
    for (let n = 0; n < nodeCount; n++) {
      if (targets[n] === 1) {
        tCount++;
        tBytes += weight[n];
      }
    }
    if (tCount === 0) break;
  }
}
