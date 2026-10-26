// @vitest-environment happy-dom
/**
 * 启动器视图的渲染冒烟（L5 骨架 + L10 创建/信任/启动流）——**行为级**，不读源码形状：
 * 1. 拿不到 `launcher.service` 也要能开：一句人话 + 说清缺哪一块（宿主桥），不白屏；
 * 2. 空库：引导「从目录创建」，按钮**可用**（L10 解禁）并能开向导；
 * 3. 向导三步：选目录 → 选候选（多候选带推荐位）→ 起名 + 隔离 → 提交（请求逐字断言）；
 * 4. 零候选：明确说「这个目录不能作为实例」并逐条给原因；
 * 5. 目录对话框取消：停在原步、只有一句说明、不是错误条；
 * 6. `InstanceCreation.task` 非空：显示复制任务进度，**不是**「就绪」；
 * 7. 未信任 ⇒「信任并启动」，且 `trust` 先于 `start`（调用数组逐字断言）；
 * 8. 原生确认框取消 ⇒ 保持未信任、不调 `start`、不重试；
 * 9. 四类错误码 → 人话解释 + 下一步（码与原文照旧原样显示）；
 * 10. 读库失败：错误码原样上屏（不翻译成「出错了」）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CreateInstanceRequest,
  ExecutableTrust,
  InstanceCreation,
  InstanceInspection,
  LauncherInstance,
  LauncherService,
  LauncherTask,
  ProcessStatus,
} from '@kojo/plugin-api';
import type { Kernel } from '@kojo/kernel';
import { LauncherView } from '../src/launcher/LauncherView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------ 夹具 ------------------------------ */

function instance(overrides: Partial<LauncherInstance> = {}): LauncherInstance {
  return {
    id: 'i-1',
    name: '示例实例',
    adapterId: 'adapter-a',
    gameId: 'game-a',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    sourceRoot: 'D:/games/a',
    isolation: 'shared',
    instanceRoot: 'C:/appData/instances/i-1',
    gameRoot: 'D:/games/a',
    state: 'ready',
    executable: { relativePath: 'game.exe', args: [], env: {}, windowMode: 'auto', sha256: null },
    runtimeId: null,
    locale: { mode: 'inherit' },
    encoding: { mode: 'auto', fallback: 'utf-8' },
    saveRoots: [],
    contentRoots: [],
    executableTrust: null,
    launchCount: 0,
    lastLaunchedAt: null,
    lastExit: null,
    schemaVersion: 1,
    ...overrides,
  };
}

function trustedRecord(): ExecutableTrust {
  return {
    sha256: 'a'.repeat(64),
    size: 1024,
    approvedAt: '2026-10-01T00:00:00.000Z',
    approvedBy: 'native-dialog',
  };
}

function processStatus(overrides: Partial<ProcessStatus> = {}): ProcessStatus {
  return {
    instanceId: 'i-1',
    state: 'idle',
    pid: null,
    sessionId: null,
    startedAt: null,
    elapsedMs: 0,
    exitCode: null,
    exitReason: null,
    lastError: null,
    ...overrides,
  };
}

function inspectionOf(entry: LauncherInstance, trusted: boolean): InstanceInspection {
  return {
    instance: entry,
    executable: {
      absolutePath: `${entry.gameRoot}/${entry.executable.relativePath}`,
      exists: true,
      sha256: trusted ? 'a'.repeat(64) : null,
      trusted,
      changedSinceTrust: false,
    },
    runtime: { required: null, resolved: null },
    paths: {
      instanceRoot: entry.instanceRoot,
      gameRoot: entry.gameRoot,
      saveRoots: [],
      logDir: `${entry.instanceRoot}/logs`,
      backupDir: `${entry.instanceRoot}/backups`,
    },
    diskUsageBytes: 0,
    warnings: [],
  };
}

interface FakeOptions {
  readonly listError?: unknown;
  readonly statuses?: readonly ProcessStatus[];
  /** 详情里的信任读数（默认 true = 已确认，与 `executableTrust` 一起给） */
  readonly trusted?: boolean;
  readonly create?: (request: CreateInstanceRequest) => Promise<InstanceCreation>;
  readonly trust?: (instanceId: string) => Promise<ExecutableTrust>;
  readonly start?: (instanceId: string) => Promise<ProcessStatus>;
  readonly inspection?: (entry: LauncherInstance) => InstanceInspection;
}

