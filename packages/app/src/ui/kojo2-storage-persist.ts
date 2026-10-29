/**
 * Kojo 2.0 宿主侧**槽位账本持久化**（K2-STORAGE-PERSIST）：
 * 两阶段提交 + 逐字节回读校验 + 换盘 fail-closed + 同键幂等。
 *
 * ## 这一层为什么必须存在
 *
 * `kojo2-storage-registry.ts`（batch-3）只做**一次内存装配**：它按稳定声明键算出槽位，
 * 然后把结果交出去，**不落盘**。可槽位号一旦和玩家存档里的字节绑定，「下一次构建还能不能
 * 拿到同一个槽」就成了跨进程、跨构建的事实——这只能由宿主持久化。没有这一层，
 * 每次启动都是「首次分配」：新增一条声明就可能把所有旧变量后移一位，旧存档静默读成别人。
 *
 * 本模块只做三件事，而且每件都做成可单测的纯逻辑（端口注入）：
 *
 * 1. **账本**：`{ version, fingerprint, slots, records, updatedAt }`。
 *    只收 `# 设`（表/池/常量没有槽位语义）；`declarationKey` 默认取注册表已经算好的
 *    `storageKey`（注册表缺省口径 = `uri#行:列`，实现在分隔处用 NUL；这里不另造一套），也可注入。
 *    `slots` 是「声明键 → 槽名」，`records` 是「声明键 → `{ slot, valueType, arraySize }`」
 *    ——**槽位的形状事实**（K2-STORAGE-HOST-FULL）。为什么非要有它：core 的
 *    `SlotRegistrySnapshot.classes` 记录着每格的值类型与数组长度，而只有 `slots` 的旧账本
 *    反哺不回 `previousSnapshot`，于是「跨构建改型」这条 fail-closed 判据（`# 设 好感 整数`
 *    改成 `字符串` 必须报错而不是静默读坏存档）在宿主侧永远不触发。`records` 与 `slots`
 *    在**同一次两阶段提交**里落盘（键集必须一致），版本仍是 1：旧账本没有 `records` ⇒
 *    解析为 `{}`（不视为损坏），下一次内容有变化时自动回填。
 * 2. **两阶段提交**：先把「新账本 + 旧账本引用」写进 `pending` 键 → **回读逐字节比对**
 *    → 才写正式键 → 删 `pending`。任一步失败都走**校验式回滚**（先读现状，只修
 *   真正偏离的那一格），返回可判别错误，不把半批留在盘上。
 * 3. **换盘检测**：账本里的 `fingerprint` 与本次 `fingerprint` 不相等（比较函数可注入）
 *    ⇒ 返回 `disk-swapped`，**一个字节都不写**。默认 fail-closed：宿主必须显式报错、
 *    让作者决定，不许静默复用旧槽（换盘/换汉化后变量表语义可能整体改变）。
 *
 * ## 端口语义（注入，不 import kernel）
 *
 * `read(key)`：没有这个键 → `null`（**不是**空串、**不是**抛错）；读不动 → 抛错。
 * `write(key, text)` / `remove(key)`：失败 → 抛错；成功返回 undefined。
 *
 * 真实现由宿主包 `kernel.storage`：那里是**异步 + JSON 值**的域（`ScopedStorage.get/set`），
 * 与本模块的同步纯文本端口之间需要一层「项目打开时水合、写操作排队」的适配（见批次回报的
 * wiring 请求）。本文件刻意不认识 kernel，保证纯 TS、零 React/DOM/Monaco、失败路径可假端口覆盖。
 *
 * ## 失败面（全部可判别，不静默）
 *
 * - `busy`：同一 persister 上重入 `commit`（同步端口下唯一的「并发」形态）——拒绝，不写。
 * - `invalid-input`：`fingerprint` 空 / 时钟返回非法值 / 参数形状不对。
 * - `port-error`：读正式账本时端口抛错（读不动 ≠ 不存在，不能当首启）。
 * - `corrupt-ledger`：盘上是坏 JSON 或形状非法（`slots` 不是对象 / 空槽名 / `__proto__` …）。
 * - `version-unsupported`：账本版本不是本层认识的版本——**绝不在未知格式上继续写**。
 * - `disk-swapped`：指纹变了，fail-closed。
 * - `plan-not-ok`：注册表自己的槽位规划失败（换盘/改型/区段…），带 core 失败明细与码。
 * - `fingerprint-mismatch`：注册表是按另一个指纹装配的（脏注册表），拒绝落账。
 * - `slot-moved`：**已存在**的声明键在本次派生里换了槽名——说明注册表不是按旧快照装配的
 *   （或旧快照与账本不同步）；继续落账等于把「搬槽」写成事实，旧存档里那个槽的旧值还在
 *   旧变量名下。默认硬失败，宿主确认要重排时显式 `allowSlotMoves`。
 * - `key-policy-mismatch`：注入的声明键函数与注册表的键口径不一致——账本看着稳定、
 *   实际会搬槽，这是最隐蔽的写坏存档形态，必须硬失败。
 * - `invalid-registry`：注册表结构不成立（槽位缺失 / 键重复 / 注入函数抛错）。
 * - `commit-failed`：写/读回/清理某一步失败，带 `phase` 与 `rollback` 报告。
 */

import type { Kojo2StorageRegistry, Kojo2StorageSymbol } from './kojo2-storage-registry';

/* ============================== 常量与账本模型 ============================== */

/** 账本格式版本（唯一落盘形态；版本不符一律 fail-closed） */
export const KOJO2_STORAGE_LEDGER_VERSION = 1 as const;

/**
 * 正式账本键的缺省值。
 *
 * 注意：kernel storage 的全局域是**应用级**的，而槽位账本是**项目级**事实。宿主接线时
 * 必须把它换成项目作用域的键（例如 `kojo2.storage.ledger.<projectKey>`），否则换项目会
 * 串账。`pendingKey` 缺省会由 `ledgerKey + '.pending'` 派生。
 */
export const KOJO2_STORAGE_LEDGER_KEY = 'kojo2.storage.ledger';

/** 两阶段提交里暂存键的缺省值（与正式键成对；宿主同样要按项目隔离） */
export const KOJO2_STORAGE_PENDING_KEY = 'kojo2.storage.ledger.pending';

/** pending 文档自身的版本（与账本版本分开演进；目前只写不读，留给崩溃取证） */
export const KOJO2_STORAGE_PENDING_VERSION = 1 as const;

/** 槽位所属的存储期（与 core `KojoVarStorage` 同口径；本层不 import core，用结构联合） */
export type Kojo2StorageSlotStorage = 'scene' | 'save' | 'session';

