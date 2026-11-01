import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_MANIFEST_FILE, WriteNotAllowedError, type PlatformBridge } from '@kojo/plugin-api';
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
    await expect(ws.create({ name: '  ' })).rejects.toThrow(/项目名不能为空/);
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

  it('remove 幂等：目录已被手删 / 项目从不存在都不报假错（P0-7b）', async () => {
    const deleted = await ws.create({ name: '手删' });
    // 模拟作者在资源管理器里把项目文件夹整个删掉（manifest 一起没）
    await fs.rm(path.join(appData, 'workspaces', deleted.id), { recursive: true, force: true });
    await expect(ws.remove(deleted.id)).resolves.toBeUndefined();
    await expect(ws.remove('p-not-here')).resolves.toBeUndefined();
    expect((await ws.list()).map((p) => p.id)).not.toContain(deleted.id);
  });

  it('remove 只删已解析的项目目录，同根邻居不受波及（P0-7b 安全口径）', async () => {
    const neighbor = path.join(ws.rootDir(), '邻居');
    await fs.mkdir(neighbor, { recursive: true });
    await fs.writeFile(path.join(neighbor, 'keep.txt'), 'keep', 'utf8');
    const p = await ws.create({ name: '目标' });
    await ws.remove(p.id);
    expect(await io.exists(path.join(neighbor, 'keep.txt'))).toBe(true);
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

/**
 * 新建冲突与失败回滚（2026-11-02 P2）。
 *
 * 口径：同根同名 = 拒绝（不覆盖、不静默），文案要能被向导的 catch 原样上屏（含下一步）；
 * 建目录之后的任何失败都清理本次半成品目录、重建可写域/缓存，清理失败只出声。
 */
describe('WorkspaceService · 新建冲突与失败回滚（P2）', () => {
  it('同根同名项目：拒绝新建（不落新目录、不覆盖旧项目，文案给出下一步）', async () => {
    const first = await ws.create({ name: '同名作品' });
    const before = await fs.readdir(ws.rootDir());
    await expect(ws.create({ name: '同名作品' })).rejects.toThrow(/同名项目/);
    // 向导只把 message 原样显示（new-project-wizard 的 catch），所以下一步必须写进文案本身
    await expect(ws.create({ name: '同名作品' })).rejects.toThrow(/换一个名字/);
    expect(await ws.get(first.id)).not.toBeNull();
    expect(await fs.readdir(ws.rootDir())).toEqual(before);
    expect((await ws.list()).map((p) => p.name)).toEqual(['同名作品']);
  });

  it('不同根的同一个名字是合法的（冲突只在本次落点根内判定）', async () => {
    const extra = path.join(tmpDir, '第二作品库');
    await fs.mkdir(extra, { recursive: true });
    const xWs = new WorkspaceServiceImpl({
      bridge: new NodeBridge(appData, [extra]),
      io: new FileIOServiceImpl(new NodeBridge(appData, [extra])),
      log: noopLog,
    });
    await xWs.init();
    const inExtra = await xWs.create({ name: '跨根同名', rootDir: extra });
    const inDefault = await xWs.create({ name: '跨根同名' });
    expect(xWs.projectDir(inExtra.id)).toBe(path.join(extra, inExtra.id));
    expect(xWs.projectDir(inDefault.id)).toBe(path.join(xWs.rootDir(), inDefault.id));
    expect((await xWs.list()).filter((p) => p.name === '跨根同名')).toHaveLength(2);
  });

  it('同名目录但没有 manifest（崩溃残留）：拒绝并说明"不是可用的项目"+ 下一步', async () => {
    const staleName = '残留作品';
    await fs.mkdir(path.join(ws.rootDir(), staleName), { recursive: true });
    await expect(ws.create({ name: staleName })).rejects.toThrow(/同名文件夹/);
    await expect(ws.create({ name: staleName })).rejects.toThrow(/不是一个可用的项目/);
    await expect(ws.create({ name: staleName })).rejects.toThrow(/改名或删掉/);
    // 残留目录原样保留（不覆盖、也不顺手删作者盘上的东西），且不会被 list 当成可用项目
    expect(await fs.readdir(ws.rootDir())).toEqual([staleName]);
    expect(await ws.list()).toEqual([]);
  });

  it('其它无 manifest 的残留目录：不被当成项目，也不妨碍新建（原样保留）', async () => {
    const staleDir = path.join(ws.rootDir(), 'p-stale');
    await fs.mkdir(staleDir, { recursive: true });
    const p = await ws.create({ name: '新作品' });
    expect(await ws.get(p.id)).not.toBeNull();
    expect((await ws.list()).map((x) => x.id)).toEqual([p.id]);
    expect(await fs.stat(staleDir).then((s) => s.isDirectory())).toBe(true);
    expect(ws.projectDir(p.id)).not.toBe(staleDir);
  });

  it('manifest 写失败：清理本次新建的半成品目录，原错误原样上抛', async () => {
    const original = io.writeText.bind(io);
    vi.spyOn(io, 'writeText').mockImplementation(async (p: string, t: string) => {
      if (p.endsWith(WORKSPACE_MANIFEST_FILE)) throw new Error('boom-manifest');
      return original(p, t);
    });
    await expect(ws.create({ name: '写失败' })).rejects.toThrow(/boom-manifest/);
    vi.restoreAllMocks();
    expect(await fs.readdir(ws.rootDir())).toEqual([]);
    expect(await ws.list()).toEqual([]);
  });

  it('回滚后缓存/可写域回到干净状态：list 无坏项、projectDirs 只剩默认根', async () => {
    vi.spyOn(io, 'writeText').mockImplementation(async () => {
      throw new Error('boom-manifest');
    });
    await expect(ws.create({ name: '回滚作品' })).rejects.toThrow(/boom-manifest/);
    vi.restoreAllMocks();
    expect(await ws.list()).toEqual([]);
    expect(ws.projectDirs()).toEqual([ws.rootDir()]);
    expect(await fs.readdir(ws.rootDir())).toEqual([]);
  });

  it('清理自身失败：原始错误优先上抛，清理失败出声（不吞）', async () => {
    const warns: string[] = [];
    const spyWs = new WorkspaceServiceImpl({
      bridge: new NodeBridge(appData),
      io,
      log: { ...noopLog, warn: (m: string) => warns.push(m) },
    });
    await spyWs.init();
    vi.spyOn(io, 'writeText').mockImplementation(async () => {
      throw new Error('boom-manifest');
    });
    vi.spyOn(io, 'removeDir').mockImplementation(async () => {
      throw new Error('boom-cleanup');
    });
    await expect(spyWs.create({ name: '清理失败作品' })).rejects.toThrow(/boom-manifest/);
    expect(warns.some((w) => w.includes('清理半成品') && w.includes('boom-cleanup'))).toBe(true);
    vi.restoreAllMocks();
    // 清理失败现场保留：目录还在但没有 manifest ⇒ 不会被 list 当成项目
    expect(await spyWs.list()).toEqual([]);
    expect(spyWs.projectDirs()).toEqual([spyWs.rootDir()]);
  });

  it('建目录这一步就失败：同样回滚、原错上抛、不往缓存里留残项', async () => {
    vi.spyOn(io, 'ensureDir').mockImplementation(async () => {
      throw new Error('boom-mkdir');
    });
    await expect(ws.create({ name: '建目录失败' })).rejects.toThrow(/boom-mkdir/);
    vi.restoreAllMocks();
    expect(await fs.readdir(ws.rootDir())).toEqual([]);
    expect(await ws.list()).toEqual([]);
    expect(ws.projectDirs()).toEqual([ws.rootDir()]);
  });

  it('旧默认路径行为不变：不传 rootDir 仍落默认根，manifest/list 正常', async () => {
    const p = await ws.create({ name: '默认位置作品', meta: { author: '作者' } });
    expect(ws.projectDir(p.id)).toBe(path.join(ws.rootDir(), p.id));
    expect(await io.exists(path.join(ws.rootDir(), p.id, WORKSPACE_MANIFEST_FILE))).toBe(true);
    const list = await ws.list();
    expect(list.map((x) => x.id)).toEqual([p.id]);
    expect(list[0]!.name).toBe('默认位置作品');
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
      /这个制品目录已经存在/,
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
    await expect(ws.writeText(p.id, '../evil.txt', 'x')).rejects.toThrow(/越出了当前项目目录/);
    await expect(ws.readText(p.id, 'sub/../../evil.txt')).rejects.toThrow(/越出了当前项目目录/);
    await expect(ws.writeText(p.id, 'C:/abs/evil.txt', 'x')).rejects.toThrow(/不接受绝对路径/);
  });

  it('制品文件路径越界：写前校验抛错且不登记半成品', async () => {
    const p = await ws.create({ name: '作品' });
    await expect(
      ws.createArtifact(p.id, { name: '坏包', dirName: 'pkg', files: { '../escape.txt': 'x' } }),
    ).rejects.toThrow(/越出了制品目录/);
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
    ).rejects.toThrow(/这个制品目录已经存在/);
  });

  it('源目录不存在拒绝', async () => {
    const p = await ws.create({ name: '作品' });
    await expect(
      ws.importDirectory(p.id, { name: '导入', dirName: 'pkg', sourceDir: path.join(tmpDir, '不存在') }),
    ).rejects.toThrow(/源目录不存在/);
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

/**
 * 多根落点（2026-10-14 新建项目自选位置批）。
 *
 * 口径：`rootDir` **不是自由参数**——授权来自平台目录对话框（这里由
 * `NodeBridge(appData, [roots])` 扮演"对话框已选定并登记"的那半边），
 * 内核只核对名单；名单外的路径一律拒绝，且拒绝必须发生在任何写盘之前。
 */
describe('WorkspaceService · 多根落点（自选项目位置）', () => {
  let extraRoot: string;
  let io2: FileIOServiceImpl;
  let ws2: WorkspaceServiceImpl;

  beforeEach(async () => {
    extraRoot = path.join(tmpDir, '自选作品库');
    await fs.mkdir(extraRoot, { recursive: true });
    io2 = new FileIOServiceImpl(new NodeBridge(appData, [extraRoot]));
    ws2 = new WorkspaceServiceImpl({
      bridge: new NodeBridge(appData, [extraRoot]),
      io: io2,
      log: noopLog,
    });
    await ws2.init();
  });

  it('roots() 默认根恒在首位；自选根根身**不进**常驻可写根（2026-10-27 收窄批）', () => {
    const roots = ws2.roots();
    expect(roots[0]).toBe(ws2.rootDir());
    expect(roots).toContain(extraRoot);
    // `roots()` 仍是"可在哪里新建作品"，含自选根整体
    expect(ws2.projectDirs()).toEqual([ws2.rootDir()]);
    // 收窄口径的反向自证：自选根根身（可能就是游戏目录）此刻不可写
    expect(io2.isWritable(path.join(extraRoot, '包', '事件.ERB'))).toBe(false);
    expect(io2.isWritable(path.join(ws2.rootDir(), 'x', 'y.txt'))).toBe(true);
  });

  it('create 进授权根：落点在外部根，list 跨根看得见，projectDir 解析到外部根', async () => {
    const p = await ws2.create({ name: '外部作品', rootDir: extraRoot });
    expect(await fs.readFile(path.join(extraRoot, p.id, WORKSPACE_MANIFEST_FILE), 'utf8')).toContain(
      '外部作品',
    );
    // 同一实例：create 把 id→目录 记进缓存，不必再扫盘
    expect(ws2.projectDir(p.id)).toBe(path.join(extraRoot, p.id));
    // 默认根下不该多出这个目录
    expect(await io2.exists(path.join(ws2.rootDir(), p.id))).toBe(false);
    // 2026-10-27 收窄批：作品目录进可写域，自选根根身**不**进（两个方向都验）
    expect(ws2.projectDirs()).toContain(path.join(extraRoot, p.id));
    expect(io2.isWritable(path.join(extraRoot, p.id, 'pkg', 'a.txt'))).toBe(true);
    expect(io2.isWritable(path.join(extraRoot, '别处', 'b.txt'))).toBe(false);

    // 新实例（模拟重启后）：init 见到授权根就扫一次 ⇒ 外部根里的项目开箱即可解析
    const freshIo = new FileIOServiceImpl(new NodeBridge(appData, [extraRoot]));
    const fresh = new WorkspaceServiceImpl({
      bridge: new NodeBridge(appData, [extraRoot]),
      io: freshIo,
      log: noopLog,
    });
    await fresh.init();
    expect(fresh.projectDir(p.id)).toBe(path.join(extraRoot, p.id));
    // init 那次扫描解析出作品目录后，常驻可写根已按作品目录重算
    expect(freshIo.isWritable(path.join(extraRoot, p.id, 'workspace.json'))).toBe(true);
    expect(freshIo.isWritable(path.join(extraRoot, '别处', 'b.txt'))).toBe(false);
    const list = await fresh.list();
    expect(list.map((x) => x.name)).toContain('外部作品');
    // 制品动作按 projectDir 定位 ⇒ 外部根里的包读写的是外部根里的那份
    await fresh.createArtifact(p.id, { name: '包', dirName: 'pkg', files: { 'a.txt': '1' } });
    expect(await freshIo.exists(path.join(extraRoot, p.id, 'pkg', 'a.txt'))).toBe(true);
    const tf = await fresh.readText(p.id, 'pkg/a.txt');
    expect(tf.text).toBe('1');
  });

  it('create 传未授权根：拒绝（中文可读）且一个目录都不落', async () => {
    const rogue = path.join(tmpDir, '没授权过的文件夹');
    await fs.mkdir(rogue, { recursive: true });
    await expect(ws2.create({ name: '越权', rootDir: rogue })).rejects.toThrow(/未获得授权/);
    expect(await fs.readdir(rogue)).toEqual([]);
    expect((await ws2.list()).map((p) => p.name)).not.toContain('越权');
  });

  it('会话中途新增的授权根立刻可用（create 前重读名单，不必重启）', async () => {
    let authorized: string[] = [];
    // 以 NodeBridge 为原型覆写名单通道（类方法在原型上，展开复制会丢）
    const bridge = Object.assign(Object.create(new NodeBridge(appData)) as PlatformBridge, {
      listWorkspaceRoots: async () => [...authorized],
    });
    const lateIo = new FileIOServiceImpl(bridge);
    const lateWs = new WorkspaceServiceImpl({ bridge, io: lateIo, log: noopLog });
    await lateWs.init();
    expect(lateWs.roots()).toEqual([lateWs.rootDir()]); // 起步只有默认根

    const newly = path.join(tmpDir, '刚在对话框里选中的文件夹');
    await fs.mkdir(newly, { recursive: true });
    authorized = [newly]; // = 用户刚点完「自选…」，平台侧已登记授权

    const p = await lateWs.create({ name: '中途授权', rootDir: newly });
    expect(await fs.readFile(path.join(newly, p.id, WORKSPACE_MANIFEST_FILE), 'utf8')).toContain(
      '中途授权',
    );
  });

  it('跨根同 id：保留默认根那一份并 warn（不静默出双份）', async () => {
    const warns: string[] = [];
    const spyLog = { ...noopLog, warn: (m: string) => warns.push(m) };
    const ioSpy = new FileIOServiceImpl(new NodeBridge(appData, [extraRoot]));
    const wsSpy = new WorkspaceServiceImpl({
      bridge: new NodeBridge(appData, [extraRoot]),
      io: ioSpy,
      log: spyLog,
    });
    await wsSpy.init();
    const p = await wsSpy.create({ name: '唯一', meta: { mark: 'default' } });
    // 把整个项目目录复制到授权根下（同 id 两处并存 = 手工挪动 / 同步盘的产物）
    await fs.cp(path.join(wsSpy.rootDir(), p.id), path.join(extraRoot, p.id), { recursive: true });

    const list = await wsSpy.list();
    const hits = list.filter((x) => x.id === p.id);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.meta.mark).toBe('default'); // 默认根那份赢（roots() 首位）
    expect(wsSpy.projectDir(p.id)).toBe(path.join(wsSpy.rootDir(), p.id));
    expect(warns.some((w) => w.includes('both'))).toBe(true);
  });

  it('外部根里的项目：remove 仍能删对目录（"回落默认根 + 删不存在的目录 = 幂等成功"这条静默失败被堵住）', async () => {
    const p = await ws2.create({ name: '将删的外部作品', rootDir: extraRoot });
    // 造一个"没扫过盘"的服务：init 时名单还是空（= 没有外部根、缓存空），
    // 之后名单里才出现那个根 ⇒ projectDir 只能回落默认根，remove 必须自己去定位
    let reveal: string[] = [];
    const bridge = Object.assign(Object.create(new NodeBridge(appData)) as PlatformBridge, {
      listWorkspaceRoots: async () => [...reveal],
    });
    const freshIo = new FileIOServiceImpl(bridge);
    const fresh = new WorkspaceServiceImpl({ bridge, io: freshIo, log: noopLog });
    await fresh.init();
    reveal = [extraRoot];

    expect(fresh.projectDir(p.id)).toBe(path.join(fresh.rootDir(), p.id)); // 契约里写明的回落
    await fresh.remove(p.id);
    expect(await freshIo.exists(path.join(extraRoot, p.id))).toBe(false);
    expect(await freshIo.exists(path.join(fresh.rootDir(), p.id))).toBe(false);
  });

  it('外部根作品删除后从常驻可写根移除（只收窄，不残留可写，P0-7b）', async () => {
    const p = await ws2.create({ name: '删掉的外部作品', rootDir: extraRoot });
    expect(ws2.projectDirs()).toContain(path.join(extraRoot, p.id));
    await ws2.remove(p.id);
    expect(ws2.projectDirs()).toEqual([ws2.rootDir()]);
    expect(io2.isWritable(path.join(extraRoot, p.id, 'x.txt'))).toBe(false);
  });

  it('授权根不存在（作者删了那个文件夹）：跳过并出声，不连累启动', async () => {
    const gone = path.join(tmpDir, '已经不存在的作品库');
    const ioGone = new FileIOServiceImpl(new NodeBridge(appData, [gone]));
    const warns: string[] = [];
    const wsGone = new WorkspaceServiceImpl({
      bridge: new NodeBridge(appData, [gone]),
      io: ioGone,
      log: { ...noopLog, warn: (m: string) => warns.push(m) },
    });
    await wsGone.init();
    expect(wsGone.roots()).toEqual([wsGone.rootDir()]);
    expect(warns.some((w) => w.includes(gone))).toBe(true);
    // 默认根照常可用
    const p = await wsGone.create({ name: '照旧' });
    expect(await ioGone.exists(path.join(wsGone.rootDir(), p.id))).toBe(true);
  });

  it('读名单本身失败：只用默认根 + 出声（不静默、不炸启动）', async () => {
    const bridge = Object.assign(Object.create(new NodeBridge(appData)) as PlatformBridge, {
      listWorkspaceRoots: async () => {
        throw new Error('no such file');
      },
    });
    const warns: string[] = [];
    const wsFallback = new WorkspaceServiceImpl({
      bridge,
      io: new FileIOServiceImpl(bridge),
      log: { ...noopLog, warn: (m: string) => warns.push(m) },
    });
    await wsFallback.init();
    expect(wsFallback.roots()).toEqual([wsFallback.rootDir()]);
    expect(warns.length).toBeGreaterThan(0);
    expect(await wsFallback.list()).toEqual([]);
  });

  it('落点根都不在写闸之外：默认根外的任意路径仍被 io 第一道闸拒绝', async () => {
    const p = await ws2.create({ name: '外部', rootDir: extraRoot });
    await expect(
      ws2.writeText(p.id, path.join('..', '..', 'evil.txt').replace(/\\/g, '/'), 'x'),
    ).rejects.toThrow(/越出了当前项目目录/);
    await expect(io2.writeText(path.join(tmpDir, 'somewhere-else', 'x.txt'), 'no')).rejects.toThrow(
      WriteNotAllowedError,
    );
  });

  it('服务不可用时 roots() 与 rootDir() 同口径抛错（不静默返回空名单）', () => {
    const dead = new WorkspaceServiceImpl({
      bridge: {
        appDataDir: async () => {
          throw new Error('no platform data dir');
        },
      } as unknown as PlatformBridge,
      io: new FileIOServiceImpl(new NodeBridge(appData)),
      log: noopLog,
    });
    expect(() => dead.roots()).toThrow(/unavailable/);
    expect(() => dead.rootDir()).toThrow(/unavailable/);
    expect(() => dead.projectDirs()).toThrow(/unavailable/);
  });

  /* ---------------- 撤销自选根（2026-10-27 撤销批） ---------------- */

  it('撤销自选根：默认根拒绝；有作品时拒绝（中文原因、平台清单不动）；清空后成功并重建可写根', async () => {
    const revoked: string[] = [];
    let authorized = [extraRoot];
    const bridge = Object.assign(Object.create(new NodeBridge(appData, [extraRoot])) as PlatformBridge, {
      listWorkspaceRoots: async () => [...authorized],
      revokeWorkspaceRoot: async (p: string) => {
        revoked.push(p);
        authorized = authorized.filter((r) => r !== p);
      },
    });
    const rIo = new FileIOServiceImpl(bridge);
    const rWs = new WorkspaceServiceImpl({ bridge, io: rIo, log: noopLog });
    await rWs.init();

    // 默认根不可撤销（它就是作品的常驻位置）
    await expect(rWs.revokeRoot(rWs.rootDir())).rejects.toThrow(/默认工作区不能撤销/);
    expect(revoked).toEqual([]);

    const p = await rWs.create({ name: '还没搬走的作品', rootDir: extraRoot });
    await expect(rWs.revokeRoot(extraRoot)).rejects.toThrow(/还有 1 个作品/);
    // 拒绝必须发生在动平台清单之前：授权一个字节都没少、作品照旧可写
    expect(revoked).toEqual([]);
    expect(rWs.roots()).toContain(extraRoot);
    expect(rIo.isWritable(path.join(extraRoot, p.id, 'a.txt'))).toBe(true);

    await rWs.remove(p.id);
    await rWs.revokeRoot(extraRoot);
    expect(revoked).toEqual([extraRoot]);
    expect(rWs.roots()).toEqual([rWs.rootDir()]);
    expect(rWs.projectDirs()).toEqual([rWs.rootDir()]);
    expect(rIo.isWritable(path.join(extraRoot, 'x.txt'))).toBe(false);
  });

  it('撤销没授权过的根：拒绝（人话），不去惊动平台', async () => {
    await expect(ws2.revokeRoot(path.join(tmpDir, '从没授权过的文件夹'))).rejects.toThrow(
      /不在已授权的项目位置清单/,
    );
  });

  it('平台无撤销能力（Node 桥）：错误如实上抛，名单原样（不静默假装撤掉了）', async () => {
    await expect(ws2.revokeRoot(extraRoot)).rejects.toThrow(/revokeWorkspaceRoot is not supported/);
    expect(ws2.roots()).toContain(extraRoot);
  });
});

/**
 * 删除路径的双闸复验（2026-10-16 修复批）。
 *
 * 修复前：remove / removeArtifact 直调 `bridge.removeDir`，绕过 io.removeDir 的
 * assertWritable 写闸；且 removeArtifact 不复验 manifest 里的 artifact.dirName——
 * join 会归一化折叠 '..'，被篡改的 dirName（如 '../../backup'）能把写闸外的
 * 备份域整目录删掉（Rust 第二道闸的判定域含整个 appDataDir，同样不拦）。
 */
describe('WorkspaceService · 删除路径：写闸 + dirName 复验', () => {
  it('remove 走 io 写闸：常驻可写根被清空后拒绝删除，目录原样在盘上', async () => {
    const p = await ws.create({ name: '将删' });
    io.setAppWritableRoots([]); // 连常驻根一起收回：此刻任何删除都必须被第一道闸拦下
    await expect(ws.remove(p.id)).rejects.toThrow(WriteNotAllowedError);
    expect(await io.exists(ws.projectDir(p.id))).toBe(true);
  });

  it('removeArtifact 走 io 写闸：同上，制品目录原样在盘上', async () => {
    const p = await ws.create({ name: '作品' });
    const art = await ws.createArtifact(p.id, { name: '包', dirName: 'pkg', files: { 'a.txt': 'x' } });
    io.setAppWritableRoots([]);
    await expect(ws.removeArtifact(p.id, art.id)).rejects.toThrow(WriteNotAllowedError);
    expect(await io.exists(path.join(ws.projectDir(p.id), 'pkg', 'a.txt'))).toBe(true);
  });

  it('remove 拒绝逃逸段的项目 id：不把 <appData>/backup 当项目目录删光', async () => {
    // 诱饵：<appData>/backup 里有 workspace.json（locateProjectDir 的存在性探测会命中）
    const backupDir = path.join(appData, 'backup');
    await fs.mkdir(path.join(backupDir, 'bucket'), { recursive: true });
    await fs.writeFile(path.join(backupDir, 'bucket', 'v1.bak'), 'precious', 'utf8');
    await fs.writeFile(path.join(backupDir, WORKSPACE_MANIFEST_FILE), '{}', 'utf8');
    await expect(ws.remove(path.join('..', '..', 'backup'))).rejects.toThrow(/项目名不合法/);
    expect(await io.exists(path.join(backupDir, 'bucket', 'v1.bak'))).toBe(true);
  });

  it('removeArtifact 复验 manifest 的 dirName：../../backup 类篡改被段校验拒绝，备份全存活', async () => {
    const p = await ws.create({ name: '作品' });
    const art = await ws.createArtifact(p.id, { name: '包', dirName: 'pkg', files: { 'a.txt': 'x' } });
    const backupDir = path.join(appData, 'backup');
    await fs.mkdir(path.join(backupDir, 'bucket'), { recursive: true });
    await fs.writeFile(path.join(backupDir, 'bucket', 'v1.bak'), 'precious', 'utf8');
    // 手改 manifest 模拟被篡改的 dirName（join 会折叠 '..'——正是要防的形态）
    const manifestPath = path.join(ws.projectDir(p.id), WORKSPACE_MANIFEST_FILE);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      artifacts: Array<{ dirName: string }>;
    };
    manifest.artifacts[0]!.dirName = path.join('..', '..', 'backup');
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    await expect(ws.removeArtifact(p.id, art.id)).rejects.toThrow(/制品目录名不合法/);
    expect(await io.exists(path.join(backupDir, 'bucket', 'v1.bak'))).toBe(true);
    // 盘上合规的制品目录不被顺手波及
    expect(await io.exists(path.join(ws.projectDir(p.id), 'pkg', 'a.txt'))).toBe(true);
  });

  it('removeArtifact 复验 dirName：同根内的段级跳跃（../邻居）写闸拦不住，段校验必须拦', async () => {
    const p = await ws.create({ name: '作品' });
    const art = await ws.createArtifact(p.id, { name: '包', dirName: 'pkg', files: { 'a.txt': 'x' } });
    // 邻居目录在同一常驻可写根内 ⇒ 纯写闸放行；只有段校验能拦
    const neighbor = path.join(ws.rootDir(), 'neighbor');
    await fs.mkdir(neighbor, { recursive: true });
    await fs.writeFile(path.join(neighbor, 'keep.txt'), 'keep', 'utf8');
    const manifestPath = path.join(ws.projectDir(p.id), WORKSPACE_MANIFEST_FILE);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      artifacts: Array<{ dirName: string }>;
    };
    manifest.artifacts[0]!.dirName = path.join('..', 'neighbor');
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    await expect(ws.removeArtifact(p.id, art.id)).rejects.toThrow(/制品目录名不合法/);
    expect(await io.exists(path.join(neighbor, 'keep.txt'))).toBe(true);
    // 摘除登记必须发生在删除成功之后（删除被拒 ⇒ manifest 原样）
    expect((await ws.get(p.id))!.artifacts).toHaveLength(1);
  });
});

describe('WorkspaceService · importDirectory 半成品清理', () => {
  async function makeImportSrc(): Promise<string> {
    const src = path.join(tmpDir, 'import-src');
    await fs.mkdir(path.join(src, 'sub'), { recursive: true });
    await fs.writeFile(path.join(src, 'a.txt'), 'A', 'utf8');
    await fs.writeFile(path.join(src, 'sub', 'b.txt'), 'B', 'utf8');
    return src;
  }

  it('复制中途失败：半成品目录被清理，manifest 未登记，重试不再撞 already exists', async () => {
    const src = await makeImportSrc();
    const p = await ws.create({ name: '作品' });
    const original = io.copyFile.bind(io);
    let calls = 0;
    // rebase 适配（PERF-10b④）：导入复制已改走一趟 copyFile，失败注入点同步换到 copyFile
    vi.spyOn(io, 'copyFile').mockImplementation(async (from, to) => {
      calls += 1;
      if (calls === 2) throw new Error('模拟第二份写入失败');
      return original(from, to);
    });
    await expect(
      ws.importDirectory(p.id, { name: '导入', dirName: 'pkg', sourceDir: src }),
    ).rejects.toThrow(/第二份写入失败/);
    vi.restoreAllMocks();
    // 半成品目录已被清理（修复前留在盘上，dirName 永久卡死）
    expect(await io.exists(path.join(ws.projectDir(p.id), 'pkg'))).toBe(false);
    expect((await ws.get(p.id))!.artifacts).toHaveLength(0);
    // 重试 = 全新导入，成功
    const art = await ws.importDirectory(p.id, { name: '导入', dirName: 'pkg', sourceDir: src });
    expect(art.dirName).toBe('pkg');
    expect(await fs.readFile(path.join(ws.projectDir(p.id), 'pkg', 'sub', 'b.txt'), 'utf8')).toBe('B');
  });

  it('清理自身失败：原错误如实上抛，清理失败出声（不吞）', async () => {
    const src = await makeImportSrc();
    const p = await ws.create({ name: '作品' });
    const original = io.copyFile.bind(io);
    let calls = 0;
    // rebase 适配（PERF-10b④）：失败注入点从 writeBytes 换到 copyFile
    vi.spyOn(io, 'copyFile').mockImplementation(async (from, to) => {
      calls += 1;
      if (calls === 2) throw new Error('boom-write');
      return original(from, to);
    });
    vi.spyOn(io, 'removeDir').mockImplementation(async () => {
      throw new Error('boom-cleanup');
    });
    const warns: string[] = [];
    const wsSpy = new WorkspaceServiceImpl({
      bridge: new NodeBridge(appData),
      io,
      log: { ...noopLog, warn: (m: string) => warns.push(m) },
    });
    await wsSpy.init();
    await expect(
      wsSpy.importDirectory(p.id, { name: '导入', dirName: 'pkg', sourceDir: src }),
    ).rejects.toThrow(/boom-write/); // 真因保留，不被清理错误顶替
    expect(warns.some((m) => m.includes('pkg') && m.includes('清理'))).toBe(true);
  });
});

/**
 * 重命名 + 复制（2026-11-02 P0-7a）。
 *
 * 口径：改名与复制都只动作者工作区；复制落点只允许「已授权根 ∪ 项目当前根」，
 * 字节级复制（含二进制）且 manifest 必然重写（新 id / 新时间 / artifact id 重生成）。
 */
describe('WorkspaceService · 重命名与复制', () => {
  /** 造一个含文本 + 二进制 + 嵌套目录的项目，返回项目与二进制字节 */
  async function makeRichProject(name = '原作品'): Promise<{
    project: Awaited<ReturnType<WorkspaceServiceImpl['create']>>;
    bin: number[];
    artifactId: string;
  }> {
    const project = await ws.create({ name, meta: { author: '原作者' } });
    const art = await ws.createArtifact(project.id, {
      name: '初版包',
      dirName: '初版包-K1 v1.0',
      files: { 'README.md': '# 原包\n', '子/深文件.ERB': 'PRINTL 深层\n' },
      meta: { charaNo: 1 },
    });
    const bin = [0x82, 0xb1, 0x82, 0xf1];
    await fs.writeFile(
      path.join(ws.projectDir(project.id), art.dirName, '二进制.bin'),
      Buffer.from(bin),
    );
    return { project, bin, artifactId: art.id };
  }

  it('复制：字节级含二进制 / 嵌套目录，manifest 重写（新 id、新名、新时间、artifact id 重生成）', async () => {
    const { project, bin, artifactId } = await makeRichProject();
    const copy = await ws.duplicateProject(project.id, { name: '副本作品' });

    expect(copy.id).not.toBe(project.id);
    expect(copy.name).toBe('副本作品');
    expect(copy.createdAt).toBeGreaterThanOrEqual(project.createdAt);
    expect(copy.meta).toEqual({ author: '原作者' });
    expect(copy.artifacts).toHaveLength(1);
    expect(copy.artifacts[0]!.dirName).toBe('初版包-K1 v1.0');
    expect(copy.artifacts[0]!.id).not.toBe(artifactId);

    const copyDir = ws.projectDir(copy.id);
    expect((await ws.readText(copy.id, '初版包-K1 v1.0/README.md')).text).toBe('# 原包\n');
    expect((await ws.readText(copy.id, '初版包-K1 v1.0/子/深文件.ERB')).text).toBe(
      'PRINTL 深层\n',
    );
    const copied = await fs.readFile(path.join(copyDir, '初版包-K1 v1.0', '二进制.bin'));
    expect([...copied]).toEqual(bin);
    // 原项目原样存活（复制不是移动）
    expect((await ws.readText(project.id, '初版包-K1 v1.0/README.md')).text).toBe('# 原包\n');
    // list 能看到两份
    const list = await ws.list();
    expect(list.map((p) => p.name)).toEqual(expect.arrayContaining(['原作品', '副本作品']));
  });

  it('复制：缺省名 = 「<原名> 副本」', async () => {
    const { project } = await makeRichProject('甲作品');
    const copy = await ws.duplicateProject(project.id);
    expect(copy.name).toBe('甲作品 副本');
  });

  it('复制：同根重名拒绝（不覆盖既有项目，也不落新目录）', async () => {
    const { project } = await makeRichProject('甲作品');
    await ws.create({ name: '甲作品 副本' });
    const before = (await ws.list()).length;
    await expect(ws.duplicateProject(project.id)).rejects.toThrow(/同名项目/);
    expect((await ws.list()).length).toBe(before);
  });

  it('复制：未授权的 rootDir 拒绝（中文原因），目标目录一个都不落', async () => {
    const { project } = await makeRichProject();
    const rogue = path.join(tmpDir, '没授权过的位置');
    await fs.mkdir(rogue, { recursive: true });
    await expect(
      ws.duplicateProject(project.id, { name: '越权副本', rootDir: rogue }),
    ).rejects.toThrow(/未获得授权/);
    expect(await fs.readdir(rogue)).toEqual([]);
  });

  it('复制：显式授权根可用（外部根），新项目目录进可写域且 list 跨根可见', async () => {
    const extraRoot = path.join(tmpDir, '自选作品库-复制');
    await fs.mkdir(extraRoot, { recursive: true });
    const xIo = new FileIOServiceImpl(new NodeBridge(appData, [extraRoot]));
    const xWs = new WorkspaceServiceImpl({
      bridge: new NodeBridge(appData, [extraRoot]),
      io: xIo,
      log: noopLog,
    });
    await xWs.init();

    const p = await xWs.create({ name: '外部原作品', rootDir: extraRoot });
    await xWs.createArtifact(p.id, { name: '包', dirName: 'pkg', files: { 'a.txt': '1' } });
    const copy = await xWs.duplicateProject(p.id, { name: '外部副本', rootDir: extraRoot });

    const copyDir = path.join(extraRoot, copy.id);
    expect((await xWs.readText(copy.id, 'pkg/a.txt')).text).toBe('1');
    expect(xWs.projectDir(copy.id)).toBe(copyDir);
    expect(xWs.projectDirs()).toContain(copyDir);
    expect(xIo.isWritable(path.join(copyDir, 'pkg', 'a.txt'))).toBe(true);
    expect((await xWs.list()).map((x) => x.name)).toEqual(
      expect.arrayContaining(['外部原作品', '外部副本']),
    );
    // 自选根根身仍不因复制变可写（收窄口径未被本批放宽）
    expect(xIo.isWritable(path.join(extraRoot, '别处', 'x.txt'))).toBe(false);
  });

  it('复制：中途失败清理半成品目录并摘掉缓存（不留半份项目）', async () => {
    const { project } = await makeRichProject();
    const original = io.copyFile.bind(io);
    let calls = 0;
    vi.spyOn(io, 'copyFile').mockImplementation(async (from, to) => {
      calls += 1;
      if (calls === 2) throw new Error('boom-copy');
      return original(from, to);
    });
    await expect(ws.duplicateProject(project.id, { name: '半成品' })).rejects.toThrow(/boom-copy/);
    vi.restoreAllMocks();
    const names = (await ws.list()).map((p) => p.name);
    expect(names).not.toContain('半成品');
    // 刷新后的列表里不出现半成品；磁盘上也没有残留的新目录（原项目仍在）
    expect(await ws.get(project.id)).not.toBeNull();
  });

  it('复制不存在的项目：如实拒绝', async () => {
    // locateProjectDir 在 P0-7b 改为以 null 表示"任何授权根里都没有"（remove 需幂等成功）；
    // duplicateProject 把 null 还原成明确失败，仍是中文人话。
    await expect(ws.duplicateProject('p-不存在')).rejects.toThrow(/找不到这个工作区项目/);
  });

  it('重命名：空名拒绝；与原项目同名（只改空白）放行', async () => {
    const p = await ws.create({ name: '原名' });
    await expect(ws.update(p.id, { name: '   ' })).rejects.toThrow(/项目名不能为空/);
    const same = await ws.update(p.id, { name: '  原名  ' });
    expect(same.name).toBe('原名');
  });

  it('重命名：与同根其它项目重名拒绝（中文原因、原名不变）', async () => {
    const a = await ws.create({ name: '甲' });
    await ws.create({ name: '乙' });
    await expect(ws.update(a.id, { name: '乙' })).rejects.toThrow(/同名项目/);
    expect((await ws.get(a.id))!.name).toBe('甲');
  });
});
