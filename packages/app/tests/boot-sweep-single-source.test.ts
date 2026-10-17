import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 首屏「引导层扫光条」单源闸（BOARD `BOOT-SW` 判据①）。
 *
 * 加载界面下方那根来回扫的细条原先有**两份手写拷贝**：`index.html` 的内联引导层（必须在 React
 * 挂载前生效且零外链 ⇒ 数值只能写字面量）与 `styles.css` 的打包层（React 侧 `ProjectViewSkeleton`
 * 用，走 token）。两份几何本就同构，唯一的真实漂移是缓动（内联 `ease-in-out` vs 打包
 * `var(--ease-out)`）⇒ 撤罩换手的瞬间会变速。
 *
 * 本闸不把它们物理合成一份源码（合成不了：内联层等不到 `styles.css`），而是**收成同一个类名
 * `.boot-bar` + 同一条 `@keyframes boot-sweep` + 同一份配方**，再用源码级逐字镜像钉住
 * 「除字面量 vs token 的取色外，不许有任何第二处差异」。形态照 `code-font.test.ts` 先例：
 * `readFileSync` 读源码比对，不依赖 DOM、不起壳（本池 `environment: 'node'`）。
 *
 * 红线（判据②，见 `index.html` 第 24-30 行注释）：内联层的底色**不许**改成 `var(--…)`、
 * 也不许构建期注入。桌面壳断言①（`tools/boot-probe.mjs` 的 `pinOk`）有效，正因为
 * 「内联字面底色」与「`themes/*.css` 的 `--bg`」是两个独立手写源在对撞；单源化会退化成
 * 自我循环，再也抓不到「改主题忘改引导层」。所以这里的取色差异是**合法的**，被排除在
 * 逐字比对之外，另由「取色镜像」一闸（三档 × 五面，口径照 `themes/light.css` 顶部
 * 「⚠ 锚定不变量」的五格清单）以**跨文件对撞**的方式钉住，漂一枚色即红、一律严格逐字相等；
 * 字号同理会跳（接力瞬间 `--fs-display` / `--fs-1` 两格），故另给两格字号镜像，真源只有基线一档。
 *
 * 补一面（2026-10-17）：**排版本身**同样是两处独立手写而先前没钉——卡容器 `index.html` 的
 * `.boot-splash-card` vs `styles.css` 的 `.boot-skeleton-card`（类名不同，「同名配方」那条抓不到）、
 * 两行文字各两格 `font-weight` / `letter-spacing` ⇒ 另挂「排版镜像」一条；只比这几格，
 * `font-size` / `color` 仍归上面两条镜像管，免得同一格两套口径。
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const htmlSrc = (): string => read('../index.html');
const cssSrc = (): string => read('../src/styles.css');
const appTsx = (): string => read('../src/ui/App.tsx');
const lightTheme = (): string => read('../src/themes/light.css');
const mintTheme = (): string => read('../src/themes/mint-dark.css');

/** index.html 的内联 `<style>` 块正文（引导层唯一样式真源） */
function inlineStyle(html: string): string {
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  const body = m?.[1];
  if (body === undefined) throw new Error('index.html 里找不到内联 <style> 块（引导层塌了？）');
  return body;
}

type Rule = { readonly prelude: string; readonly body: string; readonly parent: string | null };
type Decl = { readonly prop: string; readonly value: string };

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** 折平空白：两侧缩进层级不同（内联层在 `<style>` 里多两格），一切逐字比对前都先归一 */
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * 极简 CSS 分块器：`@media` / `@keyframes` 里的下层规则带上 `parent` 标记，
 * 于是「顶层的 `.boot-bar`」与「`@media` 里的 `.boot-bar::after`」可分别取到。
 */
