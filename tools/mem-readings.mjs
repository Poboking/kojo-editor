#!/usr/bin/env node
/**
 * mem-readings.mjs —— **内存读数探针**（MEM-1 / MEM-2 批，2026-10-29）。
 *
 * ## 量的是什么
 *
 * 一个真内核（`createKernel` + 真 ERB 解析器 / 适配器 / 校验器 / 条件抽取器）打开**真语料**
 * 之后，JS 堆在各阶段的读数：
 *
 * 1. `boot`：内核起好、还没开项目；
 * 2. `open`：`project.open()` 返回（此时索引还在后台跑）；
 * 3. `index`：索引 `phase=ready`（4,145 份 / 100k 函数量级）；
 * 4. `release`：会话文本缓存整表释放之后（MEM-2 的空闲/关项目路径，同一枚函数）。
 *
 * 每段前后都做一次真 GC（`v8.setFlagsFromString('--expose-gc')` + `vm.runInNewContext('gc')`
 * ——vitest / 裸 node 都能用；`globalThis.gc` 在 worker 里通常是 undefined，**别拿它当兜底**，
 * 否则读数全是没回收的垃圾，会得出"删了字段也不掉内存"这种假结论）。
 *
 * ## 为什么要有这个工具
 *
 * 内存批的判据不能只写在提交信息里：`docs/STATE.md` 的数字要能复算。用法：
 *
 * ```
 * KOJO_SMOKE_PROJECT="$(node tools/corpus.mjs --print)" node tools/mem-readings.mjs
 * ```
 *
 * 语料不在位 ⇒ 打印 SKIP 并以 0 退出（与 `tools/corpus.mjs` 的纪律一致：缺语料不是红）。
 *
 * ## `--warm`（热载路径，2026-10-29 收尾补）
 *
 * 上面的默认跑法只量**冷建**（无快照、全量解析）。用户每次启动走的其实是**热载**（命中
 * 盘上快照 ⇒ `files` 是 RAW 元组惰性壳、`byName` 从元组建轻量 ref），两条路的常驻构成完全不同，
 * 所以必须分开量。热载要**两趟两个进程**（一个进程里 `close()` 之后旧索引不撒手，见 PITFALLS 257）：
 *
 * ```
 * KOJO_SMOKE_PROJECT=... KOJO_MEM_STORAGE_DIR=C:/tmp/kojo-mem-store node tools/mem-readings.mjs --warm   # 冷建并写盘
 * KOJO_SMOKE_PROJECT=... KOJO_MEM_STORAGE_DIR=C:/tmp/kojo-mem-store node tools/mem-readings.mjs --warm   # 新进程热载
 * ```
 *
 * 第二趟日志里出现 `reused <N>/<N>` + `read+parse 0ms` 才算真命中。`--stats` 会摸
 * `f.functions`（热载下等于把 10 万枚惰性壳对象实体化），**别和稳态读数同跑**。
 *
 * ## 读数怎么读
 *
 * - `index` 与 `release` 的差 = **会话文本缓存的驻留量**（MEM-2 之前这部分会留到进程结束）；
 * - `index` 本身 = 索引常驻（含 `byName` / 反向引用 / 快照条目）。MEM-1 之前这里含整库正文
 *   ——函数名与注释块是正文的切片，V8 的 `SlicedString` 会顺着父串把整份文件钉在堆里。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import v8 from 'node:v8';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/**
 * 自举：内核源码用了**参数属性**（`constructor(private readonly x)`），strip-only 模式载不动，
 * 必须带 `--experimental-transform-types`。与 `tools/structure-pool-readings.mjs` 同一条约定
 * （那边是写在跑法注释里，这边直接自重启一次，免得作者忘了加旗子拿到一句 SyntaxError）。
 */
