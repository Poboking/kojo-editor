/**
 * @kojo/plugin-ui-sugar-lift
 *
 * 升糖**预览**插件（`ui.panel` + `ui.editor.liftPreview` + `ui.editor.codeAction`
 * 三槽贡献）。
 *
 * ## 定位（2026-10-12 升糖重定位批）
 *
 * 升糖**只用于看**。以前它把候选**写回源文件**，但升糖的产物是游戏不认识的糖写法，
 * 落回磁盘既无益于引擎、又让"原文件是 ERB 还是糖"变得混乱。现在改为：
 *
 * - 💡（`ui.editor.codeAction`）：光标停在可升糖片段上 → 发 `editor.liftPreview.show`
 *   意图，宿主在编辑器里**就地折叠原文 + 打字机显示糖写法**；
 * - 折叠加号（`ui.editor.liftPreview` 槽）：把可预览区间交给宿主注册为折叠范围
 *   （用编辑器原生折叠交互，参考 if 折叠）；
 * - 面板（`ui.panel`）：候选总览 + 逐条预览入口 + **未建议区间透明列出**。
 *
 * **全程不写盘**：本插件既不注入 `sugar.liftApply`，也不持有任何写逻辑。
 * ERB 默认只读（策略在宿主：`EditorPane` 按 `isErbLike` 恒置 `readOnly`；编辑
 * ERB 的合法路径是转 `.kojo`，由宿主在检测到编辑意图时自动分流）。
 *
 * ## 分层（"一切皆插件"）
 *
 * - 识别（round-trip 自证）在 kojo-sugar（`sugar.lift`，纯函数）；
 * - 渲染（折叠 / ViewZone / 打字机）在 app 壳（宿主把"意图"落成 Monaco 交互）；
 * - 本插件只做**呈现 + 意图**：纯逻辑在 `panel-logic.ts`（零 React，可单测），
 *   当前文件来自宿主事件 `editor.activeFileChanged`（不持有宿主引用）。
 */