function parseRules(css: string, parent: string | null = null): Rule[] {
  const src = stripComments(css);
  const rules: Rule[] = [];
  let preludeStart = 0;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      // 只跳过串本身：**不动 preludeStart**，否则 `html[data-theme='light'] body` 这类
      // 选择器会被从引号处截断，剩个 `] body` 出来（前缀在选择器里的引号同样属于 prelude）
      i = skipString(src, i);
      continue;
    }
    if (ch === '{') {
      const prelude = norm(src.slice(preludeStart, i));
      let depth = 1;
      let j = i + 1;
      while (j < src.length && depth > 0) {
        const c = src[j];
        if (c === '"' || c === "'") j = skipString(src, j);
        else {
          if (c === '{') depth++;
          else if (c === '}') depth--;
          j++;
        }
      }
      const body = src.slice(i + 1, j - 1);
      rules.push({ prelude, body, parent });
      if (prelude.startsWith('@')) rules.push(...parseRules(body, prelude));
      i = j;
      preludeStart = j;
      continue;
    }
    if (ch === ';') {
      i++;
      preludeStart = i;
      continue;
    }
    i++;
  }
  return rules;
}

/** 跳过一段带引号的串（返回闭引号之后一位）；串里可能藏 `{` `}`，不归零会让分块器错位 */
function skipString(src: string, start: number): number {
  const quote = src[start];
  let j = start + 1;
  while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1;
  return j + 1;
}

function declsOf(body: string, where: string): Decl[] {
  if (body.includes('{')) throw new Error(`${where} 的规则体里还有下层块，不是纯声明块`);
  return body
    .split(';')
    .map((s) => norm(s))
    .filter((s) => s.length > 0)
    .map((text) => {
      const k = text.indexOf(':');
      if (k < 0) throw new Error(`${where} 的声明无法解析：${JSON.stringify(text)}`);
      return { prop: norm(text.slice(0, k)), value: norm(text.slice(k + 1)) };
    });
}

/** 取 token 表：某条顶层规则（如 `:root` / `:root[data-theme='light']`）里的全部自定义属性 */
function tokenMap(css: string, prelude: string, label: string): Map<string, string> {
  const out = new Map<string, string>();
  const hits = parseRules(css).filter((r) => r.parent === null && r.prelude === prelude);
  if (hits.length === 0) throw new Error(`${label} 里找不到顶层 ${prelude} 规则`);
  for (const rule of hits) for (const d of declsOf(rule.body, `${label} ${prelude}`)) {
    if (d.prop.startsWith('--')) out.set(d.prop, d.value);
  }
  return out;
}

/** 把 `var(--x)` 还原成 `:root` 的现值，好让「打包层用 token」与「内联层用字面量」能逐字对账 */
function resolveVars(value: string, tokens: Map<string, string>, label: string): string {
  let out = value;
  for (let round = 0; round < 8; round++) {
    if (!out.includes('var(')) return norm(out);
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*?)\s*)?\)/, (_m, name: string, fallback?: string) => {
      const hit = tokens.get(name);
      if (hit !== undefined) return hit;
      if (fallback !== undefined) return fallback;
      throw new Error(`${label}：token ${name} 无从解析，无法与内联字面量对账（声明值 ${value}）`);
    });
  }
  throw new Error(`${label}：var() 嵌套过深（${value}）`);
}

/**
 * `animation` 简写里「缓动」这一位收成占位符 `<EASE>`：字面 `cubic-bezier(…)`、`steps(…)`、
 * 关键字（`ease-in-out` 等）、以及 `var(--ease-*)` 一律同一记号。
 * 于是配方比对只钉**名字 + 时长 + 迭代**，缓动那一格交给独立那条闸去对账（判据①的另一半）。
 */
function stripEasing(value: string): string {
  let s = value;
  s = s.replace(/var\(\s*--ease[\w-]*\s*(?:,\s*[^()]*?\s*)?\)/g, '<EASE>');
  s = s.replace(/cubic-bezier\([^)]*\)/g, '<EASE>');
  s = s.replace(/steps\([^)]*\)/g, '<EASE>');
  s = s.replace(/\b(?:ease-in-out|ease-out|ease-in|ease|linear)\b/g, '<EASE>');
  s = s.replace(/(?:<EASE>\s*){2,}/g, '<EASE> ');
  return norm(s);
}

