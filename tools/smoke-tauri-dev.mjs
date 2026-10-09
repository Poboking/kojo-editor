#!/usr/bin/env node
/**
 * tauri dev 自动冒烟：启动 → 监测（vite 端口 / 进程存活 / 关键日志）→ 自动清场。
 *
 * 为什么需要：GUI 应用无法"跑测试"，但可以验证启动链路完整——
 * vite dev server 起监听、Tauri 宿主进程存活、前端无致命报错、窗口进程不闪退。
 *
 * 用法：node tools/smoke-tauri-dev.mjs [监测秒数，默认 75]
 * 退出码：0 = 冒烟通过；1 = 失败（输出诊断）。
 * 注意：会短暂弹出应用窗口（结束后自动关闭）。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WATCH_SECONDS = Number(process.argv[2] ?? 75);

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

console.log('[smoke] launching tauri dev …');
const child = spawn('pnpm --filter @kojo/app tauri dev', {
  shell: true,
  cwd: ROOT,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
let output = '';
child.stdout.on('data', (d) => {
  output += d.toString();
});
child.stderr.on('data', (d) => {
  output += d.toString();
});

let exited = false;
let exitInfo = '';
child.on('exit', (code) => {
  exited = true;
  exitInfo = `exit code ${code}`;
});

const checks = { viteUp: false, windowProcess: false, noFatal: true };
const started = Date.now();

while (Date.now() - started < WATCH_SECONDS * 1000) {
  await sleep(2000);
  if (exited) {
    console.log(`[smoke] child exited early (${exitInfo}); output tail:\n${output.slice(-2500)}`);
    process.exit(1);
  }
  if (!checks.viteUp && (await portOpen(1420))) {
    checks.viteUp = true;
    console.log('[smoke] vite dev server is listening on 1420 ✓');
  }
  // 窗口进程：tauri 编译完成并启动后，输出中会出现 Running / kojo-editor.exe
  if (!checks.windowProcess && /Running `target\\debug\\kojo-editor|target\\debug\\kojo-editor\.exe/.test(stripAnsi(output))) {
    checks.windowProcess = true;
    console.log('[smoke] tauri host binary launched ✓');
  }
  if (/error(\[|:)/i.test(output.split('\n').slice(-40).join('\n'))) {
    checks.noFatal = false;
  }
  if (checks.viteUp && checks.windowProcess) {
    // 再观察 12 秒确认不闪退
    await sleep(12_000);
    if (!exited && checks.noFatal) {
      console.log('[smoke] window stable for 12s ✓');
      break;
    }
  }
}

const passed = checks.viteUp && checks.windowProcess && checks.noFatal && !exited;

console.log(`[smoke] checks: ${JSON.stringify(checks)} exited=${exited}`);
console.log('[smoke] output tail:\n' + output.slice(-1800));

// 清场：杀进程树（Windows）
if (!exited && child.pid) {
  console.log('[smoke] terminating process tree pid=' + child.pid);
  spawnSync(`taskkill /PID ${child.pid} /T /F`, { shell: true, stdio: 'ignore' });
}

if (passed) {
  console.log('✅ tauri dev smoke passed');
  process.exit(0);
} else {
  console.log('❌ tauri dev smoke failed');
  process.exit(1);
}
