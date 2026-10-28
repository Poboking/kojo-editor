/**
 * `hover` 供方：包里的悬停事实（`@kojo/kojo-lang/hover`）+ 展开视图（`expand-view`）
 * → 契约的 `EditorHoverResult`（**单答**能力：第一家给出 `contents` 的说了算）。
 *
 * ## B3c：这一格从"宿主原生 provider"换成了"插件供方"
 *
 * 判据全部住在包里（`kojo2HoverAt` / `kojo2HoverMarkdown` 是纯搬家，正文措辞逐字不动；
 * 展开段的判据是 `expandViewAt` + `expandViewMarkdown`，编译成品经 `expand-compile` 登记表
 * **请求时现取**），本文件只做翻译：两段事实 → 一条 `contents`。
 *
 * ## 两段 Markdown 合成**一条** `contents`（本批唯一被允许的呈现差量）
 *
 * 今天宿主交回的是 Monaco `Hover.contents` **数组的两个 part**（声明段 + 展开段，
 * `'\n\n'` 天然分段）；契约的 `EditorHoverResult.contents` 是**一枚字符串**，于是两段以
 * `'\n\n'` 相连成一条——**正文逐字相同**，差别只在 Monaco 从"两个 part"变成"一个 part 两段"。
 * 为什么仍用同一枚 provider 追加而不新造第二个 HoverProvider：理由与今天一样——
 * Monaco 多 provider 的合并顺序不可控（这条写在 `expand-view.ts` 头注）。
 *
 * ## 三态（悬停侧的"分家"）
 *
 * - 非 kojo2 请求 / 不是 hover ⇒ `undefined`（**弃权**，下一家接手）；
 * - 认这篇但此处**两段都没有事实** ⇒ 同样 `undefined`——**不是** `{ contents: '' }`：
 *   空串＝作答（契约"单答"口径），会把本该接手的下一家顶掉；
 * - 有任一段 ⇒ 作答（`format: 'markdown'`，正文今天就是 Markdown，声明这格保持渲染口径）。
 *
 * ## 展开段的纪律（与今天宿主逐字一致）
 *
 * - **只有 `via === 'call-site'` 才追加**：光标在展开体源行上（`via === 'definition'`）时
 *   作者要看的是"这一行是谁展开出来的"——那是转定义那条腿（两条 `LocationLink`），
 *   不在悬停里再贴一遍同样的产物；
 * - 编译成品经 `kojo2ExpandCompilationFor(request.path)` 现取：**取不到 ⇒ 只有声明段**，
 *   绝不二次编译、不猜（零登记零行为，与"作者还没停手 / 这份还没编译成功"逐字一致）；
 * - 展开段**单独兜一层**：它挂了不许把已经算出来的声明段一起带走（宿主今天在
 *   `expandViewFor` 上就是这么分的，口径照搬）；声明段同理反向独立。
 *
 * ## adapter：请求时现取 + 只认 id 对得上的那一枚
 *
 * `# 机` / `@织` 事件名的悬停讲的是**方言事实**（`eventCatalog`），由 `plugin.ts` 经登记表
 * 现取并核过 `adapter.id === request.project?.adapterId` 才递进来。对不上 ⇒ `null` ⇒
 * 事件名不给悬停（**不猜**），其余声明事实照旧——少给的是那一部分。
 *
 * ## `range` 的口径（1 基、尾列半开，与契约 `EditorLanguageRange` 同规）
 *
 * - 有声明段 ⇒ 名字段区间（`hover.startColumn/endColumn`，引用处是引用词、声明处是名字段；
 *   与今天宿主逐字同格）；
 * - 只有展开段 ⇒ 调用处 span（`@随机` 块头这类没有声明事实的位置）。契约的 range 是**单行**
 *   形状，而 `call-site` span 按构造就是单行（触发语句行 / 随机块头行，`expand-view.ts` 的
 *   `randomAnchorOf` 起于同一行），行取 `start.line`、列取 `start.column..end.column`；
 * - 两段都没有 ⇒ 整个应答缺席（见上），不存在"作答但不给 range"的中间态。
 */
