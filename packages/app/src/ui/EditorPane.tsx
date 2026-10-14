import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type * as Monaco from 'monaco-editor';
import type { Kernel } from '@kojo/kernel';
import type {
  EditorCodeAction,
  EditorSaveChoices,
  EditorSaveHandlerContribution,
  EditorSaveWarning,
  EditorTextEdit,
  LineDecoration,
} from '@kojo/plugin-api';
import { FULLWIDTH_SPACE, WriteNotAllowedError } from '@kojo/plugin-api';
// monaco-editor 0.57 的 exports 映射：'monaco-editor/*' → './esm/vs/*.js'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import * as monaco from 'monaco-editor';
import { ERB_LANGUAGE_ID, registerErbLanguage } from '../monaco/erb-language';
import { KOJO_LANGUAGE_ID, decorationsToMarkers, registerKojoLanguage } from '../monaco/kojo-language';
import { useNotify } from './NotificationCenter';
import { SaveWarningDialog } from './SaveWarningDialog';
import { editorOptionsForLineCount } from './editor-options';
import { ErbReadonlyAskDialog, ErbUnlockDialog, SugarViewIntroDialog } from './SugarViewDialogs';
import { decideExternalChange, matchOpenedPath } from './external-change';
import { clampRange, erbReadOnlyGate, isErbLike } from './lift-preview';
import { pathLabelParts, splitPath } from './path-label';
import { Icon } from './icons';
import { perf } from '../perf';
import {
  composeSugarDoc,
  loadSugarViewPref,
  loadSugarViewPrompted,
  saveSugarViewPref,
  saveSugarViewPrompted,
  sugarSummary,
  sugarViewAllowed,
  trimSegmentBlanks,
} from './sugar-view';
import { isSealed, subscribeSealed, useSealed } from './sealed';
import { isDirectMode, useDirectMode } from './direct-mode';
import { isUnderAnyRoot, workspaceRootsOf } from './workspace-roots';
// 问题汇总：refreshMarkers 逐文件整份发布两层波浪线（erb-parser / condition-extractor）到 problem-store
import { clearAllProblems, clearProblems, setProblems } from './problem-store';

// Monaco worker 装配（vite ?worker 后缀）；ERB 无需语言服务 worker，base 编辑器 worker 即可
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};
registerErbLanguage(monaco);
registerKojoLanguage(monaco);

/** marker owner（同一 owner 的 markers 每次整体替换；不同 owner 互不干扰） */
const MARKER_OWNER = 'kojo-decorators';
/** CodeAction 执行命令 id（宿主统一注册一次；command 参数为 pendingActionsRef 的反查 key） */
const CODE_ACTION_COMMAND = 'kojo.codeAction.run';
/** 编辑停顿多久后重算装饰（避免每击键跑一遍转译） */
const MARKER_DEBOUNCE_MS = 250;

/** 按扩展名选语言：`.kojo` = 语法糖表层 DSL；其余按原生 ERB（v0.1 口径） */
function languageFor(filePath: string): string {
  return /\.kojo$/i.test(filePath) ? KOJO_LANGUAGE_ID : ERB_LANGUAGE_ID;
}

/**
 * 就近征询**保存接管者**（槽 `ui.editor.saveHandler`，2026-10-12 批）：返回
 * `order` 最小的命中贡献（唯一接管，不做链式级联）；无命中 → undefined（宿主
 * 退回内核 io `writeText` 缺省保存）。单个贡献抛错不影响其余（与装饰器同款
 * 隔离——能力出错要"退化可见"，不让整条保存链断掉）。
 */
