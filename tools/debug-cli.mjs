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
 *   wait <js 表达式> [--timeout ms]  # 每 200ms 求值，truthy 即成功（缺省 30s 超时）——等相位/等树/等加载
 *   assert <js 表达式>         # 求值一次，falsy 就 exit 1（冒烟/回归脚本的可读断言）
 *   state                      # __kojoDebug.state() 一屏读数
 *   commands [过滤串]          # 命令面板注册表（所有功能的可编程入口）
 *   run <命令id> [--settle ms] # 跑一条命令面板命令（缺省 settle 300ms，再读相位）
 *   close-project              # 关项目回欢迎相位（相当于工具栏「项目操作」→「关闭项目」）
 *   open-project <目录> [--writable] [--no-open-first] [--timeout <ms>]
 *         # web 模式＝调试宿 POST /policy（body `{readonly:[abs], chooseDir:abs}`：既答对话框也登记读根，
 *         # 少了 readonly 会因读域不含该目录卡到 60s 超时）；真壳（shell）＝调试面 dialogPolicy 应答
 *         # fetch 腿（只读，不进 Rust 写域准入门 ⇒ --writable 如实拒）。两模式都在最后硬对拍
 *         # rootDir===请求目录（假绿拦截）。相位不对时先跑 close-project
 *         # **快速失败**：第 4 步轮询「弹窗/树」的同时同拍轮询失败信号（.notice.error 原文 /
 *         # state().notices 关键词 / 超过 1.5s 仍回流欢迎页）——不是工程根当场 exit 1 并给原文，
 *         # 不再等满 60s。--timeout 只改第 4 步预算（默认 60000，夹 [3000,300000]）
 *   open-file <路径片段>       # 点文件树真实打开一个文件（10s 内对拍 editor.info().path 含该片段，否则如实红）
 *   click <选择器>             # CDP 真实点击（元素中心 + elementFromPoint 自证）
 *   type [<选择器>] <文本> [--mode text|keys|ime]
 *         # 选择器可省＝打到当前焦点元素（命令面板/搜索框先点开再 type）
 *         # text（默认）＝Input.insertText 直插（行为与旧版逐字一致）；keys＝逐字符 keyDown/char/keyUp
 *         # 走真实键盘路径（自动配对/回车缩进/触发字符只有这条路认；非 BMP 退化为 insertText 并给 fallback=N）；
 *         # ime＝Input.imeSetComposition 起组合再 insertText 上屏（CDP 不支持时如实红，不静默退化）
 *   key <键> [ctrl|alt|shift]  # 真实键事件（enter/escape/tab/arrowdown/…，可带修饰键）
 *   screenshot <out.png> [--full]   # 整页截图（agent 可直接看 PNG）
 *   perf <start|stop|quick [ms]>    # UI 卡顿体检（探针四路；跨命令存活）
 *   profile <run [ms]>              # CPU 采样归因（函数级热点 selfTime Top25；KOJO_PROFILE_OUT 落 .cpuprofile）
 *   dom                        # DOM 结构快照（相位/标签/面板/通知/状态栏）
 *   events [n]                 # 内核事件旁听（最近 n 条，默认 40）
 *   invoke <命令> [JSON参数]   # 直达宿主命令（调试宿或桌面壳 IPC 同一入口）
 *   doctor [--json] [--repo <路径>]
 *         # 调试工具链七项体检：**直接 import 复用** debug-doctor.mjs 的判据（不复制、不 spawn），
 *         # 退出码走它的 exitCodeFor（任一 FAIL ⇒ 1，WARN 不改变）
 *   hover <选择器|"x,y"> [--settle ms]     # CDP 真鼠标悬停：停在目标中心，再等 settle 给 hover provider
 *   dblclick <选择器|"x,y">                # 真双击（clickCount 1→2：两轮互不相干的单击浏览器不会合成 dblclick）
 *   drag <起点> <终点> [--steps n]         # 真拖拽（按下 → n 帧带 buttons:1 的移动 → 抬起）
 *   wheel <选择器|"x,y"> [--dx n] [--dy n] # 真滚轮（先移动指针再滚：滚的是指针下的那个滚动容器）
 *   definition|references|code-actions|signature <行> <列>
 *   symbols · diagnostics
 *         # 语义读数（页面调试面 `__kojoDebug.editor.*`）：**行列 1 基**（与 Monaco position、
 *         # `tokens()` 同口径）；查询位置原样回显在 `at: {line, column}`；空结果**不是错误**
 *         # （打 `(空)`、退出码 0——"这里没有定义"本身就是一条有效读数）
 *
 * `--json`：status / state / commands / dom / events / wait / assert + 上面三族都支持。加了之后
 *   stdout **只有一个 JSON 文档**（不混人类可读行、无 ANSI），可直接 JSON.parse；不加时输出与
 *   旧版**逐字一致**（有脚本和人在照着读，默认形态不能变）。失败仍走 stderr + 非 0，stdout 不留半截文档。
 *
 * 退出码：0 成功；1 失败；2 前置不满足（无会话 / 浏览器找不到 / 端口被占）。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  Cdp,
  cdpClick,
  cdpDoubleClick,
  cdpDrag,
  cdpHover,
  cdpPage,
  cdpWheel,
  debugHome,
  dismissDevNoteMask,
  expandCollapsedUntilMatch,
  findBrowser,
  freePort,
  HOST_HEAP_DEFAULT_MB,
  killProcessesMarked,
  memorySourceLabel,
  MEMORY_TIGHT_MB,
  portOpen,
  resolveHostHeap,
  sessionDir,
  sessionKey,
  sleep,
  waitFor,
} from './debug-lib.mjs';
// 体检判据只有一份（debug-doctor.mjs）：这里**直接 import 复用**，不复制逻辑、不 spawn 子进程——
// 两份判据迟早漂移，而"体检说没事、真跑起不来"正是体检工具最不能犯的错。
import { exitCodeFor, formatHuman, pidAlive, probePort, runDoctor } from './debug-doctor.mjs';
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
        `成因：serve 在多个时刻覆写 session.json（host/vite/browser 就绪各一次），写到一半进程被杀就是残文件。\n` +
        `处置：node tools/debug-cli.mjs stop（会话文件坏了也能收：它按会话目录 ${SESS_DIR} 认领残留进程并删文件），再重开 serve`,
      2,
    );
  }
}

/* ---- 鉴权（契约 §1.2）：token 只在会话文件里，日志/status 一律脱敏 ---- */

/** status 打印用：把 URL 里的页面 token 抹成 ***（url 子命令仍给完整 URL——它就是给浏览器用的） */
function maskUrl(u) {
  return String(u ?? '').replace(/(kojo-debug-token=)[^&\s]+/g, '$1***');
}

/**
 * POST /policy 的唯一出口（契约 §1.2：不许散落裸 fetch）。
 * /policy 只认 `x-kojo-policy-token` 请求头，不认 query token；旧会话文件没有该字段时退回无鉴权形态。
 */
async function postPolicy(session, body) {
  const res = await fetch(`http://127.0.0.1:${session.serverPort}/policy`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(session.policyToken ? { 'x-kojo-policy-token': session.policyToken } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`调试宿 POST /policy 被拒（HTTP ${res.status}）${text ? `：${text.slice(0, 200)}` : ''}`);
  }
  return res;
}

/** 顶层 await / async 表达式包 IIFE（页内直接写 `await __kojoDebug.invoke(...)` 也能跑） */
function wrapExpr(expr) {
  return /^\s*(?:await\s|async\s)/.test(expr) ? `;(async () => (${expr}))()` : expr;
}

/** 路径对拍口径：分隔符统一成 /，Windows 再折小写（页内报的是工程相对路径，CLI 参数可能带 \） */
function normPath(p) {
  const s = String(p ?? '').replace(/\\/g, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/* --------------------------- 输出闸门（--json） --------------------------- */

/**
 * `--json` 的**唯一**闸门（由入口在 parseArgs 之后写一次）。
 *
 * 为什么必须只有一个闸门、且默认形态逐字不变：这套 CLI 的默认输出已经有人和脚本在照着读
 * （`commands` 的行、`events` 的 `+Nms`、`wait` 的 `[ok] …`），改一个字都可能是别人的回归；
 * 反过来，要让 agent 能 `JSON.parse` 就必须保证 stdout **只有一个完整 JSON 文档**——
 * 人类读的行（`[ok] …`、`（12 条）`）混进去，解析当场失败且报错位置极具误导性。
 * 所以两种形态彻底分开：`emit` 只在一处判，命令里不再散落 `if (opts.json)`。
 *
 * 失败不在这里兜：`die` 走 stderr + 非 0，stdout 一个字符都不留（宁可空，也不给半截文档）。
 */
let jsonOut = false;

/** 统一出口：`--json` 打单行 JSON（键序＝对象字面量顺序），否则走原来的 `humanFn` */
function emit(value, humanFn) {
  if (jsonOut) {
    console.log(JSON.stringify(value));
    return;
  }
  humanFn(value);
}

/* ------------------------ 参数解析（纯函数，供单测） ------------------------ */

/**
 * 带值选项的数值解析：非法值**当场红并回显原文**。
 * 为什么不像 `run --settle` 那样静默落默认：`wheel --dy abc` 若静默变 0，用户看到的是
 * "滚了但没反应"，而不是"参数打错了"——调试工具里这种静默降级比报错贵得多。
 */
function numberOption(name, raw, fallback) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) die(`${name} 需要数字，收到「${raw}」`, 2);
  return n;
}

