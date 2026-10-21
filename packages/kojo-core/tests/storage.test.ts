/**
 * 存储期槽位分配器（`project/storage.ts`）单测——任务契约逐条钉：
 *
 * 1) 首次分配稳定（声明键字典序 → 最小未用号）；
 * 2) 幂等（同事实 + 同账本重跑：0 新增、槽位零变化）；
 * 3) 新增 / 改名**不搬旧槽**（既有声明槽位不动）；
 * 4) 删除**可回收**（槽复用如实上报 `recycled`）；
 * 5) 换盘（`gameFingerprint` 不匹配）→ error 且**不产新快照**；
 * 6) 存档/会话改型、区段漂移、槽位耗尽、登记簿损坏 → fail-closed；
 * 7) 端口两阶段：stage 不落地、commit 才生效、令牌单次有效；
 * 8) 输出确定性（打乱注入顺序逐字节相同）。
 */
import { describe, expect, it } from 'vitest';

import type { KojoSpan, KojoVarStorage } from '../src/ast';
import {
  allocateStorageSlots,
  commitStoragePlan,
  createMemorySlotRegistry,
  planStorageSlots,
  SLOT_SNAPSHOT_VERSION,
  stageStoragePlan,
  type SlotAssignmentRecord,
  type SlotRegistrySnapshot,
  type SlotTable,
  type SlotClassSpec,
  type StorageDeclarationFact,
  type StorageFacts,
} from '../src/project/storage';

/* ============================== 事实构造器 ============================== */

const sp = (line: number, column = 1): KojoSpan => ({
  start: { line, column },
  end: { line, column: column + 1 },
});

const CLASSES: readonly SlotClassSpec[] = [
  { storage: 'scene', min: 0, max: 999, scope: 'unit' },
  { storage: 'save', min: 0, max: 999, scope: 'project' },
  { storage: 'session', min: 0, max: 99, scope: 'project' },
];

interface DeclOptions {
  readonly filePath?: string;
  readonly line?: number;
  readonly valueType?: 'int' | 'string';
  readonly arraySize?: number | null;
  readonly unitId?: string;
}

const decl = (key: string, name: string, storage: KojoVarStorage, options: DeclOptions = {}): StorageDeclarationFact => ({
  key,
  name,
  storage,
  filePath: options.filePath ?? 'a.kojo',
  span: sp(options.line ?? 1),
  valueType: options.valueType ?? 'int',
  arraySize: options.arraySize ?? null,
  ...(options.unitId !== undefined ? { unitId: options.unitId } : {}),
});

const factsOf = (
  declarations: readonly StorageDeclarationFact[],
  overrides: Partial<StorageFacts> = {},
): StorageFacts => ({
  gameFingerprint: overrides.gameFingerprint ?? 'fp-1',
  classes: overrides.classes ?? CLASSES,
  declarations,
});

const record = (slot: number, valueType: 'int' | 'string' = 'int', arraySize: number | null = null): SlotAssignmentRecord => ({
  slot,
  valueType,
  arraySize,
});

const snapshotOf = (
  classes: Partial<Record<KojoVarStorage, SlotTable>>,
  gameFingerprint = 'fp-1',
): SlotRegistrySnapshot => ({ version: SLOT_SNAPSHOT_VERSION, gameFingerprint, classes });

const saveTable = (table: SlotTable): Partial<Record<KojoVarStorage, SlotTable>> => ({ save: table });

const slotOf = (plan: ReturnType<typeof planStorageSlots>, key: string): number | undefined =>
  plan.assignments.find((assignment) => assignment.key === key)?.slot;

/* ============================== 1. 首次分配 / 幂等 ============================== */

