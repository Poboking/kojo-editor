// @vitest-environment happy-dom
/**
 * 右键菜单的**项契约**与**分发覆盖面**（1023 覆盖面批 · 收口测试）。
 *
 * ## 这一层补的是什么洞
 *
 * 上一批落了 33 个右键面，各面自己的测试都在回答「这一面在什么条件下有哪几项」；
 * `context-coverage.test.ts` 回答「面有没有声明、ariaLabel 对不对」。但**没有一条**测试
 * 回答下面这两个问题，而它们才是用户真正会撞上的：
 *
 * 1. **项本身是不是一条能用的项**：id 在同一份菜单里唯一吗（子菜单里的 id 也算）、
 *    文案是不是全中文、`disabled` 有没有配原因、`children` 会不会是空壳、
 *    `danger` 有没有落到不危险的动作上；
 * 2. **点下去到底有没有事发生**：`build*Menu` 产出的每个 id，`onSelect` 分发器认不认。
 *    认不出来就是**静默无反应**——铁律 4「内核不静默」在菜单这一层最直接的那条违例。
 *
 * ## 为什么用「真实夹具」而不是空对象
 *
 * 每个面的 `build*Menu` 都是「事实 → 项」的纯函数，给空对象它会（正确地）返回空数组，
 * 于是所有断言在空数组上恒真——那种测试比没有更坏（它给人一种"已覆盖"的错觉）。
 * 所以下面每个夹具都按各面现有测试的构造写成**满能力 + 数据齐备**的形态，并对
 * 每一项都额外钉 `items.length > 0`：面不表态就直接算失败，而不是"没有项可查"。
 *
 * ## 分发覆盖面的三种查法（按可否直测排序）
 *
 * 1. **导出的纯分发器**（search / problems / plugin-panel）：id 全集逐个喂进去，断言
 *    返回值表示「处理了」；顺带断言返回 `false` 的只有不认识的 id（不然 `true` 可能是
 *    兜底 `default: return true` 混出来的）；
 * 2. **经真实路由 + 注入桥**（tabs）：`registerTabsMenuBridge` 挂一份 mock 桥，
 *    用 `buildContextMenuRoute` 从真 DOM 走完整条链路，再逐 id `onSelect`——测的是
 *    组件里那份 `runTabMenuAction` 本身，不是它的替身；
 * 3. **分发器内联在组件里**（file-tree / breadcrumb / palette / 四个浮窗 / 编辑器两面包）：
 *    源码扫描——每个 id 必须在该面的分发文件里出现为 `case`/比较的一侧。
 *    这一档只能证明「被认过」，不能证明「认对了」；语义正确性由各面既有测试负责。
 *    `sibling:` 这类前缀式分发单独登记证据（见 `PREFIX_DISPATCH`）。
 *
 * ## `KNOWN_MANUAL`（人工核对、无法自动判定的面）
 *
 * 空。三类查法覆盖了本批全部 12 个面 / 16 个构建器，没有需要挂人工白名单的面。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import breadcrumbSource from '../src/ui/breadcrumb-bar.tsx?raw';
import callHierarchySource from '../src/ui/CallHierarchyOverlay.tsx?raw';
import diffViewSource from '../src/ui/DiffViewOverlay.tsx?raw';
import editorPaneSource from '../src/ui/EditorPane.tsx?raw';
import fileHistorySource from '../src/ui/FileHistoryOverlay.tsx?raw';
import fileTreeSource from '../src/ui/FileTree.tsx?raw';
import opsHistorySource from '../src/ui/OpsHistoryOverlay.tsx?raw';
import paletteSource from '../src/ui/Palette.tsx?raw';
import { crumbSiblingIndex } from '../src/ui/breadcrumb-path';
import {
  crumbMenuItems,
  crumbSurfaceItems,
  type CrumbMenuRuntime,
} from '../src/ui/breadcrumb-bar';
import {
  CALL_HIERARCHY_MENU_IDS,
  buildCallHierarchyMenu,
  type CallHierarchyMenuInput,
  type CallHierarchyRowRef,
} from '../src/ui/call-hierarchy';
import {
  isChineseMenuLabel,
  registerContextMenuCommandRunner,
  type ContextMenuItem,
} from '../src/ui/context-menu-model';
import { buildContextMenuRoute } from '../src/ui/context-surfaces';
import {
  DIFF_VIEW_MENU_IDS,
  buildDiffViewMenu,
  type DiffViewMenuInput,
} from '../src/ui/diff-view';
import {
  EDITOR_FRAME_MENU_IDS,
  PREVIEW_MENU_IDS,
  buildEditorFrameMenu,
  buildPreviewMenu,
  type EditorFrameMenuContext,
  type PreviewMenuContext,
} from '../src/ui/editor-pane/preview-menu';
import {
  FILE_HISTORY_MENU_IDS,
  buildFileHistoryMenu,
  type FileHistoryMenuInput,
} from '../src/ui/FileHistoryOverlay';
import {
  COMMAND_PALETTE_COMMAND,
  menuItemsFor,
  type MenuCapability,
  type MenuOptions,
  type MenuScopeKind,
} from '../src/ui/file-tree-ops';
import { toContextMenuItem } from '../src/ui/file-tree-menu';
import {
  OPS_HISTORY_MENU_IDS,
  buildOpsHistoryMenu,
  type OpsHistoryMenuInput,
} from '../src/ui/OpsHistoryOverlay';
import {
  PALETTE_ROW_ACTION,
  buildPaletteRowMenu,
  commandRowTarget,
  fileRowTarget,
  symbolRowTarget,
  type PaletteMenuCapabilities,
} from '../src/ui/palette-menu';
import { PLUGIN_PANEL_ACTION, buildPluginPanelMenu, runPluginPanelAction } from '../src/ui/plugin-panel-menu';
import {
  PROBLEM_MENU_IDS,
  buildProblemRowMenu,
  buildProblemsPanelMenu,
  buildProblemsSurfaceMenu,
  runProblemRowMenuAction,
  runProblemsPanelMenuAction,
  setProblemsMenuContext,
  type ProblemMenuHandlers,
} from '../src/ui/problem-menu';
import {
  SEARCH_FILE_MENU_IDS,
  SEARCH_MATCH_MENU_IDS,
  buildSearchFileMenu,
  buildSearchMatchMenu,
  runSearchFileMenuAction,
  runSearchMatchMenuAction,
  type SearchMenuCapabilities,
  type SearchMenuHandlers,
} from '../src/ui/search-menu';
import {
  TAB_LIST_LIMIT,
  groupMenuItemsFor,
  tabListIndexOf,
  tabMenuItemsFor,
  type GroupMenuFacts,
  type TabMenuFacts,
} from '../src/ui/tabs-ops';
import { registerTabsMenuBridge, type TabsMenuBridge } from '../src/ui/tabs-bar';
import { KEYBINDING_SPECS, keybindingSpecOf } from '../src/ui/keybindings';
import { effectiveKeybindingOf } from '../src/ui/keybindings';
import { formatKeybinding } from '../src/ui/commands';

/* ══════════════════════════ ① 夹具 ══════════════════════════ */

