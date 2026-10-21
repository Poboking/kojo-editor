/**
 * K2-STORAGE-PERSIST 的判据闸：槽位账本的两阶段提交、回读校验、换盘 fail-closed、同键幂等。
 *
 * 全部用**假端口**（内存 + 可注入的 read/write/remove 钩子）驱动失败面；
 * 注册表走真 batch-3 实现（真 core 词法/语法/槽位分配），只把「盘」换掉。
 */
import { describe, expect, it } from 'vitest';
import {
  KOJO2_STORAGE_DEFAULT_FINGERPRINT,
  createKojo2StorageRegistry,
  type Kojo2StorageKeyInput,
  type Kojo2StorageRegistry,
  type Kojo2StorageSymbol,
} from '../src/ui/kojo2-storage-registry';
import {
  KOJO2_STORAGE_LEDGER_KEY,
  KOJO2_STORAGE_LEDGER_VERSION,
  KOJO2_STORAGE_PENDING_KEY,
  createKojo2StoragePersister,
  kojo2StorageSlotName,
  parseKojo2StorageLedger,
  serializeKojo2StorageLedger,
  type Kojo2StorageCommitResult,
  type Kojo2StorageCommitSuccess,
  type Kojo2StorageLedger,
  type Kojo2StoragePersister,
  type Kojo2StoragePort,
} from '../src/ui/kojo2-storage-persist';

/* ============================== 假端口 ============================== */

interface PortOp {
  readonly op: 'read' | 'write' | 'remove';
  readonly key: string;
  readonly text: string | null;
}

/**
 * 内存假端口：默认行为 = 普通 Map 语义；三个钩子可精确注入「写一半」「回读被改」
 * 「删不掉」「读不动」这些真实盘上才有的失败，且保留完整操作序（断言两阶段时序）。
 */
class FakePort implements Kojo2StoragePort {
  readonly store = new Map<string, string>();
  readonly ops: PortOp[] = [];
  onRead: ((key: string, port: FakePort) => string | null) | null = null;
  onWrite: ((key: string, text: string, port: FakePort) => void) | null = null;
  onRemove: ((key: string, port: FakePort) => void) | null = null;

  read(key: string): string | null {
    this.ops.push({ op: 'read', key, text: null });
    if (this.onRead !== null) return this.onRead(key, this);
    return this.store.get(key) ?? null;
  }

  write(key: string, text: string): void {
    this.ops.push({ op: 'write', key, text });
    if (this.onWrite !== null) this.onWrite(key, text, this);
    else this.store.set(key, text);
  }

  remove(key: string): void {
    this.ops.push({ op: 'remove', key, text: null });
    if (this.onRemove !== null) this.onRemove(key, this);
    else this.store.delete(key);
  }

  writes(): readonly PortOp[] {
    return this.ops.filter((op) => op.op === 'write');
  }

  writeKeys(): readonly string[] {
    return this.writes().map((op) => op.key);
  }

  resetOps(): void {
    this.ops.length = 0;
  }
}

function textAt(port: FakePort, key: string): string {
  const text = port.store.get(key);
  if (text === undefined) throw new Error(`假端口里没有键「${key}」`);
  return text;
}

function committedOf(result: Kojo2StorageCommitResult): Kojo2StorageCommitSuccess {
  if (result.kind !== 'committed') {
    throw new Error(`期望 committed，实际 ${result.kind}：${JSON.stringify(result)}`);
  }
  return result;
}

/* ============================== 注册表 fixture（真 core） ============================== */

const URI = 'D:/proj/chara/me.kojo2';
const FINGERPRINT = KOJO2_STORAGE_DEFAULT_FINGERPRINT;
const AT = '2026-10-22T00:00:00.000Z';

const VAR_FAVOR = '# 变量 好感 整数 = 0 存档';
const VAR_MOOD = '# 变量 心情 整数 = 0 存档';
const VAR_TRUST = '# 变量 信赖 整数 = 0 存档';
const VAR_NAME = '# 变量 称呼 字符串 存档';
const VAR_ITEMS = '# 变量 物品 整数[3] 存档';

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

function snapshotOf(registry: Kojo2StorageRegistry): SlotSnapshot {
  const snapshot = registry.storagePlan.nextSnapshot;
  if (snapshot === null) throw new Error('fixture 槽位规划失败');
  return snapshot;
}

function symbolOf(registry: Kojo2StorageRegistry, name: string): Kojo2StorageSymbol {
  const symbol = registry.findDeclaration(name).symbol;
  if (symbol === null) throw new Error(`fixture 里没有声明「${name}」`);
  return symbol;
}

function storageKeyOf(registry: Kojo2StorageRegistry, name: string): string {
  const variable = symbolOf(registry, name).variable;
  if (variable === undefined) throw new Error(`「${name}」不是存储期变量`);
  return variable.storageKey;
}

function slotOf(registry: Kojo2StorageRegistry, name: string): number {
  const variable = symbolOf(registry, name).variable;
  if (variable === undefined || variable.slot === null) {
    throw new Error(`「${name}」没有已分配槽位`);
  }
  return variable.slot;
}

function persisterOf(port: FakePort, now: () => string = () => AT): Kojo2StoragePersister {
  return createKojo2StoragePersister({ port, now });
}

function commitOf(
  persister: Kojo2StoragePersister,
  registry: Kojo2StorageRegistry,
  fingerprint: string = FINGERPRINT,
): Kojo2StorageCommitResult {
  return persister.commit({ registry, fingerprint });
}

function ledgerAt(port: FakePort): Kojo2StorageLedger {
  const parsed = parseKojo2StorageLedger(textAt(port, KOJO2_STORAGE_LEDGER_KEY));
  if (parsed.kind !== 'ok') throw new Error(`假端口里的账本不可解析：${parsed.kind}`);
  return parsed.ledger;
}

interface PendingView {
  readonly version: number;
  readonly kind: string;
  readonly ledgerKey: string;
  readonly next: Kojo2StorageLedger;
  readonly previous: Kojo2StorageLedger | null;
}

