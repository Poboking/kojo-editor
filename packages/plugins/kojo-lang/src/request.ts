/**
 * 这份请求是不是 `kojo2` 的活。
 *
 * ## 判据顺序（契约 `EditorDocumentIdentity` 立的规矩，别倒过来）
 *
 * 1. **有 `languageId` 就以它为准**：宿主从 `ITextModel.getLanguageId()` 原样递来，
 *    那是"这份缓冲区此刻按哪门语言着色 / 补全"的**唯一事实**。派生 model（糖投影、
 *    无标题缓冲）的路径扩展名与它不一致是常态。
 * 2. 没有 `languageId`（旧宿主 / 直调 / **槽 `ui.editor.codeAction`**——它的请求只有
 *    `path`）才退回按扩展名认：**`.kojo`（LAU-3b-FLIP 起的主场）与 `.kojo2`（旧名兼容）**，
 *    大小写不敏感（Windows 上作者手敲 `.KOJO` 完全可能；语言 id 侧已是宿主归一后的小写）。
 *    v1 的 `.kojo1` 不匹配（它就不是这个后缀）。
 *
 * 不认 ⇒ `undefined`（**弃权**），不是空结果。两者的差别是可见性：弃权让下一家供方
 * 接手，空结果会让作者看到"这里确实没有定义"。codeAction 槽没有 `undefined` 这一态，
 * 那一路把弃权写成 `[]`（见 `src/code-actions.ts` 的头注）。
 */
import { KOJO2_LANGUAGE_ID, KOJO2_SOURCE_EXTENSION } from '@kojo/kojo-lang/constants';
import { KOJO_SOURCE_EXTENSION } from '@kojo/plugin-api';

export function isKojo2Request(request: {
  readonly languageId?: string;
  readonly path: string;
}): boolean {
  if (request.languageId !== undefined) return request.languageId === KOJO2_LANGUAGE_ID;
  const lower = request.path.toLowerCase();
  return (
    lower.endsWith(KOJO_SOURCE_EXTENSION) || lower.endsWith(KOJO2_SOURCE_EXTENSION)
  );
}
