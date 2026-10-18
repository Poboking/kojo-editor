#!/usr/bin/env node
/**
 * L1-0 引导四标记的 **release 形态**读数（dev 形态看 tools/smoke-tauri-dom.mjs，同口径）。
 *
 * 与 smoke-tauri-dom 的差别只在起壳：不起 `tauri dev`（那会连带 vite），直接跑构建产物
 * （默认 packages/app/src-tauri/target/release/kojo-editor.exe，即 `tauri build --no-bundle`
 * 的输出），经 CDP 9222 采 __kojoPerf 的 boot.* 四标记 + 两条硬断言。
 * **本工具不改任何 app 代码**：exe 已在位就直接取数，不在位就 exit 2 报前置不满足
 * （C 盘紧张时不许顺手 cargo release 编译——那是别的批次的预算）。
 *
 * 断言口径**单一真源在 `tools/boot-probe.mjs`**（页内采样 / 底色真源对撞 / Network 域取证 / 判定），
 * 两个工具共用；原先这里抄了一份 collectBoot，靠注释「改一处必须改两处」维系，已收敛。
 * 摘要（逐字口径见 boot-probe.mjs 头注）：
 * ① ≤500ms 内 `#root` 非空 **或** body 计算底色已落到**该 `data-theme` 档源码里的 `--bg`**
 *    （三档真源由 `expectedBootBg(档)` 现读：dark = `styles.css` 基础 `:root`，light / mint-dark =
 *    `themes/<档>.css`），外加「内联底色 == 该档 `--bg` == 挂载后计算底色」与「#boot-splash 已撤」两枚钉；
 *    **判据不要求深色**——浅色档 `#f6f8fa` 是用户设置，旧「亮度 < 96」硬编码必然假红；
 * ② 欢迎页可点（boot.welcomeInteractive）前不得有 monaco 请求——**取证优先 CDP Network 域**
 *    （Network.enable + Page.reload 重跑一轮开机，只认本轮 loaderId 的事件、以本轮 Document
 *    请求为锚点切分；release 形态资源条目本就少，时间线口径通常够用，但两条口径的数都要打出来
 *    对看），取不到才退回页内资源时间线并**如实标注口径**；
 *    另含两条反假绿自证：可点前切出 0 条 = 归属/锚点不可信（不许恒真判绿）；整轮零 monaco
 *    （idle 预取必然拉到 ProjectView chunk）= 匹配面可疑。
 *
 * 用法：node tools/boot-marks.mjs [--exe <路径>] [--timeout <秒，默认 90>] [--network-wait <秒，默认 60>]
 *      [--no-network] （跳过 Network 域取证轮，只取冷开机读数）
 * 退出码：0 = 读数完成且断言全过；1 = 断言红 / 采样超时；2 = 前置不满足（9222 被占、exe 缺失、底色真源读不到）。
 * 注意：会短暂弹应用窗口（结束自动关）。WEBVIEW2_USER_DATA_FOLDER 默认隔离到临时目录
 * （同机可能有另一个同 identifier 实例在跑，不隔离会 0x8007139F 建 WebView2 失败），用完删。
 * 收尸只按本工具 spawn 的进程树 + 本工具占的 9222 端口持有者收，**严禁按名杀 kojo-editor.exe**。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectBoot, judgeBoot, expectedBootBg, bootMarkLines, captureBootNetwork, resolveA2, CdpSession } from './boot-probe.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const EXE = argOf('--exe') ?? path.join(ROOT, 'packages/app/src-tauri/target/release/kojo-editor.exe');
const TIMEOUT_S = Number(argOf('--timeout') ?? 90);
const NETWORK_WAIT_MS = Number(argOf('--network-wait') ?? 60) * 1000;
const SKIP_NETWORK = argv.includes('--no-network');
const CDP_PORT = 9222;

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
const portOpen = async (port) => (await portOpenOn('127.0.0.1', port)) || (await portOpenOn('::1', port));

/** 取页面 target 的 WS 地址（release 形态只一个窗口，直接找 type=page） */
async function pageWsUrl() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    return page ? page.webSocketDebuggerUrl : null;
  } catch {
    return null;
  }
}

/** 采一次页内 boot 读数（一次性会话；常驻那条留给 Network 域取证） */
async function sampleBoot(wsUrl) {
  const cdp = new CdpSession(wsUrl);
  try {
    await cdp.open;
    const raw = await cdp.evalText(`(${collectBoot.toString()})()`);
    return JSON.parse(String(raw ?? 'null'));
  } finally {
    cdp.close();
  }
}

