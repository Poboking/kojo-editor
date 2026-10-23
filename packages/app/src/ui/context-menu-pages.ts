/**
 * 三个壳层页面（欢迎页 / 设置页 / 快捷键页）的右键菜单数据面（零渲染，可直接打纯函数）。
 *
 * ## 为什么单开一个模块
 *
 * 三页的菜单项判据（哪一项显示、哪一项灰着、灰的原因是什么）必须能被单测直接打，
 * 不能建立在"整页渲染出来点一下"上；三页又共享同一套「复制成功/失败都要说话」的口径
 * 与同一份「哪些设置项有默认值可回」的登记表——放在任一组件里都会被另外两页复制一遍。
 *
 * ## 结构（照地基的三件套，不自创第二套）
 *
 * - 面的注册在**模块顶层**（`declareContextSurface`）：id 取自 `CONTEXT_SURFACE_MANIFEST`
 *   （`welcome` / `welcome-recent` / `settings` / `keybindings`），`build` 只做两件事——
 *   ① 从 `target` 读 DOM 上的**行数据**（`data-recent-root` / `data-settings-key` / `data-kb-id`）；
 *   ② 把行数据与「本页注册的接线桥」合成纯函数入参。
 * - 各页在挂载时 `register*MenuBridge`（见下）注册一枚**接线桥**：桥里只有回调与只读读数，
 *   没有菜单知识。页面卸载即 `null`，所以菜单不会对着一个已经不存在的页面发动作。
 * - 抽屉里全是纯函数（`buildWelcomeRecentMenu` / `buildWelcomePageMenu` /
 *   `buildSettingsRowMenu` / `buildKeybindingRowMenu`）：输入上下文、输出 items，测试直接打它们。
 *
 * ## 三条铁律的落点
 *
 * 1. **文案全中文**（含 CJK），命令类项一律 `menuItemFromCommand` 取标题与键位；
 * 2. **能力不存在 ⇒ 整项不显示**：没有 Tauri（`show_in_folder` 不可用）就没有「在资源管理器中显示」；
 *    没有剪贴板就没有任何「复制…」项；命令行没就绪就没有命令项；
 * 3. **暂不可用 ⇒ `disabled: true` + `disabledReason` 人话**：已是默认值的行、没有覆盖的键位、
 *    目录已不存在的最近项目，一律灰着并说明为什么。
 */
import { useEffect, useState } from 'react';
import {
  buildFallbackMenu,
  canRunContextMenuCommand,
  menuItemFromCommand,
  runFallbackMenuAction,
  type ContextMenuItem,
} from './context-menu-model';
import { declareContextSurface } from './context-surfaces';
import { SETTINGS_SEARCH_INDEX } from './settings-search';
import {
  EDITOR_DISPLAY_PREF_DEFAULT,
  loadEditorDisplayPrefs,
  saveEditorDisplayPrefs,
  type EditorDisplayPrefs,
} from './editor-display-prefs';
import { FONT_SIZE_DEFAULT, loadFontSizePref, setFontSizePref } from './font-size-pref';
import {
  GLASS_TRANSPARENCY_DEFAULT,
  loadGlassTransparencyPref,
  resetGlassTransparencyPref,
} from './glass-pref';
import { PANEL_VIRTUALIZE_DEFAULT, loadPanelVirtualize, setPanelVirtualize } from './panel-prefs';
import { SEALED_DEFAULT, loadSealed, setSealed } from './sealed';
import { loadThemeChoice, setFollowSystem } from './theme-pref';
import { AUTOSAVE_MODE_DEFAULT, loadAutosavePref, setAutosavePref } from './autosave-pref';
import { NAME_COLOR_DEFAULT, loadNameColorPref, setNameColorPref } from './semantic-color-pref';
import { setKeybindingOverride, type KeybindingRow } from './keybindings';

/* ==========================================================================================
 * 一、公共小件：剪贴板与「一句话回执」
 * ========================================================================================== */