/** 存储期的确定顺序（落盘/还原都按它，跨构建字节稳定） */
export const KOJO2_STORAGE_CLASS_ORDER: readonly Kojo2StorageSlotStorage[] = Object.freeze([
  'scene',
  'save',
  'session',
]);

/**
 * 一格槽位的**形状事实**（与 core `SlotAssignmentRecord` 同形，本层不 import core）。
 *
 * `valueType` / `arraySize` 是「旧存档里这一格的字节怎么解释」的唯一凭证：
 * 声明改型（整数↔字符串）或改数组长度都必须在下一次装配时被判成 `core/storage/shape-changed`，
 * 而不是拿新形状去读旧字节。
 */
export interface Kojo2StorageRecord {
  /** 槽号（与 `slots[declarationKey]` 里的槽名必须指同一格） */
  readonly slot: number;
  readonly valueType: 'int' | 'string';
  /** 一维数组长度；null = 标量 */
  readonly arraySize: number | null;
}

/** 账本的形状表（键 = 稳定声明键；与 `slots` 键集一致） */
export type Kojo2StorageRecords = Readonly<Record<string, Kojo2StorageRecord>>;

/**
 * 可持久化的槽位账本（**跨构建事实**）。
 *
 * `slots` / `records` 只含 `# 设`；键是稳定声明键，`slots` 值是宿主可读的槽名
 * （缺省 `存储期#槽号`，例如 `save#3`）。场景槽按单元分账，槽名本身不带单元前缀——
 * 槽名是**声明键的注脚**，不是全局唯一 id（声明键才是）。
 */
export interface Kojo2StorageLedger {
  readonly version: typeof KOJO2_STORAGE_LEDGER_VERSION;
  /** 账本所属的游戏指纹（adapter/CSV/ERH/汉化事实；换盘检测的唯一依据） */
  readonly fingerprint: string;
  readonly slots: Readonly<Record<string, string>>;
  /** 槽位形状（additive；旧账本缺失 ⇒ 空表，不视为损坏） */
  readonly records: Kojo2StorageRecords;
  /** 最近一次**内容变化**的 ISO 时间；同键幂等重提不刷新它 */
  readonly updatedAt: string;
}

/** 宿主持久化端口（注入；本模块零 IO、零 kernel import） */
export interface Kojo2StoragePort {
  /** 键不存在 → null；读失败 → 抛错（两者不可混为一谈） */
  read(key: string): string | null;
  write(key: string, text: string): void;
  remove(key: string): void;
}

/** 声明键函数：默认 = 注册表的 `variable.storageKey`（它自己缺省 `uri#行:列`） */
export type Kojo2StorageDeclKeyOf = (symbol: Kojo2StorageSymbol) => string;

/** 槽名函数的入参（宿主可据此加项目/单元前缀） */
export interface Kojo2StorageSlotNameInput {
  readonly key: string;
  readonly storage: Kojo2StorageSlotStorage;
  readonly slot: number;
  readonly symbol: Kojo2StorageSymbol;
}

export type Kojo2StorageSlotNameOf = (input: Kojo2StorageSlotNameInput) => string;

/** 缺省槽名：`存储期#槽号`（可读、可解析、跨构建稳定——不含路径与名字） */
export function kojo2StorageSlotName(
  storage: Kojo2StorageSlotStorage,
  slot: number,
): string {
  return `${storage}#${slot}`;
}

/* ============================== 解析 / 序列化 ============================== */

export type Kojo2StorageLedgerParseResult =
  | { readonly kind: 'ok'; readonly ledger: Kojo2StorageLedger }
  | { readonly kind: 'corrupt'; readonly reason: 'json' | 'shape'; readonly detail: string }
  | { readonly kind: 'version-unsupported'; readonly version: number; readonly expected: number };

