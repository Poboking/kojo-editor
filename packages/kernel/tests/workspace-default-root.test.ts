/**
 * 默认工作区（默认落点根，2026-11-03 批）。
 *
 * 钉四件事：
 * 1. **没设定 = 历史行为逐字不变**：`defaultRoot()` 就是内置根，`create` 不带 `rootDir` 照旧落那里；
 * 2. **设定不是扩权**：只接受命中 `roots()` 的那几条（授权来自目录对话框，铁律 6），
 *    名单外一律中文拒绝且不改内存、不落盘；
 * 3. **失效不静默也不清零**：那条根暂时读不到 ⇒ 本次落回内置根 + 出声，设定留着，
 *    重新授权（硬盘插回来）自动沿用回来；
 * 4. **写允许域口径没被这批改动**：默认落点换成自选根后，可写的仍是**建出来的作品目录**，
 *    自选根的根身依旧不可写（2026-10-27 收窄批的红线）。
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PlatformBridge, ScopedStorage } from '@kojo/plugin-api';
import { WORKSPACE_MANIFEST_FILE } from '@kojo/plugin-api';
import { beforeEach, describe, expect, it } from 'vitest';
import { FileIOServiceImpl } from '../src/io';
import { WorkspaceServiceImpl, type WorkspaceServiceDeps } from '../src/workspace';
import { NodeBridge } from './helpers/node-bridge';

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const KEY = 'default-workspace-root';

/** 内核全局域的内存替身（与 `recent-projects` 同一条通道，只是不落真盘） */
function memoryStorage(initial: Record<string, unknown> = {}): ScopedStorage & { dumped(): Record<string, unknown> } {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    async get<T>(key: string) {
      return map.has(key) ? (map.get(key) as T) : undefined;
    },
    async set<T>(key: string, value: T) {
      map.set(key, value);
    },
    async delete(key: string) {
      map.delete(key);
    },
    async keys() {
      return [...map.keys()];
    },
    dumped: () => Object.fromEntries(map),
  };
}

let tmpDir: string;
let appData: string;
let extraRoot: string;
let io: FileIOServiceImpl;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-wsdef-'));
  appData = path.join(tmpDir, 'appdata');
  extraRoot = path.join(tmpDir, '自选作品库');
  await fs.mkdir(extraRoot, { recursive: true });
  io = new FileIOServiceImpl(new NodeBridge(appData, [extraRoot]));
});

/** 起一台服务（默认带一条已授权自选根 + 内存全局存储域） */
async function makeWs(
  over: Partial<Pick<WorkspaceServiceDeps, 'bridge' | 'io' | 'log' | 'globalStorage'>> & {
    init?: boolean;
  } = {},
): Promise<WorkspaceServiceImpl> {
  const ws = new WorkspaceServiceImpl({
    bridge: over.bridge ?? new NodeBridge(appData, [extraRoot]),
    io: over.io ?? io,
    log: over.log ?? noopLog,
    globalStorage: over.globalStorage === undefined ? memoryStorage() : over.globalStorage,
  });
  if (over.init !== false) await ws.init();
  return ws;
}

describe('WorkspaceService · 默认落点根：未设定 = 历史行为', () => {
  it('没设定过：defaultRoot() 就是内置根，customDefaultRoot() 为空，create 落内置根', async () => {
    const ws = await makeWs();
    expect(ws.customDefaultRoot()).toBeNull();
    expect(ws.defaultRoot()).toBe(ws.rootDir());
    const p = await ws.create({ name: '老作者的作品' });
    expect(ws.projectDir(p.id)).toBe(path.join(ws.rootDir(), p.id));
    expect(await io.exists(path.join(extraRoot, p.id))).toBe(false);
  });

  it('roots() 的顺序不受默认设定影响（内置根恒在首位）', async () => {
    const ws = await makeWs();
    await ws.setDefaultRoot(extraRoot);
    expect(ws.roots()[0]).toBe(ws.rootDir());
    expect(ws.defaultRoot()).toBe(extraRoot);
  });
});

