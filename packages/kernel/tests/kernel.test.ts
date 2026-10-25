import { describe, expect, it } from 'vitest';
import type { GameProject, Logger, Plugin } from '@kojo/plugin-api';
import { AdapterConflictError, ProjectDetectionError } from '@kojo/plugin-api';
import { createKernel } from '../src/kernel';
import { MemoryStorageBackend } from './helpers/memory-storage';
import type { PlatformBridge } from '@kojo/plugin-api';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 测试用最小平台桥（仅项目服务路径用到 stat/exists 之外的极少面） */
function stubBridge(): PlatformBridge {
  return {
    readFileBytes: async () => new Uint8Array(),
    readFilesRaw: async (paths) =>
      paths.map((path) => ({
        path,
        status: 'not-found' as const,
        mtimeMs: null,
        size: null,
        data: new Uint8Array(),
      })),
    statFiles: async (paths) => paths.map((path) => ({ path, exists: false, mtimeMs: null, size: null })),
    writeFileBytes: async () => {},
    ensureDir: async () => {},
    listDir: async () => [],
    walkDir: async () => [],
    exists: async () => false,
    stat: async () => null,
    rename: async () => {},
    copyFile: async () => {},
    removeFile: async () => {},
    removeDir: async () => {},
    watchDirs: async () => () => {},
    chooseDirectory: async () => null,
    exportFile: async () => {
      throw new Error('exportFile is not supported by this stub');
    },
    chooseWorkspaceRoot: async () => {
      throw new Error('chooseWorkspaceRoot is not supported by this stub');
    },
    fetchText: async () => {
      throw new Error('本平台的桥没有远程取文本能力（测试桩）');
    },
    marketDownload: async () => {
      throw new Error('本平台的桥没有容器下载能力（测试桩）');
    },
    marketExtract: async () => {
      throw new Error('本平台的桥没有容器解压能力（测试桩）');
    },
    listWorkspaceRoots: async () => [],
    appDataDir: async () => 'C:\\AppData\\kojo-test',
    decode: async () => '',
    encode: async () => new Uint8Array(),
  };
}

/**
 * 测试用「中立适配器」：模拟一个非具体游戏的适配器插件。
 * 适配器插件的必要职责 = 注册 `game.adapter` 槽位（供内核 onboarding 轮询）；
 * 提供服务键是可选的（服务键命名由生态约定，内核不强制）。
 */
function makeFakeAdapterPlugin(calls: { detect: string[]; load: string[] }): Plugin {
  const adapter = {
    gameId: 'fake-game',
    displayName: 'Fake Game',
    detect: async (rootDir: string) => {
      calls.detect.push(rootDir);
      return rootDir.toLowerCase().includes('valid-root');
    },
    loadProject: async (rootDir: string): Promise<GameProject> => {
      calls.load.push(rootDir);
      return {
        rootDir,
        adapterId: 'fake-game',
        kojoPaths: [`${rootDir}\\ERB\\kojo`],
        writablePaths: [`${rootDir}\\ERB\\kojo`],
        charaIndex: new Map([[1, { no: 1, name: 'Test' }]]),
      };
    },
  };
  return {
    id: 'fake-adapter',
    version: '1.0.0',
    activate(ctx) {
      ctx.slots.register('game.adapter', { id: 'fake-game-adapter', adapter });
    },
  };
}

async function bootKernel(plugins: Plugin[], backend = new MemoryStorageBackend()) {
  const kernel = await createKernel({
    platform: stubBridge(),
    plugins,
    logger: noopLogger,
    storageBackend: backend,
  });
  await kernel.start();
  return kernel;
}

