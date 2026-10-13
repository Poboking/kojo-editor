#!/usr/bin/env node
/**
 * tauri dev 深度冒烟：进程级 + **DOM 级**验证。
 *
 * **断言口径（§5.117 定，别再改回来看文案）**：DOM 级只看**结构**（`.welcome` /
 * `.welcome-card` 在不在、`.notice`"内核装配中"是否已消失），**不匹配任何界面文案**。
 * 界面文案是 UI 批的常改项，硬编码一句就会把一个渲染正常的 app 判成红
 * （本工具原先要求屏上出现 `选择 eraTW 游戏目录`，而实际文案是 `选择游戏目录`）。
 * 同理端口探测两个协议栈都试（vite 7 在本机只绑 `::1`）。
 *
 * 进程级：vite 端口 / tauri 进程 / 不闪退（同 smoke-tauri-dev.mjs）；
 * DOM 级：通过 WebView2 远程调试端口（CDP）连接，执行 JS 检查 React 是否真正渲染
 *        （欢迎页/内核 bootstrap 状态），排除"窗口起来但白屏"的情况。
 *
 * 用法：node tools/smoke-tauri-dom.mjs [监测秒数，默认 100]
 * 退出码：0 = 通过；1 = 失败。
 * 注意：会短暂弹出应用窗口（结束后自动关闭）。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WATCH_SECONDS = Number(process.argv[2] ?? 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpenOn(host, port) {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
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

/**
 * vite / CDP 端口探测必须**两个协议栈都试**：vite 7 监听 `localhost`，
 * 在部分 Windows 上只绑到 `::1`（本机实测如此）——只连 `127.0.0.1` 会得到
 * "vite 没起来"的假红，而日志里明明写着 `ready in 601ms`（§5.117）。
 */
async function portOpen(port) {
  return (await portOpenOn('127.0.0.1', port)) || (await portOpenOn('::1', port));
}

/** 通过 CDP 在页面里执行表达式 */
async function cdpEval(wsUrl, expression, timeoutMs = 15000) {
  const ws = new WebSocket(wsUrl);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('cdp timeout'));
    }, timeoutMs);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id === 1) {
          clearTimeout(timer);
          ws.close();
          resolve(msg.result?.result?.value);
        }
      } catch {}
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error('ws error'));
    };
  });
}

/**
 * 前置条件由工具自己把关（人工清单 §0 一直写着"1420 / 9222 须空闲"，但工具不检查）。
 * 不检查的代价实测过一次：上一轮残留的 vite 占着 1420 ⇒ 本轮 `tauri dev` 的
 * BeforeDevCommand 直接失败，而探针最后报的是"DOM 未挂载"——**一个与会话无关的假诊断**，
 * 白白多跑一轮才看清（§5.117）。红要红在真正的原因上。
 */
const busy = [];
for (const p of [1420, 9222]) if (await portOpen(p)) busy.push(p);
if (busy.length > 0) {
  console.log(
    `[smoke] 端口已被占用：${busy.join(' / ')} —— 多半是上一轮 tauri dev / WebView2 残留。\n` +
      '        先清掉再跑：netstat -ano | findstr 端口  取 PID 后 taskkill /PID <pid> /T /F',
  );
  process.exit(2);
}

/**
 * 收尸要按**端口持有者**收，不能只杀 `child.pid` 那一棵树：
 * WebView2 与 vite 都会挂到树外（实测本工具跑完留下 `msedgewebview2` 占 9222、
 * `node` 占 `[::1]:1420`），下一轮就撞上"端口被占用"或更糟——一个假的 "DOM 未挂载"（§5.117）。
 * 这两个端口是我们的专用调试口：真被别人占着的话，前置检查早就拦下了。
 */
function killPortOwners(ports) {
  const ns = spawnSync('netstat -ano', { shell: true, encoding: 'utf8' }).stdout ?? '';
  const pids = new Set();
  for (const line of ns.split('\n')) {
    if (!/LISTENING/i.test(line)) continue;
    if (!ports.some((p) => new RegExp(`[:.]${p}\\s`).test(line))) continue;
    const pid = line.trim().split(/\s+/).pop();
    if (pid && /^\d+$/.test(pid) && Number(pid) !== process.pid) pids.add(pid);
  }
  for (const pid of pids) spawnSync(`taskkill /PID ${pid} /T /F`, { shell: true, stdio: 'ignore' });
  return [...pids];
}

