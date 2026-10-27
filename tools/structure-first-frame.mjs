#!/usr/bin/env node
/**
 * structure-first-frame.mjs —— **ERB 首帧**的两个数（LAU-1 的 DoD 第 6 条，写进 `docs/BASELINES.md`）。
 *
 * 一次 ERB 文件从"翻开结构层"到"第一批着色数据到手"被切成两段，分开量：
 *
 * 1. **`open → ready`**：宿主发 `open{protocol:3}` 起，到 worker 回 `ready` 止。这一段 = 线程 +
 *    `Parser.init`（运行时 wasm）+ `Language.load`（ERB 文法 wasm）+ 三份查询编译；
 * 2. **`ready → 首屏着色`**：从 `ready` 到**宿主手里有第一批 token**（客户端把 `facets.semantic`
 *    的扁平投影解成 token 数组那一刻）。不含 Monaco 的 encode 与那一帧上屏——那一段要有真壳，
 *    本探针跑在 node 里（口径与 `BASELINES.md` 的注记一致，别把这两个数读成"上屏完成"）。
 *
 * ## 怎么驱动（打的是生产代码，不是替身）
 *
 * worker 那一侧是**真的** `startStructureWorker`（`worker-bootstrap.ts`）＋ 真的 ERB 资产
 * （两枚 wasm、五份查询、`erbCaptureTier` / `erbIndentPattern`）；宿主那一侧是**真的**
 * `StructureClient`（协议 v3）。唯一替身是 `Worker` 本身：进程内桥（`postMessage` 转手给
 * `scope.onmessage`，回话再转手给 client），这样一条消息环都不用重写。
 *
 * ## 为什么不用真线程 + 为什么要 `--experimental-transform-types`
 *
 * - `?worker` 是 Vite 后缀，node 里没有它；逻辑同源已由进程内桥保证。
 * - 宿主的模块链从 `@kojo/kojo-core` 的桶拖进带**参数属性**的 TS（`expr/parse.ts`），strip-only
 *   解不了 ⇒ 必须带 `--experimental-transform-types`；下面两枚 resolve 钩子把仓内 `.js` 相对
 *   说明符与无扩展名相对导入指回 `.ts`。
 * - 收尾调 `process.exit(0)`：web-tree-sitter 0.27 在 Windows 上解过档后 isolate 收尾必崩
 *   `Fatal process out of memory: Zone`（PITFALLS），本探针只要读数，不要那个崩溃码。
 *
 * ## 跑法
 *
 * ```
 * node --experimental-transform-types tools/structure-first-frame.mjs            # 3 轮，中位数
 * KOJO_FIRST_FRAME_ROUNDS=7 node --experimental-transform-types tools/structure-first-frame.mjs
 * ```
 */
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

