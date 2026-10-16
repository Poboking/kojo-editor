/**
 * 糖判定面板 / 编辑器波浪线 —— **纯逻辑**（零 React、零内核依赖，可单测）。
 *
 * 分层（"一切皆插件"）：转译与诊断全在 `kojo-sugar`（`sugar.transpile`，纯函数），
 * 本模块只做**判定归类 + 装饰翻译**——即"给定诊断列表，得出判定状态与波浪线条目"。
 * 放在本文件而非 `index.ts`：判定与列区间翻译是可复用、可逐条断言的核心，不该
 * 埋在 React 组件里（与 ui-sugar-preview 的 `panel-logic.ts` 同规矩）。
 */

import type { LineDecoration, SugarDiagnostic, SugarSeverity } from '@kojo/plugin-api';
import { pathKey } from '@kojo/plugin-api';

/** 是否 `.kojo` 糖源文件（判定面板与波浪线只作用于糖源；原生 `.ERB` 不适用） */
export function isKojoFile(path: string | null | undefined): boolean {
  return typeof path === 'string' && /\.kojo$/i.test(path);
}

/* ============================== 判定状态 ============================== */

/** 判定状态：可编译 / 有警告 / 不可编译 */
export type VerdictStatus = 'ok' | 'warning' | 'error';

export interface VerdictCounts {
  readonly error: number;
  readonly warning: number;
  readonly info: number;
}

export function countBySeverity(diagnostics: readonly SugarDiagnostic[]): VerdictCounts {
  let error = 0;
  let warning = 0;
  let info = 0;
  for (const d of diagnostics) {
    if (d.severity === 'error') error++;
    else if (d.severity === 'warning') warning++;
    else info++;
  }
  return { error, warning, info };
}

/**
 * 判定：有 `error` 即"不可编译"（`compileToFile` 会 fail-closed 拒写，规范 §5.3）；
 * 否则有 `warning` = "有警告"；再否则 = "可编译"。
 */
export function verdictStatus(counts: VerdictCounts): VerdictStatus {
  if (counts.error > 0) return 'error';
  if (counts.warning > 0) return 'warning';
  return 'ok';
}

/** 判定中文标签 */
export function verdictLabel(status: VerdictStatus): string {
  if (status === 'error') return '不可编译';
  if (status === 'warning') return '可编译（有警告）';
  return '可编译';
}

/* ============================== 逐条判定行 ============================== */

export interface VerdictRow {
  /** 稳定键（React 渲染用；诊断无天然 id，故用序号） */
  readonly key: string;
  readonly severity: SugarSeverity;
  readonly code: string;
  /** 1 基行号；文件级诊断为 null */
  readonly line: number | null;
  /** 1 基列号；无位置时为 null */
  readonly column: number | null;
  readonly message: string;
}

/**
 * 诊断 → 判定行（按"有位置的在前、位置升序"排序；文件级诊断殿后）。
 * 排序是**稳定**的：同位置按原始顺序，保证 UI 不抖动。
 */
