import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { Kernel } from '@kojo/kernel';
import type { ErbIndex, ErbParserService, GameProject, RecentProject } from '@kojo/plugin-api';
import { errorText } from '@kojo/plugin-api';
import { ensureProjectPlugins } from '../bootstrap';
import { invoke, isTauri } from '../bridge/invoke';
import type { RevealTarget } from '../monaco/reveal-position';
import type { AppPhase } from './App';
import {
  adapterConflictMessage,
  dragDropImportHintMessage,
  importRequestedPayload,
  isAdapterConflictError,
  isProjectDetectionError,
  notGameDirMessage,
} from './drag-drop';
import {
  alignSplitSizes,
  restoreGroups,
  serializeGroups,
  type EditorGroupsState,
} from './editor-groups';
import { reportDictionaryStatus, variableSchemaFor } from './dictionary-notice-ledger';
import type { Notify } from './NotificationCenter';
import { closeProjectSession } from './project-close';
import { planProjectSwitch } from './project-switch';
import { recoveredPaths } from './recovery-store';
import { resetSearch } from './search-store';
import {
  createSessionFlushScheduler,
  emptySessionRecord,
  planSessionRestore,
  probeExistingPaths,
  sanitizeExtraRoots,
  saveSessionRecord,
  sessionProjectOf,
  upsertSessionProject,
  type SessionFlushScheduler,
  type SessionRecord,
} from './session-store';
import { useWorkspaceFolders } from './use-workspace-folders';
import { watchRootsOf } from './workspace-folders';
import type { ProjectErrorAction } from './project-error-notice';
import {
  admitProjectWriteDomain,
  getSessionWriteDomainFact,
  initialWriteDomainFact,
  isProjectWritableOf,
  redeliverProjectWriteDomain,
  setSessionWriteDomainFact,
  writeDomainFixAction,
  writeDomainRefusedMessage,
  type WriteDomainAdmission,
} from './write-domain';

/**
 * 项目会话生命周期（REF-FRONT-PERF，2026-10-20）。
 *
 * App 只留 UI state 与渲染；打开 / 关闭 / 写允许域 / 审批 / 会话落盘搬到这里。
 * **行为、effect 顺序、ref 语义逐字保持**：本文件里的函数体是从 App.tsx 原位搬来的，
 * 依赖数组、ref 直读、清理顺序都没有改。唯一的结构变化是把「谁来调用」换成宿主注入。
 *
 * 刻意**没有**搬的东西（拿不准就不硬搬，见交付回执）：
 * - `decideProjectClose` / `decideProjectSwitch`：它们编排保存确认框、退出放行标志与
 *   窗口 close，属于 App 的交互流程，不是项目会话本身；
 * - `recoverCrash` / `resumeSession` / `discardCrash`：欢迎页入口，留在 App；
 * - 会话 flush 的**触发位置**：`useSessionFlush` 必须仍在 App 原来那两个 effect 的位置
 *   调用（效果次序不变）；本文件只提供实现。
 * - 布局变化是否落盘：**WS-06 起已改**——方向 / 焦点组 / 组结构 / 分屏比例 / 附加根
 *   任一变化都会 schedule（签名与 payload 见 `useSessionFlush`），不再"只在标签变化时顺带带"。
 */

/** React ref 的最小形状（避免把 React 类型扩散到参数面） */
export interface RefLike<T> {
  current: T;
}

/**
 * 把项目根交给宿主登记（准入门在 Rust 侧：只有对话框 / 拖放亲自交付过的目录才放行）。
 * 拒 = reject ⇒ 由 `write-domain.ts` 折成「这一趟没交付成功」的事实，绝不当成"能写"。
 */
function registerWriteDomainRoot(root: string): Promise<void> {
  return invoke('register_write_domain', { root }).then(() => undefined);
}

/** 原生选目录框（对话框即授权，铁律 6 的既有通道；这里不新增任何接受路径参数的命令） */
function chooseDirectoryFor(title: string): Promise<string | null> {
  return invoke<string | null>('choose_directory', { title });
}

export interface OpenProjectOptions {
  keepView?: boolean;
  skipDirtyConfirm?: boolean;
  routeDetectionFailToImport?: boolean;
  /** MM-7：欢迎页「最近文件」跨项目点开——项目打开成功后接着开它（失败分支绝不打开） */
  pendingOpenFile?: string;
}

