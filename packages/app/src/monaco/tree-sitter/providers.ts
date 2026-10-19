import type * as Monaco from '../entry';
import { sugarEnterRulePatterns } from '@kojo/plugin-kojo-sugar';
import { LARGE_FILE_LINES } from '../../ui/editor-options';
import { applyNameColorPref, loadNameColorPref, subscribeNameColorPref } from '../../ui/semantic-color-pref';
import { loadTreeSitterPref, subscribeTreeSitterPref } from '../../ui/tree-sitter-pref';
import { toMonacoFoldingRanges } from '../kojo-folding';
import { KOJO_LANGUAGE_ID } from '../kojo-language';
import { reportStructureDegradation, resetStructureDegradationLedger } from './fallback';
import { mergeIndentConfig } from './indent';
import { KOJO_STRUCTURE_LEGEND, encodeStructureTokens } from './semantic';
import type { StructureClient } from './client';
import type { KojoStructureFold } from './types';

/**
 * 结构解析叠层的**装配与闸门**（全仓唯一持有这枚开关状态的地方）。
 *
 * ## 关 = 逐字不变（这条是硬要求，代码形状就是为它设计的）
 *
 * `installKojoStructureOverlay()` 只做两件事：读一次偏好、订一张订阅表。偏好为关时
 * **`./client` 连 import 都不发生**（装配在 `activate()` 里动态取，worker 与两枚 wasm
 * 因此不在主线程静态图里），并且：
 * - 一枚 provider 都不注册；
 * - 一个编辑器选项都不写（含 `semanticHighlighting.enabled`——见下面「着色开关的归属」）；
 * - 一份语言配置都不重发；
 * - 一条线程都不 spawn。
 * 换句话说：默认状态下这条线与不存在等价，`tests/kojo-token-tiers.test.ts` 那份真 Monarch
 * 编译与既有折叠/着色行为一个字都没被碰过。
 *
 * ## 开 = 叠加，不是替换
 *
 * - **着色**：`registerDocumentSemanticTokensProvider`（Monarch 仍是底 tokenizer）；
 *   结构层对这份文档没有结果时**返回 null**，让「定义与调用的名字分色」那枚 provider 应答，
 *   两者互不吞并；同开且结构层有结果时以结构层为准（Monaco 对同一优先级的多枚
 *   document semantic tokens provider 取"第一个交得出结果的"，注册晚 = 排在前面）。
 * - **折叠**：`registerFoldingRangeProvider`；Monaco 把同语言的**多枚折叠供给器的结果并起来**
 *   （`syntaxRangeProvider.js::collectSyntaxRanges`）⇒ 既有折叠照旧，结构折叠是增量。
 * - **缩进**：`setLanguageConfiguration` 只写 `onEnterRules` / `indentationRules` 两个属性
 *   （Monaco 按属性组合、没写的属性回落基底那份），并且只在结构层真的给出规则时才写。
 *
 * ## 着色开关的归属（两枚偏好共写同一个 Monaco 选项，必须有唯一的写的人）
 *
 * `editor.semanticHighlighting.enabled` 今天由「定义与调用的名字分色」独占（`EditorPane`
 * 挂载与翻开关时写）。本特性同开时也要用它，于是**叠层开着的那段时间**由这里统一写
 * `名字分色 || 结构解析`，并监听每枚编辑器的配置变化把它按同一条判据顶回去
 * （`updateOptions` 对同值不产生变更事件 ⇒ 一来一回就收敛，不会来回打架）；
 * 关掉叠层时把选项**还原成名字分色自己的值**并撤掉全部监听，写的人回到原来那一个。
 * 这一步是"不静默"的一部分：不写就等于结构着色悄悄没影。
 */

/** 叠层总状态（模块级单例：装配点调一次，其余全靠订阅表驱动） */
let monacoRef: typeof Monaco | null = null;
let installed = false;
let active = false;
/** 是否已经"接管过"着色选项（从未开过时 = false ⇒ 一个编辑器选项都不写） */
let ownsHighlightingOption = false;
let client: StructureClient | null = null;
const registrations: Monaco.IDisposable[] = [];
const optionHooks: Monaco.IDisposable[] = [];
let appliedIndentKey: string | null = null;
let indentDisposable: Monaco.IDisposable | null = null;

/** 结构层这一路的体量闸：与语义着色同一档（全文级开销同开同关，判据只留一处） */
const STRUCTURE_MAX_LINES = LARGE_FILE_LINES;

/** 大文档不由结构层顶上（说一次，别每击键重复） */
function noteSizeSkip(kind: 'semantic' | 'folds'): void {
  reportStructureDegradation({
    capability: kind,
    stage: 'parse',
    message: `超过 ${STRUCTURE_MAX_LINES} 行的文件这次不由结构层顶上（与语义着色同一档降级，回到原有做法）`,
  });
}

