/**
 * 调试模式共享库（2026-10-24 调试模式批）：`debug-cli.mjs` / `debug-web-smoke.mjs`
 * 共用的端口探测、浏览器发现、极小 CDP 客户端与「等页内条件」工具。
 *
 * 刻意零依赖（node 内置 + 全局 WebSocket/fetch，Node ≥22 自带）——与本仓工具链同口径。
 * 这里**不含**任何业务判据：只做传输与发现，判定留给消费方。
 */
import { spawnSync } from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 调试模式的默认根落点：**系统临时目录**（`<tmp>/kojo-debug/`），不在仓库里。
 *
 * 为什么（2026-10-24 实测教训，见 PITFALLS 189 的姊妹坑）：放仓库内时，
 * 任何对仓库建整树 watcher 的工具（如 conformance CLI 载 vite）都会扫到
 * browser-profile 里被 Edge 锁住的文件（Cookies EBUSY）直接崩——调试模式的
 * 残留不该有能力弄红别人的测试。`KOJO_DEBUG_HOME` 可整体搬走（想放仓库时
 * 记得 `.kojo-debug/` 已在 .gitignore，且 app 的 vite watch 已忽略它）。
 */
export function debugHome() {
  return process.env.KOJO_DEBUG_HOME
    ? path.resolve(process.env.KOJO_DEBUG_HOME)
    : path.join(os.tmpdir(), 'kojo-debug');
}

/**
 * 会话按**仓库工作树**自动隔离（2026-10-25 多 agent 并发反馈，PITFALLS 192）：
 * `<home>/sessions/<工作树路径短哈希>/`——session.json / sandbox / appdata / browser-profile
 * 全在其中。同一棵树共享一个会话；**跨工作树互不可见、互不可杀**（本机多 agent 并发的
 * 「量到别人的树」由构造消除）。`KOJO_DEBUG_SESSION_NAME` 可显式命名（同树第二个会话 /
 * 跨工具对齐），`KOJO_DEBUG_SESSION` 仍可直接指会话文件（最高优先）。
 */
