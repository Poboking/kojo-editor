/**
 * @kojo/plugin-ui-sugar-lift
 *
 * 升糖建议面板（`ui.panel` 槽贡献；v0.3 批 S5-UI，实施记录 §5.32b）。
 *
 * 把 S5 的纯函数升糖能力第一次带上 UI，做成「扫描 → 候选列表 → diff → 应用」闭环：
 *   当前 `.kojo` 文件 → `sugar.lift` 扫描（round-trip 自证过的候选）→
 *   勾选（单选 / 全选 / 忽略）→ 实时 diff 预览 → 「应用」写回源文件。
 *
 * 分层（"一切皆插件"）：
 *   - 识别与自证在 kojo-sugar（`sugar.lift`，纯函数）；
 *   - **写盘在 kojo-sugar（`sugar.liftApply`）**——编码守卫 → 备份 →
 *     writablePaths 第一道闸 → 回读校验 → 发 `file.changed`，**一闸不少**；
 *     本插件只做**呈现 + 意图**，绝不自建写逻辑；
 *   - 纯逻辑（列表规约 / 三态勾选 / diff 行 / 跳过项标签）在 `panel-logic.ts`
 *     （零 React，可单测）；
 *   - 当前文件来自宿主事件 `editor.activeFileChanged`（不持有宿主引用）。
 *
 * 事件纪律：本插件**只消费** `editor.activeFileChanged` 与 `file.changed`
 * （后者用于"别人改了盘 → 提示重扫"），**不发**任何事件——它不改盘，写盘在
 * `sugar.liftApply` 里，事件也由那边发（谁改盘谁发，职责不重叠）。
 */

