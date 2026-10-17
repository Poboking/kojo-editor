import { describe, expect, it } from 'vitest';
import type { Logger, Plugin, PluginContext } from '@kojo/plugin-api';
import { busScopeSize, scopedBus, TypedEventBus } from '../src/bus';
import { ServiceContainer } from '../src/container';
import { PluginRuntime, type PluginRuntimeDeps } from '../src/runtime';
import { SlotRegistryImpl } from '../src/slots';
import { StorageServiceImpl } from '../src/storage';
import { MemoryStorageBackend } from './helpers/memory-storage';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeRuntime(): {
  runtime: PluginRuntime;
  container: ServiceContainer;
  bus: TypedEventBus;
  slots: SlotRegistryImpl;
} {
  const container = new ServiceContainer();
  const bus = new TypedEventBus();
  const slots = new SlotRegistryImpl();
  const storage = new StorageServiceImpl(new MemoryStorageBackend());
  const deps: PluginRuntimeDeps = {
    container,
    bus,
    slots,
    storageScope: (id) => storage.scope(id),
    logFactory: () => noopLogger,
    kernelLog: noopLogger,
  };
  return { runtime: new PluginRuntime(deps), container, bus, slots };
}

describe('PluginRuntime · 激活与依赖接线', () => {
  it('无依赖插件直接激活，provide 进入容器', async () => {
    const { runtime, container } = makeRuntime();
    runtime.register({
      id: 'a',
      version: '1.0.0',
      provides: ['svc.a'],
      activate(ctx) {
        ctx.provide('svc.a', { hello: 'world' });
      },
    });
    await runtime.tryActivateAll();
    expect(runtime.get('a')?.status).toBe('active');
    expect(container.get<{ hello: string }>('svc.a').hello).toBe('world');
  });

  it('依赖顺序：消费者在提供者之后激活并能 inject', async () => {
    const { runtime } = makeRuntime();
    const order: string[] = [];
    runtime.register({
      id: 'consumer',
      version: '1.0.0',
      requires: ['svc.base'],
      activate(ctx) {
        order.push('consumer');
        expect(ctx.inject<{ v: number }>('svc.base').v).toBe(42);
      },
    });
    runtime.register({
      id: 'provider',
      version: '1.0.0',
      provides: ['svc.base'],
      activate(ctx) {
        order.push('provider');
        ctx.provide('svc.base', { v: 42 });
      },
    });
    await runtime.tryActivateAll();
    expect(runtime.get('consumer')?.status).toBe('active');
    expect(order).toEqual(['provider', 'consumer']);
  });

  it('缺依赖 → inactive（携带 missing 列表）→ 满足后自动激活', async () => {
    const { runtime, container } = makeRuntime();
    let activated = false;
    runtime.register({
      id: 'needs',
      version: '1.0.0',
      requires: ['svc.later'],
      activate() {
        activated = true;
      },
    });
    await runtime.tryActivateAll();
    expect(runtime.get('needs')?.status).toBe('inactive');
    expect(runtime.get('needs')?.missing).toEqual(['svc.later']);
    expect(activated).toBe(false);

    // 模拟依赖稍后被提供（另一个插件激活）
    container.provide('svc.later', {}, 'external');
    await runtime.tryActivateAll();
    expect(runtime.get('needs')?.status).toBe('active');
    expect(activated).toBe(true);
  });

  it('循环依赖：环内插件全部 error，环外不受影响', async () => {
    const { runtime } = makeRuntime();
    runtime.register({
      id: 'x',
      version: '1.0.0',
      provides: ['svc.x'],
      requires: ['svc.y'],
      activate() {},
    });
    runtime.register({
      id: 'y',
      version: '1.0.0',
      provides: ['svc.y'],
      requires: ['svc.x'],
      activate() {},
    });
    runtime.register({
      id: 'ok',
      version: '1.0.0',
      activate() {},
    });
    runtime.detectCycles();
    await runtime.tryActivateAll();
    expect(runtime.get('x')?.status).toBe('error');
    expect(runtime.get('y')?.status).toBe('error');
    expect(runtime.get('ok')?.status).toBe('active');
  });

  it('activate 抛错 → error（含原因），已 provide 服务回滚，槽位无残留', async () => {
    const { runtime, container, slots } = makeRuntime();
    runtime.register({
      id: 'boom',
      version: '1.0.0',
      provides: ['svc.boom'],
      activate(ctx) {
        ctx.provide('svc.boom', {});
        ctx.slots.register('ui.panel', { id: 'p', title: 't', component: () => null });
        throw new Error('kaboom');
      },
    });
    await runtime.tryActivateAll();
    const st = runtime.get('boom');
    expect(st?.status).toBe('error');
    expect(st?.error).toContain('kaboom');
    expect(container.has('svc.boom')).toBe(false);
    expect(slots.query('ui.panel')).toHaveLength(0);
  });

  it('provide 未声明 → 报错进 error 状态（声明与注册双轨制）', async () => {
    const { runtime } = makeRuntime();
    runtime.register({
      id: 'undeclared',
      version: '1.0.0',
      activate(ctx) {
        ctx.provide('svc.sneaky', {});
      },
    });
    await runtime.tryActivateAll();
    expect(runtime.get('undeclared')?.status).toBe('error');
    expect(runtime.get('undeclared')?.error).toContain('did not declare');
  });

  it('服务冲突：两个插件提供同一 key，后来者 error，前者不受影响', async () => {
    const { runtime, container } = makeRuntime();
    runtime.register({
      id: 'first',
      version: '1.0.0',
      provides: ['svc.dup'],
      activate(ctx) {
        ctx.provide('svc.dup', { from: 'first' });
      },
    });
    runtime.register({
      id: 'second',
      version: '1.0.0',
      provides: ['svc.dup'],
      activate(ctx) {
        ctx.provide('svc.dup', { from: 'second' });
      },
    });
    await runtime.tryActivateAll();
    expect(runtime.get('first')?.status).toBe('active');
    expect(runtime.get('second')?.status).toBe('error');
    expect(container.get<{ from: string }>('svc.dup').from).toBe('first');
  });
});

