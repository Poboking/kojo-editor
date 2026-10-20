#!/usr/bin/env node
/**
 * tree-sitter 结构解析 perf 的**子进程执行体**（父进程 = `tests/tree-sitter-parse.perf.test.ts`）。
 *
 * ## 为什么要有这个子进程（不是把引擎搬进来，是把"解档这件事"搬出去）
 *
 * web-tree-sitter 0.27 + Node 24（Windows）实测两条硬事实：
 * 1. 同一进程里**每解一次** 5,000 行档，原生 RSS 抬 ~110–150 MB 且**不还给操作系统**
 *    （V8 `heapUsed` 全程平的 ≤ 40 MB、`external` 平的 ⇒ 不是 JS 侧滞留，`Tree`/`Parser`/`Query`
 *    也都按规矩 `delete()` 了；涨在 wasm/分配器那一侧的进程高水位）；
 * 2. **只要解过一次**，进程退出时（V8 `DisposeIsolate`）必报 `Fatal process out of memory: Zone`
 *    并以 0x80000003 中止——连"只解一轮"也炸；只 `init()` 不解则干净退出 rc=0。
 *    ⇒ 父进程（vitest fork）绝不能亲自碰 wasm，否则整条池子收尾时报
 *      `Worker exited unexpectedly`（正是本批要把这条用例判红的原因）。
 *
 * 与本仓库既有条例一致（`packages/kojo-syntax-tree/tools/parse-corpus.mjs`）：**以 stdout 的 JSON 为准，
 * 不看子进程退出码**，崩溃只污染 stderr。故本文件把读数写成一行 JSON 后自然结束，stdout 已同步写完。
 *
 * ## 打的是生产代码
 *
 * 子进程 `import()` 的是 `src/monaco/tree-sitter/engine.ts`（`StructureEngine`）与 `edit.ts`
 * （`commonEdit`）本体，与 worker 里那一台逐字相同；文档由 `tree-sitter-perf-corpus.ts` 与父进程
 * 共用一份生成函数 ⇒ 两侧文本永远对齐。测试文件里的判据一条不减，只是数据来自这里。
 *
 * ## 回话台账（`emitted`）与"引擎实际在跑的面"（`capabilities`）
 *
 * 台账 = 这一趟引擎说了哪几句（`semantic+folds+syntax`…）。自 TSIT2-E 起 `folds.scm` 真的发
 * `@fold` ⇒ 折叠这一面不再走"无捕获即回落"那条路，台账因此是**三面**而不是一面；缩进那一面
 * 仍在装配时就回落（`indents.scm` 没有 `@indent.*` 捕获）⇒ 不在台账里。这两件事现在由
 * `StructureEngine.capabilities`（引擎自己报）与台账**成对**交回，父进程判"台账 == capabilities"
 * ——清单抄在别处的日子结束了，漂一条就红。
 *
 * 用法：`node tree-sitter-perf-child.mjs <场景> <批次号>`
 * 场景：`cold`（整篇重解若干轮）/ `edit-batch`（打底 + 连续单击键增量）/
 *       `single-edit`（一次改一行：增量 vs 整篇重解逐字比较，三面都比）/ `surrogate`（代理对偏移）/
 *       `fallback`（没有旧树时退回整篇重解）/ `stream`（带残缺的混合击键流，逐击与整篇重算对账）。
 *
 * 需要 Node 22.18+ / 24（内置 TS 类型擦除默认开启）+ 一个 `.ts` 后缀解析钩子：
 * 生产模块内部走的是无扩展名相对导入（`./types`），Node 原生 ESM 不猜扩展名，
 * 所以在这里注册 `module.registerHooks` 的 resolve 钩子补 `.ts`（同进程内的钩子，无需额外文件/旗标）。
 */

import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.')) {
        for (const suffix of ['.ts', '/index.ts']) {
          try {
            return nextResolve(specifier + suffix, context);
          } catch {
            /* 换下一个后缀再试 */
          }
        }
      }
      throw error;
    }
  },
});

