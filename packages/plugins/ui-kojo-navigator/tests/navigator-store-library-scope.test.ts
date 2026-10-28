/**
 * 函数树的**作者视图**单测（只读基座库过滤）。
 *
 * 背景：索引面扩到整棵 ERB 之后，`ErbIndex.files/byName` 里躺着成千上万条基础库定义。
 * 「函数导航」是给作者看口上用的——若不剔除基座库，孤儿计数与搜索结果都会被基础库
 * 函数灌满。这里钉两件事：
 *   1. `store.index` 暴露的是**作者视图**（基座库文件不在 `files` 里）；
 *   2. 建树用的是同一份作者视图（`tree.totalFunctions` 只数作者函数）。
 */

import { describe, expect, it } from 'vitest';
import type {
  ErbFile,
  ErbIndex,
  ErbParserService,
  EventBus,
  GameProject,
  PluginContext,
  ProjectService,
  Unsubscribe,
} from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { createNavigatorStore } from '../src/navigator-store';

function makeIndex(files: Record<string, string>): ErbIndex {
  const map = new Map<string, ErbFile>();
  const byName = new Map<string, Array<{ name: string; normalizedName: string; filePath: string; startLine: number; endLine: number }>>();
  for (const [path, text] of Object.entries(files)) {
    const f = parseErbText(text, path);
    map.set(path, f);
    for (const fn of f.functions) {
      const refs = byName.get(fn.normalizedName) ?? [];
      refs.push({
        name: fn.name,
        normalizedName: fn.normalizedName,
        filePath: fn.filePath,
        startLine: fn.startLine,
        endLine: fn.endLine,
      });
      byName.set(fn.normalizedName, refs);
    }
  }
  return { files: map, byName };
}

function makeCtx(): PluginContext {
  const on = (): Unsubscribe => () => {};
  return {
    pluginId: 'ui-kojo-navigator',
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    bus: { on, once: on, emit: () => {} } as unknown as EventBus,
    onDispose: () => {},
  } as unknown as PluginContext;
}

async function waitUntil(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!cond()) throw new Error(`等待超时：${what}`);
}

describe('navigator-store · 作者视图（只读基座库不进函数树）', () => {
  it('store.index 剔除基座库文件，建树的 totalFunctions 只数作者函数', async () => {
    const base = '/game/ERB/base.ERB';
    const kojo = '/game/ERB/口上/個人口上/001/a.ERB';
    const index = makeIndex({
      [base]: '@BASE_FOO\n@BASE_BAR\n',
      [kojo]: '@M_KOJO_K1_A\n',
    });
    const project: GameProject = {
      rootDir: '/game',
      adapterId: 'test',
      kojoPaths: ['/game/ERB/口上/個人口上'],
      libraryPaths: ['/game/ERB'],
      writablePaths: ['/game/ERB/口上/個人口上'],
      charaIndex: new Map(),
    };
    const parser = {
      ensureIndex: async () => index,
      currentIndex: () => index,
    } as unknown as ErbParserService;
    const projectService = { current: () => project } as unknown as ProjectService;

    const store = createNavigatorStore(makeCtx(), {
      parser,
      project: projectService,
      currentFamilyIndex: () => null,
    });
    store.refresh();
    await waitUntil(() => store.tree !== null, '建树完成');

    expect([...(store.index?.files.keys() ?? [])]).toEqual([kojo]);
    expect(store.tree!.totalFunctions).toBe(1);
    expect(store.tree!.filesScanned).toBe(1);
  });

  it('缺 libraryPaths（旧适配器）⇒ 视图与源索引是同一实例（零改动）', async () => {
    const kojo = '/game/ERB/kojo/a.ERB';
    const index = makeIndex({ [kojo]: '@A\n' });
    const project: GameProject = {
      rootDir: '/game',
      adapterId: 'test',
      kojoPaths: ['/game/ERB/kojo'],
      writablePaths: [],
      charaIndex: new Map(),
    };
    const parser = { ensureIndex: async () => index, currentIndex: () => index } as unknown as ErbParserService;
    const store = createNavigatorStore(makeCtx(), {
      parser,
      project: { current: () => project } as unknown as ProjectService,
      currentFamilyIndex: () => null,
    });
    store.refresh();
    await waitUntil(() => store.tree !== null, '建树完成');

    expect(store.index).toBe(index);
  });
});