describe('槽位分配 · 首次 / 幂等', () => {
  it('首次分配：按声明键字典序取最小未用号，输出稳定排序', () => {
    const plan = planStorageSlots(
      factsOf([decl('k-b', 'B', 'save'), decl('k-a', 'A', 'save'), decl('k-c', 'C', 'save')]),
      null,
    );
    expect(plan.ok).toBe(true);
    expect(plan.failures).toEqual([]);
    expect(plan.diagnostics).toEqual([]);
    expect(plan.assignments.map((assignment) => `${assignment.key}=${assignment.slot}:${assignment.kind}`)).toEqual([
      'k-a=0:allocated',
      'k-b=1:allocated',
      'k-c=2:allocated',
    ]);
    expect(plan.nextSnapshot).toEqual(snapshotOf({ save: { 'k-a': record(0), 'k-b': record(1), 'k-c': record(2) } }));
    expect(plan.stats).toMatchObject({ declarations: 3, retained: 0, allocated: 3, retired: 0, recycled: 0 });
  });

  it('同事实 + 已提交账本重跑 ⇒ 幂等：零新增、零回收、槽位逐条不变', () => {
    const definitions = [decl('k-a', 'A', 'save'), decl('k-b', 'B', 'save')];
    const first = planStorageSlots(factsOf(definitions), null);
    const second = planStorageSlots(factsOf(definitions), first.nextSnapshot);

    expect(second.ok).toBe(true);
    expect(second.stats.retained).toBe(2);
    expect(second.stats.allocated).toBe(0);
    expect(second.recycled).toEqual([]);
    expect(second.retired).toEqual([]);
    expect(second.assignments.map((assignment) => assignment.slot)).toEqual([0, 1]);
    expect(second.assignments.every((assignment) => assignment.kind === 'retained')).toBe(true);
    // 快照可 JSON 往返（宿主持久化形态）
    expect(JSON.parse(JSON.stringify(second.nextSnapshot))).toEqual(second.nextSnapshot);
  });

  it('无声明 + 无账本 ⇒ 合法空账本（ok，不报错）', () => {
    const plan = planStorageSlots(factsOf([]), null);
    expect(plan.ok).toBe(true);
    expect(plan.nextSnapshot).toEqual(snapshotOf({}));
    expect(plan.assignments).toEqual([]);
  });
});

/* ============================== 2. 新增 / 改名 / 删除 ============================== */

