import { mkdtempSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameProject } from '@kojo/plugin-api';
import { isPathUnder } from '@kojo/plugin-api';
import { createKernel } from '../../kernel/src/kernel';
import { NodeBridge } from '../../kernel/tests/helpers/node-bridge';
import { MemoryStorageBackend } from '../../kernel/tests/helpers/memory-storage';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { DEFAULT_SEARCH_EXTENSIONS } from '../src/ui/search-query';
import { collectSearchScopes, narrowRoots } from '../src/ui/search-scope';

/**
 * 真实语料读数（C3 领域限定检索批；`KOJO_SMOKE_PROJECT` 守门，语料不在位 ⇒ 整组跳过）。
 *
 * 这份文件存在的唯一理由：**"收窄 roots 真的少扫"必须是实测数字，不是形容词**。
 * 读的是候选**枚举**这一腿（决定读盘量的那一步；匹配开销按枚举到的文件数线性放大）。
 * 判据链路与生产完全同源：真语料 → 真 `loadProject` → 真 `charaIndex.kojoDir` →
 * 槽上真提供方 → 宿主 `collectSearchScopes` / `narrowRoots`。
 *
 * 口径与 Rust 侧 `collect_files` 对齐的两条：跳过隐藏条目（名以 `.` 起头）、
 * 只算扩展名命中的文件（`DEFAULT_SEARCH_EXTENSIONS`，与过滤框缺省同源）。
 * 耗时是 **Node 侧枚举**的墙钟（原生侧读的是同一批文件，量级同源；这里不谎称是 Rust 的数）。
 *
 * 挑哪个角色做对比：**枚举文件数最多的那个**——这是收窄的最坏情况，
 * 于是这里报出来的"少扫"是**下界**，不是挑一个漂亮样本；同时给出中位角色的量。
 */

const SMOKE = process.env.KOJO_SMOKE_PROJECT;

/** 一次枚举的读数：候选文件 + 墙钟耗时（字节数按需另算，不混进计时窗口） */
interface Enumerated {
  files: string[];
  ms: number;
}

/** 目录树枚举（同步 readdir withFileTypes：Dirent 自带类型，不需要逐条 stat） */
function enumerate(roots: readonly string[]): Enumerated {
  const exts = new Set(DEFAULT_SEARCH_EXTENSIONS.map((e) => e.toLowerCase()));
  const started = performance.now();
  const files: string[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 读不动的目录跳过（Rust 侧记 skipped.unreadable，这里只关心量级）
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // 与 Rust is_hidden_entry 同口径
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf('.');
      const ext = dot <= 0 ? '' : entry.name.slice(dot + 1).toLowerCase();
      if (exts.has(ext)) files.push(p);
    }
  }
  return { files, ms: Math.round(performance.now() - started) };
}

/** 候选文件的字节总量（读盘量的真身；只在计时窗外算，不进 ms） */
function totalBytes(files: readonly string[]): number {
  let sum = 0;
  for (const p of files) {
    try {
      sum += statSync(p).size;
    } catch {
      /* 读不动就不算（与 Rust 侧的 unreadable 同一态度：不拖垮整轮读数） */
    }
  }
  return sum;
}

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

describe.skipIf(!SMOKE)('检索范围 · 真实语料枚举读数', () => {
  let appData: string;
  let kernel: Awaited<ReturnType<typeof createKernel>>;
  let project: GameProject;

  beforeAll(async () => {
    statSync(SMOKE!); // 环境变量指向不存在的目录 = 硬失败，不静默跳过
    appData = mkdtempSync(join(tmpdir(), 'kojo-scope-smoke-'));
    kernel = await createKernel({
      platform: new NodeBridge(appData),
      plugins: [createEratwAdapterPlugin()],
      storageBackend: new MemoryStorageBackend(),
    });
    await kernel.start();
    project = await kernel.project.open(SMOKE!);
  }, 180_000);

  afterAll(async () => {
    if (kernel) await kernel.stop();
  }, 60_000);

  it('真 charaIndex → 真候选；单角色枚举量显著小于全库（读数进提交信息）', () => {
    const catalog = collectSearchScopes(kernel.slots.query('search.scope'), project);
    expect(catalog.notices).toEqual([]);

    // 候选与真源恒等：有口上目录的角色数 == 下拉条数（不另建名单 ⇒ 不可能漂移）
    const withDir = [...project.charaIndex.values()].filter((c) => c.kojoDir);
    expect(catalog.items.length).toBe(withDir.length);
    expect(catalog.items.length).toBeGreaterThan(100);

    const roots = [project.rootDir];
    const full = enumerate(roots);
    expect(full.files.length).toBeGreaterThan(1000);

    // 逐个角色枚举一次：拿量最大的一份（= 收窄的下界），顺手留中位做分布感
    const runs = catalog.items.map((scope) => ({ scope, run: enumerate(narrowRoots(roots, scope).roots) }));
    const counts = runs.map((r) => r.run.files.length).sort((a, b) => a - b);
    const widest = runs.reduce((a, b) => (b.run.files.length > a.run.files.length ? b : a));
    const median = counts[Math.floor(counts.length / 2)]!;

    // 收窄正确性（不只是"更少"）：每一条范围的候选都必须住在该角色的目录里
    for (const { scope, run } of runs) {
      expect(narrowRoots(roots, scope).unreachable).toEqual([]); // 落得进检索根（不是假收窄）
      for (const p of run.files) expect(isPathUnder(scope.roots[0]!, p)).toBe(true);
    }
    expect(widest.run.files.length).toBeLessThan(full.files.length);

    const savedPct = ((1 - widest.run.files.length / full.files.length) * 100).toFixed(1);
    const fullBytes = totalBytes(full.files);
    const widestBytes = totalBytes(widest.run.files);
    const byteSavedPct = ((1 - widestBytes / fullBytes) * 100).toFixed(1);
    console.log(
      `[search-scope 语料读数] 角色目录 ${catalog.items.length} 个 · ` +
        `全库枚举 ${full.files.length} 个候选 / ${full.ms}ms / ${mb(fullBytes)}MB · ` +
        `限定「${widest.scope.label}」${widest.run.files.length} 个 / ${widest.run.ms}ms / ${mb(widestBytes)}MB` +
        `（少扫 ${savedPct}% 文件 / ${byteSavedPct}% 字节；取枚举量最大的角色=下界，中位角色 ${median} 个）`,
    );
  }, 240_000);
});
