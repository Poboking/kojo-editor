// @vitest-environment happy-dom
/**
 * Synthwave '84 · 编辑器霓虹光（`monaco/neon-glow.ts`）。
 *
 * 钉五件事，每件都对应一个"错了会静默变形"的点：
 * ① 序号是**按颜色**捞出来的，不是写死的 —— 换一档主题序号就变，写死等于把光打到别的 token 上；
 * ② 配方表就是官方那张五色表（红/粉/黄/绿/青），灯管芯色与光影逐字；
 * ③ 粉档两枚 alpha 写死（`33` / `fff3`），**不吃**亮度参数 —— 官方原样，别"统一"；
 * ④ 亮度换算逐字等于官方（`Math.floor(b * 255).toString(16)`，0.45 ⇒ `72`）；
 * ⑤ 作用域三重收口 + 找不到表时不注入半成品 + 幂等。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  NEON_DREAMS_RECIPES,
  NEON_GLOW_BRIGHTNESS,
  NEON_GLOW_ENABLED,
  NEON_GLOW_RECIPES,
  buildGlowCss,
  glowAlphaHex,
  installKeywordGlow,
  scanGlowHits,
  scheduleKeywordGlow,
  shadowOf,
} from '../src/monaco/neon-glow';

/** Monaco 实际生成的形状（见 monaco-editor `generateTokensCSSForColorMap`） */
const TOKEN_CSS = [
  '.mtk1 { color: #eae6f5; }',
  '.mtk2 { color: #848bbd; }',
  '.mtk3 { color: #fede5d; }',
  '.mtk4 { color: #36f9f6; }',
  '.mtk5 { color: #ff7edb; }',
  '.mtk6 { color: #72f1b8; }',
  '.mtk7 { color: #f97e72; }',
  '.mtki { font-style: italic; }',
].join('\n');

function mountStyle(css: string): void {
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
}

/** 只取"扫到了序号"的那些配方（方便断言） */
function hitsOf(css: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const h of scanGlowHits(document, NEON_GLOW_RECIPES)) {
    if (h.ids.length > 0) out[h.recipe.hex] = h.ids;
  }
  return out;
}

/** WCAG 相对亮度（用来钉"灯管芯不许把对比度拖到 AA 之下"） */
function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Synthwave '84 的编辑器底（`theme.ts` 色板 `background`，也是 AA 判据的取样底） */
const EDITOR_BG = '#262335';

