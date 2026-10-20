import type * as Monaco from './entry';
import { errorText } from '@kojo/plugin-api';
import type {
  EditorFoldingRange,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import { clampMonacoLine } from './positions';
import { registerForLanguageServices } from './register-dialects';

/**
 * 折叠区间的**宿主接线**（D3，2026-10-15 折叠/面包屑批）。
 *
 * 与 `kojo-symbols` 同款分层：**纯逻辑**（合并 / 三态 / 抛错隔离 / 去重 / 行号夹取）
 * 与 **Monaco 协议翻译**分开，前者可单测。宿主**不认识** `IF` / `时机` / `@` 函数——
 * 区间全部来自 `ui.editor.languageService` 槽（ERB 由解析器答、`.kojo` 由表层 DSL 线答），
 * 宿主只翻成 Monaco 的 `FoldingRange` 并按模型现实夹取。
 */

/**
 * 合并全部贡献方的折叠区间。
 *
 * 隔离与去重口径同 `collectDocumentSymbols`（单枚贡献抛错不让整篇折叠消失）。
 * **并集**安全：两路贡献方按路径互斥（ERB 方言 vs `.kojo`）；同区间去重防两枚贡献
 * 报同一块时 gutter 出现双箭头。
 */
export function collectFoldingRanges(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest,
): EditorFoldingRange[] {
  const out: EditorFoldingRange[] = [];
  const seen = new Set<string>();
  for (const contribution of contributions) {
    let result: ReturnType<EditorLanguageServiceContribution['provide']>;
    try {
      result = contribution.provide(request);
    } catch (e: unknown) {
      console.warn(
        `[kojo-folding] '${contribution.id}' provide 抛错：${errorText(e)}`,
      );
      continue;
    }
    // `undefined` = 不认这个请求；空数组 = 认但整篇无可折块（两种都不加东西）
    if (!result || result.kind !== 'foldingRange') continue;
    for (const range of result.ranges) {
      const key = `${range.startLine}\u0000${range.endLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(range);
    }
  }
  return out;
}

/**
 * 契约区间 → Monaco `FoldingRange`。
 *
 * 行号一律**夹取到模型现实**（陈旧/越界区间不该让折叠崩）；夹完 `end <= start`
 * 的区间**丢弃**——没有可隐藏的行，留着只会让 gutter 出一个折不动的假箭头。
 * 排序按起点升序、同起点按终点降序（外层块在前，gutter 呈现稳定）。
 */
export function toMonacoFoldingRanges(
  model: Monaco.editor.ITextModel,
  ranges: readonly EditorFoldingRange[],
): Monaco.languages.FoldingRange[] {
  const lineCount = model.getLineCount();
  const out: Monaco.languages.FoldingRange[] = [];
  const seen = new Set<string>();
  for (const range of ranges) {
    const start = clampMonacoLine(range.startLine, lineCount);
    const end = clampMonacoLine(range.endLine, lineCount);
    if (end <= start) continue;
    const key = `${start}\u0000${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ start, end });
  }
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  return out;
}

/** 宿主注入：怎么问（含糖视图 / 活动标签判据） */
export interface FoldingRangeHandlers {
  resolve(model: Monaco.editor.ITextModel): EditorFoldingRange[];
}

/**
 * 为 ERB 方言与 `.kojo` 两种语言 id 注册 foldingRange provider。
 *
 * 注册 provider 后 Monaco 的折叠策略（缺省 `auto`）自动改用供给器而非缩进猜测——
 * 这正是 D3 的目的：ERB 原文不缩进，缩进折叠在其上几乎无效。
 */
export function installFoldingRangeProvider(
  monaco: typeof Monaco,
  handlers: FoldingRangeHandlers,
): Monaco.IDisposable {
  const provider: Monaco.languages.FoldingRangeProvider = {
    provideFoldingRanges(model) {
      let ranges: EditorFoldingRange[];
      try {
        ranges = handlers.resolve(model);
      } catch (e: unknown) {
        // 折叠是只读呈现面：出错就"没有折叠"，绝不把编辑器带崩
        console.warn(`[kojo-folding] resolve 抛错：${errorText(e)}`);
        return [];
      }
      return toMonacoFoldingRanges(model, ranges);
    },
  };
  return registerForLanguageServices(monaco, (m, id) => m.languages.registerFoldingRangeProvider(id, provider));
}