describe('槽位分配 · 稳定性', () => {
  it('新增声明不搬旧槽（既有槽位逐条不变，新声明取最小空位）', () => {
    const first = planStorageSlots(factsOf([decl('k-a', 'A', 'save'), decl('k-b', 'B', 'save')]), null);
    const second = planStorageSlots(
      factsOf([decl('k-a', 'A', 'save'), decl('k-b', 'B', 'save'), decl('k-c', 'C', 'save')]),
      first.nextSnapshot,
    );
    expect(second.ok).toBe(true);
    expect(slotOf(second, 'k-a')).toBe(0);
    expect(slotOf(second, 'k-b')).toBe(1);
    expect(slotOf(second, 'k-c')).toBe(2);
    expect(second.assignments.filter((assignment) => assignment.kind === 'retained').map((assignment) => assignment.key)).toEqual(['k-a', 'k-b']);
  });

  it('改名不搬旧槽：声明键不变 ⇒ 槽位不动（只是显示名变）', () => {
    const first = planStorageSlots(factsOf([decl('stable-key', '旧名字', 'save')]), null);
    const renamed: StorageDeclarationFact = { ...decl('stable-key', '新名字', 'save'), span: sp(9) };
    const second = planStorageSlots(factsOf([renamed]), first.nextSnapshot);

    expect(second.ok).toBe(true);
    expect(slotOf(second, 'stable-key')).toBe(0);
    expect(second.stats.retained).toBe(1);
    expect(second.stats.allocated).toBe(0);
    expect(second.retired).toEqual([]);
    expect(second.nextSnapshot?.classes.save?.['stable-key']?.slot).toBe(0);
  });

  it('删除可回收：退役槽如实上报，新声明复用该槽并记录 recycled（旧值风险可见）', () => {
    const first = planStorageSlots(factsOf([decl('k-a', 'A', 'save'), decl('k-b', 'B', 'save')]), null);
    const second = planStorageSlots(
      factsOf([decl('k-a', 'A', 'save'), decl('k-c', 'C', 'save')]),
      first.nextSnapshot,
    );
    expect(second.ok).toBe(true);
    expect(second.retired).toEqual([{ storage: 'save', key: 'k-b', slot: 1 }]);
    expect(slotOf(second, 'k-c')).toBe(1);
    expect(second.recycled).toEqual([{ storage: 'save', slot: 1, previousKey: 'k-b', nextKey: 'k-c' }]);
    expect(second.nextSnapshot?.classes.save).toEqual({ 'k-a': record(0), 'k-c': record(1) });
  });

  it('换键 = 删除旧键 + 新增新键（不把旧槽当同一变量搬过去）', () => {
    const first = planStorageSlots(factsOf([decl('old-key', '同名', 'save')]), null);
    const second = planStorageSlots(factsOf([decl('new-key', '同名', 'save')]), first.nextSnapshot);
    expect(second.ok).toBe(true);
    expect(second.retired).toEqual([{ storage: 'save', key: 'old-key', slot: 0 }]);
    expect(second.assignments.map((assignment) => `${assignment.key}=${assignment.slot}`)).toEqual(['new-key=0']);
  });

  it('场景槽位按单元分账：不同单元同名互不冲突、各自分配', () => {
    const classes: readonly SlotClassSpec[] = [{ storage: 'scene', min: 0, max: 99, scope: 'unit' }];
    const plan = planStorageSlots(
      factsOf(
        [
          decl('u1:计数', '计数', 'scene', { unitId: '单元1', filePath: 'a.kojo' }),
          decl('u2:计数', '计数', 'scene', { unitId: '单元2', filePath: 'a.kojo' }),
        ],
        { classes },
      ),
      null,
    );
    expect(plan.ok).toBe(true);
    expect(plan.assignments.map((assignment) => assignment.slot)).toEqual([0, 1]);
  });

  it('项目级存储同名（不同文件）⇒ duplicate-storage-name + core/decl/duplicate-name', () => {
    const plan = planStorageSlots(
      factsOf([decl('k1', '今天已触发', 'save', { filePath: 'a.kojo' }), decl('k2', '今天已触发', 'save', { filePath: 'b.kojo' })]),
      null,
    );
    expect(plan.ok).toBe(false);
    expect(plan.failures.map((failure) => failure.kind)).toEqual(['duplicate-storage-name']);
    expect(plan.diagnostics.map((diag) => diag.code)).toEqual(['core/decl/duplicate-name']);
    expect(plan.diagnostics[0]!.severity).toBe('error');
  });
});

/* ============================== 3. 换盘 / 完整性 ============================== */

