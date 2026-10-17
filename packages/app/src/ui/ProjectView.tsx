import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import type { Kernel } from '@kojo/kernel';
import type { ErbIndex, GameProject, UIPanelContribution } from '@kojo/plugin-api';
import { NAV_SCOPE_EVENT, WellKnownCommands } from '@kojo/plugin-api';
import type { RevealTarget } from './App';
import { EditorPane, type EditorPaneActions } from './EditorPane';
import { ProblemPanel } from './ProblemPanel';
import { SearchPanel } from './SearchPanel';
import { affectsKojoTree, createEventCoalescer } from './external-change';
import { FileTree, walkDialectPaths } from './FileTree';
import { revealInExplorer } from './reveal-explorer';
import { ShellLayout, type EditorStatusInfo, type WorkbenchApi } from './ShellLayout';
import { Icon } from './icons';
import type { ShellCommandSpec } from './commands';
import {
  collectSearchScopes,
  filterPathsByActiveScope,
  resolveScope,
  setActiveScope,
  type SearchScopeCatalog,
} from './search-scope';
import { listSourceFiles, mergeCandidatePaths } from './commands';
import { createFileReplaceRunner } from './search-replace-exec';
import { createProjectNameLedger } from './name-ledger';
import { revealLocationOf } from '../monaco/reveal-position';
import { setReplaceRunner, snapshot as readSearchState, subscribe as subscribeSearchState } from './search-store';
import { effectiveKeybindingOf, useKeybindingsVersion } from './keybindings';
import { workspaceRootsOf } from './workspace-roots';
import { useNotify } from './NotificationCenter';
import { JUMP_TO_STATE_SOURCE, readJumpProbe, requestJumpToState } from './jump-to-state';
import { TabBar } from './tabs-bar';
import type { BatchCloseMode } from './tabs-ops';
import type { EditorGroupState } from './editor-groups';

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
  /** 向右拆分（从焦点组，VSCode 同款携带激活标签） */
  onSplitEditor: () => void;
  /** 关闭指定组（组内标签全部随组消失；单组不可关） */
  onCloseGroup: (groupId: string) => void;
  /** 各标签脏态（标签栏脏点，见 `.tab-dirty`） */
  dirtyPaths: ReadonlySet<string>;
  /** 固定标签集合（C2；会话态——与 openTabs 同生命周期，真源在宿主 App） */
  pinnedPaths: ReadonlySet<string>;
  reveal: RevealTarget | null;
  onOpenFile: (path: string) => void;
  /** 激活标签（点击标签 = 打开/切换；不丢内容） */
  onActivateTab: (path: string) => void;
  /** 请求关闭标签（脏标签由宿主弹确认） */
  onRequestCloseTab: (path: string) => void;
  /** 拖拽重排标签：把 path 移动到 toIndex（删除后插入语义；跨固定区分界自动改固定态） */
  onReorderTab: (path: string, toIndex: number) => void;
  /** 固定 / 取消固定标签（C2；顺序重排真源在宿主） */
  onTogglePin: (path: string) => void;
  /** 批量关闭（C1）：关闭其他 / 右侧 / 全部——计划与逐个确认链都在宿主，这里只发意图 */
  onBatchCloseTab: (mode: BatchCloseMode, anchor: string) => void;
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
}

/**
 * 文件树重列的合批窗口（HK-5）。比内核去抖（200ms，§5.84）略宽：
 * 树重列一次要打好几个 `listDir`，比"重载一个 model"贵；
 * 而对作者来说"外部丢的文件在不到一秒后自己出现"已经足够即时，再小没有体感收益。
 */
const TREE_REFRESH_WINDOW_MS = 400;

/** 检索范围候选的空值（ref 初值；没提供方时面板与改动前逐字一致） */
const NO_SEARCH_SCOPES: SearchScopeCatalog = { items: [], notices: [] };