/**
 * 指针目标解析：**一个**位置参数，`"x,y"` 或选择器。
 *
 * 为什么坐标不拆成两个位置参数：`drag <起点> <终点>` 已经要吃两个位置参数，若坐标再拆两个，
 * 一条命令就是四个位置参数，`drag .a .b` 与 `drag 10,20 30,40` 的歧义只能靠"猜"——
 * 而猜错的后果是"点在空白处"的假绿。保持**一个**参数，形态自明，也和直觉写法一致。
 *
 * 判据只看形状：以数字/小数点打头且含逗号 ⇒ 按坐标理解（这样 `a[href], b` 这类带逗号的
 * 选择器不会被误判）；坐标形态但数字不合法 ⇒ 回 `bad-point` 并带上**收到的原文**，
 * 由调用方 die 出去——用户得看见自己写的那串，否则无从改。
 */
export function parseTargetArg(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { kind: 'missing' };
  if (text.includes(',') && /^[+-]?(?:\d|\.\d)/.test(text)) {
    const m = /^([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)$/.exec(text);
    if (!m) return { kind: 'bad-point', raw: text };
    return { kind: 'point', x: Number(m[1]), y: Number(m[2]), raw: text };
  }
  return { kind: 'selector', selector: text };
}

/** 解析结果 → `debug-lib` 的 target（字符串＝选择器，对象＝坐标） */
function cdpTarget(t) {
  return t.kind === 'point' ? { x: t.x, y: t.y } : t.selector;
}

/** 解析结果 → --json 的稳定形状（不带 raw：机器读数只要语义） */
function jsonTarget(t) {
  return t.kind === 'point' ? { kind: 'point', x: t.x, y: t.y } : { kind: 'selector', selector: t.selector };
}

/** 人类读的一行目标回显（坐标形态带引号：一眼看出"这是坐标、不是某个选择器"） */
function describeTarget(t) {
  return t.kind === 'point' ? `"${t.raw}"` : `${t.selector}`;
}

/** 位置参数缺 / 坐标写坏时的统一出口（永远带原文） */
function requireTarget(raw, command, form) {
  const t = parseTargetArg(raw);
  if (t.kind === 'missing') die(`${command}：${form}（坐标写成 "x,y" 一个参数，不要拆两个）`, 2);
  if (t.kind === 'bad-point') {
    die(`${command}：坐标写法不认识「${t.raw}」——要 "x,y" 两个数（如 "320,480"），不要空格/多余符号`, 2);
  }
  return t;
}

/**
 * 语义族的 `<行> <列>` 解析（**1 基**，与 Monaco position / `editor.tokens()` 同口径）。
 *
 * 为什么校验得这么死：0 基 / 1 基混用是这类命令最常见的事故，而 Monaco 对越界行列**不报错**，
 * 只会给一个错位的结果——读数看上去"有内容"，实际查的是隔壁那一格。这里把非正整数当场挡掉，
 * 并把收到的原文一起打出来（`definition 3 0` 与 `definition 3` 的报错必须能区分）。
 */
export function parseLineColumn(lineArg, columnArg, command = '') {
  const rawLine = lineArg === undefined ? '' : String(lineArg);
  const rawCol = columnArg === undefined ? '' : String(columnArg);
  const line = Number(rawLine);
  const column = Number(rawCol);
  if (!Number.isInteger(line) || line < 1) {
    return {
      ok: false,
      error: `${command} 的行号必须是 >= 1 的整数（**1 基**，与 Monaco position 同口径），收到「${rawLine}」`,
    };
  }
  if (!Number.isInteger(column) || column < 1) {
    return {
      ok: false,
      error: `${command} 的列号必须是 >= 1 的整数（**1 基**，与 Monaco position 同口径），收到「${rawCol}」`,
    };
  }
  return { ok: true, at: { line, column } };
}

/** parseLineColumn + die：语义族每条命令的第一句 */
function requireAt(lineArg, columnArg, command) {
  const r = parseLineColumn(lineArg, columnArg, command);
  if (!r.ok) die(`${r.error}\n  （列号是字符列、从 1 开始；「行 列」两个位置参数都要给）`, 2);
  return r.at;
}


/* --------------------- open-project 的失败判据（纯函数） --------------------- */

/** `--timeout` 的夹取区间（第 4 步预算） */
const OPEN_TIMEOUT_MIN_MS = 3000;
const OPEN_TIMEOUT_MAX_MS = 300000;
const OPEN_TIMEOUT_DEFAULT_MS = 60000;

/** `--timeout <ms>` → 夹取后的毫秒数（非法/缺省落默认） */
export function clampOpenTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return OPEN_TIMEOUT_DEFAULT_MS;
  return Math.min(OPEN_TIMEOUT_MAX_MS, Math.max(OPEN_TIMEOUT_MIN_MS, Math.round(n)));
}

/**
 * 打开失败判据（2026-10-30 遗留 1，**纯函数，不碰 CDP**）。
 *
 * 病根：对"不是工程根"的目录（如 `fixtures/sugar`：只有 .kojo、没有 CSV/ERB）应用会当场拒绝，
 * 旧实现却只轮询「写权限弹窗 / 文件树」⇒ 一直等到 60s 超时才报「写权限审批 / 文件树」，
 * 用户看到的是"超时"而不是"不接受这个目录"。
 *
 * 口径：**只在明确有错时**返回 `{reason}`，正常中间态（opening / 弹窗在场 / 树已出）一律 null。
 * 入参（全部可选，缺字段按"没有信号"处理）：
 * - `errorNotices`：`.notice.error`（或 `[data-kind="error"]`）的可见原文 —— 无条件算失败；
 * - `notices`：`state().notices.items` —— 命中失败关键词才算（打开/失败/不支持/不是）；
 * - `phase` / `hasTree` / `modal`：页面相位 / 文件树是否在场 / 写权限弹窗是否在场；
 * - `revertedMs`：点完「打开项目」至今的毫秒数 —— 超宽限仍停在 welcome 且无树＝回流。
 */
export function classifyOpenFailure(snapshot) {
  // 欢迎页回流判定的宽限：点完「打开项目」超过这个时长还停在 welcome 且没有树＝应用把这次打开退回来了。
  // 常量住在函数里：这是纯函数，单测按源码求值时不许依赖模块级可变状态。
  const REVERT_GRACE_MS = 1500;
  const s = snapshot ?? {};
  if (s.hasTree === true) return null; // 树已出＝这一趟开了，正常
  if (s.modal === true) return null; // 写权限弹窗＝应用接受了目录，正常中间态
  const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
  const errorNotices = Array.isArray(s.errorNotices) ? s.errorNotices : [];
  const explicit = errorNotices.map(norm).find((t) => t !== '');
  if (explicit !== undefined) return { reason: explicit };
  const notices = Array.isArray(s.notices) ? s.notices : [];
  const KEYWORDS = ['打开', '失败', '不支持', '不是'];
  for (const raw of notices) {
    const t = norm(raw);
    if (t === '') continue;
    if (KEYWORDS.some((k) => t.includes(k))) return { reason: t };
  }
  const revertedMs = Number(s.revertedMs ?? 0);
  if (String(s.phase ?? '') === 'welcome' && Number.isFinite(revertedMs) && revertedMs >= REVERT_GRACE_MS) {
    return { reason: '点开之后又回到了欢迎页：应用没有接受这个目录' };
  }
  return null;
}

/** 快速失败的 Error 载体（标记后由 cmdOpenProject 出口换成固定文案 + exit 1） */
function openRejectedError(abs, reason) {
  const err = new Error(
    `[FAIL] 打开被应用拒绝：${reason}（目录：${abs}）——不是工程根或缺权限，换目录或先看 dom 通知`,
  );
  err.kojoOpenRejected = true;
  return err;
}

