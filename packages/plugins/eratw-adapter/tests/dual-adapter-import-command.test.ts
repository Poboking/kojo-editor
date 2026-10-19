import { describe, expect, it } from 'vitest';
import type {
  EditorCommandContribution,
  FileIO,
  PluginContext,
  ProjectService,
  WorkspaceService,
} from '@kojo/plugin-api';
import { IMPORT_KOJO_PROJECT_COMMAND_ID } from '@kojo/kojo-project-kit';
import { createEratwAdapterPlugin } from '../src/plugin';
import { createErakumamaidAdapterPlugin } from '../../eraakumamaid-adapter/src/plugin';

/**
 * 反向证明：两个游戏 adapter **同时装配到同一个宿主上下文**（共享一份槽注册表）。
 *
 * P0 症状是二者都往 `editor.command` 注册同一条通用导入命令 `kojo.importKojoProject`，
 * 并装时后者被内核槽注册表判为重复 id 而抛错（红错 + 中断该 adapter 后续注册）。各自
 * 单测只加载单插件，从不把两者放进同一注册表，故一直没暴露。
 *
 * 这里刻意复用内核 `SlotRegistryImpl` 的**同槽同 id 即抛**语义（测试文件允许跨包 import，
 * 见 AGENTS 铁律 2 之测试豁免），把两个 adapter 的 `activate` 塞进同一张表，钉两件事：
 *  (a) 装配两个 adapter 全程没有槽冲突 / 注册抛错；
 *  (b) `editor.command` 里那条通用导入命令**恰好一条**（不塌成两条同名命令）。
 */

interface Contrib {
  readonly slot: string;
  readonly id: string;
  readonly item: Record<string, unknown>;
  readonly pluginId: string;
}

/** 忠实复刻内核 `SlotRegistryImpl` 的重复 id 抛错语义。 */
function createSharedRegistry() {
  const seen = new Map<string, Set<string>>();
  const contributions: Contrib[] = [];
  return {
    contributions,
    register(slot: string, item: { id: string }, pluginId: string): () => void {
      const ids = seen.get(slot) ?? new Set<string>();
      if (ids.has(item.id)) {
        throw new Error(`Slot '${slot}' already has a contribution with id '${item.id}'`);
      }
      ids.add(item.id);
      seen.set(slot, ids);
      contributions.push({ slot, id: item.id, item: item as Record<string, unknown>, pluginId });
      return () => {};
    },
  };
}

/**
 * 为某个 adapter 造一份 PluginContext，全部注册落到**同一张** registry。
 * inject 只提供两个 adapter 激活期真正取用的三个内核服务；余者抛错以便暴露越界依赖。
 */
function ctxFor(pluginId: string, registry: ReturnType<typeof createSharedRegistry>): PluginContext {
  const io = {
    listDir: async () => [],
    exists: async () => false,
    isWritable: () => true,
    chooseWorkspaceRoot: async () => null,
    ensureDir: async () => {},
    readText: async () => '',
    writeText: async () => {},
  } as unknown as FileIO;
  const workspaces = {
    rootDir: () => '/appdata/workspaces',
    roots: () => ['/appdata/workspaces'],
    list: async () => [],
    listDir: async () => [],
    projectDir: (id: string) => `/appdata/workspaces/${id}`,
  } as unknown as WorkspaceService;
  const project = { current: () => null } as unknown as ProjectService;

  return {
    pluginId,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    onDispose: () => {},
    provide: () => {},
    tryInject: () => undefined,
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return io as unknown as T;
      if (key === 'kernel.workspaces') return workspaces as unknown as T;
      if (key === 'kernel.project') return project as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    bus: {
      emit: () => {},
      on: () => () => {},
    },
    slots: {
      register: (slot: string, item: unknown) => registry.register(slot, item as { id: string }, pluginId),
    },
  } as unknown as PluginContext;
}

const commandsOf = (registry: ReturnType<typeof createSharedRegistry>): Contrib[] =>
  registry.contributions.filter((c) => c.slot === 'editor.command');

describe('双 adapter 并装 · 通用导入命令收敛（P0 反向证明）', () => {
  it('同宿主同时装配 eratw-adapter 与 eraakumamaid-adapter：全程零槽冲突/注册抛错', () => {
    const registry = createSharedRegistry();
    // 关键：两个 adapter 落到**同一张** registry——这正是各自单测从不覆盖的组合。
    expect(() => {
      createEratwAdapterPlugin().activate(ctxFor('eratw-adapter', registry));
      createErakumamaidAdapterPlugin().activate(ctxFor('eraakumamaid-adapter', registry));
    }).not.toThrow();
  });

  it('editor.command 里的通用导入命令恰好一条（不塌成两条同名命令）', () => {
    const registry = createSharedRegistry();
    createEratwAdapterPlugin().activate(ctxFor('eratw-adapter', registry));
    createErakumamaidAdapterPlugin().activate(ctxFor('eraakumamaid-adapter', registry));

    const importCommands = commandsOf(registry).filter((c) => c.id === IMPORT_KOJO_PROJECT_COMMAND_ID);
    expect(importCommands).toHaveLength(1);
    expect((importCommands[0]!.item as unknown as EditorCommandContribution).title).toBe('从文件夹导入口上项目…');
  });

  it('换装配顺序同样收敛为一条（谁先激活谁落子，与顺序无关）', () => {
    const registry = createSharedRegistry();
    createErakumamaidAdapterPlugin().activate(ctxFor('eraakumamaid-adapter', registry));
    createEratwAdapterPlugin().activate(ctxFor('eratw-adapter', registry));

    expect(commandsOf(registry).filter((c) => c.id === IMPORT_KOJO_PROJECT_COMMAND_ID)).toHaveLength(1);
  });
});
