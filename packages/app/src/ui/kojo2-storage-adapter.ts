/**
 * Kojo 2.0 槽位账本的**宿主适配层**（K2-STORAGE-HOST-FULL）：
 * 把 `kernel.storage.global()` 那种**异步 + JSON 值**的域，接到
 * `kojo2-storage-persist.ts` 的**同步纯文本端口**上，并且把账本里的形状事实
 * （`records`）还原成 core 的 `storagePlan.previousSnapshot`。
 *
 * ## 为什么必须单独一层
 *
 * 下面三件事在 batch-4 的持久化模块里**做不了**，因为它们都要求「与盘对话」：
 *
 * 1. **水合 + 镜像**：持久化模块的 `commit` 是同步的（两阶段提交的时序判据全靠同步端口），
 *    而 kernel 存储是 `Promise` 的。本层在项目打开时一次性 `storage.get(ledgerKey)` 把账本文本
 *    读进内存镜像；之后同步端口只读写镜像，所有写操作进**串行队列**异步落盘。
 * 2. **项目隔离**：kernel 全局域是应用级的，账本是项目级事实。键由 `projectKey` 的稳定 hash
 *    派生（`kojo2.storage.ledger.<hash>`），**绝不直接拼项目路径**（路径含空格/`..`/大小写差异，
 *    既过不了 kernel 的 `SAFE_SEGMENT`，也会把两个项目串成一笔账）。
 * 3. **previousSnapshot 持久化**：core 的 `SlotRegistrySnapshot.classes` 带着每格
 *    `valueType` / `arraySize`，是「跨构建改型必须 fail-closed」的唯一凭证。batch-4 的账本只有
 *    `slotName`，反哺不回注册表——本层让持久化模块把 `nextSnapshot` 的形状一并写进账本
 *    `records`（**同一次两阶段提交**，不额外写第二趟），再从 `records` 还原快照。
 *
 * ## 时序（宿主接线照这个顺序）
 *
 * ```
 * const host = createKojo2StorageHost({ storage: kernel.storage.global(), projectKey });
 * const hydration = await host.hydrate();                 // ① 读盘 → 镜像
 * const previous  = host.loadPreviousSnapshot();           // ② records → previousSnapshot
 * const registry  = createKojo2StorageRegistry({
 *   documents, storageClasses, gameFingerprint,
 *   previousSnapshot: previous.kind === 'ok' ? previous.snapshot : null,
 * });
 * const result    = host.commit({ registry, fingerprint: gameFingerprint });  // ③ 两阶段提交（内存镜像）
 * const flushed   = await host.flush();                    // ④ 等队列真正落盘；失败在这里可见
 * ```
 *
 * ①必须成功（`ok` / `absent`）才能 `commit`：未水合时 `commit` 返回 `not-hydrated` 而不是
 * 把「没读过盘」当成「首启」去覆盖一份已经存在的账本。③ 是同步的（两阶段提交的每一步回读
 * 都发生在镜像上），④ 才是「盘上到底写成了没有」的判据。
 *
 * ## 失败面（全部可判别，绝不静默）
 *
 * - `not-hydrated`：未 `hydrate()` 就读/提交/还原。
 * - `port-error`：`storage.get/set/delete` 抛错（读不动 ≠ 不存在）。**正式账本**那一格写盘失败
 *   且没被成功的重写覆盖时，`hydrate()` 同样报 `port-error` 并**拒绝以盘为准覆盖内存镜像**
 *   （否则会静默丢掉刚提交的那一笔）；暂存键等别的键写失败不挡水合（盘上账本没停旧版本）。
 * - `corrupt`：盘上的账本 JSON 坏了 / 值不是本层写入的字符串 / 形状非法 / 版本不受支持。
 * - `recycled-slots`：本次装配回收了槽位（见下），默认零写阻断。
 * - `busy`：同一 host 上重入 `commit`（含注册表 getter 里再触发提交这种病态接线）。
 * - 持久化模块的全部失败（`disk-swapped` / `slot-moved` / `plan-not-ok` / `commit-failed` …）
 *   原样透传，本层不重写它们的码与语义。
 *
 * ## `recycled` 拦截：为什么默认拒绝
 *
 * 「回收」= 旧声明被删/换键，它空出的槽被本次新声明拿走。槽号一旦和存档字节绑定，
 * **那个槽里躺着的还是旧声明的值**：新声明第一次读档就会读到旧剧情/旧数值（等于跨变量
 * 串档），而账本本身完全合法、没有任何诊断。所以本层在落账前检查
 * `registry.storagePlan.recycled.length > 0` ⇒ 默认 `recycled-slots` 零写阻断；
 * 只有作者显式确认「接受旧档错位」并传入 `allowRecycledSlots: true` 才放行。
 *
 * ## 失败上屏映射
 *
 * `kojo2StorageProblemOf(result)` 是纯函数：宿主码一律 `kojo2/storage-host/*`，
 * **绝不伪造 `core/storage/*`**。core 的诊断码仍然只从 `registry.diagnostics` 原样透传
 * （问题面板那一侧照旧读注册表；本函数只负责「账本/队列这一层自己的事」该怎么说）。
 *
 * ## 本层不 import kernel
 *
 * `storage` 用**结构化类型**（`get` / `set` / `delete`，可选 `entry` / `keys`）接收，
 * 真实 `ScopedStorage` 结构上直接满足；单测用内存假实现，不拉 Tauri / Node FS。
 * 额外识别可选的 `entry()`（kernel PS-2 的显式三态）：有它就能把「盘上 JSON 坏了」
 * 与「从没写过」分开；没有它则只有 `get()`（kernel 把坏 JSON 投影成 `undefined`，
 * 那种情况下本层会看到 `absent`——这是契约层面的已知折损，已在测试里钉住）。
 */

