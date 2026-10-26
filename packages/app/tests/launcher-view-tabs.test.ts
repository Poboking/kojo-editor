// @vitest-environment happy-dom
/**
 * 详情分区接线（组长批：UI-CONTENT / UI-SAVES 两块面板挂进 `LauncherView`）。
 *
 * 断的是**接线行为**，不是面板内部（面板自己的模型与渲染各有专测）：
 * 1. 默认落在「概览」：三块只读事实在屏上，两块面板**没被挂载**（`content.list` /
 *    `saves.list` 一次都没调）——挂载即取数，默认屏不该白打两轮 IPC；
 * 2. 点「内容包」：面板挂上、`content.list` 收到的是**当前实例 id**；`host.pickArchive`
 *    被接线成「选择安装包…」的入口（点了就调到宿主，返回值原样回给面板）；
 * 3. 点「存档」：面板挂上、`saves.list` / `saves.backups` 收到当前实例 id；
 *    导出按钮走 `service.saves.exportArchive(instanceId, {})`，回执路径原样上屏；
 * 4. 宿主没有 `pickArchive`：两块面板照旧能开，但安装 / 导入按钮**禁用**并写明
 *    「宿主未提供选择器」——不假装能选。
 * 5. 「游戏插件」（UI-PLUGINS 车道）：第 4 个分区能开、`plugins.list` 收到当前实例 id；
 *    默认屏同样不挂载它（零插件 IPC）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  InstanceInspection,
  LauncherInstance,
  LauncherService,
  ProcessStatus,
  SaveExportRequest,
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

function processStatus(entry: LauncherInstance): ProcessStatus {
  return {
    instanceId: entry.id,
    state: 'idle',
    pid: null,
    sessionId: null,
    startedAt: null,
    elapsedMs: 0,
    exitCode: null,
    exitReason: null,
    lastError: null,
  };
}

function inspectionOf(entry: LauncherInstance): InstanceInspection {
  return {
    instance: entry,
    executable: {
      absolutePath: `${entry.gameRoot}/${entry.executable.relativePath}`,
      exists: true,
      sha256: 'a'.repeat(64),
      trusted: true,
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

interface Recorded {
  readonly contentList: string[];
  readonly savesList: string[];
  readonly savesBackups: string[];
  readonly exports: { readonly instanceId: string; readonly request: SaveExportRequest }[];
  picks: number;
}

function fakeService(entry: LauncherInstance): { service: LauncherService; recorded: Recorded } {
  const recorded: Recorded = {
    contentList: [],
    savesList: [],
    savesBackups: [],
    exports: [],
    picks: 0,
  };
  const status = processStatus(entry);
  const service = {
    instances: {
      list: async () => [entry],
      get: async () => entry,
      inspect: async () => inspectionOf(entry),
      create: async () => {
        throw new Error('本测不创建实例');
      },
      update: async () => {
        throw new Error('本测不更新实例');
      },
      remove: async () => undefined,
      duplicate: async () => {
        throw new Error('本测不复制实例');
      },
      subscribe: () => () => undefined,
    },
    processes: {
      start: async () => status,
      stop: async () => status,
      status: () => status,
      list: () => [status],
      trust: async () => {
        throw new Error('本测不信任程序');
      },
      subscribe: () => () => undefined,
    },
    tasks: {
      list: () => [],
      get: () => null,
      cancel: async () => undefined,
      subscribe: () => () => undefined,
    },
    content: {
      list: async (instanceId: string) => {
        recorded.contentList.push(instanceId);
        return [];
      },
    },
    saves: {
      list: async (instanceId: string) => {
        recorded.savesList.push(instanceId);
        return [];
      },
      backups: async (instanceId: string) => {
        recorded.savesBackups.push(instanceId);
        return [];
      },
      exportArchive: async (instanceId: string, request: SaveExportRequest) => {
        recorded.exports.push({ instanceId, request });
        return 'C:/out/saves.zip';
      },
    },
    initialize: async () => undefined,
  } as unknown as LauncherService;
  return { service, recorded };
}

function kernelWith(
  service: LauncherService,
  options: { readonly pickArchive?: () => Promise<string | null> } = {},
): Kernel {
  return {
    services: {
      tryGet: <T,>(_key: string): T | undefined => service as unknown as T,
      get: (): never => {
        throw new Error('unused');
      },
      keys: () => [],
    },
    launcherHost: {
      pickSourceRoot: async () => null,
      ...(options.pickArchive === undefined ? {} : { pickArchive: options.pickArchive }),
    },
    slots: { query: () => [] },
    plugins: { list: () => [{ id: 'launcher-core', version: '0.1.0', status: 'active' }] },
  } as unknown as Kernel;
}

/* ------------------------------ 挂载工具 ------------------------------ */

