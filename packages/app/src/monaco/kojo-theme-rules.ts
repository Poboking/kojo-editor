import type * as Monaco from './entry';

/**
 * Monarch token → 主题规则数据的**叶子单一真源**（PS-10 断链批；K2-CUTOVER-THEME 扩到 2.0）。
 * 现存三组：v1 糖专属、v1 语义类别、2.0 的 token 名与亮/暗两套规则。
 *
 * 为什么值得单开一层：`theme.ts` 在开机静态图里（`shell-overlays → diff-view →
 * erb-language → theme` 与 QuickFixPreviewOverlay → theme 两条链都经它），而两张规则
 * 数组的**老家**各自拖着一条重链——
 * - `kojo-language.ts` 静态 import `@kojo/plugin-kojo-sugar`（词表单一真源，~900 KB）；
 * - `kojo-semantic-tokens.ts` → `register-dialects` → `kojo-language.ts`。
 *
 * 两张数组本身却是**零依赖的纯字面数据**（糖/语义 token 的前景色，写死不动）。
 * 把它们下沉到本叶子后，`theme.ts` 的静态足迹只剩这一个零 import 模块——
 * `@kojo/plugin-kojo-sugar` 于是整包离开开机静态图（改由 shell-overlays 的
 * 动态 import 在装载 diff view 时进入）。
 *
 * ## 身份不变量（测试钉住，别破坏）
 * 本文件是**唯一定义处**；`kojo-language.ts` / `kojo-semantic-tokens.ts` 各自
 * `export ... from './kojo-theme-rules'` 原样 re-export（不复制、不接受第二份）
 * ——既有 import 点（`monaco-theme.test.ts` / `kojo-token-tiers.test.ts` 的
 * 同对象引用断言、theme.ts 的暗色原样并入）读到的仍是**同一个数组本体**。
 *
 * 取色口径与档位判据不变（见两个 re-export 点的头注与
 * `kojo-token-tiers.test.ts`）；本文件只搬家，不改一个色值。
 *
 * ## K2-CUTOVER-THEME：2.0 的 token 名与配色也住这里
 *
 * v1 三套主题（`theme.ts`）在开机静态图里，而 2.0 的规则数据原籍
 * `kojo2-language.ts`（同一条 ~900 KB 词表链）。分屏双轨期要"`.kojo2` 文件在 `kojo-*`
 * 主题下也上色"，就得让 `theme.ts` 能直接读到那批规则——于是把它们（`KOJO2_TOKEN` /
 * `KOJO2_THEME_RULES` 暗色 / `KOJO2_LIGHT_THEME_RULES` 亮色）下沉到本零 import 叶子，
 * `kojo2-language.ts` 与 `kojo2-theme.ts` 各自 `export ... from` 同一对象本体。
 *
 * **flag 关时 `theme.ts` 不并入它们**（逐字不变量见 `theme.ts::defineMonacoThemes`）：
 * 数据住在叶子 ≠ 数据生效，判据仍在装配点。
 */

/**
 * `kojo-dark` 里糖专属 token 的着色规则（由 `erb-language.ts` 合并进主题定义）。
 *
 * 取色口径（**深底可读 + 一档一色**，判据复跑见 `kojo-token-tiers.test.ts`）：
 * - 已中文化的糖层走冷色族（紫=关键字、青=运算符、蓝=函数、绿=台词、玫=代词）；
 * - 还没中文化的原生层走"外来族"（粉=引擎指令、蓝紫=族头、灰=整行原生直通），
 *   名字层（CJK 非词表 = 槽位原名 / 作者自定名）走薄荷绿；
 * - 亮度全部 ≥ 4.46:1（既有档位里最弱的一档），不为了分层引入刺眼的高饱和。
 */
export const KOJO_SUGAR_THEME_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: 'sugar.keyword', foreground: 'c678dd' },
  { token: 'sugar.keyword.alias', foreground: '8b7bb8' },
  { token: 'sugar.system-function', foreground: '61afce' },
  { token: 'sugar.operator', foreground: '56b6c2' },
  { token: 'sugar.cont', foreground: 'e5c07b', fontStyle: 'bold' },
  { token: 'sugar.pronoun', foreground: 'e06c75' },
  { token: 'sugar.speech', foreground: '98c379' },
  { token: 'sugar.speech.delimiter', foreground: '7f9cc0' },
  { token: 'sugar.interp', foreground: 'd19a66' },
  { token: 'sugar.interp.delimiter', foreground: 'd19a66', fontStyle: 'bold' },
  { token: 'sugar.colon', foreground: '7f9cc0' },
  { token: 'sugar.slot', foreground: '5cc9a8' },
  { token: 'keyword.raw', foreground: '9aa0a6' },
  { token: 'keyword.erb', foreground: 'ff7ab2' },
  { token: 'keyword.erb.family', foreground: '9d7bea' },
];

