import type * as Monaco from './entry';
// PS-10 断链：两张规则数组下沉到零 import 叶子 `kojo-theme-rules.ts`——它们的**老家**
// （`kojo-language.ts` / `kojo-semantic-tokens.ts`）各自拖着 `@kojo/plugin-kojo-sugar`
// 词表链，本文件在开机静态图里（diff-view / QuickFixPreviewOverlay 都经它），
// 直接 import 老家就等于把糖包静态挂回开机图。叶子与两个老家的关系见叶子头注。
//
// K2-CUTOVER-THEME：2.0 的 token 规则表也住在同一叶子（同一理由——不能经
// `kojo2-language.ts` 取，那条链拖糖词表）。它们**无条件追加**进三套 v1 主题
// （K2-SURFACE-DEFAULT），于是 `.kojo2` 文件在 `kojo-*` 主题下也上色，不必整窗切主题。
import {
  KOJO_SUGAR_THEME_RULES,
  KOJO_SEMANTIC_THEME_RULES,
  KOJO2_LIGHT_THEME_RULES,
  KOJO2_MINT_THEME_RULES,
  KOJO2_THEME_RULES,
} from './kojo-theme-rules';
// K2 batch-3：2.0 三套主题的注册闸。flag 模块零依赖（只读 localStorage），静态引它
// 不破坏上面那条 PS-10 断链；主题数据本身（`kojo2-theme`）仍走**动态 import**（见
// `defineMonacoThemes` 末尾）。
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';

/**
 * Monaco 三套主题（2026-10-17 反馈 3：编辑器配色跟随主题）。
 *
 * 主题 id 与 `ui/theme-pref.ts` 的三档**逐字对应**，但本模块不 import 那个 UI 模块——
 * monaco 层只认识自己的联合类型，避免 UI → monaco → UI 的反向依赖；两边联合类型相同
 * 由 `tests/monaco-theme.test.ts` 用 `THEME_IDS` 做一一映射断言钉住。
 *
 * ## 取色口径
 * - **dark**：沿用既有 `kojo-dark` 的语法色（ERB 基线 + 糖 + 语义），底色从 vs-dark 的
 *   `#1e1e1e` 改为 app 的 `--bg` `#1e2227`，编辑器与外壳同底；
 * - **light**：VS Code Light+ 气质，深蓝/橄榄绿/赭石/紫四族压浅底；不复用任何暗色前景；
 * - **mint-dark**：与 `themes/mint-dark.css` 的墨绿底 `#0f1713` 协调的冷薄荷族。
 *
 * **`operator` 档住哪儿**（ERB 半角运算符 + 全角标点、`.kojo` 表达式的 `()+[]`）：
 * 标点在屏上是骨架不是内容，所以它必须**比正文弱**（对比度低于同套 `identifier`）、
 * **比注释强且肉眼可分**（CIE76 ΔE ≥ 12，判据同 `kojo-token-tiers.test.ts` 的"撞色 = 假分层"），
 * 且**不引入新色相**——三套各取本套既有的"冷色结构族"一档：
 * dark `7f9cc0`、mint `8fb3c9` 即本套的标点/分隔符族（与 `sugar.speech.delimiter`/`sugar.colon`
 * 同色：同一枚 `「` 在两门语言里必须同色）；light 的分隔符族 2026-10-26 色值批从 `5b6b7f`
 * 抬到同族更蓝的 `335f96`（旧值与其注释色 `57606a` ΔE 只有 7.6 ⇒ 台词标点会读成注释），
 * 于是 light 的 operator 取同族更深一档 `35526f`（与分隔符 ΔE 16.6，对全部基线档 ≥ 12）。
 * 三套的 operator 彩度都低于各自关键字档 ⇒ 运算符不抢关键字。
 *
 * `inherit: false`：三套都写全规则，不从基底主题借色（避免切到 light 时残留 vs-dark 的
 * 深色 token / 部件色）。dark 的糖与语义规则**对象原样复用**（`kojo-token-tiers.test.ts`
 * 有同引用断言），light/mint 只按 token 换前景，token 集合因此永远同源。
 *
 * **底色口径（2026-10-26 判据批）**：`inherit: false` 意味着 `editor.background` 就是量
 * 对比度的那块底（dark `#1e2227` / light `#f6f8fa` / mint `#0f1713`），**不是** vs-dark 基底
 * 的 `#1e1e1e`。判据一律从 `colors['editor.background']` 取值（`kojo-token-tiers.test.ts` /
 * `theme-color-gates.test.ts`），不许再写字面量。
 */

