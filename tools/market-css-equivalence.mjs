/**
 * 市场域 CSS 搬迁的「渲染不变」对拍闸（批次十一 L07 · 可复跑）。
 *
 * 背景：`market.css` 原先只有 39 行市场域规则（追加段），基础层与推广段住在
 * `styles-project.css`（同名选择器靠"market.css 晚加载 ⇒ 同特异性后来者胜"叠加）。
 * 本批把 `styles-project.css` 里的市场域规则**逐字迁入** `market.css`（20/28 个选择器
 * 两边同名，是最险的一步）。"我人工核对过"不算证明——这个脚本把它换成可对拍读数。
 *
 * 口径（与 `packages/app/tests/styles-split.equivalence.test.ts` 同一个扁平化器 + 级联器）：
 *   before = 基线树的 [tokens, styles, styles-project, market]
 *   after  = 当前工作树的 [tokens, styles, styles-project, market]
 *   只取**市场域**的 (media ⊃ selector) 键，逐条比最终计算值（逐属性后到者覆盖）。
 *
 * 判绿条件：
 *   ① 值漂移必须**全部**落在 DELIBERATE 白名单里（每条给理由）；名单外的漂移 = 红。
 *   ② 基线里存在、现在整个消失的市场域选择器 = 红（迁移不许弄丢规则）。
 *   ③ 白名单里写了但实际没漂移的条目也报出来（防止白名单变成藏污处）。
 *
 * 用法：
 *   node tools/market-css-equivalence.mjs                 # 默认基线 b/misak/1023-visual-batch11
 *   node tools/market-css-equivalence.mjs <before-ref>    # 指定基线（组长复拍时可用集成分支）
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const BEFORE_REF = ARGS[0] ?? 'b/misak/1023-visual-batch11';
const FILES = ['packages/app/src/tokens.css', 'packages/app/src/styles.css', 'packages/app/src/styles-project.css', 'packages/app/src/market.css'];

/**
 * 三份名单（key = `media ⊃ selector`，value = 理由）——迁移之外的呈现改动全在这里在册：
 * - `DRIFT_OK`：两边都有、但终值不同（= 刻意改的呈现）
 * - `REMOVED_OK`：基线有、现在没有（= 刻意作废的规则）
 * - `ADDED_OK`：现在新增、基线没有（= 刻意新加的档）
 * 名单外的任何漂移/消失/新增都会让脚本红；名单里写了但实际没那个方向的改动会黄牌提示。
 * `--inventory` 打印三个集合，方便改动后重新登记。
 */
const DRIFT_OK = new Map([
  [' ⊃ .mk-facts', 'L07：包卡四行元信息合并成一行——不换行、整行省略号收尾（全文在 title）'],
  [' ⊃ .mk-meta', 'L07：同上，单条事实自己也不折行（ellipsis 交给容器）'],
  [' ⊃ .mk-meta + .mk-meta::before', 'L07：条目分隔由 1px 竖发丝线改成画出来的 3px 圆点（竖线在窄侧栏读成表格栏线）'],
  [' ⊃ .mk-link:hover', 'L07：hover 色改走 --accent-text（与 .mk-sub.mk-link 同一档文字色，--accent 是描边色不是文字色）'],
  [' ⊃ .mk-publish', 'L07：静息零环——不再拿 accent 描边冒充选中态，分量改由文字色 + hover 淡底给'],
  [' ⊃ .mk-publish:hover:not(:disabled)', 'L07：同上（hover 档跟着收 --accent-text，键盘环由 .mk-toolbar button:focus-visible 统一给）'],
]);

const REMOVED_OK = new Map([
  ['@container (max-width: 360px) ⊃ .mk-facts', 'L07：窄侧栏里给事实排加 row-gap 是给"会换行的四行"准备的；现在事实排恒为一行（flex-wrap: nowrap），row-gap 恒不生效 ⇒ 连同 row-gap: 0 一起作废'],
]);