import { SLOT_SNAPSHOT_VERSION } from '@kojo/kojo-core';
import type { SlotAssignmentRecord, SlotRegistrySnapshot } from '@kojo/kojo-core';
import {
  KOJO2_STORAGE_CLASS_ORDER,
  createKojo2StoragePersister,
  parseKojo2StorageLedger,
  type Kojo2StorageCommitInput,
  type Kojo2StorageCommitResult,
  type Kojo2StorageLedger,
  type Kojo2StoragePersister,
  type Kojo2StoragePort,
  type Kojo2StorageSlotStorage,
} from './kojo2-storage-persist';

/* ============================== 键与项目 hash ============================== */

/** 项目账本键前缀（后面接项目 hash；宿主可用 `host.ledgerKey` 核对实际键） */
export const KOJO2_STORAGE_HOST_LEDGER_PREFIX = 'kojo2.storage.ledger.';

/** 内置 hash 的输出长度（16 位十六进制 = 64 bit；只用于**隔离**，不是加密摘要） */
export const KOJO2_STORAGE_HOST_HASH_LENGTH = 16;

/**
 * 项目键 → 稳定 hash（**内置实现，跨平台/跨进程逐字稳定**）。
 *
 * 两条流（FNV-1a 32 与表驱动混合）拼成 64 bit 十六进制：两个不同项目键撞同一把账本的概率
 * 在工程上可忽略，而同一个键无论从哪个路径写法来（只要字符串相等）都落在同一格。
 * 只吃 UTF-16 码元、不做大小写/分隔符归一——**归一化是宿主的事**（`projectKey` 传什么就隔离什么，
 * 本层不猜"这两个写法是不是同一个项目"）。注入 `hash` 可替换本实现（例如宿主已有稳定 id）。
 */
export function kojo2StorageProjectHash(projectKey: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < projectKey.length; index += 1) {
    const code = projectKey.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ (code + index), 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  a = Math.imul(a ^ projectKey.length, 0x01000193) >>> 0;
  b = Math.imul(b ^ projectKey.length, 0xc2b2ae35) >>> 0;
  return `${hex8(a)}${hex8(b)}`;
}

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/** kernel `SAFE_SEGMENT` 的等价判据（本层不 import kernel，用同一口径本地校验） */
const SAFE_STORAGE_KEY = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/u;

function assertSafeStorageKey(key: string): void {
  if (!SAFE_STORAGE_KEY.test(key) || key.includes('..')) {
    throw new TypeError(
      `Kojo 2.0 槽位宿主：派生的账本键「${key}」不是合法存储键` +
        '（只允许 [A-Za-z0-9_][A-Za-z0-9._-]{0,119}，且不能含 ".."）——检查注入了什么 hash',
    );
  }
}

/* ============================== 端口（结构化类型，不 import kernel） ============================== */

/**
 * kernel 存储的**显式三态读**（kernel `ScopedStorageImpl.entry` 的同形端口；可选）。
 *
 * 有它就分得清 `missing`（首启）与 `corrupt`（盘上站着一份坏 JSON）——kernel 的 `get`
 * 把后者投影成 `undefined`，那会让本层把坏账当成首启覆盖掉。
 */
export type Kojo2StorageHostEntryState =
  | { readonly state: 'missing' }
  | { readonly state: 'corrupt'; readonly detail: string }
  | { readonly state: 'ok'; readonly value: unknown };

/**
 * 本层需要的存储端口（`kernel.storage.global()` 的 `ScopedStorage` 结构上满足）。
 *
 * 语义：`get` 在该键不存在时返回 `undefined`；读不动则抛错（读不动 ≠ 不存在）。
 * `set` 的 `value` 在 kernel 侧会被 `JSON.stringify`，本层只写字符串。
 */
export interface Kojo2StorageHostStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** 可选：显式三态读（kernel 有；假端口可省略） */
  entry?(key: string): Promise<Kojo2StorageHostEntryState>;
  /** 可选：列键（本层目前不用，留给宿主做体检） */
  keys?(): Promise<string[]>;
}

/* ============================== 宿主契约 ============================== */

export interface Kojo2StorageHostOptions {
  /** kernel 存储端口（结构化类型；见 {@link Kojo2StorageHostStorage}） */
  readonly storage: Kojo2StorageHostStorage;
  /** 项目键（决定账本落在哪个键；见 {@link kojo2StorageProjectHash}） */
  readonly projectKey: string;
  /** 时钟（缺省 `new Date().toISOString()`；注入固定值可让落盘字节可断言） */
  readonly now?: () => string;
  /** 项目键 → hash（缺省 {@link kojo2StorageProjectHash}；返回值必须能拼成合法存储键） */
  readonly hash?: (projectKey: string) => string;
  /**
   * 是否放行**槽位回收**（缺省 false = 零写阻断）。
   *
   * 打开它等于承认「被回收槽里的旧存档字节会被新声明读到」；只在作者确认重排、
   * 且接受旧档错位时显式传入。
   */
  readonly allowRecycledSlots?: boolean;
  /** 透传持久化模块的 `allowSlotMoves`（缺省 false；同为「作者确认重排」的显式开关） */
  readonly allowSlotMoves?: boolean;
}

/** 一条被回收的槽位（core `RecycledSlot` 的结构化镜像） */
export interface Kojo2StorageRecycledEntry {
  readonly storage: Kojo2StorageSlotStorage;
  readonly slot: number;
  /** 旧槽的拥有者声明键（本次被判定为删除/换键） */
  readonly previousKey: string;
  /** 新占用者声明键 */
  readonly nextKey: string;
}

