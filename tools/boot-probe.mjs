/**
 * L1-0 首屏取证共用层（2026-10-16 首屏批）。
 *
 * `tools/smoke-tauri-dom.mjs`（dev 形态）与 `tools/boot-marks.mjs`（release 形态）**共用**这一份，
 * 不再各抄一遍采样函数——原先两处 `collectBoot` 靠注释「改一处必须改两处」维系，迟早漂。
 * 纯逻辑、零副作用（可被 import 而不起壳；被 import 不起壳是本仓 tools 的纪律）。
 * 底色真源那一路要读 CSS，但只在 `expectedBootBg()` 被调用时才 `readFileSync`——import 仍然零副作用，
 * 而且本模块只被 `tools/**` 与 `tools/tests/**` import，绝不进 app 产物。
 *
 * ## 两条硬断言的取证口径（BOARD §I L1-0）
 *
 * **①「开机 ≤500ms 内 `#root` 非空 或 body 计算底色已落到该 `data-theme` 档应有的 `--bg`」**
 *  样本 = `index.html` 内联脚本落在 `window.__kojoBootMarks` 的 parse 期读数；
 *  第三方 = `expectedBootBg(档)` 从**源码现读**的 `--bg`（dark 档真源在 `packages/app/src/styles.css`
 *  的基础 `:root`，light / mint-dark 在 `packages/app/src/themes/<档>.css`）。
 *  **三方才有线**：内联字面量（parse 期）· 挂载后计算值 · 该档主题源里的 `--bg`——只比前两枚，
 *  两个手写源同时漂成第三种颜色就抓不到（这条闸的真实身份是跨文件对撞，不是页内自洽）。
 *  - `htmlParsed`（自导航起点 ms）≤ 500 且 `bgAtParse` == 该档 `--bg` —— 内联 `<style>` 一解析就生效
 *    且不会退场，所以这条一旦成立就等价于「≤500ms 内屏幕上已不是 WebView 默认白」；
 *  - 或 `t500`（`setTimeout(…, 500)` 的现场采样）里 `rootChildren > 0` —— React 已真挂载。
 *    容差 `ROOT_SAMPLE_GRACE_MS`：定时器在启动高峰会被挤后，取 750ms 上限（超过就是真慢，不是抖动）。
 *  再加两枚钉：**内联底色 == 该档 `--bg` == 挂载后计算底色**（防「内联那份是第二真相源」与同漂）与
 *  `#boot-splash` 已被移除（引导层必须退场，不许盖在界面上）。
 *  ⚠ 判据里**没有「深色」这件事**：不变量是「屏幕上不是 WebView 默认白」，不是「屏幕上是深色」。
 *  主题系统（`b051773` 地基 + `a595355` 三主题）之后浅色档 `--bg` = `#f6f8fa`，旧的「亮度 < 96」
 *  硬编码会把浅色用户的正常开机报成故障（把用户设置当红），故整枚判据改成对撞该档真源。
 *  底色写法统一走 `sameRgb`：页内 `getComputedStyle` 给 `rgb(30, 34, 39)`、源码写 `#1e2227`，
 *  它们是同一个颜色，比字符串原文必红。
 *
 * **②「欢迎页可点前不得出现 monaco 请求」**
 *  判定时点 = `boot.welcomeInteractive`（自导航起点 ms）。**两个数据源，优先级写死**：
 *  1. **CDP Network 域**（`captureBootNetwork`）：`Network.enable` + `Page.reload` 后收
 *     `Network.requestWillBeSent`，**只认本轮导航 `loaderId` 的事件**，并以「本轮第一个 Document
 *     请求的时刻」为锚点做差得到与 `performance.now()` 同量纲的相对毫秒，再按可点时刻切分。
 *     这是**取证首选**——它是浏览器网络栈的第一手记录，不受页内缓冲上限影响；
 *     锚点法故意不去猜 CDP 绝对时基的语义（跨版本不稳，猜错就把可点前切出 0 条 = 恒真假绿）。
 *  2. 页内 `performance.getEntriesByType('resource')`（`judgeBoot` 的 `a2Timeline`）：**回退口径**。
 *     它会被资源时间线缓冲上限截断，dev 形态 monaco 模块图 ~1338 条，组长实测出现过 `total=29`
 *     这种明显数不全的读数 ⇒ 单靠它判绿是假绿。故本工具把 Network 域采到与否、两条口径的
 *     条目数差**一律打印出来**，采不到才退回时间线并在结论里标注口径。
 *  3. **反「空匹配」自证**：可点**之后**必须真的看得到 monaco 请求（idle 预取会拉 ProjectView chunk）。
 *     整轮一条 monaco 都没有 = 匹配面失效，此时**不许判绿**（否则断言②退化成恒真）。
 *
 * ## 匹配面（MONACO_HINT_RE）
 * 只认 **monaco-editor 的模块 / 懒 chunk 名**（dev 下 URL 含 `monaco-editor`，打包后是
 * `ProjectView-*.js`、`editor.worker`、`EditorPane`）。**不含**本仓自己的 `src/monaco/*.ts`——
 * `src/monaco/reveal-position.ts` 常年挂在 boot 图上，按目录名过滤会假红（实测踩过）。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** monaco 请求特征（口径见文件头「匹配面」） */
