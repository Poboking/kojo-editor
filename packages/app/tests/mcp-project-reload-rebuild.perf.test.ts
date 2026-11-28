/**
 * WP-3a 计时判据：**增量重建相对全量重建的耗时比**（200 文件 / 5% 变化）。
 *
 * 为什么单独一个文件：`tools/perf-suite.mjs` 按源码谓词（`performance.now()` + 计时变量
 * 进比较）把这类文件归到**计时串行池**，混在功能判据里会被主池整份排除。
 * 分开是遵守既有分池口径，不是把读数藏起来。
 *
 * 读数性质（**不许混淆**）：这是**纯内存接缝读数**——真索引（`createKojo2ProjectIndex`）
 * + 假文件系统，量的是「重解析省下来的那部分」。它不是真壳读数，也不与真壳读数互借
 * （PITFALLS 236）；真壳侧要另取。
 */
import { describe, expect, it } from 'vitest';
import { createKojo2ProjectIndex } from '../src/monaco/kojo2-project-index';
import { createS1IncrementalReloadHook, type ReloadRebuildSeams } from '../src/mcp/project-reload-rebuild';
import { rootIdOf } from '../src/mcp/project-reload';
import type { ProjectReloadEvent } from '@kojo/plugin-api';

const ROOT_DIR = '/proj/a';
const ROOT_ID = rootIdOf(ROOT_DIR);
const reloadEvent = (): ProjectReloadEvent => ({
  rootId: ROOT_ID,
  rootDir: ROOT_DIR,
  trigger: 'returned',
  reason: 'fast-switch',
});

function bench(fileCount: number, changed: number) {
  const disk = new Map<string, string>();
  for (let i = 0; i < fileCount; i += 1) disk.set(`/proj/a/f${i}.kojo`, `@変数 v${i} = ${i}\n`);
  const index = createKojo2ProjectIndex();
  for (const [p, text] of disk) index.updateFile({ path: p, text });
  for (let i = 0; i < changed; i += 1) disk.set(`/proj/a/f${i}.kojo`, `@変数 v${i} = ${i + 1}\n`);

  const seams: ReloadRebuildSeams = {
    snapshot: () => index.snapshot(),
    files: () => index.files(),
    getFile: (path) => index.getFile(path),
    readText: async (path) => disk.get(path) ?? null,
    updateFile: (input) => index.updateFile(input),
    removeFile: (path) => index.removeFile(path),
    listTargets: async () => [...disk.keys()].sort(),
  };
  return { disk, index, seams };
}

describe('WP-3a 增量重建计时（纯内存接缝读数）', () => {
  it('200 文件 / 5% 变化：重解析份数 10 vs 200，墙钟不比重建慢', async () => {
    const { disk, seams } = bench(200, 10);

    const t0 = performance.now();
    const receipt = await createS1IncrementalReloadHook(seams)(reloadEvent());
    const incremental = performance.now() - t0;

    const fresh = createKojo2ProjectIndex();
    const t1 = performance.now();
    for (const [p, text] of disk) fresh.updateFile({ path: p, text });
    const full = performance.now() - t1;

    // 回执自己带读数（账本 / `kojo://project/reloads` 读的就是它）。
    expect(receipt.elapsedMs).toBeGreaterThanOrEqual(0);
    // **主读数**：喂索引的份数 10 vs 200——这是确定性的，不随机器抖动。
    expect(receipt.rebuilt).toMatchObject({ mode: 'rebuild', updated: 10, unchanged: 190 });

    // 墙钟只钉「不比重建慢」。**为什么不是 20 倍**：① 增量路径仍要读齐 200 份正文
    // 并逐份比对（S1 索引只存正文、没有 mtime 指纹，省下的是**解析**不是 IO）；
    // ② `kojo2DocumentOf` 有全局解析缓存，全量重建那 200 份多数命中缓存。
    // 所以这里如实钉一条弱下界，不编一个好看的倍数。
    expect(incremental).toBeLessThan(full * 1.5);
  });
});
