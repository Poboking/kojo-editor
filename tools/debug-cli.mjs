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
 *   status                     # 三件套健康 + 页面相位
 *   stop                       # 收掉整套（按 pid 收，端口兜底）
 *   url                        # 编辑器 URL（浏览器 / agent 直接开这个）
 *   eval "<js 表达式>"         # 页内求值（可 await；自动 JSON 序列化）
 *   state                      # __kojoDebug.state() 一屏读数
 *   commands [过滤串]          # 命令面板注册表（所有功能的可编程入口）
 *   run <命令id>               # 跑一条命令面板命令
 *   open-project <目录> [--writable] [--no-open-first]
 *         # 真实用户路径开项目：自动应答目录对话框 → 点「打开项目」卡 → 处理写权限审批
 *   open-file <路径片段>       # 点文件树真实打开一个文件（等 Monaco 挂载）
 *   click <选择器>             # CDP 真实点击（元素中心 + elementFromPoint 自证）
 *   type <选择器> <文本>       # 点击聚焦后按输入法通道插入文本
 *   key <键> [ctrl|alt|shift]  # 真实键事件（enter/escape/tab/arrowdown/…，可带修饰键）
 *   screenshot <out.png> [--full]   # 整页截图（agent 可直接看 PNG）
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
  expandTreeUntilFile,
  findBrowser,
  freePort,
  killProcessesMarked,
  portOpen,
  sleep,
  waitFor,
} from './debug-lib.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const DEBUG_DIR = debugHome();
const SESSION_FILE = process.env.KOJO_DEBUG_SESSION ?? path.join(DEBUG_DIR, 'session.json');
const die = (msg, code = 1) => {
  console.error(String(msg));
  process.exit(code);
};

/* ------------------------------ 小工具 ------------------------------ */

async function readSession() {
  try {
    return JSON.parse(await fsp.readFile(SESSION_FILE, 'utf-8'));
  } catch {
    die(
      `没有在跑的调试会话（${SESSION_FILE} 不存在）。先起一套：\n  node tools/debug-cli.mjs serve`,
      2,
    );
  }
}

