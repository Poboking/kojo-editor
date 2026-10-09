/**
 * @kojo/plugin-convention-linter
 *
 * 约定校验器**引擎**插件（服务 `convention.linter`）。
 *
 * 分层（"一切皆插件"）：
 * - 本插件 = 引擎 + 内置通用规则（零游戏知识）；
 * - 游戏知识规则由 **game adapter** 通过 `adapter.conventions` 提供，
 *   引擎经槽位查询 + `project.adapterId` 过滤后装配（多游戏共存天然正确）。
 *
 * 无项目 / 索引未就绪时返回空报告（形状稳定，UI 无需分支判空）。
 */

import type {
  ConventionLinterService,
  ConventionRule,
  ErbParserService,
  FileIO,
  GameProject,
  Plugin,
  ProjectService,
  SlotRegistry,
} from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { ConventionEngine } from './engine';

const IO = 'kernel.io';
const PROJECT = 'kernel.project';
const SLOTS = 'kernel.slots';

export function createConventionLinterPlugin(): Plugin {
  return {
    id: 'convention-linter',
    version: '0.2.0',
    provides: [WellKnownServices.ConventionLinter],
    requires: [IO, PROJECT, SLOTS, WellKnownServices.ErbParser],
    activate(ctx) {
      const io = ctx.inject<FileIO>(IO);
      const project = ctx.inject<ProjectService>(PROJECT);
      const slots = ctx.inject<SlotRegistry>(SLOTS);
      const parser = ctx.inject<ErbParserService>(WellKnownServices.ErbParser);

      const adapterRules = (): readonly ConventionRule[] => {
        const current: GameProject | null = project.current();
        if (!current) return [];
        const out: ConventionRule[] = [];
        for (const contribution of slots.query('game.adapter')) {
          // 只取当前激活适配器的规则（多适配器共存时按 adapterId 精确匹配）
          if (contribution.adapter.gameId !== current.adapterId) continue;
          if (contribution.adapter.conventions) out.push(...contribution.adapter.conventions);
        }
        return out;
      };

      const engine = new ConventionEngine({
        log: ctx.log,
        getProject: () => project.current(),
        getIndex: () => parser.currentIndex(),
        readFile: async (path: string) => (await io.readText(path)).text,
        getAdapterRules: adapterRules,
      });

      const service: ConventionLinterService = {
        async run() {
          if (project.current()) {
            // 索引可能仍在构建（项目刚打开）——等待在途构建，避免"看不到问题"的假象
            try {
              await parser.ensureIndex();
            } catch (err) {
              ctx.log.warn(`ensureIndex before lint failed: ${String(err)}`);
            }
          }
          return engine.run();
        },
        report: () => engine.report(),
        subscribe: (cb) => engine.subscribe(cb),
        rules: () => engine.rules(),
      };

      ctx.provide(WellKnownServices.ConventionLinter, service);

      // ---- 自动运行：索引重建完成即校验（串行化，避免叠加运行） ----
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
              await service.run();
            } while (queued);
          } catch (err) {
            ctx.log.error(`Convention lint run failed: ${String(err)}`);
          } finally {
            running = false;
          }
        })();
      };

      ctx.onDispose(ctx.bus.on('kojo.functionChanged', () => scheduleRun()));
      ctx.onDispose(
        ctx.bus.on('project.closed', () => {
          // 项目关闭后清空报告（面板显示待运行态）
          void engine.run();
        }),
      );

      // 激活时若已有现成索引（插件晚于项目打开被加载），立即跑一次
      if (parser.currentIndex()) scheduleRun();
    },
  };
}

export { ConventionEngine, type ConventionEngineDeps } from './engine';
export { duplicateFunctionRule, DUPLICATE_FUNCTION_RULE_ID } from './rules/duplicate-function';
