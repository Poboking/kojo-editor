import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { Kernel } from '@kojo/kernel';
import type { ErbIndex, GameProject, UIPanelContribution } from '@kojo/plugin-api';
import { WellKnownCommands } from '@kojo/plugin-api';
import type { RevealTarget } from './App';
import { EditorPane, type EditorPaneActions } from './EditorPane';
import { ProblemPanel } from './ProblemPanel';
import { SearchPanel } from './SearchPanel';
import { affectsKojoTree, createEventCoalescer } from './external-change';
import { FileTree } from './FileTree';
import { revealInExplorer } from './reveal-explorer';
import { ShellLayout, type EditorStatusInfo, type WorkbenchApi } from './ShellLayout';
import { Icon } from './icons';
import type { ShellCommandSpec } from './commands';
import { collectSearchScopes, type SearchScopeCatalog } from './search-scope';
import { workspaceRootsOf } from './workspace-roots';
import { useNotify } from './NotificationCenter';
import { JUMP_TO_STATE_SOURCE, readJumpProbe, requestJumpToState } from './jump-to-state';
import { TabBar } from './tabs-bar';
import type { BatchCloseMode } from './tabs-ops';

interface Props {
  kernel: Kernel;
  project: GameProject;
  index: ErbIndex | null;
  indexing: boolean;
  /** 索引构建失败原因（P0 实机反馈：两个树同时空必须能自解释，不能静默） */
  indexError: string | null;
  activeFile: string | null;
  /** 打开的标签页（P3 多标签；顺序即标签栏顺序） */
  openTabs: readonly string[];
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
  /** 编辑器动作句柄注册（宿主"保存并关闭 / 全部保存"流程用） */
  registerActions?: (actions: EditorPaneActions | null) => void;
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
  /** 壳层通知（G1：命令按下去必须有回应——兑现不了就说一句人话，不灰掉不说话） */
  const notify = useNotify();
  /** 壳层工作台 API（空态动作按钮：快速打开 / 命令面板 / 新建口上文件） */
  const [workbench, setWorkbench] = useState<WorkbenchApi | null>(null);
  /** Ctrl+W 命令读最新活动标签（壳层命令注册一次，闭包外取值） */
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;

  // 统计（v0.1 验收指标：角色数 / 文件数 / 函数数）
  let fileCount = 0;
  let fnCount = 0;
  if (index) {
    for (const f of index.files.values()) {
      fileCount++;
      fnCount += f.functions.length;
    }
  }

  // 快速打开候选（P2）：索引全量文件路径（壳层只消费泛型路径列表）
  const quickOpenFiles = useMemo<string[]>(() => (index ? [...index.files.keys()].sort() : []), [index]);

