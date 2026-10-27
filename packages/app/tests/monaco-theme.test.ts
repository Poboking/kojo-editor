import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import { registerErbLanguage } from '../src/monaco/erb-language';
import { ROLE_THEME_RULES } from '../src/monaco/kojo-language';
import { NAME_LAYER_RULES, ROLE, SEMANTIC_ROLES } from '@kojo/kojo-lang/semantic-roles';
import { KOJO_SEMANTIC_THEME_RULES } from '../src/monaco/kojo-semantic-tokens';
import { monacoThemeIdFor, type MonacoThemeId, type MonacoThemePref } from '../src/monaco/theme';
import { THEME_IDS, type ThemePref } from '../src/ui/theme-pref';

/**
 * Monaco 三主题（2026-10-17 反馈 3）验收：
 * ① 偏好 → 主题 id 三档一一对应、未知值不崩；
 * ② 走真装配 `registerErbLanguage` 捕获三套 defineTheme：id/base/rules/colors 齐全，
 *    三套背景互不相同，dark 的糖/语义规则**同引用**（与 kojo-token-tiers 同一判据）；
 * ③ 三套 editor.background/foreground 与 styles.css / themes/*.css 的 --bg/--fg 逐字相等；
 * ④ 每个规则前景对各自背景过 WCAG（暗色既有弱档在白名单里写明理由）；
 * ⑤ rules 覆盖全部糖 token 与语义 token（light/mint 不得少配一档）。
 */

/* ============================== 假 Monaco（捕获 defineTheme） ============================== */

interface CapturedTheme {
  readonly base: string;
  readonly inherit: boolean;
  readonly rules: Monaco.editor.ITokenThemeRule[];
  readonly colors: Record<string, string>;
}

