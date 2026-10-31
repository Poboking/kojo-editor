#!/usr/bin/env node
/**
 * Web 调试模式无头冒烟（2026-10-24 调试模式批）：不起桌面壳，只用
 * 「调试宿 + vite + 无头浏览器（CDP）」把编辑器完整跑一遍：
 *
 *   欢迎页渲染 → open-project（真实点击链路：目录对话框自动应答 → 写权限审批）→
 *   文件树在场 → open-file（真实点击）→ Monaco 挂载 → 命令注册表 → 事件旁听 →
 *   调试宿 invoke 直达 → DOM 结构快照 → 截图落盘。
 *
 * 语言面与检索镜像（2026-10-30 调试批）：Monaco 打开文件后按**当前文件**硬断言
 * `editor.actions()` / `tokens()` / `setSelection`+`info().selection` / `format()` /
 * `foldingRanges()`，并用 `search_text` 的 include globs 跑一遍 fixture —— 大小写按
 * Rust 口径**敏感**（fixture 只有 `.ERB`，写成全小写扩展名的 glob 必须一个都不回）。
 *
 * 语言面自检（2026-10-30 第二批）：`editor.selfCheck()` 硬断言 `ok === true`（hover/suggest
 * 靠 Monaco 私有 DOM 形态，升级即静默失效，红线由它兜），`hoverAt` / `suggestAt` 只钉
 * **不抛 + 返回形态**（该位置没内容属正常，不拿内容当契约）。
 *
 * 与 `smoke-tauri-dom.mjs` 的分工：那把刀验**桌面壳**（真 IPC / 真机右键），
 * 这把刀验**浏览器调试模式**（多 agent 无桌面壳时的体感 / UI / 功能验证通道）。
 * 样例工程 = `fixtures/mini-game` 复制进沙盒（可写域内，保存链路也能测）。
 *
 * CLI 能力对齐（2026-10-30 第二批末尾）：`wait` / `assert` / `close-project` /
 * `type --mode keys|ime` 是「回归脚本可编程断言」的家当，**页面侧测不到 CLI 这层**，
 * 所以这一段用 spawn **真起 CLI 子进程**（临时 session.json + KOJO_DEBUG_SESSION，
 * 跑完即收）。其中 assert 有一条**故意失败**的用例：闸的价值只在"该红时真红"，
 * 假绿在 CI 里永远不会自己暴露。类型腿读回模型正文**逐字**比对，专门钉"双写"回归。
 *
 * 分段化（2026-10-30 批次 3）：脚本按**已有的语义块**切成具名段，可按段执行。
 * 见下面「分段框架」那一大段注释里的为什么与纪律。
 *
 * 用法：node tools/debug-web-smoke.mjs [--keep] [--only <段名>[,<段名>...]]
 *       不给 --only 就是全跑（顺序、check 名称、退出码与分段化之前逐字一致）。
 * 前置：本机有 Chrome/Edge（KOJO_DEBUG_BROWSER 可指定）；vite 已安装（pnpm install 过）。
 * 退出码：0 全绿；1 有断言红；2 前置不满足（没浏览器 / vite 不在位）或参数不合法。
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

/* ------------------------------ 命令行参数 ------------------------------ */
/**
 * 只认 `--keep` 与 `--only`（以及 `--only=<段名>`）。**未知参数当场退出**：
 * 拼错的参数被静默吞掉时，脚本会"全绿"地跑了一遍你以为只跑某段的链路，
 * 这种钱花得最冤（10 分钟 + 一次假信号）。
 *
 * `--only` 的**值**在这里只做"有没有给"的判定，段名校验留给 resolvePlan——
 * 那时段名表才在（段定义在下面），报错信息才能带出完整可用段名。
 */
const ARGV = process.argv.slice(2);
const KEEP = ARGV.includes('--keep');
let onlyParts = null; // null = 没给 --only（全跑）；非 null = 给了（可能给空）
const unknownArgs = [];
for (let i = 0; i < ARGV.length; i++) {
  const a = ARGV[i];
  if (a === '--keep') continue;
  if (a === '--only') {
    onlyParts ??= [];
    const v = ARGV[i + 1];
    // 缺值 / 紧跟另一个开关：记一个空片段，交给 resolvePlan 报"需要段名"。
    // 不在这里退出，否则报错信息里没有可用段名清单。
    if (v === undefined || v.startsWith('-')) {
      onlyParts.push('');
    } else {
      onlyParts.push(v);
      i++;
    }
    continue;
  }
  if (a.startsWith('--only=')) {
    onlyParts ??= [];
    onlyParts.push(a.slice('--only='.length));
    continue;
  }
  unknownArgs.push(a);
}
if (unknownArgs.length) {
  console.error(`[smoke] 未知参数：${unknownArgs.join(' ')}`);
  console.error('[smoke] 用法：node tools/debug-web-smoke.mjs [--keep] [--only <段名>[,<段名>...]]');
  process.exit(2);
}
/** --only 的原始选择（未校验）；null = 全跑 */
const ONLY_RAW = onlyParts === null ? null : onlyParts.join(',');

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

/* ================================ 分段框架 ================================
 * 为什么分段：这份冒烟是"真 vite + 真浏览器 + 真调试宿"的端到端链，整跑 5~10 分钟。
 * 一整段线性 top-level await 意味着**加一条检查必须整跑**、改一处只能从头看结果——
 * 于是"补一条冒烟"的成本高到没人愿意补（这一批 11 条新子命令 + selfCheck 的
 * `semantic` 读数就这么一直没进冒烟）。切成具名段之后，`--only semantic` 只跑它
 * 依赖的 boot/project/editor/session，几十秒就能拿到结果。
 *
 * 三条纪律（硬要求）：
 * 1. **默认路径逐字不变**：不给 --only 时按**声明序**全跑，段序 = 原来 ⓪~⑫ 的顺序，
 *    每条 check 的名称与详情文案一个字都不改（有人靠现有输出判断回归）；
 *    新增的两段（pointer / semantic）只**追加在末尾**，不改动任何既有 check。
 * 2. **依赖显式声明**（每段 needs），不靠"声明序恰好对"：--only 时先对点名段做
 *    依赖闭包，再按声明序执行（声明序本身已满足依赖，默认跑不需要拓扑排序）。
 *    所以 `--only semantic` 会自己把 server/vite/浏览器/开工程/开文件带起来。
 * 3. **清理不许退化**：`shutdown` 仍是唯一出口——段内抛错、SIGINT、前置不满足、
 *    正常结束，四条路径都走到它；ctx 里没建起来的资源一律判空再用（`--only bogus`
 *    这种连 boot 都没跑的路径也必须能干净退出）。
 *
 * 段名用短横线小写；改段名 = 改对外接口（workflow 的 `only` 输入、人手敲的命令）。
 * ======================================================================= */
const SEGMENTS = [];
/** 注册一段。run(ctx) 里只做"这一段自己的事"，跨段共享的东西写在 ctx 上。 */
function seg(name, needs, run) {
  SEGMENTS.push({ name, needs, run });
}
/** 跨段共享的运行现场（server / vite / cdp / 沙盒路径 / CLI 助手……） */
const ctx = {};

/**
 * 把 `--only` 的选择解析成**按声明序排好的执行计划**。
 * 段名拼错 ⇒ 抛 UsageError（带全部可用段名），由 main 打印后 exit 2。
 */