const ADDED_OK = new Map([
  [' ⊃ .mk-row .mk-install:not(:disabled)', 'L07：安装按钮三态之"可安装"档（accent 描边 + 文字色），与"详情/卸载"那类次级动作分开'],
  [' ⊃ .mk-row .mk-install:not(:disabled):hover', 'L07：三态之 hover 档'],
  [' ⊃ .mk-row.busy', 'L07：装/更新进行中的行级记号（淡描边 + 左侧进行中导轨；aria-busy 在 DOM 同步）'],
  [' ⊃ .mk-hint > summary', 'L07：能力长文拆成一行 + <details> 折叠件——summary 那一行是常驻读数，去默认三角'],
  [' ⊃ .mk-hint > summary::-webkit-details-marker', 'L07：同上，WebKit 的默认三角也撤掉'],
  [' ⊃ .mk-hint > summary .mk-hint-toggle', 'L07：折叠记号 = 宿主图标注册表的 SVG（chevron-right / xs 档），展开态转 90°——字符 ＋/－ 不再是图标'],
  [' ⊃ .mk-hint > summary .mk-hint-toggle:empty', 'L07：图标桥缺位时的兜底记号（纯 CSS 画出的尖角，仍零字符）'],
  [' ⊃ .mk-hint[open] > summary .mk-hint-toggle', 'L07：折叠件展开态的图标转向'],
  [' ⊃ .mk-hint[open] > summary .mk-hint-toggle:empty', 'L07：兜底记号的展开态'],
  [' ⊃ .mk-hint > summary:hover', 'L07：折叠件 hover 提一档色'],
  [' ⊃ .mk-hint > summary:hover .mk-hint-toggle', 'L07：折叠件 hover 时记号跟着提色（与文字同档，不分两套色）'],
  [' ⊃ .mk-hint[open] > summary', 'L07：展开态与展开段之间的呼吸'],
  [' ⊃ .mk-hint-more', 'L07：折叠展开段（长文的去处）'],
  [' ⊃ .mk-main > .mk-sub', 'L07：摘要进了 .mk-main 的排布（头排之下、事实排之上），旧"挂行尾自带 margin-top"口径作废'],
]);

const isMarketKey = (key) => /\.mk-|\.panel-market/.test(key);

/* ---------------- 与 styles-split.equivalence.test.ts 同一对口径 ---------------- */

function flatRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const stack = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote !== null) {
      buf += ch;
      if (ch === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '{') {
      stack.push({ head: buf.trim(), text: '' });
      buf = '';
      continue;
    }
    if (ch === '}') {
      const top = stack.pop();
      if (top === undefined) continue;
      const parent = stack[stack.length - 1];
      if (parent === undefined || parent.head.startsWith('@')) {
        const media = stack.filter((s) => s.head.startsWith('@')).map((s) => s.head).join(' ');
        out.push({ media, selector: top.head, decls: top.text.trim() });
      }
      buf = '';
      continue;
    }
    const top = stack[stack.length - 1];
    if (top !== undefined) top.text += ch;
    buf += ch;
  }
  return out;
}

/** 样式表序列 → 终态声明表（逐属性后到者覆盖） */
function cascade(sheets) {
  const declMaps = new Map();
  for (const sheet of sheets) {
    for (const r of flatRules(sheet)) {
      const key = `${r.media} ⊃ ${r.selector}`;
      let m = declMaps.get(key);
      if (!m) {
        m = new Map();
        declMaps.set(key, m);
      }
      for (const d of r.decls.split(';')) {
        const idx = d.indexOf(':');
        if (idx <= 0) continue;
        const prop = d.slice(0, idx).trim().toLowerCase();
        if (prop !== '') m.set(prop, d.slice(idx + 1).trim());
      }
    }
  }
  return declMaps;
}

/* ---------------- 两份级联 ---------------- */

const show = (ref, file) => execFileSync('git', ['show', `${ref}:${file}`], { cwd: ROOT, encoding: 'utf8' });
const work = (file) => readFileSync(path.join(ROOT, file), 'utf8');

const beforeAll = cascade(FILES.map((f) => show(BEFORE_REF, f)));
const afterAll = cascade(FILES.map(work));

const before = new Map([...beforeAll].filter(([k]) => isMarketKey(k)));
const after = new Map([...afterAll].filter(([k]) => isMarketKey(k)));

