/**
 * K2-STORAGE-SERVICE 的判据闸：**项目打开的全序编排 + 失败必上屏 + 关闭/换项目隔离**。
 *
 * 全部走真 core（`lex` / `parse` / `planStorageSlots`）+ 真注册表 + 真账本，只把「盘」
 * （假 kernel.storage）与「上屏通道」（假 notify / 假 problem sink）换掉。这样钉住的是
 * 服务自己的顺序与失败面，而不是把被验证的三件套 mock 掉。
 *
 * 覆盖面（与任务 1–3 一一对应）：
 * ① 正常全序：hydrate → previousSnapshot → registry → plan 闸 → commit → flush；
 * ② 水合坏账 / 版本不符 / 读不动 / entry corrupt：零写阻断 + 上屏；
 * ③ previousSnapshot absent / invalid：前者继续（null），后者零写阻断；
 * ④ recycled：默认零写阻断、显式放行重试成功、关闭后待重试作废；
 * ⑤ flush 失败：提交仍算成功，但失败条目一条不少地上屏且只通知一次；
 * ⑥ 换项目隔离 / 关闭后不再写 / 幂等重开；
 * ⑦ flag 关：零实例、零端口、零写、零通知；并发 open/close ⇒ busy。
 */
import { describe, expect, it, vi } from 'vitest';
import type { SlotClassSpec } from '@kojo/kojo-core';
import {
  KOJO2_STORAGE_SERVICE_PROBLEM_CODES,
  KOJO2_STORAGE_SERVICE_PROBLEM_PATH,
  KOJO2_STORAGE_SERVICE_PROBLEM_SOURCE,
  createKojo2StorageService,
  type Kojo2StorageOpenInput,
  type Kojo2StorageOpenResult,
  type Kojo2StorageProblemSink,
  type Kojo2StorageService,
  type Kojo2StorageServiceAdapter,
  type Kojo2StorageServiceKernel,
} from '../src/ui/kojo2-storage-service';
import {
  KOJO2_STORAGE_HOST_LEDGER_PREFIX,
  KOJO2_STORAGE_HOST_PROBLEM_CODES,
  kojo2StorageProjectHash,
  type Kojo2StorageHostEntryState,
  type Kojo2StorageHostStorage,
} from '../src/ui/kojo2-storage-adapter';
import {
  KOJO2_STORAGE_DEFAULT_CLASSES,
  type Kojo2StorageDocument,
  type Kojo2StorageKeyInput,
} from '../src/ui/kojo2-storage-registry';
import { parseKojo2StorageLedger } from '../src/ui/kojo2-storage-persist';
import type { EditorProblem } from '../src/ui/problem-store';

/* ============================== 假端口 ============================== */

interface StorageOp {
  readonly op: 'get' | 'set' | 'delete';
  readonly key: string;
  readonly value: unknown;
}

/**
 * 内存假 kernel.storage：**异步签名 + 同步可见**（与 `ScopedStorage` 同形）。
 *
 * `onGet/onSet/onDelete` 可精确注入「读不动 / 写失败 / 删失败」；`ops` 保完整调用序，
 * 用来断言「顺序」与「零写」。
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

/** 只暴露 `storage.global()` 的假 kernel（服务不 import kernel，这是唯一的 kernel 面） */
function kernelOf(storage: Kojo2StorageHostStorage): Kojo2StorageServiceKernel {
  return {
    storage: {
      global(): Kojo2StorageHostStorage {
        return storage;
      },
    },
  };
}

interface Notice {
  readonly kind: 'info' | 'error';
  readonly message: string;
  readonly detail?: string;
}

interface ProblemWrite {
  readonly path: string;
  readonly items: readonly EditorProblem[];
}

interface Harness {
  readonly storage: FakeStorage;
  readonly service: Kojo2StorageService;
  readonly notices: Notice[];
  readonly writes: ProblemWrite[];
  setEnabled(on: boolean): void;
}

function harnessOf(storage: FakeStorage = new FakeStorage()): Harness {
  const notices: Notice[] = [];
  const writes: ProblemWrite[] = [];
  let enabled = true;
  const writeProblems: Kojo2StorageProblemSink = (path, items) => {
    writes.push({ path, items });
  };
  const service = createKojo2StorageService({
    kernel: kernelOf(storage),
    notify: (notice) => {
      notices.push(notice);
    },
    writeProblems,
    isEnabled: () => enabled,
    now: () => AT,
  });
  return {
    storage,
    service,
    notices,
    writes,
    setEnabled(on: boolean): void {
      enabled = on;
    },
  };
}

