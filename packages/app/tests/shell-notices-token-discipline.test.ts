/**
 * `shell-notices.css` 的 token 纪律 + 遮罩色逐字等值对拍（视觉批十一 R6 债一 / 债二）。
 *
 * 立论：R5 把 light / mint-dark 的遮罩收口写进切片时顺手抄进 **20 枚裸 `rgba()`**（连注记里那句旧值
 * 引用共 21 次出现，全仓非 token CSS 的裸 rgba 出现数因此从 125 涨到 146）。本批把它们**逐字**
 * 搬进定义点（`tokens.css` 基座 =
 * dark 现值、`themes/light.css` / `themes/mint-dark.css` = 各自翻色），切片只留 `var()`。
 * 这是重构不是改设计，所以本文件干两件事：
 *  ①**防回潮**：切片里不许再有裸 hex / 裸 rgb()/rgba()/hsla() / 裸 px 圆角（`rgb(var(--x-rgb) / .4)`
 *    这种「token 分量 + alpha」算合规，同 `ui-kit-css.test.ts` 的折叠口径）——这是债二的验收面；
 *  ②**证明逐字相等**：把每条规则按档展开（吃 tokens.css + themes 的 `var()` 链）后与
 *    **改前那串字面量**逐字符比对（名单见 EXPECTED，29 条 = 切片里 ⑤ 的每一格 × 每一档）。
 *    只比"看起来差不多"没用：遮罩色是这批反复付过学费的地方（灰泥 / 蓝雾 / 实心档丢边界）。
 *
 * 顺带钉两件事，防止"为了绿而搬空"：
 *  - 切片必须**真在消费**这些 token（消费数下限），删规则逃判据在这里红；
 *  - dark 档（`styles.css` / `styles-project.css` 的裸类基座规则）也**必须真在消费**同一族 token：
 *    组长收敛 2026-10-24 把那里的字面量一并换成 `var(--scrim-*)`，本文件按 dark 档 token 表展开后
 *    与**收敛前那串字面量**逐字符比对（见 `describe('dark 档…')`）——从此"登记而未消费"这一格没了，
 *    三档同一条通路：定义点 = tokens.css + themes/*.css（只给值），消费点 = styles*.css 基座 + 切片 ⑤。
 *
 * 账本口径（与组长的尺子一致）：**非 token CSS**（tokens.css 与 themes/*.css 这两个定义点除外）里
 * `rgb(` / `rgba(` 的原文出现数，含注释。R6 改前 146 → R6 交付 125 → dark 收敛后 105。
 *
 * 本文件待在默认 node 环境（读源码文件）；头注释里不写任何 vitest 环境指令字面量（PITFALLS 183）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const noticesRaw = read('../src/shell-notices.css');
const tokensRaw = read('../src/tokens.css');
const lightRaw = read('../src/themes/light.css');
const mintRaw = read('../src/themes/mint-dark.css');
const stylesRaw = read('../src/styles.css');
const projectRaw = read('../src/styles-project.css');

/** 注释先剥：历史注记允许提旧值（与 `css-token-single-source.test.ts` 的 stripCssComments 同口径） */
const stripComments = (s: string): string => s.replace(/[/][*][\s\S]*?[*][/]/g, '');
/**
 * 两遍折叠（照 `ui-kit-css.test.ts`）：① `var(...)` → VAR；② 通道位由 token 供色的
 * `rgb()/rgba()`（`rgb(var(--accent-rgb) / .5)` → `rgb(VAR / .5)`）→ TOKENCOLOR。
 * 真硬编码的 `rgba(12, 34, 56, .4)` 里没有 VAR，第二遍不折，照样被下面那条判据打死。
 */
const foldTokens = (s: string): string =>
  s.replace(/var\([^()]*\)/g, 'VAR').replace(/rgba?\([^()]*VAR[^()]*\)/g, 'TOKENCOLOR');

