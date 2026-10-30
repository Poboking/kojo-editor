/**
 * `tools/new-dialect.mjs` 的单元闸（不碰真实仓库：每例在临时目录里复制 5 个共享文件当树）。
 *
 * 钉四件作者真的会踩的事：
 * 1. 生成物齐全（插件 7 文件：package.json + 4 个 src + 2 个 tests）且**不含**宿主/别的插件依赖；
 * 2. 共享文件**只加行**：清单只多一个 `// new-dialect` 块，依赖/别名各一行，既有项逐字不动；
 * 3. 重复执行拒绝（同 id / 同目录 / 清单已有）且**一个字节都不写**；
 * 4. `--dry-run` 只打印、不落盘。
 *
 * 端到端的真跑（脚手架 → conformance → golden 逐字）在 `dialect-e2e.test.ts`，默认跳过。
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { MANIFEST_REL, extractAdapterEntries } from '../adapter-manifest-entries.mjs';
import { applyPlan, formatPlan, planDialect } from '../new-dialect.mjs';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../new-dialect.mjs', import.meta.url));

/** 临时树要复制的共享文件（相对仓库根）：清单 / app 包清单 / 三份别名表 */
const SEED_FILES = [
  MANIFEST_REL,
  'packages/app/package.json',
  'tsconfig.json',
  'packages/app/tsconfig.json',
  'vitest.config.ts',
];

const tempDirs: string[] = [];

async function makeTree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-new-dialect-'));
  tempDirs.push(root);
  for (const rel of SEED_FILES) {
    const target = path.join(root, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(REPO, rel), target);
  }
  return root;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** 临时树的完整快照（相对路径 + 内容）：判"有没有落盘"用逐字节，不看 mtime */
async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else out.push(rel + '::' + (await fs.readFile(path.join(dir, entry.name), 'utf8')));
    }
  };
  await walk(root, '');
  return out.sort();
}

const okPlan = (root: string, over: Record<string, string> = {}) =>
  planDialect({ root, id: 'tempdialect', title: 'Temp Dialect', ext: 'kojo2', ...over });

describe('清单解析 · conformance 的列来自这里', () => {
  it('真清单：条目齐全、可选导出名只在声明时出现', async () => {
    const source = await fs.readFile(path.join(REPO, MANIFEST_REL), 'utf8');
    const entries = extractAdapterEntries(source);
    expect(entries.length).toBeGreaterThanOrEqual(8);
    const eratw = entries.find((entry) => entry.id === 'eratw');
    expect(eratw).toMatchObject({ scope: 'boot', dir: 'eratw-adapter' });
    expect(eratw?.kojo2AdapterExport).toBeUndefined();
    const erafl = entries.find((entry) => entry.id === 'erafl');
    expect(erafl).toMatchObject({
      scope: 'project',
      kojo2AdapterExport: 'ERAFL_GAME_ADAPTER',
      kojo2BackendFactoryExport: 'createEraflEmitBackend',
    });
  });

  it('空数组 / 缺字段条目 → 抛错（fail-closed，不返回半份清单）', () => {
    expect(() => extractAdapterEntries('export const ADAPTER_MANIFEST = [];\n')).toThrow(/空数组/);
    expect(() =>
      extractAdapterEntries("export const ADAPTER_MANIFEST = [{ id: 'x' }];\n"),
    ).toThrow(/缺字段/);
  });
});

