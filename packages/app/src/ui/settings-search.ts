/**
 * 设置页搜索与「已修改」过滤（1020 编辑器体感批，用户反馈项 10；批次十一 L09 扩成全量登记）。
 *
 * 零 React 纯逻辑：一张条目索引 + 一个匹配函数。为什么要索引而不"扫 DOM 里的文字"：
 * 设置页的每一行是一段 JSX（值与回调都闭包在 props 上），运行时去读渲染出来的文本，
 * 得到的是"看起来像什么"而不是"这一项是什么"——点击结果要跳到哪一节、哪一行，
 * 必须由这份数据说了算，否则搜索结果会指向一个并不存在的位置。
 *
 * 三条口径：
 * - `key`：给了 ⇒ 该项在页面上有 `[data-settings-key]` 锚点，点结果能滚到那一行并闪一下；
 *   没给 ⇒ 只跳到对应节（一节恒有内容，绝不出现"点了没反应"，铁律 4）。
 *   控件行一律登记 key，且**登记了就必须真有一枚锚点**——写了 key 而页面上找不到那一行、
 *   或条目指向不存在的节，由 `tests/settings-search.test.ts` 当场钉红。
 *   整页级的条目（快捷键页）例外地不给 key：那一节的"行"就是整页，键位行另有 `[data-kb-id]`。
 * - `isModified` 可选：**只有拿得到真源读数的条目才写它**。「已修改」过滤是一条判据，
 *   猜出来的已修改比没有已修改过滤更坏（作者会据此去翻一处其实没动过的设置）。
 * - `label` 与页面上那行的文案**逐字一致**（搜到就认得出）。
 */
import { overrideCount } from './keybindings';
import { loadLayoutPref, LAYOUT_PREF_DEFAULT } from './layout-pref';
import {
  modifiedEditorDisplayKeys,
  type EditorDisplayPrefs,
} from './editor-display-prefs';
import {
  FONT_SIZE_DEFAULT,
  FONT_ZOOM_DEFAULT,
  loadFontSizePref,
  loadFontZoomPref,
} from './font-size-pref';
import {
  QUICK_SUGGESTIONS_DEFAULT,
  SUGGEST_DELAY_DEFAULT,
  WORD_BASED_SUGGESTIONS_DEFAULT,
  loadQuickSuggestionsPref,
  loadSuggestDelayPref,
  loadWordBasedSuggestionsPref,
} from './suggest-pref';
import { CODE_LENS_DEFAULT, loadCodeLensPref } from './code-lens-pref';
import { TREE_SITTER_DEFAULT, loadTreeSitterPref } from './tree-sitter-pref';
import { FIND_SEED_DEFAULT, loadFindSeedPref } from './find-pref';
import { AUTOSAVE_MODE_DEFAULT, loadAutosavePref } from './autosave-pref';
import { NAME_COLOR_DEFAULT, loadNameColorPref } from './semantic-color-pref';
import { DIRECT_MODE_DEFAULT, loadDirectMode } from './direct-mode';
import { loadThemeChoice } from './theme-pref';
import { MOTION_PREF_DEFAULT, loadMotionPref } from './motion-pref';
import { GLASS_TRANSPARENCY_DEFAULT, loadGlassTransparencyPref } from './glass-pref';
import { PANEL_VIRTUALIZE_DEFAULT, loadPanelVirtualize } from './panel-prefs';
import { loadFormatRulesPref, FORMAT_RULES_DEFAULT } from './format-pref';
import type { SettingsSectionId } from './SettingsPanel';

export interface SettingsSearchEntry {
  /** 稳定 id（React key 与"当前选中结果"的判据；不进任何持久化） */
  readonly id: string;
  readonly section: SettingsSectionId;
  /** 节名（结果行右侧的分组读数，与左导航逐字同词） */
  readonly sectionLabel: string;
  /** 作者面叫法（搜索结果的主行；必须与页面上那行的文案逐字一致） */
  readonly label: string;
  /** 参与匹配的额外词（英文术语、别名、快捷键名等；不显示） */
  readonly keywords?: readonly string[];
  /** 有 ⇒ 页面上存在 `[data-settings-key=这一串]` 的锚点，可精确滚动定位 */
  readonly key?: string;
  /** 该项当前是否偏离默认（「已修改」过滤与计数只用它；拿不到真源的条目一律不写） */
  readonly isModified?: () => boolean;
}