/** 队列里的写盘失败（**不毒化后续**：只记账，后续操作照跑） */
export interface Kojo2StorageHostQueueFailure {
  readonly kind: 'write-failed' | 'remove-failed';
  readonly key: string;
  readonly detail: string;
}

export interface Kojo2StorageHostFlushResult {
  /** `true` = 自上次 flush 以来没有写盘失败 */
  readonly ok: boolean;
  /**
   * 自上次 flush 以来的失败（返回即清账，避免一次旧失败永远遮住后来的成功）。
   * 失败是**如实上报**的：内存镜像已经更新，盘上可能还是旧账本。
   */
  readonly failures: readonly Kojo2StorageHostQueueFailure[];
}

/** 只读账本的结果（`not-hydrated` = 还没读过盘，不等于「没有账本」） */
export type Kojo2StorageHostLedgerReadResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly ledger: Kojo2StorageLedger }
  | {
      readonly kind: 'corrupt';
      readonly reason: 'json' | 'shape';
      readonly detail: string;
      /** 盘上的原文；kernel 级坏 JSON（`entry` 报 corrupt）时为 null */
      readonly raw: string | null;
    }
  | {
      readonly kind: 'version-unsupported';
      readonly version: number;
      readonly expected: number;
      readonly raw: string | null;
    }
  | { readonly kind: 'port-error'; readonly detail: string }
  | { readonly kind: 'not-hydrated'; readonly detail: string };

/** `previousSnapshot` 还原失败的成因（全部显式，绝不静默重置成首启） */
export type Kojo2StorageHostSnapshotProblem =
  | 'corrupt'
  | 'version-unsupported'
  | 'port-error'
  | 'slot-name'
  | 'inconsistent';

export type Kojo2StorageHostPreviousSnapshotResult =
  | {
      readonly kind: 'ok';
      readonly snapshot: SlotRegistrySnapshot;
      readonly ledger: Kojo2StorageLedger;
    }
  | {
      readonly kind: 'absent';
      /** `no-ledger` = 首启；`no-records` = 旧账本/空工程（有槽位账但没有形状事实） */
      readonly reason: 'no-ledger' | 'no-records';
      readonly detail: string;
    }
  | {
      readonly kind: 'invalid';
      readonly reason: Kojo2StorageHostSnapshotProblem;
      readonly detail: string;
    }
  | { readonly kind: 'not-hydrated'; readonly detail: string };

/** 本层独有的提交失败（与持久化模块的失败并列；`kind` 不重叠） */
export interface Kojo2StorageHostRecycledFailure {
  readonly kind: 'recycled-slots';
  readonly ok: false;
  readonly entries: readonly Kojo2StorageRecycledEntry[];
  /** 装配里报出的回收条数（含形状非法、无法逐条呈现的那些） */
  readonly total: number;
  readonly detail: string;
}

export interface Kojo2StorageHostNotHydratedFailure {
  readonly kind: 'not-hydrated';
  readonly ok: false;
  readonly detail: string;
}

export type Kojo2StorageHostCommitResult =
  | Kojo2StorageCommitResult
  | Kojo2StorageHostRecycledFailure
  | Kojo2StorageHostNotHydratedFailure;

/**
 * 槽位宿主：**一个实例 = 一个项目 + 一条串行写队列**。
 *
 * 换项目必须换实例（`projectKey` 在建实例时定死；账本键、镜像、队列都跟着它走）。
 */
export interface Kojo2StorageHost {
  /** 实际使用的账本键（`kojo2.storage.ledger.<hash>`；接线自检用） */
  readonly ledgerKey: string;
  /** 两阶段提交的暂存键（`<ledgerKey>.pending`） */
  readonly pendingKey: string;
  readonly projectKey: string;
  /**
   * 从存储水合内存镜像（**异步**；等待此前排队的写操作落盘）。
   *
   * 成功（`ok` / `absent`）后 `commit` 才被允许；`port-error` / `corrupt` 时 `commit`
   * 一律拒绝（不覆盖读不动或读不懂的账本）。
   */
  hydrate(): Promise<Kojo2StorageHostLedgerReadResult>;
  /** 读镜像里的已提交账本（同步、零 IO；未水合 → `not-hydrated`） */
  readLedger(): Kojo2StorageHostLedgerReadResult;
  /** 从账本 `records` 还原 core `previousSnapshot`（同步；未水合/坏形状 → 显式错误） */
  loadPreviousSnapshot(): Kojo2StorageHostPreviousSnapshotResult;
  /** 两阶段提交（同步，写内存镜像 + 入队）；成功后 `await flush()` 才是盘上判据 */
  commit(input: Kojo2StorageCommitInput): Kojo2StorageHostCommitResult;
  /** 等队列排空；返回自上次 flush 以来的写盘失败 */
  flush(): Promise<Kojo2StorageHostFlushResult>;
}

/* ============================== 内部工具 ============================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 缺省槽名（持久化模块的缺省口径）：`存储期#槽号` */
const CANONICAL_SLOT_NAME = /^(scene|save|session)#(0|[1-9]\d{0,8})$/u;

function parseCanonicalSlotName(
  slotName: string,
): { readonly storage: Kojo2StorageSlotStorage; readonly slot: number } | null {
  const match = CANONICAL_SLOT_NAME.exec(slotName);
  if (match === null) return null;
  const storage = match[1];
  const slotText = match[2];
  if (storage === undefined || slotText === undefined) return null;
  if (storage !== 'scene' && storage !== 'save' && storage !== 'session') return null;
  const slot = Number(slotText);
  if (!Number.isSafeInteger(slot) || slot < 0) return null;
  return { storage, slot };
}

type LedgerTextRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'corrupt'; readonly reason: 'json' | 'shape'; readonly detail: string }
  | { readonly kind: 'text'; readonly text: string };

/** `get()` 的返回值 → 账本文本：只认字符串（别把别人的 JSON 形状当账本猜） */
function coerceLedgerText(value: unknown): LedgerTextRead {
  if (value === undefined) return { kind: 'missing' };
  if (typeof value === 'string') return { kind: 'text', text: value };
  const actual = value === null ? 'null' : typeof value;
  return {
    kind: 'corrupt',
    reason: 'shape',
    detail: `存储里的账本值不是字符串（实际 ${actual}）——本层只认自己写入的 JSON 文本，拒绝猜`,
  };
}

function freezeRead(result: Kojo2StorageHostLedgerReadResult): Kojo2StorageHostLedgerReadResult {
  return Object.freeze(result);
}

function freezePrevious(
  result: Kojo2StorageHostPreviousSnapshotResult,
): Kojo2StorageHostPreviousSnapshotResult {
  return Object.freeze(result);
}

const NO_RECYCLED: readonly Kojo2StorageRecycledEntry[] = Object.freeze([]);

/* ============================== 工厂 ============================== */

/**
 * 创建槽位宿主（一个实例 = 一个项目的账本 + 一条串行写队列）。
 *
 * 配置错误在**创建时**抛 `TypeError`（端口缺方法 / `projectKey` 为空 / hash 抛错或返回非法键）：
 * 这些是接线错误，越早炸越好，不能等到第一次提交才发现账本写到了别的键上。
 */
