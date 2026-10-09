import type { Logger } from './base';
import type { EventBus } from './events';
import type { SlotRegistrar } from './slots';
import type { ScopedStorage } from './storage';

/**
 * 服务键。约定 `<domain>.<name>`，例如 `game.adapter`、`kernel.bus`。
 * 内核预定义键见 `KernelServices` / `WellKnownServices`。
 */
export type ServiceKey = string;

/**
 * 插件定义。
 *
 * 接线语义（借鉴 cordis 但更严格的方言）：
 * - `requires`     硬依赖：任一缺失 → 状态 `inactive`（**可见**，见下），依赖齐备后可自动激活；
 * - `optionalRequires` 软依赖：不阻塞激活；激活时若已存在会自动进入上下文；
 * - `provides`     声明本插件将提供的服务键（实际值在 activate() 内经 ctx.provide 注册）。
 *                  声明与注册双轨制的目的：声明用于启动期拓扑排序与冲突检测，注册用于实例绑定。
 *
 * 与 cordis 的关键差异（刻意设计）：
 * 依赖未满足时 cordis 静默不 apply，本内核把每个插件的状态强制暴露在状态面板
 * （`active / inactive(缺 X) / error(原因) / stopped`）——可观测性 > 优雅。
 */
export interface Plugin {
  /** 唯一 id。同时是：存储域命名空间、自定义事件前缀、日志前缀 */
  readonly id: string;
  readonly version: string;
  readonly requires?: readonly ServiceKey[];
  readonly optionalRequires?: readonly ServiceKey[];
  readonly provides?: readonly ServiceKey[];
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/** 插件运行状态 */
export type PluginStatus = 'pending' | 'active' | 'inactive' | 'error' | 'stopped';

/** 插件状态快照（供状态面板渲染） */
export interface PluginStateRecord {
  id: string;
  version: string;
  status: PluginStatus;
  /** status === 'inactive' 时：缺失的硬依赖键 */
  missing?: ServiceKey[];
  /** status === 'error' 时：人类可读的原因 */
  error?: string;
}

/**
 * 插件上下文：插件与内核交互的唯一入口。
 * 内核在 deactivate 时自动执行本 ctx 收集的全部 disposer（逆序）、撤销槽位注册、
 * 释放本插件提供的服务——插件代码无需（也无法）手动越权。
 */
export interface PluginContext {
  readonly pluginId: string;
  readonly log: Logger;
  readonly bus: EventBus;
  /** 自动限定到本插件命名空间的存储域 */
  readonly storage: ScopedStorage;
  /** 槽位注册（注册项绑定本插件 id；deactivate 时自动撤销） */
  readonly slots: SlotRegistrar;
  /** 注册本插件提供的服务；键必须在 plugin.provides 中声明 */
  provide<T = unknown>(key: ServiceKey, value: T): void;
  /** 取硬依赖（activate 时内核已保证存在） */
  inject<T = unknown>(key: ServiceKey): T;
  /** 取可选依赖或任意已注册服务；缺失返回 undefined */
  tryInject<T = unknown>(key: ServiceKey): T | undefined;
  /** 注册释放回调；deactivate 时逆序执行（先注册后执行） */
  onDispose(fn: () => void | Promise<void>): void;
}