export function sessionKey(repoRoot) {
  const custom = process.env.KOJO_DEBUG_SESSION_NAME;
  if (custom && custom.trim() !== '') {
    return custom.trim().replace(/[^\w.-]/g, '-').slice(0, 40);
  }
  // FNV-1a 短哈希：路径小写归一（Windows 大小写不敏感），8 位十六进制够区分且目录名友好
  let h = 0x811c9dc5;
  for (const ch of path.resolve(repoRoot).toLowerCase()) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function sessionDir(repoRoot) {
  return path.join(debugHome(), 'sessions', sessionKey(repoRoot));
}

/**
 * 杀掉「命令行里带 <mark>」的进程（Windows 实测：Edge 的子进程会逃出 taskkill /T
 * 的树，profile 被锁 ⇒ 目录清不掉 ⇒ 下一轮撞 EBUSY）。经临时 .ps1 执行——
 * Git-Bash 里内联 PowerShell 会被 `$_` 展开搅碎（本批实测）。尽力而为，非 Windows 跳过。
 */
export function killProcessesMarked(mark) {
  if (process.platform !== 'win32') return;
  try {
    const home = debugHome();
    fs.mkdirSync(home, { recursive: true });
    const script = path.join(home, `kill-marked-${process.pid}.ps1`);
    fs.writeFileSync(
      script,
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${mark.replace(/'/g, "''")}*' } | ForEach-Object {\n` +
        `  if ($_.ProcessId -ne $PID) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\n` +
        `}\n`,
      'utf8',
    );
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'ignore' });
    try { fs.rmSync(script, { force: true }); } catch {}
  } catch {}
}

/** 两个协议栈都试（vite 在部分 Windows 只绑 ::1，同 §5.117 的教训） */
export async function portOpen(port) {
  for (const host of ['127.0.0.1', '::1']) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, host);
      s.setTimeout(600);
      s.on('connect', () => { resolve(true); s.destroy(); });
      s.on('error', () => resolve(false));
      s.on('timeout', () => { resolve(false); s.destroy(); });
    });
    if (ok) return true;
  }
  return false;
}

export async function freePort(start) {
  for (let p = start; p < start + 200; p++) {
    if (!(await portOpen(p))) return p;
  }
  throw new Error(`从 ${start} 起 200 个端口都被占用`);
}

/** Chrome / Edge / Chromium 发现（KOJO_DEBUG_BROWSER 可指定；找不到 ⇒ null，由调用方定退路） */
export function findBrowser(explicit) {
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit;
    throw new Error(`指定的浏览器不存在：${explicit}`);
  }
  if (process.env.KOJO_DEBUG_BROWSER && fs.existsSync(process.env.KOJO_DEBUG_BROWSER)) {
    return process.env.KOJO_DEBUG_BROWSER;
  }
  const cands = [];
  if (process.platform === 'win32') {
    const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
      .filter(Boolean);
    for (const base of pf) {
      cands.push(
        path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      );
    }
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'msedge']) {
      const w = spawnSync('which', [name]);
      if (w.status === 0) cands.push(w.stdout.toString().trim().split('\n')[0]);
    }
  }
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

/** 极小 CDP 客户端：一条 WebSocket、id 配对、可选事件订阅 */
export class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method && this.handlers.has(msg.method)) {
        for (const h of this.handlers.get(msg.method)) h(msg.params ?? {});
      }
    };
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 8000);
      this.ws.onopen = () => { clearTimeout(t); resolve(); };
      this.ws.onerror = () => { clearTimeout(t); reject(new Error('CDP WebSocket 连接失败')); };
    });
    return this;
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(handler);
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      // 定时器必清（2026-10-25 自审）：成功路径不清会每条命令漏一个 30s timer＋闭包，
      // 长会话里数万条 send 就是数万个待触发的空拒绝与内存滞留
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try { this.ws.close(); } catch {}
  }
  /** 页内求值（awaitPromise；returnByValue 原样带回对象） */
  async evalJs(expression, timeoutMs = 20000) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      timeout: timeoutMs,
    });
    if (r.exceptionDetails) {
      throw new Error(`页内求值抛错：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result?.value;
  }
  async screenshot(fullPage = false) {
    // 反哺修（2026-10-25）：切主题 / Monaco 重绘后直接拍会拿到**缓存帧**（实测两帧 PNG 逐字节
    // 相同）。拍前两步强制产新帧：① bringToFront 把该页设为活动页；② 双 rAF 等一帧完整
    // 合成（后台页 rAF 可能停 ⇒ 300ms 兜底竞速，拿不到也不阻塞拍照本身）。
    await this.send('Page.enable').catch(() => {});
    await this.send('Page.bringToFront').catch(() => {});
    await this.evalJs(
      `new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(true); } };
        try { requestAnimationFrame(() => requestAnimationFrame(finish)); } catch { finish(); }
        setTimeout(finish, 300);
      })`,
      3000,
    ).catch(() => {});
    let clip;
    if (fullPage) {
      const metrics = await this.send('Page.getLayoutMetrics');
      const { width, height } = metrics.cssContentSize ?? metrics.contentSize ?? {};
      clip = { x: 0, y: 0, width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), scale: 1 };
    }
    const shot = await this.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      ...(clip ? { captureBeyondViewport: true, clip } : {}),
    });
    return Buffer.from(shot.data, 'base64');
  }
}

/**
 * 从 CDP /json 里挑页面：**只认属于本次 vite 端口的那页**，找不到返回 null。
 * 不做「随便兜第一页」——实测坑（2026-10-25）：旧会话的僵尸浏览器占着 CDP 端口时，
 * 兜底会抓到别人的死页面，驱动全部落空还查不出原因。调用方对 null 自己显式处理。
 */
