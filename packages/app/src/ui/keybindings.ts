import { useEffect, useState } from 'react';
import {
  parseKeybinding,
  chordEquals,
  formatKeybinding,
  byCodePoint,
  type KeyChord,
  type CommandEntry,
} from './commands';

/**
 * 集中键位注册表（R8 快捷键批）——宿主层单一真源。
 *
 * ## 为什么要有这一层
 *
 * 键位此前散在两处字面量里（ShellLayout 壳层命令、ProjectView 编辑器区命令），加上
 * Monaco 内部 addCommand（Ctrl+S）与硬编码特例（F1 / Ctrl+K Z），「到底有哪些快捷键」
 * 只能靠读源码回答。本模块把它们收敛成一张可查、可显示、可改的表：
 *
 * - **一处可查**：`KEYBINDING_SPECS` 是全部宿主键位的清单（含 Monaco 内部的 Ctrl+S）；
 * - **可显示**：命令面板与「键盘快捷键」对话框都从这里拿缺省键位；
 * - **可改**：覆盖表持久化在 localStorage，改动经订阅广播，壳层命令表随版本号重建
 *   ——全局键盘处理器读的就是命令表的 `keybinding`，改键即刻生效，无需第二套分发逻辑；
 * - **可整页管理**：`buildKeybindingRows` / `filterKeybindingRows` / `keybindingChips` 给快捷键
 *   设置页提供行数据（含解绑、全部恢复缺省、撞键提示），页面自身不含任何键位判据。
 *
 * ## 边界（刻意不做的）
 *
 * - **不劫持 Monaco 内建键**：编辑器内的 Ctrl+F / Ctrl+H / F2 / Shift+Alt+F 等仍是
 *   Monaco 的键位服务在管，宿主注册表只登记我们**自己**处理的键；编辑器动作命令
 *   （查找/替换/重命名/查找引用/格式化）进命令面板但**不带缺省键位**——想要的话
 *   作者可以自己绑（覆盖表只影响宿主分发，不会与 Monaco 抢键）。
 * - **和弦不改**：Ctrl+K Z 是两键序列，全局处理器是特例分支，改键不在本批射程
 *   （`rebindable: false`，对话框里明示）。
 * - **不与 UI-4 roving tabindex 冲突**：本模块只定义键位数据，键盘可达性（方向键
 *   漫游、focus-visible）仍在各组件的漫游逻辑里，两不相干。
 */

/** 键位注册表条目（宿主键位清单；展示名一律中文） */
export interface KeybindingSpec {
  /** 命令 id（与统一命令注册表同 key；Monaco 内部键位用 `editor.internal.` 前缀） */
  readonly id: string;
  /** 中文展示名（命令面板/键位表同词） */
  readonly title: string;
  /** 中文分类 */
  readonly category: string;
  /** 缺省键位（`undefined` = 无缺省键，仅命令面板入口；和弦含空格） */
  readonly keys?: string;
  /** 是否允许改键（和弦与 Monaco 内部键为 false） */
  readonly rebindable: boolean;
  /** 键位表里的备注（如「编辑器内生效」） */
  readonly note?: string;
}

