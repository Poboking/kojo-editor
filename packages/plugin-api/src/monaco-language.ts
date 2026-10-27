/**
 * `ui.monaco.language` 的契约面（SDK **B4**：一门语言的 Monaco 语言面 = 插件供数据、宿主落 Monaco）。
 *
 * ## 这一格解决什么
 *
 * Monaco 有三副"语言面"，今天全住在宿主里：
 *
 * | 副 | 内容 | 宿主落点（Monaco API） |
 * |---|---|---|
 * | 词法 | Monarch 状态机（正则 + token 名 + 词表 + 状态） | `languages.setMonarchTokensProvider` |
 * | 配置 | 注释符 / 成对记号 / 回车层级 / 缩进阶梯 / 词边界 | `languages.setLanguageConfiguration` |
 * | 主题 | 按 token 名铺的前景规则 + 主题身份（base / inherit） | `editor.defineTheme` |
 *
 * 它们本来就是**纯数据**：状态机是正则数组，配置是字符对与正则，主题是"token 名 → 色"。
 * 之所以长在宿主里，只是因为过去没人给它们开槽。开这一格之后，新增一门语言（或同一门语言
 * 的下一版语法）只需要发一个包、贡献这一格，宿主零改动。
 *
 * ## 三条硬口径
 *
 * 1. **纯数据 / 纯函数，零 Monaco 类型**。贡献方不许 `import 'monaco-editor'`——
 *    **连 `import type` 也不行**：type import 在运行时被擦除、单测永远绿，等真要把它交给
 *    第三方宿主那天才发现完蛋（与 `@kojo/kojo-lang` 的 purity 闸同一条教训）。所以本文件
 *    自己描述形状（{@link MonacoMonarchData} 等），宿主负责翻译成 Monaco 的类型。
 *    枚举值同理：`indentAction` 是 `'indent'` 这样的**字符串**，不是
 *    `monaco.languages.IndentAction.Indent`——后者只有握着 Monaco 实例的人才拿得到。
 *
 * 2. **token 名是语言事实，颜色是主题事实**。词法发哪个 token 名由供方定；
 *    主题那一副的键必须是**语义角色名**（LAU-2 的 `role.*`），不许在供方里重新长出一套
 *    私有 token 命名（那正是 LAU-2 收口前的状态：三处各配一遍色）。
 *    部件色（`editor.background` / `menu.*` 那一族）属编辑器 chrome、不属语言面，
 *    供方只声明"我属于哪一侧"（{@link MonacoThemeContributionData.componentPalette}）。
 *
 * 3. **判据只有一份**：这一格是某门语言的 Monaco 面的**唯一**来源。宿主侧不留"兜底实现"，
 *    见下面的退化口径。
 *
 * ## 退化口径（写死这一条，不许含糊）
 *
 * **没有供方 = 语言仍被认领，但那一副面不存在，且必须说出来。** 具体形态：
 *
 * - descriptor 的认领（`id` / 扩展名 / `matchesPath`）不受影响 ⇒ 文件照样打得开、
 *   语言 id 照样是对的（认领与语言面是两件事，见 `docs/ARCH-language-unification.md` §4.3）；
 * - **不调** `setMonarchTokensProvider` / `setLanguageConfiguration`（不是"调一次空的"：
 *   空的 `onEnterRules` 会顶掉 Monaco 的内建行为，那等于把"没有供方"变成"供方给了错的"）；
 * - **不定义**该供方的主题；作者若把偏好指到那个不存在的主题 id， Monaco 回落 `vs-dark`，
 *   宿主那条 warn 会说明为什么；
 * - 宿主打**一条** `console.warn`（每门语言、每个 Monaco 实例至多一次）：
 *   `[monaco-language-surface] 「<languageId>」没有语言面供方（插件未激活）：文件可打开、
 *   语言 id 正确，但没有语法着色 / 缩进规则`——与"插件状态面板显示 inactive"合起来读，
 *   作者能把"没色"和"没装插件"对上号（铁律 4：inactive 必须可见）。
 *
 * **不许**另一种退化：宿主内置一份兜底实现。那样判据就有两份，而两份必然漂。
 *
 * ## 同语言多供方
 *
 * 同一个 `languageId` 被两枚贡献声明 ⇒ 宿主**保留先注册的**（注册序 = `order` 后的槽序），
 * 对后者打 `console.error`（铁律 4：冲突必须 error）。不做合并：状态机规则顺序即优先级，
 * 两家规则并起来得到的不是"两家之和"而是"谁也说不清的那一份"。
 *
 * ## 与 `ui.editor.languageService` 的分工
 *
 * 那一格是**请求驱动的判据**（定义 / 大纲 / 提示：给位置、回位置）；这一格是**一次性装配数据**
 * （注册期取一次、落进 Monaco，此后 Monaco 自己用）。两者都由同一门语言的包提供，
 * 但形状与生命周期完全不同，故各开一格、不塞进同一个 `provide`。
 *
 * 本文件是**纯类型叶子**（零值导出）：桶只许 `export type`，宿主 `slots.ts` 用 `import type`
 * 引它 ⇒ 开机静态图把它整枚擦掉（与 `plugin-api/inline-completion.ts` 同一条纪律，
 * 由 `tests/monaco-language.test.ts` 的「零值导出」闸钉住）。
 */