export const MONACO_HINT_RE = /monaco-editor|ProjectView|EditorPane|editor\.worker/i;

/** 断言①-b 的 t+500ms 采样容差（setTimeout 在启动高峰会被挤后；超过即真慢，不是抖动） */
export const ROOT_SAMPLE_GRACE_MS = 750;

/** 引导四标记的打印顺序 */
export const BOOT_MARK_NAMES = [
  'boot.htmlParsed',
  'boot.firstPaint',
  'boot.welcomeInteractive',
  'boot.editorInteractive',
];

/**
 * **页内采样函数**：`toString()` 后经 CDP `Runtime.evaluate` 在页面里执行。
 * ⚠ 函数体必须自包含——**禁止引用本模块或调用方的任何外层作用域**。
 * 相比前一批新增 `timeOrigin` / `navType`（Network 域取证要把事件时刻换算到同一时基）
 * 与「可点之后」的 monaco 计数（反空匹配自证）；本批再新增 `dataTheme`（断言①要按**这一档**的
 * 真源底色来判，档位只有页面自己知道，node 侧读不到）。
 */
export function collectBoot() {
  var marks = window.__kojoBootMarks || {};
  var boot = {};
  try {
    var stats = window.__kojoPerf.stats();
    for (var i = 0; i < stats.length; i++) {
      if (stats[i].name.indexOf('boot.') === 0) boot[stats[i].name] = { last: stats[i].last, note: stats[i].note };
    }
  } catch (e) {
    /* 探针未装 = 内核未起；welcome 判据会照常红，这里不额外抛 */
  }
  var welcome = boot['boot.welcomeInteractive'] ? boot['boot.welcomeInteractive'].last : null;
  var RE = /monaco-editor|ProjectView|EditorPane|editor\.worker/i;
  var rs = performance.getEntriesByType('resource');
  var before = welcome === null ? [] : rs.filter(function (r) { return r.startTime < welcome; });
  var monoBefore = before.filter(function (r) { return RE.test(r.name); }).map(function (r) { return r.name; });
  var monoAll = rs.filter(function (r) { return RE.test(r.name); }).map(function (r) { return r.name; });
  // 时间线条目 [完整 URL, startTime(ms)]——startTime 与 boot.* 同基（页内 performance.now()）。
  // 用途：给 CDP Network 事件做**同时基校准**（Network 的 timestamp/wallTime 与页内不同钟，
  // 硬猜时基就会把刀切错位置：实测把可点前切出过 0 条 / 整轮 33 条两种假结论）。
  var tl = [];
  for (var j = 0; j < rs.length && tl.length < 900; j++) {
    var nm = rs[j].name;
    if (typeof nm === 'string' && nm.length < 300 && Number.isFinite(rs[j].startTime)) {
      tl.push([nm, Math.round(rs[j].startTime * 10) / 10]);
    }
  }
  return JSON.stringify({
    marks: marks,
    boot: boot,
    welcome: welcome,
    bgNow: getComputedStyle(document.body).backgroundColor,
    // 档位（index.html 早应用脚本落的属性；缺省按 dark，与 `ui/theme-pref.ts` 的归一口径一致）
    dataTheme: document.documentElement.getAttribute('data-theme') || 'dark',
    splashGone: !document.getElementById('boot-splash'),
    timeOrigin: performance.timeOrigin,
    now: performance.now(),
    navType: (performance.getEntriesByType('navigation')[0] || {}).type || '',
    resourceCount: rs.length,
    beforeCount: before.length,
    monacoBeforeCount: monoBefore.length,
    monacoBefore: monoBefore.slice(0, 5),
    monacoTotalCount: monoAll.length,
    monacoTotalSample: monoAll.slice(0, 5),
    timeline: tl,
  });
}

/**
 * 颜色解析：`rgb()/rgba()` **与** `#rgb/#rrggbb` 两种写法都要能吃。
 * 页内 `getComputedStyle` 交回来的是 `rgb(30, 34, 39)`，而主题源里的真源写的是 `#1e2227`——
 * 同一个颜色两种写法，所以断言①一律先解析再比三元组，不比字符串原文。
 * 解析不了返回 null（调用方按「没有底色」处理）。
 */