/**
 * 当前环境有没有可写剪贴板。
 *
 * 构建期判据：没有就让「复制…」整项不出现（铁律 4 的「能力不存在」），
 * 而不是给一个按下去只弹失败的入口。
 */
export function clipboardAvailable(): boolean {
  if (typeof navigator === 'undefined') return false;
  const clip: Clipboard | undefined = navigator.clipboard;
  return clip !== undefined && typeof clip.writeText === 'function';
}

/**
 * 写剪贴板并留下人话回执（成功、失败都说一句）。
 *
 * 复制是**最容易读成"没生效"**的动作：不吭声时作者只能反复点，最后怀疑按钮坏了。
 * 回执走各页自己的状态行（`role="status"`），不弹模态、不抢焦点。
 */
function copyText(text: string, what: string, note: (line: string) => void): void {
  if (!clipboardAvailable()) {
    note('复制失败：当前环境没有可用的剪贴板');
    return;
  }
  void navigator.clipboard.writeText(text).then(
    () => note(`已复制${what}`),
    () => note('复制失败：剪贴板拒绝了这次写入'),
  );
}

/** 菜单回执在屏幕上留多久（毫秒）：够读完一句中文，又不至于赖着） */
const MENU_NOTE_MS = 2600;

/**
 * 页面级的「菜单回执」状态（`note` 人话上屏 + 到时自动收起）。
 *
 * 三页共用这一份：菜单动作的回执不该三种写法——一处 `role="status"`、一处 toast、
 * 一处只写 console，作者会以为只有某一页的复制生效了。
 */
export function useMenuNote(): readonly [string | null, (line: string) => void] {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => setNote(null), MENU_NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);
  return [note, setNote] as const;
}

/**
 * 回执是不是一条失败（上错误色用）。
 *
 * 判据落在文案上而不是多开一条 tone 通道：回执的措辞本来就要求把成败说出来
 * （「已复制…」/「复制失败：…」），颜色只是给这句话加一层强调——只靠颜色表意
 * 对色觉障碍与读屏都不作数。
 */
export function isFailureNote(line: string): boolean {
  return line.includes('失败') || line.includes('没法');
}

/**
 * 这次按下是不是**主键**（左键）。
 *
 * 遮罩层的「点外面关掉浮层」只该认左键：右键是**开菜单**的手势，拿它在遮罩上按一下，
 * 浮层先被关掉、紧接着弹出一个压在空页面上的菜单——用户读到的是「右键把这一页关了」。
 * 右键语义归根路由（`context-surfaces.ts`），关窗语义留在这里。
 */
export function isPrimaryButton(event: { readonly button: number }): boolean {
  return event.button === 0;
}

/* ==========================================================================================
 * 二、欢迎页 · 最近项目行（WP4.4）
 * ========================================================================================== */

/** 行的动作 id（面自己的词表，不是命令） */
export const WELCOME_RECENT_ACTION = {
  open: 'welcome.openRecent',
  remove: 'welcome.removeRecent',
  copyPath: 'welcome.copyPath',
  reveal: 'welcome.reveal',
} as const;

/** 最近项目行的菜单入参（全部是纯数据：行读什么就传什么） */
export interface WelcomeRecentMenuInput {
  /** 打开这一项被挡住的人话原因（`null` = 现在就能打开） */
  readonly openBlockedReason: string | null;
  /** 目录已不存在（`stat` 判过）：行仍可点着重试，但「在资源管理器中显示」没意义 */
  readonly missing: boolean;
  /** 桌面壳在（`show_in_folder` 可用） */
  readonly canReveal: boolean;
  /** 剪贴板可用 */
  readonly canCopy: boolean;
}

/**
 * 最近项目行的菜单。
 *
 * - **打开**：被挡住（内核装配中 / 正在打开项目）时灰着并说明；
 * - **从最近移除**：走页面的既有移除回调（乐观更新 + 持久层都在那边）；
 * - **复制项目路径**：没有剪贴板就整项不出现；
 * - **在资源管理器中显示**：只有桌面壳才显示这一项；目录已不存在时灰着说明。
 *
 * 「在新组打开」**不做**：宿主没有「把项目开进新编辑器组」的能力（开项目 = 整块换工作区，
 * 编辑器组只切标签），菜单不为凑项新造业务逻辑。
 */
