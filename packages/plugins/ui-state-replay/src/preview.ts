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
import { analyzeReplay, predWindowSize, replaySummarySentence, sameSourcePath, trWindowSize } from './panel-logic';
import {
  PREDICATE_FILTER_LABEL,
  availableFilters,
  filterPredicates,
  type PredicateCounts,
  type PredicateFilter,
  type PredicateFilterKind,
} from './predicate-filter';
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
/** 筛选档位选中态（不新增 class：app 样式表里没有本面板的 class，内联最稳） */
const FILTER_ACTIVE_STYLE = { fontWeight: 600, color: 'var(--fg, inherit)', borderColor: 'var(--accent, #61afef)' } as const;

/* ---------------- 判定口径：编辑器缓冲文本 / 未建模写（纯函数，可单测） ----------------
 *
 * 2026-11-05「状态回放彻底可用」批：判定不再只能读**磁盘**文件——宿主广播
 * `editor.documentChanged` 给出编辑器缓冲的最新文本，同一份未保存的编辑可以直接判。
 *
 * 口径收在这里成一个纯函数（不在面板壳层里散着三个 if）：
 * - 判定目标文件与缓冲文件**不一定是同一份**（`nb.info().filePath` / `result.filePath`
 *   各拿各的字符串，分隔符与大小写不保证一致 → 判等走 `sameSourcePath`，与定位同款）；
 * - `dirty === false` 时不传 override（省一次解析；两份文本此时逐字相同）；
 * - 拿不准（没有缓冲 / 不是同一份 / 目标是空的）→ 一律退回磁盘文本，**不猜**。
 *
 * 结果区必须把这次用的是哪份文本说出来（`textSourceLabel`）——"为什么我改的字没生效"
 * 与"我明明没保存怎么判的是新文本"是同一枚硬币的两面，不标就是撒谎。
 */

/** 编辑器缓冲文本的一条真相（宿主 `editor.documentChanged` 载荷的子集，够用即取） */
export interface BufferedDoc {
  filePath: string;
  text: string;
  dirty: boolean;
}

/** 本次判定用的文本来源 */
export type ReplayTextSource = 'buffer' | 'disk';

/** 文本来源裁决结果（`source` 决定结果区那句口径标记） */
export interface ReplayTextChoice {
  /** 交给引擎的 `textOverride`（仅 `source === 'buffer'` 时有值） */
  textOverride?: string;
  source: ReplayTextSource;
  /**
   * 裁决理由（不静默）：
   * - `buffer-dirty`：同文件、且广播说缓冲与盘不同步（有未保存编辑）→ 用缓冲文本；
   * - `buffer-clean`：同文件、手里有缓冲文本但广播的 `dirty` 是 false → **照样用缓冲文本**；
   * - `other-file`：缓冲文本属于别的文件 → 只认磁盘；
   * - `no-buffer`：还没收到任何缓冲广播（或不知道该判哪个文件）。
   *
   * 为什么 `dirty=false` 也照样传（2026-11-05 口径修正，评审 + 宿主取证共同结论）：
   * 宿主的 `dirty` 是"上一次广播那一刻"的快照——**保存后文本没变不会重播**，300ms
   * 防抖窗口内刚敲的字也还没广播。拿一个可能滞后的 `dirty=false` 去跳过 `textOverride`，
   * 就会让引擎读**旧盘**，等于"未保存编辑不算数"原样复现。缓冲文本与盘相同传过去也无害；
   * 所以判据只认**文件身份**，不拿脏标记当门。
   */
  reason: 'buffer-dirty' | 'buffer-clean' | 'other-file' | 'no-buffer';
}

/**
 * 选这次判定用哪份文本。`targetPath` = 待判定函数所在文件（不知道就传 null）。
 * `opts.ignoreDirty = false` 可退回旧口径（同文件但 `dirty=false` 时用磁盘）——只给
 * 对拍 / 调试用；生产一律走"同文件就用缓冲"。
 */
export function chooseReplayText(
  targetPath: string | null | undefined,
  buffered: BufferedDoc | null | undefined,
  opts: { ignoreDirty?: boolean } = {},
): ReplayTextChoice {
  if (!buffered) return { source: 'disk', reason: 'no-buffer' };
  if (typeof targetPath !== 'string' || targetPath.length === 0) return { source: 'disk', reason: 'no-buffer' };
  if (!sameSourcePath(targetPath, buffered.filePath)) return { source: 'disk', reason: 'other-file' };
  if (!buffered.dirty && opts.ignoreDirty === false) return { source: 'disk', reason: 'buffer-clean' };
  return {
    textOverride: buffered.text,
    source: 'buffer',
    reason: buffered.dirty ? 'buffer-dirty' : 'buffer-clean',
  };
}

