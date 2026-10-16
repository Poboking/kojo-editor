#!/usr/bin/env node
/**
 * 桌面壳端到端冒烟 · 市场索引面（真实 IPC + 真实面板 + 真实注册表）。
 *
 * 形态照 `smoke-tauri-ipc.mjs`：`pnpm tauri dev` 起**真壳**（真 Rust 命令处理器、真白名单），
 * Node 经 CDP（`Runtime.evaluate`）在 WebView 里点真面板 ⇒ 覆盖的是那条**编译期看不出来**的链路：
 *
 *   面板「拉取列表」→ MarketService.refreshIndex({force:true}) → kernel.remote（桥的透传）
 *   → tauri invoke('market_fetch_text') → Rust guarded_send（协议/白名单/逐跳重核/体积/超时）
 *   → io.writeText 落 <appData>/market/index.json → 面板读回三态并显示数据时间
 *
 * 覆盖项：
 *   f1 白名单外的 URL 经**真 IPC** 也被拒（命令面没被绕过）
 *   f2 白名单内的真实索引经**真 IPC** 取回 = 200 / 钉数字节
 *   g  面板点「拉取列表」⇒ index.json 落盘、schema 合规、条目逐字对平
 *   h  匿名读回的 index 与本地落盘内容**逐字节**对平（含 sha256 锚）
 *   i  面板屏上给出「已拉取」人话 + 数据时间行 + 条目数（不是静默成功）
 *   j  盘上那份的坏条目会重新报进 dropped（镜像不洗盘）——只在注册表当前有坏条目时才判，
 *      现在没有 ⇒ 明确 SKIP（不假装绿）
 *   k  **真装一个包再卸掉**：面板点「安装」⇒ 真下载 + 真解压 + 真落盘 + 真记账 ⇒
 *      屏上「已安装」+ 盘上逐条目对平 + 记账容器核对码对平 ⇒ 点「卸载」确认 ⇒ 目录消失、零残壳。
 *      容器落在 github.com（本机直连必超时）⇒ **不带代理时这一项报 SKIP 并打印复跑命令**，不算过。
 *
 * 用法：node tools/smoke-tauri-market.mjs [游戏目录]
 *   k 项要真出网取容器 ⇒ 复跑口径：`HTTPS_PROXY=http://127.0.0.1:7890 node tools/smoke-tauri-market.mjs`
 *   （代理只走**进程环境**：Rust 两条市场命令的签名里都没有 proxy 参数，也不许加——受众绝大部分没有代理。
 *   父进程 env 会透传给 `pnpm tauri dev`，reqwest 的 system-proxy 读的就是这几个变量。）
 *   目录优先级 = 位置参数 > KOJO_SMOKE_PROJECT > KOJO_CORPUS_DIR > 按内容自动发现（tools/corpus.mjs）。
 *   **为什么要点开一个项目**：壳只在 `phase==='project'` 时渲染 ShellLayout（工具条 / 副侧栏 / 面板），
 *   没有项目就没有面板可点（`packages/app/src/ui/App.tsx` 的 body 分支）——这不是本工具的选择，是壳的形态。
 * 退出码：0 = 全 PASS（SKIP 不算失败）；1 = 有 FAIL；2 = 前置条件不满足（语料不在位 / 端口被占）。
 * 会弹出应用窗口（结束自动关闭）；会临时备份/还原 <appData>/market/index.json 与 store 的两个文件。
 *
 * ⚠ 一台机器同一个工作树**只许一个桌面实例**：本工具与 `smoke-tauri-ipc.mjs` 不能同时跑
 *   （Vite 1420 端口互斥，工具开头就检查，占着就 rc=2 明确失败）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveCorpusDir, discoverCorpora, corpusHint } from './corpus.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDP_PORT = 9223;
/** 默认注册表端点（与契约 `MARKET_DEFAULT_INDEX_URL` 同值；本工具按字面读线上资产，不引 TS 源码） */
const INDEX_URL = 'https://poboking.github.io/kojo-market/index.json';
/** 锚点读数（2026-10-15 复算；`packs` = 2 条 —— 不是 3，见 h 项的逐条目对平） */
const ANCHOR_BYTES = 1586;
const ANCHOR_SHA256 = 'ced50706262e26b4d203d7f280e5da3309f3faf887746411d5dc663476716bfa';
const ANCHOR_PACKS = [
  ['dict-pack', 'demo.dict', '1.0.0', 1, 77],
  ['kojo-pack', 'demo.era-tw', '1.0.1', 1, 471],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.setTimeout(1500);
    s.on('connect', () => { resolve(true); s.destroy(); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { resolve(false); s.destroy(); });
  });
}

