import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type * as Monaco from '../monaco/entry';
import type { Kernel } from '@kojo/kernel';
import type {
  EditorCodeAction,
  EditorDocumentSymbol,
  EditorSaveChoices,
  EditorSaveHandlerContribution,
  EditorSaveWarning,
  EditorTextEdit,
  ErbIndex,
  ErbParserService,
  ErbReference,
} from '@kojo/plugin-api';
import { FULLWIDTH_SPACE, WriteNotAllowedError } from '@kojo/plugin-api';
// monaco-editor 0.57 的 exports 映射：'monaco-editor/*' → './esm/vs/*.js'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import * as monaco from '../monaco/entry';
import { makeLookup } from '@kojo/plugin-kojo-sugar';
import { ERB_DIRECTIVES, ERB_LANGUAGE_ID, mergeDirectiveWords, registerErbLanguage, setErbDirectiveWords } from '../monaco/erb-language';
import { KOJO_LANGUAGE_ID, decorationsToMarkers, registerKojoLanguage } from '../monaco/kojo-language';
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
import { CODE_LENS_DEFAULT, loadCodeLensPref } from './code-lens-pref';
import { collectDefinitionLocations, installDefinitionProvider } from '../monaco/kojo-definition';
import {
  collectInlayHints,
  inlayHintsAffordable,
  installInlayHintsProvider,
} from '../monaco/kojo-inlay-hints';
import { fixAllSummary, runFixAll } from '../monaco/kojo-fix-all';
import { clampRevealPosition, type RevealTarget } from '../monaco/reveal-position';
import { dialectForLanguage, installDocumentFormatter, toTextEdits, type FormatHandlers } from '../monaco/kojo-format';
import { installRangeFormatter } from '../monaco/kojo-format-range';
import { applyFormatOnSave } from './format-on-save';
import { classifySaveRace } from './save-race';
import { selectionStatusText } from './selection-status';
import {
  createPathMutex,
  runSaveBatch,
  withPathLock,
  type SaveFileOutcome,
} from './save-coordinator';
import { loadFormatOnSavePref } from './format-pref';
import { applyNameColorPref, subscribeNameColorPref } from './semantic-color-pref';
import {
  applyFontSizePref,
  applyFontZoomPref,
  loadFontSizePref,
  setFontZoomPref,
  subscribeFontSizePref,
} from './font-size-pref';
import { collectDocumentSymbols, installDocumentSymbolProvider } from '../monaco/kojo-symbols';
import { setJumpProbe } from './jump-to-state';
import { dropRecoveredContent, peekRecoveredContent } from './recovery-store';
import { collectFoldingRanges, installFoldingRangeProvider } from '../monaco/kojo-folding';
import {
  collectSemanticTokenSpans,
  installSemanticTokensProvider,
  shouldComputeSemanticTokens,
} from '../monaco/kojo-semantic-tokens';
import {
  crumbsKey,
  crumbsNeedRefresh,
  symbolChainAt,
  toCrumbs,
  type CrumbCursor,
  type CrumbItem,
} from './breadcrumb-path';
import {
  type SignatureTables,
  installSignatureHelp,
  resolveSignatureInText,
} from '../monaco/kojo-signature';
import { type CompletionTables, installKojoCompletion } from '../monaco/kojo-completion';
import { installErbCompletion, memoizedErbFunctionNames, type ErbCompletionTables } from '../monaco/erb-completion';
import { applyReferenceEdits, installErbRename } from '../monaco/erb-rename';
import { collectReferenceLocations, installReferenceProvider } from '../monaco/find-references';
import { installKojoRename } from '../monaco/kojo-rename';
import { installImplementationProvider } from '../monaco/erb-implementation';
import { useNotify } from './NotificationCenter';
import { SaveWarningDialog } from './SaveWarningDialog';
import { CJK_TYPING_BASELINE, FIND_BASELINE, editorOptionsForLineCount } from './editor-options';
import { AUTOSAVE_IDLE_MS, decideAutosave, loadAutosavePref } from './autosave-pref';
import { ErbReadonlyAskDialog, ErbUnlockDialog, SugarViewIntroDialog } from './SugarViewDialogs';
import { decideExternalChange, matchOpenedPath } from './external-change';
import { createDocumentBroadcaster } from './document-broadcast';
import {
  clampSlice,
  extractViewSlice,
  flushViewStates,
  getViewState,
  setViewState,
} from './view-state-store';
import { clampRange, erbReadOnlyGate, isErbLike } from './lift-preview';
import { pathLabelParts, splitPath } from './path-label';
import { Icon } from './icons';
import { perf } from '../perf';
import {
  composeSugarDoc,
  loadSugarViewPref,
  loadSugarViewPrompted,
  saveSugarViewPref,
  saveSugarViewPrompted,
  sugarSummary,
  sugarViewAllowed,
  trimSegmentBlanks,
} from './sugar-view';
import { isSealed, useSealed } from './sealed';
import { isDirectMode, useDirectMode } from './direct-mode';
import { isInWorkspaceFile } from './file-area';
// C1 反向下行批：光标位点广播的载荷构造 + 连续相同载荷去重（纯逻辑，单测在 app/tests）
import { createCursorBroadcaster, cursorMovedPayload } from './cursor-broadcast';
// 问题汇总：refreshMarkers 逐文件整份发布两层波浪线（erb-parser / condition-extractor）到 problem-store
import { clearAllProblems, clearProblems, setProblems } from './problem-store';
// 装饰热路径（PERF-4）：同步/异步分层、(path, versionId) LRU、陈旧结果落地前作废
import { createMarkerRunner, type MarkerContributor } from './marker-pool';
// model 池（SPLIT-1 分屏）：纯逻辑工厂 + 真身单例（单例单独成模块，monaco 不进工厂的测试链）
import { languageFor } from './editor-model-pool';
import { editorModelPool } from './editor-model-pool-instance';
// worker 侧有没有这条 kind，判据只有一处：装配层那张两侧共用的任务表
import { hasWorkerTask } from '../compute-tasks';

// Monaco worker 装配（vite ?worker 后缀）；ERB 无需语言服务 worker，base 编辑器 worker 即可
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};
registerErbLanguage(monaco);
registerKojoLanguage(monaco);

/** marker owner（同一 owner 的 markers 每次整体替换；不同 owner 互不干扰） */
const MARKER_OWNER = 'kojo-decorators';
/** CodeAction 执行命令 id（宿主统一注册一次；command 参数为 pendingActionsRef 的反查 key） */
const CODE_ACTION_COMMAND = 'kojo.codeAction.run';
/** 编辑停顿多久后重算装饰（避免每击键跑一遍转译） */
const MARKER_DEBOUNCE_MS = 250;

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
 * 另附 `erbFunctionNames`（**非** adapter 表）——项目内全部函数名（EC-3 函数名补全预置），
 * 由 `erb-parser` 的 `ErbIndex` 派生并按整项目指纹记忆化（见 `erb-function-names-for`）。
 */
function editorTables(kernel: Kernel): CompletionTables & ErbCompletionTables & SignatureTables & HoverTables {
  const project = kernel.project.current();
  if (!project) return {};
  for (const contribution of kernel.slots.query('game.adapter')) {
    if (contribution.adapter.gameId !== project.adapterId) continue;
    const adapter = contribution.adapter;
    return {
      ...(adapter.variableSchema
        ? { dictionary: makeLookup(adapter.variableSchema), variableSchema: adapter.variableSchema }
        : {}),
      ...(adapter.kojoFaceTemplates ? { faceTable: adapter.kojoFaceTemplates } : {}),
      ...(adapter.kojoLibraryTable ? { libraryTable: adapter.kojoLibraryTable } : {}),
      ...(adapter.kojoInstructionTable ? { instructionTable: adapter.kojoInstructionTable } : {}),
      // 计数器中文名 → 原生编号的反查（ZH-D3）：与补全/诊断同一枚 adapter，运行时现取
      ...(adapter.kojoCounterTable ? { counterTable: adapter.kojoCounterTable } : {}),
      // B5 签名帮助要的槽语义表（同一枚 adapter 贡献，运行时现取；缺席 = 不产签名）
      ...(adapter.kojoCallProtocol ? { callProtocol: adapter.kojoCallProtocol } : {}),
      erbFunctionNames: erbFunctionNamesFor(kernel),
      // ERB 函数悬停通道：erb.parser 的当前索引**每次现取**（索引随项目开闭重建，不缓存脏表）。
      // 解析器缺席 / 索引在途只让该路无结果（退化可见），绝不抛进悬停 seam。
      erbIndex: () => {
        try {
          return kernel.services.tryGet<ErbParserService>('erb.parser')?.currentIndex() ?? null;
        } catch {
          return null;
        }
      },
    };
  }
  return {};
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
    fn = memoizedErbFunctionNames(() => {
      try {
        return kernel.services.tryGet<ErbParserService>('erb.parser')?.currentIndex() ?? null;
      } catch {
        return null;
      }
    });
    erbFnMemoByKernel.set(kernel, fn);
  }
  return fn;
}

/**
 * 就近征询**保存接管者**（槽 `ui.editor.saveHandler`，2026-10-12 批）：返回
 * `order` 最小的命中贡献（唯一接管，不做链式级联）；无命中 → undefined（宿主
 * 退回内核 io `writeText` 缺省保存）。单个贡献抛错不影响其余（与装饰器同款
 * 隔离——能力出错要"退化可见"，不让整条保存链断掉）。
 */