export function buildWelcomeRecentMenu(input: WelcomeRecentMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      id: WELCOME_RECENT_ACTION.open,
      label: '打开这个项目',
      icon: 'files',
      ...(input.openBlockedReason === null
        ? {}
        : { disabled: true, disabledReason: input.openBlockedReason }),
    },
    {
      id: WELCOME_RECENT_ACTION.remove,
      label: '从「最近」里移除',
      icon: 'trash',
      dividerBefore: true,
    },
  ];
  if (input.canCopy) {
    items.push({ id: WELCOME_RECENT_ACTION.copyPath, label: '复制项目路径' });
  }
  if (input.canReveal) {
    items.push({
      id: WELCOME_RECENT_ACTION.reveal,
      label: '在资源管理器中显示',
      icon: 'popout',
      dividerBefore: true,
      ...(input.missing ? { disabled: true, disabledReason: '这个目录已经不在了' } : {}),
    });
  }
  return items;
}

/* ==========================================================================================
 * 三、欢迎页 · 整面（WP4.4 的兜底：没有最近项目时的启动入口）
 * ========================================================================================== */

/** 整页面的动作 id */
export const WELCOME_PAGE_ACTION = {
  openDirectory: 'welcome.openDirectory',
  resume: 'welcome.resume',
  clearRecent: 'welcome.clearRecent',
} as const;

export interface WelcomePageMenuInput {
  readonly openBlockedReason: string | null;
  /** 有可继续的会话（最近一次打开的根，且没有待决的崩溃恢复） */
  readonly resumeAvailable: boolean;
  readonly hasRecent: boolean;
  /** 命令通道就绪（命令项否则灰着说明，不冒充能按） */
  readonly commandsReady: boolean;
  /** 通用项（复制 / 全选）：直接借兜底菜单的一份，页面不另写剪贴板判据 */
  readonly generic: readonly ContextMenuItem[];
}

/**
 * 欢迎页整面的菜单：启动（打开文件夹 / 继续上次会话） → 命令（命令面板 / 打开设置）
 * → 清理（清空最近项目） → 通用（复制 / 全选）。
 *
 * 为什么把通用项并进来：整面右键若不表态就会落到兜底菜单，可欢迎页上恰恰有大量可复制的
 * 路径文本（最近项目那张表）。这里复用兜底菜单算好的两项，不自己判断选区。
 */
export function buildWelcomePageMenu(input: WelcomePageMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      id: WELCOME_PAGE_ACTION.openDirectory,
      label: '打开文件夹…',
      icon: 'files',
      ...(input.openBlockedReason === null
        ? {}
        : { disabled: true, disabledReason: input.openBlockedReason }),
    },
  ];
  if (input.resumeAvailable) {
    items.push({
      id: WELCOME_PAGE_ACTION.resume,
      label: '继续上次会话',
      icon: 'history',
      ...(input.openBlockedReason === null
        ? {}
        : { disabled: true, disabledReason: input.openBlockedReason }),
    });
  }
  let firstCommand = true;
  for (const id of ['workbench.commandPalette', 'layout.openSettings']) {
    const item = menuItemFromCommand(id, firstCommand ? { dividerBefore: true } : undefined);
    if (item === null) continue; // 命令未登记 ⇒ 整项不显示
    firstCommand = false;
    items.push(
      input.commandsReady
        ? item
        : { ...item, disabled: true, disabledReason: '命令还没就绪，稍后再试' },
    );
  }
  if (input.hasRecent) {
    items.push({
      id: WELCOME_PAGE_ACTION.clearRecent,
      label: '清空最近项目',
      icon: 'trash',
      dividerBefore: true,
    });
  }
  input.generic.forEach((item, at) => {
    items.push(at === 0 ? { ...item, dividerBefore: true } : item);
  });
  return items;
}

