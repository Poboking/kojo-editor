/**
 * 插件项目 · 漂移报告与「构建并安装」前半段（§10.5.5 / §10.5.7）
 *
 * 漂移只读：三处版本（源 / 上次构建 / 已装）按优先级取**第一条命中**。
 * `planInstall` 一次调用完成 build + `plugins.planInstall`，中途没有可被改动的空窗。
 */

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContentPackManifest, InstalledPlugin } from '@kojo/plugin-api';
import { makeCreateInput, makeProjectHarness } from './helpers/project-harness';
import type { ProjectHarness } from './helpers/project-harness';

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

function installedFor(
  version: string,
  overrides: Partial<InstalledPlugin> = {},
): InstalledPlugin {
  const manifest: ContentPackManifest = {
    schemaVersion: 1,
    id: 'demo.example',
    name: '示例插件',
    version,
    kind: 'plugin',
    gameId: 'demo',
    files: [],
    loadOrder: 10,
    capabilities: ['add-content'],
  };
  return {
    manifest,
    enabled: true,
    order: 10,
    installedAt: '2026-10-20T00:00:00.000Z',
    ownedFiles: [],
    risk: 'content-only',
    requiresRestart: false,
    status: 'ok',
    sourceProjectId: null,
    trust: { state: 'unknown', publisher: null, signedAt: null },
    ...overrides,
  };
}

async function builtProject(h: ProjectHarness): Promise<string> {
  const project = await h.service.create(makeCreateInput());
  await h.addFile(nodePath.join(project.projectDir, 'plugin', 'src', 'a.txt'), 'a\n');
  await h.service.build(project.projectId);
  return project.projectId;
}

describe('pluginProjects.inspectDrift', () => {
  it('没装 ⇒ not-installed（installedVersion=null）', async () => {
    const h = await harness();
    const projectId = await builtProject(h);
    h.plugins.installed = [];
    const drift = await h.service.inspectDrift(projectId, 'i1');
    expect(drift).toMatchObject({
      state: 'not-installed',
      sourceVersion: '1.0.0',
      lastBuildVersion: '1.0.0',
      installedVersion: null,
    });
    expect(drift.reasons).toHaveLength(1);
  });

  it('源版本变了 ⇒ source-changed（先于 installed-differs）', async () => {
    const h = await harness();
    const projectId = await builtProject(h);
    h.plugins.installed = [installedFor('0.9.0')]; // 已装也不是这个构建
    const manifestPath = nodePath.join(h.ws.projectDir(projectId), 'plugin', 'plugin.json');
    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    raw.version = '2.0.0';
    await fs.writeFile(manifestPath, JSON.stringify(raw, null, 2), 'utf8');

    const drift = await h.service.inspectDrift(projectId, 'i1');
    expect(drift.state).toBe('source-changed');
    expect(drift.sourceVersion).toBe('2.0.0');
    expect(drift.lastBuildVersion).toBe('1.0.0');
    expect(drift.installedVersion).toBe('0.9.0');
    expect(drift.reasons.join(' ')).toContain('源版本 2.0.0 与上次构建 1.0.0 不同');
  });

  it('源文件改了（版本没变）⇒ source-changed（靠源指纹）', async () => {
    const h = await harness();
    const projectId = await builtProject(h);
    h.plugins.installed = [installedFor('1.0.0', { sourceProjectId: projectId })];
    await h.addFile(nodePath.join(h.ws.projectDir(projectId), 'plugin', 'src', 'b.txt'), 'b\n');

    const drift = await h.service.inspectDrift(projectId, 'i1');
    expect(drift.state).toBe('source-changed');
    expect(drift.reasons.join(' ')).toContain('源指纹不一致');
  });

  it('还没构建过 ⇒ source-changed 并说明原因', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());
    h.plugins.installed = [installedFor('1.0.0')];
    const drift = await h.service.inspectDrift(project.projectId, 'i1');
    expect(drift.state).toBe('source-changed');
    expect(drift.lastBuildVersion).toBeNull();
    expect(drift.reasons.join(' ')).toContain('还没有构建过');
  });

  it('已装版本 ≠ 上次构建 ⇒ installed-differs', async () => {
    const h = await harness();
    const projectId = await builtProject(h);
    h.plugins.installed = [installedFor('0.9.0')];
    const drift = await h.service.inspectDrift(projectId, 'i1');
    expect(drift).toMatchObject({
      state: 'installed-differs',
      sourceVersion: '1.0.0',
      lastBuildVersion: '1.0.0',
      installedVersion: '0.9.0',
    });
    expect(drift.reasons.join(' ')).toContain('与上次构建 1.0.0 不同');
  });

  it('实例里这个插件来自别的项目 ⇒ installed-differs', async () => {
    const h = await harness();
    const projectId = await builtProject(h);
    h.plugins.installed = [installedFor('1.0.0', { sourceProjectId: 'p-other' })];
    const drift = await h.service.inspectDrift(projectId, 'i1');
    expect(drift.state).toBe('installed-differs');
    expect(drift.reasons.join(' ')).toContain('p-other');
  });

  it('三处一致 ⇒ in-sync（reasons 为空）', async () => {
    const h = await harness();
    const projectId = await builtProject(h);
    h.plugins.installed = [installedFor('1.0.0', { sourceProjectId: projectId })];
    const drift = await h.service.inspectDrift(projectId, 'i1');
    expect(drift).toEqual({
      state: 'in-sync',
      sourceVersion: '1.0.0',
      lastBuildVersion: '1.0.0',
      installedVersion: '1.0.0',
      reasons: [],
    });
  });

  it('源清单缺失 ⇒ 拒绝判定漂移（不猜）', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());
    await fs.rm(nodePath.join(project.projectDir, 'plugin', 'plugin.json'));
    await expect(h.service.inspectDrift(project.projectId, 'i1')).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_PROJECT_INVALID',
      message: expect.stringContaining('无法判定漂移'),
    });
  });
});

describe('pluginProjects.planInstall', () => {
  it('先构建再把 zipPath 交给插件门禁；返回 build + plan', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());
    await h.addFile(nodePath.join(project.projectDir, 'plugin', 'src', 'a.txt'), 'a\n');

    const result = await h.service.planInstall(project.projectId, 'i1');
    expect(h.plugins.planRequests).toHaveLength(1);
    expect(h.plugins.planRequests[0]!.instanceId).toBe('i1');
    expect(h.plugins.planRequests[0]!.archivePath).toBe(result.build.zipPath);
    expect(result.plan.planId).toBe('plan-1');
    expect(result.build.sha256).toMatch(/^[0-9a-f]{64}$/);
    // 构建摘要也落进了项目元数据（指针）
    const view = await h.service.get(project.projectId);
    expect(view?.lastBuild?.buildId).toBe(result.build.buildId);
  });

  it('插件 gameId 与实例不一致 ⇒ 在构建之前就拒绝', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());
    const manifestPath = nodePath.join(project.projectDir, 'plugin', 'plugin.json');
    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    raw.gameId = 'another-game';
    await fs.writeFile(manifestPath, JSON.stringify(raw, null, 2), 'utf8');

    await expect(h.service.planInstall(project.projectId, 'i1')).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_INCOMPATIBLE',
    });
    expect(h.plugins.planRequests).toEqual([]);
  });
});
