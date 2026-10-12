/**
 * @kojo/plugin-ui-sugar-lift
 *
 * 升糖**视图**插件（`ui.panel` + `ui.editor.liftPreview` + `ui.editor.codeAction`
 * 三槽贡献）。
 *
 * ## 两条口径并存（2026-10-12 语法糖批新增）
 *
 * | 口径 | 服务 | 判据 | 用途 |
 * |---|---|---|---|
 * | **逐条候选**（`liftSuggest`） | `provideLiftPreview` / 💡 | 强自证（round-trip 逐字节） | "这段能不能**安全写回** `.kojo`" |
 * | **整文件投影**（`liftProject`） | `provideLiftProject` / 面板摘要 | 逐行局部映射 + 单行降级 | "这份 ERB **读起来**像不像剧本" |
 *
 * 后者的服务对象是**不熟悉 EraBasic 的读者**：打开别人写的口上，一键显示为糖，
 * 像看剧本一样读懂它（少部分糖未覆盖的行原样留原代码）。前者命中面窄（真实语料
 * 行覆盖 6.5%），后者宽（90.2%）——**两个数都真实，只是问的问题不同**。
 *
 * 注意两条口径的**消费面不同**：投影那条的主力是**宿主**（工具条开关 + 编辑器
 * 就地渲染，读者全程不必打开任何面板）；本插件的面板只回答"读懂了百分之多少、
 * 剩下的为什么是原代码"，并提供一个切换入口。
 *
 * ## 定位（2026-10-12 升糖重定位批）
 *
 * 升糖**只用于看**。以前它把候选**写回源文件**，但升糖的产物是游戏不认识的糖写法，
 * 落回磁盘既无益于引擎、又让"原文件是 ERB 还是糖"变得混乱。现在改为：
 *
 * - 宿主工具条开关（`editor.sugarView.set` 意图）：整份 ERB 显示为语法糖 / 切回原代码；
 * - 💡（`ui.editor.codeAction`）：光标停在可升糖片段上 → 发 `editor.liftPreview.show`
 *   意图，宿主就地折叠原文 + 打字机显示糖写法（**逐条**细看用）；
 * - 折叠加号（`ui.editor.liftPreview` 槽）：把可预览区间交给宿主注册为折叠范围；
 * - 面板（`ui.panel`）：投影摘要（覆盖行数 / 占比 / 保留原生的分因）。
 *
 * **全程不写盘**：本插件既不注入 `sugar.liftApply`，也不持有任何写逻辑。
 * ERB 默认只读（策略在宿主：`EditorPane` 按 `isErbLike` 恒置 `readOnly`；编辑
 * ERB 的合法路径是转 `.kojo`，由宿主在检测到编辑意图时自动分流）。
 *
 * ## 分层（"一切皆插件"）
 *
 * - 投影 / 识别（纯函数）在 kojo-sugar（`sugar.lift`）；
 * - 渲染（隐藏原文 / ViewZone / 打字机 / 着色）在 app 壳（宿主把"意图"落成 Monaco 交互）；
 * - 本插件只做**呈现 + 意图**：纯逻辑在 `panel-logic.ts`（零 React，可单测），
 *   当前文件来自宿主事件 `editor.activeFileChanged`（不持有宿主引用）。
 */