export type MonacoThemeId = 'kojo-dark' | 'kojo-light' | 'kojo-mint-dark';

/** 与 `ui/theme-pref.ts` 的 `ThemePref` 逐字同形（不 import，理由见头注） */
export type MonacoThemePref = 'dark' | 'light' | 'mint-dark';

const THEME_ID_BY_PREF: Readonly<Record<string, MonacoThemeId>> = {
  dark: 'kojo-dark',
  light: 'kojo-light',
  'mint-dark': 'kojo-mint-dark',
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
    if (id !== null) sink.editor.setTheme(id);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0); // node / 老内核：退化为宏任务，请求绝不丢
}

/* ------------------------------ 规则构建 ------------------------------ */

interface BaseRuleSpec {
  readonly token: string;
  readonly fontStyle?: 'bold' | 'italic';
}

/** 词法基线 token（三套主题都必须覆盖；字体样式与既有 kojo-dark 一致） */
const BASE_RULE_SPECS: readonly BaseRuleSpec[] = [
  { token: 'comment', fontStyle: 'italic' },
  { token: 'keyword' },
  { token: 'keyword.preprocessor' },
  { token: 'entity.name.function', fontStyle: 'bold' },
  { token: 'variable' },
  { token: 'string' },
  { token: 'number' },
  { token: 'label' },
  { token: 'identifier' },
  // 运算符 / 标点族（ERB 的半角运算符与全角标点、`.kojo` 的 `()+[]` 共用这一档；
  // 上一批只给全角标点定了 token 归属，调色板这三格是留下的欠账）
  { token: 'operator' },
  { token: 'string.escape' },
];

function ruleOf(token: string, foreground: string, fontStyle?: string): Monaco.editor.ITokenThemeRule {
  return fontStyle === undefined ? { token, foreground } : { token, foreground, fontStyle };
}

function rulesFromPalette(
  specs: readonly BaseRuleSpec[],
  palette: Readonly<Record<string, string>>,
): Monaco.editor.ITokenThemeRule[] {
  return specs.map((spec) => {
    const foreground = palette[spec.token];
    if (foreground === undefined) {
      throw new Error(`[monaco-theme] 调色板缺少 token「${spec.token}」`);
    }
    return ruleOf(spec.token, foreground, spec.fontStyle);
  });
}

/**
 * 把一套既有规则按 token 换前景（字体样式原样保留）。源规则决定 token 集合，
 * 目标调色板漏一个就当场抛——"少配一档"在模块加载期变红，而不是静默掉色。
 */
function retint(
  source: readonly Monaco.editor.ITokenThemeRule[],
  palette: Readonly<Record<string, string>>,
): Monaco.editor.ITokenThemeRule[] {
  return source.map((rule) => {
    const foreground = palette[rule.token];
    if (foreground === undefined) {
      throw new Error(`[monaco-theme] 调色板缺少 token「${rule.token}」`);
    }
    return ruleOf(rule.token, foreground, rule.fontStyle);
  });
}

/* ------------------------------ 语法色 ------------------------------ */

/**
 * 既有 dark 词法基线（与改造前 `kojo-dark` 逐字同色，只改了 `comment` 一枚——见下）。
 */