/**
 * 连本会话的页面 CDP。
 *
 * `dieOnError:false` 是给 `status` 用的：`die()` 走 `process.exit`，**不可捕获**——
 * status 复用它时会把"CDP 已经没了"变成一次 exit 2，返回码含义就被污染了（本树实测：
 * 浏览器退出后 status 反被判绿/忽然 rc=2，两种读数都不可信）。这条路返回 null，
 * 由调用方自己判红、自己决定退出码。
 */
async function cdpForSession(session, { mustHavePage = true, dieOnError = true } = {}) {
  let page = null;
  try {
    page = await cdpPage(session.cdpPort, session.vitePort);
  } catch {
    page = null;
  }
  if (!page) {
    if (!mustHavePage || !dieOnError) return null;
    die(
      `CDP :${session.cdpPort} 上没有本会话的页面（vite :${session.vitePort}）——` +
        `可能是旧会话的僵尸浏览器占着 CDP 端口（serve 只验了端口没验页面归属，2026-10-25 已收紧）。` +
        `处置：node tools/debug-cli.mjs stop 后重开 serve；还不行就杀残留（PowerShell 按 CommandLine 含 kojo-debug 认领）`,
      2,
    );
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  try {
    await cdp.connect();
  } catch (err) {
    if (dieOnError) throw err;
    return null;
  }
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
    if (err?.code !== 'ENOENT') {
      die(
        err instanceof SyntaxError
          ? `旧会话文件损坏（JSON 解析失败：${err.message}）：${SESSION_FILE}\n` +
              `先 node tools/debug-cli.mjs stop（会话文件坏了也能收：按会话目录认领残留进程并删文件），再重开 serve`
          : `读旧会话失败：${err?.message ?? err}`,
        2,
      );
    }
  }
  const session = {
    createdAt: new Date().toISOString(),
    sessionId: sessionKey(REPO),
    repoRoot: REPO,
    sandbox: path.resolve(args.sandbox ?? path.join(SESS_DIR, 'sandbox')),
    appdata: path.join(SESS_DIR, 'appdata'),
    readonly: args.readonly.map((p) => path.resolve(p)),
    // 鉴权（契约 §1.2）：每会话两枚独立随机 token——页面侧与 CLI 侧各一把，
    // 泄了页面地址也拿不到 /policy 的写入口令。旧会话文件没有它们时 CLI 退回无鉴权形态。
    token: crypto.randomBytes(24).toString('hex'),
    policyToken: crypto.randomBytes(24).toString('hex'),
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
  //    2026-10-31：大堆改成**按本机预算收**（debug-lib.hostHeapMb）。写死 4096 在小内存容器里
  //    帮倒忙——V8 不早 GC，容器 OOM 先到，内核挑 RSS 最大的杀（常常是渲染进程），现场像
  //    "浏览器 bug"。64GB 本机算出仍夹回 4096，常态输出与行为逐字不变（PITFALLS 293）。
  const heap = resolveHostHeap();
  if (heap.heapMb !== HOST_HEAP_DEFAULT_MB) {
    console.log(
      `[cli] 内存预算 ${heap.budgetMb} MB（${memorySourceLabel(heap.source)}）` +
        `⇒ 调试宿堆上限 ${heap.heapMb} MB；浏览器另需 ≥0.7 GB，总量不足先加内存（KOJO_DEBUG_HOST_HEAP 可覆盖）`,
    );
  }
  if (heap.budgetMb < MEMORY_TIGHT_MB) {
    console.warn(
      `[cli] [warn] 内存预算 ${heap.budgetMb} MB 低于 ${MEMORY_TIGHT_MB} MB：本链路实测地板 1.0~1.2 GB，` +
        '浏览器很可能被容器 OOM 杀掉（内核挑 RSS 最大的），不是编辑器 bug',
    );
  }
  const serverArgs = [`--max-old-space-size=${heap.heapMb}`, 'tools/debug-server.mjs', '--port', String(session.serverPort), '--sandbox', session.sandbox, '--appdata', session.appdata];
  for (const r of session.readonly) serverArgs.push('--readonly', r);
  // 调试宿是**有鉴权的**（契约 §1.1）：缺这两枚 token 就是给本机任意页面开读写后门
  serverArgs.push('--token', session.token, '--policy-token', session.policyToken);
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

  // 页面侧 token 走 query（页面传输按它挂 Authorization/SSE query，契约 §1.3）
  session.url = `http://127.0.0.1:${session.vitePort}/?kojo-debug=${session.serverPort}&kojo-debug-token=${session.token}`;
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
  line(`=== console 记录开始（页面 ${maskUrl(session.url)}）===`);
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
    if (err?.code !== 'ENOENT') {
      die(
        err instanceof SyntaxError
          ? `旧会话文件损坏（JSON 解析失败：${err.message}）：${SESSION_FILE}\n` +
              `先 node tools/debug-cli.mjs stop（会话文件坏了也能收），再重起 shell`
          : `读旧会话失败：${err?.message ?? err}`,
        2,
      );
    }
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
  // dieOnError:false —— status 是"读数"，不许因为 CDP 没了就 process.exit（会污染返回码含义）
  let cdpWhy = '';
  const cdpPortNum = Number(s.cdpPort ?? 0);
  if (cdpPortNum > 0 && (await portOpen(cdpPortNum))) {
    const cdp = await cdpForSession(s, { dieOnError: false }).catch(() => null);
    if (cdp) {
      cdpOk = true;
      try {
        pagePhase = await cdp.evalJs('(window.__kojoDebug ? __kojoDebug.state().phase : document.querySelector(".welcome") ? "welcome(no-debug-api)" : "unknown")');
      } catch (err) {
        cdpOk = false;
        cdpWhy = `页面求值失败：${String(err?.message ?? err)}`;
      } finally {
        cdp.close();
      }
    } else {
      cdpWhy = `端口 :${cdpPortNum} 开着但没有本会话页面（僵尸浏览器 / 别的会话占着 CDP）`;
    }
  } else {
    cdpWhy = cdpPortNum > 0 ? `CDP :${cdpPortNum} 不在（浏览器已退出）` : '会话没记 cdpPort（serve 没带浏览器？）';
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
  // 读数先成对象、再决定怎么打：`--json` 与人类形态共用同一份形状（键序即下面的字面量顺序），
  // 这样"加 --json 之后看到的东西"与"人看到的东西"永远不会是两套口径。
  const report = {
    会话: `${s.sessionId ?? '?'}（${s.repoRoot ?? '?'}${isShell ? ' · mode=shell 真桌面壳' : ''}）`,
    调试宿: serverOk === null ? '—（mode=shell：真 Tauri IPC，无调试宿）' : serverOk ? `[ok] :${s.serverPort} ${childLine('host', s.serverPid, alive(s.serverPid))}` : `[FAIL] :${s.serverPort} ${childLine('host', s.serverPid, alive(s.serverPid))}`,
    vite: `${viteOk ? '[ok]' : '[FAIL]'} :${s.vitePort}${isShell ? '' : ` ${childLine('vite', s.vitePid, alive(s.vitePid))}`}`,
    浏览器CDP: cdpOk
      ? `[ok] :${s.cdpPort} ${isShell ? childLine('shell', s.shellPid, alive(s.shellPid)) : childLine('browser', s.browserPid, alive(s.browserPid))}`
      : `[FAIL] ${cdpWhy} ${isShell ? childLine('shell', s.shellPid, alive(s.shellPid)) : childLine('browser', s.browserPid, alive(s.browserPid))}`,
    页面相位: pagePhase,
    // 真壳的写权限只由真人对话框交付（铁律 6/7）：调试通道不代答确认框 ⇒ 恒为只读浏览。
    // 这条只是读数，不参与下面的退出码判定。
    ...(isShell ? { 写权限: '只读浏览（debug 通道不代答确认框）' } : {}),
    退出记录: (s.exits ?? []).slice(-5),
    // token 只留在会话文件里：status 常被粘进工单/日志，页面 token 一律脱敏（要完整 URL 用 url 子命令）
    URL: maskUrl(s.url),
    sandbox: s.sandbox ?? null,
    readonly: s.readonly ?? [],
  };
  // 默认形态逐字不变（缩进 2 的人类形态有脚本/人在读）；--json 收成单行，保证 stdout 只有一个文档
  console.log(jsonOut ? JSON.stringify(report) : JSON.stringify(report, null, 2));
  // shell 模式没有调试宿：判据换成「vite 在 + CDP 能连 + 真壳进程活着」——
  // 只看 vite 会把「壳崩了但 vite 还挂着」判成健康（假绿）。
  if (isShell) process.exit(viteOk && cdpOk && alive(s.shellPid) === true ? 0 : 1);
  process.exit(serverOk && viteOk ? 0 : 1);
}

async function cmdStop() {
  // 收摊不许被坏会话文件卡死（契约 §2）：残文件很可能就是 serve 写到一半被杀留下的，
  // 而这时恰恰最需要 stop 把它的 host/vite/browser 收掉。容错读 → 告警 → 按会话目录兜底。
  let s = {};
  let raw = null;
  try {
    raw = await fsp.readFile(SESSION_FILE, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      die(
        `本工作树没有在跑的调试会话（${SESSION_FILE} 不存在；多 agent 并发下会话按工作树隔离，` +
          `看到的只有自己这棵树）。先起一套：\n  node tools/debug-cli.mjs serve`,
        2,
      );
    }
    console.warn(`[cli] [warn] 读会话文件失败（${err?.message ?? err}）——按会话目录 ${SESS_DIR} 兜底收进程`);
  }
  if (raw !== null) {
    try {
      s = JSON.parse(raw) ?? {};
    } catch (err) {
      console.warn(
        `[cli] [warn] 会话文件损坏（JSON 解析失败：${err?.message ?? err}）：${SESSION_FILE}\n` +
          `        按会话目录 ${SESS_DIR} 认领残留进程并删文件（端口兜底不可用——文件里读不出端口）`,
      );
      s = {};
    }
  }
  const pids = [s.browserPid, s.vitePid, s.serverPid, s.shellPid].filter((p) => typeof p === 'number' && p > 0);
  // serve 形态里三个孩子都是 serve 的子进程：按端口认属主收（Windows taskkill 树杀）
  if (process.platform === 'win32' && [s.serverPort, s.vitePort, s.cdpPort].some((p) => typeof p === 'number')) {
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
  if (!(await portOpen(s.cdpPort))) die(
    `浏览器 CDP 不在（serve 没带浏览器、浏览器已关，或 CDP 端口被旧会话僵尸占着）。\n` +
      `处置（二选一）：\n` +
      `  · 重开：node tools/debug-cli.mjs stop && node tools/debug-cli.mjs serve\n` +
      `  · 无头机：node tools/debug-cli.mjs serve --no-browser，然后用你自己的浏览器/agent 内置浏览器\n` +
      `    打开 node tools/debug-cli.mjs url 给的地址（页面托管在 vite 端口上，CDP 只用于驱动）`,
    2,
  );
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
    const v = await cdp.evalJs(wrapExpr(expr), 60000);
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  });
}

async function cmdState() {
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 10000, label: '__kojoDebug 装载' });
    const value = await cdp.evalJs('__kojoDebug.state()');
    emit(value, (v) => console.log(JSON.stringify(v, null, 2)));
  });
}