registerHooks({
  resolve(specifier, context, next) {
    // LAU-5 起 `client.ts` 静态拉着 `structure-pool.ts`（池），后者又静态 import `?worker` 入口
    // ——入口里是 `assets.ts` 的 `?url` / `?raw`。node 没有 Vite 后缀，合成只导出默认值的模块；
    // 本探针注入 `createWorker`，所以那枚合成的 worker 类不会被实例化。
    if (specifier.startsWith('.') && context.parentURL && specifier.includes('?')) {
      const [pathPart, query] = specifier.split('?');
      const abs = fileURLToPath(new URL(pathPart, context.parentURL));
      return { url: `kojo-asset:${encodeURIComponent(abs)}?${query}`, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      for (const candidate of [base.replace(/\.js$/, '.ts'), `${base}.ts`]) {
        if (candidate !== base && existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('kojo-asset:')) {
      const [encoded, query] = url.slice('kojo-asset:'.length).split('?');
      const abs = decodeURIComponent(encoded);
      if (query === 'url') return { format: 'module', source: `export default ${JSON.stringify(abs)};`, shortCircuit: true };
      if (query === 'raw') {
        return { format: 'module', source: `export default ${JSON.stringify(readFileSync(abs, 'utf8'))};`, shortCircuit: true };
      }
      if (query === 'worker') {
        return {
          format: 'module',
          source: `export default class { constructor() { throw new Error('probe：不建真线程（探针注入了桥）'); } }`,
          shortCircuit: true,
        };
      }
    }
    return next(url, context);
  },
});

const ERB_PKG = join(REPO, 'packages/erb-syntax-tree');
const RUNTIME_WASM = join(REPO, 'node_modules/web-tree-sitter/web-tree-sitter.wasm');
const GRAMMAR_WASM = join(ERB_PKG, 'tree-sitter-erb.wasm');
const FIXTURE = join(ERB_PKG, 'tests/fixtures/valid-structure.erb');

/** 首屏正文：真实 fixture 逐字（62 行）。想量更大的档就设 `KOJO_FIRST_FRAME_FIXTURE=<path>` */
const TEXT = readFileSync(process.env.KOJO_FIRST_FRAME_FIXTURE ?? FIXTURE, 'utf8');
const LINES = TEXT.split('\n').length;
const ROUNDS = Math.max(1, Number.parseInt(process.env.KOJO_FIRST_FRAME_ROUNDS ?? '3', 10) || 3);

globalThis.window = globalThis; // 客户端等待票走 `window.setTimeout`

const { StructureClient } = await import(
  pathToFileURL(resolve(REPO, 'packages/app/src/monaco/tree-sitter/client.ts')).href
);
const { startStructureWorker } = await import(
  pathToFileURL(resolve(REPO, 'packages/app/src/monaco/tree-sitter/worker-bootstrap.ts')).href
);
const { erbCaptureTier } = await import(
  pathToFileURL(resolve(REPO, 'packages/app/src/monaco/tree-sitter/erb-tiers.ts')).href
);
const { erbIndentPattern } = await import(
  pathToFileURL(resolve(REPO, 'packages/app/src/monaco/tree-sitter/erb-indent-patterns.ts')).href
);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;

/** 假 model：客户端只读 `getValue` / `isDisposed` / `onDidChangeContent` */
function fakeModel(text) {
  return {
    getValue: () => text,
    isDisposed: () => false,
    onDidChangeContent: () => ({ dispose: () => undefined }),
  };
}

/** 一轮：真 worker 环 + 进程内桥 + 真 client */
async function round() {
  let clientOnMessage = null;
  const scope = {
    onmessage: null,
    onerror: null,
    postMessage(reply) {
      queueMicrotask(() => clientOnMessage?.({ data: reply }));
    },
  };
  globalThis.self = scope;
  const engine = startStructureWorker({
    runtimeWasm: RUNTIME_WASM,
    grammarWasm: readFileSync(GRAMMAR_WASM),
    highlightsQuery: readFileSync(join(ERB_PKG, 'queries/highlights.scm'), 'utf8'),
    foldsQuery: readFileSync(join(ERB_PKG, 'queries/folds.scm'), 'utf8'),
    indentsQuery: readFileSync(join(ERB_PKG, 'queries/indents.scm'), 'utf8'),
    captureTier: erbCaptureTier,
    indentPattern: erbIndentPattern,
  });
  const worker = {
    get onmessage() {
      return clientOnMessage;
    },
    set onmessage(fn) {
      clientOnMessage = fn;
    },
    onerror: null,
    postMessage(request) {
      queueMicrotask(() => scope.onmessage?.({ data: request }));
    },
    terminate() {
      /* 进程内没有线程可杀 */
    },
  };
  const client = new StructureClient({
    runtime: { runtimeWasmUrl: RUNTIME_WASM, grammarWasmUrl: GRAMMAR_WASM, createWorker: () => worker },
    languageId: 'erb',
    onFatal: (message) => {
      throw new Error(`整档停用：${message}`);
    },
  });

  const openStarted = now();
  client.start();
  let guard = 0;
  while (client.state !== 'ready') {
    if (++guard > 20_000) throw new Error(`open→ready 超时（状态 ${client.state}）`);
    await sleep(0);
  }
  const readyMs = now() - openStarted;

  const paintStarted = now();
  const tokens = await client.tokens(fakeModel(TEXT));
  const paintMs = now() - paintStarted;

  client.dispose();
  engine.dispose();
  delete globalThis.self;
  return { readyMs, paintMs, tokens: tokens === null ? 0 : tokens.length };
}

const samples = [];
for (let i = 0; i < ROUNDS; i++) samples.push(await round());

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const report = {
  lines: LINES,
  chars: TEXT.length,
  rounds: ROUNDS,
  openToReadyMs: {
    median: +median(samples.map((s) => s.readyMs)).toFixed(1),
    min: +Math.min(...samples.map((s) => s.readyMs)).toFixed(1),
    max: +Math.max(...samples.map((s) => s.readyMs)).toFixed(1),
  },
  readyToFirstPaintMs: {
    median: +median(samples.map((s) => s.paintMs)).toFixed(1),
    min: +Math.min(...samples.map((s) => s.paintMs)).toFixed(1),
    max: +Math.max(...samples.map((s) => s.paintMs)).toFixed(1),
  },
  tokens: samples.map((s) => s.tokens),
  samples: samples.map((s) => ({ ready: +s.readyMs.toFixed(1), paint: +s.paintMs.toFixed(1) })),
};

console.log(`[structure-first-frame] ${JSON.stringify(report)}`);
if (samples.some((s) => s.tokens === 0)) {
  console.error('[structure-first-frame] FAIL：首屏一个 token 都没有（ERB 语义面没到）');
  process.exit(1);
}
process.exit(0);
