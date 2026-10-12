import type { ErbFile, ErbFunctionRef, ErbIndex, ErbParserService, FileIO, GameProject, Plugin } from '@kojo/plugin-api';
import { parseErbText, scanControlFlow } from './scanner';

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
 */

const IO = 'kernel.io';
const ERB_EXT = /\.er[bm]$/i;

/** 并发受限的批量任务（避免一次性打开数千文件） */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function createErbParserPlugin(): Plugin {
  return {
    id: 'erb-parser',
    version: '0.2.0',
    provides: ['erb.parser'],
    requires: [IO],
    activate(ctx) {
      const io = ctx.inject<FileIO>(IO);

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

      async function build(rootsToScan: string[], gen: number): Promise<ErbIndex> {
        // 耗时拆分（内核优化 L0）：索引是"开项目级联"的第一段，必须在日志里可见
        const buildStartedAt = Date.now();
        const files = new Map<string, ErbFile>();
        const byName = new Map<string, ErbFunctionRef[]>();

        // 收集全部 ERB 文件
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

        const parseStartedAt = Date.now();
        const parsed = await mapLimit(allFiles, 12, async (path) => {
          try {
            const tf = await io.readText(path);
            return parseErbText(tf.text, path);
          } catch (err) {
            ctx.log.warn(`Parse failed: ${path}: ${String(err)}`);
            return null;
          }
        });

        for (const file of parsed) {
          if (!file) continue;
          files.set(file.path, file);
          for (const fn of file.functions) {
            const refs = byName.get(fn.normalizedName) ?? [];
            refs.push({
              name: fn.name,
              normalizedName: fn.normalizedName,
              filePath: fn.filePath,
              startLine: fn.startLine,
              endLine: fn.endLine,
            });
            byName.set(fn.normalizedName, refs);
          }
        }

        ctx.log.info(
          `Indexed ${files.size} ERB files, ${byName.size} distinct functions from ${rootsToScan.length} root(s) ` +
            `in ${Date.now() - buildStartedAt}ms (walk+read+parse ${Date.now() - parseStartedAt}ms)`,
        );

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
        const p = build(roots, gen).finally(() => {
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

        buildIndex: (rootsToScan: string[]) => build(rootsToScan, generation),

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