const DARK_BASE_PALETTE: Readonly<Record<string, string>> = {
  // 2026-10-26 对比度批：注释色 6a737d 压真底 #1e2227 只有 3.32（此前按 vs-dark #1e1e1e
  // 量出 3.46，两笔都不够 4.5）。提亮到中性灰 879098（4.93），色相不动；
  // 同时把 2.0 注释 6a8f9a 并到同一个灰上（"注释"在两门语言里是一档）。
  comment: '879098',
  keyword: 'c678dd',
  'keyword.preprocessor': 'e5c07b',
  'entity.name.function': '61afef',
  variable: 'e06c75',
  string: '98c379',
  number: 'd19a66',
  label: '56b6c2',
  // 标点/运算符档 = 本套分隔符族（与 sugar.speech.delimiter / sugar.colon 同色，
  // 同一枚 `「` 在 ERB 与 .kojo 里必须同色）；比正文 abb2bf 弱、与注释 6a737d 肉眼可分
  operator: '7f9cc0',
  identifier: 'abb2bf',
  'string.escape': 'd19a66',
};

/** Light+ 气质：深蓝 = 函数/系统函数，橄榄绿 = 台词/字符串，赭石 = 数字/插值，紫 = 关键字 */
const LIGHT_BASE_PALETTE: Readonly<Record<string, string>> = {
  comment: '57606a',
  keyword: '8250df',
  'keyword.preprocessor': '953800',
  'entity.name.function': '0550ae',
  variable: 'b4232e',
  string: '116329',
  number: '953800',
  label: '0a6b73',
  // 同一支冷色结构族，但**不能**直取本套分隔符档——旧 5b6b7f 与浅底注释色 57606a
  // 的 CIE76 ΔE 只有 7.6（肉眼同色），台词标点会读成注释；取同族更深一档 35526f
  // （ΔE 对全部基线档 ≥ 12）。2026-10-26 色值批把分隔符本身抬到 335f96（见下），
  // 于是这枚算子档与它差 16.6，两档都留在"冷色结构族"。
  operator: '35526f',
  identifier: '24292f',
  'string.escape': 'b35900',
};

const LIGHT_SUGAR_PALETTE: Readonly<Record<string, string>> = {
  'sugar.keyword': '8250df',
  'sugar.keyword.alias': '6e6a86',
  'sugar.system-function': '0550ae',
  'sugar.operator': '0a6b73',
  'sugar.cont': '953800',
  'sugar.pronoun': 'b4232e',
  'sugar.speech': '116329',
  // 2026-10-26 色值批：5b6b7f 与注释 57606a 差 7.6、与别名 6e6a86 差 9.1（两对撞色）。
  // 抬到同族的钢蓝 335f96（对全部档 ≥ 16.5，对比度 6.13）；2.0 的 kojo2.keyword.delimiter
  // 跟着取同一枚（「」两门语言同色）。
  'sugar.speech.delimiter': '335f96',
  'sugar.interp': 'b35900',
  'sugar.interp.delimiter': 'b35900',
  'sugar.colon': '335f96',
  'sugar.slot': '0e6b5c',
  'keyword.raw': '57606a',
  'keyword.erb': 'bf3989',
  // 族头 6639ba 与关键字 8250df 只差 11.7（撞色），且与 2.0 声明 512da8 差 6.5；
  // 移到同族更紫的一档 8e44ad（对全部档 ≥ 12）
  'keyword.erb.family': '8e44ad',
};

const LIGHT_SEMANTIC_PALETTE: Readonly<Record<string, string>> = {
  function: '0550ae',
  'function.declaration': '0550ae',
  parameter: 'b35900',
  'variable.declaration': '953800',
  'variable.declaration.readonly': '953800',
};