describe('WorkspaceService · setDefaultRoot', () => {
  it('设定授权根后：create 不带 rootDir 就落在那条根里，作品目录进常驻可写域、根身仍不可写', async () => {
    const ws = await makeWs();
    await ws.setDefaultRoot(extraRoot);
    expect(ws.defaultRoot()).toBe(extraRoot);
    expect(ws.customDefaultRoot()).toBe(extraRoot);

    const p = await ws.create({ name: '默认库里的作品' });
    expect(ws.projectDir(p.id)).toBe(path.join(extraRoot, p.id));
    expect(await fs.readFile(path.join(extraRoot, p.id, WORKSPACE_MANIFEST_FILE), 'utf8')).toContain(
      '默认库里的作品',
    );
    // 2026-11-03 批不许动的红线：默认落点≠把整条根放宽
    expect(ws.projectDirs()).toContain(path.join(extraRoot, p.id));
    expect(io.isWritable(path.join(extraRoot, '别处', 'b.txt'))).toBe(false);
    // 制品链路（createArtifact 走 projectDir）在新落点上照常可写
    await ws.createArtifact(p.id, { name: '包', dirName: 'pkg', files: { 'a.txt': '1' } });
    expect(await io.exists(path.join(extraRoot, p.id, 'pkg', 'a.txt'))).toBe(true);
  });

  it('名单外的路径一律拒绝（中文可读），设定与盘都不动', async () => {
    const ws = await makeWs();
    const rogue = path.join(tmpDir, '对话框没授权过的文件夹');
    await fs.mkdir(rogue, { recursive: true });
    await expect(ws.setDefaultRoot(rogue)).rejects.toThrow(/不能设为默认/);
    await expect(ws.setDefaultRoot(rogue)).rejects.toThrow(/目录对话框/);
    expect(ws.customDefaultRoot()).toBeNull();
    expect(ws.defaultRoot()).toBe(ws.rootDir());
    expect(await fs.readdir(rogue)).toEqual([]);
  });

  it('空串 / 全空白：拒绝且不改动任何东西', async () => {
    const ws = await makeWs();
    await ws.setDefaultRoot(extraRoot);
    await expect(ws.setDefaultRoot('   ')).rejects.toThrow(/没有给路径/);
    expect(ws.defaultRoot()).toBe(extraRoot);
  });

  it('同一目录的另一种写法（尾分隔符 / 大小写）算同一条根，存的是名单里的规范写法', async () => {
    const ws = await makeWs();
    const sloppy = `${extraRoot}${path.sep}`;
    await ws.setDefaultRoot(sloppy);
    expect(ws.customDefaultRoot()).toBe(extraRoot);
    expect(ws.defaultRoot()).toBe(extraRoot);
  });

  it('选内置根 = 清除设定（回到"未设定"，不是"设定成内置根"）', async () => {
    const storage = memoryStorage();
    const ws = await makeWs({ globalStorage: storage });
    await ws.setDefaultRoot(extraRoot);
    expect(storage.dumped()[KEY]).toBe(extraRoot);
    await ws.setDefaultRoot(ws.rootDir());
    expect(ws.customDefaultRoot()).toBeNull();
    expect(ws.defaultRoot()).toBe(ws.rootDir());
    expect(storage.dumped()[KEY]).toBeUndefined();
  });

  it('会话中途刚授权的根立刻能设成默认（create 前重读名单那条口径同源）', async () => {
    let authorized: string[] = [];
    const bridge = Object.assign(Object.create(new NodeBridge(appData)) as PlatformBridge, {
      listWorkspaceRoots: async () => [...authorized],
    });
    const ws = await makeWs({ bridge, io: new FileIOServiceImpl(bridge) });
    const newly = path.join(tmpDir, '刚在对话框里选中的文件夹');
    await fs.mkdir(newly, { recursive: true });
    authorized = [newly];
    await ws.setDefaultRoot(newly);
    expect(ws.defaultRoot()).toBe(newly);
    const p = await ws.create({ name: '中途设的默认' });
    expect(ws.projectDir(p.id)).toBe(path.join(newly, p.id));
  });

  it('存储写不进去：原样报错并说明"仍沿用原来的设定"，内存不先改（不留两个真相）', async () => {
    const broken = memoryStorage();
    broken.set = async () => {
      throw new Error('disk full');
    };
    const ws = await makeWs({ globalStorage: broken });
    await expect(ws.setDefaultRoot(extraRoot)).rejects.toThrow(/没能保存/);
    await expect(ws.setDefaultRoot(extraRoot)).rejects.toThrow(/disk full/);
    expect(ws.customDefaultRoot()).toBeNull();
    expect(ws.defaultRoot()).toBe(ws.rootDir());
  });

  it('没有存储域（老替身）：本次会话生效 + 出声说明不跨启动，绝不假装记住了', async () => {
    const warns: string[] = [];
    const infos: string[] = [];
    const ws = await makeWs({
      globalStorage: null,
      log: { ...noopLog, warn: (m: string) => warns.push(m), info: (m: string) => infos.push(m) },
    });
    await ws.setDefaultRoot(extraRoot);
    expect(ws.defaultRoot()).toBe(extraRoot);
    expect(warns.some((w) => w.includes('不跨启动'))).toBe(true);
  });
});