const folded = foldTokens(stripComments(noticesRaw));
/** 空白压平（多行写法与单行写法等价；这是 CSS 语义，不是放宽判据） */
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/* ------------------------------ ① 微型 CSS / token 解析 ------------------------------ */

interface Rule {
  /** 所在 at-rule 头（`''` = 顶层；`@supports …` / `@media …`） */
  media: string;
  selector: string;
  body: string;
}

/** 按花括号配对拆「选择器 + 声明块」；at-rule 头记录下来（同一选择器在 @supports 里是另一格） */
function parseRules(src: string): Rule[] {
  const text = stripComments(src);
  const rules: Rule[] = [];
  const stack: { head: string; body: string }[] = [];
  let buf = '';
  for (const ch of text) {
    if (ch === '{') {
      stack.push({ head: squash(buf), body: '' });
      buf = '';
      continue;
    }
    if (ch === '}') {
      const top = stack.pop();
      if (top && !top.head.startsWith('@')) {
        const media = stack
          .filter((f) => f.head.startsWith('@'))
          .map((f) => f.head)
          .join(' ');
        rules.push({ media, selector: top.head, body: top.body });
      }
      buf = '';
      continue;
    }
    if (stack.length > 0) stack[stack.length - 1]!.body += ch;
    buf += ch;
  }
  return rules;
}

/** 某选择器（组选择器按逗号拆开）在某 prop 上的**后到者**声明值 */
function declOf(rules: readonly Rule[], selector: string, prop: string, mediaTag = ''): string | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i]!;
    if (!r.selector.split(',').map(squash).includes(selector)) continue;
    // ⚠ `mediaTag` 缺省 `''` = **只看顶层**（同一选择器在 `@supports` 里还有另一格，
    //    宽松前缀匹配会把回落格当成本体，读数就错了——这条判据踩过一次，收紧成精确）；
    //    传 `'@supports not'` 这类头时按前缀匹配（at-rule 头带各自的括号内容）。
    if (mediaTag === '' ? r.media !== '' : !r.media.startsWith(mediaTag)) continue;
    for (const part of r.body.split(';')) {
      const idx = part.indexOf(':');
      if (idx <= 0) continue;
      if (squash(part.slice(0, idx)).toLowerCase() !== prop) continue;
      return squash(part.slice(idx + 1));
    }
  }
  return undefined;
}

/** 声明块里的自定义属性表（同选择器后到覆盖先到） */
function rootDecls(rules: readonly Rule[], selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rules) {
    if (r.selector !== selector || r.media !== '') continue;
    for (const d of r.body.split(';')) {
      const idx = d.indexOf(':');
      if (idx <= 0) continue;
      const prop = squash(d.slice(0, idx));
      if (prop.startsWith('--')) out.set(prop, squash(d.slice(idx + 1)));
    }
  }
  return out;
}

const NOTICES = parseRules(noticesRaw);
const LIGHT_SEL = ":root[data-theme='light']";
const MINT_SEL = ":root[data-theme='mint-dark']";

/** 按档合成 token 终值表：tokens.css 裸 `:root` 打底，主题同名覆盖压上（与浏览器级联同构） */
function layer(themeSelector: string): Map<string, string> {
  const map = new Map(rootDecls(parseRules(tokensRaw), ':root'));
  for (const src of [lightRaw, mintRaw]) {
    for (const [k, v] of rootDecls(parseRules(src), themeSelector)) map.set(k, v);
  }
  return map;
}
const LAYERS: Readonly<Record<'light' | 'mint-dark', Map<string, string>>> = {
  light: layer(LIGHT_SEL),
  'mint-dark': layer(MINT_SEL),
};

function findCloseParen(s: string, open: number): number {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') d++;
    else if (s[i] === ')') {
      d--;
      if (d === 0) return i;
    }
  }
  return -1;
}

