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
import { isPathUnder, join } from '@kojo/plugin-api';
import { removeRecentOptimistic } from './WelcomeView';
import { invoke, isTauri } from '../bridge/invoke';
import { tauriBridge } from '../bridge/tauri-bridge';
import {
  AutosaveJournal,
  HEARTBEAT_INTERVAL_MS,
  SNAPSHOT_DEBOUNCE_MS,
  type JournalIo,
} from './autosave-journal';
import {
  SESSION_FLUSH_DEBOUNCE_MS,
  emptySessionRecord,
  loadSessionRecord,
  saveSessionRecord,
  sessionProjectOf,
  upsertSessionProject,
  type SessionRecord,
} from './session-store';
import { clearRecoveredContents, recoveredPaths, setRecoveredContents } from './recovery-store';
import { bootstrapKernel } from '../bootstrap';
import { perf } from '../perf';
import { revealTargetOf, type RevealTarget } from '../monaco/reveal-position';
import {
  NOT_READY_MESSAGE,
  clearDropHover,
  copyDroppedFiles,
  dropTargetDirAt,
  dropHintText,
  nextDropOverlay,
  planDropAt,
  routeDroppedPaths,
  subscribeDragDrop,
  updateDropHover,
  type DropOverlayState,
} from './drag-drop';
import { useNotify } from './NotificationCenter';
import { UnsavedConfirmDialog } from './UnsavedConfirmDialog';
import { UnsavedFilesConfirmDialog } from './UnsavedFilesConfirmDialog';
import { installWindowCloseGuard } from './window-close-guard';
import { WelcomeView } from './WelcomeView';
import { WritableApprovalDialog } from './WritableApprovalDialog';
import { workspaceRootsOf, planAddExtraRoot } from './workspace-roots';
import { resetSearch } from './search-store';
import { bindDiffView, DIFF_VIEW_OVERLAY_ID } from './diff-view';
import { createDiffViewOverlay } from './DiffViewOverlay';
import {
  applyPin,
  batchCloseEmptyReason,
  planBatchClose,
  planReorder,
  type BatchCloseMode,
} from './tabs-ops';
import {
  FILE_HISTORY_OVERLAY_ID,
  setFileHistoryTarget,
  SHOW_FILE_HISTORY_COMMAND_ID,
} from './file-history';
import { createFileHistoryOverlay } from './FileHistoryOverlay';
import {
  CALL_HIERARCHY_COMMAND_ID,
  CALL_HIERARCHY_OVERLAY_ID,
  setCallHierarchyState,
} from './call-hierarchy';
import { createCallHierarchyOverlay } from './CallHierarchyOverlay';
import { readJumpProbe } from './jump-to-state';
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

/**
 * journal IO 适配（退出/崩溃守护批）：Tauri bridge 直写 appData——appData 在 Rust
 * 写允许域内恒可写，**不经 kernel io**（那条链 assertWritable 游戏路径 + 触发备份
 * 轮换，都不是快照该走的路）。只在 Tauri 壳被调用（engine 仅在 isTauri() 下装配）。
 */