if (!process.execArgv.includes('--experimental-transform-types')) {
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(
    process.execPath,
    ['--experimental-transform-types', ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: process.env },
  );
  process.exit(child.status ?? 1);
}

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@kojo/')) {
      const name = specifier.slice('@kojo/'.length);
      const dir = name.startsWith('plugin-') ? join(REPO, 'packages/plugins', name.slice('plugin-'.length)) : join(REPO, 'packages', name);
      const entry = join(dir, 'src/index.ts');
      if (existsSync(entry)) return { url: pathToFileURL(entry).href, shortCircuit: true };
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

const CORPUS = process.env.KOJO_SMOKE_PROJECT ?? '';
if (CORPUS === '' || !existsSync(CORPUS)) {
  console.log('[mem-readings] SKIP：语料不在位（设 KOJO_SMOKE_PROJECT=<语料目录>；可先跑 node tools/corpus.mjs --print）');
  process.exit(0);
}

/** `--snapshot <文件>`：在索引就绪那一刻落一份 V8 堆快照（分解构成用；读法见 `tools/mem-shell.mjs --aggregate`） */
const snapArgIdx = process.argv.indexOf('--snapshot');
const SNAPSHOT_OUT = snapArgIdx >= 0 ? process.argv[snapArgIdx + 1] : null;
/** `--snapshot-after <文件>`：稳态（文本缓存释放后）那一拍再落一份，两份一 diff 就是"谁没被释放" */
const snapAfterIdx = process.argv.indexOf('--snapshot-after');
const SNAPSHOT_AFTER = snapAfterIdx >= 0 ? process.argv[snapAfterIdx + 1] : null;

v8.setFlagsFromString('--expose-gc');
const forceGc = vm.runInNewContext('gc');
const gc = () => {
  forceGc();
  forceGc();
};
const mb = (n) => +(n / 1024 / 1024).toFixed(1);
const snap = () => {
  const m = process.memoryUsage();
  return { rss: mb(m.rss), heap: mb(m.heapUsed) };
};
const line = (label, s) => console.log(`[mem] ${label.padEnd(12)} rss=${String(s.rss).padStart(6)}MB  heap=${String(s.heap).padStart(6)}MB`);

const { createKernel } = await import(pathToFileURL(join(REPO, 'packages/kernel/src/kernel.ts')).href);
const { NodeBridge } = await import(pathToFileURL(join(REPO, 'packages/kernel/tests/helpers/node-bridge.ts')).href);
const { MemoryStorageBackend } = await import(pathToFileURL(join(REPO, 'packages/kernel/tests/helpers/memory-storage.ts')).href);

const { createErbParserPlugin, erbParserTasks, scanControlFlow } = await import('@kojo/plugin-erb-parser');
const { createEratwAdapterPlugin } = await import('@kojo/plugin-eratw-adapter');
const { createConventionLinterPlugin } = await import('@kojo/plugin-convention-linter');
const { conditionExtractorTasks, createConditionExtractorPlugin } = await import('@kojo/plugin-condition-extractor');

const appData = mkdtempSync(join(tmpdir(), 'kojo-mem-readings-'));

/**
 * **落盘型存储后端**（默认）：`write` 收下就丢，只记字节数。
 *
 * 为什么不用 `MemoryStorageBackend`：它把索引快照**原样留在堆里**（真语料 57 MB 一个字符串），
 * 而真应用走 `FileStorageBackend` 写盘、写完就撒手。拿 Memory 后端量出来的"稳态"会把这
 * 57 MB 算成内核常驻（实测占 276.5 MB 里的 57 MB，虚高 26%）。
 * 这里不实现读回：单轮冷建的读数不需要热载路径（热载另有 `--memory-storage`）。
 */