/**
 * 两份状态读数是否等价（纯数据逐字段比；缺省与 null/'' 视为同值）。
 * `sel`/`autosavedAt` 是可选字段，上报方有时带有时不带 ⇒ 按"缺省即空"归一后再比，
 * 否则 `{...} vs {..., sel: undefined}` 这种同一读数会被判成两次变化。
 */
function isSameEditorStatus(a: EditorStatusInfo | null, b: EditorStatusInfo | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.encoding === b.encoding &&
    a.eol === b.eol &&
    a.lines === b.lines &&
    (a.autosavedAt ?? null) === (b.autosavedAt ?? null) &&
    (a.sel ?? '') === (b.sel ?? '')
  );
}

/**
 * 一组编辑器的**恒定身份回调集**（见 ProjectView 内的 `callbacksFor`）。
 * `register` 只在宿主传了 `registerActions` 时才接线（缺省仍是 undefined，零改动语义）。
 */
interface GroupCallbacks {
  readonly onStatusInfo: (info: EditorStatusInfo | null) => void;
  readonly onFocused: () => void;
  readonly register: (actions: EditorPaneActions | null) => void;
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
  onActivateGroup,
  onActivateTabInGroup,
  onRequestCloseTabInGroup,
  onReorderTabInGroup,
  onTogglePinInGroup,
  onBatchCloseTabInGroup,
  onSplitEditor,
  onCloseGroup,
  dirtyPaths,
  pinnedPaths,
  reveal,
  onOpenFile,
  onActivateTab,
  onRequestCloseTab,
  onReorderTab,
  onTogglePin,
  onBatchCloseTab,
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
}: Props): ReactElement {
  const [editorStatus, setEditorStatus] = useState<EditorStatusInfo | null>(null);
  /**
   * 每组各自的状态上抛（SPLIT-1）：状态栏显示**焦点组**的编码/EOL/行数——
   * 各组把状态写进 ref 表，焦点切换时取焦点组那份。
   */
  const statusByGroupRef = useRef(new Map<string, EditorStatusInfo | null>());
  const activeGroupIdRef = useRef(activeGroupId);
  activeGroupIdRef.current = activeGroupId;
  useEffect(() => {
    setEditorStatus(statusByGroupRef.current.get(activeGroupId) ?? null);
  }, [activeGroupId]);
  /**
   * 状态上报的**腰带**（用户反馈修复 · 渲染环父侧那一半）：
   * `EditorStatusInfo` 是纯数据（字符串 + 数字），逐字段相等就是"状态没变"——
   * 不再写 ref、不再 setState，壳层不因此重渲染。
   * 判据不全（新字段漏比）会退化成"每次都算变了"，只是腰带变松，不影响正确性。
   */
  const handleStatusInfo = useCallback((gid: string, info: EditorStatusInfo | null) => {
    const prev = statusByGroupRef.current.get(gid) ?? null;
    if (isSameEditorStatus(prev, info)) return;
    statusByGroupRef.current.set(gid, info);
    if (gid === activeGroupIdRef.current) setEditorStatus(info);
  }, []);
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
  const onActivateGroupRef = useRef(onActivateGroup);
  onActivateGroupRef.current = onActivateGroup;
  const groupCbRef = useRef(new Map<string, GroupCallbacks>());
  const callbacksFor = useCallback((gid: string): GroupCallbacks => {
    let cb = groupCbRef.current.get(gid);
    if (!cb) {
      cb = {
        onStatusInfo: (info) => handleStatusInfo(gid, info),
        onFocused: () => onActivateGroupRef.current(gid),
        register: (actions) => registerActionsRef.current?.(gid, actions),
      };
      groupCbRef.current.set(gid, cb);
    }
    return cb;
  }, [handleStatusInfo]);
  // 组关闭后回收其回调（Map 与组数同界；组 id 由宿主分配）
  useEffect(() => {
    const alive = new Set(groups.map((g) => g.id));
    for (const id of [...groupCbRef.current.keys()]) if (!alive.has(id)) groupCbRef.current.delete(id);
  }, [groups]);
  /** 壳层通知（G1：命令按下去必须有回应——兑现不了就说一句人话，不灰掉不说话） */
  const notify = useNotify();
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
  let fileCount = 0;
  let fnCount = 0;
  if (index) {
    for (const f of index.files.values()) {
      fileCount++;
      fnCount += f.functions.length;
    }
  }

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
   * 快速打开的候选（P2 → W7 NAV-SCOPE）。
   *
   * 两件事变了形态：**① 不再只有 ERB 索引**——口上域的递归列举把 `.kojo` 这些方言文件
   * 也带进来（写了半天的糖源文件按 Ctrl+P 搜不到，是"索引即全部"这个假设的账单）；
   * **② 跟着"只看"走**——选定范围后候选清单就只剩那一处（与另三条通道同一个戳、同一条
   * `pathInScope`；判据不在宿主里重写）。列举失败 ⇒ 退回索引那份，不炸面板。
   */
  const [dialectFiles, setDialectFiles] = useState<readonly string[]>([]);
  useEffect(() => {
    let alive = true;
    const walk = kernel.io.walkDir.bind(kernel.io);
    void walkDialectPaths(walk, project.kojoPaths)
      .then((files) => {
        if (alive) setDialectFiles(files);
      })
      .catch(() => {
        // 读不到附加清单不是故障上屏的理由：索引那份照样能开文件，只是少了非 ERB 的那些
        if (alive) setDialectFiles([]);
      });
    return () => {
      alive = false;
    };
  }, [kernel, project]);

  const quickOpenFiles = useMemo<string[]>(
    () =>
      filterPathsByActiveScope(
        mergeCandidatePaths([index ? [...index.files.keys()] : [], dialectFiles]),
        (p) => p,
      ),
    // navScope 是真实依赖（状态源的读数）：范围换了要重算候选——memo 体只读模块状态，
    // 不写进依赖就等于把"只看"又变成一个不会失效的旧读数
    [index, dialectFiles, navScope],
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
    ],
    // kbVersion 是真实依赖：改键覆盖 → 版本号自增 → 命令表带新键位重建
    [onRequestCloseTab, onSaveAll, onSplitEditor, onCloseGroup, kernel, notify, kbVersion],
  );

  // 内建文件树的**稳定组件身份**（用户反馈修复：打开文件会重建内联箭头组件 →
  // React 视作新组件类型 → 整树卸载重挂 → 展开状态被清空。改为身份恒定的包装
  // 组件 + ref 桥接最新 props：重渲染只更新属性，绝不重挂，展开状态常驻）。
  const listDir = useMemo(() => kernel.io.listDir.bind(kernel.io), [kernel]);
  // 冷开快照的递归列举桥（树即时化批）：索引要数秒才就绪，FileTree 用它在左栏先出文件
  // （一次 walkDir 拿全口上域清单；索引就绪后按索引路径切换，同构不重排）。
  const walkDir = useMemo(() => kernel.io.walkDir.bind(kernel.io), [kernel]);
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
   * 名称显示对照（中日对照：日文名 → 中文名）。
   *
   * 词典是**游戏/语言知识**，只住 game.adapter 插件；本壳层只经槽位读字段、绝不
   * import 任何适配器实现。取当前项目匹配的适配器贡献（`adapter.gameId === project.adapterId`）
   * 的 `nameGlossary`；无词典 → `undefined`（FileTree 原样显示，即旧行为）。
   * 命中规则与 eratw 侧同口径：按键长降序、`includes` 命中、名字已含对应中文则不重复。
   */
  const nameGloss = useMemo<((name: string) => string) | undefined>(() => {
    const contribution = kernel.slots
      .query('game.adapter')
      .find((c) => c.adapter.gameId === project.adapterId);
    const dict = contribution?.adapter.nameGlossary;
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

  /** 递增即失效信号（FileTree 只认"变化"；用布尔会把连续两次外部改动合并掉） */
  const [treeNonce, setTreeNonce] = useState(0);

  /**
   * 外部改动 → 树重列的**判据根集**（S2-6）= 口上域 ∪ 会话级附加根。
   * 与监视根同源：监视已经覆盖附加根（D1），过滤却不认它 = 事件到了却被丢掉。
   * 只去字面重复（附加根常落在口上域之内）；路径口径的比较交给 `affectsKojoTree` 自己。
   */
  const treeWatchRoots = useMemo(
    () => [...new Set([...project.kojoPaths, ...(extraRoots ?? [])])],
    [project.kojoPaths, extraRoots],
  );

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

  const fileTreeArgsRef = useRef({ project, index, activeFile, onOpenFile, listDir, walkDir, importPackage, treeNonce, gloss: nameGloss, io: kernel.io, guardFileOp, onFilesGone, onRevealInExplorer: revealInExplorer, extraRoots: [] as readonly string[], onAddExtraRoot: undefined as (() => void) | undefined });
  fileTreeArgsRef.current = { project, index, activeFile, onOpenFile, listDir, walkDir, importPackage, treeNonce, gloss: nameGloss, io: kernel.io, guardFileOp, onFilesGone, onRevealInExplorer: revealInExplorer, extraRoots: extraRoots ?? [], onAddExtraRoot };
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
          onFilesGone={a.onFilesGone}
          onRevealInExplorer={a.onRevealInExplorer}
          refreshNonce={a.treeNonce}
          gloss={a.gloss}
          extraRoots={a.extraRoots}
          onAddFolder={a.onAddExtraRoot}
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

  /**
   * 替换执行器装配（R7 搜索替换批）：内核 io 通道（读改写保编码 + 原子写 + 备份，
   * 写允许域由内核强制）+ Monaco live model 通道，随 kernel 生命周期装卸。
   * 未装配时搜索面板的替换入口会被状态机锁住并明示（不静默）。
   * `nameLedger` = F2 改名用的**同一份**出现点台账判据（`.erb` 索引 + `.kojo` 糖源都走
   * 这两条腿）：不接则「全部替换」只看得到已开标签里的糖源，检索范围外的同名记号
   * 没人说出来（W8 XLANG-RENAME 的跨通道回执）。
   */
  useEffect(() => {
    setReplaceRunner(
      createFileReplaceRunner({ io: kernel.io, nameLedger: createProjectNameLedger(kernel) }),
    );
    return () => setReplaceRunner(null);
  }, [kernel]);

  /**
   * 侧栏「搜索」视图的稳定组件身份（同 problemComponent 的 ref 闭包写法）。
   *
   * 检索根 = **项目根 ∪ 会话级附加根（D1）∪ 作者工作区全部根**：工作区自 2026-10-14 起
   * 不再是一个目录（默认根 + 对话框自选根），只搜项目根会把作者自己写的口上文件整批漏掉；
   * 附加根同理——加进来就是为了"这部分也要能搜到"，漏掉等于没加。
   * 跳转仍走既有 `editor.revealLocation`（与问题面板同一条通道）。
   */
  const searchArgsRef = useRef({ kernel, roots: [] as string[], scopes: NO_SEARCH_SCOPES });
  searchArgsRef.current = {
    kernel,
    roots: [...new Set([project.rootDir, ...(extraRoots ?? []), ...workspaceRootsOf(kernel)])],
    scopes: searchScopes,
  };
  const searchComponent = useMemo(() => {
    const StableSearch = (): ReactElement => {
      const a = searchArgsRef.current;
      return (
        <SearchPanel
          roots={a.roots}
          scopes={a.scopes.items}
          scopeNotices={a.scopes.notices}
          onReveal={(path, line, span) =>
            // W9 判据①：与问题面板同一个载荷出口（区间折列住在 `revealLocationOf`，
            // 这里不再自己写一遍"`column` = 区间起点"）
            a.kernel.bus.emit('editor.revealLocation', revealLocationOf({ path, line, span }, '搜索'))
          }
        />
      );
    };
    return StableSearch;
  }, []);

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
        // defaultActive:false —— 不抢「约定校验」（bottom，order 50）现有的默认激活落点（Ctrl+J）
        id: 'kojo.problems',
        title: '问题',
        icon: 'check',
        order: 40,
        location: 'bottom',
        defaultActive: false,
        component: problemComponent,
      },
    ],
    [fileTreeComponent, problemComponent, searchComponent],
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
   * 分隔条拖拽（SPLIT-1）：调宽左右两组。直接改相邻两组的 DOM flex（v1——
   * 比例不落盘、新开的组回到均分；布局真源仍是 CSS，这里只做会话内微调）。
   * 最小组宽 200px，防拖没了。
   */
  const groupRefs = useRef(new Map<string, HTMLDivElement | null>());
  const startDividerDrag = useCallback((e: ReactPointerEvent, leftId: string, rightId: string) => {
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
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

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
          <EditorPane
            kernel={kernel}
            groupId={g.id}
            filePath={g.active}
            openPaths={g.tabs}
            revealLine={focused ? reveal?.line : undefined}
            revealColumn={focused ? reveal?.column : undefined}
            revealNonce={focused ? reveal?.nonce : undefined}
            onDirtyChange={onDirtyChange}
            registerActions={registerActions ? cb.register : undefined}
            onReauth={onReauth}
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
    [kernel, reveal, onDirtyChange, registerActions, onReauth, callbacksFor, workbench, fileCount, fnCount],
  );

  return (
    <ShellLayout
      kernel={kernel}
      builtinViews={builtinViews}
      writable={writable}
      activeFile={activeFile}
      onReauth={onReauth}
      editorStatus={editorStatus}
      dirty={activeFile !== null && dirtyPaths.has(activeFile)}
      stats={{ fileCount, fnCount, indexing, indexError }}
      commandCtx={{ project, ...(activeFile ? { activeFile } : {}) }}
      onCloseProject={onClose}
      onReloadProject={onReload}
      quickOpenFiles={quickOpenFiles}
      onOpenFile={onOpenFile}
      extraCommands={extraCommands}
      onRegisterWorkbench={setWorkbench}
    >
      {/* 只读横幅（P0 实机反馈修复）：项目级一条，重授权入口常驻可见可点 */}
      {!writable ? (
        <div className="ro-banner">
          <span>当前为只读：写权限未批准，保存不可用。修改仍可浏览与复制。</span>
          <button className="small" onClick={onReauth}>
            去授权
          </button>
        </div>
      ) : null}
      {/* 编辑器组（SPLIT-1）：每组 = 标签条 + 编辑器/空态；组间分隔条可拖调宽 */}
      <div className="editor-groups">
        {groups.map((g, i) => {
          const focused = g.id === activeGroupId;
          return (
            <Fragment key={g.id}>
              {i > 0 ? (
                <div
                  className="editor-divider"
                  role="separator"
                  aria-orientation="vertical"
                  onPointerDown={(e) => {
                    const left = groups[i - 1];
                    if (left) startDividerDrag(e, left.id, g.id);
                  }}
                />
              ) : null}
              <div
                ref={(el) => {
                  groupRefs.current.set(g.id, el);
                }}
                className={focused ? 'editor-group focused' : 'editor-group'}
              >
                <div className="editor-group-head">
                  {g.tabs.length > 0 ? (
                    <TabBar
                      openTabs={g.tabs}
                      activeFile={g.active}
                      dirtyPaths={dirtyPaths}
                      pinnedPaths={pinnedPaths}
                      onActivateTab={(p) => onActivateTabInGroup(g.id, p)}
                      onRequestCloseTab={(p) => onRequestCloseTabInGroup(g.id, p)}
                      onReorderTab={(p, to) => onReorderTabInGroup(g.id, p, to)}
                      onTogglePin={(p) => onTogglePinInGroup(g.id, p)}
                      onBatchCloseTab={(mode, anchor) => onBatchCloseTabInGroup(g.id, mode, anchor)}
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
                <div className="editor-body">{renderGroupBody(g, focused)}</div>
              </div>
            </Fragment>
          );
        })}
      </div>
    </ShellLayout>
  );
}
