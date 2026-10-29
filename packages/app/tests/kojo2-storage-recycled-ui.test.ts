/**
 * K2-STORAGE-RECYCLED-UI（设计稿 §16.3 A3.6）的判据闸：
 *
 * ① recycled 阻断 → 通知带**动作**（既有 NotificationCenter 原生 action，不新造通知系统）；
 * ② 动作 = `retryWithRecycledAllowed()`；成功清 `kojo2:storage` 问题簇 + toast 一次，
 *    失败按既有失败面（问题簇 + 一条 error）上屏；动作只出现一次；
 * ③ flag 关 = 零服务、零命令、零通知、零写；
 * ④ 会话内 `.kojo2` 变更 → 防抖合并 → `refreshDeclarations`；离开项目后不再触发；
 * ⑤ 刷新幂等：同声明零重复写盘；失败不拆已 opened 实例（fail-closed 但可见）；
 * ⑥ 命令表二次入口只在「没有可做的事」时补一句人话（成功/失败仍由服务上屏）。
 *
 * 全部走真 core + 真注册表 + 真账本，只把「盘」「通知」「问题面板」「计时器」换成假端口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KOJO2_STORAGE_SERVICE_PROBLEM_CODES,
  KOJO2_STORAGE_SERVICE_PROBLEM_PATH,
  createKojo2StorageService,
  type Kojo2StorageOpenInput,
  type Kojo2StorageRefreshInput,
  type Kojo2StorageService,
  type Kojo2StorageServiceAction,
  type Kojo2StorageServiceAdapter,
  type Kojo2StorageServiceKernel,
} from '../src/ui/kojo2-storage-service';
import {
  KOJO2_STORAGE_HOST_LEDGER_PREFIX,
  KOJO2_STORAGE_HOST_PROBLEM_CODES,
  kojo2StorageProjectHash,
  type Kojo2StorageHostStorage,
} from '../src/ui/kojo2-storage-adapter';
import {
  KOJO2_STORAGE_DEFAULT_CLASSES,
  type Kojo2StorageDocument,
  type Kojo2StorageKeyInput,
} from '../src/ui/kojo2-storage-registry';
import { parseKojo2StorageLedger } from '../src/ui/kojo2-storage-persist';
import {
  createKojo2DeclRefresh,
  KOJO2_DECL_REFRESH_DEBOUNCE_MS,
  type Kojo2DeclRefreshBatch,
} from '../src/ui/kojo2-storage-refresh';
import {
  createKojo2StorageRetryCommand,
  KOJO2_STORAGE_RETRY_COMMAND_CATEGORY,
  KOJO2_STORAGE_RETRY_COMMAND_ID,
  KOJO2_STORAGE_RETRY_COMMAND_TITLE,
  runKojo2StorageRetryCommand,
} from '../src/ui/kojo2-storage-retry-command';
import type { EditorProblem } from '../src/ui/problem-store';

/* ============================== 假端口 ============================== */

interface StorageOp {
  readonly op: 'get' | 'set' | 'delete';
  readonly key: string;
}

/** 内存假 kernel.storage：异步签名、同步可见；`ops` 用来断言顺序与零写 */
class FakeStorage implements Kojo2StorageHostStorage {
  readonly store = new Map<string, unknown>();
  readonly ops: StorageOp[] = [];
  onGet: ((key: string, fake: FakeStorage) => Promise<unknown> | unknown) | null = null;
  onSet:
    | ((key: string, value: unknown, fake: FakeStorage) => Promise<void> | void)
    | null = null;

  async get(key: string): Promise<unknown> {
    this.ops.push({ op: 'get', key });
    if (this.onGet !== null) return this.onGet(key, this);
    return this.store.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.ops.push({ op: 'set', key });
    if (this.onSet !== null) {
      await this.onSet(key, value, this);
      return;
    }
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.ops.push({ op: 'delete', key });
    this.store.delete(key);
  }

  writes(): readonly StorageOp[] {
    return this.ops.filter((op) => op.op === 'set' || op.op === 'delete');
  }

  resetOps(): void {
    this.ops.length = 0;
  }
}

/** 带 kernel PS-2 显式三态的假存储（本文件只在需要区分 corrupt 时用） */
function kernelOf(storage: Kojo2StorageHostStorage): Kojo2StorageServiceKernel {
  return {
    storage: {
      global(): Kojo2StorageHostStorage {
        return storage;
      },
    },
  };
}

interface CapturedNotice {
  readonly kind: 'info' | 'error';
  readonly message: string;
  readonly detail?: string;
  readonly action?: Kojo2StorageServiceAction;
}

interface ProblemWrite {
  readonly path: string;
  readonly items: readonly EditorProblem[];
}

