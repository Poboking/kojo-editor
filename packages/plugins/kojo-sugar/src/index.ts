/**
 * @kojo/plugin-kojo-sugar
 *
 * 语法糖转译插件（服务 `sugar.transpile`；v0.3 批 S2 转译内核 + S3 编译落盘）。
 *
 * 分层（"一切皆插件"）：
 * - 本插件 = 三段式转译器（行式词法 → AST → codegen）——**引擎级语言知识**
 *   （中文表层关键字是跨游戏语言层，契约 `sugar.ts` 头注已定调），零游戏知识；
 * - 变量字典 / 时机分野命名模板来自 **game adapter**（经槽位查询 +
 *   `project.adapterId` 过滤后注入转译器）——本插件只消费，不解释；
 * - 编译落盘（S3 批）：`compileToFile` 走**内核 io 第一道闸**（writablePaths）
 *   + 备份 + 回读验证（安全顺序见 `compile.ts` 头注，复刻注入器范式）；
 *   `parse`/`transpile`/`sourceOf` 仍为纯函数。
 */

import type {
  FileIO,
  GameProject,
  Plugin,
  ProjectService,
  SlotRegistry,
  StateReplayService,
  SugarPreviewService,
  SugarTranspileService,
  VariableSchema,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { createSugarTranspileService } from './service';
import { createSugarPreviewService } from './preview';
import type { DictionaryLookup } from './types';

export function createKojoSugarPlugin(): Plugin {
  return {
    id: 'kojo-sugar',
    version: '0.3.0',
    provides: [WellKnownServices.SugarTranspile, WellKnownServices.SugarPreview],
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

      const service: SugarTranspileService = {
        parse: (source, options) => createSugarTranspileService({ dictionary: dictionaryOf() }).parse(source, options),
        transpile: (source, options) =>
          createSugarTranspileService({ dictionary: dictionaryOf() }).transpile(source, options),
        sourceOf: (result, generatedLine) =>
          createSugarTranspileService().sourceOf(result, generatedLine),
        // S3：编译落盘一体——转译（带当前 adapter 字典）+ 双闸写 + 备份 + 回读
        compileToFile: (source, targetPath, options) =>
          createSugarTranspileService({ dictionary: dictionaryOf(), io, log: ctx.log }).compileToFile(
            source,
            targetPath,
            options,
          ),
      };

      ctx.provide(WellKnownServices.SugarTranspile, service);

      /**
       * 预览服务（S4 批）——**只读数据层**：转译复用上表同一个转译器
       * （同 adapter 字典），回放软取 `state.replay`，产出三向映射。
       *
       * 事件纪律：预览**不发射任何事件**（`file.changed` 等由内核 io 监视器
       * 产生；预览只消费）。故此处不注册任何 `ctx.bus.on`。
       */
      const previewService: SugarPreviewService = createSugarPreviewService({
        transpile: (source, options) =>
          createSugarTranspileService({ dictionary: dictionaryOf() }).transpile(source, options),
        ...(replayOf() ? { replay: replayOf()! } : {}),
        io,
        log: ctx.log,
      });

      ctx.provide(WellKnownServices.SugarPreview, previewService);
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
  };
}

export { createSugarTranspileService, type CreateSugarServiceOptions } from './service';
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
