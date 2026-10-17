import type * as Monaco from './entry';
import { documentWordItems } from './document-words';
import { kojoWordCompletionItems } from './kojo-completion-words';
import { KOJO_LANGUAGE_ID } from './kojo-language';

/**
 * QSUG-2 · `.erb` 的文档词候选。
 *
 * 位置门（字符串 / 注释 / 指令记号 / 名字槽白名单）在 ERB 装配的 `locate` 与 `keep` 里；
 * 本路只负责取词。`.kojo` 原生区会**路由**进 ERB 装配（同一份 provider 管线），那时
 * model 的 languageId 仍是 `.kojo` ⇒ 交给糖侧词门（台词 / 旁白不取词），不按 ERB 正文扫。
 */
export function erbWordCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  range: Monaco.IRange,
): Monaco.languages.CompletionItem[] {
  let languageId: string | undefined;
  try {
    languageId = typeof model.getLanguageId === 'function' ? model.getLanguageId() : undefined;
  } catch {
    languageId = undefined;
  }
  if (languageId === KOJO_LANGUAGE_ID) {
    return kojoWordCompletionItems(monaco, model, position, range);
  }
  return documentWordItems(monaco, model, position, range, 'erb');
}
