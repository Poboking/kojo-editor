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

/* ------------------------------ 内存预算（2026-10-31 反哺） ------------------------------ */

/**
 * 「无头浏览器跑到 1G 就被杀，是谁的限制」问诊结论（2026-10-31）：
 * 本仓**没有任何**浏览器内存闸——`js-flags` / `renderer-process-limit` / `disable-dev-shm`
 * 全零命中，给浏览器的参数只有 remote-debugging-port / user-data-dir / headless / window-size。
 * 杀来自容器 cgroup（Linux）或 Job Object（Windows）的上限，而内核按 RSS 挑最大的杀，
 * 常常正是渲染进程 ⇒ 现场伪装成「浏览器 bug」。本机实测（64GB，fixture=mini-game，
 * `--only semantic` 31s）：Node 侧 285~553MB、Edge 侧 690~890MB（瞬峰 2.0GB），
 * 合计稳态 1.0~1.2GB、峰值 2.6GB——**1G 下连地板都过不去**，不是泄漏。
 */
const MIB = 1024 * 1024;

/** 调试宿堆上限的缺省值与地板（MB）。缺省值＝原先写死的 `--max-old-space-size=4096`（常态逐字不变） */
export const HOST_HEAP_DEFAULT_MB = 4096;
export const HOST_HEAP_MIN_MB = 512;
/** 低于这个预算就别指望整条链跑得动（实测地板 1.0~1.2GB），调用方据此告警 */
export const MEMORY_TIGHT_MB = 2048;

/**
 * 读 cgroup 的内存上限（MB）；读不到（非 Linux / 无限制 / 全失败）⇒ null。
 *
 * 顺序：`/proc/self/cgroup` 指出的**子树**在前（容器里收紧通常落在子树上），再兜根部的
 * `memory.max`（v2）与 `memory.limit_in_bytes`（v1）；多处命中取最小。v1 的「无限制」
 * 写成一个天文数字、v2 写 `max`，这里统一当"没设"，折算交给 memoryBudget 按物理内存做。
 */
function readCgroupLimitMb(readFile) {
  const files = [];
  try {
    for (const line of String(readFile('/proc/self/cgroup')).split('\n')) {
      const m = /^0::(.*)$/.exec(line.trim());
      if (m) files.push(`/sys/fs/cgroup/${m[1].replace(/^\/+|\/+$/g, '')}/memory.max`.replace(/\/{2,}/g, '/'));
    }
  } catch {}
  files.push('/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes');
  let best = null;
  for (const f of files) {
    let raw;
    try {
      raw = String(readFile(f)).trim();
    } catch {
      continue;
    }
    if (!raw || raw === 'max') continue;
    const bytes = Number(raw);
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    const mb = Math.round(bytes / MIB);
    if (mb <= 0) continue;
    best = best === null ? mb : Math.min(best, mb);
  }
  return best;
}

/**
 * 本进程实际可用的内存预算（MB）＋来源。
 * `limitMb` 只在**严格低于物理内存**时才认：等于/高于物理内存的 cgroup 值与没设同义
 * （v1 无限制那枚约 9.2e18，不能当真的 90 亿 GB 去算堆）。
 * `readFile` / `platform` / `totalMb` 都可注入——判据要能在任何机器上单测。
 */
export function memoryBudget({
  platform = process.platform,
  totalMb = Math.round(os.totalmem() / MIB),
  readFile = (p) => fs.readFileSync(p, 'utf8'),
} = {}) {
  const cgroupMb = platform === 'linux' ? readCgroupLimitMb(readFile) : null;
  const limitMb = cgroupMb !== null && cgroupMb < totalMb ? cgroupMb : null;
  return { totalMb, limitMb, budgetMb: limitMb ?? totalMb, source: limitMb === null ? 'total' : 'cgroup' };
}

/**
 * 预算 ⇒ 调试宿 `--max-old-space-size`（MB）。
 *
 * 为什么不再写死 4096：大堆在 1G 环境里**帮倒忙**——V8 以为自己有四 GB 就不早 GC，
 * 容器 OOM 先到，内核挑 RSS 最大的杀；被杀的多半是渲染进程，现场看起来像"浏览器挂了"。
 * 收紧后同样的内存不够会变成 `JavaScript heap out of memory` 打在调试宿 stderr 上，
 * **责任方一眼可辨**（`watchChild` 还会把退出码记进 `session.exits`）。
 *
 * 0.45 的来历：调试宿只是三件套之一（还有 vite 与浏览器），且 V8 堆只是 RSS 的一部分
 * （Node 自身 + external + 栈另有 80~120MB）。64GB 本机算出 29GB ⇒ 夹回 4096，
 * **与旧行为逐字一致**；`KOJO_DEBUG_HOST_HEAP`（MB）可显式覆盖，复现旧行为也不用改代码。
 */