function contrastOnBg(hex: string): number {
  const a = luminance(hex);
  const b = luminance(EDITOR_BG);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('配方表 = 官方五色表', () => {
  it('五档源色与顺序逐字（红 → 粉 → 黄 → 绿 → 青）', () => {
    expect(NEON_DREAMS_RECIPES.map((r) => r.hex)).toEqual(['fe4450', 'ff7edb', 'fede5d', '72f1b8', '36f9f6']);
  });

  it('灯管芯色逐字：粉档压深、青档近白、黄档暖白', () => {
    const core = Object.fromEntries(NEON_DREAMS_RECIPES.map((r) => [r.hex, r.core]));
    expect(core.fe4450).toBe('#fff5f6');
    expect(core.ff7edb).toBe('#f92aad');
    expect(core.fede5d).toBe('#f4eee4');
    expect(core['72f1b8']).toBe('#72f1b8');
    expect(core['36f9f6']).toBe('#fdfdfd');
  });

  it('粉档两枚 alpha 写死不随亮度变（`dc078e33` / `fff3`）', () => {
    const pink = NEON_DREAMS_RECIPES.find((r) => r.hex === 'ff7edb')!;
    expect(shadowOf(pink, 0.45)).toBe('0 0 2px #100c0f, 0 0 5px #dc078e33, 0 0 10px #fff3');
    expect(shadowOf(pink, 1)).toBe('0 0 2px #100c0f, 0 0 5px #dc078e33, 0 0 10px #fff3');
  });

  it('其余四档的 `%A` 全部被换成 alpha（不留占位符）', () => {
    for (const r of NEON_DREAMS_RECIPES) {
      expect(shadowOf(r, 0.45)).not.toContain('%A');
    }
    const yellow = NEON_DREAMS_RECIPES.find((r) => r.hex === 'fede5d')!;
    expect(shadowOf(yellow, 0.45)).toBe('0 0 2px #393a33, 0 0 8px #f39f0572, 0 0 2px #f39f0572');
  });
});

describe('生效表 = 官方表里启用的两档 + 芯色例外', () => {
  it('只启用关键字两族：粉 `ff7edb` 与黄 `fede5d`（顺序跟官方表）', () => {
    expect(NEON_GLOW_ENABLED).toEqual(['fede5d', 'ff7edb']);
    expect(NEON_GLOW_RECIPES.map((r) => r.hex)).toEqual(['ff7edb', 'fede5d']);
  });

  it('青/绿/红三档不上光（青是 `label` 定位锚点、绿是台词，换色等于抹语义）', () => {
    expect(NEON_GLOW_RECIPES.some((r) => r.hex === '36f9f6')).toBe(false);
    expect(NEON_GLOW_RECIPES.some((r) => r.hex === '72f1b8')).toBe(false);
    expect(NEON_GLOW_RECIPES.some((r) => r.hex === 'fe4450')).toBe(false);
  });

  it('只有粉档被改写芯色，其余逐字同一份；辉光一个字都没动', () => {
    for (const r of NEON_GLOW_RECIPES) {
      const official = NEON_DREAMS_RECIPES.find((o) => o.hex === r.hex)!;
      expect(r.shadow).toBe(official.shadow);
      if (r.hex !== 'ff7edb') expect(r.core).toBe(official.core);
    }
  });

  it('粉档芯色留在 `#ff7edb`（官方 `#f92aad` 在 `#262335` 上只有 4.34:1）', () => {
    expect(NEON_DREAMS_RECIPES.find((r) => r.hex === 'ff7edb')!.core).toBe('#f92aad');
    expect(NEON_GLOW_RECIPES.find((r) => r.hex === 'ff7edb')!.core).toBe('#ff7edb');
    expect(contrastOnBg('#f92aad')).toBeLessThan(4.5);
  });

  it('每一档灯管芯色在本盘底色上都过 AA（4.5:1）—— 这就是上面那条例外的判据', () => {
    for (const r of NEON_GLOW_RECIPES) {
      expect(contrastOnBg(r.core), `${r.hex} 的灯管芯 ${r.core} 未过 AA`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('按颜色捞 mtk 序号', () => {
  it('只认关键字两族；青 `mtk4`、绿 `mtk6`、数字 `mtk7`、正文 `mtk1` 一概不认', () => {
    mountStyle(TOKEN_CSS);
    expect(hitsOf(document)).toEqual({ ff7edb: ['5'], fede5d: ['3'] });
  });

  it('同一颜色出现两次（两条规则同色）⇒ 两个序号都要，且不重复、大小写都认', () => {
    mountStyle('.mtk3 { color: #fede5d; }\n.mtk9 { color: #FEDE5D; }\n.mtk3 { color: #fede5d; }');
    expect(hitsOf(document).fede5d).toEqual(['3', '9']);
  });

  it('带注释/多属性的规则段也能认（Monaco 换版本后格式可能变宽）', () => {
    mountStyle('.mtk5 { /* keyword */ color: #fede5d; font-style: normal; }');
    expect(hitsOf(document).fede5d).toEqual(['5']);
  });

  it('没有 Monaco 的表 ⇒ 一条都扫不到（不是"猜一个默认序号"）', () => {
    mountStyle('.welcome-neon { color: #fede5d; }');
    expect(hitsOf(document)).toEqual({});
  });
});

describe('亮度换算 = 官方算法', () => {
  it('缺省 0.45 ⇒ 2 位十六进制 `72`', () => {
    expect(NEON_GLOW_BRIGHTNESS).toBe(0.45);
    expect(glowAlphaHex()).toBe('72');
  });

  it('越界与脏值都夹回 0–1（0 ⇒ `00`，1 ⇒ `ff`）', () => {
    expect(glowAlphaHex(0)).toBe('00');
    expect(glowAlphaHex(1)).toBe('ff');
    expect(glowAlphaHex(-3)).toBe('00');
    expect(glowAlphaHex(9)).toBe('ff');
    expect(glowAlphaHex(Number.NaN)).toBe('72');
  });
});

describe('生成的规则', () => {
  it('三重作用域齐全：主题档 / .monaco-editor / .view-line span', () => {
    mountStyle(TOKEN_CSS);
    const css = buildGlowCss(scanGlowHits(document));
    expect(css).toContain(":root[data-theme='synthwave84']");
    expect(css).toContain('.monaco-editor .view-line span.mtk3');
    expect(css).toContain('.monaco-editor .view-line span.mtk5');
    expect(css).not.toContain('span.mtk1');
    expect(css).not.toContain('span.mtk4');
    expect(css).not.toContain('span.mtk7');
  });

  it('每档都带 backface-visibility（压掉亚像素重影）', () => {
    mountStyle(TOKEN_CSS);
    const css = buildGlowCss(scanGlowHits(document));
    const rules = css.split('}').filter((s) => s.includes('span.mtk'));
    expect(rules.length).toBe(2);
    for (const r of rules) expect(r).toContain('backface-visibility: hidden;');
  });

  it('黄档：灯管芯近白暖色 + 三道光影逐字', () => {
    mountStyle(TOKEN_CSS);
    const css = buildGlowCss(scanGlowHits(document));
    expect(css).toContain('color: #f4eee4;');
    expect(css).toContain('text-shadow: 0 0 2px #393a33, 0 0 8px #f39f0572, 0 0 2px #f39f0572;');
  });

  it('一条都没扫到 ⇒ 空串（调用方据此不注入）', () => {
    expect(buildGlowCss([{ recipe: NEON_DREAMS_RECIPES[2], ids: [] }])).toBe('');
  });
});

describe('注入', () => {
  it('只注入一枚 `<style>`，重复调用只覆盖同一枚（幂等）', () => {
    mountStyle(TOKEN_CSS);
    expect(installKeywordGlow(document)).toBe(true);
    expect(installKeywordGlow(document)).toBe(true);
    expect(document.querySelectorAll('#kojo-synthwave-keyword-glow')).toHaveLength(1);
    expect(document.getElementById('kojo-synthwave-keyword-glow')!.textContent).toContain('span.mtk3');
  });

  it('找不到颜色表 ⇒ 返回 false 且不留半成品；此前注入过的会被撤掉', () => {
    mountStyle(TOKEN_CSS);
    installKeywordGlow(document);
    document.head.innerHTML = '';
    expect(installKeywordGlow(document)).toBe(false);
    expect(document.getElementById('kojo-synthwave-keyword-glow')).toBeNull();
  });

  it('没有 document ⇒ 安全返回 false（node/SSR 路径不炸）', () => {
    expect(installKeywordGlow(undefined)).toBe(false);
  });
});

describe('兜底调度绝不许抛', () => {
  it('`window` 在、`window.setTimeout` 不在时也不抛', () => {
    // 实机回归：`monaco-token-mirror` 那类 DOM 替身里 `window` 有、定时器没挂，
    // 直接 `window.setTimeout(...)` 抛 `is not a function`，一次把 6 个套件拖红。
    const w = window as unknown as Record<string, unknown>;
    const saved = w.setTimeout;
    Object.defineProperty(w, 'setTimeout', { value: undefined, configurable: true, writable: true });
    try {
      expect(() => scheduleKeywordGlow(2, 1)).not.toThrow();
    } finally {
      Object.defineProperty(w, 'setTimeout', { value: saved, configurable: true, writable: true });
    }
  });
});
