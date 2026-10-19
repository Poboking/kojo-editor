/**
 * Monaco 选项：按文件体量分三档降级（表驱动；目标 = 超长文件丝滑）。
 *
 * | 档 | 行数 | 定位 |
 * |---|---|---|
 * | `small` | < 5,000 | 全部便利特性（引导线全开、光标动画全速） |
 * | `large` | ≥ 5,000（语料 ≥5,000 行占 6.0%，最大单文件 52,601 行） | 关"全文级"开销 |
 * | `huge` | ≥ 50,000（语料有 99 万行级盘） | 装饰性渲染也一并关 |
 *
 * **档位覆盖面**（PS-5 审计口径）：真实语料只有约 6% 的文件过 5,000 行 ⇒ 绝大多数文件落在
 * `small`。所以这一族降级的价值不在"平均文件变快"，而在**长尾那一格**：一个 5 万行文件
 * 卡死一次，作者对整个编辑器的印象就定了。也正因如此，`small` 档不许为了"看着统一"而
 * 关任何便利特性（PS-5 把小档的键写全，就是为了降级可逆）。
 *
 * **审计过但没有做成档位键的三项**（都有硬约束，记在这里免得下一批再猜一遍）：
 * - find 的 `matchesCount`：vendor 自带 19,999 上限（`find/browser/findModel.js` 的
 *   `MATCHES_LIMIT`，计数到顶即停并报"20000+"），**没有**可调的公开配置项；而 `find`
 *   这一族按既有不变式**逐档同值**（见 `tests/editor-options.test.ts` 的 A7 段），
 *   想按档改 find 必须先改那条不变式——不值得为一条已被 vendor 兜住的开销动它。
 * - `unicodeHighlight`：同上属**与体量无关的中文基线**（`CJK_TYPING_BASELINE` 每档同在，
 *   大档关掉会让全角空格/U+3000 防线随文件长度消失，那是安全性回退不是性能收益）。
 * - `semanticHighlighting`：名字按角色分色（B6）是**用户偏好**，走
 *   `semantic-color-pref.ts` 单源；档位若覆写它，设置页那一格就会在某些文件上不生效。
 *
 * 全档不变式：`CJK_TYPING_BASELINE` 每档 spread；降级集永不含 `fontSize` / `zoomLevel`
 * （A1 偏好独立管，走 EditorZoom 单例）。所有键已对 monaco-editor@0.57.0 `monaco.d.ts`
 * 实测核实（IEditorOptions / IGlobalEditorOptions / IGuidesOptions）。
 *
 * **纯函数**（`editorOptionsForLineCount`）便于单测；宿主在**每次切文件**时调用并
 * `editor.updateOptions(...)`，切回小文件即恢复（补丁是全量重发、不卡死）。
 *
 * ## 这一张表是体量轴的**唯一真源**（1020 止血批立的两条规矩）
 *
 * ① **档位键不许在表外面另判一遍**。`folding` 这一档关掉过一次事故：接线层
 *    （`ui/editor-global-providers.ts` 的折叠供给器）自己按 `LARGE_FILE_LINES` 让路，
 *    而这一侧的表写着「折叠留到 huge 才关」——两份判据对不上，5k–50k 档就成了
 *    "折痕还在、一处也折不动"（静默削功能，铁律 4）。表上折叠开不开只由
 *    {@link foldingEnabledForLineCount} 回答，供给器问的就是这一条。
 * ② **大档关掉的每一条，小档必须显式写回**。`updateOptions` 只覆写发过去的键，
 *    小档漏写一条 = 从大文件切回来那条永远卡在关值（`formatOnType` 就是这么漂掉过
 *    一次：打字规范化从此对这个编辑器实例永久关闭）。这一条由
 *    {@link sizeTierKeysMissingFromSmall} 从**表里**枚举，不靠谁手抄清单——
 *    将来往大档加一条关值而忘了在小档写回值，它直接返回那个键名（测试即红）。
 *
 * ## 排版偏好叠层（P2-16）：wordWrap 三选一 + multiCursorModifier + columnSelection
 *
 * 这三个键**不是新的档位键**（`sizeTierKeys` 的枚举口径因此不变，档位表不变式照旧
 * 恒空）：`wordWrap` 仍住在档位表里（"跟随体量档" = 表自己的值），用户偏好由
 * {@link layoutPrefPatch} 作为**叠在档位表之后的 override** 进补丁——「跟随体量档」
 * = 补丁给档位表自己在当前行数上的值（等价于不传 override），「强制开 / 强制关」
 * = 盖在表上（huge 档也拦不住用户明说的选择）。`multiCursorModifier` / `columnSelection`
 * 与体量两轴正交，不进档位表，同样走这一层补丁（真源与缺省理由在 `layout-pref.ts`）。
 *
 * 两条写选项的路径因此**同源**：切文件（`editorOptionsForLineCount` → `applySizeTier`
 * 的三个写入点）与 EditorPane 的 create options 都 spread 同一个 {@link layoutPrefPatch}，
 * 没有一条路径读偏好、另一条路径留硬编码。create 时屏幕上还没有文件 ⇒ 按 small 档取值
 * （正是今天硬编码的 `'on'`），第一个文件落档后由 `applySizeTier` 按真实行数覆写。
 */
