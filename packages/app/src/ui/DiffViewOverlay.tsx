import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react';
import type { FileIO } from '@kojo/plugin-api';
import { errorText } from '@kojo/plugin-api';
import {
  clearDiff,
  closeDiffPane,
  diffEqualityBanner,
  diffEqualityOf,
  focusDiffPane,
  getDiffPanes,
  languageIdForSide,
  subscribeDiff,
  type DiffPane,
  type DiffRequest,
} from './diff-view';
import { CODE_FONT_BASELINE } from './code-font'; // 比对面与主编辑器同一张字面（全站唯一一条栈）

/**
 * 通用 diff 视图 overlay（2026-10-15 比对/历史批；W10 第 2 点改多开）。
 *
 * 渲染用 `monaco.editor.createDiffEditor`（Monaco 已打包的内建 contrib）——
 * 行级差异计算在 Monaco 自己的差分级路径里做，宿主**零 diff 算法**；语料最大
 * 单文件（5.2 万行 / 2.35 MB）由 Monaco 的分块渲染扛住，主线程只承担一次
 * 模型创建。**刻意动态 import monaco**：本模块要在 node 测试环境里可静态渲染，
 * 而 monaco 在 node 下加载即炸——编辑器创建本来就只发生在浏览器 effect 里。
 *
 * 比对栈（`diff-core.ts`）在这里投影成一排标签：栈顶是当前这本，关一格回上一格，
 * 栈空才收模态。每格两侧的读取快照按 `key` 各自缓存——换格子不许把别的格子的
 * 读数搅在一起（旧单例正是栽在"后开者顶掉前一个"）。
 */

export interface DiffViewDeps {
  io: FileIO;
  close(): void;
}

/** 一侧的解析结果：文本已就位，或读取失败（失败可见，不静默） */
type SideResolved =
  | { kind: 'loading' }
  | { kind: 'ok'; text: string; bytes?: Uint8Array }
  | { kind: 'error'; message: string };

/** 一格两侧的读取快照 */
interface PaneSides {
  original: SideResolved;
  modified: SideResolved;
}

const loadingSides: PaneSides = { original: { kind: 'loading' }, modified: { kind: 'loading' } };

/**
 * 解析一侧内容：`text` 直用；否则按 `path` 经内核 io 现读（读侧无写闸，
 * 游戏目录 / 备份目录同样读得到）。路径侧顺手取原始字节——判等核的**字节态**
 * 要靠它（行同字节不同 = 编码/换行差异，必须在横幅里说出来）。字节取不到时
 * 只降级字节态（行态照判），不拿"没取到"冒充"相同"。
 */
async function resolveSide(side: { text?: string; path?: string }, io: FileIO): Promise<SideResolved> {
  if (typeof side.text === 'string') return { kind: 'ok', text: side.text };
  if (typeof side.path === 'string' && side.path.length > 0) {
    try {
      const [tf, bytes] = await Promise.all([
        io.readText(side.path),
        io.readBytes(side.path).catch(() => undefined),
      ]);
      return { kind: 'ok', text: tf.text, bytes };
    } catch (err) {
      return { kind: 'error', message: `${side.path} 读取失败：${errorText(err)}` };
    }
  }
  return { kind: 'error', message: '该侧没有可显示的内容' };
}

/** 收摊：清栈 + 请宿主关模态（栈留着会让下次"没内容"的开窗读到陈年比对） */
function dismissAll(deps: DiffViewDeps): void {
  clearDiff();
  deps.close();
}