/** 把串里的 `var(--x)` / `var(--x, 兜底)` 迭代展开成字面串（32 轮上限顺带兜环 → null，不静默） */
function expandVars(value: string, map: Map<string, string>): string | null {
  let v = value;
  for (let iter = 0; iter < 32; iter++) {
    const m = /var\(/i.exec(v);
    if (!m || m.index === undefined) return v;
    const open = v.indexOf('(', m.index);
    const close = findCloseParen(v, open);
    if (close < 0) return null;
    const inner = v.slice(open + 1, close);
    let depth = 0;
    let comma = -1;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) {
        comma = i;
        break;
      }
    }
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? '' : inner.slice(comma + 1).trim();
    const tokenVal = map.get(name);
    const repl = tokenVal !== undefined ? tokenVal : fallback;
    if (repl === '') return null;
    v = v.slice(0, m.index) + repl + v.slice(close + 1);
  }
  return null;
}

/* ------------------------------ ② 改前字面量（期望值名单 = 判据本体） ------------------------------ */

interface Expected {
  theme: 'light' | 'mint-dark';
  selector: string;
  prop: string;
  /** 改前逐字抄自本切片（R5 交付形态）；多行处按 squash 口径比（空白对 CSS 无语义） */
  before: string;
  mediaTag?: string;
}