class UsageError extends Error {}
function resolvePlan(onlyRaw) {
  if (onlyRaw === null) return SEGMENTS;
  const byName = new Map(SEGMENTS.map((s) => [s.name, s]));
  const wanted = onlyRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (wanted.length === 0) {
    throw new UsageError('--only 需要至少一个段名');
  }
  const closure = new Set();
  const visit = (name, stack) => {
    const s = byName.get(name);
    if (!s) throw new UsageError(`未知段名「${name}」`);
    if (closure.has(name)) return;
    if (stack.includes(name)) throw new UsageError(`段依赖成环：${[...stack, name].join(' → ')}`);
    stack.push(name);
    for (const dep of s.needs) visit(dep, stack);
    stack.pop();
    closure.add(name);
  };
  for (const n of wanted) visit(n, []);
  // 按声明序执行：声明序已满足依赖，且与默认路径的段序一致（跨段副作用顺序可预期）
  return SEGMENTS.filter((s) => closure.has(s.name));
}

/** 失败取证：屏上是什么 + 一张截图——红要红得能定位，不是只留一句超时 */
async function forensics() {
  try {
    const bodyText = await ctx.cdp.evalJs('document.body ? document.body.innerText.slice(0, 500) : "(no body)"');
    console.error(`[smoke] 失败时屏上文本：${JSON.stringify(bodyText)}`);
    const shot = await ctx.cdp.screenshot(false);
    const failShot = path.join(WORK, 'smoke-fail.png');
    await fsp.mkdir(WORK, { recursive: true });
    await fsp.writeFile(failShot, shot);
    console.error(`[smoke] 失败截图：${failShot}（${(shot.length / 1024).toFixed(0)} KB）`);
  } catch (e2) {
    console.error(`[smoke] 连取证都没拿到：${String(e2?.message ?? e2)}`);
  }
}

/* ------------------------------ boot：前置 + 起服务 + 页面就位 ------------------------------ */

