/**
 * 插件项目 · 创建 / 列举 / 改名 / 删除（§10.5.2 / ADR-0010 决策 5/6/7）
 *
 * 断言点：项目就是工作区项目（不造第二套存储）、源清单自证闭环、模板不覆盖清单、
 * 失败按**本次写入清单**回滚（不调 `workspaces.remove`）、项目 id / 目录的前缀复验。
 */

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GamePluginRules, PluginSourceManifest } from '@kojo/plugin-api';
import { makeCreateInput, makeProjectHarness } from './helpers/project-harness';
import type { ProjectHarness } from './helpers/project-harness';
import { sourceManifestProblems } from '../src/plugin-project';

const harnesses: ProjectHarness[] = [];

async function harness(
  options: Parameters<typeof makeProjectHarness>[0] = {},
): Promise<ProjectHarness> {
  const made = await makeProjectHarness(options);
  harnesses.push(made);
  return made;
}

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.cleanup();
});

async function readManifest(projectDir: string): Promise<PluginSourceManifest> {
  return JSON.parse(
    await fs.readFile(nodePath.join(projectDir, 'plugin', 'plugin.json'), 'utf8'),
  ) as PluginSourceManifest;
}

describe('pluginProjects.create · 结构', () => {
  it('项目 = 工作区项目：meta.kind / adapter / gameId / lastBuild=null / source=created', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());

    expect(project.projectId).toMatch(/^p\d+$/);
    expect(project.name).toBe('示例插件');
    expect(project.source).toBe('created');
    expect(project.meta).toMatchObject({
      kind: 'game-plugin',
      adapterId: 'demo-adapter',
      gameId: 'demo',
      gameVersion: null,
      targetInstanceId: 'i1',
      lastBuild: null,
      installedTarget: null,
    });
    expect(project.projectDir.startsWith(h.defaultRoot)).toBe(true);
    // 工作区清单里确实登记了同一份 meta（不是本层的内存副本）
    const raw = JSON.parse(
      await fs.readFile(nodePath.join(project.projectDir, 'workspace.json'), 'utf8'),
    ) as { meta: Record<string, unknown> };
    expect(raw.meta.kind).toBe('game-plugin');
    expect(raw.meta.adapterId).toBe('demo-adapter');
  });

  it('制品 / 源清单 / .gitignore / build 目录一次到位', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput({ template: 'add-content' }));

    expect(project.artifacts).toHaveLength(1);
    expect(project.artifacts[0]).toMatchObject({
      dirName: 'plugin',
      pluginId: 'demo.example',
      version: '1.0.0',
      capabilities: ['add-content'],
      manifestPath: 'plugin/plugin.json',
    });
    const entries = (await fs.readdir(project.projectDir)).sort();
    expect(entries).toEqual(['.gitignore', 'build', 'plugin', 'workspace.json']);
    expect(await fs.readFile(nodePath.join(project.projectDir, '.gitignore'), 'utf8')).toBe('build/\n');
    expect((await fs.stat(nodePath.join(project.projectDir, 'build'))).isDirectory()).toBe(true);
    expect((await fs.stat(nodePath.join(project.projectDir, 'plugin', 'src', 'main.txt'))).isFile()).toBe(true);
  });

  it('模板 scaffold 产出的清单能被自身校验器接受（自证闭环）+ 文件不覆盖清单', async () => {
    const h = await harness();
    const project = await h.service.create(
      makeCreateInput({
        template: 'add-commands',
        capabilities: ['add-commands', 'override-functions'],
        author: '某作者',
        license: 'MIT',
        description: '示例说明',
        saveImpact: 'possible',
        loadOrder: 7,
      }),
    );
    const manifest = await readManifest(project.projectDir);
    expect(sourceManifestProblems(manifest, { gameId: 'demo', rootIds: ['script', 'data'] })).toEqual([]);
    expect(manifest.entrypoints).toEqual(['src/main.txt']);
    expect(manifest.capabilities).toEqual(['add-commands', 'override-functions']);
    expect(manifest.author).toBe('某作者');
    expect(manifest.license).toBe('MIT');
    expect(manifest.description).toBe('示例说明');
    expect(manifest.saveImpact).toBe('possible');
    expect(manifest.loadOrder).toBe(7);
    expect(manifest.roots).toEqual([{ rootId: 'script', from: 'src' }]);
    // 源码根下的 README 与入口都落盘
    expect(await fs.readFile(nodePath.join(project.projectDir, 'plugin', 'src', 'main.txt'), 'utf8')).toContain(
      'demo.example',
    );
  });

  it('adapter 的 scaffold 顶替内置模板；二进制走 io.writeBytes 逐字节落盘', async () => {
    const rules: GamePluginRules = {
      roots: [
        {
          id: 'script',
          label: '脚本',
          relativePath: 'ERB',
          kind: 'script',
          accepts: ['plugin'],
          writableInShared: true,
        },
      ],
      manifestNames: ['pack.json'],
      orderSource: 'manifest',
      requiresRestart: true,
      saveImpact: 'possible',
      scaffold: async (options) => ({
        files: { 'src/custom.txt': `adapter:${options.template}:${options.pluginId}\n` },
        binaryFiles: { 'assets/raw.bin': new Uint8Array([1, 2, 3, 250]) },
        report: ['adapter 生成'],
      }),
    };
    const h = await harness({ pluginRules: rules });
    const project = await h.service.create(
      makeCreateInput({ template: 'override-functions', capabilities: ['override-functions'] }),
    );
    expect(
      await fs.readFile(nodePath.join(project.projectDir, 'plugin', 'src', 'custom.txt'), 'utf8'),
    ).toBe('adapter:override-functions:demo.example\n');
    const bytes = await h.read(nodePath.join(project.projectDir, 'plugin', 'assets', 'raw.bin'));
    expect([...bytes]).toEqual([1, 2, 3, 250]);
    expect((await readManifest(project.projectDir)).entrypoints).toEqual(['src/custom.txt']);
  });

  it('adapter 的 scaffold 想生成 plugin.json ⇒ 拒绝（清单只有一个真源）', async () => {
    const rules: GamePluginRules = {
      roots: [
        {
          id: 'script',
          label: '脚本',
          relativePath: 'ERB',
          kind: 'script',
          accepts: ['plugin'],
          writableInShared: true,
        },
      ],
      manifestNames: ['pack.json'],
      orderSource: 'manifest',
      requiresRestart: true,
      saveImpact: 'possible',
      scaffold: async () => ({ files: { 'plugin.json': '{}' }, report: [] }),
    };
    const h = await harness({ pluginRules: rules });
    await expect(h.service.create(makeCreateInput())).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_PROJECT_INVALID',
      message: expect.stringContaining('不得生成 plugin.json'),
    });
  });
});