async function cmdCommands(_, filter) {
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 10000, label: '__kojoDebug 装载' });
    const list = await cdp.evalJs('__kojoDebug.commands.list()');
    if (list && list.error) die(`命令注册表不可用：${list.error}（项目态命令要在开项目后才有）`, 1);
    const arr = (list ?? []).filter((c) => !filter || `${c.category ?? ''} ${c.title} ${c.id}`.toLowerCase().includes(filter.toLowerCase()));
    // --json 的键序：filter（用了哪个过滤串）→ count → items（原样，不裁剪字段）
    emit({ filter: filter ?? null, count: arr.length, items: arr }, () => {
      for (const c of arr) {
        console.log(`${c.id.padEnd(36)} ${c.keybinding ? `[${c.keybinding}] `.padEnd(16) : ''.padEnd(16)} ${c.category ?? ''}｜${c.title}`);
      }
      console.log(`（${arr.length} 条${filter ? `，过滤「${filter}」` : ''}）`);
    });
  });
}

async function cmdRun(_, id, settleArg) {
  if (!id) die('run 需要命令 id（先 commands 看清单）', 2);
  // 缺省 300ms 与改动前一致；慢命令（重检索 / 格式化全项目）用 --settle 放宽再读相位
  const settle = Math.max(0, Number(settleArg ?? 300) || 0);
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 10000, label: '__kojoDebug 装载' });
    await cdp.evalJs(`__kojoDebug.commands.run(${JSON.stringify(id)})`, 30000);
    await sleep(settle);
    const phase = await cdp.evalJs('__kojoDebug.state().phase');
    console.log(`[ok] 已执行命令 ${id}（settle ${settle}ms，相位：${phase}）`);
  });
}

/** wait <js 表达式> [--timeout ms]：轮询到 truthy（等相位/等树/等异步装载的正规姿势，别 sleep 撞运气） */
async function cmdWait(opts, expr) {
  if (!expr) die('wait 需要 <js 表达式>（每 200ms 求值一次，truthy 即成功）', 2);
  const timeoutMs = Math.max(200, Number(opts.timeout ?? 30000) || 30000);
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 10000, label: '__kojoDebug 装载' });
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < timeoutMs) {
      try {
        const v = await cdp.evalJs(wrapExpr(expr), 5000);
        if (v) {
          const elapsedMs = Date.now() - t0;
          emit({ ok: true, expression: expr, elapsedMs }, () => console.log(`[ok] wait 满足（${elapsedMs}ms）：${expr}`));
          return;
        }
        last = JSON.stringify(v) ?? String(v);
      } catch (err) {
        last = `求值抛错：${String(err?.message ?? err).slice(0, 200)}`;
      }
      await sleep(200);
    }
    // 超时走 die（stderr + 非 0）：--json 的 stdout 宁可空，也不给"看着像成功"的半截文档
    die(`[FAIL] wait 超时（${timeoutMs}ms）：${expr}${last ? `\n       最后一次读到：${last}` : ''}`, 1);
  });
}

/** assert <js 表达式>：求值一次，falsy 即 exit 1（回归脚本里当可读断言用） */
async function cmdAssert(_, expr) {
  if (!expr) die('assert 需要 <js 表达式>（求值一次，falsy 即 exit 1）', 2);
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 10000, label: '__kojoDebug 装载' });
    const v = await cdp.evalJs(wrapExpr(expr), 30000);
    if (v) {
      emit({ ok: true, expression: expr, value: v }, () => console.log(`[ok] 断言成立：${expr}`));
      return;
    }
    die(`[FAIL] 断言不成立：${expr} => ${JSON.stringify(v)}`, 1);
  });
}

