import type * as Monaco from '../entry';
import type { StructureFacet } from '@kojo/kojo-core';
import '../languages';
import { LARGE_FILE_LINES } from '../../ui/editor-options';
import { applyNameColorPref, loadNameColorPref, subscribeNameColorPref } from '../../ui/semantic-color-pref';
import { loadTreeSitterPref, subscribeTreeSitterPref } from '../../ui/tree-sitter-pref';
import { toMonacoFoldingRanges } from '../kojo-folding';
import { languageDescriptors, descriptorForLanguageId, descriptorForPath, FALLBACK_LANGUAGE_ID, type LanguageDescriptor } from '../language-registry';
import { toMonacoLine } from '../positions';
import { reportStructureDegradation, resetStructureDegradationLedger } from './fallback';
import { mergeIndentConfig, type BaseIndentPatterns } from './indent';
import { createStructureSyntaxPresenter } from './syntax-decorations';
import type { StructureClient, StructureStatus } from './client';
import { lostStructureSpans, type StructureLanguageRuntime, type StructureSemanticFacet } from './structure-runtime';
import type { StructureSyntaxPresenter } from './syntax-decorations';
import type { KojoStructureFold } from './types';

/**
 * 结构解析叠层的**装配与闸门**（全仓唯一持有这枚开关状态的地方；A4 语言无关化）。
 *
 * ## 谁能挂上结构层：descriptor 说了算
 *
 * 候选语言 = 传进来的 descriptor 表（缺省 = `languages.ts` 的进程级注册表）里
 * **声明了 `structure`** 的那些。每门语言各有一条 worker 线程与一个 `StructureClient`
 * （一条线程只持一棵 CST）：左右分屏同时开 ERB 与 Kojo 时两条线程各管各的文档，
 * 不再互相换轨重解。同一门语言开两份文档时仍按原口径换轨（一条线程一棵树）。
 *
 * 每门语言的 worker 入口、两枚 wasm 与查询由 `descriptor.structure.load()` **按需**
 * 交回——worker 线程仍只在真被问到一篇文档时才起（资源本身按偏好装配）。
 *
 * ## 关 = 逐字不变（这条是硬要求，代码形状就是为它设计的）
 *
 * `installStructureOverlay()` 只做两件事：读一次偏好、订一张订阅表。偏好为关时
 * **`./client` 连 import 都不发生**（装配在 `activate()` 里动态取，worker 与 wasm
 * 因此不在主线程静态图里），并且：
 * - 一枚 provider 都不注册；
 * - 一个编辑器选项都不写（含 `semanticHighlighting.enabled`——见下面「着色开关的归属」）；
 * - 一份语言配置都不重发；
 * - 一条线程都不 spawn。
 *
 * ## 开 = 叠加，不是替换
 *
 * - **着色**：只给声明了 `semantic` 面的语言注册
 *   `registerDocumentSemanticTokensProvider`（Monarch 仍是底 tokenizer）；结构层对这份
 *   文档没有结果时**返回 null**，让「定义与调用的名字分色」那枚 provider 应答。
 *   ERB 首版不声明这一面（结构专用 grammar 不做 semantic tokens），因此宿主不会给它
 *   挂空 provider。
 * - **折叠**：结构语言里**只有 `structure.folds !== false` 的那些**注册
 *   `registerFoldingRangeProvider`；Monaco 把同语言的**多枚折叠供给器的结果并起来**
 *   （`syntaxRangeProvider.js::collectSyntaxRanges`）⇒ 既有折叠照旧，结构折叠是增量。
 *   **R5（2026-10-29）起 ERB 不在此列**：它的折叠由语言服务插件供（更全），结构层这一面
 *   退休——但那条 provider 仍注册着（同步回空表），因为"Monaco 问折叠"是宿主唯一一个
 *   与"这份文档上屏了"对齐的信号，缩进 / 残缺两条推的面靠它开跑（见
 *   {@link structureFoldingProvider} 头注）。
 * - **缩进**：`setLanguageConfiguration` 只写 `onEnterRules` / `indentationRules` 两个
 *   属性，并且只在结构层真的给出规则时才写。基底规则由运行时声明（`.kojo` 派生自糖词表；
 *   没声明 = 只发结构层自己的规则）。
 * - **结构残缺**（TSIT2-D）：CST 上的 ERROR / MISSING 折成**行级波浪线**，走自己的
 *   marker owner。这一面多挂一枚 marker owner，其余注册面与上面三条完全一样。
 *
 * ## 着色开关的归属
 *
 * `editor.semanticHighlighting.enabled` 今天由「定义与调用的名字分色」独占。本特性同开时
 * 也要用它，于是**叠层开着的那段时间**由这里统一写 `名字分色 || 结构解析`；关掉叠层时
 * 还原成名字分色自己的值并撤掉全部监听。这一步是"不静默"的一部分。
 */

