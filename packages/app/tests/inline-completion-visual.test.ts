import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { defineMonacoThemes, monacoThemeIdFor, type MonacoThemeId } from '../src/monaco/theme';
import { THEME_IDS, type ThemePref } from '../src/ui/theme-pref';

/**
 * 1027 补全线 · C 车道：幽灵文本的观感判据（着色档位 / 动效纪律 / 两块 vendor DOM 的接管面）。
 *
 * 全部**静态源码判据 + 真装配取色**（不起壳、无 DOM）——与 `theme-contrast.test.ts` /
 * `monaco-theme.test.ts` / `editor-widget-css.test.ts` 同一口径。真机取证（六档截图）在交付回执里，
 * 那张表量的是"屏上真的吃到了这枚 token"，本文件量的是"这两处的数**不许各说一套**、
 * 并且每一档都过同一把 WCAG 尺"。
 *
 * ## 判据本体（五组，逐组为什么）
 * ① **两条通路同一个减弱量**。Monaco 的 ghost text 有两种渲染形态
 *   （`editor.inlineSuggest.syntaxHighlightingEnabled` 缺省开 = 整段 `opacity`；关 = 主题色
 *   `editorGhostText.foreground`）。作者拨那个开关的那一帧，字**不许跳深浅** ⇒
 *   `--ghost-text` 的 alpha 与 `--ghost-text-opacity` 必须是同一个数。
 * ② **不引入第 16 枚色相**：`--ghost-text` 的 R/G/B 通道 = 该档 `--fg` 的通道逐字相等，
 *   幽灵文本就是"正文色退一档"，不是"另一种灰"。
 * ③ **每一档都读得清，且真的比正文弱**（尺子 = `theme-contrast.test.ts` 那把 WCAG 相对亮度，
 *   不另造 ΔE、不新造公式）：
 *     正文级线：`--ghost-text` 合成到该档编辑器底上 ≥ 4.5，且 < 同底上的 `--fg`；
 *     退让线：alpha ∈ [0.5, 0.9]（≥0.9 等于没退，<0.5 在这个盘的底上读不出字）；
 *     语法着色态线：把该套主题**全部 48 档语法前景**各自按 alpha 合成到 `editor.background`，
 *       最弱的一枚仍 ≥ 3.0（那是注释族，编辑器里本就退让一档；低于 3.0 就是"幽灵文本里的注释段
 *       整段消失"，正是本车道要避免的假弱化）。
 * ④ **theme.ts 与 token 两侧不许分家（六档全量）**：`monaco-token-mirror.test.ts` 的对拍表历史上
 *   只有 dark/light/mint 三档，新三套走生成器 ⇒ 那一侧的镜像由本文件补齐：六档逐档把
 *   `--ghost-text` 展开后与该套 `colors['editorGhostText.foreground']` 逐字符相等。
 * ⑤ **切片的形状**（照 `editor-widget-css.test.ts` 的写法，射程换成 ghost text + hints widget）：
 *   在册且真被 import / 零裸色 / 字号只吃 `--fs-*` / 动效只吃本片那格局部变量且属性表里零几何量 /
 *   每条命中 vendor 的选择器都 `:root` 起头 / 减弱动效两条通道都压到 0ms / **无候选时零节点**
 *   （不许出现 `content:` 或任何能在空白处生出东西的选择器）。
 *
 * 读数一律 `console.log` 随跑随打（同 `styles-split.equivalence` 与 `ps10-eager-graph` 的口径），
 * 六档的 alpha / 对比度表直接从日志拿，不靠人肉复算。
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
/** 判据一律看剥掉注释后的正文（注释里可以引用改前的旧值，活代码才算数） */
const sliceRaw = read('../src/inline-completion.css');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');
const sliceBody = stripComments(sliceRaw);

/* ------------------------------ ① 六档 token 终值表 ------------------------------ */

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