/** close-project：真壳/Web 同路——命令面板的 workbench.closeProject（工具栏「关闭项目」是它的按钮壳） */
async function cmdCloseProject() {
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 10000, label: '__kojoDebug 装载' });
    const phase = await cdp.evalJs('__kojoDebug.state().phase');
    if (phase === 'welcome') {
      console.log('[ok] 当前已在欢迎相位');
      return;
    }
    await cdp.evalJs(`__kojoDebug.commands.run('workbench.closeProject')`, 30000);
    try {
      await waitFor(cdp, `__kojoDebug.state().phase === 'welcome'`, { timeoutMs: 20000, label: '欢迎相位' });
    } catch {
      const now = await cdp.evalJs('__kojoDebug.state().phase').catch(() => '?');
      die(`[FAIL] 关闭项目后 20s 内没回到欢迎相位（当前相位：${now}；有未保存改动时编辑器会拦——先自己存/关掉弹窗）`, 1);
    }
    console.log('[ok] 项目已关');
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
        // 安全裁决（不是缺陷，是铁律 6/7 的必然结果）：调试面应答的对话框**不进 Rust 写域准入门**，
        // 准入门只认真实对话框交付的那一次。所以这条腿不该假装能写——只把**可走的两条路**说清。
        die(
          '真壳 open-project 不支持 --writable（调试面不代答「写权限确认」＝不给脚本签发权限，铁律 6/7）。\n' +
            '  可走的两条路：\n' +
            '  ① 验写链路：web 模式 `node tools/debug-cli.mjs serve` 后 open-project <目录> --writable' +
            '（调试宿有自己的写域登记，走的是真写链路）；\n' +
            '  ② 验真壳：对**已授权目录**（PITFALLS §160/§161：先由真人开一次对话框授权该目录）' +
            '再 shell 下 open-project <该目录>（此时不需要 --writable，授权记录本身生效）',
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
      // body 必须同时登记读根（readonly）与对话框应答（chooseDir）：只给 chooseDir 时
      // 宿的读域里没有这个目录，打开任意外部目录会卡在读文件阶段直到 60s 超时。
      // 注意不吞错——/policy 被鉴权拒（旧会话 token / 别的会话）要当场红，不能吞掉后干等
      try {
        await postPolicy(s, { readonly: [abs], chooseDir: abs });
      } catch (err) {
        die(`登记目录应答失败：${String(err?.message ?? err)}`, 1);
      }
    }
    // 应答装了却没被消费（中途失败/相位不对）不许留过期 policy——收尾一律 clear
    let failure = null;
    // 点之前的 toast 底片：应用拒绝目录时**原文落在 `.toast-error`**（如「「sugar」不是可识别的
    // 游戏目录。」），这一条不在 `.notice` 家族里（state().notices 只收 `.notice`）。
    // 只有"点完之后新出现的"那条算信号，旧 toast 一律当背景（否则上一次失败会把下一次正常打开判死）。
    let preToastJson = '[]';
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
        // 点之前先记 toast 底片（失败原文常在点完之后才出现的那条 `.toast-error` 里）
        preToastJson = JSON.stringify(
          (await cdp
            .evalJs(`[...document.querySelectorAll('.toast')].map((el) => (el.textContent || '').trim())`)
            .catch(() => [])) ?? [],
        );
        await cdpClick(cdp, '.welcome-open');
      } else {
        // 前置不满足（相位不对）＝ exit 2，而且要是**一行干净文案**：旧实现 throw 到顶层，
        // Node 会打整段堆栈（`Node.js v22.x` + 内部帧），用户读不出"下一步该干什么"。
        // 走标记 + 出口 die：finally 里的 dialogPolicy.clear() 先跑完，再干净退出。
        const err = new Error(
          `[FAIL] 当前相位是 ${phase}（已开着别的项目）——先 node tools/debug-cli.mjs close-project 回到欢迎相位，再跑本命令`,
        );
        err.kojoPhaseMismatch = true;
        throw err;
      }
      // 4) 等「写权限审批弹窗 / 文件树」**或**失败信号（2026-10-30 遗留 1）：
      //    对不是工程根的目录（fixtures/sugar 这类只有 .kojo、没有 CSV/ERB）应用会当场拒绝并
      //    退回欢迎页，旧实现只等「弹窗/树」⇒ 一律拖到 60s 超时才报「写权限审批 / 文件树」，
      //    用户读到的是"超时"而不是"不接受这个目录"。现在每 250ms 同拍轮询三条失败信号，
      //    命中立刻按固定文案 exit 1（真正慢的成功路径不受影响：树/弹窗一出现就照旧往下走）。
      const budgetMs = clampOpenTimeout(args?.timeout);
      const clickedAt = Date.now();
      let modal = '';
      while (Date.now() - clickedAt < budgetMs) {
        const probe = await cdp
          .evalJs(`(() => {
            const d = document;
            const seen = new Set(${preToastJson});
            const errNotices = [...d.querySelectorAll('.notice.error, .notice[data-kind="error"]')]
              .map((el) => (el.textContent || '').trim())
              .filter((t) => t !== '');
            // 点完之后**新出现**的 toast（应用对这次打开的拒绝原文常在这里）
            const allToasts = [...d.querySelectorAll('.toast')]
              .map((el) => (el.textContent || '').trim())
              .filter((t) => t !== '');
            const freshToasts = allToasts.filter((t) => !seen.has(t));
            const errorToasts = [...d.querySelectorAll('.toast-error, .toast.toast-error')]
              .map((el) => (el.textContent || '').trim())
              .filter((t) => t !== '');
            const st = typeof __kojoDebug !== 'undefined' && __kojoDebug.state ? __kojoDebug.state() : null;
            const modalEl = d.querySelector('.modal[aria-label="写权限确认"]');
            return {
              hasTree: !!d.querySelector('.file-tree'),
              hasModal: !!modalEl,
              phase: st ? String(st.phase ?? '') : 'unknown',
              notices: (st && st.notices && Array.isArray(st.notices.items)) ? st.notices.items : [],
              errorNotices: errNotices,
              freshToasts,
              errorToasts,
            };
          })()`)
          .catch(() => null);
        if (probe?.hasTree) {
          modal = 'tree';
          break;
        }
        if (probe?.hasModal) {
          modal = 'yes';
          break;
        }
        if (probe) {
          const elapsed = Date.now() - clickedAt;
          const verdict = classifyOpenFailure({
            ...probe,
            // 新 toast 走"关键词"那条口径（不无条件算失败：与本命令无关的后台报错不该判死一次正常打开）
            notices: [...(probe.notices ?? []), ...(probe.freshToasts ?? [])],
            modal: false,
            revertedMs: elapsed,
          });
          if (verdict) {
            // 文案要带**应用的原文**：新 toast 优先；退回欢迎页时即便 toast 文案与上一次逐字相同
            // （底片去重把它当成旧的那条）也把屏上最后一条 toast 原文带出来——那是应用真说的那句话
            const reverted = String(probe.phase ?? '') === 'welcome' && elapsed >= 1500;
            const said =
              (probe.freshToasts ?? [])[0] ?? (reverted ? (probe.errorToasts ?? []).slice(-1)[0] : undefined);
            throw openRejectedError(abs, said || verdict.reason);
          }
        }
        await sleep(250);
      }
      if (modal === '') {
        throw new Error(
          `open-project 第 4 步 ${budgetMs}ms 内既没等到写权限审批弹窗、也没等到文件树，且没有可读的失败信号` +
            `（目录：${abs}）——放预算：--timeout <ms>（夹 [3000, 300000]）；先 node tools/debug-cli.mjs dom 看屏上停在哪`,
        );
      }
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
    // 快速失败：固定文案 + exit 1（不是 2——2 是"前置不满足"，这里应用明确拒绝了这次打开）。
    // 相位不对＝前置不满足，走 exit 2 的干净文案（不出堆栈）。
    // 放在 finally 之后打：真壳的 dialogPolicy.clear() 必须先跑完，过期应答不许留在调试面。
    if (failure) {
      if (failure?.kojoOpenRejected) die(failure.message, 1);
      if (failure?.kojoPhaseMismatch) die(failure.message, 2);
      throw failure;
    }
  });
}

async function cmdOpenFile(args, frag) {
  if (!frag) die('open-file 需要路径片段（文件树行的路径包含它即命中）', 2);
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, `!!document.querySelector('.file-tree')`, { timeoutMs: 10000, label: '文件树（先 open-project）' });
    // 树初始折叠：按**目标片段**逐层展开（判据是"树里有没有含 frag 的行"，不是"树里有没有
    // 任何一行文件"）。旧实现用后者 ⇒ 恢复会话后树里只有被恢复那一份的行，另一组的文件
    // 一律报「没有路径含…的行」，看上去像"树空了"（1028 会话恢复批的假阴性源）。
    const expand = await expandCollapsedUntilMatch(cdp, frag);
    const found = await cdp.evalJs(`(() => {
      const rows = [...document.querySelectorAll('.tree-file')];
      const hit = rows.find((r) => (r.getAttribute('title') || r.textContent || '').includes(${JSON.stringify(frag)}));
      if (!hit) return null;
      hit.scrollIntoView({ block: 'center' });
      hit.click();
      return hit.getAttribute('title') || hit.textContent;
    })()`);
    if (!found) {
      die(
        expand === 'no-rows' || expand === 'timeout'
          ? `文件树里没有路径含「${frag}」的行（折叠行已点到头仍未命中：可能不在任何已挂载的组里——树是虚拟化的，先用 dom 看树）`
          : `文件树里没有路径含「${frag}」的行（先用 dom 看树）`,
        1,
      );
    }
    await waitFor(cdp, `!!document.querySelector('.monaco-editor')`, { timeoutMs: 30000, label: 'Monaco 挂载' });
    // 点完 ≠ 打开成功：Monaco 复用同一实例，旧文件会残留几百毫秒（甚至因加载失败一直不换），
    // 旧实现 sleep(400) 后读一次 info 就报成功——「点了 A 却还是 B」的假绿之源。
    // 判据改成 10s 内反复读 editor.info().path，归一化后必须含目标片段。
    const want = normPath(frag);
    const t0 = Date.now();
    let actual = null;
    while (Date.now() - t0 < 10000) {
      const info = await cdp.evalJs('__kojoDebug.editor.info()').catch(() => null);
      actual = info?.path ?? null;
      if (actual && normPath(actual).includes(want)) {
        console.log(`[ok] 已打开：${actual}`);
        console.log(`   语言=${info?.languageId} 行数=${info?.lineCount} EOL=${info?.eol}`);
        return;
      }
      await sleep(200);
    }
    die(
      `[FAIL] 点了文件树里含「${frag}」的行，但 10s 内编辑器没切过去——实际 path：${actual ?? 'null（没有焦点编辑器）'}；` +
        `点到的树行：${found}`,
      1,
    );
  });
}

async function cmdClick(args, selector) {
  if (!selector) die('click 需要选择器', 2);
  await withCdp(async (s, cdp) => {
    const c = await cdpClick(cdp, selector);
    console.log(`[ok] 已点击 ${selector}（坐标 ${c.x},${c.y}）`);
  });
}

