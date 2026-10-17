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
import { disposeBusScope, scopedBus, type TypedEventBus } from './bus';
import { ServiceContainer } from './container';
import type { SlotRegistryImpl } from './slots';

/**
 * 插件运行时：注册 → 依赖解析 → 激活 → 停用，全程状态可观测。
 *
 * 与 cordis 的关键差异（教训直接来自 DSH 桌面版实践）：
 * 1. **inactive 永远是"暂时"的**：依赖未满足不静默（cordis 的 __INACTIVE__ 死锁教训），
 *    状态面板强制显示 missing 列表；任何一次依赖变化都会触发重扫（tryActivateAll），
 *    满足即自动激活。
 * 2. **停用彻底可逆**：deactivate → 逆序执行 disposer → 撤销槽位注册 → 释放服务
 *    → **放掉该插件在总线上的全部订阅**（`bus.on/once` 句柄按插件 id 归口登记，
 *    停用/激活失败都收干净；否则重激活就是双份 handler 跑在已拆除的状态上）。
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
  /**
   * 嵌套 `tryActivateAll()` 的请求记账：激活过程中（同步 emit 的 statusChanged 处理里、
   * 或插件 activate 里经 `kernel.plugins.register`）再发起的重扫**不再被丢弃**，
   * 而是置这个旗，由外层 while 循环补一轮（2026-10-17 修复）。
   */
  private rescanRequested = false;

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
    return [...this.states.values()].map((s) => toRecord(s));
  }

  get(id: string): PluginStateRecord | undefined {
    const s = this.states.get(id);
    // 与 list() 同口径的深拷 missing：浅拷会把内部数组交出去，消费方 push/sort
    // 会当场篡改内核状态（2026-10-17 修复）
    return s ? toRecord(s) : undefined;
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
   * 幂等、可重入——重入不静默丢弃请求，而是置 `rescanRequested` 让外层补扫一轮
   * （2026-10-17 修复：此前 `if (depth>0) return` 会把「activate 期间注册的新插件」
   * 这类嵌套重扫整件事丢掉，新插件永远停在 pending）。
   */
  async tryActivateAll(): Promise<void> {
    if (this.activatingDepth > 0) {
      this.rescanRequested = true;
      return;
    }
    this.activatingDepth++;
    try {
      let progressed = true;
      while (progressed || this.rescanRequested) {
        // 补扫一轮由嵌套请求触发；本轮开始时先清旗，本轮内嵌套再置则再补一轮
        this.rescanRequested = false;
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
      this.rescanRequested = false;
    }
  }

  /** 手动重试；效果等价于一次全量重扫（注意：重扫会重新激活所有满足依赖的 inactive 插件） */
  async retry(id: string): Promise<void> {
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown plugin '${id}'`);
    if (state.record.status === 'active') return;
    if (state.record.status === 'error' || state.record.status === 'stopped') {
      // 清除错误 / 复活停用让重扫有机会覆盖（原因可能已被修复）。retry 是显式用户意图：
      // 类头注的「停用彻底可逆」此前没有兑现路径——stopped 对 tryActivateAll 不可见，
      // retry 是它唯一的复活通道（tryActivateAll 依旧不碰 stopped，不会连带拉起别的停用插件）。
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

    // 上一轮（失败激活 / 泄漏引用）残留的订阅先清干净：本插件的 `on/once` 必须
    // 从干净作用域起步，否则重激活就是双份 handler 跑在已拆除的状态上。
    this.releaseBusScope(id);

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
      // 回滚激活过程中已收集的副作用（含本作用域已登记的订阅——失败前 on 过的那些）
      await this.runDisposers(disposers, id);
      this.releaseBusScope(id);
      state.ctx = null;
      this.setStatus(id, 'error', { error: errorSummary(err) });
    }
  }

  /* ------------------------------ 停用 ------------------------------ */

  /**
   * 传递依赖闭包：所有 active 且（直接或间接）依赖 `rootId` 所提供服务的插件。
   * 依赖图 = requires × provides（服务键依赖；slot 消费关系当前不在图内——
   * SlotRegistry 未记录"谁消费了某 slot 项"，此边界见架构文档安全模型）。
   * 返回按 BFS 发现序（root 的直接依赖方在前）；停用时**逆序**执行（最深依赖方先停）。
   */
  private dependentsClosure(rootId: string): string[] {
    const providerOf = new Map<ServiceKey, string>();
    for (const s of this.states.values()) {
      for (const key of s.plugin.provides ?? []) {
        if (!providerOf.has(key)) providerOf.set(key, s.plugin.id);
      }
    }
    const discovered = [rootId];
    const seen = new Set<string>([rootId]);
    for (let i = 0; i < discovered.length; i++) {
      const cur = discovered[i]!;
      const curState = this.states.get(cur);
      if (!curState) continue;
      const providedKeys = new Set<ServiceKey>([
        ...(curState.plugin.provides ?? []),
        ...curState.provided,
      ]);
      for (const s of this.states.values()) {
        if (s.record.status !== 'active' || seen.has(s.plugin.id)) continue;
        const depends = (s.plugin.requires ?? []).some((k) => providedKeys.has(k));
        if (depends) {
          seen.add(s.plugin.id);
          discovered.push(s.plugin.id);
        }
      }
    }
    return discovered.slice(1); // 不含 root 自身
  }

  /** 单插件停用原语（不做依赖联动；调用方保证顺序） */
  private async stopDirect(id: string): Promise<void> {
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
    // 订阅也是副作用：EventBus 没有批量 off，此前只清槽位与服务、`bus.on/once` 的
    // 句柄随 ctx 一起被丢 ⇒ 停用后仍在收事件（跑在已拆除的状态上），重激活又叠一份。
    this.releaseBusScope(id);
    this.deps.slots.removeAllFor(id);
    this.setStatus(id, 'stopped');
  }

  /**
   * 释放该插件本轮激活登记的全部 `bus.on/once` 订阅（幂等，可安全重复调用）。
   * 铁律 #4：释放了多少要看得见——退订自身抛错（failed>0）必须 warn，不许静默吞。
   */
  private releaseBusScope(id: string): void {
    const { released, failed } = disposeBusScope(this.deps.bus, id);
    if (failed > 0) {
      this.deps.kernelLog.warn(
        `Plugin '${id}' bus scope release incomplete: ${released} listener(s) dropped, ` +
          `${failed} unsubscribe handle(s) threw`,
      );
    } else if (released > 0) {
      this.deps.kernelLog.debug(`Plugin '${id}' bus scope released: ${released} listener(s)`);
    }
  }

  /**
   * 停用单个插件（审阅 M1 / BUG-1 修复）：
   * 先按**逆拓扑序**级联停用全部 active 依赖方（最深依赖方先停），最后停自身——
   * 避免依赖方留下悬空服务引用。每一步照常广播 plugin.statusChanged。
   * 与 stopAll 的逆序哲学一致（stopAll 逐个调 stop，依赖方已被先停的路径自然 no-op）。
   */
  async stop(id: string): Promise<void> {
    const state = this.states.get(id);
    if (!state || state.record.status !== 'active') return;
    const dependents = this.dependentsClosure(id);
    for (const depId of dependents.reverse()) {
      await this.stopDirect(depId);
    }
    await this.stopDirect(id);
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

/**
 * 对外快照：`missing` 一定拷贝。
 * 返回的记录会被状态面板/插件持有并排序或改写，共享内部数组等于把内核状态交出去。
 */
function toRecord(s: PluginStateInternal): PluginStateRecord {
  return {
    ...s.record,
    missing: s.record.missing ? [...s.record.missing] : undefined,
  };
}

