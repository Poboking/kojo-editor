#!/usr/bin/env node
/**
 * 带重试的 GitHub 推送（本机网络环境专用）。
 *
 * 背景：本机 github.com 直连时通时断（环境变量坏代理 + 线路抖动），
 * 单次 push 经常 21s 超时失败。旧口径是「清空代理环境变量直连 + 5s 间隔重试」
 * （见 ~/.workbuddy/skills/windows-net-troubleshoot），但**它不是always成立**：
 * 2026-10-13 凌晨一次推送里，直连 **6/6 全部失败**（`Failed to connect to github.com:443`），
 * 而带本地代理（地址经 `KOJO_GIT_PROXY` 提供）**一次就通**。
 * ⇒ 现在**交替试**：奇数趟直连、偶数趟走代理，两边都可能赢，不赌单一姿势。
 *
 * 用法：node tools/git-push.mjs [remote] [branch]   （默认 origin dev；日常落地分支＝dev，main 只在发版时动）
 *      代理地址经环境变量 `KOJO_GIT_PROXY` 提供（未设置 = 只试直连）。
 * 退出码：0 = 推送成功；1 = 全部重试失败。
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const remote = process.argv[2] ?? 'origin';
const branch = process.argv[3] ?? 'dev';
const MAX_TRIES = 6;
const DELAY_MS = 5000;
/** 本地代理；`KOJO_GIT_PROXY=""` 或未设置 = 纯直连（不试代理趟） */
const PROXY = process.env.KOJO_GIT_PROXY ?? '';

const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete env[k];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
};

/** 代理趟：`-c` 是 git 侧最可靠的代理口径，环境变量再补一层给可能的子进程 */
const proxyEnv = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  HTTP_PROXY: PROXY,
  HTTPS_PROXY: PROXY,
  http_proxy: PROXY,
  https_proxy: PROXY,
});

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

for (let i = 1; i <= MAX_TRIES; i++) {
  const useProxy = PROXY !== '' && i % 2 === 0;
  const gitProxyArgs = useProxy ? `-c http.proxy=${PROXY} -c https.proxy=${PROXY} ` : '';
  const r = spawnSync(`git ${gitProxyArgs}push ${remote} ${branch}`, {
    shell: true,
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: useProxy ? proxyEnv() : cleanEnv(),
  });
  if (r.status === 0) {
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    console.log(`✅ push OK (try ${i}, ${useProxy ? 'via proxy' : 'direct'})`);
    if (out) console.log(out);
    process.exit(0);
  }
  const msg = ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 140);
  console.warn(`⏳ try ${i}/${MAX_TRIES} failed (${useProxy ? 'proxy' : 'direct'}): ${msg}`);
  if (i < MAX_TRIES) sleep(DELAY_MS);
}

console.error('❌ push failed after all retries. 检查网络/代理后重试。');
process.exit(1);