/* ---------------------------- CDP 客户端（照 smoke-tauri-ipc.mjs） ---------------------------- */

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('cdp ws error'));
    });
    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p(msg); }
    };
    return this;
  }
  send(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`cdp ${method} timeout`)); }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`cdp ${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalJs(expression, timeoutMs = 90000) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'unknown';
      throw new Error(`evalJs exception: ${String(desc).slice(0, 400)}`);
    }
    return r.result?.value;
  }
  close() { try { this.ws?.close(); } catch {} }
}

const results = [];
function rec(id, name, status, detail) {
  results.push({ id, name, status, detail });
  console.log(`[${status}] ${id} ${name} — ${detail}`);
}
const P = (id, name, detail) => rec(id, name, 'PASS', detail);
const F = (id, name, detail) => rec(id, name, 'FAIL', detail);
const S = (id, name, detail) => rec(id, name, 'SKIP', detail);

async function waitFor(cdp, expr, timeoutMs = 60000, intervalMs = 700) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try { last = await cdp.evalJs(expr, 15000); if (last) return last; } catch (e) { last = String(e); }
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timeout (${timeoutMs}ms): ${expr} last=${JSON.stringify(last)}`);
}

const INV = `(cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args ?? {})`;

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  // 面板住在 ShellLayout 里 ⇒ 必须先**打开一个项目**（壳在无项目时只渲染 WelcomeView，没有任何面板可点）。
  // 因此本工具与 smoke-tauri-ipc.mjs 一样依赖语料在位；不在位就 rc=2 明确失败，不拿"跑不了"冒充"跑过了"。
  const explicit = process.argv[2] ?? process.env.KOJO_SMOKE_PROJECT;
  const gameDir = explicit
    ? path.resolve(explicit)
    : (() => {
        try { return resolveCorpusDir({ label: 'market' }) ?? ''; } catch (e) { console.error(`❌ ${e.message}`); process.exit(2); }
      })();
  if (!fs.existsSync(gameDir)) {
    const hits = discoverCorpora({});
    console.error(`❌ 游戏目录不存在：${gameDir || '（未发现任何符合内容条件的语料目录）'}\n`
      + `   盘上候选: ${hits.length ? hits.map((h) => h.dir).join('，') : '无（需 ERB/ 与 CSV/）'}\n`
      + `   用法：node tools/smoke-tauri-market.mjs "<本机真实 eraTW 根目录>"；或 ${corpusHint()}`);
    process.exit(2);
  }
  console.log(`[market-smoke] 项目目录 = ${gameDir}${explicit ? '（显式指定）' : '（按内容自动发现）'}`);

  const storeDir = path.join(os.homedir(), 'AppData', 'Roaming', 'dev.kojo.editor', 'store', '_global');
  const recentFile = path.join(storeDir, 'recent-projects.json');
  const approvedFile = path.join(storeDir, 'approved-writable.json');
  let recentBackup = null;
  let approvedBackup = null;
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    recentBackup = fs.existsSync(recentFile) ? fs.readFileSync(recentFile) : null;
    approvedBackup = fs.existsSync(approvedFile) ? fs.readFileSync(approvedFile) : null;
    let list = [];
    try { list = JSON.parse(recentBackup?.toString('utf-8') ?? '[]'); if (!Array.isArray(list)) list = []; } catch { list = []; }
    const filtered = list.filter((r) => r?.rootDir !== gameDir);
    filtered.unshift({ rootDir: gameDir, adapterId: 'eratw', lastOpenedAt: Date.now() });
    fs.writeFileSync(recentFile, JSON.stringify(filtered));
  } catch (e) {
    console.error(`❌ 播种 recent-projects 失败（起不了壳的前置）：${String(e)}`);
    process.exit(2);
  }
  const restoreStore = () => {
    try {
      if (recentBackup === null) fs.rmSync(recentFile, { force: true }); else fs.writeFileSync(recentFile, recentBackup);
      if (approvedBackup === null) fs.rmSync(approvedFile, { force: true }); else fs.writeFileSync(approvedFile, approvedBackup);
      console.log('[market-smoke] store（recent + approved-writable）已还原');
    } catch (e) { console.log('[market-smoke] store 还原失败:', String(e)); }
  };

  const startedAt = Date.now();
  const busy = (await portOpen(1420)) || (await portOpen(CDP_PORT));
  if (busy) {
    console.error('❌ 1420 或 CDP 端口已被占用（同一工作树只许一个桌面实例）。先关掉在跑的 tauri dev / 其它冒烟再试。');
    restoreStore();
    process.exit(2);
  }

  console.log('[market-smoke] launching tauri dev (CDP %d) …', CDP_PORT);
  const child = spawn('pnpm --filter @kojo/app tauri dev', {
    shell: true,
    cwd: ROOT,
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));
  let exited = false;
  child.on('exit', (code) => { exited = true; output += `\n[smoke] child exited ${code}`; });

  const killTree = () => {
    cdp?.close();
    if (!exited && child.pid) {
      try { spawnSync(`taskkill /PID ${child.pid} /T /F`, { shell: true, stdio: 'ignore' }); } catch {}
    }
  };

  let cdp = null;
  let indexPath = null;
  let indexBackup = null; // Buffer | null（null = 本机原本没有这份）
  let indexSeen = false;
  /* 装包那一项会落 `packs/` 与记账 ⇒ 跑完必须回到跑前状态（重复跑同结果） */
  const K_TARGET = { kind: 'kojo-pack', id: 'demo.era-tw', version: '1.0.1' };
  const K_CONTAINER_SHA = 'bf0bfd9f321666ba60ee6f12a03cfd64f709658121c300f4b09454d40dc7aef2';
  let kTargetDir = null;
  let kRecordsPath = null;
  let kRecordsBackup = null;
  let kTargetExistedBefore = false;

  try {
    let wsUrl = null;
    const waitStart = Date.now();
    while (Date.now() - waitStart < 240000) {
      if (exited) throw new Error(`tauri dev exited early:\n${stripAnsi(output).slice(-2000)}`);
      if (!wsUrl && (await portOpen(CDP_PORT))) {
        try {
          const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
          const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          if (page) wsUrl = page.webSocketDebuggerUrl;
        } catch {}
      }
      if (wsUrl) {
        try {
          const cand = await new Cdp(wsUrl).connect();
          if (await waitFor(cand, 'document.body && document.body.innerText.includes("kojo-editor")', 120000)) { cdp = cand; break; }
          cand.close();
        } catch {}
      }
      await sleep(1500);
    }
    if (!cdp) throw new Error('CDP page never became ready');
    console.log('[market-smoke] page ready ✓');

    /* -------- 打开项目（只为拿到壳的面板层；市场链路本身不读游戏目录） -------- */
    await waitFor(cdp, `[...document.querySelectorAll('.recent button.link .recent-dir')].some(e => e.textContent === ${JSON.stringify(gameDir)})`, 40000);
    const clicked = await cdp.evalJs(`(() => {
      const b = [...document.querySelectorAll('.recent button.link')].find(
        (el) => el.querySelector('.recent-dir')?.textContent === ${JSON.stringify(gameDir)});
      if (!b) return 'no-button';
      b.click();
      return 'clicked';
    })()`);
    if (clicked !== 'clicked') throw new Error(`recent project click failed: ${clicked}`);
    await waitFor(cdp, '!!document.querySelector(".toolbar")', 150000);
    await sleep(1500);
    if (await cdp.evalJs('!!document.querySelector(".modal")')) {
      await cdp.evalJs(`(() => {
        const b = [...document.querySelectorAll('.modal-actions button')].find((e) => e.textContent.includes('允许写入'));
        if (b) b.click();
        return b ? 'approved' : 'no-allow-button';
      })()`);
      await waitFor(cdp, '!document.querySelector(".modal")', 20000);
    }
    // 不等索引跑完（市场链路不吃索引；等了只是白等一趟语料扫描）
    P('p0', '打开项目（拿壳的面板层）', `工具条已渲染：${await cdp.evalJs('document.querySelector(".tb-project")?.title ?? ""')}`);

    /* -------- 备份本机那份 index.json（跑完原样还回去） -------- */
    const appData = await cdp.evalJs(`(${INV})('app_data_dir')`);
    indexPath = path.join(appData, 'market', 'index.json');
    indexBackup = fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : null;
    indexSeen = indexBackup !== null;
    console.log(`[market-smoke] appDataDir=${appData} index=${path.basename(indexPath)} 备份=${indexBackup ? `${indexBackup.length} B` : '本机原本没有'}`);
    kTargetDir = path.join(appData, 'market', 'packs', K_TARGET.kind, K_TARGET.id, K_TARGET.version);
    kRecordsPath = path.join(appData, 'store', 'kojo-market', 'installed.json');
    kRecordsBackup = fs.existsSync(kRecordsPath) ? fs.readFileSync(kRecordsPath) : null;
    kTargetExistedBefore = fs.existsSync(kTargetDir);
    console.log(`[market-smoke] 安装态备份：目标包${kTargetExistedBefore ? '已在本机（跑完不动它）' : '原本没有'} · 记账${kRecordsBackup ? ` ${kRecordsBackup.length} B` : '原本没有'}`);

    /* -------- f1) 白名单外的 URL 经真 IPC 也被拒 -------- */
    for (const bad of ['http://poboking.github.io/kojo-market/index.json', 'https://evil.example.com/index.json']) {
      const r = await cdp.evalJs(`(async () => {
        try { const v = await (${INV})('market_fetch_text', { url: ${JSON.stringify(bad)}, timeoutMs: 5000, maxBytes: 65536 }); return { ok: true, v }; }
        catch (e) { return { ok: false, err: String(e) }; }
      })()`);
      if (r.ok) F('f1', '白名单外 URL 经真 IPC 被拒', `竟然放行：${bad} → ${JSON.stringify(r.v).slice(0, 80)}`);
      else if (!/拒绝/.test(r.err)) F('f1', '白名单外 URL 经真 IPC 被拒', `拒了但文案不含「拒绝」：${r.err.slice(0, 120)}`);
      else P('f1', `白名单外 URL 经真 IPC 被拒（${bad.slice(0, 28)}…）`, r.err.slice(0, 90));
    }

    /* -------- f2) 白名单内的真实索引经真 IPC 取回（同一份判定、同一条链路） -------- */
    const f2 = await cdp.evalJs(`(async () => {
      try {
        const v = await (${INV})('market_fetch_text', { url: ${JSON.stringify(INDEX_URL)}, timeoutMs: 15000, maxBytes: 524288 });
        return { ok: true, v };
      } catch (e) { return { ok: false, err: String(e) }; }
    })()`);
    if (!f2.ok) F('f2', '真 IPC 取回线上索引', `market_fetch_text 失败：${f2.err}`);
    else {
      const v = f2.v;
      const bytes = Buffer.byteLength(v.text, 'utf8');
      if (v.status === 200 && v.bytes === ANCHOR_BYTES && bytes === ANCHOR_BYTES && sha256(Buffer.from(v.text, 'utf8')) === ANCHOR_SHA256) {
        P('f2', '真 IPC 取回线上索引', `status=200 bytes=${v.bytes} sha256=${ANCHOR_SHA256.slice(0, 12)}… finalUrl=${v.finalUrl}`);
      } else {
        F('f2', '真 IPC 取回线上索引', `status=${v.status} 声明=${v.bytes} 实读=${bytes} sha=${sha256(Buffer.from(v.text, 'utf8')).slice(0, 12)}（钉数 ${ANCHOR_BYTES} / ${ANCHOR_SHA256.slice(0, 12)}…）`);
      }
    }

    /* -------- g) 走**面板**：开副侧栏 → 点「口上市场」→ 点「拉取列表」（force 回源） -------- */
    const auxState = await cdp.evalJs(`(() => {
      const b = [...document.querySelectorAll('.toolbar button.toolbar-btn')].find((e) => (e.title ?? '').includes('切换副侧栏'));
      if (!b) return 'no-button';
      if (!b.classList.contains('on')) b.click();
      return b.classList.contains('on') ? 'already-open' : 'opened';
    })()`);
    console.log(`[market-smoke] 副侧栏：${auxState}`);
    await waitFor(cdp, `!!document.querySelector('.aux .panel-tabs')`, 30000);
    const tabClicked = await cdp.evalJs(`(() => {
      const t = [...document.querySelectorAll('.aux .panel-tabs .panel-tab')].find((e) => e.textContent.trim() === '口上市场');
      if (!t) return 'no-market-tab';
      t.click();
      return 'clicked';
    })()`);
    if (tabClicked !== 'clicked') throw new Error(`market tab click failed: ${tabClicked}`);
    await waitFor(cdp, `!!document.querySelector('.panel-market')`, 30000);

    // 面板首帧 busy=true（拉取期文案是「拉取中…」且按钮禁用）⇒ 禁用态继续等，别把文案窗口当成"没有按钮"
    const pullClicked = await waitFor(
      cdp,
      `(() => {
        const b = [...document.querySelectorAll('.panel-market .mk-toolbar button')].find((e) => e.textContent.includes('拉取'));
        if (!b) return 'no-pull-button';
        if (b.disabled) return null;
        b.click();
        return 'clicked';
      })()`,
      60000,
    );
    if (pullClicked !== 'clicked') throw new Error(`拉取列表 click failed: ${pullClicked}`);

    // 等屏上出现「已拉取注册表列表」（刷新成功的那句人话），顺带把面板状态读回来
    const panel = await waitFor(
      cdp,
      `(() => {
        const note = document.querySelector('.panel-market .mk-note')?.innerText ?? '';
        const time = document.querySelector('.panel-market .mk-time')?.innerText ?? '';
        const status = document.querySelector('.panel-market .mk-status')?.innerText ?? '';
        const dropped = document.querySelector('.panel-market .mk-warn')?.innerText ?? '';
        const rows = document.querySelectorAll('.panel-market .mk-row').length;
        return /已拉取注册表列表/.test(note) ? { note, time, status, dropped, rows } : null;
      })()`,
      60000,
    );

    /* -------- g) 落盘 + schema 合规 + 条目逐字对平 -------- */
    if (!fs.existsSync(indexPath)) F('g', '面板拉取 ⇒ index.json 落盘', `文件不在位：${indexPath}`);
    else {
      const local = fs.readFileSync(indexPath);
      let parsed = null;
      try { parsed = JSON.parse(local.toString('utf8')); } catch (e) { F('g', '面板拉取 ⇒ index.json 落盘', `落盘的不是合法 JSON：${e}`); }
      if (parsed !== null) {
        const rows = (parsed.packs ?? [])
          .map((p) => [p.kind, p.id, p.version, p.fileCount, p.unpackedBytes])
          .sort((a, b) => String(a).localeCompare(String(b)));
        const want = [...ANCHOR_PACKS].sort((a, b) => String(a).localeCompare(String(b)));
        const shapeOk = parsed.schema === 1 && typeof parsed.generatedAt === 'string' && Array.isArray(parsed.packs);
        const rowsOk = JSON.stringify(rows) === JSON.stringify(want);
        if (shapeOk && rowsOk) P('g', '面板拉取 ⇒ index.json 落盘 + schema 合规 + 条目对平', `packs=${parsed.packs.length} generatedAt=${parsed.generatedAt} 条目=${rows.map((r) => r.slice(0, 3).join('/')).join(' ')}`);
        else F('g', '面板拉取 ⇒ index.json 落盘 + schema 合规 + 条目对平', `shape=${shapeOk}（schema=${parsed.schema}）条目不符：${JSON.stringify(rows)} ≠ ${JSON.stringify(want)}`);
      }
      /* -------- h) 匿名读回 ⇔ 本地落盘**逐字节**对平（同一份内容，两个取法） -------- */
      const anon = await (await fetch(INDEX_URL, { cache: 'no-store' })).arrayBuffer();
      const anonBuf = Buffer.from(anon);
      const anonSha = sha256(anonBuf);
      const localSha = sha256(local);
      if (anonBuf.equals(local) && localSha === ANCHOR_SHA256 && anonSha === ANCHOR_SHA256) {
        P('h', '匿名读回与本地落盘逐字节对平', `${local.length} B 同一份；sha256 三方一致 = ${localSha.slice(0, 12)}…（远程 / 盘上 / 钉数）`);
      } else {
        F('h', '匿名读回与本地落盘逐字节对平', `远程 ${anonBuf.length} B / 盘上 ${local.length} B；sha 远程=${anonSha.slice(0, 12)} 盘上=${localSha.slice(0, 12)} 钉数=${ANCHOR_SHA256.slice(0, 12)}`);
      }
      /* -------- i) 面板屏上的事实与盘上一致（不是静默成功） -------- */
      const noteRows = (panel.note.match(/（(\d+) 个包）/) ?? [])[1];
      const timeOk = /数据时间/.test(panel.time) && /拉取/.test(panel.time);
      if (noteRows === String(parsed.packs.length) && timeOk && panel.rows === parsed.packs.length) {
        P('i', '面板给出人话 + 数据时间 + 条目数', `note=「${panel.note}」 time=「${panel.time}」 屏上条目行 ${panel.rows} 行`);
      } else {
        F('i', '面板给出人话 + 数据时间 + 条目数', `note=「${panel.note}」(包数 ${noteRows}) time=「${panel.time}」 行=${panel.rows} 盘上=${parsed.packs.length} status=「${panel.status}」`);
      }
      /* -------- j) 坏条目 ⇒ dropped 出声（注册表当前没有坏条目时明确 SKIP） -------- */
      if (panel.dropped === '') S('j', '坏条目进 dropped 并出声', '线上注册表当前没有坏条目（本地服务侧的判据见 kernel/tests/integration-market.test.ts）');
      else P('j', '坏条目进 dropped 并出声', panel.dropped.slice(0, 120));

      /* -------- k) 真装一个包再卸掉：真下载 + 真解压 + 真落盘 + 真记账 -------- */
      const kClick = await waitFor(
        cdp,
        `(() => {
          const row = [...document.querySelectorAll('.panel-market .mk-group .mk-row')]
            .find((r) => r.innerText.includes('版本 ${K_TARGET.version}'));
          if (!row) return 'no-registry-row';
          const b = [...row.querySelectorAll('button')].find((e) => /安装|更新/.test(e.textContent));
          if (!b) return 'no-action-button';
          if (b.disabled) return null;
          b.click();
          return 'clicked';
        })()`,
        60000,
      );
      if (kClick !== 'clicked') {
        F('k', '真装一个包再卸掉', `注册表行上点不动安装：${kClick}`);
      } else {
        const kOutcome = await waitFor(
          cdp,
          `(() => {
            const note = document.querySelector('.panel-market .mk-note')?.innerText ?? '';
            if (/已装上/.test(note)) return { ok: true, note };
            if (/没有成功|失败|超时|拒绝|不是同一份|要求更新版本|下载/.test(note)) return { ok: false, note };
            return null;
          })()`,
          180000,
        );
        const kHow = '复跑：HTTPS_PROXY=http://127.0.0.1:7890 node tools/smoke-tauri-market.mjs';
        if (!kOutcome.ok) {
          // 容器落在 github.com（本机直连必超时）⇒ 没带代理是"没验过"，不是"过了"
          if (/超时|下载|没有成功|连接|网络/.test(kOutcome.note)) S('k', '真装一个包再卸掉', `未验证：安装没成功（${kOutcome.note}）；${kHow}`);
          else F('k', '真装一个包再卸掉', `安装被拒（${kOutcome.note}）`);
        } else {
          const kProbs = [];
          // 落点里**只有 `files/**`**（`pack.json` 只当校验锚、不搬进落点）⇒
          // 逐文件事实取记账那一份，再逐条与注册表那一行对平、与盘上字节对平。
          let kRec = null;
          try {
            const raw = JSON.parse(fs.readFileSync(kRecordsPath, 'utf8'));
            const arr = Array.isArray(raw) ? raw : (raw?.packs ?? raw?.installed ?? []);
            kRec = arr.find(
              (r) => r?.id === K_TARGET.id && r?.kind === K_TARGET.kind && r?.version === K_TARGET.version,
            ) ?? null;
            if (kRec === null) kProbs.push('记账里没有这一条');
          } catch (e) { kProbs.push(`记账读不出：${String(e).slice(0, 80)}`); }

          const kDeclared = kRec !== null && Array.isArray(kRec.files) ? kRec.files : [];
          if (kRec !== null) {
            if (kRec.containerSha256 !== K_CONTAINER_SHA) {
              kProbs.push(`记账容器核对码 ${kRec.containerSha256 ?? '（没有）'} ≠ 注册表钉的那份`);
            }
            // 与注册表那一行对平（fileCount / unpackedBytes 的权威值由索引锚 sha 保证）
            const kWant = ANCHOR_PACKS.find((a) => a[1] === K_TARGET.id && a[2] === K_TARGET.version);
            if (kWant !== undefined) {
              if (kDeclared.length !== kWant[3]) kProbs.push(`文件数 ${kDeclared.length} ≠ 注册表 ${kWant[3]}`);
              const total = kDeclared.reduce((s, f) => s + Number(f?.bytes ?? -1), 0);
              if (total !== kWant[4]) kProbs.push(`解压总字节 ${total} ≠ 注册表 ${kWant[4]}`);
            }
            for (const f of kDeclared) {
              const p = path.join(kTargetDir, ...String(f.path).split('/'));
              if (!fs.existsSync(p)) { kProbs.push(`落点缺 ${f.path}`); continue; }
              const buf = fs.readFileSync(p);
              if (buf.length !== f.bytes) kProbs.push(`${f.path} 字节 ${buf.length}≠记账 ${f.bytes}`);
              // 工具里算 sha256 是**取证**（node:crypto），不是产品判定路径——产品侧唯一实现点在 kojo-market/src/digest.ts
              if (sha256(buf) !== f.sha256) kProbs.push(`${f.path} sha256 与记账不符`);
            }
          }
          const kStagingDir = path.resolve(kTargetDir, '..', '..', '..', '.staging');
          const kLeft = fs.existsSync(kStagingDir) ? fs.readdirSync(kStagingDir).length : 0;
          if (kLeft !== 0) kProbs.push(`暂存区有 ${kLeft} 条残壳`);

          const kRowSel = `[...document.querySelectorAll('.panel-market .mk-list .mk-row')].find((r) => r.innerText.includes('版本 ${K_TARGET.version}'))`;
          const kReq = await waitFor(
            cdp,
            `(() => {
              const row = ${kRowSel};
              if (!row) return 'no-installed-row';
              const b = [...row.querySelectorAll('button')].find((e) => e.textContent.trim() === '卸载');
              if (!b) return 'no-uninstall-button';
              if (b.disabled) return null;
              b.click();
              return 'requested';
            })()`,
            60000,
          );
          const kConf = kReq !== 'requested'
            ? kReq
            : await waitFor(
                cdp,
                `(() => {
                  const row = ${kRowSel};
                  if (!row) return 'row-gone';
                  const b = [...row.querySelectorAll('button')].find((e) => e.textContent.trim() === '确认');
                  if (!b) return 'no-confirm-button';
                  if (b.disabled) return null;
                  b.click();
                  return 'confirmed';
                })()`,
                60000,
              );
          if (kConf !== 'confirmed' && kConf !== 'row-gone') kProbs.push(`卸载没走完：${kConf}`);
          await sleep(800);
          if (fs.existsSync(kTargetDir)) kProbs.push('卸载后目录还在');
          const kRowGone = await cdp.evalJs(`[...document.querySelectorAll('.panel-market .mk-list .mk-row')].some((r) => r.innerText.includes('版本 ${K_TARGET.version}')) ? 'still-listed' : 'gone'`);
          if (kRowGone !== 'gone') kProbs.push('屏上那条还在');

          if (kProbs.length === 0) {
            P(
              'k',
              '真装一个包再卸掉（真下载+解压+落盘+记账+卸载）',
              `${K_TARGET.id} v${K_TARGET.version}：屏上「${kOutcome.note}」；盘上 ${kDeclared.length} 个条目逐条对平（${kDeclared.map((f) => `${f.path}:${f.bytes}B`).join(' ')}）；记账容器核对码=${K_CONTAINER_SHA.slice(0, 12)}…；卸载后目录与行都已消失、暂存区零残壳`,
            );
          } else {
            F('k', '真装一个包再卸掉（真下载+解压+落盘+记账+卸载）', kProbs.join('；'));
          }
        }
      }
    }
  } catch (e) {
    rec('!!', '未捕获异常', 'FAIL', String(e).slice(0, 500));
  } finally {
    killTree();
    try {
      if (indexPath !== null) {
        if (indexBackup === null) { if (fs.existsSync(indexPath)) fs.rmSync(indexPath); }
        else fs.writeFileSync(indexPath, indexBackup);
        console.log(`[market-smoke] index.json 已还原（原本${indexSeen ? '有' : '没有'}）`);
      }
    } catch (e) { console.log('[market-smoke] 还原失败:', String(e)); }
    // 装包那一项会落 `packs/` + 记账 ⇒ 回到跑前状态，重复跑同结果
    try {
      if (kTargetDir !== null && !kTargetExistedBefore && fs.existsSync(kTargetDir)) {
        fs.rmSync(kTargetDir, { recursive: true, force: true });
        console.log(`[market-smoke] 落点 ${path.relative(process.cwd(), kTargetDir)} 已清除（跑前本没有）`);
      }
    } catch (e) { console.log('[market-smoke] 落点清除失败:', String(e)); }
    try {
      if (kRecordsPath !== null) {
        if (kRecordsBackup === null) { if (fs.existsSync(kRecordsPath)) fs.rmSync(kRecordsPath); }
        else fs.writeFileSync(kRecordsPath, kRecordsBackup);
        console.log(`[market-smoke] 记账已还原（原本${kRecordsBackup ? ` ${kRecordsBackup.length} B` : '没有'}）`);
      }
    } catch (e) { console.log('[market-smoke] 记账还原失败:', String(e)); }
    try {
      if (kTargetDir !== null) {
        const staging = path.resolve(kTargetDir, '..', '..', '..', '.staging');
        if (fs.existsSync(staging)) {
          const left = fs.readdirSync(staging);
          if (left.length > 0) { fs.rmSync(staging, { recursive: true, force: true }); console.log(`[market-smoke] 暂存区残壳 ${left.length} 条已清`); }
        }
      }
    } catch (e) { console.log('[market-smoke] 暂存区清除失败:', String(e)); }
    restoreStore();
  }

  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n================ 市场冒烟汇总 ================');
  for (const r of results) console.log(`${r.status.padEnd(4)} ${r.id.padEnd(3)} ${r.name}: ${r.detail}`);
  console.log(`共 ${results.length} 项；FAIL ${failCount}；用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(failCount === 0 ? '✅ 市场索引面真链路冒烟通过' : '❌ 市场索引面真链路冒烟存在失败项');
  process.exit(failCount === 0 ? 0 : 1);
}

main();
