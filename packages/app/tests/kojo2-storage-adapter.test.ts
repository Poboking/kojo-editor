/**
 * K2-STORAGE-HOST-FULL 的判据闸：**kernel.storage 异步端口适配（镜像 + 串行队列）**、
 * `previousSnapshot` 持久化（`records` 往返）、`recycled` 落账拦截、失败上屏映射。
 *
 * 全部走**真 core**（`lex` / `parse` / `planStorageSlots`）+ **假存储端口**（内存 Map +
 * 可注入钩子 / 可手动放行的闸门），只把「盘」换掉。注册表用 batch-3 真实现，账本用 batch-4
 * 真实现——本文件钉的是两者之间的那一层，不 mock 掉被验证的语义。
 *
 * 覆盖面（与本批任务 1–5 一一对应）：
 * ① 水合 / 镜像 / 项目隔离 / 坏账 / 版本 / `entry` 三态；
 * ② 串行队列（顺序、单飞、失败可见但不毒化、flush 语义）；
 * ③ `records` 往返与 `previousSnapshot` 还原（含旧账无 records 的向前兼容与全部坏形状）；
 * ④ `recycled` 默认拦截 / 显式放行的语义；
 * ⑤ 失败上屏映射只出宿主码，绝不伪造 `core/storage/*`。
 */
import { describe, expect, it } from 'vitest';
import type { SlotRegistrySnapshot } from '@kojo/kojo-core';
import {
  KOJO2_STORAGE_DEFAULT_FINGERPRINT,
  createKojo2StorageRegistry,
  type Kojo2StorageKeyInput,
  type Kojo2StorageRegistry,
} from '../src/ui/kojo2-storage-registry';
import type {
  Kojo2StorageCommitSuccess,
  Kojo2StorageLedger,
} from '../src/ui/kojo2-storage-persist';
import {
  KOJO2_STORAGE_HOST_HASH_LENGTH,
  KOJO2_STORAGE_HOST_LEDGER_PREFIX,
  KOJO2_STORAGE_HOST_PROBLEM_CODES,
  createKojo2StorageHost,
  kojo2StorageProblemOf,
  kojo2StorageProjectHash,
  type Kojo2StorageHost,
  type Kojo2StorageHostCommitResult,
  type Kojo2StorageHostEntryState,
  type Kojo2StorageHostOptions,
  type Kojo2StorageHostStorage,
} from '../src/ui/kojo2-storage-adapter';
import { parseKojo2StorageLedger } from '../src/ui/kojo2-storage-persist';

/* ============================== 假存储端口 ============================== */

interface StorageOp {
  readonly op: 'get' | 'set' | 'delete';
  readonly key: string;
  readonly value: unknown;
}

/**
 * 内存假存储：**异步签名 + 同步可见**（与 kernel `ScopedStorage` 同形）。
 *
 * 三个钩子可精确注入「读不动」「写失败」「删失败」；`ops` 保留完整调用序，
 * 用来断言串行队列的落盘顺序。
 */
class FakeStorage implements Kojo2StorageHostStorage {
  readonly store = new Map<string, unknown>();
  readonly ops: StorageOp[] = [];
  onGet: ((key: string, fake: FakeStorage) => Promise<unknown> | unknown) | null = null;
  onSet:
    | ((key: string, value: unknown, fake: FakeStorage) => Promise<void> | void)
    | null = null;
  onDelete: ((key: string, fake: FakeStorage) => Promise<void> | void) | null = null;

  async get(key: string): Promise<unknown> {
    this.ops.push({ op: 'get', key, value: undefined });
    if (this.onGet !== null) return this.onGet(key, this);
    return this.store.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.ops.push({ op: 'set', key, value });
    if (this.onSet !== null) {
      await this.onSet(key, value, this);
      return;
    }
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.ops.push({ op: 'delete', key, value: undefined });
    if (this.onDelete !== null) {
      await this.onDelete(key, this);
      return;
    }
    this.store.delete(key);
  }

  writes(): readonly StorageOp[] {
    return this.ops.filter((op) => op.op === 'set' || op.op === 'delete');
  }

  resetOps(): void {
    this.ops.length = 0;
  }
}

/** 带 kernel PS-2 显式三态 `entry()` 的假存储（区分 missing / corrupt） */
class EntryStorage extends FakeStorage {
  entryCorrupt: string | null = null;

  async entry(key: string): Promise<Kojo2StorageHostEntryState> {
    if (this.entryCorrupt !== null) return { state: 'corrupt', detail: this.entryCorrupt };
    if (!this.store.has(key)) return { state: 'missing' };
    return { state: 'ok', value: this.store.get(key) };
  }
}

/**
 * 闸门存储：每次 set/delete 都挂起，由测试逐个放行——用来钉「同一时刻只有一个写操作在飞」
 * 与「镜像已经变了、盘还没变」这两条串行队列语义。
 */
class GateStorage implements Kojo2StorageHostStorage {
  readonly store = new Map<string, unknown>();
  readonly started: { readonly op: 'set' | 'delete'; readonly key: string }[] = [];
  private readonly resolvers: (() => void)[] = [];

  async get(key: string): Promise<unknown> {
    return this.store.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.started.push({ op: 'set', key });
    await new Promise<void>((resolve) => {
      this.resolvers.push(() => {
        this.store.set(key, value);
        resolve();
      });
    });
  }

  async delete(key: string): Promise<void> {
    this.started.push({ op: 'delete', key });
    await new Promise<void>((resolve) => {
      this.resolvers.push(() => {
        this.store.delete(key);
        resolve();
      });
    });
  }

  get openCount(): number {
    return this.resolvers.length;
  }

  resolveNext(): void {
    const next = this.resolvers.shift();
    if (next !== undefined) next();
  }
}

function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

/* ============================== 注册表 fixture（真 core） ============================== */

const URI = 'D:/proj/chara/me.kojo2';
const PROJECT_KEY = 'D:/proj';
const FINGERPRINT = KOJO2_STORAGE_DEFAULT_FINGERPRINT;
const AT = '2026-10-22T00:00:00.000Z';

const VAR_FAVOR = '# 设 好感 整数 = 0 存档';
const VAR_MOOD = '# 设 心情 整数 = 0 存档';
const VAR_TRUST = '# 设 信赖 整数 = 0 存档';
const VAR_NAME = '# 设 称呼 字符串 存档';
const VAR_ITEMS = '# 设 物品 整数[3] 存档';
const VAR_SCENE = '# 设 气氛 整数 = 0 场景';
const VAR_SESSION = '# 设 临时 整数 = 0 会话';

type SlotSnapshot = NonNullable<Kojo2StorageRegistry['storagePlan']['nextSnapshot']>;

interface RegistryOptions {
  readonly fingerprint?: string;
  readonly previous?: SlotSnapshot | null;
  readonly declarationKey?: (input: Kojo2StorageKeyInput) => string;
}

