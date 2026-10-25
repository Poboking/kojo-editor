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
 * `KOJO2_THEME_RULES` 暗色 / `KOJO2_LIGHT_THEME_RULES` 亮色 / `KOJO2_MINT_THEME_RULES` 墨绿）
 * 下沉到本零 import 叶子，`kojo2-language.ts` 与 `kojo2-theme.ts` 各自 `export ... from`
 * 同一对象本体。
 *
 * **`theme.ts` 无条件并入它们**（K2-SURFACE-DEFAULT，见 `theme.ts::defineMonacoThemes`）：
 * `.kojo2` 的语言面永远可见，配色不该等切流；数据住在叶子只是断链，不影响生效时机。
 */

/**
 * `kojo-dark` 里糖专属 token 的着色规则（由 `erb-language.ts` 合并进主题定义）。
 *
 * 取色口径（**深底可读 + 一档一色**，判据复跑见 `kojo-token-tiers.test.ts`）：
 * - 已中文化的糖层走冷色族（紫=关键字、青=运算符、蓝=函数、绿=台词、玫=代词）；
 * - 还没中文化的原生层走"外来族"（粉=引擎指令、蓝紫=族头、灰=整行原生直通），
 *   名字层（CJK 非词表 = 槽位原名 / 作者自定名）走薄荷绿；
 * - 亮度全部 ≥ 4.5:1（判据底色取自主题自己的 `editor.background` `#1e2227`，
 *   不再是 vs-dark 基底的 `#1e1e1e`），不为了分层引入刺眼的高饱和。
 *
 * 2026-10-26 对比度批：`sugar.keyword.alias` 由 `8b7bb8` 提亮到 `9687be`
 * （4.28 → 4.95；色相不动，仍是弱化紫）。
 */
export const KOJO_SUGAR_THEME_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: 'sugar.keyword', foreground: 'c678dd' },
  { token: 'sugar.keyword.alias', foreground: '9687be' },
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
  // 原生直通：9aa0a6 与正文 abb2bf 只差 7.8（撞色），移到暖灰 a8a290（ΔE 17.2；
  // 仍是"不解释的原文"那一层灰，且与 2.0 的 kojo2.raw 同色）
  { token: 'keyword.raw', foreground: 'a8a290' },
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
  /**
   * 结构性标点（`：` / `「」` / 括号 / 逗号）——**与 v1 的 `sugar.speech.delimiter` 同色**，
   * 不与保留词同档（同一枚 `「` 在两门语言里必须同色；拆档见 `KOJO2_TOKEN_TIERS`）
   */
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
 * 2.0 专属配色（**暗色**；三套 `kojo2-*` 的暗色侧与 `kojo-dark` 的合并规则都用它）。
 *
 * 取色纪律：**一档一色** + 深底对比度 ≥ 4.5 + 任意两档 CIE Lab 色差 ≥ 12（判据复跑见
 * `theme-color-gates.test.ts`：底色取主题 `editor.background`，且算的是**主题内全部生效
 * 规则**——v1 的 31 档 + 本节 15 档，不再只看 2.0 单族 12 色）。
 * 语义族：紫=声明、青=保留词、橙=说话人、绿=台词/字面、蓝=旁白、
 * 黄=插值、粉=提示、暖灰=原生、中性灰=注释、淡紫=数字、青绿=运算符；锚点用最亮的粉紫。
 *
 * **与 v1 的关系**（2026-10-26 色值批）：
 * - `kojo2.keyword.delimiter` 与 v1 的 `sugar.speech.delimiter` / `sugar.colon` **同色**
 *   `7f9cc0`——同一枚 `「`（`：`）在两门语言里必须同色，这是 `theme.ts` 头注写死的不变量；
 * - `kojo2.raw` / `kojo2.comment` 分别与 v1 的 `keyword.raw` / `comment` 同色
 *   （同一件事在两种语言里就是同一档，不再"2.0 有自己的一套灰"）；
 * - `kojo2.speech` / `kojo2.speech.string` 取 v1 的台词/字面色 `98c379`（同一段正文）；
 * - `kojo2.operator` 取 v1 运算符档 `56b6c2`（同义档同色，顺带让"运算符"只有一枚青）。
 * - 其余档在保持本族色相的前提下，与 v1 相邻档拉开到 ΔE ≥ 12（原本 5 对撞色：
 *   `89b4fa↔61afef` 9.9、`ff79c6↔ff7ab2` 11.0、`bd93f9↔9d7bea` 11.3、`66d9c8↔5cc9a8` 10.7、
 *   `9aa0a6↔abb2bf` 7.8）。
 *
 * **合并点**：`theme.ts` 把本数组追加进 `kojo-dark` 的 `rules`（v1 规则一格不动，只在尾部
 * 追加）；K2-SURFACE-DEFAULT 起**无条件追加**（2.0 语言面恒可见，开关只管写回 / 迁移 /
 * `.kojo` 解析器）。`kojo-mint-dark` 并的是 `KOJO2_MINT_THEME_RULES`（墨绿自己的盘）。
 */
