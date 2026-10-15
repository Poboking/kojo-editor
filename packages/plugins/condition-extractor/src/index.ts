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
  LineDecoration,
  Plugin,
  ProjectService,
  SlotRegistry,
} from '@kojo/plugin-api';
import { EXTRACT_STORE_KEY, decodeBuckets, encodeBuckets, extractExpect } from './snapshot';
import type { ExtractExpect, FileBucket } from './snapshot';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { ConditionEngine } from './engine';
import { EXPR_SYNTAX_DECORATIONS_TASK, conditionExtractorTasks, exprSyntaxDecorations } from './offload';
import { diagnoseExpression } from './expr';
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
       * 结果快照端口（按文件分桶）：键固定、全局判据在快照本体里（见 `./snapshot.ts`）。
       * 坏快照一律删除而不是"修"——fail-closed 与索引快照同口径。
       */
      const snapshotPort = {
        expectFor({ project }: { index: ErbIndex; project: GameProject }): ExtractExpect | null {
          return extractExpect({ project });
        },
        async load(expect: ExtractExpect): Promise<Record<string, FileBucket> | null> {
          try {
            const raw = await storage.get<unknown>(EXTRACT_STORE_KEY);
            if (raw === undefined) return null; // 首次 / 从没抽过：正常路径
            const restored = decodeBuckets(raw, expect);
            if (restored === null) {
              void storage.delete(EXTRACT_STORE_KEY).catch(() => undefined);
              ctx.log.warn('Condition snapshot unusable (format/root/adapter/inputDigest/structure); extracting from scratch');
              return null;
            }
            return restored.buckets;
          } catch (err) {
            ctx.log.warn(`Condition snapshot read failed; extracting from scratch: ${String(err)}`);
            return null;
          }
        },
        save(buckets: ReadonlyMap<string, FileBucket>, expect: ExtractExpect): void {
          // 一个桶都没有 ⇒ 没什么可缓存（空项目或全部读扫失败），不落盘免得下次白绕一圈
          if (buckets.size === 0) return;
          void storage
            .set(EXTRACT_STORE_KEY, encodeBuckets({ buckets, expect }))
            .then(() => {
              let conds = 0;
              for (const b of buckets.values()) conds += b.conds.length;
              ctx.log.info(
                `Condition snapshot saved (${buckets.size} file buckets, ${conds} functions with predicates, ` +
                  `inputDigest ${expect.inputDigest})`,
              );
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
        // 批量读（2026-10-16 批量 IO 批）：pending 文本一次批取（批内一趟 IPC +
        // 会话缓存命中——索引段刚读过的正文在这里零读盘），失败位 null = 该文件不留桶
        readFiles: async (paths: readonly string[]) => {
          const tfs = await io.readTexts(paths);
          return tfs.map((tf) => tf?.text ?? null);
        },
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

      /* ---------------- 编辑器波浪线：条件表达式语法诊断（E8） ----------------

       与 erb-parser 自己的 `erb-structure`（结构错误，order 20）分层：
       那一层只报"配不上对"的骨架错误（闭合缺失 / 无主分支），这一层报**条件表达式
       本身的词法 / 语法问题**（如 `IF A &&` 这种残句）。

       复用 `requires` 里已声明的 `erb.parser` 服务（`parser`）——骨架扫描不重复实现，
       表达式诊断走 `./expr.ts`。管线是纯函数（文本进、行级装饰出），与槽契约一致。
       `decorate` 的匹配口径只认原生 ERB/ERM（`.kojo` 的语法诊断另有其人，糖线）。

       2026-10-16 装饰热路径批 —— 声明 `offloadKind`：宿主据此把这条链请出同步装饰轮
       （worker 表由装配层用 erb-parser 的 `scanControlFlow` 纯函数填好，见 `./offload.ts`）。
       `decorate()` 保留为**就地回退**，与任务实现共用同一个纯函数 `exprSyntaxDecorations`，
       两条走法不可能给出两种波浪线。
       */
      ctx.slots.register('ui.editor.decorator', {
        id: 'erb-expr-syntax',
        title: 'ERB 条件表达式波浪线',
        order: 21,
        offloadKind: EXPR_SYNTAX_DECORATIONS_TASK,
        decorate(file): LineDecoration[] {
          return exprSyntaxDecorations({ path: file.path, text: file.text }, (t) => parser.scanControlFlow(t));
        },
      });
    },
  };
}

export { ConditionEngine, type ConditionEngineDeps } from './engine';
export { extractFunctionConditions, extractFunctionPredicates, collectPredicates, collectReturns, collectAssignments } from './extract';
export { parseExpression, splitTopLevelCommas, walkExpr } from './expr';
export { diagnoseExpression } from './expr';
export type { ExprDiagnostic } from './expr';
export { collectExprSyntaxDecorations, type ExprSyntaxDecoration } from './decorator';
// 可搬运任务表（装饰热路径批；装配层用 erb-parser 的纯扫描器填这张表）
export { EXPR_SYNTAX_DECORATIONS_TASK, conditionExtractorTasks, exprSyntaxDecorations } from './offload';
