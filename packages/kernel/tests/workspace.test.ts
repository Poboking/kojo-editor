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

  it('roots() 默认根恒在首位；授权根 init 起就登记进 io 常驻可写根', () => {
    const roots = ws2.roots();
    expect(roots[0]).toBe(ws2.rootDir());
    expect(roots).toContain(extraRoot);
    expect(io2.isWritable(path.join(extraRoot, '包', '事件.ERB'))).toBe(true);
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

    // 新实例（模拟重启后）：init 见到授权根就扫一次 ⇒ 外部根里的项目开箱即可解析
    const freshIo = new FileIOServiceImpl(new NodeBridge(appData, [extraRoot]));
    const fresh = new WorkspaceServiceImpl({
      bridge: new NodeBridge(appData, [extraRoot]),
      io: freshIo,
      log: noopLog,
    });
    await fresh.init();
    expect(fresh.projectDir(p.id)).toBe(path.join(extraRoot, p.id));
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
    ).rejects.toThrow(/escapes/);
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
    await expect(ws.remove(path.join('..', '..', 'backup'))).rejects.toThrow(/Invalid project id/);
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
    await expect(ws.removeArtifact(p.id, art.id)).rejects.toThrow(/Invalid artifact directory name/);
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
    await expect(ws.removeArtifact(p.id, art.id)).rejects.toThrow(/Invalid artifact directory name/);
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