import { createElement, useEffect, useState, type ReactNode } from 'react';
import type {
  EditorLiftPreviewItem,
  FileIO,
  Plugin,
  SugarLiftCandidate,
  SugarLiftResult,
  SugarLiftService,
  SugarProjectResult,
  SugarProjectStats,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import {
  breakdownText,
  coverageText,
  degradeText,
  summarizeProjection,
  type PanelDegrade,
  type ProjectionSummary,
} from './panel-logic';

/** 投影降级时的空统计（扫描抛错 → 无段无统计，**不静默**：面板会显示错误） */
const EMPTY_PROJECT_STATS: SugarProjectStats = {
  totalLines: 0,
  projectedLines: 0,
  passthroughLines: 0,
  nativeLines: 0,
  nativeByReason: [],
};

export function createUiSugarLiftPlugin(): Plugin {
  return {
    id: 'ui-sugar-lift',
    version: '0.3.0',
    // 只注入识别服务 + 只读 io；**不注入 sugar.liftApply**——本插件不写盘
    requires: [WellKnownServices.SugarLift, KernelServices.IO],
    activate(ctx) {
      const lift = ctx.inject<SugarLiftService>(WellKnownServices.SugarLift);
      const io = ctx.inject<FileIO>(KernelServices.IO);

      /* ------------------------ 扫描 + memo（各槽共用） ------------------------ */

      // 两个服务都是纯函数但开销不小，且 Monaco 会在光标/内容变化时反复调用
      // provider——按 (path, text) 各做一层 memo，文本没变就不重扫。
      //
      // 为什么**分开两个 memo**：两个口径的触发面不同（逐条候选只在 💡 / 折叠
      // 供给时被问；整文件投影只在「显示为糖」被问）。合成一个会让"只想要投影"
      // 的文件白跑一遍 round-trip 自证——那是本模块最贵的计算。
      let memo: { path: string; text: string; result: SugarLiftResult } | null = null;
      let projMemo: { path: string; text: string; result: SugarProjectResult } | null = null;

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

      /** 整文件糖投影（`sugar.lift`.liftProject）——同上 memo 纪律 */
      const scanProject = (path: string, text: string): SugarProjectResult => {
        if (projMemo && projMemo.path === path && projMemo.text === text) return projMemo.result;
        let result: SugarProjectResult;
        try {
          result = lift.liftProject({ source: text, filePath: path });
        } catch (err: unknown) {
          ctx.log.warn(
            `糖投影失败（${path}）：${err instanceof Error ? err.message : String(err)}`,
          );
          result = { segments: [], stats: EMPTY_PROJECT_STATS };
        }
        projMemo = { path, text, result };
        return result;
      };

      /**
       * 整文件投影 → 就地视图项（宿主「显示为糖」开关的供给）。
       *
       * 只对**原生 ERB** 供给：`.kojo` 本身就是糖，再投影一遍毫无意义
       * （`provideLiftProject` 的契约明确"不适用该文件的贡献返回空数组"）。
       */
      const toProjectItems = (path: string, text: string): EditorLiftPreviewItem[] => {
        if (!isErbFile(path)) return [];
        return scanProject(path, text).segments.map((s) => ({
          fromLine: s.fromLine,
          toLine: s.toLine,
          sugarText: s.sugarText,
          title: s.fromLine === s.toLine ? `第 ${s.fromLine} 行` : `第 ${s.fromLine}–${s.toLine} 行`,
          reason: '语法糖投影：只读显示，不改动原文件',
        }));
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
        provideLiftPreview: ({ path, text }) => toPreviewItems(scan(path, text).candidates),
        // 整文件投影供给（宿主「显示为糖」开关）：逐行降级、命中面宽，与上面的
        // 逐条候选**口径不同、用途不同**，两者并存（契约 `provideLiftProject` 注）。
        provideLiftProject: ({ path, text }) => toProjectItems(path, text),
      });

      /* --------------------------- 💡 CodeAction --------------------------- */

      // 光标落在可升糖片段上 → 「预览」动作；执行时发宿主意图（就地折叠显示），
      // **不写盘**。供给与执行之间用户可能继续编辑，故执行时按最新文本重扫一次。
      ctx.slots.register('ui.editor.codeAction', {
        id: 'sugar-lift.preview-action',
        provideActions: ({ path, text, line }) => {
          if (line === undefined) return [];
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

      /**
       * 「糖视图」面板：**这份 ERB 读起来有多少是人话**。
       *
       * 面板刻意**不列逐条候选**——那是作者点 💡 时才关心的事，而读者关心的是另外
       * 两个问题："读懂了百分之多少"与"剩下的为什么还是原代码"。切换入口就在面板
       * 顶部：面板与工具条走**同一条意图事件**，状态所有者始终是宿主。
       */
      function SugarViewPanel(): unknown {
        const [filePath, setFilePath] = useState<string | null>(null);
        const [summary, setSummary] = useState<ProjectionSummary | null>(null);
        const [degrade, setDegrade] = useState<PanelDegrade>('no-project');
        const [error, setError] = useState<string | null>(null);
        /** 重新生成用的计数器（读盘 + 投影都是纯读，重跑安全） */
        const [nonce, setNonce] = useState(0);

        // 当前文件（宿主广播）
        useEffect(() => ctx.bus.on('editor.activeFileChanged', (p) => setFilePath(p.filePath)), []);

        // 读盘 → 投影摘要（换文件 / 手动重新生成即重算）
        useEffect(() => {
          const path = filePath;
          setSummary(null);
          setError(null);
          if (!path) {
            setDegrade('no-project');
            return;
          }
          if (!isErbFile(path)) {
            setDegrade('not-erb');
            return;
          }
          setDegrade('scanning');
          let cancelled = false;
          void io
            .readText(path)
            .then((tf) => {
              if (!cancelled) setSummary(summarizeProjection(scanProject(path, tf.text)));
            })
            .catch((err: unknown) => {
              if (cancelled) return;
              setError(err instanceof Error ? err.message : String(err));
              setDegrade('scan-error');
            });
          return () => {
            cancelled = true;
          };
        }, [filePath, nonce]);

        const isErb = filePath !== null && isErbFile(filePath);

        const head = createElement(
          'div',
          { className: 'lift-toolbar' },
          createElement('span', { className: 'dim' }, '糖视图（只读 · 不改动原文件）'),
          createElement(
            'button',
            {
              className: 'ghost small',
              title: '在编辑器里把这份 ERB 显示为语法糖 / 切回原代码（也可按 Ctrl+Alt+T）',
              disabled: !isErb,
              onClick: () => ctx.bus.emit('editor.sugarView.set', {}),
            },
            '在编辑器中切换',
          ),
          createElement(
            'button',
            { className: 'ghost small', onClick: () => setNonce((n) => n + 1), disabled: !isErb },
            '重新生成',
          ),
        );

        /** 面板外壳（head + 若干 body 块；`unknown[]` → `ReactNode` 由 createElement 收口） */
        const shell = (...body: ReactNode[]): unknown =>
          createElement('div', { className: 'panel-sugar-lift' }, head, ...body);

        if (!isErb || summary === null) {
          return shell(
            createElement('div', { className: 'lift-empty dim' }, degradeText(degrade)),
            error
              ? createElement(
                  'div',
                  { className: 'lift-error' },
                  `失败：${error}`,
                  createElement(
                    'div',
                    { className: 'lift-actions' },
                    createElement('button', { className: 'ghost small', onClick: () => setNonce((n) => n + 1) }, '重试'),
                  ),
                )
              : null,
          );
        }

        const body = createElement(
          'div',
          { className: 'lift-summary' },
          createElement('div', { className: 'lift-coverage' }, coverageText(summary)),
          createElement('div', { className: 'dim lift-breakdown' }, breakdownText(summary)),
          summary.segments === 0 || summary.projected === 0
            ? createElement('div', { className: 'dim lift-empty' }, degradeText('empty'))
            : null,
          summary.reasons.length > 0
            ? createElement(
                'div',
                { className: 'lift-reasons' },
                createElement('div', { className: 'lift-reasons-head dim' }, '保留原代码的原因'),
                ...summary.reasons.map((r) =>
                  createElement(
                    'div',
                    { key: r.key, className: 'lift-reason-row' },
                    createElement('span', { className: 'lift-reason-label' }, r.label),
                    createElement('span', { className: 'dim lift-reason-count' }, `${r.count} 行`),
                  ),
                ),
              )
            : null,
        );

        const footer = createElement(
          'div',
          { className: 'lift-footer' },
          createElement(
            'div',
            { className: 'dim lift-hint' },
            '已映射的行在编辑器里以语法糖显示（台词像剧本、条件变成「如果 …：」）；' +
              '其余行原样保留原 ERB 代码，方便对照着学。全程只读，不改动原文件。',
          ),
        );

        return shell(body, footer);
      }

      ctx.slots.register('ui.panel', {
        id: 'sugar-lift',
        title: '糖视图',
        icon: '📖',
        order: 72,
        location: 'aux',
        defaultActive: false,
        component: SugarViewPanel,
      });
    },
  };
}

/* ============================== 内部工具 ============================== */

/**
 * 是否原生 ERB（`.erb` / `.erm`）。
 *
 * 与 app 壳的 `isErbLike` 同口径（那边定"是否只读预览对象"，这边定"是否该投影"）。
 * 刻意不跨包共享：两处都是单行判定，而插件**不允许** import 宿主代码
 * （"一切皆插件"纪律），为一行正则新增契约导出不划算。
 */
function isErbFile(path: string): boolean {
  return /\.er[bm]$/i.test(path);
}
