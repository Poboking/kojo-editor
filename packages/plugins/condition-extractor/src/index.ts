/**
 * @kojo/plugin-condition-extractor
 *
 * 条件谓词抽取插件（服务 `condition.extractor`）。
 *
 * 分层（"一切皆插件"）：
 * - 本插件 = 引擎 + 表达式解析（零游戏知识）；
 * - 变量语义（如"哪个编号是好感度"）由 **game adapter** 的 `variableSchema`
 *   经槽位查询 + `project.adapterId` 过滤后提供——本插件只做透传标注，不解释；
 * - 控制流骨架来自 **erb.parser** 服务（`scanControlFlow`），不重复实现扫描。
 *
 * 无项目 / 索引未就绪时返回空索引（形状稳定，UI 无需分支判空）。
 */

import type {
  ComputePool,
  ConditionExtractorService,
  ControlFlowStatement,
  ErbParserService,
  FileIO,
  GameProject,
  Plugin,
  ProjectService,
  SlotRegistry,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { ConditionEngine } from './engine';
import type { SchemaLookup } from './extract';

const IO = 'kernel.io';
const PROJECT = 'kernel.project';
const SLOTS = 'kernel.slots';

export function createConditionExtractorPlugin(): Plugin {
  return {
    id: 'condition-extractor',
    version: '0.2.0',
    provides: [WellKnownServices.ConditionExtractor],
    requires: [IO, PROJECT, SLOTS, KernelServices.Compute, WellKnownServices.ErbParser],
    activate(ctx) {
      const io = ctx.inject<FileIO>(IO);
      const project = ctx.inject<ProjectService>(PROJECT);
      const slots = ctx.inject<SlotRegistry>(SLOTS);
      const parser = ctx.inject<ErbParserService>(WellKnownServices.ErbParser);
      // 全量抽取是背景 CPU 洪水（~6.2 s / 49.3 万谓词）——过池分片，窗口间让出主线程
      const compute = ctx.inject<ComputePool>(KernelServices.Compute);

      /** 当前适配器的变量语义查询（按 adapterId 精确匹配；多适配器共存天然正确） */
      const schemaLookup = (): SchemaLookup | undefined => {
        const current: GameProject | null = project.current();
        if (!current) return undefined;
        for (const contribution of slots.query('game.adapter')) {
          if (contribution.adapter.gameId !== current.adapterId) continue;
          const vs = contribution.adapter.variableSchema;
          if (vs) return (name: string, index?: number | string) => vs.lookup(name, index);
        }
        return undefined;
      };

      const engine = new ConditionEngine({
        log: ctx.log,
        getProject: () => project.current(),
        getIndex: () => parser.currentIndex(),
        readFile: async (path: string) => (await io.readText(path)).text,
        // 走并行通道（无通道自动内联）：扫描是全量抽取里最贵的纯 CPU 段（真实语料约 40%）
        scanControlFlow: (text: string): Promise<ControlFlowStatement[]> => parser.scanControlFlowOffloaded(text),
        getSchemaLookup: schemaLookup,
        compute,
      });

      const service: ConditionExtractorService = engine;
      ctx.provide(WellKnownServices.ConditionExtractor, service);
      // ---- 自动运行：索引重建完成即抽取（串行化，避免叠加运行） ----
      let running = false;
      let queued = false;
      const scheduleRun = (): void => {
        if (running) {
          queued = true;
          return;
        }
        running = true;
        void (async () => {
          try {
            do {
              queued = false;
              await engine.run();
            } while (queued);
          } catch (err) {
            ctx.log.error(`Condition extract run failed: ${String(err)}`);
          } finally {
            running = false;
          }
        })();
      };

      ctx.onDispose(ctx.bus.on('kojo.functionChanged', () => scheduleRun()));
      ctx.onDispose(
        ctx.bus.on('project.closed', () => {
          // 项目关闭后清空（面板显示待运行态）
          engine.clear();
        }),
      );

      // 激活时若已有现成索引（插件晚于项目打开被加载），立即跑一次
      if (parser.currentIndex()) scheduleRun();
    },
  };
}

export { ConditionEngine, type ConditionEngineDeps } from './engine';
export { extractFunctionConditions, extractFunctionPredicates, collectPredicates, collectReturns, collectAssignments } from './extract';
export { parseExpression, splitTopLevelCommas, walkExpr } from './expr';
