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
 *   f2 白名单内的真实索引经**真 IPC** 取回：200 + 声明字节 = 实读字节 + 终止 URL 仍在放行主机
 *      + 正文过索引 schema 形状闸（**不钉线上的字节数 / sha256 / 包条数**——那是外部内容）
 *   g  面板点「拉取列表」⇒ index.json 落盘、schema 合规、条目与**同一时刻匿名取回的那份**逐条对平
 *   h  匿名读回的 index 与本地落盘内容**逐字节**对平（含 sha256 读数；不钉数，只要求两边是同一份）
 *   i  面板屏上给出「已拉取」人话 + 数据时间行 + 条目数（不是静默成功）
 *   j  盘上那份的坏条目会重新报进 dropped（镜像不洗盘）——只在注册表当前有坏条目时才判，
 *      现在没有 ⇒ 明确 SKIP（不假装绿）
 *   k  **真装一个包再卸掉**：面板点「安装」⇒ 真下载 + 真解压 + 真落盘 + 真记账 ⇒
 *      屏上「已安装」+ 盘上逐条目对平 + 记账容器核对码与注册表那条自证的一致性 ⇒ 点「卸载」确认
 *      ⇒ 目录消失、行消失、零残壳。目标包与期望事实**从这一次取回的注册表现场解析**
 *      （`resolveInstallTarget`：优先 demo.era-tw 1.0.3，它不在就退回同种类最小的包），
 *      不钉死外部包的摘要。
 *      容器落在 github.com（本机直连必超时）⇒ **不带代理时这一项报 SKIP 并打印复跑命令**，不算过。
 *      **MK-1 的毫秒数**（每次跑都进读数，PASS/FAIL/SKIP 都带）：
 *      ① 装成 → 「已装」行出现且卸载点得动；② 卸载确认 → 落点目录消失；
 *      ③ 卸载确认 → 屏上那一行消失；④ 卸载确认 → 「已卸掉…」结果句上屏。
 *      **判据（2026-11-01 MK-SMOKE-RECAL 重定）**：③ 比的是 ④（同一次 React 提交 ⇒ 同拍），
 *      容差 = `rowLagToleranceMs(实测采样周期)` = max(900ms, 3×周期) ⇒ 恒 > 2× 采样周期；
 *      ③ 与 ② 的差值只上读数（它量的是整段卸载尾巴：记账写盘 + 祖先目录 + 暂存清扫），
 *      另判一条方向：屏上那条不许比盘上先消失。旧口径「③ ≤ ② + 300ms」的 300ms 正好等于一个
 *      采样周期，测出来的是"这一轮谁先被采到"而不是产品滞后（实测 469ms / 2,013ms 两跑皆红）。
 *      取样一律走 `pollUntil`/`pollWhere` 的**显式值**轮询（教训①：`waitFor` 认"返回真值"为就绪，
 *      而"还没好"返回的是字符串——字符串是真值；教训②：动作后固定 `sleep` 一次性判读会把
 *      "慢一点"读成"没做完"）。
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
 * 端口：默认按仓库配置（`tauri.conf.json` 的 devUrl / `vite.config.ts` 的 port，当前 1420）；
 *   `KOJO_SMOKE_VITE_PORT=1431` 可换端口——不碰仓库里的配置文件，用临时 JSON 走 `tauri dev --config`
 *   （换了端口会触发一次 ~30s 的 cargo 重编）。占用检查**两个地址族都试**：别的树的 vite 只挂
 *   `[::1]:1420` 时，localhost 会把壳带到**别人的 dev server** 上 ⇒ 起壳后先钉页面 origin，不在
 *   预期地址就不判绿（2026-10-17 实测过的假绿）。
 *
 * ⚠ 一台机器同一个工作树**只许一个桌面实例**：本工具与 `smoke-tauri-ipc.mjs` 不能同时跑
 *   （Vite 端口互斥，工具开头就检查，占着就 rc=2 明确失败）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveCorpusDir, discoverCorpora, corpusHint } from './corpus.mjs';
import { answerAskDialogs, assertPageOrigin, devTarget, portBusy, recentRowClickSrc, recentRowWaitSrc } from './smoke-lib.mjs';
import {
  hostAllowlisted,
  parseIndexBytes,
  resolveInstallTarget,
  rowLagToleranceMs,
  sortRows,
  uninstallTailProblems,
} from './lib/market-smoke-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDP_PORT = 9223;
/**
 * 默认注册表端点（与契约 `MARKET_DEFAULT_INDEX_URL` 同值；本工具按字面读线上资产，不引 TS 源码）。
 *
 * 这是本工具**唯一**钉死的外部字面量，理由：端点属于本仓可控内容（改它 = 改了产品默认源），
 * 校验收在 `tools/tests/market-smoke-rules.test.ts` 的源形状闸里（与契约同值）。
 */