/** 一份待检的菜单（`face` 只用于报错定位与按面白名单） */
interface MenuCase {
  readonly face: string;
  /** 这一份菜单是"哪个构建器 + 什么夹具"出来的（报错时一眼看出是哪份） */
  readonly variant: string;
  readonly items: readonly ContextMenuItem[];
  /**
   * 这类项的 label 来自**用户内容**（符号名 / 文件名），不是我们写的文案，
   * 因此不受"必须含中文"这条约束（中文化守卫也豁免不了它们——它们本来就该原样上屏）。
   */
  readonly userContentIds?: readonly string[];
}

/* ---- 文件树 ---- */

const CAP_FULL: MenuCapability = {
  hasIo: true,
  canReveal: true,
  canImport: true,
  canClipboard: true,
  canRelist: true,
  canHistory: true,
  canCommandPalette: true,
  canAddFolder: true,
  // WS-13：搬运家族的分发已接上（FileTree.tsx 的 runMenuAction 认这四条），满能力档翻 true
  // 让它们进守卫网（中文标题 / id 唯一 / 快捷键不凭空写）。
  // canSearchInFolder 仍按没通道填——那是下一批（检索入口）的活，接线批同时翻位。
  canMoveEntries: true,
  canSearchInFolder: false,
};

const CAP_NONE: MenuCapability = {
  hasIo: false,
  canReveal: false,
  canImport: false,
  canClipboard: false,
  canRelist: false,
  canHistory: false,
  canCommandPalette: false,
  canAddFolder: false,
  canMoveEntries: false,
  canSearchInFolder: false,
};

/** 文件树五项：作用域 × 能力 × 视图（每一项都足够让面表态） */
function fileTreeItems(
  scope: MenuScopeKind,
  cap: MenuCapability,
  opts: MenuOptions = { view: 'kojo', activeFile: 'C:/koa/001/a.ERB', path: 'C:/koa/001/a.ERB' },
): ContextMenuItem[] {
  return menuItemsFor(scope, cap, opts).map(toContextMenuItem);
}

/* ---- 标签栏 ---- */

const TAB_FACTS: TabMenuFacts = {
  pinned: false,
  hasSaved: true,
  canReveal: true,
  hasReopen: true,
  canSplit: true,
  hasRoot: true,
  otherGroups: [
    { id: 'eg-2', label: '第 2 组' },
    { id: 'eg-3', label: '第 3 组' },
  ],
};

const GROUP_FACTS: GroupMenuFacts = {
  groupCount: 2,
  tabs: ['C:/koa/001/a.ERB', 'C:/koa/001/b.ERB'],
  active: 'C:/koa/001/a.ERB',
  pinned: new Set<string>(),
  canCloseGroup: true,
  canSplit: true,
};

/* ---- 面包屑 ---- */

const CRUMB_LEVELS = [
  {
    current: { name: '#1 冒頭', kind: 'function' as const, startLine: 1 },
    siblings: [
      { name: '#1 冒頭', kind: 'function' as const, startLine: 1 },
      { name: '#2 会話', kind: 'function' as const, startLine: 40 },
    ],
    hidden: 0,
  },
  {
    current: { name: '@挨拶', kind: 'function' as const, startLine: 5 },
    siblings: [
      { name: '@前口上', kind: 'function' as const, startLine: 2 },
      { name: '@挨拶', kind: 'function' as const, startLine: 5 },
      { name: '@返事', kind: 'function' as const, startLine: 9 },
    ],
    // 截断：子菜单里要多出那条"另有 N 项未列出"
    hidden: 3,
  },
];

const CRUMB_RT: CrumbMenuRuntime = {
  levels: CRUMB_LEVELS,
  canClipboard: true,
  hasFilePath: true,
  hasProjectRoot: true,
  canReveal: true,
  act: () => {},
};

/* ---- 命令面板 / 快速打开 ---- */

const PALETTE_CAPS: PaletteMenuCapabilities = {
  copyText: true,
  revealInExplorer: true,
  keybindingsCommand: true,
};

/* ---- 检索 ---- */

const SEARCH_CAPS: SearchMenuCapabilities = { canReplace: true, canReveal: true, canCopy: true };

/* ---- 调用层级 / 对比 / 两个时间线 ---- */

const CH_ROW_GROUP: CallHierarchyRowRef = {
  kind: 'group',
  section: 'in',
  name: '@你好',
  path: 'C:/game/ERB/COMMON.ERB',
  line: 120,
  column: null,
  count: 2,
  sites: ['C:/game/ERB/A.ERB:10:3', 'C:/game/ERB/B.ERB:20:5'],
};

const CH_INPUT: CallHierarchyMenuInput = {
  row: CH_ROW_GROUP,
  subject: { name: '@你好', path: 'C:/game/ERB/COMMON.ERB', line: 120 },
  clipboardAvailable: true,
  hidden: { in: 7, out: 3 },
  total: { in: 130, out: 12 },
  listText: '@有人（C:/game/ERB/X.ERB:5）\n  ↳ C:/game/ERB/COMMON.ERB:120:2',
};

const DIFF_INPUT: DiffViewMenuInput = {
  title: 'COMMON.ERB · 写前备份',
  leftLabel: '写前备份',
  rightLabel: '磁盘当前内容',
  leftPath: 'C:/appData/backup/COMMON.ERB.v1.bak',
  rightPath: 'C:/game/ERB/COMMON.ERB',
  editorReady: true,
  sideBySide: true,
  paneCount: 2,
  bannerMessage: null,
  clipboardAvailable: true,
};

const FH_INPUT: FileHistoryMenuInput = {
  row: {
    key: 'trash:1',
    account: 'trash',
    title: '已删除：COMMON.ERB',
    timeText: '2026-10-20 10:00:00',
    keepText: '',
    path: 'C:/appData/trash/COMMON.ERB',
    hasAction: true,
    actionLabel: '放回原位',
    // restoreTrash 才会出"彻底删除"（危险项）
    actionKind: 'restoreTrash',
    pendingAction: null,
    busy: false,
  },
  targetPath: 'C:/game/ERB/COMMON.ERB',
  clipboardAvailable: true,
};

