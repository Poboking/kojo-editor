/**
 * Kojo 2.0 的 **主题面数据**（K2-CUTOVER-PRE / K2-CUTOVER-THEME；LAU-2 起按语义角色铺色；
 * **SDK B4 起住在 `@kojo/kojo-lang`**：三套 `kojo2-*` 的身份、角色规则与作者面分类表都在这里，
 * 由 `@kojo/plugin-kojo-lang` 经槽 `ui.monaco.language` 交出，宿主落 `editor.defineTheme`）。
 *
 * ## 与六套 `kojo-*` 主题的关系
 *
 * Monaco 主题是进程级的，双轨期同一个窗口只能有一个主题名。真正让"2.0 文件在 v1 主题下
 * 也正确上色"的做法不是切主题，而是**同一批角色规则**：宿主的六套主题与这里的三套
 * `kojo2-*` 读的是 `theme-rules.ts` 的**同一批规则对象**（`ROLE_THEME_RULES` /
 * `ROLE_LIGHT_THEME_RULES` / `ROLE_MINT_THEME_RULES`），不各配一套色。本文件保留三套独立
 * 主题（显式切换 / 对照 / 将来的发布态用）。
 *
 * ## 角色表是单一真源（LAU-2）
 *
 * 档位名（`KOJO2_TOKEN`：锚点 / 声明词 / 台词 …，作者面口径）→ **语义角色**
 * （`semantic-roles.ts` 的 `ROLE.*`）→ 三套主题各一枚色（`theme-rules.ts` 的三张角色调色板）。
 * 本文件只做后两步的拼装：{@link KOJO2_THEME_TOKEN_MAP} 是"角色 → 三侧样式"的索引，
 * 任一侧少一格 / 多一格在**模块加载期**当场抛（与宿主的构建器同一纪律：
 * 少配一档在加载期变红，而不是静默掉色）。`kojo2-theme.test.ts` 再用规则表与
 * `SEMANTIC_ROLES` 双向交叉断言，防将来漂移。
 *
 * ## 取色口径
 *
 * - **暗**：`ROLE_THEME_RULES`（与 `kojo-dark` 逐字同色，底色同为 `#1e2227`）；
 * - **亮**：`ROLE_LIGHT_THEME_RULES`（`#f6f8fa`）；
 * - **墨绿**：`ROLE_MINT_THEME_RULES`（`#0f1713`）。
 * 三套都不 `inherit`（不从基底借色，切主题不残留上一套的 token 色）。
 *
 * ## 部件色不在这里（B4 的分工）
 *
 * 三套主题的 `colors`（91 键的 `editor.*` / `menu.*` / 浮层 / 滚动条那一族）是**编辑器 chrome**，
 * 六套主题共用同一批 values（2026-10-26 部件色批：同一主题族里 v1 与 2.0 逐键相等、缺键 0，
 * 闸见 `theme-color-gates.test.ts`）。语言包抄一份就是第七份色表，所以这里只声明
 * **侧名**（{@link Kojo2ThemeSurfaceData.componentPalette}：dark / light / mint），
 * 由宿主装配时取自己那一侧的部件色。`wordPattern` 同一口径。
 *
 * 硬指标（`theme-color-gates.test.ts` / `kojo2-theme.test.ts` 复跑）：每档前景对主题自己的
 * `editor.background` 对比度 ≥ 4.5；**主题内全部生效规则**（34 档角色）两两 CIE76 ΔE ≥ 12
 * （"看起来两档其实一色"是假分层）；跨语言同义档（`「」` 标点 / 台词 / 字面 / 注释 / 原生 /
 * 类型）在两门语言里落**同一个角色**，因此天然同色。
 */

import {
  ROLE_LIGHT_THEME_RULES,
  ROLE_MINT_THEME_RULES,
  ROLE_THEME_RULES,
} from './theme-rules';
import {
  ROLE,
  SEMANTIC_ROLES,
  type KojoTokenThemeRule,
  type SemanticRole,
} from './semantic-roles';

/* ============================== 三套主题的身份 ============================== */

/** 2.0 暗色主题 id（与 v1 的 `kojo-dark` 并存，双轨期各服务各的文件） */
export const KOJO2_DARK_THEME_ID = 'kojo2-dark';

/** 2.0 亮色主题 id */
export const KOJO2_LIGHT_THEME_ID = 'kojo2-light';

/** 2.0 墨绿暗色主题 id（墨绿角色调色板 + 墨绿底） */
export const KOJO2_MINT_DARK_THEME_ID = 'kojo2-mint-dark';

/** 全部 2.0 主题 id（注册顺序 = 数组序；测试按此断言"三套都在"） */
export const KOJO2_THEME_IDS = [
  KOJO2_DARK_THEME_ID,
  KOJO2_LIGHT_THEME_ID,
  KOJO2_MINT_DARK_THEME_ID,
] as const;

export type Kojo2ThemeId = (typeof KOJO2_THEME_IDS)[number];

/** 与 `ui/theme-pref.ts` / `monaco/theme.ts` 逐字同形的偏好三档（本模块不 import 那个 UI 模块） */
export type Kojo2ThemePref = 'dark' | 'light' | 'mint-dark';

