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
 * **端口 / 页面 origin（2026-10-20 补，与 IPC / market 冒烟同口径）**：vite 端口默认按仓库配置
 * （`tauri.conf.json` 的 `build.devUrl` 与 `vite.config.ts` 的 `server.port`，当前 1420）；
 * `KOJO_SMOKE_VITE_PORT=<port>` 可换（临时合并配置走 `tauri dev --config`，机制与理由见
 * `tools/smoke-lib.mjs` 的 `devTarget`）。别的树只挂 `[::1]:1420` 而 devUrl 写 `localhost` 时，
 * WebView2 的 IPv6 优先会把壳驱动到**别人的 dev server** 上（测出来的绿与本次改动无关）；
 * 因此覆盖端口时 devUrl 固定写 `127.0.0.1:<port>`，并且**起壳后先钉页面 origin** 才判绿。
 * CDP 端口固定 9222（本工具自己拉起的 WebView2 专用调试口）。
 *
 * **崩溃恢复横幅不算"装配中"（2026-10-21，BOARD SMOKE-NOTICE）**：`.notice` 里有一条是
 * `WelcomeView` 的**崩溃恢复横幅**（`.notice.crash-recovery`：%APPDATA% 下有未保存快照时才出现，
 * 是"用户数据在场"而不是"内核没装好"）。共用 appData 时它会被当成"内核装配中"⇒ 整轮判红，
 * 而屏上其实渲染得好好的（`checks.domText` 里欢迎页内容一应俱全）。故判据收窄成
 * {@link MOUNTING_NOTICE_SEL} = `.notice:not(.crash-recovery)`：**仍按 `.notice` 默认开放**
 * （未来任何新 `.notice` 照旧算装配中，宁红勿漏），只把这**一条已知合法横幅**放行。
 * 「内核装配中…」那条本身是 `className="notice welcome-notice" role="status"`（无修饰类），
 * 不带 `crash-recovery` ⇒ 本选择段**不可能**把它一并放过（`tools/tests/` 的源形状守卫钉住）。
 *
 * `KOJO_SMOKE_ISOLATE_APPDATA=1`（可选）：仍保留——用 `<identifier>.smoke` 这份独立身份起壳，
 * appDataDir 随之独立（干净首启面的读数，且与任何人的快照彻底解耦）。机制见 `devTarget` 的
 * `isolateAppData`；它**不再是**绕开崩溃横幅的必需品（判据已按上面收窄）。代价：`TAURI_CONFIG`
 * 变了会触发 cargo 重编 app crate。
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
 *       KOJO_SMOKE_VITE_PORT=1432 node tools/smoke-tauri-dom.mjs 110   （换 vite 端口，CDP 仍是 9222）
 *       KOJO_SMOKE_ISOLATE_APPDATA=1 …                                   （独立 appDataDir，干净首启面；可选）
 *       KOJO_BOOT_SETTLE_MS=12000 …                                      （放宽「可点后」观察窗；默认 4000=release 口径。
 *                                                                        dev 形态 vite 不打包，空闲预取排到窗后 ⇒ 判红是量测窗，
 *                                                                        不是产品回归；出货判据请用 release exe 走 boot-marks）
 * 退出码：0 = 通过；1 = 失败；2 = 前置不满足（端口被占 / 配置自相矛盾 / 断言①底色真源读不到）。
 * 注意：会短暂弹出应用窗口（结束后自动关闭）。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import { assertPageOrigin, devTarget } from './smoke-lib.mjs';
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
/**
 * 「内核装配中…」（=DOM 还没挂好）的**结构判据**：屏上任一 `.notice` 且不是崩溃恢复横幅。
 *
 * 为什么不是裸 `.notice`：崩溃恢复横幅 `.notice.crash-recovery` 是**合法欢迎页内容**
 * （%APPDATA% 里有未保存快照就渲染），把它算成"装配中"会让一个渲染正常的 app 整轮判红
 * （2026-10-21 实测，用户快照在场时必红）。
 * 为什么不是 `:not(.crash-recovery):not(.warn):not(.error)`：那会把「浏览器环境」/「打开失败」
 * 这两条 `.notice` 也放过 ⇒ 判据对未知/出错态从"宁红勿漏"变成"宁绿勿漏"。**只放行这一条已知合法横幅**。
 * 「内核装配中…」那条是 `className="notice welcome-notice" role="status"`（无修饰类）⇒ 本选择段
 * 匹配得到它，收窄不会连它一起放过（`tools/tests/welcome-crash-notice-selector.test.ts` 钉住）。
 * **仍只认结构，不匹配任何界面文案**（本判据一个字面文案都没沾）。
 */