/* ============================== 文档 / adapter fixture ============================== */

const URI = 'D:/proj/chara/me.kojo2';
const PROJECT = 'D:/proj';
const OTHER_PROJECT = 'D:/proj-other';
const FINGERPRINT = 'kojo2-test-disc@1';
const AT = '2026-10-22T00:00:00.000Z';

const VAR_FAVOR = '# 变量 好感 整数 = 0 存档';
const VAR_MOOD = '# 变量 心情 整数 = 0 存档';
const VAR_TRUST = '# 变量 信赖 整数 = 0 存档';

/** 名字稳定的声明键（回收测试要「改名不搬槽」，不能吃缺省的位置键） */
const NAME_KEY = (input: Kojo2StorageKeyInput): string => `${input.uri}#${input.name}`;

function adapterOf(
  overrides: Partial<Kojo2StorageServiceAdapter> = {},
): Kojo2StorageServiceAdapter {
  return {
    gameFingerprint: FINGERPRINT,
    storageClasses: KOJO2_STORAGE_DEFAULT_CLASSES,
    declarationKey: NAME_KEY,
    ...overrides,
  };
}

function docsOf(
  ...lines: readonly string[]
): readonly Kojo2StorageDocument[] {
  return [{ uri: URI, source: `${lines.join('\n')}\n` }];
}

function inputOf(
  documents: readonly Kojo2StorageDocument[] = docsOf(VAR_FAVOR, VAR_MOOD),
  overrides: Partial<Kojo2StorageOpenInput> = {},
): Kojo2StorageOpenInput {
  return {
    projectKey: PROJECT,
    documents,
    adapter: adapterOf(),
    ...overrides,
  };
}

function ledgerKeyOf(projectKey: string): string {
  return `${KOJO2_STORAGE_HOST_LEDGER_PREFIX}${kojo2StorageProjectHash(projectKey)}`;
}

function seedLedger(storage: FakeStorage, projectKey: string, ledger: Record<string, unknown>): void {
  storage.store.set(ledgerKeyOf(projectKey), JSON.stringify(ledger));
}

function ledgerTextAt(storage: FakeStorage, projectKey: string): string {
  const value = storage.store.get(ledgerKeyOf(projectKey));
  if (typeof value !== 'string') throw new Error(`项目「${projectKey}」盘上没有账本文本`);
  return value;
}

function ledgerAt(storage: FakeStorage, projectKey: string): Record<string, unknown> {
  const parsed = parseKojo2StorageLedger(ledgerTextAt(storage, projectKey));
  if (parsed.kind !== 'ok') throw new Error(`盘上的账本不可解析：${parsed.kind}`);
  return JSON.parse(JSON.stringify(parsed.ledger)) as Record<string, unknown>;
}

function slotsOf(storage: FakeStorage, projectKey: string): Record<string, unknown> {
  const ledger = ledgerAt(storage, projectKey);
  const slots = ledger.slots;
  if (typeof slots !== 'object' || slots === null) throw new Error('账本没有 slots');
  return slots as Record<string, unknown>;
}

function openedOf(result: Kojo2StorageOpenResult): Extract<Kojo2StorageOpenResult, { kind: 'opened' }> {
  if (result.kind !== 'opened') {
    throw new Error(`期望 opened，实际 ${result.kind}：${JSON.stringify(result)}`);
  }
  return result;
}

function problemsOf(result: { readonly problems: readonly { readonly code: string }[] }): readonly string[] {
  return result.problems.map((problem) => problem.code);
}

/** 上屏通道的最新一条问题列表（没有写过 → 空数组） */
function lastWritten(h: Harness): readonly EditorProblem[] {
  const last = h.writes[h.writes.length - 1];
  return last?.items ?? [];
}

/* ============================== 1. 正常全序 ============================== */