/** 薄荷暗色：墨绿底上的冷色族（青蓝/薄荷/冷紫/沙金/珊瑚），全部压 #0f1713 ≥ 4.5 */
const MINT_BASE_PALETTE: Readonly<Record<string, string>> = {
  comment: '8aa99a',
  keyword: 'c9a7f5',
  // 2026-10-26 色值批：沙金 e3c08d 与 number/interp 的 f0b98a 只差 8.6（撞色），
  // 提纯到金黄 dca023（ΔE 36.9；色相不动，仍是"暖金"族）
  'keyword.preprocessor': 'dca023',
  'entity.name.function': '7cc7ff',
  variable: 'ff9ba3',
  string: '9ccf9a',
  number: 'f0b98a',
  label: '74d6d0',
  // 同 dark：本套标点/分隔符族（sugar.speech.delimiter / sugar.colon 同色）
  operator: '8fb3c9',
  identifier: 'd9e9df',
  'string.escape': 'f0b98a',
};

const MINT_SUGAR_PALETTE: Readonly<Record<string, string>> = {
  'sugar.keyword': 'c9a7f5',
  'sugar.keyword.alias': '9a8fb8',
  'sugar.system-function': '7cc7ff',
  'sugar.operator': '74d6d0',
  'sugar.cont': 'dca023',
  'sugar.pronoun': 'ff9ba3',
  'sugar.speech': '9ccf9a',
  'sugar.speech.delimiter': '8fb3c9',
  'sugar.interp': 'f0b98a',
  'sugar.interp.delimiter': 'f0b98a',
  'sugar.colon': '8fb3c9',
  'sugar.slot': '67dcc0',
  // 原生直通：与注释 8aa99a 只差 8.3（撞色），移到暖灰 ada18a（ΔE 17.1，仍是"不解释的原文"灰）
  'keyword.raw': 'ada18a',
  'keyword.erb': 'ff9ccf',
  // 族头 bfa0ff 与关键字 c9a7f5 只差 9.6（撞色），提纯到 af8cff（ΔE 22.4；仍是紫）
  'keyword.erb.family': 'af8cff',
};

const MINT_SEMANTIC_PALETTE: Readonly<Record<string, string>> = {
  function: '7cc7ff',
  'function.declaration': '7cc7ff',
  parameter: 'f0b98a',
  'variable.declaration': 'dca023',
  'variable.declaration.readonly': 'dca023',
};

/**
 * 规则在**调用时**组装，不在模块顶层（`retint` 要按套换前景，三套主题各算各的）。
 *
 * 附带的红利：两张源规则数组住在零 import 叶子 `kojo-theme-rules.ts`，本文件不再
 * import `kojo-language.ts` / `kojo-semantic-tokens.ts`——旧有的装配环
 * （`kojo-semantic-tokens → register-dialects → erb-language → 本文件` 造成的
 * TDZ 风险）从这条静态边走不到了，`defineMonacoThemes` 任何时候调用绑定都已就绪。
 *
 * K2-SURFACE-DEFAULT：2.0 的 token 规则**无条件**追加在 v1 规则之后（`kojo2.*` 与
 * `sugar.*` 不撞名，追加不影响任何既有档，也不重排 v1 一格）。理由：`.kojo2` 的语言面
 * 永远可见，切流开关只管写回 / 迁移 / `.kojo` 的解析器切换——默认档打开 `.kojo2` 不该
 * 是一坨没有配色的灰字。三套 `kojo2-*` 独立主题仍按 flag 注册（见 `defineMonacoThemes`）。
 */
function darkRules(): Monaco.editor.ITokenThemeRule[] {
  return [
    ...rulesFromPalette(BASE_RULE_SPECS, DARK_BASE_PALETTE),
    // 同引用：既有暗色糖/语义规则对象原样并入（tokens 单一真源，测试钉住）
    ...KOJO_SUGAR_THEME_RULES,
    ...KOJO_SEMANTIC_THEME_RULES,
    ...KOJO2_THEME_RULES,
  ];
}

