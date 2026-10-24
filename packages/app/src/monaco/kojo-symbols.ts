import type * as Monaco from './entry';
import { errorText } from '@kojo/plugin-api';
import type {
  EditorDocumentSymbol,
  EditorDocumentSymbolKind,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import { registerForLanguageServices } from './register-dialects';

/**
 * 文档大纲的**宿主接线**（B3，2026-10-15 编辑器特性批）。
 *
 * 与 `kojo-definition` 同款分层：**纯逻辑**（合并 / 去重 / 抛错隔离 / 行号夹取 / 类别映射）
 * 与 **Monaco 绑定**分开，前者可单测、后者只做协议翻译。宿主**不认识**时机 / 段 / `@` 函数——
 * 大纲项全部来自 `ui.editor.languageService` 槽（ERB 由解析器答、`.kojo` 由表层 DSL 线答），
 * 宿主只把它们翻成 Monaco 的 `DocumentSymbol` 树（吸顶与"转到符号"用的就是这份树）。
 */

/** 类别 → Monaco 图标（**中性映射表**：契约只说"哪种层次"，宿主不解释它是什么语言结构） */
export function documentSymbolKindToMonaco(
  monaco: typeof Monaco,
  kind: EditorDocumentSymbolKind,
): Monaco.languages.SymbolKind {
  switch (kind) {
    case 'function':
      return monaco.languages.SymbolKind.Function;
    case 'section':
      return monaco.languages.SymbolKind.Namespace;
    case 'block':
      return monaco.languages.SymbolKind.Object;
    case 'declaration':
      return monaco.languages.SymbolKind.Variable;
  }
}

/**
 * 合并全部贡献方的大纲项。
 *
 * 隔离与去重口径同 `collectDefinitionLocations`（单枚贡献抛错不让整条大纲消失）。
 * **并集**在这里是安全的：两个贡献方按**路径**互斥（ERB 方言 vs `.kojo`），同一篇文档
 * 不会有两棵树；真出现重复项（同 name + 同区间）也只留一份，避免大纲里出现双胞胎。
 */
export function collectDocumentSymbols(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest,
): EditorDocumentSymbol[] {
  const out: EditorDocumentSymbol[] = [];
  const seen = new Set<string>();
  for (const contribution of contributions) {
    let result: ReturnType<EditorLanguageServiceContribution['provide']>;
    try {
      result = contribution.provide(request);
    } catch (e: unknown) {
      console.warn(
        `[kojo-symbols] '${contribution.id}' provide 抛错：${errorText(e)}`,
      );
      continue;
    }
    // `undefined` = 不认这个请求；空数组 = 认但整篇无结构（两种都不加东西）
    if (!result || result.kind !== 'documentSymbol') continue;
    for (const symbol of result.symbols) {
      const key = symbolKey(symbol);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(symbol);
    }
  }
  return out;
}

const symbolKey = (symbol: EditorDocumentSymbol): string =>
  `${symbol.name}\u0000${symbol.kind}\u0000${symbol.startLine}\u0000${symbol.endLine}`;

/**
 * 契约符号 → Monaco `DocumentSymbol`。
 *
 * 行号一律**夹取到模型现实**（陈旧/越界区间不该让大纲崩，也不该画出反过来的区间：
 * `end < start` 时按 `start` 收口）。列用整行（大纲项的粒度就是"这一段"）。
 */
export function toMonacoDocumentSymbols(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  symbols: readonly EditorDocumentSymbol[],
): Monaco.languages.DocumentSymbol[] {
  const lineCount = model.getLineCount();
  const clampLine = (line: number): number => Math.min(Math.max(1, Math.trunc(line) || 1), lineCount);
  const rangeOf = (startLine: number, endLine: number): Monaco.IRange => {
    const start = clampLine(startLine);
    const end = Math.max(start, clampLine(endLine));
    return {
      startLineNumber: start,
      startColumn: 1,
      endLineNumber: end,
      endColumn: model.getLineMaxColumn(end),
    };
  };
  return symbols.map((symbol) => {
    const children = symbol.children && symbol.children.length > 0
      ? toMonacoDocumentSymbols(monaco, model, symbol.children)
      : undefined;
    const range = rangeOf(symbol.startLine, symbol.endLine);
    return {
      name: symbol.name,
      detail: symbol.detail ?? '',
      kind: documentSymbolKindToMonaco(monaco, symbol.kind),
      tags: [],
      range,
      // 选区只到块头那一行：吸顶与"转到符号"定位的是块头，不是整块
      selectionRange: { ...range, endLineNumber: range.startLineNumber, endColumn: model.getLineMaxColumn(range.startLineNumber) },
      ...(children ? { children } : {}),
    };
  });
}

/** 宿主注入：怎么问（含糖视图 / 活动标签判据） */
export interface DocumentSymbolHandlers {
  resolve(model: Monaco.editor.ITextModel): EditorDocumentSymbol[];
}

/**
 * 为 ERB 方言与 `.kojo` 两种语言 id 注册 documentSymbol provider。
 *
 * 这份树同时喂两个内建能力：大纲/`转到符号`（Ctrl+Shift+O）与**粘性滚动**的贴顶行——
 * 后者正是 B3 要的"当前在哪个函数 / 哪个时机块里"。
 */
export function installDocumentSymbolProvider(
  monaco: typeof Monaco,
  handlers: DocumentSymbolHandlers,
): Monaco.IDisposable {
  const provider: Monaco.languages.DocumentSymbolProvider = {
    displayName: 'kojo',
    provideDocumentSymbols(model) {
      let symbols: EditorDocumentSymbol[];
      try {
        symbols = handlers.resolve(model);
      } catch (e: unknown) {
        // 大纲是只读呈现面：出错就"没有大纲"，绝不把编辑器带崩
        console.warn(`[kojo-symbols] resolve 抛错：${errorText(e)}`);
        return [];
      }
      return toMonacoDocumentSymbols(monaco, model, symbols);
    },
  };
  // B2：带上能力名 —— 声明了 `slotServices: ['documentSymbol']` 的语言（kojo2）
  // 也挂这一枚。它的供方是插件 `@kojo/plugin-kojo-lang`，宿主侧**零原生实现**。
  return registerForLanguageServices(
    monaco,
    (m, id) => m.languages.registerDocumentSymbolProvider(id, provider),
    'documentSymbol',
  );
}
