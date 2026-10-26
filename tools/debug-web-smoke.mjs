#!/usr/bin/env node
/**
 * Web 调试模式无头冒烟（2026-10-24 调试模式批）：不起桌面壳，只用
 * 「调试宿 + vite + 无头浏览器（CDP）」把编辑器完整跑一遍：
 *
 *   欢迎页渲染 → open-project（真实点击链路：目录对话框自动应答 → 写权限审批）→
 *   文件树在场 → open-file（真实点击）→ Monaco 挂载 → 命令注册表 → 事件旁听 →
 *   调试宿 invoke 直达 → DOM 结构快照 → 截图落盘。
 *
 * 与 `smoke-tauri-dom.mjs` 的分工：那把刀验**桌面壳**（真 IPC / 真机右键），
 * 这把刀验**浏览器调试模式**（多 agent 无桌面壳时的体感 / UI / 功能验证通道）。
 * 样例工程 = `fixtures/mini-game` 复制进沙盒（可写域内，保存链路也能测）。
 *
 * 用法：node tools/debug-web-smoke.mjs [--keep]   # --keep 保留沙盒与截图便于人工查看
 * 前置：本机有 Chrome/Edge（KOJO_DEBUG_BROWSER 可指定）；vite 已安装（pnpm install 过）。
 * 退出码：0 全绿；1 有断言红；2 前置不满足（没浏览器 / vite 不在位）。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createDebugServer } from './debug-server.mjs';
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
  sleep,
  waitFor,
} from './debug-lib.mjs';
import { assertPageOrigin } from './smoke-lib.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
// 每轮一个唯一工作目录，且**默认在系统临时目录**：browser-profile 里的文件会被 Edge
// 锁住，任何对仓库建整树 watcher 的工具（conformance CLI 载 vite）扫到就 EBUSY 崩——
// 调试模式的残留不许有能力弄红别人的测试（2026-10-24 实测，详见 debug-lib 头注）。
const WORK = path.join(debugHome(), `web-smoke-${process.pid}`);
const KEEP = process.argv.includes('--keep');

async function rmRetry(target, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      await fsp.rm(target, { recursive: true, force: true });
      return true;
    } catch {
      await sleep(600);
    }
  }
  return false;
}
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const children = [];
const cleanupAll = [];
async function shutdown(code) {
  for (const fn of cleanupAll.reverse()) {
    try { await fn(); } catch {}
  }
  for (const c of children) {
    try {
      if (process.platform === 'win32') spawnSync(`taskkill /PID ${c.pid} /T /F`, { shell: true, stdio: 'ignore' });
      else c.kill('SIGTERM');
    } catch {}
  }
  // Edge 子进程会逃出树杀、锁着 browser-profile：按工作目录认领再收一轮，才谈得上清理
  killProcessesMarked(WORK);
  await sleep(500);
  if (!KEEP) {
    await rmRetry(WORK);
  }
  // 旧轮次残留（成功轮 / 被杀轮）尽力清；清不掉只提一句，不当红
  try {
    const home = debugHome();
    for (const name of await fsp.readdir(home)) {
      if (name.startsWith('web-smoke-') && path.join(home, name) !== WORK) {
        if (!(await rmRetry(path.join(home, name), 1))) {
          console.warn(`[smoke] 旧目录清不掉（可能被浏览器锁着，稍后自清）：${name}`);
        }
      }
    }
  } catch {}
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `❌ web 调试冒烟 ${failed.length} 项红` : '✅ web 调试冒烟全绿');
  process.exit(failed.length ? 1 : code === 1 ? 1 : 0);
}
process.on('SIGINT', () => shutdown(1));

/* ------------------------------ 前置 ------------------------------ */

const browser = findBrowser(null);
if (!browser) {
  console.error('[smoke] 前置不满足：本机没找到 Chrome/Edge（可用 KOJO_DEBUG_BROWSER 指定）——exit 2');
  process.exit(2);
}
const viteBin = path.join(REPO, 'packages', 'app', 'node_modules', 'vite', 'bin', 'vite.js');
if (!fs.existsSync(viteBin)) {
  console.error(`[smoke] 前置不满足：vite 不在位（${viteBin}）——先 pnpm install ——exit 2`);
  process.exit(2);
}
console.log(`[smoke] 浏览器：${browser}`);

/* ------------------------------ 环境 ------------------------------ */

await rmRetry(WORK);
// 上轮锁死的目录不强求（唯一目录名已避开复用冲突）
const sandbox = path.join(WORK, 'sandbox');
const appdata = path.join(WORK, 'appdata');
const project = path.join(sandbox, 'mini-game');
await fsp.cp(path.join(REPO, 'fixtures', 'mini-game'), project, { recursive: true });

