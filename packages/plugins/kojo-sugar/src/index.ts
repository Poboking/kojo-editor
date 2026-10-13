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
  ErbParserService,
  FileIO,
  GameProject,
  KojoFaceTable,
  KojoInstructionTable,
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
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { createSugarTranspileService } from './service';
import { createSugarPreviewService } from './preview';
import { createSugarLiftService } from './lift';
import { createSugarLiftApplyService } from './lift-apply';
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
       * `erb.parser` 的 `scanControlFlow`（S5 批，软取）——提升建议的**结构**判据。
       *
       * 软取的理由同上：结构扫描缺席只该让提升建议退化为"内置最小扫描"，
       * 不该让整个 kojo-sugar 静默 inactive。
       */
      const scanFlowOf = (): ((text: string) => ControlFlowStatement[]) | undefined => {
        try {
          const parser = ctx.inject<ErbParserService>(WellKnownServices.ErbParser);
          return (text: string) => parser.scanControlFlow(text);
        } catch {
          return undefined;
        }
      };

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
       * 当前适配器的变量字典（按 adapterId 精确匹配；多适配器共存天然正确）。
       *
       * 每次 `transpile` 调用时才查询——适配器可能在项目切换后重建 schema，
       * 转译服务本身保持无状态（纯函数语义）。
       */
      const dictionaryOf = (): DictionaryLookup | undefined => {
        const current: GameProject | null = project.current();
        if (!current) return undefined;
        for (const contribution of slots.query('game.adapter')) {
          if (contribution.adapter.gameId !== current.adapterId) continue;
          const vs: VariableSchema | undefined = contribution.adapter.variableSchema;
          if (vs) return makeLookup(vs);
        }
        return undefined;
      };

      /**
       * 当前适配器的**时机分野模板表**（游戏知识；`KojoFaceTable`）。
       *
       * 与 `dictionaryOf` 同源同生命周期（按 `adapterId` 精确匹配 `game.adapter`
       * 槽位）。缺省 = 该适配器未声明 → 转译含 `时机` 块的文档时报
       * `timing-face-unknown`（**fail-closed**，绝不回退到内建模板——回退就是
       * 把游戏知识搬回通用插件，正是本批要根除的）。
       */
      const faceTableOf = (): KojoFaceTable | undefined => {
        const current: GameProject | null = project.current();
        if (!current) return undefined;
        for (const contribution of slots.query('game.adapter')) {
          if (contribution.adapter.gameId !== current.adapterId) continue;
          if (contribution.adapter.kojoFaceTemplates) return contribution.adapter.kojoFaceTemplates;
        }
        return undefined;
      };

      /**
       * 当前适配器的**指令名表**（游戏知识；`KojoInstructionTable`；HK-11②）。
       *
       * 与 `faceTableOf` 同源同生命周期（按 `adapterId` 精确匹配 `game.adapter`
       * 槽位；表内容随项目的 `CSV/Train.csv` 变化）。缺省 = 该适配器未声明 →
       * `时机 指令 <中文名>：` 报 `timing-instruction-unknown`（**fail-closed**，
       * 绝不猜——数字编号路径不受影响，逐字节保持旧行为）。
       */
      const instructionTableOf = (): KojoInstructionTable | undefined => {
        const current: GameProject | null = project.current();
        if (!current) return undefined;
        for (const contribution of slots.query('game.adapter')) {
          if (contribution.adapter.gameId !== current.adapterId) continue;
          if (contribution.adapter.kojoInstructionTable) return contribution.adapter.kojoInstructionTable;
        }
        return undefined;
      };

      /** 统一的转译器构造（字典 + 分野表 + 指令表同源注入；保证各路径行为一致） */
      const makeTranspiler = (
        deps?: Omit<
          Parameters<typeof createSugarTranspileService>[0],
          'dictionary' | 'faceTable' | 'instructionTable'
        >,
      ) =>
        createSugarTranspileService({
          dictionary: dictionaryOf(),
          faceTable: faceTableOf(),
          instructionTable: instructionTableOf(),
          ...(deps ?? {}),
        });

      const service: SugarTranspileService = {
        parse: (source, options) => makeTranspiler().parse(source, options),
        transpile: (source, options) => makeTranspiler().transpile(source, options),
        sourceOf: (result, generatedLine) =>
          createSugarTranspileService().sourceOf(result, generatedLine),
        // S3：编译落盘一体——转译（带当前 adapter 字典+分野表）+ 双闸写 + 备份 + 回读
        compileToFile: (source, targetPath, options) =>
          makeTranspiler({ io, log: ctx.log }).compileToFile(source, targetPath, options),
        // 导出批：内存编译（零 IO，故不注入 io）——与 compileToFile 共用守卫与编码组装
        compileToBytes: (source, options, targetLabel) =>
          makeTranspiler().compileToBytes(source, options, targetLabel),
        // S7：保存前置检查（纯函数）——推导目标 + 转译 + 全角空格告警，同一转译器
        planSave: (request) => makeTranspiler().planSave(request),
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
    },
  };
}

