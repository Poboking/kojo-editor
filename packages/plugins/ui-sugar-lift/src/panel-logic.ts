/**
 * 升糖面板纯逻辑（零 React，可单测）。
 *
 * 职责：把 `sugar.lift` 的结果 + 用户的勾选状态，规约成**可直接渲染的数据**：
 * - 候选列表行（按行区间排序 + 人读标签 + 口径提示）；
 * - 全选 / 单选 / 忽略的三态规约（`SelectState`）；
 * - diff 视图行（把 `SugarLiftDiffHunk` 转成带 `+/-/ ` 前缀的文本行）。
 *
 * **本模块不含任何游戏知识**：候选的语义（什么是一段糖）全由 `@kojo/plugin-api`
 * 的类型承载，此处只做**排序 / 过滤 / 格式化**。
 */

import type { SugarLiftCandidate, SugarLiftDiffHunk, SugarLiftResult, SugarLiftSkip } from '@kojo/plugin-api';

/* ============================== 候选列表 ============================== */

/** 候选列表行（渲染数据源；按 `fromLine` 升序） */
export interface CandidateRow {
  /** 稳定键（React key 用；不含行号以外的语义） */
  key: string;
  /** 序号（列表展示用；1 基） */
  ordinal: number;
  kind: SugarLiftCandidate['kind'];
  fromLine: number;
  toLine: number;
  /** 区间标签（`L12` 或 `L12–L18`） */
  rangeLabel: string;
  /** 糖类型显示名（中文，面向作者） */
  kindLabel: string;
  /** 建议的糖源码（多行原样；渲染时逐行） */
  sugarSource: string;
  /** 原文区间（逐行） */
  originalText: string;
  /** 是否单行候选（与块级候选在 UI 上区分） */
  singleLine: boolean;
  /** 是否依赖 `旁白色: 作者色` 口径（应用时会写文件头——须提示作者） */
  needsAuthorColor: boolean;
  /** 人读说明（来自候选自身） */
  reason: string;
}

/** 糖类型的显示名（**零游戏知识**——都是语言层术语） */
const KIND_LABELS: Record<SugarLiftCandidate['kind'], string> = {
  'print-message': '文本行',
  'if-block': '条件块',
  selectcase: '分派块',
  alias: '别名声明',
};

/**
 * 候选 → 列表行（**按行区间升序**；同起点时短区间在前，保证父块先于子块）。
 *
 * 为什么在这里再排一次：`sugar.lift` 契约已承诺升序，但消费方不该**依赖**
 * 上游排序来保证 UI 正确（自律优于假设）；重复排序的成本可忽略。
 */
export function buildRows(result: SugarLiftResult | null): CandidateRow[] {
  if (!result) return [];
  const sorted = [...result.candidates].sort((a, b) => a.fromLine - b.fromLine || a.toLine - b.toLine);
  return sorted.map((c, i) => ({
    key: `${c.kind}|${c.fromLine}|${c.toLine}`,
    ordinal: i + 1,
    kind: c.kind,
    fromLine: c.fromLine,
    toLine: c.toLine,
    rangeLabel: c.fromLine === c.toLine ? `L${c.fromLine}` : `L${c.fromLine}–L${c.toLine}`,
    kindLabel: KIND_LABELS[c.kind] ?? c.kind,
    sugarSource: c.sugarSource,
    originalText: c.roundTrip.originalText,
    singleLine: c.fromLine === c.toLine,
    needsAuthorColor: c.narrationColor === '作者色',
    reason: c.reason,
  }));
}

/* ============================== 勾选三态 ============================== */

/**
 * 勾选状态。
 *
 * - `selected`：用户显式勾上的键集合；
 * - `ignored`：用户显式忽略的键集合（优先级高于 `selected`）。
 *
 * 之所以用两个集合而不是一个三值 Map：忽略是一个**持续**的意图——"这条我不想
 * 再看到"。若用三值，全选会把忽略也覆盖掉。两集合让"忽略"天然免疫全选。
 */
export interface SelectState {
  selected: ReadonlySet<string>;
  ignored: ReadonlySet<string>;
}

export const EMPTY_SELECTION: SelectState = { selected: new Set(), ignored: new Set() };

/** 该行当前是否处于"选中"（忽略优先） */
export function isSelected(state: SelectState, key: string): boolean {
  if (state.ignored.has(key)) return false;
  return state.selected.has(key);
}

/** 切换单行选中（忽略态下点击 = 取消忽略并选中） */
export function toggleRow(state: SelectState, key: string): SelectState {
  const ignored = new Set(state.ignored);
  ignored.delete(key);
  const selected = new Set(state.selected);
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  return { selected, ignored };
}

/** 忽略 / 取消忽略一行（忽略时同时从选中移除） */
export function toggleIgnore(state: SelectState, key: string): SelectState {
  const ignored = new Set(state.ignored);
  const selected = new Set(state.selected);
  if (ignored.has(key)) {
    ignored.delete(key);
  } else {
    ignored.add(key);
    selected.delete(key);
  }
  return { selected, ignored };
}

