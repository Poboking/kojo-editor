import type { SearchMatch, SearchProgress, SearchResult } from '../bridge/search';
import type { ReplaceOutcome } from './search-store';

/**
 * 全文检索面板的**纯逻辑**（无 React、无 IPC）：扩展名过滤的双向换算、命中行预览切分、
 * 结果摘要与扁平化。抽出来的理由与 `problem-store.ts` / `notice-queue.ts` 同一做法——
 * 这是数据判据，不是渲染细节；只有独立成模块才钉得住（渲染层在 node 环境跑不了）。
 */

/**
 * 默认检索的文件类型：引擎脚本族（含作者自写的 `kojo` 面）+ 表格/文本。
 * 这是**引擎级**词表（跨游戏通用），不含任何具体游戏的约定。
 */
export const DEFAULT_SEARCH_EXTENSIONS = ['erb', 'erh', 'erd', 'kojo', 'txt', 'csv', 'als'] as const;

/** 过滤框的初始文本（与 `DEFAULT_SEARCH_EXTENSIONS` 同源，不各写一份） */
export const DEFAULT_EXTENSION_TEXT = DEFAULT_SEARCH_EXTENSIONS.join(', ');

/**
 * 过滤框文本 → 扩展名列表：逗号（半/全角）、分号、空白都当分隔符；
 * 去前导点、转小写、去重、排序（排序让"同一份输入"恒产出同一个请求，判据可钉）。
 */
export function parseExtensions(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[,，;；\s]+/)) {
    const ext = raw.trim().toLowerCase().replace(/^\.+/, '');
    if (ext !== '') seen.add(ext);
  }
  return [...seen].sort();
}

/** 列表 → 过滤框文本（回填用；与 `parseExtensions` 往返一致） */
export function formatExtensions(list: readonly string[]): string {
  return list.join(', ');
}

/** 查询是否可发（全空白不发：发给后端只会拿一条"检索词为空"回来） */
export function isValidSearchQuery(query: string): boolean {
  return query.trim() !== '';
}

/** 短路径（与问题面板同口径）：取末两段——检索结果面板窄，末两段是唯一的区分点 */
export function shortSearchPath(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.slice(-2).join('/');
}

/**
 * 命中行预览 → 三段（命中前 / 命中 / 命中后）。
 * 偏移越界一律夹回串内：Rust 侧算得再准，也不该让一个坏载荷把界面炸掉。
 */
export function previewParts(m: SearchMatch): { head: string; hit: string; tail: string } {
  const len = m.preview.length;
  const start = Math.max(0, Math.min(m.start, len));
  const end = Math.max(start, Math.min(m.end, len));
  return {
    head: m.preview.slice(0, start),
    hit: m.preview.slice(start, end),
    tail: m.preview.slice(end),
  };
}

/** 结果行的位置标签（`行:列`，与问题面板的 `路径:行` 同族但更细一档） */
export function matchLocationLabel(m: SearchMatch): string {
  return `${m.line}:${m.column}`;
}

/** 扁平化后的结果行：文件头 + 其下各命中（渲染层按此列表画，不需再懂结构） */
export type SearchRow =
  | { kind: 'file'; path: string; count: number }
  | { kind: 'match'; path: string; match: SearchMatch };

/**
 * 结果 → 扁平行列表（`cap` 是渲染上限：上万行 DOM 会拖垮面板，与问题面板同精神）。
 * 文件头也算一行——被裁掉的可能是整块的命中，界面要能说清"还有多少没显示"。
 */
export function flattenSearchResults(
  files: readonly { path: string; matches: readonly SearchMatch[] }[],
  cap: number,
): { rows: SearchRow[]; hidden: number } {
  const rows: SearchRow[] = [];
  for (const f of files) {
    rows.push({ kind: 'file', path: f.path, count: f.matches.length });
    for (const m of f.matches) rows.push({ kind: 'match', path: f.path, match: m });
  }
  if (rows.length <= cap) return { rows, hidden: 0 };
  return { rows: rows.slice(0, cap), hidden: rows.length - cap };
}

/** 结果摘要（停止态与完成态分开说——"停下来的结果"不该看起来像"搜完了"） */
export function searchSummaryText(r: SearchResult): string {
  const prefix = r.cancelled ? '已停止：' : '';
  const seconds = (r.elapsedMs / 1000).toFixed(1);
  return `${prefix}${r.totalMatches} 条结果 · ${r.files.length} 个文件 · 扫描 ${r.filesScanned} 个文件 · ${seconds}s`;
}

/** 需要显式说明的边角（截断 / 各类跳过）；无则 null */
export function searchNoticeText(r: SearchResult): string | null {
  const notes: string[] = [];
  if (r.truncated) notes.push('结果已达上限，未列全');
  if (r.skipped.binary > 0) notes.push(`跳过 ${r.skipped.binary} 个二进制文件`);
  if (r.skipped.tooLarge > 0) notes.push(`跳过 ${r.skipped.tooLarge} 个超大文件`);
  if (r.skipped.unreadable > 0) notes.push(`${r.skipped.unreadable} 个文件读取失败`);
  if (r.skipped.filtered > 0) notes.push(`${r.skipped.filtered} 个文件被类型过滤挡下`);
  return notes.length > 0 ? notes.join(' · ') : null;
}

/** 检索中的进度文案（总数为 0 时只报已扫描数，不假装知道总量） */
export function searchProgressText(p: SearchProgress): string {
  return p.totalFiles > 0
    ? `检索中… 已扫描 ${p.filesScanned}/${p.totalFiles} 个文件 · 命中 ${p.matchCount}`
    : `检索中… 已扫描 ${p.filesScanned} 个文件 · 命中 ${p.matchCount}`;
}

/**
 * 替换汇总文案（R7 搜索替换批）。逐文件跳过的只读文件、文本已变化而跳过的命中、
 * 写失败的文件——每一类都要上屏（铁律 4：不静默），作者替换完第一眼就该知道
 * 「改了什么、有什么没改成」。
 */
export function replaceSummaryText(o: ReplaceOutcome): string {
  if (o.applied === 0 && o.stale === 0 && o.readOnlyFiles === 0 && o.errors.length === 0) {
    return '没有需要替换的命中（文本可能已是新值）';
  }
  const parts: string[] = [];
  if (o.applied > 0) {
    parts.push(o.filesChanged > 1 ? `已替换 ${o.applied} 处（${o.filesChanged} 个文件）` : `已替换 ${o.applied} 处`);
  }
  if (o.stale > 0) parts.push(`${o.stale} 处文本已变化，跳过`);
  if (o.readOnlyFiles > 0) parts.push(`${o.readOnlyFiles} 个文件只读未改`);
  if (o.errors.length > 0) parts.push(...o.errors.slice(0, 3));
  if (o.errors.length > 3) parts.push(`另有 ${o.errors.length - 3} 个文件写入失败`);
  return parts.join(' · ');
}
