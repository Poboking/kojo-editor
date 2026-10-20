/**
 * 两个真壳冒烟工具（`smoke-tauri-market` / `smoke-tauri-ipc`）共用的小件。三件事，全是
 * 2026-10-17 实测换来的：
 *
 * 1. **端口占用要两个地址族都试**：别的树的 vite 可能只挂 `[::1]:1420`（本机实测如此），
 *    只试 `127.0.0.1` 会放行；而 devUrl 写的是 `localhost`，WebView2 走 IPv6 优先就会把壳
 *    驱动到**别的树的 dev server** 上——测出来的绿与本次改动无关（假绿）。宁可 rc=2 退避。
 * 2. **起壳后先钉页面 origin**：页面不在预期 dev 地址上就失败，不判绿（同上那条假绿的第二道闸）。
 * 3. **开项目后不止「写权限确认」一种模态**：会话恢复带 ERB 标签会弹「.kojo 预览」首次引导，
 *    只找「允许写入」再等 `.modal` 消失会死等到超时。这里按白名单逐朵答掉；
 *    **不认识的模态不瞎点**，直接抛错并把按钮原样打出来，让下一个人补白名单。
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const DEFAULT_VITE_PORT = 1420;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 答得下去的问句（安全语义：授权写入 / 不开启预览）。加新项前先确认它不会动用户数据 */
export const SAFE_ANSWERS = ['允许写入', '不用'];

export function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.setTimeout(1200);
    s.on('connect', () => { resolve(true); s.destroy(); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { resolve(false); s.destroy(); });
  });
}

/** 任一地址族上可连即算占用（只挂 `::1` 的情况本机实测存在） */
export async function portBusy(port) {
  const [v4, v6] = await Promise.all([portOpen(port, '127.0.0.1'), portOpen(port, '::1')]);
  return v4 || v6;
}

/**
 * 本次要起的 dev 地址：默认取仓库配置（`tauri.conf.json` 的 `build.devUrl` 与
 * `vite.config.ts` 的 `server.port`，两者不一致直接抛——配置自相矛盾时先修配置）。
 *
 * `KOJO_SMOKE_VITE_PORT` 可改端口，且**不碰仓库里的配置文件**（那是别人的工作副本）：
 * 把合并配置写进临时 JSON 交给 `tauri dev --config <path>`（实测 devUrl 与 beforeDevCommand
 * 都会生效）。代价写在返回的注释里：`TAURI_CONFIG` 变了会触发 cargo 重编 app crate（~30s）。
 *
 * 返回 `{ port, origin, tauriArgs, cleanup }`；`tauriArgs` 直接拼在 `tauri dev` 后面。
 *
 * `opts.isolateAppData`（可选，DOM 冒烟用）：在合并配置里把 `identifier` 换成
 * `<原 identifier>.smoke` ⇒ 这一轮的 `appDataDir` 落在一份独立身份下。为什么需要：
 * **别人的崩溃恢复横幅也带 `.notice`**，共用 `%APPDATA%` 时 DOM 冒烟的结构判据会把它当成
 * "内核装配中"而整轮判红（2026-10-20 实测：快照是一名 sibling 会话的未保存编辑，不能替它丢）；
 * 隔离后结构断言与用户数据彻底解耦，也不碰任何人的快照。代价同端口覆盖：
 * `TAURI_CONFIG` 变了会触发 cargo 重编 app crate。
 */