/** 取最后一次写 pending 的原文（pending 删除后 op 日志仍在）。 */
function pendingViewOf(port: FakePort): PendingView {
  const writes = port.ops.filter(
    (op) => op.op === 'write' && op.key === KOJO2_STORAGE_PENDING_KEY,
  );
  const last = writes.at(-1);
  if (last === undefined || last.text === null) throw new Error('没有 pending 写入');
  return JSON.parse(last.text) as PendingView;
}

/* ============================== 1. 正常落账与两阶段时序 ============================== */

describe('kojo2 槽位账本 · 两阶段提交', () => {
  it('首次 commit：读 → 写 pending → 回读 → 写正式 → 回读 → 删 pending，账本字段逐项正确', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const registry = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));

    const result = committedOf(commitOf(persister, registry));

    expect(result.changed).toBe(true);
    expect(result.previous).toBeNull();
    expect(result.ledger.version).toBe(KOJO2_STORAGE_LEDGER_VERSION);
    expect(result.ledger.fingerprint).toBe(FINGERPRINT);
    expect(result.ledger.updatedAt).toBe(AT);

    const favorKey = storageKeyOf(registry, '好感');
    const moodKey = storageKeyOf(registry, '心情');
    expect(slotOf(registry, '好感')).toBe(0);
    expect(slotOf(registry, '心情')).toBe(1);
    expect(result.ledger.slots).toEqual({
      [favorKey]: 'save#0',
      [moodKey]: 'save#1',
    });
    expect(Object.keys(result.ledger.slots)).toEqual([favorKey, moodKey]);

    // 完整时序：正式键只在 pending 回读通过之后才写；pending 最后被删掉
    expect(port.ops.map((op) => `${op.op}:${op.key}`)).toEqual([
      `read:${KOJO2_STORAGE_LEDGER_KEY}`,
      `write:${KOJO2_STORAGE_PENDING_KEY}`,
      `read:${KOJO2_STORAGE_PENDING_KEY}`,
      `write:${KOJO2_STORAGE_LEDGER_KEY}`,
      `read:${KOJO2_STORAGE_LEDGER_KEY}`,
      `remove:${KOJO2_STORAGE_PENDING_KEY}`,
    ]);
    expect(port.store.has(KOJO2_STORAGE_PENDING_KEY)).toBe(false);
    expect(ledgerAt(port)).toEqual(result.ledger);

    const pending = pendingViewOf(port);
    expect(pending.version).toBe(1);
    expect(pending.kind).toBe('kojo2-storage-pending');
    expect(pending.ledgerKey).toBe(KOJO2_STORAGE_LEDGER_KEY);
    expect(pending.next).toEqual(result.ledger);
    expect(pending.previous).toBeNull();
  });

  it('新增声明：旧槽原样保留、新声明拿最小空位、pending 文档带旧账本引用', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const first = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    const firstResult = committedOf(commitOf(persister, first));

    const second = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD, VAR_TRUST), {
      previous: snapshotOf(first),
    });
    const secondResult = committedOf(commitOf(persister, second));

    expect(secondResult.changed).toBe(true);
    expect(secondResult.previous).toEqual(firstResult.ledger);
    expect(slotOf(second, '好感')).toBe(0); // 保留
    expect(slotOf(second, '心情')).toBe(1); // 保留
    expect(slotOf(second, '信赖')).toBe(2); // 新增取最小空位
    expect(secondResult.ledger.slots[storageKeyOf(second, '信赖')]).toBe('save#2');

    const pending = pendingViewOf(port);
    expect(pending.previous).toEqual(firstResult.ledger);
    expect(pending.next).toEqual(secondResult.ledger);
  });

  it('空注册表：也能建账（只登记指纹），随后同一份空注册表再提交是零写幂等', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const registry = createKojo2StorageRegistry({ gameFingerprint: FINGERPRINT });

    const first = committedOf(commitOf(persister, registry));
    expect(first.changed).toBe(true);
    expect(first.ledger.slots).toEqual({});
    expect(first.ledger.fingerprint).toBe(FINGERPRINT);

    port.resetOps();
    const second = committedOf(commitOf(persister, registry));
    expect(second.changed).toBe(false);
    expect(second.ledger).toEqual(first.ledger);
    expect(port.writes()).toEqual([]);
  });

  it('readLedger：缺失 → absent；提交后 → ok 且与落盘一致；不产生任何写', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const registry = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));

    expect(persister.readLedger()).toEqual({ kind: 'absent' });

    const result = committedOf(commitOf(persister, registry));
    port.resetOps();
    const read = persister.readLedger();
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.ledger).toEqual(result.ledger);
    expect(port.writes()).toEqual([]);
    expect(port.ops.filter((op) => op.op !== 'read')).toEqual([]);
  });
});

/* ============================== 2. 幂等与声明键策略 ============================== */

