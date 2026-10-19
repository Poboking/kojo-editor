#!/usr/bin/env node
/**
 * UI 量测 harness（HK-4「UI 系统化」各轮的回归门禁，见 docs/archive/IMPLEMENTATION-LOG.md §5.121–§5.124 与 docs/log/2026-10-13-ui-icons.md）。
 *
 * 它不判断"好不好看"，只把**能数的七件事**变成数字，前后各跑一次即可 diff：
 *   1. `fontSizes` / `distinctFontSizes` —— 屏幕上**实际渲染**出几档字号（半像素档 = 各子系统自造尺度的信号）
 *   2. `contrastFails` —— WCAG 对比度不达标（正文 4.5:1、大字号 3:1；半透明背景按层合成后算）
 *   3. `clipFails` —— `overflow: hidden|clip` 下被裁掉多少像素（内容截断类缺陷）
 *   4. `smallTargets` —— 小于 24×24 的交互元素（WCAG 2.5.8 最小目标）
 *   5. `radii` / `distinctRadii` —— 屏上渲染出几档圆角（半像素之外的另一种"各面板自造尺度"）
 *   6. `shadows` / `distinctShadows` —— 屏上渲染出几档阴影（浮动层级是否收敛成少数几档）
 *   7. `glyphTexts` / `svgIcons` —— 界面上还剩几个"当图标用的符号字符"，以及渲染出多少个 SVG 图标
 *      （emoji/几何符号当图标 = 字号、色、粗细都不受 CSS 管；这个数应当随 UI-3 单调降到 0）
 *
 * 前置（HK-28 的绿态复跑配方；2026-10-16 真语料机跑了三次——冷快照一次、热快照两次，
 * 12 个状态全部量到，`04-打开ERB的.kojo预览` 之后不再超时）：
 *   1. 桌面壳带着 CDP 端口在跑，且**语料/项目已在「最近打开」里**（本工具点的是 smoke-lib 的 `recentOpenRowSel` 第一行）；
 *      起壳走 node 起（Git-Bash 直起会踩 TMP ⇒ cargo `link.exe` LNK1104，PITFALLS 26），并带自己的
 *      `WEBVIEW2_USER_DATA_FOLDER` 隔离目录（PITFALLS 70，同 identifier 实例并存必挂 0x8007139F）：
 *        node -e "const{spawn}=require('child_process'),fs=require('fs');spawn('pnpm --filter @kojo/app tauri dev',{shell:true,detached:true,stdio:['ignore',fs.openSync('dev.log','w'),fs.openSync('dev.log','a')],env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:'<本机临时目录>',WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9222'}}).unref()"
 *   2. 快照冷热都算过（2026-10-16 冷快照一次 / 热快照两次，12 状态全量到）：**本工具会自己等水位**，
 *      等不到就带读数报红，不会把判据放宽；
 *   3. 机器空闲（与全量测试 / cargo 构建并发时，页内长任务被抢 CPU，量出来的等待会虚高）；
 *   4. 每次跑都从欢迎页重新起步（本工具开头 `location.reload()` 保证）。
 *
 * 「等三水位到齐再量」是 HK-28 加的闸：`waitIdle()` 用一次平凡 `Runtime.evaluate` 的**墙钟往返**
 * 当主线程水位探针（长任务会把 evaluate 排在队尾 ⇒ 往返直接涨），连续两拍低于阈值才放行；
 * 打开项目 / 打开 ERB 后再各等一道索引水位（`.sb-idx` 连续两拍同读、不带省略号）。
 * 1016 语料机实测：空闲页往返 1–3ms，被级联占到时 229 / 762ms ⇒ 阈值取 120ms 没有含糊带；
 * 冷快照首跑索引水位等了 12.2s，之后每个状态的量测单点 3–19ms。
 * **evaluate 上限一字未改（25s）**——超时若是红，打印的 `[idle]` / `[idx]` 读数会指明
 * 是"主线程被占"还是"页面自己慢"。
 *
 * 用法：node tools/ui-measure.mjs out.json      （它会自己点遍欢迎页 / 四个活动栏视图 /
 *        打开一个 ERB / 快速打开 / 设置浮层 / 新建向导，共十个状态；结果写 out.json 并打印摘要）
 * 退出码：0 = 跑完（**不代表通过**，通过与否看摘要里的那几个数）；非 0 = 中途量不上（读数已打印）。
 *
 * 已知边界：跳过 `.monaco-editor` 内部（编辑器语法高亮另有口径）；
 * `input 13×13` 那类原生复选框会进 `smallTargets`，判读时按"表单控件"处理。
 */
import * as fs from 'node:fs';
import { recentOpenRowSel } from './smoke-lib.mjs';