export function parseRgb(s) {
  const text = String(s ?? '').trim();
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(text);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (!h) return null;
  const hex = h[1].length === 3 ? h[1].replace(/./g, (c) => c + c) : h[1];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: 1,
  };
}

/**
 * 「同一个颜色」判据：只比 r/g/b 三元组（`#1e2227` 与 `rgb(30, 34, 39)` 同判）。
 * alpha 只在「不透明」这一侧才有意义 ⇒ 任一侧 alpha < 0.5 直接判不等
 * （全透明在屏幕上就是 WebView 默认白，不算「底色落到位」）。
 */
export function sameRgb(a, b) {
  const x = parseRgb(a);
  const y = parseRgb(b);
  if (!x || !y) return false;
  if (x.a < 0.5 || y.a < 0.5) return false;
  return x.r === y.r && x.g === y.g && x.b === y.b;
}

/** 断言①底色真源所在文件（相对仓库根）：dark 档的基础 token 就住在 `styles.css` 的 `:root` */
const BOOT_BG_SOURCE_FILES = {
  dark: 'packages/app/src/styles.css',
  light: 'packages/app/src/themes/light.css',
  'mint-dark': 'packages/app/src/themes/mint-dark.css',
};

/** 档位归一：读不到 / 非法 ⇒ dark（同 `index.html` 早应用脚本与 `ui/theme-pref.ts`，不造第四种归一） */
const normalizeBgTheme = (theme) => (theme === 'light' || theme === 'mint-dark' ? theme : 'dark');

/**
 * 断言①的**第三方真源**：该 `data-theme` 档源码里 `--bg` 的字面量原文。
 * 闸塌了必须响——文件读不到 / `--bg` 抽不到 / 抽出来的值不是可比对的颜色写法，一律抛错，
 * **绝不静默回落成某个颜色常量**（回落等于把跨文件对撞降级成自我循环，从此再也抓不到漂移）。
 */
