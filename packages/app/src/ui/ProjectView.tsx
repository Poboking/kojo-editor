import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import type { Kernel } from '@kojo/kernel';
import type { ErbIndex, GameProject, OpJournal, RecentProject, UIPanelContribution } from '@kojo/plugin-api';
import { KernelServices, NAV_SCOPE_EVENT, WellKnownCommands, WellKnownServices, activeGameAdapter } from '@kojo/plugin-api';
import type { RevealTarget } from './App';
import { EditorPane, type EditorPaneActions } from './EditorPane';
import { ProblemPanel } from './ProblemPanel';
import { SearchPanel } from './SearchPanel';
import { OutlinePanel } from './OutlinePanel';
import { kojo2PreviewBottomView } from './kojo2-preview-host';
import { affectsKojoTree, createEventCoalescer } from './external-change';
import { FileTree } from './FileTree';
import { compareSelectedRequest } from './file-tree-compare';
import { revealInExplorer } from './reveal-explorer';
import { ShellLayout, setShellEditorStatus, type EditorStatusInfo, type WorkbenchApi } from './ShellLayout';
import { hostVersionStep, type HostVersionState } from './PanelHost';
import { Icon } from './icons';
import type { ShellCommandSpec } from './commands';
import {
  collectSearchScopes,
  filterPathsByActiveScope,
  resolveScope,
  setActiveScope,
  type SearchScopeCatalog,
} from './search-scope';
import { createSourceFileCache, mergeCandidatePaths } from './commands';
import { createFileReplaceRunner } from './search-replace-exec';
import { editorModelPool } from './editor-model-pool-instance';
import { createProjectNameLedger } from './name-ledger';
import { revealLocationOf } from '../monaco/reveal-position';
import { setReplaceRunner, snapshot as readSearchState, subscribe as subscribeSearchState, openFolderSearchScope } from './search-store';
import { runExplorerOp, runExplorerUndoDelete } from './file-clipboard';
import { EXPLORER_COPY_COMMAND, EXPLORER_CUT_COMMAND, EXPLORER_PASTE_COMMAND, EXPLORER_DUPLICATE_COMMAND, EXPLORER_UNDO_DELETE_COMMAND } from './file-tree-ops';
import { dirtyNamesIn } from './disk-reconcile';
import { effectiveKeybindingOf, useKeybindingsVersion } from './keybindings';
import { quickOpenRootsOf, scanRootsOf, searchRootsOf, type WorkspaceFolder } from './workspace-folders';
import { useWorkspaceFolders } from './use-workspace-folders';
import { syncErbIndexAfterDiskChange, type DiskDelta } from './erb-index-sync';
import { useNotify } from './NotificationCenter';
import { JUMP_TO_STATE_SOURCE, readJumpProbe, requestJumpToState } from './jump-to-state';
import { TabBar } from './tabs-bar';
import { requestTabCycle } from './tab-cycle';
import { setKojoXmlSchemaSource } from '../monaco/kojo-xml-providers';
import { setKojoXmlDialectSource } from '../monaco/kojo-xml-diagnostics';
import { resolveDocumentDialect } from './dialect-binding';
import type { KojoXmlService } from '@kojo/plugin-api';
import type { ActiveFileSymbolSource } from './palette-search';
import type { BatchCloseMode, OpenFileOptions } from './tabs-ops';
import { TAB_DRAG_MIME, decodeTabDragPayload, type TabMenuGroupRef } from './tabs-ops';
import { alignSplitSizes, splitFlexOf, splitSizesFromWidths, type EditorGroupState, type GroupsOrientation } from './editor-groups';

/**
 * `Ctrl+P` 里 `@` 模式的数据源：**模块级常量函数**（引用恒定 ⇒ 面板的 memo 不被每帧新闭包打穿）。
 *
 * 读的是编辑器位点探针（`jump-to-state` 那一条注册通道，与「看这一行的状态」同一个真源），
 * 符号树与大纲 / 吸顶 / 面包屑同一棵（`crumbTreeCacheRef` 那份缓存，按下才算）。
 * 探针不在场（编辑器没挂载 / 已卸载）⇒ `null`，由面板照实说"还没有打开文件"。
 */
const activeFileSymbolsFromEditor = (): ActiveFileSymbolSource | null => {
  const probe = readJumpProbe();
  return probe === null ? null : { path: probe.path, symbols: probe.symbols };
};

interface Props {
  kernel: Kernel;
  project: GameProject;
  index: ErbIndex | null;
  indexing: boolean;
  /** 索引构建失败原因（P0 实机反馈：两个树同时空必须能自解释，不能静默） */
  indexError: string | null;
  activeFile: string | null;
  /** 打开的标签页（P3 多标签；顺序即标签栏顺序）——**焦点组**的投影（命令/检索面板消费） */
  openTabs: readonly string[];
  /**
   * 编辑器组态（SPLIT-1 分屏批）：真源在宿主 App，这里按组渲染「标签条 + 编辑器」。
   * `activeFile` / `openTabs` 是焦点组的投影，供命令与检索面板等单组消费方使用。
   */
  groups: readonly EditorGroupState[];
  activeGroupId: string;
  /**
   * 编辑器组排列方向（MM-9）：row = 左右并排、column = 上下堆叠。
   * 真源在宿主 App 的组态 state，这里只读它挂 `data-orientation` 与选拖拽轴。
   */
  orientation: GroupsOrientation;
  /** 焦点组切换（点击某组编辑器区域） */
  onActivateGroup: (groupId: string) => void;
  /** 组内激活标签（点击非焦点组的标签 = 切到该组并激活） */
  onActivateTabInGroup: (groupId: string, path: string) => void;
  /** 组内请求关闭标签（脏标签由宿主弹确认；非焦点组先聚焦再走确认链） */
  onRequestCloseTabInGroup: (groupId: string, path: string) => void;
  /** 组内拖拽重排标签 */
  onReorderTabInGroup: (groupId: string, path: string, toIndex: number) => void;
  /** 组内固定 / 取消固定标签 */
  onTogglePinInGroup: (groupId: string, path: string) => void;
  /** 组内批量关闭（先聚焦该组再走既有确认链） */
  onBatchCloseTabInGroup: (groupId: string, mode: BatchCloseMode, anchor: string) => void;
  /**
   * 跨组移动一枚标签（1027 跨组批：拖拽标签到别组 / 右键「移动到组」）。
   * `toIndex` 是**目标组的插入下标**（`undefined` = 追加到末尾）。
   */
  onMoveTabBetweenGroups: (path: string, fromGroupId: string, toGroupId: string, toIndex?: number) => void;
  /** 向右拆分（从焦点组，VSCode 同款携带激活标签） */
  onSplitEditor: () => void;
  /** 向下拆分（MM-9：从焦点组，同款携带激活标签；column 下插在下方） */
  onSplitEditorDown: () => void;
  /**
   * 翻编辑器组排列方向（MM-9）：row 左右并排 / column 上下堆叠。
   * 单组时宿主侧拒（命令包装要先用 groups.length 挡一道并给人话，铁律 4）。
   */
  onSetGroupsOrientation: (dir: 'row' | 'column') => void;
  /**
   * 按**排列序**聚焦编辑器组（WS-14 · `Ctrl+1/2/3/4`；0 基下标）。
   * 没有那一组时宿主回一句人话——这里只发意图，组态判据单源在 `editor-groups`。
   * 缺省（旧调用方）⇒ 那一族命令整个不进注册表。
   */
  onFocusGroupOrdinal?: (ordinal: number) => void;
  /** 组间焦点切换（WS-14，环形）：`delta = ±1`；单组由宿主给人话 */
  onCycleActiveGroup?: (delta: 1 | -1) => void;
  /** 键盘调整焦点组份额（WS-14：分隔条只有鼠标能拖的那半欠账）；到边界由宿主给人话 */
  onResizeActiveGroup?: (delta: 1 | -1) => void;
  /** 关闭指定组（组内标签全部随组消失；单组不可关） */
  onCloseGroup: (groupId: string) => void;
  /** 后退（MM-6，Alt+←）：导航历史光标前移；到栈底由宿主发人话通知 */
  onNavBack: () => void;
  /** 前进（MM-6，Alt+→）：导航历史光标后移；到栈顶由宿主发人话通知 */
  onNavForward: () => void;
  /** 恢复最近关闭的标签（MM-10，Ctrl+Shift+T）；空栈由宿主发人话通知 */
  onReopenClosedTab: () => void;
  /** 各标签脏态（标签栏脏点，见 `.tab-dirty`） */
  dirtyPaths: ReadonlySet<string>;
  /** 固定标签集合（C2；会话态——与 openTabs 同生命周期，真源在宿主 App） */
  pinnedPaths: ReadonlySet<string>;
  reveal: RevealTarget | null;
  /** 打开文件（第二参是**方式**：预览态单击 / 永久打开；类型定义见 tabs-ops.OpenFileOptions） */
  onOpenFile: (path: string, opts?: OpenFileOptions) => void;
  /**
   * 最近打开（1020 编辑器体感批）：路径清单，最新在前 —— `Ctrl+P` 空查询时置顶的
   * 「最近打开」一节。真源在宿主 App 的那份 MM-7 记录（欢迎页同一份），这里只透传。
   */
  recentFiles?: readonly string[];
  /** 请求关闭标签（脏标签由宿主弹确认） */
  onRequestCloseTab: (path: string) => void;
  /** 全部保存（Ctrl+Shift+S 壳层命令落地处） */
  onSaveAll: () => Promise<boolean>;
  /** 编辑器脏状态上抛（按路径；宿主维护 dirtyPaths） */
  onDirtyChange?: (path: string, dirty: boolean) => void;
  /** 编辑器动作句柄注册（按组；宿主"保存并关闭 / 全部保存"流程跨组归集） */
  registerActions?: (groupId: string, actions: EditorPaneActions | null) => void;
  onClose: () => void;
  /** 重载项目（索引失败/状态过期时重开同目录，不切欢迎页） */
  onReload: () => void;
  /** 写权限状态（P0；项目级授权口径 = 状态栏胶囊在"区域答不出"时的回落；宿主通用 chrome，零业务词） */
  writable: boolean;
  /** 重授权入口（徽章点击 / 通知 action 共用） */
  onReauth: () => void;
  /**
   * 文件树编辑的脏标签守门（B1）：删除/重命名前由树侧询问宿主——标签状态单源在 App，
   * 这里只做透传接线（与 onOpenFile 同形）。
   */
  guardFileOp?: (paths: readonly string[]) => string | null;
  /** 盘上操作落地后宿主收尾（关干净标签/改标签路径）；同上只透传 */
  onFilesGone?: (deleted: readonly string[], renamed: ReadonlyArray<{ from: string; to: string }>) => void;
  /**
   * 树刷新句柄注册（B6 拖入复制）：宿主把 OS 文件复制进树的某个目录后，用它失效
   * 目标目录的列举缓存——file.changed 事件被 affectsKojoTree 按口上域过滤、监视还有
   * 去抖延迟，落文件的那次重列等不起，这里给一条直通车。形态照 registerActions。
   */
  registerTreeRefresh?: (refresh: () => void) => void;
  /**
   * 会话级附加根（D1，对标 VSCode Add Folder to Workspace）：真源在宿主 App
   * （关项目即清），这里只透传给文件树（fs 视图多根并列）与检索面板（并入检索根）。
   */
  extraRoots?: readonly string[];
  /** 「添加文件夹…」入口（对话框与去重都在宿主 App，这里只发意图） */
  onAddExtraRoot?: () => void;
  /**
   * 「从工作区移除」入口（WS-08）：附加根只能加不能减的欠账，入口挂在树根分组头上。
   * 缺省 ⇒ 组头不画那颗按钮（没有落地面就不摆一个点了没反应的按钮）。
   */
  onRemoveExtraRoot?: (dir: string) => void;
  /**
   * 分屏比例（WS-06）：长度 = 组数 - 1 的归一份额（末组吃剩余）。缺省 / 长度不符
   * ⇒ 均分（与旧行为逐字一致）。宿主是真源，这里只渲染；拖动过程**不**回写。
   */
  splitSizes?: readonly number[];
  /** 分隔条松手时的回报（拖动过程不调用；宿主负责 setState 与落盘） */
  onSplitSizesChange?: (sizes: readonly number[]) => void;
  /**
   * 「打开最近项目」子菜单的数据源（WS-07）：与欢迎页最近列表同一份（App 的 `recent`）。
   * 这里只透传给壳层，菜单项构造住在 `project-open-menu.ts`（纯函数、可单测）。
   */
  recentProjects?: readonly RecentProject[];
  /** 按目录切换项目（走宿主既有 openProject：脏确认 / 换根守卫一条不少） */
  onOpenProject?: (dir: string) => void;
  /** 「打开项目文件夹…」入口（系统目录对话框；与欢迎页同一个 chooseAndOpen） */
  onOpenProjectFolder?: () => void;
  /**
   * 宿主追加的壳层命令（K2-MIGRATE-MOUNT）：命令表在这里合并，**注册源仍在宿主**
   * （`App.tsx` 按开关注入 `kojo2-migrate-entry.ts` 的 `commands()`；开关关 ⇒ 空数组
   * ⇒ 与接线前逐字一致）。这里只做透传，不认识任何一条命令的语义。
   */
  extraShellCommands?: readonly ShellCommandSpec[];
}