/** 编辑器显示偏好的某一键是否已偏离缺省 */
function displayKeyModified(k: keyof EditorDisplayPrefs): () => boolean {
  return () => modifiedEditorDisplayKeys().includes(k);
}

/** 编程字体一行有两个真源（档位 + 旧自定义文本），「已修改」任一站起即算 */
const codeFontChanged = (): boolean => {
  const m = modifiedEditorDisplayKeys();
  return m.includes('fontFamily') || m.includes('codeFontPreset');
};

/** 界面字体一行同理（档位 + 自定义栈） */
const uiFontChanged = (): boolean => {
  const m = modifiedEditorDisplayKeys();
  return m.includes('uiFontPreset') || m.includes('uiFontFamily');
};

const wordWrapChanged = (): boolean =>
  loadLayoutPref().wordWrap !== LAYOUT_PREF_DEFAULT.wordWrap;
const multiCursorChanged = (): boolean =>
  loadLayoutPref().multiCursorModifier !== LAYOUT_PREF_DEFAULT.multiCursorModifier;
const columnSelectionChanged = (): boolean =>
  loadLayoutPref().columnSelection !== LAYOUT_PREF_DEFAULT.columnSelection;

const formatFullWidthChanged = (): boolean =>
  loadFormatRulesPref().fullWidthSpace !== FORMAT_RULES_DEFAULT.fullWidthSpace;
const formatIndentChanged = (): boolean =>
  loadFormatRulesPref().indent !== FORMAT_RULES_DEFAULT.indent;

/**
 * 条目索引（顺序 = 无查询时「已修改」列表的展示序，按节分组、节内按**页面行序**）。
 *
 * "节内按页面行序"是这条顺序的唯一尺：同一条判据既决定搜索结果的排列，也决定徽标点开
 * 的那张清单，所以页面上两行谁在上、索引里就谁在前（改页面行序 ⇒ 这里跟着挪，
 * 否则「已修改」清单会和页面反着排，读者以为某一页跳过了改动）。
 *
 * 覆盖面是**全量**：页面上每一行控件都要在这里有一条条目、有一个锚点 key——
 * "索引登记了 key 而页面上没那枚 `data-settings-key`"（点了指不到那一行）与
 * "条目指向不存在的节"由 `tests/settings-search.test.ts` 当场钉红。新增一行设置 =
 * 页面加 `data-settings-key` + 这里加一条同 key 条目，两步缺一即红。
 */
