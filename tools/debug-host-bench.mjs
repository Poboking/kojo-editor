#!/usr/bin/env node
/**
 * 调试宿性能对拍（2026-10-26 性能批）：合成语料 + 真 HTTP，量端到端耗时。
 *
 * 目的不是闸，而是**同机同语料的前后读数**：`search_text`（普通/大小写不敏感/正则/整词）、
 * `walk_dir(withMetadata)`、`stat_files`、批量读（二进制直传）、单文件读、health 串行。
 * 语料落在 `debugHome()/bench/`（系统临时目录，**不写仓库**）；已有标记则复用。
 *
 * 用法：
 *   node tools/debug-host-bench.mjs [--label baseline] [--runs 3]
 * 退出码 0（纯读数；起不来才非 0）。
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { debugHome } from './debug-lib.mjs';
import { createDebugServer } from './debug-server.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const LABEL = flag('--label', 'run');
const RUNS = Math.max(1, Number(flag('--runs', '3')) || 3);

const BASE = path.join(debugHome(), 'bench');
const corpus = path.join(BASE, 'corpus');
const large = path.join(BASE, 'large');
const sandbox = path.join(BASE, 'sandbox');
const appdata = path.join(BASE, 'appdata');

/** 2000 个 ~30KB 文件（CJK 口上形状）+ 12 个 ~6MB 大文件；带 5MiB 单读目标 */
async function ensureCorpus() {
  const marker = path.join(BASE, '.gen-v1');
  try {
    await fs.access(marker);
    return;
  } catch {}
  await fs.rm(corpus, { recursive: true, force: true });
  await fs.rm(large, { recursive: true, force: true });
  const lines = (i) =>
    `; 第${i}行注释：口上サンプル あいうえお かきくけこ さしすせそ たちつてと\n` +
    `PRINTL こんにちは世界 ${i} ゼロから始める era 生活、今日も元気に生きています。\n`;
  for (let d = 0; d < 8; d++) {
    const dir = path.join(corpus, `role-${d}`, 'ERB');
    await fs.mkdir(dir, { recursive: true });
    for (let f = 0; f < 250; f++) {
      let text = '';
      for (let i = 0; text.length < 10 * 1024; i++) text += lines(i);
      if ((d * 250 + f) % 100 === 0) text += 'PRINTL NEEDLE_TOKEN ここに針\n';
      await fs.writeFile(path.join(dir, `f-${String(f).padStart(3, '0')}.ERB`), text, 'utf-8');
    }
  }
  await fs.mkdir(path.join(large, 'big'), { recursive: true });
  const chunk = 'あいうえお かきくけこ さしすせそ たちつてと なにぬねの\r\n'.repeat(64);
  for (let i = 0; i < 12; i++) {
    let text = '';
    while (text.length < 2 * 1024 * 1024) text += chunk;
    await fs.writeFile(path.join(large, 'big', `l-${i}.ERB`), text, 'utf-8');
  }
  await fs.writeFile(
    path.join(large, 'big', 'one-5m.ERB'),
    chunk.repeat(Math.ceil((5 * 1024 * 1024) / chunk.length)),
    'utf-8',
  );
  await fs.writeFile(marker, '1');
}

async function listFiles(root, out = []) {
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) await listFiles(full, out);
    else out.push(full);
  }
  return out;
}

await ensureCorpus();
await fs.mkdir(sandbox, { recursive: true });
await fs.mkdir(appdata, { recursive: true });
const server = await createDebugServer({ port: 0, sandbox, appdata, readonly: [BASE], log: () => {} });
const base = `http://127.0.0.1:${server.port}`;

