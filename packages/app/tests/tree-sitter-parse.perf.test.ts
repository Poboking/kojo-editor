/**
 * 结构解析（tree-sitter）· **真增量与墙钟读数**（TSIT2-C 的量数那一半）。
 *
 * ## 为什么这个文件存在
 *
 * wave 1 把叠层建起来了，但"增量到底是真还是假"没人量过：`tree.edit()` 调了不等于树真的被复用，
 * 每次击键把整篇重解一遍在功能测试里**看不出差别**（结果一样，只是贵）。这一池把它钉成两件事：
 * ① **局部性**（结构判据，不靠时间）——一次单击键改动一行时，引擎向文本取了几段、取字窗口落在哪；
 * ② **墙钟读数**（p50/p95）——冷全量解与增量解各是多少毫秒，16 ms 一帧线到底达没达标。
 *
 * ## 打的是生产代码，不是替身（但**在子进程里打**）
 *
 * 引擎本体 `new StructureEngine(...)` 与 `edit.ts` 的 `commonEdit()` / `applyEdit()` 都照原样驱动，
 * 只是搬进 `tests/helpers/tree-sitter-perf-child.mjs` 那个子进程里跑：本文件（vitest fork）**一个字节的
 * wasm 都不碰**，只收子进程 stdout 的那一行 JSON 做聚合与断言。为什么要搬：
 *
 * 1. **退出必炸**：web-tree-sitter 0.27 + Node 24（Windows）实测——同一进程只要解过一次档，
 *    收尾时（V8 `DisposeIsolate`）必报 `Fatal process out of memory: Zone` 并以 0x80000003 中止；
 *    连"只解一轮"也一样，只 `init()` 不解则干净退出 rc=0。父进程带着这个中止收尾，vitest 就报
 *    `[vitest-pool]: Worker exited unexpectedly` ⇒ 整条池子被判崩（本文件此前的崩法正是这一条）。
 * 2. **原生高水位不还给 OS**：每解一次 5,000 行档，进程 RSS 抬 ~110–150 MB 且**不下降**
 *    （`heapUsed` 全程 ≤ 40 MB、`external` 平的 ⇒ 不是 JS 侧滞留；`Tree`/`Parser`/`Query` 也都按
 *    规矩 `delete()` 了）。同进程跑 20 + 32 轮仍是把 fork 推到数 GB 然后**跑到一半**真 OOM。
 *    ⇒ 轮数按子进程切开（见 `tree-sitter-perf-corpus.ts` 的拆进程计划；单击键那档每子进程
 *    11 次解，实测峰值 RSS 443–459 MB/子进程），样本数只增不减：**冷全量 n=20 不变、
 *    单击键增量 n=12 → n=32（2026-10-20，理由见 §16 ms 一帧线）**。
 *
 * 这条例矩不是新造的：`packages/kojo-syntax-tree/tools/parse-corpus.mjs` 早就因为同一个 Zone 崩溃
 * 把每份 fixture 拆进独立子进程，"父进程不碰 wasm，以 stdout 的 JSON 为准，规避崩溃码"。本文件照抄的
 * 就是那条口径（**子进程退出码不作判据**，崩溃只污染 stderr）。
 *
 * ## 本池量不到什么（写明而不是藏着）
 *
 * 1. **真 Worker**：`?worker` 是 Vite 后缀，vitest 的 node 环境没有 `Worker` 构造 ⇒
 *    线程创建、`postMessage` 序列化、Monaco provider 的取数往返都不在这一池里。
 *    引擎调用形状与 worker 里逐字相同，但**跨线程那份拷贝**没量到；
 *    本池额外再少一层：父子之间那一趟 JSON 序列化（父进程只做聚合与断言，不进计时环）；
 *    TODO（真壳）：`tools/smoke-tauri-dom.mjs` 那条壳里翻开 `editor.treeSitter` 后按同一条口径
 *    量一次"击键 → 语义着色上屏"，与本文件的 parse/change 数对照；
 * 2. **真语法**：本文件的断言只看**行级区间与档位**与"增量结果 == 整篇重解结果"，不看块形状
 *    ⇒ 语法升级后判据照旧成立（若块容器让全量解变贵，翻线的是绝对上界那条，读数会自己说出来）；
 * 3. **进程 RSS**：见上面第 2 条——现在按子进程报每一批的峰值 RSS（`memory.peakRssMb`），
 *    单批实测 ≈ 0.7–1.0 GB（整篇解那几条腿靠顶，击键那条腿 ≈ 0.75 GB）；
 *    **要加每子进程的轮数请先看这个数**（同池满载时更高）。
 *    真壳那条线要盯的是同一个数——长文件连打几百击键后 worker 的内存读数，本文件只把它打印出来，
 *    不当判据。
 * 4. **首击键的"解"仍然不局部，但"查"从第一击就吃缓存**：`single-edit` 那一批同时报两个读数——
 *    "整篇解之后的第一次带旧树重解"实测要把全文重扫一遍（reads 19–20、窗口 = 全文），从第二次
 *    击键起才是真局部（reads 1–2）。这一条是**解析器**的性质（缩进记号让旧树的复用点落在文末），
 *    与查询无关；查询那一段自 TSIT2-G 起由缓存顶着，整篇解已经把三面结果填进去 ⇒ 首击的
 *    `queryScope` 也应当是 `window`（这条现在被钉成判据，不再只是打印）。
 *    局部性判据因此钉在**稳定态那一击**上，预热那一击落在被测行下方两行（上一击留下的脏区也会被
 *    下一击扫一眼，隔太远窗口里混的就是"上次改动的位置"）；首击的 ms 与读数照原样打印不藏
 *    （真壳上"打开文件后第一击"仍会慢半帧，就是 parse 重扫那一条）。
 *
 * 断言口径照 `docs/PITFALLS.md` §72 与同池那几份 perf 用例：**结构判据为主 + 比值 + 极松绝对上界**，
 * 墙钟只报数不钉死（满载时同一条腿能差 2–4 倍）。拆进程后每个子进程都要重付 wasm 首解预热
 * （实测首轮 ~110 ms vs 稳定 ~50 ms，且之后几轮仍一路走低），故每批**丢掉头两轮**（`COLD_WARM_ROUNDS` /
 * `EDIT_WARM_EDITS`），否则读数会被进程启动的抖动灌进 p50/p95。代价：本池绝对值比"同一台引擎连解 20 轮"
 * 的长进程高 ~10%，而**增量 vs 全量那条比值判据不受影响**（两条腿同一条预热纪律）。
 *
 * ## 16 ms 一帧线：现在的口径（TSIT2-G 之后）
 *
 * 旧口径"p95 < 160 ms"与"比值 1.2 倍"都太松：把整篇查询塞回来（增量 p50 ≈ 40 ms / p95 ≈ 47 ms）
 * 两条都照样绿。查询接上改动窗口之后（本机空载，三轮实测，当轮 n=12）：**增量 p50 5.96–6.52 ms /
 * p95 10.30–11.36 ms；整篇重解 p50 56.7–57.4 ms**。判据按这个现实钉：
 * · **比值** `增量 p50 × 4 < 整篇 p50`（实测 ~9 倍；系数取 4 是给满载留一倍余量，同时仍能抓住
 *   "有人把整篇重查塞回 change()"——那种形态比值直接掉回 1.4）；
 * · **一帧线** `p50 < 16` **并且** `p95 < 16`（两条都钉）。**16 这个数没动过，动的是样本数（2026-10-20）**：
 *   n=12 时 `quantile(0.95)` 数学上就是 12 个样本的最大值，一次共享 runner 的 CPU 抢占就能一票打红
 *   （CI run 39360271928：p50 8.24 ms 与绿跑同档，p95 却 16.29 ms，且"退回整篇的击键"那行**没有内容**）。
 *   现在 4 个子进程 × 8 击 = n=32，p95 取第 2 差，单点尖刺不再一票否决；**最大值只报不判**。
 *   p95 真翻线时仍先看"退回整篇的击键"那行——有内容就是判据在退路，不是负载抖动；
 * · 取字窗口与查询窗口各判各的：`reads` 那组判据管**解**有多局部，`queryScope` 那组管**查**有多
 *   局部，两条都不许悄悄退回整篇（`⑦` 里"有击键没走查询窗口"那条判据直接把理由打印出来）。
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STRUCTURE_MAX_WINDOW_NODES, STRUCTURE_READ_CHUNK } from '../src/monaco/tree-sitter/engine';
import { applyEdit, commonEdit } from '../src/monaco/tree-sitter/edit';
import type { KojoStructureToken } from '../src/monaco/tree-sitter/types';
import {
  COLD_CHILDREN,
  COLD_RUNS,
  COLD_SAMPLES_PER_CHILD,
  COLD_WARM_ROUNDS,
  DOC_LINES,
  EDIT_CHILDREN,
  EDIT_RUNS,
  EDIT_SAMPLES_PER_CHILD,
  EDIT_WARM_EDITS,
  FALLBACK_DOC_LINES,
  SINGLE_EDIT_ROW,
  STREAM_DOC_LINES,
  STREAM_EDITS,
  WARM_EDIT_ROW,
  brokenDoc,
  nextDocAfterInsert,
  nextDocAfterLineReplace,
  surrogateDoc,
  surrogateNextDoc,
  syntheticDoc,
  type ChildResult,
  type PerfSample,
  type StreamEditRecord,
} from './helpers/tree-sitter-perf-corpus';

const here = dirname(fileURLToPath(import.meta.url)); // packages/app/tests
const repoRoot = resolve(here, '..', '..', '..');
const childScript = join(here, 'helpers', 'tree-sitter-perf-child.mjs');

/** 子进程要回传 token 数组（5,000 行档两面各 2,606 条）⇒ 默认 1 MB 的 maxBuffer 不够 */
const CHILD_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * 跑一个子进程并把它的 JSON 读数收回来。
 *
 * **退出码不作判据**（见文件头：解过档的进程收尾必被 V8 中止，崩溃码是环境性质不是结果性质），
 * 只看 stdout 最后一行能不能解析成合法 JSON——与 `tools/parse-corpus.mjs` 同一条规避法。
 */
