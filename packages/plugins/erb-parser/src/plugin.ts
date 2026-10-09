import type { ErbFile, ErbFunctionRef, ErbIndex, ErbParserService, FileIO, Plugin } from '@kojo/plugin-api';
import { parseErbText } from './scanner';

/**
 * erb-parser 插件。
 *
 * - 服务键：`erb.parser`（provides）
 * - 依赖：`kernel.io`（读文件 + 目录遍历；自动处理编码探测）
 * - 零游戏知识：不识别任何 `M_KOJO` 之类的命名约定（那是 game.adapter 的领域）
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
    version: '0.1.0',
    provides: ['erb.parser'],
    requires: [IO],
    activate(ctx) {
      const io = ctx.inject<FileIO>(IO);

      const service: ErbParserService = {
        async parseFile(path: string): Promise<ErbFile> {
          const tf = await io.readText(path);
          return parseErbText(tf.text, path);
        },

        parseText: (text: string, path?: string) => parseErbText(text, path),

        async buildIndex(roots: string[]): Promise<ErbIndex> {
          const files = new Map<string, ErbFile>();
          const byName = new Map<string, ErbFunctionRef[]>();

          // 收集全部 ERB 文件
          const allFiles: string[] = [];
          for (const root of roots) {
            const entries = await io.walkDir(root, {
              includeFiles: true,
              includeDirs: false,
              filter: (e) => e.isDirectory || ERB_EXT.test(e.name),
            });
            for (const e of entries) {
              if (!e.isDirectory && ERB_EXT.test(e.name)) allFiles.push(e.path);
            }
          }

          const parsed = await mapLimit(allFiles, 12, async (path) => {
            try {
              return await service.parseFile(path);
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

          ctx.log.info(`Indexed ${files.size} ERB files, ${byName.size} distinct functions from ${roots.length} root(s)`);
          return { files, byName };
        },
      };

      ctx.provide('erb.parser', service);
    },
  };
}