export function expectedBootBg(theme) {
  const name = normalizeBgTheme(theme);
  const rel = BOOT_BG_SOURCE_FILES[name];
  let css = '';
  try {
    css = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  } catch (e) {
    throw new Error(`断言①底色真源读不到：${name} 档应来自 ${rel}（${String(e && e.message ? e.message : e).slice(0, 140)}）`);
  }
  // 注释里也写着 `--bg` 这类字面量（各主题文件顶部的「锚定不变量」清单）⇒ 先剥注释再抽声明
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const m = /(?:^|[\s;{])--bg\s*:\s*([^;{}]+);/.exec(stripped);
  if (!m) throw new Error(`断言①底色真源塌了：${rel} 里抽不到 --bg 声明（${name} 档）`);
  const value = m[1].trim();
  if (parseRgb(value) === null) {
    throw new Error(
      `断言①底色真源塌了：${rel} 的 --bg = ${JSON.stringify(value)} 不是 rgb()/rgba()/#rgb/#rrggbb 写法（${name} 档），无法与页内计算底色对撞`,
    );
  }
  return value;
}

/** boot 标记读数格式化（值是自导航起点 ms；缺失显示「未记录」） */
export function fmtBoot(v) {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)}ms` : '未记录';
}

/**
 * 断言①＋断言②（时间线回退口径）的**纯判定**：入 = `collectBoot()` 的解析结果 + 该档底色真源。
 * `expectedBg` 由调用方现读（`expectedBootBg(b.dataTheme)`）——它就是断言①的**第三方**，
 * 少了这一方只剩「内联 vs 挂载后」两方比对，两个手写源同时漂成第三种颜色便再也抓不到。
 * 全部判据走布尔字段返回，红在哪一条由调用方打印 `why`。
 */
export function judgeBoot(b, expectedBg) {
  const marks = (b && b.marks) || {};
  const t500 = marks.t500 && typeof marks.t500.at === 'number' ? marks.t500 : null;
  const earlyBgOk = typeof marks.htmlParsed === 'number' && marks.htmlParsed <= 500 && sameRgb(marks.bgAtParse, expectedBg);
  const earlyRoot = t500 !== null && t500.rootChildren > 0 && t500.at <= ROOT_SAMPLE_GRACE_MS;
  // 三方对撞：挂载后 == 该档真源 --bg，且挂载后 == 内联 parse 期读数
  const pinOk = sameRgb(b.bgNow, expectedBg) && sameRgb(b.bgNow, marks.bgAtParse);
  const splashGone = b.splashGone === true;
  const haveWelcome = typeof b.welcome === 'number';
  return {
    a1: (earlyBgOk || earlyRoot) && pinOk,
    earlyBgOk,
    earlyRoot,
    pinOk,
    splashGone,
    /** 断言②的时间线口径（回退口径；有 Network 取证时仅作对照） */
    a2Timeline: haveWelcome && b.monacoBeforeCount === 0 && b.monacoTotalCount > 0,
    haveWelcome,
    /** 打印行靠这两枚自证「我按哪档、按哪个真源底色判的」 */
    expectedBg,
    theme: (b && b.dataTheme) || 'dark',
    htmlParsed: marks.htmlParsed,
    bgAtParse: marks.bgAtParse,
    bgNow: b.bgNow,
    t500Root: t500 ? t500.rootChildren : null,
    t500At: t500 ? t500.at : null,
  };
}

/**
 * CDP Network 事件时刻的**时基语义**在历史上有三种（相对 timeOrigin 的 ms / 自 UNIX 纪元的 ms /
 * 自 UNIX 纪元的秒）。不猜：拿页内 `timeOrigin` 把三种都算一遍，取「首请求落在合理窗口」的那一种，
 * 全都对不上就返回 null（调用方如实标注「口径未定」，不硬判）。
 */
const PLAUSIBLE_FIRST_MS = [-2000, 15 * 60 * 1000];
export function detectRelMode(samples, timeOrigin) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  if (typeof timeOrigin !== 'number' || !Number.isFinite(timeOrigin)) return null;
  const modes = [
    { name: 'relativeToTimeOrigin', f: (ts) => ts },
    { name: 'epochMs', f: (ts) => ts - timeOrigin },
    { name: 'epochSeconds', f: (ts) => ts * 1000 - timeOrigin },
  ];
  for (const m of modes) {
    const ok = samples.every((ts) => {
      const rel = m.f(ts);
      return Number.isFinite(rel) && rel >= PLAUSIBLE_FIRST_MS[0] && rel <= PLAUSIBLE_FIRST_MS[1];
    });
    if (ok) return m.name;
  }
  return null;
}

/** 按已定时基把 Network 事件时刻换算成「自导航起点 ms」（口径不可用 → null） */
export function relTimeOf(ts, mode, timeOrigin) {
  if (mode === 'relativeToTimeOrigin') return ts;
  if (mode === 'epochMs') return ts - timeOrigin;
  if (mode === 'epochSeconds') return ts * 1000 - timeOrigin;
  return null;
}

/** URL 归一（只取 pathname）：`?worker` / `?v=hash` 这类查询在两个数据源里写法不一致，
 *  对齐时按路径匹配即可（同一 URL 出现多次取最早那次）。 */
export function urlKey(u) {
  const s = String(u ?? '');
  try {
    return new URL(s).pathname;
  } catch {
    return s.replace(/[?#].*$/, '');
  }
}

const median = (xs) => {
  if (xs.length === 0) return null;
  const a = [...xs].sort((p, q) => p - q);
  return a[Math.floor(a.length / 2)];
};

/**
 * **时基校准**（断言②最容易切错刀的地方）：把 CDP Network 事件的时刻折算到
 * 页内 `performance.now()` 的时间轴上（也就是 `boot.welcomeInteractive` 所在的那条轴）。
 *
 * 三级择优，全都能被读数证伪：
 * 1. `timeline-fit`：拿页内资源时间线与本轮 Network 事件的**同 URL 交集**逐条求差、取中位数。
 *    这条最硬——它不猜 CDP 的任何绝对语义，而是让页面自己给一批「这个请求在页内钟上是几毫秒」。
 *    交集 ≥ 5 条才敢用（release 形态一整轮才 33 条、dev 形态几百条重叠，都远超门槛）。
 * 2. `wall-clock`：`Network.requestWillBeSent.wallTime`（秒、UNIX 纪元，语义跨版本唯一）
 *    减 `performance.timeOrigin`。用于交集太少但 wallTime 齐的情况。
 * 3. `document-anchor`：本轮第一个 Document 请求为 t0。只有前两条都不可用才退到这里，
 *    且此时 `judgeNetwork` 的「可点前必须 >0 条」与「整轮必须见得到 monaco」两道自证仍在兜底。
 *
 * 返回 `items`（与入参 events 同序）：每条带 `rel`（ms，页内时间轴）与 `via`（这条 rel 是哪来的）。
 * **逐条择优**：这条请求在页内时间线里出现 → 直接用它的 `startTime`（页内钟原值，零拟合误差，
 * 断言② cares 的正是 monaco 那几条，能精确就绝不拟合）；没出现（dev 缓冲截断掉的模块）→
 * 退回上面选出的 basis 拟合值，并把 `via` 写成拟合来源好让读数自证。
 *
 * ## 第 0 步：量纲归一（PS-10 回炉批修，2026-10-18 实测踩坑）
 * `Network.requestWillBeSent.timestamp` 的**单位**（ms / 秒）跟语义一样跨版本不稳。锚点法
 * 做差 (`e.ts - anchorTs`) 后若是「秒」，被下面当 ms 与页内时间线求差，median 只能修掉
 * **中位时刻**的系统差，斜率 ~999 的线性错配原样留在远端事件上（表现为 spread 数千 ms）——
 * 实测把可点后 5.3s 的 editor.worker 拟合成「可点前 543ms」，断言②假红（同 bug 在 master
 * 上只是侥幸没越线）。修法不猜量纲：交集 ≥5 条时用最小二乘估 `anchorRel → 页内 ms` 的
 * 斜率，斜率显著 >2（秒→毫秒即 ~1000）就先把 anchorRel 整体归一到 ms 再走原 offset 拟合；
 * 斜率 ≈1 说明本就同量纲，什么都不做。归一系数随 `timeScale` 字段返回，读数自证。
 */
export function assignRelTimes(events, timelineEntries, anchorTs, timeOrigin) {
  const list = Array.isArray(events) ? events : [];
  const tl = new Map();
  for (const [name, start] of timelineEntries || []) {
    if (typeof name !== 'string' || !Number.isFinite(start)) continue;
    const k = urlKey(name);
    const prev = tl.get(k);
    if (prev === undefined || start < prev) tl.set(k, start);
  }
  /** 量纲归一系数（1 = 本就同量纲；~1000 = CDP timestamp 是「秒」）——见函数头「第 0 步」 */
  let timeScale = 1;
  const finish = (basis, offset, overlap, spread, anchorRel) => ({
    basis,
    offset,
    overlap,
    spread,
    timeScale,
    items: list.map((e, i) => {
      const exact = tl.get(urlKey(e.url));
      return exact !== undefined
        ? { url: e.url, rel: exact, via: '页内时间线原值' }
        : { url: e.url, rel: anchorRel[i] === null ? null : anchorRel[i] + offset, via: `拟合(${basis})` };
    }),
  });

  if (!Number.isFinite(anchorTs) || list.length === 0) {
    // 没锚点：时间线里有的那条仍给准确值，其余 rel=null（判定层靠 beforeCount>0 自证，不会恒真判绿）
    return {
      basis: 'no-anchor',
      offset: 0,
      overlap: tl.size,
      spread: null,
      timeScale,
      items: list.map((e) => {
        const t = tl.get(urlKey(e.url));
        return { url: e.url, rel: t === undefined ? null : t, via: t === undefined ? '无锚点' : '页内时间线原值' };
      }),
    };
  }
  const anchorRel = list.map((e) => e.ts - anchorTs);
  // 第 0 步·量纲归一：交集 ≥5 时用 Theil–Sen（成对斜率中位）估 anchorRel→页内 ms 的斜率。
  // 不用最小二乘：交集里「同 URL 时间线取的条目与事件不对应」的离群对会把 LS 斜率拉偏
  // （判定层自己的测试用例里 6 条中 1 条离群就把 LS 拉到 3.86、误触归一）；Theil–Sen 的
  // 中位数对 ≤50% 的离群免疫。斜率 >2 视为量纲错配（秒→毫秒 ≈ ×1000），先把 anchorRel
  // 整体归一到 ms 再走原 offset 拟合；≈1 本就同量纲，什么都不做。
  // 样本剔掉锚点前（负值）与 <0.5 的近零值；交集大时均匀步长抽样到 ≤240 条（~2.9 万对，确定性不变）。
  {
    const dims = [];
    for (let i = 0; i < list.length; i++) {
      const t = tl.get(urlKey(list[i].url));
      if (t !== undefined && anchorRel[i] > 0.5) dims.push([anchorRel[i], t]);
    }
    if (dims.length >= 5) {
      const step = Math.max(1, Math.ceil(dims.length / 240));
      const s = [];
      for (let i = 0; i < dims.length; i += step) s.push(dims[i]);
      const slopes = [];
      for (let i = 0; i < s.length; i++) {
        for (let j = i + 1; j < s.length; j++) {
          const dx = s[j][0] - s[i][0];
          if (dx > 1e-9) slopes.push((s[j][1] - s[i][1]) / dx);
        }
      }
      const slope = slopes.length > 0 ? median(slopes) : 1;
      if (Number.isFinite(slope) && slope > 2 && slope < 100_000) {
        timeScale = slope;
        for (let i = 0; i < anchorRel.length; i++) anchorRel[i] *= slope;
      }
    }
  }
  const diffs = [];
  for (let i = 0; i < list.length; i++) {
    const t = tl.get(urlKey(list[i].url));
    if (t !== undefined) diffs.push(t - anchorRel[i]);
  }
  if (diffs.length >= 5) {
    return finish('timeline-fit', median(diffs), diffs.length, Math.max(...diffs) - Math.min(...diffs), anchorRel);
  }

  if (Number.isFinite(timeOrigin) && list.every((e) => Number.isFinite(e.wallTime))) {
    const wall = list.map((e) => e.wallTime * 1000 - timeOrigin);
    const d2 = wall.map((w, i) => w - anchorRel[i]);
    return {
      basis: 'wall-clock',
      offset: median(d2),
      overlap: diffs.length,
      spread: Math.max(...d2) - Math.min(...d2),
      timeScale,
      items: list.map((e, i) => {
        const exact = tl.get(urlKey(e.url));
        return exact !== undefined
          ? { url: e.url, rel: exact, via: '页内时间线原值' }
          : { url: e.url, rel: wall[i], via: '拟合(wall-clock)' };
      }),
    };
  }

  return finish('document-anchor', 0, diffs.length, null, anchorRel);
}

/**
 * Network 域取证的**纯判定**：入 = `captureBootNetwork()` 的结果。
 *
 * 判绿要同时满足三条（一条不满足就不许判绿）：
 * 1. 采到了可点标记、锚点/归属口径可用；
 * 2. 可点前**确实有请求**（`beforeCount > 0`）——文档与入口脚本必然在可点前取；一条都没有
 *    只能说明事件归属或时基错了，此时「可点前零 monaco」是**恒真的假绿**（实测踩过：
 *    按页内 `timeOrigin` 直接切分时 `beforeCount` 会整轮归零）；
 * 3. 可点前零 monaco，且可点**之后**见得到 monaco（idle 预取必然拉到 ProjectView chunk；
 *    整轮零 monaco = 匹配面失效，同样不许判绿）。
 */
export function judgeNetwork(cap) {
  if (!cap || cap.ok !== true) return { verdict: 'unavailable', reason: cap ? cap.reason : '无采样结果' };
  if (!cap.anchored) return { verdict: 'unavailable', reason: '未取得本轮导航锚点（Document 请求或 frameNavigated 都没来），时刻无法归一' };
  if (typeof cap.welcome !== 'number') return { verdict: 'unavailable', reason: '未采到 boot.welcomeInteractive' };
  if (cap.beforeCount === 0) {
    return { verdict: 'unavailable', reason: `可点前 0 条请求（整轮 ${cap.total} 条）——文档与入口脚本必在可点前取，归零说明事件归属/时基不可信，不据此判绿` };
  }
  if (cap.monacoTotalCount === 0) {
    return { verdict: 'unproven', reason: '整轮 Network 域未见任何 monaco 请求（含可点之后）——匹配面可疑，不许据此判绿' };
  }
  return {
    verdict: cap.monacoBeforeCount === 0 ? 'pass' : 'fail',
    reason:
      `时基=${cap.basis}（交集 ${cap.overlap ?? 'n/a'} 条，页内原值 ${cap.exactCount ?? 'n/a'} / 拟合 ${cap.fittedCount ?? 'n/a'}，偏差中位 ${Math.round(cap.offset ?? 0)}ms 离散 ${cap.spread === null ? 'n/a' : Math.round(cap.spread) + 'ms'}` +
      (typeof cap.timeScale === 'number' && cap.timeScale !== 1 ? `，量纲归一 ×${Math.round(cap.timeScale)}` : '') + `）；` +
      (cap.monacoBeforeCount === 0
        ? `可点前 ${cap.beforeCount} 条请求中零 monaco；可点后预取拉到 ${cap.monacoTotalCount} 条（匹配面有效）`
        : `可点前已发起 ${cap.monacoBeforeCount} 条 monaco 请求（可点前共 ${cap.beforeCount} 条）：${(cap.monacoBefore || []).join(' | ')}`),
  };
}

/**
 * 持久 CDP 会话（一条 WS 上同时收事件、发命令）。
 * `smoke-tauri-dom.mjs` 原有的 `cdpEval` 是「一次连接一个命令」，取证要的是**先订阅再导航**，
 * 所以这里必须常驻；导航后页面执行上下文重建，`Runtime.evaluate` 走默认上下文即可。
 */
export class CdpSession {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws = new WebSocket(url);
    this.open = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('cdp ws error'));
      this.ws.onclose = () => {
        for (const p of this.pending.values()) p.reject(new Error('cdp ws closed'));
        this.pending.clear();
      };
      this.ws.onmessage = (ev) => this._dispatch(ev.data);
    });
  }

  _dispatch(data) {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const set = this.listeners.get(msg.method);
      if (set) for (const cb of set) { try { cb(msg.params || {}); } catch { /* 监听器不许拖垮取证 */ } }
    }
  }

  on(method, cb) {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(cb);
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /** 页内求值（returnByValue）；导航中上下文未就绪时会抛，调用方按重试处理 */
  async evalText(expression, timeoutMs = 15000) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r?.exceptionDetails) throw new Error(String(r.exceptionDetails.text || '页面求值异常'));
    return r?.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 已关 */
    }
  }
}

/**
 * **CDP Network 域取证**（断言②的首选口径）：
 * 连页面 → `Network.enable` + `Page.enable` → `Page.reload(ignoreCache)` → 全程收
 * `Network.requestWillBeSent` → 轮询页内 `boot.welcomeInteractive` → 按可点时刻切分。
 *
 * 为什么要 reload 而不是直接看第一轮开机：探针发现 CDP 时页面早已在导航，Network 域是
 * 「先订阅才有事件」的流——不重跑一遍就永远缺最早那段，而「可点前」恰恰就是最早那段。
 * `ignoreCache` 保证缓存命中的请求也进网络栈记录（否则漏条目 = 假绿）。
 *
 * ## 切分口径：本轮导航自己的锚点，不碰 CDP 的绝对时基（这是这条断言的真命门）
 * `Network.requestWillBeSent.timestamp` 的语义（相对 timeOrigin / 纪元 ms / 纪元 s）跨版本不稳，
 * 而**直接拿页内 `performance.timeOrigin` 去减**实测会把可点前切出 `0` 条——文档与入口脚本
 * 不可能一条请求都没有，归零就是假绿（恒真）。所以改成两条自证：
 * 1. **归属**：只认本轮导航 `loaderId` 的事件（`Document` 请求带来的，退回主帧 `Page.frameNavigated`
 *    的 `frame.loaderId`），reload 之前那一轮的残留一律不计；
 * 2. **锚点**：`rel = ts − 本轮 Document 请求的时刻`（本轮最小 ts 兜底）。Document 请求就在
 *    导航起点、也就是页内 `timeOrigin` 附近，于是 `rel` 与 `boot.welcomeInteractive` 天然同量纲，
 *    一个字节的时基猜测都不需要。`detectRelMode` 只留作诊断对照，不参与判定。
 * 拿不到锚点（本轮既没 Document 也没主帧 frameNavigated）就 `anchored:false` 交回调用方，
 * 判据层会把它折成「口径不可用」而不是「通过」。
 *
 * 采不到**不静默**：`ok:false` + `reason` 原样带回，调用方退回时间线口径并标注。
 */
export async function captureBootNetwork(opts) {
  const {
    wsUrl,
    waitMs = 90000,
    settleMs = 4000,
    pollMs = 800,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = () => {},
  } = opts;
  const requests = [];
  let navLoaderId = null;
  let anchorTs = null;
  let anchor = '';
  let cdp = null;
  try {
    cdp = new CdpSession(wsUrl);
    await cdp.open;
    cdp.on('Network.requestWillBeSent', (p) => {
      const url = p?.request?.url;
      if (typeof url !== 'string') return;
      const ev = {
        url,
        ts: p.timestamp,
        wallTime: p.wallTime,
        type: p.type,
        loaderId: typeof p.loaderId === 'string' ? p.loaderId : '',
      };
      requests.push(ev);
      // reload 之后**第一个** Document 请求 = 本轮导航的入口：定 loaderId、定 t0
      if (anchorTs === null && ev.type === 'Document' && ev.loaderId) {
        navLoaderId = ev.loaderId;
        anchorTs = ev.ts;
        anchor = '本轮 Document 请求时刻';
      }
    });
    cdp.on('Page.frameNavigated', (p) => {
      const f = p?.frame;
      if (!f || f.parentId || typeof f.loaderId !== 'string') return; // 只认主帧
      if (navLoaderId === null) navLoaderId = f.loaderId;
    });
    await cdp.send('Network.enable', {});
    await cdp.send('Page.enable', {});
    await cdp.send('Page.reload', { ignoreCache: true });
    log(`[cdp] 已 Page.reload 重跑一轮开机（Network 域取证，最多 ${Math.round(waitMs / 1000)}s）…`);

    let page = null;
    const started = Date.now();
    while (Date.now() - started < waitMs) {
      await sleep(pollMs);
      try {
        const raw = await cdp.evalText(`(${collectBoot.toString()})()`);
        const b = JSON.parse(String(raw ?? 'null'));
        if (b && typeof b.welcome === 'number') {
          page = b;
          break;
        }
      } catch {
        /* 导航中 / 上下文未就绪：继续等 */
      }
    }
    if (!page) return { ok: false, reason: `重跑一轮开机后 ${Math.round(waitMs / 1000)}s 内仍未采到 boot.welcomeInteractive` };

    // 可点后 settleMs：等 idle 预取真的把 ProjectView chunk 发出去（反空匹配自证要看到它）
    await sleep(settleMs);
    try {
      const raw = await cdp.evalText(`(${collectBoot.toString()})()`);
      const after = JSON.parse(String(raw ?? 'null'));
      if (after && typeof after.welcome === 'number') page = after;
    } catch {
      /* 采不到就按首轮读数判，Network 事件已在手里 */
    }

    // 归属：只留本轮导航的事件（Document 锚点没来就用主帧 loaderId，再没有就整轮按 ts 最小值兜底）
    const mine = navLoaderId ? requests.filter((r) => r.loaderId === navLoaderId) : requests;
    if (anchorTs === null && mine.length > 0) {
      anchorTs = Math.min(...mine.map((r) => r.ts));
      anchor = navLoaderId ? '主帧 loaderId 内最小 ts（Document 事件未到账）' : '整轮最小 ts（loaderId 未到账）';
    }
    const anchored = anchorTs !== null && mine.length > 0;
    // 把本轮 Network 事件折算到页内时间轴（与 boot.welcomeInteractive 同一条轴）再切刀
    const fit = assignRelTimes(mine, page.timeline, anchorTs, page.timeOrigin);
    const rels = fit.items.map((it, i) => ({ ...it, ts: mine[i].ts, type: mine[i].type }));
    const before = rels.filter((r) => Number.isFinite(r.rel) && r.rel >= -2000 && r.rel < page.welcome);
    const monoBefore = before.filter((r) => MONACO_HINT_RE.test(r.url));
    const monoAll = rels.filter((r) => MONACO_HINT_RE.test(r.url));
    return {
      ok: true,
      anchored,
      basis: fit.basis,
      overlap: fit.overlap,
      spread: fit.spread,
      offset: fit.offset,
      timeScale: fit.timeScale,
      exactCount: rels.filter((r) => r.via === '页内时间线原值').length,
      fittedCount: rels.length - rels.filter((r) => r.via === '页内时间线原值').length,
      anchor: anchored
        ? `${anchor}（本轮 ${mine.length} 条 / 会话共收 ${requests.length} 条，loaderId=${navLoaderId ?? '未识别'}）`
        : '无锚点',
      // 仅作诊断对照，不参与判定
      mode: detectRelMode(mine.slice(0, 16).map((r) => r.ts), page.timeOrigin),
      timeOrigin: page.timeOrigin,
      welcome: page.welcome,
      total: rels.length,
      seenTotal: requests.length,
      beforeCount: before.length,
      monacoBeforeCount: monoBefore.length,
      monacoBefore: monoBefore.slice(0, 6).map((r) => `${Math.round(r.rel)}ms ${r.url} [${r.via}]`),
      monacoTotalCount: monoAll.length,
      monacoTotalSample: monoAll.slice(0, 6).map((r) => `${Math.round(r.rel)}ms ${r.url} [${r.via}]`),
      page,
    };
  } catch (e) {
    return { ok: false, reason: `Network 域取证失败：${String(e && e.message ? e.message : e).slice(0, 160)}` };
  } finally {
    if (cdp) { try { cdp.close(); } catch { /* 忽略 */ } }
  }
}

/** 四标记读数打印行（dev / release 同一份，别再各写各的） */
export function bootMarkLines(b) {
  const out = [];
  for (const k of BOOT_MARK_NAMES) {
    const v = b?.boot?.[k];
    out.push(`  ${k} = ${v ? v.last.toFixed(1) : '未记录（未打开项目属正常）'}${v && v.note ? '  // ' + v.note : ''}`);
  }
  const fp = b?.boot?.['boot.firstPaint'];
  const hp = b?.boot?.['boot.htmlParsed'];
  if (fp && hp) out.push(`  → 白屏段 firstPaint − htmlParsed = ${(fp.last - hp.last).toFixed(1)}ms`);
  return out;
}

/**
 * 断言②的最终结论：Network 域优先，采不到退回时间线口径（**如实标注用哪个口径判的**）。
 * 返回的 `used` 就是要在屏上打印的口径名。
 */
export function resolveA2(cap, b, judged) {
  const v = judgeNetwork(cap);
  if (v.verdict !== 'unavailable') return { ok: v.verdict === 'pass', used: 'CDP Network 域', reason: v.reason };
  return {
    ok: judged.a2Timeline,
    used: '页内资源时间线（回退口径：dev 形态缓冲可能数不全，见上方两条口径的条目数差）',
    reason: `${v.reason}；回退读数：时间线共 ${b.resourceCount} 条，可点前 ${b.beforeCount} 条，` +
      `其中 monaco ${b.monacoBeforeCount} 条，整轮 monaco ${b.monacoTotalCount} 条${judged.a2Timeline ? '' : '（=0 说明匹配面在这份缓冲里根本没使上劲，判绿不可信）'}`,
  };
}
