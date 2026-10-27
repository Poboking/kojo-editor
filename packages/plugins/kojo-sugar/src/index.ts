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
 *   **game adapter**（经契约的 `activeGameAdapter` 认出当前那枚后注入转译器）——
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
  VariableSchema,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices, activeGameAdapter, resolveSugarTarget } from '@kojo/plugin-api';
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
import { makeLookup } from '@kojo/kojo-vocab/engine';
import type { DictionaryLookup } from '@kojo/kojo-vocab/types';

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
        // 「谁是当前那枚」由契约的 `activeGameAdapter` 认。六张表**全部取自同一枚**
        // adapter ⇒ 结构上排除了「A 表来自这枚、B 表来自那枚」的错配。
        const adapter = activeGameAdapter(slots.query('game.adapter'), current.adapterId);
        return {
          adapterId: current.adapterId,
          projectRoot: current.rootDir,
          inputDigest: current.inputDigest,
          variableSchema: adapter?.variableSchema,
          faceTable: adapter?.kojoFaceTemplates,
          instructionTable: adapter?.kojoInstructionTable,
          libraryTable: adapter?.kojoLibraryTable,
          mutatorTable: adapter?.kojoMutatorTable,
          counterTable: adapter?.kojoCounterTable,
        };
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
 * 引擎变量族表与 `makeLookup` 的**真源已迁走**（LAU-3b 解耦批，2026-10-27）：
 * `@kojo/kojo-vocab/engine`。它们是 ERB 语言层的事实，不属于 kojo1 的转译器——
 * 本包只剩 v1 转译管线；这里转发只为既有消费方（本包内部 + 旧测试）零改动。
 */
export { ENGINE_VARIABLE_FAMILIES, makeLookup } from '@kojo/kojo-vocab/engine';

/**
 * 具名索引核对的生效族与来源分层规则**已随 `makeLookup` 迁到**
 * `@kojo/kojo-vocab/engine`（LAU-3b 解耦批）；原件读数见该批之前的 git 历史与
 * `packages/plugins/kojo-sugar/tests/family-name-*.test.ts`。
 */

/* makeLookup 的真源已迁到 `@kojo/kojo-vocab/engine`（LAU-3b 解耦批）；本包只转发。 */

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
// ERB-ENTER-RULES（2026-10-21）additive 再导出：`enterRulePatternsFromRoles` 是**同一套**
// 正则装配的通用形，`.erb` 由宿主喂引擎配对表派生的角色词表进来 ⇒ 两门一等语言共用一张派生表。
export {
  sugarEnterIndentAfter,
  sugarEnterRulePatterns,
  enterRulePatternsFromRoles,
  type EnterRoleVocabulary,
  type EnterRulePatterns,
  type SugarEnterRulePatterns,
} from './enter';
// SUGGEST-2A：行分类单一真源（宿主 `.kojo` 原生区判定用）——判型 / 切行与转译器、回车缩进
// 同一份实现；宿主不得在 app 层重写原生行正则（additive 纯再导出，旧消费方零改动）。
export { classifyLine, splitLogicalLines, type LineClass, type LogicalLine } from './lexer';
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
// `erbBodyRegionAtLineEnd` = 块状态机（`erbBodyLineMask` 同一趟扫描）的**末态**投影，
// 只多导这一条：宿主的窗口取文腿拿到的是切片文本，看不见起点之上的开词就会去改整篇腿
// 明确保护的字节，而它必须问"喂完前缀后停在哪"才谈得上同判据——自己写一份块状态就是第二份真相。
export {
  applyFormatEdits,
  computeFormatEdits,
  computeRangeFormatEdits,
  erbBodyRegionAtLineEnd,
  // 单行窗口的块上下文（additive）：宿主 on-type 腿按**行数组**喂前缀，判据仍只走
  // `erbBodyLineMask` / `erbIndentPlan` 这一套（`formatter.ts` 里与 `computeRangeFormatEdits` 同源）
  erbNewContentWithPrefix,
  formatText,
  type ErbBodyRegionKind,
  type FormatDialect,
  type FormatEdit,
  type RangeFormatContext,
} from './formatter';

// 结构化着色（B6，2026-10-16；纯函数，糖 AST 与缓冲区文本进、着色 span 出）
export { kojoSemanticTokens } from './semantic-tokens';

// Kojo 2.0 并存层（开发期新增导出；**不改** v1 注册/requires/provides，也不抢
// `sugar.transpile` 键——2.0 由宿主显式选用）。adapter/backend 全由调用方注入，
// 本包仍零游戏知识、零插件交叉 import（解耦审计 B/C 项）。
export {
  createKojo2TranspileService,
  type Kojo2CompileFn,
  type Kojo2CompileRequest,
  type Kojo2CompileResult,
  type Kojo2TranspileDeps,
  type Kojo2TranspileInput,
  type Kojo2TranspileService,
} from './kojo2/index.js';