/**
 * App 注入的项目会话宿主事实。绝大多数是 useState setter（引用恒稳定），
 * 少数是 ref 与回调——原 App 里的依赖数组因此可以逐字保留。
 */
export interface ProjectSessionHost {
  readonly kernel: Kernel | null;
  readonly project: GameProject | null;
  readonly dirtyRef: RefLike<ReadonlySet<string>>;
  readonly extraRoots: readonly string[];
  readonly notify: Notify;
  readonly cancelPrefetchRef: RefLike<(() => void) | null>;
  /** requestOpenFile 在 App 里声明得更晚；经 ref 取最新（它 deps 为空、引用恒稳定） */
  readonly requestOpenFileRef: RefLike<((path: string) => void) | null>;
  readonly resetProjectUiState: () => void;
  readonly sessionRecordRef: RefLike<SessionRecord>;
  /** 崩溃恢复意图（欢迎页点「恢复」置位；openProject 消费一次即清零） */
  readonly pendingRecoverRef: RefLike<boolean>;

  readonly setPhase: (phase: AppPhase) => void;
  readonly setError: (error: string | null) => void;
  /**
   * 上报一条项目态错误（同文案不重复刷屏）。
   * 第二枚 `action` 是 additive 的出路（WRITE-ADMIT-SPLIT 出路①）：这条错误能走哪条路回去
   * 与文案同生同灭；旧调用方只递 message，照旧是一条没有按钮的错误条。
   */
  readonly raiseError: (message: string, action?: ProjectErrorAction | null) => void;
  readonly setProject: (project: GameProject | null) => void;
  readonly setIndex: (index: ErbIndex | null) => void;
  readonly setIndexing: (indexing: boolean) => void;
  readonly setIndexError: (error: string | null) => void;
  readonly setWritable: (writable: boolean | null) => void;
  readonly setRecent: (recent: RecentProject[]) => void;
  readonly setPendingApproval: (project: GameProject | null) => void;
  readonly setPendingProjectSwitch: (pending: { dir: string; paths: ReadonlySet<string> } | null) => void;
  readonly setEditorGroups: Dispatch<SetStateAction<EditorGroupsState>>;
  readonly setPinnedPaths: Dispatch<SetStateAction<ReadonlySet<string>>>;
  /**
   * 分屏比例（WS-06）：恢复会话时由本 hook 一并写回（与组态同源、同一拍提交，
   * 免得 App 的对齐副作用把恢复出来的比例当"长度不符"重置成均分）。
   */
  readonly setSplitSizes: Dispatch<SetStateAction<readonly number[]>>;
  /** 会话级附加根（WS-08）：项目打开时按记录恢复，独立于标签恢复 */
  readonly setExtraRoots: Dispatch<SetStateAction<readonly string[]>>;
  readonly setReveal: (reveal: RevealTarget | null) => void;
  readonly pendingApproval: GameProject | null;
}

export interface ProjectSession {
  readonly openProject: (dir: string, opts?: OpenProjectOptions) => Promise<void>;
  readonly closeProject: () => Promise<void>;
  readonly decideApproval: (allow: boolean) => Promise<void>;
  readonly requestReauth: () => void;
}

/**
 * 会话标签集装回（退出/崩溃守护批 + MM-9 组态持久化 + WS-06 盘上校验）。
 * 原注释见 App.tsx 历史：恢复件追加在尾部并激活第一个恢复件；pinned 与 tabs 取交集；
 * 无记录且无恢复件 = 保持空，绝不凭空造标签。`groups` 合法则整态换成恢复出的组态，
 * 再贴标签集。
 *
 * WS-06 的补丁：**不再直接信任记录**——记录可能比盘上事实旧（文件被删/移动）。
 * 合并后的标签逐条过 `kernel.io.exists`（有界并发），缺失的剔除、剔除数量给一句
 * 可见说明；布局/orientation 仍照恢复（只要还剩标签）。判据全部住在
 * `session-restore.ts` 的纯函数里（`planSessionRestore` / `probeExistingPaths`），
 * 本 hook 只负责"取记录 → 探盘 → 落状态 → 出声"。
 */