/**
 * 文件树重列的合批窗口（HK-5）。比内核去抖（200ms，§5.84）略宽：
 * 树重列一次要打好几个 `listDir`，比"重载一个 model"贵；
 * 而对作者来说"外部丢的文件在不到一秒后自己出现"已经足够即时，再小没有体感收益。
 */
const TREE_REFRESH_WINDOW_MS = 400;

/**
 * 编辑器组聚焦命令的档位（WS-14 · `Ctrl+1..4`）。
 *
 * 为什么到 4 而不是无限：键位表里数字族只有 1..4 是空位（`Ctrl+0` 已给文字缩放），
 * 而 4 格分屏在 1080p 上已经是"每格看不见口上行"的宽度。要第 5 格请用
 * 「上一个 / 下一个编辑器组」环形切——命令表不必为罕见的布局再吃键位。
 */
const GROUP_FOCUS_ORDINALS: readonly number[] = [1, 2, 3, 4];

/** 检索范围候选的空值（ref 初值；没提供方时面板与改动前逐字一致） */
const NO_SEARCH_SCOPES: SearchScopeCatalog = { items: [], notices: [] };

/**
 * 内建视图的**宿主版本闸**（PS-6 正确性修复）。
 *
 * `deps` 里任一项变化 ⇒ 返回的数自增；全同 ⇒ 同一个数。壳层把它转给
 * `PanelBody.hostVersion`，memo 才有地方看见"桥后面的值换了"。
 * 判等步住在 `PanelHost.hostVersionStep`（纯函数、可单测），这里只负责跨渲染记账。
 *
 * 为什么不用 `useMemo` 造个新对象：这三只面板的**组件身份必须恒定**（内联箭头组件 =
 * 每帧新类型 = 整棵树重挂、展开态全丢——本文件那条老教训），所以"变了"只能一个数字说。
 */
function useHostVersion(deps: readonly unknown[]): number {
  const state = useRef<HostVersionState>({ version: 0, deps });
  state.current = hostVersionStep(state.current, deps);
  return state.current.version;
}

/**
 * `EditorPane` 的**模块级 memo 包装**（PS-6 第 3 项，改在调用侧）。
 *
 * 为什么在这里包而不是去改 `EditorPane.tsx`：那条文件本批由另一条线独写。
 * 为什么必须是**模块级常量**：在组件里 `memo(EditorPane)` 每帧产一个新类型 ⇒ 立刻重挂，
 * 比不包还糟。光标移动那类与编辑器 props 无关的壳层重渲，从此停在壳层门口。
 */
const EditorPaneMemo = memo(EditorPane);

/**
 * 一组编辑器的**恒定身份回调集**（见 ProjectView 内的 `callbacksFor`）。
 * `register` 只在宿主传了 `registerActions` 时才接线（缺省仍是 undefined，零改动语义）。
 *
 * PS-16：标签栏五条回调并入同一张表——TabBar memo 化后，装配处的内联箭头
 * （`(p) => onActivateTabInGroup(g.id, p)` 每帧新函数）是唯一残余的失效源，
 * 不并入则 memo 形同虚设。宿主回调经 ref 镜像取最新值，闭包不过时。
 */
interface GroupCallbacks {
  readonly onStatusInfo: (info: EditorStatusInfo | null) => void;
  readonly onFocused: () => void;
  readonly register: (actions: EditorPaneActions | null) => void;
  readonly onActivateTab: (p: string) => void;
  readonly onRequestCloseTab: (p: string) => void;
  readonly onReorderTab: (p: string, toIndex: number) => void;
  readonly onTogglePin: (p: string) => void;
  readonly onBatchCloseTab: (mode: BatchCloseMode, anchor: string) => void;
  readonly onMoveTabToGroup: (p: string, targetGroupId: string, toIndex?: number) => void;
}

/**
 * 项目视图（UI 重设计批 P1；P3 多标签）：壳层 = 五区布局（ShellLayout），
 * 编辑器区内容 = 标签栏 + 只读横幅 + 编辑器/空态。
 *
 * 口上文件树是壳层**内建视图**，以与 `ui.panel` 槽同构的贡献形态注入
 * （group:'explorer'，与函数树合并为单 Explorer——定稿 Q5）。
 */
