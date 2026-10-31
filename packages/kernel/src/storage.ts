import type { PlatformBridge, ScopedStorage, StorageService } from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';
import { decodeWithProbe } from './encoding';
import { sharedYieldToMain as yieldToMain } from './compute';

/**
 * 存储域实现。
 *
 * 布局：`{appDataDir}/store/{scope}/{key}.json`
 * - 每个插件一个 scope（= 插件 id），禁止跨域读写；
 * - key 与 scope 均做硬校验（防路径穿越，见 DSH 教训："存储域名用下划线/安全字符"）；
 * - 全局域 `_global` 供内核通用持久化（最近项目、写权限批准记录）。
 */
/**
 * 后端读盘的**三态**结果（PERF-14，2026-10 性能批 PS-2）：
 * - `missing` ≠ `unreadable`：前者是"这份数据从没写过"（首启），消费方据此**不得删任何东西**；
 *   后者是盘上站着一份但读不动——旧的 `string | undefined` 把两者挤成一谈，读失败还额外
 *   白烧一趟 `exists`。合并成**一趟** `readFilesRaw`（三态本就在契约里，零新增）。
 * - `data` 是解码后的原文（未 JSON.parse——损坏与否要到解析层才可知，见 {@link StorageEntryState}）。
 */
export type StorageReadResult =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'ok'; data: string };

/**
 * `get` 一层的**显式第三态**（PS-2 修的真 bug）：旧实现把损坏 JSON 咽下成 `undefined`，
 * 下游"快照不可用 ⇒ 删除 + 重建"的 fail-closed 判据（`raw !== undefined`）被静默解除，
 * 坏文件永远躺在盘上反复占读盘时间。`entry` 把 corrupt 与 missing 分开呈报；
 * `get` 维持 `undefined`（对契约消费者零改动）。
 */
export type StorageEntryState<T = unknown> =
  | { state: 'missing' }
  | { state: 'corrupt'; detail: string }
  | { state: 'ok'; value: T };

export interface StorageBackend {
  read(scope: string, key: string): Promise<StorageReadResult>;
  write(scope: string, key: string, data: string): Promise<void>;
  remove(scope: string, key: string): Promise<void>;
  list(scope: string): Promise<string[]>;
}

const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/;

/**
 * 值得让一次路的载荷门槛（字节 / UTF-16 码元数）：1 MiB 以上才切。
 *
 * 让路不是免费的（一次跳转 ≈ 0.1–0.3ms，还会把一次读拆成两条任务），小载荷本来 <1ms。
 * 真语料里跨过这条线的只有索引快照（v11 约 18 MB）：切它买的是"解码 98ms / 解析 163ms
 * 不再与调用方的聚合、落盘、下游级联挤进同一条任务"（实测单帧 701ms → 247ms）。
 */
const YIELD_MIN_PAYLOAD_BYTES = 1 << 20;

export function assertSafeSegment(kind: 'scope' | 'key', value: string): void {
  if (!SAFE_SEGMENT.test(value) || value.includes('..')) {
    throw new Error(`Invalid storage ${kind}: '${value}' (allowed: [A-Za-z0-9_][A-Za-z0-9._-]{0,119}, no '..')`);
  }
}

/** 基于 PlatformBridge 的文件后端（Node 与 Tauri 通用） */
export class FileStorageBackend implements StorageBackend {
  private baseDirPromise: Promise<string> | null = null;

  constructor(private readonly bridge: PlatformBridge) {}

  private baseDir(): Promise<string> {
    if (!this.baseDirPromise) {
      this.baseDirPromise = this.bridge.appDataDir().then((d) => join(d, 'store'));
    }
    return this.baseDirPromise;
  }

  private async scopeDir(scope: string): Promise<string> {
    assertSafeSegment('scope', scope);
    return join(await this.baseDir(), scope);
  }