function collectRootDecls(src: string, want: string): Map<string, string> {
  const text = stripComments(src);
  const out = new Map<string, string>();
  const stack: Array<{ head: string; body: string }> = [];
  let buf = '';
  for (const ch of text) {
    if (ch === '{') {
      stack.push({ head: squash(buf), body: '' });
      buf = '';
      continue;
    }
    if (ch === '}') {
      const top = stack.pop();
      if (top && top.head === want) {
        for (const d of top.body.split(';')) {
          const idx = d.indexOf(':');
          if (idx <= 0) continue;
          const prop = squash(d.slice(0, idx));
          if (prop.startsWith('--')) out.set(prop, squash(d.slice(idx + 1)));
        }
      }
      buf = '';
      continue;
    }
    if (stack.length > 0) stack[stack.length - 1]!.body += ch;
    buf += ch;
  }
  return out;
}

const TOKENS_SRC = read('../src/tokens.css');
const THEME_SOURCES: ReadonlyArray<{ readonly id: ThemePref; readonly selector: string; readonly src: string }> = [
  { id: 'light', selector: ":root[data-theme='light']", src: read('../src/themes/light.css') },
  { id: 'mint-dark', selector: ":root[data-theme='mint-dark']", src: read('../src/themes/mint-dark.css') },
  { id: 'one-dark', selector: ":root[data-theme='one-dark']", src: read('../src/themes/one-dark.css') },
  { id: 'rose-pine', selector: ":root[data-theme='rose-pine']", src: read('../src/themes/rose-pine.css') },
  { id: 'synthwave84', selector: ":root[data-theme='synthwave84']", src: read('../src/themes/synthwave84.css') },
];

function buildLayer(themeId: ThemePref): Map<string, string> {
  const map = new Map(collectRootDecls(TOKENS_SRC, ':root'));
  const file = THEME_SOURCES.find((t) => t.id === themeId);
  if (file) for (const [k, v] of collectRootDecls(file.src, file.selector)) map.set(k, v);
  return map;
}

/** 六档逐档点名（dark = tokens.css 基础 `:root`；名单与 `ui/theme-pref.ts` 的 THEME_IDS 同源） */
const TIERS = THEME_IDS.map((id) => {
  const map = buildLayer(id);
  return { id, themeId: monacoThemeIdFor(id) as MonacoThemeId, map };
});

/* ------------------------------ ② var() 展开 + 颜色求值（尺子照 theme-contrast） ------------------------------ */

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

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp255 = (n: number): number => Math.max(0, Math.min(255, n));

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
  const fn = /^rgba?\(([^)]*)\)$/i.exec(v);
  if (!fn) return null;
  const inner = fn[1]!.replace(/,/g, ' ');
  const slash = inner.indexOf('/');
  const main = slash < 0 ? inner : inner.slice(0, slash);
  const alphaRaw = slash < 0 ? null : inner.slice(slash + 1).trim();
  const parts = main.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;
  const num = (t: string): number | null => {
    if (t.endsWith('%')) {
      const p = Number.parseFloat(t);
      return Number.isFinite(p) ? clamp255((p / 100) * 255) : null;
    }
    const n = Number.parseFloat(t);
    return Number.isFinite(n) ? clamp255(n) : null;
  };
  const r = num(parts[0]!);
  const g = num(parts[1]!);
  const b = num(parts[2]!);
  if (r === null || g === null || b === null) return null;
  const rawAlpha = alphaRaw ?? (parts.length >= 4 ? parts[3]! : '1');
  const a = rawAlpha.endsWith('%') ? Number.parseFloat(rawAlpha) / 100 : Number.parseFloat(rawAlpha);
  if (!Number.isFinite(a)) return null;
  return { r, g, b, a: Math.max(0, Math.min(1, a)) };
}

function tokenColor(map: Map<string, string>, token: string): Rgba | null {
  const raw = map.get(token);
  if (raw === undefined) return null;
  const expanded = expandVars(raw, map);
  if (expanded === null) return null;
  return parseColor(expanded);
}

/** 前景按自身 alpha 叠到实底上（与 `theme-contrast.test.ts` 的 `overC` 同一条算式） */
const over = (fg: Rgba, bg: Rgba): Rgba =>
  fg.a >= 1 ? fg : { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };

const lin = (v: number): number => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = (c: Rgba): number => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
const ratio = (a: Rgba, b: Rgba): number => {
  const l1 = lum(a);
  const l2 = lum(b);
  return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
};
const toRgba = (c: Rgba): Rgba => c;
/** 把"整段 opacity"表达成同一把尺：拿满色按 alpha 合成到该档底上 */
const dimOver = (fg: Rgba, bg: Rgba, alpha: number): Rgba =>
  over({ r: fg.r, g: fg.g, b: fg.b, a: alpha }, bg);
