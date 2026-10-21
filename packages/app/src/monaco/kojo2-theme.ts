/**
 * Kojo 2.0 的 **Monaco 主题**（K2-CUTOVER-PRE）：五锚点 / 声明名 / 对话各归各色，
 * 亮暗两套 + 墨绿变体，`rules` 与 `kojo2-language.ts` 的 token 名**逐字同源**。
 *
 * ## 为什么单独一套主题，而不是并进 `theme.ts`
 *
 * `theme.ts` 是仓里 v1 的唯一装配点（`kojo-dark` / `kojo-light` / `kojo-mint-dark`），
 * 本批**只许新建文件**、不许碰它。切换前夜要的正是"两套主题同时存在"：`kojo-*` 继续服务
 * v1 文件，`kojo2-*` 给 2.0 面用；双轨期在同一个窗口里按当前文件切（Monaco 主题是进程级
 * 的，真正的"一窗两主题"要等 K2-CUTOVER 把 2.0 的 token 规则并进三套 `kojo-*`）。
 *
 * ## token 名的单一真源
 *
 * 本文件的调色板**以 `kojo2-language.ts` 的 `KOJO2_TOKEN` 为键**（计算属性，不手抄字符串），
 * 暗色侧直接取它的 `KOJO2_THEME_RULES`——那张表就是"档位表 = 配色表"的既有真源。
 * 任何一侧少一格 / 多一格，{@link KOJO2_THEME_TOKEN_MAP} 在**模块加载期**当场抛
 * （与 `theme.ts` 的 `retint` 同一纪律：少配一档在加载期变红，而不是静默掉色）。
 * `kojo2-theme.test.ts` 再用 `KOJO2_THEME_RULES` 与 `KOJO2_TOKEN` 双向交叉断言，防将来漂移。
 *
 * ## 取色口径
 *
 * - **暗**：原样沿用 `kojo2-language.ts` 的 `KOJO2_THEME_RULES`（不重定义、不改一个色值），
 *   底色取 app 的 `--bg` `#1e2227`（与 `kojo-dark` 同底，切过来不跳）；
 * - **亮**：同一套语义族的浅底版本（紫=声明、青=关键字、橙棕=说话人、绿=台词、蓝=旁白、
 *   金=插值、红=提示、暖灰=原生、紫灰=注释、紫=数字、石板=运算符、品红=锚点）；
 * - **墨绿**：暗色 token 规则 + 墨绿底 `#0f1713`（与 `kojo-mint-dark` 同底）。
 * 三套都不 `inherit`（不从基底借色，切主题不残留上一套的 token 色）。
 *
 * 硬指标（`kojo2-theme.test.ts` 复跑）：每档前景对各自底色对比度 ≥ 4.5；**任意两档**
 * CIE76 ΔE ≥ 12（"看起来两档其实一色"是假分层）。
 *
 * ## 幂等注册
 *
 * {@link registerKojo2Themes} 用 `WeakSet` 记已注册过的 Monaco 实例：同一实例重复调用
 * 只定义一次，第二个实例照常各注册一份（不抛、不覆盖别人的主题名）。
 */

import type * as Monaco from './entry';
import {
  KOJO2_THEME_RULES,
  KOJO2_TOKEN,
  type Kojo2TokenName,
} from './kojo2-language';

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

/** 主题两侧（暗 / 亮；墨绿复用暗色 token 规则，只换部件底色） */
export type Kojo2TokenThemeSide = 'dark' | 'light';

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
 * 亮色 token 调色板（键 = `KOJO2_TOKEN` 的计算属性，不手抄 token 名）。
 *
 * 取色族：紫=声明、靛=数字、青=关键字、棕=说话人、橄榄绿=台词、蓝=旁白、金=插值、
 * 红=提示、暖灰=原生、紫灰=注释、石板=运算符、品红=锚点。
 * 品红 / 红 / 紫灰刻意拉开：锚点与提示、注释与运算符在浅底上最容易糊成一片。
 */
