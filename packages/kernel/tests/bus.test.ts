import { describe, expect, it, vi } from 'vitest';
import { TypedEventBus } from '../src/bus';

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

  it('emit 期间退订其它 handler：本轮快照不受影响，下一轮生效', () => {
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
    expect(calls).toEqual(['first', 'second']); // 快照迭代：second 本轮仍执行

    calls.length = 0;
    bus.emit('file.changed', { kind: 'add', path: 'a' });
    expect(calls).toEqual(['first']); // 退订在下一轮生效
  });
});