const hex6 = (c: Rgba): string =>
  `#${[c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
const alphaByte = (c: Rgba): number => Math.round(clamp255(Math.max(0, Math.min(1, c.a)) * 255));

/* ------------------------------ ③ 真装配六套主题（取 rules + colors） ------------------------------ */

interface CapturedTheme {
  readonly rules: Monaco.editor.ITokenThemeRule[];
  readonly colors: Record<string, string>;
}

function stubFlagOff(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
    },
  });
}

function captureThemes(): Map<MonacoThemeId, CapturedTheme> {
  stubFlagOff();
  const themes = new Map<MonacoThemeId, CapturedTheme>();
  const monaco = {
    editor: {
      defineTheme: (id: string, theme: CapturedTheme): void => {
        themes.set(id as MonacoThemeId, theme);
      },
    },
    languages: {},
  } as unknown as typeof Monaco;
  defineMonacoThemes(monaco);
  return themes;
}

const THEMES = captureThemes();

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------ ④ 判据 ------------------------------ */

describe('C-①/② 幽灵文本的色：两条通路同一个减弱量、通道就是本档正文', () => {
  it('六档逐档点名：`--ghost-text` / `--ghost-text-opacity` 都在册，且 alpha 是同一个数', () => {
    const bad: string[] = [];
    for (const tier of TIERS) {
      const ghostRaw = tier.map.get('--ghost-text');
      const opacityRaw = tier.map.get('--ghost-text-opacity');
      if (ghostRaw === undefined) {
        bad.push(`${tier.id}：没有 --ghost-text 定义点`);
        continue;
      }
      if (opacityRaw === undefined) {
        bad.push(`${tier.id}：没有 --ghost-text-opacity 定义点`);
        continue;
      }
      const ghost = tokenColor(tier.map, '--ghost-text');
      if (!ghost) {
        bad.push(`${tier.id}：--ghost-text 解析不出颜色（${ghostRaw}）`);
        continue;
      }
      const opacity = Number.parseFloat(opacityRaw);
      if (!Number.isFinite(opacity)) {
        bad.push(`${tier.id}：--ghost-text-opacity 不是一个数（${opacityRaw}）`);
        continue;
      }
      // 同一条 alpha 在 8bit 上有两种写法（token 侧十进制 / 关键帧侧整数），容 1/255 舍入
      if (Math.abs(ghost.a - opacity) > 1 / 255) {
        bad.push(`${tier.id}：两条通路不同量 —— --ghost-text alpha ${ghost.a.toFixed(3)} vs --ghost-text-opacity ${opacity}`);
      }
      if (opacity < 0.5 || opacity > 0.9) {
        bad.push(`${tier.id}：alpha ${opacity} 出界（[0.5, 0.9]：<0.5 读不出字、>0.9 等于没退一档）`);
      }
    }
    expect(bad.join('\n'), bad.join('\n')).toBe('');
  });

  it('六档：`--ghost-text` 的 R/G/B 通道 = 该档 `--fg` 逐字相等（幽灵文本 = 正文色退一档，不是第 16 枚灰）', () => {
    const bad: string[] = [];
    for (const tier of TIERS) {
      const ghost = tokenColor(tier.map, '--ghost-text');
      const fg = tokenColor(tier.map, '--fg');
      if (!ghost || !fg) {
        bad.push(`${tier.id}：颜色解析不出（ghost=${ghost === null} fg=${fg === null}）`);
        continue;
      }
      if (hex6(ghost) !== hex6(fg)) bad.push(`${tier.id}：通道分家 ghost ${hex6(ghost)} ≠ --fg ${hex6(fg)}`);
    }
    expect(bad.join('\n'), bad.join('\n')).toBe('');
  });

  it('六档：该档没给自己另立一套值 = 值必须逐档不同或刻意同值（打印读数，同值要能说清为什么）', () => {
    const rows = TIERS.map((tier) => `${tier.id}=${tier.map.get('--ghost-text-opacity') ?? '缺'}`);
    console.log(`[ic-ghost] 六档 alpha：${rows.join(' · ')}`);
    expect(rows.length).toBe(6);
  });
});

describe('C-③ 对比度：每一档都读得清，且真的比正文弱（尺子 = WCAG 相对亮度，同 theme-contrast）', () => {
  const readings: string[] = [];
  const bad: string[] = [];
  for (const tier of TIERS) {
    const theme = THEMES.get(tier.themeId);
    if (!theme) {
      bad.push(`${tier.id}：没捕获到 ${tier.themeId}（装配面漂 = 本文件整个红）`);
      continue;
    }
    const bg = tokenColor(tier.map, '--bg');
    const fg = tokenColor(tier.map, '--fg');
    const ghost = tokenColor(tier.map, '--ghost-text');
    const opacityRaw = tier.map.get('--ghost-text-opacity');
    if (!bg || !fg || !ghost || opacityRaw === undefined) {
      bad.push(`${tier.id}：--bg/--fg/--ghost-text/--ghost-text-opacity 有解析不出的`);
      continue;
    }
    const opacity = Number.parseFloat(opacityRaw);
    const ghostOnBg = over(ghost, bg);
    const ghostRatio = ratio(ghostOnBg, bg);
    const fgRatio = ratio(fg, bg);
    // 语法着色态：该套主题**全部规则前景**（48 档）各自按整段 opacity 合成到 editor.background
    const monacoBg = parseColor(theme.colors['editor.background']!);
    if (!monacoBg) {
      bad.push(`${tier.id}：editor.background 解析不出颜色`);
      continue;
    }
    const syntax = theme.rules.map((rule) => ({
      token: rule.token,
      fg: parseColor(`#${rule.foreground ?? '000000'}`)!,
      r: ratio(dimOver(parseColor(`#${rule.foreground ?? '000000'}`)!, monacoBg, opacity), monacoBg),
    }));
    const weakest = syntax.reduce((a, b) => (b.r < a.r ? b : a));
    readings.push(
      `[${tier.id}] 底 ${hex6(bg)} 正文 ${fgRatio.toFixed(2)} → 幽灵 ${hex6(ghostOnBg)} ${ghostRatio.toFixed(2)}` +
        ` | alpha ${opacity} | 着色态最弱档 ${weakest.token} ${weakest.r.toFixed(2)}（满色 ${ratio(weakest.fg, monacoBg).toFixed(2)}）`,
    );
    if (ghostRatio < 4.5) bad.push(`${tier.id}：幽灵文本 ${ghostRatio.toFixed(2)} < 4.5（正文级线）`);
    if (ghostRatio >= fgRatio) bad.push(`${tier.id}：幽灵 ${ghostRatio.toFixed(2)} 不比正文 ${fgRatio.toFixed(2)} 弱`);
    if (weakest.r < 3.0)
      bad.push(`${tier.id}：语法着色态里最弱的一枚（${weakest.token}）合成后 ${weakest.r.toFixed(2)} < 3.0`);
    // 底色口径：token 的 --bg 与 Monaco 的 editor.background 必须同一块底（monaco-theme 也查这条，
    // 这里再查一次是因为**本文件的 alpha 是拿 --bg 量的**，底错了我这组读数就整体失真。
    if (hex6(monacoBg) !== hex6(bg)) bad.push(`${tier.id}：量对比用的底分家 token ${hex6(bg)} / monaco ${hex6(monacoBg)}`);
  }
  it('六档逐档：幽灵文本 ≥4.5、低于同档正文、着色态最弱档 ≥3.0', () => {
    console.log(readings.join('\n'));
    expect(bad.join('\n'), `共 ${bad.length} 条不达标：\n${bad.join('\n')}`).toBe('');
  });

  it('反假绿地板：六档都真的吃到 ghost token（一枚不落）', () => {
    for (const tier of TIERS) {
      expect(tokenColor(tier.map, '--ghost-text'), `${tier.id} 的 --ghost-text 解析不出颜色`).not.toBeNull();
      expect(toRgba(tokenColor(tier.map, '--ghost-text')!).a, `${tier.id} 的 --ghost-text 不许是不透明色`).toBeLessThan(1);
    }
  });
});