describe('WorkspaceService · 默认设定的持久与失效', () => {
  it('重启后沿用（同一份全局域 + 同一份授权名单）：init 即恢复默认落点', async () => {
    const storage = memoryStorage();
    const first = await makeWs({ globalStorage: storage });
    await first.setDefaultRoot(extraRoot);
    const second = await makeWs({ globalStorage: storage });
    expect(second.customDefaultRoot()).toBe(extraRoot);
    expect(second.defaultRoot()).toBe(extraRoot);
    const p = await second.create({ name: '重启后的作品' });
    expect(second.projectDir(p.id)).toBe(path.join(extraRoot, p.id));
  });

  it('那条根暂时读不到（没插盘 / 撤过授权）：落回内置根 + 出声，设定本身留着', async () => {
    const warns: string[] = [];
    const storage = memoryStorage({ [KEY]: extraRoot });
    // 名单里没有 extraRoot = 授权已不在 / 文件夹已消失
    const bridge = Object.assign(Object.create(new NodeBridge(appData)) as PlatformBridge, {
      listWorkspaceRoots: async () => [] as string[],
    });
    const ws = await makeWs({
      bridge,
      io: new FileIOServiceImpl(bridge),
      globalStorage: storage,
      log: { ...noopLog, warn: (m: string) => warns.push(m) },
    });
    expect(ws.customDefaultRoot()).toBe(extraRoot);
    expect(ws.defaultRoot()).toBe(ws.rootDir());
    expect(warns.some((w) => w.includes('默认工作区当前不可用') && w.includes(extraRoot))).toBe(true);
    // 不静默回落：新建照样成功，只是落在内置根里
    const p = await ws.create({ name: '失效期间的作品' });
    expect(ws.projectDir(p.id)).toBe(path.join(ws.rootDir(), p.id));
  });

  it('失效期间不清设定：同一条根重新授权后（下次启动）自动沿用回来', async () => {
    const storage = memoryStorage({ [KEY]: extraRoot });
    let authorized: string[] = [];
    const bridge = Object.assign(Object.create(new NodeBridge(appData)) as PlatformBridge, {
      listWorkspaceRoots: async () => [...authorized],
    });
    const ws = await makeWs({ bridge, io: new FileIOServiceImpl(bridge), globalStorage: storage });
    expect(ws.defaultRoot()).toBe(ws.rootDir());

    authorized = [extraRoot]; // = 作者重新在对话框里选了同一个文件夹
    const revived = await makeWs({ bridge, io: new FileIOServiceImpl(bridge), globalStorage: storage });
    expect(revived.defaultRoot()).toBe(extraRoot);
    expect(revived.customDefaultRoot()).toBe(extraRoot);
  });

  it('盘上的设定是坏值（相对路径 / 空串 / 非字符串）：出声忽略，不拿它去比名单', async () => {
    const warns: string[] = [];
    const log = { ...noopLog, warn: (m: string) => warns.push(m) };
    const rel = await makeWs({ globalStorage: memoryStorage({ [KEY]: 'workspaces' }), log });
    expect(rel.defaultRoot()).toBe(rel.rootDir());
    expect(rel.customDefaultRoot()).toBeNull();
    expect(warns.some((w) => w.includes('非绝对路径'))).toBe(true);

    const empty = await makeWs({ globalStorage: memoryStorage({ [KEY]: '   ' }), log });
    expect(empty.customDefaultRoot()).toBeNull();
    expect(warns.some((w) => w.includes('无效的默认工作区设定'))).toBe(true);

    const obj = await makeWs({ globalStorage: memoryStorage({ [KEY]: { root: extraRoot } }), log });
    expect(obj.customDefaultRoot()).toBeNull();
  });

  it('读设定本身失败：按未设定继续用内置根 + 出声（不炸启动）', async () => {
    const warns: string[] = [];
    const broken = memoryStorage();
    broken.get = async () => {
      throw new Error('unreadable');
    };
    const ws = await makeWs({
      globalStorage: broken,
      log: { ...noopLog, warn: (m: string) => warns.push(m) },
    });
    expect(ws.customDefaultRoot()).toBeNull();
    expect(ws.defaultRoot()).toBe(ws.rootDir());
    expect(warns.some((w) => w.includes('读取默认工作区设定失败'))).toBe(true);
  });

  it('撤销的正是默认根：落回内置根（设定仍留着，重新授权即沿用），并出声说明接下来落在哪', async () => {
    const infos: string[] = [];
    const bridge = Object.assign(Object.create(new NodeBridge(appData, [extraRoot])) as PlatformBridge, {
      revokeWorkspaceRoot: async () => {},
    });
    const ws = await makeWs({ bridge, io: new FileIOServiceImpl(bridge), log: { ...noopLog, info: (m: string) => infos.push(m) } });
    await ws.setDefaultRoot(extraRoot);
    expect(ws.defaultRoot()).toBe(extraRoot);

    await ws.revokeRoot(extraRoot);
    expect(ws.roots()).toEqual([ws.rootDir()]);
    expect(ws.defaultRoot()).toBe(ws.rootDir()); // 不会再撞"未获得授权"
    expect(ws.customDefaultRoot()).toBe(extraRoot); // 记录没被顺手抹掉
    expect(infos.some((m) => m.includes('落回内置位置'))).toBe(true);
  });

  it('内置位置不可撤销（撤的是常驻位置，撤了作品全变只读）', async () => {
    const ws = await makeWs();
    await expect(ws.revokeRoot(ws.rootDir())).rejects.toThrow(/内置工作区不能撤销/);
  });
});