/** 叠层总状态（模块级单例：装配点调一次，其余全靠订阅表驱动） */
let monacoRef: typeof Monaco | null = null;
let installed = false;
let active = false;
/** 装配时拿到的候选 descriptor（测试可注入；生产缺省 = 进程级注册表） */
let candidates: readonly LanguageDescriptor[] = [];
/** 是否已经"接管过"着色选项（从未开过时 = false ⇒ 一个编辑器选项都不写） */
let ownsHighlightingOption = false;
/** 每门结构语言一份 client / provider 句柄（key = Monaco 语言 id） */
interface LanguageOverlay {
  readonly descriptor: LanguageDescriptor;
  readonly runtime: StructureLanguageRuntime;
  readonly client: StructureClient;
  readonly registrations: readonly Monaco.IDisposable[];
  indentDisposable: Monaco.IDisposable | null;
  appliedIndentKey: string | null;
}
const overlays = new Map<string, LanguageOverlay>();
/** 结构残缺上屏器（TSIT2-D）：**只在叠层开着的那段时间存在**；建在 activate、拆在 deactivate */
let syntax: StructureSyntaxPresenter | null = null;
const optionHooks: Monaco.IDisposable[] = [];

/**
 * 结构层**管不管**折叠这一面（R5 2026-10-29：一件事只有一个供方）。
 *
 * `descriptor.structure.folds === false` = 这门语言的折叠已经有别人供了（ERB 走
 * `ui.editor.languageService` 槽的 `erb-folding`），结构层不再注册 provider、`parse` 的
 * `want` 里也不带 `folds`。缺省（没写这一格）= 照旧由结构层供。
 */
function servesStructureFolds(descriptor: LanguageDescriptor | null): boolean {
  return descriptor?.structure !== undefined && descriptor.structure.folds !== false;
}

/**
 * 结构**着色 / 缩进**这一路的体量闸：与语义着色同一档（`LARGE_FILE_LINES`）。
 *
 * **折叠不看这一条**（2026-10-28 拆开）：详见 {@link resolveStructureFoldsEnabled}。
 */
const STRUCTURE_MAX_LINES = LARGE_FILE_LINES;

/** 结构着色 / 缩进在这一行数上还供不供（纯数；折叠另有判据） */
export function structureSemanticAffordable(lineCount: number): boolean {
  return Number.isFinite(lineCount) && lineCount <= STRUCTURE_MAX_LINES;
}

/** 这门语言（或这条路径）对应的 descriptor；认不出 ⇒ `null`（**不猜**） */
function descriptorOf(languageId: string, path: string | null | undefined): LanguageDescriptor | null {
  return (
    descriptorForLanguageId(languageId) ??
    overlays.get(languageId)?.descriptor ??
    (languageId === FALLBACK_LANGUAGE_ID || !path ? null : descriptorForPath(path))
  );
}

/** 偏好 + 语言声明两条腿（**不带体量**）：体量怎么判由每个面自己决定 */
function structureCapable(
  languageId: string,
  path: string | null | undefined,
  prefOn: boolean,
): boolean {
  // 偏好开（缺省开；显式 `off` ⇒ 假）——作者关掉后即便 provider 还没被摘除也不许顶上
  if (!prefOn) return false;
  // 已装上的结构层 descriptor 也算数（测试替身语言 / 尚未进注册表的语言），再退回按路径认领
  return descriptorOf(languageId, path)?.structure !== undefined;
}

