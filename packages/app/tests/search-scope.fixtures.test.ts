import { existsSync, mkdtempSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameProject } from '@kojo/plugin-api';
import { isPathUnder } from '@kojo/plugin-api';
import { createKernel } from '../../kernel/src/kernel';
import { NodeBridge } from '../../kernel/tests/helpers/node-bridge';
import { MemoryStorageBackend } from '../../kernel/tests/helpers/memory-storage';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { DEFAULT_SEARCH_EXTENSIONS } from '../src/ui/search-query';
import { collectSearchScopes, findSearchScope, narrowRoots } from '../src/ui/search-scope';

/**
 * 全链路接线（C3 领域限定检索批；**语料无关**，用合成 fixtures 跑）。
 *
 * 钉的是"两个半边走到了一起"这件事——语料读数只在大目录在场时才跑，
 * 于是那条腿在 CI 上永远绿不到；这里用 `fixtures/mini-game/`（已入库）把
 * `真 kernel → 真 adapter loadProject → 真槽注册 → 宿主摊平 → 宿主收窄`
 * 整条链在无外部数据的环境下也钉住：
 *
 * 1. 候选 = 有口上目录的角色数（**不另建名单**：与 `charaIndex` 恒等，防漂移）；
 * 2. 候选的根 = `charaIndex[].kojoDir` **原样**（一字不差，防"宿主自己拼路径"）；
 * 3. 收窄真的落进检索根（`unreachable` 空）——kojoDir 是绝对路径，
 *    项目根的写法/分隔符若有漂移，这一步就会把它判成"不可达"而静默少扫；
 * 4. 收窄后枚举到的候选文件**严格少于**全库，且每一个都住在该角色目录里。
 */

const MINI_DIR = fileURLToPath(new URL('../../../fixtures/mini-game/', import.meta.url));

/** 按原生侧口径枚举候选文件（扩展名命中 + 跳过隐藏条目；与 Rust `collect_files` 同判据） */
function enumerate(roots: readonly string[]): string[] {
  const exts = new Set(DEFAULT_SEARCH_EXTENSIONS.map((e) => e.toLowerCase()));
  const out: string[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!statSync(p).isFile()) continue;
      const dot = entry.name.lastIndexOf('.');
      if (exts.has(dot <= 0 ? '' : entry.name.slice(dot + 1).toLowerCase())) out.push(p);
    }
  }
  return out.sort();
}

describe.skipIf(!existsSync(MINI_DIR))('检索范围 · 合成 fixtures 全链路', () => {
  let kernel: Awaited<ReturnType<typeof createKernel>>;
  let project: GameProject;

  beforeAll(async () => {
    kernel = await createKernel({
      platform: new NodeBridge(mkdtempSync(join(tmpdir(), 'kojo-scope-mini-'))),
      plugins: [createEratwAdapterPlugin()],
      storageBackend: new MemoryStorageBackend(),
    });
    await kernel.start();
    project = await kernel.project.open(MINI_DIR);
  }, 120_000);

  afterAll(async () => {
    if (kernel) await kernel.stop();
  }, 30_000);

  it('真项目 → 真候选 → 收窄到该角色目录，且确实少扫', () => {
    const catalog = collectSearchScopes(kernel.slots.query('search.scope'), project);
    expect(catalog.notices).toEqual([]);

    const withDir = [...project.charaIndex.values()].filter((c) => c.kojoDir);
    expect(catalog.items.length).toBe(withDir.length);
    expect(catalog.items.length).toBeGreaterThan(0);

    const [first] = withDir;
    const item = findSearchScope(catalog.items, `eratw-adapter:chara:${first!.no}`);
    expect(item).not.toBeNull();
    expect(item!.roots).toEqual([first!.kojoDir]); // 原样，不重拼

    const narrowing = narrowRoots([project.rootDir], item);
    expect(narrowing.unreachable).toEqual([]);
    expect(narrowing.roots).toEqual([first!.kojoDir]);

    const full = enumerate([project.rootDir]);
    const scoped = enumerate(narrowing.roots);
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.length).toBeLessThan(full.length);
    for (const p of scoped) expect(isPathUnder(first!.kojoDir!, p)).toBe(true);
  });

  it('没开项目 ⇒ 零候选（选择器不画 = 新功能默认关）', () => {
    const catalog = collectSearchScopes(kernel.slots.query('search.scope'), null);
    expect(catalog.items).toEqual([]);
    expect(catalog.notices).toEqual([]);
  });
});
