/**
 * `definition` 供方：包里的同文件落点 → 契约的 `EditorSymbolLocation`。
 *
 * ## 交什么
 *
 * 1. **声明落点**（`kojo2DefinitionAt`）：名字 → 本文档哪一行哪一列，落在名字段上；
 * 2. **展开体的两条附加落点**（B3b）：光标在展开体源行上（`view.via === 'definition'`）时，
 *    在声明落点之后追加"调用处"与"定义段"——
 *
 *    | 落点 | 是什么 | 形状 |
 *    | --- | --- | --- |
 *    | 调用处 | 这一行是被哪个 `! 名` 展开出来的 / 哪个 `@随机` 派生的 | 单行 |
 *    | 定义段 | 模板 / 池声明头到体末（随机块 = 块本身） | **跨行**（契约的 `range`） |
 *
 *    光标在**调用行**上时不加这两条——那时作者的意图是"这个名字定义在哪"，
 *    与声明落点重合，多给两条只会让 F12 变成多选。
 *
 * ## 为什么这两条也能住插件里
 *
 * 它们要的输入只有两样：源文（请求里就有）和**那一次编译的成品**。成品在 B3a 之前
 * 只有宿主拿得到（面板私有的编译缓存），B3a 把登记表搬进了 `@kojo/kojo-lang`
 * （`expand-compile.ts`），于是这里 `kojo2ExpandCompilationFor(request.path)` 一问就有。
 * **零注册 ⇒ `null` ⇒ 不追加**，与"宿主还没编译过这一篇"逐字一致。
 *
 * ## 为什么只交**同文件**落点
 *
 * `kojo2DefinitionAt` 只回答"名字 → 本文档哪一行哪一列"。跨文件（跳进别的 `.kojo2`、
 * 跳进 `ERB/` 里的定义）需要**项目索引**，而索引是宿主 / 另一个服务的事——本供方没有它，
 * 就不假装有：交回空数组而不是猜一个位置。展开落点同理，全在当前文件内。
 *
 * ## 为什么不用 `project`
 *
 * 请求里带着 `project`（游戏事实），但这条腿一个字段都不读。保持"零游戏知识"不是
 * 洁癖：一旦读了 `project`，这个包就得跟着 adapter 的演进改，而它本来只认识语言。
 */
import type {
  EditorDefinitionRequest,
  EditorLanguageServiceRequest,
  EditorSymbolLocation,
} from '@kojo/plugin-api';
import type { KojoSpan } from '@kojo/kojo-core';
import { kojo2DefinitionAt } from '@kojo/kojo-lang/definition';
import { kojo2ExpandCompilationFor } from '@kojo/kojo-lang/expand-compile';
import { expandViewAt } from '@kojo/kojo-lang/expand-view';
import { isKojo2Request } from './request';

/**
 * 展开段的一个 span → 契约落点。
 *
 * `line` / `column` 取**起点**（走事件通道那条腿时只读得到这两个，位置不会错）；
 * 整段交给 `range`（Peek 里框住全段）。`span` 给零宽：`range` 在场时落点判据不读它，
 * 而在没有 `range` 的老消费方眼里它就是"只把光标放到这一列"，**不猜终点**。
 */
function expandLocationOf(filePath: string, span: KojoSpan): EditorSymbolLocation {
  return {
    filePath,
    line: span.start.line,
    column: span.start.column,
    span: { columnStart: span.start.column, columnEnd: span.start.column },
    range: {
      startLine: span.start.line,
      startColumn: span.start.column,
      endLine: span.end.line,
      endColumn: span.end.column,
    },
  };
}

/**
 * 交回 `{ kind: 'definition', locations }`，或 `undefined`（弃权）。
 *
 * 抛错面：`kojo2DefinitionAt` / `expandViewAt` 都是纯函数且对越界行列自行夹取，
 * 理论上不抛；真抛了也**不让它冒到宿主**——宿主会把 throw 吞成"F12 没反应"，
 * 那是作者看不到任何原因的假死。这里归成空数组（"这篇没有可跳的声明"），
 * 与"此处没有定义"同一个可见语义。
 *
 * 展开那一段**单独兜一层**：它挂了不许把已经算出来的声明落点一起带走
 * （宿主当年在 `expandViewFor` 上就是这么分的，口径照搬）。
 */
export function provideDefinition(
  request: EditorLanguageServiceRequest,
): { kind: 'definition'; locations: EditorSymbolLocation[] } | undefined {
  if (request.kind !== 'definition') return undefined;
  if (!isKojo2Request(request)) return undefined;
  let target;
  try {
    target = kojo2DefinitionAt({
      source: request.text,
      line: request.line,
      column: request.column,
    });
  } catch {
    return { kind: 'definition', locations: [] };
  }
  const locations: EditorSymbolLocation[] = [];
  if (target !== undefined) {
    locations.push({
      filePath: request.path,
      line: target.line,
      column: target.column,
      // 名字段区间：`columnStart` 与 `column` 同值（落点在名字首列），`columnEnd` 半开。
      span: { columnStart: target.column, columnEnd: target.endColumn },
    });
  }
  locations.push(...expandLocationsOf(request));
  return { kind: 'definition', locations };
}

/** 展开体的两条附加落点（取不到成品 / 光标不在展开体源行上 ⇒ 空数组，不猜） */
function expandLocationsOf(request: EditorDefinitionRequest): EditorSymbolLocation[] {
  try {
    const compilation = kojo2ExpandCompilationFor(request.path);
    if (compilation === null) return [];
    const view = expandViewAt(
      compilation.compiled,
      compilation.sourceMapModel,
      { line: request.line, column: request.column },
      { source: request.text },
    );
    if (view.kind !== 'expand' || view.via !== 'definition') return [];
    return [expandLocationOf(request.path, view.callSite), expandLocationOf(request.path, view.definition)];
  } catch {
    return [];
  }
}