export function devTarget(root, opts = {}) {
  const confFile = path.join(root, 'packages', 'app', 'src-tauri', 'tauri.conf.json');
  const viteFile = path.join(root, 'packages', 'app', 'vite.config.ts');
  const conf = JSON.parse(fs.readFileSync(confFile, 'utf8'));
  const devUrl = new URL(conf.build?.devUrl ?? `http://localhost:${DEFAULT_VITE_PORT}`);
  const viteMatch = fs.readFileSync(viteFile, 'utf8').match(/\bport\s*:\s*(\d+)/);
  const vitePort = viteMatch ? Number(viteMatch[1]) : DEFAULT_VITE_PORT;
  if (Number(devUrl.port || DEFAULT_VITE_PORT) !== vitePort) {
    throw new Error(
      `配置自相矛盾：tauri.conf.json 的 devUrl 是 ${devUrl.port || DEFAULT_VITE_PORT}，`
      + `vite.config.ts 写 ${vitePort}——先对齐配置再跑冒烟`,
    );
  }

  const wanted = Number(process.env.KOJO_SMOKE_VITE_PORT ?? '') || 0;
  const overridePort = wanted !== 0 && wanted !== vitePort;
  const isolateAppData = opts.isolateAppData === true;
  if (!overridePort && !isolateAppData) {
    return { port: vitePort, origin: devUrl.origin, tauriArgs: [], cleanup: () => {} };
  }

  /* 端口覆盖：devUrl 这里**不写 localhost**——壳只认一个确定地址，页面 origin 才好钉 */
  const port = overridePort ? wanted : vitePort;
  const overrides = {};
  if (overridePort) {
    overrides.build = {
      devUrl: `http://127.0.0.1:${wanted}`,
      beforeDevCommand: `pnpm dev --port ${wanted} --host 127.0.0.1 --strictPort`,
    };
  }
  if (isolateAppData) {
    if (typeof conf.identifier !== 'string' || conf.identifier === '') {
      throw new Error('tauri.conf.json 没有 identifier，无法用隔离身份跑（appDataDir 无处落脚）');
    }
    overrides.identifier = `${conf.identifier}.smoke`;
  }
  const file = path.join(os.tmpdir(), `kojo-smoke-dev-${port}${isolateAppData ? '-iso' : ''}.json`);
  fs.writeFileSync(file, JSON.stringify(overrides, null, 2));
  return {
    port,
    origin: overridePort ? `http://127.0.0.1:${wanted}` : devUrl.origin,
    tauriArgs: ['--config', file],
    cleanup: () => { try { fs.rmSync(file, { force: true }); } catch {} },
  };
}

/** 页面必须落在预期 dev 地址上；否则抛错（不判绿）。返回 href 供日志 */
export async function assertPageOrigin(cdp, origin) {
  const href = await cdp.evalJs('location.href');
  let got = null;
  try { got = new URL(href).origin; } catch {}
  if (got !== origin) {
    throw new Error(
      `页面 origin 不是预期的 dev 地址：期望 ${origin}，实际 ${href}。\n`
      + '        端口被别人占着时，localhost 可能把壳带到别人的 dev server 上——这种绿不算数。',
    );
  }
  return href;
}

/**
 * 逐朵答掉当场挂着的问句（`choices` 白名单，默认 {@link SAFE_ANSWERS}）。
 *
 * 每轮重新读一次 `.modal`：答句可能引出下一朵（写权限批准后紧跟着首次引导，实测顺序不固定）。
 * 不认识的模态**不点**——抛错并带上标题与按钮原文。返回 `{ modals, answered }`：
 * `modals` = 见过的标题（去重），`answered` = 每朵实际按下的按钮。
 */
export async function answerAskDialogs(cdp, {
  choices = SAFE_ANSWERS,
  maxRounds = 12,
  pauseMs = 700,
  log = () => {},
} = {}) {
  const modals = [];
  const answered = [];
  for (let round = 0; round < maxRounds; round++) {
    const modal = await cdp.evalJs(`(() => {
      const m = document.querySelector('.modal');
      if (!m) return null;
      return {
        aria: m.getAttribute('aria-label') ?? '',
        head: (m.querySelector('h2')?.textContent ?? '').trim().slice(0, 60),
        buttons: [...m.querySelectorAll('.modal-actions button')].map((b) => ({ t: b.textContent.trim(), disabled: b.disabled })),
      };
    })()`);
    if (modal === null) break;
    const label = modal.aria || modal.head || '(无标题模态)';
    if (!modals.includes(label)) modals.push(label);
    const pick = modal.buttons.find(
      (b) => !b.disabled && choices.some((c) => b.t.includes(c)),
    );
    if (!pick) {
      const list = modal.buttons.map((b) => b.t).join(' / ') || '（没有按钮）';
      throw new Error(
        `遇到不认识的模态「${label}」：按钮 = ${list}。\n`
        + '        不瞎点（可能动用户数据）：确认它的安全答法后补进 smoke-lib 的 SAFE_ANSWERS 再跑。',
      );
    }
    const clicked = await cdp.evalJs(`(() => {
      const m = document.querySelector('.modal');
      if (!m) return 'gone';
      const b = [...m.querySelectorAll('.modal-actions button')]
        .find((el) => !el.disabled && el.textContent.trim() === ${JSON.stringify(pick.t)});
      if (!b) return 'no-button';
      b.click();
      return 'clicked';
    })()`);
    log(`模态「${label}」→ 点「${pick.t}」（${clicked}）`);
    answered.push({ aria: label, button: pick.t });
    await sleep(pauseMs);
  }
  const left = await cdp.evalJs(
    `(() => { const m = document.querySelector('.modal'); return m ? (m.getAttribute('aria-label') || '（无标题）') : null; })()`,
  );
  if (left !== null) {
    throw new Error(
      `答了 ${answered.length} 朵后仍有模态「${left}」在屏上（可能又弹了新的，或答句没生效）`,
    );
  }
  return { modals, answered };
}