/** 结果区那句口径标记（措辞在此钉死，测试直接钉这张表） */
export function textSourceLabel(choice: ReplayTextChoice): string {
  if (choice.source === 'buffer') {
    return choice.reason === 'buffer-dirty'
      ? '本次判定用的是编辑器里的未保存文本（不是磁盘上的那一份）'
      : '本次判定用的是编辑器缓冲区文本（编辑器里正开着的这一份）';
  }
  if (choice.reason === 'other-file') return '本次判定用的是磁盘文本（被判的那份文件不是编辑器里正在编辑的这一份）';
  return '本次判定用的是磁盘文本';
}

/** 未建模写摘要一次列几行（多的折成 `…`，数字另报） */
export const UNMODELED_WRITE_LIMIT = 5;

/**
 * 写点类别（契约 `ReplayWrite.kind`，2026-11-05 边界批 additive）。
 *
 * 类型从 `FunctionReplay['unmodeledWrites']` 取——**不从桶里 import `ReplayWrite`**：
 * 那条 import 会把契约文件的类型面拽进开机图（PS-10 字节闸），而这里只需要"那个
 * 可选字段的联合类型"。
 */
export type UnmodeledWriteKind = NonNullable<FunctionReplay['unmodeledWrites']>[number]['kind'];

/** 一条写点事实（结构上兼容契约 `ReplayWrite`；`kind` 缺省 = 旧数据 = 确定写点） */
export interface UnmodeledWriteLike {
  readonly line: number;
  readonly text: string;
  readonly kind?: UnmodeledWriteKind;
  /** 仅 `kind === 'call'`：静态可解析的被调函数名（缺省 = 目标动态 = 写不可知） */
  readonly target?: string;
  /**
   * 仅 `kind === 'call'` 且 `target` 可解析：被调段里**可证明的写点数**。
   * 缺省 = 没查到（不可知，**不是 0**）；`0` = 查过、被调段没有已知写。
   */
  readonly calleeWrites?: number;
}

/** 摘要里"确定写点"的那一条（行号 + 原文） */
export interface UnmodeledConcreteWrite {
  readonly line: number;
  readonly text: string;
}

/** 未建模写摘要（见 `summarizeUnmodeledWrites`） */
export interface UnmodeledWritesSummary {
  /** 写点总数（**全部类别**，含 call / jump；与 `concrete.length` 不一定相等） */
  total: number;
  /** 前 `limit` 条**确定写点**（行号 + 原文，行序即引擎给的顺序；call/jump 不逐行铺） */
  shown: UnmodeledConcreteWrite[];
  /** 没列出来的**确定写点**条数（0 = 全列了） */
  more: number;
  /** 提示语（分层的整句；行号按钮跟在它后面渲染） */
  head: string;
  /** 确定写点（kind 为 assign / instruction / 缺省）——全部，不截断 */
  concrete: UnmodeledConcreteWrite[];
  /** 调用行（`kind === 'call'`）条数——被调段是否写状态本层不展开 */
  calls: number;
  /**
   * 调用桶：被调段**可证有写**的调用数（`calleeWrites > 0`）。
   * 2026-11-05 边界批的跨函数传播（一层）给出的**确定**事实。
   */
  callsProven: number;
  /**
   * 调用桶：**写不可知**的调用数——`target` 缺失（动态目标）或 `calleeWrites` 缺省
   * （没查到被调段）。旧数据（无 `target` / `calleeWrites`）一律落这里。
   */
  callsUnknown: number;
  /** 调用桶：查过被调段、**没有检出已知写**的调用数（`calleeWrites === 0`） */
  callsClean: number;
  /** 跳转行（`kind === 'jump'`）条数——跳转后的写 / 早退是否执行本层不建模 */
  jumps: number;
  /** 调用行示例行号（最多 3 条，给 title 用；不逐行铺） */
  callLines: number[];
  /** 跳转行示例行号（最多 3 条，同上） */
  jumpLines: number[];
}

/** call / jump 示例行号最多留几条（title 里够定位就行，铺多了等于刷屏） */
export const UNMODELED_SAMPLE_LINES = 3;

