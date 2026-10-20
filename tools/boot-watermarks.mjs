#!/usr/bin/env node
/**
 * 开项目水位量测器（PERF-1 首屏批的姊妹工具；PERF-8 的「改前 / 改后」就量这一组数）。
 *
 * 量的是**用户体感的等待**：从页内点击「最近打开的项目」那一刻起，用页内 `performance.now`
 * 逐里程碑打点——欢迎页让位 / 文件树首项 / **点开首棵文件 → Monaco 挂载**（自点文件、
 * 自点项目两个口径）/ 三段 `cascade.projectOpened→…` 水位 / `boot.*` 四标记。
 *
 * 两条纪律（都是实测踩出来的，PITFALLS 74）：
 *   1. **打点全在页内**。node 侧轮询 `__kojoPerf` 会把 CDP 往返（级联占线时单趟 229–762ms）
 *      算进用户等待：同一轮冷开量出过「index可用 27.7s」而页内标记只有 0.84s 的假水位。
 *      本工具装一具页内 `setInterval` 打点器，node 只等结束条件、最后一次性读回。
 *   2. 文件树默认收起 ⇒ `.tree-file` 要展开后才存在，死等它会把 28.8s 量成 237s；
 *      故打点器自己补一步「**没有** `.tree-file` 才点 `.tree-group-btn`」（§71 收起陷阱同款）。
 *
 * 用法：node tools/boot-watermarks.mjs [项目目录]
 *   项目目录缺省走 `tools/corpus.mjs` 的解析链（`--corpus` > `KOJO_CORPUS_DIR` > 扫盘）；
 *   语料不在默认扫描根时设 `KOJO_CORPUS_SCAN_DIRS=<扫描根>`。冷/热各一轮（第二轮 = reload 后重开）。
 * 前置：**目标 vite 端口**与 9222 空闲（目标端口由 `smoke-lib.mjs` 的 `devTarget` 解析：
 *   `tauri.conf.json` devUrl ⇔ `vite.config.ts` port，当前配置 1420；`KOJO_SMOKE_VITE_PORT`
 *   可换端口。被占 ⇒ **exit 2**，别去抢清端口，§70）；机器空闲（与全量测试 / cargo
 *   构建并发时页内长任务被抢 CPU，量出来的等待会虚高）。
 * 纪律：`recent-projects.json` 先备份后还原；WebView2 用本工具自有的新鲜隔离画像（跑完删）；
 *   **只杀自己 spawn 的进程树与自己的 9222 持有者，绝不按镜像名 taskkill**。
 * 退出码：0 = 两轮都量到；1 = 有轮次没量到（读数照打，不静默）。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { devTarget, portBusy, recentRowFinderSrc, recentRowWaitSrc } from './smoke-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDP = 9222;
/** 本次起的 dev 端口（`devTarget` 只读配置 + 可选临时 JSON，不起任何进程）；解析失败 ⇒ 退避 */
let dev;
try {
  dev = devTarget(ROOT);
} catch (e) {
  console.log('[wm] dev 地址解析失败：' + (e && e.message ? e.message : e));
  process.exit(2);
}
const WV2 = path.join(os.tmpdir(), `kojo-boot-wm-${Date.now()}-webview2`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

function portOpen(p) {
  return new Promise((res) => {
    const tryOne = (host) => new Promise((r2) => { const s = net.connect(p, host); s.setTimeout(800); s.on('connect', () => { r2(true); s.destroy(); }); s.on('error', () => r2(false)); s.on('timeout', () => { r2(false); s.destroy(); }); });
    Promise.race([tryOne('127.0.0.1'), tryOne('::1').then((v) => v || tryOne('127.0.0.1'))]).then(res);
  });
}
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pend = new Map(); this.logs = []; }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws error')); });
    this.ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id && this.pend.has(m.id)) { const p = this.pend.get(m.id); this.pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      else if (m.method === 'Runtime.consoleAPICalled') {
        const t = (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200);
        this.logs.push({ at: Date.now(), t });
      }
    };
    await this.send('Runtime.enable');
  }
  send(method, params = {}) {
    return new Promise((res, rej) => { const i = ++this.id; this.pend.set(i, { res, rej }); this.ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('timeout ' + method)); } }, 30000); });
  }
  async ev(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result?.value;
  }
  close() { try { this.ws?.close(); } catch {} }
}

/** 项目目录：位置参数 > `tools/corpus.mjs` 解析链（认内容不认名，语料路径不落仓库） */
const EXPLICIT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
let CORPUS = EXPLICIT;
if (!CORPUS) {
  const corp = spawnSync('node tools/corpus.mjs --print', { cwd: ROOT, shell: true, encoding: 'utf8' });
  if (corp.status !== 0) {
    console.log('[wm] 项目目录解析失败（给个位置参数，或设 KOJO_CORPUS_DIR / KOJO_CORPUS_SCAN_DIRS）：' + (corp.stdout || '') + (corp.stderr || ''));
    process.exit(2);
  }
  CORPUS = (corp.stdout || '').trim().split(/\r?\n/).pop();
}
if (!fs.existsSync(CORPUS)) { console.log(`[wm] 项目目录不存在：${CORPUS}`); process.exit(2); }
console.log(`[wm] 项目目录 = ${CORPUS}${EXPLICIT ? '（显式指定）' : '（corpus.mjs 解析）'}`);

