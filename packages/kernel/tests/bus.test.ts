import { describe, expect, it, vi } from 'vitest';
import {
  TypedEventBus,
  busScopeSize,
  disposeBusScope,
  scopedBus,
  type ScopedBus,
} from '../src/bus';

describe('TypedEventBus', () => {
  it('on/emit/unsubscribe 基本行为', () => {
    const bus = new TypedEventBus();
    const seen: number[] = [];
    const un = bus.on('file.changed', (p) => seen.push(p.kind.length));
    bus.emit('file.changed', { kind: 'change', path: 'a' });
    un();
    bus.emit('file.changed', { kind: 'add', path: 'b' });
    expect(seen).toEqual([6]);
  });

  it('once 只触发一次', () => {
    const bus = new TypedEventBus();
    const fn = vi.fn();
    bus.once('project.closed', fn);
    bus.emit('project.closed', { rootDir: 'x' });
    bus.emit('project.closed', { rootDir: 'x' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('单个 handler 抛错不影响其他 handler，错误上抛给 onHandlerError', () => {
    const errors: string[] = [];
    const bus = new TypedEventBus((type) => errors.push(type));
    const ok = vi.fn();
    bus.on('file.changed', () => {
      throw new Error('bad handler');
    });
    bus.on('file.changed', ok);
    expect(() => bus.emit('file.changed', { kind: 'add', path: 'a' })).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(errors).toEqual(['file.changed']);
  });

  it('emit 期间退订其它 handler：被退订的那一个本轮不再执行（快照只兜"改集合"不兜"已表态不要"）', () => {
    const bus = new TypedEventBus();
    const calls: string[] = [];
    let unSecond: () => void = () => {};
    // 先注册 first（执行时退订 second），后注册 second
    bus.on('file.changed', () => {
      calls.push('first');
      unSecond();
    });
    unSecond = bus.on('file.changed', () => calls.push('second'));

    bus.emit('file.changed', { kind: 'add', path: 'a' });
    expect(calls).toEqual(['first']); // second 在本轮里已被退订 ⇒ 不许再跑（它会作用在已拆除状态上）

    calls.length = 0;
    bus.emit('file.changed', { kind: 'add', path: 'a' });
    expect(calls).toEqual(['first']); // 下一轮同样收不到
  });

  it('emit 期间新订阅的 handler 本轮不被调用（快照语义保留）', () => {
    const bus = new TypedEventBus();
    const calls: string[] = [];
    bus.on('file.changed', () => {
      calls.push('first');
      bus.on('file.changed', () => calls.push('late'));
    });
    bus.emit('file.changed', { kind: 'add', path: 'a' });
    expect(calls).toEqual(['first']);
    calls.length = 0;
    bus.emit('file.changed', { kind: 'add', path: 'a' });
    expect(calls).toEqual(['first', 'late']);
  });

  it('handler 把该事件类型整个清空（键被删）⇒ 本轮剩余快照一律作废', () => {
    const bus = new TypedEventBus();
    const calls: string[] = [];
    let unA: () => void = () => {};
    let unB: () => void = () => {};
    let unC: () => void = () => {};
    unA = bus.on('file.changed', () => {
      calls.push('a');
      unA();
      unB();
      unC(); // 集合清空 ⇒ 内核把键删掉；后面的 b/c 不许再被叫
    });
    unB = bus.on('file.changed', () => calls.push('b'));
    unC = bus.on('file.changed', () => calls.push('c'));

    bus.emit('file.changed', { kind: 'add', path: 'a' });
    expect(calls).toEqual(['a']);
    expect(bus.listenerCount('file.changed')).toBe(0);
  });

  it('清空后立刻重订阅（换成新集合）⇒ 旧快照不混入新集合的 handler', () => {
    const bus = new TypedEventBus();
    const calls: string[] = [];
    let unOld: () => void = () => {};
    unOld = bus.on('file.changed', () => {
      calls.push('old');
      unOld(); // 键被删
      bus.on('file.changed', () => calls.push('fresh')); // 同一轮里换成新集合
    });
    bus.emit('file.changed', { kind: 'add', path: 'a' });
    expect(calls).toEqual(['old']); // 新建的订阅不参与本轮
    calls.length = 0;
    bus.emit('file.changed', { kind: 'add', path: 'a' });
    expect(calls).toEqual(['fresh']);
  });
});

describe('scopedBus · 插件订阅作用域（监听器泄漏治理）', () => {
  it('scopedBus 仍是 EventBus：on/once 照常收到事件', () => {
    const bus = new TypedEventBus();
    const scoped = scopedBus(bus, 'p1');
    const seen: unknown[] = [];
    scoped.on('file.changed', (p) => seen.push(p));
    bus.emit('file.changed', { kind: 'add', path: 'a' });
    expect(seen).toHaveLength(1);
    expect(scoped.scopeSize()).toBe(1);
  });

  it('disposeScope 一次性放掉该插件的全部 on/once（含 once 包装），总线订阅数归零', () => {
    const bus = new TypedEventBus();
    const scoped = scopedBus(bus, 'p1');
    const calls: string[] = [];
    scoped.on('file.changed', () => calls.push('on'));
    scoped.once('project.closed', () => calls.push('once'));
    expect(bus.listenerCount('file.changed')).toBe(1);

    const released = scoped.disposeScope();
    expect(released).toEqual({ released: 2, failed: 0 });
    expect(bus.listenerCount('file.changed')).toBe(0);
    expect(bus.listenerCount('project.closed')).toBe(0);

    bus.emit('file.changed', { kind: 'add', path: 'a' });
    bus.emit('project.closed', { rootDir: 'x' });
    expect(calls).toEqual([]);
    // 幂等：再放一次 nothing
    expect(scoped.disposeScope()).toEqual({ released: 0, failed: 0 });
  });

  it('disposeBusScope 按插件 id 归口：只清自己，别的插件订阅照收', () => {
    const bus = new TypedEventBus();
    const a = scopedBus(bus, 'a');
    const b = scopedBus(bus, 'b');
    const calls: string[] = [];
    a.on('file.changed', () => calls.push('a'));
    b.on('file.changed', () => calls.push('b'));

    expect(disposeBusScope(bus, 'a')).toEqual({ released: 1, failed: 0 });
    bus.emit('file.changed', { kind: 'add', path: 'a' });
    expect(calls).toEqual(['b']);
  });

  it('重激活不叠 handler：上一轮订阅释放后再注册，同一个事件只处理一次', () => {
    const bus = new TypedEventBus();
    let handled = 0;
    const activate = (): ScopedBus => {
      const scoped = scopedBus(bus, 'p1');
      scoped.on('file.changed', () => handled++);
      return scoped;
    };
    const first = activate();
    bus.emit('file.changed', { kind: 'add', path: 'a' });
    expect(handled).toBe(1);

    first.disposeScope();
    activate(); // 重激活：重新注册
    bus.emit('file.changed', { kind: 'add', path: 'a' });
    expect(handled).toBe(2); // 只多了一次，不是两次
    expect(busScopeSize(bus, 'p1')).toBe(1);
  });

  it('泄漏引用（停用后又经旧 ctx.bus 订阅）仍会被下一次释放收掉', () => {
    const bus = new TypedEventBus();
    const scoped = scopedBus(bus, 'p1');
    scoped.on('file.changed', () => {});
    const leaked = scopedBus(bus, 'p1'); // 第二轮激活的新句柄
    leaked.on('file.changed', () => {});
    expect(busScopeSize(bus, 'p1')).toBe(2);
    expect(disposeBusScope(bus, 'p1')).toEqual({ released: 2, failed: 0 });
    expect(bus.listenerCount('file.changed')).toBe(0);
  });
});
