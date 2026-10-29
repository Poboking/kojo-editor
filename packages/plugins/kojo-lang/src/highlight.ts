/**
 * `documentHighlight` 供方：包里的同符号高亮判据（`@kojo/kojo-lang/highlight`）→
 * 契约的 `EditorDocumentHighlightResult`（B3f，2026-10-29）。
 *
 * ## 这一格回答什么
 *
 * 光标所在的同文件符号在本文件的哪些地方出现，每处是**声明** / **代码面引用** /
 * **叙事正文里的同名词**。位置门（字符串字面量 / `@原生` 围栏 / 注释 / 表体数据行
 * 不算引用）全在包里，本文件只做"三档值域同名搬运"与语言分派。
 *
 * ## 三态（与 hover / signatureHelp / references 同一条纪律）
 *
 * - **非 kojo2 请求 ⇒ `undefined`（弃权）**：宿主那枚 provider 也挂在别的语言上（共享收口
 *   按 descriptor 铺语言），弃权让它交回空列表、**不**去顶掉那门语言自己的高亮 provider；
 * - **认这门语言 ⇒ 总是作答**：`highlights: []` = 光标下没有可高亮的符号（**不是**弃权）——
 *   与宿主 `undefined` 那条歧路同 hover：混了之后兜底会在"这里确实没有符号"处冒出来；
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
import { kojo2DocumentHighlights } from '@kojo/kojo-lang/highlight';
import { isKojo2Request } from './request';

/** 交回 `{ kind: 'documentHighlight', highlights }`，或 `undefined`（弃权：不是这个 kind / 不是 kojo2） */
export function provideDocumentHighlights(
  request: EditorLanguageServiceRequest,
): EditorDocumentHighlightResult | undefined {
  if (request.kind !== 'documentHighlight') return undefined;
  if (!isKojo2Request(request)) return undefined;
  try {
    const highlights: EditorDocumentHighlight[] = kojo2DocumentHighlights(request.text, {
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
