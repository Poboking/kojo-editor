import type {
  Logger,
  Plugin,
  PluginContext,
  PluginStateRecord,
  PluginStatus,
  ScopedStorage,
  ServiceKey,
  SlotRegistrar,
} from '@kojo/plugin-api';
import { scopedBus, type TypedEventBus } from './bus';
import { ServiceContainer } from './container';
import type { SlotRegistryImpl } from './slots';

/**
 * 插件运行时：注册 → 依赖解析 → 激活 → 停用，全程状态可观测。
 *
 * 与 cordis 的关键差异（教训直接来自 DSH 桌面版实践）：
 * 1. **inactive 永远是"暂时"的**：依赖未满足不静默（cordis 的 __INACTIVE__ 死锁教训），
 *    状态面板强制显示 missing 列表；任何一次依赖变化都会触发重扫（tryActivateAll），
 *    满足即自动激活。
 * 2. **停用彻底可逆**：deactivate → 逆序执行 disposer → 撤销槽位注册 → 释放服务。
 *    开发工具必须做到热重载插件，否则迭代效率极差（DSH"改插件必须完全重启"的教训）。
 * 3. **错误隔离**：activate 抛错 → 状态转 error（含堆栈摘要），其余插件继续接线；
 *    activate 内已收集的副作用自动回滚。
 */

export interface PluginRuntimeDeps {
  container: ServiceContainer;
  bus: TypedEventBus;
  slots: SlotRegistryImpl;
  storageScope: (pluginId: string) => ScopedStorage;
  logFactory: (pluginId: string) => Logger;
  /** 内核日志（用于运行时自身事件） */
  kernelLog: Logger;
}

interface PluginStateInternal {
  record: PluginStateRecord;
  plugin: Plugin;
  ctx: PluginContext | null;
  disposers: Array<() => void | Promise<void>>;
  provided: Set<ServiceKey>;
}

export class PluginRuntime {
  private readonly states = new Map<string, PluginStateInternal>();
  private activatingDepth = 0;

  constructor(private readonly deps: PluginRuntimeDeps) {}

  /* --------------------------- 注册与查询 --------------------------- */

  register(plugin: Plugin): void {
    if (this.states.has(plugin.id)) {
      throw new Error(`Plugin '${plugin.id}' is already registered`);
    }
    this.states.set(plugin.id, {
      record: { id: plugin.id, version: plugin.version, status: 'pending' },
      plugin,
      ctx: null,
      disposers: [],
      provided: new Set(),
    });
    this.emitStatusChanged(plugin.id, 'pending');
  }

  list(): PluginStateRecord[] {
    return [...this.states.values()].map((s) => ({ ...s.record, missing: s.record.missing ? [...s.record.missing] : undefined }));
  }

  get(id: string): PluginStateRecord | undefined {
    const s = this.states.get(id);
    return s ? { ...s.record } : undefined;
  }

  /* ------------------------------ 接线 ------------------------------ */

  /** 静态环检测：requires 图上的环内插件全部置 error（不做静默悬挂） */
  detectCycles(): void {
    const provider = new Map<ServiceKey, string>();
    for (const s of this.states.values()) {
      for (const key of s.plugin.provides ?? []) provider.set(key, s.plugin.id);
    }
    const edges = new Map<string, string[]>();
    for (const s of this.states.values()) {
      const targets = new Set<string>();
      for (const key of s.plugin.requires ?? []) {
        const pid = provider.get(key);
        if (pid && pid !== s.plugin.id) targets.add(pid);
        else if (pid === s.plugin.id) targets.add(pid); // 自环
      }
      edges.set(s.plugin.id, [...targets]);
    }
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    const stack: string[] = [];
    const inCycle = new Set<string>();
    const visit = (u: string): void => {
      color.set(u, GRAY);
      stack.push(u);
      for (const v of edges.get(u) ?? []) {
        if (!this.states.has(v)) continue;
        const c = color.get(v) ?? WHITE;
        if (c === GRAY) {
          const i = stack.indexOf(v);
          for (let j = i; j >= 0 && j < stack.length; j++) inCycle.add(stack[j]!);
        } else if (c === WHITE) {
          visit(v);
        }
      }
      stack.pop();
      color.set(u, BLACK);
    };
    for (const id of this.states.keys()) {
      if ((color.get(id) ?? WHITE) === WHITE) visit(id);
    }
    for (const id of inCycle) {
      const s = this.states.get(id)!;
      if (s.record.status !== 'error') {
        this.setStatus(id, 'error', {
          error: 'circular dependency detected (see provides/requires graph)',
        });
      }
    }
  }

