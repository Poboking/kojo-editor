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
import { errorText } from '@kojo/plugin-api';
import type {
  EditorDocumentSymbol,
  EditorTextEdit,
  ErbIndex,
  ErbParserService,
  ErbReference,
  GameAdapter,
} from '@kojo/plugin-api';
import * as monaco from '../monaco/entry';
import { makeLookup } from '@kojo/plugin-kojo-sugar';
import { ERB_DIRECTIVES, ERB_LANGUAGE_ID, mergeDirectiveWords, setErbDirectiveWords } from '../monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../monaco/kojo-language';
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
import {
  collectInlayHints,
  inlayHintsAffordable,
  installInlayHintsProvider,
} from '../monaco/kojo-inlay-hints';
import { revealLocationOf } from '../monaco/reveal-position';
import { dialectForLanguage, installDocumentFormatter, type FormatHandlers } from '../monaco/kojo-format';
import { installRangeFormatter } from '../monaco/kojo-format-range';
// W8 XLANG-RENAME 的宿主侧：闭文件落盘的唯一通道（`ClosedFileIo`）与跨语言腿的取数
// （枚举 + 读文 + 问槽，判读零宿主知识；根口径与检索面板同源）
import { type ClosedFileIo } from './reference-utils';
import { kojoReferencesViaSlot, listKojoSourceTexts } from './kojo-source-scan';
import { setReferenceTally } from './reference-tally-store';
import { collectDocumentSymbols, installDocumentSymbolProvider } from '../monaco/kojo-symbols';
import { setJumpProbe } from './jump-to-state';
import { collectFoldingRanges, installFoldingRangeProvider } from '../monaco/kojo-folding';
import {
  collectSemanticTokenSpans,
  installSemanticTokensProvider,
  shouldComputeSemanticTokens,
} from '../monaco/kojo-semantic-tokens';
import {
  type SignatureTables,
  installSignatureHelp,
  resolveSignatureInText,
} from '../monaco/kojo-signature';
import { type CompletionTables, installKojoCompletion } from '../monaco/kojo-completion';
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
  type PaneCtx,
} from './editor-pane-registry';

/** CodeAction 执行命令 id（宿主统一注册一次；command 参数为 pendingActionsRef 的反查 key） */
const CODE_ACTION_COMMAND = 'kojo.codeAction.run';

/**
 * `erb.parser` 的**软取**索引（唯一一份）：解析器缺席 / 索引在途一律给 `null`——
 * `tryGet` 与 `currentIndex` 两步都包在 try 里，调用方据此让**那一路无结果**
 * （退化可见），绝不把抛错送进悬停 / 补全 / 重命名 / 签名任何一条 seam。
 * 索引**每次现取**，不缓存（索引随项目开闭重建，缓存会把上一个项目的索引带过来）。
 */