/**
 * 未建模写摘要（纯函数）：`undefined` / 空数组 → null（旧引擎整体不渲染，零改动）。
 *
 * **分桶**（2026-11-05 边界批）：契约给写点加了 `kind`，两类事实的可信度不同——
 * - `assign` / `instruction`（以及旧数据的缺省）：**确定写点**，回放不执行，逐行可点回源；
 * - `call` / `jump`：**不确定面**，只报计数（被调段与跳转后的写/早退是否执行，静态判不出）。
 *   逐行铺开等于把"可能没发生的事"伪装成一排可点的写点，所以只给数量 + 前 3 条示例行号。
 *
 * **调用桶**（2026-11-05 边界批的跨函数传播，一层）：引擎能给到 `target` 与
 * `calleeWrites` 时，把"这行调用会写"与"这行调用可能写"分开说——
 * - `calleeWrites > 0` → **proven**（被调段可证有写）；
 * - `calleeWrites === 0` → **clean**（查过、被调段没有已知写）；
 * - `target` 缺失 / `calleeWrites` 缺省（含全部旧数据）→ **unknown**（写不可知）。
 * 三桶在 head 里按 proven → unknown → clean 的顺序拼；只有一桶时用整句（见 {@link callBucketClause}），
 * 跳转那条文案保持原样（引擎本批只报动态跳转）。
 *
 * 为什么确定写点也只列前 5 行：这一段可能写着几十处 `CFLAG +=`，全铺出来会把谓词列表
 * 顶出屏外；面板要回答的是"这结论是近似的、差在哪几行"，不是把写点清单搬进结果区。
 *
 * 兼容口径：`total` 仍是**全部**写点条数；`shown` / `more` 只算确定写点（能点回源的
 * 那批）。`undefined`（没拿到行文本）与 `[]`（算过、零写点）都返回 null，但前者的
 * "未评估"那句话由 {@link unmodeledUnknownNote} 单独给——两者不能混成一句。
 */
export function summarizeUnmodeledWrites(
  writes: readonly UnmodeledWriteLike[] | undefined | null,
  limit = UNMODELED_WRITE_LIMIT,
): UnmodeledWritesSummary | null {
  if (!writes || writes.length === 0) return null;
  const cap = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : UNMODELED_WRITE_LIMIT;
  const concrete: UnmodeledConcreteWrite[] = [];
  const callLines: number[] = [];
  const jumpLines: number[] = [];
  let calls = 0;
  let callsProven = 0;
  let callsUnknown = 0;
  let callsClean = 0;
  let jumps = 0;
  for (const w of writes) {
    // 运行时脏数据（kind 不在联合里）按"确定写点"处理：宁可多列一行可点的，也不丢事实
    if (w.kind === 'call') {
      calls += 1;
      // 桶判据：先看"能不能算"（目标可解析 + 被调段查过），再按写点数分 proven / clean。
      // `target` 缺失 = 动态目标；`calleeWrites` 缺省 = 没查到（**不是 0**）⇒ 都归 unknown。
      const target = typeof w.target === 'string' && w.target.length > 0 ? w.target : null;
      const calleeWrites =
        typeof w.calleeWrites === 'number' && Number.isFinite(w.calleeWrites) ? w.calleeWrites : null;
      if (target === null || calleeWrites === null) callsUnknown += 1;
      else if (calleeWrites > 0) callsProven += 1;
      else callsClean += 1;
      if (callLines.length < UNMODELED_SAMPLE_LINES) callLines.push(w.line);
    } else if (w.kind === 'jump') {
      jumps += 1;
      if (jumpLines.length < UNMODELED_SAMPLE_LINES) jumpLines.push(w.line);
    } else {
      concrete.push({ line: w.line, text: w.text });
    }
  }
  const extra: string[] = [];
  if (calls > 0) extra.push(callBucketClause(calls, callsProven, callsUnknown, callsClean));
  if (jumps > 0) extra.push(`${jumps} 处跳转`);
  const base = `本段有 ${concrete.length} 处状态写未建模（回放按入口值判）`;
  return {
    total: writes.length,
    shown: concrete.slice(0, cap),
    more: Math.max(0, concrete.length - cap),
    head:
      extra.length > 0
        ? `${base}；另有 ${extra.join('、')}：被调段与跳转后的写/早退不展开。`
        : `${base}：`,
    concrete,
    calls,
    callsProven,
    callsUnknown,
    callsClean,
    jumps,
    callLines,
    jumpLines,
  };
}

