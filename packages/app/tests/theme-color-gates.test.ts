import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
// B4：三套 `kojo2-*` 的**声明**（id / base / 角色规则 / 部件色侧名）在语言面库，
// `colors` 那一格由宿主落点按侧名补齐——本闸量的正是补完之后的一半（v1 与 2.0 同族逐键相等）。
import {
  KOJO2_DARK_THEME_ID,
  KOJO2_LIGHT_THEME_ID,
  KOJO2_MINT_DARK_THEME_ID,
  KOJO2_THEMES,
} from '@kojo/kojo-lang/monaco-theme';
import { materializeMonacoTheme } from '../src/monaco/monaco-language-surface';
import { KOJO2_TOKEN, SEMANTIC_ROLES, roleForLegacyToken } from '@kojo/kojo-sdk/semantic-roles';
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
 * 1. **可读**：39 条规则每一档对主题自己的 `editor.background` 对比度 ≥ 4.5；
 * 2. **不撞色**：主题内去重后的前景两两 CIE76 ΔE ≥ 12（撞色 = 假分层）；
 * 3. **跨语言同义档同色**：同一段源文本被两门语法同时着色的五组（`「」`/`：` 标点、
 *    台词正文、字符串字面量、注释、原生直通）在 v1 与 2.0 两侧必须**逐字同色**——
 *    这是 `theme.ts` 头注写死的承诺（"同一枚 `「` 在两门语言里必须同色"），
 *    此前只是注释里的散文：v1 `7f9cc0` vs 2.0 `8be9fd`，ΔE 32。
 *    为什么只收这五组：它们是**同一段源文本**被两条语法各发一枚 token（同一枚 `「`、
 *    同一段台词、同一个字符串、同一行注释、同一行原生）；保留词 / 运算符 / 数字在两门
 *    语言里的字形本就不同（`依据` vs `IF`、`不在` vs `!=`），不强求同色。
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

/**
 * 本文件量的是**六套**主题（2026-10-27 经典编辑器色批的 one-dark / rose-pine / synthwave84
 * 也一并纳入——它们同样是 48 条规则：12 词法 + 15 糖 + 5 语义 + 16 的 2.0 规则，
 * 只是装配走"一张 48 键表"而不是四张分表）。加档时这张表要与 `ui/theme-pref.ts` 的
 * `THEME_IDS` 手动同步——它是**Monaco 侧 id**，与 pref 名不同形，故不直接 import。
 */
const THEME_IDS = [
  'kojo-dark',
  'kojo-light',
  'kojo-mint-dark',
  'kojo-one-dark',
  'kojo-rose-pine',
  'kojo-synthwave84',
] as const;

/** 34 档角色 + 名字层 5 条（D6）= 39 条规则（LAU-2 收口前是 32 v1 + 16 2.0 = 48 条）。
 * 收口只改命名与形状，不改色：逐档色值由 `semantic-roles.test.ts` 拿改前快照钉住。 */
