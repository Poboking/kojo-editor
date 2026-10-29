#!/usr/bin/env node
/**
 * 真壳内存读数（Tauri / WebView2 侧）——MEM 批的壳内补量。
 *
 * 为什么要有这个：`tools/mem-readings.mjs` 量的是 **node 内核级**（493.6 → 276.5 MB），
 * 但用户感受到的"系统占用"是壳里那几份进程的工作集。两边不是同一个数：
 * ① 内核在壳里跑在 **compute worker** 里（`bootstrap.ts` 的 `createWorkerTransport`），
 *    主页面那份 JS 堆很小；② WebView2 有 browser / GPU / renderer 多进程，
 *    还有一份 V8 之外的 native 占用。所以壳内读数必须**按 CDP target 逐个**取
 *    V8 堆 + **按进程树**取工作集，两个口径并列给，不拿一个冒充另一个。
 *
 * 用法：
 *   node tools/mem-shell.mjs                 # 会话自动发现（同 debug-cli），出全部读数
 *   node tools/mem-shell.mjs --cdp 9223      # 指定 CDP 端口
 *   node tools/mem-shell.mjs --ps            # 只出进程树（壳没开 CDP 时也能量）
 *   node tools/mem-shell.mjs --snapshot <f>  # 取页面堆快照并按类型聚合（**壳内唯一可信口径**）
 *   node tools/mem-shell.mjs --sanity        # 附带量具自检（页内分配 160 MB 数组看读数跟不跟）
 *   node tools/mem-shell.mjs --json          # 机读
 *
 * 口径与坑（都在本机实测过）：
 * - 读数取 `Performance.getMetrics` 的 `JSHeapUsedSize`；`performance.memory` 在 WebView2
 *   里按 100KB 量化，`Runtime.getHeapUsage` 可能返回**缓存值**（连着读四次、中间分配
 *   100 MB 都不动）。`HeapProfiler.enable` 会让本连接的读数停在旧值上——别开。
 * - **先自检再读数**（`--sanity`）：20M 双精度数组 ≈160 MB，读数不涨 ≥100 MB 就是量具坏了。
 * - 工作集（WorkingSetSize）包含已释放但还没还给 OS 的页，**天然滞后于** V8 堆；而且冷开
 *   那一轮的瞬时垃圾会把它抬得很高（实测同一次会话 2.5 GB → 1.3 GB 与代码无关）。
 *   ⇒ 工作集只当"OS 侧有没有还"的粗证，归因必须看 V8 堆。
 * - 进程树按 shellPid 往下走：**应用**（kojo-editor + msedgewebview2）与**工具链**
 *   （vite / esbuild / cargo）必须分开报，混在一起会把 `pnpm dev` 算成编辑器。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Cdp, debugHome, sessionDir, sleep } from './debug-lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const AS_JSON = has('--json');
const PS_ONLY = has('--ps');
const SNAPSHOT_OUT = val('--snapshot', null);
const MB = (n) => Math.round((n / 1024 / 1024) * 10) / 10;

/** 会话文件：与 debug-cli 同一套「按工作树隔离」的目录，别读全局那个 */
function readSession() {
  const file = process.env.KOJO_DEBUG_SESSION ?? path.join(sessionDir(ROOT), 'session.json');
  if (!fs.existsSync(file)) return null;
  try {
    return { file, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return null;
  }
}

/** 进程树：只认 shellPid 往下，绝不按进程名全局扫（多 agent 并发会把别人的壳算进来） */
function processTree(rootPid) {
  const cmd =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress';
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  if (r.status !== 0 || !r.stdout) return { error: (r.stderr || '').trim() || 'powershell 取进程表失败' };
  let rows;
  try {
    rows = JSON.parse(r.stdout);
  } catch (err) {
    return { error: `进程表 JSON 解析失败：${err.message}` };
  }
  if (!Array.isArray(rows)) rows = [rows];
  const byPid = new Map(rows.map((p) => [Number(p.ProcessId), p]));
  const childrenOf = new Map();
  for (const p of rows) {
    const ppid = Number(p.ParentProcessId);
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(p);
  }
  const out = [];
  const stack = [Number(rootPid)];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = byPid.get(pid);
    if (p) {
      out.push({
        pid,
        name: String(p.Name ?? ''),
        workingSet: Number(p.WorkingSetSize ?? 0),
        privateBytes: Number(p.PrivatePageCount ?? 0),
      });
    }
    for (const c of childrenOf.get(pid) ?? []) stack.push(Number(c.ProcessId));
  }
  // 分类：**应用** = Rust 宿主 + WebView2 各进程；**工具链** = tauri dev 拉起的 vite / esbuild /
  // cargo。两者必须分开报——混在一起会把 `pnpm dev` 的内存算成编辑器的（实测差 500 MB 量级）。
  const isApp = (n) => /^kojo-editor/i.test(n) || /^msedgewebview2/i.test(n);
  for (const p of out) p.kind = isApp(p.name) ? 'app' : 'tool';
  const sum = (list, k) => list.reduce((a, p) => a + p[k], 0);
  const app = out.filter((p) => p.kind === 'app');
  const tool = out.filter((p) => p.kind === 'tool');
  return {
    procs: out.sort((a, b) => b.workingSet - a.workingSet),
    totalWs: sum(out, 'workingSet'),
    totalPriv: sum(out, 'privateBytes'),
    app: { count: app.length, ws: sum(app, 'workingSet'), priv: sum(app, 'privateBytes') },
    tool: { count: tool.length, ws: sum(tool, 'workingSet'), priv: sum(tool, 'privateBytes') },
  };
}

