// @vitest-environment happy-dom
/**
 * 启动器视图的渲染冒烟（L5）——**行为级**，不读源码形状：
 * 1. 拿不到 `launcher.service` 也要能开：一句人话 + 说清缺哪一块（宿主桥），不白屏；
 * 2. 空库：引导「从目录创建」，按钮**禁用**并写明「宿主未就绪」；
 * 3. 有实例：列表 + 详情三块只读事实齐；启动按钮把状态推到运行中、停止随之可用；
 * 4. 读库失败：错误码原样上屏（不翻译成「出错了」）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InstanceInspection, LauncherInstance, LauncherService, ProcessStatus } from '@kojo/plugin-api';
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

function inspectionOf(entry: LauncherInstance): InstanceInspection {
  return {
    instance: entry,
    executable: {
      absolutePath: `${entry.gameRoot}/${entry.executable.relativePath}`,
      exists: true,
      sha256: null,
      trusted: false,
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
}

function fakeService(instances: readonly LauncherInstance[], options: FakeOptions = {}): LauncherService {
  const statuses = new Map<string, ProcessStatus>(
    (options.statuses ?? instances.map((entry) => processStatus({ instanceId: entry.id }))).map((status) => [
      status.instanceId,
      status,
    ]),
  );
  return {
    instances: {
      list: async () => {
        if (options.listError !== undefined) throw options.listError;
        return instances;
      },
      get: async () => null,
      inspect: async (id: string) => {
        const entry = instances.find((candidate) => candidate.id === id);
        if (entry === undefined) throw new Error(`未知实例：${id}`);
        return inspectionOf(entry);
      },
      create: async () => {
        throw new Error('测试壳不实现创建');
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
        const status = processStatus({ instanceId: id, state: 'running', pid: 42 });
        statuses.set(id, status);
        return status;
      },
      stop: async (id: string) => {
        const status = processStatus({ instanceId: id, state: 'exited', exitCode: 0, exitReason: 'user' });
        statuses.set(id, status);
        return status;
      },
      status: (id: string) => statuses.get(id) ?? processStatus({ instanceId: id }),
      list: () => [...statuses.values()],
      trust: async () => {
        throw new Error('测试壳不实现信任');
      },
      subscribe: () => () => undefined,
    },
    initialize: async () => undefined,
  } as unknown as LauncherService;
}

/** 有服务的内核（服务已在表里 ⇒ 视图不会去跑组合根装载） */
function kernelWith(service: LauncherService): Kernel {
  return {
    services: {
      tryGet: <T,>(_key: string): T | undefined => service as unknown as T,
      get: (): never => {
        throw new Error('unused');
      },
      keys: () => [],
    },
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

  it('拿不到 launcher.service 也能开：人话 + 缺哪一块 + 关闭按钮可用', async () => {
    const onClose = vi.fn();
    await mount(kernelWithoutHostBridge(), onClose);

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(container.textContent).toContain('启动器服务不可用');
    // 说清是「宿主未就绪」而不是一句「服务不可用」了事
    expect(container.textContent).toContain('宿主未就绪');
    expect(container.textContent).toContain('kernel.launcher');

    await act(async () => {
      const close = container.querySelector<HTMLButtonElement>('[aria-label="关闭启动器"]');
      if (close === null) throw new Error('找不到关闭按钮');
      close.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('空库：引导从目录创建，按钮禁用且写明宿主未就绪', async () => {
    await mount(kernelWith(fakeService([])));

    const create = buttonByText('从目录创建');
    expect(create.disabled).toBe(true);
    expect(create.title).toContain('宿主未就绪');
    expect(container.textContent).toContain('还没有实例');
    expect(container.textContent).toContain('宿主未就绪');
  });

  it('有实例：列表 + 详情三块只读事实；启动后停止可用', async () => {
    const older = instance({ id: 'old', name: '旧实例', lastLaunchedAt: '2026-10-01T00:00:00.000Z' });
    const newer = instance({
      id: 'new',
      name: '新实例',
      isolation: 'copy',
      lastLaunchedAt: '2026-10-20T00:00:00.000Z',
    });
    await mount(kernelWith(fakeService([older, newer], { statuses: [processStatus({ instanceId: 'new', state: 'running' })] })));

    // 排序：最近启动的在前，且首帧就选中它（详情不是空白）
    const rows = [...container.querySelectorAll('.launcher-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('新实例');
    expect(container.querySelector('.launcher-detail-name')?.textContent).toBe('新实例');

    // 详情三块（路径 / 运行时 / 信任），且标了只读
    const blocks = [...container.querySelectorAll('.launcher-block')];
    expect(blocks.map((block) => block.getAttribute('aria-label'))).toEqual(['路径', '运行时', '信任']);
    expect(container.textContent).toContain('只读');
    expect(container.textContent).toContain('game.exe');

    // 运行中：启动置灰、停止可点
    expect(buttonByText('启动').disabled).toBe(true);
    expect(buttonByText('停止').disabled).toBe(false);

    // 停止 → 进程回到已退出；随后启动可点（状态经命令返回值回灌）
    await act(async () => {
      buttonByText('停止').click();
    });
    await settle();
    expect(buttonByText('启动').disabled).toBe(false);
    expect(container.textContent).toContain('已退出');
  });

  it('读库失败：错误码原样上屏 + 原文不被改写', async () => {
    await mount(
      kernelWith(
        fakeService([], {
          listError: {
            code: 'LAUNCHER_INTERNAL',
            message: '读取实例列表失败',
            retryable: false,
          },
        }),
      ),
    );

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('读取实例库失败');
    expect(alert?.textContent).toContain('LAUNCHER_INTERNAL');
    expect(alert?.textContent).toContain('读取实例列表失败');
  });
});
