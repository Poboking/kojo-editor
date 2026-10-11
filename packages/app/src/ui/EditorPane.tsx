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
    } catch {
      // 忽略抛错的贡献（该文件退化为缺省保存）
    }
  }
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); // 稳定排序：同 order 保持注册顺序
  return matches[0];
}

interface Props {
  kernel: Kernel;
  filePath: string;
  /** 定位行（来自校验面板 / 函数树的 `editor.revealLocation`） */
  revealLine?: number;
  /** 定位序号：同一文件重复定位时变化以触发重新滚动 */
  revealNonce?: number;
  /** 脏状态上抛（宿主据此在切换文件前弹确认，审阅 M4 修复） */
  onDirtyChange?: (dirty: boolean) => void;
  /** 注册保存句柄（宿主"保存并前往"流程用；卸载/换文件时以 null 注销） */
  registerSave?: (fn: (() => Promise<boolean>) | null) => void;
  /** 写权限状态（P0）：只读时保存按钮置灰 + 保存前置拦截（不等到写盘才报错） */
  writable: boolean;
  /** 重授权入口（通知 action「去授权」落地处） */
  onReauth: () => void;
}

/**
 * Monaco 编辑面板：
 * - 打开 = 内核 io.readText（编码探测 + 归一化）；
 * - 保存（Ctrl+S）= 先征询 `ui.editor.saveHandler` 槽（就近接管，如 `.kojo` →
 *   保存源 + 编译产物），无命中则走内核 io.writeText 缺省路径（保编码 + 自动
 *   备份，受写白名单约束）；保存期告警（全角空格）弹确认框 + 一键修复；
 * - 未保存时显示脏标记；
 * - 支持外部定位（revealLine）：打开即滚动到指定行，供"点击校验问题跳转"消费。
 * - 语言按扩展名选择（`.kojo` = 语法糖表层；其余 = 原生 ERB）；
 * - 波浪线：消费 `ui.editor.decorator` 槽的全部贡献（纯函数）→ Monaco markers，
 *   打开即算、编辑停顿去抖重算（v0.3 S6）。
 */