const KOJO2_THEME_ID_BY_PREF: Readonly<Record<Kojo2ThemePref, Kojo2ThemeId>> = {
  dark: KOJO2_DARK_THEME_ID,
  light: KOJO2_LIGHT_THEME_ID,
  'mint-dark': KOJO2_MINT_DARK_THEME_ID,
};

/**
 * 偏好 → 2.0 主题 id（未知/脏值回缺省暗色，**绝不抛**；与 `monacoThemeIdFor` 同口径）。
 *
 * 存在的意义：宿主的主题偏好只有 `dark` / `light` / `mint-dark` 三格，接 2.0 面时不必在
 * 每个调用点写一遍映射，也不会因为多了一档而漏配。
 */
export function kojo2ThemeIdFor(pref: Kojo2ThemePref): Kojo2ThemeId {
  return KOJO2_THEME_ID_BY_PREF[pref] ?? KOJO2_DARK_THEME_ID;
}

/* ============================== 角色 → 颜色映射 ============================== */

/** 一档角色的样式（前景色 + 字体样式；与主题规则 {@link KojoTokenThemeRule} 同源） */
export interface Kojo2TokenStyle {
  readonly foreground: string;
  readonly fontStyle?: 'bold' | 'italic';
}

/** 主题三侧（暗 / 亮 / 墨绿；三侧各有一张角色调色板，不再复用暗色侧） */
export type Kojo2TokenThemeSide = 'dark' | 'light' | 'mint';

/** 把规则表的 `fontStyle` 收窄成本模块允许的两档（越界即抛） */
function toStyle(rule: KojoTokenThemeRule): Kojo2TokenStyle {
  const foreground = rule.foreground;
  if (foreground === undefined || !/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(foreground)) {
    throw new Error(`[kojo2-theme] 角色「${rule.token}」没有合法的前景色：${String(foreground)}`);
  }
  const fontStyle = rule.fontStyle;
  if (fontStyle === undefined) return { foreground };
  if (fontStyle !== 'bold' && fontStyle !== 'italic') {
    throw new Error(`[kojo2-theme] 角色「${rule.token}」的 fontStyle 不受支持：${fontStyle}`);
  }
  return { foreground, fontStyle };
}

/**
 * 把一张规则表按角色收成样式索引；重复角色 = 表本身写错了（加载期抛，不静默后者覆盖）。
 */
function indexRules(
  rules: readonly KojoTokenThemeRule[],
  label: string,
): Map<string, Kojo2TokenStyle> {
  const byToken = new Map<string, Kojo2TokenStyle>();
  for (const rule of rules) {
    if (byToken.has(rule.token)) {
      throw new Error(`[kojo2-theme] ${label}规则里角色「${rule.token}」出现了两次`);
    }
    byToken.set(rule.token, toStyle(rule));
  }
  return byToken;
}

/**
 * 组装角色 → 三套样式（暗 / 亮 / 墨绿）；三侧都必须与叶子的规则表**逐格同源**。
 *
 * 校验顺序：先按 `SEMANTIC_ROLES` 逐角色取三侧规则（缺 = 抛），再反向查三张表有没有
 * 未登记的角色（多 = 抛）。这样"角色表加了新角色忘了配色"与"配了色但角色表里没有"
 * 两个方向都在导入期变红。
 */
function buildTokenMap(): Readonly<
  Record<SemanticRole, Readonly<Record<Kojo2TokenThemeSide, Kojo2TokenStyle>>>
> {
  const bySide: Readonly<Record<Kojo2TokenThemeSide, Map<string, Kojo2TokenStyle>>> = {
    dark: indexRules(ROLE_THEME_RULES, '暗色'),
    light: indexRules(ROLE_LIGHT_THEME_RULES, '亮色'),
    mint: indexRules(ROLE_MINT_THEME_RULES, '墨绿'),
  };
  const tableName: Readonly<Record<Kojo2TokenThemeSide, string>> = {
    dark: 'ROLE_THEME_RULES',
    light: 'ROLE_LIGHT_THEME_RULES',
    mint: 'ROLE_MINT_THEME_RULES',
  };

  const map = {} as Record<
    SemanticRole,
    Readonly<Record<Kojo2TokenThemeSide, Kojo2TokenStyle>>
  >;
  for (const role of SEMANTIC_ROLES) {
    const styles = {} as Record<Kojo2TokenThemeSide, Kojo2TokenStyle>;
    for (const side of ['dark', 'light', 'mint'] as const) {
      const style = bySide[side].get(role);
      if (style === undefined) {
        throw new Error(`[kojo2-theme] 角色「${role}」在 ${tableName[side]} 里没有配色`);
      }
      styles[side] = style;
    }
    map[role] = styles;
  }
  const known = Object.keys(map).length;
  for (const side of ['dark', 'light', 'mint'] as const) {
    if (bySide[side].size !== known) {
      throw new Error(
        `[kojo2-theme] ${tableName[side]} 里有 ${bySide[side].size - known} 档未在 SEMANTIC_ROLES 登记`,
      );
    }
  }
  return map;
}

