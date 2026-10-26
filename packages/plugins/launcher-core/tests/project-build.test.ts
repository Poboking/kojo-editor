/**
 * 插件项目 · 构建确定性（§10.5.4 / ADR-0010 决策 3）
 *
 * 断言点全部落在盘上的字节与宿主读数上：
 * - 同内容两次构建**逐字节相同**（含文件顺序被打乱的输入）；
 * - `buildId` / `sha256` 与时间无关，`builtAt` 与时间有关；
 * - 失败清理半截产物；缺 `launcher_project_hash` 时如实拒绝。
 */

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readZipContainer, inflateZipEntry } from '@kojo/plugin-api';
import { FakeHost } from './helpers/fake-host';
import { FakeProjectHost, makeCreateInput, makeProjectHarness } from './helpers/project-harness';
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

/** 在项目源目录里放一批文件（顺序可打乱：`order` 决定创建次序） */
async function seedSource(
  h: ProjectHarness,
  projectDir: string,
  files: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  for (const [rel, text] of files) {
    await h.addFile(nodePath.join(projectDir, 'plugin', rel), text);
  }
}

describe('pluginProjects.build · 确定性', () => {
  it('同内容两次构建逐字节相同，buildId / sha256 一致', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput({ template: 'add-content' }));
    await seedSource(h, project.projectDir, [
      ['src/a.txt', '甲\n'],
      ['src/b.txt', '乙\n'],
    ]);

    const first = await h.service.build(project.projectId);
    const firstBytes = await h.read(first.zipPath);
    const second = await h.service.build(project.projectId);
    const secondBytes = await h.read(second.zipPath);

    expect(Buffer.compare(Buffer.from(firstBytes), Buffer.from(secondBytes))).toBe(0);
    expect(second.buildId).toBe(first.buildId);
    expect(second.sha256).toBe(first.sha256);
    expect(second.bytes).toBe(firstBytes.length);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    // 固定时钟下 builtAt 相同；它是唯一进报告、不进包的时间量
    expect(first.builtAt).toBe('2026-10-26T12:00:00.000Z');
    expect(first.zipPath.startsWith(nodePath.join(project.projectDir, 'build'))).toBe(true);
  });

  it('输入文件顺序被打乱后仍产出同一份字节（排序在消费侧）', async () => {
    const a = await harness();
    const projectA = await a.service.create(makeCreateInput({ pluginId: 'demo.ordered' }));
    await seedSource(a, projectA.projectDir, [
      ['src/1.txt', '1\n'],
      ['src/2.txt', '2\n'],
      ['src/3.txt', '3\n'],
    ]);

    const b = await harness();
    const projectB = await b.service.create(makeCreateInput({ pluginId: 'demo.ordered' }));
    // 写入顺序整体倒过来（walkDir 的枚举顺序会跟着变）
    await seedSource(b, projectB.projectDir, [
      ['src/3.txt', '3\n'],
      ['src/2.txt', '2\n'],
      ['src/1.txt', '1\n'],
    ]);

    const builtA = await a.service.build(projectA.projectId);
    const builtB = await b.service.build(projectB.projectId);

    const bytesA = await a.read(builtA.zipPath);
    const bytesB = await b.read(builtB.zipPath);
    expect(Buffer.compare(Buffer.from(bytesA), Buffer.from(bytesB))).toBe(0);
    expect(builtA.buildId).toBe(builtB.buildId);
    // 条目顺序 = POSIX 路径排序（pack.json 在前，其余按 `{rootId}/{path}`）
    const container = readZipContainer(bytesA);
    expect(container.entries.map((e) => e.name)).toEqual([
      'pack.json',
      'script/1.txt',
      'script/2.txt',
      'script/3.txt',
      'script/README.md',
    ]);
  });

  it('包内 pack.json 是算出来的：files[] 带 sha256 / size，kind=plugin，entrypoints 换算成 ContentFileRef', async () => {
    const h = await harness();
    const project = await h.service.create(
      makeCreateInput({ template: 'add-commands', capabilities: ['add-commands'] }),
    );
    await seedSource(h, project.projectDir, [['src/extra.txt', '扩展\n']]);

    const built = await h.service.build(project.projectId);
    const manifest = built.manifest;
    expect(manifest.kind).toBe('plugin');
    expect(manifest.id).toBe('demo.example');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.gameId).toBe('demo');
    expect(manifest.files.map((f) => f.path)).toEqual(['README.md', 'extra.txt', 'main.txt']);
    for (const file of manifest.files) {
      expect(file.rootId).toBe('script');
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.size).toBeGreaterThan(0);
    }
    expect(manifest.entrypoints).toEqual([{ rootId: 'script', path: 'main.txt' }]);

    // ZIP 里的 pack.json 与返回值是同一份（逐字节）
    const bytes = await h.read(built.zipPath);
    const container = readZipContainer(bytes);
    const packEntry = container.entries.find((e) => e.name === 'pack.json')!;
    const packText = new TextDecoder().decode(await inflateZipEntry(packEntry));
    expect(JSON.parse(packText)).toEqual(JSON.parse(JSON.stringify(manifest)));
  });

  it('构建报告写在 build/{buildId}.json，摘要与返回值一致；源指纹同内容稳定', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());
    await seedSource(h, project.projectDir, [['src/x.txt', 'x\n']]);

    const built = await h.service.build(project.projectId);
    const report = JSON.parse(await fs.readFile(built.reportPath, 'utf8')) as {
      buildId: string;
      zip: { file: string; bytes: number; sha256: string };
      manifest: { files: unknown[] };
      sourceFiles: Array<{ path: string }>;
    };
    expect(nodePath.basename(built.reportPath)).toBe(`${built.buildId}.json`);
    expect(report.buildId).toBe(built.buildId);
    expect(report.zip.sha256).toBe(built.sha256);
    expect(report.zip.bytes).toBe(built.bytes);
    expect(report.sourceFiles.map((f) => f.path)).toEqual(['src/README.md', 'src/x.txt']);

    const again = await h.service.build(project.projectId);
    expect(again.sourceFingerprint).toBe(built.sourceFingerprint);

    // 写完文件后指纹必然变（mtime / size 变了）
    await seedSource(h, project.projectDir, [['src/y.txt', 'y\n']]);
    const changed = await h.service.build(project.projectId);
    expect(changed.sourceFingerprint).not.toBe(built.sourceFingerprint);
  });

  it('构建把 lastBuild 指针写回项目元数据（只存摘要，不存清单）', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());
    const built = await h.service.build(project.projectId);
    const reloaded = await h.service.get(project.projectId);
    expect(reloaded?.lastBuild).toEqual({
      buildId: built.buildId,
      version: built.manifest.version,
      bytes: built.bytes,
      sha256: built.sha256,
      sourceFingerprint: built.sourceFingerprint,
      builtAt: built.builtAt,
    });
  });

  it('opts.version 只覆盖本次产物，不回写源清单', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());
    const built = await h.service.build(project.projectId, { version: '2.0.0' });
    expect(built.manifest.version).toBe('2.0.0');
    expect(built.zipPath.endsWith('demo.example-2.0.0.zip')).toBe(true);
    const view = await h.service.get(project.projectId);
    expect(view?.artifacts[0]?.version).toBe('1.0.0');
  });
});