const CDP = 'http://127.0.0.1:9222';
const OUT = process.argv[2] ?? 'ui-measure.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageUrl() {
  for (let i = 0; i < 150; i++) {
    try {
      const l = await (await fetch(`${CDP}/json`)).json();
      const p = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error('no CDP page');
}
const ws = new WebSocket(await pageUrl());
let id = 0;
const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)); } }, 25000); });
const ev = async (expression) => { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result?.value; };
await new Promise((r) => { ws.onopen = r; });

/* ---------------- 主线程水位探针（HK-28：等水位归零再量） ----------------
   一次平凡 `Runtime.evaluate` 的墙钟往返 = 页面此刻有多"接得住事"。页内长任务
   （开大 ERB 时索引 / 条件抽取 / 校验那三段级联）会把这条 evaluate 排在队尾，
   往返立刻涨——所以它是**不依赖产品内部口径**的通用水位读数。
   阈值 120ms 有实测依据：空闲页往返 1–3ms，开大 ERB 的级联中被占到 229 / 762ms，中间没有含糊带。 */
const IDLE_RT_MS = 120;
const IDLE_WAIT_CAP_MS = 180000;
const probe = async () => {
  const t0 = Date.now();
  await ev('performance.now()');
  return { rt: Date.now() - t0, idx: await ev(`document.querySelector('.sb-idx')?.innerText?.replace(/\\n/g,' ') ?? null`) };
};
/** 连续两拍往返都低于阈值才放行；等不到**不静默**，带最后一拍读数返回 */
async function waitIdle(label) {
  const t0 = Date.now();
  let good = 0;
  let last = null;
  while (Date.now() - t0 < IDLE_WAIT_CAP_MS) {
    last = await probe();
    if (last.rt <= IDLE_RT_MS) {
      if (++good >= 2) {
        console.log(`[idle] ${label}：水位归零，等了 ${Date.now() - t0}ms（末拍往返 ${last.rt}ms，状态栏「${last.idx}」）`);
        return { ok: true, waitedMs: Date.now() - t0, last };
      }
    } else {
      good = 0;
      console.log(`[idle] ${label}：水位未归零（往返 ${last.rt}ms，状态栏「${last.idx}」），继续等 …`);
    }
    await sleep(700);
  }
  console.log(`[idle] ${label}：等水位超过 ${IDLE_WAIT_CAP_MS}ms 仍未归零，末拍读数=${JSON.stringify(last)}`
    + '——**这是环境/级联红，不是量数不绿**；接着量，若 evaluate 再超时，红因就是这条读数。');
  return { ok: false, waitedMs: Date.now() - t0, last };
}

const MEASURE = `(() => {
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c || ''); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x.trim())); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const bgOf = (el) => { const layers = []; let cur = el; while (cur) { const c = parse(getComputedStyle(cur).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } cur = cur.parentElement; } let out = layers.length && layers[layers.length - 1].a >= 1 ? layers.pop() : { r: 0, g: 0, b: 0, a: 1 }; while (layers.length) out = over(layers.pop(), out); return out; };
  const lum = (c) => { const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100; };
  const cls = (el) => (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : el.tagName.toLowerCase());
  const sizes = {}, clip = [], contrast = new Map(), small = new Map(), radii = {}, shadows = {}, glyph = {};
  const GLYPH = /[\\u{1F000}-\\u{1FAFF}\\u{2190}-\\u{2BFF}\\u{2460}-\\u{24FF}\\u{FE0F}]/u;
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.monaco-editor')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
    if (own) {
      const txt = el.textContent.trim();
      if (txt.length <= 2 && GLYPH.test(txt)) glyph[txt] = (glyph[txt] ?? 0) + 1;
      const px = Math.round(parseFloat(cs.fontSize) * 100) / 100;
      sizes[px] = (sizes[px] ?? 0) + 1;
      const fg = parse(cs.color);
      if (fg) {
        const bg = bgOf(el);
        const got = ratio(over({ ...fg }, bg), bg);
        const bold = parseInt(cs.fontWeight, 10) >= 700;
        const need = (px >= 24 || (px >= 18.66 && bold)) ? 3 : 4.5;
        if (got < need) {
          const k = cls(el) + ' ' + px + 'px';
          const cur = contrast.get(k) ?? { n: 0, got, need, sample: '' };
          cur.n++; if (!cur.sample) cur.sample = el.textContent.trim().slice(0, 34);
          contrast.set(k, cur);
        }
      }
    }
    if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && el.scrollWidth - el.clientWidth > 2) {
      clip.push({ at: cls(el), clip: el.scrollWidth - el.clientWidth, w: el.clientWidth, t: el.textContent.trim().slice(0, 40) });
    }
    const interactive = el.matches('button, a[href], input, select, [role=button], [role=tab]');
    if (interactive && !(r.width >= 24 && r.height >= 24)) {
      const k = cls(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
      if (!small.has(k)) small.set(k, { k, n: 0, t: (el.textContent || el.getAttribute('aria-label') || el.title || '').trim().slice(0, 20) });
      small.get(k).n++;
    }
    const br = cs.borderTopLeftRadius;
    if (br && br !== '0px') radii[br] = (radii[br] ?? 0) + 1;
    if (cs.boxShadow && cs.boxShadow !== 'none') shadows[cs.boxShadow] = (shadows[cs.boxShadow] ?? 0) + 1;
  }
  return {
    viewport: [innerWidth, innerHeight],
    fontSizes: sizes,
    distinctFontSizes: Object.keys(sizes).length,
    radii,
    distinctRadii: Object.keys(radii).length,
    shadows,
    distinctShadows: Object.keys(shadows).length,
    glyphTexts: glyph,
    distinctGlyphTexts: Object.keys(glyph).length,
    svgIcons: document.querySelectorAll('svg.icon').length,
    clipFails: clip.sort((a, b) => b.clip - a.clip).slice(0, 12),
    contrastFails: [...contrast.entries()].map(([k, v]) => ({ k, ratio: v.got, need: v.need, n: v.n, sample: v.sample })).sort((a, b) => a.ratio - b.ratio).slice(0, 12),
    smallTargets: [...small.values()].sort((a, b) => b.n - a.n).slice(0, 14),
  };
})()`;

