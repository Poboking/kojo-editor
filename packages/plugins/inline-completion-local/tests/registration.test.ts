import type { ErbIndex, InlineCompletionSourceContribution, Plugin, PluginContext, SlotMap, SlotName } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import { createInlineCompletionLocalPlugin } from '../src/index';
import { LOCAL_SOURCE_ID, LOCAL_SOURCE_ORDER } from '../src/provider';
import { fakeIndex, requestAt } from './fixtures';

/**
 * 注册面自证（B 线 · IC 批）：插件激活后，槽 `completion.source` 里**确实有这一家**，
 * 且从槽里拿到的那枚贡献就能把候选算出来。
 *
 * 为什么单独钉这一份：判定逻辑（`provider.test.ts`）全绿、注册面却没接上，是本仓最典型的
 * "测试绿着但功能不在"（宿主问的是槽，不是 import）。这里刻意**不引内核**（解耦审计 B 项
 * 对插件目录全量生效，测试也一样），而是手写一份与 `SlotRegistryImpl` 同语义的最小注册表
 * （按 `order` 升序 + 同 id 冲突报错 + 注入 `pluginId`）——用真内核会让本包的测试
 * 依赖内核实现细节，而那正是插件不该有的知识。
 */

class MiniSlots {
  readonly entries: { item: SlotMap[SlotName]; pluginId: string; raw: SlotMap[SlotName] }[] = [];
  /**
   * 真内核由 `PluginContext.slots` 那一层绑定 plugin id（`SlotRegistryImpl.register(slot, item,
   * pluginId)`），插件自己**只传两个参数**。这份替身把第三参默认成被激活的那家，
   * 于是本包能证的两件事分开钉：
   * ①插件交出来的那枚贡献**没有自带** `pluginId`（不替内核伪造命名空间）；
   * ②查询结果里带上了注入的 id（宿主拿它加命名空间这条纪律成立）。
   */
  register<S extends SlotName>(slot: S, item: SlotMap[S], pluginId = 'inline-completion-local'): () => void {
    expect(slot).toBe('completion.source');
    if (this.entries.some((e) => e.item.id === item.id)) throw new Error(`槽位 id 冲突：${item.id}`);
    const stored = { item: { ...item, pluginId } as SlotMap[SlotName], pluginId, raw: item };
    this.entries.push(stored);
    return () => {
      const at = this.entries.findIndex((e) => e.item.id === item.id);
      if (at >= 0) this.entries.splice(at, 1);
    };
  }
  query<S extends SlotName>(slot: S): ReadonlyArray<SlotMap[S]> {
    return this.entries.map((e) => e.item as SlotMap[S]);
  }
  rawOf(id: string): SlotMap[SlotName] | undefined {
    return this.entries.find((e) => e.item.id === id)?.raw;
  }
}

/** 造一份插件上下文（只放本包真会碰的那几枚：log / slots / tryInject） */
function harness(opts: { index?: ErbIndex | null; throwOnState?: boolean } = {}) {
  const slots = new MiniSlots();
  const logs: string[] = [];
  // 显式判 `undefined` 而不是 `??`：`index: null` 是这一份夹具要表达的**一种状态**
  // （名录缺席），`?? ` 会把它静默换成"有名录"，那条 failed 闸就成了空匹配。
  const index: ErbIndex | null = opts.index === undefined ? fakeIndex({ functions: ['M_KOJO_SAMPLE'] }) : opts.index;
  const ctx = {
    pluginId: 'inline-completion-local',
    log: {
      info: (m: string) => logs.push(`info:${m}`),
      warn: (m: string) => logs.push(`warn:${m}`),
      error: (m: string) => logs.push(`error:${m}`),
    },
    slots,
    tryInject: (key: string) =>
      key === 'erb.parser'
        ? {
            currentIndex: () => index,
            indexState: () => {
              if (opts.throwOnState === true) throw new Error('事实面坏了');
              return { phase: 'ready', filesScanned: 10, functions: 1, rootsWalked: 1, sources: [], coverage: 'full' };
            },
          }
        : undefined,
    bus: { on: () => () => undefined, emit: () => undefined },
    storage: {},
    provide: () => undefined,
    inject: () => undefined,
    onDispose: () => undefined,
  } as unknown as PluginContext;
  return { ctx, slots, logs, index };
}

function contributed(slots: MiniSlots): InlineCompletionSourceContribution | undefined {
  return slots.query('completion.source').find((item) => item.id === LOCAL_SOURCE_ID);
}