/**
 * 调用桶的 head 片段（纯函数）：只有一桶时给完整句（旧数据的「N 处调用」被
 * unknown 那句取代——旧数据本来就属于"写不可知"），多桶时按 proven → unknown → clean
 * 的顺序用顿号连。片段前由调用方加「另有 」，后接「：…」。
 *
 * 单桶三态（与需求逐字对齐）：
 * - proven：`M 处调用，其中 K 处被调段可证有写`
 * - unknown：`M 处调用（目标动态 / 查不到被调段，写不可知）`
 * - clean：`M 处调用（被调段未检出已知写）`
 */
function callBucketClause(calls: number, proven: number, unknown: number, clean: number): string {
  if (proven > 0 && unknown === 0 && clean === 0) return `${calls} 处调用，其中 ${proven} 处被调段可证有写`;
  if (proven === 0 && unknown > 0 && clean === 0) return `${calls} 处调用（目标动态 / 查不到被调段，写不可知）`;
  if (proven === 0 && unknown === 0 && clean > 0) return `${calls} 处调用（被调段未检出已知写）`;
  const parts: string[] = [];
  if (proven > 0) parts.push(`${proven} 处被调段可证有写`);
  if (unknown > 0) parts.push(`${unknown} 处写不可知（目标动态 / 查不到被调段）`);
  if (clean > 0) parts.push(`${clean} 处被调段未检出已知写`);
  // 理论上 calls ≥ 三桶之和、桶全零只可能来自运行时脏数据：退回旧文案，不编造桶
  if (parts.length === 0) return `${calls} 处调用`;
  return `${calls} 处调用：${parts.join('、')}`;
}

/** `undefined`（引擎没拿到函数体行文本）时结果区那句话——与"零写点"必须分开说 */
export const UNMODELED_UNKNOWN_NOTE = '未评估状态写（这次没拿到函数体行文本）：结论按入口值算，可能近似。';

/**
 * 「未评估」裁决（纯函数）：**只有 `undefined`** 才走那句话。
 * `[]`（算过、零写点）/ 有值 / null → null（由摘要或整段不渲染负责）。
 * 旧实现把这个判断内联在渲染里，测试只能隔着组件看；抽出来才能把口径钉住。
 */
export function unmodeledUnknownNote(writes: readonly UnmodeledWriteLike[] | undefined | null): string | null {
  return writes === undefined ? UNMODELED_UNKNOWN_NOTE : null;
}

/* -------------------- 槽位候选的两路合并（纯函数） -------------------- */

/**
 * 候选值并集（P4 常量候选批，2026-11-05）。
 *
 * 两路来源口径不同、都要留：
 * - `base` = 谓词 AST 里**字面量**比较出来的值（`panel-logic.argSlotCandidates`）；
 * - `extra` = 「槽 == 具名常量」那一路解析出的**真实值**（`const-candidates.resolveConstCandidates`）。
 *
 * 合并规则：按槽取并集，`base` 在前（原有行为逐字不变）、`extra` 只补新值，
 * 槽内去重。**不再截断**——两路各自已有 20 条上限（`MAX_SLOT_CANDIDATES` /
 * `MAX_CONST_CANDIDATES`），在这里再截一次等于悄悄丢掉作者最想要的那一条。
 * 空值（空串）不当候选（槽里""与"没填"不可区分）。
 */
