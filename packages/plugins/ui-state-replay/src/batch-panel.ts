/**
 * 批量体检的**展示层**（React 组件，`createElement` 手写，零 JSX、零服务依赖）。
 *
 * 组件不碰引擎 / 存档 / 索引：所有数据从 props 来（`busy` / `progress` /
 * `summary` / `error` / 回调），因此可以单独 SSR 或直接喂合成数据测。
 * 视觉只用面板既有的 class（`dbg-sec` / `dbg-row` / `ghost small` / `dim` /
 * `rp-hint` / `rp-badge conf-*` …），不新增 CSS 文件、不改 app 样式表；
 * 需要微调布局的一律内联 style。
 *
 * 渲染结构（自上而下）：
 * 1. 段头：标题 + 进度文案（`已扫描 x/y`）；
 * 2. 操作行：「体检」/「取消」（busy 时切换）+ 按钮旁的状态说明；
 * 3. 汇总行：完全判定 / 部分 / 全未知 / 判不出的谓词数 / 缺失数；
 * 4. 最该看的段落列表（每行：函数名按钮 + 置信度徽章 + `未知 x/y`）；
 * 5. 取消 / 截断 / 缺失的显式说明；空态与错误态同样显式。
 *
 * `summary === null && !busy` 时不渲染列表（空态代替）；`summary` 有值时
 * 列表只展示 `summary.rows`（即引擎侧排好序、截断过的最该看的前 N 条）。
 */

import { createElement, type ReactElement } from 'react';
import type { BatchRow, BatchSummary } from './batch';

/** 置信度徽章（与 `preview.ts` 同款 class，不复制新样式） */
const CONFIDENCE_BADGE: Record<BatchRow['confidence'], { readonly label: string; readonly className: string }> = {
  exact: { label: '确定', className: 'rp-badge conf-exact' },
  partial: { label: '部分未知', className: 'rp-badge conf-partial' },
  unknown: { label: '无法判定', className: 'rp-badge conf-unknown' },
};

/** 行内小结的 flex 容器样式（插件内自持，不改样式表） */
const SUMMARY_ROW_STYLE = { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '8px' } as const;
const LIST_STYLE = { display: 'flex', flexDirection: 'column', gap: '4px' } as const;
const LIST_ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '6px' } as const;

export interface BatchPanelProps {
  /** 正在跑（按钮切成「取消」，进度文案持续更新） */
  readonly busy: boolean;
  /** 进度（`done/total`；null = 还没跑过，不显示进度文案） */
  readonly progress: { readonly done: number; readonly total: number } | null;
  /** 上一轮 / 本轮的汇总（null = 还没有结果，不渲染列表） */
  readonly summary: BatchSummary | null;
  /** 显式错误（不静默：有错就显示，不拿空态糊过去） */
  readonly error: string | null;
  /** 现在能不能发起体检（缺存档 / 缺角色 / 缺函数名时为 false） */
  readonly canRun: boolean;
  /** 「体检」按钮文案（由面板决定，如「体检这批段落」） */
  readonly runLabel: string;
  /** 点「体检」 */
  onRun(): void;
  /** 点「取消」 */
  onCancel(): void;
  /** 点列表里的函数名 → 回填函数名并判定 */
  onPickFunction(name: string): void;
  /** 段标题（缺省「批量体检」） */
  readonly title?: string;
  /** 不忙时「体检」按钮的悬停提示（缺省给通用说明） */
  readonly runHint?: string;
  /** 忙时「取消」按钮的悬停提示（缺省说明已扫描部分会保留） */
  readonly cancelHint?: string;
  /** 空态说明（缺省给通用说明） */
  readonly emptyNote?: string;
}

/** 一行「最该看的段落」：函数名按钮 + 徽章 + 未知 x/y */
function WorstRow(props: { readonly row: BatchRow; readonly onPick: (name: string) => void }): ReactElement {
  const { row } = props;
  const badge = CONFIDENCE_BADGE[row.confidence];
  const ratioText = row.total > 0 ? `判不出 ${Math.round(row.unknownRatio * 100)}%` : '无谓词';
  return createElement(
    'div',
    { className: 'dbg-row', style: LIST_ROW_STYLE },
    createElement(
      'button',
      {
        className: 'ghost small',
        style: { textAlign: 'left' },
        title: `回填「${row.name}」并判定`,
        onClick: () => props.onPick(row.name),
      },
      row.name,
    ),
    createElement('span', { className: badge.className }, badge.label),
    createElement(
      'span',
      { className: 'dim', title: ratioText },
      row.total > 0 ? `未知 ${row.unknown}/${row.total}` : '无谓词',
    ),
  );
}

