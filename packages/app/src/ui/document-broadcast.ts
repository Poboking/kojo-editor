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
 *   台账的**容量**必须与标签数无关地有界（S2-3）：LRU 上限 + 关标签时 `forget`。
 *   PS-5 起台账存的是**指纹**（`TextStamp`）而不是整份文本 —— 旧口径下每条都背着
 *   一份上次发出的全文，32 条就是"开过的大文件各留一份正文"常驻到面板卸载。
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
 * 每条 = 该路径上次**已发出**的文本**摘要**（见 `TextStamp`，PS-5 起不再存整份文本）；
 * 不设限就是"开过多少标签 × 全文体积"常驻到面板卸载（一整个编辑器组的生命周期里攒下
 * 几十份大 ERB 是常态，不是极端场景）。上限口径照 `view-state-store` 的 MAX_ENTRIES：
 * Map 插入序即使用序，超限淘汰最旧。
 * 被淘汰的代价只是"下一次同文本白广播一条"（去重失效 = 面板多算一次），
 * 方向安全；而常驻全文的代价是内存，两者不对称，所以要封顶。
 *
 * 容量现在只约束**条数**（每条约 200 字节，32 条 ≈ 6 KB）——旧的 32 条是 32 份整篇正文，
 * 真实语料最大单文件 2.35 MB ⇒ 满载时那是几十 MB 级常驻。
 */
export const LAST_SENT_MAX_ENTRIES = 32;

/* ───────────────── PS-5：台账存"指纹"而不是整份文本 ───────────────── */

/**
 * 一份文本的**等值判据**（不是加密哈希，是"两次广播的文本是不是同一份"这一件事的尺子）。
 *
 * 三个分量各自堵一类碰撞，缺一个都会留下**静默**漏广播（铁律 4）：
 * - `length`：任何增删改（除"同长度替换"）当场分开；
 * - `head` / `tail`（各 64 码元，逐字比）：同长度替换绝大多数落在这两段之外时也能分开，
 *   而且它们是**零成本**的（切片只在比较时按已有字符串取，不常驻大文本）；
 * - `hash`：两条 32 位独立滚动和（FNV-1a 与多项式滚动，种子不同 ⇒ 一条数据的两种形态
 *   不会同时把两条都撞回去），管"中间同长度替换且首尾没动"那一档。
 *
 * 三条同时相等而文本不同的概率量级：需要一次同长度编辑**既**不落在首尾 128 码元内、
 * **又**让两条互相独立的 32 位滚动和同时回到原值（≈2⁻⁶⁴）。一次会话内的比较次数是
 * 千级，累计误判概率 <10⁻¹⁵，而它换掉的是每标签一份整篇正文的常驻。
 * 判据方向也仍然安全：判"不同"永远照发（宁可白广播一条）。
 */
export interface TextStamp {
  readonly length: number;
  readonly hashA: number;
  readonly hashB: number;
  readonly head: string;
  readonly tail: string;
}

/** 首尾逐字比的取样长度（码元） */
export const TEXT_STAMP_SAMPLE = 64;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const ROLL_PRIME = 1_000_003;

/** 双路 32 位滚动和（一次线性扫描，无中间分配；`>>> 0` 保证无符号 32 位） */
export function stampOf(text: string): TextStamp {
  const n = text.length;
  let a = FNV_OFFSET;
  let b = 0x9e3779b9;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, FNV_PRIME) >>> 0;
    b = (Math.imul(b, ROLL_PRIME) + c + 1) >>> 0;
  }
  return {
    length: n,
    hashA: a >>> 0,
    hashB: b >>> 0,
    head: text.slice(0, TEXT_STAMP_SAMPLE),
    tail: n <= TEXT_STAMP_SAMPLE ? text : text.slice(n - TEXT_STAMP_SAMPLE),
  };
}

/** 两份指纹是否该按"同一份文本"处理（全部分量都相等才算等） */
export function sameStamp(x: TextStamp | undefined, y: TextStamp): boolean {
  if (x === undefined) return false;
  return (
    x.length === y.length && x.hashA === y.hashA && x.hashB === y.hashB && x.head === y.head && x.tail === y.tail
  );
}

export function createDocumentBroadcaster(opts: DocumentBroadcasterOptions): DocumentBroadcaster {
  const delayMs = opts.delayMs ?? DOCUMENT_BROADCAST_DEBOUNCE_MS;
  const maxEntries = Math.max(1, Math.floor(opts.maxEntries ?? LAST_SENT_MAX_ENTRIES));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { path: string; read: DocumentTruthReader } | null = null;
  /** pathKey → 上次**已发出**文本的指纹（在途排程不算——没发出去的不能拿去去重；LRU 有界） */
  const lastSent = new Map<string, TextStamp>();

  /** 写入并 touch 到最新端，超限从最旧端淘汰（S2-3：台账必须与标签数无关地有界） */
  const remember = (key: string, stamp: TextStamp): void => {
    lastSent.delete(key);
    lastSent.set(key, stamp);
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
    const stamp = stampOf(truth.text);
    if (dedupe && sameStamp(lastSent.get(key), stamp)) {
      // 同上一条逐字相同：真相没变，不发。但要把这条台账挪到最新端 ——
      // 正在用的标签不该被 LRU 先淘汰（淘汰的代价是多广播一条，方向安全，但也别常发生）
      lastSent.delete(key);
      lastSent.set(key, stamp);
      return;
    }
    remember(key, stamp);
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