/**
 * 把 adapter 的 `VariableSchema` 适配为转译器的 `DictionaryLookup`（只读消费）。
 *
 * - `resolveFamily(name)`：变量名字 → 族名。策略：按引擎变量族表逐个
 *   `lookup(FAMILY, name)`，命中即返回该族（**命中不唯一时返回首个**——
 *   规范 §3.8 说"命中不唯一时编辑器弹窗"，那是 S4 编辑体验批的职责；
 *   转译器此处取**确定性**首个命中，不静默猜测顺序之外的语义）；
 * - `resolve(ident)`：裸标识符 → 原样（引擎变量表已收录的族名 + 冒号索引
 *   写法本就合法，不需要改写）。
 */
const ENGINE_VARIABLE_FAMILIES: readonly string[] = [
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

function makeLookup(schema: VariableSchema): DictionaryLookup {
  return {
    resolveFamily(name: string): string | undefined {
      for (const family of ENGINE_VARIABLE_FAMILIES) {
        const info = schema.lookup(family, name);
        // lookup 在"表不存在 / 名称不在表内"时返回 undefined 或仅回显 name；
        // 只有**真正收录**（description 或 resolvedIndex 落地）才算命中。
        if (info && (info.description !== undefined || info.resolvedIndex !== undefined)) {
          return family;
        }
      }
      return undefined;
    },
    resolve(ident: string): string | undefined {
      // 原生 ERB 变量引用（`CFLAG:2` 形态）与引擎族名——原样保留
      const head = ident.split(':')[0]!.toUpperCase();
      if (ENGINE_VARIABLE_FAMILIES.includes(head)) return ident;
      return undefined;
    },
    nameAt(family: string, index: string): string | undefined {
      // 反向查询（升糖投影的属性反糖用）：`lookup(族, 索引).description` 即名称源。
      // 依据 adapter `variable-schema.ts`：编号索引 → `description = byIndex.get(编号)`；
      // 具名索引 → `description = 名称本身`；**未收录 → 无 description**（不猜）。
      const info = schema.lookup(family, index);
      const name = info?.description;
      return name !== undefined && name.length > 0 ? name : undefined;
    },
  };
}

export {
  sugarEditorLexicon,
  SUGAR_LEXICON_WORDS,
  SUGAR_LEXICON_OPERATORS,
  SUGAR_KEYWORD_ROLE_LABEL,
  RESERVED_PRONOUNS,
  CONT_MARKS,
  type SugarEditorLexicon,
  type SugarKeywordRole,
  type SugarLexiconWord,
} from './keywords';
export { createSugarTranspileService, type CreateSugarServiceOptions } from './service';
// HK-11①：系统函数中文别名（单一真源）——宿主 Monaco 层从本包派生高亮/补全
export { SYSTEM_FUNCTION_ALIASES, lowerSystemFunctions } from './system-functions';
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
