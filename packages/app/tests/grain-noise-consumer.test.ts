/**
 * 噪点了断批（1027）：颗粒噪点**要么有真消费方，要么整支删掉**——本闸钉住"接上"这条路。
 *
 * 立论（改前实测，别信注释）：`.u-grain` 这枚工具类以逐字相同的两份副本躺在 `styles.css` 与
 * `styles-project.css` 里（双写契约税），而 `u-grain` 在全仓 .ts/.tsx/.html **零命中**——同族的
 * `.u-sheen` / `.u-ripple` 都有真消费方（`ui/WelcomeView.tsx:394` 一处挂两枚），只有它是"文件在、
 * 类名对、测试绿、tsc 绿"四项都不红的死样式。事故口径与 `editor-glyph-slot.test.ts` 抓的那条同一
 * （那边死的是 `.kojo-bookmark-glyph`，那支的教训就叫"开档 ⇒ 样式表真有消费方"）。
 *
 * 为什么"接"而不是"删"：渐变压不出颗粒。欢迎页素雅档（`ui/welcome.css`）画的是 24px 点阵 + accent
 * 光晕，那是"纸面"；菜单这类**半透明浮面**要的是"磨砂玻璃上一层浮尘"——两者不打架，且浮面正是
 * `linear-gradient` 顶缘高光最容易读出带状断层与塑料感的地方。但接必须克制，本闸就是克制本身：
 *  ① 配方全仓**只许一份**：`--grain-noise` 单源在 `context-menu.css`，两档样式文件零副本；
 *  ② 强度封顶：烤进 SVG 的 `opacity` > 0 且 ≤ 0.035（当年标定档，只许降不许涨）；
 *  ③ 真被画出来：两枚玻璃面的背景栈**最上层**就是它，且声明序是 `background` 简写在前、
 *     `background-image` / `background-blend-mode` 在后（写反 = 噪点被简写复位，静默无效果）；
 *  ④ 不许多一层合成：噪点是背景层（`background-blend-mode`，只在元素自己的背景栈里混），
 *     不是伪元素 + `mix-blend-mode`（后者新开图层并读回背后那一叠像素，低端机白付）；
 *  ⑤ 装饰开关是真开关：`data-glass='solid'`（设置页旋钮 0%）与 `@supports not (backdrop-filter)`
 *     两条回落都用整条 `background` 简写换实色 ⇒ 噪点层连同混合模式一起被复位；
 *  ⑥ DOM 侧真有人渲染 `.context-menu`（防止再养出一枚没人画的类名）。
 *
 * 静态读源码（node 环境，与 `editor-glyph-slot.test.ts` 同一口径）；注释一律先剥——本批的"去处
 * 说明"注释里会提 `.u-grain` 这个名字，提名字不算消费方。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const SRC = fileURLToPath(new URL('../src', import.meta.url));

const menuCss = (): string => read('../src/context-menu.css');
const lightCss = (): string => read('../src/styles.css');
const heavyCss = (): string => read('../src/styles-project.css');
const menuTsx = (): string => read('../src/ui/context-menu.tsx');

/** CSS：只剥块注释（`url("…http://…")` 里的 `//` 不是注释，别顺手剥掉） */
const stripCssComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');
/** TS/TSX：块注释 + 行注释都剥（口径同 `css-token-single-source.test.ts`） */
const stripTsComments = (s: string): string => stripCssComments(s).replace(/\/\/[^\n]*/g, '');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

interface Block {
  selector: string;
  body: string;
  /** 所属 at-rule 头（顶层为空串） */
  at: string;
}