/** JSON 里的原型污染键：账本键必须来自我们的键函数，盘上出现这些一律当坏账 */
const UNSAFE_SLOT_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalSlots(slots: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(slots).sort(compareText)) {
    const value = slots[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** 形状表的确定形态：键排序，每格字段序固定（slot → valueType → arraySize） */
function canonicalRecords(records: Kojo2StorageRecords): Record<string, Kojo2StorageRecord> {
  const out: Record<string, Kojo2StorageRecord> = {};
  for (const key of Object.keys(records).sort(compareText)) {
    const record = records[key];
    if (record === undefined) continue;
    out[key] = { slot: record.slot, valueType: record.valueType, arraySize: record.arraySize };
  }
  return out;
}

function freezeLedger(ledger: Kojo2StorageLedger): Kojo2StorageLedger {
  for (const key of Object.keys(ledger.records)) {
    const record = ledger.records[key];
    if (record !== undefined) Object.freeze(record);
  }
  Object.freeze(ledger.records);
  Object.freeze(ledger.slots);
  return Object.freeze(ledger);
}

/**
 * 落盘形态（键序固定：version → fingerprint → slots（键排序）→ records（键排序）→ updatedAt）。
 *
 * `records` 为空时**整个字段省略**：这样"没有变量"的空账本字节与 batch-4 逐字相同
 * （旧测试的逐字节断言不必改动），也让"旧账本没有 records"与"新账本恰好没有变量"同形。
 */
function ledgerJson(ledger: Kojo2StorageLedger): Record<string, unknown> {
  const records = canonicalRecords(ledger.records);
  return {
    version: ledger.version,
    fingerprint: ledger.fingerprint,
    slots: canonicalSlots(ledger.slots),
    ...(Object.keys(records).length === 0 ? {} : { records }),
    updatedAt: ledger.updatedAt,
  };
}

/** 序列化账本（见 {@link ledgerJson} 的键序与省略规则） */
export function serializeKojo2StorageLedger(ledger: Kojo2StorageLedger): string {
  return JSON.stringify(ledgerJson(ledger));
}

/**
 * 解析账本并做**形状校验**（纯函数，不读盘）。
 *
 * 校验顺序刻意：版本先于其它字段——未来格式即便形状不同，也要给「版本不受支持」这条
 * 可判别错误，而不是含糊的「坏 JSON」。`slots` 的键/值都必须是非空字符串，且拒绝
 * `__proto__` 一类原型污染键（`JSON.parse` 会把它做成自有属性，`Object.keys` 能看见）。
 * `records` **缺席即空表**（旧账本），出现则逐格校验 `slot` / `valueType` / `arraySize`，
 * 并要求它的键集是 `slots` 的子集（两份表不许各说各话）。
 */
export function parseKojo2StorageLedger(text: string): Kojo2StorageLedgerParseResult {
  if (typeof text !== 'string') {
    return { kind: 'corrupt', reason: 'shape', detail: '账本原文不是字符串' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { kind: 'corrupt', reason: 'json', detail: `JSON 解析失败：${errorText(error)}` };
  }
  if (!isRecord(raw)) {
    return { kind: 'corrupt', reason: 'shape', detail: '账本 JSON 顶层必须是对象' };
  }
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { kind: 'corrupt', reason: 'shape', detail: '账本缺少整数 version' };
  }
  if (version !== KOJO2_STORAGE_LEDGER_VERSION) {
    return {
      kind: 'version-unsupported',
      version,
      expected: KOJO2_STORAGE_LEDGER_VERSION,
    };
  }
  const fingerprint = raw.fingerprint;
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    return { kind: 'corrupt', reason: 'shape', detail: '账本 fingerprint 必须是非空字符串' };
  }
  const updatedAt = raw.updatedAt;
  if (typeof updatedAt !== 'string' || updatedAt.length === 0) {
    return { kind: 'corrupt', reason: 'shape', detail: '账本 updatedAt 必须是非空字符串' };
  }
  if (!isRecord(raw.slots)) {
    return { kind: 'corrupt', reason: 'shape', detail: '账本 slots 必须是对象' };
  }
  const slots: Record<string, string> = {};
  for (const key of Object.keys(raw.slots)) {
    if (key.length === 0) {
      return { kind: 'corrupt', reason: 'shape', detail: '账本 slots 不允许空声明键' };
    }
    if (UNSAFE_SLOT_KEYS.has(key)) {
      return {
        kind: 'corrupt',
        reason: 'shape',
        detail: `账本 slots 含原型污染键「${key}」——拒绝把它当成声明键`,
      };
    }
    const value = raw.slots[key];
    if (typeof value !== 'string' || value.length === 0) {
      return {
        kind: 'corrupt',
        reason: 'shape',
        detail: `账本 slots["${key}"] 必须是非空槽名`,
      };
    }
    slots[key] = value;
  }

  /*
   * `records`（additive）：**缺席 = 旧账本 = 空表**（向前兼容，绝不因此判损坏）；
   * 一旦出现就必须逐格合法——形状字段是"旧存档字节怎么解释"的凭证，猜不得。
   */
  const records: Record<string, Kojo2StorageRecord> = {};
  const rawRecords = raw.records;
  if (rawRecords !== undefined) {
    if (!isRecord(rawRecords)) {
      return { kind: 'corrupt', reason: 'shape', detail: '账本 records 必须是对象' };
    }
    for (const key of Object.keys(rawRecords)) {
      if (key.length === 0) {
        return { kind: 'corrupt', reason: 'shape', detail: '账本 records 不允许空声明键' };
      }
      if (UNSAFE_SLOT_KEYS.has(key)) {
        return {
          kind: 'corrupt',
          reason: 'shape',
          detail: `账本 records 含原型污染键「${key}」——拒绝把它当成声明键`,
        };
      }
      if (!Object.prototype.hasOwnProperty.call(slots, key)) {
        return {
          kind: 'corrupt',
          reason: 'shape',
          detail: `账本 records["${key}"] 在 slots 里没有对应槽名——两份表必须同键集`,
        };
      }
      const entry = rawRecords[key];
      if (!isRecord(entry)) {
        return {
          kind: 'corrupt',
          reason: 'shape',
          detail: `账本 records["${key}"] 必须是对象`,
        };
      }
      const slot = entry.slot;
      if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0) {
        return {
          kind: 'corrupt',
          reason: 'shape',
          detail: `账本 records["${key}"].slot 必须是非负整数`,
        };
      }
      const valueType = entry.valueType;
      if (valueType !== 'int' && valueType !== 'string') {
        return {
          kind: 'corrupt',
          reason: 'shape',
          detail: `账本 records["${key}"].valueType 必须是 "int" / "string"`,
        };
      }
      const arraySize = entry.arraySize;
      if (
        arraySize !== null &&
        (typeof arraySize !== 'number' || !Number.isInteger(arraySize) || arraySize < 0)
      ) {
        return {
          kind: 'corrupt',
          reason: 'shape',
          detail: `账本 records["${key}"].arraySize 必须是 null 或非负整数`,
        };
      }
      records[key] = { slot, valueType, arraySize };
    }
  }

  return {
    kind: 'ok',
    ledger: freezeLedger({
      version: KOJO2_STORAGE_LEDGER_VERSION,
      fingerprint,
      slots: Object.freeze(canonicalSlots(slots)),
      records: Object.freeze(canonicalRecords(records)),
      updatedAt,
    }),
  };
}

/* ============================== 提交结果 ============================== */

/** 失败发生在两阶段提交的哪一步（测试与上屏文案共用） */
export type Kojo2StorageCommitPhase =
  | 'read-ledger'
  | 'pending-write'
  | 'pending-verify'
  | 'ledger-write'
  | 'ledger-verify'
  | 'pending-cleanup';

/** 回滚报告：说得出「修了哪一格 / 有没有修成」，绝不把未验证当成功 */
export interface Kojo2StorageRollbackReport {
  /** 是否尝试过任何修复动作（读现状 + 删 pending 也算尝试） */
  readonly attempted: boolean;
  /**
   * 正式键的回滚结果：
   * - `skipped`：读现状发现它本来就是旧值（例：写失败发生在落笔之前），无需修；
   * - `restored`：已写回旧文本并回读验证一致；
   * - `removed`：旧账本本不存在，已删掉新键并回读验证为空；
   * - `failed`：修复动作抛错、或修完回读仍不一致。
   */
  readonly ledger: 'skipped' | 'restored' | 'removed' | 'failed';
  /** 回读确认 pending 已清除（没有 pending 也算 true） */
  readonly pendingRemoved: boolean;
  /** 失败/部分成功的细节（全部成功时为 null） */
  readonly detail: string | null;
}

export interface Kojo2StorageCommitSuccess {
  readonly kind: 'committed';
  readonly ok: true;
  readonly ledger: Kojo2StorageLedger;
  readonly previous: Kojo2StorageLedger | null;
  /** `false` = 同键幂等命中：槽位/指纹都与盘上一致，本次**零写**（updatedAt 不刷新） */
  readonly changed: boolean;
  readonly rollback: Kojo2StorageRollbackReport;
}

/** `plan-not-ok` 里的一条 core 失败（从注册表的 `storagePlan.failures` 原样搬运） */
export interface Kojo2StoragePlanFailure {
  readonly kind: string;
  /** core 诊断码（`core/storage/*`）；注册表契约异常时可为空串 */
  readonly code: string;
  readonly message: string;
}