/** 当前该开着着色选项吗（两枚偏好任一为真） */
function highlightingWanted(): boolean {
  return loadTreeSitterPref() || loadNameColorPref();
}

/**
 * 写 `editor.semanticHighlighting.enabled` 的**唯一**动作。
 *
 * 走 `applyNameColorPref` 而不是在本文件再抄一遍那个键名（真源仍是 `semantic-color-pref.ts`，
 * 两处各写各的早晚漂）。类型面收窄一次并写明理由：standalone 的编辑器实例实际都是
 * `IStandaloneCodeEditor`（它的 `updateOptions` 才接这个全局键），而
 * `monaco.editor.getEditors()` / `onDidCreateEditor` 的公开签名只给 `ICodeEditor`。
 */
function writeOptionOn(editor: Monaco.editor.ICodeEditor, on: boolean): void {
  applyNameColorPref(editor as Monaco.editor.IStandaloneCodeEditor, on);
}

function writeHighlightingOption(): void {
  if (!monacoRef || !ownsHighlightingOption) return;
  const value = highlightingWanted();
  for (const editor of monacoRef.editor.getEditors()) writeOptionOn(editor, value);
}

/** 接管期间：任何一次配置变化都按同一条判据顶回去（同值写回不产生事件 ⇒ 收敛不打架） */
function hookEditor(editor: Monaco.editor.ICodeEditor): void {
  writeOptionOn(editor, highlightingWanted());
  optionHooks.push(editor.onDidChangeConfiguration(() => writeHighlightingOption()));
}

function installHighlightingOptionOwnership(): void {
  if (!monacoRef || ownsHighlightingOption) return;
  ownsHighlightingOption = true;
  for (const editor of monacoRef.editor.getEditors()) hookEditor(editor);
  optionHooks.push(monacoRef.editor.onDidCreateEditor((editor) => hookEditor(editor)));
  // 名字分色翻动时也要重算这条**合并**判据（两枚偏好共写同一个 Monaco 选项，写的人只能有一个）
  optionHooks.push({ dispose: subscribeNameColorPref(() => writeHighlightingOption()) });
}

function releaseHighlightingOptionOwnership(): void {
  for (const hook of optionHooks) hook.dispose();
  optionHooks.length = 0;
  if (!monacoRef || !ownsHighlightingOption) return;
  ownsHighlightingOption = false;
  // 还原成「名字分色」自己那一份判据的结果——本特性退场后不该留下任何痕迹
  const value = loadNameColorPref();
  for (const editor of monacoRef.editor.getEditors()) writeOptionOn(editor, value);
}

/* ------------------------------- provider ------------------------------- */

function structureSemanticProvider(monaco: typeof Monaco): Monaco.languages.DocumentSemanticTokensProvider {
  return {
    getLegend: () => KOJO_STRUCTURE_LEGEND,
    async provideDocumentSemanticTokens(model, _resultId, token) {
      if (!active || model.getLanguageId() !== KOJO_LANGUAGE_ID) return null;
      if (token.isCancellationRequested) return null;
      if (model.getLineCount() > STRUCTURE_MAX_LINES) {
        noteSizeSkip('semantic');
        return null;
      }
      if (client === null) return null; // worker 模块还在动态取的路上 ⇒ 这一次只有词法层
      let tokens: Awaited<ReturnType<StructureClient['tokens']>> | null;
      try {
        tokens = await client.tokens(model);
      } catch (error: unknown) {
        reportStructureDegradation({
          capability: 'semantic',
          stage: 'parse',
          message: `结构着色取数失败 ⇒ 回落词法层：${error instanceof Error ? error.message : String(error)}`,
        });
        return null;
      }
      if (!active || token.isCancellationRequested) return null;
      syncIndentConfig();
      if (tokens === null || tokens.length === 0) return null;
      const encoded = encodeStructureTokens(tokens, {
        lineCount: model.getLineCount(),
        maxColumn: (lineNumber) => model.getLineMaxColumn(lineNumber),
      });
      if (encoded.droppedRows + encoded.droppedEmpty + encoded.droppedWide + encoded.droppedOverlaps > 0) {
        reportStructureDegradation({
          capability: 'semantic',
          stage: 'parse',
          message: `结构着色丢掉 ${encoded.droppedRows} 条越界行 / ${encoded.droppedEmpty} 条空区间 / ${encoded.droppedWide} 条超宽跨度 / ${encoded.droppedOverlaps} 条同行重叠`,
        });
      }
      if (encoded.data.length === 0) return null;
      return { data: encoded.data };
    },
    releaseDocumentSemanticTokens: () => undefined,
  };
}

