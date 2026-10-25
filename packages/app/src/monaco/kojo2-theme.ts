/**
 * Kojo 2.0 的 **Monaco 主题**（K2-CUTOVER-PRE / K2-CUTOVER-THEME）：五锚点 / 声明名 / 对话各归各色，
 * 亮暗两套 + 墨绿变体，`rules` 与 `kojo2-language.ts` 的 token 名**逐字同源**。
 *
 * ## 与 v1 三套主题的关系（K2-CUTOVER-THEME 后）
 *
 * Monaco 主题是进程级的，双轨期同一个窗口只能有一个主题名。真正让"`.kojo2` 文件在 v1 主题下
 * 也正确上色"的做法不是切主题，而是**把 2.0 的 token 规则并进 `kojo-dark` / `kojo-light` /
 * `kojo-mint-dark`**——那件事住在 `theme.ts`（flag 守卫，规则数据取自 `kojo-theme-rules.ts`）。
 * 本文件继续保留 `kojo2-*` 三套**独立主题**（显式切换 / 对照 / 将来的发布态用），
 * 两处读的是同一批规则对象，不各配一套色。
 *
 * ## token 名的单一真源
 *
 * token 名与三套（暗 / 亮 / 墨绿）规则表的**定义处**是零 import 叶子 `kojo-theme-rules.ts`
 * （`KOJO2_TOKEN` / `KOJO2_THEME_RULES` / `KOJO2_LIGHT_THEME_RULES` /
 * `KOJO2_MINT_THEME_RULES`）；本文件只按 `KOJO2_TOKEN` 建 token → 样式的映射。任何一侧
 * 少一格 / 多一格，{@link KOJO2_THEME_TOKEN_MAP} 在**模块加载期**当场抛（与 `theme.ts` 的
 * `retint` 同一纪律：少配一档在加载期变红，而不是静默掉色）。`kojo2-theme.test.ts` 再用
 * 规则表与 `KOJO2_TOKEN` 双向交叉断言，防将来漂移。
 *
 * ## 取色口径
 *
 * - **暗**：原样沿用叶子里的 `KOJO2_THEME_RULES`（不重定义、不改一个色值），
 *   底色取 app 的 `--bg` `#1e2227`（与 `kojo-dark` 同底，切过来不跳）；
 * - **亮**：叶子里的 `KOJO2_LIGHT_THEME_RULES`（2026-10-26 批：八档同义档落到 v1 亮色盘
 *   同名档，锚点品红 / 声明靛两档自带，理由见该表头注；紫=声明、棕=说话人、绿=台词、
 *   蓝=旁白、红=提示、钢蓝=标点）；
 * - **墨绿**：叶子里的 `KOJO2_MINT_THEME_RULES`（逐档落到墨绿盘既有的语义近邻色）
 *   + 墨绿底 `#0f1713`（与 `kojo-mint-dark` 同底）。
 * 三套都不 `inherit`（不从基底借色，切主题不残留上一套的 token 色）。
 *
 * **部件色不再各配一套**（2026-10-26 部件色批）：三套 `colors` 直接复用 `theme.ts` 的
 * `KOJO_DARK_COLORS` / `KOJO_LIGHT_COLORS` / `KOJO_MINT_COLORS` 同一批 values。原先是
 * 一份 32 键的私有表，`inherit: false` 下漏列的 59 键（`menu.*` / `editorHoverWidget.*` /
 * `badge.*` / `editorBracketMatch.*` / `editorSuggestWidget.foreground` …）会掉回 Monaco
 * 默认色——切主题时露出一块基底灰。同一主题族里 v1 与 2.0 的部件色现在逐键相等、缺键 0
 * （闸见 `theme-color-gates.test.ts`）。
 *
 * 硬指标（`theme-color-gates.test.ts` / `kojo2-theme.test.ts` 复跑）：每档前景对主题自己的
 * `editor.background` 对比度 ≥ 4.5；**主题内全部生效规则**（v1 31 档 + 2.0 15 档，不只
 * 2.0 单族）两两 CIE76 ΔE ≥ 12（"看起来两档其实一色"是假分层）；跨语言同义档（`「」` 标点 /
 * 台词 / 字面 / 注释 / 原生）与 v1 同名档同色。
 *
 * ## 幂等注册
 *
 * {@link registerKojo2Themes} 用 `WeakSet` 记已注册过的 Monaco 实例：同一实例重复调用
 * 只定义一次，第二个实例照常各注册一份（不抛、不覆盖别人的主题名）。
 */

