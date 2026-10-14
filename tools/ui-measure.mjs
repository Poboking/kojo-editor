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
 * 前置：桌面壳要带着 CDP 端口起来（浏览器 `pnpm dev` 量不到桌面壳的真实渲染）：
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 pnpm --filter @kojo/app tauri dev
 * 用法：node tools/ui-measure.mjs out.json      （它会自己点遍欢迎页 / 四个活动栏视图 /
 *        打开一个 ERB / 快速打开 / 设置浮层 / 新建向导，共十个状态；结果写 out.json 并打印摘要）
 * 退出码：0 = 跑完（**不代表通过**，通过与否看摘要里的那几个数）。
 *
 * 已知边界：跳过 `.monaco-editor` 内部（编辑器语法高亮另有口径）；
 * `input 13×13` 那类原生复选框会进 `smallTargets`，判读时按"表单控件"处理。
 */
import * as fs from 'node:fs';

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
const snap = async (label) => { results[label] = await ev(MEASURE); const r = results[label]; console.log(label, '→ 字号', r.distinctFontSizes, '圆角', r.distinctRadii, '阴影', r.distinctShadows, '裁剪', r.clipFails.length, '对比度', r.contrastFails.length, '小目标', r.smallTargets.length); };

/* 每次从同一处起步（跨次可比）：先重载回欢迎页，否则第二次跑会从"上次留下的项目视图"
   起步，两个 run 的聚合数根本不是一个东西——这是本工具自己的一个假绿陷阱。 */
await ev(`location.reload()`);
await sleep(2500);
console.log('reload → welcome =', await waitFor(`!!document.querySelector('.recent, .welcome')`, 15000));

await snap('01-欢迎页');
console.log('open recent =', await click('.recent button.link', null));
await waitFor(`!!document.querySelector('.editor-body, .empty-state') && !document.querySelector('.welcome')`);
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
