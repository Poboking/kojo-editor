import type { ServiceKey } from '@kojo/plugin-api';

interface ServiceEntry {
  value: unknown;
  providerId: string;
}

/** 服务已存在错误（跨插件冲突） */
export class ServiceConflictError extends Error {
  constructor(
    public readonly key: ServiceKey,
    public readonly existingProvider: string,
    public readonly newProvider: string,
  ) {
    super(
      `Service '${key}' is already provided by '${existingProvider}'; plugin '${newProvider}' cannot provide it too`,
    );
    this.name = 'ServiceConflictError';
  }
}

/**
 * 服务容器（DI）。
 *
 * 设计取舍（对应架构文档 §3.1）：
 * - 冲突策略：同键二次 provide 由**不同**插件发起 → 抛错（插件进 error 状态、状态面板可见），
 *   不做静默覆盖——静默替换服务的行为变化是最难排查的一类插件事故；
 * - 实现插件在 `activate` 内注册实例（声明式 provides + 命令式 provide 双轨）。
 */
export class ServiceContainer {
  private readonly services = new Map<ServiceKey, ServiceEntry>();

  provide(key: ServiceKey, value: unknown, providerId: string): void {
    const existing = this.services.get(key);
    if (existing) {
      if (existing.providerId === providerId) {
        throw new Error(`Service '${key}' was provided twice by '${providerId}'`);
      }
      throw new ServiceConflictError(key, existing.providerId, providerId);
    }
    this.services.set(key, { value, providerId });
  }

  has(key: ServiceKey): boolean {
    return this.services.has(key);
  }

  tryGet<T = unknown>(key: ServiceKey): T | undefined {
    return this.services.get(key)?.value as T | undefined;
  }

  get<T = unknown>(key: ServiceKey): T {
    const entry = this.services.get(key);
    if (!entry) throw new Error(`Service '${key}' is not registered`);
    return entry.value as T;
  }

  /** 移除服务（仅允许移除该 provider 自己注册的） */
  remove(key: ServiceKey, providerId: string): void {
    const entry = this.services.get(key);
    if (entry && entry.providerId === providerId) {
      this.services.delete(key);
    }
  }

  /** 调试用：当前全部服务键与提供者 */
  describe(): Array<{ key: ServiceKey; providerId: string }> {
    return [...this.services.entries()].map(([key, e]) => ({ key, providerId: e.providerId }));
  }
}