/* ==========================================================================================
 * 四、设置页（WP4.5）
 * ========================================================================================== */

/** 一行设置可以被「重置」的登记项（读值、判默认、回默认三件事一个都不许猜） */
export interface SettingsResetEntry {
  /** 与页面上的 `[data-settings-key]` 同串 */
  readonly key: string;
  /** 作者面叫法（与设置页那一行的主文案同词） */
  readonly label: string;
  /** 当前值（「复制为 JSON」用；拿不到真源的项不登记） */
  read(): unknown;
  /** 是否已是默认值（决定「重置此项」可不可按） */
  isDefault(): boolean;
  /** 回默认：只走该偏好模块自己的 setter / reset，不直接写 localStorage */
  reset(): void;
}

/** 编辑器显示偏好的一行（八个键同一形态，故收成一处） */
function displayPrefEntry<K extends keyof EditorDisplayPrefs>(
  prefKey: K,
  menuKey: string,
  label: string,
): SettingsResetEntry {
  return {
    key: menuKey,
    label,
    read: () => loadEditorDisplayPrefs()[prefKey],
    isDefault: () => loadEditorDisplayPrefs()[prefKey] === EDITOR_DISPLAY_PREF_DEFAULT[prefKey],
    reset: () => {
      const patch = { [prefKey]: EDITOR_DISPLAY_PREF_DEFAULT[prefKey] } as Partial<EditorDisplayPrefs>;
      saveEditorDisplayPrefs(patch);
    },
  };
}

/**
 * 可重置的设置行（`[data-settings-key]` → 真源）。
 *
 * 只登记**真源是订阅式偏好模块**的行：那些模块的 setter 会广播，
 * 壳层的镜像值（props）跟着重算，页面不会出现"盘上改了、开关还亮着"的两个真相。
 * 写作模式 / 动效 / 市场地址 / .kojo 预览 / 保存时整理这几行是**壳层 useState 镜像**，
 * 模块级拿不到唯一的写入口 ⇒ 不登记（「重置此项」对它们整项不显示）。
 */
export const SETTINGS_RESET_TABLE: readonly SettingsResetEntry[] = [
  {
    key: 'general.sealed',
    label: '显示已封存功能',
    read: loadSealed,
    isDefault: () => loadSealed() === SEALED_DEFAULT,
    reset: () => {
      setSealed(SEALED_DEFAULT);
    },
  },
  {
    key: 'appearance.panelVirtualize',
    label: '长列表视口化',
    read: loadPanelVirtualize,
    isDefault: () => loadPanelVirtualize() === PANEL_VIRTUALIZE_DEFAULT,
    reset: () => {
      setPanelVirtualize(PANEL_VIRTUALIZE_DEFAULT);
    },
  },
  {
    key: 'appearance.glass',
    label: '毛玻璃透明度',
    read: loadGlassTransparencyPref,
    isDefault: () => loadGlassTransparencyPref() === GLASS_TRANSPARENCY_DEFAULT,
    reset: () => {
      resetGlassTransparencyPref();
    },
  },
  {
    key: 'appearance.followSystem',
    label: '跟随系统',
    read: loadThemeChoice,
    isDefault: () => loadThemeChoice() !== 'system',
    reset: () => {
      setFollowSystem(false);
    },
  },
  {
    key: 'editor.fontSize',
    label: '正文字号',
    read: loadFontSizePref,
    isDefault: () => loadFontSizePref() === FONT_SIZE_DEFAULT,
    reset: () => {
      setFontSizePref(FONT_SIZE_DEFAULT);
    },
  },
  displayPrefEntry('uiFontScale', 'editor.uiFontScale', '界面字号'),
  displayPrefEntry('lineHeight', 'editor.lineHeight', '行高'),
  displayPrefEntry('renderWhitespace', 'editor.renderWhitespace', '空白符显示'),
  displayPrefEntry('lineNumbers', 'editor.lineNumbers', '行号'),
  displayPrefEntry('minimap', 'editor.minimap', '缩略图'),
  displayPrefEntry('inlayHints', 'editor.inlayHints', '行内提示'),
  displayPrefEntry('fontFamily', 'editor.fontFamily', '编程字体'),
  {
    key: 'editor.nameColor',
    label: '定义与调用的名字分色',
    read: loadNameColorPref,
    isDefault: () => loadNameColorPref() === NAME_COLOR_DEFAULT,
    reset: () => {
      setNameColorPref(NAME_COLOR_DEFAULT);
    },
  },
  {
    key: 'editor.autosave',
    label: '自动保存',
    read: loadAutosavePref,
    isDefault: () => loadAutosavePref() === AUTOSAVE_MODE_DEFAULT,
    reset: () => {
      setAutosavePref(AUTOSAVE_MODE_DEFAULT);
    },
  },
];