class DiskLikeStorage {
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

/**
 * **真落盘存储后端**（`--warm` 用）：写 tmpdir 的真文件，读回真字符串。
 *
 * 为什么不用 `MemoryStorageBackend`：它把快照串一直攥在堆里，热载读数会平白多出
 * 一个 57 MB 的常驻串（真应用写完就撒手、读回解码完就撒手）。这里走 fs 就是为了让
 * 「读回 → 解码 → 撒手」这条路和真应用同形，量到的才是热载后的净堆。
 */
class TempFileStorage {
  bytes = 0;
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }
  path(scope, key) {
    return join(this.dir, `${scope}__${key}.txt`);
  }
  async read(scope, key) {
    try {
      return { kind: 'ok', data: readFileSync(this.path(scope, key), 'utf8') };
    } catch {
      return { kind: 'missing' };
    }
  }
  async write(scope, key, value) {
    this.bytes = Math.max(this.bytes, value.length);
    writeFileSync(this.path(scope, key), value);
  }
  async remove(scope, key) {
    try {
      rmSync(this.path(scope, key));
    } catch {}
  }
  async list(scope) {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.startsWith(`${scope}__`))
        .map((f) => f.slice(scope.length + 2, -4));
    } catch {
      return [];
    }
  }
}

const WARM = process.argv.includes('--warm');
/**
 * `--warm` 的存储目录**固定**（`KOJO_MEM_STORAGE_DIR`，默认 `C:/tmp/kojo-mem-store`）。
 *
 * 为什么要固定、要跨进程：一个进程里「冷建 → close → 热载」量不准——`close()` 只发事件、
 * 插件也把 `index` 置空了，但实测 `2 close` 仍停在 276.1 MB（旧索引没被回收），
 * 第二趟量到的就是「旧索引 + 新索引」。真用户是重启进程，所以这里也分两次跑：
 * 第一趟冷建写盘，第二趟新进程热载，两边各自从 22 MB 的 boot 起步。
 */
const WARM_DIR = process.env.KOJO_MEM_STORAGE_DIR ?? join(tmpdir(), 'kojo-mem-store');
const storageBackend = WARM
  ? new TempFileStorage(WARM_DIR)
  : process.argv.includes('--memory-storage')
    ? new MemoryStorageBackend()
    : new DiskLikeStorage();
/**
 * `--plugins=erb,adapter,linter,condition`（默认全开）：逐个少装一个，量"这个插件自己常驻多少"。
 *
 * 为什么要这个开关：热载稳态里 erb 索引只占 67 MB（`byName` 消融值），剩下 200+ MB 挂在
 * 别的插件身上——单看索引的读数会让人以为"索引已经很小了，没得可压"。
 */