/**
 * 这份文档的**着色 / 缩进**该不该由结构层顶上（纯判据；
 * 测试 `tests/tree-sitter-default.test.ts` 直接打它）。
 *
 * 三条腿：偏好开 + 语言声明了 `structure`（`kojo2` / JSON / 认不出的 `plaintext` 一律不碰，
 * `.kojo2` 的结构面走自己那套 worker）+ 没超过体量闸。
 *
 * `path` 只在语言 id 不认识时用来自查 descriptor（模型池还没定语言的那一拍）；
 * `plaintext` 不按路径猜——与 `language-registry`「认不出不猜 DSL」同一条。
 * `prefOn` 只为测试注入；生产取 localStorage 真源。
 */
export function resolveStructureEnabled(
  languageId: string,
  path: string | null | undefined,
  lineCount: number,
  prefOn: boolean = loadTreeSitterPref(),
): boolean {
  if (!structureSemanticAffordable(lineCount)) return false;
  return structureCapable(languageId, path, prefOn);
}

/**
 * **折叠**这一路该不该由结构层顶上：**不设行数闸**（2026-10-28）。
 *
 * ## 为什么它与着色不同档
 *
 * 原判据把三个面绑在一条 5,000 行的线上，理由是"全文级开销同开同关"。实测不支持这条：
 *
 * | 面 | 24,197 行 ERB 整篇（worker 内） | 落在哪条线程 |
 * |---|---|---|
 * | 折叠 | **210 ms** | worker（`folds.scm` 一趟查询） |
 * | + 缩进 | 271 ms | worker |
 * | + 残缺 | 299 ms | worker |
 * | + 语义 | 365 ms | worker 查询 + **主线程编码** |
 *
 * 折叠是这四条里最便宜的一条，而且**完全在 worker 里**；真正压主线程的是语义那一面的
 * token 编码（`providers.ts` 的 `semantic.encode`）——所以只有它继续留在
 * `LARGE_FILE_LINES` 的闸内，折叠放开。
 *
 * ## 放开之后编辑器还剩几道闸（都不是"静默削功能"）
 *
 * - `folding:false`（`TIER_HUGE`，≥50,000 行）把整条折叠槽撤掉——那时 provider 根本不会被问；
 * - `FOLDING_MAX_RANGES` / Monaco 的 `foldingMaximumRegions` 按**区间条数**封顶，超额有可见提示；
 * - worker 侧超时判死仍走 `fallback.ts` 台账（与其余各面同一套）。
 *
 * ## R5（2026-10-29）：这一路在 ERB 上整体关掉
 *
 * 上面那张表说的是"折叠比其余三面便宜"，但**便宜不等于该有第二份**：ERB 的折叠由
 * `erb-parser` 的语言服务插件供，而且是超集。两家的代价加起来不是"多算一遍"，是
 * "Monaco 合并多枚供给器要等最慢那条"——首解因此被 worker 那一趟顶到 186–210 ms。
 * 所以判据从"要不要给折叠设行数闸"变成"**这份文档的折叠有没有别人供**"，
 * 由 descriptor 的 `structure.folds` 回答（见 {@link servesStructureFolds}）。
 */
export function resolveStructureFoldsEnabled(
  languageId: string,
  path: string | null | undefined,
  prefOn: boolean = loadTreeSitterPref(),
): boolean {
  if (!structureCapable(languageId, path, prefOn)) return false;
  // R5（2026-10-29）：这门语言的折叠已经有别人供了 ⇒ 结构层这一面退休。
  // 判据不是"谁更好"，是"同一份文档不许有两套区间"——Monaco 把多枚供给器并起来**等最慢的
  // 那条**，所以第二份不只是白算，它还把首解顶到 worker 那一趟（186–210 ms）。
  return servesStructureFolds(descriptorOf(languageId, path));
}

