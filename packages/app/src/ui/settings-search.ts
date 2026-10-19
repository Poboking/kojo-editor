/**
 * 设置页搜索与「已修改」过滤（1020 编辑器体感批，用户反馈项 10）。
 *
 * 零 React 纯逻辑：一张条目索引 + 一个匹配函数。为什么要索引而不"扫 DOM 里的文字"：
 * 设置页的每一行是一段 JSX（值与回调都闭包在 props 上），运行时去读渲染出来的文本，
 * 得到的是"看起来像什么"而不是"这一项是什么"——点击结果要跳到哪一节、哪一行，
 * 必须由这份数据说了算，否则搜索结果会指向一个并不存在的位置。
 *
 * 两条口径：
 * - `key` 可选：给了 ⇒ 该项在页面上有 `[data-settings-key]` 锚点，点结果能滚到那一行并闪一下；
 *   没给 ⇒ 只跳到对应节（一节恒有内容，绝不出现"点了没反应"，铁律 4）。
 * - `isModified` 可选：**只有拿得到真源读数的条目才写它**。「已修改」过滤是一条判据，
 *   猜出来的已修改比没有已修改过滤更坏（作者会据此去翻一处其实没动过的设置）。
 */
import { overrideCount } from './keybindings';
import { loadLayoutPref, LAYOUT_PREF_DEFAULT } from './layout-pref';
import {
  modifiedEditorDisplayKeys,
  type EditorDisplayPrefs,
} from './editor-display-prefs';
import { loadFontSizePref, FONT_SIZE_DEFAULT } from './font-size-pref';
import { loadFormatRulesPref, FORMAT_RULES_DEFAULT } from './format-pref';
import type { SettingsSectionId } from './SettingsPanel';

export interface SettingsSearchEntry {
  /** 稳定 id（React key 与"当前选中结果"的判据；不进任何持久化） */
  readonly id: string;
  readonly section: SettingsSectionId;
  /** 节名（结果行右侧的分组读数，与左导航逐字同词） */
  readonly sectionLabel: string;
  /** 作者面叫法（搜索结果的主行） */
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

const layoutChanged = (): boolean => {
  const p = loadLayoutPref();
  const d = LAYOUT_PREF_DEFAULT;
  return p.wordWrap !== d.wordWrap || p.multiCursorModifier !== d.multiCursorModifier || p.columnSelection !== d.columnSelection;
};

const displayChanged = (): boolean => modifiedEditorDisplayKeys().length > 0;

const formatRulesChanged = (): boolean => {
  const p = loadFormatRulesPref();
  return p.fullWidthSpace !== FORMAT_RULES_DEFAULT.fullWidthSpace || p.indent !== FORMAT_RULES_DEFAULT.indent;
};

/**
 * 条目索引（顺序 = 无查询时「已修改」列表的展示序）。
 *
 * 覆盖面刻意是"高频 + 有真源"的那一批，不是全量设置清单：新增一行设置不必同步登记到这里，
 * 只有想让作者**搜得到**的行才需要一条条目（没登记 = 搜不到但仍在页面上，不是功能缺席）。
 */
export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  // ---- 编辑器 ----
  { id: 'editor.fontSize', section: 'editor', sectionLabel: '编辑器', label: '正文字号', keywords: ['字号 font size'], key: 'editor.fontSize', isModified: () => loadFontSizePref() !== FONT_SIZE_DEFAULT },
  { id: 'editor.lineHeight', section: 'editor', sectionLabel: '编辑器', label: '行高', keywords: ['line height 行距'], key: 'editor.lineHeight', isModified: displayKeyModified('lineHeight') },
  { id: 'editor.renderWhitespace', section: 'editor', sectionLabel: '编辑器', label: '空白符显示', keywords: ['空格 tab whitespace'], key: 'editor.renderWhitespace', isModified: displayKeyModified('renderWhitespace') },
  { id: 'editor.minimap', section: 'editor', sectionLabel: '编辑器', label: '缩略图', keywords: ['小地图 minimap 右侧概览'], key: 'editor.minimap', isModified: displayKeyModified('minimap') },
  { id: 'editor.lineNumbers', section: 'editor', sectionLabel: '编辑器', label: '行号', keywords: ['line numbers 相对行号'], key: 'editor.lineNumbers', isModified: displayKeyModified('lineNumbers') },
  { id: 'editor.fontFamily', section: 'editor', sectionLabel: '编辑器', label: '编程字体', keywords: ['font family 字体族 cascadia consolas'], key: 'editor.fontFamily', isModified: displayKeyModified('fontFamily') },
  { id: 'editor.inlayHints', section: 'editor', sectionLabel: '编辑器', label: '行内提示', keywords: ['inlay hints 形参名 内联'], key: 'editor.inlayHints', isModified: displayKeyModified('inlayHints') },
  { id: 'editor.sugarView', section: 'editor', sectionLabel: '编辑器', label: '.kojo 预览', keywords: ['糖 中文表层 ctrl+alt+t'], key: 'editor.sugarView' },
  { id: 'editor.formatOnSave', section: 'editor', sectionLabel: '编辑器', label: '保存时整理空白', keywords: ['格式化 format on save'], key: 'editor.formatOnSave' },
  { id: 'editor.formatRules', section: 'editor', sectionLabel: '编辑器', label: '整理规则（全角空格 / 缩进）', keywords: ['全角空格 缩进'], isModified: formatRulesChanged },
  { id: 'editor.wordWrap', section: 'editor', sectionLabel: '编辑器', label: '折行', keywords: ['word wrap 换行'], isModified: layoutChanged },
  { id: 'editor.multiCursor', section: 'editor', sectionLabel: '编辑器', label: '多光标修饰键与列选择', keywords: ['multi cursor 列选择 alt ctrl'], isModified: layoutChanged },
  { id: 'editor.autosave', section: 'editor', sectionLabel: '编辑器', label: '自动保存', keywords: ['autosave'], key: 'editor.autosave' },
  { id: 'editor.nameColor', section: 'editor', sectionLabel: '编辑器', label: '名字按用途着色', keywords: ['语义着色 color'], key: 'editor.nameColor' },