async function invoke(cmd, cmdArgs) {
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  const res = await fetch(`${base}/invoke?binary=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, args: cmdArgs ?? {} }),
  });
  const ct = res.headers.get('content-type') ?? '';
  let payloadBytes = 0;
  let value;
  if (ct.includes('application/octet-stream')) {
    const ab = await res.arrayBuffer();
    payloadBytes = ab.byteLength;
    value = ab;
  } else {
    const text = await res.text();
    payloadBytes = text.length;
    const body = JSON.parse(text);
    if (body.ok === false) throw new Error(`${cmd}: ${body.error}`);
    value = body.value;
  }
  const cpu = process.cpuUsage(cpu0);
  return { ms: performance.now() - t0, cpuMs: (cpu.user + cpu.system) / 1000, payloadBytes, value };
}

const allFiles = await listFiles(corpus);
const largeFiles = (await listFiles(large)).filter((p) => !p.includes('one-5m'));
const rows = [];
async function bench(name, fn, runs = RUNS) {
  const samples = [];
  for (let i = 0; i < runs; i++) samples.push(await fn());
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  rows.push({
    name,
    bestMs: Math.round(Math.min(...samples.map((s) => s.ms)) * 10) / 10,
    avgMs: Math.round(avg(samples.map((s) => s.ms)) * 10) / 10,
    cpuMs: Math.round(avg(samples.map((s) => s.cpuMs)) * 10) / 10,
    payloadMiB: Math.round((samples[0].payloadBytes / 1048576) * 100) / 100,
    info: samples[0].info ?? '',
  });
}

const req = (q, options = {}, maxResults = 2000) => ({
  request: {
    searchId: 1,
    roots: [corpus],
    query: q,
    options: {
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
      extensions: ['erb'],
      maxResults,
      ...options,
    },
  },
});

// 预热：模块 + OS 缓存（读数口径＝warm cache，前后对拍用同一口径）
await fetch(`${base}/health`).then((r) => r.text());
await invoke('read_files_raw', { paths: allFiles.slice(0, 50) });
await invoke('search_text', req('NEEDLE_TOKEN', { caseSensitive: true }));

await bench('search 全扫 0 命中 (2000×~30KB)', async () => {
  const r = await invoke('search_text', req('存在しない検索語XYZ', { caseSensitive: true }));
  r.info = `scanned=${r.value.filesScanned} ${Math.round(r.value.elapsedMs)}ms(host)`;
  return r;
});
await bench('search 稀疏命中 (~20 文件)', async () => {
  const r = await invoke('search_text', req('NEEDLE_TOKEN', { caseSensitive: true }));
  r.info = `scanned=${r.value.filesScanned} hits=${r.value.totalMatches}`;
  return r;
});
await bench('search 大小写不敏感 0 命中', async () => {
  const r = await invoke('search_text', req('存在しない検索語XYZ'));
  return r;
});
await bench('search 正则 0 命中', async () => {
  const r = await invoke('search_text', req('存在しない.*検索語', { isRegex: true }));
  return r;
});
await bench('search 整词 0 命中', async () => {
  const r = await invoke('search_text', req('存在しない検索語XYZ', { wholeWord: true }));
  return r;
});
await bench('search 上限截断 (maxResults=200)', async () => {
  const r = await invoke('search_text', req('あいうえお', { caseSensitive: true }, 200));
  r.info = `scanned=${r.value.filesScanned} trunc=${r.value.truncated}`;
  return r;
});
await bench('walk_dir 2000 文件 withMetadata', async () => {
  const r = await invoke('walk_dir', {
    path: corpus,
    opts: { includeFiles: true, includeDirs: true, withMetadata: true },
  });
  r.info = `entries=${r.value.length}`;
  return r;
});
await bench('stat_files 2000 路径', async () => {
  const r = await invoke('stat_files', { paths: allFiles });
  r.info = `entries=${r.value.length}`;
  return r;
});
await bench('read_files_raw 200×~30KB', async () => {
  const r = await invoke('read_files_raw', { paths: allFiles.slice(0, 200) });
  r.info = 'binary=1';
  return r;
});
await bench('read_files_raw 4×~6MB', async () => {
  const r = await invoke('read_files_raw', { paths: largeFiles.slice(0, 4) });
  r.info = 'binary=1';
  return r;
});
await bench('read_file_bytes_raw 5MiB', async () => {
  const r = await invoke('read_file_bytes_raw', { path: path.join(large, 'big', 'one-5m.ERB') });
  r.info = 'binary=1';
  return r;
});
await bench(
  'health ×100 串行',
  async () => {
    const t0 = performance.now();
    const cpu0 = process.cpuUsage();
    for (let i = 0; i < 100; i++) await fetch(`${base}/health`).then((r) => r.text());
    const cpu = process.cpuUsage(cpu0);
    return { ms: performance.now() - t0, cpuMs: (cpu.user + cpu.system) / 1000, payloadBytes: 0 };
  },
  2,
);

console.log(`\n=== 调试宿性能（${LABEL}）· ${os.cpus().length} 核 · ${new Date().toISOString()} ===`);
console.table(rows);
await server.close();