interface Harness {
  readonly service: LauncherService;
  /** 依次记录的命令名（`trust` / `start` / `stop`）——用它断言调用次序 */
  readonly calls: string[];
  readonly created: CreateInstanceRequest[];
  readonly pushTask: (task: LauncherTask) => void;
}

function fakeService(instances: readonly LauncherInstance[], options: FakeOptions = {}): Harness {
  /** 创建成功后新实例真的会出现在实例库里（宿主落盘 ⇒ 下一次 list 就有它） */
  const all: LauncherInstance[] = [...instances];
  const statuses = new Map<string, ProcessStatus>(
    (options.statuses ?? instances.map((entry) => processStatus({ instanceId: entry.id }))).map(
      (status) => [status.instanceId, status],
    ),
  );
  const calls: string[] = [];
  const created: CreateInstanceRequest[] = [];
  const taskListeners = new Set<(task: LauncherTask) => void>();
  let lastTask: LauncherTask | null = null;
  const trusted = options.trusted ?? true;

  const service = {
    instances: {
      list: async () => {
        if (options.listError !== undefined) throw options.listError;
        return [...all];
      },
      get: async () => null,
      inspect: async (id: string) => {
        const entry = all.find((candidate) => candidate.id === id);
        if (entry === undefined) throw new Error(`未知实例：${id}`);
        return (options.inspection ?? ((value: LauncherInstance) => inspectionOf(value, trusted)))(
          entry,
        );
      },
      create: async (request: CreateInstanceRequest) => {
        if (options.create === undefined) throw new Error('测试壳不实现创建');
        created.push(request);
        const creation = await options.create(request);
        all.push(creation.instance);
        return creation;
      },
      update: async () => {
        throw new Error('测试壳不实现更新');
      },
      remove: async () => undefined,
      duplicate: async () => {
        throw new Error('测试壳不实现复制');
      },
      subscribe: () => () => undefined,
    },
    processes: {
      start: async (id: string) => {
        calls.push('start');
        if (options.start !== undefined) {
          const status = await options.start(id);
          statuses.set(id, status);
          return status;
        }
        const status = processStatus({ instanceId: id, state: 'running', pid: 42 });
        statuses.set(id, status);
        return status;
      },
      stop: async (id: string) => {
        calls.push('stop');
        const status = processStatus({ instanceId: id, state: 'exited', exitCode: 0, exitReason: 'user' });
        statuses.set(id, status);
        return status;
      },
      status: (id: string) => statuses.get(id) ?? processStatus({ instanceId: id }),
      list: () => [...statuses.values()],
      trust: async (id: string) => {
        calls.push('trust');
        if (options.trust !== undefined) return options.trust(id);
        return trustedRecord();
      },
      subscribe: () => () => undefined,
    },
    tasks: {
      list: () => (lastTask === null ? [] : [lastTask]),
      get: (id: string) => (lastTask !== null && lastTask.id === id ? lastTask : null),
      cancel: async () => undefined,
      subscribe: (listener: (task: LauncherTask) => void) => {
        taskListeners.add(listener);
        return () => {
          taskListeners.delete(listener);
        };
      },
    },
    initialize: async () => undefined,
  } as unknown as LauncherService;

  return {
    service,
    calls,
    created,
    pushTask: (task: LauncherTask) => {
      lastTask = task;
      for (const listener of [...taskListeners]) listener(task);
    },
  };
}

interface KernelOptions {
  readonly pickSourceRoot?: () => Promise<string | null>;
  readonly surfaces?: readonly {
    adapter: {
      gameId: string;
      displayName: string;
      launch: { probe: (root: string) => Promise<readonly unknown[]> };
    };
  }[];
}