seg('boot', [], async (c) => {
  /* ---- 前置 ---- */
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

  /* ---- 环境 ---- */
  await rmRetry(WORK);
  // 上轮锁死的目录不强求（唯一目录名已避开复用冲突）
  c.sandbox = path.join(WORK, 'sandbox');
  c.appdata = path.join(WORK, 'appdata');
  c.project = path.join(c.sandbox, 'mini-game');
  await fsp.cp(path.join(REPO, 'fixtures', 'mini-game'), c.project, { recursive: true });

  const server = await createDebugServer({ port: 0, sandbox: c.sandbox, appdata: c.appdata, log: () => {} });
  cleanupAll.push(() => server.close());
  c.server = server;
  console.log(`[smoke] 调试宿 :${server.port}`);

  c.vitePort = await freePort(4273);
  // `--host 127.0.0.1`（2026-10-26 修，PITFALLS 230 同族小坑）：vite 7 缺省只绑/只报 localhost
  // （Windows 上常仅解析 ::1），而下面的页面 URL 与本会话一切读数口径都写 127.0.0.1——
  // 不显式 --host 就是 ERR_CONNECTION_REFUSED 假红。与 debug-cli.mjs cmdServe 同口径，不动产品配置。
  const vite = spawn(process.execPath, [viteBin, '--port', String(c.vitePort), '--strictPort', '--host', '127.0.0.1'], {
    cwd: path.join(REPO, 'packages', 'app'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(vite);
  let viteLog = '';
  vite.stdout.on('data', (d) => (viteLog += d.toString()));
  vite.stderr.on('data', (d) => (viteLog += d.toString()));

  for (let i = 0; i < 120 && !(await portOpen(c.vitePort)); i++) await sleep(500);
  if (!(await portOpen(c.vitePort))) {
    console.error(`[smoke] vite 60s 没就绪：\n${viteLog.slice(-800)}`);
    await shutdown(1);
  }
  console.log(`[smoke] vite :${c.vitePort}`);

  c.cdpPort = await freePort(9533);
  const profile = path.join(WORK, 'browser-profile');
  fs.mkdirSync(profile, { recursive: true });
  c.url = `http://127.0.0.1:${c.vitePort}/?kojo-debug=${server.port}`;
  const browserProc = spawn(
    browser,
    [
      `--remote-debugging-port=${c.cdpPort}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-first-run',
      '--window-size=1600,900',
      c.url,
    ],
    { stdio: 'ignore' },
  );
  children.push(browserProc);
  for (let i = 0; i < 60 && !(await portOpen(c.cdpPort)); i++) await sleep(400);
  if (!(await portOpen(c.cdpPort))) {
    console.error('[smoke] 浏览器 CDP 30s 没就绪');
    await shutdown(1);
  }

  /* ---- 断言链的起点：拿页面 + 连线 + origin 钉 ---- */
  let page = null;
  for (let i = 0; i < 30 && !page; i++) {
    page = await cdpPage(c.cdpPort, c.vitePort).catch(() => null);
    if (!page) await sleep(500);
  }
  if (!page) {
    console.error('[smoke] CDP 页面拿不到');
    await shutdown(1);
  }
  c.page = page;
  c.cdp = await new Cdp(page.webSocketDebuggerUrl).connect();
  const cdp = c.cdp;
  console.log(`[smoke] 页面：${page.url}`);

  // ⓪ origin 钉（2026-10-26，PITFALLS 230 同族假绿/假红闸，与 smoke-tauri-ipc 同口径）：
  //    先等导航落定（刚挂上时文档还是 about:blank，直接问 origin 会假红——实测），
  //    再要求页面 origin **逐字等于我们自己的 127.0.0.1 vite**：端口上若坐着别的树
  //    （localhost/::1 漂址或同口他树 dev server），这里带 href 当场红，绝不吃假绿。
  await waitFor(cdp, `location.href !== 'about:blank'`, { timeoutMs: 30000, label: '页面导航落定（离开 about:blank）' });
  const pageHref = await assertPageOrigin(cdp, `http://127.0.0.1:${c.vitePort}`);
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
});

/* ------------------------------ project：对话 SDK 面 + 开工程 ------------------------------ */

seg('project', ['boot'], async (c) => {
  const { cdp, server, project, sandbox } = c;

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
});

/* ------------------------------ editor：文件树 → 开文件 → Monaco → 二进制直传 ------------------------------ */

seg('editor', ['project'], async (c) => {
  const { cdp } = c;

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
  c.info = info;
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
});

/* ------------------------------ language：语言面只读 API + 检索镜像 + 自检 ------------------------------ */

seg('language', ['editor'], async (c) => {
  const { cdp, project } = c;

  // ⑤c 语言面只读 API（2026-10-30 调试批 §3）：全部读**当前打开的这份文件**。
  //     先确认焦点编辑器还在（`info()` 可能为 null —— 面板切换 / 重挂载都会让它空一拍），
  //     拿到再断言；所有读数都随失败信息一起打印，红了能直接看出是"没实现"还是"读歪了"。
  const edLive = await waitFor(cdp, 'window.__kojoDebug.editor.info()', { timeoutMs: 15000, label: '焦点编辑器 info()' });
  const curFile = String(edLive?.path ?? '');
  const evalInPage = async (expr, timeoutMs = 60000) =>
    await cdp.evalJs(`(() => { try { return ${expr}; } catch (e) { return { __err: String((e && e.message) || e) }; } })()`, timeoutMs);

  const actRes = await evalInPage(`(() => {
    const a = __kojoDebug.editor.actions();
    if (!Array.isArray(a)) return { __err: 'actions() 不是数组：' + JSON.stringify(a) };
    const bad = a.filter((x) => !x || typeof x.id !== 'string' || x.id === '' || typeof x.label !== 'string' || x.label === '');
    return { count: a.length, bad: bad.length, badSample: bad.slice(0, 3), sample: a.slice(0, 4).map((x) => x.id) };
  })()`);
  check(
    'editor.actions() ≥20 条且每项有 id/label',
    !actRes?.__err && Number(actRes?.count) >= 20 && actRes?.bad === 0,
    actRes?.__err ?? `文件=${path.basename(curFile)} · ${actRes?.count} 条 · 缺 id/label ${actRes?.bad} 条 · 例：${(actRes?.sample ?? []).join(' / ')}`,
  );

  const tokRes = await evalInPage(`__kojoDebug.editor.tokens(1, 5)`);
  const tokRows = Array.isArray(tokRes) ? tokRes : null;
  const tokBad =
    !tokRows ||
    tokRows.length === 0 ||
    tokRows.some((r, i) => !r || r.line !== i + 1 || !Array.isArray(r.tokens)) ||
    !tokRows[0] ||
    tokRows[0].line !== 1;
  check(
    'editor.tokens(1,5) 回数组且行号从 1 连续',
    !tokBad && Array.isArray(tokRes),
    tokBad
      ? `实际=${JSON.stringify(tokRes).slice(0, 200)}`
      : `${tokRows.length} 行 · 行号 ${tokRows.map((r) => r.line).join(',')} · token 数 ${tokRows.reduce((n, r) => n + r.tokens.length, 0)}`,
  );

  const setSel = await evalInPage(`__kojoDebug.editor.setSelection(1, 1, 1, 3)`);
  const selInfo = await evalInPage(`(() => { const i = __kojoDebug.editor.info(); return i ? { path: i.path, selection: i.selection } : null; })()`);
  const selText = typeof selInfo?.selection === 'string' ? selInfo.selection : null;
  check(
    'editor.setSelection(1,1,1,3) 生效且 info().selection 长 2',
    setSel === true && selText !== null && selText.length === 2,
    `setSelection=${JSON.stringify(setSel)} · selection=${JSON.stringify(selInfo?.selection)}${selInfo?.__err ? ` · ${selInfo.__err}` : ''} · 文件=${path.basename(curFile)}`,
  );

  const fmtRes = await evalInPage(`__kojoDebug.editor.format()`, 90000);
  const fmtOk =
    !!fmtRes &&
    !fmtRes.__err &&
    fmtRes.ok === true &&
    typeof fmtRes.changed === 'boolean' &&
    typeof fmtRes.before === 'number' &&
    typeof fmtRes.after === 'number' &&
    typeof fmtRes.elapsedMs === 'number';
  check(
    'editor.format() 回结构化结果且 ok=true',
    fmtOk,
    fmtOk
      ? `文件=${path.basename(curFile)} · changed=${fmtRes.changed} · ${fmtRes.before}→${fmtRes.after} 字符 · ${fmtRes.elapsedMs}ms`
      : JSON.stringify(fmtRes).slice(0, 240),
  );

  const foldRes = await evalInPage(`__kojoDebug.editor.foldingRanges()`);
  const foldShapeOk =
    !foldRes?.__err &&
    (foldRes === null || Array.isArray(foldRes)) &&
    (!Array.isArray(foldRes) ||
      foldRes.every((r) => r && typeof r.startLine === 'number' && typeof r.endLine === 'number' && typeof r.kind === 'string'));
  check(
    'editor.foldingRanges() 回数组或 null（形态合规、不抛）',
    foldShapeOk,
    foldShapeOk
      ? `文件=${path.basename(curFile)} · ${foldRes === null ? 'null（本版本拿不到折叠模型，如实回）' : `${foldRes.length} 段${foldRes.length ? ` · 首段 ${JSON.stringify(foldRes[0])}` : ''}`}`
      : JSON.stringify(foldRes).slice(0, 240),
  );

  // ⑤d search_text 的 include globs 镜像（2026-10-30 调试批 §1.4）：Rust 口径
  //     **大小写敏感**，且只匹配相对检索根的 `/` 形态路径。fixture 里真实扩展名是
  //     大写 `.ERB`（3 个）+ `.csv`（4 个）——大写 glob 必须正好收回 ERB，
  //     小写 glob 必须一个都不回（挡不住 `.ERB`）。只回传瘦身后的读数，免得几千条
  //     命中把 CDP 消息撑大。
  const runGlobSearch = async (searchId, globs) =>
    await evalInPage(
      `(async () => {
        const r = await __kojoDebug.invoke('search_text', { request: {
          searchId: ${searchId},
          roots: [${JSON.stringify(project)}],
          query: '.',
          options: { isRegex: true, caseSensitive: false, wholeWord: false, extensions: [], globs: ${JSON.stringify(globs)}, maxResults: 5000 },
        } });
        return {
          paths: (r && r.files ? r.files : []).map((f) => String(f.path).replace(/\\\\/g, '/')),
          totalMatches: r && r.totalMatches,
          scanned: r && r.filesScanned,
          filtered: r && r.skipped ? r.skipped.filtered : null,
          excluded: r && r.skipped ? r.skipped.excluded : null,
          truncated: !!(r && r.truncated),
        };
      })()`,
      120000,
    );
  const globUpper = await runGlobSearch(9001, ['**/*.ERB']);
  const upperPaths = Array.isArray(globUpper?.paths) ? globUpper.paths : [];
  const upperLeak = upperPaths.filter((p) => !p.endsWith('.ERB'));
  check(
    'search_text include globs（**/*.ERB）非空且只回 .ERB',
    !globUpper?.__err && upperPaths.length >= 1 && upperLeak.length === 0,
    globUpper?.__err ??
      `${upperPaths.length} 文件 · 命中 ${globUpper.totalMatches} 处 · 扫描 ${globUpper.scanned} · filtered=${globUpper.filtered} · excluded=${globUpper.excluded} · ${upperPaths.map((p) => p.split('/').pop()).join(', ')}${upperLeak.length ? ` · 越界：${upperLeak.join(', ')}` : ''}`,
  );
  const globLower = await runGlobSearch(9002, ['**/*.erb']);
  const lowerPaths = Array.isArray(globLower?.paths) ? globLower.paths : [];
  check(
    'search_text include globs 大小写敏感（**/*.erb 挡不住 .ERB）',
    !globLower?.__err && lowerPaths.length === 0 && Number(globLower?.filtered) >= 1,
    globLower?.__err ??
      `${lowerPaths.length} 文件（应为 0）· filtered=${globLower.filtered}（≥1 才证明 glob 真编译并使上了，不是被忽略）· 扫描 ${globLower.scanned} · 越界示例：${lowerPaths.slice(0, 3).join(', ') || '无'}`,
  );

  // ⑤e 语言面自检（2026-10-30 第二批 §3.1）：hover/suggest 依赖 Monaco 私有 DOM 形态，
  //     Monaco 一升级就是**静默失效**（不报错、只是永远读不到）。selfCheck() 是"这套选择器
  //     在当前构建还成不成立"的唯一读数，所以这里**硬断言 ok===true**——不许"API 不在就跳过"，
  //     缺 API 本身就是契约没落地，红得对。失败信息把每一项摊开，红了一眼看出是哪条腿断。
  const selfRes = await evalInPage(
    `(async () => {
      const ed = __kojoDebug.editor;
      if (typeof ed.selfCheck !== 'function') return { __missing: 'editor.selfCheck 不是函数：' + typeof ed.selfCheck };
      const r = await ed.selfCheck();
      const s = r && r.selectors;
      return {
        monacoVersion: r ? r.monacoVersion : '__noReturn',
        languageId: r ? r.languageId : undefined,
        selectors: s ? {
          hover: s.hover, suggest: s.suggest, suggestRow: s.suggestRow,
          labelName: s.labelName, detailsLabel: s.detailsLabel,
          foldingContribution: s.foldingContribution,
        } : null,
        foldingShape: r ? r.foldingShape : undefined,
        ok: r ? r.ok : undefined,
      };
    })()`,
    30000,
  );
  const selfSel = selfRes?.selectors;
  const selKeys = ['hover', 'suggest', 'suggestRow', 'labelName', 'detailsLabel', 'foldingContribution'];
  const selShapeOk =
    !!selfSel && typeof selfSel === 'object' && selKeys.every((k) => typeof selfSel[k] === 'boolean');
  const foldingShapeOk =
    selfRes?.foldingShape === 'regions' ||
    selfRes?.foldingShape === 'ranges' ||
    selfRes?.foldingShape === 'promise' ||
    selfRes?.foldingShape === 'none';
  const selfOk =
    !selfRes?.__err &&
    !selfRes?.__missing &&
    (selfRes?.monacoVersion === null || typeof selfRes?.monacoVersion === 'string') &&
    (selfRes?.languageId === null || typeof selfRes?.languageId === 'string') &&
    selShapeOk &&
    foldingShapeOk &&
    selfRes?.ok === true;
  check(
    'editor.selfCheck() 形状合规且 ok===true',
    selfOk === true,
    selfRes?.__err ||
      selfRes?.__missing ||
      `monacoVersion=${JSON.stringify(selfRes?.monacoVersion)} · languageId=${JSON.stringify(selfRes?.languageId)} · ok=${JSON.stringify(selfRes?.ok)} · foldingShape=${JSON.stringify(selfRes?.foldingShape)} · selectors=${
        selShapeOk ? selKeys.map((k) => `${k}=${selfSel[k]}`).join(',') : JSON.stringify(selfSel)
      }`,
  );

  // ⑤f hoverAt / suggestAt 不抛（同批 §3.2/§3.3）：这两条只钉**形态与不抛**，不钉"必须有内容"——
  //     fixture 的 (1,1) 未必有 hover / 补全候选，硬要求非空就是拿内容当契约。
  //     注意：两者都会移动光标并抢焦点，所以放在语言面读数之后、截图判据之前，
  //     后面「截图不吃缓存帧」比的是两拍相对差，光标位置对两拍一视同仁。
  const hovRes = await evalInPage(
    `(async () => {
      const r = await __kojoDebug.editor.hoverAt(1, 1, { timeoutMs: 1500 });
      if (r === null) return { kind: 'null' };
      return { kind: 'object', textType: typeof r.text, text: r.text, rowsIsArray: Array.isArray(r.rows), rows: r.rows, keys: Object.keys(r) };
    })()`,
    30000,
  );
  const hovOk =
    !hovRes?.__err &&
    (hovRes?.kind === 'null' ||
      (hovRes?.kind === 'object' &&
        hovRes?.textType === 'string' &&
        hovRes?.rowsIsArray === true &&
        Array.isArray(hovRes?.rows) &&
        hovRes.rows.every((x) => typeof x === 'string')));
  check(
    'editor.hoverAt(1,1,{timeoutMs:1500}) 不抛，回 null 或 {text:string, rows:array}',
    hovOk === true,
    hovRes?.__err ||
      (hovRes?.kind === 'null'
        ? 'null（该位置无 hover，如实回）'
        : `text=${JSON.stringify(String(hovRes?.text ?? '').slice(0, 60))} · rows=${Array.isArray(hovRes?.rows) ? hovRes.rows.length : JSON.stringify(hovRes?.rows)} 行 · keys=${(hovRes?.keys ?? []).join(',')}`),
  );

  const sugRes = await evalInPage(
    `(async () => {
      const r = await __kojoDebug.editor.suggestAt(1, 1, { timeoutMs: 1500 });
      return {
        keys: r && typeof r === 'object' ? Object.keys(r) : null,
        itemsIsArray: Array.isArray(r && r.items),
        itemsLen: Array.isArray(r && r.items) ? r.items.length : -1,
        countType: typeof (r && r.count),
        count: r && r.count,
        sample: Array.isArray(r && r.items) ? r.items.slice(0, 3) : null,
      };
    })()`,
    30000,
  );
  const sugOk =
    !sugRes?.__err &&
    sugRes?.itemsIsArray === true &&
    sugRes?.countType === 'number' &&
    Number.isFinite(sugRes?.count) &&
    sugRes.count >= 0 &&
    // 如实口径：limit 会切 items，所以 count 是命中总数，允许 >= items.length
    (sugRes.count === sugRes.itemsLen || sugRes.count >= sugRes.itemsLen) &&
    sugRes.itemsLen >= 0;
  check(
    'editor.suggestAt(1,1,{timeoutMs:1500}) 不抛，{items:Array, count:number} 且计数自洽',
    sugOk === true,
    sugRes?.__err ||
      `count=${JSON.stringify(sugRes?.count)} · items.length=${sugRes?.itemsLen} · 自洽=${sugRes?.count >= sugRes?.itemsLen} · keys=${(sugRes?.keys ?? []).join(',')} · 例：${JSON.stringify((sugRes?.sample ?? []).map((x) => (x && (x.label ?? x.insertText)) || x)).slice(0, 120)}`,
  );
});

/* ------------------------------ ui：命令表 / 事件 / DOM 快照 / 截图 ------------------------------ */

seg('ui', ['project'], async (c) => {
  const { cdp } = c;

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
  c.shotPath = shotPath;
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
});

/* ------------------------------ perf：性能探针 ------------------------------ */

seg('perf', ['project'], async (c) => {
  const { cdp } = c;
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
});

/* ============ session：CLI 子进程的会话接线（无 check，纯脚手架） ============
 * 为什么单独成段而不是塞进 cli 段：`pointer` / `semantic` 两段也要真起 CLI 子进程，
 * 但它们**不该**为了拿一个 runCli 而把 cli 段（wait/assert/close-project/type，分钟级）
 * 全部拖进来——否则 `--only semantic` 一点也省不下来。所以"写 session.json + 造
 * runCli/waitForExpr"独立成一段，谁需要谁声明 needs: ['session']。
 *
 * 会话文件：CLI 靠 session.json 找会话，而冒烟自己就是一套现成会话——把端口写进一份
 * 临时 session.json，用 KOJO_DEBUG_SESSION 指过去，CLI 就把它当成 serve 起的那套用。
 * **刻意不写 token**：调试宿没带 --token 时鉴权闸本来就不生效（debug-server 头注口径），
 * 把口令写进文件反而多一处落盘面。
 * ======================================================================= */
seg('session', ['boot'], async (c) => {
  const { server, sandbox, appdata, vitePort, cdpPort, url } = c;
  c.cliBin = path.join(REPO, 'tools', 'debug-cli.mjs');
  c.cliSessionFile = path.join(WORK, 'session.json');
  await fsp.writeFile(
    c.cliSessionFile,
    JSON.stringify(
      {
        mode: 'web',
        sessionId: `web-smoke-${process.pid}`,
        repoRoot: REPO,
        sandbox,
        appdata,
        readonly: [],
        serverPort: server.port,
        vitePort,
        cdpPort,
        url,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf-8',
  );

  // 用**异步** spawn 而不是 spawnSync：调试宿跑在本进程里，open-project 这条腿需要 CLI
  // 反向打 POST /policy —— spawnSync 会把本进程的事件循环钉住，宿应答不了，CLI 三秒后
  // 以「登记目录应答失败：The operation was aborted due to timeout」红（本轮实测踩到）。
  // 异步等 exit 即可：子进程自己收，超时一律强杀，不留长驻。
  c.runCli = (argv, timeoutMs = 180000) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [c.cliBin, ...argv], {
        cwd: REPO,
        env: { ...process.env, KOJO_DEBUG_SESSION: c.cliSessionFile },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let err = '';
      let timedOut = false;
      // 登记进 children：await 正常路径下它自己会收，但 SIGINT / 抛错的收尾路径上
      // 也得被 shutdown 一并 taskkill —— "跑完必须把子进程收干净"没有例外分支。
      children.push(child);
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (err += d.toString()));
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch {}
      }, timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        const at = children.indexOf(child);
        if (at >= 0) children.splice(at, 1);
        const tail = `${out}${err}`.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ⏎ ').slice(0, 300);
        // 超时/被杀的 code 是 null —— 判定一律按 "!== 0" 写，别拿它做数值比较
        resolve({ code: timedOut ? null : code, out, err, tail, timedOut });
      });
    });

  /** 页内轮询到 truthy（与 cmdWait 同口径：200ms 一拍），**带回真值**而不是只回 true */
  c.waitForExpr = async (expr, { timeoutMs = 30000, label = '' } = {}) => {
    const t0 = Date.now();
    let last = '';
    for (;;) {
      let v;
      try {
        v = await c.cdp.evalJs(expr, 10000);
      } catch (err) {
        v = null;
        last = `求值抛错：${String(err?.message ?? err).slice(0, 160)}`;
      }
      if (v) return { value: v, elapsedMs: Date.now() - t0 };
      if (v !== undefined && last === '') last = JSON.stringify(v) ?? String(v);
      if (Date.now() - t0 >= timeoutMs) {
        throw new Error(`wait 超时（${timeoutMs}ms）：${label || expr}；最后读到：${last}`);
      }
      await sleep(200);
    }
  };
});

/* ============ cli：wait / assert / close-project / type（2026-10-30 第二批） ============
 * 这一批给 debug-cli 加了 `wait` / `assert` / `close-project` / `type --mode keys|ime`，
 * 它们是「回归脚本可编程断言」的全部家当。**只测页面（__kojoDebug）测不到 CLI 这一层**：
 * 参数分发、退出码、文案、键盘帧构造全在 CLI 里，所以这里**真起 CLI 子进程**
 * （spawn：异步等 exit，跑完即收，不留长驻）。
 * ==================================================================================== */
seg('cli', ['session', 'editor'], async (c) => {
  const { cdp, sandbox } = c;
  const runCli = c.runCli;
  const waitForExpr = c.waitForExpr;

  // ⑫a wait：等一个页内表达式为真，且**返回体里有真实读数**。
  //     判据不是"走到下一行了"，而是返回体带模型身份与体量（path/行数/字符数）——
  //     只回 true 的 wait 分不清"真就绪"和"某个空壳对象恰好 truthy"。
  const modelReady = await waitForExpr(
    `(() => {
      const i = __kojoDebug.editor.info();
      if (!i || !i.path || !(i.lineCount > 0) || !(i.value.length > 0)) return null;
      return { path: i.path, languageId: i.languageId, lineCount: i.lineCount, chars: i.value.length };
    })()`,
    { timeoutMs: 20000, label: '编辑器模型就绪（editor.info() 有正文）' },
  );
  const mr = modelReady.value;
  check(
    'wait 等到模型就绪且带回真实读数（path/行数/字符数）',
    !!mr && typeof mr.path === 'string' && mr.path !== '' && Number(mr.lineCount) > 0 && Number(mr.chars) > 0,
    `${modelReady.elapsedMs}ms · ${path.basename(String(mr?.path ?? '?'))} · 行数=${mr?.lineCount} · 字符=${mr?.chars} · 语言=${mr?.languageId}`,
  );

  // ⑫b assert：CLI 的断言闸 = 退出码 + 文案，两条都要跑。
  //     ① 会通过的一条：证明正常路径不误报红（否则闸没人敢挂）。
  //     ② **故意失败的一条**——为什么必须故意红一次：闸的全部价值在于"该红时真的红"。
  //        assert 是回归脚本唯一的可读断言入口，如果表达式 falsy 时它照样 exit 0（或者
  //        文案里不肯带出断言原文），所有挂它的闸都是**假绿**，而假绿在 CI 里永远不会自己
  //        暴露出来。这里断的不是"表达式为假"，而是**闸的反应**：退出码必须非 0，且正好是 1
  //        （2 的语义是"前置不满足"，混进来等于闸在说自己环境坏了）；文案必须逐字带出那条
  //        断言原文，让人一眼知道挂的是哪条。
  const PASS_EXPR = `__kojoDebug.state().phase === 'project'`;
  const passRes = await runCli(['assert', PASS_EXPR], 60000);
  check(
    'assert 通过用例：exit 0 且回「断言成立」',
    passRes.code === 0 && passRes.out.includes('[ok] 断言成立'),
    `exit=${passRes.code} · ${passRes.tail}`,
  );
  const FAIL_EXPR = `__kojoDebug.state().phase === 'never-a-real-phase'`;
  const failRes = await runCli(['assert', FAIL_EXPR], 60000);
  const failSaidExpr = failRes.err.includes(FAIL_EXPR) || failRes.out.includes(FAIL_EXPR);
  check(
    'assert 故意失败：非 0 退出且文案逐字点出断言原文（闸会红）',
    failRes.code === 1 && failSaidExpr,
    `exit=${failRes.code}（期望 1）· 原文在场=${failSaidExpr} · ${failRes.tail}`,
  );

  // ⑫c close-project → 无工程相位 → 再开第二个工程（fixtures/mini-game 的副本）。
  //     换工程是"看起来切了、其实还挂在旧根"的高发地（PITFALLS 230 同族假绿），所以判据是
  //     「相位回 welcome + rootDir 复位 + 文件树消失」三样齐全，再要求新根**逐字**等于副本。
  //
  //     关之前先收脏：⑤c 的 format() 可能真改了正文 ⇒ dirtyPaths>0 ⇒ workbench.closeProject
  //     会先弹「有未保存的修改」确认框（App.requestCloseProject 的既有行为），CLI 只会干等到
  //     超时红。这里走真人路径先「全部保存」（沙盒可写、保存链路本来就该被覆盖），并等
  //     .tab-dirty 清零；清不掉就把读数带进详情里如实红。
  const dirtyBefore = await cdp.evalJs('!!document.querySelector(".tab-dirty")');
  let dirtyCleared = !dirtyBefore;
  if (dirtyBefore) {
    await cdp.evalJs(`__kojoDebug.commands.run('workbench.saveAll')`, 60000);
    dirtyCleared = !!(await waitForExpr('!document.querySelector(".tab-dirty")', {
      timeoutMs: 15000,
      label: '全部保存后脏标记清零',
    }));
  }
  const closeRes = await runCli(['close-project'], 90000);
  let stateAfterClose = null;
  try {
    await waitForExpr(`__kojoDebug.state().phase === 'welcome' ? 'welcome' : null`, {
      timeoutMs: 25000,
      label: '关闭项目后回到 welcome 相位',
    });
  } catch {
    // 不在这里红：下面一次读三样读数，红的时候能直接看出是"相位没退"还是"根没清"
  }
  stateAfterClose = await cdp.evalJs(`({
    phase: __kojoDebug.state().phase,
    rootDir: (__kojoDebug.state().project ?? {}).rootDir ?? null,
    tree: !!document.querySelector('.file-tree'),
  })`);
  check(
    'close-project 回到「无工程」相位（相位/根/文件树三样都复位）',
    closeRes.code === 0 &&
      dirtyCleared &&
      stateAfterClose?.phase === 'welcome' &&
      !stateAfterClose?.rootDir &&
      stateAfterClose?.tree === false,
    `exit=${closeRes.code} · 脏=${dirtyBefore ? `先全部保存，清零=${dirtyCleared}` : '无'} · 相位=${stateAfterClose?.phase} · rootDir=${JSON.stringify(stateAfterClose?.rootDir)} · 树=${stateAfterClose?.tree} · ${closeRes.tail}`,
  );

  const norm = (p) => {
    const s = String(p ?? '').replace(/\\/g, '/');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  const project2 = path.join(sandbox, 'mini-game-2');
  await fsp.cp(path.join(REPO, 'fixtures', 'mini-game'), project2, { recursive: true });
  const open2Res = await runCli(['open-project', project2, '--writable'], 180000);
  let root2 = null;
  try {
    root2 = (
      await waitForExpr(
        `(() => { const r = (__kojoDebug.state().project ?? {}).rootDir ?? ''; return r ? r : null; })()`,
        { timeoutMs: 60000, label: '第二个工程的 project.rootDir' },
      )
    ).value;
  } catch {
    // 同上：把读数交给下面的 check 一次性判红
  }
  check(
    'close-project 之后能开第二个工程（rootDir 逐字等于副本）',
    open2Res.code === 0 && root2 !== null && norm(root2) === norm(project2),
    `exit=${open2Res.code} · rootDir=${String(root2)} · 期望=${norm(project2)} · ${open2Res.tail}`,
  );

  // 树是重挂的：展开账本（__kojoDebugTreeClicks）按行标题记，跨工程复用会把新树的同名行
  // 全判成"点过了"⇒ expandTreeUntilFile 直接回 no-rows（假阴性）。换工程就清一次账。
  await cdp.evalJs('delete globalThis.__kojoDebugTreeClicks');
  await waitFor(cdp, '!!document.querySelector(".file-tree")', { timeoutMs: 60000, label: '第二个工程的文件树' });
  const expanded2 = await expandTreeUntilFile(cdp);
  const opened2 = await cdp.evalJs(`(() => {
    const row = [...document.querySelectorAll('.tree-file')][0];
    if (!row) return null;
    row.scrollIntoView({ block: 'center' });
    row.click();
    return row.getAttribute('title') || row.textContent;
  })()`);
  await waitFor(cdp, '!!document.querySelector(".monaco-editor")', { timeoutMs: 30000, label: '第二个工程的 Monaco' });
  await sleep(600);
  check(
    '第二个工程文件树可展开且能点开文件',
    expanded2 === 'file' && !!opened2,
    `expand=${expanded2} · ${path.basename(String(opened2 ?? '?'))}`,
  );

  // ⑫d type --mode keys / ime（防"双写"回归）。
  //     keys 腿逐字符走 keyDown → char → keyUp，**text 只挂在 char 帧上**；有人"顺手"给
  //     keyDown 也带上 text 时，CDP 会自己插一次、char 再插一次 ⇒ 每个字符翻倍（实测
  //     `.tree-filter` 里 "c1" 变 "cc11"，见 debug-cli cmdType 里那段注释）。
  //     ime 腿同理：imeSetComposition 起组合 + insertText 上屏，组合内容若直接落进目标
  //     就是同一类双写。
  //
  //     ⚠ 为什么**打在树过滤框而不是编辑器模型**（2026-10-30 实测，会复发的边界）：
  //     Monaco 0.57 在支持 EditContext 的浏览器上把输入面换成了 `div.native-edit-context`
  //     （探针：inputarea=false / editContext=true / imeTextArea=true）。CDP 合成输入
  //     进不去这个面——本轮逐项实测（每项都先确认 activeElement 就是那个 div）：
  //       · Input.insertText           396→396 字符（不动）
  //       · char 单帧                   396→396
  //       · keyDown+char+keyUp          396→396
  //       · imeSetComposition(+insert)  396→396
  //       · keyDown 直接带 text         396→396
  //     对照组证明不是"整个环境不聚焦"：同样无头、同样焦点仿真下，普通 `<input>`
  //     （`.tree-filter`）吃 insertText 一吃一个准；而且 **键位是通的**——Ctrl+F 能打开
  //     Monaco 的查找框（说明 keydown 真到了编辑器，只是文本不走 textupdate）。
  //     ⇒ 模型内容级验证在本宿主拿到的是"永远不动"，那是**假红**，不是回归信号；
  //     而双写回归发生在 cmdType 的**帧构造**里，同一条 CLI 代码路径打普通输入框同样能抓。
  //     待 Monaco 关掉 EditContext（或改用有头宿主）后再把这条腿搬回模型正文。
  //
  //     前置两条（缺一条都会把"打不进去"误判成 CLI 的 bug，本轮都踩过）：
  //     ① open-project 的「写权限确认」框有竞态：文件树先出来时 CLI 的「弹窗/树」轮询会
  //        先命中树，确认框就留在屏上盖住编辑器（点击全落在 .modal 上）。
  //     ② 无头宿主必须开**焦点仿真**（Puppeteer 默认就开）：不开时页面报 hasFocus=true，
  //        但 Chromium 会把 CDP 文本注入丢掉——普通 input 的 value 也是空的；开了立刻正常。
  const stuckModal = await cdp.evalJs(
    `(() => { const m = document.querySelector('.modal'); return m ? m.getAttribute('aria-label') : null; })()`,
  );
  if (stuckModal) {
    await cdpClick(cdp, stuckModal === '写权限确认' ? '.modal .primary' : '.modal .ghost');
    await waitFor(cdp, `!document.querySelector('.modal')`, { timeoutMs: 10000, label: '残留弹窗关闭' });
  }
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Page.bringToFront').catch(() => {});
  const editorSurface = await cdp.evalJs(`(() => {
    const q = (s) => !!document.querySelector(s);
    return {
      inputarea: q('.monaco-editor textarea.inputarea'),
      editContext: q('.monaco-editor .native-edit-context'),
      imeTextArea: q('.monaco-editor .ime-text-area'),
    };
  })()`);

  const TARGET_SEL = '.tree-filter';
  const readTarget = async () => await cdp.evalJs(`document.querySelector('.tree-filter')?.value ?? null`);
  /**
   * 逐字判（落点无关）：把 expected 从 after 里抠掉必须**逐字**还原成 before，且
   * 长度正好 +n、只出现一次、不是"每个字符两遍"。includes 抓不住"打进去两遍"。
   */
  const judgeTyped = (before, after, expected) => {
    const at = after.indexOf(expected);
    return {
      lenOk: after.length === before.length + expected.length,
      roundTrip: at >= 0 && after.slice(0, at) + after.slice(at + expected.length) === before,
      occurrences: after.split(expected).length - 1,
      doubled: after.includes([...expected].map((c) => c + c).join('')),
      at,
      around: at >= 0 ? after.slice(Math.max(0, at - 6), at + expected.length + 6) : after.slice(0, 40),
    };
  };
  /** 一条 type 用例：真跑 CLI（选择器形式）→ 读回目标值 → 逐字判 */
  const typeCase = async (label, mode, text) => {
    const before = String((await readTarget()) ?? '');
    const res = await runCli(['type', TARGET_SEL, text, '--mode', mode], 60000);
    const after = String((await readTarget()) ?? '');
    const j = judgeTyped(before, after, text);
    const active = await cdp.evalJs(
      `(() => { const a = document.activeElement; return a ? a.tagName + '.' + String(a.className || '').slice(0, 30) : null; })()`,
    );
    check(
      label,
      res.code === 0 && j.lenOk && j.roundTrip && j.occurrences === 1 && !j.doubled,
      res.code !== 0
        ? `exit=${res.code} · ${res.tail}`
        : `${TARGET_SEL} · ${before.length}→${after.length} 字符（应 +${text.length}）· 抠回原文=${j.roundTrip} · 命中次数=${j.occurrences} · 双写=${j.doubled} · 落点@${j.at} · 片段=${JSON.stringify(j.around)} · 焦点=${active} · 编辑器输入面=${editorSurface?.editContext ? 'EditContext（文本注入不可用，见注）' : 'legacy'}`,
    );
  };

  const KEY_TEXT = 'kojo-keys-42';
  await typeCase('type --mode keys 逐字落到输入框（无双写 / 无丢字）', 'keys', KEY_TEXT);

  // ime 用中文：ASCII 在 ime 腿里和 insertText 直插难以区分，"组合→上屏"的真实路径只有
  // 非 ASCII 才逼得出来。
  const IME_TEXT = '中文上屏';
  await typeCase('type --mode ime 组合→上屏只落一份（无双写）', 'ime', IME_TEXT);

  if (KEEP) console.log(`[smoke] 截图保留：${c.shotPath}`);
});

/* ============ pointer：UI 层真鼠标（2026-10-30 批次 3 新 CLI 的 hover/dblclick/drag/wheel） ============
 * 为什么单独成段：这四条验的是**指针原语本身**（选择器→中心点、elementFromPoint 自证、
 * 拖拽中间帧、滚轮落点），与语义族（definition/references/...）是两条独立的失败面。
 * 混在一段里，红了分不清是"鼠标打不进去"还是"语言服务没货"。
 *
 * 为什么**不断言"悬停面板出现了"**（docs/PITFALLS.md 第 247 条）：
 * `Input.dispatchMouseEvent` 打不进 Monaco 的 hover 时序——hover 面板由 Monaco 自己的
 * 位置模型 + 私有 DOM（`.monaco-hover`）驱动，合成鼠标事件到得了页面、到不了那条链，
 * 于是"面板没出现"是**环境事实**而不是回归信号。拿它当断言就是一条永远红的假红，
 * 而假红会推着人去改产品。所以这里只钉两件真能钉住的事：
 *   ① 命令退出码为 0 —— 会话读取、选择器解析、CDP 派发、读数回收整条链是通的；
 *   ② 输出里有**落点读数** —— 这一步已经吃掉了"选择器找不到"（resolvePoint 直接抛）
 *      和"被遮挡"（elementFromPoint 未命中会告警）两种失败，剩下的就是"事件真送到了"。
 * "面板弹没弹"留给有头宿主（桌面壳 / smoke-tauri-dom）那两条腿。
 * ============================================================================================ */
seg('pointer', ['session', 'editor'], async (c) => {
  const { cdp } = c;
  const runCli = c.runCli;
  // 目标选 `.monaco-editor`：默认路径里跑到这一段时，`.tree-filter` 已经被 ⑫d 打上了过滤词，
  // 树里可能一行 `.tree-file` 都不剩；编辑器容器则一定在（editor 段已硬断言）。
  // 事件落在编辑器上还有一个好处：press-drag-release 在 Monaco 里只是"选一段字"，
  // 不改文档、不开面板，不会给后面的 semantic 段留副作用。
  const TARGET = '.monaco-editor';
  /** 落点读数：hover/dblclick/wheel 打「落点 x,y」；drag 打「N 帧：x,y → x,y」 */
  const POINT_RE = /落点 \d+,\d+/;
  const DRAG_RE = /帧：\s*\d+,\d+\s*→\s*\d+,\d+/;

  const hoverRes = await runCli(['hover', TARGET], 60000);
  check(
    'hover：exit 0 且输出带落点读数（指针事件送达，不断言面板出现）',
    hoverRes.code === 0 && POINT_RE.test(hoverRes.out),
    `exit=${hoverRes.code} · ${hoverRes.tail}`,
  );

  const dblRes = await runCli(['dblclick', TARGET], 60000);
  check(
    'dblclick：exit 0 且输出带落点读数',
    dblRes.code === 0 && POINT_RE.test(dblRes.out),
    `exit=${dblRes.code} · ${dblRes.tail}`,
  );

  // drag 的终点用**运行时算出来的坐标**而不是第二个选择器：原地拖等于没拖（位移 0），
  // 而拖到另一个具名元素上会真触发一次 drop（可能改文档）。中心点 + 偏移 80,40 像素
  // 是"有真实位移、又不落在别的组件上"的最小写法。
  const anchor = await cdp.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(TARGET)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  const dragFrom = anchor ? `${anchor.x},${anchor.y}` : TARGET;
  const dragTo = anchor ? `${anchor.x + 80},${anchor.y + 40}` : TARGET;
  const dragRes = await runCli(['drag', dragFrom, dragTo, '--steps', '8'], 60000);
  check(
    'drag：exit 0 且输出带起终点落点与移动帧数',
    dragRes.code === 0 && DRAG_RE.test(dragRes.out),
    `exit=${dragRes.code} · ${dragRes.tail}`,
  );

  const wheelRes = await runCli(['wheel', TARGET, '--dy', '120'], 60000);
  check(
    'wheel：exit 0 且输出带落点读数（dx=0 dy=120）',
    wheelRes.code === 0 && POINT_RE.test(wheelRes.out),
    `exit=${wheelRes.code} · ${wheelRes.tail}`,
  );
});

/* ============ semantic：六条语义读数 + selfCheck().semantic 契约（2026-10-30 批次 3） ============
 * 为什么单独成段、并且**必须**走 CLI：这六条命令是 agent 查语义的公开入口（参数解析、
 * 1 基行列、退出码、`--json` 单文档输出全在 CLI 里），页面侧 `__kojoDebug.editor.*`
 * 只覆盖"读数本身"。两条腿都要有：CLI 腿钉接口，页面腿（见下面的 selfCheck）钉契约。
 *
 * 为什么 symbols / diagnostics 要配 `--json` 并 `JSON.parse`：人读形态是给人看的
 * （"(空)" 也是合法输出），机器形态才是回归脚本的接口。JSON 解析不过 = 输出里混进了
 * 非 JSON 的噪声（prompt、警告、多打了一行），那种"看起来有内容"的假绿最难查。
 *
 * 为什么 `symbols.count >= 1` 要硬断言：symbols 打的是**当前打开的那份文件**，
 * 而 CLI 的 ensureEditor 已经确认过"有焦点编辑器"——这份文件必然有符号（ERB 方言 /
 * kojo 都挂了 documentSymbol provider）。真回 0 就是 provider 没挂上或读数走岔了，
 * 不是"这个文件本来就没符号"，放宽成 `>= 0` 等于把这条腿删掉。
 * ============================================================================================ */
seg('semantic', ['session', 'editor'], async (c) => {
  const { cdp } = c;
  const runCli = c.runCli;

  // 四条"点查"：行列 **1 基**（与 Monaco position 同口径）。
  //
  // 2026-10-31 修正：原先四条都打 `1 1`——而夹具的第 1 行是注释（`; 合成 fixture…`），
  // 那里本来就什么也没有，于是四条永远 `(空)`，**只验到了退出码**。真机上 provider 腿
  // 整条是坏的（`ordered()` 返回 provider 本身，我们按 `{provider}` 解 ⇒ 恒空）时，
  // 这四条照样全绿。现在改打**真实符号位**：第 2 行是 `@M_KOJO_K1` 声明，第 2 列是名字首字符，
  // 第 6 行是诊断落点（`diagnostics` 报的那几行）。
  //
  // 为什么这四条**不**硬要求 count ≥ 1：这个夹具是 `kojo-erb`，而引用/签名/代码动作的供方
  // 判据是「非 kojo2 请求 ⇒ `undefined` 弃权」（`plugins/kojo-lang/src/references.ts` 头注
  // 的三态纪律：弃权让共享收口交回空列表，不去顶掉那门语言自己的 provider）。所以这里
  // 空是**正确答案**。真信号放在两处硬断言上：`symbols ≥ 1`（provider 链真的取到数）与
  // 下面 `selfCheck().semantic.providers` 五项全 true（注册表真的看得到 provider）。
  const pointQueries = [
    ['definition', ['definition', '2', '2', '--json']],
    ['references', ['references', '2', '2', '--json']],
    ['code-actions', ['code-actions', '6', '1', '--json']],
    ['signature', ['signature', '6', '1']],
  ];
  for (const [name, argv] of pointQueries) {
    const r = await runCli(argv, 90000);
    let doc = null;
    try {
      doc = argv.includes('--json') ? JSON.parse(String(r.out).trim()) : null;
    } catch {
      doc = null;
    }
    const count = typeof doc?.count === 'number' ? doc.count : null;
    const at = doc?.at ? `${doc.at.line}:${doc.at.column}` : '—';
    const argLine = argv[1];
    const argColumn = argv[2];
    check(
      `${name} ${argLine} ${argColumn}：exit 0（该语言的供方可弃权，空是合法读数）`,
      r.code === 0,
      `exit=${r.code} · at ${at} · count=${JSON.stringify(count)} · ${r.tail}`,
    );
  }

  // symbols：合法 JSON + count >= 1
  const symRes = await runCli(['symbols', '--json'], 90000);
  let symJson = null;
  let symErr = '';
  try {
    symJson = JSON.parse(String(symRes.out).trim());
  } catch (e) {
    symErr = String(e?.message ?? e);
  }
  const symCount = typeof symJson?.count === 'number' ? symJson.count : null;
  check(
    'symbols --json：exit 0 / 合法 JSON / count ≥ 1',
    symRes.code === 0 && !!symJson && !symErr && symCount !== null && symCount >= 1,
    symErr
      ? `exit=${symRes.code} · JSON 解析失败=${symErr} · 原文=${JSON.stringify(String(symRes.out).slice(0, 160))}`
      : `exit=${symRes.code} · count=${JSON.stringify(symCount)} · items=${Array.isArray(symJson?.items) ? symJson.items.length : '—'} · ${symRes.tail}`,
  );

  // diagnostics：合法 JSON（条数不设下限——没诊断是常态，0 不是坏消息）
  const diagRes = await runCli(['diagnostics', '--json'], 90000);
  let diagJson = null;
  let diagErr = '';
  try {
    diagJson = JSON.parse(String(diagRes.out).trim());
  } catch (e) {
    diagErr = String(e?.message ?? e);
  }
  check(
    'diagnostics --json：exit 0 且输出为合法 JSON',
    diagRes.code === 0 && !!diagJson && !diagErr && typeof diagJson.count === 'number',
    diagErr
      ? `exit=${diagRes.code} · JSON 解析失败=${diagErr} · 原文=${JSON.stringify(String(diagRes.out).slice(0, 160))}`
      : `exit=${diagRes.code} · count=${JSON.stringify(diagJson?.count)} · ${diagRes.tail}`,
  );

  // selfCheck().semantic：**契约**（不是近似）——
  // ① semantic 块必须在场；
  // ② providers.diagnostics 恒为 null（诊断不走 provider 注册表，getModelMarkers 是公开 API）；
  // ③ **五项 provider 全 true**。这一条是给 2026-10-31 那个真机缺陷留的闸：`ordered()` 在
  //    0.57 上直接返回 provider 数组，取数腿按 `{provider}` 解 ⇒ 恒空 ⇒ 六个语义读数全空、
  //    providers 全 false，而当时的单测喂的正是包装形状，全绿。`symbols ≥ 1` 与这一条必须
  //    同时在，才既证明"注册表看得到"也证明"取数腿拿得到"。
  // 与 install-debug.ts 的 summarizeSemanticCheck 是同一句话的两个落点：那边写死，这边钉住。
  let semRes = null;
  let semErr = '';
  try {
    semRes = await cdp.evalJs(
      `(async () => {
        const r = await __kojoDebug.editor.selfCheck();
        const s = r && r.semantic;
        return { hasSemantic: !!s, providers: s ? s.providers : null, actions: s ? s.actions : null, ok: r ? r.ok : undefined };
      })()`,
      30000,
    );
  } catch (e) {
    semErr = String(e?.message ?? e);
  }
  const providerKeys = ['definition', 'references', 'codeAction', 'signatureHelp', 'documentSymbol'];
  const allProvidersSeen =
    !!semRes?.providers && providerKeys.every((k) => semRes.providers[k] === true);
  check(
    'selfCheck().semantic：块在场 / 五项 provider 全 true / diagnostics === null',
    !semErr && semRes?.hasSemantic === true && allProvidersSeen && semRes?.providers?.diagnostics === null,
    semErr ||
      `hasSemantic=${semRes?.hasSemantic} · allProviders=${allProvidersSeen} · diagnostics=${JSON.stringify(semRes?.providers?.diagnostics)} · providers=${JSON.stringify(semRes?.providers)} · actions=${JSON.stringify(semRes?.actions)} · ok=${JSON.stringify(semRes?.ok)}`,
  );
});

/* ------------------------------ main ------------------------------ */

async function main() {
  let plan;
  try {
    plan = resolvePlan(ONLY_RAW);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`[smoke] ${err.message}`);
    // 拼错段名时**列全**可用段名（含依赖），不然只能去翻源码
    console.error('[smoke] 可用段名（括号内是它依赖的前置段，--only 会自动带上）：');
    for (const s of SEGMENTS) {
      console.error(`  ${s.name.padEnd(10)}${s.needs.length ? `（${s.needs.join(', ')}）` : ''}`);
    }
    console.error('[smoke] 用法：node tools/debug-web-smoke.mjs [--keep] [--only <段名>[,<段名>...]]');
    process.exit(2);
  }

  const onlyMode = ONLY_RAW !== null;
  if (onlyMode) console.log(`[smoke] --only → ${plan.map((s) => s.name).join(' → ')}`);
  const startedAt = Date.now();

  try {
    for (const s of plan) {
      // 段起止标记只在 --only 模式打：默认路径的输出必须与分段化之前逐字一致
      // （有人拿 stdout 判断回归，多几行就是噪声）。
      const t0 = Date.now();
      if (onlyMode) console.log(`[smoke] ▶ 段 ${s.name}`);
      await s.run(ctx);
      if (onlyMode) console.log(`[smoke] ⏹ 段 ${s.name} 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  } catch (err) {
    // 与分段化之前同一条兜底：一条红 + 取证，然后走同一个 shutdown。
    // 段内抛错意味着后续段的**前置已经不成立**（页面没打开 / 会话起不来），
    // 继续跑只会收获一串连锁假红，所以这里直接跳出计划。
    check('断言链中途失败', false, String(err?.message ?? err));
    await forensics();
  }

  if (onlyMode) console.log(`[smoke] 本次 ${plan.map((s) => s.name).join(' → ')} 总用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  // 判空再用：`--only bogus` / 前置不满足这两条路径上 cdp 根本不存在
  try { ctx.cdp?.close(); } catch {}
  await shutdown(0);
}

await main();
