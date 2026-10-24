/**
 * 设置页 / 快捷键页两个面的右键菜单数据面（零渲染，可直接打纯函数）。
 *
 * ## 为什么从 `context-menu-pages.ts` 拆出来
 *
 * 这两个面原本与欢迎页同住一个模块，代价是**开机图**替他背了一整套设置知识：
 * 欢迎页的菜单模块在 `main.tsx` 的静态图上，于是一旦它 `import` 了
 * `settings-search`（设置项索引）/ `editor-display-prefs`（外观偏好，连带 `editor-options`）
 * 与 `keybindings`（键位表），这些东西就全被拖进首屏——而它们**只在设置浮层打开、
 * 用户右键某一行设置项**时才可能需要。设置浮层本体（`SettingsPanel.tsx`）本来就是懒的
 * （`main.tsx →(动态) ProjectView → ShellLayout → SettingsPanel`），把这两个面挂到那条
 * 懒边上，就不必让欢迎页替设置页付账。
 *
 * 因此本模块的**唯一合法入口是 `SettingsPanel.tsx`**（`KeybindingsPage.tsx` 由它静态引入，
 * 同属一个懒 chunk）。**不要**从任何开机图里的模块 import 它，也不要让
 * `context-menu-pages.ts` 转发这里的符号——那等于把刚剪断的懒边又接回首屏。
 *
 * ## 面声明的形态（与欢迎页同款，不自创第二套）
 *
 * - 面的注册在**模块顶层**（`declareContextSurface`）：id 取自 `CONTEXT_SURFACE_MANIFEST`
 *   （`settings` / `keybindings`），`build` 只做两件事——① 从 `target` 读 DOM 上的行数据
 *   （`data-settings-key` / `data-kb-id`）；② 把行数据与「本页注册的接线桥」合成纯函数入参。
 * - 页面挂载时 `register*MenuBridge` 注册一枚**接线桥**：桥里只有回调与只读读数，没有菜单知识。
 *   页面卸载即 `null`，所以菜单不会对着一个已经不存在的页面发动作。
 * - 抽屉里全是纯函数（`buildSettingsRowMenu` / `buildKeybindingRowMenu`）：输入上下文、
 *   输出 items，测试直接打它们。
 *
 * ## 两条铁律的落点（第三条「文案全中文」在文案里）
 *
 * 1. **能力不存在 ⇒ 整项不显示**：没有剪贴板就没有任何「复制…」项；不可改键的行
 *    （和弦 / Monaco 内建）整组没有「重置键位 / 移除键位」；
 * 2. **暂不可用 ⇒ `disabled: true` + `disabledReason` 人话**：已是默认值的行、
 *    没有覆盖的键位、本来就没有键位的行，一律灰着并说明为什么。
 */
import type { ContextMenuItem } from './context-menu-model';
import { declareContextSurface } from './context-surfaces';
import { clipboardAvailable, copyText } from './context-menu-pages';
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
import { isKeybindingRowModified, setKeybindingOverride, type KeybindingRow } from './keybindings';

/* ==========================================================================================
 * 一、设置页（WP4.5）
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
 * 二、快捷键页（WP4.6）
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
  /**
   * 有覆盖（改过键或解绑过）——「重置键位」的可用判据。
   * 判据本身不在这里：与快捷键页范围档「已改」同一枚谓词（`keybindings.ts` 的
   * `isKeybindingRowModified`），两处问的是同一件事，只许有一处定义。
   */
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
    hasOverride: isKeybindingRowModified(row),
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
 *   可改键但没有覆盖 / 本来没有键位时灰着说明（铁律，不灰着不说话）；
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
 * 三、接线桥（两页挂载时注册；卸载即撤掉）
 * ========================================================================================== */

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
 * 四、两个面的注册（模块顶层：模块被加载即登记，热重载幂等覆盖）
 *
 * ⚠ 顶层执行 = 本模块被谁静态 import，这两个面就挂在谁的加载路径上。本文件只该被
 * `SettingsPanel.tsx`（懒 chunk）静态引入；被开机图里的模块引入即等于面与它的
 * settings-search / editor-display-prefs / keybindings 依赖重回首屏，由
 * `settings-menu.test.ts` 的源码守门盯着。
 * ========================================================================================== */

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