export type Kojo2StorageCommitFailure =
  | { readonly kind: 'busy'; readonly ok: false; readonly detail: string }
  | { readonly kind: 'invalid-input'; readonly ok: false; readonly detail: string }
  | { readonly kind: 'port-error'; readonly ok: false; readonly detail: string }
  | {
      readonly kind: 'corrupt-ledger';
      readonly ok: false;
      readonly reason: 'json' | 'shape';
      readonly detail: string;
    }
  | {
      readonly kind: 'version-unsupported';
      readonly ok: false;
      readonly version: number;
      readonly expected: number;
    }
  | {
      readonly kind: 'disk-swapped';
      readonly ok: false;
      /** 旧账本上的指纹 */
      readonly previous: string;
      /** 本次调用的指纹 */
      readonly current: string;
    }
  | {
      readonly kind: 'plan-not-ok';
      readonly ok: false;
      readonly failures: readonly Kojo2StoragePlanFailure[];
      readonly detail: string;
    }
  | {
      readonly kind: 'fingerprint-mismatch';
      readonly ok: false;
      /** 注册表装配时用的指纹 */
      readonly registryFingerprint: string;
      /** 本次落账的指纹 */
      readonly current: string;
    }
  | {
      readonly kind: 'slot-moved';
      readonly ok: false;
      /** 账本里已存在、但本次派生换槽的声明键 */
      readonly key: string;
      /** 账本里的旧槽名 */
      readonly previous: string;
      /** 本次派生出的新槽名 */
      readonly current: string;
    }
  | {
      readonly kind: 'key-policy-mismatch';
      readonly ok: false;
      /** 注册表算出的键（槽位分配依据） */
      readonly expected: string;
      /** 注入函数算出的键（账本键） */
      readonly actual: string;
      readonly uri: string;
      readonly name: string;
    }
  | { readonly kind: 'invalid-registry'; readonly ok: false; readonly detail: string }
  | {
      readonly kind: 'commit-failed';
      readonly ok: false;
      readonly phase: Kojo2StorageCommitPhase;
      readonly detail: string;
      readonly rollback: Kojo2StorageRollbackReport;
    };

export type Kojo2StorageCommitResult = Kojo2StorageCommitSuccess | Kojo2StorageCommitFailure;

/** 只读账本的结果（接线时在项目打开阶段用；不产生任何写） */
export type Kojo2StorageLedgerReadResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly ledger: Kojo2StorageLedger }
  | {
      readonly kind: 'corrupt';
      readonly reason: 'json' | 'shape';
      readonly detail: string;
      readonly raw: string;
    }
  | {
      readonly kind: 'version-unsupported';
      readonly version: number;
      readonly expected: number;
      readonly raw: string;
    }
  | { readonly kind: 'port-error'; readonly detail: string };

/* ============================== 端口 / persister 契约 ============================== */

export interface Kojo2StoragePersistOptions {
  readonly port: Kojo2StoragePort;
  /** 正式账本键；缺省 {@link KOJO2_STORAGE_LEDGER_KEY}（真项目必须换成项目作用域键） */
  readonly ledgerKey?: string;
  /** 暂存键；缺省 `<ledgerKey>.pending`（与正式键必须不同） */
  readonly pendingKey?: string;
  /** 声明键函数；缺省 `symbol.variable.storageKey`（必须与注册表口径一致，否则硬失败） */
  readonly declarationKey?: Kojo2StorageDeclKeyOf;
  /** 槽名函数；缺省 {@link kojo2StorageSlotName} */
  readonly slotNameOf?: Kojo2StorageSlotNameOf;
  /** 指纹比较（缺省严格 `===`）；大小写/规范化差异可由宿主注入，但**必须显式** */
  readonly fingerprintEquals?: (a: string, b: string) => boolean;
  /**
   * 是否允许已存在声明键在本次提交里换槽（缺省 false = fail-closed）。
   *
   * 正常接线（注册表按账本对应的旧快照装配）下永远不会发生；打开它只应出现在
   * 「作者确认重排槽位并接受旧存档错位」的显式流程里。
   */
  readonly allowSlotMoves?: boolean;
  /** 时钟（缺省 `new Date().toISOString()`）；注入固定值可让落盘字节可断言 */
  readonly now?: () => string;
}

export interface Kojo2StorageCommitInput {
  /** 已装配好的存储注册表（只能提交 `storagePlan.ok === true` 的那一份） */
  readonly registry: Kojo2StorageRegistry;
  /** 本次构建的游戏指纹（必须与注册表的 `gameFingerprint` 一致） */
  readonly fingerprint: string;
}

export interface Kojo2StoragePersister {
  readonly ledgerKey: string;
  readonly pendingKey: string;
  /** 读已提交账本（不读 pending、不写任何东西） */
  readLedger(): Kojo2StorageLedgerReadResult;
  /** 两阶段提交；同一实例上重入 → `busy`（同步端口下唯一的并发形态） */
  commit(input: Kojo2StorageCommitInput): Kojo2StorageCommitResult;
}

/* ============================== 内部：端口读写 ============================== */

function readRaw(port: Kojo2StoragePort, key: string): string | null {
  const value: unknown = port.read(key);
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new TypeError(`存储端口 read("${key}") 必须返回 string|null（实际 ${typeof value}）`);
  }
  return value;
}

const NO_ROLLBACK: Kojo2StorageRollbackReport = Object.freeze({
  attempted: false,
  ledger: 'skipped',
  pendingRemoved: true,
  detail: null,
});

/**
 * **校验式回滚**：先读正式键的现状，只在它确实偏离旧值时才修；修完再回读验证。
 *
 * 为什么不是「无脑写回旧值」：写失败往往意味着盘/端口本身有毛病，盲写会把一次
 * 「其实没写进去」的失败升级成一次「回滚也失败」的假事故。先读再修能把两种情形
 * 分开报；读不动时才退化为盲修，并在 detail 里明说「无法验证」。
 */