const KOJO2_LIGHT_TOKEN_COLORS: Readonly<Record<Kojo2TokenName, Kojo2TokenStyle>> = {
  [KOJO2_TOKEN.anchor]: { foreground: 'b5179e', fontStyle: 'bold' },
  [KOJO2_TOKEN.declaration]: { foreground: '512da8' },
  [KOJO2_TOKEN.keyword]: { foreground: '0b7285' },
  [KOJO2_TOKEN.delimiter]: { foreground: '0b7285' },
  [KOJO2_TOKEN.speaker]: { foreground: '8b4513' },
  [KOJO2_TOKEN.speech]: { foreground: '33691e' },
  [KOJO2_TOKEN.string]: { foreground: '33691e' },
  [KOJO2_TOKEN.narration]: { foreground: '1565c0' },
  [KOJO2_TOKEN.interp]: { foreground: '8a6d00' },
  [KOJO2_TOKEN.hint]: { foreground: 'b4232e', fontStyle: 'italic' },
  [KOJO2_TOKEN.raw]: { foreground: '5f5548' },
  [KOJO2_TOKEN.comment]: { foreground: '5d4a5c', fontStyle: 'italic' },
  [KOJO2_TOKEN.number]: { foreground: '8e44ad' },
  [KOJO2_TOKEN.hex]: { foreground: '8e44ad' },
  [KOJO2_TOKEN.operator]: { foreground: '2b5566' },
};

/**
 * 组装 token → 两套样式；暗色侧必须与 `KOJO2_THEME_RULES` **逐格同源**。
 *
 * 校验顺序：先按 `KOJO2_TOKEN` 逐 token 取暗色规则（缺 = 抛），再取亮色（缺 = TS 已挡，
 * 运行时兜一层）。这样"词法加了新档忘了配主题"在导入期就红。
 */
function buildTokenMap(): Readonly<
  Record<Kojo2TokenName, Readonly<Record<Kojo2TokenThemeSide, Kojo2TokenStyle>>>
> {
  const darkByToken = new Map<string, Kojo2TokenStyle>();
  for (const rule of KOJO2_THEME_RULES) darkByToken.set(rule.token, toStyle(rule));

  const map = {} as Record<
    Kojo2TokenName,
    Readonly<Record<Kojo2TokenThemeSide, Kojo2TokenStyle>>
  >;
  for (const token of Object.values(KOJO2_TOKEN)) {
    const dark = darkByToken.get(token);
    if (dark === undefined) {
      throw new Error(`[kojo2-theme] 词法 token「${token}」在 KOJO2_THEME_RULES 里没有配色`);
    }
    const light = KOJO2_LIGHT_TOKEN_COLORS[token];
    if (light === undefined) {
      throw new Error(`[kojo2-theme] 词法 token「${token}」在亮色调色板里没有配色`);
    }
    map[token] = { dark, light };
  }
  return map;
}

/**
 * 词法 token → 两套主题的样式。
 *
 * 键集合**必须**等于 `Object.values(KOJO2_TOKEN)`：暗色侧从 `KOJO2_THEME_RULES` 派生，
 * 亮色侧由 {@link KOJO2_LIGHT_TOKEN_COLORS} 给全；任一缺格在模块加载期抛。
 *
 * 声明位置在调色板之后：`buildTokenMap()` 在模块求值时就会读亮色表，放到前面会踩 TDZ。
 */
export const KOJO2_THEME_TOKEN_MAP: Readonly<
  Record<Kojo2TokenName, Readonly<Record<Kojo2TokenThemeSide, Kojo2TokenStyle>>>
> = buildTokenMap();

/** 按某一侧样式表生成 Monaco 规则数组（token 序 = `KOJO2_TOKEN` 的声明序） */
function rulesFor(
  side: Kojo2TokenThemeSide,
): Monaco.editor.ITokenThemeRule[] {
  return Object.values(KOJO2_TOKEN).map((token) => {
    const style = KOJO2_THEME_TOKEN_MAP[token][side];
    return style.fontStyle === undefined
      ? { token, foreground: style.foreground }
      : { token, foreground: style.foreground, fontStyle: style.fontStyle };
  });
}

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
 * 三套主题的部件色**同一张键表**（值各配各的）：只收"切过来第一眼会看出不对"的那批——
 * 编辑器底/前景、行号、当前行、选区、缩进参考线、光标、错误/警告/信息、焦点框、输入框、
 * 补全与悬停浮层、查找框、缩略图、滚动条、diff 两色。
 *
 * 键表共用是结构性的：{@link kojo2ColorsFor} 按这张表取值，所以三套主题的 `colors`
 * 键集合永远相等（少配一个在加载期抛，不会出现"浅色主题里漏配深色 widget"）。
 */