/* ============================== 词法面（Monarch） ============================== */

/**
 * Monarch 的一条动作。三档形态与 Monaco 的 `IMonarchLanguageAction` 一一对应，
 * 只是不含它的类型：
 *
 * - `'role.keyword'` —— 直接给 token 名（`''` = 命中但不上色，仍算消费了这一段）；
 * - `{ token, next, cases }` —— 给 token 名、同时切状态（`next` 写 `'@push'` / `'@pop'` /
 *   `'@state'` 原样传给 Monaco），或按卫兵分派（`cases` 的键是 `'@default'` / `'@词表名'` /
 *   `'$1==…'`，值仍是动作）；
 * - `[动作, 动作]` —— 一组并列动作（Monaco 的 `[token, {cases}]` 写法；元素继续递归）。
 *
 * 这一格刻意是**具名接口**而不是"任意对象"：写成 `Record<string, unknown>` 的话
 * `{ tokne: '…' }` 这种拼错要等到屏上没色才看得见。宿主翻译时还会再查一遍未知键。
 */
export interface MonacoMonarchActionCase {
  readonly token?: string;
  readonly next?: string;
  readonly cases?: Readonly<Record<string, MonacoMonarchAction>>;
}

export type MonacoMonarchAction =
  | string
  | MonacoMonarchActionCase
  | readonly MonacoMonarchAction[];

/** Monarch 规则的模式：正则本体，或 Monaco 支持的字面量串（本仓只用正则） */
export type MonacoMonarchPattern = RegExp | string;

/**
 * 一条 Monarch 规则。`[模式, 动作]` 的两元组形态。
 *
 * ⚠ 顺序即优先级：Monarch 在同一条规则表里自上而下取第一个命中项。词法判据里"类型词必须
 * 排在保留词之前"这一类约定，就是这一条顺序决定的——合并两家规则表等于改判据。
 */
export type MonacoMonarchRule = readonly [pattern: MonacoMonarchPattern, action: MonacoMonarchAction];

/**
 * 词表（Monarch 的 `@名字` 卫兵取的那份数组）。
 *
 * 键 = 状态机里 `@declWords` 去掉 `@` 之后的名字；值 = 词条数组。
 * **词形必须来自单一真源**（core / 共享词表包），不许在这一层抄一份中文。
 */
export type MonacoMonarchWordLists = Readonly<Record<string, readonly string[]>>;

/**
 * Monarch 定义（`setMonarchTokensProvider` 的第二参，去掉 Monaco 类型后的等价形状）。
 *
 * 只声明本仓真正用到的三格 + 一个 `wordLists` 出口；Monaco 的其余可选字段
 * （`brackets` / `start` / `end` / `unicode`）等真有供方要用再 additive 补，
 * 不要预先开一堆没人消费的口子。
 */
export interface MonacoMonarchData {
  readonly ignoreCase?: boolean;
  /** 未命中任何规则时的 token 名（本仓用 `''` = 不上色） */
  readonly defaultToken?: string;
  readonly wordLists?: MonacoMonarchWordLists;
  /** 状态表：`root` 是入口，其余状态名由规则里的 `next` 引用 */
  readonly tokenizer: Readonly<Record<string, readonly MonacoMonarchRule[]>>;
}

/* ============================== 配置面（language configuration） ============================== */

/**
 * 回车动作（**档位名**，不是 Monaco 枚举值）。
 * 档位集合与 `monaco.languages.IndentAction` 逐字同名；宿主按这张表取枚举，
 * 取不到的档位 ⇒ **丢弃该条并 warn**（可见退化），不当" none"处理。
 */
export type MonacoIndentAction = 'none' | 'indent' | 'indentOutdent' | 'appendTab' | 'outdent';

export interface MonacoOnEnterAction {
  readonly indentAction: MonacoIndentAction;
  /** 回车时从行尾删掉的字符数（本仓不用；缺省 = 0） */
  readonly removeText?: number;
}

export interface MonacoOnEnterRule {
  readonly beforeText?: RegExp;
  readonly afterText?: RegExp;
  readonly previousText?: RegExp;
  readonly action: MonacoOnEnterAction;
}

export interface MonacoIndentationRules {
  readonly increaseIndentPattern?: RegExp;
  readonly decreaseIndentPattern?: RegExp;
  readonly indentNextLinePattern?: RegExp;
  readonly unindentPattern?: RegExp;
}

export interface MonacoAutoClosingPair {
  readonly open: string;
  readonly close: string;
  /** 不自动闭合的上下文（Monaco 只有这三档；"我在原生围栏里"这类上下文判据属结构层，别在这里造假） */
  readonly notIn?: readonly ('comment' | 'string' | 'regex')[];
}