function repairRollback(
  port: Kojo2StoragePort,
  ledgerKey: string,
  pendingKey: string,
  expectedRaw: string | null,
): Kojo2StorageRollbackReport {
  const details: string[] = [];
  let attempted = false;
  let ledgerStatus: Kojo2StorageRollbackReport['ledger'] = 'skipped';

  let currentKnown = false;
  let current: string | null = null;
  try {
    current = readRaw(port, ledgerKey);
    currentKnown = true;
  } catch (error) {
    details.push(`回滚前读正式账本失败：${errorText(error)}（转为盲修，无法验证）`);
  }

  if (!currentKnown || current !== expectedRaw) {
    attempted = true;
    try {
      if (expectedRaw === null) {
        port.remove(ledgerKey);
        ledgerStatus = 'removed';
      } else {
        port.write(ledgerKey, expectedRaw);
        ledgerStatus = 'restored';
      }
    } catch (error) {
      ledgerStatus = 'failed';
      details.push(
        expectedRaw === null
          ? `删除新账本失败：${errorText(error)}`
          : `恢复旧账本失败：${errorText(error)}`,
      );
    }
  }

  if (ledgerStatus === 'restored' || ledgerStatus === 'removed') {
    try {
      const after = readRaw(port, ledgerKey);
      if (after !== expectedRaw) {
        ledgerStatus = 'failed';
        details.push('回滚后回读与旧账本不一致');
      }
    } catch (error) {
      details.push(`回滚后回读失败（无法验证）：${errorText(error)}`);
    }
  }

  // pending 永远尝试清掉：残留的暂存文档虽然不会被下一次提交采信（只读正式键），
  // 但它是「上次没走完」的证据，宿主有权把它当成脏数据看见。
  attempted = true;
  try {
    port.remove(pendingKey);
  } catch (error) {
    details.push(`清除暂存键失败：${errorText(error)}`);
  }
  let pendingRemoved = false;
  try {
    pendingRemoved = readRaw(port, pendingKey) === null;
    if (!pendingRemoved) details.push('暂存键仍有残留（下次提交会覆盖）');
  } catch (error) {
    details.push(`回读暂存键失败（无法验证是否清除）：${errorText(error)}`);
  }

  return Object.freeze({
    attempted,
    ledger: ledgerStatus,
    pendingRemoved,
    detail: details.length === 0 ? null : details.join('；'),
  });
}

/* ============================== 内部：从注册表派生账本 ============================== */

type DeriveResult =
  | {
      readonly kind: 'ok';
      readonly slots: Readonly<Record<string, string>>;
      readonly records: Kojo2StorageRecords;
    }
  | { readonly kind: 'plan-not-ok'; readonly failures: readonly Kojo2StoragePlanFailure[]; readonly detail: string }
  | {
      readonly kind: 'key-policy-mismatch';
      readonly expected: string;
      readonly actual: string;
      readonly uri: string;
      readonly name: string;
    }
  | { readonly kind: 'invalid-registry'; readonly detail: string };

function isStorage(value: unknown): value is Kojo2StorageSlotStorage {
  return value === 'scene' || value === 'save' || value === 'session';
}

function planFailuresOf(registry: Kojo2StorageRegistry): readonly Kojo2StoragePlanFailure[] {
  const failures: unknown = registry.storagePlan.failures;
  if (!Array.isArray(failures)) return Object.freeze([]);
  const out: Kojo2StoragePlanFailure[] = [];
  for (const failure of failures) {
    if (!isRecord(failure)) continue;
    const diagnostic = isRecord(failure.diagnostic) ? failure.diagnostic : {};
    out.push(
      Object.freeze({
        kind: typeof failure.kind === 'string' ? failure.kind : 'unknown',
        code: typeof diagnostic.code === 'string' ? diagnostic.code : '',
        message: typeof failure.message === 'string' ? failure.message : '',
      }),
    );
  }
  return Object.freeze(out);
}

/**
 * 从注册表派生 `声明键 → 槽名` **与形状表**（槽名与形状必须同一次规划、同一次落盘）。
 *
 * 三条硬口径：
 * ① 只认 `storagePlan.ok === true`：规划失败时槽位是占位/不可信值，宁可整笔不落；
 * ② 注入的声明键**必须等于**注册表算出的 `storageKey`：否则账本键与分配键是两套口径，
 *    「看着稳定、实际搬槽」，这是最难查的写坏存档形态（硬失败）；
 * ③ 槽名必须非空：空槽名等于把槽位信息丢了。
 */
function deriveSlots(
  registry: Kojo2StorageRegistry,
  keyOf: Kojo2StorageDeclKeyOf,
  slotNameOf: Kojo2StorageSlotNameOf,
): DeriveResult {
  if (!isRecord(registry)) {
    return { kind: 'invalid-registry', detail: 'registry 必须是对象' };
  }
  const plan: unknown = registry.storagePlan;
  if (!isRecord(plan)) {
    return { kind: 'invalid-registry', detail: 'registry.storagePlan 必须是对象' };
  }
  if (plan.ok !== true) {
    const failures = planFailuresOf(registry);
    const detail =
      failures.length === 0
        ? '槽位规划失败但没有给出失败明细（注册表契约异常）'
        : failures.map((failure) => `${failure.kind}(${failure.code || '无码'})：${failure.message}`).join('；');
    return { kind: 'plan-not-ok', failures, detail };
  }
  if (plan.nextSnapshot === null || plan.nextSnapshot === undefined) {
    return { kind: 'invalid-registry', detail: 'storagePlan.ok 为 true 却没有 nextSnapshot' };
  }
  const symbols: unknown = registry.symbols;
  if (!Array.isArray(symbols)) {
    return { kind: 'invalid-registry', detail: 'registry.symbols 必须是数组' };
  }

  const slots: Record<string, string> = {};
  for (const symbolValue of symbols) {
    if (!isRecord(symbolValue)) {
      return { kind: 'invalid-registry', detail: 'registry.symbols 里有非对象元素' };
    }
    const rawVariable = symbolValue.variable;
    if (rawVariable === undefined) continue; // 表 / 池 / 常量：没有槽位语义
    const variable = isRecord(rawVariable) ? rawVariable : null;
    if (variable === null) {
      return { kind: 'invalid-registry', detail: '符号的 variable 形状非法' };
    }
    const storage = variable.storage;
    if (!isStorage(storage)) {
      return { kind: 'invalid-registry', detail: `符号的存储期非法「${String(storage)}」` };
    }
    const slot = variable.slot;
    if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0) {
      return {
        kind: 'invalid-registry',
        detail: `符号「${String(symbolValue.name)}」没有已分配槽位（slot=${String(slot)}）——规划未完成时不得落账`,
      };
    }
    const registryKey = variable.storageKey;
    if (typeof registryKey !== 'string' || registryKey.length === 0) {
      return {
        kind: 'invalid-registry',
        detail: `符号「${String(symbolValue.name)}」缺少非空 storageKey`,
      };
    }
    const symbol = symbolValue as unknown as Kojo2StorageSymbol;
    let key: string;
    try {
      key = keyOf(symbol);
    } catch (error) {
      return {
        kind: 'invalid-registry',
        detail: `声明键函数抛错（${String(symbolValue.name)}）：${errorText(error)}`,
      };
    }
    if (typeof key !== 'string' || key.length === 0) {
      return {
        kind: 'key-policy-mismatch',
        expected: registryKey,
        actual: typeof key === 'string' ? key : String(key),
        uri: typeof symbolValue.uri === 'string' ? symbolValue.uri : '',
        name: typeof symbolValue.name === 'string' ? symbolValue.name : '',
      };
    }
    if (key !== registryKey) {
      return {
        kind: 'key-policy-mismatch',
        expected: registryKey,
        actual: key,
        uri: typeof symbolValue.uri === 'string' ? symbolValue.uri : '',
        name: typeof symbolValue.name === 'string' ? symbolValue.name : '',
      };
    }
    if (Object.prototype.hasOwnProperty.call(slots, key)) {
      return { kind: 'invalid-registry', detail: `声明键「${key}」被两条声明共用` };
    }
    let slotName: string;
    try {
      slotName = slotNameOf({ key, storage, slot, symbol });
    } catch (error) {
      return {
        kind: 'invalid-registry',
        detail: `槽名函数抛错（${key}）：${errorText(error)}`,
      };
    }
    if (typeof slotName !== 'string' || slotName.length === 0) {
      return { kind: 'invalid-registry', detail: `声明键「${key}」的槽名为空` };
    }
    slots[key] = slotName;
  }

  const derived = deriveRecords(plan.nextSnapshot, slots);
  if (derived.kind !== 'ok') return { kind: 'invalid-registry', detail: derived.detail };
  return {
    kind: 'ok',
    slots: Object.freeze(canonicalSlots(slots)),
    records: derived.records,
  };
}

