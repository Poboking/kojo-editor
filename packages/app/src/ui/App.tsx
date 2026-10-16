import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type { Kernel } from '@kojo/kernel';
import type { ErbIndex, ErbParserService, FileStat, GameProject, RecentProject } from '@kojo/plugin-api';
import { removeRecentOptimistic } from './WelcomeView';
import { invoke, isTauri } from '../bridge/invoke';
import { bootstrapKernel } from '../bootstrap';
import { perf } from '../perf';
import { revealTargetOf, type RevealTarget } from '../monaco/reveal-position';
import {
  NOT_READY_MESSAGE,
  dropHintText,
  nextDropOverlay,
  routeDroppedPaths,
  subscribeDragDrop,
  type DropOverlayState,
} from './drag-drop';
import { useNotify } from './NotificationCenter';
import { UnsavedConfirmDialog } from './UnsavedConfirmDialog';
import { WelcomeView } from './WelcomeView';
import { WritableApprovalDialog } from './WritableApprovalDialog';
import { workspaceRootsOf } from './workspace-roots';
import { resetSearch } from './search-store';
import { bindDiffView, DIFF_VIEW_OVERLAY_ID } from './diff-view';
import { createDiffViewOverlay } from './DiffViewOverlay';
import {
  FILE_HISTORY_OVERLAY_ID,
  setFileHistoryTarget,
  SHOW_FILE_HISTORY_COMMAND_ID,
} from './file-history';
import { createFileHistoryOverlay } from './FileHistoryOverlay';
import type { EditorPaneActions } from './EditorPane';

/**
 * L1-A 首屏分割（2026-10-16 首屏批）：项目视图的静态链会把 monaco 全图（~1338 模块 /
 * 入口块 ~4.5 MB）拖进欢迎页关键路径——这里改按需 chunk。加载器独立成函数：
 * `React.lazy` 与 idle 预取**共用同一个 import promise**（浏览器模块缓存去重，
 * 预取完再进项目零等待）。
 */
const loadProjectView = (): Promise<{ default: typeof import('./ProjectView')['ProjectView'] }> =>
  import('./ProjectView').then((m) => ({ default: m.ProjectView }));
const ProjectView = lazy(loadProjectView);

/** 项目视图 chunk 装载期间的骨架（与内联引导层同构；idle 预取命中时基本见不到） */
function ProjectViewSkeleton(): ReactElement {
  return (
    <div className="boot-skeleton" aria-hidden="true">
      <div className="boot-skeleton-card">
        <div className="boot-skeleton-brand">kojo-editor</div>
        <div className="boot-skeleton-tip">正在装载工作区…</div>
        <div className="boot-skeleton-bar" />
      </div>
    </div>
  );
}

export type AppPhase = 'boot' | 'welcome' | 'opening' | 'project';

/** 编辑器定位请求（来自校验面板 / 函数树等：内核事件 editor.revealLocation）；真源在 monaco 层 */
export type { RevealTarget } from '../monaco/reveal-position';