/** 大括号深度扁平化（同 `styles-split.equivalence.test.ts` 的够用口径：字符串跳过、注释剥离） */
function blocks(css: string): Block[] {
  const src = stripCssComments(css);
  const out: Block[] = [];
  const stack: Array<{ head: string; text: string }> = [];
  let buf = '';
  let quote: string | null = null;
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
      stack.push({ head: buf.trim().replace(/\s+/g, ' '), text: '' });
      buf = '';
      continue;
    }
    if (ch === '}') {
      const top = stack.pop();
      if (top === undefined) continue;
      const parent = stack[stack.length - 1];
      if (parent === undefined || parent.head.startsWith('@')) out.push({ selector: top.head, body: top.text, at: parent?.head ?? '' });
      else parent.text += `${top.head}{${top.text}}`;
      buf = '';
      continue;
    }
    const top = stack[stack.length - 1];
    if (top !== undefined) top.text += ch;
    else buf += ch;
  }
  return out;
}

const splitSelectors = (sel: string): string[] => sel.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);

/** 两枚菜单玻璃面（本文件的立命口径：两套 DOM 一份观感），特异性分别 (0,2,0) 与 (0,3,0)。
 *  同选择器的 `--grain-noise` 定义块也命中选择器表，故要求块内真有背景声明——摘掉消费方的
 *  `background-image` 时这里会少一块，③ 的"两枚都在册"直接红（变异实测走的就是这一条）。 */
const GLASS_SELECTORS = ['.context-menu.context-menu', ':root .context-view.monaco-menu-container'];
const glassBlocks = (css: string): Block[] =>
  blocks(css).filter(
    (b) => !b.at.startsWith('@') && splitSelectors(b.selector).some((s) => GLASS_SELECTORS.includes(s)) && /(?:^|;)\s*background\s*[:-]/.test(b.body.replace(/\s*\n\s*/g, ' ')),
  );