interface Harness {
  readonly storage: FakeStorage;
  readonly service: Kojo2StorageService;
  readonly notices: CapturedNotice[];
  readonly writes: ProblemWrite[];
  setEnabled(on: boolean): void;
}

function harnessOf(storage: FakeStorage = new FakeStorage()): Harness {
  const notices: CapturedNotice[] = [];
  const writes: ProblemWrite[] = [];
  let enabled = true;
  const service = createKojo2StorageService({
    kernel: kernelOf(storage),
    notify: (notice) => {
      notices.push(notice);
    },
    writeProblems: (path, items) => {
      writes.push({ path, items });
    },
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
const OTHER_KOJO2 = 'D:/proj/chara/you.kojo2';
const PROJECT = 'D:/proj';
const FINGERPRINT = 'kojo2-test-disc@1';
const AT = '2026-10-22T00:00:00.000Z';

const VAR_FAVOR = '# 设 好感 整数 = 0 存档';
const VAR_MOOD = '# 设 心情 整数 = 0 存档';
const VAR_TRUST = '# 设 信赖 整数 = 0 存档';

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

function docsOf(...lines: readonly string[]): readonly Kojo2StorageDocument[] {
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

function refreshOf(
  documents: readonly Kojo2StorageDocument[],
  overrides: Partial<Kojo2StorageRefreshInput> = {},
): Kojo2StorageRefreshInput {
  return { documents, ...overrides };
}

function ledgerKeyOf(projectKey: string): string {
  return `${KOJO2_STORAGE_HOST_LEDGER_PREFIX}${kojo2StorageProjectHash(projectKey)}`;
}

function ledgerTextAt(storage: FakeStorage, projectKey: string): string {
  const value = storage.store.get(ledgerKeyOf(projectKey));
  if (typeof value !== 'string') throw new Error(`项目「${projectKey}」盘上没有账本文本`);
  return value;
}

function slotsOf(storage: FakeStorage, projectKey: string): Record<string, unknown> {
  const parsed = parseKojo2StorageLedger(ledgerTextAt(storage, projectKey));
  if (parsed.kind !== 'ok') throw new Error(`盘上的账本不可解析：${parsed.kind}`);
  const slots = parsed.ledger.slots;
  if (typeof slots !== 'object' || slots === null) throw new Error('账本没有 slots');
  return slots as Record<string, unknown>;
}

function openedOf<T extends { kind: string }>(
  result: T,
): Extract<T, { kind: 'opened' }> {
  if (result.kind !== 'opened') {
    throw new Error(`期望 opened，实际 ${result.kind}：${JSON.stringify(result)}`);
  }
  return result as Extract<T, { kind: 'opened' }>;
}

/** 上屏通道的最新一条问题列表（没有写过 → 空数组） */
function lastWritten(h: Harness): readonly EditorProblem[] {
  const last = h.writes[h.writes.length - 1];
  return last?.items ?? [];
}

/** 唯一的动作（多于/少于一条都直接失败：动作必须只出现一次） */
function actionOf(h: Harness): Kojo2StorageServiceAction {
  const actions = h.notices.flatMap((notice) =>
    notice.action === undefined ? [] : [notice.action],
  );
  expect(actions).toHaveLength(1);
  const action = actions[0];
  if (action === undefined) throw new Error('没有动作');
  return action;
}

/* ============================== 打开 / 回收 fixture ============================== */

/** 已打开「好感 + 心情」，随后关项目、重置端口调用，用于刷新测试 */
async function openedHarness(): Promise<Harness> {
  const h = harnessOf();
  openedOf(await h.service.openProject(inputOf(docsOf(VAR_FAVOR, VAR_MOOD))));
  h.storage.resetOps();
  h.notices.length = 0;
  h.writes.length = 0;
  return h;
}

/** 造出「删除好感 + 新增信赖 ⇒ 信赖回收槽 0」的 recycled 现场 */
async function recycledHarness(): Promise<Harness> {
  const h = harnessOf();
  openedOf(await h.service.openProject(inputOf(docsOf(VAR_FAVOR, VAR_MOOD))));
  const closed = await h.service.closeProject();
  expect(closed.kind).toBe('closed');
  h.storage.resetOps();
  const result = await h.service.openProject(inputOf(docsOf(VAR_MOOD, VAR_TRUST)));
  if (result.kind !== 'recycled') {
    throw new Error(`期望 recycled，实际 ${result.kind}：${JSON.stringify(result)}`);
  }
  return h;
}

/* ============================== 1. 回收阻断 → 通知动作 ============================== */

describe('K2-STORAGE-RECYCLED-UI · 回收阻断的通知动作', () => {
  it('recycled：一条 error 通知 + 唯一动作「放行回收并重试」，面板同一份问题', async () => {
    const h = await recycledHarness();
    expect(h.notices).toHaveLength(1);
    const notice = h.notices[0];
    expect(notice?.kind).toBe('error');
    expect(notice?.message).toContain('回收');
    expect(notice?.action?.label).toBe('放行回收并重试');
    // 问题面板落点是虚拟 kojo2:storage，码是宿主 recycled 码（前面还有首开/重开的清账写）
    expect(h.writes.length).toBeGreaterThan(0);
    expect(h.writes.every((w) => w.path === KOJO2_STORAGE_SERVICE_PROBLEM_PATH)).toBe(true);
    expect(lastWritten(h)[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.recycledSlots);
    // 零写：回收阻断发生在 commit，盘上旧账原样
    expect(h.storage.writes()).toEqual([]);
  });

  it('动作只出现一次（不会既有 error toast 又叠一条带动作的 toast）', async () => {
    const h = await recycledHarness();
    expect(h.notices.filter((n) => n.action !== undefined)).toHaveLength(1);
    expect(h.notices.filter((n) => n.kind === 'error')).toHaveLength(1);
  });

  it('动作成功后：问题簇清成空表 + 唯一一条 info 庆功 toast', async () => {
    const h = await recycledHarness();
    const action = actionOf(h);
    const result = (await action.run()) as { kind: string };
    expect(result.kind).toBe('opened');
    // 最后一条问题写必须是空表（清账），而不是残留 recycled
    expect(lastWritten(h)).toEqual([]);
    expect(h.writes[h.writes.length - 1]?.path).toBe(KOJO2_STORAGE_SERVICE_PROBLEM_PATH);
    const infos = h.notices.filter((n) => n.kind === 'info');
    expect(infos).toHaveLength(1);
    expect(infos[0]?.message).toContain('已放行回收槽位并重试');
    // 回收写进账本（信赖拿到槽 0），且动作不再出现
    expect(slotsOf(h.storage, PROJECT)[`${URI}#信赖`]).toBe('save#0');
    expect(h.notices.filter((n) => n.action !== undefined)).toHaveLength(1);
  });

  it('动作失败：按既有失败面上屏（问题簇 + 一条 error），不报喜', async () => {
    const h = await recycledHarness();
    const action = actionOf(h);
    // 让重试的 hydrate 读不动：读不动 ≠ 不存在，必须零写阻断
    h.storage.onGet = () => {
      throw new Error('IPC 断了');
    };
    const result = (await action.run()) as { kind: string };
    expect(result.kind).toBe('blocked');
    expect(lastWritten(h)[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.storageUnavailable);
    expect(h.notices.filter((n) => n.kind === 'info')).toHaveLength(0);
    const errors = h.notices.filter((n) => n.kind === 'error');
    expect(errors).toHaveLength(2); // 原 recycled + 失败
    expect(errors[1]?.action).toBeUndefined();
    expect(h.notices.filter((n) => n.action !== undefined)).toHaveLength(1);
  });

  it('动作只能兑现一次：成功后再调只回 nothing-to-retry，并补一句「没有待放行」', async () => {
    const h = await recycledHarness();
    const action = actionOf(h);
    await action.run();
    const noticeCount = h.notices.length;
    const again = (await action.run()) as { kind: string };
    expect(again.kind).toBe('nothing-to-retry');
    expect(h.notices).toHaveLength(noticeCount + 1);
    expect(h.notices[h.notices.length - 1]?.kind).toBe('info');
    expect(h.notices[h.notices.length - 1]?.message).toContain('没有待放行的回收槽位');
    // 不会因此再多出一个动作
    expect(h.notices.filter((n) => n.action !== undefined)).toHaveLength(1);
  });

  it('直接调 retryWithRecycledAllowed 成功：同样清簇 + toast 一次', async () => {
    const h = await recycledHarness();
    const result = (await h.service.retryWithRecycledAllowed()) as { kind: string };
    expect(result.kind).toBe('opened');
    expect(lastWritten(h)).toEqual([]);
    expect(h.notices.filter((n) => n.kind === 'info')).toHaveLength(1);
    expect(h.service.getSnapshot().openCount).toBe(2); // 首开 + 放行重试
    expect(h.service.getSnapshot().commitCount).toBe(2);
  });

  it('没有待重试：retry 回 nothing-to-retry，零通知零写', async () => {
    const h = harnessOf();
    const result = await h.service.retryWithRecycledAllowed();
    expect(result.kind).toBe('nothing-to-retry');
    expect(h.notices).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.storage.ops).toEqual([]);
  });

  it('flag 关：零实例、零动作、零通知、零写（open/retry 都只有 disabled）', async () => {
    const h = harnessOf();
    h.setEnabled(false);
    expect((await h.service.openProject(inputOf())).kind).toBe('disabled');
    expect((await h.service.retryWithRecycledAllowed()).kind).toBe('disabled');
    expect(h.notices).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.storage.ops).toEqual([]);
    expect(h.service.host()).toBeNull();
    expect(h.service.getSnapshot().phase).toBe('disabled');
  });
});

/* ============================== 2. 会话内声明刷新 ============================== */

describe('K2-STORAGE-RECYCLED-UI · 会话内声明刷新（服务）', () => {
  it('幂等刷新：同声明 + 同形状 ⇒ changed=false、盘面零写、openCount 不涨', async () => {
    const h = await openedHarness();
    const result = await h.service.refreshDeclarations(
      refreshOf(docsOf(VAR_FAVOR, VAR_MOOD)),
    );
    expect(result.kind).toBe('refreshed');
    if (result.kind !== 'refreshed') return;
    expect(result.commit.changed).toBe(false);
    expect(result.problems).toEqual([]);
    expect(h.storage.ops.map((op) => op.op)).toEqual(['get']); // 只水合读一次
    expect(h.storage.writes()).toEqual([]);
    expect(h.writes).toEqual([]); // 无旧问题可清 ⇒ 连空表都不写
    const snapshot = h.service.getSnapshot();
    expect(snapshot.phase).toBe('open');
    expect(snapshot.openCount).toBe(1);
    expect(snapshot.commitCount).toBe(2);
  });

  it('新增声明：刷新后落进账本，实例仍是同一个项目（openCount 不涨）', async () => {
    const h = await openedHarness();
    const result = await h.service.refreshDeclarations(
      refreshOf(docsOf(VAR_FAVOR, VAR_MOOD, VAR_TRUST)),
    );
    expect(result.kind).toBe('refreshed');
    const slots = slotsOf(h.storage, PROJECT);
    expect(slots[`${URI}#好感`]).toBe('save#0');
    expect(slots[`${URI}#心情`]).toBe('save#1');
    expect(slots[`${URI}#信赖`]).toBe('save#2');
    expect(h.service.getSnapshot().openCount).toBe(1);
    expect(h.service.getSnapshot().projectKey).toBe(PROJECT);
  });

  it('清单不完整：零写 skipped + warning，已 opened 实例原样保留', async () => {
    const h = await openedHarness();
    const previousHost = h.service.host();
    const result = await h.service.refreshDeclarations(
      refreshOf(docsOf(VAR_FAVOR), { documentsComplete: false }),
    );
    expect(result.kind).toBe('skipped');
    if (result.kind !== 'skipped') return;
    expect(result.reason).toBe('documents-incomplete');
    expect(h.service.host()).toBe(previousHost);
    expect(h.service.getSnapshot().phase).toBe('open');
    expect(h.storage.ops).toEqual([]); // 连水合都不做
    expect(h.storage.writes()).toEqual([]);
    expect(lastWritten(h)[0]?.code).toBe(
      KOJO2_STORAGE_SERVICE_PROBLEM_CODES.documentsIncomplete,
    );
    expect(lastWritten(h)[0]?.severity).toBe('warning');
  });

  it('零文档：零写 skipped(no-documents)、零通知，实例原样保留', async () => {
    const h = await openedHarness();
    const previousHost = h.service.host();
    const result = await h.service.refreshDeclarations(refreshOf([]));
    expect(result.kind).toBe('skipped');
    if (result.kind !== 'skipped') return;
    expect(result.reason).toBe('no-documents');
    expect(h.service.host()).toBe(previousHost);
    expect(h.storage.ops).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it('注册表装配失败（URI 重复）：blocked(registry) 且不拆已 opened 实例', async () => {
    const h = await openedHarness();
    const previousHost = h.service.host();
    const documents: readonly Kojo2StorageDocument[] = [
      { uri: URI, source: `${VAR_FAVOR}\n` },
      { uri: URI, source: `${VAR_MOOD}\n` },
    ];
    const result = await h.service.refreshDeclarations(refreshOf(documents));
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.stage).toBe('registry');
    expect(h.service.host()).toBe(previousHost);
    expect(h.service.getSnapshot().phase).toBe('open');
    expect(h.storage.writes()).toEqual([]);
    expect(lastWritten(h)[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidInput);
    expect(h.notices).toHaveLength(1);
  });

  it('刷新被 recycled 挡下：零写、旧实例保留、通知带动作', async () => {
    const h = await openedHarness();
    const previousHost = h.service.host();
    const result = await h.service.refreshDeclarations(
      refreshOf(docsOf(VAR_MOOD, VAR_TRUST)),
    );
    expect(result.kind).toBe('recycled');
    expect(h.service.host()).toBe(previousHost);
    expect(h.service.getSnapshot().phase).toBe('open');
    expect(h.storage.writes()).toEqual([]);
    expect(lastWritten(h)[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.recycledSlots);
    expect(actionOf(h).label).toBe('放行回收并重试');
  });

  it('刷新被 recycled → 动作重试的是**刷新**：成功后换实例、清簇、报喜一次', async () => {
    const h = await openedHarness();
    const previousHost = h.service.host();
    const recycled = await h.service.refreshDeclarations(
      refreshOf(docsOf(VAR_MOOD, VAR_TRUST)),
    );
    expect(recycled.kind).toBe('recycled');
    const action = actionOf(h);

    const retried = (await action.run()) as { kind: string };
    expect(retried.kind).toBe('refreshed');
    expect(h.service.host()).not.toBe(previousHost);
    expect(slotsOf(h.storage, PROJECT)[`${URI}#信赖`]).toBe('save#0');
    expect(lastWritten(h)).toEqual([]);
    expect(h.notices.filter((n) => n.kind === 'info')).toHaveLength(1);
    // 刷新重试不冒充一次「打开」
    expect(h.service.getSnapshot().openCount).toBe(1);
    expect(h.service.getSnapshot().commitCount).toBe(2);
  });

  it('刷新 recycled 后又来一次失败刷新：旧的待重试作废（不拿旧清单重跑）', async () => {
    const h = await openedHarness();
    expect(
      (await h.service.refreshDeclarations(refreshOf(docsOf(VAR_MOOD, VAR_TRUST)))).kind,
    ).toBe('recycled');
    expect(
      (
        await h.service.refreshDeclarations(
          refreshOf(docsOf(VAR_FAVOR), { documentsComplete: false }),
        )
      ).kind,
    ).toBe('skipped');
    const retry = await h.service.retryWithRecycledAllowed();
    expect(retry.kind).toBe('nothing-to-retry');
    expect(h.storage.writes()).toEqual([]);
    // 实例仍在、账本没动
    expect(h.service.getSnapshot().phase).toBe('open');
  });

  it('没有已打开实例：refresh → nothing-to-refresh，零通知零写', async () => {
    const h = harnessOf();
    const result = await h.service.refreshDeclarations(
      refreshOf(docsOf(VAR_FAVOR)),
    );
    expect(result.kind).toBe('nothing-to-refresh');
    expect(h.notices).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.storage.ops).toEqual([]);
  });

  it('并发：open 在飞时 refresh 立刻 busy，不抢跑', async () => {
    const h = harnessOf();
    let release!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    h.storage.onGet = () => gate;
    const opening = h.service.openProject(inputOf(docsOf(VAR_FAVOR)));
    const busy = await h.service.refreshDeclarations(refreshOf(docsOf(VAR_FAVOR)));
    expect(busy.kind).toBe('busy');
    release(undefined);
    expect((await opening).kind).toBe('opened');
  });

  it('刷新入参非法（documents 不是数组）：blocked(input)、零写、实例保留', async () => {
    const h = await openedHarness();
    const previousHost = h.service.host();
    const result = await h.service.refreshDeclarations({
      documents: 'not-an-array' as unknown as readonly Kojo2StorageDocument[],
    });
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.stage).toBe('input');
    expect(h.service.host()).toBe(previousHost);
    expect(h.storage.ops).toEqual([]);
    expect(lastWritten(h)[0]?.code).toBe(KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidInput);
  });

  it('刷新水合坏账：blocked(hydrate)、零写、实例保留、错误可见', async () => {
    const h = await openedHarness();
    const previousHost = h.service.host();
    h.storage.onGet = () => {
      throw new Error('盘读不动');
    };
    const result = await h.service.refreshDeclarations(
      refreshOf(docsOf(VAR_FAVOR, VAR_MOOD, VAR_TRUST)),
    );
    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.stage).toBe('hydrate');
    expect(h.service.host()).toBe(previousHost);
    expect(h.storage.writes()).toEqual([]);
    expect(lastWritten(h)[0]?.code).toBe(
      KOJO2_STORAGE_HOST_PROBLEM_CODES.storageUnavailable,
    );
    expect(h.notices).toHaveLength(1);
  });
});

/* ============================== 3. 防抖刷新调度（file.changed 语义） ============================== */

const BATCH: Kojo2DeclRefreshBatch = Object.freeze({
  documents: docsOf(VAR_FAVOR, VAR_MOOD),
  documentsComplete: true,
});

interface RefreshProbe {
  readonly controller: ReturnType<typeof createKojo2DeclRefresh>;
  readonly calls: Kojo2StorageDocument[][];
  readonly failures: string[];
}

function probeOf(
  overrides: Partial<{
    collect: () => Promise<Kojo2DeclRefreshBatch> | Kojo2DeclRefreshBatch;
    refresh: (input: {
      documents: readonly Kojo2StorageDocument[];
      documentsComplete?: boolean;
    }) => Promise<{ kind: string }>;
  }> = {},
): RefreshProbe {
  const calls: Kojo2StorageDocument[][] = [];
  const failures: string[] = [];
  const controller = createKojo2DeclRefresh({
    service: {
      refreshDeclarations: async (input) => {
        calls.push([...input.documents]);
        if (overrides.refresh !== undefined) return overrides.refresh(input);
        return { kind: 'refreshed' };
      },
    },
    collect: overrides.collect ?? (async () => BATCH),
    debounceMs: KOJO2_DECL_REFRESH_DEBOUNCE_MS,
    onFailure: (message) => failures.push(message),
  });
  return { controller, calls, failures };
}

describe('K2-STORAGE-RECYCLED-UI · `.kojo2` 变更防抖', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('.kojo2 变更：窗口内 pending=true，到点只刷新一次', async () => {
    const probe = probeOf();
    probe.controller.noteChange(URI);
    expect(probe.controller.getSnapshot().pending).toBe(true);
    expect(probe.controller.getSnapshot().changeCount).toBe(1);
    expect(probe.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(KOJO2_DECL_REFRESH_DEBOUNCE_MS);
    expect(probe.controller.getSnapshot().pending).toBe(false);
    expect(probe.controller.getSnapshot().refreshCount).toBe(1);
    expect(probe.controller.getSnapshot().lastKind).toBe('refreshed');
    expect(probe.calls).toHaveLength(1);
  });

  it('窗口内多条变更合并成一次（debounce 重置而不是排队）', async () => {
    const probe = probeOf();
    probe.controller.noteChange(URI);
    await vi.advanceTimersByTimeAsync(100);
    probe.controller.noteChange(OTHER_KOJO2);
    await vi.advanceTimersByTimeAsync(100);
    probe.controller.noteChange('D:/proj/chara/third.kojo2');
    await vi.advanceTimersByTimeAsync(KOJO2_DECL_REFRESH_DEBOUNCE_MS - 1);
    expect(probe.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe.calls).toHaveLength(1);
    expect(probe.controller.getSnapshot().changeCount).toBe(3);
  });

  it('非 2.0 路径（.kojo1 / .md / .kojo2.bak）零动作、不计变更', async () => {
    const probe = probeOf();
    probe.controller.noteChange('D:/proj/a.kojo1');
    probe.controller.noteChange('D:/proj/readme.md');
    probe.controller.noteChange('D:/proj/a.kojo2.bak');
    expect(probe.controller.getSnapshot()).toMatchObject({
      pending: false,
      changeCount: 0,
      refreshCount: 0,
    });
    await vi.advanceTimersByTimeAsync(KOJO2_DECL_REFRESH_DEBOUNCE_MS);
    expect(probe.calls).toHaveLength(0);
  });

  it('`.kojo` 是 2.0 的主扩展名：变更照样计入并触发一次刷新', async () => {
    const probe = probeOf();
    probe.controller.noteChange('D:/proj/a.kojo');
    expect(probe.controller.getSnapshot()).toMatchObject({ pending: true, changeCount: 1 });
    await vi.advanceTimersByTimeAsync(KOJO2_DECL_REFRESH_DEBOUNCE_MS);
    expect(probe.calls).toHaveLength(1);
  });

  it('离开项目（dispose）取消挂起窗口：之后的变更一律不触发', async () => {
    const probe = probeOf();
    probe.controller.noteChange(URI);
    probe.controller.dispose();
    expect(probe.controller.getSnapshot()).toMatchObject({ disposed: true, pending: false });
    probe.controller.noteChange(URI);
    await vi.advanceTimersByTimeAsync(KOJO2_DECL_REFRESH_DEBOUNCE_MS);
    expect(probe.calls).toHaveLength(0);
    expect(probe.controller.getSnapshot().changeCount).toBe(1);
  });

  it('collect 在飞时 dispose：迟到的批次不再提交（离开项目不触发）', async () => {
    let release!: (batch: Kojo2DeclRefreshBatch) => void;
    const gate = new Promise<Kojo2DeclRefreshBatch>((resolve) => {
      release = resolve;
    });
    const probe = probeOf({ collect: () => gate });
    probe.controller.noteChange(URI);
    await vi.advanceTimersByTimeAsync(KOJO2_DECL_REFRESH_DEBOUNCE_MS);
    expect(probe.controller.getSnapshot().inFlight).toBe(true);
    probe.controller.dispose();
    release(BATCH);
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.calls).toHaveLength(0);
    expect(probe.controller.getSnapshot().refreshCount).toBe(0);
  });

  it('collect 抛错：一次人话上屏、不刷新、不抛出', async () => {
    const probe = probeOf({
      collect: () => {
        throw new Error('目录读不动');
      },
    });
    probe.controller.noteChange(URI);
    await vi.advanceTimersByTimeAsync(KOJO2_DECL_REFRESH_DEBOUNCE_MS);
    expect(probe.failures).toHaveLength(1);
    expect(probe.failures[0]).toContain('目录读不动');
    expect(probe.calls).toHaveLength(0);
    expect(probe.controller.getSnapshot().refreshCount).toBe(0);
  });

  it('刷新服务抛错：同样只报一次，不计刷新次数、不抛出', async () => {
    const probe = probeOf({
      refresh: () => Promise.reject(new Error('账本服务病了')),
    });
    probe.controller.noteChange(URI);
    await vi.advanceTimersByTimeAsync(KOJO2_DECL_REFRESH_DEBOUNCE_MS);
    expect(probe.failures).toHaveLength(1);
    expect(probe.failures[0]).toContain('账本服务病了');
    expect(probe.controller.getSnapshot().refreshCount).toBe(0);
  });

  it('刷新飞行中又来变更：不并发，当前这拍结束后重新防抖再跑一次', async () => {
    let release!: (result: { kind: string }) => void;
    const gate = new Promise<{ kind: string }>((resolve) => {
      release = resolve;
    });
    let n = 0;
    const probe = probeOf({
      refresh: () => {
        n += 1;
        return n === 1 ? gate : Promise.resolve({ kind: 'refreshed' });
      },
    });
    probe.controller.noteChange(URI);
    await vi.advanceTimersByTimeAsync(KOJO2_DECL_REFRESH_DEBOUNCE_MS);
    expect(probe.calls).toHaveLength(1);
    probe.controller.noteChange(URI);
    await vi.advanceTimersByTimeAsync(KOJO2_DECL_REFRESH_DEBOUNCE_MS);
    expect(probe.calls).toHaveLength(1); // 没并发第二次
    release({ kind: 'refreshed' });
    await vi.advanceTimersByTimeAsync(0); // finally 里重新排窗口
    await vi.advanceTimersByTimeAsync(KOJO2_DECL_REFRESH_DEBOUNCE_MS);
    expect(probe.calls).toHaveLength(2);
  });

  it('whenIdle：等飞行中的一拍落地（dispose 不取消已发出的服务调用）', async () => {
    let release!: (result: { kind: string }) => void;
    const gate = new Promise<{ kind: string }>((resolve) => {
      release = resolve;
    });
    const probe = probeOf({ refresh: () => gate });
    probe.controller.noteChange(URI);
    await vi.advanceTimersByTimeAsync(KOJO2_DECL_REFRESH_DEBOUNCE_MS);
    expect(probe.controller.getSnapshot().inFlight).toBe(true);
    probe.controller.dispose();
    let settled = false;
    const idle = probe.controller.whenIdle().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false); // 服务调用还没回来，whenIdle 必须等
    release({ kind: 'refreshed' });
    await idle;
    expect(settled).toBe(true);
  });

  it('flushNow：立即跑掉挂起窗口；没有挂起时返回 false', async () => {
    const probe = probeOf();
    expect(await probe.controller.flushNow()).toBe(false);
    probe.controller.noteChange(URI);
    expect(await probe.controller.flushNow()).toBe(true);
    expect(probe.calls).toHaveLength(1);
    expect(probe.controller.getSnapshot().pending).toBe(false);
    expect(await probe.controller.flushNow()).toBe(false);
  });
});

/* ============================== 4. 调度 + 真服务（落账判据） ============================== */

describe('K2-STORAGE-RECYCLED-UI · 会话内变更真的落账', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('文件变更 → 防抖 → refreshDeclarations：新声明进账本，openCount 不涨', async () => {
    const h = await openedHarness();
    const controller = createKojo2DeclRefresh({
      service: h.service,
      collect: async () => ({
        documents: docsOf(VAR_FAVOR, VAR_MOOD, VAR_TRUST),
        documentsComplete: true,
      }),
      debounceMs: KOJO2_DECL_REFRESH_DEBOUNCE_MS,
    });
    controller.noteChange(URI);
    await vi.advanceTimersByTimeAsync(KOJO2_DECL_REFRESH_DEBOUNCE_MS);

    expect(slotsOf(h.storage, PROJECT)[`${URI}#信赖`]).toBe('save#2');
    expect(h.service.getSnapshot().openCount).toBe(1);
    expect(h.service.getSnapshot().commitCount).toBe(2);
    expect(h.storage.ops.map((op) => op.op)).toEqual(['get', 'set', 'set', 'delete']);
    controller.dispose();
  });

  it('多次变更合并后只刷新一次：端口只水合一次，幂等声明零写', async () => {
    const h = await openedHarness();
    const controller = createKojo2DeclRefresh({
      service: h.service,
      collect: async () => ({
        documents: docsOf(VAR_FAVOR, VAR_MOOD),
        documentsComplete: true,
      }),
      debounceMs: KOJO2_DECL_REFRESH_DEBOUNCE_MS,
    });
    controller.noteChange(URI);
    controller.noteChange(OTHER_KOJO2);
    controller.noteChange('D:/proj/chara/third.kojo2');
    await vi.advanceTimersByTimeAsync(KOJO2_DECL_REFRESH_DEBOUNCE_MS);

    expect(h.storage.ops.map((op) => op.op)).toEqual(['get']); // 幂等：只读
    expect(h.storage.writes()).toEqual([]);
    expect(h.service.getSnapshot().openCount).toBe(1);
    expect(h.service.getSnapshot().commitCount).toBe(2);
    controller.dispose();
  });

  it('离开项目：dispose 后变更不重算，账本一个字节不动', async () => {
    const h = await openedHarness();
    const before = ledgerTextAt(h.storage, PROJECT);
    const controller = createKojo2DeclRefresh({
      service: h.service,
      collect: async () => ({
        documents: docsOf(VAR_FAVOR, VAR_MOOD, VAR_TRUST),
        documentsComplete: true,
      }),
      debounceMs: KOJO2_DECL_REFRESH_DEBOUNCE_MS,
    });
    controller.dispose();
    controller.noteChange(URI);
    await vi.advanceTimersByTimeAsync(KOJO2_DECL_REFRESH_DEBOUNCE_MS);
    expect(h.storage.ops).toEqual([]);
    expect(ledgerTextAt(h.storage, PROJECT)).toBe(before);
    expect(h.service.getSnapshot().openCount).toBe(1);
  });
});

/* ============================== 5. 命令表二次入口 ============================== */

describe('K2-STORAGE-RECYCLED-UI · 命令表出口', () => {
  it('命令条目：固定 id / 标题 / 分类，run 点火到同一个重试入口', () => {
    let calls = 0;
    const spec = createKojo2StorageRetryCommand({
      service: {
        retryWithRecycledAllowed: async () => {
          calls += 1;
          return { kind: 'nothing-to-retry' };
        },
      },
      notify: () => undefined,
    });
    expect(spec.id).toBe(KOJO2_STORAGE_RETRY_COMMAND_ID);
    expect(spec.title).toBe(KOJO2_STORAGE_RETRY_COMMAND_TITLE);
    expect(spec.category).toBe(KOJO2_STORAGE_RETRY_COMMAND_CATEGORY);
    spec.run();
    expect(calls).toBe(1);
  });

  it('nothing-to-retry / disabled / busy / nothing-to-refresh 各补一句人话', async () => {
    const messages: string[] = [];
    const deps = (kind: string) => ({
      service: {
        retryWithRecycledAllowed: async () => ({ kind }) as never,
      },
      notify: (notice: { readonly kind: 'info'; readonly message: string }) => {
        messages.push(notice.message);
      },
    });
    await runKojo2StorageRetryCommand(deps('nothing-to-retry'));
    await runKojo2StorageRetryCommand(deps('disabled'));
    await runKojo2StorageRetryCommand(deps('busy'));
    await runKojo2StorageRetryCommand(deps('nothing-to-refresh'));
    expect(messages).toHaveLength(4);
    expect(messages[0]).toContain('没有待放行的回收槽位');
    expect(messages[1]).toContain('开关关着');
    expect(messages[2]).toContain('正在处理');
    expect(messages[3]).toContain('没有已打开的槽位账本');
  });

  it('成功 / 失败由服务自己上屏：命令不再叠 toast', async () => {
    const messages: string[] = [];
    await runKojo2StorageRetryCommand({
      service: {
        retryWithRecycledAllowed: async () => ({ kind: 'opened' }) as never,
      },
      notify: (notice) => messages.push(notice.message),
    });
    await runKojo2StorageRetryCommand({
      service: {
        retryWithRecycledAllowed: async () => ({ kind: 'recycled' }) as never,
      },
      notify: (notice) => messages.push(notice.message),
    });
    expect(messages).toEqual([]);
  });

  it('服务抛错（病态端口）：命令兜成一句人话，不抛给命令面板', async () => {
    const messages: string[] = [];
    const result = await runKojo2StorageRetryCommand({
      service: {
        retryWithRecycledAllowed: async () => {
          throw new Error('端口炸了');
        },
      },
      notify: (notice) => messages.push(notice.message),
    });
    expect(result).toBeNull();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('端口炸了');
  });
});
