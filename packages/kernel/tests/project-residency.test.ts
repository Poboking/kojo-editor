import { afterEach, describe, expect, it } from 'vitest';
import type { GameProject, Logger, PlatformBridge, Plugin, ProjectEvictedEvent } from '@kojo/plugin-api';
import { createKernel } from '../src/kernel';
import { MemoryStorageBackend } from './helpers/memory-storage';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 测试用最小平台桥（仅项目服务路径；与 kernel.test.ts 的桩同形） */
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
    createFileExclusive: async () => false,
    createDirExclusive: async () => false,
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
    revokeWorkspaceRoot: async () => {
      throw new Error('revokeWorkspaceRoot is not supported by this stub');
    },
    fetchText: async () => {
      throw new Error('本平台的桥没有远程取文本能力（测试桩）');
    },
    marketDownload: async () => {
      throw new Error('本平台的桥没有容器下载能力（测试桩）');
    },
    marketExtract: async () => {
      throw new Error('本平台的桥没有容器解包能力（测试桩）');
    },
    listWorkspaceRoots: async () => [],
    appDataDir: async () => 'C:\\AppData\\kojo-test',
    decode: async () => '',
    encode: async () => new Uint8Array(),
  };
}

/** 合成项目根：C:\proj-1 .. C:\proj-N，全部命中同一枚中立适配器 */
const projDir = (n: number): string => `C:\\proj-${n}`;