import type * as Monaco from './entry';
import {
  KOJO2_LIGHT_THEME_RULES,
  KOJO2_MINT_THEME_RULES,
  KOJO2_THEME_RULES,
  KOJO2_TOKEN,
  type Kojo2TokenName,
} from './kojo-theme-rules';
// 部件色复用 v1 三套（同一主题族逐键相等；`theme.ts` 对本文件的引用是**动态 import**，
// 所以这条静态反向依赖不成环）。
import { KOJO_DARK_COLORS, KOJO_LIGHT_COLORS, KOJO_MINT_COLORS } from './theme';

/* ============================== 三套主题的身份 ============================== */

/** 2.0 暗色主题 id（与 v1 的 `kojo-dark` 并存，双轨期各服务各的文件） */
export const KOJO2_DARK_THEME_ID = 'kojo2-dark';

/** 2.0 亮色主题 id */
export const KOJO2_LIGHT_THEME_ID = 'kojo2-light';

/** 2.0 墨绿暗色主题 id（暗色 token 规则 + 墨绿底） */
export const KOJO2_MINT_DARK_THEME_ID = 'kojo2-mint-dark';

/** 全部 2.0 主题 id（注册顺序 = 数组序；测试按此断言"两套都在"） */
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

/* ============================== token → 颜色映射 ============================== */

/** 一档 token 的样式（Monaco `ITokenThemeRule` 的前景色 + 字体样式） */
export interface Kojo2TokenStyle {
  readonly foreground: string;
  readonly fontStyle?: 'bold' | 'italic';
}

/** 主题三侧（暗 / 亮 / 墨绿；墨绿有自己的 2.0 规则表，不再复用暗色侧） */
export type Kojo2TokenThemeSide = 'dark' | 'light' | 'mint';

/** 把 `ITokenThemeRule` 的 `fontStyle: string` 收窄成本模块允许的两档（越界即抛） */
function toStyle(rule: Monaco.editor.ITokenThemeRule): Kojo2TokenStyle {
  const foreground = rule.foreground;
  if (foreground === undefined || !/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(foreground)) {
    throw new Error(`[kojo2-theme] token「${rule.token}」没有合法的前景色：${String(foreground)}`);
  }
  const fontStyle = rule.fontStyle;
  if (fontStyle === undefined) return { foreground };
  if (fontStyle !== 'bold' && fontStyle !== 'italic') {
    throw new Error(`[kojo2-theme] token「${rule.token}」的 fontStyle 不受支持：${fontStyle}`);
  }
  return { foreground, fontStyle };
}

/**
 * 把一张规则表按 token 收成样式索引；重复 token = 表本身写错了（加载期抛，不静默后者覆盖）。
 */
function indexRules(
  rules: readonly Monaco.editor.ITokenThemeRule[],
  label: string,
): Map<string, Kojo2TokenStyle> {
  const byToken = new Map<string, Kojo2TokenStyle>();
  for (const rule of rules) {
    if (byToken.has(rule.token)) {
      throw new Error(`[kojo2-theme] ${label}规则里 token「${rule.token}」出现了两次`);
    }
    byToken.set(rule.token, toStyle(rule));
  }
  return byToken;
}

/**
 * 组装 token → 三套样式（暗 / 亮 / 墨绿）；三侧都必须与叶子的规则表**逐格同源**。
 *
 * 校验顺序：先按 `KOJO2_TOKEN` 逐 token 取三侧规则（缺 = 抛），再反向查三张表有没有
 * 未登记的 token（多 = 抛）。这样"词法加了新档忘了配主题"与"配了色但词法不发这个 token"
 * 两个方向都在导入期变红。
 */
function buildTokenMap(): Readonly<
  Record<Kojo2TokenName, Readonly<Record<Kojo2TokenThemeSide, Kojo2TokenStyle>>>