  async read(scope: string, key: string): Promise<StorageReadResult> {
    assertSafeSegment('key', key);
    const path = join(await this.scopeDir(scope), `${key}.json`);
    // PERF-14：一趟 `readFilesRaw` 顶替旧的 `exists` + `readFileBytes` 两趟 IPC
    // （级联一轮要付 ~7 次这样的读，每次两趟排队）。三态直接来自契约：
    // not-found = missing（首启语义，绝不等于"坏了"）；read-error = unreadable（出声、可区分）。
    const [r] = await this.bridge.readFilesRaw([path]);
    if (!r) {
      console.warn(`[storage] bridge returned no entry for ${scope}/${key}`);
      return { kind: 'unreadable' };
    }
    if (r.status === 'not-found') return { kind: 'missing' };
    if (r.status !== 'ok') return { kind: 'unreadable' };
    // 大载荷先让路再解码：解码是纯 CPU，而这一拍是 IPC 响应的续体（见 YIELD_MIN_PAYLOAD_BYTES）。
    if (r.data.byteLength >= YIELD_MIN_PAYLOAD_BYTES) await yieldToMain();
    // 单源解码（W12 ENC-SRC）：旧写法是旁路 `bridge.decode(bytes, 'utf-8')`——当年在对照的是
    // "客户端 TextDecoder vs Rust encoding_rs"逐字等价性（§5.90 实机复测后 Rust 侧对照命令
    // `decode_bytes` 已删）。判序/替换策略合一进 DECODE_PROBE_POLICY 后，KV 与编辑器走同
    // 一个 `decodeWithProbe`，对照物不复存在，旁路随之取消。
    return { kind: 'ok', data: decodeWithProbe(r.data).text };
  }

  async write(scope: string, key: string, data: string): Promise<void> {
    assertSafeSegment('key', key);
    const dir = await this.scopeDir(scope);
    const path = join(dir, `${key}.json`);
    await this.bridge.ensureDir(dir);
    const bytes = await this.bridge.encode(data, 'utf-8');
    await this.bridge.writeFileBytes(path, bytes);
  }

  async remove(scope: string, key: string): Promise<void> {
    assertSafeSegment('key', key);
    const path = join(await this.scopeDir(scope), `${key}.json`);
    if (await this.bridge.exists(path)) await this.bridge.removeFile(path);
  }

  async list(scope: string): Promise<string[]> {
    const dir = await this.scopeDir(scope);
    const entries = await this.bridge.listDir(dir);
    return entries
      .filter((e) => !e.isDirectory && e.name.endsWith('.json'))
      .map((e) => e.name.slice(0, -'.json'.length));
  }
}

/**
 * 落盘屏障的读数（E·R6，2026-10-31）。
 *
 * 存的写是 fire-and-forget（索引快照 42.7M 码元 / 写窗口实测 0.7s 起），关窗与关项目两条
 * 路径原来都不等它：`void storage.set(...)` 之后进程一走，这一轮的快照就白算了。
 * 宿主可以在退出前拿这份读数说清楚"等到了没有"，而不是静默丢掉。
 */
export interface StorageFlushReport {
  /** flush 开始那一刻登记在册的在途写条数 */
  readonly pending: number;
  /** true = 全部落地；false = 超过上限仍在途（调用方据此决定放不放行） */
  readonly drained: boolean;
  /** 实际等了多久（毫秒） */
  readonly ms: number;
}

export class ScopedStorageImpl implements ScopedStorage {
  constructor(
    private readonly scope: string,
    private readonly backend: StorageBackend,
    /** 在途写登记处（StorageServiceImpl）；单独构造（测试 / 独立域）时为 undefined，flush 无从等起 */
    private readonly owner?: { track<T>(p: Promise<T>): Promise<T> },
  ) {}