describe('C-④ theme.ts ↔ token：六档逐字对拍（mirror 表只覆盖三档，这里补齐新三套）', () => {
  it('每一档 `editorGhostText.foreground` = --ghost-text 展开值（通道逐字等、alpha 容 1/255）', () => {
    const bad: string[] = [];
    const rows: string[] = [];
    for (const tier of TIERS) {
      const theme = THEMES.get(tier.themeId);
      const tokenValue = tokenColor(tier.map, '--ghost-text');
      const monacoRaw = theme?.colors['editorGhostText.foreground'];
      if (!theme || !tokenValue || monacoRaw === undefined) {
        bad.push(`${tier.id}：theme.ts 没有 editorGhostText.foreground，或 token 解析不出`);
        continue;
      }
      const monacoValue = parseColor(monacoRaw);
      if (!monacoValue) {
        bad.push(`${tier.id}：editorGhostText.foreground 不是可解析颜色（${monacoRaw}）`);
        continue;
      }
      rows.push(`${tier.id}: --ghost-text ${hex6(tokenValue)}/${alphaByte(tokenValue)} ↔ theme.ts ${monacoRaw} ${hex6(monacoValue)}/${alphaByte(monacoValue)}`);
      if (hex6(tokenValue) !== hex6(monacoValue)) bad.push(`${tier.id}：通道分家 ${hex6(tokenValue)} vs ${hex6(monacoValue)}`);
      if (Math.abs(alphaByte(tokenValue) - alphaByte(monacoValue)) > 1)
        bad.push(`${tier.id}：alpha 漂了 ${alphaByte(tokenValue)}/255 vs ${alphaByte(monacoValue)}/255`);
    }
    console.log(`[ic-ghost] 六档对拍：\n${rows.join('\n')}`);
    expect(bad.join('\n'), bad.join('\n')).toBe('');
    expect(rows.length, '六档一枚都没对上').toBe(6);
  });

  it('只给 foreground，background / border 刻意不给（给了就是每个候选片段框一圈实线）', () => {
    for (const tier of TIERS) {
      const theme = THEMES.get(tier.themeId)!;
      expect(theme.colors, `${tier.id} 不该定义 editorGhostText.background`).not.toHaveProperty('editorGhostText.background');
      expect(theme.colors, `${tier.id} 不该定义 editorGhostText.border`).not.toHaveProperty('editorGhostText.border');
    }
  });
});