/** 取一行的可重置登记（未登记 = 这一行没有"默认值"这个概念） */
export function settingsResetEntryOf(key: string): SettingsResetEntry | undefined {
  return SETTINGS_RESET_TABLE.find((entry) => entry.key === key);
}

/** `data-settings-key` 的节前缀 → 节名（与左导航逐字同词） */
const SECTION_LABEL_BY_PREFIX: Readonly<Record<string, string>> = {
  general: '通用',
  appearance: '外观',
  editor: '编辑器',
  market: '口上市场',
  about: '关于',
  keybindings: '快捷键',
};

/**
 * 一行设置属于哪一节（「搜索同类设置」要填进搜索框的那个词）。
 *
 * 先问搜索索引（那里有节名真源），索引没登记的行退回键前缀——两条都不会给空串，
 * 否则点「搜索同类设置」会变成"把搜索框清空"。
 */
export function settingsSectionLabelOf(key: string): string {
  const indexed = SETTINGS_SEARCH_INDEX.find((entry) => entry.key === key);
  if (indexed !== undefined) return indexed.sectionLabel;
  const prefix = key.split('.')[0] ?? '';
  return SECTION_LABEL_BY_PREFIX[prefix] ?? '设置';
}

/** 一行的当前值转 JSON（未登记的行没有值来源 ⇒ `null`，「复制为 JSON」整项不显示） */
export function settingsRowJsonOf(key: string): string | null {
  const entry = settingsResetEntryOf(key);
  if (entry === undefined) return null;
  return JSON.stringify({ [key]: entry.read() });
}

/** 设置页行的动作 id */
export const SETTINGS_ACTION = {
  reset: 'settings.reset',
  copyId: 'settings.copyId',
  copyJson: 'settings.copyJson',
  searchSection: 'settings.searchSection',
} as const;

export interface SettingsRowMenuInput {
  /** 这一行属于哪一节（节名，直接进搜索框） */
  readonly sectionLabel: string;
  /** 这一行有没有可重置的真源（`null` ⇒ 无默认值可回，「重置此项」/「复制为 JSON」都不出现） */
  readonly resettable: { readonly label: string; readonly isDefault: boolean } | null;
  readonly canCopy: boolean;
}

/**
 * 设置行的菜单。
 *
 * - **重置此项**：已登记真源才有；已是默认值时灰着说「已是默认值」；
 * - **复制设置 ID**：抄 `data-settings-key`（报告与求助时指认那一行最省事的串）；
 * - **复制为 JSON**：`{"<键>": <当前值>}`，只对有值来源的行出现；
 * - **搜索同类设置**：把节名填进搜索框（同节的其他项立刻列出来）。
 */