function kernelWith(service: LauncherService, options: KernelOptions = {}): Kernel {
  return {
    services: {
      tryGet: <T,>(_key: string): T | undefined => service as unknown as T,
      get: (): never => {
        throw new Error('unused');
      },
      keys: () => [],
    },
    launcherHost: {
      pickSourceRoot: options.pickSourceRoot ?? (async () => null),
    },
    slots: { query: () => options.surfaces ?? [] },
    plugins: { list: () => [{ id: 'launcher-core', version: '0.1.0', status: 'active' }] },
  } as unknown as Kernel;
}

/** 没有服务的内核：插件表首轮为空，注册后停在 inactive（缺宿主桥）——真实 L5 的形状 */
function kernelWithoutHostBridge(): Kernel {
  let registered = false;
  return {
    services: {
      tryGet: <T,>(_key: string): T | undefined => undefined as T | undefined,
      get: (): never => {
        throw new Error('unused');
      },
      keys: () => [],
    },
    plugins: {
      list: () =>
        registered
          ? [{ id: 'launcher-core', version: '0.1.0', status: 'inactive', missing: ['kernel.launcher'] }]
          : [],
    },
    registerPlugin: async () => {
      registered = true;
    },
  } as unknown as Kernel;
}

/** 一枚带 `probe` 的启动面（只用到字段名，不认具体游戏） */
function surfaceOf(
  gameId: string,
  candidates: readonly {
    id: string;
    label: string;
    executableRelativePath: string;
    arch?: 'x64' | 'x86';
    notes?: string;
  }[],
): {
  adapter: {
    gameId: string;
    displayName: string;
    launch: { probe: (root: string) => Promise<readonly unknown[]> };
  };
} {
  return {
    adapter: {
      gameId,
      displayName: `${gameId} 游戏`,
      launch: { probe: async () => candidates },
    },
  };
}

/* ------------------------------ 挂载工具 ------------------------------ */