const click = (sel, want) => ev(`(() => {
  const list = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const el = ${JSON.stringify(want ?? null)} === null ? list[0] : list.find((e) => (e.textContent || '').includes(${JSON.stringify(want ?? '')}));
  if (!el) return { ok: false, have: list.map((x) => x.textContent.trim().slice(0, 22)) };
  el.click(); return { ok: true, t: el.textContent.trim().slice(0, 28) };
})()`);
const waitFor = async (expr, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return Math.round(Date.now() - t0); await sleep(400); } return 'TIMEOUT'; };

const results = {};
const snapTimes = [];
/**
 * 每个状态：先等主线程水位归零，再量。**判据（那几个数）一字未改**，改的是"什么时候量"。
 * 量不上（25s evaluate 上限用尽）时不丢一串栈就走——把当时水位读数与上一拍量测耗时打全，
 * 让人一眼分得清"级联还没完"与"页面真慢/真死"。
 */
const snap = async (label) => {
  await waitIdle(label);
  const t0 = Date.now();
  try {
    results[label] = await ev(MEASURE);
  } catch (e) {
    const spent = Date.now() - t0;
    console.log(`\n❌ ${label}：量测在 ${spent}ms 处失败（evaluate 上限 25s 未放宽）——${String(e)}`);
    console.log('   当时的水位读数：', JSON.stringify(await probe()));
    console.log('   已量成状态的量测耗时：', JSON.stringify(snapTimes));
    console.log('   DOM 规模：', await ev(`document.querySelectorAll('body *').length`).catch(() => '读不出'));
    ws.close();
    process.exit(1);
  }
  const ms = Date.now() - t0;
  snapTimes.push({ label, ms });
  const r = results[label];
  console.log(label, `→ 量测 ${ms}ms；字号`, r.distinctFontSizes, '圆角', r.distinctRadii, '阴影', r.distinctShadows, '裁剪', r.clipFails.length, '对比度', r.contrastFails.length, '小目标', r.smallTargets.length);
};

/**
 * 再叠一道**索引水位**：`.sb-idx` **连续两拍同读且不带省略号**才算归零。
 * 只看"不带省略号"不够——刚开项目那一刻它还是「0 文件 · 0 函数」（构建还没起），
 * 会被判成已 settle；"不再变化"才是这里要的"水位到齐"。等不到不静默：带末读数继续，
 * 后面若量测红，红因就是这一行。
 */
const waitIndexSettled = async (label, ms = 180000) => {
  const t0 = Date.now();
  let last = '';
  let prev = null;
  while (Date.now() - t0 < ms) {
    last = await ev(`document.querySelector('.sb-idx')?.innerText?.replace(/\\n/g,' ') ?? ''`);
    if (last && !last.includes('…') && last === prev) {
      console.log(`[idx] ${label}：索引水位到了（连续两拍同读「${last}」），等了 ${Date.now() - t0}ms`);
      return Date.now() - t0;
    }
    prev = last;
    await sleep(700);
  }
  console.log(`[idx] ${label}：${ms}ms 内索引水位未归零，末读「${last}」——继续，但后面的量测红因就是这条`);
  return 'TIMEOUT';
};

/* 每次从同一处起步（跨次可比）：先重载回欢迎页，否则第二次跑会从"上次留下的项目视图"
   起步，两个 run 的聚合数根本不是一个东西——这是本工具自己的一个假绿陷阱。 */
