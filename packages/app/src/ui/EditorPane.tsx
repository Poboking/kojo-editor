import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type * as Monaco from 'monaco-editor';
import type { Kernel } from '@kojo/kernel';
import type {
  EditorCodeAction,
  EditorSaveChoices,
  EditorSaveHandlerContribution,
  EditorSaveWarning,
  LineDecoration,
} from '@kojo/plugin-api';
import { FULLWIDTH_SPACE, WriteNotAllowedError, isPathUnder } from '@kojo/plugin-api';
// monaco-editor 0.57 的 exports 映射：'monaco-editor/*' → './esm/vs/*.js'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import * as monaco from 'monaco-editor';
import { ERB_LANGUAGE_ID, registerErbLanguage } from '../monaco/erb-language';
import { KOJO_LANGUAGE_ID, decorationsToMarkers, registerKojoLanguage } from '../monaco/kojo-language';
import { useNotify } from './NotificationCenter';
import { SaveWarningDialog } from './SaveWarningDialog';
import { editorOptionsForLineCount } from './editor-options';
import { decideExternalChange } from './external-change';
import { clampRange, isErbLike, liftZonePlan } from './lift-preview';
import { perf } from '../perf';

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
/** 升糖预览 ViewZone 的 DOM 类名（样式在 app 样式表里） */
const LIFT_ZONE_CLASS = 'lift-preview-zone';
/** 打字机节奏：每 tick 追加的字符数 / tick 间隔（毫秒） */
const TYPEWRITER_STEP = 2;
const TYPEWRITER_INTERVAL_MS = 8;

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
   * 工作区根（创作权威区，恒可写；服务不可用时 null）——ERB 只读规则的分野依据：
   * 游戏目录内 ERB = 只读借阅；工作区内 ERB = 可编辑源文件（工作区批新增）。
   */
  const workspaceRootRef = useRef<string | null | undefined>(undefined);
  const workspaceRoot = (): string | null => {
    if (workspaceRootRef.current === undefined) {
      try {
        workspaceRootRef.current = kernel.workspaces.rootDir();
      } catch {
        workspaceRootRef.current = null;
      }
    }
    return workspaceRootRef.current;
  };
  /** 是否工作区内文件（创作区；ERB 可编辑、恒可保存） */
  const inWorkspace = (p: string): boolean => {
    const root = workspaceRoot();
    return root !== null && isPathUnder(root, p);
  };
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
  /** 升糖预览已插入的 ViewZone id（收起 / 换文件时统一移除） */
  const liftZonesRef = useRef<string[]>([]);
  /** 升糖预览的打字机定时器（收起时清掉，避免写入已移除的 DOM） */
  const liftTimersRef = useRef<number[]>([]);
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

  const applyReveal = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
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
      const ed = editorRef.current;
      const model = ed?.getModel();
      const path = filePathRef.current;
      if (model && path && refreshMarkersRef.current) refreshMarkersRef.current(model, path);
    }, MARKER_DEBOUNCE_MS);
  }, []);

  /* --------------------------- 升糖预览（前端透镜） --------------------------- */

  /**
   * 清空全部升糖预览（移除 ViewZone + 停掉打字机定时器）。
   * 换文件 / 收起 / 卸载都走它，保证"预览不跨文件残留"。
   */
  const clearLiftPreviews = useCallback(() => {
    for (const t of liftTimersRef.current) window.clearTimeout(t);
    liftTimersRef.current = [];
    const ids = liftZonesRef.current;
    liftZonesRef.current = [];
    const ed = editorRef.current;
    if (ed && ids.length > 0) {
      ed.changeViewZones((acc) => {
        for (const id of ids) acc.removeZone(id);
      });
    }
  }, []);

  /**
   * 就地显示升糖预览（`editor.liftPreview.show` 的落地）：在原文区间**上方**插入
   * ViewZone（打字机填糖写法），并把原文区间折叠起来——折叠时只见糖、展开时糖
   * 在上原文在下。**全程不写盘**（这是升糖定位修正的核心：只用于看）。
   */
  const showLiftPreview = useCallback(
    (payload: { filePath: string; fromLine: number; toLine: number; sugarText: string }) => {
      const ed = editorRef.current;
      const model = ed?.getModel();
      if (!ed || !model) return;
      // 只对当前活动文件生效
      if (payload.filePath !== filePathRef.current) return;
      const { fromLine, toLine } = clampRange(payload.fromLine, payload.toLine, model.getLineCount());
      const plan = liftZonePlan({ fromLine, sugarText: payload.sugarText });
      clearLiftPreviews(); // 重复触发 = 刷新，不叠加
      ed.changeViewZones((acc) => {
        const dom = document.createElement('div');
        dom.className = LIFT_ZONE_CLASS;
        const head = document.createElement('div');
        head.className = 'lift-preview-head';
        const label = document.createElement('span');
        label.textContent = '💡 语法糖预览（只读 · 不改动原 ERB 文件）';
        const close = document.createElement('button');
        close.className = 'lift-preview-close';
        close.textContent = '收起';
        close.onclick = () => clearLiftPreviews();
        head.appendChild(label);
        head.appendChild(close);
        const pre = document.createElement('pre');
        pre.className = 'lift-preview-sugar';
        dom.appendChild(head);
        dom.appendChild(pre);
        const id = acc.addZone({
          afterLineNumber: plan.afterLineNumber,
          heightInLines: plan.heightInLines,
          domNode: dom,
          suppressMouseDown: false,
        });
        liftZonesRef.current.push(id);
        // 高度先按最终行数定格（避免打字过程反复重排），再逐字填充
        const text = payload.sugarText;
        let i = 0;
        const tick = (): void => {
          i = Math.min(text.length, i + TYPEWRITER_STEP);
          pre.textContent = text.slice(0, i);
          if (i < text.length) {
            liftTimersRef.current.push(window.setTimeout(tick, TYPEWRITER_INTERVAL_MS));
          }
        };
        tick();
      });
      // 折叠原文区间（单行候选无可折叠内容）；折叠后展开即可"糖 + 原文同现"
      if (toLine > fromLine) {
        ed.trigger('kojo-lift', 'editor.fold', { selectionLines: [toLine] });
      }
      ed.revealLineInCenterIfOutsideViewport(fromLine);
    },
    [clearLiftPreviews],
  );

  // 升糖预览意图 → 宿主落地（插件发意图、宿主渲染；与 editor.revealLocation 同款）
  useEffect(() => {
    const unShow = kernel.bus.on('editor.liftPreview.show', (p) => showLiftPreview(p));
    const unHide = kernel.bus.on('editor.liftPreview.hide', (p) => {
      if (!p.filePath || p.filePath === filePathRef.current) clearLiftPreviews();
    });
    return () => {
      unShow();
      unHide();
    };
  }, [kernel, showLiftPreview, clearLiftPreviews]);

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
  useEffect(() => {
    const un = kernel.bus.on('file.changed', (ev) => {
      if (ev.kind !== 'change') return; // add/unlink 不影响已打开 model 的内容
      void reloadFromDisk(ev.path);
    });
    return un;
  }, [kernel, reloadFromDisk]);

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
      const model = ed?.getModel();
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
      const line = editorRef.current?.getPosition()?.lineNumber;
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
          // 只对当前活动标签的 model 供动作（后台 model 的 provider 调用不响应）
          if (!path || model !== editorRef.current?.getModel()) {
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
    // 升糖折叠范围供给（`ui.editor.liftPreview` 槽）：把可预览区间交给 Monaco 折叠加号，
    // 让"折叠原文"用编辑器原生折叠交互（参考 if 折叠）。纯前端、零写盘。
    const liftFoldDisposer = monaco.languages.registerFoldingRangeProvider(
      [ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID],
      {
        provideFoldingRanges: (model) => {
          const path = filePathRef.current;
          if (!path || model !== editorRef.current?.getModel()) return [];
          const project = kernel.project.current();
          const text = model.getValue();
          const out: Monaco.languages.FoldingRange[] = [];
          for (const contribution of kernel.slots.query('ui.editor.liftPreview')) {
            try {
              for (const item of contribution.provideLiftPreview({
              path,
              text,
              project,
              // 体量事实：本槽被接成 Monaco 折叠范围供给器，Monaco 打开文件时即要整篇范围
              // → 超长文件必须让贡献方有机会降级（见 plugin-api slots.ts 头注）
              lineCount: model.getLineCount(),
            })) {
                if (item.toLine > item.fromLine) out.push({ start: item.fromLine, end: item.toLine });
              }
            } catch {
              // 单个贡献抛错不影响其余（与 codeAction / decorator 同款隔离）
            }
          }
          return out;
        },
      },
    );
    return () => {
      cmdDisposer.dispose();
      providerDisposer.dispose();
      liftFoldDisposer.dispose();
      clearLiftPreviews();
      for (const t of liftTimersRef.current) window.clearTimeout(t);
      liftTimersRef.current = [];
      if (markerTimerRef.current !== null) window.clearTimeout(markerTimerRef.current);
      markerTimerRef.current = null;
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
      clearLiftPreviews(); // 升糖预览不跨文件残留
      // 先按文件体量落 Monaco 选项，再挂 model——避免超长文件先在"默认全文级选项"
      // 下渲染一帧（大文件降级清单见 editor-options.ts）。
      // readOnly 语义（工作区批）：ERB 默认只读**仅限游戏目录**（借阅区不写 ERB）；
      // 工作区内 ERB 是创作源文件，可编辑（双真相源分野）。
      ed.updateOptions({
        readOnly: isErbLike(filePath) && !inWorkspace(filePath),
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
      applyReveal();
      stopApply();
    })();
    return () => {
      cancelled = true;
    };
  }, [kernel, filePath, applyReveal, refreshMarkers, onStatusInfo, computeDirty, scheduleMarkers, clearLiftPreviews]);

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        <span className="file-label" title={filePath}>
          {filePath}
        </span>
        <span className={`dirty-dot ${dirty ? 'on' : ''}`} title={dirty ? '未保存' : '已保存'}>
          {dirty ? '●' : ''}
        </span>
        {isErbLike(filePath) && !inWorkspace(filePath) ? (
          // 纯说明性标签，**不带任何操作入口**——编辑 ERB 的路径由「检测到用户要编辑
          // → 自动分流到 .kojo」承担（需求 §1.3，本批未实现）。旧的「强制编辑 ERB」
          // 按钮按 §1.4 作废：把系统责任抛给用户。
          <span
            className="erb-mode-hint"
            title="ERB 默认只读：升糖只用于预览，不写原文件。要改 ERB 请转 .kojo 文件。"
          >
            🔒 只读预览 · 升糖不写原文件
          </span>
        ) : null}
        <span className="spacer" />
        <span className="editor-status">{error ? `⚠ ${error}` : status}</span>
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
    </div>
  );
}