/** CDP target 枚举：页面 + worker 都要，内核在 worker 里 */
async function targets(cdpPort) {
  const list = await (
    await fetch(`http://127.0.0.1:${cdpPort}/json`, { signal: AbortSignal.timeout(5000) })
  ).json();
  return list.filter((t) => t.webSocketDebuggerUrl && ['page', 'worker', 'service_worker', 'iframe'].includes(t.type));
}

/**
 * 单个 target：GC 后取 V8 堆。
 *
 * **量具口径（2026-10-29 实测，别改回去）**：读数取 `Performance.getMetrics` 的
 * `JSHeapUsedSize`，不取 `performance.memory.usedJSHeapSize`（WebView2 里按 100KB 量化）。
 * `Runtime.getHeapUsage` 与它同源，但**可能返回上次刷新的缓存值**——同一个数连着读
 * 四次、中间分配 100 MB 字符串都不动，而 `Performance.enable` + `getMetrics` 会强制刷新。
 * 灵敏度自检见 `--sanity`：页内分配 20M 双精度数组（≈160 MB）后读数必须涨 ≥100 MB，
 * 不涨就是量具坏了，此时所有结论作废（PITFALLS 254 同款纪律：先校准再读）。
 */
async function heapOf(wsUrl) {
  const cdp = new Cdp(wsUrl);
  await cdp.connect();
  try {
    await cdp.send('Performance.enable').catch(() => {});
    await cdp.send('Runtime.enable').catch(() => {});
    // 注意：这里**不**调 `HeapProfiler.enable`——它会让本连接的读数停在旧值上（实测）。
    const metrics = await cdp.send('Performance.getMetrics').catch(() => null);
    const pick = (name) => {
      const m = (metrics?.metrics ?? []).find((x) => x.name === name);
      return m ? m.value : null;
    };
    const used = pick('JSHeapUsedSize');
    const total = pick('JSHeapTotalSize');
    let nodes = pick('Nodes');
    return { used, total, nodes, perf: null };
  } finally {
    cdp.close();
  }
}