export function hostHeapMb({ budgetMb, overrideMb = null } = {}) {
  const override = Number(overrideMb);
  if (Number.isFinite(override) && override >= 128) return Math.round(override);
  if (!Number.isFinite(budgetMb) || budgetMb <= 0) return HOST_HEAP_DEFAULT_MB;
  const share = Math.floor(budgetMb * 0.45);
  return Math.max(HOST_HEAP_MIN_MB, Math.min(HOST_HEAP_DEFAULT_MB, share));
}

/** 一步到位：量环境 ⇒ 给预算。`budget` 可注入（默认现场量），便于单测声明式覆盖 */
export function resolveMemoryBudget(env = process.env, budget = memoryBudget()) {
  // Windows 容器（Job Object 上限）在进程内**读不到**，os.totalmem() 还常常报宿主总量；
  // 这种环境下 `KOJO_MEM_BUDGET_MB=<MB>` 就是唯一的真话来源。只在它**比探测值更小**时采信
  // （显式声明不该把大机器平白改小），256MB 以下当笔误。
  const declared = Number(env.KOJO_MEM_BUDGET_MB);
  if (Number.isFinite(declared) && declared >= 256 && declared < budget.budgetMb) {
    return { ...budget, limitMb: declared, budgetMb: declared, source: 'env' };
  }
  return budget;
}

/** 预算来源 → 人话（CLI / 冒烟的告警共用一份措辞） */
export function memorySourceLabel(source) {
  return source === 'cgroup' ? 'cgroup 上限' : source === 'env' ? 'KOJO_MEM_BUDGET_MB' : '物理内存';
}

/** 一步到位：量环境 ⇒ 给上限。`env` 只为可测（默认 process.env） */
export function resolveHostHeap(env = process.env) {
  const budget = resolveMemoryBudget(env);
  return { ...budget, heapMb: hostHeapMb({ budgetMb: budget.budgetMb, overrideMb: env.KOJO_DEBUG_HOST_HEAP }) };
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

/**
 * 目标点解析：所有指针原语共用的一段——**选择器 → 元素中心（视口坐标）**。
 *
 * 为什么要过一遍 `document.querySelector` 而不是让调用方传像素：选择器是断言的一环
 * （元素没了要当场红，不能静默点在空白处），而坐标是执行的一环。
 *
 * 为什么要 `elementFromPoint` 自证：`getBoundingClientRect` 给的是**布局位置**，
 * 布局位置可点不等于「点下去会落到它身上」——被 toast / 遮罩 / 粘性工具栏盖住时，
 * 事件会跑到覆盖层，测试便以「点了没反应」的形态假绿成「功能坏了」。这里如实告警
 * （不抛、不冒充成功），把「为什么没反应」留在日志里；要红由调用方的判定负责。
 *
 * 选择器找不到 ⇒ 抛带选择器原文的错；对象一律当坐标且必须有限数（NaN/undefined
 * 进 Input.dispatchMouseEvent 只会得到一条看不懂的 CDP 错误）。
 */
async function resolvePoint(cdp, target) {
  if (typeof target !== 'string') {
    const { x, y } = target ?? {};
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`坐标必须是有限数：${JSON.stringify(target)}`);
    }
    return { x, y };
  }
  const center = await cdp.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(target)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!center) throw new Error(`页面上没有 ${target}`);
  const hit = await cdp.evalJs(
    `(() => { const el = document.elementFromPoint(${center.x}, ${center.y}); return el ? (el.closest(${JSON.stringify(target)}) !== null) : false; })()`,
  );
  if (!hit) console.warn(`[debug] ⚠ elementFromPoint 未命中 ${target}（可能被遮挡）——仍按坐标操作`);
  return center;
}