export async function cdpPage(cdpPort, vitePort) {
  const list = await (
    await fetch(`http://127.0.0.1:${cdpPort}/json`, { signal: AbortSignal.timeout(3000) })
  ).json();
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  return pages.find((t) => String(t.url).includes(`:${vitePort}`)) ?? null;
}

/** 轮询页内表达式直到真值 / 非空串；超时抛错（不静默） */
export async function waitFor(cdp, expression, { timeoutMs = 30000, intervalMs = 300, label = '' } = {}) {
  const started = Date.now();
  let lastErr = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const v = await cdp.evalJs(expression, 5000);
      if (v === true) return true;
      if (v !== false && v !== null && v !== undefined && v !== '') return v;
    } catch (err) {
      lastErr = String(err?.message ?? err);
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label || expression}${lastErr ? `；最后一错：${lastErr}` : ''}`);
}

/** CDP 真实点击：元素中心 → elementFromPoint 自证（被遮挡时告警不冒充成功）→ Input 派发 */
export async function cdpClick(cdp, selector) {
  const center = await cdp.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!center) throw new Error(`页面上没有 ${selector}`);
  const hit = await cdp.evalJs(
    `(() => { const el = document.elementFromPoint(${center.x}, ${center.y}); return el ? (el.closest(${JSON.stringify(selector)}) !== null) : false; })()`,
  );
  if (!hit) console.warn(`[debug] ⚠ elementFromPoint 未命中 ${selector}（可能被遮挡）——仍按坐标点击`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: center.x, y: center.y, button: 'left', clickCount: 1 });
  }
  return center;
}

/**
 * 关闭首启「开发者的碎碎念」纸条（dev-note）。要点：它是**懒挂载**的——App.tsx 的
 * Suspense fallback 本身就是一层 `.modal-mask`（`[data-lazy-mount="dev-note"]`），
 * 「检查那一刻还没弹 ⇒ 放行」是挂载竞态（2026-10-26 debug-web-smoke 实拍：`.welcome-open`
 * 的点击被随后 0.5s 内弹上的遮罩吃掉，60s 后才红）。所以等到**懒加载落定**为止：
 * 纸条在场 ⇒ 真实路径关闭（ghost=先看看，同档案记「看过」不再弹）；fallback 遮罩在场 ⇒ 再等；
 * 两者皆无 ⇒ 屏幕干净返回 true。超时仍有真纸条 ⇒ false（调用方决定是否红，不静默）。
 */
export async function dismissDevNoteMask(cdp, { timeoutMs = 6000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let closeTries = 0;
  for (;;) {
    if (await cdp.evalJs('!!document.querySelector(".dev-note-mask")')) {
      if (++closeTries > 3) return false; // 点了三次还在 ⇒ 如实交红，不死循环
      await cdpClick(cdp, '.dev-note-actions .ghost').catch(() => {});
      await sleep(250);
      continue;
    }
    if (Date.now() >= deadline) return false;
    const pending = await cdp.evalJs(`!!document.querySelector('[data-lazy-mount="dev-note"]')`);
    if (!pending) {
      // 冷 vite 上懒 chunk 可能恰在检查后挂上来：给一个短窗复核，无弹即干净
      await sleep(300);
      if (await cdp.evalJs('!!document.querySelector(".dev-note-mask")')) continue;
      return true;
    }
    await sleep(250);
  }
}

/**
 * 文件树逐层展开，直到出现文件行（`.tree-file`）或无可再点。
 * 树的顶层是**角色分组**（`.tree-group-btn`，eraTW 家族视图），展开后才有目录
 * （`.tree-dir`）与文件行——三种子都按「未点过的先点」逐个展开。
 * 页内状态 `__kojoDebugTreeClicks` 记已点过的行（按 title），不会把展开的再点回收起。
 * 返回：'file' / 'no-rows'（既无文件行也无分组、目录可点）。
 */
export async function expandTreeUntilFile(cdp, { maxRounds = 16, intervalMs = 250 } = {}) {
  for (let i = 0; i < maxRounds; i++) {
    if (await cdp.evalJs('!!document.querySelector(".tree-file")')) return 'file';
    const step = await cdp.evalJs(`(() => {
      globalThis.__kojoDebugTreeClicks ??= new Set();
      const key = (el) => el.getAttribute('title') || el.textContent;
      const rows = [...document.querySelectorAll('.tree-group-btn, .tree-dir')];
      const next = rows.find((el) => !globalThis.__kojoDebugTreeClicks.has(key(el)));
      if (!next) return 'no-rows';
      globalThis.__kojoDebugTreeClicks.add(key(next));
      next.scrollIntoView({ block: 'center' });
      next.click();
      return 'clicked';
    })()`);
    if (step !== 'clicked') return step;
    await sleep(intervalMs);
  }
  return (await cdp.evalJs('!!document.querySelector(".tree-file")')) ? 'file' : 'timeout';
}

/**
 * 文件树逐层展开，直到出现**含 `frag` 的文件行**（`debug-cli open-file` 专用）。
 *
 * 与 `expandTreeUntilFile` 的差别只有一条判据：后者只要树里有**任何**一行文件就收工
 * （它是给「先让树里有文件」的冒烟用的），于是 `open-file <另一组里的文件>` 会在已有
 * 命中行的情况下直接放弃 —— 树明明好好的、索引也在，却报「文件树里没有路径含…的行」
 * （1028 会话恢复批实测的假阴性源：恢复后树里只有被恢复那一份的行，另一组的文件一律
 * 打不开，看着像"树是空的"）。
 *
 * 这里改为按 `frag` 判定：命中即 `found`；未命中就继续点**下一个还没点过的折叠行**
 * （组头 / 目录 / 包，一律看 `aria-expanded="false"`，不把已展开的点回收起）。
 * `__kojoDebugTreeClicks` 与旧函数共用同一本账（同页多次 open-file 不会反复点同一行）。
 *
 * 已知边界：树是虚拟化的（视口外的整组只挂一条等高占位）⇒ `scrollIntoView` 把折叠行
 * 滚进视口后下一轮才点得到；实在点不到就返回 `no-rows`，由调用方如实报错，绝不猜。
 * 返回：'found' / 'no-rows' / 'timeout'。
 */
export async function expandCollapsedUntilMatch(cdp, frag, { maxRounds = 40, intervalMs = 200 } = {}) {
  const needle = JSON.stringify(String(frag));
  const hitExpr = `[...document.querySelectorAll('.tree-file')].some((r) => (r.getAttribute('title') || r.textContent || '').includes(${needle}))`;
  for (let i = 0; i < maxRounds; i++) {
    const step = await cdp.evalJs(`(() => {
      if (${hitExpr}) return 'found';
      globalThis.__kojoDebugTreeClicks ??= new Set();
      const key = (el) => el.getAttribute('title') || el.textContent;
      const collapsed = [...document.querySelectorAll('.tree-group-btn[aria-expanded="false"], .tree-dir[aria-expanded="false"], .tree-package[aria-expanded="false"]')];
      const next = collapsed.find((el) => !globalThis.__kojoDebugTreeClicks.has(key(el)));
      if (!next) return 'no-rows';
      globalThis.__kojoDebugTreeClicks.add(key(next));
      // 虚拟化树：先滚进视口再点（与 expandTreeUntilFile 同一手法），免得点在窗口外
      next.scrollIntoView({ block: 'nearest' });
      next.click();
      return 'clicked';
    })()`);
    if (step === 'found') return 'found';
    if (step !== 'clicked') return step;
    await sleep(intervalMs);
  }
  return (await cdp.evalJs(hitExpr)) ? 'found' : 'timeout';
}