const storeDir = path.join(os.homedir(), 'AppData', 'Roaming', 'dev.kojo.editor', 'store', '_global');
const recentFile = path.join(storeDir, 'recent-projects.json');
const recentBackup = fs.existsSync(recentFile) ? fs.readFileSync(recentFile) : null;
{
  let list = [];
  try { list = JSON.parse(recentBackup?.toString('utf-8') ?? '[]'); } catch {}
  const key = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();
  list = list.filter((r) => key(r.rootDir) !== key(CORPUS));
  list.unshift({ rootDir: CORPUS, adapterId: 'eratw', openedAt: new Date().toISOString() });
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(recentFile, JSON.stringify(list));
}
/* 前置闸：**目标** vite 端口与 9222 都试两个地址族（只挂 `[::1]` 的 vite 本机实测存在；
   devUrl 写 localhost 时 WebView2 会 IPv6 优先 ⇒ 只看 127.0.0.1 会放行并量到别人的 dev server） */
if (await portBusy(CDP) || await portBusy(dev.port)) { console.log(`[wm] ${dev.port}/${CDP} 被占`); try { if (recentBackup === null) fs.rmSync(recentFile, { force: true }); else fs.writeFileSync(recentFile, recentBackup); } catch {} process.exit(2); }
try { fs.rmSync(WV2, { recursive: true, force: true }); } catch {}