  /**
   * 显式三态读（PS-2）：`missing`（首启，不许据此删任何东西）/ `corrupt`（盘上有内容但 JSON
   * 坏了——旧 `get` 把它咽成 undefined，下游 fail-closed 判死跟删被静默解除）/ `ok`。
   * 读失败（unreadable）：warn + 抛错——与旧桥接直接上抛的语义同形（"读不动"必须让调用方
   * 区别于"没有"）。`get` 是本方法对旧契约（`T | undefined`）的投影，行为逐字不变。
   */
  async entry<T = unknown>(key: string): Promise<StorageEntryState<T>> {
    assertSafeSegment('key', key);
    const r = await this.backend.read(this.scope, key);
    if (r.kind === 'missing') return { state: 'missing' };
    if (r.kind === 'unreadable') {
      const msg = `[storage] unreadable ${this.scope}/${key}（读失败 ≠ 不存在，按重建处理）`;
      console.warn(msg);
      throw new Error(msg);
    }
    try {
      // 同上：`JSON.parse` 也是同步纯 CPU（18 MB 实测 163ms），别压在调用方那条任务上。
      if (r.data.length >= YIELD_MIN_PAYLOAD_BYTES) await yieldToMain();
      return { state: 'ok', value: JSON.parse(r.data) as T };
    } catch (e: unknown) {
      // 损坏的存储文件不致命：记日志 + 视为缺失（审阅 L1 修复；
      // recent 列表等非关键数据不该让整个存储域不可用）——但状态必须**可区分**，见上。
      const detail = e instanceof Error ? e.message : String(e);
      console.warn(`[storage] corrupted JSON in ${this.scope}/${key}: ${detail}`);
      return { state: 'corrupt', detail };
    }
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const e = await this.entry<T>(key);
    return e.state === 'ok' ? e.value : undefined;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    assertSafeSegment('key', key);
    // 序列化**不在调用方的任务里做**：`JSON.stringify` 是同步的，写成
    // `backend.write(..., JSON.stringify(value))` 时它在 set() 被调用那一拍就烧完全部时间
    // （索引快照 18 MB ≈ 200ms，正好压在"索引收尾"那帧的尾巴上）。写盘本身就是异步的。
    // E·R6：整段登记进在途表——调用方仍旧可以不 await（语义不变），但宿主退出前能等齐。
    const work = (async (): Promise<void> => {
      await yieldToMain();
      await this.backend.write(this.scope, key, JSON.stringify(value));
    })();
    await (this.owner ? this.owner.track(work) : work);
  }

  async delete(key: string): Promise<void> {
    assertSafeSegment('key', key);
    await this.backend.remove(this.scope, key);
  }

  async keys(): Promise<string[]> {
    return this.backend.list(this.scope);
  }
}

/** 全局域 scope 名（下划线前缀，与插件 id 视觉区分） */
export const GLOBAL_SCOPE = '_global';

export class StorageServiceImpl implements StorageService {
  /**
   * 在途写（E·R6）：`set` 一被调用就登记，settle（成功或失败）即摘除。
   *
   * 只记**当前**一批，不做历史：`flush` 的语义是"把我叫来之前已经发起的那批等完"，
   * 等的过程中新起的写不追（它们属于下一拍，追下去会变成"永远等不完"）。
   */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly backend: StorageBackend) {}

  /** 返回窄类型：内核侧（与未来的契约扩展）可经 `entry()` 拿到显式三态；契约消费者不受影响 */
  scope(pluginId: string): ScopedStorageImpl {
    assertSafeSegment('scope', pluginId);
    return new ScopedStorageImpl(pluginId, this.backend, this);
  }

  global(): ScopedStorageImpl {
    return new ScopedStorageImpl(GLOBAL_SCOPE, this.backend, this);
  }

  /** 内部：登记一笔在途写。错误仍由调用方自己的 catch / await 接，这里只负责"知道它在飞" */
  track<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    const drop = (): void => {
      this.inFlight.delete(p);
    };
    // 两条分支都挂：写失败不该在登记表里留下幽灵，也不该把 rejection 变成 unhandled
    void p.then(drop, drop);
    return p;
  }

  /**
   * 等在途写落地，最多等 `timeoutMs`（默认 1.5s —— 写窗口实测 0.7s 起，留一倍余量）。
   *
   * 为什么要有上限：这条路径挂在**关窗**上，等不完也必须放行，否则"没写完"会变成
   * "关不掉"。超时不算异常：返回值里 `drained: false` 就是"没等到"，由调用方决定怎么说。
   */
  async flush(timeoutMs = 1500): Promise<StorageFlushReport> {
    const startedAt = Date.now();
    const batch = [...this.inFlight];
    if (batch.length === 0) return { pending: 0, drained: true, ms: 0 };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs));
    });
    const settled = Promise.allSettled(batch).then(() => 'settled' as const);
    const verdict = await Promise.race([settled, timeout]);
    if (timer !== null) clearTimeout(timer);
    return { pending: batch.length, drained: verdict === 'settled', ms: Date.now() - startedAt };
  }
}
