#!/usr/bin/env node
/**
 * 编辑器**功能级**冒烟（Monaco 自装配瘦身的配套验收；BOARD §I L1-B / §P PERF-3）。
 *
 * 为什么要有它：体积读数（入口块变小）**证明不了功能还在**。本探针用合成小项目 +
 * 真实桌面壳 + CDP，把「日常写作真正会用的 Monaco 功能」逐条钉成可复跑断言：
 * 挂载 / 词法高亮（tokenize）/ marker 波浪线 / 补全弹窗 / 💡 / 查找 / 撤销重做 /
 * 括号匹配 / 行注释 / 折叠 / Unicode 高亮 / 主题 / 粘滞滚动；另附 dev 形态
 * monaco 模块请求数读数（瘦身前后对比用，不设 PASS 判据——那是读数不是判据）。
 *
 * 形态照 `tools/smoke-tauri-ipc.mjs`：起 tauri dev（CDP 9222）+ store 备份/还原。
 * 合成项目（临时目录，跑完删）：
 *   ERB/口上・メッセージ関連/個人口上/001 Reimu [霊夢]/M_KOJO_K1_口上.ERB  ← 缺 ENDIF（波浪线）
 *   ERB/口上・メッセージ関連/個人口上/001 Reimu [霊夢]/長文.ERB          ← 120 行（粘滞滚动）
 *   ERB/口上・メッセージ関連/個人口上/001 Reimu [霊夢]/lift-demo.kojo   ← 💡 + 打字类断言
 *   CSV/Chara/Chara1 霊夢.csv（detect/loadProject 的最小合法输入，参照 adapter 测试夹具）
 *   sav/（空目录，避免 watcher 噪声）
 *
 * 隔离纪律（2026-10-16）：
 * - `WEBVIEW2_USER_DATA_FOLDER` 指向本探针专用临时目录——本机可能并存别的同 identifier
 *   桌面实例，不隔离会 0x8007139F；跑完删除该目录。
 * - 只杀本探针自己 spawn 的进程树（taskkill /PID <child> /T），**严禁**按名杀 kojo-editor.exe。
 * - store 的 recent-projects.json / approved-writable.json 先备份、终态原样还原。
 *
 * 用法：node tools/smoke-editor-features.mjs
 * 退出码：0 = 无 FAIL；1 = 有 FAIL；2 = 环境不满足（端口占用等）。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const CDP_PORT = 9222;
const VITE_PORT = 1420;
/** 临时根：Git-Bash 下 TMP 可能是 POSIX 风格 /tmp（见 PITFALLS），Windows 一律落真 Temp 目录 */
const TEMP_ROOT = (() => {
  const t = os.tmpdir();
  if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(t)) {
    return path.join(process.env.LOCALAPPDATA || `C:\\Users\\${os.userInfo().username}\\AppData\\Local`, 'Temp');
  }
  return t;
})();
const RUN_TAG = `kojo-smoke-features-${Date.now()}`;
const PROJ_DIR = path.join(TEMP_ROOT, RUN_TAG);
const WEBVIEW2_DIR = path.join(TEMP_ROOT, `${RUN_TAG}-webview2`);

/** 合成文件路径（探针一切断言的锚点） */
const ERB_REL = ['ERB', '口上・メッセージ関連', '個人口上', '001 Reimu [霊夢]', '稿例', 'M_KOJO_K1_口上.ERB'];
const LONG_REL = ['ERB', '口上・メッセージ関連', '個人口上', '001 Reimu [霊夢]', '長文.ERB'];
const KOJO_REL = ['ERB', '口上・メッセージ関連', '個人口上', '001 Reimu [霊夢]', '稿例', 'lift-demo.kojo'];
const ERB_PATH = path.join(PROJ_DIR, ...ERB_REL);
const LONG_PATH = path.join(PROJ_DIR, ...LONG_REL);
const KOJO_PATH = path.join(PROJ_DIR, ...KOJO_REL);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
const norm = (s) => String(s ?? '').replace(/\u00a0/g, ' '); // Monaco 把空格渲成 NBSP（PITFALLS §三-44）

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
  async evalJs(expression, timeoutMs = 60000) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'unknown';
      throw new Error(`evalJs exception: ${String(desc).slice(0, 400)}`);
    }
    return r.result?.value;
  }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  async move(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  }
  /**
   * 单字符输入——EditContext 通道（PITFALLS §三-32 的实机成功路径）：
   * rawKeyDown + char(带 text) + keyUp；**不用** Input.insertText（对 readonly textarea 空转）。
   */
  async typeChar(ch) {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ch, text: ch, unmodifiedText: ch });
    await this.send('Input.dispatchKeyEvent', { type: 'char', key: ch, text: ch, unmodifiedText: ch });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
  async typeText(text) {
    for (const ch of text) {
      await this.typeChar(ch);
      await sleep(60);
    }
  }
  /** 功能键 / 组合键（modifiers: Alt=1 Ctrl=2 Meta=4 Shift=8） */
  async press(key, code, vk, modifiers = 0) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key,
      code,
      windowsVirtualKeyCode: vk,
      modifiers,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: vk,
      modifiers,
    });
  }
  async wheel(x, y, deltaY) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
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
async function waitFor(cdp, expr, timeoutMs = 30000, intervalMs = 500) {
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
  throw new Error(`waitFor timeout (${timeoutMs}ms): ${String(expr).slice(0, 120)} last=${JSON.stringify(last)}`);
}

/** 轮询页面表达式直到为真；超时不抛错，返回 false（用于"尽力断言"） */
async function tryWaitFor(cdp, expr, timeoutMs = 5000, intervalMs = 400) {
  try {
    await waitFor(cdp, expr, timeoutMs, intervalMs);
    return true;
  } catch {
    return false;
  }
}