export function buildVerdictRows(diagnostics: readonly SugarDiagnostic[]): VerdictRow[] {
  const rows: VerdictRow[] = diagnostics.map((d, i) => ({
    key: `${d.code}|${d.loc?.line ?? 0}|${d.loc?.column ?? 0}|${i}`,
    severity: d.severity,
    code: d.code,
    line: d.loc?.line ?? null,
    column: d.loc?.column ?? null,
    message: d.message,
  }));
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const al = a.r.line ?? Number.MAX_SAFE_INTEGER;
      const bl = b.r.line ?? Number.MAX_SAFE_INTEGER;
      if (al !== bl) return al - bl;
      const ac = a.r.column ?? Number.MAX_SAFE_INTEGER;
      const bc = b.r.column ?? Number.MAX_SAFE_INTEGER;
      if (ac !== bc) return ac - bc;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/* ============================== 波浪线翻译 ============================== */

/**
 * 诊断 → 编辑器装饰（`ui.editor.decorator` 槽的返回值）。
 *
 * 列区间：优先取诊断的 `span`（多行 span 只画到行尾，即省 `endColumn`）；
 * 无 `span` 时退化为 `loc.column` 起、到行尾（省 `endColumn`）。位置缺失的
 * 文件级诊断**不产装饰**（波浪线必须挂在某一行上；面板仍会展示它）。
 */
export function diagnosticDecorations(diagnostics: readonly SugarDiagnostic[]): LineDecoration[] {
  const out: LineDecoration[] = [];
  for (const d of diagnostics) {
    if (!d.loc) continue;
    const span = d.span;
    const sameLine = span !== undefined && span.start.line === span.end.line;
    const startColumn = sameLine ? span!.start.column : d.loc.column;
    out.push({
      line: d.loc.line,
      severity: d.severity,
      message: d.message,
      startColumn: Math.max(1, startColumn),
      ...(sameLine ? { endColumn: Math.max(startColumn + 1, span!.end.column) } : {}),
      code: d.code,
    });
  }
  return out;
}

/* ============================== 概要 ============================== */

export interface VerdictSummary {
  readonly status: VerdictStatus;
  readonly label: string;
  readonly counts: VerdictCounts;
  /** 产物行数（转译成功时给；用于"生成 N 行"提示） */
  readonly generatedLines: number;
  /** 有源映射的产物行数（纯生成行不计） */
  readonly mappedLines: number;
  /** 源行数 */
  readonly sourceLines: number;
}

export function summarize(
  source: string,
  generated: string,
  mappedLines: number,
  diagnostics: readonly SugarDiagnostic[],
): VerdictSummary {
  const counts = countBySeverity(diagnostics);
  const status = verdictStatus(counts);
  return {
    status,
    label: verdictLabel(status),
    counts,
    generatedLines: generated.length === 0 ? 0 : generated.replace(/\n$/, '').split('\n').length,
    mappedLines,
    sourceLines: source.length === 0 ? 0 : source.replace(/\n$/, '').split('\n').length,
  };
}

/* ============================== 缓冲真相池（C2） ============================== */

/**
 * 编辑器**缓冲真相**池（C2，2026-10-16 面板真相统一批）：消费宿主广播
 * `editor.documentChanged` 的最新文本，**按文件**各留一条。
 *
 * 语义（与契约注释同一口径）：
 * - 同一 path 的新广播**覆盖旧**——它就是"这个文件此刻的可编译真相"；
 * - `textFor()` 返回 null = 还没收到该文件的广播（首开窗口期）→ 调用方退回
 *   `io.readText` 读盘兜底；返回非空 = 以广播为准，**不得**再读盘（否则又成分叉）；
 * - path 判等走 `pathKey()` 归一：事件路径平台原样，裸字符串比会在 Windows 上
 *   静默判不上（HK-7 同款坑）；
 * - 只进不删、条数 = 会话内收到过广播的文件数（面板场景就一两份文件，不设上限）。
 *
 * 放在本文件（而非 React 组件里）："广播里有没有这个文件的真相"是文本源选择的
 * 核心判据，可逐条断言（与同文件其余纯逻辑同规矩）。
 */
export interface LiveTextPool {
  /** 记一条广播（同 path 覆盖旧值） */
  apply(filePath: string, text: string): void;
  /** 该文件的最新真相；未收到过广播返回 null（调用方走读盘兜底） */
  textFor(filePath: string | null | undefined): string | null;
}

export function createLiveTextPool(): LiveTextPool {
  const byKey = new Map<string, string>();
  return {
    apply(filePath: string, text: string): void {
      byKey.set(pathKey(filePath), text);
    },
    textFor(filePath: string | null | undefined): string | null {
      if (filePath === null || filePath === undefined) return null;
      return byKey.get(pathKey(filePath)) ?? null;
    },
  };
}

/* ============================== 降级态 ============================== */

/** 面板降级原因（能力/项目缺席要"退化可见"，不静默） */
export type VerdictDegrade = 'no-project' | 'not-kojo' | 'reading' | 'read-error';

export function degradeText(d: VerdictDegrade): string {
  switch (d) {
    case 'no-project':
      return '未打开 .kojo 文件（从左侧选一份开始编辑）';
    case 'not-kojo':
      return '当前文件不是 .kojo（校验只对 .kojo 文件生效）';
    case 'reading':
      return '读取中…';
    case 'read-error':
      return '读取失败';
  }
}

/* ============================== 诊断渲染窗口 ============================== */

/**
 * 诊断列表的渲染窗口（触底增窗）。
 *
 * 旧实现硬截 200 条 + 一句「其余 N 条未显示」——第 201 条起不可达。窗口化后
 * INITIAL 是首帧 DOM 上界，滚动触底或点击「显示更多」按 STEP 增长，全量可达。
 * 取值：诊断行单行 ~20px，典型 .kojo 文件诊断 <50 条 ⇒ INITIAL=80 一窗盖住
 * 绝大多数文件，且步长按 1:2 节奏（与函数树的面窗口同比例）。
 */
export const DIAG_WINDOW_INITIAL = 80;
export const DIAG_WINDOW_STEP = 160;

/** 当前窗口应渲染的行数（纯函数）：[0, min(total, limit ?? INITIAL)] */
export function diagWindowSize(total: number, limit: number | undefined): number {
  return Math.min(total, limit ?? DIAG_WINDOW_INITIAL);
}

/**
 * 窗口下一步（纯函数）：min(total, max(INITIAL, 当前 + STEP))。
 * 单调不减、单步增量 ≤ STEP、终值 = total——「显示更多」与触底自动加载共用。
 */
export function nextDiagWindow(current: number | undefined, total: number): number {
  const base = current ?? DIAG_WINDOW_INITIAL;
  return Math.min(total, Math.max(DIAG_WINDOW_INITIAL, base + DIAG_WINDOW_STEP));
}
