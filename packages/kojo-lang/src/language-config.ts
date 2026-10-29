/**
 * Kojo 2.0 的 **Monaco 语言配置面**（U6 / B4）：成对记号 + 注释符 + 回车层级 + 缩进阶梯。
 *
 * 这一层回答两件事：**敲括号时编辑器怎么配对 / 补闭**，以及**按 Enter 时下一行要不要多一级
 * 缩进**。判据与词法面同源（{@link KOJO2_INDENT_WIDTH} 来自 core），本文件不认任何中文字形，
 * 只认"行尾是否全角冒号"与"这一行是否 `@原生` 围栏头"两种形状。
 *
 * ## 交出去的是数据，不是 Monaco 配置对象
 *
 * 契约那一格（`plugin-api/monaco-language.ts` 的 `MonacoLanguageConfigurationData`）与这里
 * 逐字同形，只差两件事：
 * - `indentAction` 写档位名 `'indent'`，不是 `monaco.languages.IndentAction.Indent`——
 *   枚举值只有握着 Monaco 实例的人才拿得到；宿主按契约那张闭集查表翻译，查不到就**丢弃并
 *   warn**（可见退化，不当"不改"处理）；
 * - `wordPattern` 这里**不写**。词边界是全编辑器一条线（双击选词 / 补全触发字符都吃宿主那份
 *   CJK 标点单源），不是 2.0 独有的事实；供方确实要覆盖时才写那一格（口径见契约头注）。
 *
 * ## 口径
 * - **块头 `：` → 下一行 +1 级**：2.0 正典块头不写冒号（`# 对照表 心情 依据 恋慕` / `? 恋慕 >= 500`），
 *   但迁移期与 `选项：` 一类 UI 块头仍以全角冒号收尾；作者在冒号后回车时必须直接落进体里。
 * - **`@原生` 围栏头 → 下一行 +1 级**：仓体内必须比栏头深（规范 §8.5），否则块体为空。
 * - **`@原生` 体内不动**：围栏内是 ERB 原文，任何"按形状猜层级"的动作都会改坏原文。
 *   Monaco 的 `onEnterRules` 只能看**当前行**（拿不到"我在围栏内"这个上下文）⇒ 静态配置
 *   只能做形状近似；真正的上下文判据是 {@link kojo2EnterIndent}（纯函数，`inNativeFence`
 *   为真时一律 0）。CUTOVER 若接编辑器级 enter handler，必须调这一个函数，不要另写一份。
 * - **Enter 上不许有 Outdent**：收束永远由作者回缩决定（2.0 没有全局收束词），自动回缩会把
 *   作者刚写的体弹出去；这条与 `.kojo` v1 的回车纪律一致。
 */

import {
  KOJO2_INDENT_WIDTH,
  KOJO2_NATIVE_FENCE_WORD,
  escapeRegExp,
} from './lexicon';

/** 一级缩进 = 4 空格（core `KOJO_INDENT_WIDTH`，本文件不写魔数）。 */
export const KOJO2_INDENT_UNIT = ' '.repeat(KOJO2_INDENT_WIDTH);

/** 块头判据：行尾全角冒号（含尾部空白）。 */
export const KOJO2_BLOCK_HEADER_COLON_RE = /^\s*\S.*：\s*$/;

/** `@原生{` 围栏头（新典；裸 `@原生` 旧写法容忍；缩进不限——块内也允许出现围栏）。 */
export const KOJO2_NATIVE_HEADER_RE = new RegExp(
  `^\\s*@${escapeRegExp(KOJO2_NATIVE_FENCE_WORD)}(?:\\{)?\\s*$`,
);

/** 回车时该行是否 `@原生` 围栏头（上下文判据的一枚原子，测试与 enter handler 共用）。 */
export function kojo2IsNativeFenceHeader(lineText: string): boolean {
  return KOJO2_NATIVE_HEADER_RE.test(lineText);
}

export interface Kojo2EnterContext {
  /**
   * 光标所在行是否处于 `@原生` 围栏体内。**围栏内一律不自动缩进**（原文保真优先）；
   * Monaco 语言配置拿不到这个上下文，故由 CUTOVER 的 enter handler 传进来。
   */
  readonly inNativeFence?: boolean;
}

/**
 * 回车层级判据（纯函数）：返回下一行应当追加的缩进级数（0 = 保持原样，1 = 多一级）。
 *
 * 顺序即优先级：围栏内不动 → `@原生` 栏头 +1 → 块头冒号 +1 → 其余不动。
 */