/** 没有基底规则的语言：`mergeIndentConfig` 要求三条腿齐全，用"永不匹配"占位 */
const EMPTY_INDENT_BASE: BaseIndentPatterns = {
  indentOnEnter: [],
  increaseIndentPattern: /(?!)/,
  decreaseIndentPattern: /(?!)/,
};

/**
 * 大文档的**着色**不由结构层顶上（说一次，别每击键重复）。
 *
 * 折叠不再走这里：它已从这条体量闸里拆出去（判据见 {@link resolveStructureFoldsEnabled}），
 * 所以"让路"这件事只对着色成立——说出来的话必须只指着色，否则就是假话。
 */
function noteSemanticSizeSkip(): void {
  reportStructureDegradation({
    capability: 'semantic',
    stage: 'parse',
    message: `超过 ${STRUCTURE_MAX_LINES} 行的文件这次不由结构层着色（回到词法层的分色）`,
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

function structureSemanticProvider(
  languageId: string,
  semantic: StructureSemanticFacet,
): Monaco.languages.DocumentSemanticTokensProvider {
  return {
    getLegend: () => semantic.legend,
    async provideDocumentSemanticTokens(model, _resultId, token) {
      if (!active || model.getLanguageId() !== languageId) return null;
      if (token.isCancellationRequested) return null;
      // 偏好关 / 语言没声明结构面 / 超大文件：一律不顶上（超大那份由 noteSemanticSizeSkip 说一次）
      if (!resolveStructureEnabled(languageId, model.uri?.path, model.getLineCount())) {
        if (model.getLineCount() > STRUCTURE_MAX_LINES) noteSemanticSizeSkip();
        return null;
      }
      const overlay = overlays.get(languageId);
      if (!overlay) return null;
      let tokens: Awaited<ReturnType<StructureClient['tokens']>> | null;
      try {
        tokens = await overlay.client.tokens(model);
      } catch (error: unknown) {
        reportStructureDegradation({
          capability: 'semantic',
          stage: 'parse',
          message: `「${overlay.descriptor.label}」结构着色取数失败 ⇒ 回落词法层：${error instanceof Error ? error.message : String(error)}`,
        });
        return null;
      }
      if (!active || token.isCancellationRequested) return null;
      syncIndentConfig(languageId);
      if (tokens === null || tokens.length === 0) return null;
      const encoded = semantic.encode(tokens, {
        lineCount: model.getLineCount(),
        maxColumn: (lineNumber) => model.getLineMaxColumn(lineNumber),
      });
      // 只有"真的没涂上"才算回落（空区间是常态，见 `lostStructureSpans`）
      const lost = lostStructureSpans(encoded);
      if (lost > 0) {
        reportStructureDegradation({
          capability: 'semantic',
          stage: 'parse',
          // 一段都没剩下 = 整面确实没顶上；还剩几段 = 只是少涂了几段
          partial: encoded.data.length > 0,
          message: `丢掉 ${lost} 段（越界行 ${encoded.droppedRows} / 超宽跨度 ${encoded.droppedWide} / 完全被覆盖 ${encoded.droppedOverlaps}）`,
        });
      }
      if (encoded.data.length === 0) return null;
      return { data: encoded.data };
    },
    releaseDocumentSemanticTokens: () => undefined,
  };
}

/**
 * 折叠 provider。**两种供法，按 descriptor 二选一**（R5，2026-10-29 折叠单源）：
 *
 * - `descriptor.structure.folds !== false` → 结构层自己算（今天只剩 `.kojo1`）；
 * - `=== false`（ERB）→ 折叠已经由 `ui.editor.languageService` 槽上的 `erb-folding` 供了，
 *   这里**同步交回空表**，只把这份文档的解析**排上队**（`client.warmUp`）。
 *
 * ## 为什么留一枚"不折的折叠 provider"而不是干脆不注册
 *
 * Monaco 问折叠的那一刻，恰好就是"**这份文档上屏了**"那一刻——这是宿主今天唯一一个
 * 与"可见"对齐、且与语言无关的拉取信号。结构层还剩两条**推**的面（缩进规则写进语言配置、
 * 结构残缺写进 marker），它们没有自己的拉取时机，全都靠这一下开跑。把它拆掉就只剩
 * "按 model 创建事件预热"那条路——而一条线程只持一棵树（同门语言两份文档要换轨），
 * 在模型创建时抢轨会和真正显示的那一份互踢。**所以留着这个空壳，是把它当触发器用**，
 * 代价是一次同步 `return []`（Monaco 合并多枚供给器时不增不减）。
 *
 * 空壳只在 `folds === false` 的语言上出现，别处仍是原来那条真取数的路。
 */
function structureFoldingProvider(languageId: string): Monaco.languages.FoldingRangeProvider {
  return {
    async provideFoldingRanges(model) {
      if (!active || model.getLanguageId() !== languageId) return [];
      const overlay = overlays.get(languageId);
      if (!overlay) return [];
      if (!servesStructureFolds(overlay.descriptor)) {
        // 同一份文档的第二套区间到此为止；解析照旧排上队（缩进 / 残缺在回话里到货）
        overlay.client.warmUp(model);
        return [];
      }
      if (!resolveStructureFoldsEnabled(languageId, model.uri?.path)) return [];
      let folds: readonly KojoStructureFold[] | null;
      try {
        folds = await overlay.client.foldingRanges(model);
      } catch (error: unknown) {
        reportStructureDegradation({
          capability: 'folds',
          stage: 'parse',
          message: `「${overlay.descriptor.label}」结构折叠取数失败 ⇒ 回落词法折叠：${error instanceof Error ? error.message : String(error)}`,
        });
        return [];
      }
      if (!active) return [];
      // 没声明 semantic 面的语言（ERB 首版）也在这里拿到缩进规则：折叠是它每篇都会问的那条腿。
      // 先于"有没有折痕"判：零折痕的文档也可能带回缩进规则（语义腿对空结果同样是先同步再退场）
      syncIndentConfig(languageId);
      if (folds === null || folds.length === 0) return [];
      // 0 基行号 → 模型坐标（1 基闭区间），夹取与去重复用 `kojo-folding` 那份（口径只有一处）
      return toMonacoFoldingRanges(
        model,
        folds.map((fold) => ({
          startLine: toMonacoLine(fold.startRow),
          endLine: toMonacoLine(fold.endRow),
        })),
      );
    },
  };
}

/** 缩进：只在结构层真的给了规则、且规则与上次不同时才重发语言配置（逐语言各记各的） */
function syncIndentConfig(languageId: string): void {
  const monaco = monacoRef;
  if (!monaco || !active) return;
  const overlay = overlays.get(languageId);
  if (!overlay) return;
  const base = overlay.runtime.baseIndentPatterns?.() ?? EMPTY_INDENT_BASE;
  const merged = mergeIndentConfig(base, overlay.client.indent);
  if (merged === null) {
    if (overlay.indentDisposable !== null) {
      overlay.indentDisposable.dispose();
      overlay.indentDisposable = null;
      overlay.appliedIndentKey = null;
    }
    return;
  }
  if (merged.key === overlay.appliedIndentKey) return;
  if (merged.rejected > 0) {
    reportStructureDegradation({
      capability: 'indent',
      stage: 'query',
      message: `「${overlay.descriptor.label}」结构层给了 ${merged.rejected} 条非法正则 ⇒ 这几条丢掉，原有回车规则不变`,
    });
  }
  overlay.indentDisposable?.dispose();
  overlay.indentDisposable = monaco.languages.setLanguageConfiguration(languageId, {
    onEnterRules: merged.onEnterRules.map((rule) => ({
      beforeText: rule.beforeText,
      action: { indentAction: monaco.languages.IndentAction.Indent },
    })),
    indentationRules: {
      increaseIndentPattern: merged.increaseIndentPattern,
      decreaseIndentPattern: merged.decreaseIndentPattern,
      // 基底这两格必须原样带出：Monaco 的 `indentationRules` 是整对象替换，漏写 = 撤掉
      // 语言自己的 `SIF` 只抬一行 / 注释行不继承（ERB 的基底两格都由 `erb-enter.ts` 派生）。
      ...(merged.indentNextLinePattern ? { indentNextLinePattern: merged.indentNextLinePattern } : {}),
      ...(merged.unIndentedLinePattern ? { unIndentedLinePattern: merged.unIndentedLinePattern } : {}),
    },
  });
  overlay.appliedIndentKey = merged.key;
}

/* --------------------------------- 闸门 --------------------------------- */

type StructureClientCtor = typeof import('./client').StructureClient;

/** 一门语言：一条线程 + 一枚 client + 它自己的 provider 注册（整组可回收） */
function startLanguage(
  monaco: typeof Monaco,
  ClientClass: StructureClientCtor,
  descriptor: LanguageDescriptor,
  runtime: StructureLanguageRuntime,
): void {
  const languageId = descriptor.id;
  const client = new ClientClass({
    runtime,
    // 只进 `open.languageId`（worker 侧日志与自证）；宿主不按语言 id 分支（LAU-3 已收口）
    languageId,
    /**
     * 这一份文档要哪几面：**语义那一面只在"装配了 + 这一档还供"时才要**，折叠那一面
     * **只在结构层真的供折叠时才要**（R5：ERB 已经由语言服务插件供，结构层不再问）。
     *
     * `parse` 的 `want` 缺省 = 四面全查，而 ≥5,000 行的文档本就不供语义（上面那道闸），
     * 全查是白烧——24,197 行 ERB 实测 365 ms（四面）vs 299 ms（折叠+缩进+残缺）。
     * 缩进与残缺任何大小都要：一条管回车，一条管波浪线。
     */
    facetsFor: (model) => {
      const facets: StructureFacet[] = servesStructureFolds(descriptor) ? ['folds', 'indent', 'syntax'] : ['indent', 'syntax'];
      if (runtime.semantic !== undefined && structureSemanticAffordable(model.getLineCount())) {
        facets.push('semantic');
      }
      return facets;
    },
    onFatal: () => {
      // 整档停用只拆这一门语言：另一门语言的结构层不该被邻居的 wasm 失败带走
      stopLanguage(languageId);
      if (active && overlays.size === 0) deactivate();
    },
    // 结构残缺到货 → 行级波浪线。**上屏方式由运行时自己声明**（LAU-3）：ERB 走它自己的
    // `erb-diagnostics.ts`（文案 / 码名 / `[SKIPSTART]` 配对判据），`.kojo` 走通用上屏器
    // `syntax-decorations.ts`；宿主这里零语言 id（原先那两处 `if (languageId === ERB)` 已删）。
    onSyntax: (model, faults, truncated) => {
      if (runtime.presentSyntax) {
        runtime.presentSyntax({ monaco, model, faults, truncated });
        return;
      }
      syntax?.show(model, faults, truncated);
    },
    onSyntaxClear: (model) => {
      if (runtime.clearSyntax) {
        runtime.clearSyntax({ monaco, model });
        return;
      }
      syntax?.clear(model);
    },
    // 缩进这一面归**第二拍**（首帧分层：折叠先上，见 `client.ts::FIRST_BEAT`）⇒ 到货时
    // 当场落到语言配置上。不接这一条，作者开大文件后的第一次回车会吃基底规则。
    onIndent: () => syncIndentConfig(languageId),
  });
  const registrations: Monaco.IDisposable[] = [];
  try {
    if (runtime.semantic) {
      registrations.push(
        monaco.languages.registerDocumentSemanticTokensProvider(
          languageId,
          structureSemanticProvider(languageId, runtime.semantic),
        ),
      );
    }
    registrations.push(
      monaco.languages.registerFoldingRangeProvider(languageId, structureFoldingProvider(languageId)),
    );
  } catch (error: unknown) {
    // 半途抛错 = 这一门语言的注册全有或全无（不留一枚没人回收的半套 provider）
    for (const registration of registrations) registration.dispose();
    client.dispose();
    throw error;
  }
  overlays.set(languageId, {
    descriptor,
    runtime,
    client,
    registrations,
    indentDisposable: null,
    appliedIndentKey: null,
  });
  // worker 与 wasm 只在真的被问到时才起（这里不预先 start，翻开开关不等于要解一份文档）
}

function stopLanguage(languageId: string): void {
  const overlay = overlays.get(languageId);
  if (!overlay) return;
  overlays.delete(languageId);
  for (const registration of overlay.registrations) registration.dispose();
  overlay.indentDisposable?.dispose();
  overlay.client.dispose();
}

async function activate(monaco: typeof Monaco): Promise<void> {
  if (active) return;
  active = true;
  resetStructureDegradationLedger(); // 重新翻开 = 允许再说一次（台账只为"同一次启用里别刷屏"）
  installHighlightingOptionOwnership();
  let ClientClass: StructureClientCtor;
  try {
    const mod = await import('./client');
    ClientClass = mod.StructureClient;
  } catch (error: unknown) {
    reportStructureDegradation({
      capability: 'all',
      stage: 'wasm',
      message: `结构解析模块装载失败：${error instanceof Error ? error.message : String(error)}`,
    });
    deactivate();
    return;
  }
  if (!active) return; // 翻回关了（快速来回切），不再建线程
  syntax = createStructureSyntaxPresenter(monaco);
  for (const descriptor of candidates) {
    const structure = descriptor.structure;
    if (!structure) continue;
    let runtime: StructureLanguageRuntime;
    try {
      runtime = await structure.load();
    } catch (error: unknown) {
      // 一门语言的资源装不上只让这一门缺席（可见），别把另一门已经起来的结构层带走
      reportStructureDegradation({
        capability: 'all',
        stage: 'wasm',
        message: `「${descriptor.label}」结构层资源装载失败 ⇒ 这门语言这一层不启用：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (!active) return;
    try {
      startLanguage(monaco, ClientClass, descriptor, runtime);
    } catch (error: unknown) {
      reportStructureDegradation({
        capability: 'all',
        stage: 'wasm',
        message: `「${descriptor.label}」结构层启动失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  if (active && overlays.size === 0) deactivate();
}

function deactivate(): void {
  for (const languageId of [...overlays.keys()]) stopLanguage(languageId);
  // 结构残缺那一层整片撤下（关 = 一条波浪线都不留；Monarch 与转译器那一路一个字没动过）
  syntax?.dispose();
  syntax = null;
  active = false;
  releaseHighlightingOptionOwnership();
}

/**
 * 装配点唯一入口（`monaco/entry.ts` 动态取本模块后调用一次）。
 *
 * 关着时这个函数**只读一次偏好、只挂一张订阅表**——它不动 Monaco 的任何注册面。
 * `descriptors` 只为测试注入；生产一律用进程级注册表。
 */
export function installStructureOverlay(
  monaco: typeof Monaco,
  descriptors: readonly LanguageDescriptor[] = languageDescriptors(),
): void {
  if (installed) return;
  installed = true;
  monacoRef = monaco;
  candidates = descriptors;
  if (loadTreeSitterPref()) void activate(monaco);
  subscribeTreeSitterPref(() => {
    const on = loadTreeSitterPref();
    if (on && !active) void activate(monaco);
    else if (!on && active) deactivate();
  });
}

/** 测试与拆毁用：把单例回到未装配状态（跨 kernel 不留悬账，同 `disposeGlobalProviders` 的口径） */
export function disposeStructureOverlay(): void {
  if (active) deactivate();
  installed = false;
  candidates = [];
  monacoRef = null;
}

/**
 * 当前状态（诊断与 A/B 测试用；不在作者面展示）。
 * `client` = 第一门已起语言的 client 状态（单语言时就是它；逐语言读数见下）。
 */
export function structureOverlayState(): { installed: boolean; active: boolean; client: StructureStatus | null } {
  const first = overlays.values().next().value as LanguageOverlay | undefined;
  return { installed, active, client: first?.client.state ?? null };
}

/** 逐语言叠层状态（测试 / 诊断用；键 = Monaco 语言 id） */
export function structureOverlayLanguageStates(): Record<string, StructureStatus> {
  return Object.fromEntries([...overlays].map(([languageId, overlay]) => [languageId, overlay.client.state]));
}
