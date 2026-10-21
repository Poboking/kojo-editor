/**
 * 存储期槽位分配器（`场景` / `存档` / `会话`）——**项目级、跨构建稳定**的槽位账本。
 *
 * ## 为什么这一层最危险
 *
 * 槽位号一旦和存档里的字节绑定，任何"看起来无害"的重新分配都会把玩家的存档读成
 * 另一个变量：改名搬槽 = 旧值串进新变量；新增声明挤占 = 全部后移一位；换盘/换汉化后
 * 变量表变了却继续按旧号写 = 静默写坏存档。设计稿 §10.3 的实现前置就是这条（P0）。
 *
 * 本模块的答案是三条硬规则，全部可测：
 *
 * 1. **按稳定声明键分配，不按名字分配**：`StorageDeclarationFact.key` 是调用方（编辑器
 *    账本）给的跨构建稳定标识。键不变 ⇒ 槽位永远不动（改名不搬槽）；键变了 ⇒ 视为
 *    旧声明删除 + 新声明新增（删除的槽可回收，回收**如实上报** `recycled`，不许静默）。
 * 2. **退化输入一律 fail-closed**：`gameFingerprint` 不匹配、登记簿版本未知、既有槽位
 *    落在新声明的区段外、`存档/会话` 变量改类型/数组长度 —— 全部返回 `ok:false` 且
 *    **不产生新快照**（`nextSnapshot === null`）。宁可整个项目报错，也不搬一个槽。
 * 3. **两阶段落盘走端口**：`SlotRegistry.read()/stage()/commit()` 由宿主实现持久化；
 *    `stage` 只暂存（不落地），`commit` 才生效。本模块不读盘、不写盘、不认识 Monaco。
 *
 * ## 槽位区段来自 adapter（`storageClasses`）
 *
 * `SlotClassSpec` 只表达"这类存储期能用的编号闭区间 + 声明键作用域"：
 * - `scope: 'project'`（存档/会话）：一份账本全项目共用——两个文件声明同名存档变量是
 *   真冲突（引擎侧该名字只有一个全局落点），报 `core/storage/duplicate-name`；
 * - `scope: 'unit'`（场景）：按 `unitId`（`# 机` / `@织` 监听）分账，跨单元同名互不影响
 *   （§3.4.4：场景变量不得跨单元共享）。
 *
 * 分配策略是**最小未用号**：既有的保留，新增按声明键字典序取最小空位，删除的槽优先
 * 回收。于是"改名 / 新增"不会移动任何其他声明（不搬旧槽），"删除"可以回收。
 *
 * ## 诊断口径
 *
 * 每条失败**必带一枚 core 诊断**（`core/storage/*` 闭集，见 `STORAGE_FAILURE_CODES`；
 * severity 一律 error，span 指回声明处，项目级失败为 null）——失败对象与诊断同源，
 * 项目层不产"裸 `StorageFailure`"。存储账本是**跨构建事实**（与单文件 AST 的声明
 * 重名不是同一件事），故键/名字撞车也走 `core/storage/duplicate-key` /
 * `duplicate-name`，两套码各管各的面。
 */
import type { KojoSpan, KojoValueType, KojoVarStorage } from '../ast.js';
import { severityOf, type CoreDiagnosticCode, type KojoDiagnostic } from '../diagnostics.js';
import { compareText, formatLocation, sortDiagnostics, type Located } from './ordering.js';

/* ============================== 契约：事实与快照 ============================== */

/** 一类存储期可用的槽位区段（由 adapter `storageClasses` 提供；core 不认识具体落点） */
export interface SlotClassSpec {
  readonly storage: KojoVarStorage;
  /** 槽位编号闭区间起点（含；0 基） */
  readonly min: number;
  /** 槽位编号闭区间终点（含） */
  readonly max: number;
  /** 声明键作用域：`project` = 全项目一份账（存档/会话）；`unit` = 按单元分账（场景） */
  readonly scope: 'project' | 'unit';
}