/**
 * 拖拽中间帧：返回**从 from 走到 to 的 steps 个落点**（末点恒为 to），供 `cdpDrag` 逐帧派发。
 *
 * 为什么 drag 必须插中间帧：浏览器的拖拽不是「按下 + 抬起」两次事件就成立，而是
 * 由 `mousemove` 序列喂出来的——HTML5 dragstart / dragover / drop、以及自绘的分栏
 * 拖拽，都要在移动过程中累积位移、判定落区才有反应。只发 pressed → released，
 * 页面看到的是「在原地按了一下又松开」，于是拖文件不进编辑器、拖分栏不动。
 *
 * 退化与夹取：steps<1（含 0 / 负数 / NaN）退化为「一步到位」= 只有终点，避免空数组
 * 让 release 落在一个从未移动过的位置上；非整数取整（四舍五入，至少 1 步）；
 * 负坐标夹到 0（CDP 不认负的视口点，且负值通常是调用方算错的兜底）。
 */
export function mousePath(from, to, steps) {
  const n = Number.isFinite(steps) ? Math.max(1, Math.round(steps)) : 1;
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const fx = num(from?.x);
  const fy = num(from?.y);
  const tx = Math.max(0, num(to?.x));
  const ty = Math.max(0, num(to?.y));
  const path = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    path.push({ x: Math.max(0, fx + (tx - fx) * t), y: Math.max(0, fy + (ty - fy) * t) });
  }
  // 末点直接取夹取后的 to，避免浮点误差让「最后一帧停在 89.99999」这种落区判定失败
  path[path.length - 1] = { x: tx, y: ty };
  return path;
}

/**
 * CDP 真实点击：元素中心 → elementFromPoint 自证（被遮挡时告警不冒充成功）→ Input 派发。
 * 中心解析与自证已抽到 `resolvePoint`（与 hover / 双击 / 拖拽 / 滚轮共用同一段判据）。
 */
export async function cdpClick(cdp, selectorOrPoint) {
  const point = await resolvePoint(cdp, selectorOrPoint);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
  return point;
}

/**
 * 悬停：一次 `mouseMoved` 停在目标中心，再等 `settleMs` 让 hover provider 弹出来。
 *
 * 为什么等而不是立刻断言：hover 是**异步提供**的（Monaco 的 hover 有 debounce 与一次
 * 语言服务的往返），事件送达那一刻弹窗必然还不在。这里只给一个可调的静默窗，
 * 不做「轮询到出现为止」——是否真弹属于业务判据，留给调用方用 `waitFor` 判；
 * `settleMs: 0` 表示完全不等（调用方自己接 waitFor）。
 */
export async function cdpHover(cdp, selectorOrPoint, { settleMs = 120 } = {}) {
  const point = await resolvePoint(cdp, selectorOrPoint);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
  if (settleMs > 0) await sleep(settleMs);
  return point;
}

/**
 * 双击：pressed/released 走两轮，`clickCount` 依次 1、2。
 *
 * 为什么不是「连发两次 cdpClick」：dblclick 由浏览器按 clickCount 合成，两轮里
 * clickCount 不递进的话，页面收到的是两次互不相干的单击（选中词 / 打开文件都不触发）。
 */
export async function cdpDoubleClick(cdp, selectorOrPoint) {
  const point = await resolvePoint(cdp, selectorOrPoint);
  for (const clickCount of [1, 2]) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount });
    }
  }
  return point;
}

/**
 * 拖拽：按下 → `steps` 次带 `buttons: 1` 的移动（中间帧，理由见 `mousePath`）→ 抬起。
 * 起终点都接受选择器或 `{x,y}`；返回实际起终点与移动帧数，便于调用方在日志里对账。
 */
export async function cdpDrag(cdp, from, to, { steps = 8 } = {}) {
  const start = await resolvePoint(cdp, from);
  const end = await resolvePoint(cdp, to);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: start.x,
    y: start.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  const path = mousePath(start, end, steps);
  for (const p of path) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 });
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: end.x,
    y: end.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  return { from: start, to: end, moves: path.length };
}

/**
 * 滚轮：先 `mouseMoved` 把指针放到目标上再 `mouseWheel`——滚轮作用在**指针下的滚动容器**
 * （虚拟化列表常是内部某个 div），不发移动就滚的话，事件会落到上一次指针所在的位置。
 */
export async function cdpWheel(cdp, selectorOrPoint, { dx = 0, dy = 0 } = {}) {
  const point = await resolvePoint(cdp, selectorOrPoint);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    deltaX: dx,
    deltaY: dy,
  });
  return point;
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