describe('kojo2 槽位账本服务 · 正常全序', () => {
  it('hydrate → previousSnapshot → registry → commit → flush：账本落盘、零问题、通知为零', async () => {
    const h = harnessOf();
    const result = openedOf(await h.service.openProject(inputOf()));

    expect(result.projectKey).toBe(PROJECT);
    expect(result.ledgerKey).toBe(ledgerKeyOf(PROJECT));
    expect(result.commit.changed).toBe(true);
    expect(result.commit.previous).toBeNull(); // 首启：没有旧账
    expect(result.flush.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(h.notices).toEqual([]);
    // 文档顺序无关：两条声明都拿到槽位（好感 0 / 心情 1）
    const slots = slotsOf(h.storage, PROJECT);
    expect(slots[`${URI}#好感`]).toBe('save#0');
    expect(slots[`${URI}#心情`]).toBe('save#1');

    // 端口调用序：水合读一次 → 暂存写 → 正式写 → 清暂存（同步镜像 + 串行队列）
    expect(h.storage.ops.map((op) => op.op)).toEqual(['get', 'set', 'set', 'delete']);
    expect(h.storage.ops[0]?.key).toBe(ledgerKeyOf(PROJECT));
    expect(h.storage.ops[1]?.key).toBe(`${ledgerKeyOf(PROJECT)}.pending`);
    expect(h.storage.ops[2]?.key).toBe(ledgerKeyOf(PROJECT));
    expect(h.storage.ops[3]?.key).toBe(`${ledgerKeyOf(PROJECT)}.pending`);

    // 开头的清账只写 problem-store（虚拟路径 + 空表），不碰盘
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.path).toBe(KOJO2_STORAGE_SERVICE_PROBLEM_PATH);
    expect(h.writes[0]?.items).toEqual([]);

    const snapshot = h.service.getSnapshot();
    expect(snapshot).toEqual({
      phase: 'open',
      projectKey: PROJECT,
      ledgerKey: ledgerKeyOf(PROJECT),
      openCount: 1,
      commitCount: 1,
    });
    expect(h.service.host()).not.toBeNull();
  });

  it('幂等重开：同一批文档再提交 changed=false，正式账本零写', async () => {
    const h = harnessOf();
    openedOf(await h.service.openProject(inputOf()));
    const closed = await h.service.closeProject();
    expect(closed.kind).toBe('closed');
    expect(h.service.host()).toBeNull();

    h.storage.resetOps();
    const result = openedOf(await h.service.openProject(inputOf()));
    expect(result.commit.changed).toBe(false);
    expect(result.problems).toEqual([]);
    // 只有水合读；暂存/正式账本都没有被重写
    expect(h.storage.ops.map((op) => op.op)).toEqual(['get']);
    expect(h.service.getSnapshot().openCount).toBe(2);
    expect(h.service.getSnapshot().commitCount).toBe(2);
  });

  it('previousSnapshot absent（旧账本只有 slots、没有 records）不阻断：按首启分配并回填 records', async () => {
    const h = harnessOf();
    seedLedger(h.storage, PROJECT, {
      version: 1,
      fingerprint: FINGERPRINT,
      slots: { 'legacy-key': 'save#0' },
      records: {},
      updatedAt: AT,
    });
    const result = openedOf(await h.service.openProject(inputOf()));
    expect(result.commit.changed).toBe(true);
    const parsed = parseKojo2StorageLedger(ledgerTextAt(h.storage, PROJECT));
    if (parsed.kind !== 'ok') throw new Error('账本应可解析');
    // 新提交的账本带形状记录（records 已回填），旧 legacy 键按删除处理
    expect(parsed.ledger.records[`${URI}#好感`]).toEqual({
      slot: 0,
      valueType: 'int',
      arraySize: null,
    });
    expect(parsed.ledger.slots).not.toHaveProperty('legacy-key');
  });

  it('换项目隔离：同一服务先后开两个项目，两份账本互不覆盖', async () => {
    const h = harnessOf();
    const first = openedOf(await h.service.openProject(inputOf(docsOf(VAR_FAVOR))));
    const firstRaw = ledgerTextAt(h.storage, PROJECT);
    const second = openedOf(
      await h.service.openProject(
        inputOf(docsOf(VAR_MOOD), {
          projectKey: OTHER_PROJECT,
          adapter: adapterOf({ gameFingerprint: 'other-disc@2' }),
        }),
      ),
    );

    expect(first.ledgerKey).not.toBe(second.ledgerKey);
    expect(h.storage.store.has(first.ledgerKey)).toBe(true);
    expect(h.storage.store.has(second.ledgerKey)).toBe(true);
    // 第一个项目的账本一个字节都没被第二个项目的提交改动
    expect(ledgerTextAt(h.storage, PROJECT)).toBe(firstRaw);
    expect(Object.keys(slotsOf(h.storage, PROJECT))).toEqual([`${URI}#好感`]);
    expect(Object.keys(slotsOf(h.storage, OTHER_PROJECT))).toEqual([`${URI}#心情`]);
    expect(h.service.getSnapshot().projectKey).toBe(OTHER_PROJECT);
    expect(h.service.getSnapshot().openCount).toBe(2);
  });

  it('关闭后不再写：closeProject 返回 closed 且端口调用数不再增长', async () => {
    const h = harnessOf();
    openedOf(await h.service.openProject(inputOf()));
    const before = h.storage.ops.length;

    const closed = await h.service.closeProject();
    expect(closed.kind).toBe('closed');
    if (closed.kind !== 'closed') return;
    expect(closed.flush.ok).toBe(true);
    expect(closed.problems).toEqual([]);
    expect(h.storage.ops.length).toBe(before);
    expect(h.service.getSnapshot().phase).toBe('idle');
    expect(h.service.host()).toBeNull();

    // 关闭后再拿“重试回收”只会拿到 nothing-to-retry（不再有可写实例）
    expect((await h.service.retryWithRecycledAllowed()).kind).toBe('nothing-to-retry');
    expect(h.storage.ops.length).toBe(before);
  });
});

