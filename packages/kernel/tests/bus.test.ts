import { describe, expect, it, vi } from 'vitest';
import { STICKY_EVENT_NAMES } from '@kojo/plugin-api';
import type { EventBus } from '@kojo/plugin-api';
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

describe('TypedEventBus · onSticky（可回放的最后一条）', () => {
  it('sticky 白名单只收「当前值」型小载荷；documentChanged 大文本刻意不收', () => {
    expect([...STICKY_EVENT_NAMES]).toEqual(['editor.activeFileChanged']);
    // 正文大文本常驻总线 = 第二份文档缓存（面板另有 LiveTextPool 的按需口径）
    expect([...STICKY_EVENT_NAMES]).not.toContain('editor.documentChanged');
  });

  it('先 emit（无人订阅也算）→ 后订阅 onSticky ⇒ 立即同步收到最后一条', () => {
    const bus = new TypedEventBus();
    bus.emit('editor.activeFileChanged', { filePath: 'C:\\p\\a.kojo' });
    const seen: Array<string | null> = [];
    bus.onSticky('editor.activeFileChanged', (p) => seen.push(p.filePath));
    expect(seen).toEqual(['C:\\p\\a.kojo']); // 订阅调用返回前就回放（同步）
  });

  it('只回放最后一条（覆盖式、不是历史流水）；后续 emit 照常更新且不重复投递', () => {
    const bus = new TypedEventBus();
    bus.emit('editor.activeFileChanged', { filePath: '/p/a.kojo' });
    bus.emit('editor.activeFileChanged', { filePath: '/p/b.kojo' });
    const seen: Array<string | null> = [];
    bus.onSticky('editor.activeFileChanged', (p) => seen.push(p.filePath));
    expect(seen).toEqual(['/p/b.kojo']); // 恰好一条
    bus.emit('editor.activeFileChanged', { filePath: null });
    expect(seen).toEqual(['/p/b.kojo', null]);
    expect(bus.listenerCount('editor.activeFileChanged')).toBe(1); // 回放不是第二份订阅
  });

  it('退订后不再回调（回放只发生在订阅那一刻）', () => {
    const bus = new TypedEventBus();
    bus.emit('editor.activeFileChanged', { filePath: '/p/a.kojo' });
    const seen: Array<string | null> = [];
    const un = bus.onSticky('editor.activeFileChanged', (p) => seen.push(p.filePath));
    un();
    bus.emit('editor.activeFileChanged', { filePath: '/p/b.kojo' });
    expect(seen).toEqual(['/p/a.kojo']);
    expect(bus.listenerCount('editor.activeFileChanged')).toBe(0);
  });

  it('非白名单事件不保留、不误回放（onSticky 等价 on）', () => {
    const bus = new TypedEventBus();
    bus.emit('file.changed', { kind: 'add', path: 'a' });
    const seen: string[] = [];
    bus.onSticky('file.changed', (p) => seen.push(p.path));
    expect(seen).toEqual([]); // 文件变更是一次性通知，不是"当前值"
    bus.emit('file.changed', { kind: 'change', path: 'b' });
    expect(seen).toEqual(['b']);
  });

  it('从未收到过该事件 ⇒ 不回放；on / once 行为不受影响', () => {
    const bus = new TypedEventBus();
    const onSeen: Array<string | null> = [];
    const onceSeen: Array<string | null> = [];
    const stickySeen: Array<string | null> = [];
    bus.on('editor.activeFileChanged', (p) => onSeen.push(p.filePath));
    bus.once('editor.activeFileChanged', (p) => onceSeen.push(p.filePath));
    bus.onSticky('editor.activeFileChanged', (p) => stickySeen.push(p.filePath));
    expect(stickySeen).toEqual([]); // 总线里还没有最后值
    bus.emit('editor.activeFileChanged', { filePath: '/p/a.kojo' });
    bus.emit('editor.activeFileChanged', { filePath: '/p/b.kojo' });
    expect(onSeen).toEqual(['/p/a.kojo', '/p/b.kojo']);
    expect(onceSeen).toEqual(['/p/a.kojo']);
    expect(stickySeen).toEqual(['/p/a.kojo', '/p/b.kojo']);
  });

  it('回放回调抛错不炸订阅方，错误走 onHandlerError（与派发同一待遇）', () => {
    const errors: string[] = [];
    const bus = new TypedEventBus((type) => errors.push(type));
    bus.emit('editor.activeFileChanged', { filePath: '/p/a.kojo' });
    const ok = vi.fn();
    let un: () => void = () => {};
    expect(() => {
      un = bus.onSticky('editor.activeFileChanged', () => {
        throw new Error('bad sticky handler');
      });
      bus.onSticky('editor.activeFileChanged', ok); // 前一个抛错不影响后一个订阅
    }).not.toThrow();
    expect(errors).toEqual(['editor.activeFileChanged']);
    expect(ok).toHaveBeenCalledTimes(1);
    un();
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

  it('scopedBus 透传 onSticky（回放照给）并登记句柄：disposeScope 一次收掉', () => {
    const bus = new TypedEventBus();
    bus.emit('editor.activeFileChanged', { filePath: '/p/a.kojo' });
    const scoped = scopedBus(bus, 'p1');
    const seen: Array<string | null> = [];
    scoped.onSticky('editor.activeFileChanged', (p) => seen.push(p.filePath));
    expect(seen).toEqual(['/p/a.kojo']); // 经插件包装层同样立即回放
    expect(busScopeSize(bus, 'p1')).toBe(1);
    bus.emit('editor.activeFileChanged', { filePath: '/p/b.kojo' });
    expect(seen).toEqual(['/p/a.kojo', '/p/b.kojo']);
    expect(scoped.disposeScope()).toEqual({ released: 1, failed: 0 });
    bus.emit('editor.activeFileChanged', { filePath: '/p/c.kojo' });
    expect(seen).toEqual(['/p/a.kojo', '/p/b.kojo']); // 停用即静默
    expect(bus.listenerCount('editor.activeFileChanged')).toBe(0);
  });

  it('底座总线没有 onSticky（旧替身）⇒ 退回 on：能听、无回放、不崩', () => {
    const listeners = new Map<string, Set<(p: unknown) => void>>();
    const raw = {
      on(type: string, handler: (p: unknown) => void): () => void {
        let set = listeners.get(type);
        if (!set) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(handler);
        return () => set!.delete(handler);
      },
      once(type: string, handler: (p: unknown) => void): () => void {
        return raw.on(type, handler);
      },
      emit(type: string, payload: unknown): void {
        for (const h of [...(listeners.get(type) ?? [])]) h(payload);
      },
    };
    const legacy = raw as unknown as EventBus;
    const scoped = scopedBus(legacy, 'p2');
    const seen: unknown[] = [];
    expect(() => scoped.onSticky('editor.activeFileChanged', (p) => seen.push(p))).not.toThrow();
    expect(seen).toEqual([]); // 旧底座没有回放能力：静默降级
    legacy.emit('editor.activeFileChanged', { filePath: '/p/a.kojo' });
    expect(seen).toHaveLength(1);
    scoped.disposeScope();
    legacy.emit('editor.activeFileChanged', { filePath: '/p/b.kojo' });
    expect(seen).toHaveLength(1);
  });
});
