import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 主题侧与组件侧的颜色单源（VIS-54 外挂补票 + VIS-52 遮罩第二条通路）。
 *
 * 立论（`tokens.css:133` 那句「主题侧只翻值、不写规则」的落地口径）：
 *  1. `themes/light.css` / `themes/mint-dark.css` 里，**定义点**（那块 `:root[data-theme=…]`）
 *     可以有色值——它就是干这个的；**外挂规则**（挂在具体选择器上的 `[data-theme]` 覆盖）
 *     一个色值都不许写：要么 `var()` 取定义点的值，要么 `color-mix(in srgb, var(--x) N%, transparent)`
 *     由 token 现派生。否则同一支色在两个地方各抄一份，翻色的人只动定义点就永远追不上规则。
 *  2. 派生**不许漂**：本文件把 2026-10-26 E3 改动前的那串字面量当期望值，把改后的声明
 *     按档展开（`var()` 链 → `color-mix()` 求值 → 8bit 归一）后逐格比对。
 *     对不上就是"借重构偷偷调色"（`shell-notices-token-discipline.test.ts` 的遮罩对拍同一个口径）。
 *  3. 外挂规则**只许越删越少**（light 改前 15 条 / mint 改前 11 条）。
 *  4. 遮罩只能有一条通路（VIS-52）：`ui/palette.css` 全文件零色值，且 `.pk-mask` 不许再写
 *     `background`——原先那 7 条 `html:root[…][data-theme] .picker-backdrop.pk-mask { background: rgba(…) }`
 *     是 `--scrim-*` 族之外的第二张嘴，删干净后命令面板与快速打开共用同一枚 `--scrim-picker`。
 *
 * 纯 node 源码判据（本池 environment=node，不起壳、无 DOM），照 `code-font.test.ts` /
 * `font-presets.test.ts` 那种「CSS ↔ TS 互抄」的静态对拍先例。
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const tokensRaw = read('../src/tokens.css');
const lightRaw = read('../src/themes/light.css');
const mintRaw = read('../src/themes/mint-dark.css');
const paletteRaw = read('../src/ui/palette.css');
const projectRaw = read('../src/styles-project.css');

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/* ------------------------------ ① 微型 CSS 解析 ------------------------------ */

interface Rule {
  selector: string;
  body: string;
}

/** 按花括号配对拆「选择器 + 声明块」（只要顶层规则：主题文件的 :root 与外挂规则都在顶层） */
function parseRules(src: string): Rule[] {
  const text = stripComments(src);
  const out: Rule[] = [];
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
      if (top && !top.head.startsWith('@') && stack.length === 0) out.push({ selector: top.head, body: top.body });
      buf = '';
      continue;
    }
    if (stack.length > 0) stack[stack.length - 1]!.body += ch;
    buf += ch;
  }
  return out;
}

/** 某选择器（组选择器按逗号拆开）在某 prop 上的**后到者**声明值 */
function declOf(rules: readonly Rule[], selector: string, prop: string): string | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i]!;
    if (!r.selector.split(',').map(squash).includes(selector)) continue;
    for (const part of r.body.split(';')) {
      const idx = part.indexOf(':');
      if (idx <= 0) continue;
      if (squash(part.slice(0, idx)).toLowerCase() !== prop) continue;
      const v = squash(part.slice(idx + 1));
      if (v !== '') return v;
    }
  }
  return undefined;
}

/** `:root` 声明块里的自定义属性表（后到覆盖先到） */
function rootDecls(rules: readonly Rule[], selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rules) {
    if (r.selector !== selector) continue;
    for (const d of r.body.split(';')) {
      const idx = d.indexOf(':');
      if (idx <= 0) continue;
      const prop = squash(d.slice(0, idx));
      if (prop.startsWith('--')) {
        const v = squash(d.slice(idx + 1));
        if (v !== '') out.set(prop, v);
      }
    }
  }
  return out;
}

