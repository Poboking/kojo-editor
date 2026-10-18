import { createElement as h, useEffect, useRef, useState } from 'react';
import { cancelPreview, peekPreview, type QuickFixPreviewEntry } from './quick-fix-preview';
import { CODE_FONT_BASELINE } from './code-font'; // 与主编辑器同一张字面（全站唯一一条栈）
import { monacoThemeIdFor } from '../monaco/theme';
import { loadThemePref, useThemePref } from './theme-pref';

/**
 * 💡 快速修复的**预览 overlay**（P2-14）：quick fix 先出 preview diff、确认才落。
 *
 * 形态照 `DiffViewOverlay.tsx` 同款：工厂注依赖（node 测试环境可静态 import 本模块，
 * Monaco 只在浏览器 effect 里动态 import——monaco 在 node 下加载即炸）、`h(...)`
 * hyperscript、`wizard kd-host` 宿主类名、主题联动、`automaticLayout`。
 *
 * 里面是一枚**只读** Monaco diff 编辑器（`monaco.editor.createDiffEditor`）：左 =
 * 当前全文快照，右 = edits 应用后的样子（push 时由 `previewTextFor` 算好，与落地的
 * `applyTextEdits` 同一套夹取规则）。行级差异由 Monaco 自己算，宿主零 diff 算法。
 *
 * 底部两枚按钮：
 * - **应用修复**（默认焦点，Enter 触发）：走 deps.apply → 既有 `applyTextEdits`
 *   （一次撤销步，Ctrl+Z 可撤）；
 * - **取消**（Esc 由壳层全局键盘承接，同一条 close 通道）：什么都不写，只关预览。
 */

export interface QuickFixPreviewDeps {
  /**
   * 认领并应用（真源在 `editor-global-providers.ts`：takePreview + 既有 applyTextEdits）。
   * **异步**是有意的：宿主在 shell-overlays 里以动态 import 递这一条——那个模块静态挂着
   * 整个 monaco provider 世界（PS-10 开机图闸），预览确认是低频路径，点击那一刻才装载。
   */
  apply(actionId: string): Promise<boolean>;
  /** 触发这次修复的编辑器实例（peekPreview 按 paneId 取条目；异步理由同上） */
  activePaneId(): Promise<string | null>;
  /** 关 overlay（壳层 `ui.overlay.close` 通道，与 DiffViewOverlay 同一条） */
  close(): void;
}

