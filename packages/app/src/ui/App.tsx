import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type { Kernel } from '@kojo/kernel';
import type { ErbIndex, ErbParserService, FileStat, FileWatchStatus, GameProject, RecentProject } from '@kojo/plugin-api';
import {errorText,  join, pathKey } from '@kojo/plugin-api';
import { removeRecentOptimistic } from './WelcomeView';
// 版本号单一真源 = app 包清单（启动品牌锁与欢迎页同一条路）
import { version as APP_VERSION } from '../../package.json';
import { windowTitleFor } from './window-title';
import { invoke, isTauri } from '../bridge/invoke';
import { openExternal, tauriBridge } from '../bridge/tauri-bridge';
import { AutosaveJournal, HEARTBEAT_INTERVAL_MS, SNAPSHOT_DEBOUNCE_MS } from './autosave-journal';
import { journalIo } from './autosave-journal-io';
import { loadSessionRecord } from './session-store';
// 最近文件列表（MM-7）：欢迎页「最近文件」区的持久层与纯逻辑
import {
  loadRecentFiles,
  removeRecentFiles,
  renameRecentFiles,
  sameRecentFiles,
  saveRecentFiles,
  upsertRecentFile,
  type RecentFileRecord,
} from './recent-files';
import { clearRecoveredContents, setRecoveredContents } from './recovery-store';
import { resolveProjectSwitch, type ProjectSwitchDecision } from './project-switch';
// LAU-1a（2026-10-25）：2.0 事实的**按项目取**端口全部收在组合根（bootstrap）——
// 本文件不再直接动态 import 任何适配器包；无项目 / 该项目没有 2.0 面 ⇒ null/undefined，
// 各消费腿沿用各自既有 fail-soft 形态（迁移只判面词不猜参数、存储本轮不写账本并说人话）。
import {
  bootstrapKernel,
  kojo2AdapterForProject,
  kojo2MigrateEventArgs,
  kojo2MigrateEventNames,
  kojo2StorageFacts,
  prefetchProjectPlugins,
} from '../bootstrap';
import { perf } from '../perf';
import { revealTargetOf, type RevealSpan, type RevealTarget } from '../monaco/reveal-position';
import { degradationNoticeText, onStructureDegradation } from '../monaco/tree-sitter/fallback';
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
import { installWindowCloseGuard } from './window-close-guard';
// 常驻窗口框架（用户反馈第 9 条）：窗口永久无原生装饰，标题栏由 App 根部统一提供，
// 欢迎页 / 项目态 / 禅模式共用；浏览器 dev 里该组件返回 null（不画假按钮）。
import { WindowChrome } from './WindowChrome';
import { Icon } from './icons';
import {
  WELCOME_WINDOW_DEFAULT_HEIGHT,
  WELCOME_WINDOW_WIDTH,
  applyEditorWindow,
  applyWelcomeWindow,
  canStartWindowDragFrom,
  clampWelcomeWindowSize,
  closeWindow,
  prepareWindowDrag,
  type WindowDragStarter,
} from './window-fullscreen';
import { WelcomeView, type WelcomeTutorialId } from './WelcomeView';
import { loadDevNoteSeen, markDevNoteSeen } from './dev-note-pref';
import { WelcomeOverlayHost } from './WelcomeOverlayHost';
import { planAddExtraRoot, planRemoveExtraRoot } from './workspace-roots';
import { getKojo2CutoverController } from './kojo2-cutover';
// K2-CUTOVER-STAGE：阶段切换后的宿主效果注入口（设置页只负责改档，不认识 Monaco）
import { installKojo2CutoverStageEffects } from './kojo2-cutover-settings';
// 2.0 打开入口闸（K2-EDITOR-OPEN-PATHS）：开关关着时它只回 `off`，打开路径逐字不变
import { routeKojo2OpenPath } from './kojo2-open-paths';
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
  activeGroupOrdinal,
  alignSplitSizes,
  cycleActiveGroup,
  closeTabsInGroup,
  focusGroupAtOrdinal,
  groupsLayoutSignature,
  initialEditorGroups,
  migrateGroupPathsAfterSaveAs,
  activateTab as activateTabInGroupState,
  openInActiveGroup,
  openPreviewInActiveGroup,
  resizeGroupShare,
  setActiveGroup as setFocusedGroup,
  setGroupsOrientation,
  splitActiveDown,
  splitActiveRight,
  closeGroup as closeEditorGroup,
  moveTabBetweenGroups as moveTabBetweenGroupsState,
  splitSizesEqual,
  type EditorGroupsState,
} from './editor-groups';
// 导航历史（MM-6 前进/后退 + MM-10 恢复关闭的标签）：纯逻辑单源，App 是唯一状态所有者
import {
  createNavState,
  navBack as navBackInHistory,
  navEntrySpan,
  navForward as navForwardInHistory,
  popClosed,
  pushClosed,
  pushNav,
} from './navigation-history';
// 标签预览态与最近使用序（1020 编辑器体感批）：预览住在组态里（editor-groups），
// MRU 只服务 Ctrl+Tab，是比 pin 更 ephemeral 的会话序——不进持久化、不进快照。
import { pruneMru, stepMru, touchMru } from './tab-mru';
import { subscribeTabCycle, type TabCycleDirection } from './tab-cycle';
import type { OpenFileOptions } from './tabs-ops';
import { useShellOverlays } from './shell-overlays';
// 右键菜单（1023 覆盖面批 · WP0）：根宿主 + 三层路由。App 只挂监听与宿主，
// 面注册表与兜底策略都在各自模块里（供 13 个面并行接入）。
import { ContextMenuHost, openContextMenu } from './context-menu-host';
import { buildContextMenuRoute } from './context-surfaces';
// K2-MIGRATE-MOUNT：Kojo 2.0 迁移向导的宿主入口（纯逻辑，命令 / 开合 / IO 注入 / 刷新收尾）
// 与挂载壳。开关关时 `commands()` 返回空数组 ⇒ 命令表零变化（见 kojo2-migrate-entry.ts）。
import {
  createKojo2MigrateEntry,
  type Kojo2MigrateEntry,
  type Kojo2MigrateEntrySnapshot,
} from './kojo2-migrate-entry';
import { listSourceFiles, type ShellCommandSpec } from './commands';
import {
  fileOpGuardMessage,
  mapRenamedPath,
  pathGoneByDelete,
  reconcilePathsAfterDiskChange,
} from './disk-reconcile';
import type { EditorPaneActions } from './EditorPane';
import { openModelAcrossGroups } from './editor-pane-registry';
// 整项目诊断扫描的装配与调度（判据一份，全住在那模块里；这里只递宿主事实）
import { mountProjectScan } from './project-scan-schedule';
// K2-PROJECT-WIRE：2.0 项目级分析的装配面（adapter 事实按当前项目现取，LAU-1a；
// flag 关时工厂内部零动作，调用点无分支）。装配面**每项目重造**——分析侧按 getter
// 函数实例缓存事实，换项目换实例才不会把上一个项目的事实带到下一个。
import { createLazyKojo2ProjectOptions } from './kojo2-project-scan-adapter';
// K2-STORAGE-SERVICE：项目打开后唯一的槽位账本装配点（React 无关的服务；这里只负责
// 项目开/关两拍与把 adapter 事实惰性递进去）。
//
// S7-首屏字节（2026-10-25）：服务本体 + 持久化 + 声明刷新 + 回收重试命令（约 93 KB 源码）
// 原先随 App 静态进开机图，但这条链**只在 `isKojo2CutoverEnabled()` 为真且项目已开**时才
// 用得上（「只认 v1」档 ⇒ 那片 effect 直接返回）。改为在 effect 里 `await import()` 三件
// 套，默认路径上零解析；这里只剩类型（`import type` 会被擦除）。
import type { Kojo2StorageService, Kojo2StorageServiceAdapter } from './kojo2-storage-service';
// K2-STORAGE-RECYCLED-UI（缺口②）：会话内 `.kojo2` 变更 → 防抖 → refreshDeclarations。
// 调度判据全住在这个零 React 模块里；App 只递「文档怎么重列」与事件路径。
import type { Kojo2DeclRefresh } from './kojo2-storage-refresh';
// 回收阻断的命令表出口（toast 动作之外的二次入口；开关关 = effect 不建服务 ⇒ 零注册）
// `KOJO2_STORAGE_DEFAULT_CLASSES` 仍静态引：注册表被 `kojo2-project-analysis`（项目级
// 扫描，开机图常驻）用着，这里改懒边只会平白多一条"动态+静态混用"警告，省不下字节。
import { KOJO2_STORAGE_DEFAULT_CLASSES } from './kojo2-storage-registry';
import { isKojo2Path } from './kojo2-open';
import { isKojo2CutoverEnabled } from './kojo2-flag';
// REF-FRONT-PERF：项目生命周期（开/关/写允许域/审批/会话 flush）收在专用 hook；
// App 只留 UI state 与渲染。项目子树另加错误边界 + 项目态错误条。
import { useProjectSession, useSessionFlush, useSessionStore } from './use-project-session';
import { syncErbIndexAfterDiskChange } from './erb-index-sync';
import { ProjectErrorBoundary } from './error-boundary';
import { ProjectErrorNotice, raiseProjectErrorBar, visibleProjectError, type ProjectErrorAction, type ProjectErrorBar } from './project-error-notice';
import { crashExitDecision } from './project-close';
import { discardRecoveryJournal } from './crash-recovery';

/**
 * L1-A 首屏分割（2026-10-16 首屏批）：项目视图的静态链会把 monaco 全图（~1338 模块 /
 * 入口块 ~4.5 MB）拖进欢迎页关键路径——这里改按需 chunk。加载器独立成函数：
 * `React.lazy` 与意图预取**共用同一个 import promise**（浏览器模块缓存去重，
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

/**
 * 可重建的 lazy 实例（REF-FRONT-PERF 错误边界）。
 *
 * 不用模块级单例：React.lazy 会把 **rejected promise 缓存在组件类型上**，块加载失败后
 * 只清错误边界的 state 仍会撞同一份拒绝——「重试」必须换一个 lazy 实例。
 * `loadProjectView` 本身可重复调用；成功的模块由浏览器模块缓存去重，不会重复求值。
 */
function createProjectView() {
  return lazy(loadProjectView);
}

/**
 * 只在**特定状态/动作**下才上屏的宿主件（S7-首屏字节）：迁移向导与四扇确认框原先
 * 随 App 静态进开机图，但它们在欢迎页一个像素都不画——迁移向导要等作者显式发起迁移
 * （`migrateState.status === 'open'`）、三扇确认框要等真有未保存改动 / 写权限待批。
 * 这里各加一层 `lazy(() => import(...))` 壳，模块到那一刻才装载。
 *
 * fallback 一律是**与真身同外层**的空壳（`overlay-backdrop` / `modal-mask`）：
 * 遮罩铺满窗口、尺寸由 CSS 给，装载到位后原地换内容，不出现"先空一帧再蹦出对话框"
 * 的跳动，也不会在白屏期间漏点出底层可点区域。
 *
 * 注：迁移向导的**入口/状态机**（`kojo2-migrate-entry`）仍在开机图上——它是命令表与
 * 文件路由的一部分，只有**呈现**被推迟。
 */
const loadKojo2MigrateWizard = (): Promise<{ default: typeof import('./kojo2-migrate')['Kojo2MigrateWizardHost'] }> =>
  import('./kojo2-migrate').then((m) => ({ default: m.Kojo2MigrateWizardHost }));
const LazyKojo2MigrateWizardHost = lazy(loadKojo2MigrateWizard);
/**
 * `.kojo` → `.kojo1` 改名对话框（LAU-3b）：同样是"只有显式动作才上屏"的宿主件，
 * 走懒边；fallback 用 `modal-mask` 与真身同外层。
 */
