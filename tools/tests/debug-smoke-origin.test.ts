/**
 * 调试通道防假绿钉（2026-10-26 era-pair 批，PITFALLS 230）——两条同族病根的回归网：
 *
 * ① `tools/debug-web-smoke.mjs` 必须显式 `--host 127.0.0.1` 起 vite，并在 CDP 页面挂上后
 *    **立刻用 smoke-lib 的 `assertPageOrigin` 钉 origin**——vite 缺省 localhost 在 Windows
 *    常只落 `::1`，页面 URL 写 127.0.0.1 就是 ERR_CONNECTION_REFUSED 超时假红；origin 不钉
 *    还可能漂到**别的树**的 dev server 上拿假绿（与 smoke-tauri-ipc 同口径）。
 * ② `tools/debug-cli.mjs` 真壳 open-project 不许回到「点最近项目第一行」的猜路形态
 *    （PITFALLS 230 的假绿本体：要开 eraAV 回执 eraAkumaMaid），且幂等闸与落定闸都要走
 *    **忽略大小写的逐字对拍**（Windows 路径口径）。
 *
 * 形状钉（源文本级）刻意只认结构锚、不认整句文案；文案怎么改都红不了，猜路复活必红。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TOOLS = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const cliSrc = readFileSync(path.join(TOOLS, 'debug-cli.mjs'), 'utf8');
const smokeSrc = readFileSync(path.join(TOOLS, 'debug-web-smoke.mjs'), 'utf8');

describe('debug-web-smoke：IPv4 绑定 + origin 钉（PITFALLS 230 同族）', () => {
  it('起 vite 的参数里显式带 --host 127.0.0.1（与 debug-cli serve 同口径）', () => {
    expect(smokeSrc).toMatch(/'--strictPort',\s*'--host',\s*'127\.0\.0\.1'/);
  });

  it('页面挂上后第一件事是 assertPageOrigin，期望值就是我们自己的 127.0.0.1:vitePort', () => {
    expect(smokeSrc).toMatch(/from '\.\/smoke-lib\.mjs'/);
    // 2026-10-31：冒烟切成具名段后，vite 端口在段里是 `c.vitePort`（跨段共享现场）。
    // 判据要的是"期望 origin 由我们自己的 vite 端口拼出来"，不是那个标识符非得叫 vitePort ——
    // 两种写法都收，但**端口来源必须是同一处**（`c.` 之外不许出现别的端口表达式）。
    expect(smokeSrc).toMatch(/assertPageOrigin\(cdp, `http:\/\/127\.0\.0\.1:\$\{(?:c\.)?vitePort\}`\)/);
    // 必须在欢迎页等待之前——漂了要当场带 href 红，不是等 30s 超时谜之红
    expect(smokeSrc.indexOf('assertPageOrigin(cdp')).toBeLessThan(smokeSrc.indexOf("label: '欢迎页'"));
  });
});

describe('debug-cli 真壳 open-project：猜路已死，对拍当家（PITFALLS 230 本体）', () => {
  it('「点最近项目第一行」的猜路通道不在源里复活（recentOpenRowSel 零出现）', () => {
    expect(cliSrc).not.toContain('recentOpenRowSel');
  });

  it('幂等闸与 rootDir 落定闸都走忽略大小写的 samePath 对拍', () => {
    const calls = cliSrc.match(/samePath\(/g) ?? []; // 定义写作 `samePath = (`，不计入——只数调用
    // 两处调用都须在（已开同项目幂等直过 / 结尾硬对拍防假绿）
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // 硬对拍必须在成功回执 [ok] 之前——不一致绝不打印成功
    expect(cliSrc.indexOf('samePath(')).toBeGreaterThan(cliSrc.indexOf('const abs = path.resolve(dir)'));
    expect(cliSrc).toMatch(/if \(!samePath\(path\.resolve\(String\(st\)\), abs\)\)/);
  });

  it('真壳模式对写授权诚实：--writable 直接如实拒（准入门只认真实对话框交付）', () => {
    // 锚定 cmdOpenProject 的模式分叉（首个 `if (s.mode === 'shell') {`——幂等闸之前没有别的这形）
    const shellArm = cliSrc.indexOf("if (s.mode === 'shell') {");
    expect(shellArm).toBeGreaterThan(-1);
    expect(cliSrc.slice(shellArm, shellArm + 600)).toContain("--writable");
  });
});
