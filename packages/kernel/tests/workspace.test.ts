import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKSPACE_MANIFEST_FILE, WriteNotAllowedError } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../src/io';
import { WorkspaceServiceImpl } from '../src/workspace';
import { NodeBridge } from './helpers/node-bridge';

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let tmpDir: string;
let appData: string;
let io: FileIOServiceImpl;
let ws: WorkspaceServiceImpl;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-ws-'));
  appData = path.join(tmpDir, 'appdata');
  io = new FileIOServiceImpl(new NodeBridge(appData));
  ws = new WorkspaceServiceImpl({ bridge: new NodeBridge(appData), io, log: noopLog });
  await ws.init();
});

describe('WorkspaceService · 初始化与写闸', () => {
  it('init 后根目录存在且登记为常驻可写根', async () => {
    expect(await io.exists(ws.rootDir())).toBe(true);
    expect(io.isWritable(path.join(ws.rootDir(), 'x', 'y.txt'))).toBe(true);
  });

  it('常驻可写根不受项目授权收回（setWritableRoots([])）影响', async () => {
    io.setWritableRoots([path.join(tmpDir, 'game')]);
    io.setWritableRoots([]);
    // 工作区根仍可写（不被项目开闭周期清空）
    await ws.create({ name: '存活' });
    // 域外仍拒绝
    await expect(io.writeText(path.join(tmpDir, 'other', 'x.txt'), 'no')).rejects.toThrow(
      WriteNotAllowedError,
    );
  });
});

describe('WorkspaceService · 项目 CRUD', () => {
  it('create 落 manifest；list 扫描读回（按 updatedAt 倒序）', async () => {
    const a = await ws.create({ name: '甲作品', meta: { author: '某作者' } });
    const b = await ws.create({ name: '乙作品' });
    const list = await ws.list();
    expect(list.map((p) => p.name)).toEqual(['乙作品', '甲作品']);
    const raw = JSON.parse(
      await fs.readFile(path.join(appData, 'workspaces', a.id, WORKSPACE_MANIFEST_FILE), 'utf8'),
    );
    expect(raw.meta.author).toBe('某作者');
    expect(raw.artifacts).toEqual([]);
    expect(b.id).not.toBe(a.id);
  });

  it('空项目名拒绝', async () => {
    await expect(ws.create({ name: '  ' })).rejects.toThrow(/empty/);
  });

  it('update 改名 + 刷新 updatedAt', async () => {
    const p = await ws.create({ name: '旧名' });
    const updated = await ws.update(p.id, { name: '新名' });
    expect(updated.name).toBe('新名');
    expect(updated.updatedAt).toBeGreaterThanOrEqual(p.updatedAt);
  });

  it('remove 连目录删除；再 get 返回 null', async () => {
    const p = await ws.create({ name: '将删' });
    await ws.createArtifact(p.id, { name: '包', dirName: 'pkg', files: { 'a.txt': 'x' } });
    await ws.remove(p.id);
    expect(await ws.get(p.id)).toBeNull();
    expect(await io.exists(ws.projectDir(p.id))).toBe(false);
  });

  it('损坏的 manifest 跳过不静默（list 不含该项，其余正常）', async () => {
    const good = await ws.create({ name: '好' });
    const badDir = path.join(appData, 'workspaces', 'p-broken');
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, WORKSPACE_MANIFEST_FILE), '{not json', 'utf8');
    const list = await ws.list();
    expect(list.map((p) => p.id)).toEqual([good.id]);
  });
});

describe('WorkspaceService · 制品与文件', () => {
  it('createArtifact 写文件集并登记 manifest；listDir/readText 可读回', async () => {
    const p = await ws.create({ name: '作品' });
    const art = await ws.createArtifact(p.id, {
      name: '初版包',
      dirName: '初版包-K1 v1.0',
      files: {
        'README.md': '# 初版包\n',
        '事件.ERB': 'PRINTL 你好\n',
        '子/深文件.txt': 'deep\n',
      },
      meta: { charaNo: 1 },
    });
    const proj = (await ws.get(p.id))!;
    expect(proj.artifacts).toHaveLength(1);
    expect(proj.artifacts[0]!.dirName).toBe('初版包-K1 v1.0');
    const names = (await ws.listDir(p.id, art.dirName)).map((e) => e.name);
    expect(names).toContain('README.md');
    expect(names).toContain('事件.ERB');
    const tf = await ws.readText(p.id, `${art.dirName}/事件.ERB`);
    expect(tf.text).toContain('PRINTL 你好');
    // 深层文件落盘
    expect(await io.exists(path.join(ws.projectDir(p.id), art.dirName, '子', '深文件.txt'))).toBe(true);
  });

  it('dirName 冲突 / 非法（含分隔符、点段、manifest 占用名）拒绝', async () => {
    const p = await ws.create({ name: '作品' });
    await ws.createArtifact(p.id, { name: 'a', dirName: 'pkg', files: {} });
    await expect(ws.createArtifact(p.id, { name: 'b', dirName: 'pkg', files: {} })).rejects.toThrow(
      /already exists/,
    );
    await expect(ws.createArtifact(p.id, { name: 'c', dirName: 'a/b', files: {} })).rejects.toThrow();
    await expect(ws.createArtifact(p.id, { name: 'd', dirName: '..', files: {} })).rejects.toThrow();
    await expect(
      ws.createArtifact(p.id, { name: 'e', dirName: WORKSPACE_MANIFEST_FILE, files: {} }),
    ).rejects.toThrow();
  });

  it('removeArtifact 删目录并摘除登记', async () => {
    const p = await ws.create({ name: '作品' });
    const art = await ws.createArtifact(p.id, { name: '包', dirName: 'pkg', files: { 'a.txt': '1' } });
    await ws.removeArtifact(p.id, art.id);
    const proj = (await ws.get(p.id))!;
    expect(proj.artifacts).toHaveLength(0);
    expect(await io.exists(path.join(ws.projectDir(p.id), 'pkg'))).toBe(false);
  });

  it('writeText/readText 越界（.. 逃逸、绝对路径）拒绝', async () => {
    const p = await ws.create({ name: '作品' });
    await expect(ws.writeText(p.id, '../evil.txt', 'x')).rejects.toThrow(/escapes/);
    await expect(ws.readText(p.id, 'sub/../../evil.txt')).rejects.toThrow(/escapes/);
    await expect(ws.writeText(p.id, 'C:/abs/evil.txt', 'x')).rejects.toThrow(/Absolute/);
  });

  it('制品文件路径越界：写前校验抛错且不登记半成品', async () => {
    const p = await ws.create({ name: '作品' });
    await expect(
      ws.createArtifact(p.id, { name: '坏包', dirName: 'pkg', files: { '../escape.txt': 'x' } }),
    ).rejects.toThrow(/escapes/);
    expect((await ws.get(p.id))!.artifacts).toHaveLength(0);
  });
});

