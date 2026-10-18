import { describe, expect, it } from 'vitest';
import type { FileIO, PluginContext } from '@kojo/plugin-api';
import { createErakumamaidAdapterPlugin } from '../src/plugin';
import {
  DEPLOY_KOJO_OVERLAY_ID,
  IMPORT_KOJO_OVERLAY_ID,
  NEW_KOJO_PROJECT_OVERLAY_ID,
  PUBLISH_KOJO_OVERLAY_ID,
} from '../src/overlay-ids';
import { AM_SCAFFOLD_DEPS } from '../src/new-project-wizard';
import { AM_SCAFFOLD_FILES } from '../src/scaffold';

/**
 * eraAkumaMaid 的「我的口上项目」面板与向导族接线。
 *
 * 这些窗口来自共享层（`@kojo/kojo-project-kit`），本包只做接线。本组用例只钉
 * **接线面**：注册了哪些贡献、id 落在本游戏命名空间下、游戏侧供数确实接上了。
 * 窗口行为本身由共享层与 eratw 的既有测试覆盖。
 */
interface Registered {
  slot: string;
  item: Record<string, unknown>;
}

function activate(): { registered: Registered[]; ctx: PluginContext } {
  const registered: Registered[] = [];
  const io = {
    listDir: async () => [],
    exists: async () => false,
    isWritable: () => true,
    chooseWorkspaceRoot: async () => null,
  } as unknown as FileIO;

  const ctx = {
    pluginId: 'eraakumamaid-adapter',
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    onDispose: () => {},
    bus: { emit: () => {}, on: () => () => {} },
    tryInject: () => null,
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return io as unknown as T;
      if (key === 'kernel.project') return { current: () => null } as unknown as T;
      if (key === 'kernel.workspaces') {
        return {
          rootDir: () => '/appdata/workspaces',
          roots: () => ['/appdata/workspaces'],
          list: async () => [],
          projectDir: (id: string) => `/appdata/workspaces/${id}`,
          listDir: async () => [],
        } as unknown as T;
      }
      throw new Error(`unexpected inject: ${key}`);
    },
    slots: {
      register: (slot: string, item: unknown) => {
        registered.push({ slot, item: item as Record<string, unknown> });
        return () => {};
      },
    },
  } as unknown as PluginContext;

  createErakumamaidAdapterPlugin().activate(ctx);
  return { registered, ctx };
}

const ids = (rs: Registered[], slot: string): string[] =>
  rs.filter((r) => r.slot === slot).map((r) => String(r.item.id));

describe('eraAkumaMaid · 项目面板与向导族接线', () => {
  it('注册了面板、四个向导与导入命令（与 eratw 同一组能力）', () => {
    const { registered } = activate();

    expect(ids(registered, 'game.adapter')).toEqual(['eraakumamaid-adapter']);
    expect(ids(registered, 'ui.panel')).toEqual(['kojo-projects']);
    expect(ids(registered, 'ui.overlay')).toEqual([
      NEW_KOJO_PROJECT_OVERLAY_ID,
      IMPORT_KOJO_OVERLAY_ID,
      DEPLOY_KOJO_OVERLAY_ID,
      PUBLISH_KOJO_OVERLAY_ID,
    ]);
    expect(ids(registered, 'editor.command')).toEqual(['kojo.importKojoProject']);
  });

  it('overlay id 落在本游戏命名空间（不会与 eratw 互相顶掉）', () => {
    for (const id of [
      NEW_KOJO_PROJECT_OVERLAY_ID,
      IMPORT_KOJO_OVERLAY_ID,
      DEPLOY_KOJO_OVERLAY_ID,
      PUBLISH_KOJO_OVERLAY_ID,
    ]) {
      expect(id.startsWith('eraakumamaid.')).toBe(true);
      expect(id.startsWith('eratw.')).toBe(false);
    }
  });

  it('游戏侧供数接上了本游戏的脚手架（面数取自文件规格表，不是写死的数）', () => {
    expect(AM_SCAFFOLD_DEPS.coreFaceCount).toBe(AM_SCAFFOLD_FILES.length);
    expect(AM_SCAFFOLD_DEPS.coreFaceCount).toBeGreaterThan(1);
    // 本游戏没有「剧本号」⇒ 不提供 extraFields（共享向导连那一行都不渲染）
    expect('extraFields' in AM_SCAFFOLD_DEPS).toBe(false);

    const built = AM_SCAFFOLD_DEPS.scaffold({
      workName: '测试作品',
      authorName: '测试作者',
      version: '1.0',
      charaNo: 67,
      charaName: '测试角色',
      license: 'none',
      extra: {},
    });
    expect(Object.keys(built.files)).toContain('CSV/CHARA/CHARA67.csv');
    expect(built.dirName).toContain('测试作品');
  });
});