export function kojo2EnterIndent(lineText: string, context: Kojo2EnterContext = {}): number {
  if (context.inNativeFence === true) return 0;
  if (kojo2IsNativeFenceHeader(lineText)) return 1;
  if (KOJO2_BLOCK_HEADER_COLON_RE.test(lineText)) return 1;
  return 0;
}

/**
 * Monaco `onEnterRules` 的数据形态（契约的 `MonacoOnEnterRule[]`）：每一格都只可能是
 * `indent`（绝不 outdent）。
 *
 * 两格顺序即优先级：`@原生` 栏头先于通用冒号判据（栏头不写冒号，顺序其实不相交；
 * 写死顺序是给以后加规则的人看"更专有的形状先判"）。
 */
export const KOJO2_ON_ENTER_RULES: readonly {
  readonly beforeText: RegExp;
  readonly action: { readonly indentAction: 'indent' };
}[] = Object.freeze([
  { beforeText: KOJO2_NATIVE_HEADER_RE, action: { indentAction: 'indent' as const } },
  { beforeText: KOJO2_BLOCK_HEADER_COLON_RE, action: { indentAction: 'indent' as const } },
]);

/**
 * 回车层级的两格（`onEnterRules` 与 `indentationRules.increaseIndentPattern` 必须同源）：
 * 后者是前两格 `beforeText.source` 的并集形，`kojo2-language.test.ts` 钉住"每一格都含于它"。
 */
export const KOJO2_INDENTATION_RULES = {
  increaseIndentPattern: new RegExp(
    `(?:${KOJO2_NATIVE_HEADER_RE.source})|(?:${KOJO2_BLOCK_HEADER_COLON_RE.source})`,
  ),
  // 2.0 的收束靠作者回缩（没有全局收束词）⇒ 永不自动 outdent。
  decreaseIndentPattern: /(?!)/,
} as const;

/* ============================== 成对记号与配置装配 ============================== */

/**
 * 打字期成对记号（**一处登记、三格消费**：`brackets` = 配对高亮 / 对着色 / 跳到配对，
 * `autoClosingPairs` = 敲开括号补闭括号，`surroundingPairs` = 选中文本敲括号包住它）。
 *
 * 每一对都要有 2.0 语法事实背书：
 * - `「」` 台词引号（§4.5；台词体内的 `#` / `?` / `>` 是正文，靠这一对圈住）；
 * - `{}` 插值（§4.12；闭合插值的收束记号）；
 * - `[]` 数组类型后缀 `字符串[3]`（§3.4）与 `# 模` 的 `[插槽]`（§7.2）；
 * - `（）` / `()` 旁白括注 / 实参括注（全角括注是正文，半角才是表演提示，§4.8）；
 * - `""` 字符串字面量（表值 / 函数默认参数）。
 *
 * **不许进这张表的**：全角 `：` / `，`（块头终止符与分隔符，不是括号对）、`『』`（语法不认这一对，
 * 正文里出现也只是字面文本）。`autoClosingPairs` 的 `notIn` 只有 `string` / `comment` / `regex`
 * 三档，表达不了"我在 `@原生` 围栏里"——那条上下文判定住宿主的 `kojo2-indent.ts` 的 on-type 层
 * （同一台词法器判 `kind === 'native'`），不在语言配置里造假。
 */
export const KOJO2_PAIRS: readonly (readonly [open: string, close: string])[] = Object.freeze([
  ['{', '}'],
  ['[', ']'],
  ['「', '」'],
  ['（', '）'],
  ['(', ')'],
  ['"', '"'],
] as const);

/**
 * 语言配置（`setLanguageConfiguration` 那一副数据；全部由单源派生）。
 *
 * `comments` 是 2.0 注释唯一正典：整行 `//`（`;` 只属于 `@原生` 里的 ERB，不能进这一格）。
 * 三格同一张 {@link KOJO2_PAIRS} 派生；`open === close` 的 `"` 不是括号，只进闭合/包裹两格。
 * `wordPattern` 刻意缺席——见文件头那条口径（词边界归宿主的 CJK 单源）。
 */
export const KOJO2_LANGUAGE_CONFIGURATION = {
  comments: { lineComment: '//' },
  brackets: KOJO2_PAIRS.filter(([open, close]) => open !== close).map(
    ([open, close]) => [open, close] as [string, string],
  ),
  autoClosingPairs: KOJO2_PAIRS.map(([open, close]) => ({ open, close })),
  surroundingPairs: KOJO2_PAIRS.map(([open, close]) => ({ open, close })),
  onEnterRules: KOJO2_ON_ENTER_RULES,
  indentationRules: KOJO2_INDENTATION_RULES,
};