/** 全部宿主键位（新增快捷键必须在这里登记，否则键位表看不见它） */
export const KEYBINDING_SPECS: readonly KeybindingSpec[] = [
  // ---- 布局（壳层容器语义） ----
  { id: 'layout.toggleSidebar', title: '切换主侧栏', category: '布局', keys: 'ctrl+b', rebindable: true },
  { id: 'layout.toggleBottom', title: '切换底部区', category: '布局', keys: 'ctrl+j', rebindable: true },
  { id: 'layout.toggleAux', title: '切换副侧栏', category: '布局', keys: 'ctrl+alt+b', rebindable: true },
  { id: 'layout.toggleZen', title: '切换写作模式', category: '布局', keys: 'ctrl+k z', rebindable: false, note: '和弦，暂不支持改键' },
  { id: 'layout.openSettings', title: '打开设置', category: '布局', rebindable: true },
  { id: 'layout.reset', title: '重置布局', category: '布局', rebindable: true },
  // ---- 工作台 ----
  { id: 'workbench.commandPalette', title: '命令面板', category: '工作台', keys: 'ctrl+shift+p', rebindable: true, note: 'F1 亦可' },
  { id: 'workbench.quickOpen', title: '快速打开文件', category: '工作台', keys: 'ctrl+p', rebindable: true },
  { id: 'workbench.workspaceSymbols', title: '转到工作区符号', category: '工作台', keys: 'ctrl+t', rebindable: true },
  { id: 'workbench.searchInFiles', title: '在文件中搜索', category: '工作台', keys: 'ctrl+shift+f', rebindable: true },
  { id: 'workbench.replaceInFiles', title: '在文件中替换', category: '工作台', keys: 'ctrl+shift+h', rebindable: true },
  { id: 'workbench.problems', title: '问题面板', category: '工作台', keys: 'ctrl+shift+m', rebindable: true },
  { id: 'workbench.keybindings', title: '打开键盘快捷键', category: '工作台', rebindable: true },
  // 文字缩放（A1 批给的缺省键位，本批入表 = 可查可改可显示）
  { id: 'editor.fontZoomIn', title: '放大文字', category: '编辑器', keys: 'ctrl+=', rebindable: true },
  { id: 'editor.fontZoomOut', title: '缩小文字', category: '编辑器', keys: 'ctrl+-', rebindable: true },
  { id: 'editor.fontZoomReset', title: '重置文字缩放', category: '编辑器', keys: 'ctrl+0', rebindable: true },
  { id: 'workbench.closeActiveTab', title: '关闭当前标签', category: '工作台', keys: 'ctrl+w', rebindable: true },
  { id: 'workbench.saveAll', title: '全部保存', category: '工作台', keys: 'ctrl+shift+s', rebindable: true },
  { id: 'workbench.fixAll', title: '一键修复当前文件', category: '工作台', keys: 'ctrl+shift+y', rebindable: true },
  { id: 'workbench.toggleSugarView', title: '切换 .kojo 预览', category: '工作台', keys: 'ctrl+alt+t', rebindable: true },
  { id: 'workbench.jumpToState', title: '看这一行的状态', category: '工作台', keys: 'ctrl+alt+s', rebindable: true },
  // 导航历史（MM-6 前进/后退 + MM-10 恢复关闭的标签）：编辑器肌肉记忆批。
  // Alt+←/→ 与 Ctrl+Shift+T 都是单键 chord，走全局分发（ShellLayout 注册表匹配）。
  { id: 'workbench.navBack', title: '后退', category: '工作台', keys: 'alt+arrowleft', rebindable: true },
  { id: 'workbench.navForward', title: '前进', category: '工作台', keys: 'alt+arrowright', rebindable: true },
  { id: 'workbench.reopenClosedTab', title: '恢复关闭的标签', category: '工作台', keys: 'ctrl+shift+t', rebindable: true },
  // 标签最近使用切换（1020 编辑器体感批）：Ctrl+Tab 在**焦点组**的 MRU 序里往后走。
  // Monaco 没有占这条键（vendor 里 `CtrlCmd|Tab` 零命中），宿主直接吃；连按语义在 App 的 cycleTab。
  { id: 'workbench.nextTab', title: '切到上一个用过的标签', category: '工作台', keys: 'ctrl+tab', rebindable: true, note: '连按继续在后用序里走；仅本组' },
  { id: 'workbench.prevTab', title: '切到下一个用过的标签', category: '工作台', keys: 'ctrl+shift+tab', rebindable: true, note: '与上一条方向相反；仅本组' },
  // ---- 分屏（SPLIT-1 编辑器组批 + MM-9 布局持久化批） ----
  { id: 'workbench.splitEditor', title: '向右拆分编辑器', category: '工作台', keys: 'ctrl+\\', rebindable: true },
  // MM-9：向下拆分同时把排列钉为上下（column）——命令名说什么就给什么；
  // 翻方向两条仅分屏时生效（单组翻了看不出来，命令侧先给人话）
  { id: 'workbench.splitEditorDown', title: '向下拆分编辑器', category: '工作台', rebindable: true, note: '拆分并切换为上下排列' },
  { id: 'workbench.setGroupsColumn', title: '编辑器组上下排列', category: '工作台', rebindable: true, note: '仅分屏时生效；单组先拆分' },
  { id: 'workbench.setGroupsRow', title: '编辑器组左右排列', category: '工作台', rebindable: true, note: '仅分屏时生效；单组先拆分' },
  { id: 'workbench.closeEditorGroup', title: '关闭编辑器组', category: '工作台', rebindable: true, note: '仅分屏时生效；单组不可关' },
  // ---- 编辑器动作（命令面板入口；不带缺省键位 = 不劫持 Monaco 内建键） ----
  { id: 'editor.action.find', title: '查找', category: '编辑器', rebindable: true, note: '编辑器内 Ctrl+F 为 Monaco 内建' },
  { id: 'editor.action.replace', title: '替换', category: '编辑器', rebindable: true, note: '编辑器内 Ctrl+H 为 Monaco 内建' },
  { id: 'editor.action.formatDocument', title: '格式化文档', category: '编辑器', rebindable: true, note: '编辑器内 Shift+Alt+F 为 Monaco 内建' },
  { id: 'editor.action.rename', title: '重命名符号', category: '编辑器', rebindable: true, note: '编辑器内 F2 为 Monaco 内建' },
  { id: 'editor.action.references', title: '查找引用', category: '编辑器', rebindable: true, note: '编辑器内 Shift+F12 为 Monaco 内建' },
  { id: 'editor.action.gotoLine', title: '转到行', category: '编辑器', rebindable: true, note: '编辑器内 Ctrl+G 为 Monaco 内建' },
  // ---- 编辑器内部（Monaco addCommand，仅展示） ----
  { id: 'editor.internal.save', title: '保存当前文件', category: '编辑器', keys: 'ctrl+s', rebindable: false, note: '编辑器内生效，暂不支持改键' },
  // A7「在选定内容中查找」：有选区时把选中文本灌进 find 并把搜索域钉在选区（无选区不动作）
  { id: 'editor.internal.findInSelection', title: '在选定内容中查找', category: '编辑器', keys: 'ctrl+alt+f', rebindable: false, note: '编辑器内生效；先选中文本再按' },
];

