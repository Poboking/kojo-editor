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
 * `editor.updateOptions(...)`，切回小文件即恢复（补丁按差集发：同档零发、跨档只发变动键——
 * 口径与读数见 {@link applySizeTier}）。
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
 *
 * **查找词优先叠层（FIND-STATE-PERSIST-B，1021）**：同一形态照搬一遍——三档偏好
 * （`find-pref.ts`，默认 'selection'）由 {@link findPrefPatch} 翻成 `find.seedSearchStringFromSelection`，
 * 叠在档位表之后、恒带整组 find 字段；`FIND_BASELINE` 那格 'always' 退为"偏好层缺席时的
 * 兜底"，档位表与偏好互不读写对方的真源。
 */
import type * as Monaco from '../monaco/entry';
import { CJK_AMBIGUOUS_WHITELIST, CJK_WORD_SEPARATORS } from '../monaco/word-separators';
import { loadLayoutPref, type LayoutPref } from './layout-pref';
import { loadFindSeedPref, type FindSeedPref } from './find-pref';

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
 * 幽灵文本（内联补全，IC 批 A 车道）的 Monaco 选项补丁。
 *
 * ## 为什么这一格必须是**选项**而不是"provider 里返回空"
 *
 * `editor.inlineSuggest.enabled` 此前**全仓从没被设过**（vendor `InlineEditorSuggest`
 * 缺省 `enabled: true` / `minShowDelay: 0`；取证 `grep -rn "inlineSuggest" packages/app/src`
 * 改前只命中 `entry.ts` 那两条 import）。选项为关时 Monaco **一次都不问** provider，
 * 于是"关掉 = 与接线前逐字节一致"这条判据有机制保证，而不是靠供方自觉。
 * provider 侧另有第二道同名闸（`inline-completion-host.ts` 的 `pref-disabled`）：
 * 第二道**不是重复判据**，它挡的是"选项还没落到位"那一拍（实例创建 / 切标签的时序），
 * 真源仍是 `inline-completion-pref.ts` 那一份 localStorage。
 *
 * ## 为什么补丁只带两位
 *
 * `inlineSuggest` 是**组合选项**，vendor 的 `applyUpdate` 按键深合并到既有值上——只写
 * `enabled` / `minShowDelay` 不会把同组其余位（`mode` / `showToolbar` / `suppressSuggestions`
 * …）顶成缺省值。反过来说：**不许**在这里整张重抄 `inlineSuggest` 的值，那是第二份缺省表。
 *
 * `minShowDelay` 就是作者那格「停顿多久才弹」（真源与夹取在 pref 模块；vendor 区间 0–10000，
 * 作者区间收窄到 0–1000 与「补全弹出延迟」同一把尺）。
 */