export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  // ---- 编辑器（条目顺序 = 设置页这一节从上到下的**实际行序**；「已修改」列表照它展示）----
  // 字号与缩放（SettingsPanel 的「正文字号」行 + 「文字缩放」行）
  { id: 'editor.fontSize', section: 'editor', sectionLabel: '编辑器', label: '正文字号', keywords: ['字号 font size'], key: 'editor.fontSize', isModified: () => loadFontSizePref() !== FONT_SIZE_DEFAULT },
  { id: 'editor.fontZoom', section: 'editor', sectionLabel: '编辑器', label: '文字缩放', keywords: ['zoom 放大 缩小 ctrl+='], key: 'editor.fontZoom', isModified: () => loadFontZoomPref() !== FONT_ZOOM_DEFAULT },
  // 补全与提示（弹出总开关 → 文档词 → 延迟 → 行内提示在下面的显示偏好带）
  { id: 'editor.quickSuggestions', section: 'editor', sectionLabel: '编辑器', label: '输入时自动弹出补全', keywords: ['quick suggestions 补全 候选'], key: 'editor.quickSuggestions', isModified: () => loadQuickSuggestionsPref() !== QUICK_SUGGESTIONS_DEFAULT },
  { id: 'editor.wordSuggestions', section: 'editor', sectionLabel: '编辑器', label: '文档词补全', keywords: ['word based 补全'], key: 'editor.wordSuggestions', isModified: () => loadWordBasedSuggestionsPref() !== WORD_BASED_SUGGESTIONS_DEFAULT },
  { id: 'editor.suggestDelay', section: 'editor', sectionLabel: '编辑器', label: '补全弹出延迟', keywords: ['delay 延迟 立即'], key: 'editor.suggestDelay', isModified: () => loadSuggestDelayPref() !== SUGGEST_DELAY_DEFAULT },
  // .kojo 预览与整理（预览总闸 → 保存时整理 → 两条整理规则 → 行内标注）
  { id: 'editor.sugarView', section: 'editor', sectionLabel: '编辑器', label: '.kojo 预览', keywords: ['糖 中文表层 ctrl+alt+t'], key: 'editor.sugarView' },
  { id: 'editor.formatOnSave', section: 'editor', sectionLabel: '编辑器', label: '保存时整理空白', keywords: ['格式化 format on save'], key: 'editor.formatOnSave' },
  { id: 'editor.formatRuleFullWidth', section: 'editor', sectionLabel: '编辑器', label: '折算全角空格', keywords: ['全角 半角 整理规则'], key: 'editor.formatRuleFullWidth', isModified: formatFullWidthChanged },
  { id: 'editor.formatRuleIndent', section: 'editor', sectionLabel: '编辑器', label: '统一 .kojo 缩进写法', keywords: ['缩进 整理规则 tab'], key: 'editor.formatRuleIndent', isModified: formatIndentChanged },
  { id: 'editor.codeLens', section: 'editor', sectionLabel: '编辑器', label: '标注函数被谁调用', keywords: ['code lens 引用 被用到'], key: 'editor.codeLens', isModified: () => loadCodeLensPref() !== CODE_LENS_DEFAULT },
  // 着色与解析 / 落盘
  { id: 'editor.nameColor', section: 'editor', sectionLabel: '编辑器', label: '定义与调用的名字分色', keywords: ['语义着色 color 名字'], key: 'editor.nameColor', isModified: () => loadNameColorPref() !== NAME_COLOR_DEFAULT },
  { id: 'editor.treeSitter', section: 'editor', sectionLabel: '编辑器', label: '结构解析器辅助（实验）', keywords: ['tree sitter 结构 折叠'], key: 'editor.treeSitter', isModified: () => loadTreeSitterPref() !== TREE_SITTER_DEFAULT },
  { id: 'editor.autosave', section: 'editor', sectionLabel: '编辑器', label: '自动保存', keywords: ['autosave 落盘'], key: 'editor.autosave', isModified: () => loadAutosavePref() !== AUTOSAVE_MODE_DEFAULT },
  // 排版四行（LayoutPrefRows 三行 + FindPrefRow 一行）
  { id: 'editor.wordWrap', section: 'editor', sectionLabel: '编辑器', label: '折行', keywords: ['word wrap 换行 滚动'], key: 'editor.wordWrap', isModified: wordWrapChanged },
  { id: 'editor.multiCursor', section: 'editor', sectionLabel: '编辑器', label: '多光标修饰键', keywords: ['multi cursor alt ctrl 多个光标'], key: 'editor.multiCursor', isModified: multiCursorChanged },
  { id: 'editor.columnSelection', section: 'editor', sectionLabel: '编辑器', label: '列选择', keywords: ['column selection 方块'], key: 'editor.columnSelection', isModified: columnSelectionChanged },
  { id: 'editor.findSeed', section: 'editor', sectionLabel: '编辑器', label: '查找词优先', keywords: ['find 查找 选中'], key: 'editor.findSeed', isModified: () => loadFindSeedPref() !== FIND_SEED_DEFAULT },
  // 显示偏好八行（EditorDisplayRows 的行序，逐行照页面）
  { id: 'editor.uiFontScale', section: 'editor', sectionLabel: '编辑器', label: '界面字号', keywords: ['ui scale 标签页 侧栏'], key: 'editor.uiFontScale', isModified: displayKeyModified('uiFontScale') },
  { id: 'editor.lineHeight', section: 'editor', sectionLabel: '编辑器', label: '行高', keywords: ['line height 行距'], key: 'editor.lineHeight', isModified: displayKeyModified('lineHeight') },
  { id: 'editor.renderWhitespace', section: 'editor', sectionLabel: '编辑器', label: '空白符显示', keywords: ['空格 tab whitespace'], key: 'editor.renderWhitespace', isModified: displayKeyModified('renderWhitespace') },
  { id: 'editor.lineNumbers', section: 'editor', sectionLabel: '编辑器', label: '行号', keywords: ['line numbers 相对行号'], key: 'editor.lineNumbers', isModified: displayKeyModified('lineNumbers') },
  { id: 'editor.minimap', section: 'editor', sectionLabel: '编辑器', label: '缩略图', keywords: ['小地图 minimap 右侧概览'], key: 'editor.minimap', isModified: displayKeyModified('minimap') },
  { id: 'editor.inlayHints', section: 'editor', sectionLabel: '编辑器', label: '行内提示', keywords: ['inlay hints 形参名 内联'], key: 'editor.inlayHints', isModified: displayKeyModified('inlayHints') },
  { id: 'editor.fontFamily', section: 'editor', sectionLabel: '编辑器', label: '编程字体', keywords: ['font family 字体族 cascadia consolas 档位'], key: 'editor.fontFamily', isModified: codeFontChanged },
  // Kojo 2.0 档位（整块在 Kojo2CutoverSettings 里，档位与破例清单各有自己的行）/ 直连
  { id: 'editor.kojo2Stage', section: 'editor', sectionLabel: '编辑器', label: 'Kojo 2.0 档位', keywords: ['kojo2 2.0 破例 恢复出厂 切换'] },
  { id: 'editor.directMode', section: 'editor', sectionLabel: '编辑器', label: '直连模式（就地编辑游戏目录）', keywords: ['direct mode 游戏目录 写权限'], key: 'editor.directMode', isModified: () => loadDirectMode() !== DIRECT_MODE_DEFAULT },

  // ---- 外观 ----
  { id: 'appearance.theme', section: 'appearance', sectionLabel: '外观', label: '主题', keywords: ['theme 配色 深色 浅色 薄荷'], key: 'appearance.theme', isModified: () => {
    const c = loadThemeChoice();
    return c === 'light' || c === 'mint-dark';
  } },
  { id: 'appearance.followSystem', section: 'appearance', sectionLabel: '外观', label: '跟随系统', keywords: ['system 深浅 auto'], key: 'appearance.followSystem', isModified: () => loadThemeChoice() === 'system' },
  { id: 'appearance.motion', section: 'appearance', sectionLabel: '外观', label: '减弱动效', keywords: ['motion 动画 reduced'], key: 'appearance.motion', isModified: () => loadMotionPref() !== MOTION_PREF_DEFAULT },
  { id: 'appearance.panelVirtualize', section: 'appearance', sectionLabel: '外观', label: '长列表视口化', keywords: ['虚拟滚动 面板'], key: 'appearance.panelVirtualize', isModified: () => loadPanelVirtualize() !== PANEL_VIRTUALIZE_DEFAULT },
  { id: 'appearance.glass', section: 'appearance', sectionLabel: '外观', label: '毛玻璃透明度', keywords: ['glass 磨砂'], key: 'appearance.glass', isModified: () => loadGlassTransparencyPref() !== GLASS_TRANSPARENCY_DEFAULT },
  // 界面字体（L20）：档位表在 `font-presets.ts`；这一行的"已修改"= 档位或自定义栈任一站起偏离缺省
  { id: 'appearance.uiFontFamily', section: 'appearance', sectionLabel: '外观', label: '界面字体', keywords: ['ui font 字体 字体族 sans-serif 界面字'], key: 'appearance.uiFontFamily', isModified: uiFontChanged },

  // ---- 通用 / 布局 ----
  { id: 'general.zen', section: 'general', sectionLabel: '通用', label: '写作模式', keywords: ['zen ctrl+k z 全屏'], key: 'general.zen' },
  { id: 'general.zenLimitWidth', section: 'general', sectionLabel: '通用', label: '编辑器居中限宽', keywords: ['居中 限宽 宽度'], key: 'general.zenLimitWidth' },
  { id: 'general.sealed', section: 'general', sectionLabel: '通用', label: '显示已封存功能', keywords: ['封存 sealed 实验'], key: 'general.sealed' },
  { id: 'general.layout', section: 'general', sectionLabel: '通用', label: '重置布局', keywords: ['布局 侧栏 面板 分屏'], key: 'general.layout' },

  // ---- 语言能力 / 快捷键 / 市场 / 关于 ----
  // 锚点真存在（住在 capability-matrix-view.tsx 的语言行上），所以照其他行一样登记 key。
  // 锚点真存在（住在 capability-matrix-view.tsx 的语言行上），所以照其他行一样登记 key。
  { id: 'language.capabilities', section: 'capabilities', sectionLabel: '语言能力', label: '语言能力', keywords: ['language 语法 支持 矩阵'], key: 'language.capabilities' },
  // 快捷键一整页：不给 key——那一节里没有"设置行"可指，页面上每个键位行自有 `[data-kb-id]`
  // 锚点（住在 KeybindingsPage.tsx，不在设置页的 `[data-settings-key]` 体系内）。
  // 指一枚并不存在的行锚点，等于让点击静默落空；跳节本身就是落到那一页（铁律 4）。
  { id: 'keybindings.page', section: 'keybindings', sectionLabel: '快捷键', label: '键盘快捷键', keywords: ['keybinding 快捷键 改键 解绑 撞键 恢复默认'], isModified: () => overrideCount() > 0 },
  { id: 'market.endpoint', section: 'market', sectionLabel: '口上市场', label: '包列表来源', keywords: ['market 索引 源 地址'], key: 'market.endpoint' },
  { id: 'about.update', section: 'about', sectionLabel: '关于', label: '检查更新', keywords: ['更新 版本 update'], key: 'about.update' },
  { id: 'about.developer', section: 'about', sectionLabel: '关于', label: 'GitHub 主页', keywords: ['开发者 poboking 作者'], key: 'about.developer' },
  { id: 'about.contact', section: 'about', sectionLabel: '关于', label: '联系邮箱', keywords: ['邮箱 mail 反馈'], key: 'about.contact' },
  { id: 'about.feedback', section: 'about', sectionLabel: '关于', label: '意见反馈', keywords: ['issue github 反馈'], key: 'about.feedback' },
];