function lightRules(): Monaco.editor.ITokenThemeRule[] {
  return [
    ...rulesFromPalette(BASE_RULE_SPECS, LIGHT_BASE_PALETTE),
    ...retint(KOJO_SUGAR_THEME_RULES, LIGHT_SUGAR_PALETTE),
    ...retint(KOJO_SEMANTIC_THEME_RULES, LIGHT_SEMANTIC_PALETTE),
    // 亮底用它自己的 2.0 调色板（暗色规则落在 #f6f8fa 上对比度不足）
    ...KOJO2_LIGHT_THEME_RULES,
  ];
}

function mintRules(): Monaco.editor.ITokenThemeRule[] {
  return [
    ...rulesFromPalette(BASE_RULE_SPECS, MINT_BASE_PALETTE),
    ...retint(KOJO_SUGAR_THEME_RULES, MINT_SUGAR_PALETTE),
    ...retint(KOJO_SEMANTIC_THEME_RULES, MINT_SEMANTIC_PALETTE),
    // 墨绿有自己的 2.0 调色板：原始态直接并暗色表是 10 对撞色（最小 4.4）；修完 v1 侧仍剩
    // 4 对（含"原生直通""标点"两对必须同色的同义档）。`KOJO2_MINT_THEME_RULES` 逐档落到
    // 墨绿盘既有的语义近邻色，不引入第 16 枚色（理由见该表头注）。初版曾按切流开关决定
    // 并/不并（`mergeKojo2`），K2-SURFACE-DEFAULT 之后 2.0 语言面恒可见 ⇒ 恒并。
    ...KOJO2_MINT_THEME_RULES,
  ];
}

/* ------------------------------ 部件色 ------------------------------ */

/**
 * 部件色三套同一张键表（值各配各的）：编辑器背景/前景、行号、当前行、选区、光标、
 * 缩进参考线、括号匹配、浮层（widget/suggest/hover）、查找、缩略图、滚动条、概览尺、
 * diff 四色与粘性滚动。浅色档全部落在浅色面，不留 vs-dark 的深色块。
 *
 * **导出给 `kojo2-theme.ts`**（2026-10-26 部件色批）：2.0 三套主题的 `colors` 不再自己
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
  'editor.lineHighlightBackground': '#24292f',
  'editor.lineHighlightBorder': '#24292f',
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
  'editor.lineHighlightBackground': '#eaeef2',
  'editor.lineHighlightBorder': '#eaeef2',
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
  'editor.lineHighlightBackground': '#15201a',
  'editor.lineHighlightBorder': '#15201a',
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

/* ------------------------------ 装配 ------------------------------ */

/** 一次性定义三套主题（幂等；`registerErbLanguage` 末尾调用） */
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
  // Kojo 2.0 三套主题（K2 batch-3，flag 守卫）：与 v1 三套**不同 id**（`kojo2-*`），
  // 不覆盖、不继承，重复注册由 `registerKojo2Themes` 的 WeakSet 幂等挡掉。
  //
  // 为什么仍是**动态 import**：`kojo2-theme` 里那两张规则表虽已下沉到零 import 叶子
  // （K2-CUTOVER-THEME），但整套 `colors` 字面量 + 组装逻辑 ~15 KB 只在"真的要切到
  // `kojo2-*` 主题"时才有意义；`kojo2-*` 目前没有任何消费方（用户面切的仍是 v1 三套，
  // 而 v1 三套此时已各自带上了 2.0 规则）。flag 关时连这一份都不加载（独立主题是切流面）。
  // 失败不静默：v1 三套已经定义完，这里只少 2.0 那三套，用一条 warn 说出来。
  if (isKojo2CutoverEnabled()) {
    void import('./kojo2-theme')
      .then((module) => {
        module.registerKojo2Themes(monaco);
      })
      .catch((error: unknown) => {
        console.warn(
          `[theme] Kojo 2.0 主题注册失败（v1 三套不受影响，2.0 文件会按 v1 主题上色）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }
}
