import { describe, expect, it } from 'vitest';
import type { FileIO, PluginContext } from '@kojo/plugin-api';
import { TUTORIAL_OVERLAY_BY_ID, createEratwAdapterPlugin } from '../src/plugin';
import {
  KOJO2_TUTORIAL_OVERLAY_ID,
  KOJO_TUTORIAL_OVERLAY_ID,
  REFERENCE_TUTORIAL_OVERLAY_ID,
  SUGAR_TUTORIAL_OVERLAY_ID,
} from '../src/tutorial-overlay';

/**
 * 用户反馈 8 批：教程打开意图 `ui.tutorial.open` 的接线守门。
 *
 * 钉三件事：
 * - 语义 id → overlay 贡献 id 的映射与四个常驻 overlay 一一对应（唯一真源）；
 * - 监听器按映射发 `ui.overlay.open`（source 恒为适配器，发起方的 source 不被改写）；
 * - 未知 id 出声不打开，退订后总线上的意图不再触发本插件。
 *
 * 用最小伪 ctx 激活插件（不建真实内核）：本测试只关心事件接线，适配器其余能力
 * 在 `plugin.test.ts` 各自覆盖。
 */

type Handler = (payload: unknown) => void;

interface Harness {
  handlers: Map<string, Handler>;
  disposers: Array<() => void>;
  emitted: Array<{ type: string; payload: unknown }>;
  warns: string[];
  /** `activate()` 真注册进 `ui.overlay` 的贡献 id（映射不许指向空位） */
  overlayIds: string[];
}

function activateAdapter(): Harness {
  const handlers = new Map<string, Handler>();
  const disposers: Array<() => void> = [];
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const warns: string[] = [];
  const overlayIds: string[] = [];

  const io = {
    async exists() {
      return false;
    },
    async listDir() {
      return [];
    },
    async readText() {
      throw new Error('unexpected readText');
    },
    async readTexts() {
      return [];
    },
    isWritable() {
      return false;
    },
    async writeText() {},
    async ensureDir() {},
    async chooseWorkspaceRoot() {
      return null;
    },
  } as unknown as FileIO;

  const workspaces = {
    list: async () => [],
    projectDir: (id: string) => `/ws/${id}`,
    roots: () => [],
  };

  const project = { current: () => null };

  const ctx = {
    pluginId: 'eratw-adapter',
    log: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => warns.push(message),
      error: (message: string) => warns.push(message),
    },
    bus: {
      on: (type: string, handler: Handler) => {
        handlers.set(type, handler);
        return () => {
          handlers.delete(type);
        };
      },
      emit: (type: string, payload: unknown) => {
        emitted.push({ type, payload });
      },
    },
    onDispose: (fn: () => void | Promise<void>) => {
      disposers.push(() => {
        void fn();
      });
    },
    inject: (key: string): unknown => {
      if (key === 'kernel.io') return io;
      if (key === 'kernel.workspaces') return workspaces;
      if (key === 'kernel.project') return project;
      throw new Error(`unexpected inject: ${key}`);
    },
    tryInject: () => undefined,
    slots: {
      register: (slot: string, item: { id: string }) => {
        if (slot === 'ui.overlay') overlayIds.push(item.id);
        return () => {};
      },
    },
  } as unknown as PluginContext;

  createEratwAdapterPlugin().activate(ctx);
  return { handlers, disposers, emitted, warns, overlayIds };
}

describe('教程打开意图（用户反馈 8 批）', () => {
  it('语义 id 映射 = 四个常驻教程 overlay（面板入口与内核事件共用一份）', () => {
    expect(TUTORIAL_OVERLAY_BY_ID).toEqual({
      kojo: KOJO_TUTORIAL_OVERLAY_ID,
      sugar: SUGAR_TUTORIAL_OVERLAY_ID,
      kojo2: KOJO2_TUTORIAL_OVERLAY_ID,
      reference: REFERENCE_TUTORIAL_OVERLAY_ID,
    });
    // 映射不许指向空位：每一枚去处都必须是 activate() 真注册过的贡献（四路入口点了都要有人接）
    const { overlayIds } = activateAdapter();
    for (const id of Object.values(TUTORIAL_OVERLAY_BY_ID)) {
      expect(overlayIds, `映射里的 ${id} 没有被注册（点了没浮层 = 静默）`).toContain(id);
    }
  });

  it.each([
    ['kojo', KOJO_TUTORIAL_OVERLAY_ID],
    ['sugar', SUGAR_TUTORIAL_OVERLAY_ID],
    ['kojo2', KOJO2_TUTORIAL_OVERLAY_ID],
    ['reference', REFERENCE_TUTORIAL_OVERLAY_ID],
  ] as const)('ui.tutorial.open(%s) → 打开 %s', (tutorial, overlayId) => {
    const { handlers, emitted } = activateAdapter();
    const openTutorial = handlers.get('ui.tutorial.open');
    expect(openTutorial).toBeTypeOf('function');

    emitted.length = 0;
    openTutorial?.({ tutorial, source: 'welcome' });
    expect(emitted).toEqual([
      { type: 'ui.overlay.open', payload: { id: overlayId, source: 'eratw-adapter' } },
    ]);
  });

  it('未知教程 id：不打开任何浮层，警告出声（不静默）', () => {
    const { handlers, emitted, warns } = activateAdapter();
    const openTutorial = handlers.get('ui.tutorial.open');
    expect(openTutorial).toBeTypeOf('function');

    emitted.length = 0;
    openTutorial?.({ tutorial: 'not-a-tutorial' });
    expect(emitted).toEqual([]);
    expect(warns.some((w) => w.includes('未知教程 id'))).toBe(true);
  });

  it('退订（ctx.onDispose）后不再响应 ui.tutorial.open', () => {
    const { handlers, disposers } = activateAdapter();
    expect(handlers.has('ui.tutorial.open')).toBe(true);

    for (const dispose of disposers) dispose();
    expect(handlers.has('ui.tutorial.open')).toBe(false);
  });
});