describe('kojo2 槽位账本 · 幂等与键策略', () => {
  it('同键幂等：连续两次 commit 结果一致、零写、updatedAt 不刷新', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const registry = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    const first = committedOf(commitOf(persister, registry));

    port.resetOps();
    const second = committedOf(commitOf(persister, registry));

    expect(second.changed).toBe(false);
    expect(second.ledger).toEqual(first.ledger);
    expect(second.ledger.updatedAt).toBe(AT);
    expect(second.previous).toEqual(first.ledger);
    expect(port.writes()).toEqual([]);
    expect(port.ops.filter((op) => op.op === 'remove')).toEqual([]);
  });

  it('跨构建重建注册表（同源码、无 previousSnapshot）：键与槽一致，提交仍是零写幂等', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const first = committedOf(commitOf(persister, registryOf(sourceOf(VAR_FAVOR, VAR_MOOD))));

    const rebuilt = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    port.resetOps();
    const second = committedOf(commitOf(persister, rebuilt));

    expect(second.changed).toBe(false);
    expect(second.ledger).toEqual(first.ledger);
    expect(port.writes()).toEqual([]);
  });

  it('改名不搬槽（缺省键不含名字）：声明键与槽号都不动，账本零写', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const before = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    committedOf(commitOf(persister, before));
    const favorKeyBefore = storageKeyOf(before, '好感');

    const renamed = registryOf(sourceOf('# 变量 爱情 整数 = 0 存档', VAR_MOOD), {
      previous: snapshotOf(before),
    });
    const after = committedOf(commitOf(persister, renamed));

    expect(storageKeyOf(renamed, '爱情')).toBe(favorKeyBefore);
    expect(slotOf(renamed, '爱情')).toBe(slotOf(before, '好感'));
    expect(slotOf(renamed, '爱情')).toBe(0);
    expect(after.changed).toBe(false);
    expect(after.ledger.slots[favorKeyBefore]).toBe('save#0');
  });

  it('搬行搬槽（缺省键按位置）：交换两行后两个声明的槽号互换，账本表按键不变', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const before = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    const first = committedOf(commitOf(persister, before));
    expect(slotOf(before, '好感')).toBe(0);
    expect(slotOf(before, '心情')).toBe(1);

    const moved = registryOf(sourceOf(VAR_MOOD, VAR_FAVOR), { previous: snapshotOf(before) });
    const second = committedOf(commitOf(persister, moved));

    // 声明跟着位置走：心情占了原第 1 行的槽 0，好感退到槽 1
    expect(slotOf(moved, '心情')).toBe(0);
    expect(slotOf(moved, '好感')).toBe(1);
    // 缺省键是位置键：账本「键→槽名」这张表本身没变，所以同键幂等零写
    expect(second.changed).toBe(false);
    expect(second.ledger.slots).toEqual(first.ledger.slots);
  });

  it('插入声明导致后续声明搬槽：账本新增键、旧声明槽号后移（changed=true）', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const before = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    committedOf(commitOf(persister, before));
    expect(slotOf(before, '好感')).toBe(0);

    const after = registryOf(sourceOf(VAR_TRUST, VAR_FAVOR, VAR_MOOD), {
      previous: snapshotOf(before),
    });
    const result = committedOf(commitOf(persister, after));

    expect(result.changed).toBe(true);
    expect(slotOf(after, '信赖')).toBe(0);
    expect(slotOf(after, '好感')).toBe(1); // 后移一格
    expect(slotOf(after, '心情')).toBe(2);
    expect(result.ledger.slots[storageKeyOf(after, '信赖')]).toBe('save#0');
    expect(result.ledger.slots[storageKeyOf(after, '好感')]).toBe('save#1');
    expect(result.ledger.slots[storageKeyOf(after, '心情')]).toBe('save#2');
  });

  it('注入稳定键策略（uri#名字）：搬行不搬槽——键不变、槽位原样保留', () => {
    const port = new FakePort();
    const policy = (input: Kojo2StorageKeyInput): string => `${input.uri}#${input.name}`;
    const persister = createKojo2StoragePersister({
      port,
      now: () => AT,
      declarationKey: (symbol: Kojo2StorageSymbol): string => `${symbol.uri}#${symbol.name}`,
    });
    const before = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD), { declarationKey: policy });
    const first = committedOf(commitOf(persister, before));
    expect(slotOf(before, '好感')).toBe(0);

    const moved = registryOf(sourceOf(VAR_MOOD, VAR_FAVOR), {
      declarationKey: policy,
      previous: snapshotOf(before),
    });
    const second = committedOf(commitOf(persister, moved));

    expect(slotOf(moved, '好感')).toBe(0); // 键稳定 → 搬行不搬槽
    expect(slotOf(moved, '心情')).toBe(1);
    expect(second.changed).toBe(false);
    expect(second.ledger).toEqual(first.ledger);
    expect(second.ledger.slots[`${URI}#好感`]).toBe('save#0');
  });

  it('注入的声明键与注册表口径不一致 → key-policy-mismatch，一个字节都不写', () => {
    const port = new FakePort();
    const persister = createKojo2StoragePersister({
      port,
      now: () => AT,
      declarationKey: (symbol: Kojo2StorageSymbol): string => `${symbol.uri}#${symbol.name}`,
    });
    const registry = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD)); // 注册表用缺省位置键

    const result = commitOf(persister, registry);

    expect(result.kind).toBe('key-policy-mismatch');
    if (result.kind !== 'key-policy-mismatch') return;
    expect(result.expected).toBe(storageKeyOf(registry, '好感'));
    expect(result.actual).toBe(`${URI}#好感`);
    expect(result.uri).toBe(URI);
    expect(result.name).toBe('好感');
    expect(port.writes()).toEqual([]);
    expect(port.store.size).toBe(0);
  });

  it('旧声明换槽（注册表没按旧快照装配）→ slot-moved 硬失败；显式 allowSlotMoves 才写', () => {
    const port = new FakePort();
    const policy = (input: Kojo2StorageKeyInput): string => `${input.uri}#${input.name}`;
    const keyOf = (symbol: Kojo2StorageSymbol): string => `${symbol.uri}#${symbol.name}`;
    const persister = createKojo2StoragePersister({ port, now: () => AT, declarationKey: keyOf });
    const before = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD), { declarationKey: policy });
    committedOf(commitOf(persister, before));
    expect(slotOf(before, '好感')).toBe(0);
    port.resetOps();

    // 不传 previousSnapshot：新声明「一」排在最前，原「好感」被挤到槽 1
    const shuffled = registryOf(sourceOf('# 变量 一 整数 = 0 存档', VAR_FAVOR, VAR_MOOD), {
      declarationKey: policy,
    });
    expect(slotOf(shuffled, '好感')).toBe(1);

    const blocked = commitOf(persister, shuffled);
    expect(blocked.kind).toBe('slot-moved');
    if (blocked.kind !== 'slot-moved') return;
    expect(blocked.key).toBe(`${URI}#好感`);
    expect(blocked.previous).toBe('save#0');
    expect(blocked.current).toBe('save#1');
    expect(port.writes()).toEqual([]);

    // 作者确认重排：显式打开 allowSlotMoves 才允许把搬槽写成事实
    const forced = createKojo2StoragePersister({
      port,
      now: () => AT,
      declarationKey: keyOf,
      allowSlotMoves: true,
    });
    const committed = committedOf(commitOf(forced, shuffled));
    expect(committed.changed).toBe(true);
    expect(committed.ledger.slots[`${URI}#好感`]).toBe('save#1');
  });

  it('注入槽名函数：账本值按注入口径落（缺省是 存储期#槽号）', () => {
    const port = new FakePort();
    const persister = createKojo2StoragePersister({
      port,
      now: () => AT,
      slotNameOf: ({ storage, slot }) => `${storage}/${slot}`,
    });
    const registry = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));

    const result = committedOf(commitOf(persister, registry));
    expect(result.ledger.slots[storageKeyOf(registry, '好感')]).toBe('save/0');
    expect(result.ledger.slots[storageKeyOf(registry, '心情')]).toBe('save/1');
    expect(kojo2StorageSlotName('save', 7)).toBe('save#7');
  });

  it('注入指纹比较函数：大小写差异视为同盘（显式策略），默认严格比较则判换盘', () => {
    const port = new FakePort();
    const seed = createKojo2StoragePersister({ port, now: () => AT });
    committedOf(commitOf(seed, registryOf(sourceOf(VAR_FAVOR), { fingerprint: 'disk-A' }), 'disk-A'));

    const relaxed = createKojo2StoragePersister({
      port,
      now: () => AT,
      fingerprintEquals: (a, b) => a.toLowerCase() === b.toLowerCase(),
    });
    const sameDisk = committedOf(
      commitOf(relaxed, registryOf(sourceOf(VAR_FAVOR), { fingerprint: 'disk-a' }), 'disk-a'),
    );
    expect(sameDisk.changed).toBe(false);
    expect(sameDisk.ledger.fingerprint).toBe('disk-A'); // 同盘不改写既有指纹

    port.resetOps();
    const strict = persisterOf(port);
    const swapped = commitOf(
      strict,
      registryOf(sourceOf(VAR_FAVOR), { fingerprint: 'disk-a' }),
      'disk-a',
    );
    expect(swapped.kind).toBe('disk-swapped');
    expect(port.writes()).toEqual([]);
  });
});