const here = dirname(fileURLToPath(import.meta.url)); // packages/app/tests/helpers
const repoRoot = resolve(here, '..', '..', '..', '..');
const tsDir = join(repoRoot, 'packages', 'app', 'src', 'monaco', 'tree-sitter');
const importUrl = (file) => pathToFileURL(file).href;

const { StructureEngine, STRUCTURE_READ_CHUNK } = await import(importUrl(join(tsDir, 'engine.ts')));
const { commonEdit } = await import(importUrl(join(tsDir, 'edit.ts')));
const corpus = await import(importUrl(join(here, 'tree-sitter-perf-corpus.ts')));

/** 与 worker 里 `assets.ts` 同一批文件；node 侧用 `fs` 读（`?url` / `?raw` 在这池里解析不了） */
const assets = {
  runtimeWasm: join(repoRoot, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
  grammarWasm: readFileSync(join(repoRoot, 'packages', 'kojo-syntax-tree', 'tree-sitter-kojo.wasm')),
  highlightsQuery: readFileSync(join(repoRoot, 'packages', 'kojo-syntax-tree', 'queries', 'highlights.scm'), 'utf8'),
  foldsQuery: readFileSync(join(repoRoot, 'packages', 'kojo-syntax-tree', 'queries', 'folds.scm'), 'utf8'),
  indentsQuery: readFileSync(join(repoRoot, 'packages', 'kojo-syntax-tree', 'queries', 'indents.scm'), 'utf8'),
};

const scenario = process.argv[2] ?? '';
const batch = Number(process.argv[3] ?? '0');
const MB = 1048576;

/** 本进程的内存读数：原生高水位就是拆进程的那条例矩本身 */
const mem = { peakRssMb: 0, peakHeapMb: 0, externalMb: 0 };
function observeMemory() {
  const m = process.memoryUsage();
  mem.peakRssMb = Math.max(mem.peakRssMb, Math.round((m.rss ?? 0) / MB));
  mem.peakHeapMb = Math.max(mem.peakHeapMb, Math.round(m.heapUsed / MB));
  mem.externalMb = Math.max(mem.externalMb, Math.round(m.external / MB));
}

/** 分腿累加器（引擎只在挂了 `trace` 时才取时间戳；不给 = 完全不量） */
function legBag() {
  const sum = {};
  const totals = {};
  let rounds = 0;
  return {
    /** 每轮开头清一次：只有计量轮才 `settle()`，预热轮的分腿不进读数 */
    trace: (leg, ms) => {
      sum[leg] = (sum[leg] ?? 0) + ms;
    },
    begin() {
      for (const leg of Object.keys(sum)) delete sum[leg];
    },
    settle() {
      rounds += 1;
      for (const [leg, ms] of Object.entries(sum)) totals[leg] = (totals[leg] ?? 0) + ms;
    },
    /** 折成"每一击/每一篇的平均分腿"（除以计量轮数；没跑过的腿不出现） */
    average() {
      const out = {};
      for (const [leg, ms] of Object.entries(totals)) out[leg] = Number((ms / Math.max(1, rounds)).toFixed(3));
      return out;
    },
  };
}

/**
 * 装配一台引擎，回话只留判据要的东西：
 * 计量轮次**不留 token**（5,000 行一轮就是两千多条结构段，留着只让 RSS 白涨一截），
 * 只有明确要逐字比较的那一轮把 token/folds/faults 数组交回去（由调用方点名）。
 */
async function useEngine(legs = null) {
  const state = { replies: [], fatal: [] };
  const engine = new StructureEngine({
    assets,
    emit: (message) => {
      state.replies.push(message);
      if (message.type === 'error' && message.capability === 'all') state.fatal.push(message);
    },
    trace: legs === null ? null : legs.trace,
  });
  const ok = await engine.init();
  if (!ok) throw new Error(`引擎装配失败：${JSON.stringify(state.replies.filter((r) => r.type === 'error'))}`);
  return { engine, state };
}

/** 回话台账压成"这趟都说了什么"的形状串（判据：与引擎自己报的面**成对**相等） */
const ledger = (state) => state.replies.map((reply) => reply.type).join('+') || '（无回话）';

/** 最近一条某类型的回话（不回头的找法：同一趟里每面最多一条） */
const lastReply = (state, type) => [...state.replies].reverse().find((reply) => reply.type === type) ?? null;

/** 把一次解的读数折成样本（结果数组本体不留，只留条数） */
function sampleOf(engine, state, ms) {
  const semantic = lastReply(state, 'semantic');
  const stat = engine.lastStat;
  return {
    ms: Number(ms.toFixed(3)),
    reads: stat.reads,
    readStart: stat.readStart,
    readEnd: stat.readEnd,
    editStart: stat.editStart,
    editEnd: stat.editEnd,
    documentLength: stat.documentLength,
    incremental: stat.incremental,
    tokenCount: semantic ? semantic.tokens.length : 0,
    queryScope: stat.queryScope,
    windowNodes: stat.windowNodes,
    changedRanges: stat.changedRanges,
    queryFullReason: stat.queryFullReason,
  };
}

/** 一个子进程只有一台引擎、一份文档：`doc` 恒为 1，但协议要求每条内容回复都带它（跨文档隔离闸） */
const DOC = 1;

const changeRequest = (version, edit) => ({
  type: 'change',
  doc: DOC,
  version,
  start: edit.start,
  oldEnd: edit.oldEnd,
  newEnd: edit.newEnd,
  newText: edit.newText,
});

/* ------------------------------- 各场景 ------------------------------- */

/** 冷全量解：本进程 `COLD_WARM_ROUNDS` 轮预热（wasm 首解贵一个数量级，不计入样本）+ `COLD_SAMPLES_PER_CHILD` 轮计量 */
async function runCold() {
  const doc = corpus.syntheticDoc();
  const legs = legBag();
  const { engine, state } = await useEngine(legs);
  const rounds = corpus.COLD_WARM_ROUNDS + corpus.COLD_SAMPLES_PER_CHILD;
  const samples = [];
  let lastTokens = null;
  for (let run = 0; run < rounds; run++) {
    legs.begin();
    state.replies = [];
    const t0 = performance.now();
    engine.parse(DOC, run + 1, doc);
    const ms = performance.now() - t0;
    observeMemory();
    if (run >= corpus.COLD_WARM_ROUNDS) {
      samples.push(sampleOf(engine, state, ms));
      legs.settle();
    }
    // 只有最后一个批次的最后一轮把 token 交回去（判据③"没有糊块"要数结构段）
    if (run === rounds - 1 && batch === corpus.COLD_CHILDREN - 1) {
      const semantic = lastReply(state, 'semantic');
      lastTokens = semantic ? semantic.tokens : null;
    }
  }
  const fatal = state.fatal;
  const capabilities = engine.capabilities;
  engine.dispose();
  return {
    docLength: doc.length,
    samples,
    emitted: ledger(state),
    capabilities,
    legs: legs.average(),
    fatal,
    tokens: lastTokens,
    tokensRealigned: null,
  };
}

/** 单击键增量：整篇打底 → 预热一击键 → `EDIT_SAMPLES_PER_CHILD` 次计量击键（每子进程从同一份原始档出发） */
async function runEditBatch() {
  const doc = corpus.syntheticDoc();
  const legs = legBag();
  const { engine, state } = await useEngine(legs);
  const starts = corpus.lineStarts(doc);
  engine.parse(DOC, 1, doc);
  observeMemory();
  let current = doc;
  const samples = [];
  const localRounds = corpus.EDIT_WARM_EDITS + corpus.EDIT_SAMPLES_PER_CHILD;
  for (let local = 0; local < localRounds; local++) {
    const globalRun = batch * localRounds + local;
    const row = corpus.editRowFor(globalRun, starts);
    const nextDoc = corpus.nextDocAfterInsert(current, row);
    const edit = commonEdit(current, nextDoc);
    state.replies = [];
    legs.begin();
    const t0 = performance.now();
    engine.change(changeRequest(local + 2, edit));
    const ms = performance.now() - t0;
    observeMemory();
    if (local >= corpus.EDIT_WARM_EDITS) {
      samples.push(sampleOf(engine, state, ms));
      legs.settle(); // 分腿只记计量轮（预热那两击的形状与首击同一条路，不进均值）
    }
    current = nextDoc;
  }
  const fatal = state.fatal;
  const emitted = ledger(state);
  const capabilities = engine.capabilities;
  engine.dispose();
  return {
    docLength: doc.length,
    samples,
    emitted,
    capabilities,
    legs: legs.average(),
    fatal,
    tokens: null,
    tokensRealigned: null,
  };
}

/** 一次改一行：增量结果 vs 整篇重解**逐字**比较（三面都比），并带取字窗口与分腿读数 */
async function runSingleEdit() {
  const doc = corpus.syntheticDoc();
  const legs = legBag();
  const { engine, state } = await useEngine(legs);
  engine.parse(DOC, 1, doc);
  observeMemory();
  const baseline = lastReply(state, 'semantic')?.tokens ?? null;
  const baselineFold = lastReply(state, 'folds')?.folds ?? null;
  const baselineFault = lastReply(state, 'syntax')?.faults ?? null;

  /**
   * **先空跑一击键（不计量、不比较）**：实测"整篇解之后第一次带旧树的重解"必然将文本
   * 从头重扫（reads ≈ 19–20、窗口 = 全文），而之后的每一击才是真局部（reads = 1）。
   * 本用例要量的是"编辑器在用的时候一帧改一行局部不局部"，所以取**稳定态那一击**；
   * 首击那个读数原样交回父进程打印（`firstChange`），不藏。
   * 注：查询那一侧从**第一击**起就吃缓存（整篇解已经把三面结果填进缓存）⇒ 首击那条样本的
   * `queryScope` 也应当是 `window`，父进程把这句话说出来而不是让它躺在读数里。
   */
  const warmRow = corpus.WARM_EDIT_ROW;
  const warmDoc = corpus.nextDocAfterInsert(doc, warmRow);
  state.replies = [];
  const w0 = performance.now();
  engine.change(changeRequest(2, commonEdit(doc, warmDoc)));
  observeMemory();
  const firstChange = sampleOf(engine, state, performance.now() - w0);

  const nextDoc = corpus.nextDocAfterLineReplace(warmDoc, corpus.SINGLE_EDIT_ROW);
  const edit = commonEdit(warmDoc, nextDoc);
  state.replies = [];
  legs.begin();
  const t0 = performance.now();
  engine.change(changeRequest(3, edit));
  const ms = performance.now() - t0;
  observeMemory();
  legs.settle(); // 分腿读数是这一击的：首击（重扫全文）与整篇重解那两条各自另说
  const incrementalSample = sampleOf(engine, state, ms);
  const incrementalTokens = lastReply(state, 'semantic')?.tokens ?? null;
  const incrementalFolds = lastReply(state, 'folds')?.folds ?? null;
  const incrementalFaults = lastReply(state, 'syntax')?.faults ?? null;
  const emitted = ledger(state);
  const fatal = state.fatal;
  const capabilities = engine.capabilities;

  state.replies = [];
  const t1 = performance.now();
  engine.parse(DOC, 4, nextDoc);
  observeMemory();
  const realignedSample = sampleOf(engine, state, performance.now() - t1);
  const realignedTokens = lastReply(state, 'semantic')?.tokens ?? null;
  const realignedFolds = lastReply(state, 'folds')?.folds ?? null;
  const realignedFaults = lastReply(state, 'syntax')?.faults ?? null;

  engine.dispose();
  return {
    docLength: doc.length,
    samples: [firstChange, incrementalSample, realignedSample],
    legs: legs.average(),
    emitted,
    emittedRealigned: ledger(state),
    capabilities,
    fatal,
    tokens: incrementalTokens,
    tokensRealigned: realignedTokens,
    folds: incrementalFolds,
    foldsRealigned: realignedFolds,
    faults: incrementalFaults,
    faultsRealigned: realignedFaults,
    baselineCount: baseline ? baseline.length : 0,
    baselineFolds: baselineFold ? baselineFold.length : 0,
    baselineFaults: baselineFault ? baselineFault.length : 0,
    nextDocLength: nextDoc.length,
  };
}

/** 代理对（astral 码点）一处等宽替换：增量 vs 整篇重解逐字比较（偏移口径判据） */
async function runSurrogate() {
  const doc = corpus.surrogateDoc();
  const nextDoc = corpus.surrogateNextDoc(doc);
  const { engine, state } = await useEngine();
  engine.parse(DOC, 1, doc);
  const edit = commonEdit(doc, nextDoc);
  state.replies = [];
  const t0 = performance.now();
  engine.change(changeRequest(2, edit));
  observeMemory();
  const incrementalSample = sampleOf(engine, state, performance.now() - t0);
  const incrementalTokens = lastReply(state, 'semantic')?.tokens ?? null;
  const incrementalFolds = lastReply(state, 'folds')?.folds ?? null;
  state.replies = [];
  const t1 = performance.now();
  engine.parse(DOC, 3, nextDoc);
  observeMemory();
  const realignedSample = sampleOf(engine, state, performance.now() - t1);
  const realignedTokens = lastReply(state, 'semantic')?.tokens ?? null;
  const realignedFolds = lastReply(state, 'folds')?.folds ?? null;
  const fatal = state.fatal;
  const capabilities = engine.capabilities;
  engine.dispose();
  return {
    docLength: doc.length,
    samples: [incrementalSample, realignedSample],
    emitted: ledger(state),
    capabilities,
    fatal,
    tokens: incrementalTokens,
    tokensRealigned: realignedTokens,
    folds: incrementalFolds,
    foldsRealigned: realignedFolds,
    nextDocLength: nextDoc.length,
  };
}

/**
 * 带残缺的混合击键流：一台引擎只走增量，另一台**每击键整篇重解**当真值，
 * 逐击把三面（着色段 / 折叠区间 / 残缺事实）逐字对账。
 *
 * 为什么另开一台引擎做真值：在同一台上先增量再 `parse` 会把缓存重建成"刚刚整篇解过"的状态，
 * 下一击永远只是"首击"——长缓存链（连续十几击都吃同一份缓存）里的错就再也撞不出来了。
 * 两台各走各的路、解的是同一份文本 ⇒ 对账判据与 `single-edit` 那条一致而覆盖面大得多。
 */
async function runStream() {
  const doc = corpus.brokenDoc(corpus.STREAM_DOC_LINES);
  const incremental = await useEngine(legBag());
  const truth = await useEngine();
  const records = [];
  let text = doc;
  incremental.engine.parse(DOC, 1, text);
  truth.engine.parse(DOC, 1, text);
  observeMemory();
  for (let step = 0; step < corpus.STREAM_EDITS; step++) {
    const nextText = corpus.nextDocForStreamEdit(text, step);
    const edit = commonEdit(text, nextText);
    const version = step + 2;
    incremental.state.replies = [];
    incremental.engine.change(changeRequest(version, edit));
    truth.state.replies = [];
    truth.engine.parse(DOC, version, nextText);
    observeMemory();
    const got = {
      tokens: lastReply(incremental.state, 'semantic')?.tokens ?? null,
      folds: lastReply(incremental.state, 'folds')?.folds ?? null,
      faults: lastReply(incremental.state, 'syntax')?.faults ?? null,
    };
    const want = {
      tokens: lastReply(truth.state, 'semantic')?.tokens ?? null,
      folds: lastReply(truth.state, 'folds')?.folds ?? null,
      faults: lastReply(truth.state, 'syntax')?.faults ?? null,
    };
    records.push({
      step,
      kind: corpus.streamEditAt(step, corpus.lineStarts(text).length - 1).kind,
      row: corpus.streamEditAt(step, corpus.lineStarts(text).length - 1).row,
      deltaRows: edit.newEnd.row - edit.oldEnd.row,
      ...(() => {
        const stat = incremental.engine.lastStat;
        return { queryScope: stat.queryScope, windowNodes: stat.windowNodes, changedRanges: stat.changedRanges };
      })(),
      tokens: got.tokens ? got.tokens.length : -1,
      folds: got.folds ? got.folds.length : -1,
      faults: got.faults ? got.faults.length : -1,
      mismatch: diffOf(got, want),
    });
    text = nextText;
  }
  const fatal = [...incremental.state.fatal, ...truth.state.fatal];
  const capabilities = incremental.engine.capabilities;
  incremental.engine.dispose();
  truth.engine.dispose();
  return {
    docLength: doc.length,
    nextDocLength: text.length,
    samples: [],
    emitted: '',
    capabilities,
    fatal,
    stream: records,
    tokens: null,
    tokensRealigned: null,
  };
}

/** 三面逐字对账：相等回 null，不等回第一条差异（带两边上下各一条，够定位是哪一段漂了） */
function diffOf(got, want) {
  for (const face of ['tokens', 'folds', 'faults']) {
    const a = got[face];
    const b = want[face];
    if (a === null || b === null) {
      if (a !== b) return `${face}：增量没有回这一面（${JSON.stringify(a)}）而整篇回了 ${b?.length ?? 'null'} 条`;
      continue;
    }
    if (a.length !== b.length) return `${face}：条数不等 增量 ${a.length} / 整篇 ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const x = JSON.stringify(a[i]);
      const y = JSON.stringify(b[i]);
      if (x !== y) {
        return `${face}：第 ${i} 条不等 增量 ${x}（前一条 ${JSON.stringify(a[i - 1] ?? null)}）/ 整篇 ${y}（前一条 ${JSON.stringify(b[i - 1] ?? null)}）`;
      }
    }
  }
  return null;
}

/** 没有旧树（未装配 / 刚打底）时的行为：未装配不该自己回话、parse 不算增量、有旧树才是增量 */
async function runFallback() {
  const state = { replies: [], fatal: [] };
  const before = new StructureEngine({
    assets,
    emit: (message) => {
      state.replies.push(message);
      if (message.type === 'error' && message.capability === 'all') state.fatal.push(message);
    },
  });
  // 未装配就投递 change ⇒ 引擎一个字都不该回（worker 那一侧由"尚未装配"分支说出去）
  before.change(changeRequest(1, commonEdit('', 'x')));
  const preInitReplies = state.replies.length;
  const preInitStat = before.lastStat;
  state.replies = [];
  const ok = await before.init();
  if (!ok) throw new Error('小档引擎装配失败');
  const doc = corpus.syntheticDoc(corpus.FALLBACK_DOC_LINES);
  const t0 = performance.now();
  before.parse(DOC, 1, doc);
  observeMemory();
  const coldSample = sampleOf(before, state, performance.now() - t0);
  const coldStat = { ...coldSample };
  const nextDoc = `${doc.slice(0, 10)}Y${doc.slice(10)}`;
  state.replies = [];
  const t1 = performance.now();
  before.change(changeRequest(2, commonEdit(doc, nextDoc)));
  observeMemory();
  const changedSample = sampleOf(before, state, performance.now() - t1);
  const fatal = state.fatal;
  const emitted = ledger(state);
  const capabilities = before.capabilities;
  before.dispose();
  return {
    docLength: doc.length,
    samples: [coldSample, changedSample],
    emitted,
    capabilities,
    fatal,
    preInitReplies,
    preInitStat,
    coldStat,
    changedStat: changedSample,
    tokens: null,
    tokensRealigned: null,
  };
}

const runners = {
  cold: runCold,
  'edit-batch': runEditBatch,
  'single-edit': runSingleEdit,
  surrogate: runSurrogate,
  fallback: runFallback,
  stream: runStream,
};

const result = {
  scenario,
  batch,
  readChunk: STRUCTURE_READ_CHUNK,
  docLength: 0,
  samples: [],
  emitted: '',
  capabilities: [],
  fatal: [],
  preInitReplies: -1,
  coldStat: null,
  changedStat: null,
  memory: mem,
  error: null,
};

try {
  const run = runners[scenario];
  if (!run) throw new Error(`未知场景：${scenario}`);
  Object.assign(result, await run(), { scenario, batch });
  result.memory = mem;
} catch (error) {
  result.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
}

// 同步写 stdout：本进程随后（照上面第 2 条事实）会在退出时被 V8 中止，绝不能再指望异步 flush。
process.stdout.write(`${JSON.stringify(result)}\n`);
