import { describe, expect, it } from 'vitest';
import type {
  FileIO,
  MarketService,
  OverlayContribution,
  PluginContext,
  WorkspaceService,
} from '@kojo/plugin-api';
import { createEratwAdapterPlugin } from '../src/plugin';
import { PUBLISH_KOJO_OVERLAY_ID, ZIP_ENTRY_COPY, ignoredDerivedNote } from '../src/publish-wizard';

/**
 * 「发布口上」向导的**接线判据**（用户反馈 4 批）。
 *
 * 组件本体是 hooks + `createElement`，node 里没有渲染器（不改依赖为此背 react-dom），
 * 所以这里只钉三件接线事实：
 * 1. 插件注册了 `eratw.publishKojo` overlay（宽版、向导族 order）；
 * 2. 收到内核语义事件 `market.publishRequested` → 发出 `ui.overlay.open`（意图 → 宿主落地）；
 * 3. 插件卸载时该监听被退订（`onDispose` 真的摘掉 handler）。
 *
 * 默认值 / 校验 / 许可 / 打包这些"会进包的事实"全部在 `publish-pack.test.ts` 里直测纯函数。
 */

interface FakeCtx {
  overlays: OverlayContribution[];
  emits: Array<{ type: string; payload: unknown }>;
  /** 触发插件注册过的某个事件监听器 */
  fire(type: string, payload: unknown): void;
  /** 执行全部 onDispose 回调（模拟插件卸载） */
  disposeAll(): void;
}

function fakeWorkspaces(): WorkspaceService {
  return {
    rootDir: () => '/appdata/workspaces',
    roots: () => ['/appdata/workspaces'],
    list: async () => [],
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

function activate(market: MarketService | null = null): FakeCtx {
  const overlays: OverlayContribution[] = [];
  const emits: Array<{ type: string; payload: unknown }> = [];
  const handlers = new Map<string, (payload: unknown) => void>();
  const disposers: Array<() => void> = [];
  const io = { listDir: async () => [] } as unknown as FileIO;
  const ctx = {
    pluginId: 'eratw-adapter',
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    onDispose: (fn: () => void) => {
      disposers.push(fn);
    },
    bus: {
      emit: (type: string, payload: unknown) => emits.push({ type, payload }),
      on: (type: string, handler: (payload: unknown) => void) => {
        handlers.set(type, handler);
        return () => {
          // 只有仍是这一个 handler 时才摘（避免"退订旧号却摘掉新号"的假绿）
          if (handlers.get(type) === handler) handlers.delete(type);
        };
      },
    },
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return io as unknown as T;
      if (key === 'kernel.workspaces') return fakeWorkspaces() as unknown as T;
      if (key === 'kernel.project') return { current: () => null } as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    // 市场惰性取：本测试不触发（向导未渲染），给 undefined 等价于"市场缺席"
    tryInject: <T,>(key: string): T | undefined =>
      key === 'market' ? ((market ?? undefined) as T | undefined) : undefined,
    slots: {
      register: (slot: string, item: OverlayContribution) => {
        if (slot === 'ui.overlay') overlays.push(item);
        return () => {};
      },
    },
  } as unknown as PluginContext;
  createEratwAdapterPlugin().activate(ctx);
  return {
    overlays,
    emits,
    fire: (type, payload) => handlers.get(type)?.(payload),
    disposeAll: () => {
      for (const fn of disposers.splice(0)) fn();
    },
  };
}

describe('「发布口上」向导注册（用户反馈 4 批）', () => {
  it('注册 eratw.publishKojo：宽版、向导族 order、组件是函数', () => {
    const { overlays } = activate();
    const overlay = overlays.find((o) => o.id === PUBLISH_KOJO_OVERLAY_ID);
    expect(overlay).toBeTruthy();
    expect(overlay!.size).toBe('wide');
    expect(overlay!.order).toBeGreaterThanOrEqual(20);
    expect(overlay!.order).toBeLessThanOrEqual(40);
    expect(typeof overlay!.component).toBe('function');
    // id 不得与其它向导撞（单槽位 overlay 同名就是互相覆盖）
    expect(overlays.filter((o) => o.id === PUBLISH_KOJO_OVERLAY_ID)).toHaveLength(1);
  });

  it('市场缺席也照常注册（能力三态在向导里说明，不把入口藏起来）', () => {
    const { overlays } = activate(null);
    expect(overlays.some((o) => o.id === PUBLISH_KOJO_OVERLAY_ID)).toBe(true);
  });

  it('监听 market.publishRequested → 打开发布向导（意图 → 宿主落地，不带 payload）', () => {
    const { fire, emits } = activate();
    fire('market.publishRequested', { source: 'ui-market' });
    const opens = emits.filter((e) => e.type === 'ui.overlay.open');
    expect(opens).toHaveLength(1);
    expect(opens[0]!.payload).toEqual({ id: PUBLISH_KOJO_OVERLAY_ID, source: 'eratw-adapter' });
  });

  it('卸载即退订：dispose 之后再来的发布意图不再开窗（不退订 = 关掉的插件还在弹窗）', () => {
    const h = activate();
    h.fire('market.publishRequested', {});
    expect(h.emits.filter((e) => e.type === 'ui.overlay.open')).toHaveLength(1);
    h.disposeAll();
    h.fire('market.publishRequested', {});
    expect(h.emits.filter((e) => e.type === 'ui.overlay.open')).toHaveLength(1);
  });
});

describe('zip 入口文案 · 市场容器与普通作品包两口通吃', () => {
  it('按钮不再写「高级/市场格式」，对话标题点明两类 zip', () => {
    expect(ZIP_ENTRY_COPY.button).toBe('选择 zip 文件…');
    expect(ZIP_ENTRY_COPY.dialogTitle).toContain('市场容器');
    expect(ZIP_ENTRY_COPY.dialogTitle).toContain('普通作品包');
  });

  it('hint 说清：市场容器直接传；普通作品包先解出内容再补包信息', () => {
    expect(ZIP_ENTRY_COPY.hint).toContain('市场容器直接上传');
    expect(ZIP_ENTRY_COPY.hint).toContain('普通作品包');
    expect(ZIP_ENTRY_COPY.hint).toContain('.ERB');
    expect(ZIP_ENTRY_COPY.hint).toContain('补包信息');
  });
});

describe('ignoredDerivedNote · 派生产物被跳过时的一行人话（不静默）', () => {
  it('空数组 → 空串（界面不渲染空行）', () => {
    expect(ignoredDerivedNote([])).toBe('');
  });

  it('单个：数量、文件名与判据都在', () => {
    const note = ignoredDerivedNote([{ relPath: '主口上.ERB', sourceRel: '主口上.kojo' }]);
    expect(note).toContain('已忽略 1 个');
    expect(note).toContain('主口上.ERB');
    expect(note).toContain('以 .kojo 当前编译结果为准');
  });

  it('多个：数量与文件名逐个列出（编码差异记录同样计入）', () => {
    const note = ignoredDerivedNote([
      { relPath: 'a.ERB', sourceRel: 'a.kojo' },
      { relPath: 'b.ERB', sourceRel: 'b.kojo', reason: 'encoding' },
    ]);
    expect(note).toContain('已忽略 2 个');
    expect(note).toContain('a.ERB');
    expect(note).toContain('b.ERB');
  });
});