/* ============================== 3. 换盘 / 坏账 / 脏注册表 ============================== */

describe('kojo2 槽位账本 · 换盘与坏数据防御', () => {
  it('换盘：指纹变化 → disk-swapped（带 previous/current），fail-closed 零写', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const first = committedOf(
      commitOf(persister, registryOf(sourceOf(VAR_FAVOR), { fingerprint: 'disk-A' }), 'disk-A'),
    );
    const rawBefore = textAt(port, KOJO2_STORAGE_LEDGER_KEY);

    port.resetOps();
    const swapped = commitOf(
      persister,
      registryOf(sourceOf(VAR_FAVOR), { fingerprint: 'disk-B' }),
      'disk-B',
    );

    expect(swapped.kind).toBe('disk-swapped');
    if (swapped.kind !== 'disk-swapped') return;
    expect(swapped.previous).toBe('disk-A');
    expect(swapped.current).toBe('disk-B');
    expect(port.writes()).toEqual([]);
    expect(textAt(port, KOJO2_STORAGE_LEDGER_KEY)).toBe(rawBefore);
    expect(ledgerAt(port)).toEqual(first.ledger);
  });

  it('坏 JSON：corrupt-ledger(json)，不覆盖、不写 pending', () => {
    const port = new FakePort();
    port.store.set(KOJO2_STORAGE_LEDGER_KEY, '{"version":1,"fingerprint":');
    const persister = persisterOf(port);
    const registry = registryOf(sourceOf(VAR_FAVOR));

    port.resetOps();
    const result = commitOf(persister, registry);

    expect(result.kind).toBe('corrupt-ledger');
    if (result.kind !== 'corrupt-ledger') return;
    expect(result.reason).toBe('json');
    expect(port.writes()).toEqual([]);
    expect(port.store.has(KOJO2_STORAGE_PENDING_KEY)).toBe(false);
  });

  it('坏形状（slots 非对象 / 槽名非字符串 / 空键 / __proto__ / 空指纹）：一律 corrupt-ledger(shape)', () => {
    const cases: readonly string[] = [
      '{"version":1,"fingerprint":"f","slots":[],"updatedAt":"t"}',
      '{"version":1,"fingerprint":"f","slots":{"a":3},"updatedAt":"t"}',
      '{"version":1,"fingerprint":"f","slots":{"":"save#0"},"updatedAt":"t"}',
      '{"version":1,"fingerprint":"f","slots":{"__proto__":"save#0"},"updatedAt":"t"}',
      '{"version":1,"fingerprint":"","slots":{},"updatedAt":"t"}',
    ];
    for (const raw of cases) {
      const port = new FakePort();
      port.store.set(KOJO2_STORAGE_LEDGER_KEY, raw);
      const result = commitOf(persisterOf(port), registryOf(sourceOf(VAR_FAVOR)));
      expect(result.kind, raw).toBe('corrupt-ledger');
      if (result.kind !== 'corrupt-ledger') continue;
      expect(result.reason, raw).toBe('shape');
      expect(port.writes(), raw).toEqual([]);
    }
  });

  it('账本版本不符：version-unsupported，拒绝在未知格式上继续写', () => {
    const port = new FakePort();
    port.store.set(
      KOJO2_STORAGE_LEDGER_KEY,
      '{"version":2,"fingerprint":"f","slots":{},"updatedAt":"t"}',
    );
    const result = commitOf(persisterOf(port), registryOf(sourceOf(VAR_FAVOR)));

    expect(result.kind).toBe('version-unsupported');
    if (result.kind !== 'version-unsupported') return;
    expect(result.version).toBe(2);
    expect(result.expected).toBe(KOJO2_STORAGE_LEDGER_VERSION);
    expect(port.writes()).toEqual([]);
  });

  it('槽位规划失败（旧快照换了盘）→ plan-not-ok，带 core 失败码，零写', () => {
    const old = registryOf(sourceOf(VAR_FAVOR), { fingerprint: 'disk-A' });
    const stale = registryOf(sourceOf(VAR_FAVOR), {
      fingerprint: 'disk-B',
      previous: snapshotOf(old),
    });
    const port = new FakePort();

    const result = commitOf(persisterOf(port), stale, 'disk-B');

    expect(result.kind).toBe('plan-not-ok');
    if (result.kind !== 'plan-not-ok') return;
    expect(result.failures.map((failure) => failure.code)).toContain(
      'core/storage/fingerprint-mismatch',
    );
    expect(result.failures.length).toBeGreaterThan(0);
    expect(port.writes()).toEqual([]);
  });

  it('注册表按另一个指纹装配 → fingerprint-mismatch（拒绝把脏分配落账）', () => {
    const port = new FakePort();
    const registry = registryOf(sourceOf(VAR_FAVOR), { fingerprint: 'disk-A' });

    const result = commitOf(persisterOf(port), registry, 'disk-B');

    expect(result.kind).toBe('fingerprint-mismatch');
    if (result.kind !== 'fingerprint-mismatch') return;
    expect(result.registryFingerprint).toBe('disk-A');
    expect(result.current).toBe('disk-B');
    expect(port.writes()).toEqual([]);
  });
});

