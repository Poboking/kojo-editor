#!/usr/bin/env node
/**
 * bench-io-phases.mjs —— **冷开 IO 链路分项探针**（PERF-R7C，2026-10-31）。
 *
 * ## 它回答的问题
 *
 * `perf-cold-open.mjs` 只给到 `read+parse 5480ms` 这一格，但这一格里混着四件事：
 * 读盘、解码、换行探测、换行归一。R7B 的归因把它们拆过一次，此后 `detectEol` 改成了
 * `indexOf('\n')` 跳跃、`normalizeEol` 改成了 `indexOf('\r')` 快路径——**旧分项已失效**。
 * 要判断"把 decode+EOL 搬出主线程"值不值得做，必须重新量一遍，而不是拿两个月前的数估。
 *
 * ## 为什么是"增量档"而不是各自独立计时
 *
 * 四件事在同一条流水线上串行发生，单独量 decode 会把 `fs.readFile` 的成本也算进去。
 * 这里跑四档**递进**的管线，每一档比上一档多的那一段就是该阶段的净成本：
 *
 * | 档 | 管线 | 差值含义 |
 * |---|---|---|
 * | P0 | `readFile` | 读盘（含 IPC/系统调用与 Buffer 分配） |
 * | P1 | + `decodeWithProbe` | 解码（UTF-8 fatal 校验与解码合体） |
 * | P2 | + `detectEol` | 换行多数派探测 |
 * | P3 | + `normalizeEol` | 换行归一（纯 LF 走 `indexOf` 快路径） |
 * | P4 | + `split('\n')` | 切行（现状由消费方各切一次） |
 *
 * 每档都**重读一遍盘**（不复用上一档的 bytes），否则"读盘"那一档只有第一遍是真的。
 *
 * ## 口径
 *
 * - 并发 8（`--concurrency`）：真机 `readFilesRaw` 是批量的平台桥调用，不是 4,258 次串行。
 *   **必须用异步 `fs/promises.readFile`**：`readFileSync` 在 Node 里是同步阻塞，8 个"并发"
 *   实际完全串行（第一版就这么写的，P0 读出 7,430ms，真机批量读是 2,232ms，差了 3 倍多）；
 * - 每档先跑一轮丢弃（V8 暖起来 + 页缓存命中），第二轮的读数才是稳态；
 * - 语料不在位 ⇒ SKIP 且 exit 0（与 `tools/corpus.mjs` 同纪律）。
 *
 * ```
 * KOJO_SMOKE_PROJECT="D:/game/eraTW4.981-261017-EAGLOV3" node tools/bench-io-phases.mjs
 * ```
 */
import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

if (!process.execArgv.includes('--experimental-transform-types')) {
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(
    process.execPath,
    ['--experimental-transform-types', ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: process.env },
  );
  process.exit(child.status ?? 1);
}

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const CORPUS = flag('--corpus', process.env.KOJO_SMOKE_PROJECT ?? '');
const CONCURRENCY = Number(flag('--concurrency', '8')) || 8;

if (CORPUS === '' || !existsSync(CORPUS)) {
  console.log('[bench-io-phases] SKIP：语料不在位（设 KOJO_SMOKE_PROJECT=<语料目录>）');
  process.exit(0);
}

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@kojo/')) {
      const rest = specifier.slice('@kojo/'.length);
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      const sub = slash < 0 ? '' : rest.slice(slash + 1);
      const dirs = [join(REPO, 'packages', name)];
      if (name.startsWith('plugin-')) dirs.push(join(REPO, 'packages/plugins', name.slice('plugin-'.length)));
      const base = dirs.find((d) => existsSync(d)) ?? dirs[0];
      const candidates =
        sub === '' ? [join(base, 'src/index.ts')] : [join(base, 'src', `${sub}.ts`), join(base, 'src', sub, 'index.ts')];
      for (const entry of candidates) {
        if (existsSync(entry)) return { url: pathToFileURL(entry).href, shortCircuit: true };
      }
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      for (const c of [`${base}.ts`, base.replace(/\.js$/, '.ts'), join(base, 'index.ts')]) {
        if (c !== base && existsSync(c)) return { url: pathToFileURL(c).href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
});

const { decodeWithProbe, detectEol, normalizeEol } = await import('@kojo/kernel/encoding');

/* ------------------------------ 语料 ------------------------------ */

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs);
    else if (/\.(erb|erh)$/i.test(name)) files.push(abs);
  }
})(resolve(CORPUS));
files.sort();

if (files.length === 0) {
  console.log('[bench-io-phases] SKIP：语料里没有 .erb/.erh');
  process.exit(0);
}

/* ------------------------------ 分档 ------------------------------ */

/** 并发跑一遍全量，返回 [字节总数, 码元总数, 行数] */
async function run(pick) {
  let bytes = 0;
  let chars = 0;
  let lines = 0;
  let cursor = 0;
  const started = process.hrtime.bigint();
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= files.length) return;
      const r = pick(await readFile(files[i]));
      bytes += r.bytes;
      chars += r.chars;
      lines += r.lines;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { ms, bytes, chars, lines };
}

const P0 = (buf) => ({ bytes: buf.length, chars: 0, lines: 0 });
const P1 = (buf) => {
  const { text } = decodeWithProbe(buf);
  return { bytes: buf.length, chars: text.length, lines: 0 };
};
const P2 = (buf) => {
  const { text } = decodeWithProbe(buf);
  const eol = detectEol(text);
  return { bytes: buf.length, chars: text.length, lines: eol === 'crlf' ? 1 : 0 };
};
const P3 = (buf) => {
  const { text } = decodeWithProbe(buf);
  detectEol(text);
  const norm = normalizeEol(text);
  return { bytes: buf.length, chars: norm.length, lines: 0 };
};
const P4 = (buf) => {
  const { text } = decodeWithProbe(buf);
  const norm = normalizeEol(text);
  const parts = norm.split('\n');
  return { bytes: buf.length, chars: norm.length, lines: parts.length };
};

const tiers = [
  ['P0 readFile', P0],
  ['P1 +decode', P1],
  ['P2 +detectEol', P2],
  ['P3 +normalizeEol', P3],
  ['P4 +split', P4],
];

const results = [];
for (const [label, fn] of tiers) {
  await run(fn); // 预热轮丢弃
  const r = await run(fn);
  results.push([label, r]);
  console.log(`[phase] ${label.padEnd(16)} ${r.ms.toFixed(0).padStart(6)}ms`);
}

const stat = results[1][1];
console.log(`[phase] 语料 ${files.length} 文件 / ${(stat.bytes / 1048576).toFixed(1)} MB / 码元 ${stat.chars.toLocaleString('en-US')}`);

let prev = 0;
for (const [label, r] of results) {
  console.log(`[delta] ${label.padEnd(16)} +${(r.ms - prev).toFixed(0).padStart(5)}ms`);
  prev = r.ms;
}
