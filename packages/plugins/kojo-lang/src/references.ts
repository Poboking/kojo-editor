/**
 * `references` 供方：包里的引用判据（`@kojo/kojo-lang/references`）→ 契约的
 * `EditorReferencesResult`（B3e，2026-10-29）。
 *
 * ## 这一格回答什么
 *
 * 请求里的 `text` 是**请求文件**的全文；`projectFiles`（additive，缺席 = 只答这一篇）是
 * 项目内其他文档的快照。两条腿共用同一个入口
 * `kojo2ReferencesInProjectFiles`：
 * - 本文有同名声明 / 事件挂点时，走同文件判据（`kojo2ReferencesAt` 的原样结果）；
 * - 本文没有时，用项目快照的候选位 + 声明种类把位置对到项目符号上（同名多家族 ⇒ 不猜，空结果）。
 *
 * 跨文件与同文件**不可能各说一套**：快照索引的每个文件事实都是用同一枚
 * `kojo2ReferenceSymbolsOf` / `kojo2ReferenceCandidatesOf` 建的（见包内那条注释）。
 *
 * ## 三态（与 hover / signatureHelp / formatting 同一条纪律）
 *
 * - **非 kojo2 请求 ⇒ `undefined`（弃权）**：宿主侧那枚 provider 也挂在别的语言上（共享收口
 *   按 descriptor 铺语言），弃权让它交回空列表、**不**去顶掉那门语言自己的引用 provider；
 * - **认这门语言 ⇒ 总是作答**：`locations: []` = 这处没有可证引用（**不是**弃权）；
 * - 快照不完整（`projectFilesComplete === false`）⇒ 照样作答，但结果置 `truncated: true`
 *   如实说"少给了"——绝不把不完整快照当完整项目下"没有别的引用"的结论。
 *
 * ## 产物形状
 *
 * 一条出现点 → `EditorSymbolLocation`：`filePath` 表达跨文件（本文落点 = `request.path`），
 * `line` / `column` / `span` 来自包的 1 基区间，`kind` 走契约的三档
 * （`decl → definition` / `call → call` / `ref → mention`）。
 */
import type {
  EditorLanguageServiceRequest,
  EditorReferencesResult,
  EditorSymbolLocation,
} from '@kojo/plugin-api';
import {
  kojo2ReferencesInProjectFiles,
  type Kojo2ReferenceSiteKind,
} from '@kojo/kojo-lang/references';
import { isKojo2Request } from './request';

/** 包的三种角色 → 契约的中性类别（宿主只按它区分声明位 / 调用位 / 普通提及） */
function symbolKindOf(kind: Kojo2ReferenceSiteKind): 'definition' | 'call' | 'mention' {
  if (kind === 'decl') return 'definition';
  if (kind === 'call') return 'call';
  return 'mention';
}

/** 交回 `{ kind: 'references', locations }`，或 `undefined`（弃权：不是 references / 不是 kojo2） */
export function provideReferences(
  request: EditorLanguageServiceRequest,
): EditorReferencesResult | undefined {
  if (request.kind !== 'references') return undefined;
  if (!isKojo2Request(request)) return undefined;
  try {
    const path = request.path.length > 0 ? request.path : undefined;
    // 快照口把**请求文件自己**放在第一位：索引里的那份可能是 400ms 防抖之前的旧文本，
    // 而请求里的 `text` 是作者此刻的缓冲区。跨文件侧的 `excludePath` 仍会把它排除，
    // 只在"本文件没有声明、这里是一处引用位"时用它判本地落点。
    const files =
      request.projectFiles === undefined
        ? undefined
        : path === undefined
          ? request.projectFiles
          : [{ path, text: request.text }, ...request.projectFiles];
    const result = kojo2ReferencesInProjectFiles(
      request.text,
      { line: request.line, column: request.column },
      files,
      path === undefined ? {} : { path },
    );
    if (result === null) return { kind: 'references', locations: [] };
    const locations: EditorSymbolLocation[] = result.refs.map((site) => ({
      filePath: site.path ?? request.path,
      line: site.span.startLine,
      column: site.span.startColumn,
      span: {
        columnStart: site.span.startColumn,
        columnEnd: site.span.endColumn,
      },
      kind: symbolKindOf(site.kind),
    }));
    // 两条"少给"的来源合流：单次结果上限（本文件 / 跨文件）与宿主快照不完整。
    const truncated = result.truncated || request.projectFilesComplete === false;
    return {
      kind: 'references',
      locations,
      ...(truncated ? { truncated: true } : {}),
    };
  } catch {
    // 读不到 / 解析意外 ⇒ 空结果（"这处没有可证引用"是作者能读懂的退化）。
    return { kind: 'references', locations: [] };
  }
}