/* ============================== 4. 两阶段失败与回滚 ============================== */

describe('kojo2 槽位账本 · 失败回滚', () => {
  it('pending 写入失败：正式键保持旧账本、pending 不残留', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const before = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    committedOf(commitOf(persister, before));
    const rawBefore = textAt(port, KOJO2_STORAGE_LEDGER_KEY);

    port.onWrite = (key, text, fake) => {
      if (key === KOJO2_STORAGE_PENDING_KEY) throw new Error('磁盘满');
      fake.store.set(key, text);
    };
    port.resetOps();
    const after = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD, VAR_TRUST), {
      previous: snapshotOf(before),
    });
    const result = commitOf(persister, after);

    expect(result.kind).toBe('commit-failed');
    if (result.kind !== 'commit-failed') return;
    expect(result.phase).toBe('pending-write');
    expect(result.rollback.ledger).toBe('skipped');
    expect(result.rollback.pendingRemoved).toBe(true);
    expect(textAt(port, KOJO2_STORAGE_LEDGER_KEY)).toBe(rawBefore);
    expect(port.store.has(KOJO2_STORAGE_PENDING_KEY)).toBe(false);
  });

  it('pending 回读不一致：拒绝写正式键，回滚后旧账本完好、pending 清除', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const before = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    committedOf(commitOf(persister, before));
    const rawBefore = textAt(port, KOJO2_STORAGE_LEDGER_KEY);

    port.onWrite = (key, text, fake) => {
      if (key === KOJO2_STORAGE_PENDING_KEY) {
        fake.store.set(key, '{"tampered":true}');
        return;
      }
      fake.store.set(key, text);
    };
    port.resetOps();
    const after = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD, VAR_TRUST), {
      previous: snapshotOf(before),
    });
    const result = commitOf(persister, after);

    expect(result.kind).toBe('commit-failed');
    if (result.kind !== 'commit-failed') return;
    expect(result.phase).toBe('pending-verify');
    expect(result.rollback.ledger).toBe('skipped');
    expect(result.rollback.pendingRemoved).toBe(true);
    expect(textAt(port, KOJO2_STORAGE_LEDGER_KEY)).toBe(rawBefore);
    expect(port.writes().map((op) => op.key)).not.toContain(KOJO2_STORAGE_LEDGER_KEY);
  });

  it('正式写失败：回滚到旧账本、pending 清除', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const before = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    committedOf(commitOf(persister, before));
    const rawBefore = textAt(port, KOJO2_STORAGE_LEDGER_KEY);

    port.onWrite = (key, text, fake) => {
      if (key === KOJO2_STORAGE_LEDGER_KEY) throw new Error('正式键写失败');
      fake.store.set(key, text);
    };
    port.resetOps();
    const after = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD, VAR_TRUST), {
      previous: snapshotOf(before),
    });
    const result = commitOf(persister, after);

    expect(result.kind).toBe('commit-failed');
    if (result.kind !== 'commit-failed') return;
    expect(result.phase).toBe('ledger-write');
    expect(result.rollback.ledger).toBe('skipped');
    expect(result.rollback.pendingRemoved).toBe(true);
    expect(textAt(port, KOJO2_STORAGE_LEDGER_KEY)).toBe(rawBefore);
    expect(port.store.has(KOJO2_STORAGE_PENDING_KEY)).toBe(false);
  });

  it('正式写后回读不一致：恢复旧账本（restored + 回读验证）', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const before = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    committedOf(commitOf(persister, before));
    const rawBefore = textAt(port, KOJO2_STORAGE_LEDGER_KEY);

    let formalWrites = 0;
    port.onWrite = (key, text, fake) => {
      if (key === KOJO2_STORAGE_LEDGER_KEY) {
        formalWrites += 1;
        if (formalWrites === 1) {
          fake.store.set(key, '{"mangled":true}');
          return;
        }
      }
      fake.store.set(key, text);
    };
    port.resetOps();
    const after = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD, VAR_TRUST), {
      previous: snapshotOf(before),
    });
    const result = commitOf(persister, after);

    expect(result.kind).toBe('commit-failed');
    if (result.kind !== 'commit-failed') return;
    expect(result.phase).toBe('ledger-verify');
    expect(result.rollback.ledger).toBe('restored');
    expect(result.rollback.detail).toBeNull();
    expect(textAt(port, KOJO2_STORAGE_LEDGER_KEY)).toBe(rawBefore);
    expect(port.store.has(KOJO2_STORAGE_PENDING_KEY)).toBe(false);
  });

  it('删 pending 失败：正式键回滚到旧账本，残留 pending 如实上报（pendingRemoved=false）', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const before = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    const first = committedOf(commitOf(persister, before));
    const rawBefore = textAt(port, KOJO2_STORAGE_LEDGER_KEY);

    port.onRemove = (key, fake) => {
      if (key === KOJO2_STORAGE_PENDING_KEY) throw new Error('删不掉暂存键');
      fake.store.delete(key);
    };
    port.resetOps();
    const after = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD, VAR_TRUST), {
      previous: snapshotOf(before),
    });
    const result = commitOf(persister, after);

    expect(result.kind).toBe('commit-failed');
    if (result.kind !== 'commit-failed') return;
    expect(result.phase).toBe('pending-cleanup');
    expect(result.rollback.ledger).toBe('restored');
    expect(result.rollback.pendingRemoved).toBe(false);
    expect(textAt(port, KOJO2_STORAGE_LEDGER_KEY)).toBe(rawBefore);
    expect(ledgerAt(port)).toEqual(first.ledger);
    expect(port.store.has(KOJO2_STORAGE_PENDING_KEY)).toBe(true);
  });

  it('回滚也失败：如实报 failed（不把半批说成成功），盘上状态可解释', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const before = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    committedOf(commitOf(persister, before));

    let formalWrites = 0;
    port.onWrite = (key, text, fake) => {
      if (key === KOJO2_STORAGE_LEDGER_KEY) {
        formalWrites += 1;
        if (formalWrites === 1) {
          fake.store.set(key, '{"mangled":true}');
          return;
        }
        throw new Error('回滚也写不动');
      }
      fake.store.set(key, text);
    };
    port.resetOps();
    const after = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD, VAR_TRUST), {
      previous: snapshotOf(before),
    });
    const result = commitOf(persister, after);

    expect(result.kind).toBe('commit-failed');
    if (result.kind !== 'commit-failed') return;
    expect(result.phase).toBe('ledger-verify');
    expect(result.rollback.ledger).toBe('failed');
    expect(result.rollback.detail).toContain('恢复旧账本失败');
    expect(textAt(port, KOJO2_STORAGE_LEDGER_KEY)).toBe('{"mangled":true}');
  });

  it('崩溃残留的 pending 不毒化下一次提交：以正式键为准，残留被覆盖后清掉', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const before = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    const first = committedOf(commitOf(persister, before));

    // 伪造一次「pending 写完、正式键没写」的崩溃残留（next 是另一份凭空账本）
    port.store.set(
      KOJO2_STORAGE_PENDING_KEY,
      JSON.stringify({
        version: 1,
        kind: 'kojo2-storage-pending',
        ledgerKey: KOJO2_STORAGE_LEDGER_KEY,
        next: {
          version: 1,
          fingerprint: 'ghost',
          slots: { ghost: 'save#9' },
          updatedAt: 'ghost',
        },
        previous: null,
      }),
    );

    const after = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD, VAR_TRUST), {
      previous: snapshotOf(before),
    });
    port.resetOps();
    const result = committedOf(commitOf(persister, after));

    expect(result.changed).toBe(true);
    expect(result.previous).toEqual(first.ledger);
    expect(ledgerAt(port)).toEqual(result.ledger);
    expect(result.ledger.slots).not.toHaveProperty('ghost');
    expect(port.store.has(KOJO2_STORAGE_PENDING_KEY)).toBe(false);
  });

  it('读正式账本时端口抛错：port-error（读不动 ≠ 首启），零写', () => {
    const port = new FakePort();
    port.onRead = (key) => {
      if (key === KOJO2_STORAGE_LEDGER_KEY) throw new Error('io 读取失败');
      return null;
    };

    const result = commitOf(persisterOf(port), registryOf(sourceOf(VAR_FAVOR)));

    expect(result.kind).toBe('port-error');
    if (result.kind !== 'port-error') return;
    expect(result.detail).toContain('读不动');
    expect(port.writes()).toEqual([]);
  });
});