/** 量具自检：页内分配 ≈160 MB 双精度数组，读数必须跟着涨；涨不动就是量具坏了 */
async function sanity(wsUrl) {
  const cdp = new Cdp(wsUrl);
  await cdp.connect();
  const read = async () => {
    const m = await cdp.send('Performance.getMetrics');
    return (m.metrics.find((x) => x.name === 'JSHeapUsedSize') ?? {}).value ?? null;
  };
  try {
    await cdp.send('Performance.enable').catch(() => {});
    const before = await read();
    await cdp.evalJs('(() => { globalThis.__kojoMemSanity = new Array(20000000).fill(1.5); return true; })()', 60000);
    const peak = await read();
    await cdp.evalJs('(() => { globalThis.__kojoMemSanity = null; return true; })()', 60000);
    return { before, peak, deltaMB: before == null || peak == null ? null : MB(peak - before) };
  } finally {
    cdp.close();
  }
}

/**
 * 堆快照——**唯一可信的壳内口径**（PITFALLS 256）。两个必须的写法：
 * ① `takeHeapSnapshot` 会超过 `Cdp.send` 的 30s 固定超时 ⇒ 故意吞掉超时，改等
 *    `reportHeapSnapshotProgress` 的 `finished`；
 * ② 快照 500 MB+ 超过 V8 单串上限（0x1fffffe8）⇒ **不能 `chunks.join('')`**，必须逐块写流。
 */
async function takeSnapshot(wsUrl, out) {
  const cdp = new Cdp(wsUrl);
  await cdp.connect();
  await cdp.send('HeapProfiler.enable');
  const ws = fs.createWriteStream(out);
  let bytes = 0;
  let chunks = 0;
  let finished = false;
  cdp.on('HeapProfiler.addHeapSnapshotChunk', (p) => {
    chunks++;
    bytes += p.chunk.length;
    ws.write(p.chunk);
  });
  cdp.on('HeapProfiler.reportHeapSnapshotProgress', (p) => {
    if (p.finished) finished = true;
  });
  const startedAt = Date.now();
  cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: true }).catch(() => {});
  for (let i = 0; i < 600 && !finished; i++) await sleep(500);
  await new Promise((r) => ws.end(r));
  cdp.close();
  return { out, bytesMB: MB(bytes), chunks, seconds: Math.round((Date.now() - startedAt) / 100) / 10, finished };
}

/** 快照按类型聚合：流式扫 `nodes` 数字（不整体 JSON.parse——500 MB 文件解析会吃掉几 GB） */
function aggregateSnapshot(file) {
  const headFd = fs.openSync(file, 'r');
  const headBuf = Buffer.alloc(262144);
  fs.readSync(headFd, headBuf, 0, headBuf.length, 0);
  fs.closeSync(headFd);
  const head = headBuf.toString('utf8');
  const nfM = /"node_fields":\s*\[([^\]]*)\]/.exec(head);
  const ntM = /"node_types":\s*\[(\[[^\]]*\][^\]]*)\]/.exec(head);
  if (!nfM || !ntM) return { error: '快照 meta 解析失败' };
  const fields = JSON.parse('[' + nfM[1] + ']');
  const types = JSON.parse('[' + ntM[1] + ']');
  const iType = fields.indexOf('type');
  const iSelf = fields.indexOf('self_size');
  const stride = fields.length;
  const typeNames = types[iType];

  const fd = fs.openSync(file, 'r');
  const CH = 1 << 25;
  const buf = Buffer.alloc(CH);
  const byType = new Map();
  const byCount = new Map();
  let pos = 0;
  let started = false;
  let done = false;
  let idx = 0;
  let num = 0;
  let inNum = false;
  let curType = -1;
  let total = 0;
  let count = 0;
  let read;
  while (!done && (read = fs.readSync(fd, buf, 0, CH, pos)) > 0) {
    const s = buf.toString('utf8', 0, read);
    let i = 0;
    if (!started) {
      const k = s.indexOf('"nodes":[');
      if (k < 0) {
        pos += Math.max(0, read - 32);
        continue;
      }
      i = k + 9;
      started = true;
    }
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 48 && c <= 57) {
        num = num * 10 + (c - 48);
        inNum = true;
        continue;
      }
      if (c === 44 || c === 93) {
        if (inNum) {
          const slot = idx % stride;
          if (slot === iType) curType = num;
          else if (slot === iSelf) {
            total += num;
            count++;
            const t = typeNames[curType] ?? 'type#' + curType;
            byType.set(t, (byType.get(t) || 0) + num);
            byCount.set(t, (byCount.get(t) || 0) + 1);
          }
          idx++;
          num = 0;
          inNum = false;
        }
        if (c === 93) {
          done = true;
          break;
        }
      }
    }
    pos += read;
  }
  fs.closeSync(fd);
  const list = [...byType]
    .sort((a, b) => b[1] - a[1])
    .map(([type, bytes]) => ({ type, mb: MB(bytes), count: byCount.get(type) ?? 0 }));
  return { totalMB: MB(total), nodes: count, byType: list };
}

