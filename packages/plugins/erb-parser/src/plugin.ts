import type {
  ComputePool,
  ControlFlowStatement,
  ErbFile,
  ErbIndex,
  ErbIndexFileFailure,
  ErbIndexState,
  ErbParserService,
  ErbReferenceIndex,
  ErbScanSourceFact,
  FileIO,
  FileStat,
  GameProject,
  LineDecoration,
  Plugin,
  WorkspaceService,
} from '@kojo/plugin-api';
import { KernelServices, isErbDialectPath, projectFingerprintOf } from '@kojo/plugin-api';
import { planScanRoots, rootsSignature, type ScanRootPlan } from './index-roots';
import { idleIndexState, indexStateOf, sourceFactsOf, type IndexOutcome, type SourceReading } from './index-state';
import {
  PARSE_FILE_TASK,
  SCAN_FLOW_TASK,
  STRUCTURE_DECORATIONS_TASK,
  erbParserTasks,
  erbStructureDecorations,
  type ParseFilePayload,
  type ScanFlowPayload,
} from './offload';
import { parseErbText, scanControlFlow } from './scanner';
import { checkControlFlowStructure } from './structure';
import { buildStructureFixes } from './structure-fix';
import { erbDocumentSymbols } from './document-symbols';
import { erbFoldingRanges } from './folding';
import { buildReferenceIndex, erbReferenceDecorations, erbReferenceLocationsAt, referencesOf, scanFileRefs, type FileRefs } from './references';
import { definitionTargetsAt, functionAt } from './symbols';
import { workspaceSymbolsInIndex } from './workspace-symbols';
import { usageLenses } from './usage-lens';
import { erbSemanticTokens } from './semantic-tokens';
import { callArgumentHints, inlaySlotsOf } from './inlay-hints';
import {
  SNAPSHOT_VERSION,
  aggregateIndex,
  attachRefs,
  coerceSnapshot,
  countEntries,
  diffSnapshot,
  encodeEntries,
  mergeEntries,
  nameSetDigest,
  pruneSnapshotKeys,
  refsAreReusable,
  salvageSnapshot,
  snapshotKeyCandidatesFor,
  snapshotKeyFor,
  verifiedNamesDigest,
  type IndexSnapshot,
  type SalvagedSnapshot,
  type SnapshotEntry,
} from './snapshot';

/**
 * erb-parser 插件。
 *
 * - 服务键：`erb.parser`（provides）
 * - 依赖：`kernel.io`（读文件 + 目录遍历；自动处理编码探测）
 * - 零游戏知识：不识别任何 `M_KOJO` 之类的命名约定（那是 game.adapter 的领域）
 *
 * v0.2 —— **索引所有权收敛到解析器**（架构文档 §5.7「响应式，不是中心式流水线」）：
 * 订阅 `project.opened` 自动构建索引并缓存，构建完成发 `kojo.functionChanged`；
 * 消费方（函数树 / 校验器 / 面板）订阅事件或调用 `currentIndex()` / `ensureIndex()`
 * 取用，无需各自重复构建。
 *
 * 2026-10-12「内核优化」批 —— **索引快照 + 增量复扫**（例 1：第二次开项目不用再等）：
 * 文件没变（mtime 一致）时直接复用上次的解析结果，只重扫变过的文件。
 * 设计与纪律见 `./snapshot.ts` 头注（fail-closed / 保守失效 / 顺序确定）。
 *
 * 2026-10-16 PERF-7「快照热载瘦身」批：
 * - 失效判据加 size（mtime 同值替换兜底；`fileSizes` 一并对下游暴露，additive）；
 * - 还原两段化（懒外壳见 `./snapshot.ts`）+ `references` 惰性聚合（首发消费才建 bySymbol）；
 * - prune 语义从"只留当前项目"改为"保留本会话工作集"（交替开项目不再互删，见
 *   `pruneStaleSnapshots` 的取舍注）。
 *
 * 2026-10-19 IDX-ROOT「索引根扩到作者工作区」批：
 * 扫描根从 `project.kojoPaths` 扩成 **`kojoPaths ∪ 工作区全部根`**（`kernel.workspaces`
 * 的 `roots()`，每次现读不缓存），作者在自己「我的口上项目」里写的定义第一次进五条
 * 语言服务腿。根的合成/判等/签名判据全在 `./index-roots.ts`（纯函数），这里只有接线；
 * 没有"工作区根变更"事件 ⇒ 在**既有时刻**（`ensureIndex()` / `file.changed` /
 * `editor.activeFileChanged`）活读比对签名，变了就 `generation++` 重扫并走既有广播。
 * 只读行为：本批不碰任何写通道，也不因扩根放宽写允许域（铁律 5/6）。
 */

const IO = 'kernel.io';
/**
 * 「哪些文件算 ERB 方言」一律问契约层的单一真源（`plugin-api/erb-ext`，FT-2 收口）。
 *
 * 2026-10-14 起口径**含 `.ERH`**（引擎预载白名单认它是脚本文件，实测口上根内 31 份、
 * 内容只有 `#DIM` / `#DIMS`）：索引文件数随之增加，而函数树不变——声明文件 0 个 `@` 定义，
 * 这条不变量由 `tests/erh-index.corpus.test.ts` 在真语料上钉死。
 *
 * 2026-10-17 W6 复核（`.kojo` 能力面拉平批）——本别名就是**全包唯一的方言谓词**：
 * - 索引遍历、波浪线、八类语言服务应答一律走它，仓库里不存在第二个"这文件算不算方言"的
 *   写法（`references.ts` / `offload.ts` / `ui-sugar-lift` 同样 import 契约层那一个）；
 * - **族内没有正当请求被挡**：`.erb` / `.erm` / `.erh` 的大小写形态逐个都答，由
 *   `tests/dialect-gate.test.ts` 按 `ERB_DIALECT_EXTENSIONS` **派生**逐个钉（清单不抄进
 *   测试，扩展族时那条自动跟上）；
 * - 拒 `.kojo` 是**对的**，不是缺口：本包交出的行号是方言原文的行号，`.kojo` 缓冲区那些行
 *   是派生文本。缺的是 `.kojo` 自己那一腿的应答方，已落在糖线
 *   （`kojo-sugar/src/langsvc.ts`：拿产物问本包，再把坐标折回源——判据仍只有这里一份）；
 * - `.erd` 是契约里明写的**留位未接线**（`ERB_ENGINE_RESERVED_EXTENSIONS`：基线盘仅 1 份
 *   且在索引根之外）。接线动作 = 并入 `ERB_DECLARATION_EXTENSIONS` 后复跑语料自证，
 *   归 ERB 方言覆盖线，不在本批顺手扩（没有第二份盘可证之前不做没根据的工作）。
 */
const isDialect = isErbDialectPath;

/** 索引三段（walk 之外）的窗口并发度：stat 轻、parse 重 */
const STAT_CONCURRENCY = 32;
/**
 * 解析窗口的并发度 = **计算池容量上限**（宿主装配 `min(4, cores−1)` 个 worker 槽，
 * 见 `app/src/bootstrap.ts`）。旧值 12 是池出现前"内联轮转"时代的数字：对 4 槽池
 * 它只是让 8 份载荷提前结构化克隆进队列排着——多付 12× 克隆/驻留、零吞吐增益；
 * 内联回退（无通道）时 CPU 在单线程上本来也串。PS-3 对齐到池顶。
 */
const PARSE_CONCURRENCY = 4;
/** 片预算：半个 60fps 帧（与计算池默认一致） */
const SLICE_MS = 8;
/**
 * 批量读批大小（2026-10-16 批量 IO 批）：一次 `io.readTexts` 带 64 个文件
 * （≈ 一帧 4MB 级 IPC 载荷），解析段/引用段的读盘就此从"每文件两趟 IPC"变成"每批一趟"。
 */
const READ_BATCH = 64;

/** 一趟批量读的产出形态（失败位 null，与逐文件 readText 抛错同语义面） */
type BatchTexts = Awaited<ReturnType<FileIO['readTexts']>>;