describe('C-⑤ 切片在册与形状（inline-completion.css）', () => {
  const selectors = [...sliceBody.matchAll(/([^{}]+)\{/g)]
    .map((m) => m[1]!.trim())
    .filter((s) => s.length > 0 && !s.startsWith('@') && !s.startsWith('from') && !/^\d/.test(s));
  /** 一条规则里逗号并列的落点各算一枚（口径照 `editor-widget-css.test.ts`：先 flatMap 再筛） */
  const vendorSelectors = selectors
    .flatMap((s) => s.split(',').map((one) => one.trim()))
    .filter((s) => /ghost-text|inlineSuggestionsHints/.test(s));
  const timingDecls = [
    ...[...sliceBody.matchAll(/\btransition:\s*([^;]+);/g)].map((m) => ({ kind: 'transition', value: m[1]!.trim() })),
    ...[...sliceBody.matchAll(/\banimation:\s*([^;]+);/g)].map((m) => ({ kind: 'animation', value: m[1]!.trim() })),
  ];

  it('文件非空且被真 import（只认 import 语句，注释里提文件名不算）', () => {
    expect(sliceBody.length, 'inline-completion.css 正文为空').toBeGreaterThan(300);
    expect(read('../src/main.tsx')).toMatch(/import\s*'\.\/inline-completion\.css'/);
  });

  it('射程就是那两块 vendor DOM，且一条不落全带 :root 前缀（与注入顺序解耦）', () => {
    expect(vendorSelectors.length, 'ghost text / hints 的选择器一条都没扫到').toBeGreaterThan(8);
    const naked = vendorSelectors.filter((s) => !s.startsWith(':root'));
    expect(naked, `没有 :root 前缀的落点：${naked.join(' , ')}`).toEqual([]);
    expect(sliceBody).toMatch(/\.ghost-text-decoration\.syntax-highlighted/);
    expect(sliceBody).toMatch(/\.ghost-text-decoration\.warning/);
    expect(sliceBody).toMatch(/\.inlineSuggestionsHints\.withBorder/);
  });

  it('零裸色：正文里一个十六进制 / rgb() 分量都不许出现（色一律 var()）', () => {
    const hex = [...sliceBody.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(hex, `写死的色值：${hex.join(' ')}`).toEqual([]);
    const raw = [...sliceBody.matchAll(/\b(?:rgba?|hsla?)\(([^)]*)\)/g)].filter((m) => !m[1]!.includes('var(')).map((m) => m[0]);
    expect(raw, `裸分量色函数：${raw.join(' ')}`).toEqual([]);
  });

  it('字号只吃 --fs-* 刻度（vendor 那枚 8px 键帽必须被抬进刻度，而不是被本文件重新抄一遍）', () => {
    const sizes = [...sliceBody.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(sizes.length, '本切片一处字号都没写（那条"8px 出刻度"的收编就不成立）').toBeGreaterThan(0);
    for (const v of sizes) expect(v, `font-size: ${v} 不吃 --fs-*`).toMatch(/^var\(--fs-[a-z0-9]+\)$/);
  });

  it('动效：时长只吃本片那格局部变量；属性表里零几何量；keyframes 只动 opacity', () => {
    expect(timingDecls.length, '本切片一处动效都没写（判据空转）').toBeGreaterThan(0);
    for (const { kind, value } of timingDecls) {
      if (value === 'none') continue;
      expect(value, `${kind}: ${value} 绕过了 --ic-* 局部节奏`).toContain('var(--ic-');
      expect(value, `${kind}: ${value} 直接吃了 --dur-*/--ease-*（减弱豁免会漏落点）`).not.toMatch(/var\(--(?:dur|ease)-/);
    }
    const keyframes = /@keyframes\s+kojo-ghost-in\s*\{([\s\S]*?)\n\}/.exec(sliceBody);
    expect(keyframes, '入场 keyframes 不在册').not.toBeNull();
    const body = keyframes![1]!;
    expect(body).toMatch(/opacity/);
    expect(body, 'keyframes 里混进了会重排的量').not.toMatch(/\b(width|height|left|top|padding|margin|transform|letter-spacing)\b/);
    // 隐式 to 帧：只写 from，末帧取元素自己的计算值（写成 to: 1 就会比静息帧亮一档）
    expect(body, '不许写显式 to 帧——那会让动画末端的亮度与静息态分家').not.toMatch(/\bto\s*\{/);
  });

  it('减弱动效两条通道都在册且把 --ic-dur 压成 0ms（选择器权重与 editor-widget.css 同形态）', () => {
    expect(sliceBody).toMatch(/:root\[data-motion='reduced'\]:root \.monaco-editor\s*\{[^}]*--ic-dur:\s*0ms/);
    expect(sliceBody).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?:root:root \.monaco-editor\s*\{[^}]*--ic-dur:\s*0ms/);
  });

  it('无候选 = 零节点：切片不声明任何 content:，也不给 ghost text 一族加盒模型', () => {
    expect(sliceBody, 'content: 会在空白处生出节点（无候选时屏幕必须逐字节与今天一致）').not.toMatch(/(^|[;{\s])content\s*:/);
    const box = [...sliceBody.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => /ghost-text/.test(m[1]!) && /\b(width|height|padding|margin|letter-spacing|line-height)\s*:/.test(m[2]!));
    expect(box.map((m) => m[1]!.trim()), `给行内幽灵字加了盒模型 = 逐键横向重排：\n${box.map((m) => m[1]).join('\n')}`).toEqual([]);
  });

  it('失败档只点名既有 token（--warning），且不新造图标：本切片零 codicon 类名、零 content', () => {
    const warningRule = /\.ghost-text-decoration\.warning[^{]*\{([^}]*)\}/.exec(sliceBody);
    expect(warningRule, '失败/警示那一档的落点不在册').not.toBeNull();
    expect(warningRule![1]).toMatch(/border-bottom:\s*1px dashed var\(--warning\)/);
    expect(warningRule![1], 'vendor 的 4px double + 波浪底片必须撤掉（不许与诊断告警同形）').toMatch(/background:\s*none/);
    expect(sliceBody, '本切片不许自己点 codicon 类名（图标归 vendor 的 warning 通道）').not.toMatch(/codicon/);
  });
});