/** 归一（大小写与空白不参与比对；作者敲 `ctrl + k` 也命中 `Ctrl+K`） */
function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

/**
 * 「已修改」的**唯一判据**（一处定义）：写了 `isModified` 判据、且当前读数确实偏离默认。
 * 没写判据的条目永远返回 false——猜出来的"已修改"比没有这条过滤更坏。
 * 三个消费者都吃它：下面的名单（过滤 + 徽标计数）与结果行上那枚「已改」标记。
 */
export function settingsEntryModified(entry: SettingsSearchEntry): boolean {
  return entry.isModified !== undefined && entry.isModified();
}

/**
 * 「已修改」的那一份名单（`settingsEntryModified` 的第一个消费者）。
 *
 * 徽标计数与「已修改」过滤**都**吃这个数组 ⇒ "徽标数 = 点数得到的条数"是构造上成立，
 * 不是两处各写一遍判据碰巧相等（两条各算一份名单时，任一处漏一条就永远对不上）。
 */
export function modifiedSettingsEntries(
  entries: readonly SettingsSearchEntry[] = SETTINGS_SEARCH_INDEX,
): SettingsSearchEntry[] {
  return entries.filter((entry) => settingsEntryModified(entry));
}

/** 一条结果的命中强度：标签子串 > 关键词子串 > 全串子序列 */
function scoreEntry(entry: SettingsSearchEntry, q: string): number {
  const label = normalize(entry.label);
  if (label.includes(q)) return 0;
  const haystack = normalize(`${entry.label} ${entry.keywords?.join(' ') ?? ''}`);
  if (haystack.includes(q)) return 1;
  const compact = normalize(`${haystack} ${entry.sectionLabel}`);
  let i = 0;
  for (const ch of q) {
    const at = compact.indexOf(ch, i);
    if (at < 0) return -1;
    i = at + 1;
  }
  return 2;
}

