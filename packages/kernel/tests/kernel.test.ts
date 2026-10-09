import { describe, expect, it } from 'vitest';
import type { GameProject, Logger, Plugin } from '@kojo/plugin-api';
import { ProjectDetectionError } from '@kojo/plugin-api';
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
    writeFileBytes: async () => {},
    ensureDir: async () => {},
    listDir: async () => [],
    walkDir: async () => [],
    exists: async () => false,
    stat: async () => null,
    rename: async () => {},
    copyFile: async () => {},
    removeFile: async () => {},
    watchDirs: async () => () => {},
    chooseDirectory: async () => null,
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

  it('多适配器命中：取 order 最小者并告警（不静默）', async () => {
    const calls1 = { detect: [] as string[], load: [] as string[] };
    const calls2 = { detect: [] as string[], load: [] as string[] };
    const warnings: string[] = [];
    const logger: Logger = { ...noopLogger, warn: (m) => warnings.push(m) };

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
            return true;
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
    const project = await kernel.project.open('C:\\valid-root\\game');
    expect(project.adapterId).toBe('fake-game'); // order 缺省 0 < 10
    expect(warnings.some((w) => w.includes('Multiple adapters matched'))).toBe(true);
    await kernel.stop();
  });
});