function sourceOf(...lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

function registryOf(source: string, options: RegistryOptions = {}): Kojo2StorageRegistry {
  return createKojo2StorageRegistry({
    documents: [{ uri: URI, source }],
    gameFingerprint: options.fingerprint ?? FINGERPRINT,
    previousSnapshot: options.previous ?? null,
    ...(options.declarationKey === undefined ? {} : { declarationKey: options.declarationKey }),
  });
}

/** 名字稳定的声明键（回收测试要「改名不搬槽」，所以不能吃缺省的位置键） */
const NAME_KEY = (input: Kojo2StorageKeyInput): string => `${input.uri}#${input.name}`;

function snapshotOf(registry: Kojo2StorageRegistry): SlotSnapshot {
  const snapshot = registry.storagePlan.nextSnapshot;
  if (snapshot === null) throw new Error('fixture 槽位规划失败');
  return snapshot;
}

function storageKeyOf(registry: Kojo2StorageRegistry, name: string): string {
  const symbol = registry.findDeclaration(name).symbol;
  const variable = symbol?.variable;
  if (variable === undefined) throw new Error(`fixture 里没有存储期声明「${name}」`);
  return variable.storageKey;
}

function slotOf(registry: Kojo2StorageRegistry, name: string): number {
  const variable = registry.findDeclaration(name).symbol?.variable;
  if (variable === undefined || variable.slot === null) {
    throw new Error(`「${name}」没有已分配槽位`);
  }
  return variable.slot;
}

/* ============================== 宿主 fixture ============================== */

function hostOf(
  storage: Kojo2StorageHostStorage,
  extra: Partial<Kojo2StorageHostOptions> = {},
): Kojo2StorageHost {
  return createKojo2StorageHost({
    storage,
    projectKey: PROJECT_KEY,
    now: () => AT,
    ...extra,
  });
}

async function openedHostOf(
  storage: Kojo2StorageHostStorage,
  extra: Partial<Kojo2StorageHostOptions> = {},
): Promise<Kojo2StorageHost> {
  const host = hostOf(storage, extra);
  const read = await host.hydrate();
  if (read.kind !== 'absent' && read.kind !== 'ok') {
    throw new Error(`fixture 水合失败：${read.kind}`);
  }
  return host;
}

function committedOf(result: Kojo2StorageHostCommitResult): Kojo2StorageCommitSuccess {
  if (result.kind !== 'committed') {
    throw new Error(`期望 committed，实际 ${result.kind}：${JSON.stringify(result)}`);
  }
  return result;
}

/** 一份形状合法的空账本（上屏映射测试只关心结果种类） */
function ledgerFixture(): Kojo2StorageLedger {
  return { version: 1, fingerprint: FINGERPRINT, slots: {}, records: {}, updatedAt: AT };
}

/** 只需要 `store` 的存储视图（`FakeStorage` 与 `GateStorage` 都满足） */
interface StoreView {
  readonly store: Map<string, unknown>;
}

function ledgerTextAt(storage: StoreView, host: Kojo2StorageHost): string {
  const value = storage.store.get(host.ledgerKey);
  if (typeof value !== 'string') throw new Error('假存储里没有账本文本');
  return value;
}

function ledgerAt(storage: StoreView, host: Kojo2StorageHost): Kojo2StorageLedger {
  const parsed = parseKojo2StorageLedger(ledgerTextAt(storage, host));
  if (parsed.kind !== 'ok') throw new Error(`假存储里的账本不可解析：${parsed.kind}`);
  return parsed.ledger;
}

/** 往假存储里直接写一份账本（模拟旧版本 / 坏数据 / 手改） */
function seedLedger(
  storage: FakeStorage,
  host: Kojo2StorageHost,
  ledger: Record<string, unknown>,
): void {
  storage.store.set(host.ledgerKey, JSON.stringify(ledger));
}

/** 先把一份正常账本落盘，然后删掉 `records`——模拟 batch-4 的旧账本 */
async function seedLegacyLedger(
  storage: FakeStorage,
  registry: Kojo2StorageRegistry,
): Promise<Kojo2StorageHost> {
  const host = await openedHostOf(storage);
  committedOf(host.commit({ registry, fingerprint: FINGERPRINT }));
  await host.flush();
  const parsed = JSON.parse(ledgerTextAt(storage, host)) as Record<string, unknown>;
  delete parsed.records;
  storage.store.set(host.ledgerKey, JSON.stringify(parsed));
  return host;
}

/* ============================== 1. 建实例 / 键 / 项目隔离 ============================== */

describe('kojo2 槽位宿主 · 实例与项目隔离', () => {
  it('配置错误在创建时抛 TypeError（端口缺方法 / projectKey 空 / hash 抛错 / hash 返回非法键）', () => {
    expect(() =>
      createKojo2StorageHost({
        storage: {} as Kojo2StorageHostStorage,
        projectKey: PROJECT_KEY,
      }),
    ).toThrow(TypeError);

    const storage = new FakeStorage();
    expect(() =>
      createKojo2StorageHost({ storage, projectKey: '' }),
    ).toThrow(TypeError);
    expect(() =>
      createKojo2StorageHost({
        storage,
        projectKey: PROJECT_KEY,
        hash: () => {
          throw new Error('hash 坏了');
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      createKojo2StorageHost({
        storage,
        projectKey: PROJECT_KEY,
        hash: () => 'a/b',
      }),
    ).toThrow(TypeError);
    expect(() =>
      createKojo2StorageHost({
        storage,
        projectKey: PROJECT_KEY,
        hash: () => '..',
      }),
    ).toThrow(TypeError);
    expect(() =>
      createKojo2StorageHost({ storage, projectKey: PROJECT_KEY, hash: () => '' }),
    ).toThrow(TypeError);
  });

  it('账本键 = 前缀 + 16 位稳定 hash；暂存键成对派生；hash 同键稳定、异键不同', () => {
    const storage = new FakeStorage();
    const host = hostOf(storage);
    expect(host.ledgerKey.startsWith(KOJO2_STORAGE_HOST_LEDGER_PREFIX)).toBe(true);
    expect(host.ledgerKey).toBe(`${KOJO2_STORAGE_HOST_LEDGER_PREFIX}${kojo2StorageProjectHash(PROJECT_KEY)}`);
    expect(host.pendingKey).toBe(`${host.ledgerKey}.pending`);
    expect(host.projectKey).toBe(PROJECT_KEY);

    const hash = kojo2StorageProjectHash(PROJECT_KEY);
    expect(hash).toHaveLength(KOJO2_STORAGE_HOST_HASH_LENGTH);
    expect(hash).toMatch(/^[0-9a-f]+$/u);
    expect(kojo2StorageProjectHash(PROJECT_KEY)).toBe(hash);
    expect(kojo2StorageProjectHash(`${PROJECT_KEY}/`)).not.toBe(hash);
    expect(kojo2StorageProjectHash(':')).not.toBe(kojo2StorageProjectHash('/'));
  });

  it('注入 hash 决定落点（宿主已有稳定项目 id 时不必吃内置算法）', () => {
    const storage = new FakeStorage();
    const host = hostOf(storage, { hash: () => 'proj42' });
    expect(host.ledgerKey).toBe(`${KOJO2_STORAGE_HOST_LEDGER_PREFIX}proj42`);
  });

  it('结构化类型：kernel `ScopedStorage` 形状（泛型 get/set + 可选 entry）可直接喂进来', async () => {
    // 这段只做**编译期**证明：不 import @kojo/kernel，也不 mock 任何内核内部件。
    const kernelLike: Kojo2StorageHostStorage = {
      async get<T = unknown>(_key: string): Promise<T | undefined> {
        return undefined;
      },
      async set<T = unknown>(_key: string, _value: T): Promise<void> {
        return undefined;
      },
      async delete(_key: string): Promise<void> {
        return undefined;
      },
      async entry<T = unknown>(
        _key: string,
      ): Promise<
        { state: 'missing' } | { state: 'corrupt'; detail: string } | { state: 'ok'; value: T }
      > {
        return { state: 'missing' };
      },
      async keys(): Promise<string[]> {
        return [];
      },
    };
    const host = hostOf(kernelLike);
    expect(await host.hydrate()).toEqual({ kind: 'absent' });
    expect(host.readLedger()).toEqual({ kind: 'absent' });
  });

  it('项目隔离：A 的账本对 B 不可见，两者键不同且互不覆盖', async () => {
    const storage = new FakeStorage();
    const hostA = await openedHostOf(storage, { projectKey: 'D:/proj-a' });
    const hostB = await openedHostOf(storage, { projectKey: 'D:/proj-b' });
    expect(hostA.ledgerKey).not.toBe(hostB.ledgerKey);

    committedOf(hostA.commit({ registry: registryOf(sourceOf(VAR_FAVOR)), fingerprint: FINGERPRINT }));
    await hostA.flush();

    const reopenedB = await openedHostOf(storage, { projectKey: 'D:/proj-b' });
    expect(reopenedB.readLedger()).toEqual({ kind: 'absent' });

    const reopenedA = await openedHostOf(storage, { projectKey: 'D:/proj-a' });
    const read = reopenedA.readLedger();
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.ledger.slots[storageKeyOf(registryOf(sourceOf(VAR_FAVOR)), '好感')]).toBe('save#0');
    // B 的键下什么都没写
    expect(storage.store.has(hostB.ledgerKey)).toBe(false);
  });
});

/* ============================== 2. 水合 / 读账本 ============================== */

describe('kojo2 槽位宿主 · 水合与坏账防御', () => {
  it('未水合：readLedger / commit / loadPreviousSnapshot 全部 not-hydrated 且零写', () => {
    const storage = new FakeStorage();
    const host = hostOf(storage);
    const registry = registryOf(sourceOf(VAR_FAVOR));

    expect(host.readLedger()).toEqual({
      kind: 'not-hydrated',
      detail: expect.stringContaining('hydrate'),
    });
    expect(host.loadPreviousSnapshot().kind).toBe('not-hydrated');
    const result = host.commit({ registry, fingerprint: FINGERPRINT });
    expect(result.kind).toBe('not-hydrated');
    if (result.kind !== 'not-hydrated') return;
    expect(result.ok).toBe(false);
    expect(storage.writes()).toEqual([]);
    expect(storage.store.size).toBe(0);
  });

  it('空存储：hydrate → absent；readLedger → absent；不产生任何写', async () => {
    const storage = new FakeStorage();
    const host = hostOf(storage);
    expect(await host.hydrate()).toEqual({ kind: 'absent' });
    expect(host.readLedger()).toEqual({ kind: 'absent' });
    expect(storage.writes()).toEqual([]);
  });

  it('已有账本：新实例水合可读到同一份账本（records 也在）', async () => {
    const storage = new FakeStorage();
    const first = await openedHostOf(storage);
    const registry = registryOf(sourceOf(VAR_FAVOR, VAR_ITEMS));
    committedOf(first.commit({ registry, fingerprint: FINGERPRINT }));
    await first.flush();

    const second = await openedHostOf(storage);
    const read = second.readLedger();
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.ledger.fingerprint).toBe(FINGERPRINT);
    expect(read.ledger.slots).toEqual(ledgerAt(storage, first).slots);
    expect(read.ledger.records).toEqual(ledgerAt(storage, first).records);
    expect(read.ledger.records[storageKeyOf(registry, '物品')]).toEqual({
      slot: slotOf(registry, '物品'),
      valueType: 'int',
      arraySize: 3,
    });
  });

  it('hydrate 幂等：再水合只重读、不写、结果一致', async () => {
    const storage = new FakeStorage();
    const host = await openedHostOf(storage);
    committedOf(host.commit({ registry: registryOf(sourceOf(VAR_FAVOR)), fingerprint: FINGERPRINT }));
    await host.flush();

    storage.resetOps();
    const again = await host.hydrate();
    expect(again.kind).toBe('ok');
    expect(storage.writes()).toEqual([]);
    expect(storage.ops.map((op) => op.op)).toEqual(['get']);
  });

  it('读账本抛错 → port-error（读不动 ≠ 首启），之后 readLedger 仍 not-hydrated', async () => {
    const storage = new FakeStorage();
    storage.onGet = () => {
      throw new Error('io 读取失败');
    };
    const host = hostOf(storage);
    const result = await host.hydrate();
    expect(result.kind).toBe('port-error');
    if (result.kind !== 'port-error') return;
    expect(result.detail).toContain('读不动');
    expect(host.readLedger().kind).toBe('not-hydrated');
    expect(storage.writes()).toEqual([]);
  });

  it('存储里的账本不是字符串（对象 / null）→ corrupt(shape)，raw=null，commit 零写', async () => {
    for (const seeded of [{ version: 1 }, null] as const) {
      const storage = new FakeStorage();
      const host = hostOf(storage);
      storage.store.set(host.ledgerKey, seeded);
      const read = await host.hydrate();
      expect(read.kind, String(seeded)).toBe('corrupt');
      if (read.kind !== 'corrupt') continue;
      expect(read.reason).toBe('shape');
      expect(read.raw).toBeNull();
      expect(read.detail).toContain('不是字符串');

      const blocked = host.commit({
        registry: registryOf(sourceOf(VAR_FAVOR)),
        fingerprint: FINGERPRINT,
      });
      expect(blocked.kind).toBe('corrupt-ledger');
      expect(storage.writes()).toEqual([]);
    }
  });

  it('坏 JSON 文本 → corrupt(json) 带原文；loadPreviousSnapshot → invalid(corrupt)', async () => {
    const storage = new FakeStorage();
    const host = hostOf(storage);
    storage.store.set(host.ledgerKey, '{"version":1,"fingerprint":');
    const read = await host.hydrate();
    expect(read.kind).toBe('corrupt');
    if (read.kind !== 'corrupt') return;
    expect(read.reason).toBe('json');
    expect(read.raw).toBe('{"version":1,"fingerprint":');

    const previous = host.loadPreviousSnapshot();
    expect(previous.kind).toBe('invalid');
    if (previous.kind !== 'invalid') return;
    expect(previous.reason).toBe('corrupt');
  });

  it('账本版本不符 → version-unsupported（带 raw），还原快照同判', async () => {
    const storage = new FakeStorage();
    const host = hostOf(storage);
    storage.store.set(
      host.ledgerKey,
      '{"version":9,"fingerprint":"f","slots":{},"updatedAt":"t"}',
    );
    const read = await host.hydrate();
    expect(read.kind).toBe('version-unsupported');
    if (read.kind !== 'version-unsupported') return;
    expect(read.version).toBe(9);
    expect(read.expected).toBe(1);
    expect(read.raw).toContain('"version":9');

    const previous = host.loadPreviousSnapshot();
    expect(previous.kind).toBe('invalid');
    if (previous.kind !== 'invalid') return;
    expect(previous.reason).toBe('version-unsupported');
  });

  it('kernel 显式三态 entry()：corrupt 与 missing 分得开，坏账拒绝落账', async () => {
    const storage = new EntryStorage();
    const host = hostOf(storage);

    storage.entryCorrupt = 'Unexpected token } in JSON at position 3';
    const corrupt = await host.hydrate();
    expect(corrupt.kind).toBe('corrupt');
    if (corrupt.kind !== 'corrupt') return;
    expect(corrupt.reason).toBe('json');
    expect(corrupt.detail).toContain('Unexpected token');
    expect(corrupt.raw).toBeNull();
    expect(
      host.commit({ registry: registryOf(sourceOf(VAR_FAVOR)), fingerprint: FINGERPRINT }).kind,
    ).toBe('corrupt-ledger');

    storage.entryCorrupt = null;
    const missing = await host.hydrate();
    expect(missing).toEqual({ kind: 'absent' });
  });
});

/* ============================== 3. 提交 / 两阶段 / records ============================== */

describe('kojo2 槽位宿主 · 两阶段提交与 records', () => {
  it('首次提交：账本按两阶段时序落盘，slots 与 records 同键、形状齐全', async () => {
    const storage = new FakeStorage();
    const host = await openedHostOf(storage);
    const registry = registryOf(sourceOf(VAR_FAVOR, VAR_NAME, VAR_ITEMS, VAR_SCENE, VAR_SESSION));
    storage.resetOps();

    const result = committedOf(host.commit({ registry, fingerprint: FINGERPRINT }));
    expect(result.changed).toBe(true);
    expect(result.ledger.version).toBe(1);
    expect(result.ledger.fingerprint).toBe(FINGERPRINT);
    expect(result.ledger.updatedAt).toBe(AT);
    expect(Object.keys(result.ledger.records).sort()).toEqual(
      Object.keys(result.ledger.slots).sort(),
    );

    const favorKey = storageKeyOf(registry, '好感');
    const nameKey = storageKeyOf(registry, '称呼');
    const itemsKey = storageKeyOf(registry, '物品');
    const sceneKey = storageKeyOf(registry, '气氛');
    const sessionKey = storageKeyOf(registry, '临时');
    expect(result.ledger.records[favorKey]).toEqual({
      slot: slotOf(registry, '好感'),
      valueType: 'int',
      arraySize: null,
    });
    expect(result.ledger.records[nameKey]).toEqual({
      slot: slotOf(registry, '称呼'),
      valueType: 'string',
      arraySize: null,
    });
    expect(result.ledger.records[itemsKey]).toEqual({
      slot: slotOf(registry, '物品'),
      valueType: 'int',
      arraySize: 3,
    });
    expect(result.ledger.slots[sceneKey]).toBe(`scene#${String(slotOf(registry, '气氛'))}`);
    expect(result.ledger.slots[sessionKey]).toBe(`session#${String(slotOf(registry, '临时'))}`);

    await host.flush();
    // 存储侧只有三次写：暂存 → 正式 → 删暂存（回读都在镜像上）
    expect(storage.writes().map((op) => `${op.op}:${op.key}`)).toEqual([
      `set:${host.pendingKey}`,
      `set:${host.ledgerKey}`,
      `delete:${host.pendingKey}`,
    ]);
    expect(storage.store.has(host.pendingKey)).toBe(false);
    expect(ledgerAt(storage, host)).toEqual(result.ledger);
    // 盘上 JSON 真的带 records 字段（不是只活在内存）
    const raw = JSON.parse(ledgerTextAt(storage, host)) as Record<string, unknown>;
    expect(raw.records).toBeTypeOf('object');
  });

  it('同键幂等：第二次提交 changed=false、flush 后零新写、updatedAt 不刷新', async () => {
    const storage = new FakeStorage();
    const host = await openedHostOf(storage);
    const registry = registryOf(sourceOf(VAR_FAVOR, VAR_NAME));
    const first = committedOf(host.commit({ registry, fingerprint: FINGERPRINT }));
    await host.flush();

    storage.resetOps();
    const second = committedOf(host.commit({ registry, fingerprint: FINGERPRINT }));
    await host.flush();
    expect(second.changed).toBe(false);
    expect(second.ledger).toEqual(first.ledger);
    expect(second.ledger.updatedAt).toBe(AT);
    expect(storage.ops).toEqual([]);
  });

  it('records 往返：另一个实例 Hydrate + loadPreviousSnapshot 还原出与 nextSnapshot 深相等的快照', async () => {
    const storage = new FakeStorage();
    const registry = registryOf(sourceOf(VAR_FAVOR, VAR_NAME, VAR_ITEMS, VAR_SCENE, VAR_SESSION));
    const host = await openedHostOf(storage);
    committedOf(host.commit({ registry, fingerprint: FINGERPRINT }));
    await host.flush();

    const reopened = await openedHostOf(storage);
    const previous = reopened.loadPreviousSnapshot();
    expect(previous.kind).toBe('ok');
    if (previous.kind !== 'ok') return;
    expect(previous.snapshot).toEqual(snapshotOf(registry));
    expect(previous.ledger.fingerprint).toBe(FINGERPRINT);
    expect(Object.isFrozen(previous.snapshot)).toBe(true);
    expect(Object.isFrozen(previous.snapshot.classes)).toBe(true);
    // 场景/存档/会话三类都还原出来了
    expect(Object.keys(previous.snapshot.classes).sort()).toEqual(['save', 'scene', 'session']);
  });

  it('records 反哺注册表：跨构建改型触发 core/storage/shape-changed（plan-not-ok，零写）', async () => {
    const storage = new FakeStorage();
    const before = registryOf(sourceOf(VAR_FAVOR));
    const host = await openedHostOf(storage);
    committedOf(host.commit({ registry: before, fingerprint: FINGERPRINT }));
    await host.flush();

    const reopened = await openedHostOf(storage);
    const previous = reopened.loadPreviousSnapshot();
    if (previous.kind !== 'ok') throw new Error(`fixture 还原失败：${previous.kind}`);
    // 整数 → 字符串：没有 records 就检测不到，有了就必须 fail-closed
    const changed = registryOf(sourceOf('# 设 好感 字符串 存档'), {
      previous: previous.snapshot,
    });
    expect(changed.storagePlan.ok).toBe(false);
    expect(
      changed.diagnostics.some((diagnostic) => diagnostic.code === 'core/storage/shape-changed'),
    ).toBe(true);

    storage.resetOps();
    const result = reopened.commit({ registry: changed, fingerprint: FINGERPRINT });
    expect(result.kind).toBe('plan-not-ok');
    if (result.kind !== 'plan-not-ok') return;
    expect(result.failures.map((failure) => failure.code)).toContain(
      'core/storage/shape-changed',
    );
    await reopened.flush();
    expect(storage.ops).toEqual([]);
  });

  it('换盘：指纹变化 → disk-swapped 透传、零写、旧账本原样', async () => {
    const storage = new FakeStorage();
    const host = await openedHostOf(storage);
    const registry = registryOf(sourceOf(VAR_FAVOR), { fingerprint: 'disk-A' });
    committedOf(host.commit({ registry, fingerprint: 'disk-A' }));
    await host.flush();
    const rawBefore = ledgerTextAt(storage, host);

    storage.resetOps();
    const swapped = host.commit({
      registry: registryOf(sourceOf(VAR_FAVOR), { fingerprint: 'disk-B' }),
      fingerprint: 'disk-B',
    });
    await host.flush();
    expect(swapped.kind).toBe('disk-swapped');
    if (swapped.kind !== 'disk-swapped') return;
    expect(swapped.previous).toBe('disk-A');
    expect(swapped.current).toBe('disk-B');
    expect(storage.ops).toEqual([]);
    expect(ledgerTextAt(storage, host)).toBe(rawBefore);
  });

  it('空工程：账本可建、records 为空时序列化省略该字段，旧读取方字节不变', async () => {
    const storage = new FakeStorage();
    const host = await openedHostOf(storage);
    const registry = createKojo2StorageRegistry({ gameFingerprint: FINGERPRINT });
    const result = committedOf(host.commit({ registry, fingerprint: FINGERPRINT }));
    await host.flush();

    expect(result.ledger.slots).toEqual({});
    expect(result.ledger.records).toEqual({});
    const raw = JSON.parse(ledgerTextAt(storage, host)) as Record<string, unknown>;
    expect(raw).not.toHaveProperty('records');
    expect(raw).toEqual({
      version: 1,
      fingerprint: FINGERPRINT,
      slots: {},
      updatedAt: AT,
    });

    const reopened = await openedHostOf(storage);
    const previous = reopened.loadPreviousSnapshot();
    expect(previous.kind).toBe('absent');
    if (previous.kind !== 'absent') return;
    expect(previous.reason).toBe('no-records');
  });

  it('注册表快照与槽位表不同键集（缺一格形状）→ invalid-registry，零写', async () => {
    const storage = new FakeStorage();
    const host = await openedHostOf(storage);
    const real = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    const nextSnapshot = snapshotOf(real);
    const favorKey = storageKeyOf(real, '好感');
    const truncated = {
      ...nextSnapshot,
      classes: {
        save: {
          [favorKey]: nextSnapshot.classes.save?.[favorKey] ?? {
            slot: 0,
            valueType: 'int',
            arraySize: null,
          },
        },
      },
    };
    const spoofed = {
      ...real,
      storagePlan: { ...real.storagePlan, nextSnapshot: truncated },
    } as unknown as Kojo2StorageRegistry;

    storage.resetOps();
    const result = host.commit({ registry: spoofed, fingerprint: FINGERPRINT });
    expect(result.kind).toBe('invalid-registry');
    if (result.kind !== 'invalid-registry') return;
    expect(result.detail).toContain('缺少形状事实');
    expect(storage.ops).toEqual([]);
  });

  it('注册表 getter 抛错：兜成 invalid-registry，不把异常抛进宿主链路', async () => {
    const storage = new FakeStorage();
    const host = await openedHostOf(storage);
    const spoofed = Object.defineProperty({}, 'storagePlan', {
      get(): never {
        throw new Error('getter 爆了');
      },
    }) as unknown as Kojo2StorageRegistry;
    // 回收预检先踩 getter：问不出「有没有回收」⇒ 按非法注册表处理
    const result = host.commit({ registry: spoofed, fingerprint: FINGERPRINT });
    expect(result.kind).toBe('invalid-registry');
    if (result.kind !== 'invalid-registry') return;
    expect(result.detail).toContain('getter 爆了');
    expect(storage.writes()).toEqual([]);
  });
});

/* ============================== 4. 串行队列 / 镜像 / flush ============================== */

describe('kojo2 槽位宿主 · 串行队列与 flush', () => {
  it('镜像先行：盘上还没写、readLedger 已是新账本（同步端口断言的正是镜像）', async () => {
    const storage = new GateStorage();
    const host = hostOf(storage);
    await host.hydrate();
    const registry = registryOf(sourceOf(VAR_FAVOR));
    const result = committedOf(host.commit({ registry, fingerprint: FINGERPRINT }));

    expect(storage.store.has(host.ledgerKey)).toBe(false); // 一次 set 都还没放行
    const read = host.readLedger();
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.ledger).toEqual(result.ledger);
  });

  it('串行队列：任意时刻只有一个写在飞，落盘顺序 = 入队顺序', async () => {
    const storage = new GateStorage();
    const host = hostOf(storage);
    await host.hydrate();
    const registry = registryOf(sourceOf(VAR_FAVOR));
    committedOf(host.commit({ registry, fingerprint: FINGERPRINT }));

    expect(storage.started).toHaveLength(1);
    expect(storage.openCount).toBe(1);

    const flushing = host.flush();
    for (let step = 0; step < 3; step += 1) {
      expect(storage.openCount).toBe(1); // 单飞：始终只有一个未放行的写
      storage.resolveNext();
      await tick();
    }
    const flushed = await flushing;
    expect(flushed.ok).toBe(true);
    expect(storage.started.map((op) => `${op.op}:${op.key}`)).toEqual([
      `set:${host.pendingKey}`,
      `set:${host.ledgerKey}`,
      `delete:${host.pendingKey}`,
    ]);
    expect(ledgerAt(storage, host).fingerprint).toBe(FINGERPRINT);
  });

  it('队列失败可见但不毒化：正式账本写失败一次，后续提交照常成功', async () => {
    const storage = new FakeStorage();
    const host = await openedHostOf(storage);
    const before = registryOf(sourceOf(VAR_FAVOR));
    let failuresLeft = 1;
    storage.onSet = (key, value, fake) => {
      if (key === host.ledgerKey && failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('磁盘满');
      }
      fake.store.set(key, value);
    };

    const first = committedOf(host.commit({ registry: before, fingerprint: FINGERPRINT }));
    const flushed = await host.flush();
    expect(flushed.ok).toBe(false);
    expect(flushed.failures).toHaveLength(1);
    expect(flushed.failures[0]?.kind).toBe('write-failed');
    expect(flushed.failures[0]?.key).toBe(host.ledgerKey);
    expect(flushed.failures[0]?.detail).toContain('磁盘满');
    expect(storage.store.has(host.ledgerKey)).toBe(false); // 那次写确实没落盘

    // 不毒化：再加一个声明继续提交，这一次成功落盘
    const after = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    const second = committedOf(host.commit({ registry: after, fingerprint: FINGERPRINT }));
    expect(second.changed).toBe(true);
    const flushedAgain = await host.flush();
    expect(flushedAgain.ok).toBe(true);
    expect(flushedAgain.failures).toEqual([]);
    expect(ledgerAt(storage, host)).toEqual(second.ledger);
    expect(first.ledger).not.toEqual(second.ledger);
  });

  it('正式账本写失败后 hydrate 拒绝以盘为准（port-error）；成功重写后恢复', async () => {
    const storage = new FakeStorage();
    const host = await openedHostOf(storage);
    let failuresLeft = 1;
    storage.onSet = (key, value, fake) => {
      if (key === host.ledgerKey && failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('写不动');
      }
      fake.store.set(key, value);
    };
    committedOf(host.commit({ registry: registryOf(sourceOf(VAR_FAVOR)), fingerprint: FINGERPRINT }));
    const flushed = await host.flush();
    expect(flushed.ok).toBe(false);

    const refused = await host.hydrate();
    expect(refused.kind).toBe('port-error');
    if (refused.kind !== 'port-error') return;
    expect(refused.detail).toContain('写盘失败');
    expect(refused.detail).toContain('拒绝以盘为准覆盖');

    // 下一次成功提交把那一格覆盖成新的（noteSuccess 清掉失败标记）
    committedOf(
      host.commit({ registry: registryOf(sourceOf(VAR_FAVOR, VAR_MOOD)), fingerprint: FINGERPRINT }),
    );
    expect((await host.flush()).ok).toBe(true);
    const recovered = await host.hydrate();
    expect(recovered.kind).toBe('ok');
  });

  it('flush 空队列：立即 ok、失败表为空、可重复调用', async () => {
    const storage = new FakeStorage();
    const host = hostOf(storage);
    expect(await host.flush()).toEqual({ ok: true, failures: [] });
    expect(await host.flush()).toEqual({ ok: true, failures: [] });
    expect(storage.ops).toEqual([]);
  });

  it('flush 失败账只报一次（返回即清账），旧失败不遮后来的成功', async () => {
    const storage = new FakeStorage();
    const host = await openedHostOf(storage);
    let failuresLeft = 1;
    storage.onSet = (key, value, fake) => {
      if (key === host.pendingKey && failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('暂存写不动');
      }
      fake.store.set(key, value);
    };
    committedOf(host.commit({ registry: registryOf(sourceOf(VAR_FAVOR)), fingerprint: FINGERPRINT }));
    const first = await host.flush();
    expect(first.ok).toBe(false);
    const second = await host.flush();
    expect(second).toEqual({ ok: true, failures: [] });
    // 暂存键写失败不挡水合（盘上正式账本没停旧版本）
    expect((await host.hydrate()).kind).toBe('ok');
  });

  it('flush 等所有排队写完：连续两次提交后盘上是最后一版', async () => {
    const storage = new FakeStorage();
    const host = await openedHostOf(storage);
    const first = registryOf(sourceOf(VAR_FAVOR));
    const second = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    committedOf(host.commit({ registry: first, fingerprint: FINGERPRINT }));
    const latest = committedOf(host.commit({ registry: second, fingerprint: FINGERPRINT }));
    const flushed = await host.flush();
    expect(flushed.ok).toBe(true);
    expect(ledgerAt(storage, host)).toEqual(latest.ledger);
    expect(latest.ledger.slots[storageKeyOf(second, '心情')]).toBe('save#1');
    const read = host.readLedger();
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.ledger).toEqual(latest.ledger);
  });

  it('并发 commit：注册表 getter 里重入 → 内层 busy，外层照常完成且写序不交错', async () => {
    const storage = new FakeStorage();
    const host = await openedHostOf(storage);
    const real = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    const inner: Kojo2StorageHostCommitResult[] = [];
    let fired = false;
    const spied = new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'storagePlan' && !fired) {
          fired = true;
          inner.push(host.commit({ registry: real, fingerprint: FINGERPRINT }));
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const outer = committedOf(
      host.commit({ registry: spied as Kojo2StorageRegistry, fingerprint: FINGERPRINT }),
    );
    await host.flush();

    expect(inner).toHaveLength(1);
    expect(inner[0]?.kind).toBe('busy');
    expect(outer.changed).toBe(true);
    expect(storage.writes().map((op) => op.key)).toEqual([
      host.pendingKey,
      host.ledgerKey,
      host.pendingKey,
    ]);
    expect(ledgerAt(storage, host)).toEqual(outer.ledger);
  });
});

