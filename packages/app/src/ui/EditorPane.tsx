import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type * as Monaco from '../monaco/entry';
import type { Kernel } from '@kojo/kernel';
import type {
  EditorCodeAction,
  EditorSaveChoices,
  EditorSaveWarning,
} from '@kojo/plugin-api';
import {errorText,  FULLWIDTH_SPACE, WriteNotAllowedError } from '@kojo/plugin-api';
// monaco-editor 0.57 的 exports 映射：'monaco-editor/*' → './esm/vs/*.js'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import * as monaco from '../monaco/entry';
import { registerErbLanguage } from '../monaco/erb-language';
import { KOJO_LANGUAGE_ID, decorationsToMarkers, registerKojoLanguage } from '../monaco/kojo-language';
import { monacoThemeIdFor } from '../monaco/theme';
import { useThemePref } from './theme-pref';
import { fixAllSummary, runFixAll } from '../monaco/kojo-fix-all';
import { clampRevealPosition, type RevealSpan, type RevealTarget } from '../monaco/reveal-position';
import { dialectForLanguage, toTextEdits } from '../monaco/kojo-format';
import { applyFormatOnSave } from './format-on-save';
import { loadFormatRulesPref } from './format-pref';
import { classifySaveRace } from './save-race';
import { selectionStatusText } from './selection-status';
import {
  createPathMutex,
  runSaveBatch,
  withPathLock,
  type SaveFileOutcome,
} from './save-coordinator';
import { loadFormatOnSavePref } from './format-pref';
import { loadQuickSuggestionsPref, loadSuggestDelayPref } from './suggest-pref';
import { loadFontSizePref } from './font-size-pref';
import { dropRecoveredContent, peekRecoveredContent } from './recovery-store';
import { CrumbBar } from './breadcrumb-bar';
import { useNotify } from './NotificationCenter';
// FMT-TOAST：格式化让路 → 通知中心的那一条订阅（去重与文案都在台账侧，见该文件头注）
import { subscribeFormatNotices } from './format-notice-ledger';
import { SaveWarningDialog } from './SaveWarningDialog';
import { applySizeTier, quickSuggestionsFor } from './editor-options';
import { AUTOSAVE_IDLE_MS, decideAutosave, loadAutosavePref } from './autosave-pref';
import { ErbReadonlyAskDialog, ErbUnlockDialog, SugarViewIntroDialog } from './SugarViewDialogs';
import { decideExternalChange, matchOpenedPath, openExternalChangeDiff } from './external-change';
import { createDocumentBroadcaster } from './document-broadcast';
import {
  clampSlice,
  extractViewSlice,
  FOLDING_CONTRIBUTION_ID,
  foldRestoreState,
  getViewState,
  setViewState,
} from './view-state-store';
import { clampRange, erbReadOnlyGate, isErbLike } from './lift-preview';
import { pathLabelParts } from './path-label';
import { Icon } from './icons';
// 糖视图阅读模式（.kojo 预览专用）的显示层样式：装饰类 + 工具条开关，组件级引入
// （照 tab-chip.css / welcome.css 先例；只影响挂在糖 model 上的装饰，不碰普通编辑）
import './sugar-read.css';
import { perf } from '../perf';
import {
  composeSugarDoc,
  EDITOR_PADDING_DEFAULT,
  loadSugarMarksPref,
  loadSugarViewPref,
  loadSugarViewPrompted,
  saveSugarMarksPref,
  saveSugarViewPref,
  saveSugarViewPrompted,
  sourceLineToSugar,
  sugarReadDecorations,
  sugarReadTypography,
  SUGAR_READ_MARK_MAX_LINES,
  sugarSummary,
  sugarToggleTitle,
  sugarViewAllowed,
  trimSegmentBlanksWithMap,
  type SugarSegmentInput,
} from './sugar-view';
import { isSealed, useSealed } from './sealed';
import { isDirectMode, useDirectMode } from './direct-mode';
import { isInWorkspaceFile } from './file-area';
// C1 反向下行批：光标位点广播的载荷构造 + 连续相同载荷去重（纯逻辑，单测在 app/tests）
import { createCursorBroadcaster, cursorMovedPayload } from './cursor-broadcast';
// 问题汇总：refreshMarkers 逐文件整份发布两层波浪线（erb-parser / condition-extractor）到 problem-store
import { clearProblems, setProblems } from './problem-store';
// 装饰热路径（PERF-4）：同步/异步分层、(path, versionId) LRU、陈旧结果落地前作废
import { createMarkerRunner, type MarkerContributor } from './marker-pool';
// model 池（SPLIT-1 分屏）：纯逻辑工厂 + 真身单例（单例单独成模块，monaco 不进工厂的测试链）
import { languageFor } from './editor-model-pool';
import { editorModelPool } from './editor-model-pool-instance';
// SPLIT-1 拆出的多实例登记簿：本文件只留 ModelEntry 型（实例/偏好/面包屑三条线
// 已再拆一层，见下方 ./editor-pane/*，REF-FRONT-PERF 2026-10-20）
import type { ModelEntry } from './editor-pane-registry';
import {
  acquireDirectiveWords,
  applyDirectiveWords,
  applyTextEdits,
  foldingCapNoticeFor,
  onFoldingCapChanged,
  releaseDirectiveWords,
  FOLDING_MAX_RANGES,
  type FoldingCapNotice,
} from './editor-global-providers';
// worker 侧有没有这条 kind，判据只有一处：装配层那张两侧共用的任务表
import { hasWorkerTask } from '../compute-tasks';
// REF-FRONT-PERF：纯函数 / 三个 hook 从本文件搬出（调用点与时序不变）
import {
  MARKER_DEBOUNCE_MS,
  PREVIEW_WRITE_VETO,
  applyEditabilityAndSuggest,
  baseNameOf,
  minimapCtxForPath,
  pickSaveHandler,
  sugarStampOf,
  tierOverrides,
  type SugarCacheEntry,
} from './editor-pane/pane-helpers';
import { useBreadcrumb } from './editor-pane/use-breadcrumb';
import {
  useCodeLensPreference,
  useEditorPreferences,
} from './editor-pane/use-editor-preferences';
import { useMonacoInstance } from './editor-pane/use-monaco-instance';

// Monaco worker 装配（vite ?worker 后缀）；ERB 无需语言服务 worker，base 编辑器 worker 即可
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};
registerErbLanguage(monaco);
registerKojoLanguage(monaco);

/** marker owner（同一 owner 的 markers 每次整体替换；不同 owner 互不干扰） */
const MARKER_OWNER = 'kojo-decorators';

/**
 * `.kojo` 预览装配判据的项目侧摘要（PS-5 缓存键的一部分）。
 *
 * 段由 `ui.editor.liftPreview` 按 `{path, text, project}` 现算 ⇒ 决定产物的只有
 * "哪套项目 + 哪份内容"。内容那一维交给 model 的 `alternativeVersionId`（撤销回到
 * 原样时它会回到同一个数，缓存正好复用）；项目这一维取 adapterId / rootDir /
 * `inputDigest`——**字典与时机表都在 inputDigest 里**（adapter `loadProject` 吃进去的
 * 非 ERB 输入摘要，与 `marker-pool` 的缓存判据同一条尺子）。取不到 digest 就不给摘要
 * （判据不全 ⇒ 不缓存，同抽取快照纪律）。
 */
/** autosave 快照句柄吐出的一条脏内容（退出/崩溃守护批；只增不改——旧消费方零影响） */
export interface EditorSnapshotRecord {
  path: string;
  text: string;
  encoding: string;
  eol: string;
}

/**
 * 编辑器动作句柄（P3 多标签批）：宿主（App）经 `registerActions` 取得，
 * 供「保存并关闭」「全部保存」等标签级流程调用。
 */
export interface EditorPaneActions {
  /** 保存当前活动标签 */
  save: () => Promise<boolean>;
  /** 保存指定标签（含后台标签；model 仍在内存中，无需切换） */
  savePath: (path: string) => Promise<boolean>;
  /** 保存全部脏标签（并发池 + 一条合成回执；needs-choice 跳过计入回执，不静默） */
  saveAll: () => Promise<boolean>;
  /** 全部脏标签的内容快照（autosave 兜底用：O(脏数) 取值，不切标签不落盘） */
  snapshots: () => EditorSnapshotRecord[];
}

/**
 * A10：保存互斥从"组件实例一把全局锁"降为 **per-path 锁**，且提到模块级共享——
 * 分屏后同一文件可在多组打开，锁必须跨实例生效；不同文件则放行使能并发写
 * （IPC 桥逐命令独立、Rust 原子写临时名逐次唯一，跨文件并发无共享态可踩）。
 */
const sharedSaveLock = createPathMutex();

interface Props {
  kernel: Kernel;
  /** 所属编辑器组 id（SPLIT-1 分屏：糖视图 model URI 隔离、宿主按组收动作句柄） */
  groupId: string;
  /** 当前活动标签路径 */
  filePath: string;
  /** 全部打开的标签（model 生命周期以此为准：不在列表中的 model 释放池引用） */
  openPaths: readonly string[];
  /** 定位行（来自校验面板 / 函数树的 `editor.revealLocation`） */
  revealLine?: number;
  /** 定位列（1 基、UTF-16 码元；缺席 = 落行首，与列接线前一致） */
  revealColumn?: number;
  /** 定位区间（导航回跳带回来的原选区；缺席 = 零宽落点，退化口径只在 `reveal-position` 里写） */
  revealSpan?: RevealSpan;
  /** 定位序号：同一文件重复定位时变化以触发重新滚动 */
  revealNonce?: number;
  /** 脏状态上抛（P3：按路径逐个上报，宿主维护 dirtyPaths 集合） */
  onDirtyChange?: (path: string, dirty: boolean) => void;
  /** 注册编辑器动作句柄（宿主"保存并关闭 / 全部保存"流程用；卸载时以 null 注销） */
  registerActions?: (actions: EditorPaneActions | null) => void;
  /** 重授权入口（通知 action「去授权」落地处） */
  onReauth: () => void;
  /** 编辑器状态上抛（状态栏右区显示编码/EOL/行数 + A9 选区/光标读数；卸载或无文件时 null；autosavedAt 走同一条链路，A6 状态栏轻指示） */
  onStatusInfo?: (info: { encoding: string; eol: string; lines: number; autosavedAt?: number | null; sel?: string } | null) => void;
  /** 编辑器获得焦点（SPLIT-1：宿主据此把焦点组切到本组） */
  onFocused?: () => void;
}

/**
 * Monaco 编辑面板（P3 多标签化）：
 * - 每个标签一个 model：打开 = 读盘建 model，切换 = saveViewState → setModel →
 *   restoreViewState（编辑内容全程留内存，切换零丢失、零确认）；标签关闭即 dispose；
 * - 保存（Ctrl+S）= 先征询 `ui.editor.saveHandler` 槽（就近接管，如 `.kojo` →
 *   保存源 + 编译产物），无命中则走内核 io.writeText 缺省路径（保编码 + 自动
 *   备份，受写白名单约束）；保存期告警（全角空格）弹确认框 + 一键修复；
 * - 脏判定按 model 版本号 O(1)（BUG-4），逐 model 监听上报；
 * - 支持外部定位（revealLine）；语言按扩展名选择；
 * - 波浪线：消费 `ui.editor.decorator` 槽全部贡献（纯函数）→ Monaco markers，
 *   打开即算、编辑停顿去抖重算（v0.3 S6）。
 */
