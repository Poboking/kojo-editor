/**
 * 糖判定面板 / 编辑器波浪线 —— **纯逻辑**（零 React、零内核依赖，可单测）。
 *
 * 分层（"一切皆插件"）：转译与诊断全在 `kojo-sugar`（`sugar.transpile`，纯函数），
 * 本模块只做**判定归类 + 装饰翻译**——即"给定诊断列表，得出判定状态与波浪线条目"。
 * 放在本文件而非 `index.ts`：判定与列区间翻译是可复用、可逐条断言的核心，不该
 * 埋在 React 组件里（与 ui-sugar-preview 的 `panel-logic.ts` 同规矩）。
 *
 * W4 PANEL-DEDUP（2026-10-18 面板去重批）：行池 / `.kojo` 判定 / 降级文案 /
 * 诊断行成形 / 渲染窗口 / 触底哨兵核**曾与 preview 逐字各抄一份**，现已上收
 * `@kojo/plugin-api/sugar-panels`（唯一实现）；本文件保留原有导出名做薄转发，
 * `index.ts` 的 import 面零改动。新增真相事件请只改契约层一处。
 */

import type { LineDecoration, SugarDiagnostic } from '@kojo/plugin-api';
import { buildPanelDiagnosticRows } from '@kojo/plugin-api';
import type { PanelDegrade, PanelDiagnosticRow } from '@kojo/plugin-api';

/* ---- 共享核薄转发（W4：唯一实现在 @kojo/plugin-api/sugar-panels，勿在此复刻） ---- */
export {
  MORE_ROW_STYLE,
  MORE_ROW_TITLE,
  attachGrowSentinel,
  createLiveTextPool,
  createPanelTruthController,
  degradeForActiveFile,
  degradeText,
  DIAG_WINDOW,
  DIAG_WINDOW_INITIAL,
  DIAG_WINDOW_STEP,
  growWindow,
  isKojoFile,
  moreRowLabel,
  diagWindowSize,
  nextDiagWindow,
} from '@kojo/plugin-api';
export type { LiveTextPool, PanelTruthController, PanelTruthHandlers } from '@kojo/plugin-api';

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

/**
 * 判定行 = 共享诊断行（形状逐字相同；W4 起同源同口径：有位置的在前、
 * (行,列) 升序、文件级殿后、同位置保序——与 preview 面板同屏必同序）。
 */
export type VerdictRow = PanelDiagnosticRow;

/** 诊断 → 判定行（实现住在契约层 `sugar-panels`，此处仅保留原导出名） */
export function buildVerdictRows(diagnostics: readonly SugarDiagnostic[]): VerdictRow[] {
  return buildPanelDiagnosticRows(diagnostics);
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

/** 面板降级原因：W4 起与 preview 共用契约层闭集（文案单一真源 = `degradeText`） */
export type VerdictDegrade = PanelDegrade;
