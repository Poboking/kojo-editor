import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { Kernel } from '@kojo/kernel';
import type { EditorCommandContext, EditorCommandContribution, EditorWorkspaceSymbol, ErbParserService, FileEncoding, MarketService, UIPanelContribution } from '@kojo/plugin-api';
import {errorText,  MARKET_SERVICE_KEY } from '@kojo/plugin-api';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import {
  beginLiveResize,
  beginSplitResize,
  defaultLayout,
  effectiveLocation,
  filterGameScopedPanels,
  gameScopeByPlugin,
  loadLayout,
  organizePanels,
  reducer,
  reconcileLayout,
  resetLayout,
  saveLayout,
  type ContainerKey,
  type LayoutState,
  type OrganizedPanels,
  type ViewDef,
} from './layout';
import {
  PANEL_DRAG_MIME,
  acceptsPanelDrop,
  decodeDroppedPanelIds,
  nextDropTarget,
  planPanelMoves,
} from './panel-drop';
import {
  RESIZE_HANDLES,
  keyResizeDelta,
  resizeRect,
  type ResizeHandle,
  type Viewport,
} from './float-geometry';
import { beginFloatDrag, beginFloatResize } from './float-drag';
import { loadSugarViewPref, saveSugarViewPref } from './sugar-view';
// 保存时整理空白（E2）：偏好真源在 localStorage（`format-pref.ts`），保存链路每次现读
import { loadFormatOnSavePref, saveFormatOnSavePref } from './format-pref';
// 状态栏即时开关（B 批）：自动换行三档（layout-pref）与空白符五档（editor-display-prefs）
// 的真源与展示词汇都在各自纯模块里；这里只取投影 + 写值，落 Monaco 由既有订阅通路负责。
import {
  loadLayoutPref,
  nextWordWrapToggle,
  saveWordWrapPref,
  subscribeLayoutPref,
  WORD_WRAP_CHOICES,
  WORD_WRAP_LABELS,
} from './layout-pref';
import { layoutPrefPatch } from './editor-options';
import {
  loadEditorDisplayPrefs,
  nextRenderWhitespaceToggle,
  RENDER_WHITESPACE_CHOICES,
  RENDER_WHITESPACE_LABELS,
  saveEditorDisplayPrefs,
  useEditorDisplayPrefs,
} from './editor-display-prefs';
// 行上内联注解（B8）：同一份偏好形态，默认关；开关真源在 localStorage，这里只写值 + 发意图
import { loadCodeLensPref, saveCodeLensPref } from './code-lens-pref';
import { useNameColorPref } from './semantic-color-pref';
import {
  saveQuickSuggestionsPref,
  saveSuggestDelayPref,
  saveWordBasedSuggestionsPref,
  useQuickSuggestionsPref,
  useSuggestDelayPref,
  useWordBasedSuggestionsPref,
} from './suggest-pref';
import {
  resetFontZoomPref,
  stepFontZoomPref,
  useFontSizePref,
  useFontZoomPref,
} from './font-size-pref';
import { fileWritableArea, writablePillTone } from './file-area';
// 状态栏三格（批次十 S1）：语言模式 / 缩进 / 编码的偏好与判据都在各自纯逻辑模块里，
// 这里只取「当前活动文件那份 model」并把选择落到 model 上。
import { focusedCtx, openModelAcrossGroups } from './editor-pane-registry';
import { descriptorForPath, FALLBACK_LANGUAGE_ID, languageDescriptors } from '../monaco/language-registry';
import type * as Monaco from '../monaco/entry';
import {
  languageModeChoices,
  resolveModelLanguage,
  setLanguageOverride,
} from './language-mode-pref';
import {
  applyIndentPref,
  indentChoiceFromOptions,
  indentLabel,
  indentLabelFromOptions,
  indentPrefFor,
  nextIndentChoice,
  setIndentPref,
  storedIndentChoiceFor,
  type IndentTarget,
} from './indentation-pref';
// S2 的编码清单是纯模块（只 import type），静态取即可；动作侧原本想走"点击时装配"，
// 但 `encoding-actions` 既然已经为清单静态进开机图，那条 `import('./encoding-actions')`
// 一个字节也省不下，只会换来 rollup 的「动态+静态混用」警告（S7-首屏清账）⇒ 一并静态引。
// 真正重的那半（monaco 模型池 `editor-model-pool-instance`）仍是点击时的动态装载。
import { createEncodingActions, listEncodings } from './encoding-actions';
import { useAutosavePref } from './autosave-pref';
import {
  applyMotionPref,
  loadMotionPref,
  saveMotionPref,
  type MotionPref,
} from './motion-pref';
// 毛玻璃透明度（2026-10-17 教程打磨批）：真源在 glass-pref 的 localStorage，挂载时写一次根元素，
// 设置页旋钮改值即时联动全场磨砂面（--glass-alpha + data-glass）
import { applyGlassPref, useGlassTransparencyPref } from './glass-pref';
// 主题（2026-10-17 主题系统）：真源在 theme-pref 的 localStorage，挂载/翻开关时写 <html data-theme>，
// 由 themes/*.css 的 :root[data-theme=…] 读；与 glass/motion 同款分层（生效路径单源、可单测）
import { applyThemePref, useThemePref } from './theme-pref';
import { filterSealedPanels, useSealed } from './sealed';
import { useDirectMode } from './direct-mode';
import { usePanelVirtualize } from './panel-prefs';
// 2.0 面投影（K2-EDITOR-OPEN-PATHS）：开关关着时恒 undefined，下传面与改动前逐字相同
import { useKojo2Surface } from './kojo2-open-paths';
import {
  applyEndpointEdit,
  isOverridden,
  NO_SERVICE_VIEW,
  resetEndpoint,
  type MarketSourceView,
} from './market-source';
import {
  reduceUpdatePhase,
  updateDialogPhase,
  updateStatus,
  type UpdateAction,
  type UpdatePhase,
} from './update-check';
import { UpdateDialog } from './UpdateDialog';
import { isTauri } from '../bridge/invoke';
import { modalDepth, closeTopModal } from './modal-stack';
import { useNotify } from './NotificationCenter';
import {
  isComposingEvent,
  isEditableKeyTarget,
  nextRovingIndex,
  reportKeyYield,
  resolveEscLayer,
  resolveGlobalKeyGate,
  shouldRunGlobalCommand,
} from './shell-keys';
import {
  buildCommandRegistry,
  chordFromEvent,
  chordEquals,
  commandEnabled,
  parseKeybinding,
  type ShellCommandSpec,
} from './commands';
// 内核动作清单（1026 编辑器内核批）：Monaco 内建动作的宿主命令入口，纯数据
import { MONACO_COMMAND_SPECS } from './monaco-command-specs';
import {
  CommandPalette,
  QuickOpen,
  WorkspaceSymbols,
  type PaletteReveal,
} from './Palette';
import type { ActiveFileSymbolSource } from './palette-search';
import { effectiveKeybindingOf, useKeybindingsVersion } from './keybindings';
// 文档内书签（1026 编辑器体感 C 批）：判据与存取全在 ./bookmarks（纯逻辑），这里是命令层
import { clearFileBookmarks, nextBookmark, prevBookmark, toggleBookmark } from './bookmarks';
import {
  collectWorkspaceSymbols,
  workspaceSymbolNotice,
  WORKSPACE_SYMBOL_RENDER_LIMIT,
} from './workspace-symbols';
import { PanelBody, StatusbarItem } from './PanelHost';
import { useOverlayPresence } from './overlay-chrome';
import { projectDirName } from './window-title';
import { ProblemsStatusItem } from './ProblemPanel';
// 项目名旁的「更多」菜单（C-1a）：复用全站共享 <ContextMenu>（玻璃观感 + WAI-ARIA 键盘），不另造菜单
import { ContextMenu, type ContextMenuItem } from './context-menu';
// 右键菜单（1023 覆盖面批）：根路由挂在 App 壳层，命令注册表在这里——两边靠这根线接头，
// 兜底菜单里的「命令面板 / 设置 / 检查更新」才按得动（判据与命令面板同一份，不另造）。
import {
  isPrimaryButton,
  registerContextMenuCommandRunner,
  registerMenuKeybindingLookup,
} from './context-menu-model';
// 壳层七面的右键菜单（1023 覆盖面批）：菜单数据面在 context-menu-shell（纯函数 + 面声明），
// 这里只注入能力面（快照 + 既有布局动作），不把菜单文案写进这个 2269 行的大文件。
import {
  defaultFloatRect,
  installShellMenuHost,
  maximizedFloatRect,
  type ShellContainerTarget,
  type ShellMenuHost,
} from './context-menu-shell';
import { requestReplaceFocus, requestSearchFocus } from './search-store';
import { Icon } from './icons';
import { SettingsPanel, type SettingsSectionId } from './SettingsPanel';
import { toggleFullscreen } from './window-fullscreen';

/**
 * 壳层五区布局（2026-10-11 UI 重设计批 P1；定稿 §二）。
 *
 * 区域：顶部工具栏 / 活动栏 + 主侧栏 / 编辑器区 / 副侧栏 / 底部区 / 状态栏。
 * 壳层只懂容器语义（location / group / 显隐 / 尺寸）——零业务知识；面板内容
 * 全部来自 `ui.panel` 槽贡献 + 内建视图（口上文件树，与槽同构注入）。
 *
 * 布局状态持久化在 WebView localStorage（`kojo.ui.layout.v1`，全局一份，
 * 定稿 Q3）——内核存储域零负担。「重置布局」清持久化回落默认。
 */

/** `@` 模式的缺省来源（编辑器区没注入 ⇒ 恒回 `null`，面板照实说"还没有打开文件"） */
const NO_ACTIVE_FILE_SYMBOLS = (): ActiveFileSymbolSource | null => null;

export interface EditorStatusInfo {
  encoding: string;
  eol: string;
  lines: number;
  /** 最近一次自动保存成功的时刻（epochMs；手动保存/切文件不写这条，链路复用 onStatusInfo 不新开协议） */
  autosavedAt?: number | null;
  /** A9 选区/光标读数文案（`选中 …` 或 `行:列`；糖视图/无文件时 ''） */
  sel?: string;
  /**
   * EOL 读数此刻能不能点击切换（W7-H）。
   *
   * 只有"可写 + 原文面"为 true：只读文件（写权限未批准 / 游戏目录 ERB 未解锁）与
   * `.kojo` 预览面挂的是派生只读 model，切换改不到真文件 ⇒ 入口整条不画。
   * 缺省（undefined）= 不可切换，旧上报方零改动。
   */
  eolSwitchable?: boolean;
}

/**
 * 两份状态读数是否等价（纯数据逐字段比；缺省与 null/'' 视为同值）。
 * `sel`/`autosavedAt` 是可选字段，上报方有时带有时不带 ⇒ 按"缺省即空"归一后再比，
 * 否则 `{...} vs {..., sel: undefined}` 这种同一读数会被判成两次变化。
 *
 * PS-6 起这条判据搬到**壳层状态读数 store** 里（见下），ProjectView 不再自己留一份。
 */
export function isSameEditorStatus(a: EditorStatusInfo | null, b: EditorStatusInfo | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.encoding === b.encoding &&
    a.eol === b.eol &&
    a.lines === b.lines &&
    (a.autosavedAt ?? null) === (b.autosavedAt ?? null) &&
    (a.sel ?? '') === (b.sel ?? '') &&
    (a.eolSwitchable ?? false) === (b.eolSwitchable ?? false)
  );
}

/* ---------------- PS-6：编辑器状态读数住在这里，不住在壳层 state 里 ---------------- */

/**
 * **编辑器状态读数的叶子 store**（PS-6 第 3 项）。
 *
 * 旧形态：`EditorPane` 每次光标移动都 `onStatusInfo` ⇒ ProjectView `setEditorStatus` ⇒
 * ProjectView 重渲 ⇒ ShellLayout 整壳重渲 ⇒ 挂在 children 里的 EditorPane 又拿到新的一次
 * 元素（三条回调里两条每次现建闭包 ⇒ 它自己也重渲）。**光标一动，全壳跟着抖**，
 * 而那格读数只是状态栏上的十几个字。
 *
 * 新形态：读数写进这个模块级 store，只有订阅它的 `.sb-editor` 小叶子重渲。
 * 内容相等（`isSameEditorStatus`）连通知都不发。
 *
 * 为什么是模块级而不是内核 store：这是**壳层私有的显示量**（与布局 localStorage 同层，
 * 见本文件头注），零业务知识、不进内核域；生命周期与 ProjectView 同步
 * （关项目时由 ProjectView 的卸载钩子清成 null，绝不让上一个文件的读数挂在状态栏上）。
 */
let editorStatusValue: EditorStatusInfo | null = null;
const editorStatusListeners = new Set<() => void>();

/** 写读数（内容没变 ⇒ 连通知都不发） */
export function setShellEditorStatus(info: EditorStatusInfo | null): void {
  if (isSameEditorStatus(editorStatusValue, info)) return;
  editorStatusValue = info;
  for (const notify of [...editorStatusListeners]) notify();
}

export function getShellEditorStatus(): EditorStatusInfo | null {
  return editorStatusValue;
}

export function subscribeShellEditorStatus(listener: () => void): () => void {
  editorStatusListeners.add(listener);
  return () => {
    editorStatusListeners.delete(listener);
  };
}

/** 只读胶囊前的锁形小图标（描边走 currentColor，随 `.sb-writable.ro` 的琥珀档变色；14px 命中区由胶囊 flex 撑到 ≥24px） */
function LockIcon(): ReactElement {
  return (
    <svg
      className="icon sb-lock"
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3.5" y="7" width="9" height="6.2" rx="1.3" />
      <path d="M5.6 7V5.1a2.4 2.4 0 0 1 4.8 0V7" />
    </svg>
  );
}

/** 状态栏 EOL 两档（与 EditorPane 的 `entry.eol` 同口径，大写） */
export type EditorEolChoice = 'LF' | 'CRLF';

/** 状态栏轻量弹层（一次只开一个；沿用 `.sb-eol-menu` 那套已有 popover 样式惯例） */
type StatusMenu =
  | null
  | 'eol'
  | 'language'
  | 'encoding'
  | 'encoding-reopen'
  | 'encoding-save'
  // B 批两格：自动换行 / 空白符显示（各自 popover，复用同一套 `.sb-eol-menu` 轻量弹层）
  | 'wordWrap'
  | 'whitespace';

/**
 * 编码菜单一项（真源 = S2 `./encoding-actions` 的 `listEncodings()`）。
 * 这里只搬 `id`（进内核显式编码入口）与 `label`（给人看）两格。
 */
export interface EncodingMenuOption {
  readonly id: string;
  readonly label: string;
}

/**
 * 编码动作端口（真身 = S2 的 `EncodingActions` + `listEncodings`）。
 *
 * 签名照 S2 交付面收口：`listEncodings()` / `reopenWithEncoding(path, enc)` /
 * `saveWithEncoding(path, enc)`。S2 的 `createEncodingActions` 是**依赖注入**形态
 * （`kernel.io` + `editorModelPool`），所以真身由本文件的 `createEncodingMenuPort`
 * 在**点击时**装配——壳层模块图不静态摸 Monaco 运行时。
 */
export interface EncodingMenuPort {
  listEncodings(): readonly EncodingMenuOption[];
  reopenWithEncoding(path: string, encoding: string): void | Promise<void>;
  saveWithEncoding(path: string, encoding: string): void | Promise<void>;
}

/** 没有宿主接线时的兜底（单测直接渲染叶子 / 宿主未传端口）：清单照读，动作明确报告而不是假装成功 */
const detachedEncodingPort: EncodingMenuPort = {
  listEncodings: () => listEncodings().map(({ id, label }) => ({ id, label })),
  reopenWithEncoding: () => {
    console.warn('[statusbar] 没有宿主编码端口，重开请求被忽略');
  },
  saveWithEncoding: () => {
    console.warn('[statusbar] 没有宿主编码端口，另存请求被忽略');
  },
};

/**
 * 壳层真身端口：清单同步（S2 的纯模块），动作点击时才拉 monaco 模型池并装配
 * `createEncodingActions({ io: kernel.io, models: editorModelPool })`。
 */
function createEncodingMenuPort(kernel: Kernel): EncodingMenuPort {
  const run = async (kind: EncodingActionKind, path: string, encoding: string): Promise<void> => {
    const { editorModelPool } = await import('./editor-model-pool-instance');
    const actions = createEncodingActions({ io: kernel.io, models: editorModelPool });
    if (kind === 'reopen') await actions.reopenWithEncoding(path, encoding as FileEncoding);
    else await actions.saveWithEncoding(path, encoding as FileEncoding);
  };
  return {
    listEncodings: () => listEncodings().map(({ id, label }) => ({ id, label })),
    reopenWithEncoding: (path, encoding) => run('reopen', path, encoding),
    saveWithEncoding: (path, encoding) => run('save', path, encoding),
  };
}

export type EncodingActionKind = 'reopen' | 'save';

/**
 * 编码动作前要不要确认（脏文档先确认的**唯一判据**，纯函数便于单测）。
 *
 * - 干净文档 ⇒ `null`（不问，直接落地）；
 * - 脏文档 + 重新打开 ⇒ 说明会丢未保存修改；
 * - 脏文档 + 按别的编码另存 ⇒ 说明可能丢字（该编码无法表示的字符会被替换）。
 */
export function encodingConfirmMessage(
  kind: EncodingActionKind,
  encoding: string,
  dirty: boolean,
): string | null {
  if (!dirty) return null;
  return kind === 'reopen'
    ? `重新以 ${encoding} 读取会丢弃当前文件的未保存修改，仍要继续？`
    : `按 ${encoding} 另存可能丢字（无法表示的字符会被替换），仍要继续？`;
}

/** 状态栏两个即时开关命令体需要的最小编辑器面（结构化：宿主传真编辑器，单测传假对象） */
export interface ToggleCommandTarget {
  getModel(): { getLineCount(): number } | null;
}