/** 取某条声明的值（块内 `background:` 与 `background-image:` 是两条，长名先匹配靠 `;`/行首锚定） */
const declValue = (body: string, prop: string): string => {
  const flat = body.replace(/\s*\n\s*/g, ' ');
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]*)`).exec(flat);
  return m ? m[1]!.trim() : '';
};

/** 消费方的引用形态：必须逐字吃 `--grain-noise` 且带 `none` 回落（打错名字 = 整条背景列表在
 *  计算值阶段失效，玻璃底会跟着一起没——回落就是防这一手的，别把它当装饰删掉）。 */
const GRAIN_USE = /^var\(\s*--grain-noise\s*,\s*none\s*\)/;
const usesGrain = (body: string): boolean => /var\(\s*--grain-noise\s*,\s*none\s*\)/.test(body.replace(/\s*\n\s*/g, ' '));

describe('噪点①：死码已清账（`.u-grain` 的类壳不再以任何形态存在）', () => {
  it('三档 CSS 的**活声明**里零命中（去处说明的注释不算消费方）', () => {
    const alive = (
      [
        ['styles.css', lightCss()],
        ['styles-project.css', heavyCss()],
        ['context-menu.css', menuCss()],
      ] as const
    ).filter(([, src]) => /u-grain/.test(stripCssComments(src)));
    expect(alive.map(([name]) => name), '活声明里还挂着 u-grain 的文件（应为空表）').toEqual([]);
  });

  it('全仓 .ts/.tsx/.html 零命中：工具类要靠人往 DOM 上挂类才生效，挂的人一个都没有', () => {
    const srcFiles = walk(SRC).filter((p) => /\.(ts|tsx|html)$/.test(p));
    const hits = srcFiles
      .filter((p) => /u-grain/.test(stripTsComments(readFileSync(p, 'utf8'))))
      .map((p) => path.relative(SRC, p).replace(/\\/g, '/'));
    expect(read('../index.html')).not.toMatch(/u-grain/);
    expect(hits, `这些文件还挂着 u-grain：${hits.join(', ')}`).toEqual([]);
    console.log(`[grain] 死码扫描：src 的 .ts/.tsx 共 ${srcFiles.length} 份，u-grain 命中 0`);
  });
});

describe('噪点②：配方单源，双写税归零', () => {
  it('`feTurbulence` 噪点图全仓恰好一份，且在 context-menu.css（两档样式文件零副本）', () => {
    const count = (src: string): number => stripCssComments(src).match(/feTurbulence/g)?.length ?? 0;
    const menu = count(menuCss());
    const light = count(lightCss());
    const heavy = count(heavyCss());
    console.log(`[grain] feTurbulence 副本数：context-menu.css ${menu} / styles.css ${light} / styles-project.css ${heavy}（改前 0/1/1）`);
    expect(menu, '噪点配方必须真在 context-menu.css 里有一份').toBe(1);
    expect(light + heavy, '两档样式文件不许再各存一份副本（改前各 1 份 = 本批要了断的账）').toBe(0);
  });

  it('单源走 `--grain-noise`：data URI 只许出现在定义点，消费方一律 var()', () => {
    const uriCopies = (stripCssComments(menuCss()).match(/data:image\/svg\+xml/g) ?? []).length;
    expect(uriCopies, '噪点 URL 在本文件被抄了第二遍 = 双写税回潮').toBe(1);
    const uses = glassBlocks(menuCss()).filter((b) => usesGrain(b.body)).map((b) => b.selector);
    expect([...uses].sort()).toEqual([...GLASS_SELECTORS].sort());
  });

  it('强度封顶：烤进 SVG 的 opacity > 0 且 ≤ 0.035（标定档只许降不许涨）', () => {
    const def = /--grain-noise\s*:\s*url\("([^"]+)"\)/.exec(stripCssComments(menuCss()));
    expect(def, '--grain-noise 的定义形态变了（应为 url("data:image/svg+xml,…")）').not.toBeNull();
    const raw = /opacity='([\d.]+)'/.exec(def![1]!)?.[1];
    expect(raw, 'SVG 的 rect 没烤透明度 ⇒ 满不透明度噪点，直接糊屏').not.toBeUndefined();
    const opacity = Number(raw);
    console.log(`[grain] SVG rect opacity=${opacity}（上限 0.035）`);
    expect(opacity).toBeGreaterThan(0);
    expect(opacity, '强度超过 0.035 就不是"看得见质感、看不见噪点本身"了').toBeLessThanOrEqual(0.035);
  });
});

describe('噪点③：真被画出来（开档 ⇒ 样式表真有消费方）', () => {
  it('两枚玻璃面都把噪点当背景栈**最上层**画', () => {
    const bs = glassBlocks(menuCss());
    expect(bs.map((b) => b.selector).sort(), '两枚玻璃面规则被改形了（找不到声明块）').toEqual([...GLASS_SELECTORS].sort());
    for (const b of bs) {
      const image = declValue(b.body, 'background-image');
      expect(image, `${b.selector} 没有 background-image（消费方摘掉 = 本批白接）`).not.toBe('');
      expect(GRAIN_USE.test(image), `${b.selector} 的噪点不是背景栈最上层：${image.slice(0, 64)}`).toBe(true);
      expect(usesGrain(b.body), `${b.selector} 没引用单源噪点变量`).toBe(true);
      expect(declValue(b.body, 'background-blend-mode'), `${b.selector} 少了 overlay 混合`).toMatch(/^overlay/);
    }
  });

  it('声明序：`background` 简写 < `background-image` < `background-blend-mode`（写反就是静默无效果）', () => {
    const bs = glassBlocks(menuCss());
    expect(bs.length, '两枚玻璃面规则被改形了（找不到声明块）').toBe(GLASS_SELECTORS.length);
    for (const b of bs) {
      const flat = b.body.replace(/\s*\n\s*/g, ' ');
      const at = (prop: string): number => flat.search(new RegExp(`(?:^|;)\\s*${prop}\\s*:`));
      const iShort = at('background');
      const iImage = at('background-image');
      const iBlend = at('background-blend-mode');
      const where = `${b.selector} ⇒ 简写 ${iShort} / image ${iImage} / blend ${iBlend}`;
      expect(iShort, `${where}（少了 background 简写 = 底色那层没了）`).toBeGreaterThanOrEqual(0);
      expect(iImage, `${where}（少了 background-image = 消费方被摘掉）`).toBeGreaterThanOrEqual(0);
      expect(iBlend, `${where}（少了 background-blend-mode = 噪点不再与玻璃底混，只剩抹灰）`).toBeGreaterThanOrEqual(0);
      expect(iShort < iImage && iImage < iBlend, `${where}：简写在后会把噪点层与混合模式一起复位成 none`).toBe(true);
    }
  });

  it('DOM 侧真渲染 `.context-menu`（防"类名对但没人画"——glyph-slot 的同款事故）', () => {
    expect(menuTsx()).toMatch(/className=\{`context-menu context-menu--shared/);
  });

  it('零新增合成层：本文件没有 `mix-blend-mode`，也没有带 url 的伪元素噪点', () => {
    const body = stripCssComments(menuCss());
    expect(body, 'mix-blend-mode 回来 = 每个浮层多一枚合成层').not.toMatch(/mix-blend-mode/);
    const pseudoNoise = blocks(menuCss()).filter((b) => /::(after|before)/.test(b.selector) && /url\(|--grain-noise/.test(b.body));
    expect(pseudoNoise.map((b) => b.selector), '噪点又回到伪元素上了（每层浮面多一枚合成层）').toEqual([]);
  });
});

