#!/usr/bin/env node
/**
 * 桌面壳端到端冒烟（真实 IPC）：CDP 驱动 WebView + `__TAURI_INTERNALS__.invoke`
 * 直调 Rust 命令，跑完 tools/smoke-tauri-manual.md 的 a~e 全清单。
 *
 * 为什么可行：tauri dev 用 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 打开远程调试端口，
 * Node 经 CDP（Runtime.evaluate）在页面里执行真实 `invoke()` —— 这不是"伪造 IPC"，
 * 而是与 app 的 bridge 走同一条 `__TAURI_INTERNALS__` 通道，落到真实 Rust 命令处理器。
 *
 * 覆盖：
 *   a 打开真实游戏目录（点「最近打开」→ 真实 openProject → register_write_domain）
 *   b 域内写正常（编辑器改一个口上文件→保存→落盘 + 备份目录有新 .bak）
 *   c 域外写被拒（devtools console 调 write_file_bytes 到 C:\Windows\Temp → 明确拒绝）
 *   d 关闭项目后再写游戏目录 → 被拒（回到仅 appDataDir）
 *   e appDataDir 写正常
 *
 * 用法：node tools/smoke-tauri-ipc.mjs [游戏目录]
 *   端口默认按仓库配置（1420）；`KOJO_SMOKE_VITE_PORT=1431` 可换（临时合并配置走 `tauri dev --config`，
 *   不碰仓库文件；换端口会触发一次 ~30s 的 cargo 重编）。占用检查两个地址族都算，起壳后钉页面 origin
 *   ——别的树只挂 [::1]:1420 时，localhost 会把壳带到它的 dev server 上（假绿）。
 * 退出码：0 = 全 PASS；1 = 有 FAIL（输出逐项诊断）。
 * 注意：会弹出应用窗口（结束自动关闭）；会临时改写 store/recent-projects.json（结束还原）。
 *
 * 前置（HK-28 复跑配方；2026-10-16 真语料机跑通全绿：8 项 / FAIL 0，b1 PASS）：
 *   1. 语料在位：位置参数 / KOJO_SMOKE_PROJECT / KOJO_CORPUS_SCAN_DIRS 任一能解析出目录；
 *   2. 端口 1420/9222 空闲（`exit 2` = 别人在用，退避重试，别抢清端口）；
 *   3. **本工具自带的 WebView2 隔离目录**（PITFALLS 70，跑完自删）：直连门 `kojo.ui.directMode.v1`
 *      与「.kojo 预览」的引导选择都存 WebView localStorage ⇒ 共用画像时只要上一轮把直连打开过，
 *      本轮游戏目录 ERB 就直接可编辑，b1 的「只读前置」根本不成立。
 *   4. b1 的两个**实测**要点（缺一就红，红的是探针不是产品）：
 *      ① 「.kojo 预览」引导弹窗在 filePath 的 effect 里 setState，**晚于**文件标签出现 ⇒
 *         单次判定会把"还没弹"读成"没有弹窗"，于是打字打在还开着的 `.modal-mask` 上、
 *         焦点被遮罩吃掉 ⇒ 只读事件永远不发生。本工具因此改成**重试式清弹窗 + 等弹窗真关 +
 *         打字前无条件把焦点真点回编辑器中心**（实测读数 `focused=native-edit-context/div`）。
 *      ② 按键两路都试，命中哪路记哪路：路 A `keyDown`(带 text)+`keyUp`、路 B
 *         `rawKeyDown`+`char`+`keyUp`（EditContext 通道，PITFALLS §三-32）。本次实测
 *         **route=keyDown+text** ⇒ 曾怀疑的"合成按键在 WebView2 下彻底失效"**不成立**，路 B 只兜底。
 *   注：`approved-writable.json` 含不含该语料目录**不影响** b1 的只读前置——读数见
 *   `[b1-diag] store 前置`：门是 `isErbLike ∧ ¬inWorkspace ∧ ¬canEdit`，批准写权限只喂
 *   `canEdit` 的「直连门 ∧ 已批准」那一路，直连门关着照样只读、照样该弹解锁窗 ⇒ 本工具**不动 store**。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveCorpusDir, discoverCorpora, corpusHint } from './corpus.mjs';
import { answerAskDialogs, assertPageOrigin, devTarget, portBusy, recentRowClickSrc, recentRowWaitSrc } from './smoke-lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
// 语料路径**按主机而定**（本机只有 C:，QA 机用 D:），且目录名会被反复重排 ⇒ 不写死默认名：
//   优先级 位置参数 > KOJO_SMOKE_PROJECT > KOJO_CORPUS_DIR > 扫 C:/game/* 认内容发现（tools/corpus.mjs）。
//   一条都没有仍**一开头明确失败**（列盘上候选），比跑到 a 步"点了最近打开却没进项目"再猜原因省一整轮。
const explicitGameDir = process.argv[2] ?? process.env.KOJO_SMOKE_PROJECT;
const GAME_DIR = explicitGameDir
  ? path.resolve(explicitGameDir)
  : (() => {
      try {
        return resolveCorpusDir({ label: 'ipc' }) ?? '';
      } catch (e) {
        console.error(`❌ ${e.message}`);
        process.exit(2);
      }
    })();
if (!fs.existsSync(GAME_DIR)) {
  const hits = discoverCorpora({});
  console.error(`❌ 游戏目录不存在：${GAME_DIR || '（未发现任何符合内容条件的语料目录）'}\n`
    + `   盘上候选: ${hits.length ? hits.map((h) => h.dir).join('，') : '无（需 ERB/ 与 CSV/）'}\n`
    + `   用法：node tools/smoke-tauri-ipc.mjs "<本机真实 eraTW 根目录>"；或 ${corpusHint()}`);
  process.exit(2);
}
console.log(`[ipc] 游戏目录 = ${GAME_DIR}${explicitGameDir ? '（显式指定）' : '（按内容自动发现）'}`);
const OUTSIDE_PATH = 'C:\\Windows\\Temp\\kojo-smoke-outside.txt';
const CDP_PORT = 9222;
/**
 * 临时根：Git-Bash 下 `TMP` 可能是 POSIX 风格 `/tmp` 或干脆为空 —— 那样 cargo 起 link.exe
 * 会往 `C:\WINDOWS\lnk{…}.tmp` 写而报 LNK1104（PITFALLS 26 同款，编译期直接红一轮）。
 * Windows 一律落真 Temp 目录（照 tools/smoke-editor-features.mjs 的写法）。
 */