console.log('[smoke] launching tauri dev (with CDP 9222) …');
const child = spawn('pnpm --filter @kojo/app tauri dev', {
  shell: true,
  cwd: ROOT,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
let output = '';
child.stdout.on('data', (d) => (output += d.toString()));
child.stderr.on('data', (d) => (output += d.toString()));
let exited = false;
child.on('exit', (code) => {
  exited = true;
  output += `\n[smoke] child exited with code ${code}`;
});

const checks = { viteUp: false, hostLaunched: false, cdpUp: false, domRendered: false, domText: '', rootChildren: 0 };
const started = Date.now();

while (Date.now() - started < WATCH_SECONDS * 1000) {
  await sleep(2000);
  if (exited) break;
  if (!checks.viteUp && (await portOpen(1420))) {
    checks.viteUp = true;
    console.log('[smoke] vite 1420 ✓');
  }
  if (!checks.hostLaunched && /Running `target\\debug\\kojo-editor/.test(stripAnsi(output))) {
    checks.hostLaunched = true;
    console.log('[smoke] host binary launched ✓');
  }
  if (checks.hostLaunched && !checks.cdpUp && (await portOpen(9222))) {
    checks.cdpUp = true;
    console.log('[smoke] CDP 9222 ✓');
  }
  if (checks.cdpUp && !checks.domRendered) {
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json')).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const raw = await cdpEval(
          page.webSocketDebuggerUrl,
          `JSON.stringify({
             welcome: !!document.querySelector('.welcome'),
             card: !!document.querySelector('.welcome-card'),
             mounting: !!document.querySelector('.notice'),
             rootChildren: (document.getElementById('root') || document.body.firstElementChild || {childElementCount:0}).childElementCount,
             text: document.body ? document.body.innerText.slice(0, 600) : '(no body)',
           })`,
        );
        const dom = JSON.parse(String(raw ?? '{}'));
        checks.domText = String(dom.text ?? '');
        // **"React 真的挂载了"只看结构，不看文案**：欢迎页的按钮文案是 UI 批的常改项
        // （这句原先硬编码 `选择 eraTW 游戏目录`，文案一旦改成 `选择游戏目录`
        //  探针就把一个渲染正常的 app 判成红——§5.117）。
        // 结构判据：欢迎页根 + 卡片都在；"内核装配中…"的 `.notice` 态**不算过**（那正是白屏的近亲）。
        checks.domRendered = dom.welcome === true && dom.card === true && dom.mounting !== true;
        checks.rootChildren = dom.rootChildren;
        if (/Error|错误|失败/.test(checks.domText)) {
          console.log('[smoke] ⚠ error text on page:', checks.domText.slice(0, 300));
        }
        console.log(
          `[smoke] DOM 结构: welcome=${dom.welcome} card=${dom.card} notice=${dom.mounting} ` +
            `rootChildren=${dom.rootChildren}`,
        );
        console.log('[smoke] DOM text captured:', JSON.stringify(checks.domText.slice(0, 160)));
      }
    } catch (e) {
      console.log('[smoke] CDP eval retry:', String(e).slice(0, 120));
    }
  }
  if (checks.domRendered) break;
}

const passed = checks.viteUp && checks.hostLaunched && checks.cdpUp && checks.domRendered && !exited;
console.log(`[smoke] checks: ${JSON.stringify(checks)} exited=${exited}`);
console.log('[smoke] output tail:\n' + output.slice(-1200));

if (!exited && child.pid) {
  console.log('[smoke] terminating pid=' + child.pid);
  spawnSync(`taskkill /PID ${child.pid} /T /F`, { shell: true, stdio: 'ignore' });
}
// 树外残留（WebView2 / vite）单独收，否则端口留给下一轮
const orphans = killPortOwners([1420, 9222]);
if (orphans.length > 0) console.log('[smoke] 已清掉树外残留进程 pid=' + orphans.join(' / '));

console.log(passed ? '✅ tauri DOM smoke passed' : '❌ tauri DOM smoke failed');
if (!passed) {
  // 不静默：红的时候要说清"缺哪一项、当时屏上是什么"，否则又要人回来问
  console.log(
    '[smoke] 未满足：' +
      [
        !checks.viteUp && 'vite 1420 未监听（IPv4/IPv6 都试过）',
        !checks.hostLaunched && '未看到 `Running target\\debug\\kojo-editor`',
        !checks.cdpUp && 'CDP 9222 未监听',
        !checks.domRendered && 'DOM 未挂载（要求 .welcome + .welcome-card 且无 .notice；rootChildren 见 checks）',
        exited && '进程提前退出',
      ]
        .filter(Boolean)
        .join(' ｜ '),
  );
}
process.exit(passed ? 0 : 1);