/** 全选（已忽略的行**不参与**；已忽略的保持忽略） */
export function selectAll(state: SelectState, rows: readonly CandidateRow[]): SelectState {
  const selected = new Set(state.selected);
  for (const r of rows) if (!state.ignored.has(r.key)) selected.add(r.key);
  return { selected, ignored: state.ignored };
}

/** 全不选（忽略态保持） */
export function clearSelection(state: SelectState): SelectState {
  return { selected: new Set(), ignored: state.ignored };
}

/** 选中的行（保持列表顺序；忽略态不会出现在结果里） */
export function selectedRows(state: SelectState, rows: readonly CandidateRow[]): CandidateRow[] {
  return rows.filter((r) => isSelected(state, r.key));
}

/** 勾选摘要（UI 头部计数） */
export interface SelectionSummary {
  total: number;
  selected: number;
  ignored: number;
  /** 选中的候选里是否有需要写文件头的（提示用） */
  needsAuthorColor: boolean;
}

export function summarizeSelection(state: SelectState, rows: readonly CandidateRow[]): SelectionSummary {
  const chosen = selectedRows(state, rows);
  return {
    total: rows.length,
    selected: chosen.length,
    ignored: rows.filter((r) => state.ignored.has(r.key)).length,
    needsAuthorColor: chosen.some((r) => r.needsAuthorColor),
  };
}

/* ============================== 跳过项 ============================== */

/** 跳过原因显示名（中文；**闭集**——`SugarLiftSkipReason` 的每个键都要有） */
const SKIP_LABELS: Record<SugarLiftSkip['reason'], string> = {
  'unsupported-print-variant': 'PRINT 变体无糖形态',
  'unparsable-condition': '条件不可解析',
  'unsupported-control-flow': '含糖未覆盖的控制流',
  'label-or-goto': '含标签 / GOTO',
  'macro-or-directive': '含宏或函数边界',
  'mixed-domain-line': '文本域与逻辑域混行',
  'comment-interference': '注释打断连段',
  'roundtrip-mismatch': '转回去对不上（已降级）',
  'transpile-error': '糖片段本身非法',
  'not-covered': '不在 v1 四类糖之内',
};

export interface SkipRow {
  key: string;
  rangeLabel: string;
  reasonLabel: string;
  message: string;
}

/** 跳过项 → 列表行（**显式呈现，不静默**——内核铁律） */
export function buildSkipRows(skips: readonly SugarLiftSkip[] | undefined): SkipRow[] {
  return (skips ?? []).map((s) => ({
    key: `${s.reason}|${s.fromLine}|${s.toLine}`,
    rangeLabel: s.fromLine === s.toLine ? `L${s.fromLine}` : `L${s.fromLine}–L${s.toLine}`,
    reasonLabel: SKIP_LABELS[s.reason] ?? s.reason,
    message: s.message,
  }));
}

/* ============================== diff 视图 ============================== */

/** diff 显示行（前缀 + 文本；前缀 ∈ `+` / `-` / ` `） */
export interface DiffLine {
  prefix: '+' | '-' | ' ';
  text: string;
  /** 该行对应对候选的第几行（0 基；用于 React key） */
  index: number;
}

/** diff 行前缀（`-` 改前 / `+` 改后；相同内容不重复渲染——见 `buildDiffLines`） */
export const DIFF_PREFIX = { removed: '-', added: '+', context: ' ' } as const;

/**
 * 把 hunk 列表转为 diff 显示行。
 *
 * 逐 hunk 展开：先所有 `-` 行，再所有 `+` 行（**不做行对齐**）。理由：
 * 升糖的替换是"整段换整段"，行数常常不等（1 行 ERB → 3 行糖块），
 * 强行对齐只会制造不存在的"上下文行"。UI 用颜色区分即可。
 */
export function buildDiffLines(hunks: readonly SugarLiftDiffHunk[]): DiffLine[] {
  const out: DiffLine[] = [];
  for (const h of hunks) {
    let i = 0;
    for (const l of h.removed) out.push({ prefix: DIFF_PREFIX.removed, text: l, index: i++ });
    for (const l of h.added) out.push({ prefix: DIFF_PREFIX.added, text: l, index: i++ });
  }
  return out;
}

/** 把 diff 行组成可复制的文本块（`-`/`+` 前缀保留；供"复制 diff"按钮） */
export function diffToText(hunks: readonly SugarLiftDiffHunk[]): string {
  return buildDiffLines(hunks)
    .map((l) => `${l.prefix}${l.text}`)
    .join('\n');
}

/* ============================== 降级提示 ============================== */

export type PanelDegrade = 'no-project' | 'no-file' | 'empty' | 'scan-error' | 'scanning';

const DEGRADE_TEXT: Record<PanelDegrade, string> = {
  'no-project': '打开项目后可用（升糖建议来自当前 .kojo 文件）',
  'no-file': '打开一个 .kojo 文件后可用',
  scanning: '扫描中…',
  empty: '未发现可升糖的片段（全部区间已显式列在下方"未建议"里）',
  'scan-error': '升糖扫描失败',
};

export function degradeText(d: PanelDegrade): string {
  return DEGRADE_TEXT[d];
}