/**
 * 从 `storagePlan.nextSnapshot.classes` 派生形状表（`声明键 → 形状`）。
 *
 * 为什么从快照派生而不是从符号重新算：快照是 core 分配槽位时**实际落进存档**的那份事实
 * （`valueType` / `arraySize` 已按核心口径归一），账本要与它逐格对齐；重新算就等于在宿主侧
 * 另造一套形状口径，迟早与快照漂移。
 *
 * 三条硬口径：
 * ① 每格 `slot` / `valueType` / `arraySize` 必须合法（`arraySize` 缺席 ≠ 标量，是坏形状）；
 * ② 同一声明键不得跨存储期出现两次（槽号只在类内唯一）；
 * ③ 键集与 `slots` **双向相等**——少一格会让"改型检测"漏判，多一格会让账本自相矛盾。
 */
function deriveRecords(
  snapshot: unknown,
  slots: Readonly<Record<string, string>>,
):
  | { readonly kind: 'ok'; readonly records: Kojo2StorageRecords }
  | { readonly kind: 'invalid-registry'; readonly detail: string } {
  if (!isRecord(snapshot)) {
    return { kind: 'invalid-registry', detail: 'storagePlan.nextSnapshot 必须是对象' };
  }
  const classes = snapshot.classes;
  if (!isRecord(classes)) {
    return { kind: 'invalid-registry', detail: 'storagePlan.nextSnapshot.classes 必须是对象' };
  }
  const records: Record<string, Kojo2StorageRecord> = {};
  for (const storage of KOJO2_STORAGE_CLASS_ORDER) {
    const table = classes[storage];
    if (table === undefined) continue;
    if (!isRecord(table)) {
      return { kind: 'invalid-registry', detail: `nextSnapshot.classes.${storage} 必须是对象` };
    }
    for (const key of Object.keys(table)) {
      if (key.length === 0) {
        return { kind: 'invalid-registry', detail: `nextSnapshot.classes.${storage} 含空声明键` };
      }
      const entry = table[key];
      if (!isRecord(entry)) {
        return {
          kind: 'invalid-registry',
          detail: `nextSnapshot.classes.${storage}["${key}"] 必须是对象`,
        };
      }
      const slot = entry.slot;
      if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0) {
        return {
          kind: 'invalid-registry',
          detail: `nextSnapshot.classes.${storage}["${key}"].slot 必须是非负整数`,
        };
      }
      const valueType = entry.valueType;
      if (valueType !== 'int' && valueType !== 'string') {
        return {
          kind: 'invalid-registry',
          detail: `nextSnapshot.classes.${storage}["${key}"].valueType 必须是 "int" / "string"`,
        };
      }
      const arraySize = entry.arraySize;
      if (
        !(
          arraySize === null ||
          (typeof arraySize === 'number' && Number.isInteger(arraySize) && arraySize >= 0)
        )
      ) {
        return {
          kind: 'invalid-registry',
          detail: `nextSnapshot.classes.${storage}["${key}"].arraySize 必须是 null 或非负整数`,
        };
      }
      if (Object.prototype.hasOwnProperty.call(records, key)) {
        return {
          kind: 'invalid-registry',
          detail: `声明键「${key}」在多个存储期里同时出现——槽号只在类内唯一，账本必须同键唯一`,
        };
      }
      records[key] = Object.freeze({ slot, valueType, arraySize });
    }
  }
  for (const key of Object.keys(records)) {
    if (!Object.prototype.hasOwnProperty.call(slots, key)) {
      return {
        kind: 'invalid-registry',
        detail: `形状表里的「${key}」没有对应槽名——slots 与 nextSnapshot 不是同一次规划`,
      };
    }
  }
  for (const key of Object.keys(slots)) {
    if (!Object.prototype.hasOwnProperty.call(records, key)) {
      return {
        kind: 'invalid-registry',
        detail: `槽位「${key}」缺少形状事实（valueType/arraySize）——没有它就检测不到跨构建改型`,
      };
    }
  }
  return { kind: 'ok', records: Object.freeze(canonicalRecords(records)) };
}

function sameSlots(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || a[key] !== b[key]) return false;
  }
  return true;
}

function sameRecords(a: Kojo2StorageRecords, b: Kojo2StorageRecords): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    const left = a[key];
    const right = b[key];
    if (left === undefined || right === undefined) return false;
    if (
      left.slot !== right.slot ||
      left.valueType !== right.valueType ||
      left.arraySize !== right.arraySize
    ) {
      return false;
    }
  }
  return true;
}

/** pending 文档：新账本 + 旧账本引用（崩溃后可取证；本模块只写不读） */
interface PendingDocument {
  readonly version: typeof KOJO2_STORAGE_PENDING_VERSION;
  readonly kind: 'kojo2-storage-pending';
  readonly ledgerKey: string;
  readonly next: Record<string, unknown>;
  readonly previous: Record<string, unknown> | null;
}

function serializePending(
  ledgerKey: string,
  next: Kojo2StorageLedger,
  previous: Kojo2StorageLedger | null,
): string {
  const document: PendingDocument = {
    version: KOJO2_STORAGE_PENDING_VERSION,
    kind: 'kojo2-storage-pending',
    ledgerKey,
    next: ledgerJson(next),
    previous: previous === null ? null : ledgerJson(previous),
  };
  return JSON.stringify(document);
}