/** 汇总行（完全判定 / 部分 / 全未知 / 判不出的谓词数 + 缺失数） */
function SummaryLine(props: { readonly summary: BatchSummary }): ReactElement {
  const s = props.summary;
  return createElement(
    'div',
    { className: 'dbg-row', style: SUMMARY_ROW_STYLE },
    createElement('span', { className: 'rp-count hit' }, `完全判定 ${s.exact}`),
    createElement('span', { className: 'dim' }, `部分 ${s.partial}`),
    createElement('span', { className: 'rp-count unk' }, `全未知 ${s.unknown}`),
    createElement(
      'span',
      { className: 'dim', title: '所有已扫描段落里判不出的条件数 / 条件总数' },
      `判不出的谓词 ${s.unknownPredicates}/${s.totalPredicates}`,
    ),
    s.missing > 0 ? createElement('span', { className: 'dim' }, `回放不了 ${s.missing}`) : null,
    createElement('span', { className: 'dim' }, `已扫描 ${s.scanned}/${s.requested}`),
  );
}

export function BatchPanel(props: BatchPanelProps): ReactElement {
  const { busy, progress, summary, error, canRun, runLabel } = props;

  const actionButton = busy
    ? createElement(
        'button',
        {
          className: 'ghost small',
          title: props.cancelHint ?? '停止本次体检；已扫描的部分会保留并照常汇总',
          onClick: props.onCancel,
        },
        '取消',
      )
    : createElement(
        'button',
        {
          className: 'ghost small',
          disabled: !canRun,
          title: props.runHint ?? '逐段回放，汇总哪些段落完全判定 / 部分 / 全未知',
          onClick: props.onRun,
        },
        runLabel,
      );

  const progressText =
    progress !== null
      ? `已扫描 ${progress.done}/${progress.total}`
      : busy
        ? '正在准备…'
        : null;

  const notes: ReturnType<typeof createElement>[] = [];
  if (summary !== null) {
    if (summary.cancelled) {
      notes.push(createElement('div', { key: 'cancelled', className: 'dbg-note' }, '已取消：下面是已扫描部分的汇总。'));
    }
    if (summary.remaining > 0) {
      notes.push(
        createElement(
          'div',
          { key: 'remaining', className: 'dbg-note dim' },
          `超出单次体检上限，还有 ${summary.remaining} 个函数没回放。`,
        ),
      );
    }
    if (summary.scanned > summary.rows.length) {
      notes.push(
        createElement(
          'div',
          { key: 'truncated', className: 'dbg-note dim' },
          `列表只列最该看的 ${summary.rows.length} 条（共 ${summary.scanned} 段有结果）。`,
        ),
      );
    }
  }

  const resultBlock =
    summary === null
      ? null
      : createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          createElement(SummaryLine, { summary }),
          summary.rows.length > 0
            ? createElement(
                'div',
                null,
                createElement('div', { className: 'rp-section-title' }, '最该看的段落'),
                createElement(
                  'div',
                  { style: LIST_STYLE },
                  ...summary.rows.map((row, i) =>
                    createElement(WorstRow, { key: `${row.name}#${i}`, row, onPick: props.onPickFunction }),
                  ),
                ),
              )
            : createElement(
                'div',
                { className: 'dbg-note' },
                summary.missing > 0
                  ? `这轮没有可展示的段落：${summary.missing} 个函数回放不了（不存在 / 没有条件索引 / 单次回放失败）。`
                  : '这轮没有可展示的段落。',
              ),
          ...notes,
        );

  const emptyBlock =
    summary === null && !busy
      ? createElement(
          'div',
          { className: 'dbg-empty' },
          createElement('div', { className: 'dbg-empty-title' }, '尚未体检'),
          createElement(
            'div',
            { className: 'dbg-empty-note' },
            props.emptyNote ??
              '选好存档与角色后点上面的按钮：会逐个回放并汇总完全判定 / 部分 / 全未知，以及最该看的段落。',
          ),
        )
      : null;

  return createElement(
    'section',
    { className: 'dbg-sec' },
    createElement(
      'div',
      { className: 'dbg-sec-head' },
      createElement('span', { className: 'dbg-sec-title' }, props.title ?? '批量体检'),
      progressText !== null ? createElement('span', { className: 'dbg-sec-note' }, progressText) : null,
    ),
    createElement(
      'div',
      { className: 'dbg-row', style: { alignItems: 'center', gap: '8px' } },
      actionButton,
      busy ? createElement('span', { className: 'dim rp-hint' }, '正在逐段回放…（可随时取消，已扫描部分保留）') : null,
    ),
    error !== null ? createElement('div', { className: 'rp-error' }, error) : null,
    resultBlock,
    emptyBlock,
    // summary 有值、但既无行也无可解释原因时也给出显式说明（上面的 resultBlock 已覆盖）
  );
}