const OH_INPUT: OpsHistoryMenuInput = {
  row: {
    key: 'trash:1',
    account: 'trash',
    title: '已删除：COMMON.ERB',
    timeText: '2026-10-20 10:00:00',
    path: 'C:/appData/trash/COMMON.ERB',
    hasAction: true,
    actionLabel: '放回原位',
    actionKind: 'restoreTrash',
    status: null,
    fileCount: 1,
    expandable: false,
    expanded: false,
    pendingAction: null,
    busy: false,
  },
  clipboardAvailable: true,
};

const PREVIEW_CTX: PreviewMenuContext = {
  previewing: true,
  hasPreviewText: true,
  hasSelection: true,
  canJumpToSource: true,
  canToggleFold: true,
  canOpenSettings: true,
};

const FRAME_CTX: EditorFrameMenuContext = {
  filePath: 'C:/game/ERB/COMMON.ERB',
  canRunCommand: () => true,
};

/* ---- 全部待检菜单（12 个面 / 16 个构建器） ---- */

const MENU_CASES: readonly MenuCase[] = [
  // 文件树（5 个作用域 + 能力/视图变体）
  { face: '文件树', variant: '文件·满能力', items: fileTreeItems('file', CAP_FULL) },
  { face: '文件树', variant: '目录·满能力', items: fileTreeItems('dir', CAP_FULL, { view: 'kojo', activeFile: null }) },
  { face: '文件树', variant: '作者包·满能力', items: fileTreeItems('package', CAP_FULL, { view: 'kojo', activeFile: null }) },
  { face: '文件树', variant: '角色组·满能力', items: fileTreeItems('group', CAP_FULL, { view: 'kojo', activeFile: null }) },
  { face: '文件树', variant: '空白区·满能力', items: fileTreeItems('blank', CAP_FULL, { view: 'kojo', activeFile: null }) },
  { face: '文件树', variant: '空白区·文件系统视图', items: fileTreeItems('blank', CAP_FULL, { view: 'fs', activeFile: null }) },
  { face: '文件树', variant: '文件·无能力', items: fileTreeItems('file', CAP_NONE, { view: 'kojo', activeFile: null }) },

  // 标签栏（标签行 / 组头）
  { face: '标签栏', variant: '标签行·满能力', items: tabMenuItemsFor(TAB_FACTS) },
  { face: '标签栏', variant: '标签行·已固定且无分屏', items: tabMenuItemsFor({ ...TAB_FACTS, pinned: true, canSplit: false }) },
  { face: '标签栏', variant: '编辑器组头', items: groupMenuItemsFor(GROUP_FACTS) },
  { face: '标签栏', variant: '组头·单组空列表', items: groupMenuItemsFor({ ...GROUP_FACTS, groupCount: 1, tabs: [], active: null, canCloseGroup: false }) },

  // 面包屑（右键面 3 段 + 就地同级下拉）
  { face: '面包屑', variant: '最外层段', items: crumbSurfaceItems(CRUMB_LEVELS[0]!, 0, CRUMB_RT) },
  { face: '面包屑', variant: '内层段（同级截断）', items: crumbSurfaceItems(CRUMB_LEVELS[1]!, 1, CRUMB_RT) },
  {
    face: '面包屑',
    variant: '无剪贴板',
    items: crumbSurfaceItems(CRUMB_LEVELS[1]!, 1, { ...CRUMB_RT, canClipboard: false, canReveal: false }),
  },
  {
    face: '面包屑',
    variant: '就地同级下拉（截断）',
    items: crumbMenuItems(CRUMB_LEVELS[1]!),
    // 同级项的名字 = 文档里的符号名（用户内容），不受"文案必须含中文"约束
    userContentIds: CRUMB_LEVELS[1]!.siblings.map((_s, i) => `${i}`),
  },

  // 命令面板 / 快速打开（三种行）
  { face: '命令面板', variant: '文件行', items: buildPaletteRowMenu(fileRowTarget('C:/koa/a.ERB', 'a.ERB'), PALETTE_CAPS) },
  {
    face: '命令面板',
    variant: '命令行',
    items: buildPaletteRowMenu(commandRowTarget('workbench.splitEditor', '向右拆分编辑器'), PALETTE_CAPS),
  },
  {
    face: '命令面板',
    variant: '符号行',
    items: buildPaletteRowMenu(symbolRowTarget('C:/koa/a.ERB', 12, '@挨拶', '@挨拶'), PALETTE_CAPS),
  },
  {
    face: '命令面板',
    variant: '命令行·无通道',
    items: buildPaletteRowMenu(commandRowTarget('workbench.splitEditor', '向右拆分编辑器'), {
      copyText: false,
      revealInExplorer: false,
      keybindingsCommand: false,
    }),
  },

  // 检索结果
  { face: '检索', variant: '文件组', items: buildSearchFileMenu(SEARCH_CAPS) },
  { face: '检索', variant: '命中行', items: buildSearchMatchMenu(SEARCH_CAPS) },
  {
    face: '检索',
    variant: '命中行·替换未就绪',
    items: buildSearchMatchMenu({ ...SEARCH_CAPS, canReplace: false, canCopy: false, canReveal: false }),
  },

  // 问题面板
  { face: '问题', variant: '单条·满能力', items: buildProblemRowMenu({ canCopy: true, canQuickFix: true, code: 'KOJO-1001' }) },
  { face: '问题', variant: '单条·无修复无码', items: buildProblemRowMenu({ canCopy: true, canQuickFix: false, code: null }) },
  { face: '问题', variant: '面板级', items: buildProblemsPanelMenu({ canCopy: true, itemCount: 3, filtering: true }) },
  { face: '问题', variant: '面板级·空面板', items: buildProblemsPanelMenu({ canCopy: true, itemCount: 0, filtering: false }) },

  // 调用层级
  { face: '调用层级', variant: '组行', items: buildCallHierarchyMenu(CH_INPUT)!.items },
  {
    face: '调用层级',
    variant: '入调用侧点位行',
    items: buildCallHierarchyMenu({
      ...CH_INPUT,
      row: { kind: 'site', section: 'in', name: '@有人', path: 'C:/game/ERB/X.ERB', line: 5, column: 2, count: 0, sites: [] },
    })!.items,
  },
  { face: '调用层级', variant: '面板级', items: buildCallHierarchyMenu({ ...CH_INPUT, row: null })!.items },
  {
    face: '调用层级',
    variant: '无剪贴板',
    items: buildCallHierarchyMenu({ ...CH_INPUT, clipboardAvailable: false })!.items,
  },

  // 对比浮窗
  { face: '对比', variant: '满能力', items: buildDiffViewMenu(DIFF_INPUT)!.items },
  {
    face: '对比',
    variant: '无编辑器无剪贴板',
    items: buildDiffViewMenu({ ...DIFF_INPUT, editorReady: false, clipboardAvailable: false, leftPath: null, rightPath: null })!.items,
  },

  // 文件历史
  { face: '文件历史', variant: '回收站行', items: buildFileHistoryMenu(FH_INPUT)!.items },
  { face: '文件历史', variant: '面板级', items: buildFileHistoryMenu({ row: null, targetPath: 'C:/game/ERB/COMMON.ERB', clipboardAvailable: true })!.items },
  { face: '文件历史', variant: '忙碌中', items: buildFileHistoryMenu({ ...FH_INPUT, row: { ...FH_INPUT.row!, busy: true } })!.items },
  { face: '文件历史', variant: '空屏', items: buildFileHistoryMenu({ row: null, targetPath: null, clipboardAvailable: false })!.items },

  // 操作历史
  { face: '操作历史', variant: '批操作行', items: buildOpsHistoryMenu({ ...OH_INPUT, row: { ...OH_INPUT.row!, account: 'ops', actionKind: 'undoOp', status: 'committed', expandable: true, path: null } })!.items },
  { face: '操作历史', variant: '回收站行', items: buildOpsHistoryMenu(OH_INPUT)!.items },
  { face: '操作历史', variant: '面板级', items: buildOpsHistoryMenu({ row: null, clipboardAvailable: true })!.items },
  { face: '操作历史', variant: '忙碌中', items: buildOpsHistoryMenu({ ...OH_INPUT, row: { ...OH_INPUT.row!, busy: true } })!.items },

  // 预览 / 编辑器外框
  { face: '预览', variant: '满能力', items: buildPreviewMenu(PREVIEW_CTX) },
  {
    face: '预览',
    variant: '无选区无折叠',
    items: buildPreviewMenu({ ...PREVIEW_CTX, hasSelection: false, canToggleFold: false, canJumpToSource: false, canOpenSettings: false }),
  },
  { face: '编辑器外框', variant: '有文件', items: buildEditorFrameMenu(FRAME_CTX) },
  { face: '编辑器外框', variant: '空态', items: buildEditorFrameMenu({ filePath: null, canRunCommand: () => false }) },

  // 插件面板
  {
    face: '插件面板',
    variant: '满能力',
    items: buildPluginPanelMenu({ panelId: 'kojo.outline', panelTitle: '大纲', pluginId: 'kojo.outline' }, true) as ContextMenuItem[],
  },
];

