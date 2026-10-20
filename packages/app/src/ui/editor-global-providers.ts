/**
 * EditorPane 的全局 Monaco provider 接线层（SPLIT-1「只注册一份」那一半）。
 *
 * 分工：登记簿与跨实例反查在 `editor-pane-registry.ts`；本模块只做**一次性接线**——把
 * `ui.editor.*` / `game.adapter` 槽位的贡献翻译给 Monaco（宿主零游戏知识），外加两份只能全局
 * 一份的模块级资源：适配器表 `editorTables`（悬停 ZH-F2 + 两条补全 seam + 签名 + Monarch 词表
 * 共用，**单一数据源**）与 Monarch directive 词表的实例引用计数。
 *
 * 三道门不许改：注册恰好一次（`globalsInstalled`；半途抛错则**全有或全无**地撤回这一位，
 * 拆掉已登记的每一枚并把错误外抛，绝不留"flag 已置但 provider 缺一整批"的永久静默）、
 * kernel 来源随最新实例刷新、最后一个实例退场才整体拆毁（`disposeGlobalProviders`；调用它的
 * 先后顺序由 EditorPane 的卸载路径钉死）。
 *
 * `applyTextEdits`（💡 行级改写落地的唯一通道）也定义在这里并由 EditorPane 的「一键修复」
 * import：一条腿一个定义，不另写第二套编辑应用机制（降序 + 夹取 + 单次 `executeEdits`）。
 *
 * 依赖单向：EditorPane → 本模块 → 登记簿。本模块不 import React，也不 import EditorPane。
 */
import type * as Monaco from '../monaco/entry';
import type { Kernel } from '@kojo/kernel';
import { errorText, KOJO_SOURCE_EXTENSION, pathKey } from '@kojo/plugin-api';
import type {
  EditorCodeAction,
  EditorDocumentSymbol,
  EditorFoldingRange,
  EditorInlayHint,
  EditorCodeLens,
  EditorSymbolLocation,
  EditorTextEdit,
  ErbFile,
  ErbIndex,
  ErbParserService,
  ErbReference,
  GameAdapter,
  GameProject,
  LineDecoration,
} from '@kojo/plugin-api';
import * as monaco from '../monaco/entry';
import { makeLookup } from '@kojo/plugin-kojo-sugar';
import { ERB_DIRECTIVES, mergeDirectiveWords, setErbDirectiveWords } from '../monaco/erb-language';
import { descriptorForLanguageId, languageDescriptors } from '../monaco/language-registry';
import { installHover, type HoverTables } from '../monaco/kojo-hover';
import {
  PROVIDED_CODE_ACTION_KINDS,
  actionDiagnostics,
  collectCodeActions,
  markersToDecorations,
} from '../monaco/kojo-code-action';
import {
  codeLensAffordable,
  collectCodeLenses,
  installCodeLensProvider,
  withinCodeLensBudget,
} from '../monaco/kojo-code-lens';
import { collectDefinitionLocations, installDefinitionProvider, type DefinitionLocation } from '../monaco/kojo-definition';
import { createPeekLeases, type PeekLeases } from './peek-leases';
import { editorModelPool } from './editor-model-pool-instance';
import {
  collectInlayHints,
  inlayHintsAffordable,
  installInlayHintsProvider,
} from '../monaco/kojo-inlay-hints';
import { revealLocationOf } from '../monaco/reveal-position';
// 大文档档位线的**单一真源**（本模块只引用、不再抄数字，同 codeLens / 着色 / 面包屑各批）
import { foldingEnabledForLineCount } from './editor-options';
import { dialectForLanguage, installDocumentFormatter, type FormatRequest } from '../monaco/kojo-format';
import { installRangeFormatter, type RangeFormatHandlers } from '../monaco/kojo-format-range';
// FMT-TOAST：格式化让路的一次性台账（去重 + 文案都住 `ui/format-notice-ledger.ts`，
// 本模块只做"把出口接上"这一件事；上屏由 `EditorPane.tsx` 订阅根通知中心完成）
import { reportFormatDegradation } from './format-notice-ledger';
// W8 XLANG-RENAME 的宿主侧：闭文件落盘的唯一通道（`ClosedFileIo`）与跨语言腿的取数
// （枚举 + 读文 + 问槽，判读零宿主知识；根口径与检索面板同源）
import { type ClosedFileIo } from './reference-utils';
import { kojoReferencesViaSlot, listKojoSourceTexts } from './kojo-source-scan';
import { setReferenceTally } from './reference-tally-store';
import { collectDocumentSymbols, installDocumentSymbolProvider } from '../monaco/kojo-symbols';
import { setJumpProbe } from './jump-to-state';
import { documentRequestFields } from './language-service-request';
import { collectFoldingRanges, installFoldingRangeProvider } from '../monaco/kojo-folding';
// P2-14：quick fix 预览层（纯逻辑）——落地前先出 diff 预览，确认才应用
import {
  QUICK_FIX_PREVIEW_OVERLAY_ID,
  previewTextFor,
  pushPreview,
  quickFixPreviewTitle,
  resetQuickFixPreviews,
  takePreview,
} from './quick-fix-preview';
// P2-14：格式化规则开关（设置页真源；resolve 组请求时现读，与保存链路同一现读纪律）
import { loadFormatRulesPref } from './format-pref';
import {
  collectSemanticTokenSpans,
  installSemanticTokensProvider,
  shouldComputeSemanticTokens,
} from '../monaco/kojo-semantic-tokens';
import {
  SIGNATURE_LOOKBACK_LINES,
  type ResolvedSignature,
  type SignatureTables,
  installSignatureHelp,
  resolveSignatureInText,
} from '../monaco/kojo-signature';
import { type CompletionTables, installKojoCompletion } from '../monaco/kojo-completion';
// `erbFileFacts` 的注入契约形状（通道语义 / `undefined` 与 `[]` 的分家，见该文件头注）
import type { ErbFileFactsProvider } from '../monaco/completion-core';
import { installErbCompletion, memoizedErbFunctionNames, type ErbCompletionTables } from '../monaco/erb-completion';
import { createApplyToClosedFile, installErbRename } from '../monaco/erb-rename';
import { collectReferenceLocations, installReferenceProvider } from '../monaco/find-references';
import { installKojoRename } from '../monaco/kojo-rename';
import { installImplementationProvider } from '../monaco/erb-implementation';
import {
  focusedCtx,
  livePanes,
  openModelAcrossGroups,
  owningPaneOf,
  pathForUriAcrossGroups,
  requireKernel,
  sourceModelOf,
  sugarOwningPaneOf,
  sugarSourceOf,
  type PaneCtx,
} from './editor-pane-registry';
import { sourceLineToSugar } from './sugar-view';
import { loadWordBasedSuggestionsPref } from './suggest-pref';

/** CodeAction 执行命令 id（宿主统一注册一次；command 参数为 pendingActionsRef 的反查 key） */
const CODE_ACTION_COMMAND = 'kojo.codeAction.run';

/**
 * `erb.parser` 的**软取**索引（唯一一份）：解析器缺席 / 索引在途一律给 `null`——
 * `tryGet` 与 `currentIndex` 两步都包在 try 里，调用方据此让**那一路无结果**
 * （退化可见），绝不把抛错送进悬停 / 补全 / 重命名 / 签名任何一条 seam。
 * 索引**每次现取**，不缓存（索引随项目开闭重建，缓存会把上一个项目的索引带过来）。
 *
 * ST-TAIL（2026-10-20）把这条腿升成**宿主唯一的 `currentIndex()` 软取**：`erbIndex`（悬停）
 * 这一枚此前手抄了一遍同样的三行（try + tryGet + `?? null`），`EditorPane.tsx` 的面包屑那条
 * 也抄了第三遍——一份"怎么问索引"写三处，下一次改口径就要改三处且必漏一处（同 `9bba5e6`
 * 那批 `.kojo` 后缀手抄归一的口径）。守卫见 `ui-kojo-navigator/tests/
 * index-state-single-source.test.ts` 第 ⑦ 组（按处数钉死，多一处即红）。
 */
export function erbParserIndex(kernel: Kernel): ErbIndex | null {
  try {
    return kernel.services.tryGet<ErbParserService>('erb.parser')?.currentIndex() ?? null;
  } catch {
    return null;
  }
}

/**
 * 编辑器只读消费的适配器表（悬停 ZH-F2 + `.kojo` / `.erb` 两个补全 seam 共用）——按当前项目
 * `adapterId` 精确匹配 `game.adapter` 槽位贡献，**运行时**现取（适配器随项目开闭重建，
 * 缓存会把上一个项目的表带过来）。**单一数据源**：kojo 与 erb 两个 seam 共用它，不各建一份。
 *
 * 表全在适配器贡献上（游戏知识只住 adapter；宿主只读不解释）：变量字典
 * （`variableSchema` → `makeLookup`，与 kojo-sugar 转译器同一个构造器）、时机分野模板表
 * （`kojoFaceTemplates`，`.kojo` 补全 seam 的 KC-2 前置）、基础库函数名表、指令名表。
 * 缺一即该路不产候选 / 不反查（**不猜**）。
 *
 * **没开项目 ≠ 一张表都没有**：`variableSchema` / `kojoInstructionTable` / `kojoCallProtocol`
 * 由 `loadProject` 现读 CSV / 路由表填充，无项目时它们确实不存在 ⇒ 一律不给（给了就是"假装可用"：
 * 带 `requires` 的那几路会握着空表一声不吭）。而分野模板 / 基础库 / 计数器三张表是 adapter
 * **构造时**就给出的纯数据静态表（零 IO，见 `staticTablesOf`），与项目无关 ⇒ 无项目时照旧给出，
 * 让依赖它们的候选源照常开口（否则静态面那几路被一刀切静默）。多枚 adapter 的取舍见
 * `staticTablesFor`。有项目但 `adapterId` 在槽位里找不到贡献时**同口径**（只给静态面）。
 *
 * 另附 `erbFunctionNames`（**非** adapter 表）——项目内全部函数名（EC-3 函数名补全预置），
 * 由 `erb-parser` 的 `ErbIndex` 派生并按整项目指纹记忆化（见 `erb-function-names-for`）。
 */
export function editorTables(kernel: Kernel): EditorTables {
  const contributions = kernel.slots.query('game.adapter');
  const project = kernel.project.current();
  const matched = project ? contributions.find((c) => c.adapter.gameId === project.adapterId) : undefined;
  if (matched) {
    const adapter = matched.adapter;
    return {
      ...(adapter.variableSchema
        ? { dictionary: makeLookup(adapter.variableSchema), variableSchema: adapter.variableSchema }
        : {}),
      ...staticTablesOf(adapter),
      ...(adapter.kojoInstructionTable ? { instructionTable: adapter.kojoInstructionTable } : {}),
      // B5 签名帮助要的槽语义表（同一枚 adapter 贡献，运行时现取；缺席 = 不产签名）
      ...(adapter.kojoCallProtocol ? { callProtocol: adapter.kojoCallProtocol } : {}),
      ...projectSoftLegs(kernel),
    };
  }
  // 两条落空的路径同一口径（没开项目 / 开了项目但槽位里没有同 `adapterId` 的贡献）：
  // 只给静态面 + 两条软取腿，**绝不给** `loadProject` 才填得上的那三张表。
  return { ...staticTablesFor(contributions), ...projectSoftLegs(kernel) };
}

/** `editorTables` 的返回形状（两个补全 seam + 签名 + 悬停四面并成一型） */
type EditorTables = CompletionTables & ErbCompletionTables & SignatureTables & HoverTables;

/**
 * adapter 贡献上**静态、零 IO** 的表 → `editorTables` 的输出键。
 * 这三枚在 adapter 构造时就是现成实例（手工维护的纯数据表），不读盘、不随项目开闭重建；
 * 与 `variableSchema`（`loadProject` 读 CSV / `.ERH`）、`kojoInstructionTable`（读指令 CSV）、
 * `kojoCallProtocol`（读路由表）**分属两面**，别混——只有这一支可以在无项目时给出。
 */
function staticTablesOf(
  adapter: GameAdapter,
): Pick<CompletionTables, 'faceTable' | 'libraryTable' | 'counterTable'> {
  return {
    ...(adapter.kojoFaceTemplates ? { faceTable: adapter.kojoFaceTemplates } : {}),
    ...(adapter.kojoLibraryTable ? { libraryTable: adapter.kojoLibraryTable } : {}),
    // 计数器中文名 → 原生编号的反查（ZH-D3）：与补全/诊断同一枚 adapter，运行时现取
    ...(adapter.kojoCounterTable ? { counterTable: adapter.kojoCounterTable } : {}),
  };
}