/** `keys` 模式：单个 BMP 字符 → CDP 键事件的三段载荷（keydown / char / keyup 共用） */
function charKeyEvent(ch) {
  if (ch === '\n' || ch === '\r') return { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' };
  if (ch === '\t') return { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' };
  if (ch === ' ') return { key: ' ', code: 'Space', keyCode: 32, text: ' ' };
  if (/^[a-zA-Z]$/.test(ch)) {
    return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
  }
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
  // 标点 / 符号：真实浏览器对它们不产固定 `code`（布局相关），key+text 就够走键盘路径
  return { key: ch, keyCode: ch.charCodeAt(0), text: ch };
}

async function cmdType(args, selector, text, mode = 'text') {
  // 反哺修（2026-10-25）：选择器可省——省略时打到**当前焦点元素**。命令面板 / 搜索框
  // 这类输入没有稳定选择器，先 click 点开、再 `type <文本>` 是顺手的驱动形态。
  if (text === undefined) {
    text = selector;
    selector = null;
  }
  if (text === undefined) die('type 需要 [<选择器>] <文本>；省略选择器＝打到当前焦点元素', 2);
  const modeNorm = String(mode ?? 'text').toLowerCase();
  if (!['text', 'keys', 'ime'].includes(modeNorm)) {
    die(`type 的 --mode 只认 text|keys|ime（收到：${mode}）——text=直插（默认）；keys=逐字符真实键盘事件；ime=输入法组合→上屏`, 2);
  }
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
    // 默认 text：`Input.insertText` 直插（行为逐字沿用旧实现——冒烟与脚本都按这个口径写的）
    if (modeNorm === 'text') {
      await cdp.send('Input.insertText', { text });
      console.log(
        `[ok] 已输入 ${text.length} 字符（mode=text）${selector ? ` 到 ${selector}` : `（焦点元素 ${focusInfo?.tag ?? ''}.${focusInfo?.cls ?? ''}）`}`,
      );
      return;
    }
    // keys：逐字符走真实键盘路径（keyDown → char → keyUp）——自动配对、回车缩进、触发字符
    // 这些**只认 keydown** 的行为只有这条路能测到。按码位迭代：非 BMP（emoji 之类）CDP 的
    // char 事件表达不了，如实退化为 insertText 单发并计数（fallback=N），不假装是键盘输入。
    if (modeNorm === 'keys') {
      let fallback = 0;
      for (const ch of text) {
        if (ch.codePointAt(0) > 0xffff) {
          await cdp.send('Input.insertText', { text: ch });
          fallback += 1;
          continue;
        }
        const keyDef = charKeyEvent(ch);
        // `text` 只挂在 `char` 帧上：CDP 的 keyDown **带 text 时会自己插一次字**，再发 char
        // 就是双写（实测 .tree-filter 里 "c1" 变 "cc11"）。keydown 的派发不依赖 text。
        const { text: charText, ...keyOnly } = keyDef;
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 0, ...keyOnly });
        await cdp.send('Input.dispatchKeyEvent', { type: 'char', modifiers: 0, text: charText, ...keyOnly });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, ...keyOnly });
      }
      console.log(
        `[ok] 已输入 ${[...text].length} 字符（mode=keys${fallback > 0 ? `，fallback=${fallback}` : ''}）` +
          `${selector ? ` 到 ${selector}` : `（焦点元素 ${focusInfo?.tag ?? ''}.${focusInfo?.cls ?? ''}）`}`,
      );
      return;
    }
    // ime：先起输入法组合（imeSetComposition，选区落在当前长度）再 insertText 提交上屏。
    // CDP 不支持这个方法时**如实红**，不静默退化成 insertText——退化后的读数会让人以为
    // "输入法路径已经验过"，那是假绿。
    try {
      await cdp.send('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
    } catch (err) {
      die(
        `[FAIL] 本 CDP 端点不支持 Input.imeSetComposition（${String(err?.message ?? err)}）——` +
          `输入法组合→上屏这条路在这台浏览器上验不了（换 Chrome/Edge 或降级用 --mode keys），如实红不退化`,
        1,
      );
    }
    await cdp.send('Input.insertText', { text });
    console.log(
      `[ok] 已输入 ${text.length} 字符（mode=ime）${selector ? ` 到 ${selector}` : `（焦点元素 ${focusInfo?.tag ?? ''}.${focusInfo?.cls ?? ''}）`}`,
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
      // 功能键：缺表时落到 `key.toUpperCase().charCodeAt(0)`（F12 → 70）——Monaco 的 F12
      // 绑定认 123，旧口径下「按 F12」是假按键（2026-10-30 实机验转定义时踩到）。
      f1: { key: 'F1', code: 'F1', keyCode: 112 },
      f2: { key: 'F2', code: 'F2', keyCode: 113 },
      f3: { key: 'F3', code: 'F3', keyCode: 114 },
      f4: { key: 'F4', code: 'F4', keyCode: 115 },
      f5: { key: 'F5', code: 'F5', keyCode: 116 },
      f6: { key: 'F6', code: 'F6', keyCode: 117 },
      f7: { key: 'F7', code: 'F7', keyCode: 118 },
      f8: { key: 'F8', code: 'F8', keyCode: 119 },
      f9: { key: 'F9', code: 'F9', keyCode: 120 },
      f10: { key: 'F10', code: 'F10', keyCode: 121 },
      f11: { key: 'F11', code: 'F11', keyCode: 122 },
      f12: { key: 'F12', code: 'F12', keyCode: 123 },
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
    const snap = await cdp.evalJs('__kojoDebug.dom.snapshot()');
    emit(snap, (v) => console.log(JSON.stringify(v, null, 2)));
  });
}

async function cmdEvents(args, nArg) {
  const n = Number(nArg ?? 40) || 40;
  await withCdp(async (s, cdp) => {
    await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 10000, label: '__kojoDebug 装载' });
    const list = await cdp.evalJs(`__kojoDebug.bus.recent(${n})`);
    // --json 的键序：count → events（`t` 是页内 performance.now()，原样给，不折算）
    emit({ count: list?.length ?? 0, events: list ?? [] }, (reading) => {
      // e.t 与探针同域（performance.now() 页内钟，口径修②）——不再是墙钟：相对首条的偏移毫秒展示
      const firstT = reading.events?.[0]?.t;
      for (const e of reading.events ?? []) {
        console.log(`+${Math.max(0, Math.round(e.t - firstT))}ms ${e.name} ${JSON.stringify(e.payload).slice(0, 160)}`);
      }
      console.log(`（最近 ${reading.count} 条）`);
    });
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
    // 形态归一（2026-10-30 第二批真壳实测）：`profile 2000` 是最顺手的写法，但旧分发把
    // positional[0] 原样当子命令 ⇒ mode='2000' 两个分支都不进、`Profiler.start` 压根没跑，
    // 直接 `Profiler.stop` 抛 `CDP No recording profiles found`（还带整段栈）。
    // 这里把它归一成 run + ms；未知子命令则一次说清，不再靠 CDP 报错兜底。
    let mode = sub ?? 'run';
    let budget = msArg;
    if (/^\d+$/.test(String(mode))) {
      budget = mode;
      mode = 'run';
    }
    if (mode !== 'run' && mode !== 'start') {
      die(`profile 只认 run / start，或直接给毫秒数（profile 3000）；收到「${sub}」`, 2);
    }
    if (mode === 'start') {
      die(
        'profile start/stop 跨 CLI 调用拿不到数据（Profiler 绑定 CDP 连接，连接断采样即丢——实测）。\n' +
          '用一次连接内完成的形式：node tools/debug-cli.mjs profile run [ms]（缺省 3000）',
        2,
      );
    }
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 }).catch(() => {});
    const runMs = mode === 'run' ? Math.max(300, Number(budget ?? 3000) || 3000) : 0;
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

/* ------------------------------ 体检（doctor） ------------------------------ */

/**
 * `doctor`：把 `debug-doctor.mjs` 那七项判据接到 CLI 面上。
 *
 * 为什么是 import 而不是 spawn / 复制：判据只有一份才有意义——复制出来的第二份迟早与第一份
 * 漂移，而"体检说没事、真跑起不来"正是体检工具最不能犯的错；spawn 又会多一层子进程与
 * 退出码转译（还丢 `--json` 的原始键序）。所以直接调 `runDoctor`，人读形态用它的
 * `formatHuman`，退出码用它的 `exitCodeFor`（任一 FAIL ⇒ 1，WARN 不改变）。
 *
 * `--repo` 缺省取**本 CLI 所在的仓库**（不是 cwd）：会话目录按工作树哈希隔离
 * （`sessionDir(REPO)`），在别的目录下敲命令时要看的仍然是这棵树的会话。
 *
 * `--json` 与独立脚本 `debug-doctor.mjs --json` 保持同一形态（缩进 2），两份输出可逐字对拍。
 */