export function App(): ReactElement {
  const [kernel, setKernel] = useState<Kernel | null>(null);
  const [phase, setPhase] = useState<AppPhase>('boot');
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<GameProject | null>(null);
  const [index, setIndex] = useState<ErbIndex | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  /** 打开的标签页（P3 多标签；顺序即标签栏顺序） */
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  /** 各标签脏态集合（EditorPane 按路径逐个上报；标签栏脏点 + 关闭确认用） */
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(new Set());
  /** 待确认的脏标签关闭（非 null = 弹确认框） */
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const [reveal, setReveal] = useState<RevealTarget | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [pendingApproval, setPendingApproval] = useState<GameProject | null>(null);
  /** 写权限状态（P0）：null = 无项目；驱动状态栏徽章 + 保存置灰 */
  const [writable, setWritable] = useState<boolean | null>(null);
  /** 口上域索引构建失败原因（null = 成功/未构建）；驱动状态栏诊断与通知 */
  const [indexError, setIndexError] = useState<string | null>(null);
  /** OS 文件拖放的覆盖提示（状态机见 drag-drop.nextDropOverlay；over 刷屏必须幂等） */
  const [dropHint, setDropHint] = useState<DropOverlayState>('hidden');
  /** 通知中心（入口层 Provider 装配，App 自身也可发通知） */
  const notify = useNotify();
  /** 编辑器动作句柄（保存/保存指定/全部保存；EditorPane 注册） */
  const actionsRef = useRef<EditorPaneActions | null>(null);
  const registerActions = useCallback((a: EditorPaneActions | null) => {
    actionsRef.current = a;
  }, []);
  const onDirtyChange = useCallback((path: string, dirty: boolean) => {
    setDirtyPaths((prev) => {
      const has = prev.has(path);
      if (has === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    bootstrapKernel()
      .then(async (k) => {
        if (disposed) return;
        setKernel(k);
        setRecent(await k.project.recent());
        setPhase('welcome');
      })
      .catch((e: unknown) => {
        if (disposed) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase('welcome');
      });
    return () => {
      disposed = true;
    };
  }, []);

  // L1-A：React 首次提交后移除 index.html 的内联引导层。用布局副作用（先于本次绘制）：
  // 撤罩与真实界面的首帧同拍完成——既不闪"内容未绘先撤罩"的空窗，也不多挂一帧罩子。
  useLayoutEffect(() => {
    document.getElementById('boot-splash')?.remove();
  }, []);

  // L1-0 / L1-A 接线：内核就绪 ⇒ 欢迎页主按钮即渲染完成（本布局副作用随提交执行）。
  // 顺序是硬约束：**先记** `boot.welcomeInteractive`、**再排** idle 预取——tools 的断言②
  // 以该标记为界判「欢迎页可点前的网络请求不含 monaco」，而 rIC 最早也在下一帧才执行。
  const prefetched = useRef(false);
  useLayoutEffect(() => {
    if (!kernel || prefetched.current) return;
    prefetched.current = true;
    perf.bootMark('boot.welcomeInteractive', undefined, '自导航起点 ms；内核就绪 ⇒ 欢迎页主按钮可点（提交时刻）');
    const prefetch = (): void => {
      // 预取尽力而为：失败不打扰（真加载失败由 lazy 的 Suspense 路径呈现）
      void loadProjectView().catch(() => undefined);
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(prefetch, { timeout: 4000 });
    } else {
      setTimeout(prefetch, 1500);
    }
  }, [kernel]);

  // 索引所有权在 erb-parser：索引重建完成后由事件通知，宿主只同步展示
  useEffect(() => {
    if (!kernel) return;
    const parser = kernel.services.tryGet<ErbParserService>('erb.parser');
    if (!parser) return;
    const refresh = (): void => setIndex(parser.currentIndex());
    const un = kernel.bus.on('kojo.functionChanged', refresh);
    return () => {
      un();
    };
  }, [kernel]);

  // 通用 diff 视图（2026-10-15 比对/历史批）：宿主注册 ui.overlay 贡献并订阅
  // `ui.diffView.open` 意图（插件发意图、宿主落地；与 editor.revealLocation 同款）。
  // 本地时间线（同批）：命令进（活动文件在 ctx 里）→ 状态单源 → ui.overlay 开窗；
  // 「对比」发同一枚 diff 意图（F1 视图复用），「恢复」只经 kernel.io 既有写链路。
  useEffect(() => {
    if (!kernel) return;
    const unBind = bindDiffView(kernel);
    const unReg = kernel.slots.register('ui.overlay', {
      id: DIFF_VIEW_OVERLAY_ID,
      order: 40,
      size: 'wide',
      component: createDiffViewOverlay({
        io: kernel.io,
        close: () =>
          kernel.bus.emit('ui.overlay.close', { id: DIFF_VIEW_OVERLAY_ID, source: 'host:diff-view' }),
      }),
    });
    const unRegHistory = kernel.slots.register('ui.overlay', {
      id: FILE_HISTORY_OVERLAY_ID,
      order: 41,
      size: 'wide',
      component: createFileHistoryOverlay({
        io: kernel.io,
        requestDiff: (p) => kernel.bus.emit('ui.diffView.open', { ...p, source: 'host:file-history' }),
        close: () =>
          kernel.bus.emit('ui.overlay.close', { id: FILE_HISTORY_OVERLAY_ID, source: 'host:file-history' }),
      }),
    });
    const unRegHistoryCommand = kernel.slots.register('editor.command', {
      id: SHOW_FILE_HISTORY_COMMAND_ID,
      title: '显示当前文件的历史版本',
      when: (ctx) => Boolean(ctx.activeFile),
      run: (ctx) => {
        if (!ctx.activeFile) return;
        setFileHistoryTarget(ctx.activeFile);
        kernel.bus.emit('ui.overlay.open', {
          id: FILE_HISTORY_OVERLAY_ID,
          source: 'host:file-history',
        });
      },
    });
    return () => {
      unBind();
      unReg();
      unRegHistory();
      unRegHistoryCommand();
    };
  }, [kernel]);

  // BUG-5：监视器自述必须可见。`partial` / `unavailable` 意味着"某些目录的外部改动
  // 不会自动重载"——这正是过去静默失灵的形状（用户以为会自动重载，其实句柄早没了）。
  // `watching` 不提示：它是常态，不是需要用户处置的事。
  useEffect(() => {
    if (!kernel) return;
    const un = kernel.bus.on('file.watchState', (st) => {
      if (st.status === 'watching' || st.status === 'stopped') return;
      const detail = st.failures.map((f) => `${f.root} — ${f.reason}`).join('；');
      notify({
        kind: 'error',
        message:
          (st.status === 'partial'
            ? '文件监视只启用了一部分，下列目录的外部改动不会自动重载：'
            : '文件监视不可用，外部改动不会自动重载：') +
          `${detail || '(未给出原因)'}。可点各面板的「刷新」按钮手动重扫。`,
      });
    });
    return un;
  }, [kernel, notify]);

  // 通用导航意图：任意插件提出"打开文件并定位"，宿主在此落地。
  // P3 多标签后切换零丢失（model 留内存），无需未保存确认——确认只发生在关闭脏标签。
  // 列（R1）：发起方给得出列就一路带到编辑器（转到定义 / 源映射折回都带列），给不出就只定位行。
  useEffect(() => {
    if (!kernel) return;
    const un = kernel.bus.on('editor.revealLocation', (ev) => {
      requestOpenFile(ev.filePath, ev.line ?? 1, ev.column);
    });
    return () => {
      un();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernel]);

  // 当前文件广播（v0.3 批 S5-UI）：宿主是"当前打开哪个文件"的唯一权威，
  // 面板（如升糖建议器）需要它才知道该扫哪个文件。做成事件而非查询接口，
  // 免得面板为"知道变了"而持有宿主引用。
  useEffect(() => {
    if (!kernel) return;
    kernel.bus.emit('editor.activeFileChanged', { filePath: activeFile });
  }, [kernel, activeFile]);

  /** 旧项目的一套 UI 态整体带走：切项目与关项目共用，防旧标签/脏态/待确认残留到下一拍 */
  const resetProjectUiState = useCallback(() => {
    setActiveFile(null);
    setOpenTabs([]);
    setDirtyPaths(new Set());
    setPendingClose(null);
    setReveal(null);
  }, []);

  const openProject = useCallback(
    async (dir: string, opts?: { keepView?: boolean }) => {
      if (!kernel) return;
      // 重载项目（同目录重开）不切回欢迎页：避免「项目被关掉」的错觉
      if (!opts?.keepView) setPhase('opening');
      setError(null);
      // 静默只读修复（P0）：不一致事件只在 open() 期间同步发出——局部订阅，
      // 避免常驻监听与 openProject 状态写入之间的竞态
      let approvalMismatch = false;
      const unMismatch = kernel.bus.on('project.writableApprovalMismatch', () => {
        approvalMismatch = true;
      });
      try {
        const p = await kernel.project.open(dir);
        setProject(p);
        // 换项目（欢迎页首开 / 拖入新目录）：旧项目的整套 UI 态整体带走；
        // 同目录 reload 靠 keepView 保住标签，只清激活与定位（原行为）
        if (project?.rootDir !== dir) resetProjectUiState();
        else {
          setActiveFile(null);
          setReveal(null);
        }
        setIndex(null);
        setPhase('project');
        setRecent(await kernel.project.recent());

        // Rust 侧写允许域注册（M3 纵深防御第二道闸）：
        // 允许域 = 项目根目录 + appDataDir；失败 fail-closed（仅 appDataDir 可写）并显式报错
        if (isTauri()) {
          try {
            await invoke('register_write_domain', { root: dir });
          } catch (e: unknown) {
            setError(`写允许域注册失败（将只允许 appDataDir 写入）: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // BUG-5：起文件监视（Rust notify → 内核去抖 → `file.changed`）。
        // 根 = 项目根 ∪ 适配器其余根 ∪ **作者工作区全部根**：存档目录可能在项目根外
        // （本机就有独立的 sav 库），而工作区在 `%APPDATA%` 下、与项目根毫无包含关系。
        // 嵌套根由内核折叠。监视状态经 `file.watchState` 呈现，不在此处吞掉。
        //
        // 工作区**全部根**必须一起监视（HK-5 批补上，理由不是"整齐"而是**防数据丢失**）：
        // 作者工作区是可写的权威区，`.kojo` 就住在这里。若不监视，作者在记事本里改了
        // 一个正被编辑器打开的工作区文件，回到编辑器按 Ctrl+S 就会**静默覆盖**那份外部
        // 改动——正是 §5.36/§5.84 那条「谁改盘谁发事件、宿主据此重载」要根治的形状，
        // 而这条链路此前只覆盖游戏目录那半边。
        // 之所以是"全部根"而不是默认根：作品可以落在作者自选的项目位置（目录对话框授权）
        // 里，那些目录与 `%APPDATA%` 下的默认根毫无包含关系，漏掉就等于没监视。
        // 服务在没有平台数据目录的环境（浏览器开发壳）会抛，`workspaceRootsOf` 吞成空列表：
        // 那种环境本来也没有真实文件系统可监视，不能因为它把整个开项目流程带崩。
        await kernel.fileWatch.start([
          p.rootDir,
          ...p.kojoPaths,
          ...(p.savDir ? [p.savDir] : []),
          ...workspaceRootsOf(kernel),
        ]);

        // 可写路径批准（首次打开必须由用户显式确认；未批准 = 只读浏览）；
        // 批准记录与新提议不一致（approvalMismatch）同样重弹确认（F1/F2 修复）
        const approved = await kernel.project.approvedWritableFor(dir);
        if (!approved || approvalMismatch) setPendingApproval(p);
        setWritable(approved !== null && !approvalMismatch);

        // 口上域全量索引：解析器在 project.opened 已自动开建，这里等待其完成。
        // 索引失败**不**回退欢迎页：项目仍可浏览，失败原因走状态栏 + 通知显式呈现
        // （原先会走外层 catch → 用户只见「项目打不开」，无从判断是索引的问题）
        setIndexing(true);
        setIndexError(null);
        const parser = kernel.services.get<ErbParserService>('erb.parser');
        try {
          const idx = await parser.ensureIndex();
          setIndex(idx);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          setIndexError(msg);
          notify({ kind: 'error', message: `口上域索引构建失败：${msg}` });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        // 打开失败必须显式可见：只落在 welcome 错误区容易被误读成「项目读不了」而无从下手
        notify({ kind: 'error', message: `打开项目失败：${msg}` });
        // 内核 open() 失败不会关掉还活着的旧项目——留在项目态，别把用户踢回欢迎页
        setPhase(kernel.project.current() !== null ? 'project' : 'welcome');
      } finally {
        unMismatch();
        setIndexing(false);
      }
    },
    [kernel, notify, project, resetProjectUiState],
  );

  const chooseAndOpen = useCallback(async () => {
    try {
      // 泛化主入口（A2）：对话框不再预设「游戏目录」——选任意文件夹，适配器自动识别
      const dir = await invoke<string | null>('choose_directory', { title: '打开文件夹（自动识别游戏）' });
      if (dir) await openProject(dir);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [openProject]);

  /** 欢迎页最近列表「移除」：乐观更新先行，失败回滚并人话通知（存储是权威，UI 只是投影） */
  const removeRecentEntry = useCallback(
    (dir: string) => {
      if (!kernel) return;
      const snapshot = recent;
      setRecent(removeRecentOptimistic(snapshot, dir));
      void kernel.project.removeRecent(dir).catch((e: unknown) => {
        setRecent(snapshot);
        const msg = e instanceof Error ? e.message : String(e);
        notify({ kind: 'error', message: `从最近列表移除失败：${msg}` });
      });
    },
    [kernel, recent, notify],
  );

  /** 欢迎页最近列表「清除全部」：直接清（欢迎页数据丢了可重开项目自动找回，不值得弹框） */
  const clearRecentEntries = useCallback(() => {
    if (!kernel) return;
    const snapshot = recent;
    setRecent([]);
    void kernel.project.clearRecent().then(
      () => notify({ kind: 'info', message: '已清除全部最近打开记录' }),
      (e: unknown) => {
        setRecent(snapshot);
        const msg = e instanceof Error ? e.message : String(e);
        notify({ kind: 'error', message: `清除最近列表失败：${msg}` });
      },
    );
  }, [kernel, recent, notify]);

  /** 欢迎页失效标记的探测通道；内核未就绪时不会被取用（列表只在 kernelReady 后渲染） */
  const statPath = useCallback(
    (p: string): Promise<FileStat | null> => (kernel ? kernel.io.stat(p) : Promise.resolve(null)),
    [kernel],
  );

  const commitOpenFile = useCallback((path: string, line?: number, column?: number) => {
    setOpenTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActiveFile(path);
    setReveal(line ? revealTargetOf({ line, column }, Date.now()) : null);
  }, []);

  const requestOpenFile = useCallback(
    (path: string, line?: number, column?: number) => {
      // P3 多标签：切换标签不丢内容（model 留内存），无需未保存确认
      commitOpenFile(path, line, column);
    },
    [commitOpenFile],
  );

  const openFile = useCallback(
    (path: string) => {
      requestOpenFile(path);
    },
    [requestOpenFile],
  );

  const phaseRef = useRef<AppPhase>(phase);
  phaseRef.current = phase;
  // 拖放落地要用、但不值得整依赖进订阅 effect 的快照（脏标签集合 / 当前项目根）
  const dirtyRef = useRef(dirtyPaths);
  dirtyRef.current = dirtyPaths;
  const rootDirRef = useRef<string | null>(null);
  rootDirRef.current = project?.rootDir ?? null;

  // 从资源管理器拖文件/文件夹进窗口即打开（Rust `kojo:drag-drop` → 这里落地）。
  // 只读链路：路径只喂既有打开入口，写权限仍由写允许域既有分野决定。
  // 文件夹是项目入口（欢迎页与项目态同权，对标 VSCode）；文件只在项目态开标签。
  useEffect(() => {
    if (!kernel) return;
    const io = kernel.io;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const overlay = (type: 'enter' | 'over' | 'leave' | 'drop'): void => {
      setDropHint((s) => nextDropOverlay(s, { type }));
    };
    void subscribeDragDrop({
      onEnter: () => overlay('enter'),
      onOver: () => overlay('over'),
      onLeave: () => overlay('leave'),
      onDrop: (paths) => {
        overlay('drop');
        const ph = phaseRef.current;
        if (ph !== 'welcome' && ph !== 'project') {
          // opening/boot：项目还没就绪，拖什么先都接不住——说一句，不静默
          notify({ kind: 'info', message: NOT_READY_MESSAGE });
          return;
        }
        void routeDroppedPaths({
          io,
          paths,
          projectOpen: ph === 'project',
          hasUnsavedChanges: dirtyRef.current.size > 0,
          currentProjectDir: rootDirRef.current,
          openFile: (p) => requestOpenFile(p),
          openProject: (dir) => void openProject(dir),
          reloadProject: () => {
            const cur = rootDirRef.current;
            if (cur) void openProject(cur, { keepView: true });
          },
          notify: (message) => notify({ kind: 'info', message }),
        });
      },
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e: unknown) => {
        console.warn('[drag-drop] 订阅失败:', e);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [kernel, notify, requestOpenFile, openProject]);

  /** 关闭标签（无确认路径；model 回收由 EditorPane 的 openPaths effect 落地） */
  const doCloseTab = useCallback(
    (path: string) => {
      const i = openTabs.indexOf(path);
      const next = openTabs.filter((p) => p !== path);
      setOpenTabs(next);
      setDirtyPaths((prev) => {
        if (!prev.has(path)) return prev;
        const n = new Set(prev);
        n.delete(path);
        return n;
      });
      if (path === activeFile) {
        // 激活邻居标签（优先右侧，末尾则左侧）；空 → 编辑器区回空态
        setActiveFile(next.length > 0 ? (next[Math.min(i, next.length - 1)] ?? null) : null);
        setReveal(null);
      }
    },
    [openTabs, activeFile],
  );

  /** 关闭标签入口：脏标签先弹确认（绝不静默丢弃，审阅 M4 精神在多标签下的延续） */
  const requestCloseTab = useCallback(
    (path: string) => {
      if (dirtyPaths.has(path)) {
        setPendingClose(path);
        return;
      }
      doCloseTab(path);
    },
    [dirtyPaths, doCloseTab],
  );

  const decideClose = useCallback(
    async (action: 'save-then-go' | 'discard' | 'cancel') => {
      const path = pendingClose;
      setPendingClose(null);
      if (!path || action === 'cancel') return;
      if (action === 'save-then-go') {
        const ok = actionsRef.current ? await actionsRef.current.savePath(path) : false;
        if (!ok) return; // 保存失败：标签保留（错误已显示在编辑器状态栏/通知）
      }
      doCloseTab(path);
    },
    [pendingClose, doCloseTab],
  );

  /** 拖拽重排标签（删除后插入语义：toIndex 以移除 path 之后的数组为基准） */
  const reorderTab = useCallback((path: string, toIndex: number) => {
    setOpenTabs((prev) => {
      const from = prev.indexOf(path);
      if (from < 0) return prev;
      const next = [...prev];
      next.splice(from, 1);
      next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, path);
      return next;
    });
  }, []);

  /** 全部保存（Ctrl+Shift+S；壳层命令经 ProjectView 注入） */
  const saveAll = useCallback(async (): Promise<boolean> => {
    return actionsRef.current ? actionsRef.current.saveAll() : false;
  }, []);

  const closeProject = useCallback(async () => {
    if (!kernel) return;
    await kernel.project.close();
    kernel.fileWatch.stop(); // BUG-5：监视随项目生命周期收（与写允许域同相位）
    // Rust 侧允许域回到「仅 appDataDir」（与 kernel 的 writablePaths 清理同相位）
    if (isTauri()) {
      try {
        await invoke('clear_write_domain');
      } catch (e: unknown) {
        setError(`写允许域清除失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setProject(null);
    setIndex(null);
    resetProjectUiState();
    setPendingApproval(null);
    setWritable(null);
    setIndexError(null);
    // 检索结果按项目根算出来的：项目一关，旧结果里的路径全部失去意义（留着只会误导）
    resetSearch();
    setPhase('welcome');
    setRecent(await kernel.project.recent());
  }, [kernel, resetProjectUiState]);

  const decideApproval = useCallback(
    async (allow: boolean) => {
      const p = pendingApproval;
      setPendingApproval(null);
      if (!p || !kernel) return;
      if (!allow) {
        setWritable(false);
        return;
      }
      try {
        await kernel.project.approveWritablePaths(p, p.writablePaths);
        setWritable(true);
      } catch (e: unknown) {
        // 授权失败必须显式可见（P0 实机反馈）：否则对话框一关、徽章仍是「只读」，
        // 用户以为点了没反应（=「无法重新选择权限」）
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setWritable(false);
        notify({ kind: 'error', message: `写权限授权失败：${msg}` });
      }
    },
    [kernel, pendingApproval, notify],
  );

  /** 重授权入口（定稿 Q9：状态栏徽章点击 + 通知 action 两者都留） */
  const requestReauth = useCallback(() => {
    if (project) setPendingApproval(project);
  }, [project]);

  const body =
    phase === 'project' && kernel && project ? (
      <Suspense fallback={<ProjectViewSkeleton />}>
        <ProjectView
          kernel={kernel}
          project={project}
          index={index}
          indexing={indexing}
          indexError={indexError}
          activeFile={activeFile}
          openTabs={openTabs}
          dirtyPaths={dirtyPaths}
          reveal={reveal}
          onOpenFile={openFile}
          onActivateTab={requestOpenFile}
          onRequestCloseTab={requestCloseTab}
          onReorderTab={reorderTab}
          onSaveAll={saveAll}
          onDirtyChange={onDirtyChange}
          registerActions={registerActions}
          onClose={closeProject}
          onReload={() => void openProject(project.rootDir, { keepView: true })}
          writable={writable ?? false}
          onReauth={requestReauth}
        />
      </Suspense>
    ) : (
      <WelcomeView
        phase={phase}
        error={error}
        recent={recent}
        tauri={isTauri()}
        kernelReady={kernel !== null}
        onOpenDirectory={chooseAndOpen}
        onOpenRecent={openProject}
        onRemoveRecent={removeRecentEntry}
        onClearRecent={clearRecentEntries}
        statPath={statPath}
      />
    );

  return (
    <>
      {body}
      {dropHint === 'shown' ? (
        <div className="drop-hint">{dropHintText()}</div>
      ) : null}
      {pendingApproval ? <WritableApprovalDialog project={pendingApproval} onDecide={decideApproval} /> : null}
      {pendingClose ? (
        <UnsavedConfirmDialog filePath={pendingClose} context="close" onDecide={decideClose} />
      ) : null}
    </>
  );
}
