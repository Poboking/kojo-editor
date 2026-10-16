/**
 * CJK 选词 / 全角标点单一真源（A2+A3）。两条消费通道缺一不可（均按 vendored monaco 0.57 源码核实）：
 * - 编辑器选项 `wordSeparators`：双击 / Ctrl+方向键的分词走 `WordCharacterClassifier`，
 *   charCode≥256 的字符落 Map 分支（`core/characterClassifier.js`），全角标点真实生效；
 * - 语言配置 `wordPattern`：`model.getWordAtPosition/getWordUntilPosition` 走这里。
 *   `：` 触发字符尤其依赖它——quickSuggestions 全关后，`suggestModel` 的
 *   `checkTriggerCharacter` 仅当 `LineContext.shouldAutoTrigger` 为 false（即 `：` 不属于词）才放行显式触发。
 */

/** monaco 默认集（`common/core/wordHelper.js` 的 USUAL_WORD_SEPARATORS 原样）；全角字符只追加、不删减 */
const ASCII_WORD_SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";

/** 中文/全角标点：双击能把两个标点之间的短语整段选中 */
const CJK_PUNCT_SEPARATORS = '，。、；：！？「」『』（）《》【】“”‘’～…・·';

/** 供编辑器选项 `wordSeparators`（默认 ASCII 集 ∪ 全角集） */
export const CJK_WORD_SEPARATORS = ASCII_WORD_SEPARATORS + CJK_PUNCT_SEPARATORS;

/** 供 `setLanguageConfiguration(...).wordPattern`；字符集与上面的选项同源，不是第二处手抄 */
export const CJK_WORD_PATTERN = new RegExp(
  `[^${CJK_WORD_SEPARATORS.replace(/[-[\]{}()\\^$*+?.]/g, '\\$&')}\\s]+`,
  'g',
);

/**
 * 供 `unicodeHighlight.allowedCharacters`：这些标点永不进"歧义字符"判定。
 * monaco 内置 ambiguous 数据（`_common` + locale 表）会把 ，：（）！？； 乃至 “”‘’ 标红——
 * 对中文语料是灾难级噪声；西里尔等真同形异义字符不在白名单，告警能力保留
 * （`common/services/unicodeTextModelHighlighter.js` 实测，见 cjk-typing.test.ts）。
 */
export const CJK_AMBIGUOUS_WHITELIST: Readonly<Record<string, true>> = Object.fromEntries(
  Array.from(CJK_PUNCT_SEPARATORS, (ch) => [ch, true] as const),
);