export function ProjectView({
  kernel,
  project,
  index,
  indexing,
  indexError,
  activeFile,
  openTabs,
  groups,
  activeGroupId,
  orientation,
  onActivateGroup,
  onActivateTabInGroup,
  onRequestCloseTabInGroup,
  onReorderTabInGroup,
  onTogglePinInGroup,
  onBatchCloseTabInGroup,
  onMoveTabBetweenGroups,
  onSplitEditor,
  onSplitEditorDown,
  onSetGroupsOrientation,
  onFocusGroupOrdinal,
  onCycleActiveGroup,
  onResizeActiveGroup,
  onCloseGroup,
  onNavBack,
  onNavForward,
  onReopenClosedTab,
  dirtyPaths,
  pinnedPaths,
  reveal,
  onOpenFile,
  recentFiles,
  onRequestCloseTab,
  onSaveAll,
  onDirtyChange,
  registerActions,
  onClose,
  onReload,
  writable,
  onReauth,
  guardFileOp,
  onFilesGone,
  registerTreeRefresh,
  extraRoots,
  onAddExtraRoot,
  onRemoveExtraRoot,
  splitSizes,
  onSplitSizesChange,
  recentProjects,
  onOpenProject,
  onOpenProjectFolder,
  extraShellCommands,
}: Props): ReactElement {
  /**
   * 每组各自的状态上报（SPLIT-1）：状态栏显示**焦点组**的编码/EOL/行数——
   * 各组把状态写进 ref 表，焦点切换时取焦点组那份。
   *
   * PS-6：这里**不再有 `editorStatus` state**。读数写进壳层的叶子 store
   * （`setShellEditorStatus`），只有状态栏那三格小字订阅它。
   */
  const statusByGroupRef = useRef(new Map<string, EditorStatusInfo | null>());
  const activeGroupIdRef = useRef(activeGroupId);
  activeGroupIdRef.current = activeGroupId;
  useEffect(() => {
    setShellEditorStatus(statusByGroupRef.current.get(activeGroupId) ?? null);
  }, [activeGroupId]);
  /**
   * 状态上报的**腰带**（PS-6 第 3 项：光标移动不再往上抬状态）。
   *
   * 旧形态这里 `setEditorStatus(info)` ⇒ ProjectView 重渲 ⇒ ShellLayout 重渲 ⇒
   * EditorPane 与整棵 children 跟着重算，而代价只换来状态栏一行字变几个数字。
   * 现在写 store：内容相等连通知都不发（判据在 `isSameEditorStatus`，壳层那侧），
   * 内容变了也只惊动订阅它的小叶子。
   *
   * `EditorStatusInfo` 是纯数据（字符串 + 数字），逐字段相等就是"状态没变"；
   * 判据不全（新字段漏比）会退化成"每次都算变了"，只是腰带变松，不影响正确性。
   */
  const handleStatusInfo = useCallback((gid: string, info: EditorStatusInfo | null) => {
    statusByGroupRef.current.set(gid, info);
    if (gid === activeGroupIdRef.current) setShellEditorStatus(info);
  }, []);
  /**
   * 卸载时清读数（PS-6）：store 是模块级的，活得比一次 `ProjectView` 挂载久。
   * 不清 ⇒ 关项目回欢迎页、或换一个项目时，上一个文件的「GBK · CRLF · 52,601 行」
   * 会挂在状态栏上直到下一次上报——那是一条会说谎的读数。
   */
  useEffect(() => () => setShellEditorStatus(null), []);
  /**
   * **每组一条恒定身份的上报/回调**（渲染环的父侧根因，与上面的内容相等是同一件事的两半）。
   *
   * 这些回调原本写成 render 里的内联箭头（`(info) => handleStatusInfo(g.id, info)`）：
   * 每次渲染都是新函数 ⇒ 子侧 `useEffect(..., [onStatusInfo])` 每帧重跑，而它的 cleanup
   * 正是 `onStatusInfo(null)` —— 上报 null ⇒ 父侧 setState ⇒ 再渲染 ⇒ 环自己咬住自己。
   * 按组 id 缓存（读 ref 拿最新的宿主回调，闭包不过时），组关了就回收，表有界。
   */
  const registerActionsRef = useRef(registerActions);
  registerActionsRef.current = registerActions;
  /**
   * 各组编辑器动作句柄的本地副本（W7-H）：状态栏 EOL 菜单要把"切换行"落到**焦点组**，
   * 而宿主注册口只转发给 App —— 这里留一份同源引用（与宿主同一条注册拍，不另开协议）。
   * 组关闭时随回调表一起回收（有界）。
   */
  const paneActionsRef = useRef(new Map<string, EditorPaneActions>());
  const onActivateGroupRef = useRef(onActivateGroup);
  onActivateGroupRef.current = onActivateGroup;
  /** 标签栏宿主回调的 ref 镜像（PS-16）：闭包恒定、取值最新，与上面两条同款腰带 */
  const tabHostRef = useRef({
    onActivateTabInGroup,
    onRequestCloseTabInGroup,
    onReorderTabInGroup,
    onTogglePinInGroup,
    onBatchCloseTabInGroup,
    onMoveTabBetweenGroups,
  });
  tabHostRef.current = {
    onActivateTabInGroup,
    onRequestCloseTabInGroup,
    onReorderTabInGroup,
    onTogglePinInGroup,
    onBatchCloseTabInGroup,
    onMoveTabBetweenGroups,
  };
  const groupCbRef = useRef(new Map<string, GroupCallbacks>());
  const callbacksFor = useCallback((gid: string): GroupCallbacks => {
    let cb = groupCbRef.current.get(gid);
    if (!cb) {
      cb = {
        onStatusInfo: (info) => handleStatusInfo(gid, info),
        onFocused: () => onActivateGroupRef.current(gid),
        register: (actions) => {
          if (actions) paneActionsRef.current.set(gid, actions);
          else paneActionsRef.current.delete(gid);
          registerActionsRef.current?.(gid, actions);
        },
        onActivateTab: (p) => tabHostRef.current.onActivateTabInGroup(gid, p),
        onRequestCloseTab: (p) => tabHostRef.current.onRequestCloseTabInGroup(gid, p),
        onReorderTab: (p, to) => tabHostRef.current.onReorderTabInGroup(gid, p, to),
        onTogglePin: (p) => tabHostRef.current.onTogglePinInGroup(gid, p),
        onBatchCloseTab: (mode, anchor) => tabHostRef.current.onBatchCloseTabInGroup(gid, mode, anchor),
        onMoveTabToGroup: (p, targetGroupId, toIndex) =>
          tabHostRef.current.onMoveTabBetweenGroups(p, gid, targetGroupId, toIndex),
      };
      groupCbRef.current.set(gid, cb);
    }
    return cb;
  }, [handleStatusInfo]);
  // 组关闭后回收其回调（Map 与组数同界；组 id 由宿主分配）
  useEffect(() => {
    const alive = new Set(groups.map((g) => g.id));
    for (const id of [...groupCbRef.current.keys()]) if (!alive.has(id)) groupCbRef.current.delete(id);
    for (const id of [...paneActionsRef.current.keys()]) if (!alive.has(id)) paneActionsRef.current.delete(id);
  }, [groups]);
  /**
   * 状态栏 EOL 菜单 → **焦点组**的编辑器动作（W7-H）。
   * 入口是否出现由 EditorPane 上报的 `eolSwitchable` 决定（只读 / 预览面不画）；
   * 这里只做转发，不复制第二份可切换判据。组没注册句柄 ⇒ 静默无操作（不会发生：
   * 有读数就说明该组的 EditorPane 正挂在屏幕上并已注册）。
   */
  const switchEolInActiveGroup = useCallback((eol: 'LF' | 'CRLF'): void => {
    paneActionsRef.current.get(activeGroupIdRef.current)?.switchEol(eol);
  }, []);
  /** 壳层通知（G1：命令按下去必须有回应——兑现不了就说一句人话，不灰掉不说话） */
  const notify = useNotify();
  /**
   * 工作区根模型（WS-04）：树 / Ctrl+P / 检索 / 整项目诊断**同一份**根表。
   *
   * 作品目录是活读数（本会话新建 / 导入的作品自动进模型，不需要手动加根）；
   * 变化信号与监视那条同源（`use-workspace-folders.ts`），所以"作品建好了但
   * 树里看不见"这类裂缝不会再出现。
   */
  const workspaceFolders = useWorkspaceFolders(kernel, project, extraRoots);
  /** 壳层工作台 API（空态动作按钮：快速打开 / 命令面板 / 新建口上文件） */
  const [workbench, setWorkbench] = useState<WorkbenchApi | null>(null);
  /** Ctrl+W 命令读最新活动标签（壳层命令注册一次，闭包外取值） */
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;

  /**
   * 检索范围候选（C3 领域限定检索批）：**判据不在本层**。宿主只做接线——问槽上
   * 有哪些提供方、把当前项目递回去、拿回"标签 + 目录"这两样自己不需要理解的泛型事实。
   * 没有任何提供方（没开项目 / 游戏不给这概念）⇒ 候选空 ⇒ 面板整行不画 = 今天的行为。
   *
   * 依赖刻意只到 `project`（不跟 `roots`）：候选是项目的属性，收窄在发请求那一刻才做。
   * （W7 起这份候选还多喂一处：下面的"只看"接线要按 `key` 找回位置集合。）
   */
  const searchScopes = useMemo(
    () => collectSearchScopes(kernel.slots.query('search.scope'), project),
    [kernel, project],
  );

  // 统计（v0.1 验收指标：角色数 / 文件数 / 函数数）
  // PS-6：这份计数挂在索引对象上，不是挂在渲染次数上——真语料 2,325 个条目，
  // 以前壳层每渲一次就把整张表再数一遍（状态栏那格读数要的是数字，不是新的遍历）。
  const stats = useMemo(() => {
    let fileCount = 0;
    let fnCount = 0;
    if (index) {
      for (const f of index.files.values()) {
        fileCount++;
        fnCount += f.functions.length;
      }
    }
    return { fileCount, fnCount };
  }, [index]);
  const { fileCount, fnCount } = stats;

  /**
   * 上抛给 `EditorPane` 的两条回调的**恒定身份包装**（PS-6 第 3 项）。
   *
   * `EditorPaneMemo` 只认 props 引用：这两条若是宿主每次渲染现建的闭包，
   * memo 就等于没包。真源仍是宿主传进来的那两条（经 ref 读最新值，闭包不过时），
   * 这里只是把"每次新函数"折成"每次同一个函数 + 读最新实现"。
   */
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const onReauthRef = useRef(onReauth);
  onReauthRef.current = onReauth;
  const stableDirtyChange = useCallback((path: string, dirty: boolean) => {
    onDirtyChangeRef.current?.(path, dirty);
  }, []);
  const stableReauth = useCallback(() => onReauthRef.current(), []);

  /**
   * 「只看」范围的**接线**（W7 NAV-SCOPE）：选择器住在搜索面板（它的状态在检索 store 里），
   * 而这条范围现在要喂**四条**通道——全文检索（面板自己收窄检索根）、函数树（插件，经总线）、
   * `Ctrl+T`（`collectWorkspaceSymbols` 读同一状态源）、`Ctrl+P`（这里过滤候选清单）。
   *
   * 宿主这一层只做两件事：把选择器 `key` 翻成**泛型事实**（`key` + 位置集合），
   * 写进唯一状态源并广播给插件侧。订阅只认 `scopeKey` 一个字段：检索 store 每敲一个字符
   * 都 notify，整壳层跟着重渲是白付的钱。
   */
  const [scopeKey, setScopeKey] = useState<string>(() => readSearchState().scopeKey);
  useEffect(
    () =>
      subscribeSearchState(() => {
        const next = readSearchState().scopeKey;
        setScopeKey((prev) => (prev === next ? prev : next));
      }),
    [],
  );
  const navScope = useMemo(
    () => resolveScope(searchScopes.items, scopeKey),
    [searchScopes, scopeKey],
  );
  useEffect(() => {
    setActiveScope(navScope);
    // 插件侧消费者（函数树）与宿主侧消费者读同一份戳；事件名是契约常量，两侧不各写字符串
    kernel.bus.emit(NAV_SCOPE_EVENT, navScope);
  }, [kernel, navScope]);

  /**
   * 快速打开的候选（P2 → W7 NAV-SCOPE → PS-14 候选清单缓存）。
   *
   * 三件事变了形态：**① 不再只有 ERB 索引**——口上域的递归列举把 `.kojo` 这些方言文件
   * 也带进来（写了半天的糖源文件按 Ctrl+P 搜不到，是"索引即全部"这个假设的账单）；
   * **② 跟着"只看"走**——选定范围后候选清单就只剩那一处（与另三条通道同一个戳、同一条
   * `pathInScope`；判据不在宿主里重写）。列举失败 ⇒ 退回索引那份，不炸面板。
   * **③ 会话级缓存（PS-14）**——列举源从「effect 每次 [kernel, project] 变化就裸走
   * `walkDialectPaths`」换成 `listSourceFiles` + `createSourceFileCache`：同项目
   * 连开 N 次 Ctrl+P 只有一趟 walk；失效判据接的是树重列已有的合批信号 `treeNonce`
   * （`file.changed` 经 `affectsKojoTree` 过滤 + 400ms 合批，见下方 effect）——
   * 不另造一套失效机制。附带把 D1 的欠账补上：候选根此前漏了 `extraRoots`
   * （附加根加进来就是为了能被找到，检索面板认、Ctrl+P 不认 = 自相矛盾）。
   */
  // 冷开快照的递归列举桥（树即时化批）：索引要数秒才就绪，FileTree 用它在左栏先出文件
  // （一次 walkDir 拿全口上域清单；索引就绪后按索引路径切换，同构不重排）。
  // PS-14 之后快速打开的候选缓存也走这座桥（声明在前：下方 sourceFiles 段已消费）。
  const walkDir = useMemo(() => kernel.io.walkDir.bind(kernel.io), [kernel]);
  /**
   * 树重列信号（HK-5）：递增即失效——FileTree 与 PS-14 的候选缓存都只认"变化"
   * （用布尔会把连续两次外部改动合并掉）。声明在前是因为本段下方两处消费。
   */
  const [treeNonce, setTreeNonce] = useState(0);
  const [sourceFiles, setSourceFiles] = useState<readonly string[]>([]);
  /** 缓存器与 walkDir 桥同生命周期（kernel 换 ⇒ 缓存整体作废，键里不用带 kernel） */
  const sourceFilesCache = useMemo(() => createSourceFileCache(walkDir), [walkDir]);
  /** 候选根 = 工作区模型里带 `quickOpen` 的那一组（口上域 ∪ 作品目录 ∪ 会话级附加根；
   *  与监视 / 树 / 检索同一份表，写法的去重与嵌套折叠都在模型里做过） */
  const sourceRoots = useMemo(() => quickOpenRootsOf(workspaceFolders), [workspaceFolders]);
  useEffect(() => {
    let alive = true;
    void sourceFilesCache
      .list(sourceRoots, treeNonce)
      .then((files) => {
        // 读不到附加清单不是故障上屏的理由：索引那份照样能开文件，只是少了非 ERB 的那些
        if (alive) setSourceFiles(files);
      })
      .catch(() => {
        // 整趟列举失败（极端形态）：保留上一次的清单——旧候选仍能开文件，比清空好
      });
    return () => {
      alive = false;
    };
  }, [sourceFilesCache, sourceRoots, treeNonce]);

  const quickOpenFiles = useMemo<string[]>(
    () =>
      filterPathsByActiveScope(
        mergeCandidatePaths([index ? [...index.files.keys()] : [], sourceFiles]),
        (p) => p,
      ),
    // navScope 是真实依赖（状态源的读数）：范围换了要重算候选——memo 体只读模块状态，
    // 不写进依赖就等于把"只看"又变成一个不会失效的旧读数
    [index, sourceFiles, navScope],
  );

  // 编辑器区壳层命令（P3：关闭标签 / 全部保存——容器语义，零业务知识）。
  // 键位从键位注册表现取（R8）：缺省 + 用户改键覆盖，kbVersion 变化即重建。
  const kbVersion = useKeybindingsVersion();
  const extraCommands = useMemo<readonly ShellCommandSpec[]>(
    () => [
      {
        id: 'workbench.closeActiveTab',
        title: '关闭当前标签',
        keybinding: effectiveKeybindingOf('workbench.closeActiveTab'),
        run: () => {
          const p = activeFileRef.current;
          if (p) onRequestCloseTab(p);
        },
      },
      {
        id: 'workbench.saveAll',
        title: '全部保存',
        keybinding: effectiveKeybindingOf('workbench.saveAll'),
        run: () => {
          void onSaveAll();
        },
      },
      // 一键修复（E3 · 批量快速修复批）：把**当前这一份文件**里每一条"只有唯一改法"
      // 的问题一次补好。与「全部保存」同形（壳层只发意图，落地与结果播报全在宿主
      // EditorPane —— 壳层不认识波浪线、更不认识补词是什么）。
      // **刻意不灰掉**（与 `workbench.workspaceSymbols` 同理）：按得下去才说得出为什么没修。
      {
        id: 'workbench.fixAll',
        title: '一键修复当前文件',
        keybinding: effectiveKeybindingOf('workbench.fixAll'),
        run: () => {
          kernel.bus.emit('editor.fixAll.request', {});
        },
      },
      // 预览开关的命令（含 Ctrl+Alt+T）恒在注册表里：预览已交付为常态功能，
      // 不再受封存总闸管辖（总闸现在只管 `sealed.ts` 清单里的两只面板）。
      {
        // 预览：整份 ERB 投影成 .kojo 写法（只读显示）。命令面板与快捷键都从这里进——
        // 与工具条按钮同一条意图事件，宿主（EditorPane）是唯一的状态所有者。
        // 标题跟其余命令同形（裸动宾、无括号，见「切换写作模式」），措辞跟工具条同词
        // （「.kojo 预览」——命令面板是作者找到这功能的入口，名字必须一致）。
        id: 'workbench.toggleSugarView',
        title: '切换 .kojo 预览',
        keybinding: effectiveKeybindingOf('workbench.toggleSugarView'),
        run: () => {
          kernel.bus.emit('editor.sugarView.set', {});
        },
      },
      // G1「看这一行的状态」（2026-10-16 跳到命中状态批）：光标所在那一段 + 那一行
      // → 状态回放面板里对应的那条记录。宿主只做"位置 → 中性名字 → 发意图"，
      // 命中判定与呈现全在回放面板那一处（编辑器里不画第二份标记，也不新建显示面）。
      // 与「转到工作区符号」同款**刻意不给 `when`**：没打开文件也要按得下去，
      // 按下去必须听到响（铁律 4）——兑现不了就回一句人话，绝不灰着不说话。
      {
        id: 'workbench.jumpToState',
        title: '看这一行的状态',
        keybinding: effectiveKeybindingOf('workbench.jumpToState'),
        run: () => {
          requestJumpToState({
            probe: readJumpProbe,
            emit: (intent) => kernel.bus.emit('kojo.replayFunction', { ...intent, source: JUMP_TO_STATE_SOURCE }),
            say: (message) => notify({ kind: 'info', message }),
          });
        },
      },
      // 分屏（SPLIT-1 编辑器组批）：向右拆分 = 从焦点组复制激活标签开新组；关组只关焦点组。
      // 关组刻意不带缺省键位（面板入口即可）——Ctrl+W 已经是关标签，误按代价高。
      {
        id: 'workbench.splitEditor',
        title: '向右拆分编辑器',
        keybinding: effectiveKeybindingOf('workbench.splitEditor'),
        run: () => onSplitEditor(),
      },
      {
        id: 'workbench.closeEditorGroup',
        title: '关闭编辑器组',
        keybinding: effectiveKeybindingOf('workbench.closeEditorGroup'),
        run: () => onCloseGroup(activeGroupIdRef.current),
      },
      // 导航历史（MM-6 前进/后退 + MM-10 恢复关闭的标签，编辑器肌肉记忆批）：
      // 三条腿的栈都在宿主 App（navRef + 纯逻辑 navigation-history.ts），壳层只发意图；
      // 边界（栈底/栈顶/恢复栈空）由宿主回人话通知——按得下去就听得到响（铁律 4）。
      {
        id: 'workbench.navBack',
        title: '后退',
        keybinding: effectiveKeybindingOf('workbench.navBack'),
        run: () => onNavBack(),
      },
      {
        id: 'workbench.navForward',
        title: '前进',
        keybinding: effectiveKeybindingOf('workbench.navForward'),
        run: () => onNavForward(),
      },
      {
        id: 'workbench.reopenClosedTab',
        title: '恢复关闭的标签',
        keybinding: effectiveKeybindingOf('workbench.reopenClosedTab'),
        run: () => onReopenClosedTab(),
      },
      // 标签后用序切换（1020 编辑器体感批）：命令只发意图，MRU 真源在宿主 App
      // （tab-cycle 是一个模块级发布订阅——它不是跨插件的业务事件，不该进 plugin-api 事件面）。
      {
        id: 'workbench.nextTab',
        title: '切到上一个用过的标签',
        keybinding: effectiveKeybindingOf('workbench.nextTab'),
        run: () => requestTabCycle('next'),
      },
      {
        id: 'workbench.prevTab',
        title: '切到下一个用过的标签',
        keybinding: effectiveKeybindingOf('workbench.prevTab'),
        run: () => requestTabCycle('prev'),
      },
      /* ---- 编辑器动作（R8 命令面板补齐批）：壳层发意图，EditorPane 落 Monaco 动作 ----
       * **刻意不带缺省键位**：编辑器内这些动作 Monaco 已有内建键（Ctrl+F / Ctrl+H /
       * Shift+Alt+F / F2 / Shift+F12），宿主命令不抢键（注册表带键会在编辑器聚焦时
       * 与 Monaco 抢同一次按键）；命令面板是无键入口，想要键位可在键盘快捷键里自绑。 */
      {
        id: 'editor.action.find',
        title: '查找',
        category: '编辑器',
        run: () => {
          kernel.bus.emit('editor.action.request', { action: 'find', source: '命令面板' });
        },
      },
      {
        id: 'editor.action.replace',
        title: '替换',
        category: '编辑器',
        run: () => {
          kernel.bus.emit('editor.action.request', { action: 'replace', source: '命令面板' });
        },
      },
      {
        id: 'editor.action.formatDocument',
        title: '格式化文档',
        category: '编辑器',
        run: () => {
          kernel.bus.emit('editor.action.request', { action: 'formatDocument', source: '命令面板' });
        },
      },
      {
        id: 'editor.action.rename',
        title: '重命名符号',
        category: '编辑器',
        run: () => {
          kernel.bus.emit('editor.action.request', { action: 'rename', source: '命令面板' });
        },
      },
      {
        id: 'editor.action.references',
        title: '查找引用',
        category: '编辑器',
        run: () => {
          kernel.bus.emit('editor.action.request', { action: 'references', source: '命令面板' });
        },
      },
      {
        id: 'editor.action.gotoLine',
        title: '转到行',
        category: '编辑器',
        run: () => {
          kernel.bus.emit('editor.action.request', { action: 'gotoLine', source: '命令面板' });
        },
      },
      /* ---- 编辑器组布局（MM-9）：向下拆分 + 上下/左右排列 ----
       * 与 workbench.splitEditor 同族：壳层只发意图，组态推进全在宿主的纯逻辑层。
       * 翻方向命令**刻意不灰**（铁律 4）：单组时按得下去，但先给一句人话——
       * 翻了也看不出来，不如告诉作者先拆出多个组。 */
      {
        id: 'workbench.splitEditorDown',
        title: '向下拆分编辑器',
        keybinding: effectiveKeybindingOf('workbench.splitEditorDown'),
        run: () => onSplitEditorDown(),
      },
      {
        id: 'workbench.setGroupsColumn',
        title: '编辑器组上下排列',
        keybinding: effectiveKeybindingOf('workbench.setGroupsColumn'),
        run: () => {
          if (groups.length < 2) {
            notify({ kind: 'info', message: '先拆分出多个编辑器组，再切换排列方向' });
            return;
          }
          onSetGroupsOrientation('column');
        },
      },
      {
        id: 'workbench.setGroupsRow',
        title: '编辑器组左右排列',
        keybinding: effectiveKeybindingOf('workbench.setGroupsRow'),
        run: () => {
          if (groups.length < 2) {
            notify({ kind: 'info', message: '先拆分出多个编辑器组，再切换排列方向' });
            return;
          }
          onSetGroupsOrientation('row');
        },
      },
      /* ---- 编辑器组聚焦与键盘调分隔条（WS-14：组态还差的那半套）----
       * 判据全在 `editor-groups` 的纯函数里（**排列序 = 数组序**，不是创建序 id），
       * 这里只把它们折成命令项；"没有第 4 组 / 已经拉到边界"的人话由宿主 App 给
       * （铁律 4：按得下去就要有交代）。
       * **刻意不灰**这些命令（与 `workbench.setGroupsRow` 同形态）：灰掉会让作者读成
       * "这功能没做"，而真相反只是"现在只有一格"——那句人话才是答案。
       * 宿主没给入口（旧调用方 / 单测）⇒ 整族命令不出现，与拆分那族同口径。 */
      ...(onFocusGroupOrdinal !== undefined
        ? GROUP_FOCUS_ORDINALS.map((n) => ({
            id: `workbench.focusGroup${n}`,
            title: `聚焦第 ${n} 个编辑器组`,
            category: '工作台',
            keybinding: effectiveKeybindingOf(`workbench.focusGroup${n}`),
            run: () => onFocusGroupOrdinal(n - 1),
          }))
        : []),
      ...(onCycleActiveGroup !== undefined
        ? [
            {
              id: 'workbench.prevEditorGroup',
              title: '上一个编辑器组',
              category: '工作台',
              keybinding: effectiveKeybindingOf('workbench.prevEditorGroup'),
              run: () => onCycleActiveGroup(-1),
            },
            {
              id: 'workbench.nextEditorGroup',
              title: '下一个编辑器组',
              category: '工作台',
              keybinding: effectiveKeybindingOf('workbench.nextEditorGroup'),
              run: () => onCycleActiveGroup(1),
            },
          ]
        : []),
      ...(onResizeActiveGroup !== undefined
        ? [
            {
              id: 'workbench.enlargeActiveGroup',
              title: '放大焦点编辑器组',
              category: '工作台',
              keybinding: effectiveKeybindingOf('workbench.enlargeActiveGroup'),
              run: () => onResizeActiveGroup(1),
            },
            {
              id: 'workbench.shrinkActiveGroup',
              title: '缩小焦点编辑器组',
              category: '工作台',
              keybinding: effectiveKeybindingOf('workbench.shrinkActiveGroup'),
              run: () => onResizeActiveGroup(-1),
            },
          ]
        : []),
      /* ---- 资源管理器剪贴板家族（WS-13 2a 车）----
       * 命令面板 / 键位页的入口；执行腿只有树自己那条（宾语与落点都要现场：多选集、
       * 焦点行、目录缓存都在 `FileTree` 的运行时桥里现读）。树没挂载（项目没开、
       * 侧栏被换掉）⇒ `runExplorerOp` 回 false，这里必须说人话——静默返回是铁律 4 的形状。
       * 键位四条**刻意不带缺省键**（登记与理由见 `keybinding-specs-commands.ts`）：
       * Ctrl+C/X/V/D 走树内白名单，全局认领会把编辑器的复制粘贴抢走。 */
      { id: EXPLORER_COPY_COMMAND, title: '复制到剪贴板', category: '资源管理器', run: () => { if (!runExplorerOp('copy')) notify({ kind: 'info', message: '资源管理器的树没有挂载——先打开项目再执行。' }); } },
      { id: EXPLORER_CUT_COMMAND, title: '剪切到剪贴板', category: '资源管理器', run: () => { if (!runExplorerOp('cut')) notify({ kind: 'info', message: '资源管理器的树没有挂载——先打开项目再执行。' }); } },
      { id: EXPLORER_PASTE_COMMAND, title: '粘贴到当前文件夹', category: '资源管理器', run: () => { if (!runExplorerOp('paste')) notify({ kind: 'info', message: '资源管理器的树没有挂载——先打开项目再执行。' }); } },
      { id: EXPLORER_DUPLICATE_COMMAND, title: '创建副本', category: '资源管理器', run: () => { if (!runExplorerOp('duplicate')) notify({ kind: 'info', message: '资源管理器的树没有挂载——先打开项目再执行。' }); } },
      // 撤销这次删除（WS-13 2c 车）：宾语是会话台账里刚删的那一批，收尾（重列目录 / 放回索引）
      // 全在树里 ⇒ 仍走那座运行时桥。桥不在、或树没登记这条腿 ⇒ 照实说一句，不静默返回。
      { id: EXPLORER_UNDO_DELETE_COMMAND, title: '撤销这次删除', category: '资源管理器', run: () => { if (!runExplorerUndoDelete()) notify({ kind: 'info', message: '撤销打不出去：资源管理器的树没有挂载，或这次会话里还没有删过东西。' }); } },
      // 宿主追加的命令（K2-MIGRATE-MOUNT；开关关时是空数组，表与接线前逐字一致）
      ...(extraShellCommands ?? []),
    ],
    // kbVersion 是真实依赖：改键覆盖 → 版本号自增 → 命令表带新键位重建。
    // groups 也是：三条 MM-9 命令（splitEditorDown / setGroupsColumn / setGroupsRow）
    // 的 run 闭包读它判组数，依赖漏了就是过期读数。
    [onRequestCloseTab, onSaveAll, onSplitEditor, onSplitEditorDown, onSetGroupsOrientation, onFocusGroupOrdinal, onCycleActiveGroup, onResizeActiveGroup, onCloseGroup, onNavBack, onNavForward, onReopenClosedTab, groups, kernel, notify, kbVersion, extraShellCommands],
  );

  // 内建文件树的**稳定组件身份**（用户反馈修复：打开文件会重建内联箭头组件 →
  // React 视作新组件类型 → 整树卸载重挂 → 展开状态被清空。改为身份恒定的包装
  // 组件 + ref 桥接最新 props：重渲染只更新属性，绝不重挂，展开状态常驻）。
  const listDir = useMemo(() => kernel.io.listDir.bind(kernel.io), [kernel]);

  // 导入作者包为工作区项目（口上项目批 P-F）：壳层只发意图事件，
  // 「导入成什么形态」由工作区消费方（适配器）解释——跨层零游戏知识
  const importPackage = useCallback(
    (pkg: { dir: string; label: string }) => {
      kernel.bus.emit('workspace.importRequested', {
        sourceDir: pkg.dir,
        suggestedName: pkg.label,
        source: 'file-tree',
      });
    },
    [kernel],
  );
  /**
   * 「比较已选文件」（D 批）：树只发两条路径，宿主把 `ui.diffView.open` 发进总线。
   *
   * 载荷构造住在 `file-tree-compare.compareSelectedRequest`（纯函数、可单测）：两侧只给
   * **盘上路径**、不给内联文本 ⇒ 差异视图读的是磁盘版本，与「与剪贴板比较」读屏上 model 不同。
   * 宿主本层不读盘、不写盘——读盘由差异视图自己的 `resolveSide` 经内核 io 走。
   */
  const compareSelectedFiles = useCallback(
    (left: string, right: string) => {
      kernel.bus.emit('ui.diffView.open', compareSelectedRequest(left, right, project.rootDir));
    },
    [kernel, project.rootDir],
  );
  /**
   * 搬运的脏闸（WS-13 2a 车）：把会话脏态投影成"这批路径里哪几份是脏的"。
   *
   * **真源只有这一份**：`dirtyPaths` 由编辑器逐文件上抛（宿主 App 持有），匹配判据住
   * `disk-reconcile.dirtyNamesIn`——与删除/重命名守门（`guardFileOp`）同一条腿，
   * 树侧拿到的就是"有没有未保存改动"的同一真相，不许长第二份"脏"定义。
   * 身份恒定（读 ref），所以它进不了、也不需要进 `fileTreeVersion` 的比较面。
   */
  const dirtyPathsRef = useRef(dirtyPaths);
  dirtyPathsRef.current = dirtyPaths;
  const dirtyOf = useCallback(
    (paths: readonly string[]): string[] => dirtyNamesIn(paths, dirtyPathsRef.current),
    [],
  );
  /**
   * 名称显示对照（中日对照：日文名 → 中文名）。
   *
   * 词典是**游戏/语言知识**，只住 game.adapter 插件；本壳层只经槽位读字段、绝不
   * import 任何适配器实现。当前那枚适配器由契约的 `activeGameAdapter` 认，
   * 取其 `nameGlossary`；无词典 → `undefined`（FileTree 原样显示，即旧行为）。
   * 命中规则与各 adapter 侧同口径：按键长降序、`includes` 命中、名字已含对应中文则不重复。
   */
  const nameGloss = useMemo<((name: string) => string) | undefined>(() => {
    const dict = activeGameAdapter(kernel.slots.query('game.adapter'), project.adapterId)?.nameGlossary;
    if (!dict) return undefined;
    const keys = Object.keys(dict).sort((a, b) => b.length - a.length);
    return (name: string): string => {
      if (!name) return name;
      for (const key of keys) {
        if (name.includes(key)) {
          const zh = dict[key]!;
          if (name.includes(zh)) return name;
          return `${name}（${zh}）`;
        }
      }
      return name;
    };
  }, [kernel, project.adapterId]);
  /* ---------------- 外部改动 → 文件树目录重列（HK-5；接 §5.87 留下的欠账） ---------------- */


  /**
   * 外部改动 → 树重列的**判据根集**（S2-6）= 工作区模型里带 `quickOpen` 的那一组
   * （口上域 ∪ 作品目录 ∪ 会话级附加根）。
   * 与监视根同源：监视已经覆盖这些根，过滤却不认它 = 事件到了却被丢掉。
   * 路径口径的比较交给 `affectsKojoTree` 自己。
   */
  const treeWatchRoots = useMemo(() => scanRootsOf(workspaceFolders), [workspaceFolders]);

  // B6：树刷新直通车（宿主拖入复制落地后失效目标目录；句柄只注册一次）
  useEffect(() => {
    registerTreeRefresh?.(() => setTreeNonce((n) => n + 1));
  }, [registerTreeRefresh]);

  useEffect(() => {
    // 合批窗口：一次外部写入常炸出多条事件（原子写临时文件 + rename、连写几份档）。
    // 内核去抖已经按文件合过一轮（§5.84），这里合的是"整棵树的目录重列"这一层。
    const coalescer = createEventCoalescer(() => setTreeNonce((n) => n + 1), TREE_REFRESH_WINDOW_MS);
    const un = kernel.bus.on('file.changed', (ev) => {
      // 首动作零 IO：监视根是口上域 **+ 会话级附加根（D1）**，游戏写存档、写图片缓存同样投递事件，
      // 而树只列举这些根——分野判错就是每次外部写入都白重列一遍（§5.87 立的纪律）。
      // 判据的根集合必须与监视的根集合同口径：只给 kojoPaths 会让附加根下的
      // 外部新建/删除一直不上树，直到用户手动刷新（S2-6 实机反馈）。
      if (affectsKojoTree(ev.path, treeWatchRoots)) coalescer.push();
    });
    return () => {
      un();
      coalescer.dispose();
    };
  }, [kernel, treeWatchRoots]);

  /**
   * 盘上条目新增（树里新建）/ 删除 / 改名 → **索引增量**（WS-05）。
   *
   * 树侧只报事实（哪一份是新的、哪一份没了），落地在 `erb-index-sync`：目录改名按前缀
   * 映射其下已索引的文件，删除按前缀移除——`index.files` 与函数树因此不再留幽灵行。
   * 索引读数走 ref（宿主每次渲染才换它；闭包身份保持恒定，树的 memo 不被击穿）。
   */
  const indexRef = useRef(index);
  indexRef.current = index;
  const onDiskEntriesChanged = useCallback(
    (delta: DiskDelta) => {
      void syncErbIndexAfterDiskChange({ kernel, index: indexRef.current, notify, delta });
    },
    [kernel, notify],
  );
  const fileTreeArgsRef = useRef({ project, index, activeFile, onOpenFile, listDir, walkDir, importPackage, treeNonce, gloss: nameGloss, io: kernel.io, guardFileOp, dirtyOf, onFilesGone, onRevealInExplorer: revealInExplorer, extraRoots: [] as readonly string[], workspaceFolders: [] as readonly WorkspaceFolder[], onDiskEntriesChanged: undefined as ((delta: DiskDelta) => void) | undefined, onAddExtraRoot: undefined as (() => void) | undefined, onRemoveExtraRoot: undefined as ((dir: string) => void) | undefined, onCompareFiles: compareSelectedFiles });
  fileTreeArgsRef.current = { project, index, activeFile, onOpenFile, listDir, walkDir, importPackage, treeNonce, gloss: nameGloss, io: kernel.io, guardFileOp, dirtyOf, onFilesGone, onRevealInExplorer: revealInExplorer, extraRoots: extraRoots ?? [], workspaceFolders, onDiskEntriesChanged, onAddExtraRoot, onRemoveExtraRoot, onCompareFiles: compareSelectedFiles };
  /**
   * 桥换了内容就得有人告诉 memo（PS-6 正确性修复）。
   *
   * `StableFileTree` 的**组件身份恒定**（那是"打开文件不再整树重挂"那批修复的成果，
   * 不许回退），代价是 `PanelBody` 的三条比较项对它永远相等 ⇒ 旧实现里桥进去的
   * `index` / `activeFile` / `refreshNonce` 一次都送不到 `FileTree`：
   * 定位到树（B4）、外部改动后重列（HK-5）、冷开快照转索引三件事全是哑的，
   * 只有偶然重挂组件时才"看起来好了"。这一格计数就是那句话："桥那边变了"。
   */
  const fileTreeVersion = useHostVersion([
    project,
    index,
    activeFile,
    onOpenFile,
    listDir,
    walkDir,
    importPackage,
    treeNonce,
    nameGloss,
    kernel.io,
    guardFileOp,
    onFilesGone,
    extraRoots,
    onAddExtraRoot,
    onRemoveExtraRoot,
    compareSelectedFiles,
    workspaceFolders,
  ]);
  const fileTreeComponent = useMemo(() => {
    const StableFileTree = (): ReactElement => {
      const a = fileTreeArgsRef.current;
      return (
        <FileTree
          project={a.project}
          index={a.index}
          activeFile={a.activeFile}
          onOpenFile={a.onOpenFile}
          listDir={a.listDir}
          walkDir={a.walkDir}
          onImportPackage={a.importPackage}
          io={a.io}
          guardFileOp={a.guardFileOp}
          dirtyOf={a.dirtyOf}
          onFilesGone={a.onFilesGone}
          onRevealInExplorer={a.onRevealInExplorer}
          refreshNonce={a.treeNonce}
          gloss={a.gloss}
          extraRoots={a.extraRoots}
          workspaceFolders={a.workspaceFolders}
          onDiskEntriesChanged={a.onDiskEntriesChanged}
          onAddFolder={a.onAddExtraRoot}
          onRemoveExtraRoot={a.onRemoveExtraRoot}
          onCompareFiles={a.onCompareFiles}
          /**
           * 「在此文件夹中搜索」的宿主腿（WS-13 收尾批）：直接给 `search-store` 的模块函数。
           * 它是恒等稳定的模块级引用（不走 `fileTreeArgsRef` 桥也不必进 `useHostVersion`），
           * 存在性即能力位——传了，树的 `canSearchInFolder` 才翻 true，菜单才摆这一项。
           */
          onSearchInFolder={openFolderSearchScope}
        />
      );
    };
    return StableFileTree;
  }, []);

  // 底部「问题」面板（HK-4 · UI-6）的**稳定组件身份**：同 fileTreeComponent 的 ref 闭包写法——
  // 内建视图组件不要每次 render 换新类型（会 remount 丢掉内部 state），用 ref 持有最新 kernel。
  // 跳源行走既有通道 `editor.revealLocation`（宿主 App.tsx 监听并打开文件定位行）。
  // W9 判据①：载荷一律由 `revealLocationOf` 折出来——面板给的列区间（波浪线那段）
  // 必须跟到落点，否则"点问题落在行首、同一处按 F12 落在名字那一列"。
  const problemArgsRef = useRef({ kernel });
  problemArgsRef.current = { kernel };
  const problemVersion = useHostVersion([kernel]);
  const problemComponent = useMemo(() => {
    const StableProblems = (): ReactElement => {
      const a = problemArgsRef.current;
      return (
        <ProblemPanel
          onReveal={(path, line, span) =>
            a.kernel.bus.emit('editor.revealLocation', revealLocationOf({ path, line, span }, '问题'))
          }
        />
      );
    };
    return StableProblems;
  }, []);

  useEffect(() => {
    /**
     * 口上 XML 的**游戏侧规格**接进编辑器（2026-10-24 XML 口上批）。
     *
     * 为什么在宿主这里接、而不是让 Monaco 层直接取服务：`monaco/*` 属于"内核 / 宿主
     * 层"，审计 A 项禁止它出现具体游戏的属性枚举——所以它只认 `KojoXmlSchema` 这个
     * 形状，由宿主把 adapter 的实现塞进去。取不到（eraTW 工程 / 插件未装）⇒ 撤回，
     * XML 语言面退化为"只有语法高亮"，补全与枚举诊断都不出现（而不是瞎猜）。
     */
    const xml = kernel.services.tryGet<KojoXmlService>(WellKnownServices.KojoXml);
    setKojoXmlSchemaSource(xml ? () => xml.schema() : null);
    /**
     * 方言事实 + 载体归属接进 XML 诊断（LAU-D3）。
     *
     * 解析全在 `resolveDocumentDialect`（core 的 `resolveDialectBinding` + 宿主输入），
     * 这里只交「这份文件此刻的 facts 与 binding」——`monaco/*` 不认识任何方言，
     * 也不决定归属。取不到（未开项目 / 未绑定）⇒ `null` ⇒ 事件面零诊断（不猜）。
     *
     * 路径口径：Monaco model URI 在 Windows 上是 `/D:/…`（前导斜杠），宿主解析器
     * 要的是盘上的绝对路径；只在盘符形态下剥掉那一个斜杠，其它形态原样交。
     */
    setKojoXmlDialectSource((path, text) => {
      const project = kernel.project.current();
      if (!project) return null;
      const filePath = /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
      const resolution = resolveDocumentDialect({ project, source: text, filePath });
      const binding = resolution.binding;
      if (binding === null) return null;
      return { facts: binding.facts, binding };
    });
    return () => {
      setKojoXmlSchemaSource(null);
      setKojoXmlDialectSource(null);
    };
  }, [kernel]);

  /**
   * 替换执行器装配（R7 搜索替换批）：内核 io 通道（读改写保编码 + 原子写 + 备份，
   * 写允许域由内核强制）+ Monaco live model 通道，随 kernel 生命周期装卸。
   * 未装配时搜索面板的替换入口会被状态机锁住并明示（不静默）。
   * `nameLedger` = F2 改名用的**同一份**出现点台账判据（`.erb` 索引 + `.kojo` 糖源都走
   * 这两条腿）：不接则「全部替换」只看得到已开标签里的糖源，检索范围外的同名记号
   * 没人说出来（W8 XLANG-RENAME 的跨通道回执）。
   * `journal` = 闭文件批量替换进操作账（2026-10-18 undo 覆盖批，additive 可选）：
   * 与 sav-parser / ui-sugar-editor 的 `tryInject` 同款降级——kernel.ops 缺席时替换
   * 照旧（旧行为），只是不进操作历史。
   */
  useEffect(() => {
    setReplaceRunner(
      createFileReplaceRunner({
        io: kernel.io,
        nameLedger: createProjectNameLedger(kernel),
        journal: kernel.services.tryGet<OpJournal>(KernelServices.Ops) ?? undefined,
        // PS-12-C：活面判定只认池。Monaco 注册表对已关标签仍留有残余 model（有界冷档
        // 之后池会 evict，注册表不跟）——拿注册表当活面，替换腿会往"没人看的副本"上写，
        // 盘上真身原封不动（PS-12 冷档批实机踩过）。池只答 refs>0 的活面，
        // undefined ⇒ 执行器自然改走盘路径，语义本来就是对的。
        modelFor: (p) => editorModelPool.liveModel(p),
      }),
    );
    return () => setReplaceRunner(null);
  }, [kernel]);

  /**
   * 侧栏「搜索」视图的稳定组件身份（同 problemComponent 的 ref 闭包写法）。
   *
   * 检索根 = 工作区模型里带 `search` 的那一组（游戏根 ∪ 口上域 ∪ 作品目录 ∪ 附加根；
   * 2026-10-27 收窄批：从"工作区全部根"收窄到作品目录——自选项目位置根可能正是游戏目录，
   * 按根检索会把整个游戏目录拖进检索范围）。只搜项目根会把作者自己写的口上文件整批漏掉；
   * 附加根同理——加进来就是为了"这部分也要能搜到"，漏掉等于没加。
   * 跳转仍走既有 `editor.revealLocation`（与问题面板同一条通道）。
   */
  const searchArgsRef = useRef({ kernel, roots: [] as string[], scopes: NO_SEARCH_SCOPES });
  // 检索根是**活读数**（`workspaceFolders` 每次渲染现算，作品目录那一格来自内核现读）。
  // 它的量是几根目录，每渲一次重算不要钱；真正要省的是"根没变 ⇒ 面板不重渲"，
  // 所以进计数的是拼出来的那串键，不是数组引用。
  const searchRoots = useMemo(() => searchRootsOf(workspaceFolders), [workspaceFolders]);
  searchArgsRef.current = {
    kernel,
    roots: searchRoots,
    scopes: searchScopes,
  };
  const searchVersion = useHostVersion([kernel, searchRoots.join('\n'), searchScopes]);
  const searchComponent = useMemo(() => {
    const StableSearch = (): ReactElement => {
      const a = searchArgsRef.current;
      return (
        <SearchPanel
          roots={a.roots}
          scopes={a.scopes.items}
          scopeNotices={a.scopes.notices}
          onReveal={(path, line, span, options) =>
            // W9 判据①：与问题面板同一个载荷出口（区间折列住在 `revealLocationOf`，
            // 这里不再自己写一遍"`column` = 区间起点"）。
            // W7-B：检索框回车 / Shift+回车带 `focus:false`——逐项跳只定位、不抢检索框焦点。
            a.kernel.bus.emit(
              'editor.revealLocation',
              revealLocationOf({ path, line, span, focus: options?.focus }, '搜索'),
            )
          }
        />
      );
    };
    return StableSearch;
  }, []);

  /**
   * 侧栏「大纲」的稳定组件身份（批次十 S9；同 problem/search 的 ref 闭包写法）。
   *
   * 面板自己订阅内核（光标 / 文档 / 活动文件），宿主只负责两件事：把最新 kernel
   * 桥进去、把跳源折成既有 `editor.revealLocation` 载荷（落点判据仍只在
   * `revealLocationOf` 一处）。kernel 换人时用版本计数把 ref 里的新值送过 memo。
   */
  const outlineArgsRef = useRef({ kernel });
  outlineArgsRef.current = { kernel };
  const outlineVersion = useHostVersion([kernel]);
  const outlineComponent = useMemo(() => {
    const StableOutline = (): ReactElement => {
      const a = outlineArgsRef.current;
      return (
        <OutlinePanel
          kernel={a.kernel}
          onReveal={(path, line) =>
            a.kernel.bus.emit('editor.revealLocation', revealLocationOf({ path, line }, '大纲'))
          }
        />
      );
    };
    return StableOutline;
  }, []);

  /**
   * Kojo 2.0「编译预览」内建底部视图（K2-EDITOR-MOUNT ①）。
   *
   * 挂载点选**既有底部面板区**（与「问题」同一容器、同一种 `UIPanelContribution`），
   * 不新造面板宿主：面板体的数据由编辑器侧的预览入口经模块桥推送（`kojo2-preview-host`），
   * 本文件只负责"有没有这只视图"。
   *
   * flag 关 ⇒ `kojo2PreviewBottomView()` 返回 `null`，底部区连 tab 都不出现（零挂载零监听；
   * 开关是装配那一刻读的，与语言面 / 诊断同一条口径）。
   */
  const kojo2PreviewView = useMemo(() => kojo2PreviewBottomView(), []);

  const builtinViews = useMemo<UIPanelContribution[]>(
    () => [
      {
        id: 'kojo.files',
        title: '口上文件',
        icon: 'files',
        order: 30,
        group: 'explorer',
        location: 'sidebar',
        component: fileTreeComponent,
      },
      {
        // order 40 > 口上文件(30)：活动栏里排在文件树下一位（VSCode 同序），
        // 且**不改默认激活落点**——默认激活取 order 最小的、未声明 defaultActive:false 的视图，
        // 文件树仍旧是先落点。这里刻意**不写** defaultActive:false：那个字段还会把视图
        // 判成"低频"并挪到活动栏下半区（与设置齿轮同排），搜索是有快捷键的主力面，不该在那儿。
        id: 'kojo.search',
        title: '搜索',
        icon: 'search',
        order: 40,
        location: 'sidebar',
        component: searchComponent,
      },
      {
        // 侧栏大纲（批次十 S9）：独立视图 = 活动栏自带开关（点同枚图标收起、再点展开），
        // 激活项与容器尺寸由布局 store 持久化，即"记忆布局"。order 45 排在搜索(40)之后，
        // 不写 defaultActive:false ⇒ 留在活动栏上半区，且不抢文件树(30)的默认激活落点。
        id: 'kojo.outline',
        title: '大纲',
        icon: 'structure',
        order: 45,
        location: 'sidebar',
        component: outlineComponent,
      },
      {
        // defaultActive:false —— 不抢「约定校验」（bottom，order 50）现有的默认激活落点（Ctrl+J）
        id: 'kojo.problems',
        title: '问题',
        icon: 'check',
        order: 40,
        location: 'bottom',
        defaultActive: false,
        component: problemComponent,
      },
      ...(kojo2PreviewView === null ? [] : [kojo2PreviewView]),
    ],
    [fileTreeComponent, problemComponent, searchComponent, outlineComponent, kojo2PreviewView],
  );

  /**
   * 三只内建视图的宿主版本表（PS-6）：`id → 计数`，壳层原样转给对应面板的
   * `PanelBody.hostVersion`。**表里没有的面板（插件面板）不抬号**——它们自己订阅内核，
   * 拿 `undefined` 走 0，memo 行为与改动前逐字一致（不让一次切标签变成十只面板陪跑）。
   */
  const panelHostVersions = useMemo<Readonly<Record<string, number>>>(
    () => ({
      'kojo.files': fileTreeVersion,
      'kojo.search': searchVersion,
      'kojo.problems': problemVersion,
      'kojo.outline': outlineVersion,
    }),
    [fileTreeVersion, searchVersion, problemVersion, outlineVersion],
  );

  /* ---------------- 标签栏（C1/C2/C3）：渲染与交互在 TabBar，宿主只接回调 ---------------- */

  /**
   * 「全部保存」显性按钮的落地面（C3）：无脏标签时按下去也要有响（铁律 4）——
   * 回一句人话而不是沉默；有脏时走既有 saveAll，成功也给一句轻反馈
   * （失败方 EditorPane 的保存链路已显式报错，这里不重复）。
   */
  const handleSaveAllClick = useCallback(() => {
    if (dirtyPaths.size === 0) {
      notify({ kind: 'info', message: '没有未保存的修改' });
      return;
    }
    void onSaveAll().then((ok) => {
      if (ok) notify({ kind: 'info', message: '已保存全部修改' });
    });
  }, [dirtyPaths, onSaveAll, notify]);

  /**
   * 分隔条拖拽（SPLIT-1；WS-06 补上"比例落盘"）。
   *
   * 拖动过程仍**只改相邻两组的 DOM flex**（每帧 setState 会把整壳拖进重渲染，手会抖）；
   * **松手（pointerup / pointercancel）时**才量一遍全部组的像素宽（column 下是高度），
   * 折成归一份额回报宿主（`onSplitSizesChange`），并把 px 立刻换回比例——
   * 拖回原位时"比例值没变、React 不重写 style"这条短路不会把 DOM 留在 px 上。
   *
   * 最小组宽 200px（横拖）/ 120px（竖排：高度才是稀缺维度），防拖没了。
   */
  const groupRefs = useRef(new Map<string, HTMLDivElement | null>());
  /** 组序 / 比例回调的最新值（拖拽闭包活过一次手势，不能握旧值） */
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const onSplitSizesChangeRef = useRef(onSplitSizesChange);
  onSplitSizesChangeRef.current = onSplitSizesChange;
  /** 有效份额（缺省均分；长度不符由 alignSplitSizes 兜成均分——与旧行为一致） */
  const effectiveSplitSizes = useMemo(
    () => alignSplitSizes(splitSizes, groups.length),
    [splitSizes, groups.length],
  );
  const shareOfGroup = useCallback(
    (index: number): number => {
      if (index < effectiveSplitSizes.length) return effectiveSplitSizes[index]!;
      const rest = 1 - effectiveSplitSizes.reduce((a, b) => a + b, 0);
      return rest > 0 ? rest : 0;
    },
    [effectiveSplitSizes],
  );
  const applySizesToDom = useCallback((sizes: readonly number[]) => {
    const list = groupsRef.current;
    const rest = 1 - sizes.reduce((a, b) => a + b, 0);
    list.forEach((g, i) => {
      const el = groupRefs.current.get(g.id);
      if (!el) return;
      const share = i < sizes.length ? sizes[i]! : rest;
      el.style.flex = splitFlexOf(share > 0 ? share : 0);
    });
  }, []);
  /** 松手落定：量像素 → 份额 → 回报宿主（量不出来就维持现状，绝不把布局抹成均分） */
  const commitDividerDrag = useCallback(
    (vertical: boolean) => {
      const list = groupsRef.current;
      if (list.length < 2) return;
      const widths = list.map((g) => {
        const el = groupRefs.current.get(g.id);
        if (!el) return 0;
        const rect = el.getBoundingClientRect();
        return vertical ? rect.height : rect.width;
      });
      const next = splitSizesFromWidths(widths);
      if (next.length === 0) return;
      applySizesToDom(next);
      onSplitSizesChangeRef.current?.(next);
    },
    [applySizesToDom],
  );
  const startDividerDrag = useCallback(
    (e: ReactPointerEvent, leftId: string, rightId: string) => {
      e.preventDefault();
      const left = groupRefs.current.get(leftId);
      const right = groupRefs.current.get(rightId);
      const container = left?.parentElement;
      if (!left || !right || !container) return;
      const total = container.clientWidth;
      const leftW = left.clientWidth;
      const startX = e.clientX;
      const move = (ev: PointerEvent): void => {
        const dx = ev.clientX - startX;
        const nl = Math.max(200, Math.min(leftW + dx, total - 200));
        left.style.flex = '0 0 ' + nl + 'px';
        right.style.flex = '1 1 0%';
      };
      // 解绑要看住三种收场（PS-6 第 7 项）：pointerup / pointercancel / 指针丢失。
      // 只认 pointerup 的那版实现里，手在窗口外松开或系统取消手势 ⇒ 监听器一直挂着，
      // 下一次拖拽就再叠一条，旧闭包还握着上一轮的 DOM 节点。
      const up = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        commitDividerDrag(false);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [commitDividerDrag],
  );

  /**
   * 分隔条**竖向**拖拽（MM-9 column 排列）：调高上下两组，其余与横向同款
   * （三事件收尾、松手落定回报比例）；最小的高是 120px。
   */
  const startDividerDragVertical = useCallback(
    (e: ReactPointerEvent, topId: string, bottomId: string) => {
      e.preventDefault();
      const top = groupRefs.current.get(topId);
      const bottom = groupRefs.current.get(bottomId);
      const container = top?.parentElement;
      if (!top || !bottom || !container) return;
      const total = container.clientHeight;
      const topH = top.clientHeight;
      const startY = e.clientY;
      const move = (ev: PointerEvent): void => {
        const dy = ev.clientY - startY;
        const nh = Math.max(120, Math.min(topH + dy, total - 120));
        top.style.flex = '0 0 ' + nh + 'px';
        bottom.style.flex = '1 1 0%';
      };
      const up = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        commitDividerDrag(true);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [commitDividerDrag],
  );

  /**
   * 每组可见的「其他组」清单（1027 跨组批：标签右键「移动到组」子菜单）。
   *
   * label 按**数组序**编号（第 N 组 = 排列序第 N 组：row 从左到右、column 从上到下），
   * 编号规则只此一处；菜单侧只照单显示。memo 的依赖是「组 id 序列」拼成的串：
   * 组的 id 与顺序不变时数组引用恒定 ⇒ TabBar 的 memo 不被每帧新数组打穿。
   */
  const groupIdKey = groups.map((g) => g.id).join('|');
  const otherGroupsByGroup = useMemo(() => {
    const refs: TabMenuGroupRef[] = (groupIdKey === '' ? [] : groupIdKey.split('|')).map((id, i) => ({
      id,
      label: `第 ${i + 1} 组`,
    }));
    const map = new Map<string, readonly TabMenuGroupRef[]>();
    for (const ref of refs) map.set(ref.id, refs.filter((x) => x.id !== ref.id));
    return map;
  }, [groupIdKey]);

  /**
   * 跨组拖拽落在某一组正文上的高亮（1027）。
   * 空组没有 TabBar，正文是它**唯一**能接住拖拽的地方（只靠拆分才能往空组放东西的旧限制，
   * 这一条就是那个缺口的补丁）。
   */
  const [bodyDropGroupId, setBodyDropGroupId] = useState<string | null>(null);
  /**
   * 组正文的拖放处理（每条都只认标签拖拽的 MIME，编辑器内部的文本拖拽原样放行）。
   *
   * 同组拖到正文 = 追加到本组末尾（与拖到标签栏空白同义）；跨组 = 交给宿主搬迁。
   * 源组未知（旧版裸路径载荷）⇒ 不猜，交给既有行为。
   */
  const groupBodyDragHandlers = useCallback(
    (
      g: EditorGroupState,
    ): {
      onDragOver: (e: ReactDragEvent<HTMLDivElement>) => void;
      onDragLeave: (e: ReactDragEvent<HTMLDivElement>) => void;
      onDrop: (e: ReactDragEvent<HTMLDivElement>) => void;
    } => ({
      onDragOver: (e) => {
        if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setBodyDropGroupId((cur) => (cur === g.id ? cur : g.id));
      },
      onDragLeave: (e) => {
        const next = e.relatedTarget;
        if (next instanceof Node && e.currentTarget.contains(next)) return;
        setBodyDropGroupId((cur) => (cur === g.id ? null : cur));
      },
      onDrop: (e) => {
        if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
        setBodyDropGroupId(null);
        const drag = decodeTabDragPayload(e.dataTransfer.getData(TAB_DRAG_MIME));
        if (drag === null || drag.groupId === null) return;
        e.preventDefault();
        if (drag.groupId !== g.id) {
          tabHostRef.current.onMoveTabBetweenGroups(drag.path, drag.groupId, g.id, g.tabs.length);
          return;
        }
        tabHostRef.current.onReorderTabInGroup(g.id, drag.path, g.tabs.length);
      },
    }),
    [],
  );

  /**
   * 一组编辑器的正文（SPLIT-1）。
   *
   * 刻意写成**函数**而不是内联组件：内联组件类型每次 render 都是新的 ⇒ React 整棵子树
   * 卸载重挂（与本文件 `fileTreeComponent` 那条教训同源）。
   * EditorPane 的三条回调走 `callbacksFor` 拿恒定身份（渲染环腰带，见其注释）。
   */
  const renderGroupBody = useCallback(
    (g: EditorGroupState, focused: boolean): ReactElement => {
      if (g.active) {
        const cb = callbacksFor(g.id);
        return (
          <EditorPaneMemo
            kernel={kernel}
            groupId={g.id}
            filePath={g.active}
            openPaths={g.tabs}
            revealLine={focused ? reveal?.line : undefined}
            revealColumn={focused ? reveal?.column : undefined}
            revealSpan={focused ? reveal?.span : undefined}
            revealNonce={focused ? reveal?.nonce : undefined}
            revealFocus={focused ? reveal?.focus : undefined}
            onDirtyChange={stableDirtyChange}
            registerActions={registerActions ? cb.register : undefined}
            onReauth={stableReauth}
            onStatusInfo={cb.onStatusInfo}
            onFocused={focused ? undefined : cb.onFocused}
          />
        );
      }
      return (
        <div className="empty-state">
          <p>没有打开的文件</p>
          <div className="empty-actions">
            <button className="primary small" onClick={() => workbench?.openQuickOpen()}>
              打开文件… <span className="hint">Ctrl+P</span>
            </button>
            {workbench?.hasCommand(WellKnownCommands.NewKojoFile) ? (
              <button
                className="ghost small"
                onClick={() => workbench.runCommand(WellKnownCommands.NewKojoFile)}
              >
                新建口上文件 <span className="hint">Ctrl+N</span>
              </button>
            ) : null}
            <button className="ghost small" onClick={() => workbench?.openPalette()}>
              命令面板 <span className="hint">Ctrl+Shift+P</span>
            </button>
          </div>
          <p className="dim">
            项目已索引 {fileCount} 个 ERB 文件、{fnCount} 个函数定义（口上域全量）
          </p>
        </div>
      );
    },
    [kernel, reveal, stableDirtyChange, registerActions, stableReauth, callbacksFor, workbench, fileCount, fnCount],
  );

  return (
    <ShellLayout
      kernel={kernel}
      builtinViews={builtinViews}
      writable={writable}
      activeFile={activeFile}
      onReauth={onReauth}
      dirty={activeFile !== null && dirtyPaths.has(activeFile)}
      dirtyCount={dirtyPaths.size}
      onSwitchEol={switchEolInActiveGroup}
      stats={{ fileCount, fnCount, indexing, indexError }}
      commandCtx={{ project, ...(activeFile ? { activeFile } : {}) }}
      onCloseProject={onClose}
      onReloadProject={onReload}
      recentProjects={recentProjects}
      onOpenProject={onOpenProject}
      onOpenProjectFolder={onOpenProjectFolder}
      quickOpenFiles={quickOpenFiles}
      quickOpenRecent={recentFiles}
      activeFileSymbols={activeFileSymbolsFromEditor}
      onOpenFile={onOpenFile}
      extraCommands={extraCommands}
      onRegisterWorkbench={setWorkbench}
      panelHostVersions={panelHostVersions}
      activeAdapterId={project.adapterId}
    >
      {/* 只读**不再**占一整条横幅（视觉批十三）：游戏目录默认只读是常态，常态不该按事故呈现。
          权限入口收进状态栏那枚「只读」徽标（可点，`onReauth`），真正保存被拒时由回执通知
          带「去授权」按钮说明原因（EditorPane 的 WriteNotAllowedError 分支）。 */}
      {/* 编辑器组（SPLIT-1 / MM-9）：每组 = 标签条 + 编辑器/空态；组间分隔条可拖
          （row 调宽、column 调高——由组态 orientation 决定） */}
      <div className="editor-groups" data-orientation={orientation}>
        {groups.map((g, i) => {
          const focused = g.id === activeGroupId;
          // PS-16：五条回调走 callbacksFor 恒定身份（TabBar memo 的父侧前提）
          const tabCb = callbacksFor(g.id);
          // MM-9：column 下分隔条是横向的（aria-orientation 与拖拽轴一起翻）
          const vertical = orientation === 'column';
          return (
            <Fragment key={g.id}>
              {i > 0 ? (
                <div
                  className={vertical ? 'editor-divider is-vertical' : 'editor-divider'}
                  role="separator"
                  aria-orientation={vertical ? 'horizontal' : 'vertical'}
                  onPointerDown={(e) => {
                    const prev = groups[i - 1];
                    if (!prev) return;
                    if (vertical) startDividerDragVertical(e, prev.id, g.id);
                    else startDividerDrag(e, prev.id, g.id);
                  }}
                />
              ) : null}
              <div
                ref={(el) => {
                  groupRefs.current.set(g.id, el);
                }}
                className={focused ? 'editor-group focused' : 'editor-group'}
                // 分屏比例（WS-06）：挂载 / 组态恢复时按份额挂 flex；缺省均分与旧行为一致。
                // 拖动过程由上面的拖拽处理器直接改同一格 inline style（不回写 state）。
                style={{ flex: splitFlexOf(shareOfGroup(i)) }}
              >
                {/* 1023 覆盖面批：组头是 `editor-group-header` 面的根（右键面靠
                    `data-group-id` 找回这一组的菜单桥）；标签栏空白区是它内部的
                    `tab-bar-blank` 面，标签行自己又是更内层的 `tabs` 面。 */}
                <div
                  className="editor-group-head"
                  data-context-surface="editor-group-header"
                  data-group-id={g.id}
                >
                  {g.tabs.length > 0 ? (
                    <TabBar
                      openTabs={g.tabs}
                      activeFile={g.active}
                      dirtyPaths={dirtyPaths}
                      pinnedPaths={pinnedPaths}
                      previewPath={g.preview ?? null}
                      groupId={g.id}
                      groupCount={groups.length}
                      rootDir={project.rootDir}
                      onCloseGroup={onCloseGroup}
                      onActivateTab={tabCb.onActivateTab}
                      onRequestCloseTab={tabCb.onRequestCloseTab}
                      onReorderTab={tabCb.onReorderTab}
                      onTogglePin={tabCb.onTogglePin}
                      onBatchCloseTab={tabCb.onBatchCloseTab}
                      otherGroups={otherGroupsByGroup.get(g.id) ?? []}
                      onMoveTabToGroup={tabCb.onMoveTabToGroup}
                      onSaveAllClick={handleSaveAllClick}
                      hasDirty={dirtyPaths.size > 0}
                    />
                  ) : null}
                  {groups.length > 1 ? (
                    <button
                      className="editor-group-close"
                      title="关闭此编辑器组"
                      onClick={() => onCloseGroup(g.id)}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  ) : null}
                </div>
                {/* 正文也是跨组拖拽的落点（1027）：空组没有 TabBar，这里是唯一能接住的地方；
                    只认标签拖拽的 MIME，编辑器内部的文本拖拽不受影响 */}
                <div
                  className={bodyDropGroupId === g.id ? 'editor-body tab-drop-target' : 'editor-body'}
                  {...groupBodyDragHandlers(g)}
                >
                  {renderGroupBody(g, focused)}
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>
    </ShellLayout>
  );
}
