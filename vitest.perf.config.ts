import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { perfInclude } from './tools/perf-suite.mjs';
import mainConfig from './vitest.config';

/**
 * 计时预算用例的**串行静默池**（唯一消费者是 `pnpm test:perf`）。
 *
 * 为什么单独一池：CI（windows-latest 4 核）里墙钟断言红的 11 次全部是并行池互相饿死——
 * 一个 0.5 ms 的读数被同池的 100 个 worker 挤成 2.5 ms 就会翻线（`docs/PITFALLS.md` §72 的纪律，
 * 这一池把它变成机制）。判据、清单与主配置同源：`tools/perf-suite.mjs`。
 *
 * 一个时刻只允许**一个文件、一条线程**：vitest 4 里 `fileParallelism: false` 会把 `maxWorkers`
 * 强制成 1（见 `InlineConfig.fileParallelism` 的注释），再加 `maxWorkers: 1` 是显式自证；
 * vitest 4 已无 `poolOptions`/`minWorkers` 这两个键，所以不写。
 */
const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  // alias / extensions 直接取主配置对象（同一份，不复制粘贴）
  resolve: mainConfig.resolve,
  test: {
    include: [...perfInclude(rootDir)],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    // 满载下单个计时文件也可能跑到几十秒；清理钩子在满负载下要 60 s 以上预算（PITFALLS）
    testTimeout: 60000,
    hookTimeout: 120000,
  },
});
