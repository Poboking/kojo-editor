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
 * Monaco 主题（2026-10-17 反馈 3：编辑器配色跟随主题；2026-10-27 经典编辑器色批扩到六套）。
 *
 * 主题 id 与 `ui/theme-pref.ts` 的六档**逐字对应**，但本模块不 import 那个 UI 模块——
 * monaco 层只认识自己的联合类型，避免 UI → monaco → UI 的反向依赖；两边联合类型相同
 * 由 `tests/monaco-theme.test.ts` 用 `THEME_IDS` 做一一映射断言钉住。
 *
 * ## 两代装配路并存（2026-10-27 批）
 * 前三套（dark/light/mint-dark）走"四张分表"（BASE/SUGAR/SEMANTIC/2.0），它们各自的演进史
 * 与逐档判据注释都留在原地、一格未动；后三套（one-dark/rose-pine/synthwave84）走
 * "一张 48 键表 + 部件色种子生成器"，理由与判据见本文件下半段那节的表头。
 * 两条路的产物形状完全相同（48 条规则 + 91 键部件色），由同一道闸量。
 *
 * ## 取色口径
 * - **dark**：沿用既有 `kojo-dark` 的语法色（ERB 基线 + 糖 + 语义），底色从 vs-dark 的
 *   `#1e1e1e` 改为 app 的 `--bg` `#1e2227`，编辑器与外壳同底；
 * - **light**：VS Code Light+ 气质，深蓝/橄榄绿/赭石/紫四族压浅底；不复用任何暗色前景；
 * - **mint-dark**：与 `themes/mint-dark.css` 的墨绿底 `#0f1713` 协调的冷薄荷族。
 * - 后三套逐套见其表头（One Dark 的底色还账、Rosé Pine 的两枚弃用色、Synthwave '84 的
 *   整块过闸）。
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
 * **`support.type` 档住哪儿**（2026-10-27 第三色批）：外部建议点名的"类型用第三色"，本仓此前
 * 只有紫（关键字）与蓝（函数名，粗）两层，结构名一直没有自己的色。三套各取一支**黄绿／橄榄**
 * （dark `b3bd47` / light `5f6b2a` / mint `96b458`）——这条色相带在三套盘里都是空的，所以对每套
 * 最近的一枚（都是台词绿）都拉开到 ΔE ≥ 24，对比度 5.4–7.9。它**不加 fontStyle**：分层靠色相，
 * 不靠伪斜体（CJK 斜体会糊，与 `keyword` 同一口径）。消费方两条链都默认开：
 * `.ERB` 结构层的 `#DIM` 型/存储限定词（`tree-sitter/erb-tiers.ts`）与 2.0 的结构定义头
 * （`kojo2.type`，逐字同色，两门语言的"类型"不许有两种绿）。
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
  // 类型 / 结构名（2026-10-27 第三色批）：本仓第一枚**独立于关键字与函数名**的结构前景档。
  // 消费方是两条默认开的链：`.ERB` 结构层的 `#DIM` 型/存储限定词（`erb-tiers.ts` 的 `type` 档）
  // 与 2.0 的结构定义头（`kojo2.type` 与本档逐字同色）。**不加 fontStyle**：
  // 与 `keyword` 同理——CJK 环境里的斜体是伪斜体，糊；这一档靠色相分层，不靠字形。
  { token: 'support.type' },
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
  // 类型 / 结构名（第三色）：暗底上取偏黄的橄榄 `b3bd47`——对底 `#1e2227` 对比 7.83，
  // 对全表最近的一枚（台词草绿 `98c379`）ΔE 25.4，与关键字紫 / 函数蓝三色分立。
  'support.type': 'b3bd47',
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
  // 类型 / 结构名（第三色）：浅底取深橄榄 `5f6b2a`——对底 `#f6f8fa` 对比 5.44，
  // 对台词绿 `116329` ΔE 24.6（浅底可读区间窄，这一支是量出来的，不是猜的）。
  'support.type': '5f6b2a',
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
  // 类型 / 结构名（第三色）：墨绿底上的暖橄榄 `96b458`——对底 `#0f1713` 对比 7.78，
  // 对最近的台词绿 `9ccf9a` ΔE 23.9。墨绿盘的黄绿／橄榄那一块原本是空的（不是"第 16 枚必撞"），
  // 2.0 侧的 `kojo2.type` 与本档逐字同色。
  'support.type': '96b458',
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
 * 三套新主题走**另一条装配路**，与上面三套并存（既有三套一格未动，它们的同引用断言、
 * 三分法调色板、逐档注释全部保持原样）。
 *
 * 为什么新开一条：既有三套把 48 档拆成 BASE（12）/ SUGAR（15）/ SEMANTIC（5）/ 2.0（16）
 * 四张表，是因为它们的演进史是「先有词法、后补糖、再补语义、最后并 2.0」——四张表各自
 * 带着自己的判据注释。新主题没有这段历史，**一张 48 键的表反而更好核**：一屏能看全
 * "这套主题到底给了几种色"，而 `retint()` 只按 token 名取值、四个来源的 token 名两两不
 * 重叠（`sugar.*` / `kojo2.*` / `function` 族 / 裸词法名），所以单表完全够用。
 *
 * 取色纪律与既有三套**逐条相同**（判据由 `theme-color-gates.test.ts` 对 `THEME_IDS` 全量跑）：
 * 每条规则对 `editor.background` ≥ 4.5、主题内任意两枚不同前景 CIE76 ΔE ≥ 12、
 * `operator` 住在结构族（可读 / 弱于正文 / 彩度低于关键字 / 对全部基线档 ΔE ≥ 12）、
 * 跨语言同义档五组逐字同色、第三色档（`support.type` 与 `kojo2.type`）逐字同色。
 * 三套的实算读数写在各自表头。
 */