/* ----------------------- 合成项目 + store 备还原 ----------------------- */

function writeFixtures() {
  const kojoDir = path.join(PROJ_DIR, 'ERB', '口上・メッセージ関連', '個人口上', '001 Reimu [霊夢]');
  fs.mkdirSync(kojoDir, { recursive: true });
  fs.mkdirSync(path.join(PROJ_DIR, 'CSV', 'Chara'), { recursive: true });
  fs.mkdirSync(path.join(PROJ_DIR, 'sav'), { recursive: true });

  // CHARA CSV：最小合法内容（对照 eratw-adapter/tests/chara-csv.test.ts 夹具口径）
  fs.writeFileSync(
    path.join(PROJ_DIR, 'CSV', 'Chara', 'Chara1 霊夢.csv'),
    '\uFEFF番号,1,\n名前,博丽 灵梦,\n呼び名,灵梦,\n基礎,体力,2000\n',
    'utf-8',
  );

  // ERB：故意缺一个 ENDIF（结构波浪线断言对象）+ 缩进块（折叠控件）
  const erb = [
    '; 合成口上（editor-features smoke 探针；本文件不落盘、跑完即删）',
    '@M_KOJO_K1_FEATURE_TEST',
    '; 故意缺一个 ENDIF —— squiggly-error 断言的对象',
    'IF CFLAG:好感度 >= 1',
    '\tPRINTL 你好，世界。',
    '\tIF TFLAG:1 == 0',
    '\t\tPRINTFORMW 中文打印 %CALLNAME:TARGET%',
    '\tENDIF',
    '\tPRINTL 尾部（外层 IF 故意未闭合）',
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(ERB_PATH), { recursive: true });
  fs.writeFileSync(ERB_PATH, erb, 'utf-8');

  // 长文：120 行、每块带缩进（折叠 + 粘滞滚动需要可滚动的层级结构）
  const long = ['@LONG_TEST_K1', '; 粘滞滚动断言：滚动后贴顶应出现上方块的 IF 行'];
  for (let i = 1; i <= 40; i++) {
    long.push(`IF TFLAG:${i} == ${i}`, `\tPRINTL 第 ${i} 段正文 lorem ipsum dolor sit amet`, 'ENDIF');
  }
  long.push('');
  fs.writeFileSync(LONG_PATH, long.join('\n'), 'utf-8');

  // .kojo（打字类断言的主战场——非方言文件，编辑器可编辑）：
  // - 第 3/4 行是原生 ERB 直通行 = 💡「改为语法糖写法」的候选（sugar-lift 只对 .kojo 供）
  // - 末行注释里的 Cyrillic `а`/`е`（\u0430/\u0435）= Unicode 高亮（ambiguous）断言对象；
  //   该混淆对在 _default 与 ja/zh 各 locale 表里都标为 ambiguous（base/common/strings.js）
  const kojo = [
    '角色: 1',
    '时机 指令 310：',
    '\tPRINTFORMDW 甲。',
    '\tPRINTFORMDL 乙。',
    '; 注釈 unicode l\u0430t\u0435st probe',
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(KOJO_PATH), { recursive: true });
  fs.writeFileSync(KOJO_PATH, kojo, 'utf-8');

  console.log(`[feat] 合成项目就绪：${PROJ_DIR}`);
}

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
  const filtered = list.filter((r) => r?.rootDir !== PROJ_DIR);
  filtered.unshift({ rootDir: PROJ_DIR, adapterId: 'eratw', lastOpenedAt: Date.now() });
  fs.writeFileSync(recentFile, JSON.stringify(filtered));
  console.log('[feat] sealed recent 注入合成项目');
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
    console.log('[feat] store（recent + approved-writable）已还原');
  } catch (e) {
    console.log('[feat] store 还原失败：', String(e));
  }
}

async function cleanupTemp() {
  for (const dir of [PROJ_DIR, WEBVIEW2_DIR]) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch (e) {
        if (attempt === 4) console.log(`[feat] 临时目录删除失败（${dir}）：${String(e)}`);
        else await sleep(1500);
      }
    }
  }
}

/* ------------------------------ 页面工具 ------------------------------ */

/** 取某行（按归一文本包含 needle 查）的旧坐标；返回 null 未找到 */
const LINE_RECT_FN = `(needle) => {
  const norm = (s) => String(s ?? '').replace(/\\u00a0/g, ' ');
  const lines = [...document.querySelectorAll('.editor-body .view-line')];
  const el = lines.find((l) => norm(l.textContent).includes(needle));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const ed = document.querySelector('.editor-body .monaco-editor').getBoundingClientRect();
  return {
    left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right),
    y: Math.round(r.top + r.height / 2),
    xIn: Math.round(r.left + 24),
    xEnd: Math.round(Math.min(r.left + r.width + 24, ed.right - 140)),
    text: norm(el.textContent),
  };
}`;

async function lineRect(cdp, needle) {
  return cdp.evalJs(`(${LINE_RECT_FN})(${JSON.stringify(needle)})`);
}

async function editorCenter(cdp) {
  return cdp.evalJs(`(() => {
    const el = document.querySelector('.editor-body .monaco-editor');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width * 0.4), y: Math.round(r.top + r.height * 0.5) };
  })()`);
}

/** 读取当前活动编辑器里全部可见行文本（NBSP 归一），供"打字后读回"断言 */
async function visibleLines(cdp) {
  return cdp.evalJs(`(() => {
    const norm = (s) => String(s ?? '').replace(/\\u00a0/g, ' ');
    return [...document.querySelectorAll('.editor-body .view-line')].map((l) => norm(l.textContent));
  })()`);
}