const DEFAULTS = new Map(KEYBINDING_SPECS.filter((s) => s.keys !== undefined).map((s) => [s.id, s.keys!]));

/**
 * 分类的展示顺序（快捷键页左导航据此排）。
 *
 * 为什么要显式一张序表而不是 `localeCompare`：分类名是中文，字典序随运行环境的区域设置漂移，
 * 同一张表在两台机器上两种顺序 ⇒ 作者记住「编辑器在第三位」就不可靠。
 * 新增分类**必须同时**加进这里，否则该分类会被排到最后（漏了也不会炸，只是靠后）。
 */
export const KEYBINDING_CATEGORY_ORDER: readonly string[] = ['工作台', '布局', '编辑器'];

/** 键位现状三态：原样 / 被改过 / 被作者关掉（解绑） */
export type BindingState = 'default' | 'overridden' | 'unbound';

/**
 * 快捷键页一行的行数据（纯派生，不含 React）。
 *
 * 为什么要在这一层算好而不是让组件各算各的：这一行要同时给出键位串（给分发与改键用）、
 * 人读展示形（给作者看）、状态与撞键提示；组件里各算一套就会出现「面板显示一个键、
 * 表格显示另一个键」——同一页两个真相是事故。
 */
export interface KeybindingRow {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  /** 生效键位串（和弦含空格，如 `'ctrl+k z'`）；无键位 = `undefined` */
  readonly keys: string | undefined;
  /** 人读展示形（走 `formatKeybinding`）；无键位 = 空串 */
  readonly display: string;
  readonly rebindable: boolean;
  readonly note: string | null;
  readonly state: BindingState;
  /** 与哪条命令撞了同一个键（对方展示名）；无冲突 = `null`。和弦不参与判重 */
  readonly conflictWith: string | null;
}

const STORAGE_KEY = 'kojo.keybindings.v1';

/** 覆盖表（id → 键位串）。node/无 localStorage 环境退化为内存表（测试与 SSR 不炸） */
let overrides: Record<string, string> = loadOverrides();

function loadOverrides(): Record<string, string> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k !== 'string' || typeof v !== 'string') continue;
      // 空串 = 作者显式要求「这个命令没有键位」，是合法持久化值。
      // 旧写法一刀切 `parseKeybinding(v) !== null` 会把它当坏数据滤掉（parseKeybinding('') 返回 null），
      // 于是解绑存进去、下次启动悄悄复活——作者以为解绑没生效。
      if (v === '' || parseKeybinding(v) !== null) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    }
  } catch {
    // 存储不可写（隐私模式等）：覆盖仍在内存里活到本会话结束，改键不因此坏掉
  }
}

/* ---------------------------- 订阅（版本号驱动重建） ---------------------------- */

let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const l of listeners) l();
}

/** 订阅覆盖表变化（返回退订函数） */
export function subscribeKeybindings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前版本号（React 侧经 useKeybindingsVersion 消费） */
export function keybindingsVersion(): number {
  return version;
}

/** React 钩子：覆盖表变化即重渲染（命令表据此重建，改键即刻生效） */
export function useKeybindingsVersion(): number {
  const [v, setV] = useState(version);
  useEffect(() => subscribeKeybindings(() => setV(keybindingsVersion())), []);
  return v;
}

/* ---------------------------- 查询与修改 ---------------------------- */