/**
 * `workbench.toggleWordWrap` 的命令体（**单源可测**：宿主命令表与快捷键都调它，不各写一份）。
 *
 * 作用于**当前焦点编辑器**：只写 `layout-pref.ts` 的真源（`saveWordWrapPref`），活编辑器由
 * `use-editor-preferences.ts` 的 `layoutUnsub` 订阅现读 `layoutPrefPatch` 补发
 * （`updateOptions`）——**同一条偏好通路**，不另开只有状态栏会走的写选项路径；后续打开的文件
 * 走 create options / `applySizeTier` 同源。没有编辑器 / 无活动文件 ⇒ 中文通知（铁律 4），不静默。
 *
 * **Alt+Z 与三档偏好的互操作**（判据在 `layout-pref.nextWordWrapToggle`，此处只说契约）：
 * 按一下在**「开 / 关」两个显式值**间翻转；`tier`（跟随档）视为「跟随体量档」，被显式切换
 * 即离开——切向由**此刻屏幕上那份文档**在档位表上的生效值（`layoutPrefPatch(lineCount).wordWrap`）
 * 决定：生效 `on` ⇒ 写 `off`，生效 `off` ⇒ 写 `on`。`tier` 这一档**不删**（它仍是"没存过键"
 * 与"跟随体量档"的既有真源，作者可在状态栏 / 设置页调回跟随档）。判据自洽、可测、可持久化。
 */
export function applyToggleWordWrap(
  target: ToggleCommandTarget | null,
  notify: (message: string) => void,
): void {
  const model = target?.getModel() ?? null;
  if (!model) {
    notify('当前没有可用的编辑器：先在编辑区点一下再切换自动换行。');
    return;
  }
  const current = loadLayoutPref().wordWrap;
  const tierEffective: 'on' | 'off' = layoutPrefPatch(model.getLineCount()).wordWrap === 'on' ? 'on' : 'off';
  saveWordWrapPref(nextWordWrapToggle(current, tierEffective));
}

/**
 * `workbench.toggleRenderWhitespace` 的命令体：切向 `none ↔ all`（细粒度档留给状态栏 /
 * 设置页五档），其余口径与 {@link applyToggleWordWrap} 逐字同款——写 `editor-display-prefs.ts`
 * 真源、活编辑器经 `displayUnsub` 补发、无编辑器给中文通知。
 */
export function applyToggleRenderWhitespace(
  target: ToggleCommandTarget | null,
  notify: (message: string) => void,
): void {
  if ((target?.getModel() ?? null) === null) {
    notify('当前没有可用的编辑器：先在编辑区点一下再切换空白符显示。');
    return;
  }
  saveEditorDisplayPrefs({
    renderWhitespace: nextRenderWhitespaceToggle(loadEditorDisplayPrefs().renderWhitespace),
  });
}

/**
 * 语言模式落地：Monaco 0.57 的公开出口只有 `editor.setModelLanguage`（`ITextModel` 没有
 * `setLanguage`）。monaco 图**动态取**——壳层与它的状态栏测试都不该静态摸 Monaco 运行时。
 */
function applyModelLanguage(
  model: Monaco.editor.ITextModel,
  languageId: string,
  onError?: (message: string) => void,
): void {
  void import('../monaco/entry')
    .then((monaco) => monaco.editor.setModelLanguage(model, languageId))
    .catch((error: unknown) => {
      if (onError) onError(`语言模式切换未完成：${errorText(error)}`);
      else console.warn('[statusbar] 语言模式切换失败：', error);
    });
}

/**
 * 状态栏右区读数（语言模式·缩进·编码·EOL·行数 ／ 选区 ／ 自动保存时刻）。
 *
 * W7-H：EOL 那一格在**可写原文面**变成按钮，点开是 LF / CRLF 两档小菜单
 * （落地由编辑器动作句柄 `switchEol` 负责：`model.pushEOL` + 前后停点 + 标脏，撤销栈上自成一段）。
 * 只读 / 预览 / 没开文件时 `eolSwitchable` 不为 true ⇒ 仍是纯文字（无入口）。
 *
 * 批次十 S1 增三格（只在有活动文件时出现）：
 * - **语言模式**：读当前 model 的 `getLanguageId()`，点开是轻量选择（语言注册面 + 四档固定项），
 *   选中即 `setModelLanguage` + 按路径持久化（`language-mode-pref.ts`），重开时由本组件恢复；
 * - **缩进**：`Tab` / `Spaces:N`，点击循环，`model.updateOptions` 生效并按路径持久化；
 * - **编码**：变成按钮，菜单「以其他编码重新打开…」「另存为…编码」，落地走 S2 的编码动作；
 *   脏文档先确认（重新读取会丢未保存修改 / 按别的编码另存可能丢字）。
 *
 * 导出是给 `packages/app/tests/status-eol-readout.test.ts` / `statusbar-controls.test.ts`
 * 直接渲染取证用；生产消费方仍只有本文件的 `statusbar` 一处。
 */
export function EditorStatusReadout({
  onSwitchEol,
  activeFile,
  dirty = false,
  encodingActions,
  confirmAction,
  onError,
}: {
  onSwitchEol?: (eol: EditorEolChoice) => void;
  /** 当前活动文件（语言 / 缩进 / 编码三格的归属路径；缺省 ⇒ 三格都不画） */
  activeFile?: string | null;
  /** 当前文件脏态（编码动作前要确认） */
  dirty?: boolean;
  /** 编码动作端口（宿主注入真身；缺省 = 只读清单的脱离端口，动作会明确告警不假装成功） */
  encodingActions?: EncodingMenuPort;
  /** 确认框（测试注入；缺省 = `window.confirm`） */
  confirmAction?: (message: string) => boolean;
  /** 失败出口（宿主 = 通知中心 toast；缺省 = console.warn，不静默） */
  onError?: (message: string) => void;
}): ReactElement | null {
  const status = useSyncExternalStore(subscribeShellEditorStatus, getShellEditorStatus, getShellEditorStatus);
  // 两格即时开关的真源投影（写值只落偏好模块，活编辑器由各自的订阅通路 updateOptions；
  // 本格订阅同一张表 ⇒ 值一变就重渲，与编辑器读数同源、不各拿一份）
  const layoutPref = useSyncExternalStore(subscribeLayoutPref, loadLayoutPref, loadLayoutPref);
  const displayPrefs = useEditorDisplayPrefs();
  const [menu, setMenu] = useState<StatusMenu>(null);
  /** 读数刷新信号（model 语言 / 选项变化、本格写入后用；值本身不参与渲染） */
  const [, refreshReadout] = useState(0);
  /** 编码清单（同步读，仅弹层打开时才取；null = 还没读到） */
  const [encodingList, setEncodingList] = useState<readonly EncodingMenuOption[] | null>(null);
  const path = activeFile ?? null;
  /** 失败出口 ref（固定身份：恢复 effect 不该因宿主每渲染换一次回调而重跑） */
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // 当前活动文件那份 model（跨组反查；没有活着的 model ⇒ undefined，读数退化到偏好 / 缺省）
  const model = path === null ? undefined : openModelAcrossGroups(path);
  const canSwitchEol = status?.eolSwitchable === true && onSwitchEol !== undefined;
  // 读数消失 / 切到不可切换面（只读、预览）⇒ EOL 菜单不许留在屏上
  useEffect(() => {
    if (!canSwitchEol && menu === 'eol') setMenu(null);
  }, [canSwitchEol, menu]);
  // 轻量 popover 的收场：点别处或 Esc 关掉（不引入新组件库；一次只开一个弹层）
  useEffect(() => {
    if (menu === null) return;
    const onPointerDown = (ev: PointerEvent): void => {
      const target = ev.target as Element | null;
      if (target && target.closest('.sb-eol-wrap')) return;
      setMenu(null);
    };
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setMenu(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menu]);
  // model 自身的语言 / 选项变化 ⇒ 读数跟上（effect 只随 model 身份重挂，不跟刷新信号，免得自激）
  useEffect(() => {
    if (!model) return;
    const subscriptions = [
      model.onDidChangeLanguage(() => refreshReadout((n) => n + 1)),
      model.onDidChangeOptions(() => refreshReadout((n) => n + 1)),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
    };
  }, [model]);
  // 重开恢复（语言）：判据与建 model 共用 `resolveModelLanguage`（覆盖 > descriptor）。
  // 无覆盖时以 model **当前**语言当描述符答案 ⇒ 目标恒等于现值、这一拍零动作——
  // 2.0 按正文路由出来的语言不会被这里拉回扩展名判据；有覆盖则强制对齐。
  useEffect(() => {
    if (path === null || !model) return;
    const desired = resolveModelLanguage(path, model.getLanguageId());
    if (desired !== model.getLanguageId()) {
      applyModelLanguage(model, desired, onErrorRef.current);
    }
  }, [path, model]);
  // 重开恢复（缩进）：只有明确存过才写 model 选项（不覆盖 Monaco / 编辑器缺省）
  useEffect(() => {
    if (path === null || !model) return;
    const saved = storedIndentChoiceFor(path);
    if (saved !== null) applyIndentPref(model as unknown as IndentTarget, saved);
  }, [path, model]);
  if (!status) return null;

  const modelLanguage = model
    ? model.getLanguageId()
    : path === null
      ? null
      : resolveModelLanguage(path, descriptorForPath(path)?.id ?? FALLBACK_LANGUAGE_ID);
  const indentText = model
    ? indentLabelFromOptions(model.getOptions())
    : path === null
      ? null
      : indentLabel(indentPrefFor(path));

  /** 失败出口：宿主有 toast 就走 toast，没有才退 console（绝不静默吞掉） */
  const reportError = (message: string, error: unknown): void => {
    const report = onErrorRef.current;
    if (report) report(`${message}${errorText(error)}`);
    else console.warn(`[statusbar] ${message}`, error);
  };

  /** 选语言：先落偏好（重开恢复的真源），再落到当前 model，最后把读数刷一次 */
  const chooseLanguage = (languageId: string): void => {
    setMenu(null);
    if (path === null) return;
    setLanguageOverride(path, languageId);
    if (model && model.getLanguageId() !== languageId) {
      applyModelLanguage(model, languageId, onErrorRef.current);
    }
    refreshReadout((n) => n + 1);
  };

  /** 点缩进格：Tab → 2 → 4 → 8 → Tab（认不出的档位按偏好当基准） */
  const cycleIndent = (): void => {
    if (path === null) return;
    const current = model
      ? indentChoiceFromOptions(model.getOptions()) ?? indentPrefFor(path)
      : indentPrefFor(path);
    const next = nextIndentChoice(current);
    setIndentPref(path, next);
    applyIndentPref(model as unknown as IndentTarget, next);
    refreshReadout((n) => n + 1);
  };

  const resolveEncodingPort = (): Promise<EncodingMenuPort> =>
    Promise.resolve(encodingActions ?? detachedEncodingPort);

  /** 打开编码清单（两类动作共用一个清单弹层） */
  const openEncodingList = (kind: 'reopen' | 'save'): void => {
    setEncodingList(null);
    setMenu(kind === 'reopen' ? 'encoding-reopen' : 'encoding-save');
    void resolveEncodingPort()
      .then((port) => setEncodingList(port.listEncodings()))
      .catch((error: unknown) => {
        reportError('编码清单读取失败：', error);
        setMenu(null);
      });
  };

  /** 选定编码：脏文档先确认，再交给编码动作落地 */
  const runEncoding = (encoding: string): void => {
    const kind: 'reopen' | 'save' = menu === 'encoding-reopen' ? 'reopen' : 'save';
    setMenu(null);
    if (path === null) return;
    const message = encodingConfirmMessage(kind, encoding, dirty);
    if (message !== null) {
      const confirm =
        confirmAction ?? ((text: string) => typeof window !== 'undefined' && window.confirm(text));
      if (!confirm(message)) return;
    }
    void resolveEncodingPort()
      .then((port) =>
        kind === 'reopen' ? port.reopenWithEncoding(path, encoding) : port.saveWithEncoding(path, encoding),
      )
      .catch((error: unknown) => {
        reportError('编码动作未完成：', error);
      });
  };

  return (
    <>
      {/* 语言模式格（S1）：只在有活动文件时出现；读数 = 当前 model 的语言 id */}
      {path !== null && modelLanguage !== null ? (
        <span className="sb-editor sb-lang" data-status-cell="">
          <span className="sb-eol-wrap">
            <button
              type="button"
              className="sb-eol"
              data-status-cell=""
              aria-haspopup="menu"
              aria-expanded={menu === 'language'}
              title={`当前语言模式：${modelLanguage}（点击切换）`}
              onClick={() => setMenu(menu === 'language' ? null : 'language')}
            >
              {modelLanguage}
            </button>
            {menu === 'language' ? (
              <span className="sb-eol-menu" role="menu" aria-label="语言模式">
                {languageModeChoices(languageDescriptors().map((descriptor) => descriptor.id)).map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={modelLanguage === id}
                    className={`sb-eol-item${modelLanguage === id ? ' on' : ''}`}
                    onClick={() => chooseLanguage(id)}
                  >
                    {id}
                  </button>
                ))}
              </span>
            ) : null}
          </span>
        </span>
      ) : null}
      {/* 缩进格（S1）：点击循环 Tab / 2 / 4 / 8 */}
      {indentText !== null ? (
        <button
          type="button"
          className="sb-eol sb-indent"
          data-status-cell=""
          title="缩进：点击在 Tab / 2 / 4 / 8 间切换"
          onClick={cycleIndent}
        >
          {indentText}
        </button>
      ) : null}
      <span className="sb-editor" data-status-cell="">
        {path !== null ? (
          <span className="sb-eol-wrap">
            <button
              type="button"
              className="sb-eol"
              data-status-cell=""
              aria-haspopup="menu"
              aria-expanded={menu === 'encoding' || menu === 'encoding-reopen' || menu === 'encoding-save'}
              title={`当前编码：${status.encoding}（点击转换编码）`}
              onClick={() => setMenu(menu === 'encoding' ? null : 'encoding')}
            >
              {status.encoding}
            </button>
            {menu === 'encoding' ? (
              <span className="sb-eol-menu" role="menu" aria-label="编码">
                <button type="button" role="menuitem" className="sb-eol-item" onClick={() => openEncodingList('reopen')}>
                  以其他编码重新打开…
                </button>
                <button type="button" role="menuitem" className="sb-eol-item" onClick={() => openEncodingList('save')}>
                  另存为…编码
                </button>
              </span>
            ) : null}
            {menu === 'encoding-reopen' || menu === 'encoding-save' ? (
              <span className="sb-eol-menu" role="menu" aria-label="选择编码">
                {encodingList === null ? (
                  <span className="sb-eol-note">读取编码清单…</span>
                ) : encodingList.length === 0 ? (
                  <span className="sb-eol-note">没有可用编码</span>
                ) : (
                  encodingList.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="menuitem"
                      className={`sb-eol-item${option.id === status.encoding ? ' on' : ''}`}
                      title={option.id}
                      onClick={() => runEncoding(option.id)}
                    >
                      {option.label}
                    </button>
                  ))
                )}
              </span>
            ) : null}
          </span>
        ) : (
          status.encoding
        )}{' '}
        ·{' '}
        {canSwitchEol ? (
          <span className="sb-eol-wrap">
            <button
              type="button"
              className="sb-eol"
              data-status-cell=""
              aria-haspopup="menu"
              aria-expanded={menu === 'eol'}
              title={`当前换行符：${status.eol}（点击切换 LF / CRLF）`}
              onClick={() => setMenu(menu === 'eol' ? null : 'eol')}
            >
              {status.eol}
            </button>
            {menu === 'eol' ? (
              <span className="sb-eol-menu" role="menu" aria-label="换行符">
                {(['LF', 'CRLF'] as const).map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    role="menuitemradio"
                    aria-checked={status.eol === choice}
                    className={`sb-eol-item${status.eol === choice ? ' on' : ''}`}
                    onClick={() => {
                      setMenu(null);
                      // 已是目标档：只收菜单，不制造一次无意义的脏
                      if (status.eol !== choice) onSwitchEol?.(choice);
                    }}
                  >
                    {choice}
                  </button>
                ))}
              </span>
            ) : null}
          </span>
        ) : (
          status.eol
        )}{' '}
        · {status.lines} 行
      </span>
      {/* 自动换行格（B 批）：展示并切换 `layout-pref` 三档（跟随档 / 开 / 关）。
          写值 = 偏好真源，活编辑器与后续打开的文件都走同一条订阅通路即时生效；
          无活动文件时整格不渲染（与相邻三格同一判据）。 */}
      {path !== null ? (
        <span className="sb-eol-wrap">
          <button
            type="button"
            className="sb-eol sb-wordwrap"
            data-status-cell=""
            aria-haspopup="menu"
            aria-expanded={menu === 'wordWrap'}
            title={`自动换行：${WORD_WRAP_LABELS[layoutPref.wordWrap]}（点击切换）`}
            onClick={() => setMenu(menu === 'wordWrap' ? null : 'wordWrap')}
          >
            {WORD_WRAP_LABELS[layoutPref.wordWrap]}
          </button>
          {menu === 'wordWrap' ? (
            <span className="sb-eol-menu" role="menu" aria-label="自动换行">
              {WORD_WRAP_CHOICES.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  role="menuitemradio"
                  aria-checked={layoutPref.wordWrap === choice}
                  className={`sb-eol-item${layoutPref.wordWrap === choice ? ' on' : ''}`}
                  onClick={() => {
                    setMenu(null);
                    if (layoutPref.wordWrap !== choice) saveWordWrapPref(choice);
                  }}
                >
                  {WORD_WRAP_LABELS[choice]}
                </button>
              ))}
            </span>
          ) : null}
        </span>
      ) : null}
      {/* 空白符显示格（B 批）：展示并切换 `editor-display-prefs` 的五档（Monaco 登记值，
          标签只做中文展示、落 Monaco 前零翻译）；写值即真源、订阅通路即时生效，
          无活动文件时整格不渲染。 */}
      {path !== null ? (
        <span className="sb-eol-wrap">
          <button
            type="button"
            className="sb-eol sb-whitespace"
            data-status-cell=""
            aria-haspopup="menu"
            aria-expanded={menu === 'whitespace'}
            title={`空白符显示：${RENDER_WHITESPACE_LABELS[displayPrefs.renderWhitespace]}（点击切换）`}
            onClick={() => setMenu(menu === 'whitespace' ? null : 'whitespace')}
          >
            {RENDER_WHITESPACE_LABELS[displayPrefs.renderWhitespace]}
          </button>
          {menu === 'whitespace' ? (
            <span className="sb-eol-menu" role="menu" aria-label="空白符显示">
              {RENDER_WHITESPACE_CHOICES.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  role="menuitemradio"
                  aria-checked={displayPrefs.renderWhitespace === choice}
                  className={`sb-eol-item${displayPrefs.renderWhitespace === choice ? ' on' : ''}`}
                  onClick={() => {
                    setMenu(null);
                    if (displayPrefs.renderWhitespace !== choice) {
                      saveEditorDisplayPrefs({ renderWhitespace: choice });
                    }
                  }}
                >
                  {RENDER_WHITESPACE_LABELS[choice]}
                </button>
              ))}
            </span>
          ) : null}
        </span>
      ) : null}
      {status.sel ? (
        <span className="sb-sel" data-status-cell="">
          {status.sel}
        </span>
      ) : null}
      {/* 自动保存轻指示（A6）：同一条 onStatusInfo 链路带出的读数，不做第二个协议 */}
      {status.autosavedAt != null ? (
        <span
          className="sb-editor"
          data-status-cell=""
          title={`自动保存于 ${new Date(status.autosavedAt).toLocaleTimeString()}`}
        >
          自动保存 {new Date(status.autosavedAt).toLocaleTimeString()}
        </span>
      ) : null}
    </>
  );
}