describe('pluginProjects.create · 守卫与回滚', () => {
  it('同一工作区重复 pluginId ⇒ LAUNCHER_PLUGIN_PROJECT_EXISTS', async () => {
    const h = await harness();
    await h.service.create(makeCreateInput());
    await expect(h.service.create(makeCreateInput({ name: '另一个' }))).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_PROJECT_EXISTS',
      message: expect.stringContaining('demo.example'),
    });
    expect(await h.service.list()).toHaveLength(1);
  });

  it('实例不存在 ⇒ LAUNCHER_INSTANCE_NOT_FOUND', async () => {
    const h = await harness();
    await expect(h.service.create(makeCreateInput({ instanceId: 'nope' }))).rejects.toMatchObject({
      code: 'LAUNCHER_INSTANCE_NOT_FOUND',
    });
  });

  it('workspaceRoot 未命中工作区授权根 ⇒ 拒绝（落点不是自由参数）', async () => {
    const h = await harness();
    await expect(
      h.service.create(makeCreateInput({ workspaceRoot: nodePath.join(h.tempDir, 'elsewhere') })),
    ).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_PROJECT_INVALID',
      message: expect.stringContaining('未获得授权'),
    });
  });

  it('rootId 不在 adapter 声明的根里 ⇒ 拒绝', async () => {
    const h = await harness();
    await expect(
      h.service.create(makeCreateInput({ roots: [{ rootId: 'nowhere', from: 'src' }] })),
    ).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_PROJECT_INVALID',
      message: expect.stringContaining('不在该游戏声明的根里'),
    });
  });

  it('pluginId / version / roots 非法 ⇒ 创建前就拒绝', async () => {
    const h = await harness();
    await expect(h.service.create(makeCreateInput({ pluginId: 'Bad Id' }))).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_PROJECT_INVALID',
    });
    await expect(h.service.create(makeCreateInput({ version: '1.0 beta' }))).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_PROJECT_INVALID',
    });
    await expect(h.service.create(makeCreateInput({ roots: [] }))).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_PROJECT_INVALID',
    });
    expect(await h.service.list()).toHaveLength(0);
  });

  it('模板路径逃逸（.. / 绝对路径）⇒ 拒绝且不留半成品项目', async () => {
    const rules: GamePluginRules = {
      roots: [
        {
          id: 'script',
          label: '脚本',
          relativePath: 'ERB',
          kind: 'script',
          accepts: ['plugin'],
          writableInShared: true,
        },
      ],
      manifestNames: ['pack.json'],
      orderSource: 'manifest',
      requiresRestart: true,
      saveImpact: 'possible',
      scaffold: async () => ({ files: { '../evil.txt': 'x' }, report: [] }),
    };
    const h = await harness({ pluginRules: rules });
    await expect(h.service.create(makeCreateInput())).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_PROJECT_INVALID',
    });
    expect(await h.service.list()).toHaveLength(0);
    expect(await fs.readdir(h.defaultRoot)).toEqual([]);
  });

  it('中途写盘失败 ⇒ 按本批路径清单回滚，项目目录与制品登记都不残留', async () => {
    const h = await harness();
    h.io.failWrite = (abs) => abs.includes(`${nodePath.sep}plugin${nodePath.sep}src${nodePath.sep}`);
    await expect(h.service.create(makeCreateInput({ template: 'add-content' }))).rejects.toThrow(
      /模拟写入失败/,
    );
    expect(await h.service.list()).toHaveLength(0);
    expect(await fs.readdir(h.defaultRoot)).toEqual([]);
  });

  it('自选授权根里的项目：创建落在该根，projectDir 解析到该根', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput({ workspaceRoot: h.extraRoot }));
    expect(project.projectDir.startsWith(h.extraRoot)).toBe(true);
    expect(await h.service.projectDir(project.projectId)).toBe(project.projectDir);
  });
});