/** 一条需要稳定槽位的声明事实（`# 变量`；调用方从 AST + 账本拼出） */
export interface StorageDeclarationFact extends Located {
  /**
   * **稳定声明键**：跨构建不变的标识（编辑器账本给）。
   *
   * - 改名不换键 ⇒ 槽位不动（旧存档里的值还属于这个声明）；
   * - 换键 ⇒ 旧键按"删除"处理（槽可回收，并进 `retired`）；新键按"新增"分配。
   */
  readonly key: string;
  readonly storage: KojoVarStorage;
  /** 作者可读的声明名（仅用于诊断/回收记录；槽位只认 `key`） */
  readonly name: string;
  readonly valueType: KojoValueType;
  /** 一维数组长度；null = 标量 */
  readonly arraySize: number | null;
  /** 场景变量的单元边界（`# 机` / `@织` 监听）；非场景忽略。缺省 = 文件级单元 */
  readonly unitId?: string;
}

/** 一次规划所需的全部事实（装配层注入；本层零 IO） */
export interface StorageFacts {
  /** adapter/游戏事实指纹（CSV/ERH/引擎/汉化）；换盘检测的唯一依据 */
  readonly gameFingerprint: string;
  readonly classes: readonly SlotClassSpec[];
  readonly declarations: readonly StorageDeclarationFact[];
}

/** 一个已分配槽位的存档记录（形状也存：改型是写坏存档事故，必须可检测） */
export interface SlotAssignmentRecord {
  readonly slot: number;
  readonly valueType: KojoValueType;
  readonly arraySize: number | null;
}

/** 一类存储期的 `声明键 → 槽位记录` 表（JSON 友好：宿主直接持久化） */
export type SlotTable = Readonly<Record<string, SlotAssignmentRecord>>;

export const SLOT_SNAPSHOT_VERSION = 1 as const;

/** 可持久化的槽位账本快照（**唯一落盘形态**；宿主负责存/取，本层只产出） */
export interface SlotRegistrySnapshot {
  readonly version: typeof SLOT_SNAPSHOT_VERSION;
  readonly gameFingerprint: string;
  readonly classes: Readonly<Partial<Record<KojoVarStorage, SlotTable>>>;
}

/* ============================== 端口 ============================== */

/** 暂存令牌（不透明；`stage` 发、`commit` 收） */
export interface SlotRegistryCommitToken {
  /** 仅供实现方识别的令牌 id（语义上不透明；调用方不得解读） */
  readonly id: symbol;
}

/**
 * 宿主持久化端口（编辑器侧实现：写 store / 工作区元数据）。
 *
 * 两阶段语义：`stage` **不得**产生任何持久化副作用；`commit` 才落盘（且必须整体成功）。
 * 这样"换盘检测失败"或"用户取消"时不会留下半截账本。
 */
export interface SlotRegistry {
  /** 读已提交快照；无账本 → null（首次分配） */
  read(): SlotRegistrySnapshot | null;
  /** 暂存一份拟提交快照，返回令牌（不落盘） */
  stage(snapshot: SlotRegistrySnapshot): SlotRegistryCommitToken;
  /** 提交暂存快照（落盘）；令牌无效/重复提交 → 抛错（不静默） */
  commit(token: SlotRegistryCommitToken): void;
}

/* ============================== 结果 ============================== */

/**
 * 存储完整性失败的种类（机器可读；每种都对应一枚 `core/storage/*` 诊断码，
 * 见 `STORAGE_FAILURE_CODES`——项目层不产"裸失败"，诊断面与 code 面同源）。
 */
export type StorageFailureKind =
  | 'snapshot-version-unsupported'
  | 'fingerprint-mismatch'
  | 'invalid-class-spec'
  | 'invalid-declaration'
  | 'unknown-storage-class'
  | 'duplicate-declaration-key'
  | 'duplicate-storage-name'
  | 'declaration-shape-changed'
  | 'corrupt-snapshot'
  | 'slot-range-changed'
  | 'slot-space-exhausted';

/** 失败种类 → core 诊断码（`diagnostics.ts` additive 入表；级别一律 error） */
const STORAGE_FAILURE_CODES: Readonly<Record<StorageFailureKind, CoreDiagnosticCode>> = {
  'snapshot-version-unsupported': 'core/storage/snapshot-version',
  'fingerprint-mismatch': 'core/storage/fingerprint-mismatch',
  'invalid-class-spec': 'core/storage/invalid-class',
  'invalid-declaration': 'core/storage/invalid-declaration',
  'unknown-storage-class': 'core/storage/unknown-class',
  'duplicate-declaration-key': 'core/storage/duplicate-key',
  'duplicate-storage-name': 'core/storage/duplicate-name',
  'declaration-shape-changed': 'core/storage/shape-changed',
  'corrupt-snapshot': 'core/storage/corrupt-snapshot',
  'slot-range-changed': 'core/storage/range-changed',
  'slot-space-exhausted': 'core/storage/exhausted',
};

