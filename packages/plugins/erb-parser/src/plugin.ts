import type {
  ComputePool,
  ControlFlowStatement,
  ErbFile,
  ErbIndex,
  ErbParserService,
  FileIO,
  FileStat,
  GameProject,
  Plugin,
} from '@kojo/plugin-api';
import { KernelServices } from '@kojo/plugin-api';
import { PARSE_FILE_TASK, SCAN_FLOW_TASK, erbParserTasks, type ParseFilePayload, type ScanFlowPayload } from './offload';
import { parseErbText, scanControlFlow } from './scanner';
import {
  SNAPSHOT_VERSION,
  aggregateIndex,
  coerceSnapshot,
  diffSnapshot,
  mergeEntries,
  snapshotKeyFor,
  type IndexSnapshot,
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
 */

const IO = 'kernel.io';
const ERB_EXT = /\.er[bm]$/i;

/** 索引三段（walk 之外）的窗口并发度：stat 轻、parse 重 */
const STAT_CONCURRENCY = 32;
const PARSE_CONCURRENCY = 12;
/** 片预算：半个 60fps 帧（与计算池默认一致） */
const SLICE_MS = 8;

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
      /** 当前口上根（由 project.opened 提供） */
      let roots: string[] = [];
      /** 当前项目根（事件载荷用） */
      let currentRoot = '';
      /** 代际号：项目切换时作废过期构建的结果 */
      let generation = 0;

      async function build(rootsToScan: string[], gen: number, useSnapshot: boolean): Promise<ErbIndex> {
        // 耗时拆分（内核优化 L0）：索引是"开项目级联"的第一段，必须在日志里可见
        const buildStartedAt = Date.now();
        const allFiles: string[] = [];
        for (const root of rootsToScan) {
          const entries = await io.walkDir(root, {
            includeFiles: true,
            includeDirs: false,
            filter: (e) => e.isDirectory || ERB_EXT.test(e.name),
          });
          for (const e of entries) {
            if (!e.isDirectory && ERB_EXT.test(e.name)) allFiles.push(e.path);
          }
        }

        // 体量指纹：逐文件 stat 取 mtime（与 readText 的 mtimeMs 同源口径），
        // 是增量复扫的判据——mtime 没变的文件，解析结果必然不变（纯函数）。
        const statStartedAt = Date.now();
        const stats = new Map<string, FileStat | null>();
        await compute.runSliced(
          allFiles,
          { concurrency: STAT_CONCURRENCY, sliceMs: SLICE_MS, priority: 'background', label: 'index.stat' },
          async (path) => {
            try {
              stats.set(path, await io.stat(path));
            } catch {
              stats.set(path, null); // stat 失败 = 判过期（保守）
            }
          },
        );

        // 快照：只在项目响应式路径启用（service.buildIndex 的显式调用 = 强制重建）
        let snapshot: IndexSnapshot | null = null;
        if (useSnapshot && currentRoot) {
          const key = snapshotKeyFor(currentRoot);
          try {
            const raw = await storage.get<unknown>(key);
            if (raw === undefined) {
              snapshot = null; // 首次打开 / 无快照 → 全量（正常路径）
            } else {
              snapshot = coerceSnapshot(raw, currentRoot);
              if (snapshot === null) {
                // fail-closed：版本/结构/项目根任一不符 → 删除 + 全量重建，绝不"修"快照
                ctx.log.warn('Index snapshot unusable (version/structure/root mismatch); rebuilding from scratch');
                void storage.delete(key).catch(() => undefined);
              }
            }
          } catch (err) {
            ctx.log.warn(`Index snapshot read failed; rebuilding from scratch: ${String(err)}`);
            snapshot = null;
          }
        }

        const diff = snapshot ? diffSnapshot(snapshot, allFiles, stats) : { reusable: [], stale: allFiles };

        const parseStartedAt = Date.now();
        const fresh = new Map<string, SnapshotEntry>();
        await compute.runSliced(
          diff.stale,
          { concurrency: PARSE_CONCURRENCY, sliceMs: SLICE_MS, priority: 'background', label: 'index.parse' },
          async (path) => {
            try {
              // IO 留主线程（worker 内 IPC 未验证），**只把纯解析**搬上并行通道：
              // 有 worker 时是真并行（多槽轮转），无 worker / 通道失败时自动内联回退。
              const tf = await io.readText(path);
              const payload: ParseFilePayload = { text: tf.text, path };
              const file = await compute.offload<ErbFile>(PARSE_FILE_TASK, payload);
              fresh.set(path, { mtimeMs: tf.mtimeMs, textLength: tf.text.length, file });
            } catch (err) {
              ctx.log.warn(`Parse failed: ${path}: ${String(err)}`);
            }
          },
        );

        // 合并：按本次 walk 顺序取数（快照只换"来源"，byName 聚合顺序与全量重建逐位一致）
        const ordered: ErbFile[] = [];
        for (const path of allFiles) {
          const parsed = fresh.get(path)?.file;
          if (parsed) {
            ordered.push(parsed);
            continue;
          }
          const reused = snapshot?.entries[path]?.file;
          if (reused) ordered.push(reused);
        }
        const { files, byName } = aggregateIndex(ordered);

        ctx.log.info(
          `Indexed ${files.size} ERB files, ${byName.size} distinct functions from ${rootsToScan.length} root(s) ` +
            `in ${Date.now() - buildStartedAt}ms (stat ${parseStartedAt - statStartedAt}ms, ` +
            `read+parse ${Date.now() - parseStartedAt}ms, reused ${diff.reusable.length}/${allFiles.length})`,
        );

        // 落盘快照（异步，不阻塞广播；失败只告警——它只是缓存，不是数据）
        const snapshotDirty =
          fresh.size > 0 || (snapshot !== null && Object.keys(snapshot.entries).length !== allFiles.length);
        if (useSnapshot && currentRoot && gen === generation && snapshotDirty) {
          const key = snapshotKeyFor(currentRoot);
          const entries = mergeEntries(snapshot, allFiles, fresh);
          void storage
            .set(key, { version: SNAPSHOT_VERSION, rootDir: currentRoot, savedAt: Date.now(), entries })
            .then(() => {
              ctx.log.info(`Index snapshot saved (${Object.keys(entries).length} entries, key ${key})`);
            })
            .catch((err: unknown) => {
              ctx.log.warn(`Index snapshot save failed: ${String(err)}`);
            });
        }

        // 仅在仍是当前代际时提交（避免项目快速切换导致旧结果覆盖新结果）
        if (gen !== generation) return { files, byName };

        const built: ErbIndex = { files, byName };
        index = built;
        ctx.bus.emit('kojo.functionChanged', {
          projectRoot: currentRoot,
          files: [...files.keys()],
        });
        return built;
      }

      function startBuild(gen: number): Promise<ErbIndex> {
        const p = build(roots, gen, true).finally(() => {
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

        // 走计算池的并行通道（无通道/失败自动内联）；消费方不需要知道 kind 与 worker
        scanControlFlowOffloaded: (text: string) =>
          compute.offload<ControlFlowStatement[]>(SCAN_FLOW_TASK, { text } satisfies ScanFlowPayload),

        buildIndex: (rootsToScan: string[]) => build(rootsToScan, generation, false),

        currentIndex: () => index,

        async ensureIndex(): Promise<ErbIndex> {
          if (index) return index;
          // 项目切换会立刻作废旧在途构建并替换 inFlight，因此共享 inFlight 是安全的
          if (inFlight) return inFlight;
          if (roots.length === 0) throw new Error('No project is open; cannot build the ERB index');
          return startBuild(generation);
        },
      };

      // 响应式：项目打开 → 自动构建；项目关闭 → 清空
      ctx.onDispose(
        ctx.bus.on('project.opened', (ev) => {
          const project: GameProject = ev.project;
          currentRoot = project.rootDir;
          roots = [...project.kojoPaths];
          index = null;
          generation++;
          ctx.log.info(`Project opened; indexing ${roots.length} root(s)…`);
          // 不阻塞事件（构建可能数秒）；结果通过 kojo.functionChanged 广播
          void startBuild(generation).catch((err: unknown) => {
            ctx.log.error(`Index build failed: ${String(err)}`);
          });
        }),
      );
      ctx.onDispose(
        ctx.bus.on('project.closed', () => {
          index = null;
          roots = [];
          currentRoot = '';
          generation++;
        }),
      );

      ctx.provide('erb.parser', service);
    },
  };
}
