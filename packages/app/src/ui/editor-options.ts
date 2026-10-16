/**
 * Monaco 选项：按文件体量分三档降级（表驱动；目标 = 超长文件丝滑）。
 *
 * | 档 | 行数 | 定位 |
 * |---|---|---|
 * | `small` | < 5,000 | 全部便利特性（引导线全开、光标动画全速） |
 * | `large` | ≥ 5,000（语料 ≥5,000 行占 6.0%，最大单文件 52,601 行） | 关"全文级"开销 |
 * | `huge` | ≥ 50,000（语料有 99 万行级盘） | 装饰性渲染也一并关 |
 *
 * 全档不变式：`CJK_TYPING_BASELINE` 每档 spread；降级集永不含 `fontSize` / `zoomLevel`
 * （A1 偏好独立管，走 EditorZoom 单例）。所有键已对 monaco-editor@0.57.0 `monaco.d.ts`
 * 实测核实（IEditorOptions / IGlobalEditorOptions / IGuidesOptions）。
 *
 * **纯函数**（`editorOptionsForLineCount`）便于单测；宿主在**每次切文件**时调用并
 * `editor.updateOptions(...)`，切回小文件即恢复（补丁是全量重发、不卡死）。
 */
import type * as Monaco from '../monaco/entry';
import { CJK_AMBIGUOUS_WHITELIST, CJK_WORD_SEPARATORS } from '../monaco/word-separators';

/** 大文件阈值（行）：≥ 此行数即降级若干"全文级"Monaco 特性 */
export const LARGE_FILE_LINES = 5000;

/** 超大文件阈值（行）：≥ 此行数连视口级的装饰性渲染也一并关 */
export const HUGE_FILE_LINES = 50_000;

/** 体量档位（表驱动降级：每档一行表项，差异一眼可读、可测） */
export type EditorProfileTier = 'small' | 'large' | 'huge';

/** 供 `editor.updateOptions` 使用的选项补丁 */
export type EditorOptionPatch = Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions;

/**
 * 中文语料的打字噪声 / 选词基线（A2+A3，**所有档位同值**）：
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

/** 与体量无关的公共补丁（各档共用，不进档位表） */
const COMMON_OPTIONS: EditorOptionPatch = {
  // 基于词的建议对 ERB / 口上中文文本无意义（补全由自带 provider 提供），且默认会扫文档
  wordBasedSuggestions: 'off',
  // 语料缩进实况（fixtures 全量 .ERB/.erb 清点：tab 488 行 vs 空格缩进 2 行且非语料文件）：
  // tab 惯例钉死；关探测后（large/huge）靠这两键兜底，探测开着时（small）仍随文件内容走
  tabSize: 4,
  insertSpaces: false,
};

/** small 档全量（与 EditorPane 的 create options 对齐——切标签往返不产生"半套恢复"） */
const TIER_SMALL: EditorOptionPatch = {
  occurrencesHighlight: 'singleFile',
  matchBrackets: 'always',
  bracketPairColorization: { enabled: true },
  // 引导线全开：括号对纵向 guide + 缩进 guide + 活动项高亮
  guides: {
    bracketPairs: true,
    bracketPairsHorizontal: 'active',
    highlightActiveBracketPair: true,
    indentation: true,
    highlightActiveIndentation: true,
  },
  minimap: { enabled: true, renderCharacters: false, maxColumn: 72 },
  renderLineHighlight: 'all',
  renderLineHighlightOnlyWhenFocus: false,
  // 粘性滚动（B3）：贴顶行给的就是大纲项（当前函数 / 当前时机块）
  stickyScroll: { enabled: true, maxLineCount: 4 },
  smoothScrolling: true,
  cursorBlinking: 'blink',
  cursorSmoothCaretAnimation: 'on',
  // 偶尔混排的空格文件跟内容走（探测只扫文件头，代价可忽略）
  detectIndentation: true,
};

/** large 档全量（huge 在其上再削；同时也是 huge 档的继承基座） */
const TIER_LARGE: EditorOptionPatch = {
  // 光标停留即"整篇找同词"——大文件头号隐性开销
  occurrencesHighlight: 'off',
  // 括号配对高亮：'always' 对整篇文档找配对；大文件降为"仅视口附近"
  matchBrackets: 'near',
  // 括号对着色需在整篇文档上建索引——大文件关
  bracketPairColorization: { enabled: false },
  // 引导线缩到"活动括号对"：视口级、不随全文增长
  guides: {
    bracketPairs: 'active',
    bracketPairsHorizontal: 'active',
    highlightActiveBracketPair: false,
    indentation: false,
    highlightActiveIndentation: false,
  },
  minimap: { enabled: false },
  renderLineHighlight: 'line',
  // 失焦仍铺高亮是白烧一次整行重绘
  renderLineHighlightOnlyWhenFocus: true,
  // 贴顶要在每次滚动后按可见区间重算行位置，这个体量不划算
  stickyScroll: { enabled: false },
  // 平滑滚动每帧插值重排视口；光标动画是持续重绘源——大档起全停
  smoothScrolling: false,
  cursorBlinking: 'solid',
  cursorSmoothCaretAnimation: 'off',
  // 语料同质（tab），不值得为探测再扫一遍文件头
  detectIndentation: false,
};

/** huge 档 = large 档再削掉一切视口级装饰 */
const TIER_HUGE: EditorOptionPatch = {
  ...TIER_LARGE,
  // 99 万行级盘：连视口级的括号配对查找也关（'never' 是 0.57 d.ts 合法值）
  matchBrackets: 'never',
  guides: {
    bracketPairs: false,
    bracketPairsHorizontal: false,
    highlightActiveBracketPair: false,
    indentation: false,
    highlightActiveIndentation: false,
  },
};

/** 档位差异表（键 = 档名，每档差异一眼可读、可测） */
const TIER_OPTIONS: Record<EditorProfileTier, EditorOptionPatch> = {
  small: TIER_SMALL,
  large: TIER_LARGE,
  huge: TIER_HUGE,
};

/** 档位判定（纯函数；阈值含等号，与降级语义"≥ 即降"一致） */
export function editorProfileTierForLineCount(lineCount: number): EditorProfileTier {
  if (lineCount >= HUGE_FILE_LINES) return 'huge';
  if (lineCount >= LARGE_FILE_LINES) return 'large';
  return 'small';
}

/**
 * 与文件规模相称的 Monaco 选项（**纯函数**）= 中文基线 + 公共补丁 + 档位表全量。
 */
export function editorOptionsForLineCount(lineCount: number): EditorOptionPatch {
  return {
    ...CJK_TYPING_BASELINE,
    ...COMMON_OPTIONS,
    ...TIER_OPTIONS[editorProfileTierForLineCount(lineCount)],
  };
}
