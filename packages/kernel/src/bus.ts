import type { AnyEventMap, EventBus, Unsubscribe } from '@kojo/plugin-api';

export type KernelEventName =
  | 'file.changed'
  | 'project.opened'
  | 'project.closed'
  | 'kojo.functionChanged'
  | 'plugin.statusChanged'
  | 'state.snapshotLoaded'
  | 'editor.revealLocation'
  | 'kojo.replayFunction'
  | 'kojo.snapshotSelected';

export const KERNEL_EVENT_NAMES: ReadonlySet<string> = new Set<KernelEventName>([
  'file.changed',
  'project.opened',
  'project.closed',
  'kojo.functionChanged',
  'plugin.statusChanged',
  'state.snapshotLoaded',
  'editor.revealLocation',
  'kojo.replayFunction',
  'kojo.snapshotSelected',
]);

type Handler = (payload: unknown) => void;

/**
 * 类型化事件总线实现。
 *
 * 错误隔离：单个 handler 抛错不会中断其余 handler，
 * 错误上抛给内核注入的 onHandlerError（记录日志），保证一个坏插件不炸全树。
 */
export class TypedEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<Handler>>();

  constructor(private readonly onHandlerError?: (eventType: string, error: unknown) => void) {}

  on<K extends keyof AnyEventMap>(type: K, handler: (payload: AnyEventMap[K]) => void): Unsubscribe {
    const key = type as string;
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    const h = handler as Handler;
    set.add(h);
    return () => {
      set.delete(h);
      if (set.size === 0) this.handlers.delete(key);
    };
  }

  once<K extends keyof AnyEventMap>(type: K, handler: (payload: AnyEventMap[K]) => void): Unsubscribe {
    let fired = false;
    const un = this.on(type, (payload) => {
      if (fired) return;
      fired = true;
      un();
      handler(payload);
    });
    return un;
  }

  emit<K extends keyof AnyEventMap>(type: K, payload: AnyEventMap[K]): void {
    const set = this.handlers.get(type as string);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        this.onHandlerError?.(type as string, err);
      }
    }
  }

  /** 调试辅助：当前订阅数 */
  listenerCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}

/**
 * 插件视角的总线包装：
 * - `on/once` 原样透传（消费者可订阅任意事件）；
 * - `emit` 强制命名空间纪律：内核事件之外的 emit 必须携带 `插件id:` 前缀，
 *   违反即抛错（把"约定"升格为内核保障，对应 DSH 的事件命名空间约定）。
 */
export function scopedBus(bus: EventBus, pluginId: string, onViolation?: (message: string) => void): EventBus {
  const prefix = `${pluginId}:`;
  return {
    on: (type, handler) => bus.on(type, handler),
    once: (type, handler) => bus.once(type, handler),
    emit: (type, payload) => {
      const t = type as string;
      if (!KERNEL_EVENT_NAMES.has(t) && !t.startsWith(prefix)) {
        const message = `Plugin '${pluginId}' tried to emit event '${t}' without its '${prefix}' prefix`;
        // onViolation 只负责可观测性（记日志），不得吞掉事件：
        // 违规必须显式失败，否则插件会误以为事件已发出（对应 DSH 事件命名空间约定）。
        onViolation?.(message);
        throw new Error(message);
      }
      bus.emit(type, payload);
    },
  };
}