  // 编辑器区壳层命令（P3：关闭标签 / 全部保存——容器语义，零业务知识）
  const extraCommands = useMemo<readonly ShellCommandSpec[]>(
    () => [
      {
        id: 'workbench.closeActiveTab',
        title: '关闭当前标签',
        keybinding: 'ctrl+w',
        run: () => {
          const p = activeFileRef.current;
          if (p) onRequestCloseTab(p);
        },
      },
      {
        id: 'workbench.saveAll',
        title: '全部保存',
        keybinding: 'ctrl+shift+s',
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
        keybinding: 'ctrl+shift+y',
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
        keybinding: 'ctrl+alt+t',
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
        keybinding: 'ctrl+alt+s',
        run: () => {
          requestJumpToState({
            probe: readJumpProbe,
            emit: (intent) => kernel.bus.emit('kojo.replayFunction', { ...intent, source: JUMP_TO_STATE_SOURCE }),
            say: (message) => notify({ kind: 'info', message }),
          });
        },
      },
    ],
    [onRequestCloseTab, onSaveAll, kernel, notify],
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

  // B6：树刷新直通车（宿主拖入复制落地后失效目标目录；句柄只注册一次）
  useEffect(() => {
    registerTreeRefresh?.(() => setTreeNonce((n) => n + 1));
  }, [registerTreeRefresh]);

  useEffect(() => {
    // 合批窗口：一次外部写入常炸出多条事件（原子写临时文件 + rename、连写几份档）。
    // 内核去抖已经按文件合过一轮（§5.84），这里合的是"整棵树的目录重列"这一层。
    const coalescer = createEventCoalescer(() => setTreeNonce((n) => n + 1), TREE_REFRESH_WINDOW_MS);
    const un = kernel.bus.on('file.changed', (ev) => {
      // 首动作零 IO：监视根是整个项目目录，游戏写存档、写图片缓存同样投递事件，
      // 而树只列举口上域——分野判错就是每次外部写入都白重列一遍（§5.87 立的纪律）。
      if (affectsKojoTree(ev.path, project.kojoPaths)) coalescer.push();
    });
    return () => {
      un();
      coalescer.dispose();
    };
  }, [kernel, project]);

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
  const problemArgsRef = useRef({ kernel });
  problemArgsRef.current = { kernel };
  const problemComponent = useMemo(() => {
    const StableProblems = (): ReactElement => {
      const a = problemArgsRef.current;
      return (
        <ProblemPanel
          onReveal={(path, line) =>
            a.kernel.bus.emit('editor.revealLocation', { filePath: path, line, source: '问题' })
          }
        />
      );
    };
    return StableProblems;
  }, []);

  /**
   * 检索范围候选（C3 领域限定检索批）：**判据不在本层**。宿主只做接线——问槽上
   * 有哪些提供方、把当前项目递回去、拿回"标签 + 目录"这两样自己不需要理解的泛型事实。
   * 没有任何提供方（没开项目 / 游戏不给这概念）⇒ 候选空 ⇒ 面板整行不画 = 今天的行为。
   *
   * 依赖刻意只到 `project`（不跟 `roots`）：候选是项目的属性，收窄在发请求那一刻才做。
   */
  const searchScopes = useMemo(
    () => collectSearchScopes(kernel.slots.query('search.scope'), project),
    [kernel, project],
  );

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
          onReveal={(path, line, column) =>
            a.kernel.bus.emit('editor.revealLocation', {
              filePath: path,
              line,
              column,
              source: '搜索',
            })
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
      {/* 标签栏（C1 右键菜单 / C2 固定标签 / C3 全部保存入口；渲染细节在 TabBar） */}
      {openTabs.length > 0 ? (
        <TabBar
          openTabs={openTabs}
          activeFile={activeFile}
          dirtyPaths={dirtyPaths}
          pinnedPaths={pinnedPaths}
          onActivateTab={onActivateTab}
          onRequestCloseTab={onRequestCloseTab}
          onReorderTab={onReorderTab}
          onTogglePin={onTogglePin}
          onBatchCloseTab={onBatchCloseTab}
          onSaveAllClick={handleSaveAllClick}
          hasDirty={dirtyPaths.size > 0}
        />
      ) : null}
      {/* 只读横幅（P0 实机反馈修复）：重授权入口常驻可见可点 */}
      {!writable ? (
        <div className="ro-banner">
          <span>当前为只读：写权限未批准，保存不可用。修改仍可浏览与复制。</span>
          <button className="small" onClick={onReauth}>
            去授权
          </button>
        </div>
      ) : null}
      <div className="editor-body">
        {activeFile ? (
          <EditorPane
            kernel={kernel}
            filePath={activeFile}
            openPaths={openTabs}
            revealLine={reveal?.line}
            revealColumn={reveal?.column}
            revealNonce={reveal?.nonce}
            onDirtyChange={onDirtyChange}
            registerActions={registerActions}
            onReauth={onReauth}
            onStatusInfo={setEditorStatus}
          />
        ) : (
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
        )}
      </div>
    </ShellLayout>
  );
}
