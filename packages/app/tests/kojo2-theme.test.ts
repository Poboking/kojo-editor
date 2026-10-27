/**
 * Kojo 2.0 主题判据闸（K2-CUTOVER-PRE；LAU-2 起判据对象 = 语义角色）。
 *
 * 钉四件事：
 * 1. **角色同源**：`KOJO2_THEME_TOKEN_MAP` 的键集合与 `SEMANTIC_ROLES` 逐字相等（顺序也相等），
 *    暗色侧与叶子的 `ROLE_THEME_RULES` 逐格同源——将来角色表加档 / 改名，这里先红，
 *    不会静默掉色；
 * 2. **三套 key 完整**：暗 / 亮 / 墨绿三套的 `colors` 键集合与 `KOJO2_COLOR_KEYS` 相等，
 *    每个值都是合法十六进制色；三套的规则 token 集合彼此相等；
 * 3. **配色质量**：每档角色对各自底色对比度 ≥ 4.5，任意两档 CIE76 ΔE ≥ 12（假分层 = 红）；
 * 4. **注册幂等**：同一 Monaco 实例只定义一次，第二个实例各注册一份，主题名不串。
 *
 * LAU-2 之前这一族量的是 16 个 `kojo2.*` token；现在两门语言共用一个角色表，
 * 三套 `kojo2-*` 主题与六套 `kojo-*` 主题铺的是**同一批 34 档角色**（逐档色值由
 * `semantic-roles.test.ts` 拿改前快照钉住），所以本文件量角色，不再量 `kojo2.*` 名字。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import {
  KOJO_SEMANTIC_THEME_RULES,
  ROLE_LIGHT_THEME_RULES,
  ROLE_MINT_THEME_RULES,
  ROLE_THEME_RULES,
} from '../src/monaco/kojo-theme-rules';
import { KOJO2_TOKEN, ROLE, ROLE_FONT_STYLES, SEMANTIC_ROLES, isSemanticRole } from '../src/monaco/semantic-roles';
import { defineMonacoThemes, monacoThemeIdFor } from '../src/monaco/theme';
import { THEME_IDS } from '../src/ui/theme-pref';
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

/* ============================== 角色同源 ============================== */

const ROLE_NAMES = [...SEMANTIC_ROLES];

describe('角色映射：与语义角色表逐字一致', () => {
  it('键集合 = SEMANTIC_ROLES（顺序也一致，防手抄漂移）', () => {
    expect(Object.keys(KOJO2_THEME_TOKEN_MAP)).toEqual(ROLE_NAMES);
    expect(new Set(Object.keys(KOJO2_THEME_TOKEN_MAP)).size).toBe(ROLE_NAMES.length);
    // 全部 `role.` 前缀（与 Monaco 基线 token 如 `keyword` / `string` 不撞名）
    for (const role of ROLE_NAMES) expect(role.startsWith('role.')).toBe(true);
  });

  it('暗色侧与 ROLE_THEME_RULES 逐格同源（前景 + 字体样式，一格不差）', () => {
    const ruleByRole = new Map(ROLE_THEME_RULES.map((rule) => [rule.token, rule]));
    expect(ruleByRole.size).toBe(ROLE_NAMES.length);
    for (const role of ROLE_NAMES) {
      const rule = ruleByRole.get(role);
      expect(rule, `ROLE_THEME_RULES 缺 ${role}`).toBeTruthy();
      const style = KOJO2_THEME_TOKEN_MAP[role as keyof typeof KOJO2_THEME_TOKEN_MAP].dark;
      expect(style.foreground).toBe(rule!.foreground);
      expect(style.fontStyle).toBe(rule!.fontStyle);
    }
  });

  it('亮色侧齐全且是合法十六进制；三侧都只含允许的字体样式', () => {
    for (const role of ROLE_NAMES) {
      for (const side of ['dark', 'light', 'mint'] as const) {
        const style = KOJO2_THEME_TOKEN_MAP[role as keyof typeof KOJO2_THEME_TOKEN_MAP][side];
        expect(style.foreground, `${role}/${side}`).toMatch(/^[0-9a-f]{6}$/i);
        expect([undefined, 'bold', 'italic']).toContain(style.fontStyle);
      }
    }
    // 锚点加粗、提示与注释斜体（与角色表的 `ROLE_FONT_STYLES` 一致）
    expect(KOJO2_THEME_TOKEN_MAP[ROLE.anchor].dark.fontStyle).toBe('bold');
    expect(KOJO2_THEME_TOKEN_MAP[ROLE.anchor].light.fontStyle).toBe('bold');
    expect(KOJO2_THEME_TOKEN_MAP[ROLE.hint].light.fontStyle).toBe('italic');
    expect(KOJO2_THEME_TOKEN_MAP[ROLE.comment].light.fontStyle).toBe('italic');
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
        expect(isSemanticRole(token), `${category.category} 里的 ${token} 不是角色`).toBe(true);
        expect(ROLE_NAMES, `${category.category} 里的 ${token} 不在角色表`).toContain(token);
        expect(seen.has(token), `${token} 被两类同时登记`).toBe(false);
        seen.add(token);
      }
    }
    // 对话类必须含 `角色：「…」` 的两层：说话人与台词
    const dialogue = KOJO2_THEME_CATEGORIES.find((category) => category.category === '对话')!;
    expect(dialogue.tokens).toContain(ROLE.speaker);
    expect(dialogue.tokens).toContain(ROLE.speech);
  });

  it('2.0 的十六个词法档位名解析到的角色全部在映射里（词法 → 角色 → 颜色一条链走通）', () => {
    expect(Object.keys(KOJO2_TOKEN).length).toBe(16);
    for (const role of Object.values(KOJO2_TOKEN)) {
      expect(isSemanticRole(role)).toBe(true);
      expect(KOJO2_THEME_TOKEN_MAP[role], `${role} 没有主题样式`).toBeDefined();
    }
  });

  it('三侧字重逐格等于角色表的 ROLE_FONT_STYLES（字重漂移 = 屏上"同一档两种脸"）', () => {
    for (const role of ROLE_NAMES) {
      const want = ROLE_FONT_STYLES[role as keyof typeof ROLE_FONT_STYLES];
      for (const side of ['dark', 'light', 'mint'] as const) {
        expect(
          KOJO2_THEME_TOKEN_MAP[role as keyof typeof KOJO2_THEME_TOKEN_MAP][side].fontStyle,
          `${role}/${side}`,
        ).toBe(want);
      }
    }
  });
});

