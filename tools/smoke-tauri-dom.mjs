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
 * **L1-0 两条硬断言（2026-10-16 首屏批；取证层 = `tools/boot-probe.mjs`，dev/release 共用）**：
 * ① 开机 ≤500 ms 内 `#root` 非空**或** body 计算底色已落到**该 `data-theme` 档应有的 `--bg`**
 *    ——三方对撞：内联脚本 parse 期样本（style 一 parse 即生效且不会退场，最迟 ≤500 ms 成立）
 *    ＋ t+500 ms 采样兜底支 ＋ `expectedBootBg(档)` 从源码现读的 `--bg`
 *    （dark 档真源在 `packages/app/src/styles.css` 基础 `:root`，light / mint-dark 在 `themes/<档>.css`）；
 *    同时钉「**内联底色 == 该档 `--bg` == React 挂载后的计算底色**」（任一处漂移即红，
 *    也防两个手写源同时漂成第三种颜色）与「#boot-splash 已被移除」。
 *    ⚠ 这条判据**不要求深色**：浅色用户开机底色 `#f6f8fa` 是设置不是故障（旧「亮度 < 96」
 *    硬编码在主题系统落地后必然假红，已于 2026-10-17 改掉）。
 * ② 欢迎页可点（`boot.welcomeInteractive`，自导航起点 ms）**之前**的网络请求不得含 monaco。
 *    **取证优先级写死**：CDP Network 域（`Network.enable` + `Page.reload` 重跑一轮开机，只认本轮
 *    `loaderId` 的事件、以本轮 Document 请求为锚点切分）> 页内资源时间线（回退口径）。
 *    回退口径不可全信的理由是实证的：dev 的 monaco 模块图 ~1338 条会截断缓冲，组长实测出现过
 *    `total=29` 这种数不全的读数 ⇒ 单靠它判绿就是假绿。内联脚本已把缓冲放大到 6000 条，
 *    但**放大不失败≠数得全**，所以两条口径的条目数都要打出来对看。
 *    另设**反空匹配自证**：整轮 Network 域一条 monaco 都没见到（可点之后 idle 预取必然拉到
 *    ProjectView chunk）= 匹配面失效，此时判红不判绿。
 *    idle 预取发生在可点**之后**，不在 cut 内（App.tsx 里「先记标记、再排 rIC」是本断言的
 *    口径依赖，别调换顺序）。
 *
 * 用法：node tools/smoke-tauri-dom.mjs [监测秒数，默认 100]
 * 退出码：0 = 通过；1 = 失败；2 = 前置不满足（端口被占 / 断言①底色真源读不到）。
 * 注意：会短暂弹出应用窗口（结束后自动关闭）。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  collectBoot,
  judgeBoot,
  expectedBootBg,
  bootMarkLines,
  captureBootNetwork,
  resolveA2,
  fmtBoot,
} from './boot-probe.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const WATCH_SECONDS = Number(process.argv[2] ?? 100);
/** 断言②的 Network 域取证轮（Page.reload 重跑一轮开机）最多等多久 */
const NETWORK_WAIT_MS = Number(process.env.KOJO_BOOT_NETWORK_WAIT_MS ?? 90000);
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

// L1-0 的页内采样 / 底色真源对撞 / Network 域取证 / 断言判定全部下沉到 `tools/boot-probe.mjs`
// （与 release 形态的 `tools/boot-marks.mjs` 共用同一份口径，不再各抄一遍）。

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

/**
 * 断言①的**底色真源**在起壳之前先过一遍（三档各现读一次 `--bg`）：真源塌了必须在这里响——
 * 抛在采样循环里会被当成「boot 采样重试」，抛在后面又会把已起的壳和 1420/9222 端口留成孤儿。
 * 这一趟只读三个小文件，比白烧一轮 ~100s 桌面预算便宜得多（前置条件由工具自己把关，同上面的端口检查）。
 */