function runChild(scenario: string, batch = 0): ChildResult {
  const env: Record<string, string | undefined> = { ...process.env, NODE_NO_WARNINGS: '1' };
  delete env.NODE_OPTIONS; // 别把 vitest 注入的旗标带进子进程（子进程只要 node 本身）
  const result = spawnSync(process.execPath, [childScript, scenario, String(batch)], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: CHILD_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  const line = (result.stdout ?? '').trim().split('\n').pop() ?? '';
  let parsed: ChildResult;
  try {
    parsed = JSON.parse(line) as ChildResult;
  } catch {
    throw new Error(
      `子进程（场景 ${scenario}#${batch}）没有给出合法 JSON：rc=${result.status} signal=${result.signal}\n` +
        `stdout 末行：${line.slice(0, 400)}\nstderr 尾部：\n${(result.stderr ?? '').slice(-800)}`,
    );
  }
  if (parsed.error !== null) throw new Error(`子进程（场景 ${scenario}#${batch}）内部抛错：\n${parsed.error}`);
  return parsed;
}

/* ------------------------------ 量数工具 ------------------------------ */

interface Latency {
  readonly p50: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
  readonly runs: number;
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}

function latency(samples: readonly number[]): Latency {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    runs: sorted.length,
  };
}

const fmt = (l: Latency): string =>
  `p50 ${l.p50.toFixed(2)} ms / p95 ${l.p95.toFixed(2)} ms（min ${l.min.toFixed(2)}、max ${l.max.toFixed(2)}、n=${l.runs}）`;

