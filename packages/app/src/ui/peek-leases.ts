import type * as Monaco from '../monaco/entry';

/**
 * Peek 的**未打开文件租约**（1020 编辑器体感批，用户反馈项 7）。
 *
 * 病根（D4 取证，monaco-editor 0.57 standalone）：`Alt+F12` 的 Peek 列表拿的是 provider
 * 返回的 `LocationLink[]`，而每条链接必须指向一份**已存在的 model**——
 * `InMemoryTextModelService.createModelReference` 对不存在的 model 直接抛 `Model not found`。
 * 所以此前只要有一个目标文件没在标签里打开，整批就退回事件通道（`editor.revealLocation`），
 * Peek 对"引用了别的文件里的函数"这件事等于没有。
 *
 * 这一层补的就是那份缺的 model：向**编辑器 model 池**要一份（池按 `Uri.file(path)` 全局共享，
 * 作者随后真打开同一份文件用的还是同一份 model，不存在两遍正文），并给它挂**租约**：
 * - 有界（`PEEK_LEASE_LIMIT` 份，LRU 逐出）——Peek 是只读浏览，不该随重名函数数量单调涨内存；
 * - 逐出 = 还给池（`release`），池自己决定进冷档还是销毁（PS-12 那套判据一行不动）；
 * - 读盘失败 / 不在写域外的只读目录读不出来 ⇒ 该目标不进列表，退回原来的跳转腿（不静默失败：
 *   列表少一条 vs 整批退化成跳转，后者是改前行为，不是新故障）。
 *
 * 分层：本文件**不认识 monaco 与内核**（ acquire / release 由装配点注入 ），所以纯逻辑可单测
 * （`tests/peek-leases.test.ts`）。
 */

/**
 * 同时持有的 Peek 租约上限（份）。尺子**照池的冷档那一把**（`COLD_CACHE_MAX_MODELS`）：
 * 一份租约 = 一整篇正文的 model，量级就是个位数；重名函数的多处定义通常也只有几处。
 * 超出从最旧那头逐出——逐出只是 `release` 还给池，池自己决定进冷档（model 仍活着，
 * Peek 列表那一行照常显示）还是销毁（那一行取不到内容，但跳转腿不受影响）。
 */
export const PEEK_LEASE_LIMIT = 8;

export interface PeekLeaseDeps {
  /** 取一份正文 model（真身 = `editorModelPool.acquire(kernel, path)`，池按路径幂等共享） */
  acquire(filePath: string): Promise<{ readonly model: Monaco.editor.ITextModel }>;
  /** 放掉一份租约（真身 = `editorModelPool.release(filePath)`） */
  release(filePath: string): void;
  /** 覆盖上限（测试与调参用；脏输入回 `PEEK_LEASE_LIMIT`） */
  limit?: number;
  /** 逐出 / 读盘失败的可见出口（缺省 console.warn，铁律 4 的同族纪律） */
  warn?: (message: string) => void;
}

export interface PeekLeases {
  /**
   * 要一份可 Peek 的 model：已在租约里 ⇒ 直接给（并记一次"最近用过"）；
   * 否则现取现挂。失败 ⇒ `undefined`（调用方据此少一条链接，不抛）。
   */
  peek(filePath: string): Promise<Monaco.editor.ITextModel | undefined>;
  /** 只问租约里**已经有**的（判腿与构造链接那两趟用，绝不触发新的读盘） */
  modelFor(filePath: string): Monaco.editor.ITextModel | undefined;
  /** URI 反查宿主路径（Peek 里按 Enter 时 Monaco 交给 opener 的就是这个串） */
  pathOfUri(uri: string): string | undefined;
  /** 全部释放（关项目 / 拆 provider 时调；不漏内存） */
  disposeAll(): void;
  /** 当前租约数（观测面） */
  size(): number;
}

function limitOf(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) return PEEK_LEASE_LIMIT;
  return Math.trunc(requested);
}

export function createPeekLeases(deps: PeekLeaseDeps): PeekLeases {
  const limit = limitOf(deps.limit);
  const warn = deps.warn ?? ((m: string): void => console.warn(`[peek-leases] ${m}`));
  /** 插入序 = 使用序（touch 时删了重插），逐出永远从最旧那头拿 */
  const leases = new Map<string, Monaco.editor.ITextModel>();
  /** 同一路径的并发 peek 共担一次取文（两个目标落在同一份没打开的文件里是常态） */
  const inflight = new Map<string, Promise<Monaco.editor.ITextModel | undefined>>();

  /**
   * 放掉一份租约；**死件只销账不 release**：池里那条记录早没了（`file.changed` 弃档 / 关项目），
   * 此刻同路径的引用属于下一个重新 acquire 上来的人，多放一次就把人家的账拆了。
   */
  const giveBack = (path: string): void => {
    const model = leases.get(path);
    leases.delete(path);
    if (model !== undefined && !model.isDisposed()) deps.release(path);
  };

  const touch = (path: string, model: Monaco.editor.ITextModel): void => {
    leases.delete(path);
    leases.set(path, model);
    while (leases.size > limit) {
      const victim = leases.keys().next();
      if (victim.done) break;
      if (victim.value === path) break; // 只逐出"比刚这一份更旧"的：刚要用的那份不许被自己挤掉
      const victimPath = victim.value;
      giveBack(victimPath);
      warn(`Peek 租约已满（上限 ${limit} 份），逐出最早的那一份：${victimPath}`);
    }
  };

  return {
    peek(filePath) {
      const held = leases.get(filePath);
      if (held !== undefined) {
        if (!held.isDisposed()) {
          touch(filePath, held);
          return Promise.resolve(held);
        }
        giveBack(filePath); // 死件：只销账，随后重新取文
      }
      const pending = inflight.get(filePath);
      if (pending !== undefined) return pending;
      const task = deps
        .acquire(filePath)
        .then(
          (entry) => {
            inflight.delete(filePath);
            // 取文回来时这份 model 可能已被别处 dispose（关项目 / 池回收）：照实说"没有"
            if (!entry || entry.model.isDisposed()) return undefined;
            touch(filePath, entry.model);
            return entry.model;
          },
          (e: unknown) => {
            inflight.delete(filePath);
            warn(`Peek 取文失败（该目标退回跳转腿）：${filePath} · ${e instanceof Error ? e.message : String(e)}`);
            return undefined;
          },
        );
      inflight.set(filePath, task);
      return task;
    },

    modelFor(filePath) {
      const held = leases.get(filePath);
      if (held === undefined || held.isDisposed()) return undefined;
      return held;
    },

    pathOfUri(uri) {
      for (const [path, model] of leases) {
        if (!model.isDisposed() && model.uri.toString() === uri) return path;
      }
      return undefined;
    },

    disposeAll() {
      for (const path of [...leases.keys()]) giveBack(path);
      inflight.clear();
    },

    size() {
      return leases.size;
    },
  };
}
