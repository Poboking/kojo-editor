/**
 * 插件项目 · 提取（§10.5.6）与「压缩包反解成项目」
 *
 * 断言点：字节级复制、`source='extracted'` 与 `extractedFrom` 持久化、清单按根重组、
 * 路径闸（逃逸 / 符号链接 / 限额）一律拒绝且不留半成品项目。
 */

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContentPackManifest, InstalledPlugin } from '@kojo/plugin-api';
import { FakeProjectHost, makeProjectHarness } from './helpers/project-harness';
import type { ProjectHarness } from './helpers/project-harness';
import type { HostProjectExtractResult } from '../src/plugin-project';

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

function pack(overrides: Partial<ContentPackManifest> = {}): ContentPackManifest {
  return {
    schemaVersion: 1,
    id: 'demo.installed',
    name: '已装插件',
    version: '1.2.3',
    kind: 'plugin',
    gameId: 'demo',
    files: [],
    loadOrder: 5,
    capabilities: ['override-functions'],
    saveImpact: 'possible',
    entrypoints: [{ rootId: 'script', path: 'sub/main.txt' }],
    ...overrides,
  };
}

function installed(files: InstalledPlugin['ownedFiles'], overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    manifest: pack(),
    enabled: true,
    order: 5,
    installedAt: '2026-10-20T00:00:00.000Z',
    ownedFiles: files,
    risk: 'overrides-logic',
    requiresRestart: true,
    status: 'ok',
    sourceProjectId: null,
    trust: { state: 'unknown', publisher: null, signedAt: null },
    ...overrides,
  };
}

describe('pluginProjects.extract · 已安装插件 → 源码项目', () => {
  it('按根重组目录、字节级复制、清单与来源标记写入', async () => {
    const h = await harness();
    await h.addFile(nodePath.join(h.instance.gameRoot, 'ERB', 'sub', 'main.txt'), '原始脚本\n');
    await h.addFile(nodePath.join(h.instance.gameRoot, 'ERB', 'sub', 'utf8.txt'), '多字节内容\n');
    h.plugins.installed = [
      installed([
        { rootId: 'script', path: 'sub/main.txt' },
        { rootId: 'script', path: 'sub/utf8.txt' },
      ]),
    ];

    const project = await h.service.extract('i1', 'demo.installed');
    expect(project.source).toBe('extracted');
    expect(project.meta.extractedFrom).toEqual({
      instanceId: 'i1',
      pluginId: 'demo.installed',
      version: '1.2.3',
      at: '2026-10-26T12:00:00.000Z',
    });
    expect(project.name).toBe('已装插件（提取）');

    const copied = await h.read(
      nodePath.join(project.projectDir, 'plugin', 'content', 'script', 'sub', 'main.txt'),
    );
    expect(new TextDecoder().decode(copied)).toBe('原始脚本\n');

    const manifest = JSON.parse(
      await fs.readFile(nodePath.join(project.projectDir, 'plugin', 'plugin.json'), 'utf8'),
    ) as { roots: unknown[]; entrypoints: unknown[]; capabilities: string[]; version: string };
    expect(manifest.roots).toEqual([{ rootId: 'script', from: 'content/script' }]);
    expect(manifest.entrypoints).toEqual(['content/script/sub/main.txt']);
    expect(manifest.capabilities).toEqual(['override-functions']);
    expect(manifest.version).toBe('1.2.3');
  });

  it('归属路径逃逸（.. / 绝对 / 盘符 / UNC / 反斜杠）⇒ EXTRACT_FAILED 且不留项目', async () => {
    const h = await harness();
    for (const path of ['../evil.txt', '/etc/passwd', 'C:/windows/x', '\\\\server\\share\\x', 'a\\b.txt']) {
      h.plugins.installed = [installed([{ rootId: 'script', path }])];
      await expect(h.service.extract('i1', 'demo.installed')).rejects.toMatchObject({
        code: 'LAUNCHER_PLUGIN_EXTRACT_FAILED',
      });
    }
    expect(await h.service.list()).toHaveLength(0);
    expect(await fs.readdir(h.defaultRoot)).toEqual([]);
  });

  it('已装文件缺失 ⇒ EXTRACT_FAILED 并点名缺哪个文件', async () => {
    const h = await harness();
    h.plugins.installed = [installed([{ rootId: 'script', path: 'missing.txt' }])];
    await expect(h.service.extract('i1', 'demo.installed')).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_EXTRACT_FAILED',
      message: expect.stringContaining('missing.txt'),
    });
    expect(await h.service.list()).toHaveLength(0);
  });

  it('归属路径不是普通文件（目录 / 符号链接等价形态）⇒ 拒绝', async () => {
    const h = await harness();
    await fs.mkdir(nodePath.join(h.instance.gameRoot, 'ERB', 'linked'), { recursive: true });
    h.plugins.installed = [installed([{ rootId: 'script', path: 'linked' }])];
    await expect(h.service.extract('i1', 'demo.installed')).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_EXTRACT_FAILED',
      message: expect.stringContaining('不是普通文件'),
    });
  });

  it('插件不在该实例里 ⇒ 拒绝（没有可提取的内容）', async () => {
    const h = await harness();
    h.plugins.installed = [];
    await expect(h.service.extract('i1', 'demo.installed')).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_PROJECT_INVALID',
      message: expect.stringContaining('没有安装'),
    });
  });

  it('登记的内容根不在实例里 ⇒ 拒绝', async () => {
    const h = await harness();
    h.plugins.installed = [installed([{ rootId: 'ghost', path: 'a.txt' }])];
    await expect(h.service.extract('i1', 'demo.installed')).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_EXTRACT_FAILED',
      message: expect.stringContaining('ghost'),
    });
  });
});