/** 跨批次聚合出来的读数（拆进程前是同一台引擎的连续轮次，现在按批次池化，样本数不变） */
interface BatchReading {
  readonly children: readonly ChildResult[];
  readonly samples: readonly PerfSample[];
  readonly reading: Latency;
  readonly peakRssMb: number;
  readonly fatal: readonly unknown[];
}

function aggregate(children: readonly ChildResult[]): BatchReading {
  const samples = children.flatMap((child) => [...child.samples]);
  return {
    children,
    samples,
    reading: latency(samples.map((sample) => sample.ms)),
    peakRssMb: Math.max(...children.map((child) => child.memory.peakRssMb)),
    fatal: children.flatMap((child) => [...child.fatal]),
  };
}

/** 分腿均值（单位 ms；`total` 是各腿相加，用来和整趟墙钟对照） */
interface PerfLegAverages {
  readonly parse: number;
  readonly changedRanges: number;
  readonly semanticQuery: number;
  readonly foldsQuery: number;
  readonly indentQuery: number;
  readonly syntaxScan: number;
  readonly total: number;
}

/**
 * 分腿均值（子进程按"计量轮"平均后回传，这里跨批次再取均值）。
 * 缺项按 0 计：某条腿整批没跑到（例如缩进那面装配时就回落了）本来就是 0，不是读数丢了。
 */
function legsOf(children: readonly ChildResult[]): PerfLegAverages {
  const sum = { parse: 0, changedRanges: 0, semanticQuery: 0, foldsQuery: 0, indentQuery: 0, syntaxScan: 0 };
  let counted = 0;
  for (const child of children) {
    const legs = child.legs;
    if (!legs) continue;
    counted += 1;
    sum.parse += legs.parse ?? 0;
    sum.changedRanges += legs.changedRanges ?? 0;
    sum.semanticQuery += legs.semanticQuery ?? 0;
    sum.foldsQuery += legs.foldsQuery ?? 0;
    sum.indentQuery += legs.indentQuery ?? 0;
    sum.syntaxScan += legs.syntaxScan ?? 0;
  }
  const divide = (value: number): number => Number((value / Math.max(1, counted)).toFixed(3));
  const parse = divide(sum.parse);
  const changedRanges = divide(sum.changedRanges);
  const semanticQuery = divide(sum.semanticQuery);
  const foldsQuery = divide(sum.foldsQuery);
  const indentQuery = divide(sum.indentQuery);
  const syntaxScan = divide(sum.syntaxScan);
  return {
    parse,
    changedRanges,
    semanticQuery,
    foldsQuery,
    indentQuery,
    syntaxScan,
    total: Number((parse + changedRanges + semanticQuery + foldsQuery + indentQuery + syntaxScan).toFixed(3)),
  };
}

/** 结构段台账里的 semantic 那一面（父进程只做比较，不再自己解） */
const asTokens = (value: readonly unknown[] | null): KojoStructureToken[] | null =>
  value === null ? null : (value as KojoStructureToken[]);

/** 折叠/残缺两面同上：父进程只做逐字比较，判据的形状与 `KojoStructureFold` / `KojoStructureSyntaxFault` 一致 */
const asFolds = (value: readonly unknown[] | null | undefined, label: string): readonly Record<string, number>[] => {
  if (value === null || value === undefined) throw new Error(`${label}：子进程没有回 folds 这一面（判据不能拿到 undefined 装绿）`);
  return value as readonly Record<string, number>[];
};

const asFaults = (value: readonly unknown[] | null | undefined, label: string): readonly Record<string, unknown>[] => {
  if (value === null || value === undefined) throw new Error(`${label}：子进程没有回 syntax 这一面（判据不能拿到 undefined 装绿）`);
  return value as readonly Record<string, unknown>[];
};

/** 取子进程回样的第 index 条（缺样就是子进程没跑完，直接说清楚，别让判据拿到 undefined 装绿） */
function sampleAt(samples: readonly PerfSample[], index: number, label: string): PerfSample {
  const found = samples[index];
  if (found === undefined) throw new Error(`子进程（${label}）没有给出第 ${index + 1} 条样本，只回了 ${samples.length} 条`);
  return found;
}