const devCmd = ['pnpm --filter @kojo/app tauri dev', ...dev.tauriArgs.map((a) => `"${a}"`)].join(' ');
const child = spawn(devCmd, {
  cwd: ROOT, shell: true,
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP}`, WEBVIEW2_USER_DATA_FOLDER: WV2 },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
let exited = false; child.on('exit', () => { exited = true; });
function cleanup() {
  try { dev.cleanup(); } catch {}
  try { if (child.pid) spawnSync(`taskkill /PID ${child.pid} /T /F`, { shell: true, stdio: 'ignore' }); } catch {}
  try {
    const ns = spawnSync('netstat -ano', { shell: true, encoding: 'utf8' }).stdout ?? '';
    for (const line of ns.split('\n')) {
      if (!/LISTENING/i.test(line) || !/[:.]9222\s/.test(line)) continue;
      const pid = line.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid) && Number(pid) !== process.pid) spawnSync(`taskkill /PID ${pid} /T /F`, { shell: true, stdio: 'ignore' });
    }
  } catch {}
  try { if (recentBackup === null) fs.rmSync(recentFile, { force: true }); else fs.writeFileSync(recentFile, recentBackup); } catch {}
  try { fs.rmSync(WV2, { recursive: true, force: true }); } catch {}
}
const t0 = Date.now();
let url = null;
while (Date.now() - t0 < 900000 && !url && !exited) {
  await sleep(2000);
  if (!(await portOpen(CDP))) continue;
  try { const l = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); const p = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (p) url = p.webSocketDebuggerUrl; } catch {}
}
if (!url) { console.log('[wm] CDP 未就绪：' + strip(out).slice(-800)); cleanup(); process.exit(1); }
const cdp = new Cdp(url);
await cdp.open();
console.log('[wm] CDP 就绪 +' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

/**
 * 页内打点：点项目 → 欢迎页让位后**先展开第一组**（默认收起，`.tree-file` 此时不存在）
 * → 首棵文件出现即点 → Monaco 挂载。全部时间戳取 performance.now，零 CDP 往返误差。
 */
const INSTALL = () => `(() => {
  const T = { milestones: {}, perf: {}, clickAt: null, fileClickAt: null };
  window.__kojoTrace = T;
  const rec = (k, base) => { if (T.milestones[k] === undefined) T.milestones[k] = Math.round(performance.now() - base); };
  const b = ${recentRowFinderSrc(JSON.stringify(CORPUS))};
  if (!b) return 'no-recent-button';
  T.clickAt = performance.now();
  b.click();
  let expanded = false, fileClicked = false;
  const timer = setInterval(() => {
    if (!document.querySelector('.welcome')) {
      rec('欢迎页让位', T.clickAt);
      if (!expanded && !document.querySelector('.tree-file')) { const g = document.querySelector('.tree-group-btn'); if (g) { g.click(); expanded = true; } }
    }
    const f = document.querySelector('.tree-file');
    if (f && !fileClicked) { rec('文件树首项', T.clickAt); T.fileClickAt = performance.now(); f.click(); fileClicked = true; }
    if (document.querySelector('.editor-body .monaco-editor') && T.fileClickAt) {
      rec('Monaco 挂载（自点文件）', T.fileClickAt);
      rec('Monaco 挂载（自点项目）', T.clickAt);
    }
    const m = document.querySelector('.modal[aria-label=".kojo 预览"]');
    if (m) { const btn = [...m.querySelectorAll('.modal-actions button')].find(e => e.textContent.trim() === '不用'); if (btn) btn.click(); }
    const p = globalThis.__kojoPerf;
    if (p) for (const s of p.stats()) {
      if (T.perf[s.name] === undefined && /cascade\\.|boot\\.|switch\\.|markers\\.|project\\./.test(s.name)) T.perf[s.name] = Number(s.last.toFixed(1));
    }
    for (const n of ['cascade.projectOpened→index可用','cascade.projectOpened→条件可用','cascade.projectOpened→校验有结果'])
      if (T.perf[n] !== undefined) rec(n.replace('cascade.projectOpened→','水位-'), T.clickAt);
  }, 200);
  T.stop = () => clearInterval(timer);
  return 'installed';
})()`;

async function waitRecent() {
  const s = Date.now();
  while (Date.now() - s < 180000) {
    if (await cdp.ev(recentRowWaitSrc(JSON.stringify(CORPUS))).catch(() => false)) return true;
    await sleep(1000);
  }
  return false;
}
async function round(label) {
  if (!await waitRecent()) { console.log(`[wm][${label}] recent 未出现（没量到就是红，不静默）`); return false; }
  const mark = cdp.logs.length;
  if (await cdp.ev(INSTALL()) !== 'installed') { console.log(`[wm][${label}] 打点器装载失败（recent 按钮不在）`); return false; }
  const done = `(() => { const T=window.__kojoTrace; return !!(T.milestones['水位-校验有结果'] !== undefined && T.milestones['Monaco 挂载（自点文件）'] !== undefined); })()`;
  const s = Date.now();
  while (Date.now() - s < 150000) { if (await cdp.ev(done).catch(() => false)) break; await sleep(1200); }
  await sleep(3000);
  // W8-D 归因批：冷轮落盘观察窗。save 是 build 尾部的 `void storage.set(...)`——19MB 信封
  // stringify + 25MB base64 过 IPC + Rust 阻塞线程落盘，整链可长于上面那 3s 观察窗；不等到
  // settle 就 reload / taskkill ⇒ promise 永不 settle ⇒ saved 与 save failed 两类日志都不会
  // 出现，落盘静默丢失（本工具前几批 6 次冷轮 3 次没落盘的成因判别）。冷轮最多再等 20s 收
  // settled 证据；热轮不存盘，不加窗。
  if (/冷/.test(label)) {
    const saveMark = cdp.logs.length;
    for (let i = 0; i < 40; i++) {
      if (cdp.logs.slice(saveMark).some((l) => /Index snapshot (saved|save failed)/.test(l.t))) break;
      await sleep(500);
    }
  }
  const dump = await cdp.ev(`(() => { const T=window.__kojoTrace; T && T.stop && T.stop(); return JSON.stringify({milestones:T.milestones, perf:T.perf}); })()`);
  const parsed = JSON.parse(String(dump ?? '{}'));
  console.log(`\n===== [wm][${label}] 页内里程碑（ms） =====`);
  console.log(JSON.stringify(parsed.milestones, null, 1));
  console.log(`----- [${label}] 页内 perf 标记 ----`);
  console.log(JSON.stringify(parsed.perf, null, 1));
  console.log(`----- [${label}] 加载期日志（产品自带 log.info，本工具不注入任何探针） ----`);
  // 过滤词含 `lint breakdown`/`lint reuse`（12b 的分区复用读数）与 `lint units`（12c 的
  // 懒取/投机候选读数，单独成行——壳侧单行 170 字符，行尾字段会被切没，PITFALLS 86）；
  // `Index`（大写）＝ 索引落盘/收尸/换代自愈一行（`Index snapshot saved/pruned/…`，
  // W8-D 归因批补：小写 `index` 滤词匹配不到大写开头的产品日志，save 失败证据因此整段失踪）；
  // 截断长度取 400。
  for (const l of cdp.logs.slice(mark)) if (/自定名表|追加名表|汉化词典|工程加载完成|Project opened|index|Index|索引|lint breakdown|lint reuse|lint units|Condition index/.test(l.t)) console.log('   ' + l.t.slice(0, 400));
  return !!(parsed.milestones['水位-校验有结果'] !== undefined && parsed.milestones['Monaco 挂载（自点文件）'] !== undefined);
}

const ok1 = await round('R1-冷');
await cdp.ev('location.reload()').catch(() => {});
await sleep(6000);
const ok2 = await round('R2-热');
console.log('\n[wm] done 冷=' + ok1 + ' 热=' + ok2);
cleanup();
cdp.close();
process.exit(ok1 && ok2 ? 0 : 1);