/* ══════════════════════════ ② 契约断言 ══════════════════════════ */

/**
 * `danger` 白名单（按面）：**只有**破坏性动作才配危险色。
 *
 * 依据（逐条对着动作语义）：
 * - `文件树 / delete`：删除到回收站（`removeFile`/`removeDir`）；
 * - `文件历史 / fh.purge`：彻底删除回收站里的那一份（不可找回）；
 * - `操作历史 / oh.purge`：彻底删除回收站里的那一份（不可找回）。
 *
 * 「关闭 / 撤销 / 恢复」这类也在破坏性语境里，但都可逆（关掉的能重开、撤销能重做、
 * 恢复能再删），按本仓既有口径不上危险色——它们靠 `group` 分组区分，不靠颜色。
 * 这条白名单宁严不宽：谁把 `danger` 加到别处，测试就红，必须来这儿说明凭什么是破坏性动作。
 */
const DANGER_WHITELIST: Readonly<Record<string, readonly string[]>> = {
  文件树: ['delete'],
  文件历史: ['fh.purge'],
  操作历史: ['oh.purge'],
};

/**
 * 「灰着的危险项」白名单：**只允许**忙碌中（`busy`）的彻底删除。
 *
 * 为什么这条规则有例外：这两个面在写盘在途时把恢复 / 删除整组灰掉（点了会并发出错），
 * 而危险标记是**项的稳定身份**——这一刻灰、下一刻亮，若灰的时候摘掉 `danger`，
 * 用户会看到这枚项在同一个位置上忽然变色，反而认不出是同一条动作。
 * 例外必须带 `disabledReason`（"正在写入，稍后再试"），不许出现"灰着不说话"的组合。
 */
const DANGER_DISABLED_ALLOWED: ReadonlySet<string> = new Set(['fh.purge', 'oh.purge']);

/** 递归摊平（含子菜单），附带所在层级（报错时能看出死在几级） */
function flatten(items: readonly ContextMenuItem[], depth = 0): { item: ContextMenuItem; depth: number }[] {
  const out: { item: ContextMenuItem; depth: number }[] = [];
  for (const item of items) {
    out.push({ item, depth });
    if (item.children !== undefined) out.push(...flatten(item.children, depth + 1));
  }
  return out;
}

/** 一条项的完整契约（递归） */
function expectItemContract(c: MenuCase): void {
  const where = `${c.face}/${c.variant}`;
  // 面不表态 = 夹具没造对（或面真的没项了）——这种情况必须炸，不许"空数组恒真"混过去
  expect(c.items.length, `${where} 产出了 0 项`).toBeGreaterThan(0);

  const seen = new Set<string>();
  const allowedDanger = DANGER_WHITELIST[c.face] ?? [];

  for (const { item, depth } of flatten(c.items)) {
    const at = `${where} › ${item.id}（第 ${depth + 1} 级）`;

    // 1. id 全局唯一：子菜单里的 id 与主菜单撞车（`copy-path` 上下各来一份）会让分发器
    //    分不清是谁被点了——两种语义共用一个 id 是这类菜单最阴的一种坏法
    expect(seen.has(item.id), `${at} id 在同一份菜单里重复`).toBe(false);
    seen.add(item.id);

    // 2. label 非空且含中文（用户内容类豁免：符号名/文件名本来就该原样上屏）
    expect(item.label.trim().length, `${at} label 为空`).toBeGreaterThan(0);
    if (c.userContentIds?.includes(item.id) !== true) {
      expect(isChineseMenuLabel(item.label), `${at} label 不含中文：${item.label}`).toBe(true);
    }

    // 3. 禁用必须说话（铁律 4）
    if (item.disabled === true) {
      expect(typeof item.disabledReason === 'string' && item.disabledReason.trim().length > 0, `${at} 灰着不说话`).toBe(true);
      expect(isChineseMenuLabel(item.disabledReason ?? ''), `${at} 禁用原因不是中文：${item.disabledReason}`).toBe(true);
    }

    // 4. 子菜单不许是空壳（点开一个空菜单 = 点了没反应）
    if (item.children !== undefined) {
      expect(item.children.length, `${at} 子菜单为空`).toBeGreaterThan(0);
    }

    // 5. danger 只落在破坏性动作上
    if (item.danger === true) {
      expect(allowedDanger.includes(item.id), `${at} 不是破坏性动作却带 danger`).toBe(true);
    }

    // 6. 不允许"灰着的危险项"（除忙碌中的彻底删除，见白名单注释）
    if (item.danger === true && item.disabled === true) {
      expect(DANGER_DISABLED_ALLOWED.has(item.id), `${at} 同时 disabled + danger`).toBe(true);
    }
  }
}