import { createElement, useEffect, useState } from 'react';
import type {
  EditorLiftPreviewItem,
  FileIO,
  Plugin,
  SugarLiftCandidate,
  SugarLiftResult,
  SugarLiftService,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import {
  buildRows,
  buildSkipRows,
  degradeText,
  type CandidateRow,
  type PanelDegrade,
} from './panel-logic';
import { countLines, liftScanBudget } from './large-file';

/** 候选列表渲染上限（防 DOM 爆炸） */
const ROW_CAP = 200;
/** 「未建议」跳过项渲染上限 */
const SKIP_CAP = 60;

export function createUiSugarLiftPlugin(): Plugin {
  return {
    id: 'ui-sugar-lift',
    version: '0.3.0',
    // 只注入识别服务 + 只读 io；**不注入 sugar.liftApply**——本插件不写盘
    requires: [WellKnownServices.SugarLift, KernelServices.IO],
    activate(ctx) {
      const lift = ctx.inject<SugarLiftService>(WellKnownServices.SugarLift);
      const io = ctx.inject<FileIO>(KernelServices.IO);

      /* ------------------------ 扫描 + memo（三槽共用） ------------------------ */

      // liftSuggest 是纯函数但开销不小，且 Monaco 会在光标/内容变化时反复调用
      // provider——按 (path, text) 做一层 memo，文本没变就不重扫。
      let memo: { path: string; text: string; result: SugarLiftResult } | null = null;

      const scan = (path: string, text: string): SugarLiftResult => {
        if (memo && memo.path === path && memo.text === text) return memo.result;
        let result: SugarLiftResult;
        try {
          result = lift.liftSuggest({ source: text, filePath: path });
        } catch (err: unknown) {
          // provider 是纯函数：扫描失败 = 无候选（错误由面板路径显式上报，💡 不重复吼）
          ctx.log.warn(`升糖扫描失败（${path}）：${err instanceof Error ? err.message : String(err)}`);
          result = { candidates: [], skipped: [], degraded: false };
        }
        memo = { path, text, result };
        return result;
      };

      /**
       * 超大文件降级告警（每文件一次）。
       *
       * 折叠供给 / 💡 探测都是**高频自动调用**（Monaco 在打开、光标移动、选区变化
       * 时都会问），故告警必须去重；`Set` 加上限防长会话无限增长。
       */
      const warnedLarge = new Set<string>();
      const warnLargeOnce = (path: string, reason: string | null): void => {
        if (warnedLarge.has(path)) return;
        if (warnedLarge.size > 200) warnedLarge.clear();
        warnedLarge.add(path);
        ctx.log.warn(`已跳过整篇升糖扫描（${path}）：${reason ?? ''}`);
      };

      /** 候选 → 预览项（`alias` 无区间、不参与就地预览） */
      const toPreviewItems = (candidates: readonly SugarLiftCandidate[]): EditorLiftPreviewItem[] =>
        candidates
          .filter((c) => c.kind !== 'alias')
          .map((c) => ({
            fromLine: c.fromLine,
            toLine: c.toLine,
            sugarText: c.sugarSource,
            title:
              c.fromLine === c.toLine
                ? `预览语法糖（第 ${c.fromLine} 行）`
                : `预览语法糖（第 ${c.fromLine}–${c.toLine} 行）`,
            reason: c.reason,
          }));

      /* --------------------------- ui.editor.liftPreview --------------------------- */

      // 折叠范围供给：宿主把它变成 Monaco 的折叠加号（"参考 if 折叠"的交互来源）
      ctx.slots.register('ui.editor.liftPreview', {
        id: 'sugar-lift.preview',
        provideLiftPreview: ({ path, text, lineCount }) => {
          // 超长文件降级（2026-10-12「内核优化」批）：本槽被宿主接成 Monaco 折叠
          // 范围供给器，Monaco 会在**打开文件时**就要一遍整篇范围——全量扫描在
          // 52k 行文件上实测 231 ms，即"打开大文件卡一下"的主因。这里按体量让路。
          const budget = liftScanBudget(lineCount);
          if (budget.skip) {
            warnLargeOnce(path, budget.reason);
            return [];
          }
          return toPreviewItems(scan(path, text).candidates);
        },
      });

      /* --------------------------- 💡 CodeAction --------------------------- */

      // 光标落在可升糖片段上 → 「预览」动作；执行时发宿主意图（就地折叠显示），
      // **不写盘**。供给与执行之间用户可能继续编辑，故执行时按最新文本重扫一次。
      ctx.slots.register('ui.editor.codeAction', {
        id: 'sugar-lift.preview-action',
        provideActions: ({ path, text, line, lineCount }) => {
          if (line === undefined) return [];
          // 超长文件降级（2026-10-12「内核优化」批）：💡 可用性探测由 Monaco 在
          // 光标/选区变化时自动调用，超长文件上一次扫描 231 ms → 直接表现为卡顿。
          // 降级后请走「升糖候选」面板的显式「重新扫描」。
          const budget = liftScanBudget(lineCount);
          if (budget.skip) {
            warnLargeOnce(path, budget.reason);
            return [];
          }
          const items = toPreviewItems(scan(path, text).candidates);
          const hit = items.find((i) => line >= i.fromLine && line <= i.toLine);
          if (!hit) return [];
          return [
            {
              title: `${hit.title}（就地折叠原文）`,
              kind: 'refactor' as const,
              run: () => {
                const fresh = toPreviewItems(scan(path, text).candidates);
                const target = fresh.find((i) => i.fromLine === hit.fromLine && i.toLine === hit.toLine) ?? hit;
                ctx.bus.emit('editor.liftPreview.show', {
                  filePath: path,
                  fromLine: target.fromLine,
                  toLine: target.toLine,
                  sugarText: target.sugarText,
                });
              },
            },
          ];
        },
      });

      /* ------------------------------ 面板组件 ------------------------------ */

      function LiftPanel(): unknown {
        const [filePath, setFilePath] = useState<string | null>(null);
        const [result, setResult] = useState<SugarLiftResult | null>(null);
        const [degrade, setDegrade] = useState<PanelDegrade>('no-project');
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState<string | null>(null);

        // 当前文件（宿主广播）——换文件即重置
        useEffect(() => {
          const un = ctx.bus.on('editor.activeFileChanged', (p) => {
            setFilePath(p.filePath);
            setResult(null);
            setError(null);
            setDegrade(p.filePath ? 'scanning' : 'no-project');
          });
          return un;
        }, []);

        /**
         * 扫描：读当前文件（只读）→ `sugar.lift` → 候选列表。
         *
         * `force` 区分**自动**与**显式**两条路径（2026-10-12「内核优化」批）：
         * 自动路径（换文件即扫）在超长文件上让路给流畅度；显式路径（用户点
         * 「重新扫描」）照常执行——代价自担，但结果必须可得。
         */
        const runScan = (force = false): void => {
          const path = filePath;
          if (!path) return;
          setBusy(true);
          setError(null);
          void io
            .readText(path)
            .then((tf) => {
              const budget = liftScanBudget(countLines(tf.text));
              if (budget.skip && !force) {
                setResult(null);
                setDegrade('too-large');
                ctx.log.warn(`已跳过升糖自动扫描（${path}）：${budget.reason ?? ''}`);
                return;
              }
              const r = scan(path, tf.text);
              setResult(r);
              setDegrade(r.candidates.length === 0 ? 'empty' : 'scanning');
            })
            .catch((err: unknown) => {
              setError(err instanceof Error ? err.message : String(err));
              setDegrade('scan-error');
            })
            .finally(() => setBusy(false));
        };

        // 文件就绪但还没扫过 → 自动扫一次（面板打开即用）；超长文件让路（见 runScan）
        useEffect(() => {
          if (filePath && result === null && !busy && !error) runScan();
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [filePath]);

        /** 就地预览某条候选（发宿主意图；不写盘） */
        const preview = (r: CandidateRow): void => {
          const path = filePath;
          if (!path) return;
          ctx.bus.emit('editor.liftPreview.show', {
            filePath: path,
            fromLine: r.fromLine,
            toLine: r.toLine,
            sugarText: r.sugarSource,
          });
        };

        const rows = buildRows(result).slice(0, ROW_CAP);
        const skipRows = buildSkipRows(result?.skipped).slice(0, SKIP_CAP);

        const head = createElement(
          'div',
          { className: 'lift-toolbar' },
          createElement('span', { className: 'dim' }, '升糖预览（就地折叠显示 · 不改动原文件）'),
          createElement(
            'button',
            { className: 'ghost small', onClick: () => runScan(true), disabled: !filePath || busy },
            busy ? '扫描中…' : '重新扫描',
          ),
        );

        if (!filePath || degrade === 'no-file' || busy || result === null) {
          return createElement(
            'div',
            { className: 'panel-sugar-lift' },
            head,
            createElement('div', { className: 'lift-empty dim' }, degradeText(degrade)),
          );
        }
        if (error) {
          return createElement(
            'div',
            { className: 'panel-sugar-lift' },
            head,
            createElement('div', { className: 'lift-error' }, `失败：${error}`),
            createElement(
              'div',
              { className: 'lift-actions' },
              createElement('button', { className: 'ghost small', onClick: () => runScan(true) }, '重试'),
            ),
          );
        }

        const listBox = createElement(
          'div',
          { className: 'lift-list' },
          ...rows.map((r) =>
            createElement(
              'div',
              { key: r.key, className: 'lift-row' },
              createElement('span', { className: 'lift-range dim' }, r.rangeLabel),
              createElement('span', { className: 'lift-kind' }, r.kindLabel),
              createElement('span', { className: 'lift-sugar', title: r.reason }, firstLine(r.sugarSource)),
              r.needsAuthorColor
                ? createElement(
                    'span',
                    { className: 'lift-warn', title: '该糖写法依赖文件头「旁白色: 作者色」口径' },
                    '头',
                  )
                : null,
              createElement(
                'button',
                { className: 'ghost small', title: '在编辑器中就地折叠原文并显示糖写法', onClick: () => preview(r) },
                '预览',
              ),
            ),
          ),
          rows.length > ROW_CAP
            ? createElement('div', { className: 'dim lift-more' }, `其余 ${rows.length - ROW_CAP} 条未显示`)
            : null,
          rows.length === 0
            ? createElement('div', { className: 'dim lift-empty' }, degradeText('empty'))
            : null,
        );

        const footer = createElement(
          'div',
          { className: 'lift-footer' },
          createElement(
            'div',
            { className: 'dim lift-hint' },
            '预览为纯前端显示：折叠原文区间并在其上打字机输出糖写法，**不会改动原文件**。',
          ),
          skipRows.length > 0
            ? createElement(
                'div',
                { className: 'lift-skips' },
                createElement('div', { className: 'lift-skips-head dim' }, `未建议（${result.skipped.length}）`),
                ...skipRows.map((s) =>
                  createElement(
                    'div',
                    { key: s.key, className: 'lift-skip-row' },
                    createElement('span', { className: 'lift-range dim' }, s.rangeLabel),
                    createElement('span', { className: 'lift-skip-reason' }, s.reasonLabel),
                    createElement('span', { className: 'dim lift-skip-msg' }, s.message),
                  ),
                ),
              )
            : null,
        );

        return createElement('div', { className: 'panel-sugar-lift' }, head, listBox, footer);
      }

      ctx.slots.register('ui.panel', {
        id: 'sugar-lift',
        title: '升糖预览',
        icon: '⟰',
        order: 72,
        location: 'aux',
        defaultActive: false,
        component: LiftPanel,
      });
    },
  };
}

/* ============================== 内部工具 ============================== */

/** 糖写法首行（列表摘要用） */
function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i < 0 ? s : `${s.slice(0, i)} …`;
}