/** ⑤ 每一格 × 每一档，共 29 条（light 16 / mint-dark 13）；一条不落，漏一格就是"用删规则换绿" */
const EXPECTED: readonly Expected[] = [
  // —— light：确认面遮罩（渐变两端 + 实底） ——
  {
    theme: 'light',
    selector: ":root[data-theme='light'] .overlay-backdrop",
    prop: 'background',
    before: 'radial-gradient(130% 105% at 50% -5%, rgba(26, 34, 47, 0.4), rgba(14, 19, 27, 0.62)), rgba(18, 24, 33, 0.5)',
  },
  {
    theme: 'light',
    selector: ":root[data-theme='light'] .modal-mask",
    prop: 'background',
    before: 'radial-gradient(130% 105% at 50% -5%, rgba(26, 34, 47, 0.4), rgba(14, 19, 27, 0.62)), rgba(18, 24, 33, 0.5)',
  },
  // —— light：只读查询面（轻一档） ——
  {
    theme: 'light',
    selector: ":root[data-theme='light'] .overlay-backdrop:has(.ov-query)",
    prop: 'background',
    before: 'radial-gradient(130% 105% at 50% -5%, rgba(26, 34, 47, 0.24), rgba(14, 19, 27, 0.44)), rgba(18, 24, 33, 0.36)',
  },
  // —— light：命令面板 ——
  {
    theme: 'light',
    selector: ":root[data-theme='light'] .picker-backdrop",
    prop: 'background',
    before: 'rgba(18, 24, 33, 0.32)',
  },
  // —— light：浮层实描边（磨砂档三格同值） ——
  { theme: 'light', selector: ":root[data-theme='light'] .overlay-host", prop: 'border-color', before: 'rgba(23, 31, 43, 0.55)' },
  { theme: 'light', selector: ":root[data-theme='light'] .modal", prop: 'border-color', before: 'rgba(23, 31, 43, 0.55)' },
  { theme: 'light', selector: ":root[data-theme='light'] .picker", prop: 'border-color', before: 'rgba(23, 31, 43, 0.55)' },
  // —— light：实心档（旋钮 0%）遮罩 + 描边 ——
  {
    theme: 'light',
    selector: ":root[data-theme='light'][data-glass='solid'] .overlay-backdrop",
    prop: 'background',
    before: 'rgba(18, 24, 33, 0.52)',
  },
  {
    theme: 'light',
    selector: ":root[data-theme='light'][data-glass='solid'] .modal-mask",
    prop: 'background',
    before: 'rgba(18, 24, 33, 0.52)',
  },
  {
    theme: 'light',
    selector: ":root[data-theme='light'][data-glass='solid'] .picker-backdrop",
    prop: 'background',
    before: 'rgba(18, 24, 33, 0.52)',
  },
  {
    theme: 'light',
    selector: ":root[data-theme='light'][data-glass='solid'] .overlay-host",
    prop: 'border-color',
    before: 'rgba(23, 31, 43, 0.62)',
  },
  {
    theme: 'light',
    selector: ":root[data-theme='light'][data-glass='solid'] .modal",
    prop: 'border-color',
    before: 'rgba(23, 31, 43, 0.62)',
  },
  {
    theme: 'light',
    selector: ":root[data-theme='light'][data-glass='solid'] .picker",
    prop: 'border-color',
    before: 'rgba(23, 31, 43, 0.62)',
  },
  // —— light：老内核无 backdrop-filter 回落 ——
  {
    theme: 'light',
    selector: ":root[data-theme='light'] .overlay-backdrop",
    prop: 'background',
    before: 'rgba(18, 24, 33, 0.55)',
    mediaTag: '@supports not',
  },
  {
    theme: 'light',
    selector: ":root[data-theme='light'] .modal-mask",
    prop: 'background',
    before: 'rgba(18, 24, 33, 0.55)',
    mediaTag: '@supports not',
  },
  {
    theme: 'light',
    selector: ":root[data-theme='light'] .picker-backdrop",
    prop: 'background',
    before: 'rgba(18, 24, 33, 0.55)',
    mediaTag: '@supports not',
  },
  // —— mint-dark：确认面遮罩 + 描边 ——
  {
    theme: 'mint-dark',
    selector: ":root[data-theme='mint-dark'] .overlay-backdrop",
    prop: 'background',
    before: 'radial-gradient(130% 105% at 50% -5%, rgba(2, 10, 6, 0.36), rgba(2, 10, 6, 0.64)), rgba(5, 12, 8, 0.48)',
  },
  {
    theme: 'mint-dark',
    selector: ":root[data-theme='mint-dark'] .modal-mask",
    prop: 'background',
    before: 'radial-gradient(130% 105% at 50% -5%, rgba(2, 10, 6, 0.36), rgba(2, 10, 6, 0.64)), rgba(5, 12, 8, 0.48)',
  },
  { theme: 'mint-dark', selector: ":root[data-theme='mint-dark'] .overlay-host", prop: 'border-color', before: 'rgba(191, 232, 210, 0.34)' },
  { theme: 'mint-dark', selector: ":root[data-theme='mint-dark'] .modal", prop: 'border-color', before: 'rgba(191, 232, 210, 0.34)' },
  { theme: 'mint-dark', selector: ":root[data-theme='mint-dark'] .picker", prop: 'border-color', before: 'rgba(191, 232, 210, 0.34)' },
  // —— mint-dark：查询面（(0,4,0) 那一档墨绿） ——
  {
    theme: 'mint-dark',
    selector: ":root[data-theme='mint-dark'] .overlay-backdrop:has(.ov-query)",
    prop: 'background',
    before: 'radial-gradient(130% 105% at 50% -5%, rgba(2, 10, 6, 0.22), rgba(2, 10, 6, 0.42)), rgba(5, 12, 8, 0.34)',
  },
  // —— mint-dark：命令面板（组长收敛 2026-10-24，改前是 `themes/mint-dark.css` 末尾那条活规则） ——
  {
    theme: 'mint-dark',
    selector: ":root[data-theme='mint-dark'] .picker-backdrop",
    prop: 'background',
    before: 'rgba(6, 12, 9, 0.38)',
  },
  // —— mint-dark：实心档遮罩 + 描边（就是 `themes/mint-dark.css` 那条「事实纠正」注记说反了的那一处） ——
  {
    theme: 'mint-dark',
    selector: ":root[data-theme='mint-dark'][data-glass='solid'] .overlay-backdrop",
    prop: 'background',
    before: 'rgba(5, 12, 8, 0.56)',
  },
  {
    theme: 'mint-dark',
    selector: ":root[data-theme='mint-dark'][data-glass='solid'] .modal-mask",
    prop: 'background',
    before: 'rgba(5, 12, 8, 0.56)',
  },
  {
    theme: 'mint-dark',
    selector: ":root[data-theme='mint-dark'][data-glass='solid'] .picker-backdrop",
    prop: 'background',
    before: 'rgba(5, 12, 8, 0.56)',
  },
  {
    theme: 'mint-dark',
    selector: ":root[data-theme='mint-dark'][data-glass='solid'] .overlay-host",
    prop: 'border-color',
    before: 'rgba(191, 232, 210, 0.42)',
  },
  {
    theme: 'mint-dark',
    selector: ":root[data-theme='mint-dark'][data-glass='solid'] .modal",
    prop: 'border-color',
    before: 'rgba(191, 232, 210, 0.42)',
  },
  {
    theme: 'mint-dark',
    selector: ":root[data-theme='mint-dark'][data-glass='solid'] .picker",
    prop: 'border-color',
    before: 'rgba(191, 232, 210, 0.42)',
  },
];

