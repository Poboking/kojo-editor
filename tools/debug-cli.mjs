#!/usr/bin/env node
/**
 * 调试模式 CLI（2026-10-24 调试模式批）：**完全命令行操作**编辑器的入口。
 *
 * 一句话：`node tools/debug-cli.mjs serve` 把「调试宿 + vite + 浏览器（CDP）」整套拉起来，
 * 之后一切编辑器能力都可以从命令行驱动（打开项目 / 开文件 / 跑命令面板 / 事件旁听 /
 * DOM 快照 / 截图）。配合 agent 内置的浏览器打开同一 URL，人与 agent 看的是同一屏。
 *
 * 会话文件：`<repo>/.kojo-debug/session.json`（端口 / pid / URL）。子命令都从它找会话；
 * `KOJO_DEBUG_SESSION` 可指向别处的会话文件（多会话并行）。
 *
 * 子命令：
 *   serve [--sandbox DIR] [--readonly DIR]... [--vite-port N] [--port N] [--cdp-port N]
 *         [--browser <exe>] [--headless] [--no-browser] [--record] [--fresh]
 *         # 拉起整套（调试宿 + vite + 浏览器）；前台驻留，Ctrl+C 全收
 *   shell [--cdp-port N] [--isolate] [--no-debug-api] [--record]
 *         # 起一台**真桌面壳**（tauri dev）带 CDP——无边框/启动相位/窗口几何这类
 *         # 壳专属改动 Web 调试宿复现不了，用这个验；页面注入 ?kojo-debug=api
 *         # 调试面（invoke 走真 Tauri IPC）。--isolate 换 .smoke 身份（多壳并发），
 *         # --no-debug-api 保持 pristine boot（验启动相位本身）
 *   status                     # 三件套健康 + 页面相位
 *   stop                       # 收掉整套（按 pid 收，端口兜底）
 *   url                        # 编辑器 URL（浏览器 / agent 直接开这个）
 *   eval "<js 表达式>"         # 页内求值（可 await；自动 JSON 序列化）
 *   state                      # __kojoDebug.state() 一屏读数
 *   commands [过滤串]          # 命令面板注册表（所有功能的可编程入口）
 *   run <命令id>               # 跑一条命令面板命令
 *   open-project <目录> [--writable] [--no-open-first]
 *         # web 模式＝调试宿 POST /policy；真壳（shell）＝调试面 dialogPolicy 应答 fetch 腿（只读，
 *         # 不进 Rust 写域准入门 ⇒ --writable 如实拒）。两模式都在最后硬对拍 rootDir===请求目录（假绿拦截）
 *   open-file <路径片段>       # 点文件树真实打开一个文件（等 Monaco 挂载）
 *   click <选择器>             # CDP 真实点击（元素中心 + elementFromPoint 自证）
 *   type [<选择器>] <文本>     # 选择器可省＝打到当前焦点元素（命令面板/搜索框先点开再 type）
 *   key <键> [ctrl|alt|shift]  # 真实键事件（enter/escape/tab/arrowdown/…，可带修饰键）
 *   screenshot <out.png> [--full]   # 整页截图（agent 可直接看 PNG）
 *   perf <start|stop|quick [ms]>    # UI 卡顿体检（探针四路；跨命令存活）
 *   profile <run [ms]>              # CPU 采样归因（函数级热点 selfTime Top25；KOJO_PROFILE_OUT 落 .cpuprofile）
 *   dom                        # DOM 结构快照（相位/标签/面板/通知/状态栏）
 *   events [n]                 # 内核事件旁听（最近 n 条，默认 40）
 *   invoke <命令> [JSON参数]   # 直达宿主命令（调试宿或桌面壳 IPC 同一入口）
 *
 * 退出码：0 成功；1 失败；2 前置不满足（无会话 / 浏览器找不到 / 端口被占）。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  Cdp,
  cdpClick,
  cdpPage,
  debugHome,
  dismissDevNoteMask,
  expandTreeUntilFile,
  findBrowser,
  freePort,
  killProcessesMarked,
  portOpen,
  sessionDir,
  sessionKey,
  sleep,
  waitFor,
} from './debug-lib.mjs';
import { devTarget } from './smoke-lib.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const DEBUG_DIR = debugHome();
// 多 agent 并发隔离（2026-10-25，PITFALLS 192）：会话目录按仓库工作树自动分房——
// 本树的 serve/status/stop 只看得见本树那一间，跨树互不可见、互不可杀。
const SESS_DIR = sessionDir(REPO);
const SESSION_FILE = process.env.KOJO_DEBUG_SESSION ?? path.join(SESS_DIR, 'session.json');
const die = (msg, code = 1) => {
  console.error(String(msg));
  process.exit(code);
};

/* ------------------------------ 小工具 ------------------------------ */