/**
 * 搜索设置项（空串 = 全量）。
 *
 * `modifiedOnly` 走 `modifiedSettingsEntries` 那份名单（与徽标计数同一个数组）——
 * 没写判据的条目**不会**被算进"已修改"。结果按命中强度分桶、桶内保持索引原序（同输入同输出）。
 */
export function searchSettings(
  query: string,
  opts: { readonly modifiedOnly?: boolean; readonly entries?: readonly SettingsSearchEntry[] } = {},
): SettingsSearchEntry[] {
  const modifiedOnly = opts.modifiedOnly === true;
  // 名单只从一处取：过滤之后仍按索引原序排（`at` 是名单内的位次，与索引同序）
  const entries = modifiedOnly
    ? modifiedSettingsEntries(opts.entries ?? SETTINGS_SEARCH_INDEX)
    : (opts.entries ?? SETTINGS_SEARCH_INDEX);
  const q = normalize(query.trim());
  const out: { entry: SettingsSearchEntry; score: number; at: number }[] = [];
  entries.forEach((entry, at) => {
    const score = q === '' ? 0 : scoreEntry(entry, q);
    if (score < 0) return;
    out.push({ entry, score, at });
  });
  out.sort((a, b) => a.score - b.score || a.at - b.at);
  return out.map((x) => x.entry);
}

/** 「已修改」的条目数（导航栏上那枚计数徽标；与 `searchSettings('', { modifiedOnly })` 同一个数组） */
export function settingsModifiedCount(
  entries: readonly SettingsSearchEntry[] = SETTINGS_SEARCH_INDEX,
): number {
  return modifiedSettingsEntries(entries).length;
}