export const KOJO2_COLOR_KEYS = [
  'editor.background',
  'editor.foreground',
  'editorLineNumber.foreground',
  'editorLineNumber.activeForeground',
  'editorCursor.foreground',
  'editor.lineHighlightBackground',
  'editor.selectionBackground',
  'editorIndentGuide.background1',
  'editorIndentGuide.activeBackground1',
  'editorWhitespace.foreground',
  'editorGutter.background',
  'editorOverviewRuler.background',
  'editorError.foreground',
  'editorWarning.foreground',
  'editorInfo.foreground',
  'focusBorder',
  'input.background',
  'input.border',
  'input.foreground',
  'list.activeSelectionBackground',
  'list.activeSelectionForeground',
  'list.hoverBackground',
  'list.highlightForeground',
  'widget.border',
  'editorWidget.background',
  'editorWidget.border',
  'editorSuggestWidget.background',
  'editorSuggestWidget.selectedBackground',
  'minimap.background',
  'scrollbarSlider.background',
  'diffEditor.insertedTextBackground',
  'diffEditor.removedTextBackground',
] as const;

export type Kojo2ColorKey = (typeof KOJO2_COLOR_KEYS)[number];

/** 部件色三套（值与 `theme.ts` 同底：切主题时外壳与编辑器不跳色） */
const KOJO2_DARK_COLORS: Readonly<Record<Kojo2ColorKey, string>> = {
  'editor.background': '#1e2227',
  'editor.foreground': '#d7dce2',
  'editorLineNumber.foreground': '#7d8794',
  'editorLineNumber.activeForeground': '#d7dce2',
  'editorCursor.foreground': '#6ea8ff',
  'editor.lineHighlightBackground': '#24292f',
  'editor.selectionBackground': '#4c8bf559',
  'editorIndentGuide.background1': '#2f363d',
  'editorIndentGuide.activeBackground1': '#4a545f',
  'editorWhitespace.foreground': '#3a424b',
  'editorGutter.background': '#1e2227',
  'editorOverviewRuler.background': '#1e2227',
  'editorError.foreground': '#e06c75',
  'editorWarning.foreground': '#d19a66',
  'editorInfo.foreground': '#6ea8ff',
  focusBorder: '#4c8bf5',
  'input.background': '#2b3138',
  'input.border': '#4a545f',
  'input.foreground': '#d7dce2',
  'list.activeSelectionBackground': '#2b3138',
  'list.activeSelectionForeground': '#e6edf3',
  'list.hoverBackground': '#2b3138',
  'list.highlightForeground': '#6ea8ff',
  'widget.border': '#3a424b',
  'editorWidget.background': '#24292f',
  'editorWidget.border': '#3a424b',
  'editorSuggestWidget.background': '#24292f',
  'editorSuggestWidget.selectedBackground': '#2b3138',
  'minimap.background': '#1e2227',
  'scrollbarSlider.background': '#ffffff1f',
  'diffEditor.insertedTextBackground': '#4fc08d2e',
  'diffEditor.removedTextBackground': '#e06c752e',
};

const KOJO2_LIGHT_COLORS: Readonly<Record<Kojo2ColorKey, string>> = {
  'editor.background': '#f6f8fa',
  'editor.foreground': '#1f2328',
  'editorLineNumber.foreground': '#6e7781',
  'editorLineNumber.activeForeground': '#1f2328',
  'editorCursor.foreground': '#0550ae',
  'editor.lineHighlightBackground': '#eaeef2',
  'editor.selectionBackground': '#0a5cc248',
  'editorIndentGuide.background1': '#d8dee4',
  'editorIndentGuide.activeBackground1': '#afb8c1',
  'editorWhitespace.foreground': '#d0d7de',
  'editorGutter.background': '#f6f8fa',
  'editorOverviewRuler.background': '#f6f8fa',
  'editorError.foreground': '#b4232e',
  'editorWarning.foreground': '#8a5a04',
  'editorInfo.foreground': '#0550ae',
  focusBorder: '#0a5cc2',
  'input.background': '#ffffff',
  'input.border': '#d0d7de',
  'input.foreground': '#1f2328',
  'list.activeSelectionBackground': '#dde3ea',
  'list.activeSelectionForeground': '#1f2328',
  'list.hoverBackground': '#eaeef2',
  'list.highlightForeground': '#0550ae',
  'widget.border': '#d0d7de',
  'editorWidget.background': '#ffffff',
  'editorWidget.border': '#d0d7de',
  'editorSuggestWidget.background': '#ffffff',
  'editorSuggestWidget.selectedBackground': '#dde3ea',
  'minimap.background': '#f6f8fa',
  'scrollbarSlider.background': '#091e421f',
  'diffEditor.insertedTextBackground': '#0e6b2c26',
  'diffEditor.removedTextBackground': '#b4232e26',
};