const shared = [...before.keys()].filter((k) => after.has(k));
const drifted = shared.filter((k) => `${[...before.get(k).entries()]}` !== `${[...after.get(k).entries()]}`);
const removed = [...before.keys()].filter((k) => !after.has(k));
const added = [...after.keys()].filter((k) => !before.has(k));

if (process.argv.includes('--inventory')) {
  console.log(`值漂移 ${drifted.length} 条：`);
  drifted.forEach((k) => console.log(`  Δ ${k}`));
  console.log(`基线有 / 现在没有 ${removed.length} 条：`);
  removed.forEach((k) => console.log(`  - ${k}`));
  console.log(`现在新增 / 基线没有 ${added.length} 条：`);
  added.forEach((k) => console.log(`  + ${k}`));
  process.exit(0);
}

const unexpected = drifted.filter((k) => !DRIFT_OK.has(k));
const bogusDrift = [...DRIFT_OK.keys()].filter((k) => !drifted.includes(k));
const unexpectedRemoved = removed.filter((k) => !REMOVED_OK.has(k));
const bogusRemoved = [...REMOVED_OK.keys()].filter((k) => !removed.includes(k));
const unexpectedAdded = added.filter((k) => !ADDED_OK.has(k));
const bogusAdded = [...ADDED_OK.keys()].filter((k) => !added.includes(k));

/* ---------------- 读数 ---------------- */

console.log(`[market-css-equivalence] 基线 = ${BEFORE_REF}`);
console.log(
  `[market-css-equivalence] 市场域选择器：基线 ${before.size} 条 / 迁后 ${after.size} 条；` +
    `共同 ${shared.length} 条里终值逐字相同 ${shared.length - drifted.length} 条、值漂移 ${drifted.length} 条；` +
    `消失 ${removed.length} 条、新增 ${added.length} 条`,
);
console.log(
  `[market-css-equivalence] 全表级联键（含非市场域）：基线 ${beforeAll.size} / 迁后 ${afterAll.size}——` +
    `市场域搬迁只动市场域键，其它域的键数不受影响`,
);
for (const k of drifted) {
  const b = before.get(k);
  const a = after.get(k);
  const props = new Set([...b.keys(), ...a.keys()]);
  const lines = [...props]
    .filter((p) => b.get(p) !== a.get(p))
    .map((p) => `      ${p}: ${b.has(p) ? b.get(p) : '∅'}  →  ${a.has(p) ? a.get(p) : '∅'}`);
  console.log(`  Δ ${k}\n      理由：${DRIFT_OK.get(k) ?? '★ 名单外'}`);
  lines.forEach((l) => console.log(l));
}
removed.forEach((k) => console.log(`  − ${k}　理由：${REMOVED_OK.get(k) ?? '★ 名单外'}`));
added.forEach((k) => console.log(`  + ${k}　理由：${ADDED_OK.get(k) ?? '★ 名单外'}`));

const reds = [];
if (unexpected.length) reds.push(`名单外值漂移 ${unexpected.length} 条：${unexpected.join(' | ')}`);
if (unexpectedRemoved.length) reds.push(`名单外消失 ${unexpectedRemoved.length} 条：${unexpectedRemoved.join(' | ')}`);
if (unexpectedAdded.length) reds.push(`名单外新增 ${unexpectedAdded.length} 条：${unexpectedAdded.join(' | ')}`);
const warns = [...bogusDrift, ...bogusRemoved, ...bogusAdded];
if (warns.length) console.warn(`\n! 名单里写了但实际没这个方向的改动（改动回滚了就请把条目删掉）：\n  ${warns.join('\n  ')}`);

const ok = reds.length === 0;
console.log(
  ok
    ? `\n✅ 渲染不变性成立：市场域 ${before.size} 条规则里 ${shared.length - drifted.length} 条终值逐字相同，` +
        `${drifted.length} 条漂移 + ${removed.length} 条消失 + ${added.length} 条新增全部在册（理由见上），意外改动 0 条（rc=0）`
    : `\n❌ 判定为红（rc=1）：\n  ${reds.join('\n  ')}`,
);
process.exit(ok ? 0 : 1);