export const KOJO2_THEME_RULES: readonly Monaco.editor.ITokenThemeRule[] = [
  { token: KOJO2_TOKEN.anchor, foreground: 'ff41b9', fontStyle: 'bold' },
  { token: KOJO2_TOKEN.declaration, foreground: 'a582d7' },
  { token: KOJO2_TOKEN.keyword, foreground: '8be9fd' },
  { token: KOJO2_TOKEN.delimiter, foreground: '7f9cc0' },
  { token: KOJO2_TOKEN.speaker, foreground: 'ffb86c' },
  // 台词 / 字面与 v1 同色（98c379）：同一段正文在两门语言里就是同一档
  { token: KOJO2_TOKEN.speech, foreground: '98c379' },
  { token: KOJO2_TOKEN.string, foreground: '98c379' },
  { token: KOJO2_TOKEN.narration, foreground: '5fa0f5' },
  { token: KOJO2_TOKEN.interp, foreground: 'f9e2af' },
  { token: KOJO2_TOKEN.hint, foreground: 'f38ba8', fontStyle: 'italic' },
  { token: KOJO2_TOKEN.raw, foreground: 'a8a290' },
  { token: KOJO2_TOKEN.comment, foreground: '879098', fontStyle: 'italic' },
  { token: KOJO2_TOKEN.number, foreground: 'd6acff' },
  { token: KOJO2_TOKEN.hex, foreground: 'd6acff' },
  { token: KOJO2_TOKEN.operator, foreground: '56b6c2' },
];

/**
 * 2.0 专属配色（**亮色**；`kojo-light` 的合并规则与 `kojo2-light` 主题的 `rules` 都用它）。
 *
 * 与暗色同一套语义族，取浅底可读版本：靛=声明、紫=保留词、钢蓝=标点、棕=说话人、
 * 橄榄绿=台词、蓝=旁白、橙棕=插值、红=提示、暖灰=原生与注释、棕=数字、石板=运算符、品红=锚点。
 *
 * **2026-10-26 色值批：亮色不再另起一套色，而是落到 v1 亮色盘的语义近邻色上。**
 * 理由是浅底的可读区间窄（正文级 ≥4.5 把全部前景压进 L* 25–55），26 枚独立色在 Lab 里
 * 已经挤到"两两 ≥12"不可行（原读数 8 对撞色，最小 `6639ba↔512da8` 只有 6.5）。把 2.0 档
 * 收进 v1 的同一批色后，主题内独立色 26 → 17，撞色 0；顺带兑现"同义档同色"：
 * 标点 / 台词 / 字面 / 注释 / 原生 / 数字 / 插值 / 运算符 八档都与 v1 同名档逐字相等
 * （含 `theme.ts` 头注写死的「`「` 两门语言同色」）。
 * 仍保留 2.0 自己的两档：锚点 `bf3989`（品红，v1 只有 `keyword.erb` 用它）与声明 `512da8`（靛）。
 *
 * **顺序 = {@link KOJO2_TOKEN} 的声明序**（与暗色表同序）；字体样式逐格对齐暗色
 * （锚点粗体、提示与注释斜体），两套主题切来切去不该有字重漂移。
 * 完整性（token 集合 = `KOJO2_TOKEN` 的值集合）由 `kojo2-theme.ts` 在模块求值期校验，
 * 少一格 / 多一格当场抛，而不是静默掉色。
 */