describe('PluginRuntime · 停用与清理', () => {
  it('deactivate → disposer 逆序执行 → 服务释放 → 槽位撤销', async () => {
    const { runtime, container, slots } = makeRuntime();
    const log: string[] = [];
    runtime.register({
      id: 'lifecycle',
      version: '1.0.0',
      provides: ['svc.lc'],
      activate(ctx) {
        ctx.provide('svc.lc', {});
        ctx.onDispose(() => {
          log.push('d1');
        });
        ctx.onDispose(() => {
          log.push('d2');
        });
        ctx.slots.register('ui.panel', { id: 'panel1', title: 'T', component: () => null });
      },
      deactivate() {
        log.push('deactivate');
      },
    });
    await runtime.tryActivateAll();
    expect(runtime.get('lifecycle')?.status).toBe('active');
    expect(container.has('svc.lc')).toBe(true);
    expect(slots.query('ui.panel')).toHaveLength(1);

    await runtime.stop('lifecycle');
    expect(runtime.get('lifecycle')?.status).toBe('stopped');
    expect(log).toEqual(['deactivate', 'd2', 'd1']);
    expect(container.has('svc.lc')).toBe(false);
    expect(slots.query('ui.panel')).toHaveLength(0);
  });

  it('stopAll 逆注册序停用（消费者先于提供者）', async () => {
    const { runtime } = makeRuntime();
    const order: string[] = [];
    runtime.register({
      id: 'provider',
      version: '1.0.0',
      provides: ['svc.base'],
      activate(ctx) {
        ctx.provide('svc.base', {});
      },
      deactivate() {
        order.push('provider');
      },
    });
    runtime.register({
      id: 'consumer',
      version: '1.0.0',
      requires: ['svc.base'],
      activate() {},
      deactivate() {
        order.push('consumer');
      },
    });
    await runtime.tryActivateAll();
    await runtime.stopAll();
    expect(order).toEqual(['consumer', 'provider']);
  });

  it('BUG-1 方案 A：stop(提供者) 级联停用 active 依赖方，双方 deactivate 均被调用', async () => {
    const { runtime, container } = makeRuntime();
    const deactivated: string[] = [];
    runtime.register({
      id: 'provider',
      version: '1.0.0',
      provides: ['svc.x'],
      activate(ctx) {
        ctx.provide('svc.x', {});
      },
      deactivate() {
        deactivated.push('provider');
      },
    });
    runtime.register({
      id: 'consumer',
      version: '1.0.0',
      requires: ['svc.x'],
      activate() {},
      deactivate() {
        deactivated.push('consumer');
      },
    });
    await runtime.tryActivateAll();
    expect(runtime.get('consumer')?.status).toBe('active');

    await runtime.stop('provider');
    expect(runtime.get('provider')?.status).toBe('stopped');
    // 依赖方不再保持 active（悬空服务引用消除）
    expect(runtime.get('consumer')?.status).toBe('stopped');
    expect(deactivated).toEqual(['consumer', 'provider']); // 依赖方先停
    expect(container.has('svc.x')).toBe(false);
  });

  it('BUG-1：三级链 A→B→C，stop(A) 按 C、B、A 逆拓扑序停用', async () => {
    const { runtime } = makeRuntime();
    const order: string[] = [];
    const mk = (id: string, requires?: string[], provides?: string[]): Plugin => ({
      id,
      version: '1.0.0',
      requires,
      provides,
      activate(ctx) {
        for (const key of provides ?? []) ctx.provide(key, { id });
      },
      deactivate() {
        order.push(id);
      },
    });
    runtime.register(mk('a', undefined, ['svc.a']));
    runtime.register(mk('b', ['svc.a'], ['svc.b']));
    runtime.register(mk('c', ['svc.b'], ['svc.c']));
    await runtime.tryActivateAll();

    await runtime.stop('a');
    expect(runtime.get('a')?.status).toBe('stopped');
    expect(runtime.get('b')?.status).toBe('stopped');
    expect(runtime.get('c')?.status).toBe('stopped');
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('BUG-1：无依赖关系的旁观插件不受级联影响', async () => {
    const { runtime } = makeRuntime();
    runtime.register({ id: 'p', version: '1.0.0', provides: ['svc.p'], activate(ctx) { ctx.provide('svc.p', {}); } });
    runtime.register({ id: 'dep', version: '1.0.0', requires: ['svc.p'], activate() {} });
    runtime.register({ id: 'bystander', version: '1.0.0', activate() {} });
    await runtime.tryActivateAll();

    await runtime.stop('p');
    expect(runtime.get('dep')?.status).toBe('stopped');
    expect(runtime.get('bystander')?.status).toBe('active');
  });
});

describe('PluginRuntime · 状态事件与可观测性', () => {
  it('每次状态迁移都广播 plugin.statusChanged', async () => {
    const { runtime, bus } = makeRuntime();
    const seen: Array<{ pluginId: string; status: string }> = [];
    bus.on('plugin.statusChanged', (p) => seen.push({ ...p }));

    runtime.register({
      id: 'obs',
      version: '1.0.0',
      requires: ['svc.none'],
      activate() {},
    });
    await runtime.tryActivateAll();
    expect(seen.map((s) => s.status)).toContain('pending');
    expect(seen.map((s) => s.status)).toContain('inactive');
  });

  it('retry 可在错误原因排除后恢复激活', async () => {
    const { runtime, container } = makeRuntime();
    runtime.register({
      id: 'recover',
      version: '1.0.0',
      requires: ['svc.arrives'],
      activate() {},
    });
    await runtime.tryActivateAll();
    expect(runtime.get('recover')?.status).toBe('inactive');
    container.provide('svc.arrives', {}, 'external');
    await runtime.retry('recover');
    expect(runtime.get('recover')?.status).toBe('active');
  });

  it('retry 可复活 stopped 插件（「停用彻底可逆」的兑现路径；真重激活不是记账）', async () => {
    const { runtime } = makeRuntime();
    let activated = 0;
    runtime.register({
      id: 'revive',
      version: '1.0.0',
      activate() {
        activated++;
      },
    });
    await runtime.tryActivateAll();
    expect(runtime.get('revive')?.status).toBe('active');
    await runtime.stop('revive');
    expect(runtime.get('revive')?.status).toBe('stopped');
    await runtime.retry('revive');
    expect(runtime.get('revive')?.status).toBe('active');
    expect(activated).toBe(2);
  });
});

describe('PluginRuntime · 事件命名空间纪律', () => {
  it('scopedBus：带前缀事件放行；无前缀自定义事件被拦截并回调违规', () => {
    const bus = new TypedEventBus();
    const received: unknown[] = [];
    const violations: string[] = [];
    bus.on('p1:ok' as never, (p) => received.push(p));
    bus.on('x:y' as never, (p) => received.push(p));

    const scoped = scopedBus(bus, 'p1', (msg) => violations.push(msg));
    scoped.emit('p1:ok' as never, 1 as never);
    // 违规：无 'p1:' 前缀 —— 必须抛错而非静默丢弃
    expect(() => scoped.emit('x:y' as never, 2 as never)).toThrow(/without its 'p1:' prefix/);
    scoped.emit('plugin.statusChanged' as never, { pluginId: 'p1', status: 'active' } as never);

    expect(received).toEqual([1]); // 违规事件不得触发任何订阅
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("without its 'p1:' prefix");
  });
});

describe('PluginRuntime · 订阅生命周期（监听器泄漏治理）', () => {
  it('stop 释放该插件的全部 bus 订阅：停用后事件不再进已拆除的状态', async () => {
    const { runtime, bus } = makeRuntime();
    const hits: string[] = [];
    runtime.register({
      id: 'listener',
      version: '1.0.0',
      activate(ctx) {
        ctx.bus.on('file.changed', (p) => hits.push(p.path));
        ctx.bus.once('project.closed', () => hits.push('closed'));
      },
    });
    await runtime.tryActivateAll();
    bus.emit('file.changed', { kind: 'add', path: 'a' });
    expect(hits).toEqual(['a']);
    expect(bus.listenerCount('file.changed')).toBe(1);
    expect(busScopeSize(bus, 'listener')).toBe(2);

    await runtime.stop('listener');
    expect(bus.listenerCount('file.changed')).toBe(0);
    expect(bus.listenerCount('project.closed')).toBe(0);
    expect(busScopeSize(bus, 'listener')).toBe(0);
    bus.emit('file.changed', { kind: 'add', path: 'b' });
    expect(hits).toEqual(['a']); // 停用后再来的事件不进插件
  });

  it('级联停用同样逐个释放依赖方的订阅', async () => {
    const { runtime, bus } = makeRuntime();
    runtime.register({ id: 'provider', version: '1.0.0', provides: ['svc.p'], activate(ctx) { ctx.provide('svc.p', {}); } });
    runtime.register({
      id: 'dep',
      version: '1.0.0',
      requires: ['svc.p'],
      activate(ctx) {
        ctx.bus.on('file.changed', () => {});
      },
    });
    await runtime.tryActivateAll();
    expect(bus.listenerCount('file.changed')).toBe(1);
    await runtime.stop('provider');
    expect(runtime.get('dep')?.status).toBe('stopped');
    expect(bus.listenerCount('file.changed')).toBe(0);
  });

  it('activate 抛错 → 失败前登记的订阅一并回滚；retry 重激活只留一份 handler', async () => {
    const { runtime, bus } = makeRuntime();
    const hits: number[] = [];
    let attempts = 0;
    runtime.register({
      id: 'flaky',
      version: '1.0.0',
      activate(ctx) {
        attempts++;
        ctx.bus.on('file.changed', () => hits.push(attempts));
        if (attempts === 1) throw new Error('first attempt fails');
      },
    });
    await runtime.tryActivateAll();
    expect(runtime.get('flaky')?.status).toBe('error');
    expect(bus.listenerCount('file.changed')).toBe(0); // 回滚把失败前 on 的那份清掉了
    expect(busScopeSize(bus, 'flaky')).toBe(0);

    await runtime.retry('flaky');
    expect(runtime.get('flaky')?.status).toBe('active');
    bus.emit('file.changed', { kind: 'add', path: 'a' });
    expect(hits).toHaveLength(1); // 只有一份 handler 在跑，不是新旧两份
  });

  it('插件持有 ctx.bus 不放（引用泄漏）——停用仍按插件 id 归口收干净', async () => {
    const { runtime, bus } = makeRuntime();
    const held: PluginContext['bus'][] = [];
    runtime.register({
      id: 'hoarder',
      version: '1.0.0',
      activate(ctx) {
        held.push(ctx.bus);
        ctx.bus.on('file.changed', () => {});
      },
    });
    await runtime.tryActivateAll();
    held[0]!.on('file.changed', () => {}); // 停用后又用旧句柄加订阅（登记仍在同一插件 id 名下）
    expect(bus.listenerCount('file.changed')).toBe(2);
    await runtime.stop('hoarder');
    expect(bus.listenerCount('file.changed')).toBe(0);
  });
});

describe('PluginRuntime · 重扫记账（嵌套 tryActivateAll）', () => {
  it('激活期间嵌套重扫被记账：外层收尾时新注册的插件已就位，不停在 pending', async () => {
    const { runtime } = makeRuntime();
    const seen: string[] = [];
    runtime.register({
      id: 'host',
      version: '1.0.0',
      activate: async (ctx) => {
        // 模拟"激活里经 kernel.plugins.register 装了个新插件"的形态
        runtime.register({ id: 'late', version: '1.0.0', activate: () => { seen.push('late'); } });
        await runtime.tryActivateAll(); // 嵌套：不得被一句 return 丢掉
        expect(runtime.get('late')?.status).not.toBe('active'); // 嵌套调用不重入循环（防死锁）
      },
    });
    await runtime.tryActivateAll();
    expect(runtime.get('host')?.status).toBe('active');
    expect(runtime.get('late')?.status).toBe('active'); // 外层补扫把 pending 收干净
    expect(seen).toEqual(['late']);
  });

  it('statusChanged 同步处理里发起的嵌套重扫同样记账（不静默丢）', async () => {
    const { runtime, bus, container } = makeRuntime();
    let fired = false;
    const un = bus.on('plugin.statusChanged', (p) => {
      // 只在"被判 inactive 的那一刻"反应（register 时的 pending 广播不能算，那时外层还没开跑）
      if (fired || p.pluginId !== 'needs' || p.status !== 'inactive') return;
      fired = true;
      container.provide('svc.arrives', {}, 'external');
      void runtime.tryActivateAll(); // 同步嵌套（此刻外层循环还在跑）
    });
    runtime.register({
      id: 'needs',
      version: '1.0.0',
      requires: ['svc.arrives'],
      activate() {},
    });
    await runtime.tryActivateAll();
    un();
    expect(fired).toBe(true); // 反应确实发生在循环内
    expect(runtime.get('needs')?.status).toBe('active'); // 外层必须补那一轮
  });
});

describe('PluginRuntime · 状态记录不可外泄内部数组', () => {
  it('get() 的 missing 是拷贝：消费方 push/改写不腐蚀内核状态', async () => {
    const { runtime } = makeRuntime();
    runtime.register({ id: 'needs', version: '1.0.0', requires: ['svc.gone'], activate() {} });
    await runtime.tryActivateAll();
    const rec = runtime.get('needs')!;
    expect(rec.missing).toEqual(['svc.gone']);
    rec.missing!.push('svc.bogus');
    rec.missing![0] = 'hacked';
    expect(runtime.get('needs')?.missing).toEqual(['svc.gone']);
    expect(runtime.list().find((r) => r.id === 'needs')?.missing).toEqual(['svc.gone']);
  });
});
