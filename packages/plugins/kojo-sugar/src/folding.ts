import type { EditorDocumentSymbol, EditorFoldingRange, SugarDoc } from '@kojo/plugin-api';
import { kojoDocumentSymbols } from './document-symbols';

/**
 * `.kojo` 折叠区间（D3，2026-10-15 折叠/面包屑批）。
 *
 * **糖的层级就是折叠层级**：时机块 / `如果…` / `是…`（分支）/ `选项` 条目…全部来自
 * `kojoDocumentSymbols` 的同一棵符号树摊平——不建第二份解析，折叠与大纲/吸顶/面包屑
 * 共用同一棵 `loc` 树，行号天然与作者正在编辑的缓冲区逐行对齐。
 *
 * 只收 `endLine > startLine` 的节点（单行块无可隐藏内容）；区间可嵌套/重叠，
 * 宿主只夹取与去重，不解释层次。
 */
export function kojoFoldingRanges(doc: SugarDoc): EditorFoldingRange[] {
  const out: EditorFoldingRange[] = [];
  const walk = (symbols: readonly EditorDocumentSymbol[]): void => {
    for (const symbol of symbols) {
      if (symbol.endLine > symbol.startLine) out.push({ startLine: symbol.startLine, endLine: symbol.endLine });
      if (symbol.children !== undefined && symbol.children.length > 0) walk(symbol.children);
    }
  };
  walk(kojoDocumentSymbols(doc));
  return out;
}
