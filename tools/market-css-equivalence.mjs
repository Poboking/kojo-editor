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
 *   node tools/market-css-equivalence.mjs                 # 默认基线 = 8518a647（L07 搬迁前的固定提交）
 *   node tools/market-css-equivalence.mjs <before-ref>    # 指定基线（组长复拍时可用集成分支）
 *
 * 默认基线的选法（2026-10-24 re-baseline）：`8518a647`（`370d71b1^`，批次十一 L08 的合流提交）。
 * 它是 `370d71b1`（组长代取的 L07 工作树快照 = 实际执行"迁回 market.css"的那一提交）的父提交，
 * 因此 market.css 仍只有 198 行追加段、基础层还在 styles-project.css（87 行 `.mk-`），
 * 正是"迁移前"的口径。
 * 为什么必须钉成固定提交（批次十一 R3，同一 sha 的第二次动因）：默认值原先写的是分支名
 * `b/misak/1023-visual-batch11`——**可变的集成分支**，组长每并一批就往前挪一截；挪到含
 * L07/L18 的呈现改动后，本文件三份名单相对它全部变成"写了但没这个方向的改动"的黄牌，
 * 这把秤就空转了。尺没有旧、账也没有漂：钉回搬迁前的固定提交重拍，L07 的 21 条与
 * L18 的 1+20 条逐条对齐、零黄牌。
 * 不用 tag 的原因：`v0.4.2-beta.2` 及更早的 tag 里还没有 `tokens.css`（四文件级联链是
 * 之后才拆出来的），`git show <tag>:tokens.css` 读不到，工具无法对拍；该 sha 在 `dev` 上
 * 永久可达，不会随短命批次分支删除而失效。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
/** 迁移前那一版（`370d71b1^`，完整 sha 钉死；理由见文件头「默认基线的选法」） */
const BEFORE_REF = ARGS[0] ?? '8518a6478d2d37bc99fe5fcd9df20c1e93ee2bd9';
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
  [' ⊃ .mk-name', 'L18：名字前面多一枚占位徽标 ⇒ 名字这一档改行内 flex，省略号从容器挪到 `.mk-name-text`（overflow hidden→visible、text-overflow ellipsis→clip，加 display/align-items/gap）'],
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
  [' ⊃ .mk-name-text', 'L18：名字的文字格——裁切与省略号住在这一格，徽标永不缩'],
  [' ⊃ .mk-emblem', 'L18：缺封面的「」母题徽标（包名首字 + 画出来的两枚直角；零图片零 emoji）'],
  [' ⊃ .mk-emblem::before,\n.mk-emblem::after', 'L18：「」的两笔（content:\'\' 形状，不是字符图标）'],
  [' ⊃ .mk-emblem::before', 'L18：左上角'],
  [' ⊃ .mk-emblem::after', 'L18：右下角'],
  [' ⊃ .mk-row:hover .mk-emblem::before,\n.mk-row:hover .mk-emblem::after', 'L18：整行 hover 才提 accent，静息不抢眼'],
  [' ⊃ .mk-emblem:empty::before,\n.mk-emblem:empty::after', 'L18：名字读不出可用字 ⇒ 只剩半透引号，仍不是坏图'],
  [' ⊃ .mk-main > .mk-sub:not(.mk-link)', 'L18：摘要抬到 fs-1 近 --fg 给层级；`:not(.mk-link)` 把来源那行留在子层 fs-0/--fg-dim'],
  [' ⊃ .mk-badge.mk-badge-warn', 'L18：「有更新」那枚胶囊改成 inline-flex（给那颗点让位）'],
  [' ⊃ .mk-badge.mk-badge-warn::before', 'L18：有事可做的一颗画出来的实心点（跟 currentColor 走 amber）'],
  [' ⊃ .mk-row .mk-update:not(:disabled)', 'L18：更新按钮与 amber 徽章同套语义色（首装仍 accent）'],
  [' ⊃ .mk-row .mk-update:not(:disabled):hover', 'L18：同上 hover 档'],
  [' ⊃ .mk-row .mk-update:disabled', 'L18：忙时这一枚的 cursor 是 progress 不是 not-allowed（此刻真在搬东西）'],
  [' ⊃ .mk-busyline', 'L18：进行中的行级骨架条（与 ui-kit kit-skeleton 类名并列；字仍只在 .mk-note）'],
  [' ⊃ .mk-guide', 'L18：失败态第二行「哪一步 + 下一步」——铁律 4 不许退化成只变色'],
  [' ⊃ .mk-body > .mk-empty', 'L18：空态格的井面档（KitEmpty 没有带边框的这一档；只补井面不抢版式）'],
  [' ⊃ .mk-body > .mk-empty .mk-empty-hint', 'L18：副句限宽 30ch，260px 侧栏里不贴井边'],
  ['@container (max-width: 300px) ⊃ .mk-name', 'L18：极窄侧栏里徽标与名字的沟收一档'],
  ['@container (max-width: 300px) ⊃ .mk-emblem', 'L18：极窄侧栏里整枚徽标小一档（尺寸跟着 em 走，不另立 px）'],
  ['@container (max-width: 300px) ⊃ .mk-emblem::before,\n  .mk-emblem::after', 'L18：极窄档里两枚角跟着比例走'],
  [' ⊃ .mk-cover', 'R3：封面在场的那一格（契约 cover 字段渲染面）——与母题同位互斥、同尺寸档（1.6em×fs-0），行高不因有无封面而跳；onError 退母题，不存在破图框态'],
  ['@container (max-width: 300px) ⊃ .mk-cover', 'R3：极窄侧栏里封面跟母题同一档缩（1.35em），有图没图仍等高'],
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

/**
 * 基线 ref 必须先**显式**验存在：`git show` 失败时若被兜成空集，会得出"基线 0 条"的
 * 假绿（分支/tag 被删后就静默失效）。这里宁可 rc=2 也不产出误导性读数。
 */
function assertRefUsable(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ROOT, stdio: 'pipe' });
  } catch {
    console.error(`[market-css-equivalence] 基线 ref 不存在：${ref}`);
    console.error('  请换一个存在的 ref（本仓的 tag / 分支 / 完整 commit sha 均可；默认基线见文件头注释）。');
    process.exit(2);
  }
  for (const file of FILES) {
    try {
      execFileSync('git', ['cat-file', '-e', `${ref}:${file}`], { cwd: ROOT, stdio: 'pipe' });
    } catch {
      console.error(`[market-css-equivalence] 基线 ref 里没有 ${file}：${ref}`);
      console.error('  这个 ref 太旧（四份样式表还没拆出来）或不是本仓坐标；请换一个存在的 ref。');
      process.exit(2);
    }
  }
}

function show(ref, file) {
  return execFileSync('git', ['show', `${ref}:${file}`], { cwd: ROOT, encoding: 'utf8' });
}
const work = (file) => readFileSync(path.join(ROOT, file), 'utf8');

assertRefUsable(BEFORE_REF);
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

