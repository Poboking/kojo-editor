/**
 * 项目层的**排序/定位单源**：分析结果、诊断、槽位分配表全部经这里排序。
 *
 * 为什么单独一枚：项目级输出必须"输入顺序无关"——同一份事实无论以什么顺序注入，
 * 分桶、诊断、槽位分配结果都要逐条相同（测试靠打乱输入顺序钉死）。排序判据若在
 * `analysis.ts` / `storage.ts` 各写一份，两份迟早对不上（诊断里出现两种次序 = 噪声）。
 *
 * 口径：码元序比较（不用 `localeCompare`：确定性、无 locale 依赖、快），
 * 同键时保留注入顺序（稳定），无落点（span=null）排最后。
 */
import type { KojoSpan } from '../ast.js';
import type { KojoDiagnostic } from '../diagnostics.js';
import { comparePositions } from '../positions.js';

/** 排序所需的最小坐标事实：来源文件 + 源区间（无落点 = null） */
export interface Located {
  readonly filePath: string;
  readonly span: KojoSpan | null;
}

/** 码元序比较（<0 / 0 / >0） */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** span 比较：同一文件内按（起点, 终点）；无落点排最后 */
export function compareNullableSpan(a: KojoSpan | null, b: KojoSpan | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return comparePositions(a.start, b.start) || comparePositions(a.end, b.end);
}

/** 定位比较：先文件路径，再 span */
export function compareLocated(a: Located, b: Located): number {
  return compareText(a.filePath, b.filePath) || compareNullableSpan(a.span, b.span);
}

/** 稳定排序副本（不改入参）：文件路径 → span → 注入序 */
export function sortLocated<T extends Located>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => compareLocated(a.item, b.item) || a.index - b.index)
    .map((entry) => entry.item);
}

/** 人读位置：`路径:行:列`；无落点只给路径 */
export function formatLocation(item: Located): string {
  const start = item.span?.start;
  return start ? `${item.filePath}:${start.line}:${start.column}` : item.filePath;
}

/** 诊断统一排序：span（无落点最后）→ code → message → 注入序（稳定） */
export function sortDiagnostics(diagnostics: readonly KojoDiagnostic[]): KojoDiagnostic[] {
  return diagnostics
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        compareNullableSpan(a.entry.span, b.entry.span) ||
        compareText(String(a.entry.code), String(b.entry.code)) ||
        compareText(a.entry.message, b.entry.message) ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
}