/**
 * `kojo-dark` 里语义类别的主题规则。
 *
 * token 名就是 `type.modifier…` 那条点分串（standalone 主题服务原文这么匹配），
 * 所以 `function.declaration` 比 `function` 更具体 = 定义点与调用点两种色。
 * 取色一律**复用既有词法色**（蓝 = 函数、黄 = 声明、橙 = 数/参数位），不引入新配色：
 * 作者看到的应当是"同一类东西同一个色"，而不是"新机制带来第七种蓝"。
 */
export const KOJO_SEMANTIC_THEME_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: 'function', foreground: '61afef' },
  { token: 'function.declaration', foreground: '61afef', fontStyle: 'bold' },
  { token: 'parameter', foreground: 'd19a66' },
  { token: 'variable.declaration', foreground: 'e5c07b' },
  { token: 'variable.declaration.readonly', foreground: 'e5c07b', fontStyle: 'italic' },
];

/* ==================== Kojo 2.0：token 名与配色（K2-CUTOVER-THEME 数据面） ==================== */

/**
 * 2.0 token 名（全部 `kojo2.` 前缀，与 v1 的 `sugar.*` 不撞名）。
 *
 * 细分子档（`.keyword.delimiter` / `.speech.string` / `.number.hex`）与父档同色，
 * 保留它们是为了将来"标点/字面量单独调色"时有挂点，不用改词法。
 *
 * 这是**全仓唯一一份** token 名字面量：词法（`kojo2-language.ts` 的 Monarch）、
 * 主题（`kojo2-theme.ts` 的三套 `kojo2-*`）、v1 三套的合并规则、语义映射
 * （`kojo2-semantic.ts`）全部从这里取；谁要加一档，只改这一格。
 */
export const KOJO2_TOKEN = {
  /** 五锚点符号（`# @ > ? !` 与行首转义 `\`） */
  anchor: 'kojo2.anchor',
  /** 声明词 / 调度词（`#` 后的词、`@` 后的词、`!` 的被调名） */
  declaration: 'kojo2.declaration',
  /** 保留词（`由` / `否` / `续` / `空行` / 类型词 / 存储期词 / 织入修饰词 / `[插槽]`） */
  keyword: 'kojo2.keyword',
  /** 结构性标点（`：` / `「」` / 括号 / 逗号）——与保留词同档同色 */
  delimiter: 'kojo2.keyword.delimiter',
  /** 说话人（`角色：` 的整段前导 + 域符号 `我/你/她`） */
  speaker: 'kojo2.speaker',
  /** 台词正文 */
  speech: 'kojo2.speech',
  /** 字符串字面量（`"…"`，正文面同款文本色） */
  string: 'kojo2.speech.string',
  /** 旁白正文（`>` 之后） */
  narration: 'kojo2.narration',
  /** 插值 `{…}` / `{条件 ? A : B}`（含花括号） */
  interp: 'kojo2.interp',
  /** 行尾表演提示 `(心形)` / `(别过头)` */
  hint: 'kojo2.hint',
  /** `@原生` 围栏体（整行原文，不解释） */
  raw: 'kojo2.raw',
  /** 整行 `//` 注释 */
  comment: 'kojo2.comment',
  /** 十进制整数 */
  number: 'kojo2.number',
  /** 十六进制颜色/常量字面量 */
  hex: 'kojo2.number.hex',
  /** 运算符（ASCII 符号与中文运算符词） */
  operator: 'kojo2.operator',
} as const;

export type Kojo2TokenName = (typeof KOJO2_TOKEN)[keyof typeof KOJO2_TOKEN];

