#!/usr/bin/env node
/**
 * 带重试的直连 GitHub 推送（本机网络环境专用）。
 *
 * 背景：本机 github.com 直连时通时断（环境变量坏代理 + 线路抖动），
 * 单次 push 经常 21s 超时失败；实测「清空代理环境变量直连 + 5s 间隔重试」
 * 是命中率最高的姿势（见 ~/.workbuddy/skills/windows-net-troubleshoot）。
 *
 * 用法：node tools/git-push.mjs [remote] [branch]   （默认 origin master）
 * 退出码：0 = 推送成功；1 = 全部重试失败。
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const remote = process.argv[2] ?? 'origin';
const branch = process.argv[3] ?? 'master';
const MAX_TRIES = 6;
const DELAY_MS = 5000;

const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete env[k];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

for (let i = 1; i <= MAX_TRIES; i++) {
  const r = spawnSync(`git push ${remote} ${branch}`, {
    shell: true,
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: cleanEnv(),
  });
  if (r.status === 0) {
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    console.log(`✅ push OK (try ${i})`);
    if (out) console.log(out);
    process.exit(0);
  }
  const msg = ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 140);
  console.warn(`⏳ try ${i}/${MAX_TRIES} failed: ${msg}`);
  if (i < MAX_TRIES) sleep(DELAY_MS);
}

console.error('❌ push failed after all retries. 检查网络/代理后重试。');
process.exit(1);