import type * as Monaco from '../monaco/entry';
import { CJK_AMBIGUOUS_WHITELIST, CJK_WORD_SEPARATORS } from '../monaco/word-separators';
import { loadLayoutPref, type LayoutPref } from './layout-pref';

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

/**
 * small 档全量（与 EditorPane 的 create options 对齐——切标签往返不产生"半套恢复"）。
 *
 * PS-5 起这一档把**每条体量轴上都存在的键**写全（`wordWrap` / `selectionHighlight` /
 * `links` / `colorDecorators` / `folding`）：`updateOptions` 只覆写发过去的键，
 * 小档不显式写回 ⇒ 从大文件切回小文件会**卡在大档的关值**（档位漂移）。
 */
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
  // ---- PS-5 补齐的体量轴（每条都是"大档要关 ⇒ 小档必须显式开"，否则切回来卡在关值）----
  wordWrap: 'on',
  selectionHighlight: true,
  links: true,
  colorDecorators: true,
  folding: true,
  // 打字规范化（T13 / ZH-D4）：大档关的是"每击键整篇跑一遍"那一刀，小档必须开回来。
  // 这一条漂掉过的代价最隐蔽——Monaco 只在 `formatOnType` 为真时才派发 on-type provider，
  // 而这一位**没有别的地方会再写**（创建时开一次、大档关一次），于是"开过任何一个 ≥5,000 行
  // 文件之后，这个编辑器实例到关掉为止都不再就地整理 `;` / 全角空格，回车缩进也失去兜底"。
  formatOnType: true,
};