function useRestoreSessionTabs(
  kernel: Kernel | null,
  sessionRecordRef: RefLike<SessionRecord>,
  notify: Notify,
  setEditorGroups: Dispatch<SetStateAction<EditorGroupsState>>,
  setPinnedPaths: Dispatch<SetStateAction<ReadonlySet<string>>>,
  setSplitSizes: Dispatch<SetStateAction<readonly number[]>>,
): (dir: string, recovered: readonly string[]) => Promise<void> {
  return useCallback(
    async (dir: string, recovered: readonly string[]) => {
      const rec = sessionProjectOf(sessionRecordRef.current, dir);
      const restored = rec?.groups !== undefined ? restoreGroups(rec.groups) : null;
      const tabs = [...(rec?.tabs ?? [])];
      for (const p of recovered) if (!tabs.includes(p)) tabs.push(p);
      if (tabs.length === 0) return;
      // 探盘：记录标签 ∪ 组态快照里的标签（多组时两者不一定相等），有界并发
      const candidates = [...new Set([...tabs, ...(restored?.groups.flatMap((g) => g.tabs) ?? [])])];
      const exists = kernel ? (p: string) => kernel.io.exists(p) : async () => true;
      const alive = await probeExistingPaths(candidates, exists);
      const plan = planSessionRestore({
        tabs: rec?.tabs ?? [],
        active: rec?.active ?? null,
        pinned: rec?.pinned ?? [],
        groups: restored,
        recovered,
        exists: (p) => alive.has(p),
      });
      if (plan.note !== null) notify({ kind: 'info', message: plan.note });
      if (plan.focusTabs.length === 0) return; // 全缺：维持空会话（不恢复空壳组）
      setEditorGroups((prev) => {
        const base = plan.groups ?? prev;
        return {
          ...base,
          groups: base.groups.map((g) =>
            g.id === base.activeGroupId ? { ...g, tabs: plan.focusTabs, active: plan.active } : g,
          ),
        };
      });
      setPinnedPaths(new Set(plan.pinned));
      // 分屏比例（WS-06）：与 groups 快照同源；长度对不上由 alignSplitSizes 兜成均分
      if (plan.groups !== null) setSplitSizes(alignSplitSizes(rec?.splitSizes, plan.groups.groups.length));
      else setSplitSizes([]);
    },
    // 与搬迁前同口径：ref 与 useState setter 都稳定，回调身份恒定（kernel/notify 同源）
    [kernel, notify, setEditorGroups, setPinnedPaths, setSplitSizes],
  );
}