const INDEX_URL = 'https://poboking.github.io/kojo-market/index.json';
/*
 * 索引面的锚点（2026-11-01 MK-SMOKE-RECAL 重定）：**只钉本仓可控的东西**——
 * 端点字面、schema 版本、包种类枚举、体积上限（全在 `lib/market-smoke-rules.mjs`）。
 *
 * **不再**钉注册表的字节数 / sha256 / 包条数 / 具体条目：旧的 `ANCHOR_BYTES=1612` /
 * `ANCHOR_SHA256=f1b72c01…` / 期望 2 条包钉的是**会变的外部内容**——社区投稿进注册表后
 * 线上实测 4,141 B / e100bb76… / 6 条包，于是 f2/g/h 三条一起红，而链路与产品一个字节都没坏。
 * 现在外部内容的正确性由 f2/g/h **自证**：真 IPC 取回 / 匿名取回 / 盘上落盘三方逐字节相同，
 * 且每条都过 `parseIndexBytes` 的形状闸（schema=1 / packs 数组 / 每条的
 * kind/id/version/fileCount/unpackedBytes/zip 合法）。注册表长出新包不该判红，长出**坏包**才该。
 */
/** k 项的**首选**装包目标（本仓夹具包）；它不在注册表里时由 `resolveInstallTarget` 现场改选 */
const K_PREFERRED_TARGET = { kind: 'kojo-pack', id: 'demo.era-tw', version: '1.0.3' };

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

/**
 * 布尔型就绪等待：`expr` 必须自己返回 **true**（返回值不是 `true` 一律继续等）。
 *
 * ⚠ 教训（看板 MK-1，探针自害①）：本仓过去把"返回一个字符串表示还没好"的表达式交给
 * 这种等待——字符串是**真值**，于是第一次轮询就"等到"了，60s 的等待形同虚设，
 * 把「滞后 1.2s」读成「永远不出现」。**要判"取到某个值"，用下面的 `pollUntil`，别用这里。**
 */