  /**
   * 全量尝试激活：反复扫描直到没有新进展。
   * 幂等、可重入（重入时直接返回，避免 activate 内再触发）。
   */
  async tryActivateAll(): Promise<void> {
    if (this.activatingDepth > 0) return;
    this.activatingDepth++;
    try {
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const [id, state] of this.states) {
          const status = state.record.status;
          if (status !== 'pending' && status !== 'inactive') continue;
          const missing = (state.plugin.requires ?? []).filter((k) => !this.deps.container.has(k));
          if (missing.length > 0) {
            this.setStatus(id, 'inactive', { missing });
            continue;
          }
          await this.activateOne(id);
          progressed = true;
        }
      }
    } finally {
      this.activatingDepth--;
    }
  }

  /** 手动重试（状态面板的"重试"按钮）；效果等价于一次全量重扫 */
  async retry(id: string): Promise<void> {
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown plugin '${id}'`);
    if (state.record.status === 'active') return;
    if (state.record.status === 'error') {
      // 清除错误让重扫有机会覆盖（原因可能已被修复）
      this.setStatus(id, 'pending');
    }
    await this.tryActivateAll();
  }

  /* ------------------------------ 激活 ------------------------------ */

  private async activateOne(id: string): Promise<void> {
    const state = this.states.get(id)!;
    const plugin = state.plugin;
    const disposers: Array<() => void | Promise<void>> = [];
    const provided = new Set<ServiceKey>();

    const log = this.deps.logFactory(plugin.id);
    const bus = scopedBus(this.deps.bus, plugin.id, (msg) => log.warn(msg));

    const slots: SlotRegistrar = {
      register: (slot, item) => {
        const un = this.deps.slots.register(slot, item, plugin.id);
        disposers.push(un);
        return un;
      },
    };

    const ctx: PluginContext = {
      pluginId: plugin.id,
      log,
      bus,
      storage: this.deps.storageScope(plugin.id),
      slots,
      provide: (key, value) => {
        if (!(plugin.provides ?? []).includes(key)) {
          throw new Error(
            `Plugin '${plugin.id}' called provide('${key}') but did not declare it in provides[]. ` +
              'Declare it so dependency ordering and conflict detection keep working.',
          );
        }
        if (provided.has(key)) throw new Error(`Plugin '${plugin.id}' provided '${key}' twice`);
        this.deps.container.provide(key, value, plugin.id);
        provided.add(key);
        disposers.push(() => this.deps.container.remove(key, plugin.id));
      },
      inject: <T = unknown>(key: ServiceKey): T => {
        const value = this.deps.container.tryGet<T>(key);
        if (value === undefined) {
          throw new Error(`Service '${key}' is not available (required by '${plugin.id}')`);
        }
        return value;
      },
      tryInject: <T = unknown>(key: ServiceKey): T | undefined => this.deps.container.tryGet<T>(key),
      onDispose: (fn) => {
        disposers.push(fn);
      },
    };

    try {
      await plugin.activate(ctx);
      state.ctx = ctx;
      state.disposers = disposers;
      state.provided = provided;
      this.setStatus(id, 'active');
    } catch (err) {
      // 回滚激活过程中已收集的副作用
      await this.runDisposers(disposers, id);
      this.setStatus(id, 'error', { error: errorSummary(err) });
    }
  }

  /* ------------------------------ 停用 ------------------------------ */

  async stop(id: string): Promise<void> {
    const state = this.states.get(id);
    if (!state || state.record.status !== 'active') return;
    try {
      await state.plugin.deactivate?.();
    } catch (err) {
      this.deps.kernelLog.warn(`Plugin '${id}' deactivate() threw: ${errorSummary(err)}`);
    }
    await this.runDisposers(state.disposers, id);
    state.disposers = [];
    state.ctx = null;
    state.provided.clear();
    this.deps.slots.removeAllFor(id);
    this.setStatus(id, 'stopped');
  }

  async stopAll(): Promise<void> {
    // 逆注册序停用（后启动的可能是先启动者的消费者）
    const activeIds = [...this.states.values()]
      .filter((s) => s.record.status === 'active')
      .map((s) => s.plugin.id)
      .reverse();
    for (const id of activeIds) await this.stop(id);
  }

  private async runDisposers(disposers: Array<() => void | Promise<void>>, pluginId: string): Promise<void> {
    for (const fn of [...disposers].reverse()) {
      try {
        await fn();
      } catch (err) {
        this.deps.kernelLog.warn(`Disposer of plugin '${pluginId}' threw: ${errorSummary(err)}`);
      }
    }
  }

  /* ------------------------------ 内部 ------------------------------ */

  private setStatus(id: string, status: PluginStatus, extra?: { missing?: ServiceKey[]; error?: string }): void {
    const state = this.states.get(id);
    if (!state) return;
    state.record = {
      ...state.record,
      status,
      missing: extra?.missing,
      error: extra?.error,
    };
    this.emitStatusChanged(id, status);
  }

  private emitStatusChanged(pluginId: string, status: PluginStatus): void {
    // 内核自身事件：始终用原始总线（scopedBus 只约束插件）
    try {
      this.deps.bus.emit('plugin.statusChanged', { pluginId, status });
    } catch {
      /* 状态事件自身不得引发级联故障 */
    }
  }
}

function errorSummary(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

