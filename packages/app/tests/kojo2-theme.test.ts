/**
 * Kojo 2.0 主题判据闸（K2-CUTOVER-PRE）。
 *
 * 钉四件事：
 * 1. **token 同源**：`KOJO2_THEME_TOKEN_MAP` 的键集合与 `kojo2-language.ts` 的 `KOJO2_TOKEN`
 *    逐字相等（顺序也相等），暗色侧与 `KOJO2_THEME_RULES` 逐格同源——将来词法加档 / 改名，
 *    这里先红，不会静默掉色；
 * 2. **两套 key 完整**：暗 / 亮 / 墨绿三套的 `colors` 键集合与 `KOJO2_COLOR_KEYS` 相等，
 *    每个值都是合法十六进制色；
 * 3. **配色质量**：每档对各自底色对比度 ≥ 4.5，任意两档 CIE76 ΔE ≥ 12（假分层 = 红）；
 * 4. **注册幂等**：同一 Monaco 实例只定义一次，第二个实例各注册一份，主题名不串。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { KOJO2_THEME_RULES, KOJO2_TOKEN } from '../src/monaco/kojo2-language';
import {
  KOJO2_LIGHT_THEME_RULES,
  KOJO2_MINT_THEME_RULES,
  KOJO2_THEME_RULES as LEAF_THEME_RULES,
  KOJO2_TOKEN as LEAF_TOKEN,
  KOJO_SEMANTIC_THEME_RULES,
  KOJO_SUGAR_THEME_RULES,
} from '../src/monaco/kojo-theme-rules';
import { defineMonacoThemes } from '../src/monaco/theme';
import {
  KOJO2_COLOR_KEYS,
  KOJO2_DARK_THEME_ID,
  KOJO2_LIGHT_THEME_ID,
  KOJO2_MINT_DARK_THEME_ID,
  KOJO2_THEMES,
  KOJO2_THEME_CATEGORIES,
  KOJO2_THEME_IDS,
  KOJO2_THEME_TOKEN_MAP,
  kojo2DarkTheme,
  kojo2LightTheme,
  kojo2MintDarkTheme,
  kojo2ThemeIdFor,
  registerKojo2Themes,
  type Kojo2TokenThemeSide,
} from '../src/monaco/kojo2-theme';

/* ============================== 假 Monaco（记调用账） ============================== */

interface FakeMonaco {
  readonly monaco: typeof Monaco;
  readonly defined: Map<string, Monaco.editor.IStandaloneThemeData>;
  /** 累计 `defineTheme` 调用次数（幂等判据靠它，不靠 Map 大小） */
  calls(): number;
}

function fakeMonaco(): FakeMonaco {
  const defined = new Map<string, Monaco.editor.IStandaloneThemeData>();
  let calls = 0;
  const fake = {
    editor: {
      defineTheme: (id: string, theme: Monaco.editor.IStandaloneThemeData): void => {
        calls += 1;
        defined.set(id, theme);
      },
    },
    languages: {},
  };
  return {
    monaco: fake as unknown as typeof Monaco,
    defined,
    calls: () => calls,
  };
}

/* ============================== 色彩度量（判据复跑） ============================== */