export interface StorageFailure {
  readonly kind: StorageFailureKind;
  readonly message: string;
  /** 与 `kind` 一一对应的 core 诊断（severity=error；span=声明处，项目级失败为 null） */
  readonly diagnostic: KojoDiagnostic;
}

export interface SlotAssignment {
  readonly key: string;
  readonly storage: KojoVarStorage;
  readonly name: string;
  readonly slot: number;
  readonly filePath: string;
  readonly span: KojoSpan | null;
  /** `retained` = 沿用旧槽；`allocated` = 本次新分配 */
  readonly kind: 'retained' | 'allocated';
}

/** 一个被回收再利用的槽（**必须如实上报**：旧存档里这个槽的旧值会被新声明读到） */
export interface RecycledSlot {
  readonly storage: KojoVarStorage;
  readonly slot: number;
  /** 旧槽的拥有者声明键（本次被判定为删除） */
  readonly previousKey: string;
  /** 新占用者声明键 */
  readonly nextKey: string;
}

/** 本次消失的声明（删除/换键）；槽位号在快照里已不再保留 */
export interface RetiredSlot {
  readonly storage: KojoVarStorage;
  readonly key: string;
  readonly slot: number;
}

export interface StorageAllocationStats {
  readonly classes: number;
  readonly declarations: number;
  readonly retained: number;
  readonly allocated: number;
  readonly retired: number;
  readonly recycled: number;
}

export interface StorageAllocationPlan {
  /** `false` = 有任何失败；此时 `nextSnapshot === null`，调用方**不得**提交 */
  readonly ok: boolean;
  /** 拟提交的新快照（仅 `ok === true` 时非 null） */
  readonly nextSnapshot: SlotRegistrySnapshot | null;
  /** 稳定排序后的「声明键 → 槽位」结果（类顺序固定 + 键字典序） */
  readonly assignments: readonly SlotAssignment[];
  readonly recycled: readonly RecycledSlot[];
  readonly retired: readonly RetiredSlot[];
  readonly failures: readonly StorageFailure[];
  readonly diagnostics: readonly KojoDiagnostic[];
  readonly stats: StorageAllocationStats;
}

/* ============================== 内部工具 ============================== */

const STORAGE_ORDER: readonly KojoVarStorage[] = ['scene', 'save', 'session'];

/** 槽位类是否跨存档保留（形状/类型变更必须 fail-closed；场景变量每次调用重建，无此问题） */
function isPersistentStorage(storage: KojoVarStorage): boolean {
  return storage === 'save' || storage === 'session';
}

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function diagnosticOf(code: CoreDiagnosticCode, message: string, span: KojoSpan | null): KojoDiagnostic {
  return { code, severity: severityOf(code), message, span };
}

function shapeText(valueType: KojoValueType, arraySize: number | null): string {
  const base = valueType === 'int' ? '整数' : '字符串';
  return arraySize === null ? base : `${base}[${arraySize}]`;
}

interface MutablePlan {
  readonly assignments: SlotAssignment[];
  readonly recycled: RecycledSlot[];
  readonly retired: RetiredSlot[];
  readonly failures: StorageFailure[];
  readonly diagnostics: KojoDiagnostic[];
  retained: number;
  allocated: number;
}

function emptyPlanState(): MutablePlan {
  return { assignments: [], recycled: [], retired: [], failures: [], diagnostics: [], retained: 0, allocated: 0 };
}

/**
 * 记一条失败：失败对象与诊断**同源**（`kind` 查表得 core 码），不产"裸失败"。
 *
 * `span` = 该失败指向的声明处（可点回源行）；项目级失败（换盘 / 版本 / 区段声明）
 * 没有单一声明可指，给 null。
 */