export function EditorPane({
  kernel,
  groupId,
  filePath,
  openPaths,
  revealLine,
  revealColumn,
  revealSpan,
  revealNonce,
  onDirtyChange,
  registerActions,
  onReauth,
  onStatusInfo,
  onFocused,
}: Props): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  /** 全部打开文件的 model（随标签存续；切换不销毁，关闭释放池引用） */
  const entriesRef = useRef(new Map<string, ModelEntry>());
  /** 各标签的视图状态（光标/滚动；切换时保存/恢复） */
  const viewStatesRef = useRef(new Map<string, Monaco.editor.ICodeEditorViewState | null>());
  /** 上一个活动路径（切换时先把它的视图状态存下） */
  const prevPathRef = useRef<string | null>(null);
  /** 上一次 savePath 是否走了"竞态保留脏"分支（写成功但保存期间又来新输入）——非失败，A6 不误报 */
  const saveRacedRef = useRef(false);
  const revealRef = useRef<RevealTarget | null>(null);
  /** 当前文件路径（供只注册一次的 Monaco 回调读取最新值，避免闭包过时） */
  const filePathRef = useRef<string>(filePath);
  const openPathsRef = useRef<readonly string[]>(openPaths);
  /** 重授权入口 ref（同上：Monaco 回调与保存句柄只注册一次，须读最新值） */
  const onReauthRef = useRef<() => void>(onReauth);
  /** 焦点上抛 ref（SPLIT-1：编辑器聚焦 ⇒ 宿主把焦点组切到本组） */
  const onFocusedRef = useRef<(() => void) | undefined>(onFocused);
  /**
   * 工作区根（创作权威区，恒可写）——ERB 只读规则的分野依据：
   * 游戏目录内 ERB = 只读借阅；**全部工作区根**（默认根 + 作者自选的项目位置）内的 ERB
   * = 可编辑源文件（工作区批新增，自选位置批扩成多根）。
   *
   * 判定本身住在 `file-area.ts`（状态栏可写胶囊问的是同一个问题，两处共用一把尺子，
   * 不许在这里另写一份）。每次判定现取，不缓存：`roots()` 是同步读内存数组、零 IO，
   * 缓存没有收益，反而会把"本会话刚自选的那个新根"永远排除在外（一次取值定死 ⇒ 之后一路判成借阅件锁只读）。
   */
  const inWorkspace = (p: string): boolean => isInWorkspaceFile(kernel, p);
  /**
   * 直连模式（direct-mode.ts）可编辑判定：开关开 + 该文件在写白名单内（用户批准的可写目录）
   * ⇒ 游戏目录 ERB 视为可直接编辑（就地编辑工作流）。写保护铁律不破：可写性仍完全来自
   * `kernel.io.isWritable`（用户批准的 writablePaths），直连模式不扩权。
   */
  const directEditable = (p: string): boolean => isDirectMode() && kernel.io.isWritable(p);
  const onDirtyChangeRef = useRef(onDirtyChange);
  /** 编辑器状态上抛 ref（重载时读最新，避免把不稳定 prop 拖进回调依赖） */
  const onStatusInfoRef = useRef(onStatusInfo);
  const notify = useNotify();
  /**
   * 预览面写类否决的统一出口（VETO-1，2026-10-20）——**否决必须给出路**（铁律 4）：
   * 预览挂的是只读派生 model，F2 改名 / Shift+Alt+F 格式化 / 壳层动作请求 / 整文件修法
   * 在它上面都改不到真文件。过去这里只弹一句"先关掉预览"，作者还得自己去找那颗开关；
   * 现在每条否决都挂「切回原文」按钮，点击走**工具条那颗开关同一条通道**
   * （`editor.sugarView.set`，宿主是糖视图状态所有者，壳层不持有第二份真源）。
   * 通知中心先关 toast 再执行 action（`NotificationCenter` 既有语义）⇒ 点完即消失。
   *
   * 调用点全部在 `if (sugarModelRef.current)` 里：**原文面一条都不新增**——同一个动作
   * 在原文面上要么照常执行，要么沿用该动作自己既有的提示。
   */
  const notifyPreviewWriteVeto = useCallback(
    (message: string): void => {
      // 目标文件在**弹通知那一刻**定下来：切走标签后旧通知仍在屏上，点它不该误关
      // 另一个文件的预览（监听端会按 filePath 对不上直接忽略，安全 no-op）。
      const target = filePathRef.current;
      notify({
        kind: 'info',
        message,
        actions: [
          {
            label: '切回原文',
            run: () => {
              kernel.bus.emit('editor.sugarView.set', {
                on: false,
                ...(target ? { filePath: target } : {}),
              });
            },
          },
        ],
      });
    },
    [kernel, notify],
  );
  /**
   * 格式化让路必须可见（铁律 4；FMT-TOAST）：`Shift+Alt+F` / 选区格式化 / 打字规范化
   * 这五处"这次不格式化"由 `monaco/kojo-format-range.ts` 递出 `notice`，台账
   * （`ui/format-notice-ledger.ts`）按 `where` + 行区间去重 ⇒ **同一处让路一次会话只说一遍**，
   * 文案与人话分工也在那一侧。订阅的是根通知中心那枚 `notify`（全树同一函数身份 ⇒
   * 多枚标签共用一条订阅，同一条让路只上一条 toast；台账按身份计数，关标签不会撤掉别人的）。
   */
  useEffect(() => subscribeFormatNotices(notify), [notify]);
  /**
   * 主题偏好（反馈 3）：dark / light / mint-dark 三档与 `monaco/theme.ts` 的三套主题
   * 一一对应；偏好一变就把 Monaco 全局主题换过去（同页所有编辑器实例一起换）。
   * 创建实例时另按 `loadThemePref()` 现取（见下方 `monaco.editor.create`）。
   */
  const themePref = useThemePref();
  useEffect(() => {
    monaco.editor.setTheme(monacoThemeIdFor(themePref));
  }, [themePref]);
  /** 装饰重算定时器（编辑停顿去抖） */
  const markerTimerRef = useRef<number | null>(null);
  /** 装饰刷新函数（ref 化，供只注册一次的 model 监听调用） */
  const refreshMarkersRef = useRef<((model: Monaco.editor.ITextModel, path: string) => void) | null>(null);
  /** CodeAction 待执行动作表（Monaco command 参数须可序列化 → 以 id 反查动作本体） */
  const pendingActionsRef = useRef(new Map<string, EditorCodeAction>());
  /** CodeAction id 序号（**单调递增不复用**：Monaco 可能持有上一轮列表，复用 id 会解析到别的动作） */
  const actionSeqRef = useRef(0);
  /**
   * 糖视图当前挂载的只读内存 model（null = 未启用糖视图）。
   *
   * 整份糖文本写进这份 model，用 `ed.setModel()` 换上；它非空即代表"编辑器此刻显示的是
   * 糖而不是原文"，所有读 `ed.getModel()` 的路径都要据此改判（见 `currentFileModel`）。
   */
  const sugarModelRef = useRef<Monaco.editor.ITextModel | null>(null);
  /** 糖视图挂载前编辑器上的原文 model（糖模式降级取模 / 还原兜底用） */
  const sugarOriginalModelRef = useRef<Monaco.editor.ITextModel | null>(null);
  /**
   * 屏幕上这份糖投影的「预览行 → 源行」表（`lineMap[i]` = 预览第 i+1 行的源行号，0 = 无源行）。
   *
   * 只定位、不改写：糖是派生只读文本，写类动作一律仍按"不在原文上"否决；但**读**的语义
   * （跳到某行、转到定义、诊断落点）在预览面上同样有意义，没这张表它们只能整条早退。
   */
  const sugarLineMapRef = useRef<readonly number[]>([]);
  /**
   * 投影产物缓存（PS-5，容量 1）：判据 = 路径 + 内容版本号 + 项目摘要 + 行数。
   * 命中即跳过"整篇 getValue + 逐行取原文 + 段扫描"这三条 O(行数) 的腿。
   */
  const sugarCacheRef = useRef<SugarCacheEntry | null>(null);
  /**
   * 已解锁编辑的 ERB 路径（**会话内有效**，不落盘）。
   *
   * 为什么不持久化：ERB 默认只读是**安全姿态**（游戏目录里别人的口上，误改即事故）。
   * 解锁是用户对"这一份文件、这一次会话"的显式决定；重启后回到默认只读，成本极低
   * （再点一次弹窗即可），而"上次解锁过就一直可写"会让保护形同虚设。
   */
  const unlockedPathsRef = useRef(new Set<string>());
  /** 当前活动文件是否已解锁编辑（驱动 readOnly 与工具条文案） */
  const [unlocked, setUnlocked] = useState(false);
  /** 待用户决策的"ERB 编辑解锁"询问（非 null = 弹确认框） */
  const [unlockAsk, setUnlockAsk] = useState<string | null>(null);
  /** 是否弹"首次引导：要不要用语法糖视图"（只在首次打开 ERB 时一次） */
  const [introAsk, setIntroAsk] = useState(false);
  /** 糖视图开关（偏好持久化；默认**关**——缺省即"看到的正是盘上那份"，见 `sugar-view.ts` 头注） */
  const [sugarView, setSugarView] = useState<boolean>(() => loadSugarViewPref());
  /**
   * 封存总闸（`sealed.ts`；默认封存）。它如今**只作用于两个面板**，糖视图不在其内；
   * 这里剩下的用处只有"解锁弹窗讲多少话"那一档文案口径（见 `decideUnlock` / 弹框选型）。
   */
  const sealed = useSealed();
  /**
   * 直连模式开关（`direct-mode.ts`；默认关）—— React 触发（re-render）：切换时
   * 走下方 effect 重算当前文件的可编辑态，并让糖视图让位/恢复。
   */
  const directMode = useDirectMode();
  /** 同一份"最新开关"给只注册一次的 Monaco 回调读（避免闭包过时） */
  const sugarViewRef = useRef<boolean>(sugarView);
  /** 糖视图摘要（null = 未启用 / 无文件）；工具条展示 */
  const [sugarStats, setSugarStats] = useState<string | null>(null);
  /**
   * **这一份文件**到底投出了几段（按路径存 ⇒ 换文件不拿旧读数说话；null = 还没算过）。
   *
   * 存在理由（NATIVE-UX 实测）：`langDoc: native` 起手包的 8 份 `.ERB` 每份都投出**零段**
   * （整份透传），`applySugarView` 那一拍直接 return、糖 model 根本不挂；那颗开关若只看
   * 偏好状态就说「当前显示的是 .kojo 写法」，作者读到的是假话。读数只服务于**既有那一格**
   * 的悬停文案（`sugarToggleTitle`），不新开显示面。
   */
  const [sugarSegments, setSugarSegments] = useState<{ path: string; segments: number } | null>(
    null,
  );
  /**
   * 阅读模式「显示语法标记」开关（偏好持久化；默认**关** = 阅读态——`续`、`空行`、
   * `等待`、`：` 这类语法标记降到低对比，台词成为屏上主体；开 = 恢复主题高对比）。
   * 作用面**只在糖预览 model**（按 token 区间铺装饰 + `sugar-read.css`），投影文本
   * 一字不变；开关就近放糖视图工具条，不进设置页（预览专属的阅读态，两处状态必漂）。
   */
  const [sugarMarks, setSugarMarks] = useState<boolean>(() => loadSugarMarksPref());
  /** 给只注册一次的 Monaco 偏好回调读的最新值（与 sugarViewRef 同款理由） */
  const sugarMarksRef = useRef<boolean>(sugarMarks);
  /** 阅读态弱化装饰集（编辑器级：`setModel` 换 model 时自动清空，撤预览不必修拆） */
  const sugarReadCollRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  /** 正在以磁盘内容重载 model（抑制由此触发的脏上报：重载不是用户编辑） */
  const reloadingRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  /**
   * PS-5 校验暂停闸的可见态（键 = 正停着的那条路径；值恒 true）。
   * 由 `markerRunner` 的 `pauseChanged` 在跨界时写入 ⇒ 工具条那一句「文件太大，
   * 错误检查已暂停」与波浪线**同源同时**（不是宿主另算一遍体量，两处不会漂）。
   */
  const [markerPaused, setMarkerPaused] = useState<Record<string, boolean>>({});
  /**
   * 折叠被按数量截了尾巴的那句话（键 = 文件路径；与上面那颗徽章同一族）。
   *
   * 为什么要有它：折叠区间超额时**宿主**先按 vendor 那条线（5,000 处）截掉尾巴，
   * 而 standalone Monaco 的那位 `RangesLimitReporter` 在本 app 没人接（那句
   * "folding was removed for N ranges" 是 VS Code 工作区侧发的）——不由这里说，
   * 就又是一次"少给了但没人说"（铁律 4）。文案走作者口径，见工具条那一格。
   */
  const [foldingCap, setFoldingCap] = useState<Record<string, FoldingCapNotice>>({});
  useEffect(() => {
    const off = onFoldingCapChanged((path, notice) => {
      setFoldingCap((prev) => {
        const had = prev[path];
        if (notice === null) {
          if (had === undefined) return prev;
          const next = { ...prev };
          delete next[path];
          return next;
        }
        if (had && had.shownRanges === notice.shownRanges && had.droppedRanges === notice.droppedRanges) return prev;
        return { ...prev, [path]: notice };
      });
    });
    // 分屏后挂载的第二枚实例要能看见**已经在途**的那句说法（订阅只给变化，不给现值）
    const seed = foldingCapNoticeFor(filePathRef.current);
    if (seed) setFoldingCap((prev) => ({ ...prev, [filePathRef.current]: seed }));
    return off;
  }, []);
  /** 待用户决策的保存告警（非 null = 弹确认框；宿主全角空格"一键修复"的入口） */
  const [pendingChoice, setPendingChoice] = useState<EditorSaveWarning | null>(null);
  /** 保存告警的 ref 镜像（A6：自动保存 tick 是定时器闭包，护栏须读最新值） */
  const pendingChoiceRef = useRef<EditorSaveWarning | null>(null);
  /** 外部改动与本地脏冲突、用户未处置的路径集（A6 护栏：未决不自动保存） */
  const externalConflictRef = useRef(new Set<string>());
  /** 自动保存连败已报过的路径（同一文件连败只报一次；保存成功即销账） */
  const autosaveFailedRef = useRef(new Set<string>());
  /** 自动保存闲置定时器（A6；卸载与文件切换都要能取消） */
  const autosaveTimerRef = useRef<number | null>(null);

  /** O(1) 脏判定：model 当前版本号 ≠ 已保存基线版本号（BUG-4；基线随池走——分屏后同一文件多组共享） */
  const computeDirty = useCallback((path: string): boolean => {
    const entry = entriesRef.current.get(path);
    const base = editorModelPool.baseline(path);
    if (!entry || base === undefined) return false;
    return entry.model.getAlternativeVersionId() !== base;
  }, []);

  /**
   * 面包屑刷新链（D1）：缓存 / 索引快路 / 防抖重算三条腿全在 `use-breadcrumb.ts`，
   * 本组件只持有它吐回的 `crumbLevels`（渲染）与 `crumbTreeCacheRef`（登记簿反查）。
   */
  const breadcrumb = useBreadcrumb({
    kernel,
    editorRef,
    filePathRef,
    sugarModelRef,
    computeDirty,
  });

  /**
   * A9 状态栏选区读数：活动文件真 model 的选区/光标 → 文案（判据全在纯函数
   * `selection-status.ts`）。糖视图给空串——派生 model 的行号不属于真文件，
   * 状态栏不许用它误导作者（与面包屑同口径）。
   */
  const selStatusRef = useRef('');
  const selReadout = (): string => {
    const ed = editorRef.current;
    if (!ed || !filePathRef.current || sugarModelRef.current) return '';
    const model = ed.getModel();
    const sel = model ? ed.getSelection() : null;
    if (!model || !sel) return '';
    return selectionStatusText(model, sel, { line: sel.positionLineNumber, column: sel.positionColumn });
  };
  /** 读数上抛：复用 dirty/编码 在走的 onStatusInfo 链路；文案未变则不惊动壳层重渲染 */
  const pushSelStatus = (force = false): void => {
    const entry = entriesRef.current.get(filePathRef.current);
    if (!entry) return;
    const sel = selReadout();
    if (!force && sel === selStatusRef.current) return;
    selStatusRef.current = sel;
    onStatusInfoRef.current?.({
      encoding: entry.encoding,
      eol: entry.eol,
      lines: entry.model.getLineCount(),
      sel,
    });
  };

  /**
   * 全部脏标签的内容快照（autosave 兜底句柄，退出/崩溃守护批）：逐 model 读
   * getValue + 打开时的编码/EOL。脏 ⇒ model 必在 entriesRef（脏只可能来自
   * model 监听），所以这里天然是"脏集合真相源"，不需要宿主另传 dirtyPaths。
   */
  const snapshots = useCallback((): EditorSnapshotRecord[] => {
    const out: EditorSnapshotRecord[] = [];
    for (const [path, entry] of [...entriesRef.current]) {
      if (entry.model.isDisposed()) continue;
      if (!computeDirty(path)) continue;
      out.push({ path, text: entry.model.getValue(), encoding: entry.encoding, eol: entry.eol });
    }
    return out;
  }, [computeDirty]);

  /**
   * 文档真相广播（C2，2026-10-16 面板真相统一批）：编辑器缓冲区 = "这个文件当前的
   * 可编译真相"。防抖 / 去重 / 抑制 derived 的判据全在 `document-broadcast`（纯逻辑
   * 可单测），这里只提供两条宿主事实：往内核总线发 `editor.documentChanged`；
   * 糖视图挂载中（derived 只读 model，文本不是文件真相）为抑制态。
   */
  const documentBroadcaster = useMemo(
    () =>
      createDocumentBroadcaster({
        emit: (payload) => kernel.bus.emit('editor.documentChanged', payload),
        // 谓词在**落地时刻**求值：排程后、落地前用户可能刚切进/切出糖视图
        suppressed: () => sugarModelRef.current !== null,
      }),
    [kernel],
  );
  // 卸载（含 kernel 更换重建）清掉在途排程：旧广播器的定时器不该再落地
  useEffect(() => () => documentBroadcaster.dispose(), [documentBroadcaster]);

  /**
   * 现取指定文件的**缓冲真相**（广播载荷的读取入口）。绑定 `entriesRef` 里的真
   * model——糖视图期间它仍指向原文 model（糖 model 从不进 entriesRef，见其 ref 注）；
   * 标签已关 / model 已替换 → null = 本次广播作废（不拿残影当真相）。
   */
  const readDocumentTruth = useCallback(
    (path: string): { text: string; dirty: boolean } | null => {
      const entry = entriesRef.current.get(path);
      if (!entry || entry.model.isDisposed()) return null;
      return { text: entry.model.getValue(), dirty: computeDirty(path) };
    },
    [computeDirty],
  );

  /**
   * 取"当前文件"的**真 model**（装饰 / 保存 / 编辑落点 / 定位的统一入口）。
   *
   * 糖视图激活时 `ed.getModel()` 是那份**只读糖 model**——对它做脏判定、挂波浪线、落编辑
   * 都毫无意义（糖是派生物，没有"已保存基线"，也改不得）。所以糖模式下统一返回该文件真正
   * 的原文 model（`entriesRef` 里的 `entry.model`；极端兜底 `sugarOriginalModelRef`）。
   * 非糖模式退回 `ed.getModel()`，行为与旧版一致。
   */
  const currentFileModel = useCallback((): Monaco.editor.ITextModel | null => {
    const ed = editorRef.current;
    if (!ed) return null;
    if (sugarModelRef.current) {
      return entriesRef.current.get(filePathRef.current)?.model ?? sugarOriginalModelRef.current;
    }
    return ed.getModel();
  }, []);

  /**
   * 光标位点广播（C1 反向下行批）：光标动 / 切文件完成 / 糖视图翻转三处都调它。
   * 广播器实例挂 ref（去重状态跨三处触发存活）；载荷构造与"连续相同不发"的判据
   * 全在 `cursor-broadcast.ts`（纯逻辑，单测钉死）——这里只做"现取此刻事实"。
   */
  const cursorBroadcasterRef = useRef<ReturnType<typeof createCursorBroadcaster> | null>(null);
  const publishCursor = useCallback((): void => {
    const ed = editorRef.current;
    if (!ed) return;
    // 异步 acquire 竞态闸：`filePathRef` 先于 model 换装更新——此刻可能"新路径 + 旧 model"，
    // 不加闸会把 A 的行号广播成 {B, A 行}。判据：屏幕 model 必须是当前路径的真 model，
    // 或当前糖 model（糖视图是有意展示派生物，derivedView 标注由 payload 自己处理）。
    const entry = entriesRef.current.get(filePathRef.current);
    const shown = ed.getModel();
    if (!entry || (shown !== entry.model && shown !== sugarModelRef.current)) return;
    let broadcaster = cursorBroadcasterRef.current;
    if (!broadcaster) {
      broadcaster = createCursorBroadcaster((payload) => kernel.bus.emit('editor.cursorMoved', payload));
      cursorBroadcasterRef.current = broadcaster;
    }
    broadcaster.publish(
      cursorMovedPayload({
        filePath: filePathRef.current || null,
        position: ed.getPosition(),
        // 糖视图下屏幕上那份是派生物：行号不属于真文件，如实标 derivedView（消费方据此清高亮）
        derivedView: !!sugarModelRef.current,
      }),
    );
  }, [kernel]);

  const applyReveal = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const model = ed.getModel();
    const target = revealRef.current;
    if (!model || !target) return;
    // 糖视图在屏 ⇒ 发起方给的是**原文行号**，必须先经装配时留下的 `lineMap` 换成预览行。
    // 源行被折进糖段、没有独立成行时落到"包住它的那段糖"（`sourceLineToSugar` 的退化口径）；
    // 映射还没装配出来（首帧 / 投影退化）就不动——滚到第一行比原地不动更糟。
    const line =
      sugarModelRef.current === null
        ? target.line
        : sourceLineToSugar(sugarLineMapRef.current, target.line);
    if (line === null) return;
    // 行列夹取的判据在 `reveal-position`（纯函数）；行长一律问 model（`getLineMaxColumn`
    // 本身就是 UTF-16 码元口径），宿主不自算字符数。
    const position = clampRevealPosition(
      { ...target, line },
      {
        lineCount: model.getLineCount(),
        maxColumn: (lineNumber) => model.getLineMaxColumn(lineNumber),
      },
    );
    ed.revealLineInCenter(position.lineNumber);
    // W9：落点是**区间**（起点 + 不含端点），不是光标的单个位置——零宽区间天然等价于
    // 旧的 `setPosition`，所以没带 span 的老发起方零风险；带了 span 就把那一处选出来。
    ed.setSelection({
      startLineNumber: position.lineNumber,
      startColumn: position.column,
      endLineNumber: position.lineNumber,
      endColumn: position.columnEnd,
    });
    ed.focus();
  }, []);

  /**
   * 重算并应用编辑器波浪线（2026-10-16 装饰热路径批：调度住在 `marker-pool.ts`）。
   *
   * 本函数只做两件事：**发起一次刷新** + **定义"结果怎么上屏"**。谁同步跑、谁进
   * worker、同版本要不要重算、迟到的结果能不能信，全在 `createMarkerRunner` 里
   * （那里的读数与判据都可单测）。
   *
   * 发布语义与改动前逐字相同：一次刷新 = 该 owner 的 markers **整档替换** +
   * problem-store 该文件**整档替换**；装饰器抛错不打断编辑（退化可见）。
   * 声明了 `offloadKind` 的贡献会分两拍落地（轻的先上屏、重的回来再整档替换一次），
   * 每一拍仍是一整档，不存在"追加/残留"。
   */
  const markerRunner = useMemo(
    () =>
      createMarkerRunner({
        compute: kernel.compute,
        workerHasTask: hasWorkerTask,
        // 槽位贡献映射成热路径需要的最小面（顺序 = 槽位顺序 = 面板行序）
        contributors: () =>
          kernel.slots
            .query('ui.editor.decorator')
            .map((c): MarkerContributor => ({
              id: c.id,
              ...(c.offloadKind === undefined ? {} : { offloadKind: c.offloadKind }),
              decorate: (payload) => c.decorate(payload),
            })),
        project: () => kernel.project.current(),
        // 版本以**当前仍活着的那个 model** 为准：标签关了 / model 换了 → undefined
        // ⇒ 在途结果一律丢弃（陈旧防护与"别给已关闭文件发问题"同一把尺子）
        versionOf: (path) => {
          const model = entriesRef.current.get(path)?.model;
          return model && !model.isDisposed() ? model.getVersionId() : undefined;
        },
        publish: (path, decorations) => {
          const model = entriesRef.current.get(path)?.model;
          if (!model || model.isDisposed()) return; // 发布时标签已关：什么都不做
          monaco.editor.setModelMarkers(model, MARKER_OWNER, decorationsToMarkers(monaco, model, decorations));
          // 同一份 decorations 发布到问题面板：两层波浪线（结构 error / 表达式 warning）在此汇总成可展开列表
          setProblems(
            path,
            decorations.map((d) => ({
              path,
              line: d.line,
              // W9：波浪线本来就带列区间，面板此前没接住 ⇒ 同一个位置两条腿落两个地方
              ...(d.startColumn !== undefined
                ? { span: { columnStart: d.startColumn, columnEnd: d.endColumn ?? d.startColumn } }
                : {}),
              severity: d.severity,
              message: d.message,
              ...(d.code ? { code: d.code } : {}),
            })),
          );
        },
        record: (name, ms, note) => perf.record(name, ms, note),
        /* PS-5 校验暂停闸的两条宿主腿。
         * `sizeOf` 只用 model 的 O(1) 读数（码元数走 `getValueLength()`——piece tree 的
         * 前缀和，不复制正文；行数走 `getLineCount()`）。判据本体在 marker-pool。
         * `pauseChanged` 只在跨界时叫一次 ⇒ 宿主把它变成**看得见的**一句话（铁律 4：
         * 停掉波浪线可以，停下来没人说就是 bug）。 */
        sizeOf: (path) => {
          const model = entriesRef.current.get(path)?.model;
          if (!model || model.isDisposed()) return undefined;
          return { units: model.getValueLength(), lineCount: model.getLineCount() };
        },
        pauseChanged: (path, paused) => {
          // 记的是"哪几份文件正停着"（不是"最后翻转的那一条"）：两份超大文件并存时，
          // 切过去的那一份不会再触发翻转 ⇒ 用集合判可见，提示不会跟着标签漂丢。
          setMarkerPaused((prev) => {
            if ((prev[path] === true) === paused) return prev;
            const next = { ...prev };
            if (paused) next[path] = true;
            else delete next[path];
            return next;
          });
        },
      }),
    [kernel],
  );

  const refreshMarkers = useCallback(
    (model: Monaco.editor.ITextModel, path: string) => {
      if (model.isDisposed()) return;
      markerRunner.refresh(path, () => (model.isDisposed() ? '' : model.getValue()));
    },
    [markerRunner],
  );

  // ref 化刷新函数，供只注册一次的 Monaco 回调取用最新闭包
  useEffect(() => {
    refreshMarkersRef.current = refreshMarkers;
  }, [refreshMarkers]);

  // 文件路径 / 打开列表 ref 同步（只注册一次的 Monaco 回调读它们）
  useEffect(() => {
    filePathRef.current = filePath;
  }, [filePath]);
  useEffect(() => {
    openPathsRef.current = openPaths;
  }, [openPaths]);

  // 重授权/脏上报 ref 同步（同上；写权限判定已改为按文件 kernel.io.isWritable）
  useEffect(() => {
    onReauthRef.current = onReauth;
    onDirtyChangeRef.current = onDirtyChange;
    onStatusInfoRef.current = onStatusInfo;
  }, [onReauth, onDirtyChange, onStatusInfo]);
  // 保存告警镜像（A6 护栏读它：定时器闭包拿不到 state 最新值）
  useEffect(() => {
    pendingChoiceRef.current = pendingChoice;
  }, [pendingChoice]);

  /** 编辑停顿后重算装饰（去抖；换文件时立即算，见文件加载 effect） */
  const scheduleMarkers = useCallback(() => {
    if (markerTimerRef.current !== null) window.clearTimeout(markerTimerRef.current);
    markerTimerRef.current = window.setTimeout(() => {
      markerTimerRef.current = null;
      // 糖视图下 `currentFileModel()` 返回真 model：波浪线**仍发布到 `entry.model`**（它此刻
      // 没上屏，自然不可见），而不是那份只读糖 model——糖是派生物，没有可诊断的语义。
      const model = currentFileModel();
      const path = filePathRef.current;
      if (model && path && refreshMarkersRef.current) refreshMarkersRef.current(model, path);
    }, MARKER_DEBOUNCE_MS);
  }, [currentFileModel]);

  /* ------------------------ 糖视图（整文件显示为糖） ------------------------ */

  /**
   * 清空糖视图：把编辑器换回**真 model** 并 dispose 那份只读糖 model。
   * 换文件 / 关开关 / 卸载 / 解锁都走它（"换上"必须是可逆的，且不留内存泄漏）。
   */
  const clearSugarView = useCallback(() => {
    const ed = editorRef.current;
    const sugarModel = sugarModelRef.current;
    if (ed && sugarModel) {
      if (ed.getModel() === sugarModel) {
        // 还挂在编辑器上：换回真 model。优先按**当前文件路径**取回原文 model，取不到再退回
        // "挂糖前记住的那份"——两者都没有时宁可保留挂载也不 dispose（dispose 正在显示的
        // model 会让编辑器白屏）。
        const restore =
          entriesRef.current.get(filePathRef.current)?.model ?? sugarOriginalModelRef.current;
        if (restore && !restore.isDisposed()) {
          ed.setModel(restore);
          // 档位跟着"此刻屏幕上那份文档"重落一遍（PS-5 交付说的「小档必须显式写回，否则档位
          // 漂移」在**这一条腿**上没做：挂糖时按投影行数落过档，撤糖却只回了可写态）。
          // 一份几万行投影的关值——折行 / 折叠 / 找同词 / 打字规范化——以前会一路骑到
          // 下一份小文件上，且没有第二次机会纠正（切标签那道档位只在**换文件**时发）。
          const restoreLines = restore.getLineCount();
          applySizeTier(ed, restoreLines, tierOverrides(restoreLines, isErbLike(filePathRef.current), undefined, minimapCtxForPath(filePathRef.current)));
          // 阅读四件套里 `applySizeTier` 覆盖不到的两位（折行模式/行高/偏好折行值都在它的
          // 补丁里，写回同源）：`wordWrapColumn`（阅读栏宽盖过缺省 80）与上下留白
          // （create 路径那份值）——`updateOptions` 只覆写发过去的键，不写回就漂移。
          ed.updateOptions({ wordWrapColumn: 80, padding: { ...EDITOR_PADDING_DEFAULT } });
          // 按当前文件重算 readOnly（解锁 / 直连 / 工作区口径与切换标签 effect 一致）
          const path = filePathRef.current;
          const canEdit = unlockedPathsRef.current.has(path) || directEditable(path);
          applyEditabilityAndSuggest(ed, erbReadOnlyGate(path, { inWorkspace: inWorkspace(path), canEdit }));
          sugarModel.dispose();
        } else {
          return; // 无处可还原：保留挂载、不 dispose，至少不白屏
        }
      } else {
        // 糖 model 已不在编辑器上（被别的 setModel 顶掉）：直接回收
        sugarModel.dispose();
      }
    }
    sugarModelRef.current = null;
    sugarOriginalModelRef.current = null;
    sugarLineMapRef.current = [];
    // 装饰集是编辑器级的：`setModel` 换回原文那拍已自动清空，这里只弃引用
    // （"被别的 setModel 顶掉"分支同理——model 一 dispose，装饰随之无主）。
    sugarReadCollRef.current = null;
    setSugarStats(null);
    // C1 反向下行批：糖视图撤下 = derivedView 翻转（true→false），立刻透出给面板
    publishCursor();
  }, [kernel, publishCursor]);

  /* ------------------------ 糖视图 · 阅读模式（标记弱化） ------------------------ */

  /**
   * 重铺阅读态的标记弱化装饰（**纯显示层**：投影文本、行号对齐、折行口径一字不变）。
   *
   * 判据只按 token：把当前糖 model 整篇重新分词（`monaco.editor.tokenize`，与上屏
   * 渲染同一套 Monarch 规则）→ `sugarReadDecorations`（sugar-view.ts，口径单测钉死）
   * 产区间 → 编辑器级装饰集铺设。「显示语法标记」开、或投影行数超过阅读上限时清空
   * （恢复主题高对比 / 不冒同步分词卡首屏的险）。
   */
  const refreshSugarReadDecorations = useCallback(() => {
    const ed = editorRef.current;
    const model = sugarModelRef.current;
    if (!ed || !model || model.isDisposed() || ed.getModel() !== model) return;
    let coll = sugarReadCollRef.current;
    if (!coll) {
      coll = ed.createDecorationsCollection();
      sugarReadCollRef.current = coll;
    }
    if (sugarMarksRef.current || model.getLineCount() > SUGAR_READ_MARK_MAX_LINES) {
      coll.set([]);
      return;
    }
    const lineCount = model.getLineCount();
    const lineTexts: string[] = [];
    for (let i = 1; i <= lineCount; i++) lineTexts.push(model.getLineContent(i));
    const tokenLines = monaco.editor.tokenize(lineTexts.join('\n'), model.getLanguageId());
    coll.set(
      sugarReadDecorations(lineTexts, tokenLines).map((r) => ({
        range: new monaco.Range(r.lineNumber, r.startColumn, r.lineNumber, r.endColumn),
        options: { className: r.className },
      })),
    );
  }, []);

  /**
   * 预览在屏时重发阅读排版四件套（行高 / 折行模式 / 栏宽 / 留白）。
   *
   * 存在的唯一理由：字号、排版、显示族三族偏好的订阅回调会把 `lineHeight` /
   * `wordWrap` 按**正文口径**补发回来——用户在预览挂着时动设置页，稿纸行距会被
   * 普通行距顶掉；这一位在每次偏好补发之后把阅读值盖回去（撤预览由
   * `clearSugarView` / 切档路径按正文口径写回，不残留）。
   */
  const reapplySugarReadOptions = useCallback(() => {
    const ed = editorRef.current;
    const model = sugarModelRef.current;
    if (!ed || !model || model.isDisposed() || ed.getModel() !== model) return;
    ed.updateOptions(sugarReadTypography(loadFontSizePref()));
  }, []);

  /**
   * 偏好安装器（字体 / 缩放 / 快建议 / 排版 / 显示订阅；REF-FRONT-PERF 搬进
   * `use-editor-preferences.ts`）。本 hook 不注册 effect——安装点仍在实例创建
   * effect 的原来那一行，接线/退订次序与拆前逐字一致。
   */
  const installPreferences = useEditorPreferences({ sugarModelRef, reapplySugarReadOptions });

  /**
   * 生成糖视图：整份文件投影成糖文本 → 建一份**只读内存 model** → `ed.setModel()` 换上。
   *
   * 为什么换成 model 而不是自绘 ViewZone：Monaco 用自己的行渲染（原生字号 / 行高 / 折行 /
   * 缩进 / 行号槽），糖文本与原文**逐行对齐、无法区分**，且天然支持滚动 / 搜索 / 复制。
   * 磁盘文件绝不被改：换上的是一份 `inmemory://` scheme 的临时 model。
   *
   * 整文件模式刻意**不打字机**：打字机是"逐条预览"的仪式感（一次一段），整文件有
   * 几十上百段，逐字动画会变成等待。这里的体感目标只有一个字：快。
   */
  const applySugarView = useCallback(() => {
    const ed = editorRef.current;
    const path = filePathRef.current;
    const entry = entriesRef.current.get(path);
    clearSugarView(); // 先把上一次的糖 model 撤下（幂等）
    if (!ed || !entry) return;
    // C2：糖视图让位 / 撤下的这一拍，编辑器真理回到原文缓冲——立即补发一条。
    // 这是"切文件/加载完成即有真相"与"切回原码后补一发"的共同落点（本函数被开关
    // 切换 / 解锁 / 直连 / 换文件全部入口调用）；糖视图正要挂上时同样发的是**原文**
    // 真相（派生文本永不外发，挂载后由 broadcaster 的抑制谓词兜住）。
    documentBroadcaster.flush(path, () => readDocumentTruth(path));
    // 可用门（ADR-0005）：只对**游戏目录里、本次未解锁**的 ERB 生效。
    // `.kojo` 与**工作区内 ERB**（作者自己的创作源文件，恒可编辑）都不放预览——
    // 预览靠"整份文件换成只读 model"工作，可编辑的原文必须始终看得见。
    if (
      !sugarViewRef.current ||
      !sugarViewAllowed({
        isErbLike: isErbLike(path),
        inWorkspace: inWorkspace(path),
        // 直连可编辑 ⟹ 预览让位（与 unlocks 同口径，ADR-0005 互斥）
        unlocked: unlockedPathsRef.current.has(path) || directEditable(path),
      })
    )
      return;

    const model = entry.model;
    const versionId = model.getAlternativeVersionId();
    const project = kernel.project.current();
    const maxLine = model.getLineCount();
    const stamp = sugarStampOf(project);
    // PS-5 装配缓存：同一份内容 + 同一套项目判据 ⇒ 整篇 getValue、逐行取原文、段扫描**一次都不付**
    // （改前每次切标签 / 解锁 / 直连开关都要重付一遍，见下面 else 分支那三条 O(行数) 的腿）。
    // 只留一份（容量 1）：换来的是"来回切标签不重算"，代价是一份投影文本常驻——
    // 与"每次重算却谁也不留"相比是有界且可预期的（关标签 / 换项目 / 内容改动都会作废它）。
    const hit = sugarCacheRef.current;
    let doc: string;
    let lineMap: readonly number[];
    let sugarLines: number;
    /** 本文件的投影段数（命中缓存也要报得出——见 `sugarSegments` 的存在理由） */
    let segCount: number;
    if (hit && hit.path === path && hit.versionId === versionId && hit.stamp === stamp && hit.lineCount === maxLine) {
      doc = hit.doc;
      lineMap = hit.lineMap;
      sugarLines = hit.sugarLines;
      segCount = hit.segmentCount;
    } else {
      const text = model.getValue();
      // 段清点：单个贡献抛错不影响其余（与装饰器 / codeAction 同款隔离）
      const segments: SugarSegmentInput[] = [];
      for (const contribution of kernel.slots.query('ui.editor.liftPreview')) {
        const provide = contribution.provideLiftProject;
        if (typeof provide !== 'function') continue;
        try {
          for (const item of provide.call(contribution, { path, text, project })) {
            const { fromLine, toLine } = clampRange(item.fromLine, item.toLine, maxLine);
            // 段首尾的空行不进糖文本（否则糖块开头是一大块空白，见 `trimSegmentBlanks`）；
            // 剪行与剪映射必须同一次做，否则预览行号整体错位且错得静默。
            const trimmed = trimSegmentBlanksWithMap(item.sugarText, item.sourceLines);
            segments.push({
              fromLine,
              toLine,
              sugarText: trimmed.sugarText,
              ...(trimmed.sourceLines ? { sourceLines: trimmed.sourceLines } : {}),
            });
          }
        } catch (e: unknown) {
          // 能力出错要"退化可见"：记录后继续，糖视图少一段好过整份消失
          console.warn(
            `[EditorPane] liftPreview '${contribution.id}' provideLiftProject 抛错：${
              errorText(e)
            }`,
          );
        }
      }
      if (segments.length === 0) {
        // 无段可铺：保持原文（clear 已在函数开头做过；不进缓存——没有可复用的产物）。
        // NATIVE-UX：这一拍必须把"零段"记下来——那颗开关的悬停否则会说"当前显示的是 .kojo
        // 写法"，而屏上正是原文（`langDoc: native` 的起手文件 8/8 都走这一条）。
        setSugarSegments({ path, segments: 0 });
        return;
      }

      // 取原文逐行内容，拼装整份糖文本（纯函数，口径单测钉死在 sugar-view.test.ts）
      const originalLines: string[] = [];
      for (let i = 1; i <= maxLine; i++) originalLines.push(model.getLineContent(i));
      const composed = composeSugarDoc(originalLines, segments);
      doc = composed.text;
      lineMap = composed.lineMap;

      sugarLines = 0;
      for (const seg of segments) sugarLines += seg.sugarText.split('\n').length;
      segCount = segments.length;
      sugarCacheRef.current = { path, versionId, stamp, lineCount: maxLine, doc, lineMap, sugarLines, segmentCount: segCount };
    }
    setSugarSegments({ path, segments: segCount });

    // 只读内存 model：`inmemory://` scheme（**非** `file:`，避免与真文件 model 冲突被复用）。
    // URI 按组隔离（SPLIT-1）：同文件可在两组同时开糖视图——同 URI 的 createModel 会撞车。
    // 换文件 / 关开关时由 clearSugarView dispose。
    const sugarModel = monaco.editor.createModel(
      doc,
      KOJO_LANGUAGE_ID,
      monaco.Uri.parse(`inmemory://sugar/${encodeURIComponent(groupId)}/${encodeURIComponent(path)}`),
    );
    sugarModelRef.current = sugarModel;
    sugarOriginalModelRef.current = model;
    sugarLineMapRef.current = lineMap;
    // 糖 model 同样按**行数**落 Monaco 降级选项：主切换（见加载 effect）给真 model 发了
    // 档位补丁，这里若只发 `readOnly`，一份几万行的投影会带着全文级特性
    // （小地图 / 粘性滚动 / 括号对着色 / 整篇找同词）上屏 ⇒ 滚动即卡死。先落选项再挂 model。
    // 档位 = **此刻屏幕上这份投影**的行数（投影比原文长，该档更保守）；撤下时由
    // `clearSugarView` 按原文行数再落一次——两拍合起来才是"谁在屏幕上就按谁落档"。
    // `isErb` 恒 false：糖 model 是 `.kojo` 投影，打字规范化的窗口腿对它不适用。
    // `preview: true`：投影是派生文本，缩略图「跟随」档在这里让路（读的是原文，不是它）。
    const sugarTierLines = sugarModel.getLineCount();
    applySizeTier(ed, sugarTierLines, tierOverrides(sugarTierLines, false, {
      readOnly: true, // 糖是派生物，禁止在糖视图上编辑
      // 预览是派生只读 model：快建议整条关掉（provider 拿不到 editor 的可写状态）
      quickSuggestions: false,
      quickSuggestionsDelay: loadSuggestDelayPref(),
    }, { preview: true }));
    // 阅读排版（稿纸化）：盖在档位之后——行距 / 折行栏宽 / 上下留白只对这份投影生效，
    // 撤下时由 `clearSugarView`（还原腿）与档位重落路径按正文口径写回。
    ed.updateOptions(sugarReadTypography(loadFontSizePref()));
    ed.setModel(sugarModel);
    setSugarStats(sugarSummary(sugarLines, 0));
    refreshSugarReadDecorations();
    // C1 反向下行批：糖视图挂上 = derivedView 翻转（false→true），立刻透出给面板
    publishCursor();
  }, [kernel, clearSugarView, documentBroadcaster, readDocumentTruth, publishCursor, refreshSugarReadDecorations]);

  // 开关变化：记住偏好（下次启动仍是你的选择）+ 就地重算视图
  useEffect(() => {
    sugarViewRef.current = sugarView;
    saveSugarViewPref(sugarView);
    applySugarView();
  }, [sugarView, applySugarView]);

  // 阅读模式「显示语法标记」：偏好落盘 + 立即重铺装饰（只动显示层，投影零改动；
  // 装饰集挂在当前糖 model 上，所以切档 / 重挂之后还要由 applySugarView 再铺一次）
  useEffect(() => {
    sugarMarksRef.current = sugarMarks;
    saveSugarMarksPref(sugarMarks);
    refreshSugarReadDecorations();
  }, [sugarMarks, refreshSugarReadDecorations]);

  // 直连模式开关切换：重算当前文件的可编辑态（readOnly），并让糖视图让位/恢复
  useEffect(() => {
    const ed = editorRef.current;
    const p = filePathRef.current;
    if (!ed || !p) return;
    const canEdit = unlockedPathsRef.current.has(p) || directEditable(p);
    applyEditabilityAndSuggest(ed, erbReadOnlyGate(p, { inWorkspace: inWorkspace(p), canEdit }));
    applySugarView();
  }, [directMode, kernel, applySugarView]);

  // 糖视图开关意图 → 宿主落地（插件发意图、宿主渲染；与 editor.liftPreview.show 同款）
  useEffect(() => {
    return kernel.bus.on('editor.sugarView.set', (p) => {
      if (p.filePath && p.filePath !== filePathRef.current) return;
      // 省略 `on` = 反转：状态所有者是宿主，请求方不必先问"现在是开还是关"
      setSugarView((v) => p.on ?? !v);
    });
  }, [kernel]);

  // 记录最新定位请求（同一文件重复定位靠 nonce 变化触发）
  useEffect(() => {
    revealRef.current = revealLine
      ? {
          line: revealLine,
          ...(revealColumn !== undefined ? { column: revealColumn } : {}),
          ...(revealSpan !== undefined ? { span: revealSpan } : {}),
          nonce: revealNonce ?? 0,
        }
      : null;
    applyReveal();
  }, [revealLine, revealColumn, revealSpan, revealNonce, filePath, applyReveal]);

  /** 保存成功：把该文件 model 的当前版本号立为新基线 */
  const markSaved = useCallback(
    (path: string, entry: ModelEntry) => {
      editorModelPool.setBaseline(path, entry.model.getAlternativeVersionId());
      editorModelPool.setSavedBase(path, entry.model.getValue());
      onDirtyChangeRef.current?.(path, false);
      if (filePathRef.current === path) setDirty(false);
      // 落盘成功 = 外部冲突已被用户表达处置、连败计数销账（A6 护栏与"只报一次"的复位点）
      externalConflictRef.current.delete(path);
      autosaveFailedRef.current.delete(path);
    },
    [],
  );

  /**
   * 保存指定文件（活动标签与后台标签同一条路径；A10 起返回逐文件结果）：
   * - **per-path 互斥**（`sharedSaveLock`）：同文件连点只写一次（第二次记 skipped-busy，
   *   不排队重复落盘）；不同文件互不阻塞——全局锁的旧语义退役；
   * - 先就近征询**保存接管者**（槽 `ui.editor.saveHandler`）：命中（如 `.kojo`）
   *   则由接管者完成"保存源 + 编译产物"，宿主只消费其 `outcome`；
   * - 未命中 → 缺省路径：内核 io `writeText`（保编码保换行，受写白名单约束）；
   * - `needs-choice`（全角空格告警）→ 活动标签弹确认框、**本次不落盘**；后台标签
   *   跳过并计入回执（`quiet` 模式逐条通知收进一条合成回执，跳过必须可见、不静默吞）。
   */
  const savePathDetailed = useCallback(
    async (path: string, choices?: EditorSaveChoices, quiet = false): Promise<SaveFileOutcome> => {
      const entry = entriesRef.current.get(path);
      if (!entry) return { path, status: 'failed', message: '标签已不在编辑器中' };
      saveRacedRef.current = false; // 每次保存尝试重记竞态（A6 失败守卫读这一位）
      return withPathLock(
        sharedSaveLock,
        path,
        async () => {
          const isActive = filePathRef.current === path;
          // P0 前置拦截：按文件实际可写性判定（工作区恒可写，不被项目授权状态误伤——
          // 双真相源：工作区 = 创作权威，游戏目录 = 部署目标）
          if (!kernel.io.isWritable(path)) {
            if (!quiet) {
              notify({
                kind: 'error',
                message: '保存被拒绝：项目当前为只读（写权限未批准或批准已失效）。',
                action: { label: '去授权', run: () => onReauthRef.current() },
              });
              // 用户已表达明确的写入意图 → 软件主动重弹授权对话框（实机反馈：让用户自己去
              // 发现并点击「重新授权」按钮 = 把软件的责任抛给用户，是设计错误）
              // quiet（全保存）下改由回执挂「去授权」action，一次弹窗不轰炸。
              onReauthRef.current();
            }
            if (isActive) setError('只读：写权限未批准');
            return { path, status: 'failed', message: '项目当前为只读', needsReauth: true };
          }
          const rawText = entry.model.getValue();
          // 保存前整理（E2）：跑 `Shift+Alt+F` 那一份纯函数（同一真源，不复制规则）。
          // 只改**内存文本**并让它落进 model，随后的保存链路一条不绕：写允许域已在上面判过、
          // 编码/行尾由内核 io 保、备份与原子写在 `writeText`/`compileToFile` 里。
          // 全角空格告警因此天然少弹一次：`planSave` 看的就是这份整理后的文本。
          // 糖视图下不重算预览（与 `reloadFromDisk` 同口径：派生视图随下一次切换刷新）。
          // 规则开关（P2-14）与总开关同一纪律：**落盘前现读**（不存闭包旧值）。
          // 缺省全开 ⇒ 与"开关出现之前"的保存整理逐字等价；作者显式关掉某条
          // （比如全角空格是拿来做对齐的），保存时整理同样不折——否则开关就食言了。
          const prepared = applyFormatOnSave(
            rawText,
            dialectForLanguage(languageFor(path)),
            loadFormatOnSavePref(),
            undefined,
            loadFormatRulesPref(),
          );
          let text = rawText;
          if (prepared.changed) {
            // `pushEditOperations` 一次落地全部 edits ⇒ 落进撤销栈的是**一个**元素；
            // 用它而不是 `ed.executeEdits` 是因为后台标签的 model 不在编辑器上（全部保存途中）。
            entry.model.pushEditOperations([], toTextEdits(entry.model, prepared.edits), () => null);
            text = entry.model.getValue();
          }
          // A1 保存竞态守卫：文本定稿（保存前整理已落地）即快照版本号——写盘窗口内的
          // 新输入只进 model 不进盘，落盘回包后必须版本未变才允许 markSaved 立基线，
          // 否则保持脏并如实报失败（旧链路在 await 之后立基线，把没落盘的字节标成已保存）。
          const versionAtFinalize = entry.model.getAlternativeVersionId();
          const racedAfterWrite = (): SaveFileOutcome => {
            saveRacedRef.current = true; // 写成功了，只是保存窗口内又来了新输入——A6 不当失败报
            if (isActive) setStatus('已保存，但保存期间又有新输入——文件仍标记为未保存');
            else if (!quiet) notify({ kind: 'info', message: `「${path}」保存完成，但保存期间又有新输入——已保留未保存标记` });
            return { path, status: 'kept-dirty' };
          };
          try {
            const handler = pickSaveHandler(kernel, path);
            if (handler) {
              const outcome = await handler.save({
                path,
                text,
                project: kernel.project.current(),
                ...(choices ? { choices } : {}),
              });
              if (outcome.status === 'needs-choice') {
                if (isActive) {
                  setPendingChoice(outcome.warning); // 尚未落盘：由确认框决定
                  pendingChoiceRef.current = outcome.warning; // A6 护栏读同步镜像（effect 慢一帧，定时器等不起）
                } else if (!quiet) {
                  notify({
                    kind: 'info',
                    message: `「${path}」存在保存告警，全部保存时已跳过——切到该标签单独保存可处理。`,
                  });
                }
                return { path, status: 'skipped-choice' };
              }
              if (outcome.status === 'error') {
                if (isActive) setError(outcome.message);
                else if (!quiet) notify({ kind: 'error', message: `保存「${path}」失败：${outcome.message}` });
                return { path, status: 'failed', message: outcome.message };
              }
              if (classifySaveRace(versionAtFinalize, entry.model.getAlternativeVersionId()) !== 'unchanged') {
                return racedAfterWrite();
              }
              markSaved(path, entry);
              if (isActive) {
                setError(null);
                setStatus(outcome.note ? `${outcome.message} · ${outcome.note}` : outcome.message);
              }
              return { path, status: 'saved' };
            }
            // 缺省保存（无接管者 / 提供者未激活 → 优雅降级）
            await kernel.io.writeText(path, text);
            if (classifySaveRace(versionAtFinalize, entry.model.getAlternativeVersionId()) !== 'unchanged') {
              return racedAfterWrite();
            }
            markSaved(path, entry);
            if (isActive) {
              setError(null);
              setStatus(`已保存 ${new Date().toLocaleTimeString()}`);
            }
            return { path, status: 'saved' };
          } catch (e: unknown) {
            // 竞态兜底（批准在保存途中被收回等）：WriteNotAllowedError → 中文人话 + 去授权
            if (e instanceof WriteNotAllowedError) {
              if (!quiet) {
                notify({
                  kind: 'error',
                  message: '保存被拒绝：写入路径不在已批准范围内。',
                  action: { label: '去授权', run: () => onReauthRef.current() },
                });
                onReauthRef.current();
              }
              if (isActive) setError('只读：写权限未批准');
              return { path, status: 'failed', message: '写入路径不在已批准范围内', needsReauth: true };
            }
            const msg = errorText(e);
            if (isActive) setError(msg);
            else if (!quiet) notify({ kind: 'error', message: `保存「${path}」失败：${msg}` });
            return { path, status: 'failed', message: msg };
          }
        },
        // 同文件在途（连点 / 跨组分屏并发）：拒绝第二次，绝不排队重复写盘
        (): SaveFileOutcome => ({ path, status: 'skipped-busy' }),
      );
    },
    [kernel, markSaved, notify],
  );

  /** 保存指定标签（对外保持布尔语义：非 saved 一律 false，与旧调用方零改动） */
  const savePath = useCallback(
    async (path: string, choices?: EditorSaveChoices): Promise<boolean> =>
      (await savePathDetailed(path, choices)).status === 'saved',
    [savePathDetailed],
  );

  /** 保存当前活动标签（Ctrl+S / 工具栏按钮） */
  const save = useCallback(
    async (choices?: EditorSaveChoices): Promise<boolean> => {
      const path = filePathRef.current;
      if (!path) return false;
      return savePath(path, choices);
    },
    [savePath],
  );

  /**
   * 全部保存（A10）：并发池（≤ `SAVE_MAX_CONCURRENCY` 路，防 IPC 洪泛）逐文件走
   * 保存链——不同文件并发写、同文件被 per-path 锁挡成 skipped-busy（不排队重复写）。
   * 成功/失败/跳过逐文件收集成**一条**回执通知（失败不轰炸、needs-choice 跳过必须
   * 可见）；全部 saved 才返回 true（成功的不回滚）。
   */
  const saveAll = useCallback(async (): Promise<boolean> => {
    const targets = openPathsRef.current.filter((p) => computeDirty(p));
    if (targets.length === 0) return true;
    const { ok, receipt } = await runSaveBatch(targets, (p) => savePathDetailed(p, undefined, true));
    if (receipt) {
      notify({
        kind: receipt.kind,
        message: receipt.message,
        // 写允许域拒绝合并进回执后，「去授权」入口跟着这条唯一的通知走
        ...(receipt.needsReauth ? { action: { label: '去授权', run: () => onReauthRef.current() } } : {}),
      });
    }
    return ok;
  }, [computeDirty, savePathDetailed, notify]);

  /**
   * 以磁盘最新内容重载某个打开中的 model（2026-10-12 审阅补丁，修 B1）。
   *
   * 触发源：内核事件 `file.changed`（谁改盘谁发）——当前主要来自 💡 升糖
   * （`sugar.liftApply`）。若宿主不重载，用户随后 `Ctrl+S` 会用**旧文本覆盖**
   * 磁盘上的新内容（真实数据丢失）。
   *
   * 决策纯函数 `decideExternalChange`（noop / reload / conflict）：
   * - `noop`（磁盘 == model，多为自身保存回声）→ 不动（不重置撤销栈/光标）；
   * - `reload`（磁盘变了、model 干净）→ 静默替换并立为新基线，保留视图状态；
   * - `conflict`（磁盘变了、model 脏）→ **绝不静默覆盖**：弹常驻通知说明
   *   「保存将覆盖磁盘内容」，用户可点「重新加载（放弃我的修改）」。
   */
  /** reloadFromDisk 恒稳引用（冲突 toast 的 action 点击时经它**现读盘**重跑；与 saveRef / runAutosaveRef 同款纪律——闭包不持过期文本） */
  const reloadFromDiskRef = useRef<((path: string) => Promise<void>) | null>(null);
  /** 「重新加载」点击意图（一次性：reloadFromDisk 入口消费，强制以现读盘文本落地，不再走冲突提示分支） */
  const forceReloadPathsRef = useRef(new Set<string>());
  const reloadFromDisk = useCallback(
    async (path: string): Promise<void> => {
      const entry = entriesRef.current.get(path);
      if (!entry) return; // 该文件未打开 → 与编辑器无关
      const forced = forceReloadPathsRef.current.delete(path);
      let text: string;
      try {
        ({ text } = await kernel.io.readText(path));
      } catch (e: unknown) {
        notify({
          kind: 'error',
          message: `重新加载「${path}」失败：${errorText(e)}`,
        });
        return;
      }
      // 读盘期间 model 可能已被关闭/替换（标签关闭竞态）→ 放弃
      if (entriesRef.current.get(path) !== entry) return;
      const memoryText = entry.model.getValue();
      const decision = decideExternalChange(memoryText, text, computeDirty(path), editorModelPool.savedBase(path));
      if (decision === 'noop') {
        // 点击重跑时盘已等于 model（如用户手工撤销回同内容）：冲突即已了结，销账放行自动保存
        if (forced) externalConflictRef.current.delete(path);
        return;
      }
      const applyReload = (): void => {
        // 常驻通知的 action 闭包可能晚于标签关闭才被点击——闭包只持 path+text，
        // 落地前现取 entry；缺失或 model 已 dispose（Monaco 标准 API）直接放弃，
        // 绝不对 disposed model setValue 炸异常（深审 A3）。
        const live = entriesRef.current.get(path);
        if (!live || live.model.isDisposed()) return;
        externalConflictRef.current.delete(path); // 用户已处置（放弃我的修改）：A6 护栏放行
        const ed = editorRef.current;
        const isActive = filePathRef.current === path;
        const vs = isActive && ed ? ed.saveViewState() : null;
        reloadingRef.current = true;
        try {
          live.model.setValue(text);
        } finally {
          reloadingRef.current = false;
        }
        const version = live.model.getAlternativeVersionId();
        editorModelPool.setBaseline(path, version);
        editorModelPool.setSavedBase(path, text);
        onDirtyChangeRef.current?.(path, false);
        if (isActive && ed && vs) ed.restoreViewState(vs);
        if (refreshMarkersRef.current) refreshMarkersRef.current(live.model, path);
        // C2：外部改动重载 / 冲突解决后立即补发新真相（活动文件才发；面板不该吃到
        // 旧盘文本的残影。后台标签切回来时会经 applySugarView 补发）
        if (isActive) documentBroadcaster.flush(path, () => readDocumentTruth(path));
        if (isActive) {
          setDirty(false);
          setStatus('已从磁盘重新加载（文件在外部被修改）');
          pushSelStatus(true);
        }
      };
      if (decision === 'reload' || forced) {
        applyReload();
        return;
      }
      if (typeof decision === 'object' && decision.kind === 'merge') {
        const live = entriesRef.current.get(path);
        // 合并窗口内又敲了字 ⇒ 这次不合，等下一个 file.changed（别拿过期 memoryText 覆盖新输入）
        if (!live || live.model.isDisposed() || live.model.getValue() !== memoryText) return;
        externalConflictRef.current.delete(path);
        editorModelPool.setSavedBase(path, text);
        live.model.setValue(decision.text); // 版本号变了 ⇒ 监听如实上报"仍未保存"
        if (filePathRef.current === path) setStatus('已合并磁盘改动与你的未保存改动（还没写入磁盘）');
        notify({
          kind: 'info',
          message: `已把磁盘上对「${path}」的修改和你的未保存修改合并到编辑器里，两边都保住了——内容还没写入磁盘，看过再保存。`,
        });
        return;
      }
      const clashCount = typeof decision === 'object' ? decision.conflicts.length : 0;
      // conflict：外部改动未决期间自动保存必须让路（A6 护栏；处置点 = 重新加载 / 保存成功 / 关标签）
      // 防旧文本覆盖（数据丢失）：action **不闭包本次读到的 text**——点击时经 ref 置一次性强制
      // 意图并重跑 reloadFromDisk 现读盘；点击前若又有第二次外部写入，应用的也是那一刻的真相
      // 而非过期的 T1（旧闭包 T1 + 钉基线为干净 ⇒ 下一次保存覆盖 T2）。
      // 同一文件已有未决冲突时不再叠第二条通知（去重；现存通知的 action 现读盘，同样覆盖新改动）。
      const conflictPending = externalConflictRef.current.has(path);
      externalConflictRef.current.add(path);
      if (!conflictPending) {
        notify({
          kind: 'error',
          message:
            clashCount > 0
              ? `磁盘上对「${path}」的修改和你的未保存修改有 ${clashCount} 处撞到了一起——软件没有替你取舍，编辑器里仍是你的内容；现在保存会覆盖磁盘上的新内容。`
              : `「${path}」已在磁盘上被修改，但你有未保存的修改——保存会覆盖磁盘内容。`,
          // 两个动作并列，不替用户选：「看差异」把两边真相摊开（内存侧取点击时刻现值，
          // 盘侧现读——都不许用这次通知闭包住的旧文本），「重新加载」才是放弃我的修改。
          actions: [
            {
              label: '查看差异',
              run: () => {
                const live = entriesRef.current.get(path);
                if (!live || live.model.isDisposed()) return; // 与 applyReload 同款护栏
                void openExternalChangeDiff(
                  { decision, path, memoryText: live.model.getValue() },
                  { io: kernel.io, emitDiffOpen: (p) => kernel.bus.emit('ui.diffView.open', p), notify },
                );
              },
            },
            {
              label: '重新加载（放弃我的修改）',
              run: () => {
                forceReloadPathsRef.current.add(path);
                void reloadFromDiskRef.current?.(path);
              },
            },
          ],
        });
      }
    },
    [kernel, notify, computeDirty, documentBroadcaster, readDocumentTruth],
  );
  reloadFromDiskRef.current = reloadFromDisk;

  // 外部写盘 → 重载对应 model（B1 修复）：宿主只**消费** `file.changed`，不认识"升糖"
  //
  // BUG-5 补全（§5.46 记录的已知缺口"add/unlink 不处理"）：
  // - `add` 同样触发重载——外部工具用「删除 + 重建」的方式保存时，去抖窗末态就是 add，
  //   只认 change 会让已打开的 model 停在旧内容上（读者以为"自动重载坏了"）；
  // - `unlink` 不动 model（关标签/清内容都是替用户做决定），但**必须说**：
  //   盘上没了而编辑器还在，是"保存会凭空造回这个文件"的口径问题，不能静默。
  //
  // HK-7（2026-10-13）：事件里的路径是**平台原样**，而 entriesRef 的键是宿主自己的
  // `filePath` —— 裸字符串判等一旦对不上，这条防数据丢失的链路就**静默失效**（没有任何
  // 症状，作者随后 Ctrl+S 覆盖掉外部改动而已）。所以先按 `pathKey()` 找回宿主用的那个键，
  // 之后一律用找回的键：消息里报的也是作者标签上看到的那条路径。
  useEffect(() => {
    const un = kernel.bus.on('file.changed', (ev) => {
      const opened = matchOpenedPath(entriesRef.current.keys(), ev.path);
      if (opened === null) return; // 没打开 → 与编辑器无关
      if (ev.kind === 'unlink') {
        notify({
          kind: 'error',
          message: `「${opened}」已在磁盘上被删除。编辑器里的内容现在是唯一副本——保存会重新创建该文件。`,
        });
        return;
      }
      void reloadFromDisk(opened);
    });
    return un;
  }, [kernel, reloadFromDisk, notify]);

  /**
   * 保存告警的处置（确认框回调）：
   * - `cancel`：放弃本次保存（脏标记保留）；
   * - `save-anyway`：带确认重存（不再追问）；
   * - `fix-and-save`：把编辑器里的 `U+3000` 替换为半角空格（可撤销的编辑）后重存。
   */
  const decideSaveWarning = useCallback(
    (action: 'cancel' | 'save-anyway' | 'fix-and-save') => {
      setPendingChoice(null);
      if (action === 'cancel') return;
      if (action === 'save-anyway') {
        void save({ acknowledgeFullwidthSpace: true });
        return;
      }
      const ed = editorRef.current;
      // 糖视图下不修：`ed.getModel()` 是只读糖 model，改它改的不是真文件（保存走 entry.model）。
      const model = sugarModelRef.current ? null : ed?.getModel();
      if (ed && model) {
        const fixed = model.getValue().split(FULLWIDTH_SPACE).join(' ');
        ed.executeEdits('kojo-fix-fullwidth', [{ range: model.getFullModelRange(), text: fixed }]);
        ed.pushUndoStop();
      }
      void save();
    },
    [save],
  );

  // 动作句柄注册（宿主标签流程：保存并关闭 / 全部保存）
  useEffect(() => {
    registerActions?.({ save: () => save(), savePath: (p) => savePath(p), saveAll, snapshots });
    return () => registerActions?.(null);
  }, [save, savePath, saveAll, snapshots, registerActions]);

  // 卸载时清空状态栏编辑器信息
  useEffect(() => () => onStatusInfo?.(null), [onStatusInfo]);

  // Ctrl+S 回调经 ref 读最新 save（编辑器只创建一次，save 闭包随 kernel 更新）
  const saveRef = useRef(save);
  saveRef.current = save;

  /* ------------------------ 自动保存（A6；写盘只走上面那一条 save，绝不抄第二条路） ------------------------ */

  /**
   * 闲置到点的一次尝试：现场读数进 `decideAutosave`（护栏判据是纯函数，单测钉死），
   * 放行才调 `saveRef.current()`——同一全局互斥、同一写允许域闸门、同一竞态守卫。
   * 失败如实进通知队列，但同一文件连败只报一次（销账点 = 保存成功 / 关标签）。
   */
  const runAutosave = useCallback(
    async (path: string): Promise<void> => {
      // 只管活动标签；per-path 锁被手动保存在途占住 = 这一拍放弃（下一次输入会重新计时）
      if (path !== filePathRef.current || sharedSaveLock.isBusy(path)) return;
      const entry = entriesRef.current.get(path);
      if (!entry || entry.model.isDisposed()) return;
      const decision = decideAutosave({
        mode: loadAutosavePref(),
        dirty: computeDirty(path),
        saving: false,
        saveWarningPending: pendingChoiceRef.current !== null,
        externalChangePending: externalConflictRef.current.has(path),
        sugarView: sugarModelRef.current !== null,
        writable: kernel.io.isWritable(path),
      });
      if (decision !== 'run') return;
      if (await saveRef.current()) {
        const live = entriesRef.current.get(path);
        if (live) {
          // 状态栏轻指示：复用 onStatusInfo 同一条上报链路，不新开协议
          // sel 随行——不带的话「选中…」widget 会在自动保存成功的一瞬消失（口径同 pushSelStatus）
          onStatusInfoRef.current?.({
            encoding: live.encoding,
            eol: live.eol,
            lines: live.model.getLineCount(),
            autosavedAt: Date.now(),
            sel: selStatusRef.current,
          });
        }
        return;
      }
      // false 的三种含义只有"真失败"该进通知队列：needs-choice 已弹框待决（pendingChoiceRef）、
      // 竞态保脏已自行说话（saveRacedRef）——都不许再叠一条"自动保存未成功"惊扰作者。
      if (pendingChoiceRef.current !== null || saveRacedRef.current) return;
      if (!autosaveFailedRef.current.has(path)) {
        autosaveFailedRef.current.add(path);
        notify({
          kind: 'error',
          message: `自动保存「${path}」未成功——内容仍标记未保存；原因见编辑器工具条的红色提示，手动 Ctrl+S 同样可处理。`,
        });
      }
    },
    [computeDirty, kernel, notify],
  );

  /** 闲置去抖：最后一次输入重起计时；关着开关就不挂定时器（零成本）。**恒稳引用**——model 监听只注册一次，靠 ref 读最新 tick（与 saveRef 同款纪律） */
  const runAutosaveRef = useRef(runAutosave);
  runAutosaveRef.current = runAutosave;
  const scheduleAutosave = useCallback((): void => {
    if (loadAutosavePref() !== 'afterDelay') return;
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
    const path = filePathRef.current;
    if (!path) return;
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void runAutosaveRef.current(path);
    }, AUTOSAVE_IDLE_MS);
  }, []);

  /* ---------------- 视图状态跨会话持久化（view-state-store，落盘防抖在 store 内） ---------------- */

  /** 快照当前编辑器（选区 + 滚动读数）→ 持久层。糖视图不落盘：糖的行号不属于真文件 */
  const persistEditorSlice = (ed: Monaco.editor.IStandaloneCodeEditor, path: string): void => {
    if (sugarModelRef.current) return;
    const root = kernel.project.current()?.rootDir;
    if (!root) return;
    const slice = extractViewSlice(ed.saveViewState(), ed.getScrollTop(), ed.getScrollLeft());
    if (slice) setViewState(root, path, slice);
  };
  /** 活动标签的即时快照（光标/滚动事件驱动；store 防抖合并落盘） */
  const snapshotActiveView = (): void => {
    const ed = editorRef.current;
    const path = filePathRef.current;
    if (!ed || !path) return;
    // 异步 acquire 竞态闸：`filePathRef` 先于 model 换装更新——不加闸会把 A 的光标/滚动
    // 存进 B 的键下（切回 A 时视图错位）。只认"屏幕 model == 当前路径的真 model"；
    // 糖视图（派生 model）本就落盘即跳过，这里一并挡在门外。
    const entry = entriesRef.current.get(path);
    if (!entry || ed.getModel() !== entry.model) return;
    persistEditorSlice(ed, path);
  };

  /** 从持久层恢复：行列钳进当前 model（文件可能变短）；滚动越界由 monaco 内部钳制，不抛 */
  const applyPersistedView = (
    ed: Monaco.editor.IStandaloneCodeEditor,
    model: Monaco.editor.ITextModel,
    path: string,
  ): void => {
    const root = kernel.project.current()?.rootDir;
    if (!root) return;
    const slice = getViewState(root, path);
    if (!slice) return;
    const clamped = clampSlice(slice, model.getLineCount(), (l) => model.getLineMaxColumn(l));
    try {
      // Selection 构造自带归一化（钳制后 start 可能越过 end，交换由 monaco 处理）
      ed.setSelections(
        clamped.selections.map((r) => new monaco.Selection(r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn)),
      );
      // FOLD-1：折叠状态是视图状态的一部分；恢复走 Monaco 自己的 folding contribution
      // （缺省不挂/形状不认识 ⇒ 返回 undefined，这一拍就等于没折过，不猜）
      const foldState = foldRestoreState(clamped.folds);
      if (foldState) {
        const folding = ed.getContribution(FOLDING_CONTRIBUTION_ID) as
          | { restoreViewState?: (state: unknown) => void }
          | null;
        folding?.restoreViewState?.(foldState);
      }
      ed.setScrollPosition({ scrollTop: clamped.scrollTop, scrollLeft: clamped.scrollLeft });
    } catch {
      // 出错退化 = 这次不恢复：视图状态是易失偏好，绝不反绑打开流程
    }
  };

  // 编辑器实例（仅一次）；卸载时 dispose 全部 model
  // REF-FRONT-PERF：创建/销毁、4 个命令、全局 provider 接线、模型池释放与卸载清账全部
  // 搬进 use-monaco-instance.ts。偏好与面包屑仍在这一条 effect 的原来两拍里安装（安装器
  // 由两个 hook 给出），所以 effect 数量/顺序、退订顺序与拆前逐字一致。
  useMonacoInstance({
    hostRef,
    kernel,
    refs: {
      editorRef,
      entriesRef,
      filePathRef,
      sugarModelRef,
      sugarOriginalModelRef,
      sugarLineMapRef,
      pendingActionsRef,
      actionSeqRef,
      crumbTreeCacheRef: breadcrumb.crumbTreeCacheRef,
      viewStatesRef,
      prevPathRef,
    },
    saveRef,
    notifyPreviewWriteVeto,
    clearSugarView,
    persistEditorSlice,
    snapshotActiveView,
    publishCursor,
    pushSelStatus,
    onFocusedRef,
    markerTimerRef,
    autosaveTimerRef,
    externalConflictRef,
    autosaveFailedRef,
    installPreferences,
    installBreadcrumb: breadcrumb.install,
  });

  // 「标注函数被谁调用」开关（B8）：偏好落地 / 事件订阅 / 退订全在 use-editor-preferences.ts。
  // **调用点必须留在实例创建之后**：create 时 `codeLens` 先落默认关，这一拍才把偏好覆盖上去。
  useCodeLensPreference(editorRef, kernel);

  // Monarch directive 词表同源化（T5）：判据（基底 ∪ 当前项目 adapter 的指令表、等值去重、
  // 回基底）与实例引用计数都住在 `editor-global-providers.ts`——词表喂的是全局那一份 `.erb`
  // language provider，计数留两处必漂（**项目切换不残留上一项目的词表**：`project.closed` /
  // 卸载一律回基底，与 hover 的"表随项目现取"同一纪律）。本 effect 只剩实例侧三件事：
  // 成对计数 + 两个项目事件的触发点。
  useEffect(() => {
    acquireDirectiveWords();
    const applyForCurrentAdapter = (): void => applyDirectiveWords(kernel);
    applyForCurrentAdapter();
    const offOpened = kernel.bus.on('project.opened', () => applyForCurrentAdapter());
    const offClosed = kernel.bus.on('project.closed', () => applyForCurrentAdapter());
    return () => {
      offOpened();
      offClosed();
      releaseDirectiveWords();
    };
  }, [kernel]);

  // 标签关闭 → model 池引用回收（不在 openPaths 中的一律释放；绝不泄漏）。
  // SPLIT-1：同文件可能仍被另一组引用——problems 清理与"报不脏"只在**最后一份**
  // 引用释放（模型真正 dispose）时做，否则一组关标签会端走另一组的波浪线/脏点。
  useEffect(() => {
    const keep = new Set(openPaths);
    for (const [path, entry] of [...entriesRef.current]) {
      if (keep.has(path)) continue;
      // 关闭的是活动标签：切换 effect 不会再为它存视图（条目即释放），此处补最后快照
      if (path === prevPathRef.current) {
        const closing = editorRef.current;
        if (closing && closing.getModel() === entry.model) persistEditorSlice(closing, path);
      }
      entry.listener.dispose();
      const left = editorModelPool.release(path);
      // 装饰缓存跟着本组标签走：新开的 model 版本号会从 1 重新数，留着旧条目就可能
      // 把"上一份 model 的同版本号"当成同一份内容发上屏（判据不成立就不许命中）。
      // 每组各丢各的缓存；共享 model 的另一组由它自己的 runner 继续供。
      markerRunner.dropPath(path);
      // PS-5 投影缓存同批作废（关标签 = 这份内容不再被任何标签认领；留着就是白占一份正文）
      if (sugarCacheRef.current?.path === path) sugarCacheRef.current = null;
      // 面包屑树缓存同理：重开同一文件时 model 的版本号会从 1 重新数，
      // 留着旧条目就可能把上一份内容的树当"当前内容"发上屏（与 #F6 同一条理由）。
      if (breadcrumb.crumbTreeCacheRef.current?.path === path) breadcrumb.crumbTreeCacheRef.current = null;
      entriesRef.current.delete(path);
      viewStatesRef.current.delete(path);
      if (left === 0) {
        clearProblems(path); // 最后一份引用：同步清掉该文件在问题面板里的条目
        externalConflictRef.current.delete(path);
        autosaveFailedRef.current.delete(path);
        onDirtyChangeRef.current?.(path, false);
      }
    }
  }, [openPaths, markerRunner]);

  // 切换活动标签（model 复用；首次打开读盘建 model）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ed = editorRef.current;
      if (!ed) return;
      // 先把上一个标签的视图状态存下（光标/滚动原位恢复）
      const prev = prevPathRef.current;
      if (prev && prev !== filePath && entriesRef.current.has(prev)) {
        // 糖视图挂着时 saveViewState() 记的是**派生行号/折叠**：不得写进原文条目的内存视图
        if (!sugarModelRef.current) viewStatesRef.current.set(prev, ed.saveViewState());
        persistEditorSlice(ed, prev);
      }
      let entry = entriesRef.current.get(filePath);
      if (!entry) {
        // 探针：切文件一次性成本 = 读盘 + 建 model（+ 下方 apply 段）
        const stopRead = perf.start('switch.readText');
        try {
          // 崩溃恢复注入（退出/崩溃守护批）：该路径有恢复快照 → 不读盘，直接以快照
          // 内容建 model，基线版本号钉在 0（初始版本号从 1 起数，永不相等）⇒ model
          // 一生出来就是"未保存脏"。恢复**永不自动写游戏目录**：存不存由用户决定。
          // （SPLIT-1：model 经进程级池取——同文件另一组已开则直接共享同一份；
          //   恢复注入只在"全池首次打开"生效，快照语义本就是重启后第一次。）
          // **竞态修复（"app ate my work"批）**：快照只 **peek 不消费**——消费一律推迟到
          // 提交闸之后（!cancelled 且条目落进 entriesRef 且基线已由池钉住）。旧的"取即删"
          // 让快速切换（cancelled 生效）后的重跑拿到 null → 按读盘语义补基线 → 恢复内容
          // 被洗成"干净"：autosave 不存、退出无提示丢弃、外部 file.changed 直接覆盖。
          // 基线钉 0 由**池在建 model 的那一刻**落在记录上（fromRecovery），不依赖闭包里的
          // `recovered` 撑过 await。
          const recovered = peekRecoveredContent(filePath);
          const pooled = await editorModelPool.acquire(
            kernel,
            filePath,
            recovered
              ? { text: recovered.text, encoding: recovered.encoding, eol: recovered.eol }
              : undefined,
          );
          stopRead();
          if (cancelled) {
            // 引用计数对称回收：这次 acquire 不提交就必须 release（refcount-leak 修复——
            // 快速 Ctrl+P 每次竞态都会留下一份没人认领的 model/引用，整个会话不释放）。
            // 快照未消费（peek 语义），下一轮重跑照常能以恢复内容重建。
            editorModelPool.release(filePath);
            return;
          }
          const model = pooled.model;
          // 逐 model 脏监听（BUG-4：版本号 O(1) 比较；后台标签的编辑同样上报）；
          // 每组各挂各的监听（共享 model 的另一组由它自己的监听上报）
          const listener = model.onDidChangeContent(() => {
            // 探针（内核优化 L0）：击键路径应**恒 <1ms**（dirty 是 O(1)、装饰已去抖）；
            // 若 p95 超 1ms，说明 React 层或别处有未知同步开销。
            const t0 = performance.now();
            try {
              if (reloadingRef.current) return; // 磁盘重载非用户编辑：不报脏、不排装饰
              const d = computeDirty(filePath);
              onDirtyChangeRef.current?.(filePath, d);
              if (filePathRef.current === filePath) {
                setDirty(d);
                scheduleMarkers();
                // C2：活动文件缓冲变化 → 防抖广播"当前真相"（糖视图激活时广播器自行抑制；
                // 程序性整篇改写——fix-all / 重命名批量 / 保存前整理——同样走这条通道）
                documentBroadcaster.schedule(filePath, () => readDocumentTruth(filePath));
                if (d) scheduleAutosave(); // A6：脏了才起闲置计时（撤销回干净由 tick 的护栏判掉）
              }
            } finally {
              perf.record('input.handler', performance.now() - t0);
            }
          });
          entry = { model, listener, encoding: pooled.encoding, eol: pooled.eol };
          entriesRef.current.set(filePath, entry);
          // 已保存基线只在**本条目首次落进池记录**时按当前版本号落定；池里已有基线就不碰——
          // 恢复件的 0 钉（池建 model 时落的：内容本身就是"未保存"，撤销回快照原样脏标也不消失）
          // 与另一组未保存的保存点都属文件级真相，无条件重设等于"第二组一打开就把第一组的
          // 未保存内容洗成干净"（本批竞态的另一半成因）。
          if (editorModelPool.baseline(filePath) === undefined) {
            editorModelPool.setBaseline(filePath, model.getAlternativeVersionId());
          }
          // 提交成功（条目已入、基线已钉）⇒ 此刻才允许消费恢复快照；内容从此活在共享 model 里，
          // 由 autosave/用户保存接管后续。本轮没真用上快照（池里已是读盘 model）就**不消费**——
          // 留给下一次全池首开。
          if (recovered && pooled.fromRecovery) dropRecoveredContent(filePath);
        } catch (e: unknown) {
          stopRead(); // 幂等：读盘失败时补记一次采样（正常路径已记过则跳过）
          if (!cancelled) setError(errorText(e));
          return;
        }
      }
      // 探针：apply 段 = setModel + 选项更新 + 视图恢复 + 装饰刷新（同步可测）
      const stopApply = perf.start('switch.apply');
      prevPathRef.current = filePath;
      // 糖视图把编辑器换成了只读糖 model，换文件前必须先撤下（换回上一个文件真 model 并
      // dispose 糖 model）——否则下一个文件的 `setModel` 会踩在一份派生物上。
      // 必须在 `setModel` **之前**调用。
      clearSugarView();
      // 两道**正交轴**（ADR-0005，两组共同依据）：
      //   轴一 · 目录分野 = 默认可写性：工作区 ERB 是创作源文件恒可编辑；游戏目录 ERB 默认只读。
      //   轴二 · 显式解锁 = 游戏目录里"这一份、这一次"的破例（`unlockedPathsRef`，
      //          按文件按会话、**不落盘**——"上次解锁过就一直可写"会让写保护形同虚设）。
      // 先按文件体量落 Monaco 选项，再挂 model——避免超长文件先在"默认全文级选项"
      // 下渲染一帧（大文件降级清单见 editor-options.ts）。
      const allowEdit = unlockedPathsRef.current.has(filePath) || directEditable(filePath);
      setUnlocked(allowEdit);
      const readOnly = erbReadOnlyGate(filePath, { inWorkspace: inWorkspace(filePath), canEdit: allowEdit });
      // 档位判据 = 此刻屏幕上这份**原文**的行数；可写态与快建议在 overrides 里盖在档位之后
      const tierLines = entry.model.getLineCount();
      applySizeTier(ed, tierLines, tierOverrides(tierLines, isErbLike(filePath), {
        readOnly,
        // 体量档位也会带 quickSuggestions（代码位开）；只读 / 设置页关掉必须在这里整条盖掉
        quickSuggestions: quickSuggestionsFor(readOnly, loadQuickSuggestionsPref()),
        quickSuggestionsDelay: loadSuggestDelayPref(),
      }, minimapCtxForPath(filePath)));
      ed.setModel(entry.model);
      const vs = viewStatesRef.current.get(filePath);
      if (vs) ed.restoreViewState(vs);
      else applyPersistedView(ed, entry.model, filePath);
      setDirty(computeDirty(filePath));
      setError(null);
      // 换文件才作废未决的保存告警（避免误对旧文件应用修复）；同文件重跑（依赖抖动 /
      // kernel 换代）不清——否则正弹着的确认框会被静默吞掉，保存意图丢失。
      if (prev !== filePath) setPendingChoice(null);
      setStatus(`${entry.encoding} · ${entry.eol} · ${entry.model.getLineCount()} 行`);
      pushSelStatus(true);
      // 打开/切换即算一次装饰（不等用户编辑）——首屏就能看到波浪线
      if (markerTimerRef.current !== null) window.clearTimeout(markerTimerRef.current);
      markerTimerRef.current = null;
      refreshMarkers(entry.model, filePath);
      applySugarView(); // 预览：整份 ERB 投影成 .kojo 写法（默认关；`.kojo` 自动跳过）
      applyReveal();
      // C1 反向下行批：setModel + 视图恢复 + 定位都落定后补发一次位点——面板刚切过来
      // 就有位点（此前收到的还是上一份文件的旧位点，消费方按 filePath 判等自会忽略）
      publishCursor();
      stopApply();
    })();
    return () => {
      cancelled = true;
    };
  }, [kernel, filePath, applyReveal, refreshMarkers, computeDirty, scheduleMarkers, scheduleAutosave, clearSugarView, applySugarView, documentBroadcaster, readDocumentTruth, publishCursor]);

  /* ------------------- 只读锁：编辑意图 → 询问 → 解锁 ------------------- */

  /** 解锁 / 回锁当前 ERB（解锁即关闭该文件的糖视图——两者互斥） */
  const setErbEditable = useCallback(
    (path: string, allowEdit: boolean) => {
      const ed = editorRef.current;
      if (allowEdit) unlockedPathsRef.current.add(path);
      else unlockedPathsRef.current.delete(path);
      if (filePathRef.current !== path || !ed) return;
      setUnlocked(allowEdit);
      // 轴二只管游戏目录那一份：工作区文件本就可写，不存在"解锁/回锁"这回事
      // （ADR-0005 给糖组的适配项——别把写保护铁律的代价转嫁到正常操作上）。
      // 回锁时若直连开门仍应保持可编辑（直连是独立的可编辑来源）。
      const canEdit = allowEdit || directEditable(path);
      applyEditabilityAndSuggest(ed, erbReadOnlyGate(path, { inWorkspace: inWorkspace(path), canEdit }));
      // 解锁 → 糖视图必须让位（原文要看得见）；回锁 → 重新生成糖视图
      applySugarView();
    },
    [applySugarView],
  );

  // 首次打开 ERB：问一次"要不要开预览"（问过就再不问）。
  // **工作区 ERB 不弹**（恒可编辑，预览本就不生效，问了没有意义——ADR-0005 轴一）；
  // 已解锁编辑的文件同样不弹（轴二的破例态下预览也让位）。
  // 默认关之后，这一次询问就是本功能主要的发现路径 ⇒ **必须保留**（预览已不在封存清单里，
  // 不再有"封存时不弹"这一条）。
  useEffect(() => {
    if (
      !sugarViewAllowed({
        isErbLike: isErbLike(filePath),
        inWorkspace: inWorkspace(filePath),
        unlocked: unlockedPathsRef.current.has(filePath) || directEditable(filePath),
      })
    )
      return;
    if (loadSugarViewPrompted()) return;
    setIntroAsk(true);
  }, [filePath]);

  const decideIntro = useCallback((on: boolean) => {
    saveSugarViewPrompted();
    setIntroAsk(false);
    setSugarView(on); // 走既有的偏好持久化 + 重算链路
  }, []);

  // 只读态下用户尝试输入 → 询问"保持只读 / 允许编辑"（Monaco 的只读编辑意图事件）
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const disposable = ed.onDidAttemptReadOnlyEdit(() => {
      const path = filePathRef.current;
      if (!isErbLike(path) || unlockedPathsRef.current.has(path) || directEditable(path)) return;
      // 已弹着就不再重复弹（连按键盘会产生一串事件）
      setUnlockAsk((cur) => cur ?? path);
    });
    return () => disposable.dispose();
  }, []);

  const decideUnlock = useCallback(
    (allow: boolean) => {
      const path = unlockAsk;
      setUnlockAsk(null);
      if (!path || !allow) return;
      setErbEditable(path, true);
      notify({
        kind: 'info',
        message: isSealed()
          ? '已允许编辑这份文件 · 你改的是游戏目录里的原生文件，请当心'
          : '已允许编辑此 ERB · .kojo 预览已关闭（建议改在自己的 .kojo 口上文件里写内容）',
      });
    },
    [unlockAsk, setErbEditable, notify],
  );

  /**
   * 编辑器动作意图（R8 命令面板补齐批）：命令面板的查找/替换/格式化/重命名/引用
   * 都从这里落地。壳层只发意图（`editor.action.request`），Monaco action id 的知识
   * 留在编辑器这一侧——发起方不必知道 Monaco 的内部命名。
   *
   * 判据与 fixAll 同款：没有活动文件 / 糖视图挂着（只读派生 model）时**可见拒绝**
   * 不静默；动作缺席（当前语言没注册对应能力）也明说。
   */
  useEffect(() => {
    const ACTION_IDS = {
      find: 'actions.find',
      replace: 'editor.action.startFindReplaceAction',
      formatDocument: 'editor.action.formatDocument',
      rename: 'editor.action.rename',
      references: 'editor.action.goToReferences',
      gotoLine: 'editor.action.gotoLine',
    } as const;
    const un = kernel.bus.on('editor.action.request', (p) => {
      const ed = editorRef.current;
      if (!ed) {
        notify({ kind: 'info', message: '先打开一份文件，再执行这个动作。' });
        return;
      }
      if (sugarModelRef.current) {
        // VETO-1：否决必须给出路——按钮走工具条那颗开关同一条通道（原文面不经过这里）
        notifyPreviewWriteVeto(PREVIEW_WRITE_VETO);
        return;
      }
      const action = ed.getAction(ACTION_IDS[p.action]);
      if (!action) {
        notify({ kind: 'info', message: '当前文件类型不支持这个动作。' });
        return;
      }
      void action.run();
    });
    return un;
  }, [kernel, notify, notifyPreviewWriteVeto]);

  /**
   * E3「全部修复」的落地入口——`editor.fixAll.request` 的唯一实现（2026-10-16 批量修复批；
   * VETO-1 把"没落"的三种原因拆开说）。
   *
   * 宿主在这里只做三件事，**零批量判据**（判据全在 `kojo-fix-all.ts` 的纯函数里）：
   * ① 按既有的那道闸判"这份文件能不能改"（目录分野 + 逐份解锁，与 `setModel` 时
   *    挂给 Monaco 的 `readOnly` 同一个表达式，不另立第二套口径）；
   * ② 把 model 的读文本 / 行数 / 落改写包成 `FixAllDeps` 的四个回调——落地用的就是
   *    💡 那一条 `applyTextEdits` 通道（降序 + 夹取 + 一次 `executeEdits`），
   *    **不新造第二套编辑应用机制**，一轮 = 一个撤销步；
   * ③ 结果如实说一句（补了几处 / 剩下几处为什么要逐处选），绝不静默返回"按了没反应"
   *    （铁律 4）。命令恒可按下 = 就是这个道理：灰掉的命令要按得下去才知道为什么没修。
   *
   * 三种"没落"各说各话，绝不混成一条（VETO-1）：
   * - **预览面只读**：派生 model 上改不到真文件 ⇒ 带「切回原文」出路的否决；
   * - **文件被外部改动**（保存冲突未决）：先让作者决定保留哪边，别把旧缓冲区上的修法
   *   写回去再保存——那会把两边的改动搅在一起；
   * - **无可用修法**：明说"不必再按"，不拿一句"按了没反应"糊过去。
   *
   * 与 `editor-global-providers.ts` 里预览 overlay 那一枚**同名函数**不是同一条路：
   * 那枚管 💡 单条改写的布尔回执（在允许的文件边界之外），本枚管壳层「一键修复」意图。
   *
   * 只改缓冲区、**不碰磁盘**：保存仍由作者 Ctrl+S 决定（与 💡 完全同级，批量只是次数）。
   */
  const applyQuickFixEdits = useCallback((): void => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    const path = filePathRef.current;
    if (!ed || !model || !path) {
      notify({ kind: 'info', message: '先打开一份口上文件，再用一键修复。' });
      return;
    }
    // ① 预览面只读（派生 model）——否决带出路，与另外两条总线否决同一枚按钮
    if (sugarModelRef.current) {
      notifyPreviewWriteVeto('.kojo 预览是只读显示，改不到原文件——先切回原文再一键修复。');
      return;
    }
    // ② 文件被外部改动、保存冲突还没处置（与 A6 自动保存护栏读同一个信号）
    if (externalConflictRef.current.has(path)) {
      notify({
        kind: 'info',
        message: `「${path}」在磁盘上已被外部改动，保存冲突还没处置——先决定保留哪边，再一键修复。`,
      });
      return;
    }
    const canEdit = unlockedPathsRef.current.has(path) || directEditable(path);
    if (erbReadOnlyGate(path, { inWorkspace: inWorkspace(path), canEdit })) {
      notify({ kind: 'info', message: '这份文件当前只读，一键修复不动它——先按提示允许编辑这份文件。' });
      return;
    }
    const report = runFixAll({
      decorators: kernel.slots.query('ui.editor.decorator'),
      codeActions: kernel.slots.query('ui.editor.codeAction'),
      path,
      project: kernel.project.current(),
      readText: () => model.getValue(),
      lineCount: () => model.getLineCount(),
      apply: (edits) => applyTextEdits(ed, edits),
    });
    // ③ 无可用修法：一句独立的"不必再按"，不借用 ①② 的措辞
    const nothingToFix =
      report.fixed === 0 &&
      report.ambiguous === 0 &&
      report.bundled === 0 &&
      report.manual === 0 &&
      report.conflicted === 0 &&
      report.unclaimed === 0;
    if (nothingToFix) {
      notify({ kind: 'info', message: '这一份没有可自动补好的修法——不必再按了。' });
      return;
    }
    notify({ kind: 'info', message: fixAllSummary(report) });
  }, [kernel, notify, notifyPreviewWriteVeto]);

  useEffect(() => {
    return kernel.bus.on('editor.fixAll.request', () => applyQuickFixEdits());
  }, [kernel, applyQuickFixEdits]);

  const labelParts = pathLabelParts(filePath);

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        {/* 身份优先（UI P4）：文件名 + 最深一层目录恒显，只有长前缀可缩。
            旧版整条路径交给 CSS 尾部省略，1280 窗口下 969px 塞进 550px ⇒ 裁掉的
            正好是文件名，作者盯着工具条读到的是游戏目录前缀。完整路径留在 title 里。 */}
        <span className="file-label" title={filePath}>
          {labelParts.head !== '' ? <span className="file-dir">{labelParts.head}</span> : null}
          {labelParts.tail !== '' ? <span className="file-pkg">{labelParts.tail}</span> : null}
          <span className="file-base">{labelParts.base}</span>
        </span>
        <span className={`dirty-dot ${dirty ? 'on' : ''}`} title={dirty ? '未保存' : '已保存'}>
          {dirty ? <Icon name="circle-filled" size={9} /> : null}
        </span>
        {/* PS-5 校验暂停闸的可见性（铁律 4「内核不静默」在宿主这一侧的落点）：
            波浪线与右侧问题列表停了，就必须有一句话说它为什么停、以及"内容/保存没受影响"。
            文案走作者口径（不出现 marker / 装饰 / 阈值这类内部词），细节放悬停。
            盒子复用 `.erb-mode-hint` 那一族徽章度量（工具条里已有两家同款），不另造一档样式。 */}
        {markerPaused[filePath] === true ? (
          <span
            className="erb-mode-hint"
            title={
              '这份文件太大，把整篇重算一遍会让界面卡好几秒，所以这里先不给检查结果（行上没有波浪线，右侧问题列表这一份文件是空的）。' +
              ' 你的内容和保存都不受影响；换回较小的文件，检查会自动跟上。'
            }
          >
            <Icon name="warning" size={13} /> 文件太大，错误检查已暂停
          </span>
        ) : null}
        {/* 折叠超额的那句人话（同一族徽章度量，不另造样式）：说的是"少折了"，
            不是"文件太大所以不给你折"——后者由折叠槽整条不见来表达，两句不许混。 */}
        {foldingCap[filePath] ? (
          <span
            className="erb-mode-hint"
            title={
              `这份文件里能折起来的地方太多，界面上只折住最靠前的 ${FOLDING_MAX_RANGES} 处，` +
              `另外 ${foldingCap[filePath].droppedRanges} 处先原样摊着（内容一字未改，往下滚照样能读、能改）。` +
              ' 换回较短的文件就全部折得动。'
            }
          >
            <Icon name="warning" size={13} /> 折叠太多，只折前 {FOLDING_MAX_RANGES} 处
          </span>
        ) : null}
        {isErbLike(filePath) && !inWorkspace(filePath) ? (
          <>
            {/* 两道正交轴的呈现（ADR-0005）：能走到这里说明这是**游戏目录里的 ERB**
                （工作区 ERB 恒可编辑，不开预览）。
                只读**不再在这里挂胶囊**——它与底部状态栏那颗是同一件事，两处并排等于互相抢答
                （2026-10-14 去重），原先挂在徽章上的那句解释迁进了状态栏胶囊的悬停。
                纯说明性标签不带操作入口——旧的「强制编辑 ERB」按钮按需求 §1.4 作废。 */}
            {unlocked ? (
              // 解锁 = 写保护对这一份文件暂时失效，是**需要被看见**的破例态 → 琥珀警示色；
              // 只读反而是安全默认态 → 中性色（见 styles.css `.erb-mode-hint` 配色口径）。
              <button
                className="erb-mode-hint unlocked"
                onClick={() => setErbEditable(filePath, false)}
                title={
                  sealed
                    ? '已破例允许编辑这一份文件（只对本次会话有效，关闭编辑器即失效）。改的是游戏目录里的原生文件，请当心。'
                    : '已破例允许编辑这一份文件（只对本次会话有效，关闭编辑器即失效），.kojo 预览同时关闭——要动手改的原文必须看得见。点击收回这次破例。'
                }
              >
                <Icon name="edit" size={13} /> 已解锁编辑
              </button>
            ) : directMode && kernel.io.isWritable(filePath) ? (
              /* 直连模式：已获写权限的目录内文件直接可编辑 → 信息色提示（非警示）。
                 直连可编辑 ⟹ 预览让位（与 unlocks 同口径，ADR-0005 互斥）→ 不渲染预览 toggle。 */
              <span
                className="erb-mode-hint direct"
                title="直连模式已开启：这份文件在已获写权限的目录内，可直接编辑（就地修改游戏目录）。写权限仍只来自你批准的可写目录。"
              >
                直连可编辑
              </span>
            ) : (
              <>
                {/* 预览开关：整份 ERB 投影成 .kojo 写法（只读显示，磁盘一字未动）——
                    本功能的存在理由就是让不熟悉原生语法的人也能把别人的口上当剧本读懂。
                    **默认关**（选择会被记住），发现路径 = 首次打开游戏目录 ERB 时的那一次询问。
                    图标走 HK-4 UI-3 的单色 `Icon` 通道（`currentColor`，跟 `.on` 的文字色一起变）。
                    标签**恒为「.kojo 预览」**，开关状态交给 .on 配色 + aria-pressed 表达：
                    按状态换字时两档字数不同，每点一次工具条就横向抖一下（与 T3 根除的树抖动同类缺陷）。
                    悬停那一格说的是什么由 `sugar-view.ts` 的 `sugarToggleTitle` 单源给出——
                    它多知道一件事：**这一份文件到底投出了几段**（零段 = 屏上还是原文，
                    `langDoc: native` 的起手文件全是这种），那一拍不许再讲"当前显示的是"。 */}
                <button
                  className={`ghost small sugar-toggle${sugarView ? ' on' : ''}`}
                  aria-pressed={sugarView}
                  onClick={() => setSugarView((v) => !v)}
                  title={sugarToggleTitle({
                    on: sugarView,
                    // 读数只认**这一份文件**的（换文件后旧读数不许说话）；没算过 = null
                    segments:
                      sugarSegments && sugarSegments.path === filePath ? sugarSegments.segments : null,
                  })}
                >
                  <Icon name="preview" size={13} /> .kojo 预览
                </button>
                {sugarView && sugarStats ? (
                  <>
                    <span
                      className="sugar-stats dim"
                      title="其余行按原样显示：.kojo 还没覆盖到的控制流（SIF / 循环 / TRY）、赋值与调用，以及注释和空行。文件内容始终没有被改动。"
                    >
                      {sugarStats}
                    </span>
                    {/* 阅读模式开关（C-2）：默认阅读态——`续`、`空行`、`等待`、`：` 这类
                        语法标记降到低对比、台词成为主体；打开恢复主题高对比，逐字看清标记。
                        只动显示层（token 装饰），投影文本一字不变。标签恒为「显示语法标记」，
                        状态交给 .on + aria-pressed（C-1a 防工具条横抖的口径）。 */}
                    <button
                      className={`ghost small sugar-marks-toggle${sugarMarks ? ' on' : ''}`}
                      aria-pressed={sugarMarks}
                      onClick={() => setSugarMarks((v) => !v)}
                      title={
                        sugarMarks
                          ? '语法标记当前高对比显示。点击切回阅读态：续、空行、等待这类标记降到低对比，台词成为主体。只改显示，不改动文件。'
                          : '当前是阅读态：续、空行、等待这类语法标记已降到低对比。点击恢复高对比，逐字看清语法标记。只改显示，不改动文件。'
                      }
                    >
                      显示语法标记
                    </button>
                  </>
                ) : null}
              </>
            )}
          </>
        ) : null}
        <span className="spacer" />
        <span className="editor-status">
          {error ? (
            <>
              <Icon name="warning" size={13} /> {error}
            </>
          ) : (
            status
          )}
        </span>
        {/* 保存三段式（P3-4）：醒目度跟着「有没有东西可存」走——
            只读态整颗**不渲染**（只读的说明只留底部状态栏胶囊一处，2026-10-14 去重口径，
            工具条不再重造只读提示，也不摆一颗永远按不动的实心按钮）；
            可写但无改动 = .idle 弱化档（ghost 化，仍 disabled，快捷键行为零改动）；
            改过内容才回到醒目主按钮。判定用 `kernel.io.isWritable` 同一真源，不另立口径。 */}
        {kernel.io.isWritable(filePath) ? (
          <button
            className={`primary small${dirty ? '' : ' idle'}`}
            onClick={() => void save()}
            disabled={!dirty}
          >
            保存 (Ctrl+S)
          </button>
        ) : null}
      </div>
      {/* 面包屑（D1，宿主自绘）：角色/家族级导航复用 documentSymbol 链（外→内），
          每段后面的把手展开**同级**列表（1020 编辑器体感批，数据在同一棵缓存树上）。
          空链整条不渲染（糖视图 / 不在任何块内 = 没有可信的真文件行号可展示）。
          点击走 `editor.revealLocation` 既有通道跳块头行——不新造导航机制。 */}
      <CrumbBar
        levels={breadcrumb.crumbLevels}
        onRevealLine={(line) => {
          if (!filePath) return;
          kernel.bus.emit('editor.revealLocation', { filePath, line, source: '面包屑' });
        }}
      />
      <div className="editor-body" ref={hostRef} />
      {pendingChoice ? <SaveWarningDialog warning={pendingChoice} onDecide={decideSaveWarning} /> : null}
      {introAsk ? <SugarViewIntroDialog onDecide={decideIntro} /> : null}
      {unlockAsk ? (
        sealed ? (
          <ErbReadonlyAskDialog fileName={baseNameOf(unlockAsk)} onDecide={decideUnlock} />
        ) : (
          <ErbUnlockDialog fileName={baseNameOf(unlockAsk)} onDecide={decideUnlock} />
        )
      ) : null}
    </div>
  );
}