function structureFoldingProvider(monaco: typeof Monaco): Monaco.languages.FoldingRangeProvider {
  return {
    async provideFoldingRanges(model) {
      if (!active || model.getLanguageId() !== KOJO_LANGUAGE_ID || client === null) return [];
      if (model.getLineCount() > STRUCTURE_MAX_LINES) {
        noteSizeSkip('folds');
        return [];
      }
      let folds: readonly KojoStructureFold[] | null;
      try {
        folds = await client.foldingRanges(model);
      } catch (error: unknown) {
        reportStructureDegradation({
          capability: 'folds',
          stage: 'parse',
          message: `结构折叠取数失败 ⇒ 回落词法折叠：${error instanceof Error ? error.message : String(error)}`,
        });
        return [];
      }
      if (!active || folds === null || folds.length === 0) return [];
      // 0 基行号 → 模型坐标（1 基闭区间），夹取与去重复用 `kojo-folding` 那份（口径只有一处）
      return toMonacoFoldingRanges(
        model,
        folds.map((fold) => ({ startLine: fold.startRow + 1, endLine: fold.endRow + 1 })),
      );
    },
  };
}

/** 缩进：只在结构层真的给了规则、且规则与上次不同时才重发语言配置 */
function syncIndentConfig(): void {
  const monaco = monacoRef;
  if (!monaco || !active || client === null) return;
  const merged = mergeIndentConfig(sugarEnterRulePatterns(), client.indent);
  if (merged === null) {
    if (indentDisposable !== null) {
      indentDisposable.dispose();
      indentDisposable = null;
      appliedIndentKey = null;
    }
    return;
  }
  if (merged.key === appliedIndentKey) return;
  if (merged.rejected > 0) {
    reportStructureDegradation({
      capability: 'indent',
      stage: 'query',
      message: `结构层给了 ${merged.rejected} 条非法正则 ⇒ 这几条丢掉，原有回车规则不变`,
    });
  }
  indentDisposable?.dispose();
  indentDisposable = monaco.languages.setLanguageConfiguration(KOJO_LANGUAGE_ID, {
    onEnterRules: merged.onEnterRules.map((rule) => ({
      beforeText: rule.beforeText,
      action: { indentAction: monaco.languages.IndentAction.Indent },
    })),
    indentationRules: {
      increaseIndentPattern: merged.increaseIndentPattern,
      decreaseIndentPattern: merged.decreaseIndentPattern,
    },
  });
  appliedIndentKey = merged.key;
}

/* --------------------------------- 闸门 --------------------------------- */

async function activate(monaco: typeof Monaco): Promise<void> {
  if (active) return;
  active = true;
  resetStructureDegradationLedger(); // 重新翻开 = 允许再说一次（台账只为"同一次启用里别刷屏"）
  installHighlightingOptionOwnership();
  try {
    const mod = await import('./client');
    if (!active) return; // 翻回关了（快速来回切），不再建线程
    client = new mod.StructureClient({
      onFatal: () => {
        // 整档停用：拆 provider（回到只有词法层），偏好**不动**（作者没说要关）
        if (active) deactivate();
      },
    });
    registrations.push(monaco.languages.registerDocumentSemanticTokensProvider(KOJO_LANGUAGE_ID, structureSemanticProvider(monaco)));
    registrations.push(monaco.languages.registerFoldingRangeProvider(KOJO_LANGUAGE_ID, structureFoldingProvider(monaco)));
    // worker 与两枚 wasm 只在真的被问到时才起（这里不预先 start，翻开开关不等于要解一份文档）
  } catch (error: unknown) {
    reportStructureDegradation({
      capability: 'all',
      stage: 'wasm',
      message: `结构解析模块装载失败：${error instanceof Error ? error.message : String(error)}`,
    });
    deactivate();
  }
}

function deactivate(): void {
  for (const registration of registrations) registration.dispose();
  registrations.length = 0;
  indentDisposable?.dispose();
  indentDisposable = null;
  appliedIndentKey = null;
  client?.dispose();
  client = null;
  active = false;
  releaseHighlightingOptionOwnership();
}

/**
 * 装配点唯一入口（`monaco/entry.ts` 动态取本模块后调用一次）。
 *
 * 关着时这个函数**只读一次偏好、只挂一张订阅表**——它不动 Monaco 的任何注册面。
 */
export function installKojoStructureOverlay(monaco: typeof Monaco): void {
  if (installed) return;
  installed = true;
  monacoRef = monaco;
  if (loadTreeSitterPref()) void activate(monaco);
  subscribeTreeSitterPref(() => {
    const on = loadTreeSitterPref();
    if (on && !active) void activate(monaco);
    else if (!on && active) deactivate();
  });
}

/** 测试与拆毁用：把单例回到未装配状态（跨 kernel 不留悬账，同 `disposeGlobalProviders` 的口径） */
export function disposeKojoStructureOverlay(): void {
  if (active) deactivate();
  client = null;
  installed = false;
  monacoRef = null;
}

/** 当前状态（诊断与 A/B 测试用；不在作者面展示） */
export function kojoStructureOverlayState(): { installed: boolean; active: boolean; client: string | null } {
  return { installed, active, client: client?.state ?? null };
}
