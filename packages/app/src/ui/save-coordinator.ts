/**
 * A10 保存协调（纯函数半边）：per-path 互斥 + 并发池 + 保存回执。
 *
 * 为什么从"全局一把 savingRef"降成 per-path：不同文件的写盘本无共享态——
 * IPC 桥（bridge/invoke.ts）逐命令独立、Rust 原子写临时名带进程内单调序号
 * （lib.rs `tmp_unique_id`），跨文件并发天然安全；同文件互斥才是要害（备份/
 * rename 互踩）。全局锁把前者也禁了，多脏标签的全保存被拖成串行。
 *
 * 并发上限的理由只有一个：防 IPC 洪泛（保存接管者一份源可能写多个产物文件）。
 * 回执（`buildSaveReceipt`）把逐文件结果合成一条通知——失败不轰炸，跳过必须
 * 可见（内核"不静默"铁律的宿主同调）。
 */

/** 全保存并发池上限（lane 数）：4 路足够吃满桌面 IPC，再多只有排队没有吞吐 */
export const SAVE_MAX_CONCURRENCY = 4;

export type SaveFileStatus =
  /** 落盘成功且版本未竞态 */
  | 'saved'
  /** 写失败（含只读拒绝/异常）；message 为人话原因 */
  | 'failed'
  /** needs-choice 告警被跳过（后台标签；活动标签同时弹确认框） */
  | 'skipped-choice'
  /** 该文件已有在途保存（per-path 互斥拒绝，不排队重复写） */
  | 'skipped-busy'
  /** 已落盘但写窗口内有新输入——保持未保存，不回滚盘上内容 */
  | 'kept-dirty';

export interface SaveFileOutcome {
  path: string;
  status: SaveFileStatus;
  /** 失败原因（人话，进回执） */
  message?: string;
  /** 失败源于写允许域 → 回执通知要挂「去授权」action */
  needsReauth?: boolean;
}

/* --------------------------- per-path 互斥 --------------------------- */

export interface PathMutex {
  tryAcquire(key: string): boolean;
  release(key: string): boolean;
  isBusy(key: string): boolean;
}

export function createPathMutex(): PathMutex {
  const held = new Set<string>();
  return {
    tryAcquire: (key) => {
      if (held.has(key)) return false;
      held.add(key);
      return true;
    },
    release: (key) => held.delete(key),
    isBusy: (key) => held.has(key),
  };
}

/**
 * 锁语义的执行壳：拿到锁跑 task；拿不到（同 key 在途）走 onBusy。
 * task 抛错也必须释放锁——泄漏一把 per-path 锁等于该文件永远存不了。
 */
export async function withPathLock<T>(
  lock: PathMutex,
  key: string,
  task: () => Promise<T>,
  onBusy: () => T,
): Promise<T> {
  if (!lock.tryAcquire(key)) return onBusy();
  try {
    return await task();
  } finally {
    lock.release(key);
  }
}

/* ----------------------------- 并发池 ----------------------------- */

/**
 * 定长泳道池：结果按输入序返回。worker 不许 reject（reject = 全批 await 悬挂
 * 前其余泳道仍在跑、错误语义却丢了）；调用方把逐文件异常收进返回值里。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  const runLane = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: lanes }, () => runLane()));
  return results;
}

/* ----------------------------- 回执 ----------------------------- */

export interface SaveReceipt {
  kind: 'info' | 'error';
  message: string;
  /** 任一失败源于写允许域 → 宿主给这条通知挂「去授权」action */
  needsReauth: boolean;
}

/** 回执里逐文件失败明细的最长列举（再多只报个数——一条通知不轰炸） */
const RECEIPT_FAILURE_MAX = 3;

/**
 * 逐文件结果 → 一条合成回执；全部成功返回 null（成功不吭声，旧语义不变）。
 */
export function buildSaveReceipt(outcomes: readonly SaveFileOutcome[]): SaveReceipt | null {
  if (outcomes.length === 0 || outcomes.every((o) => o.status === 'saved')) return null;
  const failed = outcomes.filter((o) => o.status === 'failed');
  const choice = outcomes.filter((o) => o.status === 'skipped-choice');
  const busy = outcomes.filter((o) => o.status === 'skipped-busy');
  const kept = outcomes.filter((o) => o.status === 'kept-dirty');
  const saved = outcomes.length - failed.length - choice.length - busy.length - kept.length;
  const parts: string[] = [`已保存 ${saved}/${outcomes.length}`];
  if (failed.length > 0) {
    const detail = failed
      .slice(0, RECEIPT_FAILURE_MAX)
      .map((f) => `「${f.path}」${f.message ? `（${f.message}）` : ''}`)
      .join('、');
    parts.push(`失败 ${failed.length}：${detail}${failed.length > RECEIPT_FAILURE_MAX ? ` 等${failed.length}个` : ''}`);
  }
  if (choice.length > 0) parts.push(`跳过 ${choice.length}：保存告警待处理，切到该标签单独保存`);
  if (busy.length > 0) parts.push(`跳过 ${busy.length}：已有在途保存`);
  if (kept.length > 0) parts.push(`保持未保存 ${kept.length}：写盘期间又有新输入`);
  return {
    kind: failed.length > 0 ? 'error' : 'info',
    message: `全部保存：${parts.join(' · ')}`,
    needsReauth: failed.some((f) => f.needsReauth === true),
  };
}

/** 全保存的批语义收口：并发池跑 saveOne → 回执 + 整体 ok（非 saved 一律不 ok） */
export async function runSaveBatch(
  paths: readonly string[],
  saveOne: (path: string) => Promise<SaveFileOutcome>,
  limit: number = SAVE_MAX_CONCURRENCY,
): Promise<{ ok: boolean; receipt: SaveReceipt | null }> {
  const outcomes = await mapWithConcurrency(paths, limit, (p) => saveOne(p));
  return {
    ok: outcomes.every((o) => o.status === 'saved'),
    receipt: buildSaveReceipt(outcomes),
  };
}