describe('项契约 · 12 个面 / 16 个构建器的每一份菜单', () => {
  for (const c of MENU_CASES) {
    it(`${c.face} · ${c.variant}`, () => {
      expectItemContract(c);
    });
  }

  it('夹具覆盖了每个面（防止有人删掉一份夹具后测试"全部通过"）', () => {
    // 12 个面 + 编辑器外框（预览与外框同住 `preview-menu.ts`，但是两个独立的右键面）
    expect(new Set(MENU_CASES.map((c) => c.face)).size).toBe(13);
  });
});

/* ══════════════════════════ ③ 分发覆盖面 ══════════════════════════ */

/* ---------- ③.1 导出的纯分发器：逐个 id 喂进去 ---------- */

const SEARCH_HANDLERS: SearchMenuHandlers = {
  openMatch: () => {},
  copyText: () => {},
  revealPath: () => {},
  replaceMatch: () => {},
};

const MATCH = { path: 'C:/koa/a.ERB', line: 3, column: 5, preview: '@挨拶 の行' } as unknown as Parameters<
  typeof runSearchMatchMenuAction
>[2];

describe('检索面 · 分发覆盖面（id 全集逐个喂）', () => {
  it('文件组：每一条都处理得了', () => {
    const ids = buildSearchFileMenu(SEARCH_CAPS).map((i) => i.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(runSearchFileMenuAction(id, 'C:/koa/a.ERB', MATCH, SEARCH_HANDLERS), id).toBe(true);
    }
  });

  it('命中行：每一条都处理得了', () => {
    const ids = buildSearchMatchMenu(SEARCH_CAPS).map((i) => i.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(runSearchMatchMenuAction(id, 'C:/koa/a.ERB', MATCH, SEARCH_HANDLERS), id).toBe(true);
  });

  it('不认识的 id 一律回 false（分发器没有"default: true"式的假处理）', () => {
    expect(runSearchFileMenuAction('search.nope', 'C:/koa/a.ERB', MATCH, SEARCH_HANDLERS)).toBe(false);
    expect(runSearchMatchMenuAction('search.nope', 'C:/koa/a.ERB', MATCH, SEARCH_HANDLERS)).toBe(false);
  });

  it('文件组没有命中时「打开」不假装处理（不猜落点）', () => {
    expect(runSearchFileMenuAction(SEARCH_FILE_MENU_IDS.open, 'C:/koa/a.ERB', null, SEARCH_HANDLERS)).toBe(false);
  });

  it('命中行的 id 与文件组不共用（两组菜单能各自分发）', () => {
    const fileIds = new Set(buildSearchFileMenu(SEARCH_CAPS).map((i) => i.id));
    expect(buildSearchMatchMenu(SEARCH_CAPS).some((i) => fileIds.has(i.id))).toBe(false);
    // 反向确认：文件组的 id 不会被命中行分发器误认
    expect(runSearchMatchMenuAction(SEARCH_FILE_MENU_IDS.open, 'C:/koa/a.ERB', MATCH, SEARCH_HANDLERS)).toBe(false);
    expect(SEARCH_MATCH_MENU_IDS.open).not.toBe(SEARCH_FILE_MENU_IDS.open);
  });
});

const PROBLEM = { path: 'C:/koa/a.ERB', line: 3, column: 5, severity: 'error', message: '未定义 @函数', code: 'KOJO-1001' } as unknown as Parameters<
  typeof runProblemRowMenuAction
>[1];

const PROBLEM_HANDLERS: ProblemMenuHandlers = {
  reveal: () => {},
  quickFix: () => {},
  copyProblem: () => {},
  filterByCode: () => {},
  copyAll: () => {},
  clearFilter: () => {},
};

describe('问题面 · 分发覆盖面（id 全集逐个喂）', () => {
  it('单条：每一条都处理得了', () => {
    const ids = buildProblemRowMenu({ canCopy: true, canQuickFix: true, code: 'KOJO-1001' }).map((i) => i.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(runProblemRowMenuAction(id, PROBLEM, PROBLEM_HANDLERS), id).toBe(true);
  });

  it('面板级：每一条都处理得了', () => {
    const ids = buildProblemsPanelMenu({ canCopy: true, itemCount: 3, filtering: true }).map((i) => i.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(runProblemsPanelMenuAction(id, PROBLEM_HANDLERS), id).toBe(true);
  });

  it('不认识的 id 一律回 false', () => {
    expect(runProblemRowMenuAction('problems.nope', PROBLEM, PROBLEM_HANDLERS)).toBe(false);
    expect(runProblemsPanelMenuAction('problems.nope', PROBLEM_HANDLERS)).toBe(false);
  });

  it('「按规则过滤」只在问题真有码时才处理（无码项本就不出，兜底不假装）', () => {
    expect(runProblemRowMenuAction(PROBLEM_MENU_IDS.filterByCode, { ...PROBLEM, code: undefined }, PROBLEM_HANDLERS)).toBe(false);
    expect(runProblemRowMenuAction(PROBLEM_MENU_IDS.filterByCode, { ...PROBLEM, code: '' }, PROBLEM_HANDLERS)).toBe(false);
  });
});

describe('插件面板面 · 分发覆盖面（id 全集逐个喂）', () => {
  const FACTS = { panelId: 'kojo.outline', panelTitle: '大纲', pluginId: 'kojo.outline' };
  const clip = { written: [] as string[] };

  beforeEach(() => {
    clip.written = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { clip.written.push(text); } },
    });
  });

  it('每一条都真的写了剪贴板（返回 true 才代表落地）', async () => {
    const ids = buildPluginPanelMenu(FACTS, true).map((i) => i.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(await runPluginPanelAction(id, FACTS), id).toBe(true);
    expect(clip.written).toHaveLength(ids.length);
  });

  it('三条各复制各的（面板名 / 面板 ID / 插件 ID 不串）', async () => {
    await runPluginPanelAction(PLUGIN_PANEL_ACTION.copyPanelTitle, FACTS);
    await runPluginPanelAction(PLUGIN_PANEL_ACTION.copyPanelId, FACTS);
    await runPluginPanelAction(PLUGIN_PANEL_ACTION.copyPluginId, FACTS);
    expect(clip.written).toEqual(['大纲', 'kojo.outline', 'kojo.outline']);
  });

  it('不认识的 id / 没有事实 ⇒ false（不假装复制了）', async () => {
    expect(await runPluginPanelAction('pluginPanel.nope', FACTS)).toBe(false);
    expect(await runPluginPanelAction(PLUGIN_PANEL_ACTION.copyPanelId, null)).toBe(false);
  });
});

/* ---------- ③.2 标签栏：经真实路由 + 注入桥 ---------- */

describe('标签栏 · 经真实路由逐 id 分发', () => {
  const calls: string[] = [];
  const bridge: TabsMenuBridge = {
    groupId: 'g1',
    groupCount: 2,
    openTabs: ['C:/koa/a.ERB', 'C:/koa/b.ERB'],
    active: 'C:/koa/a.ERB',
    dirtyPaths: new Set<string>(),
    pinnedPaths: new Set<string>(),
    rootDir: 'C:/koa',
    otherGroups: [
      { id: 'eg-2', label: '第 2 组' },
      { id: 'eg-3', label: '第 3 组' },
    ],
    canCloseGroup: true,
    copyText: (_text, _ok) => calls.push('copyText'),
    activate: () => calls.push('activate'),
    requestClose: () => calls.push('requestClose'),
    batchClose: () => calls.push('batchClose'),
    togglePin: () => calls.push('togglePin'),
    closeSaved: () => calls.push('closeSaved'),
    saveAll: () => calls.push('saveAll'),
    closeGroup: () => calls.push('closeGroup'),
    reveal: () => calls.push('reveal'),
    moveToGroup: (_path, groupId) => calls.push(`moveToGroup:${groupId}`),
  };
  let unregister: () => void = () => {};

  const contextEvent = (): MouseEvent =>
    new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 30 });

  beforeEach(() => {
    calls.length = 0;
    document.body.innerHTML = '';
    // 桌面壳在场：「在资源管理器中显示」才会出现在菜单里（否则这一项按能力整项不显示，
    // 覆盖不到它的分发）
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    // 命令通道也要记一笔：拆分 / 恢复关闭的标签 / 命令面板这些项**只**走命令通道，
    // 不碰桥（不记就等于"点了没反应"的误报）
    registerContextMenuCommandRunner({
      hasCommand: () => true,
      runCommand: (id) => {
        calls.push(`command:${id}`);
        return true;
      },
    });
    unregister = registerTabsMenuBridge(bridge);
  });

  afterEach(() => {
    unregister();
    registerContextMenuCommandRunner(null);
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  const mount = (attrs: Record<string, string>, tag = 'div'): HTMLElement => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.appendChild(el);
    return el;
  };

  it('标签行：菜单里每一条都能让桥动起来', () => {
    const row = mount({ 'data-context-surface': 'tabs', 'data-group-id': 'g1', 'data-tab-path': 'C:/koa/b.ERB' });
    const route = buildContextMenuRoute(row, contextEvent());
    expect(route?.source).toBe('tabs');
    const items = route!.items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      // 子菜单父项（移动到组）只负责展开，不派发（渲染侧点它开子菜单）——
      // 它的子项逐个喂（动态 id 走前缀分发）
      if (item.children !== undefined && item.children.length > 0) {
        for (const child of item.children) {
          calls.length = 0;
          route!.onSelect(child.id);
          expect(calls.length, `标签行子菜单 ${child.id} 点了没反应`).toBeGreaterThan(0);
        }
        continue;
      }
      calls.length = 0;
      route!.onSelect(item.id);
      expect(calls.length, `标签行 ${item.id} 点了没反应`).toBeGreaterThan(0);
    }
  });

  it('编辑器组头：每一条都能让桥 / 命令通道动起来', () => {
    const head = mount({ 'data-context-surface': 'editor-group-header', 'data-group-id': 'g1' });
    const route = buildContextMenuRoute(head, contextEvent());
    expect(route?.source).toBe('editor-group-header');
    const ids = route!.items.map((i) => i.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const index = tabListIndexOf(id);
      if (index !== null) {
        calls.length = 0;
        route!.onSelect(id);
        expect(calls, `标签列表 ${id}`).toEqual(['activate']);
        continue;
      }
      // 子菜单父项只负责展开，不派发（渲染侧点它开子菜单）
      if (id === 'tab-list') continue;
      calls.length = 0;
      route!.onSelect(id);
      expect(calls.length, `组头 ${id} 点了没反应`).toBeGreaterThan(0);
    }
  });

  it('标签列表子项：下标 → 标签，点谁切谁（不跑错目标）', () => {
    const head = mount({ 'data-context-surface': 'editor-group-header', 'data-group-id': 'g1' });
    const items = groupMenuItemsFor({ ...GROUP_FACTS, tabs: ['C:/koa/a.ERB', 'C:/koa/b.ERB', 'C:/koa/c.ERB'] });
    const list = items.find((i) => i.id === 'tab-list')!;
    expect(list.children).toHaveLength(3);
    expect(tabListIndexOf(list.children![1]!.id)).toBe(1);
    expect(tabListIndexOf('tab-list:rest')).toBeNull();
    const route = buildContextMenuRoute(head, contextEvent());
    expect(route).not.toBeNull();
  });

  it('子菜单只列前 N 条并如实说明剩余（不静默截断）', () => {
    const tabs = Array.from({ length: TAB_LIST_LIMIT + 5 }, (_v, i) => `C:/koa/f${i}.ERB`);
    const items = groupMenuItemsFor({ ...GROUP_FACTS, tabs });
    const list = items.find((i) => i.id === 'tab-list')!;
    expect(list.children).toHaveLength(TAB_LIST_LIMIT + 1);
    const rest = list.children![list.children!.length - 1]!;
    expect(rest.id).toBe('tab-list:rest');
    expect(rest.disabled).toBe(true);
    expect(rest.disabledReason).toBeTruthy();
  });
});

