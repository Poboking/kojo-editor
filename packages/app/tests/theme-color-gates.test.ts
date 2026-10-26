import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import {
  KOJO2_DARK_THEME_ID,
  KOJO2_LIGHT_THEME_ID,
  KOJO2_MINT_DARK_THEME_ID,
  KOJO2_THEMES,
} from '../src/monaco/kojo2-theme';
import { KOJO2_TOKEN } from '../src/monaco/kojo-theme-rules';
import {
  KOJO_DARK_COLORS,
  KOJO_LIGHT_COLORS,
  KOJO_MINT_COLORS,
  defineMonacoThemes,
} from '../src/monaco/theme';

/**
 * 主题色闸（2026-10-26 色值批）——判据对象是**主题内全部生效规则**，不是某一族。
 *
 * 为什么另开一道闸：原先三处判据各量各的半张表，三处都能"绿"而屏上是花的——
 *  - `kojo-token-tiers.test.ts` 只量糖的 13 个档位，且拿 vs-dark 基底 `#1e1e1e` 当底
 *    （真底是主题自己的 `editor.background`）；
 *  - `kojo2-theme.test.ts` 只量 2.0 单族的 12/13 色；
 *  - 合并视图（v1 32 档 + 2.0 16 档 = 48 条规则同一屏）里**跨族撞色**正是前者都看不见的
 *    那一段：原读数 kojo-mint-dark 10 对、kojo-light 8 对、kojo-dark 5 对 CIE76 ΔE < 12，
 *    最小 4.4（`c9a7f5` vs `d6acff`）。
 *
 * 本文件钉四件事（flag 开 = 双轨期真实装配态）：
 * 1. **可读**：48 条规则每一档对主题自己的 `editor.background` 对比度 ≥ 4.5；
 * 2. **不撞色**：主题内去重后的前景两两 CIE76 ΔE ≥ 12（撞色 = 假分层）；
 * 3. **跨语言同义档同色**：同一段源文本被两门语法同时着色的五组（`「」`/`：` 标点、
 *    台词正文、字符串字面量、注释、原生直通）在 v1 与 2.0 两侧必须**逐字同色**——
 *    这是 `theme.ts` 头注写死的承诺（"同一枚 `「` 在两门语言里必须同色"），
 *    此前只是注释里的散文：v1 `7f9cc0` vs 2.0 `8be9fd`，ΔE 32。
 *    为什么只收这五组：它们是**同一段源文本**被两条语法各发一枚 token（同一枚 `「`、
 *    同一段台词、同一个字符串、同一行注释、同一行原生）；保留词 / 运算符 / 数字在两门
 *    语言里的字形本就不同（`由` vs `IF`、`不在` vs `!=`），不强求同色。
 * 4. **部件色同族同源**：`kojo2-*` 与 `kojo-*` 同一主题族的 `colors` 键集相等、值逐键相等、
 *    缺键 0（2.0 此前只有 32 键，`inherit: false` 下漏列的 59 键掉回 Monaco 默认色）。
 *
 * 度量公式照抄 `kojo2-theme.test.ts:71-113`（不另发明口径）。
 */

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
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76 色差 */
function deltaE(a: string, b: string): number {
  const p = toLab(a);
  const q = toLab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/* ============================== 装配：flag 开 = 双轨期真实态 ============================== */

interface CapturedTheme {
  readonly rules: Monaco.editor.ITokenThemeRule[];
  readonly colors: Record<string, string>;
  readonly inherit?: boolean;
}

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

/** 真装配（不自己拼规则数组）：`defineMonacoThemes` 同步定义 v1 三套，flag 开时尾部带 2.0 规则 */
function captureMergedThemes(): Map<string, CapturedTheme> {
  stubFlag(true);
  const themes = new Map<string, CapturedTheme>();
  const monaco = {
    editor: {
      defineTheme: (id: string, theme: CapturedTheme): void => {
        themes.set(id, theme);
      },
    },
    languages: {},
  } as unknown as typeof Monaco;
  defineMonacoThemes(monaco);
  return themes;
}

const THEMES = captureMergedThemes();

const THEME_IDS = ['kojo-dark', 'kojo-light', 'kojo-mint-dark'] as const;

/** v1 基线 32 条（词法 12 + 糖 15 + 语义 5）；其余是 2.0 的 16 条
 * （2026-10-27 第三色批：词法基线 +`support.type`、2.0 +`kojo2.type`，两枚同色） */
const V1_RULE_COUNT = 32;
const ALL_RULE_COUNT = 48;

function themeOf(id: string): CapturedTheme {
  const theme = THEMES.get(id);
  if (!theme) throw new Error(`没有捕获到 ${id}（装配面漂 = 本文件整个红）`);
  return theme;
}

function foregroundByToken(theme: CapturedTheme): Map<string, string> {
  const map = new Map<string, string>();
  for (const rule of theme.rules) {
    if (rule.foreground === undefined) throw new Error(`${rule.token} 没有前景色`);
    if (map.has(rule.token)) throw new Error(`${rule.token} 在主题里出现了两次`);
    map.set(rule.token, rule.foreground);
  }
  return map;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ============================== ① 可读性 ============================== */

describe('主题内全部生效规则：对主题自己的 editor.background ≥ 4.5', () => {
  it('三套都真的合并了 48 条（32 v1 + 16 2.0），一个 kojo2 都不少（反假绿地板）', () => {
    for (const id of THEME_IDS) {
      const theme = themeOf(id);
      expect(theme.rules.length, `${id} 规则数`).toBe(ALL_RULE_COUNT);
      expect(theme.rules.filter((rule) => rule.token.startsWith('kojo2.')).length, id).toBe(
        ALL_RULE_COUNT - V1_RULE_COUNT,
      );
      expect(theme.inherit ?? false, `${id} 必须 inherit:false`).toBe(false);
    }
  });

  it.each(THEME_IDS)('%s：逐档点名（48 条）', (id) => {
    const theme = themeOf(id);
    const background = theme.colors['editor.background']!.slice(1);
    const weak = theme.rules
      .map((rule) => ({ token: rule.token, fg: rule.foreground!, ratio: contrast(rule.foreground!, background) }))
      .filter((row) => row.ratio < 4.5)
      .map((row) => `${row.token}=#${row.fg} ${row.ratio.toFixed(2)}`);
    expect(
      weak.join('\n'),
      `${id} 在 #${background} 上有 ${weak.length} 档对比度 < 4.5：\n${weak.join('\n')}`,
    ).toBe('');
  });
});

/* ============================== ② 不撞色 ============================== */

describe('主题内任意两档前景 CIE76 ΔE ≥ 12（撞色 = 假分层）', () => {
  it.each(THEME_IDS)('%s：去重后两两（读数逐条列在失败信息里）', (id) => {
    const theme = themeOf(id);
    const byColor = new Map<string, string[]>();
    for (const rule of theme.rules) {
      const list = byColor.get(rule.foreground!) ?? [];
      list.push(rule.token);
      byColor.set(rule.foreground!, list);
    }
    const colors = [...byColor.keys()];
    const collisions: string[] = [];
    for (let i = 0; i < colors.length; i += 1) {
      for (let j = i + 1; j < colors.length; j += 1) {
        const d = deltaE(colors[i]!, colors[j]!);
        if (d < 12) {
          collisions.push(
            `#${colors[i]}（${byColor.get(colors[i]!)!.join(' / ')}）↔ #${colors[j]}（${byColor.get(colors[j]!)!.join(' / ')}）ΔE=${d.toFixed(1)}`,
          );
        }
      }
    }
    expect(
      collisions.join('\n'),
      `${id} 有 ${collisions.length} 对撞色（共 ${colors.length} 枚独立色）：\n${collisions.join('\n')}`,
    ).toBe('');
  });
});

/* ============================== ③ 跨语言同义档 ============================== */

/**
 * 五组"同一段源文本被两门语法各发一枚 token"的同义档。v1 侧是糖/基线 token，
 * 2.0 侧是 `kojo2.*`；两侧在**每一套主题**里都必须逐字同色。
 */
const SYNONYM_GROUPS: readonly { readonly v1: readonly string[]; readonly k2: string; readonly why: string }[] = [
  {
    v1: ['sugar.speech.delimiter', 'sugar.colon'],
    k2: KOJO2_TOKEN.delimiter,
    why: '同一枚 `「`（`：`）—— `theme.ts` 头注写死的承诺',
  },
  { v1: ['sugar.speech'], k2: KOJO2_TOKEN.speech, why: '台词正文' },
  { v1: ['string'], k2: KOJO2_TOKEN.string, why: '字符串字面量' },
  { v1: ['comment'], k2: KOJO2_TOKEN.comment, why: '整行注释' },
  { v1: ['keyword.raw'], k2: KOJO2_TOKEN.raw, why: '整行原生直通' },
];

describe('跨语言同义档：同一段文本在两门语言里同色', () => {
  it('五组都登记在表里（防"表空了也算绿"）', () => {
    expect(SYNONYM_GROUPS.length).toBe(5);
  });

  it.each(THEME_IDS)('%s：五组逐字同色', (id) => {
    const theme = themeOf(id);
    const fg = foregroundByToken(theme);
    const bad: string[] = [];
    for (const group of SYNONYM_GROUPS) {
      const k2 = fg.get(group.k2);
      expect(k2, `${id} 缺 ${group.k2}`).toBeDefined();
      for (const token of group.v1) {
        const v1 = fg.get(token);
        expect(v1, `${id} 缺 ${token}`).toBeDefined();
        if (v1 !== k2) {
          bad.push(
            `${token}=#${v1} vs ${group.k2}=#${k2}（ΔE=${deltaE(v1!, k2!).toFixed(1)}）—— ${group.why}`,
          );
        }
      }
    }
    expect(bad.join('\n'), `${id} 的同义档不同色：\n${bad.join('\n')}`).toBe('');
  });
});

/* ============================== ③b 第三色档：两门语言同色 ============================== */

/**
 * 类型 / 结构名（2026-10-27 第三色批）。
 *
 * 这一组**不在**上面那五组里——五组的判据是"同一段源文本被两条语法各发一枚 token"，
 * 而 v1 侧的 `support.type` 打的是 `.ERB` 的 `#DIM` 型/存储限定词、2.0 侧的 `kojo2.type`
 * 打的是 `# 表`/`# 池`/`# 模` 头与类型词，**字形不同、语义同一档**。所以这里判的是
 * "同一类东西同一个色"那一半承诺：两门语言的"类型"在每一套主题里必须逐字同色，
 * 不许出现"ERB 的 olive 与 2.0 的另一种绿"。
 */
describe('第三色档：v1 `support.type` 与 2.0 `kojo2.type` 每套主题逐字同色', () => {
  it.each(THEME_IDS)('%s：两枚都在，且色值相等', (id) => {
    const fg = foregroundByToken(themeOf(id));
    const v1 = fg.get('support.type');
    const k2 = fg.get(KOJO2_TOKEN.type);
    expect(v1, `${id} 缺 v1 侧 support.type 的前景`).toBeDefined();
    expect(k2, `${id} 缺 2.0 侧 kojo2.type 的前景`).toBeDefined();
    expect(k2, `${id}: support.type=#${v1} 与 kojo2.type=#${k2} 漂移`).toBe(v1);
    expect(v1).toMatch(/^[0-9a-fA-F]{6}$/);
  });
});

/* ============================== ④ 部件色同族同源 ============================== */

const COLOR_FAMILIES: readonly {
  readonly v1: string;
  readonly k2: string;
  readonly table: Readonly<Record<string, string>>;
}[] = [
  { v1: 'kojo-dark', k2: KOJO2_DARK_THEME_ID, table: KOJO_DARK_COLORS },
  { v1: 'kojo-light', k2: KOJO2_LIGHT_THEME_ID, table: KOJO_LIGHT_COLORS },
  { v1: 'kojo-mint-dark', k2: KOJO2_MINT_DARK_THEME_ID, table: KOJO_MINT_COLORS },
];

describe('部件色：同一主题族里 v1 与 2.0 共有键逐字相等、缺键 0', () => {
  it('键表不少于 80 键（反假绿地板：补齐后的规模线，旧 2.0 表只有 32 键）', () => {
    for (const family of COLOR_FAMILIES) {
      expect(Object.keys(family.table).length, family.v1).toBeGreaterThanOrEqual(80);
    }
  });

  it.each(COLOR_FAMILIES.map((family) => ({ name: family.v1, ...family })))(
    '$name：键集相等、值逐键相等',
    ({ v1, k2, table }) => {
      const merged = themeOf(v1).colors;
      const kojo2 = KOJO2_THEMES[k2 as keyof typeof KOJO2_THEMES].colors!;
      const mergedKeys = Object.keys(merged).sort();
      const kojo2Keys = Object.keys(kojo2).sort();
      // 缺键 0（两个方向都查：v1 有的 2.0 必须有，反之亦然）
      expect(kojo2Keys, `${k2} 缺键：${mergedKeys.filter((key) => !kojo2Keys.includes(key)).join(', ')}`).toEqual(mergedKeys);
      const diff = mergedKeys
        .filter((key) => kojo2[key] !== merged[key])
        .map((key) => `${key}: v1=${merged[key]} / 2.0=${kojo2[key]}`);
      expect(diff.join('\n'), `${k2} 与 ${v1} 的共有键值不等：\n${diff.join('\n')}`).toBe('');
      // 与导出的 v1 原表也逐键相等（"复用同一批 values"不是复制）
      expect(Object.entries(kojo2).sort()).toEqual(Object.entries(table).sort());
    },
  );
});