  // ---- 外观 ----
  { id: 'appearance.theme', section: 'appearance', sectionLabel: '外观', label: '主题配色', keywords: ['theme 深色 浅色 薄荷'], key: 'appearance.theme' },
  { id: 'appearance.motion', section: 'appearance', sectionLabel: '外观', label: '动效（减弱 / 关闭）', keywords: ['motion 动画 reduced'], key: 'appearance.motion' },
  { id: 'appearance.glass', section: 'appearance', sectionLabel: '外观', label: '玻璃透明度', keywords: ['glass 磨砂'], key: 'appearance.glass' },
  { id: 'appearance.panelVirtualize', section: 'appearance', sectionLabel: '外观', label: '长列表按需渲染', keywords: ['虚拟滚动 面板'], key: 'appearance.panelVirtualize' },

  // ---- 通用 / 布局 ----
  { id: 'general.zen', section: 'general', sectionLabel: '通用', label: '写作模式', keywords: ['zen ctrl+k z 全屏'], key: 'general.zen' },
  { id: 'general.layout', section: 'general', sectionLabel: '通用', label: '侧栏与面板布局', keywords: ['布局 重置 分屏'], key: 'general.layout' },
  { id: 'general.sealed', section: 'general', sectionLabel: '通用', label: '实验功能总闸', keywords: ['封存 sealed'], key: 'general.sealed' },

  // ---- 快捷键 / 市场 / 关于 ----
  { id: 'keybindings.page', section: 'keybindings', sectionLabel: '快捷键', label: '键盘快捷键（改键 / 解绑 / Monaco 内建）', keywords: ['keybinding 快捷键 撞键'], isModified: () => overrideCount() > 0 },
  { id: 'market.endpoint', section: 'market', sectionLabel: '口上市场', label: '口上市场地址', keywords: ['market 索引 源'], key: 'market.endpoint' },
  { id: 'about.update', section: 'about', sectionLabel: '关于', label: '检查更新', keywords: ['更新 版本 update'], key: 'about.update' },
  { id: 'about.contact', section: 'about', sectionLabel: '关于', label: '联系邮箱与意见反馈', keywords: ['邮箱 mail issue 反馈'], key: 'about.contact' },
];

/** 归一（大小写与空白不参与比对；作者敲 `ctrl + k` 也命中 `Ctrl+K`） */
function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
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
 * `modifiedOnly` 只看写了 `isModified` 的条目——没写判据的条目**不会**因为它而被排除掉
 * 之外的地方冒充"已修改"。结果按命中强度分桶、桶内保持索引原序（同输入同输出）。
 */
export function searchSettings(
  query: string,
  opts: { readonly modifiedOnly?: boolean; readonly entries?: readonly SettingsSearchEntry[] } = {},
): SettingsSearchEntry[] {
  const entries = opts.entries ?? SETTINGS_SEARCH_INDEX;
  const q = normalize(query.trim());
  const modifiedOnly = opts.modifiedOnly === true;
  const out: { entry: SettingsSearchEntry; score: number; at: number }[] = [];
  entries.forEach((entry, at) => {
    if (modifiedOnly && (entry.isModified === undefined || !entry.isModified())) return;
    const score = q === '' ? 0 : scoreEntry(entry, q);
    if (score < 0) return;
    out.push({ entry, score, at });
  });
  out.sort((a, b) => a.score - b.score || a.at - b.at);
  return out.map((x) => x.entry);
}

/** 「已修改」的条目数（导航栏上那枚计数徽标；判据与过滤逐字同源） */
export function settingsModifiedCount(
  entries: readonly SettingsSearchEntry[] = SETTINGS_SEARCH_INDEX,
): number {
  return entries.filter((e) => e.isModified !== undefined && e.isModified()).length;
}

/**
 * 结果的无障碍/文案行：`已修改` 徽标只在真判据上过真时出现。
 * （单独一个函数：设置页与将来的搜索结果渲染都吃这一条口径，不各写一遍。）
 */
export function settingsEntryModified(entry: SettingsSearchEntry): boolean {
  return entry.isModified !== undefined && entry.isModified();
}