const LIGHT_SEL = ":root[data-theme='light']";
const MINT_SEL = ":root[data-theme='mint-dark']";
const DARK_LAYER = rootDecls(parseRules(tokensRaw), ':root');

/** 按档合成终值表：tokens.css 裸 `:root` 打底，主题同名覆盖压上（与浏览器级联同构） */
function layer(themeSelector: string, themeSrc: string): Map<string, string> {
  return new Map([...DARK_LAYER, ...rootDecls(parseRules(themeSrc), themeSelector)]);
}

const LAYERS = {
  dark: DARK_LAYER,
  light: layer(LIGHT_SEL, lightRaw),
  'mint-dark': layer(MINT_SEL, mintRaw),
} as const;

type Tier = keyof typeof LAYERS;

/* ------------------------------ ② 颜色求值（var → color-mix → 8bit） ------------------------------ */

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function findClose(s: string, open: number): number {
  let d = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '(') d += 1;
    else if (s[i] === ')') {
      d -= 1;
      if (d === 0) return i;
    }
  }
  return -1;
}

/** 迭代展开 `var(--x)` / `var(--x, 兜底)`（32 轮上限顺带兜环 → null，绝不静默） */
function expandVars(value: string, map: Map<string, string>): string | null {
  let v = value;
  for (let iter = 0; iter < 32; iter += 1) {
    const m = /var\(/i.exec(v);
    if (!m || m.index === undefined) return v;
    const open = v.indexOf('(', m.index);
    const close = findClose(v, open);
    if (close < 0) return null;
    const inner = v.slice(open + 1, close);
    let depth = 0;
    let comma = -1;
    for (let i = 0; i < inner.length; i += 1) {
      const c = inner[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      else if (c === ',' && depth === 0) {
        comma = i;
        break;
      }
    }
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? '' : inner.slice(comma + 1).trim();
    const got = map.get(name);
    const repl = got !== undefined ? got : fallback;
    if (repl === '') return null;
    v = v.slice(0, m.index) + repl + v.slice(close + 1);
  }
  return null;
}

const clamp = (n: number): number => Math.max(0, Math.min(255, n));

function parseColor(raw: string): Rgba | null {
  const v = squash(raw);
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(v);
  if (hex) {
    const h = hex[1]!;
    const at = (i: number, w: number): number => {
      const part = h.slice(i, i + w);
      return w === 1 ? Number.parseInt(part + part, 16) : Number.parseInt(part, 16);
    };
    if (h.length === 3 || h.length === 4) return { r: at(0, 1), g: at(1, 1), b: at(2, 1), a: h.length === 4 ? at(3, 1) / 255 : 1 };
    if (h.length === 6 || h.length === 8) return { r: at(0, 2), g: at(2, 2), b: at(4, 2), a: h.length === 8 ? at(6, 2) / 255 : 1 };
    return null;
  }
  if (/^transparent$/i.test(v)) return { r: 0, g: 0, b: 0, a: 0 };
  const fn = /^rgba?\(([^)]*)\)$/i.exec(v);
  if (fn) {
    const inner = fn[1]!.replace(/,/g, ' ');
    const slash = inner.indexOf('/');
    const main = slash < 0 ? inner : inner.slice(0, slash);
    const alphaRaw = slash < 0 ? null : inner.slice(slash + 1).trim();
    const parts = main.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 3) return null;
    const num = (t: string): number | null => {
      if (t.endsWith('%')) {
        const p = Number.parseFloat(t);
        return Number.isFinite(p) ? clamp((p / 100) * 255) : null;
      }
      const n = Number.parseFloat(t);
      return Number.isFinite(n) ? clamp(n) : null;
    };
    const r = num(parts[0]!);
    const g = num(parts[1]!);
    const b = num(parts[2]!);
    if (r === null || g === null || b === null) return null;
    const alphaRawStr = alphaRaw ?? (parts.length >= 4 ? parts[3]! : '1');
    const a = alphaRawStr.endsWith('%') ? Number.parseFloat(alphaRawStr) / 100 : Number.parseFloat(alphaRawStr);
    if (!Number.isFinite(a)) return null;
    return { r, g, b, a: Math.max(0, Math.min(1, a)) };
  }
  return null;
}