export interface MonacoSurroundingPair {
  readonly open: string;
  readonly close: string;
}

/**
 * 语言配置（`setLanguageConfiguration` 的第二参，去掉 Monaco 类型后的等价形状）。
 *
 * `wordPattern` 是**可选**的：词边界判据在本仓是全编辑器一条线（双击选词 / 补全触发字符
 * 都吃同一份 CJK 标点集，宿主侧的 `CJK_WORD_SEPARATORS`），不是某一门语言的事实；
 * 一门语言确实要覆盖它时才写这一格。**缺省 = 宿主用它那一份**，不是"兜底实现"——
 * 这一格里没有判据，只有编辑器 chrome 的选词口径。
 */
export interface MonacoLanguageConfigurationData {
  readonly comments?: {
    readonly lineComment?: string;
    readonly blockComment?: readonly [open: string, close: string];
  };
  /** 参与配对高亮 / 跳到配对的括号对（`open === close` 的字面量不算括号） */
  readonly brackets?: readonly (readonly [open: string, close: string])[];
  readonly autoClosingPairs?: readonly MonacoAutoClosingPair[];
  readonly surroundingPairs?: readonly MonacoSurroundingPair[];
  readonly onEnterRules?: readonly MonacoOnEnterRule[];
  readonly indentationRules?: MonacoIndentationRules;
  readonly wordPattern?: RegExp;
}

/* ============================== 主题面 ============================== */

/** 一条前景规则（`token` 写语义角色名 `role.*`；`foreground` 是不带 `#` 的 6/8 位十六进制） */
export interface MonacoTokenThemeRuleData {
  readonly token: string;
  readonly foreground: string;
  readonly fontStyle?: 'bold' | 'italic';
}

/** Monaco 主题基底档位 */
export type MonacoThemeBase = 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';

/** 宿主部件色的**侧名**（本仓三侧：暗 / 亮 / 墨绿；两侧以上再 additive 扩） */
export type MonacoComponentPaletteSide = 'dark' | 'light' | 'mint';

/**
 * 一套主题的贡献数据（`defineTheme` 的第二参，去掉 Monaco 类型后的等价形状）。
 *
 * `rules` 是这门语言的**语言面**（哪些角色存在、各给什么色）；`colors` 是编辑器 chrome
 * （行号 / 浮层 / 滚动条那一族 91 键），本仓由宿主按 {@link componentPalette} 那一侧
 * 现取——语言包不该抄一份部件色，那是六套主题共用的东西，抄了就必然与 v1 那几套漂。
 * 确实要自带部件色的供方可以显式写 `colors`（写了就以它为准）。
 */
export interface MonacoThemeContributionData {
  readonly id: string;
  readonly base: MonacoThemeBase;
  /** 是否从基底借色（本仓全部 `false`：`inherit: false` 下未列的键落 Monaco 默认色） */
  readonly inherit: boolean;
  readonly rules: readonly MonacoTokenThemeRuleData[];
  /** 部件色取宿主哪一侧（缺省 = `'dark'`；与 `colors` 同时给时以 `colors` 为准） */
  readonly componentPalette?: MonacoComponentPaletteSide;
  /** 自带部件色（键名用 Monaco 的 `editor.*` / `menu.*` 那一族） */
  readonly colors?: Readonly<Record<string, string>>;
}

/* ============================== 一格贡献的整体形状 ============================== */

/**
 * 一门语言的 Monaco 语言面。三副都是可选的：一门语言可以只有词法没有主题（主题由宿主统一铺）。
 *
 * ⚠ "可选"不等于"可以整枚缺席"：一枚贡献若三副全空，宿主按"没有供方"处理并 warn——
 * 空对象不是语言面，是接线忘了填。
 */
export interface MonacoLanguageSurface {
  /** Monaco 语言 id（= descriptor 的那一枚；宿主据此认领该语言的注册时机） */
  readonly languageId: string;
  readonly monarch?: MonacoMonarchData;
  readonly configuration?: MonacoLanguageConfigurationData;
  readonly themes?: readonly MonacoThemeContributionData[];
}

/**
 * 槽 `ui.monaco.language` 的贡献方。
 *
 * 与 `ui.editor.languageService` 的 `provide(request)` 不同，这里没有请求：语言面是
 * **注册期一次性交出的数据**，所以贡献物直接是 {@link surface} 字段（同 `game.adapter` 那一族）。
 * 数据必须是**稳定引用**（同一枚对象，不要在 getter 里现造）：宿主按引用判重复注册。
 *
 * `id` / `order` / `pluginId` 三格与 `inline-completion.ts` 的
 * `InlineCompletionSourceContribution` 同形（本叶子不 import `slots.ts`，
 * 免得契约内部长出一条反向依赖）。
 */
export interface MonacoLanguageContribution {
  readonly id: string;
  readonly order?: number;
  readonly pluginId?: string;
  readonly surface: MonacoLanguageSurface;
}