export function createQuickFixPreviewOverlay(deps: QuickFixPreviewDeps): () => unknown {
  return function QuickFixPreviewOverlay(): unknown {
    // 条目挂载后异步取（activePaneId 走动态 import）：取到前不渲染空态也不渲染窗体，
    // 避免"没有待确认"闪一帧（那一刻其实有条目，只是宿主能力还在装载）。
    const [entry, setEntry] = useState<QuickFixPreviewEntry | null>(null);
    const [loaded, setLoaded] = useState(false);
    // 应用失败（条目已被认领 / 编辑器不在了）要说出来，不给"点了没反应"的面
    const [miss, setMiss] = useState<string | null>(null);
    // 主题联动（与 DiffViewOverlay 同款）：overlay 打开期间翻主题同样立刻跟上
    const themePref = useThemePref();
    const appliedRef = useRef(false);
    const containerRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
      let alive = true;
      void Promise.resolve(deps.activePaneId()).then((paneId) => {
        if (!alive) return;
        setEntry(paneId === null ? null : peekPreview(paneId));
        setLoaded(true);
      });
      return () => {
        alive = false;
      };
      // deps 由工厂闭包持有，挂载期恒定；只在挂载时取一次
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 只读 diff 编辑器：两侧就位即建；卸载即 dispose 模型与编辑器（照 DiffViewOverlay 写法）
    useEffect(() => {
      if (!entry) return;
      const host = containerRef.current;
      if (!host) return;
      let disposed = false;
      let editor: { dispose(): void } | null = null;
      void (async () => {
        const monaco = await import('../monaco/entry');
        if (disposed || !containerRef.current) return;
        const modelA = monaco.editor.createModel(entry.originalText, entry.languageId);
        const modelB = monaco.editor.createModel(entry.previewText, entry.languageId);
        const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
          theme: monacoThemeIdFor(loadThemePref()),
          // 纯预览：确认前一个字符都不许改（要改请回主编辑器）
          readOnly: true,
          originalEditable: false,
          renderSideBySide: true,
          renderOverviewRuler: true,
          // 缩进有语义（tab 层级），空白差异必须如实可见——与 DiffViewOverlay 同口径
          ignoreTrimWhitespace: false,
          diffAlgorithm: 'advanced',
          automaticLayout: true,
          // 预览是短平快的一次确认，Monaco 缺省那两道太晚的刹车照 DiffViewOverlay 收紧
          maxComputationTime: 3000,
          maxFileSize: 20,
          ...CODE_FONT_BASELINE,
        });
        diffEditor.setModel({ original: modelA, modified: modelB });
        editor = {
          dispose: () => {
            diffEditor.dispose();
            modelA.dispose();
            modelB.dispose();
          },
        };
      })();
      return () => {
        disposed = true;
        editor?.dispose();
      };
    }, [entry]);

    // 主题联动 effect（照 DiffViewOverlay：全局 setTheme，主编辑器与预览一起换）
    useEffect(() => {
      let alive = true;
      void import('../monaco/entry').then((monaco) => {
        if (alive) monaco.editor.setTheme(monacoThemeIdFor(themePref));
      });
      return () => {
        alive = false;
      };
    }, [themePref]);

    // 卸载时没应用过 ⇒ 这条预览按"取消"收账（Esc 关闭与点「取消」同口径，注册表不留悬账）
    useEffect(
      () => () => {
        if (!appliedRef.current && entry) cancelPreview(entry.actionId);
      },
      [entry],
    );

    if (!loaded) {
      // 宿主能力（动态 import）装载中的极短一拍：不渲染空态（那一刻其实有条目）
      return h('div', { className: 'wizard kd-host' }, h('p', { className: 'dim' }, '正在打开修复预览…'));
    }
    if (!entry) {
      return h(
        'div',
        { className: 'wizard kd-host' },
        h('p', { className: 'dim' }, '没有待确认的修复预览。'),
        h('div', { className: 'wizard-actions' }, h('button', { className: 'ghost small', onClick: deps.close }, '关闭')),
      );
    }

    const apply = (): void => {
      void Promise.resolve(deps.apply(entry!.actionId)).then((ok) => {
        if (ok) {
          appliedRef.current = true;
          deps.close();
          return;
        }
        // 拿不到条目 / 编辑器不在了：说清原因，不给"点了没反应"（铁律 4）
        setMiss('这条修复已经失效（预览已被认领或文件视图已关闭）——关闭后重新发起即可。');
      });
    };

    const cancel = (): void => {
      cancelPreview(entry.actionId);
      deps.close();
    };

    return h(
      'div',
      { className: 'wizard kd-host' },
      h('h3', null, entry.title),
      h(
        'div',
        { className: 'kd-labels' },
        h('span', { className: 'kd-label' }, '当前内容'),
        h('span', { className: 'kd-label-arrow' }, '⇒'),
        h('span', { className: 'kd-label' }, '修复后'),
      ),
      h('p', { className: 'dim qfp-hint' }, '确认前不会改动文件；应用后可用 Ctrl+Z 撤销。'),
      h('div', { ref: containerRef, className: 'qfp-editor' }),
      miss !== null ? h('p', { className: 'kd-error' }, miss) : null,
      h(
        'div',
        { className: 'wizard-actions' },
        h('button', { className: 'primary small', autoFocus: true, onClick: apply }, '应用修复（Enter）'),
        h('button', { className: 'ghost small', onClick: cancel }, '取消（Esc）'),
      ),
    );
  };
}