try {
  for (const t of ['dark', 'light', 'mint-dark']) expectedBootBg(t);
} catch (e) {
  console.log(`[smoke] 断言①底色真源塌了：${String(e && e.message ? e.message : e)}`);
  process.exit(2);
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

const checks = {
  viteUp: false,
  hostLaunched: false,
  cdpUp: false,
  domRendered: false,
  domText: '',
  rootChildren: 0,
  // L1-0（见文件头）：boot = collectBoot 的原始采样；a1/a2 = 两条硬断言；splashGone = 引导层已撤
  // a2 判定口径写在 a2Caliber（Network 域优先，取不到才退回页内资源时间线）
  bootChecked: false,
  bootAttempts: 0,
  boot: null,
  bootWsUrl: '',
  a1: false,
  a2: false,
  a2Caliber: '',
  splashGone: false,
  networkTotal: null,
  networkMonacoBefore: null,
  networkMonacoTotal: null,
};
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
  if (checks.domRendered && !checks.bootChecked) {
    // 冷开机这一轮的读数（四标记 + 断言①）。判定在 boot-probe.judgeBoot，本文件不再自写口径。
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json')).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const raw = await cdpEval(page.webSocketDebuggerUrl, `(${collectBoot.toString()})()`);
        const b = JSON.parse(String(raw ?? 'null'));
        checks.bootAttempts += 1;
        if (b && (b.welcome !== null || checks.bootAttempts >= 3)) {
          // 断言①的第三方真源：按**这一档**（页内 data-theme）源码里的 --bg 判底色，不要求深色
          const j = judgeBoot(b, expectedBootBg(b.dataTheme));
          checks.boot = b;
          checks.bootWsUrl = page.webSocketDebuggerUrl;
          checks.a1 = j.a1;
          checks.splashGone = j.splashGone;
          // 断言②先按**时间线回退口径**记着，Network 域取证在后面覆盖它
          checks.a2 = j.a2Timeline;
          checks.a2Caliber = '页内资源时间线（回退口径，Network 域未取到）';
          checks.bootChecked = true;
          console.log(
            `[smoke] L1-0 断言①=${checks.a1}（档位=${j.theme} 该档源码 --bg=${j.expectedBg} ` +
              `htmlParsed=${fmtBoot(j.htmlParsed)} 内联bg=${j.bgAtParse} ` +
              `挂载后bg=${j.bgNow} t500.root=${j.t500Root ?? 'n/a'}；三分支 earlyBgOk=${j.earlyBgOk} ` +
              `earlyRoot=${j.earlyRoot} 三方底色钉=${j.pinOk}）`,
          );
          console.log(
            `[smoke] 断言②时间线口径读数：资源 ${b.resourceCount} 条（可点前 ${b.beforeCount} 条，` +
              `其中 monaco ${b.monacoBeforeCount} 条${b.monacoBeforeCount > 0 ? '：' + b.monacoBefore.join(' | ') : ''}），` +
              `整轮 monaco ${b.monacoTotalCount} 条`,
          );
          console.log(`[smoke] 引导层已移除=${checks.splashGone}`);
        } else {
          console.log('[smoke] boot 标记未就绪（等 boot.welcomeInteractive）…');
        }
      }
    } catch (e) {
      console.log('[smoke] boot 采样重试:', String(e).slice(0, 120));
    }
  }
  if (checks.domRendered && checks.bootChecked) break;
}

