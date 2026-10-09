import type { PluginStateRecord, ServiceKey } from './plugin';

/**
 * 内核预定义服务键（兼容性承诺：不改名）。
 */
export const KernelServices = {
  Bus: 'kernel.bus',
  IO: 'kernel.io',
  Storage: 'kernel.storage',
  Slots: 'kernel.slots',
  Plugins: 'kernel.plugins',
  Project: 'kernel.project',
} as const;

/**
 * 生态通用服务键（由插件提供；内核不感知具体实现）。
 */
export const WellKnownServices = {
  /** 当前激活的游戏适配器（消费者声明注入；单激活语义见 slots.ts） */
  GameAdapter: 'game.adapter',
  /** ERB 解析器服务 */
  ErbParser: 'erb.parser',
} as const;

export type KernelServiceKey = (typeof KernelServices)[keyof typeof KernelServices];
export type WellKnownServiceKey = (typeof WellKnownServices)[keyof typeof WellKnownServices];

/**
 * 插件注册表服务（内核 `kernel.plugins`）。
 * 状态面板与插件管理 UI 的数据源；内核保证数据永远可得（可观测性 > 优雅）。
 */
export interface PluginRegistry {
  list(): PluginStateRecord[];
  get(id: string): PluginStateRecord | undefined;
  /** 手动重试一个 inactive / error 插件（依赖已满足或原因已排除时使用） */
  retry(id: string): Promise<void>;
  /** 运行期注册并尝试激活新插件 */
  register(plugin: unknown): Promise<void>;
  /** 停用插件（含执行 deactivate 与清理） */
  stop(id: string): Promise<void>;
}

export type { ServiceKey };