/**
 * 2.0 专属配色（**暗色**；三套 `kojo2-*` 的暗色侧与 `kojo-mint-dark` 的合并规则都用它）。
 *
 * 取色纪律：**一档一色** + 深底对比度 ≥ 4.5 + 任意两档 CIE Lab 色差 ≥ 12（测试复跑）。
 * 语义族沿用既有暗色惯性：紫=声明、青=保留词、橙=说话人、绿=台词/字面、蓝=旁白、
 * 黄=插值、粉=提示、灰=原生、暗青灰=注释、淡紫=数字、青绿=运算符；锚点用最亮的粉紫。
 *
 * **合并点**：`theme.ts` 在 flag 开时把本数组追加进 `kojo-dark` / `kojo-mint-dark`
 * 的 `rules`（v1 规则一格不动，只在尾部追加；flag 关时不追加）。
 */
export const KOJO2_THEME_RULES: readonly Monaco.editor.ITokenThemeRule[] = [
  { token: KOJO2_TOKEN.anchor, foreground: 'ff79c6', fontStyle: 'bold' },
  { token: KOJO2_TOKEN.declaration, foreground: 'bd93f9' },
  { token: KOJO2_TOKEN.keyword, foreground: '8be9fd' },
  { token: KOJO2_TOKEN.delimiter, foreground: '8be9fd' },
  { token: KOJO2_TOKEN.speaker, foreground: 'ffb86c' },
  { token: KOJO2_TOKEN.speech, foreground: 'a6e3a1' },
  { token: KOJO2_TOKEN.string, foreground: 'a6e3a1' },
  { token: KOJO2_TOKEN.narration, foreground: '89b4fa' },
  { token: KOJO2_TOKEN.interp, foreground: 'f9e2af' },
  { token: KOJO2_TOKEN.hint, foreground: 'f38ba8', fontStyle: 'italic' },
  { token: KOJO2_TOKEN.raw, foreground: '9aa0a6' },
  { token: KOJO2_TOKEN.comment, foreground: '6a8f9a', fontStyle: 'italic' },
  { token: KOJO2_TOKEN.number, foreground: 'd6acff' },
  { token: KOJO2_TOKEN.hex, foreground: 'd6acff' },
  { token: KOJO2_TOKEN.operator, foreground: '66d9c8' },
];

/**
 * 2.0 专属配色（**亮色**；`kojo-light` 的合并规则与 `kojo2-light` 主题的 `rules` 都用它）。
 *
 * 与暗色同一套语义族，取浅底可读版本：紫=声明、靛=数字、青=关键字、棕=说话人、
 * 橄榄绿=台词、蓝=旁白、金=插值、红=提示、暖灰=原生、紫灰=注释、石板=运算符、品红=锚点。
 * 品红 / 红 / 紫灰刻意拉开：锚点与提示、注释与运算符在浅底上最容易糊成一片。
 *
 * **顺序 = {@link KOJO2_TOKEN} 的声明序**（与暗色表同序）；字体样式逐格对齐暗色
 * （锚点粗体、提示与注释斜体），两套主题切来切去不该有字重漂移。
 * 完整性（token 集合 = `KOJO2_TOKEN` 的值集合）由 `kojo2-theme.ts` 在模块求值期校验，
 * 少一格 / 多一格当场抛，而不是静默掉色。
 */
export const KOJO2_LIGHT_THEME_RULES: readonly Monaco.editor.ITokenThemeRule[] = [
  { token: KOJO2_TOKEN.anchor, foreground: 'b5179e', fontStyle: 'bold' },
  { token: KOJO2_TOKEN.declaration, foreground: '512da8' },
  { token: KOJO2_TOKEN.keyword, foreground: '0b7285' },
  { token: KOJO2_TOKEN.delimiter, foreground: '0b7285' },
  { token: KOJO2_TOKEN.speaker, foreground: '8b4513' },
  { token: KOJO2_TOKEN.speech, foreground: '33691e' },
  { token: KOJO2_TOKEN.string, foreground: '33691e' },
  { token: KOJO2_TOKEN.narration, foreground: '1565c0' },
  { token: KOJO2_TOKEN.interp, foreground: '8a6d00' },
  { token: KOJO2_TOKEN.hint, foreground: 'b4232e', fontStyle: 'italic' },
  { token: KOJO2_TOKEN.raw, foreground: '5f5548' },
  { token: KOJO2_TOKEN.comment, foreground: '5d4a5c', fontStyle: 'italic' },
  { token: KOJO2_TOKEN.number, foreground: '8e44ad' },
  { token: KOJO2_TOKEN.hex, foreground: '8e44ad' },
  { token: KOJO2_TOKEN.operator, foreground: '2b5566' },
];