const TEMP_ROOT = (() => {
  const t = os.tmpdir();
  if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(t)) {
    return path.join(process.env.LOCALAPPDATA || `C:\\Users\\${os.userInfo().username}\\AppData\\Local`, 'Temp');
  }
  return t;
})();
/**
 * WebView2 专用画像（PITFALLS 70）：同 identifier 实例并存时新窗口必挂 0x8007139F；
 * 且 **直连模式 / 糖视图引导都存 WebView localStorage** ⇒ 共用画像会串味（上一轮把直连
 * 打开过，本轮游戏目录 ERB 直接可编辑，b1 的「只读前置」根本不存在）。每次跑换新画像。
 */
const RUN_TAG = `kojo-smoke-ipc-${Date.now()}`;
const WEBVIEW2_DIR = path.join(TEMP_ROOT, `${RUN_TAG}-webview2`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.setTimeout(1500);
    s.on('connect', () => {
      resolve(true);
      s.destroy();
    });
    s.on('error', () => resolve(false));
    s.on('timeout', () => {
      resolve(false);
      s.destroy();
    });
  });
}

/* ---------------------------- CDP 客户端 ---------------------------- */

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
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p(msg);
      }
    };
    return this;
  }
  send(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`cdp ${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** Runtime.evaluate（awaitPromise），返回 JS 值；异常抛出自定义错误 */
  async evalJs(expression, timeoutMs = 60000) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    if (r.exceptionDetails) {
      const desc =
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'unknown';
      throw new Error(`evalJs exception: ${String(desc).slice(0, 400)}`);
    }
    return r.result?.value;
  }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }
  async insertText(text) {
    await this.send('Input.insertText', { text });
  }
  /**
   * 单字符输入 —— Chromium **EditContext 通道**（PITFALLS §三-32 的实机成功路径；形态与
   * smoke-editor-features.mjs 的 `typeChar` 逐字一致：rawKeyDown + char(带 text) + keyUp）。
   * b1 里它是**兜底**：1016 真语料机实测路 A（`keyDown` 带 text）就足以触发
   * `onDidAttemptReadOnlyEdit`（`[b1] … 按键路=keyDown+text`），换机器/换 WebView 版本时
   * 若路 A 失灵，路 B 接手并且打印是哪一路命中的。
   */
  async typeChar(ch) {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ch, text: ch, unmodifiedText: ch });
    await this.send('Input.dispatchKeyEvent', { type: 'char', key: ch, text: ch, unmodifiedText: ch });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

/* ------------------------------ 结果记录 ------------------------------ */

const results = [];
function rec(id, name, status, detail) {
  results.push({ id, name, status, detail });
  console.log(`[${status}] ${id} ${name} — ${detail}`);
}
const P = (id, name, detail) => rec(id, name, 'PASS', detail);
const F = (id, name, detail) => rec(id, name, 'FAIL', detail);
const S = (id, name, detail) => rec(id, name, 'SKIP', detail);

/** 轮询页面表达式直到为真 */
async function waitFor(cdp, expr, timeoutMs = 60000, intervalMs = 700) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await cdp.evalJs(expr, 15000);
      if (last) return last;
    } catch (e) {
      last = String(e);
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timeout (${timeoutMs}ms): ${expr} last=${JSON.stringify(last)}`);
}

/** 轮询到真为止；超时**不抛**，返回 false（判因探针要的是"有没有"，不是异常） */
async function tryWaitFor(cdp, expr, timeoutMs, intervalMs = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await cdp.evalJs(expr, 8000)) return true;
    } catch {}
    await sleep(intervalMs);
  }
  return false;
}