/** 缺省键位（不在注册表 = undefined） */
export function defaultKeybindingOf(id: string): string | undefined {
  return DEFAULTS.get(id);
}

/** 生效键位 = 覆盖 ?? 缺省；不在注册表 = undefined；已解绑也 = undefined（无键位可用） */
export function effectiveKeybindingOf(id: string): string | undefined {
  const o = overrides[id];
  if (o === '') return undefined; // 显式解绑：覆盖表里存空串，对分发与展示都等于「没有键位」
  if (o !== undefined) return o;
  return DEFAULTS.get(id);
}

/** 这条键位现在是原样、被改过，还是被作者关掉了（快捷键页的行徽标据此画） */
export function bindingStateOf(id: string): BindingState {
  const o = overrides[id];
  if (o === undefined) return 'default';
  return o === '' ? 'unbound' : 'overridden';
}

/** 覆盖条数（含已解绑——解绑也是作者做过的改动，得计入「有几处不是缺省」） */
export function overrideCount(): number {
  return Object.keys(overrides).length;
}

/**
 * 全部回到缺省（含解绑），返回被清掉的条数。
 * 空表**不落盘也不广播**：一次无改动的点击让整张命令表重建一遍，只是白白抖一次界面，
 * 还会把「恢复过」这个信号抹平成「刚刚改过」。
 */
export function resetAllKeybindings(): number {
  const cleared = overrideCount();
  if (cleared === 0) return 0;
  overrides = {};
  persist();
  bump();
  return cleared;
}

/** 注册表条目（展示用） */
export function keybindingSpecOf(id: string): KeybindingSpec | undefined {
  return KEYBINDING_SPECS.find((s) => s.id === id);
}

/** 该 id 是否有用户覆盖 */
export function hasKeybindingOverride(id: string): boolean {
  return overrides[id] !== undefined;
}

/**
 * 设置覆盖（`keys` = 键位串；`''` = 解绑，即作者显式要求这个命令没有键位；`null` = 回缺省）。
 * 非法键位串与不可改键的条目拒绝并返回 false
 * ——改键是持久化操作，宁可按不下也不能写进坏数据。
 */
export function setKeybindingOverride(id: string, keys: string | null): boolean {
  const spec = keybindingSpecOf(id);
  if (!spec || !spec.rebindable) return false;
  if (keys === null) {
    if (overrides[id] === undefined) return true; // 幂等：本来就没有覆盖
    delete overrides[id];
    persist();
    bump();
    return true;
  }
  if (keys === '') {
    if (overrides[id] === '') return true; // 幂等：已经是解绑态
    overrides[id] = '';
    persist();
    bump();
    return true;
  }
  const parsed = parseKeybinding(keys);
  if (parsed === null || /\s/.test(parsed.key)) return false; // 主键带空白 = 不是一键（坏数据不进持久化）
  overrides[id] = keys;
  persist();
  bump();
  return true;
}

/**
 * 键位冲突检测：除 `excludeId` 外还有哪条命令占了同一个 chord（展示给作者看，
 * 不阻止——分发按注册表顺序先到先得，冲突方让位，对话框里一句话说清）。
 */
export function keybindingConflictWith(chord: KeyChord, excludeId: string): string | null {
  for (const spec of KEYBINDING_SPECS) {
    if (spec.id === excludeId) continue;
    const keys = effectiveKeybindingOf(spec.id);
    if (keys === undefined || keys.includes(' ')) continue; // 和弦走全局处理器特例，不算单键冲突
    const parsed = parseKeybinding(keys);
    if (parsed && chordEquals(parsed, chord)) return spec.title;
  }
  return null;
}

/** KeyChord → 键位串（`parseKeybinding` 的逆；捕获改键时落库用） */
export function chordToBinding(c: KeyChord): string {
  const parts: string[] = [];
  if (c.ctrl) parts.push('ctrl');
  if (c.shift) parts.push('shift');
  if (c.alt) parts.push('alt');
  if (c.meta) parts.push('meta');
  parts.push(c.key);
  return parts.join('+');
}

/* ---------------------------- 快捷键页的表格视图 ---------------------------- */

/** 分类在序表里的位次；未登记的分类一律排到最后（漏登记只是靠后，不是消失） */
function categoryRank(category: string): number {
  const i = KEYBINDING_CATEGORY_ORDER.indexOf(category);
  return i === -1 ? KEYBINDING_CATEGORY_ORDER.length : i;
}

