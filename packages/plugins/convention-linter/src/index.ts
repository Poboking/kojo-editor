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
  ComputePool,
  ConventionLinterService,
  ConventionRule,
  ConventionRunOptions,
  ErbParserService,
  FileIO,
  GameProject,
  Plugin,
  ProjectService,
  SlotRegistry,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices, activeGameAdapter } from '@kojo/plugin-api';
import { ConventionEngine } from './engine';
import {
  buildConventionIssueView,
  conventionCodeActionsForFile,
  conventionDecorationsForFile,
} from './diagnostics';
import { conventionIssueFixes } from './fixes';
import {
  LINT_STORE_KEY,
  LINT_UNITS_KEY_PREFIX,
  decodeCache,
  decodeUnits,
  encodeCache,
  encodeUnits,
  lintExpect,
  lintUnitsKey,
  type LintCache,
  type LintUnitEntry,
} from './snapshot';

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
      // 计算池是"怎么调度"而不是"要不要跑"：内核恒供（`kernel.ts` 起手就 provide），
      // 最小假上下文里没有 ⇒ 引擎自带的本地限并发兜底照常判对，只是少一档仲裁。
      const compute = ctx.tryInject<ComputePool>(KernelServices.Compute);
      const parser = ctx.inject<ErbParserService>(WellKnownServices.ErbParser);
      /** 本插件命名空间的存储域：校验结果快照的落点（`{appData}/store/convention-linter/`） */
      const storage = ctx.storage;

      /**
       * 当前适配器带来的约定规则。
       * 「谁是当前那枚」由契约的 `activeGameAdapter` 认（多适配器共存天然正确）。
       */
      const adapterRules = (): readonly ConventionRule[] =>
        activeGameAdapter(slots.query('game.adapter'), project.current()?.adapterId)?.conventions ?? [];

      /**
       * 结果快照端口（键固定、**三层判据**在快照本体里；坏快照删除而不是"修"）。
       * 校验实测 3.6 s / 产出 0.4 MB，而其中 55% 的成本在一条只看单文件的规则上
       * ⇒ 逐文件桶 + 整项目结论分开存，改一个文件只重算那一个文件。
       */
      /**
       * 分区贡献键的写入链（PERF-12c）：`save`/`prune`/`dropAll` 全部排队串行。
       * `prune` 要 listDir 求补集，必须排在同轮 `save` 之后——否则看不见在途的键，
       * 会把刚写的贡献当孤儿删掉（竞态 = 自己造孤儿）。
       */
      let unitsChain: Promise<void> = Promise.resolve();
      const queueUnits = (what: 'save' | 'prune' | 'drop', run: () => Promise<void>, note?: string): void => {
        unitsChain = unitsChain
          .then(run)
          .catch((err: unknown) => {
            ctx.log.warn(`Convention partition units ${what} failed${note ? ` for '${note}'` : ''}: ${String(err)}`);
          });
      };
      const listUnitKeys = async (): Promise<string[]> => {
        const listed = await storage.keys();
        return listed.filter((k) => k.startsWith(LINT_UNITS_KEY_PREFIX));
      };

      const snapshotPort = {
        expectFor({ project: p, rules }: { project: GameProject; rules: readonly ConventionRule[] }) {
          return lintExpect({ project: p, rules });
        },
        async load(expect: CacheExpect): Promise<LintCache | null> {
          try {
            const raw = await storage.get<unknown>(LINT_STORE_KEY);
            if (raw === undefined) return null; // 首次 / 全局判据刚变：正常路径
            // 贡献已拆键 ⇒ 主快照里那份旧形态**不解码**（引擎会用 `droppedUnits` 立刻改写一次瘦版）
            const restored = decodeCache(raw, expect, { includeUnits: false });
            if (restored === null) {
              void storage.delete(LINT_STORE_KEY).catch(() => undefined);
              // 主快照被判死（换项目 / 输入摘要变了）⇒ 拆出去的贡献键同批作废，不留跨项目残留
              queueUnits('drop', async () => {
                for (const key of await listUnitKeys()) await storage.delete(key);
              });
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

        /**
         * 分区贡献 = **每条规则一个存储键**（PERF-12c）。
         *
         * 真语料读数：贡献占主快照 4.0 MB / 5.1 MB（79%），而"全命中轮"为了一句零计算
         * 要把整份读盘 + parse（装载 1.4–2.0 s）。拆键后主快照只剩桶与结论；贡献只在
         * **真有分区规则要重算**时按 ruleId 懒取那一条（引擎里那条规则没建计划就完全不碰盘）。
         *
         * 生命周期：① 键名由 `lintUnitsKey(ruleId)` 正算 ⇒ 规则改名/换适配器后 `prune`
         * 拿得到孤儿；② 每条键自带全局判据 + ruleId，判据不符即删（fail-closed，绝不"修"）；
         * ③ 主快照被判死时整批贡献跟着清（见上面 `load`）。
         */
        units: {
          async load(ruleId: string, expect: CacheExpect) {
            const keyName = lintUnitsKey(ruleId);
            try {
              const raw = await storage.get<unknown>(keyName);
              if (raw === undefined) return null;
              const decoded = decodeUnits(raw, expect, ruleId);
              if (decoded === null) {
                void storage.delete(keyName).catch(() => undefined);
                ctx.log.warn(`Convention partition units for '${ruleId}' unusable; recomputing (fail-closed)`);
              }
              return decoded;
            } catch (err) {
              ctx.log.warn(`Convention partition units read failed for '${ruleId}': ${String(err)}`);
              return null;
            }
          },
          save(ruleId: string, state: { key: string; units: Record<string, LintUnitEntry> }, expect: CacheExpect) {
            queueUnits('save', () => storage.set(lintUnitsKey(ruleId), encodeUnits({ ruleId, ...state, expect })).then(() => undefined), ruleId);
          },
          prune(keepRuleIds: readonly string[]) {
            const keep = new Set(keepRuleIds.map((id) => lintUnitsKey(id)));
            queueUnits('prune', async () => {
              for (const key of await listUnitKeys()) {
                if (keep.has(key)) continue;
                await storage.delete(key);
              }
            });
          },
        },
      };

      const engine = new ConventionEngine({
        log: ctx.log,
        // 逐文件/分区循环交给内核计算池分片让路（ZH-F4）：一轮全项目校验是 background 档，
        // 不许连续占住主线程把打字与波浪线挤到几百毫秒之后
        compute,
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
        async run(opts?: ConventionRunOptions) {
          if (project.current()) {
            // 索引可能仍在构建（项目刚打开）——等待在途构建，避免"看不到问题"的假象
            try {
              await parser.ensureIndex();
            } catch (err) {
              ctx.log.warn(`ensureIndex before lint failed: ${String(err)}`);
            }
          }
          // opts 原样交给引擎：`force`（面板「重新校验」）与 `signal`（ZH-F4b 叫停）都不在这层解释
          return engine.run(opts);
        },
        report: () => engine.report(),
        subscribe: (cb) => engine.subscribe(cb),
        rules: () => engine.rules(),
      };

      ctx.provide(WellKnownServices.ConventionLinter, service);

      /* ---------------- 诊断面接线（DIAG-LINK，2026-10-18） ----------------

       报告过去只有面板在读：项目级校验（含 `erb.duplicate-function`）在 Monaco **零波浪线**、
       不进问题面板、`Ctrl+.` 捞不到、`workbench.fixAll` 碰不到，状态栏「问题 n」与面板的
       convention-counts 是两本互不对账的数。这里把**同一份 issues** 折进两个既有槽：
       `ui.editor.decorator`（波浪线 + 面板行）与 `ui.editor.codeAction`（💡 / `Ctrl+.`）。

       **不新建第二套事件**：视图只由引擎既有订阅（`ConventionLinterService.subscribe`，
       立即以当前值回调一次）重算——`report` 变了装饰就跟着变，面板/命令/CI 读的还是同一条广播。

       **两本数怎么对账（判据②，`tests/diagnostics.test.ts` 有闸）**：本层的恒等式是
       `report.counts 之和 = 面上本层红线数 + 归别家画的糖族条 + 无文件归属的整项目结论 + 有文件但无行号的结论`
       （前两项一一对应：一条**归本层画**的 issue 恰好一条装饰，绝不多画也不折叠；"归别家"那一项
       是 `.kojo` 上的糖族——线由 `ui-sugar-editor#sugar-diagnostics` 对着实时转译产物画，
       本层只记账不再发第二条，见 `diagnostics.ts` 的归属注）。后两项**天生进不了波浪线**，
       而状态栏「问题 n」还另含 ①未打开的文件（marker 只发给活着的 model）②别的装饰贡献方
       （`.kojo` 糖诊断 / ERB 结构 / 表达式）自己的账——所以两数**不可能相等**，等的只是上面
       这条可核算的恒等式。差额口径必须在 UI 上说清（不许各说各话）：
       `ui.statusbar#convention-counts` 的 tooltip 写明"项目级约定计数，含未打开文件与整项目
       结论 ≠ 状态栏『问题』"，宿主那枚「问题」小件同时写明它数的是"已打开文件的波浪线"
       （两处均已落地，2026-10-19 清账批）。

       **刻意不声明 `offloadKind`**：本装饰器吃的是**插件内的报告态**（`view`），搬进 worker
       就得把整份报告复制过去（第二个真源）。`decorate` 因此只是一次 `Map` 取表（O(1)、零 CPU
       压力），留在同步装饰轮里恰好与它的成本形状相配（与 `erb-reference` 同一取舍）。
       */
      let view = buildConventionIssueView([]);
      ctx.onDispose(
        service.subscribe((report) => {
          view = buildConventionIssueView(report?.issues ?? []);
        }),
      );

      ctx.onDispose(
        ctx.slots.register('ui.editor.decorator', {
          id: 'convention-issues',
          title: '约定校验波浪线',
          order: 22,
          decorate: (file) => conventionDecorationsForFile(view, file.path),
        }),
      );

      /* ---------------- 💡 约定问题的一键修复 ----------------

       动作**只在有可证明改法时**才出：`issue.edits`（契约 additive 字段）优先，其次是
       `fixes.ts` 的兜底供给方；两者都空 ⇒ 一条动作都不给（波浪线照旧在，绝不给一个
       改不动眼前红线的 quickfix——那比没有更糟）。
       `diagnostics` 逐条原样交出**与装饰面同一身份键**的那条 `LineDecoration`（B9）：
       聚合视图与 `Ctrl+.` 说的因此是同一次问题，Monaco 的排序优先 / 应用高亮 / `hasAutoFix`
       才认得出"这个修复消解的就是这条红线"。
       只对**能写**的路径供（同 `erb-structure-fix` 的门槛）：游戏目录默认只读，
       Monaco 的 `executeEdits` 却照样能改缓冲 ⇒ 不挡就会造出"只读文件被改脏"的怪态。
       */
      ctx.onDispose(
        ctx.slots.register('ui.editor.codeAction', {
          id: 'convention-quickfix',
          order: 31,
          provideActions: (file) =>
            conventionCodeActionsForFile(view, {
              path: file.path,
              text: file.text,
              ...(file.line !== undefined ? { line: file.line } : {}),
              ...(file.scope !== undefined ? { scope: file.scope } : {}),
              ...(file.diagnostics !== undefined ? { diagnostics: file.diagnostics } : {}),
              writable: io.isWritable(file.path),
              fixResolver: conventionIssueFixes,
            }),
        }),
      );

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
export {
  buildConventionIssueView,
  conventionCodeActionsForFile,
  conventionDecorationsForFile,
  conventionIssueDecoration,
  conventionIssueKey,
  conventionSeverityToDecoration,
  conventionSquiggleOwnedElsewhere,
  conventionSurfaceDecoration,
  foldIssueEdit,
  toIssueLines,
  type ConventionCodeActionRequest,
  type ConventionFileBucket,
  type ConventionIssueFixResolver,
  type ConventionIssueView,
} from './diagnostics';
export { conventionIssueFixes } from './fixes';
export { duplicateFunctionRule, DUPLICATE_FUNCTION_RULE_ID } from './rules/duplicate-function';
export {
  sugarStaticConventionsRule,
  SUGAR_STATIC_CONVENTIONS_RULE_ID,
  SUGAR_RULE_ID_PREFIX,
  isSugarFamilyRuleId,
  sugarFamilyCodeOf,
  CONT_INSIDE_QUOTES_RULE_ID,
  MULTIPLE_CHOICE_BLOCKS_RULE_ID,
  EXPR_MISSING_ELSE_RULE_ID,
  READONLY_ALIAS_ASSIGN_RULE_ID,
} from './rules/sugar-conventions';