describe('激活与注册', () => {
  it('activate 后槽 completion.source 里有本包那枚贡献', () => {
    const { ctx, slots, logs } = harness();
    createInlineCompletionLocalPlugin().activate(ctx);
    const contribution = contributed(slots);
    expect(contribution).toBeDefined();
    expect(contribution!.title.length).toBeGreaterThan(0);
    expect(contribution!.order).toBe(LOCAL_SOURCE_ORDER);
    expect(logs.some((l) => l.includes('completion.source'))).toBe(true);
  });

  it('pluginId 由内核注入、本包不自带（宿主拿它给 id 加命名空间）', () => {
    const { ctx, slots } = harness();
    createInlineCompletionLocalPlugin().activate(ctx);
    expect(contributed(slots)!.pluginId).toBe('inline-completion-local');
    // 插件交出去的那枚原始贡献**没有** pluginId —— 那一格是内核的，不是供方的
    expect('pluginId' in (slots.rawOf(LOCAL_SOURCE_ID) as object)).toBe(false);
  });

  it('从槽里取到的那枚就能算出候选（注册面与判定面之间没有第三层）', async () => {
    const { ctx, slots } = harness();
    createInlineCompletionLocalPlugin().activate(ctx);
    const outcome = await contributed(slots)!.provideInline(requestAt('@M_KOJO_SA', 'MPLE'));
    expect(outcome!.state).toBe('candidates');
    if (outcome!.state !== 'candidates') return;
    expect(outcome!.candidates[0]!.insertText).toBe('M_KOJO_SAMPLE');
    expect(outcome!.version).toBe(7);
  });

  it('deactivate 不必手动撤销槽位（内核负责）——本包也不自持任何需要清理的状态', () => {
    const plugin: Plugin = createInlineCompletionLocalPlugin();
    expect(plugin.deactivate).toBeUndefined();
  });
});

describe('插件清单面', () => {
  it('id / version 稳定；erb.parser 是**软**依赖（缺席时逐格说话，而不是整包 inactive）', () => {
    const plugin = createInlineCompletionLocalPlugin();
    expect(plugin.id).toBe('inline-completion-local');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.requires ?? []).toEqual([]);
    expect(plugin.optionalRequires).toEqual(['erb.parser']);
    expect(plugin.provides ?? []).toEqual([]);
  });

  it('erb.parser 缺席时不抛，激活照常完成（候选面走 failed 说话）', async () => {
    const slots = new MiniSlots();
    const ctx = {
      pluginId: 'inline-completion-local',
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      slots,
      tryInject: () => undefined,
      bus: { on: () => () => undefined, emit: () => undefined },
      storage: {},
      provide: () => undefined,
      inject: () => undefined,
      onDispose: () => undefined,
    } as unknown as PluginContext;
    createInlineCompletionLocalPlugin().activate(ctx);
    const outcome = await contributed(slots)!.provideInline(requestAt('@AEGI', ''));
    expect(outcome!.state).toBe('failed');
    if (outcome!.state !== 'failed') return;
    expect(outcome!.reason).toBe('parser-absent');
  });

  it('indexState 抛错只少一句读数，不改变判据（事实面不是判据面）', async () => {
    const { ctx, slots } = harness({ index: null, throwOnState: true });
    createInlineCompletionLocalPlugin().activate(ctx);
    const outcome = await contributed(slots)!.provideInline(requestAt('@AEGI', ''));
    expect(outcome!.state).toBe('failed');
    if (outcome!.state !== 'failed') return;
    expect(outcome!.reason).toBe('index-unknown');
  });

  it('测试注入的 indexSource 让本包脱离真服务也能验（宿主接线不因此变复杂）', async () => {
    const slots = new MiniSlots();
    const index = fakeIndex({ functions: ['注入函数'] });
    const ctx = {
      pluginId: 'inline-completion-local',
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      slots,
      tryInject: () => undefined,
      bus: { on: () => () => undefined, emit: () => undefined },
      storage: {},
      provide: () => undefined,
      inject: () => undefined,
      onDispose: () => undefined,
    } as unknown as PluginContext;
    createInlineCompletionLocalPlugin({ indexSource: () => index }).activate(ctx);
    const outcome = await contributed(slots)!.provideInline(requestAt('@注入', '函数'));
    expect(outcome!.state).toBe('candidates');
  });
});