const server = await createDebugServer({ port: 0, sandbox, appdata, log: () => {} });
cleanupAll.push(() => server.close());
console.log(`[smoke] 调试宿 :${server.port}`);

const vitePort = await freePort(4273);
// `--host 127.0.0.1`（2026-10-26 修，PITFALLS 230 同族小坑）：vite 7 缺省只绑/只报 localhost
// （Windows 上常仅解析 ::1），而下面的页面 URL 与本会话一切读数口径都写 127.0.0.1——
// 不显式 --host 就是 ERR_CONNECTION_REFUSED 假红。与 debug-cli.mjs cmdServe 同口径，不动产品配置。
const vite = spawn(process.execPath, [viteBin, '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], {
  cwd: path.join(REPO, 'packages', 'app'),
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(vite);
let viteLog = '';
vite.stdout.on('data', (d) => (viteLog += d.toString()));
vite.stderr.on('data', (d) => (viteLog += d.toString()));

for (let i = 0; i < 120 && !(await portOpen(vitePort)); i++) await sleep(500);
if (!(await portOpen(vitePort))) {
  console.error(`[smoke] vite 60s 没就绪：\n${viteLog.slice(-800)}`);
  await shutdown(1);
}
console.log(`[smoke] vite :${vitePort}`);

const cdpPort = await freePort(9533);
const profile = path.join(WORK, 'browser-profile');
fs.mkdirSync(profile, { recursive: true });
const url = `http://127.0.0.1:${vitePort}/?kojo-debug=${server.port}`;
const browserProc = spawn(
  browser,
  [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--window-size=1600,900',
    url,
  ],
  { stdio: 'ignore' },
);
children.push(browserProc);
for (let i = 0; i < 60 && !(await portOpen(cdpPort)); i++) await sleep(400);
if (!(await portOpen(cdpPort))) {
  console.error('[smoke] 浏览器 CDP 30s 没就绪');
  await shutdown(1);
}

/* ------------------------------ 断言链 ------------------------------ */

let page = null;
for (let i = 0; i < 30 && !page; i++) {
  page = await cdpPage(cdpPort, vitePort).catch(() => null);
  if (!page) await sleep(500);
}
if (!page) {
  console.error('[smoke] CDP 页面拿不到');
  await shutdown(1);
}
const cdp = await new Cdp(page.webSocketDebuggerUrl).connect();
console.log(`[smoke] 页面：${page.url}`);

try {
  // ⓪ origin 钉（2026-10-26，PITFALLS 230 同族假绿/假红闸，与 smoke-tauri-ipc 同口径）：
  //    先等导航落定（刚挂上时文档还是 about:blank，直接问 origin 会假红——实测），
  //    再要求页面 origin **逐字等于我们自己的 127.0.0.1 vite**：端口上若坐着别的树
  //    （localhost/::1 漂址或同口他树 dev server），这里带 href 当场红，绝不吃假绿。
  await waitFor(cdp, `location.href !== 'about:blank'`, { timeoutMs: 30000, label: '页面导航落定（离开 about:blank）' });
  const pageHref = await assertPageOrigin(cdp, `http://127.0.0.1:${vitePort}`);
  console.log(`[smoke] 页面 origin 钉死：${pageHref}`);

  // ① 欢迎页真实渲染（结构判据，不匹配文案）
  await waitFor(cdp, '!!document.querySelector(".welcome")', { timeoutMs: 30000, label: '欢迎页' });
  check('欢迎页渲染', true);

  // ② 调试面装载（?kojo-debug 选入 ⇒ __kojoDebug 在场且走 web-debug 模式）
  await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 15000, label: '__kojoDebug' });
  const mode = await cdp.evalJs('({mode: __kojoDebug.mode, host: __kojoDebug.host, v: __kojoDebug.appVersion})');
  check('调试面在场', mode?.mode === 'web-debug' && String(mode?.host).includes('127.0.0.1'), JSON.stringify(mode));

  // ③ 宿主命令走调试宿：app_data_dir 直达 + kernel 装配成功（welcome 有卡片说明内核起来了）
  const appDir = await cdp.evalJs('__kojoDebug.invoke("app_data_dir")');
  check(
    'invoke 直达调试宿',
    String(appDir ?? '').replace(/\\/g, '/').endsWith('appdata'),
    String(appDir),
  );
  const kernelOk = await cdp.evalJs('__kojoDebug.kernel().then((k) => !!k && typeof k.project.current === "function")');
  check('内核装配完成', kernelOk === true);

  // ④ open-project：自动应答对话框 + 真实点击「打开项目」+ 写权限审批（批准可写——沙盒内可测保存链路）
  await fetch(`http://127.0.0.1:${server.port}/policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chooseDir: project }),
  });
  // ④a 调试面对话框 policy（2026-10-26 era-pair 批；真壳靠这条腿应答原生对话框，web 腿在此对拍）：
  //    armed 面在场 + **一次性**消费——armed 时 choose_directory 回页面值（宿 policy 值不动，未 armed 回宿值）。
  const dpFake = path.join(sandbox, 'dialog-policy-probe');
  const dpShape = await cdp.evalJs(
    `(() => { const d = __kojoDebug.dialogPolicy; return d && typeof d.arm === 'function' && typeof d.armed === 'function' && typeof d.clear === 'function' && typeof d.status === 'function' ? true : null; })()`,
  );
  check('dialogPolicy 面在场（arm/armed/clear/status）', dpShape === true);
  const dpRound = await cdp.evalJs(
    `(() => {
      __kojoDebug.dialogPolicy.arm(${JSON.stringify(dpFake)});
      const armedEcho = __kojoDebug.dialogPolicy.armed();
      return { armed: armedEcho.armed, value: armedEcho.value };
    })()`,
  );
  check(
    'dialogPolicy.arm 后 armed() 回显（win 路径大小写不敏感对拍）',
    dpRound?.armed === true && String(dpRound?.value).toLowerCase() === dpFake.toLowerCase(),
    JSON.stringify(dpRound),
  );
  const dpConsumed = await cdp.evalJs(
    `__kojoDebug.invoke('choose_directory').then((v) => __kojoDebug.dialogPolicy.armed().armed === false && String(v).toLowerCase() === ${JSON.stringify(dpFake.toLowerCase())})`,
  );
  check('dialogPolicy armed 时 choose_directory 回页面值且一次性消费', dpConsumed === true, String(dpConsumed));
  // 未 armed ⇒ 回落到既有宿 policy（POST /policy 的 project，非消费式）——真壳腿坏时这条红能区分层级
  const dpHost = await cdp.evalJs(`__kojoDebug.invoke('choose_directory').then((v) => String(v).toLowerCase() === ${JSON.stringify(project.toLowerCase())})`);
  check('未 armed 时 choose_directory 照旧回落宿 policy（零触扰）', dpHost === true, String(dpHost));

  // 首启「开发者的碎碎念」纸条会盖住整屏（一次性提示）：在场就按真实路径关掉。
  // 懒挂载竞态（2026-10-26 实拍）：纸条的 Suspense fallback 本身就是一层 .modal-mask，
  // 「在场才关」的单次检查会放行、0.5s 后遮罩弹上吃掉 .welcome-open 的点击 ⇒ dismissDevNoteMask 等到落定。
  if (!(await dismissDevNoteMask(cdp))) {
    throw new Error('「开发者的碎碎念」纸条关不掉（ghost 点击未生效）——屏幕被遮罩盖住，如实红');
  }
  await cdpClick(cdp, '.welcome-open');
  const modalStep = await waitFor(
    cdp,
    `(() => { const m = document.querySelector('.modal[aria-label="写权限确认"]'); return m ? 'yes' : (document.querySelector('.file-tree') ? 'tree' : ''); })()`,
    { timeoutMs: 60000, intervalMs: 250, label: '写权限审批 / 文件树' },
  );
  if (modalStep === 'yes') await cdpClick(cdp, '.modal .primary');
  const rootDir = await waitFor(cdp, '(__kojoDebug.state().project ?? {}).rootDir ?? ""', {
    timeoutMs: 90000,
    label: 'project.rootDir',
  });
  check('项目已打开', String(rootDir).replace(/\\/g, '/') === project.replace(/\\/g, '/'), String(rootDir));

  // ⑤ 文件树在场且能点开一个文件（逐层展开目录 → 真实点击 → Monaco 挂载）
  await waitFor(cdp, `!!document.querySelector('.file-tree')`, { timeoutMs: 60000, label: '文件树' });
  const expanded = await expandTreeUntilFile(cdp);
  check('文件树可展开出文件行', expanded === 'file', `expand=${expanded}`);
  const opened = await cdp.evalJs(`(() => {
    const row = [...document.querySelectorAll('.tree-file')][0];
    if (!row) return null;
    row.scrollIntoView({ block: 'center' });
    row.click();
    return row.getAttribute('title') || row.textContent;
  })()`);
  await waitFor(cdp, '!!document.querySelector(".monaco-editor")', { timeoutMs: 30000, label: 'Monaco' });
  await sleep(600);
  const info = await cdp.evalJs('__kojoDebug.editor.info()');
  check(
    '文件打开 + Monaco 挂载',
    !!info?.path && info.lineCount > 0,
    `${info?.path ?? '?'} · 行数=${info?.lineCount} · 语言=${info?.languageId}`,
  );

  // ⑤b 二进制直传（2026-10-26 性能批）：页面拿到的必须是原始 ArrayBuffer，
  //     不是 {__b64} 信封——读者据此区分旧宿回退与新宿直传两条腿。
  const binBytes = await cdp.evalJs(
    `(async () => {
      const r = await __kojoDebug.invoke('read_file_bytes_raw', { path: ${JSON.stringify(info?.path ?? '')} });
      return r instanceof ArrayBuffer ? r.byteLength : -1;
    })()`,
    30000,
  );
  check('二进制命令直传原始字节（ArrayBuffer）', typeof binBytes === 'number' && binBytes > 0, `${binBytes} B`);

  // ⑥ 命令注册表：所有功能的可编程入口在场
  const cmdCount = await cdp.evalJs('__kojoDebug.commands.list().length');
  check('命令注册表在场', Number(cmdCount) > 10, `${cmdCount} 条命令`);

  // ⑦ 事件旁听：开项目级联必然发过事件
  await sleep(400);
  const busCount = await cdp.evalJs('__kojoDebug.bus.recent(200).length');
  check('事件旁听有读数', Number(busCount) > 0, `${busCount} 条`);

  // ⑧ DOM 结构快照相位正确
  const snapPhase = await cdp.evalJs('__kojoDebug.dom.snapshot().phase');
  check('DOM 快照相位=project', snapPhase === 'project', String(snapPhase));

  // ⑨ 截图落盘（agent 的「眼睛」）
  const shot = await cdp.screenshot(false);
  const shotPath = path.join(WORK, 'smoke-final.png');
  await fsp.mkdir(WORK, { recursive: true });
  await fsp.writeFile(shotPath, shot);
  check('截图落盘', shot.length > 10000, `${shotPath}（${(shot.length / 1024).toFixed(0)} KB）`);

  // ⑩ 反哺回归（2026-10-25）：界面变了截图必须变——两拍之间开「问题」面板，
  //     字节相同＝captureScreenshot 吃了缓存帧（切主题 / Monaco 重绘同款病）
  const beforeShot = await cdp.screenshot(false);
  await cdp.evalJs(`__kojoDebug.commands.run('workbench.problems')`, 30000);
  await sleep(800);
  const afterShot = await cdp.screenshot(false);
  check(
    '截图不吃缓存帧（界面变化后字节不同）',
    beforeShot.length > 10000 && !beforeShot.equals(afterShot),
    `${beforeShot.length} B → ${afterShot.length} B`,
  );

  // ⑪ 性能探针（2026-10-25 卡顿体检批）：start → 开合面板制造交互 → stop 出报告，
  //     帧采样与报告结构必须就位（long-animation-frame 支持性如实回，不强求条目非空）
  await cdp.evalJs('__kojoDebug.perf.start()');
  await cdp.evalJs(`__kojoDebug.commands.run('workbench.problems')`, 30000);
  await sleep(1200);
  const probeReport = await cdp.evalJs(
    `(() => { try { return __kojoDebug.perf.stop(); } catch (e) { return { __err: String(e && e.message || e) }; } })()`,
    30000,
  );
  const probeOk =
    probeReport &&
    !probeReport.__err &&
    probeReport.kind === 'perf-probe' &&
    probeReport.frames.total > 5 &&
    typeof probeReport.frames.p50 === 'number' &&
    Array.isArray(probeReport.bySource) &&
    typeof probeReport.capabilities.longAnimationFrame === 'boolean';
  check(
    '性能探针可开关且出结构化报告',
    probeOk === true,
    probeOk
      ? `帧 ${probeReport.frames.total}（p50=${probeReport.frames.p50}ms max=${probeReport.frames.max}ms）· bySource ${probeReport.bySource.length} 项 · laf=${probeReport.capabilities.longAnimationFrame}`
      : JSON.stringify(probeReport).slice(0, 160),
  );
  if (KEEP) console.log(`[smoke] 截图保留：${shotPath}`);
} catch (err) {
  check('断言链中途失败', false, String(err?.message ?? err));
  // 失败取证：屏上是什么 + 一张截图——红要红得能定位，不是只留一句超时
  try {
    const bodyText = await cdp.evalJs('document.body ? document.body.innerText.slice(0, 500) : "(no body)"');
    console.error(`[smoke] 失败时屏上文本：${JSON.stringify(bodyText)}`);
    const shot = await cdp.screenshot(false);
    const failShot = path.join(WORK, 'smoke-fail.png');
    await fsp.mkdir(WORK, { recursive: true });
    await fsp.writeFile(failShot, shot);
    console.error(`[smoke] 失败截图：${failShot}（${(shot.length / 1024).toFixed(0)} KB）`);
  } catch (e2) {
    console.error(`[smoke] 连取证都没拿到：${String(e2?.message ?? e2)}`);
  }
}

cdp.close();
await shutdown(0);