describe('WorkspaceService · 导入外部目录（P-F）', () => {
  /** 造一个源目录：两层结构 + 非 UTF-8 字节（验证字节级保编码复制） */
  async function makeSourceDir(): Promise<string> {
    const src = path.join(tmpDir, 'source-package');
    await fs.mkdir(path.join(src, '子目录'), { recursive: true });
    await fs.writeFile(path.join(src, 'README.md'), '# 源包说明\n', 'utf8');
    await fs.writeFile(path.join(src, '事件.ERB'), 'PRINTL 你好\n', 'utf8');
    await fs.writeFile(path.join(src, '子目录', '深文件.ERB'), 'PRINTL 深层\n', 'utf8');
    // 任意字节（模拟 Shift_JIS 等非 UTF-8 内容；字节级复制必须原样）
    await fs.writeFile(path.join(src, '二进制.bin'), Buffer.from([0x82, 0xb1, 0x82, 0xf1]));
    return src;
  }

  it('递归导入：逐文件字节复制 + 登记 manifest（含来源元数据）', async () => {
    const src = await makeSourceDir();
    const p = await ws.create({ name: '作品' });
    const art = await ws.importDirectory(p.id, {
      name: '导入包',
      dirName: '导入包-K1 v1.0',
      sourceDir: src,
      meta: { importedFrom: src },
    });

    const proj = (await ws.get(p.id))!;
    expect(proj.artifacts).toHaveLength(1);
    expect(proj.artifacts[0]!.meta.importedFrom).toBe(src);

    // 文件逐一落盘（含子目录）
    const pkgDir = path.join(ws.projectDir(p.id), art.dirName);
    expect(await fs.readFile(path.join(pkgDir, 'README.md'), 'utf8')).toBe('# 源包说明\n');
    expect(await fs.readFile(path.join(pkgDir, '事件.ERB'), 'utf8')).toBe('PRINTL 你好\n');
    expect(await fs.readFile(path.join(pkgDir, '子目录', '深文件.ERB'), 'utf8')).toBe('PRINTL 深层\n');
    // 字节级保真（非 UTF-8 内容不转码）
    const bin = await fs.readFile(path.join(pkgDir, '二进制.bin'));
    expect([...bin]).toEqual([0x82, 0xb1, 0x82, 0xf1]);

    // 源目录不被改动（只读语义）
    expect(await fs.readFile(path.join(src, 'README.md'), 'utf8')).toBe('# 源包说明\n');
    expect(art.name).toBe('导入包');
  });

  it('目标 dirName 冲突拒绝（不覆盖既有包）', async () => {
    const src = await makeSourceDir();
    const p = await ws.create({ name: '作品' });
    await ws.createArtifact(p.id, { name: '既有', dirName: '已有包', files: {} });
    await expect(
      ws.importDirectory(p.id, { name: '导入', dirName: '已有包', sourceDir: src }),
    ).rejects.toThrow(/already exists/);
  });

  it('源目录不存在拒绝', async () => {
    const p = await ws.create({ name: '作品' });
    await expect(
      ws.importDirectory(p.id, { name: '导入', dirName: 'pkg', sourceDir: path.join(tmpDir, '不存在') }),
    ).rejects.toThrow(/does not exist/);
  });

  it('dirName 非法（含分隔符 / 点段）拒绝', async () => {
    const src = await makeSourceDir();
    const p = await ws.create({ name: '作品' });
    await expect(
      ws.importDirectory(p.id, { name: '导入', dirName: 'a/b', sourceDir: src }),
    ).rejects.toThrow();
    await expect(
      ws.importDirectory(p.id, { name: '导入', dirName: '..', sourceDir: src }),
    ).rejects.toThrow();
  });
});
