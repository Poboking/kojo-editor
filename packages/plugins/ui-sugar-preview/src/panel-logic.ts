/**
 * 糖预览面板纯逻辑（零 React，可单测）。
 *
 * 职责：把 `sugar.preview` 的只读结果 + 源文本，规约成**可直接渲染的数据**：
 * - 逐行映射行（糖源码行 → 产物行区间；产物行区间折叠为 `L12` / `L12–L18`）；
 * - 诊断行（severity / 消息 / 定位；文件级诊断 `line = null`）；
 * - 全角空格告警行（规范 §8：全角空格/标点在保存时告警，预览侧先提示）；
 * - 可达性计数（三档折成计数 + 着色类别 + 人读标签）；
 * - 概要（源行 / 产物行 / 诊断 / 映射 / 消息块计数）。
 *
 * **本模块不含任何游戏知识**：一切语义（什么是糖行、什么是消息块）由
 * `@kojo/plugin-api` 的类型承载，此处只做**排序 / 过滤 / 格式化 / 计数**。
 *
 * 边界（S4 数据层已知边界，见 `kojo-sugar/src/preview.ts` 头注）：三向映射里
 * 「产物行 ↔ 消息块」的坐标同源性由装配方保证；本模块只消费其输出，
 * **不替它做坐标判断**，故无回放数据时 `messageBlocks` 为空数组是合法输入。
 */

import type {
  PreviewReachability,
  SnapshotScanResult,
  SugarDiagnostic,
  SugarPreviewLine,
  SugarPreviewMessageBlock,
  SugarPreviewResult,
} from '@kojo/plugin-api';
import { FULLWIDTH_SPACE, fullwidthSpaceLines, pathKey } from '@kojo/plugin-api';

/* ============================== 全角空格（规范 §8） ============================== */

/**
 * 全角空格（`U+3000`）——**单一真源已上收契约层**（S7 批）。
 *
 * 这里不再本地定义，而是从 `@kojo/plugin-api` 导入后**原样转出**：契约层的
 * `FULLWIDTH_SPACE` / `fullwidthSpaceLines` 是保存前置检查（`planSave`）与本
 * 预览面板**共用**的判据，两处各写一遍会让"什么算全角空格"悄悄分叉。契约层
 * 是允许的公共面，插件之间仍不交叉 import（解耦审计 C 项不受影响）。
 */
export { FULLWIDTH_SPACE, fullwidthSpaceLines };

/* ============================== 诊断行 ============================== */

/** 诊断列表行（渲染数据源；保持上游顺序，不做重排） */
export interface DiagnosticRow {
  key: string;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  /** 1 基行号；**文件级诊断（无位置）为 null** */
  line: number | null;
  /** 1 基列号；无位置为 null */
  column: number | null;
}

/** 是否可跳转定位（有源位置） */
export function canJump(d: DiagnosticRow): boolean {
  return d.line !== null;
}

/** 诊断 → 列表行（`key` 含序号，避免同码同位置重复诊断互相顶掉） */
export function buildDiagnosticRows(diags: readonly SugarDiagnostic[] | undefined): DiagnosticRow[] {
  return (diags ?? []).map((d, i) => ({
    key: `${d.code}|${d.loc?.line ?? 0}|${d.loc?.column ?? 0}|${i}`,
    severity: d.severity,
    code: d.code,
    message: d.message,
    line: d.loc?.line ?? null,
    column: d.loc?.column ?? null,
  }));
}

/* ============================== 可达性折叠 ============================== */

/** 消息块可达性三档计数 */
export interface ReachabilityCounts {
  reachable: number;
  unreachable: number;
  unknown: number;
}

/** 空计数（无块 / 未接入回放时用；冻结以避免共享可变状态） */
export const ZERO_REACH: ReachabilityCounts = Object.freeze({ reachable: 0, unreachable: 0, unknown: 0 });

/** 折叠一组消息块的可达性（计数，不丢失混合态——"某行同时有可达与不可达块"是真实情形） */
export function foldReachability(blocks: readonly SugarPreviewMessageBlock[]): ReachabilityCounts {
  const counts: ReachabilityCounts = { reachable: 0, unreachable: 0, unknown: 0 };
  for (const b of blocks) counts[b.reachability] += 1;
  return counts;
}

/** 是否有任何块（用于决定是否画徽章） */
export function hasBlocks(c: ReachabilityCounts): boolean {
  return c.reachable + c.unreachable + c.unknown > 0;
}

/** 着色类别：`bad`（含不可达）/ `warn`（含未知）/ `ok`（全可达）/ `none`（无块） */
export type ReachClass = 'bad' | 'warn' | 'ok' | 'none';

export function reachabilityClass(c: ReachabilityCounts): ReachClass {
  if (!hasBlocks(c)) return 'none';
  if (c.unreachable > 0) return 'bad';
  if (c.unknown > 0) return 'warn';
  return 'ok';
}