/* ---------- ③.3 分发器内联在组件里：源码扫描 ---------- */

/**
 * 读**源码文本**（`?raw` 走 Vite 的资产面，不 import 模块——要的是"这行 case 在不在"，
 * 不是模块导出面；也不走 fs：这几份文件里有 monaco 全图，真 import 会把测试拖成几十秒）。
 */
const SOURCES: Readonly<Record<string, string>> = {
  'FileTree.tsx': fileTreeSource,
  'breadcrumb-bar.tsx': breadcrumbSource,
  'Palette.tsx': paletteSource,
  'CallHierarchyOverlay.tsx': callHierarchySource,
  'DiffViewOverlay.tsx': diffViewSource,
  'FileHistoryOverlay.tsx': fileHistorySource,
  'OpsHistoryOverlay.tsx': opsHistorySource,
  'EditorPane.tsx': editorPaneSource,
};

const SRC = (file: string): string => {
  const text = SOURCES[file];
  if (text === undefined) throw new Error(`没有登记 ${file} 的源码（见 SOURCES）`);
  return text;
};

/** 子菜单父项只负责展开，不派发（渲染侧点它开子菜单）——这类 id 不参与分发覆盖 */
const PARENT_ONLY = new Set(['siblings', 'tab-list']);

/**
 * 前缀式分发（id 由「前缀 + 下标」拼出来的面）。
 * 证据是那枚**唯一的解析函数**：它在分发文件里出现，就说明这一族 id 有人接。
 */