describe('噪点④：装饰开关是真开关', () => {
  it('本文件两条回落（老内核 / 实心档）都换整条 `background` 简写 ⇒ 噪点与混合模式一起复位', () => {
    const supports = blocks(menuCss()).filter((b) => b.at.startsWith('@supports'));
    expect(supports.length, '@supports not (backdrop-filter) 的出口没了（低端机）').toBeGreaterThan(0);
    for (const b of supports) {
      expect(declValue(b.body, 'background'), `${b.at} ⇒ ${b.selector} 没换成实色`).toContain('var(--bg-2)');
      expect(b.body, `${b.selector} 在低端机出口里还引用噪点（多付一层）`).not.toMatch(/--grain-noise/);
    }
    const solid = blocks(menuCss()).filter((b) => b.selector.includes("data-glass='solid'"));
    expect(solid.length, '本文件的实心档回落规则没了（旋钮 0% = 关装饰）').toBeGreaterThan(0);
    for (const b of solid) {
      expect(b.body.replace(/\s+/g, ' ')).toMatch(/background:\s*var\(--bg-2\)/);
      expect(b.body).not.toMatch(/--grain-noise/);
    }
  });

  it('特异性兜得住级联位次：两档样式文件的实心档名单里 `.context-menu` 在册（(0,3,0) 压过任何后到的单类玻璃面）', () => {
    for (const [name, css] of [
      ['styles.css', lightCss()],
      ['styles-project.css', heavyCss()],
    ] as const) {
      const solid = blocks(css).filter(
        (b) => splitSelectors(b.selector).some((s) => s.startsWith(":root[data-glass='solid'") && s.includes('.context-menu')),
      );
      expect(solid.length, `${name} 的实心档回落名单里不该把 .context-menu 摘掉`).toBeGreaterThanOrEqual(1);
      expect(solid[0]!.body.replace(/\s+/g, ' '), `${name} 的实心档没换实色`).toMatch(/background:\s*var\(--bg-2\)/);
    }
  });

  it('噪点不掺动动效：减弱动效的两条规则只管 `animation`，不拿噪点当开销出口（静态背景层本就没有帧成本）', () => {
    const reduced = blocks(menuCss()).filter(
      (b) => b.selector.includes("data-motion='reduced'") || splitSelectors(b.selector).some((s) => s.includes('data-motion=')) || b.at.includes('prefers-reduced-motion'),
    );
    expect(reduced.length, '减弱动效的两条回落（属性档 + 系统档）没了').toBeGreaterThanOrEqual(2);
    for (const b of reduced) expect(b.body, '动效回落里动到了背景层').not.toMatch(/--grain-noise|background/);
  });
});