const MOUNTING_NOTICE_SEL = '.notice:not(.crash-recovery)';

/** 断言②的 Network 域取证轮（Page.reload 重跑一轮开机）最多等多久 */
const NETWORK_WAIT_MS = Number(process.env.KOJO_BOOT_NETWORK_WAIT_MS ?? 90000);
/**
 * 「可点之后」再等多久才切 Network 读数（反空匹配自证的那扇窗）。默认 4000 与 release 实测同量级
 * （可点后预取 1–2 条到账）；**dev 形态必须放大**——vite 不打包，ProjectView 那张模块图要在空闲里
 * 排队，本机 2026-10-22 实测首个 monaco 请求落在导航后 25–30s，4s 窗必然读成「整轮零 monaco」而判红
 * （同一棵树 `tauri build --no-bundle` 出的 release exe 经 boot-marks 复测断言②为真绿）。
 * 只加宽观察窗，不改判据：可点前含 monaco 依旧红、可点后一条 monaco 都见不到依旧判「匹配面可疑」。
 */
const SETTLE_MS = Number(process.env.KOJO_BOOT_SETTLE_MS ?? 4000);
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
 *
 * 端口取自 `devTarget`（与 IPC / market 冒烟同一份机制）：`KOJO_SMOKE_VITE_PORT` 可换，
 * 这样别的树占着 1420 时本工具也能跑；**被占时仍旧 exit 2 退避**，不抢清端口——
 * 占 1420 的可能是别人正在看的会话（PITFALLS 142，先按 PID 认属主再谈清不清）。
 */
let dev;
try {
  dev = devTarget(ROOT, { isolateAppData: process.env.KOJO_SMOKE_ISOLATE_APPDATA === '1' });
} catch (e) {
  console.log(`[smoke] dev 地址解析失败：${String(e && e.message ? e.message : e)}`);
  process.exit(2);
}
const CDP_PORT = 9222;

const busy = [];
for (const p of [dev.port, CDP_PORT]) if (await portOpen(p)) busy.push(p);
if (busy.length > 0) {
  console.log(
    `[smoke] 端口已被占用：${busy.join(' / ')} —— 先按 PID 认属主再清（netstat -ano | findstr 端口），` +
      '别杀别人的 dev server。\n' +
      `        或者换端口绕开：KOJO_SMOKE_VITE_PORT=<空闲端口> 再跑（CDP 固定 ${CDP_PORT}）。`,
  );
  dev.cleanup();
  process.exit(2);
}

/**
 * 收尸要按**端口持有者**收，不能只杀 `child.pid` 那一棵树：
 * WebView2 与 vite 都会挂到树外（实测本工具跑完留下 `msedgewebview2` 占 9222、
 * `node` 占 `[::1]:1420`），下一轮就撞上"端口被占用"或更糟——一个假的 "DOM 未挂载"（§5.117）。
 * 这两个端口是我们的专用调试口：起壳前的前置检查已经确认它们是空的（而且只收**本次实际用的**
 * vite 端口 + 9222，绝不会去碰别人的 1420）。
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
 * 抛在采样循环里会被当成「boot 采样重试」，抛在后面又会把已起的壳和 vite/CDP 端口留成孤儿。
 * 这一趟只读三个小文件，比白烧一轮 ~100s 桌面预算便宜得多（前置条件由工具自己把关，同上面的端口检查）。
 */
try {
  for (const t of ['dark', 'light', 'mint-dark']) expectedBootBg(t);
} catch (e) {
  console.log(`[smoke] 断言①底色真源塌了：${String(e && e.message ? e.message : e)}`);
  dev.cleanup();
  process.exit(2);
}