/* ============================== 2. 水合闸门 ============================== */

describe('kojo2 槽位账本服务 · 水合闸门', () => {
  it('盘上 JSON 坏了：blocked(hydrate)、零写、一条通知、面板可见', async () => {
    const h = harnessOf();
    h.storage.store.set(ledgerKeyOf(PROJECT), '{ this is not json');
    const result = await h.service.openProject(inputOf());

    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.stage).toBe('hydrate');
    expect(result.ledgerKey).toBe(ledgerKeyOf(PROJECT));
    expect(problemsOf(result)).toEqual([KOJO2_STORAGE_HOST_PROBLEM_CODES.ledgerCorrupt]);
    expect(result.problems[0]?.message).toContain('账本损坏');
    expect(h.storage.writes()).toEqual([]); // 只读过一次，一个字节没写
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]?.kind).toBe('error');
    expect(lastWritten(h)[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.ledgerCorrupt);
    expect(h.service.host()).toBeNull();
  });

  it('账本版本不受支持：blocked(hydrate)、零写、码是 host 命名空间', async () => {
    const h = harnessOf();
    seedLedger(h.storage, PROJECT, {
      version: 99,
      fingerprint: FINGERPRINT,
      slots: {},
      records: {},
      updatedAt: AT,
    });
    const result = await h.service.openProject(inputOf());
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.stage).toBe('hydrate');
    expect(problemsOf(result)).toEqual([
      KOJO2_STORAGE_HOST_PROBLEM_CODES.ledgerVersionUnsupported,
    ]);
    expect(h.storage.writes()).toEqual([]);
    expect(h.notices).toHaveLength(1);
  });

  it('读不动（get 抛错）≠ 不存在：blocked(hydrate)、storage-unavailable、零写', async () => {
    const h = harnessOf();
    h.storage.onGet = () => {
      throw new Error('IPC 断了');
    };
    const result = await h.service.openProject(inputOf());
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.stage).toBe('hydrate');
    expect(problemsOf(result)).toEqual([KOJO2_STORAGE_HOST_PROBLEM_CODES.storageUnavailable]);
    expect(result.problems[0]?.message).toContain('读不动 ≠ 不存在');
    expect(h.storage.writes()).toEqual([]);
    expect(h.notices).toHaveLength(1);
  });

  it('kernel entry() 报 corrupt：同样阻断，不把坏 JSON 当首启覆盖', async () => {
    const storage = new EntryStorage();
    storage.entryCorrupt = 'Unexpected token }';
    const h = harnessOf(storage);
    const result = await h.service.openProject(inputOf());
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.stage).toBe('hydrate');
    expect(problemsOf(result)).toEqual([KOJO2_STORAGE_HOST_PROBLEM_CODES.ledgerCorrupt]);
    expect(storage.writes()).toEqual([]);
  });
});