export function buildSettingsRowMenu(input: SettingsRowMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (input.resettable !== null) {
    items.push({
      id: SETTINGS_ACTION.reset,
      label: '重置此项',
      icon: 'reset',
      ...(input.resettable.isDefault
        ? { disabled: true, disabledReason: '已是默认值' }
        : {}),
    });
  }
  if (input.canCopy) {
    items.push({ id: SETTINGS_ACTION.copyId, label: '复制设置 ID' });
    if (input.resettable !== null) {
      items.push({ id: SETTINGS_ACTION.copyJson, label: '复制为 JSON' });
    }
  }
  items.push({
    id: SETTINGS_ACTION.searchSection,
    label: `搜索「${input.sectionLabel}」类设置`,
    icon: 'search',
    dividerBefore: items.length > 0,
  });
  return items;
}

/* ==========================================================================================
 * 五、快捷键页（WP4.6）
 * ========================================================================================== */

/** 快捷键行的动作 id */
export const KEYBINDING_ACTION = {
  copyId: 'keybindings.copyId',
  reset: 'keybindings.reset',
  remove: 'keybindings.remove',
  showConflict: 'keybindings.showConflict',
} as const;

/** 菜单需要的行读数（从 `KeybindingRow` 摘出来，纯函数不依赖行对象的其余字段） */
export interface KeybindingMenuState {
  readonly id: string;
  readonly title: string;
  readonly rebindable: boolean;
  /** 有覆盖（改过键或解绑过）——「重置键位」的可用判据 */
  readonly hasOverride: boolean;
  /** 当前有键位（解绑后为 false，「移除键位」没得可移） */
  readonly hasKeys: boolean;
  /** 与哪条命令撞了同一个键（无冲突 = null ⇒ 「查看同键位冲突」整项不显示） */
  readonly conflictWith: string | null;
}

/** `KeybindingRow` → 菜单读数（页面渲染行时顺手算好，交进桥里） */
export function keybindingMenuStateOf(row: KeybindingRow): KeybindingMenuState {
  return {
    id: row.id,
    title: row.title,
    rebindable: row.rebindable,
    hasOverride: row.state !== 'default',
    hasKeys: row.keys !== undefined,
    conflictWith: row.conflictWith,
  };
}

export interface KeybindingRowMenuInput extends KeybindingMenuState {
  /** 全页撞键项数（上屏用：点进去之前就知道要看多少条） */
  readonly conflictCount: number;
  readonly canCopy: boolean;
}

/**
 * 快捷键行的菜单。
 *
 * - **复制命令 ID**：抄命令 id（提 issue / 写插件时指认命令）；
 * - **重置键位 / 移除键位**：不可改键的行（和弦、Monaco 内建）整组不出现——那是能力不存在；
 *   可改键但没有覆盖 / 本来没有键位时灰着说明（铁律 4，不灰着不说话）；
 * - **查看同键位冲突**：只有真的撞了才出现，并把冲突条数写上屏。
 */
export function buildKeybindingRowMenu(input: KeybindingRowMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (input.canCopy) {
    items.push({ id: KEYBINDING_ACTION.copyId, label: '复制命令 ID' });
  }
  if (input.rebindable) {
    items.push(
      {
        id: KEYBINDING_ACTION.reset,
        label: '重置键位',
        icon: 'reset',
        dividerBefore: items.length > 0,
        ...(input.hasOverride ? {} : { disabled: true, disabledReason: '这一条还是默认键位' }),
      },
      {
        id: KEYBINDING_ACTION.remove,
        label: '移除键位',
        icon: 'trash',
        ...(input.hasKeys ? {} : { disabled: true, disabledReason: '这一条本来就没有键位' }),
      },
    );
  }
  if (input.conflictWith !== null) {
    items.push({
      id: KEYBINDING_ACTION.showConflict,
      label: `查看同键位冲突（共 ${input.conflictCount} 项）`,
      dividerBefore: true,
    });
  }
  return items;
}

/* ==========================================================================================
 * 六、接线桥（各页挂载时注册；卸载即撤掉）
 * ========================================================================================== */

