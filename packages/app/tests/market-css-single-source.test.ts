import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 市场域 CSS 的单源与「零字符图标」闸（批次十一 L07）。
 *
 * 钉三件本批改出来、之后最容易悄悄回潮的事：
 *  A. **单源**：市场域（`.mk-*` / `.panel-market`）规则只住 `market.css`，
 *     `styles-project.css` 一条都不留。搬迁前那三段（基础层 / 效果推广 A 组 / MK-UI 精修批）
 *     住在 `styles-project.css`，同名选择器靠"market.css 晚加载 ⇒ 同特异性后来者胜"叠加——
 *     这条懒链一旦回潮，"改 market.css 却不生效"就会回来。（终值等价性由
 *     `node tools/market-css-equivalence.mjs` 对基线树逐条对拍，本闸只钉"不再分家"这个结构事实。）
 *  B. **零字符图标**：本域 `content:` 的值只许是空串（画出来的形状），不许是 `▸ › ⋯ ✓ ＋ －`
 *     这类**字符当图标**——图形一律走 `ui/icons.tsx` 注册表（面板侧经 `renderIcon` 桥取）。
 *  C. **焦点环只认 `:focus-visible`**：本域里凡是给焦点环（`--shadow-focus` / `outline`）的声明，
 *     所在选择器必须含 `:focus-visible`；静息态不许常驻 accent 描边冒充选中态。
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const marketSrc = (): string => read('../src/market.css');
const heavySrc = (): string => read('../src/styles-project.css');

/** 剥注释后按大括号深度取**叶子声明块**（与 styles-split.equivalence.test.ts 同一够用口径） */
function leafBlocks(css: string): Array<{ media: string; selector: string; body: string }> {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Array<{ media: string; selector: string; body: string }> = [];
  const stack: Array<{ head: string; text: string }> = [];
  let buf = '';
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote !== null) {
      buf += ch;
      const t = stack[stack.length - 1];
      if (t !== undefined) t.text += ch;
      if (ch === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      const t = stack[stack.length - 1];
      if (t !== undefined) t.text += ch;
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
        out.push({
          media: stack.filter((s) => s.head.startsWith('@')).map((s) => s.head).join(' '),
          selector: top.head,
          body: top.text,
        });
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

const isMarketSelector = (sel: string): boolean => /\.mk-|\.panel-market/.test(sel);

describe('市场域 CSS 单源（批次十一 L07）', () => {
  it('A `styles-project.css` 零条市场域规则；`market.css` 里市场域规则成规模在位', () => {
    const stray = leafBlocks(heavySrc()).filter((b) => isMarketSelector(b.selector));
    expect(
      stray.map((b) => `${b.media} ⊃ ${b.selector}`),
      '市场域规则不许再住回 styles-project.css（同名选择器 + 跨文件后来者胜 = 本批搬走的那颗雷）',
    ).toEqual([]);
    const own = leafBlocks(marketSrc()).filter((b) => isMarketSelector(b.selector));
    expect(own.length, 'market.css 必须真的装着市场域整域').toBeGreaterThan(40);
    console.log(`[market-css] 市场域声明块：market.css ${own.length} 条 / styles-project.css ${stray.length} 条`);
  });

  it('B 本域零字符图标：`content:` 只许是空串（图形一律走图标注册表）', () => {
    const offenders: string[] = [];
    for (const b of leafBlocks(marketSrc())) {
      if (!isMarketSelector(b.selector)) continue;
      for (const m of b.body.matchAll(/(?<![-\w])content\s*:\s*([^;}]+)/g)) {
        const value = m[1]!.trim();
        if (value === "''" || value === '""') continue;
        offenders.push(`${b.selector} → content: ${value}`);
      }
    }
    expect(offenders, '非空 `content:` = 拿字符当图标（本仓纪律：改 SVG 或画形状）').toEqual([]);
  });

  it('C 焦点环只在 `:focus-visible` 上给；静息态不常驻选中感', () => {
    const offenders: string[] = [];
    for (const b of leafBlocks(marketSrc())) {
      if (!isMarketSelector(b.selector)) continue;
      if (b.selector.includes(':focus-visible') || b.selector.includes(':focus-within')) continue;
      // `outline: none` 在静息态是"撤销浏览器环"，允许；给环的那两类不许出现在静息选择器上
      if (/box-shadow\s*:[^;]*--shadow-focus/.test(b.body) || /^\s*outline\s*:\s*(?!none)/m.test(b.body)) {
        offenders.push(b.selector);
      }
    }
    expect(offenders, '焦点环只认 :focus-visible（批次十一 L07「发布口上…」常驻环的口径）').toEqual([]);
    // 「发布口上…」这一枚：静息态不许再拿 accent 描边/环冒充选中态（键盘环由本域
    // `.mk-toolbar button:focus-visible` 那一条统一给）
    const publish = leafBlocks(marketSrc()).filter((b) => /\.mk-publish(\b|:hover)/.test(b.selector));
    expect(publish.length, '.mk-publish 这一枚必须在册').toBeGreaterThan(0);
    for (const b of publish) {
      expect(b.body, `静息 .mk-publish 不许给环：${b.selector}`).not.toMatch(/box-shadow\s*:/);
      expect(b.body, `静息 .mk-publish 不许用 accent 描边：${b.selector}`).not.toMatch(/border-color\s*:\s*var\(--accent/);
    }
    const focusRing = leafBlocks(marketSrc()).find((b) => b.selector.includes('.mk-toolbar button:focus-visible'));
    expect(focusRing, '缺 .mk-toolbar button:focus-visible 这一档（发布口的键盘环来源）').toBeTruthy();
  });
});