/** 只读保护弹窗（糖版 / 简易版两朵都要认）——b1 断言的靶心，比裸 `.modal` 精确 */
const READONLY_MODAL = `!!document.querySelector('.modal[aria-label="ERB 只读保护"], .modal[aria-label="文件只读保护"]')`;

/**
 * 只读态的**现场读数**（HK-28：把「红是环境还是代码」变成一眼可分的读数）。
 * 读的全是屏上的东西，不改任何东西：
 *   hints = 工具条那一族胶囊的 class + 文案（unlocked / direct 有没有）
 *   sb    = 底部那颗 `.sb-writable` 的 class（口上区恒为 ro ⇒ 单看它判不出能不能写）
 *   input = Monaco 输入面：`inputarea` 的 readonly 属性 / EditContext 是否存在 / 焦点在哪
 *   modals= 此刻屏上的弹窗 aria-label 列表（等错一朵是历史红因之一）
 */
async function editorReadout(cdp) {
  return cdp.evalJs(`(() => {
    const t = (e) => (e ? (e.textContent ?? '').trim() : null);
    const ia = document.querySelector('.editor-body .inputarea');
    const ae = document.activeElement;
    return {
      hints: [...document.querySelectorAll('.erb-mode-hint, .sugar-toggle')].map((e) => e.className + '|' + t(e)),
      sb: (() => { const s = document.querySelector('.sb-writable'); return s ? s.className + '|' + t(s) : null; })(),
      input: {
        has: !!ia,
        readonly: ia ? ia.readOnly === true || ia.hasAttribute('readonly') : null,
        tag: ia ? ia.tagName.toLowerCase() : null,
        editContext: !!document.querySelector('.editcontext, [aria-multiline]') || 'editContext' in document,
        focused: ae ? ae.className + '/' + ae.tagName.toLowerCase() : null,
      },
      modals: [...document.querySelectorAll('.modal')].map((m) => m.getAttribute('aria-label')),
    };
  })()`);
}

/**
 * 打字触发「只读态下尝试编辑」——**两路都试，谁灵记谁**（HK-28 判因）：
 *   路 A = 既有配方 `keyDown`(带 text) + `keyUp`
 *   路 B = EditContext 通道 `rawKeyDown` + `char` + `keyUp`（PITFALLS §三-32 的实机成功路径）
 * 返回命中那一路的名字，两路都不灵返回 'no-modal'。
 */
async function attemptReadonlyTyping(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: 'x', key: 'x', windowsVirtualKeyCode: 88, code: 'KeyX' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x', windowsVirtualKeyCode: 88, code: 'KeyX' });
  if (await tryWaitFor(cdp, READONLY_MODAL, 3000)) return 'keyDown+text';
  await cdp.typeChar('x');
  if (await tryWaitFor(cdp, READONLY_MODAL, 5000)) return 'rawKeyDown+char+keyUp';
  return 'no-modal';
}

/* ----------------------- store 备（recent 播种） ----------------------- */

const storeDir = path.join(os.homedir(), 'AppData', 'Roaming', 'dev.kojo.editor', 'store', '_global');
const recentFile = path.join(storeDir, 'recent-projects.json');
const approvedFile = path.join(storeDir, 'approved-writable.json');
let recentBackup = null;
let approvedBackup = null;

function seedRecent() {
  fs.mkdirSync(storeDir, { recursive: true });
  recentBackup = fs.existsSync(recentFile) ? fs.readFileSync(recentFile) : null;
  approvedBackup = fs.existsSync(approvedFile) ? fs.readFileSync(approvedFile) : null;
  let list = [];
  try {
    list = JSON.parse(recentBackup?.toString('utf-8') ?? '[]');
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }
  const filtered = list.filter((r) => r?.rootDir !== GAME_DIR);
  filtered.unshift({ rootDir: GAME_DIR, adapterId: 'eratw', lastOpenedAt: Date.now() });
  fs.writeFileSync(recentFile, JSON.stringify(filtered));
  console.log(`[smoke] seeded recent with ${GAME_DIR}`);
}
function restoreStore() {
  try {
    if (recentBackup === null) {
      if (fs.existsSync(recentFile)) fs.rmSync(recentFile);
    } else {
      fs.writeFileSync(recentFile, recentBackup);
    }
    if (approvedBackup === null) {
      if (fs.existsSync(approvedFile)) fs.rmSync(approvedFile);
    } else {
      fs.writeFileSync(approvedFile, approvedBackup);
    }
    console.log('[smoke] store (recent + approved-writable) restored');
  } catch (e) {
    console.log('[smoke] restore store failed:', String(e));
  }
}

/**
 * b1 的**前置读数**（node 侧只读 store 文件，不写）：把「只读门到底成不成立」拆开摆出来。
 *
 * 门的口径是 `isErbLike ∧ ¬inWorkspace ∧ ¬canEdit`（`lift-preview.ts`），其中
 * `inWorkspace` 看 `workspace_roots.txt`、`canEdit` 看「直连门（WebView localStorage）」+
 * `approved-writable.json`。**单看 approved-writable 判不出只读态**——批准过写权限但直连门
 * 关着，ERB 照样只读、照样该弹解锁窗；这条读数的作用是把那种猜测当场证伪/证实。
 */