/* ============================== 5. 串行化 / 配置 / 冻结 ============================== */

describe('kojo2 槽位账本 · 串行化与边界', () => {
  it('并发/重入 commit：同一实例内重入 → busy，外层照常完成且没有交错写', () => {
    const port = new FakePort();
    const registry = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    const inner: Kojo2StorageCommitResult[] = [];
    let persister: Kojo2StoragePersister | null = null;

    port.onWrite = (key, text, fake) => {
      fake.store.set(key, text);
      if (key === KOJO2_STORAGE_PENDING_KEY && persister !== null) {
        inner.push(persister.commit({ registry, fingerprint: FINGERPRINT }));
      }
    };
    persister = createKojo2StoragePersister({ port, now: () => AT });

    const outer = committedOf(persister.commit({ registry, fingerprint: FINGERPRINT }));

    expect(inner).toHaveLength(1);
    expect(inner[0]?.kind).toBe('busy');
    expect(outer.changed).toBe(true);
    // 只有外层的两次写，内层一个字节都没写
    expect(port.writeKeys()).toEqual([KOJO2_STORAGE_PENDING_KEY, KOJO2_STORAGE_LEDGER_KEY]);
    expect(ledgerAt(port)).toEqual(outer.ledger);
  });

  it('配置错误在创建时抛 TypeError（端口缺方法 / 空键 / 正式键与暂存键相同）', () => {
    const port = new FakePort();
    expect(() => createKojo2StoragePersister({ port: {} as Kojo2StoragePort })).toThrow(TypeError);
    expect(
      () =>
        createKojo2StoragePersister({
          port: { read: () => null, write: () => undefined } as unknown as Kojo2StoragePort,
        }),
    ).toThrow(TypeError);
    expect(() => createKojo2StoragePersister({ port, ledgerKey: '' })).toThrow(TypeError);
    expect(() =>
      createKojo2StoragePersister({ port, ledgerKey: 'same', pendingKey: 'same' }),
    ).toThrow(TypeError);
  });

  it('commit 参数非法（空指纹 / registry 非对象 / 时钟返回空串）→ invalid-input，零写', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const registry = registryOf(sourceOf(VAR_FAVOR));

    expect(persister.commit({ registry, fingerprint: '' }).kind).toBe('invalid-input');
    expect(
      persister.commit({
        registry: null as unknown as Kojo2StorageRegistry,
        fingerprint: FINGERPRINT,
      }).kind,
    ).toBe('invalid-input');

    const badClock = createKojo2StoragePersister({ port, now: () => '' });
    port.resetOps();
    const result = badClock.commit({ registry, fingerprint: FINGERPRINT });
    expect(result.kind).toBe('invalid-input');
    expect(port.writes()).toEqual([]);
  });

  it('readLedger 对坏账 / 未知版本也给出可判别结果（带原文，不抛）', () => {
    const corrupt = new FakePort();
    corrupt.store.set(KOJO2_STORAGE_LEDGER_KEY, '{oops');
    expect(persisterOf(corrupt).readLedger().kind).toBe('corrupt');

    const future = new FakePort();
    future.store.set(
      KOJO2_STORAGE_LEDGER_KEY,
      '{"version":9,"fingerprint":"f","slots":{},"updatedAt":"t"}',
    );
    const read = persisterOf(future).readLedger();
    expect(read.kind).toBe('version-unsupported');
    if (read.kind !== 'version-unsupported') return;
    expect(read.version).toBe(9);
    expect(read.raw).toContain('"version":9');
  });

  it('返回结构运行时冻结：账本、slots、records 都改不动', () => {
    const result = committedOf(
      commitOf(persisterOf(new FakePort()), registryOf(sourceOf(VAR_FAVOR))),
    );

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.ledger)).toBe(true);
    expect(Object.isFrozen(result.ledger.slots)).toBe(true);
    expect(Object.isFrozen(result.ledger.records)).toBe(true);
    expect(() => {
      (result.ledger as { fingerprint: string }).fingerprint = '改不动';
    }).toThrow(TypeError);
  });

  it('解析 / 序列化：slots 键排序固定，往返逐字节稳定', () => {
    const raw =
      '{"version":1,"fingerprint":"f","slots":{"b":"save#1","a":"save#0"},' +
      '"updatedAt":"2026-01-01T00:00:00.000Z"}';
    const parsed = parseKojo2StorageLedger(raw);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(Object.keys(parsed.ledger.slots)).toEqual(['a', 'b']);
    expect(serializeKojo2StorageLedger(parsed.ledger)).toBe(
      '{"version":1,"fingerprint":"f","slots":{"a":"save#0","b":"save#1"},' +
        '"updatedAt":"2026-01-01T00:00:00.000Z"}',
    );
  });
});

