/**
 * Kojo 2.0 **转到定义**的宿主面 —— B2 起只剩两件事：
 *
 * 1. **判据**：已搬 `@kojo/kojo-lang` 的 `definition.ts`（`kojo2DefinitionAt`），此处
 *    re-export，既有 import 点一字不改；
 * 2. **翻译**：把包交回的 `{line, column, endColumn}` 翻成 Monaco `LocationLink` /
 *    契约的 `EditorSymbolLocation`（`definitionTargetsToLocations`）。
 *
 * ## 为什么判据必须搬走
 *
 * 这条腿的**供方**是插件 `@kojo/plugin-kojo-lang`（它经 `ui.editor.languageService`
 * 槽的 `kind: 'definition'` 应答）。插件在 `packages/plugins/**`，看不见
 * `packages/app/src/**`；判据留在宿主 = 插件只能靠复制一份来应答 = 两份判据迟早漂移。
 *
 * ## 为什么翻译层留下
 *
 * `LocationLink` 是 Monaco 的形状，`EditorSymbolLocation` 是契约的形状，两者都不是
 * "语言事实"。把它们塞进包里会立刻违反包的三条硬约束（零 Monaco / 零 IO / 零游戏名词）。
 *
 * 注：2.0 的**展开视图**那两条追加落点（`expand-view.ts` 的 `via === 'definition'`）
 * 不在这里判——那是消费方拿到落点之后的 additive 追加，现由插件侧合成
 * （`@kojo/plugin-kojo-lang` 的 `definition` 贡献）。
 */
import type * as Monaco from './entry';
import type { EditorSymbolLocation } from '@kojo/plugin-api';
import { kojo2DefinitionAt, type Kojo2DefinitionTarget } from '@kojo/kojo-lang/definition';

export { kojo2DefinitionAt };
export type { Kojo2DefinitionTarget };

/**
 * 同文件定义落点 → 契约位置（**1 基、尾列半开**，与 `EditorSymbolLocation` 同口径）。
 *
 * `filePath` 由调用方给：判据只认"本文档里的哪一行哪一列"，"这是哪个文件"是身份问题，
 * 归宿主（派生 model / 糖投影下它不一定等于 `model.uri`）。
 */
export function definitionTargetsToLocations(
  filePath: string,
  target: Kojo2DefinitionTarget | undefined,
): EditorSymbolLocation[] {
  if (target === undefined) return [];
  return [
    {
      filePath,
      line: target.line,
      column: target.column,
      span: { columnStart: target.column, columnEnd: target.endColumn },
    },
  ];
}

/** 同文件定义落点 → Monaco `LocationLink`（`targetUri` 由调用方给，缺省 = `model.uri`） */
export function definitionTargetsToLinks(
  targetUri: Monaco.Uri,
  target: Kojo2DefinitionTarget | undefined,
): Monaco.languages.LocationLink[] {
  if (target === undefined) return [];
  const range: Monaco.IRange = {
    startLineNumber: target.line,
    startColumn: target.column,
    endLineNumber: target.line,
    endColumn: target.endColumn,
  };
  return [{ uri: targetUri, range, targetSelectionRange: range }];
}
