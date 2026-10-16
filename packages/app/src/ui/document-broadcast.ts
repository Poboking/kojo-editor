/**
 * `editor.documentChanged` 的调度纯逻辑（C2，2026-10-16 面板真相统一批）。
 *
 * 背景：编辑器缓冲区是"这个文件当前的可编译真相"，而面板过去直接 `io.readText` 读
 * **磁盘**——未保存编辑时波浪线（吃缓冲）在动、面板数字（吃磁盘）是旧的，两屏真相
 * 分叉。宿主把缓冲文本经本模块广播出去，面板以广播为准、读盘降级为兜底。
 *
 * 抽成纯模块（零 React、零 kernel，emit/读取均回调注入）以便逐条钉住三个行为：
 * - **防抖**：击键流不逐字广播；停笔 `delayMs` 后经 `read()` **现取**最新文本落地
 *   （借出的是落地时刻的真相，不是排程那一刻的——排程与落地之间用户可能又改了）；
 * - **去重**：同一 path 与上次**已发出**的 text 逐字相同即跳过（保存回声 / 防抖空转
 *   不进总线；重复广播只会让面板白重算）。path 判等走 `pathKey()` 归一——事件路径
 *   是平台原样，裸字符串比会在 Windows 上静默判不上（HK-7 同款坑）。
 *   **去重只管防抖通道**；`flush` 是"显式断言当前真相"（切文件/加载/reload/抑制
 *   解除），**不走去重**——面板可能在上次广播之后才挂载，把它去重掉等于让
 *   "换过来即有真相"的承诺永远兑现不了（首开窗口期就此冻结成 Disk 旧文本）；
 *   台账每条存的是**整份文本** ⇒ 必须有界（S2-3）：LRU 上限 + 关标签时 `forget`；
 * - **抑制**：`suppressed()` 为真（糖视图挂的是 derived 只读 model）时丢弃在途排程
 *   且不发——派生文本不是文件真相（行号对不上），发了就是把面板带沟里。谓词在
 *   **落地时刻**求值：排程后、落地前用户可能刚切进糖视图。
 */

import { pathKey } from '@kojo/plugin-api';
import type { KernelEventMap } from '@kojo/plugin-api';

/** 广播载荷 = 契约层 `editor.documentChanged` 的载荷（单一真源，不另写一份形状） */
export type DocumentBroadcastPayload = KernelEventMap['editor.documentChanged'];

/**
 * 现取"此刻的真相"。返回 `null` = 此刻没有可广播的东西（model 已关/已替换），
 * 整次广播作废——**不是**空文本：空内容也是真相，必须如实发出。
 */
export type DocumentTruthReader = () => { text: string; dirty: boolean } | null;

export interface DocumentBroadcasterOptions {
  emit: (payload: DocumentBroadcastPayload) => void;
  /** 派生态抑制谓词（糖视图挂载中）。缺省 = 从不抑制。 */
  suppressed?: () => boolean;
  /** 停笔多久后落地；缺省 300ms（比装饰的 250ms 稍慢，节奏不打架） */
  delayMs?: number;
  /** 去重台账容量（LRU）；缺省 `LAST_SENT_MAX_ENTRIES`。测试可传小值。 */
  maxEntries?: number;
}

export interface DocumentBroadcaster {
  /** 排程一次防抖广播（同一 broadcaster 同时只保留一条在途——总是最后排程的那条赢） */
  schedule(path: string, read: DocumentTruthReader): void;
  /** 立即广播一条（切文件 / 加载完成 / 外部重载 / 抑制解除后补发）；在途排程作废 */
  flush(path: string, read: DocumentTruthReader): void;
  /**
   * 遗忘一条路径的去重台账（S2-3，标签关闭时调）。
   * 台账存的是**整份文本**，关标签后不清就是一整个面板寿命的常驻内存；
   * 而且"重开同一文件"必须重新广播一次真相，留着旧台账反而会让首拍去重掉。
   * 可选：宿主没接线也不构成泄漏——台账本身有 LRU 上限。
   */
  forget(path: string): void;
  /** 卸载：清掉在途排程（不发），并释放去重台账 */
  dispose(): void;
}

/** 编辑停笔多久后广播文档真相（宿主已在此防抖，消费面板收到即算，不必再叠一层） */
export const DOCUMENT_BROADCAST_DEBOUNCE_MS = 300;

/**
 * 去重台账的容量上限（S2-3）。
 *
 * 每条 = 该路径上次**已发出**的整份文本；不设限就是"开过多少标签 × 全文体积"常驻到
 * 面板卸载（一整个编辑器组的生命周期里攒下几十份大 ERB 是常态，不是极端场景）。
 * 上限口径照 `view-state-store` 的 MAX_ENTRIES：Map 插入序即使用序，超限淘汰最旧。
 * 被淘汰的代价只是"下一次同文本白广播一条"（去重失效 = 面板多算一次），
 * 方向安全；而常驻全文的代价是内存，两者不对称，所以要封顶。
 */
export const LAST_SENT_MAX_ENTRIES = 32;

export function createDocumentBroadcaster(opts: DocumentBroadcasterOptions): DocumentBroadcaster {
  const delayMs = opts.delayMs ?? DOCUMENT_BROADCAST_DEBOUNCE_MS;
  const maxEntries = Math.max(1, Math.floor(opts.maxEntries ?? LAST_SENT_MAX_ENTRIES));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { path: string; read: DocumentTruthReader } | null = null;
  /** pathKey → 上次**已发出**的文本（在途排程不算——没发出去的不能拿去去重；LRU 有界） */
  const lastSent = new Map<string, string>();

  /** 写入并 touch 到最新端，超限从最旧端淘汰（S2-3：台账必须与标签数无关地有界） */
  const remember = (key: string, text: string): void => {
    lastSent.delete(key);
    lastSent.set(key, text);
    while (lastSent.size > maxEntries) {
      const oldest = lastSent.keys().next();
      if (oldest.done) break;
      lastSent.delete(oldest.value);
    }
  };

  const cancelPending = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  };

  const tryEmit = (path: string, read: DocumentTruthReader, dedupe: boolean): void => {
    if (opts.suppressed?.()) return;
    const truth = read();
    if (truth === null) return;
    const key = pathKey(path);
    if (dedupe && lastSent.get(key) === truth.text) {
      // 同上一条逐字相同：真相没变，不发。但要把这条台账挪到最新端 ——
      // 正在用的标签不该被 LRU 先淘汰（淘汰的代价是多广播一条，方向安全，但也别常发生）
      lastSent.delete(key);
      lastSent.set(key, truth.text);
      return;
    }
    remember(key, truth.text);
    opts.emit({ filePath: path, text: truth.text, dirty: truth.dirty });
  };

  return {
    schedule(path: string, read: DocumentTruthReader): void {
      pending = { path, read };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const p = pending;
        pending = null;
        if (p) tryEmit(p.path, p.read, true);
      }, delayMs);
    },
    flush(path: string, read: DocumentTruthReader): void {
      // 在途排程作废：它携带的是旧闭包/旧路径的读取入口，立即广播以本次为准
      cancelPending();
      tryEmit(path, read, false);
    },
    forget(path: string): void {
      const key = pathKey(path);
      lastSent.delete(key);
      // 在途排程读的就是这条路径 → 一并作废（已关闭的标签没有真相可广播）
      if (pending !== null && pathKey(pending.path) === key) cancelPending();
    },
    dispose(): void {
      cancelPending();
      lastSent.clear();
    },
  };
}