/** 欢迎页的接线桥（只有回调与只读读数，没有任何菜单知识） */
export interface WelcomeMenuBridge {
  /** 打开被挡住的人话原因（`null` = 现在就能打开） */
  openBlockedReason(): string | null;
  canReveal(): boolean;
  resumeAvailable(): boolean;
  hasRecent(): boolean;
  openRecent(rootDir: string): void;
  removeRecent(rootDir: string): void;
  reveal(rootDir: string): void;
  openDirectory(): void;
  resumeSession(): void;
  clearRecent(): void;
  note(line: string): void;
}

let welcomeBridge: WelcomeMenuBridge | null = null;

/** 注册欢迎页接线桥（`null` = 卸载） */
export function registerWelcomeMenuBridge(bridge: WelcomeMenuBridge | null): void {
  welcomeBridge = bridge;
}

/** 设置页的接线桥 */
export interface SettingsMenuBridge {
  /** 把节名填进搜索框（页面自己的状态，菜单不碰它的实现） */
  searchSection(sectionLabel: string): void;
  note(line: string): void;
}

let settingsBridge: SettingsMenuBridge | null = null;

export function registerSettingsMenuBridge(bridge: SettingsMenuBridge | null): void {
  settingsBridge = bridge;
}

/** 快捷键页的接线桥 */
export interface KeybindingsMenuBridge {
  /** 行读数（页面已经算好，菜单不重算按键冲突） */
  rowOf(id: string): KeybindingMenuState | undefined;
  conflictCount(): number;
  /** 只看撞键（复用页面上那枚范围档，不另造一条过滤） */
  onlyConflicts(): void;
  note(line: string): void;
}

let keybindingsBridge: KeybindingsMenuBridge | null = null;

export function registerKeybindingsMenuBridge(bridge: KeybindingsMenuBridge | null): void {
  keybindingsBridge = bridge;
}

/* ==========================================================================================
 * 七、四个面的注册（模块顶层：模块被加载即登记，热重载幂等覆盖）
 * ========================================================================================== */

/** 最近项目行：行数据在 DOM，能力读数在桥 */
declareContextSurface({
  id: 'welcome-recent',
  ariaLabel: '最近项目菜单',
  area: 'chrome',
  build: (ctx) => {
    const bridge = welcomeBridge;
    const row = ctx.target.closest<HTMLElement>('[data-context-surface="welcome-recent"]');
    if (bridge === null || row === null) return null; // 这一级不表态 ⇒ 往兜底走
    const rootDir = row.getAttribute('data-recent-root') ?? '';
    if (rootDir === '') return null;
    const items = buildWelcomeRecentMenu({
      openBlockedReason: bridge.openBlockedReason(),
      missing: row.getAttribute('data-recent-missing') === '1',
      canReveal: bridge.canReveal(),
      canCopy: clipboardAvailable(),
    });
    return {
      items,
      onSelect: (id) => {
        switch (id) {
          case WELCOME_RECENT_ACTION.open:
            bridge.openRecent(rootDir);
            break;
          case WELCOME_RECENT_ACTION.remove:
            bridge.removeRecent(rootDir);
            bridge.note('已从「最近」里移除');
            break;
          case WELCOME_RECENT_ACTION.copyPath:
            copyText(rootDir, '项目路径', bridge.note);
            break;
          case WELCOME_RECENT_ACTION.reveal:
            bridge.reveal(rootDir);
            break;
          default:
            break;
        }
      },
    };
  },
});