const KOJO2_MINT_COLORS: Readonly<Record<Kojo2ColorKey, string>> = {
  'editor.background': '#0f1713',
  'editor.foreground': '#d9e9df',
  'editorLineNumber.foreground': '#6f8c7d',
  'editorLineNumber.activeForeground': '#d9e9df',
  'editorCursor.foreground': '#45d9ab',
  'editor.lineHighlightBackground': '#15201a',
  'editor.selectionBackground': '#35d0a052',
  'editorIndentGuide.background1': '#243a30',
  'editorIndentGuide.activeBackground1': '#3d5a4b',
  'editorWhitespace.foreground': '#2b3f35',
  'editorGutter.background': '#0f1713',
  'editorOverviewRuler.background': '#0f1713',
  'editorError.foreground': '#e2707a',
  'editorWarning.foreground': '#d8a269',
  'editorInfo.foreground': '#7cc7ff',
  focusBorder: '#45d9ab',
  'input.background': '#1c2a23',
  'input.border': '#3d5a4b',
  'input.foreground': '#d9e9df',
  'list.activeSelectionBackground': '#1c2a23',
  'list.activeSelectionForeground': '#d9e9df',
  'list.hoverBackground': '#1c2a23',
  'list.highlightForeground': '#55dcb0',
  'widget.border': '#2b3f35',
  'editorWidget.background': '#15201a',
  'editorWidget.border': '#2b3f35',
  'editorSuggestWidget.background': '#15201a',
  'editorSuggestWidget.selectedBackground': '#1c2a23',
  'minimap.background': '#0f1713',
  'scrollbarSlider.background': '#35d0a02e',
  'diffEditor.insertedTextBackground': '#62c77626',
  'diffEditor.removedTextBackground': '#e2707a26',
};

/** 按共用键表把一套部件色展开成 Monaco 的 `colors` 记录（键集合由键表钉死） */
function kojo2ColorsFor(palette: Readonly<Record<Kojo2ColorKey, string>>): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const key of KOJO2_COLOR_KEYS) {
    const value = palette[key];
    if (value === undefined) {
      throw new Error(`[kojo2-theme] 部件色调色板缺少「${key}」`);
    }
    colors[key] = value;
  }
  return colors;
}

/* ============================== 主题字面量 ============================== */

/**
 * 2.0 暗色主题（`vs-dark` 基底、不继承）。
 *
 * `rules` 是 `kojo2-language.ts` 的 `KOJO2_THEME_RULES` 的**浅拷贝**（元素同对象）：
 * 顶层数组要可写（Monaco 的类型是 `ITokenThemeRule[]`），但每一格不重造——暗色真源只有一份。
 */
export const kojo2DarkTheme: Monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: false,
  rules: [...KOJO2_THEME_RULES],
  colors: kojo2ColorsFor(KOJO2_DARK_COLORS),
};

/** 2.0 亮色主题（`vs` 基底、不继承；token 规则按亮色调色板逐格重算） */
export const kojo2LightTheme: Monaco.editor.IStandaloneThemeData = {
  base: 'vs',
  inherit: false,
  rules: rulesFor('light'),
  colors: kojo2ColorsFor(KOJO2_LIGHT_COLORS),
};

/** 2.0 墨绿暗色主题（token 规则同暗色，底色换 `#0f1713`） */
export const kojo2MintDarkTheme: Monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: false,
  rules: [...KOJO2_THEME_RULES],
  colors: kojo2ColorsFor(KOJO2_MINT_COLORS),
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