/* ============================== 3. previousSnapshot 闸门 ============================== */

describe('kojo2 槽位账本服务 · previousSnapshot 闸门', () => {
  it('账本自相矛盾（slots 里的键在 records 缺格）：blocked(previous-snapshot)、零写', async () => {
    const h = harnessOf();
    seedLedger(h.storage, PROJECT, {
      version: 1,
      fingerprint: FINGERPRINT,
      slots: { 'k-1': 'save#0', 'k-2': 'save#1' },
      records: { 'k-1': { slot: 0, valueType: 'int', arraySize: null } },
      updatedAt: AT,
    });
    const result = await h.service.openProject(inputOf());
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.stage).toBe('previous-snapshot');
    expect(problemsOf(result)).toEqual([
      KOJO2_STORAGE_HOST_PROBLEM_CODES.previousSnapshotInvalid,
    ]);
    expect(result.problems[0]?.message).toContain('records');
    expect(h.storage.writes()).toEqual([]);
    expect(h.notices).toHaveLength(1);
  });

  it('槽名不是「存储期#槽号」：blocked(previous-snapshot)，不猜映射', async () => {
    const h = harnessOf();
    seedLedger(h.storage, PROJECT, {
      version: 1,
      fingerprint: FINGERPRINT,
      slots: { k: 'custom-slot#3' },
      records: { k: { slot: 3, valueType: 'int', arraySize: null } },
      updatedAt: AT,
    });
    const result = await h.service.openProject(inputOf());
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.stage).toBe('previous-snapshot');
    expect(result.problems[0]?.message).toContain('槽名');
    expect(h.storage.writes()).toEqual([]);
  });

  it('slots 与 records 的槽号不一致：blocked(previous-snapshot)，不落账', async () => {
    const h = harnessOf();
    seedLedger(h.storage, PROJECT, {
      version: 1,
      fingerprint: FINGERPRINT,
      slots: { k: 'save#3' },
      records: { k: { slot: 2, valueType: 'int', arraySize: null } },
      updatedAt: AT,
    });
    const result = await h.service.openProject(inputOf());
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.stage).toBe('previous-snapshot');
    expect(result.problems[0]?.message).toContain('自相矛盾');
    expect(h.storage.writes()).toEqual([]);
  });
});

/* ============================== 4. 入参 / 规划闸 ============================== */