/* ------------------------------ ③ 账本尺（组长口径） ------------------------------ */

const PKG_ROOT = fileURLToPath(new URL('../../../packages', import.meta.url));
function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === 'coverage') continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
/** token 定义点＝字面量**该**待着的地方，不进账本 */
const TOKEN_DEF_POINTS = ['tokens.css', 'light.css', 'mint-dark.css'];
const ledgerFiles = walk(PKG_ROOT).filter((p) => p.endsWith('.css') && !TOKEN_DEF_POINTS.includes(path.basename(p)));
const ledger = ledgerFiles.reduce((n, p) => n + (readFileSync(p, 'utf8').match(/rgba?[(]/g) ?? []).length, 0);

/* ------------------------------ ④ 判据 ------------------------------ */

describe('债二 · shell-notices.css 的 token 纪律（防回潮）', () => {
  it('文件确实被读到（防"空字符串全绿"）', () => {
    expect(noticesRaw.length).toBeGreaterThan(8000);
    expect(folded).toContain('.overlay-backdrop');
    expect(NOTICES.length).toBeGreaterThan(20);
  });

  it('var 之外零 hex / rgb() / rgba() / hsla() 字面量', () => {
    expect(folded).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(folded).not.toMatch(/\brgba?\(/);
    expect(folded).not.toMatch(/\bhsla?\(/);
  });

  it('圆角不许裸 px（50% / 0 这类几何豁免，同 ui-kit 口径）', () => {
    expect(folded).not.toMatch(/border-radius:[^;]*\d+px/);
  });

  it('字号不许裸 px（一律 --fs-*）', () => {
    expect(folded).not.toMatch(/font-size:[^;]*\d+(?:\.\d+)?px/);
  });

  it('切片真在消费遮罩 token（删规则逃判据在这里红）', () => {
    const occ = (needle: string): number => noticesRaw.split(needle).length - 1;
    const scrimUses = occ('var(--scrim');
    const rimUses = occ('var(--rim');
    // 改前是 20 枚遮罩字面量 + 4 枚描边字面量，落在 16 + 4 条声明里（一条声明常同时带渐变两端 + 实底）；
    // 这里给下限不给上限（以后加格只许更多消费，不许把规则删了换绿）
    expect(scrimUses, `遮罩 token 的声明格数低于 16（现 ${scrimUses}）—— 有人删规则而不是搬 token`).toBeGreaterThanOrEqual(16);
    expect(rimUses, `rim token 的声明格数低于 4（现 ${rimUses}）`).toBeGreaterThanOrEqual(4);
  });

  it(`全仓非 token CSS 的裸 rgba 账本只许降不许涨（R6 改前 146 → 现测 ${ledger}）`, () => {
    expect(ledger, '账本涨了：新抄的字面量请进 tokens.css / themes/*.css 的定义点').toBeLessThanOrEqual(105);
    console.log(`[token-hygiene] 非 token CSS 裸 rgba 出现数 = ${ledger}（R5 交付后 146 → R6 125 → dark 收敛 105）`);
  });
});

describe('债一 · 遮罩色逐字等值（改前字面量当期望值，28 条逐格点名）', () => {
  const bad: string[] = [];
  const missing: string[] = [];
  for (const e of EXPECTED) {
    const got = declOf(NOTICES, e.selector, e.prop, e.mediaTag ?? '');
    if (got === undefined) {
      missing.push(`${e.theme}: ${e.selector} { ${e.prop} }`);
      continue;
    }
    const expanded = expandVars(got, LAYERS[e.theme]);
    if (expanded === null) {
      bad.push(`${e.theme}: ${e.selector} { ${e.prop}: ${got} } —— var() 展开失败（环 / 无定义且无兜底）`);
      continue;
    }
    if (squash(expanded) !== squash(e.before)) {
      bad.push(`${e.theme}: ${e.selector} { ${e.prop} }\n      改前 ${squash(e.before)}\n      现值 ${squash(expanded)}`);
    }
  }

  it('名单本身够格（29 条 = ⑤ 的每一格每一档，覆盖不全的"绿"不算数）', () => {
    expect(EXPECTED.length).toBeGreaterThanOrEqual(29);
    expect(EXPECTED.filter((e) => e.theme === 'light')).toHaveLength(16);
    expect(EXPECTED.filter((e) => e.theme === 'mint-dark')).toHaveLength(13);
  });

  it('每格都还在（没有靠删规则换绿）', () => {
    expect(missing, `切片里找不到这些规则：\n${missing.join('\n')}`).toEqual([]);
  });

  it('展开后与改前逐字相等：0 格漂移', () => {
    expect(bad, `终值漂移 ${bad.length} 格：\n${bad.join('\n')}`).toEqual([]);
  });

  it('两档都真吃到各自的翻色（不是 light 的值漏进 mint）', () => {
    expect(LAYERS.light.get('--scrim-fill')).toBe('rgba(18, 24, 33, 0.5)');
    expect(LAYERS['mint-dark'].get('--scrim-fill')).toBe('rgba(5, 12, 8, 0.48)');
    expect(LAYERS.light.get('--rim-1')).toBe('rgba(23, 31, 43, 0.55)');
    expect(LAYERS['mint-dark'].get('--rim-1')).toBe('rgba(191, 232, 210, 0.34)');
    // dark 档基座不许被主题污染（tokens.css 的裸 `:root` 就是 styles 侧那条基座规则读的那一档）
    const dark = new Map(rootDecls(parseRules(tokensRaw), ':root'));
    expect(dark.get('--scrim-fill')).toBe('rgba(8, 10, 13, 0.4)');
    expect(dark.get('--rim-1')).toBe('var(--border)');
  });
});

describe('dark 档收敛 · styles 的遮罩格吃 token，展开后与收敛前逐字相等', () => {
  const dark = new Map(rootDecls(parseRules(tokensRaw), ':root'));
  const FILES: readonly [name: string, rules: Rule[]][] = [
    ['styles.css', parseRules(stylesRaw)],
    ['styles-project.css', parseRules(projectRaw)],
  ];

  interface DarkSlot {
    /** 组选择器拆开后的那一格 */
    selector: string;
    /** **收敛前**逐字抄自这两份文件的字面量（两侧当时同值，见 git `68b7c667`） */
    before: string;
    /** 这条遮罩格必须吃掉的 token 名：字面量回潮 = 定义点外又冒出一张嘴，当场红 */
    token: string;
    mediaTag?: string;
    /** 轻档没有这一格（拆分时它属于项目态）⇒ 只对懒档判，别拿"轻档找不到"当假红 */
    projectOnly?: boolean;
  }

  const SLOTS: readonly DarkSlot[] = [
    {
      selector: '.modal-mask',
      before: 'radial-gradient(130% 105% at 50% -5%, rgba(0, 0, 0, 0.28), rgba(0, 0, 0, 0.55)), rgba(8, 10, 13, 0.4)',
      token: '--scrim-a',
    },
    {
      selector: '.overlay-backdrop',
      before: 'radial-gradient(130% 105% at 50% -5%, rgba(0, 0, 0, 0.28), rgba(0, 0, 0, 0.55)), rgba(8, 10, 13, 0.4)',
      token: '--scrim-fill',
    },
    {
      selector: '.overlay-backdrop:has(.ov-query)',
      before: 'radial-gradient(130% 105% at 50% -5%, rgba(0, 0, 0, 0.16), rgba(0, 0, 0, 0.34)), rgba(8, 10, 13, 0.28)',
      token: '--scrim-query-a',
      mediaTag: '@supports',
      projectOnly: true,
    },
    { selector: '.picker-backdrop', before: 'rgba(8, 10, 13, 0.35)', token: '--scrim-picker', projectOnly: true },
    { selector: ":root[data-glass='solid'] .modal-mask", before: 'rgba(0, 0, 0, 0.45)', token: '--scrim-solid' },
    { selector: '.modal-mask', before: 'rgba(0, 0, 0, 0.5)', token: '--scrim-nofilter', mediaTag: '@supports not' },
  ];

  for (const s of SLOTS) {
    for (const [name, rules] of FILES) {
      if (s.projectOnly && name === 'styles.css') continue;
      it(`${name} 的 \`${s.selector} { background }\` 真吃 ${s.token} 且展开 ≡ 收敛前字面量`, () => {
        const got = declOf(rules, s.selector, 'background', s.mediaTag ?? '');
        expect(got, `遮罩格消失了：${name} 里找不到 ${s.selector} { background }`).toBeDefined();
        expect(got!, `${name} 的 ${s.selector} 没吃 token —— 把字面量抄回 styles 就是重新开第二张口径`).toContain(
          `var(${s.token})`,
        );
        const expanded = expandVars(got!, dark);
        expect(expanded, `${name} 的 ${s.selector}：var() 展开失败（环 / 无定义且无兜底）`).not.toBeNull();
        expect(squash(expanded!), `${name} 的 ${s.selector} 展开后与收敛前分叉`).toBe(squash(s.before));
      });
    }
  }

  it('三档同路：token 定义点（themes/*.css）不写遮罩规则，只给值', () => {
    // 收敛前 light.css 有四条、mint-dark.css 有两条同分遮罩规则，全部被 ⑤ 遮蔽 = 死口径 + 旧值漂移的隐患
    for (const [name, src] of [
      ['themes/light.css', lightRaw],
      ['themes/mint-dark.css', mintRaw],
    ] as const) {
      const decls = parseRules(src).filter((r) => /\b(overlay-backdrop|modal-mask|picker-backdrop)\b/.test(r.selector));
      expect(decls, `${name} 里又出现了遮罩规则（${decls.map((d) => d.selector).join(' / ')}）—— 消费点只有 shell-notices.css ⑤`).toEqual([]);
    }
  });

  it('mint 档的 --scrim-picker 不再缺登记；老内核回落仍不给 mint（沿用基座纯黑）', () => {
    expect(LAYERS['mint-dark'].get('--scrim-picker')).toBe('rgba(6, 12, 9, 0.38)');
    const mintOwn = rootDecls(parseRules(mintRaw), MINT_SEL);
    // 这条不许被"补齐对称性"顺手填上：填了就是改设计（老内核的遮罩本来就退回基座黑）
    expect(mintOwn.has('--scrim-nofilter'), 'mint-dark.css 里登记了 --scrim-nofilter —— 基座纯黑是有意的').toBe(false);
    expect(LAYERS['mint-dark'].get('--scrim-nofilter')).toBe('rgba(0, 0, 0, 0.5)');
  });
});