/* ─────────────────────────── 欢迎页「最近项目」page-object ─────────────────────────── */

/**
 * 欢迎页「最近打开的项目」行的**唯一**选择段（SMOKE-RECENT 2026-10-20）。
 *
 * 旧版用 recent 容器 + button.link + recent-dir 三个类名拼出的选段，随欢迎页重设计已不存在；
 * 现在渲染的是（`packages/app/src/ui/WelcomeView.tsx`）：
 *   - `<section class="welcome-section welcome-recent">`  ← 项目区（不含同页的「最近文件」区，后者类名是 welcome-recent-files）
 *   - `<button class="welcome-recent-open">`              ← 行内可点开的按钮
 *   - `<span class="welcome-recent-path">{r.rootDir}</span>` ← 路径文本段
 *
 * 类名只准住在 `WELCOME_RECENT_CLASSES` 一处：消费方（四个真壳冒烟 + ui-measure）一律 import
 * 这里的构造函数，不许把上面任何类名手抄进自己的 querySelectorAll——`tools/tests/welcome-recent-selector.test.ts`
 * 双向钉死（WelcomeView 改类名 ⇒ 红；工具里再现旧选段或手抄新类名 ⇒ 红）。
 *
 * 所有函数都接收**已 JSON 编码的目录字符串**（即调用方写 `JSON.stringify(dir)`），
 * 返回**页内 JavaScript 源码字符串**——直接喂 `cdp.evalJs()` 或各工具的 `waitFor()`。
 */
export const WELCOME_RECENT_CLASSES = Object.freeze({
  section: 'welcome-recent',
  open:    'welcome-recent-open',
  path:    'welcome-recent-path',
});

const _wrSel = (k) => `.${WELCOME_RECENT_CLASSES[k]}`;

/** 「最近项目」区内可点开按钮的选择器（ui-measure 点第一行时直接用这个字符串） */
export const recentOpenRowSel = `${_wrSel('section')} ${_wrSel('open')}`;

/**
 * 页内表达式源：在「最近项目」区里找到 `rootDir` 文本恰好等于 `dirJson`（JSON 编码串）
 * 那行的可点按钮；找不到返回 `undefined`。
 * `recentRowWaitSrc` / `recentRowClickSrc` 都由此派生——选择段在此一处，不在他处重复。
 */
export function recentRowFinderSrc(dirJson) {
  return `[...document.querySelectorAll(${JSON.stringify(recentOpenRowSel)})]`
    + `.find((el) => el.querySelector(${JSON.stringify(_wrSel('path'))})?.textContent === ${dirJson})`;
}

/**
 * 页内表达式源：「最近项目」区是否已渲染出 `dirJson` 对应的行（返回布尔）——
 * 喂各工具的 `waitFor` / `waitRecent`。
 */
export function recentRowWaitSrc(dirJson) {
  return `!!(${recentRowFinderSrc(dirJson)})`;
}

/**
 * 页内 IIFE 源：点开 `dirJson` 对应的最近项目行，返回 `'clicked'` 或 `'no-button'`——
 * 喂各工具的 `cdp.evalJs`，调用方检查返回值是否为 `'clicked'`。
 */
export function recentRowClickSrc(dirJson) {
  return `(() => {
  const b = ${recentRowFinderSrc(dirJson)};
  if (!b) return 'no-button';
  b.click();
  return 'clicked';
})()`;
}