/**
 * 壳层工作台 API（P3：编辑器区空态动作按钮用——壳层持有 picker/命令注册表，
 * 空态在 children 里，需反向取得触发入口）。
 */
export interface WorkbenchApi {
  openQuickOpen: () => void;
  openPalette: () => void;
  hasCommand: (id: string) => boolean;
  /** 执行命令（when 不满足 / 不存在 → false；抛错隔离记日志） */
  runCommand: (id: string) => boolean;
}

interface Props {
  kernel: Kernel;
  /** 壳层内建视图（与槽同构的贡献形态；如口上文件树 → group:'explorer'） */
  builtinViews: UIPanelContribution[];
  /** 编辑器区内容（只读横幅 + 编辑器/空态） */
  children: ReactNode;
  /**
   * 写权限状态（P0 项目级授权口径）。
   *
   * 状态栏那颗胶囊现在**先看当前打开文件落在哪一区**（工作项目区 / 口上区），
   * 区域答不出的时候（没有打开文件、或区域外的非 ERB）才回落到这个布尔。
   */
  writable: boolean;
  /** 当前活动文件（状态栏可写胶囊的区域依据；判定与编辑器共用 `file-area.ts` 一把尺子） */
  activeFile?: string | null;
  onReauth: () => void;
  /** 当前文件脏态（状态栏保存态指示） */
  dirty: boolean;
  /**
   * 状态栏 EOL 读数切档的落地入口（W7-H）。缺省 = 读数不可点；
   * EditorPane 上报 `eolSwitchable: true` 时才画入口。
   */
  onSwitchEol?: (eol: EditorEolChoice) => void;
  /** 索引状态（状态栏左区） */
  stats: { fileCount: number; fnCount: number; indexing: boolean; indexError: string | null };
  /** 命令执行上下文（ui.toolbar / 命令面板消费） */
  commandCtx: EditorCommandContext;
  /** 关闭项目入口（工具栏右区；欢迎页回退） */
  onCloseProject?: () => void;
  /** 重载项目入口（工具栏左区，项目标签旁） */
  onReloadProject?: () => void;
  /** 快速打开候选文件（P2；壳层泛型路径列表，零业务知识） */
  quickOpenFiles?: readonly string[];
  /**
   * 快速打开「最近打开」一节（1020 编辑器体感批）：路径清单，最新在前。
   * 空查询时置顶成一节；不在 `quickOpenFiles` 里的条目（别的项目的）自然被跳过。
   */
  quickOpenRecent?: readonly string[];
  /**
   * `Ctrl+P` 里 `@` 模式的符号来源（编辑器区注入）。
   * 壳层不认识"符号从哪来"——它只把这个函数交给面板；真源是编辑器的位点探针
   * （与大纲 / 吸顶 / 面包屑同一棵树），见 `ProjectView` 那侧的接线。
   */
  activeFileSymbols?: () => ActiveFileSymbolSource | null;
  /** 快速打开选中回调 */
  onOpenFile?: (path: string) => void;
  /** 编辑器区注入的壳层命令（P3：关闭标签 / 全部保存；与内建布局命令合并进统一注册表） */
  extraCommands?: readonly ShellCommandSpec[];
  /** 工作台 API 注册（P3：编辑器区空态动作按钮反向取得 picker/命令入口；卸载时 null） */
  onRegisterWorkbench?: (api: WorkbenchApi | null) => void;
  /**
   * 内建视图的**宿主版本闸**（PS-6 正确性修复）：`面板 id → 计数`。
   *
   * 这些面板由宿主用可变 ref 桥 props（组件身份必须恒定，否则整棵树每次重挂），
   * `PanelBody` 的 memo 三条比较项对它们恒相等 ⇒ 桥里换了新 index / activeFile / 失效信号
   * 也送不进去。宿主每次改桥就抬一次对应那格的数，壳层原样转给 `PanelBody.hostVersion`。
   *
   * 表里没有的面板（插件面板）拿 `undefined` ⇒ 比较按 0 走，行为与改动前逐字一致。
   */
  panelHostVersions?: Readonly<Record<string, number>>;
  /**
   * 当前项目所属的游戏 id（`GameProject.adapterId`；2026-10-20 游戏域面板闸）。
   *
   * 壳层拿它跟 `game.adapter` 槽的贡献方插件 id 对表，**只编排本游戏 adapter 的面板**：
   * 两个 adapter 各贡献一枚「我的口上项目」（同图标同标题），并装时活动栏会出现两枚
   * 一模一样的「工作区」图标，而另一游戏的面板在本项目上落点不同（部署会把口上文件
   * 铺错层）。判据是 id 相等、不是游戏名——壳层仍零游戏知识。
   *
   * 缺省 / null（无项目、旧消费方）不过闸，编排结果与改动前逐字一致。
   */
  activeAdapterId?: string | null;
}

/** 视图在活动栏的位置：组成员全为低频（defaultActive:false）→ 底部区（定稿 §四插件状态齿轮位） */
function isLowFreqView(v: ViewDef): boolean {
  return v.panels.every((p) => p.defaultActive === false);
}

/** 进入编辑器后静默检查更新的延迟（用户反馈第 1 条：3 秒，够首屏与索引喘口气） */
const AUTO_UPDATE_CHECK_DELAY_MS = 3000;

/**
 * 本次应用会话里作者亲手关掉的更新版本（模块级，活得比一次项目开关更久）：
 * 自动检查不再为同一版重开弹窗；手动检查是明确意图，发现就重开（并把这里清掉）。
 * 不落 localStorage——重启应用时愿意再提醒一次是合理的。
 */
let dismissedUpdateVersionInSession: string | null = null;