function pickSaveHandler(kernel: Kernel, path: string): EditorSaveHandlerContribution | undefined {
  const matches: EditorSaveHandlerContribution[] = [];
  for (const contribution of kernel.slots.query('ui.editor.saveHandler')) {
    try {
      if (contribution.matches(path)) matches.push(contribution);
    } catch (e: unknown) {
      // 贡献抛错不静默（与 plugin-api「绝不静默」约定一致）：
      // 记录后仍降级为缺省保存，避免单个坏贡献阻断整条保存链路。
      console.warn(
        `[EditorPane] save handler '${contribution.id}' matches('${path}') 抛错：${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); // 稳定排序：同 order 保持注册顺序
  return matches[0];
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
function applyTextEdits(
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
 * 路径末段（弹窗里给文件名而不是整条路径：用户认文件，不认目录树）。
 * 拆分口径与工具条共用 `path-label.splitPath`，一处规矩。
 */
function baseNameOf(path: string): string {
  return splitPath(path).base;
}

/** autosave 快照句柄吐出的一条脏内容（退出/崩溃守护批；只增不改——旧消费方零影响） */
export interface EditorSnapshotRecord {
  path: string;
  text: string;
  encoding: string;
  eol: string;
}

/**
 * 编辑器动作句柄（P3 多标签批）：宿主（App）经 `registerActions` 取得，
 * 供「保存并关闭」「全部保存」等标签级流程调用。
 */
export interface EditorPaneActions {
  /** 保存当前活动标签 */
  save: () => Promise<boolean>;
  /** 保存指定标签（含后台标签；model 仍在内存中，无需切换） */
  savePath: (path: string) => Promise<boolean>;
  /** 保存全部脏标签（并发池 + 一条合成回执；needs-choice 跳过计入回执，不静默） */
  saveAll: () => Promise<boolean>;
  /** 全部脏标签的内容快照（autosave 兜底用：O(脏数) 取值，不切标签不落盘） */
  snapshots: () => EditorSnapshotRecord[];
}

/** 单个打开文件的 model 记录（多标签：model 随标签存续，切换不销毁） */
interface ModelEntry {
  model: Monaco.editor.ITextModel;
  listener: Monaco.IDisposable;
  /** 打开时的编码/EOL（状态栏展示用；保存由内核 io 保编码） */
  encoding: string;
  eol: string;
}

/* ------------------- SPLIT-1：多实例基座（模块级单注册） ------------------- */

/**
 * 每个活着的 EditorPane 实例在模块注册表里的一条档案。全局（`monaco.languages.*` /
 * `registerCommand` / 跳转探针）provider **只注册一份**（standalone Monaco 的 language
 * provider 是全局单表，双实例注册 = 补全候选成对重复），resolve 回调收到 `model` 后经
 * `owningPaneOf` 反查归属实例，再读该实例的 ref——单实例时行为与旧版（闭包直读自身
 * ref）逐字等价。
 */
interface PaneCtx {
  paneId: string;
  editorRef: { current: Monaco.editor.IStandaloneCodeEditor | null };
  entriesRef: { current: Map<string, ModelEntry> };
  filePathRef: { current: string };
  sugarModelRef: { current: Monaco.editor.ITextModel | null };
  pendingActionsRef: { current: Map<string, EditorCodeAction> };
  actionSeqRef: { current: number };
  crumbTreeCacheRef: { current: { path: string; versionId: number; symbols: EditorDocumentSymbol[] } | null };
}

const livePanes = new Map<string, PaneCtx>();
let paneSeq = 0;
/** 最后一次获得焦点的实例（跳转探针读它；编辑器 focus 与实例首挂时刷新） */
let focusedPaneId: string | null = null;
let globalsInstalled = false;
/** 全局 provider 的 kernel 来源（单 kernel 应用；随最新实例刷新，等价旧版闭包捕获） */
let globalKernel: Kernel | null = null;
const globalDisposers: Monaco.IDisposable[] = [];
/** Monarch 词表等模块级资源的实例引用计数（最后一个实例退场才清） */
let erbWordsUsers = 0;
let lastWordsKey = '__unset__';
let bootEditorMarked = false;

/**
 * 全局 provider 的**单次注册**（SPLIT-1 多实例基座）：standalone Monaco 的
 * `monaco.languages.*` provider / `registerCommand` / 跳转探针都是模块级单表，
 * 每个实例各注册一份 = 补全候选成对重复、命令解析错组。这里只在首个实例挂载时
 * 注册一次；各 resolve 回调收到 `model` 后经 `owningPaneOf` 反查归属实例再读它的
 * ref——单实例时与旧版（闭包直读自身 ref）逐字等价，多实例时按"model 在哪组编辑器
 * 上活动"分派。最后一个实例退场时整体拆毁（`disposeGlobalProviders`）。
 */
function ensureGlobalProviders(): void {
  if (globalsInstalled) return;
  globalsInstalled = true;
    // 💡 CodeAction 宿主适配（槽 `ui.editor.codeAction`，P3b）：宿主只做 Monaco 协议
    // 转换（registerCodeActionProvider），动作产出全在插件（纯函数 provideActions）；
    // 执行经 registerCommand 落地，command 参数用 id 反查 pendingActionsRef（参数须可
    // 序列化，且避免闭包捕获过时文本）。
    const cmdDisposer = monaco.editor.registerCommand(CODE_ACTION_COMMAND, (_accessor, actionId: string) => {
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
    });
    const providerDisposer = monaco.languages.registerCodeActionProvider(
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
    );
    // 悬停中文名（ZH-F2）：只读显示，光标下的原生记号 → 中文名。表按当前项目 adapterId
    // **运行时**现取（`editorTables`），查不到即不显示（**不猜**）。与 CodeAction 同款隔离。
    const hoverDisposer = installHover(monaco, () => editorTables(requireKernel()));
    // 转到定义（2026-10-15 语言服务批）：宿主只做 Monaco 协议翻译——光标位置进、目标位置出；
    // "那个名字是什么、定义在哪"全在 `ui.editor.languageService` 槽（ERB 由解析器答、
    // `.kojo` 由糖线答）。跨文件跳转不新造机制：发 `editor.revealLocation`（宿主既有通道，
    // App 据此开文件、编辑器据此滚动）——与 codeAction 的"宿主零业务"同一分层。
    // D4（2026-10-15 Peek 批）追加两条腿：目标在同文件/已开标签时**返回真 LocationLink**
    // （Monaco 的 `Alt+F12` Peek 与就地跳都以这份返回为数据源），其余情形照旧发事件。
    const definitionDisposer = installDefinitionProvider(monaco, {
      resolve: (model, position) => {
        const ctx = owningPaneOf(model);
        // 与 codeAction 同一判据（见上方 provideCodeActions）：只应答当前活动标签的真 model。
        // 糖视图下 `ed.getModel()` 是只读糖 model——它的行号对应糖文本，拿它去问 ERB 行号
        // 会得到"派生物里的位置"，所以一律不供，避免把作者跳到错行。
        if (!ctx) return [];
        const path = ctx.filePathRef.current;
        if (!path) return [];
        return collectDefinitionLocations(requireKernel().slots.query('ui.editor.languageService'), {
          kind: 'definition',
          path,
          text: model.getValue(),
          line: position.lineNumber,
          column: position.column,
          project: requireKernel().project.current(),
          lineCount: model.getLineCount(),
        });
      },
      navigate: (location) => {
        requireKernel().bus.emit('editor.revealLocation', {
          filePath: location.filePath,
          line: location.line,
          ...(location.column !== undefined ? { column: location.column } : {}),
          source: '转到定义',
        });
      },
      // D4（Peek 就地预览）两条腿的判据都来自**全部组**的打开表（`openModelAcrossGroups` /
      // 路径，值 = 那份 model），路径比较一律走 `matchOpenedPath` 的 `pathKey` 口径
      // （HK-7：平台原样路径与宿主键在 Windows 上分隔符/大小写不一致，裸字符串比会静默判不上）：
      // - openModelFor：目标文件是否**已经开着**（开着 ⇒ 有 model ⇒ Monaco 能给 Peek 显示）；
      // - pathForUri：Monaco 的跨 model 跳转请求（opener）反回宿主路径，落回同一条
      //   `editor.revealLocation` 通道——不新造第二套导航机制。
      openModelFor: openModelAcrossGroups,
      pathForUri: pathForUriAcrossGroups,
    });
    // 文档大纲（B3）：同一枚 `ui.editor.languageService` 槽的第二个判别成员。宿主照旧只做
    // 协议翻译——"这篇文档有哪些层"全在插件（ERB 给函数与声明、`.kojo` 给时机/段/分支）。
    // 这份树同时是**粘性滚动**的贴顶来源（吸顶显示"当前在哪个函数 / 哪个时机块里"），
    // 所以它必须在糖视图之外只认真 model：糖 model 的行号属于派生物，贴出来是错的层次。
    const symbolsDisposer = installDocumentSymbolProvider(monaco, {
      resolve: (model) => {
        const ctx = owningPaneOf(model);
        if (!ctx) return [];
        const path = ctx.filePathRef.current;
        if (!path) return [];
        return collectDocumentSymbols(requireKernel().slots.query('ui.editor.languageService'), {
          kind: 'documentSymbol',
          path,
          text: model.getValue(),
          project: requireKernel().project.current(),
          lineCount: model.getLineCount(),
        });
      },
    });
    // 签名帮助（B5 形参槽语义 + R5 跨行 / ERB 形参签名）：唯一真源两层——
    // ① adapter 的调用协议表（槽语义）；② 协议不认识时的 ERB 用户函数形参（解析器索引
    // `erb.parser`，按归一化名查定义取 `params` 原文）。两层都运行时现取（表随项目开闭
    // 重建，缓存会把上一个项目的表带过来）；都缺席 / 都不认 ⇒ 不应答，**不猜**。
    // 跨行：`resolveSignatureInText` 从光标行向上收未闭合括号（窗口封顶），最内层括号
    // 语义与单行同源。糖视图挂的是只读派生 model，它的行列不属于原文 ⇒ 与 codeAction /
    // 转到定义同判据一律不应答。
    const signatureDisposer = installSignatureHelp(monaco, {
      resolve: (model, position) => {
        const ctx = owningPaneOf(model);
        if (!ctx) return null;
        const path = ctx.filePathRef.current;
        if (!path) return null;
        const protocol = editorTables(requireKernel()).callProtocol;
        return resolveSignatureInText(model.getValue(), position.lineNumber, position.column, protocol, (callee) => {
          try {
            const index = requireKernel().services.tryGet<ErbParserService>('erb.parser')?.currentIndex() ?? null;
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
    });
    // 折叠范围（D3）：同一枚 `ui.editor.languageService` 槽的第三个判别成员。ERB 原文不缩进，
    // Monaco 的缩进折叠在其上几乎无效——注册供给器后 `foldingStrategy: auto` 自动改走这里。
    // 应答判据与大纲逐字同款：糖 model 的行号属于派生物，折叠它会把作者折进不存在的位置。
    const foldingDisposer = installFoldingRangeProvider(monaco, {
      resolve: (model) => {
        const ctx = owningPaneOf(model);
        if (!ctx) return [];
        const path = ctx.filePathRef.current;
        if (!path) return [];
        return collectFoldingRanges(requireKernel().slots.query('ui.editor.languageService'), {
          kind: 'foldingRange',
          path,
          text: model.getValue(),
          project: requireKernel().project.current(),
          lineCount: model.getLineCount(),
        });
      },
    });

    // 结构化着色（B6，作者面叫「名字按用途着色」）：同一枚 `ui.editor.languageService` 槽的
    // 第六个判别成员。宿主照旧只做协议翻译——"这个名字在这里是定义、形参槽还是引用"
    // 全在插件（ERB 由解析器答、`.kojo` 由表层 DSL 线答），本层一个 ERB / 糖名词都不认识。
    // 应答判据与大纲/折叠逐字同款：糖 model 的行号属派生物，着色它就是把颜色画到
    // 一份不存在的文本上。开关**不在这里判**：Monaco 的 `editor.semanticHighlighting.enabled`
    // 关着时根本不会问 provider（见 `semantic-color-pref.ts`），这里只留大文件那一道降级闸。
    const semanticDisposer = installSemanticTokensProvider(monaco, {
      resolve: (model) => {
        const ctx = owningPaneOf(model);
        if (!ctx) return [];
        const path = ctx.filePathRef.current;
        if (!path) return [];
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
    });
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
    const completionDisposer = installKojoCompletion(monaco, () => editorTables(requireKernel()));
    // `.erb` 方言补全（EC-1 seam）：同 `editorTables` 单一数据源；候选由 `ERB_COMPLETION_SOURCES` 提供。
    const erbCompletionDisposer = installErbCompletion(monaco, () => editorTables(requireKernel()));
    // ERB 函数重命名（F2，2026-10-16）：判定与编辑收集全在解析器索引（`erb.parser`），
    // 宿主只注入 monaco 拿不到的东西——活动标签判据（同 codeAction 逐字同款）、写权限
    // （`requireKernel().io.isWritable`，与保存同源口径）、已开标签表、未打开文件的 io 落盘通道。
    // 「查找引用」的 ERB 数据源由下方 `referenceSearchDisposer`（languageService 槽）承担；
    // 这组 helpers 只喂重命名（ErbReferenceHandlers = 重命名 handlers）。
    const canAnswerErb = (model: Monaco.editor.ITextModel): boolean => {
      const ctx = owningPaneOf(model);
      return !!ctx && !!ctx.filePathRef.current;
    };
    const currentIndexErb = (): ErbIndex | null => {
      try {
        return requireKernel().services.tryGet<ErbParserService>('erb.parser')?.currentIndex() ?? null;
      } catch {
        return null;
      }
    };
    const referencesToErb = (name: string): readonly ErbReference[] | null => {
      try {
        const parser = requireKernel().services.tryGet<ErbParserService>('erb.parser');
        return parser?.referencesTo ? parser.referencesTo(name) : null;
      } catch {
        return null;
      }
    };
    const erbRenameDisposer = installErbRename(monaco, {
      canAnswer: canAnswerErb,
      currentIndex: currentIndexErb,
      referencesTo: referencesToErb,
      isWritable: (path) => requireKernel().io.isWritable(path),
      openModelFor: openModelAcrossGroups,
      applyToClosedFile: async (filePath, refs, newName, normalizedName) => {
        const { text } = await requireKernel().io.readText(filePath);
        const next = applyReferenceEdits(text, refs, newName, normalizedName);
        if (next.text !== text) await requireKernel().io.writeText(filePath, next.text);
        return { applied: next.applied, stale: next.stale };
      },
    });
    // 查找所有引用（R2，2026-10-16）：同一枚 `ui.editor.languageService` 槽的第七个判别
    // 成员。宿主只做协议翻译——认活动标签的真 model（与转到定义逐字同判据）、问槽、
    // 把"未打开文件"那条腿的点击落回 `editor.revealLocation`（与转到定义同通道）。
    // 引用什么算、谁在索引外，全在贡献方（ERB 由解析器答、`.kojo` 由糖线答）。
    const referenceSearchDisposer = installReferenceProvider(monaco, {
      resolve: (model, position) => {
        const ctx = owningPaneOf(model);
        if (!ctx) return [];
        const path = ctx.filePathRef.current;
        if (!path) return [];
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
        requireKernel().bus.emit('editor.revealLocation', {
          filePath: location.filePath,
          line: location.line,
          ...(location.column !== undefined ? { column: location.column } : {}),
          source: '查找引用',
        });
      },
      openModelFor: openModelAcrossGroups,
    });
    // 跳到实现（R3 残项，2026-10-16）：数据源 = `erb.parser` 的 `byName`（本项目用户函数
    // 的定义位；引擎系统函数不在索引 ⇒ 不应答 = 真话"没有实现"）。三条腿复用转到定义的
    // 分腿判据与链接构造（`planDefinitionJump` / `toDefinitionLinks`），跨文件落地同一条
    // `editor.revealLocation` 通道——不新造第二套跳转。取数走服务本体而非 languageService
    // 槽（同 erb-rename 先例：为转发加联合成员换不来新数据）。
    const implementationDisposer = installImplementationProvider(monaco, {
      canAnswer: (model) => {
        const ctx = owningPaneOf(model);
        return !!ctx && !!ctx.filePathRef.current;
      },
      currentIndex: () => {
        try {
          return requireKernel().services.tryGet<ErbParserService>('erb.parser')?.currentIndex() ?? null;
        } catch {
          return null;
        }
      },
      navigate: (location) => {
        requireKernel().bus.emit('editor.revealLocation', {
          filePath: location.filePath,
          line: location.line,
          ...(location.column !== undefined ? { column: location.column } : {}),
          source: '跳到实现',
        });
      },
      openModelFor: openModelAcrossGroups,
      pathForUri: pathForUriAcrossGroups,
    });
    // `.kojo` 用户函数改名（R1，2026-10-16）：同一枚槽的第八个判别成员。ERB 方言不归它
    // 管（全项目改名走上面 `erbRenameDisposer` 的专用通道）；`.kojo` 的判定（可证明引用面
    // + 整卷复核）全在糖线，宿主只做 Monaco 协议翻译与落地前的现文本验证（模块头注）。
    const kojoRenameDisposer = installKojoRename(monaco, {
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
              `[kojo-rename] '${contribution.id}' provide 抛错：${e instanceof Error ? e.message : String(e)}`,
            );
            continue;
          }
          if (result && result.kind === 'rename') {
            return { edits: result.edits, ...(result.oldName !== undefined ? { oldName: result.oldName } : {}), ...(result.rejectReason !== undefined ? { rejectReason: result.rejectReason } : {}) };
          }
        }
        return { edits: [], rejectReason: '「.kojo」改名只认本文件「函数」块声明的名字（语言服务未应答这处请求）' };
      },
    });
    // 文档格式化（E1，`Shift+Alt+F`）：规则全在插件（`computeFormatEdits` 纯函数），宿主只做
    // 协议翻译。应答判据与 codeAction / 转到定义逐字同款：只认**当前活动标签的真 model**——
    // 糖视图挂着只读派生 model，格式化它改的不是真文件，所以一律不应答。
    const formatResolve: FormatHandlers = {
      resolve: (model) => {
        const ctx = owningPaneOf(model);
        if (!ctx) return null;
        const path = ctx.filePathRef.current;
        if (!path) return null;
        const dialect = dialectForLanguage(model.getLanguageId());
        return dialect === null ? null : { text: model.getValue(), dialect };
      },
    };
    const formatterDisposer = installDocumentFormatter(monaco, formatResolve);
    // 选区格式化 + 打字规范化（T13）：同一份 resolve、同一份规则核心，只多一层行裁剪（ERB 语言）
    const rangeFormatterDisposer = installRangeFormatter(monaco, formatResolve);
    // 行上内联注解（B8，2026-10-16）：同一枚 `ui.editor.languageService` 槽的第五个判别成员。
    // 宿主在这里做的事只有四件：认活动标签的**真** model、把体量/预算两档降级判掉、问槽、
    // 把点击落到**既有**的 `editor.revealLocation` 通道（不新造第二套跳转，与转到定义同腿）。
    // 注解说什么（"被 N 处用到"、何时不说、大数为什么说 `1000+`）全在贡献方，宿主零判定——
    // 分工与取舍见 `monaco/kojo-code-lens.ts` 与 `plugins/erb-parser/src/usage-lens.ts` 头注。
    //
    // **开关不在这儿**：那是 Monaco 的 `codeLens` 编辑器选项，由下面那条独立的偏好 effect
    // 落地（关掉时 Monaco 根本不发请求，省掉一次整篇解析）。
    const codeLensDisposer = installCodeLensProvider(monaco, {
      resolve: (model) => {
        const ctx = owningPaneOf(model);
        if (!ctx) return [];
        const path = ctx.filePathRef.current;
        if (!path) return [];
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
        requireKernel().bus.emit('editor.revealLocation', {
          filePath: target.filePath,
          line: target.line,
          ...(target.column !== undefined ? { column: target.column } : {}),
          source: '行上注解',
        });
      },
    });
    // 行内提示（LS-R6，2026-10-16）：同一枚 `ui.editor.languageService` 槽的第七个判别成员。
    // 应答判据与 codeLens 逐字同款：只认活动标签的真 model（糖视图挂的是只读派生 model，
    // 它的行列不属于原文），体量档 `inlayHintsAffordable` 判在请求之前（52,602 行实测
    // 50ms/次，档线与 stickyScroll / 面包屑 / codeLens 同一条）。提示说什么（实参落
    // 哪个形参槽）全在 erb-parser（`erb-inlay-hints`），宿主零判据——取舍见
    // `monaco/kojo-inlay-hints.ts` 与 `plugins/erb-parser/src/inlay-hints.ts` 头注。
    const inlayHintsDisposer = installInlayHintsProvider(monaco, {
      resolve: (model) => {
        const ctx = owningPaneOf(model);
        if (!ctx) return [];
        const path = ctx.filePathRef.current;
        if (!path) return [];
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
    });

  globalDisposers.push(
    cmdDisposer,
    providerDisposer,
    hoverDisposer,
    definitionDisposer,
    symbolsDisposer,
    signatureDisposer,
    foldingDisposer,
    semanticDisposer,
    completionDisposer,
    erbCompletionDisposer,
    erbRenameDisposer,
    referenceSearchDisposer,
    implementationDisposer,
    kojoRenameDisposer,
    formatterDisposer,
    rangeFormatterDisposer,
    codeLensDisposer,
    inlayHintsDisposer,
  );
}

function disposeGlobalProviders(): void {
  for (const d of globalDisposers) d.dispose();
  globalDisposers.length = 0;
  globalsInstalled = false;
  lastWordsKey = '__unset__';
}

function requireKernel(): Kernel {
  if (!globalKernel) throw new Error('[EditorPane] 全局 provider 在无实例时被调用（不应发生）');
  return globalKernel;
}

/** 跨组反查：哪组的活动编辑器正显示这份 model（糖 model 是派生物，无主 → null） */
function owningPaneOf(model: Monaco.editor.ITextModel): PaneCtx | null {
  for (const ctx of livePanes.values()) {
    const ed = ctx.editorRef.current;
    if (!ed || ed.getModel() !== model) continue;
    return ctx.sugarModelRef.current === model ? null : ctx;
  }
  return null;
}

function focusedCtx(): PaneCtx | null {
  const focused = focusedPaneId ? livePanes.get(focusedPaneId) : undefined;
  return focused ?? livePanes.values().next().value ?? null;
}

/**
 * 跨组版「目标文件是否已开着」（原单实例版经 `matchOpenedPath` 找回宿主键，HK-7）：
 * 任一组的打开表命中即返回那份共享 model——Peek / 重命名 / 引用的跨文件腿由此看见
 * 另一组开着的文件。
 */
function openModelAcrossGroups(filePath: string): Monaco.editor.ITextModel | undefined {
  for (const ctx of livePanes.values()) {
    const key = matchOpenedPath(ctx.entriesRef.current.keys(), filePath);
    if (key) return ctx.entriesRef.current.get(key)?.model;
  }
  return undefined;
}

/** 跨组版 URI → 宿主路径（Monaco opener 反查）：遍历全部组的打开表 */
function pathForUriAcrossGroups(uri: string): string | undefined {
  for (const ctx of livePanes.values()) {
    for (const [path, entry] of ctx.entriesRef.current) {
      if (entry.model.uri.toString() === uri) return path;
    }
  }
  return undefined;
}


/**
 * A10：保存互斥从"组件实例一把全局锁"降为 **per-path 锁**，且提到模块级共享——
 * 分屏后同一文件可在多组打开，锁必须跨实例生效；不同文件则放行使能并发写
 * （IPC 桥逐命令独立、Rust 原子写临时名逐次唯一，跨文件并发无共享态可踩）。
 */
const sharedSaveLock = createPathMutex();

interface Props {
  kernel: Kernel;
  /** 所属编辑器组 id（SPLIT-1 分屏：糖视图 model URI 隔离、宿主按组收动作句柄） */
  groupId: string;
  /** 当前活动标签路径 */
  filePath: string;
  /** 全部打开的标签（model 生命周期以此为准：不在列表中的 model 释放池引用） */
  openPaths: readonly string[];
  /** 定位行（来自校验面板 / 函数树的 `editor.revealLocation`） */
  revealLine?: number;
  /** 定位列（1 基、UTF-16 码元；缺席 = 落行首，与列接线前一致） */
  revealColumn?: number;
  /** 定位序号：同一文件重复定位时变化以触发重新滚动 */
  revealNonce?: number;
  /** 脏状态上抛（P3：按路径逐个上报，宿主维护 dirtyPaths 集合） */
  onDirtyChange?: (path: string, dirty: boolean) => void;
  /** 注册编辑器动作句柄（宿主"保存并关闭 / 全部保存"流程用；卸载时以 null 注销） */
  registerActions?: (actions: EditorPaneActions | null) => void;
  /** 重授权入口（通知 action「去授权」落地处） */
  onReauth: () => void;
  /** 编辑器状态上抛（状态栏右区显示编码/EOL/行数 + A9 选区/光标读数；卸载或无文件时 null；autosavedAt 走同一条链路，A6 状态栏轻指示） */
  onStatusInfo?: (info: { encoding: string; eol: string; lines: number; autosavedAt?: number | null; sel?: string } | null) => void;
  /** 编辑器获得焦点（SPLIT-1：宿主据此把焦点组切到本组） */
  onFocused?: () => void;
}

/**
 * Monaco 编辑面板（P3 多标签化）：
 * - 每个标签一个 model：打开 = 读盘建 model，切换 = saveViewState → setModel →
 *   restoreViewState（编辑内容全程留内存，切换零丢失、零确认）；标签关闭即 dispose；
 * - 保存（Ctrl+S）= 先征询 `ui.editor.saveHandler` 槽（就近接管，如 `.kojo` →
 *   保存源 + 编译产物），无命中则走内核 io.writeText 缺省路径（保编码 + 自动
 *   备份，受写白名单约束）；保存期告警（全角空格）弹确认框 + 一键修复；
 * - 脏判定按 model 版本号 O(1)（BUG-4），逐 model 监听上报；
 * - 支持外部定位（revealLine）；语言按扩展名选择；
 * - 波浪线：消费 `ui.editor.decorator` 槽全部贡献（纯函数）→ Monaco markers，
 *   打开即算、编辑停顿去抖重算（v0.3 S6）。
 */
export function EditorPane({
  kernel,
  groupId,
  filePath,
  openPaths,
  revealLine,
  revealColumn,
  revealNonce,
  onDirtyChange,
  registerActions,
  onReauth,
  onStatusInfo,
  onFocused,
}: Props): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  /** 全部打开文件的 model（随标签存续；切换不销毁，关闭释放池引用） */
  const entriesRef = useRef(new Map<string, ModelEntry>());
  /** 各标签的视图状态（光标/滚动；切换时保存/恢复） */
  const viewStatesRef = useRef(new Map<string, Monaco.editor.ICodeEditorViewState | null>());
  /** 上一个活动路径（切换时先把它的视图状态存下） */
  const prevPathRef = useRef<string | null>(null);
  /** 上一次 savePath 是否走了"竞态保留脏"分支（写成功但保存期间又来新输入）——非失败，A6 不误报 */
  const saveRacedRef = useRef(false);
  const revealRef = useRef<RevealTarget | null>(null);
  /** 当前文件路径（供只注册一次的 Monaco 回调读取最新值，避免闭包过时） */
  const filePathRef = useRef<string>(filePath);
  const openPathsRef = useRef<readonly string[]>(openPaths);
  /** 重授权入口 ref（同上：Monaco 回调与保存句柄只注册一次，须读最新值） */
  const onReauthRef = useRef<() => void>(onReauth);
  /** 焦点上抛 ref（SPLIT-1：编辑器聚焦 ⇒ 宿主把焦点组切到本组） */
  const onFocusedRef = useRef<(() => void) | undefined>(onFocused);
  /**
   * 工作区根（创作权威区，恒可写）——ERB 只读规则的分野依据：
   * 游戏目录内 ERB = 只读借阅；**全部工作区根**（默认根 + 作者自选的项目位置）内的 ERB
   * = 可编辑源文件（工作区批新增，自选位置批扩成多根）。
   *
   * 判定本身住在 `file-area.ts`（状态栏可写胶囊问的是同一个问题，两处共用一把尺子，
   * 不许在这里另写一份）。每次判定现取，不缓存：`roots()` 是同步读内存数组、零 IO，
   * 缓存没有收益，反而会把"本会话刚自选的那个新根"永远排除在外（一次取值定死 ⇒ 之后一路判成借阅件锁只读）。
   */
  const inWorkspace = (p: string): boolean => isInWorkspaceFile(kernel, p);
  /**
   * 直连模式（direct-mode.ts）可编辑判定：开关开 + 该文件在写白名单内（用户批准的可写目录）
   * ⇒ 游戏目录 ERB 视为可直接编辑（就地编辑工作流）。写保护铁律不破：可写性仍完全来自
   * `kernel.io.isWritable`（用户批准的 writablePaths），直连模式不扩权。
   */
  const directEditable = (p: string): boolean => isDirectMode() && kernel.io.isWritable(p);
  const onDirtyChangeRef = useRef(onDirtyChange);
  /** 编辑器状态上抛 ref（重载时读最新，避免把不稳定 prop 拖进回调依赖） */
  const onStatusInfoRef = useRef(onStatusInfo);
  const notify = useNotify();
  /** 装饰重算定时器（编辑停顿去抖） */
  const markerTimerRef = useRef<number | null>(null);
  /** 装饰刷新函数（ref 化，供只注册一次的 model 监听调用） */
  const refreshMarkersRef = useRef<((model: Monaco.editor.ITextModel, path: string) => void) | null>(null);
  /** CodeAction 待执行动作表（Monaco command 参数须可序列化 → 以 id 反查动作本体） */
  const pendingActionsRef = useRef(new Map<string, EditorCodeAction>());
  /** CodeAction id 序号（**单调递增不复用**：Monaco 可能持有上一轮列表，复用 id 会解析到别的动作） */
  const actionSeqRef = useRef(0);
  /**
   * 糖视图当前挂载的只读内存 model（null = 未启用糖视图）。
   *
   * 整份糖文本写进这份 model，用 `ed.setModel()` 换上；它非空即代表"编辑器此刻显示的是
   * 糖而不是原文"，所有读 `ed.getModel()` 的路径都要据此改判（见 `currentFileModel`）。
   */
  const sugarModelRef = useRef<Monaco.editor.ITextModel | null>(null);
  /** 糖视图挂载前编辑器上的原文 model（糖模式降级取模 / 还原兜底用） */
  const sugarOriginalModelRef = useRef<Monaco.editor.ITextModel | null>(null);
  /**
   * 已解锁编辑的 ERB 路径（**会话内有效**，不落盘）。
   *
   * 为什么不持久化：ERB 默认只读是**安全姿态**（游戏目录里别人的口上，误改即事故）。
   * 解锁是用户对"这一份文件、这一次会话"的显式决定；重启后回到默认只读，成本极低
   * （再点一次弹窗即可），而"上次解锁过就一直可写"会让保护形同虚设。
   */
  const unlockedPathsRef = useRef(new Set<string>());
  /** 当前活动文件是否已解锁编辑（驱动 readOnly 与工具条文案） */
  const [unlocked, setUnlocked] = useState(false);
  /** 待用户决策的"ERB 编辑解锁"询问（非 null = 弹确认框） */
  const [unlockAsk, setUnlockAsk] = useState<string | null>(null);
  /** 是否弹"首次引导：要不要用语法糖视图"（只在首次打开 ERB 时一次） */
  const [introAsk, setIntroAsk] = useState(false);
  /** 糖视图开关（偏好持久化；默认**关**——缺省即"看到的正是盘上那份"，见 `sugar-view.ts` 头注） */
  const [sugarView, setSugarView] = useState<boolean>(() => loadSugarViewPref());
  /**
   * 封存总闸（`sealed.ts`；默认封存）。它如今**只作用于两个面板**，糖视图不在其内；
   * 这里剩下的用处只有"解锁弹窗讲多少话"那一档文案口径（见 `decideUnlock` / 弹框选型）。
   */
  const sealed = useSealed();
  /**
   * 直连模式开关（`direct-mode.ts`；默认关）—— React 触发（re-render）：切换时
   * 走下方 effect 重算当前文件的可编辑态，并让糖视图让位/恢复。
   */
  const directMode = useDirectMode();
  /** 同一份"最新开关"给只注册一次的 Monaco 回调读（避免闭包过时） */
  const sugarViewRef = useRef<boolean>(sugarView);
  /** 糖视图摘要（null = 未启用 / 无文件）；工具条展示 */
  const [sugarStats, setSugarStats] = useState<string | null>(null);
  /** 正在以磁盘内容重载 model（抑制由此触发的脏上报：重载不是用户编辑） */
  const reloadingRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** 待用户决策的保存告警（非 null = 弹确认框；宿主全角空格"一键修复"的入口） */
  const [pendingChoice, setPendingChoice] = useState<EditorSaveWarning | null>(null);
  /** 保存告警的 ref 镜像（A6：自动保存 tick 是定时器闭包，护栏须读最新值） */
  const pendingChoiceRef = useRef<EditorSaveWarning | null>(null);
  /** 外部改动与本地脏冲突、用户未处置的路径集（A6 护栏：未决不自动保存） */
  const externalConflictRef = useRef(new Set<string>());
  /** 自动保存连败已报过的路径（同一文件连败只报一次；保存成功即销账） */
  const autosaveFailedRef = useRef(new Set<string>());
  /** 自动保存闲置定时器（A6；卸载与文件切换都要能取消） */
  const autosaveTimerRef = useRef<number | null>(null);
  /**
   * D1 面包屑链（宿主自绘——取证：standalone Monaco 0.57 的 `monaco.d.ts` 里 `breadcrumb`
   * 零命中，公开面没有面包屑，见 `breadcrumb-path.ts` 头注）。数据**复用 B3 的 documentSymbol
   * 树**（与大纲/吸顶同源同判据，不建第二份符号树）；空数组 = 不渲染整条栏
   * （糖视图 / 无文件 / 光标不在任何块内——只读派生态下绝不导到派生行号）。
   */
  const [crumbs, setCrumbs] = useState<readonly CrumbItem[]>([]);
  /** 面包屑刷新入口（ref 化：光标/model 监听只注册一次，须读最新闭包） */
  const crumbRefreshRef = useRef<(() => void) | null>(null);
  /** 大纲树缓存（path + model 版本号为键：光标移动只换链、不重解析） */
  const crumbTreeCacheRef = useRef<{ path: string; versionId: number; symbols: EditorDocumentSymbol[] } | null>(
    null,
  );
  /** 上一次渲染的链键（等值即不 setState——光标每动一次不该白刷一次 React） */
  const crumbsKeyRef = useRef('');
  /** 上一次**重算过链**的位点（同 path 同行即跳过全文解析，判据见 `crumbsNeedRefresh`） */
  const crumbLastRef = useRef<CrumbCursor | null>(null);

  /** O(1) 脏判定：model 当前版本号 ≠ 已保存基线版本号（BUG-4；基线随池走——分屏后同一文件多组共享） */
  const computeDirty = useCallback((path: string): boolean => {
    const entry = entriesRef.current.get(path);
    const base = editorModelPool.baseline(path);
    if (!entry || base === undefined) return false;
    return entry.model.getAlternativeVersionId() !== base;
  }, []);

  /**
   * A9 状态栏选区读数：活动文件真 model 的选区/光标 → 文案（判据全在纯函数
   * `selection-status.ts`）。糖视图给空串——派生 model 的行号不属于真文件，
   * 状态栏不许用它误导作者（与面包屑同口径）。
   */
  const selStatusRef = useRef('');
  const selReadout = (): string => {
    const ed = editorRef.current;
    if (!ed || !filePathRef.current || sugarModelRef.current) return '';
    const model = ed.getModel();
    const sel = model ? ed.getSelection() : null;
    if (!model || !sel) return '';
    return selectionStatusText(model, sel, { line: sel.positionLineNumber, column: sel.positionColumn });
  };
  /** 读数上抛：复用 dirty/编码 在走的 onStatusInfo 链路；文案未变则不惊动壳层重渲染 */
  const pushSelStatus = (force = false): void => {
    const entry = entriesRef.current.get(filePathRef.current);
    if (!entry) return;
    const sel = selReadout();
    if (!force && sel === selStatusRef.current) return;
    selStatusRef.current = sel;
    onStatusInfoRef.current?.({
      encoding: entry.encoding,
      eol: entry.eol,
      lines: entry.model.getLineCount(),
      sel,
    });
  };

  /**
   * 全部脏标签的内容快照（autosave 兜底句柄，退出/崩溃守护批）：逐 model 读
   * getValue + 打开时的编码/EOL。脏 ⇒ model 必在 entriesRef（脏只可能来自
   * model 监听），所以这里天然是"脏集合真相源"，不需要宿主另传 dirtyPaths。
   */
  const snapshots = useCallback((): EditorSnapshotRecord[] => {
    const out: EditorSnapshotRecord[] = [];
    for (const [path, entry] of [...entriesRef.current]) {
      if (entry.model.isDisposed()) continue;
      if (!computeDirty(path)) continue;
      out.push({ path, text: entry.model.getValue(), encoding: entry.encoding, eol: entry.eol });
    }
    return out;
  }, [computeDirty]);

  /**
   * 文档真相广播（C2，2026-10-16 面板真相统一批）：编辑器缓冲区 = "这个文件当前的
   * 可编译真相"。防抖 / 去重 / 抑制 derived 的判据全在 `document-broadcast`（纯逻辑
   * 可单测），这里只提供两条宿主事实：往内核总线发 `editor.documentChanged`；
   * 糖视图挂载中（derived 只读 model，文本不是文件真相）为抑制态。
   */
  const documentBroadcaster = useMemo(
    () =>
      createDocumentBroadcaster({
        emit: (payload) => kernel.bus.emit('editor.documentChanged', payload),
        // 谓词在**落地时刻**求值：排程后、落地前用户可能刚切进/切出糖视图
        suppressed: () => sugarModelRef.current !== null,
      }),
    [kernel],
  );
  // 卸载（含 kernel 更换重建）清掉在途排程：旧广播器的定时器不该再落地
  useEffect(() => () => documentBroadcaster.dispose(), [documentBroadcaster]);

  /**
   * 现取指定文件的**缓冲真相**（广播载荷的读取入口）。绑定 `entriesRef` 里的真
   * model——糖视图期间它仍指向原文 model（糖 model 从不进 entriesRef，见其 ref 注）；
   * 标签已关 / model 已替换 → null = 本次广播作废（不拿残影当真相）。
   */
  const readDocumentTruth = useCallback(
    (path: string): { text: string; dirty: boolean } | null => {
      const entry = entriesRef.current.get(path);
      if (!entry || entry.model.isDisposed()) return null;
      return { text: entry.model.getValue(), dirty: computeDirty(path) };
    },
    [computeDirty],
  );

  /**
   * 取"当前文件"的**真 model**（装饰 / 保存 / 编辑落点 / 定位的统一入口）。
   *
   * 糖视图激活时 `ed.getModel()` 是那份**只读糖 model**——对它做脏判定、挂波浪线、落编辑
   * 都毫无意义（糖是派生物，没有"已保存基线"，也改不得）。所以糖模式下统一返回该文件真正
   * 的原文 model（`entriesRef` 里的 `entry.model`；极端兜底 `sugarOriginalModelRef`）。
   * 非糖模式退回 `ed.getModel()`，行为与旧版一致。
   */
  const currentFileModel = useCallback((): Monaco.editor.ITextModel | null => {
    const ed = editorRef.current;
    if (!ed) return null;
    if (sugarModelRef.current) {
      return entriesRef.current.get(filePathRef.current)?.model ?? sugarOriginalModelRef.current;
    }
    return ed.getModel();
  }, []);

  /**
   * 光标位点广播（C1 反向下行批）：光标动 / 切文件完成 / 糖视图翻转三处都调它。
   * 广播器实例挂 ref（去重状态跨三处触发存活）；载荷构造与"连续相同不发"的判据
   * 全在 `cursor-broadcast.ts`（纯逻辑，单测钉死）——这里只做"现取此刻事实"。
   */
  const cursorBroadcasterRef = useRef<ReturnType<typeof createCursorBroadcaster> | null>(null);
  const publishCursor = useCallback((): void => {
    const ed = editorRef.current;
    if (!ed) return;
    let broadcaster = cursorBroadcasterRef.current;
    if (!broadcaster) {
      broadcaster = createCursorBroadcaster((payload) => kernel.bus.emit('editor.cursorMoved', payload));
      cursorBroadcasterRef.current = broadcaster;
    }
    broadcaster.publish(
      cursorMovedPayload({
        filePath: filePathRef.current || null,
        position: ed.getPosition(),
        // 糖视图下屏幕上那份是派生物：行号不属于真文件，如实标 derivedView（消费方据此清高亮）
        derivedView: !!sugarModelRef.current,
      }),
    );
  }, [kernel]);

  const applyReveal = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    // 糖视图激活时编辑器显示的是糖 model，其行号与原文不对应；定位请求（校验面板 / 函数树）
    // 给的是**原文行号**，此刻无法直接映射——宁可不动，也绝不做半吊子映射把用户滚到错位置。
    if (sugarModelRef.current) return;
    const model = ed.getModel();
    const target = revealRef.current;
    if (!model || !target) return;
    // 行列夹取的判据在 `reveal-position`（纯函数）；行长一律问 model（`getLineMaxColumn`
    // 本身就是 UTF-16 码元口径），宿主不自算字符数。
    const position = clampRevealPosition(target, {
      lineCount: model.getLineCount(),
      maxColumn: (lineNumber) => model.getLineMaxColumn(lineNumber),
    });
    ed.revealLineInCenter(position.lineNumber);
    ed.setPosition(position);
    ed.focus();
  }, []);

  /**
   * 重算并应用编辑器波浪线（2026-10-16 装饰热路径批：调度住在 `marker-pool.ts`）。
   *
   * 本函数只做两件事：**发起一次刷新** + **定义"结果怎么上屏"**。谁同步跑、谁进
   * worker、同版本要不要重算、迟到的结果能不能信，全在 `createMarkerRunner` 里
   * （那里的读数与判据都可单测）。
   *
   * 发布语义与改动前逐字相同：一次刷新 = 该 owner 的 markers **整档替换** +
   * problem-store 该文件**整档替换**；装饰器抛错不打断编辑（退化可见）。
   * 声明了 `offloadKind` 的贡献会分两拍落地（轻的先上屏、重的回来再整档替换一次），
   * 每一拍仍是一整档，不存在"追加/残留"。
   */
  const markerRunner = useMemo(
    () =>
      createMarkerRunner({
        compute: kernel.compute,
        workerHasTask: hasWorkerTask,
        // 槽位贡献映射成热路径需要的最小面（顺序 = 槽位顺序 = 面板行序）
        contributors: () =>
          kernel.slots
            .query('ui.editor.decorator')
            .map((c): MarkerContributor => ({
              id: c.id,
              ...(c.offloadKind === undefined ? {} : { offloadKind: c.offloadKind }),
              decorate: (payload) => c.decorate(payload),
            })),
        project: () => kernel.project.current(),
        // 版本以**当前仍活着的那个 model** 为准：标签关了 / model 换了 → undefined
        // ⇒ 在途结果一律丢弃（陈旧防护与"别给已关闭文件发问题"同一把尺子）
        versionOf: (path) => {
          const model = entriesRef.current.get(path)?.model;
          return model && !model.isDisposed() ? model.getVersionId() : undefined;
        },
        publish: (path, decorations) => {
          const model = entriesRef.current.get(path)?.model;
          if (!model || model.isDisposed()) return; // 发布时标签已关：什么都不做
          monaco.editor.setModelMarkers(model, MARKER_OWNER, decorationsToMarkers(monaco, model, decorations));
          // 同一份 decorations 发布到问题面板：两层波浪线（结构 error / 表达式 warning）在此汇总成可展开列表
          setProblems(
            path,
            decorations.map((d) => ({
              path,
              line: d.line,
              severity: d.severity,
              message: d.message,
              ...(d.code ? { code: d.code } : {}),
            })),
          );
        },
        record: (name, ms, note) => perf.record(name, ms, note),
      }),
    [kernel],
  );

  const refreshMarkers = useCallback(
    (model: Monaco.editor.ITextModel, path: string) => {
      if (model.isDisposed()) return;
      markerRunner.refresh(path, () => (model.isDisposed() ? '' : model.getValue()));
    },
    [markerRunner],
  );

  // ref 化刷新函数，供只注册一次的 Monaco 回调取用最新闭包
  useEffect(() => {
    refreshMarkersRef.current = refreshMarkers;
  }, [refreshMarkers]);

  // 文件路径 / 打开列表 ref 同步（只注册一次的 Monaco 回调读它们）
  useEffect(() => {
    filePathRef.current = filePath;
  }, [filePath]);
  useEffect(() => {
    openPathsRef.current = openPaths;
  }, [openPaths]);

  // 重授权/脏上报 ref 同步（同上；写权限判定已改为按文件 kernel.io.isWritable）
  useEffect(() => {
    onReauthRef.current = onReauth;
    onDirtyChangeRef.current = onDirtyChange;
    onStatusInfoRef.current = onStatusInfo;
  }, [onReauth, onDirtyChange, onStatusInfo]);
  // 保存告警镜像（A6 护栏读它：定时器闭包拿不到 state 最新值）
  useEffect(() => {
    pendingChoiceRef.current = pendingChoice;
  }, [pendingChoice]);

  /** 编辑停顿后重算装饰（去抖；换文件时立即算，见文件加载 effect） */
  const scheduleMarkers = useCallback(() => {
    if (markerTimerRef.current !== null) window.clearTimeout(markerTimerRef.current);
    markerTimerRef.current = window.setTimeout(() => {
      markerTimerRef.current = null;
      // 糖视图下 `currentFileModel()` 返回真 model：波浪线**仍发布到 `entry.model`**（它此刻
      // 没上屏，自然不可见），而不是那份只读糖 model——糖是派生物，没有可诊断的语义。
      const model = currentFileModel();
      const path = filePathRef.current;
      if (model && path && refreshMarkersRef.current) refreshMarkersRef.current(model, path);
    }, MARKER_DEBOUNCE_MS);
  }, [currentFileModel]);

  /* ------------------------ 糖视图（整文件显示为糖） ------------------------ */

  /**
   * 清空糖视图：把编辑器换回**真 model** 并 dispose 那份只读糖 model。
   * 换文件 / 关开关 / 卸载 / 解锁都走它（"换上"必须是可逆的，且不留内存泄漏）。
   */
  const clearSugarView = useCallback(() => {
    const ed = editorRef.current;
    const sugarModel = sugarModelRef.current;
    if (ed && sugarModel) {
      if (ed.getModel() === sugarModel) {
        // 还挂在编辑器上：换回真 model。优先按**当前文件路径**取回原文 model，取不到再退回
        // "挂糖前记住的那份"——两者都没有时宁可保留挂载也不 dispose（dispose 正在显示的
        // model 会让编辑器白屏）。
        const restore =
          entriesRef.current.get(filePathRef.current)?.model ?? sugarOriginalModelRef.current;
        if (restore && !restore.isDisposed()) {
          ed.setModel(restore);
          // 按当前文件重算 readOnly（解锁 / 直连 / 工作区口径与切换标签 effect 一致）
          const path = filePathRef.current;
          const canEdit = unlockedPathsRef.current.has(path) || directEditable(path);
          ed.updateOptions({ readOnly: erbReadOnlyGate(path, { inWorkspace: inWorkspace(path), canEdit }) });
          sugarModel.dispose();
        } else {
          return; // 无处可还原：保留挂载、不 dispose，至少不白屏
        }
      } else {
        // 糖 model 已不在编辑器上（被别的 setModel 顶掉）：直接回收
        sugarModel.dispose();
      }
    }
    sugarModelRef.current = null;
    sugarOriginalModelRef.current = null;
    setSugarStats(null);
    // C1 反向下行批：糖视图撤下 = derivedView 翻转（true→false），立刻透出给面板
    publishCursor();
  }, [kernel, publishCursor]);

  /**
   * 生成糖视图：整份文件投影成糖文本 → 建一份**只读内存 model** → `ed.setModel()` 换上。
   *
   * 为什么换成 model 而不是自绘 ViewZone：Monaco 用自己的行渲染（原生字号 / 行高 / 折行 /
   * 缩进 / 行号槽），糖文本与原文**逐行对齐、无法区分**，且天然支持滚动 / 搜索 / 复制。
   * 磁盘文件绝不被改：换上的是一份 `inmemory://` scheme 的临时 model。
   *
   * 整文件模式刻意**不打字机**：打字机是"逐条预览"的仪式感（一次一段），整文件有
   * 几十上百段，逐字动画会变成等待。这里的体感目标只有一个字：快。
   */
  const applySugarView = useCallback(() => {
    const ed = editorRef.current;
    const path = filePathRef.current;
    const entry = entriesRef.current.get(path);
    clearSugarView(); // 先把上一次的糖 model 撤下（幂等）
    if (!ed || !entry) return;
    // C2：糖视图让位 / 撤下的这一拍，编辑器真理回到原文缓冲——立即补发一条。
    // 这是"切文件/加载完成即有真相"与"切回原码后补一发"的共同落点（本函数被开关
    // 切换 / 解锁 / 直连 / 换文件全部入口调用）；糖视图正要挂上时同样发的是**原文**
    // 真相（派生文本永不外发，挂载后由 broadcaster 的抑制谓词兜住）。
    documentBroadcaster.flush(path, () => readDocumentTruth(path));
    // 可用门（ADR-0005）：只对**游戏目录里、本次未解锁**的 ERB 生效。
    // `.kojo` 与**工作区内 ERB**（作者自己的创作源文件，恒可编辑）都不放预览——
    // 预览靠"整份文件换成只读 model"工作，可编辑的原文必须始终看得见。
    if (
      !sugarViewRef.current ||
      !sugarViewAllowed({
        isErbLike: isErbLike(path),
        inWorkspace: inWorkspace(path),
        // 直连可编辑 ⟹ 预览让位（与 unlocks 同口径，ADR-0005 互斥）
        unlocked: unlockedPathsRef.current.has(path) || directEditable(path),
      })
    )
      return;

    const model = entry.model;
    const text = model.getValue();
    const project = kernel.project.current();
    const maxLine = model.getLineCount();

    // 段清点：单个贡献抛错不影响其余（与装饰器 / codeAction 同款隔离）
    const segments: Array<{ fromLine: number; toLine: number; sugarText: string }> = [];
    for (const contribution of kernel.slots.query('ui.editor.liftPreview')) {
      const provide = contribution.provideLiftProject;
      if (typeof provide !== 'function') continue;
      try {
        for (const item of provide.call(contribution, { path, text, project })) {
          const { fromLine, toLine } = clampRange(item.fromLine, item.toLine, maxLine);
          // 段首尾的空行不进糖文本（否则糖块开头是一大块空白，见 `trimSegmentBlanks`）
          segments.push({ fromLine, toLine, sugarText: trimSegmentBlanks(item.sugarText) });
        }
      } catch (e: unknown) {
        // 能力出错要"退化可见"：记录后继续，糖视图少一段好过整份消失
        console.warn(
          `[EditorPane] liftPreview '${contribution.id}' provideLiftProject 抛错：${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    if (segments.length === 0) return; // 无段可铺：保持原文（clear 已在函数开头做过）

    // 取原文逐行内容，拼装整份糖文本（纯函数，口径单测钉死在 sugar-view.test.ts）
    const originalLines: string[] = [];
    for (let i = 1; i <= maxLine; i++) originalLines.push(model.getLineContent(i));
    const doc = composeSugarDoc(originalLines, segments);

    let sugarLines = 0;
    for (const seg of segments) sugarLines += seg.sugarText.split('\n').length;

    // 只读内存 model：`inmemory://` scheme（**非** `file:`，避免与真文件 model 冲突被复用）。
    // URI 按组隔离（SPLIT-1）：同文件可在两组同时开糖视图——同 URI 的 createModel 会撞车。
    // 换文件 / 关开关时由 clearSugarView dispose。
    const sugarModel = monaco.editor.createModel(
      doc,
      KOJO_LANGUAGE_ID,
      monaco.Uri.parse(`inmemory://sugar/${encodeURIComponent(groupId)}/${encodeURIComponent(path)}`),
    );
    sugarModelRef.current = sugarModel;
    sugarOriginalModelRef.current = model;
    ed.updateOptions({ readOnly: true }); // 糖是派生物，禁止在糖视图上编辑
    ed.setModel(sugarModel);
    setSugarStats(sugarSummary(sugarLines, 0));
    // C1 反向下行批：糖视图挂上 = derivedView 翻转（false→true），立刻透出给面板
    publishCursor();
  }, [kernel, clearSugarView, documentBroadcaster, readDocumentTruth, publishCursor]);

  // 开关变化：记住偏好（下次启动仍是你的选择）+ 就地重算视图
  useEffect(() => {
    sugarViewRef.current = sugarView;
    saveSugarViewPref(sugarView);
    applySugarView();
  }, [sugarView, applySugarView]);

  // 直连模式开关切换：重算当前文件的可编辑态（readOnly），并让糖视图让位/恢复
  useEffect(() => {
    const ed = editorRef.current;
    const p = filePathRef.current;
    if (!ed || !p) return;
    const canEdit = unlockedPathsRef.current.has(p) || directEditable(p);
    ed.updateOptions({ readOnly: erbReadOnlyGate(p, { inWorkspace: inWorkspace(p), canEdit }) });
    applySugarView();
  }, [directMode, kernel, applySugarView]);

  // 糖视图开关意图 → 宿主落地（插件发意图、宿主渲染；与 editor.liftPreview.show 同款）
  useEffect(() => {
    return kernel.bus.on('editor.sugarView.set', (p) => {
      if (p.filePath && p.filePath !== filePathRef.current) return;
      // 省略 `on` = 反转：状态所有者是宿主，请求方不必先问"现在是开还是关"
      setSugarView((v) => p.on ?? !v);
    });
  }, [kernel]);

  // 记录最新定位请求（同一文件重复定位靠 nonce 变化触发）
  useEffect(() => {
    revealRef.current = revealLine
      ? { line: revealLine, ...(revealColumn !== undefined ? { column: revealColumn } : {}), nonce: revealNonce ?? 0 }
      : null;
    applyReveal();
  }, [revealLine, revealColumn, revealNonce, filePath, applyReveal]);

  /** 保存成功：把该文件 model 的当前版本号立为新基线 */
  const markSaved = useCallback(
    (path: string, entry: ModelEntry) => {
      editorModelPool.setBaseline(path, entry.model.getAlternativeVersionId());
      onDirtyChangeRef.current?.(path, false);
      if (filePathRef.current === path) setDirty(false);
      // 落盘成功 = 外部冲突已被用户表达处置、连败计数销账（A6 护栏与"只报一次"的复位点）
      externalConflictRef.current.delete(path);
      autosaveFailedRef.current.delete(path);
    },
    [],
  );

  /**
   * 保存指定文件（活动标签与后台标签同一条路径；A10 起返回逐文件结果）：
   * - **per-path 互斥**（`sharedSaveLock`）：同文件连点只写一次（第二次记 skipped-busy，
   *   不排队重复落盘）；不同文件互不阻塞——全局锁的旧语义退役；
   * - 先就近征询**保存接管者**（槽 `ui.editor.saveHandler`）：命中（如 `.kojo`）
   *   则由接管者完成"保存源 + 编译产物"，宿主只消费其 `outcome`；
   * - 未命中 → 缺省路径：内核 io `writeText`（保编码保换行，受写白名单约束）；
   * - `needs-choice`（全角空格告警）→ 活动标签弹确认框、**本次不落盘**；后台标签
   *   跳过并计入回执（`quiet` 模式逐条通知收进一条合成回执，跳过必须可见、不静默吞）。
   */
  const savePathDetailed = useCallback(
    async (path: string, choices?: EditorSaveChoices, quiet = false): Promise<SaveFileOutcome> => {
      const entry = entriesRef.current.get(path);
      if (!entry) return { path, status: 'failed', message: '标签已不在编辑器中' };
      saveRacedRef.current = false; // 每次保存尝试重记竞态（A6 失败守卫读这一位）
      return withPathLock(
        sharedSaveLock,
        path,
        async () => {
          const isActive = filePathRef.current === path;
          // P0 前置拦截：按文件实际可写性判定（工作区恒可写，不被项目授权状态误伤——
          // 双真相源：工作区 = 创作权威，游戏目录 = 部署目标）
          if (!kernel.io.isWritable(path)) {
            if (!quiet) {
              notify({
                kind: 'error',
                message: '保存被拒绝：项目当前为只读（写权限未批准或批准已失效）。',
                action: { label: '去授权', run: () => onReauthRef.current() },
              });
              // 用户已表达明确的写入意图 → 软件主动重弹授权对话框（实机反馈：让用户自己去
              // 发现并点击「重新授权」按钮 = 把软件的责任抛给用户，是设计错误）
              // quiet（全保存）下改由回执挂「去授权」action，一次弹窗不轰炸。
              onReauthRef.current();
            }
            if (isActive) setError('只读：写权限未批准');
            return { path, status: 'failed', message: '项目当前为只读', needsReauth: true };
          }
          const rawText = entry.model.getValue();
          // 保存前整理（E2）：跑 `Shift+Alt+F` 那一份纯函数（同一真源，不复制规则）。
          // 只改**内存文本**并让它落进 model，随后的保存链路一条不绕：写允许域已在上面判过、
          // 编码/行尾由内核 io 保、备份与原子写在 `writeText`/`compileToFile` 里。
          // 全角空格告警因此天然少弹一次：`planSave` 看的就是这份整理后的文本。
          // 糖视图下不重算预览（与 `reloadFromDisk` 同口径：派生视图随下一次切换刷新）。
          const prepared = applyFormatOnSave(
            rawText,
            dialectForLanguage(languageFor(path)),
            loadFormatOnSavePref(),
          );
          let text = rawText;
          if (prepared.changed) {
            // `pushEditOperations` 一次落地全部 edits ⇒ 落进撤销栈的是**一个**元素；
            // 用它而不是 `ed.executeEdits` 是因为后台标签的 model 不在编辑器上（全部保存途中）。
            entry.model.pushEditOperations([], toTextEdits(entry.model, prepared.edits), () => null);
            text = entry.model.getValue();
          }
          // A1 保存竞态守卫：文本定稿（保存前整理已落地）即快照版本号——写盘窗口内的
          // 新输入只进 model 不进盘，落盘回包后必须版本未变才允许 markSaved 立基线，
          // 否则保持脏并如实报失败（旧链路在 await 之后立基线，把没落盘的字节标成已保存）。
          const versionAtFinalize = entry.model.getAlternativeVersionId();
          const racedAfterWrite = (): SaveFileOutcome => {
            saveRacedRef.current = true; // 写成功了，只是保存窗口内又来了新输入——A6 不当失败报
            if (isActive) setStatus('已保存，但保存期间又有新输入——文件仍标记为未保存');
            else if (!quiet) notify({ kind: 'info', message: `「${path}」保存完成，但保存期间又有新输入——已保留未保存标记` });
            return { path, status: 'kept-dirty' };
          };
          try {
            const handler = pickSaveHandler(kernel, path);
            if (handler) {
              const outcome = await handler.save({
                path,
                text,
                project: kernel.project.current(),
                ...(choices ? { choices } : {}),
              });
              if (outcome.status === 'needs-choice') {
                if (isActive) {
                  setPendingChoice(outcome.warning); // 尚未落盘：由确认框决定
                  pendingChoiceRef.current = outcome.warning; // A6 护栏读同步镜像（effect 慢一帧，定时器等不起）
                } else if (!quiet) {
                  notify({
                    kind: 'info',
                    message: `「${path}」存在保存告警，全部保存时已跳过——切到该标签单独保存可处理。`,
                  });
                }
                return { path, status: 'skipped-choice' };
              }
              if (outcome.status === 'error') {
                if (isActive) setError(outcome.message);
                else if (!quiet) notify({ kind: 'error', message: `保存「${path}」失败：${outcome.message}` });
                return { path, status: 'failed', message: outcome.message };
              }
              if (classifySaveRace(versionAtFinalize, entry.model.getAlternativeVersionId()) !== 'unchanged') {
                return racedAfterWrite();
              }
              markSaved(path, entry);
              if (isActive) {
                setError(null);
                setStatus(outcome.note ? `${outcome.message} · ${outcome.note}` : outcome.message);
              }
              return { path, status: 'saved' };
            }
            // 缺省保存（无接管者 / 提供者未激活 → 优雅降级）
            await kernel.io.writeText(path, text);
            if (classifySaveRace(versionAtFinalize, entry.model.getAlternativeVersionId()) !== 'unchanged') {
              return racedAfterWrite();
            }
            markSaved(path, entry);
            if (isActive) {
              setError(null);
              setStatus(`已保存 ${new Date().toLocaleTimeString()}`);
            }
            return { path, status: 'saved' };
          } catch (e: unknown) {
            // 竞态兜底（批准在保存途中被收回等）：WriteNotAllowedError → 中文人话 + 去授权
            if (e instanceof WriteNotAllowedError) {
              if (!quiet) {
                notify({
                  kind: 'error',
                  message: '保存被拒绝：写入路径不在已批准范围内。',
                  action: { label: '去授权', run: () => onReauthRef.current() },
                });
                onReauthRef.current();
              }
              if (isActive) setError('只读：写权限未批准');
              return { path, status: 'failed', message: '写入路径不在已批准范围内', needsReauth: true };
            }
            const msg = e instanceof Error ? e.message : String(e);
            if (isActive) setError(msg);
            else if (!quiet) notify({ kind: 'error', message: `保存「${path}」失败：${msg}` });
            return { path, status: 'failed', message: msg };
          }
        },
        // 同文件在途（连点 / 跨组分屏并发）：拒绝第二次，绝不排队重复写盘
        (): SaveFileOutcome => ({ path, status: 'skipped-busy' }),
      );
    },
    [kernel, markSaved, notify],
  );

  /** 保存指定标签（对外保持布尔语义：非 saved 一律 false，与旧调用方零改动） */
  const savePath = useCallback(
    async (path: string, choices?: EditorSaveChoices): Promise<boolean> =>
      (await savePathDetailed(path, choices)).status === 'saved',
    [savePathDetailed],
  );

  /** 保存当前活动标签（Ctrl+S / 工具栏按钮） */
  const save = useCallback(
    async (choices?: EditorSaveChoices): Promise<boolean> => {
      const path = filePathRef.current;
      if (!path) return false;
      return savePath(path, choices);
    },
    [savePath],
  );

  /**
   * 全部保存（A10）：并发池（≤ `SAVE_MAX_CONCURRENCY` 路，防 IPC 洪泛）逐文件走
   * 保存链——不同文件并发写、同文件被 per-path 锁挡成 skipped-busy（不排队重复写）。
   * 成功/失败/跳过逐文件收集成**一条**回执通知（失败不轰炸、needs-choice 跳过必须
   * 可见）；全部 saved 才返回 true（成功的不回滚）。
   */
  const saveAll = useCallback(async (): Promise<boolean> => {
    const targets = openPathsRef.current.filter((p) => computeDirty(p));
    if (targets.length === 0) return true;
    const { ok, receipt } = await runSaveBatch(targets, (p) => savePathDetailed(p, undefined, true));
    if (receipt) {
      notify({
        kind: receipt.kind,
        message: receipt.message,
        // 写允许域拒绝合并进回执后，「去授权」入口跟着这条唯一的通知走
        ...(receipt.needsReauth ? { action: { label: '去授权', run: () => onReauthRef.current() } } : {}),
      });
    }
    return ok;
  }, [computeDirty, savePathDetailed, notify]);

  /**
   * 以磁盘最新内容重载某个打开中的 model（2026-10-12 审阅补丁，修 B1）。
   *
   * 触发源：内核事件 `file.changed`（谁改盘谁发）——当前主要来自 💡 升糖
   * （`sugar.liftApply`）。若宿主不重载，用户随后 `Ctrl+S` 会用**旧文本覆盖**
   * 磁盘上的新内容（真实数据丢失）。
   *
   * 决策纯函数 `decideExternalChange`（noop / reload / conflict）：
   * - `noop`（磁盘 == model，多为自身保存回声）→ 不动（不重置撤销栈/光标）；
   * - `reload`（磁盘变了、model 干净）→ 静默替换并立为新基线，保留视图状态；
   * - `conflict`（磁盘变了、model 脏）→ **绝不静默覆盖**：弹常驻通知说明
   *   「保存将覆盖磁盘内容」，用户可点「重新加载（放弃我的修改）」。
   */
  const reloadFromDisk = useCallback(
    async (path: string): Promise<void> => {
      const entry = entriesRef.current.get(path);
      if (!entry) return; // 该文件未打开 → 与编辑器无关
      let text: string;
      try {
        ({ text } = await kernel.io.readText(path));
      } catch (e: unknown) {
        notify({
          kind: 'error',
          message: `重新加载「${path}」失败：${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }
      // 读盘期间 model 可能已被关闭/替换（标签关闭竞态）→ 放弃
      if (entriesRef.current.get(path) !== entry) return;
      const decision = decideExternalChange(entry.model.getValue(), text, computeDirty(path));
      if (decision === 'noop') return;
      const applyReload = (): void => {
        // 常驻通知的 action 闭包可能晚于标签关闭才被点击——闭包只持 path+text，
        // 落地前现取 entry；缺失或 model 已 dispose（Monaco 标准 API）直接放弃，
        // 绝不对 disposed model setValue 炸异常（深审 A3）。
        const live = entriesRef.current.get(path);
        if (!live || live.model.isDisposed()) return;
        externalConflictRef.current.delete(path); // 用户已处置（放弃我的修改）：A6 护栏放行
        const ed = editorRef.current;
        const isActive = filePathRef.current === path;
        const vs = isActive && ed ? ed.saveViewState() : null;
        reloadingRef.current = true;
        try {
          live.model.setValue(text);
        } finally {
          reloadingRef.current = false;
        }
        const version = live.model.getAlternativeVersionId();
        editorModelPool.setBaseline(path, version);
        onDirtyChangeRef.current?.(path, false);
        if (isActive && ed && vs) ed.restoreViewState(vs);
        if (refreshMarkersRef.current) refreshMarkersRef.current(live.model, path);
        // C2：外部改动重载 / 冲突解决后立即补发新真相（活动文件才发；面板不该吃到
        // 旧盘文本的残影。后台标签切回来时会经 applySugarView 补发）
        if (isActive) documentBroadcaster.flush(path, () => readDocumentTruth(path));
        if (isActive) {
          setDirty(false);
          setStatus('已从磁盘重新加载（文件在外部被修改）');
          pushSelStatus(true);
        }
      };
      if (decision === 'reload') {
        applyReload();
        return;
      }
      // conflict：外部改动未决期间自动保存必须让路（A6 护栏；处置点 = applyReload / 保存成功 / 关标签）
      externalConflictRef.current.add(path);
      notify({
        kind: 'error',
        message: `「${path}」已在磁盘上被修改，但你有未保存的修改——保存会覆盖磁盘内容。`,
        action: { label: '重新加载（放弃我的修改）', run: applyReload },
      });
    },
    [kernel, notify, computeDirty, documentBroadcaster, readDocumentTruth],
  );

  // 外部写盘 → 重载对应 model（B1 修复）：宿主只**消费** `file.changed`，不认识"升糖"
  //
  // BUG-5 补全（§5.46 记录的已知缺口"add/unlink 不处理"）：
  // - `add` 同样触发重载——外部工具用「删除 + 重建」的方式保存时，去抖窗末态就是 add，
  //   只认 change 会让已打开的 model 停在旧内容上（读者以为"自动重载坏了"）；
  // - `unlink` 不动 model（关标签/清内容都是替用户做决定），但**必须说**：
  //   盘上没了而编辑器还在，是"保存会凭空造回这个文件"的口径问题，不能静默。
  //
  // HK-7（2026-10-13）：事件里的路径是**平台原样**，而 entriesRef 的键是宿主自己的
  // `filePath` —— 裸字符串判等一旦对不上，这条防数据丢失的链路就**静默失效**（没有任何
  // 症状，作者随后 Ctrl+S 覆盖掉外部改动而已）。所以先按 `pathKey()` 找回宿主用的那个键，
  // 之后一律用找回的键：消息里报的也是作者标签上看到的那条路径。
  useEffect(() => {
    const un = kernel.bus.on('file.changed', (ev) => {
      const opened = matchOpenedPath(entriesRef.current.keys(), ev.path);
      if (opened === null) return; // 没打开 → 与编辑器无关
      if (ev.kind === 'unlink') {
        notify({
          kind: 'error',
          message: `「${opened}」已在磁盘上被删除。编辑器里的内容现在是唯一副本——保存会重新创建该文件。`,
        });
        return;
      }
      void reloadFromDisk(opened);
    });
    return un;
  }, [kernel, reloadFromDisk, notify]);

  /**
   * 保存告警的处置（确认框回调）：
   * - `cancel`：放弃本次保存（脏标记保留）；
   * - `save-anyway`：带确认重存（不再追问）；
   * - `fix-and-save`：把编辑器里的 `U+3000` 替换为半角空格（可撤销的编辑）后重存。
   */
  const decideSaveWarning = useCallback(
    (action: 'cancel' | 'save-anyway' | 'fix-and-save') => {
      setPendingChoice(null);
      if (action === 'cancel') return;
      if (action === 'save-anyway') {
        void save({ acknowledgeFullwidthSpace: true });
        return;
      }
      const ed = editorRef.current;
      // 糖视图下不修：`ed.getModel()` 是只读糖 model，改它改的不是真文件（保存走 entry.model）。
      const model = sugarModelRef.current ? null : ed?.getModel();
      if (ed && model) {
        const fixed = model.getValue().split(FULLWIDTH_SPACE).join(' ');
        ed.executeEdits('kojo-fix-fullwidth', [{ range: model.getFullModelRange(), text: fixed }]);
        ed.pushUndoStop();
      }
      void save();
    },
    [save],
  );

  // 动作句柄注册（宿主标签流程：保存并关闭 / 全部保存）
  useEffect(() => {
    registerActions?.({ save: () => save(), savePath: (p) => savePath(p), saveAll, snapshots });
    return () => registerActions?.(null);
  }, [save, savePath, saveAll, snapshots, registerActions]);

  // 卸载时清空状态栏编辑器信息
  useEffect(() => () => onStatusInfo?.(null), [onStatusInfo]);

  // Ctrl+S 回调经 ref 读最新 save（编辑器只创建一次，save 闭包随 kernel 更新）
  const saveRef = useRef(save);
  saveRef.current = save;

  /* ------------------------ 自动保存（A6；写盘只走上面那一条 save，绝不抄第二条路） ------------------------ */

  /**
   * 闲置到点的一次尝试：现场读数进 `decideAutosave`（护栏判据是纯函数，单测钉死），
   * 放行才调 `saveRef.current()`——同一全局互斥、同一写允许域闸门、同一竞态守卫。
   * 失败如实进通知队列，但同一文件连败只报一次（销账点 = 保存成功 / 关标签）。
   */
  const runAutosave = useCallback(
    async (path: string): Promise<void> => {
      // 只管活动标签；per-path 锁被手动保存在途占住 = 这一拍放弃（下一次输入会重新计时）
      if (path !== filePathRef.current || sharedSaveLock.isBusy(path)) return;
      const entry = entriesRef.current.get(path);
      if (!entry || entry.model.isDisposed()) return;
      const decision = decideAutosave({
        mode: loadAutosavePref(),
        dirty: computeDirty(path),
        saving: false,
        saveWarningPending: pendingChoiceRef.current !== null,
        externalChangePending: externalConflictRef.current.has(path),
        sugarView: sugarModelRef.current !== null,
        writable: kernel.io.isWritable(path),
      });
      if (decision !== 'run') return;
      if (await saveRef.current()) {
        const live = entriesRef.current.get(path);
        if (live) {
          // 状态栏轻指示：复用 onStatusInfo 同一条上报链路，不新开协议
          onStatusInfoRef.current?.({
            encoding: live.encoding,
            eol: live.eol,
            lines: live.model.getLineCount(),
            autosavedAt: Date.now(),
          });
        }
        return;
      }
      // false 的三种含义只有"真失败"该进通知队列：needs-choice 已弹框待决（pendingChoiceRef）、
      // 竞态保脏已自行说话（saveRacedRef）——都不许再叠一条"自动保存未成功"惊扰作者。
      if (pendingChoiceRef.current !== null || saveRacedRef.current) return;
      if (!autosaveFailedRef.current.has(path)) {
        autosaveFailedRef.current.add(path);
        notify({
          kind: 'error',
          message: `自动保存「${path}」未成功——内容仍标记未保存；原因见编辑器工具条的红色提示，手动 Ctrl+S 同样可处理。`,
        });
      }
    },
    [computeDirty, kernel, notify],
  );

  /** 闲置去抖：最后一次输入重起计时；关着开关就不挂定时器（零成本）。**恒稳引用**——model 监听只注册一次，靠 ref 读最新 tick（与 saveRef 同款纪律） */
  const runAutosaveRef = useRef(runAutosave);
  runAutosaveRef.current = runAutosave;
  const scheduleAutosave = useCallback((): void => {
    if (loadAutosavePref() !== 'afterDelay') return;
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
    const path = filePathRef.current;
    if (!path) return;
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void runAutosaveRef.current(path);
    }, AUTOSAVE_IDLE_MS);
  }, []);

  /* ---------------- 视图状态跨会话持久化（view-state-store，落盘防抖在 store 内） ---------------- */

  /** 快照当前编辑器（选区 + 滚动读数）→ 持久层。糖视图不落盘：糖的行号不属于真文件 */
  const persistEditorSlice = (ed: Monaco.editor.IStandaloneCodeEditor, path: string): void => {
    if (sugarModelRef.current) return;
    const root = kernel.project.current()?.rootDir;
    if (!root) return;
    const slice = extractViewSlice(ed.saveViewState(), ed.getScrollTop(), ed.getScrollLeft());
    if (slice) setViewState(root, path, slice);
  };
  /** 活动标签的即时快照（光标/滚动事件驱动；store 防抖合并落盘） */
  const snapshotActiveView = (): void => {
    const ed = editorRef.current;
    const path = filePathRef.current;
    if (ed && path) persistEditorSlice(ed, path);
  };

  /** 从持久层恢复：行列钳进当前 model（文件可能变短）；滚动越界由 monaco 内部钳制，不抛 */
  const applyPersistedView = (
    ed: Monaco.editor.IStandaloneCodeEditor,
    model: Monaco.editor.ITextModel,
    path: string,
  ): void => {
    const root = kernel.project.current()?.rootDir;
    if (!root) return;
    const slice = getViewState(root, path);
    if (!slice) return;
    const clamped = clampSlice(slice, model.getLineCount(), (l) => model.getLineMaxColumn(l));
    try {
      // Selection 构造自带归一化（钳制后 start 可能越过 end，交换由 monaco 处理）
      ed.setSelections(
        clamped.selections.map((r) => new monaco.Selection(r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn)),
      );
      ed.setScrollPosition({ scrollTop: clamped.scrollTop, scrollLeft: clamped.scrollLeft });
    } catch {
      // 出错退化 = 这次不恢复：视图状态是易失偏好，绝不反绑打开流程
    }
  };

  // 编辑器实例（仅一次）；卸载时 dispose 全部 model
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // 缩放在实例创建**之前**播种：EditorZoom 是全局单例，创建时算 fontInfo 就按它缩放
    applyFontZoomPref(monaco.editor.EditorZoom);
    const ed = monaco.editor.create(host, {
      theme: 'kojo-dark',
      language: ERB_LANGUAGE_ID,
      automaticLayout: true,
      // 缩略图：文本块模式（不逐字符渲染——口上文本为长行文，色块更干净也更省性能）
      minimap: { enabled: true, renderCharacters: false, maxColumn: 72 },
      fontSize: loadFontSizePref(),
      lineNumbers: 'on',
      renderWhitespace: 'none',
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      // 中文块回车的精确缩进层（ZH-D4）：`onEnterRules` 的正则只看得到原文，块头行尾带 `;`
      // 注释这类同步层判不了的形态靠 on-type provider 兜；Monaco 只在 `formatOnType` 为真时派发它。
      formatOnType: true,
      // 行上内联注解（B8）：**创建时就按默认关**——Monaco 这条选项的缺省是 `true`
      // （`common/config/editorOptions.js` 的 `EditorBooleanOption(23, 'codeLens', true)`），
      // 只靠下面那个偏好 effect 事后覆盖，等于让"默认关"依赖一次 effect 的时序；
      // 真值仍只有一处（`CODE_LENS_DEFAULT`），这里不另写 `false`。
      codeLens: CODE_LENS_DEFAULT,
      // 编辑器体感（ui-polish）：平滑滚动 / 平滑光标 / 整行高亮 / 上下留白
      smoothScrolling: true,
      cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'all',
      padding: { top: 6, bottom: 16 },
      scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12 },
      // 中文打字噪声 / 选词基线（A2+A3）：与切文件降级集同源（editor-options.ts）
      ...CJK_TYPING_BASELINE,
      // find 体验基线（A7）：create 与切文件两条路径都要带上，吞一条就是档位漂移
      ...FIND_BASELINE,
    });
    editorRef.current = ed;
    if (!bootEditorMarked) {
      bootEditorMarked = true;
      perf.bootMark('boot.editorInteractive', undefined, '自导航起点 ms；Monaco 实例创建完成（近似：已挂载可输入）');
    }
    // SPLIT-1：本实例登记进模块注册表——全局 provider 只注册一份（ensureGlobalProviders
    // 内部有门），各 provider 的 resolve 经 `owningPaneOf(model)` 找归属实例再读它的 ref。
    const paneId = `pane-${++paneSeq}`;
    livePanes.set(paneId, {
      paneId,
      editorRef,
      entriesRef,
      filePathRef,
      sugarModelRef,
      pendingActionsRef,
      actionSeqRef,
      crumbTreeCacheRef,
    });
    if (focusedPaneId === null) focusedPaneId = paneId; // 首个实例即焦点（与宿主初始焦点组同源）
    globalKernel = kernel; // 单 kernel 应用：全局 provider 的 kernel 来源随最新实例刷新
    ensureGlobalProviders();
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveRef.current();
    });
    // A7「在选定内容中查找」：选中即把文本灌进 find widget 并把搜索域钉在选区。
    // 实测（vendor 取证）：action `editor.actions.findWithArgs` 由 findController 的
    // `StartFindWithArgsAction` 注册（standalone 包含），args 形态
    // `{ searchString, findInSelection, ... }`，`findInSelection: true` 走 `updateSearchScope`
    // 把当前非空选区变 searchScope。键位 Ctrl+Alt+F：核过 keybindings.ts 无占用
    // （Ctrl+Shift+F 是全库检索、Ctrl+F/Ctrl+H 是 Monaco 内建，均避让）。
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => {
      const model = ed.getModel();
      const selection = ed.getSelection();
      if (!model || !selection || selection.isEmpty()) return;
      const action = ed.getAction('editor.actions.findWithArgs');
      if (!action) return;
      void action.run({ searchString: model.getValueInRange(selection), findInSelection: true });
    });
    // 偏好落盘只在设置页，生效走 Monaco 配置项：开 ⇒ 逐 model 挂上着色器，关 ⇒ 卸掉，
    // 不用重开文件（standalone 的 DocumentSemanticTokensFeature 自己监听这条配置）。
    applyNameColorPref(ed);
    const nameColorUnsub = subscribeNameColorPref(() => applyNameColorPref(ed));
    // 字号/缩放偏好（A1）：设置页一改立即生效；反向（Monaco 原生 fontZoom 动作改了
    // EditorZoom 单例）也落盘，两条方向都收敛到 localStorage 这一份真源。
    const fontSizeUnsub = subscribeFontSizePref(() => {
      applyFontSizePref(ed);
      applyFontZoomPref(monaco.editor.EditorZoom);
    });
    const fontZoomSync = monaco.editor.EditorZoom.onDidChangeZoomLevel((level) => setFontZoomPref(level));
    // 焦点上抛（SPLIT-1）：编辑器聚焦 ⇒ 宿主把焦点组切到本组（点哪组哪组成为焦点组）
    const focusDisposer = ed.onDidFocusEditorText(() => {
      focusedPaneId = paneId; // 模块级焦点随编辑器焦点走（跳转探针读"最后聚焦的实例"）
      onFocusedRef.current?.();
    });
    // 面包屑（D1，宿主自绘——standalone Monaco 无面包屑 API，取证见 `breadcrumb-path.ts`）。
    // 数据复用大纲那棵树：`collectDocumentSymbols` 的应答判据与 provider 接线逐字同款
    // （糖视图只读 model 一律不给——行号属派生物，面包屑不许把作者导到不存在的位置）。
    // 树按 path+版本号缓存，重算本身再按"换行才算一次"闸住（`crumbsNeedRefresh`）：
    // 光标监听没有防抖，不闸就是每敲一键全文解析一次。
    crumbRefreshRef.current = () => {
      const ed = editorRef.current;
      const path = filePathRef.current;
      const model = ed?.getModel() ?? null;
      const apply = (next: readonly CrumbItem[]): void => {
        const key = crumbsKey(next);
        if (key === crumbsKeyRef.current) return;
        crumbsKeyRef.current = key;
        setCrumbs(next);
      };
      if (!ed || !path || sugarModelRef.current || !model) {
        crumbLastRef.current = null;
        apply([]);
        return;
      }
      const cursor: CrumbCursor = { path, line: ed.getPosition()?.lineNumber ?? 1, lineCount: model.getLineCount() };
      if (!crumbsNeedRefresh(cursor, crumbLastRef.current)) return;
      crumbLastRef.current = cursor;
      try {
        const versionId = model.getAlternativeVersionId();
        const cache = crumbTreeCacheRef.current;
        let symbols: EditorDocumentSymbol[];
        if (cache && cache.path === path && cache.versionId === versionId) symbols = cache.symbols;
        else {
          symbols = collectDocumentSymbols(kernel.slots.query('ui.editor.languageService'), {
            kind: 'documentSymbol',
            path,
            text: model.getValue(),
            project: kernel.project.current(),
            lineCount: model.getLineCount(),
          });
          crumbTreeCacheRef.current = { path, versionId, symbols };
        }
        apply(toCrumbs(symbolChainAt(symbols, cursor.line)));
      } catch (e: unknown) {
        // 面包屑是只读呈现面：出错就"没链"，绝不把光标处理链带崩
        console.warn(`[breadcrumb] 刷新抛错：${e instanceof Error ? e.message : String(e)}`);
        apply([]);
      }
    };
    // A9 选区读数搭同一条光标监听：不新增高频监听，等值去抖在 pushSelStatus 内
    const crumbCursorSub = ed.onDidChangeCursorPosition(() => {
      crumbRefreshRef.current?.();
      pushSelStatus();
    });
    const crumbModelSub = ed.onDidChangeModel(() => {
      crumbRefreshRef.current?.();
      pushSelStatus();
    });
    // 视图状态：光标/滚动驱动快照（store 内防抖合并落盘）；页面卸载前 flush 一次
    const viewCurSub = ed.onDidChangeCursorPosition(snapshotActiveView);
    const viewScrSub = ed.onDidScrollChange(snapshotActiveView);
    // C1 反向下行批：光标位点广播（面板跟着光标走）。选区也要听——拖动选择区改变的是
    // 活动端（position），Monaco 两条事件都可能先到，重复的那次由广播器去重吞掉（零成本）。
    const cursorSub = ed.onDidChangeCursorPosition(() => publishCursor());
    const cursorSelSub = ed.onDidChangeCursorSelection(() => publishCursor());
    const flushViewOnUnload = (): void => flushViewStates();
    window.addEventListener('beforeunload', flushViewOnUnload);
    return () => {
      nameColorUnsub();
      fontSizeUnsub();
      fontZoomSync.dispose();
      focusDisposer.dispose();
      crumbCursorSub.dispose();
      crumbModelSub.dispose();
      viewCurSub.dispose();
      viewScrSub.dispose();
      cursorSub.dispose();
      cursorSelSub.dispose();
      window.removeEventListener('beforeunload', flushViewOnUnload);
      crumbRefreshRef.current = null;
      // SPLIT-1：本实例退册；全局 provider 属于"活实例集合"，最后一个实例退场才拆
      livePanes.delete(paneId);
      if (focusedPaneId === paneId) focusedPaneId = livePanes.keys().next().value ?? null;
      if (livePanes.size === 0) {
        disposeGlobalProviders();
        setJumpProbe(null);
        clearAllProblems(); // 清掉全部文件的问题，防幽灵诊断残留
      }
      clearSugarView();
      // 兜底：糖 model 若因"无处可还原"被保留挂载，随卸载一并回收（编辑器即将 dispose）
      sugarModelRef.current?.dispose();
      sugarModelRef.current = null;
      sugarOriginalModelRef.current = null;
      if (markerTimerRef.current !== null) window.clearTimeout(markerTimerRef.current);
      markerTimerRef.current = null;
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
      externalConflictRef.current.clear();
      autosaveFailedRef.current.clear();
      // 卸载 = 会话终点：补一次最后快照（在途防抖窗口内的改动）再同步 flush
      if (prevPathRef.current) persistEditorSlice(ed, prevPathRef.current);
      flushViewStates();
      ed.dispose();
      editorRef.current = null;
      for (const [path, entry] of [...entriesRef.current]) {
        entry.listener.dispose();
        editorModelPool.release(path);
      }
      entriesRef.current.clear();
      viewStatesRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 「标注函数被谁调用」开关落地（B8，2026-10-16 行内注解批）。
   *
   * 偏好真源是 `code-lens-pref.ts` 的 localStorage（**默认关**，理由写在那份文件里），
   * 本 effect 只做一件事：把它写成 Monaco 的 `codeLens` 选项。
   * 这条腿必须在**选项**上而不是在 `resolve()` 里返回空数组——关掉时 Monaco 不再发请求，
   * 于是那份文档的整篇解析一次都不付（供给器没有可视区间，开着的代价是"每次停笔解析一遍"）。
   *
   * 翻开关为什么要听事件而不是自己再读一次偏好：Monaco 只在 `EditorOption.codeLens`
   * 变化时重算注解（取证 `codelensController.js` 的 `e.hasChanged(...) → _onModelChange()`），
   * 不推就是"作者关掉设置页回到编辑器，一条注解都没动"。壳层的设置页与本页读的都是同一把
   * localStorage，所以这里不存在两份状态——事件只是"去重算一次"的扳机（同 `editor.sugarView.set`）。
   */
  useEffect(() => {
    const apply = (on: boolean): void => {
      editorRef.current?.updateOptions({ codeLens: on });
    };
    apply(loadCodeLensPref());
    const un = kernel.bus.on('editor.codeLens.set', ({ on }) => apply(on));
    return un;
  }, [kernel]);

  // Monarch directive 词表同源化（T5）：adapter 指令表可用时，词表 = 基底 `ERB_DIRECTIVES`
  // ∪ `instructionTable.names()`（合并去重排序见 `mergeDirectiveWords` 纯函数）；表缺席 ⇒ 基底。
  // **项目切换不残留上一项目的词表**：`project.closed` / 卸载一律回基底（与 hover 的
  // "表随项目现取"同一纪律）；重设时 dispose 旧 provider（`setErbDirectiveWords` 内置）。
  useEffect(() => {
    // SPLIT-1：Monarch 词表是模块级资源（provider 全局一份），按实例数引用计数——
    // 首个实例挂上、最后一个实例退场才回基底；双实例时事件触发的第二次 apply
    // 被等值去重挡掉（不重复 dispose/重建 provider）。
    erbWordsUsers += 1;
    const applyForCurrentAdapter = (): void => {
      const names = editorTables(kernel).instructionTable?.names?.() ?? null;
      const key = names ? names.join('\u0000') : '';
      if (key === lastWordsKey) return;
      lastWordsKey = key;
      setErbDirectiveWords(monaco, names === null ? null : mergeDirectiveWords(ERB_DIRECTIVES, names));
    };
    applyForCurrentAdapter();
    const offOpened = kernel.bus.on('project.opened', () => applyForCurrentAdapter());
    const offClosed = kernel.bus.on('project.closed', () => applyForCurrentAdapter());
    return () => {
      offOpened();
      offClosed();
      erbWordsUsers -= 1;
      if (erbWordsUsers === 0) {
        setErbDirectiveWords(monaco, null);
        lastWordsKey = '__unset__';
      }
    };
  }, [kernel]);

  // 标签关闭 → model 池引用回收（不在 openPaths 中的一律释放；绝不泄漏）。
  // SPLIT-1：同文件可能仍被另一组引用——problems 清理与"报不脏"只在**最后一份**
  // 引用释放（模型真正 dispose）时做，否则一组关标签会端走另一组的波浪线/脏点。
  useEffect(() => {
    const keep = new Set(openPaths);
    for (const [path, entry] of [...entriesRef.current]) {
      if (keep.has(path)) continue;
      // 关闭的是活动标签：切换 effect 不会再为它存视图（条目即释放），此处补最后快照
      if (path === prevPathRef.current) {
        const closing = editorRef.current;
        if (closing && closing.getModel() === entry.model) persistEditorSlice(closing, path);
      }
      entry.listener.dispose();
      const left = editorModelPool.release(path);
      // 装饰缓存跟着本组标签走：新开的 model 版本号会从 1 重新数，留着旧条目就可能
      // 把"上一份 model 的同版本号"当成同一份内容发上屏（判据不成立就不许命中）。
      // 每组各丢各的缓存；共享 model 的另一组由它自己的 runner 继续供。
      markerRunner.dropPath(path);
      entriesRef.current.delete(path);
      viewStatesRef.current.delete(path);
      if (left === 0) {
        clearProblems(path); // 最后一份引用：同步清掉该文件在问题面板里的条目
        externalConflictRef.current.delete(path);
        autosaveFailedRef.current.delete(path);
        onDirtyChangeRef.current?.(path, false);
      }
    }
  }, [openPaths, markerRunner]);

  // 切换活动标签（model 复用；首次打开读盘建 model）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ed = editorRef.current;
      if (!ed) return;
      // 先把上一个标签的视图状态存下（光标/滚动原位恢复）
      const prev = prevPathRef.current;
      if (prev && prev !== filePath && entriesRef.current.has(prev)) {
        viewStatesRef.current.set(prev, ed.saveViewState());
        persistEditorSlice(ed, prev);
      }
      let entry = entriesRef.current.get(filePath);
      if (!entry) {
        // 探针：切文件一次性成本 = 读盘 + 建 model（+ 下方 apply 段）
        const stopRead = perf.start('switch.readText');
        try {
          // 崩溃恢复注入（退出/崩溃守护批）：该路径有恢复快照 → 不读盘，直接以快照
          // 内容建 model，基线版本号钉在 0（初始版本号从 1 起数，永不相等）⇒ model
          // 一生出来就是"未保存脏"。恢复**永不自动写游戏目录**：存不存由用户决定。
          // （SPLIT-1：model 经进程级池取——同文件另一组已开则直接共享同一份；
          //   恢复注入只在"全池首次打开"生效，快照语义本就是重启后第一次。）
          // **竞态修复（"app ate my work"批）**：快照只 **peek 不消费**——消费一律推迟到
          // 提交闸之后（!cancelled 且条目落进 entriesRef 且基线已由池钉住）。旧的"取即删"
          // 让快速切换（cancelled 生效）后的重跑拿到 null → 按读盘语义补基线 → 恢复内容
          // 被洗成"干净"：autosave 不存、退出无提示丢弃、外部 file.changed 直接覆盖。
          // 基线钉 0 由**池在建 model 的那一刻**落在记录上（fromRecovery），不依赖闭包里的
          // `recovered` 撑过 await。
          const recovered = peekRecoveredContent(filePath);
          const pooled = await editorModelPool.acquire(
            kernel,
            filePath,
            recovered
              ? { text: recovered.text, encoding: recovered.encoding, eol: recovered.eol }
              : undefined,
          );
          stopRead();
          if (cancelled) {
            // 引用计数对称回收：这次 acquire 不提交就必须 release（refcount-leak 修复——
            // 快速 Ctrl+P 每次竞态都会留下一份没人认领的 model/引用，整个会话不释放）。
            // 快照未消费（peek 语义），下一轮重跑照常能以恢复内容重建。
            editorModelPool.release(filePath);
            return;
          }
          const model = pooled.model;
          // 逐 model 脏监听（BUG-4：版本号 O(1) 比较；后台标签的编辑同样上报）；
          // 每组各挂各的监听（共享 model 的另一组由它自己的监听上报）
          const listener = model.onDidChangeContent(() => {
            // 探针（内核优化 L0）：击键路径应**恒 <1ms**（dirty 是 O(1)、装饰已去抖）；
            // 若 p95 超 1ms，说明 React 层或别处有未知同步开销。
            const t0 = performance.now();
            try {
              if (reloadingRef.current) return; // 磁盘重载非用户编辑：不报脏、不排装饰
              const d = computeDirty(filePath);
              onDirtyChangeRef.current?.(filePath, d);
              if (filePathRef.current === filePath) {
                setDirty(d);
                scheduleMarkers();
                // C2：活动文件缓冲变化 → 防抖广播"当前真相"（糖视图激活时广播器自行抑制；
                // 程序性整篇改写——fix-all / 重命名批量 / 保存前整理——同样走这条通道）
                documentBroadcaster.schedule(filePath, () => readDocumentTruth(filePath));
                if (d) scheduleAutosave(); // A6：脏了才起闲置计时（撤销回干净由 tick 的护栏判掉）
              }
            } finally {
              perf.record('input.handler', performance.now() - t0);
            }
          });
          entry = { model, listener, encoding: pooled.encoding, eol: pooled.eol };
          entriesRef.current.set(filePath, entry);
          // 已保存基线只在**本条目首次落进池记录**时按当前版本号落定；池里已有基线就不碰——
          // 恢复件的 0 钉（池建 model 时落的：内容本身就是"未保存"，撤销回快照原样脏标也不消失）
          // 与另一组未保存的保存点都属文件级真相，无条件重设等于"第二组一打开就把第一组的
          // 未保存内容洗成干净"（本批竞态的另一半成因）。
          if (editorModelPool.baseline(filePath) === undefined) {
            editorModelPool.setBaseline(filePath, model.getAlternativeVersionId());
          }
          // 提交成功（条目已入、基线已钉）⇒ 此刻才允许消费恢复快照；内容从此活在共享 model 里，
          // 由 autosave/用户保存接管后续。本轮没真用上快照（池里已是读盘 model）就**不消费**——
          // 留给下一次全池首开。
          if (recovered && pooled.fromRecovery) dropRecoveredContent(filePath);
        } catch (e: unknown) {
          stopRead(); // 幂等：读盘失败时补记一次采样（正常路径已记过则跳过）
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
          return;
        }
      }
      // 探针：apply 段 = setModel + 选项更新 + 视图恢复 + 装饰刷新（同步可测）
      const stopApply = perf.start('switch.apply');
      prevPathRef.current = filePath;
      // 糖视图把编辑器换成了只读糖 model，换文件前必须先撤下（换回上一个文件真 model 并
      // dispose 糖 model）——否则下一个文件的 `setModel` 会踩在一份派生物上。
      // 必须在 `setModel` **之前**调用。
      clearSugarView();
      // 两道**正交轴**（ADR-0005，两组共同依据）：
      //   轴一 · 目录分野 = 默认可写性：工作区 ERB 是创作源文件恒可编辑；游戏目录 ERB 默认只读。
      //   轴二 · 显式解锁 = 游戏目录里"这一份、这一次"的破例（`unlockedPathsRef`，
      //          按文件按会话、**不落盘**——"上次解锁过就一直可写"会让写保护形同虚设）。
      // 先按文件体量落 Monaco 选项，再挂 model——避免超长文件先在"默认全文级选项"
      // 下渲染一帧（大文件降级清单见 editor-options.ts）。
      const allowEdit = unlockedPathsRef.current.has(filePath) || directEditable(filePath);
      setUnlocked(allowEdit);
      ed.updateOptions({
        readOnly: erbReadOnlyGate(filePath, { inWorkspace: inWorkspace(filePath), canEdit: allowEdit }),
        ...editorOptionsForLineCount(entry.model.getLineCount()),
      });
      ed.setModel(entry.model);
      const vs = viewStatesRef.current.get(filePath);
      if (vs) ed.restoreViewState(vs);
      else applyPersistedView(ed, entry.model, filePath);
      setDirty(computeDirty(filePath));
      setError(null);
      setPendingChoice(null); // 换文件即作废未决的保存告警（避免误对旧文件应用修复）
      setStatus(`${entry.encoding} · ${entry.eol} · ${entry.model.getLineCount()} 行`);
      pushSelStatus(true);
      // 打开/切换即算一次装饰（不等用户编辑）——首屏就能看到波浪线
      if (markerTimerRef.current !== null) window.clearTimeout(markerTimerRef.current);
      markerTimerRef.current = null;
      refreshMarkers(entry.model, filePath);
      applySugarView(); // 预览：整份 ERB 投影成 .kojo 写法（默认关；`.kojo` 自动跳过）
      applyReveal();
      // C1 反向下行批：setModel + 视图恢复 + 定位都落定后补发一次位点——面板刚切过来
      // 就有位点（此前收到的还是上一份文件的旧位点，消费方按 filePath 判等自会忽略）
      publishCursor();
      stopApply();
    })();
    return () => {
      cancelled = true;
    };
  }, [kernel, filePath, applyReveal, refreshMarkers, onStatusInfo, computeDirty, scheduleMarkers, scheduleAutosave, clearSugarView, applySugarView, documentBroadcaster, readDocumentTruth, publishCursor]);

  /* ------------------- 只读锁：编辑意图 → 询问 → 解锁 ------------------- */

  /** 解锁 / 回锁当前 ERB（解锁即关闭该文件的糖视图——两者互斥） */
  const setErbEditable = useCallback(
    (path: string, allowEdit: boolean) => {
      const ed = editorRef.current;
      if (allowEdit) unlockedPathsRef.current.add(path);
      else unlockedPathsRef.current.delete(path);
      if (filePathRef.current !== path || !ed) return;
      setUnlocked(allowEdit);
      // 轴二只管游戏目录那一份：工作区文件本就可写，不存在"解锁/回锁"这回事
      // （ADR-0005 给糖组的适配项——别把写保护铁律的代价转嫁到正常操作上）。
      // 回锁时若直连开门仍应保持可编辑（直连是独立的可编辑来源）。
      const canEdit = allowEdit || directEditable(path);
      ed.updateOptions({ readOnly: erbReadOnlyGate(path, { inWorkspace: inWorkspace(path), canEdit }) });
      // 解锁 → 糖视图必须让位（原文要看得见）；回锁 → 重新生成糖视图
      applySugarView();
    },
    [applySugarView],
  );

  // 首次打开 ERB：问一次"要不要开预览"（问过就再不问）。
  // **工作区 ERB 不弹**（恒可编辑，预览本就不生效，问了没有意义——ADR-0005 轴一）；
  // 已解锁编辑的文件同样不弹（轴二的破例态下预览也让位）。
  // 默认关之后，这一次询问就是本功能主要的发现路径 ⇒ **必须保留**（预览已不在封存清单里，
  // 不再有"封存时不弹"这一条）。
  useEffect(() => {
    if (
      !sugarViewAllowed({
        isErbLike: isErbLike(filePath),
        inWorkspace: filePath !== null && inWorkspace(filePath),
        unlocked: filePath !== null && (unlockedPathsRef.current.has(filePath) || directEditable(filePath)),
      })
    )
      return;
    if (loadSugarViewPrompted()) return;
    setIntroAsk(true);
  }, [filePath]);

  const decideIntro = useCallback((on: boolean) => {
    saveSugarViewPrompted();
    setIntroAsk(false);
    setSugarView(on); // 走既有的偏好持久化 + 重算链路
  }, []);

  // 只读态下用户尝试输入 → 询问"保持只读 / 允许编辑"（Monaco 的只读编辑意图事件）
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const disposable = ed.onDidAttemptReadOnlyEdit(() => {
      const path = filePathRef.current;
      if (!isErbLike(path) || unlockedPathsRef.current.has(path) || directEditable(path)) return;
      // 已弹着就不再重复弹（连按键盘会产生一串事件）
      setUnlockAsk((cur) => cur ?? path);
    });
    return () => disposable.dispose();
  }, []);

  const decideUnlock = useCallback(
    (allow: boolean) => {
      const path = unlockAsk;
      setUnlockAsk(null);
      if (!path || !allow) return;
      setErbEditable(path, true);
      notify({
        kind: 'info',
        message: isSealed()
          ? '已允许编辑这份文件 · 你改的是游戏目录里的原生文件，请当心'
          : '已允许编辑此 ERB · .kojo 预览已关闭（建议改在自己的 .kojo 口上文件里写内容）',
      });
    },
    [unlockAsk, setErbEditable, notify],
  );

  /**
   * 编辑器动作意图（R8 命令面板补齐批）：命令面板的查找/替换/格式化/重命名/引用
   * 都从这里落地。壳层只发意图（`editor.action.request`），Monaco action id 的知识
   * 留在编辑器这一侧——发起方不必知道 Monaco 的内部命名。
   *
   * 判据与 fixAll 同款：没有活动文件 / 糖视图挂着（只读派生 model）时**可见拒绝**
   * 不静默；动作缺席（当前语言没注册对应能力）也明说。
   */
  useEffect(() => {
    const ACTION_IDS = {
      find: 'actions.find',
      replace: 'editor.action.startFindReplaceAction',
      formatDocument: 'editor.action.formatDocument',
      rename: 'editor.action.rename',
      references: 'editor.action.goToReferences',
    } as const;
    const un = kernel.bus.on('editor.action.request', (p) => {
      const ed = editorRef.current;
      if (!ed) {
        notify({ kind: 'info', message: '先打开一份文件，再执行这个动作。' });
        return;
      }
      if (sugarModelRef.current) {
        notify({ kind: 'info', message: '.kojo 预览是只读显示，动作改的是派生文本——先关掉预览再执行。' });
        return;
      }
      const action = ed.getAction(ACTION_IDS[p.action]);
      if (!action) {
        notify({ kind: 'info', message: '当前文件类型不支持这个动作。' });
        return;
      }
      void action.run();
    });
    return un;
  }, [kernel, notify]);

  /**
   * E3「全部修复」：把**当前文档**里每一条"只有唯一改法"的问题一次补好
   * （2026-10-16 批量修复批）。
   *
   * 宿主在这里只做三件事，**零批量判据**（判据全在 `kojo-fix-all.ts` 的纯函数里）：
   * ① 按既有的那道闸判"这份文件能不能改"（目录分野 + 逐份解锁，与 `setModel` 时
   *    挂给 Monaco 的 `readOnly` 同一个表达式，不另立第二套口径）；
   * ② 把 model 的读文本 / 行数 / 落改写包成 `FixAllDeps` 的四个回调——落地用的就是
   *    💡 那一条 `applyTextEdits` 通道（降序 + 夹取 + 一次 `executeEdits`），
   *    **不新造第二套编辑应用机制**，一轮 = 一个撤销步；
   * ③ 结果如实说一句（补了几处 / 剩下几处为什么要逐处选），绝不静默返回"按了没反应"
   *    （铁律 4）。命令恒可按下 = 就是这个道理：灰掉的命令要按得下去才知道为什么没修。
   *
   * 只改缓冲区、**不碰磁盘**：保存仍由作者 Ctrl+S 决定（与 💡 完全同级，批量只是次数）。
   */
  useEffect(() => {
    const un = kernel.bus.on('editor.fixAll.request', () => {
      const ed = editorRef.current;
      const model = ed?.getModel();
      const path = filePathRef.current;
      if (!ed || !model || !path) {
        notify({ kind: 'info', message: '先打开一份口上文件，再用一键修复。' });
        return;
      }
      // .kojo 预览挂的是**只读派生 model**：在它上面改 = 改不到任何真文件 ⇒ 可见拒绝
      if (sugarModelRef.current) {
        notify({ kind: 'info', message: '.kojo 预览是只读显示，改不到原文件——先关掉预览再一键修复。' });
        return;
      }
      const canEdit = unlockedPathsRef.current.has(path) || directEditable(path);
      if (erbReadOnlyGate(path, { inWorkspace: inWorkspace(path), canEdit })) {
        notify({ kind: 'info', message: '这份文件当前只读，一键修复不动它——先按提示允许编辑这份文件。' });
        return;
      }
      const report = runFixAll({
        decorators: kernel.slots.query('ui.editor.decorator'),
        codeActions: kernel.slots.query('ui.editor.codeAction'),
        path,
        project: kernel.project.current(),
        readText: () => model.getValue(),
        lineCount: () => model.getLineCount(),
        apply: (edits) => applyTextEdits(ed, edits),
      });
      notify({ kind: 'info', message: fixAllSummary(report) });
    });
    return un;
  }, [kernel, notify]);

  const labelParts = pathLabelParts(filePath);

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        {/* 身份优先（UI P4）：文件名 + 最深一层目录恒显，只有长前缀可缩。
            旧版整条路径交给 CSS 尾部省略，1280 窗口下 969px 塞进 550px ⇒ 裁掉的
            正好是文件名，作者盯着工具条读到的是游戏目录前缀。完整路径留在 title 里。 */}
        <span className="file-label" title={filePath}>
          {labelParts.head !== '' ? <span className="file-dir">{labelParts.head}</span> : null}
          {labelParts.tail !== '' ? <span className="file-pkg">{labelParts.tail}</span> : null}
          <span className="file-base">{labelParts.base}</span>
        </span>
        <span className={`dirty-dot ${dirty ? 'on' : ''}`} title={dirty ? '未保存' : '已保存'}>
          {dirty ? <Icon name="circle-filled" size={9} /> : null}
        </span>
        {isErbLike(filePath) && !inWorkspace(filePath) ? (
          <>
            {/* 两道正交轴的呈现（ADR-0005）：能走到这里说明这是**游戏目录里的 ERB**
                （工作区 ERB 恒可编辑，不开预览）。
                只读**不再在这里挂胶囊**——它与底部状态栏那颗是同一件事，两处并排等于互相抢答
                （2026-10-14 去重），原先挂在徽章上的那句解释迁进了状态栏胶囊的悬停。
                纯说明性标签不带操作入口——旧的「强制编辑 ERB」按钮按需求 §1.4 作废。 */}
            {unlocked ? (
              // 解锁 = 写保护对这一份文件暂时失效，是**需要被看见**的破例态 → 琥珀警示色；
              // 只读反而是安全默认态 → 中性色（见 styles.css `.erb-mode-hint` 配色口径）。
              <button
                className="erb-mode-hint unlocked"
                onClick={() => setErbEditable(filePath, false)}
                title={
                  sealed
                    ? '已破例允许编辑这一份文件（只对本次会话有效，关闭编辑器即失效）。改的是游戏目录里的原生文件，请当心。'
                    : '已破例允许编辑这一份文件（只对本次会话有效，关闭编辑器即失效），.kojo 预览同时关闭——要动手改的原文必须看得见。点击收回这次破例。'
                }
              >
                <Icon name="edit" size={13} /> 已解锁编辑
              </button>
            ) : directMode && kernel.io.isWritable(filePath) ? (
              /* 直连模式：已获写权限的目录内文件直接可编辑 → 信息色提示（非警示）。
                 直连可编辑 ⟹ 预览让位（与 unlocks 同口径，ADR-0005 互斥）→ 不渲染预览 toggle。 */
              <span
                className="erb-mode-hint direct"
                title="直连模式已开启：这份文件在已获写权限的目录内，可直接编辑（就地修改游戏目录）。写权限仍只来自你批准的可写目录。"
              >
                直连可编辑
              </span>
            ) : (
              <>
                {/* 预览开关：整份 ERB 投影成 .kojo 写法（只读显示，磁盘一字未动）——
                    本功能的存在理由就是让不熟悉原生语法的人也能把别人的口上当剧本读懂。
                    **默认关**（选择会被记住），发现路径 = 首次打开游戏目录 ERB 时的那一次询问。
                    图标走 HK-4 UI-3 的单色 `Icon` 通道（`currentColor`，跟 `.on` 的文字色一起变）。
                    标签**恒为「.kojo 预览」**，开关状态交给 .on 配色 + aria-pressed 表达：
                    按状态换字时两档字数不同，每点一次工具条就横向抖一下（与 T3 根除的树抖动同类缺陷）。 */}
                <button
                  className={`ghost small sugar-toggle${sugarView ? ' on' : ''}`}
                  aria-pressed={sugarView}
                  onClick={() => setSugarView((v) => !v)}
                  title={
                    sugarView
                      ? '已开启：当前显示的是 .kojo 写法。点击切回原生代码（这是显示偏好，文件内容一字未动）。'
                      : '把这份文件显示成 .kojo 写法——台词读起来像剧本、条件变成「如果 …：」。只改显示，不改动文件。'
                  }
                >
                  <Icon name="preview" size={13} /> .kojo 预览
                </button>
                {sugarView && sugarStats ? (
                  <span
                    className="sugar-stats dim"
                    title="其余行按原样显示：.kojo 还没覆盖到的控制流（SIF / 循环 / TRY）、赋值与调用，以及注释和空行。文件内容始终没有被改动。"
                  >
                    {sugarStats}
                  </span>
                ) : null}
              </>
            )}
          </>
        ) : null}
        <span className="spacer" />
        <span className="editor-status">
          {error ? (
            <>
              <Icon name="warning" size={13} /> {error}
            </>
          ) : (
            status
          )}
        </span>
        <button
          className="primary small"
          onClick={() => void save()}
          disabled={!dirty || (filePath !== null && !kernel.io.isWritable(filePath))}
          title={
            filePath !== null && !kernel.io.isWritable(filePath)
              ? '只读：写权限未批准（点击底部状态栏「只读」徽章授权）'
              : undefined
          }
        >
          保存 (Ctrl+S)
        </button>
      </div>
      {/* 面包屑（D1，宿主自绘）：角色/家族级导航复用 documentSymbol 链（外→内）。
          空链整条不渲染（糖视图 / 不在任何块内 = 没有可信的真文件行号可展示）。
          点击走 `editor.revealLocation` 既有通道跳块头行——不新造导航机制。 */}
      {crumbs.length > 0 ? (
        <div className="editor-crumb" aria-label="位置面包屑">
          {crumbs.map((c, i) => (
            <span key={`${i}-${c.startLine}-${c.name}`} className="editor-crumb-seg">
              {i > 0 ? <span className="editor-crumb-sep" aria-hidden="true">
                ›
              </span> : null}
              <button
                type="button"
                className="editor-crumb-item"
                title={`跳回「${c.name}」块头（第 ${c.startLine} 行）`}
                onClick={() => {
                  if (!filePath) return;
                  kernel.bus.emit('editor.revealLocation', { filePath, line: c.startLine, source: '面包屑' });
                }}
              >
                {c.name}
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="editor-body" ref={hostRef} />
      {pendingChoice ? <SaveWarningDialog warning={pendingChoice} onDecide={decideSaveWarning} /> : null}
      {introAsk ? <SugarViewIntroDialog onDecide={decideIntro} /> : null}
      {unlockAsk ? (
        sealed ? (
          <ErbReadonlyAskDialog fileName={baseNameOf(unlockAsk)} onDecide={decideUnlock} />
        ) : (
          <ErbUnlockDialog fileName={baseNameOf(unlockAsk)} onDecide={decideUnlock} />
        )
      ) : null}
    </div>
  );
}
