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
import {errorText,  join } from '@kojo/plugin-api';
import { removeRecentOptimistic } from './WelcomeView';
import { invoke, isTauri } from '../bridge/invoke';
import { openExternal, tauriBridge } from '../bridge/tauri-bridge';
import { AutosaveJournal, HEARTBEAT_INTERVAL_MS, SNAPSHOT_DEBOUNCE_MS } from './autosave-journal';
import { journalIo } from './autosave-journal-io';
import {
  createSessionFlushScheduler,
  emptySessionRecord,
  loadSessionRecord,
  saveSessionRecord,
  sessionProjectOf,
  upsertSessionProject,
  type SessionFlushScheduler,
  type SessionRecord,
} from './session-store';
// 最近文件列表（MM-7）：欢迎页「最近文件」区的持久层与纯逻辑
import {
  loadRecentFiles,
  removeRecentFiles,
  saveRecentFiles,
  upsertRecentFile,
  type RecentFileRecord,
} from './recent-files';
import { clearRecoveredContents, recoveredPaths, setRecoveredContents } from './recovery-store';
import { planProjectSwitch, resolveProjectSwitch, type ProjectSwitchDecision } from './project-switch';
import { bootstrapKernel, ensureProjectPlugins, prefetchProjectPlugins } from '../bootstrap';
import { perf } from '../perf';
import { revealTargetOf, type RevealSpan, type RevealTarget } from '../monaco/reveal-position';
import {
  NOT_READY_MESSAGE,
  clearDropHover,
  copyDroppedFiles,
  dragDropImportHintMessage,
  dropTargetDirAt,
  dropHintText,
  importRequestedPayload,
  isProjectDetectionError,
  nextDropOverlay,
  notGameDirMessage,
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
// 常驻窗口框架（用户反馈第 9 条）：窗口永久无原生装饰，标题栏由 App 根部统一提供，
// 欢迎页 / 项目态 / 禅模式共用；浏览器 dev 里该组件返回 null（不画假按钮）。
import { WindowChrome } from './WindowChrome';
import { WelcomeView, type WelcomeTutorialId } from './WelcomeView';
import { DevNoteDialog } from './DevNoteDialog';
import { loadDevNoteSeen, markDevNoteSeen } from './dev-note-pref';
import { WelcomeOverlayHost } from './WelcomeOverlayHost';
import { WritableApprovalDialog } from './WritableApprovalDialog';
import { workspaceRootsOf, planAddExtraRoot } from './workspace-roots';
import { resetSearch } from './search-store';
import {
  applyPin,
  batchCloseEmptyReason,
  planBatchClose,
  planReorder,
  type BatchCloseMode,
} from './tabs-ops';
// 编辑器组态（SPLIT-1 分屏）：纯逻辑单源，App 是唯一状态所有者
import {
  activeGroupOf,
  closeTabsInGroup,
  initialEditorGroups,
  activateTab as activateTabInGroupState,
  openInActiveGroup,
  setActiveGroup as setFocusedGroup,
  splitActiveRight,
  closeGroup as closeEditorGroup,
  type EditorGroupsState,
} from './editor-groups';
// 导航历史（MM-6 前进/后退 + MM-10 恢复关闭的标签）：纯逻辑单源，App 是唯一状态所有者
import {
  createNavState,
  navBack as navBackInHistory,
  navForward as navForwardInHistory,
  popClosed,
  pushClosed,
  pushNav,
} from './navigation-history';
import { useShellOverlays } from './shell-overlays';
import {
  fileOpGuardMessage,
  pathGoneByDelete,
  reconcilePathsAfterDiskChange,
} from './disk-reconcile';
import type { EditorPaneActions } from './EditorPane';

/**
 * L1-A 首屏分割（2026-10-16 首屏批）：项目视图的静态链会把 monaco 全图（~1338 模块 /
 * 入口块 ~4.5 MB）拖进欢迎页关键路径——这里改按需 chunk。加载器独立成函数：
 * `React.lazy` 与 idle 预取**共用同一个 import promise**（浏览器模块缓存去重，
 * 预取完再进项目零等待）。
 *
 * PS-18（2026-10-18）：styles.css 拆「欢迎页轻档（main.tsx 静态链）/ 项目重档
 * styles-project.css（本函数动态链）」两档后，这里成为重档的**唯一加载点**，且顺序是
 * 硬约束：`styles-project.css`（全量样式表）必须先于 `market.css`（它对 `.mk-*` 有
 * 同特异性后来者胜的叠加）先于 `ProjectView` 模块求值——串行 await 保证 css 注入完成
 * 早于项目视图首帧，杜绝裸奔一帧。等价性判据（轻档 ⊆ 重档保序子序列 ⇒ 终态级联 ≡
 * 拆分前单文件）由 `packages/app/tests/styles-split.equivalence.test.ts` 钉死。
 */
const loadProjectView = (): Promise<{ default: typeof import('./ProjectView')['ProjectView'] }> =>
  import('../styles-project.css')
    .then(() => import('../market.css'))
    .then(() => import('./ProjectView'))
    .then((m) => ({ default: m.ProjectView }));
const ProjectView = lazy(loadProjectView);

/**
 * 欢迎页上"我要开项目"的两处意图面（PS-10 ③ 的预取闸门）：最近项目区（含每一行）与
 * 「继续上次会话」。选择器只认既有类名，`WelcomeView` 一字未改。
 */
const WELCOME_OPEN_INTENT_SELECTOR = '.welcome-recent, .welcome-resume';

/**
 * 无人点击时的兜底预取延迟（ms）。**上限被取证口径钉死**，不是随手数：
 * `tools/boot-probe.mjs` 的 `captureBootNetwork` 在采到 `boot.welcomeInteractive` 之后只等
 * `settleMs`（默认 4000ms，`smoke-tauri-dom` / `boot-marks` 都没另传）就切 Network 域读数，
 * 而它的**反空匹配自证**要求「可点之后必须真的看得到 monaco 请求」——兜底若晚于这个窗口，
 * 整轮 monaco 计数归零 ⇒ `judgeNetwork` 判 `unproven` ⇒ 断言②无法自证（假绿同罪）。
 * 下限则要远晚于"开机就点最近项目"的那一下（旧接线是空闲一帧就抢跑，正是被堵住的用户）。
 * 真点击走 `pointerdown` 意图触发，与本常量无关；这里只管"停在欢迎页不点"的兜底。
 */
const PREFETCH_FALLBACK_MS = 2_500;

/** 项目视图 chunk 装载期间的骨架（与内联引导层同构；idle 预取命中时基本见不到） */
function ProjectViewSkeleton(): ReactElement {
  return (
    <div className="boot-skeleton" aria-hidden="true">
      <div className="boot-skeleton-card">
        <div className="boot-skeleton-brand">kojo-editor</div>
        <div className="boot-skeleton-tip">正在装载工作区…</div>
        <div className="boot-bar" />
      </div>
    </div>
  );
}

export type AppPhase = 'boot' | 'welcome' | 'opening' | 'project';

/** 编辑器定位请求（来自校验面板 / 函数树等：内核事件 editor.revealLocation）；真源在 monaco 层 */
export type { RevealTarget } from '../monaco/reveal-position';

/**
 * 从脏态 / 固定态集合里剔掉 `gone` 里的全部路径（关标签的连带收尾）。
 * `closeManySync`（批量）与 `closeTabInGroup`（单张）共用这一份口径：两者都先过
 * **跨组门**（路径还在别的组里就不许端走），剩下的就是同一件事。
 * 没命中时返回**同一个引用**——不给 React 制造无谓的重渲染。
 */
function omitPaths(prev: ReadonlySet<string>, gone: ReadonlySet<string>): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const p of prev) {
    if (gone.has(p)) {
      next ??= new Set(prev);
      next.delete(p);
    }
  }
  return next ?? prev;
}