export function ShellLayout(props: Props): ReactElement {
  const {
    kernel,
    builtinViews,
    children,
    writable,
    activeFile,
    onReauth,
    dirty,
    onSwitchEol,
    stats,
    commandCtx,
    onCloseProject,
    onReloadProject,
    quickOpenFiles,
    quickOpenRecent,
    activeFileSymbols,
    onOpenFile,
    extraCommands,
    onRegisterWorkbench,
    panelHostVersions,
    activeAdapterId = null,
  } = props;

  /** 封存总闸（`sealed.ts`；默认封存）：封存态下 `SEALED_PANEL_IDS` 清单里的插件面板整只不进编排 */
  const sealed = useSealed();
  /** 直连模式开关（`direct-mode.ts`；默认关）：设置页里经封存总闸 gated——封存态不渲染 */
  const directMode = useDirectMode();
  /**
   * 面板 UI 偏好：长列表视口化（`panel-prefs.ts`；默认关）。
   *
   * 真源是壳层私有的 localStorage 偏好 + 订阅；这里只持有投影并**即时下传**给面板。
   * `usePanelVirtualize` 走 `useSyncExternalStore`，设置页一翻开关即重渲染本壳层 ⇒
   * 下面 `uiPrefs` 重算 ⇒ 面板以新偏好重渲染（无需重开设置页）。
   */
  const panelVirtualize = usePanelVirtualize();
  /**
   * 2.0 面投影（K2-EDITOR-OPEN-PATHS）：开关打开时把「扩展名」这一格下传给面板/浮层，
   * 新建向导据此**追加**一个 2.0 文件选项（扩展名由宿主给，插件侧零字面量）。
   * 开关关着 ⇒ `undefined`，`uiPrefs` 的形状与改动前逐字相同。
   */
  const kojo2Surface = useKojo2Surface();
  /** 下传给面板的偏好投影（对象身份随开关稳定，开关不变则面板不因它白重渲染） */
  const uiPrefs = useMemo(
    () => ({ panelVirtualize, ...(kojo2Surface ? { kojo2: kojo2Surface } : {}) }),
    [panelVirtualize, kojo2Surface],
  );
  const allPanels = useMemo(() => {
    // 游戏域面板闸：`game.adapter` 槽现取「贡献方插件 id → 游戏 id」映射，
    // 只编排本游戏 adapter 的面板（否则活动栏出现两枚同图标的「工作区」）
    const scoped = filterGameScopedPanels(
      [...builtinViews, ...kernel.slots.query('ui.panel')],
      gameScopeByPlugin(kernel.slots.query('game.adapter')),
      activeAdapterId,
    );
    return filterSealedPanels(scoped, sealed);
  }, [kernel, builtinViews, sealed, activeAdapterId]);
  const toolbarItems = useMemo(() => kernel.slots.query('ui.toolbar'), [kernel]);
  const statusbarItems = useMemo(() => kernel.slots.query('ui.statusbar'), [kernel]);
  /** 状态栏编码格的落地端口（S2 显式编码读写的真身装配；动作在点击时才拉 monaco 模型池） */
  const statusEncodingActions = useMemo(() => createEncodingMenuPort(kernel), [kernel]);
  const slotCommands = useMemo(() => kernel.slots.query('editor.command'), [kernel]);
  const overlayItems = useMemo(() => kernel.slots.query('ui.overlay'), [kernel]);

  const [layout, dispatch] = useReducer(reducer, undefined as unknown as LayoutState, () =>
    reconcileLayout(loadLayout(), organizePanels(allPanels, {})),
  );
  // 渲染用的编排排除已浮动的面板（它们不在三容器里重复显示）
  const dockedPanels = useMemo(
    () => allPanels.filter((p) => layout.floating[p.id] === undefined),
    [allPanels, layout.floating],
  );
  const org: OrganizedPanels = useMemo(
    () => organizePanels(dockedPanels, layout.panelLocations),
    [dockedPanels, layout.panelLocations],
  );

  // 清洗总闸的再清洗必须基于全体面板（含浮动的），否则浮动 id 会被误清洗掉
  const fullOrg = useMemo(
    () => organizePanels(allPanels, layout.panelLocations),
    [allPanels, layout.panelLocations],
  );
  const fullOrgRef = useRef(fullOrg);
  fullOrgRef.current = fullOrg;
  // 总闸切换 / 换项目（游戏域面板闸换了一批可见面板）后面板集合增删，active/override
  // 可能失效——重跑一次清洗器（首跑跳过，挂载时已清洗过）
  const panelSetSkipFirstRef = useRef(true);
  useEffect(() => {
    if (panelSetSkipFirstRef.current) {
      panelSetSkipFirstRef.current = false;
      return;
    }
    dispatch({ type: 'reconcile', org: fullOrgRef.current });
  }, [sealed, activeAdapterId]);

  // 持久化（壳层私事，localStorage；变更即存，体量小无需去抖）
  useEffect(() => saveLayout(layout), [layout]);

  // zen / overlay / picker 的 ref 供全局键盘读取最新值（Esc 优先级链）
  const zenRef = useRef(layout.zen);
  zenRef.current = layout.zen;

  /* -------------------- P2：命令注册表 + picker/overlay 状态 -------------------- */

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  /** 工作区符号面板（D2 · Ctrl+T）：与上面两个 picker 同一层 Esc 优先级 */
  const [symbolsOpen, setSymbolsOpen] = useState(false);
  const [activeOverlay, setActiveOverlay] = useState<{ id: string; payload?: unknown } | null>(null);
  const overlayRef = useRef(activeOverlay);
  overlayRef.current = activeOverlay;
  /**
   * 浮层退场（视觉批十四）：关闭时先把面板挂 200ms 的 `.ov-exiting` 动画再卸。
   * CSS `overlay-out` 从批次十一就备着，缺的一直是"挂类"这一步——真机读数是入场
   * 320ms 弹簧、退场 0ms，关起来像被掐断。只记 id，贡献对象仍从插槽现查（槽换版本时
   * 退场那一帧也读得到最新那份）。
   */
  const [exitingOverlayId, setExitingOverlayId] = useState<string | null>(null);
  const overlayExitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissOverlay = useCallback(() => {
    const cur = overlayRef.current;
    if (cur === null) return;
    setActiveOverlay(null);
    setExitingOverlayId(cur.id);
    if (overlayExitTimer.current !== null) clearTimeout(overlayExitTimer.current);
    overlayExitTimer.current = setTimeout(() => setExitingOverlayId(null), 200);
  }, []);
  useEffect(
    () => () => {
      if (overlayExitTimer.current !== null) clearTimeout(overlayExitTimer.current);
    },
    [],
  );
  const pickerRef = useRef(false);
  pickerRef.current = paletteOpen || quickOpen || symbolsOpen;
  /**
   * 项目名旁「更多」菜单的锚点（C-1a 工具栏分组批）：null = 关。
   * 「关闭项目」是破坏性动作，从右侧视图开关那一排收拢到这里（菜单项 danger 危险色），
   * 菜单本体走共享 `<ContextMenu>`（Esc/外点关闭与焦点归还它自己做，这里只记打开位置）。
   */
  const [projectMenuAt, setProjectMenuAt] = useState<{ x: number; y: number } | null>(null);
  // 设置 overlay（P4；壳层私有——设置项全是容器语义，不经 ui.overlay 槽）
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 设置浮层也要退场（视觉批十五）：与 `ui.overlay` 族同一个 200ms 时机，别一半有一半没有 */
  const settingsPresence = useOverlayPresence(settingsOpen);
  // 打开设置时定位到哪一节：「打开设置」恒回 general（不记住上次在哪节），
  // 「打开键盘快捷键」直达快捷键节。SettingsPanel 每次开浮层都重新挂载 ⇒ 该值即初始选中节。
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('general');
  const settingsRef = useRef(settingsOpen);
  settingsRef.current = settingsOpen;
  /**
   * 语法糖视图开关（设置页里的那一项）。
   *
   * 状态所有者是**编辑器**（`EditorPane` 持有 + 落 localStorage）；这里只做
   * "开面板时读一次当前值 + 改动时写偏好并发意图事件"——避免同一个开关有两个真源。
   */
  const [sugarViewOn, setSugarViewOn] = useState(() => loadSugarViewPref());
  useEffect(() => {
    if (settingsOpen) setSugarViewOn(loadSugarViewPref());
  }, [settingsOpen]);
  const applySugarViewPref = useCallback(
    (on: boolean) => {
      saveSugarViewPref(on);
      setSugarViewOn(on);
      kernel.bus.emit('editor.sugarView.set', { on });
    },
    [kernel],
  );

  /**
   * 减弱动效开关（UI-5；设置页里的那一项）。
   *
   * 真源是 `motion-pref.ts` 的 localStorage 偏好 + `<html data-motion>` 属性，
   * 这里只持有会话内的镜像值供开关渲染。挂载时按存下的偏好同步一次属性——
   * 否则「上次选了减弱动效」要到用户再打开设置页才生效。
   */
  const [motionPref, setMotionPref] = useState<MotionPref>(() => loadMotionPref());
  useEffect(() => {
    applyMotionPref(loadMotionPref());
  }, []);
  const commitMotionPref = useCallback((p: MotionPref) => {
    saveMotionPref(p);
    setMotionPref(p);
    applyMotionPref(p);
  }, []);

  /**
   * 毛玻璃透明度（2026-10-17 教程打磨批；设置页「外观」里的那一项）。
   *
   * 与「减弱动效」同款分层：真源是 `glass-pref.ts` 的 localStorage，生效是把值写到根元素
   * （`--glass-alpha` + `data-glass`），样式表读取。这里只拿投影 + 一个 effect 落地——
   * 挂载时按存下的偏好同步一次（否则上次调的透明度要重开设置页才生效），旋钮改值时
   * `glassTransparency` 变 ⇒ effect 重跑 ⇒ 全场磨砂面即时联动，不用重开浮层。
   */
  const glassTransparency = useGlassTransparencyPref();
  useEffect(() => {
    applyGlassPref(glassTransparency);
  }, [glassTransparency]);

  /**
   * 主题（2026-10-17 主题系统；设置页「外观」里的那一项）。
   *
   * 与「减弱动效 / 毛玻璃」同款分层：真源是 `theme-pref.ts` 的 localStorage，生效是把值写到
   * 根元素 `data-theme`，由 `themes/*.css` 读取。index.html 早期内联脚本已在首屏前设过一次
   * （免闪深色）；这里挂载时按存下的偏好再断言一次并订阅——设置页一翻，全场 token 立即重算。
   */
  const themePref = useThemePref();
  useEffect(() => {
    applyThemePref(themePref);
  }, [themePref]);

  /**
   * 保存时整理空白开关（E2；设置页里的那一项，默认关）。
   *
   * 与上面两个开关的分工差别值得说一句：**这里不推事件、也不持业务状态**——
   * 保存链路（`EditorPane.savePath`）落盘前自己 `loadFormatOnSavePref()` 现读，
   * 所以刚翻的开关立刻生效且不可能读到旧镜像。本组件只留一个渲染用的镜像值，
   * 并在设置面板打开时重读一次（别的窗口/会话写过也能反映）。
   */
  const [formatOnSave, setFormatOnSave] = useState<boolean>(() => loadFormatOnSavePref());
  useEffect(() => {
    if (settingsOpen) setFormatOnSave(loadFormatOnSavePref());
  }, [settingsOpen]);
  const commitFormatOnSave = useCallback((on: boolean) => {
    saveFormatOnSavePref(on);
    setFormatOnSave(on);
  }, []);

  /**
   * 「标注函数被谁调用」开关（B8，2026-10-16 行内注解批；默认关）。
   *
   * 与上面「保存时整理空白」的差别值得一句：那条挂在**保存那一刻**上，链路自己现读偏好
   * 就够；这条改的是**编辑器选项**，翻完必须让 Monaco 重算一次才当场见效 ⇒ 除了写值还要
   * 发一条 `editor.codeLens.set`（落地在 `EditorPane`，状态所有者仍是编辑器）。
   * 真源仍然只有一份 localStorage：本组件只持渲染用的镜像，并在设置页打开时重读一次。
   */
  const [codeLensOn, setCodeLensOn] = useState<boolean>(() => loadCodeLensPref());
  useEffect(() => {
    if (settingsOpen) setCodeLensOn(loadCodeLensPref());
  }, [settingsOpen]);
  const commitCodeLens = useCallback(
    (on: boolean) => {
      saveCodeLensPref(on);
      setCodeLensOn(on);
      kernel.bus.emit('editor.codeLens.set', { on });
    },
    [kernel],
  );

  /**
   * 「定义与调用的名字分色」开关（B6，2026-10-16 结构化着色批；设置页里的那一项，默认关）。
   *
   * 真源是 `semantic-color-pref.ts` 的 localStorage + 订阅表，这里只拿投影；
   * 写下去的瞬间 `EditorPane` 那位订阅者会把新值推给 Monaco 的配置项，
   * **不需要重开文件**（与 `useDirectMode` 同一条通路，只是订阅方是编辑器而不是壳层）。
   */
  const nameColorOn = useNameColorPref();

  /**
   * 「补全弹出延迟」读数（SUGGEST-2B，2026-10-18；设置页里的那一项，默认 0 = 立刻弹）。
   *
   * 真源是 `suggest-pref.ts` 的 localStorage + 订阅表，这里只拿投影；写下去的下一刻，
   * `EditorPane` 里观察者的 `getDebounceMs` 现读就会拿到新值 ⇒ **改完下一次击键即生效**。
   */
  const suggestDelay = useSuggestDelayPref();
  const commitSuggestDelay = useCallback((ms: number) => {
    saveSuggestDelayPref(ms);
  }, []);

  // 补全两个总开关（QSUG-2）：默认都开；写下去后 EditorPane 的订阅 / 词源的下一次读取
  // 各自现取，不重开文件。设置页只拿投影。
  const quickSuggestionsOn = useQuickSuggestionsPref();
  const commitQuickSuggestions = useCallback((on: boolean) => {
    saveQuickSuggestionsPref(on);
  }, []);
  const wordSuggestionsOn = useWordBasedSuggestionsPref();
  const commitWordSuggestions = useCallback((on: boolean) => {
    saveWordBasedSuggestionsPref(on);
  }, []);

  // 字号/缩放读数（A1）：真源在 font-size-pref 的 localStorage，这里只拿投影
  const fontSize = useFontSizePref();
  const fontZoom = useFontZoomPref();
  // 自动保存读数（A6）：真源在 autosave-pref 的 localStorage，这里只拿投影
  const autosaveMode = useAutosavePref();

  /**
   * 注册表来源（KM-9 设置页那一行）。
   *
   * 真源在 `market` 服务里（= `kojo-market` 的 `ctx.storage` 域）：面板取数、拉取、这一行
   * 读写的都是同一个 `endpoint()` ⇒ 壳不抄第二份（localStorage 那套偏好只管壳自己的渲染）。
   * **这一组只有一个 URL 输入框**：代理不是产品前提，也不许从 JS 递进下载命令（SSRF），
   * 所以既没有代理输入框也没有代理开关——见 `market-source.ts` 顶部说明。
   */
  const [marketSource, setMarketSource] = useState<MarketSourceView | null>(null);
  const [marketEndpointDraft, setMarketEndpointDraft] = useState('');
  useEffect(() => {
    if (!settingsOpen) return;
    const svc = kernel.services.tryGet<MarketService>(MARKET_SERVICE_KEY);
    if (svc === undefined) {
      setMarketSource(NO_SERVICE_VIEW);
      setMarketEndpointDraft('');
      return;
    }
    let cancelled = false;
    void svc
      .endpoint()
      .then((effective) => {
        if (cancelled) return;
        setMarketSource({ effective, overridden: isOverridden(effective), note: '' });
        // 输入框预填**覆盖值**；用默认时留空（空 = "跟默认"，不是"存一个空地址"）
        setMarketEndpointDraft(isOverridden(effective) ? effective : '');
      })
      .catch(() => {
        if (!cancelled) setMarketSource({ effective: '', overridden: false, note: '注册表地址读不出来' });
      });
    return () => {
      cancelled = true;
    };
  }, [settingsOpen, kernel]);
  const saveMarketEndpoint = useCallback(async (): Promise<void> => {
    const svc = kernel.services.tryGet<MarketService>(MARKET_SERVICE_KEY);
    if (svc === undefined) {
      setMarketSource(NO_SERVICE_VIEW);
      return;
    }
    setMarketSource(await applyEndpointEdit(svc, marketEndpointDraft));
  }, [kernel, marketEndpointDraft]);
  // 设置页「恢复默认」：走既有 reset 通路回到默认地址（与保存同一只服务、同一条链路）
  const resetMarketEndpoint = useCallback(async (): Promise<void> => {
    const next = await resetEndpoint(kernel.services.tryGet<MarketService>(MARKET_SERVICE_KEY));
    setMarketSource(next);
    // 回到默认后草稿框重新按既有约定预填：用默认 ⇒ 空框
    setMarketEndpointDraft(next.overridden ? next.effective : '');
  }, [kernel]);

  /**
   * 检查更新（REL-1 收尾 · REL-2 设置页 · 用户反馈第 1 条）：状态机在 `update-check.ts`
   * （零 React，可单测），这里只持有会话内镜像 + 调宿主 API。版本号走 `getVersion()`
   * （core:default 已放行）；非 Tauri 环境（纯浏览器 dev / node 测试）读不到就保持 null。
   *
   * 本批新增的是**入口**与**呈现**：进入编辑器 3 秒后静默检查一次（只查一次，失败/已最新
   * 都不弹任何东西），发现新版本才自动打开 `UpdateDialog`；设置页继续用手动检查/安装，
   * 两条入口共享同一份 phase 与同一个 installUpdate。
   */
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>({ kind: 'idle' });
  const updateFoundRef = useRef<Update | null>(null);
  // 给「3 秒后还要不要查」与关闭弹窗读最新 phase：这两个回调刻意不依赖 state，
  // 避免 getVersion / phase 变化把自动检查的 timer 反复重置。
  const updatePhaseRef = useRef(updatePhase);
  updatePhaseRef.current = updatePhase;
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  /** 并发检查的序号：后发起的那次说了算，先前的结果连 Update 资源一起作废 */
  const updateCheckSeqRef = useRef(0);
  /** 下载安装进行中：卸载清理别把正在安装的 Update 资源关掉 */
  const updateInstallingRef = useRef(false);
  /** 自动检查只跑一次（timer 真触发后才置位；StrictMode 的 cleanup 重排不会把它吞掉） */
  const autoUpdateCheckFiredRef = useRef(false);
  /** 组件还活着：关项目时仍在路上的 check() 回来要还资源，而不是往已卸载的树里塞状态 */
  const updateAliveRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    getVersion()
      .then((v) => {
        if (!cancelled) setAppVersion(v);
      })
      .catch(() => {
        /* 非 Tauri 环境：保持「未知」 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 常驻状态行（found 态回 null——它另有带安装按钮的专属行）
  const updateStatusLine = updateStatus(updatePhase);

  /**
   * 释放手上那条 Update 的宿主资源（updater 的 `Update` 是 Rust Resource）。
   * 只在"确定不会再安装它"时调用：换一次检查、或组件卸载且没在安装。
   */
  const releaseFoundUpdate = useCallback(() => {
    const found = updateFoundRef.current;
    updateFoundRef.current = null;
    if (found !== null) {
      void found.close().catch(() => {
        /* 释放失败不影响用户：宿主进程退出时也会回收 */
      });
    }
  }, []);

  /**
   * 真去查一次（auto = 进编辑器的静默检查；manual = 设置页那颗按钮）。
   *
   * `origin` 只决定"发现新版本时弹窗开不开"：自动检查尊重作者关过的同一版本；
   * 手动检查是明确意图，发现就重开。**检查失败一律只落状态**，绝不弹窗（私仓端点 404 是常态）。
   */
  const performUpdateCheck = useCallback(
    async (origin: 'auto' | 'manual'): Promise<void> => {
      const seq = updateCheckSeqRef.current + 1;
      updateCheckSeqRef.current = seq;
      releaseFoundUpdate();
      setUpdatePhase((p) => reduceUpdatePhase(p, { type: 'checkStart' }));
      try {
        // 更新检查跟随环境代理（REL-1 收尾）：Rust 侧读标准环境变量（HTTPS > HTTP > ALL，
        // 畸形值忽略），有的话透传进 check({ proxy })；取不到（含非 Tauri 环境）= None，
        // check() 与不传参时一字不差。取代理失败也按 None 走，绝不因它让检查失败。
        const envProxy = await invoke<string | null>('updater_env_proxy').catch(() => null);
        const found = await check(envProxy === null ? undefined : { proxy: envProxy });
        if (!updateAliveRef.current) {
          // 关项目时这次 check 才回来：树已卸载，别把 Update 的宿主资源留在那儿
          if (found !== null) void found.close().catch(() => {});
          return;
        }
        if (seq !== updateCheckSeqRef.current) {
          // 后发起的检查已经接管：这次结果作废，别把旧 Update 的宿主资源留在那儿
          if (found !== null) void found.close().catch(() => {});
          return;
        }
        if (found === null) {
          setUpdatePhase((p) => reduceUpdatePhase(p, { type: 'checkLatest' }));
          return;
        }
        const currentVersion = found.currentVersion.trim() === '' ? undefined : found.currentVersion;
        const action: UpdateAction = {
          type: 'checkFound',
          version: found.version,
          ...(currentVersion === undefined ? {} : { currentVersion }),
          ...(found.body === undefined ? {} : { notes: found.body }),
          ...(found.date === undefined ? {} : { date: found.date }),
        };
        // 先用"检查中"这一态试算：只有真落到 found 才保留 Update 资源并弹窗；
        // latest / 版本形读不出都是这次检查的结局，资源当场还掉。
        if (reduceUpdatePhase({ kind: 'checking' }, action).kind !== 'found') {
          void found.close().catch(() => {});
          setUpdatePhase((p) => reduceUpdatePhase(p, action));
          return;
        }
        updateFoundRef.current = found;
        setUpdatePhase((p) => reduceUpdatePhase(p, action));
        if (origin === 'manual') {
          dismissedUpdateVersionInSession = null;
          setUpdateDialogOpen(true);
        } else if (dismissedUpdateVersionInSession !== found.version) {
          setUpdateDialogOpen(true);
        }
      } catch {
        // 私仓尚未发布 release：端点现阶段必然 404，失败是常态路径——必须可见、可重试，绝不抛未捕获异常
        if (!updateAliveRef.current || seq !== updateCheckSeqRef.current) return;
        releaseFoundUpdate();
        setUpdatePhase((p) => reduceUpdatePhase(p, { type: 'checkFailed' }));
      }
    },
    [releaseFoundUpdate],
  );

  /** 设置页的手动检查入口（Public 面保持无参：SettingsPanel 直接把它当 onClick） */
  const runUpdateCheck = useCallback(
    () => performUpdateCheck('manual'),
    [performUpdateCheck],
  );

  /**
   * 进入编辑器 3 秒后静默检查一次——只在 Tauri 壳里跑（浏览器 dev 跳过），
   * 卸载清 timer。依赖只有稳定的 `performUpdateCheck`，不随渲染重置。
   * 3 秒内作者若已手动检查/安装（phase 不再是 idle），这次自动检查让位，不叠加请求。
   */
  useEffect(() => {
    if (!isTauri() || autoUpdateCheckFiredRef.current) return;
    const timer = window.setTimeout(() => {
      autoUpdateCheckFiredRef.current = true;
      if (updatePhaseRef.current.kind !== 'idle') return;
      void performUpdateCheck('auto');
    }, AUTO_UPDATE_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [performUpdateCheck]);

  // 卸载（关项目）时把没在安装的那条 Update 还给宿主；下载中不关，免得把安装打断
  useEffect(() => {
    updateAliveRef.current = true;
    return () => {
      updateAliveRef.current = false;
      const found = updateFoundRef.current;
      updateFoundRef.current = null;
      if (found !== null && !updateInstallingRef.current) {
        void found.close().catch(() => {});
      }
    };
  }, []);

  const installUpdate = useCallback(async () => {
    const found = updateFoundRef.current;
    if (found === null || updateInstallingRef.current) return;
    // 设置页「下载并安装」与本弹窗是同一个入口：从设置页点，也把进度抬进弹窗
    setUpdateDialogOpen(true);
    updateInstallingRef.current = true;
    setUpdatePhase((p) => reduceUpdatePhase(p, { type: 'installStart', total: null }));
    try {
      await found.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          setUpdatePhase((p) => reduceUpdatePhase(p, { type: 'installStart', total: event.data.contentLength ?? null }));
        } else if (event.event === 'Progress') {
          setUpdatePhase((p) => reduceUpdatePhase(p, { type: 'installProgress', chunk: event.data.chunkLength }));
        } else if (event.event === 'Finished') {
          setUpdatePhase((p) => reduceUpdatePhase(p, { type: 'installDone' }));
        }
      });
      setUpdatePhase((p) => reduceUpdatePhase(p, { type: 'installDone' }));
      updateFoundRef.current = null;
    } catch {
      // 下载 / 安装中断（断网、磁盘、取消）：失败态可见可重试。
      // **保留** Update 资源：重试对同一个 Update 再下一次，不必重新查端点。
      setUpdatePhase((p) => reduceUpdatePhase(p, { type: 'installFailed' }));
    } finally {
      updateInstallingRef.current = false;
    }
  }, []);

  /**
   * 关更新弹窗（稍后 / X / 遮罩 / Esc 共用）。
   *
   * 下载中**也允许关**：`downloadAndInstall` 发出后不可取消，关面板不中断安装；
   * 进度会继续落在设置页的状态行上。把作者锁在全屏模态里等下载是更坏的体验。
   * 关掉时记住这一版，自动检查不再为它重开（手动检查发现同一版仍可重开）。
   */
  const closeUpdateDialog = useCallback(() => {
    const dialog = updateDialogPhase(updatePhaseRef.current);
    if (dialog !== null) {
      dismissedUpdateVersionInSession =
        dialog.kind === 'failed' ? dialog.release.version : dialog.version;
    }
    setUpdateDialogOpen(false);
  }, []);

  // 弹窗只在 found / downloading / done / failed(install) 出现；别的态连节点都不挂
  const updateDialog = updateDialogOpen ? updateDialogPhase(updatePhase) : null;

  // overlay 打开/关闭意图（内核事件落地；Esc 关闭在全局键盘处理器）
  useEffect(() => {
    const unOpen = kernel.bus.on('ui.overlay.open', (ev) => {
      setActiveOverlay({ id: ev.id, ...(ev.payload !== undefined ? { payload: ev.payload } : {}) });
    });
    const unClose = kernel.bus.on('ui.overlay.close', (ev) => {
      setActiveOverlay((cur) => (cur && cur.id === ev.id ? null : cur));
    });
    return () => {
      unOpen();
      unClose();
    };
  }, [kernel]);

  // 壳层布局命令（定稿 §五-3：合法容器语义）与槽命令合并为统一注册表。
  // 键位不再写死在这里：缺省值与用户改键覆盖统一从键位注册表取（R8），
  // `kbVersion` 变化即重建——改键即刻生效，无需重启。
  const kbVersion = useKeybindingsVersion();

  /**
   * 让位读数发射口（KEY-YIELD-VISIBLE）：走既有通知中心 toast，不新造提示通道。
   * ref 只为一件事——全局 keydown 监听器挂载一次（依赖表为空），闭包里不能抓着
   * 会变的身份不放；`notify` 本身在 NotificationCenter 里是 useCallback 稳定值。
   *
   * B 批起这两行**上移**到命令表之前：状态栏那两个即时开关命令在无编辑器时也要发中文
   * 通知（铁律 4），必须与全局键处理共用同一枚稳定 ref，不得各留一份。
   */
  const notify = useNotify();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  /**
   * 状态栏两格的命令体（B 批）：只写偏好真源（`layout-pref` / `editor-display-prefs`），
   * 活编辑器与后续打开的文件由既有订阅通路即时反映；无编辑器 / 无活动文件时给中文通知，
   * 不静默。命令体是 `ShellLayout` 导出的纯函数（单源可测，见 `applyToggleWordWrap`）。
   */
  const toggleWordWrap = useCallback((): void => {
    applyToggleWordWrap(focusedCtx()?.editorRef.current ?? null, (message) =>
      notifyRef.current({ kind: 'info', message }),
    );
  }, []);
  const toggleRenderWhitespace = useCallback((): void => {
    applyToggleRenderWhitespace(focusedCtx()?.editorRef.current ?? null, (message) =>
      notifyRef.current({ kind: 'info', message }),
    );
  }, []);

  /**
   * 书签命令族（C 批）：四条命令只做「取当前焦点编辑器 / 当前文件」的接线，判据与行号集合
   * 全在 `./bookmarks`（纯逻辑、可单测）。三条取不到目标的路径一律给中文通知，不静默（铁律 4）：
   * 无编辑器 / 无活动文件 / **预览面**（投影文本的行号不是原文行号，在它上面加书签只会错位）。
   */
  const toggleBookmarkAtCursor = useCallback((): void => {
    const ctx = focusedCtx();
    const ed = ctx?.editorRef.current ?? null;
    const path = ctx?.filePathRef.current ?? '';
    if (ed === null || ed.getModel() === null || path === '') {
      notifyRef.current({ kind: 'info', message: '先打开一个文件，再切换书签。' });
      return;
    }
    if ((ctx?.sugarModelRef.current ?? null) !== null) {
      notifyRef.current({ kind: 'info', message: '预览面是投影文本，书签只挂在原文上：先切回源码再加。' });
      return;
    }
    const line = ed.getPosition()?.lineNumber;
    if (line === undefined) {
      notifyRef.current({ kind: 'info', message: '当前没有光标位置，书签没有可挂的行。' });
      return;
    }
    // 切换书签的可见回执就是 glyph：加/删当场出现在行首，不另弹提示（照 VSCode 书签扩展）
    toggleBookmark(path, line);
  }, []);

  /** 书签间跳转（`direction`：1 = 下一个，-1 = 上一个）——回绕语义在 bookmarks 的 next/prev */
  const jumpToBookmark = useCallback((direction: 1 | -1): void => {
    const ctx = focusedCtx();
    const ed = ctx?.editorRef.current ?? null;
    const path = ctx?.filePathRef.current ?? '';
    if (ed === null || ed.getModel() === null || path === '') {
      notifyRef.current({ kind: 'info', message: '先打开一个文件，再在书签间跳。' });
      return;
    }
    if ((ctx?.sugarModelRef.current ?? null) !== null) {
      notifyRef.current({ kind: 'info', message: '预览面是投影文本，书签只在原文上跳：先切回源码。' });
      return;
    }
    const from = ed.getPosition()?.lineNumber ?? 1;
    const line = direction === 1 ? nextBookmark(path, from) : prevBookmark(path, from);
    if (line === null) {
      notifyRef.current({ kind: 'info', message: '本文件还没有书签：先在要记的行按「切换书签」加一个。' });
      return;
    }
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.revealLineInCenter(line);
    ed.focus();
  }, []);

  /** 清除本文件全部书签（无书签时也出声——按下去屏上没有任何变化才是静默） */
  const clearFileBookmarksCmd = useCallback((): void => {
    const ctx = focusedCtx();
    const ed = ctx?.editorRef.current ?? null;
    const path = ctx?.filePathRef.current ?? '';
    if (ed === null || ed.getModel() === null || path === '') {
      notifyRef.current({ kind: 'info', message: '先打开一个文件，再清除它的书签。' });
      return;
    }
    if (clearFileBookmarks(path) === 0) {
      notifyRef.current({ kind: 'info', message: '本文件没有书签，无需清除。' });
    }
  }, []);

  const shellCommands = useMemo<readonly ShellCommandSpec[]>(
    () => [
      { id: 'layout.toggleSidebar', title: '切换主侧栏', keybinding: effectiveKeybindingOf('layout.toggleSidebar'), run: () => dispatch({ type: 'toggle', container: 'sidebar' }) },
      { id: 'layout.toggleBottom', title: '切换底部区', keybinding: effectiveKeybindingOf('layout.toggleBottom'), run: () => dispatch({ type: 'toggle', container: 'bottom' }) },
      { id: 'layout.toggleAux', title: '切换副侧栏', keybinding: effectiveKeybindingOf('layout.toggleAux'), run: () => dispatch({ type: 'toggle', container: 'aux' }) },
      // Ctrl+K Z 和弦是全局键盘处理器的特例分支（注册表单键表达不了），键位在
      // 键位注册表里登记为不可改；此处不带 keybinding，避免全局处理器重复消费。
      { id: 'layout.toggleZen', title: '切换写作模式', run: () => dispatch({ type: 'toggleZen' }) },
      // 全屏（用户反馈第 2 条）：F11 已由全局键盘分支处理，此处**不带 keybinding**，
      // 免得和可改键系统重复触发；命令面板里仍可搜到并执行。
      { id: 'layout.toggleFullscreen', title: '切换全屏', category: '工作台', run: () => { void toggleFullscreen(); } },
      { id: 'layout.reset', title: '重置布局', run: () => doResetRef.current() },
      { id: 'layout.openSettings', title: '打开设置', run: () => { setSettingsSection('general'); setSettingsOpen(true); } },
      // 检查更新（1023 覆盖面批 · 兜底右键菜单的入口）：与设置页「关于」那颗按钮**同一个动作**
      // （`runUpdateCheck`），菜单不复制任何更新逻辑。检查结果在设置页可见
      // （检查中… / 已是最新 / 发现新版本），故顺带把设置页定位到「关于」——否则从菜单点下去
      // 在"已是最新"这条路上什么都看不见（铁律 4 的"不许按了没反应"）。
      { id: 'workbench.checkUpdates', title: '检查更新', category: '工作台', run: () => { setSettingsSection('about'); setSettingsOpen(true); void runUpdateCheck(); } },
      { id: 'workbench.commandPalette', title: '命令面板', keybinding: effectiveKeybindingOf('workbench.commandPalette'), run: () => setPaletteOpen(true) },
      { id: 'workbench.quickOpen', title: '快速打开文件', keybinding: effectiveKeybindingOf('workbench.quickOpen'), run: () => setQuickOpen(true) },
      // 工作区符号（D2 · Ctrl+T）：按名字找函数定义并跳过去（候选来自
      // `ui.editor.languageService` 的 `workspaceSymbol` 应答，壳层不认识 ERB）。
      // **刻意不给 `when`**（与 `workbench.quickOpen` 同形态，而命令面板的禁用位另有用途）：
      // 没项目 / 索引没建好时命令仍要**按得下去**——面板里那句原因才是给作者的答复；
      // 把它灰掉就成了"按了没反应"（铁律 4）。
      { id: 'workbench.workspaceSymbols', title: '转到工作区符号', keybinding: effectiveKeybindingOf('workbench.workspaceSymbols'), run: () => setSymbolsOpen(true) },
      // 全文搜索（2026-10-15 检索批）：打开侧栏「搜索」视图 + 请求输入框聚焦。
      // 激活单位是视图 key（单独成视图的面板 = `panel:<id>`，见 layout.organizePanels）；
      // 聚焦意图发进 search-store（面板订阅 focusNonce 落地）——壳层不知道面板内部的输入框。
      {
        id: 'workbench.searchInFiles',
        title: '在文件中搜索',
        keybinding: effectiveKeybindingOf('workbench.searchInFiles'),
        run: () => {
          requestSearchFocus();
          dispatch({ type: 'activate', container: 'sidebar', key: 'panel:kojo.search' });
        },
      },
      // 全文替换（R7/R8）：同一视图，聚焦的是替换框（替换是搜索面板的下半身，
      // 不另开视图——与 VSCode 的搜索/替换一体同构）。
      {
        id: 'workbench.replaceInFiles',
        title: '在文件中替换',
        keybinding: effectiveKeybindingOf('workbench.replaceInFiles'),
        run: () => {
          requestReplaceFocus();
          dispatch({ type: 'activate', container: 'sidebar', key: 'panel:kojo.search' });
        },
      },
      // 键盘快捷键（b/kbset/1017）：不再是独立对话框，改为「打开设置并定位到快捷键节」。
      { id: 'workbench.keybindings', title: '打开键盘快捷键', run: () => { setSettingsSection('keybindings'); setSettingsOpen(true); } },
      // 问题面板（HK-4 · UI-6）：打开底部区并激活「问题」视图（activate 会同时置 visible:true）
      { id: 'workbench.problems', title: '问题面板', keybinding: effectiveKeybindingOf('workbench.problems'), run: () => dispatch({ type: 'activate', container: 'bottom', key: 'kojo.problems' }) },
      // 状态注入器（2026-10-19）：副侧栏默认收起、且该面板 defaultActive=false，
      // 作者只能靠猜「切换副侧栏」再点标签才能找到它（实机审计：功能因此被判「没做过」）。
      // 这里给一条直达命令（activate 同时置 visible:true），命令面板可搜「状态注入」。
      { id: 'workbench.snapshotInjector', title: '打开状态注入器', category: '工作台', run: () => dispatch({ type: 'activate', container: 'aux', key: 'snapshot-injector' }) },
      // 文字缩放（A1）：走 font-size-pref 的档位真源，Monaco 原生 fontZoom contrib
      // 装载但未自带键位（standalone 无 workbench 绑定），键位由这张命令表给出
      // （缺省值登记在键位注册表，可查可改）。
      { id: 'editor.fontZoomIn', title: '放大文字', keybinding: effectiveKeybindingOf('editor.fontZoomIn'), run: () => stepFontZoomPref(1) },
      { id: 'editor.fontZoomOut', title: '缩小文字', keybinding: effectiveKeybindingOf('editor.fontZoomOut'), run: () => stepFontZoomPref(-1) },
      { id: 'editor.fontZoomReset', title: '重置文字缩放', keybinding: effectiveKeybindingOf('editor.fontZoomReset'), run: () => resetFontZoomPref() },
      // 状态栏即时开关（B 批）：与状态栏那两格同一个动作（都落偏好真源、走既有订阅通路），
      // 命令面板可搜、键位页可改；`alt+z` 与 VSCode 一致，空白符不占缺省键（见键位表登记处）。
      { id: 'workbench.toggleWordWrap', title: '切换自动换行', keybinding: effectiveKeybindingOf('workbench.toggleWordWrap'), run: () => toggleWordWrap() },
      { id: 'workbench.toggleRenderWhitespace', title: '切换空白符显示', keybinding: effectiveKeybindingOf('workbench.toggleRenderWhitespace'), run: () => toggleRenderWhitespace() },
      // 文档内书签（C 批）：命令面板可搜、键位页可改（缺省键登记在键位表，选择依据见登记处注释）。
      // 四条命令体都作用于**当前焦点编辑器**（focusedCtx），无编辑器 / 预览面给中文通知。
      { id: 'bookmarks.toggle', title: '切换书签', category: '书签', keybinding: effectiveKeybindingOf('bookmarks.toggle'), run: () => toggleBookmarkAtCursor() },
      { id: 'bookmarks.next', title: '跳到下一个书签', category: '书签', keybinding: effectiveKeybindingOf('bookmarks.next'), run: () => jumpToBookmark(1) },
      { id: 'bookmarks.prev', title: '跳到上一个书签', category: '书签', keybinding: effectiveKeybindingOf('bookmarks.prev'), run: () => jumpToBookmark(-1) },
      { id: 'bookmarks.clearFile', title: '清除本文件书签', category: '书签', keybinding: effectiveKeybindingOf('bookmarks.clearFile'), run: () => clearFileBookmarksCmd() },
      // P3：编辑器区注入的命令（关闭标签 / 全部保存）并入统一注册表
      ...(extraCommands ?? []),
    ],
    // kbVersion 是真实依赖：改键覆盖 → 版本号自增 → 命令表带新键位重建
    [extraCommands, kbVersion, toggleWordWrap, toggleRenderWhitespace, toggleBookmarkAtCursor, jumpToBookmark, clearFileBookmarksCmd],
  );
  /**
   * Monaco 内建动作的宿主命令入口（1026 编辑器内核批）。
   *
   * 执行腿与编辑器的 `runEditorAction`（`use-monaco-instance.ts`）同一条：跨实例取
   * **当前焦点编辑器**（`focusedCtx()` 是全仓唯一的「焦点实例」来源）再 `getAction(id)`。
   * 两条失败路径都给一句中文通知、不静默（铁律 4）：
   *   ① 没有可用编辑器（还没打开文件 / 焦点不在编辑器）——先点一下再执行；
   *   ② `getAction` 返回 null（这门语言没这个动作）——与编辑器右键那条口径逐字一致。
   *
   * 依赖表为空：`notifyRef` 是稳定 ref（每次渲染指向最新 notify），`focusedCtx` 是模块函数；
   * 被 `editorActionCommands` 记忆化引用，不随每次渲染换身份。
   */
  const runMonacoBuiltinAction = useCallback((monacoActionId: string): void => {
    const ed = focusedCtx()?.editorRef.current;
    if (!ed) {
      notifyRef.current({ kind: 'info', message: '当前没有可用的编辑器：先在编辑区点一下再执行。' });
      return;
    }
    const action = ed.getAction(monacoActionId);
    if (action === null) {
      notifyRef.current({ kind: 'info', message: '当前文件类型不支持这个动作。' });
      return;
    }
    void action.run();
  }, []);
  /**
   * 内核动作 → 宿主命令项（形状与槽贡献同构）。
   *
   * `keybinding` 只取**宿主生效键**（`effectiveKeybindingOf`）——作者在内核动作行改的键才显示；
   * 不改就没有（Monaco 内建键在只读页另列，不在这里冒充宿主键）。
   * `when`：这些动作都要求「有活动编辑器」，用 `requiresFile` 数据位驱动（无焦点编辑器 ⇒ 面板里灰）。
   */
  const editorActionCommands = useMemo<EditorCommandContribution[]>(
    () =>
      MONACO_COMMAND_SPECS.map((s) => {
        const keybinding = effectiveKeybindingOf(s.id);
        return {
          id: s.id,
          title: s.title,
          category: s.category,
          ...(keybinding !== undefined ? { keybinding } : {}),
          ...(s.requiresFile
            ? { when: () => focusedCtx()?.editorRef.current?.getModel() != null }
            : {}),
          run: () => runMonacoBuiltinAction(s.monacoActionId),
        };
      }),
    [kbVersion, runMonacoBuiltinAction],
  );
  const registry = useMemo(
    () => buildCommandRegistry(shellCommands, slotCommands, editorActionCommands),
    [shellCommands, slotCommands, editorActionCommands],
  );
  // 最新注册表 / 上下文 ref（全局键盘处理器闭包外读取）
  const registryRef = useRef(registry);
  registryRef.current = registry;
  const commandCtxRef = useRef(commandCtx);
  commandCtxRef.current = commandCtx;

  // 调试面登记（2026-10-24 调试模式批）：把「命令面板注册表」暴露给 `window.__kojoDebug.commands`
  // ——只登记读 ref 的通道，注册表本身随渲染重建不受影响；未选入调试模式时登记簿无人读。
  // 挂载一次（effect 无依赖），通道内每次现读 `registryRef` / `commandCtxRef` 的最新值。
  // **动态 import 是刻意的**：开机图闸文件余量只剩 1，登记簿不许静态进图。
  useEffect(() => {
    void import('../debug/debug-registry').then((m) => {
      m.registerDebugCommandRunner({
        list: () =>
          registryRef.current.map((c) => ({
            id: c.id,
            title: c.title,
            ...(c.category !== undefined ? { category: c.category } : {}),
            ...(c.keybinding !== undefined ? { keybinding: c.keybinding } : {}),
          })),
        run: async (id) => {
          const entry = registryRef.current.find((c) => c.id === id);
          if (!entry) throw new Error(`命令不存在：${id}（先 __kojoDebug.commands.list() 看可用命令）`);
          await entry.run(commandCtxRef.current);
        },
      });
    });
  }, []);

  /* -------------------- D2：工作区符号（Ctrl+T）的宿主接线 -------------------- */

  /**
   * 符号应答方（与「转到定义 / 文档大纲」**同一枚槽**的第三个判别成员）。
   * 宿主只按 `kind` 问、把返回的候选合并——**不认识** ERB / 家族 / 角色；
   * 名字口径与索引归属全在应答方（ERB 侧 = erb-parser 的 `ErbIndex.byName`）。
   */
  const languageServices = useMemo(() => kernel.slots.query('ui.editor.languageService'), [kernel]);

  /**
   * 问一次（面板每次击键问一次；预算 = DOM 行数，提供方那侧另有内存预算）。
   * 读 `commandCtxRef` 而不是 `commandCtx`：项目切换要拿**当下**的项目，
   * 而闭包按 `languageServices` 记忆化——依赖里塞 project 会让每次活动文件变化都重建。
   */
  const fetchWorkspaceSymbols = useCallback(
    (query: string) =>
      collectWorkspaceSymbols(languageServices, {
        query,
        project: commandCtxRef.current.project,
        limit: WORKSPACE_SYMBOL_RENDER_LIMIT,
      }),
    [languageServices],
  );

  /**
   * 空结果的**可见原因**（铁律 4「不静默」在 UI 侧的那一半）。
   *
   * 用的是壳层**本来就有的事实**（项目开没开 + 状态栏那三个索引读数），不去问插件
   * "你为什么没答"——应答方给的是 `undefined`（不认这个查询），而"为什么不认"
   * 只有宿主这一侧说得出（否则作者看到的是"无匹配符号"这种假答案）。
   */
  const workspaceSymbolNoticeFor = useCallback(
    (query: string) =>
      workspaceSymbolNotice({
        hasProject: commandCtx.project !== null,
        indexing: stats.indexing,
        indexError: stats.indexError,
        fileCount: stats.fileCount,
        query,
        // ST-CONSUMERS：把提供方那一轮的**可查事实**原样转述给文案层（宿主不代判形状，
        // 三态与覆盖的判据只住 `erb-parser/index-state.ts`；服务缺席 / 抛错 ⇒ null = 退回旧读数）
        indexState: (() => {
          try {
            return kernel.services.tryGet<ErbParserService>('erb.parser')?.indexState?.() ?? null;
          } catch {
            return null;
          }
        })(),
      }),
    [commandCtx.project, stats.indexing, stats.indexError, stats.fileCount, kernel],
  );

  /** 选中 ⇒ 发既有 `editor.revealLocation`（开文件 + 定位由 App 落地，不新造跳转机制） */
  const revealWorkspaceSymbol = useCallback(
    (symbol: EditorWorkspaceSymbol) => {
      kernel.bus.emit('editor.revealLocation', {
        filePath: symbol.filePath,
        line: symbol.line,
        ...(symbol.column !== undefined ? { column: symbol.column } : {}),
        source: '工作区符号',
      });
    },
    [kernel],
  );

  /**
   * `Ctrl+P` 的 `:` / `@` 两条腿的落点（1020 编辑器体感批）：与上面同一条通道，
   * 只是发起方换成快速打开面板。列不给 ⇒ 落在行首（与 `revealLocation` 那条退化口径一致）。
   */
  const revealLine = useCallback(
    (target: PaletteReveal) => {
      kernel.bus.emit('editor.revealLocation', {
        filePath: target.filePath,
        line: target.line,
        source: target.source,
      });
    },
    [kernel],
  );

  // 工作台 API 注册（编辑器区空态动作按钮反向取 picker/命令入口）
  useEffect(() => {
    const api: WorkbenchApi = {
      openQuickOpen: () => setQuickOpen(true),
      openPalette: () => setPaletteOpen(true),
      hasCommand: (id) => registryRef.current.some((c) => c.id === id),
      runCommand: (id) => {
        const cmd = registryRef.current.find((c) => c.id === id);
        if (!cmd) return false;
        try {
          if (cmd.when && !cmd.when(commandCtxRef.current)) return false;
          void cmd.run(commandCtxRef.current);
          return true;
        } catch (e: unknown) {
          console.warn(`[ShellLayout] 命令 '${id}' 执行失败：${errorText(e)}`);
          return false;
        }
      },
    };
    onRegisterWorkbench?.(api);
    // 同一份判据同时喂给右键菜单（兜底菜单的命令项据此决定「显示/禁用」）
    registerContextMenuCommandRunner(api);
    return () => {
      onRegisterWorkbench?.(null);
      registerContextMenuCommandRunner(null);
    };
  }, [onRegisterWorkbench]);

  /**
   * 右键菜单的键位注入（1023 开机图减重批）。
   *
   * `context-menu-model` 不再值导入 `./keybindings`（那一个 import 把整包键位运行期拖进
   * 首屏，只为菜单右侧的两根字符串）。生效键位这只眼睛由壳层递进去——它本来就懒加载，
   * 也本来就握着 `effectiveKeybindingOf`。**注入的是同一个函数**：作者改键后菜单提示
   * 跟着变，仍然只有一套键位解析，不存在「菜单显示一个键、按下去另一个键」。
   *
   * 依赖表为空：`effectiveKeybindingOf` 是模块级函数，读的是模块内的覆盖表。注销放在
   * 清理函数里，壳层卸载后菜单回到规格表的缺省键（而不是死记着上一次的答案）。
   */
  useEffect(() => {
    registerMenuKeybindingLookup(effectiveKeybindingOf);
    return () => registerMenuKeybindingLookup(null);
  }, []);

  /**
   * 输入法合成会话标志（2026-10-12 实机缺陷修复）。
   *
   * 事件自带的 `isComposing` / `keyCode 229` 已覆盖主路径，这一层兜的是第三方输入法
   * 「keydown 上不带合成态」的情形——写作模式的主场景就是大量中文输入，漏一次等于把
   * 用户的界面状态拆掉（且布局会持久化，重启仍在）。
   */
  const composingRef = useRef(false);


  // 全局快捷键（统一注册表驱动；Ctrl+K Z 和弦特例；Esc 优先级见 shell-keys 的 ESC_PRIORITY）
  useEffect(() => {
    let chordAt = 0;
    // 合成期一律不消费：撤销拼音候选的那次 Esc 属于输入法，不属于编辑器（判据在 shell-keys）
    const onCompositionStart = (): void => {
      composingRef.current = true;
    };
    const onCompositionEnd = (): void => {
      composingRef.current = false;
    };
    // 失焦时合成会话未必会补一个 compositionend（候选窗还开着就 alt-tab 走）——不清掉标志
    // 会把「合成期不消费快捷键」变成「永久不消费快捷键」，那比原缺陷更坏。
    const onWindowBlur = (): void => {
      composingRef.current = false;
    };
    const onKey = (e: KeyboardEvent): void => {
      // 三层早退（顺序即优先级，判定单源在 shell-keys 的 GLOBAL_KEY_GATE_PRIORITY）：
      // 1) 内层已 preventDefault ⇒ 让位；2) 输入法合成期 ⇒ 键属于 IME；
      // 3) 事件目标正在输入（树内改名/过滤框）⇒ Ctrl+W 不许关标签、Ctrl+B 不许折侧栏，
      //    否则输入框 blur 触发 onCancel，一次改名静默作废。命中即 return：
      //    不 preventDefault、不 run，原生输入行为原样保留。
      // Monaco 的隐藏 textarea 被 isEditableKeyTarget 放行，编辑器内快捷键照旧。
      // 命中「键先给了输入」的两层 ⇒ 经通知中心留一行读数（为什么没执行 + 先 Esc 再按），
      // 判定与节流单源在 shell-keys 的 reportKeyYield；不 preventDefault、不 run，语义一字未动。
      const keyEvidence = {
        defaultPrevented: e.defaultPrevented,
        composing: isComposingEvent(e, composingRef.current),
        editableTarget: isEditableKeyTarget(e.target),
      };
      const gate = resolveGlobalKeyGate(keyEvidence);
      if (gate !== null) {
        reportKeyYield({
          gate,
          event: e,
          commands: registryRef.current,
          now: Date.now(),
          emit: (message) => notifyRef.current({ kind: 'info', message }),
        });
        return;
      }
      const k = e.key.toLowerCase();
      // Ctrl+K Z 和弦：先记 Ctrl+K，1.5s 内按 Z 触发（两键序列，注册表单键表达不了）
      if (chordAt > 0) {
        const fresh = Date.now() - chordAt < 1500;
        chordAt = 0;
        if (fresh && k === 'z' && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          dispatch({ type: 'toggleZen' });
          return;
        }
      }
      if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && k === 'k') {
        chordAt = Date.now();
        return;
      }
      if (e.key === 'Escape') {
        // 命中哪一层由 shell-keys 单源判定；picker 内部已 stopPropagation，全局侧原样让位。
        // 模态（HK-2 的宿主模态栈）排在 overlay 之前：它正在问一个当下就要答案的问题，
        // 而 Esc 恒落在不写盘那一侧（见 modal-stack 注释）。
        const hit = resolveEscLayer({
          picker: pickerRef.current,
          modal: modalDepth() > 0,
          overlay: overlayRef.current !== null,
          settings: settingsRef.current,
          zen: zenRef.current,
        });
        if (hit === 'modal') closeTopModal();
        else if (hit === 'overlay') dismissOverlay();
        else if (hit === 'settings') setSettingsOpen(false);
        else if (hit === 'zen') dispatch({ type: 'exitZen' });
        return;
      }
      if (e.key === 'F1') {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      // 全屏切换（用户反馈第 2 条）：F11 落在合成门之后，输入法合成期不会走到这里
      if (e.key === 'F11') {
        e.preventDefault();
        void toggleFullscreen();
        return;
      }
      // 注册表 keybinding 匹配
      const chord = chordFromEvent(e);
      if (!chord) return;
      for (const cmd of registryRef.current) {
        if (!cmd.keybinding || cmd.keybinding.includes(' ')) continue; // 和弦走上方特例
        const parsed = parseKeybinding(cmd.keybinding);
        if (parsed && chordEquals(parsed, chord)) {
          // 启用态闸（与命令面板同一条 `commandEnabled` 判据）：无项目时 Ctrl+N 在面板里
          // 是灰的，键盘侧也必须按不动——false ⇒ 不 preventDefault、不 run，让原生行为接手。
          // 停在这一条命令（不回退到下一条同键命令）：分发仍是「注册表顺序先到先得」。
          if (
            !shouldRunGlobalCommand({
              ...keyEvidence,
              enabled: commandEnabled(cmd, commandCtxRef.current),
            })
          ) {
            return;
          }
          e.preventDefault();
          void cmd.run(commandCtxRef.current);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    // 捕获阶段收合成事件：组件（含 Monaco）可能自行 stopPropagation，会话标志不能因此漏记
    window.addEventListener('compositionstart', onCompositionStart, true);
    window.addEventListener('compositionend', onCompositionEnd, true);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('compositionstart', onCompositionStart, true);
      window.removeEventListener('compositionend', onCompositionEnd, true);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, []);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  /**
   * 三容器与侧栏分栏节的 DOM 引用（PS-6）：拖拽期要往它们身上写内联样式。
   * 由渲染处的 ref 回调登记；把手与容器同一次渲染挂载，拖起来一定拿得到。
   */
  const shellElsRef = useRef<Partial<Record<ContainerKey, HTMLElement | null>>>({});
  const sectionElsRef = useRef(new Map<string, HTMLElement>());

  /**
   * 尺寸拖拽（PS-6 第 2 项）：**拖拽期只写内联样式，松手才 dispatch 一次**。
   *
   * 旧形态每次 mousemove 都 `dispatch({type:'resize'})` ⇒ 一个新 `LayoutState` ⇒
   * 整棵 ShellLayout 重渲染 ⇒ 持久化那条 `useEffect(..., [layout])` 跟着
   * `JSON.stringify` + 写一次 localStorage。两秒拖拽 ≈ 120 次全壳重渲染 + 120 次写盘，
   * 而浮窗拖拽早就用"只写 inline、松手 commit"这一招避掉了（见下面 `startFloatDrag`），
   * 这里照搬同一个口径。换算与钳制的机制住在 `layout.ts` 的 `beginLiveResize`（可单测）。
   *
   * 指针侧一并收口（PS-6 第 7 项）：改用 pointer 事件 + `setPointerCapture`，
   * 并挂 `pointercancel`——旧实现只在 window 的 mouseup 上解绑，
   * 手在窗口外松开 ⇒ 监听器留着、下一次按下去叠一份。
   */
  const startDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>, container: ContainerKey, horizontal: boolean, sign: 1 | -1) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      const pointerId = e.pointerId;
      handle.setPointerCapture?.(pointerId);
      const session = beginLiveResize({
        target: shellElsRef.current[container] ?? undefined,
        container,
        startSize: layoutRef.current[container].size,
        startPos: horizontal ? e.clientX : e.clientY,
        sign,
      });
      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return;
        session.onMove(horizontal ? ev.clientX : ev.clientY);
      };
      const onUp = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
        // 松手一次 commit：值就是拖拽期最后写进 inline 的那个数 ⇒ 视觉零 delta，不跳一下
        const size = session.finish();
        if (size !== null) dispatch({ type: 'resize', container, size });
      };
      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [],
  );

  /**
   * 浮窗 DOM 引用（id → 根 `<section>`）。
   * 拖拽 / 缩放期间**直接改元素样式**、不进 reducer——否则每次 mousemove 都会产生新
   * `LayoutState` ⇒ 整棵 ShellLayout（含浮窗内面板子树）重渲染 + `saveLayout` 写
   * localStorage，于是拖起来卡。松手才 commit 一次几何到 state。
   */
  const floatElsRef = useRef(new Map<string, HTMLElement>());

  const floatingPanels = useMemo(
    () => allPanels.filter((p) => layout.floating[p.id] !== undefined),
    [allPanels, layout.floating],
  );

  /** 浮动一个面板：按视口算初值，多窗层叠错位避免完全重叠 */
  const floatPanel = useCallback((id: string) => {
    const n = Object.keys(layoutRef.current.floating).length;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 初值公式住在 context-menu-shell（浮窗右键的「重置位置与尺寸」要用同一个数，
    // 抄一份在这里迟早两边不一样——那正是「重置」看起来没重置的成因）
    dispatch({ type: 'float', id, geometry: defaultFloatRect(n, { w: vw, h: vh }) });
  }, []);

  /** 视口尺寸供应商（拖拽/缩放钳制的基准；每次手势现场取，窗口改变不吃旧值） */
  const viewportSize = useCallback((): Viewport => ({ w: window.innerWidth, h: window.innerHeight }), []);

  /**
   * 浮窗拖拽（标题栏 pointerdown → 全局 pointermove）。
   *
   * 性能口径（2026-10-14「拖拽依旧卡顿」根治，硬约束：不许引入松手抖动）：
   * - 拖拽期用**合成层移动**（`transform: translate3d` + `will-change: transform`），
   *   **不写 left/top** ⇒ 浮窗子树零 layout / 零重排；几何换算每 pointermove 一次（纯算）。
   * - pointermove **合并到 rAF**（一帧最多落一次、只落最新值）；以 `{passive:true}` 在
   *   pointerdown 挂上、pointerup/pointercancel 卸载；setPointerCapture 让指针出窗不丢事件。
   * - 松手**原子交接**：同一同步块写最终 inline left/top（= 基准 + 累积 transform 位移）
   *   + 清 transform，再 commit 给 React（值同坐标系、逐字相同）⇒ 视觉零 delta。
   * 拖拽全程不进 reducer、不写 localStorage（仅松手那一次 commit 除外）。
   *
   * `button` 命中的 pointerdown 一律放行——标题栏里的关闭/停靠按钮不能被拖拽吃掉。
   */
  const startFloatDrag = useCallback((e: ReactPointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const f = layoutRef.current.floating[id];
    if (!f) return;
    const el = floatElsRef.current.get(id);
    if (!el) return;
    const head = e.currentTarget;
    const pointerId = e.pointerId;
    head.setPointerCapture?.(pointerId);
    const session = beginFloatDrag({
      el,
      base: f,
      origin: { x: e.clientX, y: e.clientY },
      viewport: viewportSize,
    });
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      session.onMove(ev.clientX, ev.clientY);
    };
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (head.hasPointerCapture?.(pointerId)) head.releasePointerCapture(pointerId);
      const g = session.finish();
      if (g) dispatch({ type: 'moveFloating', id, x: g.x, y: g.y });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [viewportSize]);

  /**
   * 浮窗缩放（四角 + 四边，指针拖拽）。
   *
   * 与拖拽同一套性能口径：直接改 DOM、合并到 rAF、松手才 commit（不进 reducer）。
   * 缩放本就改尺寸（width/height 是布局属性，避不开 layout）——这里省不掉的是**重渲染**，
   * 而每帧重渲染整棵壳层才是卡顿的根源，故同样拖拽期只写 inline、不进 state。
   * 左/上系把手同时改 x/y，故 x/y 亦在拖拽期直写 inline，松手值与 React 落地值逐字一致。
   */
  const startFloatResize = useCallback((e: ReactPointerEvent<HTMLElement>, id: string, handle: ResizeHandle) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // 把手不在标题栏内，防御性阻止冒泡到拖拽
    const f = layoutRef.current.floating[id];
    if (!f) return;
    const el = floatElsRef.current.get(id);
    if (!el) return;
    const target = e.currentTarget;
    const pointerId = e.pointerId;
    target.setPointerCapture?.(pointerId);
    const session = beginFloatResize({
      el,
      base: f,
      handle,
      origin: { x: e.clientX, y: e.clientY },
      viewport: viewportSize,
    });
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      session.onMove(ev.clientX, ev.clientY);
    };
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
      const g = session.finish();
      if (!g) return;
      // 左/上系把手会同时挪 x/y：分两动作 commit（同一事件回调内自动批处理 ⇒ 仍是一次渲染）
      if (g.x !== f.x || g.y !== f.y) dispatch({ type: 'moveFloating', id, x: g.x, y: g.y });
      if (g.w !== f.w || g.h !== f.h) dispatch({ type: 'resizeFloating', id, w: g.w, h: g.h });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [viewportSize]);

  /** 缩放把手的键盘操作（方向键）：与指针共用同一套几何，走同一条 commit 路径 */
  const resizeKeyDown = useCallback((e: ReactKeyboardEvent<HTMLElement>, id: string, handle: ResizeHandle) => {
    const delta = keyResizeDelta(handle, e.key);
    if (!delta) return;
    const f = layoutRef.current.floating[id];
    if (!f) return;
    e.preventDefault();
    const next = resizeRect(f, handle, delta.dx, delta.dy, viewportSize());
    if (next.x !== f.x || next.y !== f.y) dispatch({ type: 'moveFloating', id, x: next.x, y: next.y });
    if (next.w !== f.w || next.h !== f.h) dispatch({ type: 'resizeFloating', id, w: next.w, h: next.h });
  }, [viewportSize]);

  // 浮动面板意图（内核事件落地；停靠由浮窗自带的按钮完成）
  useEffect(() => {
    const un = kernel.bus.on('ui.panel.float', (ev) => floatPanel(ev.id));
    return un;
  }, [kernel, floatPanel]);

  /* -------------------- P4：三容器拖拽停靠（定稿 §七；override 持久化在 layout.panelLocations） -------------------- */

  /** 落点高亮目标（dragover 置位，drop/dragend/真正离开容器时清除） */
  const [dropTarget, setDropTarget] = useState<ContainerKey | null>(null);

  /** 拖拽载荷：面板 id 数组（活动栏图标拖拽 = 整组视图迁移） */
  const startPanelDrag = (e: ReactDragEvent, ids: readonly string[]): void => {
    e.dataTransfer.setData(PANEL_DRAG_MIME, JSON.stringify(ids));
    e.dataTransfer.setData('text/plain', ids.join(','));
    e.dataTransfer.effectAllowed = 'move';
  };

  /** 容器落点 props：dragover 接受 + 高亮；drop 派发 move（逐面板；sidebar 需 viewKey 激活） */
  const dropProps = (container: ContainerKey) => ({
    onDragOver: (e: ReactDragEvent) => {
      if (!acceptsPanelDrop(e.dataTransfer.types)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget((cur) => nextDropTarget(cur, { type: 'dragover', container }));
    },
    onDragLeave: (e: ReactDragEvent) => {
      // 子元素间移动会反复触发 leave——「真正离开」的判据住在 panel-drop（relatedTarget 仍在容器内即不动）
      const stillInside = e.currentTarget.contains(e.relatedTarget as Node | null);
      setDropTarget((cur) => nextDropTarget(cur, { type: 'dragleave', container, stillInside }));
    },
    onDrop: (e: ReactDragEvent) => {
      const raw = e.dataTransfer.getData(PANEL_DRAG_MIME);
      setDropTarget((cur) => nextDropTarget(cur, { type: 'dropped' }));
      if (!raw) return;
      e.preventDefault();
      for (const intent of planPanelMoves(decodeDroppedPanelIds(raw), allPanels, container)) {
        dispatch({ type: 'move', id: intent.id, to: intent.to, viewKey: intent.viewKey });
      }
    },
  });
  const dragEnd = (): void => setDropTarget((cur) => nextDropTarget(cur, { type: 'dragend' }));

  const doReset = useCallback(() => {
    resetLayout();
    dispatch({ type: 'reset', state: defaultLayout(organizePanels(allPanels, {})) });
  }, [allPanels]);
  const doResetRef = useRef(doReset);
  doResetRef.current = doReset;

  const runToolbarCommand = useCallback(
    (commandId: string) => {
      const cmd = registry.find((c) => c.id === commandId);
      if (!cmd) return;
      try {
        if (cmd.when && !cmd.when(commandCtx)) return;
        void cmd.run(commandCtx);
      } catch (e: unknown) {
        console.warn(`[ShellLayout] 工具栏命令 '${commandId}' 执行失败：${errorText(e)}`);
      }
    },
    [registry, commandCtx],
  );

  /* ------------------------------ 渲染片段 ------------------------------ */

  const activeView = org.views.find((v) => v.key === layout.sidebar.active) ?? org.views[0] ?? null;
  const activeAux = org.aux.find((p) => p.id === layout.aux.active) ?? org.aux[0] ?? null;
  const activeBottom = org.bottom.find((p) => p.id === layout.bottom.active) ?? org.bottom[0] ?? null;

  /** 侧栏组内折叠状态（会话级，不持久化——定稿 §七持久化清单不含组内折叠） */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleCollapse = (panelId: string): void =>
    setCollapsed((prev) => ({ ...prev, [panelId]: !prev[panelId] }));

  /* -------------------- 右键菜单：壳层七面的能力面（WP3.7 / 4.1 / 4.2 / 4.3） -------------------- */

  /**
   * 菜单动作要读的**当下**状态（活动面板 / 浮窗几何 / 折叠位 / 换行符落地入口）。
   *
   * 走 ref 而不是把 layout 塞进 `useMemo` 依赖：宿主对象必须**引用稳定**
   * （`installShellMenuHost` 只注入一次），而布局每拖一次都换对象——若把 layout 写进依赖，
   * 每次布局变化都会重装一次宿主，菜单开着时正好点下去就可能落在被卸下的那份上。
   */
  const menuStateRef = useRef({ layout, allPanels, org, collapsed, onSwitchEol });
  menuStateRef.current = { layout, allPanels, org, collapsed, onSwitchEol };

  /** 浮窗几何按当前视口取（最大化判据与重置都现场算，窗口改过尺寸不吃旧值） */
  const menuViewport = (): { w: number; h: number } => ({ w: window.innerWidth, h: window.innerHeight });

  const shellMenuHost = useMemo<ShellMenuHost>(
    () => ({
      snapshot: () => {
        const state = menuStateRef.current;
        const status = getShellEditorStatus();
        return {
          floating: state.layout.floating,
          sidebarVisible: state.layout.sidebar.visible,
          activeViewKey: state.layout.sidebar.active,
          eol: status === null ? null : status.eol === 'CRLF' ? 'CRLF' : 'LF',
          canSwitchEol: status?.eolSwitchable === true && state.onSwitchEol !== undefined,
        };
      },
      containerOf: (panelId) => {
        const panel = menuStateRef.current.allPanels.find((p) => p.id === panelId);
        if (panel === undefined) return null;
        return effectiveLocation(panel, menuStateRef.current.layout.panelLocations);
      },
      panelsOfView: (viewKey) =>
        menuStateRef.current.org.views.find((v) => v.key === viewKey)?.panels.map((p) => p.id) ?? [],
      isCollapsed: (panelId) => menuStateRef.current.collapsed[panelId] === true,
      closeContainer: (container) => dispatch({ type: 'toggle', container }),
      float: (panelId) => floatPanel(panelId),
      dock: (panelId) => dispatch({ type: 'dock', id: panelId }),
      move: (panelId, to: ShellContainerTarget) => {
        const panel = menuStateRef.current.allPanels.find((p) => p.id === panelId);
        if (panel === undefined) return;
        // 与拖拽停靠同一条意图（viewKey 口径由 planPanelMoves 统一算，不在这里另写一遍）
        for (const intent of planPanelMoves([panelId], [panel], to)) {
          dispatch({ type: 'move', id: intent.id, to: intent.to, viewKey: intent.viewKey });
        }
      },
      maximizeFloat: (panelId) => {
        const rect = maximizedFloatRect(menuViewport());
        dispatch({ type: 'moveFloating', id: panelId, x: rect.x, y: rect.y });
        dispatch({ type: 'resizeFloating', id: panelId, w: rect.w, h: rect.h });
      },
      resetFloat: (panelId) => {
        const rect = defaultFloatRect(0, menuViewport());
        dispatch({ type: 'moveFloating', id: panelId, x: rect.x, y: rect.y });
        dispatch({ type: 'resizeFloating', id: panelId, w: rect.w, h: rect.h });
      },
      toggleCollapse: (panelId) => toggleCollapse(panelId),
      resetLayout: () => doResetRef.current(),
      switchEol: (eol) => menuStateRef.current.onSwitchEol?.(eol),
      toggleSidebarView: (viewKey) =>
        dispatch(
          menuStateRef.current.layout.sidebar.visible && menuStateRef.current.layout.sidebar.active === viewKey
            ? { type: 'toggle', container: 'sidebar' }
            : { type: 'activate', container: 'sidebar', key: viewKey },
        ),
    }),
    // 全部方法读 ref / 稳定回调（dispatch、floatPanel、doResetRef），宿主因此只注入一次
    [floatPanel],
  );
  useEffect(() => installShellMenuHost(shellMenuHost), [shellMenuHost]);

  /* -------- 侧栏多面板弹性分栏（用户反馈：口上文件/函数树默认 50/50，可上下拉伸） -------- */

  /** 各视图的分栏权重（会话级，与组内折叠同级不持久化；缺省 = 全 1 等分） */
  const [splitWeights, setSplitWeights] = useState<Record<string, number[]>>({});
  const splitRef = useRef<HTMLDivElement | null>(null);

  /**
   * 分栏把手拖拽（PS-6 第 2 项的另一半）：调整第 i / i+1 两个展开面板的权重
   * （总和守恒，带最小权重钳制）。
   *
   * 与容器尺寸同款口径：**拖拽期只写两节的 `flex-grow`，松手才 `setSplitWeights` 一次**。
   * 旧实现每次 mousemove 都 setSplitWeights ⇒ 整个 ShellLayout（含编辑器区）重渲染一遍。
   */
  const startSectionDrag = (e: ReactPointerEvent<HTMLElement>, view: ViewDef, i: number): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const container = splitRef.current;
    if (!container) return;
    const totalPx = container.clientHeight;
    if (totalPx <= 0) return;
    const n = view.panels.length;
    const cur = splitWeights[view.key] ?? Array.from({ length: n }, () => 1);
    const handle = e.currentTarget;
    const pointerId = e.pointerId;
    handle.setPointerCapture?.(pointerId);
    const panelA = view.panels[i];
    const panelB = view.panels[i + 1];
    const session = beginSplitResize({
      targets: [
        panelA ? sectionElsRef.current.get(panelA.id) : undefined,
        panelB ? sectionElsRef.current.get(panelB.id) : undefined,
      ],
      weights: cur,
      index: i,
      totalPx,
      startPos: e.clientY,
    });
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      session.onMove(ev.clientY);
    };
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      const next = session.finish();
      if (next !== null) setSplitWeights((prev) => ({ ...prev, [view.key]: next }));
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  /* -------------------- UI-4：活动栏 / 标签条方向键漫游（roving tabindex） -------------------- */

  /** 活动栏视图项按 DOM 顺序（常规组 + 低频组）——方向键漫游的索引基准 */
  const abHighFreq = org.views.filter((v) => !isLowFreqView(v));
  const abLowFreq = org.views.filter(isLowFreqView);
  const abViewList = [...abHighFreq, ...abLowFreq];
  /** 活动栏 roving 的 tab 落点：当前激活视图；不在列表（视图被清空/迁移）则回退首项 */
  const abTabKey = abViewList.some((v) => v.key === layout.sidebar.active)
    ? layout.sidebar.active
    : abViewList[0]?.key;

  /** 活动栏方向键：移动焦点并同步激活该视图（Enter/Space 仍由按钮原生活化） */
  const activityKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = nextRovingIndex(index, abViewList.length, e.key);
    if (next === null) return; // 非漫游键：原样让位（Enter/Space/Tab 不该被吞）
    e.preventDefault();
    const view = abViewList[next];
    if (!view) return;
    if (view.key !== layout.sidebar.active) {
      dispatch({ type: 'activate', container: 'sidebar', key: view.key });
    }
    // 落点在视图项之内（设置按钮排在 `.ab-item` 序列末尾，next 不会落到它）
    const btns = e.currentTarget.closest('nav')?.querySelectorAll<HTMLButtonElement>('.ab-item');
    if (btns) Array.from(btns)[next]?.focus();
  };

  /** 标签条方向键：移动焦点并同步激活该面板（role=tablist 自动激活，与鼠标点击同语义） */
  const tabStripKeyDown = (
    e: ReactKeyboardEvent<HTMLButtonElement>,
    container: 'aux' | 'bottom',
    items: readonly UIPanelContribution[],
    index: number,
  ): void => {
    const next = nextRovingIndex(index, items.length, e.key);
    if (next === null) return;
    e.preventDefault();
    const tab = items[next];
    if (!tab) return;
    dispatch({ type: 'activate', container, key: tab.id });
    const tabs = e.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    if (tabs) Array.from(tabs)[next]?.focus();
  };

  const activityBar = (
    <nav
      className={`activitybar ${dropTarget === 'sidebar' ? 'drop-target' : ''}`}
      aria-label="活动栏"
      // 右键面根（1023 覆盖面批 · WP4.1）：图标按钮自带 data-view-key，菜单据此认「点的是哪个视图」
      data-context-surface="activity-bar"
      {...dropProps('sidebar')}
    >
      {abHighFreq.map((v, i) => (
        <button
          key={v.key}
          className={`ab-item ${layout.sidebar.visible && v.key === layout.sidebar.active ? 'active' : ''}`}
          title={`${v.title}（可拖拽到其他容器）`}
          data-view-key={v.key}
          draggable
          tabIndex={v.key === abTabKey ? 0 : -1}
          onKeyDown={(e) => activityKeyDown(e, i)}
          onDragStart={(e) => startPanelDrag(e, v.panels.map((p) => p.id))}
          onDragEnd={dragEnd}
          onClick={() =>
            dispatch(
              v.key === layout.sidebar.active
                ? { type: 'toggle', container: 'sidebar' }
                : { type: 'activate', container: 'sidebar', key: v.key },
            )
          }
        >
          <Icon name={v.icon ?? v.title.slice(0, 1)} size={22} />
        </button>
      ))}
      <span className="ab-spacer" />
      {abLowFreq.map((v, i) => (
        <button
          key={v.key}
          className={`ab-item ${layout.sidebar.visible && v.key === layout.sidebar.active ? 'active' : ''}`}
          title={`${v.title}（可拖拽到其他容器）`}
          data-view-key={v.key}
          draggable
          tabIndex={v.key === abTabKey ? 0 : -1}
          onKeyDown={(e) => activityKeyDown(e, abHighFreq.length + i)}
          onDragStart={(e) => startPanelDrag(e, v.panels.map((p) => p.id))}
          onDragEnd={dragEnd}
          onClick={() =>
            dispatch(
              v.key === layout.sidebar.active
                ? { type: 'toggle', container: 'sidebar' }
                : { type: 'activate', container: 'sidebar', key: v.key },
            )
          }
        >
          <Icon name={v.icon ?? v.title.slice(0, 1)} size={22} />
        </button>
      ))}
      <button className="ab-item" title="设置" onClick={() => { setSettingsSection('general'); setSettingsOpen(true); }}>
        <Icon name="settings" size={22} />
      </button>
    </nav>
  );

  const sidebarView = activeView && activeView.panels.length > 1 ? (
    /* 多面板视图：弹性分栏（默认等分；把手上下拉伸；折叠的头只占标题行） */
    <div ref={splitRef} className="sidebar-views split">
      {activeView.panels.map((p, i) => {
        const isCollapsed = collapsed[p.id] === true;
        const weights = splitWeights[activeView.key] ?? activeView.panels.map(() => 1);
        const nextPanel = activeView.panels[i + 1];
        const showSplitter =
          !isCollapsed && nextPanel !== undefined && collapsed[nextPanel.id] !== true;
        return (
          <Fragment key={p.id}>
            <section
              className="sidebar-section"
              ref={(node) => {
                // 分栏拖拽要往这两节写内联 flex-grow（PS-6）；折叠节没把手，登记了也不碍事
                if (node) sectionElsRef.current.set(p.id, node);
                else sectionElsRef.current.delete(p.id);
              }}
              style={isCollapsed ? undefined : { flexGrow: weights[i] ?? 1, flexBasis: 0 }}
            >
              <button
                className="sidebar-section-head"
                title={`${p.title}（可拖拽到其他容器）`}
                // 右键面根（WP3.7 分区头）：data-panel-id 让菜单知道「是哪一节」；
                // 「折叠 / 展开」的文案由宿主按会话折叠态给（状态真源仍在 React 这边）
                data-context-surface="panel-section-header"
                data-panel-id={p.id}
                draggable
                onDragStart={(e) => startPanelDrag(e, [p.id])}
                onDragEnd={dragEnd}
                onClick={() => toggleCollapse(p.id)}
              >
                <span className="caret">
                  <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={12} />
                </span>
                <span>{p.title}</span>
              </button>
              {isCollapsed ? null : (
                <PanelBody contribution={p} uiPrefs={uiPrefs} hostVersion={panelHostVersions?.[p.id]} />
              )}
            </section>
            {showSplitter ? (
              <div
                className="resizer resizer-y section-splitter"
                role="separator"
                aria-label={`调整 ${p.title} 高度`}
                onPointerDown={(e) => startSectionDrag(e, activeView, i)}
              />
            ) : null}
          </Fragment>
        );
      })}
    </div>
  ) : (
    <div className="sidebar-views">
      {activeView && activeView.panels[0] ? (
        <PanelBody
          contribution={activeView.panels[0]}
          uiPrefs={uiPrefs}
          hostVersion={panelHostVersions?.[activeView.panels[0].id]}
        />
      ) : null}
    </div>
  );

  const tabStrip = (container: 'aux' | 'bottom', items: readonly UIPanelContribution[], activeId: string | null): ReactElement => (
    <div
      className="panel-tabs"
      role="tablist"
      // 右键面根（WP3.7 面板选项卡）：容器写在这里（aux/bottom 共用这一个函数），
      // 空白处右键按「当前激活的那颗面板」出菜单——与条尾的 ✕ / 浮动按钮同一个受作用者
      data-context-surface="panel-tabs"
      data-panel-tabs-container={container}
      data-active-panel={activeId ?? ''}
    >
      {items.map((p, i) => (
        <button
          key={p.id}
          role="tab"
          aria-selected={p.id === activeId}
          tabIndex={p.id === activeId ? 0 : -1}
          className={`panel-tab ${p.id === activeId ? 'active' : ''}`}
          title={`${p.title}（可拖拽到其他容器）`}
          data-panel-id={p.id}
          draggable
          onKeyDown={(e) => tabStripKeyDown(e, container, items, i)}
          onDragStart={(e) => startPanelDrag(e, [p.id])}
          onDragEnd={dragEnd}
          onClick={() => dispatch({ type: 'activate', container, key: p.id })}
        >
          {p.title}
        </button>
      ))}
      <span className="spacer" />
      <button
        className="ghost small panel-float"
        title="浮动到大窗口"
        disabled={!activeId}
        onClick={() => { if (activeId) floatPanel(activeId); }}
      >
        <Icon name="popout" size={14} />
      </button>
      <button
        className="ghost small panel-close"
        title="关闭面板"
        onClick={() => dispatch({ type: 'toggle', container })}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );

  /** 「更多」菜单的项表（模块内常量：身份稳定，ContextMenu 不因每帧新数组重排焦点） */
  const projectMenuItems: ContextMenuItem[] = [{ id: 'project.close', label: '关闭项目', danger: true }];

  const toolbar = (
    <header className="toolbar" data-context-surface="toolbar">
      <div className="toolbar-left">
        {/* 项目位显示**目录名**而不是适配器 id（视觉批十六）：适配器 id 是机器名，
            作者认不出自己打开的是哪一份；完整路径仍进悬停。取不出目录名才退回 adapterId。 */}
        {commandCtx.project ? (
          <span className="tb-project" title={commandCtx.project.rootDir}>
            {projectDirName(commandCtx.project.rootDir) ?? commandCtx.project.adapterId}
          </span>
        ) : null}
        {onCloseProject ? (
          // 破坏性动作收拢进项目名旁的「更多」菜单（C-1a）：不再与视图开关混在一排；
          // 快捷键与命令行为不变，这里只是换了个入口。可访问名与 aria 态齐全。
          <button
            className="ghost small toolbar-btn tb-project-more"
            title="项目操作（关闭项目）"
            aria-label="项目操作"
            aria-haspopup="menu"
            aria-expanded={projectMenuAt !== null}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setProjectMenuAt({ x: r.left, y: r.bottom + 2 });
            }}
          >
            <Icon name="more-horizontal" size="sm" />
          </button>
        ) : null}
        {onReloadProject ? (
          <button className="ghost small toolbar-btn" title="重载项目" onClick={onReloadProject}>
            <Icon name="refresh" size={15} />
          </button>
        ) : null}
        {toolbarItems.map((t) => {
          const cmd = registry.find((c) => c.id === t.command);
          let enabled = false;
          if (cmd) {
            enabled = true;
            if (cmd.when) {
              try {
                enabled = cmd.when(commandCtx);
              } catch {
                enabled = false;
              }
            }
          }
          return (
            <button
              key={t.id}
              className="ghost small toolbar-btn"
              title={t.title}
              // 右键面根（WP4.2 工具条）：「复制命令标题 / 命令 ID」只对挂了命令的贡献按钮成立
              data-toolbar-command={t.command}
              data-toolbar-title={t.title}
              disabled={!enabled}
              onClick={() => runToolbarCommand(t.command)}
            >
              {t.icon ? <Icon name={t.icon} size={14} /> : null}
              {t.title}
            </button>
          );
        })}
      </div>
      {/* 分组分隔（C-1a）：左簇 = 项目操作，右簇 = 纯视图开关 */}
      <span className="toolbar-sep" aria-hidden="true" />
      <div className="toolbar-right">
        <button
          className={`ghost small toolbar-btn ${layout.sidebar.visible ? 'on' : ''}`}
          title="切换主侧栏 (Ctrl+B)"
          onClick={() => dispatch({ type: 'toggle', container: 'sidebar' })}
        >
          <Icon name="layout-sidebar-left" size={15} />
        </button>
        <button
          className={`ghost small toolbar-btn ${layout.bottom.visible ? 'on' : ''}`}
          title="切换底部区 (Ctrl+J)"
          onClick={() => dispatch({ type: 'toggle', container: 'bottom' })}
        >
          <Icon name="layout-panel-bottom" size={15} />
        </button>
        <button
          className={`ghost small toolbar-btn ${layout.aux.visible ? 'on' : ''}`}
          title="切换副侧栏 (Ctrl+Alt+B)"
          onClick={() => dispatch({ type: 'toggle', container: 'aux' })}
        >
          <Icon name="layout-sidebar-right" size={15} />
        </button>
        {/* 「重置布局」不再占工具条一排（与设置页/命令面板重复，C-1a）：
            功能仍在——命令 `layout.reset`（ShellLayout 注册）与设置页 `onResetLayout={doReset}` 两个入口。 */}
      </div>
      {projectMenuAt !== null && onCloseProject ? (
        <ContextMenu
          x={projectMenuAt.x}
          y={projectMenuAt.y}
          items={projectMenuItems}
          ariaLabel="项目操作"
          onSelect={(id) => {
            setProjectMenuAt(null);
            if (id === 'project.close') onCloseProject();
          }}
          onDismiss={() => setProjectMenuAt(null)}
        />
      ) : null}
    </header>
  );

  /**
   * 状态栏那颗可写胶囊（2026-10-14 去重 + 区域化）。
   *
   * 依据是**当前打开文件落在哪一区**，判定走 `file-area.ts`——与编辑器的只读分野同一把尺子，
   * 不在这里另写一份（工具条上那颗同色胶囊已删，两处并排等于互相抢答；它原本独载的
   * 解释性文字也一并迁到这里，别丢信息）。
   * 区域答不出（没打开文件 / 区域外的非 ERB）才回落到项目级 `writable`。
   */
  // PS-6：memo 在 kernel + activeFile 上——`fileWritableArea` 每次调用都要
  // `workspaceRootsOf(kernel)`（内核那侧现拼一份根数组），路径没换答案就不会换，
  // 不该跟着壳层的每一次重渲重算一遍。
  const writableArea = useMemo(() => fileWritableArea(kernel, activeFile ?? null), [kernel, activeFile]);
  const writablePill = writablePillTone(writableArea, writable);
  const writablePillTitle =
    writableArea === 'workspace'
      ? '这份文件在你的工作项目区（你自己写的口上文件），可以直接保存。'
      : writableArea === 'game-erb'
        ? '口上区（游戏目录）里的原生文件：默认只读——直接改它等于改别人装好的游戏内容。开始输入时编辑器会询问你是否破例；点击这里可重新批准写权限。'
        : writable
          ? '写权限已批准'
          : '只读：写权限未批准，点击重新授权';

  /**
   * 状态栏**次组**（项目级约定计数 `.sb-diag`）的展开态（视觉批十一 R5 · 密度分主次）。
   *
   * 真壳读数：左簇并排两串三档计数（项目 ⚠2843 / 已打开 ⚠647），六个数字挨在一起，
   * 反而读不出"谁数的是什么"。口径：`.sb-problems`（作者此刻要对的那一本）常驻原样，
   * 项目级常态账静息只留「项目」标签 + 在途状态词，三档数字由这颗 ▸ 点开（贴在它前面）。
   * 收起是**视觉隐藏**（clip 配方在 `shell-notices.css`），DOM 里逐档都在 ⇒ 读屏念得完、
   * 那一格的右键复制也还在；`error > 0 / 这轮失败`那两格由插件上内联色 ⇒ 永不收起。
   * 会话级、不进布局持久化：这是一次"看一眼"，不是要记住的偏好。
   */
  const [secondaryCountsOpen, setSecondaryCountsOpen] = useState(false);
  const hasSecondaryCounts = statusbarItems.some((s) => (s.align ?? 'right') === 'left');

  const statusbar = (
    <footer
      className={`statusbar ${layout.zen ? 'zen' : ''}`}
      data-context-surface="status-bar"
      data-sb-secondary={secondaryCountsOpen ? 'open' : 'collapsed'}
    >
      <div className="sb-left">
        {writablePill === 'ok' ? (
          <span className="sb-writable ok" data-status-cell="" title={writablePillTitle}>
            可写
          </span>
        ) : (
          // 只读态加锁形图标（C-1a）：琥珀色 + 文字之外再多一档形状线索；命中区 ≥24px 由 CSS 保证
          <button className="sb-writable ro" data-status-cell="" title={writablePillTitle} onClick={onReauth}>
            <LockIcon /> 只读
          </button>
        )}
        {/* 次组（项目级约定计数）的展开/收起：紧贴它管的那一串，读作「▸ 项目 …」 */}
        {hasSecondaryCounts ? (
          <button
            type="button"
            className="ghost small shell-sb-toggle"
            aria-expanded={secondaryCountsOpen}
            aria-label={secondaryCountsOpen ? '收起项目级约定计数' : '展开项目级约定计数'}
            title={
              secondaryCountsOpen
                ? '收起项目级约定计数（同排右边那三档是已打开文件的波浪线，两本数口径不同）'
                : '展开项目级约定计数（含未打开文件与整项目结论 ≠ 波浪线计数）；静息只留标签，读数一条不丢'
            }
            onClick={() => setSecondaryCountsOpen((v) => !v)}
          >
            <Icon name={secondaryCountsOpen ? 'chevron-down' : 'chevron-right'} size={12} />
          </button>
        ) : null}
        {statusbarItems
          .filter((s) => (s.align ?? 'right') === 'left')
          .map((s) => (
            <StatusbarItem key={s.id} contribution={s} />
          ))}
        {/* 问题计数小件（HK-4 · UI-6）：与约定校验的 `.sb-diag` 相邻；点击打开问题面板 */}
        <ProblemsStatusItem onClick={() => dispatch({ type: 'activate', container: 'bottom', key: 'kojo.problems' })} />
        {!layout.zen &&
          (stats.indexError ? (
            // 第一眼只说状态（原文已由打开项目那条通知说过一遍——一处状态只占一格）；
            // 原始错误（路径 + 英文栈式片段）逐字留在悬停里，技术信息一条不丢
            //（口径同 `ui-kojo-navigator` 的 `panel-copy.ts`：首句人话，原文进 title）。
            // 2026-10-20 复核：常驻 chrome 只有四个字 + 悬停看原因是**刻意的**（用户认可维持现状），
            // 别把它当成"状态栏信息不足"来补长——同一状态只在通知那一处占格。
            <span className="sb-idx err" data-status-cell="" title={`索引失败：${stats.indexError}`}>
              索引失败
            </span>
          ) : stats.indexing ? (
            <span className="sb-idx" data-status-cell="">索引构建中…</span>
          ) : (
            <span className="sb-idx" data-status-cell="">
              {stats.fileCount} 文件 · {stats.fnCount} 函数
            </span>
          ))}
      </div>
      <div className="sb-right">
        {statusbarItems
          .filter((s) => (s.align ?? 'right') === 'right')
          .map((s) => (
            <StatusbarItem key={s.id} contribution={s} />
          ))}
        {/* PS-6：这三格读的是壳层状态 store（见 `setShellEditorStatus`），
            光标移动只重渲这一枚小叶子，不再掀整壳。没读数 ⇒ 不画（旧口径一致）。 */}
        <EditorStatusReadout
          onSwitchEol={onSwitchEol}
          activeFile={activeFile ?? null}
          dirty={dirty}
          encodingActions={statusEncodingActions}
          onError={(message) => notify({ kind: 'error', message })}
        />
        {/* 脏读数（C-1a 语义修正）：只读态下「已保存」是误导——这份文件根本走不了保存；
            没有改动时如实说「未修改」。有未保存改动仍显示「未保存」（那是事实）。 */}
        <span
          className={`sb-dirty ${dirty ? 'on' : ''}`}
          data-status-cell=""
          title={dirty ? '有未保存修改' : writablePill === 'ro' ? '当前文件只读，没有改动' : '已保存'}
        >
          {dirty ? (
            <>
              <Icon name="circle-filled" size={9} /> 未保存
            </>
          ) : writablePill === 'ro' ? (
            '未修改'
          ) : (
            '已保存'
          )}
        </span>
      </div>
    </footer>
  );

  /* ------------------------------ 浮层（picker + overlay） ------------------------------ */

  const overlayContribution = activeOverlay
    ? (overlayItems.find((o) => o.id === activeOverlay.id) ?? null)
    : null;
  /** 正在退场的那一份（关掉后 200ms 内仍在 DOM 里，挂 `.ov-exiting` 播 `overlay-out`） */
  const exitingOverlay =
    exitingOverlayId === null ? null : (overlayItems.find((o) => o.id === exitingOverlayId) ?? null);
  const shownOverlay = overlayContribution ?? exitingOverlay;
  const overlays = (
    <>
      {paletteOpen ? (
        <CommandPalette commands={registry} commandCtx={commandCtx} onClose={() => setPaletteOpen(false)} />
      ) : null}
      {quickOpen && quickOpenFiles && onOpenFile ? (
        <QuickOpen
          files={quickOpenFiles}
          {...(quickOpenRecent !== undefined ? { recent: quickOpenRecent } : {})}
          commands={registry}
          commandCtx={commandCtx}
          activeFileSymbols={activeFileSymbols ?? NO_ACTIVE_FILE_SYMBOLS}
          activeFile={activeFile ?? null}
          onOpenFile={onOpenFile}
          onReveal={revealLine}
          onClose={() => setQuickOpen(false)}
        />
      ) : null}
      {symbolsOpen ? (
        <WorkspaceSymbols
          fetchSymbols={fetchWorkspaceSymbols}
          notice={workspaceSymbolNoticeFor}
          onPickSymbol={revealWorkspaceSymbol}
          onClose={() => setSymbolsOpen(false)}
        />
      ) : null}
      {shownOverlay ? (
        <div
          className={`overlay-backdrop${overlayContribution === null ? ' ov-closing' : ''}`}
          aria-hidden={overlayContribution === null ? true : undefined}
          onMouseDown={(e) => {
            // 只认左键：右键要弹浮层自己的菜单，不能先把浮层关掉
            // ——关掉之后根路由再收到 contextmenu，面已经不在场了
            if (!isPrimaryButton(e) || overlayContribution === null) return;
            dismissOverlay();
          }}
        >
          <div
            className={`overlay-host${overlayContribution?.size === 'wide' ? ' overlay-host-wide' : ''}${
              overlayContribution === null ? ' ov-exiting' : ''
            }`}
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* 浮层与面板同一条偏好通道（`UiPrefs`）：2.0 新建向导是 `ui.overlay` 贡献，
                它要知道宿主这侧 2.0 面开没开、扩展名是哪个（K2-EDITOR-OPEN-PATHS）。 */}
            <PanelBody contribution={shownOverlay} uiPrefs={uiPrefs} />
          </div>
        </div>
      ) : null}
      {settingsPresence.mounted ? (
        <SettingsPanel
          exiting={settingsPresence.exiting}
          onClose={() => setSettingsOpen(false)}
          initialSection={settingsSection}
          commands={registry}
          zen={layout.zen}
          zenLimitWidth={layout.zenLimitWidth}
          dispatch={dispatch}
          onResetLayout={doReset}
          themePref={themePref}
          motionPref={motionPref}
          commitMotionPref={commitMotionPref}
          panelVirtualize={panelVirtualize}
          glassTransparency={glassTransparency}
          sealed={sealed}
          nameColorOn={nameColorOn}
          fontSize={fontSize}
          fontZoom={fontZoom}
          quickSuggestionsOn={quickSuggestionsOn}
          commitQuickSuggestions={commitQuickSuggestions}
          wordSuggestionsOn={wordSuggestionsOn}
          commitWordSuggestions={commitWordSuggestions}
          suggestDelay={suggestDelay}
          commitSuggestDelay={commitSuggestDelay}
          sugarViewOn={sugarViewOn}
          applySugarViewPref={applySugarViewPref}
          formatOnSave={formatOnSave}
          commitFormatOnSave={commitFormatOnSave}
          codeLensOn={codeLensOn}
          commitCodeLens={commitCodeLens}
          autosaveMode={autosaveMode}
          directMode={directMode}
          marketSource={marketSource}
          marketEndpointDraft={marketEndpointDraft}
          setMarketEndpointDraft={setMarketEndpointDraft}
          saveMarketEndpoint={saveMarketEndpoint}
          resetMarketEndpoint={resetMarketEndpoint}
          appVersion={appVersion}
          updatePhase={updatePhase}
          updateStatusLine={updateStatusLine}
          runUpdateCheck={runUpdateCheck}
          installUpdate={installUpdate}
        />
      ) : null}
      {/* 更新弹窗（用户反馈第 1 条）：放在最后 ⇒ 与设置/向导同 z 时压在最上面；
          zen 与常规形态共用这一份 overlays，两种形态都看得见。 */}
      {updateDialog ? (
        <UpdateDialog phase={updateDialog} onClose={closeUpdateDialog} onInstall={installUpdate} />
      ) : null}
    </>
  );

  /* ------------------------------ 全禅形态 ------------------------------ */

  if (layout.zen) {
    return (
      <div className="shell zen">
        <div className="zen-editor">
          <div className={`zen-editor-inner ${layout.zenLimitWidth ? '' : 'no-limit'}`}>{children}</div>
        </div>
        {statusbar}
        {overlays}
      </div>
    );
  }

  /* ------------------------------ 常规形态 ------------------------------ */

  return (
    <div className="shell">
      {toolbar}
      <div className="shell-main">
        {activityBar}
        {layout.sidebar.visible && activeView ? (
          <>
            <aside
              className={`sidebar ${dropTarget === 'sidebar' ? 'drop-target' : ''}`}
              ref={(node) => {
                shellElsRef.current.sidebar = node;
              }}
              style={{ width: layout.sidebar.size }}
              {...dropProps('sidebar')}
            >
              {sidebarView}
            </aside>
            <div
              className="resizer resizer-x"
              role="separator"
              aria-label="调整主侧栏宽度"
              onPointerDown={(e) => startDrag(e, 'sidebar', true, 1)}
            />
          </>
        ) : null}
        <main className="editor-area">{children}</main>
        {layout.aux.visible && activeAux ? (
          <>
            <div
              className="resizer resizer-x"
              role="separator"
              aria-label="调整副侧栏宽度"
              onPointerDown={(e) => startDrag(e, 'aux', true, -1)}
            />
            <aside
              className={`aux ${dropTarget === 'aux' ? 'drop-target' : ''}`}
              ref={(node) => {
                shellElsRef.current.aux = node;
              }}
              style={{ width: layout.aux.size }}
              {...dropProps('aux')}
            >
              {tabStrip('aux', org.aux, layout.aux.active)}
              <div className="container-body">
                <PanelBody
                  contribution={activeAux}
                  uiPrefs={uiPrefs}
                  hostVersion={panelHostVersions?.[activeAux.id]}
                />
              </div>
            </aside>
          </>
        ) : null}
      </div>
      {layout.bottom.visible && activeBottom ? (
        <>
          <div
            className="resizer resizer-y"
            role="separator"
            aria-label="调整底部区高度"
            onPointerDown={(e) => startDrag(e, 'bottom', false, -1)}
          />
          <section
            className={`bottombar ${dropTarget === 'bottom' ? 'drop-target' : ''}`}
            ref={(node) => {
              shellElsRef.current.bottom = node;
            }}
            style={{ height: layout.bottom.size }}
            {...dropProps('bottom')}
          >
            {tabStrip('bottom', org.bottom, layout.bottom.active)}
            <div className="container-body">
              <PanelBody
                contribution={activeBottom}
                uiPrefs={uiPrefs}
                hostVersion={panelHostVersions?.[activeBottom.id]}
              />
            </div>
          </section>
        </>
      ) : null}
      {statusbar}
      {floatingPanels.map((p) => {
        const f = layout.floating[p.id];
        if (!f) return null;
        return (
          <section
            key={p.id}
            ref={(node) => {
              const els = floatElsRef.current;
              if (node) els.set(p.id, node);
              else els.delete(p.id);
            }}
            className="floating-panel"
            style={{ left: f.x, top: f.y, width: f.w, height: f.h }}
            aria-label={p.title}
            // 右键面根（浮窗）：整个窗口（标题栏 + 内容区）都算，菜单认 data-floating-panel-id
            data-context-surface="floating-window"
            data-floating-panel-id={p.id}
          >
            <header className="floating-panel-head" onPointerDown={(e) => startFloatDrag(e, p.id)}>
              <Icon name={p.icon ?? 'preview'} size={14} />
              <span className="floating-panel-title">{p.title}</span>
              <span className="spacer" />
              <button
                className="ghost small floating-panel-action"
                title="关闭浮窗（回到侧栏）"
                onClick={() => dispatch({ type: 'dock', id: p.id })}
              >
                <Icon name="close" size={14} />
              </button>
            </header>
            <div className="floating-panel-body">
              <PanelBody
                contribution={p}
                floating
                uiPrefs={uiPrefs}
                hostVersion={panelHostVersions?.[p.id]}
              />
            </div>
            {/* 四角 + 四边缩放把手：默认隐形，hover / 聚焦时显形；光标方向由 fp-<dir> 类给 */}
            {RESIZE_HANDLES.map((dir) => (
              <div
                key={dir}
                className={`floating-panel-resize fp-${dir}`}
                role="button"
                tabIndex={0}
                title="拖拽调整大小"
                aria-label="调整浮窗大小"
                onPointerDown={(e) => startFloatResize(e, p.id, dir)}
                onKeyDown={(e) => resizeKeyDown(e, p.id, dir)}
              />
            ))}
          </section>
        );
      })}
      {overlays}
    </div>
  );
}