/* ============================== 主题字面量 ============================== */

describe('主题字面量：亮 / 暗 / 墨绿三套，rules 与 colors 都完整', () => {
  it('暗色：vs-dark、不继承、规则就是 ROLE_THEME_RULES 的浅拷贝', () => {
    expect(kojo2DarkTheme.base).toBe('vs-dark');
    expect(kojo2DarkTheme.inherit).toBe(false);
    expect(kojo2DarkTheme.rules).toEqual([...ROLE_THEME_RULES]);
    expect(kojo2DarkTheme.rules.map((rule) => rule.token).sort()).toEqual([...ROLE_NAMES].sort());
  });

  it('亮色 / 墨绿：不继承、规则角色集合与暗色完全相同', () => {
    for (const theme of [kojo2LightTheme, kojo2MintDarkTheme]) {
      expect(theme.inherit).toBe(false);
      expect(theme.rules.map((rule) => rule.token).sort()).toEqual([...ROLE_NAMES].sort());
    }
    expect(kojo2LightTheme.base).toBe('vs');
    expect(kojo2MintDarkTheme.base).toBe('vs-dark');
    // 亮色的每一格 = 映射里的亮色侧（不另写第二份调色板）
    const lightByRole = new Map(kojo2LightTheme.rules.map((rule) => [rule.token, rule]));
    for (const role of ROLE_NAMES) {
      const rule = lightByRole.get(role);
      expect(rule!.foreground).toBe(KOJO2_THEME_TOKEN_MAP[role as keyof typeof KOJO2_THEME_TOKEN_MAP].light.foreground);
      expect(rule!.fontStyle).toBe(KOJO2_THEME_TOKEN_MAP[role as keyof typeof KOJO2_THEME_TOKEN_MAP].light.fontStyle);
    }
    expect(kojo2LightTheme.rules).toEqual([...ROLE_LIGHT_THEME_RULES]);
    expect(kojo2MintDarkTheme.rules).toEqual([...ROLE_MINT_THEME_RULES]);
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
    // 三套主题的底必须两两不同（不是复制粘贴的假亮色）
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

  it.each(SIDES)('$name：每档角色前景对底色对比度 ≥ 4.5', ({ theme, side }) => {
    const background = theme.colors['editor.background']!.slice(1);
    for (const role of ROLE_NAMES) {
      const foreground = KOJO2_THEME_TOKEN_MAP[role as keyof typeof KOJO2_THEME_TOKEN_MAP][side].foreground;
      expect(contrast(foreground, background), `${role} 在 ${side} 底上太弱`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    // 去重后剩几枚独立色（LAU-2 收口前与收口后**逐字相同**——本批一格色都没改；
    // 旧读数是 16 档 `kojo2.*` 去重后的 14 / 13 / 13，现在是 34 档角色去重后的 25 / 18 / 16）：
    // dark 25 / light 18 / mint 16。
    { name: 'dark', theme: kojo2DarkTheme, unique: 25 },
    { name: 'light', theme: kojo2LightTheme, unique: 18 },
    { name: 'mint-dark', theme: kojo2MintDarkTheme, unique: 16 },
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

/**
 * v1 主题 id 全集（**按 `THEME_IDS` 现算，不手抄**）：2026-10-27 批次把 v1 从三套扩到六套
 * （深 / 浅 / 薄荷 / One Dark / Rosé Pine / Synthwave '84），自那以后任何"三套"字面量都
 * 会当场红。这里与 `monaco-theme.test.ts` 同口径，将来加档两条测试一起自动跟上。
 */
const V1_THEME_IDS: readonly string[] = THEME_IDS.map(monacoThemeIdFor);

/**
 * 假 localStorage。**LAU-3 起缺省档 = `2.0-default`（flag 开）**，所以：
 * 开 = 旧键 `'on'`（⇒ `dual`）或什么都不存；关 = 盘上显式一份 `v1-only` 计划。
 */
function stubFlag(on: boolean): void {
  const store = new Map<string, string>();
  if (on) store.set('kojo.ui.kojo2Cutover.v1', 'on');
  else
    store.set(
      'kojo.ui.kojo2Cutover.plan.v1',
      JSON.stringify({ version: 2, stage: 'v1-only', overrides: {} }),
    );
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

  it('flag 关 ⇒ 只有 v1 那几套，一个 kojo2-* 都不定义（也不加载主题模块）', async () => {
    stubFlag(false);
    const fake = fakeMonaco();
    defineMonacoThemes(fake.monaco);
    await flushThemeImport();
    expect([...fake.defined.keys()]).toEqual(V1_THEME_IDS);
    expect(fake.calls()).toBe(V1_THEME_IDS.length);
  });

  it('flag 开 ⇒ 追加定义 kojo2-* 三套（v1 原样保留，不覆盖）', async () => {
    stubFlag(true);
    const fake = fakeMonaco();
    defineMonacoThemes(fake.monaco);
    // v1 是同步定义；2.0 三套在动态 import 之后
    expect([...fake.defined.keys()]).toEqual(V1_THEME_IDS);
    await flushThemeImport();
    expect([...fake.defined.keys()]).toEqual([...V1_THEME_IDS, ...KOJO2_THEME_IDS]);
    for (const id of KOJO2_THEME_IDS) expect(fake.defined.get(id)).toBe(KOJO2_THEMES[id]);
    expect(fake.calls()).toBe(V1_THEME_IDS.length + KOJO2_THEME_IDS.length);
  });

  it('重复装配同一实例：2.0 三套不重复 define（`registerKojo2Themes` 的 WeakSet 幂等）', async () => {
    stubFlag(true);
    const fake = fakeMonaco();
    defineMonacoThemes(fake.monaco);
    await flushThemeImport();
    const firstPass = V1_THEME_IDS.length + KOJO2_THEME_IDS.length;
    expect(fake.calls()).toBe(firstPass);
    defineMonacoThemes(fake.monaco);
    await flushThemeImport();
    // 第二次：v1 那几套照旧重定义（既有行为），2.0 三套被幂等挡掉
    expect(fake.calls()).toBe(firstPass + V1_THEME_IDS.length);
    expect(fake.defined.size).toBe(firstPass);
  });
});

/* ==================== LAU-2：规则数据单源 + 六套与三套同角色 ==================== */

/** 装配一次并拿 `defineTheme` 捕获的账（flag 由调用方先 stub） */
function captureThemes(): Map<string, Monaco.editor.IStandaloneThemeData> {
  const fake = fakeMonaco();
  defineMonacoThemes(fake.monaco);
  return fake.defined;
}

describe('LAU-2：三套 `kojo2-*` 与六套 `kojo-*` 铺同一批角色', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('规则数据单源：叶子三张规则表被三套 kojo2 主题原样引用（浅拷贝，元素同对象）', () => {
    for (const [theme, rules] of [
      [kojo2DarkTheme, ROLE_THEME_RULES],
      [kojo2LightTheme, ROLE_LIGHT_THEME_RULES],
      [kojo2MintDarkTheme, ROLE_MINT_THEME_RULES],
    ] as const) {
      expect(theme.rules).toHaveLength(rules.length);
      for (let i = 0; i < rules.length; i += 1) expect(theme.rules[i]).toBe(rules[i]);
    }
  });

  it('六套 kojo-* 的角色规则集与 kojo2-* 逐字相同（两门语言同一批档）', () => {
    const themes = captureThemes();
    for (const id of V1_THEME_IDS) {
      const roles = themes.get(id)!.rules.map((rule) => rule.token).filter((t) => t.startsWith('role.'));
      expect([...roles].sort(), id).toEqual([...ROLE_NAMES].sort());
    }
  });

  it('规则与颜色只随装配、不随切流开关：两档逐字相同', () => {
    stubFlag(false);
    const off = captureThemes();
    stubFlag(true);
    const on = captureThemes();
    for (const id of V1_THEME_IDS) {
      expect(on.get(id)!.rules, id).toEqual(off.get(id)!.rules);
      expect(on.get(id)!.colors, id).toEqual(off.get(id)!.colors);
    }
  });

  it('亮色角色调色板在 #f6f8fa 上每档 ≥ 4.5（合并进 kojo-light 不掉档）', () => {
    for (const rule of ROLE_LIGHT_THEME_RULES) {
      expect(rule.foreground, rule.token).toBeDefined();
      expect(contrast(rule.foreground!, 'f6f8fa'), `${rule.token} 在浅底上太弱`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('名字层五条仍在 kojo-dark 里（D6：与角色正交，不并进角色表）', () => {
    const themes = captureThemes();
    const tokens = new Set(themes.get('kojo-dark')!.rules.map((rule) => rule.token));
    for (const rule of KOJO_SEMANTIC_THEME_RULES) expect(tokens.has(rule.token), rule.token).toBe(true);
  });
});
