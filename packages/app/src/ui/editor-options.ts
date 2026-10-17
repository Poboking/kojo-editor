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
 * 全局快建议（QSUG-1，2026-10-18 用户点名）：**代码位边打字边弹**，注释 / 字符串不弹。
 *
 * 与 VSCode 默认口径对齐：`other:true`，`comments:false`，`strings:false`。
 * 台词 / 旁白不是 Monaco 的语法概念（`.kojo` 里它们是 `text` / `heartText` 行），
 * 由 `.kojo` 装配的 `locate` 门为零候选（`kojo-suggest-gate.ts`）——不在 Monaco 选项里
 * 靠字符猜。只读 / 糖预览由宿主把 `quickSuggestions` 整条关掉（`EditorPane` 的
 * `applyEditabilityAndSuggest`），因为 provider 拿不到 editor 的可写状态。
 *
 * `wordBasedSuggestions` 仍为 `off`：Monaco 内建的词 provider 在**任意位置**出货，绕不过
 * `.kojo` 的台词 / 旁白门。文档词改由语言侧的受门 source 提供（`document-words.ts`），
 * 开关见 `suggest-pref.ts` 的 `wordBasedSuggestions`。
 */
export const QUICK_SUGGESTIONS = { other: true, comments: false, strings: false } as const;

/**
 * 只读编辑器整条关掉快建议；可写编辑器按设置页开关给 {@link QUICK_SUGGESTIONS}。
 * `enabled` 缺省 true（调用方只管只读态时的旧用法零改动）。
 */
export function quickSuggestionsFor(
  readOnly: boolean,
  enabled = true,
): EditorOptionPatch['quickSuggestions'] {
  return readOnly || !enabled ? false : QUICK_SUGGESTIONS;
}

/**
 * 中文语料的打字噪声 / 选词基线（A2+A3，**所有档位同值**）：
 * 既 spread 进 `editorOptionsForLineCount`（切文件路径），也 spread 进 EditorPane 的 create options。
 *
 * - `quickSuggestions`——代码位开、注释 / 字符串关（见 {@link QUICK_SUGGESTIONS}）；
 *   `.kojo` 台词 / 旁白 / 注释由装配侧代码门清零，不靠 Monaco 分词猜。
 * - `unicodeHighlight`——monaco 公开面没有 VS Code 的 `'neverVisible'` 词汇，
 *   `nonBasicASCII:false` 即等价；歧义字符**保持告警**（西里尔等真同形异义照标），
 *   常用中文标点由 `allowedLocales`(zh) + `allowedCharacters`(白名单) 双保险排除
 *   （`UnicodeTextModelHighlighter.computeUnicodeHighlightReason` 实测 null；
 *   默认 locale 集 `_default` 会把 ，：（）！？； 全标红——这就是本项要灭的噪声）。
 * - `wordSeparators`——双击 / Ctrl+方向键的分词表（`WordCharacterClassifier` 对
 *   charCode≥256 走 Map 分支，全角标点真实生效）。
 */
export const CJK_TYPING_BASELINE: EditorOptionPatch = {
  quickSuggestions: QUICK_SUGGESTIONS,
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
  // Monaco 内建词 provider 任意位置都出货（台词行弹词）⇒ 永远关；文档词由
  // `document-words.ts` 的受门 source 提供，开关在 `suggest-pref.ts`
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
  // 击键即格式化（F5）：ERB on-type provider 每次触发都要 getValue 整篇 + 全文档扫描
  //（O(行数)）——大文件每敲一个 `;` 就整篇跑一遍。关掉；要格式化走显式命令/保存动作。
  formatOnType: false,
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
 * find 体验基线（A7，**所有档位同值**）：spread 口径与 `CJK_TYPING_BASELINE` 逐字同款
 * （`editorOptionsForLineCount` 切文件路径 + EditorPane 的 create options 都要带上，缺一吞一档）。
 *
 * vendor 实测（monaco 0.57 `IEditorFindOptions` + `EditorFind.validate` 白名单）：
 * `loopAtEnd` 不存在（循环查找真名是 `loop`，缺省已 true）；
 * `seedSearchStringFromGlobalClipboard` 非公开配置。
 * 「选中即搜」是 `seedSearchStringFromSelection !== 'never'` 的内建行为（缺省 'always'），
 * 这里显式钉住防档位漂移。
 */
export const FIND_BASELINE: EditorOptionPatch = {
  find: {
    seedSearchStringFromSelection: 'always',
    loop: true,
  },
};

/**
 * 与文件规模相称的 Monaco 选项（**纯函数**）= 中文基线 + find 基线 + 公共补丁 + 档位表全量。
 */
export function editorOptionsForLineCount(lineCount: number): EditorOptionPatch {
  return {
    ...CJK_TYPING_BASELINE,
    ...FIND_BASELINE,
    ...COMMON_OPTIONS,
    ...TIER_OPTIONS[editorProfileTierForLineCount(lineCount)],
  };
}