/** 人读标签（混合态显式列出计数，不隐藏） */
export function reachabilityLabel(c: ReachabilityCounts): string {
  if (!hasBlocks(c)) return '';
  if (c.unreachable > 0 && c.reachable === 0 && c.unknown === 0) return '不可达';
  if (c.reachable > 0 && c.unreachable === 0 && c.unknown === 0) return '可达';
  if (c.unknown > 0 && c.reachable === 0 && c.unreachable === 0) return '未知';
  const parts: string[] = [];
  if (c.reachable > 0) parts.push(`可达 ${c.reachable}`);
  if (c.unknown > 0) parts.push(`未知 ${c.unknown}`);
  if (c.unreachable > 0) parts.push(`不可达 ${c.unreachable}`);
  return parts.join(' / ');
}

/** 单块可达性标签（详情区逐块显示） */
const BLOCK_LABELS: Record<PreviewReachability, string> = {
  reachable: '可达',
  unreachable: '不可达',
  unknown: '未知',
};

export function blockLabel(r: PreviewReachability): string {
  return BLOCK_LABELS[r];
}

/* ============================== 逐行映射 ============================== */

/** 逐行映射行（渲染数据源；按糖源码行升序） */
export interface PreviewRow {
  /** 稳定键 */
  key: string;
  /** 糖源码行号（1 基） */
  sourceLine: number;
  sourceText: string;
  /** 空行（渲染淡显） */
  blank: boolean;
  /** 该糖行生成的产物行号（升序；空 = 纯糖语法行） */
  generatedLines: number[];
  /** 产物行标签（`L120` / `L120–L123` / `—`） */
  generatedLabel: string;
  /** 该糖行的消息块（详情区用） */
  messageBlocks: readonly SugarPreviewMessageBlock[];
  reach: ReachabilityCounts;
  reachClass: ReachClass;
  reachLabel: string;
  /** 含全角空格（保存告警的行内标记） */
  hasFullwidthSpace: boolean;
}

/** 产物行号区间 → 标签（空数组返回 `—`） */
export function generatedLabel(lines: readonly number[]): string {
  if (lines.length === 0) return '—';
  const first = lines[0]!;
  const last = lines[lines.length - 1]!;
  if (first === last || lines.length === 1) return `L${first}`;
  // 连续区间才用 `–`，否则列出首尾（`.kojo` 一行通常只映射到连续产物行）
  return last - first + 1 === lines.length ? `L${first}–L${last}` : `L${first}…L${last}（${lines.length} 行）`;
}

/**
 * 逐行映射 → 渲染行。
 *
 * `lines` 由数据层保证覆盖全部源行（契约：行数 = 源文件行数）；此处**防御性**
 * 以源文本行数为准，缺失的源行补一条空行，避免"预览少了一行"这种静默错位。
 * 含全角空格的行标记在行上（保存告警的行内指示）。
 *
 * `withReachability`：**未接入存档回放时必须为 false**。没有分支链数据时，
 * 数据层会把每个块都折成 `reachable`（无覆盖链 = 无条件输出），那是"**不可
 * 判定**"而非"可达"——宁可不显示，也不误导作者（内核铁律：不静默）。
 */
export function buildPreviewRows(
  result: SugarPreviewResult | null,
  source: string,
  withReachability = true,
): PreviewRow[] {
  const sourceLines = source.split('\n');
  // 源末尾若有换行，split 会产生一个空尾元素——那不是真实的"行"
  // （与 `countLines` 及数据层 `buildLines` 同口径，否则预览会多出一条幻影空行）
  if (sourceLines.length > 0 && sourceLines[sourceLines.length - 1] === '') sourceLines.pop();
  const fullwidth = new Set(fullwidthSpaceLines(source));
  const byLine = new Map<number, SugarPreviewLine>();
  if (result) for (const l of result.lines) byLine.set(l.sourceLine, l);

  const rows: PreviewRow[] = [];
  for (let i = 0; i < sourceLines.length; i++) {
    const lineNo = i + 1;
    const text = sourceLines[i]!;
    const mapped = byLine.get(lineNo);
    const blocks = mapped?.messageBlocks ?? [];
    const reach = withReachability ? foldReachability(blocks) : ZERO_REACH;
    rows.push({
      key: `L${lineNo}`,
      sourceLine: lineNo,
      sourceText: text,
      blank: text.trim().length === 0,
      generatedLines: mapped ? [...mapped.generatedLines] : [],
      generatedLabel: generatedLabel(mapped?.generatedLines ?? []),
      messageBlocks: blocks,
      reach,
      reachClass: reachabilityClass(reach),
      reachLabel: reachabilityLabel(reach),
      hasFullwidthSpace: fullwidth.has(lineNo),
    });
  }
  return rows;
}

/* ============================== 概要 ============================== */

