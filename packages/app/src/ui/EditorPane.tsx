import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type * as Monaco from 'monaco-editor';
import type { Kernel } from '@kojo/kernel';
import type { LineDecoration } from '@kojo/plugin-api';
// monaco-editor 0.57 的 exports 映射：'monaco-editor/*' → './esm/vs/*.js'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import * as monaco from 'monaco-editor';
import { ERB_LANGUAGE_ID, registerErbLanguage } from '../monaco/erb-language';
import { KOJO_LANGUAGE_ID, decorationsToMarkers, registerKojoLanguage } from '../monaco/kojo-language';

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
}

/**
 * Monaco 编辑面板：
 * - 打开 = 内核 io.readText（编码探测 + 归一化）；保存 = io.writeText（保编码 + 自动备份，受写白名单约束）；
 * - Ctrl+S 保存；未保存时显示脏标记；
 * - 支持外部定位（revealLine）：打开即滚动到指定行，供"点击校验问题跳转"消费。
 * - 语言按扩展名选择（`.kojo` = 语法糖表层；其余 = 原生 ERB）；
 * - 波浪线：消费 `ui.editor.decorator` 槽的全部贡献（纯函数）→ Monaco markers，
 *   打开即算、编辑停顿去抖重算（v0.3 S6）。
 */
export function EditorPane({ kernel, filePath, revealLine, revealNonce, onDirtyChange, registerSave }: Props): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const originalRef = useRef<string>('');
  /** 打开/保存成功时的 model 版本号（BUG-4：脏判定 O(1)，替代每击键全量字符串比较） */
  const originalVersionRef = useRef<number>(0);
  const savingRef = useRef(false);
  const revealRef = useRef<{ line: number; nonce: number } | null>(null);
  /** 当前文件路径（供只注册一次的 Monaco 回调读取最新值，避免闭包过时） */
  const filePathRef = useRef<string>(filePath);
  /** 装饰重算定时器（编辑停顿去抖） */
  const markerTimerRef = useRef<number | null>(null);
  /** 装饰刷新函数（ref 化，供只注册一次的 onDidChangeModelContent 调用） */
  const refreshMarkersRef = useRef<((model: Monaco.editor.ITextModel, path: string) => void) | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

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

  const save = useCallback(async (): Promise<boolean> => {
    const ed = editorRef.current;
    if (!ed || savingRef.current) return false;
    const text = ed.getValue();
    savingRef.current = true;
    try {
      await kernel.io.writeText(filePath, text);
      originalRef.current = text;
      // 保存成功 → 以当前版本号为新基线（BUG-4）
      const v = ed.getModel()?.getAlternativeVersionId();
      if (v !== undefined) originalVersionRef.current = v;
      setDirty(false);
      setError(null);
      setStatus(`已保存 ${new Date().toLocaleTimeString()}`);
      return true;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [kernel, filePath]);

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
        <button className="primary small" onClick={() => void save()} disabled={!dirty}>
          保存 (Ctrl+S)
        </button>
      </div>
      <div className="editor-body" ref={hostRef} />
    </div>
  );
}
