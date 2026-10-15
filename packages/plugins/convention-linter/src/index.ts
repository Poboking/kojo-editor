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
  CacheExpect,
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
import { LINT_STORE_KEY, decodeCache, encodeCache, lintExpect, type LintCache } from './snapshot';

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
      /** 本插件命名空间的存储域：校验结果快照的落点（`{appData}/store/convention-linter/`） */
      const storage = ctx.storage;

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

      /**
       * 结果快照端口（键固定、**三层判据**在快照本体里；坏快照删除而不是"修"）。
       * 校验实测 3.6 s / 产出 0.4 MB，而其中 55% 的成本在一条只看单文件的规则上
       * ⇒ 逐文件桶 + 整项目结论分开存，改一个文件只重算那一个文件。
       */
      const snapshotPort = {
        expectFor({ project: p, rules }: { project: GameProject; rules: readonly ConventionRule[] }) {
          return lintExpect({ project: p, rules });
        },
        async load(expect: CacheExpect): Promise<LintCache | null> {
          try {
            const raw = await storage.get<unknown>(LINT_STORE_KEY);
            if (raw === undefined) return null; // 首次 / 全局判据刚变：正常路径
            const restored = decodeCache(raw, expect);
            if (restored === null) {
              void storage.delete(LINT_STORE_KEY).catch(() => undefined);
              ctx.log.warn('Convention snapshot unusable (format/root/adapter/inputDigest/rules/structure); linting from scratch');
            }
            return restored;
          } catch (err) {
            ctx.log.warn(`Convention snapshot read failed; linting from scratch: ${String(err)}`);
            return null;
          }
        },
        save(cache: LintCache, expect: CacheExpect): void {
          void storage
            .set(LINT_STORE_KEY, encodeCache({ cache, expect }))
            .then(() => {
              const bucketFiles = Object.values(cache.buckets).reduce((n, byPath) => n + Object.keys(byPath).length, 0);
              ctx.log.info(
                `Convention snapshot saved (${bucketFiles} file buckets across ` +
                  `${Object.keys(cache.buckets).length} file rule(s), ${Object.keys(cache.projectResults).length} ` +
                  `project rule(s), erbFingerprint ${cache.erbFingerprint})`,
              );
            })
            .catch((err: unknown) => {
              ctx.log.warn(`Convention snapshot save failed: ${String(err)}`);
            });
        },
      };

      const engine = new ConventionEngine({
        log: ctx.log,
        getProject: () => project.current(),
        getIndex: () => parser.currentIndex(),
        readFile: async (path: string) => (await io.readText(path)).text,
        // 批量读（2026-10-16 批量 IO 批）：逐文件规则的 stale 并集一次批取
        // （批内一趟 IPC + 会话缓存——索引/抽取段刚读过的正文在这里零读盘）
        readFiles: async (paths: readonly string[]) => {
          const tfs = await io.readTexts(paths);
          return tfs.map((tf) => tf?.text ?? null);
        },
        getAdapterRules: adapterRules,
        snapshot: snapshotPort,
      });

      const service: ConventionLinterService = {
        async run(opts?: { force?: boolean }) {
          if (project.current()) {
            // 索引可能仍在构建（项目刚打开）——等待在途构建，避免"看不到问题"的假象
            try {
              await parser.ensureIndex();
            } catch (err) {
              ctx.log.warn(`ensureIndex before lint failed: ${String(err)}`);
            }
          }
          // opts.force（面板「重新校验」）一路传到引擎：显式意图不该被缓存糊住
          return engine.run(opts);
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
export {
  sugarStaticConventionsRule,
  SUGAR_STATIC_CONVENTIONS_RULE_ID,
  CONT_INSIDE_QUOTES_RULE_ID,
  MULTIPLE_CHOICE_BLOCKS_RULE_ID,
  EXPR_MISSING_ELSE_RULE_ID,
  READONLY_ALIAS_ASSIGN_RULE_ID,
} from './rules/sugar-conventions';