const session = readSession();

// 离线重算：给一份已落的快照，不连壳也能聚合（事后复算 / 对比两份快照用）
const AGGREGATE_FILE = val('--aggregate', null);
if (AGGREGATE_FILE) {
  const heap = aggregateSnapshot(AGGREGATE_FILE);
  if (AS_JSON) console.log(JSON.stringify(heap, null, 2));
  else if (heap.error) console.log(`[mem-shell] 聚合失败：${heap.error}`);
  else {
    console.log(`[mem-shell] ${AGGREGATE_FILE}：页面堆合计 ${heap.totalMB} MB / ${heap.nodes} 个节点`);
    for (const row of heap.byType.slice(0, 12)) {
      console.log(`    ${String(row.mb).padStart(8)} MB  ${String(row.count).padStart(8)} 个  ${row.type}`);
    }
  }
  process.exit(0);
}

const cdpPort = Number(val('--cdp', session?.cdpPort ?? 0)) || null;
const rootPid = Number(val('--pid', session?.shellPid ?? 0)) || null;

const report = { session: session?.file ?? null, cdpPort, rootPid, ps: null, targets: [], totals: {} };

if (rootPid) {
  report.ps = processTree(rootPid);
}

if (!PS_ONLY && cdpPort) {
  try {
    const list = await targets(cdpPort);
    for (const t of list) {
      const h = await heapOf(t.webSocketDebuggerUrl).catch((err) => ({ error: String(err?.message ?? err) }));
      report.targets.push({
        type: t.type,
        url: String(t.url ?? ''),
        title: String(t.title ?? ''),
        usedMB: h.used == null ? null : MB(h.used),
        totalMB: h.total == null ? null : MB(h.total),
        nodes: h.nodes ?? null,
        error: h.error ?? null,
      });
    }
    // 量具自检只在页面上跑（worker 里分配 160 MB 会扰动被测状态本身）
    const page = list.find((t) => t.type === 'page');
    if (page && has('--sanity')) {
      report.sanity = await sanity(page.webSocketDebuggerUrl).catch((err) => ({ error: String(err?.message ?? err) }));
    }
    if (page && SNAPSHOT_OUT) {
      report.snapshot = await takeSnapshot(page.webSocketDebuggerUrl, SNAPSHOT_OUT).catch((err) => ({
        error: String(err?.message ?? err),
      }));
      if (report.snapshot && !report.snapshot.error) report.snapshot.heap = aggregateSnapshot(SNAPSHOT_OUT);
    }
  } catch (err) {
    report.targetsError = String(err?.message ?? err);
  }
  const v8Used = report.targets.reduce((a, t) => a + (t.usedMB ?? 0), 0);
  const v8Total = report.targets.reduce((a, t) => a + (t.totalMB ?? 0), 0);
  report.totals.v8UsedMB = Math.round(v8Used * 10) / 10;
  report.totals.v8TotalMB = Math.round(v8Total * 10) / 10;
}
if (report.ps && !report.ps.error) {
  report.totals.wsMB = MB(report.ps.totalWs);
  report.totals.privateMB = MB(report.ps.totalPriv);
  report.totals.procCount = report.ps.procs.length;
  report.totals.appWsMB = MB(report.ps.app.ws);
  report.totals.appPrivateMB = MB(report.ps.app.priv);
  report.totals.appProcCount = report.ps.app.count;
  report.totals.toolWsMB = MB(report.ps.tool.ws);
}

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[mem-shell] 会话 ${report.session ?? '（未发现）'}  CDP :${cdpPort ?? '-'}  shellPid ${rootPid ?? '-'}`);
  if (report.ps?.error) console.log(`[mem-shell] 进程树取数失败：${report.ps.error}`);
  if (report.ps && !report.ps.error) {
    console.log(
      `[mem-shell] 进程树 ${report.totals.procCount} 个：工作集 ${report.totals.wsMB} MB / 私有 ${report.totals.privateMB} MB`,
    );
    console.log(
      `[mem-shell]   ├ 应用 ${report.totals.appProcCount} 个（kojo-editor + msedgewebview2）：工作集 ${report.totals.appWsMB} MB / 私有 ${report.totals.appPrivateMB} MB`,
    );
    console.log(`[mem-shell]   └ 工具链 ${report.totals.toolWsMB} MB（vite / esbuild / cargo，不算编辑器占用）`);
    for (const p of report.ps.procs.slice(0, 12)) {
      const tag = p.kind === 'app' ? '应用' : '工具';
      console.log(
        `    ${String(MB(p.workingSet)).padStart(7)} MB ws  ${String(MB(p.privateBytes)).padStart(7)} MB priv  ${tag}  ${p.name} (${p.pid})`,
      );
    }
  }
  if (report.targetsError) console.log(`[mem-shell] CDP target 枚举失败：${report.targetsError}`);
  for (const t of report.targets) {
    const label = t.type === 'page' ? '页面' : t.type === 'worker' ? 'worker' : t.type;
    console.log(
      `    ${String(t.usedMB ?? '-').padStart(7)} MB used  ${String(t.totalMB ?? '-').padStart(7)} MB total  ${label}  ${t.url.slice(0, 90)}${t.error ? `  ⚠ ${t.error}` : ''}`,
    );
  }
  if (report.totals.v8UsedMB != null) {
    console.log(`[mem-shell] V8 合计 ${report.totals.v8UsedMB} MB used / ${report.totals.v8TotalMB} MB total`);
  }
  if (report.sanity) {
    if (report.sanity.error) console.log(`[mem-shell] 量具自检失败：${report.sanity.error}`);
    else {
      const ok = report.sanity.deltaMB != null && report.sanity.deltaMB >= 100;
      console.log(
        `[mem-shell] 量具自检 ${ok ? '✅' : '❌'}：页内分配 160 MB 数组后读数 ${report.sanity.before == null ? '?' : MB(report.sanity.before)} → ${report.sanity.peak == null ? '?' : MB(report.sanity.peak)} MB（Δ ${report.sanity.deltaMB} MB）`,
      );
    }
  }
  if (report.snapshot) {
    if (report.snapshot.error) console.log(`[mem-shell] 堆快照失败：${report.snapshot.error}`);
    else {
      const h = report.snapshot.heap;
      console.log(
        `[mem-shell] 堆快照 ${report.snapshot.out}（${report.snapshot.bytesMB} MB JSON，${report.snapshot.seconds}s）${h?.error ? ` ⚠ ${h.error}` : ''}`,
      );
      if (h && !h.error) {
        console.log(`[mem-shell]   页面堆合计 ${h.totalMB} MB / ${h.nodes} 个节点`);
        for (const row of h.byType.slice(0, 8)) {
          console.log(`    ${String(row.mb).padStart(8)} MB  ${String(row.count).padStart(8)} 个  ${row.type}`);
        }
      }
    }
  }
}
process.exit(0);