import { createElement, useEffect, useState } from 'react';
import type {
  FileIO,
  Plugin,
  SugarLiftApplyService,
  SugarLiftCandidate,
  SugarLiftDiffHunk,
  SugarLiftResult,
  SugarLiftService,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import {
  EMPTY_SELECTION,
  buildDiffLines,
  buildRows,
  buildSkipRows,
  clearSelection,
  degradeText,
  diffToText,
  isSelected,
  selectAll,
  selectedRows,
  summarizeSelection,
  toggleIgnore,
  toggleRow,
  type CandidateRow,
  type PanelDegrade,
  type SelectState,
} from './panel-logic';

/** 候选列表渲染上限（防 DOM 爆炸；超大文件下建议先按区间过滤） */
const ROW_CAP = 200;
/** 「未建议」跳过项渲染上限 */
const SKIP_CAP = 60;

export function createUiSugarLiftPlugin(): Plugin {
  return {
    id: 'ui-sugar-lift',
    version: '0.3.0',
    // 只声明服务契约：写能力由 sugar.liftApply 承担，本插件不碰 io
    requires: [
      WellKnownServices.SugarLift,
      WellKnownServices.SugarLiftApply,
      KernelServices.IO,
    ],
    activate(ctx) {
      const lift = ctx.inject<SugarLiftService>(WellKnownServices.SugarLift);
      const applier = ctx.inject<SugarLiftApplyService>(WellKnownServices.SugarLiftApply);
      const io = ctx.inject<FileIO>(KernelServices.IO);

      /* ------------------------------ 面板组件 ------------------------------ */

      function LiftPanel(): unknown {
        const [filePath, setFilePath] = useState<string | null>(null);
        const [source, setSource] = useState<string | null>(null);
        const [result, setResult] = useState<SugarLiftResult | null>(null);
        const [sel, setSel] = useState<SelectState>(EMPTY_SELECTION);
        const [degrade, setDegrade] = useState<PanelDegrade>('no-project');
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState<string | null>(null);
        const [applying, setApplying] = useState(false);
        const [armed, setArmed] = useState(false);
        const [applied, setApplied] = useState<string | null>(null);
        // "盘上文件变了"提示（本插件不改盘；别处改了 → 建议重扫）
        const [staleHint, setStaleHint] = useState(false);

        // 当前文件（宿主广播）——换文件即重置全部状态
        useEffect(() => {
          const un = ctx.bus.on('editor.activeFileChanged', (p) => {
            setFilePath(p.filePath);
            setSource(null);
            setResult(null);
            setSel(EMPTY_SELECTION);
            setError(null);
            setApplied(null);
            setArmed(false);
            setStaleHint(false);
            setDegrade(p.filePath ? 'scanning' : 'no-project');
          });
          return un;
        }, []);

        // 外部写盘（本次应用自己的写入也会触发）→ 提示"盘上内容已变"
        useEffect(() => {
          const un = ctx.bus.on('file.changed', (p) => {
            if (p.kind !== 'change') return;
            setFilePath((cur) => {
              if (cur && p.path === cur) setStaleHint(true);
              return cur;
            });
          });
          return un;
        }, []);

        /** 扫描：读当前文件（内核 io，只读）→ `sugar.lift` → 候选列表 */
        const runScan = (): void => {
          const path = filePath;
          if (!path) return;
          setBusy(true);
          setError(null);
          setApplied(null);
          setArmed(false);
          setStaleHint(false);
          void io
            .readText(path)
            .then((tf) => {
              setSource(tf.text);
              const r = lift.liftSuggest({ source: tf.text, filePath: path });
              setResult(r);
              setSel(EMPTY_SELECTION);
              setDegrade(r.candidates.length === 0 ? 'empty' : 'scanning');
            })
            .catch((err: unknown) => {
              setError(err instanceof Error ? err.message : String(err));
              setDegrade('scan-error');
            })
            .finally(() => setBusy(false));
        };

        // 文件就绪但还没扫过 → 自动扫一次（面板打开即用，无需额外点击）
        useEffect(() => {
          if (filePath && source === null && !busy && !error) runScan();
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [filePath]);

        /** 应用（两步确认：第一次点击进入"确认"态） */
        const runApply = (): void => {
          if (!filePath || !source || applying) return;
          const chosen = selectedRows(sel, rows);
          if (chosen.length === 0) return;
          if (!armed) {
            setArmed(true);
            return;
          }
          setArmed(false);
          setApplying(true);
          setError(null);
          void applier
            .applyToFile(filePath, {
              source,
              // 只把本插件认得的三类候选传下去（`alias` 不参与替换，见契约）
              candidates: chosen.map(toCandidate),
            })
            .then((res) => {
              setSource(res.preview.text);
              setApplied(
                `✓ 已应用 ${res.appliedCount} 条（${res.byteSize}B）` +
                  (res.backupPath ? ` · 原文件备份：${res.backupPath}` : ''),
              );
              // 应用后重扫：行号已变，旧候选一律作废（不重扫就会出现"错行应用"）
              setResult(null);
              setSel(EMPTY_SELECTION);
              runScan();
            })
            .catch((err: unknown) => {
              setError(err instanceof Error ? err.message : String(err));
            })
            .finally(() => setApplying(false));
        };

        const rows = buildRows(result);
        const shown = rows.slice(0, ROW_CAP);
        const summary = summarizeSelection(sel, rows);
        const chosen = selectedRows(sel, rows);

        /* ------------------------------ 头部 ------------------------------ */

        const head = createElement(
          'div',
          { className: 'lift-toolbar' },
          createElement('span', { className: 'dim' }, '升糖建议器（round-trip 自证 + 双闸写盘）'),
          createElement(
            'button',
            { className: 'ghost small', onClick: runScan, disabled: !filePath || busy },
            busy ? '扫描中…' : '重新扫描',
          ),
        );

        if (!filePath) {
          return createElement('div', { className: 'panel-sugar-lift' }, head,
            createElement('div', { className: 'lift-empty dim' }, degradeText(degrade)));
        }
        if (degrade === 'no-file') {
          return createElement('div', { className: 'panel-sugar-lift' }, head,
            createElement('div', { className: 'lift-empty dim' }, degradeText(degrade)));
        }
        if (error) {
          return createElement('div', { className: 'panel-sugar-lift' }, head,
            createElement('div', { className: 'lift-error' }, `失败：${error}`),
            createElement('div', { className: 'lift-actions' },
              createElement('button', { className: 'ghost small', onClick: runScan }, '重试')));
        }
        if (busy || result === null) {
          return createElement('div', { className: 'panel-sugar-lift' }, head,
            createElement('div', { className: 'lift-empty dim' }, degradeText('scanning')));
        }

        /* ------------------------------ 候选列表 ------------------------------ */

        const listBox = createElement(
          'div',
          { className: 'lift-list' },
          ...shown.map((r) => {
            const on = isSelected(sel, r.key);
            const ign = sel.ignored.has(r.key);
            return createElement(
              'div',
              {
                key: r.key,
                className: `lift-row${on ? ' active' : ''}${ign ? ' ignored' : ''}`,
              },
              createElement('input', {
                type: 'checkbox',
                className: 'lift-check',
                checked: on,
                disabled: ign,
                onChange: () => setSel(toggleRow(sel, r.key)),
              }),
              createElement('span', { className: 'lift-range dim' }, r.rangeLabel),
              createElement('span', { className: 'lift-kind' }, r.kindLabel),
              createElement('span', { className: 'lift-sugar' }, firstLine(r.sugarSource)),
              r.needsAuthorColor
                ? createElement('span', { className: 'lift-warn', title: '应用时会在文件头写入「旁白色: 作者色」' }, '头')
                : null,
              createElement(
                'button',
                {
                  className: 'ghost small',
                  title: ign ? '取消忽略' : '忽略此条',
                  onClick: () => setSel(toggleIgnore(sel, r.key)),
                },
                ign ? '恢复' : '忽略',
              ),
            );
          }),
          rows.length > ROW_CAP
            ? createElement('div', { className: 'dim lift-more' }, `其余 ${rows.length - ROW_CAP} 条未显示`)
            : null,
          rows.length === 0
            ? createElement('div', { className: 'dim lift-empty' }, degradeText('empty'))
            : null,
        );

        const toolbar = createElement(
          'div',
          { className: 'lift-actions' },
          createElement('button', { className: 'ghost small', onClick: () => setSel(selectAll(sel, rows)) }, '全选'),
          createElement('button', { className: 'ghost small', onClick: () => setSel(clearSelection(sel)) }, '全不选'),
          createElement('span', { className: 'dim' },
            `已选 ${summary.selected} / ${summary.total}` +
            (summary.ignored > 0 ? `（忽略 ${summary.ignored}）` : '')),
          summary.needsAuthorColor
            ? createElement('span', { className: 'lift-warn' }, '选中项含「作者色」口径——应用会写文件头')
            : null,
        );

        /* ------------------------------ diff 视图 ------------------------------ */

        // 预览复用后端的纯函数（apply 的 dry-run）：结果与真正应用**必然一致**
        let diffBox: ReturnType<typeof createElement> | null = null;
        if (chosen.length > 0 && source !== null) {
          const src: string = source;
          let lines: ReturnType<typeof buildDiffLines> = [];
          let failure: string | null = null;
          let hunks: readonly SugarLiftDiffHunk[] = [];
          try {
            const preview = applier.apply({ source: src, candidates: chosen.map(toCandidate) });
            lines = buildDiffLines(preview.hunks);
            hunks = preview.hunks;
          } catch (err) {
            failure = err instanceof Error ? err.message : String(err);
          }
          diffBox = createElement(
            'div',
            { className: 'lift-diff' },
            createElement('div', { className: 'lift-diff-head' },
              createElement('span', null, `diff 预览（${chosen.length} 处替换）`),
              createElement('button', {
                className: 'ghost small',
                onClick: () => {
                  // 剪贴板不可用（非安全上下文 / 无权限）是环境限制，静默降级即可
                  void copyText(diffToText(hunks));
                },
              }, '复制 diff')),
            failure
              ? createElement('div', { className: 'lift-error' }, `预览失败：${failure}`)
              : createElement('div', { className: 'lift-diff-body' },
                  ...lines.slice(0, 400).map((l, i) =>
                    createElement('div', { key: `${l.prefix}${l.index}-${i}`, className: `lift-diff-line ${l.prefix === '+' ? 'add' : 'del'}` },
                      createElement('span', { className: 'lift-diff-prefix' }, l.prefix),
                      createElement('span', { className: 'lift-diff-text' }, l.text.length === 0 ? ' ' : l.text)),
                  )),
          );
        }

        /* ------------------------------ 底部：应用 + 未建议 ------------------------------ */

        const skipRows = buildSkipRows(result.skipped).slice(0, SKIP_CAP);

        const footer = createElement(
          'div',
          { className: 'lift-footer' },
          applied ? createElement('div', { className: 'lift-result' }, applied) : null,
          staleHint
            ? createElement('div', { className: 'dim lift-hint' }, '盘上文件已被外部修改——建议「重新扫描」后再应用')
            : null,
          createElement('div', { className: 'lift-apply-row' },
            createElement('button', {
              className: 'primary',
              disabled: chosen.length === 0 || applying,
              onClick: runApply,
            }, applying ? '应用中…' : armed ? '确认写回源文件？' : `应用（${chosen.length} 条）`),
            armed ? createElement('button', { className: 'ghost small', onClick: () => setArmed(false) }, '取消') : null),
          createElement('div', { className: 'dim lift-hint' },
            '应用走与编译落盘同款写链路（编码守卫 → 备份 → 可写白名单 → 回读校验）；应用后会立即重扫。'),
          skipRows.length > 0
            ? createElement('div', { className: 'lift-skips' },
                createElement('div', { className: 'lift-skips-head dim' }, `未建议（${result.skipped.length}）`),
                ...skipRows.map((s) =>
                  createElement('div', { key: s.key, className: 'lift-skip-row' },
                    createElement('span', { className: 'lift-range dim' }, s.rangeLabel),
                    createElement('span', { className: 'lift-skip-reason' }, s.reasonLabel),
                    createElement('span', { className: 'dim lift-skip-msg' }, s.message))))
            : null,
        );

        return createElement('div', { className: 'panel-sugar-lift' },
          head, toolbar, listBox, diffBox, footer);
      }

      ctx.slots.register('ui.panel', {
        id: 'sugar-lift',
        title: '升糖建议',
        icon: '⟰',
        order: 72,
        // UI 重设计批 P1：💡 CodeAction 迁移期的 aux 兜底面板（定稿 §四，稳定后移除）
        location: 'aux',
        defaultActive: false,
        component: LiftPanel,
      });
    },
  };
}

/* ============================== 内部工具 ============================== */

/** `CandidateRow` → 契约候选（应用/预览都只需要这三项：区间 + 糖源码 + 口径） */
function toCandidate(r: CandidateRow): SugarLiftCandidate {
  // 从原始结果里取（`rows` 已丢掉 `roundTrip` 等字段）；此处按 key 反查代价高，
  // 故直接用行数据重建——`apply` 只消费 `kind`/`fromLine`/`toLine`/`sugarSource`/
  // `narrationColor`，其余字段（`roundTrip` 等）仅用于校验原文一致性，
  // 由调用方（`LiftPanel`）保证行数据来自同一份扫描结果。
  return {
    kind: r.kind,
    fromLine: r.fromLine,
    toLine: r.toLine,
    sugarSource: r.sugarSource,
    confidence: 'verified',
    ...(r.needsAuthorColor ? { narrationColor: '作者色' as const } : { narrationColor: '默认' as const }),
    roundTrip: { verified: true, originalText: r.originalText, generatedText: r.sugarSource },
    reason: r.reason,
  };
}

/** 糖源码首行（列表摘要用） */
function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i < 0 ? s : `${s.slice(0, i)} …`;
}

/**
 * 复制到剪贴板（可选能力；不可用时**静默降级**）。
 *
 * 环境限制（非安全上下文 / 无权限 / 非浏览器宿主）不是错误，不该弹错误提示；
 * 之所以不把失败冒泡到渲染路径，是为了"复制"这种次要动作失败时不打断主流程。
 */
async function copyText(text: string): Promise<void> {
  try {
    const nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator;
    const clip = (nav as { clipboard?: { writeText(t: string): Promise<void> } } | undefined)?.clipboard;
    await clip?.writeText(text);
  } catch {
    /* 剪贴板不可用：静默（环境限制，非错误） */
  }
}
