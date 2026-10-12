/**
 * 升糖面板纯逻辑（零 React，可单测）。
 *
 * 定位（2026-10-12 升糖重定位批）：升糖**只用于看**——面板把 `sugar.lift` 的结果
 * 规约成"可点击预览"的列表行，点击即在编辑器里就地折叠显示糖写法（纯前端，
 * **不写盘**）。因此本模块只保留**排序 / 标签 / 跳过项 / 降级文案**，不再有
 * 勾选三态与 diff（写回路径已从本插件摘除）。
 *
 * **本模块不含任何游戏知识**：候选语义全由 `@kojo/plugin-api` 的类型承载。
 */

import type { SugarLiftCandidate, SugarLiftResult, SugarLiftSkip } from '@kojo/plugin-api';

/* ============================== 候选列表 ============================== */

/** 候选列表行（渲染数据源；按 `fromLine` 升序） */
export interface CandidateRow {
  /** 稳定键（React key 用） */
  key: string;
  kind: SugarLiftCandidate['kind'];
  fromLine: number;
  toLine: number;
  /** 区间标签（`L12` 或 `L12–L18`） */
  rangeLabel: string;
  /** 糖类型显示名（中文，面向作者） */
  kindLabel: string;
  /** 建议的糖写法（多行原样） */
  sugarSource: string;
  /** 是否依赖 `旁白色: 作者色` 口径（预览时提示作者） */
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
  return [...result.candidates]
    .sort((a, b) => a.fromLine - b.fromLine || a.toLine - b.toLine)
    .map((c) => ({
      key: `${c.kind}|${c.fromLine}|${c.toLine}`,
      kind: c.kind,
      fromLine: c.fromLine,
      toLine: c.toLine,
      rangeLabel: c.fromLine === c.toLine ? `L${c.fromLine}` : `L${c.fromLine}–L${c.toLine}`,
      kindLabel: KIND_LABELS[c.kind] ?? c.kind,
      sugarSource: c.sugarSource,
      needsAuthorColor: c.narrationColor === '作者色',
      reason: c.reason,
    }));
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

/* ============================== 降级提示 ============================== */

export type PanelDegrade = 'no-project' | 'no-file' | 'empty' | 'scan-error' | 'scanning' | 'too-large';

const DEGRADE_TEXT: Record<PanelDegrade, string> = {
  'no-project': '打开项目后可用（升糖建议来自当前文件）',
  'no-file': '打开一个口上文件后可用',
  scanning: '扫描中…',
  empty: '未发现可升糖的片段（全部区间已显式列在下方"未建议"里）',
  'scan-error': '升糖扫描失败',
  // 超长文件降级（2026-10-12「内核优化」批）：自动扫描让位给流畅度，显式路径仍在
  'too-large':
    '当前文件过长，为保持打开/滚动流畅，已跳过整篇升糖扫描。点上方「重新扫描」可按需执行（会有一瞬卡顿）。',
};

export function degradeText(d: PanelDegrade): string {
  return DEGRADE_TEXT[d];
}