/** 这枚 adapter 是否贡献了至少一张静态表（全空的贡献不值得被选中） */
function hasStaticTables(adapter: GameAdapter): boolean {
  const statics = staticTablesOf(adapter);
  return statics.faceTable !== undefined || statics.libraryTable !== undefined || statics.counterTable !== undefined;
}

/**
 * 无项目时选哪枚 adapter 的静态面：**注册序第一枚带静态表的贡献**
 * （`slots.query` 已按 `order` 稳定排序 ⇒ 同一份注册表下结果确定、可复现）。
 *
 * 多枚 adapter 各有一张同名静态表时**不做跨 adapter 合并**：这些表对象自带查表语义
 * （`names()` / 中文名反查 / 分野拼名），并两张表需要有人先定义"同名不同表谁赢、键冲突怎么合"——
 * 宿主给不出这个定义，硬合就是一次语义猜测（游戏知识只住 adapter，宿主只读不解释）。
 * 因此只认一枚、把这枚用满；真要同时服务多款游戏，正路是先开项目走上面 `adapterId` 精确匹配
 * 那一支，需要的是**那一款的表**而不是并集。
 */
function staticTablesFor(
  contributions: readonly { readonly adapter: GameAdapter }[],
): Pick<CompletionTables, 'faceTable' | 'libraryTable' | 'counterTable'> {
  const picked = contributions.find((c) => hasStaticTables(c.adapter));
  return picked ? staticTablesOf(picked.adapter) : {};
}

/**
 * 与项目开闭**无关**、但取数依赖项目态的三条软腿：函数名补全（`erb.parser` 索引派生）、
 * 悬停用的当前索引通道、补全 seam 的**解析事实通道**（`erbFileFacts`：`#DIM*` 声明名 +
 * 光标行所属函数内的 `$` 标签名，契约见 `monaco/completion-core.ts` 的 `ErbFileFactsProvider`）。
 * 三者都在**求值时**软取（`services.tryGet` + try/catch），索引未建 ⇒ 该路零候选 / 零结果 /
 * `undefined`（退化可见），绝不抛进 seam；每次现取，不缓存上一个项目的脏索引。
 */
function projectSoftLegs(
  kernel: Kernel,
): Pick<CompletionTables, 'erbFunctionNames' | 'erbFileFacts' | 'wordBasedSuggestions'> & HoverTables {
  return {
    erbFunctionNames: erbFunctionNamesFor(kernel),
    erbFileFacts: erbFileFactsFor(kernel),
    // QSUG-2：文档词开关每次补全现取（设置页一翻，下一个候选轮即生效；不用重开文件）
    wordBasedSuggestions: () => loadWordBasedSuggestionsPref(),
    erbIndex: () => erbParserIndex(kernel),
  };
}

/**
 * 每 kernel 一份的「函数名（已排序）」提供者缓存（`WeakMap`：同一 kernel 跨多次补全请求复用
 * 同一份记忆化闭包，指纹不变即不重排；kernel 随 App 生命周期，弱引用不碍回收）。
 */
const erbFnMemoByKernel = new WeakMap<Kernel, () => readonly string[]>();

/**
 * 取 `kernel` 对应的记忆化函数名提供者。`erb.parser` **软取**（`services.tryGet` + try/catch）：
 * 解析器缺席 / 索引在途只让此路**无候选**（退化可见），绝不抛到补全 seam。
 */
function erbFunctionNamesFor(kernel: Kernel): () => readonly string[] {
  let fn = erbFnMemoByKernel.get(kernel);
  if (!fn) {
    fn = memoizedErbFunctionNames(() => erbParserIndex(kernel));
    erbFnMemoByKernel.set(kernel, fn);
  }
  return fn;
}

/**
 * 在索引里按 `pathKey` 归一找 `path` 对应的文件——**路径归一责任在宿主**（`ErbFileFactsProvider`
 * 的契约只收 fsPath 原文）。HK-7 同款口径：平台原样路径与宿主键在 Windows 上分隔符 / 大小写
 * 不一致，裸字符串比会静默判不上（先例见 `ui/external-change.ts` 的 `matchOpenedPath`）。
 * 从 `index.files` 的**键**逐键比较（键即绝对路径）；找不到 / 索引缺席 ⇒ `null`。
 */
function fileForPath(index: ErbIndex | null, path: string): ErbFile | null {
  if (!index) return null;
  const want = pathKey(path);
  for (const [key, file] of index.files) {
    if (pathKey(key) === want) return file;
  }
  return null;
}

/**
 * 当前 ERB 文件的**解析事实通道**（补全 seam 的 `erbFileFacts` 注入位，语义见
 * `monaco/completion-core.ts` 的 `ErbFileFactsProvider`）：`#DIM*` 声明名与光标行所属
 * 函数内的 `$` 标签名，一律从 `erb.parser` 索引**现取**（不缓存：索引随项目开闭重建）。
 *
 * 语义纪律（`undefined` 与 `[]` 严格分家，消费方据此决定回退与否）：
 * - 索引缺席 / 索引在途 / 索引里没有这个文件 ⇒ `undefined`（未索引 ⇒ 调用方自行回退）；
 * - 文件在索引里但没有包含该行的函数 ⇒ `[]`（已索引但确无该项，诚实空，**不回退**）。
 * 取索引与求事实全程 try/catch：绝不把抛错送进补全 seam（与 `erbParserIndex` 同一纪律）。
 */