/** 欢迎页整面：没有最近项目时这里就是启动入口 */
declareContextSurface({
  id: 'welcome',
  ariaLabel: '欢迎页菜单',
  area: 'chrome',
  build: (ctx) => {
    const bridge = welcomeBridge;
    if (bridge === null) return null;
    const items = buildWelcomePageMenu({
      openBlockedReason: bridge.openBlockedReason(),
      resumeAvailable: bridge.resumeAvailable(),
      hasRecent: bridge.hasRecent(),
      commandsReady:
        canRunContextMenuCommand('workbench.commandPalette') ||
        canRunContextMenuCommand('layout.openSettings'),
      // 通用项借兜底菜单现算（复制 / 全选），页面不另写一份选区判据
      generic: buildFallbackMenu(ctx.target).filter(
        (item) => item.id === 'clipboard.copy' || item.id === 'selection.selectAll',
      ),
    });
    return {
      items,
      onSelect: (id) => {
        switch (id) {
          case WELCOME_PAGE_ACTION.openDirectory:
            bridge.openDirectory();
            break;
          case WELCOME_PAGE_ACTION.resume:
            bridge.resumeSession();
            break;
          case WELCOME_PAGE_ACTION.clearRecent:
            bridge.clearRecent();
            bridge.note('已清空最近项目（磁盘上的文件没动）');
            break;
          default:
            // 命令项与通用项（复制 / 全选）都走地基的统一分发，本页不另写一套执行路径
            if (!runFallbackMenuAction(id, ctx.target)) bridge.note('这个动作现在没法执行');
            break;
        }
      },
    };
  },
});

/** 设置页：行数据在 `data-settings-key`，其余读数在桥与登记表 */
declareContextSurface({
  id: 'settings',
  ariaLabel: '设置菜单',
  area: 'chrome',
  build: (ctx) => {
    const bridge = settingsBridge;
    const row = ctx.target.closest<HTMLElement>('[data-settings-key]');
    if (bridge === null || row === null) return null; // 空白处 / 导航栏 / 搜索框 ⇒ 往兜底或输入框面走
    const key = row.getAttribute('data-settings-key') ?? '';
    if (key === '') return null;
    const entry = settingsResetEntryOf(key);
    const items = buildSettingsRowMenu({
      sectionLabel: settingsSectionLabelOf(key),
      resettable: entry === undefined ? null : { label: entry.label, isDefault: entry.isDefault() },
      canCopy: clipboardAvailable(),
    });
    return {
      items,
      onSelect: (id) => {
        switch (id) {
          case SETTINGS_ACTION.reset:
            if (entry !== undefined) {
              entry.reset();
              bridge.note(`「${entry.label}」已恢复默认`);
            }
            break;
          case SETTINGS_ACTION.copyId:
            copyText(key, '设置 ID', bridge.note);
            break;
          case SETTINGS_ACTION.copyJson: {
            const json = settingsRowJsonOf(key);
            if (json !== null) copyText(json, '这一项的 JSON', bridge.note);
            break;
          }
          case SETTINGS_ACTION.searchSection:
            bridge.searchSection(settingsSectionLabelOf(key));
            break;
          default:
            break;
        }
      },
    };
  },
});

/** 快捷键页：行读数在桥（页面已算好），改键走覆盖表既有 API */
declareContextSurface({
  id: 'keybindings',
  ariaLabel: '快捷键菜单',
  area: 'chrome',
  build: (ctx) => {
    const bridge = keybindingsBridge;
    const row = ctx.target.closest<HTMLElement>('[data-kb-id]');
    if (bridge === null || row === null) return null;
    const id = row.getAttribute('data-kb-id') ?? '';
    if (id === '') return null;
    const state = bridge.rowOf(id);
    if (state === undefined) return null;
    const items = buildKeybindingRowMenu({
      ...state,
      conflictCount: bridge.conflictCount(),
      canCopy: clipboardAvailable(),
    });
    return {
      items,
      onSelect: (picked) => {
        switch (picked) {
          case KEYBINDING_ACTION.copyId:
            copyText(id, '命令 ID', bridge.note);
            break;
          case KEYBINDING_ACTION.reset:
            if (setKeybindingOverride(id, null)) bridge.note(`「${state.title}」已恢复默认键位`);
            else bridge.note('恢复失败：这一条不支持改键');
            break;
          case KEYBINDING_ACTION.remove:
            if (setKeybindingOverride(id, '')) bridge.note(`「${state.title}」的键位已移除`);
            else bridge.note('移除失败：这一条不支持改键');
            break;
          case KEYBINDING_ACTION.showConflict:
            bridge.onlyConflicts();
            break;
          default:
            break;
        }
      },
    };
  },
});