/** 取色的那几格：字面量 vs token 是唯一合法差异，排除在配方逐字比对之外 */
const COLOR_PROPS = new Set(['background', 'background-color', 'color']);

/** 一份「配方」= 某选择器顶层规则的非取色声明序列（token 已还原、缓动已收成占位符） */
function recipeOf(css: string, selector: string, tokens: Map<string, string>, label: string): string[] {
  const hits = parseRules(css).filter((r) => r.parent === null && r.prelude === selector);
  if (hits.length !== 1) {
    throw new Error(`${label}：顶层选择器 ${selector} 应有且只有一条，实得 ${hits.length} 条`);
  }
  const rule = hits[0];
  if (!rule) throw new Error(`${label}：取不到 ${selector}`);
  return declsOf(rule.body, `${label} ${selector}`)
    .filter((d) => !COLOR_PROPS.has(d.prop))
    .map((d) => `${d.prop}: ${d.prop === 'animation' ? stripEasing(d.value) : resolveVars(d.value, tokens, label)};`);
}

/** 取 `@media (prefers-reduced-motion: reduce)` 里某选择器的配方（内联层与打包层各一份） */
function mediaRecipeOf(css: string, selector: string, label: string): string[] {
  const hits = parseRules(css).filter(
    (r) => r.parent === '@media (prefers-reduced-motion: reduce)' && r.prelude === selector,
  );
  if (hits.length !== 1) throw new Error(`${label}：减动效分支里 ${selector} 应有且只有一条，实得 ${hits.length} 条`);
  const rule = hits[0];
  if (!rule) throw new Error(`${label}：取不到 ${selector}`);
  return declsOf(rule.body, `${label} @media ${selector}`).map((d) => `${d.prop}: ${d.value};`);
}

const keyframesRules = (css: string, name: string): Rule[] =>
  parseRules(css).filter((r) => r.parent === null && r.prelude === `@keyframes ${name}`);

/** 关键帧块体「按行去缩进」的逐字序列（两边缩进层级不同，必须先归一缩进） */
const bodyLines = (rule: Rule): string[] =>
  rule.body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const NO_TOKENS = new Map<string, string>();

/** 引导层三个档位的名字（`index.html` 早应用脚本 + `themes/*.css` 的口径：读不到/非法 ⇒ dark） */
type ThemeName = 'dark' | 'light' | 'mint-dark';
const THEMES: readonly ThemeName[] = ['dark', 'light', 'mint-dark'];

/** 每档取色 token 的真源：dark 在 `styles.css` 基础 `:root`，另两档在各自 `themes/*.css` */
function themeTokens(theme: ThemeName): Map<string, string> {
  if (theme === 'dark') return tokenMap(cssSrc(), ':root', 'styles.css');
  if (theme === 'light') return tokenMap(lightTheme(), ":root[data-theme='light']", 'light.css');
  return tokenMap(mintTheme(), ":root[data-theme='mint-dark']", 'mint-dark.css');
}

const THEME_SOURCE: Readonly<Record<ThemeName, string>> = {
  dark: 'styles.css 基础 :root',
  light: 'themes/light.css',
  'mint-dark': 'themes/mint-dark.css',
};

/**
 * 一面 = 引导层的一组裸选择器 + 一个属性 + 该档主题源里必须与之内联字面量逐字相等的 token。
 * 内联层写的是字面量、主题源写的是 token（红线②）⇒ 这是两个独立手写源的对撞，不是自我循环。
 */
type Face = {
  readonly label: string;
  readonly selectors: ReadonlySet<string>;
  readonly prop: string;
  readonly token: string;
};