function storePrecheck() {
  const low = (s) => String(s).toLowerCase();
  let approvedDirs = [];
  let approvedHasRoot = false;
  try {
    const j = JSON.parse(fs.readFileSync(approvedFile, 'utf-8'));
    const key = low(GAME_DIR);
    approvedHasRoot = Object.prototype.hasOwnProperty.call(j, key);
    approvedDirs = approvedHasRoot ? (j[key] ?? []) : [];
  } catch {
    approvedDirs = ['（approved-writable.json 读不到）'];
  }
  let wsRoots = [];
  try {
    wsRoots = fs
      .readFileSync(path.join(path.dirname(path.dirname(storeDir)), 'workspace_roots.txt'), 'utf-8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    wsRoots = [];
  }
  return {
    approvedHasRoot,
    approvedDirs,
    workspaceRoots: wsRoots,
    gameDirIsWorkspace: wsRoots.some((r) => low(GAME_DIR).startsWith(low(r) + '\\') || low(GAME_DIR).startsWith(low(r) + '/')),
  };
}

/** 预检：等两个端口都空闲（上一轮遗留进程会占用，直接起会互相干扰） */
async function waitPortsFree(vitePort, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // 两个地址族都算占用：只挂 [::1] 的 vite 会让 127.0.0.1 检查放行，localhost 随后把壳带歪
    const busy = (await portBusy(vitePort)) || (await portBusy(CDP_PORT));
    if (!busy) return;
    console.log(`[smoke] ports busy (${vitePort}/${CDP_PORT}), waiting for previous run to release …`);
    await sleep(3000);
  }
  console.log('[smoke] ports still busy after wait; proceeding anyway');
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  seedRecent();
  let dev;
  try {
    dev = devTarget(ROOT);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(2);
  }
  await waitPortsFree(dev.port);

  // WebView2 画像：操作者显式给了就照用（并且**不动它**），否则本工具自带一具新鲜隔离画像。
  const ownedWebviewDir = !process.env.WEBVIEW2_USER_DATA_FOLDER;
  const webviewDir = ownedWebviewDir ? WEBVIEW2_DIR : process.env.WEBVIEW2_USER_DATA_FOLDER;
  if (ownedWebviewDir) {
    try {
      fs.rmSync(webviewDir, { recursive: true, force: true });
    } catch {}
  }
  console.log('[smoke] launching tauri dev (Vite %d%s, CDP %d, WebView2 画像 %s%s) …',
    dev.port, dev.tauriArgs.length > 0 ? ` 来自 KOJO_SMOKE_VITE_PORT` : '',
    CDP_PORT, webviewDir, ownedWebviewDir ? '，跑完删除' : '，操作者指定，保留');
  const devCmd = ['pnpm --filter @kojo/app tauri dev', ...dev.tauriArgs.map((a) => `"${a}"`)].join(' ');
  const child = spawn(devCmd, {
    shell: true,
    cwd: ROOT,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: webviewDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));
  let exited = false;
  child.on('exit', (code) => {
    exited = true;
    output += `\n[smoke] child exited ${code}`;
  });

  let cdp = null;
  const killTree = () => {
    cdp?.close();
    if (!exited && child.pid) {
      try {
        spawnSync(`taskkill /PID ${child.pid} /T /F`, { shell: true, stdio: 'ignore' });
      } catch {}
    }
  };

  try {
    // 1) 等 CDP + 页面就绪
    let wsUrl = null;
    const waitStart = Date.now();
    while (Date.now() - waitStart < 180000) {
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
          const ok = await waitFor(cand, 'document.body && document.body.innerText.includes("kojo-editor")', 90000);
          if (ok) {
            cdp = cand;
            break;
          }
          cand.close();
        } catch {}
      }
      await sleep(1500);
    }
    if (!cdp) throw new Error('CDP page never became ready');
    const pageHref = await assertPageOrigin(cdp, dev.origin);
    console.log(`[smoke] page ready ✓（${pageHref}）`);

    // 探明 IPC 通道
    const bridgeProbe = await cdp.evalJs(`(() => ({
      hasInternals: '__TAURI_INTERNALS__' in window,
      hasGlobal: '__TAURI__' in window,
    }))()`);
    console.log('[smoke] bridge:', JSON.stringify(bridgeProbe));
    const INV = `(cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args ?? {})`;

    const appData = await cdp.evalJs(`(${INV})('app_data_dir')`);
    console.log('[smoke] appDataDir =', appData);

    /* -------- a) 打开真实游戏目录（点最近打开的对应条目） -------- */
    await waitFor(cdp, recentRowWaitSrc(JSON.stringify(GAME_DIR)), 30000);
    const clicked = await cdp.evalJs(recentRowClickSrc(JSON.stringify(GAME_DIR)));
    if (clicked !== 'clicked') throw new Error(`recent button click failed: ${clicked}`);
    // 等项目标识出现（openProject 期间会弹写权限确认）。
    // ⚠ 选择器口径（2026-10-13 修）：UI 重设计后**没有** `.project-header` / `.proj-dir` 了，
    //   项目根在工具栏左侧 `.tb-project` 的 **title** 上（可见文字是项目名，不是路径）。
    await waitFor(cdp, `!!document.querySelector('.tb-project')`, 120000);
    const projDir = await cdp.evalJs(`document.querySelector('.tb-project')?.title ?? ''`);
    if (projDir === GAME_DIR) P('a', '打开真实游戏目录', `工具栏项目标签 rootDir=${projDir}`);
    else F('a', '打开真实游戏目录', `期望 ${GAME_DIR}，实际 ${projDir}`);

    /* -------- 批准写权限（若弹窗）+ 同屏其它首次引导 -------- */
    // 弹窗在 openProject 末尾异步 setState，稍等再判定。
    // 开项目后不止「写权限确认」一种模态：会话恢复带 ERB 标签会先弹「.kojo 预览」首次引导
    // （上游 2026-10-17 新增）。逐朵按白名单答掉；不认识的模态由 helper 抛错并打出按钮原文
    // ——不瞎点，免得替作者动用户数据。
    await sleep(2000);
    const asks = await answerAskDialogs(cdp, { log: (m) => console.log(`[smoke] ${m}`) });
    const approved = asks.answered.some((a) => a.button.includes('允许写入'));
    const others = asks.answered
      .filter((a) => !a.button.includes('允许写入'))
      .map((a) => `${a.aria}→${a.button}`);
    if (approved) {
      const extra = others.length > 0 ? `（同轮还答掉：${others.join('，')}）` : '';
      P('a2', '批准写权限对话框', `点击「允许写入」→ 弹窗关闭${extra}`);
    } else if (asks.modals.length === 0) {
      S('a2', '批准写权限对话框', '未弹出（该目录已有批准记录）');
    } else if (asks.answered.length > 0) {
      S('a2', '批准写权限对话框', `未弹出（该目录已有批准记录）；同轮答掉：${others.join('，')}`);
    } else {
      F('a2', '批准写权限对话框', '屏上模态里没有可答的白名单按钮');
    }

    // 等索引完成（状态栏 `.sb-idx` 不再含省略号：索引中显示「索引构建中…」）
    try {
      await waitFor(
        cdp,
        `(document.querySelector('.sb-idx') && !document.querySelector('.sb-idx').innerText.includes('…')) || false`,
        180000,
      );
    } catch (e) {
      const dump = await cdp.evalJs(`(() => ({
        href: location.href,
        header: !!document.querySelector('.tb-project'),
        stats: document.querySelector('.sb-idx')?.innerText ?? null,
        welcome: !!document.querySelector('.welcome'),
        bodyText: (document.body?.innerText ?? '').slice(0, 400),
      }))()`);
      throw new Error(`stats never settled: ${JSON.stringify(dump)}`);
    }
    const stats = await cdp.evalJs(`document.querySelector('.sb-idx').innerText.replace(/\\n/g,' ')`);
    console.log('[smoke] project stats:', stats);

    /* -------- b) 域内写：编辑 + 保存 + 落盘 + 备份 -------- */
    // 展开所有角色组露出文件行（工具条六按钮已撤，「展开全部」不再存在）：组默认全折叠，
    // 首轮把每个组头点一次即全开；一旦见到 .tree-file 就返回 true 停手，不再点（避免 toggle 开合）。
    try {
      await waitFor(
        cdp,
        `(() => {
          if (document.querySelectorAll('.tree-file').length > 0) return true;
          document.querySelectorAll('.tree-group-btn').forEach((b) => b.click());
          return false;
        })()`,
        30000,
      );
    } catch (e) {
      const dump = await cdp.evalJs(`(() => ({
        stats: document.querySelector('.sb-idx')?.innerText ?? null,
        sidebarText: (document.querySelector('.sidebar')?.innerText ?? '').slice(0, 400),
        groupBtns: document.querySelectorAll('.tree-group-btn').length,
        groups: document.querySelectorAll('.tree-groups').length,
        loading: !!document.querySelector('.tree-loading'),
        filePanel: !!document.querySelector('.file-panel'),
      }))()`);
      throw new Error(`tree-file never appeared: ${JSON.stringify(dump)}`);
    }
    const targetFile = await cdp.evalJs(`(() => {
      const b = document.querySelector('.tree-file');
      if (!b) return null;
      b.click();
      return b.title || null;
    })()`);
    // 等编辑器就绪
    await waitFor(cdp, `!!document.querySelector('.editor-body .monaco-editor')`, 30000);
    await sleep(1500);
    const loadedLabel = await cdp.evalJs(`document.querySelector('.file-label')?.title ?? ''`);
    const filePath = loadedLabel || targetFile;

    const originalBytes = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
    const marker = `;kojo-smoke-${Date.now()}`;
    const backupRoot = path.join(appData, 'backup');
    const backupsBefore = listBackups(backupRoot);

    // 聚焦编辑器中心 + 插入 marker
    const box = await cdp.evalJs(`(() => {
      const el = document.querySelector('.editor-body .monaco-editor');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + Math.min(r.height/2, 200)) };
    })()`);
    if (!box) throw new Error('editor box not found');
    await cdp.click(box.x, box.y);
    await sleep(400);

    // 2026-10-13：游戏目录里的 ERB **默认只读**（ADR-0005 轴一）。此时 insertText 会被 Monaco
    // 整个吞掉——那是产品正确行为，不是探针该绕过去的坑；探针因此**显式走一遍轴二解锁**，
    // 顺便把屏上文案钉成断言（清单 7.17 / 7.20 的机器半边）。
    // 2026-10-14 只读面去重：全站只剩**一颗** `.sb-writable`——底部状态栏那颗，且它按**当前打开
    // 文件所在的区域**上色 ⇒ 口上区这份 ERB 上它恒为「只读」（点了就是重新批准写权限）。
    // "这份文件此刻能不能写"不在状态栏，在工具条：
    //   已解锁 = `.erb-mode-hint.unlocked`（文案「已解锁编辑」）· 直连 = `.erb-mode-hint.direct`；
    // 两处都没有，才轮到状态栏那颗读成 locked。
    const readPill = () =>
      cdp.evalJs(`(() => {
        const un = document.querySelector('.erb-mode-hint.unlocked');
        if (un) return ['unlocked', (un.textContent ?? '').trim()];
        const direct = document.querySelector('.erb-mode-hint.direct');
        if (direct) return ['editable', (direct.textContent ?? '').trim()];
        const ro = document.querySelector('.sb-writable.ro');
        if (ro) return ['locked', (ro.textContent ?? '').trim()];
        return ['editable', ''];
      })()`);
    // 首次打开游戏目录 ERB 会问一次「要开启 .kojo 预览吗」——那也是一朵 `.modal`。
    // 探针要的是**原文可编辑**，所以先答「不用」把局面清干净，免得后面等解锁弹窗时等错一朵。
    // （2026-10-14 起这朵弹窗真的会出现：预览已摘出封存总闸，默认关，首次询问是它的发现路径。）
    // **重试式**（HK-28 照 smoke-editor-features 的 `dismissIntroIfAny`）：这朵弹窗在 filePath
    // effect 里 setState，晚于文件标签出现；单次判定会把「还没弹」读成「没有弹窗」，
    // 于是打字打在还开着的 `.modal-mask` 上——焦点被遮罩吃掉，只读事件永远不发生。
    const dismissIntro = async () =>
      cdp.evalJs(`(() => {
        const m = document.querySelector('.modal[aria-label=".kojo 预览"]');
        if (!m) return 'no-intro';
        const b = [...m.querySelectorAll('.modal-actions button')].find(e => e.textContent.trim() === '不用');
        if (b) b.click();
        return 'intro-dismissed';
      })()`);
    let intro = 'no-intro';
    for (let i = 0; i < 3; i++) {
      intro = await dismissIntro();
      if (intro === 'intro-dismissed') break;
      await sleep(900);
    }
    console.log(`[smoke] .kojo 预览 引导弹窗：${intro}`);
    if (intro === 'intro-dismissed') {
      await waitFor(cdp, `!document.querySelector('.modal')`, 10000);
      await sleep(400);
    }
    // 无论有没有引导弹窗，打字前都把焦点真点回编辑器中心。
    await cdp.click(box.x, box.y);
    await sleep(300);

    const [mode0, pill0] = await readPill();
    console.log(`[b1-diag] readPill=${mode0}/${pill0} 现场读数=${JSON.stringify(await editorReadout(cdp))}`);
    console.log(`[b1-diag] store 前置=${JSON.stringify(storePrecheck())}`);
    if (mode0 === 'locked') {
      if (pill0 !== '只读') F('b0', '只读胶囊文案', `期望「只读」，实际「${pill0}」`);
      else P('b0', '只读胶囊文案', '屏上原样＝「只读」（无 🔒 字符）');
      const route = await attemptReadonlyTyping(cdp);
      if (route === 'no-modal') {
        F('b1', '轴二解锁（游戏目录 ERB）',
          `两路合成按键都没弹出只读保护弹窗（keyDown+text / rawKeyDown+char+keyUp 各试一次）；` +
          `此刻读数=${JSON.stringify(await editorReadout(cdp))}——按读数分「没焦点/没只读」与「按键通道失效」`);
        throw new Error('b1: unlock modal never appeared');
      }
      const dlg = await cdp.evalJs(`(() => {
        const m = document.querySelector('.modal[aria-label="ERB 只读保护"], .modal[aria-label="文件只读保护"]');
        if (!m) return null;
        return { label: m.getAttribute('aria-label'), h2: (m.querySelector('h2')?.textContent ?? '').trim(),
                 btns: [...m.querySelectorAll('.modal-actions button')].map((e) => e.textContent.trim()) };
      })()`);
      const unlockClick = await cdp.evalJs(`(() => {
        const b = [...document.querySelectorAll('.modal-actions button')].find(e => e.textContent.includes('仍要直接编辑'));
        if (!b) return 'no-unlock-button';
        b.click();
        return 'unlocked-click';
      })()`);
      if (unlockClick !== 'unlocked-click') throw new Error(`erb unlock failed: ${unlockClick}`);
      await waitFor(cdp, `!!document.querySelector('.erb-mode-hint.unlocked')`, 15000);
      P('b1', '轴二解锁（游戏目录 ERB）',
        `按键路=${route} → 弹窗「${dlg ? dlg.label + '／' + dlg.h2 : '(aria-label 未匹配，仍按 .modal 命中)'}」` +
        `按钮=${dlg ? dlg.btns.join('、') : '—'} → 「仍要直接编辑」→ 工具条转「已解锁编辑」（底栏那颗按区域仍读作「只读」）`);
    } else {
      // 'unlocked' = 上一段真解锁过；其余（'editable'）= 直连门被串开了 ⇒ 只读前置不存在。
      // 两者都是**环境**问题不是代码问题，但都不许当 PASS 也不算 SKIP：报 FAIL 带读数。
      const why = mode0 === 'unlocked' ? '开局已是解锁态' : '直连可编辑（画像串味：localStorage 里直连门是开的）';
      S('b0', '只读胶囊文案', `${why}（${pill0}）`);
      F('b1', '轴二解锁（游戏目录 ERB）',
        `只读前置不成立：${why}；读数=${JSON.stringify(await editorReadout(cdp))} ` +
        `store 前置=${JSON.stringify(storePrecheck())}`);
    }

    await cdp.insertText(`\n${marker}\n`);
    await sleep(800);
    const dirty = await cdp.evalJs(`!!document.querySelector('.dirty-dot.on')`);
    if (!dirty) throw new Error('editor not marked dirty after insertText');
    // 点保存
    const saveClick = await cdp.evalJs(`(() => {
      const b = document.querySelector('.editor-toolbar button.primary.small');
      if (b && !b.disabled) { b.click(); return 'saved-click'; }
      return b ? 'save-disabled' : 'no-save-button';
    })()`);
    // 等保存完成（状态显示"已保存"）；超时把「按钮当时点没点动 / 状态行原文 / 有没有模态」
    // 一起带出来——只留一个 last=false 会让人白跑一轮（实测过一次）。
    try {
      await waitFor(cdp, `/已保存/.test(document.querySelector('.editor-status')?.innerText ?? '')`, 20000, 500);
    } catch (e) {
      const why = await cdp.evalJs(`(() => ({
        保存按钮: (() => { const b = document.querySelector('.editor-toolbar button.primary.small'); return b ? { text: b.textContent.trim(), disabled: b.disabled } : null; })(),
        状态行: document.querySelector('.editor-status')?.innerText ?? null,
        脏点: !!document.querySelector('.dirty-dot.on'),
        模态: [...document.querySelectorAll('.modal')].map((m) => m.getAttribute('aria-label')),
      }))()`);
      throw new Error(`${e.message}｜点击=${saveClick}｜现场=${JSON.stringify(why)}`);
    }

    const onDisk = fs.existsSync(filePath) ? fs.readFileSync(filePath).toString('utf-8') : '';
    const backupsAfter = listBackups(backupRoot);
    const newBackups = [...backupsAfter.keys()].filter((k) => !backupsBefore.has(k) || backupsAfter.get(k) !== backupsBefore.get(k));
    const wroteOk = onDisk.includes(marker);
    const backupOk = newBackups.length > 0;
    if (wroteOk && backupOk) {
      P('b', '域内写正常', `落盘含 marker ✓；备份新增 ${newBackups.length} 个 .bak（例：${newBackups[0] ?? ''}）`);
    } else {
      F('b', '域内写正常', `落盘=${wroteOk} 备份=${backupOk} file=${filePath}`);
    }
    // 还原被改文件（保持测试游戏目录内容不变）
    if (originalBytes) {
      try {
        fs.writeFileSync(filePath, originalBytes);
        console.log('[smoke] restored original bytes to', filePath);
      } catch (e) {
        console.log('[smoke] restore file failed:', String(e));
      }
    }

    /* -------- c) 域外写被拒（devtools console 式 invoke） -------- */
    const cResult = await cdp.evalJs(`(async () => {
      const inv = ${INV};
      try {
        await inv('write_file_bytes', { path: ${JSON.stringify(OUTSIDE_PATH)}, data: btoa('evil') });
        return { ok: true, err: null };
      } catch (e) { return { ok: false, err: String(e) }; }
    })()`);
    if (!cResult.ok && /可写范围拒绝/.test(cResult.err)) {
      P('c', '域外写被拒', `拒绝且文案含「可写范围拒绝」: ${cResult.err.slice(0, 90)}`);
    } else if (!cResult.ok) {
      F('c', '域外写被拒', `被拒但文案不含预期关键字: ${cResult.err}`);
    } else {
      F('c', '域外写被拒', '写入未被拒绝（安全缺陷！）');
    }

    /* -------- e) appDataDir 写正常 -------- */
    const ePath = path.join(appData, '_kojo_smoke', 'probe.txt');
    const eResult = await cdp.evalJs(`(async () => {
      const inv = ${INV};
      try {
        await inv('ensure_dir', { path: ${JSON.stringify(path.join(appData, '_kojo_smoke'))} });
        await inv('write_file_bytes', { path: ${JSON.stringify(ePath)}, data: btoa('appdata-ok') });
        return { ok: true, err: null };
      } catch (e) { return { ok: false, err: String(e) }; }
    })()`);
    const eOnDisk = fs.existsSync(ePath) && fs.readFileSync(ePath).toString('utf-8') === 'appdata-ok';
    if (eResult.ok && eOnDisk) P('e', 'appDataDir 写正常', `写入并可读回 ${ePath}`);
    else F('e', 'appDataDir 写正常', `invoke=${JSON.stringify(eResult)} onDisk=${eOnDisk}`);

    /* -------- d) 关闭项目后再写游戏目录 → 被拒 -------- */
    // ⚠ C-1a 起「关闭项目」从工具栏右区收进项目名旁「更多」⋯ 菜单（共享 ContextMenu）：
    //   先点触发器、等一帧渲染出菜单项，再点 role=menuitem 的「关闭项目」。
    //   这里必须**断言点到了**：静默 no-op 会让本项在没有关闭动作的情况下"通过"。
    const closeClick = await cdp.evalJs(`(async () => {
      const trigger = document.querySelector('.toolbar button[title="项目操作（关闭项目）"]');
      if (!trigger) return 'no-menu-trigger';
      trigger.click();
      await new Promise((r) => setTimeout(r, 200));
      const item = [...document.querySelectorAll('button[role="menuitem"]')].find(e=>e.textContent.includes('关闭项目'));
      if (!item) return 'no-close-menuitem';
      item.click(); return 'closed-click';
    })()`);
    if (closeClick !== 'closed-click') throw new Error(`close-project click failed: ${closeClick}`);
    await waitFor(cdp, `!!document.querySelector('.welcome')`, 30000);
    const dPath = path.join(GAME_DIR, '_kojo_smoke_after_close.txt');
    const dResult = await cdp.evalJs(`(async () => {
      const inv = ${INV};
      try {
        await inv('write_file_bytes', { path: ${JSON.stringify(dPath)}, data: btoa('nope') });
        return { ok: true, err: null };
      } catch (e) { return { ok: false, err: String(e) }; }
    })()`);
    if (!dResult.ok && /可写范围拒绝/.test(dResult.err)) {
      P('d', '关闭项目后写游戏目录被拒', `拒绝且文案含「可写范围拒绝」: ${dResult.err.slice(0, 90)}`);
    } else if (!dResult.ok) {
      F('d', '关闭项目后写游戏目录被拒', `被拒但文案不含预期关键字: ${dResult.err}`);
    } else {
      F('d', '关闭项目后写游戏目录被拒', '写入未被拒绝（安全缺陷！）');
    }

    // 清场：appData 探针文件
    try {
      await cdp.evalJs(`(async () => { const inv = ${INV};
        await inv('remove_file', { path: ${JSON.stringify(ePath)} }); return true; })()`);
    } catch {}
    try {
      if (fs.existsSync(OUTSIDE_PATH)) fs.rmSync(OUTSIDE_PATH);
      if (fs.existsSync(dPath)) fs.rmSync(dPath);
    } catch {}
    // 清场：本次冒烟新增的备份 .bak（内容为被测文件原始版本，删除不影响仓库与游戏目录真身）
    try {
      for (const b of newBackups) if (fs.existsSync(b)) fs.rmSync(b);
    } catch {}
    try {
      const smokeDir = path.join(appData, '_kojo_smoke');
      if (fs.existsSync(smokeDir)) fs.rmSync(smokeDir, { recursive: true, force: true });
    } catch {}

    console.log('[smoke] stats:', stats);
  } catch (e) {
    rec('!!', '未捕获异常', 'FAIL', String(e).slice(0, 500));
  } finally {
    killTree();
    restoreStore();
    dev.cleanup();
    if (ownedWebviewDir) await removeDirRetry(webviewDir, 'WebView2 隔离画像');
  }

  /* ------------------------------ 汇总 ------------------------------ */
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n================ 冒烟汇总 ================');
  for (const r of results) console.log(`${r.status.padEnd(4)} ${r.id.padEnd(3)} ${r.name}: ${r.detail}`);
  console.log(`共 ${results.length} 项；FAIL ${failCount}`);
  console.log(failCount === 0 ? '✅ tauri IPC 冒烟全部通过' : '❌ tauri IPC 冒烟存在失败项');
  process.exit(failCount === 0 ? 0 : 1);
}

/** 删临时目录（WebView2 进程收尾要几秒，EBUSY/EPERM 就重试；失败只报不抛） */
async function removeDirRetry(dir, label) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[smoke] ${label} 已删除：${dir}`);
      return;
    } catch (e) {
      if (attempt === 4) console.log(`[smoke] ${label} 删除失败（${dir}）：${String(e)}`);
      else await sleep(1500);
    }
  }
}

/** 列 backup 目录下全部 .bak → Map(绝对路径 -> mtimeMs) */
function listBackups(root) {
  const map = new Map();
  if (!fs.existsSync(root)) return map;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.bak')) {
        try {
          map.set(p, fs.statSync(p).mtimeMs);
        } catch {}
      }
    }
  };
  walk(root);
  return map;
}

main();