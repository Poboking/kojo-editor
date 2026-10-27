/**
 * 结构解析线程池（LAU-5）。
 *
 * ## 一句话
 *
 * **一条线程、一个 `Parser.init`，按需装载多门语言的文法**：所有结构客户端（`.kojo`、
 * ERB 主文档、`@原生` 子解析）都从这只池里**借**线程，用完**还**回来——线程在池里活着，
 * 它的运行时（`web-tree-sitter` 的 wasm 模块）与已经装进来的文法都不会随客户端释放而丢。
 *
 * ## 为什么是"借还"而不是"每个客户端一条线程"
 *
 * v3 之前每个语言模块自带一个 `?worker` 入口、每个 `StructureClient` `dispose()` 时
 * `terminate()` 掉线程。代价是**每起一个客户端就重付一次**：
 * 线程创建 + `Parser.init`（运行时 wasm 实例化）+ 文法 `Language.load`。
 * 池把这三笔一次性付掉，之后同一条线程服务下一个客户端（`open` 直接回 `ready{loadMs:0}`）。
 *
 * ## 池怎么分（键是什么）
 *
 * 键 = `runtimeWasmUrl`。`web-tree-sitter` 的运行时只能在一个线程里实例化一次，**同一份运行时
 * 下的多门语言共用一条线程是有意义的**（`Parser.init` 只付一次）；换运行时才另起线程。
 * 语言维度的"占哪台引擎"由 worker 侧按 `grammarWasmUrl` 分流（见 `worker-bootstrap.ts`），
 * 池这边不需要知道语言名——它只认运行时。
 *
 * ## 上限与收账
 *
 * - 空闲线程最多 {@link MAX_IDLE} 条（超出的直接 `terminate`，不无限攒）；
 * - **坏线程不回池**：客户端在 `fatal` 之后调 `release(false)`，当场 `terminate`；
 * - `closeStructurePool()` 由装配层在"整套拆毁"时调（与 `disposeInjectionClients()` 同一处
 *   ——provider 注册面都不在了，留着线程只有占内存）；
 * - 所以"关掉池"的回滚点 = 把这个模块的 `acquireStructureThread` 换回
 *   `runtime.createWorker()`（一行），行为回到"每语言一条线程"。
 */
import type { StructureLanguageRuntime } from './structure-runtime';
import StructureWorker from './structure.worker?worker';

/** 空闲线程上限（超出即 terminate；正常会话里最多 1 条，留 1 条给"切开关后再开"） */
const MAX_IDLE = 2;

interface PoolEntry {
  readonly worker: Worker;
  /** 池键（`runtimeWasmUrl`） */
  readonly key: string;
}

const idle: PoolEntry[] = [];

const stats = { created: 0, reused: 0, terminated: 0, acquired: 0, released: 0 };

/** 一条借出去的线程：`release` 之后这个对象就不能再用（线程已经回池或已经被杀） */
export interface StructureThreadLease {
  readonly worker: Worker;
  /** 还回池子；`reusable=false` ⇒ 这条线程已经坏了（线程崩过 / 协议不符），直接终结 */
  release(reusable: boolean): void;
}

/** 造一条新线程（`?worker` 在唯一一处；`client-v2` 的旧路也走这里拿线程） */
export function createStructureThread(): Worker {
  return new StructureWorker();
}

/**
 * 借一条线程。同一个运行时下有空闲的就复用（`stats.reused` 记一笔），否则新建。
 *
 * 借出去的线程**独占**到 `release` 为止：同一时刻两个客户端不会共用一条线程（各客户端
 * 各自 `open` 自己的文法；线程内部再按 `docBase` 分引擎——那是**同一线程里**的多客户端，
 * 由 worker 侧 `channels` 表管，不靠池保证）。
 */
export function acquireStructureThread(runtime: StructureLanguageRuntime): StructureThreadLease {
  stats.acquired += 1;
  // 注入点（测试 / 回滚）：运行时自带 `createWorker` 时不进池——用哪具线程由调用方说了算
  if (runtime.createWorker !== undefined) {
    return leaseOf({ worker: runtime.createWorker(), key: '' }, false);
  }
  const key = runtime.runtimeWasmUrl;
  const index = idle.findIndex((entry) => entry.key === key);
  if (index >= 0) {
    const entry = idle.splice(index, 1)[0]!;
    stats.reused += 1;
    if (stats.reused === 1) {
      console.debug(`[kojo-structure] 池复用线程（key=${key}）：运行时与已装文法都不重付`);
    }
    return leaseOf(entry);
  }
  stats.created += 1;
  return leaseOf({ worker: createStructureThread(), key });
}

function leaseOf(entry: PoolEntry, pooled = true): StructureThreadLease {
  let released = false;
  return {
    worker: entry.worker,
    release(reusable: boolean): void {
      if (released) return;
      released = true;
      stats.released += 1;
      if (pooled && reusable && idle.length < MAX_IDLE) {
        // 回池前把主线程侧的回调摘掉：线程还在跑，但下一位借它的人会自己装回调
        entry.worker.onmessage = null;
        entry.worker.onerror = null;
        idle.push(entry);
        return;
      }
      terminate(entry);
    },
  };
}

function terminate(entry: PoolEntry): void {
  stats.terminated += 1;
  entry.worker.onmessage = null;
  entry.worker.onerror = null;
  entry.worker.terminate();
}

/** 整套拆毁：把所有空闲线程收掉（借出去的那些由各自 `release(false)` 收） */
export function closeStructurePool(): void {
  for (const entry of idle.splice(0)) terminate(entry);
}

/** 读数（回执 / 测试用）：建了几条、复用了几次、收掉几条、当前空闲几条 */
export function structurePoolStats(): {
  readonly created: number;
  readonly reused: number;
  readonly terminated: number;
  readonly acquired: number;
  readonly released: number;
  readonly idle: number;
} {
  return { ...stats, idle: idle.length };
}

/** 测试用：清空池与计数（生产不调） */
export function resetStructurePoolForTests(): void {
  for (const entry of idle.splice(0)) {
    entry.worker.onmessage = null;
    entry.worker.onerror = null;
    entry.worker.terminate();
  }
  stats.created = 0;
  stats.reused = 0;
  stats.terminated = 0;
  stats.acquired = 0;
  stats.released = 0;
}
