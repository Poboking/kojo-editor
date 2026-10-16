import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react';
import type { FileIO } from '@kojo/plugin-api';
import {
  getDiffState,
  languageIdForSide,
  setDiffState,
  subscribeDiff,
  type DiffViewState,
} from './diff-view';
import { CODE_FONT_BASELINE } from './code-font'; // 比对面与主编辑器同一张字面（全站唯一一条栈）

/**
 * 通用 diff 视图 overlay（2026-10-15 比对/历史批）。
 *
 * 渲染用 `monaco.editor.createDiffEditor`（Monaco 已打包的内建 contrib）——
 * 行级差异计算在 Monaco 自己的差分级路径里做，宿主**零 diff 算法**；语料最大
 * 单文件（5.2 万行 / 2.35 MB）由 Monaco 的分块渲染扛住，主线程只承担一次
 * 模型创建。**刻意动态 import monaco**：本模块要在 node 测试环境里可静态渲染，
 * 而 monaco 在 node 下加载即炸——编辑器创建本来就只发生在浏览器 effect 里。
 */

export interface DiffViewDeps {
  io: FileIO;
  close(): void;
}

/** 一侧的解析结果：文本已就位，或读取失败（失败可见，不静默） */
type SideResolved =
  | { kind: 'loading' }
  | { kind: 'ok'; text: string }
  | { kind: 'error'; message: string };

/**
 * 解析一侧内容：`text` 直用；否则按 `path` 经内核 io 现读（读侧无写闸，
 * 游戏目录 / 备份目录同样读得到）。
 */
async function resolveSide(side: { text?: string; path?: string }, io: FileIO): Promise<SideResolved> {
  if (typeof side.text === 'string') return { kind: 'ok', text: side.text };
  if (typeof side.path === 'string' && side.path.length > 0) {
    try {
      const tf = await io.readText(side.path);
      return { kind: 'ok', text: tf.text };
    } catch (err) {
      return { kind: 'error', message: `${side.path} 读取失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { kind: 'error', message: '该侧没有可显示的内容' };
}

const loadingSide: SideResolved = { kind: 'loading' };

export function createDiffViewOverlay(deps: DiffViewDeps): () => unknown {
  return function DiffViewOverlay(): unknown {
    const [, setTick] = useState(0);
    useEffect(() => subscribeDiff(() => setTick((t) => t + 1)), []);
    const state: DiffViewState | null = getDiffState();

    const [original, setOriginal] = useState<SideResolved>(loadingSide);
    const [modified, setModified] = useState<SideResolved>(loadingSide);
    const containerRef = useRef<HTMLDivElement | null>(null);

    // 换请求（开窗后又被新意图顶掉）⇒ 两侧重读
    useEffect(() => {
      if (state === null || state.kind !== 'request') return;
      setOriginal(loadingSide);
      setModified(loadingSide);
      let alive = true;
      void resolveSide(state.request.original, deps.io).then((r) => alive && setOriginal(r));
      void resolveSide(state.request.modified, deps.io).then((r) => alive && setModified(r));
      return () => {
        alive = false;
      };
    }, [state]);

    // 两侧就位后才建编辑器；卸载（Esc/关闭/重开）即 dispose 模型与编辑器
    useEffect(() => {
      if (state === null || state.kind !== 'request') return;
      if (original.kind !== 'ok' || modified.kind !== 'ok') return;
      if (original.text === modified.text) return; // 无差异：横幅已讲清，不必建编辑器
      const host = containerRef.current;
      if (!host) return;
      let disposed = false;
      let editor: { dispose(): void } | null = null;
      void (async () => {
        const monaco = await import('../monaco/entry');
        if (disposed || !containerRef.current) return;
        const langA = languageIdForSide(state.request.original);
        const langB = languageIdForSide(state.request.modified);
        const modelA = monaco.editor.createModel(original.text, langA);
        const modelB = monaco.editor.createModel(modified.text, langB);
        const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
          theme: 'kojo-dark',
          readOnly: true,
          originalEditable: false,
          renderSideBySide: true,
          renderOverviewRuler: true,
          // eraTW 缩进有语义（tab 层级），空白差异必须如实可见
          ignoreTrimWhitespace: false,
          diffAlgorithm: 'advanced',
          renderIndicators: true,
          automaticLayout: true,
          // 编程字体：与主编辑器同一份真源（createDiffEditor 也吃 IEditorOptions 这些键）
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
    }, [state, original, modified]);

    if (state === null) {
      return h('div', { className: 'wizard kd-host' }, h('p', { className: 'dim' }, '没有要对比的内容。'));
    }
    if (state.kind === 'rejected') {
      return h(
        'div',
        { className: 'wizard kd-host' },
        h('h3', null, '无法打开对比'),
        h('p', { className: 'kd-error' }, state.reason),
        h('div', { className: 'wizard-actions' }, h('button', { className: 'ghost small', onClick: closeWith(deps) }, '关闭')),
      );
    }

    const { request } = state;
    const bothOk = original.kind === 'ok' && modified.kind === 'ok';
    const identical = bothOk && (original as { text: string }).text === (modified as { text: string }).text;
    const errLine: ReactNode[] = [];
    if (original.kind === 'error') errLine.push(h('p', { key: 'a', className: 'kd-error' }, original.message));
    if (modified.kind === 'error') errLine.push(h('p', { key: 'b', className: 'kd-error' }, modified.message));

    return h(
      'div',
      { className: 'wizard kd-host' },
      h('h3', null, request.title),
      h(
        'div',
        { className: 'kd-labels' },
        h('span', { className: 'kd-label' }, request.original.label),
        h('span', { className: 'kd-label-arrow' }, '⇄'),
        h('span', { className: 'kd-label' }, request.modified.label),
      ),
      identical
        ? h('p', { className: 'kd-banner ok' }, '两侧内容完全一致（无差异）。')
        : null,
      !bothOk && errLine.length === 0 ? h('p', { className: 'dim' }, '正在读取两侧内容…') : null,
      errLine,
      bothOk && !identical ? h('div', { ref: containerRef, className: 'kd-editor' }) : null,
      h(
        'div',
        { className: 'wizard-actions' },
        h(
          'button',
          {
            className: 'ghost small',
            onClick: () => closeWith(deps)(),
          },
          '关闭',
        ),
      ),
    );
  };
}

/** 关闭 = 清状态 + 请求宿主关 overlay（状态留着会让下次"没内容"的开窗读到旧请求） */
function closeWith(deps: DiffViewDeps): () => void {
  return () => {
    setDiffState(null);
    deps.close();
  };
}