/**
 * `color-mix(in srgb, A p%, B [q%])` → RGBA。
 * 照 CSS Color 5 的**预乘**插值：结果 alpha = p·αA + q·αB，通道 = 预乘后除回结果 alpha。
 * 与 `transparent` 混色时 ⇒ 通道全取 A、alpha 缩到 p（这正是"由 token 派生 wash"的算式）。
 */
function evalColorMix(value: string, map: Map<string, string>): string | null {
  let v = value;
  for (let iter = 0; iter < 8; iter += 1) {
    const m = /color-mix\(/i.exec(v);
    if (!m || m.index === undefined) return v;
    const open = v.indexOf('(', m.index);
    const close = findClose(v, open);
    if (close < 0) return null;
    const args = v.slice(open + 1, close);
    const splitTop = (s: string): string[] => {
      const out: string[] = [];
      let depth = 0;
      let buf = '';
      for (const c of s) {
        if (c === '(') depth += 1;
        if (c === ')') depth -= 1;
        if (c === ',' && depth === 0) {
          out.push(buf);
          buf = '';
          continue;
        }
        buf += c;
      }
      out.push(buf);
      return out.map(squash);
    };
    const parts = splitTop(args);
    const [colorspace, first, second] = parts;
    if (!colorspace || !/^in\s+srgb$/i.test(colorspace) || !first || !second) return null;
    const readLeg = (leg: string): { color: Rgba | null; pct: number | null } => {
      const pc = /(-?\d*\.?\d+)%\s*$/.exec(leg);
      const colorRaw = pc ? leg.slice(0, pc.index).trim() : leg;
      const expanded = expandVars(colorRaw, map);
      return { color: expanded === null ? null : parseColor(expanded), pct: pc ? Number.parseFloat(pc[1]!) / 100 : null };
    };
    const A = readLeg(first);
    const B = readLeg(second);
    if (!A.color || !B.color) return null;
    const ca = A.color;
    const cb = B.color;
    const p1 = A.pct ?? (B.pct === null ? 0.5 : 1 - B.pct);
    const p2 = B.pct ?? 1 - p1;
    const alpha = p1 * ca.a + p2 * cb.a;
    const chan = (x: number, y: number): number => (alpha === 0 ? 0 : clamp((p1 * ca.a * x + p2 * cb.a * y) / alpha));
    const mixed: Rgba = { r: chan(ca.r, cb.r), g: chan(ca.g, cb.g), b: chan(ca.b, cb.b), a: alpha };
    v = v.slice(0, m.index) + canonical(mixed) + v.slice(close + 1);
  }
  return null;
}

/** 把一段 CSS 值归一成可比串：展开 var、算掉 color-mix、每枚颜色写成 `rgba(R, G, B, A)` */
function normalize(value: string, map: Map<string, string>): string | null {
  const expanded = evalColorMix(value, map);
  if (expanded === null) return null;
  const done = expandVars(expanded, map);
  if (done === null) return null;
  const out = done.replace(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\btransparent\b/gi, (token) => {
    const c = parseColor(token);
    return c === null ? token : canonical(c);
  });
  return squash(out);
}

/** 8bit 归一（浏览器最终就是这个位深；0.5 与 0.5000000001 视为同一格） */
function canonical(c: Rgba): string {
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Math.round(c.a * 1e4) / 1e4})`;
}

/* ------------------------------ ③ 判据一：外挂规则零色值 ------------------------------ */

interface OuterRule {
  tier: Tier;
  selector: string;
  body: string;
}

/** 定义点（`:root[data-theme=…]`）之外的每一条规则 = 外挂规则 */
function outerRulesOf(tier: Tier, themeSelector: string, src: string): OuterRule[] {
  return parseRules(src)
    .filter((r) => r.selector !== themeSelector && r.selector !== '')
    .map((r) => ({ tier, selector: r.selector, body: stripComments(r.body) }));
}

const LIGHT_OUTER = outerRulesOf('light', LIGHT_SEL, lightRaw);
const MINT_OUTER = outerRulesOf('mint-dark', MINT_SEL, mintRaw);
/** 字面色：hex / rgb() / rgba() / hsl()；`transparent` 与 `currentColor` 是关键字不是色值抄本 */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bhsl\(/;
/**
 * 合规形态先折掉（照 `ui-kit-css.test.ts` / `shell-notices-token-discipline.test.ts` 的两遍折叠）：
 * ① `var(...)` → VAR；② **通道由 token 供色**的 `rgb(var(--x-rgb) / .16)` → TOKENCOLOR。
 * 真抄本 `rgba(138, 90, 4, .1)` 里没有 VAR，第二遍不折，照样被判据打死。
 */
const foldTokenFed = (s: string): string => s.replace(/var\([^()]*\)/g, 'VAR').replace(/rgba?\([^()]*VAR[^()]*\)/g, 'TOKENCOLOR');

describe('VIS-54 主题外挂规则零字面色（值只住定义点，规则只 var()/color-mix()）', () => {
  it('两档的外挂规则都真被读到（防"空数组全绿"）', () => {
    expect(LIGHT_OUTER.length, 'light.css 外挂规则解析出 0 条 = 解析器断了').toBeGreaterThan(0);
    expect(MINT_OUTER.length, 'mint-dark.css 外挂规则解析出 0 条 = 解析器断了').toBeGreaterThan(0);
  });

  it('light：每一条外挂规则的每一条声明都不夹带色值', () => {
    const bad: string[] = [];
    for (const r of LIGHT_OUTER) {
      for (const d of foldTokenFed(r.body).split(';')) {
        if (COLOR_LITERAL.test(d)) bad.push(`. ${r.selector} { ${squash(d)} }`);
      }
    }
    expect(bad.join('\n'), `light.css 外挂规则里还有 ${bad.length} 条写着字面色：\n${bad.join('\n')}`).toBe('');
  });

  it('mint-dark：同上（含那枚裸 hex `#7fd28e` 的去处）', () => {
    const bad: string[] = [];
    for (const r of MINT_OUTER) {
      for (const d of foldTokenFed(r.body).split(';')) {
        if (COLOR_LITERAL.test(d)) bad.push(`. ${r.selector} { ${squash(d)} }`);
      }
    }
    expect(bad.join('\n'), `mint-dark.css 外挂规则里还有 ${bad.length} 条写着字面色：\n${bad.join('\n')}`).toBe('');
  });

  it('外挂规则条数只许降：light 15→12、mint 11→10（加一条新覆盖先回答"base 为什么兜不住"）', () => {
    expect(LIGHT_OUTER.length, 'light.css 外挂规则回潮').toBeLessThanOrEqual(12);
    expect(MINT_OUTER.length, 'mint-dark.css 外挂规则回潮').toBeLessThanOrEqual(10);
  });

  it('删掉的三条确实是冗余（base 展开后与本档那枚 token 逐字同值）', () => {
    const PROJECT = parseRules(projectRaw);
    // `.kd-error`：base 写 var(--danger)，本档删的那条写 var(--red)
    for (const tier of ['light', 'mint-dark'] as const) {
      const map = LAYERS[tier];
      expect(declOf(PROJECT, '.kd-error', 'color'), `${tier}：base 的 .kd-error 不再是 var(--danger)`).toBe('var(--danger)');
      expect(normalize('var(--danger)', map)).toBe(normalize('var(--red)', map));
    }
    // `.dd-modified .dd-path`：base var(--warn) ≡ var(--amber)；`.dd-*-only .dd-path`：base 就是 var(--fg-dim)
    expect(declOf(PROJECT, '.dd-modified .dd-path', 'color'), 'base 的 .dd-modified 不再是 var(--warn)').toBe('var(--warn)');
    expect(normalize('var(--warn)', LAYERS.light)).toBe(normalize('var(--amber)', LAYERS.light));
    expect(declOf(PROJECT, '.dd-workspace-only .dd-path', 'color')).toBe('var(--fg-dim)');
    expect(declOf(PROJECT, '.dd-game-only .dd-path', 'color')).toBe('var(--fg-dim)');
  });
});

