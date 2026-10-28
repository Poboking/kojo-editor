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
 * ## 读数怎么读
 *
 * - `index` 与 `release` 的差 = **会话文本缓存的驻留量**（MEM-2 之前这部分会留到进程结束）；
 * - `index` 本身 = 索引常驻（含 `byName` / 反向引用 / 快照条目）。MEM-1 之前这里含整库正文
 *   ——函数名与注释块是正文的切片，V8 的 `SlicedString` 会顺着父串把整份文件钉在堆里。
 */
import { existsSync, mkdtempSync } from 'node:fs';
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
const kernel = await createKernel({
  platform: new NodeBridge(appData),
  plugins: [
    createErbParserPlugin(),
    createEratwAdapterPlugin(),
    createConventionLinterPlugin(),
    createConditionExtractorPlugin(),
  ],
  storageBackend: new MemoryStorageBackend(),
});
for (const [kind, impl] of Object.entries({ ...erbParserTasks, ...conditionExtractorTasks(scanControlFlow) })) {
  kernel.compute.registerTask(kind, impl);
}
await kernel.start();
gc();
const boot = snap();
line('0 boot', boot);

const openStart = Date.now();
await kernel.project.open(CORPUS);
gc();
const afterOpen = snap();
line('1 open', afterOpen);
console.log(`[mem] open() 墙钟 ${Date.now() - openStart}ms`);

const parser = kernel.services.get('erb.parser');
let index = null;
const indexStart = Date.now();
for (let i = 0; i < 1200; i++) {
  index = parser.currentIndex?.() ?? null;
  if (index) break;
  await new Promise((done) => setTimeout(done, 100));
}
gc();
const afterIndex = snap();
line('2 index', afterIndex);
const state = parser.indexState?.() ?? null;
console.log(`[mem] index ready 墙钟 ${Date.now() - indexStart}ms  state=${JSON.stringify(state)}`);
console.log(`[mem] index files=${index?.files?.size ?? 'n/a'} names=${index?.byName?.size ?? 'n/a'}`);

// 读数走内核既有的观测面（`debugCaches().text`），不另开 API
console.log(`[mem] io textCache ${JSON.stringify(kernel.io.debugCaches?.().text ?? null)}`);
kernel.io.releaseTextCache?.('manual');
gc();
const afterRelease = snap();
line('3 release', afterRelease);

const drop = (a, b) => `-${(a.heap - b.heap).toFixed(1)}MB`;
console.log(
  `[mem-verdict] index=+${(afterIndex.heap - boot.heap).toFixed(1)}MB  ` +
    `textCache=${drop(afterIndex, afterRelease)}  ` +
    `steady=${afterRelease.heap}MB  ` +
    `(boot ${boot.heap}MB / 索引就绪 ${afterIndex.heap}MB)`,
);

// 内核持着 worker 池与监视器句柄 ⇒ 不主动退出的话读数打完也回不到 shell（读到数字即走）
process.exit(0);