/** 适配器调用计数：钉「重开驻留目录走完整 detect→loadProject」（驻留档案不替代重读盘面） */
function makeMultiProjectAdapterPlugin(calls: { detect: string[]; load: string[] }): Plugin {
  const adapter = {
    gameId: 'fake-game',
    displayName: 'Fake Game',
    detect: async (rootDir: string) => {
      calls.detect.push(rootDir);
      return /^c:\\proj-\d+$/i.test(rootDir);
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

interface Recorder {
  opened: string[];
  closed: string[];
  evicted: ProjectEvictedEvent[];
  /** opened/closed/evicted 的统一时间线（钉事件次序） */
  timeline: string[];
}

function recordEvents(kernel: Awaited<ReturnType<typeof createKernel>>): Recorder {
  const rec: Recorder = { opened: [], closed: [], evicted: [], timeline: [] };
  kernel.bus.on('project.opened', (p) => {
    rec.opened.push(p.project.rootDir);
    rec.timeline.push(`opened:${p.project.rootDir}`);
  });
  kernel.bus.on('project.closed', (p) => {
    rec.closed.push(p.rootDir);
    rec.timeline.push(`closed:${p.rootDir}`);
  });
  kernel.bus.on('project.evicted', (p) => {
    rec.evicted.push(p);
    rec.timeline.push(`evicted:${p.rootDir}(${p.reason})`);
  });
  return rec;
}

async function boot(opts: { residencyCap?: number; storage?: MemoryStorageBackend } = {}) {
  const calls = { detect: [] as string[], load: [] as string[] };
  const kernel = await createKernel({
    platform: stubBridge(),
    plugins: [makeMultiProjectAdapterPlugin(calls)],
    logger: noopLogger,
    storageBackend: opts.storage ?? new MemoryStorageBackend(),
    ...(opts.residencyCap !== undefined ? { projectResidencyCap: opts.residencyCap } : {}),
  });
  await kernel.start();
  return { kernel, calls, rec: recordEvents(kernel) };
}

describe('多项目驻留 LRU（MCP-PERF-S19）', () => {
  const savedEnv = { value: undefined as string | undefined };
  afterEach(() => {
    if (savedEnv.value === undefined) delete process.env['KOJO_PROJECT_RESIDENCY_CAP'];
    else process.env['KOJO_PROJECT_RESIDENCY_CAP'] = savedEnv.value;
    delete savedEnv.value;
  });

  it('合成 4 项目、缺省上限 3：第 1 个被逐且事件可见；当前项目零影响', async () => {
    const { kernel, rec } = await boot();
    for (let i = 1; i <= 4; i++) await kernel.project.open(projDir(i));

    // 逐出事实：P1（最旧非当前）被逐，reason=lru，且只逐这一枚
    expect(rec.evicted).toEqual([
      { rootDir: projDir(1), adapterId: 'fake-game', reason: 'lru' },
    ]);
    // 当前项目零影响：current 是 P4；opened 4 次、逐字 close 3 次（每次切换照旧走完整 close）
    expect(kernel.project.current()?.rootDir).toBe(projDir(4));
    expect(rec.opened).toEqual([projDir(1), projDir(2), projDir(3), projDir(4)]);
    expect(rec.closed).toEqual([projDir(1), projDir(2), projDir(3)]);
    // 事件次序：P4 的 evicted 在 closed(P3) 之后、opened(P4) 之前——旧世界清完才宣告新世界
    expect(rec.timeline).toEqual([
      'opened:C:\\proj-1',
      'closed:C:\\proj-1',
      'opened:C:\\proj-2',
      'closed:C:\\proj-2',
      'opened:C:\\proj-3',
      'closed:C:\\proj-3',
      'evicted:C:\\proj-1(lru)',
      'opened:C:\\proj-4',
    ]);
    await kernel.stop();
  });

  it('继续开第 5 个：逐出次序最旧优先，当前项目从不在逐出名单上', async () => {
    const { kernel, rec } = await boot();
    for (let i = 1; i <= 5; i++) await kernel.project.open(projDir(i));
    expect(rec.evicted.map((e) => e.rootDir)).toEqual([projDir(1), projDir(2)]);
    expect(rec.evicted.every((e) => e.reason === 'lru')).toBe(true);
    expect(kernel.project.current()?.rootDir).toBe(projDir(5));
    expect(rec.closed).toEqual([projDir(1), projDir(2), projDir(3), projDir(4)]);
    await kernel.stop();
  });

  it('kernel 启动参数最优先：cap=1 退化为零驻留（每次切换即逐出，行为≈现行+事件痕迹）', async () => {
    process.env['KOJO_PROJECT_RESIDENCY_CAP'] = '9'; // env 再大也压不过显式启动参数
    const { kernel, rec } = await boot({ residencyCap: 1 });
    await kernel.project.open(projDir(1));
    await kernel.project.open(projDir(2));
    expect(rec.evicted.map((e) => e.rootDir)).toEqual([projDir(1)]);
    expect(kernel.project.current()?.rootDir).toBe(projDir(2));
    expect(rec.closed).toEqual([projDir(1)]);
    await kernel.stop();
  });

  it('存储域配置可调：_global project-residency-cap=1 生效（无启动参数时）', async () => {
    const storage = new MemoryStorageBackend();
    await storage.write('_global', 'project-residency-cap', JSON.stringify(1));
    const { kernel, rec } = await boot({ storage });
    await kernel.project.open(projDir(1));
    await kernel.project.open(projDir(2));
    expect(rec.evicted.map((e) => e.rootDir)).toEqual([projDir(1)]);
    expect(kernel.project.current()?.rootDir).toBe(projDir(2));
    await kernel.stop();
  });

  it('环境变量兜底：KOJO_PROJECT_RESIDENCY_CAP=1 生效（无启动参数、无存储配置时）', async () => {
    process.env['KOJO_PROJECT_RESIDENCY_CAP'] = '1';
    const { kernel, rec } = await boot();
    await kernel.project.open(projDir(1));
    await kernel.project.open(projDir(2));
    expect(rec.evicted.map((e) => e.rootDir)).toEqual([projDir(1)]);
    expect(kernel.project.current()?.rootDir).toBe(projDir(2));
    await kernel.stop();
  });

  it('优先级合成：启动参数 > 存储域 > 环境变量 > 缺省 3', async () => {
    process.env['KOJO_PROJECT_RESIDENCY_CAP'] = '9';
    const storage = new MemoryStorageBackend();
    await storage.write('_global', 'project-residency-cap', JSON.stringify(1));
    const { kernel, rec } = await boot({ storage, residencyCap: 2 });
    for (let i = 1; i <= 3; i++) await kernel.project.open(projDir(i));
    // cap=2（启动参数）：开第 3 个时逐 P1。若是存储的 1 会在开第 2 个时就逐；若是 env 的 9 则不逐。
    expect(rec.evicted.map((e) => e.rootDir)).toEqual([projDir(1)]);
    expect(rec.closed).toEqual([projDir(1), projDir(2)]);
    expect(kernel.project.current()?.rootDir).toBe(projDir(3));
    await kernel.stop();
  });

  it('非法配置值（负数/非数值）逐级回退，最终落缺省 3', async () => {
    process.env['KOJO_PROJECT_RESIDENCY_CAP'] = 'not-a-number';
    const storage = new MemoryStorageBackend();
    await storage.write('_global', 'project-residency-cap', JSON.stringify(-5));
    const { kernel, rec } = await boot({ storage });
    for (let i = 1; i <= 4; i++) await kernel.project.open(projDir(i));
    // 缺省 3：开第 4 个时逐 P1（cap=1 的存储值若生效会在第 2 个就逐）
    expect(rec.evicted.map((e) => e.rootDir)).toEqual([projDir(1)]);
    expect(kernel.project.current()?.rootDir).toBe(projDir(4));
    await kernel.stop();
  });

  it('同目录 reload：退役副本不留档（用户明确要求重读盘面），无逐出', async () => {
    const { kernel, calls, rec } = await boot();
    await kernel.project.open(projDir(1));
    await kernel.project.open(projDir(1)); // reload
    expect(rec.evicted).toEqual([]);
    expect(rec.closed).toEqual([projDir(1)]);
    expect(rec.opened).toEqual([projDir(1), projDir(1)]);
    // reload 语义逐字：detect + loadProject 都重跑（驻留不替代重读）
    expect(calls.load).toEqual([projDir(1), projDir(1)]);
    expect(calls.detect).toEqual([projDir(1), projDir(1)]);
    await kernel.stop();
  });

  it('superseded：重开已驻留目录，旧档案被新加载取代且事件出声', async () => {
    const { kernel, rec } = await boot();
    await kernel.project.open(projDir(1));
    await kernel.project.open(projDir(2)); // P1 退役入档
    await kernel.project.open(projDir(1)); // 完整重开 P1：旧档案被取代
    const superseded = rec.evicted.filter((e) => e.reason === 'superseded');
    expect(superseded).toEqual([{ rootDir: projDir(1), adapterId: 'fake-game', reason: 'superseded' }]);
    expect(kernel.project.current()?.rootDir).toBe(projDir(1));
    await kernel.stop();
  });

  it('显式 close 是销毁不是退役：不入驻留档案、也绝不产生逐出事件', async () => {
    const { kernel, rec } = await boot();
    await kernel.project.open(projDir(1));
    await kernel.project.open(projDir(2)); // P1 退役入档
    await kernel.project.close(); // 显式关 P2：销毁（现行语义逐字），P2 绝不进逐出事件
    expect(rec.evicted).toEqual([]);
    expect(rec.closed).toEqual([projDir(1), projDir(2)]);
    expect(kernel.project.current()).toBeNull();
    // 再开第 3 个：驻留 = {P1 档案} + 当前 P3 = 2 ≤ 3，无逐出
    await kernel.project.open(projDir(3));
    expect(rec.evicted).toEqual([]);
    expect(kernel.project.current()?.rootDir).toBe(projDir(3));
    await kernel.stop();
  });

  it('重开驻留目录走完整 detect→loadProject（驻留档案不替代重读盘面——适配器服务态在 loadProject 重建）', async () => {
    const { kernel, calls } = await boot();
    await kernel.project.open(projDir(1));
    await kernel.project.open(projDir(2));
    await kernel.project.open(projDir(1));
    expect(calls.detect).toEqual([projDir(1), projDir(2), projDir(1)]);
    expect(calls.load).toEqual([projDir(1), projDir(2), projDir(1)]);
    await kernel.stop();
  });
});