const ROLE_RULE_COUNT = SEMANTIC_ROLES.length;
const NAME_LAYER_RULE_COUNT = 5;
const ALL_RULE_COUNT = ROLE_RULE_COUNT + NAME_LAYER_RULE_COUNT;

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
  it('六套都真的铺满 39 条（34 角色 + 5 名字层），一个角色都不少（反假绿地板）', () => {
    for (const id of THEME_IDS) {
      const theme = themeOf(id);
      expect(theme.rules.length, `${id} 规则数`).toBe(ALL_RULE_COUNT);
      expect(theme.rules.filter((rule) => rule.token.startsWith('role.')).length, id).toBe(ROLE_RULE_COUNT);
      expect(theme.rules.filter((rule) => !rule.token.startsWith('role.')).length, id).toBe(NAME_LAYER_RULE_COUNT);
      expect(theme.inherit ?? false, `${id} 必须 inherit:false`).toBe(false);
    }
  });

  it.each(THEME_IDS)('%s：逐档点名（39 条）', (id) => {
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
 * 六组"同一段源文本被两门语法各发一枚 token"的同义档。LAU-2 起它们**落同一个角色**
 * （`semantic-roles.ts` 的别名表），于是"同色"是结构性的，不再是三处各配一遍色的巧合：
 * - `「」` / `：` 标点、台词正文、字符串字面量、整行注释、整行原生直通、类型 / 结构名。
 *
 * 判据分两层：①两枚旧名解析到**同一角色**（结构）；②该角色在每一套主题里只有一条规则
 * （`semantic-roles.test.ts` 的"每套每角色一条"），于是取值唯一 ⇒ 必然同色。
 * 旧名清单本身就是这张表的取证面，故此处允许出现旧名。
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
  { v1: ['support.type'], k2: KOJO2_TOKEN.type, why: '类型 / 结构名（字形不同、语义同一档）' },
];

describe('跨语言同义档：同一段文本在两门语言里落同一角色（因此同色）', () => {
  it('六组都登记在表里（防"表空了也算绿"）', () => {
    expect(SYNONYM_GROUPS.length).toBe(6);
  });

  it.each(THEME_IDS)('%s：六组都落同一角色，且该角色只有一条规则', (id) => {
    const fg = foregroundByToken(themeOf(id));
    const bad: string[] = [];
    for (const group of SYNONYM_GROUPS) {
      expect(fg.get(group.k2), `${id} 缺 ${group.k2}`).toBeDefined();
      for (const token of group.v1) {
        const role = roleForLegacyToken(token);
        if (role === undefined) {
          bad.push(`${token} 在别名表里没有角色`);
          continue;
        }
        if (role !== group.k2) bad.push(`${token} → ${role}，2.0 侧是 ${group.k2}（${group.why}）`);
        if (fg.get(role) !== fg.get(group.k2)) bad.push(`${token} → ${role} 的两侧取色不一致`);
      }
    }
    expect(bad.join('\n'), `${id} 的同义档没落在同一角色：\n${bad.join('\n')}`).toBe('');
  });
});

/* ============================== ③b 类型档：两门语言同一角色 ============================== */

/**
 * 类型 / 结构名（2026-10-27 第三色批；LAU-2 收成同一角色）。
 *
 * v1 侧的 `support.type` 打的是 `.ERB` 的 `#DIM` 型/存储限定词、2.0 侧的 `kojo2.type` 打的是
 * `# 对照表`/`# 池`/`# 模` 头与类型词，**字形不同、语义同一档**。"同一类东西同一个色"这条承诺
 * 现在由别名表结构性保证：两枚旧名解析到同一个 `role.type`，故每一套主题里必然同色。
 */
describe('类型档：v1 `support.type` 与 2.0 `kojo2.type` 每套主题落同一角色、同色', () => {
  it.each(THEME_IDS)('%s：两枚都在，且解析到同一角色、同色', (id) => {
    const fg = foregroundByToken(themeOf(id));
    const v1Role = roleForLegacyToken('support.type');
    const k2Role = KOJO2_TOKEN.type; // 2.0 侧这一步已经是角色（KOJO2_TOKEN 的值即角色）
    expect(v1Role, `${id} 缺 v1 侧 support.type 的角色`).toBeDefined();
    expect(k2Role, `${id} 缺 2.0 侧 kojo2.type 的角色`).toBeDefined();
    expect(k2Role, `${id}: support.type → ${v1Role} 与 kojo2.type → ${k2Role} 漂移`).toBe(v1Role);
    expect(fg.get(v1Role!), `${id} 主题里缺 ${v1Role} 的规则`).toMatch(/^[0-9a-fA-F]{6}$/);
  });
});

/* ============================== ④ 部件色同族同源 ============================== */

/**
 * 部件色同族同源只对**有 2.0 版本**的三族成立（语言面库 `monaco-theme.ts` 目前只声明三套，
 * 与 v1 三套一一对应；`colors` 由宿主落点按 `componentPalette` 侧名补，本闸就是钉这一步
 * 补齐之后没有漂）。新三套（one-dark / rose-pine / synthwave84）没有 `kojo2-*` 孪生，
 * 因此不在这张表里——它们的部件色由 `buildColors()` 统一生成（取值逻辑三套相同），
 * 一致性由生成器保证，不需要这道"v1 与 2.0 逐键相等"的闸。
 */
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
      const kojo2 = materializeMonacoTheme(KOJO2_THEMES[k2 as keyof typeof KOJO2_THEMES]).colors;
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