/* ------------------------------ 判据二：改前终值 = 改后终值（逐格点名） ------------------------------ */

interface Slot {
  tier: Tier;
  selector: string;
  prop: string;
  /** 2026-10-26 E3 改前逐字抄自该文件的字面量（或当时已成立的派生式） */
  before: string;
}

const PRE_E3: readonly Slot[] = [
  // —— light：装饰"光"族（改前是写在规则里的白字面） ——
  {
    tier: 'light',
    selector: ":root[data-theme='light'] .u-sheen::before",
    prop: 'background',
    before: 'linear-gradient(100deg, transparent, rgba(255, 255, 255, 0.28), transparent)',
  },
  {
    tier: 'light',
    selector: ":root[data-theme='light'] .u-ripple::after",
    prop: 'background',
    before: 'radial-gradient(circle, rgba(255, 255, 255, 0.42) 0%, rgba(255, 255, 255, 0) 60%)',
  },
  { tier: 'light', selector: ":root[data-theme='light'] .tutorial-code", prop: 'box-shadow', before: '0 1px 2px rgba(35, 48, 64, 0.1)' },
  { tier: 'light', selector: ":root[data-theme='light'] .tutorial-code code", prop: 'box-shadow', before: 'inset 0 1px 0 rgba(35, 48, 64, 0.06)' },
  // —— light：语义 wash（改前是档内私有色 rgb(14 107 44 / .1) 一类的十进制抄本） ——
  { tier: 'light', selector: ":root[data-theme='light'] .kd-banner.ok", prop: 'background', before: 'rgb(14 107 44 / 0.1)' },
  { tier: 'light', selector: ":root[data-theme='light'] .notice.warn", prop: 'background', before: 'rgb(138 90 4 / 0.1)' },
  { tier: 'light', selector: ":root[data-theme='light'] .notice.warn", prop: 'border-color', before: 'rgb(138 90 4 / 0.38)' },
  { tier: 'light', selector: ":root[data-theme='light'] .notice.error", prop: 'background', before: 'rgb(180 35 46 / 0.08)' },
  { tier: 'light', selector: ":root[data-theme='light'] .notice.error", prop: 'border-color', before: 'rgb(180 35 46 / 0.38)' },
  { tier: 'light', selector: ":root[data-theme='light'] .crash-recovery", prop: 'background', before: 'rgb(138 90 4 / 0.1)' },
  { tier: 'light', selector: ":root[data-theme='light'] .crash-recovery", prop: 'border-color', before: 'rgb(138 90 4 / 0.4)' },
  { tier: 'light', selector: ":root[data-theme='light'] .sb-writable.ok", prop: 'background', before: 'rgb(14 107 44 / 0.1)' },
  { tier: 'light', selector: ":root[data-theme='light'] .sb-writable.ok", prop: 'border-color', before: 'rgb(14 107 44 / 0.34)' },
  { tier: 'light', selector: ":root[data-theme='light'] .sb-writable.ro", prop: 'background', before: 'rgb(138 90 4 / 0.08)' },
  { tier: 'light', selector: ":root[data-theme='light'] .sb-writable.ro", prop: 'border-color', before: 'rgb(138 90 4 / 0.34)' },
  { tier: 'light', selector: ":root[data-theme='light'] .sb-writable.ro:hover", prop: 'background', before: 'rgb(138 90 4 / 0.1)' },
  { tier: 'light', selector: ":root[data-theme='light'] .sb-writable.ro:hover", prop: 'border-color', before: 'rgb(138 90 4 / 0.55)' },
  { tier: 'light', selector: ":root[data-theme='light'] .conv-failed", prop: 'background', before: 'rgb(180 35 46 / 0.08)' },
  { tier: 'light', selector: ":root[data-theme='light'] .conv-failed", prop: 'border-color', before: 'rgb(180 35 46 / 0.42)' },
  // —— mint-dark ——
  {
    tier: 'mint-dark',
    selector: ":root[data-theme='mint-dark'] button.primary .hint",
    prop: 'border-color',
    before: 'rgba(7, 33, 24, 0.35)',
  },
  { tier: 'mint-dark', selector: ":root[data-theme='mint-dark'] button.primary .hint", prop: 'background', before: 'rgba(7, 33, 24, 0.14)' },
  {
    tier: 'mint-dark',
    selector: ":root[data-theme='mint-dark'] .switch-thumb",
    prop: 'box-shadow',
    before: '0 1px 2px rgba(2, 10, 6, 0.5), 0 0 0 1px rgba(191, 232, 210, 0.4)',
  },
  {
    tier: 'mint-dark',
    selector: ":root[data-theme='mint-dark'] .welcome::before",
    prop: 'background',
    before:
      'radial-gradient(36% 40% at 30% 32%, rgba(53, 208, 160, 0.16), transparent 62%), radial-gradient(32% 38% at 72% 68%, rgba(56, 168, 196, 0.13), transparent 64%)',
  },
  {
    tier: 'mint-dark',
    selector: ":root[data-theme='mint-dark'] .u-sheen::before",
    prop: 'background',
    before: 'linear-gradient(100deg, transparent, rgba(226, 255, 241, 0.16), transparent)',
  },
  {
    tier: 'mint-dark',
    selector: ":root[data-theme='mint-dark'] .u-ripple::after",
    prop: 'background',
    before: 'radial-gradient(circle, rgba(214, 255, 236, 0.3) 0%, rgba(214, 255, 236, 0) 60%)',
  },
  { tier: 'mint-dark', selector: ":root[data-theme='mint-dark'] .notice.warn", prop: 'background', before: 'rgba(216, 162, 105, 0.12)' },
  { tier: 'mint-dark', selector: ":root[data-theme='mint-dark'] .crash-recovery", prop: 'border-color', before: 'rgba(216, 162, 105, 0.45)' },
  { tier: 'mint-dark', selector: ":root[data-theme='mint-dark'] .notice.error", prop: 'background', before: 'rgba(226, 112, 122, 0.12)' },
  { tier: 'mint-dark', selector: ":root[data-theme='mint-dark'] .conv-failed", prop: 'border-color', before: 'rgba(226, 112, 122, 0.55)' },
  { tier: 'mint-dark', selector: ":root[data-theme='mint-dark'] .sb-writable.ok", prop: 'background', before: 'rgba(98, 199, 118, 0.12)' },
  { tier: 'mint-dark', selector: ":root[data-theme='mint-dark'] .sb-writable.ok", prop: 'border-color', before: 'rgba(98, 199, 118, 0.4)' },
  { tier: 'mint-dark', selector: ":root[data-theme='mint-dark'] .kd-banner.ok", prop: 'background', before: 'rgba(98, 199, 118, 0.14)' },
  { tier: 'mint-dark', selector: ":root[data-theme='mint-dark'] .kd-banner.ok", prop: 'color', before: '#7fd28e' },
];