export function createKojo2StorageHost(options: Kojo2StorageHostOptions): Kojo2StorageHost {
  if (!isRecord(options)) {
    throw new TypeError('Kojo 2.0 槽位宿主：createKojo2StorageHost 需要 options 对象');
  }
  const storage = options.storage;
  if (
    !isRecord(storage) ||
    typeof storage.get !== 'function' ||
    typeof storage.set !== 'function' ||
    typeof storage.delete !== 'function'
  ) {
    throw new TypeError('Kojo 2.0 槽位宿主：storage 必须实现 get / set / delete');
  }
  const projectKey = options.projectKey;
  if (typeof projectKey !== 'string' || projectKey.length === 0) {
    throw new TypeError(
      'Kojo 2.0 槽位宿主：projectKey 必须是非空字符串（账本按项目隔离的唯一依据）',
    );
  }
  const hash = options.hash ?? kojo2StorageProjectHash;
  let suffix: string;
  try {
    suffix = hash(projectKey);
  } catch (error) {
    throw new TypeError(`Kojo 2.0 槽位宿主：项目 hash 抛错：${errorText(error)}`);
  }
  if (typeof suffix !== 'string' || suffix.length === 0) {
    throw new TypeError('Kojo 2.0 槽位宿主：项目 hash 必须返回非空字符串');
  }
  const ledgerKey = `${KOJO2_STORAGE_HOST_LEDGER_PREFIX}${suffix}`;
  assertSafeStorageKey(ledgerKey);

  const allowRecycledSlots = options.allowRecycledSlots === true;
  const now = options.now;

  /* ---------- 镜像 + 串行队列 ---------- */

  interface QueueTask {
    readonly op: 'write' | 'remove';
    readonly key: string;
    /** 仅 `op === 'write'` 时有意义 */
    readonly text: string;
  }

  const mirror = new Map<string, string>();
  const queue: QueueTask[] = [];
  const queueFailures: Kojo2StorageHostQueueFailure[] = [];
  let drain: Promise<void> | null = null;
  /**
   * 「正式账本这一格写盘失败且之后没有被成功的同名写入覆盖」——水合闸门。
   *
   * 只认 `ledgerKey`：暂存键/别的键写失败不会让盘上账本停在旧版本，重读一遍是安全的；
   * 而正式账本写失败时**盘比内存旧**，此时若照常 `hydrate()` 就会把刚提交的那一笔静默丢掉。
   */
  let ledgerWriteFailed: string | null = null;

  function noteSuccess(key: string): void {
    if (key === ledgerKey && ledgerWriteFailed !== null) ledgerWriteFailed = null;
  }

  function noteFailure(key: string, detail: string): void {
    if (key === ledgerKey) ledgerWriteFailed = detail;
  }

  function enqueue(task: QueueTask): void {
    queue.push(task);
    pump();
  }

  /**
   * 串行泵：队头逐个 await，失败只记账（后续任务照跑）。
   *
   * 为什么失败不能毒化队列：一次 `set` 失败（磁盘满 / 瞬时 IO 错）之后，下一次提交的两阶段
   * 提交仍然要能写、能回读——把队列卡死等于让整个存储面永久不可用；失败由 `flush()`
   * 如实上报，交给人决定。
   */
  function pump(): void {
    if (drain !== null || queue.length === 0) return;
    const run = async (): Promise<void> => {
      while (queue.length > 0) {
        const task = queue.shift();
        if (task === undefined) break;
        try {
          if (task.op === 'write') await storage.set(task.key, task.text);
          else await storage.delete(task.key);
          noteSuccess(task.key);
        } catch (error) {
          const detail = errorText(error);
          noteFailure(task.key, detail);
          queueFailures.push(
            Object.freeze({
              kind: task.op === 'write' ? 'write-failed' : 'remove-failed',
              key: task.key,
              detail,
            }),
          );
        }
      }
    };
    drain = run().finally(() => {
      drain = null;
    });
  }

  const port: Kojo2StoragePort = {
    read(key: string): string | null {
      return mirror.get(key) ?? null;
    },
    write(key: string, text: string): void {
      // 镜像先改：两阶段提交的「回读校验」发生在镜像上（同步），真正落盘由队列负责。
      mirror.set(key, text);
      enqueue({ op: 'write', key, text });
    },
    remove(key: string): void {
      mirror.delete(key);
      enqueue({ op: 'remove', key, text: '' });
    },
  };

  const persister: Kojo2StoragePersister = createKojo2StoragePersister({
    port,
    ledgerKey,
    ...(now === undefined ? {} : { now }),
    ...(options.allowSlotMoves === true ? { allowSlotMoves: true } : {}),
  });

  /** 等队列排空（**不消费**失败账：失败留给 `flush()` 如实上报） */
  async function drainQueue(): Promise<void> {
    while (drain !== null || queue.length > 0) {
      if (drain !== null) {
        await drain;
        continue;
      }
      pump();
    }
  }

  async function flush(): Promise<Kojo2StorageHostFlushResult> {
    await drainQueue();
    const failures = queueFailures.splice(0, queueFailures.length);
    return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures) });
  }

  /* ---------- 水合状态 ---------- */

  let hydrated = false;
  /**
   * kernel 级坏账（`entry()` 报 corrupt，拿不到原文）时在这里存一笔：
   * `readLedger` 如实报 corrupt，`commit` 一律拒绝——绝不把「读不懂」当「首启」覆盖。
   */
  let mirrorFailure: {
    readonly kind: 'corrupt';
    readonly reason: 'json' | 'shape';
    readonly detail: string;
  } | null = null;

  function mirrorRead(): Kojo2StorageHostLedgerReadResult {
    if (!hydrated) {
      return freezeRead({
        kind: 'not-hydrated',
        detail:
          '账本尚未 hydrate()：先 await host.hydrate() 再读——「没读过盘」不等于「没有账本」，' +
          '把它当成 absent 会让下一次提交静默覆盖已有的槽位账。',
      });
    }
    if (mirrorFailure !== null) {
      return freezeRead({
        kind: 'corrupt',
        reason: mirrorFailure.reason,
        detail: mirrorFailure.detail,
        raw: null,
      });
    }
    const text = mirror.get(ledgerKey);
    if (text === undefined) return freezeRead({ kind: 'absent' });
    const parsed = parseKojo2StorageLedger(text);
    if (parsed.kind === 'corrupt') {
      return freezeRead({
        kind: 'corrupt',
        reason: parsed.reason,
        detail: parsed.detail,
        raw: text,
      });
    }
    if (parsed.kind === 'version-unsupported') {
      return freezeRead({
        kind: 'version-unsupported',
        version: parsed.version,
        expected: parsed.expected,
        raw: text,
      });
    }
    return freezeRead({ kind: 'ok', ledger: parsed.ledger });
  }

  async function hydrate(): Promise<Kojo2StorageHostLedgerReadResult> {
    /*
     * 先把队列排空：水合是「以盘为准」的重建，必须等所有已知写操作都有结论。
     * 失败账**不在这里消费**（留给下一次 flush 上报）；但正式账本写失败且没被成功重写覆盖时，
     * 盘比内存镜像旧——照常重读就会把刚提交的那一笔静默丢掉，所以拒绝水合并上报。
     */
    await drainQueue();
    if (ledgerWriteFailed !== null) {
      return freezeRead({
        kind: 'port-error',
        detail:
          `正式账本写盘失败且尚未被成功的重写覆盖（${ledgerWriteFailed}）——内存镜像比盘新，` +
          '拒绝以盘为准覆盖（否则会静默丢掉刚提交的那一笔）；请先修复写盘问题，' +
          '或换一个新实例重新打开项目（新实例会以盘为准并如实报出差额）',
      });
    }

    let read: LedgerTextRead;
    try {
      const entry = storage.entry;
      if (typeof entry === 'function') {
        const state = await entry.call(storage, ledgerKey);
        if (state.state === 'missing') {
          read = { kind: 'missing' };
        } else if (state.state === 'corrupt') {
          read = { kind: 'corrupt', reason: 'json', detail: state.detail };
        } else {
          read = coerceLedgerText(state.value);
        }
      } else {
        read = coerceLedgerText(await storage.get(ledgerKey));
      }
    } catch (error) {
      // 读不动 ≠ 不存在：保持原状态（含「未水合」），绝不据此落账。
      return freezeRead({
        kind: 'port-error',
        detail: `读账本失败（读不动 ≠ 不存在）：${errorText(error)}`,
      });
    }

    mirror.clear();
    if (read.kind === 'corrupt') {
      hydrated = true;
      mirrorFailure = { kind: 'corrupt', reason: read.reason, detail: read.detail };
      return freezeRead({
        kind: 'corrupt',
        reason: read.reason,
        detail:
          read.reason === 'json'
            ? `存储里的账本 JSON 已损坏（${read.detail}）——拒绝把它当成首启覆盖掉`
            : read.detail,
        raw: null,
      });
    }
    mirrorFailure = null;
    hydrated = true;
    if (read.kind === 'text') {
      mirror.set(ledgerKey, read.text);
      return mirrorRead();
    }
    return freezeRead({ kind: 'absent' });
  }

  /* ---------- previousSnapshot 还原 ---------- */

  function loadPreviousSnapshot(): Kojo2StorageHostPreviousSnapshotResult {
    const read = mirrorRead();
    if (read.kind === 'absent') {
      return freezePrevious({
        kind: 'absent',
        reason: 'no-ledger',
        detail: '本项目还没有已提交的槽位账本（首次分配）。',
      });
    }
    if (read.kind === 'corrupt') {
      return freezePrevious({ kind: 'invalid', reason: 'corrupt', detail: read.detail });
    }
    if (read.kind === 'version-unsupported') {
      return freezePrevious({
        kind: 'invalid',
        reason: 'version-unsupported',
        detail: `账本版本 ${read.version} 不受支持（当前 ${read.expected}）——拒绝在未知格式上继续分配。`,
      });
    }
    if (read.kind === 'port-error') {
      return freezePrevious({ kind: 'invalid', reason: 'port-error', detail: read.detail });
    }
    if (read.kind === 'not-hydrated') {
      return freezePrevious({ kind: 'not-hydrated', detail: read.detail });
    }

    const ledger = read.ledger;
    const recordKeys = Object.keys(ledger.records).sort(compareText);
    if (recordKeys.length === 0) {
      return freezePrevious({
        kind: 'absent',
        reason: 'no-records',
        detail:
          '账本只有 slots、没有 records（旧版账本或空工程）——没有 valueType/arraySize 就还原不了' +
          '槽位形状，跨构建改型检测会失效；下一次内容有变化时账本会自动回填 records，' +
          '别把它当成「没有账本」去静默重建。',
      });
    }

    for (const key of Object.keys(ledger.slots)) {
      if (!Object.prototype.hasOwnProperty.call(ledger.records, key)) {
        return freezePrevious({
          kind: 'invalid',
          reason: 'inconsistent',
          detail:
            `slots 里的「${key}」没有形状记录（records 缺这一格）——账本不完整，` +
            '请先完成一次 commit 回填 records，别拿残缺账本反哺 previousSnapshot。',
        });
      }
    }

    const classes: Partial<Record<Kojo2StorageSlotStorage, Record<string, SlotAssignmentRecord>>> =
      {};
    for (const key of recordKeys) {
      const slotName = ledger.slots[key];
      const record = ledger.records[key];
      if (slotName === undefined || record === undefined) {
        return freezePrevious({
          kind: 'invalid',
          reason: 'inconsistent',
          detail: `records 里的「${key}」在 slots 里没有槽名——两份表不是同一次提交写的。`,
        });
      }
      const parsed = parseCanonicalSlotName(slotName);
      if (parsed === null) {
        return freezePrevious({
          kind: 'invalid',
          reason: 'slot-name',
          detail:
            `槽名「${slotName}」不是「存储期#槽号」形式，无法还原 storagePlan.classes` +
            '（自定义槽名的宿主必须自己提供映射，本层不猜）。',
        });
      }
      if (parsed.slot !== record.slot) {
        return freezePrevious({
          kind: 'invalid',
          reason: 'inconsistent',
          detail:
            `「${key}」的槽名是 ${slotName}（槽 ${parsed.slot}），但 records.slot=${record.slot}` +
            '——账本自相矛盾，拒绝还原。',
        });
      }
      const table = classes[parsed.storage] ?? {};
      table[key] = Object.freeze({
        slot: record.slot,
        valueType: record.valueType,
        arraySize: record.arraySize,
      });
      classes[parsed.storage] = table;
    }

    const frozenClasses: Partial<
      Record<Kojo2StorageSlotStorage, Record<string, SlotAssignmentRecord>>
    > = {};
    for (const storageKey of KOJO2_STORAGE_CLASS_ORDER) {
      const table = classes[storageKey];
      if (table === undefined) continue;
      const sorted: Record<string, SlotAssignmentRecord> = {};
      for (const key of Object.keys(table).sort(compareText)) {
        const value = table[key];
        if (value !== undefined) sorted[key] = value;
      }
      frozenClasses[storageKey] = Object.freeze(sorted);
    }

    const snapshot: SlotRegistrySnapshot = Object.freeze({
      version: SLOT_SNAPSHOT_VERSION,
      gameFingerprint: ledger.fingerprint,
      classes: Object.freeze(frozenClasses),
    });
    return freezePrevious({ kind: 'ok', snapshot, ledger });
  }

  /* ---------- 提交（含 recycled 拦截） ---------- */

  let inFlight = false;

  function recycledScanOf(registry: Record<string, unknown>): {
    readonly entries: readonly Kojo2StorageRecycledEntry[];
    readonly total: number;
    readonly malformed: number;
  } {
    const plan = registry.storagePlan;
    if (!isRecord(plan)) return { entries: NO_RECYCLED, total: 0, malformed: 0 };
    const raw = plan.recycled;
    if (!Array.isArray(raw)) return { entries: NO_RECYCLED, total: 0, malformed: 0 };
    const entries: Kojo2StorageRecycledEntry[] = [];
    let malformed = 0;
    for (const value of raw) {
      if (!isRecord(value)) {
        malformed += 1;
        continue;
      }
      const storageValue = value.storage;
      const slot = value.slot;
      const previousKey = value.previousKey;
      const nextKey = value.nextKey;
      if (
        (storageValue !== 'scene' && storageValue !== 'save' && storageValue !== 'session') ||
        typeof slot !== 'number' ||
        !Number.isInteger(slot) ||
        slot < 0 ||
        typeof previousKey !== 'string' ||
        typeof nextKey !== 'string'
      ) {
        malformed += 1;
        continue;
      }
      entries.push(
        Object.freeze({ storage: storageValue, slot, previousKey, nextKey }),
      );
    }
    return { entries: Object.freeze(entries), total: raw.length, malformed };
  }

  function recycledFailure(scan: {
    readonly entries: readonly Kojo2StorageRecycledEntry[];
    readonly total: number;
    readonly malformed: number;
  }): Kojo2StorageHostRecycledFailure {
    const described = scan.entries
      .map(
        (entry) =>
          `${entry.storage}#${entry.slot}：旧「${entry.previousKey}」→ 新「${entry.nextKey}」`,
      )
      .join('；');
    const detail =
      `本次装配回收了 ${scan.total} 个槽位（${described.length === 0 ? '形状非法，无法逐条呈现' : described}）` +
      '——被回收槽里的旧存档字节仍属于已删除的声明，新声明第一次读档会读到旧值（等于把旧剧情/数值串进新变量），' +
      '而账本与诊断都是合法的、不会自己报警。默认零写阻断；作者确认重排并接受旧档错位后，' +
      `用 allowRecycledSlots: true 显式放行${scan.malformed > 0 ? `（另有 ${scan.malformed} 条回收记录形状非法）` : ''}。`;
    return Object.freeze({
      kind: 'recycled-slots',
      ok: false,
      entries: scan.entries,
      total: scan.total,
      detail,
    });
  }

  function commit(input: Kojo2StorageCommitInput): Kojo2StorageHostCommitResult {
    if (inFlight) {
      return Object.freeze({
        kind: 'busy',
        ok: false,
        detail:
          '同一槽位宿主上发生了重入 commit（同步端口下即并发）——已拒绝，本次一个字节都没写。' +
          '宿主若在注册表 getter / 存储回调里再触发提交，那是接线 bug，必须硬拒绝。',
      });
    }
    if (!hydrated) {
      return Object.freeze({
        kind: 'not-hydrated',
        ok: false,
        detail:
          '账本尚未 hydrate()：先 await host.hydrate() 再提交——否则会把「没读过盘」当成首启，' +
          '覆盖掉已有的槽位账本。',
      });
    }
    inFlight = true;
    try {
      if (mirrorFailure !== null) {
        return Object.freeze({
          kind: 'corrupt-ledger',
          ok: false,
          reason: mirrorFailure.reason,
          detail:
            `盘上的账本读不懂（${mirrorFailure.detail}）——拒绝在它上面继续写，` +
            '请作者先处理坏数据（备份/删除）再重开项目。',
        });
      }

      const record = isRecord(input) ? input : null;
      const registryRecord =
        record !== null && isRecord(record.registry) ? record.registry : null;
      if (registryRecord !== null) {
        let scan: ReturnType<typeof recycledScanOf>;
        try {
          scan = recycledScanOf(registryRecord);
        } catch (error) {
          // 病态注册表（getter 抛错 / 代理陷阱）：连「有没有回收」都问不出来时绝不落账。
          return Object.freeze({
            kind: 'invalid-registry',
            ok: false,
            detail: `读取存储注册表的回收记录时抛错：${errorText(error)}——已按非法注册表处理，不落账。`,
          });
        }
        if (scan.total > 0 && !allowRecycledSlots) return recycledFailure(scan);
      }

      try {
        return persister.commit(input);
      } catch (error) {
        // 病态注册表（getter 抛错 / 代理陷阱）：同步端口下 commit 不该抛，兜成可判别失败。
        return Object.freeze({
          kind: 'invalid-registry',
          ok: false,
          detail: `落账过程中存储注册表抛错：${errorText(error)}——已按非法注册表处理，不落账。`,
        });
      }
    } finally {
      inFlight = false;
    }
  }

  return Object.freeze({
    ledgerKey,
    pendingKey: persister.pendingKey,
    projectKey,
    hydrate,
    readLedger: mirrorRead,
    loadPreviousSnapshot,
    commit,
    flush,
  });
}