/**
 * large 档全量（huge 在其上再削；同时也是 huge 档的继承基座）。
 *
 * PS-5 新增的四条各自关掉一个**全文级**扫描（口径与 VS Code `editor.largeFileOptimizations`
 * 同一族——那份开关关的就是 selectionHighlight / occurrencesHighlight / folding /
 * bracketPairColorization / stickyScroll 这一批"随文件长度增长"的功能；我们没那个总开关，
 * monaco-editor 不导出它，只能自己按档列）：
 * - `selectionHighlight:false`——每次光标/选区变化都在**整篇**收集同词区间并挂装饰
 *   （`selectionHighlighter.ts` 走 `getWordAtPosition` + 全文匹配）；口上正文里"同一个词
 *   出现几百次"是常态，代价随文件长度线性涨；
 * - `links:false`——本 app 不给 ERB/`.kojo` 注册 documentLink provider，于是 Monaco 走
 *   **自动链词**那条兜底路（`linkComputer.ts`：无 provider ⇒ `computeAutolinkedWords`
 *   逐行扫全文找 URL 形态），每次内容变化重扫一遍；
 * - `colorDecorators:false`——颜色装饰器（`colorExtensionPoint` 那条）对**整篇**逐行找
 *   `#RRGGBB` 与颜色词，内容一变就重算；语料里的 `#DIM` / `#FUNCTION` 前缀正好是它的
 *   误命中形态，白扫一遍还什么都不给；
 * - `folding` 留到 huge 才关（见下）：段折叠是本产品读口上的主要导航手段，5k–50k 档
 *   一次 provider 调用实测远小于其余几条，不值这一刀。
 */
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
  // 缩略图留到 huge 才关：small 那一份本来就是廉价模式（不逐字符渲染、限 72 列），
  // 它是**导航面**而不是全文级开销——1020 之后这一刀已经落回"砍全文级、不砍导航"
  minimap: { enabled: true, renderCharacters: false, maxColumn: 72 },
  renderLineHighlight: 'line',
  // 失焦仍铺高亮是白烧一次整行重绘
  renderLineHighlightOnlyWhenFocus: true,
  // 贴顶同样是导航面：Monaco 的 sticky scroll 只按**可见区间**算行位置（不是全文级扫描），
  // 大档保留但少贴一行（4 → 3），把重排成本压到最低
  stickyScroll: { enabled: true, maxLineCount: 3 },
  // 平滑滚动每帧插值重排视口；光标动画是持续重绘源——大档起全停
  smoothScrolling: false,
  cursorBlinking: 'solid',
  cursorSmoothCaretAnimation: 'off',
  // 语料同质（tab），不值得为探测再扫一遍文件头
  detectIndentation: false,
  // 击键即格式化（F5）这一位**不在这里定**：ERB 的 on-type 腿早已被 PS-4 收成"只取触发
  // 行那一段窗口"（`editor-global-providers.ts` 的 `formatRequestWindowFor`），关掉的理由
  // 过期；而 `.kojo` 的缩进单位与 `@` 块状态是文档级判据，窗口视角会数错，仍要关。
  // 判据只有一份：{@link formatOnTypeForDocument}——接线层与档位表都问它，不许各抄阈值。
  formatOnType: false,
  // PS-5：三条全文级扫描关档（机理见文件头注），折叠与小档同开（读口上要靠它）
  selectionHighlight: false,
  links: false,
  colorDecorators: false,
  folding: true,
  // 折行到 huge 才关：这一档留着（台词长行 + 5k–50k 行的折行成本仍可接受）
  wordWrap: 'on',
};

/**
 * huge 档 = large 档再削掉一切视口级装饰。
 *
 * `wordWrap:'off'`（PS-5 新增，本档最关键的一刀）：折行开着时 Monaco 不能用
 * `SimpleLinesLayout`（等高 ⇒ 滚动位移与行号互为 O(1) 换算），只能维护
 * `LinesLayout` 那份**逐可视行高度前缀和**——行数越长数组越长，且每次内容变化 /
 * 视口宽度变化都要重排。这正是 VS Code 把 `largeFileOptimizations` 的适用条件写成
 * "for large files **without word wrap**" 的那个前提：折行一开，那批降级就失效。
 * 99 万行级盘上这一条决定"能不能滚动"，而关折行的代价只是长行要横向滚——
 * 到这一档的文件本来也不是拿来通读的。
 *
 * `folding:false`：折叠区间由 `ui.editor.languageService` 的 foldingRange 贡献方
 * **按整篇文本**算（ERB 那路 = parseErbText + scanControlFlow 两遍线性扫描），
 * 每次内容变化重算一遍；50k 行往上不值（要折叠看结构请降到大档或分段打开）。
 */
