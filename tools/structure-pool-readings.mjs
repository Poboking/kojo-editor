#!/usr/bin/env node
/**
 * structure-pool-readings.mjs —— **LAU-5 的池读数**（DoD：省一次运行时 init / 少两条线程 /
 * 内存峰值不涨）。
 *
 * ## 量的是什么
 *
 * 一条线程（真的 `startStructureWorker`，真 ERB + 真 `.kojo` 资产）依次服务四个客户端：
 *
 * 1. **冷 ERB**：线程第一次 `open` ⇒ 线程创建 + `Parser.init`（运行时 wasm）+ `Language.load`
 *    （ERB 文法）+ 查询编译；
 * 2. **热 ERB**：同一线程的第二个客户端（池里"还了再借"就是这个形状）⇒ 引擎原地复用，
 *    `ready.loadMs = 0`；
 * 3. **冷 `.kojo`**：同一线程换一门文法 ⇒ 只有 `Language.load` + 查询编译**该付**，
 *    运行时 init 不该重付（`ready.loadMs` 与冷 ERB 的差 = LAU-5 省下来的那一次）；
 * 4. **热 `.kojo`**：同上复用。
 *
 * 另外每轮解一次真文本（ERB 用真 fixture、`.kojo` 用一段标题 + 注释），钉"复用之后还是真在解"。
 *
 * ## 线程数
 *
 * 本探针只有**一个** `self` 作用域（= 一条线程），四段共用一个 `startStructureWorker`。
 * 旧的"每语言一条 `?worker` 入口"是四条；池把线程数从"每客户端一条"降到"每运行时一条"。
 *
 * ## 为什么收尾调 `process.exit(0)`
 *
 * web-tree-sitter 0.27 在 Windows 上一个进程装**第二门**文法，退出时必崩
 * `Fatal process out of memory: Zone`（PITFALLS）；读数已经打完，不要那个崩溃码。
 *
 * ## 跑法
 *
 * ```
 * node --experimental-transform-types tools/structure-pool-readings.mjs
 * KOJO_POOL_ROUNDS=7 node --experimental-transform-types tools/structure-pool-readings.mjs
 * ```
 */
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 子进程模式（`KOJO_POOL_CHILD=1`）才做测量：web-tree-sitter 0.27 在 Windows 上装第二门文法后
 * **退出必然崩**（`Fatal process out of memory: Zone`，PITFALLS），退出码会被 native 层改成 3。
 * 所以父进程只看子进程打印的裁决行，不看它的退出码。
 */
if (process.env.KOJO_POOL_CHILD !== '1') {
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
    env: { ...process.env, KOJO_POOL_CHILD: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.on('close', () => {
    process.stdout.write(out);
    const verdict = out.split(/\r?\n/).find((line) => line.includes('[structure-pool-verdict]'));
    if (verdict === undefined) {
      console.error('[structure-pool-readings] FAIL：子进程没有给出裁决（多半是装配期就抛了）');
      process.exit(1);
    }
    process.exit(verdict.includes('[structure-pool-verdict] PASS') ? 0 : 1);
  });
} else {
  await main();
}

/** 子进程主流程（父进程不走到这里） */
async function main() {
const REPO = resolve(HERE, '..');

registerHooks({
  resolve(specifier, context, next) {
    // Vite 资产后缀（`?url` / `?raw` / `?worker`）：node 里没有，合成一个只导出默认值的模块。
    // 本探针自带资源包（不走 `assets.ts`），`?worker` 也永不实例化（客户端注入了进程内桥）。
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
          source: `export default class { constructor() { throw new Error('probe：不建真线程（客户端已注入桥）'); } }`,
          shortCircuit: true,
        };
      }
    }
    return next(url, context);
  },
});

const RUNTIME_WASM = join(REPO, 'node_modules/web-tree-sitter/web-tree-sitter.wasm');
const KOJO_PKG = join(REPO, 'packages/kojo-syntax-tree');
const ERB_PKG = join(REPO, 'packages/erb-syntax-tree');
const ERB_FIXTURE = join(ERB_PKG, 'tests/fixtures/valid-structure.erb');
const WARM_ROUNDS = Math.max(1, Number.parseInt(process.env.KOJO_POOL_ROUNDS ?? '3', 10) || 3);