function erbParserIndex(kernel: Kernel): ErbIndex | null {
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
 * 与项目开闭**无关**、但取数依赖项目态的两条软腿：函数名补全（`erb.parser` 索引派生）与
 * 悬停用的当前索引通道。两者都在**求值时**软取（`services.tryGet` + try/catch），索引未建 ⇒
 * 该路零候选 / 零结果（退化可见），绝不抛进 seam；每次现取，不缓存上一个项目的脏索引。
 */
function projectSoftLegs(kernel: Kernel): Pick<CompletionTables, 'erbFunctionNames'> & HoverTables {
  return {
    erbFunctionNames: erbFunctionNamesFor(kernel),
    erbIndex: () => {
      try {
        return kernel.services.tryGet<ErbParserService>('erb.parser')?.currentIndex() ?? null;
      } catch {
        return null;
      }
    },
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
 * 每条能力腿共用的**开口**：由 model 反查归属实例，再读它的真路径。
 * 返回 `null` = 这份 model 不挂在任何活动标签上，或那个标签还没有路径
 * （糖视图挂的是只读派生 model，行号属于派生物 ⇒ 一律不应答，与 codeAction 同判据）。
 *
 * **兜底值留在各调用点**：各能力"不应答"的形状本来就不一样（`[]` / `null` /
 * `{ hints: [] … }` / `{ actions: [] … }`），把它们折成一个是行为改动，不是去重。
 */
function owningPanePathOf(model: Monaco.editor.ITextModel): string | null {
  const ctx = owningPaneOf(model);
  if (!ctx) return null;
  return ctx.filePathRef.current || null;
}

let globalsInstalled = false;
const globalDisposers: Monaco.IDisposable[] = [];
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
      //（两者语义不同，见 `EditorTextEdit` 契约；💡「改为语法糖写法」走这条）。
      // 糖视图下 `ed.getModel()` 是只读糖 model：编辑无处可落（applyTextEdits 会改到派生物
      // 而非原文），直接跳过，避免"改了却不在真文件里"。
      if (action.edits && action.edits.length > 0 && ed && !ctx?.sugarModelRef.current && ed.getModel()) {
        if (applyTextEdits(ed, action.edits)) return;
      }
      const line = ed?.getPosition()?.lineNumber;
      void action.run({
        project: requireKernel().project.current(),
        activeFile: ctx?.filePathRef.current,
        ...(line !== undefined ? { line } : {}),
      });
    }));
    globalDisposers.push(monaco.languages.registerCodeActionProvider(
      [ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID],
      {
        provideCodeActions: (model, range, context) => {
          const ctx = owningPaneOf(model);
          // 只对当前活动标签的 model 供动作（后台 model 的 provider 调用不响应）；
          // 糖视图下挂的是只读糖 model，不供任何 CodeAction（编辑落点无真文件可依）。
          if (!ctx || !ctx.filePathRef.current) {
            return { actions: [], dispose: () => undefined };
          }
          const path = ctx.filePathRef.current;
          const pending = ctx.pendingActionsRef.current;
          // 超阈值整体清理（长期运行不至于无限增长）；id 单调递增，绝不复用
          if (pending.size > 500) pending.clear();
          const actions = collectCodeActions(
            requireKernel().slots.query('ui.editor.codeAction'),
            {
              path,
              text: model.getValue(),
              project: requireKernel().project.current(),
              lineCount: model.getLineCount(),
              ...(range?.startLineNumber !== undefined ? { line: range.startLineNumber } : {}),
              // 本次请求对应的**当前波浪线**（B9）：Monaco 的 standalone 包装层已按
              // 区间求交填好 `context.markers` ⇒ 贡献方按 `code` 精确应答，
              // 零 marker = 这个区间本来就没红线 ⇒ 不该有 quickfix
              diagnostics: markersToDecorations(monaco, context.markers ?? []),
            },
            {
              register: (contributionId, action) => {
                const actionId = `${ctx.paneId}:${contributionId}#${++ctx.actionSeqRef.current}`;
                pending.set(actionId, action);
                return actionId;
              },
              markerDataFor: (action) => actionDiagnostics(monaco, model, action),
            },
            CODE_ACTION_COMMAND,
          );
          return { actions, dispose: () => undefined };
        },
      },
      // B9：类别声明走 metadata（Monaco 用它决定 `Ctrl+.` 这条 only=quickfix 的
      // 显式请求要不要调用本 provider，并写进 `supportedCodeActions` 上下文键）
      { providedCodeActionKinds: PROVIDED_CODE_ACTION_KINDS },
    ));
    // 悬停中文名（ZH-F2）：只读显示，光标下的原生记号 → 中文名。表按当前项目 adapterId
    // **运行时**现取（`editorTables`），查不到即不显示（**不猜**）。与 CodeAction 同款隔离。
    globalDisposers.push(installHover(monaco, () => editorTables(requireKernel())));
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
    ): DefinitionLocation[] => {
      // 与 codeAction 同一判据（见上方 provideCodeActions）：只应答当前活动标签的真 model。
      // 糖视图下 `ed.getModel()` 是只读糖 model——它的行号对应糖文本，拿它去问 ERB 行号
      // 会得到"派生物里的位置"，所以一律不供，避免把作者跳到错行。
      const path = owningPanePathOf(model);
      if (path === null) return [];
      return collectDefinitionLocations(requireKernel().slots.query('ui.editor.languageService'), {
        kind: 'definition',
        path,
        text: model.getValue(),
        line: position.lineNumber,
        column: position.column,
        project: requireKernel().project.current(),
        lineCount: model.getLineCount(),
      });
    };
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
      // D4（Peek 就地预览）两条腿的判据都来自**全部组**的打开表（`openModelAcrossGroups` /
      // 路径，值 = 那份 model），路径比较一律走 `matchOpenedPath` 的 `pathKey` 口径
      // （HK-7：平台原样路径与宿主键在 Windows 上分隔符/大小写不一致，裸字符串比会静默判不上）：
      // - openModelFor：目标文件是否**已经开着**（开着 ⇒ 有 model ⇒ Monaco 能给 Peek 显示）；
      // - pathForUri：Monaco 的跨 model 跳转请求（opener）反回宿主路径，落回同一条
      //   `editor.revealLocation` 通道——不新造第二套导航机制。
      openModelFor: openModelAcrossGroups,
      pathForUri: pathForUriAcrossGroups,
    }));
    // 文档大纲（B3）：同一枚 `ui.editor.languageService` 槽的第二个判别成员。宿主照旧只做
    // 协议翻译——"这篇文档有哪些层"全在插件（ERB 给函数与声明、`.kojo` 给时机/段/分支）。
    // 这份树同时是**粘性滚动**的贴顶来源（吸顶显示"当前在哪个函数 / 哪个时机块里"），
    // 所以它必须在糖视图之外只认真 model：糖 model 的行号属于派生物，贴出来是错的层次。
    globalDisposers.push(installDocumentSymbolProvider(monaco, {
      resolve: (model) => {
        const path = owningPanePathOf(model);
        if (path === null) return [];
        return collectDocumentSymbols(requireKernel().slots.query('ui.editor.languageService'), {
          kind: 'documentSymbol',
          path,
          text: model.getValue(),
          project: requireKernel().project.current(),
          lineCount: model.getLineCount(),
        });
      },
    }));
    // 签名帮助（B5 形参槽语义 + R5 跨行 / ERB 形参签名）：唯一真源两层——
    // ① adapter 的调用协议表（槽语义）；② 协议不认识时的 ERB 用户函数形参（解析器索引
    // `erb.parser`，按归一化名查定义取 `params` 原文）。两层都运行时现取（表随项目开闭
    // 重建，缓存会把上一个项目的表带过来）；都缺席 / 都不认 ⇒ 不应答，**不猜**。
    // 跨行：`resolveSignatureInText` 从光标行向上收未闭合括号（窗口封顶），最内层括号
    // 语义与单行同源。糖视图挂的是只读派生 model，它的行列不属于原文 ⇒ 与 codeAction /
    // 转到定义同判据一律不应答。
    globalDisposers.push(installSignatureHelp(monaco, {
      resolve: (model, position) => {
        const path = owningPanePathOf(model);
        if (path === null) return null;
        const protocol = editorTables(requireKernel()).callProtocol;
        return resolveSignatureInText(model.getValue(), position.lineNumber, position.column, protocol, (callee) => {
          try {
            const index = erbParserIndex(requireKernel());
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
      },
    }));
    // 折叠范围（D3）：同一枚 `ui.editor.languageService` 槽的第三个判别成员。ERB 原文不缩进，
    // Monaco 的缩进折叠在其上几乎无效——注册供给器后 `foldingStrategy: auto` 自动改走这里。
    // 应答判据与大纲逐字同款：糖 model 的行号属于派生物，折叠它会把作者折进不存在的位置。
    globalDisposers.push(installFoldingRangeProvider(monaco, {
      resolve: (model) => {
        const path = owningPanePathOf(model);
        if (path === null) return [];
        return collectFoldingRanges(requireKernel().slots.query('ui.editor.languageService'), {
          kind: 'foldingRange',
          path,
          text: model.getValue(),
          project: requireKernel().project.current(),
          lineCount: model.getLineCount(),
        });
      },
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
        const path = isSugarModel ? realPath.replace(/\.[A-Za-z0-9]+$/, '.kojo') : realPath;
        const lineCount = model.getLineCount();
        if (!shouldComputeSemanticTokens(lineCount)) return [];
        return collectSemanticTokenSpans(requireKernel().slots.query('ui.editor.languageService'), {
          kind: 'semanticToken',
          path,
          text: model.getValue(),
          project: requireKernel().project.current(),
          lineCount,
        });
      },
    }));
    /* G1「跳到命中状态」的位点探针（2026-10-16）。
     *
     * **按下才取**，不挂常驻监听：这条键一秒可能被按一次，而面包屑一次按键要算一次，
     * 两者对"最新光标行"的代价口径完全不同。符号树复用面包屑那份缓存（同一棵
     * documentSymbol 树第二次上岗；缓存判据照旧 = path + model 版本号）。
     * 派生视图（`.kojo` 糖视图挂的是只读 model）行号不属于这份文件本身，
     * 一律如实标 `derivedView` 并**不给符号**——不许把作者导到不存在的位置。
     */
    setJumpProbe(() => {
      const ctx = focusedCtx();
      const ed2 = ctx?.editorRef.current ?? null;
      const path = ctx?.filePathRef.current ?? '';
      const model = ed2?.getModel() ?? null;
      if (!ctx || !ed2 || !path || !model) return null;
      const line = ed2.getPosition()?.lineNumber ?? 1;
      if (ctx.sugarModelRef.current) return { path, line, symbols: null, derivedView: true };
      const versionId = model.getAlternativeVersionId();
      const cache = ctx.crumbTreeCacheRef.current;
      let symbols: EditorDocumentSymbol[];
      if (cache && cache.path === path && cache.versionId === versionId) symbols = cache.symbols;
      else {
        symbols = collectDocumentSymbols(requireKernel().slots.query('ui.editor.languageService'), {
          kind: 'documentSymbol',
          path,
          text: model.getValue(),
          project: requireKernel().project.current(),
          lineCount: model.getLineCount(),
        });
        ctx.crumbTreeCacheRef.current = { path, versionId, symbols };
      }
      return { path, line, symbols, derivedView: false };
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
    // 引用腿的"读数是谁家的"随 `resolve` 记录（Monaco 的 provideReferences 同步问一次、
    // 同步出一读数 ⇒ 这一变量就是那一次请求的路径，不另开第二条通道）
    let tallySourcePath = '';
    globalDisposers.push(installReferenceProvider(monaco, {
      resolve: (model, position) => {
        const path = owningPanePathOf(model);
        if (path === null) return [];
        tallySourcePath = path;
        return collectReferenceLocations(requireKernel().slots.query('ui.editor.languageService'), {
          kind: 'references',
          path,
          text: model.getValue(),
          line: position.lineNumber,
          column: position.column,
          project: requireKernel().project.current(),
          lineCount: model.getLineCount(),
        });
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
      openModelFor: openModelAcrossGroups,
      pathForUri: pathForUriAcrossGroups,
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
        for (const contribution of requireKernel().slots.query('ui.editor.languageService')) {
          let result: ReturnType<typeof contribution.provide>;
          try {
            result = contribution.provide({
              kind: 'rename',
              path,
              text: model.getValue(),
              line: position.lineNumber,
              column: position.column,
              newName,
              project: requireKernel().project.current(),
              lineCount: model.getLineCount(),
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
    const formatResolve: FormatHandlers = {
      resolve: (model) => {
        const path = owningPanePathOf(model);
        if (path === null) return null;
        const dialect = dialectForLanguage(model.getLanguageId());
        return dialect === null ? null : { text: model.getValue(), dialect };
      },
    };
    globalDisposers.push(installDocumentFormatter(monaco, formatResolve));
    // 选区格式化 + 打字规范化（T13）：同一份 resolve、同一份规则核心，只多一层行裁剪（ERB 语言）
    globalDisposers.push(installRangeFormatter(monaco, formatResolve));
    // 行上内联注解（B8，2026-10-16）：同一枚 `ui.editor.languageService` 槽的第五个判别成员。
    // 宿主在这里做的事只有四件：认活动标签的**真** model、把体量/预算两档降级判掉、问槽、
    // 把点击落到**既有**的 `editor.revealLocation` 通道（不新造第二套跳转，与转到定义同腿）。
    // 注解说什么（"被 N 处用到"、何时不说、大数为什么说 `1000+`）全在贡献方，宿主零判定——
    // 分工与取舍见 `monaco/kojo-code-lens.ts` 与 `plugins/erb-parser/src/usage-lens.ts` 头注。
    //
    // **开关不在这儿**：那是 Monaco 的 `codeLens` 编辑器选项，由下面那条独立的偏好 effect
    // 落地（关掉时 Monaco 根本不发请求，省掉一次整篇解析）。
    globalDisposers.push(installCodeLensProvider(monaco, {
      resolve: (model) => {
        const path = owningPanePathOf(model);
        if (path === null) return [];
        const lineCount = model.getLineCount();
        // 大文件档：先于请求判掉（一次开口就是整篇文档的解析，实测读数见宿主模块头注）
        if (!codeLensAffordable(lineCount)) return [];
        const lenses = collectCodeLenses(requireKernel().slots.query('ui.editor.languageService'), {
          kind: 'codeLens',
          path,
          text: model.getValue(),
          project: requireKernel().project.current(),
          lineCount,
        });
        // 产出预算：**全有或全无**（缺席携带语义，不许用来表示"额度用完了"）
        return withinCodeLensBudget(lenses.length, lineCount) ? lenses : [];
      },
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
    // 应答判据与 codeLens 逐字同款：只认活动标签的真 model（糖视图挂的是只读派生 model，
    // 它的行列不属于原文），体量档 `inlayHintsAffordable` 判在请求之前（52,602 行实测
    // 50ms/次，档线与 stickyScroll / 面包屑 / codeLens 同一条）。提示说什么（实参落
    // 哪个形参槽）全在 erb-parser（`erb-inlay-hints`），宿主零判据——取舍见
    // `monaco/kojo-inlay-hints.ts` 与 `plugins/erb-parser/src/inlay-hints.ts` 头注。
    globalDisposers.push(installInlayHintsProvider(monaco, {
      resolve: (model) => {
        const path = owningPanePathOf(model);
        if (path === null) return [];
        const lineCount = model.getLineCount();
        if (!inlayHintsAffordable(lineCount)) return [];
        return collectInlayHints(requireKernel().slots.query('ui.editor.languageService'), {
          kind: 'inlayHint',
          path,
          text: model.getValue(),
          project: requireKernel().project.current(),
          lineCount,
        });
      },
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