function fail(state: MutablePlan, kind: StorageFailureKind, message: string, span: KojoSpan | null): void {
  const diagnostic = diagnosticOf(STORAGE_FAILURE_CODES[kind], message, span);
  state.failures.push({ kind, message, diagnostic });
  state.diagnostics.push(diagnostic);
}

/** 收束：ok=false 时绝不产出新快照（不产半成品） */
function finalize(state: MutablePlan, facts: StorageFacts, classes: SlotTable[]): StorageAllocationPlan {
  const ok = state.failures.length === 0;
  const classTable: Partial<Record<KojoVarStorage, SlotTable>> = {};
  for (let i = 0; i < STORAGE_ORDER.length; i++) {
    const table = classes[i];
    if (table !== undefined && Object.keys(table).length > 0) {
      classTable[STORAGE_ORDER[i]!] = table;
    }
  }
  const nextSnapshot: SlotRegistrySnapshot | null = ok
    ? {
        version: SLOT_SNAPSHOT_VERSION,
        gameFingerprint: facts.gameFingerprint,
        classes: classTable,
      }
    : null;
  const order = new Map<KojoVarStorage, number>(STORAGE_ORDER.map((storage, index) => [storage, index]));
  const assignments = [...state.assignments].sort(
    (a, b) => (order.get(a.storage) ?? STORAGE_ORDER.length) - (order.get(b.storage) ?? STORAGE_ORDER.length) || compareText(a.key, b.key),
  );
  const recycled = [...state.recycled].sort(
    (a, b) => (order.get(a.storage) ?? STORAGE_ORDER.length) - (order.get(b.storage) ?? STORAGE_ORDER.length) || compareText(a.previousKey, b.previousKey) || compareText(a.nextKey, b.nextKey),
  );
  const retired = [...state.retired].sort(
    (a, b) => (order.get(a.storage) ?? STORAGE_ORDER.length) - (order.get(b.storage) ?? STORAGE_ORDER.length) || compareText(a.key, b.key),
  );
  return {
    ok,
    nextSnapshot,
    assignments,
    recycled,
    retired,
    failures: state.failures,
    diagnostics: sortDiagnostics(state.diagnostics),
    stats: {
      classes: ok ? Object.keys(classTable).length : 0,
      declarations: facts.declarations.length,
      retained: state.retained,
      allocated: state.allocated,
      retired: retired.length,
      recycled: recycled.length,
    },
  };
}

/* ============================== 纯分配算法 ============================== */

/**
 * 规划一次槽位分配（**纯函数**：事实 + 旧快照进，新快照/失败出；零 IO）。
 *
 * `previous === null` = 首次分配（拿当前 `gameFingerprint` 建账）。
 * 任何失败 ⇒ `ok:false` + `nextSnapshot:null`（调用方不得提交）。
 */