/* ============================== 5. recycled 落账拦截 ============================== */

describe('kojo2 槽位宿主 · recycled 拦截与放行', () => {
  async function recycledFixture(): Promise<{
    storage: FakeStorage;
    previous: SlotSnapshot;
    recycledRegistry: Kojo2StorageRegistry;
  }> {
    const storage = new FakeStorage();
    const host = await openedHostOf(storage);
    const before = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD), { declarationKey: NAME_KEY });
    committedOf(host.commit({ registry: before, fingerprint: FINGERPRINT }));
    await host.flush();

    const reopened = await openedHostOf(storage);
    const previousResult = reopened.loadPreviousSnapshot();
    if (previousResult.kind !== 'ok') throw new Error('fixture 还原失败');
    // 删「好感」（让出槽 0）+ 新增「信赖」⇒ 信赖回收槽 0
    const recycledRegistry = registryOf(
      sourceOf(VAR_MOOD, VAR_TRUST),
      { declarationKey: NAME_KEY, previous: previousResult.snapshot },
    );
    expect(recycledRegistry.storagePlan.recycled).toHaveLength(1);
    return { storage, previous: previousResult.snapshot, recycledRegistry };
  }

  it('默认拦截：recycled-slots 带 entries，零写、账本原样', async () => {
    const { storage, recycledRegistry } = await recycledFixture();
    const host = await openedHostOf(storage);
    storage.resetOps();
    const rawBefore = ledgerTextAt(storage, host);

    const result = host.commit({ registry: recycledRegistry, fingerprint: FINGERPRINT });
    expect(result.kind).toBe('recycled-slots');
    if (result.kind !== 'recycled-slots') return;
    expect(result.ok).toBe(false);
    expect(result.total).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      storage: 'save',
      slot: 0,
      previousKey: `${URI}#好感`,
      nextKey: `${URI}#信赖`,
    });
    // 报告里必须说清「旧值仍在那个槽里」的语义与放行开关
    expect(result.detail).toContain('旧存档字节');
    expect(result.detail).toContain('allowRecycledSlots');
    expect(storage.ops).toEqual([]);
    expect(ledgerTextAt(storage, host)).toBe(rawBefore);
  });

  it('显式放行：allowRecycledSlots 才允许把回收写成事实，records 跟着新键走', async () => {
    const { storage, recycledRegistry } = await recycledFixture();
    const host = await openedHostOf(storage, { allowRecycledSlots: true });

    const result = committedOf(host.commit({ registry: recycledRegistry, fingerprint: FINGERPRINT }));
    await host.flush();
    expect(result.changed).toBe(true);
    const trustKey = storageKeyOf(recycledRegistry, '信赖');
    const moodKey = storageKeyOf(recycledRegistry, '心情');
    expect(result.ledger.slots[trustKey]).toBe('save#0'); // 回收来的槽
    expect(result.ledger.records[trustKey]).toEqual({ slot: 0, valueType: 'int', arraySize: null });
    expect(result.ledger.slots[moodKey]).toBe('save#1'); // 保留的槽
    expect(result.ledger.slots).not.toHaveProperty(`${URI}#好感`);
    expect(ledgerAt(storage, host)).toEqual(result.ledger);
  });

  it('无回收的新增声明不拦：changed=true 正常落账', async () => {
    const storage = new FakeStorage();
    const host = await openedHostOf(storage);
    const before = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD), { declarationKey: NAME_KEY });
    committedOf(host.commit({ registry: before, fingerprint: FINGERPRINT }));
    await host.flush();

    const reopened = await openedHostOf(storage);
    const previous = reopened.loadPreviousSnapshot();
    if (previous.kind !== 'ok') throw new Error('fixture 还原失败');
    const added = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD, VAR_TRUST), {
      declarationKey: NAME_KEY,
      previous: previous.snapshot,
    });
    expect(added.storagePlan.recycled).toHaveLength(0);
    const result = committedOf(reopened.commit({ registry: added, fingerprint: FINGERPRINT }));
    expect(result.changed).toBe(true);
    expect(result.ledger.slots[`${URI}#信赖`]).toBe('save#2');
  });

  it('回收记录形状非法时仍拦截（total 照数）并在报告里承认有几条没能呈现', async () => {
    const storage = new FakeStorage();
    const host = await openedHostOf(storage);
    const real = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD), { declarationKey: NAME_KEY });
    const spoofed = {
      ...real,
      storagePlan: { ...real.storagePlan, recycled: [{ slot: 'bad' }, null] },
    } as unknown as Kojo2StorageRegistry;

    storage.resetOps();
    const result = host.commit({ registry: spoofed, fingerprint: FINGERPRINT });
    expect(result.kind).toBe('recycled-slots');
    if (result.kind !== 'recycled-slots') return;
    expect(result.total).toBe(2);
    expect(result.entries).toEqual([]);
    expect(result.detail).toContain('形状非法');
    expect(storage.ops).toEqual([]);
  });
});