async function readSession() {
  let raw;
  try {
    raw = await fsp.readFile(SESSION_FILE, 'utf-8');
  } catch {
    die(
      `本工作树没有在跑的调试会话（${SESSION_FILE} 不存在；多 agent 并发下会话按工作树隔离，` +
        `看到的只有自己这棵树）。先起一套：\n  node tools/debug-cli.mjs serve` +
        `\n（要接管别的会话：KOJO_DEBUG_SESSION=<那个 session.json> 或 KOJO_DEBUG_SESSION_NAME=<名>）`,
      2,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    die(
      `会话文件损坏（JSON 解析失败：${err?.message ?? err}）：${SESSION_FILE}\n` +
        `多半是 serve 与 stop 写入相撞——先 node tools/debug-cli.mjs stop 清掉再重开 serve`,
      2,
    );
  }
}

async function cdpForSession(session, { mustHavePage = true } = {}) {
  let page = null;
  try {
    page = await cdpPage(session.cdpPort, session.vitePort);
  } catch {
    page = null;
  }
  if (!page) {
    if (!mustHavePage) return null;
    die(
      `CDP :${session.cdpPort} 上没有本会话的页面（vite :${session.vitePort}）——` +
        `可能是旧会话的僵尸浏览器占着 CDP 端口（serve 只验了端口没验页面归属，2026-10-25 已收紧）。` +
        `处置：node tools/debug-cli.mjs stop 后重开 serve；还不行就杀残留（PowerShell 按 CommandLine 含 kojo-debug 认领）`,
      2,
    );
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  return cdp;
}

/* ------------------------------ serve ------------------------------ */

async function cmdServe(args) {
  fs.mkdirSync(SESS_DIR, { recursive: true });
  // 会话房间互斥：web / shell 同树同一时刻只挂一套（真壳与调试宿会抢 vite/端口语义）
  try {
    const prev = JSON.parse(await fsp.readFile(SESSION_FILE, 'utf-8'));
    die(
      `本工作树已有会话在跑（mode=${prev.mode ?? 'web'}，起于 ${prev.createdAt}）——先 node tools/debug-cli.mjs stop`,
      2,
    );
  } catch (err) {
    if (err?.code !== 'ENOENT') die(`读旧会话失败：${err?.message ?? err}`, 2);
  }
  const session = {
    createdAt: new Date().toISOString(),
    sessionId: sessionKey(REPO),
    repoRoot: REPO,
    sandbox: path.resolve(args.sandbox ?? path.join(SESS_DIR, 'sandbox')),
    appdata: path.join(SESS_DIR, 'appdata'),
    readonly: args.readonly.map((p) => path.resolve(p)),
  };
  if (args.fresh) {
    await fsp.rm(session.sandbox, { recursive: true, force: true });
    await fsp.rm(session.appdata, { recursive: true, force: true });
  }

  const vitePort = args.vitePort ?? Number(process.env.KOJO_DEBUG_VITE_PORT ?? 0) ?? 0;
  session.vitePort = vitePort > 0 ? vitePort : await freePort(4173);
  session.serverPort = args.port ?? await freePort(17777);
  session.cdpPort = args.cdpPort ?? await freePort(9333);

  for (const [name, port] of [['vite', session.vitePort], ['调试宿', session.serverPort], ['CDP', session.cdpPort]]) {
    if (await portOpen(port)) die(`端口 ${port}（${name}）已被占用——换 --vite-port/--port/--cdp-port，或先 node tools/debug-cli.mjs stop`, 2);
  }

  const children = []; // { name: 'host'|'vite'|'browser', proc }
  let shuttingDown = false;
  /** 反哺修（2026-10-25）：子进程退出要**可见**——重检索把宿 OOM 挂掉（实测 exit 13）时，
   *  会话不能只剩一句「CDP 不在」。退出码当场打到 serve 输出，并进 session.exits 供 status 读。 */
  const sessionExits = [];
  const persistSession = async () => {
    await fsp.writeFile(SESSION_FILE, JSON.stringify(session, null, 2), 'utf-8');
  };
  const watchChild = (name, proc) => {
    proc.on('exit', (code, signal) => {
      if (shuttingDown) return; // 正常收尾不记
      const rec = { name, pid: proc.pid, code, signal: signal ?? null, at: new Date().toISOString() };
      sessionExits.push(rec);
      (session.exits ??= []).push(rec);
      console.warn(
        `[cli] [warn] ${name} 进程退出（pid=${proc.pid} code=${code} signal=${signal ?? '-'} at=${rec.at}）——status 可见；` +
          `需要浏览器就重开 serve（或换 --headless/--browser 排查）`,
      );
      void persistSession().catch(() => {});
    });
    return proc;
  };
  const cleanup = async () => {
    shuttingDown = true;
    for (const { proc } of children) {
      try {
        if (process.platform === 'win32') spawnSync(`taskkill /PID ${proc.pid} /T /F`, { shell: true, stdio: 'ignore' });
        else proc.kill('SIGTERM');
      } catch {}
    }
    try { await fsp.rm(SESSION_FILE, { force: true }); } catch {}
  };
  process.on('SIGINT', () => { console.log('\n[cli] 收会话…'); void cleanup().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void cleanup().then(() => process.exit(0)); });

  // 1) 调试宿（--max-old-space-size：全项目重检索的解码峰值实测能把默认堆顶穿——OOM 退出
  //    是「挂」的主嫌疑，直接给大堆；再挂也会经 watchChild 落进 status 读数）
  const serverArgs = ['--max-old-space-size=4096', 'tools/debug-server.mjs', '--port', String(session.serverPort), '--sandbox', session.sandbox, '--appdata', session.appdata];
  for (const r of session.readonly) serverArgs.push('--readonly', r);
  children.push({ name: 'host', proc: watchChild('host', spawn(process.execPath, serverArgs, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })) });
  session.serverPid = children[0].proc.pid;
  children[0].proc.stdout.on('data', (d) => process.stdout.write(`[host] ${d}`));
  children[0].proc.stderr.on('data', (d) => process.stderr.write(`[host!] ${d}`));

  // 2) vite（编辑器页面；--port 覆盖配置里的 1420，strictPort 只对自己的端口严格）
  //    --host 127.0.0.1：CLI / 会话文件里的编辑器 URL 一律写 127.0.0.1（见下 session.url），
  //    而 vite 缺省绑 localhost——Windows 上 localhost 常只解析到 ::1，浏览器会 ERR_CONNECTION_REFUSED。
  const viteBin = path.join(REPO, 'packages', 'app', 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteBin)) die(`vite 不在位（${viteBin}）——先 pnpm install`, 2);
  const viteProc = spawn(
    process.execPath,
    [viteBin, '--port', String(session.vitePort), '--strictPort', '--host', '127.0.0.1'],
    {
      windowsHide: true,
      cwd: path.join(REPO, 'packages', 'app'),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push({ name: 'vite', proc: watchChild('vite', viteProc) });
  session.vitePid = viteProc.pid;
  let viteLog = '';
  // 封顶（自审 2026-10-25）：vite 长会话的日志原本无界累积——保住报错所需的尾巴即可
  const appendViteLog = (tag, d) => {
    viteLog += d.toString();
    if (viteLog.length > 65536) viteLog = viteLog.slice(-32768);
    process.stdout.write(`${tag} ${d}`);
  };
  viteProc.stdout.on('data', (d) => appendViteLog('[vite]', d));
  viteProc.stderr.on('data', (d) => appendViteLog('[vite!]', d));

  console.log(`[cli] 起调试宿 :${session.serverPort} 与 vite :${session.vitePort} …`);
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    // 快败（自审 2026-10-25）：起动窗内孩子就退出（端口被抢 / 依赖缺失）时，60s 干等
    // 是假诊断——watchChild 已记退出码，当场带着读数收工
    if (sessionExits.length > 0) {
      const ex = sessionExits[0];
      die(
        `起动窗内 ${ex.name} 进程退出（code=${ex.code} signal=${ex.signal ?? '-'}）——` +
          `多半是端口被占或依赖缺失；日志尾：\n${viteLog.slice(-800)}`,
        1,
      );
    }
    if (!(await portOpen(session.serverPort)) || !(await portOpen(session.vitePort))) {
      await sleep(500);
      continue;
    }
    break;
  }
  if (!(await portOpen(session.serverPort))) die('调试宿 60s 内没就绪', 1);
  if (!(await portOpen(session.vitePort))) die(`vite 60s 内没就绪；日志尾：\n${viteLog.slice(-800)}`, 1);

  session.url = `http://127.0.0.1:${session.vitePort}/?kojo-debug=${session.serverPort}`;
  await fsp.writeFile(SESSION_FILE, JSON.stringify(session, null, 2), 'utf-8');

  // 3) 浏览器（可选）
  if (!args.noBrowser) {
    const exe = findBrowser(args.browser);
    if (!exe) {
      console.warn('[cli] [warn] 没找到 Chrome/Edge——跳过浏览器（页面 URL 仍可用，agent 内置浏览器直接开）');
      session.browserPid = null;
    } else {
      // profile 每会话独立（实测坑 2026-10-25：共用一个目录时，被锁/清残损坏的旧 profile
      // 会让 Edge 当场退出 code=21）；陈旧 profile 尽力清，清不掉不拦路（killProcessesMarked 已先收进程）
      const profile = path.join(SESS_DIR, `browser-profile-${process.pid}`);
      fs.mkdirSync(profile, { recursive: true });
      try {
        for (const name of await fsp.readdir(SESS_DIR)) {
          if (name.startsWith('browser-profile-') && name !== path.basename(profile)) {
            await fsp.rm(path.join(SESS_DIR, name), { recursive: true, force: true, maxRetries: 1 }).catch(() => {});
          }
        }
      } catch {}
      const browser = spawn(
        exe,
        [
          `--remote-debugging-port=${session.cdpPort}`,
          `--user-data-dir=${profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--window-size=1600,900',
          ...(args.headless ? ['--headless=new'] : []),
          session.url,
        ],
        { stdio: 'ignore', detached: false },
      );
      children.push({ name: 'browser', proc: watchChild('browser', browser) });
      session.browserPid = browser.pid;
      const t1 = Date.now();
      // 就绪判据＝CDP 上出现**本 vite 端口**的页面（只看端口通会被旧会话的僵尸浏览器骗过，实测）
      let page = null;
      while (Date.now() - t1 < 30000) {
        page = await cdpPage(session.cdpPort, session.vitePort).catch(() => null);
        if (page) break;
        await sleep(400);
      }
      if (page) {
        console.log(`[cli] 浏览器 CDP 就绪 :${session.cdpPort}（${args.headless ? '无头' : '有窗'}）`);
        if (args.record) void recordConsole(session).catch((err) => console.warn(`[cli] console 记录失败：${err?.message ?? err}`));
      } else if (await portOpen(session.cdpPort)) {
        console.warn(`[cli] [warn] :${session.cdpPort} 有 CDP 但没有本会话页面——大概率被旧会话僵尸浏览器占着；先 stop / 清残留再重开`);
      } else {
        console.warn('[cli] [warn] 浏览器起了但 CDP 30s 没就绪（无头标志或策略拦截？）；继续无 CDP 模式');
      }
    }
  }
  await fsp.writeFile(SESSION_FILE, JSON.stringify(session, null, 2), 'utf-8');

  console.log('');
  console.log('[ok] 调试会话就绪：');
  console.log(`   会话       ：${session.sessionId}（按工作树隔离；会话目录 ${SESS_DIR}）`);
  console.log(`   编辑器 URL ：${session.url}   ← 浏览器 / agent 打开这个`);
  console.log(`   调试宿     ：http://127.0.0.1:${session.serverPort}/health`);
  console.log(`   沙盒       ：${session.sandbox}${session.readonly.length ? `（只读根：${session.readonly.join('；')}）` : ''}`);
  console.log('   常用命令   ：status · state · commands · open-project <dir> · open-file <片段> · screenshot <png>');
  console.log('   收工       ：Ctrl+C 或 node tools/debug-cli.mjs stop');
  console.log('');
  await new Promise(() => {}); // 前台驻留（收尾走 SIGINT）
}

/** serve --record：挂一条常驻 CDP 连接，把 console / 异常 / 网络失败落到会话目录 console.log */
async function recordConsole(session) {
  const cdp = await cdpForSession(session);
  const out = fsp.createWriteStream(path.join(SESS_DIR, 'console.log'), { flags: 'a' });
  let dropped = 0;
  const line = (s) => {
    // 背压护栏（自审 2026-10-25）：写不过来时丢行并计数——刷屏会话别把 serve 内存堆爆
    if (out.writableLength > 8 * 1024 * 1024) {
      dropped += 1;
      if (dropped % 1000 === 1) out.write(`[${new Date().toISOString()}] [warn] console 记录背压，已丢 ${dropped} 行\n`);
      return;
    }
    out.write(`[${new Date().toISOString()}] ${s}\n`);
  };
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable').catch(() => {});
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
    line(`console.${p.type} ${text}`);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    line(`exception ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? ''}`);
  });
  cdp.on('Log.entryAdded', (p) => {
    if (['error', 'warning'].includes(p.entry?.level)) line(`log.${p.entry.level} [${p.entry.source}] ${p.entry.text}`);
  });
  line(`=== console 记录开始（页面 ${session.url}）===`);
}

/* ------------------------------ 真桌面壳通道（shell） ------------------------------ */

/**
 * 起一台**真桌面壳**（tauri dev）并带上 CDP（2026-10-25 agent 反哺落点）：
 * 启动页 / 无边框 / 逐相位窗口几何这类**壳专属改动**在 Web 调试宿里复现不了——
 * 无壳的 agent 要验它们，只能起真壳。本命令把「真壳 + CDP + `?kojo-debug=api` 调试面」
 * 接进同一套会话（state/commands/eval/screenshot/events 全部照用，invoke 走真 Tauri IPC）。
 *
 * 与 smoke-tauri-dom 的分工：那是发版判据的一次性冒烟；这是可驻留、可逐步驱动的会话。
 * 壳专属的窗口几何读数以截图 + DOM 为准（CDP 看不到 OS 窗口框本身）。
 */
async function cmdShell(args, flags) {
  fs.mkdirSync(SESS_DIR, { recursive: true });
  // 一个会话房间同一时刻只挂一套：web / shell 互斥，先把旧会话的存亡问清
  try {
    const prev = JSON.parse(await fsp.readFile(SESSION_FILE, 'utf-8'));
    die(
      `本工作树已有会话在跑（mode=${prev.mode ?? 'web'}，起于 ${prev.createdAt}）——` +
        `先 node tools/debug-cli.mjs stop 再起 ${prev.mode === 'shell' ? 'web' : 'shell'}`,
      2,
    );
  } catch (err) {
    if (err?.code !== 'ENOENT') die(`读旧会话失败：${err?.message ?? err}`, 2);
  }

  let dev;
  try {
    dev = devTarget(REPO, { isolateAppData: flags.includes('--isolate') });
  } catch (err) {
    die(`真壳 dev 地址解析失败：${err?.message ?? err}`, 2);
  }
  const cdpPort = args.cdpPort ?? await freePort(9223); // 9222 是 smoke 专用，别撞
  const bootMs = Number(process.env.KOJO_DEBUG_SHELL_BOOT_MS ?? 300000); // 冷 cargo 构建就是要几分钟
  const session = {
    mode: 'shell',
    createdAt: new Date().toISOString(),
    sessionId: sessionKey(REPO),
    repoRoot: REPO,
    cdpPort,
    vitePort: dev.port,
    serverPort: null, // 真壳没有调试宿——invoke 走真 Tauri IPC
    shellPid: null,
    tauriConfigTemp: dev.tauriArgs[1] ?? null,
    readonly: [],
  };
  const debugApiUrl = `${dev.origin}/?kojo-debug=api`;
  session.url = debugApiUrl;

  const exits = [];
  const persist = async () => {
    await fsp.writeFile(SESSION_FILE, JSON.stringify(session, null, 2), 'utf-8');
  };
  const shellCmd = ['pnpm --filter @kojo/app tauri dev', ...dev.tauriArgs.map((a) => `"${a}"`)].join(' ');
  console.log(`[shell] 起真桌面壳：${shellCmd}（CDP :${cdpPort}；冷 cargo 构建首次会久，预算 ${Math.round(bootMs / 1000)}s）`);
  const child = spawn(shellCmd, {
      windowsHide: true,
    shell: true,
    cwd: REPO,
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  session.shellPid = child.pid;
  let shuttingDown = false;
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const rec = { name: 'shell', pid: child.pid, code, signal: signal ?? null, at: new Date().toISOString() };
    exits.push(rec);
    (session.exits ??= []).push(rec);
    console.warn(`[shell] [warn] 真壳进程退出（code=${code} signal=${signal ?? '-'} at=${rec.at}）——status 可见`);
    void persist().catch(() => {});
  });
  child.stdout.on('data', (d) => process.stdout.write(`[shell] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[shell!] ${d}`));

  const cleanup = async () => {
    shuttingDown = true;
    try {
      if (process.platform === 'win32') spawnSync(`taskkill /PID ${child.pid} /T /F`, { shell: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
    } catch {}
    dev.cleanup();
    try { await fsp.rm(SESSION_FILE, { force: true }); } catch {}
  };
  process.on('SIGINT', () => { console.log('\n[shell] 收会话…'); void cleanup().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void cleanup().then(() => process.exit(0)); });

  // 等 CDP 上出现**本 dev 端口**的页面（只看端口通会被别人的壳/浏览器骗过）
  const t0 = Date.now();
  let page = null;
  while (Date.now() - t0 < bootMs) {
    if (exits.length > 0) {
      await cleanup();
      die(`真壳起动窗内退出（code=${exits[0].code}）——端口被占 / cargo 失败 / 同 identifier 并发（0x8007139F 时加 --isolate）`, 1);
    }
    page = await cdpPage(cdpPort, dev.port).catch(() => null);
    if (page) break;
    await sleep(1000);
  }
  if (!page) {
    await cleanup();
    die(`真壳 ${Math.round(bootMs / 1000)}s 内没就绪（CDP :${cdpPort} 上没有 :${dev.port} 的页面）——冷 cargo 构建会久，KOJO_DEBUG_SHELL_BOOT_MS 可放宽`, 1);
  }
  console.log(`[shell] CDP 就绪 :${cdpPort}（页面在 ${dev.origin}）`);

  // 默认把 webview 导航到 ?kojo-debug=api：调试面在场、invoke 仍走真 Tauri IPC。
  // 验「启动相位」本身要 pristine boot 的，加 --no-debug-api（导航会重放开机流程）。
  if (!flags.includes('--no-debug-api')) {
    const cdp = await new Cdp(page.webSocketDebuggerUrl).connect();
    await cdp.send('Page.navigate', { url: debugApiUrl });
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 30000, label: '__kojoDebug（api 形态）' });
    const mode = await cdp.evalJs('__kojoDebug.mode');
    console.log(`[shell] 调试面在场（mode=${mode}，invoke=真 Tauri IPC）`);
    if (args.record) void recordConsole(session).catch((err) => console.warn(`[shell] console 记录失败：${err?.message ?? err}`));
    cdp.close();
  }
  await persist();

  console.log('');
  console.log('[ok] 真壳调试会话就绪：');
  console.log(`   会话       ：${session.sessionId}（mode=shell；会话目录 ${SESS_DIR}）`);
  console.log(`   页面       ：${session.url}（webview 内，浏览器打开无壳行为属正常）`);
  console.log('   下一步     ：state · commands · eval · screenshot（窗口几何以截图+DOM 为准）· open-project <目录>（调试面 policy 应答目录对话框，只读）');
  console.log('   收工       ：Ctrl+C 或 node tools/debug-cli.mjs stop');
  console.log('');
  await new Promise(() => {});
}

/* ------------------------------ 其余子命令 ------------------------------ */

async function cmdStatus() {
  const s = await readSession();
  const isShell = s.mode === 'shell';
  const serverOk = isShell
    ? null // 真壳没有调试宿：invoke 走真 Tauri IPC
    : await fetch(`http://127.0.0.1:${s.serverPort}/health`, {
        signal: AbortSignal.timeout(3000),
      })
        .then((r) => r.ok)
        .catch(() => false);
  const viteOk = await portOpen(s.vitePort);
  let pagePhase = null;
  let cdpOk = false;
  if (await portOpen(s.cdpPort)) {
    try {
      const cdp = await cdpForSession(s);
      cdpOk = true;
      pagePhase = await cdp.evalJs('(window.__kojoDebug ? __kojoDebug.state().phase : document.querySelector(".welcome") ? "welcome(no-debug-api)" : "unknown")');
      cdp.close();
    } catch {}
  }
  // 反哺修（2026-10-25）：崩溃要**有读数**，不是一句「CDP 不在」。逐孩子问存活（kill(pid,0)），
  // 退出记录（serve 的 watchChild 写进 session.exits）原样带退出码与时间。
  const alive = (pid) => {
    if (typeof pid !== 'number' || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const exitOf = (name) => (s.exits ?? []).filter((e) => e.name === name).slice(-1)[0] ?? null;
  const childLine = (name, pid, ok) => {
    if (ok === true) return `[ok] pid=${pid}`;
    const ex = exitOf(name);
    if (ex) return `[FAIL] pid=${ex.pid} 已退出 code=${ex.code} signal=${ex.signal ?? '-'} at=${ex.at}（serve 输出有同期日志）`;
    return ok === false ? `[FAIL] pid=${pid} 不在（无退出记录——serve 进程可能已死，整会话作废重开）` : '—（未起）';
  };
  console.log(
    JSON.stringify(
      {
        会话: `${s.sessionId ?? '?'}（${s.repoRoot ?? '?'}${isShell ? ' · mode=shell 真桌面壳' : ''}）`,
        调试宿: serverOk === null ? '—（mode=shell：真 Tauri IPC，无调试宿）' : serverOk ? `[ok] :${s.serverPort} ${childLine('host', s.serverPid, alive(s.serverPid))}` : `[FAIL] :${s.serverPort} ${childLine('host', s.serverPid, alive(s.serverPid))}`,
        vite: `${viteOk ? '[ok]' : '[FAIL]'} :${s.vitePort}${isShell ? '' : ` ${childLine('vite', s.vitePid, alive(s.vitePid))}`}`,
        浏览器CDP: cdpOk
          ? `[ok] :${s.cdpPort} ${isShell ? childLine('shell', s.shellPid, alive(s.shellPid)) : childLine('browser', s.browserPid, alive(s.browserPid))}`
          : `— ${isShell ? childLine('shell', s.shellPid, alive(s.shellPid)) : childLine('browser', s.browserPid, alive(s.browserPid))}`,
        页面相位: pagePhase,
        退出记录: (s.exits ?? []).slice(-5),
        URL: s.url,
        sandbox: s.sandbox ?? null,
        readonly: s.readonly ?? [],
      },
      null,
      2,
    ),
  );
  process.exit(serverOk === null ? (viteOk ? 0 : 1) : serverOk && viteOk ? 0 : 1);
}

async function cmdStop() {
  const s = await readSession();
  const pids = [s.browserPid, s.vitePid, s.serverPid, s.shellPid].filter((p) => typeof p === 'number' && p > 0);
  // serve 形态里三个孩子都是 serve 的子进程：按端口认属主收（Windows taskkill 树杀）
  if (process.platform === 'win32') {
    const ns = spawnSync('netstat -ano', { shell: true, encoding: 'utf8' }).stdout ?? '';
    const ports = [s.serverPort, s.vitePort, s.cdpPort];
    for (const lineText of ns.split('\n')) {
      if (!/LISTENING/i.test(lineText)) continue;
      if (!ports.some((p) => new RegExp(`[:.]${p}\\s`).test(lineText))) continue;
      const pid = lineText.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid) && !pids.includes(Number(pid))) pids.push(Number(pid));
    }
    for (const pid of pids) spawnSync(`taskkill /PID ${pid} /T /F`, { shell: true, stdio: 'ignore' });
  } else {
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
  }
  // 兜底：Edge 子进程会逃出树杀（实测锁着 profile ⇒ 目录清不掉）。**只按本会话目录认领**
  // （多 agent 并发下按 debugHome 全局杀会把别人的会话一起收掉——PITFALLS 192 的教训）。
  killProcessesMarked(SESS_DIR);
  // 真壳会话的临时 tauri 覆盖配置（devTarget 产物）一并清
  if (s.tauriConfigTemp) {
    try { await fsp.rm(s.tauriConfigTemp, { force: true }); } catch {}
  }
  try { await fsp.rm(SESSION_FILE, { force: true }); } catch {}
  console.log('[clean] 调试会话已收（' + (pids.length ? `pid ${pids.join('/')}` : '无存活 pid') + `；mode=${s.mode ?? 'web'}；会话目录 ` + SESS_DIR + '）');
}

async function withCdp(fn) {
  const s = await readSession();
  if (!(await portOpen(s.cdpPort))) die('浏览器 CDP 不在（serve 没带浏览器，或浏览器已关）——重跑 serve，或用 agent 内置浏览器开 URL 后把调试端口交给 KOJO_DEBUG_CDP_PORT', 2);
  const cdp = await cdpForSession(s);
  try {
    return await fn(s, cdp);
  } finally {
    cdp.close();
  }
}

async function cmdEval(_, expr) {
  if (!expr) die('eval 需要一个表达式：debug-cli.mjs eval "__kojoDebug.state()"', 2);
  await withCdp(async (s, cdp) => {
    // 自动包 async IIFE：顶层 await（如 `await __kojoDebug.invoke(...)`）也能直接写
    const wrapped = /^\s*(?:await\s|async\s)/.test(expr) ? `;(async () => (${expr}))()` : expr;
    const v = await cdp.evalJs(wrapped, 60000);
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  });
}

async function cmdState() {
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 10000, label: '__kojoDebug 装载' });
    console.log(JSON.stringify(await cdp.evalJs('__kojoDebug.state()'), null, 2));
  });
}

