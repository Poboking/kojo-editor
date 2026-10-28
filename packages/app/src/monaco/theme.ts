import type * as Monaco from './entry';
// PS-10 断链：角色调色板下沉到零依赖叶子 `@kojo/kojo-lang/theme-rules`——它们的**老家**
// （三份 Monarch 与 `kojo-semantic-tokens.ts`）各自拖着 `@kojo/plugin-kojo-sugar`
// 词表链，本文件在开机静态图里（diff-view / QuickFixPreviewOverlay 都经它），
// 直接 import 老家就等于把糖包静态挂回开机图。叶子与几个老家的关系见叶子头注。
//
// LAU-2（角色表批）：主题规则按**语义角色**铺，不再按 token 名。角色表（含字重）住
// `@kojo/kojo-sdk/semantic-roles`，三套主题的角色调色板住叶子，本文件只做装配 + 后三套自己的调色板。
// 于是 `.kojo2` 文件在 `kojo-*` 主题下也上色（同一批角色规则，不必整窗切主题）。
import {
  KOJO_SEMANTIC_LIGHT_THEME_RULES,
  KOJO_SEMANTIC_MINT_THEME_RULES,
  KOJO_SEMANTIC_THEME_RULES,
  ROLE_LIGHT_THEME_RULES,
  ROLE_MINT_THEME_RULES,
  ROLE_THEME_RULES,
} from '@kojo/kojo-lang/theme-rules';
import { ROLE, nameLayerRules, rulesFromRolePalette } from '@kojo/kojo-sdk/semantic-roles';

// K2 batch-3：2.0 三套主题的注册闸。flag 模块零依赖（只读 localStorage），静态引它
// 不破坏上面那条 PS-10 断链；主题数据本身（`@kojo/kojo-lang/monaco-theme`，经槽交出）仍走
// **动态链**（见 `defineMonacoThemes` 末尾）。
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';
// Synthwave '84 的关键字霓虹光：零依赖叶子（只碰 DOM），静态引它不加包体负担。
import { installKeywordGlow, scheduleKeywordGlow } from './neon-glow';

/**
 * Monaco 主题（2026-10-17 反馈 3：编辑器配色跟随主题；2026-10-27 经典编辑器色批扩到六套）。
 *
 * 主题 id 与 `ui/theme-pref.ts` 的六档**逐字对应**，但本模块不 import 那个 UI 模块——
 * monaco 层只认识自己的联合类型，避免 UI → monaco → UI 的反向依赖；两边联合类型相同
 * 由 `tests/monaco-theme.test.ts` 用 `THEME_IDS` 做一一映射断言钉住。
 *
 * ## 装配只有一条路（LAU-2 起）
 * 六套主题都走"角色调色板 → `rulesFromRolePalette()` + 名字层五条"：34 条角色规则 + 5 条
 * 名字层 = 39 条规则，外加 91 键部件色，由同一道闸量（`theme-color-gates.test.ts`）。
 * 前三套（dark/light/mint-dark）的角色调色板住零依赖叶子 `@kojo/kojo-lang/theme-rules`（与
 * `@kojo/kojo-lang/monaco-theme` 同一批对象本体）；后三套（one-dark/rose-pine/synthwave84）的调色板
 * 住在下面各自那节，逐档判据注释留在原地。
 *
 * ## 取色口径
 * - **dark**：沿用既有 `kojo-dark` 的语法色（ERB 基线 + 糖 + 语义 + 2.0），底色从 vs-dark 的
 *   `#1e1e1e` 改为 app 的 `--bg` `#1e2227`，编辑器与外壳同底；
 * - **light**：VS Code Light+ 气质，深蓝/橄榄绿/赭石/紫四族压浅底；不复用任何暗色前景；
 * - **mint-dark**：与 `themes/mint-dark.css` 的墨绿底 `#0f1713` 协调的冷薄荷族。
 * - 后三套逐套见其表头（One Dark 的底色还账、Rosé Pine 的两枚弃用色、Synthwave '84 的
 *   整块过闸）。
 *
 * **`role.operator` 档住哪儿**（ERB 半角运算符 + 全角标点、`.kojo` 表达式的 `()+[]`）：
 * 标点在屏上是骨架不是内容，所以它必须**比正文弱**（对比度低于同套 `role.text`）、
 * **比注释强且肉眼可分**（CIE76 ΔE ≥ 12，判据同 `kojo-token-tiers.test.ts` 的"撞色 = 假分层"），
 * 且**不引入新色相**——三套各取本套既有的"冷色结构族"一档：
 * dark `7f9cc0`、mint `8fb3c9` 即本套的标点/分隔符族（与 `role.punctuation` 同色：
 * 同一枚 `「` 在两门语言里必须同色）；light 的分隔符族 2026-10-26 色值批从 `5b6b7f`
 * 抬到同族更蓝的 `335f96`（旧值与其注释色 `57606a` ΔE 只有 7.6 ⇒ 台词标点会读成注释），
 * 于是 light 的 operator 取同族更深一档 `35526f`（与分隔符 ΔE 16.6，对全部基线档 ≥ 12）。
 * 三套的 operator 彩度都低于各自关键字档 ⇒ 运算符不抢关键字。
 *
 * `inherit: false`：六套都写全规则，不从基底主题借色（避免切到 light 时残留 vs-dark 的
 * 深色 token / 部件色）。三套叶子调色板的规则**对象原样复用**（`kojo-token-tiers.test.ts`
 * 有同引用断言），角色集合因此永远同源。
 *
 * **`role.type` 档住哪儿**（2026-10-27 第三色批）：外部建议点名的"类型用第三色"，本仓此前
 * 只有紫（关键字）与蓝（函数名，粗）两层，结构名一直没有自己的色。三套各取一支**黄绿／橄榄**
 * （dark `b3bd47` / light `5f6b2a` / mint `96b458`）——这条色相带在三套盘里都是空的，所以对每套
 * 最近的一枚（都是台词绿）都拉开到 ΔE ≥ 24，对比度 5.4–7.9。它**不加 fontStyle**：分层靠色相，
 * 不靠伪斜体（CJK 斜体会糊，与 `role.keyword` 同一口径）。消费方两条链都默认开：
 * `.ERB` 结构层的 `#DIM` 型/存储限定词（`tree-sitter/erb-tiers.ts`）与 2.0 的结构定义头
 * ——两门语言落**同一个角色**，不许有两种绿。
 *
 * **底色口径（2026-10-26 判据批）**：`inherit: false` 意味着 `editor.background` 就是量
 * 对比度的那块底（dark `#1e2227` / light `#f6f8fa` / mint `#0f1713`），**不是** vs-dark 基底
 * 的 `#1e1e1e`。判据一律从 `colors['editor.background']` 取值（`kojo-token-tiers.test.ts` /
 * `theme-color-gates.test.ts`），不许再写字面量。
 */

export type MonacoThemeId =
  | 'kojo-dark'
  | 'kojo-light'
  | 'kojo-mint-dark'
  | 'kojo-one-dark'
  | 'kojo-rose-pine'
  | 'kojo-synthwave84';

/** 与 `ui/theme-pref.ts` 的 `ThemePref` 逐字同形（不 import，理由见头注） */
export type MonacoThemePref =
  | 'dark'
  | 'light'
  | 'mint-dark'
  | 'one-dark'
  | 'rose-pine'
  | 'synthwave84';

const THEME_ID_BY_PREF: Readonly<Record<string, MonacoThemeId>> = {
  dark: 'kojo-dark',
  light: 'kojo-light',
  'mint-dark': 'kojo-mint-dark',
  'one-dark': 'kojo-one-dark',
  'rose-pine': 'kojo-rose-pine',
  synthwave84: 'kojo-synthwave84',
};

/** 偏好 → Monaco 主题 id（未知/脏值回缺省 dark，绝不抛） */
export function monacoThemeIdFor(pref: MonacoThemePref): MonacoThemeId {
  return THEME_ID_BY_PREF[pref] ?? 'kojo-dark';
}