> {
  const bySide: Readonly<Record<Kojo2TokenThemeSide, Map<string, Kojo2TokenStyle>>> = {
    dark: indexRules(KOJO2_THEME_RULES, '暗色'),
    light: indexRules(KOJO2_LIGHT_THEME_RULES, '亮色'),
    mint: indexRules(KOJO2_MINT_THEME_RULES, '墨绿'),
  };
  const tableName: Readonly<Record<Kojo2TokenThemeSide, string>> = {
    dark: 'KOJO2_THEME_RULES',
    light: 'KOJO2_LIGHT_THEME_RULES',
    mint: 'KOJO2_MINT_THEME_RULES',
  };

  const map = {} as Record<
    Kojo2TokenName,
    Readonly<Record<Kojo2TokenThemeSide, Kojo2TokenStyle>>
  >;
  for (const token of Object.values(KOJO2_TOKEN)) {
    const styles = {} as Record<Kojo2TokenThemeSide, Kojo2TokenStyle>;
    for (const side of ['dark', 'light', 'mint'] as const) {
      const style = bySide[side].get(token);
      if (style === undefined) {
        throw new Error(
          `[kojo2-theme] 词法 token「${token}」在 ${tableName[side]} 里没有配色`,
        );
      }
      styles[side] = style;
    }
    map[token] = styles;
  }
  const known = Object.keys(map).length;
  for (const side of ['dark', 'light', 'mint'] as const) {
    if (bySide[side].size !== known) {
      throw new Error(
        `[kojo2-theme] ${tableName[side]} 里有 ${bySide[side].size - known} 档未在 KOJO2_TOKEN 登记`,
      );
    }
  }
  return map;
}

/**
 * 词法 token → 三套主题的样式（暗 / 亮 / 墨绿）。
 *
 * 键集合**必须**等于 `Object.values(KOJO2_TOKEN)`：三侧都从叶子的规则表派生；任一缺格 /
 * 多格在模块加载期抛。
 */
export const KOJO2_THEME_TOKEN_MAP: Readonly<
  Record<Kojo2TokenName, Readonly<Record<Kojo2TokenThemeSide, Kojo2TokenStyle>>>
> = buildTokenMap();


/**
 * 作者面的**分类口径**：五锚点 / 声明名 / 对话三层各自归哪些 token。
 *
 * 这不是第二份配色表（颜色只在上面的映射里），而是"主题到底覆盖了哪三类东西"的验收清单：
 * 设置页 / 配色文档 / 测试都从这里取，避免"以为锚点单独一色"这类误解——词法对五锚点
 * 只发一个 `kojo2.anchor`（`#`/`@`/`>`/`?`/`!` 不再细分，改细分是词法的事，不是主题的事）。
 */
export interface Kojo2ThemeCategory {
  readonly category: '锚点' | '声明名' | '对话';
  readonly tokens: readonly Kojo2TokenName[];
  readonly note: string;
}

export const KOJO2_THEME_CATEGORIES: readonly Kojo2ThemeCategory[] = [
  {
    category: '锚点',
    tokens: [KOJO2_TOKEN.anchor],
    note: '五锚点 `# @ > ? !` 共用一档（词法只发 kojo2.anchor；行首转义 `\\` 同档）',
  },
  {
    category: '声明名',
    tokens: [KOJO2_TOKEN.declaration],
    note: '`#` 后的声明词 / `@` 后的调度词 / `!` 后的被调名',
  },
  {
    category: '对话',
    tokens: [
      KOJO2_TOKEN.speaker,
      KOJO2_TOKEN.speech,
      KOJO2_TOKEN.string,
      KOJO2_TOKEN.interp,
      KOJO2_TOKEN.hint,
      KOJO2_TOKEN.delimiter,
    ],
    note: '`角色：「…」` 的说话人与台词两层，外加插值 / 行尾表演提示 / 「」标点',
  },
];

/* ============================== 部件色 ============================== */

/**
 * 三套主题的部件色**直接复用 v1 的同一批 values**（2026-10-26 部件色批）：编辑器底/前景、
 * 行号、当前行、选区、光标、缩进参考线、括号匹配、浮层（menu / suggest / hover / widget）、
 * 徽章、查找、缩略图、滚动条、概览尺、diff 四色与粘性滚动。
 *
 * 为什么不再自持一份：`inherit: false` 下**未列的键落 Monaco 默认色**。旧表只有 32 键，
 * 漏了 59 键（`menu.*` / `editorHoverWidget.*` / `badge.*` / `editorBracketMatch.*` /
 * `editorSuggestWidget.foreground` / `editorWidget.foreground` …），切到 `kojo2-*` 时那些
 * 浮层露出一块与主题无关的基底灰。共有键的值与 v1 **逐字相等**（0 漂移），所以键集合
 * 直接取 v1 那张表——同一主题族里 v1 与 2.0 的部件色从此结构性地同源（闸见
 * `theme-color-gates.test.ts`：共有键相等 + 缺键 0）。
 */