import type {
  EditorHoverRequest,
  EditorLanguageRange,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
// 只取**类型**：2.0 adapter 的形状住 core，运行时不 import `@kojo/kojo-core`（同 `inlay.ts`）。
import type { GameAdapter } from '@kojo/kojo-core';
import { kojo2ExpandCompilationFor } from '@kojo/kojo-lang/expand-compile';
import { expandViewAt, expandViewMarkdown } from '@kojo/kojo-lang/expand-view';
import { kojo2HoverAt, kojo2HoverMarkdown } from '@kojo/kojo-lang/hover';
import { isKojo2Request } from './request';

/** 可选注入面（缺省 = 事件名不给悬停，其余事实照旧——不猜） */
export interface HoverAdapterInjection {
  /** 当前项目的 2.0 adapter（`plugin.ts` 请求时现取并核过 id；对不上 ⇒ `null`） */
  readonly adapter?: GameAdapter | null;
}

/** 悬停应答（`format` 固定 `'markdown'`：正文今天就是 Markdown，这里只是把口径写进契约格）。 */
export type Kojo2HoverAnswer = {
  readonly kind: 'hover';
  readonly contents: string;
  readonly format: 'markdown';
  readonly range?: EditorLanguageRange;
};

/** 声明段（`undefined` = 此处没有声明事实；取段抛错也归 `undefined`，不冒到宿主）。 */
function declarationSegmentOf(
  request: EditorHoverRequest,
  adapter: GameAdapter | null,
): { readonly markdown: string; readonly range: EditorLanguageRange } | undefined {
  try {
    const hover = kojo2HoverAt(
      { source: request.text, line: request.line, column: request.column },
      { adapter },
    );
    if (hover === undefined) return undefined;
    return {
      markdown: kojo2HoverMarkdown(hover),
      range: { line: request.line, startColumn: hover.startColumn, endColumn: hover.endColumn },
    };
  } catch {
    return undefined;
  }
}

/** 展开段（`null` = 这一轮没有展开事实：取不到成品 / 视图不命中 / 不是调用行 / 抛错）。 */
function expandSegmentOf(
  request: EditorHoverRequest,
): { readonly markdown: string; readonly range: EditorLanguageRange } | null {
  try {
    const compilation = kojo2ExpandCompilationFor(request.path);
    if (compilation === null) return null;
    const view = expandViewAt(
      compilation.compiled,
      compilation.sourceMapModel,
      { line: request.line, column: request.column },
      { source: request.text },
    );
    if (view.kind !== 'expand' || view.via !== 'call-site') return null;
    return {
      markdown: expandViewMarkdown(view).value,
      range: {
        line: view.callSite.start.line,
        startColumn: view.callSite.start.column,
        endColumn: view.callSite.end.column,
      },
    };
  } catch {
    return null;
  }
}

/**
 * 交回一条 `EditorHoverResult` 形态的应答，或 `undefined`（弃权 / 两段都没有事实）。
 *
 * 段的顺序固定：声明段在前、展开段在后（与今天宿主 contents 数组的序逐字相同）。
 */
export function provideHover(
  request: EditorLanguageServiceRequest,
  injection: HoverAdapterInjection = {},
): Kojo2HoverAnswer | undefined {
  if (request.kind !== 'hover') return undefined;
  if (!isKojo2Request(request)) return undefined;
  const declaration = declarationSegmentOf(request, injection.adapter ?? null);
  const expand = expandSegmentOf(request);
  if (declaration === undefined && expand === null) return undefined;
  const parts: string[] = [];
  if (declaration !== undefined) parts.push(declaration.markdown);
  if (expand !== null) parts.push(expand.markdown);
  const range = declaration !== undefined ? declaration.range : expand?.range;
  return {
    kind: 'hover',
    contents: parts.join('\n\n'),
    format: 'markdown',
    ...(range === undefined ? {} : { range }),
  };
}
