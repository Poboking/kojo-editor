/**
 * `definition` 供方：包里的同文件落点 → 契约的 `EditorSymbolLocation`。
 *
 * ## 为什么只交**同文件**落点
 *
 * `@kojo/kojo-lang` 的 `kojo2DefinitionAt` 只回答"名字 → 本文档哪一行哪一列"。
 * 跨文件（跳进别的 `.kojo2`、跳进 `ERB/` 里的定义）需要**项目索引**，而索引是
 * 宿主 / 另一个服务的事——本供方没有它，就不假装有：交回空数组而不是猜一个位置。
 *
 * ## 为什么不用 `project`
 *
 * 请求里带着 `project`（游戏事实），但这条腿一个字段都不读。保持"零游戏知识"不是
 * 洁癖：一旦读了 `project`，这个包就得跟着 adapter 的演进改，而它本来只认识语言。
 */
import type { EditorLanguageServiceRequest, EditorSymbolLocation } from '@kojo/plugin-api';
import { kojo2DefinitionAt } from '@kojo/kojo-lang/definition';
import { isKojo2Request } from './request';

/**
 * 交回 `{ kind: 'definition', locations }`，或 `undefined`（弃权）。
 *
 * 抛错面：`kojo2DefinitionAt` 是纯函数且对越界行列自行夹取，理论上不抛；真抛了也
 * **不让它冒到宿主**——宿主会把 throw 吞成"F12 没反应"，那是作者看不到任何原因的
 * 假死。这里归成空数组（"这篇没有可跳的声明"），与"此处没有定义"同一个可见语义。
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
  if (target === undefined) return { kind: 'definition', locations: [] };
  return {
    kind: 'definition',
    locations: [
      {
        filePath: request.path,
        line: target.line,
        column: target.column,
        // 名字段区间：`columnStart` 与 `column` 同值（落点在名字首列），`columnEnd` 半开。
        span: { columnStart: target.column, columnEnd: target.endColumn },
      },
    ],
  };
}