describe('kojo2 槽位账本服务 · 入参与规划闸', () => {
  it('adapter 未声明 storageClasses：blocked(input)、零端口调用、零写', async () => {
    const h = harnessOf();
    const result = await h.service.openProject(
      inputOf(docsOf(VAR_FAVOR), { adapter: adapterOf({ storageClasses: [] }) }),
    );
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.stage).toBe('input');
    expect(problemsOf(result)).toEqual([KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidInput]);
    expect(result.problems[0]?.message).toContain('storageClasses');
    expect(h.storage.ops).toEqual([]); // 连 global() 都没走到（见下一条 port 记账）
    expect(h.notices).toHaveLength(1);
  });

  it('projectKey 为空 / gameFingerprint 为空：各一条 invalid-input 阻断', async () => {
    const h = harnessOf();
    const emptyKey = await h.service.openProject(inputOf(undefined, { projectKey: '' }));
    expect(emptyKey.kind).toBe('blocked');
    if (emptyKey.kind === 'blocked') {
      expect(emptyKey.stage).toBe('input');
      expect(problemsOf(emptyKey)).toEqual([KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidInput]);
    }
    const emptyFingerprint = await h.service.openProject(
      inputOf(docsOf(VAR_FAVOR), {
        adapter: adapterOf({ gameFingerprint: '' }),
      }),
    );
    expect(emptyFingerprint.kind).toBe('blocked');
    if (emptyFingerprint.kind === 'blocked') {
      expect(emptyFingerprint.problems[0]?.message).toContain('gameFingerprint');
    }
    expect(h.storage.ops).toEqual([]);
    expect(h.notices).toHaveLength(2);
  });

  it('槽位区段放不下（save 只有 1 格）：plan 闸拦下，不调 commit、零写', async () => {
    const h = harnessOf();
    const tight: readonly SlotClassSpec[] = [
      { storage: 'scene', min: 0, max: 7, scope: 'unit' },
      { storage: 'save', min: 0, max: 0, scope: 'project' },
      { storage: 'session', min: 0, max: 0, scope: 'project' },
    ];
    const result = await h.service.openProject(
      inputOf(docsOf(VAR_FAVOR, VAR_MOOD), {
        adapter: adapterOf({ storageClasses: tight }),
      }),
    );
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.stage).toBe('plan');
    expect(problemsOf(result)).toEqual([KOJO2_STORAGE_HOST_PROBLEM_CODES.planNotOk]);
    expect(result.problems[0]?.message).toContain('槽位规划失败');
    expect(result.problems[0]?.message).toContain('core/storage/exhausted');
    // 只水合读过一次，一个字节没写
    expect(h.storage.writes()).toEqual([]);
    expect(h.notices).toHaveLength(1);
  });

  it('注册表装配失败（URI 重复）：blocked(registry)、零写、一条通知', async () => {
    const h = harnessOf();
    const documents: readonly Kojo2StorageDocument[] = [
      { uri: URI, source: `${VAR_FAVOR}\n` },
      { uri: URI, source: `${VAR_MOOD}\n` },
    ];
    const result = await h.service.openProject(inputOf(documents));
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.stage).toBe('registry');
    expect(problemsOf(result)).toEqual([KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidInput]);
    expect(result.problems[0]?.message).toContain('URI 重复');
    expect(h.storage.writes()).toEqual([]);
    expect(h.notices).toHaveLength(1);
  });

  it('文档清单不完整：零写 skipped(documents-incomplete)，一条 warning 上屏', async () => {
    const h = harnessOf();
    const result = await h.service.openProject(
      inputOf(undefined, { documentsComplete: false }),
    );
    expect(result.kind).toBe('skipped');
    if (result.kind !== 'skipped') return;
    expect(result.reason).toBe('documents-incomplete');
    expect(problemsOf(result)).toEqual([KOJO2_STORAGE_SERVICE_PROBLEM_CODES.documentsIncomplete]);
    expect(result.problems[0]?.severity).toBe('warning');
    expect(h.storage.ops).toEqual([]); // 连水合都不做
    expect(h.notices).toHaveLength(1);
    expect(lastWritten(h)[0]?.message).toContain('零写');
  });

  it('零文档：skipped(no-documents)、零端口、零通知（空工程不是错误）', async () => {
    const h = harnessOf();
    const result = await h.service.openProject(inputOf([]));
    expect(result.kind).toBe('skipped');
    if (result.kind !== 'skipped') return;
    expect(result.reason).toBe('no-documents');
    expect(result.problems).toEqual([]);
    expect(h.storage.ops).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.service.host()).toBeNull();
  });
});

/* ============================== 5. recycled ============================== */

