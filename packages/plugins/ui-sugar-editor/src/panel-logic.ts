/**
 * 糖判定面板 / 编辑器波浪线 —— **纯逻辑**（零 React、零内核依赖，可单测）。
 *
 * 分层（"一切皆插件"）：转译与诊断全在 `kojo-sugar`（`sugar.transpile`，纯函数），
 * 本模块只做**判定归类 + 装饰翻译**——即"给定诊断列表，得出判定状态与波浪线条目"。
 * 放在本文件而非 `index.ts`：判定与列区间翻译是可复用、可逐条断言的核心，不该
 * 埋在 React 组件里（与 ui-sugar-preview 的 `panel-logic.ts` 同规矩）。
 */

import type { LineDecoration, SugarDiagnostic, SugarSeverity } from '@kojo/plugin-api';

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

/* ============================== 降级态 ============================== */

/** 面板降级原因（能力/项目缺席要"退化可见"，不静默） */
export type VerdictDegrade = 'no-project' | 'not-kojo' | 'reading' | 'read-error';

export function degradeText(d: VerdictDegrade): string {
  switch (d) {
    case 'no-project':
      return '未打开 .kojo 文件（从左侧选择糖源开始编辑）';
    case 'not-kojo':
      return '当前文件不是 .kojo 糖源（判定只作用于语法糖表层文件）';
    case 'reading':
      return '读取中…';
    case 'read-error':
      return '读取失败';
  }
}