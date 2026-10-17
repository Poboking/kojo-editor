import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentType } from 'react';
import { describe, expect, it } from 'vitest';
import type { FileIO, OverlayContribution, PluginContext } from '@kojo/plugin-api';
import { createEratwAdapterPlugin, TUTORIAL_OVERLAY_BY_ID } from '../../plugins/eratw-adapter/src/plugin';
import {
  KOJO_TUTORIAL_OVERLAY_ID,
  REFERENCE_TUTORIAL_OVERLAY_ID,
  SUGAR_TUTORIAL_OVERLAY_ID,
  createLazyTutorialOverlay,
  loadTutorialOverlay,
} from '../../plugins/eratw-adapter/src/tutorial-lazy';
import { TUTORIALS } from '../../plugins/eratw-adapter/src/tutorial-content';

/**
 * PS-10 ①：教程浮层改懒装载后的**行为不变**闸。
 *
 * 拆分只许动"什么时候把正文搬进来"，不许动任何可观察面。这里钉四件：
 * 1. `activate()` 仍注册七个 `ui.overlay`，教程三本的 id / order / size 一字不改
 *    （面板顺序与 `ui.tutorial.open` 映射的可见结果因此完全不变）；
 * 2. 同步渲染只给一行"正在载入"，**正文一枚字都不出现** ⇒ 浮层没被打开时那 223 KB
 *    没有被求值（这条就是"证据不是注释"的那一半）；
 * 3. 装载出来的是**真正文**（标题与导语逐字来自 `tutorial-content.ts`），且按 id 记忆化：
 *    同一本第二次装载拿到同一个组件引用，不重复求值；
 * 4. `plugin.ts` 不再静态挂正文（`import type` 允许，值导入不允许）。
 */

type Handler = (payload: unknown) => void;

/** 最小伪 ctx（照 `eratw-adapter/tests/tutorial-event.test.ts` 的形状，不建真实内核） */
function activateWithOverlays(): OverlayContribution[] {
  const handlers = new Map<string, Handler>();
  const overlays: OverlayContribution[] = [];
  const io = {
    async exists() {
      return false;
    },
    async listDir() {
      return [];
    },
    isWritable() {
      return false;
    },
  } as unknown as FileIO;
  const ctx = {
    pluginId: 'eratw-adapter',
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    bus: {
      on: (type: string, handler: Handler) => {
        handlers.set(type, handler);
        return () => {};
      },
      emit: () => {},
    },
    onDispose: () => {},
    inject: (key: string): unknown => {
      if (key === 'kernel.io') return io;
      if (key === 'kernel.workspaces') return { list: async () => [], projectDir: (id: string) => `/ws/${id}`, roots: () => [] };
      if (key === 'kernel.project') return { current: () => null };
      throw new Error(`unexpected inject: ${key}`);
    },
    tryInject: () => undefined,
    slots: {
      register: (slot: string, item: OverlayContribution) => {
        // 只收 overlay：适配器同一趟还挂 ui.panel / search.scope，混进来会把"七个"数成十一个
        if (slot === 'ui.overlay') overlays.push(item);
        return () => {};
      },
    },
  } as unknown as PluginContext;
  createEratwAdapterPlugin().activate(ctx);
  return overlays;
}

const TUTORIAL_IDS = [SUGAR_TUTORIAL_OVERLAY_ID, KOJO_TUTORIAL_OVERLAY_ID, REFERENCE_TUTORIAL_OVERLAY_ID];

describe('PS-10 教程懒装载：可观察面不变、正文只在打开时进来', () => {
  it('activate 仍注册七个 overlay，教程三本的 id / order / size 一字不改', () => {
    const overlays = activateWithOverlays();
    expect(overlays).toHaveLength(7);
    const byId = new Map(overlays.map((o) => [o.id, o]));
    expect([SUGAR_TUTORIAL_OVERLAY_ID, KOJO_TUTORIAL_OVERLAY_ID, REFERENCE_TUTORIAL_OVERLAY_ID].every((id) => byId.has(id))).toBe(true);
    expect(byId.get(SUGAR_TUTORIAL_OVERLAY_ID)!.order).toBe(30);
    expect(byId.get(KOJO_TUTORIAL_OVERLAY_ID)!.order).toBe(31);
    expect(byId.get(REFERENCE_TUTORIAL_OVERLAY_ID)!.order).toBe(32);
    for (const id of TUTORIAL_IDS) {
      expect(byId.get(id)!.size).toBe('wide');
      expect(typeof byId.get(id)!.component).toBe('function');
    }
  });

  it('语义 id 映射照旧指向这三个 overlay 贡献（欢迎页与面板两条入口共用一份）', () => {
    expect(TUTORIAL_OVERLAY_BY_ID).toEqual({
      kojo: KOJO_TUTORIAL_OVERLAY_ID,
      sugar: SUGAR_TUTORIAL_OVERLAY_ID,
      reference: REFERENCE_TUTORIAL_OVERLAY_ID,
    });
  });

  it('同步渲染只有"正在载入"，一枚正文都不出现（= 没打开就不求值 223 KB）', () => {
    const markup = renderToStaticMarkup(
      h(createLazyTutorialOverlay({ tutorial: 'kojo', close: () => {} }) as ComponentType<{}>, {}),
    );
    expect(markup).toContain('教程正在载入');
    for (const t of Object.values(TUTORIALS)) {
      expect(markup).not.toContain(t.title);
      expect(markup).not.toContain(t.lead);
    }
  });

  it('装载出来的是真正文，且按 id 记忆化（第二次同引用，不重复求值）', async () => {
    const built = await loadTutorialOverlay({ tutorial: 'kojo', close: () => {} });
    const markup = renderToStaticMarkup(built() as ReactElementLike);
    expect(markup).toContain(TUTORIALS.kojo.title);
    expect(markup).toContain(TUTORIALS.kojo.lead);
    expect(markup).not.toContain('教程正在载入');
    const again = await loadTutorialOverlay({ tutorial: 'kojo', close: () => {} });
    expect(again).toBe(built);
  });

  it('plugin.ts 不再静态挂正文或渲染器（值导入一枚都不许有）', () => {
    const src = readFileSync(
      path.join(fileURLToPath(new URL('../../..', import.meta.url)), 'packages/plugins/eratw-adapter/src/plugin.ts'),
      'utf8',
    );
    const staticSpecs = [...src.matchAll(/import\s+(?!type\b)([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g)]
      .filter((m) => m[1]!.split(',').some((p) => p.trim() !== '' && !/^\s*type\b/.test(p.trim())))
      .map((m) => m[2]!);
    expect(staticSpecs.filter((s) => /tutorial-(content|overlay|reference|inline)/.test(s))).toEqual([]);
    expect(src).toContain(`from './tutorial-lazy'`);
  });
});

type ReactElementLike = Parameters<typeof renderToStaticMarkup>[0];