describe('pluginProjects · 列举 / 改名 / 删除 / 目录', () => {
  it('list 只返回 meta.kind=game-plugin 的项目（口上项目不混进来）', async () => {
    const h = await harness();
    await h.ws.create({ name: '口上项目', meta: { author: '某人' } });
    const plugin = await h.service.create(makeCreateInput());
    const list = await h.service.list();
    expect(list.map((p) => p.projectId)).toEqual([plugin.projectId]);
    expect(list[0]!.artifacts[0]!.pluginId).toBe('demo.example');
  });

  it('get 未知 id 返回 null（不抛错）', async () => {
    const h = await harness();
    expect(await h.service.get('p404')).toBeNull();
  });

  it('update 只改元数据名，不动清单', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());
    const renamed = await h.service.update(project.projectId, { name: '改过的名字' });
    expect(renamed.name).toBe('改过的名字');
    const manifest = await readManifest(project.projectDir);
    expect(manifest.name).toBe('示例插件');
  });

  it('remove 连同项目目录删除；之后 list 为空、get 为 null', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());
    await h.service.remove(project.projectId);
    expect(await h.service.list()).toHaveLength(0);
    expect(await h.service.get(project.projectId)).toBeNull();
    expect(await fs.stat(project.projectDir).catch(() => null)).toBeNull();
  });

  it('项目 id 的前缀复验：.. / 绝对路径 / UNC / 反斜杠一律拒绝', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());
    for (const bad of ['../evil', '..\\evil', 'C:/Windows', 'C:\\Windows', '\\\\server\\share', 'a/b']) {
      await expect(h.service.projectDir(bad)).rejects.toMatchObject({
        code: 'LAUNCHER_PLUGIN_PROJECT_INVALID',
      });
      await expect(h.service.remove(bad)).rejects.toMatchObject({
        code: 'LAUNCHER_PLUGIN_PROJECT_INVALID',
      });
    }
    // 合法 id 不受影响
    expect(await h.service.projectDir(project.projectId)).toBe(project.projectDir);
  });

  it('工作区 / IO 能力面缺席 ⇒ 如实拒绝并点名服务键', async () => {
    const noWorkspaces = await harness({ withWorkspaces: false });
    await expect(noWorkspaces.service.list()).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
      detail: expect.stringContaining('kernel.workspaces'),
    });
    const noIo = await harness({ withIo: false });
    // 创建本身就要写源文件 ⇒ 没有内核 IO 时在第一步就拒绝，不造空壳项目
    await expect(noIo.service.create(makeCreateInput())).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
      detail: expect.stringContaining('kernel.io'),
    });
  });
});