/** 收尸按端口持有者收（WebView2 会挂到树外；形态照 smoke-tauri-dom.mjs） */
function killPortOwners(ports) {
  const ns = spawnSync('netstat -ano', { shell: true, encoding: 'utf8' }).stdout ?? '';
  const pids = new Set();
  for (const line of ns.split('\n')) {
    if (!/LISTENING/i.test(line)) continue;
    if (!ports.some((p) => new RegExp(`[:.]${p}\\s`).test(line))) continue;
    const pid = line.trim().split(/\s+/).pop();
    if (pid && /^\d+$/.test(pid) && Number(pid) !== process.pid) pids.add(pid);
  }
  for (const pid of pids) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  return [...pids];
}

if (await portOpen(CDP_PORT)) {
  console.log(`[boot-marks] CDP ${CDP_PORT} 已被占用——多半是别的 agent 的实例在跑，先让路再跑（本工具不杀别人）。`);
  process.exit(2);
}
if (!fs.existsSync(EXE)) {
  console.log(
    `[boot-marks] exe 不存在：${EXE}\n` +
      '            release 读数缺——按预算**不在本机重新编译**（C 盘紧张），只出 dev 形态一组；' +
      '需要 release 数请在有构建预算的机器上跑 `pnpm --filter @kojo/app tauri build --no-bundle` 后重跑本工具。',
  );
  process.exit(2);
}
// 断言①的底色真源也在起壳前过一遍（三档各现读一次）：塌了要在这里响——抛进下面的采样循环
// 只会被那个静默 catch 当成「页面/WS 未就绪」，一直转到超时才报个假诊断。
try {
  for (const t of ['dark', 'light', 'mint-dark']) expectedBootBg(t);
} catch (e) {
  console.log(`[boot-marks] 断言①底色真源塌了：${String(e && e.message ? e.message : e)}`);
  process.exit(2);
}
const exeStat = fs.statSync(EXE);
console.log(`[boot-marks] 被测产物：${EXE}\n[boot-marks] 构建时间=${exeStat.mtime.toISOString()} 大小=${exeStat.size} B`);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kojo-boot-marks-'));
console.log(`[boot-marks] launch（CDP ${CDP_PORT}，user-data 隔离到 ${userData}）…`);
const child = spawn(EXE, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: userData,
  },
  stdio: 'ignore',
});
let exited = false;
child.on('exit', (code) => {
  exited = true;
  console.log(`[boot-marks] 被测进程退出 code=${code}`);
});

const result = { a1: false, a2: false, a2Caliber: '', splashGone: false, boot: null, netTotal: null };
const started = Date.now();
let coldWsUrl = '';
while (Date.now() - started < TIMEOUT_S * 1000 && !exited && result.boot === null) {
  await sleep(500);
  const wsUrl = await pageWsUrl();
  if (!wsUrl) continue;
  try {
    const b = await sampleBoot(wsUrl);
    if (b && typeof b.welcome === 'number') {
      // 断言①的第三方真源：按页内这一档的源码 --bg 判底色（不要求深色）
      const j = judgeBoot(b, expectedBootBg(b.dataTheme));
      result.boot = b;
      coldWsUrl = wsUrl;
      result.a1 = j.a1;
      result.splashGone = j.splashGone;
      // 断言②先按时间线回退口径记着，Network 域取证在下面覆盖它
      result.a2 = j.a2Timeline;
      result.a2Caliber = SKIP_NETWORK ? '页内资源时间线（--no-network，未做 Network 域取证）' : '页内资源时间线（回退口径，Network 域未取到）';
      console.log(
        `[boot-marks] 断言①=${j.a1}（档位=${j.theme} 该档源码 --bg=${j.expectedBg} htmlParsed=${j.htmlParsed?.toFixed(1)} ` +
          `内联bg=${j.bgAtParse} 挂载后bg=${j.bgNow} t500.root=${j.t500Root ?? 'n/a'}；` +
          `earlyBgOk=${j.earlyBgOk} earlyRoot=${j.earlyRoot} 三方底色钉=${j.pinOk}）引导层已撤=${j.splashGone}`,
      );
      console.log(
        `[boot-marks] 断言②时间线口径读数：资源 ${b.resourceCount} 条（可点前 ${b.beforeCount} 条，` +
          `monaco ${b.monacoBeforeCount} 条），整轮 monaco ${b.monacoTotalCount} 条`,
      );
    }
  } catch {
    /* 页面/WS 未就绪，继续等 */
  }
}

