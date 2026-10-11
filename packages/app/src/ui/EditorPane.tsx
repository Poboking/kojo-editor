import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type * as Monaco from 'monaco-editor';
import type { Kernel } from '@kojo/kernel';
import type {
  EditorSaveChoices,
  EditorSaveHandlerContribution,
  EditorSaveWarning,
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

// Monaco worker 装配（vite ?worker 后缀）；ERB 无需语言服务 worker，base 编辑器 worker 即可
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};
registerErbLanguage(monaco);
registerKojoLanguage(monaco);

/** marker owner（同一 owner 的 markers 每次整体替换；不同 owner 互不干扰） */
const MARKER_OWNER = 'kojo-decorators';
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
  /** 写权限状态（P0）：只读时保存按钮置灰 + 保存前置拦截（不等到写盘才报错） */
  writable: boolean;
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
  writable,
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
  /** 写权限/重授权入口 ref（同上：Monaco 回调与保存句柄只注册一次，须读最新值） */
  const writableRef = useRef<boolean>(writable);
  const onReauthRef = useRef<() => void>(onReauth);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const notify = useNotify();
  /** 装饰重算定时器（编辑停顿去抖） */
  const markerTimerRef = useRef<number | null>(null);
  /** 装饰刷新函数（ref 化，供只注册一次的 model 监听调用） */
  const refreshMarkersRef = useRef<((model: Monaco.editor.ITextModel, path: string) => void) | null>(null);
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
      const project = kernel.project.current();
      const text = model.getValue();
      const decorations: LineDecoration[] = [];
      for (const contribution of kernel.slots.query('ui.editor.decorator')) {
        try {
          decorations.push(...contribution.decorate({ path, text, project }));
        } catch {
          // 单个装饰器失败不影响其余（错误写入由该插件自行上报，宿主不静默吞掉整轮）
        }
      }
      monaco.editor.setModelMarkers(model, MARKER_OWNER, decorationsToMarkers(monaco, model, decorations));
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

  // 写权限/重授权/脏上报 ref 同步（同上）
  useEffect(() => {
    writableRef.current = writable;
    onReauthRef.current = onReauth;
    onDirtyChangeRef.current = onDirtyChange;
  }, [writable, onReauth, onDirtyChange]);

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
      // P0 前置拦截：只读时不等到写盘才报错——通知 + 去授权 action（定稿 §九-1/3）
      if (!writableRef.current) {
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
      minimap: { enabled: false },
      fontSize: 14,
      lineNumbers: 'on',
      renderWhitespace: 'none',
      scrollBeyondLastLine: false,
      wordWrap: 'on',
    });
    editorRef.current = ed;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveRef.current();
    });
    return () => {
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
        try {
          const tf = await kernel.io.readText(filePath);
          if (cancelled) return;
          const model = monaco.editor.createModel(tf.text, languageFor(filePath), monaco.Uri.file(filePath));
          // 逐 model 脏监听（BUG-4：版本号 O(1) 比较；后台标签的编辑同样上报）
          const listener = model.onDidChangeContent(() => {
            const d = computeDirty(filePath);
            onDirtyChangeRef.current?.(filePath, d);
            if (filePathRef.current === filePath) {
              setDirty(d);
              scheduleMarkers();
            }
          });
          entry = { model, listener, encoding: tf.encoding, eol: tf.eol.toUpperCase() };
          entriesRef.current.set(filePath, entry);
          baseVersionRef.current.set(filePath, model.getAlternativeVersionId());
        } catch (e: unknown) {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
          return;
        }
      }
      prevPathRef.current = filePath;
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
    })();
    return () => {
      cancelled = true;
    };
  }, [kernel, filePath, applyReveal, refreshMarkers, onStatusInfo, computeDirty, scheduleMarkers]);

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        <span className="file-label" title={filePath}>
          {filePath}
        </span>
        <span className={`dirty-dot ${dirty ? 'on' : ''}`} title={dirty ? '未保存' : '已保存'}>
          {dirty ? '●' : ''}
        </span>
        <span className="spacer" />
        <span className="editor-status">{error ? `⚠ ${error}` : status}</span>
        <button
          className="primary small"
          onClick={() => void save()}
          disabled={!dirty || !writable}
          title={writable ? undefined : '只读：写权限未批准（点击底部状态栏「只读」徽章授权）'}
        >
          保存 (Ctrl+S)
        </button>
      </div>
      <div className="editor-body" ref={hostRef} />
      {pendingChoice ? <SaveWarningDialog warning={pendingChoice} onDecide={decideSaveWarning} /> : null}
    </div>
  );
}