async function waitFor(cdp, expr, timeoutMs = 60000, intervalMs = 700) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try { last = await cdp.evalJs(expr, 15000); if (last === true) return last; } catch (e) { last = String(e); }
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timeout (${timeoutMs}ms): ${expr} last=${JSON.stringify(last)}`);
}

/**
 * **带耗时的显式值轮询**（MK-1 判据的取样形态）：
 * 只认 `values` 里列出的那几个返回值（逐字 `===` 比，不做真值判断），命中即返回，
 * 超时**不抛**而是带着 `timedOut` 与**毫秒数**回来——因为看板要的正是"多久出现/消失"这个数，
 * 抛异常就等于把最该上读数的那个数丢掉了。
 *
 * 判"有没有出现/消失"一律走这里，别再拿 `waitFor` 接一个返回字符串的表达式（教训①），
 * 也别在动作之后固定 `sleep` 一次性判读（教训②：那会把"慢一点"读成"没做完"）。
 */
async function pollUntil(cdp, expr, values, { timeoutMs = 60000, intervalMs = 400, settle = 0 } = {}) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    try { last = await cdp.evalJs(expr, 15000); } catch (e) { last = `eval-error:${String(e).slice(0, 60)}`; }
    if (values.some((v) => v === last)) {
      const ms = Date.now() - t0;
      // `settle` > 0 ⇒ 命中后再等这么久复核一次：中间隔了网络动作的等待，
      // 必须确认它**没有回退**（"行消失 120ms"随后被旧读数倒灌复活，就是看板那条 3.7s 的另一半成因）
      if (settle > 0) {
        await sleep(settle);
        let again = null;
        try { again = await cdp.evalJs(expr, 15000); } catch { again = null; }
        if (!values.some((v) => v === again)) { last = again; continue; }
      }
      return { value: last, ms, timedOut: false };
    }
    if (Date.now() - t0 >= timeoutMs) return { value: last, ms: Date.now() - t0, timedOut: true };
    await sleep(intervalMs);
  }
}

/** 表达式版：命中条件由 `predicate(返回值)` 决定（对象一类没法逐字列举时用这条；仍然是显式判定，不认裸真值） */
async function pollWhere(cdp, expr, predicate, { timeoutMs = 60000, intervalMs = 400 } = {}) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    try { last = await cdp.evalJs(expr, 15000); } catch (e) { last = `eval-error:${String(e).slice(0, 60)}`; }
    if (predicate(last)) return { value: last, ms: Date.now() - t0, timedOut: false };
    if (Date.now() - t0 >= timeoutMs) return { value: last, ms: Date.now() - t0, timedOut: true };
    await sleep(intervalMs);
  }
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
  let dev;
  try {
    dev = devTarget(ROOT);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    restoreStore();
    process.exit(2);
  }
  const busy = (await portBusy(dev.port)) || (await portBusy(CDP_PORT));
  if (busy) {
    console.error(
      `❌ ${dev.port} 或 CDP ${CDP_PORT} 已被占用（同一工作树只许一个桌面实例）。\n`
      + '   注意占用要两个地址族都算：别的树的 vite 只挂 [::1] 时，localhost 会把壳带到它的 dev server 上。\n'
      + '   先关掉在跑的 tauri dev / 其它冒烟再试；或换端口：KOJO_SMOKE_VITE_PORT=1431 再跑。',
    );
    restoreStore();
    process.exit(2);
  }

  console.log('[market-smoke] launching tauri dev (Vite %d, CDP %d%s) …',
    dev.port, CDP_PORT, dev.tauriArgs.length > 0 ? '，端口来自 KOJO_SMOKE_VITE_PORT' : '');
  const devCmd = ['pnpm --filter @kojo/app tauri dev', ...dev.tauriArgs.map((a) => `"${a}"`)].join(' ');
  const child = spawn(devCmd, {
    shell: true,
    windowsHide: true,
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
  /* 装包那一项会落 `packs/` 与记账 ⇒ 跑完必须回到跑前状态（重复跑同结果）。
     目标包要到 f2 取回注册表之后才能定（`resolveInstallTarget`），故 `kTargetDir` 那时才赋值。 */
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
    const pageHref = await assertPageOrigin(cdp, dev.origin);
    console.log(`[market-smoke] page ready ✓（${pageHref}）`);

    /* -------- 打开项目（只为拿到壳的面板层；市场链路本身不读游戏目录） -------- */
    await waitFor(cdp, recentRowWaitSrc(JSON.stringify(gameDir)), 40000);
    const clicked = await cdp.evalJs(recentRowClickSrc(JSON.stringify(gameDir)));
    if (clicked !== 'clicked') throw new Error(`recent project click failed: ${clicked}`);
    await waitFor(cdp, '!!document.querySelector(".toolbar")', 150000);
    await sleep(1500);
    // 开项目后不止「写权限确认」一种模态：会话恢复里带 ERB 标签会先弹「.kojo 预览」首次引导。
    // 逐朵按白名单答掉（不认识的模态由 helper 抛错并打出按钮原文——不瞎点）。
    const askResult = await answerAskDialogs(cdp, { log: (m) => console.log(`[market-smoke] ${m}`) });
    if (askResult.answered.length > 0) {
      console.log(`[market-smoke] 模态已清空（${askResult.answered.length} 朵）`);
    }
    // 不等索引跑完（市场链路不吃索引；等了只是白等一趟语料扫描）
    P('p0', '打开项目（拿壳的面板层）', `工具条已渲染：${await cdp.evalJs('document.querySelector(".tb-project")?.title ?? ""')}`);

    /* -------- 备份本机那份 index.json（跑完原样还回去） -------- */
    const appData = await cdp.evalJs(`(${INV})('app_data_dir')`);
    indexPath = path.join(appData, 'market', 'index.json');
    indexBackup = fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : null;
    indexSeen = indexBackup !== null;
    console.log(`[market-smoke] appDataDir=${appData} index=${path.basename(indexPath)} 备份=${indexBackup ? `${indexBackup.length} B` : '本机原本没有'}`);
    kRecordsPath = path.join(appData, 'store', 'kojo-market', 'installed.json');
    kRecordsBackup = fs.existsSync(kRecordsPath) ? fs.readFileSync(kRecordsPath) : null;
    console.log(`[market-smoke] 记账备份：${kRecordsBackup ? ` ${kRecordsBackup.length} B` : '本机原本没有'}`);

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

    /* -------- f2) 白名单内的真实索引经真 IPC 取回（同一份判定、同一条链路） --------
       判据只落在**本仓能负责**的三件事上（外部注册表长出新包不该判红）：
       ① 真 IPC 取回是 200，且重定向后的终止 URL 仍在放行主机（白名单没被绕）；
       ② 响应声明的字节数 = 正文实读字节数（桥没截断、没补字节）；
       ③ 正文过索引 schema 形状闸（`parseIndexBytes`：schema=1 / generatedAt 可解析 /
          packs 数组 / 每条的 kind/id/version/fileCount/unpackedBytes/zip 合法、三元组不重复）。
       取回的那一份同时留作下面 g/h/k 的对照物（远程 ⇔ 盘上 ⇔ 屏上三方自证）。 */
    const f2 = await cdp.evalJs(`(async () => {
      try {
        const v = await (${INV})('market_fetch_text', { url: ${JSON.stringify(INDEX_URL)}, timeoutMs: 15000, maxBytes: 524288 });
        return { ok: true, v };
      } catch (e) { return { ok: false, err: String(e) }; }
    })()`);
    let remoteIndex = null; // parseIndexBytes 的结果（f2 成功时才有）
    if (!f2.ok) F('f2', '真 IPC 取回线上索引（200 + 声明=实读 + schema 合规）', `market_fetch_text 失败：${f2.err}`);
    else {
      const v = f2.v;
      const remoteBuf = Buffer.from(v.text, 'utf8');
      const parsedRemote = parseIndexBytes(remoteBuf);
      let finalHost = '';
      try { finalHost = new URL(v.finalUrl).host; } catch { finalHost = ''; }
      const problems = [];
      if (v.status !== 200) problems.push(`status=${v.status}`);
      if (!Number.isInteger(v.bytes) || v.bytes !== remoteBuf.length) problems.push(`响应声明 ${v.bytes} B ≠ 实读 ${remoteBuf.length} B`);
      if (!hostAllowlisted(finalHost)) problems.push(`终止 URL 的主机 ${finalHost || '（读不出）'} 不在放行名单`);
      problems.push(...parsedRemote.problems);
      if (problems.length === 0) {
        remoteIndex = parsedRemote;
        P('f2', '真 IPC 取回线上索引（200 + 声明=实读 + schema 合规）',
          `status=200 ${remoteBuf.length} B sha256=${sha256(remoteBuf).slice(0, 12)}… packs=${parsedRemote.packs.length} 条 `
          + `generatedAt=${parsedRemote.json?.generatedAt} finalUrl=${v.finalUrl}`);
      } else {
        F('f2', '真 IPC 取回线上索引（200 + 声明=实读 + schema 合规）', problems.join('；'));
      }
    }

    /* -------- g) 走**面板**：点活动栏「口上市场」（主侧栏独占视图）→ 点「拉取列表」（force 回源） --------
       点击要幂等：布局持久化在 WebView2 localStorage ⇒ 上一次跑留下的"市场已激活"会被这次继承，
       活动栏对已激活视图的点击语义是**收起侧栏**（ShellLayout 的 toggle）——已开着就不再点。 */
    const abClicked = await cdp.evalJs(`(() => {
      if (document.querySelector('.sidebar .panel-market')) return 'already-open';
      const b = [...document.querySelectorAll('.activitybar .ab-item')].find((e) => (e.title ?? '').startsWith('口上市场'));
      if (!b) return 'no-market-item';
      b.click();
      return 'clicked';
    })()`);
    if (!['clicked', 'already-open'].includes(abClicked)) throw new Error(`market activity-bar click failed: ${abClicked}`);
    await waitFor(cdp, `!!document.querySelector('.sidebar .panel-market')`, 30000);

    // 面板首帧 busy=true（拉取期文案是「拉取中…」且按钮禁用）⇒ 禁用态继续等，别把文案窗口当成"没有按钮"
    const pullClicked = await pollUntil(
      cdp,
      `(() => {
        const b = [...document.querySelectorAll('.panel-market .mk-toolbar button')].find((e) => e.textContent.includes('拉取'));
        if (!b) return 'no-pull-button';
        if (b.disabled) return 'pull-disabled';
        b.click();
        return 'clicked';
      })()`,
      ['clicked'],
      { timeoutMs: 60000 },
    );
    if (pullClicked.value !== 'clicked') throw new Error(`拉取列表 click failed: ${pullClicked.value}（等了 ${pullClicked.ms}ms）`);

    // 等屏上出现「已拉取注册表列表」（刷新成功的那句人话），顺带把面板状态读回来。
    // 对象返回值没法逐字列举 ⇒ 走 `pollWhere` 的显式谓词（就绪前返回 `null`，判定认"对象且带 note"，
    // 不是"非空即真"）。
    // 行数只数**索引组**（section.mk-group）：「已装」组（.mk-list）的行数由本机安装态决定，
    // 与注册表包数无关——数全面板会把机器状态读成判据（本机装着旧版时 3 行 vs 盘上 2 的假红）。
    const panelPoll = await pollWhere(
      cdp,
      `(() => {
        const note = document.querySelector('.panel-market .mk-note')?.innerText ?? '';
        const time = document.querySelector('.panel-market .mk-time')?.innerText ?? '';
        const status = document.querySelector('.panel-market .mk-status')?.innerText ?? '';
        const dropped = document.querySelector('.panel-market .mk-warn')?.innerText ?? '';
        const rows = document.querySelectorAll('.panel-market section.mk-group .mk-row').length;
        return /已拉取注册表列表/.test(note) ? { note, time, status, dropped, rows } : null;
      })()`,
      (v) => v !== null && typeof v === 'object' && typeof v.note === 'string',
      { timeoutMs: 60000 },
    );
    if (panelPoll.timedOut) throw new Error(`面板没给出「已拉取注册表列表」（等了 ${panelPoll.ms}ms）`);
    const panel = panelPoll.value;

    /* -------- g) 落盘 + schema 合规 + 条目与**同一时刻的远程**逐条对平 --------
       对平的参照物是"这一次匿名取回的那份"，**不是**钉死的包清单：注册表里有哪些包是外部内容，
       社区投稿会让它长（2 条 → 6 条），钉死就等于把"注册表长大了"判成"本仓回归"。 */
    const local = fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : null;
    const disk = local === null ? null : parseIndexBytes(local);
    let anonBuf = null;
    let anon = null;
    try {
      anonBuf = Buffer.from(await (await fetch(INDEX_URL, { cache: 'no-store' })).arrayBuffer());
      anon = parseIndexBytes(anonBuf);
    } catch (e) {
      anonBuf = null;
      anon = null;
      console.log(`[market-smoke] 匿名读回失败（h 会据此判红）：${String(e).slice(0, 160)}`);
    }
    if (disk === null) F('g', '面板拉取 ⇒ index.json 落盘 + schema 合规 + 条目对平', `文件不在位：${indexPath}`);
    else {
      const rows = sortRows(disk.packs);
      const want = anon === null ? null : sortRows(anon.packs);
      const problems = [];
      if (disk.problems.length > 0) problems.push(`盘上 schema 不合规：${disk.problems.join('；')}`);
      if (anon === null) problems.push('匿名取不回远程那一份（没有对平参照物）');
      else if (anon.problems.length > 0) problems.push(`远程 schema 不合规：${anon.problems.join('；')}`);
      else if (JSON.stringify(rows) !== JSON.stringify(want)) {
        problems.push(`条目与远程不符：盘上 ${JSON.stringify(rows)} ≠ 远程 ${JSON.stringify(want)}`);
      }
      if (problems.length === 0) {
        P('g', '面板拉取 ⇒ index.json 落盘 + schema 合规 + 条目与远程对平',
          `packs=${disk.packs.length} generatedAt=${disk.json?.generatedAt} 条目=${rows.map((r) => r.slice(0, 3).join('/')).join(' ')}`);
      } else {
        F('g', '面板拉取 ⇒ index.json 落盘 + schema 合规 + 条目与远程对平', problems.join('；'));
      }
      /* -------- h) 匿名读回 ⇔ 本地落盘**逐字节**对平（同一份内容，两个取法） -------- */
      const localSha = sha256(local);
      if (anonBuf !== null && anonBuf.equals(local)) {
        P('h', '匿名读回与本地落盘逐字节对平',
          `${local.length} B 同一份；sha256 两边一致 = ${localSha.slice(0, 12)}…（远程 / 盘上；不钉外部摘要）`);
      } else {
        const anonSha = anonBuf === null ? '(取不回)' : `${anonBuf.length} B / ${sha256(anonBuf).slice(0, 12)}`;
        F('h', '匿名读回与本地落盘逐字节对平', `远程 ${anonSha} / 盘上 ${local.length} B ${localSha.slice(0, 12)}`);
      }
      /* -------- i) 面板屏上的事实与盘上一致（不是静默成功） -------- */
      const noteRows = (panel.note.match(/（(\d+) 个包）/) ?? [])[1];
      const timeOk = /数据时间/.test(panel.time) && /拉取/.test(panel.time);
      if (noteRows === String(disk.packs.length) && timeOk && panel.rows === disk.packs.length) {
        P('i', '面板给出人话 + 数据时间 + 条目数', `note=「${panel.note}」 time=「${panel.time}」 屏上条目行 ${panel.rows} 行`);
      } else {
        F('i', '面板给出人话 + 数据时间 + 条目数', `note=「${panel.note}」(包数 ${noteRows}) time=「${panel.time}」 行=${panel.rows} 盘上=${disk.packs.length} status=「${panel.status}」`);
      }
      /* -------- j) 坏条目 ⇒ dropped 出声（注册表当前没有坏条目时明确 SKIP） -------- */
      if (panel.dropped === '') S('j', '坏条目进 dropped 并出声', '线上注册表当前没有坏条目（本地服务侧的判据见 kernel/tests/integration-market.test.ts）');
      else P('j', '坏条目进 dropped 并出声', panel.dropped.slice(0, 120));

      /* -------- k) 真装一个包再卸掉：真下载 + 真解压 + 真落盘 + 真记账 + 即时失效 -------- */
      /**
       * 目标包与期望事实**从这一次取回的注册表现场解析**（`resolveInstallTarget`），不钉死外部包的
       * 摘要 / 文件数 / 解压字节：注册表一变（旧口径钉的 `demo.era-tw 1.0.3 = d88a4a24…` 只是碰巧还在）
       * 就会变成假红。钉的只有"优先拿本仓夹具包，它不在就退回同种类最小的包"，其余一律取自索引自述。
       *
       * 四个毫秒数**每一次跑都上读数**（看板 MK-1 的量化靶）：
       * ① 装成那句人话 → 「已装」行出现且卸载点得动；② 卸载确认 → 落点目录消失；
       * ③ 卸载确认 → 屏上那一行消失；④ 卸载确认 → 「已卸掉…」结果句上屏。
       *
       * **判据（2026-11-01 MK-SMOKE-RECAL 重定）**：
       * · 主判据是 ③ ≤ ④ + 容差。撤行与结果句是同一次 React 提交里的两笔 ⇒ 这个差值只受采样粒度
       *   影响，与"卸载本身要花多久"无关；容差 `rowLagToleranceMs(实测采样周期)` = max(900ms, 3×周期)
       *   ⇒ 恒 > 2× 采样周期。
       * · 旧口径「③ ≤ ② + 300ms」把**整段卸载尾巴**（记账写盘 + 祖先目录收尾 + 暂存清扫）也算进
       *   一个正好等于采样周期的 300ms 里 ⇒ 测出来的是"这一轮谁先被采到"（实测 469ms / 2,013ms
       *   两跑皆红，而盘上 / 记账 / 屏幕逐字节全对）。现在 ③−② 只上读数，另判一条方向：
       *   屏上那条不许比盘上先消失（那是"屏上先于盘上"的假象）。
       * · 功能面一条不松：行必须真出现、目录必须真消失、行必须真消失、消失后不许复活。
       * 取不到的那个写「未取」，不改写成 SKIP 蒙过去。
       */
      const kHow = '复跑：HTTPS_PROXY=http://127.0.0.1:7890 node tools/smoke-tauri-market.mjs';
      const kName = '真装一个包再卸掉（真下载+解压+落盘+记账+卸载+即时失效）';
      const kPicked = resolveInstallTarget(
        // 目标从**面板此刻列的那份索引**里挑（盘上那份 = 屏上那份），取不到才退回 f2 的远程快照
        disk !== null && disk.packs.length > 0 ? disk.packs : (remoteIndex?.packs ?? []),
        K_PREFERRED_TARGET,
      );
      const kSkip = kPicked === null;
      const K = kPicked?.entry ?? { kind: '', id: '', version: '', fileCount: 0, unpackedBytes: 0, zipSha256: '', zipBytes: 0 };
      const kKey = `${K.kind}/${K.id}@${K.version}`;
      let kRowMs = null;
      let kDirMs = null;
      let kGoneMs = null;
      let kDoneMs = null;
      let kSamplingMs = 0;
      let kFailNote = '';
      const fmtMs = (n) => (n === null ? '未取' : `${n}ms`);
      const kRead = () => `毫秒数：①行出现=${fmtMs(kRowMs)} ②目录消失=${fmtMs(kDirMs)} ③行消失=${fmtMs(kGoneMs)} ④结果句=${fmtMs(kDoneMs)}；采样周期≈${kSamplingMs}ms 容差=${rowLagToleranceMs(kSamplingMs)}ms`;
      if (kSkip) {
        S('k', kName, '未验证：盘上那份索引与 f2 的远程快照里都挑不出可安装的包——没有装包目标，不假装测过');
      } else {
        kTargetDir = path.join(appData, 'market', 'packs', K.kind, K.id, K.version);
        kTargetExistedBefore = fs.existsSync(kTargetDir);
        console.log(`[market-smoke] k 目标包 = ${kKey}（${kPicked.why}）；落点${kTargetExistedBefore ? '已在本机（跑完不动它）' : '原本没有'}`);
      }
      /* 行身份走 `data-market-key`（= `kind/id@version`，面板自己写上去的那个键）：
         旧写法按「版本 x.y.z」在行文本里找，注册表里多个包同版本时会挑错行。 */
      const kRowSel = kSkip ? 'null' : `document.querySelector('.panel-market .mk-list .mk-row[data-market-key="${kKey}"]')`;
      const kRowStateExpr = `(() => (${kRowSel} ? 'listed' : 'gone'))()`;

      /* 1) 注册表行上点「安装」（显式值轮询：只认 'clicked'） */
      const kClick = kSkip
        ? { value: 'skipped(没有装包目标)', ms: 0, timedOut: true }
        : await pollUntil(
            cdp,
            `(() => {
              const row = document.querySelector('.panel-market section.mk-group .mk-row[data-market-key="${kKey}"]');
              if (!row) return 'no-registry-row';
              const b = [...row.querySelectorAll('button')].find((e) => /安装|更新/.test(e.textContent));
              if (!b) return 'no-action-button';
              if (b.disabled) return 'install-disabled';
              b.click();
              return 'clicked';
            })()`,
            ['clicked'],
            { timeoutMs: 60000, intervalMs: 300 },
          );
      if (kSkip) {
        /* 已在上一条报过 SKIP：没有装包目标时这条链路一次都不走 */
      } else if (kClick.value !== 'clicked') {
        F('k', kName, `注册表行上点不动安装：${String(kClick.value)}（等了 ${kClick.ms}ms）；${kRead()}`);
      } else {
        /* 2) 等装成那句人话（对象返回值 ⇒ 显式谓词，仍然是带耗时的轮询） */
        const kOutcome = await pollWhere(
          cdp,
          `(() => {
            const note = document.querySelector('.panel-market .mk-note')?.innerText ?? '';
            if (/已装上|已把「.+」更新到版本/.test(note)) return { ok: true, note };
            if (/没装成|没有成功|没能|失败|超时|拒绝|不是同一份|要求更新版本/.test(note)) return { ok: false, note };
            return null;
          })()`,
          (v) => v !== null && typeof v === 'object' && typeof v.ok === 'boolean',
          { timeoutMs: 180000, intervalMs: 300 },
        );
        if (kOutcome.timedOut) {
          S('k', kName, `未验证：180s 内安装没有给出结果句（多半是没出网取不到容器）；${kHow}；${kRead()}`);
        } else if (kOutcome.value.ok !== true) {
          const note = kOutcome.value.note;
          // 容器落在 github.com（本机直连必超时）⇒ 没带代理是"没验过"，不是"过了"
          if (/超时|没能|没有成功|连接|网络/.test(note)) S('k', kName, `未验证：安装没成功（${note}）；${kHow}；${kRead()}`);
          else F('k', kName, `安装被拒（${note}）；${kRead()}`);
        } else {
          const kProbs = [];
          // 落点里**只有 `files/**`**（`pack.json` 只当校验锚、不搬进落点）⇒
          // 逐文件事实取记账那一份，再逐条与注册表那一行对平、与盘上字节对平。
          let kRec = null;
          try {
            const raw = JSON.parse(fs.readFileSync(kRecordsPath, 'utf8'));
            const arr = Array.isArray(raw) ? raw : (raw?.packs ?? raw?.installed ?? []);
            kRec = arr.find(
              (r) => r?.id === K.id && r?.kind === K.kind && r?.version === K.version,
            ) ?? null;
            if (kRec === null) kProbs.push('记账里没有这一条');
          } catch (e) { kProbs.push(`记账读不出：${String(e).slice(0, 80)}`); }

          const kDeclared = kRec !== null && Array.isArray(kRec.files) ? kRec.files : [];
          if (kRec !== null) {
            // 容器核对码与**这一次索引自述的那一条**对平（钉死外部摘要的旧做法见 k 项注释）
            if (kRec.containerSha256 !== K.zipSha256) {
              kProbs.push(`记账容器核对码 ${kRec.containerSha256 ?? '（没有）'} ≠ 注册表这一条声明的 ${K.zipSha256}`);
            }
            // 与注册表那一行对平（fileCount / unpackedBytes 的权威值由索引自述给出）
            if (kDeclared.length !== K.fileCount) kProbs.push(`文件数 ${kDeclared.length} ≠ 注册表 ${K.fileCount}`);
            const total = kDeclared.reduce((s, f) => s + Number(f?.bytes ?? -1), 0);
            if (total !== K.unpackedBytes) kProbs.push(`解压总字节 ${total} ≠ 注册表 ${K.unpackedBytes}`);
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

          /* 3) ①「已装」行出现：从"装成那句上屏"这一刻起，100ms 一轮真等到卸载按钮点得动 */
          const kRowPoll = await pollUntil(
            cdp,
            `(() => {
              const row = ${kRowSel};
              if (!row) return 'no-installed-row';
              const b = [...row.querySelectorAll('button')].find((e) => e.textContent.trim() === '卸载');
              if (!b) return 'no-uninstall-button';
              if (b.disabled) return 'uninstall-disabled';
              b.click();
              return 'requested';
            })()`,
            ['requested'],
            { timeoutMs: 60000, intervalMs: 100 },
          );
          kRowMs = kRowPoll.ms;
          if (kRowPoll.timedOut) {
            kProbs.push(`装成后 ${kRowMs}ms 卸载入口仍不可点：${String(kRowPoll.value)}`);
          } else if (kRowMs > 3000) {
            /**
             * 3s 这条线是**组长 2026-10-16 现定的**，不是产品承诺；即时失效（MK-1）之后
             * 这一数应当落在"一次重绘"的量级，>3s 就是"刷新链没接上"的形态 ⇒ 判红。
             */
            kProbs.push(`卸载入口在装成功后 ${kRowMs}ms 才可点（>3s ⇒ 装后即时失效没接上）`);
          } else {
            // 出现后 1.2s 内复核这一行还在：乐观先行又被在途旧读数盖掉的形态，正是本项要抓的另一种滞后
            const kStill = await pollUntil(cdp, kRowStateExpr, ['listed'], { timeoutMs: 1200, intervalMs: 200 });
            if (kStill.timedOut) kProbs.push('卸载点后这一行在 1.2s 内又不见了（显示回跳，读数不可信）');
          }

          /* 4) 确认卸载（显式值轮询；就绪前返回的字符串不再被当成"等到了"） */
          const kConf = kRowPoll.timedOut
            ? { value: 'skipped(卸载入口不可点，见上条读数)', ms: 0, timedOut: true }
            : await pollUntil(
                cdp,
                `(() => {
                  const row = ${kRowSel};
                  if (!row) return 'row-gone';
                  const b = [...row.querySelectorAll('button')].find((e) => e.textContent.trim() === '确认');
                  if (!b) return 'no-confirm-button';
                  if (b.disabled) return 'confirm-disabled';
                  b.click();
                  return 'confirmed';
                })()`,
                ['confirmed', 'row-gone'],
                { timeoutMs: 60000, intervalMs: 100 },
              );
          if (!String(kConf.value).startsWith('skipped') && kConf.value !== 'confirmed' && kConf.value !== 'row-gone') {
            kProbs.push(`卸载没走完：${String(kConf.value)}（等了 ${kConf.ms}ms）`);
          }

          /* 5) ②盘上 / ③屏上 / ④结果句 在同一段循环里采：
                ② 走**紧循环**（`fs.existsSync`，中间不夹 CDP 往返 ⇒ 采样误差 ~10ms）；
                ③④ 由**同一次** evalJs 一起读回来（屏上那一行还在不在 + 状态行原文），
                    时间戳取**页内** `Date.now()`（CDP 往返的延迟记在采样自己头上，
                    不记成"屏上晚了"，这是旧判据被采样噪声吃掉的那一半根因）。 */
          if (kConf.value === 'confirmed' || kConf.value === 'row-gone') {
            const kWatchExpr = `(() => {
              const row = ${kRowSel};
              const note = document.querySelector('.panel-market .mk-note')?.innerText ?? '';
              return { row: row ? 'listed' : 'gone', note, t: Date.now() };
            })()`;
            const tUn = Date.now();
            const rounds = [];
            for (;;) {
              const tRound = Date.now();
              if (kDirMs === null && !fs.existsSync(kTargetDir)) kDirMs = tRound - tUn;
              let sample = null;
              try { sample = await cdp.evalJs(kWatchExpr, 15000); } catch { sample = null; }
              if (sample !== null && typeof sample === 'object') {
                const at = Math.max(0, (Number.isFinite(sample.t) ? sample.t : Date.now()) - tUn);
                if (kGoneMs === null && sample.row === 'gone') kGoneMs = at;
                if (kDoneMs === null && /已卸掉/.test(String(sample.note))) kDoneMs = at;
                if (kFailNote === '' && /卸载没有成功/.test(String(sample.note))) kFailNote = String(sample.note);
              }
              if (kDirMs !== null && kGoneMs !== null && kDoneMs !== null) break;
              if (Date.now() - tUn > 30000) break;
              await sleep(120);
              rounds.push(Date.now() - tRound);
            }
            // 实测采样周期（中位数）：容差按它换算，采样变慢时容差跟着变粗，判据不会退化到噪声面
            kSamplingMs = rounds.length === 0 ? 0 : [...rounds].sort((a, b) => a - b)[Math.floor(rounds.length / 2)];
            if (kDirMs === null) kProbs.push('卸载确认后 30s 落点目录仍在（盘上没卸掉，这是功能断裂不是滞后）');
            kProbs.push(...uninstallTailProblems({
              rowGoneMs: kGoneMs,
              doneMs: kDoneMs,
              dirGoneMs: kDirMs,
              samplingMs: kSamplingMs,
              failNote: kFailNote,
            }));
            if (kGoneMs !== null) {
              // 不许"消失后又复活"：面板被在途旧读数倒灌就是这个形态
              await sleep(400);
              let back = 'gone';
              try { back = await cdp.evalJs(kRowStateExpr, 15000); } catch { back = 'gone'; }
              if (back === 'listed') kProbs.push(`屏上那条消失 ${kGoneMs}ms 后又复活（旧读数倒灌）`);
            }
          }

          const kFact = `${kKey}：盘上 ${kDeclared.length} 个条目逐条对平（${kDeclared.map((f) => `${f.path}:${f.bytes}B`).join(' ')}）；记账容器核对码=${String(K.zipSha256).slice(0, 12)}…（与注册表自述一致）；暂存区残壳 ${kLeft} 条`;
          const kScreen = `屏上「${kOutcome.value.note}」`;
          const kDelta = kDirMs !== null && kGoneMs !== null ? `${kGoneMs - kDirMs}ms` : '未取';
          const kTail = `③−②=${kDelta}（读数：整段卸载尾巴，不设噪声级阈值）`;
          if (kProbs.length === 0) P('k', kName, `${kFact}；${kScreen}；${kRead()}；${kTail}；判据 ③ ≤ ④ + ${rowLagToleranceMs(kSamplingMs)}ms`);
          else F('k', kName, `${kProbs.join('；')}｜${kFact}｜${kScreen}｜${kRead()}｜${kTail}`);
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
    dev.cleanup();
  }

  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n================ 市场冒烟汇总 ================');
  for (const r of results) console.log(`${r.status.padEnd(4)} ${r.id.padEnd(3)} ${r.name}: ${r.detail}`);
  console.log(`共 ${results.length} 项；FAIL ${failCount}；用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(failCount === 0 ? '✅ 市场索引面真链路冒烟通过' : '❌ 市场索引面真链路冒烟存在失败项');
  process.exit(failCount === 0 ? 0 : 1);
}

main();