async function cdpForSession(session, { mustHavePage = true } = {}) {
  const page = await cdpPage(session.cdpPort, session.vitePort);
  if (!page) {
    if (!mustHavePage) return null;
    die(`CDP ${session.cdpPort} 上没有页面（浏览器没开或已关）`, 2);
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  return cdp;
}

/* ------------------------------ serve ------------------------------ */

async function cmdServe(args) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const session = {
    createdAt: new Date().toISOString(),
    sandbox: path.resolve(args.sandbox ?? path.join(DEBUG_DIR, 'sandbox')),
    appdata: path.join(DEBUG_DIR, 'appdata'),
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

  const children = [];
  const cleanup = async () => {
    for (const c of children) {
      try {
        if (process.platform === 'win32') spawnSync(`taskkill /PID ${c.pid} /T /F`, { shell: true, stdio: 'ignore' });
        else c.kill('SIGTERM');
      } catch {}
    }
    try { await fsp.rm(SESSION_FILE, { force: true }); } catch {}
  };
  process.on('SIGINT', () => { console.log('\n[cli] 收会话…'); void cleanup().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void cleanup().then(() => process.exit(0)); });

  // 1) 调试宿
  const serverArgs = ['tools/debug-server.mjs', '--port', String(session.serverPort), '--sandbox', session.sandbox, '--appdata', session.appdata];
  for (const r of session.readonly) serverArgs.push('--readonly', r);
  children.push(spawn(process.execPath, serverArgs, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] }));
  session.serverPid = children[0].pid;
  children[0].stdout.on('data', (d) => process.stdout.write(`[host] ${d}`));
  children[0].stderr.on('data', (d) => process.stderr.write(`[host!] ${d}`));

  // 2) vite（编辑器页面；--port 覆盖配置里的 1420，strictPort 只对自己的端口严格）
  const viteBin = path.join(REPO, 'packages', 'app', 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteBin)) die(`vite 不在位（${viteBin}）——先 pnpm install`, 2);
  children.push(
    spawn(process.execPath, [viteBin, '--port', String(session.vitePort), '--strictPort'], {
      cwd: path.join(REPO, 'packages', 'app'),
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  session.vitePid = children[1].pid;
  let viteLog = '';
  children[1].stdout.on('data', (d) => { viteLog += d.toString(); process.stdout.write(`[vite] ${d}`); });
  children[1].stderr.on('data', (d) => { viteLog += d.toString(); process.stderr.write(`[vite!] ${d}`); });

  console.log(`[cli] 起调试宿 :${session.serverPort} 与 vite :${session.vitePort} …`);
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
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
      console.warn('[cli] ⚠ 没找到 Chrome/Edge——跳过浏览器（页面 URL 仍可用，agent 内置浏览器直接开）');
      session.browserPid = null;
    } else {
      const profile = path.join(DEBUG_DIR, 'browser-profile');
      fs.mkdirSync(profile, { recursive: true });
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
      children.push(browser);
      session.browserPid = browser.pid;
      const t1 = Date.now();
      while (Date.now() - t1 < 30000 && !(await portOpen(session.cdpPort))) await sleep(400);
      if (await portOpen(session.cdpPort)) {
        console.log(`[cli] 浏览器 CDP 就绪 :${session.cdpPort}（${args.headless ? '无头' : '有窗'}）`);
        if (args.record) void recordConsole(session).catch((err) => console.warn(`[cli] console 记录失败：${err?.message ?? err}`));
      } else {
        console.warn('[cli] ⚠ 浏览器起了但 CDP 30s 没就绪（无头标志或策略拦截？）；继续无 CDP 模式');
      }
    }
  }
  await fsp.writeFile(SESSION_FILE, JSON.stringify(session, null, 2), 'utf-8');

  console.log('');
  console.log('✅ 调试会话就绪：');
  console.log(`   编辑器 URL ：${session.url}   ← 浏览器 / agent 打开这个`);
  console.log(`   调试宿     ：http://127.0.0.1:${session.serverPort}/health`);
  console.log(`   沙盒       ：${session.sandbox}${session.readonly.length ? `（只读根：${session.readonly.join('；')}）` : ''}`);
  console.log('   常用命令   ：status · state · commands · open-project <dir> · open-file <片段> · screenshot <png>');
  console.log('   收工       ：Ctrl+C 或 node tools/debug-cli.mjs stop');
  console.log('');
  await new Promise(() => {}); // 前台驻留（收尾走 SIGINT）
}

/** serve --record：挂一条常驻 CDP 连接，把 console / 异常 / 网络失败落到 .kojo-debug/console.log */
async function recordConsole(session) {
  const cdp = await cdpForSession(session);
  const out = fsp.createWriteStream(path.join(DEBUG_DIR, 'console.log'), { flags: 'a' });
  const line = (s) => out.write(`[${new Date().toISOString()}] ${s}\n`);
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

/* ------------------------------ 其余子命令 ------------------------------ */

async function cmdStatus() {
  const s = await readSession();
  const serverOk = await fetch(`http://127.0.0.1:${s.serverPort}/health`).then((r) => r.ok).catch(() => false);
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
  console.log(
    JSON.stringify(
      {
        调试宿: serverOk ? `✅ :${s.serverPort}` : `❌ :${s.serverPort}`,
        vite: viteOk ? `✅ :${s.vitePort}` : `❌ :${s.vitePort}`,
        浏览器CDP: cdpOk ? `✅ :${s.cdpPort}` : '—（未起浏览器或已关）',
        页面相位: pagePhase,
        URL: s.url,
        sandbox: s.sandbox,
        readonly: s.readonly,
      },
      null,
      2,
    ),
  );
  process.exit(serverOk && viteOk ? 0 : 1);
}

async function cmdStop() {
  const s = await readSession();
  const pids = [s.browserPid, s.vitePid, s.serverPid].filter((p) => typeof p === 'number' && p > 0);
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
  // 兜底：Edge 子进程会逃出树杀（实测锁着 profile ⇒ 目录清不掉）。按会话目录认领再收一轮。
  killProcessesMarked(DEBUG_DIR);
  try { await fsp.rm(SESSION_FILE, { force: true }); } catch {}
  console.log('🧹 调试会话已收（' + (pids.length ? `pid ${pids.join('/')}` : '无存活 pid') + '；运行时目录 ' + DEBUG_DIR + '）');
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
    const v = await cdp.evalJs(expr, 60000);
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
    console.log(`✅ 已执行命令 ${id}（当前相位：${phase}）`);
  });
}