async function cmdDoctor(args) {
  const repo = args.repo ? path.resolve(args.repo) : REPO;
  const result = await runDoctor({
    repo,
    nodeVersion: process.versions.node,
    probe: (port) => probePort(port),
    isAlive: pidAlive,
  });
  if (jsonOut) console.log(JSON.stringify(result, null, 2));
  else console.log(formatHuman(result));
  process.exit(exitCodeFor(result));
}

/* ---------------------------- 指针族（CDP 真鼠标） ---------------------------- */

/**
 * 这四个命令只是 `debug-lib` 那批原语的**接线**，判据不在这里：`resolvePoint` 负责
 * 选择器→元素中心 + `elementFromPoint` 自证（被遮挡时告警、不冒充成功），
 * `mousePath` 负责拖拽中间帧。CLI 这层要做的只有两件事：把位置参数解析对、把读数打出来。
 */

async function cmdHover(args, targetArg) {
  const target = requireTarget(targetArg, 'hover', '<选择器|"x,y">');
  const settleMs = Math.max(0, numberOption('--settle', args.settle, 120));
  await withCdp(async (s, cdp) => {
    const point = await cdpHover(cdp, cdpTarget(target), { settleMs });
    emit({ target: jsonTarget(target), point, settleMs }, () =>
      console.log(`[ok] 已悬停 ${describeTarget(target)}（落点 ${point.x},${point.y}，settle ${settleMs}ms）`),
    );
  });
}

async function cmdDblClick(args, targetArg) {
  const target = requireTarget(targetArg, 'dblclick', '<选择器|"x,y">');
  await withCdp(async (s, cdp) => {
    const point = await cdpDoubleClick(cdp, cdpTarget(target));
    emit({ target: jsonTarget(target), point }, () =>
      console.log(`[ok] 已双击 ${describeTarget(target)}（落点 ${point.x},${point.y}）`),
    );
  });
}

async function cmdDrag(args, fromArg, toArg) {
  const from = requireTarget(fromArg, 'drag', '起点 <选择器|"x,y">');
  const to = requireTarget(toArg, 'drag', '终点 <选择器|"x,y">');
  // steps 缺省 8（与 cdpDrag 默认同值）；非法值不静默落默认——拖拽帧数是"为什么没拖动"的第一嫌疑
  const steps = Math.max(1, Math.round(numberOption('--steps', args.steps, 8)));
  await withCdp(async (s, cdp) => {
    const r = await cdpDrag(cdp, cdpTarget(from), cdpTarget(to), { steps });
    emit({ from: r.from, to: r.to, steps, moves: r.moves }, (v) =>
      console.log(
        `[ok] 已拖拽 ${describeTarget(from)} → ${describeTarget(to)}` +
          `（${v.moves} 帧：${v.from.x},${v.from.y} → ${v.to.x},${v.to.y}）`,
      ),
    );
  });
}

async function cmdWheel(args, targetArg) {
  const target = requireTarget(targetArg, 'wheel', '<选择器|"x,y">');
  const dx = numberOption('--dx', args.dx, 0);
  const dy = numberOption('--dy', args.dy, 0);
  // 两个 delta 都是 0 就是一条空事件：CDP 会照发，页面一动不动，用户看到的是"滚轮坏了"。
  // 当场红（exit 2）比让它静静什么都不做强。
  if (dx === 0 && dy === 0) die('wheel 需要滚动量：--dx <n> 和/或 --dy <n>（都为 0 等于不滚）', 2);
  await withCdp(async (s, cdp) => {
    const point = await cdpWheel(cdp, cdpTarget(target), { dx, dy });
    emit({ target: jsonTarget(target), point, dx, dy }, () =>
      console.log(`[ok] 已滚轮 ${describeTarget(target)}（落点 ${point.x},${point.y}，dx=${dx} dy=${dy}）`),
    );
  });
}

/* -------------------------- 语义族（页面调试面） -------------------------- */

/**
 * 语义族公共前置：等 `__kojoDebug` 装载（照 `cmdState` 的 waitFor）→ 确认 `.editor` 分面在场
 * → 确认**有焦点编辑器**。
 *
 * 为什么"没有焦点编辑器"要红而不是给 `(空)`：这两种情况的处置完全不同——`(空)` 是"这里确实
 * 没有定义/引用"（一条有效读数），没有编辑器是"你还没打开文件"（前置不满足）。混成一样，
 * 用户会去查语言服务，而真正该做的是 `open-file`。
 */
async function ensureEditor(cdp) {
  await waitFor(cdp, 'window.__kojoDebug !== undefined', { timeoutMs: 10000, label: '__kojoDebug 装载' });
  const has = await cdp.evalJs(
    '(() => { const d = window.__kojoDebug; return !!(d && d.editor && typeof d.editor === "object"); })()',
  );
  if (!has) die('页面调试面没有 editor 分面（壳/页面跑的是旧构建？stop 后重开 serve 或 shell 再试）', 2);
  const info = await cdp.evalJs('__kojoDebug.editor.info()');
  if (!info) die('当前没有焦点编辑器——先 open-project <目录> + open-file <片段>（或 click 编辑器），再查语义读数', 2);
  return info;
}

/**
 * 调一个语义读数。
 *
 * 这些 API 全部返回 Promise（走 Monaco provider 链，有一次语言服务往返）。`Cdp.evalJs` 里
 * `awaitPromise: true`（debug-lib.mjs 的 `Runtime.evaluate` 参数），所以**不需要**在页内再包
 * 一层 async IIFE、也不需要 sleep 猜完成时机；反过来说，谁把 awaitPromise 关掉，拿到的会是
 * Promise 的序列化壳（`{}`）——它看起来恰好长得像"没有结果"，是最坏的一种假绿/假红。
 */
function querySemantic(cdp, api, at, timeoutMs = 30000) {
  return cdp.evalJs(`__kojoDebug.editor.${api}(${at.line}, ${at.column})`, timeoutMs);
}

/** 语义族共同的「查的位置」行：行列一错位，读数看上去照样"有内容"，只能靠回显抓 */
function atLine(at) {
  return `at ${at.line}:${at.column}`;
}

async function cmdDefinition(args, lineArg, columnArg) {
  const at = requireAt(lineArg, columnArg, 'definition');
  await withCdp(async (s, cdp) => {
    await ensureEditor(cdp);
    const items = await querySemantic(cdp, 'definitionAt', at);
    const list = Array.isArray(items) ? items : [];
    emit({ at, count: list.length, items: list }, () => {
      console.log(`${atLine(at)} · ${list.length === 0 ? '(空)' : `${list.length} 条`}`);
      for (const loc of list) console.log(`  ${loc.path}:${loc.line}:${loc.column}`);
    });
  });
}

async function cmdReferences(args, lineArg, columnArg) {
  const at = requireAt(lineArg, columnArg, 'references');
  await withCdp(async (s, cdp) => {
    await ensureEditor(cdp);
    const reading = await querySemantic(cdp, 'referencesAt', at);
    const list = Array.isArray(reading?.items) ? reading.items : [];
    const total = Number.isInteger(reading?.total) ? reading.total : list.length;
    // 截断必须说清：只报"50 条"会让人以为整个工程就 50 处引用
    const truncated = total > list.length;
    emit({ at, total, count: list.length, truncated, items: list }, () => {
      if (list.length === 0) {
        console.log(`${atLine(at)} · 共 ${total} 条 → (空)`);
        return;
      }
      console.log(`${atLine(at)} · 共 ${total} 条（显示 ${list.length} 条${truncated ? '，已截断' : ''}）`);
      for (const loc of list) console.log(`  ${loc.path}:${loc.line}:${loc.column}`);
    });
  });
}

async function cmdCodeActions(args, lineArg, columnArg) {
  const at = requireAt(lineArg, columnArg, 'code-actions');
  await withCdp(async (s, cdp) => {
    await ensureEditor(cdp);
    const items = await querySemantic(cdp, 'codeActionsAt', at);
    const list = Array.isArray(items) ? items : [];
    emit({ at, count: list.length, items: list }, () => {
      console.log(`${atLine(at)} · ${list.length === 0 ? '(空)' : `${list.length} 条`}`);
      for (const a of list) {
        // 只读摘要：告诉你"有哪些动作"，不说"改成什么"（apply 是 commands run 的事）
        console.log(`  ${a.isPreferred ? '*' : ' '} [${a.kind || '-'}] ${a.title}（${a.hasEdit ? '有编辑' : '仅命令'}）`);
      }
    });
  });
}