/** 打开项目（含换根守卫 / 插件注册 / 写允许域 / 审批 / 索引 / 会话恢复） */
export function useProjectSession(host: ProjectSessionHost): ProjectSession {
  const {
    kernel,
    project,
    dirtyRef,
    extraRoots,
    notify,
    cancelPrefetchRef,
    requestOpenFileRef,
    resetProjectUiState,
    sessionRecordRef,
    pendingRecoverRef,
    setPhase,
    setError,
    raiseError,
    setProject,
    setIndex,
    setIndexing,
    setIndexError,
    setWritable,
    setRecent,
    setPendingApproval,
    setPendingProjectSwitch,
    setEditorGroups,
    setPinnedPaths,
    setSplitSizes,
    setExtraRoots,
    setReveal,
    pendingApproval,
  } = host;

  const restoreSessionTabs = useRestoreSessionTabs(
    kernel,
    sessionRecordRef,
    notify,
    setEditorGroups,
    setPinnedPaths,
    setSplitSizes,
  );

  /**
   * 宿主这一半边的写域事实（WRITE-ADMIT-SPLIT 出路①）：`{dir, grant, reason}`。
   * 「这个项目能不能直接编辑」从此要**同时**吃 TS 批准记录与这一份——以前只看前者，
   * 于是注册被准入门拒了、下面那行 `setWritable(approved !== null)` 仍把 UI 翻成"能编辑"。
   * SAVE-BUTTON-IO-SEAM（出路②）：这份事实的**存储本体**住在 `write-domain.ts` 的会话单例
   * （`setSessionWriteDomainFact` / `getSessionWriteDomainFact`）。写方仍然只有本 hook
   *（开项目 / 重新交付 / 关项目复位这三处，一次都不许多）；读方多了每个文件那颗保存按钮
   * （EditorPane 现读同一份 ⇒ 宿主拒过时置灰），没有第二份真源，也不新造第三套可写态。
   */
  /** 出路动作可能长期挂在错误条上：run 走 ref，按钮永远叫得响当前这份实现（同 App 的 onReauthRef 手法） */
  const redeliverRef = useRef<() => void>(() => undefined);

  /** 一次写域交付的落地：会话事实 + 错误条（含出路）+ 可写态，三者只从这一处写 */
  const applyWriteDomainAdmission = useCallback(
    (admission: WriteDomainAdmission) => {
      setSessionWriteDomainFact(admission.fact);
      if (admission.error === null) setError(null);
      else raiseError(admission.error.message, admission.error.action);
      setWritable(admission.writable);
    },
    [raiseError, setError, setWritable],
  );

  /**
   * 错误条上那颗「重新选择这个文件夹」的执行体：走一次原生选目录框把这个项目文件夹
   * **重新交付**给宿主（对话框即授权，铁律 6 的既有形态——不新造授权路、不放宽写域），
   * 成功后错误条消失、可写态按两份事实重新对齐；取消则什么都不变。
   */
  const redeliverWriteDomain = useCallback(async () => {
    const dir = getSessionWriteDomainFact().dir;
    if (!kernel || dir === null || !isTauri()) return;
    const admission = await redeliverProjectWriteDomain({
      dir,
      chooseDirectory: chooseDirectoryFor,
      register: registerWriteDomainRoot,
      hasApprovalRecord: async () => (await kernel.project.approvedWritableFor(dir)) !== null,
      // 不一致事件只在 open() 期间同步发出，这一趟没有新事件可吃 ⇒ 按无冲突算
      approvalMismatch: false,
      redeliver: () => redeliverRef.current(),
    });
    if (admission === null) return; // 作者取消：现场一切不变
    applyWriteDomainAdmission(admission);
    if (admission.needsApproval) {
      const current = kernel.project.current();
      if (current) setPendingApproval(current);
    }
  }, [applyWriteDomainAdmission, kernel, setPendingApproval]);
  redeliverRef.current = () => void redeliverWriteDomain();

  const openProject = useCallback(
    async (dir: string, opts?: OpenProjectOptions) => {
      if (!kernel) return;
      // SAFE-1（2026-10-16）：换根开项目前先过脏确认——旧项目有未保存修改时，
      // recent 点击 / chooseAndOpen / 拖入新目录三条路收在这同一个决策口
      //（与 requestCloseProject 同款三选一），绝不随 EditorPane 卸载静默 dispose。
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
      // 换项目 / 重开都从"宿主还没表态"起算：上一次交付结果不许踩进这一趟
      setSessionWriteDomainFact(initialWriteDomainFact);
      // 静默只读修复（P0）：不一致事件只在 open() 期间同步发出——局部订阅，
      // 避免常驻监听与 openProject 状态写入之间的竞态
      let approvalMismatch = false;
      const unMismatch = kernel.bus.on('project.writableApprovalMismatch', () => {
        approvalMismatch = true;
      });
      try {
        // PS-10 ②：18 个项目级插件在开项目这一刻才注册（欢迎页不需要它们的面板 / 命令 /
        // 状态栏贡献）。**必须赶在 open() 之前**：插件们挂在 `project.opened` 那一拍上，
        // 漏拍就是级联与快照少一家。指针意图已把这块预热过，这里通常只剩注册。
        // 顺带撤防预取（PS-10 ③）：真加载由下面的 lazy 与这里共同负责，抢跑没有意义。
        cancelPrefetchRef.current?.();
        await ensureProjectPlugins(kernel);
        const p = await kernel.project.open(dir);
        /**
         * TW-DICT-VISIBLE：`project.open()` 返回即 `loadProject` 已把变量字典填好（`project.opened`
         * 就在返回前发出）⇒ 这里是"schema 就绪"的确定时机。词典缺席 / 读失败 ⇒ 一条中文 toast，
         * 同会话同项目同一种失败只说一遍（台账在 `dictionary-notice-ledger.ts`，文案也只住那一侧）。
         * `dictionary` 缺省（实现没陈述）⇒ 不出声——不得把"没陈述"当失败。
         */
        reportDictionaryStatus(notify, p.rootDir, variableSchemaFor(kernel, p.adapterId));
        setProject(p);
        // 换项目（欢迎页首开 / 拖入新目录）：旧项目的整套 UI 态整体带走；
        // 同目录 reload 靠 keepView 保住标签，只清激活与定位（原行为）。
        // 换项目即恢复该项目的会话标签集（退出/崩溃守护批）：重启后重开、同会话
        // 切回、崩溃恢复合并，走的是同一条路
        if (project?.rootDir !== dir) {
          resetProjectUiState();
          // WS-08：附加根独立于标签恢复（标签全关但根还在的项目也回得来）；
          // 记录里的根已过绝对路径 / 去重 / 上限清洗，这里再按项目根剔一次自我指涉。
          setExtraRoots(sanitizeExtraRoots(sessionProjectOf(sessionRecordRef.current, dir)?.extraRoots, dir));
          // WS-06：恢复前逐条探盘，缺失标签剔除（剔了会出声）
          await restoreSessionTabs(dir, wantRecovery ? recoveredPaths() : []);
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
        // 允许域 = 项目根目录 + appDataDir；失败 fail-closed（仅 appDataDir 可写）并显式报错。
        // WRITE-ADMIT-SPLIT 出路①：这一趟的结果是一份**独立事实**（宿主到底把写域交出来了
        // 没有），下面那行可写态必须吃它——只看着 TS 批准记录解锁 = UI 表演"能编辑"。
        // 被拒时错误条自带那颗「重新选择这个文件夹」，点了才重新交付一次。
        const admission = await admitProjectWriteDomain({
          dir,
          hosted: isTauri(),
          register: registerWriteDomainRoot,
          hasApprovalRecord: async () => (await kernel.project.approvedWritableFor(dir)) !== null,
          approvalMismatch,
          redeliver: () => redeliverRef.current(),
        });
        applyWriteDomainAdmission(admission);

        // BUG-5：起文件监视。根集合 = 项目根 ∪ 口上域 ∪ 存档目录 ∪ 会话级附加根（D1）
        //        ∪ 作者工作区全部根——组装与启动收在下方的专用 effect 里（extraRoots
        //        变化 = 换根，与首开共用同一条路），这里只负责把项目挂上状态。

        // 可写路径批准（首次打开必须由用户显式确认；未批准 = 只读浏览）；
        // 批准记录与新提议不一致（approvalMismatch）同样重弹确认（F1/F2 修复）
        if (admission.needsApproval) setPendingApproval(p);

        // 口上域全量索引：解析器在 project.opened 已自动开建，这里等待其完成。
        // 索引失败**不**回退欢迎页：项目仍可浏览，失败原因走状态栏 + 通知显式呈现
        //（原先会走外层 catch → 用户只见「项目打不开」，无从判断是索引的问题）
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
        //（放在成功路径末尾：打开失败走下面的 catch，绝不顺带打开文件）
        if (opts?.pendingOpenFile) requestOpenFileRef.current?.(opts.pendingOpenFile);
      } catch (e: unknown) {
        if (isAdapterConflictError(e)) {
          // 两个适配器都认领同一目录 = 识别规则重叠（程序性冲突），不是用户选错目录。
          // 点名「谁和谁」但不透传内核英文原文；错误条与通知同时可见。
          const message = adapterConflictMessage(e, dir);
          raiseError(message);
          notify({ kind: 'error', message });
        } else if (isProjectDetectionError(e)) {
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
          raiseError(msg);
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
    // 与搬迁前逐字一致：requestOpenFile 经 ref 取（它 deps 链全空、引用恒稳定）
    [kernel, notify, project, resetProjectUiState, restoreSessionTabs],
  );

  /**
   * 文件监视的根集合收口（D1）：**首开与"加了文件夹"共用同一条路**。
   * 原注释见 App.tsx 历史：`fileWatch.start(roots)` 的语义是「用新的一组根替换旧的」，
   * 所以"加根" = 用完整根集合再 start 一次，不需要先 stop。
   *
   * WS-04 起根集合不再在这里拼：它取自工作区根模型（`workspace-folders.ts`）——
   * 与树 / Ctrl+P / 检索 / 整项目诊断**同一份**根表。作品目录是活读数（本会话新建的作品
   * 也立刻进模型），所以这条 effect 跟的是 `workspaceFolders` 的引用而不是 project 的字面量。
   */
  const workspaceFolders = useWorkspaceFolders(kernel, project, extraRoots);
  useEffect(() => {
    if (!kernel || !project) return;
    // 只监视模型给定的根：自选项目位置根的**根身**可能正是游戏目录，卷进来等于给整个
    // 游戏目录挂全量 watcher（体量 + 噪声都不该发生）——作品目录才进表（2026-10-27 收窄批）。
    void kernel.fileWatch.start(watchRootsOf(workspaceFolders));
  }, [kernel, project, workspaceFolders]);

  const closeProject = useCallback(async () => {
    if (!kernel) return;
    await closeProjectSession({
      kernel,
      // 与搬迁前同相位：Tauri 壳才清 Rust 侧允许域；浏览器壳不发明知会失败的 IPC
      clearWriteDomain: isTauri() ? () => invoke('clear_write_domain').then(() => undefined) : null,
      reportError: raiseError,
      // 拆除序的状态复位与搬迁前逐字同序（含 resetSearch 与 phase 回落）
      reset: () => {
        setProject(null);
        setIndex(null);
        resetProjectUiState();
        setPendingApproval(null);
        setWritable(null);
        setIndexError(null);
        // WRITE-ADMIT-SPLIT 出路①：宿主写域事实与那条带出路的错误条都只属于这个项目——
        // 项目一关，Rust 侧回到「仅应用数据目录可写」，屏上不许留着"这个项目不能写"的话
        // 和一颗对着空现场按得下去的按钮（clear_write_domain 真失败仍会另报一条）。
        setSessionWriteDomainFact(initialWriteDomainFact);
        setError(null);
        // 检索结果按项目根算出来的：项目一关，旧结果里的路径全部失去意义（留着只会误导）
        resetSearch();
        setPhase('welcome');
      },
      setRecent,
    });
  }, [
    kernel,
    raiseError,
    resetProjectUiState,
    setIndex,
    setIndexError,
    setPendingApproval,
    setPhase,
    setProject,
    setRecent,
    setWritable,
  ]);

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
        // WRITE-ADMIT-SPLIT 出路①：批的是 TS 那半边记录。宿主没把写域交出来时（准入门拒过），
        // 这里照同一份事实判 ⇒ 仍是只读，并把那条带出路的错误重新挂上屏，别让徽章说谎。
        const hostFact = getSessionWriteDomainFact();
        const writableNow = isProjectWritableOf({
          hasApprovalRecord: true,
          approvalMismatch: false,
          hostGrant: hostFact.grant,
        });
        setWritable(writableNow);
        if (!writableNow && hostFact.grant === 'refused') {
          raiseError(writeDomainRefusedMessage(hostFact), writeDomainFixAction(() => redeliverRef.current()));
        }
      } catch (e: unknown) {
        // 授权失败必须显式可见（P0 实机反馈）：否则对话框一关、徽章仍是「只读」，
        // 用户以为点了没反应（=「无法重新选择权限」）
        const msg = errorText(e);
        raiseError(msg);
        setWritable(false);
        notify({ kind: 'error', message: `写权限授权失败：${msg}` });
      }
    },
    [kernel, pendingApproval, notify, raiseError, setPendingApproval, setWritable],
  );

  /** 重授权入口（定稿 Q9：状态栏徽章点击 + 通知 action 两者都留） */
  const requestReauth = useCallback(() => {
    if (project) setPendingApproval(project);
  }, [project, setPendingApproval]);

  return { openProject, closeProject, decideApproval, requestReauth };
}

/* ------------------------------ 会话记录落盘 ------------------------------ */

/**
 * 会话记录的内存权威 + 防抖调度器（原 App.tsx 的 ref 初始化块，S2 #4）。
 * 只建 ref、不注册 effect；`useSessionFlush` 才在 App 原来的两个 effect 位置注册。
 */
export interface SessionStoreOptions {
  readonly editorGroupsRef: RefLike<EditorGroupsState>;
  /** 最近一次打开过的项目根（欢迎页「继续上次会话」） */
  readonly onLastRoot: (root: string | null) => void;
}

export interface SessionStore {
  readonly sessionRecordRef: RefLike<SessionRecord>;
  readonly sessionFlushRef: RefLike<SessionFlushScheduler | null>;
  /** 启动读回：装载记录并顺手更新「继续上次会话」的目标根 */
  readonly adoptSessionRecord: (rec: SessionRecord) => void;
}

export function useSessionStore(options: SessionStoreOptions): SessionStore {
  const { editorGroupsRef, onLastRoot } = options;
  const sessionRecordRef = useRef<SessionRecord>(emptySessionRecord());
  const sessionFlushRef = useRef<SessionFlushScheduler | null>(null);
  if (sessionFlushRef.current === null) {
    sessionFlushRef.current = createSessionFlushScheduler({
      write: (p) => {
        // MM-9：编辑器组态随会话一起落盘（serializeGroups 的纯数据快照；restoreGroups
        // 判非法不存——editorGroupsRef 读最新组态，不吃陈旧闭包，同 openTabsRef 纪律）
        const next = upsertSessionProject(sessionRecordRef.current, p.root, {
          ...p,
          groups: serializeGroups(editorGroupsRef.current),
        });
        sessionRecordRef.current = next;
        onLastRoot(next.lastRoot);
        void saveSessionRecord(p.kv, next).catch(() => undefined);
      },
    });
  }

  const adoptSessionRecord = useCallback(
    (rec: SessionRecord) => {
      sessionRecordRef.current = rec;
      onLastRoot(rec.lastRoot);
    },
    [onLastRoot],
  );

  return { sessionRecordRef, sessionFlushRef, adoptSessionRecord };
}

export interface SessionFlushOptions {
  readonly kernel: Kernel | null;
  readonly project: GameProject | null;
  readonly sessionFlushRef: RefLike<SessionFlushScheduler | null>;
  readonly openTabsRef: RefLike<readonly string[]>;
  readonly activeFileRef: RefLike<string | null>;
  readonly pinnedRef: RefLike<ReadonlySet<string>>;
  /** 依赖项（与搬迁前 effect 的依赖数组同源；payload 仍从 ref 读最新值） */
  readonly openTabs: readonly string[];
  readonly activeFile: string | null;
  readonly pinnedPaths: ReadonlySet<string>;
  /**
   * 组态**布局签名**（WS-06）：方向 / 焦点组 / 每组 id、激活、标签序的稳定签名。
   * 只改焦点、只翻方向、只动组结构也各算一次"布局变了"——此前这些变化一律不落盘
   * （`openTabs` 是焦点组的投影，换个焦点组而标签相同时它可能一字不变）。
   */
  readonly layoutSignature: string;
  /** 分屏比例（WS-06）：拖完分隔条也要落盘；payload 直接带上当前值 */
  readonly splitSizes: readonly number[];
  /** 会话级附加根（WS-08）：加/减根都要落盘，重启后根还在 */
  readonly extraRoots: readonly string[];
}

/**
 * 会话标签集落盘 + 拆除强刷（原 App.tsx 两个 effect，位置由 App 决定）。
 * 判据：
 * - debounce 600ms，写 kernel 全局存储；欢迎页（project null）不写；
 * - **标签 / 焦点 / 方向 / 组结构 / 分屏比例 / 附加根**任一变化都 schedule（WS-06/08）；
 * - 项目拆除 / kernel 更替 / 卸载：layout 相同步 flushNow，防抖窗口里的最后一拍不丢；
 * - 快照由 schedule 那一刻的值构成，关项目 reset 之后不会再回读现场。
 */
export function useSessionFlush(options: SessionFlushOptions): void {
  const {
    kernel,
    project,
    sessionFlushRef,
    openTabsRef,
    activeFileRef,
    pinnedRef,
    openTabs,
    activeFile,
    pinnedPaths,
    layoutSignature,
    splitSizes,
    extraRoots,
  } = options;

  useEffect(() => {
    if (!kernel || !project) return;
    sessionFlushRef.current?.schedule({
      root: project.rootDir,
      kv: kernel.storage.global(),
      tabs: openTabsRef.current,
      active: activeFileRef.current,
      pinned: [...pinnedRef.current],
      splitSizes,
      extraRoots,
    });
  }, [kernel, project, openTabs, activeFile, pinnedPaths, layoutSignature, splitSizes, extraRoots]);

  // 项目拆除（project→null / 换项目 / kernel 更替 / 组件卸载）：layout 相保证这步在
  // commit 内同步发生；无待写时 flushNow 是 no-op，绝不双写。
  useLayoutEffect(() => {
    return () => {
      sessionFlushRef.current?.flushNow();
    };
  }, [kernel, project]);
}