const LazyKojo1RenameDialog = lazy(() =>
  import('./kojo1-rename').then((m) => ({ default: m.Kojo1RenameDialog })),
);
const LazyDevNoteDialog = lazy(() => import('./DevNoteDialog').then((m) => ({ default: m.DevNoteDialog })));
const LazyWritableApprovalDialog = lazy(() =>
  import('./WritableApprovalDialog').then((m) => ({ default: m.WritableApprovalDialog })),
);
const LazyUnsavedConfirmDialog = lazy(() =>
  import('./UnsavedConfirmDialog').then((m) => ({ default: m.UnsavedConfirmDialog })),
);
const LazyUnsavedFilesConfirmDialog = lazy(() =>
  import('./UnsavedFilesConfirmDialog').then((m) => ({ default: m.UnsavedFilesConfirmDialog })),
);
// 启动器实例库（L5）：视图与它依赖的 launcher-core 一起走动态边（开机图零新增文件）
const LazyLauncherView = lazy(() =>
  import('../launcher/LauncherView').then((m) => ({ default: m.LauncherView })),
);

/**
 * 槽位账本的 adapter 事实（K2-STORAGE-SERVICE · LAU-1a 改按项目取）。
 *
 * 事实来源是组合根的 2.0 登记簿（`kojo2StorageFacts(project)`，键 = 当前项目的
 * `adapterId`）：**不再无条件动态 import 某一枚具体适配器**（旧实现即 §5.1 漏点表
 * 第二行——开别的工程拿的是那一枚常驻适配器的事实）。取不到（无项目 / 该项目没有
 * 2.0 面）⇒ `null` 并交一句人话给宿主（本轮不建服务、零写，项目其余功能照常）；
 * **绝不借别游戏的事实**。
 *
 * `storageClasses`：契约目前只有引擎落点与槽前缀，**没有槽位编号区段**；宿主先用
 * `KOJO2_STORAGE_DEFAULT_CLASSES` 的现口径（0..4095）顶数值，但**只保留 adapter 真
 * 声明过的存储期**——adapter 没声明的存储期绝不替它补，声明用了就会在 core 的规划闸
 * 报 `core/storage/unknown-class`。adapter 补出数值区段后只改这一行映射。
 */
async function loadKojo2StorageAdapter(
  project: GameProject | null,
  onUnavailable: (reason: string) => void,
): Promise<Kojo2StorageServiceAdapter | null> {
  const facts = kojo2StorageFacts(project);
  if (facts === null) {
    onUnavailable(
      project === null
        ? '当前未开项目，没有 2.0 存储期事实（不猜、不借）'
        : `项目适配器 '${project.adapterId ?? '未知'}' 没有 2.0 存储面（不借别游戏的事实）`,
    );
    return null;
  }
  return {
    gameFingerprint: facts.gameFingerprint,
    storageClasses: KOJO2_STORAGE_DEFAULT_CLASSES.filter((spec) => facts.declaredPeriods.has(spec.storage)),
    /**
     * 仓库还没有「编辑器声明账本键」（注册表头注说的跨构建稳定键）⇒ 先用
     * `(文件, 名字)` 近似：**搬行不搬槽**（位置键会随插入一行就把整段槽位判成
     * 删除+新增，回收闸会被日常编辑频繁触发）。`pathKey` 归一化盘符大小写/分隔符，
     * 同一文件从两种写法进来仍认成同一声明。改名按新声明处理（旧槽 retire），
     * 若新声明回收了旧槽，服务会零写阻断、等作者显式放行——那是真该问人的时候。
     */
    declarationKey: (input) => `${pathKey(input.uri)}\u0000${input.name}`,
  };
}

/**
 * 欢迎页上"我要开项目"的两处意图面（PS-10 ③ 的预取闸门）：最近项目区（含每一行）与
 * 「继续上次会话」。选择器只认既有类名，`WelcomeView` 一字未改。
 */
const WELCOME_OPEN_INTENT_SELECTOR = '.welcome-recent, .welcome-resume';

/* 2026-10-25 性能批：欢迎页的无人兜底预取已删除——用户不点就一个字节都不拉。
   真壳实测那发空闲预取（ProjectView ~4 MB Monaco + 项目插件）会在欢迎页可点后
   3.7s / 4.7s 各顶出一个 54ms / 106ms 长任务、掉两帧；且真开项目本来就会自己拉。
   取证侧（boot-probe 的反假绿自证）改由探针派发一次合成 pointerdown 触发，不靠产品兜底。 */

/** 项目视图 chunk 装载期间的骨架（与内联引导层同构；意图预取命中时基本见不到） */
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

/**
 * 启动弹窗（2026-10-25 启动弹窗批）：内核装配期间的唯一可见面。
 *
 * 形态（用户口径）：窗口已是「欢迎卡核心区」大小、无边框、无标题栏；里面只有
 * 主题底色 + 扫光条 + 「正在启动…」+ 右上角一个 ×。品牌字不再出现。
 * 扫光条与提示行复用 `styles.css` 的 `.boot-bar` / `.boot-skeleton-*`（与
 * `index.html` 内联首帧层逐字镜像，守卫见 boot-sweep-single-source）；× 的样式
 * 住在 `window-chrome.css`（与标题栏窗控同一族，不另开样式文件——PS-10 文件数预算）。
 *
 * × 走 `closeWindow()`（Tauri 原生 close；启动期没有脏文件，关窗守卫直接放行）；
 * 浏览器 dev 无壳，`closeWindow` 自身 no-op。
 */
