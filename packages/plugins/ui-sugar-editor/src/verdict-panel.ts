/**
 * 糖判定面板组件（从 `index.ts` 的 `activate()` 原样迁出：DOM 结构、`className`、
 * 上屏文案与 hooks 次序逐字不变）。
 *
 * 保持**闭包工厂**形态（与 navigator / injector 同一迁移规矩）：
 *   - `sugar` / `io` / `ctx` 由 `index.ts` 的 `activate()` 注入，本模块不 inject、不查槽位；
 *   - 真相三事件仍只经共享核 `createPanelTruthController`（attach 一次订齐、dispose
 *     一次退净），面板不自带第二份事件拷贝、不自建文本真相源（C2 口径不变）；
 *   - 诊断列表 `diagList` 由装配层递进来——那张芯片行受 app 侧静态守卫
 *     `packages/app/tests/diagnostic-copy.test.ts` 钉在 `index.ts` 的源码文本上，搬不走。
 */

import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type {
  FileIO,
  PluginContext,
  PluginContextMenuAnchor,
  SugarTranspileService,
  UIPanelProps,
} from '@kojo/plugin-api';
import { diagnosticDisplay } from '@kojo/plugin-api';
import {
  copyVerdictText,
  openVerdictDiagMenu,
  openVerdictPanelMenu,
  type VerdictMenuHost,
} from './context-menu';
import {
  DIAG_WINDOW,
  buildVerdictRows,
  createPanelTruthController,
  degradeForActiveFile,
  degradeText,
  growWindow,
  isKojoFile,
  summarize,
  type VerdictDegrade,
  type VerdictRow,
  type VerdictSummary,
} from './panel-logic';
import type { FollowNode, VerdictDiagListProps } from './index';

/** 面板依赖（全部由 `index.ts` 的 `activate()` 注入） */
export interface VerdictPanelDeps {
  readonly ctx: PluginContext;
  readonly sugar: SugarTranspileService;
  readonly io: FileIO;
  /** 诊断列表组件（住在 `index.ts`；判据与守卫都在那边） */
  readonly diagList: (props: VerdictDiagListProps) => ReactElement;
}