function compareRows(a: KeybindingRow, b: KeybindingRow): number {
  const ra = categoryRank(a.category);
  const rb = categoryRank(b.category);
  if (ra !== rb) return ra - rb;
  // 同位次只可能是「都没登记的不同分类」，否则就是同一分类 ⇒ 按码点序（不用 localeCompare，理由见 commands.ts）
  if (a.category !== b.category) return byCodePoint(a.category, b.category);
  return byCodePoint(a.title, b.title);
}

/**
 * 命令注册表 + 键位表 ⇒ 快捷键页的表格行。
 *
 * 行的**有无**取自命令注册表（那里才是「到底有哪些命令」的真相），键位表只补充
 * 「能不能改、缺省是什么、有什么要说」——只在键位表登记、命令面板里没有的东西不该出现在页面上，
 * 反之新命令忘了登记键位也必须看得见（否则作者无从知道它存在，只是改不了键）。
 *
 * 纯派生：同样的命令清单 + 同样的覆盖表 ⇒ 同样的行序，组件侧不必再排序或去重。
 */
export function buildKeybindingRows(commands: readonly CommandEntry[]): KeybindingRow[] {
  const rows: KeybindingRow[] = commands.map((c) => {
    const spec = keybindingSpecOf(c.id);
    const keys = effectiveKeybindingOf(c.id) ?? c.keybinding;
    return {
      id: c.id,
      // 展示名以命令项为准——命令面板显示什么，这里就显示什么；命令项没给词才退回键位表
      title: c.title === '' ? (spec?.title ?? '') : c.title,
      category: c.category ?? spec?.category ?? '',
      keys,
      display: keys === undefined ? '' : formatKeybinding(keys),
      // 没在键位表登记过的命令一律不许改键：改键只对「知道缺省、也知道怎么复原」的键位开放
      rebindable: spec?.rebindable ?? false,
      note: spec?.note ?? null,
      state: bindingStateOf(c.id),
      conflictWith: null,
    };
  });
  rows.sort(compareRows);

  // 撞键分组：先把键位串归一再比（`shift+ctrl+p` 与 `ctrl+shift+p` 是同一个键，字面不同而已）。
  // 和弦（含空格）不参与判重——它由全局处理器的特例分支分发，与单键不同一条路径。
  const groups = new Map<string, KeybindingRow[]>();
  for (const row of rows) {
    const keys = row.keys;
    if (keys === undefined || keys.includes(' ')) continue;
    const parsed = parseKeybinding(keys);
    if (parsed === null) continue;
    const canonical = chordToBinding(parsed);
    const bucket = groups.get(canonical);
    if (bucket) bucket.push(row);
    else groups.set(canonical, [row]);
  }

  const partners = new Map<KeybindingRow, string>();
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    bucket.forEach((row, at) => {
      // 「第一个对方」按排序后的行序取，故同输入同输出（不依赖分组遍历以外的顺序）
      const partner = bucket[at === 0 ? 1 : 0];
      if (partner) partners.set(row, partner.title);
    });
  }
  if (partners.size === 0) return rows;
  return rows.map((row) => {
    const partner = partners.get(row);
    return partner === undefined ? row : { ...row, conflictWith: partner };
  });
}

/** 搜索用的归一形：小写 + 去空白，作者敲 `ctrl + k` 也命中展示形 `Ctrl+K` */
function normalizeForSearch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

/** 快捷键页的搜索框过滤（命中 标题/分类/展示键位/id；空串返回全部且是**新数组**） */
export function filterKeybindingRows(rows: readonly KeybindingRow[], query: string): KeybindingRow[] {
  const q = normalizeForSearch(query);
  if (q === '') return [...rows];
  return rows.filter(
    (r) => normalizeForSearch(`${r.title} ${r.category} ${r.display} ${r.id}`).includes(q),
  );
}

/**
 * 键位串 → 一枚枚按键芯片（`'ctrl+k z'` ⇒ `[['Ctrl','K'],['Z']]`；和弦一步一组，画成「按这组，再按这组」）。
 *
 * 展示口径直接借 `formatKeybinding` 再拆开，不在这里重排修饰键——两处各写一套顺序，
 * 命令面板的提示和快捷键页的芯片就会两个词。非法串返回空数组而不抛：
 * 表格渲染里抛一次 = 整页白屏，比画不出芯片严重得多。
 */
export function keybindingChips(binding: string): string[][] {
  if (typeof binding !== 'string') return [];
  const steps = binding.trim().split(/\s+/).filter(Boolean);
  const out: string[][] = [];
  for (const step of steps) {
    if (parseKeybinding(step) === null) return []; // 任一步不认得 ⇒ 整串不画芯片
    out.push(formatKeybinding(step).split('+'));
  }
  return out;
}