if (result.boot && !SKIP_NETWORK && coldWsUrl) {
  const cap = await captureBootNetwork({
    wsUrl: coldWsUrl,
    waitMs: NETWORK_WAIT_MS,
    log: (s) => console.log(`[boot-marks] ${s}`),
  });
  if (!cap.ok) {
    console.log(`[boot-marks] Network 域取证未成功：${cap.reason}——断言②仍按时间线口径判（已在上方标注）`);
  } else {
    const a2 = resolveA2(cap, cap.page, judgeBoot(cap.page, expectedBootBg(cap.page.dataTheme)));
    result.a2 = a2.ok;
    result.a2Caliber = a2.used;
    result.netTotal = cap.total;
    console.log(
      `[boot-marks] Network 域取证：本轮 ${cap.total} 条（可点前 ${cap.beforeCount} 条，monaco ${cap.monacoBeforeCount} 条` +
        `${cap.monacoBeforeCount > 0 ? '：' + cap.monacoBefore.join(' | ') : ''}）；` +
        `整轮 monaco ${cap.monacoTotalCount} 条；时基=${cap.basis}（与页内时间线交集 ${cap.overlap} 条：原值 ${cap.exactCount} / 拟合 ${cap.fittedCount}，` +
        `偏差中位 ${Math.round(cap.offset)}ms，离散 ${cap.spread === null ? 'n/a' : Math.round(cap.spread) + 'ms'}` +
        (typeof cap.timeScale === 'number' && cap.timeScale !== 1 ? `，量纲归一 ×${Math.round(cap.timeScale)}` : '') + `）；锚点=${cap.anchor}`,
    );
    console.log(
      `[boot-marks] 断言②=${a2.ok}（口径=${a2.used}）—— ${a2.reason}；对照：时间线 ${cap.page.resourceCount} 条 vs Network 本轮 ${cap.total} 条`,
    );
    const kb = (n) => (typeof n === 'number' ? `${(n / 1024).toFixed(1)}KB` : 'n/a');
    console.log(
      `[boot-marks] CSS 字节（Network 域 loadingFinished 对照）：可点前 ${kb(cap.cssBeforeBytes)} / 整轮 ${kb(cap.cssTotalBytes)}` +
        `（${cap.cssCount} 条 .css，可点前 ${cap.cssBeforeCount} 条）${cap.cssSample ? '：' + cap.cssSample.join(' | ') : ''}`,
    );
    console.log('[boot-marks] 二轮开机（Page.reload 那一轮）四标记：');
    for (const line of bootMarkLines(cap.page)) console.log('  ·' + line.slice(1));
  }
}

if (result.boot) {
  console.log('[boot-marks] boot 四标记（自导航起点 ms，冷开机轮）：');
  for (const line of bootMarkLines(result.boot)) console.log(line);
} else {
  console.log(`[boot-marks] 采样超时（${TIMEOUT_S}s）或进程提前退出（exited=${exited}）——未拿到 boot.welcomeInteractive`);
}

if (!exited && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
const orphans = killPortOwners([CDP_PORT]);
if (orphans.length > 0) console.log('[boot-marks] 已清掉树外残留 pid=' + orphans.join(' / '));
for (let i = 0; i < 5; i++) {
  try {
    fs.rmSync(userData, { recursive: true, force: true });
    break;
  } catch {
    await sleep(400);
  }
}

const pass = result.boot !== null && result.a1 && result.a2 && result.splashGone;
if (!pass) {
  console.log(
    '[boot-marks] 未满足：' +
      [
        result.boot === null && '未采到 boot.welcomeInteractive（超时或进程退出）',
        result.boot !== null && !result.a1 && '断言①未过（≤500ms 内底色未落到该 data-theme 档应有的 --bg、也未见 #root 非空，' +
          '或 内联底色 / 挂载后计算底色 != 该档源码的 --bg；档位与三方读数见上方打印行）',
        result.boot !== null && !result.a2 && `断言②未过（口径=${result.a2Caliber}：可点前出现过 monaco，或整轮零 monaco=匹配面可疑）`,
        result.boot !== null && !result.splashGone && '引导层 #boot-splash 未被移除',
      ]
        .filter(Boolean)
        .join(' ｜ '),
  );
}
console.log(pass ? '✅ boot-marks passed' : '❌ boot-marks failed');
process.exit(pass ? 0 : 1);