describe('Kernel 组装级', () => {
  it('start 后插件全部激活，内核服务可注入', async () => {
    const observed: string[] = [];
    const consumer: Plugin = {
      id: 'consumer',
      version: '1.0.0',
      requires: ['kernel.bus', 'kernel.io', 'kernel.storage', 'kernel.project'],
      activate(ctx) {
        expect(ctx.inject('kernel.bus')).toBeTruthy();
        expect(ctx.inject('kernel.io')).toBeTruthy();
        expect(ctx.inject('kernel.storage')).toBeTruthy();
        observed.push('ok');
      },
    };
    const kernel = await bootKernel([consumer]);
    expect(observed).toEqual(['ok']);
    const states = kernel.plugins.list();
    expect(states.find((s) => s.id === 'consumer')?.status).toBe('active');
    await kernel.stop();
  });

  it('project.open：轮询 adapter detect → loadProject → project.opened 事件', async () => {
    const calls = { detect: [] as string[], load: [] as string[] };
    const events: string[] = [];
    const kernel = await bootKernel([makeFakeAdapterPlugin(calls)]);
    kernel.bus.on('project.opened', (p) => events.push(p.project.adapterId));

    const project = await kernel.project.open('C:\\valid-root\\game');
    expect(project.adapterId).toBe('fake-game');
    expect(project.charaIndex.get(1)?.name).toBe('Test');
    expect(events).toEqual(['fake-game']);
    expect(calls.detect.length).toBe(1);
    expect(calls.load.length).toBe(1);
    expect(kernel.project.current()?.rootDir).toBe('C:\\valid-root\\game');
    await kernel.stop();
  });

  it('无适配器命中 → ProjectDetectionError（含候选清单）', async () => {
    const calls = { detect: [] as string[], load: [] as string[] };
    const kernel = await bootKernel([makeFakeAdapterPlugin(calls)]);
    await expect(kernel.project.open('C:\\bogus')).rejects.toThrow(ProjectDetectionError);
    await kernel.stop();
  });

  it('close：广播 project.closed 并收回写权限', async () => {
    const calls = { detect: [] as string[], load: [] as string[] };
    const kernel = await bootKernel([makeFakeAdapterPlugin(calls)]);
    const project = await kernel.project.open('C:\\valid-root\\game');
    await kernel.project.approveWritablePaths(project, project.writablePaths);
    expect(kernel.io.isWritable(project.writablePaths[0]!)).toBe(true);

    const closed: string[] = [];
    kernel.bus.on('project.closed', (p) => closed.push(p.rootDir));
    await kernel.project.close();
    expect(closed).toEqual(['C:\\valid-root\\game']);
    expect(kernel.io.isWritable(project.writablePaths[0]!)).toBe(false);
    expect(kernel.project.current()).toBeNull();
    await kernel.stop();
  });

  it('写权限批准跨会话持久化：重开同一目录自动恢复', async () => {
    const calls = { detect: [] as string[], load: [] as string[] };
    const backend = new MemoryStorageBackend();

    const kernel1 = await bootKernel([makeFakeAdapterPlugin(calls)], backend);
    const p1 = await kernel1.project.open('C:\\valid-root\\game');
    await kernel1.project.approveWritablePaths(p1, p1.writablePaths);
    await kernel1.stop();

    // 模拟重启：同一存储后端、新内核实例
    const kernel2 = await bootKernel([makeFakeAdapterPlugin(calls)], backend);
    const p2 = await kernel2.project.open('C:\\valid-root\\game');
    expect(kernel2.io.isWritable(p2.writablePaths[0]!)).toBe(true);
    // 大小写不同（Windows 路径）也应命中同一批准记录
    await kernel2.project.close();
    const p3 = await kernel2.project.open('C:\\VALID-ROOT\\GAME');
    expect(kernel2.io.isWritable(p3.writablePaths[0]!)).toBe(true);
    await kernel2.stop();
  });

  it('approveWritablePaths 拒绝超出适配器提议的路径（UI 不可越权扩权）', async () => {
    const calls = { detect: [] as string[], load: [] as string[] };
    const kernel = await bootKernel([makeFakeAdapterPlugin(calls)]);
    const project = await kernel.project.open('C:\\valid-root\\game');
    await expect(kernel.project.approveWritablePaths(project, ['C:\\Windows'])).rejects.toThrow(
      /not part of the adapter's proposed writable paths/,
    );
    await kernel.stop();
  });

  it('批准记录与适配器新提议不一致：不自动放行 + 广播 writableApprovalMismatch（重批准后恢复）', async () => {
    const backend = new MemoryStorageBackend();

    // 首次打开 + 批准 → 持久化到共享存储后端
    const kernel1 = await bootKernel([makeFakeAdapterPlugin({ detect: [], load: [] })], backend);
    const p1 = await kernel1.project.open('C:\\valid-root\\game');
    await kernel1.project.approveWritablePaths(p1, p1.writablePaths);
    await kernel1.stop();

    // 适配器提议变化（游戏更新场景）：writablePaths 多出一项 → 旧批准不再匹配
    const changedAdapter: Plugin = {
      id: 'fake-adapter',
      version: '1.0.0',
      activate(ctx) {
        ctx.slots.register('game.adapter', {
          id: 'fake-game-adapter',
          adapter: {
            gameId: 'fake-game',
            displayName: 'Fake Game',
            detect: async () => true,
            loadProject: async (rootDir: string): Promise<GameProject> => ({
              rootDir,
              adapterId: 'fake-game',
              kojoPaths: [`${rootDir}\\ERB\\kojo`],
              writablePaths: [`${rootDir}\\ERB\\kojo`, `${rootDir}\\ERB\\kojo\\added`],
              charaIndex: new Map(),
            }),
          },
        });
      },
    };

    const kernel2 = await bootKernel([changedAdapter], backend);
    const mismatches: string[] = [];
    kernel2.bus.on('project.writableApprovalMismatch', (ev) => mismatches.push(ev.rootDir));

    const p2 = await kernel2.project.open('C:\\valid-root\\game');
    // 不一致 → 不自动放行（连旧批准内的路径也不放行）+ 恰好一次事件通知宿主重确认
    expect(kernel2.io.isWritable(p2.writablePaths[0]!)).toBe(false);
    expect(mismatches).toEqual(['C:\\valid-root\\game']);

    // 用户重新批准后恢复可写
    await kernel2.project.approveWritablePaths(p2, p2.writablePaths);
    expect(kernel2.io.isWritable(p2.writablePaths[0]!)).toBe(true);
    await kernel2.stop();

    // 重批准后再次重开：记录与新提议一致 → 自动放行、不再发事件
    const kernel3 = await bootKernel([changedAdapter], backend);
    const mismatches3: string[] = [];
    kernel3.bus.on('project.writableApprovalMismatch', (ev) => mismatches3.push(ev.rootDir));
    const p3 = await kernel3.project.open('C:\\valid-root\\game');
    expect(kernel3.io.isWritable(p3.writablePaths[0]!)).toBe(true);
    expect(mismatches3).toEqual([]);
    await kernel3.stop();
  });

  it('多适配器命中：抛 AdapterConflictError（不取舍、不 loadProject）', async () => {
    const calls1 = { detect: [] as string[], load: [] as string[] };
    const calls2 = { detect: [] as string[], load: [] as string[] };
    const errors: string[] = [];
    const logger: Logger = { ...noopLogger, error: (m) => errors.push(m) };

    const p1 = makeFakeAdapterPlugin(calls1);
    const p2: Plugin = {
      id: 'fake-adapter-2',
      version: '1.0.0',
      activate(ctx) {
        const adapter = {
          gameId: 'fake-game-2',
          displayName: 'Fake Game 2',
          detect: async () => {
            calls2.detect.push('x');
            return { matched: true, evidence: ['second marker'] };
          },
          loadProject: async (rootDir: string): Promise<GameProject> => ({
            rootDir,
            adapterId: 'fake-game-2',
            kojoPaths: [],
            writablePaths: [],
            charaIndex: new Map(),
          }),
        };
        ctx.slots.register('game.adapter', { id: 'fake-game-2-adapter', order: 10, adapter });
      },
    };

    const kernel = await createKernel({
      platform: stubBridge(),
      plugins: [p1, p2],
      logger,
      storageBackend: new MemoryStorageBackend(),
    });
    await kernel.start();

    const err = await kernel.project.open('C:\\valid-root\\game').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterConflictError);
    const conflict = err as AdapterConflictError;
    expect(conflict.candidates.map((c) => c.adapterId)).toEqual(['fake-game', 'fake-game-2']);
    expect(conflict.candidates[1]?.evidence).toEqual(['second marker']);
    expect(conflict.message).toContain('fake-game-2 [second marker]');
    // 冲突在 loadProject 之前就停下：任何一方都不该有副作用
    expect(calls1.load).toEqual([]);
    expect(calls2.load).toEqual([]);
    expect(errors.some((m) => m.includes('Adapter conflict'))).toBe(true);
    await kernel.stop();
  });

  it('adapter 返回的 project.adapterId 与 gameId 不一致 → 打开失败（不静默错位）', async () => {
    const plugin: Plugin = {
      id: 'fake-adapter-mismatch',
      version: '1.0.0',
      activate(ctx) {
        ctx.slots.register('game.adapter', {
          id: 'fake-game-mismatch-adapter',
          adapter: {
            gameId: 'fake-game',
            displayName: 'Fake Game',
            detect: async () => true,
            loadProject: async (rootDir: string): Promise<GameProject> => ({
              rootDir,
              adapterId: 'someone-else',
              kojoPaths: [],
              writablePaths: [],
              charaIndex: new Map(),
            }),
          },
        });
      },
    };
    const kernel = await bootKernel([plugin]);
    await expect(kernel.project.open('C:\\valid-root\\game')).rejects.toThrow(
      /adapterId must equal gameId/,
    );
    await kernel.stop();
  });
});