export function createVerdictPanel(deps: VerdictPanelDeps): (props: UIPanelProps) => unknown {
  const { ctx, sugar, io, diagList } = deps;

  function VerdictPanel(props: UIPanelProps): unknown {
    const [filePath, setFilePath] = useState<string | null>(null);
    const [degrade, setDegrade] = useState<VerdictDegrade>('no-project');
    const [summary, setSummary] = useState<VerdictSummary | null>(null);
    const [rows, setRows] = useState<readonly VerdictRow[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [nonce, setNonce] = useState(0);
    /**
     * 真相三事件（activeFileChanged / documentChanged / cursorMoved）的订阅
     * 生命周期核（W4）：attach 一次订齐三条、dispose 一次退净三条；缓冲真相
     * 池（C2）与"命中当前文件 / 非派生视图"判据都住在核内，面板只拿裁决结果。
     */
    const truthRef = useRef(createPanelTruthController(ctx.bus));
    /** 当前文件的真相更新序号（广播命中当前文件时 +1，驱动重算） */
    const [liveTick, setLiveTick] = useState(0);
    /**
     * C1 反向下行：光标行（只在「光标就在面板显示的这一份文件里、且不是派生视图」时非 null）。
     * 派生视图的行号不属于这份文件——宁可清高亮，也不指错行。
     */
    const [cursorLine, setCursorLine] = useState<number | null>(null);
    /** 当前高亮行的节点（scrollIntoView 跟随；无匹配 / 未渲染到 = null，静默跳过） */
    const cursorRowRef = useRef<FollowNode | null>(null);
    /** 诊断渲染窗口（行数；undefined = 初始窗口——旧实现硬截 200 且第 201 条起不可达） */
    const [diagWindow, setDiagWindow] = useState<number | undefined>(undefined);

    /** 触底 / 点击「显示更多」→ 按 STEP 追加（单调不减、步长有界；算术住共享核，与预览面板同窗） */
    const growDiag = useCallback((total: number): void => {
      setDiagWindow((prev) => growWindow(prev, total, DIAG_WINDOW)); // 无增长原样返回 prev ⇒ 跳过重渲
    }, []);

    // 真相三事件：挂载即订齐、卸载即退净（换文件即重置全部状态；高亮随旧文件
    // 一起清掉——新文件的位点稍后才到，中间这一拍若留着旧行号会"指错行"）。
    // 缓冲真相广播（C2）命中当前文件即 +1 tick 驱动重算——面板数字从此与
    // 波浪线吃**同一份**文本（宿主已防抖/去重，收到即算，不叠加第二层）。
    useEffect(
      () =>
        truthRef.current.attach({
          onActiveFile: (filePath) => {
            setFilePath(filePath);
            setSummary(null);
            setRows([]);
            setDiagWindow(undefined);
            setError(null);
            setNonce(0);
            setCursorLine(null);
            setDegrade(degradeForActiveFile(filePath));
          },
          onLiveText: () => setLiveTick((n) => n + 1),
          onCursorLine: (line) => setCursorLine(line),
        }),
      [],
    );

    // 跟随：光标行换人时滚一次（nearest——已在视野内就不动）。行未渲染 / 无匹配行 → 静默跳过。
    useEffect(() => {
      if (cursorLine === null) return;
      cursorRowRef.current?.scrollIntoView?.({ block: 'nearest' });
    }, [cursorLine]);

    // 取"当前真相"：编辑器缓冲广播优先（live），还没收到广播的窗口期退回读盘（disk）；
    // 换文件 / 手动刷新 / 缓冲更新都走这里。转译有共享缓存，此处按收即算。
    useEffect(() => {
      const path = filePath;
      if (!path || !isKojoFile(path)) return;
      let cancelled = false;
      setError(null);
      const compute = (text: string): void => {
        const r = sugar.transpile(text, { filePath: path });
        const mapped = r.sourceMap.filter((e) => e.sourceLine !== null).length;
        setSummary(summarize(text, r.erb, mapped, r.diagnostics));
        setRows(buildVerdictRows(r.diagnostics));
      };
      const live = truthRef.current.pool.textFor(path);
      if (live !== null) {
        // 有缓冲真相：直接用它转译出判定（summary + rows），不等读盘
        try {
          compute(live);
        } catch (err: unknown) {
          setError(err instanceof Error ? err.message : String(err));
          setDegrade('read-error');
        }
        return;
      }
      setDegrade('reading');
      void io
        .readText(path)
        .then((tf) => {
          if (cancelled) return;
          compute(tf.text);
          setDiagWindow(undefined); // 新一批诊断 = 新窗口（刷新后从初始窗口看起）
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          setDegrade('read-error');
        });
      return () => {
        cancelled = true;
      };
    }, [filePath, nonce, liveTick]);

    /** 点击定位：请求宿主打开并滚动到该行 */
    const reveal = (line: number): void => {
      if (!filePath) return;
      ctx.bus.emit('editor.revealLocation', { filePath, line });
    };

    /**
     * 右键菜单落点（1023 批）：三条都接回已有通道（定位 / 重算 / `editor.sugarView.set`）。
     * 复制失败写进 `menuNote`（工具栏下面一行小字），不另起浮层。
     */
    const [menuNote, setMenuNote] = useState('');
    const rerunVerdict = (): void => setNonce((n) => n + 1);
    const menuHost: VerdictMenuHost = {
      reveal,
      refresh: rerunVerdict,
      setSugarView: (on) => {
        ctx.bus.emit('editor.sugarView.set', { on, source: 'ui-sugar-editor' });
      },
      copy: (text) => {
        void copyVerdictText(text).then((ok) => {
          if (ok) {
            setMenuNote('已复制');
            return;
          }
          setMenuNote('复制失败：当前环境不允许写剪贴板');
          ctx.log.warn('糖判定复制失败：剪贴板不可用');
        });
      },
    };

    // 空白处右键（1023 批）：刷新判定 · 切回源码 / 按语法糖显示 · 复制文件路径
    const shell = (children: ReactNode[]): ReactNode =>
      createElement(
        'div',
        {
          className: 'panel-sugar-verdict',
          onContextMenu: (e: PluginContextMenuAnchor) =>
            openVerdictPanelMenu(props, e, { filePath, canRefresh: isKojoFile(filePath) }, menuHost),
        },
        createElement(
          'div',
          { className: 'sv-toolbar' },
          createElement('span', { className: 'dim' }, '.kojo 校验（转译诊断；只读）'),
          createElement(
            'button',
            {
              className: 'ghost small',
              onClick: () => setNonce((n) => n + 1),
              disabled: !isKojoFile(filePath),
              title: '按当前真相重算（未保存的编辑也算数——与编辑器波浪线同源）',
            },
            '刷新',
          ),
        ),
        menuNote === '' ? null : createElement('div', { className: 'dim sv-hint' }, menuNote),
        ...children,
      );

    if (!isKojoFile(filePath)) {
      return shell([createElement('div', { className: 'sv-empty dim' }, degradeText(degrade))]);
    }
    // 读取中只在**还没有结果**时占屏：命中缓冲真相是同步算完的，degrade 标签可能
    // 仍停在 'reading' 上——有 summary 就必须让判定上屏（否则面板永远停在读取中）。
    if (degrade === 'reading' && summary === null) {
      return shell([createElement('div', { className: 'sv-empty dim' }, degradeText(degrade))]);
    }
    if (error) {
      return shell([
        createElement('div', { className: 'sv-error' }, `${degradeText(degrade)}：${error}`),
        createElement(
          'div',
          { className: 'sv-actions' },
          createElement('button', { className: 'ghost small', onClick: () => setNonce((n) => n + 1) }, '重试'),
        ),
      ]);
    }
    if (!summary) {
      return shell([createElement('div', { className: 'sv-empty dim' }, degradeText('reading'))]);
    }

    const statusBox = createElement(
      'div',
      { className: `sv-verdict ${summary.status}` },
      createElement('span', { className: 'sv-verdict-badge' }, summary.label),
      createElement('span', { className: 'sv-counts' },
        createElement('span', { className: 'sv-count err' }, `错误 ${summary.counts.error}`),
        createElement('span', { className: 'sv-count warn' }, `警告 ${summary.counts.warning}`),
        createElement('span', { className: 'sv-count info' }, `提示 ${summary.counts.info}`),
      ),
    );

    const meta = createElement(
      'div',
      { className: 'sv-meta dim' },
      `源行 ${summary.sourceLines} · 产物行 ${summary.generatedLines} · 已映射 ${summary.mappedLines} 行`,
    );

    const list =
      rows.length === 0
        ? createElement('div', { className: 'sv-empty dim' }, '无诊断 ✅')
        : createElement(diagList, {
            rows,
            limit: diagWindow,
            onGrow: growDiag,
            onReveal: reveal,
            cursorLine,
            cursorRef: cursorRowRef,
          });

    return shell([statusBox, meta, list]);
  }

  return VerdictPanel;
}
