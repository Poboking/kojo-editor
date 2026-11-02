/**
 * 回放面板的**预览层 + 谓词列表**（v1.0 收口 A3 的分层，从 `index.ts` 原样迁出）。
 *
 * 职责：把 `FunctionReplay` 渲染为「状态 → 分支 / 谓词三值 / 未知分组 / 假设标注」。
 * 参数一律显式传入（不闭包面板状态），与 `ui.panel` 壳层（选档 / 选角 / 选函数 /
 * 场景输入）解耦；判定与统计等纯逻辑仍在 `panel-logic.ts`，本层不复制第二份。
 *
 * `PredicateList` 是**模块级组件**（不是面板内部组件）：SSR 单测可直接按 DOM 行数
 * 钉住窗口上界（见 `packages/app/tests/panel-window-state-replay.test.ts`）。
 * 「显示更多」哨兵沿用契约层 `attachGrowSentinel`，className 仍是本面板自己的
 * `rp-more-btn`；窗口口径沿用 `predWindowSize(total, limit, mustInclude)`
 * （它会把定位那一行撑进屏，与通用 `windowSize` **不等价**，勿替换）。
 */

import { createElement, useCallback, useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import type {
  BranchChainOutcome,
  FunctionReplay,
  PluginContextMenuAnchor,
  PredicateReplay,
  QuickEditField,
  ReplayUnknownCode,
  TranscriptLine,
  TranscriptVisibility,
} from '@kojo/plugin-api';
import {
  MORE_ROW_STYLE,
  MORE_ROW_TITLE,
  attachGrowSentinel,
  moreRowLabel,
  shortPath,
} from '@kojo/plugin-api';
import type { AssumedSlot, LocateNotice, ReplayAnalysis, ReplayDiff } from './panel-logic';
import { analyzeReplay, predWindowSize, replaySummarySentence, trWindowSize } from './panel-logic';
/** 置信度徽章样式 */
const CONFIDENCE_BADGE: Record<FunctionReplay['confidence'], { label: string; className: string }> = {
  exact: { label: '确定', className: 'rp-badge conf-exact' },
  partial: { label: '部分未知', className: 'rp-badge conf-partial' },
  unknown: { label: '无法判定', className: 'rp-badge conf-unknown' },
};

const OUTCOME_LABEL: Record<string, string> = { true: '真', false: '假', unknown: '未知' };

/** 分支走向的状态标记（v0.2 第九批） */
const BRANCH_MARK: Record<BranchChainOutcome['outcome'], { mark: string; className: string; title: string }> = {
  taken: { mark: '✓', className: 'rp-branch-mark taken', title: '该状态命中此分支' },
  'no-match': { mark: '∅', className: 'rp-branch-mark nomatch', title: '全部分支条件为假且无兜底（落空）' },
  unknown: { mark: '?', className: 'rp-branch-mark unk', title: '分支条件未知，无法判定走向' },
  unreachable: { mark: '·', className: 'rp-branch-mark unreach', title: '外层分支未进入（不可达）' },
};

/** 跳转源码（source 缺省 = 本插件；谓词行沿用 normalizedName 作为来源标记） */
export type EmitReveal = (filePath: string, line: number, source?: string) => void;
/** 假设值标记的内联样式（插件内自持，不改 app 样式表；虚线 = 与手输确定值视觉可区分） */
export const ASSUME_STYLE = { color: 'var(--amber, #d19a66)', borderColor: 'var(--amber, #d19a66)', borderStyle: 'dashed' } as const;

/* ------------------------------ 谓词窗口 ------------------------------ */

/**
 * 「显示更多」哨兵（谓词列表触底器）。
 *
 * 观察器行为核住在契约层 `sugar-panels` 的 `attachGrowSentinel`（进入滚动视口即
 * 追加下一窗；观察器不可用——SSR / 测试 / 旧环境——时返回空退订 ⇒ 退化为**纯点击
 * 按钮**，功能不丢）。外观三件套（hint 语言样式 / 悬停提示 / 「显示更多（还剩 N）」）
 * 与其余面板同源同值，**className 仍是本面板自己的 `rp-more-btn`**（视觉口径不漂）。
 * ref 用稳定回调 ref 拿真实节点，避免每次渲染重挂 observer；回调只在**触发时**经
 * `onMoreRef` 取最新值（observer 只挂一次，捕获旧闭包 = 窗口行为静默改变）。
 */
function MoreRow({ remaining, onMore }: { remaining: number; onMore: () => void }): ReactElement {
  const anchor = useRef<unknown>(null);
  const setAnchor = useCallback((node: unknown): void => {
    anchor.current = node;
  }, []);
  /** 最新回调引用（observer 只挂一次，不做重复挂卸） */
  const onMoreRef = useRef(onMore);
  onMoreRef.current = onMore;
  useEffect(() => attachGrowSentinel(anchor.current, () => onMoreRef.current()), []);
  return createElement(
    'button',
    {
      ref: setAnchor,
      className: 'ghost small dim rp-more-btn',
      style: MORE_ROW_STYLE,
      title: MORE_ROW_TITLE,
      onClick: () => onMore(),
    },
    moreRowLabel(remaining),
  );
}

/** 谓词列表（窗口化渲染；模块级组件 ⇒ 可独立 SSR 单测 DOM 行数上界） */
export interface PredicateListProps {
  readonly predicates: readonly PredicateReplay[];
  readonly filePath: string;
  /** 跳转来源标记（与旧行为逐字一致：命中函数名） */
  readonly normalizedName: string;
  /** 假设影响标记（与 predicates 同序——`summarizeAssumptions` 的 affected） */
  readonly assumed: readonly boolean[];
  /**
   * 「就是这一行」的位点（G1；null = 本次不是跳转来的）。
   * 有它时窗口至少盖住那一行——跳转来的那一条必须看得见（见 predWindowSize）。
   */
  readonly atLine: number | null;
  /** 当前渲染窗口行数（undefined = 初始窗口） */
  readonly limit: number | undefined;
  /** 触底 / 点击「显示更多」→ 追加一窗（新值由 growWindow(prev, total, PRED_WINDOW) 计算） */
  readonly onGrow: (total: number) => void;
  readonly emitReveal: EmitReveal;
  /**
   * 右键谓词行（1023 批，可选）：交给宿主统一渲染的菜单（跳到行 / 复制谓词）。
   * 缺省 = 没有右键菜单（旧调用方与 SSR 判据零改动）。
   */
  readonly onMenu?: (predicate: PredicateReplay, event: PluginContextMenuAnchor) => void;
  /**
   * 谓词行的中文标注（可选；白话批）——词典命中的变量中文名，跟在原文后作对照。
   * 缺省 = 不标注（旧调用方零改动）；计算在窗口内逐行进行（走窗才有成本）。
   */
  readonly glossOf?: (predicate: PredicateReplay) => string | null;
}

export function PredicateList(props: PredicateListProps): ReactElement {
  const { predicates, atLine } = props;
  // 窗口至少盖住「就是这一行」（findIndex 未命中返回 -1 ⇒ mustInclude = 0）
  const mustInclude = atLine !== null ? predicates.findIndex((p) => p.line === atLine) + 1 : 0;
  const win = predWindowSize(predicates.length, props.limit, mustInclude);
  const glossOf = props.glossOf;
  return createElement(
    'ul',
    { className: 'rp-preds' },
    ...predicates.slice(0, win).map((p, i) => {
      const cls =
        p.outcome.kind === 'true' ? 'rp-outcome hit' : p.outcome.kind === 'false' ? 'rp-outcome miss' : 'rp-outcome unk';
      const isAt = atLine !== null && p.line === atLine;
      const gloss = glossOf ? glossOf(p) : null;
      return createElement(
        'li',
        {
          key: `${p.line}:${i}`,
          ...(props.onMenu === undefined
            ? {}
            : { onContextMenu: (event: PluginContextMenuAnchor) => props.onMenu?.(p, event) }),
        },
        createElement(
          'button',
          {
            className: `rp-pred-btn${isAt ? ' rp-locate-row' : ''}`,
            ...(isAt ? { 'data-locate': '1' } : {}),
            title: `${props.filePath}:${p.line}${p.outcome.kind === 'unknown' ? ` — ${p.outcome.unknown.message}` : ''}`,
            onClick: () => props.emitReveal(props.filePath, p.line, props.normalizedName),
          },
          createElement('span', { className: 'rp-kind' }, p.kind),
          createElement('span', { className: cls }, OUTCOME_LABEL[p.outcome.kind] ?? '?'),
          props.assumed[i]
            ? createElement(
                'span',
                {
                  className: 'rp-badge assume',
                  style: ASSUME_STYLE,
                  title: '该谓词读取了默认场景的假设参数（未手改的预填 0）——结论建立在假设之上',
                },
                '基于假设',
              )
            : null,
          createElement('span', { className: 'rp-pred-text' }, p.text),
          gloss !== null
            ? createElement(
                'span',
                { className: 'rp-pred-gloss dim', title: '条件里变量的中文名（来自游戏词典）' },
                `（${gloss}）`,
              )
            : null,
          createElement('span', { className: 'rp-line dim' }, `:${p.line}`),
        ),
      );
    }),
    predicates.length > win
      ? createElement(
          'li',
          { className: 'rp-more' },
          createElement(MoreRow, {
            key: 'more',
            remaining: predicates.length - win,
            onMore: () => props.onGrow(predicates.length),
          }),
        )
      : null,
  );
}

function branchRow(
  chain: BranchChainOutcome,
  filePath: string,
  emit: EmitReveal,
  key: string,
  renderIcon?: (name: string, size?: number) => unknown,
  /** G1：作者从编辑器跳到这一行时，管辖它的链要标出来（null = 本次不是跳转来的） */
  atLine?: number | null,
): ReturnType<typeof createElement> {
  const mk = BRANCH_MARK[chain.outcome]!;
  const isAt = atLine !== undefined && atLine !== null && (chain.headLine === atLine || chain.members.some((m) => m.line === atLine));
  /** 命中分支的 ✓ 走宿主图标注册表；缺省回退原字形（BRANCH_MARK 数据模型不改） */
  const mark: ReactNode =
    chain.outcome === 'taken' ? ((renderIcon?.('check', 12) as ReactNode | undefined) ?? mk.mark) : mk.mark;
  const takenText = chain.members.find((m) => m.line === chain.takenLine);
  const headText =
    chain.outcome === 'taken'
      ? `${takenText?.kind ?? ''} ${takenText?.text ?? ''}`.trim()
      : chain.members[0]?.kind === 'IF' || chain.members[0]?.kind === 'CASE'
        ? `${chain.members[0]!.kind} ${chain.members[0]!.text}`.trim()
        : chain.kind === 'if-chain'
          ? 'IF …'
          : 'SELECTCASE …';
  return createElement(
    'div',
    {
      key,
      className: `rp-branch-row ${chain.outcome}${isAt ? ' rp-locate-row' : ''}`,
      style: { paddingLeft: `${chain.depth * 14 + 2}px` },
      ...(isAt ? { 'data-locate': '1' } : {}),
    },
    createElement('span', { className: mk.className, title: mk.title }, mark),
    createElement(
      'button',
      {
        className: 'rp-branch-btn',
        title: `${filePath}:${chain.takenLine ?? chain.headLine} — ${mk.title}`,
        onClick: () => emit(filePath, chain.takenLine ?? chain.headLine),
      },
      createElement('span', { className: 'rp-branch-head' }, headText),
      createElement('span', { className: 'rp-branch-taken dim' }, chain.takenLine ? ` → :${chain.takenLine}` : ''),
    ),
  );
}

/**
 * 预览层（v1.0 收口 A3）：把 `FunctionReplay` 渲染为"状态 → 分支 / 文本预览"。
 *
 * 职责分工：本层只做**状态 → 预览**（分支走向 + 谓词三值 + 未知分组 + 假设标注）；
 * 将来的语法糖预览复用 `preview.renderer`（ARCHITECTURE §5.4）产出的
 * `PreviewLines[]` 渲染文本，**不自建渲染逻辑**。参数显式传入（不闭包面板状态），
 * 与 ui.panel 壳层（选档 / 选角 / 选函数 / 输入）解耦——纯逻辑复用则下沉到
 * `panel-logic.ts`（`summarizeAssumptions` 等）。
 */
/**
 * 台词推演的可见性徽章（口上调试统一批）。措辞白话：作者面说"会显示 / 不显示 /
 * 可能"，不说 shown / hidden / maybe。
 */
const TR_MARK: Record<TranscriptVisibility, { label: string; className: string; hint: string }> = {
  shown: { label: '会显示', className: 'rp-tr-mark shown', hint: '这个状态下这句话会出现在消息窗里' },
  hidden: { label: '不显示', className: 'rp-tr-mark hidden', hint: '这个状态下这句话不会出现' },
  maybe: { label: '可能', className: 'rp-tr-mark maybe', hint: '有条件判不出——这句话可能出现也可能不出现' },
};

/**
 * 台词推演列表（消息窗视角）：每条 PRINT 行"会不会显示 + 显示什么"。
 * `hidden` 行划线呈现原文（点行号可回源）；判不出的插值在引擎侧已落成
 * `%?%` 占位（诚实边界，不猜）；「A／B」= 行内三元选不出，两支都可能。
 *
 * 视觉（2026-11-02 美化批）：头部给"几句会显示"的计数 chip，行分三列（徽章 / 文本 /
 * 行号），行号常驻但很淡、hover 才亮——它是"回源"的把手，不该抢正文的注意力。
 */
export function TranscriptList(props: {
  lines: readonly TranscriptLine[];
  filePath: string;
  emitReveal: EmitReveal;
  atLine?: number | null;
  /**
   * 渲染窗口（可选；2026-11-02 美化批）。缺省 = 全渲染（旧调用方与单测零改动）。
   * 给了 `onGrow` 才启用窗口：首屏 `TR_WINDOW.initial` 行 + 触底/点击追加。
   */
  limit?: number;
  onGrow?: (total: number) => void;
}): ReactElement {
  const shownCount = props.lines.filter((t) => t.visibility === 'shown').length;
  const maybeCount = props.lines.filter((t) => t.visibility === 'maybe').length;
  // 窗口必须盖住「就是这一行」（从编辑器跳进来的那条不能在屏外）——与谓词区同口径
  const mustInclude =
    props.onGrow === undefined || props.atLine == null
      ? 0
      : props.lines.findIndex((t) => t.line === props.atLine) + 1;
  const win = props.onGrow === undefined ? props.lines.length : trWindowSize(props.lines.length, props.limit, mustInclude);
  const rest = props.lines.length - win;
  return createElement(
    'div',
    { className: 'rp-transcript' },
    createElement(
      'div',
      { className: 'rp-tr-head' },
      createElement('span', { className: 'rp-section-title' }, '这段会说的话'),
      createElement('span', { className: 'rp-tr-count' }, `${shownCount}/${props.lines.length} 行会显示`),
      maybeCount > 0 ? createElement('span', { className: 'rp-tr-count maybe' }, `${maybeCount} 行判不出`) : null,
    ),
    // 边界必须写在脸上：只推这一段自己的 PRINT 行。CALL 出去的段、PRINTDATA 随机块、
    // 循环体的多次执行都不在推演范围内——不写明就会让作者以为"没显示 = 不会说"。
    createElement(
      'div',
      { className: 'rp-tr-note' },
      '只推这一段自己的输出行：CALL 出去的段、PRINTDATA 随机块、循环体的多次执行暂不推演。',
    ),
    createElement(
      'div',
      { className: 'rp-tr-body' },
      ...props.lines.slice(0, win).map((t, i) => {
        // 空载荷（裸 `PRINTL` / 只输出换行）也要有个字面落点：只挂一枚徽章的空行
        // 读起来像渲染坏了。`（空行）` 是灰注脚，不参与"会说的话"的视觉权重。
        const body = t.visibility === 'hidden' ? t.payload : t.text;
        const blank = body.trim().length === 0;
        return createElement(
          'div',
          {
            key: `${t.line}:${i}`,
            className: `rp-tr-row ${t.visibility}`,
            'data-locate': props.atLine != null && t.line === props.atLine ? '1' : undefined,
          },
          createElement(
            'span',
            { className: TR_MARK[t.visibility].className, title: TR_MARK[t.visibility].hint },
            TR_MARK[t.visibility].label,
          ),
          createElement(
            'span',
            { className: 'rp-tr-text' },
            blank
              ? createElement('span', { className: 'rp-tr-blank' }, '（空行）')
              : t.visibility === 'hidden'
                ? createElement('span', { className: 'rp-tr-hidden' }, body)
                : body,
            !blank && t.visibility !== 'hidden' && t.unresolved > 0
              ? createElement('span', { className: 'rp-tr-unresolved' }, `${t.unresolved} 处判不出`)
              : null,
            t.reason && t.visibility !== 'shown'
              ? createElement('span', { className: 'rp-tr-reason', title: t.reason.message }, t.reason.message)
              : null,
          ),
          createElement(
            'button',
            {
              className: 'rp-tr-line',
              onClick: () => props.emitReveal(props.filePath, t.line),
              title: `${t.verb} · 在编辑器里打开第 ${t.line} 行`,
            },
            `${t.line}`,
          ),
        );
      }),
      // 触底/点击追加一窗（与谓词区同一枚哨兵组件、同一套口径）
      rest > 0 && props.onGrow !== undefined
        ? createElement(
            'div',
            { className: 'rp-tr-more' },
            createElement(MoreRow, {
              key: 'more',
              remaining: rest,
              onMore: () => props.onGrow?.(props.lines.length),
            }),
          )
        : null,
    ),
  );
}

/**
 * 注入预演面板（2026-11-02 美化批：从面板壳层 `index.ts` 抽出）。
 *
 * 为什么抽出来：它是纯呈现（全部状态与回调由壳层持有），抽出来才能 SSR 单测与
 * 视觉预览；留在壳层里就只能靠"打开真面板、恰好有存档"才能看到。
 *
 * 视觉分层：表单（改哪个值）→ 结论（这次改动会怎样）→ diff 明细 → 危险动作（写入）
 * 靠右下角且需二次确认。**预演是主按钮、写入是危险动作**——顺序与权重都在说这件事。
 */
export function DebugPreviewPanel(props: {
  quickFields: readonly QuickEditField[];
  fieldId: string;
  value: string;
  busy: boolean;
  canRun: boolean;
  canWrite: boolean;
  error: string | null;
  diff: ReplayDiff | null;
  diffSummary: string | null;
  writeArmed: boolean;
  writeNote: string | null;
  onFieldChange: (id: string) => void;
  onValueChange: (value: string) => void;
  onPreview: () => void;
  onWriteClick: () => void;
}): ReactElement {
  const selected = props.quickFields.find((f) => f.id === props.fieldId) ?? null;
  const diffRows: ReactElement[] = [];
  if (props.diff) {
    for (const t of props.diff.added.slice(0, 12)) {
      diffRows.push(
        createElement(
          'div',
          { key: `a${t.line}`, className: 'rp-diff-row add' },
          createElement('span', { className: 'rp-diff-sign' }, '+'),
          createElement('span', { className: 'rp-diff-line' }, `${t.line}`),
          createElement('span', { className: 'rp-diff-text' }, t.text || t.payload),
        ),
      );
    }
    for (const t of props.diff.removed.slice(0, 12)) {
      diffRows.push(
        createElement(
          'div',
          { key: `r${t.line}`, className: 'rp-diff-row remove' },
          createElement('span', { className: 'rp-diff-sign' }, '−'),
          createElement('span', { className: 'rp-diff-line' }, `${t.line}`),
          createElement('span', { className: 'rp-diff-text' }, t.payload),
        ),
      );
    }
  }
  const moreCount = props.diff ? props.diff.added.length + props.diff.removed.length - diffRows.length : 0;

  return createElement(
    'section',
    { className: 'rp-debug' },
    createElement(
      'div',
      { className: 'rp-tr-head' },
      createElement('span', { className: 'rp-section-title' }, '换个数值试试'),
      createElement('span', { className: 'rp-debug-sub' }, '先在内存里改，存档不动'),
    ),
    createElement(
      'div',
      { className: 'rp-debug-form' },
      createElement(
        'select',
        {
          className: 'rp-select rp-debug-field',
          value: props.fieldId,
          onChange: (e: { target: { value: string } }) => props.onFieldChange(e.target.value),
        },
        createElement('option', { value: '' }, '挑一个要改的数值'),
        ...props.quickFields.map((f) =>
          createElement(
            'option',
            { key: f.id, value: f.id },
            `${f.label}（${f.family}:${f.index}${f.scope === 'global' ? ' · 全局' : ''}）`,
          ),
        ),
      ),
      createElement('input', {
        className: 'rp-slot-input rp-debug-value',
        type: 'text',
        value: props.value,
        placeholder: selected ? `新值（现在是 ${selected.label}）` : '新值',
        onChange: (e: { target: { value: string } }) => props.onValueChange(e.target.value),
        onKeyDown: (e: { key: string }) => {
          if (e.key === 'Enter') props.onPreview();
        },
      }),
      createElement(
        'button',
        {
          className: 'primary small',
          disabled: props.busy || !props.canRun,
          onClick: props.onPreview,
          title: '在内存里改这个值，看看这段会变成什么样（存档不动）',
        },
        props.busy ? '推演中…' : '预演',
      ),
    ),
    props.error !== null ? createElement('div', { className: 'rp-error rp-debug-msg' }, props.error) : null,
    props.diff !== null
      ? createElement(
          'div',
          { className: 'rp-debug-result' },
          createElement(
            'div',
            { className: `rp-diff-summary${props.diffSummary === null ? ' quiet' : ''}` },
            props.diffSummary !== null ? `这次改动：${props.diffSummary}。` : '这次改动对这一段没有影响。',
          ),
          diffRows.length > 0 ? createElement('div', { className: 'rp-diff-list' }, ...diffRows) : null,
          moreCount > 0 ? createElement('div', { className: 'rp-diff-more' }, `还有 ${moreCount} 行没列出`) : null,
        )
      : null,
    props.writeNote !== null ? createElement('div', { className: 'rp-debug-msg dim' }, props.writeNote) : null,
    createElement(
      'div',
      { className: 'rp-debug-foot' },
      props.writeArmed
        ? createElement('span', { className: 'rp-debug-warn' }, '再点一次「确认写入」就会落盘（写前自动备份）。')
        : createElement('span', { className: 'rp-debug-sub' }, '写入会改存档文件，先备份原文件。'),
      createElement(
        'button',
        {
          className: props.writeArmed ? 'small danger armed' : 'small danger',
          disabled: props.busy || !props.canWrite,
          onClick: props.onWriteClick,
          title: '把预演的值真正写进存档（写前自动备份；写完本面板自动重算）',
        },
        props.writeArmed ? '确认写入' : '写入存档',
      ),
    ),
  );
}

export function renderReplayPreview(opts: {
  result: FunctionReplay;
  assumedSlots: readonly AssumedSlot[];
  emitReveal: EmitReveal;
  renderIcon?: (name: string, size?: number) => unknown;
  /** 「就是这一行」的横幅（G1；null = 本次不是从编辑器跳进来的，呈现与旧行为逐字一致） */
  notice?: LocateNotice | null;
  /** 谓词渲染窗口（undefined = 初始窗口）与触底增窗回调（窗口状态归面板壳层持有） */
  predLimit: number | undefined;
  onGrowPreds: (total: number) => void;
  /**
   * 台词推演区的渲染窗口与增窗回调（可选；2026-11-02 美化批）。
   * 缺省 = 全渲染——旧调用方与单测零改动（additive）。
   */
  trLimit?: number;
  onGrowTranscript?: (total: number) => void;
  /** 右键谓词行（可选；1023 批）——透传给 `PredicateList` */
  onPredicateMenu?: (predicate: PredicateReplay, event: PluginContextMenuAnchor) => void;
  /** 谓词行中文标注（可选；白话批）——透传给 `PredicateList`（词典命中变量中文名） */
  glossOf?: (predicate: PredicateReplay) => string | null;
  /**
   * 面板算好的只读统计（PS-7：`analyzeReplay` 的记忆化产物）。
   * 给了就直接用；没给（如单测与别的调用方）就地算——呈现结果逐字相同。
   */
  analysis?: ReplayAnalysis | null;
}): ReturnType<typeof createElement> {
  const { result, assumedSlots, emitReveal, renderIcon, notice, predLimit, onGrowPreds } = opts;
  const conf = CONFIDENCE_BADGE[result.confidence];
  const analysis = opts.analysis ?? analyzeReplay(result, assumedSlots);
  const unknowns = analysis.unknowns;
  const impact = analysis.impact;
  /** 高亮只给**对得上来源**的那一次（对不上时不许画出假的"就是这一行"） */
  const atLine = notice && notice.hasRows ? notice.line : null;

  // 「这一行」横幅：结论一句话 + 徽章，放在汇总行之前（作者要的正是这一句）
  const noticeBanner = notice
    ? createElement(
        'div',
        { className: 'rp-locate', role: 'status' },
        createElement('span', { className: notice.className }, notice.badge),
        createElement('span', { className: 'rp-locate-text' }, notice.sentence),
      )
    : null;

  // 假设参数汇总（C9 附加）：分支折叠结果区一眼可见的可信度提示
  const assumptionSummary =
    impact.consumed.length > 0
      ? createElement(
          'span',
          {
            className: 'rp-badge assume',
            style: ASSUME_STYLE,
            title: '命中判定用到了默认场景的假设参数（未被手改的预填 0，未必等于引擎真实默认）——请核对场景参数',
          },
          `本结果含 ${impact.consumed.length} 个假设参数`,
        )
      : null;

  // 分支折叠结果区：链走向 + 假设汇总（无链但有假设影响时也显式提示，不静默）
  const branchSection =
    result.branches.length > 0
      ? createElement(
          'div',
          { className: 'rp-branches' },
          createElement(
            'div',
            { className: 'dim rp-branches-head' },
            `分支走向（${result.branches.length} 条链）`,
            assumptionSummary,
          ),
          ...result.branches.map((b, i) =>
            branchRow(b, result.filePath, emitReveal, `b${b.headLine}:${i}`, renderIcon, atLine),
          ),
        )
      : assumptionSummary
        ? createElement(
            'div',
            { className: 'rp-branches' },
            createElement('div', { className: 'dim rp-branches-head' }, assumptionSummary),
          )
        : null;

  // 台词推演区（口上调试统一批；additive）：引擎附了 transcript 才渲染，
  // 缺省（旧引擎 / 行文本不可得）整个区不出现——消费方按缺省降级。
  const transcriptSection =
    result.transcript && result.transcript.length > 0
      ? createElement(TranscriptList, {
          lines: result.transcript,
          filePath: result.filePath,
          emitReveal,
          atLine,
          ...(opts.trLimit === undefined ? {} : { limit: opts.trLimit }),
          ...(opts.onGrowTranscript === undefined ? {} : { onGrow: opts.onGrowTranscript }),
        })
      : null;

  return createElement(
    'div',
    { className: 'rp-result' },
    noticeBanner,
    // 白话摘要（白话批）：徽章行数字之前先给一句结论（措辞对齐 describeReading）
    createElement('div', { className: 'rp-plain dim' }, replaySummarySentence(result)),
    createElement(
      'div',
      { className: 'rp-summary' },
      createElement('span', { className: conf.className }, conf.label),
      createElement('span', { className: 'rp-count hit' }, `命中 ${result.stats.hit}`),
      createElement('span', { className: 'rp-count miss' }, `未命中 ${result.stats.miss}`),
      createElement('span', { className: 'rp-count unk' }, `未知 ${result.stats.unknown}`),
      createElement(
        'span',
        { className: 'dim rp-meta' },
        `共 ${result.stats.total} 谓词 · ${shortPath(result.filePath)}:${result.startLine}`,
      ),
    ),
    branchSection,
    transcriptSection,
    unknowns.length > 0
      ? createElement(
          'div',
          { className: 'rp-unknowns' },
          createElement('span', { className: 'dim' }, '判不出的原因：'),
          ...unknowns.map((u) =>
            createElement(
              'span',
              { key: u.code, className: 'rp-badge unk', title: UNKNOWN_HINT[u.code] ?? u.code },
              `${UNKNOWN_HINT[u.code] ?? u.code} ${u.count}`,
            ),
          ),
        )
      : null,
    createElement(PredicateList, {
      predicates: result.predicates,
      filePath: result.filePath,
      normalizedName: result.normalizedName,
      assumed: impact.affected,
      atLine,
      limit: predLimit,
      onGrow: onGrowPreds,
      emitReveal,
      ...(opts.onPredicateMenu === undefined ? {} : { onMenu: opts.onPredicateMenu }),
      ...(opts.glossOf === undefined ? {} : { glossOf: opts.glossOf }),
    }),
  );
}

/**
 * 未知原因的中文短句（按 code；与 replay.ts 的分类一一对应）。
 *
 * 2026-11-02 白话批：旧词表是工程口径（「调用上下文未提供」「本地量无可见赋值」），
 * 零基础作者读不出因果。全部改成「为什么判不出 + 该怎么办」的白话；机器码仍在
 * 徽章的 title 里留档（悬停可见），不丢排障能力。
 *
 * **类型就是穷尽闸**（KW-28 1103）：这张表此前挂在 `Record<string, string>` 上——
 * 新增一枚机器码忘了配文案，编译期一声不响，屏上直接露出 `local-range` 这种工程词
 * （组长实测过的形状）。改成 `Record<ReplayUnknownCode, string>` 后少一格就 typecheck 红；
 * 运行期那把同源尺在 `tests/unknown-hint-exhaustive.test.ts`（键表从契约联合现算，不抄第二份）。
 */
export const UNKNOWN_HINT: Record<ReplayUnknownCode, string> = {
  opaque: '这段写法看不懂',
  call: '调用了别的函数，存档里看不出来',
  builtin: '用了内置函数，存档里算不出来',
  rename: '用了改名记号，对应关系不在存档里',
  pseudo: '用到了运行中才有的值（比如随机数）',
  'local-no-write': '这个临时量在存档里没留下数值',
  'local-range': '循环变量有好几种可能的取值，这几种判出来的结果不一样',
  // KW-28 判性：这一族不是"谁忘了给参数"，而是**本次调用的实参根本不在存档里**
  // （真语料 K49 × save03 实测 858 枚 / 131 个函数，同一路由键的转发实参在各调用点取值不同）。
  // 旧短句只说"没告诉它"，作者会去找一个并不存在的"告诉"入口；白话批的口径是「为什么 + 该怎么办」，
  // 所以这里补上那半句——面板里那格可以手填（填了就是作者给的场景值，引擎仍不猜）。
  'call-context': '这一格要看它是被谁、带着什么调进来的，存档里没有；知道场景就在「场景参数」里填这一格',
  'dynamic-index': '下标是算出来的，看不出指哪一格',
  'named-index': '下标名字认不出来',
  'missing-var': '存档里没有这个变量',
  'index-oob': '下标超出了存档范围',
  truncated: '存档里这格数据被截断了',
  type: '类型对不上',
  'divide-by-zero': '除以零',
  'too-many-args': '参数过多',
  'string-compare': '文本比大小，存档里定不了',
  'non-numeric': '结果不是数字',
  other: '其它',
};