function BootSplashView(): ReactElement {
  return (
    <div className="boot-skeleton boot-screen" role="status">
      <div className="boot-skeleton-card" data-tauri-drag-region>
        {/* 品牌锁：与内联引导层同构（logo + 字标 + 版本）。没有它这屏读起来像空窗/坏窗 */}
        <div className="boot-splash-lock">
          <svg
            className="boot-splash-mark"
            viewBox="0 0 16 16"
            fill="currentColor"
            fillRule="evenodd"
            aria-hidden="true"
            focusable="false"
            data-tauri-drag-region
          >
            <path d="M3 1.6h10a2.4 2.4 0 0 1 2.4 2.4v5a2.4 2.4 0 0 1-2.4 2.4H7.3L4 14.1v-2.7H3A2.4 2.4 0 0 1 .6 9V4A2.4 2.4 0 0 1 3 1.6Zm1.45 4.9a1.05 1.05 0 1 0 2.1 0 1.05 1.05 0 1 0-2.1 0Zm2.5 0a1.05 1.05 0 1 0 2.1 0 1.05 1.05 0 1 0-2.1 0Zm2.5 0a1.05 1.05 0 1 0 2.1 0 1.05 1.05 0 1 0-2.1 0Z" />
          </svg>
          <span className="boot-splash-name" data-tauri-drag-region>
            kojo-editor
          </span>
          <span className="boot-splash-ver" data-tauri-drag-region>
            v{APP_VERSION}
          </span>
        </div>
        <div className="boot-skeleton-tip">正在启动…</div>
        <div className="boot-bar" />
      </div>
      <button
        type="button"
        className="boot-splash-close"
        aria-label="退出应用"
        title="退出应用"
        onClick={() => void closeWindow()}
      >
        <Icon name="close" size="sm" />
      </button>
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

/**
 * Kojo 2.0 切换计划（K2-CUTOVER-PRE）：把持久化端口挂上控制器单例。
 *
 * 模块求值一次即可：控制器是进程级单例，存储只影响「阶段 / per-file override」这两个
 * 计划值，不参与渲染；没有这一行也能跑（只在内存里）。`localStorage` 在浏览器 dev 环境
 * 一定存在；隐私模式写失败由控制器自己吞成 `persisted=false`，不抛。
 */
if (typeof window !== 'undefined') getKojo2CutoverController().attachStorage(window.localStorage);

/**
 * Kojo 2.0 切档的宿主效果（K2-CUTOVER-STAGE）：改档后让已开 model 按新阶段重挂语言。
 *
 * 重挂器住在 monaco 图里（`editor-model-pool-instance`），这里**动态 import**：
 * 开机静态图（PS-10 的走图判据）一分不多，切档时才把它拉进来。失败不静默（铁律 4）：
 * 重挂没做成只是"标签要重开/重载才换色"，用一条 warn 说出来，不挡任何操作。
 */
if (typeof window !== 'undefined') {
  installKojo2CutoverStageEffects({
    refreshAll: () => {
      void import('./editor-model-pool-instance').then(
        (module) => module.kojo2ModelLanguage.refreshAll(),
        (error: unknown) => {
          console.warn(
            `[kojo2] 切档后重挂已开文件的语言失败（重载窗口可恢复）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      );
    },
  });
}

/**
 * K2-EVENT-FACEWORD / K2-MIGRATE-SHAPE 的宿主接线（LAU-1a 改按项目取）：
 * 迁移向导的事件目录名字投影与参数形状投影都走组合根
 * `bootstrap.ts::kojo2MigrateEventNames / kojo2MigrateEventArgs`（键 = 当前项目的
 * `adapterId`）。取不到 ⇒ `undefined`：迁移器只判面词、不猜参数形状（既有 fail-soft
 * 形态）——**绝不拿别游戏的事件目录冒充**（旧实现无条件取那一枚常驻适配器的事实，
 * 属 §5.1 漏点表第一行）。向导只在项目态渲染，`project` 随渲染闭包现值传入；
 * 无项目态本就开不了向导。
 */

export function App(): ReactElement {
  const [kernel, setKernel] = useState<Kernel | null>(null);
  const [phase, setPhase] = useState<AppPhase>('boot');
  /**
   * 项目视图的懒加载实例（REF-FRONT-PERF 错误边界）：**不是模块级单例**。
   * React.lazy 会把 rejected promise 缓存在组件类型上；「重试」必须换一个实例，
   * 否则错误边界清完 state 重渲染仍会撞同一份拒绝。成功块由浏览器模块缓存去重。
   */
  const [ProjectViewComponent, setProjectViewComponent] = useState(createProjectView);
  /**
   * 「开发者的碎碎念」纸条（用户反馈 2，2026-10-18）：初值直接问 localStorage——
   * 只有**从未看过**才为 true，于是"下载后第一次启动"自然只弹一次。关闭（Esc / 遮罩 /
   * ✕ / 两个按钮）写 seen 标记；只活在本会话，不参与 phase 判定。
   */
  const [devNoteOpen, setDevNoteOpen] = useState(() => !loadDevNoteSeen());
  /** 启动器实例库（L5）：全屏浮层；命令面板与 Ctrl+Alt+O 打开，视图本体懒装载 */
  const [launcherOpen, setLauncherOpen] = useState(false);
  /**
   * 项目生命周期错误（欢迎页错误区 + 项目态错误条共用的一条 state）。
   * WRITE-ADMIT-SPLIT 出路①：从「一句文案」升级为「文案 + 它自带的那条出路」——
   * 出路只在真有出路时出现，与文案同生同灭，不会各说各话。
   */
  const [errorBar, setErrorBar] = useState<ProjectErrorBar | null>(null);
  const [project, setProject] = useState<GameProject | null>(null);
  /**
   * 窗口标题三处同源（视觉批十四）：自绘标题栏、`document.title`（浏览器标签 / 调试宿）、
   * Tauri 系统标题（任务栏 / Alt-Tab）。只吃项目目录名，算法见 `window-title.ts`。
   */
  const windowTitle = useMemo(() => windowTitleFor(project?.rootDir ?? null), [project?.rootDir]);
  useEffect(() => {
    document.title = windowTitle;
    if (!isTauri()) return;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        if (!cancelled) await getCurrentWindow().setTitle(windowTitle);
      } catch (error) {
        // 设置不上不影响使用（自绘标题栏仍对）：记一条，不弹窗打断
        console.warn('[window-title] 设置系统窗口标题失败：', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [windowTitle]);
  const [index, setIndex] = useState<ErbIndex | null>(null);
  /** 索引读数的 ref 镜像（`onFilesGone` 等恒定身份回调里要读最新那一份，不吃陈旧闭包） */
  const indexRef = useRef(index);
  indexRef.current = index;
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
   * 分屏比例的长度对齐（WS-06）：**只认组数**——组数没变就一个字不动（拖过的比例保住），
   * 组数一变（拆分 / 关组 / 会话恢复成别的组数）交给 `alignSplitSizes`：长度对得上沿用，
   * 对不上整份退回均分。`alignSplitSizes` 对合法比例返回**同一引用** ⇒ setState 直接
   * 被 React 短路，不会因为每次渲染都算一遍而抖动。
   */
  useLayoutEffect(() => {
    setSplitSizes((prev) => alignSplitSizes(prev, editorGroupsRef.current.groups.length));
  }, [editorGroups.groups.length]);
  /**
   * 导航历史（MM-6 / MM-10）：**刻意不用 useState**——每次跳转/关标签都写一遍会把
   * 整棵壳树拖进重渲染，而它只被命令回调与关闭路径读写，没有任何渲染面消费。
   * 纯函数返回新 state 后由回调直接写回 ref（与 editorGroupsRef 同族的直接赋值模式）。
   */
  const navRef = useRef(createNavState());
  /**
   * 各组标签的最近使用序（1020 编辑器体感批，Ctrl+Tab 的数据源）。与 navRef 同一条理由
   * **不用 useState**：没有任何渲染面消费它（只有命令回调读）， useState 会让每次切标签
   * 多拖一次整壳重渲染。不落盘、不进快照——会话内的"上一个看过哪张"不值得跨项目保留。
   */
  const mruRef = useRef<Record<string, string[]>>({});
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
   * 检索/监视根。**不进写允许域**（附加根默认只读——写仍走既有批准域）；WS-08 起随
   * 本项目会话记录持久化（重开项目回来还是这组根），但换项目仍整体清空——
   * 绝不把上一个项目的根带进下一个（互不继承）。
   */
  const [extraRoots, setExtraRoots] = useState<readonly string[]>([]);
  /**
   * 分屏比例（WS-06）：长度 = 组数 - 1 的归一份额（末组吃剩余，判据见 `split-sizes.ts`）。
   * 真源在 App，ProjectView 只渲染与在拖拽落定时回报；**拖动过程不落盘、不 setState**
   * （每帧 setState 会把整壳拖进重渲染），松手才回报一次。
   *
   * 长度对齐：组数变化（拆分/关组/恢复）时由下面的 layout effect 过一次
   * `alignSplitSizes`——长度对不上就整份退回均分，不把旧比例套到新组上。
   */
  const [splitSizes, setSplitSizes] = useState<readonly number[]>([]);
  const splitSizesRef = useRef(splitSizes);
  splitSizesRef.current = splitSizes;
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
  /**
   * `Ctrl+P` 空查询时置顶的「最近打开」（1020 编辑器体感批）：欢迎页那块用的是同一份
   * MM-7 记录，这里只取路径清单（最新在前）。数组身份跟着 state 走 ⇒ 面板的 memo 不乱重算。
   */
  const recentOpenPaths = useMemo<string[]>(() => recentFiles.map((r) => r.path), [recentFiles]);
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
  /**
   * 会话记录的内存权威 + 落盘调度器（S2 #4）：稳态变更只 schedule（600ms 合并写盘），
   * 关项目 / kernel 更替 / 卸载收尾走 flushNow 同步落盘——防抖窗口里的最后一拍
   * 不再被清定时器丢掉。实现整体搬进 `use-project-session.ts`，这里只在该 hook 的
   * 原来位置调用 `useSessionFlush`，effect 次序不变。
   */
  const { sessionRecordRef, sessionFlushRef, adoptSessionRecord } = useSessionStore({
    editorGroupsRef,
    onLastRoot: setResumeRoot,
  });
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

  /* --------- 窗口几何（2026-10-25 启动弹窗批）：欢迎弹窗 ↔ 编辑器窗口 --------- */

  /** 应用根节点：量欢迎卡时临时挂 `welcome-popup-measuring`，不落长期状态 */
  const frameRef = useRef<HTMLDivElement>(null);
  /** 上次落窗的欢迎弹窗高度：换内容时先按它收窗，再按自然高度量一次，避免来回跳 */
  const welcomeWindowHeightRef = useRef(WELCOME_WINDOW_DEFAULT_HEIGHT);
  /** 测量代次：内容连续变化时只让最后一轮落窗 */
  const welcomeFitSeqRef = useRef(0);
  /** 当前窗口几何态；只防重复切窗，不参与渲染 */
  const windowModeRef = useRef<'popup' | 'editor'>('popup');
  /** 本次进入欢迎弹窗是否还没摆过位置（内容变化只改尺寸、不把作者拖到的位置拽回屏幕中央） */
  const welcomePlacementRef = useRef<'pending' | 'placed'>('pending');

  /**
   * 项目非空 = 编辑器窗口（标题栏/外框的渲染条件同这一条），否则欢迎弹窗。
   * 切项目时 phase 会短暂回到 opening、旧项目还在 ⇒ 保持编辑器窗口，不闪回小弹窗。
   * 欢迎弹窗的**尺寸**不在这里定：要等欢迎卡渲染完量出来（见下一条 effect）。
   */
  useLayoutEffect(() => {
    const mode = project !== null ? 'editor' : 'popup';
    if (mode === windowModeRef.current) return;
    windowModeRef.current = mode;
    if (mode === 'editor') void applyEditorWindow();
    else welcomePlacementRef.current = 'pending';
  }, [project]);

  /**
   * 欢迎弹窗整窗拖动：弹窗里除交互控件、滚动条、打开的模态外，任意位置按下都能拖。
   * 只靠 `data-tauri-drag-region` 时只有品牌文字那一小块生效（它只认事件目标元素本身），
   * 大面积留白按下去没反应；编辑器态由 WindowChrome 自己的拖拽区负责，这里不挂。
   */
  useEffect(() => {
    if (project !== null || phase === 'boot') return;
    const frame = frameRef.current;
    if (frame === null) return;
    // 原生拖动必须在 mousedown 栈里同步发起 ⇒ 窗口对象在挂载时预载，不在这里 await
    let startDrag: WindowDragStarter | null = null;
    let cancelled = false;
    void prepareWindowDrag().then((starter) => {
      if (!cancelled) startDrag = starter;
    });
    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!canStartWindowDragFrom(target, event.clientX, event.clientY)) return;
      event.preventDefault();
      startDrag?.();
    };
    frame.addEventListener('mousedown', onMouseDown);
    return () => {
      cancelled = true;
      frame.removeEventListener('mousedown', onMouseDown);
    };
  }, [project, phase]);

  /**
   * 欢迎弹窗贴合卡片核心区：
   * ① 先按目标宽度（1120，受屏幕工作区夹取）和上次高度把窗口收回来；
   * ② 等 WebView 真的换到新宽度（媒体查询按 viewport 生效，量早了会拿到窄版式）；
   * ③ 临时把卡片放回自然高度量矩形，再按量到的宽高落窗一次。
   * 只在「无项目 + phase welcome」跑：启动期用固定首帧尺寸，开项目中不弹跳。
   */
  useLayoutEffect(() => {
    if (phase !== 'welcome' || project !== null) return;
    const frame = frameRef.current;
    if (!frame) return;
    const seq = ++welcomeFitSeqRef.current;
    let cancelled = false;
    const center = welcomePlacementRef.current === 'pending';
    const screen = { width: window.screen.availWidth, height: window.screen.availHeight };

    const fit = async (): Promise<void> => {
      const provisional = clampWelcomeWindowSize(
        { width: WELCOME_WINDOW_WIDTH, height: welcomeWindowHeightRef.current },
        screen,
      );
      // 宽度已到位（欢迎页回访 / 重载）就别再落一次窗：少一整轮 resize + center 的整页重排。
      if (Math.abs(window.innerWidth - provisional.width) > 1) {
        await applyWelcomeWindow(provisional, { center });
        if (cancelled || seq !== welcomeFitSeqRef.current) return;
      }
      // 宽度没到位时媒体查询还是旧版式，量出来的高度不可信
      const deadline = performance.now() + 400;
      while (Math.abs(window.innerWidth - provisional.width) > 1 && performance.now() < deadline) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      if (cancelled || seq !== welcomeFitSeqRef.current) return;
      frame.classList.add('welcome-popup-measuring');
      let core: DOMRect | null = null;
      try {
        core = frame.querySelector<HTMLElement>('.welcome-card')?.getBoundingClientRect() ?? null;
      } finally {
        frame.classList.remove('welcome-popup-measuring');
      }
      if (!core) return;
      const final = clampWelcomeWindowSize(core, screen);
      welcomeWindowHeightRef.current = final.height;
      await applyWelcomeWindow(final, { center });
      if (center) welcomePlacementRef.current = 'placed';
    };
    void fit();
    return () => {
      cancelled = true;
      frame.classList.remove('welcome-popup-measuring');
    };
  }, [
    phase,
    project,
    recent.length,
    recentFiles.length,
    errorBar?.message,
    crashRecovery?.files,
  ]);

  /** 脏标签集合的最新值快照（openProject 换根守卫 / 拖放落地 / 关窗守卫共用，不吃陈旧闭包） */
  const dirtyRef = useRef(dirtyPaths);
  dirtyRef.current = dirtyPaths;

  /**
   * 纯文案上报（欢迎页错误区 / 项目态错误条的旧入口，签名照 `useState` 那份保持不变）：
   * 这类错误没有出路可给 ⇒ 动作恒为 null，屏上只有文案与关闭叉。
   */
  const setError = useCallback((message: string | null) => {
    setErrorBar(message === null ? null : { message, action: null });
  }, []);

  /**
   * 项目生命周期错误的统一上报口（REF-FRONT-PERF）：同一条文案保持原引用，
   * React 直接 bail out——重复失败不会把错误条重挂一遍（同屏始终只有一条）。
   * `action`（WRITE-ADMIT-SPLIT 出路①）：这条错误能走哪条路回去，随文案同生同灭。
   */
  const raiseError = useCallback((message: string, action: ProjectErrorAction | null = null) => {
    setErrorBar((prev) => raiseProjectErrorBar(prev, { message, action }));
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
          adoptSessionRecord(rec);
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
          } catch (e: unknown) {
            // autosave 通道坏了不挡启动：编辑照常，但这次没有崩溃兜底必须让作者知道
            notify({
              kind: 'error',
              message: '崩溃恢复检查失败：本次会话没有自动恢复兜底（编辑与保存不受影响）。',
              detail: errorText(e),
            });
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
  /**
   * `requestOpenFile` 在本组件更晚处声明；项目生命周期 hook 经它取最新引用。
   * 该回调的依赖链全空、引用恒稳定（见它自己的注释），ref 只是绕开声明次序。
   */
  const requestOpenFileRef = useRef<((path: string) => void) | null>(null);
  useLayoutEffect(() => {
    if (!kernel || prefetched.current) return;
    prefetched.current = true;
    perf.bootMark('boot.welcomeInteractive', undefined, '自导航起点 ms；内核就绪 ⇒ 欢迎页主按钮可点（提交时刻）');

    /* PS-10 ③：预取**只认意图**——最近项目区 / 「继续上次会话」的第一次 `pointerdown`
     * （此时取回 + 求值本来就是开项目的前置，并行预热只赚不亏）。无点击兜底见上方常量位注释：
     * 它在欢迎页可点后制造 100ms 级长任务，2026-10-25 已删。
     * 撤防＝`openProject` 一入口就取消：真开项目会自己拉这两块，抢跑没有意义。
     */
    let done = false;
    const disarm = (): void => {
      done = true;
      window.removeEventListener('pointerdown', onPointer, true);
      cancelPrefetchRef.current = null;
    };
    const fire = (): void => {
      if (done) return;
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

  /**
   * 整项目诊断扫描的装配（唯一一处；触发、节流、清账判据全在 `project-scan-schedule.ts`，
   * 这里只递两条宿主事实：会话附加根与那句人话的通道）。
   * 依赖只有 kernel：换项目 / 关项目由模块自己订阅 `project.opened` / `project.closed`，
   * 挂在这条 effect 上重装配会把刚扫完的账反复抹掉。
   */
  const extraRootsRef = useRef(extraRoots);
  extraRootsRef.current = extraRoots;
  useEffect(() => {
    if (!kernel) return;
    const handle = mountProjectScan({
      kernel,
      extraRoots: () => extraRootsRef.current,
      onNotice: (message) => notify({ kind: 'info', message }),
      // 2.0 项目级分析（K2-PROJECT-WIRE · LAU-1a）：flag 关时工厂内部零动作，扫描器连
      // `.kojo2` 判据都不调；adapter 事实经组合根登记簿**按当前项目现取**（取不到 ⇒
      // `undefined` = 本轮拿不到，织面退回"无 adapter"的可见降级，绝不借别游戏的事实）。
      // 工厂形态 = 每装配一个项目新建一份 getter：分析侧按 getter 实例缓存，换项目自然重解析。
      kojo2ProjectFactory: () =>
        createLazyKojo2ProjectOptions({
          loadAdapter: async () => kojo2AdapterForProject(kernel.project.current()) ?? undefined,
        }),
    });
    return () => handle.dispose();
  }, [kernel, notify]);

  // 覆盖层 / 命令槽位的主机接线（diff · 文件历史 · 调用层级 · 操作历史）：整段只吃 kernel、
  // 依赖数组仍是 [kernel]——抽到 shell-overlays.ts 的自定义钩子，在同一位置无条件调用，
  // React 钩子次序不变。
  useShellOverlays(kernel);

  /* --------- Kojo 2.0 迁移向导入口（K2-MIGRATE-MOUNT；开关关 = 零注册） --------- */

  /**
   * 迁移候选根：口上域 ∪ 会话附加根（与文件树 / `Ctrl+P` 的候选根同口径，只去字面重复）。
   *
   * 用 ref 镜像而不是闭包捕获：入口是在**命令按下那一刻**才去列举的，闭包不能拿
   * "开项目那会儿"的旧根（附加根是会话级可变状态）。
   */
  const migrateRootsRef = useRef<readonly string[]>([]);
  migrateRootsRef.current = project ? [...new Set([...project.kojoPaths, ...extraRoots])] : [];
  /** 通知通道镜像（`useNotify` 的返回身份不保证恒定，入口不该跟着重建） */
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  /**
   * Kojo 2.0 槽位账本（K2-STORAGE-SERVICE）：项目打开 / 关闭的**唯一**接线点。
   *
   * ① flag 关 ⇒ 直接返回：不建服务、不读盘、零写、零命令（服务内部另有同一道闸，双保险）；
   * ② 文档清单 = 项目口上根 ∪ 会话附加根里按 `.kojo2` 后缀现读；任何一根读不动、任何一份
   *    读不动都记 `complete=false`——服务据此**零写跳过**（把读不到当成删除会回收它的槽位，
   *    文件恢复后新声明就会读到旧存档字节）。**不并入**跨项目的常驻工作区根：那会把别的
   *    项目的声明算进本项目账本；
   * ③ adapter 动态 import（不进开机静态图）；装载失败只报一句，本轮不建服务；
   * ④ 打开之后才挂 `file.changed` 防抖刷新（K2-STORAGE-RECYCLED-UI 缺口②）：同一条
   *    `collectDocuments` 重列文档，交给 `refreshDeclarations`（失败不拆已 opened 实例）。
   *
   * 关闭 / 换项目 = effect 清理：先停刷新、摘监听、撤命令，再等还在飞的 open 落地后
   * `closeProject()`（flush 后丢弃实例；flush 失败由服务自己上屏）。`cancelled` 防的是
   * 「项目已经关了、文档才读完」的迟到装配。
   *
   * ⑤（S7-首屏字节）整族改走 `await import()`：服务本体 + 持久化 + 声明刷新 + 回收重试
   *    命令约 93 KB 源码原先随 App 静态进开机图，而这条链**只在 flag 打开且项目已开**时
   *    才用得上；「只认 v1」档上一个字节都不解析。装配次序一字未改，只多一次本地
   *    chunk 读取；`cancelled` 同时挡住"装载途中项目就关了"的迟到建服。
   */
  const [storageCommands, setStorageCommands] = useState<readonly ShellCommandSpec[]>([]);
  useEffect(() => {
    if (!kernel || !project) {
      setStorageCommands([]);
      return;
    }
    if (!isKojo2CutoverEnabled()) {
      setStorageCommands([]);
      return;
    }
    let cancelled = false;
    /**
     * 服务体在模块到位后才建（S7-首屏字节）。清理可能早于装载 ⇒ `null` 即"没建过、
     * 也没有什么要关"，不会漏掉一个已 opened 的实例。
     */
    let service: Kojo2StorageService | null = null;
    /** 本次装配的 open promise：清理时要等它落地再关，否则 close 会拿到 busy 而漏掉实例 */
    let opening: Promise<void> | null = null;
    /** 会话内声明刷新器（打开之后才建；清理时先 dispose，迟到的 collect 不会写账本） */
    let refresh: Kojo2DeclRefresh | null = null;
    let unFileChanged: (() => void) | null = null;

    /** 唯一递归列举口径：项目口上根 ∪ 会话附加根，只按 `.kojo2` 收文件 */
    const collectDocuments = async (): Promise<{
      documents: readonly { uri: string; source: string }[];
      documentsComplete: boolean;
    }> => {
      const roots = [...new Set([...project.kojoPaths, ...extraRootsRef.current])];
      const documents: { uri: string; source: string }[] = [];
      let complete = roots.length > 0;
      for (const root of roots) {
        if (cancelled) return { documents, documentsComplete: false };
        try {
          const entries = await kernel.io.walkDir(root, {
            includeFiles: true,
            includeDirs: false,
            filter: (entry) => entry.isDirectory || isKojo2Path(entry.name),
          });
          for (const entry of entries) {
            if (cancelled) return { documents, documentsComplete: false };
            if (entry.isDirectory || !isKojo2Path(entry.name)) continue;
            try {
              const text = await kernel.io.readText(entry.path);
              documents.push({ uri: entry.path, source: text.text });
            } catch {
              complete = false;
            }
          }
        } catch {
          complete = false;
        }
      }
      return { documents, documentsComplete: complete };
    };

    void (async () => {
      // 三件套一次性并行装载：服务本体、声明刷新器、回收重试命令。三者同属一族（服务是
      // 另两个的入参），拆成三条懒边只会多两次请求，不会多省一个字节。
      const [storageService, declRefresh, retryCommand] = await Promise.all([
        import('./kojo2-storage-service'),
        import('./kojo2-storage-refresh'),
        import('./kojo2-storage-retry-command'),
      ]);
      if (cancelled) return;
      const svc = storageService.createKojo2StorageService({
        kernel,
        notify: (notice) => notifyRef.current(notice),
      });
      service = svc;
      // 回收阻断的二次入口：与 toast 动作同一个 retryWithRecycledAllowed（不新造通知系统）
      setStorageCommands([
        retryCommand.createKojo2StorageRetryCommand({
          service: svc,
          notify: (notice) => notifyRef.current(notice),
        }),
      ]);
      const initial = await collectDocuments();
      if (cancelled) return;
      const adapter = await loadKojo2StorageAdapter(project, (reason) =>
        notifyRef.current({
          kind: 'error',
          message: `Kojo 2.0 存储期事实不可用，本次不写槽位账本（项目其余功能不受影响）：${reason}`,
        }),
      );
      if (cancelled || adapter === null) return;
      opening = svc
        .openProject({
          projectKey: pathKey(project.rootDir),
          documents: initial.documents,
          adapter,
          documentsComplete: initial.documentsComplete,
        })
        .then(() => undefined);
      await opening;
      if (cancelled) return;
      // 打开之后再挂刷新：不要在装配途中的 file.changed 上抢跑（那时还没有实例可刷新）
      const controller = declRefresh.createKojo2DeclRefresh({
        service: svc,
        collect: collectDocuments,
        isKojo2Path,
        onFailure: (message) => notifyRef.current({ kind: 'error', message }),
      });
      refresh = controller;
      unFileChanged = kernel.bus.on('file.changed', (ev) => controller.noteChange(ev.path));
    })().catch((error: unknown) => {
      notifyRef.current({
        kind: 'error',
        message: `Kojo 2.0 槽位账本装配失败（项目其余功能不受影响）：${errorText(error)}`,
      });
    });
    return () => {
      cancelled = true;
      refresh?.dispose();
      unFileChanged?.();
      setStorageCommands([]);
      void (async () => {
        // 先让还在飞的 open 落地（服务对并发 close 只回 busy），再等声明刷新收尾，最后关：
        // 不留没有 flush 的实例，也不让一次 300ms 内的刷新把 close 挤成 busy。
        if (opening !== null) await opening.catch(() => undefined);
        if (refresh !== null) await refresh.whenIdle();
        await service?.closeProject();
      })();
    };
  }, [kernel, project?.rootDir]);

  const [migrateEntry, setMigrateEntry] = useState<Kojo2MigrateEntry | null>(null);
  const [migrateState, setMigrateState] = useState<Kojo2MigrateEntrySnapshot | null>(null);

  /**
   * `.kojo` → `.kojo1` 改名工具（LAU-3b）。
   *
   * 状态三分：`open=false` 零动作；`open=true && paths===null` 正在列清单（遮罩已在外层）；
   * `paths!==null` 把清单交给对话框（对话框自己读正文 / 分候选 / 落地）。
   * 列举口径复用 `listSourceFiles`（与迁移向导 / 快速打开同一条递归列举），不另写一套。
   */
  const [legacyRenameOpen, setLegacyRenameOpen] = useState(false);
  const [legacyRenamePaths, setLegacyRenamePaths] = useState<readonly string[] | null>(null);
  const openLegacyRename = useCallback((): void => {
    if (kernel === null) return;
    setLegacyRenameOpen(true);
    setLegacyRenamePaths(null);
    const io = kernel.io;
    void listSourceFiles(io.walkDir.bind(io), migrateRootsRef.current).then(
      (paths) => setLegacyRenamePaths(paths),
      (e: unknown) => {
        setLegacyRenameOpen(false);
        notifyRef.current({
          kind: 'error',
          message: `列举旧 .kojo 文件失败：${e instanceof Error ? e.message : String(e)}`,
        });
      },
    );
  }, [kernel]);
  const closeLegacyRename = useCallback((): void => {
    setLegacyRenameOpen(false);
    setLegacyRenamePaths(null);
  }, []);

  /**
   * 入口与 kernel 同生命周期（换内核 = 换 io，旧入口的写端口作废）。
   *
   * `listFiles` 复用 `commands.ts` 的 `listSourceFiles`（宿主唯一的递归列举口径），
   * 收口由入口按 `.kojo` 做——这里不另写第二份扩展名判据。
   */
  useEffect(() => {
    if (kernel === null) {
      setMigrateEntry(null);
      setMigrateState(null);
      return;
    }
    const io = kernel.io;
    const entry = createKojo2MigrateEntry({
      io,
      listFiles: () => listSourceFiles(io.walkDir.bind(io), migrateRootsRef.current),
      /**
       * 刷新走宿主**既有**通道：`file.changed` 一条事件同时喂给两侧——
       * 文件树（`affectsKojoTree` 过滤 + 400ms 合批重列）与已开编辑器
       * （外部改动重载：干净即静默重载、脏则交作者选）。**不自造第二条刷新链**。
       *
       * `kind: 'change'`：迁移只改内容（原地改写，不改名不删源），不是新增/删除。
       */
      refreshFiles: (paths) => {
        for (const path of paths) kernel.bus.emit('file.changed', { kind: 'change', path });
      },
      notify: (message) => notifyRef.current({ kind: 'info', message }),
    });
    setMigrateEntry(entry);
    setMigrateState(entry.getSnapshot());
    return entry.subscribe(setMigrateState);
  }, [kernel]);

  /**
   * 命令表：开关关 ⇒ 空数组（零注册，命令面板 / 快捷键表里一个字都不出现）。
   * 与 `monaco/languages.ts` 同一条生效时机口径——开关在**装配那一刻**读，
   * 翻了要重载窗口才换表（本批不提供运行时热切换）。
   */
  const migrateCommands = useMemo<readonly ShellCommandSpec[]>(
    () => migrateEntry?.commands() ?? [],
    [migrateEntry],
  );

  /**
   * 项目视图的壳层命令 = 迁移入口 ∪ 槽位账本重试。两者在开关关时都是空数组
   * （迁移入口自己判/槽位账本的 effect 根本不建服务），所以这里不重复读开关。
   * 合并一次 memo：`ProjectView` 的 `extraShellCommands` 身份稳定，注册表不随每帧重建。
   */
  const shellCommands = useMemo<readonly ShellCommandSpec[]>(
    () => [
      ...migrateCommands,
      ...storageCommands,
      // LAU-3b：旧 `.kojo` → `.kojo1` 改名（只改名、不改内容；只读域由内核闸拒绝）。
      // 常驻在项目视图的命令表里：它不是"开关开才有"的功能，任何档位都可能需要把旧文件
      // 预先标成封存形态。
      {
        id: 'workbench.legacyRename',
        title: '把旧 .kojo 文件改名为 .kojo1（封存）',
        category: '工作台',
        run: openLegacyRename,
      },
      // 启动器实例库（L5）：键位按 LAUNCHER-ARCHITECTURE §14.4 的 Ctrl+Alt+O
      //（Ctrl+N 已被 kojo.newKojoFile 占用、F5 归 WebView2，两条都刻意避开）。
      {
        id: 'launcher.openInstances',
        title: '启动器：打开实例库',
        category: '启动器',
        keybinding: 'ctrl+alt+o',
        run: () => setLauncherOpen(true),
      },
    ],
    [migrateCommands, storageCommands, openLegacyRename],
  );

  // 结构解析叠层（默认开；只有显式 `off` 才算关，见 `monaco/tree-sitter-pref.ts`）的回落必须可见（铁律 4）：wasm / worker / 解析任何一路不通
  // 都自动退回原有的着色与折叠，但"退回了"这件事由这里上一条通知。台账按消息去重 ⇒
  // 同一种错一次会话只说一遍（`monaco/tree-sitter/fallback.ts`），不随编辑重复弹。
  useEffect(
    () =>
      onStructureDegradation((degradation) =>
        notify({ kind: 'error', message: degradationNoticeText(degradation) }),
      ),
    [notify],
  );

  // BUG-5：监视器自述必须可见。`partial` / `unavailable` 意味着"某些目录的外部改动
  // 不会自动重载"——这正是过去静默失灵的形状（用户以为会自动重载，其实句柄早没了）。
  // `watching` 不提示：它是常态，不是需要用户处置的事。
  // P0-5 重连三态：`reconnecting` 只在**首次进入**时提示一次（内核按次发布进度，
  // 逐条弹会刷屏）；从 `reconnecting` 恢复回 `watching` 必须报喜（不静默）——
  // 正常打开项目的 `watching` 不在报喜之列，靠上一状态区分。
  useEffect(() => {
    if (!kernel) return;
    let prev: FileWatchStatus | null = null;
    const un = kernel.bus.on('file.watchState', (st) => {
      const prior = prev;
      prev = st.status;
      if (st.status === 'reconnecting') {
        if (prior !== 'reconnecting') {
          const detail = st.failures.map((f) => `${f.root} — ${f.reason}`).join('；');
          notify({
            kind: 'info',
            message:
              '文件监视暂时不可用，正在自动重连：' +
              `${detail || '(未给出原因)'}。期间外部改动不会自动重载，可点各面板的「刷新」按钮手动重扫。`,
          });
        }
        return;
      }
      if (st.status === 'watching' || st.status === 'stopped') {
        if (st.status === 'watching' && prior === 'reconnecting') {
          notify({ kind: 'info', message: '文件监视已恢复，外部改动将自动重载。' });
        }
        return;
      }
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
      // 2.0 文件同样先过入口闸（K2-EDITOR-OPEN-PATHS）：`v1-only` 阶段点开一份 `.kojo2`
      // （如向导刚建的那份）给一句人话，而不是把它当纯文本悄悄开出来。
      // `routeOpenPath` / `rootDirRef` 都声明在本 effect **之后**：回调是异步的（总线事件），
      // 执行时绑定早已初始化——与下面 `requestOpenFile` 同一条既有先例。
      routeOpenPath(ev.filePath, rootDirRef.current, () => {
        // W7-B：`focus: false`（检索框逐项跳）一路带到编辑器——定位但不抢焦点，
        // 老发起方不带这个键 ⇒ 仍按现行行为聚焦。
        requestOpenFile(ev.filePath, ev.line ?? 1, ev.column, ev.span, false, ev.focus);
        // 同款记录（MM-7）：问题面板/转到定义/查找引用/函数树跳转来的打开也进最近文件
        recordRecentFile(ev.filePath);
      });
    });
    return () => {
      un();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernel]);

  // PEEK-STACK：同文件就地跳转（不经过 revealLocation）也要进导航历史——插件侧只记账、
  // 宿主在这里**只**pushNav，绝不 requestOpenFile（那会导致跳两次）。
  useEffect(() => {
    if (!kernel) return;
    const un = kernel.bus.on('editor.navigated', (ev) => {
      const t = revealTargetOf({ line: ev.line, column: ev.column, span: ev.span }, Date.now());
      const endCol =
        t.column !== undefined && t.span !== undefined && t.span.columnEnd > t.column
          ? t.span.columnEnd
          : undefined;
      navRef.current = pushNav(
        navRef.current,
        {
          path: ev.filePath,
          line: t.line,
          ...(t.column !== undefined ? { column: t.column } : {}),
          ...(endCol !== undefined ? { endColumn: endCol } : {}),
        },
        rootDirRef.current,
      );
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

  // 问题面板行内修复的宿主座（P2-13）：面板静态模块图零 Monaco，文本读数与落地
  // 都从这座上过；座为 null（未挂载 / 已卸载）⇒ 面板不给修复按钮——能力缺席是
  // 可见的（没有按钮），不是按了没反应的死按钮（铁律 4）。判据全在 problem-fix，
  // 这里只递能力：贡献快照 / 项目 / model 读数（openModelAcrossGroups）/
  // 落地（problem-fix-apply 动态 import，Monaco 不进 App 静态图）。
  // 注册本身也走**动态 import**（PS-10 开机图闸）：problem-fix → kojo-code-action →
  // sugar 词表那条链不该因这条接线提前进 eager 图——面板住懒链，座的注册早于
  // 面板首帧即可；卸载清座与注册共享同一 import promise，then 排队保序。
  useEffect(() => {
    if (!kernel) return;
    let disposed = false;
    void import('./problem-fix').then((m) => {
      if (disposed) return;
      m.setProblemFixHost({
        codeActionContributions: () => kernel.slots.query('ui.editor.codeAction'),
        project: () => kernel.project.current(),
        documentOf: (path) => {
          const model = openModelAcrossGroups(path);
          if (!model || model.isDisposed()) return null;
          return {
            text: model.getValue(),
            lineCount: model.getLineCount(),
            versionId: model.getVersionId(),
          };
        },
        applyRowFix: (path, planned) =>
          import('./problem-fix-apply').then((mm) => mm.applyPlannedLineEdits(path, planned)),
      });
    });
    return () => {
      disposed = true;
      void import('./problem-fix').then((m) => m.setProblemFixHost(null));
    };
  }, [kernel]);

  /** 旧项目的一套 UI 态整体带走：切项目与关项目共用，防旧标签/脏态/待确认残留到下一拍 */
  const resetProjectUiState = useCallback(() => {
    setEditorGroups(initialEditorGroups()); // 组态整体重置为单组空栈（SPLIT-1：分屏不跨项目存活）
    setDirtyPaths(new Set());
    setPinnedPaths(new Set()); // pin 是标签态的一部分，随标签一起清（C2）
    mruRef.current = {}; // 最近使用序同理清账（预览态住在组态里，随上面那行一起没）
    setExtraRoots([]); // 会话级附加根是项目会话的一部分（D1）：换项目即清，绝不带进下一个
    setPendingClose(null);
    setReveal(null);
  }, []);

  /**
   * 项目生命周期整体交给 `use-project-session.ts`（REF-FRONT-PERF）：
   * openProject（换根守卫 / 插件注册 / 写允许域 / 审批 / 索引 / 会话恢复）+
   * closeProject（try/finally 拆除序）+ 审批。函数体与 effect 顺序逐字搬迁，
   * 依赖数组不变；唯一的结构差别是「谁来调用」改为本组件注入。
   *
   * 刻意留在 App 的：decideProjectClose / decideProjectSwitch（保存确认与退出放行编排）、
   * 欢迎页恢复入口、会话 flush 的**触发位置**（见下方 useSessionFlush，effect 次序不变）。
   */
  const { openProject, closeProject, decideApproval, requestReauth } = useProjectSession({
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
  });

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

  /**
   * 「从工作区移除文件夹」（WS-08）：附加根只能加不能减的欠账，收在这里。
   * 判据与去重走 `planRemoveExtraRoot`（pathKey 判等）；移除后：
   * - 文件树 / 检索 / 监视都按既有活读（`extraRoots` 是它们的 props / 依赖）自然更新，
   *   这里不额外通知任何组件；
   * - 会话 flush 的依赖里有 extraRoots ⇒ 下一次 debounce 就会把新清单落盘。
   * 没命中（例如别的入口已经删过）也给人话，按下去必须有响（铁律 4）。
   */
  const removeExtraRoot = useCallback(
    (dir: string) => {
      const plan = planRemoveExtraRoot(extraRoots, dir);
      setExtraRoots(plan.roots);
      notify({ kind: 'info', message: plan.note });
    },
    [extraRoots, notify],
  );

  /**
   * 分隔条松手时回报的比例（WS-06）：拖动过程 ProjectView 只改 DOM flex，
   * 落定才喊一次；值没变就不 setState（免得拖回原位也触发一次落盘）。
   */
  const onSplitSizesChange = useCallback((next: readonly number[]) => {
    if (splitSizesEqual(splitSizesRef.current, next)) return;
    splitSizesRef.current = next;
    setSplitSizes(next);
  }, []);

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

  const commitOpenFile = useCallback(
    (path: string, line?: number, column?: number, span?: RevealSpan, preview = false, focus?: boolean) => {
      // SPLIT-1：开进焦点组。preview=true ⇒ 就地替换本组那张预览（规则在 tabs-ops 一份）
      setEditorGroups((prev) =>
        preview ? openPreviewInActiveGroup(prev, path, (p) => dirtyRef.current.has(p)) : openInActiveGroup(prev, path),
      );
      // 最近使用序：打开/换到 = 提到最前（脏判定与预览替换都归组态那边，这里只记顺序）
      const gid = editorGroupsRef.current.activeGroupId;
      mruRef.current = { ...mruRef.current, [gid]: touchMru(mruRef.current[gid] ?? [], path) };
      // W9：区间一路带到编辑器（退化判据唯一住在 `revealTargetOf`，这里不许再折一次列）
      // W7-B：焦点选项同拍透传（`false` = 键盘逐项跳，定位后不抢检索框焦点）
      const target = line ? revealTargetOf({ line, column, span, focus }, Date.now()) : null;
      setReveal(target);
      // MM-6：导航历史同拍入栈。行/列/区间取本次 reveal 的落点（没给行 = 第 1 行；
      // NAV-1：列与区间终点一并记下，回跳才回得到原列而不是行首。区间只在**真给了宽度**
      // 时记（零宽等价于只有列，与两条 editor opener 的升级判据同口径）。
      // rootDir 可能还是 null（欢迎页期的跳转）——照记，项目一出现按跨项目规则整段作废。
      const navColumn = target?.column;
      const navEndColumn =
        navColumn !== undefined && target?.span !== undefined && target.span.columnEnd > navColumn
          ? target.span.columnEnd
          : undefined;
      navRef.current = pushNav(
        navRef.current,
        {
          path,
          line: target?.line ?? 1,
          ...(navColumn !== undefined ? { column: navColumn } : {}),
          ...(navEndColumn !== undefined ? { endColumn: navEndColumn } : {}),
        },
        rootDirRef.current,
      );
    },
    [],
  );

  /**
   * Ctrl+Tab / Ctrl+Shift+Tab 的落地（1020 编辑器体感批）。
   *
   * 意图从 `tab-cycle` 订阅进来（命令注册在壳层，标签真源在这里），走的是既有
   * `activateTabInGroupState`——那条函数在激活的同时把预览转正，所以"用 Ctrl+Tab 停在
   * 一张预览上"这一步就把它变成常驻标签（作者既然专门切回来，就不是瞄一眼）。
   *
   * 连按是在 MRU 序里继续走（`cycleRef` 记第几下 + 时间戳，超过 1.2 秒视为重新开始）；
   * 只剩一张标签 ⇒ 一句人话，不静默（铁律 4）。
   */
  const cycleRef = useRef<{ readonly dir: TabCycleDirection; readonly at: number; readonly presses: number }>({
    dir: 'next',
    at: 0,
    presses: 0,
  });
  const cycleTab = useCallback(
    (dir: TabCycleDirection) => {
      const g = activeGroupOf(editorGroupsRef.current);
      const cleaned = pruneMru(mruRef.current[g.id] ?? [], g.tabs);
      mruRef.current = { ...mruRef.current, [g.id]: cleaned };
      if (cleaned.length < 2) {
        notify({ kind: 'info', message: '这组里只有一张标签，没有可切换的上一次' });
        return;
      }
      const now = Date.now();
      const again = cycleRef.current.dir === dir && now - cycleRef.current.at < 1200;
      const presses = again ? cycleRef.current.presses + 1 : 0;
      cycleRef.current = { dir, at: now, presses };
      const target = stepMru(cleaned, g.active, dir, presses);
      if (target === null) return;
      setEditorGroups((prev) => activateTabInGroupState(prev, g.id, target));
      mruRef.current = { ...mruRef.current, [g.id]: touchMru(cleaned, target) };
    },
    [notify],
  );
  useEffect(() => subscribeTabCycle(cycleTab), [cycleTab]);

  const requestOpenFile = useCallback(
    (path: string, line?: number, column?: number, span?: RevealSpan, preview = false, focus?: boolean) => {
      // P3 多标签：切换标签不丢内容（model 留内存），无需未保存确认
      commitOpenFile(path, line, column, span, preview, focus);
    },
    [commitOpenFile],
  );
  // 项目生命周期 hook 早于本行声明调用；它经 ref 取最新引用（本回调 deps 空、引用恒定）
  requestOpenFileRef.current = requestOpenFile;

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
   * `.kojo2` 的入口闸（K2-EDITOR-OPEN-PATHS）：所有打开入口先过这一拍，再过改动前那条路。
   *
   * - 开关关 / 不是 2.0 文件 ⇒ `routeKojo2OpenPath` 返回 `off` / `not-kojo2`，这里立刻
   *   调 `open()`（= 改动前那一条路，**逐字未变**）；
   * - 开关开 + `.kojo2` ⇒ 走 batch-3 的路由（当前项目内直接开 / 切项目并排队）或
   *   阶段闸的 `blocked`（`v1-only` 阶段人话已上屏，**不开空编辑器**）。
   *
   * `rootDir` 是"这份文件属于哪个项目"：文件树/快速打开 = 当前根；欢迎页最近文件 =
   * 记录里带的那个根（换项目时走 openProject 的 pendingOpenFile 腿）。
   */
  const routeOpenPath = useCallback(
    (path: string, rootDir: string | null, open: () => void): void => {
      const plan = routeKojo2OpenPath(
        { path, rootDir },
        { currentRoot: rootDirRef.current, projectOpen: rootDirRef.current !== null },
        {
          openFile: open,
          openProject: (root, opts) => void openProject(root, { pendingOpenFile: opts.pendingOpenFile }),
          notify: (message) => notify({ kind: 'info', message }),
        },
      );
      if (plan.kind === 'off' || plan.kind === 'not-kojo2') open();
    },
    [openProject, notify],
  );

  /**
   * MM-7 欢迎页「最近文件」点击：同项目（根未变且项目开着）⇒ 直接开文件；
   * 换了项目 ⇒ 先开项目，pendingOpenFile 在 openProject 成功路径末尾落地
   * （打开失败绝不顺带打开文件）。
   *
   * 2.0 文件先过 `routeOpenPath`（K2-EDITOR-OPEN-PATHS）：开关打开时 `.kojo2` 由它
   * 决定"直接开 / 切项目 / 被阶段拦下说一句"，非 2.0 文件照下面这条老路走。
   */
  const openRecentFile = useCallback(
    (path: string, rootDir: string) => {
      routeOpenPath(path, rootDir, () => {
        if (rootDirRef.current === rootDir && project) {
          requestOpenFile(path);
          return;
        }
        void openProject(rootDir, { pendingOpenFile: path });
      });
    },
    [project, openProject, requestOpenFile, routeOpenPath],
  );

  /**
   * 文件树 / 快速打开的打开入口。`opts.preview = true` ⇒ **预览态**打开（单击浏览：斜体标签、
   * 不占新位，下一次单击换掉它）；双击与所有"跳转类"入口都不带这个旗标 = 永久打开。
   */
  const openFile = useCallback(
    (path: string, opts?: OpenFileOptions) => {
      routeOpenPath(path, rootDirRef.current, () => {
        requestOpenFile(path, undefined, undefined, undefined, opts?.preview === true);
        recordRecentFile(path); // MM-7：文件树/快速打开的落地也进最近文件
      });
    },
    [requestOpenFile, recordRecentFile, routeOpenPath],
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
          // 拖放的文件也只喂既有打开入口；2.0 文件先过阶段闸（开关关着 = 直通，逐字不变）
          openFile: (p) => routeOpenPath(p, rootDirRef.current, () => requestOpenFile(p)),
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
  }, [kernel, notify, requestOpenFile, openProject, routeOpenPath]);

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

  /** 点某组的标签 = 切到该组并激活该标签（activateTab 纯函数一并处理焦点转移与预览转正） */
  const activateTabInGroup = useCallback((groupId: string, path: string) => {
    setEditorGroups((prev) => activateTabInGroupState(prev, groupId, path));
    mruRef.current = { ...mruRef.current, [groupId]: touchMru(mruRef.current[groupId] ?? [], path) };
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

  /**
   * 向右拆分（VSCode 同款：新组携带焦点组激活标签，焦点跟到新组）。
   * MM-9：拆分方向即排列方向——column 态下只拆不翻 orientation 的话，数组插位
   * 在视觉上是「向下」，「向右拆分」就说了谎。方向随拆分钉为 row，命令名恒真。
   */
  const splitEditor = useCallback(() => {
    setEditorGroups((prev) => setGroupsOrientation(splitActiveRight(prev), 'row'));
  }, []);

  /**
   * 向下拆分（MM-9：长口上下对照）：同 splitActiveRight 语义，新组插在焦点组
   * 下方（数组序即排列序——row 从左到右、column 从上到下）。
   * MM-9：与 splitEditor 对称——拆分同时把排列钉为 column，作者按「向下拆分」
   * 得到的就是上下两组（缺省 row 态下一次到位，不必再手动翻排列）。
   */
  const splitEditorDown = useCallback(() => {
    setEditorGroups((prev) => setGroupsOrientation(splitActiveDown(prev), 'column'));
  }, []);

  /**
   * 翻编辑器组排列方向（MM-9）：row 左右并排 / column 上下堆叠。
   * 单组时翻了也看不出来 ⇒ 这里直接拒（原样返回）；可见的那句人话由
   * ProjectView 的命令包装给（铁律 4）。
   */
  const setGroupsOrientationDir = useCallback((dir: 'row' | 'column') => {
    setEditorGroups((prev) => (prev.groups.length > 1 ? setGroupsOrientation(prev, dir) : prev));
  }, []);

  /**
   * 按**排列序**聚焦编辑器组（WS-14 · `Ctrl+1/2/3…`，对标 VS Code 的
   * `View: Focus First/Second/Third Editor Group`）。
   *
   * 序号取排列序而不是 id：id 是创建序，拆分/关组后与"屏幕上从左数第几格"会分叉，
   * 而作者按键时想的就是那一格。
   * 没有这一组 ⇒ 一句人话（铁律 4）：按下去没动静会被读成"快捷键坏了"。
   */
  const focusGroupByOrdinal = useCallback(
    (ordinal: number) => {
      const prev = editorGroupsRef.current;
      const next = focusGroupAtOrdinal(prev, ordinal);
      if (next === prev) {
        notify({
          kind: 'info',
          message: `现在只有 ${prev.groups.length} 个编辑器组——先按 Ctrl+\\ 拆分，再按 Ctrl+${ordinal + 1}`,
        });
        return;
      }
      setEditorGroups(next);
    },
    [notify],
  );

  /** 组间焦点切换（WS-14，环形）：单组没有"隔壁"，同样给人话不静默 */
  const cycleGroupBy = useCallback(
    (delta: 1 | -1) => {
      const prev = editorGroupsRef.current;
      const next = cycleActiveGroup(prev, delta);
      if (next === prev) {
        notify({ kind: 'info', message: '只有一个编辑器组——先按 Ctrl+\\ 拆分出第二格' });
        return;
      }
      setEditorGroups(next);
    },
    [notify],
  );

  /**
   * 键盘调整焦点组的份额（WS-14：分隔条原来只有鼠标能拖）。动的是焦点组与其**右侧**
   * （末组则左侧）那一条分隔条，判据与钳制全在 `editor-groups.resizeGroupShare`。
   *
   * 挪不动 ⇒ 报"已到边界"而不是静默；真的变了才 setState——份额是会话落盘的依赖，
   * 白写一帧等于白拍一次盘（与拖拽那条 `onSplitSizesChange` 同一写法：先更 ref 再 setState，
   * 连按时下一拍读到的就是刚写进去的那份）。
   */
  const resizeActiveGroupBy = useCallback(
    (delta: 1 | -1) => {
      const prev = editorGroupsRef.current;
      if (prev.groups.length < 2) {
        notify({ kind: 'info', message: '只有一个编辑器组——先按 Ctrl+\\ 拆分出第二格' });
        return;
      }
      const next = resizeGroupShare(
        splitSizesRef.current,
        prev.groups.length,
        activeGroupOrdinal(prev),
        delta,
      );
      if (next === null) {
        notify({
          kind: 'info',
          message: delta > 0 ? '这一组已经放到最宽（相邻那组只剩一成）' : '这一组已经收到最窄（一成下限）',
        });
        return;
      }
      splitSizesRef.current = next;
      setSplitSizes(next);
    },
    [notify],
  );

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
   * NAV-1：条目记下的列/区间随落地一并交回（`navEntrySpan`），回跳落回原列而不是行首。
   * 到栈底 ⇒ 人话拒绝（铁律 4：按了必须有反应，不静默）。
   */
  const navBack = useCallback(() => {
    const moved = navBackInHistory(navRef.current);
    if (!moved.entry) {
      notify({ kind: 'info', message: '已经后退到最早的位置了' });
      return;
    }
    navRef.current = moved.state;
    commitOpenFile(moved.entry.path, moved.entry.line, moved.entry.column, navEntrySpan(moved.entry));
  }, [commitOpenFile, notify]);

  /** 前进（MM-6，Alt+→）：光标后移；到栈顶 ⇒ 人话拒绝（同 navBack 的铁律；列/区间同款交回） */
  const navForward = useCallback(() => {
    const moved = navForwardInHistory(navRef.current);
    if (!moved.entry) {
      notify({ kind: 'info', message: '已经前进到最新的位置了' });
      return;
    }
    navRef.current = moved.state;
    commitOpenFile(moved.entry.path, moved.entry.line, moved.entry.column, navEntrySpan(moved.entry));
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

  /**
   * 跨组移动标签（1027：拖拽到别组 / 右键「移动到组」）。
   *
   * 规则全在 `editor-groups.moveTabBetweenGroups`（固定区钳位 / 源组邻居落点 / 空组不回收 /
   * 预览转正），这里只负责三件宿主的事：定位清除（焦点与激活都换了组）、组态写回、
   * 以及 MRU 账（源组摘掉、目标组按 `activateTabInGroup` 同一条 touchMru 口径置顶）。
   */
  const moveTabBetweenGroups = useCallback(
    (path: string, fromGroupId: string, toGroupId: string, toIndex?: number) => {
      const prev = editorGroupsRef.current;
      const dest = prev.groups.find((g) => g.id === toGroupId);
      const at = toIndex ?? dest?.tabs.length ?? 0;
      const next = moveTabBetweenGroupsState(prev, path, fromGroupId, toGroupId, at, pinnedRef.current);
      if (next === prev) return; // 无操作（同组 / 状态已变）：连 return 都不惊动渲染
      if (
        prev.activeGroupId !== next.activeGroupId ||
        activeGroupOf(prev).active !== activeGroupOf(next).active
      ) {
        setReveal(null);
      }
      setEditorGroups(next);
      const fromMru = (mruRef.current[fromGroupId] ?? []).filter((p) => p !== path);
      mruRef.current = {
        ...mruRef.current,
        [fromGroupId]: fromMru,
        [toGroupId]: touchMru(mruRef.current[toGroupId] ?? [], path),
      };
    },
    [],
  );

  /** 全部保存（Ctrl+Shift+S；壳层命令经 ProjectView 注入；SPLIT-1 起跨组逐组保存） */
  const saveAll = useCallback(async (): Promise<boolean> => {
    for (const a of actionsByGroupRef.current.values()) {
      if (!(await a.saveAll())) return false;
    }
    return true;
  }, []);

  /**
   * 真另存为（1028 批）：把**活动标签**的 buffer 转档到对话框选定的新路径。
   *
   * 判据与落盘全在懒面 `file-save-as.ts`（`await import` 拉入，不进开机图；裁决 5 的
   * 可测性要求）；本回调只递宿主事实——各登记处（model 池 / 脏态 / 固定态 / 组态标签 /
   * journal / EditorPane 内三张 ref 账 / 内核编码缓存）的迁移都发生在流的成功回调里，
   * **一枚都不许漏**：漏一条就是"旧路径还挂在某本账上冒充在册"。
   *
   * 通道不换（裁决 2）：落点由对话框选、但**对话框只交回路径不写盘**，落盘走带闸的
   * `kernel.io`（`isWritable` 预检 + 写域双闸），域外目标诚实拒绝并指向『导出』——本批
   * 没有新增第四条域外写通道，游戏根照样整体只读。
   */
  const saveAs = useCallback(async (): Promise<void> => {
    const path = activeFileRef.current;
    if (!path) {
      notify({ kind: 'info', message: '没有活动文件，另存为无处落脚。' });
      return;
    }
    if (!kernel) return;
    const io = kernel.io;
    const { runSaveAsFlow } = await import('./file-save-as');
    const { saveBlockedByHostWriteDomain } = await import('./write-domain');
    // 全组标签里已开着的活 buffer（pathKey 归一），供"目标已有活 buffer ⇒ 拒绝"判据
    const openBufferKeys = new Set<string>();
    for (const g of editorGroupsRef.current.groups) for (const t of g.tabs) openBufferKeys.add(pathKey(t));
    const paneFor = (p: string): EditorPaneActions | undefined => {
      for (const a of actionsByGroupRef.current.values()) if (a.readBuffer(p) !== undefined) return a;
      return undefined;
    };
    const result = await runSaveAsFlow({
      currentPath: path,
      io,
      pick: (opts) => {
        const pickSavePath = io.pickSavePath;
        if (pickSavePath === undefined) {
          return Promise.reject(new Error('当前平台没有原生落点选择对话框（需要桌面壳）——另存为不会假装成功。'));
        }
        return pickSavePath.call(io, opts);
      },
      isWritable: (p) => io.isWritable(p),
      hostBlocked: (p) => saveBlockedByHostWriteDomain(p),
      hasLiveBuffer: (p) => pathKey(p) !== pathKey(path) && openBufferKeys.has(pathKey(p)),
      readSource: (p) => paneFor(p)?.readBuffer(p),
      saveCurrent: async () => {
        const a = paneFor(path);
        return a ? a.savePath(path) : false;
      },
      dialogConfirmsOverwrite: isTauri(),
      confirmOverwrite: (target) =>
        typeof window !== 'undefined' && window.confirm(`「${target}」已存在，确定覆盖吗？覆盖前的现状会先进本地历史。`),
      onTransferred: async (from, to, clean) => {
        // ① 池记录换键（monaco 图里，动态 import）⇒ 同 model 换身份，撤销栈随迁
        const poolModule = await import('./editor-model-pool-instance');
        poolModule.retargetSavedAsPath(from, to);
        // ② EditorPane 侧三张 ref 账 + entriesRef + 监听重挂（每组的这一格都过一遍）
        for (const a of actionsByGroupRef.current.values()) a.transferBuffer(from, to, clean);
        // ③ 组态标签：指向 from 的 tabs/active/preview 换成 to
        setEditorGroups((prev) => migrateGroupPathsAfterSaveAs(prev, from, to));
        // ④ 脏态与固定态：同一份口径精确随迁（旧路径不留悬空 pin / 幽灵脏点）
        setDirtyPaths((prev) => reconcilePathsAfterDiskChange(prev, [], [{ from, to }]));
        setPinnedPaths((prev) => reconcilePathsAfterDiskChange(prev, [], [{ from, to }]));
        // ⑤ journal 与视图状态随迁（动态 import：低频动作不该把这俩拖进开机图）
        const engine = autosaveRef.current;
        if (engine) {
          const records = [...actionsByGroupRef.current.values()].flatMap((a) => a.snapshots());
          void engine.snapshot(rootDirRef.current, records).catch(() => undefined);
        }
        const rootDir = rootDirRef.current;
        if (rootDir !== null) {
          void import('./view-state-store').then(
            (m) => m.renameViewStates(rootDir, [{ from, to }]),
            () => undefined, // 迁不上 = 视图状态退回按新路径现采，不绑死另存为
          );
        }
        // ⑥ 最近文件：新路径记一笔（转档的落点就是作者刚碰的文件）；索引按**新增**通知
        if (rootDir !== null) {
          const nextRecent = upsertRecentFile(recentFilesRef.current, { path: to, rootDir, now: Date.now() });
          if (!sameRecentFiles(recentFilesRef.current, nextRecent)) {
            recentFilesRef.current = nextRecent;
            setRecentFiles(nextRecent);
            void saveRecentFiles(kernel.storage.global(), nextRecent).catch(() => undefined);
          }
        }
        // ⑦ 文件历史 / 索引增量：另存为记成「盘上新增一个文件」（原路径还在，绝不复用 rename
        // 的成对迁移语义）；走新建文件同一条 changed 通知路径。
        void syncErbIndexAfterDiskChange({
          kernel,
          index: indexRef.current,
          notify,
          delta: { changed: [to] },
        }).catch((err: unknown) => {
          notify({ kind: 'error', message: `另存为后更新代码索引失败：${errorText(err)}——函数树可能少这一个新文件。` });
        });
      },
      notify: (kind, message) => notify({ kind, message }),
    }).catch((err: unknown) => {
      // 兜底闸：流里任何一枚没被就地处理的抛错都不许被调用方那发 `void onSaveAs()` 吞成
      // 静默（`ProjectView` 的命令 run 就是 `void`，未处理 rejection 屏上什么都不会出现）。
      // 走到这里一律按"没落成"出声，落点与文件一律以当下屏上读数为准，不许猜成功。
      notify({
        kind: 'error',
        message: `另存为没有走完：${errorText(err)}——按没落成处理，原文件与标签都保持原样。`,
      });
      return { kind: 'failed' as const, message: errorText(err) };
    });
    void result; // 结果的人话已在流里上屏（成功 / 取消 / 拒绝 / 失败各说各话）
  }, [kernel, notify]);

  /* -------------- 文件树编辑的标签收尾（B1；状态单源在此——树侧只发意图） -------------- */

  /** 标签/激活文件的最新值快照（回调经 ref 闭包下发，不能吃陈旧闭包） */
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;
  /** 固定标签的最新值快照（批量关闭计划 / 拖拽重排都要读当下值，同上） */
  const pinnedRef = useRef(pinnedPaths);
  pinnedRef.current = pinnedPaths;

  // 会话标签集落盘 + 项目拆除强刷（REF-FRONT-PERF：实现搬进 use-project-session.ts）。
  // **调用位置就是原来的两个 effect 位置**：debounce schedule 与 layout 相 flushNow 的
  // 注册次序不动；依赖数组在 WS-06/08 扩了布局签名 / 分屏比例 / 附加根——
  // 只改焦点、只翻方向、只拖分隔条、只加减附加根，现在各算一次真实变更并落盘。
  useSessionFlush({
    kernel,
    project,
    sessionFlushRef,
    openTabsRef,
    activeFileRef,
    pinnedRef,
    openTabs,
    activeFile,
    pinnedPaths,
    layoutSignature: groupsLayoutSignature(editorGroups),
    splitSizes,
    extraRoots,
  });

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
      // 改名收尾走**前缀感知**映射（WS-02）：目录改名后其下打开的文件标签 / 激活项都要跟随，
      // 精确 `from → to` 只会换掉目录那一条、子路径全留成悬空旧路径（幽灵标签）。
      nextGroups = {
        ...nextGroups,
        groups: nextGroups.groups.map((g) => ({
          ...g,
          tabs: g.tabs.map((t) => mapRenamedPath(t, renamed)),
          active: g.active ? mapRenamedPath(g.active, renamed) : null,
        })),
      };
      if (activeGroupOf(prevGroups).active !== activeGroupOf(nextGroups).active) setReveal(null);
      setEditorGroups(nextGroups);
      // 脏态与固定态收尾同一份口径（被删的含子路径退出、被改名的换新路径）：
      // 固定标签不留悬空 pin（C2）
      setDirtyPaths((prev) => reconcilePathsAfterDiskChange(prev, del, renamed));
      setPinnedPaths((prev) => reconcilePathsAfterDiskChange(prev, del, renamed));
      // K2 batch-5（K2-EDITOR-MOUNT ③）：改名 / 另存为改了扩展名（`.kojo` → `.kojo2`）时，
      // 语言判据的答案会跟着变；仍活着的 model 必须立刻重判，否则"文件已经叫 2.0 了，
      // 词法还挂在 v1 上"（整篇假错误）。重挂器住在 monaco 图里，与上面「切档后重挂」
      // 同一条纪律：**动态 import**，不让 App 的启动模块图拖 monaco 进来。
      // 池里没有这一份（改名链路重建 model 的常见情形）⇒ 那个函数返回 false、零动作。
      if (renamed.length > 0) {
        const pairs = renamed.map((r) => ({ from: r.from, to: r.to }));
        void import('./editor-model-pool-instance').then(
          (module) => {
            for (const pair of pairs) module.retargetKojo2RenamedModel(pair.from, pair.to);
          },
          () => undefined, // 重挂器装不上 = 停旧判据（下一份 model 建时仍会按新路径判）
        );
        // 视图状态（光标 / 折叠 / 查找）跟着改名走：旧键下的 slice 迁到新键，LRU 次序不变（WS-02）。
        // **动态 import**：改名是低频动作，而 store 带上 Monaco 视图态族的可序列化面（约 22 KB）
        // 不该因为这一条收尾挂进开机图——同上方 `editor-model-pool-instance` 的懒边纪律。
        const rootDir = rootDirRef.current;
        if (rootDir !== null) {
          void import('./view-state-store').then(
            (module) => module.renameViewStates(rootDir, renamed),
            (err: unknown) => {
              notify({ kind: 'error', message: `迁移编辑器视图状态失败：${errorText(err)}` });
            },
          );
        }
      }
      // 索引里的旧路径不会随盘上改名自己消失，被删的条目也不会自己退场（函数树 / 引用会留
      // 幽灵行）。WS-05 起走**增量**：改名按前缀映射其下已索引文件、删除按前缀移除条目，
      // 不再为一次改名重扫整棵树（那是几秒级的代价，而改的只是几份文件）。
      // 增量通道不可用（旧实现）时才退回既有整扫；两条腿的失败都如实出声（铁律 4）。
      const parser = kernel?.services.tryGet<ErbParserService>('erb.parser');
      if (kernel && (del.length > 0 || renamed.length > 0)) {
        void syncErbIndexAfterDiskChange({
          kernel,
          index: indexRef.current,
          notify,
          delta: { removed: del, renamed },
        }).then((outcome) => {
          if (outcome !== 'unsupported' || renamed.length === 0) return;
          if (!parser?.rebuildIndex) return;
          void parser.rebuildIndex().catch((err: unknown) => {
            notify({
              kind: 'error',
              message: `重建代码索引失败：${errorText(err)}。函数树与引用可能还停在旧路径上。`,
            });
          });
        });
      }
      // 最近文件：被删的摘除、被改名的**迁移**到新路径（含改名目录之下的子路径），
      // 有变化才落盘（无变化不惊动渲染与存储）
      const prevRecentFiles = recentFilesRef.current;
      const nextRecentFiles = removeRecentFiles(renameRecentFiles(prevRecentFiles, renamed), del);
      if (!sameRecentFiles(prevRecentFiles, nextRecentFiles)) {
        recentFilesRef.current = nextRecentFiles;
        setRecentFiles(nextRecentFiles);
        if (kernel) void saveRecentFiles(kernel.storage.global(), nextRecentFiles).catch(() => undefined);
      }
    },
    [kernel, notify],
  );

  /**
   * closeProject / decideApproval 已在 `useProjectSession` 里（REF-FRONT-PERF）：
   * 拆除序改由 `project-close.ts` 的 try/finally 保证——close 抛错也照样
   * fileWatch.stop / 清写允许域 / 状态复位，并显式报错。
   */

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
    void discardRecoveryJournal(autosaveRef.current).then((notice) => {
      if (notice) notify(notice);
    });
  }, [notify]);

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

  /**
   * 错误边界的两个出口（REF-FRONT-PERF）：
   * - 重试 = 换一个 lazy 实例（rejected promise 缓存在旧实例上）+ 边界清错重渲染；
   * - 回到欢迎页 = 走 closeProject（try/finally 保证监视/写域/状态都收干净）。
   */
  const retryProjectView = useCallback(() => {
    setProjectViewComponent(createProjectView());
  }, []);
  const exitProjectOnCrash = useCallback(() => {
    if (crashExitDecision(dirtyPaths.size) === 'close') {
      void closeProject();
      return;
    }
    // 崩溃后 EditorPane 已卸载，保存链路是空操作；直接 close 会经 dirtyPaths 清空
    // 触发 autosave journal 的 clear，把恢复件静默抹掉。这里只给「明确丢弃」出口，
    // 关闭通知或点「重试」都等于取消。
    notify({
      kind: 'error',
      message:
        `项目界面崩溃，当前有 ${dirtyPaths.size} 个文件未保存。回到欢迎页会丢弃这些未保存改动；` +
        '可以先点「重试」或关闭本条提示，留在崩溃页继续处理。',
      action: {
        label: '丢弃未保存改动并回到欢迎页',
        run: () => {
          void (async () => {
            const notice = await discardRecoveryJournal(autosaveRef.current);
            await closeProject();
            if (notice) notify(notice);
          })();
        },
      },
    });
  }, [closeProject, dirtyPaths, notify]);
  const dismissProjectError = useCallback(() => setError(null), []);
  /** 项目态错误（welcome/opening 由 WelcomeView 自己的错误区承担，不重复上屏） */
  const projectError = visibleProjectError(phase, errorBar?.message ?? null);

  /**
   * 全局右键路由（1023 覆盖面批 · WP0）：壳层根上收口一次，三级策略住在
   * `context-surfaces.ts`（显式面 → 输入框面 → 兜底）。这里只做三件放行判定 + 一次 preventDefault：
   *
   * - **Monaco 内部放行**：编辑器的原生菜单（剪切/复制/粘贴/转到定义/命令面板…）自己管，
   *   抢过来就是把现成功能做没了；
   * - **已被别的面处理**（`defaultPrevented`）：各面永远优先，根路由只兜没人管的地方
   *   ——React 的合成监听挂在 #root 上，冒泡到 window 时 `defaultPrevented` 已经落定；
   * - **其余一律阻断**：WebView2 的默认菜单把整页当文本框（刷新/另存为/检查…），
   *   在桌面壳里全是噪音。
   */
  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => {
      if (!(e.target instanceof Element)) return;
      if (e.target.closest('.monaco-editor') !== null) return;
      if (e.defaultPrevented) return;
      e.preventDefault();
      const target = e.target instanceof HTMLElement ? e.target : e.target.parentElement;
      if (target === null) return;
      const route = buildContextMenuRoute(target, e);
      if (route === null) return;
      openContextMenu({ x: e.clientX, y: e.clientY, ...route });
    };
    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
  }, []);

  const body =
    phase === 'project' && kernel && project ? (
      <ProjectErrorBoundary
        resetKey={project.rootDir}
        onRetry={retryProjectView}
        onExit={exitProjectOnCrash}
      >
        {/* 边界必须在 Suspense **外面**：lazy 的模块加载失败是渲染期异常，
            Suspense 只接挂起，接不住它 */}
        <Suspense fallback={<ProjectViewSkeleton />}>
          <ProjectViewComponent
            kernel={kernel}
            project={project}
            index={index}
            indexing={indexing}
            indexError={indexError}
            activeFile={activeFile}
            openTabs={openTabs}
            groups={editorGroups.groups}
            activeGroupId={editorGroups.activeGroupId}
            orientation={editorGroups.orientation}
            dirtyPaths={dirtyPaths}
            pinnedPaths={pinnedPaths}
            reveal={reveal}
            onOpenFile={openFile}
            recentFiles={recentOpenPaths}
            onRequestCloseTab={requestCloseTab}
            onActivateGroup={activateGroup}
            onActivateTabInGroup={activateTabInGroup}
            onRequestCloseTabInGroup={closeTabInGroup}
            onReorderTabInGroup={reorderTabInGroup}
            onTogglePinInGroup={togglePinInGroup}
            onBatchCloseTabInGroup={batchCloseInGroup}
            onMoveTabBetweenGroups={moveTabBetweenGroups}
            onSplitEditor={splitEditor}
            onSplitEditorDown={splitEditorDown}
            onSetGroupsOrientation={setGroupsOrientationDir}
            onFocusGroupOrdinal={focusGroupByOrdinal}
            onCycleActiveGroup={cycleGroupBy}
            onResizeActiveGroup={resizeActiveGroupBy}
            onCloseGroup={closeGroupById}
            onNavBack={navBack}
            onNavForward={navForward}
            onReopenClosedTab={reopenClosedTab}
            onSaveAll={saveAll}
            onSaveAs={saveAs}
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
            onRemoveExtraRoot={removeExtraRoot}
            extraShellCommands={shellCommands}
            splitSizes={splitSizes}
            onSplitSizesChange={onSplitSizesChange}
            recentProjects={recent}
            onOpenProject={openProject}
            onOpenProjectFolder={chooseAndOpen}
          />
        </Suspense>
      </ProjectErrorBoundary>
    ) : (
      <>
        <WelcomeView
          phase={phase}
          error={errorBar?.message ?? null}
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
          onOpenTutorial={openWelcomeTutorial}
        />
        {/* 无项目时的 overlay 宿主：教程等模态由插件常驻注册，宿主却只在 ShellLayout 里，
            这里补上同一份壳（打开/关闭订阅与 ShellLayout 同语义），教程才真的看得见 */}
        <WelcomeOverlayHost kernel={kernel} />
      </>
    );

  // 窗口框架常驻：标题栏只属于编辑器态（有项目）；无项目时整窗就是欢迎卡核心区的
  // 无边框弹窗（启动弹窗同尺寸）。正文与所有 fixed overlay 收进 `.app-frame-body`。
  return (
    <div
      ref={frameRef}
      className={`app-frame${project === null ? ' app-frame-popup' : ''}`}
      data-context-surface="app-fallback"
    >
      {project !== null ? <WindowChrome title={windowTitle} /> : null}
      <div className="app-frame-body">
        {phase === 'boot' ? <BootSplashView /> : body}
        {/* 项目态错误条（REF-FRONT-PERF）：写允许域注册/清除、授权失败的 error state
            原先只在欢迎页可见；这里固定左下显示、可关闭、同文案不重复刷屏。
            出路按钮（WRITE-ADMIT-SPLIT 出路①）与文案同一条 state：能走回去的错误才有按钮。 */}
        {projectError ? (
          <ProjectErrorNotice
            message={projectError}
            action={errorBar?.action ?? null}
            onDismiss={dismissProjectError}
          />
        ) : null}
        {/* 首启动纸条（用户反馈 2）：只在欢迎页弹（进了项目就不打扰），且只在从未看过时。
            「去绑定游戏根目录」先收纸条再走欢迎页那个同一个目录选择入口。 */}
        {devNoteOpen && phase === 'welcome' ? (
          <Suspense fallback={<div className="modal-mask" data-lazy-mount="dev-note" />}>
            <LazyDevNoteDialog
              onClose={closeDevNote}
              onOpenDirectory={() => {
                closeDevNote();
                void chooseAndOpen();
              }}
            />
          </Suspense>
        ) : null}
        {dropHint === 'shown' ? (
          <div className="drop-hint">{dropHintText()}</div>
        ) : null}
        {pendingApproval ? (
          <Suspense fallback={<div className="modal-mask" data-lazy-mount="approval" />}>
            <LazyWritableApprovalDialog project={pendingApproval} onDecide={decideApproval} />
          </Suspense>
        ) : null}
        {pendingClose ? (
          <Suspense fallback={<div className="modal-mask" data-lazy-mount="unsaved" />}>
            <LazyUnsavedConfirmDialog filePath={pendingClose} context="close" onDecide={decideClose} />
          </Suspense>
        ) : null}
        {pendingProjectClose ? (
          <Suspense fallback={<div className="modal-mask" data-lazy-mount="unsaved-files" />}>
            <LazyUnsavedFilesConfirmDialog paths={pendingProjectClose} onDecide={decideProjectClose} />
          </Suspense>
        ) : null}
        {pendingProjectSwitch ? (
          <Suspense fallback={<div className="modal-mask" data-lazy-mount="unsaved-files" />}>
            <LazyUnsavedFilesConfirmDialog
              context="switch"
              paths={pendingProjectSwitch.paths}
              onDecide={decideProjectSwitch}
            />
          </Suspense>
        ) : null}
        {/* Kojo 2.0 迁移向导（K2-MIGRATE-MOUNT）：只在入口状态为 open 时挂载，
            与其余模态同在根舞台（遮罩自己 fixed 铺满窗口）。应用 / 撤销后的刷新由入口
            经 `file.changed` 收尾，这里不重复接线。
            S7-首屏：向导本体走 `loadKojo2MigrateWizard` 的懒边，fallback 是同一层
            `overlay-backdrop`（向导自己也挂在它上面），装载窗口里遮罩已在位。 */}
        {kernel !== null && migrateEntry !== null && migrateState?.status === 'open' ? (
          <Suspense fallback={<div className="overlay-backdrop" data-lazy-mount="kojo2-migrate" />}>
            <LazyKojo2MigrateWizardHost
              io={kernel.io}
              filePaths={migrateState.filePaths}
              speaker={migrateEntry.speaker()}
              loadEventNames={async () => kojo2MigrateEventNames(project)}
              loadEventArgs={async () => kojo2MigrateEventArgs(project)}
              onClose={() => migrateEntry.close()}
              applyPlan={migrateEntry.apply}
              undoPlan={migrateEntry.undo}
            />
          </Suspense>
        ) : null}
        {/* `.kojo` → `.kojo1` 改名（LAU-3b）：只有命令面板显式发起才挂载；落地后由
            `onFilesGone` 换标签路径、`treeRefreshRef` 直通车重列文件树（与文件树内联改名
            同一套收尾），对话框本身不认识这两条通道。
            `legacyRenamePaths === null` = 正在列清单：外层 `modal-mask` 已在位。 */}
        {legacyRenameOpen ? (
          <Suspense fallback={<div className="modal-mask" data-lazy-mount="kojo1-rename" />}>
            {kernel !== null && legacyRenamePaths !== null ? (
              <LazyKojo1RenameDialog
                io={kernel.io}
                filePaths={legacyRenamePaths}
                guard={guardFileOp}
                onClose={closeLegacyRename}
                onRenamed={(renamed) => {
                  onFilesGone([], renamed);
                  treeRefreshRef.current?.();
                }}
                notify={(message) => notify({ kind: 'info', message })}
              />
            ) : (
              <div className="modal-mask" data-lazy-mount="kojo1-listing" />
            )}
          </Suspense>
        ) : null}
      </div>
      {/* 弹窗态的退出钮（启动层自带一枚，这里只管欢迎页 / 关闭态）：无边框窗口没有
          系统标题栏，右上角必须有「只退应用」的 ×；欢迎页自己的 × 仍只收起本页。 */}
      {project === null && phase !== 'boot' ? (
        <button
          type="button"
          className="app-popup-close"
          aria-label="退出应用"
          title="退出应用"
          onClick={() => void closeWindow()}
        >
          <Icon name="close" size="sm" />
        </button>
      ) : null}
      {/* 启动器实例库（L5）：顶层浮层，遮罩自己铺满窗口；卸载即收（内部订阅随之断开） */}
      {launcherOpen ? (
        <Suspense fallback={<div className="overlay-backdrop" data-lazy-mount="launcher" />}>
          <LazyLauncherView kernel={kernel} onClose={() => setLauncherOpen(false)} />
        </Suspense>
      ) : null}
      {/* 右键菜单根宿主（1023 覆盖面批）：固定层，必须排在所有浮层之后（层级见 CSS）。
          各面自己的就地菜单不受影响——这一层只接根路由与兜底。 */}
      <ContextMenuHost />
    </div>
  );
}