/**
 * 取色面五格，口径照 `themes/light.css` 顶部「⚠ 锚定不变量」列的那张清单
 * （`--bg · --fg · --fg-dim · --bg-3 · --accent`）：底色两处 / 文字 / 提示文字 / 进度轨 / 进度滑块。
 */
const COLOR_FACES: readonly Face[] = [
  { label: '底色', selectors: new Set(['html', 'body', '#boot-splash']), prop: 'background', token: '--bg' },
  { label: '文字', selectors: new Set(['#boot-splash']), prop: 'color', token: '--fg' },
  { label: '提示文字', selectors: new Set(['.boot-splash-tip']), prop: 'color', token: '--fg-dim' },
  { label: '进度轨道', selectors: new Set(['.boot-bar']), prop: 'background', token: '--bg-3' },
  { label: '进度滑块', selectors: new Set(['.boot-bar::after']), prop: 'background', token: '--accent' },
];

/**
 * 字号面（防同一类 bug：splash→app 接力瞬间字号跳）。`--fs-*` 不在 `themes/*.css` 里逐档重定义
 * ⇒ 真源只有 `styles.css` 基线 `:root` 一档，所以按 `dark`（= 引导层无档位前缀的基线规则）比一次，
 * 不硬造按档断言；前提本身另由下面那条闸钉住。
 */
const FONT_FACES: readonly Face[] = [
  { label: '品牌标题字号', selectors: new Set(['.boot-splash-brand']), prop: 'font-size', token: '--fs-display' },
  { label: '提示文字字号', selectors: new Set(['.boot-splash-tip']), prop: 'font-size', token: '--fs-1' },
];

/**
 * 选择器归一：摘掉 `[data-theme='x']`，再丢掉前导的 `html `。于是
 * `html[data-theme='light'] .boot-bar` 与基线 `html, body` 拆出来的 `body` 都收成裸选择器，
 * 同一面在三个档位共用一张表。
 */
function canonSelector(sel: string): string {
  const s = norm(sel.replace(/\[data-theme='[\w-]+'\]/g, ' '));
  return s.startsWith('html ') ? norm(s.slice('html '.length)) : s;
}

/**
 * 内联引导层「某一档某一面」的字面量。dark 档只读无档位前缀的基线规则，另两档只读带自己
 * `data-theme` 的规则——否则浅色档会把深色基线一起抓进来，跨档漏改再也查不出。
 */
function faceLiterals(theme: ThemeName, selectors: ReadonlySet<string>, prop: string): string[] {
  const found: string[] = [];
  for (const rule of parseRules(inlineStyle(htmlSrc()))) {
    if (rule.parent !== null) continue;
    const ruleTheme = /\[data-theme='([\w-]+)'\]/.exec(rule.prelude)?.[1] ?? 'dark';
    if (ruleTheme !== theme) continue;
    if (!rule.prelude.split(',').some((sel) => selectors.has(canonSelector(sel)))) continue;
    for (const d of declsOf(rule.body, `index.html ${rule.prelude}`)) {
      if (d.prop === prop) found.push(d.value);
    }
  }
  return found;
}

/** 一面一档的自证三查：抓不到 ⇒ 红（闸自己塌了）、同档内部自相矛盾 ⇒ 红、与主题源不等 ⇒ 红 */
function expectMirrored(theme: ThemeName, face: Face, tokens: Map<string, string>): void {
  const source = THEME_SOURCE[theme];
  const where = `${theme} 档「${face.label}」面（index.html 的 ${[...face.selectors].join(' / ')} { ${face.prop} }）`;
  const literals = faceLiterals(theme, face.selectors, face.prop);
  expect(literals.length, `${where} 一处字面量都没抓到：闸自己塌了（选择器或属性名变了？）`).toBeGreaterThan(0);
  const distinct = [...new Set(literals)];
  expect(distinct.length, `${where} 在 index.html 内部就自相矛盾：${distinct.join(' / ')}`).toBe(1);
  const token = tokens.get(face.token);
  if (token === undefined) throw new Error(`${where} 无法对账：${source} 里没有声明 ${face.token}`);
  expect(
    distinct[0],
    `${where} 与主题源不等 —— index.html 现值 ${distinct[0]} vs ${source} 的 ${face.token} = ${token}`,
  ).toBe(token);
}

