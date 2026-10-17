/**
 * @kojo/plugin-kojo-sugar
 *
 * 语法糖转译插件（服务 `sugar.transpile`；v0.3 批 S2 转译内核 + S3 编译落盘
 * + S5-UI 升糖应用）。
 *
 * 分层（"一切皆插件"）：
 * - 本插件 = 三段式转译器（行式词法 → AST → codegen）——**引擎级语言知识**
 *   （中文表层关键字是跨游戏语言层，契约 `sugar.ts` 头注已定调），零游戏知识；
 * - 变量字典（`VariableSchema`）/ **时机分野命名模板（`KojoFaceTable`）** 来自
 *   **game adapter**（经槽位查询 + `project.adapterId` 过滤后注入转译器）——
 *   本插件只消费，不解释；
 * - 编译落盘（S3 批）：`compileToFile` 走**内核 io 第一道闸**（writablePaths）
 *   + 备份 + 回读验证（安全顺序见 `compile.ts` 头注，复刻注入器范式）；
 *   `parse`/`transpile`/`sourceOf` 仍为纯函数。
 * - 升糖应用（S5-UI 批）：`sugar.liftApply` 与 `compileToFile` **同款写链路**
 *   （见 `lift-apply.ts` 头注），落盘成功后发 `file.changed`。
 */

import type {
  ConditionExpr,
  ConditionExtractorService,
  ControlFlowStatement,
  EditorLanguageServiceRequest,
  EditorLanguageServiceResult,
  ErbIndex,
  ErbParserService,
  FileIO,
  GameProject,
  KojoCounterTable,
  KojoFaceTable,
  KojoInstructionTable,
  KojoLibraryTable,
  KojoMutatorTable,
  Plugin,
  ProjectService,
  SlotRegistry,
  StateReplayService,
  SugarLiftApplyService,
  SugarLiftService,
  SugarPreviewService,
  SugarTranspileService,
  VariableInfo,
  VariableSchema,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices, resolveSugarTarget } from '@kojo/plugin-api';
import { createSugarTranspileService, type SugarTranspileServiceWithCache } from './service';
import { createSugarPreviewService } from './preview';
import { createSugarLiftService } from './lift';
import { createSugarLiftApplyService } from './lift-apply';
import { resolveKojoDefinition } from './definition';
import { kojoDocumentSymbols } from './document-symbols';
import { kojoFoldingRanges } from './folding';
import { kojoSemanticTokens } from './semantic-tokens';
import { kojoReferencesAt, planKojoRename } from './rename';
import {
  KOJO_LANGSVC_IDS,
  kojoCodeLens,
  kojoInlayHint,
  kojoWorkspaceSymbol,
  type KojoLangSvcDeps,
  type KojoWorkspaceSymbolDeps,
} from './langsvc';
import { createKojoFunctionCatalog, type KojoFunctionCatalog } from './kojo-function-catalog';
import type { DictionaryLookup } from './types';

