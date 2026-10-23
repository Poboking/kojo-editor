import type { EditorDocumentSymbol } from '@kojo/plugin-api';
import { enclosingChainAt } from '@kojo/plugin-api';

/**
 * 侧栏大纲（批次十 S9）的**纯逻辑**：符号树 → 可渲染的扁平行序、光标行定位。
 *
 * 数据源与面包屑 / 吸顶同一棵 `documentSymbol` 树（ERB 与 `.kojo2` 各有 provider，
 * 宿主不解析任何格式）；本文件只做"树 → 行"的收窄与定位，零 React、零 DOM。
 *
 * 行序 = **先序遍历**：父在子前，`depth` 即层级缩进。兄弟按起始行排序（稳定排序，
 * 同一行保留 provider 给的文档序——ERB 的"函数在前、声明在后"就靠这一条原样成立）。
 *
 * 光标定位**不另立判据**：区间包含、平局折法、畸形树下行全部复用契约层的
 * `enclosingChainAt`（与面包屑 / 跳状态 / 调用层级同一条尺子），这里只在扁平行序里
 * 按**符号引用**找回那一行——引用相等即同一枚节点，不会把同名的另一段认成它。
 */

/** 一条大纲行（已按先序扁平化；`symbol` 是树上的原始节点，供光标定位按引用比对） */
export interface OutlineRow {
  /** 渲染键（先序序号；树同形即稳定） */
  readonly id: string;
  readonly name: string;
  readonly detail: string | null;
  readonly kind: EditorDocumentSymbol['kind'];
  readonly startLine: number;
  readonly endLine: number;
  /** 0 = 顶层；每深一层 +1（宿主据此算缩进） */
  readonly depth: number;
  /** 树上的原始节点（不参与渲染，仅供 {@link locateOutlineRow} 按引用定位） */
  readonly symbol: EditorDocumentSymbol;
}

/**
 * 符号树 → 先序扁平行。
 *
 * 兄弟按 `startLine` 稳定排序：provider 给的树理论上已是文档序，这里再排一次是
 * 为了让"换 provider / 索引派生树"来的乱序也落到同一条阅读顺序上；稳定排序保证
 * 起始行相同的节点保持原相对次序（ERB 同名行上函数先于声明的那条口径不被打乱）。
 */
export function buildOutlineRows(symbols: readonly EditorDocumentSymbol[]): OutlineRow[] {
  const rows: OutlineRow[] = [];
  let ordinal = 0;
  const walk = (nodes: readonly EditorDocumentSymbol[], depth: number): void => {
    const ordered = [...nodes].sort((a, b) => a.startLine - b.startLine);
    for (const node of ordered) {
      rows.push({
        id: `r${ordinal++}`,
        name: node.name,
        detail: node.detail ?? null,
        kind: node.kind,
        startLine: node.startLine,
        endLine: node.endLine,
        depth,
        symbol: node,
      });
      const children = node.children;
      if (children && children.length > 0) walk(children, depth + 1);
    }
  };
  walk(symbols, 0);
  return rows;
}

/**
 * 光标行（1 基，模型坐标）→ 应当高亮的那一行（`-1` = 光标不在任何符号内，**不猜**）。
 *
 * `rows` 必须由同一棵 `symbols` 经 {@link buildOutlineRows} 生成（按引用找回）：
 * 传进来两棵不同的树时返回 `-1`，而不是靠名字/行号硬配——
 * 那种"看起来对"的配对正是把作者导到别处的来源。
 */
export function locateOutlineRow(
  rows: readonly OutlineRow[],
  symbols: readonly EditorDocumentSymbol[],
  line: number,
): number {
  const chain = enclosingChainAt(symbols, line);
  if (chain.length === 0) return -1;
  const target = chain[chain.length - 1]!;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.symbol === target) return i;
  }
  return -1;
}

/** 大纲行序的**等值键**（同键 = 视觉无变化；光标每动一次不该白刷一次 React） */
export function outlineRowsKey(rows: readonly OutlineRow[]): string {
  return rows
    .map((row) => `${row.depth}\u0000${row.startLine}\u0000${row.endLine}\u0000${row.name}\u0000${row.detail ?? ''}`)
    .join('\u0001');
}