describe('槽位分配 · 换盘与完整性 fail-closed', () => {
  it('gameFingerprint 不匹配 ⇒ ok=false、nextSnapshot=null、账本原样不动', () => {
    const previous = snapshotOf(saveTable({ 'k-a': record(0) }), '旧盘');
    const plan = planStorageSlots(factsOf([decl('k-a', 'A', 'save')], { gameFingerprint: '新盘' }), previous);
    expect(plan.ok).toBe(false);
    expect(plan.nextSnapshot).toBeNull();
    expect(plan.failures.map((failure) => failure.kind)).toEqual(['fingerprint-mismatch']);
    expect(plan.diagnostics).toEqual([]);
    expect(plan.assignments).toEqual([]);
  });

  it('登记簿版本未知 ⇒ snapshot-version-unsupported（拒绝在未知格式上分配）', () => {
    const previous = { ...snapshotOf(saveTable({ 'k-a': record(0) })), version: 2 } as unknown as SlotRegistrySnapshot;
    const plan = planStorageSlots(factsOf([decl('k-a', 'A', 'save')]), previous);
    expect(plan.ok).toBe(false);
    expect(plan.failures.map((failure) => failure.kind)).toEqual(['snapshot-version-unsupported']);
  });

  it('存档变量改类型/数组长度 ⇒ declaration-shape-changed（不静默改型）', () => {
    const previous = snapshotOf(saveTable({ 'k-a': record(0) }));
    const changed = planStorageSlots(factsOf([decl('k-a', 'A', 'save', { valueType: 'string' })]), previous);
    expect(changed.ok).toBe(false);
    expect(changed.failures.map((failure) => failure.kind)).toEqual(['declaration-shape-changed']);

    const resized = planStorageSlots(factsOf([decl('k-a', 'A', 'save', { arraySize: 10 })]), previous);
    expect(resized.failures.map((failure) => failure.kind)).toEqual(['declaration-shape-changed']);
  });

  it('场景变量改型合法（每次调用重建，不绑存档）', () => {
    const previous = snapshotOf({ scene: { 'k-scene': record(0) } });
    const plan = planStorageSlots(
      factsOf([decl('k-scene', '临时', 'scene', { valueType: 'string' })], {
        classes: [{ storage: 'scene', min: 0, max: 9, scope: 'unit' }],
      }),
      previous,
    );
    expect(plan.ok).toBe(true);
    expect(plan.stats.retained).toBe(1);
    expect(plan.nextSnapshot?.classes.scene?.['k-scene']).toEqual(record(0, 'string'));
  });

  it('既有槽位落在新区段外 ⇒ slot-range-changed（搬槽 = 旧存档错位，拒绝）', () => {
    const previous = snapshotOf(saveTable({ 'k-a': record(5) }));
    const plan = planStorageSlots(
      factsOf([decl('k-a', 'A', 'save')], { classes: [{ storage: 'save', min: 10, max: 20, scope: 'project' }] }),
      previous,
    );
    expect(plan.ok).toBe(false);
    expect(plan.failures.map((failure) => failure.kind)).toEqual(['slot-range-changed']);
  });

  it('槽位区段耗尽 ⇒ slot-space-exhausted（不挤占、不移动既有槽）', () => {
    const classes: readonly SlotClassSpec[] = [{ storage: 'save', min: 0, max: 1, scope: 'project' }];
    const first = planStorageSlots(factsOf([decl('k-a', 'A', 'save'), decl('k-b', 'B', 'save')], { classes }), null);
    const second = planStorageSlots(
      factsOf([decl('k-a', 'A', 'save'), decl('k-b', 'B', 'save'), decl('k-c', 'C', 'save')], { classes }),
      first.nextSnapshot,
    );
    expect(second.ok).toBe(false);
    expect(second.failures.map((failure) => failure.kind)).toEqual(['slot-space-exhausted']);
    expect(second.nextSnapshot).toBeNull();
  });

  it('声明键重复 ⇒ duplicate-declaration-key + core/decl/duplicate-name（指向第二处）', () => {
    const plan = planStorageSlots(
      factsOf([decl('dup', 'A', 'save', { line: 1 }), decl('dup', 'B', 'save', { line: 2 })]),
      null,
    );
    expect(plan.ok).toBe(false);
    expect(plan.failures.map((failure) => failure.kind)).toEqual(['duplicate-declaration-key']);
    expect(plan.diagnostics[0]!.code).toBe('core/decl/duplicate-name');
    expect(plan.diagnostics[0]!.span?.start.line).toBe(2);
  });

  it('存储期未被 adapter 声明 ⇒ unknown-storage-class + core/decl/unknown-storage', () => {
    const plan = planStorageSlots(
      factsOf([decl('k', 'X', 'save')], { classes: [{ storage: 'scene', min: 0, max: 9, scope: 'unit' }] }),
      null,
    );
    expect(plan.ok).toBe(false);
    expect(plan.failures.map((failure) => failure.kind)).toEqual(['unknown-storage-class']);
    expect(plan.diagnostics.map((diag) => diag.code)).toEqual(['core/decl/unknown-storage']);
  });

  it('区段声明非法（min > max / 非整数）⇒ invalid-class-spec', () => {
    const plan = planStorageSlots(
      factsOf([decl('k', 'X', 'save')], { classes: [{ storage: 'save', min: 5, max: 1, scope: 'project' }] }),
      null,
    );
    expect(plan.ok).toBe(false);
    expect(plan.failures.map((failure) => failure.kind)).toEqual(['invalid-class-spec']);
  });

  it('adapter 撤掉某个存储期：其旧条目退役（retired 可见），不静默丢', () => {
    const previous = snapshotOf({ save: { 'k-old': record(3) }, scene: { 'k-s': record(0) } });
    const plan = planStorageSlots(
      factsOf([decl('k-s', '临时', 'scene')], { classes: [{ storage: 'scene', min: 0, max: 9, scope: 'unit' }] }),
      previous,
    );
    expect(plan.ok).toBe(true);
    expect(plan.retired).toEqual([{ storage: 'save', key: 'k-old', slot: 3 }]);
    expect(plan.nextSnapshot?.classes.save).toBeUndefined();
  });
});