export const KOJO2_COLOR_KEYS: readonly string[] = Object.freeze(Object.keys(KOJO_DARK_COLORS));

export type Kojo2ColorKey = (typeof KOJO2_COLOR_KEYS)[number];

/**
 * 部件色 → Monaco `colors`（**拷贝 + 逐键校验**）。
 *
 * 拷贝：Monaco 的 `colors` 是可写记录，不把 v1 那张只读表本体交给它（防宿主改写 v1 主题）；
 * 校验：每个值必须是 6/8 位十六进制——少配 / 配错在加载期抛，不静默掉色（本文件既有纪律）。
 */
function kojo2ColorsFor(colors: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of KOJO2_COLOR_KEYS) {
    const value = colors[key];
    if (value === undefined) {
      throw new Error(`[kojo2-theme] 部件色调色板缺少「${key}」`);
    }
    if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
      throw new Error(`[kojo2-theme] 部件色「${key}」不是合法十六进制色：${value}`);
    }
    out[key] = value;
  }
  return out;
}

/* ============================== 主题字面量 ============================== */

/**
 * 2.0 暗色主题（`vs-dark` 基底、不继承）。
 *
 * `rules` 是叶子 `kojo-theme-rules.ts` 的 `KOJO2_THEME_RULES` 的**浅拷贝**（元素同对象）：
 * 顶层数组要可写（Monaco 的类型是 `ITokenThemeRule[]`），但每一格不重造——暗色真源只有一份。
 */
export const kojo2DarkTheme: Monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: false,
  rules: [...KOJO2_THEME_RULES],
  colors: kojo2ColorsFor(KOJO_DARK_COLORS),
};

/** 2.0 亮色主题（`vs` 基底、不继承；token 规则 = 叶子的 `KOJO2_LIGHT_THEME_RULES` 浅拷贝） */
export const kojo2LightTheme: Monaco.editor.IStandaloneThemeData = {
  base: 'vs',
  inherit: false,
  rules: [...KOJO2_LIGHT_THEME_RULES],
  colors: kojo2ColorsFor(KOJO_LIGHT_COLORS),
};

/** 2.0 墨绿暗色主题（token 规则 = 叶子的 `KOJO2_MINT_THEME_RULES`；底色 `#0f1713`） */
export const kojo2MintDarkTheme: Monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: false,
  rules: [...KOJO2_MINT_THEME_RULES],
  colors: kojo2ColorsFor(KOJO_MINT_COLORS),
};

/** 主题 id → 字面量（注册器与测试共用一张表；顺序与 {@link KOJO2_THEME_IDS} 一致） */
export const KOJO2_THEMES: Readonly<
  Record<Kojo2ThemeId, Monaco.editor.IStandaloneThemeData>
> = {
  [KOJO2_DARK_THEME_ID]: kojo2DarkTheme,
  [KOJO2_LIGHT_THEME_ID]: kojo2LightTheme,
  [KOJO2_MINT_DARK_THEME_ID]: kojo2MintDarkTheme,
};

/* ============================== 注册 ============================== */

/** 已注册过的 Monaco 实例（WeakSet：不拖住实例，也不阻止宿主重建） */
const registeredInstances = new WeakSet<object>();

/**
 * 注册三套 2.0 主题（**幂等**）。
 *
 * 同一 Monaco 实例重复调用只定义一次；`defineTheme` 本身是"同名覆盖"，即便将来有第二个
 * 实例重新注册也不会抛。返回是否真的写了（`false` = 这次是重复调用，什么都没做）。
 */
export function registerKojo2Themes(monaco: typeof Monaco): boolean {
  const instance = monaco as unknown as object;
  if (registeredInstances.has(instance)) return false;
  for (const id of KOJO2_THEME_IDS) {
    monaco.editor.defineTheme(id, KOJO2_THEMES[id]);
  }
  registeredInstances.add(instance);
  return true;
}