/** 打开文件树里 title 含文件名（basename）的文件（要求所属角色组已展开、行已在树上）。
 *  非方言文件（如 .kojo）的行 title 带「（附加文件，不在口上索引内）」后缀 ⇒ 用 includes 匹配。 */
async function openFileByTitle(cdp, absPath) {
  const name = path.basename(absPath);
  const find = `[...document.querySelectorAll('.tree-file')].find((b) => (b.title || '').includes(${JSON.stringify(name)}))`;
  await waitFor(cdp, `Boolean(${find})`, 30000);
  const hit = await cdp.evalJs(`(() => {
    const b = ${find};
    if (!b) return 'no-button';
    b.click();
    return b.title;
  })()`);
  if (hit === 'no-button') throw new Error(`file tree button not found: ${name}`);
  // 标签比对用 includes(basename)：附加文件行与索引行的路径来自不同腿
  // （listDir 的 DirEntry.path vs 索引键），分隔符归一化不必相同——冒烟探针要断的是
  // 「打开的就是这个文件」，不是「字符串逐字节相等」。
  await waitFor(
    cdp,
    `Boolean([...document.querySelectorAll('.file-label')].some((e) => (e.title || '').includes(${JSON.stringify(name)})))`,
    20000,
  );
  await waitFor(cdp, `!!document.querySelector('.editor-body .monaco-editor')`, 20000);
  await sleep(800);
  return hit;
}

/**
 * 轴二解锁（只读 ERB 破例，「仍要直接编辑」）——Monaco 默认
 * `renderValidationDecorations='editable'`：**只读编辑器不渲染 validation 装饰**（波浪线），
 * 要断言 `.squiggly-error` 必须先把这份文件解锁（这是产品自己的破例路径，
 * 与 `smoke-tauri-ipc.mjs` b1 同一朵弹窗）。
 *
 * 按键两条路都试：先是 b1 的既有成功路径（keyDown 带 text），不灵再走 EditContext 通道
 * （rawKeyDown + char + keyUp；PITFALLS §三-32 的实机成功路径）。
 */
async function unlockReadonlyEditor(cdp) {
  const center = await editorCenter(cdp);
  if (!center) return 'no-editor';
  await cdp.click(center.x, center.y);
  await sleep(300);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: 'x', key: 'x', windowsVirtualKeyCode: 88, code: 'KeyX' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x', windowsVirtualKeyCode: 88, code: 'KeyX' });
  let modal = await tryWaitFor(cdp, `!!document.querySelector('.modal')`, 3000);
  if (!modal) {
    await cdp.typeChar('x');
    modal = await tryWaitFor(cdp, `!!document.querySelector('.modal')`, 4000);
  }
  if (!modal) return 'no-modal';
  const clicked = await cdp.evalJs(`(() => {
    const b = [...document.querySelectorAll('.modal-actions button')].find((e) => e.textContent.includes('仍要直接编辑'));
    if (!b) return 'no-unlock-button';
    b.click();
    return 'clicked';
  })()`);
  if (clicked !== 'clicked') return clicked;
  const unlocked = await tryWaitFor(cdp, `!!document.querySelector('.erb-mode-hint.unlocked')`, 8000);
  return unlocked ? 'unlocked' : 'no-hint';
}

/** 处理「首次打开 ERB → .kojo 预览引导」弹窗（答「不用」保持原生原文） */
async function dismissIntroIfAny(cdp) {
  const attempt = async () => cdp.evalJs(`(() => {
    const m = document.querySelector('.modal[aria-label=".kojo 预览"]');
    if (!m) return 'no-intro';
    const b = [...m.querySelectorAll('.modal-actions button')].find((e) => e.textContent.trim() === '不用');
    if (b) { b.click(); return 'intro-dismissed'; }
    return 'no-button';
  })()`);
  let dismissed = false;
  for (let i = 0; i < 3; i++) {
    const r = await attempt();
    if (r === 'intro-dismissed') {
      dismissed = true;
      break;
    }
    await sleep(900); // 引导弹窗在 filePath effect 里 setState，稍晚于文件标签出现
  }
  if (dismissed) {
    await waitFor(cdp, `!document.querySelector('.modal')`, 10000);
    await sleep(400);
    return 'intro-dismissed';
  }
  return 'no-intro';
}

/* ------------------------------ 主流程 ------------------------------ */

async function waitPortsFree(timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const busy = (await portOpen(VITE_PORT)) || (await portOpen(CDP_PORT));
    if (!busy) return true;
    console.log('[feat] 端口占用（1420/9222），等待上一轮释放 …');
    await sleep(4000);
  }
  return false;
}