describe('kojo2 槽位账本服务 · recycled 阻断与放行', () => {
  async function seedRecycled(): Promise<Harness> {
    const h = harnessOf();
    openedOf(await h.service.openProject(inputOf(docsOf(VAR_FAVOR, VAR_MOOD))));
    const closed = await h.service.closeProject();
    expect(closed.kind).toBe('closed');
    h.storage.resetOps();
    return h;
  }

  it('回收槽位默认零写阻断：recycled + 一条通知 + 面板可见，账本原样', async () => {
    const h = await seedRecycled();
    const rawBefore = ledgerTextAt(h.storage, PROJECT);
    // 删「好感」（让出槽 0）+ 新增「信赖」⇒ 信赖回收槽 0
    const result = await h.service.openProject(inputOf(docsOf(VAR_MOOD, VAR_TRUST)));

    expect(result.kind).toBe('recycled');
    if (result.kind !== 'recycled') return;
    expect(result.total).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.previousKey).toBe(`${URI}#好感`);
    expect(result.entries[0]?.nextKey).toBe(`${URI}#信赖`);
    expect(result.detail).toContain('旧存档字节');
    expect(problemsOf(result)).toEqual([KOJO2_STORAGE_HOST_PROBLEM_CODES.recycledSlots]);
    expect(h.storage.writes()).toEqual([]);
    expect(ledgerTextAt(h.storage, PROJECT)).toBe(rawBefore);
    expect(h.notices).toHaveLength(1);
    expect(h.service.host()).toBeNull();
  });

  it('retryWithRecycledAllowed：放行后落到 opened，回收写进账本', async () => {
    const h = await seedRecycled();
    const blocked = await h.service.openProject(inputOf(docsOf(VAR_MOOD, VAR_TRUST)));
    expect(blocked.kind).toBe('recycled');

    const retried = await h.service.retryWithRecycledAllowed();
    expect(retried.kind).toBe('opened');
    const opened = openedOf(retried as Kojo2StorageOpenResult);
    expect(opened.commit.changed).toBe(true);
    const slots = slotsOf(h.storage, PROJECT);
    expect(slots[`${URI}#信赖`]).toBe('save#0'); // 回收来的槽
    expect(slots[`${URI}#心情`]).toBe('save#1'); // 保留的槽
    expect(slots).not.toHaveProperty(`${URI}#好感`);
    const records = ledgerAt(h.storage, PROJECT).records;
    if (typeof records !== 'object' || records === null) throw new Error('账本没有 records');
    expect((records as Record<string, unknown>)[`${URI}#信赖`]).toEqual({
      slot: 0,
      valueType: 'int',
      arraySize: null,
    });
  });

  it('没有待重试的装配：retryWithRecycledAllowed → nothing-to-retry（不伪造成功）', async () => {
    const h = harnessOf();
    expect((await h.service.retryWithRecycledAllowed()).kind).toBe('nothing-to-retry');
    expect(h.storage.ops).toEqual([]);
  });

  it('recycled 之后关项目：待重试作废，再调 retry 也是 nothing-to-retry', async () => {
    const h = await seedRecycled();
    const blocked = await h.service.openProject(inputOf(docsOf(VAR_MOOD, VAR_TRUST)));
    expect(blocked.kind).toBe('recycled');

    const closed = await h.service.closeProject();
    expect(closed.kind).toBe('idle'); // 被阻断时没有实例可关
    expect((await h.service.retryWithRecycledAllowed()).kind).toBe('nothing-to-retry');
  });
});

/* ============================== 6. flush 失败 ============================== */

describe('kojo2 槽位账本服务 · flush 失败上屏', () => {
  it('正式账本写盘失败：opened 但 flush.ok=false，一条 write-behind 上屏', async () => {
    const h = harnessOf();
    const ledgerKey = ledgerKeyOf(PROJECT);
    h.storage.onSet = (key, value, fake) => {
      if (key === ledgerKey) throw new Error('磁盘满了');
      fake.store.set(key, value);
    };
    const result = openedOf(await h.service.openProject(inputOf()));

    expect(result.flush.ok).toBe(false);
    expect(result.flush.failures).toHaveLength(1);
    expect(problemsOf(result)).toEqual([KOJO2_STORAGE_HOST_PROBLEM_CODES.writeBehindFailed]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]?.message).toContain('磁盘满了');
    const written = lastWritten(h);
    expect(written[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.writeBehindFailed);
    // 落点与来源：虚拟项目路径 + 稳定的来源标签（问题面板按这两样分组）
    expect(written[0]?.path).toBe(KOJO2_STORAGE_SERVICE_PROBLEM_PATH);
    expect(written[0]?.source).toBe(KOJO2_STORAGE_SERVICE_PROBLEM_SOURCE);
    // 实例仍算已打开（内存镜像已提交；下次打开以盘为准）
    expect(h.service.host()).not.toBeNull();
    expect(h.service.getSnapshot().phase).toBe('open');
  });

  it('暂存与正式两次写都失败：两条问题进面板，但只发一条通知', async () => {
    const h = harnessOf();
    h.storage.onSet = () => {
      throw new Error('IO 全挂');
    };
    const result = openedOf(await h.service.openProject(inputOf()));
    expect(result.flush.ok).toBe(false);
    expect(result.flush.failures).toHaveLength(2);
    expect(result.problems).toHaveLength(2);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]?.message).toContain('另有 1 条');
    expect(lastWritten(h)).toHaveLength(2);
  });

  it('flush 失败之后关闭：close 仍能排空队列并丢弃实例（失败不毒化后续）', async () => {
    const h = harnessOf();
    h.storage.onSet = () => {
      throw new Error('一次性 IO 错');
    };
    openedOf(await h.service.openProject(inputOf()));
    h.storage.onSet = null; // 盘恢复
    const closed = await h.service.closeProject();
    expect(closed.kind).toBe('closed');
    if (closed.kind !== 'closed') return;
    expect(closed.flush.ok).toBe(true);
    expect(h.service.host()).toBeNull();
  });

  it('上屏通道自身抛错：流程不被打断、结果照旧（错误只进 console，不反向污染存储）', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const storage = new FakeStorage();
      const service = createKojo2StorageService({
        kernel: kernelOf(storage),
        isEnabled: () => true,
        now: () => AT,
        writeProblems: () => {
          throw new Error('问题面板挂了');
        },
        notify: () => {
          throw new Error('通知中心挂了');
        },
      });
      const result = openedOf(await service.openProject(inputOf()));
      expect(result.flush.ok).toBe(true);
      expect(service.host()).not.toBeNull();
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });
});