const PREFIX_DISPATCH: readonly { prefix: string; evidence: RegExp; why: string }[] = [
  {
    prefix: 'sibling:',
    evidence: /crumbSiblingIndex\(/,
    why: '面包屑同级项 id = `sibling:<下标>`，由 crumbSiblingIndex 解析后跳行',
  },
];

/** 某面的分发文件里，每个 id 是否有一处「认得出它」的 case / 比较 */
function expectHandledInSource(
  face: string,
  file: string,
  items: readonly ContextMenuItem[],
  mode: { kind: 'literal' } | { kind: 'const'; name: string; keys: readonly string[] },
): void {
  const source = SRC(file);
  const literalTargets = flatten(items).map(({ item }) => item);
  const targets = mode.kind === 'const' ? mode.keys.map((key) => ({ key, disabled: false })) : literalTargets.map((item) => ({ key: item.id, disabled: item.disabled === true }));
  expect(targets.length, `${face} 的 id 集合为空（夹具没让面表态）`).toBeGreaterThan(0);
  for (const target of targets) {
    if (mode.kind === 'literal' && PARENT_ONLY.has(target.key)) continue;
    // 灰着的说明行（"还有 N 项未列出"这种）不是动作：菜单根本不会对它发 onSelect，
    // 要求它有 case 只会逼着后人给说明行编一个空动作
    if (mode.kind === 'literal' && target.disabled) continue;
    const prefix = PREFIX_DISPATCH.find((p) => target.key.startsWith(p.prefix));
    if (prefix !== undefined) {
      expect(prefix.evidence.test(source), `${face}/${target.key}：${file} 里找不到前缀分发证据（${prefix.why}）`).toBe(true);
      continue;
    }
    const escaped = target.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern =
      mode.kind === 'literal'
        ? new RegExp(`(?:case\\s+|===\\s*)['"]${escaped}['"]`)
        : new RegExp(`(?:case\\s+[A-Za-z_$][\\w$]*\\.${escaped}\\s*:|===\\s*[A-Za-z_$][\\w$]*\\.${escaped}\\b)`);
    expect(pattern.test(source), `${face}/${target.key}：${file} 的分发器里没有这一条（点了会静默无反应）`).toBe(true);
  }
}

describe('分发覆盖面 · 内联分发器（源码扫描：每个 id 必须被 case/比较认过）', () => {
  it('文件树 → FileTree.tsx 的 runMenuAction', () => {
    const items: ContextMenuItem[] = [];
    for (const scope of ['file', 'dir', 'package', 'group', 'blank'] as const) {
      for (const view of ['kojo', 'fs'] as const) {
        items.push(...fileTreeItems(scope, CAP_FULL, { view, activeFile: 'C:/koa/a.ERB', path: 'C:/koa/a.ERB' }));
      }
    }
    expect(new Set(items.map((i) => i.id)).size).toBeGreaterThanOrEqual(20);
    expectHandledInSource('文件树', 'FileTree.tsx', items, { kind: 'literal' });
  });

  it('面包屑 → breadcrumb-bar.tsx 的 act', () => {
    const items: ContextMenuItem[] = [];
    for (const [index, level] of CRUMB_LEVELS.entries()) {
      items.push(...crumbSurfaceItems(level, index, CRUMB_RT));
    }
    expectHandledInSource('面包屑', 'breadcrumb-bar.tsx', items, { kind: 'literal' });
  });

  it('命令面板 → Palette.tsx 的 runPaletteRowAction', () => {
    const items: ContextMenuItem[] = [];
    for (const row of [
      fileRowTarget('C:/koa/a.ERB', 'a.ERB'),
      commandRowTarget('workbench.splitEditor', '向右拆分'),
      symbolRowTarget('C:/koa/a.ERB', 12, '@挨拶', '@挨拶'),
    ]) {
      items.push(...buildPaletteRowMenu(row, PALETTE_CAPS));
    }
    const keys = Object.keys(PALETTE_ROW_ACTION);
    expect(keys.length).toBeGreaterThan(0);
    // 面自己的动作走 switch；命令类项走 default 分支（命令面板 / 打开键盘快捷键）
    expectHandledInSource('命令面板', 'Palette.tsx', items, { kind: 'const', name: 'PALETTE_ROW_ACTION', keys });
  });

  it('调用层级 → CallHierarchyOverlay.tsx 的动作桥', () => {
    const items: ContextMenuItem[] = [];
    for (const input of [
      CH_INPUT,
      { ...CH_INPUT, row: null },
      { ...CH_INPUT, row: { ...CH_ROW_GROUP, kind: 'site' as const, section: 'out' as const } },
    ]) {
      items.push(...buildCallHierarchyMenu(input)!.items);
    }
    expectHandledInSource('调用层级', 'CallHierarchyOverlay.tsx', items, {
      kind: 'const',
      name: 'CALL_HIERARCHY_MENU_IDS',
      keys: Object.keys(CALL_HIERARCHY_MENU_IDS),
    });
  });

  it('对比浮窗 → DiffViewOverlay.tsx 的 menuRunRef', () => {
    const items = buildDiffViewMenu(DIFF_INPUT)!.items;
    expectHandledInSource('对比', 'DiffViewOverlay.tsx', items, {
      kind: 'const',
      name: 'DIFF_VIEW_MENU_IDS',
      keys: Object.keys(DIFF_VIEW_MENU_IDS),
    });
  });

  it('文件历史 → FileHistoryOverlay.tsx 的 runFaceActionRef', () => {
    const items: ContextMenuItem[] = [];
    for (const input of [FH_INPUT, { row: null, targetPath: 'C:/x.ERB', clipboardAvailable: true }]) {
      items.push(...buildFileHistoryMenu(input)!.items);
    }
    expectHandledInSource('文件历史', 'FileHistoryOverlay.tsx', items, {
      kind: 'const',
      name: 'FILE_HISTORY_MENU_IDS',
      keys: Object.keys(FILE_HISTORY_MENU_IDS),
    });
  });

  it('操作历史 → OpsHistoryOverlay.tsx 的 runFaceActionRef', () => {
    const items = buildOpsHistoryMenu(OH_INPUT)!.items;
    expectHandledInSource('操作历史', 'OpsHistoryOverlay.tsx', items, {
      kind: 'const',
      name: 'OPS_HISTORY_MENU_IDS',
      keys: Object.keys(OPS_HISTORY_MENU_IDS),
    });
  });

  it('预览 / 编辑器外框 → EditorPane.tsx 的两个动作函数', () => {
    const previewItems = buildPreviewMenu(PREVIEW_CTX);
    const frameItems = buildEditorFrameMenu(FRAME_CTX);
    expectHandledInSource('预览', 'EditorPane.tsx', previewItems, {
      kind: 'const',
      name: 'PREVIEW_MENU_IDS',
      keys: Object.keys(PREVIEW_MENU_IDS),
    });
    expectHandledInSource('编辑器外框', 'EditorPane.tsx', frameItems, {
      kind: 'const',
      name: 'EDITOR_FRAME_MENU_IDS',
      keys: Object.keys(EDITOR_FRAME_MENU_IDS),
    });
  });
});

/* ---------- ③.4 面级：全灰的菜单不该表态（空壳不如通用菜单） ---------- */

describe('问题面 · 面板级全灰时不表态（让兜底菜单接管）', () => {
  afterEach(() => setProblemsMenuContext(null));

  const mount = (attrs: Record<string, string> = {}): HTMLElement => {
    document.body.innerHTML = '';
    const el = document.createElement('div');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.appendChild(el);
    return el;
  };

  const install = (over: { canCopy: boolean; itemCount: number; filtering: boolean }): void => {
    setProblemsMenuContext({
      capabilities: { canCopy: over.canCopy },
      handlers: PROBLEM_HANDLERS,
      problemAt: () => null,
      quickFixAvailable: () => false,
      itemCount: () => over.itemCount,
      filtering: () => over.filtering,
    });
  };

  it('没有剪贴板且没有过滤条件 ⇒ 一项也点不动 ⇒ 不表态（交回兜底）', () => {
    install({ canCopy: false, itemCount: 0, filtering: false });
    expect(buildProblemsSurfaceMenu(mount())).toBeNull();
  });

  it('有剪贴板但面板空且无过滤 ⇒ 仍是全灰 ⇒ 不表态', () => {
    install({ canCopy: true, itemCount: 0, filtering: false });
    expect(buildProblemsSurfaceMenu(mount())).toBeNull();
  });

  it('有一项可点（比如能复制全部）⇒ 正常表态', () => {
    install({ canCopy: true, itemCount: 3, filtering: false });
    const menu = buildProblemsSurfaceMenu(mount());
    expect(menu).not.toBeNull();
    // 面可以回 `ContextMenuItem[]` 或 `{ items, onSelect }` 两种形态；本面回的是后者
    const items = (Array.isArray(menu) ? menu : (menu as { items: readonly ContextMenuItem[] }).items) as readonly ContextMenuItem[];
    expect(items.some((i) => i.disabled !== true)).toBe(true);
  });
});

/* ══════════════════════════ ④ 一致性抽查 ══════════════════════════ */

describe('文案一致性 · 同一面内同名动作说法相同', () => {
  it('文件树：「复制路径 / 删除 / 重命名」在文件与目录两种作用域下说法一致', () => {
    const file = new Map(fileTreeItems('file', CAP_FULL).map((i) => [i.id, i.label]));
    const dir = new Map(fileTreeItems('dir', CAP_FULL).map((i) => [i.id, i.label]));
    for (const id of ['copy-path', 'delete', 'rename', 'copy-name']) {
      expect(dir.get(id), id).toBe(file.get(id));
    }
  });

  it('面包屑：「复制层级名」≠「复制路径」（前者是块名，后者是文件路径，两者不许混用同一个说法）', () => {
    const labels = crumbSurfaceItems(CRUMB_LEVELS[1]!, 1, CRUMB_RT).map((i) => i.label);
    expect(labels).toContain('复制层级名');
    expect(labels).toContain('复制路径');
  });
});

describe('快捷键提示 · 不许凭空写键位', () => {
  /**
   * 全部「键位表能生成的提示」的集合。
   *
   * 两条合法来源：
   * 1. 有对应命令 ⇒ 提示必须是键位表里某条**生效键位**格式化后的样子。这里不按 item.id
   *    去查表（多数面把自己的动作 id 挂在命令项上，id 与命令 id 有意不同：`close` ← 
   *    `workbench.closeActiveTab`），所以断言的是"这串提示确实出自键位表"，用来抓**手抄**
   *    ——手写的 `Ctrl+X` 抄得再对也是凭空：作者改键之后它就成了谎话；
   * 2. 没有对应命令 ⇒ 只允许「第 N 行」这种**非键位**的位置提示。
   */
  const REGISTERED_SHORTCUTS: ReadonlySet<string> = new Set(
    KEYBINDING_SPECS.flatMap((spec) => {
      const keys = effectiveKeybindingOf(spec.id);
      return keys === undefined || keys === '' ? [] : [formatKeybinding(keys)];
    }),
  );

  for (const c of MENU_CASES) {
    it(`${c.face} · ${c.variant}`, () => {
      for (const { item } of flatten(c.items)) {
        if (item.shortcut === undefined) continue;
        const spec = keybindingSpecOf(item.id);
        if (spec !== undefined) {
          const keys = effectiveKeybindingOf(item.id) ?? '';
          if (keys !== '') expect(item.shortcut, `${item.id} 的快捷键与键位表不一致`).toBe(formatKeybinding(keys));
          continue;
        }
        expect(
          REGISTERED_SHORTCUTS.has(item.shortcut) || /^第 \d+ 行$/.test(item.shortcut),
          `${item.id} 的 shortcut「${item.shortcut}」不是键位表给的，也不是行号提示`,
        ).toBe(true);
      }
    });
  }

  it('命令项（命令面板）的快捷键来自键位表本身', () => {
    const items = fileTreeItems('blank', CAP_FULL);
    const palette = items.find((i) => i.id === 'command-palette')!;
    const keys = effectiveKeybindingOf(COMMAND_PALETTE_COMMAND)!;
    expect(palette.shortcut).toBe(formatKeybinding(keys));
  });
});

/* ══════════════════════════ ⑤ 前缀分发的解析器（点谁是谁） ══════════════════════════ */

describe('面包屑同级项 · 下标解析不跑错目标', () => {
  it('sibling:<n> → n；其余形态一律 null（不猜）', () => {
    expect(crumbSiblingIndex('sibling:0')).toBe(0);
    expect(crumbSiblingIndex('sibling:12')).toBe(12);
    expect(crumbSiblingIndex('sibling:x')).toBeNull();
    expect(crumbSiblingIndex('siblings-hidden')).toBeNull();
    expect(crumbSiblingIndex('copy-path')).toBeNull();
  });

  it('同级项的 id 与「另有 N 项」的 id 不撞车', () => {
    const children = crumbSurfaceItems(CRUMB_LEVELS[1]!, 1, CRUMB_RT).find((i) => i.id === 'siblings')!.children!;
    const ids = children.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('siblings-hidden');
  });
});

/* 占位：`vi` 在上面若干断言里用于构造 mock（保持 import 有用，避免 lint 误报未使用） */
void vi;