const TIER_HUGE: EditorOptionPatch = {
  ...TIER_LARGE,
  // 99 万行级盘：连视口级的括号配对查找也关（'never' 是 0.57 d.ts 合法值）
  matchBrackets: 'never',
  // 导航面到这一档才真的关：缩略图逐行算色块、贴顶每次滚动重排可见区，99 万行撑不起
  minimap: { enabled: false },
  stickyScroll: { enabled: false },
  guides: {
    bracketPairs: false,
    bracketPairsHorizontal: false,
    highlightActiveBracketPair: false,
    indentation: false,
    highlightActiveIndentation: false,
  },
  wordWrap: 'off',
  folding: false,
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
 * 排版偏好补丁（P2-16）：把 `layout-pref.ts` 那份偏好翻成 Monaco 选项，
 * **叠在档位表之后**（`editorOptionsForLineCount` 与 EditorPane 的 create options
 * 同调它——两条写选项的路径因此读同一份偏好）。
 *
 * - `wordWrap`：「跟随体量档」给档位表自己在 `lineCount` 上的值（create 路径没有档位表
 *   可 spread，靠这一格拿到 small 档的 `'on'` 初值；切文件路径上与档位表同值 =
 *   等价于不传 override）；「强制开 / 强制关」盖在档位表之后。
 * - `multiCursorModifier` / `columnSelection`：与体量无关，恒取偏好值。
 *
 * `pref` 形参可注入（缺省现读 localStorage）：node 单测用显式偏好钉死映射，不必装假
 * window；宿主两条路径都用缺省现读，保证「同一份偏好」不靠谁手抄。
 */
export function layoutPrefPatch(
  lineCount = 0,
  pref: LayoutPref = loadLayoutPref(),
): EditorOptionPatch {
  return {
    wordWrap:
      pref.wordWrap === 'tier'
        ? TIER_OPTIONS[editorProfileTierForLineCount(lineCount)].wordWrap
        : pref.wordWrap,
    multiCursorModifier: pref.multiCursorModifier,
    columnSelection: pref.columnSelection,
  };
}

/**
 * 与文件规模相称的 Monaco 选项（**纯函数**）= 中文基线 + find 基线 + 公共补丁 + 档位表全量
 * + 排版偏好叠层（P2-16，见 {@link layoutPrefPatch}：偏好永远叠在档位表之后）。
 */
export function editorOptionsForLineCount(lineCount: number): EditorOptionPatch {
  return {
    ...CJK_TYPING_BASELINE,
    ...FIND_BASELINE,
    ...COMMON_OPTIONS,
    ...TIER_OPTIONS[editorProfileTierForLineCount(lineCount)],
    ...layoutPrefPatch(lineCount),
  };
}

/**
 * 折叠这条能力在**当前档位**上开不开（读表，不另写阈值）。
 *
 * 存在的唯一理由：折叠区间由 `ui.editor.languageService` 的供给器给，而编辑器一旦注册了
 * 供给器，Monaco 就**不再退回缩进折叠**（取证 `contrib/folding/browser/folding.js:67`
 * `this._useFoldingProviders = options.get(EditorOption.foldingStrategy) !== 'indentation'`
 * 与 `getRangeProvider()` 里"有供给器 ⇒ rangeProvider = SyntaxRangeProvider"那一段）。
 * 于是"选项上 folding 还开着、供给器却不干活"= 折痕画在槽上、一处也折不动，且没有任何话。
 * 判据因此**必须只能有这一份**：选项与供给器各自读同一张表，谁都别自己抄数字。
 */
export function foldingEnabledForLineCount(lineCount: number): boolean {
  if (!Number.isFinite(lineCount)) return false;
  return TIER_OPTIONS[editorProfileTierForLineCount(lineCount)].folding !== false;
}

/**
 * 打字规范化（formatOnType）在**当前体量 + 当前方言**上开不开（读表，不另写阈值）。
 *
 * 档位表里 large/huge 写的是 `false`，那是 `.kojo` 那一条腿的值：ERB 的 on-type 供方早在
 * PS-4 就改成只取触发行那一段窗口（`editor-global-providers.ts` 的 `formatRequestWindowFor`
 * 对 ERB 走窗口、对 `.kojo` 交回 `null` 退整篇），"每敲一键整篇 getValue"这条关闭理由
 * 对 ERB 已不成立。而 `.kojo` 的缩进单位探测与 `@` 原生块状态是**文档级**判据，窗口视角
 * 会数错 ⇒ 大档继续关。
 *
 * Monaco 只在 `formatOnType` 为真时派发 on-type provider，这一位没有第二个写入点，
 * 所以判据**必须只有这一份**（与 {@link foldingEnabledForLineCount} 同一条纪律）：
 * 接线层问它，档位表也解释它，谁都不许自己抄 `LARGE_FILE_LINES`。
 */
export function formatOnTypeForDocument(lineCount: number, isErb: boolean): boolean {
  // 行数不可知 ⇒ 与 {@link foldingEnabledForLineCount} 同一条纪律：不办这件"每击键一次"的事
  if (!Number.isFinite(lineCount)) return false;
  if (editorProfileTierForLineCount(lineCount) === 'small') return true;
  return isErb;
}

/** 档位表里所有档（不含 small）写过的键，升序去重 */
function tierKeysAboveSmall(): string[] {
  const keys = new Set<string>();
  for (const tier of ['large', 'huge'] as const) {
    for (const key of Object.keys(TIER_OPTIONS[tier])) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * 体量轴上被**任何一档**写过的那批键（测试与审计从这里枚举，不抄清单）。
 * 含 small 独有的键 ⇒ "每条体量轴都要有值"这类断言拿它当全集。
 */
export function sizeTierKeys(): string[] {
  const keys = new Set<string>(Object.keys(TIER_SMALL));
  for (const key of tierKeysAboveSmall()) keys.add(key);
  return [...keys].sort();
}

/**
 * **必须恒为空表**的一条判据：任一档关掉、但 small 档没写回的键。
 *
 * 非空即"从大文件切回来那条卡在关值"（档位漂移）。写成函数而不是把清单抄进测试，
 * 是为了让"往大档加一条关值、忘了在小档写回"这种改动**自己**把测试弄红——
 * `formatOnType` 那一条正是被手抄的五项清单放过来的（PS-5 的测试枚举了五条、表上有六条）。
 */
export function sizeTierKeysMissingFromSmall(): string[] {
  return tierKeysAboveSmall().filter((key) => !(key in TIER_SMALL));
}

/** {@link applySizeTier} 需要的最小编辑器面（结构化：宿主传真编辑器，单测传假对象） */
export interface SizeTierTarget {
  updateOptions(options: EditorOptionPatch): void;
}

/**
 * 体量档位落到编辑器上的**唯一出口**：屏幕上此刻挂的是哪份文档，就按**那份文档的行数**落档，
 * 再叠调用方那层与体量无关的补丁（可写态 / 快建议——两轴正交，但一次 `updateOptions` 发完，
 * 切标签是热路径，发两遍就是让 Monaco 重算两遍配置）。
 *
 * 三个写入点全走这里，一个都不许自己 spread 档位表：
 * ① 切标签（按**原文** model 的行数）；② 挂上 `.kojo` 预览（按**投影**的行数——投影比原文长，
 * 这一档该更保守）；③ 撤下预览（按**回到屏幕上的那份原文**的行数）。
 * ③ 是 1020 止血批补上的：预览那档的关值（折行 / 折叠 / 找同词 / 打字规范化）以前不会
 * 被还原，一份几万行投影能把它们一路带到下一份小文件上。
 *
 * P2-16 起这一层还自动带上排版偏好（{@link layoutPrefPatch} 叠在档位表之后）：三个
 * 写入点一个都不必单独读偏好——它们走的 `editorOptionsForLineCount` 已经读了。于是
 * 「切回小文件不卡在 huge 档的关值」对偏好层同样成立：跟随档时按**回到屏幕上的那份
 * 文档**重取档位值，不会卡在上一手的强制值上。
 */
export function applySizeTier(
  ed: SizeTierTarget,
  lineCount: number,
  overrides?: EditorOptionPatch,
): void {
  ed.updateOptions({ ...editorOptionsForLineCount(lineCount), ...(overrides ?? {}) });
}