async function cmdCommands(_, filter) {
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 10000, label: '__kojoDebug 装载' });
    const list = await cdp.evalJs('__kojoDebug.commands.list()');
    if (list && list.error) die(`命令注册表不可用：${list.error}（项目态命令要在开项目后才有）`, 1);
    const arr = (list ?? []).filter((c) => !filter || `${c.category ?? ''} ${c.title} ${c.id}`.toLowerCase().includes(filter.toLowerCase()));
    for (const c of arr) {
      console.log(`${c.id.padEnd(36)} ${c.keybinding ? `[${c.keybinding}] `.padEnd(16) : ''.padEnd(16)} ${c.category ?? ''}｜${c.title}`);
    }
    console.log(`（${arr.length} 条${filter ? `，过滤「${filter}」` : ''}）`);
  });
}

async function cmdRun(_, id) {
  if (!id) die('run 需要命令 id（先 commands 看清单）', 2);
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 10000, label: '__kojoDebug 装载' });
    await cdp.evalJs(`__kojoDebug.commands.run(${JSON.stringify(id)})`, 30000);
    await sleep(300);
    const phase = await cdp.evalJs('__kojoDebug.state().phase');
    console.log(`[ok] 已执行命令 ${id}（当前相位：${phase}）`);
  });
}

async function cmdOpenProject(args, dir, flags) {
  if (!dir) die('open-project 需要目录参数', 2);
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) die(`目录不存在：${abs}`, 2);
  const samePath = (a, b) =>
    process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : String(a) === String(b);
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 15000, label: '__kojoDebug 装载' });
    // 0) 已开着同一个项目 ⇒ 幂等直过
    const cur = await cdp.evalJs('(__kojoDebug.state().project ?? {}).rootDir ?? null');
    if (cur && samePath(path.resolve(String(cur)), abs)) {
      console.log(`[ok] 项目已开着：${abs}`);
      return;
    }
    // 1) 目录对话框的自动应答——两条腿同一个 policy 口径（2026-10-26 era-pair 批）：
    //    web 模式 = 调试宿 POST /policy（既有）；真壳 = 调试面 dialogPolicy 一次性应答
    //    custom-protocol fetch 腿（`packages/app/src/debug/dialog-policy.ts`）。
    //    旧退化形态「点最近项目第一行」根本不读传入路径，是假绿之源（PITFALLS 230），已删——
    //    路径落不了地就在后面的 rootDir 硬对拍上如实红，绝不猜。
    if (s.mode === 'shell') {
      if (flags.includes('--writable')) {
        die(
          '真壳 open-project 只支持只读打开：调试面应答的对话框**不进 Rust 写域准入门**' +
            '（铁律 6/7：准入门只认真实对话框交付）。要验写链路走 web 模式（serve，调试宿有自己的写域登记）' +
            '或真人开一次对话框。',
          2,
        );
      }
      const has = await cdp.evalJs('typeof (__kojoDebug.dialogPolicy && __kojoDebug.dialogPolicy.arm) === "function"');
      if (!has) {
        die('真壳调试面缺 dialogPolicy 面（壳里跑的是旧构建？stop 后重起 shell）——本命令不回退「最近项目行」猜路径（PITFALLS 230）', 2);
      }
      try {
        await cdp.evalJs(`__kojoDebug.dialogPolicy.arm(${JSON.stringify(abs)})`);
      } catch (err) {
        die(`调试面装载对话框应答失败：${String(err?.message ?? err)}`, 1);
      }
    } else {
      await fetch(`http://127.0.0.1:${s.serverPort}/policy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chooseDir: abs }),
        signal: AbortSignal.timeout(3000),
      });
    }
    // 应答装了却没被消费（中途失败/相位不对）不许留过期 policy——收尾一律 clear
    let failure = null;
    try {
      // 2) 首启「开发者的碎碎念」纸条会盖住整屏（一次性提示）：在场就按真实路径关掉
      //    （ghost=关闭并记「看过」，同一浏览器档案不会再弹）。它是懒挂载的（Suspense fallback
      //    本身就是一层 .modal-mask）——helper 等到落定为止，防「检查后 0.5s 弹上」吃掉后续点击。
      if (!(await dismissDevNoteMask(cdp))) {
        throw new Error('「开发者的碎碎念」纸条关不掉（ghost 点击未生效）——屏幕被遮罩盖住，如实红');
      }
      // 3) 点「打开项目」卡（欢迎相位）——两模式同路；真壳的对话框已由第 1 步的 policy 应答
      const phase = await cdp.evalJs('__kojoDebug.state().phase');
      if (phase === 'welcome') {
        await waitFor(cdp, `!!document.querySelector('.welcome-open')`, { timeoutMs: 10000, label: '欢迎页打开按钮' });
        for (let i = 0; i < 40; i++) {
          const gate = await cdp.evalJs(`(() => {
            const el = document.querySelector('.welcome-open');
            const note = !!document.querySelector('.dev-note-mask');
            if (!el) return { note, clickable: false };
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
            return { note, clickable: !!hit && hit.closest('.welcome-open') !== null };
          })()`);
          if (gate?.note) {
            await cdpClick(cdp, '.dev-note-actions .ghost');
            await sleep(200);
            continue;
          }
          if (gate?.clickable) break;
          await sleep(200);
        }
        await cdpClick(cdp, '.welcome-open');
      } else {
        throw new Error(`当前相位是 ${phase}（已开着别的项目）——先关项目（工具栏「项目操作」→「关闭项目」，它不是命令面板命令）或 stop 后重启会话`);
      }
      // 4) 写权限审批弹窗（出现就按 flags 决定；不出现（只读根）就等树）
      const modal = await waitFor(
        cdp,
        `(() => { const m = document.querySelector('.modal[aria-label="写权限确认"]'); return m ? 'yes' : (document.querySelector('.file-tree') ? 'tree' : ''); })()`,
        { timeoutMs: 60000, intervalMs: 250, label: '写权限审批 / 文件树' },
      );
      if (modal === 'yes') {
        // 弹窗里 primary = 批准可写；ghost = 只读浏览
        await cdpClick(cdp, flags.includes('--writable') ? '.modal .primary' : '.modal .ghost');
        console.log(flags.includes('--writable') ? '   写权限：已批准可写' : '   写权限：按只读浏览');
      }
      // 5) 等项目态落定：文件树在场 + project.rootDir 就位
      await waitFor(cdp, `!!document.querySelector('.file-tree')`, { timeoutMs: 90000, label: '文件树' });
      const st = await waitFor(cdp, `(__kojoDebug.state().project ?? {}).rootDir ?? ''`, { timeoutMs: 90000, label: 'project.rootDir' });
      const state = await cdp.evalJs('__kojoDebug.state()');
      // 防假绿硬对拍（PITFALLS 230 的病根）：落盘读到的 rootDir 必须逐字（win 忽略大小写）等于请求目录
      if (!samePath(path.resolve(String(st)), abs)) {
        throw new Error(`打开的目录与请求不一致（假绿拦截）：请求 ${abs}，实际 ${st}`);
      }
      console.log(`[ok] 项目已开：${st}`);
      console.log(`   adapter=${state.project?.adapterId ?? '?'} · 标签=${state.tabs.count} · 通知=${state.notices.count}`);
      for (const n of state.notices.items ?? []) console.log(`   notice: ${n}`);
    } catch (err) {
      failure = err;
    } finally {
      if (s.mode === 'shell') {
        await cdp.evalJs('__kojoDebug.dialogPolicy && __kojoDebug.dialogPolicy.clear()').catch(() => {});
      }
    }
    if (failure) throw failure;
  });
}

async function cmdOpenFile(args, frag) {
  if (!frag) die('open-file 需要路径片段（文件树行的路径包含它即命中）', 2);
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, `!!document.querySelector('.file-tree')`, { timeoutMs: 10000, label: '文件树（先 open-project）' });
    // 树初始折叠：先逐层展开直到有文件行（找不到含 frag 的行时也会先展开再找一轮）
    for (let round = 0; round < 3; round++) {
      const hitNow = await cdp.evalJs(`!![...document.querySelectorAll('.tree-file')].find((r) => (r.getAttribute('title') || '').includes(${JSON.stringify(frag)}))`);
      if (hitNow) break;
      const step = await expandTreeUntilFile(cdp);
      if (step !== 'file') break;
    }
    const found = await cdp.evalJs(`(() => {
      const rows = [...document.querySelectorAll('.tree-file')];
      const hit = rows.find((r) => (r.getAttribute('title') || r.textContent || '').includes(${JSON.stringify(frag)}));
      if (!hit) return null;
      hit.scrollIntoView({ block: 'center' });
      hit.click();
      return hit.getAttribute('title') || hit.textContent;
    })()`);
    if (!found) die(`文件树里没有路径含「${frag}」的行（可能要展开目录；先用 dom 看树）`, 1);
    await waitFor(cdp, `!!document.querySelector('.monaco-editor')`, { timeoutMs: 30000, label: 'Monaco 挂载' });
    await sleep(400);
    const info = await cdp.evalJs('__kojoDebug.editor.info()');
    console.log(`[ok] 已打开：${info?.path ?? found}`);
    console.log(`   语言=${info?.languageId} 行数=${info?.lineCount} EOL=${info?.eol}`);
  });
}

async function cmdClick(args, selector) {
  if (!selector) die('click 需要选择器', 2);
  await withCdp(async (s, cdp) => {
    const c = await cdpClick(cdp, selector);
    console.log(`[ok] 已点击 ${selector}（坐标 ${c.x},${c.y}）`);
  });
}

async function cmdType(args, selector, text) {
  // 反哺修（2026-10-25）：选择器可省——省略时打到**当前焦点元素**。命令面板 / 搜索框
  // 这类输入没有稳定选择器，先 click 点开、再 `type <文本>` 是顺手的驱动形态。
  if (text === undefined) {
    text = selector;
    selector = null;
  }
  if (text === undefined) die('type 需要 [<选择器>] <文本>；省略选择器＝打到当前焦点元素', 2);
  await withCdp(async (s, cdp) => {
    let focusInfo = null;
    if (selector) {
      await cdpClick(cdp, selector);
    } else {
      focusInfo = await cdp.evalJs(`(() => {
        const a = document.activeElement;
        if (!a) return null;
        return {
          tag: a.tagName,
          cls: String(a.className ?? '').slice(0, 60),
          editable: a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable === true,
        };
      })()`);
      if (!focusInfo) die('当前没有焦点元素——先 click 聚焦，或给选择器', 1);
      if (!focusInfo.editable) {
        die(`焦点元素不可输入（${focusInfo.tag}.${focusInfo.cls}）——命令面板/搜索框要先点开（或 key ctrl+p）再 type`, 1);
      }
    }
    await cdp.send('Input.insertText', { text });
    console.log(
      `[ok] 已输入 ${text.length} 字符${selector ? ` 到 ${selector}` : `（焦点元素 ${focusInfo?.tag ?? ''}.${focusInfo?.cls ?? ''}）`}`,
    );
  });
}

async function cmdKey(args, key, mod = '') {
  if (!key) die('key 需要 <键名>（enter/escape/tab/arrowdown/…）', 2);
  const mods = mod.split('+').filter(Boolean);
  await withCdp(async (s, cdp) => {
    const keyDef = {
      enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
      escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
      tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
      backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
      arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    }[key.toLowerCase()] ?? { key: key.length === 1 ? key : key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), ...(key.length === 1 ? { text: key } : {}) };
    const modifiers = (mods.includes('ctrl') ? 2 : 0) | (mods.includes('shift') ? 8 : 0) | (mods.includes('alt') ? 1 : 0);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...keyDef });
    // char（文本插入）只给**裸键**：带修饰键的组合（ctrl+p 之类）在真实浏览器里不产文本，
    // 实测坑：char 里带着 'p' 会把字面字母插进刚打开的命令面板输入框（inputVal 变 "p问题"）。
    if (keyDef.text && modifiers === 0) await cdp.send('Input.dispatchKeyEvent', { type: 'char', modifiers, ...keyDef });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...keyDef });
    console.log(`[ok] 已发送键 ${mods.length ? mods.join('+') + '+' : ''}${key}`);
  });
}

async function cmdScreenshot(args, out) {
  if (!out) die('screenshot 需要输出路径（.png）', 2);
  const full = args.includes('--full');
  await withCdp(async (s, cdp) => {
    await cdp.send('Page.enable').catch(() => {});
    const buf = await cdp.screenshot(full);
    const dest = path.resolve(out);
    await fsp.writeFile(dest, buf);
    console.log(`[shot] 截图已存：${dest}（${full ? '整页' : '视口'}，${(buf.length / 1024).toFixed(0)} KB）`);
  });
}

async function cmdDom() {
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 10000, label: '__kojoDebug 装载' });
    console.log(JSON.stringify(await cdp.evalJs('__kojoDebug.dom.snapshot()'), null, 2));
  });
}

async function cmdEvents(args, nArg) {
  const n = Number(nArg ?? 40) || 40;
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 10000, label: '__kojoDebug 装载' });
    const list = await cdp.evalJs(`__kojoDebug.bus.recent(${n})`);
      // e.t 与探针同域（performance.now() 页内钟，口径修②）——不再是墙钟：相对首条的偏移毫秒展示
      const firstT = list?.[0]?.t;
      for (const e of list ?? []) {
        console.log(`+${Math.max(0, Math.round(e.t - firstT))}ms ${e.name} ${JSON.stringify(e.payload).slice(0, 160)}`);
      }
    console.log(`（最近 ${list?.length ?? 0} 条）`);
  });
}

async function cmdInvoke(args, cmd, jsonArgs) {
  if (!cmd) die('invoke 需要 <命令名> [JSON参数]', 2);
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 10000, label: '__kojoDebug 装载' });
    const expr = `__kojoDebug.invoke(${JSON.stringify(cmd)}, ${jsonArgs ?? '{}'})`;
    const v = await cdp.evalJs(expr, 60000);
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  });
}

/**
 * perf <start|stop|quick [ms]>——UI 卡顿体检（2026-10-25 调试模式批）：
 * start 开探针（页内持续采集，跨 CLI 调用存活）→ 中间随便驱动（run/click/type/切主题）→
 * stop 出结构化报告；quick N = start+睡 N ms+stop 一条龙。报告四路读数：
 * 帧率/掉帧分档、长任务(≥50ms)、交互延迟(>100ms)、逐源码文件的帧耗时归因
 * （long-animation-frame；运行时不支持会如实标注）。
 */
async function cmdPerf(args, sub, msArg) {
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 10000, label: '__kojoDebug 装载' });
    const mode = sub ?? 'quick';
    if (mode === 'start') {
      const ack = await cdp.evalJs('__kojoDebug.perf.start()');
      console.log(ack?.note ?? JSON.stringify(ack));
      return;
    }
    if (mode === 'stop') {
      await printProbeReport(cdp);
      return;
    }
    if (mode === 'quick') {
      const ms = Math.max(500, Number(msArg ?? 3000) || 3000);
      await cdp.evalJs('__kojoDebug.perf.start()');
      console.log(`[perf] 采样 ${ms}ms …`);
      await sleep(ms);
      await printProbeReport(cdp);
      return;
    }
    die('perf 子形态：start / stop / quick [ms]（缺省 quick 3000）', 2);
  });
}

async function printProbeReport(cdp) {
  // stop() 同步返回报告（探针是页内对象，无异步链）——try/catch 形态统一吃两种实现
  const report = await cdp.evalJs(
    `(() => { try { return __kojoDebug.perf.stop(); } catch (e) { return { __err: String(e && e.message || e) }; } })()`,
    30000,
  );
  if (report && report.__err) die(`探针 stop 失败：${report.__err}`, 1);
  if (!report) die('探针没有返回报告', 1);
  // 人读摘要（口径行自带）+ 全量 JSON（可断言/落盘）
  const summary = await cdp.evalJs('__kojoDebug.perf.summary()');
  for (const line of summary ?? []) console.log(line);
  console.log('---- report(json) ----');
  console.log(JSON.stringify(report, null, 2));
}

/**
 * profile <start|stop|run [ms]>——CDP Profiler 归因（2026-10-25 反馈④，把「自己在 %TEMP%
 * 写 CDP 脚本」变成常规通道）：性能探针的 long-animation-frame 只给长帧内的 sourceURL；
 * **自用时归因**（函数级热点、selfTime）要 CPU 采样器。分工：perf 答「卡不卡、卡在哪帧」；
 * profile 答「热点函数是谁」。
 *
 * ⚠ Profiler 会话绑定 CDP **连接**：连接断开采样即丢（实测 "No recording profiles found"）。
 * 因此 start/stop 必须同一条连接——CLI 每次调用独立连接 ⇒ 跨调用 start→stop 拿不到数据。
 * 常规用法是 `profile run [ms]`（一次连接内 start→睡→stop 一条龙）；`KOJO_PROFILE_OUT`
 * 可同时落完整 .cpuprofile（Chrome DevTools 火焰图）。
 */
async function cmdProfile(args, sub, msArg) {
  await withCdp(async (s, cdp) => {
    const mode = sub ?? 'run';
    if (mode === 'start') {
      die(
        'profile start/stop 跨 CLI 调用拿不到数据（Profiler 绑定 CDP 连接，连接断采样即丢——实测）。\n' +
          '用一次连接内完成的形式：node tools/debug-cli.mjs profile run [ms]（缺省 3000）',
        2,
      );
    }
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 }).catch(() => {});
    const runMs = mode === 'run' ? Math.max(300, Number(msArg ?? 3000) || 3000) : 0;
    if (mode === 'run') {
      await cdp.send('Profiler.start');
      // 同连接内可选负载：--eval "<js>"（Profiler 会话绑连接，CLI 跨调用 start→stop 拿不到
      // 数据 ⇒ 代码级负载必须在同一条连接的窗口里跑；页内交互可由真人/并行 CLI 驱动）
      const evalIdx = args.indexOf('--eval');
      const loadExpr = evalIdx >= 0 ? args[evalIdx + 1] : null;
      console.log(`[profile] 采样 ${runMs}ms …${loadExpr ? '（含 --eval 负载）' : '（这段窗口内去驱动界面）'}`);
      if (loadExpr) {
        const until = Date.now() + runMs;
        while (Date.now() < until) {
          // 每次迭代包 IIFE：负载里的 const/let 不留在页内全局（重复求值会撞重声明）
          await cdp.evalJs(`(() => { ${loadExpr} })()`, 30000).catch((err) =>
            console.warn(`[profile] eval 失败：${String(err?.message ?? err).slice(0, 120)}`),
          );
        }
      } else {
        await sleep(runMs);
      }
    }
    const { profile } = await cdp.send('Profiler.stop');
    await printProfileSummary(profile);
  });
}

async function printProfileSummary(profile) {
  const nodes = profile.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const self = new Map(); // nodeId → selfTime µs
  let totalUs = 0;
  for (const [i, sample] of (profile.samples ?? []).entries()) {
    const dt = profile.timeDeltas?.[i] ?? 0; // µs（timeDeltas[i] = 第 i-1→i 个样本的间隔）
    if (dt <= 0) continue;
    totalUs += dt;
    self.set(sample, (self.get(sample) ?? 0) + dt);
  }
  const rows = [...self.entries()]
    .map(([id, us]) => {
      const n = byId.get(id) ?? {};
      const cf = n.callFrame ?? {};
      const url = String(cf.url ?? '');
      const file = url ? url.split('/').slice(-2).join('/') : '(vm)';
      const fn = cf.functionName || '(anonymous)';
      return { where: `${file}:${cf.lineNumber ?? '?'} ${fn}`, selfMs: us / 1000 };
    })
    // 过滤阈值按 µs 算（此前 >1ms 会把 100µs 采样档的绝大多数样本滤掉，只剩 3ms 假读数）
    .filter((r) => r.selfMs > 0.2)
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, 25);
  console.log(`[profile] 采样总时长 ${(totalUs / 1000).toFixed(0)}ms；按 selfTime 降序 Top ${rows.length}：`);
  for (const r of rows) {
    console.log(`  ${r.selfMs.toFixed(1)}ms  ${r.where}`);
  }
  if (rows.length === 0) console.log('  （采样窗口太短或无热点——窗口拉长点再试）');
  const dest = process.env.KOJO_PROFILE_OUT;
  if (dest) {
    await fsp.writeFile(path.resolve(dest), JSON.stringify(profile));
    console.log(`[profile] 完整 profile 已存：${path.resolve(dest)}（可拖进 Chrome DevTools 的 Performance 面板看火焰图）`);
  } else {
    console.log('[profile] 提示：设 KOJO_PROFILE_OUT=<路径> 可同时落完整 .cpuprofile（DevTools 火焰图）');
  }
}

/* ------------------------------ main ------------------------------ */

function parseArgs(argv) {
  const flags = [];
  const opts = { readonly: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sandbox') opts.sandbox = argv[++i];
    else if (a === '--readonly') opts.readonly.push(argv[++i]);
    else if (a === '--vite-port') opts.vitePort = Number(argv[++i]);
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--cdp-port') opts.cdpPort = Number(argv[++i]);
    else if (a === '--browser') opts.browser = argv[++i];
    else if (a === '--headless' || a === '--no-browser' || a === '--record' || a === '--fresh' || a === '--writable' || a === '--full' || a === '--isolate' || a === '--no-debug-api') flags.push(a);
    else positional.push(a);
  }
  return { flags, opts, positional };
}

const [rawCmd, ...rest] = process.argv.slice(2);
const { flags, opts, positional } = parseArgs(rest);
const commands = {
  serve: () =>
    cmdServe({
      ...opts,
      fresh: flags.includes('--fresh'),
      headless: flags.includes('--headless'),
      noBrowser: flags.includes('--no-browser'),
      record: flags.includes('--record'),
    }),
  shell: () =>
    cmdShell(
      { ...opts, record: flags.includes('--record') },
      flags,
    ),
  status: cmdStatus,
  stop: cmdStop,
  url: async () => { const s = await readSession(); console.log(s.url); },
  eval: () => cmdEval(positional, positional[0]),
  state: cmdState,
  commands: () => cmdCommands(positional, positional[0]),
  run: () => cmdRun(positional, positional[0]),
  'open-project': () => cmdOpenProject(opts, positional[0], flags),
  'open-file': () => cmdOpenFile(positional, positional[0]),
  click: () => cmdClick(positional, positional[0]),
  type: () => cmdType(positional, positional[0], positional[1]),
  key: () => cmdKey(positional, positional[0], positional[1]),
  screenshot: () => cmdScreenshot(flags, positional[0]),
  dom: cmdDom,
  events: () => cmdEvents(positional, positional[0]),
  invoke: () => cmdInvoke(positional, positional[0], positional[1]),
  perf: () => cmdPerf(positional, positional[0], positional[1]),
  profile: () => cmdProfile(positional, positional[0]),
};
if (!rawCmd || !commands[rawCmd]) {
  console.log('用法：node tools/debug-cli.mjs <子命令> […]\n  ' + [...Object.keys(commands)].join(' · '));
  process.exit(rawCmd ? 1 : 0);
}
await commands[rawCmd]();