async function cmdOpenProject(args, dir, flags) {
  if (!dir) die('open-project 需要目录参数', 2);
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) die(`目录不存在：${abs}`, 2);
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 15000, label: '__kojoDebug 装载' });
    // 0) 已开着同一个项目 ⇒ 幂等直过
    const cur = await cdp.evalJs('(__kojoDebug.state().project ?? {}).rootDir ?? null');
    if (cur && path.resolve(String(cur)) === abs) {
      console.log(`✅ 项目已开着：${abs}`);
      return;
    }
    // 1) 目录对话框的自动应答（真实点击后 UI 会走 choose_directory → 调试宿按 policy 应答）
    await fetch(`http://127.0.0.1:${s.serverPort}/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chooseDir: abs }),
    });
    // 2) 首启「开发者的碎碎念」纸条会盖住整屏（一次性提示）：在场就按真实路径关掉
    //    （ghost=关闭并记「看过」，同一浏览器档案不会再弹）
    if (await cdp.evalJs('!!document.querySelector(".dev-note-mask")')) {
      await cdpClick(cdp, '.dev-note-actions .ghost');
      await sleep(300);
    }
    // 3) 点「打开项目」卡（欢迎相位）——项目相位（换项目）时走命令面板不适用，直接给显式错
    const phase = await cdp.evalJs('__kojoDebug.state().phase');
    if (phase === 'welcome') {
      await waitFor(cdp, `!!document.querySelector('.welcome-open')`, { timeoutMs: 10000, label: '欢迎页打开按钮' });
      await cdpClick(cdp, '.welcome-open');
    } else {
      die(`当前相位是 ${phase}（已开着别的项目）——先 __kojoDebug.commands.run('workbench.closeProject') 或重启会话`, 2);
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
    console.log(`✅ 项目已开：${st}`);
    console.log(`   adapter=${state.project?.adapterId ?? '?'} · 标签=${state.tabs.count} · 通知=${state.notices.count}`);
    for (const n of state.notices.items ?? []) console.log(`   notice: ${n}`);
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
    console.log(`✅ 已打开：${info?.path ?? found}`);
    console.log(`   语言=${info?.languageId} 行数=${info?.lineCount} EOL=${info?.eol}`);
  });
}

async function cmdClick(args, selector) {
  if (!selector) die('click 需要选择器', 2);
  await withCdp(async (s, cdp) => {
    const c = await cdpClick(cdp, selector);
    console.log(`✅ 已点击 ${selector}（坐标 ${c.x},${c.y}）`);
  });
}

async function cmdType(args, selector, text) {
  if (!selector || text === undefined) die('type 需要 <选择器> <文本>', 2);
  await withCdp(async (s, cdp) => {
    await cdpClick(cdp, selector);
    await cdp.send('Input.insertText', { text });
    console.log(`✅ 已输入 ${text.length} 字符到 ${selector}`);
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
    if (keyDef.text) await cdp.send('Input.dispatchKeyEvent', { type: 'char', modifiers, ...keyDef });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...keyDef });
    console.log(`✅ 已发送键 ${mods.length ? mods.join('+') + '+' : ''}${key}`);
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
    console.log(`📸 截图已存：${dest}（${full ? '整页' : '视口'}，${(buf.length / 1024).toFixed(0)} KB）`);
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
    for (const e of list ?? []) {
      console.log(`${new Date(e.t).toISOString().slice(12, 23)} ${e.name} ${JSON.stringify(e.payload).slice(0, 160)}`);
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
    else if (a === '--headless' || a === '--no-browser' || a === '--record' || a === '--fresh' || a === '--writable' || a === '--full') flags.push(a);
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
};
if (!rawCmd || !commands[rawCmd]) {
  console.log('用法：node tools/debug-cli.mjs <子命令> […]\n  ' + [...Object.keys(commands)].join(' · '));
  process.exit(rawCmd ? 1 : 0);
}
await commands[rawCmd]();