/* ============================== 内部：结果构造 ============================== */

function failBusy(detail: string): Kojo2StorageCommitFailure {
  return Object.freeze({ kind: 'busy', ok: false, detail });
}

function failInvalidInput(detail: string): Kojo2StorageCommitFailure {
  return Object.freeze({ kind: 'invalid-input', ok: false, detail });
}

function failCorrupt(reason: 'json' | 'shape', detail: string): Kojo2StorageCommitFailure {
  return Object.freeze({ kind: 'corrupt-ledger', ok: false, reason, detail });
}

function failVersion(version: number, expected: number): Kojo2StorageCommitFailure {
  return Object.freeze({ kind: 'version-unsupported', ok: false, version, expected });
}

function failPlanNotOk(
  failures: readonly Kojo2StoragePlanFailure[],
  detail: string,
): Kojo2StorageCommitFailure {
  return Object.freeze({ kind: 'plan-not-ok', ok: false, failures, detail });
}

function failKeyPolicy(
  expected: string,
  actual: string,
  uri: string,
  name: string,
): Kojo2StorageCommitFailure {
  return Object.freeze({ kind: 'key-policy-mismatch', ok: false, expected, actual, uri, name });
}

function failInvalidRegistry(detail: string): Kojo2StorageCommitFailure {
  return Object.freeze({ kind: 'invalid-registry', ok: false, detail });
}

function failSlotMoved(
  key: string,
  previous: string,
  current: string,
): Kojo2StorageCommitFailure {
  return Object.freeze({ kind: 'slot-moved', ok: false, key, previous, current });
}

function failCommit(
  phase: Kojo2StorageCommitPhase,
  detail: string,
  rollback: Kojo2StorageRollbackReport,
): Kojo2StorageCommitFailure {
  return Object.freeze({ kind: 'commit-failed', ok: false, phase, detail, rollback });
}

function committed(
  ledger: Kojo2StorageLedger,
  previous: Kojo2StorageLedger | null,
  changed: boolean,
): Kojo2StorageCommitSuccess {
  return Object.freeze({
    kind: 'committed',
    ok: true,
    ledger,
    previous,
    changed,
    rollback: NO_ROLLBACK,
  });
}

/* ============================== 工厂 ============================== */

/**
 * 创建一个槽位账本持久化器（**实例 = 一条串行提交线**）。
 *
 * 同一实例上重入 `commit` 会被判 `busy` 而不是交错写：同步端口下这是唯一的并发形态
 * （宿主若从 `write` 回调里再次触发提交，必定是 bug 或重入状态机，必须硬拒绝）。
 *
 * 配置错误（端口缺方法 / 键为空 / 正式键与暂存键相同）在**创建时**抛 `TypeError`：
 * 这些不是运行期可判别错误，而是接线错误，越早炸越好。
 */