const rssLine = (label: string, batch: BatchReading): string =>
  `${label} 各子进程峰值 RSS: ${batch.children.map((child) => `${child.batch}#${child.memory.peakRssMb}MB`).join(' / ')}（单批最高 ${batch.peakRssMb} MB；JS heap 高水位 ≤ ${Math.max(...batch.children.map((child) => child.memory.peakHeapMb))} MB、external ≤ ${Math.max(...batch.children.map((child) => child.memory.externalMb))} MB ⇒ 涨在 wasm 侧不是 JS 侧）`;

let coldBatch: BatchReading | null = null;

/* ================================= 用例 ================================= */

describe('结构解析 · 偏移口径（UTF-16 码元，不是字节）', () => {
  it('代理对（emoji / astral）改一处：增量结果仍与整篇重解逐字相等', () => {
    // web-tree-sitter 的 `Edit.startIndex` 与 `Node.startIndex` 都是 **JS 字符串下标 = UTF-16 码元**；
    // `edit.ts` 的 `pointAt()` 也按码元计列。谁哪天换成字节偏移（UTF-8）来过这道闸，
    // 这一条立刻红——代理对前后每一格的偏移都会差一格，树被编辑歪就是着色歪。
    const doc = surrogateDoc();
    const nextDoc = surrogateNextDoc(doc);
    const child = runChild('surrogate');
    expect(child.docLength, '子进程用的文档与父进程这份不等 ⇒ 两侧生成口径漂了').toBe(doc.length);
    expect(child.readChunk, '子进程里的 STRUCTURE_READ_CHUNK 与本文件不是同一个数').toBe(STRUCTURE_READ_CHUNK);
    expect(doc.length).toBeGreaterThan([...doc].length); // 确有代理对（码元数 > 码点数）

    const edit = commonEdit(doc, nextDoc);
    expect(applyEdit(doc, edit)).toBe(nextDoc);

    const incrementalStat = sampleAt(child.samples, 0, 'surrogate 增量那一趟');
    const incremental = asTokens(child.tokens)!;
    const realigned = asTokens(child.tokensRealigned)!;
    const incrementalFold = asFolds(child.folds, '代理对增量那一趟');
    const realignedFold = asFolds(child.foldsRealigned, '代理对整篇重解那一趟');
    expect(nextDoc.length).toBe(child.nextDocLength);
    console.log(`\n===== ⑤b 偏移口径（代理对一处替换）=====`);
    console.log(`增量取字 ${incrementalStat.reads} 段 / 编辑点 ${incrementalStat.editStart}..${incrementalStat.editEnd}（码元）/ 结构段 ${incremental.length} 条 / 折叠 ${incrementalFold.length} 条`);
    expect(incrementalStat.incremental, '这一趟没走增量').toBe(true);
    expect(incremental, '代理对编辑后的增量着色段与整篇重解不等 ⇒ 偏移口径漂了').toEqual(realigned);
    // 折叠那一面同样吃码元轴上的偏移口径：代理对把"码元 ≠ 字节"这条线在两面上一齐验掉
    expect(incrementalFold, '代理对编辑后的增量折叠区间与整篇重解不等 ⇒ 窗口/平移那一条在代理对上漂了').toEqual(realignedFold);
    expect(incremental.length).toBeGreaterThan(0);
    expect(child.fatal, `代理对这一趟出现整档停用级别的错误：${JSON.stringify(child.fatal)}`).toHaveLength(0);
  }, 120_000);
});

describe('结构解析 · 冷全量解读数（5,000 行合成档）', () => {
  const doc = syntheticDoc();

  it(`${COLD_RUNS} 轮整篇重解：p50/p95 + 取字段数与文档规模挂钩`, () => {
    const children: ChildResult[] = [];
    for (let batch = 0; batch < COLD_CHILDREN; batch++) {
      const child = runChild('cold', batch);
      expect(child.docLength, `第 ${batch} 批的文档与父进程这份不等`).toBe(doc.length);
      expect(child.samples, `第 ${batch} 批的样本数不对`).toHaveLength(COLD_SAMPLES_PER_CHILD);
      children.push(child);
    }
    const batch = aggregate(children);
    coldBatch = batch;
    const reading = batch.reading;
    const stat = batch.samples[batch.samples.length - 1]!; // 最后一批的最后一轮（与拆进程前同一个位置）
    const lineCount = doc.split('\n').length - 1;
    console.log(`\n===== ⑤ 结构解析墙钟（node 子进程直调引擎，非真 Worker；${lineCount} 行 / ${doc.length} 码元）=====`);
    console.log(`冷全量解（parse + 查询 + 回话）: ${fmt(reading)}（${COLD_CHILDREN} 个子进程 × ${COLD_WARM_ROUNDS} 轮预热 + ${COLD_SAMPLES_PER_CHILD} 轮计量）`);
    console.log(`整篇解取字 ${stat.reads} 段 / 段上限 ${STRUCTURE_READ_CHUNK} 码元 ⇒ 窗口 ${stat.readStart}..${stat.readEnd}（覆盖全文）`);
    console.log(rssLine('拆进程后', batch));
    expect(reading.runs).toBe(COLD_RUNS);
    expect(stat, '整篇解之后没有读数').not.toBeNull();
    // 引擎走的是有界 stringer ⇒ 一份全文至少要取"全文码元 / 段上限"这么多次
    expect(stat.reads, '整篇解的取字段数少于"覆盖全文"的下界 ⇒ 引擎没把全文喂给解析器').toBeGreaterThanOrEqual(
      Math.floor(doc.length / STRUCTURE_READ_CHUNK),
    );
    expect(stat.incremental, 'parse 消息不该冒充增量').toBe(false);
    // 极松绝对上界：本机实测 p95 是 5×10¹ ms 量级，这一条只抓"有人把整篇扫描改贵了一个数量级"。
    expect(reading.p95, `整篇解 p95 ${reading.p95.toFixed(1)} ms 超宽松上界`).toBeLessThan(400);
    expect(batch.fatal, `整篇解期间出现整档停用级别的错误：${JSON.stringify(batch.fatal)}`).toHaveLength(0);
  }, 240_000);

  it('语法没解出错误恢复的糊块（否则上面的时间判据量的是别的东西）', () => {
    const batch = coldBatch ?? aggregate(Array.from({ length: COLD_CHILDREN }, (_, one) => runChild('cold', one)));
    const tokens = asTokens(batch.children[batch.children.length - 1]!.tokens);
    expect(tokens, '三面里 semantic 一个字都没回 ⇒ 查询或档位表漂了').not.toBeNull();
    expect(tokens!.length).toBeGreaterThan(1_000);
    const wide = tokens!.filter((token) => token.endRow - token.startRow > 200);
    console.log(`结构段总数 ${tokens!.length}，其中跨 >200 行的 ${wide.length} 段（错误恢复跑飞的形状判据）`);
    expect(wide, '出现跨 >200 行的结构段 ⇒ 语法错误恢复在合成档上跑飞，先修语法再谈性能').toHaveLength(0);
  }, 240_000);
});