function stubMonaco(): { monaco: typeof Monaco; themes: Map<string, CapturedTheme> } {
  const themes = new Map<string, CapturedTheme>();
  const registered: string[] = [];
  const monaco = {
    languages: {
      // ERB-ENTER-RULES：`registerErbLanguage` 现在也装配两件套，翻译层要读这一格
      // （取值与 monaco-editor 的枚举逐字对齐，同 monarch-harness / kojo-enter.test.ts）
      IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
      getLanguages: () => registered.map((id) => ({ id })),
      register: (language: { id: string }) => {
        registered.push(language.id);
        return { dispose: () => undefined };
      },
      setMonarchTokensProvider: () => ({ dispose: () => undefined }),
      setLanguageConfiguration: () => ({ dispose: () => undefined }),
    },
    editor: {
      defineTheme: (id: string, theme: CapturedTheme) => {
        themes.set(id, theme);
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, themes };
}

const { monaco, themes } = stubMonaco();
registerErbLanguage(monaco);

const THEME_BASES: Readonly<Record<MonacoThemeId, string>> = {
  'kojo-dark': 'vs-dark',
  'kojo-light': 'vs',
  'kojo-mint-dark': 'vs-dark',
  // 2026-10-27 经典编辑器色三套：三套都是深色，base 一律 vs-dark
  // （`inherit: false` 下 base 只决定滚动条惯性 / 缩略图归一化这类"深浅行为"开关，不供色）
  'kojo-one-dark': 'vs-dark',
  'kojo-rose-pine': 'vs-dark',
  'kojo-synthwave84': 'vs-dark',
};

const REQUIRED_COLORS = [
  'editor.background',
  'editor.foreground',
  'editorLineNumber.foreground',
  'editorLineNumber.activeForeground',
  'editor.lineHighlightBackground',
  'editor.selectionBackground',
  'editor.inactiveSelectionBackground',
  'editorCursor.foreground',
  'editorIndentGuide.background1',
  'editorIndentGuide.activeBackground1',
  'editorBracketMatch.background',
  'editorBracketMatch.border',
  'editorWidget.background',
  'editorWidget.border',
  'editorWidget.foreground',
  'editorSuggestWidget.background',
  'editorSuggestWidget.selectedBackground',
  'editorSuggestWidget.highlightForeground',
  'editorHoverWidget.background',
  'editorHoverWidget.border',
  'editor.findMatchBackground',
  'minimap.background',
  'scrollbarSlider.background',
  'editorOverviewRuler.border',
] as const;

/**
 * 六套主题都必须覆盖的**角色**（LAU-2：词法基线不再按 token 名判，改按角色判）。
 * 这十二档是"每个编辑器都必须有的那几层"：注释 / 骨架 / 预处理 / 定义名 / 类型 / 变量 /
 * 串 / 数字 / 标签 / 正文 / 运算符 / 转义。缺一档 ⇔ `rulesFromRolePalette` 在装配期抛。
 */
const REQUIRED_BASE_ROLES = [
  ROLE.comment,
  ROLE.keyword,
  ROLE.directive,
  ROLE.decl,
  ROLE.type,
  ROLE.variable,
  ROLE.string,
  ROLE.number,
  ROLE.label,
  ROLE.text,
  ROLE.operator,
  ROLE.escape,
] as const;

/* ============================== ① 映射 ============================== */

describe('monacoThemeIdFor：六档映射与兜底', () => {
  it('六档偏好一一对应且主题 id 唯一、全覆盖', () => {
    expect(THEME_IDS.map((pref) => monacoThemeIdFor(pref))).toEqual([
      'kojo-dark',
      'kojo-light',
      'kojo-mint-dark',
      'kojo-one-dark',
      'kojo-rose-pine',
      'kojo-synthwave84',
    ]);
    expect(new Set(THEME_IDS.map((pref) => monacoThemeIdFor(pref))).size).toBe(THEME_IDS.length);
  });

  it('未知值不崩：回缺省 kojo-dark', () => {
    expect(monacoThemeIdFor('solarized' as ThemePref)).toBe('kojo-dark');
  });
});

/* ============================== ② 六套主题装配 ============================== */

/**
 * v1 主题 id 全集（**按 `THEME_IDS` 现算，不手抄**；与 `kojo2-theme.test.ts` 同口径）。
 *
 * LAU-3 起缺省档（`2.0-default`）就在装配时追加 `kojo2-*` 三套——但那是**动态 import**
 * （`theme.ts` 的 flag 守卫）：何时落地取决于本模块是否已被同 worker 里别的用例加载过，
 * 跑单文件时不落地、跑全量时常已落地。拿"装配面上恰好只有 v1 全集"当判据就成了与时序
 * 赛跑，所以要按这张集合过滤；2.0 三套的注册纪律由 `kojo2-theme.test.ts` 钉
 * （那边显式等 import 落地）。
 */
const V1_THEME_IDS: readonly string[] = THEME_IDS.map((pref) => monacoThemeIdFor(pref));
const V1_THEME_ID_SET: ReadonlySet<string> = new Set(V1_THEME_IDS);

/** 取一套 v1 主题（缺了当场抛：别让 `!` 把"没装配"吞成一条 undefined 链） */
function theme(id: string): CapturedTheme {
  const captured = themes.get(id);
  if (!captured) throw new Error(`没有捕获到 ${id} 主题（装配面漂 = 本文件整个红）`);
  return captured;
}

describe('defineMonacoThemes：经 registerErbLanguage 一次定义六套', () => {
  it('六套 id 齐全，base 正确，rules/colors 非空，inherit=false', () => {
    // 期望集合 = THEME_IDS 经同一映射得来——**不再手抄一份 id 元组**：加档时只要
    // `THEME_IDS` 与 `THEME_ID_BY_PREF` 同步，这条断言自动跟上（手抄的话两处都要改，
    // 漏一处就是"新档有 id 但没被这条守门看见"）。只过滤 v1 全集，理由见 `V1_THEME_IDS`。
    expect([...themes.keys()].filter((id) => V1_THEME_ID_SET.has(id)).sort()).toEqual(
      [...V1_THEME_IDS].sort(),
    );
    for (const id of V1_THEME_IDS) {
      const captured = theme(id);
      expect(captured.base, `${id}.base`).toBe(THEME_BASES[id as MonacoThemeId]);
      expect(captured.inherit, `${id}.inherit`).toBe(false);
      expect(captured.rules.length, `${id}.rules 过少`).toBeGreaterThan(20);
      expect(Object.keys(captured.colors).length, `${id}.colors 过少`).toBeGreaterThan(20);
      for (const key of REQUIRED_COLORS) {
        expect(captured.colors[key], `${id} 缺部件色 ${key}`).toBeDefined();
      }
      for (const [key, value] of Object.entries(captured.colors)) {
        expect(value, `${id}/${key} 颜色不是 hex`).toMatch(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
      }
    }
  });

  it('六套 editor.background 互不相同（换主题必须换底色）', () => {
    const backgrounds = [...themes.entries()]
      .filter(([id]) => V1_THEME_ID_SET.has(id))
      .map(([, captured]) => captured.colors['editor.background']!.toLowerCase());
    expect(new Set(backgrounds).size).toBe(V1_THEME_IDS.length);
  });

  it('dark 的糖/语义规则对象原样复用（同引用，主题侧不抄第二份）', () => {
    const dark = themes.get('kojo-dark');
    if (!dark) throw new Error('没有捕获到 kojo-dark 主题');
    for (const rule of ROLE_THEME_RULES) {
      expect(dark.rules.includes(rule), `kojo-dark 缺糖规则 ${rule.token}（或被复制了）`).toBe(true);
    }
    for (const rule of KOJO_SEMANTIC_THEME_RULES) {
      expect(dark.rules.includes(rule), `kojo-dark 缺语义规则 ${rule.token}（或被复制了）`).toBe(true);
    }
  });
});

/* ============================== ③ 与主题 token 逐字相等 ============================== */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function cssHex(file: string, name: 'bg' | 'fg'): string {
  const match = read(file).match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\b`));
  if (!match?.[1]) throw new Error(`${file} 里找不到 --${name}（主题 token 单一真源漂了）`);
  return match[1].toLowerCase();
}

const CSS_SOURCES: readonly { theme: MonacoThemeId; file: string }[] = [
  // 视觉批十一 L01：dark 档 `--bg/--fg` 随基础 :root 收敛到单源 tokens.css
  { theme: 'kojo-dark', file: '../src/tokens.css' },
  { theme: 'kojo-light', file: '../src/themes/light.css' },
  { theme: 'kojo-mint-dark', file: '../src/themes/mint-dark.css' },
  // 2026-10-27：新三套各自一份主题源。这条映射是"编辑器底色与外壳底色必须同一块"
  // 的唯一守门——两处各写一遍 hex 而没人比对，正是最容易静默漂的一格。
  { theme: 'kojo-one-dark', file: '../src/themes/one-dark.css' },
  { theme: 'kojo-rose-pine', file: '../src/themes/rose-pine.css' },
  { theme: 'kojo-synthwave84', file: '../src/themes/synthwave84.css' },
];

describe('编辑器底色/字色与主题 token 逐字相等', () => {
  for (const { theme, file } of CSS_SOURCES) {
    it(`${theme}：editor.background = --bg、editor.foreground = --fg`, () => {
      const captured = themes.get(theme);
      if (!captured) throw new Error(`没有捕获到 ${theme}`);
      expect(captured.colors['editor.background']!.toLowerCase()).toBe(cssHex(file, 'bg'));
      expect(captured.colors['editor.foreground']!.toLowerCase()).toBe(cssHex(file, 'fg'));
    });
  }
});

/* ============================== ④ 对比度（WCAG 2.x） ============================== */

function srgbChannel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const v = parseInt(hex.replace('#', ''), 16);
  return (
    0.2126 * srgbChannel((v >> 16) & 255) +
    0.7152 * srgbChannel((v >> 8) & 255) +
    0.0722 * srgbChannel(v & 255)
  );
}

function contrastRatio(foreground: string, background: string): number {
  const l1 = luminance(foreground);
  const l2 = luminance(background);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/*
 * 暗色弱档白名单**已清空**（2026-10-26 判据批）。
 *
 * 原先这里挂着两枚豁免：`comment`（`#6a737d` 压 `#1e2227` 3.32，白名单放到 3.0）与
 * `sugar.keyword.alias`（`#8b7bb8` 4.28，放到 4.0）。两者的理由都是"底色从 vs-dark 的
 * `#1e1e1e` 换成 app 的 `#1e2227`，规则色本批不动"——即拿旧基底当尺子量新底，等于承认
 * 这两档在真底上不可读。本批把两枚色提到过线（`879098` 4.93 / `9687be` 4.95），
 * 白名单随之取消：**三套主题的每一条规则都必须 ≥ 4.5**，没有例外。
 */

describe('规则前景对主题背景的 WCAG 对比度', () => {
  for (const id of V1_THEME_IDS) {
    it(`${id}：全部规则 ≥ 4.5:1（无白名单）`, () => {
      const captured = theme(id);
      const background = captured.colors['editor.background'];
      if (!background) throw new Error(`${id} 没有 editor.background`);
      expect(background).toMatch(/^#[0-9a-fA-F]{6}$/);
      for (const rule of captured.rules) {
        const foreground = rule.foreground;
        if (!foreground) throw new Error(`${id}/${rule.token} 没有 foreground`);
        expect(foreground, `${id}/${rule.token}`).toMatch(/^[0-9a-fA-F]{6}$/);
        const ratio = contrastRatio(foreground, background);
        expect(
          ratio,
          `${id}/${rule.token} #${foreground} 对比度 ${ratio.toFixed(2)}:1 < 4.5（底 ${background}）`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

/* ============================== ④b operator 档的落点 ============================== */

/** sRGB → CIE Lab（D65）；色差与彩度都在这条轴上判，判据同 `kojo-token-tiers.test.ts` */
function toLab(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16);
  const [r, g, b] = [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255].map((c) =>
    (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92) * 100,
  ) as [number, number, number];
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 95.047;
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 100;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 108.883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 ΔE：两档肉眼能否分（< 12 就是"配了两个色、屏上一个色"） */
function deltaE(a: string, b: string): number {
  const [l1, c1, h1] = toLab(a);
  const [l2, c2, h2] = toLab(b);
  return Math.hypot(l1 - l2, c1 - c2, h1 - h2);
}

/** Lab 彩度 C*：`抢眼` 的数值代理（同一枚结构档不该比关键字更饱和） */
function chroma(hex: string): number {
  const [, a, b] = toLab(hex);
  return Math.hypot(a, b);
}

/**
 * `operator` 是三套调色板都缺的一格（半角运算符一直裸默认前景，全角标点上一批才定了
 * token 归属却没有颜色）。补色要同时满足四条，否则要么"标点比台词还抢眼"，要么
 * "台词标点读成注释"：可读、弱于正文、别于注释、不抢关键字。
 * light 没直取本套分隔符档 `5b6b7f`（它与浅底注释色 `57606a` 的 ΔE 只有 7.6 ⇒ 同色），
 * 取的是同族更深一档——`③` 那条 ΔE 线就是把这次取舍钉成判据。
 */
describe('operator 档住在结构族里：可读、弱于正文、别于注释、不抢关键字', () => {
  for (const id of V1_THEME_IDS) {
    it(`${id}：四条落点判据全过`, () => {
      const captured = theme(id);
      const background = captured.colors['editor.background'];
      if (!background) throw new Error(`${id} 没有 editor.background`);
      const fgOf = (token: string): string => {
        const foreground = captured.rules.find((r) => r.token === token)?.foreground;
        if (!foreground) throw new Error(`${id} 没有 ${token} 的前景（调色板漏格）`);
        return foreground;
      };
      const operator = fgOf(ROLE.operator);
      expect(operator, `${id}/role.operator`).toMatch(/^[0-9a-fA-F]{6}$/);
      // ① 可读（本文件 ④ 的全局线在 operator 上单独再看一次，读数写进失败信息）
      expect(
        contrastRatio(operator, background),
        `${id}/role.operator #${operator} 对比 ${contrastRatio(operator, background).toFixed(2)}:1 < 4.5`,
      ).toBeGreaterThanOrEqual(4.5);
      // ② 弱于正文：标点比台词/标识符退让（浅底上"退让"= 对比更低）
      expect(
        contrastRatio(operator, background),
        `${id}/role.operator #${operator} 比正文 #${fgOf(ROLE.text)} 还抢眼`,
      ).toBeLessThan(contrastRatio(fgOf(ROLE.text), background));
      // ③ 不抢关键字：彩度低于本套关键字档
      expect(chroma(operator), `${id}/role.operator C*=${chroma(operator).toFixed(1)} ≥ 关键字 C*`).toBeLessThan(
        chroma(fgOf(ROLE.keyword)),
      );
      // ④ 肉眼可分：对每个基线档 ΔE ≥ 12（撞色 = 假分层；注释那一档尤其，台词标点最常被读成它）
      for (const token of REQUIRED_BASE_ROLES) {
        if (token === ROLE.operator) continue;
        const other = fgOf(token);
        expect(
          deltaE(operator, other),
          `${id}: role.operator #${operator} ↔ ${token} #${other} ΔE=${deltaE(operator, other).toFixed(1)} < 12`,
        ).toBeGreaterThanOrEqual(12);
      }
    });
  }
});

/* ============================== ⑤ token 覆盖 ============================== */

describe('六套 rules 覆盖全部角色 + 名字层五条', () => {
  const roleTokens = ROLE_THEME_RULES.map((r) => r.token);
  const semanticTokens = KOJO_SEMANTIC_THEME_RULES.map((r) => r.token);

  for (const id of V1_THEME_IDS) {
    it(`${id}：无漏配 token`, () => {
      const tokens = new Set(theme(id).rules.map((r) => r.token));
      for (const token of [...REQUIRED_BASE_ROLES, ...roleTokens, ...semanticTokens]) {
        expect(tokens.has(token), `${id} 漏配 ${token}`).toBe(true);
      }
    });
  }

  it('light / mint 不复用任何暗色 v1 规则前景（浅色下暗色高亮必然对比不足）', () => {
    const dark = themes.get('kojo-dark');
    if (!dark) throw new Error('没有捕获到 kojo-dark 主题');
    // `kojo2.*` 是 2.0 的专属调色板：`kojo-mint-dark` 刻意沿用暗色 2.0 规则（与 `kojo2-mint-dark`
    // 同一选择），亮色那套自带浅底版本——它们不参与"暗色 v1 前景不许出现在浅底"这条判据。
    const isKojo2 = (token: string): boolean => token.startsWith('kojo2.');
    const darkForegrounds = new Set(
      dark.rules.filter((r) => !isKojo2(r.token)).map((r) => r.foreground?.toLowerCase()),
    );
    for (const id of ['kojo-light', 'kojo-mint-dark'] as const) {
      const theme = themes.get(id);
      if (!theme) throw new Error(`没有捕获到 ${id}`);
      for (const rule of theme.rules) {
        if (isKojo2(rule.token)) continue;
        expect(
          darkForegrounds.has(rule.foreground?.toLowerCase()),
          `${id}/${rule.token} 复用了暗色前景 #${rule.foreground}`,
        ).toBe(false);
      }
    }
  });
});

/* 编译期钉子：主题层联合与 UI 层 ThemePref 必须双向同形（任一侧加档/改名都编译失败） */
type SameUnion<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

const THEME_PREF_SHAPE: SameUnion<ThemePref, MonacoThemePref> = true;
void THEME_PREF_SHAPE;
