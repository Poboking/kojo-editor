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
import type { BranchChainOutcome, FunctionReplay, PredicateReplay } from '@kojo/plugin-api';
import {
  MORE_ROW_STYLE,
  MORE_ROW_TITLE,
  attachGrowSentinel,
  moreRowLabel,
  shortPath,
} from '@kojo/plugin-api';
import type { AssumedSlot, LocateNotice, ReplayAnalysis } from './panel-logic';
import { analyzeReplay, predWindowSize } from './panel-logic';
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
}

export function PredicateList(props: PredicateListProps): ReactElement {
  const { predicates, atLine } = props;
  // 窗口至少盖住「就是这一行」（findIndex 未命中返回 -1 ⇒ mustInclude = 0）
  const mustInclude = atLine !== null ? predicates.findIndex((p) => p.line === atLine) + 1 : 0;
  const win = predWindowSize(predicates.length, props.limit, mustInclude);
  return createElement(
    'ul',
    { className: 'rp-preds' },
    ...predicates.slice(0, win).map((p, i) => {
      const cls =
        p.outcome.kind === 'true' ? 'rp-outcome hit' : p.outcome.kind === 'false' ? 'rp-outcome miss' : 'rp-outcome unk';
      const isAt = atLine !== null && p.line === atLine;
      return createElement(
        'li',
        { key: `${p.line}:${i}` },
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

  return createElement(
    'div',
    { className: 'rp-result' },
    noticeBanner,
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
    unknowns.length > 0
      ? createElement(
          'div',
          { className: 'rp-unknowns' },
          createElement('span', { className: 'dim' }, '未知原因：'),
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
    }),
  );
}

/** 未知原因的中文提示（按 code；与 replay.ts 的分类一一对应） */
const UNKNOWN_HINT: Record<string, string> = {
  opaque: '表达式未解析',
  call: '函数调用不可求值',
  builtin: '内置函数无法求值',
  rename: 'rename 词',
  pseudo: '伪变量/运行期值',
  'local-no-write': '本地量无可见赋值',
  'call-context': '调用上下文未提供',
  'dynamic-index': '动态索引',
  'named-index': '具名索引无法解析',
  'missing-var': '快照中无此变量',
  'index-oob': '索引越界',
  truncated: '数组单元被截断',
  type: '类型不匹配',
  'divide-by-zero': '除零',
  'too-many-args': '参数过多',
  'string-compare': '字符串序比较',
  'non-numeric': '结果非数值',
  other: '其它',
};
