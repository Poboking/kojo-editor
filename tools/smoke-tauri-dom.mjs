#!/usr/bin/env node
/**
 * tauri dev 深度冒烟：进程级 + **DOM 级**验证。
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

const checks = { viteUp: false, hostLaunched: false, cdpUp: false, domRendered: false, domText: '' };
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
        const text = await cdpEval(
          page.webSocketDebuggerUrl,
          'document.body ? document.body.innerText.slice(0, 600) : "(no body)"',
        );
        checks.domText = String(text ?? '');
        // 内核就绪 = Onboarding 按钮出现；若停留在装配中文案则继续等待
        checks.domRendered = checks.domText.includes('选择 eraTW 游戏目录');
        if (/Error|错误|失败/.test(checks.domText)) {
          console.log('[smoke] ⚠ error text on page:', checks.domText.slice(0, 300));
        }
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

console.log(passed ? '✅ tauri DOM smoke passed' : '❌ tauri DOM smoke failed');
process.exit(passed ? 0 : 1);
