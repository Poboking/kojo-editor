/**
 * `documentHighlight` 供方：包里的同符号高亮判据（`@kojo/erb-lang/highlight`）→
 * 契约的 `EditorDocumentHighlightResult`（LAU-4 第一步，2026-10-30）。
 *
 * ## 这一格回答什么
 *
 * 光标所在的同文件符号在本文件的哪些地方出现，每处是**声明** / **代码面引用** /
 * **不参与解析的同名提及**。判据（位置门 / 字符串与注释 / `[SKIPSTART]` 死区 /
 * 函数与标签槽）全在包里，本文件只做"三档值域同名搬运"与语言分派。
 *
 * ## 三态（与 kojo2 的同名供方同一条纪律）
 *
 * - **非 ERB 请求 ⇒ `undefined`（弃权）**：宿主那枚 provider 也挂在别的语言上（共享收口按
 *   descriptor 铺语言），弃权让它交回空列表、**不**去顶掉那门语言自己的高亮 provider；
 * - **认这门语言 ⇒ 总是作答**：`highlights: []` = 光标下没有可高亮的符号（**不是**弃权）
 *   ——混了之后兜底会在"这里确实没有符号"处冒出来；
 * - 判据抛错（坏输入 / 词法意外）⇒ 空结果（作者能读懂的退化），不让异常穿回宿主。
 *
 * 档位**原样搬运**（包与契约同名同值域 `text | read | write`）：映射到 Monaco
 * `DocumentHighlightKind` 是宿主的事，供方这里不做第二套语义。
 */
import type {
  EditorDocumentHighlight,
  EditorDocumentHighlightResult,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import { erbDocumentHighlights } from '@kojo/erb-lang/highlight';
import { isErbRequest } from './request';

/** 交回 `{ kind: 'documentHighlight', highlights }`，或 `undefined`（弃权：不是这个 kind / 不是 ERB） */
export function provideDocumentHighlights(
  request: EditorLanguageServiceRequest,
): EditorDocumentHighlightResult | undefined {
  if (request.kind !== 'documentHighlight') return undefined;
  if (!isErbRequest(request)) return undefined;
  try {
    const highlights: EditorDocumentHighlight[] = erbDocumentHighlights(request.text, {
      line: request.line,
      column: request.column,
    }).map((highlight) => ({
      line: highlight.range.startLine,
      startColumn: highlight.range.startColumn,
      endColumn: highlight.range.endColumn,
      kind: highlight.kind,
    }));
    return { kind: 'documentHighlight', highlights };
  } catch {
    // 读不到 / 解析意外 ⇒ 空结果（"这里没有可高亮的符号"是作者能读懂的退化）。
    return { kind: 'documentHighlight', highlights: [] };
  }
}