export function createKojo2StoragePersister(
  options: Kojo2StoragePersistOptions,
): Kojo2StoragePersister {
  if (!isRecord(options)) {
    throw new TypeError('Kojo 2.0 槽位账本：createKojo2StoragePersister 需要 options 对象');
  }
  const port = options.port;
  if (
    !isRecord(port) ||
    typeof port.read !== 'function' ||
    typeof port.write !== 'function' ||
    typeof port.remove !== 'function'
  ) {
    throw new TypeError('Kojo 2.0 槽位账本：port 必须实现 read / write / remove');
  }
  const ledgerKey = options.ledgerKey ?? KOJO2_STORAGE_LEDGER_KEY;
  if (typeof ledgerKey !== 'string' || ledgerKey.length === 0) {
    throw new TypeError('Kojo 2.0 槽位账本：ledgerKey 必须是非空字符串');
  }
  const pendingKey =
    options.pendingKey === undefined ? `${ledgerKey}.pending` : options.pendingKey;
  if (typeof pendingKey !== 'string' || pendingKey.length === 0) {
    throw new TypeError('Kojo 2.0 槽位账本：pendingKey 必须是非空字符串');
  }
  if (pendingKey === ledgerKey) {
    throw new TypeError('Kojo 2.0 槽位账本：pendingKey 不能与 ledgerKey 相同（两阶段提交会自吞）');
  }
  const keyOf: Kojo2StorageDeclKeyOf =
    options.declarationKey ??
    ((symbol: Kojo2StorageSymbol): string => symbol.variable?.storageKey ?? '');
  const slotNameOf: Kojo2StorageSlotNameOf =
    options.slotNameOf ??
    ((input: Kojo2StorageSlotNameInput): string => kojo2StorageSlotName(input.storage, input.slot));
  const fingerprintEquals = options.fingerprintEquals ?? ((a: string, b: string): boolean => a === b);
  const allowSlotMoves = options.allowSlotMoves === true;
  const now = options.now ?? ((): string => new Date().toISOString());

  let inFlight = false;

  function readLedger(): Kojo2StorageLedgerReadResult {
    let raw: string | null;
    try {
      raw = readRaw(port, ledgerKey);
    } catch (error) {
      return Object.freeze({ kind: 'port-error', detail: errorText(error) });
    }
    if (raw === null) return Object.freeze({ kind: 'absent' });
    const parsed = parseKojo2StorageLedger(raw);
    if (parsed.kind === 'corrupt') {
      return Object.freeze({
        kind: 'corrupt',
        reason: parsed.reason,
        detail: parsed.detail,
        raw,
      });
    }
    if (parsed.kind === 'version-unsupported') {
      return Object.freeze({
        kind: 'version-unsupported',
        version: parsed.version,
        expected: parsed.expected,
        raw,
      });
    }
    return Object.freeze({ kind: 'ok', ledger: parsed.ledger });
  }

  function commit(input: Kojo2StorageCommitInput): Kojo2StorageCommitResult {
    if (inFlight) {
      return failBusy(
        '同一账本持久化器上发生了重入 commit（同步端口下即并发）——已拒绝，本次一个字节都没写',
      );
    }
    inFlight = true;
    try {
      return runCommit(input);
    } finally {
      inFlight = false;
    }
  }

  function runCommit(input: Kojo2StorageCommitInput): Kojo2StorageCommitResult {
    if (!isRecord(input)) return failInvalidInput('commit 需要 { registry, fingerprint }');
    const fingerprint: unknown = input.fingerprint;
    if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
      return failInvalidInput('fingerprint 必须是非空字符串（换盘检测的唯一依据）');
    }
    const registry: unknown = input.registry;
    if (!isRecord(registry)) return failInvalidInput('registry 必须是存储注册表对象');

    /* ---------- ① 读旧账本：坏账/未知版本/读不动一律 fail-closed ---------- */

    let previousRaw: string | null;
    try {
      previousRaw = readRaw(port, ledgerKey);
    } catch (error) {
      return Object.freeze({
        kind: 'port-error',
        ok: false,
        detail: `读正式账本失败：${errorText(error)}（读不动 ≠ 首启，拒绝覆盖）`,
      });
    }

    let previous: Kojo2StorageLedger | null = null;
    if (previousRaw !== null) {
      const parsed = parseKojo2StorageLedger(previousRaw);
      if (parsed.kind === 'corrupt') return failCorrupt(parsed.reason, parsed.detail);
      if (parsed.kind === 'version-unsupported') {
        return failVersion(parsed.version, parsed.expected);
      }
      previous = parsed.ledger;
    }

    /* ---------- ② 换盘检测：先于一切分配/写入，fail-closed ---------- */

    if (previous !== null && !fingerprintEquals(previous.fingerprint, fingerprint)) {
      return Object.freeze({
        kind: 'disk-swapped',
        ok: false,
        previous: previous.fingerprint,
        current: fingerprint,
      });
    }

    /* ---------- ③ 从注册表派生账本内容（规划失败/键口径不一致都不写） ---------- */

    const derived = deriveSlots(
      registry as unknown as Kojo2StorageRegistry,
      keyOf,
      slotNameOf,
    );
    if (derived.kind === 'plan-not-ok') {
      return failPlanNotOk(derived.failures, derived.detail);
    }
    if (derived.kind === 'key-policy-mismatch') {
      return failKeyPolicy(derived.expected, derived.actual, derived.uri, derived.name);
    }
    if (derived.kind === 'invalid-registry') {
      return failInvalidRegistry(derived.detail);
    }

    const registryRecord = registry as unknown as Kojo2StorageRegistry;
    const registrySnapshot = registryRecord.storagePlan.nextSnapshot as unknown;
    if (!isRecord(registrySnapshot) || typeof registrySnapshot.gameFingerprint !== 'string') {
      return Object.freeze({
        kind: 'invalid-registry',
        ok: false,
        detail: 'storagePlan.nextSnapshot 缺少 gameFingerprint',
      });
    }
    if (registrySnapshot.gameFingerprint !== fingerprint) {
      return Object.freeze({
        kind: 'fingerprint-mismatch',
        ok: false,
        registryFingerprint: registrySnapshot.gameFingerprint,
        current: fingerprint,
      });
    }

    /* ---------- ④ 旧声明不许换槽：缺旧快照/账本不同步时硬失败 ---------- */

    if (!allowSlotMoves && previous !== null) {
      for (const key of Object.keys(previous.slots)) {
        if (!Object.prototype.hasOwnProperty.call(derived.slots, key)) continue;
        const prior = previous.slots[key];
        const current = derived.slots[key];
        if (prior !== undefined && current !== undefined && prior !== current) {
          return failSlotMoved(key, prior, current);
        }
      }
    }

    /* ---------- ⑤ 同键幂等：槽位**与形状**都一致 → 零写，updatedAt 不刷新 ---------- */

    if (
      previous !== null &&
      sameSlots(previous.slots, derived.slots) &&
      sameRecords(previous.records, derived.records)
    ) {
      return committed(previous, previous, false);
    }

    let updatedAt: string;
    try {
      updatedAt = now();
    } catch (error) {
      return failInvalidInput(`时钟抛错：${errorText(error)}`);
    }
    if (typeof updatedAt !== 'string' || updatedAt.length === 0) {
      return failInvalidInput('时钟必须返回非空 ISO 时间字符串');
    }

    const next: Kojo2StorageLedger = freezeLedger({
      version: KOJO2_STORAGE_LEDGER_VERSION,
      fingerprint,
      slots: derived.slots,
      records: derived.records,
      updatedAt,
    });
    const nextText = serializeKojo2StorageLedger(next);
    const pendingText = serializePending(ledgerKey, next, previous);

    /* ---------- ⑥ 两阶段提交：pending 落盘 → 回读逐字节校验 ---------- */

    try {
      port.write(pendingKey, pendingText);
    } catch (error) {
      return failCommit(
        'pending-write',
        `写暂存账本失败：${errorText(error)}`,
        repairRollback(port, ledgerKey, pendingKey, previousRaw),
      );
    }

    let pendingReadBack: string | null;
    try {
      pendingReadBack = readRaw(port, pendingKey);
    } catch (error) {
      return failCommit(
        'pending-verify',
        `暂存账本回读失败：${errorText(error)}`,
        repairRollback(port, ledgerKey, pendingKey, previousRaw),
      );
    }
    if (pendingReadBack !== pendingText) {
      return failCommit(
        'pending-verify',
        `暂存账本回读不一致（期望 ${pendingText.length} 字符，实际 ${
          pendingReadBack === null ? '缺失' : `${pendingReadBack.length} 字符`
        }）——拒绝把未验证的账本写正式键`,
        repairRollback(port, ledgerKey, pendingKey, previousRaw),
      );
    }

    /* ---------- ⑦ 正式键落盘 → 再回读一次（写坏存档的最后一道闸） ---------- */

    try {
      port.write(ledgerKey, nextText);
    } catch (error) {
      return failCommit(
        'ledger-write',
        `写正式账本失败：${errorText(error)}`,
        repairRollback(port, ledgerKey, pendingKey, previousRaw),
      );
    }

    let ledgerReadBack: string | null;
    try {
      ledgerReadBack = readRaw(port, ledgerKey);
    } catch (error) {
      return failCommit(
        'ledger-verify',
        `正式账本回读失败：${errorText(error)}`,
        repairRollback(port, ledgerKey, pendingKey, previousRaw),
      );
    }
    if (ledgerReadBack !== nextText) {
      return failCommit(
        'ledger-verify',
        `正式账本回读不一致（期望 ${nextText.length} 字符，实际 ${
          ledgerReadBack === null ? '缺失' : `${ledgerReadBack.length} 字符`
        }）`,
        repairRollback(port, ledgerKey, pendingKey, previousRaw),
      );
    }

    /* ---------- ⑧ 清理 pending：清不掉也算失败，回滚正式键（不留半批） ---------- */

    try {
      port.remove(pendingKey);
    } catch (error) {
      return failCommit(
        'pending-cleanup',
        `清除暂存账本失败：${errorText(error)}——正式键已回滚，绝不留下「暂存已删/正式已改」的半批`,
        repairRollback(port, ledgerKey, pendingKey, previousRaw),
      );
    }

    return committed(next, previous, true);
  }

  return Object.freeze({
    ledgerKey,
    pendingKey,
    readLedger,
    commit,
  });
}