describe('结构解析 · 单击键增量（真 tree.edit + 有界取字）', () => {
  it('一次改一行：结果与整篇重解逐字相等，且取字窗口只贴着改动点', () => {
    const child = runChild('single-edit');
    const doc = syntheticDoc();
    expect(child.docLength).toBe(doc.length);
    // 走宿主同一条缝：模型侧先热一次击键（首击必重扫全文，见文件头第 4 条），再把 1200 行那一行整行换掉。
    // 缝合算术在父进程核（纯字符串，不碰 wasm）：commonEdit 算出的那条编辑必须能把旧文本缝回新文本。
    const afterWarm = nextDocAfterInsert(doc, WARM_EDIT_ROW);
    const nextDoc = nextDocAfterLineReplace(afterWarm, SINGLE_EDIT_ROW);
    const onPristine = nextDocAfterLineReplace(doc, SINGLE_EDIT_ROW);
    expect(applyEdit(doc, commonEdit(doc, onPristine)), 'commonEdit/applyEdit 与手改的下一版文本不一致 ⇒ 缝合口径漂了').toBe(onPristine);
    expect(child.nextDocLength, '子进程最终那份文本与父进程算出来的不等 ⇒ 编辑点漂了').toBe(nextDoc.length);

    const firstChange = sampleAt(child.samples, 0, 'single-edit 首击');
    const stat = sampleAt(child.samples, 1, 'single-edit 稳定态那一击');
    const realignedStat = sampleAt(child.samples, 2, 'single-edit 整篇重解');
    const incremental = asTokens(child.tokens)!;
    const realigned = asTokens(child.tokensRealigned)!;
    const incrementalFold = asFolds(child.folds, 'single-edit 增量那一趟');
    const realignedFold = asFolds(child.foldsRealigned, 'single-edit 整篇重解那一趟');
    const incrementalFault = asFaults(child.faults, 'single-edit 增量那一趟');
    const realignedFault = asFaults(child.faultsRealigned, 'single-edit 整篇重解那一趟');
    expect(child.baselineCount, '打底那趟没有回结构段').toBeGreaterThan(0);

    // ① 判据（结构不变）：增量解出来的**三面**必须与整篇重解逐字相等
    expect(incremental, '增量这一趟没有回 semantic').not.toBeNull();
    expect(incremental, '增量结果与整篇重解不等 ⇒ 树没被正确复用（把错的树留在手上着色）').toEqual(realigned);
    expect(incrementalFold, '增量折叠区间与整篇重解不等 ⇒ 窗口重查 + 缓存平移拼出来的折叠漂了').toEqual(realignedFold);
    expect(incrementalFault, '增量结构残缺与整篇重解不等 ⇒ 残缺那一条腿的窗口拼装漂了').toEqual(realignedFault);
    expect(incrementalFold.length, '合成档上折叠这一面就该有货（@fold 自 TSIT2-E 起真供折叠）').toBeGreaterThan(100);

    // ② 判据（局部性）：向文本取字的窗口必须贴着编辑点，而不是全文
    const window = stat.readEnd - stat.readStart;
    console.log(`\n===== ⑥ 单击键增量（${DOC_LINES} 行档，改第 ${SINGLE_EDIT_ROW + 1} 行）=====`);
    console.log(`改动前结构段数      : ${child.baselineCount} / 折叠 ${child.baselineFolds} / 残缺 ${child.baselineFaults}`);
    console.log(`用得上旧树          : ${stat.incremental}`);
    console.log(`取字段数 / 窗口     : ${stat.reads} 段 / ${stat.readStart}..${stat.readEnd}（窗口 ${window} 码元 = 全文的 ${((window / nextDoc.length) * 100).toFixed(2)}%）`);
    console.log(`编辑点（新文本）    : ${stat.editStart}..${stat.editEnd}，文档 ${stat.documentLength} 码元`);
    console.log(`这一趟的回话        : ${child.emitted}`);
    console.log(`引擎实际在跑的面    : ${(child.capabilities ?? []).join('+')}（判据：台账与这张表成对相等）`);
    const legs = child.legs ?? {};
    const queryLeg = (legs.semanticQuery ?? 0) + (legs.foldsQuery ?? 0) + (legs.indentQuery ?? 0) + (legs.syntaxScan ?? 0);
    console.log(
      `这一击的分腿        : parse ${legs.parse ?? 0} + 问脏段 ${legs.changedRanges ?? 0} + 查询与扫描 ${queryLeg.toFixed(2)} ⇒ 对照整趟 ${stat.ms.toFixed(2)} ms（旧口径这里查询与扫描 ≈ 35 ms，是 parse 的八倍）`,
    );
    const firstWindow = Math.min(firstChange.readEnd, nextDoc.length) - firstChange.readStart;
    console.log(
      `首击（刚开档第一次）: ${firstChange.reads} 段 / 窗口 ${firstChange.readStart}..${firstChange.readEnd} = 全文的 ${((firstWindow / nextDoc.length) * 100).toFixed(0)}% / ${firstChange.ms.toFixed(2)} ms（本语法带缩进记号，整篇解后第一击的**解**必把全文重扫一遍；从第二击起解才局部 ⇒ 局部性判据钉稳定态那一击，预热那一击落在被测行下方两行，首击这条只报数不藏。查询那一段从这一击起就吃缓存——整篇解已经把三面结果填进缓存 ⇒ 首击 queryScope=${firstChange.queryScope}）`,
    );
    console.log(`对照·整篇重解       : ${realignedStat.reads} 段 / ${realignedStat.ms.toFixed(2)} ms（queryScope=${realignedStat.queryScope}）`);
    console.log(`子进程峰值 RSS      : ${child.memory.peakRssMb} MB（heap ≤ ${child.memory.peakHeapMb} MB）`);
    expect(stat.incremental, '这一次没有走增量（旧树没被用上）').toBe(true);
    expect(stat.reads, '增量取字段数超过"改动附近几段"的量级 ⇒ 实际在重解全文').toBeLessThanOrEqual(8);
    expect(window, '取字窗口占了全文的两成以上 ⇒ 局部性不成立').toBeLessThan(nextDoc.length * 0.2);
    expect(stat.readStart, '取字起点不在编辑点附近').toBeGreaterThanOrEqual(stat.editStart - STRUCTURE_READ_CHUNK);
    expect(stat.readEnd, '取字终点不在编辑点附近').toBeLessThanOrEqual(stat.editEnd + 2 * STRUCTURE_READ_CHUNK);
    expect(stat.documentLength).toBe(nextDoc.length);
    // ③ 判据（查询也局部）：稳定态这一击的三面都该走改动窗口，而不是把整篇再查一遍；
    //    首击（刚整篇解完）也吃同一份缓存 —— 那一条以前是"必然重查全文"，现在是判据不是打印。
    expect(stat.queryScope, `稳定态这一击没走窗口（理由：${stat.queryFullReason || '（未给）'}）`).toBe('window');
    expect(stat.windowNodes, '窗口里一枚顶层节点都没有 ⇒ queryScope 说的"走窗口"是空的').toBeGreaterThan(0);
    expect(stat.changedRanges, '旧树报回来的改动段数是 -1 ⇒ 压根没问（窗口那条路没接上）').toBeGreaterThanOrEqual(0);
    expect(firstChange.queryScope, `首击没吃上缓存（理由：${firstChange.queryFullReason || '（未给）'}）⇒ 整篇解就该把三面结果填进缓存`).toBe('window');
    expect(realignedStat.queryScope, '整篇重解那一条路本来就把整篇查一遍').toBe('full');
    // 台账形状：增量这一趟说的三面必须与整篇重解**一模一样**（folds 自 TSIT2-E 起由 @fold 供，
    // indents 查询仍无 @indent.* 捕获 ⇒ 装配时就已回落；少一面或多一面都是漂）。
    expect(child.emitted, '增量这一趟的回话台账不对').toBe('semantic+folds+syntax');
    expect(child.emittedRealigned, '整篇重解与增量的回话台账不一致 ⇒ 有一面只在其中一条腿上说话').toBe(child.emitted);
    // 成对判据：台账 = 引擎自己报的"我在跑哪些面"。这张表由 `StructureEngine.capabilities` 说话，
    // 不再有人（包括本文件以前那句"增量那一趟只该回 semantic"的注释）抄一份清单当口径。
    expect(child.capabilities, '回话台账与引擎实际在跑的面不成对 ⇒ 有一面静默掉了').toEqual(child.emitted.split('+'));
    expect(child.fatal, `增量期间出现整档停用级别的错误：${JSON.stringify(child.fatal)}`).toHaveLength(0);
  }, 180_000);

  it(`${EDIT_RUNS} 次单击键增量：p50/p95（目标 <16 ms 一帧）`, () => {
    const children: ChildResult[] = [];
    for (let batch = 0; batch < EDIT_CHILDREN; batch++) {
      const child = runChild('edit-batch', batch);
      expect(child.samples, `第 ${batch} 批的击键样本数不对`).toHaveLength(EDIT_SAMPLES_PER_CHILD);
      children.push(child);
    }
    const batch = aggregate(children);
    const reading = batch.reading;
    const full = coldBatch ?? aggregate(Array.from({ length: COLD_CHILDREN }, (_, one) => runChild('cold', one)));
    const readSamples = batch.samples.map((sample) => sample.reads);
    const tokenSamples = new Set(batch.samples.map((sample) => sample.tokenCount));
    const scopes = batch.samples.map((sample) => sample.queryScope);
    const windowNodes = batch.samples.map((sample) => sample.windowNodes);
    const legs = legsOf(children);
    console.log(`\n===== ⑦ 单击键增量 p50/p95（每批一台引擎、同一份 ${DOC_LINES} 行档）=====`);
    console.log(`增量解（parse + 查询 + 回话）: ${fmt(reading)}（${EDIT_CHILDREN} 个子进程 × ${EDIT_WARM_EDITS} 次预热击键 + ${EDIT_SAMPLES_PER_CHILD} 次计量）`);
    console.log(`对照·整篇重解（⑤ 那一轮）   : ${fmt(full.reading)}`);
    console.log(`增量取字段数                : 中位 ${quantile([...readSamples].sort((a, b) => a - b), 0.5)} / 最大 ${Math.max(...readSamples)}`);
    // 逐批样本序是"尾部尖刺是冷首击还是随机抢占"的唯一现场证据（p95 翻线时先看这里，再决定修判据还是修实现）
    console.log(
      `各批样本（ms，从左到右）      : ${children.map((child, index) => `#${index} ${child.samples.map((sample) => sample.ms.toFixed(2)).join('/')}`).join('  |  ')}`,
    );
    console.log(`每一击键的结构段数          : ${[...tokenSamples].join(' / ')}（不随击键漂移 = 增量没把树解歪）`);
    const fellBack = batch.samples.filter((sample) => sample.queryScope !== 'window');
    console.log(`查询走的是什么              : ${[...new Set(scopes)].join(' / ')}（窗口里的顶层节点数 ${windowNodes.join(' / ')}）`);
    if (fellBack.length > 0) {
      console.log(`退回整篇的击键              : ${fellBack.map((sample) => `[${sample.queryFullReason}]`).join('  ')}`);
    }
    console.log(
      `分腿均值（每击键）            : parse ${legs.parse.toFixed(2)} + 问脏段 ${legs.changedRanges.toFixed(2)} + 着色 ${legs.semanticQuery.toFixed(2)} + 折叠 ${legs.foldsQuery.toFixed(2)} + 缩进 ${legs.indentQuery.toFixed(2)} + 残缺扫描 ${legs.syntaxScan.toFixed(2)} = ${legs.total.toFixed(2)} ms（改前这一趟查询 + 扫描 ≈ 35 ms，整档 p50 ≈ 40 ms）`,
    );
    const slowest = Math.max(...batch.samples.map((sample) => sample.ms));
    console.log(
      `目标线 16 ms：p50 ${reading.p50 < 16 ? '达标' : '未达标'}（${reading.p50.toFixed(2)} ms，余量 ${(16 / reading.p50).toFixed(2)}×）/ p95 ${reading.p95 < 16 ? '达标' : '未达标'}（${reading.p95.toFixed(2)} ms，余量 ${(16 / reading.p95).toFixed(2)}×；n=${reading.runs} ⇒ p95 取第 ${Math.ceil(reading.runs * 0.95)} 差，已不是最大值）/ 最慢一击 ${slowest.toFixed(2)} ms（只报不判）`,
    );
    console.log(rssLine('拆进程后', batch));
    expect(reading.runs).toBe(EDIT_RUNS);
    // 结构判据（比值，不靠绝对毫秒）：增量必须比整篇重解**便宜得多**。
    // 系数从 1.2 抬到 4：改前实测比值只有 1.35–1.55（大头就是每击键那一遍全文查询），
    // 查询接上窗口后本机实测 ~8 倍（增量 p50 ≈ 7 ms / 整篇 ≈ 55 ms）。系数留一倍余量给满载，
    // 而"有人把整篇重查塞回 change()"那种形态会直接把比值打回 1.4 ⇒ 这条一定翻线。
    expect(
      reading.p50 * 4,
      `增量 p50 ${reading.p50.toFixed(2)} ms 已经不像增量（整篇重解 p50 ${full.reading.p50.toFixed(2)} ms）⇒ 有人把全文重解或全文重查查回来了`,
    ).toBeLessThan(full.reading.p50);
    // 一帧线：p50 与 p95 都钉在 16 ms 上。本机 n=32 三轮实测 p50 6.26–6.73 / p95 7.64–8.53。
    // 这条线以前只敢打印不敢判：改前 p95 = 47 ms（每击键整篇重查 + 全树重扫），窗口那条腿接上
    // 之后才真的进了一帧。样本数 2026-10-20 从 n=12 提到 n=32（理由见文件头）：n=12 时 p95 就是最大值，
    // 单点 CPU 抢占会假红；提到 32 后 p95 取第 2 差，**16 ms 这条线一个字没动**。
    expect(reading.p50, `增量 p50 ${reading.p50.toFixed(2)} ms 超过一帧线 16 ms`).toBeLessThan(16);
    expect(
      reading.p95,
      `增量 p95 ${reading.p95.toFixed(2)} ms 超过一帧线 16 ms（n=${reading.runs}：p95 已取第 ${Math.ceil(reading.runs * 0.95)} 差，不再是单点抖动；先查上面"退回整篇的击键"那行是不是有内容——那是判据在退路，不是负载）`,
    ).toBeLessThan(16);
    // 取字窗口与文档规模解耦（每击键只该取改动附近那几段）
    expect(Math.max(...readSamples), '某次击键取了 16 段以上 ⇒ 增量退化成全文重扫').toBeLessThanOrEqual(16);
    // 查询侧同样不许退化：这一批每击键都该走窗口（走整篇的理由由上一条流对账用例负责说明）
    expect(
      scopes.filter((scope) => scope !== 'window').length,
      `有击键没走查询窗口：${batch.samples.filter((sample) => sample.queryScope !== 'window').map((sample) => `${sample.queryScope}(${sample.queryFullReason})`).join(' / ')}`,
    ).toBe(0);
    expect(Math.max(...windowNodes), '窗口里的顶层节点数大得离谱 ⇒ 窗口判据没生效').toBeLessThanOrEqual(STRUCTURE_MAX_WINDOW_NODES);
    expect(batch.fatal, `增量循环出现整档停用级别的错误：${JSON.stringify(batch.fatal)}`).toHaveLength(0);
  }, 240_000);

  it(`${STREAM_EDITS} 击混合流（带残缺）：每一击三面都与整篇重算逐字相等`, () => {
    const child = runChild('stream');
    const records = child.stream ?? [];
    expect(records, '子进程没有回流对账记录').toHaveLength(STREAM_EDITS);
    expect(child.docLength, '流对账那份文档与父进程这份不等 ⇒ 两侧生成口径漂了').toBe(brokenDoc(STREAM_DOC_LINES).length);
    const mismatches = records.filter((record) => record.mismatch !== null);
    const windowed = records.filter((record) => record.queryScope === 'window');
    const shifted = records.filter((record) => record.deltaRows !== 0);
    const withFaults = records.filter((record) => record.faults > 0);
    console.log(`\n===== ⑧ 混合击键流对账（${STREAM_DOC_LINES} 行 + 三处真残缺，${STREAM_EDITS} 击）=====`);
    console.log(
      `形状覆盖              : ${[...new Set(records.map((record) => record.kind))].join(' / ')}；行数变动的击键 ${shifted.length} 击 / 窗口顶上的击键 ${windowed.length} 击 / 有残缺的击键 ${withFaults.length} 击`,
    );
    console.log(`残缺条数轨迹          : ${records.map((record) => record.faults).join(' → ')}`);
    console.log(`每击的改动段数        : ${records.map((record) => record.changedRanges).join(' / ')}`);
    for (const record of mismatches) {
      console.log(`  ✗ 第 ${record.step + 1} 击（${record.kind} @行 ${record.row}，行差 ${record.deltaRows}，${record.queryScope}）：${record.mismatch}`);
    }
    // 判据：逐击、逐面 `toEqual` 整篇重算（差异说明由子进程带回，父进程只把"全 null"钉成判据）
    expect(mismatches.map((record) => `#${record.step + 1} ${record.mismatch}`), `有 ${mismatches.length} 击的增量结果与整篇重算不等`).toEqual([]);
    // 这条用例自己也必须有效：没有残缺、没有行数变动、一次窗口都没走上，都算它白跑
    expect(withFaults.length, '流里没有一击真的带回残缺 ⇒ 残缺那一条腿的判据是空的').toBeGreaterThan(0);
    expect(shifted.length, '流里没有一击真的改到行数 ⇒ 缓存平移那条判据是空的').toBeGreaterThan(0);
    expect(windowed.length, '流里没有一击走上窗口 ⇒ 这条对账量的是"整篇重查"，不是增量').toBeGreaterThan(STREAM_EDITS / 2);
    expect(child.fatal, `流对账出现整档停用级别的错误：${JSON.stringify(child.fatal)}`).toHaveLength(0);
  }, 240_000);

  it('没有旧树时退回整篇重解（而"有旧树"那一趟确实是增量）', () => {
    const child = runChild('fallback');
    const doc = syntheticDoc(FALLBACK_DOC_LINES);
    expect(child.docLength, '小档那份文本与父进程这份不等').toBe(doc.length);
    expect(child.preInitReplies, '未装配的引擎不该自己回话（worker 的"尚未装配"分支才该说）').toBe(0);
    expect(child.preInitStat, '未装配的引擎不该有读数').toBeNull();
    const cold = child.coldStat!;
    const stat = child.changedStat!;
    expect(cold.incremental, 'parse 消息不该冒充增量').toBe(false);
    console.log(`小档（${FALLBACK_DOC_LINES} 行）无旧树那一次：incremental=${cold.incremental} 取字 ${cold.reads} 段；有旧树：incremental=${stat.incremental} 取字 ${stat.reads} 段`);
    expect(stat.incremental).toBe(true);
    expect(stat.reads).toBeLessThanOrEqual(8);
    expect(child.fatal, `小档这一趟出现整档停用级别的错误：${JSON.stringify(child.fatal)}`).toHaveLength(0);
  }, 120_000);
});
