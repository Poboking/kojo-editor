/**
 * Monaco 选项：按文件体量分级（2026-10-12「内核优化」批；目标 = 超长文件丝滑）。
 *
 * ## 背景（实测，见 `docs/archive/PERF-REVIEW-2026-10-11.md` §7.3/§7.6）
 *
 * 真实口上语料里最大的单个 ERB 达 **52,601 行 / 2.35 MB**（2,317 个文件中 ≥5,000 行的
 * 占 6.0%）。原先 `monaco.editor.create` 里**一个相关开关都没设**，全部走 Monaco 默认值，
 * 其中三项的默认值在大文件上是"全文级"操作：
 *
 * | 选项 | 默认 | 大文件上的代价 |
 * |---|---|---|
 * | `occurrencesHighlight` | `singleFile` | 光标一停就**整篇找同词** |
 * | `bracketPairColorization` | 开 | 需在**整篇文档**上建配对标色 |
 * | `matchBrackets` | `always` | 整篇文档找配对括号 |
 *
 * 本模块把这些开关按体量分两档（阈值 `LARGE_FILE_LINES`），编辑口上的实际需求
 * （读/改台词行）不需要上述任何一项在大文件上开启。
 *
 * **纯函数**（`editorOptionsForLineCount`）便于单测；宿主在**每次切文件**时调用并
 * `editor.updateOptions(...)`。
 */
import type * as Monaco from '../monaco/entry';
import { CJK_AMBIGUOUS_WHITELIST, CJK_WORD_SEPARATORS } from '../monaco/word-separators';

/** 大文件阈值（行）：≥ 此行数即降级若干"全文级"Monaco 特性 */
export const LARGE_FILE_LINES = 5000;

/** 供 `editor.updateOptions` 使用的选项补丁 */
export type EditorOptionPatch = Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions;

/**
 * 中文语料的打字噪声 / 选词基线（A2+A3，**大小文件两档同值**）：
 * 既 spread 进 `editorOptionsForLineCount`（切文件路径），也 spread 进 EditorPane 的 create options。
 *
 * - `quickSuggestions:false`——两个补全 provider 在任何 token 上下文都无门槛地返回候选
 *   （`mergeSuggestions` 不做 token 判定），台词行连打必然弹无关列表；而显式触发字符
 *   （`{` `：` `#` `[`）走 `suggestModel._updateTriggerCharacters`（受
 *   `suggestOnTriggerCharacters` 而非 quickSuggestions 门控）、Ctrl+Space 走手动 trigger，
 *   两条路都不受影响（monaco 0.57 `suggest/browser/suggestModel.js` 已核）。
 * - `unicodeHighlight`——monaco 公开面没有 VS Code 的 `'neverVisible'` 词汇，
 *   `nonBasicASCII:false` 即等价；歧义字符**保持告警**（西里尔等真同形异义照标），
 *   常用中文标点由 `allowedLocales`(zh) + `allowedCharacters`(白名单) 双保险排除
 *   （`UnicodeTextModelHighlighter.computeUnicodeHighlightReason` 实测 null；
 *   默认 locale 集 `_default` 会把 ，：（）！？； 全标红——这就是本项要灭的噪声）。
 * - `wordSeparators`——双击 / Ctrl+方向键的分词表（`WordCharacterClassifier` 对
 *   charCode≥256 走 Map 分支，全角标点真实生效）。
 */
export const CJK_TYPING_BASELINE: EditorOptionPatch = {
  quickSuggestions: false,
  wordSeparators: CJK_WORD_SEPARATORS,
  unicodeHighlight: {
    nonBasicASCII: false,
    // U+3000 全角空格照旧标形——与保存前的全角空格确认门同一道防线，不是噪声
    invisibleCharacters: true,
    ambiguousCharacters: true,
    allowedLocales: { 'zh-hans': true, 'zh-hant': true },
    allowedCharacters: CJK_AMBIGUOUS_WHITELIST,
  },
};

/**
 * 与文件规模相称的 Monaco 选项（**纯函数**）。
 *
 * 小文件档 = 保留全部便利特性；大文件档 = 关掉"全文级"开销，只留视图内的那些。
 */
export function editorOptionsForLineCount(lineCount: number): EditorOptionPatch {
  const large = lineCount >= LARGE_FILE_LINES;
  return {
    ...CJK_TYPING_BASELINE,
    // 光标停留即"整篇找同词"——大文件头号隐性开销
    occurrencesHighlight: large ? 'off' : 'singleFile',
    // 基于词的建议对 ERB / 口上中文文本无意义（补全由自带 provider 提供），
    // 且默认会在输入时扫文档——一律关
    wordBasedSuggestions: 'off',
    // 括号配对高亮：'always' 对整篇文档找配对；大文件降为"仅视口附近"
    matchBrackets: large ? 'near' : 'always',
    // 括号对着色需在整篇文档上建索引——大文件关
    bracketPairColorization: { enabled: !large },
    // 缩略图：小文件保留"文本块"模式（口上是长行文，色块更干净也更省）；
    // 大文件整篇渲染不划算，关掉
    minimap: large ? { enabled: false } : { enabled: true, renderCharacters: false, maxColumn: 72 },
    // 当前行高亮：'all' 会额外整行铺色；大文件只保留行号侧
    renderLineHighlight: large ? 'line' : 'all',
    // 粘性滚动（B3）：小文件档开——贴顶行给的就是大纲项（当前函数 / 当前时机块），
    // 读长正文时"我在哪一层"不再靠滚回开头看。大文件档仍关：贴顶要在每次滚动后
    // 按可见区间重算行位置，52,000 行那种文件上不划算（与本模块其余降级同一条理由）。
    stickyScroll: large ? { enabled: false } : { enabled: true, maxLineCount: 4 },
  };
}