const devNotes = [
  process.env.KOJO_SMOKE_VITE_PORT ? '端口来自 KOJO_SMOKE_VITE_PORT' : '',
  process.env.KOJO_SMOKE_ISOLATE_APPDATA === '1' ? 'appDataDir 隔离（.smoke 身份）' : '',
].filter(Boolean).join('，');
console.log(
  `[smoke] launching tauri dev (Vite ${dev.port}, CDP ${CDP_PORT}${devNotes ? '；' + devNotes : ''}) …`,
);
const devCmd = ['pnpm --filter @kojo/app tauri dev', ...dev.tauriArgs.map((a) => `"${a}"`)].join(' ');
const child = spawn(devCmd, {
  shell: true,
  cwd: ROOT,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
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
  /** 崩溃恢复横幅是否在场（**不参与判绿**；只让"屏上是什么"在读数里说得清） */
  crashBanner: false,
  rootChildren: 0,
  // 页面 origin 必须落在本次 dev 地址上（dev.origin）：端口被别的树占着时 localhost 可能把壳带偏，
  // 那种绿不算数——与 IPC / market 冒烟同一道假绿闸（smoke-lib.assertPageOrigin）。
  originChecked: false,
  originOk: null,
  pageHref: '',
  originReason: '',
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
  if (!checks.viteUp && (await portOpen(dev.port))) {
    checks.viteUp = true;
    console.log(`[smoke] vite ${dev.port} ✓`);
  }
  if (!checks.hostLaunched && /Running `target\\debug\\kojo-editor/.test(stripAnsi(output))) {
    checks.hostLaunched = true;
    console.log('[smoke] host binary launched ✓');
  }
  if (checks.hostLaunched && !checks.cdpUp && (await portOpen(CDP_PORT))) {
    checks.cdpUp = true;
    console.log(`[smoke] CDP ${CDP_PORT} ✓`);
  }
  if (checks.cdpUp && !checks.domRendered) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const raw = await cdpEval(
          page.webSocketDebuggerUrl,
          `JSON.stringify({
             welcome: !!document.querySelector('.welcome'),
             card: !!document.querySelector('.welcome-card'),
             mounting: !!document.querySelector(${JSON.stringify(MOUNTING_NOTICE_SEL)}),
             crashBanner: !!document.querySelector('.crash-recovery'),
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
        // 「装配中」的 `.notice` 已按 MOUNTING_NOTICE_SEL 收窄：崩溃恢复横幅（`.crash-recovery`）
        // 是合法内容，不算装配中；其余 `.notice`（含装配中那条）照旧不算过。
        checks.domRendered = dom.welcome === true && dom.card === true && dom.mounting !== true;
        checks.crashBanner = dom.crashBanner === true;
        checks.rootChildren = dom.rootChildren;
        if (/Error|错误|失败/.test(checks.domText)) {
          console.log('[smoke] ⚠ error text on page:', checks.domText.slice(0, 300));
        }
        console.log(
          `[smoke] DOM 结构: welcome=${dom.welcome} card=${dom.card} notice=${dom.mounting}` +
            ` crashBanner=${dom.crashBanner} rootChildren=${dom.rootChildren}（装配中判据 ${MOUNTING_NOTICE_SEL}）`,
        );
        console.log('[smoke] DOM text captured:', JSON.stringify(checks.domText.slice(0, 160)));
      }
    } catch (e) {
      console.log('[smoke] CDP eval retry:', String(e).slice(0, 120));
    }
  }
  // 页面 origin 只认本次 dev 地址（默认档 = 仓库配置的 origin；覆盖档 = 127.0.0.1:<port>）。
  // 只要页面已导航到 http(s) 就钉，**不等结构判据**：结构红了也要知道这屏是从哪个 dev server 来的
  // （"假绿"与"假红"都要同一个地址锚）。判据与 IPC / market 冒烟共用 `smoke-lib.assertPageOrigin`；
  // 采样本身的故障（取页表 / ws 掉线 / 还在 about:blank）只记重试，不冒充"origin 不对"。
  if (checks.cdpUp && !checks.originChecked) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const href = await cdpEval(page.webSocketDebuggerUrl, 'location.href');
        // 非 http(s)（about:blank 之类）不算"采样到位"，重试；只有真站在 dev 地址上才交给共享闸判
        const proto = (() => { try { return new URL(String(href)).protocol; } catch { return ''; } })();
        if (!/^https?:$/.test(proto)) throw new Error(`页面尚未导航到 http(s)：${String(href)}`);
        checks.pageHref = await assertPageOrigin(
          { evalJs: (expression) => cdpEval(page.webSocketDebuggerUrl, expression) },
          dev.origin,
        );
        checks.originOk = true;
        checks.originChecked = true;
        console.log(`[smoke] 页面 origin ✓（${checks.pageHref}）`);
      }
    } catch (e) {
      const message = String(e && e.message ? e.message : e);
      if (message.includes('页面 origin 不是预期的 dev 地址')) {
        checks.originOk = false;
        checks.originChecked = true;
        checks.originReason = message;
        console.log(`[smoke] ❌ ${message}`);
      } else {
        console.log('[smoke] origin 采样重试:', message.slice(0, 120));
      }
    }
  }
  if (checks.domRendered && !checks.bootChecked) {
    // 冷开机这一轮的读数（四标记 + 断言①）。判定在 boot-probe.judgeBoot，本文件不再自写口径。
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
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
  // origin 不匹配 = 页面根本不在本次 dev 地址上，后续读数（结构 / boot）都没有意义：立即收工判红
  if (checks.originChecked && checks.originOk === false) break;
  if (checks.domRendered && checks.bootChecked) break;
}

