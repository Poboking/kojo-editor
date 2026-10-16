import { useEffect, useState } from 'react';
import { parseKeybinding, chordEquals, type KeyChord } from './commands';

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
 *   ——全局键盘处理器读的就是命令表的 `keybinding`，改键即刻生效，无需第二套分发逻辑。
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
  // ---- 编辑器动作（命令面板入口；不带缺省键位 = 不劫持 Monaco 内建键） ----
  { id: 'editor.action.find', title: '查找', category: '编辑器', rebindable: true, note: '编辑器内 Ctrl+F 为 Monaco 内建' },
  { id: 'editor.action.replace', title: '替换', category: '编辑器', rebindable: true, note: '编辑器内 Ctrl+H 为 Monaco 内建' },
  { id: 'editor.action.formatDocument', title: '格式化文档', category: '编辑器', rebindable: true, note: '编辑器内 Shift+Alt+F 为 Monaco 内建' },
  { id: 'editor.action.rename', title: '重命名符号', category: '编辑器', rebindable: true, note: '编辑器内 F2 为 Monaco 内建' },
  { id: 'editor.action.references', title: '查找引用', category: '编辑器', rebindable: true, note: '编辑器内 Shift+F12 为 Monaco 内建' },
  // ---- 编辑器内部（Monaco addCommand，仅展示） ----
  { id: 'editor.internal.save', title: '保存当前文件', category: '编辑器', keys: 'ctrl+s', rebindable: false, note: '编辑器内生效，暂不支持改键' },
];

const DEFAULTS = new Map(KEYBINDING_SPECS.filter((s) => s.keys !== undefined).map((s) => [s.id, s.keys!]));

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
      if (typeof k === 'string' && typeof v === 'string' && parseKeybinding(v) !== null) out[k] = v;
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

/** 生效键位 = 覆盖 ?? 缺省；不在注册表 = undefined */
export function effectiveKeybindingOf(id: string): string | undefined {
  const o = overrides[id];
  if (o !== undefined) return o;
  return DEFAULTS.get(id);
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
 * 设置覆盖（`keys` = 键位串；`null` = 回缺省）。非法键位串与不可改键的条目拒绝并返回 false
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