/* ============================== 6. previousSnapshot：旧账兼容与坏形状 ============================== */

describe('kojo2 槽位宿主 · previousSnapshot 还原与坏形状', () => {
  it('旧账本（无 records）不视为损坏：readLedger ok、records 空、还原报 absent(no-records)', async () => {
    const storage = new FakeStorage();
    const registry = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    const seeded = await seedLegacyLedger(storage, registry);

    const host = await openedHostOf(storage);
    const read = host.readLedger();
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.ledger.records).toEqual({});
    expect(read.ledger.slots[storageKeyOf(registry, '好感')]).toBe('save#0');

    const previous = host.loadPreviousSnapshot();
    expect(previous.kind).toBe('absent');
    if (previous.kind !== 'absent') return;
    expect(previous.reason).toBe('no-records');
    expect(previous.detail).toContain('回填');
    // 旧账本没有被改写
    expect(ledgerTextAt(storage, seeded)).not.toContain('records');
  });

  it('旧账本 + 声明不变：下一次提交自动回填 records（changed=true），槽位一个都不动', async () => {
    const storage = new FakeStorage();
    const registry = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    await seedLegacyLedger(storage, registry);

    const host = await openedHostOf(storage);
    const result = committedOf(host.commit({ registry, fingerprint: FINGERPRINT }));
    await host.flush();
    expect(result.changed).toBe(true);
    expect(Object.keys(result.ledger.records).sort()).toEqual(
      Object.keys(result.ledger.slots).sort(),
    );
    expect(result.ledger.slots[storageKeyOf(registry, '好感')]).toBe('save#0');
    expect(result.ledger.slots[storageKeyOf(registry, '心情')]).toBe('save#1');
    // 回填后再还原就拿到了完整快照
    const reopened = await openedHostOf(storage);
    expect(reopened.loadPreviousSnapshot().kind).toBe('ok');
  });

  it('槽名不是「存储期#槽号」→ invalid(slot-name)，不猜也不静默重置', async () => {
    const storage = new FakeStorage();
    const host = hostOf(storage);
    seedLedger(storage, host, {
      version: 1,
      fingerprint: FINGERPRINT,
      slots: { 'k-1': 'weird#0' },
      records: { 'k-1': { slot: 0, valueType: 'int', arraySize: null } },
      updatedAt: AT,
    });
    expect((await host.hydrate()).kind).toBe('ok');
    const previous = host.loadPreviousSnapshot();
    expect(previous.kind).toBe('invalid');
    if (previous.kind !== 'invalid') return;
    expect(previous.reason).toBe('slot-name');
    expect(previous.detail).toContain('weird#0');
  });

  it('records.slot 与槽名不一致 → invalid(inconsistent)', async () => {
    const storage = new FakeStorage();
    const host = hostOf(storage);
    seedLedger(storage, host, {
      version: 1,
      fingerprint: FINGERPRINT,
      slots: { 'k-1': 'save#2' },
      records: { 'k-1': { slot: 1, valueType: 'int', arraySize: null } },
      updatedAt: AT,
    });
    expect((await host.hydrate()).kind).toBe('ok');
    const previous = host.loadPreviousSnapshot();
    expect(previous.kind).toBe('invalid');
    if (previous.kind !== 'invalid') return;
    expect(previous.reason).toBe('inconsistent');
    expect(previous.detail).toContain('save#2');
  });

  it('slots 有而 records 缺键 → invalid(inconsistent)（残缺账本不许反哺快照）', async () => {
    const storage = new FakeStorage();
    const host = hostOf(storage);
    seedLedger(storage, host, {
      version: 1,
      fingerprint: FINGERPRINT,
      slots: { 'k-1': 'save#0', 'k-2': 'save#1' },
      records: { 'k-1': { slot: 0, valueType: 'int', arraySize: null } },
      updatedAt: AT,
    });
    expect((await host.hydrate()).kind).toBe('ok');
    const previous = host.loadPreviousSnapshot();
    expect(previous.kind).toBe('invalid');
    if (previous.kind !== 'invalid') return;
    expect(previous.reason).toBe('inconsistent');
    expect(previous.detail).toContain('k-2');
  });

  it('records 字段坏形状（valueType 非法 / arraySize 非整数 / slot 负数）→ 解析即 corrupt', async () => {
    const badRecords: readonly Record<string, unknown>[] = [
      { 'k-1': { slot: 0, valueType: 'float', arraySize: null } },
      { 'k-1': { slot: 0, valueType: 'int', arraySize: 1.5 } },
      { 'k-1': { slot: -1, valueType: 'int', arraySize: null } },
      { 'k-1': { slot: 0, valueType: 'int' } }, // arraySize 缺席 ≠ 标量
    ];
    for (const records of badRecords) {
      const storage = new FakeStorage();
      const host = hostOf(storage);
      seedLedger(storage, host, {
        version: 1,
        fingerprint: FINGERPRINT,
        slots: { 'k-1': 'save#0' },
        records,
        updatedAt: AT,
      });
      const read = await host.hydrate();
      expect(read.kind, JSON.stringify(records)).toBe('corrupt');
      if (read.kind !== 'corrupt') continue;
      expect(read.reason).toBe('shape');
      const previous = host.loadPreviousSnapshot();
      expect(previous.kind).toBe('invalid');
    }
  });

  it('records 的键在 slots 里没有槽名 → 解析即 corrupt（两份表必须同键集）', async () => {
    const storage = new FakeStorage();
    const host = hostOf(storage);
    seedLedger(storage, host, {
      version: 1,
      fingerprint: FINGERPRINT,
      slots: {},
      records: { ghost: { slot: 0, valueType: 'int', arraySize: null } },
      updatedAt: AT,
    });
    const read = await host.hydrate();
    expect(read.kind).toBe('corrupt');
    if (read.kind !== 'corrupt') return;
    expect(read.reason).toBe('shape');
    expect(read.detail).toContain('slot');
  });
});