/** 带 `launcher_project_extract` 的假宿主（把「包内条目」直接摆成暂存目录） */
class FakeExtractHost extends FakeProjectHost {
  result: HostProjectExtractResult | null = null;
  readonly requests: string[] = [];

  async projectExtract(archivePath: string): Promise<HostProjectExtractResult> {
    this.requests.push(archivePath);
    if (this.result === null) throw new Error('测试没有准备暂存结果');
    return this.result;
  }
}

async function staged(
  h: ProjectHarness,
  entries: ReadonlyArray<{ path: string; text: string }>,
): Promise<HostProjectExtractResult> {
  const stagingDir = nodePath.join(h.tempDir, 'staging');
  for (const entry of entries) {
    const abs = nodePath.join(stagingDir, entry.path);
    await fs.mkdir(nodePath.dirname(abs), { recursive: true });
    await fs.writeFile(abs, entry.text, 'utf8');
  }
  return {
    stagingDir,
    manifest: pack({ id: 'demo.packed', name: '包里的插件', version: '0.9.0' }),
    entries: entries.map((entry) => ({ path: entry.path, kind: 'file', size: Buffer.byteLength(entry.text) })),
  };
}

describe('pluginProjects.extractArchive · 压缩包 → 源码项目（宿主暂存）', () => {
  it('宿主没有 launcher_project_extract ⇒ 如实拒绝并点名命令', async () => {
    const h = await harness();
    await expect(h.service.extractArchive('C:/tmp/demo.zip')).rejects.toMatchObject({
      code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
      detail: expect.stringContaining('launcher_project_extract'),
    });
  });

  it('成功：暂存字节写进项目，清单按 {rootId}/{path} 重组', async () => {
    const host = new FakeExtractHost();
    const h = await harness({ host });
    host.result = await staged(h, [
      { path: 'script/a.txt', text: '甲\n' },
      { path: 'script/deep/b.txt', text: '乙\n' },
    ]);

    const project = await h.service.extractArchive('C:/tmp/demo.zip', { instanceId: 'i1' });
    expect(host.requests).toEqual(['C:/tmp/demo.zip']);
    expect(project.source).toBe('extracted');
    expect(project.meta.adapterId).toBe('demo-adapter');
    expect(project.meta.gameId).toBe('demo');
    expect(
      await fs.readFile(nodePath.join(project.projectDir, 'plugin', 'content', 'script', 'deep', 'b.txt'), 'utf8'),
    ).toBe('乙\n');
    const manifest = JSON.parse(
      await fs.readFile(nodePath.join(project.projectDir, 'plugin', 'plugin.json'), 'utf8'),
    ) as { roots: unknown[] };
    expect(manifest.roots).toEqual([{ rootId: 'script', from: 'content/script' }]);
  });

  it('包内条目路径逃逸 ⇒ EXTRACT_FAILED，不落任何字节', async () => {
    const host = new FakeExtractHost();
    const h = await harness({ host });
    const result = await staged(h, [{ path: 'script/ok.txt', text: 'ok' }]);
    host.result = {
      ...result,
      entries: [
        ...result.entries,
        { path: 'script/../../escape.txt', kind: 'file', size: 1 },
      ],
    };
    await expect(h.service.extractArchive('C:/tmp/demo.zip')).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_EXTRACT_FAILED',
      message: expect.stringContaining('路径非法'),
    });
    expect(await h.service.list()).toHaveLength(0);
  });

  it('包内条目是符号链接 ⇒ 拒绝（首版只搬普通文件）', async () => {
    const host = new FakeExtractHost();
    const h = await harness({ host });
    const result = await staged(h, [{ path: 'script/ok.txt', text: 'ok' }]);
    host.result = {
      ...result,
      entries: [{ path: 'script/link.txt', kind: 'symlink', size: 3 }],
    };
    await expect(h.service.extractArchive('C:/tmp/demo.zip')).rejects.toMatchObject({
      code: 'LAUNCHER_PLUGIN_EXTRACT_FAILED',
      message: expect.stringContaining('不是普通文件'),
    });
  });

  it('条目数超限 / 解压总字节超限 ⇒ LAUNCHER_ARCHIVE_LIMIT', async () => {
    const host = new FakeExtractHost();
    const h = await harness({ host });
    const result = await staged(h, [{ path: 'script/ok.txt', text: 'ok' }]);

    host.result = {
      ...result,
      entries: Array.from({ length: 5001 }, (_, i) => ({
        path: `script/f${i}.txt`,
        kind: 'file' as const,
        size: 1,
      })),
    };
    await expect(h.service.extractArchive('C:/tmp/demo.zip')).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_LIMIT',
    });

    host.result = {
      ...result,
      entries: [{ path: 'script/huge.bin', kind: 'file', size: 129 * 1024 * 1024 }],
    };
    await expect(h.service.extractArchive('C:/tmp/demo.zip')).rejects.toMatchObject({
      code: 'LAUNCHER_ARCHIVE_LIMIT',
    });
  });
});
