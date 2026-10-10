/**
 * @kojo/plugin-state-replay
 *
 * 状态回放插件（服务 `state.replay`；v0.2 第五批 / v1.0 主体先行）。
 *
 * 分层（"一切皆插件"）：
 * - 本插件 = 回放编排 + Emuera 变量寻址语义 + 三值求值（**引擎级语言知识**，零游戏知识）；
 * - 谓词明细来自 **condition.extractor**（按需解析，不重复实现表达式解析）；
 * - 存档模型来自 **snapshot.source**（不重复实现二进制协议）；
 * - 具名索引字典（`TALENT:恋慕` → 3）来自 **game adapter** 的 `variableSchema`
 *   经槽位查询 + `project.adapterId` 过滤后提供——本插件只消费，不解释。
 *
 * 近似定位（架构文档 §5.3）：不执行函数、不模拟随机；能力边界全部
 * 降级为显式 `unknown`（原因分类）——置信度三档由此而来。
 */

import type {
  ConditionExtractorService,
  FileIO,
  Plugin,
  ProjectService,
  SlotRegistry,
  SnapshotSourceService,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { StateReplayEngine } from './engine';
import type { SchemaLookup } from './state-view';

export function createStateReplayPlugin(): Plugin {
  return {
    id: 'state-replay',
    version: '0.2.0',
    provides: [WellKnownServices.StateReplay],
    requires: [
      KernelServices.Project,
      KernelServices.Slots,
      KernelServices.IO, // v0.2 第七批：内联求值需要函数体行文本
      WellKnownServices.SnapshotSource,
      WellKnownServices.ConditionExtractor,
    ],
    activate(ctx) {
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      const slots = ctx.inject<SlotRegistry>(KernelServices.Slots);
      const io = ctx.inject<FileIO>(KernelServices.IO);
      const snapshot = ctx.inject<SnapshotSourceService>(WellKnownServices.SnapshotSource);
      const extractor = ctx.inject<ConditionExtractorService>(WellKnownServices.ConditionExtractor);

      /** 当前适配器的具名索引字典（按 adapterId 精确匹配；多适配器共存天然正确） */
      const schemaLookup = (): SchemaLookup | undefined => {
        const current = project.current();
        if (!current) return undefined;
        for (const contribution of slots.query('game.adapter')) {
          if (contribution.adapter.gameId !== current.adapterId) continue;
          const vs = contribution.adapter.variableSchema;
          if (vs) return (name: string, index?: number | string) => vs.lookup(name, index);
        }
        return undefined;
      };

      const engine = new StateReplayEngine({
        log: ctx.log,
        parseArchive: (path: string) => snapshot.parse(path),
        functionPredicates: (name: string) => extractor.functionPredicates(name),
        getSchemaLookup: schemaLookup,
        readFileText: async (path: string) => (await io.readText(path)).text,
      });

      ctx.provide(WellKnownServices.StateReplay, engine);

      // 缓存生命周期：项目切换 / 索引重建 → 函数体与明细可能已变，清空内联与文本缓存
      ctx.onDispose(ctx.bus.on('kojo.functionChanged', () => engine.resetCaches()));
      ctx.onDispose(ctx.bus.on('project.closed', () => engine.resetCaches()));
    },
  };
}

export { StateReplayEngine, replayPredicates, type StateReplayEngineDeps } from './engine';
export { createStateView, ReplayViewError, type CreateStateViewOptions, type SchemaLookup } from './state-view';
export { judgeCondition, evaluateExpr, type ValueReader, type EvalContext, type CallResolver } from './evaluate';
export { InlineManager, analyzeInlineBody, MAX_INLINE_DEPTH, type AnalyzedFunction, type InlineBody } from './inline';
export { buildBranchOutcomes } from './branches';
export {
  builtinVarModel,
  isCalcPseudo,
  isKnownCharaVariable,
  isKnownGlobalVariable,
  isLanguageLocal,
  varShapeFromArchiveType,
  type VarModel,
} from './var-model';
