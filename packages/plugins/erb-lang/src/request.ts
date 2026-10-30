/**
 * 这份请求是不是 ERB 的活。
 *
 * ## 判据顺序（契约 `EditorDocumentIdentity` 立的规矩，别倒过来）
 *
 * 1. **有 `languageId` 就以它为准**：宿主从 `ITextModel.getLanguageId()` 原样递来，那是
 *    "这份缓冲区此刻按哪门语言着色 / 补全"的**唯一事实**。派生 model（糖投影、注入子语言、
 *    无标题缓冲）的扩展名与它不一致是常态。
 *    认的 id 清单位于 `@kojo/erb-lang/constants`（`'kojo-erb'` 是宿主
 *    `ERB_LANGUAGE_ID`，`'erb'` 是短形式——注入子语言与 `inline-completion-local` 都用它）；
 *    清单与宿主常量的一致性由 `packages/app/tests/erb-highlight-selection.test.ts` 对拍。
 * 2. 没有 `languageId`（旧宿主 / 直调）才退回按**路径**认：`.erb` / `.erm` / `.erh`
 *    大小写不敏感，判据取契约层 `isErbDialectPath`（方言扩展名的单一真源，不在这里
 *    另抄一份清单）。
 *
 * 不认 ⇒ `undefined`（**弃权**），不是空结果。两者的差别是可见性：弃权让下一家供方
 * 接手，空结果会让作者看到"这里确实没有可高亮的东西"。
 */
import { isErbDialectPath } from '@kojo/plugin-api';
import { ERB_LANGUAGE_IDS } from '@kojo/erb-lang/constants';

export function isErbRequest(request: {
  readonly languageId?: string;
  readonly path: string;
}): boolean {
  if (request.languageId !== undefined) return ERB_LANGUAGE_IDS.includes(request.languageId);
  return isErbDialectPath(request.path);
}