describe('LauncherView 渲染冒烟', () => {
  let container: HTMLElement;
  let root: Root | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
    root = undefined;
  });

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /**
   * 轮询到条件成立（异步装载 / IPC 回执都不保证一拍内到齐）。
   *
   * 判据是**墙钟预算**（10 s）而不是固定次数：满池并行时定时器被抢占，
   * 200 × 10 ms 的"2 秒"会被拉成十几秒也可能不到 200 拍就超时（2026-10-26 满池实测
   * 唯一非业务红就是这条）。预算给足，断言仍只断内容。
   */
  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    throw new Error(`等待超时（10 s）：${label}`);
  }

  async function mount(kernel: Kernel | null, onClose: () => void = () => undefined): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root!.render(h(LauncherView, { kernel, onClose }));
    });
    await waitFor(
      () => !(container.textContent ?? '').includes('正在装载启动器…'),
      '启动器离开装载态',
    );
    await settle();
  }

  function buttonByText(text: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find(
      (button) => (button.textContent ?? '').trim() === text,
    );
    if (found === undefined) throw new Error(`找不到按钮「${text}」`);
    return found;
  }

  function text(): string {
    return container.textContent ?? '';
  }

  async function click(button: HTMLButtonElement | null | undefined): Promise<void> {
    if (button === null || button === undefined) throw new Error('要点的按钮不存在');
    await act(async () => {
      button.click();
    });
    await settle();
  }

  /* ---------------------------- 基础骨架（L5） ---------------------------- */

  it('拿不到 launcher.service 也能开：人话 + 缺哪一块 + 关闭按钮可用', async () => {
    const onClose = vi.fn();
    await mount(kernelWithoutHostBridge(), onClose);

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(text()).toContain('启动器服务不可用');
    // 说清是「宿主未就绪」而不是一句「服务不可用」了事
    expect(text()).toContain('宿主未就绪');
    expect(text()).toContain('kernel.launcher');

    await act(async () => {
      const close = container.querySelector<HTMLButtonElement>('[aria-label="关闭启动器"]');
      if (close === null) throw new Error('找不到关闭按钮');
      close.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('空库：按钮解禁，点了开向导第一步；没有启动面时如实提示', async () => {
    await mount(kernelWith(fakeService([]).service));

    const create = buttonByText('从目录创建');
    expect(create.disabled).toBe(false);
    expect(text()).toContain('还没有实例');
    // 分档提示保留：没有 adapter 启动面 ≠ 宿主未就绪
    expect(text()).toContain('没有提供启动面的适配器');
    expect(text()).not.toContain('宿主未就绪');

    await click(create);
    expect(container.querySelector('.launcher-wizard')).not.toBeNull();
    expect(container.querySelector('.launcher-step[data-state="on"]')?.textContent).toContain(
      '选来源目录',
    );
    expect(text()).toContain('选择游戏目录…');
  });

  it('有实例：列表 + 详情三块只读事实；启动后停止可用', async () => {
    const older = instance({
      id: 'old',
      name: '旧实例',
      executableTrust: trustedRecord(),
      lastLaunchedAt: '2026-10-01T00:00:00.000Z',
    });
    const newer = instance({
      id: 'new',
      name: '新实例',
      isolation: 'copy',
      executableTrust: trustedRecord(),
      lastLaunchedAt: '2026-10-20T00:00:00.000Z',
    });
    await mount(
      kernelWith(
        fakeService([older, newer], {
          statuses: [processStatus({ instanceId: 'new', state: 'running' })],
        }).service,
      ),
    );

    // 排序：最近启动的在前，且首帧就选中它（详情不是空白）
    const rows = [...container.querySelectorAll('.launcher-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('新实例');
    expect(container.querySelector('.launcher-detail-name')?.textContent).toBe('新实例');

    // 详情三块（路径 / 运行时 / 信任），且标了只读
    const blocks = [...container.querySelectorAll('.launcher-block')];
    expect(blocks.map((block) => block.getAttribute('aria-label'))).toEqual(['路径', '运行时', '信任']);
    expect(text()).toContain('只读');
    expect(text()).toContain('game.exe');

    // 运行中：启动置灰、停止可点
    expect(buttonByText('启动').disabled).toBe(true);
    expect(buttonByText('停止').disabled).toBe(false);

    // 停止 → 进程回到已退出；随后启动可点（状态经命令返回值回灌）
    await click(buttonByText('停止'));
    expect(text()).toContain('已退出');
    expect(buttonByText('启动').disabled).toBe(false);
  });

  it('读库失败：错误码原样上屏 + 原文不被改写', async () => {
    await mount(
      kernelWith(
        fakeService([], {
          listError: { code: 'LAUNCHER_INTERNAL', message: '读取实例列表失败', retryable: false },
        }).service,
      ),
    );

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('读取实例库失败');
    expect(alert?.textContent).toContain('LAUNCHER_INTERNAL');
    expect(alert?.textContent).toContain('读取实例列表失败');
  });

  /* ------------------------------ 向导 ------------------------------ */

  it('向导三步：选目录 → 多候选（推荐位）→ 起名/隔离 → 提交请求逐字正确', async () => {
    const harness = fakeService([], {
      create: async (request) => ({
        instance: instance({ id: 'new-1', name: request.name, isolation: request.isolation }),
        task: null,
      }),
    });
    const kernel = kernelWith(harness.service, {
      pickSourceRoot: async () => 'D:/games/eratw',
      surfaces: [
        surfaceOf('game-a', [
          { id: 'x64', label: '主程序（x64 · 推荐）', executableRelativePath: 'Emuera_x64.exe', arch: 'x64', notes: '本机实测' },
          { id: 'x86', label: '主程序（x86）', executableRelativePath: 'Emuera_x86.exe', arch: 'x86' },
        ]),
      ],
    });
    await mount(kernel);

    await click(buttonByText('从目录创建'));
    await click(buttonByText('选择游戏目录…'));
    await waitFor(() => container.querySelectorAll('.launcher-candidate').length === 2, '候选卡片出现');

    // 推荐位只在多候选时标，且标的是 adapter 顺序第一条（契约无推荐位字段）
    const cards = [...container.querySelectorAll('.launcher-candidate')];
    expect(cards[0]?.getAttribute('data-recommended')).toBe('true');
    expect(cards[1]?.getAttribute('data-recommended')).toBe('false');
    expect(cards[0]?.textContent).toContain('Emuera_x64.exe');
    expect(text()).toContain('推荐位');

    // 未选候选时「下一步」不可点
    expect(buttonByText('下一步').disabled).toBe(true);
    await click(cards[1] as HTMLButtonElement);
    await click(buttonByText('下一步'));

    // 第三步：名字默认用游戏显示名，可改
    const nameInput = container.querySelector<HTMLInputElement>('input[aria-label="实例名"]');
    expect(nameInput?.value).toBe('game-a 游戏');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(nameInput, '主存档');
      nameInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect(text()).toContain('共享目录（默认）');
    await click(buttonByText('创建实例'));

    expect(harness.created).toHaveLength(1);
    expect(harness.created[0]).toEqual({
      name: '主存档',
      sourceRoot: 'D:/games/eratw',
      adapterId: 'game-a',
      gameId: 'game-a',
      candidateId: 'x86',
      isolation: 'shared',
    });
    // 没有复制任务 ⇒ 明确说已创建，而不是留一块空白
    expect(text()).toContain('实例已创建');
  });

  it('零候选：明确说这个目录不能作为实例，并逐条给原因', async () => {
    const harness = fakeService([]);
    await mount(
      kernelWith(harness.service, {
        pickSourceRoot: async () => 'D:/games/empty',
        surfaces: [surfaceOf('game-a', [])],
      }),
    );

    await click(buttonByText('从目录创建'));
    await click(buttonByText('选择游戏目录…'));
    await waitFor(() => (container.textContent ?? '').includes('这个目录不能作为实例'), '零候选提示');

    expect(text()).toContain('这个目录不能作为实例');
    expect(text()).toContain('一个候选都没有的目录不能作为实例');
    expect(text()).toContain('适配器在这个目录的根层没有找到它能启动的程序');
    expect(buttonByText('下一步').disabled).toBe(true);
  });

  it('目录对话框取消：停在第一步、只有一行说明、不弹错误条', async () => {
    const harness = fakeService([]);
    await mount(kernelWith(harness.service, { pickSourceRoot: async () => null }));

    await click(buttonByText('从目录创建'));
    await click(buttonByText('选择游戏目录…'));

    expect(text()).toContain('已取消选择目录');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // 仍在第一步：没有候选列表，step 指示器还停在「选来源目录」
    expect(container.querySelector('.launcher-candidate')).toBeNull();
    expect(container.querySelector('.launcher-step[data-state="on"]')?.textContent).toContain(
      '选来源目录',
    );
    expect(buttonByText('选择游戏目录…').disabled).toBe(false);
  });

  it('后退：候选步回来源步会清掉候选，再选目录重来', async () => {
    const harness = fakeService([]);
    let picks = 0;
    await mount(
      kernelWith(harness.service, {
        pickSourceRoot: async () => {
          picks += 1;
          return picks === 1 ? 'D:/games/a' : 'D:/games/b';
        },
        surfaces: [
          surfaceOf('game-a', [
            { id: 'only', label: '唯一候选', executableRelativePath: 'game.exe' },
          ]),
        ],
      }),
    );

    await click(buttonByText('从目录创建'));
    await click(buttonByText('选择游戏目录…'));
    await waitFor(() => container.querySelectorAll('.launcher-candidate').length === 1, '候选出现');
    // 唯一候选不标推荐位（把「唯一」叫推荐是噪声）
    expect(container.querySelector('.launcher-candidate')?.getAttribute('data-recommended')).toBe(
      'false',
    );

    await click(buttonByText('上一步'));
    expect(container.querySelector('.launcher-step[data-state="on"]')?.textContent).toContain(
      '选来源目录',
    );
    expect(container.querySelector('.launcher-candidate')).toBeNull();

    await click(buttonByText('选择游戏目录…'));
    await waitFor(() => (container.textContent ?? '').includes('D:/games/b'), '第二个目录');
    expect(text()).toContain('来源目录：D:/games/b');
  });

  it('copy 档：勾选存档才随请求下发，共享档不带 includeSaves', async () => {
    const harness = fakeService([], {
      create: async (request) => ({
        instance: instance({ id: 'new-copy', name: request.name, isolation: request.isolation }),
        task: null,
      }),
    });
    await mount(
      kernelWith(harness.service, {
        pickSourceRoot: async () => 'D:/games/a',
        surfaces: [
          surfaceOf('game-a', [{ id: 'only', label: '唯一候选', executableRelativePath: 'game.exe' }]),
        ],
      }),
    );

    await click(buttonByText('从目录创建'));
    await click(buttonByText('选择游戏目录…'));
    await waitFor(() => container.querySelectorAll('.launcher-candidate').length === 1, '候选出现');
    await click(container.querySelector('.launcher-candidate') as HTMLButtonElement);
    await click(buttonByText('下一步'));

    const copyRadio = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1];
    await act(async () => {
      copyRadio?.click();
    });
    await settle();
    expect(text()).toContain('可能数百 MB 到数 GB');

    const includeSaves = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(includeSaves?.disabled).toBe(false);
    await act(async () => {
      includeSaves?.click();
    });
    await settle();
    await click(buttonByText('创建实例'));

    expect(harness.created[0]).toMatchObject({ isolation: 'copy', includeSaves: true });
  });

  it('复制任务非空：显示任务进度而不是「就绪」', async () => {
    const task: LauncherTask = {
      id: 'task-1',
      kind: 'instance-copy',
      instanceId: 'new-copy',
      state: 'running',
      progress: { done: 512 * 1024 * 1024, total: 2 * 1024 * 1024 * 1024, unit: 'bytes', message: '正在复制 resources/' },
      createdAt: '2026-10-26T00:00:00.000Z',
      startedAt: '2026-10-26T00:00:01.000Z',
      endedAt: null,
      error: null,
      result: null,
      cancellable: true,
    };
    const harness = fakeService([], {
      create: async (request) => ({
        instance: instance({
          id: 'new-copy',
          name: request.name,
          isolation: 'copy',
          state: 'preparing',
        }),
        task,
      }),
    });
    await mount(
      kernelWith(harness.service, {
        pickSourceRoot: async () => 'D:/games/a',
        surfaces: [
          surfaceOf('game-a', [{ id: 'only', label: '唯一候选', executableRelativePath: 'game.exe' }]),
        ],
      }),
    );

    await click(buttonByText('从目录创建'));
    await click(buttonByText('选择游戏目录…'));
    await waitFor(() => container.querySelectorAll('.launcher-candidate').length === 1, '候选出现');
    await click(container.querySelector('.launcher-candidate') as HTMLButtonElement);
    await click(buttonByText('下一步'));
    await click(buttonByText('创建实例'));

    expect(text()).toContain('正在复制实例目录…');
    expect(text()).toContain('512.0 MB / 2.00 GB');
    expect(text()).toContain('25%');
    expect(text()).toContain('准备中');
    expect(container.querySelector('progress')).not.toBeNull();
    // 准备中不能启动：按钮禁用（而不是假装 ready）
    expect(buttonByText('启动').disabled).toBe(true);

    // 任务走完：面板改口「完成」，实例库刷新
    await act(async () => {
      harness.pushTask({ ...task, state: 'succeeded', progress: { ...task.progress!, done: task.progress!.total } });
    });
    await settle();
    expect(text()).toContain('复制实例目录完成');
  });

  /* ------------------------------ 信任流 ------------------------------ */

  it('未信任 ⇒「信任并启动」，且 trust 先于 start', async () => {
    const harness = fakeService([instance({ executableTrust: null })], { trusted: false });
    await mount(
      kernelWith(harness.service, {
        surfaces: [surfaceOf('game-a', [])],
      }),
    );

    expect(text()).toContain('首次启动前需要确认目标程序');
    const launch = buttonByText('信任并启动');
    expect(launch.disabled).toBe(false);

    await click(launch);
    expect(harness.calls).toEqual(['trust', 'start']);
    expect(container.querySelector('.launcher-trust-note')).toBeNull();
    expect(text()).toContain('运行中');
  });

  it('已信任 ⇒ 只是「启动」，不走确认框', async () => {
    const harness = fakeService([instance({ executableTrust: trustedRecord() })], { trusted: true });
    await mount(kernelWith(harness.service, { surfaces: [surfaceOf('game-a', [])] }));

    expect(text()).toContain('可以启动。');
    await click(buttonByText('启动'));
    expect(harness.calls).toEqual(['start']);
  });

  it('原生确认框取消：保持未信任、不调 start、只有一行说明', async () => {
    const harness = fakeService([instance({ executableTrust: null })], {
      trusted: false,
      trust: async () => {
        throw { code: 'LAUNCHER_TRUST_CANCELLED', message: '用户取消了确认', retryable: false };
      },
    });
    await mount(kernelWith(harness.service, { surfaces: [surfaceOf('game-a', [])] }));

    await click(buttonByText('信任并启动'));

    expect(harness.calls).toEqual(['trust']);
    expect(text()).toContain('已取消系统确认框');
    expect(text()).toContain('不会自动重试');
    // 仍是未信任态：按钮文案没变，也没有错误条
    expect(buttonByText('信任并启动')).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  /* ------------------------------ 错误面 ------------------------------ */

  it('LAUNCHER_TRUST_CHANGED：错误条给「为什么 + 下一步」，码与原文不改写', async () => {
    const harness = fakeService([instance({ executableTrust: trustedRecord() })], {
      trusted: true,
      start: async () => {
        throw {
          code: 'LAUNCHER_TRUST_CHANGED',
          message: '目标程序在确认之后被修改',
          detail: 'sha256 不匹配',
          retryable: false,
        };
      },
    });
    await mount(kernelWith(harness.service, { surfaces: [surfaceOf('game-a', [])] }));

    await click(buttonByText('启动'));
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('LAUNCHER_TRUST_CHANGED');
    expect(alert?.textContent).toContain('启动失败');
    expect(alert?.textContent).toContain('目标程序在确认之后被修改');
    expect(alert?.textContent).toContain('目标程序在确认之后被改动过');
    expect(alert?.textContent).toContain('重新走一次系统确认框');
    expect(alert?.textContent).toContain('sha256 不匹配');
  });

  it('LAUNCHER_EXECUTABLE_INVALID：错误条点明「目标程序不在位」之外的那条规则', async () => {
    const harness = fakeService([instance({ executableTrust: trustedRecord() })], {
      trusted: true,
      start: async () => {
        throw {
          code: 'LAUNCHER_EXECUTABLE_INVALID',
          message: '目标程序不合法',
          retryable: false,
        };
      },
    });
    await mount(kernelWith(harness.service, { surfaces: [surfaceOf('game-a', [])] }));

    await click(buttonByText('启动'));
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('启动目标不合法');
    expect(alert?.textContent).toContain('相对路径');
    expect(alert?.textContent).toContain('LAUNCHER_EXECUTABLE_INVALID');
  });

  it('LAUNCHER_INSTANCE_BUSY：告诉用户等哪个状态', async () => {
    const harness = fakeService([instance({ executableTrust: trustedRecord() })], {
      trusted: true,
      start: async () => {
        throw {
          code: 'LAUNCHER_INSTANCE_BUSY',
          message: '该实例正在启动或停止',
          retryable: true,
        };
      },
    });
    await mount(kernelWith(harness.service, { surfaces: [surfaceOf('game-a', [])] }));

    await click(buttonByText('启动'));
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('这个实例正忙');
    expect(alert?.textContent).toContain('等状态点变成「运行中」或「未运行」再操作');
    expect(alert?.textContent).toContain('按上面的建议处理后可以重试');
  });

  it('LAUNCHER_PLATFORM_UNSUPPORTED：说清是哪一类能力没接', async () => {
    const harness = fakeService([instance({ executableTrust: trustedRecord() })], {
      trusted: true,
      start: async () => {
        throw {
          code: 'LAUNCHER_PLATFORM_UNSUPPORTED',
          message: '当前平台没有启动器能力',
          retryable: false,
        };
      },
    });
    await mount(kernelWith(harness.service, { surfaces: [surfaceOf('game-a', [])] }));

    await click(buttonByText('启动'));
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('这一版还没有这条宿主能力');
    expect(alert?.textContent).toContain('当前平台没有启动器能力');
  });
});