describe('pluginProjects.build · 失败与守卫', () => {
  it('缺 launcher_project_hash 时如实拒绝并点名命令', async () => {
    const h = await harness({ host: new FakeHost() });
    const project = await h.service.create(makeCreateInput());
    await expect(h.service.build(project.projectId)).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
    });
    await expect(h.service.build(project.projectId)).rejects.toMatchObject({
      detail: expect.stringContaining('launcher_project_hash'),
    });
    // 没有半截产物
    const buildDir = nodePath.join(project.projectDir, 'build');
    expect(await fs.readdir(buildDir)).toEqual([]);
  });

  it('入口指向不存在的文件 ⇒ 构建失败且不出包', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());
    const manifestPath = nodePath.join(project.projectDir, 'plugin', 'plugin.json');
    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    raw.entrypoints = ['src/missing.txt'];
    await fs.writeFile(manifestPath, JSON.stringify(raw, null, 2), 'utf8');

    await expect(h.service.build(project.projectId)).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_PROJECT_INVALID',
      message: expect.stringContaining('entrypoints'),
    });
    expect(await fs.readdir(nodePath.join(project.projectDir, 'build'))).toEqual([]);
  });

  it('两条映射命中同一目标路径 ⇒ 拒绝隐式覆盖', async () => {
    const h = await harness();
    const project = await h.service.create(
      makeCreateInput({
        roots: [
          { rootId: 'script', from: 'src' },
          { rootId: 'script', from: 'src', to: '' },
        ],
      }),
    );
    await seedSource(h, project.projectDir, [['src/a.txt', 'a\n']]);
    await expect(h.service.build(project.projectId)).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_BUILD_FAILED',
      message: expect.stringContaining('隐式覆盖'),
    });
  });

  it('根映射的源目录不存在 ⇒ 源清单非法，不出包', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());
    const manifestPath = nodePath.join(project.projectDir, 'plugin', 'plugin.json');
    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    raw.roots = [{ rootId: 'script', from: 'nope' }];
    await fs.writeFile(manifestPath, JSON.stringify(raw, null, 2), 'utf8');

    await expect(h.service.build(project.projectId)).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_PROJECT_INVALID',
      message: expect.stringContaining('源目录不存在'),
    });
    expect(await fs.readdir(nodePath.join(project.projectDir, 'build'))).toEqual([]);
  });

  it('源清单手写 files[] / sha256 ⇒ 构建拒绝（防伪造验收）', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());
    const manifestPath = nodePath.join(project.projectDir, 'plugin', 'plugin.json');
    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    raw.files = [{ path: 'a.txt', sha256: 'a'.repeat(64) }];
    await fs.writeFile(manifestPath, JSON.stringify(raw, null, 2), 'utf8');

    await expect(h.service.build(project.projectId)).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_PROJECT_INVALID',
      detail: expect.stringContaining('不许手写哈希'),
    });
  });

  it('摘要与盘上字节对不上 ⇒ 构建失败并清掉 ZIP / 暂存', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());
    await seedSource(h, project.projectDir, [['src/a.txt', 'a\n']]);
    (h.host as FakeProjectHost).corruptFrom = 1; // 第一次摘要之后全部改坏（两步之间被换过的等价形态）

    await expect(h.service.build(project.projectId)).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_BUILD_FAILED',
    });
    const buildDir = nodePath.join(project.projectDir, 'build');
    expect(await fs.readdir(buildDir)).toEqual([]);
    expect(await fs.stat(nodePath.join(buildDir, 'staging')).catch(() => null)).toBeNull();
  });

  it('写盘阶段失败 ⇒ 半截产物被清理（ZIP / 报告 / 暂存都不留）', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());
    await seedSource(h, project.projectDir, [['src/a.txt', 'a\n']]);
    const buildDir = nodePath.join(project.projectDir, 'build');
    h.io.failWrite = (abs) => abs.startsWith(nodePath.join(buildDir, 'demo.example-1.0.0.zip'));

    await expect(h.service.build(project.projectId)).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_BUILD_FAILED',
    });
    expect(await fs.readdir(buildDir)).toEqual([]);
  });

  it('未映射进任何根的文件以 warning 列出（「放了却没生效」不许静默）', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());
    await seedSource(h, project.projectDir, [['drafts/note.txt', '草稿\n']]);
    const built = await h.service.build(project.projectId);
    expect(built.warnings).toContain('未打包文件：drafts/note.txt（不在任何 roots 映射里）');
  });

  it('includeDocs=false 时 README / LICENSE 不进包', async () => {
    const h = await harness();
    const project = await h.service.create(makeCreateInput());
    await seedSource(h, project.projectDir, [['LICENSE', 'MIT\n'], ['src/a.txt', 'a\n']]);
    const built = await h.service.build(project.projectId, { includeDocs: false });
    expect(built.manifest.files.map((f) => f.path)).toEqual(['a.txt']);
  });
});