const ERB_TEXT = readFileSync(process.env.KOJO_FIRST_FRAME_FIXTURE ?? ERB_FIXTURE, 'utf8');
const KOJO_TEXT = '* 标题\n# 注释\n@F\n  PRINTL 甲\n@\n';

globalThis.window = globalThis; // 客户端等待票走 `window.setTimeout`

const { StructureClient } = await import(pathToFileURL(resolve(REPO, 'packages/app/src/monaco/tree-sitter/client.ts')).href);
const { startStructureWorker } = await import(
  pathToFileURL(resolve(REPO, 'packages/app/src/monaco/tree-sitter/worker-bootstrap.ts')).href
);
const { erbCaptureTier } = await import(pathToFileURL(resolve(REPO, 'packages/app/src/monaco/tree-sitter/erb-tiers.ts')).href);
const { erbIndentPattern } = await import(
  pathToFileURL(resolve(REPO, 'packages/app/src/monaco/tree-sitter/erb-indent-patterns.ts')).href
);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;

const ERB_BUNDLE = {
  runtimeWasm: RUNTIME_WASM,
  grammarWasm: join(ERB_PKG, 'tree-sitter-erb.wasm'),
  highlightsQuery: readFileSync(join(ERB_PKG, 'queries/highlights.scm'), 'utf8'),
  foldsQuery: readFileSync(join(ERB_PKG, 'queries/folds.scm'), 'utf8'),
  indentsQuery: readFileSync(join(ERB_PKG, 'queries/indents.scm'), 'utf8'),
  captureTier: erbCaptureTier,
  indentPattern: erbIndentPattern,
};
const KOJO_BUNDLE = {
  runtimeWasm: RUNTIME_WASM,
  grammarWasm: join(KOJO_PKG, 'tree-sitter-kojo.wasm'),
  highlightsQuery: readFileSync(join(KOJO_PKG, 'queries/highlights.scm'), 'utf8'),
  foldsQuery: readFileSync(join(KOJO_PKG, 'queries/folds.scm'), 'utf8'),
  indentsQuery: readFileSync(join(KOJO_PKG, 'queries/indents.scm'), 'utf8'),
};

function fakeModel(text) {
  return {
    getValue: () => text,
    isDisposed: () => false,
    onDidChangeContent: () => ({ dispose: () => undefined }),
  };
}

/** 一条线程（一个 `self` 作用域）+ 一把进程内桥；四段客户端共用 */
function makeThread() {
  let clientOnMessage = null;
  /** 每次 `ready` 的 `loadMs`（引擎自己报的那一格：0 = 原地复用） */
  const readies = [];
  const scope = {
    onmessage: null,
    onerror: null,
    postMessage(reply) {
      if (reply && reply.kind === 'ready') readies.push(reply.loadMs);
      queueMicrotask(() => clientOnMessage?.({ data: reply }));
    },
  };
  globalThis.self = scope;
  const engine = startStructureWorker([ERB_BUNDLE, KOJO_BUNDLE]);
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
      /* 进程内没有线程可杀（线程仍在，池的复用就是这个形状） */
    },
  };
  return { engine, worker, readies };
}

/** 借一个客户端跑一段：open→ready 的墙钟 + 首解墙钟 + token 数 */
async function useClient(thread, bundle, text) {
  const client = new StructureClient({
    runtime: { runtimeWasmUrl: bundle.runtimeWasm, grammarWasmUrl: bundle.grammarWasm, createWorker: () => thread.worker },
    languageId: 'probe',
    timeoutMs: 20_000,
    bootstrapTimeoutMs: 20_000,
    onFatal: (message) => {
      throw new Error(`整档停用：${message}`);
    },
  });
  const started = now();
  client.start();
  let guard = 0;
  while (client.state !== 'ready') {
    if (++guard > 60_000) throw new Error(`open→ready 超时（状态 ${client.state}）`);
    await sleep(0);
  }
  const readyMs = now() - started;

  const parseStarted = now();
  const tokens = await client.tokens(fakeModel(text));
  const parseMs = now() - parseStarted;

  client.dispose();
  return { readyMs, parseMs, tokens: tokens === null ? 0 : tokens.length };
}

const memory = () => {
  const { rss, heapUsed } = process.memoryUsage();
  return { rssMb: +(rss / 1024 / 1024).toFixed(1), heapMb: +(heapUsed / 1024 / 1024).toFixed(1) };
};

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : +((sorted[mid - 1] + sorted[mid]) / 2).toFixed(1);
};

