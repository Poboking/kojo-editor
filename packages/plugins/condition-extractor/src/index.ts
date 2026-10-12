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
  CacheExpect,
  ComputePool,
  ConditionIndex,
  ConditionExtractorService,
  ControlFlowStatement,
  ErbIndex,
  ErbParserService,
  FileIO,
  GameProject,
  Plugin,
  ProjectService,
  SlotRegistry,
} from '@kojo/plugin-api';
import { EXTRACT_STORE_KEY, decodeConditionIndex, encodeConditionIndex, extractExpect } from './snapshot';
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
      /** 本插件命名空间的存储域：抽取结果快照的落点（`{appData}/store/condition-extractor/`） */
      const storage = ctx.storage;

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

      /**
       * 结果快照端口：键固定、判据在快照本体里（见 `./snapshot.ts`）。
       * 坏快照一律删除而不是"修"——fail-closed 与索引快照同口径。
       */
      const snapshotPort = {
        expectFor({ index, project }: { index: ErbIndex; project: GameProject }): CacheExpect | null {
          return extractExpect({ index, project });
        },
        async load(expect: CacheExpect): Promise<ConditionIndex | null> {
          try {
            const raw = await storage.get<unknown>(EXTRACT_STORE_KEY);
            if (raw === undefined) return null; // 首次 / 刚变过文件：正常路径
            const restored = decodeConditionIndex(raw, expect);
            if (restored === null) {
              void storage.delete(EXTRACT_STORE_KEY).catch(() => undefined);
              ctx.log.warn('Condition snapshot unusable (format/root/adapter/fingerprint mismatch); extracting from scratch');
            }
            return restored;
          } catch (err) {
            ctx.log.warn(`Condition snapshot read failed; extracting from scratch: ${String(err)}`);
            return null;
          }
        },
        save(index: ConditionIndex, expect: CacheExpect): void {
          // 零函数被扫描 = 结果可疑（多半是索引刚失效），不落盘免得下次还原出空结果
          if (index.stats.functions === 0) return;
          void storage
            .set(EXTRACT_STORE_KEY, encodeConditionIndex({ index, expect }))
            .then(() => {
              ctx.log.info(`Condition snapshot saved (${index.byFunction.size} entries, fingerprint ${expect.fingerprint})`);
            })
            .catch((err: unknown) => {
              ctx.log.warn(`Condition snapshot save failed: ${String(err)}`);
            });
        },
      };

      const engine = new ConditionEngine({
        log: ctx.log,
        getProject: () => project.current(),
        getIndex: () => parser.currentIndex(),
        readFile: async (path: string) => (await io.readText(path)).text,
        // 走并行通道（无通道自动内联）：扫描是全量抽取里最贵的纯 CPU 段（真实语料约 40%）
        scanControlFlow: (text: string): Promise<ControlFlowStatement[]> => parser.scanControlFlowOffloaded(text),
        getSchemaLookup: schemaLookup,
        snapshot: snapshotPort,
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
              // 走 ensureIndex 而非 run()：前者共享在途 Promise。自动触发（functionChanged）
              // 与面板显式 ensureIndex 若并发起两条全量抽取，真实语料上要白跑 8.8 s × 2
              // （2026-10-12 级联实测暴露）。
              await engine.ensureIndex();
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