function erbFileFactsFor(kernel: Kernel): ErbFileFactsProvider {
  return {
    dimsOf: (path) => {
      try {
        const file = fileForPath(erbParserIndex(kernel), path);
        return file ? [...new Set(file.dims.map((d) => d.name))] : undefined;
      } catch {
        return undefined;
      }
    },
    labelsAt: (path, line) => {
      try {
        const file = fileForPath(erbParserIndex(kernel), path);
        if (!file) return undefined;
        const fn = file.functions.find((f) => f.startLine <= line && line <= f.endLine);
        if (!fn) return [];
        return [...new Set((file.labels ?? []).filter((l) => l.functionStartLine === fn.startLine).map((l) => l.name))];
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * 把 💡 动作给出的**行级改写**落成一次 Monaco 编辑（**一次撤销步**，`Ctrl+Z` 可撤回）。
 *
 * 三条纪律：
 * - **降序应用**：从最大行号开始替换，前面的行号才不会因替换而位移（与
 *   `lift-apply.ts` 的倒序替换同源理由）；
 * - **坐标夹取**：贡献方给出的行号可能因"供给与执行之间用户又编辑了"而过期，
 *   夹取而非报错（陈旧行号不该让编辑器崩）；
 * - **单次 `executeEdits`**：多段改写合并成一个撤销步——用户按一次 Ctrl+Z 应当
 *   撤销"这次改写"，而不是被要求按 N 次。
 *
 * 返回是否真的落了一次编辑。
 */
export function applyTextEdits(
  ed: Monaco.editor.IStandaloneCodeEditor,
  edits: readonly EditorTextEdit[],
): boolean {
  const model = ed.getModel();
  if (!model || edits.length === 0) return false;
  const maxLine = model.getLineCount();
  const ops = edits
    .map((e) => {
      const from = Math.min(Math.max(1, Math.trunc(e.fromLine) || 1), maxLine);
      const to = Math.min(Math.max(from, Math.trunc(e.toLine) || from), maxLine);
      return { range: new monaco.Range(from, 1, to, model.getLineMaxColumn(to)), text: e.newText };
    })
    .sort((a, b) => b.range.startLineNumber - a.range.startLineNumber);
  ed.executeEdits('kojo.codeAction', ops);
  ed.pushUndoStop();
  return true;
}

/**
 * 预览 overlay 的「应用修复」落点（P2-14）：认领待确认条目，把它的 edits 用**既有**
 * `applyTextEdits` 落到归属实例的 model 上（一次撤销步；落地时按当下 model 夹取——
 * 预览打开期间用户又编辑了 ⇒ 与今天直接应用同一口径，陈旧行号不崩）。
 *
 * 返回 false = 这次没落（条目已被认领 / 归属实例不在了 / 糖视图）：overlay 据此把
 * 原因说出来，不静默。**取消路径不走这里**（`cancelPreview` 只收账、不写 model）。
 */
export function applyQuickFixEdits(actionId: string): boolean {
  const outcome = takePreview(actionId);
  if (outcome.kind !== 'taken') {
    console.warn(`[editor-providers] 快速修复预览没有可应用的条目（${outcome.reason}）：${actionId}`);
    return false;
  }
  const entry = outcome.entry;
  const ctx = livePanes.get(entry.paneId) ?? null;
  const ed = ctx?.editorRef.current ?? null;
  if (!ctx || !ed || ctx.sugarModelRef.current || !ed.getModel()) return false;
  return applyTextEdits(ed, entry.edits);
}

/** 触发预览的编辑器实例（overlay 按 paneId 取待确认条目用；无焦点实例 = null） */
export function focusedPaneIdOf(): string | null {
  return focusedCtx()?.paneId ?? null;
}

/**
 * 每条**写**能力腿共用的**开口**：由 model 反查归属实例，再读它的真路径。
 * 返回 `null` = 这份 model 不挂在任何活动标签上，或那个标签还没有路径
 * （糖视图挂的是只读派生 model，在它上面落笔改的不是原文 ⇒ 一律不应答）。
 *
 * 分界线只有一条——**这个动作最终会不会写盘**：会写盘的（💡 落地 / quickfix / F2 改名 /
 * 格式化 / 搜索替换）走这里，糖面一律否决；只读的走下面那套换算（`readTargetOf`），
 * 拿 `owningPanePathOf` 拦读类是把八条腿一起没收。
 *
 * **兜底值留在各调用点**：各能力"不应答"的形状本来就不一样（`[]` / `null` /
 * `{ hints: [] … }` / `{ actions: [] … }`），把它们折成一个是行为改动，不是去重。
 */
function owningPanePathOf(model: Monaco.editor.ITextModel): string | null {
  const ctx = owningPaneOf(model);
  if (!ctx) return null;
  return ctx.filePathRef.current || null;
}

/* ========================================================================================
 * 升糖预览面上的**读类**腿（definition / references / documentSymbol / 签名 / folding /
 * codeLens / inlayHints / 跳转探针）：位点先 `sugarSourceOf` 换成源位点，按源 path+line 走
 * 既有实现，再把结果里的源行号折回预览行。
 *
 * **落点类腿（definition / references）不折行号**：交回的是源坐标，源行 → 预览行那一跳住在
 * 落点通道（`EditorPane` 的 `applyReveal` 读同一张 `sugarLineMapRef`），这里折就是折两遍。
 *
 * 旧口径是"糖 model ⇒ 整条早退"，代价不是"慢一点"而是**这批腿在预览面上集体静默**：
 * 用户在投影里点一行按 F12 什么也不发生。预览的每一行都来自某个源行（`sugarLineMapRef`），
 * 所以"问源、答预览"是有确定映射的；只有映射缺席（空表 / 这一行压根没有源行）才不给结果。
 *
 * 三条换算纪律：
 * ① **`text` 取原文 model 那份**：契约写的是"真文件的文本"（`EditorDefinitionRequest.text`
 *    的注），供方按 `text.split('\n')[line - 1]` 取光标行——投影文本配源行号问的就是隔壁一行。
 * ② **列不折算**：预览行与源行的行内列不对应（连文本都不是同一串）。跨面换算时列一律落到
 *    行首（1），源结果里的列与区间在预览面上抹掉——把源列套到预览行上，选区就盖在别的字上，
 *    那比不跳更糟。
 * ③ **折不回 = 不给**：`sourceLineToSugar` 回 `null` 的那条结果直接丢弃，绝不给一个猜的行号
 *    （"不许把作者导到不存在的位置"）。
 *
 * `semanticTokens` 那条腿不在本段里：它按**投影自己**派生 `.kojo` 路径应答（行号天然同空间），
 * 是本段判据的另一个合法形态，保持原样。
 * ==================================================================================== */

/** 一次换算后的**读类目标**：屏幕上这份 model 该问哪份文本、源行号怎么折回来 */
interface ReadTarget {
  /** 取数真正落在的 model：原文面上 = 屏幕上这份，糖面上 = 它背后那份原文 model */
  readonly model: Monaco.editor.ITextModel;
  /** 原文路径（供方按扩展名认方言；投影不是文件，拿它去问谁都是猜） */
  readonly path: string;
  /** 仅糖面给出：归属实例（位点换算要用它的映射表）+「源行 → 预览行」折回 */
  readonly sugar: { readonly ctx: PaneCtx; readonly fold: (sourceLine: number) => number | null } | null;
}

/** 「源行 → 预览行」快表：`at[t]` = 预览行号（1 基），`0` = 折不回 */
interface PreviewRowTable {
  readonly at: Int32Array;
  readonly maxSourceLine: number;
  /** 源行比表尾还靠后时的落点（`sourceLineToSugar` 的退化口径：停在包住它的那一行） */
  readonly tail: number;
}

/**
 * 快表按 `lineMap` 的**数组身份**记忆化（投影装配时整张换表 ⇒ 身份变即重建，
 * 与 `sugarModelRef` / `sugarLineMapRef` 同批换上的纪律对齐）。
 * 存在的理由：`sourceLineToSugar` 每次查表 O(表长)，而折叠 / 大纲 / 注解一次要折几百到几千条，
 * Monaco 又**每次滚动、每次停笔**重问一遍 ⇒ 逐条现扫是 O(表长 × 结果数)。建表一趟 O(表长)，
 * 之后每条 O(1)。
 */
let previewRowTables = new WeakMap<readonly number[], PreviewRowTable | null>();

/**
 * 建反查表（判据与 `sourceLineToSugar` 逐字对齐：精确命中取**第一次**出现，源行被折进糖段时
 * 退化成"包住它的那一行"，早于表首 = 无落点）。
 * 单调不减是这套算法的前提（`composeSugarDoc` 按源行顺序产出，`kojo-sugar` 那边另有钉子）；
 * 外部数据不许假定算准了 ⇒ 表里出现倒退 / 非整数即放弃快表，由调用方退回逐条 `sourceLineToSugar`。
 */
function buildPreviewRowTable(lineMap: readonly number[]): PreviewRowTable | null {
  let maxSourceLine = 0;
  let previous = 0;
  for (const source of lineMap) {
    if (!Number.isInteger(source) || source < 0) return null;
    if (source > 0) {
      if (source < previous) return null;
      previous = source;
      if (source > maxSourceLine) maxSourceLine = source;
    }
  }
  if (maxSourceLine === 0) return null; // 全零表 = 一个源行都没有
  const at = new Int32Array(maxSourceLine + 1);
  let filled = 0;
  let row = 0;
  for (let i = 0; i < lineMap.length; i++) {
    const source = lineMap[i]!;
    if (source <= 0) continue;
    for (let t = filled + 1; t < source; t++) at[t] = row;
    if (at[source] === 0) at[source] = i + 1;
    row = i + 1;
    if (source > filled) filled = source;
  }
  return { at, maxSourceLine, tail: row };
}

/** 「源行 → 预览行」的折回函数（`null` = 折不回，调用方丢弃这一条结果） */
function createPreviewFolder(lineMap: readonly number[]): (sourceLine: number) => number | null {
  let table = previewRowTables.get(lineMap);
  if (table === undefined) {
    table = buildPreviewRowTable(lineMap);
    previewRowTables.set(lineMap, table);
  }
  if (table === null) return (sourceLine) => sourceLineToSugar(lineMap, sourceLine);
  const { at, maxSourceLine, tail } = table;
  return (sourceLine) => {
    if (!Number.isInteger(sourceLine)) return sourceLineToSugar(lineMap, sourceLine);
    if (sourceLine < 1) return null;
    const row = sourceLine > maxSourceLine ? tail : at[sourceLine] ?? 0;
    return row > 0 ? row : null;
  };
}

/**
 * 屏幕上这份 model 的读类目标。`null` = 这份 model 无主 / 没有原文可依 / **映射缺席**
 * （空表时无换算可言 ⇒ 宁可不答，也不给一个猜的位点）。
 */
function readTargetOf(model: Monaco.editor.ITextModel): ReadTarget | null {
  const own = owningPaneOf(model);
  if (own) {
    const path = own.filePathRef.current;
    return path ? { model, path, sugar: null } : null;
  }
  const ctx = sugarOwningPaneOf(model);
  if (!ctx) return null;
  const path = ctx.filePathRef.current;
  const lineMap = ctx.sugarLineMapRef.current;
  if (!path || lineMap.length === 0) return null;
  const source = sourceModelOf(ctx);
  if (!source) return null;
  return { model: source, path, sugar: { ctx, fold: createPreviewFolder(lineMap) } };
}

/** 位点换算（只在糖面上发生）：预览行 → 源行，**列落到行首**（纪律②） */
function sourcePointOf(
  target: ReadTarget,
  position: Monaco.Position,
): { readonly line: number; readonly column: number } | null {
  if (!target.sugar) return { line: position.lineNumber, column: position.column };
  const at = sugarSourceOf(target.sugar.ctx, position.lineNumber);
  return at === null ? null : { line: at.line, column: 1 };
}

/** 大纲树折回预览面：`startLine` 折不回的符号**整枚丢弃**，`endLine` 折不回就收在起点那一行 */
function foldSymbolsToPreview(
  symbols: readonly EditorDocumentSymbol[],
  fold: (sourceLine: number) => number | null,
): EditorDocumentSymbol[] {
  const out: EditorDocumentSymbol[] = [];
  for (const symbol of symbols) {
    const startLine = fold(symbol.startLine);
    if (startLine === null) continue;
    const foldedChildren = symbol.children === undefined ? undefined : foldSymbolsToPreview(symbol.children, fold);
    out.push({
      ...symbol,
      startLine,
      endLine: Math.max(startLine, fold(symbol.endLine) ?? startLine),
      ...(foldedChildren !== undefined ? { children: foldedChildren } : {}),
    });
  }
  return out;
}

/** 屏幕上这份投影 model 自己的 URI 键（`inmemory://sugar/…`；桩 model 可能压根没有 uri） */
function projectionUriKeys(shown: Monaco.editor.ITextModel): Set<string> {
  const out = new Set<string>();
  const uri = (shown as unknown as { uri?: { fsPath?: unknown; path?: unknown } }).uri;
  if (!uri || typeof uri !== 'object') return out;
  for (const value of [uri.fsPath, uri.path]) {
    if (typeof value === 'string' && value.length > 0) out.add(pathKey(value));
  }
  return out;
}

/**
 * 符号落点（转到定义 / 跳到实现 / 查找引用**三条腿共用**，形状同为 `EditorSymbolLocation`）。
 *
 * **行号在这里不折**（与其余几条读类腿刻意不同）：落点那一侧的 model 是**原文**——Monaco 按
 * `filePath` 找的是原文那份 model，`clampRevealPosition` 也按原文行数夹取，把预览行号交给它
 * 就是跳到源文件的另一行。源行 → 预览行的那一跳早就在落点通道里做（`EditorPane` 的 `applyReveal`
 * 读同一张 `sugarLineMapRef`），这里再折一次就是折两遍。本函数只做糖面独有的三件事：
 * ① 同文件的落点若折不回预览行 ⇒ 丢弃（预览面上没有那一行，交出去等于一次原地不动的假跳转）；
 * ② 同文件的落点把列与区间抹成行首（纪律②）；
 * ③ 剔除**指向投影自己 URI** 的落点：本地腿（`#DIM` / `$`）2026-10-20 起已经换算成**存档坐标**、
 *    不再交回那条 URI，但剔除仍然要留——槽侧贡献方与迟到结果仍可能带着屏幕 model 的 uri 出来，
 *    而 `mergeSymbolLocations` 把它们排在最前、`planDefinitionJump` 的事件通道兜底只取第一枚
 *    ⇒ 不剔就是幻影把真算出来的源落点挤掉。
 * 跨文件的真落点原样交回——那是另一份文件，与这一面的映射无关。
 */
function foldLocationsToPreview(
  shown: Monaco.editor.ITextModel,
  target: ReadTarget,
  locations: readonly EditorSymbolLocation[],
): EditorSymbolLocation[] {
  const sugar = target.sugar;
  if (!sugar) return [...locations];
  const sameFile = pathKey(target.path);
  const phantom = projectionUriKeys(shown);
  const out: EditorSymbolLocation[] = [];
  for (const location of locations) {
    const key = pathKey(location.filePath);
    if (phantom.has(key)) continue;
    if (key !== sameFile) {
      out.push(location);
      continue;
    }
    if (sugar.fold(location.line) === null) continue;
    out.push({
      filePath: location.filePath,
      line: location.line,
      column: 1,
      ...(location.kind !== undefined ? { kind: location.kind } : {}),
    });
  }
  return out;
}

/** 屏幕上这份 model 的**悬停路径**（`installHover` 的注入位；原文面回 `null` = 沿用 `model.uri`） */
export function previewSourcePathOf(model: Monaco.editor.ITextModel): string | null {
  const ctx = sugarOwningPaneOf(model);
  // 只换算**身份**，不涉及行号 ⇒ 不要求映射已装配（投影退化时声明行悬停照样是真话）
  return ctx ? ctx.filePathRef.current || null : null;
}

/** 转到定义 / 跳到实现共用的读类腿（换算 → 问槽 → 折回） */
export function readDefinitionTargets(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  kernel: Kernel,
): DefinitionLocation[] {
  const target = readTargetOf(model);
  if (!target) return [];
  const at = sourcePointOf(target, position);
  if (at === null) return [];
  const locations = collectDefinitionLocations(kernel.slots.query('ui.editor.languageService'), {
    kind: 'definition',
    ...documentRequestFields(target.model, target.path, kernel.project.current()),
    line: at.line,
    column: at.column,
  });
  return target.sugar ? foldLocationsToPreview(model, target, locations) : locations;
}

/**
 * 引用腿（读类，与 `readDefinitionTargets` 同形状）：糖面换算到原文问一次，交回**源坐标**。
 *
 * `path` 一起交回是必要的而非顺手：引用计数读数（`onTally` → 台账 → 「被调用」面板）要知道
 * 这批读数是谁家的，糖面上那一位必须是**源路径**——投影不是文件，拿它的 URI 去对文件就是猜。
 * 返回 `null` = 无主 / 没有可问的原文 / 映射缺席 / 这一行没有源行（调用方据此给空列表）。
 */
export function readReferences(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  kernel: Kernel,
): { readonly path: string; readonly locations: readonly EditorSymbolLocation[] } | null {
  const target = readTargetOf(model);
  if (!target) return null;
  const at = sourcePointOf(target, position);
  if (at === null) return null;
  const locations = collectReferenceLocations(kernel.slots.query('ui.editor.languageService'), {
    kind: 'references',
    ...documentRequestFields(target.model, target.path, kernel.project.current()),
    line: at.line,
    column: at.column,
  });
  return {
    path: target.path,
    locations: target.sugar ? foldLocationsToPreview(model, target, locations) : locations,
  };
}

/** 文档大纲腿（吸顶与"转到符号"的数据源；糖面上折回预览行，两层消费方同一棵坐标一致的树） */
export function readDocumentSymbols(
  model: Monaco.editor.ITextModel,
  kernel: Kernel,
): EditorDocumentSymbol[] {
  const target = readTargetOf(model);
  if (!target) return [];
  const symbols = collectDocumentSymbols(kernel.slots.query('ui.editor.languageService'), {
    kind: 'documentSymbol',
    ...documentRequestFields(target.model, target.path, kernel.project.current()),
  });
  return target.sugar ? foldSymbolsToPreview(symbols, target.sugar.fold) : symbols;
}

/**
 * 折叠腿：档位与版本记忆化都判在**原文 model** 上（糖面问的就是那一篇），交回前把区间折回预览行。
 * 折完 `end <= start` 与重复区间由 `toMonacoFoldingRanges` 那道既有闸收口，本处不重抄判据。
 */
export function readFoldingRanges(
  model: Monaco.editor.ITextModel,
  kernel: Kernel,
): EditorFoldingRange[] {
  const target = readTargetOf(model);
  if (!target) return [];
  const ranges = foldingRangesFor(target.model, target.path, kernel);
  if (!target.sugar) return ranges;
  const fold = target.sugar.fold;
  const out: EditorFoldingRange[] = [];
  for (const range of ranges) {
    const startLine = fold(range.startLine);
    if (startLine === null) continue;
    out.push({ ...range, startLine, endLine: Math.max(startLine, fold(range.endLine) ?? startLine) });
  }
  return out;
}

/**
 * 行上注解腿：注解**画在预览面上** ⇒ 行号必须折回；`target` 那一位照旧留**源坐标**——点击落回
 * `editor.revealLocation`，那条腿的落点侧按同一张表换算（折两遍就会跳到别处）。
 * 折回后同一预览行上同一句话并成一条（供方的去重键是源行 + 文本，跨面换算会把它打散）。
 */
export function readCodeLenses(model: Monaco.editor.ITextModel, kernel: Kernel): EditorCodeLens[] {
  const target = readTargetOf(model);
  if (!target) return [];
  const lenses = codeLensesFor(target.model, target.path, kernel);
  if (!target.sugar) return lenses;
  const out: EditorCodeLens[] = [];
  const seen = new Set<string>();
  for (const lens of lenses) {
    const line = target.sugar.fold(lens.line);
    if (line === null) continue;
    const key = `${line}\u0000${lens.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...lens, line });
  }
  return out;
}

/**
 * 行内提示腿：提示钉在预览面上 ⇒ 折行、列落行首（纪律②），落在同一格同一句话的并成一条
 * （源侧那几枚各自钉在某个实参之前，预览行没有那些实参的位置可言）。
 */
export function readInlayHints(model: Monaco.editor.ITextModel, kernel: Kernel): EditorInlayHint[] {
  const target = readTargetOf(model);
  if (!target) return [];
  const hints = inlayHintsFor(target.model, target.path, kernel);
  if (!target.sugar) return hints;
  const out: EditorInlayHint[] = [];
  const seen = new Set<string>();
  for (const hint of hints) {
    const line = target.sugar.fold(hint.line);
    if (line === null) continue;
    const key = `${line}\u0000${hint.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...hint, line, column: 1 });
  }
  return out;
}

/** 签名腿：窗口取文落在**原文 model** 上（`SIGNATURE_LOOKBACK_LINES` 的回看行数是源侧事实） */
export function readSignatureHelp(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  kernel: Kernel,
): ResolvedSignature | null {
  const target = readTargetOf(model);
  if (!target) return null;
  const at = sourcePointOf(target, position);
  if (at === null) return null;
  return signatureHelpAt(target.model, { lineNumber: at.line, column: at.column } as Monaco.Position, kernel);
}

/**
 * 符号树（面包屑缓存那一棵，**源空间**）：跳转探针两条面共用。
 * 缓存键 = `(原文路径, 原文 model 版本号)` ⇒ 预览与原文两种面上存的是**同一份**源空间数据，
 * 撤下预览后照旧命中，不存在"把预览坐标系的树留在缓存里"这种串。
 */
function documentSymbolsCached(ctx: PaneCtx, target: ReadTarget): EditorDocumentSymbol[] {
  const versionId = target.model.getAlternativeVersionId();
  const cache = ctx.crumbTreeCacheRef.current;
  if (cache && cache.path === target.path && cache.versionId === versionId) return cache.symbols;
  const kernel = requireKernel();
  const symbols = collectDocumentSymbols(kernel.slots.query('ui.editor.languageService'), {
    kind: 'documentSymbol',
    ...documentRequestFields(target.model, target.path, kernel.project.current()),
  });
  ctx.crumbTreeCacheRef.current = { path: target.path, versionId, symbols };
  return symbols;
}

/* ========================================================================================
 * PS-4（2026-10-18 性能批）· 大文档 provider 缝的三件机制
 *
 * 尺子 = 真实语料之最那篇 **52,601 行 / 2.35 MB** 的 ERB（`docs/STATE.md` §二另记 99 万行级盘）。
 * 这一族 provider 的每一次请求都要把**整篇文档**抄成一份 JS 字符串再交给插件，而 Monaco 又在
 * **停笔 / 每次滚动 / 每次光标移动 / 每次波浪线刷新**后重新问一遍 ⇒ "整篇复制"是一等缺陷。
 *
 * 三条机制，各自对标 VSCode 消掉这一类成本的那一个机制：
 * ① **档位让路**（`editor.largeFileOptimizations` 所在的位置）：让路判在**请求之前**，档外一次
 *    都不扫；让路不许静默，由 `warnSeamDegradedOnce` 逐文件报一次（与 `ui-sugar-lift` 的
 *    `warnLargeOnce` 同纪律）。**折叠这一条的档位在 1020 止血批改过一次**：判据不再是本模块
 *    自立的 `LARGE_FILE_LINES`，而是档位表上 `folding` 那一条（`foldingEnabledForLineCount`），
 *    并按 VSCode 的 `FoldingLimitReporter` 补了"超额的那部分要说出来"这一格——见下面
 *    `foldingAffordable` 与 `capFoldingRanges` 两处注。
 * ② **版本记忆化**（tsserver 单文件增量失效所在的位置：内容没变就绝不重算）：
 *    `memoizedDocument` 按 `(真路径, alternativeVersionId, 项目引用, 贡献方条数)` 认文档，
 *    四项任一项变即重算。每一项都有必然性——少一项就是一次"把上一个项目 / 别份文件的
 *    解析结果搬到这一份上"的事故（`editorTables` 那条"索引每次现取"纪律在本批的等价物）。
 * ③ **区间窗口**（LSP 的 `textDocument/*` 都带 range 的那个形状）：签名帮助只取光标行往上
 *    `SIGNATURE_LOOKBACK_LINES` 行那一段，on-type 格式化只取触发行那一行
 *    （`monaco/kojo-format-range.ts` 的 `resolveRange` 那条腿）。
 *
 * 档位线一律**引用** `editor-options.ts` 那一张表（本模块不写第二个数字，也不再自己判一次）。
 * ==================================================================================== */

/**
 * 四条「整篇文档一次解析」腿各自的记忆化（`WeakMap` 以 model 为键：标签关掉、model 释放之后
 * 条目自然可回收，不需要额外的清理时机）。`let` 而不是 `const`：整套注册拆毁时
 * （`teardownGlobalProviders`）换一张新的，绝不让上一个 kernel 的解析结果活到下一次挂载。
 */
let foldingMemo = new WeakMap<Monaco.editor.ITextModel, DocumentMemoEntry<EditorFoldingRange[]>>();
let inlayHintsMemo = new WeakMap<Monaco.editor.ITextModel, DocumentMemoEntry<EditorInlayHint[]>>();
let codeLensesMemo = new WeakMap<Monaco.editor.ITextModel, DocumentMemoEntry<EditorCodeLens[]>>();
let codeActionsMemo = new WeakMap<Monaco.editor.ITextModel, CodeActionsMemoEntry>();

/** 一条「整篇文档一次解析」腿的记忆化键（四项缺一即可能把别的项目 / 别份文件的结论搬过来） */
interface DocumentMemoKey {
  readonly path: string;
  readonly versionId: number;
  readonly project: GameProject | null;
  readonly contributions: number;
}

interface DocumentMemoEntry<V> extends DocumentMemoKey {
  readonly value: V;
}

/**
 * 折叠这一族的**档位**判据（1020 止血批改过一次，理由要说清）：
 *
 * PS-4 原本在这里自己按 `LARGE_FILE_LINES`（5,000 行）让路，而**同一批**在档位表上写的是
 * 「折叠留到 huge 才关……5k–50k 档一次 provider 调用实测远小于其余几条，不值这一刀」
 * （`ui/editor-options.ts` 的 `TIER_LARGE` / `TIER_HUGE`）。两份判据对不上的后果不是"慢一点"：
 * 编辑器注册了 foldingRange 供给器，Monaco 就**不再退回缩进折叠**（取证
 * `contrib/folding/browser/folding.js:67` 的 `_useFoldingProviders = foldingStrategy !== 'indentation'`
 * + `getRangeProvider()` 里"有供给器 ⇒ SyntaxRangeProvider"那一段），于是 5,000–49,999 行那份文件
 * 面上留着折痕、**一处也折不动**，唯一的信号是一条 `console.warn`（桌面壳里看不见）——
 * 铁律 4「inactive 必须可见」直接破。语料里约 6% 的文件正落在这一档。
 *
 * 现在**只有一份判据**：档位表上 `folding` 那一格（{@link foldingEnabledForLineCount}）。
 * 表说关（≥ 50,000 行）这边才让路，并且**关在选项上看得见**——`folding:false` 会让 Monaco
 * 把整条折叠槽撤掉，作者看到的是"没有折痕"，而不是"有折痕但折不动"。
 *
 * 判据留在**缝上**（不在 `monaco/kojo-folding.ts`）：那一层只做协议翻译，插件侧
 * `erb-parser/src/plugin.ts` 的 `erb-folding` 又明确写了"不按 lineCount 降级"——
 * 档位是宿主的产品判据，本批只在接线处立闸，不动任何供方口径。
 */
export function foldingAffordable(lineCount: number): boolean {
  return foldingEnabledForLineCount(lineCount);
}

/**
 * 一次交回的折叠区间**数量**上限。对标的是 VSCode 的 `FoldingLimitReporter` 那一格：
 * 大文件上它不杀供给器，而是**按数量**截并**把截了多少说出来**
 * （那句 "folding was removed for N ranges because the file is too large"）。
 *
 * 数字不是新造的，取 vendor 自己那条线的缺省值（取证 `common/config/editorOptions.js`
 * 的 `EditorIntOption(56, 'foldingMaximumRegions', 5000, 10, 65000)`；硬顶在
 * `contrib/folding/browser/foldingRanges.js` 的 `MAX_FOLDING_REGIONS = 0xFFFF`）：
 * Monaco 本来就会在 5,000 条上把多出来的丢掉，我们只是**在它丢之前自己先丢、并且说一声**——
 * standalone 那份 `RangesLimitReporter`（`folding.js:418`）在本 app 里没人接它的
 * `onDidChange`（那句话是 workbench 侧的 notification service 发的），所以数量超额若不由宿主说，
 * 就又是一次静默。真实语料之最那篇（52,601 行）的函数 + 控制流块远不到 5,000 条 ⇒ 这一档
 * **不削任何今天存在的文件**，只兜住"块数病态多"的那一类。
 */
export const FOLDING_MAX_RANGES = 5_000;

/** 折叠被按数量截了尾巴的那句话（{@link onFoldingCapChanged} 递给宿主；null = 没截） */
export interface FoldingCapNotice {
  readonly shownRanges: number;
  readonly droppedRanges: number;
}

/**
 * 每 (能力, 文件) 一次的降级告警去重表（超阈值整体清，与 `ui-sugar-lift` 同一手法）；
 * 另加一张"此刻哪几份文件的折叠被截了尾巴"的可见态 + 订阅表（宿主工具条那句人话读它）。
 * 两套都在 `teardownGlobalProviders` 里换新的，绝不留给下一个 kernel。
 */
let degradedSeams = new Set<string>();
let foldingCaps = new Map<string, FoldingCapNotice>();
const foldingCapListeners = new Set<(path: string, notice: FoldingCapNotice | null) => void>();

function warnSeamDegradedOnce(capability: string, path: string): void {
  const key = `${capability}\u0000${path}`;
  if (degradedSeams.has(key)) return;
  if (degradedSeams.size > 200) degradedSeams = new Set();
  degradedSeams.add(key);
  console.warn(
    `[editor-providers] ${capability}在这次请求里让了路（${path}）：这一档的编辑器选项本来就把它关了，全文级解析省着来`,
  );
}

/**
 * 订阅"折叠数量封顶"的可见态变化（EditorPane 的工具条徽章读它）。
 * 只在**状态真的变了**时通知；返回退订函数。
 */
export function onFoldingCapChanged(
  listener: (path: string, notice: FoldingCapNotice | null) => void,
): () => void {
  foldingCapListeners.add(listener);
  return () => {
    foldingCapListeners.delete(listener);
  };
}

/** 当前这份文件的折叠封顶态（没截过 = null）；宿主挂载时用它把已有状态补回来 */
export function foldingCapNoticeFor(path: string): FoldingCapNotice | null {
  return foldingCaps.get(path) ?? null;
}

function setFoldingCap(path: string, notice: FoldingCapNotice | null): void {
  const prev = foldingCaps.get(path);
  if (notice === null) {
    if (prev === undefined) return;
    foldingCaps.delete(path);
  } else {
    if (prev && prev.shownRanges === notice.shownRanges && prev.droppedRanges === notice.droppedRanges) return;
    foldingCaps.set(path, notice);
  }
  for (const listener of [...foldingCapListeners]) listener(path, notice);
}

/**
 * **按数量**给折叠封顶（而不是"文件大就一条都不给"）：超额时留下最靠前的那些块
 * （排序与 `toMonacoFoldingRanges` 同口径：起点升序、同起点终点降序 ⇒ 外层块在前），
 * 并把"截了多少"经 `setFoldingCap` 说出去。没超额就把上一条说法撤掉。
 */
function capFoldingRanges(path: string, ranges: EditorFoldingRange[]): EditorFoldingRange[] {
  if (ranges.length <= FOLDING_MAX_RANGES) {
    setFoldingCap(path, null);
    return ranges;
  }
  const kept = [...ranges]
    .sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine)
    .slice(0, FOLDING_MAX_RANGES);
  setFoldingCap(path, { shownRanges: kept.length, droppedRanges: ranges.length - kept.length });
  return kept;
}

/**
 * 一次请求的文档身份（记忆化的键）。`versionId` 取 `getAlternativeVersionId()`——与撤销栈
 * 同步的那个号：同一份内容必得同一个号，内容与号一一对得上（面包屑树那份缓存同口径）。
 */
function documentMemoKey(
  model: Monaco.editor.ITextModel,
  path: string,
  kernel: Kernel,
  contributions: number,
): DocumentMemoKey {
  return {
    path,
    versionId: model.getAlternativeVersionId(),
    project: kernel.project.current(),
    contributions,
  };
}

function sameDocumentKey(a: DocumentMemoKey, b: DocumentMemoKey): boolean {
  return a.path === b.path &&
    a.versionId === b.versionId &&
    a.project === b.project &&
    a.contributions === b.contributions;
}

/** 记忆化本体：键合就交回缓存，否则算一次并记下（`compute` 里只许做纯取数） */
function memoizedDocument<V>(
  store: WeakMap<Monaco.editor.ITextModel, DocumentMemoEntry<V>>,
  model: Monaco.editor.ITextModel,
  key: DocumentMemoKey,
  compute: () => V,
): V {
  const hit = store.get(model);
  if (hit && sameDocumentKey(hit, key)) return hit.value;
  const value = compute();
  store.set(model, { ...key, value });
  return value;
}

/**
 * 折叠范围（PS-4 的①+②，1020 止血批把①的判据搬回档位表）：
 * 档位判在取文之前（**与编辑器选项同一份表**），档内按版本记忆化，交回前**按数量**封顶
 * 并把超额的那部分说出来。
 *
 * 记忆化不改变任何判据：同一份 (文档, 项目, 贡献方) 的同一次问，答案本来就应当逐字相同
 * （供方是纯函数）。省掉的是 Monaco 在停笔 / 换 model / 改配置后重复问的那几次整篇拷贝。
 * 封顶放在记忆化**之外**：缓存命中也算一次"这一份文件此刻被截了没有"，可见态才不会
 * 停在上一份内容留下的那句话说（每次都判，但只有状态真变了才通知）。
 */
export function foldingRangesFor(
  model: Monaco.editor.ITextModel,
  path: string,
  kernel: Kernel,
): EditorFoldingRange[] {
  const lineCount = model.getLineCount();
  if (!foldingAffordable(lineCount)) {
    // 这一档的编辑器选项本来就把折叠关了（折叠槽整条不见 ⇒ 看得见）；这里的可见态一并清零，
    // 不许把"上一档截了尾巴"那句话留在已经没有折痕的面上。
    setFoldingCap(path, null);
    warnSeamDegradedOnce('折叠', path);
    return [];
  }
  const contributions = kernel.slots.query('ui.editor.languageService');
  const ranges = memoizedDocument(foldingMemo, model, documentMemoKey(model, path, kernel, contributions.length), () =>
    collectFoldingRanges(contributions, {
      kind: 'foldingRange',
      ...documentRequestFields(model, path, kernel.project.current()),
    }),
  );
  return capFoldingRanges(path, ranges);
}

/**
 * 行内提示（PS-4 的②+③）：档内问一次记一次。
 *
 * 为什么不按 Monaco 给的区间**取文**：供方 `visibleCodeLines` 带 `[SKIPSTART]…[SKIPEND]`
 * 的跨行状态，从窗口中间起算会把屏蔽区里的行当代码行 ⇒ 凭空多出提示（错标比不标危险）。
 * 区间这一侧本批改的是**交回**：`toMonacoInlayHints` 只交回这一段（见该模块头注），
 * 每次滚动不再为全篇每条提示重建装饰器。
 */
export function inlayHintsFor(
  model: Monaco.editor.ITextModel,
  path: string,
  kernel: Kernel,
): EditorInlayHint[] {
  const lineCount = model.getLineCount();
  if (!inlayHintsAffordable(lineCount)) return [];
  const contributions = kernel.slots.query('ui.editor.languageService');
  return memoizedDocument(inlayHintsMemo, model, documentMemoKey(model, path, kernel, contributions.length), () =>
    collectInlayHints(contributions, {
      kind: 'inlayHint',
      ...documentRequestFields(model, path, kernel.project.current()),
    }),
  );
}

/**
 * 行上注解（PS-4 的②）：判据与档位照旧全在接线处，只把"同一篇没改过第二次"的那几次
 * 整篇拷贝挡掉（Monaco 在 model 切换 / 配置变化 / 注册表变化后也会重新问一遍）。
 */
export function codeLensesFor(
  model: Monaco.editor.ITextModel,
  path: string,
  kernel: Kernel,
): EditorCodeLens[] {
  const lineCount = model.getLineCount();
  if (!codeLensAffordable(lineCount)) return [];
  const contributions = kernel.slots.query('ui.editor.languageService');
  return memoizedDocument(codeLensesMemo, model, documentMemoKey(model, path, kernel, contributions.length), () => {
    const lenses = collectCodeLenses(contributions, {
      kind: 'codeLens',
      ...documentRequestFields(model, path, kernel.project.current()),
    });
    // 产出预算：**全有或全无**（缺席携带语义，不许用来表示"额度用完了"）
    return withinCodeLensBudget(lenses.length, lineCount) ? lenses : [];
  });
}

/**
 * 签名帮助（PS-4 的③）：**只取光标行往上那一段窗口**，整篇一次都不 copy。
 *
 * 等价性可证：`findCallSiteAt` 的向上收行有硬上限（`SIGNATURE_LOOKBACK_LINES`），
 * 窗口给的就是"上限那么多行 + 光标行"，它读到的行集合与整篇视角逐字相同；
 * 窗口更短只可能是文档本来就到顶（第一行往上没有了）。
 * 行号按窗口内坐标递进去（`resolveSignatureInText` 的 `lineNumber` 是**它拿到的那段文本**的行号）。
 */
export function signatureHelpAt(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  kernel: Kernel,
): ResolvedSignature | null {
  if (!Number.isFinite(position.lineNumber) || position.lineNumber < 1) return null;
  if (position.lineNumber > model.getLineCount()) return null;
  const protocol = editorTables(kernel).callProtocol;
  const from = Math.max(1, position.lineNumber - SIGNATURE_LOOKBACK_LINES);
  const windowText = model.getValueInRange({
    startLineNumber: from,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: model.getLineMaxColumn(position.lineNumber),
  });
  return resolveSignatureInText(windowText, position.lineNumber - from + 1, position.column, protocol, (callee) => {
    try {
      const index = erbParserIndex(kernel);
      if (!index) return null;
      const defs = index.byName.get(callee.toUpperCase());
      const ref = defs?.[0];
      if (!ref) return null;
      const file = index.files.get(ref.filePath);
      const fn = file?.functions.find((f) => f.startLine === ref.startLine);
      return fn ? fn.params : null;
    } catch {
      return null;
    }
  });
}

/**
 * on-type / 选区格式化那条**窗口取文腿**（PS-4 的③）：只把要算的那几行交给规则层。
 *
 * 判据全在 `monaco/kojo-format-range.ts`（等价性钉子在那边与 `tests/ps4-provider-seams.test.ts`，
 * 单价差在 `tests/ps4-provider-seams.perf.test.ts`）。
 * 交回 `null` = 这次不适用 ⇒ 调用方自动退回整篇那条腿：
 * 糖视图的派生 model（行号不属于真文件）、认不出方言的语言、以及**`.kojo`**——后者的缩进单位
 * 探测与 `@` 原生块状态是文档级判据，窗口视角会数错（见 `kojo-format.ts` 区间格式化头注）。
 */
export function formatRequestWindowFor(
  model: Monaco.editor.ITextModel,
  startLine: number,
  endLine: number,
): FormatRequest | null {
  const path = owningPanePathOf(model);
  if (path === null) return null;
  const dialect = dialectForLanguage(model.getLanguageId());
  if (dialect !== 'erb') return null;
  const lineCount = model.getLineCount();
  const from = Math.min(Math.max(1, Math.trunc(startLine) || 1), lineCount);
  const to = Math.min(Math.max(from, Math.trunc(endLine) || from), lineCount);
  return {
    dialect,
    text: model.getValueInRange({
      startLineNumber: from,
      startColumn: 1,
      endLineNumber: to,
      endColumn: model.getLineMaxColumn(to),
    }),
  };
}

/** 💡 一次请求里登记过的动作（缓存命中时要把 id → 动作重新挂回反查表，命令才执行得了） */
interface CodeActionRegistration {
  readonly actionId: string;
  readonly action: EditorCodeAction;
}

/** 💡 那条腿的缓存键：文档身份四项 + 这一次的行 + 面上这几条波浪线的身份 */
interface CodeActionsMemoKey extends DocumentMemoKey {
  readonly line: number;
  readonly markers: string;
}

interface CodeActionsMemoEntry extends CodeActionsMemoKey {
  readonly actions: Monaco.languages.CodeAction[];
  readonly registrations: readonly CodeActionRegistration[];
}

/**
 * 波浪线身份串（💡 记忆化键的一部分）。
 *
 * 逐条取 `severity | 行 | 列 | 码 | 消息`——与 `kojo-code-action.ts` 的 `diagnosticKey`
 * 同一族字段（消息必须在内：两条同行同码不同消息的诊断在贡献方那里是两个问题）。
 * 单价 = O(本次请求区间内的 marker 条数)：standalone 已按请求区间求交
 * （vendor `standaloneLanguages.js:416`），所以它是"这一行的那几条"，不是全篇的波浪线。
 */
function markersDigest(diagnostics: readonly LineDecoration[]): string {
  return diagnostics
    .map((d) => `${d.severity}\u0001${d.line}\u0001${d.code ?? ''}\u0001${d.message}`)
    .join('\u0002');
}

/**
 * 💡 快速修复这一条腿（PS-4 的①②③里最便宜的那一种做法：**先判该不该问，再取文**）。
 *
 * 两道闸：
 * - **零波浪线 + ERB 方言 ⇒ 一条都不问**：这一族贡献方全部按"面上画着的那条红线"应答
 *   （`erb-structure-fix` 按 `code` + 行精确匹配、`convention-quickfix` 按 `diagnosticKey`
 *   求交，空诊断集必然空结果），而判据之前那次 `getValue()` 与插件里那次整篇
 *   `split('\n')` + 结构体检（`structure-fix.ts` 的 `buildStructureFixes`）是白付的。
 *   这一档**不减能力**：没有可修的红线时，改前改后都是零条动作。
 *   `.kojo` 现在走同一道闸：唯一的 `.kojo` 供方 `sugar-quickfix` 在零诊断时本就返回空
 *   （LIFT-2 删掉「改为语法糖写法」后，`.kojo` 上不再有不依赖波浪线的动作）。
 *   ⚠ 将来若给 ERB / `.kojo` 加**不依赖波浪线**的动作（重构族），这道闸要按语言/类别放行，别照抄本行。
 * - **同一篇没改过 + 同一行 + 同一组波浪线 ⇒ 结果照抄**：Monaco 的 💡 在每次光标移动
 *   与每次 marker 重发布后都会重新问（vendor `codeActionModel.js:30-31,44`，防抖 250ms），
 *   两次问之间文本没动过，答案必然逐字相同。缓存命中时把 `id → 动作` **重新挂回**
 *   `pendingActionsRef`，所以反查表被超阈值整体清理过也照样执行得了。
 *
 * **这条腿为什么不立 `LARGE_FILE_LINES` 那道档位闸**：折叠 / 注解 / 行内提示那三条是
 * "锦上添花"（没了我少看一点，面上还说得过去），而 💡 是**红线旁边唯一的出口**——
 * 大文件恰恰是最需要修结构的地方，按行数让路就是把作者的修复按钮按体量没收，
 * 而 Monaco 的动作列表没有列表头可以写"文件太大，这次不给"（codeLens 那条
 * "缺席携带语义 ⇒ 宁可整篇不给"的纪律在这里反过来成立：这里的缺席就是"没法修"）。
 * 于是这一族的"该不该付这一刀"由**有没有波浪线**判，而不是由行数判：
 * 实测同一篇 52,601 行的文档，零波浪线时改前白付中位 85–275 ms（本机两轮，满载更慢）、
 * 改后 0.002 ms（`tests/ps4-provider-seams.perf.test.ts`），有波浪线时那一次请求本来就该付。
 */
export function provideCodeActionsFor(
  model: Monaco.editor.ITextModel,
  range: Monaco.Range | undefined,
  context: Monaco.languages.CodeActionContext,
  ctx: PaneCtx,
  kernel: Kernel,
): Monaco.languages.CodeActionList {
  const path = ctx.filePathRef.current;
  if (!path) return { actions: [], dispose: () => undefined };
  const diagnostics = markersToDecorations(monaco, context.markers ?? []);
  if (
    diagnostics.length === 0 &&
    descriptorForLanguageId(model.getLanguageId())?.languageServices === true
  ) {
    return { actions: [], dispose: () => undefined };
  }
  const pending = ctx.pendingActionsRef.current;
  // 超阈值整体清理（长期运行不至于无限增长）；id 单调递增，绝不复用
  if (pending.size > 500) pending.clear();
  const contributions = kernel.slots.query('ui.editor.codeAction');
  const line = range?.startLineNumber;
  const key: CodeActionsMemoKey = {
    ...documentMemoKey(model, path, kernel, contributions.length),
    line: line ?? 0,
    markers: markersDigest(diagnostics),
  };
  const hit = codeActionsMemo.get(model);
  if (
    hit &&
    sameDocumentKey(hit, key) &&
    hit.line === key.line &&
    hit.markers === key.markers
  ) {
    for (const { actionId, action } of hit.registrations) pending.set(actionId, action);
    return { actions: hit.actions, dispose: () => undefined };
  }
  const registrations: CodeActionRegistration[] = [];
  const actions = collectCodeActions(
    contributions,
    {
      path,
      text: model.getValue(),
      project: kernel.project.current(),
      lineCount: model.getLineCount(),
      ...(line !== undefined ? { line } : {}),
      // B9：本次请求对应的**当前波浪线**（Monaco 的 standalone 包装层已按区间求交填好
      // `context.markers`）⇒ 贡献方按 `code` 精确应答，零 marker = 这个区间本来就没红线
      diagnostics,
    },
    {
      register: (contributionId, action) => {
        const actionId = `${ctx.paneId}:${contributionId}#${++ctx.actionSeqRef.current}`;
        pending.set(actionId, action);
        registrations.push({ actionId, action });
        return actionId;
      },
      markerDataFor: (action) => actionDiagnostics(monaco, model, action),
    },
    CODE_ACTION_COMMAND,
  );
  codeActionsMemo.set(model, { ...key, actions, registrations });
  return { actions, dispose: () => undefined };
}

let globalsInstalled = false;
const globalDisposers: Monaco.IDisposable[] = [];

/**
 * Peek 未打开文件的租约（1020 编辑器体感批，项 7）：与全局 provider **同生共死**。
 *
 * 惰性建（第一次真需要隐藏 model 时才建）：`acquire` 要 kernel，而 kernel 在装配之后才存在。
 * 拆毁时机与 provider 同一处（`teardownGlobalProviders`）——上一套注册留下的租约若活到下一个
 * kernel，那些 model 就挂在池里没人放（池的引用计数是 app 级单例的账，不随换项目清零）。
 */
let peekLeases: PeekLeases | null = null;
const peekLeasesOf = (): PeekLeases =>
  peekLeases ??= createPeekLeases({
    acquire: (path) => editorModelPool.acquire(requireKernel(), path),
    release: (path) => {
      editorModelPool.release(path);
    },
  });

/**
 * 「这个目标文件有没有 model 可 Peek」（D4 判腿与构造链接两条腿共用的问法）：
 * 先问全部组的**打开表**（开着的标签 = 权威，那份 model 正被编辑器显示），
 * 打不开表才问 Peek 租约（项 7 补的那一层）。顺序反了会把"作者刚关掉的那一份"
 * 当成 peek 目标——池按路径共享同一份 model，租约里留着的那份就是打开表里的那份。
 */
const modelForPeekPath = (path: string): Monaco.editor.ITextModel | undefined =>
  openModelAcrossGroups(path) ?? (peekLeases?.modelFor(path) ?? undefined);

/** URI → 宿主路径（opener 反查）：打开表优先，问不到再看租约（隐藏 model 的 URI 就是 `Uri.file(path)`） */
const pathForPeekUri = (uri: string): string | undefined =>
  pathForUriAcrossGroups(uri) ?? (peekLeases?.pathOfUri(uri) ?? undefined);
/** Monarch 词表等模块级资源的实例引用计数（最后一个实例退场才清） */
let erbWordsUsers = 0;
let lastWordsKey = '__unset__';

/**
 * 全局 provider 的**单次注册**（SPLIT-1 多实例基座）：standalone Monaco 的
 * `monaco.languages.*` provider / `registerCommand` / 跳转探针都是模块级单表，
 * 每个实例各注册一份 = 补全候选成对重复、命令解析错组。这里只在首个实例挂载时
 * 注册一次；各 resolve 回调收到 `model` 后经 `owningPaneOf` 反查归属实例再读它的
 * ref——单实例时与旧版（闭包直读自身 ref）逐字等价，多实例时按"model 在哪组编辑器
 * 上活动"分派。最后一个实例退场时整体拆毁（`disposeGlobalProviders`）。
 *
 * **全有或全无**（缺陷 2）：注册序列里每一枚成功建立**立即**进入 `globalDisposers`
 * （`globalDisposers.push(...)` 逐枚写在注册点上，不是收尾一次性并入）；任一枚注册抛错时
 * 把**已登记的**逐枚拆掉、清空登记表、复位 `globalsInstalled` 后**重新抛出**。半途失败绝不
 * 留 `globalsInstalled = true`——否则每次 EditorPane 挂载都被开头那道门挡住、永不重试，
 * 补全 / 💡 / 悬停 / 改名整批 provider 就此静默永久缺失（铁律 4：内核不静默，宿主同样不静默）。
 */
export function ensureGlobalProviders(): void {
  if (globalsInstalled) return;
  // 置位只为挡住同一批挂载里的重入；抛错路径由下面 catch 撤回（见模块内"全有或全无"注）。
  globalsInstalled = true;
  try {
    // 💡 CodeAction 宿主适配（槽 `ui.editor.codeAction`，P3b）：宿主只做 Monaco 协议
    // 转换（registerCodeActionProvider），动作产出全在插件（纯函数 provideActions）；
    // 执行经 registerCommand 落地，command 参数用 id 反查 pendingActionsRef（参数须可
    // 序列化，且避免闭包捕获过时文本）。
    globalDisposers.push(monaco.editor.registerCommand(CODE_ACTION_COMMAND, (_accessor, actionId: string) => {
      const sep = actionId.indexOf(':');
      // 动作 id 首段 = 归属实例（provideCodeActions 生成时打上的前缀）：反查活实例档案
      const ctx = sep > 0 ? livePanes.get(actionId.slice(0, sep)) : undefined;
      const action = ctx?.pendingActionsRef.current.get(actionId);
      if (!action) return;
      const ed = ctx?.editorRef.current ?? null;
      // 有 `edits` 的动作 = **改文本本身**（可撤销）：宿主直接落地，不再走 `run`
      //（两者语义不同，见 `EditorTextEdit` 契约；`.kojo` 快速修复走这条）。
      // 糖视图下 `ed.getModel()` 是只读糖 model：编辑无处可落（applyTextEdits 会改到派生物
      // 而非原文），直接跳过，避免"改了却不在真文件里"。
      //
      // P2-14 起**先预览、确认才落**：不再直接 `applyTextEdits`，而是算出预览文本
      // （与落地同一套夹取/降序规则，见 `quick-fix-preview.ts`）、登记待确认条目、
      // 打开预览 overlay。用户可感知的行为变化：`Ctrl+.` / 💡 里的改文本动作，Enter 现在
      // 是"开预览"，预览里 Enter = 应用、Esc = 取消（取消一个字符都不写）。
      if (action.edits && action.edits.length > 0 && ed && !ctx?.sugarModelRef.current && ed.getModel()) {
        const model = ed.getModel()!;
        const originalText = model.getValue();
        pushPreview({
          paneId: ctx!.paneId,
          actionId,
          title: quickFixPreviewTitle(action),
          languageId: model.getLanguageId(),
          originalText,
          previewText: previewTextFor(originalText, action.edits),
          edits: action.edits,
        });
        requireKernel().bus.emit('ui.overlay.open', {
          id: QUICK_FIX_PREVIEW_OVERLAY_ID,
          source: 'host:quick-fix-preview',
        });
        return;
      }
      const line = ed?.getPosition()?.lineNumber;
      void action.run({
        project: requireKernel().project.current(),
        activeFile: ctx?.filePathRef.current,
        ...(line !== undefined ? { line } : {}),
      });
    }));
    // 一等语言（descriptor 声明 languageServices）共用这一枚 provider；新增语言零改动
    const codeActionLanguages = languageDescriptors()
      .filter((descriptor) => descriptor.languageServices === true)
      .map((descriptor) => descriptor.id);
    globalDisposers.push(monaco.languages.registerCodeActionProvider(
      codeActionLanguages,
      {
        provideCodeActions: (model, range, context) => {
          const ctx = owningPaneOf(model);
          // 只对当前活动标签的 model 供动作（后台 model 的 provider 调用不响应）；
          // 糖视图下挂的是只读糖 model，不供任何 CodeAction（编辑落点无真文件可依）。
          if (!ctx || !ctx.filePathRef.current) {
            return { actions: [], dispose: () => undefined };
          }
          // PS-4：两道闸（零波浪线的方言请求不问供方 / 同一篇同一行同一组波浪线照抄上次）
          // 与取数全在 `provideCodeActionsFor`（判据与等价性钉子见那里 + `tests/ps4-*.test.ts`）
          return provideCodeActionsFor(model, range, context, ctx, requireKernel());
        },
      },
      // B9：类别声明走 metadata（Monaco 用它决定 `Ctrl+.` 这条 only=quickfix 的
      // 显式请求要不要调用本 provider，并写进 `supportedCodeActions` 上下文键）
      { providedCodeActionKinds: PROVIDED_CODE_ACTION_KINDS },
    ));
    // 悬停中文名（ZH-F2）：只读显示，光标下的原生记号 → 中文名。表按当前项目 adapterId
    // **运行时**现取（`editorTables`），查不到即不显示（**不猜**）。与 CodeAction 同款隔离。
    // 第三参 = 本文件身份的换算：投影那份 `inmemory://sugar/…` 的 URI 在索引里对不到任何文件，
    // `#DIM` 声明那一路于是在预览面上静默；原文面回 `null` ⇒ 沿用 `model.uri`，逐字不变。
    globalDisposers.push(installHover(monaco, () => editorTables(requireKernel()), previewSourcePathOf));
    // 转到定义（2026-10-15 语言服务批）：宿主只做 Monaco 协议翻译——光标位置进、目标位置出；
    // "那个名字是什么、定义在哪"全在 `ui.editor.languageService` 槽（ERB 由解析器答、
    // `.kojo` 由糖线答）。跨文件跳转不新造机制：发 `editor.revealLocation`（宿主既有通道，
    // App 据此开文件、编辑器据此滚动）——与 codeAction 的"宿主零业务"同一分层。
    // D4（2026-10-15 Peek 批）追加两条腿：目标在同文件/已开标签时**返回真 LocationLink**
    // （Monaco 的 `Alt+F12` Peek 与就地跳都以这份返回为数据源），其余情形照旧发事件。
    // 转到定义与跳到实现**共用这一条取数腿**（W9：`ImplementationHandlers = DefinitionHandlers`，
    // 两者要的"名字 → 定义位"是同一份数据；写两份就是允许第二条腿自己再算一遍，
    // 旧 `erb-implementation` 直读 `ErbIndex.byName` 正是这么长出第二份计算的）。
    const resolveDefinitionTargets = (
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
    ): DefinitionLocation[] => readDefinitionTargets(model, position, requireKernel());
    globalDisposers.push(installDefinitionProvider(monaco, {
      resolve: resolveDefinitionTargets,
      navigate: (location) => {
        // W9 判据①：载荷一律由 `revealLocationOf` 构造（六条腿同一个出口，列与区间同源）
        requireKernel().bus.emit(
          'editor.revealLocation',
          revealLocationOf(
            { path: location.filePath, line: location.line, column: location.column, span: location.span },
            '转到定义',
          ),
        );
      },
      // NAV-1（2026-10-20）：同文件 F12 / Ctrl+Click / Peek 回车由 Monaco 缺省 handler 就地
      // 跳完（含 symbolHighlight 高亮动画），**这里只发"跳过了"的事实**——与 `navigate`
      // 的"请跳"相反；App 订阅 `editor.navigated` 后只 pushNav，不得再定位（跳两次）。
      recordInPlaceNavigation: (location) => {
        // 载荷仍由 `revealLocationOf` 构造（列/区间同源）；`line` 在这里补成必填——
        // `DefinitionLocation.line` 本来就是必填，事件契约只是不接受"没有行的导航"。
        const payload = revealLocationOf(
          { path: location.filePath, line: location.line, column: location.column, span: location.span },
          '转到定义',
        );
        requireKernel().bus.emit('editor.navigated', { ...payload, line: location.line });
      },
      // D4（Peek 就地预览）两条腿的判据都来自**全部组**的打开表（`openModelAcrossGroups` /
      // 路径，值 = 那份 model），路径比较一律走 `matchOpenedPath` 的 `pathKey` 口径
      // （HK-7：平台原样路径与宿主键在 Windows 上分隔符/大小写不一致，裸字符串比会静默判不上）：
      // - openModelFor：目标文件是否**已经开着**（开着 ⇒ 有 model ⇒ Monaco 能给 Peek 显示）；
      //   项 7 起再叠一层 Peek 租约：没开着的目标也能现取一份隐藏 model 进列表；
      // - pathForUri：Monaco 的跨 model 跳转请求（opener）反回宿主路径，落回同一条
      //   `editor.revealLocation` 通道——不新造第二套导航机制。
      openModelFor: modelForPeekPath,
      pathForUri: pathForPeekUri,
      peekTarget: (path) => peekLeasesOf().peek(path),
    }));
    // 文档大纲（B3）：同一枚 `ui.editor.languageService` 槽的第二个判别成员。宿主照旧只做
    // 协议翻译——"这篇文档有哪些层"全在插件（ERB 给函数与声明、`.kojo` 给时机/段/分支）。
    // 这份树同时是**粘性滚动**的贴顶来源（吸顶显示"当前在哪个函数 / 哪个时机块里"），
    // 所以两面的行号都必须落在**屏幕上这一面**：原文面直通，糖面按 `sugarLineMapRef` 折回预览行。
    globalDisposers.push(installDocumentSymbolProvider(monaco, {
      resolve: (model) => readDocumentSymbols(model, requireKernel()),
    }));
    // 签名帮助（B5 形参槽语义 + R5 跨行 / ERB 形参签名）：唯一真源两层——
    // ① adapter 的调用协议表（槽语义）；② 协议不认识时的 ERB 用户函数形参（解析器索引
    // `erb.parser`，按归一化名查定义取 `params` 原文）。两层都运行时现取（表随项目开闭
    // 重建，缓存会把上一个项目的表带过来）；都缺席 / 都不认 ⇒ 不应答，**不猜**。
    // 跨行：`resolveSignatureInText` 从光标行向上收未闭合括号（窗口封顶），最内层括号
    // 语义与单行同源。糖面把光标位点换成源位点后照常应答（只读呈现，不落一个字节）。
    globalDisposers.push(installSignatureHelp(monaco, {
      resolve: (model, position) => readSignatureHelp(model, position, requireKernel()),
    }));
    // 折叠范围（D3）：同一枚 `ui.editor.languageService` 槽的第三个判别成员。ERB 原文不缩进，
    // Monaco 的缩进折叠在其上几乎无效——注册供给器后 `foldingStrategy: auto` 自动改走这里。
    // 应答判据与大纲逐字同款：折的是**屏幕上这一面**的行号（糖面折回预览行，折不回的区间不给）。
    // PS-4：档位 + 版本记忆化都判在取文之前，落点 = 原文 model（糖面问的就是那一篇），
    // 让"停笔 → Monaco 重问一遍"不再等于"整篇再 copy 再扫一遍"（判据见 `foldingRangesFor`）。
    globalDisposers.push(installFoldingRangeProvider(monaco, {
      resolve: (model) => readFoldingRanges(model, requireKernel()),
    }));

    // 结构化着色（B6，作者面叫「名字按用途着色」）：同一枚 `ui.editor.languageService` 槽的
    // 第六个判别成员。宿主照旧只做协议翻译——"这个名字在这里是定义、形参槽还是引用"
    // 全在插件（ERB 由解析器答、`.kojo` 由表层 DSL 线答），本层一个 ERB / 糖名词都不认识。
    // 应答判据与大纲/折叠逐字同款：糖 model 的行号属派生物，着色它就是把颜色画到
    // 一份不存在的文本上。开关**不在这里判**：Monaco 的 `editor.semanticHighlighting.enabled`
    // 关着时根本不会问 provider（见 `semantic-color-pref.ts`），这里只留大文件那一道降级闸。
    globalDisposers.push(installSemanticTokensProvider(monaco, {
      resolve: (model) => {
        // 着色是**纯显示**职责：跟着"此刻屏幕上那份 model"走，派生糖视图同样要上色。
        // 故这里**不能**用 `owningPaneOf`——它把糖 model 判 null 是为拦 definition/rename/hover
        // 等"导航"作用在派生行号上，误伤到着色 ⇒ .kojo 预览关键词高亮全灭。
        // 糖 model 显示的是 `.kojo` 投影：以 `.kojo` 路径派发，让 kojo 语义腿命中这份文本
        // （`resolveSugarTarget` 只认 `.kojo` 后缀），同时 ERB 语义腿因扩展名不符自然跳过，无冲突。
        let ctx: PaneCtx | null = null;
        let isSugarModel = false;
        for (const c of livePanes.values()) {
          const ed = c.editorRef.current;
          if (!ed || ed.getModel() !== model) continue;
          ctx = c;
          isSugarModel = c.sugarModelRef.current === model;
          break;
        }
        if (!ctx) return [];
        const realPath = ctx.filePathRef.current;
        if (!realPath) return [];
        const path = isSugarModel ? realPath.replace(/\.[A-Za-z0-9]+$/, KOJO_SOURCE_EXTENSION) : realPath;
        const lineCount = model.getLineCount();
        if (!shouldComputeSemanticTokens(lineCount)) return [];
        const kernel = requireKernel();
        return collectSemanticTokenSpans(kernel.slots.query('ui.editor.languageService'), {
          kind: 'semanticToken',
          ...documentRequestFields(model, path, kernel.project.current()),
        });
      },
    }));
    /* G1「跳到命中状态」的位点探针（2026-10-16）。
     *
     * **按下才取**，不挂常驻监听：这条键一秒可能被按一次，而面包屑一次按键要算一次，
     * 两者对"最新光标行"的代价口径完全不同。符号树复用面包屑那份缓存（同一棵
     * documentSymbol 树第二次上岗；缓存判据照旧 = path + model 版本号）。
     *
     * 糖面（换算批 2026-10-19）：探针交出的是**源坐标**——预览行先换成源行、符号树取原文那一棵，
     * `derivedView` 随之为 `false`。面板要的本来就是"存档里那一行"（`locate.filePath/line` 与
     * `functionAt(path, line)` 都按原文索引查），而落点回到编辑器时还会按同一张表把源行换回预览行
     * ⇒ 在探针这里先折成预览行就是折两遍。映射缺席 / 这一行压根没有源行 ⇒ 照旧如实标
     * `derivedView` 且不给符号（不许把作者导到不存在的位置）。
     */
    setJumpProbe(() => {
      const ctx = focusedCtx();
      const ed2 = ctx?.editorRef.current ?? null;
      const path = ctx?.filePathRef.current ?? '';
      const model = ed2?.getModel() ?? null;
      if (!ctx || !ed2 || !path || !model) return null;
      const line = ed2.getPosition()?.lineNumber ?? 1;
      if (ctx.sugarModelRef.current === model) {
        const target = readTargetOf(model);
        const at = target === null ? null : sourcePointOf(target, { lineNumber: line, column: 1 } as Monaco.Position);
        if (!target || at === null) return { path, line, symbols: null, derivedView: true };
        return { path: target.path, line: at.line, symbols: documentSymbolsCached(ctx, target), derivedView: false };
      }
      return {
        path,
        line,
        symbols: documentSymbolsCached(ctx, { model, path, sugar: null }),
        derivedView: false,
      };
    });
    // `.kojo` 补全（C-1 seam）：唯一装配点，候选由 `KOJO_COMPLETION_SOURCES` 可扩展数组提供。
    globalDisposers.push(installKojoCompletion(monaco, () => editorTables(requireKernel())));
    // `.erb` 方言补全（EC-1 seam）：同 `editorTables` 单一数据源；候选由 `ERB_COMPLETION_SOURCES` 提供。
    globalDisposers.push(installErbCompletion(monaco, () => editorTables(requireKernel())));
    // ERB 函数重命名（F2，2026-10-16）：判定与编辑收集全在解析器索引（`erb.parser`），
    // 宿主只注入 monaco 拿不到的东西——活动标签判据（同 codeAction 逐字同款）、写权限
    // （`requireKernel().io.isWritable`，与保存同源口径）、已开标签表、未打开文件的 io 落盘通道。
    // 「查找引用」的 ERB 数据源由下方那条 reference 注册（languageService 槽）承担；
    // 这组 helpers 只喂重命名（ErbReferenceHandlers = 重命名 handlers）。
    const canAnswerErb = (model: Monaco.editor.ITextModel): boolean => {
      const ctx = owningPaneOf(model);
      return !!ctx && !!ctx.filePathRef.current;
    };
    const currentIndexErb = (): ErbIndex | null => erbParserIndex(requireKernel());
    const referencesToErb = (name: string): readonly ErbReference[] | null => {
      try {
        const parser = requireKernel().services.tryGet<ErbParserService>('erb.parser');
        return parser?.referencesTo ? parser.referencesTo(name) : null;
      } catch {
        return null;
      }
    };
    /* ---- W8 XLANG-RENAME 的宿主三条腿（接线债在此收口） ----
     *
     * - `applyToClosedFile`：**只用** `createApplyToClosedFile`（与搜索面板「全部替换」
     *   共用 `rewriteClosedFile` 的同一条纪律：先闸写权限 → 现文本验证 → 零改动不写）。
     *   宿主此前在这里手写了一份 read-modify-write，两份"怎么落盘"必然漂（W8 收口理由），
     *   而且那份没有 `isWritable` 前置闸。`io` 按调用现取（口径与其余 handlers 逐字同款）。
     *   **行为不变式**（W8b 取证）：闭文件已落盘时绝不返回 `rejectReason`——standalone 的
     *   rename 控制器见 `rejectReason` 会丢弃**全部** WorkspaceEdit ⇒ 标签没改、盘上改一半。
     *   这条纪律住在 `erb-rename.provideEdits` 的最后一道（`landedFiles` 计数），本处只搬运。
     * - `kojoSources` / `kojoReferences`：取数在 `ui/kojo-source-scan`（枚举 + 读文 + 问槽，
     *   **零糖语法判读**；失败一律抛 ⇒ `erb-rename` 整批拒绝，绝不只改 `.erb` 半边）。
     */
    const renameClosedFileIo: ClosedFileIo = {
      isWritable: (path) => requireKernel().io.isWritable(path),
      readText: (path) => requireKernel().io.readText(path),
      writeText: (path, text) => requireKernel().io.writeText(path, text),
    };
    globalDisposers.push(installErbRename(monaco, {
      canAnswer: canAnswerErb,
      currentIndex: currentIndexErb,
      referencesTo: referencesToErb,
      isWritable: (path) => requireKernel().io.isWritable(path),
      openModelFor: openModelAcrossGroups,
      applyToClosedFile: createApplyToClosedFile(renameClosedFileIo),
      kojoSources: () => listKojoSourceTexts(requireKernel()),
      // 槽表**一次取**：同一次改名里两次 query 可能拿到不同的注册表（项目开闭 / 插件退场），
      // 那会让"判读"与"枚举"面对的不是同一套供方
      kojoReferences: (probe) => {
        const kernel = requireKernel();
        return kojoReferencesViaSlot(kernel.slots.query('ui.editor.languageService'), kernel, probe);
      },
    }));
    // 查找所有引用（R2，2026-10-16）：同一枚 `ui.editor.languageService` 槽的第七个判别
    // 成员。宿主只做协议翻译——认活动标签的真 model（与转到定义逐字同判据）、问槽、
    // 把"未打开文件"那条腿的点击落回 `editor.revealLocation`（与转到定义同通道）。
    // 引用什么算、谁在索引外，全在贡献方（ERB 由解析器答、`.kojo` 由糖线答）。
    // 读类换算批（2026-10-20）：糖面不再是整条静默——位点换算到原文问一次，交回的**引用列表
    // 留在源坐标**（面板列的就是源位置，落点侧 `applyReveal` 按同一张表折回预览行，折两遍就跳
    // 到隔壁）。写类那三条闸（改名 / quickfix / 格式化）一字未动。
    // 引用腿的"读数是谁家的"随 `resolve` 记录（Monaco 的 provideReferences 同步问一次、
    // 同步出一读数 ⇒ 这一变量就是那一次请求的路径，不另开第二条通道）
    let tallySourcePath = '';
    globalDisposers.push(installReferenceProvider(monaco, {
      resolve: (model, position) => {
        const read = readReferences(model, position, requireKernel());
        if (read === null) return [];
        tallySourcePath = read.path;
        return read.locations;
      },
      navigate: (location) => {
        // W9 判据①：与转到定义同一个载荷出口
        requireKernel().bus.emit(
          'editor.revealLocation',
          revealLocationOf(
            { path: location.filePath, line: location.line, column: location.column, span: location.span },
            '查找引用',
          ),
        );
      },
      openModelFor: openModelAcrossGroups,
      // W8 台账读数：F12 的"N 处"与「被调用」面板的入边读数同源（面板读 tally.nonDefinitionCount）。
      // 这里只**搬运**，一次都不重数——重数就是 W8 要收口的第二判据。
      onTally: (tally, explanation) => {
        setReferenceTally({ tally, explanation, path: tallySourcePath });
      },
    }));
    // 跳到实现（R3 残项，2026-10-16；W9 收口）：数据源与转到定义**同一个 `kind: 'definition'`
    // 的取数腿**（上方 `resolveDefinitionTargets`，只问 `ui.editor.languageService` 槽）。
    // 引擎系统函数不在任何供方的索引里 ⇒ 给不出定义位 = 不应答 = 真话"没有实现"。
    // 三条腿（同 model 就地跳 / 已开标签 Peek / 未开文件事件通道）整个复用
    // `planDefinitionJump` / `toDefinitionLinks` / `clampRevealPosition`——宿主一行取数都不做，
    // `canAnswer` / `currentIndex` 随旧的 byName 直读一起删（那是第二份计算）。
    globalDisposers.push(installImplementationProvider(monaco, {
      resolve: resolveDefinitionTargets,
      navigate: (location) => {
        // W9 判据①：与转到定义同一个载荷出口
        requireKernel().bus.emit(
          'editor.revealLocation',
          revealLocationOf(
            { path: location.filePath, line: location.line, column: location.column, span: location.span },
            '跳到实现',
          ),
        );
      },
      openModelFor: modelForPeekPath,
      pathForUri: pathForPeekUri,
      peekTarget: (path) => peekLeasesOf().peek(path),
    }));
    // `.kojo` 用户函数改名（R1，2026-10-16）：同一枚槽的第八个判别成员。ERB 方言不归它
    // 管（全项目改名走上面那条 ERB 改名注册的专用通道）；`.kojo` 的判定（可证明引用面
    // + 整卷复核）全在糖线，宿主只做 Monaco 协议翻译与落地前的现文本验证（模块头注）。
    globalDisposers.push(installKojoRename(monaco, {
      canAnswer: (model) => {
        const ctx = owningPaneOf(model);
        return !!ctx && !!ctx.filePathRef.current;
      },
      resolve: (model, position, newName) => {
        const ctx = owningPaneOf(model);
        if (!ctx || !ctx.filePathRef.current) {
          return { edits: [], rejectReason: '当前视图不参与重命名（请在原文视图内按 F2）' };
        }
        const path = ctx.filePathRef.current;
        const kernel = requireKernel();
        for (const contribution of kernel.slots.query('ui.editor.languageService')) {
          let result: ReturnType<typeof contribution.provide>;
          try {
            result = contribution.provide({
              kind: 'rename',
              ...documentRequestFields(model, path, kernel.project.current()),
              line: position.lineNumber,
              column: position.column,
              newName,
            });
          } catch (e: unknown) {
            console.warn(
              `[kojo-rename] '${contribution.id}' provide 抛错：${errorText(e)}`,
            );
            continue;
          }
          if (result && result.kind === 'rename') {
            return { edits: result.edits, ...(result.oldName !== undefined ? { oldName: result.oldName } : {}), ...(result.rejectReason !== undefined ? { rejectReason: result.rejectReason } : {}) };
          }
        }
        return { edits: [], rejectReason: '「.kojo」改名只认本文件「函数」块声明的名字（语言服务未应答这处请求）' };
      },
    }));
    // 文档格式化（E1，`Shift+Alt+F`）：规则全在插件（`computeFormatEdits` 纯函数），宿主只做
    // 协议翻译。应答判据与 codeAction / 转到定义逐字同款：只认**当前活动标签的真 model**——
    // 糖视图挂着只读派生 model，格式化它改的不是真文件，所以一律不应答。
    const formatResolve: RangeFormatHandlers = {
      resolve: (model) => {
        const path = owningPanePathOf(model);
        if (path === null) return null;
        const dialect = dialectForLanguage(model.getLanguageId());
        if (dialect === null) return null;
        // P2-14：规则开关**组请求时现读**（与保存链路"落盘前现读一次偏好"同一纪律，
        // 不存闭包旧值）；`undefined`（缺省全开）与今天逐字等价。窗口腿
        // （`resolveRange` → `formatRequestWindowFor`）不带规则——区间/打字规范化
        // 本批保持全开口径（见 kojo-format.ts 头注），这是**明说的边界**不是漏接。
        return { text: model.getValue(), dialect, rules: loadFormatRulesPref() };
      },
      resolveRange: (model, startLine, endLine) => formatRequestWindowFor(model, startLine, endLine),
    };
    globalDisposers.push(installDocumentFormatter(monaco, formatResolve));
    // 选区格式化 + 打字规范化（T13）：同一份 resolve、同一份规则核心，只多一层行裁剪（ERB 语言）。
    // PS-4：再挂一条**窗口取文腿**（`formatRequestWindowFor`）——一次 `;` 击键只为触发行那一行
    // 取文，不再 copy 整篇；`.kojo` 与糖视图一律退回整篇那条腿（判据见 `RangeFormatHandlers`）。
    // FMT-TOAST：五处让路点从此**不再哑**——`onDegraded` 接台账（同一 `where` + 同一行区间
    // 一次会话只上一条 toast）。台账只读这份 `notice`，格式化那条链的返回值语义一字未动。
    globalDisposers.push(installRangeFormatter(monaco, { ...formatResolve, onDegraded: reportFormatDegradation }));
    // 行上内联注解（B8，2026-10-16）：同一枚 `ui.editor.languageService` 槽的第五个判别成员。
    // 宿主在这里做的事只有四件：定位取数的那份 model（糖面换算到原文，见 `readCodeLenses`）、
    // 把体量/预算两档降级判掉、问槽、把点击落到**既有**的 `editor.revealLocation` 通道
    //（不新造第二套跳转，与转到定义同腿）。
    // 注解说什么（"被 N 处用到"、何时不说、大数为什么说 `1000+`）全在贡献方，宿主零判定——
    // 分工与取舍见 `monaco/kojo-code-lens.ts` 与 `plugins/erb-parser/src/usage-lens.ts` 头注。
    //
    // **开关不在这儿**：那是 Monaco 的 `codeLens` 编辑器选项，由下面那条独立的偏好 effect
    // 落地（关掉时 Monaco 根本不发请求，省掉一次整篇解析）。
    globalDisposers.push(installCodeLensProvider(monaco, {
      resolve: (model) => readCodeLenses(model, requireKernel()),
      navigate: (target) => {
        // W9 判据①：注解的落点区间原样穿过命令参数到达这里，载荷仍由同一个出口构造
        requireKernel().bus.emit(
          'editor.revealLocation',
          revealLocationOf(
            { path: target.filePath, line: target.line, column: target.column, span: target.span },
            '行上注解',
          ),
        );
      },
    }));
    // 行内提示（LS-R6，2026-10-16）：同一枚 `ui.editor.languageService` 槽的第七个判别成员。
    // 应答判据与 codeLens 逐字同款：取数落在原文 model 上，糖面把提示行折回预览行、列落到行首
    //（见 `readInlayHints`），体量档 `inlayHintsAffordable` 判在请求之前（52,602 行实测
    // 50ms/次，档线与 stickyScroll / 面包屑 / codeLens 同一条）。提示说什么（实参落
    // 哪个形参槽）全在 erb-parser（`erb-inlay-hints`），宿主零判据——取舍见
    // `monaco/kojo-inlay-hints.ts` 与 `plugins/erb-parser/src/inlay-hints.ts` 头注。
    // PS-4：这条腿按版本记忆化（Monaco **每次滚动**都重新问，缺省防抖低到 25ms），
    // 交回时只给 Monaco 点名的那一段区间（见 `toMonacoInlayHints` 的 `range`）。
    globalDisposers.push(installInlayHintsProvider(monaco, {
      resolve: (model) => readInlayHints(model, requireKernel()),
    }));
  } catch (e: unknown) {
    // 全有或全无：拆掉**已登记的**每一枚（未登记 = 根本没建起来）、清空登记表、复位 flag，
    // 让下一个实例挂载时重新注册；错误照旧外抛，不在宿主这里吞掉（AGENTS.md 铁律 4）。
    teardownGlobalProviders('注册半途失败');
    throw e;
  }
}

/**
 * 拆毁全局注册表：**逐枚** `try/catch`（缺陷 3）——一枚 `dispose()` 抛错不许带走其余的，
 * 且清空登记表与复位 `globalsInstalled` **无条件**执行（`finally` 语义）。
 * 少了这道闸，一次抛错就会留下"半套旧注册 + flag 已置位"：下次挂载直接 return，
 * provider 表里从此是残缺的一套，而且再也补不回来。
 *
 * 两种调用场景同一条纪律：最后一个实例退场（`disposeGlobalProviders`）与
 * 注册半途失败的回滚（`ensureGlobalProviders` 的 catch）。`reason` 只进日志，不参与判定。
 */
function teardownGlobalProviders(reason: string): void {
  try {
    for (const d of globalDisposers) {
      try {
        d.dispose();
      } catch (e: unknown) {
        console.warn(
          `[editor-providers] ${reason}：一枚 disposable dispose 抛错（其余照常拆）：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } finally {
    globalDisposers.length = 0;
    globalsInstalled = false;
    lastWordsKey = '__unset__';
    // PS-4：四条腿的记忆化换新的（弱表没有 clear；换一张就是把上一整套全丢掉）。
    // 记忆化的键已经带项目引用，但"整套注册被拆毁"意味着下一个 kernel 可能接替，
    // 这里把"绝不把上一个项目的解析结果带过去"做成机制而不是指望键够聪明。
    foldingMemo = new WeakMap();
    inlayHintsMemo = new WeakMap();
    codeLensesMemo = new WeakMap();
    codeActionsMemo = new WeakMap();
    // 糖面的「源行 → 预览行」快表同理换新：键是投影装配出来的那张数组，留着也不脏
    //（投影换一次就换一张新表 ⇒ 身份变了必然重建），但整套注册拆毁时一并清账最省事也最好读
    previewRowTables = new WeakMap();
    degradedSeams = new Set();
    // 折叠封顶的可见态同理整套换掉：上一套注册留下的"截了尾巴"那句不许挂到下一个 kernel 的文件上
    foldingCaps = new Map();
    // P2-14：待确认的修复预览同理——上一套注册的悬账不许活到下一个 kernel
    //（overlay 已随上一套壳层 effect 退场，条目无处可认领，留着只会误导）
    resetQuickFixPreviews();
    // 项 7：Peek 租约同理整套清账（池的引用计数是 app 级单例的账，不随换项目自己清零）
    peekLeases?.disposeAll();
    peekLeases = null;
  }
}

export function disposeGlobalProviders(): void {
  teardownGlobalProviders('最后一个实例退场');
}

/**
 * 重新挂上 Monarch directive 词表（T5）：`.erb` 语言的 directive 词表 = 基底 `ERB_DIRECTIVES`
 * ∪ 当前项目 adapter 的 `instructionTable.names()`（合并去重排序见 `mergeDirectiveWords` 纯函数）；
 * 表缺席 ⇒ 基底。**项目切换不残留上一项目的词表**：`project.closed` / 卸载一律回基底（与 hover
 * 的"表随项目现取"同一纪律）；重设时 dispose 旧 provider（`setErbDirectiveWords` 内置）。
 *
 * 词表是**模块级资源**（provider 全局一份），故计数与去重键都住在本模块，由 EditorPane 的实例
 * effect 成对调用 `acquireDirectiveWords` / `releaseDirectiveWords`；等值去重挡掉重复重建
 * （双实例时事件触发的第二次 apply 就是被这一道挡掉的）。
 */
export function applyDirectiveWords(kernel: Kernel): void {
  const names = editorTables(kernel).instructionTable?.names?.() ?? null;
  const key = names ? names.join('\u0000') : '';
  if (key === lastWordsKey) return;
  lastWordsKey = key;
  setErbDirectiveWords(monaco, names === null ? null : mergeDirectiveWords(ERB_DIRECTIVES, names));
}

/** 一个实例开始使用 Monarch 词表（与 `releaseDirectiveWords` 成对，挂在组件 effect 上） */
export function acquireDirectiveWords(): void {
  erbWordsUsers += 1;
}

/** 实例退场：最后一个用户离开才把词表回基底（与 `disposeGlobalProviders` 的复位同源） */
export function releaseDirectiveWords(): void {
  erbWordsUsers -= 1;
  if (erbWordsUsers === 0) {
    setErbDirectiveWords(monaco, null);
    lastWordsKey = '__unset__';
  }
}