describe('LauncherView · 详情分区接线', () => {
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

  async function waitFor(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (check()) return;
      await settle();
    }
    throw new Error(`等待超时：${label}`);
  }

  async function mount(kernel: Kernel): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root!.render(h(LauncherView, { kernel, onClose: () => undefined }));
    });
    await waitFor(() => container.querySelector('.launcher-detail') !== null, '详情出现');
  }

  function tab(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll<HTMLButtonElement>('.launcher-tab')].find(
      (button) => button.textContent?.trim() === label,
    );
    if (found === undefined) throw new Error(`找不到分区：${label}`);
    return found;
  }

  async function click(element: Element): Promise<void> {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
  }

  function buttonByText(text: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes(text),
    );
  }

  it('默认落在概览：三块只读事实在屏上，两块面板都没挂载（零 IPC）', async () => {
    const entry = instance();
    const { service, recorded } = fakeService(entry);
    await mount(kernelWith(service));

    expect(container.textContent).toContain('路径');
    expect(container.textContent).toContain('运行时');
    expect(container.textContent).toContain('信任');
    expect(container.querySelector('.launcher-fact-grid')).not.toBeNull();
    expect(container.querySelector('section[aria-label="内容包"]')).toBeNull();
    expect(container.querySelector('section[aria-label="存档"]')).toBeNull();
    expect(recorded.contentList).toEqual([]);
    expect(recorded.savesList).toEqual([]);

    // 三个分区都在，默认选中的是「概览」
    expect(tab('概览').getAttribute('aria-selected')).toBe('true');
    expect(tab('内容包').getAttribute('aria-selected')).toBe('false');
    expect(tab('存档').getAttribute('aria-selected')).toBe('false');
  });

  it('点「内容包」才挂载，取数用的是当前实例 id，安装入口直达宿主选择器', async () => {
    const entry = instance();
    const { service, recorded } = fakeService(entry);
    const kernel = kernelWith(service, {
      pickArchive: async () => {
        recorded.picks += 1;
        return null;
      },
    });
    await mount(kernel);

    await click(tab('内容包'));
    await waitFor(() => container.querySelector('section[aria-label="内容包"]') !== null, '内容包面板');
    expect(recorded.contentList).toEqual(['i-1']);
    // 概览那一屏已让位
    expect(container.querySelector('.launcher-fact-grid')).toBeNull();

    const pick = buttonByText('选择安装包');
    expect(pick).toBeDefined();
    expect(pick!.disabled).toBe(false);
    await click(pick!);
    await waitFor(() => recorded.picks === 1, '宿主选择器被调用');

    // 取消选择（回执 null）只留一行说明，不是错误条
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('已取消选择安装包');
  });

  it('点「存档」才挂载，导出走 service.saves.exportArchive 并把回执路径原样上屏', async () => {
    const entry = instance();
    const { service, recorded } = fakeService(entry);
    await mount(kernelWith(service, { pickArchive: async () => null }));

    await click(tab('存档'));
    await waitFor(() => container.querySelector('section[aria-label="存档"]') !== null, '存档面板');
    expect(recorded.savesList).toEqual(['i-1']);
    expect(recorded.savesBackups).toEqual(['i-1']);
    expect(recorded.contentList).toEqual([]);

    const exportButton = buttonByText('导出全部存档');
    expect(exportButton).toBeDefined();
    await click(exportButton!);
    await waitFor(() => recorded.exports.length === 1, '导出调用');
    expect(recorded.exports[0]).toEqual({ instanceId: 'i-1', request: {} });
    expect(container.textContent).toContain('已导出到：C:/out/saves.zip');
  });

  it('宿主没有 pickArchive：面板照开，但安装 / 导入按钮禁用并写明原因', async () => {
    const entry = instance();
    const { service, recorded } = fakeService(entry);
    await mount(kernelWith(service));

    await click(tab('内容包'));
    await waitFor(() => container.querySelector('section[aria-label="内容包"]') !== null, '内容包面板');
    const pick = buttonByText('选择安装包');
    expect(pick).toBeDefined();
    expect(pick!.disabled).toBe(true);
    expect(container.textContent).toContain('宿主未提供选择器');

    await click(tab('存档'));
    await waitFor(() => container.querySelector('section[aria-label="存档"]') !== null, '存档面板');
    const importButton = buttonByText('选择导入包');
    expect(importButton).toBeDefined();
    expect(importButton!.disabled).toBe(true);
    expect(container.textContent).toContain('这一层没有给导入入口');
    expect(recorded.exports).toEqual([]);
  });

  it('第 4 个分区「游戏插件」能开，取数命中当前实例；默认屏仍不挂载它', async () => {
    const entry = instance();
    const { service, recorded } = fakeService(entry);
    const pluginList: string[] = [];
    const withPlugins = {
      ...service,
      plugins: {
        list: async (instanceId: string) => {
          pluginList.push(instanceId);
          return [];
        },
      },
    } as unknown as LauncherService;
    await mount(kernelWith(withPlugins));

    // 默认屏（概览）不挂载插件面板：一次 plugins.list 都没有
    expect(pluginList).toEqual([]);
    expect(tab('游戏插件').getAttribute('aria-selected')).toBe('false');

    await click(tab('游戏插件'));
    await waitFor(
      () => container.querySelector('section[aria-label="游戏插件"]') !== null,
      '插件面板',
    );
    expect(pluginList).toEqual(['i-1']);
    expect(recorded.contentList).toEqual([]);
    expect(recorded.savesList).toEqual([]);
    expect(container.textContent).toContain('还没有安装游戏插件');
  });
});
