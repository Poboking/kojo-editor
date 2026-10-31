#!/usr/bin/env node
/**
 * perf-cold-open.mjs —— **冷开探针**（F 批 / R7，2026-10-31）。
 *
 * ## 它量的是什么
 *
 * 「用户点开项目、到索引能用」这一段真时间：起一个真内核（真 ERB 解析器 / 适配器 /
 * 校验器 / 条件抽取器），打开**真语料**，等到索引 ready，把耗时按**产品自己打的那条
 * `index breakdown`** 拆成段输出。
 *
 * ## 为什么要有它（而不是拿 hand-rolled 脚本凑）
 *
 * `docs/STATE.md` §四 记着：此前每批 A/B 都是手搓（`git worktree add` + 两份独立
 * `KOJO_MEM_STORAGE_DIR`），"够用但每次都要人记得同样的口径"。口径一散，读数就不可比。
 * 本文件是 `tools/perf-ab.mjs` 的**默认探针**：只要两侧都能跑起同一个探针，读数就同源。
 *
 * ## 冷建是**算出来的**，不是假设的
 *
 * 存储后端用 `DiskLikeStorage`：`read` 永远返回 `missing`、`write` 只记字节数。这正好
 * 等于「真用户第一次打开这个项目」——盘上还没有快照。所以每一轮都必然是冷建。
 * 探针不满足于"大概是这样"：它把产品日志里的 `reused N/M` 读出来，`N !== 0` 就判定
 * 这一轮**不是冷开**并以非 0 退出（除非显式 `--allow-warm`）。热载的读数形状完全不同
 * （`read+parse 0ms`），混进来会让 A/B 比值变成噪声。
 *
 * ## 自证：我测的到底是哪棵树
 *
 * A/B 的致命失败模式是"两侧其实跑同一份代码，比值漂亮地等于 1.00"。所以探针在
 * `registerHooks` 解析 `@kojo/*` 的那一刻就把落点记下来，跑完打印一条 `selfcheck`：
 * **每一个 `@kojo/*` 都必须落在本树内**，落在外面的直接判红。这条自证是 PITFALLS 291
 * 的教训——对照实验的第一步是证明开关/隔离真的生效，而不是假设它生效。
 *
 * ## 跑法
 *
 * ```
 * KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)" node tools/perf-cold-open.mjs
 * node tools/perf-ab.mjs --a HEAD~1 --b HEAD --corpus <语料>   # 由量具批量驱动
 * ```
 *
 * 输出是一行一条 `[probe] key=value`，供 `perf-ab.mjs` 解析；原始产品日志同时转发到
 * stdout（排错时不用重跑）。语料不在位 ⇒ 打印 SKIP 并以 0 退出（与 `tools/corpus.mjs`
 * 的纪律一致：缺语料不是红）。
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker as NodeWorker } from 'node:worker_threads';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/**
 * 自举：内核源码用了**参数属性**（`constructor(private readonly x)`），strip-only 模式载不动，
 * 必须带 `--experimental-transform-types`。与 `tools/mem-readings.mjs` 同一条约定——这里直接
 * 自重启一次，免得作者忘了加旗子拿到一句 SyntaxError 却以为是代码挂了。
 */
if (isMainThread && !process.execArgv.includes('--experimental-transform-types')) {
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(
    process.execPath,
    ['--experimental-transform-types', ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: process.env },
  );
  process.exit(child.status ?? 1);
}

/* ============================== 参数 ============================== */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const CORPUS = flag('--corpus', process.env.KOJO_SMOKE_PROJECT ?? '');
const LABEL = flag('--label', 'run');
const ALLOW_WARM = has('--allow-warm');
/** 等索引的上限：真语料 4,258 文件约 13s，留 6 倍余量；超了说明挂住，不是慢 */
const INDEX_TIMEOUT_MS = Number(flag('--timeout-ms', '90000')) || 90_000;
/**
 * 并行槽数。**默认 `auto` = `min(核数-1, 4)`，与真实应用同形**
 * （`bootstrap.installComputeTransport` 就是这个式子）。
 *
 * 为什么必须默认并行：不挂 transport 时所有 compute 任务都在主线程内联跑，
 * `read+parse` 与 `refs scan` 会串成两段长时间阻塞，读出来的"冷开 18s"里有一大半
 * 是"没有 worker"的产物，不是真实用户的形状。归因若建立在串行读数上，会把优化
 * 火力对准一个并行下根本不存在的瓶颈。
 */