/* ============================== 失败上屏映射 ============================== */

/**
 * 宿主命名空间的诊断码（**绝不与 `core/storage/*` 混用**）。
 *
 * core 的码只从 `registry.diagnostics` 原样透传；本表只覆盖「账本 / 队列 / 宿主接线」
 * 这一层自己的事——问题面板据此能一眼看出「这是持久化层的问题，不是稿子写错了」。
 */
export const KOJO2_STORAGE_HOST_PROBLEM_CODES = Object.freeze({
  notHydrated: 'kojo2/storage-host/not-hydrated',
  ledgerCorrupt: 'kojo2/storage-host/ledger-corrupt',
  ledgerVersionUnsupported: 'kojo2/storage-host/ledger-version-unsupported',
  storageUnavailable: 'kojo2/storage-host/storage-unavailable',
  busy: 'kojo2/storage-host/busy',
  invalidInput: 'kojo2/storage-host/invalid-input',
  diskSwapped: 'kojo2/storage-host/disk-swapped',
  planNotOk: 'kojo2/storage-host/plan-not-ok',
  registryFingerprintMismatch: 'kojo2/storage-host/registry-fingerprint-mismatch',
  slotMoved: 'kojo2/storage-host/slot-moved',
  declarationKeyMismatch: 'kojo2/storage-host/declaration-key-mismatch',
  invalidRegistry: 'kojo2/storage-host/invalid-registry',
  commitFailed: 'kojo2/storage-host/commit-failed',
  recycledSlots: 'kojo2/storage-host/recycled-slots',
  previousSnapshotInvalid: 'kojo2/storage-host/previous-snapshot-invalid',
  writeBehindFailed: 'kojo2/storage-host/write-behind-failed',
});