export function createDiffViewOverlay(deps: DiffViewDeps): () => unknown {
  return function DiffViewOverlay(): unknown {
    const [, setTick] = useState(0);
    useEffect(() => subscribeDiff(() => setTick((t) => t + 1)), []);
    const panes: readonly DiffPane[] = getDiffPanes();
    const active: DiffPane | null = panes.length === 0 ? null : panes[panes.length - 1]!;

    /** 每格两侧的读取快照，按格子 key 隔离 */
    const [sidesByKey, setSidesByKey] = useState<Record<string, PaneSides>>({});
    /** 已发起过读取的格子（StrictMode 二次执行也不重复读盘） */
    const requestedRef = useRef<Set<string>>(new Set());
    const containerRef = useRef<HTMLDivElement | null>(null);

    const activeKey = active?.key ?? null;
    const activeRequest: DiffRequest | null =
      active !== null && active.state.kind === 'request' ? active.state.request : null;
    const sides = activeKey === null ? null : (sidesByKey[activeKey] ?? null);
    const original = sides?.original ?? loadingSides.original;
    const modified = sides?.modified ?? loadingSides.modified;

    // 这一格第一次进视野 ⇒ 两侧并行现读；读回来过就不重复读
    useEffect(() => {
      if (activeKey === null || activeRequest === null) return;
      if (requestedRef.current.has(activeKey)) return;
      requestedRef.current.add(activeKey);
      const key = activeKey;
      setSidesByKey((prev) => ({ ...prev, [key]: loadingSides }));
      void resolveSide(activeRequest.original, deps.io).then((r) => {
        setSidesByKey((prev) => ({ ...prev, [key]: { ...(prev[key] ?? loadingSides), original: r } }));
      });
      void resolveSide(activeRequest.modified, deps.io).then((r) => {
        setSidesByKey((prev) => ({ ...prev, [key]: { ...(prev[key] ?? loadingSides), modified: r } }));
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, activeRequest]);

    // 已被关掉的格子 ⇒ 缓存与"已读取"标记一起丢（不留陈旧读数；重开同一对还会现读）
    useEffect(() => {
      const live = new Set(panes.map((p) => p.key));
      for (const k of [...requestedRef.current]) if (!live.has(k)) requestedRef.current.delete(k);
      setSidesByKey((prev) => {
        let changed = false;
        const next: Record<string, PaneSides> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (live.has(k)) next[k] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [panes.length]);

    // 两侧就位且确有差异才建编辑器；卸载（Esc/关闭/换格）即 dispose 模型与编辑器
    useEffect(() => {
      if (activeKey === null || activeRequest === null) return;
      if (original.kind !== 'ok' || modified.kind !== 'ok') return;
      // 行级无差异就不建编辑器（与横幅同一条判等核：行态从 compareContent 派生）
      if (diffEqualityOf(original, modified).linesEqual === true) return; // 无差异：横幅已讲清
      const host = containerRef.current;
      if (!host) return;
      let disposed = false;
      let editor: { dispose(): void } | null = null;
      const textA = original.text;
      const textB = modified.text;
      void (async () => {
        const monaco = await import('../monaco/entry');
        if (disposed || !containerRef.current) return;
        const langA = languageIdForSide(activeRequest.original);
        const langB = languageIdForSide(activeRequest.modified);
        const modelA = monaco.editor.createModel(textA, langA);
        const modelB = monaco.editor.createModel(textB, langB);
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
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, original, modified]);

    if (active === null) {
      return h('div', { className: 'wizard kd-host' }, h('p', { className: 'dim' }, '没有要对比的内容。'));
    }

    // 多开：栈里超过一本才出标签条；点标签切过去，点 × 只关那一本
    const tabs: ReactNode[] =
      panes.length > 1
        ? [
            h(
              'div',
              { key: 'tabs', className: 'kd-tabs' },
              ...panes.map((p) =>
                h(
                  'span',
                  {
                    key: p.key,
                    className: `kd-tab${p.key === active.key ? ' active' : ''}`,
                    title: p.state.kind === 'request' ? p.state.request.title : '无法对比',
                    onClick: () => focusDiffPane(p.key),
                  },
                  p.state.kind === 'request' ? p.state.request.title : '（无法对比）',
                  h(
                    'button',
                    {
                      className: 'ghost small kd-tab-close',
                      'aria-label': '关闭这组比对',
                      onClick: (e: { stopPropagation(): void }) => {
                        e.stopPropagation();
                        if (closeDiffPane(p.key)) deps.close();
                      },
                    },
                    '×',
                  ),
                ),
              ),
            ),
          ]
        : [];

    if (active.state.kind === 'rejected') {
      return h(
        'div',
        { className: 'wizard kd-host' },
        ...tabs,
        h('h3', null, '无法打开对比'),
        h('p', { className: 'kd-error' }, active.state.reason),
        h(
          'div',
          { className: 'wizard-actions' },
          h('button', { className: 'ghost small', onClick: () => dismissAll(deps) }, '关闭'),
        ),
      );
    }

    const { request } = active.state;
    const bothOk = original.kind === 'ok' && modified.kind === 'ok';
    // 判等只认一条核：字节态 + 行态同源派生（W17；宿主不再各写 if 链）
    const banner =
      original.kind === 'ok' && modified.kind === 'ok'
        ? diffEqualityBanner(diffEqualityOf(original, modified))
        : null;
    const identical = banner?.noLineDiff === true;
    const errLine: ReactNode[] = [];
    if (original.kind === 'error') errLine.push(h('p', { key: 'a', className: 'kd-error' }, original.message));
    if (modified.kind === 'error') errLine.push(h('p', { key: 'b', className: 'kd-error' }, modified.message));

    return h(
      'div',
      { className: 'wizard kd-host' },
      ...tabs,
      h('h3', null, request.title),
      h(
        'div',
        { className: 'kd-labels' },
        h('span', { className: 'kd-label' }, request.original.label),
        h('span', { className: 'kd-label-arrow' }, '⇄'),
        h('span', { className: 'kd-label' }, request.modified.label),
      ),
      banner !== null ? h('p', { className: 'kd-banner ok' }, banner.message) : null,
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
            onClick: () => {
              // 关当前这格：栈里还有别的比对就回到上一本，栈空才收模态
              if (closeDiffPane(active.key)) deps.close();
            },
          },
          panes.length > 1 ? `关闭这组比对（还剩 ${panes.length - 1} 组）` : '关闭',
        ),
      ),
    );
  };
}