export const KOJO2_LIGHT_THEME_RULES: readonly Monaco.editor.ITokenThemeRule[] = [
  { token: KOJO2_TOKEN.anchor, foreground: 'bf3989', fontStyle: 'bold' },
  { token: KOJO2_TOKEN.declaration, foreground: '512da8' },
  { token: KOJO2_TOKEN.keyword, foreground: '8250df' },
  { token: KOJO2_TOKEN.delimiter, foreground: '335f96' },
  { token: KOJO2_TOKEN.speaker, foreground: '8b4513' },
  { token: KOJO2_TOKEN.speech, foreground: '116329' },
  { token: KOJO2_TOKEN.string, foreground: '116329' },
  { token: KOJO2_TOKEN.narration, foreground: '0550ae' },
  { token: KOJO2_TOKEN.interp, foreground: 'b35900' },
  { token: KOJO2_TOKEN.hint, foreground: 'b4232e', fontStyle: 'italic' },
  { token: KOJO2_TOKEN.raw, foreground: '57606a' },
  { token: KOJO2_TOKEN.comment, foreground: '57606a', fontStyle: 'italic' },
  { token: KOJO2_TOKEN.number, foreground: '953800' },
  { token: KOJO2_TOKEN.hex, foreground: '953800' },
  { token: KOJO2_TOKEN.operator, foreground: '35526f' },
];

/**
 * 2.0 专属配色（**墨绿**；`kojo-mint-dark` 的合并规则与 `kojo2-mint-dark` 主题的 `rules` 都用它）。
 *
 * 为什么不再复用暗色表：原始态把暗色 15 档并进墨绿盘是 **10 对** CIE76 ΔE < 12（最小
 * `c9a7f5↔d6acff` 4.4）；即便先把墨绿 v1 侧的撞色修掉，直接沿用暗色表仍剩 4 对：
 * `a8a290↔ada18a` 3.7（原生直通——2.0 与 v1 必须同色）、`d6acff↔c9a7f5` 4.4、
 * `7f9cc0↔8fb3c9` 11.7（标点——必须同色）、`f38ba8↔ff9ba3` 11.7。
 * 墨绿盘只有 15 枚独立色，两两 ≥12 已到极限（再进一枚新色必然撞色），因此本表把 2.0
 * 十五档**逐档落到墨绿盘既有的语义近邻色**上——不引入第 16 枚色，撞色归零：
 * - 同义档同色（与 v1 墨绿盘逐字相等）：标点 `8fb3c9`、台词/字面 `9ccf9a`、注释 `8aa99a`、
 *   原生 `ada18a`、数字 `f0b98a`、插值 `f0b98a`、运算符 `74d6d0`、保留词 `c9a7f5`；
 * - 2.0 独有的五档借用本盘语义近邻：锚点取粉 `ff9ccf`（粗体与 `keyword.erb` 分档）、
 *   声明取函数蓝 `7cc7ff`（"名字"）、说话人取珊瑚 `ff9ba3`（"人"）、旁白取正文色 `d9e9df`
 *   （旁白就是正文）、提示取薄荷 `67dcc0`（斜体与名字层分档）。
 *   代价是这五档在合并视图里与 v1 某档同色——按"同一类东西同色"看是对的，但不再是"一档一色"。
 *
 * 字体样式与暗色表逐格一致（锚点粗体、提示与注释斜体）。
 */
export const KOJO2_MINT_THEME_RULES: readonly Monaco.editor.ITokenThemeRule[] = [
  { token: KOJO2_TOKEN.anchor, foreground: 'ff9ccf', fontStyle: 'bold' },
  { token: KOJO2_TOKEN.declaration, foreground: '7cc7ff' },
  { token: KOJO2_TOKEN.keyword, foreground: 'c9a7f5' },
  { token: KOJO2_TOKEN.delimiter, foreground: '8fb3c9' },
  { token: KOJO2_TOKEN.speaker, foreground: 'ff9ba3' },
  { token: KOJO2_TOKEN.speech, foreground: '9ccf9a' },
  { token: KOJO2_TOKEN.string, foreground: '9ccf9a' },
  { token: KOJO2_TOKEN.narration, foreground: 'd9e9df' },
  { token: KOJO2_TOKEN.interp, foreground: 'f0b98a' },
  { token: KOJO2_TOKEN.hint, foreground: '67dcc0', fontStyle: 'italic' },
  { token: KOJO2_TOKEN.raw, foreground: 'ada18a' },
  { token: KOJO2_TOKEN.comment, foreground: '8aa99a', fontStyle: 'italic' },
  { token: KOJO2_TOKEN.number, foreground: 'f0b98a' },
  { token: KOJO2_TOKEN.hex, foreground: 'f0b98a' },
  { token: KOJO2_TOKEN.operator, foreground: '74d6d0' },
];