/** 一条待上屏的存储问题（`problem-store` / toast 的直接输入） */
export interface Kojo2StorageHostProblem {
  /** 宿主机码；**永远带 `kojo2/storage-host/` 前缀** */
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

/** 本函数接受的结果并集（提交 / 读账本 / 还原快照 / 队列失败） */
export type Kojo2StorageHostOutcome =
  | Kojo2StorageHostCommitResult
  | Kojo2StorageHostLedgerReadResult
  | Kojo2StorageHostPreviousSnapshotResult
  | Kojo2StorageHostQueueFailure;

const NO_PROBLEMS: readonly Kojo2StorageHostProblem[] = Object.freeze([]);

function problem(
  code: string,
  message: string,
  severity: 'error' | 'warning' = 'error',
): readonly Kojo2StorageHostProblem[] {
  return Object.freeze([Object.freeze({ code, severity, message })]);
}

/**
 * 结果 → 上屏问题列表（**纯函数**，同输入同输出）。
 *
 * 成功 / 首启 / 无害状态返回空表。所有 `code` 都是宿主码：**本函数不发明也不改写
 * `core/storage/*`**——core 诊断由 `registry.diagnostics` 那一侧原样透传（`plan-not-ok`
 * 的 message 里会把 core 失败码当**文本**带出来，方便人核对，但它不进 `code` 字段）。
 */
export function kojo2StorageProblemOf(
  outcome: Kojo2StorageHostOutcome,
): readonly Kojo2StorageHostProblem[] {
  switch (outcome.kind) {
    case 'ok':
    case 'absent':
    case 'committed':
      return NO_PROBLEMS;

    case 'not-hydrated':
      return problem(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.notHydrated,
        `槽位账本还没水合：${outcome.detail}`,
      );

    case 'corrupt':
    case 'corrupt-ledger':
      return problem(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.ledgerCorrupt,
        `槽位账本损坏（${outcome.reason}）：${outcome.detail}——已拒绝覆盖/继续写；` +
          '请先备份或删除该项目账本再重开，别让它被静默重建。',
      );

    case 'version-unsupported':
      return problem(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.ledgerVersionUnsupported,
        `槽位账本版本 ${outcome.version} 不受支持（当前 ${outcome.expected}）：` +
          '这份账本是更新的工具写的，本版本不会在未知格式上继续写——请升级工具。',
      );

    case 'port-error':
      return problem(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.storageUnavailable,
        `存储读写失败：${outcome.detail}——读不动 ≠ 不存在；在恢复之前不会落账。`,
      );

    case 'busy':
      return problem(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.busy,
        `槽位账本提交重入（同步端口下即并发）：${outcome.detail}`,
      );

    case 'invalid-input':
      return problem(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidInput,
        `槽位账本提交参数非法：${outcome.detail}`,
      );

    case 'disk-swapped':
      return problem(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.diskSwapped,
        `游戏指纹变了（旧「${outcome.previous}」→ 新「${outcome.current}」）——` +
          '换盘/换汉化会改变变量表语义，本层 fail-closed、一个槽都没搬、一个字节都没写；' +
          '旧账原样保留，请作者确认盘符后重新分配。',
      );

    case 'plan-not-ok': {
      const failures =
        outcome.failures.length === 0
          ? outcome.detail
          : outcome.failures
              .map((failure) => `${failure.kind}(${failure.code || '无码'}) ${failure.message}`)
              .join('；');
      return problem(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.planNotOk,
        `槽位规划失败（${outcome.failures.length} 条）：${failures}——账本零写；` +
          'core 诊断原文见 registry.diagnostics（本函数不伪造 core 码）。',
      );
    }

    case 'fingerprint-mismatch':
      return problem(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.registryFingerprintMismatch,
        `存储注册表是按另一个指纹装配的（注册表「${outcome.registryFingerprint}」≠ 本次「${outcome.current}」）` +
          '——拒绝把脏分配落账：请用本次指纹重新装配注册表。',
      );

    case 'slot-moved':
      return problem(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.slotMoved,
        `已存在的声明换了槽位（「${outcome.key}」：${outcome.previous} → ${outcome.current}）——` +
          '说明注册表不是按旧账本/旧快照装配的；继续落账会把「搬槽」写成事实，' +
          '旧存档里那个槽的旧值还留在旧变量名下。已零写阻断；确认重排才可显式 allowSlotMoves。',
      );

    case 'key-policy-mismatch':
      return problem(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.declarationKeyMismatch,
        `注入的声明键与注册表口径不一致（注册表「${outcome.expected}」≠ 注入「${outcome.actual}」，` +
          `声明「${outcome.name}」@ ${outcome.uri}）——账本看着稳定、实际会搬槽，已零写阻断。`,
      );

    case 'invalid-registry':
      return problem(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.invalidRegistry,
        `存储注册表结构不成立：${outcome.detail}——不落账（注册表异常时宁可整笔不写）。`,
      );

    case 'commit-failed': {
      const rollback = outcome.rollback;
      const pending = rollback.pendingRemoved ? '已清除' : '仍残留';
      return problem(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.commitFailed,
        `槽位账本落盘在「${outcome.phase}」一步失败：${outcome.detail}；` +
          `回滚报告：正式键 ${rollback.ledger}，暂存键 ${pending}` +
          `${rollback.detail === null ? '' : `，细节：${rollback.detail}`}` +
          '——失败已回滚（或如实报告修不动），盘上状态以上述报告为准。',
      );
    }

    case 'recycled-slots':
      return problem(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.recycledSlots,
        `槽位回收被拦截（${outcome.total} 个）：${outcome.detail}`,
      );

    case 'invalid':
      return problem(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.previousSnapshotInvalid,
        `上一份槽位快照无法还原（${outcome.reason}）：${outcome.detail}`,
      );

    case 'write-failed':
    case 'remove-failed':
      return problem(
        KOJO2_STORAGE_HOST_PROBLEM_CODES.writeBehindFailed,
        `写盘落后失败（${outcome.kind === 'write-failed' ? '写' : '删'}「${outcome.key}」）：` +
          `${outcome.detail}——内存镜像已更新、盘上可能还是旧账本；下次打开会以盘为准，` +
          '请把这一条当作「本次提交没有真正落盘」上报。',
      );

    default:
      return NO_PROBLEMS;
  }
}
