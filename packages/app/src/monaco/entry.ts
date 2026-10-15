/**
 * Monaco 装配点（**唯一**；禁第二份）。
 *
 * ## 清单来源（钉死，改版先改这里）
 *
 * 下面的 import 段**逐条抄自** `monaco-editor@0.57.0` 的
 * `esm/vs/editor/editor.main.js` 的**非语言 import 段**（contrib + `codeEditorWidget` +
 * coreCommands 等）——抄它、别自创：那一段是 monaco 上游对「编辑器本体该带哪些 contrib」
 * 的权威答案。只做三处**减法**（依据 `docs/BOARD.md` §D「文件类型保留面」四档）：
 *
 * - **不引** `languages/definitions/**` 全量注册（C 档 ~79 门砍；本仓语言面由
 *   erb/kojo 自备 tokenizer 覆盖）；
 * - **不引** `languages/features/**` 四门重型 feature（json 400 KB / html 704 KB /
 *   css 1.1 MB / typescript 6.8 MB worker；B 档全砍）与 `external/monaco-lsp-client`；
 * - **不引** 两行裸 `codicon.css` 子路径（L99/L165）：本包 exports 只有
 *   `./* → ./esm/vs/*.js`，`.css` 会被机械补成不存在的 `*.css.js`（Vite 解析 NULL，
 *   构建直接挂）。两份 css 已由本清单内的 `standaloneGotoSymbolQuickAccess.js`
 *   自带相对 import（其 L1/L2）**原样带入**，不丢样式、也无需往 vite.config 加别名。
 *
 * ## 保留面（§D 四档）
 *
 * - **A 档**：`markdown` / `ini` / `xml` 三门轻量 `register.js` 单独引入（每门 ≈1 KB，
 *   tokenizer 懒加载、**不带 worker**）；
 * - **B 档**：`.json` 高亮由 `./json-language` 自写微型 Monarch 顶替（注册语言 id `json`，
 *   不引 worker）；
 * - 其余见上「不引」。
 *
 * ## 维护纪律
 *
 * - 升级 monaco-editor（**精确钉版，见 app/package.json**）时：重新对照新版
 *   `editor.main.js` 的非语言段，逐条差量更新本文件——漂了就漂在你眼前，别让清单停留在旧版；
 * - 全仓（`packages/app/src`）只许从本文件取 monaco：`EditorPane.tsx` 与 `monaco/*.ts`
 *   的 import 全部指向这里；`editor.worker` 的 `?worker` import 是 worker 装配，留在 EditorPane。
 */

/* ------------------------- A 档：轻量内置语言（保留面） ------------------------- */

import 'monaco-editor/languages/definitions/markdown/register.js';
import 'monaco-editor/languages/definitions/ini/register.js';
import 'monaco-editor/languages/definitions/xml/register.js';

/* ----------- 编辑器 contrib 段（抄自 editor.main.js L92–L165，逐条同序） ----------- */

import 'monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/caretOperations/browser/transpose.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/codeAction/browser/codeActionContributions.js';
import 'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js';
import 'monaco-editor/editor/contrib/codelens/browser/codelensController.js';
// L99 原是裸 `base/browser/ui/codicons/codicon/codicon.css`：exports 映射不可达（见文件头），
// 该 css 已由下方 standaloneGotoSymbolQuickAccess.js 的相对 import 带入 ⇒ 此处省略。
import 'monaco-editor/editor/contrib/colorPicker/browser/colorPickerContribution.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js';
import 'monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js';
import 'monaco-editor/editor/contrib/diffEditorBreadcrumbs/browser/contribution.js';
import 'monaco-editor/editor/contrib/dnd/browser/dnd.js';
import 'monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols.js';
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js';
import 'monaco-editor/features/find/register.js';
import 'monaco-editor/editor/contrib/floatingMenu/browser/floatingMenu.contribution.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/fontZoom/browser/fontZoom.js';
import 'monaco-editor/editor/contrib/format/browser/formatActions.js';
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js';
import 'monaco-editor/editor/contrib/gpu/browser/gpuActions.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js';
import 'monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution.js';
import 'monaco-editor/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.js';
import 'monaco-editor/editor/contrib/inlineProgress/browser/inlineProgress.js';
import 'monaco-editor/editor/contrib/inPlaceReplace/browser/inPlaceReplace.js';
import 'monaco-editor/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine.js';
import 'monaco-editor/editor/standalone/browser/inspectTokens/inspectTokens.js';
import 'monaco-editor/editor/standalone/browser/iPadShowKeyboard/iPadShowKeyboard.js';
import 'monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/editor/contrib/linkedEditing/browser/linkedEditing.js';
import 'monaco-editor/editor/contrib/links/browser/links.js';
import 'monaco-editor/editor/contrib/longLinesHelper/browser/longLinesHelper.js';
import 'monaco-editor/editor/contrib/middleScroll/browser/middleScroll.contribution.js';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js';
import 'monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js';
import 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js';
import 'monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js';
import 'monaco-editor/editor/contrib/rename/browser/rename.js';
import 'monaco-editor/editor/contrib/sectionHeaders/browser/sectionHeaders.js';
import 'monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js';
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js';
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2.js';
import 'monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestInlineCompletions.js';
import 'monaco-editor/editor/standalone/browser/toggleHighContrast/toggleHighContrast.js';
import 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js';
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization.js';
import 'monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js';
import 'monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js';
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js';
import 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js';
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/editor/common/standaloneStrings.js';
// L165 原是裸 `base/browser/ui/codicons/codicon/codicon-modifiers.css`：同上（exports 不可达，
// 已随 standaloneGotoSymbolQuickAccess.js 的相对 import 带入）⇒ 此处省略。

/* --------------------------- API 面（editor.api 全量） --------------------------- */

import * as monacoApi from 'monaco-editor/editor/editor.api';
import { registerJsonLanguage } from './json-language';

// B 档：`.json` 微型 Monarch（不用 languages/features/json 的 400 KB worker feature）
registerJsonLanguage(monacoApi);

export * from 'monaco-editor/editor/editor.api';