export function planStorageSlots(facts: StorageFacts, previous: SlotRegistrySnapshot | null): StorageAllocationPlan {
  const state = emptyPlanState();
  const classes: SlotTable[] = []; // 与 STORAGE_ORDER 对齐（缺省 = 空表占位，finalize 过滤）

  // ---- 0. 旧账本兼容 / 换盘检测（先于一切分配）----
  if (previous !== null) {
    const version: number = previous.version;
    if (version !== SLOT_SNAPSHOT_VERSION) {
      fail(
        state,
        'snapshot-version-unsupported',
        `槽位登记簿版本 ${version} 不受支持（当前 ${SLOT_SNAPSHOT_VERSION}）——拒绝在未知格式上继续分配，避免写坏存档。`,
        null,
      );
      return finalize(state, facts, classes);
    }
    if (previous.gameFingerprint !== facts.gameFingerprint) {
      fail(
        state,
        'fingerprint-mismatch',
        `gameFingerprint 不匹配（登记簿「${previous.gameFingerprint}」≠ 当前「${facts.gameFingerprint}」）——换盘/换汉化会改变变量表语义，已拒绝分配：一个槽都不搬，旧账原样不动。`,
        null,
      );
      return finalize(state, facts, classes);
    }
  }

  // ---- 1. 区段声明校验 ----
  const specs = new Map<KojoVarStorage, SlotClassSpec>();
  /** 声明过但非法的区段：后续"未声明"检查不再重复报（成因已报过，不双报） */
  const invalidStorages = new Set<KojoVarStorage>();
  for (const spec of facts.classes) {
    if (!STORAGE_ORDER.includes(spec.storage)) {
      fail(state, 'invalid-class-spec', `槽位区段声明了未知存储期「${String(spec.storage)}」。`, null);
      continue;
    }
    if (specs.has(spec.storage) || invalidStorages.has(spec.storage)) {
      invalidStorages.add(spec.storage);
      fail(state, 'invalid-class-spec', `存储期「${spec.storage}」重复声明了槽位区段——区段必须唯一。`, null);
      continue;
    }
    const validRange = Number.isInteger(spec.min) && Number.isInteger(spec.max) && spec.min >= 0 && spec.min <= spec.max;
    const validScope = spec.scope === 'project' || spec.scope === 'unit';
    if (!validRange || !validScope) {
      invalidStorages.add(spec.storage);
      fail(
        state,
        'invalid-class-spec',
        `存储期「${spec.storage}」的槽位区段非法（min=${String(spec.min)} max=${String(spec.max)} scope=${String(spec.scope)}）——拒绝分配。`,
        null,
      );
      continue;
    }
    specs.set(spec.storage, spec);
  }

  // ---- 2. 声明事实校验：键合法 / 键唯一 / 存储期已声明 ----
  const keyMap = new Map<string, StorageDeclarationFact>();
  const usable: StorageDeclarationFact[] = [];
  for (const fact of facts.declarations) {
    if (typeof fact.key !== 'string' || fact.key.length === 0) {
      fail(
        state,
        'invalid-declaration',
        `存储期声明「${fact.name}」（${formatLocation(fact)}）缺少稳定声明键——无法跨构建保住槽位，已拒绝分配。`,
        fact.span,
      );
      continue;
    }
    const first = keyMap.get(fact.key);
    if (first !== undefined) {
      fail(
        state,
        'duplicate-declaration-key',
        `稳定声明键「${fact.key}」被两个声明共用（${formatLocation(first)} / ${formatLocation(fact)}）——键必须唯一，否则两个声明会争同一个槽，已拒绝分配。`,
        fact.span,
      );
      continue;
    }
    keyMap.set(fact.key, fact);
    usable.push(fact);
  }

  for (const fact of usable) {
    if (specs.has(fact.storage) || invalidStorages.has(fact.storage)) continue;
    fail(
      state,
      'unknown-storage-class',
      `存储期「${fact.storage}」（${fact.name} @ ${formatLocation(fact)}）没有 adapter 声明的槽位区段——不能猜落点。`,
      fact.span,
    );
  }

  // ---- 3. 名字冲突（同一作用域内同存储期不允许同名）----
  const nameSeen = new Map<string, StorageDeclarationFact>();
  for (const fact of usable) {
    const spec = specs.get(fact.storage);
    if (spec === undefined) continue;
    const unit = spec.scope === 'unit' ? (fact.unitId ?? fact.filePath) : '';
    const nameKey = `${fact.storage}\u0000${unit}\u0000${fact.name}`;
    const first = nameSeen.get(nameKey);
    if (first === undefined) {
      nameSeen.set(nameKey, fact);
      continue;
    }
    fail(
      state,
      'duplicate-storage-name',
      `同名存储期声明「${fact.name}」（${formatLocation(fact)} 与 ${formatLocation(first)}）落在同一个 ${spec.scope === 'unit' ? '单元' : '项目级'} 存储空间里——引擎侧只有一个名字，后声明会被静默覆盖。`,
      fact.span,
    );
  }

  // 出现失败时仍然走完诊断收集，但绝不产快照（fail-closed）。

  // ---- 4. 逐类分配（保留旧槽 → 回收删除槽 → 新增取最小空位）----
  for (let classIndex = 0; classIndex < STORAGE_ORDER.length; classIndex++) {
    const storage = STORAGE_ORDER[classIndex]!;
    const spec = specs.get(storage);
    const prevTable = previous?.classes?.[storage];
    const classFacts = usable.filter((fact) => fact.storage === storage);

    if (spec === undefined) {
      // 该类未声明：旧账里的条目全部退役（不静默丢，进 retired）
      if (prevTable !== undefined) {
        for (const key of Object.keys(prevTable).sort(compareText)) {
          state.retired.push({ storage, key, slot: prevTable[key]!.slot });
        }
      }
      classes[classIndex] = {};
      continue;
    }

    const prevKeys = prevTable === undefined ? [] : Object.keys(prevTable).sort(compareText);
    const retainedSlotByKey = new Map<string, number>();
    const retainedUsed = new Set<number>();
    for (const fact of classFacts) {
      const prev = prevTable === undefined ? undefined : own(prevTable, fact.key);
      if (prev === undefined) continue;

      const shapeChanged = prev.valueType !== fact.valueType || prev.arraySize !== fact.arraySize;
      if (shapeChanged && isPersistentStorage(storage)) {
        fail(
          state,
          'declaration-shape-changed',
          `存储期变量「${fact.name}」声明形状从 ${shapeText(prev.valueType, prev.arraySize)} 变为 ${shapeText(fact.valueType, fact.arraySize)}（${formatLocation(fact)}）——槽位 ${prev.slot} 已绑定旧存档，按新形状读取会写坏存档，已拒绝（不静默改型）。`,
          fact.span,
        );
      }
      if (prev.slot < spec.min || prev.slot > spec.max) {
        fail(
          state,
          'slot-range-changed',
          `存储期变量「${fact.name}」的既有槽位 ${prev.slot} 不在当前区段 [${spec.min}, ${spec.max}] 内（${formatLocation(fact)}）——搬槽等于让旧存档错位，已拒绝。`,
          fact.span,
        );
      }
      if (retainedUsed.has(prev.slot)) {
        fail(
          state,
          'corrupt-snapshot',
          `槽位登记簿损坏：存储期「${storage}」的槽位 ${prev.slot} 被两个声明同时占用（后者 ${fact.key}）——拒绝在其上继续分配。`,
          fact.span,
        );
      }
      retainedUsed.add(prev.slot);
      retainedSlotByKey.set(fact.key, prev.slot);
      state.retained += 1;
    }

    // 旧键不在本次事实里 = 删除（或换键）⇒ 退役，槽位可回收
    const freedOwners = new Map<number, string>();
    for (const key of prevKeys) {
      if (retainedSlotByKey.has(key)) continue;
      const prev = prevTable![key]!;
      state.retired.push({ storage, key, slot: prev.slot });
      if (prev.slot >= spec.min && prev.slot <= spec.max && !freedOwners.has(prev.slot)) {
        freedOwners.set(prev.slot, key);
      }
    }

    // 新增键：按声明键字典序取最小未用槽（先回收的、再没碰过的；不搬任何保留槽）
    const newFacts = classFacts.filter((fact) => !retainedSlotByKey.has(fact.key)).sort((a, b) => compareText(a.key, b.key));
    const used = new Set<number>(retainedUsed);
    const freed = [...freedOwners.keys()].sort((a, b) => a - b);
    let freeIndex = 0;
    let nextSlot = spec.min;
    const takeSlot = (): { slot: number; previousKey?: string } | null => {
      while (nextSlot <= spec.max && used.has(nextSlot)) nextSlot += 1;
      while (freeIndex < freed.length && used.has(freed[freeIndex]!)) freeIndex += 1;
      const candidate = freeIndex < freed.length ? freed[freeIndex]! : Number.POSITIVE_INFINITY;
      if (candidate <= nextSlot) {
        freeIndex += 1;
        used.add(candidate);
        return { slot: candidate, previousKey: freedOwners.get(candidate) };
      }
      if (nextSlot > spec.max) return null;
      const slot = nextSlot;
      nextSlot += 1;
      used.add(slot);
      return { slot };
    };
    const allocatedSlotByKey = new Map<string, number>();
    for (const fact of newFacts) {
      const taken = takeSlot();
      if (taken === null) {
        fail(
          state,
          'slot-space-exhausted',
          `存储期「${storage}」的槽位区段 [${spec.min}, ${spec.max}] 已用尽（本次需要 ${classFacts.length} 个槽）——拒绝分配，绝不挤占/移动既有槽。`,
          fact.span,
        );
        break;
      }
      allocatedSlotByKey.set(fact.key, taken.slot);
      state.allocated += 1;
      if (taken.previousKey !== undefined) {
        state.recycled.push({ storage, slot: taken.slot, previousKey: taken.previousKey, nextKey: fact.key });
      }
    }

    // 组表 + 结果（类内按声明键字典序，落盘形态确定）
    const sortedFacts = [...classFacts].sort((a, b) => compareText(a.key, b.key));
    const table: Record<string, SlotAssignmentRecord> = Object.fromEntries(
      sortedFacts.map((fact): [string, SlotAssignmentRecord] => {
        const retained = retainedSlotByKey.get(fact.key);
        const allocated = allocatedSlotByKey.get(fact.key);
        const slot = retained ?? allocated;
        return [
          fact.key,
          {
            slot: slot ?? -1, // 失败路径：占位 -1，最终 ok=false 不会落盘
            valueType: fact.valueType,
            arraySize: fact.arraySize,
          },
        ];
      }),
    );
    classes[classIndex] = table;
    for (const fact of sortedFacts) {
      const retained = retainedSlotByKey.get(fact.key);
      const allocated = allocatedSlotByKey.get(fact.key);
      const slot = retained ?? allocated;
      state.assignments.push({
        key: fact.key,
        storage,
        name: fact.name,
        slot: slot ?? -1,
        filePath: fact.filePath,
        span: fact.span,
        kind: retained === undefined ? 'allocated' : 'retained',
      });
    }
  }

  return finalize(state, facts, classes);
}

