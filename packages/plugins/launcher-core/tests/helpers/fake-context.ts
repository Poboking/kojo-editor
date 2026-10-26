/**
 * 假插件上下文：够 `launcher-core` 激活用的最小 `PluginContext`。
 *
 * 不造完整内核（那会变成第二份内核）：只实现本插件真会碰的五个面——`inject` /
 * `tryInject` / `provide` / `onDispose` / `slots.query`，加一个空总线与空存储。
 */

import type {
  AnyEventMap,
  EventBus,
  PluginContext,
  ScopedStorage,
  SlotRegistry,
  Unsubscribe,
} from '@kojo/plugin-api';

export interface FakeContext {
  ctx: PluginContext;
  /** 插件 provide 出去的服务（断言「确实注册了」） */
  provided: Map<string, unknown>;
  /** 已登记但还没执行的 disposer（模拟内核 deactivate） */
  runDisposers(): void;
}

export interface FakeContextOptions {
  readonly injects?: Readonly<Record<string, unknown>>;
  /** `game.adapter` 槽的查询结果（缺省 = 空数组） */
  readonly adapterContributions?: readonly unknown[];
  /** 不提供槽位服务（`tryInject(kernel.slots)` 得 undefined） */
  readonly withoutSlots?: boolean;
}

export function makeContext(options: FakeContextOptions = {}): FakeContext {
  const injects = new Map(Object.entries(options.injects ?? {}));
  const provided = new Map<string, unknown>();
  const disposers: Array<() => void | Promise<void>> = [];

  const slots: SlotRegistry = {
    register: () => () => {},
    query: (() => options.adapterContributions ?? []) as SlotRegistry['query'],
  };

  const bus: EventBus = {
    on: (_type, _handler): Unsubscribe => () => {},
    once: (_type, _handler): Unsubscribe => () => {},
    emit: (_type: keyof AnyEventMap, _payload: AnyEventMap[keyof AnyEventMap]) => {},
  };

  const storage: ScopedStorage = {
    get: async () => undefined,
    set: async () => {},
    delete: async () => {},
    keys: async () => [],
  };

  const ctx: PluginContext = {
    pluginId: 'launcher-core',
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    bus,
    storage,
    slots,
    provide<T>(key: string, value: T): void {
      provided.set(key, value);
    },
    inject<T>(key: string): T {
      if (!injects.has(key)) throw new Error(`unexpected inject: ${key}`);
      return injects.get(key) as T;
    },
    tryInject<T>(key: string): T | undefined {
      if (key === 'kernel.slots' && options.withoutSlots) return undefined;
      if (key === 'kernel.slots') return slots as unknown as T;
      return injects.get(key) as T | undefined;
    },
    onDispose(fn: () => void | Promise<void>): void {
      disposers.push(fn);
    },
  };

  return {
    ctx,
    provided,
    runDisposers(): void {
      while (disposers.length > 0) void disposers.pop()!();
    },
  };
}

/** 一枚只有启动面的假 adapter（`activeGameAdapter` 只读 `.adapter.gameId` 与 `.adapter.launch`） */
export function makeLaunchAdapter(
  options: {
    readonly gameId?: string;
    readonly probe?: (rootDir: string) => Promise<readonly unknown[]>;
    readonly buildProfile?: (rootDir: string, candidateId: string) => Promise<unknown>;
  } = {},
) {
  return {
    gameId: options.gameId ?? 'demo',
    launch: {
      probe:
        options.probe ??
        (async () => [{ id: 'default', label: '默认', executableRelativePath: 'game.exe' }]),
      buildProfile:
        options.buildProfile ??
        (async (_rootDir: string, candidateId: string) => ({
          candidateId,
          executable: {
            relativePath: 'game.exe',
            args: [],
            env: {},
            windowMode: 'auto',
            sha256: null,
          },
          cwdRelative: '.',
          saveRoots: [],
          contentRoots: [],
        })),
    },
  };
}
