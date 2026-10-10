import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type * as Monaco from 'monaco-editor';
import type { Kernel } from '@kojo/kernel';
// monaco-editor 0.57 的 exports 映射：'monaco-editor/*' → './esm/vs/*.js'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import * as monaco from 'monaco-editor';
import { ERB_LANGUAGE_ID, registerErbLanguage } from '../monaco/erb-language';

// Monaco worker 装配（vite ?worker 后缀）；ERB 无需语言服务 worker，base 编辑器 worker 即可
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};
registerErbLanguage(monaco);

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
 * - 行级装饰（`ui.editor.decorator` 槽）为后续交付物。
 */
export function EditorPane({ kernel, filePath, revealLine, revealNonce, onDirtyChange, registerSave }: Props): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const originalRef = useRef<string>('');
  const savingRef = useRef(false);
  const revealRef = useRef<{ line: number; nonce: number } | null>(null);
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
    ed.onDidChangeModelContent(() => {
      setDirty(ed.getValue() !== originalRef.current);
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void save();
    });
    return () => {
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
        const model = monaco.editor.createModel(tf.text, ERB_LANGUAGE_ID, uri);
        ed.setModel(model);
        originalRef.current = tf.text;
        setDirty(false);
        setError(null);
        setStatus(`${tf.encoding} · ${tf.eol.toUpperCase()} · ${tf.text.split('\n').length} 行`);
        applyReveal();
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kernel, filePath, applyReveal]);

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