/* ============================== 6. records（形状事实）：扩账本 / 旧账兼容 ============================== */

describe('kojo2 槽位账本 · records 形状事实', () => {
  it('首次 commit：records 与 slots 同键集，int / string / 数组形状逐格正确且冻结', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const registry = registryOf(sourceOf(VAR_FAVOR, VAR_NAME, VAR_ITEMS));
    const result = committedOf(commitOf(persister, registry));

    const favorKey = storageKeyOf(registry, '好感');
    const nameKey = storageKeyOf(registry, '称呼');
    const itemsKey = storageKeyOf(registry, '物品');
    expect(result.ledger.records).toEqual({
      [favorKey]: { slot: slotOf(registry, '好感'), valueType: 'int', arraySize: null },
      [nameKey]: { slot: slotOf(registry, '称呼'), valueType: 'string', arraySize: null },
      [itemsKey]: { slot: slotOf(registry, '物品'), valueType: 'int', arraySize: 3 },
    });
    expect(Object.keys(result.ledger.records).sort()).toEqual(
      Object.keys(result.ledger.slots).sort(),
    );
    // 槽名与形状必须指同一格
    for (const key of Object.keys(result.ledger.records)) {
      expect(result.ledger.slots[key]).toBe(`save#${String(result.ledger.records[key]?.slot)}`);
    }
    expect(Object.isFrozen(result.ledger.records)).toBe(true);
    expect(Object.isFrozen(result.ledger.records[favorKey])).toBe(true);
    expect(ledgerAt(port)).toEqual(result.ledger);
  });

  it('pending 文档的 next / previous 都带 records（崩溃后可取证形状）', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const before = registryOf(sourceOf(VAR_FAVOR));
    const first = committedOf(commitOf(persister, before));
    const after = registryOf(sourceOf(VAR_FAVOR, VAR_NAME, VAR_ITEMS), {
      previous: snapshotOf(before),
    });
    const second = committedOf(commitOf(persister, after));

    const pending = pendingViewOf(port);
    expect(pending.next.records).toEqual(second.ledger.records);
    expect(pending.previous?.records).toEqual(first.ledger.records);
    expect(Object.keys(pending.next.records)).toHaveLength(3);
  });

  it('旧账本没有 records：解析为 {} 且不视为损坏；下一次提交自动回填（changed=true）', () => {
    const port = new FakePort();
    const persister = persisterOf(port);
    const registry = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    const first = committedOf(commitOf(persister, registry));

    // 抹掉 records，模拟 batch-4 的旧账本（旧账本连这个字段都不存在）
    const legacy = { ...first.ledger } as Record<string, unknown>;
    delete legacy.records;
    port.store.set(KOJO2_STORAGE_LEDGER_KEY, JSON.stringify(legacy));

    const read = persister.readLedger();
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.ledger.records).toEqual({});
    expect(read.ledger.slots).toEqual(first.ledger.slots);

    port.resetOps();
    const refilled = committedOf(commitOf(persister, registry));
    expect(refilled.changed).toBe(true);
    expect(refilled.ledger.slots).toEqual(first.ledger.slots);
    expect(Object.keys(refilled.ledger.records).sort()).toEqual(
      Object.keys(refilled.ledger.slots).sort(),
    );
    expect(port.writeKeys()).toEqual([KOJO2_STORAGE_PENDING_KEY, KOJO2_STORAGE_LEDGER_KEY]);
    expect(JSON.parse(textAt(port, KOJO2_STORAGE_LEDGER_KEY))).toHaveProperty('records');
  });

  it('坏 records 形状一律 corrupt-ledger(shape)，零写', () => {
    const validRecord = { slot: 0, valueType: 'int', arraySize: null };
    const protoRecord = Object.fromEntries([['__proto__', validRecord]]);
    const cases: readonly Record<string, unknown>[] = [
      { version: 1, fingerprint: 'f', slots: { k: 'save#0' }, records: [], updatedAt: 't' },
      { version: 1, fingerprint: 'f', slots: { k: 'save#0' }, records: { k: 3 }, updatedAt: 't' },
      {
        version: 1,
        fingerprint: 'f',
        slots: { k: 'save#0' },
        records: { k: { slot: 0, valueType: 'float', arraySize: null } },
        updatedAt: 't',
      },
      {
        version: 1,
        fingerprint: 'f',
        slots: { k: 'save#0' },
        records: { k: { slot: -2, valueType: 'int', arraySize: null } },
        updatedAt: 't',
      },
      {
        version: 1,
        fingerprint: 'f',
        slots: { k: 'save#0' },
        records: { k: { slot: 0.5, valueType: 'int', arraySize: null } },
        updatedAt: 't',
      },
      {
        version: 1,
        fingerprint: 'f',
        slots: { k: 'save#0' },
        records: { k: { slot: 0, valueType: 'int', arraySize: '3' } },
        updatedAt: 't',
      },
      {
        version: 1,
        fingerprint: 'f',
        slots: { k: 'save#0' },
        records: { k: { slot: 0, valueType: 'int' } },
        updatedAt: 't',
      },
      { version: 1, fingerprint: 'f', slots: {}, records: { ghost: validRecord }, updatedAt: 't' },
      {
        version: 1,
        fingerprint: 'f',
        slots: { k: 'save#0' },
        records: protoRecord,
        updatedAt: 't',
      },
      { version: 1, fingerprint: 'f', slots: { k: 'save#0' }, records: { '': validRecord }, updatedAt: 't' },
    ];
    for (const raw of cases) {
      const port = new FakePort();
      port.store.set(KOJO2_STORAGE_LEDGER_KEY, JSON.stringify(raw));
      port.resetOps();
      const result = commitOf(persisterOf(port), registryOf(sourceOf(VAR_FAVOR)));
      expect(result.kind, JSON.stringify(raw)).toBe('corrupt-ledger');
      if (result.kind !== 'corrupt-ledger') continue;
      expect(result.reason, JSON.stringify(raw)).toBe('shape');
      expect(port.writes(), JSON.stringify(raw)).toEqual([]);
    }
  });

  it('records 序列化：键排序 + 字段序固定、空表省略字段（旧字节逐字不变）', () => {
    const raw =
      '{"version":1,"fingerprint":"f","slots":{"b":"save#1","a":"save#0"},' +
      '"records":{"b":{"slot":1,"valueType":"string","arraySize":null},' +
      '"a":{"slot":0,"valueType":"int","arraySize":2}},"updatedAt":"2026-01-01T00:00:00.000Z"}';
    const parsed = parseKojo2StorageLedger(raw);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(Object.keys(parsed.ledger.records)).toEqual(['a', 'b']);
    // 盘上键序不管怎么排，序列化一律规范化（slots/records 键排序 + 字段序固定）
    expect(serializeKojo2StorageLedger(parsed.ledger)).toBe(
      '{"version":1,"fingerprint":"f","slots":{"a":"save#0","b":"save#1"},' +
        '"records":{"a":{"slot":0,"valueType":"int","arraySize":2},' +
        '"b":{"slot":1,"valueType":"string","arraySize":null}},' +
        '"updatedAt":"2026-01-01T00:00:00.000Z"}',
    );
    expect(
      serializeKojo2StorageLedger({ ...parsed.ledger, records: {} }),
    ).toBe(
      '{"version":1,"fingerprint":"f","slots":{"a":"save#0","b":"save#1"},' +
        '"updatedAt":"2026-01-01T00:00:00.000Z"}',
    );
  });

  it('形状表与槽位表不同键集 → invalid-registry（缺一格 / 多一格都不落账）', () => {
    const base = registryOf(sourceOf(VAR_FAVOR, VAR_MOOD));
    const favorKey = storageKeyOf(base, '好感');
    const nextSnapshot = snapshotOf(base);
    const saveTable = nextSnapshot.classes.save ?? {};
    const favorRecord = saveTable[favorKey];
    if (favorRecord === undefined) throw new Error('fixture 里没有好感的形状记录');
    const missing = {
      ...base,
      storagePlan: {
        ...base.storagePlan,
        nextSnapshot: { ...nextSnapshot, classes: { save: { [favorKey]: favorRecord } } },
      },
    } as unknown as Kojo2StorageRegistry;
    const port = new FakePort();
    const missingResult = commitOf(persisterOf(port), missing);
    expect(missingResult.kind).toBe('invalid-registry');
    if (missingResult.kind === 'invalid-registry') {
      expect(missingResult.detail).toContain('缺少形状事实');
    }
    expect(port.writes()).toEqual([]);

    const ghost = {
      ...base,
      storagePlan: {
        ...base.storagePlan,
        nextSnapshot: {
          ...nextSnapshot,
          classes: {
            save: { ...saveTable, ghost: { slot: 9, valueType: 'int', arraySize: null } },
          },
        },
      },
    } as unknown as Kojo2StorageRegistry;
    const ghostPort = new FakePort();
    const ghostResult = commitOf(persisterOf(ghostPort), ghost);
    expect(ghostResult.kind).toBe('invalid-registry');
    expect(ghostPort.writes()).toEqual([]);
  });
});