/* ============================== 端口装配 ============================== */

/** 暂存一份规划结果（不落盘）；规划失败 → null（调用方据此不进入提交阶段） */
export function stageStoragePlan(
  registry: SlotRegistry,
  plan: StorageAllocationPlan,
): SlotRegistryCommitToken | null {
  if (!plan.ok || plan.nextSnapshot === null) return null;
  return registry.stage(plan.nextSnapshot);
}

/** 提交一次暂存（等同 registry.commit，但禁止拿失败规划来提交） */
export function commitStoragePlan(registry: SlotRegistry, token: SlotRegistryCommitToken): void {
  registry.commit(token);
}

/**
 * 一步到位（读账 → 规划 → 成功才提交）：宿主"确认无换盘风险后立即分配"用。
 *
 * 失败时**绝不提交**：返回值 `ok:false`，盘上账本保持原样。
 */
export function allocateStorageSlots(registry: SlotRegistry, facts: StorageFacts): StorageAllocationPlan {
  const plan = planStorageSlots(facts, registry.read());
  if (plan.ok) {
    const token = stageStoragePlan(registry, plan);
    if (token !== null) commitStoragePlan(registry, token);
  }
  return plan;
}

/* ============================== 内存 registry（测试用） ============================== */

/** 内存实现的公开面（测试可观察「已提交 / 已暂存」两态） */
export interface MemorySlotRegistry extends SlotRegistry {
  /** 已提交快照（= `read()`；给断言用作别名） */
  committed(): SlotRegistrySnapshot | null;
  /** 暂存中（未提交）的快照数 */
  stagedCount(): number;
}

/**
 * 内存 registry（**不写盘**；给测试与纯逻辑宿主用）。
 *
 * 语义与宿主实现必须一致：`stage` 无副作用、`commit` 原子生效、令牌单次有效。
 */
export function createMemorySlotRegistry(initial: SlotRegistrySnapshot | null = null): MemorySlotRegistry {
  let committed: SlotRegistrySnapshot | null = initial;
  const staged = new Map<symbol, SlotRegistrySnapshot>();
  return {
    read(): SlotRegistrySnapshot | null {
      return committed;
    },
    stage(snapshot: SlotRegistrySnapshot): SlotRegistryCommitToken {
      const id = Symbol('kojo-slot-commit');
      staged.set(id, snapshot);
      return { id };
    },
    commit(token: SlotRegistryCommitToken): void {
      const snapshot = staged.get(token.id);
      if (snapshot === undefined) {
        throw new Error('槽位登记簿提交失败：令牌无效或已被提交（见 SlotRegistry.commit 语义）');
      }
      staged.delete(token.id);
      committed = snapshot;
    },
    committed(): SlotRegistrySnapshot | null {
      return committed;
    },
    stagedCount(): number {
      return staged.size;
    },
  };
}