describe('脚手架 · 生成物', () => {
  it('七个文件齐全（package.json + 4 src + 2 tests）', async () => {
    const root = await makeTree();
    const plan = okPlan(root);
    expect(plan.conflicts).toEqual([]);
    applyPlan(plan);
    const dir = path.join(root, 'packages/plugins/tempdialect-adapter');
    const expected = [
      'package.json',
      'src/index.ts',
      'src/adapter.ts',
      'src/backend.ts',
      'src/plugin.ts',
      'tests/purity.test.ts',
      'tests/adapter-shape.test.ts',
    ];
    for (const rel of expected) {
      await expect(fs.stat(path.join(dir, rel))).resolves.toBeDefined();
    }
    // 包清单：清单自证要的名字/导出/依赖逐字对
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as {
      name: string;
      exports: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(pkg.name).toBe('@kojo/plugin-tempdialect-adapter');
    expect(pkg.exports['.']).toBe('./src/index.ts');
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@kojo/kojo-core', '@kojo/plugin-api']);
  });

  it('导出面含清单点名的三个名字（工厂 / 事实面 / 发射面）', async () => {
    const root = await makeTree();
    applyPlan(okPlan(root));
    const index = await fs.readFile(
      path.join(root, 'packages/plugins/tempdialect-adapter/src/index.ts'),
      'utf8',
    );
    for (const name of [
      'createTempdialectAdapterPlugin',
      'TEMPDIALECT_GAME_ADAPTER',
      'createTempdialectEmitBackend',
    ]) {
      expect(index, name).toContain(name);
    }
  });

  it('生成物不含宿主 / 内核 / 别的插件依赖，也不写具体游戏名', async () => {
    const root = await makeTree();
    applyPlan(okPlan(root));
    const dir = path.join(root, 'packages/plugins/tempdialect-adapter/src');
    for (const name of await fs.readdir(dir)) {
      const text = await fs.readFile(path.join(dir, name), 'utf8');
      expect(text, name).not.toMatch(/from\s+'node:/);
      expect(text, name).not.toMatch(/['"]@kojo\/kernel['"]/);
      expect(text, name).not.toMatch(/['"]@kojo\/plugin-(?!api['"])/);
      expect(text, name).not.toMatch(/['"]monaco-editor['"]|['"]react['"]/);
    }
  });
});

describe('脚手架 · 共享文件只加行', () => {
  it('清单：多且只多一个 `// new-dialect` 块，既有条目逐字不动', async () => {
    const root = await makeTree();
    const before = await fs.readFile(path.join(root, MANIFEST_REL), 'utf8');
    applyPlan(okPlan(root));
    const after = await fs.readFile(path.join(root, MANIFEST_REL), 'utf8');
    const markerCount = (text: string): number => (text.match(/\/\/ new-dialect/g) ?? []).length;
    expect(markerCount(after)).toBe(markerCount(before) + 1);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.startsWith(before.split('\n];')[0]!)).toBe(true);
    // 结构化核对：条目数 +1，最后一条就是新方言
    const entries = extractAdapterEntries(after);
    expect(entries.length).toBe(extractAdapterEntries(before).length + 1);
    expect(entries.at(-1)).toMatchObject({
      id: 'tempdialect',
      dir: 'tempdialect-adapter',
      packageName: '@kojo/plugin-tempdialect-adapter',
      factory: 'createTempdialectAdapterPlugin',
      scope: 'project',
      auditWord: 'tempdialect',
      kojo2AdapterExport: 'TEMPDIALECT_GAME_ADAPTER',
      kojo2BackendFactoryExport: 'createTempdialectEmitBackend',
    });
  });

  it('app 依赖与三份别名各加一行（root tsconfig 与 vitest 同集，清单自证才过）', async () => {
    const root = await makeTree();
    applyPlan(okPlan(root));
    const appPkg = JSON.parse(
      await fs.readFile(path.join(root, 'packages/app/package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(appPkg.dependencies['@kojo/plugin-tempdialect-adapter']).toBe('workspace:*');

    const aliases = (source: string): string[] =>
      [...source.matchAll(/@kojo\/plugin-([a-z0-9-]+-adapter)/g)].map((m) => m[1]!);
    const rootTs = aliases(await fs.readFile(path.join(root, 'tsconfig.json'), 'utf8'));
    const vitest = aliases(await fs.readFile(path.join(root, 'vitest.config.ts'), 'utf8'));
    const appTs = aliases(await fs.readFile(path.join(root, 'packages/app/tsconfig.json'), 'utf8'));
    expect(rootTs).toContain('tempdialect-adapter');
    expect([...vitest].sort()).toEqual([...rootTs].sort());
    expect(appTs).toContain('tempdialect-adapter');
  });
});

describe('脚手架 · 拒绝与 dry-run', () => {
  it('重复执行：计划报冲突、applyPlan 抛错、磁盘逐字节不变', async () => {
    const root = await makeTree();
    applyPlan(okPlan(root));
    const snapshotBefore = await snapshot(root);
    const again = okPlan(root);
    expect(again.conflicts.length).toBeGreaterThan(0);
    expect(formatPlan(again)).toContain('拒绝生成');
    expect(() => applyPlan(again)).toThrow(/拒绝落盘/);
    expect(await snapshot(root)).toEqual(snapshotBefore);
  });

  it('清单里已有同 id（别的目录）也拒绝', async () => {
    const root = await makeTree();
    const manifestPath = path.join(root, MANIFEST_REL);
    const manifest = await fs.readFile(manifestPath, 'utf8');
    await fs.writeFile(manifestPath, manifest.replace("id: 'erakoumakan',", "id: 'tempdialect',"), 'utf8');
    const plan = okPlan(root);
    expect(plan.conflicts.some((item: string) => item.includes('清单已有同 id'))).toBe(true);
  });

  it('非法参数：id / 扩展名形态不对直接抛（不生成半截计划）', async () => {
    const root = await makeTree();
    expect(() => okPlan(root, { id: 'Bad-Id' })).toThrow(/--id/);
    expect(() => okPlan(root, { ext: '.kojo2' })).toThrow(/--ext/);
    expect(() => okPlan(root, { title: '   ' })).toThrow(/--title/);
  });

  it('--dry-run 走真 CLI：打印计划、零落盘', async () => {
    const root = await makeTree();
    const before = await snapshot(root);
    const { stdout } = await run(process.execPath, [
      SCRIPT,
      '--root',
      root,
      '--id',
      'tempdialect',
      '--title',
      'Temp Dialect',
      '--ext',
      'kojo2',
      '--dry-run',
    ]);
    expect(stdout).toContain('[dry-run]');
    expect(stdout).toContain('packages/plugins/tempdialect-adapter/src/index.ts');
    expect(await snapshot(root)).toEqual(before);
  });
});