export function createErbParserPlugin(): Plugin {
  return {
    id: 'erb-parser',
    version: '0.2.0',
    provides: ['erb.parser'],
    requires: [IO, KernelServices.Compute],
    activate(ctx) {
      const io = ctx.inject<FileIO>(IO);
      /**
       * 计算池（内核优化批）：索引是"开项目级联"的第一段，2,317 个文件 / 362 万行
       * 的 walk+stat+parse 必须**分片让路**，否则用户开项目后几秒内打字必卡。
       * 用 `concurrency` 保住 IPC 并行度，窗口之间让出主线程。
       */
      const compute = ctx.inject<ComputePool>(KernelServices.Compute);
      // 注册可搬运任务：本地实现 = 无并行通道（或通道失败）时的回退路径；
      // worker 侧由装配层用**同一份表**（`erbParserTasks`）注册，避免映射漂移。
      for (const [kind, impl] of Object.entries(erbParserTasks)) compute.registerTask(kind, impl as never);
      /** 本插件命名空间的存储域：索引快照的落点（`{appData}/store/erb-parser/`） */
      const storage = ctx.storage;

      /** 当前索引（未打开项目 / 未构建时为 null） */
      let index: ErbIndex | null = null;
      /** 在途构建（并发调用 ensureIndex 时共享同一 Promise） */
      let inFlight: Promise<ErbIndex> | null = null;
      /** 当前项目的口上根（由 project.opened 提供；**不含**工作区根——那些每次现读） */
      let projectRoots: string[] = [];
      /**
       * 最近一次**起跑构建**所用的扫描根签名（`rootsSignature(planScanRoots().roots)`）。
       * 与"当前活读出来的签名"不一致 ⇒ 根集合变了，必须重扫（判据见 `./index-roots`）。
       */
      let activeSignature = '';
      /** 工作区不可用的降级只在**状态翻转**时出声一次（`file.changed` 是高频时刻，逐次刷屏即噪声） */
      let workspaceDegradedLogged = false;
      /**
       * 降级的那句原始原因（IDX-STATE）：出声一次不等于"只说一次"——`ctx.log` 那条为
       * 开发者服务、且只翻转时响一遍，而作者侧的事实面每一轮都得读得出**为什么读不到**。
       * 与 `workspaceDegradedLogged` 同生命周期（可用时复位）。
       */
      let workspaceDegradeReason: string | null = null;
      /**
       * 索引的对外事实（IDX-STATE）。构造与判据全在 `./index-state.ts`（形状判据只那一处），
       * 这里只按**时机**喂读数；过期代际的构建结果既不写它也不落盘（同 `index` 的纪律）。
       */
      let lastIndexState: ErbIndexState = idleIndexState();
      /** 本轮起跑时定下的逐来源事实（`build` 里的进度笔数照它写，免得两处各说各话） */
      let lastSources: readonly ErbScanSourceFact[] = [];
      /** 本轮实际去遍历的根数（起跑即定，进度阶段与收尾阶段读同一枚数） */
      let lastRootsWalked = 0;
      /** 进度读数沿用位：事实面的每一笔都写"截至这一笔的最新已知读数"，绝不回退成 0 */
      let lastFilesScanned = 0;
      let lastFunctions = 0;
      /**
       * 本轮失败文件全表（IDX-SILENT）：只在这里攒，对外条数与样本由 `indexStateOf()` 派生。
       * 这一笔补的正是 `filesScanned − index.files.size` 看不见的那类降级——被上一轮快照
       * 顶替的文件这一轮同样没读成，但索引里仍有旧内容，差值照旧是 0。
       */
      let lastFailures: readonly ErbIndexFileFailure[] = [];
      /** 当前项目根（事件载荷用） */
      let currentRoot = '';
      /** 代际号：项目切换 / 扫描根变更时作废过期构建的结果 */
      let generation = 0;

      /**
       * 作者工作区全部根（IDX-ROOT）。**每次现读、绝不缓存**：`roots()` 同步读内存数组、
       * 零 IO，缓存一次就把"本会话刚经目录对话框授权的那个落点根"永久排除在外——
       * 而那正是作品真正住着的地方。
       *
       * 不可用（无平台数据目录的浏览器开发壳 / 服务键缺席 / `roots()` 自己抛）⇒
       * 返回 `null`，调用点**退化成只有口上根**并记一行 warn（铁律 4：不静默；
       * 沿用本包既有的 `ctx.log` 口径，不新发明错误通道）。
       *
       * 刻意**不**把 `kernel.workspaces` 写进 `requires`：那条硬依赖会让工作区缺席的
       * 环境把整个 erb-parser 打成 `inactive`（runtime 的缺依赖判据），从而**连带掐掉
       * 五条语言服务腿与波浪线**——比"索引少扫工作区"严重一个数量级。
       */
      function workspaceRootsOrNothing(): string[] | null {
        try {
          const got = ctx.inject<WorkspaceService>(KernelServices.Workspaces).roots();
          workspaceDegradedLogged = false;
          workspaceDegradeReason = null;
          return got;
        } catch (err) {
          // 原始原因**每轮都留档**（与"只出声一次"的 log 分流）：事实面要答得出
          // "这一轮为什么少了工作区根"，而不只在看板式的开发者日志里响过一次。
          workspaceDegradeReason = String(err);
          if (!workspaceDegradedLogged) {
            workspaceDegradedLogged = true;
            ctx.log.warn(
              `Workspace roots unavailable; the ERB index will scan only the project's kojo paths: ${String(err)}`,
            );
          }
          return null;
        }
      }

      /**
       * 逐来源读数（IDX-STATE 的唯一采集处）：**在这一刻现读**，与 `planScanRoots` 的入参
       * 同源 ⇒ "谁交了几条根 / 谁读不到"与真正走进去的根必然是同一次采集的产物
       * （分两处读就会给出一条降级、一条没降级的假事实）。
       */
      function sourceReadings(workspaceRoots: readonly string[] | null): SourceReading[] {
        return [
          { kind: 'project', roots: projectRoots },
          { kind: 'workspace', roots: workspaceRoots, ...(workspaceDegradeReason === null ? {} : { reason: workspaceDegradeReason }) },
        ];
      }

      /**
       * 记一笔对外事实。`gen` 不是当前代际 ⇒ **一律不记**（过期构建的进度/结果不是
       * 当前状态；写进去就是拿上一棵树的数据回答"这一轮怎么样了"）。
       * 后三个读数缺省时沿用上一次的值——失败那一笔不该把"已经扫到 1,234 个文件"抹成 0。
       * `failures` 是**逐文件失败全表**（IDX-SILENT）：条数与样本都在 `indexStateOf()` 里派生。
       */
      function noteState(
        gen: number,
        outcome: IndexOutcome,
        filesScanned: number = lastFilesScanned,
        functions: number = lastFunctions,
        error?: string,
        failures: readonly ErbIndexFileFailure[] = lastFailures,
      ): void {
        if (gen !== generation) return;
        lastFilesScanned = filesScanned;
        lastFunctions = functions;
        lastFailures = failures;
        lastIndexState = indexStateOf({
          outcome,
          sources: lastSources,
          rootsWalked: lastRootsWalked,
          filesScanned,
          functions,
          failures,
          ...(error === undefined ? {} : { error }),
        });
      }

      /** 当前该扫的根（活读合成；折叠/去重判据见 `./index-roots`） */
      function scanRootPlan(): ScanRootPlan {
        return planScanRoots(projectRoots, workspaceRootsOrNothing() ?? []);
      }

      /**
       * 活读比对扫描根签名：变了就**作废在途构建**（`generation++`，过期结果在收尾处
       * 被丢弃、也不落盘）并异步重扫，收尾照常广播 `kojo.functionChanged` 让派生缓存
       * 失效——既有机制原样复用，不新开通道、不静默。
       *
       * 返回是否真的起了新一轮构建（测试判据 + 调用点不必解释原因）。
       */
      function refreshScanRoots(): boolean {
        // 无项目态不在本刀范围（app 无项目只渲染欢迎页，编辑器根本进不去）：
        // `ensureIndex()` 照旧明确报"未打开项目"，这里不擅自替它建索引。
        if (projectRoots.length === 0) return false;
        const next = rootsSignature(scanRootPlan().roots);
        if (next === activeSignature) return false;
        ctx.log.info('Index scan roots changed; rebuilding the ERB index');
        generation++;
        void startBuild(generation).catch((err: unknown) => {
          ctx.log.error(`Index rebuild after root change failed: ${String(err)}`);
        });
        return true;
      }

      /**
       * 磁盘卫生：索引快照的**保留集 = 本会话工作集**（本会话构建过的各项目键）。
       * 其余索引快照键（含格式升级留下的 `index-v1-*` / `v2-*` 孤儿）回收。
       *
       * 为什么不是"只留当前项目这一份"（上一版语义）：那会让**交替开两个游戏目录**
       * 演变成"每次切换都全冷重建"——A 落盘即删 B 的键，回头开 B 又全冷，往复（实测
       * 合成 A/B 交替 3 轮 6 次全冷）。作者拿两三个版本对拍是真实工作流（三盘语料），
       * 不该拿冷索引（真语料 ~2.3 s）当税。工作集把切换收进内存判据，界 = 一次会话
       * 摸过的项目数（典型 1–3 份快照落盘），"不留无上限磁盘口子"的初衷不破。
       * 纯清理动作，失败只记一行——缓存回收不该影响索引正确性。
       */
      const sessionSnapshotKeys = new Set<string>();
      function pruneStaleSnapshots(): void {
        void (async () => {
          try {
            const doomed = pruneSnapshotKeys(await storage.keys(), [...sessionSnapshotKeys]);
            for (const k of doomed) await storage.delete(k);
            if (doomed.length > 0) ctx.log.info(`Index snapshot store pruned (${doomed.length} stale key(s))`);
          } catch (err) {
            ctx.log.warn(`Index snapshot prune failed (cache hygiene only): ${String(err)}`);
          }
        })();
      }

      /**
       * 构建的**记账外壳**：把 `sources`（本轮的逐来源事实）落到闭包，任何抛出都记成
       * `failed` 一笔并**原样上抛**（失败语义一字未动——照旧由调用方决定怎么处置）。
       * `sources = null` 是 `service.buildIndex()` 那条显式给根清单的路径：调用方没陈述
       * 来源，事实面就如实只陈述"走了几个根"，不编造来源。
       */
      async function build(
        rootsToScan: string[],
        gen: number,
        useSnapshot: boolean,
        sources: readonly ErbScanSourceFact[] | null,
      ): Promise<ErbIndex> {
        lastSources = sources ?? [];
        lastRootsWalked = rootsToScan.length;
        try {
          return await buildWalkAndParse(rootsToScan, gen, useSnapshot);
        } catch (err) {
          noteState(gen, 'failed', undefined, undefined, String(err));
          throw err;
        }
      }

      async function buildWalkAndParse(
        rootsToScan: string[],
        gen: number,
        useSnapshot: boolean,
      ): Promise<ErbIndex> {
        // 耗时拆分（内核优化 L0）：索引是"开项目级联"的第一段，必须在日志里可见。
        // 每段单独计时——上一轮"热启动 stat 872ms"的疑点就是因为快照读盘被并进了 stat 区间。
        const buildStartedAt = Date.now();
        const allFiles: string[] = [];
        // 失败面（IDX-SILENT）从这一轮的**零**起算：进度/收尾每一笔都带它，绝不继承上一轮
        const failures: ErbIndexFileFailure[] = [];
        noteState(gen, 'scanning', 0, 0, undefined, failures);
        /**
         * `walkDir({withMetadata})` 顺带带回的元数据（IMPLEMENTATION-LOG §5.117）：
         * 热开段实测 `stat` 独占 2,038ms / index 2,657ms，全部是 2,285 次逐文件 IPC 往返；
         * 遍历目录时元数据本就在手边，一次带回就把那一整段折进 walk。
         */
        const metaByPath = new Map<string, { mtimeMs: number; size: number }>();
        for (const root of rootsToScan) {
          const entries = await io.walkDir(root, {
            includeFiles: true,
            includeDirs: false,
            withMetadata: true,
            filter: (e) => e.isDirectory || isDialect(e.name),
          });
          for (const e of entries) {
            if (e.isDirectory || !isDialect(e.name)) continue;
            allFiles.push(e.path);
            if (typeof e.mtimeMs === 'number' && typeof e.size === 'number') {
              metaByPath.set(e.path, { mtimeMs: e.mtimeMs, size: e.size });
            }
          }
          // 进度读数（IDX-STATE）：每走完一个根就记一次——"正在扫"这一格要拿得出已扫文件数
          noteState(gen, 'scanning', allFiles.length, 0);
        }
        const walkMs = Date.now() - buildStartedAt;

        // 体量指纹：mtime（+ size，PERF-7）是增量复扫的判据——两者都没变的文件，解析结果必然不变（纯函数）。
        // 首选 walk 带回的值；**缺项才逐文件 stat 兜底**（桥没实现 withMetadata / 个别取不到），
        // 兜底也不许伪造：拿不到 stat ⇒ null ⇒ 该文件一律判过期（保守）。
        const statStartedAt = Date.now();
        const stats = new Map<string, FileStat | null>();
        const needStat: string[] = [];
        for (const path of allFiles) {
          const meta = metaByPath.get(path);
          if (meta) stats.set(path, { size: meta.size, mtimeMs: meta.mtimeMs, isDirectory: false });
          else needStat.push(path);
        }
        await compute.runSliced(
          needStat,
          { concurrency: STAT_CONCURRENCY, sliceMs: SLICE_MS, priority: 'background', label: 'index.stat' },
          async (path) => {
            try {
              stats.set(path, await io.stat(path));
            } catch {
              stats.set(path, null); // stat 失败 = 判过期（保守）
            }
          },
        );
        const statMs = Date.now() - statStartedAt;
        // 项目体量指纹：stat 已经逐文件做过，这里只是把它汇成一个判据给下游派生缓存
        // （条件抽取 / 约定校验）。任一文件取不到 stat ⇒ null ⇒ 下游一律不命中。
        const fingerprint = projectFingerprintOf(
          allFiles.map((path) => {
            const st = stats.get(path);
            return { path, mtimeMs: st?.mtimeMs ?? null, size: st?.size ?? null };
          }),
        );

        // 快照：只在项目响应式路径启用（service.buildIndex 的显式调用 = 强制重建）
        let snapshot: IndexSnapshot | null = null;
        /** 逐条目 salvage 的产出（非 null = 这一轮的数据来自"作废面"而非当前键的完好快照） */
        let salvaged: SalvagedSnapshot | null = null;
        const snapStartedAt = Date.now();
        let snapGetMs = 0;
        let snapCoerceMs = 0;
        if (useSnapshot && currentRoot) {
          const key = snapshotKeyFor(currentRoot);
          // 本会话摸过的项目入保留集（在首次 await **之前**登记：prune 是异步收尾，
          // 登记先于落盘就位 ⇒ 交替开项目时不会被别的项目的 prune 竞态误删）
          sessionSnapshotKeys.add(key);
          try {
            // get 内含「读盘 + decode + JSON.parse」——体积过大时这一项就是热启动的主要成本
            const getStartedAt = Date.now();
            const raw = await storage.get<unknown>(key);
            snapGetMs = Date.now() - getStartedAt;
            if (raw !== undefined) {
              const coerceStartedAt = Date.now();
              snapshot = coerceSnapshot(raw, currentRoot);
              snapCoerceMs = Date.now() - coerceStartedAt;
            }
            // 当前键没捡到 / 整体不可用 ⇒ **不是"全树重读"的信号**，而是"逐条目 salvage"的信号：
            // 版本换代（键里嵌着版本，换代后新键必然不存在）、rootDir 写法不符、单条目损坏，
            // 都只该作废**那几条**条目，而不是 2,325 条各自完好、mtime+size 相符的条目。
            // 候选键顺序与成本见 `snapshotKeyCandidatesFor`（当前键已试过，这里跳过）。
            if (snapshot === null) {
              // 候选键第 0 位就是当前键（先就地 salvage：单条目损坏只该重读那一条，不该连坐整棵树），
              // 其余是换代/写法变体的旧键（键里嵌着版本 ⇒ 换代后新键必然不存在，数据躺在旧键那份里）
              for (const candidate of snapshotKeyCandidatesFor(currentRoot)) {
                const cStartedAt = Date.now();
                const craw = candidate === key ? raw : await storage.get<unknown>(candidate);
                snapGetMs += Date.now() - cStartedAt;
                if (craw === undefined) continue;
                const s = salvageSnapshot(craw, { rootDir: currentRoot, key: candidate, knownPaths: allFiles });
                if (s === null) continue;
                if (countEntries(s.entries) === 0) {
                  // 认得这份数据、但一条都读不懂 ⇒ 与"整体弃用"同判：删掉它，别让它反复占读盘时间
                  ctx.log.warn(`Index snapshot candidate unusable (no salvageable entry): ${candidate}`);
                  void storage.delete(candidate).catch(() => undefined);
                  continue;
                }
                salvaged = s;
                snapshot = s;
                break;
              }
              if (snapshot === null && raw !== undefined) {
                // fail-closed 的老规矩：当前键这份连一条都认不出来 → 删除 + 全量重建，绝不"修"快照
                ctx.log.warn('Index snapshot unusable (version/structure/root mismatch); rebuilding from scratch');
                void storage.delete(key).catch(() => undefined);
              }
            }
          } catch (err) {
            ctx.log.warn(`Index snapshot read failed; rebuilding from scratch: ${String(err)}`);
            snapshot = null;
            salvaged = null;
          }
        }
        const snapMs = Date.now() - snapStartedAt;
        /** 换代/损坏/salvage 之后必须把数据**改写回当前键**：否则 salvage 每轮都重付一次读旧键的钱，
         *  而且旧键随后会被 prune 收走 ⇒ 下一轮直接全冷（这是"作废不连坐"能站住的闭环条件） */
        const needsRewrite = salvaged !== null;
        const salvagedSkipped = salvaged?.skipped ?? 0;

        const diff = snapshot ? diffSnapshot(snapshot, allFiles, stats) : { reusable: [], stale: allFiles };

        /**
         * PS-3 双缓冲：第 N+1 批的 `io.readTexts` 在第 N 批**处理前**就发出，让 37 趟
         * 串行往返里"读盘/IPC"与"解析/扫描 CPU"两两重叠（旧形态 await 读 → await 处理
         * 轮班，磁盘与 CPU 从不同时干活）。失败语义不变：整批 rejection 照旧向上传播
         * （晚一拍、在下一轮 await 处），逐位失败仍走 null 位的既有告警路径。
         * 每批发出时同步挂兜订阅（`pending?.catch`）：`process` 抛错早退时孤儿批不再漂
         * unhandled rejection（纪律同 compute.ts 的窗口起跑），正常路径拒绝仍由 await 上抛。
         */
        async function readBatchesPipelined(
          paths: readonly string[],
          process: (chunk: readonly string[], texts: BatchTexts) => Promise<void>,
        ): Promise<void> {
          let pending: Promise<BatchTexts> | null =
            paths.length > 0 ? io.readTexts(paths.slice(0, READ_BATCH)) : null;
          // 首发批同样必须有同步订阅者：兜住"循环首轮前即退出"的理论面（同下：只接孤儿、不改传播）。
          void pending?.catch(() => undefined);
          for (let base = 0; base < paths.length; base += READ_BATCH) {
            const chunk = paths.slice(base, base + READ_BATCH);
            const texts = await pending!; // eslint 无关：循环结构保证首轮已置
            const nextBase = base + READ_BATCH;
            pending = nextBase < paths.length ? io.readTexts(paths.slice(nextBase, nextBase + READ_BATCH)) : null;
            // 兜订阅（防"漏成 unhandled rejection"，纪律同 kernel/compute.ts:196-200）：
            // 下一批的读已在途，若 `process` 抛错（或循环提前退出）就没有下一轮 `await`
            // 来接它 ⇒ 拒绝无订阅者、宿主侧漂出 unhandledrejection 且整批读白付。
            // 这只吞**早退路径**的孤儿拒绝：正常路径的拒绝仍由下一轮 `await pending`
            // 原样上抛（失败语义一字未动——"不吞错也不漂错"）。
            void pending?.catch(() => undefined);
            await process(chunk, texts);
          }
        }

        const parseStartedAt = Date.now();
        const fresh = new Map<string, SnapshotEntry>();
        /**
         * 批量读 + 分片解析（2026-10-16 批量 IO 批）：每 READ_BATCH 个文件一次 IPC
         * （原：每个文件 readText = 2 趟 IPC，2285 个文件 ≈ 4,570 趟）。
         * PS-3 起读批走 `readBatchesPipelined` 双缓冲（批 N+1 的读盘与批 N 的 CPU 重叠）；
         * **片调度/优先级语义原样保留**（批内仍走 runSliced：
         * PARSE_CONCURRENCY（PS-3 对齐池容量）/ SLICE_MS / background 档见常量注）；
         * 读失败位（null）与旧 readText 抛错同语义：记警告、不留结果。
         */
        await readBatchesPipelined(diff.stale, async (chunk, texts) => {
          await compute.runSliced(
            chunk,
            { concurrency: PARSE_CONCURRENCY, sliceMs: SLICE_MS, priority: 'background', label: 'index.parse' },
            async (path, k) => {
              const tf = texts[k];
              if (!tf) {
                // 事实面同步记一笔（IDX-SILENT）：只发一声 warn 的话，作者侧读起来与"盘上没这个文件"
                // 一模一样。被快照旧内容顶替的情形尤其要记——那一类差值仍是 0。
                failures.push({ path, reason: 'read' });
                ctx.log.warn(`Parse skipped (read failed): ${path}`);
                return;
              }
              try {
                // IO 留主线程（worker 内 IPC 未验证），**只把纯解析**搬上并行通道：
                // 有 worker 时是真并行（多槽轮转），无 worker / 通道失败时自动内联回退。
                const payload: ParseFilePayload = { text: tf.text, path };
                const file = await compute.offload<ErbFile>(PARSE_FILE_TASK, payload);
                fresh.set(path, {
                  mtimeMs: tf.mtimeMs,
                  // 双判据的 size 位（PERF-7）：与 mtime 同源口径（walk 顺带 / stat 兜底）
                  size: stats.get(path)?.size ?? null,
                  textLength: tf.text.length,
                  file,
                });
              } catch (err) {
                failures.push({ path, reason: 'parse' });
                ctx.log.warn(`Parse failed: ${path}: ${String(err)}`);
              }
            },
          );
        });
        const parseMs = Date.now() - parseStartedAt;

        // 合并：按本次 walk 顺序取数（快照只换"来源"，byName 聚合顺序与全量重建逐位一致）
        const aggStartedAt = Date.now();
        const ordered: ErbFile[] = [];
        // 逐文件 mtime / size 顺手记下来（同源：重扫文件用 readText/stat 的、复用文件用快照的）——
        // 下游条件抽取按文件粒度复用结果时，只有整项目指纹会出现"改一个文件重算全库"；
        // size（PERF-7 additive）给下游的逐文件判据再叠一层"mtime 同值替换"防线。
        const fileMtimes = new Map<string, number | null>();
        const fileSizes = new Map<string, number | null>();
        for (const path of allFiles) {
          const parsed = fresh.get(path);
          if (parsed?.file) {
            ordered.push(parsed.file);
            fileMtimes.set(path, parsed.mtimeMs);
            fileSizes.set(path, parsed.size);
            continue;
          }
          const old = snapshot?.entries[path];
          if (old?.file) {
            ordered.push(old.file);
            fileMtimes.set(path, old.mtimeMs);
            fileSizes.set(path, old.size);
          }
        }
        const { files, byName } = aggregateIndex(ordered);
        const aggMs = Date.now() - aggStartedAt;
        /** 当前名录摘要（refs 溯源判据，见 `snapshot.nameSetDigest`）；随新扫出的 refs 一起落盘 */
        const namesFp = nameSetDigest(byName.keys());

        /* ---------------- 反向引用扫描（H2 批，判据 = 全局 byName ⇒ 必须排在聚合后） ----------------
         * 只对 **stale 文件**重扫；复用文件直接取快照里的 refs（热构建零额外读盘）。
         * 2026-10-16 批量 IO 批：冷构建的二次文本改走 `io.readTexts` 批量路径——
         * 解析段刚读过的正文还在会话缓存里（mtime+size 判据），这里**零读盘**命中；
         * 万一被缓存上限挤掉，也只付"每批一趟 IPC"而不是每文件两趟。
         *
         * 2026-10-16 PERF-7：**聚合（bySymbol）推迟到首次被消费**（`index.references`
         * 是惰性属性）。消费方只有 find-references / rename 这类按需动作，而聚合要建
         * 全部引用点对象（合成 2,000 文件口径 900k 点 ≈ 170ms + 同量对象）——
         * 热开项目不该替一次可能不发生的查询买单。stale 文件的**扫描**照旧（本轮新读的
         * 文件本来就要扫，且快照落盘需要它们的 refs 一并挂回）。
         *
         * 2026-10-16 PERF-12a：**salvage 轮加一道溯源补正**。存量 refs 是在**当时的名录**下扫出来的，
         * "文件正文没变"只保证记号没变、不保证名录没变——旁处新增一个 `@函数` 会让未变文件的
         * 存量 refs 少一条边。
         * PS-3（本批）把这道洞**补到逐条目闭合**：巡检不再只在 salvage 轮发生——热路径名录变了
         * 同样就地重扫"溯源位对不上/未知"的复用条目（这是**正确性**判据，不是性能旋钮：
         * 改前热轮落盘的是一份"1 条新摘要 + 2,324 条旧摘要"的混账快照，find-references 静默缺边、
         * 下一轮 salvage 再付整树 7.4 s）。信封级 `namesFp`（见 `snapshot.verifiedNamesDigest`）
         * 让"名录没变"这一常见情形退化成一次数比较、整段巡检都不走；变了也只扫差集
         * （摘要跟不上的复用条目），且扫过的条目连同新摘要一起记账 ⇒ **下一轮自动可信**。
         * 代价说清楚：新增/改名一个函数的那一轮开项目，引用段要重读重扫全树未变文件
         * （真语料实测见交付读数；此后轮次照常热）。 */
        const refsStartedAt = Date.now();
        const hasName = (upper: string): boolean => byName.has(upper);
        const refsByPath = new Map<string, FileRefs>();
        const freshToScan = diff.stale.filter((path) => fresh.has(path));
        const provenanceToScan: string[] = [];
        if (snapshot !== null && snapshot.namesFp !== namesFp) {
          // 信封摘要与当前名录不符（含旧盘无信封位）⇒ 逐条目巡检；相符 ⇒ 全体条目已可信，跳过
          for (const path of diff.reusable) {
            const e = snapshot.entries[path];
            if (e !== undefined && !refsAreReusable(e, namesFp)) provenanceToScan.push(path);
          }
        }
        const refsToScan = provenanceToScan.length > 0 ? [...freshToScan, ...provenanceToScan] : freshToScan;
        await readBatchesPipelined(refsToScan, async (chunk, texts) => {
          await compute.runSliced(
            chunk,
            { concurrency: STAT_CONCURRENCY, sliceMs: SLICE_MS, priority: 'background', label: 'index.refs' },
            async (path, k) => {
              const tf = texts[k];
              if (!tf) {
                ctx.log.warn(`Refs scan skipped (reread failed): ${path}`);
                return;
              }
              refsByPath.set(path, scanFileRefs(tf.text, hasName));
            },
          );
        });
        const refsScanMs = Date.now() - refsStartedAt;

        /**
         * 惰性聚合：首次读 `index.references` 才建 bySymbol。
         * 复用条目的 refs 就地汇入（快照元组别名，零拷贝）；构建结果自持缓存，
         * 后续查询零成本。判据（`hasName` = 聚合后的全局名字表）与冷建逐位同源，
         * 因此"冷建 vs 快照"两条路径的 bySymbol 逐字节一致（references.test 钉死）。
         * salvage 轮里溯源补正过的文件已经在上面扫过、已在 `refsByPath` 里，不再覆盖。
         */
        let referencesBuilt: ErbReferenceIndex | null = null;
        const referencesBuild = (): ErbReferenceIndex => {
          if (referencesBuilt) return referencesBuilt;
          const t0 = Date.now();
          let fromSnapshot = 0;
          for (const path of diff.reusable) {
            if (refsByPath.has(path)) continue;
            const reused = snapshot?.entries[path];
            if (reused?.refs !== undefined) {
              refsByPath.set(path, reused.refs);
              fromSnapshot++;
            }
          }
          referencesBuilt = buildReferenceIndex(ordered, refsByPath);
          let sites = 0;
          for (const list of referencesBuilt.bySymbol.values()) sites += list.length;
          ctx.log.info(
            `Index references built on demand (${sites} sites, ${Date.now() - t0}ms; ` +
              `scan ${refsScanMs}ms, rescan ${refsToScan.length}, snapshot ${fromSnapshot})`,
          );
          return referencesBuilt;
        };

        const makeIndex = (): ErbIndex => {
          const idx: ErbIndex = { files, byName, fingerprint, fileMtimes, fileSizes };
          // references 惰性装配（enumerable 保持"索引里有这一项"的既有观感）
          Object.defineProperty(idx, 'references', { get: referencesBuild, enumerable: true, configurable: true });
          return idx;
        };

        ctx.log.info(
          `Indexed ${files.size} ERB files, ${byName.size} distinct functions from ${rootsToScan.length} root(s) ` +
            `in ${Date.now() - buildStartedAt}ms`,
        );
        ctx.log.info(
          `  index breakdown: walk ${walkMs}ms · stat ${statMs}ms · snapshot ${snapMs}ms ` +
            `(get ${snapGetMs}ms, coerce ${snapCoerceMs}ms) · read+parse ${parseMs}ms · aggregate ${aggMs}ms · ` +
            `refs scan ${refsScanMs}ms (rescan ${refsToScan.length}, aggregate deferred) · ` +
            `mtime 来源 walk顺带 ${metaByPath.size} / 兜底逐文件 ${needStat.length} · ` +
            `reused ${diff.reusable.length}/${allFiles.length}`,
        );
        /** salvage 单独一行：壳侧日志按 170 字符截断，把作废面的读数挤到第二行才看得见 */
        ctx.log.info(
          `  index salvage: ${salvaged === null ? 0 : countEntries(salvaged.entries)}/${allFiles.length} ` +
            `(丢 ${salvagedSkipped}, 溯源补正 ${provenanceToScan.length}, 旧形态 ${salvaged?.legacy === true ? 1 : 0}, ` +
            `键 ${salvaged === null ? '-' : salvaged.key})`,
        );

        // 落盘快照（异步，不阻塞广播；失败只告警——它只是缓存，不是数据）
        const snapshotDirty =
          needsRewrite ||
          fresh.size > 0 ||
          (snapshot !== null && countEntries(snapshot.entries) !== allFiles.length);
        if (useSnapshot && currentRoot && gen === generation) {
          const key = snapshotKeyFor(currentRoot);
          if (snapshotDirty) {
            // refs 挂在条目上一起落盘：热复用时反向索引不花一次读盘（挂接纯函数，见 snapshot.attachRefs）。
            // refsByPath 现在只含 stale 文件（PERF-7 惰性聚合）+ 溯源巡检补扫的复用条目（PS-3：
            // 热轮与 salvage 轮同判据），恰好是需要挂接的那批；未复扫条目自带快照 refs、原样留用。
            // 挂上新流水的条目同时记下**当前名录摘要**：下一轮"正文没变、名录变了"就靠它对号入座。
            const entries = attachRefs(mergeEntries(snapshot, allFiles, fresh), refsByPath, namesFp);
            // 信封摘要（PS-3）：全体条目都记了当前账才写数，否则写 null（下轮退回逐条目巡检）
            const envelopeFp = verifiedNamesDigest(entries, namesFp);
            const entryCount = countEntries(entries);
            const saveStartedAt = Date.now();
            void storage
              .set(key, {
                version: SNAPSHOT_VERSION,
                rootDir: currentRoot,
                savedAt: Date.now(),
                namesFp: envelopeFp,
                // 盘上用 v7 紧凑元组（剥可派生字段 + 位置化 + refs 名录摘要位），加载时由 decodeEntries 还原
                entries: encodeEntries(entries),
              })
              .then(() => {
                ctx.log.info(
                  `Index snapshot saved (${entryCount} entries, key ${key}, ` +
                    `${Date.now() - saveStartedAt}ms)`,
                );
                pruneStaleSnapshots();
              })
              .catch((err: unknown) => {
                ctx.log.warn(`Index snapshot save failed: ${String(err)}`);
              });
          } else {
            // 没变更也要收口：磁盘上可能躺着本会话未摸过的项目快照或旧版本孤儿
            pruneStaleSnapshots();
          }
        }

        // 仅在仍是当前代际时提交（避免项目快速切换导致旧结果覆盖新结果）
        if (gen !== generation) return makeIndex();

        const built = makeIndex();
        index = built;
        // 收尾事实（IDX-STATE）：`ready` 与 `nothing-to-scan` 的分界由 `coverageOf()` 判，
        // 这里只交读数——一个根都没走到的那一轮永远不会被写成"扫完了"。
        // 失败文件表（IDX-SILENT）随收尾一起交出：`filesScanned` 与 `filesFailed` 是同一批 walk
        // 的两个面，"走了 N 个、其中 M 个没读成"必须一句话读得出来。
        noteState(gen, 'settled', allFiles.length, built.byName.size, undefined, failures);
        ctx.bus.emit('kojo.functionChanged', {
          projectRoot: currentRoot,
          files: [...files.keys()],
        });
        return built;
      }

      function startBuild(gen: number): Promise<ErbIndex> {
        // 扫描根在**起跑这一刻**定下来（含工作区根），签名必须在任何 await 之前落定：
        // 否则在途期间的事件会拿旧签名比出"根变了"、对着同一份根再开一次全树遍历。
        const wsRoots = workspaceRootsOrNothing();
        const plan = planScanRoots(projectRoots, wsRoots ?? []);
        activeSignature = rootsSignature(plan.roots);
        // 来源事实与 plan **同一次采集**（谁交了几条根 / 谁读不到，判的就是这批根）
        const sources = sourceFactsOf(sourceReadings(wsRoots));
        const wsSide = wsRoots === null ? 'workspace unavailable' : `${wsRoots.length} workspace`;
        ctx.log.info(
          `Scan roots resolved: ${plan.roots.length} to walk (` +
            `${projectRoots.length} kojo + ${wsSide}, ` +
            `${plan.duplicated} duplicate / ${plan.nested} nested folded)`,
        );
        const p = build(plan.roots, gen, true, sources).finally(() => {
          if (inFlight === p) inFlight = null;
        });
        inFlight = p;
        return p;
      }

      const service: ErbParserService = {
        async parseFile(path: string): Promise<ErbFile> {
          const tf = await io.readText(path);
          return parseErbText(tf.text, path);
        },

        parseText: (text: string, path?: string) => parseErbText(text, path),

        scanControlFlow: (text: string) => scanControlFlow(text),

        // 结构体检（2026-10-13 UI 反馈 7）：与骨架扫描共用 scanner 的配对表与行过滤规则，
        // 纯文本入、纯数据出——编辑器去抖后经 ui.editor.decorator 调它，不读盘也不碰索引。
        checkStructure: (text: string) => checkControlFlowStructure(text),

        // 走计算池的并行通道（无通道/失败自动内联）；消费方不需要知道 kind 与 worker
        scanControlFlowOffloaded: (text: string) =>
          compute.offload<ControlFlowStatement[]>(SCAN_FLOW_TASK, { text } satisfies ScanFlowPayload),

        buildIndex: (rootsToScan: string[]) => build(rootsToScan, generation, false, null),

        currentIndex: () => index,

        // 索引这一轮的可查事实（IDX-STATE，additive）：纯读、不读盘、不现算形状判据
        indexState: () => lastIndexState,

        async ensureIndex(): Promise<ErbIndex> {
          // 既有时刻活读一次：会话中途经对话框授权的落点根要在这里进索引，
          // 而不是等一条并不存在的"工作区根变更"事件（判据见 `./index-roots`）。
          refreshScanRoots();
          if (index) return index;
          // 项目切换会立刻作废旧在途构建并替换 inFlight，因此共享 inFlight 是安全的
          if (inFlight) return inFlight;
          if (projectRoots.length === 0) throw new Error('No project is open; cannot build the ERB index');
          return startBuild(generation);
        },

        // 位置 → 符号（B0）：只读已构建的索引，不读盘；未构建 → undefined（不猜）
        functionAt: (path: string, line: number) => (index ? functionAt(index, path, line) : undefined),

        // 符号 → 引用点（H2）：同上，只读 `index.references`，未构建 → 空数组
        referencesTo: (name: string) => (index ? referencesOf(index, name) : []),
      };

      // 响应式：项目打开 → 自动构建（根 = 口上根 ∪ 工作区根，见 startBuild）；项目关闭 → 清空
      ctx.onDispose(
        ctx.bus.on('project.opened', (ev) => {
          const project: GameProject = ev.project;
          currentRoot = project.rootDir;
          projectRoots = [...project.kojoPaths];
          index = null;
          generation++;
          activeSignature = '';
          ctx.log.info(`Project opened; indexing (kojo roots: ${projectRoots.length})…`);
          // 不阻塞事件（构建可能数秒）；结果通过 kojo.functionChanged 广播
          void startBuild(generation).catch((err: unknown) => {
            ctx.log.error(`Index build failed: ${String(err)}`);
          });
        }),
      );
      ctx.onDispose(
        ctx.bus.on('project.closed', () => {
          index = null;
          projectRoots = [];
          currentRoot = '';
          activeSignature = '';
          generation++;
          // 复位事实面（IDX-STATE）：上一棵树的读数留着就是"这一轮还在扫上一轮的东西"
          lastSources = [];
          lastRootsWalked = 0;
          lastFilesScanned = 0;
          lastFunctions = 0;
          lastFailures = [];
          lastIndexState = idleIndexState();
        }),
      );

      /* ---------------- 扫描根变更的"活读时刻"（IDX-ROOT，2026-10-19） ----------------

       为什么不新开一条"工作区根变更"事件：授权发生在**平台命令内**（目录对话框与"写进
       常驻可写根清单"绑成一个原子动作），JS 侧只追加写闸，压根没有可订阅的变更时刻；
       为一条内部判据去扩契约与总线，换来的是"发起方还得记得 emit"——第二份真相。
       于是改成在**既有时刻**活读比对签名（`refreshScanRoots`）：签名一致 ⇒ 一次同步数组
       读 + 字符串比较就返回，绝不为"没变更"付一次全树遍历。

       两个时刻各覆盖一条真实路径：
       - `file.changed`（内核监视器）：作者刚在新授权的落点里建/存了文件；
       - `editor.activeFileChanged`（宿主）：作者切到自己工作区那份口上文件——
         五条语言服务腿直接读 `index` 而**不**经 `ensureIndex()`，光靠那条兜不住这一步。
       */
      ctx.onDispose(
        ctx.bus.on('file.changed', () => {
          refreshScanRoots();
        }),
      );
      ctx.onDispose(
        ctx.bus.on('editor.activeFileChanged', () => {
          refreshScanRoots();
        }),
      );

      ctx.provide('erb.parser', service);

      /* ---------------- 编辑器波浪线（2026-10-13 UI 反馈 7） ----------------

       为什么装饰器由**解析器插件自己**注册，而不是放进某个 UI 插件：
       判据与配对表同源才能不漂移（表在 `scanner.ts`），而 `ui.editor.decorator` 的契约是
       **纯函数**（文本进、行级装饰出，无 React、无 IO）——放这里既不引入新的跨插件依赖，
       也不把"哪些行算控制流语句"这件事外化成第二份知识。

       只管 ERB 方言全集（`isErbDialectPath` 同一条口径：正文 `.erb`/`.erm` + 声明 `.erh`）；
       `.kojo` 的语法诊断另有其人（糖线）。
       超大文件不降级、不跳过：判据是单遍线性扫描，实测读数见 IMPLEMENTATION-LOG 本批记录，
       真要限流也应该由宿主那侧的去抖/上限来做，不在这里悄悄少报。

       2026-10-16 装饰热路径批 —— 声明 `offloadKind`：全文体检是**纯数据进纯数据出**，
       于是宿主可以把它整条请出同步装饰轮、送进 worker（宿主主线程只装配）。适用性判据
       与成形逻辑都住在 `offload.ts` 的 `erbStructureDecorations` **一处**，`decorate()`
       （无通道时的就地回退）与任务实现共用它——两处各拼一份必然漂移。
       */
      ctx.slots.register('ui.editor.decorator', {
        id: 'erb-structure',
        title: 'ERB 结构错误波浪线',
        order: 20,
        offloadKind: STRUCTURE_DECORATIONS_TASK,
        decorate(file): LineDecoration[] {
          return erbStructureDecorations({ path: file.path, text: file.text });
        },
      });

      /* ---------------- 未定义 CALL 目标波浪线（T3，2026-10-16 语言服务批） ----------------

       同一枚槽的第二个贡献。判据（"CALL 直系族名字槽里的裸标识符在不在项目里"）只有
       `ErbIndex.byName` 说了算，而它是本包私产——放宿主或别的插件都得抄第二份口径
       （`references.ts` 的 `erbReferenceDecorations` 是单一真源，与反向索引共用同一条
       可见行遍历、同一张 CALL 族表、同一个记号字符集；漂移的表现是"引用面板说没有、
       波浪线却红"）。

       **刻意不声明 `offloadKind`、同步主线程执行**：判据要读 `index`（项目态），搬进
       worker 就得复制索引——取舍与 `.kojo` 转译同款（项目态硬搬造假错）。扫描是单遍
       线性（实测装饰热路径量级见交付读数），与结构波浪线的"先例：纯函数 + offloadKind"
       不同之处只在数据来源，不在成本形状。

       fail-open：索引未建（未开项目 / 还在建）⇒ **一条不报**——"全红"比"没有提示"
       糟得多（错标比不标危险）；索引几秒后建好，波浪线随之而来。FORM 动态拼接 /
       CALLFORM 全族 / 字符串 / 注释 / `[SKIPSTART]` 区 / `$` 标签全部不报（判据层，
       见 `scanUndefinedCallTargets`），这里只补索引缺席这一态。
       */
      ctx.slots.register('ui.editor.decorator', {
        id: 'erb-reference',
        title: 'ERB 未定义调用目标波浪线',
        order: 21,
        decorate(file): LineDecoration[] {
          const idx = index;
          if (!idx) return []; // fail-open：索引未建零误报
          return erbReferenceDecorations({ path: file.path, text: file.text }, (upper) => idx.byName.has(upper));
        },
      });

      /* ---------------- 💡 一键补齐缺失的闭合语句（2026-10-13 反馈 7 的第二步） ----------------

       波浪线说"少一个 ENDIF"，但**补在哪一行**对新手是更难的一半：补在 `IF` 紧后面与补在
       函数末尾都编译得过，语义却完全不同。本动作给出体检器判定的那个保守位置（这一层确定
       没关的地方），落地走宿主既有的 `EditorTextEdit` 通道 = 一次可撤销的 model 编辑，
       **不碰磁盘**（保存仍由用户 Ctrl+S 决定）。

       门槛两条，都是"不确定就不给动作"：
       - 只对**能写**的路径供（`io.isWritable`）：游戏目录里的 ERB 默认只读，Monaco 的
         `executeEdits` 却照样能改缓冲区 ⇒ 不挡就会造出一个"只读文件被改脏"的怪状态。
         轴二解锁那一份也拿不到动作（插件看不见宿主的会话解锁态），这是刻意的保守。
       - 只对 `unclosed-open` 供：孤儿闭合 / 无主分支也可能是"我们把函数边界漏判了"，
         据一条不确定的推断去删用户写好的行不做（见 `structure-fix.ts` 头注）。
       */
      ctx.slots.register('ui.editor.codeAction', {
        id: 'erb-structure-fix',
        order: 30,
        provideActions: ({ path, text, line, diagnostics, scope }) => {
          if (!isDialect(path) || text.length === 0) return [];
          // 位置未知就不猜：本包的动作**天生按行**（波浪线在哪行，💡 就在哪行给），
          // 少了这个约束会把几十条动作灌进同一个菜单。
          // 唯一的例外是宿主的**整篇批量**请求（`scope:'document'`，E3）：那一次就是要
          // 把全篇每条唯一解都交出来，且点明了整篇的波浪线（`diagnostics` 逐条 code+行
          // 精确应答，与区间请求同一条口径，不近似）。
          if (line === undefined && scope !== 'document') return [];
          if (!io.isWritable(path)) return [];
          return buildStructureFixes(text, line, diagnostics).map((fix) => ({
            title: fix.title,
            kind: 'quickfix' as const,
            // B9：把这条动作消解的那条波浪线交出去（宿主挂进 Monaco 的
            // `CodeAction.diagnostics`）——作者在这条红线上按 `Ctrl+.` 才捞得到它，
            // 应用后 Monaco 还会把被修的那一段标出来
            diagnostics: [fix.diagnostic],
            edits: fix.edits,
            // 有 `edits` 时宿主不调 `run`；仍给以满足契约（并在无改写通道的宿主下无害退化）
            run: () => undefined,
          }));
        },
      });

      /* ---------------- 转到定义（2026-10-15 语言服务批） ----------------

       为什么由解析器插件自己应答：判据（"光标处那个名字是不是本项目的一个函数"）
       只有 `ErbIndex.byName` 说了算。放进任何别的插件都得先拿到索引，等于把同一份
       判据抄第二遍、并在项目开闭时机上与解析器赛跑。

       数据面只有两件事：光标处记号（`symbolTokenAt`）＋ `byName` 反查；跨文件怎么
       跳由**宿主**决定（插件只给"文件:行"，不碰导航——宿主那条 `editor.revealLocation`
       通道已经能开文件定位，不新造机制）。

       三态返回（见契约 `EditorLanguageServiceContribution`）：非 ERB 方言或未打开
       项目 → `undefined`（不是本包的活）；认这个文件但记号不在索引里 → 空数组
       （**不猜**，作者会看到"没有定义"，而不是被跳到错地方）。
       */
      ctx.slots.register('ui.editor.languageService', {
        id: 'erb-definition',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'definition') return undefined;
          if (!isDialect(request.path)) return undefined;
          const idx = index;
          if (!idx) return undefined;
          const refs = definitionTargetsAt(idx, request.path, request.text, request.line, request.column);
          return {
            kind: 'definition',
            // 有列才给区间（`column + 名字长度`，与 `ErbReference.endColumn` 同一条口径）；
            // 索引里没有列这个事实 ⇒ 只交行，让宿主按它的唯一退化判据落到行首——
            // 供方**不补 1**（补了就是假事实），宿主侧的夹取/退化也不许在插件里重抄一遍。
            locations: refs.map((ref) => ({
              filePath: ref.filePath,
              line: ref.startLine,
              ...(ref.nameColumn === undefined
                ? {}
                : { column: ref.nameColumn, span: { columnStart: ref.nameColumn, columnEnd: ref.nameColumn + ref.name.length } }),
            })),
          };
        },
      });

      /* ---------------- 文档大纲（B3，2026-10-15 编辑器特性批） ----------------

       同一枚槽、同一个判别式联合的第二个成员（这正是单槽设计的意图：宿主与既有
       贡献方零改动）。与 `erb-definition` 分枚注册而不是塞进同一个 `provide`：
       两者**数据来源不同**（定义查项目索引、大纲解析当前缓冲区），混在一枚里
       会让"索引未建 ⇒ 大纲也没了"这种假联动发生——大纲不该依赖项目开闭。

       不按 `lineCount` 降级：判据是单遍线性扫描，与波浪线装饰器同一条口径
       （见上方 decorator 的注册注）；吸顶用的就是它，大文件那档由宿主的选项分级
       决定开不开，不由贡献方悄悄少报。
       */
      ctx.slots.register('ui.editor.languageService', {
        id: 'erb-symbols',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'documentSymbol') return undefined;
          if (!isDialect(request.path)) return undefined;
          if (request.text.length === 0) return { kind: 'documentSymbol', symbols: [] };
          return { kind: 'documentSymbol', symbols: erbDocumentSymbols(parseErbText(request.text, request.path)) };
        },
      });

      /* ---------------- 折叠范围（D3，2026-10-15 折叠/面包屑批） ----------------

       同一枚槽的第三个判别成员。ERB 原文普遍不缩进，Monaco 默认的缩进折叠在其上几乎无效，
       折叠层级只能由块结构算——数据源就是 `parseErbText` + `scanControlFlow` 两条既有
       单遍纯函数（配对表单一真源在 scanner，见 `folding.ts` 头注），不新开第三份扫描。
       与大纲同款**不按 lineCount 降级**：两遍线性扫描与波浪线同量级，实测见交付读数。
       */
      ctx.slots.register('ui.editor.languageService', {
        id: 'erb-folding',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'foldingRange') return undefined;
          if (!isDialect(request.path)) return undefined;
          return { kind: 'foldingRange', ranges: erbFoldingRanges(request.text) };
        },
      });

      /* ---------------- 工作区符号（D2，2026-10-15 工作区符号批） ----------------

       同一枚槽的第四个判别成员。判据只有一个：`ErbIndex.byName`（归一化名 → 定义列表），
       而它是本包的私产——放宿主就得让宿主认识 ERB 的名字口径（破"壳层零业务知识"），
       放别的插件就得把索引再抄一份。查询/排序/预算的实现见 `./workspace-symbols.ts`
       （纯函数，逐条断言在 `tests/workspace-symbols.test.ts`）。

       索引缺席（未开项目 / 未建好）→ `undefined`：本包**不答**这个查询，而不是答"没有"。
       区分点在于"项目里真的没有这个名字"与"我根本还没有名录"是两件事，宿主据
       `stats.indexing / stats.indexError` 把后者**说给作者听**（铁律 4 不静默）。
       */
      ctx.slots.register('ui.editor.languageService', {
        id: 'erb-workspace-symbols',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'workspaceSymbol') return undefined;
          const idx = index;
          if (!idx) return undefined;
          const hit = workspaceSymbolsInIndex(idx, request.query, request.limit);
          return { kind: 'workspaceSymbol', symbols: hit.symbols, totalMatched: hit.totalMatched };
        },
      });

      /* ---------------- 行上内联注解（B8，2026-10-16 行内注解批） ----------------

       同一枚槽的第五个判别成员（additive：往联合末尾追加，宿主与既有贡献方零改动）。
       判据与口径全在 `./usage-lens.ts` 的纯函数里，这里只做接线；为什么由本包应答
       而不是放进某个 UI 插件，理由与 `erb-definition` / `erb-workspace-symbols` 完全一致：
       两件事实（缓冲区里的定义、某名的反向引用表）都是本包私产，抄到别处就是抄第二份口径。

       索引缺席（未开项目 / 还没建好）⇒ `undefined` = **本包不答**，而不是答「没有引用」
       （与 `erb-workspace-symbols` 同一区分：真没有 ≠ 我根本还没有名录，铁律 4 不静默）。
       非方言文件（`.kojo` 的行号属派生文本，本批不参与）同样 `undefined`。
       体量/条数/密度三道降级**不归这里**，一律在宿主（`app/src/monaco/kojo-code-lens.ts`）。
       */
      ctx.slots.register('ui.editor.languageService', {
        id: 'erb-usage-lens',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'codeLens') return undefined;
          if (!isDialect(request.path)) return undefined;
          const idx = index;
          if (!idx) return undefined;
          const lenses = usageLenses(parseErbText(request.text, request.path).functions, {
            definitionsOf: (normalizedName) => idx.byName.get(normalizedName)?.length ?? 0,
            referencesOf: (name) => referencesOf(idx, name),
          });
          return { kind: 'codeLens', lenses };
        },
      });

      /* ---------------- 查找引用（R2，2026-10-16 语言服务批） ----------------

       同一枚槽的第七个判别成员（additive：往联合末尾追加，宿主与既有贡献方零改动）。
       判据与 rename 完全同源——`referencesOf`（反向索引）+ `symbolTokenAt`（光标 →
       名字），单一真源都在本包（`references.ts`），宿主只做 Monaco 协议翻译。

       索引缺席（未开项目 / 还没建好）⇒ `undefined` = **本包不答**，而不是答"没有引用"
       （与 `erb-workspace-symbols` 同一区分：真没有 ≠ 我根本还没有名录，铁律 4 不静默）。
       记号不在索引里（变量 / 标签 / 散文）⇒ 空数组（**不猜**，作者看到"没有引用"）。
       */
      ctx.slots.register('ui.editor.languageService', {
        id: 'erb-references',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'references') return undefined;
          if (!isDialect(request.path)) return undefined;
          const idx = index;
          if (!idx) return undefined;
          return {
            kind: 'references',
            locations: erbReferenceLocationsAt(idx, request.text, request.line, request.column),
          };
        },
      });

      /* ---------------- 结构化着色（B6，2026-10-16） ----------------

       同一枚槽的**第六个**判别成员。判据为什么必须住在解析器：这条能力给的是
       "这个名字在这里是定义、形参槽还是引用"，答案是 `parseErbText`（缓冲区结构）与
       `scanFileRefs` + `byName`（名录）算出来的——放到宿主就得让宿主认识 `@` 与 `CALL`，
       放到别的插件就得把这两把尺子各抄一份（漂移的表现是"引用面板说有引用、
       着色却不亮"）。引用那条腿**逐字复用** `scanFileRefs`，与查找引用/重命名同判据。

       索引缺席时**仍应答**（只交声明那部分）：`@` 定义与 `#DIM` 声明本就是缓冲区事实，
       与项目开闭无关；返回 `undefined` 等于谎称"这文件不归我管"。
       */
      ctx.slots.register('ui.editor.languageService', {
        id: 'erb-semantic-tokens',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'semanticToken') return undefined;
          if (!isDialect(request.path)) return undefined;
          return { kind: 'semanticToken', spans: erbSemanticTokens(request.text, index) };
        },
      });

      /* ---------------- 实参位行内提示（LS-R6，2026-10-16 语言服务批） ----------------

       同一枚槽的第七个判别成员。判据为什么必须住在本包：提示说什么（第 j 个实参 =
       第 j 个声明槽，槽名来自被调方 `@` 头）全是 `ErbIndex` 的私产——放宿主就得让宿主
       认识形参表，放别的插件就得把索引再抄一份（与 erb-definition / erb-workspace-symbols
       同一条理由）。说什么 / 不说什么的可证明边界与性能纪律见 `./inlay-hints.ts` 头注。

       索引缺席（未开项目 / 还没建好）⇒ `undefined` = 本包不答（与 workspace-symbols
       同一区分：真没有提示 ≠ 我还没有名录）；非方言文件同样 `undefined`。
       宿主侧的体量降级与 Monaco 形状翻译见 `app/src/monaco/kojo-inlay-hints.ts`。
       */
      ctx.slots.register('ui.editor.languageService', {
        id: 'erb-inlay-hints',
        order: 20,
        provide: (request) => {
          if (request.kind !== 'inlayHint') return undefined;
          if (!isDialect(request.path)) return undefined;
          const idx = index;
          if (!idx) return undefined;
          return { kind: 'inlayHint', hints: callArgumentHints(request.text, (name) => inlaySlotsOf(idx, name)) };
        },
      });
    },
  };
}