describe('Kernel 最近项目列表 removeRecent', () => {
  it('移除中间一条：其余条目顺序与内容逐字不动', async () => {
    const kernel = await bootKernel([makeFakeAdapterPlugin({ detect: [], load: [] })]);
    await kernel.project.open('C:\\valid-root\\aaa');
    await kernel.project.open('C:\\valid-root\\bbb');
    await kernel.project.open('C:\\valid-root\\ccc');
    const before = await kernel.project.recent();
    expect(before.map((r) => r.rootDir)).toEqual([
      'C:\\valid-root\\ccc',
      'C:\\valid-root\\bbb',
      'C:\\valid-root\\aaa',
    ]);

    await kernel.project.removeRecent('C:\\valid-root\\bbb');
    const after = await kernel.project.recent();
    expect(after.map((r) => r.rootDir)).toEqual(['C:\\valid-root\\ccc', 'C:\\valid-root\\aaa']);
    // 逐字比对：除被移除条目外，其余对象（adapterId / lastOpenedAt）零变化
    expect(after).toEqual([before[0]!, before[2]!]);
    await kernel.stop();
  });

  it('移除不存在的路径：幂等 no-op，不抛错且列表不动', async () => {
    const kernel = await bootKernel([makeFakeAdapterPlugin({ detect: [], load: [] })]);
    await kernel.project.open('C:\\valid-root\\game');
    const before = await kernel.project.recent();
    await expect(kernel.project.removeRecent('C:\\nowhere')).resolves.toBeUndefined();
    expect(await kernel.project.recent()).toEqual(before);
    await kernel.stop();
  });

  it('移除最后一条后 recent() 读数为空', async () => {
    const kernel = await bootKernel([makeFakeAdapterPlugin({ detect: [], load: [] })]);
    await kernel.project.open('C:\\valid-root\\game');
    await kernel.project.removeRecent('C:\\valid-root\\game');
    expect(await kernel.project.recent()).toEqual([]);
    await kernel.stop();
  });

  it('大小写 / 分隔符差异路径也能移除（Windows 判等走 pathKey）', async () => {
    const kernel = await bootKernel([makeFakeAdapterPlugin({ detect: [], load: [] })]);
    await kernel.project.open('C:\\valid-root\\game');
    await kernel.project.removeRecent('c:/VALID-ROOT/GAME');
    expect(await kernel.project.recent()).toEqual([]);
    await kernel.stop();
  });
});