// —— 断言②的**取证首选口径**：CDP Network 域（口径与理由见文件头 / boot-probe.mjs 头注）——
// 常驻会话里 Network.enable 后 Page.reload 重跑一轮开机，才拿得到「可点前」那段（第一轮的
// 事件在探针连上之前就丢了）。取不到不硬判绿：如实退回上面的时间线读数并标注口径。
if (checks.bootChecked && checks.bootWsUrl) {
  const cap = await captureBootNetwork({
    wsUrl: checks.bootWsUrl,
    waitMs: NETWORK_WAIT_MS,
    settleMs: SETTLE_MS,
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
        `偏差中位 ${Math.round(cap.offset)}ms，离散 ${cap.spread === null ? 'n/a' : Math.round(cap.spread) + 'ms'}` +
        (typeof cap.timeScale === 'number' && cap.timeScale !== 1 ? `，量纲归一 ×${Math.round(cap.timeScale)}` : '') + `）；锚点=${cap.anchor}`,
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
  checks.originOk === true &&
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
// 树外残留（WebView2 / vite）单独收，否则端口留给下一轮。
// **只收本次实际用的 vite 端口 + 9222**（默认档下就是 1420；覆盖档下是 dev.port）——
// 绝不碰别人的 1420（PITFALLS 142：那可能是别人正在看的会话）。
const orphans = killPortOwners([dev.port, CDP_PORT]);
if (orphans.length > 0) console.log('[smoke] 已清掉树外残留进程 pid=' + orphans.join(' / '));
dev.cleanup();

console.log(passed ? '✅ tauri DOM smoke passed' : '❌ tauri DOM smoke failed');
if (!passed) {
  // 不静默：红的时候要说清"缺哪一项、当时屏上是什么"，否则又要人回来问
  console.log(
    '[smoke] 未满足：' +
      [
        !checks.viteUp && `vite ${dev.port} 未监听（IPv4/IPv6 都试过）`,
        !checks.hostLaunched && '未看到 `Running target\\debug\\kojo-editor`',
        !checks.cdpUp && `CDP ${CDP_PORT} 未监听`,
        !checks.domRendered && `DOM 未挂载（要求 .welcome + .welcome-card 且无「${MOUNTING_NOTICE_SEL}」；` +
          `crashBanner=${checks.crashBanner}，rootChildren 见 checks）`,
        !checks.originChecked && checks.cdpUp && '未能校验页面 origin',
        checks.originChecked && checks.originOk === false &&
          `页面 origin 不在本次 dev 地址上（见上方打印行；期望 ${dev.origin}）`,
        !checks.bootChecked && '未采到 L1-0 boot 标记（boot.welcomeInteractive 一直未上报）',
        checks.bootChecked && !checks.a1 && 'L1-0 断言①未过（≤500ms 内底色未落到该 data-theme 档应有的 --bg、也未见 #root 非空，' +
          '或 内联底色 / 挂载后计算底色 != 该档源码的 --bg；档位与三方读数见上方打印行）',
        checks.bootChecked && !checks.a2 && `L1-0 断言②未过（口径=${checks.a2Caliber || '未采'}：可点前出现过 monaco 请求，` +
          `或整轮一条 monaco 都没采到=匹配面可疑；Network 域读数 ${checks.networkMonacoBefore ?? 'n/a'}/${checks.networkMonacoTotal ?? 'n/a'} 条，` +
          `时间线读数见上方）` +
          (checks.networkMonacoTotal === 0 && SETTLE_MS === 4000
            ? '｜ 整轮零 monaco 且用的是默认 4s 窗：dev 形态 vite 不打包，空闲预取（App.tsx 兜底 2.5s + rIC 至多 4s）' +
              '可能排在窗后。先按 `KOJO_BOOT_SETTLE_MS=12000` 复跑定责，并用 release exe 走 `node tools/boot-marks.mjs` ' +
              '取出货口径——别直接改判据。'
            : ''),
        checks.bootChecked && !checks.splashGone && '引导层 #boot-splash 未被移除（应在 React 首次提交后撤罩）',
        exited && '进程提前退出',
      ]
        .filter(Boolean)
        .join(' ｜ '),
  );
}
process.exit(passed ? 0 : 1);