export function createKojoSugarPlugin(): Plugin {
  return {
    id: 'kojo-sugar',
    version: '0.3.0',
    provides: [
      WellKnownServices.SugarTranspile,
      WellKnownServices.SugarPreview,
      WellKnownServices.SugarLift,
      WellKnownServices.SugarLiftApply,
    ],
    // S3 批：编译落盘需要内核 io（第一道闸）；Project/Slots 供 adapter 字典查询
    requires: [KernelServices.Project, KernelServices.Slots, KernelServices.IO],
    activate(ctx) {
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      const slots = ctx.inject<SlotRegistry>(KernelServices.Slots);
      const io = ctx.inject<FileIO>(KernelServices.IO);

      /**
       * 状态回放服务（`state.replay`）——**可选消费**（S4 批）。
       *
       * 之所以**不写进 `requires`**：预览在无存档时仍要可用（糖预览是编辑器
       * 常态），把 `state.replay` 做成硬依赖会让"回放插件未激活"直接导致
       * kojo-sugar 静默 inactive——那是本末倒置。故按需**软取**：
       * `ctx.inject` 抛错则回退 undefined，预览走结构化降级
       * （`replay-service-unavailable`，契约已定义）。
       */
      const replayOf = (): StateReplayService | undefined => {
        try {
          return ctx.inject<StateReplayService>(WellKnownServices.StateReplay);
        } catch {
          return undefined;
        }
      };

      /**
       * `erb.parser` 服务本体（**软取**，三处消费者共用一个口子）。
       *
       * 软取理由与 `scanFlowOf` 逐字相同：解析器未激活只该让"依赖索引/结构判据的那几条腿"
       * 退化，不该让整个 kojo-sugar 静默 inactive。收成一处是因为消费者已经长到三个
       * （结构扫描、项目索引、产物解析），三份 `try/inject` 迟早有一份漏掉错误分支。
       */
      const erbParserServiceOf = (): ErbParserService | undefined => {
        try {
          return ctx.inject<ErbParserService>(WellKnownServices.ErbParser);
        } catch {
          return undefined;
        }
      };

      /**
       * `erb.parser` 的 `scanControlFlow`（S5 批，软取）——提升建议的**结构**判据。
       */
      const scanFlowOf = (): ((text: string) => ControlFlowStatement[]) | undefined => {
        const parser = erbParserServiceOf();
        return parser ? (text: string) => parser.scanControlFlow(text) : undefined;
      };

      /**
       * `erb.parser`.`currentIndex()`（软取，2026-10-15 语言服务批）——转到定义的
       * **跨文件那一腿**：`.kojo` 里的函数名就是 ERB 函数名，别处的函数只能靠项目
       * 索引反查（同一份 `byName`，不新造表）。软取理由同 `scanFlowOf`：索引缺席
       * 只该让"跳到别处"这条路失效，不该让整个 kojo-sugar 静默 inactive。
       */
      const erbIndexOf = (): ErbIndex | null => erbParserServiceOf()?.currentIndex() ?? null;

      /**
       * `condition.extractor` 的 `parseExpression`（S5 批，软取）——提升建议的
       * **条件可解析性**判据（`opaque` = 跳过信号）。
       */
      const parseExprOf = (): ((text: string) => ConditionExpr) | undefined => {
        try {
          const extractor = ctx.inject<ConditionExtractorService>(WellKnownServices.ConditionExtractor);
          return (text: string) => extractor.parseExpression(text);
        } catch {
          return undefined;
        }
      };

      /**
       * 当前适配器的**变量字典 / 分野表 / 指令表 / 函数名表 / 数值增减族表 / 计数器值域表**
       * （一次槽位扫出六件）。
       *
       * 每次调用都**重查**（适配器可能在项目切换后重建 schema/表，正是代际判据
       * 的来源）——但只做一次 `slots.query` + 一次逐字段首命中；六件全齐且
       * 对象引用未变 ⇒ 视为同一代际，转译器/字典实例（含共享缓存）整体复用。
       */
      interface AdapterView {
        readonly adapterId: string | null;
        readonly projectRoot: string | null;
        readonly inputDigest: string | undefined;
        readonly variableSchema: VariableSchema | undefined;
        readonly faceTable: KojoFaceTable | undefined;
        readonly instructionTable: KojoInstructionTable | undefined;
        readonly libraryTable: KojoLibraryTable | undefined;
        readonly mutatorTable: KojoMutatorTable | undefined;
        readonly counterTable: KojoCounterTable | undefined;
      }

      const emptyView = (): AdapterView => ({
        adapterId: null,
        projectRoot: null,
        inputDigest: undefined,
        variableSchema: undefined,
        faceTable: undefined,
        instructionTable: undefined,
        libraryTable: undefined,
        mutatorTable: undefined,
        counterTable: undefined,
      });

      const viewOf = (): AdapterView => {
        const current: GameProject | null = project.current();
        if (!current) return emptyView();
        const v: {
          adapterId: string;
          projectRoot: string;
          inputDigest: string | undefined;
          variableSchema: VariableSchema | undefined;
          faceTable: KojoFaceTable | undefined;
          instructionTable: KojoInstructionTable | undefined;
          libraryTable: KojoLibraryTable | undefined;
          mutatorTable: KojoMutatorTable | undefined;
          counterTable: KojoCounterTable | undefined;
        } = {
          adapterId: current.adapterId,
          projectRoot: current.rootDir,
          inputDigest: current.inputDigest,
          variableSchema: undefined,
          faceTable: undefined,
          instructionTable: undefined,
          libraryTable: undefined,
          mutatorTable: undefined,
          counterTable: undefined,
        };
        for (const contribution of slots.query('game.adapter')) {
          if (contribution.adapter.gameId !== current.adapterId) continue;
          // 逐字段首命中（与改前四个独立查询函数逐条同义）
          v.variableSchema ??= contribution.adapter.variableSchema;
          v.faceTable ??= contribution.adapter.kojoFaceTemplates;
          v.instructionTable ??= contribution.adapter.kojoInstructionTable;
          v.libraryTable ??= contribution.adapter.kojoLibraryTable;
          v.mutatorTable ??= contribution.adapter.kojoMutatorTable;
          v.counterTable ??= contribution.adapter.kojoCounterTable;
        }
        return v;
      };

      /**
       * 代际判据：项目根 + adapterId + 非 ERB 输入摘要 + 六张表的**对象引用**。
       * 表对象换代（新对象）或项目换代 ⇒ 全新转译器实例（空缓存）；
       * 引用全同 ⇒ 同一代际（产物只依赖这些对象的内容，纯函数语义下结果可复用）。
       * **前提**：表以"整体换代"变更（eratw-adapter 每次 loadProject 重建 schema，
       * 指令表随 `Train.csv` 换代）——原地改表内容的实现不在本判据面内。
       */
      const sameView = (a: AdapterView, b: AdapterView): boolean =>
        a.adapterId === b.adapterId &&
        a.projectRoot === b.projectRoot &&
        a.inputDigest === b.inputDigest &&
        a.variableSchema === b.variableSchema &&
        a.faceTable === b.faceTable &&
        a.instructionTable === b.instructionTable &&
        a.libraryTable === b.libraryTable &&
        a.mutatorTable === b.mutatorTable &&
        a.counterTable === b.counterTable;

      interface ResolvedAdapter {
        readonly view: AdapterView;
        /** 字典（按 variableSchema 身份 memo；`lift` 服务经 `dictionaryOf()` 共享同一枚） */
        readonly dictionary: DictionaryLookup | undefined;
        /** 纯转译实例（含共享结果缓存）；同代际内被全部纯转译消费方复用 */
        base?: SugarTranspileServiceWithCache;
        /** 带内核 io 的编译实例（compileToFile；与 base 同代际同缓存语义） */
        ioBound?: SugarTranspileServiceWithCache;
      }

      let resolved: ResolvedAdapter | null = null;

      const resolveAdapter = (): ResolvedAdapter => {
        const view = viewOf();
        if (resolved !== null && sameView(resolved.view, view)) return resolved;
        resolved = {
          view,
          dictionary: view.variableSchema ? makeLookup(view.variableSchema) : undefined,
        };
        return resolved;
      };

      const dictionaryOf = (): DictionaryLookup | undefined => resolveAdapter().dictionary;

      const faceTableOf = (): KojoFaceTable | undefined => resolveAdapter().view.faceTable;

      const instructionTableOf = (): KojoInstructionTable | undefined => resolveAdapter().view.instructionTable;

      const libraryTableOf = (): KojoLibraryTable | undefined => resolveAdapter().view.libraryTable;

      /**
       * 统一的转译器构造（字典 + 分野/指令/函数名/增减族/计数器表同源注入；保证各路径行为一致）。
       *
       * **按代际 memo**（L2 批）：同代际内返回**同一实例**——既省去每次调用的
       * 槽位查询 + `makeLookup` 闭包构造 + 服务装配，也让该实例的**共享结果缓存**
       * 对所有消费者生效（波浪线 / 糖判定面板 / 预览 / 保存链同一份结果）。
       */
      const makeTranspiler = (
        deps?: Omit<
          Parameters<typeof createSugarTranspileService>[0],
          'dictionary' | 'faceTable' | 'instructionTable' | 'libraryTable' | 'mutatorTable' | 'counterTable'
        >,
      ): SugarTranspileService => {
        const r = resolveAdapter();
        const tables = {
          dictionary: r.dictionary,
          faceTable: r.view.faceTable,
          instructionTable: r.view.instructionTable,
          libraryTable: r.view.libraryTable,
          mutatorTable: r.view.mutatorTable,
          counterTable: r.view.counterTable,
        };
        if (deps === undefined) return (r.base ??= createSugarTranspileService({ ...tables, log: ctx.log }));
        return (r.ioBound ??= createSugarTranspileService({ ...tables, ...deps }));
      };

      /** 无表只读查询（sourceOf / sourceColumnOf / generatedOf）——一个无状态实例用到底 */
      const stateless = createSugarTranspileService();

      const service: SugarTranspileService & Pick<SugarTranspileServiceWithCache, 'transpileCacheStats'> = {
        parse: (source, options) => makeTranspiler().parse(source, options),
        transpile: (source, options) => makeTranspiler().transpile(source, options),
        sourceOf: (result, generatedLine) => stateless.sourceOf(result, generatedLine),
        // S6 列级映射（纯查询：只读转译结果里的 sourceMap，不需要 adapter 注入）
        sourceColumnOf: (result, generatedLine, generatedColumn) =>
          stateless.sourceColumnOf(result, generatedLine, generatedColumn),
        generatedOf: (result, source) => stateless.generatedOf?.(result, source) ?? null,
        // S3：编译落盘一体——转译（带当前 adapter 字典+分野表）+ 双闸写 + 备份 + 回读
        compileToFile: (source, targetPath, options) =>
          makeTranspiler({ io, log: ctx.log }).compileToFile(source, targetPath, options),
        // 导出批：内存编译（零 IO，故不注入 io）——与 compileToFile 共用守卫与编码组装
        compileToBytes: (source, options, targetLabel) =>
          makeTranspiler().compileToBytes(source, options, targetLabel),
        // S7：保存前置检查（纯函数）——推导目标 + 转译 + 全角空格告警，同一转译器
        planSave: (request) => makeTranspiler().planSave(request),
        // L2：共享缓存读数（**附加能力**，非契约面；契约消费方零改动）——
        // 与 `transpile` 同源取当前代际实例（换代即读到新实例的空缓存，不混代际）。
        transpileCacheStats: () =>
          resolveAdapter().base?.transpileCacheStats() ?? {
            hits: 0,
            misses: 0,
            evictions: 0,
            entries: 0,
            sourceChars: 0,
          },
      };

      ctx.provide(WellKnownServices.SugarTranspile, service);

      /**
       * 预览服务（S4 批）——**只读数据层**：转译复用上表同一个转译器
       * （同 adapter 字典 + 分野表），回放软取 `state.replay`，产出三向映射。
       *
       * 事件纪律：预览**不发射任何事件**（`file.changed` 等由内核 io 监视器
       * 产生；预览只消费）。故此处不注册任何 `ctx.bus.on`。
       */
      const previewService: SugarPreviewService = createSugarPreviewService({
        transpile: (source, options) => makeTranspiler().transpile(source, options),
        ...(replayOf() ? { replay: replayOf()! } : {}),
        io,
        log: ctx.log,
      });

      ctx.provide(WellKnownServices.SugarPreview, previewService);

      /**
       * 提升建议服务（S5 批）——**原生 ERB → 糖候选**。
       *
       * 依赖方向（单向，无环；**一律走服务槽**，插件不得交叉 import —— 解耦审计 C 项）：
       * - `transpile` 复用上面同一个转译器（同 adapter 字典）——round-trip 自证
       *   的**唯一**手段；本服务只调用它，不改动转译内核；
       * - `scanControlFlow` 取自 `erb.parser` 服务（块配对 + "糖未覆盖的控制流"判据）；
       * - `parseCondition` 取自 `condition.extractor` 服务的 `parseExpression`
       *   （`opaque` = 跳过信号）。
       *
       * 后两者**软取**（`try/catch` → undefined）：两者缺席时提升建议仍能工作，
       * 只是判据退化（`degraded: true`，`lift.ts` 里已有明确分支）。若写成硬
       * 依赖，"解析器未激活"会让 kojo-sugar 整体静默 inactive——那是本末倒置
       * （与 `state.replay` 的软取同理）。
       *
       * 事件纪律：提升建议是**纯函数式只读**能力（不读盘、不写盘、不发事件），
       * 与预览一致——故此处不注册任何 `ctx.bus.on`。
       */
      const liftService: SugarLiftService = createSugarLiftService({
        transpile: (source, options) => makeTranspiler().transpile(source, options),
        ...(scanFlowOf() ? { scanControlFlow: scanFlowOf()! } : {}),
        ...(parseExprOf() ? { parseCondition: parseExprOf()! } : {}),
        // 变量字典（软取：adapter 未激活时投影退化为"不做属性反糖"，其余照常）
        // `dictionaryOf` 是**每次调用时才查**的函数（适配器可能随项目切换重建 schema）。
        dictionary: () => dictionaryOf(),
        // 时机分野模板表（软取，批 I 的函数头反解用；缺席 = 一个头都不标）
        faceTable: () => faceTableOf(),
        // 基础库 / 常用函数名表（软取，ZH-F2 的函数名反显用；缺席 = 英文函数名保持英文）
        libraryTable: () => libraryTableOf(),
      });

      ctx.provide(WellKnownServices.SugarLift, liftService);

      /**
       * 升糖**应用**服务（S5-UI 批）——把候选写回 `.kojo` 源文件。
       *
       * 与 `sugar.lift` 的分工：后者是**只读观察面**（契约明文：不读盘不写盘不发
       * 事件）；写能力必须显式声明成一个独立服务键，否则"哪些插件能写盘"就不再
       * 可审计。**能力面 = 服务键面**。
       *
       * 写链路与 S3 的 `compileToFile` 逐条对齐（编码组装 → 目录 → 备份 → 内核
       * io 写盘〔第一道闸〕→ 回读验证），**不绕过任何一闸**。
       *
       * 事件纪律：本服务**发** `file.changed`（写盘成功路径上）。这与 S4 预览的
       * "只消费、绝不发射"不冲突——预览不写盘，故无变更可报；本服务确实改了盘，
       * 不发事件反而是"内核不静默"铁律的破坏（编辑器不会知道文件变了）。
       * 发口由装配层注入（`onApplied`），实现层零内核依赖。
       */
      const liftApplyService: SugarLiftApplyService = createSugarLiftApplyService({
        io,
        log: ctx.log,
        onApplied: (path: string) => {
          ctx.bus.emit('file.changed', { kind: 'change', path });
        },
      });

      ctx.provide(WellKnownServices.SugarLiftApply, liftApplyService);

      /* ---------------- W6 能力面通道（2026-10-17 PARITY-EXT 批） ----------------

       下面三枚 `.kojo` 应答（`workspaceSymbol` / `codeLens` / `inlayHint`）**不自己判**：
       判据在 `erb-parser`（反向索引、形参表、名字名录），本包只把坐标从产物折回源。
       通道就是那枚公共槽——`askLanguageService` 把整枚请求原样问给槽上的其余应答方，
       于是"被谁调用"这类口径全仓仍只有一份（抄第二份的代价见 `langsvc.ts` 头注的表格）。
       走槽而不是 import 别的插件：解耦审计 C 项的明文路径（插件间只经契约类型 + 内核服务交互）。
       */

      /**
       * 问一次槽（**本包自己那三枚先摘掉**——留着就是自问自答，递归到栈爆）。
       * 单枚贡献抛错只丢它一家（与宿主 `collectCodeLenses` / `collectInlayHints` 的
       * 隔离口径逐字相同：能力出错退化可见，不许把整条链带没）。
       */
      const askLanguageService = (request: EditorLanguageServiceRequest): EditorLanguageServiceResult[] => {
        const out: EditorLanguageServiceResult[] = [];
        for (const contribution of slots.query('ui.editor.languageService')) {
          if (KOJO_LANGSVC_IDS.has(contribution.id)) continue;
          try {
            const result = contribution.provide(request);
            if (result) out.push(result);
          } catch (e: unknown) {
            ctx.log.warn(
              `[kojo-langsvc] '${contribution.id}' 应答抛错（已跳过）：${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        return out;
      };

      /** 三枚应答共用的依赖（转译与列级折回都走 `sugar.transpile` 的现役代际实例） */
      const langSvcDeps: KojoLangSvcDeps = {
        transpile: (source, options) => service.transpile(source, options),
        sourceColumnOf: (result, generatedLine, generatedColumn) =>
          service.sourceColumnOf(result, generatedLine, generatedColumn),
        ask: askLanguageService,
      };

      /**
       * `.kojo` 函数名录（产物路径 → 源路径 + 源行）：`workspaceSymbol` 那条腿的坐标源。
       *
       * 绑定条件苛刻是故意的——"什么是函数定义"的判据主人是解析器，拿不到它的
       * `parseText` 就**根本不建名录**（宁可不答，也不在糖包里养第二份方言解析）。
       */
      let catalog: KojoFunctionCatalog | null = null;
      let catalogParser: ErbParserService | null = null;
      const catalogOf = (): KojoFunctionCatalog | null => {
        const parser = erbParserServiceOf();
        if (!parser) return null;
        if (catalog !== null && catalogParser === parser) return catalog;
        catalogParser = parser;
        return (catalog = createKojoFunctionCatalog({
          io,
          transpile: (source, options) => service.transpile(source, options),
          parseProduct: (text, path) => parser.parseText(text, path),
          log: ctx.log,
        }));
      };

      /** 名录的检索根 = 索引的根（同一份 `project.kojoPaths`，不另立一套覆盖面） */
      const catalogRoots = (): string[] => {
        const current: GameProject | null = project.current();
        return current ? [...current.kojoPaths] : [];
      };

      // 刷新排队：同一时刻只跑一轮，期间来的信号并成"结束后再跑一轮"（文件监视一拍能来十几条）
      let catalogBusy = false;
      let catalogQueued = false;
      const refreshCatalog = (): void => {
        if (project.current() === null) return; // 没开项目就没事可办（也别把未就绪当就绪）
        if (catalogBusy) {
          catalogQueued = true;
          return;
        }
        const target = catalogOf();
        if (!target) return; // 判据主人缺席 ⇒ 不建名录（`catalogReady()` 那侧如实答 undefined）
        catalogBusy = true;
        const roots = catalogRoots();
        void target
          .refresh(roots)
          .catch((e: unknown) => {
            ctx.log.warn(`[kojo-langsvc] .kojo 名录刷新失败：${e instanceof Error ? e.message : String(e)}`);
          })
          .finally(() => {
            catalogBusy = false;
            if (catalogQueued) {
              catalogQueued = false;
              refreshCatalog();
            }
          });
      };

      const wsDeps: KojoWorkspaceSymbolDeps = {
        ...langSvcDeps,
        // 未开项目 = 连"该不该有一份名录"都还没定 ⇒ 不答（与 erb 的"索引缺席"同一区分）
        catalogReady: () => project.current() !== null && (catalogOf()?.stats().ready ?? false),
        locate: (productPath, name) => catalogOf()?.locate(productPath, name) ?? null,
      };

      ctx.onDispose(
        ctx.bus.on('project.opened', () => {
          catalog?.reset();
          refreshCatalog();
        }),
      );
      ctx.onDispose(
        ctx.bus.on('project.closed', () => {
          catalog?.reset();
        }),
      );
      // 源文件变脏 ⇒ 那一份的 `size`+`mtime` 复用判据作废，下一轮只重算它（其余整份复用）
      ctx.onDispose(
        ctx.bus.on('file.changed', (ev) => {
          if (resolveSugarTarget(ev.path) === null) return;
          catalog?.invalidate(ev.path);
          refreshCatalog();
        }),
      );
      // 索引重建完成（产物的增删改名都在这条上）⇒ 名录跟着走一轮
      ctx.onDispose(ctx.bus.on('kojo.functionChanged', () => refreshCatalog()));

      /* ---------------- 转到定义（2026-10-15 语言服务批） ----------------

       由 kojo-sugar 应答 `.kojo`：判据是**糖语义**（`.kojo` 里的名字指向编译产物
       ERB 里的函数），只有本包有转译器与源映射。`erb-parser` 应答 ERB 方言，两条线
       各管自己认得的文件，宿主只合并结果。

       `.kojo` 的判定复用 `resolveSugarTarget`（"同目录换扩展名"的唯一真源），
       不另写一条正则——两条判据漂移的表现是"保存认得、跳转不认得"这类鬼故事。
       */
      // 注册入口与另外 17 个插件同一条路（`ctx.slots.register`，单一约定）。
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo-definition',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'definition') return undefined;
          if (resolveSugarTarget(request.path) === null) return undefined;
          return {
            kind: 'definition',
            locations: resolveKojoDefinition(
              { path: request.path, text: request.text, line: request.line, column: request.column },
              {
                transpile: service.transpile,
                sourceOf: service.sourceOf,
                sourceColumnOf: service.sourceColumnOf,
                index: erbIndexOf,
              },
            ),
          };
        },
      });

      /* ---------------- 文档大纲（B3，2026-10-15 编辑器特性批） ----------------

       同一个判别式联合的第二个成员，`.kojo` 这一腿由本包答：大纲项就是糖 AST 的
       结构节点（时机 / 段 / 分支 / 选项…），节点自带 `loc`，行号与作者正在编辑的
       缓冲区逐行对齐——不存在"索引过期"这回事，也不需要第二份表。
       */
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo-symbols',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'documentSymbol') return undefined;
          if (resolveSugarTarget(request.path) === null) return undefined;
          return {
            kind: 'documentSymbol',
            symbols: kojoDocumentSymbols(service.parse(request.text, { filePath: request.path })),
          };
        },
      });

      /* ---------------- 折叠范围（D3，2026-10-15 折叠/面包屑批） ----------------

       同一枚槽的第三个判别成员，`.kojo` 这一腿由本包答：**糖的层级就是折叠层级**——
       区间直接摊平自大纲的同一棵符号树（`loc` 来自转译器，行号与缓冲区逐行对齐），
       不建第二份解析。折叠/大纲/吸顶/面包屑共用这一棵树。
       */
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo-folding',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'foldingRange') return undefined;
          if (resolveSugarTarget(request.path) === null) return undefined;
          return {
            kind: 'foldingRange',
            ranges: kojoFoldingRanges(service.parse(request.text, { filePath: request.path })),
          };
        },
      });

      /* ---------------- 结构化着色（B6，2026-10-16） ----------------

       同一枚槽的第六个判别成员，`.kojo` 这一腿由本包答：判据是**糖 AST 的节点身份**
       （`函数` / `自定指令` 的名字、形参表、`别名` / `常量` 声明、`调用` 的被调者），
       与大纲/折叠共用同一棵 `loc` 树，不建第二份解析。宿主只把 span 翻成编辑器的
       着色协议——它不认识 `函数` 这个词。

       只画**声明位与调用位**，不画别名在条件里的使用点：糖节点把条件存成原文字符串，
       段内没有子记号区间，要画就得自己再切一遍表达式（与本包 `expression.ts` 分叉）。
       */
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo-semantic-tokens',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'semanticToken') return undefined;
          if (resolveSugarTarget(request.path) === null) return undefined;
          const doc = service.parse(request.text, { filePath: request.path });
          return { kind: 'semanticToken', spans: kojoSemanticTokens(doc, request.text) };
        },
      });

      /* ---------------- 查找引用（R2，2026-10-16 语言服务批） ----------------

       同一枚槽的第七个判别成员，`.kojo` 这一腿由本包答。判据为什么必须住在转译器：
       "这个出现点是不是函数引用"只有转译行为说了算（台词/注释/原生直通里的同名出现
       不是引用），词法正则答不了。数据面在 `./rename.ts`（探针法，纯函数），此处只接线。

       编译错误 / 不是本文件「函数」声明的名字 ⇒ 空数组（**不猜**，作者看到"没有引用"）。
       */
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo-references',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'references') return undefined;
          if (resolveSugarTarget(request.path) === null) return undefined;
          return {
            kind: 'references',
            locations: kojoReferencesAt({
              source: request.text,
              path: request.path,
              line: request.line,
              column: request.column,
              transpile: service.transpile,
            }),
          };
        },
      });

      /* ---------------- 用户函数改名（R1，2026-10-16 语言服务批） ----------------

       同一枚槽的第八个判别成员。与 `erb-rename` 的分工：ERB 函数的全项目改名走它的
       专用通道（双通道送达 + 只读全或无）；`.kojo` 用户函数**文件局部**（规范 §7.2
       排除跨文件可见），引用集只在同一份文件里，故走单槽应答 + 宿主 WorkspaceEdit
       单步落地。可证明引用面与"整卷复核"纪律见 `./rename.ts` 头注——转译器当判官，
       产物 diff 越出预期行 ⇒ 整次取消并明说（宁可不改，不做名字分叉的半成品）。
       */
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo-rename',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'rename') return undefined;
          if (resolveSugarTarget(request.path) === null) return undefined;
          const idx = erbIndexOf();
          const plan = planKojoRename({
            source: request.text,
            path: request.path,
            line: request.line,
            column: request.column,
            newName: request.newName,
            transpile: service.transpile,
            // 产物名撞名守门（软取：索引缺席 = 不判，不猜索引外的事）
            productNameExists: idx ? (name) => idx.byName.has(name.toUpperCase()) : undefined,
          });
          if (plan.kind === 'reject') return { kind: 'rename', edits: [], rejectReason: plan.reason };
          return {
            kind: 'rename',
            edits: plan.edits.map((e) => ({
              line: e.line,
              startColumn: e.column,
              endColumn: e.endColumn,
              newText: request.newName,
            })),
            oldName: plan.oldName,
          };
        },
      });

      /* ---------------- 工作区符号（D2 的 `.kojo` 那一腿，W6 批） ----------------

       同一枚槽的**第九个**判别成员由本包答的方式很特别：本包**不做任何匹配**。
       请求原样问给槽上的其余应答方（今天就是 `erb-workspace-symbols` 那一份 `byName`
       投影），拿到候选后只做一件事——命中项的定义点若正好是某个 `.kojo` 的**编译产物**，
       把 `filePath`/`line` 换成那份源文件的对应位置（坐标来自本包的 `.kojo` 名录）。
       于是匹配口径、排序桶、`limit` 预算、结果形状**全部与 ERB 逐字同一份实现**，
       而 `Ctrl+T` 打出来的那条候选点开的是作者能改的那份文件，不是一份生成物。
       证不了源位置的那一条不重定基（它仍以产物路径出现在 ERB 那条线的结果里 ⇒
       没有任何东西被吞掉）。名录未就绪 / 判据主人缺席 ⇒ `undefined`（不答 ≠ 没有）。
       */
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo-workspace-symbols',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'workspaceSymbol') return undefined;
          return kojoWorkspaceSymbol(request, wsDeps);
        },
      });

      /* ---------------- 行上内联注解（B8 的 `.kojo` 那一腿，W6 批） ----------------

       「这一处定义被谁用到」的判据全在 `erb-parser/usage-lens.ts` + 项目反向索引，
       本包既没有那份索引也不该有第二份口径。做法：把 `.kojo` 转译成产物（缓存命中即
       零成本——同一份文本刚被波浪线那一路转译过），拿**产物坐标**去问 ERB 那条线，
       再把每条注解的行折回源行（`@` 函数头是纯生成行，走"向下取最近一条有源行、
       越过下一个 `@` 就放弃"那条与转到定义同款的保守路）。
       折不回 ⇒ **整条丢弃**：把产物第 5,000 行的话说成源第 4,999 行 = 错标比不标危险。
       三道体量/条数/密度降级**不归这里**，一律在宿主（`app/src/monaco/kojo-code-lens.ts`）。
       */
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo-code-lens',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'codeLens') return undefined;
          return kojoCodeLens(request, langSvcDeps);
        },
      });

      /* ---------------- 实参位行内提示（LS-R6 的 `.kojo` 那一腿，W6 批） ----------------

       同上，只多一维：提示钉在"某个实参的首字符之前"，所以**行列一起折**——列必须走
       S6 列级映射（`sourceColumnOf`）且落回同一个源行，否则整条不说（契约 `SugarColumnRun`
       的"绝不记录猜出来的列"）。因此 `.kojo` 里有提示的是**产物行与源行逐码元同源**那些
       调用位（原生直通 / `调用` 直译那几形），降糖改写区如实留白。
       被调方形参表仍然只有 `ErbIndex` 说得清——本包一条都不判。
       */
      ctx.slots.register('ui.editor.languageService', {
        id: 'kojo-inlay-hints',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'inlayHint') return undefined;
          return kojoInlayHint(request, langSvcDeps);
        },
      });
    },
  };
}

/**
 * 把 adapter 的 `VariableSchema` 适配为转译器的 `DictionaryLookup`（只读消费）。
 *
 * - `resolveFamily(name)`：变量名字 → 族名。策略：按引擎变量族表逐个
 *   `lookup(FAMILY, name)`，**两轮**取归属（ALS-R1）——第一轮只认**主表**（`'primary'`）
 *   收录、按族表顺序取首个；一轮都不中才第二轮认**追加名表**（`'append'`）；
 *   `'const'`（作者自定具名常量）**一律不参与族归属**（adapter FT-1 的自述口径就是
 *   "本表只做名字→编号换算、不宣称族归属"，此前只因它返回 `description`/`resolvedIndex`
 *   就被当成族收录 ⇒ 把主表的归属抢走，实测 `教養` ABL→CFLAG、`憤怒` TCVAR→BASE）。
 *   **为什么必须分层**：升糖投影按 `nameAt(族, 编号)` 显示（`project.ts`），显示侧走的是
 *   主表；作者照抄下来降糖时若 `resolveFamily` 给出另一个族，就是**显示与写不同族**。
 *   规范 §3.8 说"命中不唯一时编辑器弹窗"，那是 S4 编辑体验批的职责；本函数取
 *   **确定性**首个命中（同层内仍是族表顺序即优先级，不静默猜测顺序之外的语义）；
 * - `resolve(ident)`：裸标识符 → 原样（引擎变量表已收录的族名 + 冒号索引
 *   写法本就合法，不需要改写）；
 * - `unlistedFamilyName(ident)`（P-10③）：`族头:具名索引` 的**名称段**核对——
 *   历史上 `resolve` 只看族头就整串放行，拼错的具名（`NOWEX:噴乳乳瞎写`）零诊断
 *   进产物（违铁律 4）。本方法把"族表在位但该名查无"单独问一次，**不改写产物**，
 *   报警由 `expression.ts` 的族引用放行点决定（**warning 起步**）。
 *   **收录判定三层都算**（含 `'const'`）：拼错名检测受益于常量表——作者写在 `.ERH`
 *   里的名字是真名，不是拼错。
 */
export const ENGINE_VARIABLE_FAMILIES: readonly string[] = [
  'CFLAG',
  'TALENT',
  'ABL',
  'EXP',
  'MARK',
  'BASE',
  'PALAM',
  'TEQUIP',
  'TCVAR',
  'FLAG',
  'TFLAG',
  'CALLNAME',
  'NAME',
  'JVEL',
  'STAIN',
  'DOWNBASE',
  'CUP',
  'GOTJUEL',
  'NOWEX',
  'SOURCE',
];

/**
 * **本批具名索引核对的生效族 → 其名称表键候选**（P-10③ 立项；ALS 批 2026-10-14 扩族）。
 *
 * 为什么是"候选表键"而不是"族名一律查自己的表"：引擎把**同一张名字表**挂在两个变量上
 * （`NOWEX` 的具名索引住在 `EX` 的表里、`DOWNBASE` 住在 `BASE` 里），游戏目录里并没有
 * `NOWEX.csv`。别名与上面那张族头清单同性质 —— 是 **ERB 语言层**知识，不是某个游戏的数据
 * （数据本身仍由 adapter 的 CSV/ALS 表注入）。
 *
 * ## 入库判据（ALS 批定死，别照着"看着少"就加）
 *
 * 生效族 = adapter 字典（**已含 `CSV/*.als` 追加名表**，见 eratw-adapter `variable-schema.ts`）
 * 在真语料上把该族的**实际 warn 面打到 0** —— 或者只剩**真阳性**（作者确实写错的名称，
 * 引擎取不到值，正是本核对要抓的东西）。只要残余里还有**一条系统性假阳性类**，该族就不入库。
 *
 * ## 读数（ALS-R2 批 2026-10-14 **按生产判据**全表重测，本机三盘；口径见下"口径声明"）
 *
 * 列义：`具名` = 真二段形引用处数；`前/中/现` = 判表外处数，字典分别是
 * 只 `*.csv` / `+*.als` / `+*.ERH`（现 = 今天的生产字典）；`warn` = 现字典判表外后再过
 * `expression.ts:reportUnlistedFamilyName` 的"名称段是裸引擎全局"放行 ⇒ **warn 才是作者真会看到的数**。
 *
 * | 族头 | 具名 | 前 | 中 | 现 | warn | 取舍 |
 * | --- | --- | --- | --- | --- | --- | --- |
 * | `MARK` | 10,943 | 0 | 0 | 0 | 0 | 保持入库（`Mark.als` 与 `Mark.csv` 逐字节相同） |
 * | `NOWEX` | 5,197 | 7 | 3 | 3 | 2 | 保持入库（残余 = `i`×2 动态索引 + `COUNT`，第 5 类） |
 * | `DOWNBASE` | 108 | 0 | 0 | 0 | 0 | 保持入库 |
 * | `STAIN` | 4 | 0 | 0 | 0 | 0 | 保持入库 |
 * | `BASE` | 1,842 | **711** | **0** | 0 | 0 | 保持入库（`Base.als` 简繁双写：`10,情绪`+`10,情緒`） |
 * | `FLAG` | 3,984 | **126** | **0** | 0 | 0 | 保持入库 |
 * | `TFLAG` | 1,262 | **46** | **0** | 0 | 0 | 保持入库 |
 * | `TEQUIP` | 3,460 | **73** | **1** | 1 | **1** | 保持入库（唯一残余 `TEQUIP:震动棒`，表内 `振動棒`／`バイブ` ⇒ **真阳性**） |
 * | `SOURCE` | 1,793 | **0** | **0** | **0** | **0** | **入库**（ALS-R2：按生产判据三盘 0/0/0，与 `MARK`/`DOWNBASE`/`STAIN` 同判据形态；旧记"残余 6"是探针口径，见"口径声明"） |
 * | `MAXBASE` | 823 | 21 | **0** | 0 | 0 | **候选·本批未入库**（无 `MAXBASE.csv`，名字全住 `BASE` 表：`['MAXBASE','BASE']` 判表外降到 0，三盘 warn 0；入库只需登记族头，**不需**扩 `ENGINE_VARIABLE_FAMILIES`——实测 `MAXBASE:具名` 今天就走表达式直通、零诊断。停在"生效族 = 九张"的交付口径，读数交 ALS 线） |
 * | `EX` | 1,068 | 3 | 3 | 3 | 2 | **不入库**（`.als` 一条也没替它消掉 ⇒ 零收益；残余见第 5 类） |
 * | `EXP` | 2,289 | 15 | 1 | 1 | 1 | **不入库**（残余 1 = `EXP:LOCAL`，第 1 类） |
 * | `PALAM` | 1,626 | 45 | 42 | 42 | **42** | **不入库**（42/42 = `PALAM:LOCAL`，第 1 类） |
 * | `ABL` | 8,245 | 26 | 7 | 2 | 0 | **不入库**（残余 2 = `ABL:TARGET`×1 + `ABL:MASTER`×1，被 E16 的"裸引擎全局"口径**放行成 0**，不是字典权威判出的 0；它真正的作者自定义名全靠 `.ERH` 常量兜住（`ABL:K17C_部位V`），而 FT-1 明令不收可写 `#DIM NAME = 351` ⇒ 登记后这类名字一出现就是误伤。读数交 ALS 线） |
 * | `TCVAR` | 8,427 | 172 | 68 | 9 | 9 | **不入库**（残余几乎全是自定义名 `TCVAR:K58C_…`，第 2 类；`*.ERH` 替它消掉 59 处） |
 * | `TALENT` | 69,038 | 547 | 60 | 60 | 3 | **不入库**（77 处作用域词 + 名称含全角 `／` 被切词，第 3 类） |
 * | `CFLAG` | 8,350 | **1,284** | 569 | 69 | 69 | **不入库**（残余 = 自定义名族 `CFLAG:K42C_結婚` 一类，第 2 类，非字典缺表） |
 * | `EQUIP` | 456 | 306 | 305 | 305 | 305 | **不入库**（残余 `EQUIP:下半身内衣` —— 表内是 `下半身内衣１`，全角数字被切词，第 3 类） |
 * | `ITEM` | 264 | 30 | 25 | 25 | 11 | **不入库**（自定义名 + 作用域词 + 异体名） |
 * | `DAY` | 1 | 1 | 1 | 1 | 1 | **不入库**（`DAY:晴朗`；且 `DAY.als` 名称段含行内 `;` 注释，见 adapter 测试） |
 * | `CSTR` | 18 | 0 | 0 | 0 | 0 | **不入库**（前后皆 0 ⇒ 入库零收益，样本仅 18 处） |
 * | `JUEL` `BUFF` `GOTJUEL` | 0 | — | — | — | — | **不入库**（本语料无真二段具名引用；`BUFF.als` 只存在于魔王改版） |
 *
 * 还有一类**别当候选**：盘上根本没有同名名称表的族头（`CALLNAME` 193,961 / `MASTERNAME` 269 /
 * `NAME` 73 / `CUP` 51 / `TRAINNAME` 3 处二段具名，判表外都是 0）——那 0 是"**无表 ⇒ 一律放行**"
 * 得来的（`nameTableKey` 找不到表就返回 undefined），不是字典判出来的，登记它们零收益。
 *
 * ### 口径声明（写给下一个读数的人；ALS-R2 把这句改到与判据同源）
 * **与生产判据同一条**：`ERB/口上・メッセージ関連` 全部 `.ERB` 的**非注释行**，用与转译器
 * 同一个标识符字符集（`identifier-chars.ts`）扫 `族头:具名` **恰好二段形**（名称段非纯数字），
 * 且**不计**被扫描器在 `:` 处截断的三段作用域写法（`SOURCE:LOCAL:(LOCAL:1)` 这类——
 * `unlistedFamilyName` 的"≥3 段一律放行"过去会被截词绕过，`expression.ts` 现按
 * "截断处仍是 `:` 就不核"堵住，ALS-R2）。本表**只取二段**，不再含三段截词。
 * 仍是**整行扫描**（含 `\@ … \@` 行内表达式与散文里的 `族头:名字` 字样）⇒ 处数是**上界**；
 * 转译器真正的报点只在表达式上下文。
 *
 * 与 ALS 批旧记 `前` 列的差额**全部**是那条截词：旧列 = 本表 `前` + 截断形态处数
 * （CFLAG 1,284+20=1,304 / TALENT 547+20=567 / TEQUIP 73+2=75 / PALAM 45+1=46 /
 * EXP 15+18=33 / SOURCE 0+6=6；`FLAG` 126、`TCVAR` 172、`ABL` 26、`NOWEX` 7、`MARK` 0、
 * `BASE` 711、`TFLAG` 46 无截断形态 ⇒ 逐字相同）。旧表把 `SOURCE:LOCAL` 计成 6 处判表外，
 * 生产判据下它们一律放行 ⇒ `SOURCE` 的残余是 **0** 而不是"作用域词 6 条"，按本表自己的判据**应入库**。
 *
 * ### 五类残余（逐条核过 `文件:行`，读数钉在 `family-name-source-tier.corpus.test.ts`）
 * 1. **作用域词当名称段**：`PALAM:LOCAL`×42 / `EXP:LOCAL`×1 / `ITEM:ARG`。
 *    `TARGET` `MASTER` `PLAYER` `ARG` `RESULT` 已在 `engine-globals.ts` 里、被"裸引擎全局"口径吸收；
 *    **`LOCAL` / `GETNUM` 不在那张表里**（PALAM 42 条 warn 全是它）。那是 E16 线的判据面
 *    （动它会改**裸标识符**属性/悬停命中集，且 `LOCAL` 是段块糖的信封槽），**本批不越线补**。
 *    注意 `SOURCE:LOCAL:(LOCAL:1)` 属**截断形态**、生产已不判 ⇒ 不再卡 `SOURCE` 入库（旧表那句作废）。
 * 2. **作者自定义名**：`CFLAG:K42C_結婚`×86、`TCVAR:K58C_胖次剥ぎ重複阻止`×18、`ABL:K17C_部位V`×2 等
 *    —— 住在角色目录 / 各自口上的 `#DIM` 里，游戏 `CSV/*.csv` 与 `*.als` 都不含它。
 *    **`.ERH` 具名常量（FT-1）已经吃掉一大块**：`CFLAG` 判表外 569→69、`TCVAR` 68→9、`ABL` 7→2。
 *    剩下的要治得加"每角色自定名表"这路数据源（**P-10③ 已立项的另一个方向**，不是本批）。
 * 3. **扫描器字符集截断**：表内名称含全角 `／`（`Talent.csv:24 开朗／阴郁`、`:150 幼児／幼児退行`）
 *    或全角数字（`Equip.csv:5 下半身内衣１`）时，`identifier-chars.ts` 在标点/全角数字处切词
 *    ⇒ 名称段被截成 `开朗` / `下半身内衣`，判表外。属**语言层字符集**口径（与本批正交），
 *    放宽它 = 把全角标点收进标识符（规范 §8 明令要检测的东西）⇒ 本批不动。
 * 4. **真阳性**：`TEQUIP:震动棒`（表内 `振动棒`→`振動棒`／`バイブ`，首字就不同）
 *    `M_KOJO_K55_絶頂.ERB:217`、`TCVAR:口服避孕药`（表内 `口服避孕薬`）—— 引擎本就取不到值，
 *    这类 warn 是功能在起作用，**不算误伤**。
 * 5. **名称段是变量而非常量名**（P-10③ 已有的 `NOWEX:i` 属这一类）：
 *    `IF NOWEX:i` 的 `i` 来自 `M_KOJO_K17_絶頂.ERB:64` 的 `FOR i,4,-1,-1`；
 *    `SIF EX:COUNT > EX:BEST` 的 `BEST` 来自同文件 `:4380` 的 `#DIM BEST`（映姫 K30_イベント.ERB:4395）。
 *    字典看不见符号表 ⇒ 这类形态**必然**判表外。`EX` 头因此**不入库**（它同时又是"`.als` 零收益"的头：
 *    前后都是 3 条）。要治它得让核对读别名/`#DIM` 声明，属另一条线。
 *
 * **全语料实际 warn 面（本批最终登记态 = 九张生效族）= 3 条 / 2,317 份 `.ERB`**：
 * `NOWEX:i`×2（第 5 类）+ `TEQUIP:震动棒`×1（第 4 类真阳性）。`SOURCE` 入库**一条都没加**
 * （判表外 0）。对比 P-10③ 交付时的 4 条：汉化追加名 `Ｖ绝顶`×4 已由 `ex.als` 归零
 * （`M_KOJO_K72_セクハラコマンド.ERB:5143/5164/5185/5206` `IF NOWEX:TARGET:Ｃ绝顶 || NOWEX:Ｖ绝顶`）。
 *
 * **另两张盘的对照读数**（同一探针、同一口径，2026-10-14；格式 `具名 / 前 / 中 / 现 / warn`）：
 * - **魔王改版**（38 份 `.csv` + 20 份 `.als`，2,370 份 `.ERB`）：九张生效族里
 *   `NOWEX` 5,317/9/3/3/2、`TEQUIP` 3,502/96/1/1/1、`SOURCE` 1,805/0/0/0/**0**、
 *   其余六张（`MARK` 11,162 / `BASE` 1,843 前 711 / `FLAG` 4,031 前 132 / `TFLAG` 1,271 前 43 /
 *   `DOWNBASE` 108 / `STAIN` 4）现与 warn **全 0** ⇒ 实际 warn 面同样 **3 条**；
 *   候选 `MAXBASE` 823/21/0/0/0。未入库族：`CFLAG` 8,493/1,326/561/61/61、`TALENT` 71,869/647/60/60/3、
 *   `TCVAR` 8,627/185/68/9/9、`PALAM` 1,708/45/42/42/42、`EQUIP` 474/324/323/323/323。
 * - **原生官方版 4.842**（25 份 `.csv`、**0 份 `.als`**，1,280 份 `.ERB`）：九张生效族的
 *   `中` 与 `现` 只差 `.ERH` 那一档 ⇒ `NOWEX` 3,877/2/2/2/2、`TEQUIP` 2,392/1/1/1/**1**、
 *   `SOURCE` 825/**0/0/0/0**、`MARK` 7,425/0、`BASE` 1,374/0、`FLAG` 2,772/0、`TFLAG` 607/0、
 *   `DOWNBASE` 29/0、`STAIN` 0 处 ⇒ 实际 warn 面 **3 条**（`NOWEX:i`×2 + `TEQUIP:震动棒`×1，
 *   同一个真 bug 也在这张盘里：`個人口上\聖\M_KOJO_K55_絶頂.ERB:205`）；候选 `MAXBASE` 525/0/0/0/0。
 *   `.als` 缺席时字典与改前**逐字一致**（`inputDigest` 相同的断言钉在 adapter 侧 corpus 测试里）。
 *
 * **R1（来源分层）的同盘读数**（名池 = 全部 `*.csv`+`*.als` 名称表的非纯数字名称键，
 * 期望归属 = 主表优先→追加表次之，`*.ERH` 常量不参与）：三盘名池 **6,254 / 6,580 / 2,768**，
 * 改前**改判 93 / 94 / 85** 处（追加表抢主表 1 处 = `憤怒` `TCVAR`→`Base.als` 的 `BASE`；
 * 常量抢主表 92 / 93 / 84 处，`教養` `ABL`→`ERB/DIM.ERH` 的 `CFLAG` 是其中一条），
 * 分层后 **改判 0 / 0 / 0**；追加名表新命中 **460 / 642 / 0** 条不少、
 * `.ERH` 的**具名→编号换算**仍覆盖 **92 / 93 / 84** 个名字（换算与拼错名核对都不受分层影响）。
 */
const CHECKED_FAMILY_NAME_TABLES: Readonly<Record<string, readonly string[]>> = {
  NOWEX: ['NOWEX', 'EX'],
  MARK: ['MARK'],
  DOWNBASE: ['DOWNBASE', 'BASE'],
  STAIN: ['STAIN'],
  // ↓ ALS 批（2026-10-14）：`CSV/*.als` 进字典后按上表读数放开（`BASE` 是既有表键，不新增数据源）
  BASE: ['BASE'],
  FLAG: ['FLAG'],
  TFLAG: ['TFLAG'],
  TEQUIP: ['TEQUIP'],
  // ↓ ALS-R2 批（2026-10-14）：`SOURCE` 按生产判据（只核二段形、截断的三段形不核）三盘
  //   判表外 **0/0/0** ⇒ 符合本表自述的入库判据（与 `MARK`/`DOWNBASE`/`STAIN` 同一形态）。
  //   旧读数"残余 6/6 = `SOURCE:LOCAL`"是**探针口径**产物（把 `SOURCE:LOCAL:(LOCAL:1)`
  //   这类三段作用域写法截成二段来判），生产判据下它本就该放行——见下表的"口径"一句。
  SOURCE: ['SOURCE'],
};

/** 字典 `lookup` 的"真正收录"判据（与 `resolveFamily` 同一口径，不另立标准） */
function isRecorded(info: { description?: string; resolvedIndex?: number } | undefined): boolean {
  return info !== undefined && (info.description !== undefined || info.resolvedIndex !== undefined);
}

/**
 * 名称索引的**建档门槛**（真实线性扫次数）：扫到这么多次才付一次建表成本。
 * 依据（本机微基准，见 `tests/hotpath-bench.test.ts`）：单次线性扫 ~1–2µs，
 * 建表（Σ|names| 次 lookup）~亚毫秒—数毫秒 ⇒ 稀疏查询（小额文档 / 少量属性）
 * 永远走"扫 + 记忆"，稠密会话（多文件、名字面广）建表后全额摊还。
 */
const INDEX_BUILD_AFTER_SCANS = 64;

/** 回退扫结果记忆上限（含负结果；防超长会话里错名无限积累） */
const FALLBACK_MEMO_MAX = 4096;

/**
 * 条目所属的**来源层**（族归属用；ALS-R1）。
 *
 * - `'const'` → `undefined`：作者自定具名常量**不参与族归属**（同一个名字可以写在任意族
 *   后面，宣称归属就是猜）；
 * - `'append'` → 追加名表：只在主表一轮都不中时才用它；
 * - `'primary'` **与缺省**（旧字典不标源）→ 主表：第一优先。
 *   缺省按主表处理 ⇒ 不标源的字典行为与今天**逐字相同**（契约 additive 的另一半）。
 * 未收录（`undefined` / 只回显）同样返回 `undefined`，与 `isRecorded` 同一口径。
 */
function familySourceTier(info: VariableInfo | undefined): 'primary' | 'append' | undefined {
  if (info === undefined || !isRecorded(info)) return undefined;
  if (info.source === 'const') return undefined;
  return info.source === 'append' ? 'append' : 'primary';
}

export function makeLookup(schema: VariableSchema): DictionaryLookup {
  /**
   * 生效族的**名称表键**：按上面登记的候选依次找（族名自己 → 引擎层同名表姊妹族）；
   * 一张都不在位 → undefined（= 无表 = 不许校验，正是 `service.ts` 头注
   * "字典未加载不误伤"的口径；未登记的族头同样直接返回 undefined）。
   */
  const nameTableKey = (family: string): string | undefined => {
    for (const key of CHECKED_FAMILY_NAME_TABLES[family] ?? []) {
      // 无索引的 lookup：表存在必回一条（哪怕只有变量名），表不存在回 undefined
      if (schema.lookup(key) !== undefined) return key;
    }
    return undefined;
  };

  /**
   * 名称 → 族 的**惰性索引**（L2 批；命中路径由"每名 22 族线性扫"改 O(1) 查）。
   *
   * ## 为什么是"正表 + 精确回退"两段而不是纯索引
   *
   * 枚举面 = `schema.names(family)`（KC-1 的可选枚举能力；eratw 实现走 `byIndex`
   * 的**值**）。但 `lookup` 还能命中 `byName` 独有的别名（同编号重名行，如
   * `Base.als` 的 `10,情绪` + `10,情緒`——`byIndex` 只留首个、`byName` 两个都收），
   * 那类名字**不在枚举面内**。故：
   * - 枚举面内 ⇒ 正表 O(1)（tier 由**与线性扫逐字相同的** `lookup + familySourceTier`
   *   判定，族表顺序即优先级、primary 压 append ⇒ 与改前逐位等价）；
   * - 枚举面外 ⇒ **精确回退线性扫**（原口径），并把结果记忆到 `fallbackMemo`
   *   （含 undefined——负结果也记忆，同一错名不再重复 22 族扫）。
   *
   * ## 建表时机（门槛门控）
   *
   * 累计**真实线性扫**达到 `INDEX_BUILD_AFTER_SCANS` 次才建表——小额/稀疏文档
   * （属性解析寥寥）永远走"扫 + 记忆"、不付建表账；稠密会话建表后摊还。
   * `names()` 缺席（旧 schema 形态）⇒ 建表返回 null，行为与改前逐字相同
   * （回退记忆仍生效）。
   *
   * 生命周期 = `makeLookup` 产物（随代际 memo 复用）⇒ 建表账每个项目代际只付一次。
   */
  let familyIndex: { primary: Map<string, string>; append: Map<string, string> } | null | undefined;
  let scansSeen = 0;
  /** 回退扫结果记忆（含负结果；上限防超长会话积累） */
  const fallbackMemo = new Map<string, string | undefined>();

  const buildFamilyIndex = (): { primary: Map<string, string>; append: Map<string, string> } | null => {
    if (typeof schema.names !== 'function') return null;
    const primary = new Map<string, string>();
    const append = new Map<string, string>();
    for (const family of ENGINE_VARIABLE_FAMILIES) {
      for (const info of schema.names(family) ?? []) {
        const name = info.name;
        if (name.length === 0) continue;
        const tier = familySourceTier(schema.lookup(family, name));
        if (tier === 'primary') {
          if (!primary.has(name)) primary.set(name, family); // 族表顺序即优先级（首个命中胜）
        } else if (tier === 'append') {
          if (!append.has(name)) append.set(name, family);
        }
      }
    }
    return { primary, append };
  };

  /** 线性扫（建档前 / 枚举面外 / 无枚举能力时的原口径） */
  const resolveFamilyLinear = (name: string): string | undefined => {
    let appendHit: string | undefined;
    for (const family of ENGINE_VARIABLE_FAMILIES) {
      // lookup 在"表不存在 / 名称不在表内"时返回 undefined 或仅回显 name；
      // 只有**真正收录**（description 或 resolvedIndex 落地）才算命中。
      const tier = familySourceTier(schema.lookup(family, name));
      if (tier === 'primary') return family;
      if (tier === 'append' && appendHit === undefined) appendHit = family;
    }
    return appendHit;
  };

  return {
    resolveFamily(name: string): string | undefined {
      // 两轮（ALS-R1）：主表优先，追加名表只在主表一轮都不中时才给出归属；
      // `'const'`（`.ERH` 具名常量）不参与——它照样让 `lookup` 换算编号（快照回放 /
      // 别名 / 具名索引），但不再宣称"这个名字属于哪个族"。
      // 同层内仍是族表顺序即优先级（首个命中即返回，与改前同一确定性口径）。
      //
      // L2：正表 O(1)（建表有门槛）；枚举面外走精确回退扫 + 结果记忆（含负结果）。
      if (familyIndex === undefined && scansSeen >= INDEX_BUILD_AFTER_SCANS) {
        familyIndex = buildFamilyIndex(); // 扫描量证明工作量足够，建表摊销
      }
      if (familyIndex) {
        const hit = familyIndex.primary.get(name) ?? familyIndex.append.get(name);
        if (hit !== undefined) return hit;
      }
      const memo = fallbackMemo.get(name);
      if (memo !== undefined || fallbackMemo.has(name)) return memo;
      const result = resolveFamilyLinear(name);
      if (scansSeen < INDEX_BUILD_AFTER_SCANS) scansSeen++;
      if (fallbackMemo.size < FALLBACK_MEMO_MAX) fallbackMemo.set(name, result);
      return result;
    },
    resolve(ident: string): string | undefined {
      // 原生 ERB 变量引用（`CFLAG:2` 形态）与引擎族名——原样保留。
      // **注意**：无族头的**裸引擎全局**（`SELECTCOM` / `PREVCOM` / `ARG` …）不在这里判
      // ——它们不属字典（CSV 建不出"引擎自带标量"这张表），且字典本身是可选注入的，
      // 寄生在这里会让"没打开项目时又写不了"。判据与实测计数见 `engine-globals.ts`，
      // 生效点在 `expression.ts` 的 `resolveBareIdentifier`（E16 批，2026-10-14）。
      // 同一条"可选注入"纪律也约束着具名索引核对——它**不在这里**报（`resolve` 只能
      // 返回原文或 undefined，返回 undefined 会被调用方报成 error），走
      // `unlistedFamilyName`（P-10③，warning 起步）。
      const head = ident.split(':')[0]!.toUpperCase();
      if (ENGINE_VARIABLE_FAMILIES.includes(head)) return ident;
      return undefined;
    },
    unlistedFamilyName(ident: string): { family: string; name: string } | undefined {
      // 只核 `族头:名称` **二段形**（P-10③ 的病根形态）。三段及以上（`CFLAG:TARGET:好感度`、
      // `NOWEX:PLAYER:11`）混着作用域语义，本批不碰——实测它们的表外率高，误伤面大。
      const sep = ident.indexOf(':');
      if (sep <= 0 || ident.indexOf(':', sep + 1) >= 0) return undefined;
      const family = ident.slice(0, sep).toUpperCase();
      const name = ident.slice(sep + 1);
      if (name.length === 0) return undefined;
      // 生效族 = 上面按实测表权威登记的那几张（未登记的族头逐字保持今天的放行）
      if (CHECKED_FAMILY_NAME_TABLES[family] === undefined) return undefined;
      // 纯数字索引是引擎合法写法（`CFLAG:1088`），没有"名称表"可核 ⇒ 放行
      if (/^[0-9]+$/.test(name)) return undefined;
      const table = nameTableKey(family);
      if (table === undefined) return undefined; // 无表则放行
      if (isRecorded(schema.lookup(table, name))) return undefined; // 表内 ⇒ 放行
      return { family, name };
    },
    nameAt(family: string, index: string): string | undefined {
      // 反向查询（升糖投影的属性反糖用）：`lookup(族, 索引).description` 即名称源。
      // 依据 adapter `variable-schema.ts`：编号索引 → `description = byIndex.get(编号)`；
      // 具名索引 → `description = 名称本身`；**未收录 → 无 description**（不猜）。
      const info = schema.lookup(family, index);
      const name = info?.description;
      return name !== undefined && name.length > 0 ? name : undefined;
    },
    bitIndexOf(variableName: string, bitLabel: string): number | undefined {
      // 位名 → 引擎位号（v1.8）。只认 `族头:…:索引`（**索引 = 末段**；中间的作用域词
      // 如 `TARGET` / `MASTER` / 角色号跳过），族头必须是引擎变量族。位表数据由 adapter
      // 挂在 `lookup(族, 索引).bits` 上（`variable-schema.withBits`，KC-1b）——
      // 本方法**零游戏知识**：只按 `label` 整词精确匹配；查无 / 同一位表内多枚同名（歧义）
      // ⇒ `undefined`（不猜）。
      const segs = variableName.split(':');
      if (segs.length < 2) return undefined;
      const family = segs[0]!.toUpperCase();
      if (!ENGINE_VARIABLE_FAMILIES.includes(family)) return undefined;
      const index = segs[segs.length - 1]!;
      if (index.length === 0) return undefined;
      const bits = schema.lookup(family, index)?.bits;
      if (bits === undefined) return undefined;
      let hit: number | undefined;
      for (const b of bits) {
        if (b.label !== bitLabel) continue;
        if (hit !== undefined) return undefined; // 同一位表内多枚同名 → 歧义（不猜）
        hit = b.bit;
      }
      return hit;
    },
    // 家族头中文别名（D2）：直接转发 adapter 的 `familyAlias` / `familyAliasReverse`
    // （单一真源，本包零硬编码）；**adapter 未提供 ⇒ 不挂**（消费方据 `undefined` 不替换，不猜）。
    ...(schema.familyAlias
      ? { familyAlias: (name: string) => schema.familyAlias!(name) }
      : {}),
    ...(schema.familyAliasReverse
      ? { familyAliasReverse: (family: string) => schema.familyAliasReverse!(family) }
      : {}),
  };
}

export {
  sugarEditorLexicon,
  SUGAR_LEXICON_WORDS,
  SUGAR_LEXICON_OPERATORS,
  SUGAR_KEYWORD_ROLE_LABEL,
  RESERVED_PRONOUNS,
  CONT_MARKS,
  // KC-2b：时机命名参数键表（单一真源）——宿主 Monaco 补全从本包派生键/取值候选。
  TIMING_NAMED_PARAMS,
  TIMING_ARG_TOKENS,
  // v1.7：实参令牌中文主形（`参数:` 补全面板据引擎记号**派生**展示，编辑器侧零硬编码）。
  argTokenCnLabel,
  type TimingNamedParamSpec,
  type TimingParamValueSource,
  type SugarEditorLexicon,
  type SugarKeywordRole,
  type SugarLexiconWord,
} from './keywords';
export { createSugarTranspileService, type CreateSugarServiceOptions } from './service';
// HK-11①：系统函数中文别名（单一真源）——宿主 Monaco 层从本包派生高亮/补全。
// ZH-F1：另导出查表/收录判定（中文函数名 → 原生 ERB 名；系统表 + adapter 表）。
export {
  SYSTEM_FUNCTION_ALIASES,
  SYSTEM_FUNCTION_REVERSE,
  lowerSystemFunctions,
  lookupFunctionName,
  isKnownFunctionName,
} from './system-functions';
// v1.7：行首语句形中文函数调用白名单（位糖 = 方案 E；单一真源）。
export { STATEMENT_FUNCTIONS } from './statement-functions';
// ZH-D3：悬停反查（中文 → 原生形态）要拼时机函数名——**复用转译器同一条命名链**
// （规范 §5.5 的 `{t}` / `{n}` / `{i}` 求值只此一份实现），宿主侧不得另拼字符串。
// additive 纯再导出：`codegen.ts` 本体零改动、旧消费方零改动。
export { buildFunctionName } from './codegen';

// ZH-D4 回车层级（纯判型 + 由词表派生的回车正则族；宿主 Monaco 只做协议翻译）
export {
  sugarEnterIndentAfter,
  sugarEnterRulePatterns,
  type SugarEnterRulePatterns,
} from './enter';
// E16：裸引擎全局白名单（`SELECTCOM`/`PREVCOM`/…；判据与实测计数在模块头注）
export { ENGINE_GLOBAL_IDENTIFIERS, resolveEngineGlobal } from './engine-globals';
export {
  createSugarPreviewService,
  foldMessageBlocks,
  foldReachability,
  isEnvelopeChain,
  isStructuralLine,
  preview,
  scanProductFunctions,
  sourceLinesOf,
  type PreviewDeps,
} from './preview';
export type { AliasEntry, AliasTable, DictionaryLookup } from './types';
export { createSugarLiftService, liftSuggest, type LiftDeps } from './lift';
export { liftProject } from './project';
export {
  applyLift,
  applyLiftToFile,
  createSugarLiftApplyService,
  type LiftApplyDeps,
} from './lift-apply';
// 转到定义（2026-10-15 语言服务批；纯函数，转译与索引由装配层注入）
export { findGeneratedHeaderLine, resolveKojoDefinition, type KojoDefinitionDeps } from './definition';
// E1/E2 文档格式化（Shift+Alt+F 与「保存时格式化」共用同一真源；纯函数、零 IO）
export {
  applyFormatEdits,
  computeFormatEdits,
  formatText,
  type FormatDialect,
  type FormatEdit,
} from './formatter';

// 结构化着色（B6，2026-10-16；纯函数，糖 AST 与缓冲区文本进、着色 span 出）
export { kojoSemanticTokens } from './semantic-tokens';