const PARALLEL_SPEC = flag('--parallel', 'auto');

const PLUGIN_NAMES = ['erb', 'adapter', 'linter', 'condition'];
const enabled = (() => {
  // 两种写法都要认：`--plugins=erb` 与 `--plugins erb`。只认一种的话，另一种会**静默回落到全开**
  // ——mem-readings 那边踩过：五次"逐级少装一个插件"的读数一模一样，差点当成"插件不占开销"。
  const eq = argv.find((a) => a.startsWith('--plugins='));
  if (eq !== undefined) {
    return new Set(
      eq
        .slice('--plugins='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  const i = argv.indexOf('--plugins');
  if (i < 0) return new Set(PLUGIN_NAMES);
  return new Set(
    String(argv[i + 1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
})();

if (CORPUS === '' || !existsSync(CORPUS)) {
  console.log('[perf-cold-open] SKIP：语料不在位（设 KOJO_SMOKE_PROJECT=<语料目录>，或先跑 node tools/corpus.mjs --print）');
  process.exit(0);
}

/* ============================== 模块解析（含自证） ============================== */

/**
 * `@kojo/*` 的落点台账：specifier → 绝对文件路径。
 *
 * 这份台账同时干两件事：①让游离树不依赖 `node_modules` 里那套 pnpm 符号链接；②跑完之后
 * 用来证明"加载的源码确实来自本树"。没有 ②，A/B 就可能在比"同一份代码跑两遍"而毫无察觉。
 */
const kojoHits = new Map();
const outsideHits = [];

/**
 * 装 `@kojo/*` 的解析钩子。**主线程与 worker 各装一次**——`registerHooks` 是**每线程**的，
 * 主线程装好不代表 worker 里也认这套 alias（worker 里会退回 Node 的包解析，在游离树上直接
 * `ERR_MODULE_NOT_FOUND`，或者更糟：在主树靠 `node_modules` 兜底跑通了，测的却是另一棵树）。
 */
function installKojoHooks() {
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('@kojo/')) {
        // 子路径也要认（ERB-VOCAB 批之后 `@kojo/erb-vocab/control-flow` 是常态）：只认裸包名时，
        // 这类 import 会落到 Node 的包解析上 ⇒ `ERR_MODULE_NOT_FOUND: Cannot find package`，而
        // 错误信息里**不带子路径**，看起来像"包没装"。
        // 口径与 `packages/app/vite.config.ts` 的 alias 一致：`@kojo/x` → `packages/x/src/index.ts`、
        // `@kojo/x/y` → `packages/x/src/y.ts`（再退回 `packages/x/src/y/index.ts`）。
        const rest = specifier.slice('@kojo/'.length);
        const slash = rest.indexOf('/');
        const name = slash < 0 ? rest : rest.slice(0, slash);
        const sub = slash < 0 ? '' : rest.slice(slash + 1);
        // 目录判据先 `packages/<name>` 再退 `packages/plugins/<name 去掉 plugin- 前缀>`：
        // `@kojo/plugin-api` **是契约包**（`packages/plugin-api`），按前缀一刀切会把它指到
        // `packages/plugins/api`（不存在）⇒ 在本树靠 node_modules 兜底看不出来，换到游离树
        // 就 `ERR_MODULE_NOT_FOUND`（PITFALLS 282）。
        const dirs = [join(REPO, 'packages', name)];
        if (name.startsWith('plugin-')) dirs.push(join(REPO, 'packages/plugins', name.slice('plugin-'.length)));
        const base = dirs.find((d) => existsSync(d)) ?? dirs[0];
        const candidates =
          sub === '' ? [join(base, 'src/index.ts')] : [join(base, 'src', `${sub}.ts`), join(base, 'src', sub, 'index.ts')];
        for (const entry of candidates) {
          if (existsSync(entry)) {
            if (!entry.startsWith(REPO)) outsideHits.push(`${specifier} → ${entry}`);
            if (!kojoHits.has(specifier)) kojoHits.set(specifier, entry);
            return { url: pathToFileURL(entry).href, shortCircuit: true };
          }
        }
      }
      if (specifier.startsWith('.') && context.parentURL) {
        const base = fileURLToPath(new URL(specifier, context.parentURL));
        for (const candidate of [`${base}.ts`, base.replace(/\.js$/, '.ts'), join(base, 'index.ts')]) {
          if (candidate !== base && existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      return next(specifier, context);
    },
  });
}

/* ============================== worker 分支 ============================== */

/**
 * worker 直接复用**本文件**（`isMainThread` 分流），不另写一份 worker 入口。
 *
 * 这么做的理由是"同源"：alias 规则、任务表装配、甚至自证台账全都只有一份代码。
 * 另写一个 worker 文件的话，两边迟早漂移——而漂移的表现是 worker 静默退回 Node 的
 * 包解析、测到另一棵树的代码，读数看起来完全正常。
 */
if (!isMainThread) {
  installKojoHooks();
  const erb = await import('@kojo/plugin-erb-parser');
  const cond = await import('@kojo/plugin-condition-extractor');
  const { handleComputeRequest } = await import('@kojo/plugin-api');
  const workerTasks = { ...erb.erbParserTasks, ...cond.conditionExtractorTasks(erb.scanControlFlow) };
  parentPort.on('message', (data) => {
    // 不复用 `handleComputeRequest` 的错误分支语义就会漂移，所以直接用它
    void handleComputeRequest(workerTasks, data).then((res) => parentPort.postMessage(res));
  });
  // 挂住：worker 靠消息循环活着。不挂的话模块执行完会继续往下跑主线程那套（参数解析、
  // 起内核……），每个 worker 都变成一整个探针。
  await new Promise(() => {});
} else {
  installKojoHooks();
}

/* ============================== 日志捕获 ============================== */

/**
 * 产品读数是 `ctx.log.info(...)` 打出来的，最终经 `Logger` 落到 console。这里注入一个捕获型
 * logger——**不是覆写 `console.log`**：内核的 `consoleLogger()` 走的是 `console.info`，覆写
 * `console.log` 一条都抓不到（第一版就这么踩了：`seg_walk=` 全空，还以为是插件没打日志）。
 * 捕获的同时原样转发——perf-ab 判红时人要能看见原始上下文，否则只能重跑一遍才知道发生了什么。
 */
const captured = [];
const rawLog = console.log.bind(console);
const mkLine = (kind) => (message, ...args) => {
  const line = [message, ...args.map((a) => (typeof a === 'string' ? a : String(a)))].join(' ');
  captured.push(line);
  rawLog(`[${kind}]`, line);
};
const captureLogger = { debug: mkLine('dbg'), info: mkLine('info'), warn: mkLine('warn'), error: mkLine('err') };

/* ============================== 装配 ============================== */

const { createKernel } = await import(pathToFileURL(join(REPO, 'packages/kernel/src/kernel.ts')).href);
const { NodeBridge } = await import(pathToFileURL(join(REPO, 'packages/kernel/tests/helpers/node-bridge.ts')).href);

const pluginFactories = {
  erb: async () => (await import('@kojo/plugin-erb-parser')).createErbParserPlugin(),
  adapter: async () => (await import('@kojo/plugin-eratw-adapter')).createEratwAdapterPlugin(),
  linter: async () => (await import('@kojo/plugin-convention-linter')).createConventionLinterPlugin(),
  condition: async () => (await import('@kojo/plugin-condition-extractor')).createConditionExtractorPlugin(),
};

const plugins = [];
for (const name of PLUGIN_NAMES) {
  if (enabled.has(name)) plugins.push(await pluginFactories[name]());
}

const { mkdtempSync } = await import('node:fs');
const appData = mkdtempSync(join(tmpdir(), 'kojo-perf-cold-'));

/**
 * 空存储后端：`read` 永远 `missing`、`write` 只记字节。
 *
 * 不用 `MemoryStorageBackend` 的原因有二——①它把 57 MB 的快照串攥在堆里，与大头无关但会让
 * 进程堆形状偏离真应用；②本探针要的是**冷建**，任何能把快照读回来的后端都会让第二轮变成
 * 热载（这正是 R7 读数最容易被自己污染的地方）。
 */
class EmptyStorage {
  bytes = 0;
  async read() {
    return { kind: 'missing' };
  }
  async write(_scope, _key, value) {
    this.bytes = Math.max(this.bytes, value.length);
  }
  async remove() {}
  async list() {
    return [];
  }
}

const kernel = await createKernel({
  platform: new NodeBridge(appData),
  plugins,
  storageBackend: new EmptyStorage(),
  logger: captureLogger,
});

// 任务实现（条件抽取与扫描）与 mem-readings 同源：少了它们，condition 插件只会空转
const erbMod = enabled.has('erb') ? await import('@kojo/plugin-erb-parser') : null;
const condMod = enabled.has('condition') ? await import('@kojo/plugin-condition-extractor') : null;
const tasks = { ...(erbMod?.erbParserTasks ?? {}), ...(condMod?.conditionExtractorTasks?.(erbMod?.scanControlFlow) ?? {}) };
for (const [kind, impl] of Object.entries(tasks)) kernel.compute.registerTask(kind, impl);

/**
 * 并行槽数：`auto` = `min(核数-1, 4)`，与真实应用同一条式子。
 * `0` / `off` = 强制串行（只用于对照"并行到底值多少"）。
 */
const PARALLEL = (() => {
  if (PARALLEL_SPEC === '0' || PARALLEL_SPEC === 'off' || PARALLEL_SPEC === 'false') return 0;
  if (PARALLEL_SPEC === 'auto') return Math.max(1, Math.min(4, cpus().length - 1));
  return Math.max(0, Number(PARALLEL_SPEC) || 0);
})();

if (PARALLEL > 0) {
  const { createWorkerTransport } = await import('@kojo/plugin-api');
  /**
   * worker 入口就是本文件。`Worker` **不接受 `file://` 字符串**（`ERR_WORKER_PATH`：
   * "must be an absolute path or ... Wrap file:// URLs with `new URL`"）——而这条失败是
   * **静默降级**的：transport 连续失败 3 次就整体关掉，后续任务全部 inline 跑，读数看起来
   * 完全正常（只是慢）。所以下面还要从 `stats().offload.parallel` 回读一次，如实报出来。
   */
  const workerUrl = new URL(import.meta.url);
  /** node 真线程包装成 `ComputeWorkerLike`（与 `compute-transport.test.ts` 同一条适配） */
  const spawn = () => {
    const w = new NodeWorker(workerUrl, { execArgv: ['--experimental-transform-types'] });
    const addEventListener = (type, handler) => {
      if (type === 'message') w.on('message', (data) => handler({ data }));
      else w.on('error', (err) => handler(err));
    };
    return {
      postMessage: (data) => w.postMessage(data),
      addEventListener,
      terminate: () => {
        void w.terminate();
      },
    };
  };
  kernel.compute.attachTransport(createWorkerTransport(spawn, { size: PARALLEL }));
}

await kernel.start();

/* ============================== 测量 ============================== */

const t0 = performance.now();
await kernel.project.open(CORPUS);
const openMs = Math.round(performance.now() - t0);

const parser = (() => {
  try {
    return kernel.services.get('erb.parser');
  } catch {
    return null;
  }
})();

// 没有 erb 就没有索引可等：与其白等 90s 再给一句"超时"，不如当场说清是配置错了。
// （留这个分支是因为 `--plugins` 是开放参数，`--plugins adapter` 这类写法迟早有人试。）
if (!parser) {
  console.log(`[probe] label=${LABEL}`);
  console.log('[probe] fatal=no-erb-plugin');
  console.error('[perf-cold-open] 判红：冷开读数靠 erb 索引，--plugins 里必须含 erb');
  process.exit(6);
}

// 等索引 ready。真语料 ~13s；超时说明挂住了（不是慢），直接判红而不是给一个假读数。
const tIndex = performance.now();
let index = null;
const deadline = tIndex + INDEX_TIMEOUT_MS;
while (performance.now() < deadline) {
  index = parser?.currentIndex?.() ?? null;
  if (index) break;
  await new Promise((done) => setTimeout(done, 50));
}
const indexMs = Math.round(performance.now() - tIndex);
if (!index) {
  console.log(`[probe] label=${LABEL}`);
  console.log(`[probe] fatal=index-timeout(${INDEX_TIMEOUT_MS}ms)`);
  process.exit(3);
}

/**
 * 让插件的异步尾巴跑完：等**日志静默**，不等固定时长。
 *
 * 为什么静默窗要 1.5s：`index_ms` 只到 erb 索引 ready，而条件抽取与校验还在后台跑
 * （实测条件抽取 10–12s，与 erb 索引同量级）。窗太短会把它们的读数整段截掉——
 * 第一版取 400ms 时 `cond_ms` 直接是空的，看起来像"条件抽取没跑"，实际是被掐断了。
 * 固定 sleep 也不行：那会把"别人的耗时"算进总时长，而静默判据只去掉尾巴、不虚构时间。
 */
const TAIL_IDLE_MS = Number(flag('--tail-idle-ms', '1500')) || 1500;
const TAIL_MAX_MS = Number(flag('--tail-max-ms', '25000')) || 25_000;
const tailStart = performance.now();
await new Promise((done) => {
  let last = captured.length;
  let idle = 0;
  const tick = setInterval(() => {
    if (captured.length !== last) {
      last = captured.length;
      idle = 0;
      return;
    }
    idle += 100;
    if (idle >= TAIL_IDLE_MS || performance.now() - tailStart > TAIL_MAX_MS) {
      clearInterval(tick);
      done();
    }
  }, 100);
});
const allReadyMs = Math.round(performance.now() - t0);

/* ============================== 解析产品读数 ============================== */

const text = captured.join('\n');
const num = (re, group = 1) => {
  const m = re.exec(text);
  return m ? Number(m[group]) : null;
};

/** `index breakdown: walk 185ms · stat 0ms · snapshot 543ms (get …, coerce …) · read+parse 12ms · aggregate 68ms …` */
const seg = {
  walk: num(/walk (\d+)ms · stat/),
  stat: num(/stat (\d+)ms · snapshot/),
  snapshot: num(/snapshot (\d+)ms \(get/),
  readparse: num(/read\+parse (\d+)ms · aggregate/),
  aggregate: num(/aggregate (\d+)ms ·/),
  refs: num(/refs scan (\d+)ms \(rescan/),
  rescan: num(/refs scan \d+ms \(rescan (\d+)/),
};
/** `Indexed 4258 ERB files, 117032 distinct functions from 2 root(s) in 13210ms` */
const indexedFiles = num(/Indexed (\d+) ERB files/);
const distinctFns = num(/Indexed \d+ ERB files, (\d+) distinct functions/);
const rootCount = num(/distinct functions from (\d+) root\(s\)/);
const buildMs = num(/distinct functions from \d+ root\(s\) in (\d+)ms/);
/** `reused 0/4258`：非 0 就是热载，冷开读数作废 */
const reused = num(/reused (\d+)\/(\d+)/);
const reusedTotal = num(/reused \d+\/(\d+)/);
/** 条件抽取与校验各自自报（它们不在 erb 的 breakdown 里） */
const condMs = num(/Condition index:[\s\S]*?in (\d+)ms（复用/);
const lintMs = num(/Convention lint:[\s\S]*?in (\d+)ms across (\d+) rule\(s\)/);

/* ============================== 自证 ============================== */

/**
 * 自证一：解析台账里每条 `@kojo/*` 都要落在本树内。
 * 自证二：`reused` 必须为 0（否则这一轮不是冷开）。
 * 两条都是"量具在骗人"的入口，任一不成立就不许给出读数。
 */
const selfcheck = outsideHits.length === 0 ? 'ok' : 'outside-tree';
const cold = reused === 0;
/**
 * 并行**实际**有没有生效——不信 `--parallel` 的入参，只信内核自己的统计。
 * transport 连续失败 3 次会静默整体关掉（见上面 `ERR_WORKER_PATH` 那条注），
 * 不读这一格的话，"parallel=4" 会一直印在报表上，而任务其实全在主线程跑。
 */
const offload = kernel.compute.stats().offload;
const parallelEffective = offload.parallel ? 1 : 0;

console.log('');
console.log(`[probe] label=${LABEL}`);
console.log(`[probe] tree=${REPO}`);
console.log(`[probe] corpus=${CORPUS}`);
console.log(`[probe] node=${process.version}`);
console.log(`[probe] plugins=${[...enabled].join(',') || '(none)'}`);
console.log(`[probe] parallel=${PARALLEL}`);
console.log(`[probe] parallel_effective=${parallelEffective}`);
console.log(`[probe] offload_dispatched=${offload.dispatched ?? 0}`);
console.log(`[probe] offload_inline=${offload.inline ?? 0}`);
console.log(`[probe] offload_fellback=${offload.fellBack ?? 0}`);
console.log(`[probe] selfcheck=${selfcheck}`);
console.log(`[probe] cold=${cold ? 1 : 0}`);
console.log(`[probe] open_ms=${openMs}`);
console.log(`[probe] index_ms=${indexMs}`);
console.log(`[probe] total_ms=${openMs + indexMs}`);
console.log(`[probe] all_ready_ms=${allReadyMs}`);
console.log(`[probe] build_ms=${buildMs ?? ''}`);
console.log(`[probe] indexed_files=${indexedFiles ?? ''}`);
console.log(`[probe] distinct_functions=${distinctFns ?? ''}`);
console.log(`[probe] root_count=${rootCount ?? ''}`);
console.log(`[probe] reused=${reused ?? ''}/${reusedTotal ?? ''}`);
for (const [k, v] of Object.entries(seg)) console.log(`[probe] seg_${k}=${v ?? ''}`);
console.log(`[probe] cond_ms=${condMs ?? ''}`);
console.log(`[probe] lint_ms=${lintMs ?? ''}`);
/**
 * 会话文本缓存的命中面：回答"refs 阶段是不是又读了一遍盘"。
 *
 * `misses` ≈ 文件数、`hits` ≈ 文件数 ⇒ 解析段全冷读、引用段全命中（只付内存取 + 序列化，
 * 不付盘 IO）。两个数都接近文件数的一半时才是真重读。这条读数是"要不要合并两遍遍历"
 * 的直接依据，不靠猜。
 */
const caches = kernel.io.debugCaches?.();
if (caches !== undefined) {
  console.log(`[probe] cache_hits=${caches.text.hits}`);
  console.log(`[probe] cache_misses=${caches.text.misses}`);
  console.log(`[probe] cache_files=${caches.text.files}`);
  console.log(`[probe] cache_chars=${caches.text.chars}`);
}
console.log(`[probe] resolved=${kojoHits.size}`);
if (outsideHits.length > 0) {
  for (const hit of outsideHits.slice(0, 5)) console.log(`[probe] outside=${hit}`);
}

await kernel.stop().catch(() => {});

if (selfcheck !== 'ok') {
  console.error(`\n[perf-cold-open] 判红：有 ${outsideHits.length} 个 @kojo/* 解析到本树之外，读数不可信`);
  process.exit(4);
}
if (!cold && !ALLOW_WARM) {
  console.error(`\n[perf-cold-open] 判红：reused ${reused}/${reusedTotal} ⇒ 这不是冷开（要热载读数请加 --allow-warm）`);
  process.exit(5);
}
process.exit(0);
