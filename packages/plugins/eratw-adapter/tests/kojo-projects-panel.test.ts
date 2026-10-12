import { describe, expect, it } from 'vitest';
import type {
  DirEntry,
  FileIO,
  OverlayContribution,
  PluginContext,
  UIPanelContribution,
  WorkspaceProject,
  WorkspaceService,
} from '@kojo/plugin-api';
import { createEratwAdapterPlugin } from '../src/plugin';
import { artifactDir, sortDirEntries } from '../src/kojo-projects-panel';
import { NEW_KOJO_PROJECT_OVERLAY_ID } from '../src/new-project-wizard';
import { IMPORT_KOJO_OVERLAY_ID } from '../src/import-wizard';

/* ------------------------------ 纯函数 ------------------------------ */

describe('目录条目排序（目录在前，名称中文本地化比较）', () => {
  const entry = (name: string, isDirectory: boolean): DirEntry => ({
    name,
    path: `/ws/${name}`,
    isDirectory,
  });

  it('目录恒在文件之前（不看名称）', () => {
    const sorted = sortDirEntries([entry('b.txt', false), entry('甲目录', true), entry('a.txt', false)]);
    expect(sorted.map((e) => e.name)).toEqual(['甲目录', 'a.txt', 'b.txt']);
  });

  it('不修改入参数组（返回新数组）', () => {
    const input = [entry('b', false), entry('a', false)];
    const sorted = sortDirEntries(input);
    expect(sorted).not.toBe(input);
    expect(input.map((e) => e.name)).toEqual(['b', 'a']);
  });
});

describe('包目录路径', () => {
  it('项目目录 + 包目录名（单层拼接）', () => {
    expect(artifactDir('/appdata/workspaces/p1', { dirName: '东方口上-灵梦 v1.0' })).toBe(
      '/appdata/workspaces/p1/东方口上-灵梦 v1.0',
    );
  });
});

/* ------------------------------ 插件注册形态 ------------------------------ */

interface FakeCtx {
  ctx: PluginContext;
  panels: UIPanelContribution[];
  overlays: OverlayContribution[];
  emits: Array<{ type: string; payload: unknown }>;
  /** 触发某内核事件的插件监听器（如 workspace.importRequested） */
  fire(type: string, payload: unknown): void;
}

function fakeWorkspaces(): WorkspaceService {
  const projects: WorkspaceProject[] = [];
  return {
    rootDir: () => '/appdata/workspaces',
    list: async () => projects,
    get: async () => null,
    create: async () => {
      throw new Error('not used');
    },
    update: async () => {
      throw new Error('not used');
    },
    remove: async () => {},
    projectDir: (id: string) => `/appdata/workspaces/${id}`,
    createArtifact: async () => {
      throw new Error('not used');
    },
    importDirectory: async () => {
      throw new Error('not used');
    },
    removeArtifact: async () => {},
    listDir: async () => [],
    readText: async () => {
      throw new Error('not used');
    },
    writeText: async () => {},
  };
}

function activateWithPanel(): FakeCtx {
  const panels: UIPanelContribution[] = [];
  const overlays: OverlayContribution[] = [];
  const emits: Array<{ type: string; payload: unknown }> = [];
  const handlers = new Map<string, (payload: unknown) => void>();
  const io = {
    listDir: async () => [],
  } as unknown as FileIO;
  const ctx = {
    pluginId: 'eratw-adapter',
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    onDispose: () => {},
    bus: {
      emit: (type: string, payload: unknown) => emits.push({ type, payload }),
      on: (type: string, handler: (payload: unknown) => void) => {
        handlers.set(type, handler);
        return () => {};
      },
    },
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return io as unknown as T;
      if (key === 'kernel.workspaces') return fakeWorkspaces() as unknown as T;
      // 新建向导依赖（P-C）：角色表来自当前游戏项目
      if (key === 'kernel.project') return { current: () => null } as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    slots: {
      register: (slot: string, item: UIPanelContribution) => {
        if (slot === 'ui.panel') panels.push(item);
        else if (slot === 'ui.overlay') overlays.push(item as unknown as OverlayContribution);
        return () => {};
      },
    },
  } as unknown as PluginContext;
  createEratwAdapterPlugin().activate(ctx);
  return {
    ctx,
    panels,
    overlays,
    emits,
    fire: (type, payload) => handlers.get(type)?.(payload),
  };
}

describe('「我的口上项目」面板注册（P-B）', () => {
  it('注册 ui.panel：独占活动栏图标（无 group）、sidebar、中文标题', () => {
    const { panels } = activateWithPanel();
    expect(panels).toHaveLength(1);
    const panel = panels[0]!;
    expect(panel.id).toBe('kojo-projects');
    expect(panel.title).toBe('我的口上项目');
    expect(panel.location).toBe('sidebar');
    // 不声明 group → 壳层按独占视图渲染出独立活动栏图标
    expect(panel.group).toBeUndefined();
    expect(typeof panel.component).toBe('function');
  });

  it('插件硬依赖包含 kernel.workspaces / kernel.project（缺席时可见地 inactive，不静默）', () => {
    const plugin = createEratwAdapterPlugin();
    expect(plugin.requires).toContain('kernel.workspaces');
    expect(plugin.requires).toContain('kernel.project');
  });
});

describe('口上项目向导注册（P-C 新建 / P-F 导入）', () => {
  it('注册两个 ui.overlay：新建 + 导入，id 与各引用常量一致', () => {
    const { overlays } = activateWithPanel();
    const ids = overlays.map((o) => o.id);
    expect(ids).toContain(NEW_KOJO_PROJECT_OVERLAY_ID);
    expect(ids).toContain(IMPORT_KOJO_OVERLAY_ID);
    for (const o of overlays) expect(typeof o.component).toBe('function');
  });

  it('监听 workspace.importRequested → 打开导入 overlay（意图 → 宿主落地）', () => {
    const { fire, emits } = activateWithPanel();
    fire('workspace.importRequested', {
      sourceDir: '/game/个人口上/001 灵梦/某包',
      suggestedName: '某包',
      source: 'file-tree',
    });
    const open = emits.find((e) => e.type === 'ui.overlay.open');
    expect(open).toBeTruthy();
    expect((open!.payload as { id: string }).id).toBe(IMPORT_KOJO_OVERLAY_ID);
  });
});