export interface PreviewSummary {
  /** 糖源码行数（与预览请求的同源文本一致） */
  sourceLines: number;
  /** 产物行数 */
  generatedLines: number;
  /** 诊断总数 */
  diagnostics: number;
  errors: number;
  warnings: number;
  /** 有产物映射的糖行数 */
  mappedLines: number;
  /** 产物中纯结构行数（数据层提供） */
  structuralLines: number;
  /** 消息块总数 */
  blocks: number;
  unreachableBlocks: number;
  unknownBlocks: number;
  /** 含全角空格的行数 */
  fullwidthLines: number;
}

/** 行数统计（末尾换行不额外计入一行；与编辑器 `lineNumbers` 口径一致） */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

export function summarize(
  result: SugarPreviewResult | null,
  source: string,
  withReachability = true,
): PreviewSummary {
  const rows = buildPreviewRows(result, source, withReachability);
  const diags = buildDiagnosticRows(result?.transpile.diagnostics);
  let blocks = 0;
  let unreachableBlocks = 0;
  let unknownBlocks = 0;
  for (const r of rows) {
    blocks += r.reach.reachable + r.reach.unreachable + r.reach.unknown;
    unreachableBlocks += r.reach.unreachable;
    unknownBlocks += r.reach.unknown;
  }
  return {
    sourceLines: countLines(source),
    generatedLines: result ? countLines(result.transpile.erb) : 0,
    diagnostics: diags.length,
    errors: diags.filter((d) => d.severity === 'error').length,
    warnings: diags.filter((d) => d.severity === 'warning').length,
    mappedLines: rows.filter((r) => r.generatedLines.length > 0).length,
    structuralLines: result ? result.structuralLines.length : 0,
    blocks,
    unreachableBlocks,
    unknownBlocks,
    fullwidthLines: fullwidthSpaceLines(source).length,
  };
}

/* ============================== 存档选择（三向映射的前置） ============================== */

/** 存档下拉选项（来源：`snapshot.source` 的浅解析扫描结果） */
export interface ArchiveOption {
  path: string;
  fileName: string;
  /** 人读标签（文件名 + 大小） */
  label: string;
  size: number;
}

/** 字节 → 人读大小（10.5KB 级即可；不引入单位库） */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 扫描结果 → 存档下拉选项。
 *
 * **只收浅解析成功的档**（`meta !== null && !error`）——坏档照样列出来会让作者
 * 选了才发现不能回放；直接不列，且（扫描结果自带 `error`）在别处显式提示。
 * 无项目 / 无存档目录 → `scan` 为空 / null → 空列表（下拉禁用，面板转入两向映射）。
 */
export function buildArchiveOptions(scan: SnapshotScanResult | null): ArchiveOption[] {
  return (scan?.entries ?? [])
    .filter((e) => e.meta !== null && !e.error)
    .map((e) => ({
      path: e.path,
      fileName: e.fileName,
      size: e.size,
      label: `${e.fileName}（${formatSize(e.size)}）`,
    }));
}

/** 存档接入状态（三向映射是否真的可用） */
export interface ArchiveStatus {
  /** 是否接入了回放（`SugarPreviewResult.archive !== null`） */
  connected: boolean;
  /** 短标签（徽章用；未接入 = `未接`） */
  who: string;
  /** 未接入时的说明（否则空串） */
  hint: string;
}

export function archiveStatus(result: SugarPreviewResult | null): ArchiveStatus {
  const a = result?.archive;
  if (!a) {
    return { connected: false, who: '未接', hint: '未接入存档回放——可达性不可判定（下方不显示可达徽章）' };
  }
  const who = a.characterName ? `${a.characterName} #${a.characterNo}` : `#${a.characterNo}`;
  return { connected: true, who, hint: '' };
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

/* ============================== 降级 / 文件判定 ============================== */

export type PreviewDegrade =
  | 'no-project'
  | 'no-file'
  | 'not-kojo'
  | 'reading'
  | 'previewing'
  | 'read-error'
  | 'preview-error';

const DEGRADE_TEXT: Record<PreviewDegrade, string> = {
  'no-project': '打开项目并选择一个 .kojo 文件后可用',
  'no-file': '打开一个 .kojo 文件后可用',
  'not-kojo': '当前文件不是 .kojo（转译检查只对 .kojo 文件有意义）',
  reading: '读取源文件中…',
  previewing: '生成预览中…',
  'read-error': '读取源文件失败',
  'preview-error': '预览生成失败',
};

export function degradeText(d: PreviewDegrade): string {
  return DEGRADE_TEXT[d];
}

/** 是否 `.kojo` 表层语法源文件（大小写不敏感；与编译器入口口径一致） */
export function isKojoFile(path: string | null | undefined): boolean {
  if (!path) return false;
  return path.toLowerCase().endsWith('.kojo');
}