const PLUGIN_NAMES = ['erb', 'adapter', 'linter', 'condition'];
const enabled = (() => {
  // 两种写法都要认：`--plugins=erb` 与 `--plugins erb`。
  // 只写 `argv.indexOf('--plugins')` 的话，等号写法会**静默回落到默认全开**——
  // 实测踩过：五次"逐级少装一个插件"的读数一模一样（200.9 / 263.9），差点当成"插件不占内存"。
  const eq = process.argv.find((a) => a.startsWith('--plugins='));
  if (eq !== undefined) {
    return new Set(
      eq
        .slice('--plugins='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  const i = process.argv.indexOf('--plugins');
  if (i < 0) return new Set(PLUGIN_NAMES);
  return new Set(
    String(process.argv[i + 1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
})();
const pluginFactories = {
  erb: () => createErbParserPlugin(),
  adapter: () => createEratwAdapterPlugin(),
  linter: () => createConventionLinterPlugin(),
  condition: () => createConditionExtractorPlugin(),
};
console.log(`[mem] 插件：${[...enabled].join(',') || '（无）'}`);

const kernel = await createKernel({
  platform: new NodeBridge(appData),
  plugins: PLUGIN_NAMES.filter((n) => enabled.has(n)).map((n) => pluginFactories[n]()),
  storageBackend,
});
for (const [kind, impl] of Object.entries({ ...erbParserTasks, ...conditionExtractorTasks(scanControlFlow) })) {
  kernel.compute.registerTask(kind, impl);
}
await kernel.start();
gc();
const boot = snap();
line('0 boot', boot);

// `services.get` 对未注册的服务**抛错**（不是返回 undefined）：少装一个插件做预算对比时
// 必须先兜住，否则 `--plugins=adapter` 这类基线跑法直接崩在取服务这一步
const parser = (() => {
  try {
    return kernel.services.get('erb.parser');
  } catch {
    return null;
  }
})();
let index = null;
let afterIndex = null;

/**
 * 开一次项目并等到索引就绪。
 *
 * `--warm` 的两次跑法见 `WARM_DIR` 的注释：本进程只跑一趟，冷/热由盘上有没有快照决定，
 * 所以「热载读数」必须用两次独立进程拿到（第一次写盘、第二次命中）。
 */
async function buildOnce(tag) {
  const openStart = Date.now();
  await kernel.project.open(CORPUS);
  gc();
  const afterOpen = snap();
  line(`${tag} open`, afterOpen);
  const openMs = Date.now() - openStart;
  const indexStart = Date.now();
  let idx = null;
  // 没装 erb 插件就没有索引可等（否则会白等 120s，把"少装一个插件"的量法拖成十几分钟）
  for (let i = 0; enabled.has('erb') && i < 1200; i++) {
    idx = parser?.currentIndex?.() ?? null;
    if (idx) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  gc();
  const afterIdx = snap();
  line(`${tag} index`, afterIdx);
  const state = parser?.indexState?.() ?? null;
  console.log(
    `[mem] ${tag} open() ${openMs}ms  index ready ${Date.now() - indexStart}ms  state=${JSON.stringify(state)}`,
  );
  console.log(`[mem] ${tag} files=${idx?.files?.size ?? 'n/a'} names=${idx?.byName?.size ?? 'n/a'}`);
  if (WARM) console.log(`[mem] ${tag} storage bytes=${storageBackend.bytes}（本进程写进去的）`);
  return { idx, afterIdx };
}

{
  const cold = await buildOnce(WARM ? '1' : '1');
  index = cold.idx;
  afterIndex = cold.afterIdx;
}
if (process.argv.includes('--stats') && index) {
  // 结构普查：把"堆里那 96 万个数组到底是哪些"直接数出来，不靠猜快照
  let fnTotal = 0, paramsTotal = 0, paramsArr = 0, dimsTotal = 0, labelsTotal = 0;
  for (const f of index.files.values()) {
    fnTotal += f.functions?.length ?? 0;
    for (const fn of f.functions ?? []) {
      paramsTotal += fn.params?.length ?? 0;
      if (fn.params) paramsArr++;
    }
    dimsTotal += f.dims?.length ?? 0;
    labelsTotal += f.labels?.length ?? 0;
  }
  let byNameArr = 0, byNameSingle = 0, byNameElems = 0;
  for (const v of index.byName.values()) {
    byNameArr++;
    byNameElems += v.length;
    if (v.length === 1) byNameSingle++;
  }
  const bySymbol = index.references?.bySymbol;
  let symArr = 0, symSingle = 0, symElems = 0;
  if (bySymbol) for (const v of bySymbol.values()) { symArr++; symElems += v.length; if (v.length === 1) symSingle++; }
  console.log(
    `[mem] stats files=${index.files.size} 函数=${fnTotal} 形参数=${paramsTotal}（params 数组 ${paramsArr}）` +
      ` dims=${dimsTotal} labels=${labelsTotal}`,
  );
  console.log(
    `[mem] stats byName 值数组=${byNameArr}（其中单元素 ${byNameSingle}）元素合计=${byNameElems}` +
      ` | bySymbol 值数组=${symArr}（单元素 ${symSingle}）元素合计=${symElems}`,
  );
  console.log(
    `[mem] stats 其它 Map：fileMtimes=${index.fileMtimes?.size ?? '-'} fileSizes=${index.fileSizes?.size ?? '-'}`,
  );
}

/**
 * `--snapshot-stats`：跨轮保留的**解码后快照条目**的结构普查。
 *
 * 这是热载稳态最大的一块常驻，但它藏在插件闭包里，外面只能倒推。`snapshotStatsForDebug()`
 * 是纯读口子（不物化懒外壳）：元组 / refs / 候选集分别占多少，一次问清。
 */
if (process.argv.includes('--snapshot-stats')) {
  const st = parser.snapshotStatsForDebug?.() ?? null;
  if (st === null) {
    console.log('[mem] snapshot-stats 无（未保留快照）');
  } else {
    console.log(
      `[mem] snapshot-stats 条目=${st.entries}（惰性壳 ${st.lazyShells} / 已物化 ${st.materialized}）` +
        ` 正文=${st.textLength} 码元`,
    );
    console.log(
      `[mem] snapshot-stats 函数=${st.functions} 名=${st.nameChars} 字符 注释=${st.docChars} 字符` +
        ` 声明=${st.dims} 引用=${st.refs} 标签=${st.labels}`,
    );
    console.log(
      `[mem] snapshot-stats 候选集：${st.candidatesKnown}/${st.entries} 条，合计 ${st.candidateChars} 字符` +
        ` | 带 refs 的条目 ${st.withRefs}`,
    );
  }
}

// 读数走内核既有的观测面（`debugCaches().text`），不另开 API
console.log(`[mem] io textCache ${JSON.stringify(kernel.io.debugCaches?.().text ?? null)}`);if (SNAPSHOT_OUT) {
  // 快照必须**在释放之前**落：文本缓存那 200 MB 是这一步要归因的对象
  const t0 = Date.now();
  v8.writeHeapSnapshot(SNAPSHOT_OUT);
  console.log(`[mem] snapshot → ${SNAPSHOT_OUT}（${Date.now() - t0}ms）`);
}
/**
 * 等索引快照落盘（`void storage.set(...)` 是 fire-and-forget）。
 *
 * 为什么必须等：序列化出来的快照串（真语料 57 MB）在这一刻是**瞬时垃圾**，不等它落地
 * 就直接量稳态，会把这份瞬时算成常驻（`--warm` 首测 steady 339.2 MB，比干净的 276.1
 * 高出 63 MB，正是它）。等落盘 + 随后的 `gc()` 才是"写完就撒手"的真应用形态。
 */
const settleStart = Date.now();
const settleCap = (() => {
  const i = process.argv.indexOf('--settle');
  return i >= 0 ? Number(process.argv[i + 1]) : 20_000;
})();
while (storageBackend.bytes < 1024 && Date.now() - settleStart < settleCap) {
  await new Promise((done) => setTimeout(done, 50));
}
console.log(`[mem] snapshot 落盘 ${storageBackend.bytes} 字符（等 ${Date.now() - settleStart}ms）`);

kernel.io.releaseTextCache?.('manual');
gc();
const afterRelease = snap();
line('3 release', afterRelease);

/**
 * `--samples N`：**多次采样取稳态下界**（默认 1 = 只取上面那一点）。
 *
 * 为什么需要：热载稳态**不是个稳定数**。索引就绪之后，校验器与条件抽取器还在跑各自的
 * 异步流水，GC 撞上谁全看时机——同一份语料、同一份代码，1.5s 处读到 260.1 MB、
 * 3s 处 398.4 MB、12s 处 313.8 MB。单点读数因此既不能当"优化前后的对照"，
 * 也不能当"回归判据"。这里每秒 `gc()` 后采一次，**取下界**（= 常驻地板，
 * 不被在途垃圾污染）并给出中位/上界，读数才有可比性。
 */
const SAMPLE_COUNT = (() => {
  const i = process.argv.indexOf('--samples');
  return i >= 0 ? Math.max(1, Number(process.argv[i + 1]) || 1) : 1;
})();
let steadyFloor = afterRelease.heap;
if (SAMPLE_COUNT > 1) {
  const samples = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    await new Promise((done) => setTimeout(done, 1000));
    gc();
    samples.push(snap().heap);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  steadyFloor = sorted[0];
  console.log(
    `[mem] steady 采样 ${SAMPLE_COUNT} 次：下界 ${sorted[0]}MB · 中位 ${sorted[sorted.length >> 1]}MB · 上界 ${sorted[sorted.length - 1]}MB`,
  );
  console.log(`[mem] steady 全部样本 ${samples.join(' / ')}`);
}
if (SNAPSHOT_AFTER) {
  const t0 = Date.now();
  v8.writeHeapSnapshot(SNAPSHOT_AFTER);
  console.log(`[mem] snapshot(after) → ${SNAPSHOT_AFTER}（${Date.now() - t0}ms）`);
}

/** 带符号的差值（`a` 相对 `b` 的变化）：释放量写 `-X`，反而涨了写 `+X`——别让 `--157.6` 这种双负号进日志 */
const signed = (deltaMb) => `${deltaMb >= 0 ? '-' : '+'}${Math.abs(deltaMb).toFixed(1)}MB`;
const drop = (a, b) => signed(a.heap - b.heap);

if (process.argv.includes('--ablate') && index) {
  // 消融：摘掉索引的一块，看堆掉多少——比追持有链快，也比猜快照准。
  //
  // ⚠ **一次只许跑一步**（`--ablate-only=<key>`）。串着跑会把读数毁掉：每一步的 `gc()`
  // 顺手把上一步制造/遗留的垃圾也收了，后一步的差值就不是它自己的量。
  // 实测（同一份语料、同一平台）：串着跑时 `byName.clear` 报 −67.1 MB，
  // 而三块一起清只报 −30.4 MB——后者比前者还小，逻辑上不可能，就是串跑污染的。
  // 另：删单个字段会触发 V8 把对象转字典模式，**堆反而涨**（`byName.docComment` 报 +18.6 MB），
  // 所以"删字段"这类步骤只能看方向，不能当数值。
  console.log(`[mem] ablate index frozen=${Object.isFrozen(index)} keys=${Object.keys(index).join(',')}`);
  const onlyArg = process.argv.find((a) => a.startsWith('--ablate-only='));
  const only = onlyArg === undefined ? null : onlyArg.slice('--ablate-only='.length);
  const step = (key, label, fn) => {
    if (only !== null && only !== key) return;
    // 基线用"刚 gc 过"的值：不然 before 里含着上一步的垃圾
    gc();
    const before = process.memoryUsage().heapUsed;
    let err = '';
    try {
      fn();
    } catch (e) {
      err = String(e?.message ?? e);
    }
    gc();
    const after = process.memoryUsage().heapUsed;
    console.log(
      `[mem] ablate ${label.padEnd(16)} ${signed((before - after) / 1048576).padStart(9)}（剩 ${mb(after)}MB）${err ? ` ⚠ ${err}` : ''}`,
    );
  };
  const dropEntries = () => {
    const svc = kernel.services.get?.('erb.parser');
    const snap = svc?.snapshotForDebug?.() ?? null;
    // `entries` 是 Record 不是数组：`entries.length = 0` 什么也删不掉（上一轮就是这么报出
    // "−0 MB" 的假读数，还被我当成"快照不占内存"的证据）
    if (snap?.entries) for (const k in snap.entries) delete snap.entries[k];
  };
  // 单清一方量不出来：`files` 的惰性壳持有 RAW 元组、`entries` 也持有同一批壳，
  // 互相兜底 ⇒ 只清 `files`、只清 `entries` 都掉不动。这一发把三块一起摘掉，
  // 量的才是**整棵 ERB 索引**的常驻。
  step('index', '索引全清', () => {
    index.files.clear();
    index.byName.clear();
    dropEntries();
  });
  step('bySymbol', 'references.bySymbol', () => index.references?.bySymbol?.clear?.());
  step('byName', 'byName.clear', () => index.byName.clear());
  step('files', 'files.clear', () => index.files.clear());
  step('mtimes', 'fileMtimes.clear', () => index.fileMtimes?.clear?.());
  step('snapshot', 'snapshot entries', dropEntries);
}
console.log(
  `[mem-verdict] index=+${(afterIndex.heap - boot.heap).toFixed(1)}MB  ` +
    `textCache=${drop(afterIndex, afterRelease)}  ` +
    `steady=${steadyFloor}MB  ` +
    `(boot ${boot.heap}MB / 索引就绪 ${afterIndex.heap}MB)`,
);

// 内核持着 worker 池与监视器句柄 ⇒ 不主动退出的话读数打完也回不到 shell（读到数字即走）
process.exit(0);