describe('引导层扫光 · 单源配方（BOOT-SW 判据①）', () => {
  it('两份各含恰好一条 @keyframes boot-sweep，且块体按行去缩进后逐字相等', () => {
    const inline = keyframesRules(inlineStyle(htmlSrc()), 'boot-sweep');
    const packed = keyframesRules(cssSrc(), 'boot-sweep');
    expect(inline, 'index.html 内联层的 @keyframes boot-sweep 条数').toHaveLength(1);
    expect(packed, 'styles.css 的 @keyframes boot-sweep 条数').toHaveLength(1);

    const a = inline[0];
    const b = packed[0];
    if (!a || !b) throw new Error('关键帧取不到（上两条断言本该已挡下）');
    const inlineLines = bodyLines(a);
    const packedLines = bodyLines(b);
    expect(inlineLines, '@keyframes boot-sweep 块体漂移：index.html（内联层） vs styles.css（打包层）').toEqual(
      packedLines,
    );
    // 配方本身也得钉住（否则两份都改成别的行程也"相等"）
    expect(inlineLines).toEqual([
      '0% {',
      'transform: translateX(-110%);',
      '}',
      '100% {',
      'transform: translateX(320%);',
      '}',
    ]);
  });

  it('旧名清零：boot-splash-sweep / boot-skeleton-sweep / .boot-splash-bar / .boot-skeleton-bar 不再残留', () => {
    const stale = ['boot-splash-sweep', 'boot-skeleton-sweep', '.boot-splash-bar', '.boot-skeleton-bar'];
    for (const name of stale) {
      expect(htmlSrc(), `index.html 仍残留旧名 ${name}`).not.toContain(name);
      expect(cssSrc(), `styles.css 仍残留旧名 ${name}`).not.toContain(name);
    }
  });

  it('React 侧骨架用的就是同一个类名（App.tsx 的 boot-bar，改 CSS 忘改 TSX 会静默失联）', () => {
    expect(appTsx()).toContain('className="boot-bar"');
  });

  it('两份 .boot-bar / .boot-bar::after 的非取色声明逐字相等（取色是唯一合法差异）', () => {
    const packedTokens = tokenMap(cssSrc(), ':root', 'styles.css');
    const targets = ['.boot-bar', '.boot-bar::after'] as const;
    for (const selector of targets) {
      const inline = recipeOf(inlineStyle(htmlSrc()), selector, NO_TOKENS, 'index.html');
      const packed = recipeOf(cssSrc(), selector, packedTokens, 'styles.css');
      expect(inline, `${selector} 配方漂移：index.html（内联字面量） vs styles.css（token 已还原）`).toEqual(packed);
    }
    // 钉住配方实值，防"两边一起漂"
    expect(recipeOf(cssSrc(), '.boot-bar', packedTokens, 'styles.css')).toEqual([
      'width: 168px;',
      'height: 3px;',
      'border-radius: 999px;',
      'overflow: hidden;',
    ]);
    expect(recipeOf(cssSrc(), '.boot-bar::after', packedTokens, 'styles.css')).toEqual([
      "content: '';",
      'display: block;',
      'width: 42%;',
      'height: 100%;',
      'border-radius: inherit;',
      'animation: boot-sweep 1.15s <EASE> infinite;',
    ]);
  });

  it('排版镜像：卡容器全配方逐字相等 + 两行文字的 font-weight / letter-spacing 同档（钉住 16px / 600 / 0.02em）', () => {
    const packedTokens = tokenMap(cssSrc(), ':root', 'styles.css');

    /**
     * 顶层选择器的**全部**声明（token 已还原）。不借道 `recipeOf`：它会滤掉取色那几格，
     * 而这两条规则本就不取色 ⇒ 一格都不许漏（哪天有人往卡上补 `background` 也得当场红）。
     */
    const declsFor = (css: string, selector: string, tokens: Map<string, string>, label: string): Decl[] => {
      const hits = parseRules(css).filter((r) => r.parent === null && r.prelude === selector);
      if (hits.length !== 1) throw new Error(`${label}：顶层选择器 ${selector} 应有且只有一条，实得 ${hits.length} 条`);
      const rule = hits[0];
      if (!rule) throw new Error(`${label}：取不到 ${selector}`);
      return declsOf(rule.body, `${label} ${selector}`).map((d) => ({
        prop: d.prop,
        value: resolveVars(d.value, tokens, `${label} ${selector} { ${d.prop} }`),
      }));
    };
    const seqOf = (decls: Decl[]): string[] => decls.map((d) => `${d.prop}: ${d.value};`);
    const cellOf = (decls: Decl[], prop: string): string | undefined => decls.find((d) => d.prop === prop)?.value;

    // ① 卡容器：两类名不同（splash / skeleton），上面「同名配方 .boot-bar」那条覆盖不到 ⇒ 全配方单独钉
    const cardInline = declsFor(inlineStyle(htmlSrc()), '.boot-splash-card', NO_TOKENS, 'index.html');
    const cardPacked = declsFor(cssSrc(), '.boot-skeleton-card', packedTokens, 'styles.css');
    expect(
      seqOf(cardInline),
      '卡容器配方漂移：index.html 的 .boot-splash-card（内联字面量） vs styles.css 的 .boot-skeleton-card（token 已还原）',
    ).toEqual(seqOf(cardPacked));

    // ② 两行文字的排版两格。font-size / color 归「取色镜像」「字号镜像」两条管，这里不重复钉，免得两套口径
    const TYPE_CELLS = ['font-weight', 'letter-spacing'] as const;
    const rows = [
      { label: '品牌标题', inlineSel: '.boot-splash-brand', packedSel: '.boot-skeleton-brand' },
      { label: '提示文字', inlineSel: '.boot-splash-tip', packedSel: '.boot-skeleton-tip' },
    ] as const;
    for (const row of rows) {
      const inlineDecls = declsFor(inlineStyle(htmlSrc()), row.inlineSel, NO_TOKENS, 'index.html');
      const packedDecls = declsFor(cssSrc(), row.packedSel, packedTokens, 'styles.css');
      for (const prop of TYPE_CELLS) {
        const inlineCell = cellOf(inlineDecls, prop);
        const packedCell = cellOf(packedDecls, prop);
        const where = `${row.label}这一行的 ${prop}：index.html 的 ${row.inlineSel} vs styles.css 的 ${row.packedSel}`;
        // 提示行两侧都不写这两格（`.boot-splash-tip` / `.boot-skeleton-tip` 只有 font-size + color）：
        // 那是合法现状 ⇒ 不比值、也不替它造实值。单侧缺则必须红，且点名缺在哪一侧（下面 brand 的
        // 实值那一钉还兜住「brand 两侧一起删掉这两格」，所以整段没有静默放行的缝）。
        if (inlineCell === undefined && packedCell === undefined) continue;
        expect(
          inlineCell !== undefined,
          `${where} —— 缺在内联层：这一格 styles.css 有（现值 ${packedCell}）、index.html 没有，` +
            '两份排版不再同构（要加就两侧一起加）',
        ).toBe(true);
        expect(
          packedCell !== undefined,
          `${where} —— 缺在打包层：这一格 index.html 有（现值 ${inlineCell}）、styles.css 没有，` +
            '两份排版不再同构（要加就两侧一起加）',
        ).toBe(true);
        if (inlineCell === undefined || packedCell === undefined) continue;
        expect(
          inlineCell,
          `${where} 漂移：内联字面量 ${inlineCell} vs 打包层（token 已还原）${packedCell}`,
        ).toBe(packedCell);
      }
    }

    // ③ 钉住实值，防「两边一起漂」。只钉打包层即可：①②已把两侧逐字绑死，内联层被传递性钉住
    expect(seqOf(cardPacked), '卡容器配方实值（styles.css 的 .boot-skeleton-card）应就是这四格').toEqual([
      'display: flex;',
      'flex-direction: column;',
      'align-items: center;',
      'gap: 16px;',
    ]);
    const brandPacked = declsFor(cssSrc(), '.boot-skeleton-brand', packedTokens, 'styles.css');
    for (const [prop, want] of [
      ['font-weight', '600'],
      ['letter-spacing', '0.02em'],
    ] as const) {
      expect(
        cellOf(brandPacked, prop),
        `防一起漂：styles.css 的 .boot-skeleton-brand { ${prop} } 真值须为 ${want}（内联层 .boot-splash-brand 靠上面的逐字镜像一起钉死）`,
      ).toBe(want);
    }
  });

  it('两份减动效（@media prefers-reduced-motion）回落分支的声明也逐字相等', () => {
    const inline = mediaRecipeOf(inlineStyle(htmlSrc()), '.boot-bar::after', 'index.html');
    const packed = mediaRecipeOf(cssSrc(), '.boot-bar::after', 'styles.css');
    expect(inline, '.boot-bar::after 减动效回落漂移：index.html vs styles.css').toEqual(packed);
    expect(inline).toEqual(['animation: none;', 'width: 100%;', 'opacity: 0.35;']);
  });

  it('内联缓动字面量 == styles.css :root 的 --ease-out 现值，且内联层零 var()（红线：不许单源化取色）', () => {
    const packedTokens = tokenMap(cssSrc(), ':root', 'styles.css');
    const easeOut = packedTokens.get('--ease-out');
    expect(easeOut, 'styles.css :root 的 --ease-out 声明值').toBeDefined();

    const animOf = (decls: Decl[]): string => {
      const hit = decls.find((d) => d.prop === 'animation');
      if (!hit) throw new Error('.boot-bar::after 里没有 animation 简写');
      return hit.value;
    };
    const ruleDecls = (css: string, selector: string): Decl[] => {
      const hits = parseRules(css).filter((r) => r.parent === null && r.prelude === selector);
      if (hits.length !== 1) throw new Error(`${selector} 应有且只有一条顶层规则，实得 ${hits.length} 条`);
      const rule = hits[0];
      if (!rule) throw new Error(`取不到 ${selector}`);
      return declsOf(rule.body, selector);
    };

    const inlineAnim = animOf(ruleDecls(inlineStyle(htmlSrc()), '.boot-bar::after'));
    const packedAnim = animOf(ruleDecls(cssSrc(), '.boot-bar::after'));

    const inlineEase = inlineAnim.match(/cubic-bezier\([^)]*\)/)?.[0];
    expect(inlineEase, `内联 animation 简写里要的是字面 cubic-bezier(…)，实得 ${inlineAnim}`).toBeDefined();
    expect(inlineEase, '缓动漂移：index.html 内联字面量 vs styles.css 的 --ease-out').toBe(easeOut);
    expect(inlineAnim, '内联层与打包层的时长/迭代必须同档').toContain('1.15s');
    expect(packedAnim, '打包层那条应继续走 var(--ease-out)').toContain('var(--ease-out)');
    // 红线判据②：内联层等不到 styles.css，取色只能是独立手写的字面量——不许被"顺手"改成 token
    const inlineAll = ruleDecls(inlineStyle(htmlSrc()), '.boot-bar')
      .concat(ruleDecls(inlineStyle(htmlSrc()), '.boot-bar::after'))
      .map((d) => d.value)
      .join(' | ');
    expect(inlineAll, '内联引导层出现了 var()：单源化会掏空桌面壳断言①').not.toContain('var(');
  });

  it('取色镜像：三档 × 五面引导层字面量 == 该档主题源对应 token（严格逐字相等，不许例外）', () => {
    for (const theme of THEMES) {
      const tokens = themeTokens(theme);
      for (const face of COLOR_FACES) expectMirrored(theme, face, tokens);
    }
  });

  it('字号镜像：引导层两处 font-size 字面量 == styles.css 基线 :root 的 --fs-display / --fs-1', () => {
    const tokens = themeTokens('dark');
    for (const face of FONT_FACES) expectMirrored('dark', face, tokens);

    // 「真源只有基线一档」这条前提本身也得钉住：themes/*.css 若哪天逐档重定义 --fs-*，
    // 上面只比基线就会漏掉按档跳字，那时才需要改成按档断言。
    const perTheme: readonly [ThemeName, string, string][] = [
      ['light', lightTheme(), ":root[data-theme='light']"],
      ['mint-dark', mintTheme(), ":root[data-theme='mint-dark']"],
    ];
    for (const [theme, css, prelude] of perTheme) {
      const themeTokenMap = tokenMap(css, prelude, THEME_SOURCE[theme]);
      for (const face of FONT_FACES) {
        expect(
          themeTokenMap.has(face.token),
          `${THEME_SOURCE[theme]} 重定义了 ${face.token}：字号镜像「真源只有基线一档」的前提失效，请把上面改成按档断言`,
        ).toBe(false);
      }
    }
  });

  it('.skeleton 与 u-shimmer 仍在（大面积占位是另一种视觉语言，属效果库资产，不许被顺手删）', () => {
    const css = cssSrc();
    const shimmer = keyframesRules(css, 'u-shimmer');
    expect(shimmer, 'styles.css 的 @keyframes u-shimmer 条数').toHaveLength(1);
    const one = shimmer[0];
    if (!one) throw new Error('取不到 u-shimmer');
    expect(bodyLines(one)).toEqual(['to {', 'transform: translateX(100%);', '}']);

    // 满幅渐变柔光那条与 boot-bar 是两套视觉语言：只钉"还在、还指向 u-shimmer"，不并入逐字配方
    const skeleton = parseRules(css).find((r) => r.parent === null && r.prelude === '.skeleton');
    const after = parseRules(css).find((r) => r.parent === null && r.prelude === '.skeleton::after');
    expect(skeleton, 'styles.css 的 .skeleton 规则不见了').toBeDefined();
    expect(after, 'styles.css 的 .skeleton::after 规则不见了').toBeDefined();
    if (!after) throw new Error('取不到 .skeleton::after');
    const shimmerAnim = declsOf(after.body, '.skeleton::after').find((d) => d.prop === 'animation');
    expect(shimmerAnim?.value, '.skeleton::after 的扫光不再指向 u-shimmer').toContain('u-shimmer');
  });

  it('应用内「减弱动效」开关那条也有静态回落（否则 animation-name 不改 ⇒ 滑块停终态、只剩空沟）', () => {
    const hits = parseRules(cssSrc()).filter(
      (r) => r.parent === null && r.prelude === ":root[data-motion='reduced'] .boot-bar::after",
    );
    expect(hits, 'styles.css 需有 :root[data-motion=\'reduced\'] .boot-bar::after 这条静态回落').toHaveLength(1);
    const rule = hits[0];
    if (!rule) throw new Error('取不到 data-motion 回落规则');
    const decls = declsOf(rule.body, ":root[data-motion='reduced'] .boot-bar::after").map((d) => `${d.prop}: ${d.value};`);
    expect(decls, '应用内关动效的回落须与 @media 分支同一条 35% 淡条').toEqual([
      'animation: none;',
      'width: 100%;',
      'opacity: 0.35;',
    ]);
    // 全局压平那条只改 duration / iteration-count，没改 name ⇒ 本条必须自己把 name 关掉
    expect(decls.some((d) => d.startsWith('animation:'))).toBe(true);
  });
});