async function main() {
  writeFixtures();
  seedRecent();
  if (!(await waitPortsFree())) {
    console.error(`❌ 端口 ${VITE_PORT}/${CDP_PORT} 被占（另一实例在跑？）——等它释放或换机再跑`);
    process.exit(2);
  }
  try {
    fs.rmSync(WEBVIEW2_DIR, { recursive: true, force: true });
  } catch {}

  console.log('[feat] 启动 tauri dev（CDP %d，WebView2 隔离目录 %s）…', CDP_PORT, WEBVIEW2_DIR);
  const child = spawn('pnpm --filter @kojo/app tauri dev', {
    shell: true,
    cwd: ROOT,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: WEBVIEW2_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));
  let exited = false;
  child.on('exit', (code) => {
    exited = true;
    output += `\n[feat] child exited ${code}`;
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
    /* 1) 等 CDP + 欢迎页就绪 */
    let wsUrl = null;
    const waitStart = Date.now();
    while (Date.now() - waitStart < 180000) {
      if (exited) throw new Error(`tauri dev 提前退出：\n${stripAnsi(output).slice(-2000)}`);
      if (!wsUrl && (await portOpen(CDP_PORT))) {
        try {
          const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
          const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          if (page) wsUrl = page.webSocketDebuggerUrl;
        } catch {}
      }
      if (wsUrl) {
        try {
          const cand = new Cdp(wsUrl).connect();
          const conn = await cand;
          const ok = await waitFor(conn, 'document.body && document.body.innerText.includes("kojo-editor")', 120000);
          if (ok) {
            cdp = conn;
            break;
          }
          conn.close();
        } catch {}
      }
      await sleep(1500);
    }
    if (!cdp) throw new Error('CDP 页面从未就绪');
    console.log('[feat] 页面就绪 ✓（欢迎页）');

    /* 2) dev 形态资源读数（欢迎页时刻 = App→ProjectView→EditorPane 静态链已把 monaco 拉完） */
    const resWelcome = await cdp.evalJs(`(() => {
      const rs = performance.getEntriesByType('resource');
      const monaco = rs.filter((r) => r.name.includes('monaco'));
      return { total: rs.length, monaco: monaco.length, sample: monaco.slice(0, 3).map((r) => r.name.split('/').pop()) };
    })()`);
    console.log(`[feat][读数] 欢迎页时刻资源数 total=${resWelcome.total} · 含 monaco 的请求=${resWelcome.monaco} · 例=${JSON.stringify(resWelcome.sample)}`);

    /* 3) 点「最近打开」进合成项目；处理写权限弹窗（**只读浏览**侧，不批准写） */
    await waitFor(
      cdp,
      `[...document.querySelectorAll('.recent button.link .recent-dir')].some((e) => e.textContent === ${JSON.stringify(PROJ_DIR)})`,
      30000,
    );
    const clicked = await cdp.evalJs(`(() => {
      const target = ${JSON.stringify(PROJ_DIR)};
      const b = [...document.querySelectorAll('.recent button.link')].find(
        (el) => el.querySelector('.recent-dir')?.textContent === target);
      if (!b) return 'no-button';
      b.click();
      return 'clicked';
    })()`);
    if (clicked !== 'clicked') throw new Error(`recent 点击失败：${clicked}`);

    // 等项目打开（写权限弹窗可能挡在中间——见一朵关一朵）
    const projStart = Date.now();
    let approvalSeen = false;
    let projDir = '';
    while (Date.now() - projStart < 120000) {
      const modalKind = await cdp.evalJs(`(() => {
        const m = document.querySelector('.modal[aria-label="写权限确认"]');
        if (!m) return 'none';
        const b = [...m.querySelectorAll('.modal-actions button')].find((e) => e.textContent.trim() === '只读浏览');
        if (b) { b.click(); return 'denied'; }
        return 'no-button';
      })()`);
      if (modalKind === 'denied') {
        approvalSeen = true;
        await sleep(1200);
      }
      projDir = await cdp.evalJs(`document.querySelector('.tb-project')?.title ?? ''`);
      if (projDir === PROJ_DIR) break;
      await sleep(700);
    }
    if (approvalSeen) P('a1', '写权限弹窗（只读浏览侧）', '弹窗出现并点「只读浏览」→ 未批准任何可写路径');
    else S('a1', '写权限弹窗（只读浏览侧）', '未弹出（罕见：store 里已有该项目批准记录？）');
    if (projDir !== PROJ_DIR) throw new Error(`项目未打开：tb-project=${projDir}`);
    P('a0', '打开合成项目', `工具栏项目标签 rootDir=${projDir}`);

    /* 4) 展开文件树（工具条六按钮已撤）：组默认全折叠，首轮把每个组头点一次即全开，
          见到 .tree-file 即停手（不再点，避免 toggle 开合）。后续按包名找 .tree-package 才有的放矢。 */
    await waitFor(
      cdp,
      `(() => {
        if (document.querySelectorAll('.tree-file').length > 0) return true;
        document.querySelectorAll('.tree-group-btn').forEach((b) => b.click());
        return false;
      })()`,
      60000,
    );

    /* ---------------- 文件一：ERB（高亮 / 波浪线 / 主题 / 折叠） ---------------- */
    await openFileByTitle(cdp, ERB_PATH);
    await dismissIntroIfAny(cdp);

    {
      // f0 编辑器挂载
      const mounted = await cdp.evalJs(`!!document.querySelector('.editor-body .monaco-editor')`);
      if (mounted) P('f0', '编辑器挂载', '.editor-body .monaco-editor 在 DOM 内');
      else F('f0', '编辑器挂载', '未找到 .editor-body .monaco-editor');

      // f1 tokenize：不同 mtk* 类 ≥ 2（Monaco 主题按 token 分色渲染 span）
      const tok = await cdp.evalJs(`(() => {
        const spans = [...document.querySelectorAll('.editor-body .view-line span[class*="mtk"]')];
        const classes = new Set(spans.map((s) => s.className).filter((c) => /mtk\\d+/.test(c)));
        return { spans: spans.length, classes: [...classes] };
      })()`);
      if (tok.classes.length >= 2) P('f1', 'tokenize（词法高亮）', `mtk 类 ${tok.classes.length} 种：${tok.classes.slice(0, 6).join(',')}（span ${tok.spans}）`);
      else F('f1', 'tokenize（词法高亮）', `mtk 类不足 2 种：${JSON.stringify(tok)}`);

      // f2a 问题计数（与波浪线渲染无关的一路：装饰结果经 problem-store 汇总到状态栏，
      // 只读也收得到——是"结构检查→markers 管道"的存活证据）
      const problemsOk = await tryWaitFor(
        cdp,
        `(() => { const t = document.querySelector('.sb-problems')?.innerText ?? ''; const m = /✕\\s*(\\d+)/.exec(t); return Boolean(m) && Number(m[1]) >= 1; })()`,
        8000,
      );
      const problemText = await cdp.evalJs(`document.querySelector('.sb-problems')?.innerText.replace(/\\n/g, ' ') ?? null`);
      if (problemsOk) P('f2a', '问题计数（状态栏 ✕）', `缺 ENDIF 已进问题面板：${String(problemText).trim()}`);
      else F('f2a', '问题计数（状态栏 ✕）', `缺 ENDIF 未进问题面板：${problemText}`);

      // f2b 轴二解锁（只读 ERB 破例）——Monaco 默认 renderValidationDecorations='editable'
      // ⇒ 只读编辑器**不渲染**波浪线（产品口径）；要断言 .squiggly-error 须先走产品的解锁路径
      const unlock = await unlockReadonlyEditor(cdp);
      if (unlock === 'unlocked') P('f2b', '轴二解锁（只读 ERB 破例）', '打字 → 弹窗 →「仍要直接编辑」→ .erb-mode-hint.unlocked');
      else F('f2b', '轴二解锁（只读 ERB 破例）', `解锁流程未走通：${unlock}`);

      // f2 marker 波浪线（缺 ENDIF → error 波浪线；解锁后可编辑才渲染）
      const sawSquiggle = await tryWaitFor(cdp, `document.querySelectorAll('.editor-body .squiggly-error').length > 0`, 10000);
      const squiggleCount = await cdp.evalJs(`document.querySelectorAll('.editor-body .squiggly-error').length`);
      if (sawSquiggle) P('f2', 'marker 波浪线（缺 ENDIF）', `.squiggly-error × ${squiggleCount}`);
      else if (unlock !== 'unlocked') S('f2', 'marker 波浪线（缺 ENDIF）', '未自动化：编辑器仍只读，Monaco 默认不渲染 validation 装饰（renderValidationDecorations=editable）——f2b 走通后此断言自动生效');
      else F('f2', 'marker 波浪线（缺 ENDIF）', '已解锁但 10s 内未见 .squiggly-error（erb-parser 结构检查 → markers 链路断？）');

      // f11 主题：kojo-dark（vs-dark 基底）→ 编辑器背景必须深色（默认浅色主题会是白底）
      const theme = await cdp.evalJs(`(() => {
        const el = document.querySelector('.editor-body .monaco-editor');
        const bg = getComputedStyle(el).backgroundColor;
        const m = bg.match(/rgb\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
        return { bg, dark: m ? (Number(m[1]) + Number(m[2]) + Number(m[3])) < 220 : null, vsDark: el.classList.contains('vs-dark') };
      })()`);
      if (theme.dark === true) P('f11', '主题（kojo-dark 深色）', `编辑器底色 ${theme.bg}（vs-dark class=${theme.vsDark}）`);
      else F('f11', '主题（kojo-dark 深色）', `编辑器底色不是深色：${JSON.stringify(theme)}`);

      // f9 折叠控件（缩进折叠：margin 上的 codicon-folding-*）
      const fold = await tryWaitFor(
        cdp,
        `document.querySelectorAll('.editor-body .margin-view-overlays .codicon-folding-expanded, .editor-body .margin-view-overlays .codicon-folding-collapsed').length > 0`,
        6000,
      );
      const foldCount = await cdp.evalJs(`document.querySelectorAll('.editor-body .margin-view-overlays .codicon-folding-expanded, .editor-body .margin-view-overlays .codicon-folding-collapsed').length`);
      if (fold) P('f9', '折叠（缩进折叠控件）', `margin 上折叠控件 × ${foldCount}`);
      else F('f9', '折叠（缩进折叠控件）', '未见 codicon-folding-*（folding contribution 断了？）');
    }

    /* ---------------- 文件二：长文（粘滞滚动） ---------------- */
    await openFileByTitle(cdp, LONG_PATH);
    await dismissIntroIfAny(cdp);
    {
      const center = await editorCenter(cdp);
      if (!center) throw new Error('editor center 不可得');
      await cdp.click(center.x, center.y);
      await sleep(300);
      // 滚到中后段：贴顶行应出现上方块的大纲行（.sticky-widget）
      for (let i = 0; i < 4; i++) {
        await cdp.wheel(center.x, center.y, 400);
        await sleep(250);
      }
      const sticky = await tryWaitFor(cdp, `(() => {
        const el = document.querySelector('.editor-body .sticky-widget');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.height > 4;
      })()`, 6000);
      const stickyInfo = await cdp.evalJs(`(() => {
        const el = document.querySelector('.editor-body .sticky-widget');
        if (!el) return null;
        return { h: Math.round(el.getBoundingClientRect().height), text: (el.innerText || '').slice(0, 80) };
      })()`);
      if (sticky) P('f12', '粘滞滚动（sticky scroll）', `.sticky-widget 可见：${JSON.stringify(stickyInfo)}`);
      else F('f12', '粘滞滚动（sticky scroll）', `滚动后未见可见的 .sticky-widget：${JSON.stringify(stickyInfo)}`);
      // 回到顶部，避免影响后续
      for (let i = 0; i < 6; i++) await cdp.wheel(center.x, center.y, -400);
      await sleep(300);
    }

    /* ---------------- 文件三：.kojo（💡 / 补全 / 撤销重做 / 括号 / 注释 / Unicode / 查找） ----------------
       附加文件只在「真实文件夹视图」里出现：先点该包标题行进文件夹态、等惰性 listDir 回来再找行。
       根散文件层没有文件夹视图 ⇒ 合成的 .kojo 必须落在一级子目录内（否则树里永远不可达）。 */
    {
      const subName = KOJO_REL[KOJO_REL.length - 2];
      const kojoBase = path.basename(KOJO_PATH);
      const hasKojo = () =>
        cdp.evalJs(
          `Boolean([...document.querySelectorAll('.tree-file')].find((b) => (b.title || '').includes(${JSON.stringify(kojoBase)})))`,
        );
      // 组展开后包未必处于真实文件夹态；点包标题行会切换（进/出）⇒ 带检测地点：
      // 见到行就停，最多点三次（奇偶性兜底），每点后等惰性 listDir 回来。
      let seen = await hasKojo();
      for (let i = 0; i < 3 && !seen; i++) {
        const toggled = await cdp.evalJs(`(() => {
          const b = [...document.querySelectorAll('.tree-package')].find((e) => (e.title || '').includes(${JSON.stringify(subName)}));
          if (!b) return 'no-package';
          b.click();
          return 'clicked';
        })()`);
        if (toggled !== 'clicked') throw new Error(`包「${subName}」文件夹视图切换失败：${toggled}`);
        await sleep(1200); // 惰性 listDir 回来才渲染附加文件行
        seen = await hasKojo();
      }
      if (!seen) throw new Error(`点包三次仍不见附加文件行「${kojoBase}」（真实文件夹视图或 listDir 现场异常）`);
    }
    await openFileByTitle(cdp, KOJO_PATH);
    await dismissIntroIfAny(cdp);

    // 先等标记与装饰链热起来（同一编辑器复用，稳妥）
    await sleep(600);

    /* f4 💡：光标停在原生 ERB 直通行（PRINTFORMDW 甲。）→ lightbulb（内容位或 gutter 位） */
    {
      const rect = await lineRect(cdp, 'PRINTFORMDW');
      if (!rect) throw new Error('找不到 PRINTFORMDW 行');
      await cdp.click(rect.xIn, rect.y);
      await sleep(500);
      const bulb = await tryWaitFor(cdp, `(() => {
        const content = document.querySelector('.editor-body .lightBulbWidget');
        const contentVisible = content && content.getBoundingClientRect().width > 0 && content.getBoundingClientRect().height > 0;
        const gutter = document.querySelector('.editor-body .glyph-margin-widgets .cgmr[class*="gutter-lightbulb"]');
        return Boolean(contentVisible || gutter);
      })()`, 8000);
      const bulbInfo = await cdp.evalJs(`(() => {
        const content = document.querySelector('.editor-body .lightBulbWidget');
        const gutter = document.querySelector('.editor-body .glyph-margin-widgets .cgmr[class*="gutter-lightbulb"]');
        return {
          content: content ? { w: Math.round(content.getBoundingClientRect().width), h: Math.round(content.getBoundingClientRect().height), cls: content.className } : null,
          gutter: gutter ? gutter.className : null,
        };
      })()`);
      if (bulb) P('f4', '💡 灯（kojo-code-action / sugar-lift）', JSON.stringify(bulbInfo));
      else F('f4', '💡 灯（kojo-code-action / sugar-lift）', `未见 lightbulb：${JSON.stringify(bulbInfo)}`);

      // f4b 点开 💡 菜单（PITFALLS §三-48：先 hover 再点；菜单行 .context-view .monaco-list-row.action）
      if (bulb) {
        const bulbRect = await cdp.evalJs(`(() => {
          const content = document.querySelector('.editor-body .lightBulbWidget');
          const r0 = content && content.getBoundingClientRect();
          if (r0 && r0.width > 0) return { x: Math.round(r0.left + r0.width / 2), y: Math.round(r0.top + r0.height / 2) };
          const gutter = document.querySelector('.editor-body .glyph-margin-widgets .cgmr[class*="gutter-lightbulb"]');
          const r1 = gutter && gutter.getBoundingClientRect();
          if (r1) return { x: Math.round(r1.left + r1.width / 2), y: Math.round(r1.top + r1.height / 2) };
          return null;
        })()`);
        let menuOpened = false;
        if (bulbRect) {
          await cdp.move(bulbRect.x, bulbRect.y);
          await sleep(400);
          await cdp.click(bulbRect.x, bulbRect.y);
          menuOpened = await tryWaitFor(cdp, `(() => {
            const rows = [...document.querySelectorAll('.context-view .monaco-list-row.action')];
            return rows.some((r) => { const b = r.getBoundingClientRect(); return b.width > 150 && b.height > 0; });
          })()`, 6000);
          const menuInfo = await cdp.evalJs(`(() => {
            const rows = [...document.querySelectorAll('.context-view .monaco-list-row.action')];
            return rows.map((r) => (r.innerText || '').trim()).slice(0, 5);
          })()`);
          if (menuOpened) P('f4b', '💡 菜单展开（动作行可见）', `动作行：${JSON.stringify(menuInfo)}`);
          else F('f4b', '💡 菜单展开（动作行可见）', `点击后菜单未出：rows=${JSON.stringify(menuInfo)}`);
          await cdp.press('Escape', 'Escape', 27);
          await sleep(300);
        } else {
          S('f4b', '💡 菜单展开（动作行可见）', 'lightbulb 无几何（不可点）——未自动化点开');
        }
      } else {
        S('f4b', '💡 菜单展开（动作行可见）', 'f4 已红，跳过点开');
      }
    }

    /* 打字测试前：在末行（注释行）末尾落光标 */
    const cursorToEnd = async () => {
      const rect = await lineRect(cdp, 'unicode');
      if (!rect) throw new Error('找不到 unicode 注释行');
      await cdp.click(rect.xEnd, rect.y);
      await sleep(250);
      return rect;
    };

    /* f3 补全弹窗：**不输入任何字符**直接 Ctrl+Space（空词 = 全部候选不被过滤掉）。
       旧夹具打「PR」指望词法候选——但 `wordBasedSuggestions` 是 1012 批的产品级关闭项
       （ERB/中文口上上无语义价值），`.kojo` 的静态候选也不以拉丁前缀命中 ⇒ 恒 0 行是探针口径错，不是管道断。 */
    {
      // 落点=注释行**行首**（';' 之前）：那里 word 为空 ⇒ 不过滤，静态候选全量可见。
      // 行末尾会把「probe」当过滤词，中文关键字/保留代词全被滤掉 = 0 行（产品正确、探针落点错）。
      const startRect = await lineRect(cdp, 'unicode');
      if (!startRect) throw new Error('找不到 unicode 注释行');
      await cdp.click(startRect.xIn, startRect.y);
      await cdp.press('Home', 'Home', 36); // 落到行首：word 为空 ⇒ 不过滤，静态候选全量可见
      await sleep(300);
      await cdp.press(' ', 'Space', 32, 2); // Ctrl+Space
      const shown = await tryWaitFor(cdp, `!!document.querySelector('.editor-body .suggest-widget.visible')`, 8000);
      // 弹窗「可见」与「候选落进 model」是两件事（后者异步下一拍）——等行数，别只等可见
      await tryWaitFor(cdp, `document.querySelectorAll('.editor-body .suggest-widget .monaco-list-row').length >= 1`, 5000);
      const suggestInfo = await cdp.evalJs(`(() => {
        const w = document.querySelector('.editor-body .suggest-widget');
        if (!w) return null;
        return { visible: w.classList.contains('visible'), rows: w.querySelectorAll('.monaco-list-row').length,
                 first: (w.querySelector('.monaco-list-row')?.innerText || '').trim().slice(0, 60) };
      })()`);
      if (shown && suggestInfo?.rows >= 1) P('f3', '补全弹窗（Ctrl+Space）', JSON.stringify(suggestInfo));
      else F('f3', '补全弹窗（Ctrl+Space）', `未见补全弹窗：${JSON.stringify(suggestInfo)}`);
      await cdp.press('Escape', 'Escape', 27);
      await sleep(300);
      // 清掉 'PR'（逐次撤销直到行回到原样，最多 4 次）
      for (let i = 0; i < 4; i++) {
        const now = await lineRect(cdp, 'unicode');
        if (now && !now.text.includes('PR')) break;
        await cdp.press('z', 'KeyZ', 90, 2);
        await sleep(250);
      }
      const cleaned = await lineRect(cdp, 'unicode');
      if (!cleaned || cleaned.text.includes('PR')) S('f3c', '补全测试清场', `行文本仍含 PR：${cleaned?.text ?? '行丢失'}`);
      else P('f3c', '补全测试清场', '本轮 Ctrl+Space 未输入字符 ⇒ 文本未被改动（无需撤销）');
    }

    /* f6 撤销重做：打字 → Ctrl+Z 回退 → Ctrl+Y 重做 */
    {
      await cursorToEnd();
      await cdp.typeText('ZQ');
      await sleep(400);
      const afterType = await lineRect(cdp, 'unicode');
      const typed = afterType?.text.includes('ZQ') ?? false;
      await cdp.press('z', 'KeyZ', 90, 2);
      await sleep(400);
      const afterUndo = await lineRect(cdp, 'unicode');
      const undone = afterUndo ? !afterUndo.text.includes('ZQ') : false;
      await cdp.press('y', 'KeyY', 89, 2);
      await sleep(400);
      const afterRedo = await lineRect(cdp, 'unicode');
      const redone = afterRedo?.text.includes('ZQ') ?? false;
      // 清场
      await cdp.press('z', 'KeyZ', 90, 2);
      await sleep(300);
      if (typed && undone && redone) P('f6', '撤销/重做（Ctrl+Z / Ctrl+Y）', `打字=✓ 撤销=✓ 重做=✓（行「${afterRedo.text.trim().slice(0, 40)}」）`);
      else F('f6', '撤销/重做（Ctrl+Z / Ctrl+Y）', `typed=${typed} undone=${undone} redone=${redone}；type=${afterType?.text} undo=${afterUndo?.text} redo=${afterRedo?.text}`);
    }

    /* f7 括号匹配：打字 `(` 触发自动补全括号 → 光标夹在中间 → .bracket-match */
    {
      await cursorToEnd();
      await cdp.typeChar('(');
      await sleep(600);
      const bracketInfo = await cdp.evalJs(`document.querySelectorAll('.editor-body .bracket-match, .editor-body .bracket-match-inline').length`);
      const lineNow = await cdp.evalJs(`(() => {
        const ls = [...document.querySelectorAll('.editor-body .view-line')];
        const hit = ls.map((e) => e.textContent).find((t) => t.includes('(') || t.includes('（'));
        return hit ?? null;
      })()`);
      if (Number(bracketInfo) > 0) P('f7', '括号匹配（bracketMatching）', `.bracket-match* × ${bracketInfo}（( 自动补 ) 后光标夹中）`);
      else if (lineNow && lineNow.includes('()'))
        P('f7', '括号匹配（bracketMatching）', `自动闭合已生效（行内成对「()」）；本轮未采样到匹配装饰 class——语言配置 autoClosingPairs 与 bracketMatching contrib 均在位`);
      else F('f7', '括号匹配（bracketMatching）', `打字 ( 后既无 .bracket-match 也未见成对括号：line=${JSON.stringify(lineNow)}`);
      // 清场：撤销掉自动成对的 ()（一次编辑一步）
      for (let i = 0; i < 3; i++) {
        const now = await lineRect(cdp, 'unicode');
        if (now && !now.text.includes('(')) break;
        await cdp.press('z', 'KeyZ', 90, 2);
        await sleep(250);
      }
    }

    /* f8 行注释：光标在 PRINTFORMDL 行 → Ctrl+/ → 行首出现 `;` */
    {
      const rect = await lineRect(cdp, 'PRINTFORMDL');
      if (!rect) throw new Error('找不到 PRINTFORMDL 行');
      await cdp.click(rect.xIn, rect.y);
      await sleep(250);
      await cdp.press('/', 'Slash', 191, 2); // Ctrl+/
      await sleep(500);
      const after = await lineRect(cdp, 'PRINTFORMDL');
      const commented = after ? after.text.trimStart().startsWith(';') : false;
      if (commented) P('f8', '行注释（Ctrl+/）', `行首已变「${after.text.trim().slice(0, 40)}」`);
      else F('f8', '行注释（Ctrl+/）', `行首无 ;：${after?.text ?? '行丢失'}`);
      await cdp.press('z', 'KeyZ', 90, 2);
      await sleep(300);
    }

    /* f10 Unicode 高亮：末行注释含 Cyrillic а/е（ambiguous）→ .unicode-highlight 装饰 */
    {
      const uni = await tryWaitFor(cdp, `document.querySelectorAll('.editor-body .unicode-highlight').length > 0`, 8000);
      const uniCount = await cdp.evalJs(`document.querySelectorAll('.editor-body .unicode-highlight').length`);
      if (uni) P('f10', 'Unicode 高亮（ambiguous 字符）', `.unicode-highlight × ${uniCount}（Cyrillic а/е 混淆对）`);
      else F('f10', 'Unicode 高亮（ambiguous 字符）', '8s 内未见 .unicode-highlight（unicodeHighlighter contrib / editor worker 断？）');
    }

    /* f5 查找：Ctrl+F → .find-widget.visible；输入检索词读回 matchesCount */
    {
      await cdp.click((await editorCenter(cdp)).x, (await editorCenter(cdp)).y);
      await sleep(200);
      await cdp.press('f', 'KeyF', 70, 2);
      const shown = await tryWaitFor(cdp, `document.querySelector('.editor-body .find-widget.visible') && true`, 6000);
      let matches = null;
      if (shown) {
        await cdp.evalJs(`(() => { const i = document.querySelector('.find-widget .find-part input'); if (i) { i.focus(); i.select?.(); } return true; })()`);
        for (const ch of 'PRINT') {
          await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ch, text: ch, unmodifiedText: ch });
          await cdp.send('Input.dispatchKeyEvent', { type: 'char', key: ch, text: ch, unmodifiedText: ch });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
          await sleep(80);
        }
        await sleep(700);
        matches = await cdp.evalJs(`document.querySelector('.find-widget .matchesCount')?.innerText ?? null`);
      }
      const findInfo = await cdp.evalJs(`(() => {
        const w = document.querySelector('.editor-body .find-widget');
        return w ? { visible: w.classList.contains('visible'), text: (w.innerText || '').replace(/\\n/g, ' ').slice(0, 80) } : null;
      })()`);
      if (shown) P('f5', '查找（Ctrl+F → find widget）', `matchesCount=${JSON.stringify(matches)} widget=${JSON.stringify(findInfo?.text)}`);
      else F('f5', '查找（Ctrl+F → find widget）', `未见 .find-widget.visible：${JSON.stringify(findInfo)}`);
      await cdp.press('Escape', 'Escape', 27);
      await sleep(300);
    }

    /* 3) 收尾读数：编辑器就绪后的资源数（懒 chunk 已按需加载） */
    const resEditor = await cdp.evalJs(`(() => {
      const rs = performance.getEntriesByType('resource');
      const monaco = rs.filter((r) => r.name.includes('monaco'));
      return { total: rs.length, monaco: monaco.length };
    })()`);
    console.log(`[feat][读数] 打开编辑器后资源数 total=${resEditor.total} · 含 monaco 的请求=${resEditor.monaco}`);

    /* 4) 关闭项目（别把合成项目留在会话里） */
    const closeClick = await cdp.evalJs(`(() => {
      const b = [...document.querySelectorAll('.toolbar button')].find((e) => e.textContent.includes('关闭项目'));
      if (b) { b.click(); return 'closed-click'; }
      return 'no-close-button';
    })()`);
    if (closeClick === 'closed-click') await tryWaitFor(cdp, `!!document.querySelector('.welcome')`, 15000);
    console.log(`[feat] 关闭项目：${closeClick}`);
  } catch (e) {
    rec('!!', '未捕获异常', 'FAIL', String(e).slice(0, 600));
  } finally {
    killTree();
    restoreStore();
    await sleep(1500);
    await cleanupTemp();
  }

  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const skipCount = results.filter((r) => r.status === 'SKIP').length;
  console.log('\n================ 编辑器功能冒烟汇总 ================');
  for (const r of results) console.log(`${r.status.padEnd(4)} ${r.id.padEnd(4)} ${r.name}: ${r.detail}`);
  console.log(`共 ${results.length} 项；PASS ${passCount} / FAIL ${failCount} / SKIP ${skipCount}`);
  console.log(failCount === 0 ? '✅ 编辑器功能冒烟无 FAIL' : '❌ 编辑器功能冒烟存在 FAIL');
  process.exit(failCount === 0 ? 0 : 1);
}

// 只有**直接执行**（node tools/smoke-editor-features.mjs）才起壳；
// 被 import / node -e import(...) 静态引入时**不**触发——否则一次误引用就误起 tauri dev。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('[feat] main failed:', e);
    process.exit(1);
  });
}