type RulePalette = Readonly<Record<string, string>>;

/** 单表 → 48 条规则（四个来源的 token 名互不重叠，故一张表喂四次） */
function rulesFromOneTable(palette: RulePalette): Monaco.editor.ITokenThemeRule[] {
  return [
    ...rulesFromPalette(BASE_RULE_SPECS, palette),
    ...retint(KOJO_SUGAR_THEME_RULES, palette),
    ...retint(KOJO_SEMANTIC_THEME_RULES, palette),
    ...retint(KOJO2_THEME_RULES, palette),
  ];
}

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
  comment: '8e97a0',
  keyword: 'c678dd',
  'keyword.preprocessor': 'e5c07b',
  'entity.name.function': '61afef',
  // 类型 / 结构名（第三色）：**直接沿用缺省 dark 那一枚 `b3bd47`**，不另调。
  // 本盘与 `DARK_BASE_PALETTE` 本来就是同源色（见上），"类型"这一档跟着同源才不会
  // 在切档时自己变色；而底从 #1e2227 抬到 #282c34 后它仍有 6.86，余量比 dark 那档还大。
  'support.type': 'b3bd47',
  variable: 'e8838c',
  string: '98c379',
  number: 'd19a66',
  label: '56b6c2',
  operator: '7f9cc0',
  identifier: 'b8bfca',
  'string.escape': 'd19a66',

  'sugar.keyword': 'c678dd',
  'sugar.keyword.alias': 'a194c9',
  'sugar.system-function': '61afce',
  'sugar.operator': '56b6c2',
  'sugar.cont': 'e5c07b',
  'sugar.pronoun': 'e8838c',
  'sugar.speech': '98c379',
  'sugar.speech.delimiter': '7f9cc0',
  'sugar.interp': 'd19a66',
  'sugar.interp.delimiter': 'd19a66',
  'sugar.colon': '7f9cc0',
  'sugar.slot': '5cc9a8',
  'keyword.raw': 'b0a89a',
  'keyword.erb': 'e8838c',
  'keyword.erb.family': 'a194c9',

  function: '61afef',
  'function.declaration': '61afef',
  parameter: 'd19a66',
  'variable.declaration': 'e5c07b',
  'variable.declaration.readonly': 'e5c07b',

  'kojo2.anchor': 'ff5ec7',
  'kojo2.declaration': 'a194c9',
  'kojo2.keyword': 'c678dd',
  'kojo2.keyword.delimiter': '7f9cc0',
  'kojo2.speaker': 'e5c07b',
  'kojo2.speech': '98c379',
  'kojo2.speech.string': '98c379',
  'kojo2.narration': '61afef',
  'kojo2.interp': 'd19a66',
  'kojo2.hint': 'e8838c',
  'kojo2.raw': 'b0a89a',
  'kojo2.comment': '8e97a0',
  'kojo2.number': 'd19a66',
  'kojo2.number.hex': 'd19a66',
  'kojo2.operator': '56b6c2',
  'kojo2.type': 'b3bd47',
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
  comment: '908caa',
  keyword: 'c4a7e7',
  'keyword.preprocessor': 'f6c177',
  'entity.name.function': '9ccfd8',
  'support.type': '94a06e',
  variable: 'ebbcba',
  string: 'f6c177',
  number: 'eb6f92',
  label: '9ccfd8',
  operator: '5fa0b8',
  identifier: 'e0def4',
  'string.escape': 'eb6f92',

  'sugar.keyword': 'c4a7e7',
  'sugar.keyword.alias': '908caa',
  'sugar.system-function': '9ccfd8',
  'sugar.operator': '5fa0b8',
  'sugar.cont': 'f6c177',
  'sugar.pronoun': 'eb6f92',
  'sugar.speech': 'ebbcba',
  'sugar.speech.delimiter': '908caa',
  'sugar.interp': 'f6c177',
  'sugar.interp.delimiter': 'f6c177',
  'sugar.colon': '908caa',
  'sugar.slot': '9ccfd8',
  'keyword.raw': '9d9489',
  'keyword.erb': 'eb6f92',
  'keyword.erb.family': 'c4a7e7',

  function: '9ccfd8',
  'function.declaration': '9ccfd8',
  parameter: 'f6c177',
  'variable.declaration': 'eb6f92',
  'variable.declaration.readonly': 'eb6f92',

  'kojo2.anchor': 'eb6f92',
  'kojo2.declaration': 'c4a7e7',
  'kojo2.keyword': 'c4a7e7',
  'kojo2.keyword.delimiter': '908caa',
  'kojo2.speaker': 'ebbcba',
  'kojo2.speech': 'ebbcba',
  'kojo2.speech.string': 'f6c177',
  'kojo2.narration': '9ccfd8',
  'kojo2.interp': 'f6c177',
  'kojo2.hint': 'eb6f92',
  'kojo2.raw': '9d9489',
  'kojo2.comment': '908caa',
  'kojo2.number': 'eb6f92',
  'kojo2.number.hex': 'eb6f92',
  'kojo2.operator': '5fa0b8',
  'kojo2.type': '94a06e',
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
  comment: '848bbd',
  keyword: 'fede5d',
  'keyword.preprocessor': 'f97e72',
  'entity.name.function': '36f9f6',
  'support.type': 'a8cf4e',
  variable: 'ff7edb',
  string: 'ff8b39',
  number: 'f97e72',
  label: '36f9f6',
  operator: 'b893ce',
  identifier: 'eae6f5',
  'string.escape': '36f9f6',

  'sugar.keyword': 'fede5d',
  'sugar.keyword.alias': 'b893ce',
  'sugar.system-function': '36f9f6',
  'sugar.operator': '72f1b8',
  'sugar.cont': 'fede5d',
  'sugar.pronoun': 'ff7edb',
  'sugar.speech': '72f1b8',
  'sugar.speech.delimiter': 'b893ce',
  'sugar.interp': 'ff8b39',
  'sugar.interp.delimiter': 'ff8b39',
  'sugar.colon': 'b893ce',
  'sugar.slot': '72f1b8',
  'keyword.raw': 'a09ab8',
  'keyword.erb': 'ff7edb',
  'keyword.erb.family': 'b893ce',

  function: '36f9f6',
  'function.declaration': '36f9f6',
  parameter: 'f97e72',
  'variable.declaration': 'fede5d',
  'variable.declaration.readonly': 'fede5d',

  'kojo2.anchor': 'ff7edb',
  'kojo2.declaration': 'b893ce',
  'kojo2.keyword': 'fede5d',
  'kojo2.keyword.delimiter': 'b893ce',
  'kojo2.speaker': 'ff8b39',
  'kojo2.speech': '72f1b8',
  'kojo2.speech.string': 'ff8b39',
  'kojo2.narration': '36f9f6',
  'kojo2.interp': 'ff8b39',
  'kojo2.hint': 'ff7edb',
  'kojo2.raw': 'a09ab8',
  'kojo2.comment': '848bbd',
  'kojo2.number': 'f97e72',
  'kojo2.number.hex': 'f97e72',
  'kojo2.operator': 'b893ce',
  'kojo2.type': 'a8cf4e',
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
}

function buildColors(s: ColorSeeds): Readonly<Record<string, string>> {
  return {
    'editor.background': s.bg,
    'editor.foreground': s.fg,
    'editorLineNumber.foreground': s.dim,
    'editorLineNumber.activeForeground': s.fg,
    'editorLineNumber.dimmedForeground': s.dimDeep,
    'editorCursor.foreground': s.accentText,
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
    rules: rulesFromOneTable(ONE_DARK_PALETTE),
    colors: ONE_DARK_COLORS,
  });
  monaco.editor.defineTheme('kojo-rose-pine', {
    base: 'vs-dark',
    inherit: false,
    rules: rulesFromOneTable(ROSE_PINE_PALETTE),
    colors: ROSE_PINE_COLORS,
  });
  monaco.editor.defineTheme('kojo-synthwave84', {
    base: 'vs-dark',
    inherit: false,
    rules: rulesFromOneTable(SYNTHWAVE84_PALETTE),
    colors: SYNTHWAVE84_COLORS,
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