export function EditorPane({
  kernel,
  filePath,
  revealLine,
  revealNonce,
  onDirtyChange,
  registerSave,
  writable,
  onReauth,
}: Props): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const originalRef = useRef<string>('');
  /** 打开/保存成功时的 model 版本号（BUG-4：脏判定 O(1)，替代每击键全量字符串比较） */
  const originalVersionRef = useRef<number>(0);
  const savingRef = useRef(false);
  const revealRef = useRef<{ line: number; nonce: number } | null>(null);
  /** 当前文件路径（供只注册一次的 Monaco 回调读取最新值，避免闭包过时） */
  const filePathRef = useRef<string>(filePath);
  /** 写权限/重授权入口 ref（同上：Monaco 回调与保存句柄只注册一次，须读最新值） */
  const writableRef = useRef<boolean>(writable);
  const onReauthRef = useRef<() => void>(onReauth);
  const notify = useNotify();
  /** 装饰重算定时器（编辑停顿去抖） */
  const markerTimerRef = useRef<number | null>(null);
  /** 装饰刷新函数（ref 化，供只注册一次的 onDidChangeModelContent 调用） */
  const refreshMarkersRef = useRef<((model: Monaco.editor.ITextModel, path: string) => void) | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** 待用户决策的保存告警（非 null = 弹确认框；宿主全角空格"一键修复"的入口） */
  const [pendingChoice, setPendingChoice] = useState<EditorSaveWarning | null>(null);

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

  // 文件路径 ref 同步（只注册一次的 Monaco 回调读它）
  useEffect(() => {
    filePathRef.current = filePath;
  }, [filePath]);

  // 写权限/重授权 ref 同步（同上）
  useEffect(() => {
    writableRef.current = writable;
    onReauthRef.current = onReauth;
  }, [writable, onReauth]);

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

  /** 保存成功后把"当前内容/版本号"立为新基线（BUG-4：脏判定 O(1)） */
  const markSaved = useCallback((ed: Monaco.editor.IStandaloneCodeEditor, text: string) => {
    originalRef.current = text;
    const v = ed.getModel()?.getAlternativeVersionId();
    if (v !== undefined) originalVersionRef.current = v;
    setDirty(false);
  }, []);

  /**
   * 保存当前文件。
   *
   * - 先就近征询**保存接管者**（槽 `ui.editor.saveHandler`，2026-10-12 批）：命中
   *   （如 `.kojo`）则由接管者完成"保存源 + 编译产物"，宿主只消费其 `outcome`；
   * - 未命中 → 缺省路径：内核 io `writeText`（保编码保换行，受写白名单约束）；
   * - `needs-choice`（全角空格告警）→ 弹确认框、**本次不落盘**（返回 false，脏标记
   *   保留）；确认后由 `decideSaveWarning` 带 `choices` 重新调用本函数。
   *
   * 路径经 `filePathRef` 取最新值——修掉"只注册一次的 Ctrl+S 回调闭包过时"隐患
   * （换文件后 Ctrl+S 必须存到当前文件）；`save` 因而只依赖 `kernel`，身份稳定。
   */
  const save = useCallback(
    async (choices?: EditorSaveChoices): Promise<boolean> => {
      const ed = editorRef.current;
      if (!ed || savingRef.current) return false;
      const path = filePathRef.current;
      if (!path) return false;
      // P0 前置拦截：只读时不等到写盘才报错——通知 + 去授权 action（定稿 §九-1/3）
      if (!writableRef.current) {
        notify({
          kind: 'error',
          message: '保存被拒绝：项目当前为只读（写权限未批准或批准已失效）。',
          action: { label: '去授权', run: () => onReauthRef.current() },
        });
        setError('只读：写权限未批准');
        return false;
      }
      const text = ed.getValue();
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
            setPendingChoice(outcome.warning); // 尚未落盘：由确认框决定
            return false;
          }
          if (outcome.status === 'error') {
            setError(outcome.message);
            return false;
          }
          markSaved(ed, text);
          setError(null);
          setStatus(outcome.note ? `${outcome.message} · ${outcome.note}` : outcome.message);
          return true;
        }
        // 缺省保存（无接管者 / 提供者未激活 → 优雅降级）
        await kernel.io.writeText(path, text);
        markSaved(ed, text);
        setError(null);
        setStatus(`已保存 ${new Date().toLocaleTimeString()}`);
        return true;
      } catch (e: unknown) {
        // 竞态兜底（批准在保存途中被收回等）：WriteNotAllowedError → 中文人话 + 去授权
        if (e instanceof WriteNotAllowedError) {
          notify({
            kind: 'error',
            message: '保存被拒绝：写入路径不在已批准范围内。',
            action: { label: '去授权', run: () => onReauthRef.current() },
          });
          setError('只读：写权限未批准');
          return false;
        }
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        savingRef.current = false;
      }
    },
    [kernel, markSaved, notify],
  );

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

  // 脏状态上抛 + 保存句柄注册（审阅 M4 修复）
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    registerSave?.(save);
    return () => registerSave?.(null);
  }, [save, registerSave]);

  // 编辑器实例（仅一次）
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
    // BUG-4：脏判定改用 model 版本号比较（O(1)），不再每击键做全量字符串比较。
    // 取舍说明：撤销回原始内容后版本号仍不同 → 显示为脏（内容相等不再视为已保存）；
    // 这是版本号方案的标准行为（与主流编辑器一致），换取 MB 级文件零比较开销。
    ed.onDidChangeModelContent(() => {
      const v = ed.getModel()?.getAlternativeVersionId();
      setDirty(v !== undefined ? v !== originalVersionRef.current : ed.getValue() !== originalRef.current);
      scheduleMarkers();
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void save();
    });
    return () => {
      if (markerTimerRef.current !== null) window.clearTimeout(markerTimerRef.current);
      markerTimerRef.current = null;
      ed.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换文件（每次 filePath 变化重新加载）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ed = editorRef.current;
      if (!ed) return;
      try {
        const tf = await kernel.io.readText(filePath);
        if (cancelled) return;
        const uri = monaco.Uri.file(filePath);
        const old = monaco.editor.getModel(uri);
        old?.dispose();
        const model = monaco.editor.createModel(tf.text, languageFor(filePath), uri);
        ed.setModel(model);
        originalRef.current = tf.text;
        const v = model.getAlternativeVersionId();
        if (v !== undefined) originalVersionRef.current = v;
        setDirty(false);
        setError(null);
        setPendingChoice(null); // 换文件即作废未决的保存告警（避免误对旧文件应用修复）
        setStatus(`${tf.encoding} · ${tf.eol.toUpperCase()} · ${tf.text.split('\n').length} 行`);
        // 打开即算一次装饰（不等用户编辑）——首屏就能看到波浪线
        if (markerTimerRef.current !== null) window.clearTimeout(markerTimerRef.current);
        markerTimerRef.current = null;
        refreshMarkers(model, filePath);
        applyReveal();
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kernel, filePath, applyReveal, refreshMarkers]);

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