/* ============================== 4. 端口两阶段 ============================== */

describe('SlotRegistry 端口 · 两阶段', () => {
  it('stage 不落地、commit 才生效；allocateStorageSlots 一步到位', () => {
    const registry = createMemorySlotRegistry();
    const plan = planStorageSlots(factsOf([decl('k-a', 'A', 'save')]), registry.read());
    const token = stageStoragePlan(registry, plan);
    expect(token).not.toBeNull();
    expect(registry.read()).toBeNull(); // 暂存期不可见
    expect(registry.stagedCount()).toBe(1);

    commitStoragePlan(registry, token!);
    expect(registry.read()).toEqual(plan.nextSnapshot);
    expect(registry.stagedCount()).toBe(0);

    // 再跑一次幂等分配（含端口装配）
    const second = allocateStorageSlots(registry, factsOf([decl('k-a', 'A', 'save')]));
    expect(second.ok).toBe(true);
    expect(second.stats.retained).toBe(1);
  });

  it('失败规划不进入提交阶段（stageStoragePlan → null），盘上账本原样', () => {
    const registry = createMemorySlotRegistry(snapshotOf(saveTable({ 'k-a': record(0) }), '旧盘'));
    const before = registry.read();
    const plan = allocateStorageSlots(registry, factsOf([decl('k-a', 'A', 'save')], { gameFingerprint: '新盘' }));
    expect(plan.ok).toBe(false);
    expect(registry.read()).toBe(before);
    expect(registry.stagedCount()).toBe(0);
    expect(stageStoragePlan(registry, plan)).toBeNull();
  });

  it('令牌单次有效：重复提交 / 未知令牌 → 抛错（不静默）', () => {
    const registry = createMemorySlotRegistry();
    const plan = planStorageSlots(factsOf([decl('k-a', 'A', 'save')]), null);
    const token = registry.stage(plan.nextSnapshot!);
    registry.commit(token);
    expect(() => registry.commit(token)).toThrow(/令牌无效|已被提交/);
    expect(() => registry.commit({ id: Symbol('unknown') })).toThrow(/令牌无效|已被提交/);
  });
});

/* ============================== 5. 确定性 ============================== */

describe('槽位分配 · 输出确定性', () => {
  it('打乱声明注入顺序 ⇒ 快照与分配表逐字节相同', () => {
    const definitions = [
      decl('k-b', 'B', 'save'),
      decl('k-a', 'A', 'save'),
      decl('k-scene', '临时', 'scene', { unitId: 'u1' }),
      decl('k-session', '会话', 'session'),
    ];
    const one = planStorageSlots(factsOf(definitions), null);
    const two = planStorageSlots(factsOf([...definitions].reverse()), null);
    expect(JSON.stringify(two.nextSnapshot)).toBe(JSON.stringify(one.nextSnapshot));
    expect(JSON.stringify(two.assignments)).toBe(JSON.stringify(one.assignments));
    // 类顺序固定：scene → save → session
    expect(one.assignments.map((assignment) => assignment.storage)).toEqual(['scene', 'save', 'save', 'session']);
  });
});