const thread = makeThread();
const before = memory();

const coldErb = await useClient(thread, ERB_BUNDLE, ERB_TEXT);
const afterCold = memory();

const warmErb = [];
for (let i = 0; i < WARM_ROUNDS; i += 1) warmErb.push(await useClient(thread, ERB_BUNDLE, ERB_TEXT));
const afterWarmErb = memory();

const coldKojo = await useClient(thread, KOJO_BUNDLE, KOJO_TEXT);
const warmKojo = [];
for (let i = 0; i < WARM_ROUNDS; i += 1) warmKojo.push(await useClient(thread, KOJO_BUNDLE, KOJO_TEXT));
const afterAll = memory();

thread.engine.dispose();
delete globalThis.self;

const report = {
  rounds: WARM_ROUNDS,
  thread: 'one (single self scope; ERB + .kojo share the same startStructureWorker)',
  coldErb: { readyMs: +coldErb.readyMs.toFixed(1), loadMs: thread.readies[0], tokens: coldErb.tokens },
  warmErb: {
    readyMedianMs: median(warmErb.map((s) => s.readyMs)),
    readySamples: warmErb.map((s) => +s.readyMs.toFixed(1)),
    loadMs: thread.readies.slice(1, 1 + WARM_ROUNDS),
  },
  coldKojo: {
    readyMs: +coldKojo.readyMs.toFixed(1),
    loadMs: thread.readies[1 + WARM_ROUNDS],
    tokens: coldKojo.tokens,
  },
  warmKojo: {
    readyMedianMs: median(warmKojo.map((s) => s.readyMs)),
    readySamples: warmKojo.map((s) => +s.readyMs.toFixed(1)),
    loadMs: thread.readies.slice(2 + WARM_ROUNDS),
  },
  parseMs: {
    erbMedian: median([coldErb, ...warmErb].map((s) => s.parseMs)),
    kojoMedian: median([coldKojo, ...warmKojo].map((s) => s.parseMs)),
  },
  memory: { before, afterColdErb: afterCold, afterWarmErb, afterAll },
  savings: {
    // 同一门语言的复用：引擎原地复用 ⇒ ready.loadMs 必须是 0
    warmErbLoadMsZero: thread.readies.slice(1, 1 + WARM_ROUNDS).every((ms) => ms === 0),
    // 换语言的冷启动只付 Language.load + 查询（比第一门少一次运行时 init）
    secondLanguageLoadMs: thread.readies[1 + WARM_ROUNDS],
    runtimeInitSaved: thread.readies[1 + WARM_ROUNDS] < thread.readies[0],
  },
};

const failures = [];
if (!report.savings.warmErbLoadMsZero) failures.push('热复用没有回 loadMs=0');
if (!(report.warmErb.readyMedianMs < coldErb.readyMs)) failures.push('热 ERB 的 open→ready 不比冷启动快');
if (!report.savings.runtimeInitSaved) failures.push('第二门语言没有省下运行时 init（loadMs 不小于第一门）');
if (coldErb.tokens === 0 || coldKojo.tokens === 0) failures.push('复用之后有一门语言的首解没有 token');
// 内存判据看 **JS 堆**：RSS 含 wasm 的 native 段，装第二门文法必然 onboarding（那是"多一门语言"的
// 成本，不是泄漏）；热轮次里堆只要不持续涨就算过。
if (afterAll.heapMb - afterWarmErb.heapMb > 8) {
  failures.push(`热轮次的 JS 堆涨了 ${(afterAll.heapMb - afterWarmErb.heapMb).toFixed(1)} MB`);
}

// 收尾一律走 **同步写**：子进程下一刻会被 web-tree-sitter 的退出崩溃带走（见文件头），
// 异步 stdout 可能还没落盘；裁决行由父进程读。
const lines = [`[structure-pool-readings] ${JSON.stringify(report)}`];
if (failures.length > 0) lines.push(`[structure-pool-readings] FAIL：${failures.join('；')}`, '[structure-pool-verdict] FAIL');
else lines.push('[structure-pool-verdict] PASS');
writeSync(1, `${lines.join('\n')}\n`);
process.exit(0);
}
