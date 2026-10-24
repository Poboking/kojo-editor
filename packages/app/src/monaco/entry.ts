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

/* ------------------------- 本地化（必须在一切 monaco 模块之前） ------------------------- */

// 用户反馈 7：原生右键菜单（剪切/复制/粘贴/转到定义/命令面板…）中文化。
// `nls/lang/zh-cn.js` 是 0.57 自带的**构建产物**（exports `./*` → `./esm/vs/*.js` 可解析），
// 它只做两件事：写 `globalThis._VSCODE_NLS_MESSAGES` 与 `_VSCODE_NLS_LANGUAGE='zh-cn'`。
// 位置是硬约束：`localize()` 在**模块顶层**就把文案取成常量（standaloneStrings 的
// `quickCommandActionLabel` 等），晚于 monaco 模块 import 就来不及——菜单会中英混杂。
// 本文件是唯一装配点，所以在这里、在下面所有 monaco import 之前落一次即可；worker 不进
// 这条模块图（`?worker` 由 Vite 单独打包），不受影响。
import 'monaco-editor/nls/lang/zh-cn.js';

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
// ZH-D4 回车缩进（on-type 兜底层）：provider 自带语言闸（认不出 id 就沉默），注册面留在装配点
// 一次性完成。格式化三枚 provider（整篇 / 区间 / ERB 区间）都走宿主 resolve 判据，一律由
// `ui/editor-global-providers.ts` 统一注册——装配点拿不到偏好读取与降级回调，不在这儿另开旁路。
import { installEnterIndenter } from './kojo-format';
// 回落台账（纯逻辑、零依赖）：静态引它只为"装载失败也要说出去"这一条路，
// 结构解析本体（worker + 两枚 wasm）全在下面的动态边界后面
import { reportStructureDegradation } from './tree-sitter/fallback';

// B 档：`.json` 微型 Monarch（不用 languages/features/json 的 400 KB worker feature）
registerJsonLanguage(monacoApi);
// 装配点这枚 on-type provider 与模块同寿（无宿主判据可依，也不随标签装卸），但**句柄必须留在原地**：
// 返回值一旦丢弃，重复装配就会挂两枚 provider 且没有任何回收入口。
// 区间格式化（`.kojo` 与 ERB 两枚）都带宿主 resolve 判据，注册面在 `ui/editor-global-providers.ts`。
const assemblyDisposables = [installEnterIndenter(monacoApi)];
void assemblyDisposables; // 与模块同寿：不回收，但句柄在此可见（不往 API 面加导出，entry 的类型面必须与 monaco 一致）

// 结构解析叠层（TSIT-M1，实验特性，**默认关**）：**动态取**装配模块。这一条 `import()`
// 是"关着时逐字不变"的落点——偏好为关时 `./tree-sitter/client`、那枚 worker 与两枚 wasm
// 一概不进主线程静态图，装配函数本身也只读一次偏好、挂一张订阅表，不注册任何 provider。
// 装载失败（懒 chunk 取不到）不许静默：经回落台账说一次，编辑器继续走词法层。
void import('./tree-sitter/providers')
  .then((m) => m.installStructureOverlay(monacoApi))
  .catch((error: unknown) => {
    reportStructureDegradation({
      capability: 'all',
      stage: 'wasm',
      message: `结构解析装配模块装载失败：${error instanceof Error ? error.message : String(error)}`,
    });
  });

export * from 'monaco-editor/editor/editor.api';