export function inlineSuggestPatch(enabled: boolean, minShowDelay: number): EditorOptionPatch {
  return { inlineSuggest: { enabled, minShowDelay } };
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

/**
 * 一次交回的折叠区间**条数**上限（**宿主与 Monaco 同一份**：这枚数字同时进
 * `foldingMaximumRegions`，见 `COMMON_OPTIONS`）。
 *
 * ## 为什么从 5,000 抬到 20,000（2026-10-28）
 *
 * 5,000 是照 Monaco 的缺省 `foldingMaximumRegions`（5000）抄的，抄的时候没有真语料读数。
 * 实测（`erbFoldingRanges`，真语料整篇）：
 *
 * | 文件 | 行数 | 折叠区间 |
 * |---|---|---|
 * | `M_KOJO_K139_日常系コマンド.ERB` | 24,197 | **8,066** |
 * | `M_KOJO_K42_日常系コマンド.ERB` | 23,171 | 6,073 |
 * | `NewNameGenerator.ERB` | 169,247 | 139 |
 *
 * ⇒ 5,000 在 2.3 万行这一档上已经**真的在砍**（砍掉约 3,000 处，界面那条"只折前 5000 处"
 * 说的就是这件事），而 5,000–20,000 行正是语料的主体重心。20,000 是最大观测值的 2.5 倍，
 * 内存代价仍可忽略（每条 3 枚定长数组 ≈ 12 字节 ⇒ 满额约 240 KB）；超过仍有可见提示。
 */
export const FOLDING_MAX_RANGES = 20_000;

/** 与体量无关的公共补丁（各档共用，不进档位表） */
const COMMON_OPTIONS: EditorOptionPatch = {
  // Monaco 自己的折叠条数上限：**与本仓 `FOLDING_MAX_RANGES` 同源**（否则宿主不砍、它照砍，
  // 而且是静默砍——它的 `RangesLimitReporter` 在这套 standalone 里没人接）
  foldingMaximumRegions: FOLDING_MAX_RANGES,
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
  // 书签的 **glyph margin 槽位**（VIS-62，1026 编辑器体感 E1）：monaco-editor 这一档的缺省
  // 是 `false`（`monaco.d.ts:3580`「Defaults to true in vscode and to false in monaco-editor」），
  // 而 C 批的装饰层只写了 `glyphMarginClassName` / `glyphMarginHoverMessage`
  // （`editor-pane/use-bookmarks.ts:46-47`）——全仓**没有任何一处**开过 `glyphMargin`（取证
  // `grep -rn "glyphMargin" packages/app/src` 只有那两行）⇒ 角标与那句 hover 文案从未画过，
  // `bookmark-gutter.css` 的 `.kojo-bookmark-glyph` 一支是死样式。
  //
  // **三档同值 = 开**，判据与 `folding` / `minimap` 走的是同一条口径：这一格是**视口级**渲染
  // （`viewParts/glyphMargin` 只为可见行铺装饰，代价随视口行数，不随文档长度），书签集合本身
  // 稀疏（装饰层按行号造 Range，没有全文扫描）⇒ 它不属于"随文件长度增长"那一族，大档没有
  // 理由砍它；而它是作者亲手钉的**导航面**，5,000 行以上悄悄消失就是铁律 4 的静默削功能。
  // "开档 ⇒ 样式表真有消费方"这一条由 `tests/editor-glyph-slot.test.ts` 钉住，防它再变死样式。
  glyphMargin: true,
  renderLineHighlight: 'all',
  renderLineHighlightOnlyWhenFocus: false,
  // 粘性滚动（B3）：贴顶行给的就是大纲项（当前函数 / 当前时机块）
  stickyScroll: { enabled: true, maxLineCount: 4 },
  smoothScrolling: true,
  // 光标呼吸（C3）：`blink` 是硬切闪（亮→灭一瞬间），在深底上看久了刺眼；`smooth` 是淡入淡出。
  // 大档仍 `solid`（持续重绘源，见 TIER_LARGE）——这一条是"小档专属的舒适度"，不是全局默认。
  cursorBlinking: 'smooth',
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
 * - `folding` 两档都保留：段折叠是本产品读口上的主要导航手段，供给方按内容版本
 *   记忆化（每次编辑一次，不是每帧），不值这一刀。
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
  // 折行两档同值：跟随档时按用户偏好（缺省开），档位表不在这里替作者做决定
  wordWrap: 'on',
  // 书签槽位同理**逐档同值**：机理与判据见 `TIER_SMALL` 那一格（视口级渲染 + 稀疏装饰，
  // 不在"随文件长度增长"那一族里）。huge 档 spread 这一行 ⇒ 三档全开，大文件里作者的
  // 书签不会因为体量档而消失。
  glyphMargin: true,
};

/**
 * huge 档 = large 档再削掉视口级装饰（**只削视口级，不再碰导航面与折行偏好**）。
 *
 * 2026-10-23 重估（批次十 S6）：`stickyScroll` 只按**可见区间**算贴顶行，`wordWrap`
 * 是**用户偏好**（`layout-pref.ts` 三选一），档位表不该替作者强制关掉；这两条从 huge
 * 的差异集里撤掉（继承 {@link TIER_LARGE}），强制开关仍由偏好叠层盖在这张表之上。
 *
 * 但 `folding` 仍关：PS-4 的 52,601 行读数显示，折叠一开就多一次**整篇 copy**
 * （`ps4-provider-seams.perf.test.ts`：全文 copy 9 → 10），与「档位判在取文之前」的
 * 不变量冲突；折叠范围供给方的记忆化省的是重复扫描，不是首次取文。有新的实测读数前
 * 不开回来。
 *
 * 这一档仍然关的只有**视口级装饰 + 折叠**：缩略图（逐行算色块）、括号配对查找与整表
 * 引导线在 99 万行级盘上没有信息价值，留着只是白烧重绘。
 */
const TIER_HUGE: EditorOptionPatch = {
  ...TIER_LARGE,
  // 99 万行级盘：连视口级的括号配对查找也关（'never' 是 0.57 d.ts 合法值）
  matchBrackets: 'never',
  // 导航面到这一档才真的关：缩略图逐行算色块，99 万行撑不起
  minimap: { enabled: false },
  guides: {
    bracketPairs: false,
    bracketPairsHorizontal: false,
    highlightActiveBracketPair: false,
    indentation: false,
    highlightActiveIndentation: false,
  },
  // PS-4 实测：折叠一开就多一次整篇 copy（9 → 10），与「判档在取文之前」冲突
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
 * 这里显式钉住防档位漂移。FIND-STATE-PERSIST-B 起这一格是**偏好层缺席时的兜底**：
 * 作者实际用哪一档由 {@link findPrefPatch} 叠在这之后决定（真源在 `find-pref.ts`，
 * 档位表本身不读 localStorage——两份真相各管各的轴，P2-16 同一条纪律）。
 */
export const FIND_BASELINE: EditorOptionPatch = {
  find: {
    seedSearchStringFromSelection: 'always',
    loop: true,
  },
};

/**
 * 查找词优先补丁（FIND-STATE-PERSIST-B）：把 `find-pref.ts` 的三档偏好翻成 Monaco 的
 * `find.seedSearchStringFromSelection`，**叠在档位表之后**（create options、`applySizeTier`
 * 的三个写入点与偏好订阅回调三条路同调它——写选项的路径因此读同一份偏好）。
 *
 * **恒带整组 find 字段**（spread `FIND_BASELINE.find` 再改一位）：monaco 的 `find` 是一枚
 * 对象选项，`updateOptions({ find: { …部分字段 } })` 时 `EditorFind.validate` 对缺的字段
 * 逐位回落**内建缺省**而非上一拍的值——将来谁往基线加了非缺省值（如 `loop:false`），
 * 只发一字的补丁就会把它打回默认。带着全量发就没这条缝（实测前后快照对照见
 * `tests/find-pref.test.ts` 第 ④ 组，用例钉「其余 find 字段零变化」）。
 */
export function findPrefPatch(pref: FindSeedPref = loadFindSeedPref()): EditorOptionPatch {
  return {
    find: {
      ...FIND_BASELINE.find,
      seedSearchStringFromSelection: pref,
    },
  };
}

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
 * + 排版偏好叠层（P2-16，见 {@link layoutPrefPatch}）+ 查找词优先叠层
 * （FIND-STATE-PERSIST-B，见 {@link findPrefPatch}：偏好永远叠在档位表之后）。
 */
export function editorOptionsForLineCount(lineCount: number): EditorOptionPatch {
  return {
    ...CJK_TYPING_BASELINE,
    ...FIND_BASELINE,
    ...COMMON_OPTIONS,
    ...TIER_OPTIONS[editorProfileTierForLineCount(lineCount)],
    ...layoutPrefPatch(lineCount),
    ...findPrefPatch(),
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
 * 落档时**留到下一帧**再写的键（两类，都是"首帧不需要、且换档时白烧一次"的）：
 *
 * ① `detectIndentation`——**模型级**判据。Monaco 收到它会给活着的 model 重扫缓冲区
 *    （`TextModel.detectIndentation` → `guessIndentation`），翻回 false 那侧则改
 *    `tabSize/insertSpaces`，折行开着 ⇒ 整篇重排。实测 4,800–6,000 行文件上这一格
 *    值 5–17ms（1025 切文件批读数，波动随机器）。它只影响 Tab / 回车行为。
 * ② 四个**纯视觉节奏**键：光标闪烁 / 光标平滑动画 / 平滑滚动 / 整行高亮（含"仅聚焦时"）。
 *    它们没有任何文档级建立成本（viewport 级，改一次 ≈ 1ms），但换档时必变，四条叠起来
 *    仍在同步段里占 3–6ms；晚一帧只是"光标从闪烁切到常亮"这种看不出来的差别。
 *
 * 反过来，**门禁类**的键一个都不许延后：`bracketPairColorization` / `occurrencesHighlight` /
 * `selectionHighlight` / `links` / `colorDecorators` / `minimap` / `folding` / `matchBrackets`
 * —— 它们必须在 model 挂上去之前就是对的，否则新 model 会先按旧档建一遍全文结构再被拆掉
 * （对 99 万行档是灾难，且这正是"档位闸"本身要拦的开销）。
 */
const DEFERRED_TIER_KEYS: ReadonlySet<string> = new Set([
  'detectIndentation',
  'cursorBlinking',
  'cursorSmoothCaretAnimation',
  'smoothScrolling',
  'renderLineHighlight',
  'renderLineHighlightOnlyWhenFocus',
]);

/** 一次落档的记忆：上一次发出去的**完整**补丁 + 可能还排着队的延后键 */
interface TierApplyMemory {
  patch: EditorOptionPatch;
  deferred: { patch: Record<string, unknown>; cancel: () => void; apply: () => void } | null;
}

/**
 * 每枚编辑器实例各记一份（`WeakMap`：编辑器销毁即随 GC 走，不用手工清）。
 *
 * 为什么记在实例上而不是模块级单变量：分屏多组各有自己的编辑器，共用一份记忆会让
 * 两组的档位互相"以为已落过"（B 组切大文件时 A 组那格仍是小档值，差集就漏发）。
 */
const tierApplyMemory = new WeakMap<SizeTierTarget, TierApplyMemory>();

/** 顶层选项值相等判定（对象值逐字段递归：本表的对象选项都是扁平小对象，比一遍 < 0.02ms） */
function optionValueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  if (keys.length !== Object.keys(rb).length) return false;
  for (const k of keys) if (!optionValueEquals(ra[k], rb[k])) return false;
  return true;
}

/**
 * 把延后那一拍排到**下一个宏任务**（`setTimeout 0`），而不是 `requestAnimationFrame`。
 *
 * 差别在实测里是可见的：切文件那一帧里 Monaco 自己已经用 rAF 排了"新 model 的首次渲染"
 * （6,000 行文件实测 35–45ms），再挤进我们这一发就等于把它们并进**同一个长任务**；
 * 用宏任务就把这 3–6ms 挪到独立的一小段里，长任务只剩渲染那一条。
 *
 * 视觉上无差：宏任务与 rAF 都在下一次绘制之前跑完，用户看到的第一帧已是终态。
 * node 单测同样落到这条路径（`flushDeferredTierOptions` 可同步收口）。
 */
function scheduleAfterTask(run: () => void): () => void {
  const timer = setTimeout(run, 0);
  return () => clearTimeout(timer);
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
 *
 * ## 1025 切文件批：**只发与上一次不同的键**（同档切换 = 一次 `updateOptions` 都不发）
 *
 * 改前每次切标签都把 24 个顶层键（连嵌套 ≈117 个）整份重发。实测同实例连发同一份补丁
 * 只要 0.9ms，但**跨档**那一发要 17–34ms（Monaco 逐键比对后触发各自的重算：缩略图重建、
 * 整篇重排、模型重探测），而其中大头 `detectIndentation` 是**模型级**扫描，见
 * {@link DEFERRED_TIER_KEYS}。
 *
 * 记忆体 {@link tierApplyMemory} 记"上次发给这枚编辑器的完整补丁"，本函数发**差集**：
 * - 同档同值（小文件↔小文件、同一份文件重落档）⇒ 零 `updateOptions`；
 * - 跨档 ⇒ 只发真正变化的十几条键，外加"上一拍还排着队的延后键"的目标值变了就作废旧拍。
 *
 * 合法性的根据是**唯一出口**：{@link applySizeTier} 是档位写入的唯一出口（既有静态用例钉着
 * 三个写入点），而别的写入者（只读态 / 偏好订阅 / 字号）写的键要么不在本表里、要么读的是
 * 同一份偏好真源 ⇒ 差集的"上一手值"不会与屏上实况打架。
 */
export function applySizeTier(
  ed: SizeTierTarget,
  lineCount: number,
  overrides?: EditorOptionPatch,
): void {
  const desired: Record<string, unknown> = { ...editorOptionsForLineCount(lineCount), ...(overrides ?? {}) };
  const mem = tierApplyMemory.get(ed);
  // 上一拍排进下一帧的键：本次目标都没变 ⇒ 让它照原样落地（不必重发）；有一个变了 ⇒ 作废旧的那一拍，
  // 否则旧档的值会在新档落定之后偷偷盖回来（延后执行的唯一一条硬边）。
  if (mem?.deferred) {
    const stale = Object.keys(mem.deferred.patch).some((key) => !optionValueEquals(mem.deferred!.patch[key], desired[key]));
    if (stale) {
      mem.deferred.cancel();
      mem.deferred = null;
    }
  }
  const next: TierApplyMemory = mem ?? { patch: {}, deferred: null };
  const before = next.patch as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(desired)) {
    if (Object.prototype.hasOwnProperty.call(before, key) && optionValueEquals(before[key], desired[key])) continue;
    patch[key] = desired[key];
  }
  // 记忆体记"完整目标"（含刚排进下一帧的那一格）：它回答的是「这个实例最终应当是什么」，
  // 不是「此刻已经写进去的是什么」——延后键由 `deferred.cancel/apply` 那一对负责收口。
  next.patch = desired as EditorOptionPatch;
  tierApplyMemory.set(ed, next);

  const deferredPatch: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if (!DEFERRED_TIER_KEYS.has(key)) continue;
    deferredPatch[key] = patch[key];
    delete patch[key];
  }
  if (Object.keys(patch).length > 0) ed.updateOptions(patch as EditorOptionPatch);
  if (Object.keys(deferredPatch).length > 0) {
    if (next.deferred) next.deferred.cancel();
    const apply = (): void => {
      try {
        ed.updateOptions(deferredPatch as EditorOptionPatch);
      } catch {
        // 编辑器已销毁（关标签 / 换组）：这一拍作废，不做静默之外的补救——档位随实例一起没了
      }
    };
    const entry: TierApplyMemory['deferred'] = { patch: deferredPatch, cancel: () => {}, apply };
    entry.cancel = scheduleAfterTask(() => {
      if (next.deferred === entry) next.deferred = null;
      apply();
    });
    next.deferred = entry;
  }
}

/**
 * 立刻落地本实例排进下一帧的模型级键（见 {@link DEFERRED_TIER_KEYS}）。
 *
 * 两个用途：① 单测要在同步断言里对账"最终选项"，不能等定时器；② 将来若有人在销毁编辑器
 * 之前想按最终态收口（当前宿主不需要：实例没了，选项也没了）。幂等：没排队就什么都不做。
 */
export function flushDeferredTierOptions(ed: SizeTierTarget): void {
  const mem = tierApplyMemory.get(ed);
  const pending = mem?.deferred;
  if (!mem || !pending) return;
  pending.cancel();
  mem.deferred = null;
  pending.apply();
}
