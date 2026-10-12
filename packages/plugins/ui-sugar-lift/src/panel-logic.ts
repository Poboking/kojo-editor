/**
 * 升糖**视图**面板纯逻辑（零 React，可单测）。
 *
 * ## 定位（2026-10-12 语法糖批换了一个问题）
 *
 * 面板以前回答的是"**哪些片段能安全写回 `.kojo`**"——那是 `liftSuggest` 的强自证
 * 口径（逐字节 round-trip），真实语料上行覆盖只有 **6.5%**，于是作者打开面板看到的
 * 是九万条"未建议区间"。那个数字对读者是噪声，不是信息。
 *
 * 现在回答的是读者真正会问的两句话：
 *
 * 1. **"这份文件我读懂了多少？"** → `coverageText`（已显示为语法糖的行数与占比）；
 * 2. **"剩下的为什么没读懂？"** → `breakdownText` + 分因明细（闭集中文标签）。
 *
 * 数字全部来自 `SugarProjectStats`，本模块**不另算口径**（算两遍必然漂移）。
 *
 * **零游戏知识**：本模块只消费 `@kojo/plugin-api` 里的结构类型。
 */

import type { SugarProjectNativeReason, SugarProjectResult } from '@kojo/plugin-api';

/* ============================== 保留原生：分因 ============================== */

/**
 * "这一行为什么留着原代码"的显示名（**闭集**——`SugarProjectNativeReason` 的每个键
 * 都要有；面向读者，一律说人话，不暴露内部术语）。
 */
const NATIVE_REASON_LABELS: Record<SugarProjectNativeReason, string> = {
  'unsupported-print-variant': '其它输出指令（非台词/旁白写法）',
  'inline-condition': '含行内条件（\\@ 写法）',
  'unsupported-control-flow': '糖未覆盖的控制流（SIF / 循环 / TRY / 数据表）',
  'data-or-skip': '数据表内容 / 已停用区（[SKIPSTART]）',
  other: '赋值、函数调用、函数声明等',
};

/** 分因明细行 */
export interface NativeReasonRow {
  key: SugarProjectNativeReason;
  /** 中文显示名 */
  label: string;
  count: number;
}

/* ============================== 投影摘要 ============================== */

/** 投影摘要（面板的全部渲染数据源） */
export interface ProjectionSummary {
  /** 源文件总行数 */
  total: number;
  /** 连续可映射段数 */
  segments: number;
  /** 被糖覆盖的源行数 */
  projected: number;
  /** 原样保留的原生行数 */
  native: number;
  /** 原样透传的注释 / 空行数 */
  passthrough: number;
  /** 已显示为语法糖的比例（0–100，四舍五入到整数） */
  coverage: number;
  /** 保留原生的分因明细（按计数降序） */
  reasons: NativeReasonRow[];
}

/** 千分位（不依赖 ICU：不同 Node/WebView 的 `toLocaleString` 输出不一致） */
function formatCount(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  return `${n < 0 ? '-' : ''}${s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/**
 * 投影结果 → 摘要。
 *
 * `null`（尚未扫描 / 文件不可读）→ `null`：面板显示降级文案，不假装"已读懂 0%"。
 * 无段但行数非零（系统脚本、纯数据表）→ **仍然返回摘要**（"已映射 0 行"是真实的
 * 读数，比"空"更有信息量）。
 */
export function summarizeProjection(result: SugarProjectResult | null): ProjectionSummary | null {
  if (!result) return null;
  const { stats } = result;
  const coverage =
    stats.totalLines > 0 ? Math.round((stats.projectedLines / stats.totalLines) * 100) : 0;
  return {
    total: stats.totalLines,
    segments: result.segments.length,
    projected: stats.projectedLines,
    native: stats.nativeLines,
    passthrough: stats.passthroughLines,
    coverage,
    reasons: [...stats.nativeByReason]
      .map((r) => ({ key: r.reason, label: NATIVE_REASON_LABELS[r.reason] ?? r.reason, count: r.count }))
      .sort((a, b) => b.count - a.count),
  };
}

/** 首行摘要：这份文件读懂了百分之多少 */
export function coverageText(s: ProjectionSummary): string {
  return `共 ${formatCount(s.total)} 行 · 已显示为语法糖 ${formatCount(s.projected)} 行（${s.coverage}%）`;
}

/** 次行摘要：另一半去哪了（原代码 / 注释空行分开说，读者不会以为漏了） */
export function breakdownText(s: ProjectionSummary): string {
  return `原样保留原代码 ${formatCount(s.native)} 行 · 注释与空行 ${formatCount(s.passthrough)} 行`;
}

/* ============================== 降级提示 ============================== */

export type PanelDegrade = 'no-project' | 'no-file' | 'empty' | 'scan-error' | 'scanning' | 'not-erb';

const DEGRADE_TEXT: Record<PanelDegrade, string> = {
  'no-project': '打开项目后可用（糖视图针对当前打开的文件）',
  'no-file': '打开一个口上文件后可用',
  'not-erb': '当前文件不是原生 ERB（`.kojo` 本身即是语法糖，无需转换）',
  scanning: '正在生成糖视图…',
  empty: '这份文件没有可显示为语法糖的内容（可能是纯数据表或系统脚本）',
  'scan-error': '糖视图生成失败',
};

export function degradeText(d: PanelDegrade): string {
  return DEGRADE_TEXT[d];
}