/* ------------------------------ 换主题的两段式 ------------------------------ */

/**
 * 换主题拆两帧：`data-theme`（整页 style recalc）当帧由 `ui/theme-pref.ts` 同步落，
 * Monaco 的重活（`setTheme` ⇒ 重算 token 色 + 重绘视口 + 缩略图）延一帧再落；同帧连切
 * 合并成最后一次。理由、读数与帧策略取舍写在 `tests/theme-switch-defer.test.ts` 头注
 * ——本文件在开机静态图里，注释也占包体。
 */

/** 换主题需要的最小 Monaco 面（只要求一个方法 ⇒ 本模块不 import entry，node 单测直接给替身） */
export interface MonacoThemeSink {
  readonly editor: { setTheme(themeName: string): void };
}

let pending: MonacoThemeId | null = null;
let armed = false;

/** 主路径唯一排队点（浮层仍各自直调）：同帧只落一次 `setTheme` */
export function applyMonacoTheme(sink: MonacoThemeSink, pref: MonacoThemePref): void {
  pending = monacoThemeIdFor(pref);
  if (armed) return; // 已排过一帧：只覆盖目标档，不再排第二次
  armed = true;
  const run = (): void => {
    armed = false;
    const id = pending;
    pending = null;
    if (id !== null) {
      sink.editor.setTheme(id);
      // Monaco 把 token 色表（`.mtk<N> { color: … }`）写进 `<head>` 正好在 setTheme 这一帧里、
      // 同步完成 ⇒ 紧跟其后重扫一次是**唯一确定**能捞到序号的时机（早于它的任何时机都靠猜）。
      // 改档不撤销：规则自带 `:root[data-theme='synthwave84']` 作用域，换到别档自然失效；
      // 换回 Synthwave 时这里会重扫重写（序号表跟着重算了就跟着变）。
      installKeywordGlow();
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0); // node / 老内核：退化为宏任务，请求绝不丢
}

/* ------------------------------ 规则构建 ------------------------------ */

/* ------------------------------ 规则构建（LAU-2：角色调色板） ------------------------------ */

/**
 * 六套主题的语法规则**只有一种铺法**：给 34 个语义角色各发一色，再补名字层那五条。
 *
 * 上一代是三套走"四张分表"（词法 12 / 糖 15 / 语义 5 / 2.0 16）、新三套走"一张 48 键表"；
 * LAU-2 把两代合成一条：`rulesFromRolePalette(角色调色板)` + 名字层。
 * - 角色表本身（含字重）见 `@kojo/kojo-sdk/semantic-roles`；
 * - 暗 / 亮 / 墨绿三套的角色调色板与名字层调色板住在零依赖叶子 `@kojo/kojo-lang/theme-rules`
 *   （`@kojo/kojo-lang/monaco-theme` 与原宿主的 `kojo2-semantic.ts` 读的是同一批对象本体）；
 * - 后三套（One Dark / Rosé Pine / Synthwave '84）的调色板留本文件下半段（各自带判据注释）。
 *
 * 两代产物的形状如今完全相同（34 条角色 + 5 条名字层 = 39 条规则 + 91 键部件色），由同一道闸量
 * （`theme-color-gates.test.ts`）。
 */
type RulePalette = Readonly<Record<string, string>>;

/** 角色调色板 + 名字层调色板 → 39 条规则（漏一格当场抛，不静默掉色） */
function rulesFromPalettes(roles: Readonly<Record<string, string>>, nameLayer: RulePalette): Monaco.editor.ITokenThemeRule[] {
  return [...rulesFromRolePalette(roles), ...nameLayerRules(nameLayer)];
}

/** 暗色：角色调色板与名字层都直接取叶子的同一批对象（真源只有一份） */
function darkRules(): Monaco.editor.ITokenThemeRule[] {
  return [...ROLE_THEME_RULES, ...KOJO_SEMANTIC_THEME_RULES];
}

/** 亮色：叶子里各自一套浅底调色板 */
function lightRules(): Monaco.editor.ITokenThemeRule[] {
  return [...ROLE_LIGHT_THEME_RULES, ...KOJO_SEMANTIC_LIGHT_THEME_RULES];
}

/** 墨绿：墨绿盘自己的两套（理由见 `SEMANTIC_ROLE_PALETTE_MINT` 表头） */
function mintRules(): Monaco.editor.ITokenThemeRule[] {
  return [...ROLE_MINT_THEME_RULES, ...KOJO_SEMANTIC_MINT_THEME_RULES];
}

/* ------------------------------ 部件色 ------------------------------ */

/**
 * 部件色三套同一张键表（值各配各的）：编辑器背景/前景、行号、当前行、选区、光标、
 * 缩进参考线、括号匹配、浮层（widget/suggest/hover）、查找、缩略图、滚动条、概览尺、
 * diff 四色与粘性滚动。浅色档全部落在浅色面，不留 vs-dark 的深色块。
 *
 * **导出给宿主落点 `./monaco-language-surface`**（2026-10-26 部件色批；B4 起 2.0 三套主题
 * 的身份在 `@kojo/kojo-lang/monaco-theme`，部件色仍按 `componentPalette` 侧名回取本表）；
 * 2.0 三套主题的 `colors` 不再自己
 * 抄 32 键（`inherit: false` 下未列的 59 键会掉回 Monaco 默认的 `menu.*` / `editorHoverWidget.*`
 * / `badge.*` / `editorBracketMatch.*` 等，切主题时露出一块基底色）。2.0 直接复用本表的
 * **同一批 values**：同一主题族里 v1 与 2.0 的部件色逐键相等、缺键 0（闸见
 * `theme-color-gates.test.ts`）。
 */
export const KOJO_DARK_COLORS: Readonly<Record<string, string>> = {
  'editor.background': '#1e2227',
  'editor.foreground': '#d7dce2',
  'editorLineNumber.foreground': '#7d8794',
  'editorLineNumber.activeForeground': '#d7dce2',
  'editorLineNumber.dimmedForeground': '#4c545e',
  'editorCursor.foreground': '#6ea8ff',
  /* 幽灵文本（内联补全）的前景观 — 与 `tokens.css` 的 `--ghost-text` 逐字同源（镜像行见
     `monaco-token-mirror.test.ts`）。**通道 = 本档 `--fg`，只带 alpha**："幽灵文本就是正文色退一档"，
     不引入第 16 枚色相。vendor 缺省是 `#ffffff56` / `#0007`（按 base 深浅取，**不随本仓六档翻色**），
     所以这一格不定义就等于让 Monaco 拿它自己的白/黑覆盖层——浅色档会当场翻成灰雾。
     为什么只给 foreground、不给 `editorGhostText.background / .border`：那两枚在注册表里缺省 null，
     不定义 ⇒ `--vscode-*` 不发 ⇒ vendor 的 `background-color` / `border` 两条声明整条失效回落
     initial（透明 + `border-style: none`）= **无色无框**。一旦给了 border，每个候选片段都会框出一圈
     1px 实线（inline span 逐段成框），那是"格子"不是"预告"。alpha 的取数理由见 tokens.css 那一族注。 */
  'editorGhostText.foreground': '#d7dce2bd',
  // 当前行（C1，2026-10-26 阅读面批）：旧值 `#24292f` 压在 `#1e2227` 上只有 **1.091:1**，
  // 等于没有（作者找不到"我现在在哪一行"）。三套主题统一改成**各自 `--bg-3` 那一档**
  // ——外壳里"比面板再抬一层"用的同一枚台阶，不新造色、不引入色相：
  //   dark  #1e2227 ← #2b3138  **1.218:1**
  //   light #f6f8fa ← #dde3ea  **1.214:1**
  //   mint  #0f1713 ← #1c2a23  **1.219:1**
  // 三档都落在 1.18–1.25 之间，且正文压在新底上仍有 9.5–12.2:1（不是"这行被选中"的
  // accent wash，只是一层薄抬升）。border 与 background 同色 ⇒ 不画描边（`current-line-exact`
  // 那条 2px border 规则因 theme 定义了 border 色而生效，同色即不可见）。
  'editor.lineHighlightBackground': '#2b3138',
  'editor.lineHighlightBorder': '#2b3138',
  'editor.selectionBackground': '#4c8bf559',
  'editor.inactiveSelectionBackground': '#4c8bf529',
  'editor.selectionHighlightBackground': '#4c8bf53d',
  'editor.wordHighlightBackground': '#4c8bf52e',
  'editor.wordHighlightStrongBackground': '#4c8bf55c',
  'editor.findMatchBackground': '#d19a6666',
  'editor.findMatchHighlightBackground': '#d19a6638',
  'editor.findRangeHighlightBackground': '#4c8bf524',
  'editorIndentGuide.background1': '#2f363d',
  'editorIndentGuide.activeBackground1': '#4a545f',
  'editorBracketMatch.background': '#4c8bf529',
  'editorBracketMatch.border': '#4c8bf5',
  'editorBracketHighlight.foreground1': '#c678dd',
  'editorBracketHighlight.foreground2': '#61afef',
  'editorBracketHighlight.foreground3': '#56b6c2',
  'editorBracketHighlight.foreground4': '#e5c07b',
  'editorBracketHighlight.foreground5': '#e06c75',
  'editorBracketHighlight.foreground6': '#98c379',
  'editorBracketHighlight.unexpectedBracket.foreground': '#e06c75',
  'editorWhitespace.foreground': '#3a424b',
  'editorRuler.foreground': '#2b3138',
  'editorGutter.background': '#1e2227',
  'editorOverviewRuler.background': '#1e2227',
  'editorOverviewRuler.border': '#3a424b',
  'editorError.foreground': '#e06c75',
  'editorWarning.foreground': '#d19a66',
  'editorInfo.foreground': '#6ea8ff',
  'editorLink.activeForeground': '#6ea8ff',
  // 全局部件色（find 输入 / 补全列表 / 右键菜单 / 徽章）：不通用的基底默认色会
  // 在 mint 的绿底上露出一块中性灰——一并对齐到本主题的面上。
  focusBorder: '#4c8bf5',
  'input.background': '#2b3138',
  'input.border': '#4a545f',
  'input.foreground': '#d7dce2',
  'input.placeholderForeground': '#8b949e',
  'list.hoverBackground': '#2b3138',
  'list.focusBackground': '#2b3138',
  'list.activeSelectionBackground': '#2b3138',
  'list.activeSelectionForeground': '#e6edf3',
  'list.inactiveSelectionBackground': '#24292f',
  'list.hoverForeground': '#d7dce2',
  'list.highlightForeground': '#6ea8ff',
  'list.focusHighlightForeground': '#6ea8ff',
  'menu.background': '#24292f',
  'menu.foreground': '#d7dce2',
  'menu.selectionBackground': '#2b3138',
  'menu.selectionForeground': '#e6edf3',
  'menu.border': '#3a424b',
  'menu.separatorBackground': '#3a424b',
  'badge.background': '#2e6fd1',
  'badge.foreground': '#ffffff',
  'widget.border': '#3a424b',
  'editorWidget.background': '#24292f',
  'editorWidget.border': '#3a424b',
  'editorWidget.foreground': '#d7dce2',
  'editorSuggestWidget.background': '#24292f',
  'editorSuggestWidget.border': '#3a424b',
  'editorSuggestWidget.foreground': '#d7dce2',
  'editorSuggestWidget.selectedBackground': '#2b3138',
  'editorSuggestWidget.selectedForeground': '#e6edf3',
  'editorSuggestWidget.highlightForeground': '#6ea8ff',
  'editorSuggestWidget.focusHighlightForeground': '#6ea8ff',
  'editorSuggestWidgetStatus.foreground': '#8b949e',
  'editorHoverWidget.background': '#24292f',
  'editorHoverWidget.border': '#3a424b',
  'editorHoverWidget.foreground': '#d7dce2',
  'editorHoverWidget.highlightForeground': '#6ea8ff',
  'editorHoverWidget.statusBarBackground': '#2b3138',
  'editorStickyScroll.background': '#1e2227',
  'editorStickyScroll.border': '#2f363d',
  'editorStickyScrollHover.background': '#24292f',
  'minimap.background': '#1e2227',
  'scrollbarSlider.background': '#ffffff1f',
  'scrollbarSlider.hoverBackground': '#ffffff33',
  'scrollbarSlider.activeBackground': '#ffffff47',
  'diffEditor.insertedTextBackground': '#4fc08d2e',
  'diffEditor.removedTextBackground': '#e06c752e',
  'diffEditor.insertedLineBackground': '#4fc08d1a',
  'diffEditor.removedLineBackground': '#e06c751a',
  'diffEditorGutter.insertedLineBackground': '#4fc08d26',
  'diffEditorGutter.removedLineBackground': '#e06c7526',
  'diffEditor.diagonalFill': '#3a424b66',
  'diffEditor.border': '#3a424b',
  'diffEditorOverview.insertedForeground': '#4fc08dcc',
  'diffEditorOverview.removedForeground': '#e06c75cc',
};

export const KOJO_LIGHT_COLORS: Readonly<Record<string, string>> = {
  'editor.background': '#f6f8fa',
  'editor.foreground': '#1f2328',
  'editorLineNumber.foreground': '#6e7781',
  'editorLineNumber.activeForeground': '#1f2328',
  'editorLineNumber.dimmedForeground': '#afb8c1',
  'editorCursor.foreground': '#0550ae',
  /* 幽灵文本前景（口径与 dark 表那条注逐字相同）：通道 = 本档 `--fg` #1f2328，alpha 0.78。
     浅档的 alpha 是六档里最高的之一——不是手抖：浅底可读区间窄，本档最弱的一枚语法前景
     只有 4.54，整段再乘 0.7 就跌破 3.0（vendor 的缺省值 `#0007` = alpha 0.47，压浅底 2.1:1，
     等于"看得见但读不出"）。 */
  'editorGhostText.foreground': '#1f2328c7',
  // 当前行（C1）：`#eaeef2` 只有 1.095:1 ⇒ 抬到浅档的 `--bg-3` `#dde3ea`（**1.214:1**）。
  // 数字是同一条公式在**本套底色**上算的，不是抄 dark 那一格。
  'editor.lineHighlightBackground': '#dde3ea',
  'editor.lineHighlightBorder': '#dde3ea',
  'editor.selectionBackground': '#0a5cc248',
  'editor.inactiveSelectionBackground': '#0a5cc220',
  'editor.selectionHighlightBackground': '#0a5cc226',
  'editor.wordHighlightBackground': '#0a5cc21f',
  'editor.wordHighlightStrongBackground': '#0a5cc23d',
  'editor.findMatchBackground': '#d4a72c66',
  'editor.findMatchHighlightBackground': '#d4a72c38',
  'editor.findRangeHighlightBackground': '#0a5cc21a',
  'editorIndentGuide.background1': '#d8dee4',
  'editorIndentGuide.activeBackground1': '#afb8c1',
  'editorBracketMatch.background': '#0a5cc21f',
  'editorBracketMatch.border': '#0a5cc2',
  'editorBracketHighlight.foreground1': '#8250df',
  'editorBracketHighlight.foreground2': '#0550ae',
  'editorBracketHighlight.foreground3': '#0a6b73',
  'editorBracketHighlight.foreground4': '#953800',
  'editorBracketHighlight.foreground5': '#bf3989',
  'editorBracketHighlight.foreground6': '#116329',
  'editorBracketHighlight.unexpectedBracket.foreground': '#b4232e',
  'editorWhitespace.foreground': '#d0d7de',
  'editorRuler.foreground': '#e1e6eb',
  'editorGutter.background': '#f6f8fa',
  'editorOverviewRuler.background': '#f6f8fa',
  'editorOverviewRuler.border': '#d0d7de',
  'editorError.foreground': '#b4232e',
  'editorWarning.foreground': '#8a5a04',
  'editorInfo.foreground': '#0550ae',
  'editorLink.activeForeground': '#0550ae',
  // 全局部件色（find 输入 / 补全列表 / 右键菜单 / 徽章）：与浅色面同族，不留深色块
  focusBorder: '#0a5cc2',
  'input.background': '#ffffff',
  'input.border': '#d0d7de',
  'input.foreground': '#1f2328',
  'input.placeholderForeground': '#6e7781',
  'list.hoverBackground': '#eaeef2',
  'list.focusBackground': '#eaeef2',
  'list.activeSelectionBackground': '#dde3ea',
  'list.activeSelectionForeground': '#1f2328',
  'list.inactiveSelectionBackground': '#eaeef2',
  'list.hoverForeground': '#1f2328',
  'list.highlightForeground': '#0550ae',
  'list.focusHighlightForeground': '#0550ae',
  'menu.background': '#ffffff',
  'menu.foreground': '#1f2328',
  'menu.selectionBackground': '#dde3ea',
  'menu.selectionForeground': '#1f2328',
  'menu.border': '#d0d7de',
  'menu.separatorBackground': '#e1e6eb',
  'badge.background': '#0a5cc2',
  'badge.foreground': '#ffffff',
  'widget.border': '#d0d7de',
  'editorWidget.background': '#ffffff',
  'editorWidget.border': '#d0d7de',
  'editorWidget.foreground': '#1f2328',
  'editorSuggestWidget.background': '#ffffff',
  'editorSuggestWidget.border': '#d0d7de',
  'editorSuggestWidget.foreground': '#1f2328',
  'editorSuggestWidget.selectedBackground': '#dde3ea',
  'editorSuggestWidget.selectedForeground': '#1f2328',
  'editorSuggestWidget.highlightForeground': '#0550ae',
  'editorSuggestWidget.focusHighlightForeground': '#0550ae',
  'editorSuggestWidgetStatus.foreground': '#57606a',
  'editorHoverWidget.background': '#ffffff',
  'editorHoverWidget.border': '#d0d7de',
  'editorHoverWidget.foreground': '#1f2328',
  'editorHoverWidget.highlightForeground': '#0550ae',
  'editorHoverWidget.statusBarBackground': '#eaeef2',
  'editorStickyScroll.background': '#f6f8fa',
  'editorStickyScroll.border': '#d8dee4',
  'editorStickyScrollHover.background': '#eaeef2',
  'minimap.background': '#f6f8fa',
  'scrollbarSlider.background': '#091e421f',
  'scrollbarSlider.hoverBackground': '#091e4233',
  'scrollbarSlider.activeBackground': '#091e4247',
  'diffEditor.insertedTextBackground': '#0e6b2c26',
  'diffEditor.removedTextBackground': '#b4232e26',
  'diffEditor.insertedLineBackground': '#0e6b2c14',
  'diffEditor.removedLineBackground': '#b4232e14',
  'diffEditorGutter.insertedLineBackground': '#0e6b2c1f',
  'diffEditorGutter.removedLineBackground': '#b4232e1f',
  'diffEditor.diagonalFill': '#d0d7de66',
  'diffEditor.border': '#d0d7de',
  'diffEditorOverview.insertedForeground': '#0e6b2ccc',
  'diffEditorOverview.removedForeground': '#b4232ecc',
};

export const KOJO_MINT_COLORS: Readonly<Record<string, string>> = {
  'editor.background': '#0f1713',
  'editor.foreground': '#d9e9df',
  'editorLineNumber.foreground': '#6f8c7d',
  'editorLineNumber.activeForeground': '#d9e9df',
  'editorLineNumber.dimmedForeground': '#3f574a',
  'editorCursor.foreground': '#45d9ab',
  /* 幽灵文本前景（口径见 dark 表那条注）：通道 = 墨绿档 `--fg` #d9e9df，alpha 0.66——
     三套老主题里最"退一档"的一档，因为墨绿底上本档最弱的语法前景仍有 6.07，两把尺都松。 */
  'editorGhostText.foreground': '#d9e9dfa8',
  // 当前行（C1）：`#15201a` 只有 1.088:1 ⇒ 抬到墨绿档的 `--bg-3` `#1c2a23`（**1.219:1**）。
  // 绿底上抬"同一族更亮一档"，不掺中性灰（灰块在绿底上像另一套主题的残留）。
  'editor.lineHighlightBackground': '#1c2a23',
  'editor.lineHighlightBorder': '#1c2a23',
  'editor.selectionBackground': '#35d0a052',
  'editor.inactiveSelectionBackground': '#35d0a024',
  'editor.selectionHighlightBackground': '#35d0a03d',
  'editor.wordHighlightBackground': '#35d0a02e',
  'editor.wordHighlightStrongBackground': '#35d0a05c',
  'editor.findMatchBackground': '#d8a26966',
  'editor.findMatchHighlightBackground': '#d8a2693d',
  'editor.findRangeHighlightBackground': '#35d0a024',
  'editorIndentGuide.background1': '#243a30',
  'editorIndentGuide.activeBackground1': '#3d5a4b',
  'editorBracketMatch.background': '#35d0a029',
  'editorBracketMatch.border': '#35d0a0',
  'editorBracketHighlight.foreground1': '#c9a7f5',
  'editorBracketHighlight.foreground2': '#7cc7ff',
  'editorBracketHighlight.foreground3': '#74d6d0',
  'editorBracketHighlight.foreground4': '#dca023',
  'editorBracketHighlight.foreground5': '#ff9ba3',
  'editorBracketHighlight.foreground6': '#9ccf9a',
  'editorBracketHighlight.unexpectedBracket.foreground': '#ff9ba3',
  'editorWhitespace.foreground': '#2b3f35',
  'editorRuler.foreground': '#203028',
  'editorGutter.background': '#0f1713',
  'editorOverviewRuler.background': '#0f1713',
  'editorOverviewRuler.border': '#2b3f35',
  'editorError.foreground': '#e2707a',
  'editorWarning.foreground': '#d8a269',
  'editorInfo.foreground': '#7cc7ff',
  'editorLink.activeForeground': '#55dcb0',
  // 全局部件色（find 输入 / 补全列表 / 右键菜单 / 徽章）：换成墨绿面与薄荷 accent，
  // 不用 vs-dark 的中性灰（灰块在绿底上像另一套主题的残留）
  focusBorder: '#45d9ab',
  'input.background': '#1c2a23',
  'input.border': '#3d5a4b',
  'input.foreground': '#d9e9df',
  'input.placeholderForeground': '#88a896',
  'list.hoverBackground': '#1c2a23',
  'list.focusBackground': '#1c2a23',
  'list.activeSelectionBackground': '#1c2a23',
  'list.activeSelectionForeground': '#d9e9df',
  'list.inactiveSelectionBackground': '#15201a',
  'list.hoverForeground': '#d9e9df',
  'list.highlightForeground': '#55dcb0',
  'list.focusHighlightForeground': '#55dcb0',
  'menu.background': '#15201a',
  'menu.foreground': '#d9e9df',
  'menu.selectionBackground': '#1c2a23',
  'menu.selectionForeground': '#d9e9df',
  'menu.border': '#2b3f35',
  'menu.separatorBackground': '#2b3f35',
  'badge.background': '#12a37a',
  'badge.foreground': '#072118',
  'widget.border': '#2b3f35',
  'editorWidget.background': '#15201a',
  'editorWidget.border': '#2b3f35',
  'editorWidget.foreground': '#d9e9df',
  'editorSuggestWidget.background': '#15201a',
  'editorSuggestWidget.border': '#2b3f35',
  'editorSuggestWidget.foreground': '#d9e9df',
  'editorSuggestWidget.selectedBackground': '#1c2a23',
  'editorSuggestWidget.selectedForeground': '#d9e9df',
  'editorSuggestWidget.highlightForeground': '#55dcb0',
  'editorSuggestWidget.focusHighlightForeground': '#55dcb0',
  'editorSuggestWidgetStatus.foreground': '#88a896',
  'editorHoverWidget.background': '#15201a',
  'editorHoverWidget.border': '#2b3f35',
  'editorHoverWidget.foreground': '#d9e9df',
  'editorHoverWidget.highlightForeground': '#55dcb0',
  'editorHoverWidget.statusBarBackground': '#1c2a23',
  'editorStickyScroll.background': '#0f1713',
  'editorStickyScroll.border': '#243a30',
  'editorStickyScrollHover.background': '#15201a',
  'minimap.background': '#0f1713',
  'scrollbarSlider.background': '#35d0a02e',
  'scrollbarSlider.hoverBackground': '#35d0a04d',
  'scrollbarSlider.activeBackground': '#35d0a06b',
  'diffEditor.insertedTextBackground': '#62c77626',
  'diffEditor.removedTextBackground': '#e2707a26',
  'diffEditor.insertedLineBackground': '#62c77614',
  'diffEditor.removedLineBackground': '#e2707a14',
  'diffEditorGutter.insertedLineBackground': '#62c7761f',
  'diffEditorGutter.removedLineBackground': '#e2707a1f',
  'diffEditor.diagonalFill': '#2b3f3566',
  'diffEditor.border': '#2b3f35',
  'diffEditorOverview.insertedForeground': '#62c776cc',
  'diffEditorOverview.removedForeground': '#e2707acc',
};

/* ============ 2026-10-27 经典编辑器色批：One Dark / Rosé Pine / Synthwave '84 ============ */

/**
 * 三套新主题的调色板**按角色**写（LAU-2）：一张 34 档角色 + 5 条名字层的表。
 *
 * 上一代这里还分两条装配路（前三套四张分表 / 后三套一张 48 键表），LAU-2 之后合成一条：
 * 角色调色板 → `rulesFromRolePalette()`，名字层 → `nameLayerRules()`。一张表反而更好核：
 * 一屏能看全"这套主题到底给了几种色"，且角色名与键顺序由 `SEMANTIC_ROLES` 钉死，
 * 六个主题互相之间不再各有一套键名。
 *
 * 取色纪律与另三套**逐条相同**（判据由 `theme-color-gates.test.ts` 对 `THEME_IDS` 全量跑）：
 * 每条规则对 `editor.background` ≥ 4.5、主题内任意两枚不同前景 CIE76 ΔE ≥ 12、
 * `role.operator` 住在结构族（可读 / 弱于正文 / 彩度低于关键字 / 对全部基线档 ΔE ≥ 12）、
 * 跨语言同义档五组逐字同色、类型档（`role.type`）两门语言逐字同色。
 * 三套的实算读数写在各自表头（读数按改前的 token 名记，色值一格未动）。
 */
/**
 * One Dark（Atom 原味）——**本仓缺省 dark 的语法色本来就是它**。
 *
 * 这一点值得说清，否则会以为这一档"抄了自己"：`DARK_BASE_PALETTE` 的十一档
 * （`c678dd` 紫关键字 / `61afef` 蓝函数 / `e06c75` 红变量 / `98c379` 绿字符串 /
 * `d19a66` 橙数字 / `56b6c2` 青标签 / `e5c07b` 黄预处理）与 One Dark 官方
 * `tokenColors` **逐字同源**——差别只在底色：本仓用了 App 的 `#1e2227`，官方是 `#282c34`。
 * 所以这一档真正的产出是「把底色与面板还回官方，并让那套调色板在更亮的底上重新过闸」。
 *
 * **换底是要付账的**：底从 `#1e2227`（L 0.0157）抬到 `#282c34`（L 0.0250），同样的 4.5
 * 门槛把可用前景整体上推约 6%，于是原样搬过来的七档当场掉线（实测 4.30–4.47）。
 * 提亮后仍要守住 ΔE ≥ 12 —— 提亮会把色池往上压，**灰系与紫系最先挤在一起**：
 * - `comment` 退到偏暖的中性灰 `8e97a0`（不提更蓝：越蓝越靠近 `identifier` 与 `operator`，
 *   实测蓝移一档就撞到 ΔE 9.7）；
 * - `identifier` 提到 `b8bfca`（正文比官方 `abb2bf` 亮一档，把上沿让开给注释）；
 * - `operator` 留在 `7f9cc0`（结构族），**不往更饱和的蓝走**——`6d9ce0` 与函数蓝
 *   `61afef` 只差 ΔE 10.1；
 * - 2.0 的十五档**不搬 dark 那套**（那是 15 枚独立色，提亮后紫系凑不下），改为落到本盘
 *   近邻：锚点取亮粉 `ff5ec7`、声明取紫灰 `a194c9`、旁白取函数蓝、说话人取黄。
 *   独立色因此从 24 枚收到 15 枚。
 *
 * 实算（底 `#282c34`）：全部 48 档 ≥ 4.72；独立色 16 枚，最紧一对 `56b6c2 ↔ 61afce`
 * ΔE 12.6（这一对是既有三套就一直守着的"系统函数 vs 函数"微差，不是本批新造）。
 */
const ONE_DARK_PALETTE: RulePalette = {
  [ROLE.text]: 'b8bfca',
  [ROLE.comment]: '8e97a0',
  [ROLE.keyword]: 'c678dd',
  [ROLE.keywordAlias]: 'a194c9',
  [ROLE.keywordAlt]: 'c678dd',
  [ROLE.directive]: 'e5c07b',
  [ROLE.engine]: 'e8838c',
  [ROLE.engineFamily]: 'a194c9',
  [ROLE.operator]: '7f9cc0',
  [ROLE.operatorWord]: '56b6c2',
  [ROLE.operatorAlt]: '56b6c2',
  [ROLE.number]: 'd19a66',
  [ROLE.numberAlt]: 'd19a66',
  [ROLE.string]: '98c379',
  [ROLE.escape]: 'd19a66',
  [ROLE.interp]: 'd19a66',
  [ROLE.interpDelimiter]: 'd19a66',
  [ROLE.interpAlt]: 'd19a66',
  [ROLE.punctuation]: '7f9cc0',
  [ROLE.speech]: '98c379',
  [ROLE.speaker]: 'e5c07b',
  [ROLE.narration]: '61afef',
  [ROLE.hint]: 'e8838c',
  [ROLE.cont]: 'e5c07b',
  [ROLE.slot]: '5cc9a8',
  [ROLE.pronoun]: 'e8838c',
  [ROLE.variable]: 'e8838c',
  [ROLE.label]: '56b6c2',
  [ROLE.decl]: '61afef',
  [ROLE.declaration]: 'a194c9',
  [ROLE.call]: '61afce',
  [ROLE.type]: 'b3bd47',
  [ROLE.raw]: 'b0a89a',
  [ROLE.anchor]: 'ff5ec7',

  // 名字层五条（D6：与语法角色正交；键是 Monaco 语义 token 的 type.modifier 串）
  'function': '61afef',
  'function.declaration': '61afef',
  'parameter': 'd19a66',
  'variable.declaration': 'e5c07b',
  'variable.declaration.readonly': 'e5c07b',
};

/**
 * Rosé Pine —— 玫瑰灰紫、低饱和、近黑的底（官方 base `#191724`）。
 *
 * 官方那 9 枚色里有两枚**在这个 App 的判据下不可用**，这是本档唯一的取舍：
 * - `muted #6e6a86`（官方注释色）压 `#191724` 只有 3.0 ⇒ 注释改用 `subtle #908caa`；
 * - `pine #31748f`（官方深青）只有 3.4 ⇒ `operator` 用它**提亮版** `5fa0b8`
 *   （同色相、同"深青"身份，只把明度抬到过线；对 `identifier` 仍明显退让，彩度 24 < 关键字 36）。
 *
 * 留下来的是它真正的身份：`iris #c4a7e7` 关键字、`foam #9ccfd8` 函数/标签、
 * `gold #f6c177` 字符串与数字、`rose #ebbcba` 变量与台词、`love #eb6f92` 常量与警示。
 * 底够黑（L* 8.5），所以这套是三套新主题里对比度余量最大的：最弱 `#908caa` 5.48、
 * 独立色 10 枚、最紧一对 ΔE 19.6 —— 不需要任何额外提亮就整块过闸。
 *
 * 两枚"外借"色（Rosé Pine 官方九枚里没有对应档）：
 * - `keyword.raw` 取 `9d9489`（暖灰）——官方把原生直通直接用正文色，会与 `identifier`
 *   同色；这枚把"不解释的原文"与注释、正文两条灰线都拉开。
 * - `support.type` 取灰橄榄 `94a06e`——**不取上游那枚满彩的 `96b458`**：本盘九枚的彩度
 *   中位只有 18（最艳的 `eb6f92` 也才 51），塞一枚 C50 的亮绿橄榄会像异物。`94a06e` 的
 *   C28 落在盘内典型区间，对底 6.32（与本盘最弱档同水平），对最近的一枚暖灰 `9d9489`
 *   ΔE 22.8。色相仍守在"黄绿/橄榄"这一族——与另五套主题同一支，换档时"类型"不会跳色相。
 */
const ROSE_PINE_PALETTE: RulePalette = {
  [ROLE.text]: 'e0def4',
  [ROLE.comment]: '908caa',
  [ROLE.keyword]: 'c4a7e7',
  [ROLE.keywordAlias]: '908caa',
  [ROLE.keywordAlt]: 'c4a7e7',
  [ROLE.directive]: 'f6c177',
  [ROLE.engine]: 'eb6f92',
  [ROLE.engineFamily]: 'c4a7e7',
  [ROLE.operator]: '5fa0b8',
  [ROLE.operatorWord]: '5fa0b8',
  [ROLE.operatorAlt]: '5fa0b8',
  [ROLE.number]: 'eb6f92',
  [ROLE.numberAlt]: 'eb6f92',
  [ROLE.string]: 'f6c177',
  [ROLE.escape]: 'eb6f92',
  [ROLE.interp]: 'f6c177',
  [ROLE.interpDelimiter]: 'f6c177',
  [ROLE.interpAlt]: 'f6c177',
  [ROLE.punctuation]: '908caa',
  [ROLE.speech]: 'ebbcba',
  [ROLE.speaker]: 'ebbcba',
  [ROLE.narration]: '9ccfd8',
  [ROLE.hint]: 'eb6f92',
  [ROLE.cont]: 'f6c177',
  [ROLE.slot]: '9ccfd8',
  [ROLE.pronoun]: 'eb6f92',
  [ROLE.variable]: 'ebbcba',
  [ROLE.label]: '9ccfd8',
  [ROLE.decl]: '9ccfd8',
  [ROLE.declaration]: 'c4a7e7',
  [ROLE.call]: '9ccfd8',
  [ROLE.type]: '94a06e',
  [ROLE.raw]: '9d9489',
  [ROLE.anchor]: 'eb6f92',

  // 名字层五条（D6：与语法角色正交；键是 Monaco 语义 token 的 type.modifier 串）
  'function': '9ccfd8',
  'function.declaration': '9ccfd8',
  'parameter': 'f6c177',
  'variable.declaration': 'eb6f92',
  'variable.declaration.readonly': 'eb6f92',
};

/**
 * Synthwave '84 —— 深紫底 + 霓虹粉青，参考 robb0wen/synthwave-vscode。
 *
 * **官方色板整块过闸，一档未改**（这是本批最意外的一件事，值得记下来）：
 * 底 `#262335` 够黑（L* 14.8），官方那十枚霓虹色压上去最弱的一档 `comment #848bbd`
 * 仍有 **4.66:1**，而它们的色相跨度大到两两 ΔE 最小也有 13.6。以往"霓虹主题必然
 * 有一半过不了 AA"的直觉，在这个底上不成立 —— 前提是底真的够暗（比 App 缺省 dark 还暗半档）。
 *
 * 十一枚独立色与它们的语义（顺序＝官方 tokenColors 的主干，末一枚是本盘自造）：
 * `fede5d` 黄=关键字 / `36f9f6` 青=函数、标签、旁白、字符串转义 / `ff7edb` 粉=变量、代词、
 * 锚点、提示 / `ff8b39` 橙=字符串、插值、说话人 / `f97e72` 珊瑚=数字、预处理、参数 /
 * `72f1b8` 薄荷=台词、名字层、糖运算符 / `b893ce` 紫=结构标点+声明（operator 那一族）/
 * `848bbd` 蓝灰=注释 / `eae6f5` 正文 / `a09ab8` 冷灰紫=原生直通 / `a8cf4e` 酸柠檬=类型。
 *
 * 三处**不是官方原值**的地方：
 * - `keyword.raw`（原生直通）`a09ab8`：官方没有对应档（它把围栏体当正文），这是本盘自造，
 *   取"冷灰紫"是为了同时离开注释 `848bbd`（ΔE 13.6）与正文；
 * - `operator` 用 `b893ce` 而不是官方的黄 `fede5d`：官方把运算符与关键字同色，而本仓
 *   判据要求运算符**彩度低于关键字**（标点是骨架不是内容）。紫色在本盘是现成的结构族
 *   （官方 `gitDecoration.modified` 就是它），拿来做标点既守判据又不出戏；
 * - `support.type` 取酸柠檬 `a8cf4e`：官方没有类型档。这一档要落在黄绿那条窄带上
 *   （另五套主题都在这一族，换档时"类型"不该跳色相），而本盘的黄已被关键字占死，
 *   于是往绿侧偏 20° —— 对关键字黄 ΔE 31.4（读不成"第二种黄"）、对台词薄荷 45.2、
 *   对底 8.51；C57 与本盘彩度中位 51 同档，霓虹盘里不显脏。
 */
const SYNTHWAVE84_PALETTE: RulePalette = {
  [ROLE.text]: 'eae6f5',
  [ROLE.comment]: '848bbd',
  [ROLE.keyword]: 'fede5d',
  [ROLE.keywordAlias]: 'b893ce',
  [ROLE.keywordAlt]: 'fede5d',
  [ROLE.directive]: 'f97e72',
  [ROLE.engine]: 'ff7edb',
  [ROLE.engineFamily]: 'b893ce',
  [ROLE.operator]: 'b893ce',
  [ROLE.operatorWord]: '72f1b8',
  [ROLE.operatorAlt]: 'b893ce',
  [ROLE.number]: 'f97e72',
  [ROLE.numberAlt]: 'f97e72',
  [ROLE.string]: 'ff8b39',
  [ROLE.escape]: '36f9f6',
  [ROLE.interp]: 'ff8b39',
  [ROLE.interpDelimiter]: 'ff8b39',
  [ROLE.interpAlt]: 'ff8b39',
  [ROLE.punctuation]: 'b893ce',
  [ROLE.speech]: '72f1b8',
  [ROLE.speaker]: 'ff8b39',
  [ROLE.narration]: '36f9f6',
  [ROLE.hint]: 'ff7edb',
  [ROLE.cont]: 'fede5d',
  [ROLE.slot]: '72f1b8',
  [ROLE.pronoun]: 'ff7edb',
  [ROLE.variable]: 'ff7edb',
  [ROLE.label]: '36f9f6',
  [ROLE.decl]: '36f9f6',
  [ROLE.declaration]: 'b893ce',
  [ROLE.call]: '36f9f6',
  [ROLE.type]: 'a8cf4e',
  [ROLE.raw]: 'a09ab8',
  [ROLE.anchor]: 'ff7edb',

  // 名字层五条（D6：与语法角色正交；键是 Monaco 语义 token 的 type.modifier 串）
  'function': '36f9f6',
  'function.declaration': '36f9f6',
  'parameter': 'f97e72',
  'variable.declaration': 'fede5d',
  'variable.declaration.readonly': 'fede5d',
};

/**
 * 部件色的**生成器**：91 键的键表只写一次，三套主题各给 18 枚种子。
 *
 * 为什么不学既有三套逐键手写：那三张表各 91 行，加一套就是 91 行 × 3，而且**彼此会漂**
 * （同一件事 `list.hoverBackground` 在某套用了 `--bg-3`、另一套用了 `--bg-2`，漂了没人
 * 看得出来——`inherit: false` 下漏键才会露底，取值不一致就只是"手感不一样"）。
 * 键表写一次、种子各给一份，于是三套新主题的部件色**取值逻辑完全相同**，差异只剩种子。
 *
 * 取色口径（与 `KOJO_DARK_COLORS` 的既有约定对齐，注释见那张表）：
 * - 所有半透明档一律由种子色拼 alpha（`${seed}59`），**不新造色**；
 * - 字色类（`input.foreground` / `list.*Foreground`）一律用正文或强调文字档；
 * - 当前行 = 该档 `--bg-3`（1.18–1.25 那一档薄抬升，理由见 `KOJO_DARK_COLORS` 的 C1 注）。
 */
interface ColorSeeds {
  /** 编辑器底（必须与 `themes/<id>.css` 的 `--bg` 逐字相等，测试钉住） */
  readonly bg: string;
  /** 正文（必须与 `--fg` 逐字相等） */
  readonly fg: string;
  /** 次要文字 / 行号 */
  readonly dim: string;
  /** 更暗一档：暗行号、缩进参考线、分隔线（不承载语义文字） */
  readonly dimDeep: string;
  /** 当前行抬升 = 该档 `--bg-3` */
  readonly lineHi: string;
  /** 面板 / 列表悬停底 */
  readonly panel: string;
  /** 浮层底（菜单 / 补全 / hover / 输入框下落面） */
  readonly overlay: string;
  readonly accent: string;
  /** accent 当文字用（光标 / 链接 / 高亮字） */
  readonly accentText: string;
  readonly indent: string;
  readonly indentActive: string;
  readonly brackets: readonly [string, string, string, string, string, string];
  readonly red: string;
  readonly amber: string;
  readonly green: string;
  readonly badgeBg: string;
  readonly badgeFg: string;
  /** 滚动条滑块基色（透明度由生成器统一给三档） */
  readonly slider: string;
  /**
   * 幽灵文本的 alpha（**两枚 hex 字符**，= 该档 `themes/<id>.css` 里 `--ghost-text` 的 alpha 落位）。
   * 通道不另给种子——它**就是** `fg` 的通道（"幽灵文本 = 正文色退一档"，见 `editorGhostText.foreground`
   * 那条注），所以这里只能翻"退多少"。逐档取数理由在各自主题文件里。
   */
  readonly ghostAlpha: string;
}

function buildColors(s: ColorSeeds): Readonly<Record<string, string>> {
  return {
    'editor.background': s.bg,
    'editor.foreground': s.fg,
    'editorLineNumber.foreground': s.dim,
    'editorLineNumber.activeForeground': s.fg,
    'editorLineNumber.dimmedForeground': s.dimDeep,
    'editorCursor.foreground': s.accentText,
    /* 幽灵文本前景：通道 = 正文（`s.fg`，与 `--fg` 逐字相等，已由 editor.foreground 那格钉住），
       alpha = `s.ghostAlpha`（该档 `--ghost-text` / `--ghost-text-opacity` 的同一枚数）。
       不给 background / border，理由见 `KOJO_DARK_COLORS` 里那格的分节注。 */
    'editorGhostText.foreground': `${s.fg}${s.ghostAlpha}`,
    // 当前行（C1）：border 与 background 同色 ⇒ 不画描边（理由见 KOJO_DARK_COLORS 同键注）
    'editor.lineHighlightBackground': s.lineHi,
    'editor.lineHighlightBorder': s.lineHi,
    'editor.selectionBackground': `${s.accent}59`,
    'editor.inactiveSelectionBackground': `${s.accent}29`,
    'editor.selectionHighlightBackground': `${s.accent}3d`,
    'editor.wordHighlightBackground': `${s.accent}2e`,
    'editor.wordHighlightStrongBackground': `${s.accent}5c`,
    'editor.findMatchBackground': `${s.amber}66`,
    'editor.findMatchHighlightBackground': `${s.amber}38`,
    'editor.findRangeHighlightBackground': `${s.accent}24`,
    'editorIndentGuide.background1': s.indent,
    'editorIndentGuide.activeBackground1': s.indentActive,
    'editorBracketMatch.background': `${s.accent}29`,
    'editorBracketMatch.border': s.accent,
    'editorBracketHighlight.foreground1': s.brackets[0],
    'editorBracketHighlight.foreground2': s.brackets[1],
    'editorBracketHighlight.foreground3': s.brackets[2],
    'editorBracketHighlight.foreground4': s.brackets[3],
    'editorBracketHighlight.foreground5': s.brackets[4],
    'editorBracketHighlight.foreground6': s.brackets[5],
    'editorBracketHighlight.unexpectedBracket.foreground': s.red,
    'editorWhitespace.foreground': s.indent,
    'editorRuler.foreground': s.lineHi,
    'editorGutter.background': s.bg,
    'editorOverviewRuler.background': s.bg,
    'editorOverviewRuler.border': s.indentActive,
    'editorError.foreground': s.red,
    'editorWarning.foreground': s.amber,
    'editorInfo.foreground': s.accentText,
    'editorLink.activeForeground': s.accentText,
    focusBorder: s.accent,
    'input.background': s.lineHi,
    'input.border': s.indentActive,
    'input.foreground': s.fg,
    'input.placeholderForeground': s.dim,
    'list.hoverBackground': s.lineHi,
    'list.focusBackground': s.lineHi,
    'list.activeSelectionBackground': s.lineHi,
    'list.activeSelectionForeground': s.fg,
    'list.inactiveSelectionBackground': s.panel,
    'list.hoverForeground': s.fg,
    'list.highlightForeground': s.accentText,
    'list.focusHighlightForeground': s.accentText,
    'menu.background': s.overlay,
    'menu.foreground': s.fg,
    'menu.selectionBackground': s.lineHi,
    'menu.selectionForeground': s.fg,
    'menu.border': s.indentActive,
    'menu.separatorBackground': s.indentActive,
    'badge.background': s.badgeBg,
    'badge.foreground': s.badgeFg,
    'widget.border': s.indentActive,
    'editorWidget.background': s.overlay,
    'editorWidget.border': s.indentActive,
    'editorWidget.foreground': s.fg,
    'editorSuggestWidget.background': s.overlay,
    'editorSuggestWidget.border': s.indentActive,
    'editorSuggestWidget.foreground': s.fg,
    'editorSuggestWidget.selectedBackground': s.lineHi,
    'editorSuggestWidget.selectedForeground': s.fg,
    'editorSuggestWidget.highlightForeground': s.accentText,
    'editorSuggestWidget.focusHighlightForeground': s.accentText,
    'editorSuggestWidgetStatus.foreground': s.dim,
    'editorHoverWidget.background': s.overlay,
    'editorHoverWidget.border': s.indentActive,
    'editorHoverWidget.foreground': s.fg,
    'editorHoverWidget.highlightForeground': s.accentText,
    'editorHoverWidget.statusBarBackground': s.lineHi,
    'editorStickyScroll.background': s.bg,
    'editorStickyScroll.border': s.indent,
    'editorStickyScrollHover.background': s.panel,
    'minimap.background': s.bg,
    'scrollbarSlider.background': `${s.slider}30`,
    'scrollbarSlider.hoverBackground': `${s.slider}50`,
    'scrollbarSlider.activeBackground': `${s.slider}70`,
    'diffEditor.insertedTextBackground': `${s.green}2e`,
    'diffEditor.removedTextBackground': `${s.red}2e`,
    'diffEditor.insertedLineBackground': `${s.green}1a`,
    'diffEditor.removedLineBackground': `${s.red}1a`,
    'diffEditorGutter.insertedLineBackground': `${s.green}26`,
    'diffEditorGutter.removedLineBackground': `${s.red}26`,
    'diffEditor.diagonalFill': `${s.indentActive}66`,
    'diffEditor.border': s.indentActive,
    'diffEditorOverview.insertedForeground': `${s.green}cc`,
    'diffEditorOverview.removedForeground': `${s.red}cc`,
  };
}

/**
 * One Dark 的部件色种子。底/正文与 `themes/one-dark.css` 的 `--bg/--fg` 逐字相等
 * （`#282c34` / `#b8bfca`）；`lineHi` 取 `#333944`——官方面板 `#3e4451` 压在 `#282c34` 上是
 * **1.43:1**，作为"当前行"太重（那是"被选中"的量级），故取只抬 1.21:1 的一档。
 */
const ONE_DARK_COLORS = buildColors({
  bg: '#282c34',
  fg: '#b8bfca',
  dim: '#8e97a0',
  dimDeep: '#5a626e',
  lineHi: '#333944',
  panel: '#2c313a',
  overlay: '#21252b',
  accent: '#61afef',
  accentText: '#7cc4ff',
  indent: '#3b4048',
  indentActive: '#4b5263',
  brackets: ['#c678dd', '#61afef', '#56b6c2', '#e5c07b', '#e8838c', '#98c379'],
  red: '#e8838c',
  amber: '#e5c07b',
  green: '#98c379',
  badgeBg: '#2e6fd1',
  badgeFg: '#ffffff',
  slider: '#4b5263',
  ghostAlpha: 'c2', // 0.76 —— 理由见 themes/one-dark.css 的幽灵文本档注
});

const ROSE_PINE_COLORS = buildColors({
  bg: '#191724',
  fg: '#e0def4',
  dim: '#908caa',
  dimDeep: '#524f67',
  // 官方 overlay `#26233a` 只有 1.10:1（几乎看不出），抬到 #2c2843 = 1.19:1
  lineHi: '#2c2843',
  panel: '#1f1d2e',
  overlay: '#1f1d2e',
  accent: '#c4a7e7',
  accentText: '#d4c0f2',
  indent: '#26233a',
  indentActive: '#403d52',
  brackets: ['#c4a7e7', '#9ccfd8', '#f6c177', '#ebbcba', '#eb6f92', '#908caa'],
  red: '#eb6f92',
  amber: '#f6c177',
  green: '#8fc7a8',
  badgeBg: '#c4a7e7',
  badgeFg: '#191724',
  slider: '#524f67',
  ghostAlpha: 'ad', // 0.68 —— 六档里最"退一档"的一档（底最黑、余量最大），理由见 themes/rose-pine.css
});

const SYNTHWAVE84_COLORS = buildColors({
  bg: '#262335',
  fg: '#eae6f5',
  dim: '#9a92b8',
  dimDeep: '#5c5470',
  // 官方没有 lineHighlightBackground（只有一条 40% 的紫描边）；按"抬 1.22:1"自算得 #362e52
  lineHi: '#362e52',
  panel: '#241b2f',
  overlay: '#1f1932',
  accent: '#ff7edb',
  accentText: '#ff9ce6',
  indent: '#3a3352',
  indentActive: '#4d4470',
  brackets: ['#ff7edb', '#36f9f6', '#fede5d', '#72f1b8', '#ff8b39', '#b893ce'],
  red: '#ff6b73',
  amber: '#fede5d',
  green: '#72f1b8',
  badgeBg: '#ff7edb',
  badgeFg: '#1b0f26',
  slider: '#b893ce',
  ghostAlpha: 'bd', // 0.74 —— 霓虹盘不敢更淡（低 alpha 的霓虹字会读成"背景另一团光"），理由见 themes/synthwave84.css
});

/* ------------------------------ 装配 ------------------------------ */

/** 一次性定义六套主题（幂等；`registerErbLanguage` 末尾调用） */
export function defineMonacoThemes(monaco: typeof Monaco): void {
  // K2-SURFACE-DEFAULT：v1 三套**无条件**带 2.0 token 规则（见 `darkRules` 上方头注）——
  // 默认档打开 `.kojo2` 就有配色，不必先切流。部件色与 v1 规则一格未动。
  monaco.editor.defineTheme('kojo-dark', {
    base: 'vs-dark',
    inherit: false,
    rules: darkRules(),
    colors: KOJO_DARK_COLORS,
  });
  monaco.editor.defineTheme('kojo-light', {
    base: 'vs',
    inherit: false,
    rules: lightRules(),
    colors: KOJO_LIGHT_COLORS,
  });
  monaco.editor.defineTheme('kojo-mint-dark', {
    base: 'vs-dark',
    inherit: false,
    rules: mintRules(),
    colors: KOJO_MINT_COLORS,
  });
  // 2026-10-27 经典编辑器色三套：base 一律 `vs-dark`（三套都是深色；`inherit: false` 下
  // base 只决定 Monaco 内部几个"深浅行为"开关——滚动条惯性、缩略图对比归一化——不供色）。
  monaco.editor.defineTheme('kojo-one-dark', {
    base: 'vs-dark',
    inherit: false,
    rules: rulesFromPalettes(ONE_DARK_PALETTE, ONE_DARK_PALETTE),
    colors: ONE_DARK_COLORS,
  });
  monaco.editor.defineTheme('kojo-rose-pine', {
    base: 'vs-dark',
    inherit: false,
    rules: rulesFromPalettes(ROSE_PINE_PALETTE, ROSE_PINE_PALETTE),
    colors: ROSE_PINE_COLORS,
  });
  monaco.editor.defineTheme('kojo-synthwave84', {
    base: 'vs-dark',
    inherit: false,
    rules: rulesFromPalettes(SYNTHWAVE84_PALETTE, SYNTHWAVE84_PALETTE),
    colors: SYNTHWAVE84_COLORS,
  });
  // Kojo 2.0 三套主题（K2 batch-3，flag 守卫）：与 v1 三套**不同 id**（`kojo2-*`），
  // 不覆盖、不继承，重复注册由 `applyAllMonacoLanguageThemes` 的 WeakSet 幂等挡掉。
  //
  // **SDK B4 起这三套不是本文件定义的**：规则（按 `role.*` 铺）与主题身份在供方
  // （`@kojo/kojo-lang/monaco-theme` 经 `@kojo/plugin-kojo-lang` 交进槽 `ui.monaco.language`），
  // 这里只把槽里的声明落成 `defineTheme`——91 键部件色仍由宿主补（`componentPalette` 那一侧），
  // 因为它是编辑器 chrome 不是语言事实（六套 `kojo-*` 与三套 `kojo2-*` 共用同一批 values）。
  //
  // 为什么仍是**动态 import**：落点模块静态引着本文件的部件色表，而 `kojo2-*` 目前没有任何
  // 消费方（用户面切的仍是 v1 三套，而 v1 三套此时已各自带上了 2.0 规则）。flag 关时连这一份
  // 都不加载（独立主题是切流面）。
  // 失败不静默：v1 三套已经定义完，这里只少 2.0 那三套，用一条 warn 说出来。
  if (isKojo2CutoverEnabled()) {
    void import('./monaco-language-surface')
      .then((module) => {
        module.applyAllMonacoLanguageThemes(monaco, { absentIsVisible: true });
      })
      .catch((error: unknown) => {
        console.warn(
          `[theme] Kojo 2.0 主题注册失败（v1 三套不受影响，2.0 文件会按 v1 主题上色）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  // Synthwave '84 的"关键字霓虹光"（仿 robb0wen/synthwave-vscode 的 Neon Dreams）。
  // 它按**颜色**去 Monaco 生成的 `.mtk<N> { color: #fede5d }` 表里找序号，本函数跑在语言
  // 注册时、比那张表更早 ⇒ 这里只排一次有限重试兜开机早到的情况；**真正的确定点**是
  // `applyMonacoTheme` 里 `setTheme` 之后那一发（见该函数）。找不到就什么都不做。
  scheduleKeywordGlow();
}