async function cmdSignature(args, lineArg, columnArg) {
  const at = requireAt(lineArg, columnArg, 'signature');
  await withCdp(async (s, cdp) => {
    await ensureEditor(cdp);
    const sig = (await querySemantic(cdp, 'signatureAt', at)) ?? null;
    emit({ at, signature: sig }, () => {
      if (!sig) {
        console.log(`${atLine(at)} · (空)`);
        return;
      }
      console.log(`${atLine(at)} · ${sig.label}`);
      const active = Number(sig.activeParameter);
      (sig.parameters ?? []).forEach((p, i) => console.log(`  ${i === active ? '→' : ' '} 参数 ${i}: ${p}`));
      console.log(`  当前参数下标：${Number.isFinite(active) ? active : 0}（0 基，与 provider 同口径）`);
      if (sig.documentation) console.log(`  文档：${String(sig.documentation).slice(0, 200)}`);
    });
  });
}

async function cmdSymbols() {
  await withCdp(async (s, cdp) => {
    await ensureEditor(cdp);
    const items = await cdp.evalJs('__kojoDebug.editor.documentSymbols()', 30000);
    const list = Array.isArray(items) ? items : [];
    emit({ count: list.length, items: list }, () => {
      if (list.length === 0) {
        console.log('(空)');
        return;
      }
      for (const sym of list) {
        const indent = '  '.repeat(Math.max(0, Number(sym.depth) || 0));
        console.log(`${indent}${sym.name}${sym.kind ? `  (kind=${sym.kind})` : ''}`);
      }
    });
  });
}

/** Monaco `MarkerSeverity` 的四档（1/2/4/8）；未知值原样打出来，不编造"错误" */
const SEVERITY_NAME = { 1: 'Hint', 2: 'Info', 4: 'Warning', 8: 'Error' };

async function cmdDiagnostics() {
  await withCdp(async (s, cdp) => {
    await ensureEditor(cdp);
    const items = await cdp.evalJs('__kojoDebug.editor.diagnostics()', 30000);
    const list = Array.isArray(items) ? items : [];
    emit({ count: list.length, items: list }, () => {
      if (list.length === 0) {
        console.log('(空)');
        return;
      }
      console.log(`${list.length} 条诊断（当前文档）`);
      for (const d of list) {
        const sev = SEVERITY_NAME[d.severity] ?? `severity=${d.severity}`;
        console.log(`  ${d.line}:${d.column} [${sev}] ${d.message}${d.source ? `（${d.source}）` : ''}`);
      }
    });
  });
}

/* ------------------------------ main ------------------------------ */

/**
 * 参数解析（纯函数，单测直接从源码取来跑）。
 *
 * 铁律：**带值参数必须在这里吃掉**——没吃掉的 `--steps 4` 会变成两个位置参数
 * （`4` 落到 positional[0]），于是 `drag .a .b --steps 4` 的终点变成 `"4"`、`--steps`
 * 本身变成选择器。本仓库已经为此踩过一次坑（`type --mode` 的 mode 被当成待输入文本），
 * 所以 `--steps / --dx / --dy / --settle / --repo` 一律走 `argv[++i]`。
 */
export function parseArgs(argv) {
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
    else if (a === '--settle') opts.settle = argv[++i];
    else if (a === '--timeout') opts.timeout = argv[++i];
    // `type --mode text|keys|ime`：带值参数必须在这里吃掉，否则 mode 会被当成位置参数
    // （第二个位置参数是**待输入文本**，被占走就等于把字打错地方）
    else if (a === '--mode') opts.mode = argv[++i];
    // 指针族 / 体检的带值参数（同上：不吃掉就会污染 positional——drag 有两个位置参数）
    else if (a === '--steps') opts.steps = argv[++i];
    else if (a === '--dx') opts.dx = argv[++i];
    else if (a === '--dy') opts.dy = argv[++i];
    else if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--browser') opts.browser = argv[++i];
    // --json 是**布尔**开关：放进 opts（命令直接读）而不是 flags（flags 只喂给 serve/shell 的形态判定）
    else if (a === '--json') opts.json = true;
    else if (a === '--headless' || a === '--no-browser' || a === '--record' || a === '--fresh' || a === '--writable' || a === '--full' || a === '--isolate' || a === '--no-debug-api') flags.push(a);
    else positional.push(a);
  }
  return { flags, opts, positional };
}

const [rawCmd, ...rest] = process.argv.slice(2);
const { flags, opts, positional } = parseArgs(rest);
// 输出闸门在这里落定一次（之后所有命令共用一个 `jsonOut`，不再各自判 opts.json）
jsonOut = Boolean(opts.json);
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
  wait: () => cmdWait(opts, positional[0]),
  assert: () => cmdAssert(opts, positional[0]),
  state: cmdState,
  commands: () => cmdCommands(positional, positional[0]),
  run: () => cmdRun(positional, positional[0], opts.settle),
  'close-project': cmdCloseProject,
  'open-project': () => cmdOpenProject(opts, positional[0], flags),
  'open-file': () => cmdOpenFile(positional, positional[0]),
  click: () => cmdClick(positional, positional[0]),
  type: () => cmdType(positional, positional[0], positional[1], opts.mode),
  key: () => cmdKey(positional, positional[0], positional[1]),
  screenshot: () => cmdScreenshot(flags, positional[0]),
  dom: cmdDom,
  events: () => cmdEvents(positional, positional[0]),
  invoke: () => cmdInvoke(positional, positional[0], positional[1]),
  perf: () => cmdPerf(positional, positional[0], positional[1]),
  profile: () => cmdProfile(positional, positional[0], positional[1]),
  // 体检（复用 debug-doctor 的判据）
  doctor: () => cmdDoctor(opts),
  // 指针族（CDP 真鼠标）：坐标写成 "x,y" **一个**位置参数
  hover: () => cmdHover(opts, positional[0]),
  dblclick: () => cmdDblClick(opts, positional[0]),
  drag: () => cmdDrag(opts, positional[0], positional[1]),
  wheel: () => cmdWheel(opts, positional[0]),
  // 语义族（页面调试面 editor.*）：<行> <列> **1 基**
  definition: () => cmdDefinition(opts, positional[0], positional[1]),
  references: () => cmdReferences(opts, positional[0], positional[1]),
  'code-actions': () => cmdCodeActions(opts, positional[0], positional[1]),
  signature: () => cmdSignature(opts, positional[0], positional[1]),
  symbols: () => cmdSymbols(),
  diagnostics: () => cmdDiagnostics(),
};
if (!rawCmd || !commands[rawCmd]) {
  console.log('用法：node tools/debug-cli.mjs <子命令> […]\n  ' + [...Object.keys(commands)].join(' · '));
  // 带值参数的速查（文件头的完整清单很长，这里只点最常被问的几条参数形态）
  console.log('  type [<选择器>] <文本> [--mode text|keys|ime]   # 默认 text；keys=真实键盘路径；ime=输入法组合→上屏');
  console.log('  open-project <目录> [--writable] [--timeout <ms>]   # 第 4 步预算，默认 60000，夹 [3000,300000]');
  console.log('  doctor [--json] [--repo <路径>]   # 七项体检；任一 FAIL ⇒ 退出码 1（WARN 不改变）');
  console.log('  hover <选择器|"x,y"> [--settle <ms>] · dblclick <选择器|"x,y">   # CDP 真鼠标；坐标是**一个**参数');
  console.log('  drag <起点> <终点> [--steps <n>] · wheel <选择器|"x,y"> [--dx <n>] [--dy <n>]');
  console.log('  definition|references|code-actions|signature <行> <列> · symbols · diagnostics');
  console.log('       ↑ 行列 **1 基**（与 Monaco position 同口径）；空结果打 (空)、退出码 0');
  console.log('  --json   # status/state/commands/dom/events/wait/assert + 上面三族：stdout 只有一个 JSON 文档');
  process.exit(rawCmd ? 1 : 0);
}
await (async () => {
  try {
    await commands[rawCmd]();
  } catch (err) {
    // 顶层兜底（2026-10-30 第二批真壳实测）：子命令内部 throw 出来的错误（CDP 报错、路径对拍
    // 失败、profile 采样异常……）原先让 Node 打整段栈，agent 读到的是「Node.js v22.22.2」而不是
    // 「哪一步错了」。这里统一成一行 [FAIL]，栈留在 KOJO_DEBUG_TRACE=1 时才打（排障仍可拿）。
    console.error(`[FAIL] ${String(err?.message ?? err)}`);
    if (process.env.KOJO_DEBUG_TRACE) console.error(String(err?.stack ?? ''));
    process.exit(1);
  }
})();