function pickSaveHandler(kernel: Kernel, path: string): EditorSaveHandlerContribution | undefined {
  const matches: EditorSaveHandlerContribution[] = [];
  for (const contribution of kernel.slots.query('ui.editor.saveHandler')) {
    try {
      if (contribution.matches(path)) matches.push(contribution);
    } catch (e: unknown) {
      // 贡献抛错不静默（与 plugin-api「绝不静默」约定一致）：
      // 记录后仍降级为缺省保存，避免单个坏贡献阻断整条保存链路。
      console.warn(
        `[EditorPane] save handler '${contribution.id}' matches('${path}') 抛错：${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); // 稳定排序：同 order 保持注册顺序
  return matches[0];
}

/**
 * 把 💡 动作给出的**行级改写**落成一次 Monaco 编辑（**一次撤销步**，`Ctrl+Z` 可撤回）。
 *
 * 三条纪律：
 * - **降序应用**：从最大行号开始替换，前面的行号才不会因替换而位移（与
 *   `lift-apply.ts` 的倒序替换同源理由）；
 * - **坐标夹取**：贡献方给出的行号可能因"供给与执行之间用户又编辑了"而过期，
 *   夹取而非报错（陈旧行号不该让编辑器崩）；
 * - **单次 `executeEdits`**：多段改写合并成一个撤销步——用户按一次 Ctrl+Z 应当
 *   撤销"这次改写"，而不是被要求按 N 次。
 *
 * 返回是否真的落了一次编辑。
 */
function applyTextEdits(
  ed: Monaco.editor.IStandaloneCodeEditor,
  edits: readonly EditorTextEdit[],
): boolean {
  const model = ed.getModel();
  if (!model || edits.length === 0) return false;
  const maxLine = model.getLineCount();
  const ops = edits
    .map((e) => {
      const from = Math.min(Math.max(1, Math.trunc(e.fromLine) || 1), maxLine);
      const to = Math.min(Math.max(from, Math.trunc(e.toLine) || from), maxLine);
      return { range: new monaco.Range(from, 1, to, model.getLineMaxColumn(to)), text: e.newText };
    })
    .sort((a, b) => b.range.startLineNumber - a.range.startLineNumber);
  ed.executeEdits('kojo.codeAction', ops);
  ed.pushUndoStop();
  return true;
}

/**
 * 路径末段（弹窗里给文件名而不是整条路径：用户认文件，不认目录树）。
 * 拆分口径与工具条共用 `path-label.splitPath`，一处规矩。
 */
function baseNameOf(path: string): string {
  return splitPath(path).base;
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
  /** 保存全部脏标签（逐一走保存接管链；needs-choice 的后台标签跳过并通知） */
  saveAll: () => Promise<boolean>;
}

/** 单个打开文件的 model 记录（多标签：model 随标签存续，切换不销毁） */
interface ModelEntry {
  model: Monaco.editor.ITextModel;
  listener: Monaco.IDisposable;
  /** 打开时的编码/EOL（状态栏展示用；保存由内核 io 保编码） */
  encoding: string;
  eol: string;
}

interface Props {
  kernel: Kernel;
  /** 当前活动标签路径 */
  filePath: string;
  /** 全部打开的标签（model 生命周期以此为准：不在列表中的 model 被 dispose） */
  openPaths: readonly string[];
  /** 定位行（来自校验面板 / 函数树的 `editor.revealLocation`） */
  revealLine?: number;
  /** 定位序号：同一文件重复定位时变化以触发重新滚动 */
  revealNonce?: number;
  /** 脏状态上抛（P3：按路径逐个上报，宿主维护 dirtyPaths 集合） */
  onDirtyChange?: (path: string, dirty: boolean) => void;
  /** 注册编辑器动作句柄（宿主"保存并关闭 / 全部保存"流程用；卸载时以 null 注销） */
  registerActions?: (actions: EditorPaneActions | null) => void;
  /** 重授权入口（通知 action「去授权」落地处） */
  onReauth: () => void;
  /** 编辑器状态上抛（状态栏右区显示编码/EOL/行数；卸载或无文件时 null） */
  onStatusInfo?: (info: { encoding: string; eol: string; lines: number } | null) => void;
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
  filePath,
  openPaths,
  revealLine,
  revealNonce,
  onDirtyChange,
  registerActions,
  onReauth,
  onStatusInfo,
}: Props): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  /** 全部打开文件的 model（随标签存续；切换不销毁，关闭才 dispose） */
  const entriesRef = useRef(new Map<string, ModelEntry>());
  /** 各文件"已保存基线"版本号（BUG-4：脏判定 O(1)，替代全量字符串比较） */
  const baseVersionRef = useRef(new Map<string, number>());
  /** 各标签的视图状态（光标/滚动；切换时保存/恢复） */
  const viewStatesRef = useRef(new Map<string, Monaco.editor.ICodeEditorViewState | null>());
  /** 上一个活动路径（切换时先把它的视图状态存下） */
  const prevPathRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const revealRef = useRef<{ line: number; nonce: number } | null>(null);
  /** 当前文件路径（供只注册一次的 Monaco 回调读取最新值，避免闭包过时） */
  const filePathRef = useRef<string>(filePath);
  const openPathsRef = useRef<readonly string[]>(openPaths);
  /** 重授权入口 ref（同上：Monaco 回调与保存句柄只注册一次，须读最新值） */
  const onReauthRef = useRef<() => void>(onReauth);
  /**
   * 工作区根（创作权威区，恒可写）——ERB 只读规则的分野依据：
   * 游戏目录内 ERB = 只读借阅；**全部工作区根**（默认根 + 作者自选的项目位置）内的 ERB
   * = 可编辑源文件（工作区批新增，自选位置批扩成多根）。
   *
   * 每次判定现取，不缓存：`roots()` 是同步读内存数组、零 IO，缓存没有收益，
   * 反而会把"本会话刚自选的那个新根"永远排除在外（一次取值定死 ⇒ 之后一路判成借阅件锁只读）。
   */
  const inWorkspace = (p: string): boolean => isUnderAnyRoot(workspaceRootsOf(kernel), p);
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
  /** 糖视图开关（偏好持久化；默认开——见 `sugar-view.ts` 头注） */
  const [sugarView, setSugarView] = useState<boolean>(() => loadSugarViewPref());
  /**
   * 封存总闸（`sealed.ts`；默认封存）。封存态下糖视图现效果整件不可用，
   * 但**不碰偏好**——`sugarView` 维持用户原值，解封即按原偏好恢复。
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
  /** 正在以磁盘内容重载 model（抑制由此触发的脏上报：重载不是用户编辑） */
  const reloadingRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** 待用户决策的保存告警（非 null = 弹确认框；宿主全角空格"一键修复"的入口） */
  const [pendingChoice, setPendingChoice] = useState<EditorSaveWarning | null>(null);

  /** O(1) 脏判定：model 当前版本号 ≠ 已保存基线版本号（BUG-4） */
  const computeDirty = useCallback((path: string): boolean => {
    const entry = entriesRef.current.get(path);
    const base = baseVersionRef.current.get(path);
    if (!entry || base === undefined) return false;
    return entry.model.getAlternativeVersionId() !== base;
  }, []);

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

  const applyReveal = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    // 糖视图激活时编辑器显示的是糖 model，其行号与原文不对应；定位请求（校验面板 / 函数树）
    // 给的是**原文行号**，此刻无法直接映射——宁可不动，也绝不做半吊子映射把用户滚到错位置。
    if (sugarModelRef.current) return;
    const model = ed.getModel();
    const target = revealRef.current;
    if (!model || !target) return;
    const line = Math.min(Math.max(1, target.line), model.getLineCount());
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.focus();
  }, []);

  /**
   * 重算并应用编辑器波浪线：把全部 `ui.editor.decorator` 贡献（纯函数）的结果
   * 合并为 Monaco markers。装饰器**抛错不打断编辑**（能力出错要"退化可见"而非
   * 让编辑器崩）——出错即跳过该贡献，其余照常呈现。
   */
  const refreshMarkers = useCallback(
    (model: Monaco.editor.ITextModel, path: string) => {
      // 探针（内核优化 L0）：`markers.total` = 一次装饰刷新的主线程总耗时；
      // 逐装饰器再记一条，用于区分"是 sugar 转译贵"还是"别的装饰器贵"。
      const t0 = performance.now();
      const project = kernel.project.current();
      const text = model.getValue();
      const decorations: LineDecoration[] = [];
      for (const contribution of kernel.slots.query('ui.editor.decorator')) {
        const d0 = performance.now();
        try {
          decorations.push(...contribution.decorate({ path, text, project }));
        } catch {
          // 单个装饰器失败不影响其余（错误写入由该插件自行上报，宿主不静默吞掉整轮）
        }
        perf.record(`markers.decorate:${contribution.id}`, performance.now() - d0);
      }
      monaco.editor.setModelMarkers(model, MARKER_OWNER, decorationsToMarkers(monaco, model, decorations));
      // 同一份 decorations 发布到问题面板：两层波浪线（结构 error / 表达式 warning）在此汇总成可展开列表
      setProblems(
        path,
        decorations.map((d) => ({
          path,
          line: d.line,
          severity: d.severity,
          message: d.message,
          ...(d.code ? { code: d.code } : {}),
        })),
      );
      perf.record('markers.total', performance.now() - t0, `${model.getLineCount()} 行 / ${text.length} 字符`);
    },
    [kernel],
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
          // 按当前文件重算 readOnly（解锁 / 直连 / 工作区口径与切换标签 effect 一致）
          const path = filePathRef.current;
          const canEdit = unlockedPathsRef.current.has(path) || directEditable(path);
          ed.updateOptions({ readOnly: erbReadOnlyGate(path, { inWorkspace: inWorkspace(path), canEdit }) });
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
    setSugarStats(null);
  }, [kernel]);

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
    // 可用门（ADR-0005）：只对**游戏目录里、本次未解锁**的 ERB 生效。
    // `.kojo` 与**工作区内 ERB**（作者自己的创作源文件，恒可编辑）都不放糖视图——
    // 糖视图靠"整份文件换成只读 model"工作，可编辑的原文必须始终看得见。
    // 封存总闸（sealed.ts）优先于一切：封存态直接不放（用户 2026-10-13 反馈批）。
    if (
      !sugarViewRef.current ||
      !sugarViewAllowed({
        sealed: isSealed(),
        isErbLike: isErbLike(path),
        inWorkspace: inWorkspace(path),
        // 直连可编辑 ⟹ 糖视图让位（与 unlocks 同口径，ADR-0005 互斥）
        unlocked: unlockedPathsRef.current.has(path) || directEditable(path),
      })
    )
      return;

    const model = entry.model;
    const text = model.getValue();
    const project = kernel.project.current();
    const maxLine = model.getLineCount();

    // 段清点：单个贡献抛错不影响其余（与装饰器 / codeAction 同款隔离）
    const segments: Array<{ fromLine: number; toLine: number; sugarText: string }> = [];
    for (const contribution of kernel.slots.query('ui.editor.liftPreview')) {
      const provide = contribution.provideLiftProject;
      if (typeof provide !== 'function') continue;
      try {
        for (const item of provide.call(contribution, { path, text, project })) {
          const { fromLine, toLine } = clampRange(item.fromLine, item.toLine, maxLine);
          // 段首尾的空行不进糖文本（否则糖块开头是一大块空白，见 `trimSegmentBlanks`）
          segments.push({ fromLine, toLine, sugarText: trimSegmentBlanks(item.sugarText) });
        }
      } catch (e: unknown) {
        // 能力出错要"退化可见"：记录后继续，糖视图少一段好过整份消失
        console.warn(
          `[EditorPane] liftPreview '${contribution.id}' provideLiftProject 抛错：${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    if (segments.length === 0) return; // 无段可铺：保持原文（clear 已在函数开头做过）

    // 取原文逐行内容，拼装整份糖文本（纯函数，口径单测钉死在 sugar-view.test.ts）
    const originalLines: string[] = [];
    for (let i = 1; i <= maxLine; i++) originalLines.push(model.getLineContent(i));
    const doc = composeSugarDoc(originalLines, segments);

    let sugarLines = 0;
    for (const seg of segments) sugarLines += seg.sugarText.split('\n').length;

    // 只读内存 model：`inmemory://` scheme（**非** `file:`，避免与真文件 model 冲突被复用）。
    // 换文件 / 关开关时由 clearSugarView dispose。
    const sugarModel = monaco.editor.createModel(
      doc,
      KOJO_LANGUAGE_ID,
      monaco.Uri.parse(`inmemory://sugar/${encodeURIComponent(path)}`),
    );
    sugarModelRef.current = sugarModel;
    sugarOriginalModelRef.current = model;
    ed.updateOptions({ readOnly: true }); // 糖是派生物，禁止在糖视图上编辑
    ed.setModel(sugarModel);
    setSugarStats(sugarSummary(sugarLines, 0));
  }, [kernel, clearSugarView]);

  // 开关变化：记住偏好（下次启动仍是你的选择）+ 就地重算视图
  useEffect(() => {
    sugarViewRef.current = sugarView;
    saveSugarViewPref(sugarView);
    applySugarView();
  }, [sugarView, applySugarView]);

  // 封存总闸切换：封存 → 现场撤下糖视图；解封 → 按用户偏好重新铺上
  useEffect(() => {
    return subscribeSealed(() => {
      setIntroAsk(false);
      applySugarView();
    });
  }, [applySugarView]);

  // 直连模式开关切换：重算当前文件的可编辑态（readOnly），并让糖视图让位/恢复
  useEffect(() => {
    const ed = editorRef.current;
    const p = filePathRef.current;
    if (!ed || !p) return;
    const canEdit = unlockedPathsRef.current.has(p) || directEditable(p);
    ed.updateOptions({ readOnly: erbReadOnlyGate(p, { inWorkspace: inWorkspace(p), canEdit }) });
    applySugarView();
  }, [directMode, kernel, applySugarView]);

  // 糖视图开关意图 → 宿主落地（插件发意图、宿主渲染；与 editor.liftPreview.show 同款）
  useEffect(() => {
    return kernel.bus.on('editor.sugarView.set', (p) => {
      // 封存态不接受开关意图——不偷偷改用户偏好（解封后按原偏好恢复，见 sealed.ts）
      if (isSealed()) return;
      if (p.filePath && p.filePath !== filePathRef.current) return;
      // 省略 `on` = 反转：状态所有者是宿主，请求方不必先问"现在是开还是关"
      setSugarView((v) => p.on ?? !v);
    });
  }, [kernel]);

  // 记录最新定位请求（同一文件重复定位靠 nonce 变化触发）
  useEffect(() => {
    revealRef.current = revealLine ? { line: revealLine, nonce: revealNonce ?? 0 } : null;
    applyReveal();
  }, [revealLine, revealNonce, filePath, applyReveal]);

  /** 保存成功：把该文件 model 的当前版本号立为新基线 */
  const markSaved = useCallback(
    (path: string, entry: ModelEntry) => {
      baseVersionRef.current.set(path, entry.model.getAlternativeVersionId());
      onDirtyChangeRef.current?.(path, false);
      if (filePathRef.current === path) setDirty(false);
    },
    [],
  );

  /**
   * 保存指定文件（活动标签与后台标签同一条路径）：
   * - 先就近征询**保存接管者**（槽 `ui.editor.saveHandler`）：命中（如 `.kojo`）
   *   则由接管者完成"保存源 + 编译产物"，宿主只消费其 `outcome`；
   * - 未命中 → 缺省路径：内核 io `writeText`（保编码保换行，受写白名单约束）；
   * - `needs-choice`（全角空格告警）→ 活动标签弹确认框、**本次不落盘**；后台
   *   标签（全部保存途中）跳过并显式通知（不静默吞）。
   */
  const savePath = useCallback(
    async (path: string, choices?: EditorSaveChoices): Promise<boolean> => {
      const entry = entriesRef.current.get(path);
      if (!entry || savingRef.current) return false;
      const isActive = filePathRef.current === path;
      // P0 前置拦截：按文件实际可写性判定（工作区恒可写，不被项目授权状态误伤——
      // 双真相源：工作区 = 创作权威，游戏目录 = 部署目标）
      if (!kernel.io.isWritable(path)) {
        notify({
          kind: 'error',
          message: '保存被拒绝：项目当前为只读（写权限未批准或批准已失效）。',
          action: { label: '去授权', run: () => onReauthRef.current() },
        });
        if (isActive) setError('只读：写权限未批准');
        // 用户已表达明确的写入意图 → 软件主动重弹授权对话框（实机反馈：让用户自己去
        // 发现并点击「重新授权」按钮 = 把软件的责任抛给用户，是设计错误）
        onReauthRef.current();
        return false;
      }
      const text = entry.model.getValue();
      savingRef.current = true;
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
            } else {
              notify({
                kind: 'info',
                message: `「${path}」存在保存告警，全部保存时已跳过——切到该标签单独保存可处理。`,
              });
            }
            return false;
          }
          if (outcome.status === 'error') {
            if (isActive) setError(outcome.message);
            else notify({ kind: 'error', message: `保存「${path}」失败：${outcome.message}` });
            return false;
          }
          markSaved(path, entry);
          if (isActive) {
            setError(null);
            setStatus(outcome.note ? `${outcome.message} · ${outcome.note}` : outcome.message);
          }
          return true;
        }
        // 缺省保存（无接管者 / 提供者未激活 → 优雅降级）
        await kernel.io.writeText(path, text);
        markSaved(path, entry);
        if (isActive) {
          setError(null);
          setStatus(`已保存 ${new Date().toLocaleTimeString()}`);
        }
        return true;
      } catch (e: unknown) {
        // 竞态兜底（批准在保存途中被收回等）：WriteNotAllowedError → 中文人话 + 去授权
        if (e instanceof WriteNotAllowedError) {
          notify({
            kind: 'error',
            message: '保存被拒绝：写入路径不在已批准范围内。',
            action: { label: '去授权', run: () => onReauthRef.current() },
          });
          if (isActive) setError('只读：写权限未批准');
          // 与前置拦截同款：写被拒后自动重弹授权框，而不是让用户去找按钮
          onReauthRef.current();
          return false;
        }
        const msg = e instanceof Error ? e.message : String(e);
        if (isActive) setError(msg);
        else notify({ kind: 'error', message: `保存「${path}」失败：${msg}` });
        return false;
      } finally {
        savingRef.current = false;
      }
    },
    [kernel, markSaved, notify],
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

  /** 全部保存：逐一走保存接管链；任一失败整体返回 false（成功的不回滚） */
  const saveAll = useCallback(async (): Promise<boolean> => {
    const targets = openPathsRef.current.filter((p) => computeDirty(p));
    let ok = true;
    for (const p of targets) {
      // 串行而非并行：保存接管者可能写多个产物文件，串行让状态/通知次序可预期
      const r = await savePath(p);
      if (!r) ok = false;
    }
    return ok;
  }, [computeDirty, savePath]);

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
  const reloadFromDisk = useCallback(
    async (path: string): Promise<void> => {
      const entry = entriesRef.current.get(path);
      if (!entry) return; // 该文件未打开 → 与编辑器无关
      let text: string;
      try {
        ({ text } = await kernel.io.readText(path));
      } catch (e: unknown) {
        notify({
          kind: 'error',
          message: `重新加载「${path}」失败：${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }
      // 读盘期间 model 可能已被关闭/替换（标签关闭竞态）→ 放弃
      if (entriesRef.current.get(path) !== entry) return;
      const decision = decideExternalChange(entry.model.getValue(), text, computeDirty(path));
      if (decision === 'noop') return;
      const applyReload = (): void => {
        const ed = editorRef.current;
        const isActive = filePathRef.current === path;
        const vs = isActive && ed ? ed.saveViewState() : null;
        reloadingRef.current = true;
        try {
          entry.model.setValue(text);
        } finally {
          reloadingRef.current = false;
        }
        const version = entry.model.getAlternativeVersionId();
        baseVersionRef.current.set(path, version);
        onDirtyChangeRef.current?.(path, false);
        if (isActive && ed && vs) ed.restoreViewState(vs);
        if (refreshMarkersRef.current) refreshMarkersRef.current(entry.model, path);
        if (isActive) {
          setDirty(false);
          setStatus('已从磁盘重新加载（文件在外部被修改）');
          onStatusInfoRef.current?.({
            encoding: entry.encoding,
            eol: entry.eol,
            lines: entry.model.getLineCount(),
          });
        }
      };
      if (decision === 'reload') {
        applyReload();
        return;
      }
      notify({
        kind: 'error',
        message: `「${path}」已在磁盘上被修改，但你有未保存的修改——保存会覆盖磁盘内容。`,
        action: { label: '重新加载（放弃我的修改）', run: applyReload },
      });
    },
    [kernel, notify, computeDirty],
  );

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
    registerActions?.({ save: () => save(), savePath: (p) => savePath(p), saveAll });
    return () => registerActions?.(null);
  }, [save, savePath, saveAll, registerActions]);

  // 卸载时清空状态栏编辑器信息
  useEffect(() => () => onStatusInfo?.(null), [onStatusInfo]);

  // Ctrl+S 回调经 ref 读最新 save（编辑器只创建一次，save 闭包随 kernel 更新）
  const saveRef = useRef(save);
  saveRef.current = save;

  // 编辑器实例（仅一次）；卸载时 dispose 全部 model
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ed = monaco.editor.create(host, {
      theme: 'kojo-dark',
      language: ERB_LANGUAGE_ID,
      automaticLayout: true,
      // 缩略图：文本块模式（不逐字符渲染——口上文本为长行文，色块更干净也更省性能）
      minimap: { enabled: true, renderCharacters: false, maxColumn: 72 },
      fontSize: 14,
      lineNumbers: 'on',
      renderWhitespace: 'none',
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      // 编辑器体感（ui-polish）：平滑滚动 / 平滑光标 / 整行高亮 / 上下留白
      smoothScrolling: true,
      cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'all',
      padding: { top: 6, bottom: 16 },
      scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12 },
    });
    editorRef.current = ed;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveRef.current();
    });
    // 💡 CodeAction 宿主适配（槽 `ui.editor.codeAction`，P3b）：宿主只做 Monaco 协议
    // 转换（registerCodeActionProvider），动作产出全在插件（纯函数 provideActions）；
    // 执行经 registerCommand 落地，command 参数用 id 反查 pendingActionsRef（参数须可
    // 序列化，且避免闭包捕获过时文本）。
    const cmdDisposer = monaco.editor.registerCommand(CODE_ACTION_COMMAND, (_accessor, actionId: string) => {
      const action = pendingActionsRef.current.get(actionId);
      if (!action) return;
      const ed = editorRef.current;
      // 有 `edits` 的动作 = **改文本本身**（可撤销）：宿主直接落地，不再走 `run`
      //（两者语义不同，见 `EditorTextEdit` 契约；💡「改为语法糖写法」走这条）。
      // 糖视图下 `ed.getModel()` 是只读糖 model：编辑无处可落（applyTextEdits 会改到派生物
      // 而非原文），直接跳过，避免"改了却不在真文件里"。
      if (action.edits && action.edits.length > 0 && ed && !sugarModelRef.current && ed.getModel()) {
        if (applyTextEdits(ed, action.edits)) return;
      }
      const line = ed?.getPosition()?.lineNumber;
      void action.run({
        project: kernel.project.current(),
        activeFile: filePathRef.current,
        ...(line !== undefined ? { line } : {}),
      });
    });
    const providerDisposer = monaco.languages.registerCodeActionProvider(
      [ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID],
      {
        provideCodeActions: (model, range) => {
          const path = filePathRef.current;
          // 只对当前活动标签的 model 供动作（后台 model 的 provider 调用不响应）；
          // 糖视图下挂的是只读糖 model，不供任何 CodeAction（编辑落点无真文件可依）。
          if (!path || sugarModelRef.current || model !== editorRef.current?.getModel()) {
            return { actions: [], dispose: () => undefined };
          }
          const project = kernel.project.current();
          const text = model.getValue();
          const line = range?.startLineNumber;
          const pending = pendingActionsRef.current;
          // 超阈值整体清理（长期运行不至于无限增长）；id 单调递增，绝不复用
          if (pending.size > 500) pending.clear();
          const actions: Monaco.languages.CodeAction[] = [];
          for (const contribution of kernel.slots.query('ui.editor.codeAction')) {
            let provided: EditorCodeAction[];
            try {
              provided = contribution.provideActions({
                path,
                text,
                project,
                // 体量事实：供贡献方对超长文件降级（见 plugin-api slots.ts 头注）
                lineCount: model.getLineCount(),
                ...(line !== undefined ? { line } : {}),
              });
            } catch (e: unknown) {
              // 单个贡献抛错不影响其余（与装饰器同款隔离：能力出错退化可见，不让 💡 整体消失）
              console.warn(
                `[EditorPane] codeAction '${contribution.id}' provideActions 抛错：${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
              continue;
            }
            for (const a of provided) {
              const actionId = `${contribution.id}#${++actionSeqRef.current}`;
              pending.set(actionId, a);
              actions.push({
                title: a.title,
                kind: a.kind === 'refactor' ? 'refactor' : 'quickfix',
                command: { id: CODE_ACTION_COMMAND, title: a.title, arguments: [actionId] },
              });
            }
          }
          return { actions, dispose: () => undefined };
        },
      },
    );
    return () => {
      cmdDisposer.dispose();
      providerDisposer.dispose();
      clearSugarView();
      // 兜底：糖 model 若因"无处可还原"被保留挂载，随卸载一并回收（编辑器即将 dispose）
      sugarModelRef.current?.dispose();
      sugarModelRef.current = null;
      sugarOriginalModelRef.current = null;
      if (markerTimerRef.current !== null) window.clearTimeout(markerTimerRef.current);
      markerTimerRef.current = null;
      clearAllProblems(); // 编辑器整体卸载：清掉全部文件的问题，防幽灵诊断残留
      ed.dispose();
      editorRef.current = null;
      for (const entry of entriesRef.current.values()) {
        entry.listener.dispose();
        entry.model.dispose();
      }
      entriesRef.current.clear();
      baseVersionRef.current.clear();
      viewStatesRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 标签关闭 → model 回收（不在 openPaths 中的一律 dispose；绝不泄漏）
  useEffect(() => {
    const keep = new Set(openPaths);
    for (const [path, entry] of [...entriesRef.current]) {
      if (keep.has(path)) continue;
      entry.listener.dispose();
      entry.model.dispose();
      clearProblems(path); // 标签关闭：同步清掉该文件在问题面板里的条目
      entriesRef.current.delete(path);
      baseVersionRef.current.delete(path);
      viewStatesRef.current.delete(path);
      onDirtyChangeRef.current?.(path, false);
    }
  }, [openPaths]);

  // 切换活动标签（model 复用；首次打开读盘建 model）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ed = editorRef.current;
      if (!ed) return;
      // 先把上一个标签的视图状态存下（光标/滚动原位恢复）
      const prev = prevPathRef.current;
      if (prev && prev !== filePath && entriesRef.current.has(prev)) {
        viewStatesRef.current.set(prev, ed.saveViewState());
      }
      let entry = entriesRef.current.get(filePath);
      if (!entry) {
        // 探针：切文件一次性成本 = 读盘 + 建 model（+ 下方 apply 段）
        const stopRead = perf.start('switch.readText');
        try {
          const tf = await kernel.io.readText(filePath);
          stopRead();
          if (cancelled) return;
          const tModel = performance.now();
          const model = monaco.editor.createModel(tf.text, languageFor(filePath), monaco.Uri.file(filePath));
          perf.record('switch.createModel', performance.now() - tModel, `${tf.text.length} 字符`);
          // 逐 model 脏监听（BUG-4：版本号 O(1) 比较；后台标签的编辑同样上报）
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
              }
            } finally {
              perf.record('input.handler', performance.now() - t0);
            }
          });
          entry = { model, listener, encoding: tf.encoding, eol: tf.eol.toUpperCase() };
          entriesRef.current.set(filePath, entry);
          baseVersionRef.current.set(filePath, model.getAlternativeVersionId());
        } catch (e: unknown) {
          stopRead(); // 幂等：读盘失败时补记一次采样（正常路径已记过则跳过）
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
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
      ed.updateOptions({
        readOnly: erbReadOnlyGate(filePath, { inWorkspace: inWorkspace(filePath), canEdit: allowEdit }),
        ...editorOptionsForLineCount(entry.model.getLineCount()),
      });
      ed.setModel(entry.model);
      const vs = viewStatesRef.current.get(filePath);
      if (vs) ed.restoreViewState(vs);
      setDirty(computeDirty(filePath));
      setError(null);
      setPendingChoice(null); // 换文件即作废未决的保存告警（避免误对旧文件应用修复）
      setStatus(`${entry.encoding} · ${entry.eol} · ${entry.model.getLineCount()} 行`);
      onStatusInfo?.({
        encoding: entry.encoding,
        eol: entry.eol,
        lines: entry.model.getLineCount(),
      });
      // 打开/切换即算一次装饰（不等用户编辑）——首屏就能看到波浪线
      if (markerTimerRef.current !== null) window.clearTimeout(markerTimerRef.current);
      markerTimerRef.current = null;
      refreshMarkers(entry.model, filePath);
      applySugarView(); // 糖视图：整份 ERB 显示为糖（默认开；`.kojo` 自动跳过）
      applyReveal();
      stopApply();
    })();
    return () => {
      cancelled = true;
    };
  }, [kernel, filePath, applyReveal, refreshMarkers, onStatusInfo, computeDirty, scheduleMarkers, clearSugarView, applySugarView]);

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
      ed.updateOptions({ readOnly: erbReadOnlyGate(path, { inWorkspace: inWorkspace(path), canEdit }) });
      // 解锁 → 糖视图必须让位（原文要看得见）；回锁 → 重新生成糖视图
      applySugarView();
    },
    [applySugarView],
  );

  // 首次打开 ERB：问一次"要不要用语法糖视图"（问过就再不问）。
  // **工作区 ERB 不弹**（恒可编辑，糖视图本就不生效，问了没有意义——ADR-0005 轴一）；
  // 已解锁编辑的文件同样不弹（轴二的破例态下糖视图也让位）；
  // 封存总闸封存时不弹（三件封存功能默认隐藏，问了也没有入口可用）。
  useEffect(() => {
    if (
      !sugarViewAllowed({
        sealed: isSealed(),
        isErbLike: isErbLike(filePath),
        inWorkspace: filePath !== null && inWorkspace(filePath),
        unlocked: filePath !== null && (unlockedPathsRef.current.has(filePath) || directEditable(filePath)),
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
        {isErbLike(filePath) && !inWorkspace(filePath) ? (
          <>
            {/* 两道正交轴的呈现（ADR-0005）：能走到这里说明这是**游戏目录里的 ERB**
                （工作区 ERB 恒可编辑，不放只读徽章、也不开糖视图）。
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
                 直连可编辑 ⟹ 糖视图让位（与 unlocks 同口径，ADR-0005 互斥）→ 不渲染糖视图 toggle。 */
              <span
                className="erb-mode-hint direct"
                title="直连模式已开启：这份文件在已获写权限的目录内，可直接编辑（就地修改游戏目录）。写权限仍只来自你批准的可写目录。"
              >
                直连可编辑
              </span>
            ) : (
              <>
                <span
                  className="sb-writable ro"
                  title="游戏目录里的原生文件，默认只读——直接改它等于改别人装好的游戏内容。开始输入时编辑器会询问你是否破例；写权限授权入口在底部状态栏。"
                >
                  只读
                </span>
                {/* 糖视图：整份 ERB 显示为语法糖（只读）——本功能的存在理由就是让不熟悉
                    原生语法的人也能把别人的口上当剧本读懂。默认开（偏好可记忆）。
                    标签**恒为「语法糖视图」**，开关状态交给 .on 配色 + aria-pressed 表达：
                    原先按状态在「语法糖视图 / 显示为语法糖」间换字，两者字数不同，
                    每点一次工具条就横向抖一下（与 T3 根除的树抖动同类缺陷）。
                    封存总闸（sealed.ts）封存时整只不渲染——入口齐撤，设置页勾选可临时恢复。 */}
                {!sealed ? (
                  <button
                    className={`ghost small sugar-toggle${sugarView ? ' on' : ''}`}
                    aria-pressed={sugarView}
                    onClick={() => setSugarView((v) => !v)}
                    title={
                      sugarView
                        ? '已开启：当前显示的是 .kojo 写法。点击切回原生代码（这是显示偏好，文件内容一字未动）。'
                        : '把这份文件显示成 .kojo 写法——台词读起来像剧本、条件变成「如果 …：」。只改显示，不改动文件。'
                    }
                  >
                    .kojo 预览
                  </button>
                ) : null}
                {sugarView && sugarStats ? (
                  <span
                    className="sugar-stats dim"
                    title="其余行按原样显示：.kojo 还没覆盖到的控制流（SIF / 循环 / TRY）、赋值与调用，以及注释和空行。文件内容始终没有被改动。"
                  >
                    {sugarStats}
                  </span>
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
        <button
          className="primary small"
          onClick={() => void save()}
          disabled={!dirty || (filePath !== null && !kernel.io.isWritable(filePath))}
          title={
            filePath !== null && !kernel.io.isWritable(filePath)
              ? '只读：写权限未批准（点击底部状态栏「只读」徽章授权）'
              : undefined
          }
        >
          保存 (Ctrl+S)
        </button>
      </div>
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