const journalIo: JournalIo = {
  readTextFile: async (p) => {
    try {
      if (!(await tauriBridge.exists(p))) return undefined;
      return new TextDecoder().decode(await tauriBridge.readFileBytes(p));
    } catch {
      return undefined; // 读不动按缺失算：恢复决策宁可保守降级，不让兜底数据炸启动
    }
  },
  writeTextFile: async (p, text) => {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    if (i > 0) await tauriBridge.ensureDir(p.slice(0, i));
    await tauriBridge.writeFileBytes(p, new TextEncoder().encode(text));
  },
  removeFile: async (p) => {
    try {
      await tauriBridge.removeFile(p);
    } catch {
      // 幂等清理：文件不在/删不掉都不值得出声（下次快照会覆盖出一致状态）
    }
  },
};

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
  /**
   * 固定标签集合（C2）。会话态：标签列表本身不持久化，pin 不必走得更远——
   * 与 openTabs 同生命周期，关项目 / 切项目随 resetProjectUiState 一起清。
   * openTabs 维持「固定区在前」的不变量（applyPin / planReorder 落地），渲染层不再排序。
   */
  const [pinnedPaths, setPinnedPaths] = useState<ReadonlySet<string>>(new Set());
  /**
   * 会话级附加根（D1，对标 VSCode Add Folder to Workspace）：作者临时挂进来的浏览/
   * 检索/监视根。**不持久化**、不进写允许域（附加根默认只读——写仍走既有批准域），
   * 与 openTabs 同属项目会话态：关项目 / 切项目随 resetProjectUiState 一起清。
   */
  const [extraRoots, setExtraRoots] = useState<readonly string[]>([]);
  /** 待确认的脏标签关闭（非 null = 弹确认框） */
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  /** 待确认的关项目/关窗（非 null = 弹全项目未保存确认；深审 A2） */
  const [pendingProjectClose, setPendingProjectClose] = useState<ReadonlySet<string> | null>(null);
  /** Alt+F4 批准后：关项目完成即退出应用（窗口关闭意图延续，不走二次确认） */
  const exitAfterCloseRef = useRef(false);
  /** 关窗放行标志：确认框批准 + 关项目完成后置位，守卫对主动 close() 不拦（退出通道） */
  const windowCloseApprovedRef = useRef(false);
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

  /* --------- 退出/崩溃守护（2026-10-16）：autosave 引擎 + 会话记录 + 恢复 --------- */

  /** 崩溃恢复待决（非 null = 欢迎页横幅：上次异常退出且有快照） */
  const [crashRecovery, setCrashRecovery] = useState<{ root: string; files: number } | null>(null);
  /** 欢迎页「继续上次会话」的目标根（最近一次打开的项目；随会话落盘更新） */
  const [resumeRoot, setResumeRoot] = useState<string | null>(null);
  /** 会话标签集的内存权威（落盘数据的投影；开项目时从它恢复） */
  const sessionRecordRef = useRef<SessionRecord>(emptySessionRecord());
  /** 会话落盘的防抖计时器 */
  const sessionFlushTimerRef = useRef<number | null>(null);
  /** autosave 引擎（仅 Tauri 壳装配；浏览器壳恒 null，全部相关链路自然空转） */
  const autosaveRef = useRef<AutosaveJournal | null>(null);
  /** 恢复意图：欢迎页点了「恢复」→ 下一次 openProject 把恢复件合并进标签集 */
  const pendingRecoverRef = useRef(false);
  /** 文件树刷新句柄（B6 拖入复制落地后失效目标目录；ProjectView 注册，形态照 actionsRef） */
  const treeRefreshRef = useRef<(() => void) | null>(null);
  const registerTreeRefresh = useCallback((refresh: () => void) => {
    treeRefreshRef.current = refresh;
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
        // 会话记录读回（退出/崩溃守护批）：欢迎页「继续上次会话」+ 开项目恢复标签集。
        // 读不到就算了——会话数据是锦上添花，绝不挡启动
        try {
          const rec = await loadSessionRecord(k.storage.global());
          sessionRecordRef.current = rec;
          setResumeRoot(rec.lastRoot);
        } catch {
          // 静默：空记录即无会话可恢复
        }
        // 崩溃探测（退出/崩溃守护批）：journal 非空 + 心跳超龄/缺失 = 上次不正常退出。
        // 探测结果只决定欢迎页横幅与恢复内容注入，**永不自动写游戏目录**
        if (isTauri()) {
          try {
            const dir = join(await tauriBridge.appDataDir(), 'autosave');
            await tauriBridge.ensureDir(dir);
            const engine = new AutosaveJournal(journalIo, dir);
            autosaveRef.current = engine;
            const found = await engine.readForRecovery();
            if (found && found.manifest.root) {
              setRecoveredContents(found.records);
              setCrashRecovery({ root: found.manifest.root, files: found.records.length });
            }
          } catch {
            // autosave 通道坏了不挡启动：编辑照常，只是这次没有崩溃兜底
          }
        }
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
    // 调用层级（批 E，2026-10-16）：宿主自建只读查询面板（Monaco standalone 无
    // CallHierarchy API，取证见 PITFALLS §83）。判定与收集全在
    // `monaco/erb-call-hierarchy.ts`（复用 erb.parser 反向索引与 functionAt 通道），
    // 这里只做两件接线：命令面板入口 + overlay 注册。位点现取 `readJumpProbe()`
    // （G1 既有探针——`EditorCommandContext` 没有光标行，不为此扩宿主管道）；
    // 跳转落既有 `editor.revealLocation`，与转到定义同一条通道。
    const parser = (): ErbParserService | undefined => kernel.services.tryGet<ErbParserService>('erb.parser');
    const unRegCallHierarchy = kernel.slots.register('ui.overlay', {
      id: CALL_HIERARCHY_OVERLAY_ID,
      order: 42,
      component: createCallHierarchyOverlay({
        currentIndex: () => {
          try {
            return parser()?.currentIndex() ?? null;
          } catch {
            return null;
          }
        },
        functionAt: (path, line) => {
          try {
            const service = parser();
            // 三态：通道不存在（服务/方法缺席）⇒ null（数据层退化到索引自扫）；
            // 在场则它的 undefined 是权威的"不在此函数内"
            return service?.functionAt ? service.functionAt(path, line) : null;
          } catch {
            return null;
          }
        },
        reveal: (path, line, column) =>
          kernel.bus.emit('editor.revealLocation', {
            filePath: path,
            line,
            ...(column !== undefined ? { column } : {}),
            source: '调用层级',
          }),
        close: () =>
          kernel.bus.emit('ui.overlay.close', { id: CALL_HIERARCHY_OVERLAY_ID, source: 'host:call-hierarchy' }),
      }),
    });
    const unRegCallHierarchyCommand = kernel.slots.register('editor.command', {
      id: CALL_HIERARCHY_COMMAND_ID,
      title: '查看当前函数的调用层级（谁调用它 / 它调用谁）',
      when: (ctx) => Boolean(ctx.activeFile),
      run: () => {
        const probe = readJumpProbe();
        if (!probe) {
          setCallHierarchyState({
            kind: 'rejected',
            reason: '编辑器还没准备好——先打开一份文件，把光标放到函数体里，再运行本命令。',
          });
        } else if (probe.derivedView) {
          setCallHierarchyState({
            kind: 'rejected',
            reason: '现在屏幕上的是派生视图（行号不属于原文）——切回原代码再查看调用层级。',
          });
        } else {
          setCallHierarchyState({ kind: 'request', request: { filePath: probe.path, line: probe.line } });
        }
        kernel.bus.emit('ui.overlay.open', { id: CALL_HIERARCHY_OVERLAY_ID, source: 'host:call-hierarchy' });
      },
    });
    return () => {
      unBind();
      unReg();
      unRegHistory();
      unRegHistoryCommand();
      unRegCallHierarchy();
      unRegCallHierarchyCommand();
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
    setPinnedPaths(new Set()); // pin 是标签态的一部分，随标签一起清（C2）
    setExtraRoots([]); // 会话级附加根是项目会话的一部分（D1）：换项目即清，绝不带进下一个
    setPendingClose(null);
    setReveal(null);
  }, []);

  /**
   * 会话标签集装回（退出/崩溃守护批）：换项目（欢迎页首开 / 切回 / 重启后重开）时
   * 按根目录恢复。恢复件（崩溃快照）追加在尾部、激活落第一个恢复件——用户第一眼
   * 看到的就是没保存成的那份。pinned 与 tabs 取交集（记录可能比盘上事实旧）。
   * 无记录且无恢复件 = 保持空，绝不凭空造标签。
   */
  const restoreSessionTabs = useCallback((dir: string, recovered: readonly string[]) => {
    const rec = sessionProjectOf(sessionRecordRef.current, dir);
    const tabs = [...(rec?.tabs ?? [])];
    for (const p of recovered) if (!tabs.includes(p)) tabs.push(p);
    if (tabs.length === 0) return;
    const pinned = new Set((rec?.pinned ?? []).filter((p) => tabs.includes(p)));
    const active = recovered[0] ?? (rec?.active && tabs.includes(rec.active) ? rec.active : tabs[0] ?? null);
    setOpenTabs(tabs);
    setActiveFile(active);
    setPinnedPaths(pinned);
  }, []);

  const openProject = useCallback(
    async (dir: string, opts?: { keepView?: boolean }) => {
      if (!kernel) return;
      // 崩溃恢复意图只对"下一次开项目"生效一次（打开失败也不悬挂到更晚的打开）
      const wantRecovery = pendingRecoverRef.current;
      pendingRecoverRef.current = false;
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
        // 同目录 reload 靠 keepView 保住标签，只清激活与定位（原行为）。
        // 换项目即恢复该项目的会话标签集（退出/崩溃守护批）：重启后重开、同会话
        // 切回、崩溃恢复合并，走的是同一条路
        if (project?.rootDir !== dir) {
          resetProjectUiState();
          restoreSessionTabs(dir, wantRecovery ? recoveredPaths() : []);
        } else {
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

        // BUG-5：起文件监视。根集合 = 项目根 ∪ 口上域 ∪ 存档目录 ∪ 会话级附加根（D1）
        //        ∪ 作者工作区全部根——组装与启动收在下方的专用 effect 里（extraRoots
        //        变化 = 换根，与首开共用同一条路），这里只负责把项目挂上状态。

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
    [kernel, notify, project, resetProjectUiState, restoreSessionTabs],
  );

  /**
   * 文件监视的根集合收口（D1）：**首开与"加了文件夹"共用同一条路**。
   *
   * 契约取舍：`fileWatch.start(roots)` 没有动态加根（plugin-api 的 FileWatchController
   * 只有 start/stop/state），但 `start` 的语义本就是「用新的一组根替换旧的」（内核
   * watcher 自带 teardown + 嵌套根折叠）——所以"加根" = 用**完整根集合**再 start 一次，
   * 不需要先 stop。代价是附加根一变就重挂全部句柄：会话里加根是低频动作（一次对话
   * 至多几次），而动态加根要动内核契约，违背本段纪律。
   */
  useEffect(() => {
    if (!kernel || !project) return;
    void kernel.fileWatch.start([
      project.rootDir,
      ...project.kojoPaths,
      ...(project.savDir ? [project.savDir] : []),
      ...extraRoots,
      // 服务在没有平台数据目录的环境（浏览器开发壳）会抛，workspaceRootsOf 吞成空列表
      ...workspaceRootsOf(kernel),
    ]);
  }, [kernel, project, extraRoots]);

  /**
   * 「添加文件夹到工作区」（D1）：系统目录对话框 → 去重计划 → 落会话态。
   * 取消 / 空结果安静返回；重复加与选了项目根本身都给一句人话（planAddExtraRoot）；
   * 对话框本身失败也得出声（绝不点了没反应）。
   */
  const addExtraRoot = useCallback(async () => {
    if (!kernel || !project) return;
    try {
      const dir = await invoke<string | null>('choose_directory', {
        title: '选择要添加到工作区的文件夹',
      });
      if (!dir) return; // 用户取消：安静返回，不是故障
      const plan = planAddExtraRoot(extraRoots, dir, project.rootDir);
      setExtraRoots(plan.roots);
      if (plan.note) notify({ kind: 'info', message: plan.note });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ kind: 'error', message: `添加文件夹失败：${msg}` });
    }
  }, [kernel, project, extraRoots, notify]);

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

  // Alt+F4 / 关窗守卫（深审 A2）：Tauri 的 onCloseRequested 不 preventDefault 就直接
  // 关窗（EditorPane 卸载 dispose 全部 model，脏修改静默丢失）。一律先拦下再分流：
  // 无脏 → 直接退出；有脏 → 复用关项目确认框，批准后关项目 + 退出。
  // 仅 Tauri 壳生效；浏览器 dev 无窗口关闭语义，不装。
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const cleanup = await installWindowCloseGuard(
        {
          onCloseRequested: (handler) => getCurrentWindow().onCloseRequested(handler),
        },
        {
          isApproved: () => windowCloseApprovedRef.current,
          hasDirty: () => dirtyRef.current.size > 0,
          onConfirm: () => {
            exitAfterCloseRef.current = true;
            setPendingProjectClose(dirtyRef.current);
          },
        },
      );
      if (disposed) cleanup();
      else unlisten = cleanup;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  const rootDirRef = useRef<string | null>(null);
  rootDirRef.current = project?.rootDir ?? null;

  /* -------- autosave（退出/崩溃守护批）：崩溃兜底快照，Tauri 壳专属 -------- */

  // 快照触发器 = dirtyPaths 变化（防抖落盘）；真相源 = EditorPane 的快照句柄
  //（脏 ⇒ model 必在内存，句柄天然覆盖后台标签）。浏览器壳引擎未装配，整段空转。
  useEffect(() => {
    const engine = autosaveRef.current;
    if (!engine) return;
    if (dirtyPaths.size === 0) {
      // 脏清空（保存完 / 标签关完 / 关项目）→ journal 清空。本会话没写过快照时
      // 是 no-op——绝不误伤上一会话留在盘上的崩溃证据
      void engine.clear().catch(() => undefined);
      return;
    }
    const t = window.setTimeout(() => {
      const records = actionsRef.current?.snapshots() ?? [];
      void engine.snapshot(rootDirRef.current, records).catch(() => undefined);
    }, SNAPSHOT_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [dirtyPaths]);

  // 心跳：脏周期内定期刷（崩溃判定的时间锚）。干净会话不刷——绝不制造"疑似崩溃"证据
  useEffect(() => {
    const engine = autosaveRef.current;
    if (!engine || dirtyPaths.size === 0) return;
    const id = window.setInterval(() => {
      void engine.heartbeat().catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [dirtyPaths]);

  // 从资源管理器拖文件/文件夹进窗口（Rust `kojo:drag-drop` → 这里落地）。
  // 打开语义：只读链路，路径只喂既有打开入口（文件夹是项目入口；文件只在项目态开标签）。
  // 复制语义（B6）：drop 坐标命中树内目录行/包节点（data-drop-dir）→ 复制进该目录——
  // 唯一写通道 kernel.io.copyFile（只对 to 过闸）；isWritable 预检 + 防覆盖查重都在它前面。
  useEffect(() => {
    if (!kernel) return;
    const io = kernel.io;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const overlay = (type: 'enter' | 'over' | 'leave' | 'drop'): void => {
      setDropHint((s) => nextDropOverlay(s, { type }));
    };
    void subscribeDragDrop({
      onEnter: (x, y) => {
        overlay('enter');
        updateDropHover(x, y);
      },
      onOver: (x, y) => {
        overlay('over');
        updateDropHover(x, y);
      },
      onLeave: () => {
        overlay('leave');
        clearDropHover();
      },
      onDrop: (paths, x, y) => {
        overlay('drop');
        clearDropHover();
        const ph = phaseRef.current;
        if (ph !== 'welcome' && ph !== 'project') {
          // opening/boot：项目还没就绪，拖什么先都接不住——说一句，不静默
          notify({ kind: 'info', message: NOT_READY_MESSAGE });
          return;
        }
        if (ph === 'project' && x !== null && y !== null) {
          const plan = planDropAt(dropTargetDirAt(x, y));
          if (plan.kind === 'copy') {
            void copyDroppedFiles({
              io,
              paths,
              targetDir: plan.targetDir,
              notify: (message) => notify({ kind: 'info', message }),
              onLanded: () => treeRefreshRef.current?.(),
            });
            return;
          }
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

  /**
   * 批量关闭队列（C1）：**尚未关闭**的剩余待关标签（null = 没有进行中的批量关闭）。
   * 推进器 advanceBatch 消费它；脏标签停在原地等单标签确认，用户取消即清空。
   */
  const batchQueueRef = useRef<readonly string[] | null>(null);

  /**
   * 一次关掉多张干净标签（C1 批量关闭的地基）：全部走**功能性更新**——
   * 同步循环里连关多张也不吃陈旧闭包（旧 doCloseTab 的"过滤+赋值"写法连关两张
   * 会互相覆盖）。激活收尾用快照 ref 一次算清：关的标签里有活动文件 →
   * 落到原视角下的右侧邻居（末尾则左侧）；空 → 编辑器区回空态。
   */
  const closeManySync = useCallback((paths: readonly string[]) => {
    if (paths.length === 0) return;
    const gone = new Set(paths);
    setOpenTabs((prev) => (prev.some((p) => gone.has(p)) ? prev.filter((p) => !gone.has(p)) : prev));
    setDirtyPaths((prev) => {
      let n: Set<string> | null = null;
      for (const p of prev) {
        if (gone.has(p)) {
          n ??= new Set(prev);
          n.delete(p);
        }
      }
      return n ?? prev;
    });
    setPinnedPaths((prev) => {
      let n: Set<string> | null = null;
      for (const p of prev) {
        if (gone.has(p)) {
          n ??= new Set(prev);
          n.delete(p);
        }
      }
      return n ?? prev;
    });
    const tabs = openTabsRef.current;
    const cur = activeFileRef.current;
    if (cur !== null && gone.has(cur)) {
      const i = tabs.indexOf(cur);
      const remaining = tabs.filter((p) => !gone.has(p));
      const removedBefore = tabs.slice(0, i).filter((p) => gone.has(p)).length;
      const j = Math.min(i - removedBefore, remaining.length - 1);
      setActiveFile(remaining.length > 0 ? (remaining[j] ?? null) : null);
      setReveal(null);
    }
  }, []);

  /**
   * 批量关闭推进器：关掉队列开头的干净标签直到遇见脏的（弹一次确认，停在原地，
   * 确认结果经 decideClose 续跑或中止）。队列里的目标可能已被其他途径关掉
   * （如确认期间用户手动关了别的）——跳过不再在打开列表里的，不误关。
   */
  const advanceBatch = useCallback(() => {
    for (;;) {
      const queue = batchQueueRef.current;
      if (!queue || queue.length === 0) {
        batchQueueRef.current = null;
        return;
      }
      const tabs = openTabsRef.current;
      const idx = queue.findIndex((p) => tabs.includes(p));
      if (idx < 0) {
        batchQueueRef.current = null;
        return;
      }
      const next = queue[idx]!;
      batchQueueRef.current = queue.slice(idx + 1);
      if (dirtyRef.current.has(next)) {
        setPendingClose(next); // 停在原地等确认（铁律：绝不静默丢弃脏修改）
        return;
      }
      closeManySync([next]);
    }
  }, [closeManySync]);

  /** 关闭标签（无确认路径；model 回收由 EditorPane 的 openPaths effect 落地） */
  const doCloseTab = useCallback(
    (path: string) => {
      closeManySync([path]);
    },
    [closeManySync],
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
      if (!path || action === 'cancel') {
        // 取消即中止剩余的批量关闭（停在原地，已关的不回滚——VSCode 同款）；单标签关闭无队列，no-op
        batchQueueRef.current = null;
        return;
      }
      if (action === 'save-then-go') {
        const ok = actionsRef.current ? await actionsRef.current.savePath(path) : false;
        if (!ok) return; // 保存失败：标签保留（错误已显示在编辑器状态栏/通知）
      }
      doCloseTab(path);
      advanceBatch(); // 批量关闭中：继续推进队列（无队列时 no-op）
    },
    [pendingClose, doCloseTab, advanceBatch],
  );

  /**
   * 拖拽重排标签（C2；删除后插入语义：toIndex 以移除 path 之后的数组为基准）。
   * 跨固定区分界的拖放自动改固定态（planReorder：非固定拖进固定区 = pin，
   * 固定拖出 = unpin——落点指示画哪标签落哪，所见即所得）。
   */
  const reorderTab = useCallback((path: string, toIndex: number) => {
    const plan = planReorder(openTabsRef.current, path, toIndex, pinnedRef.current);
    setOpenTabs([...plan.order]);
    const pc = plan.pinChange;
    if (pc) {
      setPinnedPaths((prev) => {
        const next = new Set(prev);
        if (pc.pin) next.add(pc.path);
        else next.delete(pc.path);
        return next;
      });
    }
  }, []);

  /** 全部保存（Ctrl+Shift+S；壳层命令经 ProjectView 注入） */
  const saveAll = useCallback(async (): Promise<boolean> => {
    return actionsRef.current ? actionsRef.current.saveAll() : false;
  }, []);

  /* -------------- 文件树编辑的标签收尾（B1；状态单源在此——树侧只发意图） -------------- */

  /** 标签/激活文件的最新值快照（回调经 ref 闭包下发，不能吃陈旧闭包） */
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;
  /** 固定标签的最新值快照（批量关闭计划 / 拖拽重排都要读当下值，同上） */
  const pinnedRef = useRef(pinnedPaths);
  pinnedRef.current = pinnedPaths;

  // 会话标签集落盘（退出/崩溃守护批）：debounce 600ms，写 kernel 全局存储。
  // 关项目不清记录（重启后「继续上次会话」靠它）；欢迎页（project null）不写——
  // lastRoot 只指向最近一次打开过的项目。恢复用的读值经 ref 取最新，不吃陈旧闭包。
  useEffect(() => {
    if (!kernel || !project) return;
    const root = project.rootDir;
    if (sessionFlushTimerRef.current !== null) window.clearTimeout(sessionFlushTimerRef.current);
    sessionFlushTimerRef.current = window.setTimeout(() => {
      sessionFlushTimerRef.current = null;
      const next = upsertSessionProject(sessionRecordRef.current, root, {
        tabs: openTabsRef.current,
        active: activeFileRef.current,
        pinned: [...pinnedRef.current],
      });
      sessionRecordRef.current = next;
      setResumeRoot(next.lastRoot);
      void saveSessionRecord(kernel.storage.global(), next).catch(() => undefined);
    }, SESSION_FLUSH_DEBOUNCE_MS);
    return () => {
      if (sessionFlushTimerRef.current !== null) {
        window.clearTimeout(sessionFlushTimerRef.current);
        sessionFlushTimerRef.current = null;
      }
    };
  }, [kernel, project, openTabs, activeFile, pinnedPaths]);

  /** 固定 / 取消固定标签（C2）：pinned 会话态 + 顺序重排（固定区在前，见 applyPin） */
  const toggleTabPin = useCallback((path: string) => {
    const wasPinned = pinnedRef.current.has(path);
    const nextPinned = new Set(pinnedRef.current);
    if (wasPinned) nextPinned.delete(path);
    else nextPinned.add(path);
    pinnedRef.current = nextPinned; // 同一拍内的连续操作读得到最新值
    setPinnedPaths(nextPinned);
    setOpenTabs((tabs) => applyPin(tabs, path, !wasPinned, nextPinned));
  }, []);

  /**
   * 批量关闭入口（C1）：纯函数出计划（pinned 豁免），逐个走既有 requestCloseTab
   * 单标签确认链——脏的弹一次确认，取消即中止剩余（已关的不回滚）。
   * 计划为空也要有响（铁律 4）：按 batchCloseEmptyReason 回一句人话。
   */
  const runBatchClose = useCallback(
    (mode: BatchCloseMode, anchor: string) => {
      const tabs = openTabsRef.current;
      const plan = planBatchClose(mode, tabs, anchor, pinnedRef.current);
      if (plan.toClose.length === 0) {
        notify({ kind: 'info', message: batchCloseEmptyReason(mode, tabs, anchor, pinnedRef.current) });
        return;
      }
      const first = plan.toClose[0];
      if (!first) return;
      batchQueueRef.current = plan.toClose.slice(1);
      if (dirtyRef.current.has(first)) setPendingClose(first);
      else {
        closeManySync([first]);
        advanceBatch();
      }
    },
    [closeManySync, advanceBatch, notify],
  );

  /**
   * 删除/重命名的守门：涉及**打开中且有未保存修改**的文件就拦下，给一句人话。
   * 目录同样拦——脏文件在被删目录之下时，"删目录"会把它一起带走（递归删除是大刀）。
   */
  const guardFileOp = useCallback(
    (paths: readonly string[]): string | null => {
      for (const target of paths) {
        for (const p of dirtyPaths) {
          if (p === target || isPathUnder(target, p)) {
            const name = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
            return `文件「${name}」有未保存修改，请先保存或关闭它，再进行删除/重命名。`;
          }
        }
      }
      return null;
    },
    [dirtyPaths],
  );

  /**
   * 盘上操作落地后的标签收尾：被删的关标签（只可能是干净标签——脏的已被守门拦下）、
   * 被改名的换路径；激活文件随之切换到邻居或换新路径。
   */
  const onFilesGone = useCallback(
    (deleted: readonly string[], renamed: ReadonlyArray<{ from: string; to: string }>) => {
      const del = [...deleted];
      setOpenTabs((prev) => {
        let next = prev.filter((p) => !del.some((d) => p === d || isPathUnder(d, p)));
        for (const r of renamed) next = next.map((t) => (t === r.from ? r.to : t));
        return next;
      });
      setDirtyPaths((prev) => {
        let next: Set<string> | null = null;
        for (const d of del) {
          for (const p of prev) {
            if (p === d || isPathUnder(d, p)) {
              next ??= new Set(prev);
              next.delete(p);
            }
          }
        }
        // 改名的脏标签不该出现（守门拦了），但真发生时也不能留出悬空旧路径
        for (const r of renamed) {
          if (prev.has(r.from)) {
            next ??= new Set(prev);
            next.delete(r.from);
            next.add(r.to);
          }
        }
        return next ?? prev;
      });
      // 固定标签随标签收尾同步（C2）：被删的退出固定、被改名的换新路径——不留悬空 pin
      setPinnedPaths((prev) => {
        let next: Set<string> | null = null;
        for (const d of del) {
          for (const p of prev) {
            if (p === d || isPathUnder(d, p)) {
              next ??= new Set(prev);
              next.delete(p);
            }
          }
        }
        for (const r of renamed) {
          if (prev.has(r.from)) {
            next ??= new Set(prev);
            next.delete(r.from);
            next.add(r.to);
          }
        }
        return next ?? prev;
      });
      const cur = activeFileRef.current;
      if (cur === null) return;
      if (del.some((d) => cur === d || isPathUnder(d, cur))) {
        const tabs = openTabsRef.current.filter((p) => !del.some((d) => p === d || isPathUnder(d, p)));
        const i = openTabsRef.current.indexOf(cur);
        setActiveFile(tabs.length > 0 ? (tabs[Math.min(Math.max(i, 0), tabs.length - 1)] ?? null) : null);
        setReveal(null);
        return;
      }
      const moved = renamed.find((r) => r.from === cur);
      if (moved) setActiveFile(moved.to);
    },
    [],
  );

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

  /** 关项目入口（深审 A2）：有脏文件先弹全项目确认，绝不静默 dispose 全部 model */
  const requestCloseProject = useCallback(() => {
    if (dirtyPaths.size > 0) {
      exitAfterCloseRef.current = false;
      setPendingProjectClose(dirtyPaths);
      return;
    }
    void closeProject();
  }, [dirtyPaths, closeProject]);

  const decideProjectClose = useCallback(
    async (action: 'save-then-close' | 'discard' | 'cancel') => {
      const paths = pendingProjectClose;
      setPendingProjectClose(null);
      if (!paths || action === 'cancel') return;
      if (action === 'save-then-close') {
        const ok = actionsRef.current ? await actionsRef.current.saveAll() : false;
        if (!ok) return; // 保存失败：留在项目里（错误已显示在编辑器状态栏/通知），绝不静默丢
      }
      const exitAfter = exitAfterCloseRef.current;
      exitAfterCloseRef.current = false;
      // 脏内容已在此处分流（保存成功 或 用户明确丢弃）→ journal 强制清空：
      // 退出关窗的竞态里，autosave effect 的 clear 可能赶不上窗口消亡，这里显式收口
      //（'discard' 尤其重要：用户说了不要，崩溃恢复就绝不能再把它端回来）
      try {
        await autosaveRef.current?.discard();
      } catch {
        // 清理失败不影响退出/关项目
      }
      await closeProject();
      if (exitAfter && isTauri()) {
        // 退出通道 = 放行原生 close：置放行标志后主动 close()，守卫对这次请求不拦
        //（@tauri-apps/api v2 核心无 process 模块；capabilities 已加 core:window:allow-close）
        windowCloseApprovedRef.current = true;
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().close();
      }
    },
    [pendingProjectClose, closeProject],
  );

  /** 重授权入口（定稿 Q9：状态栏徽章点击 + 通知 action 两者都留） */
  const requestReauth = useCallback(() => {
    if (project) setPendingApproval(project);
  }, [project]);

  /* --------- 欢迎页的两个会话入口（退出/崩溃守护批） --------- */

  /** 崩溃恢复：开上次的项目 + 把快照内容装回 model 当未保存脏内容（存不存用户定） */
  const recoverCrash = useCallback(() => {
    const c = crashRecovery;
    if (!c || !c.root) return;
    setCrashRecovery(null);
    pendingRecoverRef.current = true;
    void openProject(c.root);
  }, [crashRecovery, openProject]);

  /** 崩溃恢复的"丢弃"：内存恢复件清掉 + journal 强制清空（用户说了不要） */
  const discardCrash = useCallback(() => {
    setCrashRecovery(null);
    clearRecoveredContents();
    void autosaveRef.current?.discard().catch(() => undefined);
  }, []);

  /** 继续上次会话：目标根 = 最近一次打开的项目（标签集由 openProject 的会话恢复装回） */
  const resumeSession = useCallback(() => {
    if (!resumeRoot) return;
    void openProject(resumeRoot);
  }, [resumeRoot, openProject]);

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
          pinnedPaths={pinnedPaths}
          reveal={reveal}
          onOpenFile={openFile}
          onActivateTab={requestOpenFile}
          onRequestCloseTab={requestCloseTab}
          onReorderTab={reorderTab}
          onTogglePin={toggleTabPin}
          onBatchCloseTab={runBatchClose}
          onSaveAll={saveAll}
          onDirtyChange={onDirtyChange}
          registerActions={registerActions}
          onClose={requestCloseProject}
          onReload={() => void openProject(project.rootDir, { keepView: true })}
          writable={writable ?? false}
          onReauth={requestReauth}
          guardFileOp={guardFileOp}
          onFilesGone={onFilesGone}
          registerTreeRefresh={registerTreeRefresh}
          extraRoots={extraRoots}
          onAddExtraRoot={() => void addExtraRoot()}
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
        resumeRoot={resumeRoot}
        onResumeSession={resumeSession}
        crashRecovery={crashRecovery}
        onRecoverCrash={recoverCrash}
        onDiscardCrash={discardCrash}
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
      {pendingProjectClose ? (
        <UnsavedFilesConfirmDialog paths={pendingProjectClose} onDecide={decideProjectClose} />
      ) : null}
    </>
  );
}