/**
 * 角色 → 三套主题的样式（暗 / 亮 / 墨绿）。
 *
 * 键集合**必须**等于 `SEMANTIC_ROLES`：三侧都从叶子的角色调色板派生；任一缺格 / 多格在
 * 模块加载期抛。
 */
export const KOJO2_THEME_TOKEN_MAP: Readonly<
  Record<SemanticRole, Readonly<Record<Kojo2TokenThemeSide, Kojo2TokenStyle>>>
> = buildTokenMap();

/**
 * 作者面的**分类口径**：五锚点 / 声明名 / 对话三层各自归哪些角色。
 *
 * 这不是第二份配色表（颜色只在上面的映射里），而是"主题到底覆盖了哪几类东西"的验收清单：
 * 设置页 / 配色文档 / 测试都从这里取，避免"以为锚点单独一色"这类误解——词法对五锚点
 * 只发一个 `role.anchor`（`#`/`@`/`>`/`?`/`!` 不再细分，改细分是词法的事，不是主题的事）。
 */
export interface Kojo2ThemeCategory {
  readonly category: '锚点' | '声明名' | '对话';
  readonly tokens: readonly SemanticRole[];
  readonly note: string;
}

export const KOJO2_THEME_CATEGORIES: readonly Kojo2ThemeCategory[] = [
  {
    category: '锚点',
    tokens: [ROLE.anchor],
    note: '五锚点 `# @ > ? !` 共用一档（词法只发 role.anchor；行首转义 `\\` 同档）',
  },
  {
    category: '声明名',
    tokens: [ROLE.declaration],
    note: '`#` 后的声明词 / `@` 后的调度词 / `!` 后的被调名',
  },
  {
    category: '对话',
    tokens: [ROLE.speaker, ROLE.speech, ROLE.string, ROLE.interpAlt, ROLE.hint, ROLE.punctuation],
    note: '`角色：「…」` 的说话人与台词两层，外加插值 / 行尾表演提示 / 「」标点',
  },
];

/* ============================== 主题面数据（契约的 `themes` 那一副） ============================== */

/**
 * 一套 2.0 主题的语言面声明（与契约 `MonacoThemeContributionData` 同形）。
 *
 * 这里给的是**规则与身份**，不是 Monaco 的 `IStandaloneThemeData`：缺 `colors` 那一格，
 * 由宿主按 {@link Kojo2ThemeSurfaceData.componentPalette} 取同侧部件色补齐
 * （拷贝 + 逐键校验都住在宿主落点，理由见文件头"部件色不在这里"）。
 */
export interface Kojo2ThemeSurfaceData {
  readonly id: string;
  readonly base: 'vs' | 'vs-dark';
  readonly inherit: false;
  readonly rules: readonly KojoTokenThemeRule[];
  readonly componentPalette: Kojo2TokenThemeSide;
}

/**
 * 2.0 暗色主题（`vs-dark` 基底、不继承）。
 *
 * `rules` 是 `ROLE_THEME_RULES` 的**浅拷贝**（元素同对象）：顶层数组交给 Monaco 时要可写，
 * 但每一格不重造——暗色真源只有一份，v1 的 `kojo-dark` 铺的就是同一批对象。
 */
export const kojo2DarkTheme: Kojo2ThemeSurfaceData = {
  id: KOJO2_DARK_THEME_ID,
  base: 'vs-dark',
  inherit: false,
  rules: [...ROLE_THEME_RULES],
  componentPalette: 'dark',
};

/** 2.0 亮色主题（`vs` 基底、不继承；角色规则 = `ROLE_LIGHT_THEME_RULES` 浅拷贝） */
export const kojo2LightTheme: Kojo2ThemeSurfaceData = {
  id: KOJO2_LIGHT_THEME_ID,
  base: 'vs',
  inherit: false,
  rules: [...ROLE_LIGHT_THEME_RULES],
  componentPalette: 'light',
};

/** 2.0 墨绿暗色主题（角色规则 = `ROLE_MINT_THEME_RULES`；底色 `#0f1713`） */
export const kojo2MintDarkTheme: Kojo2ThemeSurfaceData = {
  id: KOJO2_MINT_DARK_THEME_ID,
  base: 'vs-dark',
  inherit: false,
  rules: [...ROLE_MINT_THEME_RULES],
  componentPalette: 'mint',
};

/** 主题 id → 声明（注册器与测试共用一张表；顺序与 {@link KOJO2_THEME_IDS} 一致） */
export const KOJO2_THEMES: Readonly<Record<Kojo2ThemeId, Kojo2ThemeSurfaceData>> = {
  [KOJO2_DARK_THEME_ID]: kojo2DarkTheme,
  [KOJO2_LIGHT_THEME_ID]: kojo2LightTheme,
  [KOJO2_MINT_DARK_THEME_ID]: kojo2MintDarkTheme,
};

/** 三套主题的**注册序**（供方交出的数组顺序 = 这张表；宿主按此定义，不重排） */
export const KOJO2_THEME_SURFACES: readonly Kojo2ThemeSurfaceData[] = Object.freeze(
  KOJO2_THEME_IDS.map((id) => KOJO2_THEMES[id]),
);
