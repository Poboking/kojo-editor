import { KERNEL_EVENT_NAMES } from '@kojo/plugin-api';
import type { AnyEventMap, EventBus, KernelEventName, Unsubscribe } from '@kojo/plugin-api';

// 事件 emit 权限白名单已归一至契约层（plugin-api/src/events.ts）：与 KernelEventMap
// 同文件维护 + 编译期分类完整性断言（KERNEL_EVENT_CLASSIFICATION_GUARD）。
// 根治 0bf2eb9 式双源漂移——此前本文件持有一份手工同步的清单，契约加了类型而
// 白名单漏同步，插件 emit 被拦截抛错、向导命令链断裂（只在运行时暴露）。
// 此处 re-export 保持既有导入路径（kernel/src/index.ts → './bus'）不变。
export { KERNEL_EVENT_NAMES } from '@kojo/plugin-api';
export type { KernelEventName } from '@kojo/plugin-api';

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
    const key = type as string;
    const set = this.handlers.get(key);
    if (!set || set.size === 0) return;
    // 快照迭代：允许 handler 在本轮里订阅/退订（改集合本身不会炸迭代器）。
    // 但**被本轮更早的 handler 退订掉的那一个不得再被调用**——它已经表态说
    // "我不要再收事件"，再叫它跑就会作用在已拆除的状态上（2026-10-17 修复）。
    // 若整组被清空（键被删）或换成新集合（全清后重订阅），剩余快照一律作废。
    for (const handler of [...set]) {
      if (this.handlers.get(key) !== set) break; // 键已删/已换集合 ⇒ 本轮到此为止
      if (!set.has(handler)) continue; // 本轮内已被退订 ⇒ 跳过
      try {
        handler(payload);
      } catch (err) {
        this.onHandlerError?.(key, err);
      }
    }
  }

  /** 调试辅助：当前订阅数 */
  listenerCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}

/** 一次作用域释放的结果（可观测：释放了多少、有多少退订自身抛错） */
export interface BusScopeRelease {
  released: number;
  failed: number;
}

/**
 * scopedBus 订阅登记表：`基础总线 → (插件 id → 该插件经本作用域拿到的全部退订句柄)`。
 *
 * 为什么需要它：`EventBus` 契约没有"批量退订"，而插件的 `on/once` 句柄一旦丢掉就永远
 * 退不掉——停用/激活失败后重激活会**再注册一份**，双份 handler 跑在已拆除的状态上
 * （铁律 #4：不许静默留脏）。登记表按插件 id 归口，运行时停谁就清谁的订阅。
 * WeakMap 键 ⇒ 总线被回收时登记表一并回收，本身不泄漏。
 */
const busScopes = new WeakMap<EventBus, Map<string, Set<Unsubscribe>>>();

function scopeSetFor(bus: EventBus, pluginId: string): Set<Unsubscribe> {
  let byPlugin = busScopes.get(bus);
  if (!byPlugin) {
    byPlugin = new Map();
    busScopes.set(bus, byPlugin);
  }
  let set = byPlugin.get(pluginId);
  if (!set) {
    set = new Set();
    byPlugin.set(pluginId, set);
  }
  return set;
}

/**
 * 释放某插件在指定总线上登记的全部 `on/once` 订阅（幂等：再次调用返回 0）。
 * 退订句柄自身抛错不中断清理，只计入 `failed` 由调用方呈现。
 */
export function disposeBusScope(bus: EventBus, pluginId: string): BusScopeRelease {
  const set = busScopes.get(bus)?.get(pluginId);
  if (!set || set.size === 0) return { released: 0, failed: 0 };
  const handles = [...set];
  set.clear(); // 先摘表：退订动作自身不得回灌登记表
  let failed = 0;
  for (const un of handles) {
    try {
      un();
    } catch {
      failed++;
    }
  }
  return { released: handles.length, failed };
}

/** 某插件当前登记的订阅句柄数（诊断/测试面） */
export function busScopeSize(bus: EventBus, pluginId: string): number {
  return busScopes.get(bus)?.get(pluginId)?.size ?? 0;
}

/** `scopedBus` 的返回值：EventBus 的超集（既有消费方按 EventBus 用，零改动） */
export interface ScopedBus extends EventBus {
  /** 释放本插件在本总线上的全部订阅（stopDirect / activate 回滚路径调用） */
  disposeScope(): BusScopeRelease;
  /** 本插件当前登记的订阅句柄数 */
  scopeSize(): number;
}

/**
 * 插件视角的总线包装：
 * - `on/once` 原样透传（消费者可订阅任意事件），并把拿到的退订句柄按插件 id 登记，
 *   供 `disposeBusScope` / `disposeScope()` 在停用与激活失败回滚时统一释放；
 * - `emit` 强制命名空间纪律：内核事件之外的 emit 必须携带 `插件id:` 前缀，
 *   违反即抛错（把"约定"升格为内核保障，对应 DSH 的事件命名空间约定）。
 */
export function scopedBus(bus: EventBus, pluginId: string, onViolation?: (message: string) => void): ScopedBus {
  const prefix = `${pluginId}:`;
  /** 登记一次订阅拿到的句柄（每次都在登记表里查，跨多次 scopedBus 调用共享同一份名单） */
  const track = (un: Unsubscribe): Unsubscribe => {
    scopeSetFor(bus, pluginId).add(un);
    return un;
  };
  return {
    on: (type, handler) => track(bus.on(type, handler)),
    once: (type, handler) => track(bus.once(type, handler)),
    emit: (type, payload) => {
      const t = type as string;
      if (!KERNEL_EVENT_NAMES.has(t as KernelEventName) && !t.startsWith(prefix)) {
        const message = `Plugin '${pluginId}' tried to emit event '${t}' without its '${prefix}' prefix`;
        // onViolation 只负责可观测性（记日志），不得吞掉事件：
        // 违规必须显式失败，否则插件会误以为事件已发出（对应 DSH 事件命名空间约定）。
        onViolation?.(message);
        throw new Error(message);
      }
      bus.emit(type, payload);
    },
    disposeScope: () => disposeBusScope(bus, pluginId),
    scopeSize: () => busScopeSize(bus, pluginId),
  };
}