/* ============================== 7. 失败上屏映射 ============================== */

describe('kojo2 槽位宿主 · 失败上屏映射', () => {
  it('成功 / 首启 / 提交成功 → 无问题', () => {
    expect(kojo2StorageProblemOf({ kind: 'ok', ledger: ledgerFixture() })).toEqual([]);
    expect(kojo2StorageProblemOf({ kind: 'absent' })).toEqual([]);
    expect(
      kojo2StorageProblemOf({
        kind: 'committed',
        ok: true,
        ledger: ledgerFixture(),
        previous: null,
        changed: true,
        rollback: { attempted: false, ledger: 'skipped', pendingRemoved: true, detail: null },
      }),
    ).toEqual([]);
  });

  it('未水合 / 坏账 / 版本 / 读不动：各出一条宿主码，message 能读', () => {
    const notHydrated = kojo2StorageProblemOf({
      kind: 'not-hydrated',
      detail: '先 hydrate',
    });
    expect(notHydrated).toHaveLength(1);
    expect(notHydrated[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.notHydrated);
    expect(notHydrated[0]?.severity).toBe('error');
    expect(notHydrated[0]?.message).toContain('先 hydrate');

    const corrupt = kojo2StorageProblemOf({
      kind: 'corrupt',
      reason: 'shape',
      detail: 'slots 非对象',
      raw: '{}',
    });
    expect(corrupt[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.ledgerCorrupt);

    const version = kojo2StorageProblemOf({
      kind: 'version-unsupported',
      version: 2,
      expected: 1,
      raw: '{}',
    });
    expect(version[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.ledgerVersionUnsupported);

    const unavailable = kojo2StorageProblemOf({
      kind: 'port-error',
      detail: '读不动 ≠ 首启',
    });
    expect(unavailable[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.storageUnavailable);
    expect(unavailable[0]?.message).toContain('读不动');
  });

  it('落账失败全谱：disk-swapped / slot-moved / key-policy / recycled / commit-failed 各一条', () => {
    const swapped = kojo2StorageProblemOf({
      kind: 'disk-swapped',
      ok: false,
      previous: 'disk-A',
      current: 'disk-B',
    });
    expect(swapped[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.diskSwapped);
    expect(swapped[0]?.message).toContain('disk-A');
    expect(swapped[0]?.message).toContain('一个字节都没写');

    const moved = kojo2StorageProblemOf({
      kind: 'slot-moved',
      ok: false,
      key: 'k-1',
      previous: 'save#0',
      current: 'save#1',
    });
    expect(moved[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.slotMoved);
    expect(moved[0]?.message).toContain('save#0 → save#1');

    const policy = kojo2StorageProblemOf({
      kind: 'key-policy-mismatch',
      ok: false,
      expected: 'uri#0:3',
      actual: 'uri#name',
      uri: URI,
      name: '好感',
    });
    expect(policy[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.declarationKeyMismatch);
    expect(policy[0]?.message).toContain('好感');

    const recycled = kojo2StorageProblemOf({
      kind: 'recycled-slots',
      ok: false,
      entries: [{ storage: 'save', slot: 0, previousKey: 'old', nextKey: 'new' }],
      total: 1,
      detail: '被回收槽里的旧存档字节仍属于已删除的声明',
    });
    expect(recycled[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.recycledSlots);
    expect(recycled[0]?.message).toContain('旧存档字节');

    const commitFailed = kojo2StorageProblemOf({
      kind: 'commit-failed',
      ok: false,
      phase: 'ledger-write',
      detail: '磁盘满',
      rollback: { attempted: true, ledger: 'restored', pendingRemoved: true, detail: null },
    });
    expect(commitFailed[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.commitFailed);
    expect(commitFailed[0]?.message).toContain('ledger-write');
    expect(commitFailed[0]?.message).toContain('磁盘满');
    expect(commitFailed[0]?.message).toContain('restored');
  });

  it('plan-not-ok：code 是宿主码，core 码只作为文本出现在 message 里（不伪造 core/storage/*）', () => {
    const problems = kojo2StorageProblemOf({
      kind: 'plan-not-ok',
      ok: false,
      failures: [
        {
          kind: 'fingerprint-mismatch',
          code: 'core/storage/fingerprint-mismatch',
          message: '换盘了',
        },
      ],
      detail: '槽位规划失败',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.planNotOk);
    expect(problems[0]?.code.startsWith('core/')).toBe(false);
    // core 码只作为**文本**出现在 message 里，供人核对；它不进 code 字段
    expect(problems[0]?.message).toContain('core/storage/fingerprint-mismatch');
    expect(problems[0]?.message).toContain('registry.diagnostics');
  });

  it('所有映射结果的 code 一律带宿主前缀（绝不出现 core/* 码）', () => {
    const outcomes = [
      { kind: 'busy', ok: false, detail: '重入' } as const,
      { kind: 'invalid-input', ok: false, detail: '参数' } as const,
      { kind: 'corrupt-ledger', ok: false, reason: 'json', detail: '坏' } as const,
      { kind: 'invalid-registry', ok: false, detail: '注册表' } as const,
      {
        kind: 'version-unsupported',
        ok: false,
        version: 3,
        expected: 1,
      } as const,
      {
        kind: 'invalid',
        reason: 'inconsistent',
        detail: '账本自相矛盾',
      } as const,
      { kind: 'write-failed', key: 'k', detail: '写不动' } as const,
      { kind: 'remove-failed', key: 'k', detail: '删不动' } as const,
    ];
    for (const outcome of outcomes) {
      const problems = kojo2StorageProblemOf(outcome);
      expect(problems, outcome.kind).toHaveLength(1);
      for (const item of problems) {
        expect(item.code.startsWith('kojo2/storage-host/'), item.code).toBe(true);
        expect(item.code.startsWith('core/'), item.code).toBe(false);
        expect(item.severity, item.code).toBe('error');
        expect(item.message.length, item.code).toBeGreaterThan(10);
      }
    }
  });

  it('队列写盘失败 → write-behind-failed，message 说清「内存已更新、盘上可能还是旧账」', () => {
    const problems = kojo2StorageProblemOf({
      kind: 'write-failed',
      key: 'kojo2.storage.ledger.x',
      detail: '磁盘满',
    });
    expect(problems[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.writeBehindFailed);
    expect(problems[0]?.message).toContain('磁盘满');
    expect(problems[0]?.message).toContain('内存镜像已更新');
  });

  it('纯函数 + 冻结：同输入同输出，返回值不可就地改', () => {
    const outcome = { kind: 'busy', ok: false, detail: '重入' } as const;
    const first = kojo2StorageProblemOf(outcome);
    const second = kojo2StorageProblemOf(outcome);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(() => {
      (first as unknown as { push: (value: unknown) => void }).push({});
    }).toThrow(TypeError);
  });
});