await ev(`location.reload()`);
await sleep(2500);
console.log('reload → welcome =', await waitFor(`!!document.querySelector('.welcome')`, 15000));

await snap('01-欢迎页');
console.log('open recent =', await click(recentOpenRowSel, null));
await waitFor(`!!document.querySelector('.editor-body, .empty-state') && !document.querySelector('.welcome')`);
await waitIndexSettled('开项目');
await sleep(1500);
if (await ev(`!!document.querySelector('.shell.zen')`)) {
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))`); await sleep(120);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',bubbles:true}))`); await sleep(600);
}
if ((await ev(`document.querySelectorAll('.tree-group-btn').length`)) === 0) await click('button', '🗀');
await waitFor(`document.querySelectorAll('.tree-group-btn').length > 0`);
await snap('02-项目+口上文件树');

/* 逐个点开活动栏视图，把插件面板都渲染一遍 */
const abCount = await ev(`document.querySelectorAll('.activity-bar button, .activity button, [class*=activity] button').length`);
console.log('activity buttons =', abCount);
for (let i = 0; i < Math.min(abCount, 8); i++) {
  await ev(`(() => { const b = [...document.querySelectorAll('.activity-bar button, .activity button, [class*=activity] button')][${i}]; if (b) b.click(); return b ? b.title || b.textContent.trim() : null; })()`);
  await sleep(900);
  await snap('03-视图' + i + '-' + (await ev(`([...document.querySelectorAll('.activity-bar button, .activity button, [class*=activity] button')][${i}]||{}).title ?? ''`)));
}

await click('.tree-group-btn', null);
await sleep(700);
await click('.tree-file', '.ERB');
await waitFor(`document.querySelectorAll('.view-line').length > 0`);
/* 「首次打开游戏目录 ERB 会问一次要不要开 .kojo 预览」那朵弹窗存 WebView localStorage ⇒
   换一具画像就弹、用旧画像不弹，04 这个状态的 DOM 规模随画像变，跨次根本不可比。
   答「不用」（= 预览默认关，与本功能默认口径一致）把这朵清掉，把画像差异摘出量测。
   **重试式**：这朵弹窗在 filePath 的 effect 里 setState，晚于 `.view-line` 出现，
   单次判定会把"还没弹"读成"没有弹窗"，于是 04 量到一朵半开的遮罩。 */
const dismissIntro = () => ev(`(() => {
  const m = document.querySelector('.modal[aria-label=".kojo 预览"]');
  if (!m) return 'no-intro';
  const b = [...m.querySelectorAll('.modal-actions button')].find((e) => e.textContent.trim() === '不用');
  if (b) b.click();
  return 'intro-dismissed';
})()`);
let intro = 'no-intro';
for (let i = 0; i < 3; i++) {
  intro = await dismissIntro();
  if (intro === 'intro-dismissed') break;
  await sleep(900);
}
console.log('intro =', intro);
await waitFor(`!document.querySelector('.modal')`, 10000);
await waitIndexSettled('开 ERB');
await sleep(1500);
await snap('04-打开ERB的.kojo预览');

await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'p',ctrlKey:true,bubbles:true}))`);
await sleep(900);
await snap('05-快速打开');
await ev(`(() => { const i = document.querySelector('.picker input'); if (i) i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return 1; })()`);
await sleep(600);

await click('button', '⚙');
await waitFor(`!!document.querySelector('.overlay-host')`);
await sleep(700);
await snap('06-设置浮层');
await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
await sleep(500);

await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true}))`);
await sleep(1000);
await snap('07-新建口上文件向导');
await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);

fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
/* 实测分布：25s 那条 evaluate 上限就是照这一行定的（不改上限、只把它量出来给人看）。 */
console.log('\n量测耗时分布（ms）=', snapTimes.map((s) => `${s.label}:${s.ms}`).join('  '),
  '｜最大', Math.max(...snapTimes.map((s) => s.ms)), '｜上限', '25000（未放宽）');
const agg = (field) => { const m = new Map(); for (const st of Object.values(results)) for (const [k, n] of Object.entries(st[field] ?? {})) m.set(k, (m.get(k) ?? 0) + n); return m; };
const dump = (title, field, sort) => {
  const m = agg(field);
  console.log(`\n=== ${title}（值 → 元素数）===`);
  console.log([...m.entries()].sort(sort).map(([k, n]) => k + '×' + n).join('  '));
  console.log('档数 =', m.size);
};
dump('全站渲染出来的字号档', 'fontSizes', (a, b) => parseFloat(a[0]) - parseFloat(b[0]));
dump('全站渲染出来的圆角档', 'radii', (a, b) => b[1] - a[1]);
dump('全站渲染出来的阴影档', 'shadows', (a, b) => b[1] - a[1]);
console.log('\nwritten', OUT);
ws.close();