export function mergeSlotCandidates(
  base: ReadonlyMap<string, readonly string[]>,
  extra: ReadonlyMap<string, readonly string[]> | null | undefined,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const put = (key: string, values: readonly string[]): void => {
    let list = out.get(key);
    if (!list) {
      list = [];
      out.set(key, list);
    }
    const seen = new Set(list);
    for (const v of values) {
      if (v.length === 0) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      list.push(v);
    }
  };
  for (const [key, values] of base) put(key, values);
  if (extra) for (const [key, values] of extra) put(key, values);
  // 两路都没给出值的槽不留空壳（渲染端按"有候选才挂 datalist"判）
  for (const [key, list] of [...out]) if (list.length === 0) out.delete(key);
  return out;
}

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
                  title: '该谓词读取了「按默认场景 0 试算」补的假设值——结论建立在假设之上',
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
  /**
   * 本次判定用的是哪份文本（可选；缓冲文本批）。
   * 缺省 = 不标（单测 / 别的调用方零改动）；面板一律给（口径必须写在脸上）。
   */
  textSource?: ReplayTextChoice | null;
  /**
   * 谓词筛选（可选；2026-11-05 筛选批）。只影响**渲染**：统计 / 分支 / 台词区一律
   * 仍按全量结果算，窗口（`predLimit`）作用于**筛后**列表。
   * 缺省 = 不画筛选行、直接渲染全量（旧调用方与 SSR 判据零改动）。
   */
  predicateFilter?: {
    readonly filter: PredicateFilter;
    readonly counts: PredicateCounts;
    onChange(next: PredicateFilter): void;
  } | null;
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
            title: '命中判定用到了「按默认场景 0 试算」补的假设值（作者没填、面板按 0 试算）——请核对场景参数',
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

  /**
   * 文本口径标记（缓冲文本批）：改过没保存的字到底算不算数，结果区自己说。
   * 缺省不渲染（单测 / 别的调用方零改动）。
   */
  const textSourceNote =
    opts.textSource === undefined || opts.textSource === null
      ? null
      : createElement(
          'div',
          { className: 'rp-hint dim rp-text-source' },
          textSourceLabel(opts.textSource),
        );

  /**
   * 未建模写标记（2026-11-05；2026-11-05 边界批分桶）：这一段里对游戏变量的写
   * （`CFLAG +=` / `SETBIT` / `INPUT`…）回放**不执行**，结论按入口值算 ⇒ 结果只是近似。
   *
   * 呈现分两层（不把"可能没发生"伪装成"写了"）：
   * - **确定写点**（assign / instruction / 旧数据缺省）逐行可点回源，行数多时只列前 5 条；
   * - **调用 / 跳转**只给计数，不逐行铺（被调段与跳转后的写/早退静态判不出）；
   *   前 3 条示例行号进 title，悬停即可定位，不占屏。
   */
  const unmodeled = summarizeUnmodeledWrites(result.unmodeledWrites);
  /** D6（2026-11-05）：引擎把 undefined 定义成「不知道有没有写」（没拿到正文），`[]` 才是「算过、未检出」。
   * 两者都渲染成「没有写点」就是在替引擎撒谎 ⇒ undefined 单独给一句「未评估」。 */
  const unmodeledUnknown = unmodeledUnknownNote(result.unmodeledWrites);
  /** 调用桶细目（悬停 title 用：proven / unknown / clean 各几处，不占屏） */
  const unmodeledCallBuckets =
    unmodeled === null
      ? []
      : [
          unmodeled.callsProven > 0 ? `被调段可证有写 ${unmodeled.callsProven} 处` : null,
          unmodeled.callsUnknown > 0 ? `写不可知 ${unmodeled.callsUnknown} 处` : null,
          unmodeled.callsClean > 0 ? `被调段未检出写 ${unmodeled.callsClean} 处` : null,
        ].filter((s): s is string => s !== null);
  /** call/jump 的悬停示例（只有计数，示例行号放 title） */
  const unmodeledExamples =
    unmodeled !== null && (unmodeled.calls > 0 || unmodeled.jumps > 0)
      ? [
          unmodeled.calls > 0
            ? `调用 ${unmodeled.calls} 处${
                unmodeledCallBuckets.length > 0 ? `（${unmodeledCallBuckets.join(' · ')}）` : ''
              }${unmodeled.callLines.length > 0 ? `（示例：第 ${unmodeled.callLines.join('、')} 行）` : ''}`
            : null,
          unmodeled.jumps > 0
            ? `跳转 ${unmodeled.jumps} 处${unmodeled.jumpLines.length > 0 ? `（示例：第 ${unmodeled.jumpLines.join('、')} 行）` : ''}`
            : null,
          '被调段与跳转后的写/早退不展开（静态判不出是否执行）',
        ]
          .filter((s): s is string => s !== null)
          .join('\n')
      : null;
  const unmodeledSection = unmodeledUnknown !== null
    ? createElement(
        'div',
        { className: 'rp-hint rp-unmodeled', role: 'note' },
        unmodeledUnknown,
      )
    : unmodeled
    ? createElement(
        'div',
        { className: 'rp-hint rp-unmodeled', role: 'note' },
        createElement('span', unmodeledExamples === null ? null : { title: unmodeledExamples }, unmodeled.head),
        ...unmodeled.shown.map((w, i) =>
          createElement(
            'button',
            {
              key: `w${w.line}:${i}`,
              className: 'ghost small rp-unmodeled-line',
              type: 'button',
              title: `${result.filePath}:${w.line}\n${w.text}`,
              onClick: () => emitReveal(result.filePath, w.line, result.normalizedName),
            },
            `第 ${w.line} 行`,
          ),
        ),
        unmodeled.more > 0
          ? createElement('span', { className: 'dim' }, `…（还有 ${unmodeled.more} 处确定写点未列）`)
          : null,
      )
    : null;

  /**
   * 谓词筛选行（2026-11-05）：真语料单函数能到 3,732 条，没有收窄手段就只能一路滚。
   * 档位按钮 + 一个搜索框，**只筛屏幕上的行**——统计徽章、分支、台词推演一律仍按全量算，
   * 窗口（`predLimit`）作用于筛后列表（"显示更多"按筛后条数走）。
   */
  const pf = opts.predicateFilter ?? null;
  const filteredPredicates = pf === null ? result.predicates : filterPredicates(result.predicates, pf.filter);
  // assumed 与 predicates 按下标对齐（`analysis.impact.affected`）；筛后要重新对齐——
  // `filterPredicates` 原样返回同一批对象（不复制），所以按对象身份搬即可。
  const assumedByIdentity = new Map<PredicateReplay, boolean>();
  result.predicates.forEach((p, i) => assumedByIdentity.set(p, impact.affected[i] === true));
  const filteredAssumed = filteredPredicates.map((p) => assumedByIdentity.get(p) === true);
  const filterBar =
    pf === null
      ? null
      : createElement(
          'div',
          { className: 'dbg-row rp-filter', style: { flexWrap: 'wrap', alignItems: 'baseline', gap: '4px' } },
          createElement('span', { className: 'dim' }, '筛选'),
          ...availableFilters(pf.counts).map((kind: PredicateFilterKind) =>
            createElement(
              'button',
              {
                key: kind,
                type: 'button',
                className: 'ghost small',
                style: kind === pf.filter.kind ? FILTER_ACTIVE_STYLE : undefined,
                title: `${PREDICATE_FILTER_LABEL[kind]} ${pf.counts[kind]} 条（只筛屏幕上的行，不改上面的统计）`,
                onClick: () => pf.onChange({ ...pf.filter, kind }),
              },
              `${PREDICATE_FILTER_LABEL[kind]} ${pf.counts[kind]}`,
            ),
          ),
          createElement('input', {
            className: 'rp-context-input',
            style: { flex: '1 1 80px', minWidth: 0 },
            type: 'text',
            value: pf.filter.query,
            placeholder: '搜原文 / 行号',
            title: '按原文、未知原因或行号收窄列表（不区分大小写；不改统计）',
            onChange: (e: { target: { value: string } }) => pf.onChange({ ...pf.filter, query: e.target.value }),
          }),
          filteredPredicates.length !== result.predicates.length
            ? createElement('span', { className: 'dim' }, `筛出 ${filteredPredicates.length}/${result.predicates.length}`)
            : null,
        );

  return createElement(
    'div',
    { className: 'rp-result' },
    noticeBanner,
    // 白话摘要（白话批）：徽章行数字之前先给一句结论（措辞对齐 describeReading）
    createElement('div', { className: 'rp-plain dim' }, replaySummarySentence(result)),
    // 口径：这次判的是编辑器里的未保存文本还是磁盘文本（缓冲文本批）
    textSourceNote,
    // 近似边界：这一段有未建模的状态写（引擎给了才渲染）
    unmodeledSection,
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
    filterBar,
    createElement(PredicateList, {
      predicates: filteredPredicates,
      filePath: result.filePath,
      normalizedName: result.normalizedName,
      assumed: filteredAssumed,
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
  // 2026-11-05 P6：旧文案叫作者"在场景参数里填这一格"，但常常根本没有那一格
  // （槽位输入只按路由模板渲染，模板不转发的 ARGS 压根没有输入框）。并集输入
  // （`mergeSlotInputs`）落地后这一格一定在；文案同时给两条可执行出路：
  // 手动填值，或勾「按默认场景 0 试算」。
  'call-context':
    '这一格由本次调用的实参决定，存档里没有 —— 在「场景参数」里给 ARG/ARGS 那一格填值就能判；数值槽也可以勾「按默认场景 0 试算」',
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