function channelLuminance(value: number): number {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG 对比度（前景 / 背景；两色不分前后） */
function contrast(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

/** sRGB → CIE Lab（D65） */
function toLab(hex: string): readonly [number, number, number] {
  const linear = [0, 2, 4].map((offset) => {
    const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  });
  const [r, g, b] = linear as [number, number, number];
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 色差 */
function deltaE(a: string, b: string): number {
  const p = toLab(a);
  const q = toLab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/* ============================== token 同源 ============================== */

const TOKEN_NAMES = Object.values(KOJO2_TOKEN);

describe('token 映射：与 kojo2-language 的 token 名逐字一致', () => {
  it('键集合 = KOJO2_TOKEN 的值集合（顺序也一致，防手抄漂移）', () => {
    expect(Object.keys(KOJO2_THEME_TOKEN_MAP)).toEqual([...TOKEN_NAMES]);
    expect(new Set(Object.keys(KOJO2_THEME_TOKEN_MAP)).size).toBe(TOKEN_NAMES.length);
    // 全部 `kojo2.` 前缀（与 v1 的 `sugar.*` / `keyword.*` 不撞名）
    for (const token of TOKEN_NAMES) expect(token.startsWith('kojo2.')).toBe(true);
  });

  it('暗色侧与 KOJO2_THEME_RULES 逐格同源（前景 + 字体样式，一格不差）', () => {
    const ruleByToken = new Map(KOJO2_THEME_RULES.map((rule) => [rule.token, rule]));
    expect(ruleByToken.size).toBe(TOKEN_NAMES.length);
    for (const token of TOKEN_NAMES) {
      const rule = ruleByToken.get(token);
      expect(rule, `KOJO2_THEME_RULES 缺 ${token}`).toBeTruthy();
      const style = KOJO2_THEME_TOKEN_MAP[token].dark;
      expect(style.foreground).toBe(rule!.foreground);
      expect(style.fontStyle).toBe(rule!.fontStyle);
    }
  });

  it('亮色侧齐全且是合法十六进制；暗/亮都只含允许的字体样式', () => {
    for (const token of TOKEN_NAMES) {
      for (const side of ['dark', 'light'] as const) {
        const style = KOJO2_THEME_TOKEN_MAP[token][side];
        expect(style.foreground, `${token}/${side}`).toMatch(/^[0-9a-f]{6}$/i);
        expect([undefined, 'bold', 'italic']).toContain(style.fontStyle);
      }
    }
    // 锚点加粗、提示与注释斜体（与 kojo2-language 的规则一致）
    expect(KOJO2_THEME_TOKEN_MAP[KOJO2_TOKEN.anchor].dark.fontStyle).toBe('bold');
    expect(KOJO2_THEME_TOKEN_MAP[KOJO2_TOKEN.anchor].light.fontStyle).toBe('bold');
    expect(KOJO2_THEME_TOKEN_MAP[KOJO2_TOKEN.hint].light.fontStyle).toBe('italic');
    expect(KOJO2_THEME_TOKEN_MAP[KOJO2_TOKEN.comment].light.fontStyle).toBe('italic');
  });

  it('作者面三类（锚点 / 声明名 / 对话）都落在映射里，且不重复登记', () => {
    expect(KOJO2_THEME_CATEGORIES.map((category) => category.category)).toEqual([
      '锚点',
      '声明名',
      '对话',
    ]);
    const seen = new Set<string>();
    for (const category of KOJO2_THEME_CATEGORIES) {
      expect(category.tokens.length).toBeGreaterThan(0);
      expect(category.note.length).toBeGreaterThan(0);
      for (const token of category.tokens) {
        expect(TOKEN_NAMES, `${category.category} 里的 ${token} 不是词法 token`).toContain(token);
        expect(seen.has(token), `${token} 被两类同时登记`).toBe(false);
        seen.add(token);
      }
    }
    // 对话类必须含 `角色：「…」` 的两层：说话人与台词
    const dialogue = KOJO2_THEME_CATEGORIES.find((category) => category.category === '对话')!;
    expect(dialogue.tokens).toContain(KOJO2_TOKEN.speaker);
    expect(dialogue.tokens).toContain(KOJO2_TOKEN.speech);
  });
});

/* ============================== 主题字面量 ============================== */

describe('主题字面量：亮 / 暗 / 墨绿三套，rules 与 colors 都完整', () => {
  it('暗色：vs-dark、不继承、规则就是 KOJO2_THEME_RULES 的浅拷贝', () => {
    expect(kojo2DarkTheme.base).toBe('vs-dark');
    expect(kojo2DarkTheme.inherit).toBe(false);
    expect(kojo2DarkTheme.rules).toEqual([...KOJO2_THEME_RULES]);
    expect(kojo2DarkTheme.rules.map((rule) => rule.token).sort()).toEqual([...TOKEN_NAMES].sort());
  });

  it('亮色 / 墨绿：不继承、规则 token 集合与暗色完全相同', () => {
    for (const theme of [kojo2LightTheme, kojo2MintDarkTheme]) {
      expect(theme.inherit).toBe(false);
      expect(theme.rules.map((rule) => rule.token).sort()).toEqual([...TOKEN_NAMES].sort());
    }
    expect(kojo2LightTheme.base).toBe('vs');
    expect(kojo2MintDarkTheme.base).toBe('vs-dark');
    // 亮色的每一格 = 映射里的亮色侧（不另写第二份调色板）
    const lightByToken = new Map(kojo2LightTheme.rules.map((rule) => [rule.token, rule]));
    for (const token of TOKEN_NAMES) {
      const rule = lightByToken.get(token);
      expect(rule!.foreground).toBe(KOJO2_THEME_TOKEN_MAP[token].light.foreground);
      expect(rule!.fontStyle).toBe(KOJO2_THEME_TOKEN_MAP[token].light.fontStyle);
    }
  });

  it('主题 id ↔ 字面量一一对应；偏好映射回缺省暗色', () => {
    expect(KOJO2_THEME_IDS).toEqual([
      KOJO2_DARK_THEME_ID,
      KOJO2_LIGHT_THEME_ID,
      KOJO2_MINT_DARK_THEME_ID,
    ]);
    expect(Object.keys(KOJO2_THEMES).sort()).toEqual([...KOJO2_THEME_IDS].sort());
    expect(KOJO2_THEMES[KOJO2_DARK_THEME_ID]).toBe(kojo2DarkTheme);
    expect(kojo2ThemeIdFor('dark')).toBe(KOJO2_DARK_THEME_ID);
    expect(kojo2ThemeIdFor('light')).toBe(KOJO2_LIGHT_THEME_ID);
    expect(kojo2ThemeIdFor('mint-dark')).toBe(KOJO2_MINT_DARK_THEME_ID);
    expect(kojo2ThemeIdFor('sepia' as never)).toBe(KOJO2_DARK_THEME_ID);
  });

  it('colors 键集合三套相同且 = KOJO2_COLOR_KEYS；每个值都是合法十六进制', () => {
    const expectedKeys = [...KOJO2_COLOR_KEYS].sort();
    for (const id of KOJO2_THEME_IDS) {
      const colors = KOJO2_THEMES[id].colors;
      expect(Object.keys(colors).sort(), id).toEqual(expectedKeys);
      for (const [key, value] of Object.entries(colors)) {
        expect(value, `${id}/${key}`).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i);
      }
    }
    // 两套主题的底必须不同（不是复制粘贴的假亮色）
    expect(kojo2LightTheme.colors['editor.background']).not.toBe(
      kojo2DarkTheme.colors['editor.background'],
    );
    expect(kojo2MintDarkTheme.colors['editor.background']).not.toBe(
      kojo2DarkTheme.colors['editor.background'],
    );
  });
});

/* ============================== 配色质量 ============================== */

describe('配色质量：对比度 ≥ 4.5、任意两档 ΔE ≥ 12', () => {
  const SIDES: readonly {
    readonly name: string;
    readonly side: Kojo2TokenThemeSide;
    readonly theme: Monaco.editor.IStandaloneThemeData;
  }[] = [
    { name: 'dark', side: 'dark', theme: kojo2DarkTheme },
    { name: 'light', side: 'light', theme: kojo2LightTheme },
    { name: 'mint-dark', side: 'mint', theme: kojo2MintDarkTheme },
  ];

  it.each(SIDES)('$name：每档前景对底色对比度 ≥ 4.5', ({ theme, side }) => {
    const background = theme.colors['editor.background']!.slice(1);
    for (const token of TOKEN_NAMES) {
      const foreground = KOJO2_THEME_TOKEN_MAP[token][side].foreground;
      expect(contrast(foreground, background), `${token} 在 ${side} 底上太弱`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    // 去重后剩几枚独立色 = 16 档减去"同档共用色"的对数：
    // 暗色共用 {台词/字面, 数字/十六进制} 2 对 ⇒ 14；亮色再多一对 {原生/注释} ⇒ 13。
    // （标点 2026-10-26 批起与 v1 同色 7f9cc0，不再与保留词共用 ⇒ 暗色 12 → 13；
    //  类型档 2026-10-27 批各套都是一枚新色，不与任何档共用 ⇒ 暗 13 → 14、亮 12 → 13。）
    { name: 'dark', theme: kojo2DarkTheme, unique: 14 },
    { name: 'light', theme: kojo2LightTheme, unique: 13 },
  ])('$name：任意两档 CIE76 ΔE ≥ 12（一档一色，不许假分层）', ({ theme, unique: expected }) => {
    const unique = [...new Set(theme.rules.map((rule) => rule.foreground!))];
    expect(unique.length).toBe(expected);
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        expect(
          deltaE(unique[i]!, unique[j]!),
          `${unique[i]} 与 ${unique[j]} 肉眼难分`,
        ).toBeGreaterThanOrEqual(12);
      }
    }
  });
});

/* ============================== 注册 ============================== */

describe('registerKojo2Themes：幂等、不串实例、主题名完整', () => {
  it('同一实例重复调用只定义一次（返回 false 表示这次什么都没做）', () => {
    const fake = fakeMonaco();
    expect(registerKojo2Themes(fake.monaco)).toBe(true);
    expect([...fake.defined.keys()]).toEqual([...KOJO2_THEME_IDS]);
    expect(fake.calls()).toBe(3);
    expect(fake.defined.get(KOJO2_DARK_THEME_ID)).toBe(kojo2DarkTheme);

    expect(registerKojo2Themes(fake.monaco)).toBe(false);
    expect(registerKojo2Themes(fake.monaco)).toBe(false);
    expect(fake.calls()).toBe(3);
    expect(fake.defined.size).toBe(3);
  });

  it('第二个 Monaco 实例照常各注册一份（不因前一实例已注册而跳过）', () => {
    const fresh = fakeMonaco();
    expect(registerKojo2Themes(fresh.monaco)).toBe(true);
    expect(fresh.calls()).toBe(3);
    expect([...fresh.defined.keys()]).toEqual([...KOJO2_THEME_IDS]);
    for (const id of KOJO2_THEME_IDS) {
      expect(fresh.defined.get(id)).toBe(KOJO2_THEMES[id]);
    }
  });
});

/* ==================== 既有主题装配点：flag 守卫的接线 ==================== */

/** 假 localStorage（`null` = 没存过 = flag 关；`'on'` = 开） */
function stubFlag(on: boolean): void {
  const store = new Map<string, string>();
  if (on) store.set('kojo.ui.kojo2Cutover.v1', 'on');
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

/** 动态 import 是异步的：等它落地（不引入假时钟，避免与 `defineTheme` 的同步断言打架） */
async function flushThemeImport(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('defineMonacoThemes · Kojo 2.0 主题只在 flag 开时注册', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('flag 关 ⇒ 只有 v1 三套，一个 kojo2-* 都不定义（也不加载主题模块）', async () => {
    stubFlag(false);
    const fake = fakeMonaco();
    defineMonacoThemes(fake.monaco);
    await flushThemeImport();
    expect([...fake.defined.keys()]).toEqual(['kojo-dark', 'kojo-light', 'kojo-mint-dark']);
    expect(fake.calls()).toBe(3);
  });

  it('flag 开 ⇒ 追加定义 kojo2-* 三套（v1 三套原样保留，不覆盖）', async () => {
    stubFlag(true);
    const fake = fakeMonaco();
    defineMonacoThemes(fake.monaco);
    // v1 三套是同步定义；2.0 三套在动态 import 之后
    expect([...fake.defined.keys()]).toEqual(['kojo-dark', 'kojo-light', 'kojo-mint-dark']);
    await flushThemeImport();
    expect([...fake.defined.keys()]).toEqual([
      'kojo-dark',
      'kojo-light',
      'kojo-mint-dark',
      ...KOJO2_THEME_IDS,
    ]);
    for (const id of KOJO2_THEME_IDS) expect(fake.defined.get(id)).toBe(KOJO2_THEMES[id]);
    expect(fake.calls()).toBe(6);
  });

  it('重复装配同一实例：2.0 三套不重复 define（`registerKojo2Themes` 的 WeakSet 幂等）', async () => {
    stubFlag(true);
    const fake = fakeMonaco();
    defineMonacoThemes(fake.monaco);
    await flushThemeImport();
    expect(fake.calls()).toBe(6);
    defineMonacoThemes(fake.monaco);
    await flushThemeImport();
    // 第二次：v1 三套照旧重定义（既有行为），2.0 三套被幂等挡掉
    expect(fake.calls()).toBe(9);
    expect(fake.defined.size).toBe(6);
  });
});

/* ==================== K2-CUTOVER-THEME：2.0 规则并入 v1 三套 ==================== */

/**
 * v1 三套主题的**规则词表契约**（本测试自持一份，不 import `theme.ts` 的实现细节）：
 * 词法基线 12 档 + 糖 15 档 + 语义 5 档 = 32 条。flag 关时三套 rules 必须**逐字**就是这
 * 32 条（K2-CUTOVER-THEME 的硬判据）；flag 开时这 32 条仍在原位，2.0 规则只许**追加**。
 */
const V1_BASE_TOKENS: readonly string[] = [
  'comment',
  'keyword',
  'keyword.preprocessor',
  'entity.name.function',
  // 类型 / 结构名（2026-10-27 第三色批）：位序与 `theme.ts` 的 BASE_RULE_SPECS 逐字对齐——
  // 本表是"原序在前"那条判据的尺子，插错一格当场红。
  'support.type',
  'variable',
  'string',
  'number',
  'label',
  'identifier',
  'operator',
  'string.escape',
];

const V1_RULE_TOKENS: readonly string[] = [
  ...V1_BASE_TOKENS,
  ...KOJO_SUGAR_THEME_RULES.map((rule) => rule.token),
  ...KOJO_SEMANTIC_THEME_RULES.map((rule) => rule.token),
];

/** 装配一次并拿 `defineTheme` 捕获的账（flag 由调用方先 stub） */
function captureThemes(): Map<string, Monaco.editor.IStandaloneThemeData> {
  const fake = fakeMonaco();
  defineMonacoThemes(fake.monaco);
  return fake.defined;
}

function tokensOf(theme: Monaco.editor.IStandaloneThemeData): string[] {
  return theme.rules.map((rule) => rule.token);
}

describe('2.0 规则无条件并入 v1 三套（K2-SURFACE-DEFAULT）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('默认档（不设任何 stage）：v1 32 条原序在前，16 条 2.0 规则逐格追加在后', () => {
    // 不 stub 任何东西 = 缺省阶段 `v1-only`（切流语义关闭）——配色是语言面，照样并入
    const themes = captureThemes();
    for (const id of ['kojo-dark', 'kojo-light', 'kojo-mint-dark'] as const) {
      const tokens = tokensOf(themes.get(id)!);
      expect(tokens.slice(0, V1_RULE_TOKENS.length), id).toEqual([...V1_RULE_TOKENS]);
      expect(tokens.length, id).toBe(V1_RULE_TOKENS.length + KOJO2_THEME_RULES.length);
    }
  });

  it('默认档：16/16 个 `kojo2.*` token 全部有配色（三套主题各 16 条）', () => {
    const themes = captureThemes();
    const expected = Object.values(KOJO2_TOKEN);
    expect(expected).toHaveLength(16);
    for (const id of ['kojo-dark', 'kojo-light', 'kojo-mint-dark'] as const) {
      const tokens = new Set(tokensOf(themes.get(id)!));
      const missing = expected.filter((token) => !tokens.has(token));
      expect(missing, `${id} 缺 ${missing.length} 档 2.0 token 配色`).toEqual([]);
    }
  });

  it('暗色两套追加暗色规则、亮色那套追加亮色规则（不把暗色调色板照搬）', () => {
    const themes = captureThemes();
    const darkTail = themes.get('kojo-dark')!.rules.slice(V1_RULE_TOKENS.length);
    const mintTail = themes.get('kojo-mint-dark')!.rules.slice(V1_RULE_TOKENS.length);
    const lightTail = themes.get('kojo-light')!.rules.slice(V1_RULE_TOKENS.length);
    expect(darkTail).toEqual([...KOJO2_THEME_RULES]);
    // 墨绿有自己的盘（色值批：暗色表落墨绿底剩 4 对撞色）⇒ 只保证"是 2.0 的 16 档"
    expect(mintTail.map((rule) => rule.token)).toEqual(KOJO2_THEME_RULES.map((rule) => rule.token));
    expect(lightTail).toEqual([...KOJO2_LIGHT_THEME_RULES]);
    const darkByToken = new Map(KOJO2_THEME_RULES.map((rule) => [rule.token, rule.foreground]));
    for (const rule of lightTail) {
      expect(rule.foreground, `${rule.token} 亮色误用暗色`).not.toBe(darkByToken.get(rule.token));
    }
  });

  it('kojo-mint-dark：追加墨绿 2.0 规则（与 kojo2-mint-dark 同一选择）', () => {
    const mint = captureThemes().get('kojo-mint-dark')!;
    expect(mint.rules.slice(V1_RULE_TOKENS.length)).toEqual([...KOJO2_MINT_THEME_RULES]);
    // 墨绿不再复用暗色表：那五枚与本盘近邻色只差 4.4–11.7（撞色），已换成墨绿语义近邻色
    expect(KOJO2_MINT_THEME_RULES).not.toEqual(KOJO2_THEME_RULES);
  });

  it('rules 与 colors 只随装配，不随切流开关：两档逐字相同', () => {
    stubFlag(false);
    const off = captureThemes();
    stubFlag(true);
    const on = captureThemes();
    for (const id of ['kojo-dark', 'kojo-light', 'kojo-mint-dark'] as const) {
      expect(on.get(id)!.rules, id).toEqual(off.get(id)!.rules);
      expect(on.get(id)!.colors, id).toEqual(off.get(id)!.colors);
    }
  });

  it('亮色 2.0 规则表在 #f6f8fa 上每档对比度 ≥ 4.5（合并进 kojo-light 不掉档）', () => {
    expect(KOJO2_LIGHT_THEME_RULES.length).toBe(Object.values(KOJO2_TOKEN).length);
    for (const rule of KOJO2_LIGHT_THEME_RULES) {
      expect(rule.foreground, rule.token).toBeDefined();
      expect(contrast(rule.foreground!, 'f6f8fa'), `${rule.token} 在浅底上太弱`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('KOJO2_LIGHT_THEME_RULES 与 KOJO2_TOKEN 逐字对齐（token 集合 + 顺序 + 字体样式）', () => {
    expect(KOJO2_LIGHT_THEME_RULES.map((rule) => rule.token)).toEqual([...Object.values(KOJO2_TOKEN)]);
    const darkByToken = new Map(KOJO2_THEME_RULES.map((rule) => [rule.token, rule]));
    for (const rule of KOJO2_LIGHT_THEME_RULES) {
      expect(rule.fontStyle, `${rule.token} 亮/暗字重漂移`).toBe(darkByToken.get(rule.token)?.fontStyle);
    }
  });

  it('规则数据单源：kojo2-language 的 re-export 与叶子是同一对象（搬家没复制）', () => {
    expect(KOJO2_THEME_RULES).toBe(LEAF_THEME_RULES);
    expect(KOJO2_TOKEN).toBe(LEAF_TOKEN);
  });
});