// —— 断言②的**取证首选口径**：CDP Network 域（口径与理由见文件头 / boot-probe.mjs 头注）——
// 常驻会话里 Network.enable 后 Page.reload 重跑一轮开机，才拿得到「可点前」那段（第一轮的
// 事件在探针连上之前就丢了）。取不到不硬判绿：如实退回上面的时间线读数并标注口径。
if (checks.bootChecked && checks.bootWsUrl) {
  const cap = await captureBootNetwork({
    wsUrl: checks.bootWsUrl,
    waitMs: NETWORK_WAIT_MS,
    log: (s) => console.log(`[smoke] ${s}`),
  });
  checks.networkTotal = cap.ok ? cap.total : null;
  if (!cap.ok) {
    console.log(`[smoke] Network 域取证未成功：${cap.reason}——断言②退回页内资源时间线口径（dev 下缓冲可能数不全）`);
  } else {
    const a2 = resolveA2(cap, cap.page, judgeBoot(cap.page, expectedBootBg(cap.page.dataTheme)));
    checks.a2 = a2.ok;
    checks.a2Caliber = a2.used;
    checks.networkMonacoBefore = cap.monacoBeforeCount;
    checks.networkMonacoTotal = cap.monacoTotalCount;
    console.log(
      `[smoke] Network 域取证：本轮 ${cap.total} 条请求（可点前 ${cap.beforeCount} 条，` +
        `其中 monaco ${cap.monacoBeforeCount} 条${cap.monacoBeforeCount > 0 ? '：' + cap.monacoBefore.join(' | ') : ''}），` +
        `整轮 monaco ${cap.monacoTotalCount} 条；时基=${cap.basis}（与页内时间线交集 ${cap.overlap} 条：原值 ${cap.exactCount} / 拟合 ${cap.fittedCount}，` +
        `偏差中位 ${Math.round(cap.offset)}ms，离散 ${cap.spread === null ? 'n/a' : Math.round(cap.spread) + 'ms'}）；锚点=${cap.anchor}`,
    );
    console.log(
      `[smoke] 断言②=${a2.ok}（口径=${a2.used}）—— ${a2.reason}` +
        `；对照：时间线 ${cap.page.resourceCount} 条 vs Network 本轮 ${cap.total} 条` +
        (cap.total > cap.page.resourceCount ? '（时间线确实数不全，回退口径不可信）' : ''),
    );
    console.log('[smoke] 二轮开机（Page.reload 那一轮）四标记：');
    for (const line of bootMarkLines(cap.page)) console.log('  ·' + line.slice(1));
  }
} else if (checks.bootChecked) {
  console.log('[smoke] Network 域取证跳过：没拿到页面 WS 地址——断言②按页内资源时间线口径判（dev 下缓冲可能数不全）');
}

// L1-0 四标记读数表（冷开机那一轮；release 形态用 tools/boot-marks.mjs 同口径采）
if (checks.boot) {
  console.log('[smoke] boot 四标记（自导航起点 ms，冷开机轮）：');
  for (const line of bootMarkLines(checks.boot)) console.log(line);
}

const passed =
  checks.viteUp &&
  checks.hostLaunched &&
  checks.cdpUp &&
  checks.domRendered &&
  checks.bootChecked &&
  checks.a1 &&
  checks.a2 &&
  checks.splashGone &&
  !exited;
console.log(`[smoke] checks: ${JSON.stringify({ ...checks, boot: undefined, bootWsUrl: undefined })} exited=${exited}`);
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
        !checks.bootChecked && '未采到 L1-0 boot 标记（boot.welcomeInteractive 一直未上报）',
        checks.bootChecked && !checks.a1 && 'L1-0 断言①未过（≤500ms 内底色未落到该 data-theme 档应有的 --bg、也未见 #root 非空，' +
          '或 内联底色 / 挂载后计算底色 != 该档源码的 --bg；档位与三方读数见上方打印行）',
        checks.bootChecked && !checks.a2 && `L1-0 断言②未过（口径=${checks.a2Caliber || '未采'}：可点前出现过 monaco 请求，` +
          `或整轮一条 monaco 都没采到=匹配面可疑；Network 域读数 ${checks.networkMonacoBefore ?? 'n/a'}/${checks.networkMonacoTotal ?? 'n/a'} 条，` +
          `时间线读数见上方）`,
        checks.bootChecked && !checks.splashGone && '引导层 #boot-splash 未被移除（应在 React 首次提交后撤罩）',
        exited && '进程提前退出',
      ]
        .filter(Boolean)
        .join(' ｜ '),
  );
}
process.exit(passed ? 0 : 1);