/* ============================== 7. flag 关 / 并发 ============================== */

describe('kojo2 槽位账本服务 · flag 关与并发', () => {
  it('flag 关：零实例、零端口、零写、零通知（open 与 close 都只有 disabled）', async () => {
    // 假 kernel 只给了 storage 面：服务若挂任何总线监听都会当场炸 ⇒ 这条同时钉住「零监听」。
    const storage = new FakeStorage();
    let calls = 0;
    const notices: Notice[] = [];
    const writes: ProblemWrite[] = [];
    const service = createKojo2StorageService({
      kernel: {
        storage: {
          global(): Kojo2StorageHostStorage {
            calls += 1;
            return storage;
          },
        },
      },
      notify: (notice) => {
        notices.push(notice);
      },
      writeProblems: (path, items) => {
        writes.push({ path, items });
      },
      isEnabled: () => false,
    });

    const opened = await service.openProject(inputOf());
    expect(opened.kind).toBe('disabled');
    expect(calls).toBe(0); // 连 storage.global() 都没摸
    expect(storage.ops).toEqual([]);
    expect(notices).toEqual([]);
    expect(writes).toEqual([]);
    expect(service.host()).toBeNull();
    expect(service.getSnapshot().phase).toBe('disabled');

    expect((await service.closeProject()).kind).toBe('disabled');
    expect(calls).toBe(0);
    expect(writes).toEqual([]);
  });

  it('flag 在打开后被关：closeProject 仍然 flush 并丢弃实例（不静默丢队列）', async () => {
    const h = harnessOf();
    openedOf(await h.service.openProject(inputOf()));
    h.setEnabled(false);
    const closed = await h.service.closeProject();
    expect(closed.kind).toBe('closed');
    expect(h.service.host()).toBeNull();
    expect(h.service.getSnapshot().phase).toBe('disabled');
  });

  it('flag 在 open 在飞时被关：close 不会回 disabled（否则会把待落账的实例当成不存在）', async () => {
    const h = harnessOf();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    h.storage.onGet = async (key, fake) => {
      await gate;
      return fake.store.get(key);
    };

    const opening = h.service.openProject(inputOf());
    h.setEnabled(false);
    const earlyClose = await h.service.closeProject();
    expect(earlyClose.kind).toBe('busy');

    release();
    openedOf(await opening);
    const closed = await h.service.closeProject();
    expect(closed.kind).toBe('closed');
    expect(h.service.host()).toBeNull();
  });

  it('并发 open：第二次立刻 busy，第一次照常完成', async () => {
    const h = harnessOf();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    h.storage.onGet = async (key, fake) => {
      await gate;
      return fake.store.get(key);
    };

    const first = h.service.openProject(inputOf());
    const second = await h.service.openProject(inputOf());
    expect(second.kind).toBe('busy');
    if (second.kind === 'busy') expect(second.detail).toContain('在飞');

    release();
    expect(openedOf(await first).flush.ok).toBe(true);
  });

  it('open 在飞时 close：close 拿到 busy，不抢跑 flush', async () => {
    const h = harnessOf();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    h.storage.onGet = async (key, fake) => {
      await gate;
      return fake.store.get(key);
    };

    const opening = h.service.openProject(inputOf());
    const closed = await h.service.closeProject();
    expect(closed.kind).toBe('busy');

    release();
    openedOf(await opening);
    const after = await h.service.closeProject();
    expect(after.kind).toBe('closed');
  });
});
