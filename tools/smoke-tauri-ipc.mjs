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
 * 退出码：0 = 全 PASS；1 = 有 FAIL（输出逐项诊断）。
 * 注意：会弹出应用窗口（结束自动关闭）；会临时改写 store/recent-projects.json（结束还原）。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const GAME_DIR =
  process.argv[2] ?? 'D:\\Game\\eratw\\eratw-sub-modding-eratw4.980-260326-SANYOUSEI(PC)';
const OUTSIDE_PATH = 'C:\\Windows\\Temp\\kojo-smoke-outside.txt';
const CDP_PORT = 9222;

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

/** 预检：等两个端口都空闲（上一轮遗留进程会占用，直接起会互相干扰） */
async function waitPortsFree(timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const busy = (await portOpen(1420)) || (await portOpen(CDP_PORT));
    if (!busy) return;
    console.log('[smoke] ports busy (1420/9222), waiting for previous run to release …');
    await sleep(3000);
  }
  console.log('[smoke] ports still busy after wait; proceeding anyway');
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  seedRecent();
  await waitPortsFree();

  console.log('[smoke] launching tauri dev (CDP %d) …', CDP_PORT);
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
    console.log('[smoke] page ready ✓');

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
    await waitFor(
      cdp,
      `[...document.querySelectorAll('.recent button.link .recent-dir')].some(e => e.textContent === ${JSON.stringify(GAME_DIR)})`,
      30000,
    );
    const clicked = await cdp.evalJs(`(() => {
      const target = ${JSON.stringify(GAME_DIR)};
      const b = [...document.querySelectorAll('.recent button.link')].find(
        (el) => el.querySelector('.recent-dir')?.textContent === target);
      if (!b) return 'no-button';
      b.click();
      return 'clicked';
    })()`);
    if (clicked !== 'clicked') throw new Error(`recent button click failed: ${clicked}`);
    // 等项目头出现（openProject 期间会弹写权限确认）
    await waitFor(cdp, `!!document.querySelector('.project-header')`, 120000);
    const projDir = await cdp.evalJs(`document.querySelector('.proj-dir')?.textContent ?? ''`);
    if (projDir === GAME_DIR) P('a', '打开真实游戏目录', `项目头 rootDir=${projDir}`);
    else F('a', '打开真实游戏目录', `期望 ${GAME_DIR}，实际 ${projDir}`);

    /* -------- 批准写权限（若弹窗） -------- */
    // 弹窗在 openProject 末尾异步 setState，稍等再判定
    await sleep(2000);
    const modalShown = await cdp.evalJs(`!!document.querySelector('.modal')`);
    if (modalShown) {
      await cdp.evalJs(`(() => {
        const b = [...document.querySelectorAll('.modal-actions button')].find(
          (el) => el.textContent.includes('允许写入'));
        if (b) { b.click(); return 'approved'; }
        return 'no-allow-button';
      })()`);
      await waitFor(cdp, `!document.querySelector('.modal')`, 15000);
      P('a2', '批准写权限对话框', '点击「允许写入」→ 弹窗关闭');
    } else {
      S('a2', '批准写权限对话框', '未弹出（该目录已有批准记录）');
    }

    // 等索引完成（stats 不再含 …）
    try {
      await waitFor(
        cdp,
        `(document.querySelector('.proj-stats') && !document.querySelector('.proj-stats').innerText.includes('…')) || false`,
        180000,
      );
    } catch (e) {
      const dump = await cdp.evalJs(`(() => ({
        href: location.href,
        header: !!document.querySelector('.project-header'),
        stats: document.querySelector('.proj-stats')?.innerText ?? null,
        welcome: !!document.querySelector('.welcome'),
        bodyText: (document.body?.innerText ?? '').slice(0, 400),
      }))()`);
      throw new Error(`stats never settled: ${JSON.stringify(dump)}`);
    }
    const stats = await cdp.evalJs(`document.querySelector('.proj-stats').innerText.replace(/\\n/g,' ')`);
    console.log('[smoke] project stats:', stats);

    /* -------- b) 域内写：编辑 + 保存 + 落盘 + 备份 -------- */
    // 展开全部（重试式：等 FileTree 真正渲染后点击；随后断言文件出现）
    try {
      await waitFor(
        cdp,
        `(() => {
          const btns = [...document.querySelectorAll('.tree-actions button')];
          const b = btns.find((e) => e.textContent.includes('展开全部'));
          if (b) b.click();
          return document.querySelectorAll('.tree-file').length > 0;
        })()`,
        30000,
      );
    } catch (e) {
      const dump = await cdp.evalJs(`(() => ({
        stats: document.querySelector('.proj-stats')?.innerText ?? null,
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
    await cdp.insertText(`\n${marker}\n`);
    await sleep(800);
    const dirty = await cdp.evalJs(`!!document.querySelector('.dirty-dot.on')`);
    if (!dirty) throw new Error('editor not marked dirty after insertText');
    // 点保存
    await cdp.evalJs(`(() => {
      const b = document.querySelector('.editor-toolbar button.primary.small');
      if (b && !b.disabled) { b.click(); return 'saved-click'; }
      return 'save-disabled';
    })()`);
    // 等保存完成（状态显示"已保存"）
    await waitFor(cdp, `/已保存/.test(document.querySelector('.editor-status')?.innerText ?? '')`, 20000, 500);

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
    if (!cResult.ok && /写允许域拒绝/.test(cResult.err)) {
      P('c', '域外写被拒', `拒绝且文案含「写允许域拒绝」: ${cResult.err.slice(0, 90)}`);
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
    await cdp.evalJs(`(() => {
      const b = [...document.querySelectorAll('.project-header button')].find(e=>e.textContent.includes('关闭项目'));
      if (b) { b.click(); return 'closed-click'; }
      return 'no-close-button';
    })()`);
    await waitFor(cdp, `!!document.querySelector('.welcome')`, 30000);
    const dPath = path.join(GAME_DIR, '_kojo_smoke_after_close.txt');
    const dResult = await cdp.evalJs(`(async () => {
      const inv = ${INV};
      try {
        await inv('write_file_bytes', { path: ${JSON.stringify(dPath)}, data: btoa('nope') });
        return { ok: true, err: null };
      } catch (e) { return { ok: false, err: String(e) }; }
    })()`);
    if (!dResult.ok && /写允许域拒绝/.test(dResult.err)) {
      P('d', '关闭项目后写游戏目录被拒', `拒绝且文案含「写允许域拒绝」: ${dResult.err.slice(0, 90)}`);
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
  }

  /* ------------------------------ 汇总 ------------------------------ */
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n================ 冒烟汇总 ================');
  for (const r of results) console.log(`${r.status.padEnd(4)} ${r.id.padEnd(3)} ${r.name}: ${r.detail}`);
  console.log(`共 ${results.length} 项；FAIL ${failCount}`);
  console.log(failCount === 0 ? '✅ tauri IPC 冒烟全部通过' : '❌ tauri IPC 冒烟存在失败项');
  process.exit(failCount === 0 ? 0 : 1);
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