export function App(): ReactElement {
  const [kernel, setKernel] = useState<Kernel | null>(null);
  const [phase, setPhase] = useState<AppPhase>('boot');
  /**
   * 欢迎页是否被「×」关掉（用户反馈 8 批；只活在本会话）。关闭不改变 phase：
   * 有项目时本来就不渲染欢迎页，这里只管无项目分支显示欢迎页还是空态。
   */
  const [welcomeClosed, setWelcomeClosed] = useState(false);
  /**
   * 「开发者的碎碎念」纸条（用户反馈 2，2026-10-18）：初值直接问 localStorage——
   * 只有**从未看过**才为 true，于是"下载后第一次启动"自然只弹一次。关闭（Esc / 遮罩 /
   * ✕ / 两个按钮）写 seen 标记；只活在本会话，不参与 phase 判定。
   */
  const [devNoteOpen, setDevNoteOpen] = useState(() => !loadDevNoteSeen());
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<GameProject | null>(null);
  const [index, setIndex] = useState<ErbIndex | null>(null);
  const [indexing, setIndexing] = useState(false);
  /**
   * 编辑器组态（SPLIT-1 分屏）：**真源**。`activeFile` / `openTabs` 是焦点组的投影
   * （下方派生），既有单组语义（命令、检索面板、会话记录）全部读投影、写走组操作。
   */
  const [editorGroups, setEditorGroups] = useState<EditorGroupsState>(initialEditorGroups);
  const activeGroup = activeGroupOf(editorGroups);
  const activeFile = activeGroup.active;
  const openTabs = activeGroup.tabs;
  /** 组态快照（回调经 ref 读最新值，不吃陈旧闭包——同 openTabsRef 纪律） */
  const editorGroupsRef = useRef(editorGroups);
  editorGroupsRef.current = editorGroups;
  /**
   * 导航历史（MM-6 / MM-10）：**刻意不用 useState**——每次跳转/关标签都写一遍会把
   * 整棵壳树拖进重渲染，而它只被命令回调与关闭路径读写，没有任何渲染面消费。
   * 纯函数返回新 state 后由回调直接写回 ref（与 editorGroupsRef 同族的直接赋值模式）。
   */
  const navRef = useRef(createNavState());
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
  /** 待确认的切项目（SAFE-1）：非 null = 弹同款全项目确认，目标根暂存到决策回调 */
  const [pendingProjectSwitch, setPendingProjectSwitch] = useState<{ dir: string; paths: ReadonlySet<string> } | null>(null);
  /** Alt+F4 批准后：关项目完成即退出应用（窗口关闭意图延续，不走二次确认） */
  const exitAfterCloseRef = useRef(false);
  /** 关窗放行标志：确认框批准 + 关项目完成后置位，守卫对主动 close() 不拦（退出通道） */
  const windowCloseApprovedRef = useRef(false);
  const [reveal, setReveal] = useState<RevealTarget | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  /** 最近文件列表（MM-7）：欢迎页「最近文件」区数据源；落盘与读回见 recent-files.ts */
  const [recentFiles, setRecentFiles] = useState<RecentFileRecord[]>([]);
  /** 最新值快照（记录点不吃陈旧闭包；与 dirtyRef 同模式） */
  const recentFilesRef = useRef(recentFiles);
  recentFilesRef.current = recentFiles;
  const [pendingApproval, setPendingApproval] = useState<GameProject | null>(null);
  /** 写权限状态（P0）：null = 无项目；驱动状态栏徽章 + 保存置灰 */
  const [writable, setWritable] = useState<boolean | null>(null);
  /** 口上域索引构建失败原因（null = 成功/未构建）；驱动状态栏诊断与通知 */
  const [indexError, setIndexError] = useState<string | null>(null);
  /** OS 文件拖放的覆盖提示（状态机见 drag-drop.nextDropOverlay；over 刷屏必须幂等） */
  const [dropHint, setDropHint] = useState<DropOverlayState>('hidden');
  /** 通知中心（入口层 Provider 装配，App 自身也可发通知） */
  const notify = useNotify();
  /** 编辑器动作句柄（保存/保存指定/全部保存；EditorPane 按组注册——SPLIT-1 跨组归集） */
  const actionsByGroupRef = useRef(new Map<string, EditorPaneActions>());
  const registerActions = useCallback((groupId: string, a: EditorPaneActions | null) => {
    if (a) actionsByGroupRef.current.set(groupId, a);
    else actionsByGroupRef.current.delete(groupId);
  }, []);

  /* --------- 退出/崩溃守护（2026-10-16）：autosave 引擎 + 会话记录 + 恢复 --------- */

  /** 崩溃恢复待决（非 null = 欢迎页横幅：上次异常退出且有快照） */
  const [crashRecovery, setCrashRecovery] = useState<{ root: string; files: number } | null>(null);
  /** 欢迎页「继续上次会话」的目标根（最近一次打开的项目；随会话落盘更新） */
  const [resumeRoot, setResumeRoot] = useState<string | null>(null);
  /** 会话标签集的内存权威（落盘数据的投影；开项目时从它恢复） */
  const sessionRecordRef = useRef<SessionRecord>(emptySessionRecord());
  /**
   * 会话落盘防抖调度器（S2 #4）：稳态变更只 schedule（600ms 合并写盘），
   * 关项目 / kernel 更替 / 卸载收尾走 flushNow 同步落盘——防抖窗口里的
   * 最后一拍不再被清定时器丢掉了。write 面读写内存权威 ref，幂等由调度器保证。
   */
  const sessionFlushRef = useRef<SessionFlushScheduler | null>(null);
  if (sessionFlushRef.current === null) {
    sessionFlushRef.current = createSessionFlushScheduler({
      write: (p) => {
        const next = upsertSessionProject(sessionRecordRef.current, p.root, p);
        sessionRecordRef.current = next;
        setResumeRoot(next.lastRoot);
        void saveSessionRecord(p.kv, next).catch(() => undefined);
      },
    });
  }
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

  /** 脏标签集合的最新值快照（openProject 换根守卫 / 拖放落地 / 关窗守卫共用，不吃陈旧闭包） */
  const dirtyRef = useRef(dirtyPaths);
  dirtyRef.current = dirtyPaths;

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
        // 最近文件读回（MM-7）：欢迎页「最近文件」区。读不到就是空列表，静默
        loadRecentFiles(k.storage.global()).then(setRecentFiles).catch(() => undefined);
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
        setError(errorText(e));
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
  // 顺序是硬约束：**先记** `boot.welcomeInteractive`、**再排**预取——tools 的断言②
  // 以该标记为界判「欢迎页可点前的网络请求不含 monaco」，而这里两发预取都在标记之后才准起飞。
  const prefetched = useRef(false);
  /** 开项目时的撤防口（`openProject` 入口调用：真加载由 lazy / ensureProjectPlugins 自己拉） */
  const cancelPrefetchRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (!kernel || prefetched.current) return;
    prefetched.current = true;
    perf.bootMark('boot.welcomeInteractive', undefined, '自导航起点 ms；内核就绪 ⇒ 欢迎页主按钮可点（提交时刻）');

    /* PS-10 ③：预取从"空闲即抢跑"改成"**有意图才飞**"。
     *
     * 旧接线是 `requestIdleCallback(…, { timeout: 4000 })`——timeout 只是**上限**，
     * 第一个空闲帧就执行 ⇒ 开机 1–2s 就把 ProjectView（静态链上挂着 ~4 MB Monaco）连同
     * 项目级插件整块取回并**求值**，正好和用户最快那一下「继续上次会话」抢同一根主线程。
     * 推迟字节不等于推迟求值，所以这里把触发条件换成意图：
     *  - 首选＝最近项目区 / 「继续上次会话」上的第一次 `pointerdown`（此时取回+求值本来就是
     *    开项目的前置，并行预热只赚不亏）；
     *  - 兜底＝`PREFETCH_FALLBACK_MS` 内没人碰（读者停在欢迎页）才在空闲里补一发。
     *    这发兜底同时保住 boot-probe 断言②的反假绿自证——「整轮零 monaco 请求 = 匹配面可疑」，
     *    取证那一轮没有人点击，口径必须仍然看得到 monaco（窗口＝可点后 `settleMs` 4s，
     *    取值见上面那个常量的注释，别往后挪）。
     *  - 撤防＝`openProject` 一入口就取消：真开项目会自己拉这两块，抢跑没有意义。
     */
    let done = false;
    let fallbackTimer = 0;
    const disarm = (): void => {
      done = true;
      window.clearTimeout(fallbackTimer);
      window.removeEventListener('pointerdown', onPointer, true);
      cancelPrefetchRef.current = null;
    };
    const fire = (): void => {
      if (done) return;
      // 先到先得：意图触发或兜底触发都只执行一次，撤防后不再起飞
      disarm();
      // 预取尽力而为：失败不打扰（真加载失败由 lazy 的 Suspense 路径呈现）
      void loadProjectView().catch(() => undefined);
      void prefetchProjectPlugins().catch(() => undefined);
    };
    function onPointer(event: PointerEvent): void {
      const target = event.target as HTMLElement | null;
      if (typeof target?.closest === 'function' && target.closest(WELCOME_OPEN_INTENT_SELECTOR)) fire();
    }
    window.addEventListener('pointerdown', onPointer, true);
    fallbackTimer = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(fire, { timeout: 4000 });
      else fire();
    }, PREFETCH_FALLBACK_MS);
    cancelPrefetchRef.current = disarm;
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

  // 覆盖层 / 命令槽位的主机接线（diff · 文件历史 · 调用层级 · 操作历史）：整段只吃 kernel、
  // 依赖数组仍是 [kernel]——抽到 shell-overlays.ts 的自定义钩子，在同一位置无条件调用，
  // React 钩子次序不变。
  useShellOverlays(kernel);

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
      requestOpenFile(ev.filePath, ev.line ?? 1, ev.column, ev.span);
      // 同款记录（MM-7）：问题面板/转到定义/查找引用/函数树跳转来的打开也进最近文件
      recordRecentFile(ev.filePath);
    });
    return () => {
      un();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernel]);

  // 外链打开意图：插件够不着平台，跨层走总线（与 editor.revealLocation 同款分工）。
  // 闸（https + 主机白名单）的唯一执法点在 Rust，这里不复制白名单；被拒时 toast 一句
  // ——主机闸让失败面只剩"非白名单 URL"这种发起方就不该发出的输入，log 级静默不可接受
  // （铁律 4），但也不需要比 toast 更重的仪式。
  useEffect(() => {
    if (!kernel) return;
    const un = kernel.bus.on('ui.openExternal', (ev) => {
      void openExternal(ev.url).catch((e: unknown) => {
        notify({ kind: 'error', message: `外链打开被拒：${errorText(e)}` });
      });
    });
    return un;
  }, [kernel, notify]);

  // 当前文件广播（v0.3 批 S5-UI）：宿主是"当前打开哪个文件"的唯一权威，
  // 面板（如升糖建议器）需要它才知道该扫哪个文件。做成事件而非查询接口，
  // 免得面板为"知道变了"而持有宿主引用。
  useEffect(() => {
    if (!kernel) return;
    kernel.bus.emit('editor.activeFileChanged', { filePath: activeFile });
  }, [kernel, activeFile]);

  /** 旧项目的一套 UI 态整体带走：切项目与关项目共用，防旧标签/脏态/待确认残留到下一拍 */
  const resetProjectUiState = useCallback(() => {
    setEditorGroups(initialEditorGroups()); // 组态整体重置为单组空栈（SPLIT-1：分屏不跨项目存活）
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
    setEditorGroups((prev) => ({
      ...prev,
      groups: prev.groups.map((g) => (g.id === prev.activeGroupId ? { ...g, tabs, active } : g)),
    }));
    setPinnedPaths(pinned);
  }, []);

  const openProject = useCallback(
    async (
      dir: string,
      opts?: {
        keepView?: boolean;
        skipDirtyConfirm?: boolean;
        routeDetectionFailToImport?: boolean;
        /** MM-7：欢迎页「最近文件」跨项目点开——项目打开成功后接着开它（失败分支绝不打开） */
        pendingOpenFile?: string;
      },
    ) => {
      if (!kernel) return;
      // SAFE-1（2026-10-16）：换根开项目前先过脏确认——旧项目有未保存修改时，
      // recent 点击 / chooseAndOpen / 拖入新目录三条路收在这同一个决策口
      // （与 requestCloseProject 同款三选一），绝不随 EditorPane 卸载静默 dispose。
      // 确认回调续跑时带 skipDirtyConfirm 直进，不再二次弹框。
      const plan = planProjectSwitch(project?.rootDir ?? null, dir, dirtyRef.current, opts);
      if (plan.kind === 'confirm') {
        setPendingProjectSwitch({ dir, paths: plan.paths });
        return;
      }
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
        // PS-10 ②：17 个项目级插件在开项目这一刻才注册（欢迎页不需要它们的面板 / 命令 /
        // 状态栏贡献）。**必须赶在 open() 之前**：插件们挂在 `project.opened` 那一拍上，
        // 漏拍就是级联与快照少一家。指针意图已把这块预热过，这里通常只剩注册。
        // 顺带撤防预取（PS-10 ③）：真加载由下面的 lazy 与这里共同负责，抢跑没有意义。
        cancelPrefetchRef.current?.();
        await ensureProjectPlugins(kernel);
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
          // 同目录重开：标签保住（keepView），激活与定位清掉——清的是**每组**的激活
          // （多组都还在，激活态一并回空态，与单组时代语义一致）
          setEditorGroups((prev) => ({
            ...prev,
            groups: prev.groups.map((g) => ({ ...g, active: null })),
          }));
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
            setError(`写允许域注册失败（将只允许 appDataDir 写入）: ${errorText(e)}`);
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
          const msg = errorText(e);
          setIndexError(msg);
          notify({ kind: 'error', message: `口上域索引构建失败：${msg}` });
        }
        // MM-7：欢迎页「最近文件」跨项目点开的待开文件——项目完全就绪后才落进焦点组
        // （放在成功路径末尾：打开失败走下面的 catch，绝不顺带打开文件）
        if (opts?.pendingOpenFile) requestOpenFile(opts.pendingOpenFile);
      } catch (e: unknown) {
        if (isProjectDetectionError(e)) {
          // 检测失败（拖进来 / 打开的目录不是可识别的游戏目录）：内部英文术语绝不上屏。
          // 拖拽这条路径顺势引导去「导入项目」向导（emit 意图，adapter 消费后弹窗，
          // 用户选目标/改名才真正字节复制，不静默写盘）；其它入口只做人话化报错。
          const toImport = opts?.routeDetectionFailToImport === true;
          notify({
            kind: toImport ? 'info' : 'error',
            message: toImport ? dragDropImportHintMessage(dir) : notGameDirMessage(dir),
          });
          if (toImport) kernel.bus.emit('workspace.importRequested', importRequestedPayload(dir));
          setError(null);
        } else {
          const msg = errorText(e);
          setError(msg);
          // 打开失败必须显式可见：只落在 welcome 错误区容易被误读成「项目读不了」而无从下手
          notify({ kind: 'error', message: `打开项目失败：${msg}` });
        }
        // 内核 open() 失败不会关掉还活着的旧项目——留在项目态，别把用户踢回欢迎页
        setPhase(kernel.project.current() !== null ? 'project' : 'welcome');
      } finally {
        unMismatch();
        setIndexing(false);
      }
    },
    // requestOpenFile 不进依赖：它的 deps 链全空（commitOpenFile → []），引用恒稳定，
    // 闭包捕获不会 stale（且它声明在本函数之后，同步求值的依赖数组写不了它）
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
      const msg = errorText(e);
      notify({ kind: 'error', message: `添加文件夹失败：${msg}` });
    }
  }, [kernel, project, extraRoots, notify]);

  const chooseAndOpen = useCallback(async () => {
    try {
      // 泛化主入口（A2）：对话框不再预设「游戏目录」——选任意文件夹，适配器自动识别
      const dir = await invoke<string | null>('choose_directory', { title: '打开文件夹（自动识别游戏）' });
      if (dir) await openProject(dir);
    } catch (e: unknown) {
      setError(errorText(e));
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
        const msg = errorText(e);
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
        const msg = errorText(e);
        notify({ kind: 'error', message: `清除最近列表失败：${msg}` });
      },
    );
  }, [kernel, recent, notify]);

  /** 欢迎页失效标记的探测通道；内核未就绪时不会被取用（列表只在 kernelReady 后渲染） */
  const statPath = useCallback(
    (p: string): Promise<FileStat | null> => (kernel ? kernel.io.stat(p) : Promise.resolve(null)),
    [kernel],
  );

  const commitOpenFile = useCallback((path: string, line?: number, column?: number, span?: RevealSpan) => {
    setEditorGroups((prev) => openInActiveGroup(prev, path)); // SPLIT-1：开进焦点组
    // W9：区间一路带到编辑器（退化判据唯一住在 `revealTargetOf`，这里不许再折一次列）
    const target = line ? revealTargetOf({ line, column, span }, Date.now()) : null;
    setReveal(target);
    // MM-6：导航历史同拍入栈。行取本次 reveal 的落点行（没给行 = 第 1 行）；
    // rootDir 可能还是 null（欢迎页期的跳转）——照记，项目一出现按跨项目规则整段作废。
    navRef.current = pushNav(navRef.current, { path, line: target?.line ?? 1 }, rootDirRef.current);
  }, []);

  const requestOpenFile = useCallback(
    (path: string, line?: number, column?: number, span?: RevealSpan) => {
      // P3 多标签：切换标签不丢内容（model 留内存），无需未保存确认
      commitOpenFile(path, line, column, span);
    },
    [commitOpenFile],
  );

  /**
   * 最近文件记录（MM-7）：打开/跳转落地即记——欢迎页「最近文件」区的数据源。
   * rootDir 为 null（无项目态）记空串：欢迎页态不会走打开路径，实际记录不到
   * 这种；防御即可。
   */
  const recordRecentFile = useCallback(
    (path: string) => {
      const next = upsertRecentFile(recentFilesRef.current, {
        path,
        rootDir: rootDirRef.current ?? '',
        now: Date.now(),
      });
      recentFilesRef.current = next;
      setRecentFiles(next);
      if (kernel) void saveRecentFiles(kernel.storage.global(), next).catch(() => undefined);
    },
    [kernel],
  );

  /**
   * MM-7 欢迎页「最近文件」点击：同项目（根未变且项目开着）⇒ 直接开文件；
   * 换了项目 ⇒ 先开项目，pendingOpenFile 在 openProject 成功路径末尾落地
   * （打开失败绝不顺带打开文件）。
   */
  const openRecentFile = useCallback(
    (path: string, rootDir: string) => {
      if (rootDirRef.current === rootDir && project) {
        requestOpenFile(path);
        return;
      }
      void openProject(rootDir, { pendingOpenFile: path });
    },
    [project, openProject, requestOpenFile],
  );

  const openFile = useCallback(
    (path: string) => {
      requestOpenFile(path);
      recordRecentFile(path); // MM-7：文件树/快速打开的落地也进最近文件
    },
    [requestOpenFile, recordRecentFile],
  );

  const phaseRef = useRef<AppPhase>(phase);
  phaseRef.current = phase;

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
      // SPLIT-1：跨组归集——每组的动作句柄各自吐自己标签的快照
      const records = [...actionsByGroupRef.current.values()].flatMap((a) => a.snapshots());
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
          // SAFE-1：项目态换目录的脏确认收口在 openProject 换根守卫（不再这里拒切）
          currentProjectDir: rootDirRef.current,
          openFile: (p) => requestOpenFile(p),
          // 拖拽路径：检测失败顺势引导去「导入项目」向导（其它入口不开这个 opt，只人话化报错）
          openProject: (dir) => void openProject(dir, { routeDetectionFailToImport: true }),
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
   * 一次关掉多张干净标签（C1 批量关闭的地基；SPLIT-1 起落在**焦点组**内）：
   * 组态纯函数一次算清（过滤 + 组内激活落右邻/左邻 + 组空即收），激活变化才清定位。
   * 脏态/固定态的连带清理有**跨组门**：路径还被别的组引用着就保留（另一组还开着，
   * 脏点与 pin 不能端走）。
   */
  const closeManySync = useCallback((paths: readonly string[]) => {
    if (paths.length === 0) return;
    // MM-10：批量关闭整体入恢复栈（LIFO：批次里后关的先恢复；上限淘汰见纯逻辑）
    navRef.current = pushClosed(navRef.current, paths, rootDirRef.current);
    const prev = editorGroupsRef.current;
    const next = closeTabsInGroup(prev, prev.activeGroupId, paths);
    if (activeGroupOf(prev).active !== activeGroupOf(next).active) setReveal(null);
    setEditorGroups(next);
    const stillOpen = (p: string): boolean => next.groups.some((g) => g.tabs.includes(p));
    const gone = new Set(paths.filter((p) => !stillOpen(p)));
    if (gone.size === 0) return;
    setDirtyPaths((prevSet) => omitPaths(prevSet, gone));
    setPinnedPaths((prevSet) => omitPaths(prevSet, gone));
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

  /* ------------- 编辑器组交互入口（SPLIT-1 分屏；真源仍是本组件的组态） ------------- */

  /** 点某组的编辑器区域 = 焦点切到该组 */
  const activateGroup = useCallback((groupId: string) => {
    setEditorGroups((prev) => setFocusedGroup(prev, groupId));
  }, []);

  /** 点某组的标签 = 切到该组并激活该标签（activateTab 纯函数一并处理焦点转移） */
  const activateTabInGroup = useCallback((groupId: string, path: string) => {
    setEditorGroups((prev) => activateTabInGroupState(prev, groupId, path));
  }, []);

  /** 组内关标签：干净即关在该组；脏的先聚焦该组再走既有单标签确认链 */
  const closeTabInGroup = useCallback(
    (groupId: string, path: string) => {
      if (dirtyPaths.has(path)) {
        setEditorGroups((prev) => setFocusedGroup(prev, groupId));
        setPendingClose(path);
        return;
      }
      const prev = editorGroupsRef.current;
      const next = closeTabsInGroup(prev, groupId, [path]);
      if (activeGroupOf(prev).active !== activeGroupOf(next).active) setReveal(null);
      // MM-10：真正关掉这一刻入恢复栈（单张；批量路径走 closeManySync 同款压入）
      navRef.current = pushClosed(navRef.current, [path], rootDirRef.current);
      setEditorGroups(next);
      // 跨组门：路径还被别的组引用着就保留脏态/固定态（closeManySync 同款口径）
      if (next.groups.some((g) => g.tabs.includes(path))) return;
      const gone = new Set([path]);
      setDirtyPaths((prevSet) => omitPaths(prevSet, gone));
      setPinnedPaths((prevSet) => omitPaths(prevSet, gone));
    },
    [dirtyPaths],
  );

  /** 组内批量关闭：先聚焦该组，计划与确认链照旧走焦点组 */
  const batchCloseInGroup = useCallback(
    (groupId: string, mode: BatchCloseMode, anchor: string) => {
      const prev = editorGroupsRef.current;
      const g = prev.groups.find((x) => x.id === groupId);
      if (!g) return;
      if (prev.activeGroupId !== groupId) setEditorGroups(setFocusedGroup(prev, groupId));
      const plan = planBatchClose(mode, g.tabs, anchor, pinnedRef.current);
      if (plan.toClose.length === 0) {
        notify({ kind: 'info', message: batchCloseEmptyReason(mode, g.tabs, anchor, pinnedRef.current) });
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

  /** 向右拆分（VSCode 同款：新组携带焦点组激活标签，焦点跟到新组） */
  const splitEditor = useCallback(() => {
    setEditorGroups((prev) => splitActiveRight(prev));
  }, []);

  /**
   * 关组（唯一组不关——closeGroup 纯函数里已原样返回）。
   * 关门前必须先过脏门：组内若有任何脏标签，走逐标签确认批量关闭（脏的弹确认、
   * 干净的即关，全空后整组由 closeTabsInGroup 自动回收）——直接 closeEditorGroup
   * 会静默 dispose 组内脏 model（与关窗守卫同一「绝不静默丢修改」铁律）。
   * 无脏时维持原语义整组直接收（含固定标签，无数据可丢）。
   */
  const closeGroupById = useCallback((groupId: string) => {
    const prev = editorGroupsRef.current;
    const g = prev.groups.find((x) => x.id === groupId);
    if (g && g.tabs.some((p) => dirtyRef.current.has(p))) {
      batchCloseInGroup(groupId, 'all', g.active ?? g.tabs[0]!);
      return;
    }
    setEditorGroups(closeEditorGroup(prev, groupId));
  }, [batchCloseInGroup]);

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
        // SPLIT-1：路径可能开在任一组——逐组问，谁持有谁保存（不含该路径的组返回 false）
        let ok = false;
        for (const a of actionsByGroupRef.current.values()) {
          if (await a.savePath(path)) {
            ok = true;
            break;
          }
        }
        if (!ok) return; // 保存失败：标签保留（错误已显示在编辑器状态栏/通知）
      }
      doCloseTab(path);
      advanceBatch(); // 批量关闭中：继续推进队列（无队列时 no-op）
    },
    [pendingClose, doCloseTab, advanceBatch],
  );

  /**
   * 后退（MM-6，Alt+←）：导航栈光标前移，落地走 commitOpenFile——它同拍 pushNav，
   * 而目标条目正是光标新驻地，去重规则下栈不涨、光标不漂（back/forward 不污染历史）。
   * 到栈底 ⇒ 人话拒绝（铁律 4：按了必须有反应，不静默）。
   */
  const navBack = useCallback(() => {
    const moved = navBackInHistory(navRef.current);
    if (!moved.entry) {
      notify({ kind: 'info', message: '已经后退到最早的位置了' });
      return;
    }
    navRef.current = moved.state;
    commitOpenFile(moved.entry.path, moved.entry.line);
  }, [commitOpenFile, notify]);

  /** 前进（MM-6，Alt+→）：光标后移；到栈顶 ⇒ 人话拒绝（同 navBack 的铁律） */
  const navForward = useCallback(() => {
    const moved = navForwardInHistory(navRef.current);
    if (!moved.entry) {
      notify({ kind: 'info', message: '已经前进到最新的位置了' });
      return;
    }
    navRef.current = moved.state;
    commitOpenFile(moved.entry.path, moved.entry.line);
  }, [commitOpenFile, notify]);

  /**
   * 恢复最近关闭的标签（MM-10，Ctrl+Shift+T）：恢复栈栈顶弹一张，开进当前焦点组并激活
   * （openInActiveGroup 对已存在的 tab 只激活——天然幂等，重复恢复不会开出第二张）。
   * 空栈 ⇒ 人话拒绝（同款铁律）。
   */
  const reopenClosedTab = useCallback(() => {
    const popped = popClosed(navRef.current);
    if (popped.path === null) {
      notify({ kind: 'info', message: '没有可恢复的标签' });
      return;
    }
    navRef.current = popped.state;
    commitOpenFile(popped.path);
  }, [commitOpenFile, notify]);

  /**
   * 拖拽重排标签（C2；删除后插入语义：toIndex 以移除 path 之后的数组为基准）。
   * 跨固定区分界的拖放自动改固定态（planReorder：非固定拖进固定区 = pin，
   * 固定拖出 = unpin——落点指示画哪标签落哪，所见即所得）。
   */
  const reorderTabInGroup = useCallback((groupId: string, path: string, toIndex: number) => {
    const g = editorGroupsRef.current.groups.find((x) => x.id === groupId);
    if (!g) return;
    const plan = planReorder(g.tabs, path, toIndex, pinnedRef.current);
    setEditorGroups((prev) => ({
      ...prev,
      groups: prev.groups.map((x) => (x.id === groupId ? { ...x, tabs: plan.order } : x)),
    }));
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

  /** 全部保存（Ctrl+Shift+S；壳层命令经 ProjectView 注入；SPLIT-1 起跨组逐组保存） */
  const saveAll = useCallback(async (): Promise<boolean> => {
    for (const a of actionsByGroupRef.current.values()) {
      if (!(await a.saveAll())) return false;
    }
    return true;
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
  // S2 #4：schedule 即快照（此刻读 ref 拿最新），计时器到点与关项目强刷都只吃快照，
  // 不再回读被 resetProjectUiState 清空的现场标签态。
  useEffect(() => {
    if (!kernel || !project) return;
    sessionFlushRef.current?.schedule({
      root: project.rootDir,
      kv: kernel.storage.global(),
      tabs: openTabsRef.current,
      active: activeFileRef.current,
      pinned: [...pinnedRef.current],
    });
  }, [kernel, project, openTabs, activeFile, pinnedPaths]);

  // 项目拆除（project→null / 换项目 / kernel 更替 / 组件卸载）：防抖窗口里还没
  // 到点的待写必须同步落盘，只清定时器会把最后一拍（首开时甚至整条记录）丢掉。
  // layout 相保证这步在 commit 内同步发生；无待写时 flushNow 是 no-op，绝不双写。
  useLayoutEffect(() => {
    return () => {
      sessionFlushRef.current?.flushNow();
    };
  }, [kernel, project]);

  /** 固定 / 取消固定标签（C2）：pinned 会话态 + 顺序重排（固定区在前，见 applyPin） */
  const togglePinInGroup = useCallback((groupId: string, path: string) => {
    const wasPinned = pinnedRef.current.has(path);
    const nextPinned = new Set(pinnedRef.current);
    if (wasPinned) nextPinned.delete(path);
    else nextPinned.add(path);
    pinnedRef.current = nextPinned; // 同一拍内的连续操作读得到最新值
    setPinnedPaths(nextPinned);
    setEditorGroups((prev) => ({
      ...prev,
      groups: prev.groups.map((g) =>
        g.id === groupId ? { ...g, tabs: applyPin(g.tabs, path, !wasPinned, nextPinned) } : g,
      ),
    }));
  }, []);

  /**
   * 删除/重命名的守门：涉及**打开中且有未保存修改**的文件就拦下，给一句人话。
   * 目录同样拦——脏文件在被删目录之下时，"删目录"会把它一起带走（递归删除是大刀）。
   * 判定住在 `disk-reconcile.fileOpGuardMessage`（与测试同一份口径）。
   */
  const guardFileOp = useCallback(
    (paths: readonly string[]): string | null => fileOpGuardMessage(paths, dirtyPaths),
    [dirtyPaths],
  );

  /**
   * 盘上操作落地后的标签收尾：被删的关标签（只可能是干净标签——脏的已被守门拦下）、
   * 被改名的换路径；激活文件随之切换到邻居或换新路径。
   */
  const onFilesGone = useCallback(
    (deleted: readonly string[], renamed: ReadonlyArray<{ from: string; to: string }>) => {
      const del = [...deleted];
      // SPLIT-1：盘上事实变了，**每一组**里开着的这份都得收尾（先按组关删、再全组换名）
      const prevGroups = editorGroupsRef.current;
      let nextGroups = prevGroups;
      for (const g of prevGroups.groups) {
        const gone = new Set(g.tabs.filter((p) => pathGoneByDelete(del, p)));
        if (gone.size > 0) nextGroups = closeTabsInGroup(nextGroups, g.id, [...gone]);
      }
      const renameMap = new Map(renamed.map((r) => [r.from, r.to] as const));
      nextGroups = {
        ...nextGroups,
        groups: nextGroups.groups.map((g) => ({
          ...g,
          tabs: g.tabs.map((t) => renameMap.get(t) ?? t),
          active: g.active ? (renameMap.get(g.active) ?? g.active) : null,
        })),
      };
      if (activeGroupOf(prevGroups).active !== activeGroupOf(nextGroups).active) setReveal(null);
      setEditorGroups(nextGroups);
      // 脏态与固定态收尾同一份口径（被删的含子路径退出、被改名的换新路径）：
      // 固定标签不留悬空 pin（C2）
      setDirtyPaths((prev) => reconcilePathsAfterDiskChange(prev, del, renamed));
      setPinnedPaths((prev) => reconcilePathsAfterDiskChange(prev, del, renamed));
      // 最近文件摘除（MM-7）：被删的与被改名的旧路径从欢迎页列表移除并落盘
      // （真有变化才写：无变化不惊动渲染与存储）
      const gonePaths = [...del, ...renamed.map((r) => r.from)];
      const nextRecentFiles = removeRecentFiles(recentFilesRef.current, gonePaths);
      if (nextRecentFiles.length !== recentFilesRef.current.length) {
        recentFilesRef.current = nextRecentFiles;
        setRecentFiles(nextRecentFiles);
        if (kernel) void saveRecentFiles(kernel.storage.global(), nextRecentFiles).catch(() => undefined);
      }
    },
    [kernel],
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
        setError(`写允许域清除失败: ${errorText(e)}`);
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
        const msg = errorText(e);
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
        const ok = await saveAll();
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
        // 用 finally 复位：若 close() 未真正终结进程（末窗策略拦截 / 异常返回），
        // 标志会一直为 true ⇒ 关窗守卫对本会话剩余时间永久失效、脏修改再无提示。
        // close() 成功终结进程时 finally 不再执行，无副作用。
        windowCloseApprovedRef.current = true;
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          await getCurrentWindow().close();
        } finally {
          windowCloseApprovedRef.current = false;
        }
      }
    },
    [pendingProjectClose, closeProject],
  );

  /**
   * 切项目确认的落地（SAFE-1）：三选一与 decideProjectClose 同款分流——
   * 取消 / 保存失败留在原地；保存成功与明确丢弃都先走 journal 强制 discard
   * （刚存完的陈旧快照、用户明确不要的内容，都不能再被崩溃恢复端回来），
   * 再带 skipDirtyConfirm 续跑 openProject。
   */
  const decideProjectSwitch = useCallback(
    async (action: 'save-then-close' | 'discard' | 'cancel') => {
      const pending = pendingProjectSwitch;
      setPendingProjectSwitch(null);
      if (!pending) return;
      // 对话框的动作字面量与关项目共用一套（save-then-close），归一到切换语义
      const decision: ProjectSwitchDecision = action === 'save-then-close' ? 'save-then-go' : action;
      // SPLIT-1 遗留红：`actionsRef` 已更名 `actionsByGroupRef`，此处改走跨组收口的 saveAll 本体
      const saveOk = decision === 'save-then-go' ? await saveAll() : true;
      if (resolveProjectSwitch(decision, saveOk).kind === 'stay') return;
      try {
        await autosaveRef.current?.discard();
      } catch {
        // 清理失败不拦切项目（与 decideProjectClose 同口径）
      }
      await openProject(pending.dir, { skipDirtyConfirm: true });
    },
    [pendingProjectSwitch, openProject, saveAll],
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

  /**
   * 欢迎页教程卡片（用户反馈 8 批）：只发语义意图 `ui.tutorial.open`，
   * 由教程提供方（适配器）映射到自己的 overlay。宿主不认识教程内容，也不在这里
   * 直接 `ui.overlay.open`（那会把提供方的模态名抄进欢迎页）。
   */
  const openWelcomeTutorial = useCallback(
    (tutorial: WelcomeTutorialId): void => {
      kernel?.bus.emit('ui.tutorial.open', { tutorial, source: 'welcome' });
    },
    [kernel],
  );

  /** 纸条的关闭出口：先写 seen 标记再收（写不进也不影响"本次会话只弹一次"） */
  const closeDevNote = useCallback((): void => {
    markDevNoteSeen();
    setDevNoteOpen(false);
  }, []);

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
          groups={editorGroups.groups}
          activeGroupId={editorGroups.activeGroupId}
          dirtyPaths={dirtyPaths}
          pinnedPaths={pinnedPaths}
          reveal={reveal}
          onOpenFile={openFile}
          onRequestCloseTab={requestCloseTab}
          onActivateGroup={activateGroup}
          onActivateTabInGroup={activateTabInGroup}
          onRequestCloseTabInGroup={closeTabInGroup}
          onReorderTabInGroup={reorderTabInGroup}
          onTogglePinInGroup={togglePinInGroup}
          onBatchCloseTabInGroup={batchCloseInGroup}
          onSplitEditor={splitEditor}
          onCloseGroup={closeGroupById}
          onNavBack={navBack}
          onNavForward={navForward}
          onReopenClosedTab={reopenClosedTab}
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
      <>
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
          recentFiles={recentFiles}
          onOpenRecentFile={openRecentFile}
          statPath={statPath}
          resumeRoot={resumeRoot}
          onResumeSession={resumeSession}
          crashRecovery={crashRecovery}
          onRecoverCrash={recoverCrash}
          onDiscardCrash={discardCrash}
          closed={welcomeClosed}
          onClose={() => setWelcomeClosed(true)}
          onReopen={() => setWelcomeClosed(false)}
          onOpenTutorial={openWelcomeTutorial}
        />
        {/* 无项目时的 overlay 宿主：教程等模态由插件常驻注册，宿主却只在 ShellLayout 里，
            这里补上同一份壳（打开/关闭订阅与 ShellLayout 同语义），教程才真的看得见 */}
        <WelcomeOverlayHost kernel={kernel} />
      </>
    );

  // 窗口框架常驻：标题栏在 App 根部（不在 ShellLayout 里），欢迎页没有项目时也有；
  // 正文与所有 fixed overlay 收进 `.app-frame-body`（flex:1; min-height:0），
  // `.welcome` / `.shell` 的 100% 高度由这块确定高度的 flex 舞台承接。
  return (
    <div className="app-frame">
      <WindowChrome />
      <div className="app-frame-body">
        {body}
        {/* 首启动纸条（用户反馈 2）：只在欢迎页弹（进了项目就不打扰），且只在从未看过时。
            「去绑定游戏根目录」先收纸条再走欢迎页那个同一个目录选择入口。 */}
        {devNoteOpen && phase === 'welcome' ? (
          <DevNoteDialog
            onClose={closeDevNote}
            onOpenDirectory={() => {
              closeDevNote();
              void chooseAndOpen();
            }}
          />
        ) : null}
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
        {pendingProjectSwitch ? (
          <UnsavedFilesConfirmDialog context="switch" paths={pendingProjectSwitch.paths} onDecide={decideProjectSwitch} />
        ) : null}
      </div>
    </div>
  );
}