const THEME_SRC: Readonly<Record<Tier, string>> = { dark: tokensRaw, light: lightRaw, 'mint-dark': mintRaw };

describe('VIS-54 逐格对拍：改前那串字面量 = 改后按档展开的终值', () => {
  it('名单够长（light 19 格 / mint 13 格，短了就等于把对拍写松）', () => {
    expect(PRE_E3.filter((s) => s.tier === 'light').length).toBeGreaterThanOrEqual(19);
    expect(PRE_E3.filter((s) => s.tier === 'mint-dark').length).toBeGreaterThanOrEqual(13);
  });

  const missing: string[] = [];
  const drift: string[] = [];
  for (const slot of PRE_E3) {
    const rules = parseRules(THEME_SRC[slot.tier]);
    const got = declOf(rules, slot.selector, slot.prop);
    if (got === undefined) {
      missing.push(`${slot.tier}: ${slot.selector} { ${slot.prop} }`);
      continue;
    }
    const before = normalize(slot.before, LAYERS[slot.tier]);
    const after = normalize(got, LAYERS[slot.tier]);
    if (before === null || after === null) {
      drift.push(`${slot.tier}: ${slot.selector} { ${slot.prop}: ${got} } —— 展开失败（环 / 未知形式）`);
      continue;
    }
    if (before !== after) {
      drift.push(`${slot.tier}: ${slot.selector} { ${slot.prop} }\n      改前 ${before}\n      现值 ${after}`);
    }
  }

  it('每一格都还在（没有靠删规则换绿）', () => {
    expect(missing, `找不到这些规则格：\n${missing.join('\n')}`).toEqual([]);
  });

  it('展开后与改前逐字相等：0 格漂移', () => {
    expect(drift, `终值漂移 ${drift.length} 格：\n${drift.join('\n')}`).toEqual([]);
  });

  it('每一格现值都必须真的吃 token（值退回抄本 = 对拍绿而单源没了）', () => {
    const bare: string[] = [];
    for (const slot of PRE_E3) {
      const got = declOf(parseRules(THEME_SRC[slot.tier]), slot.selector, slot.prop);
      if (got === undefined || /var\(--|color-mix\(/.test(got) === false) bare.push(`${slot.tier}: ${slot.selector} { ${slot.prop}: ${got ?? '(缺)'} }`);
    }
    expect(bare.join('\n'), `这些格没吃 token：\n${bare.join('\n')}`).toBe('');
  });
});

/* ------------------------------ 判据三：VIS-52 遮罩只有一条通路 ------------------------------ */

describe('VIS-52 命令面板遮罩并回 `--scrim-*` 主路（palette.css 不供色）', () => {
  const paletteBody = stripComments(paletteRaw);

  it('palette.css 全文件零色值（纪律②"不写死颜色"的硬版）', () => {
    const hits = paletteBody.match(new RegExp(COLOR_LITERAL.source, 'g')) ?? [];
    expect(hits.join(' '), `palette.css 里出现了 ${hits.length} 枚字面色`).toBe('');
  });

  it('`.pk-mask` 不再写 background（遮罩色只能由主路的 var(--scrim-*) 供）', () => {
    const bad = parseRules(paletteRaw)
      .filter((r) => r.selector.includes('.pk-mask'))
      .flatMap((r) => r.body.split(';').map(squash))
      .filter((d) => /^(background|background-color|border-color|color)\s*:/.test(d));
    expect(bad.join('\n'), `palette.css 的 .pk-mask 又张嘴供色了：\n${bad.join('\n')}`).toBe('');
  });

  it(`主路三档都真在吃 scrim token：磨砂 ${'--scrim-picker'} / 实心 ${'--scrim-solid'} / 老内核 ${'--scrim-nofilter'}`, () => {
    const PROJECT = parseRules(projectRaw);
    expect(declOf(PROJECT, '.picker-backdrop', 'background')).toBe('var(--scrim-picker)');
    expect(declOf(PROJECT, ":root[data-glass='solid'] .picker-backdrop", 'background')).toBe('var(--scrim-solid)');
    expect(normalize('var(--scrim-picker)', LAYERS.light)).toBe('rgba(18, 24, 33, 0.32)');
    expect(normalize('var(--scrim-picker)', LAYERS['mint-dark'])).toBe('rgba(6, 12, 9, 0.38)');
  });

  it('palette.css 里的 `[data-theme]` 选择器归零（第二条通路就是这么被掐死的）', () => {
    const themed = parseRules(paletteRaw).filter((r) => /\[data-theme/.test(r.selector));
    expect(themed.map((r) => r.selector).join('\n'), `palette.css 又开始按档供色：\n${themed.map((r) => r.selector).join('\n')}`).toBe('');
  });
});
