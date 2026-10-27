/**
 * 结构解析的**旧（v2）client**——双跑窗口里的回滚路（LAU-1）。
 *
 * 这个文件是 LAU-1 之前的 `client.ts` **原样留档**（只换了文件名、类名与收件闸的名字）：
 * 它说 v2 协议（`init` / `parse` / `change` + 四条推送 + `error`），也就是双跑窗口里
 * 旧 worker（还没跟上 v3 那种）听得懂的话。
 *
 * ## 谁用它、什么时候用
 *
 * `client.ts`（v3 薄壳）发 `open` 握手时，如果 worker 回 `protocol-mismatch`（或者回了
 * 一个协议号不符的 `ready`），它就在那一刻把这条语言的结构层**整体交给本类**
 * （`StructureClient.fallback`），并重放当前文档。作者面看到的是"照旧有结构着色"，
 * 不是"整档哑火"。
 *
 * ## 回滚方式（两种）
 *
 * 1. **自动**：v3 握手被拒 ⇒ 本文件接管（双跑窗口的常态，不需要人工动作）；
 * 2. **手动**：`new StructureClient({ protocolMode: 'legacy' })`（`providers.ts::startLanguage`
 *    那一处传一格）⇒ 一个字节的 v3 都不发，直接走本文件。LAU-1 收尾（双跑窗口关闭）时
 *    本文件与那个开关一起删。
 *
 * ## 以下为原文（除下列改名外逐字未动）
 *
 * `StructureClient` → `StructureClientV2`；`isStructureReply` → `isLegacyStructureReply`。
 */

import type * as Monaco from '../entry';
// LAU-5 起，v1 / ERB 的旧 `?worker` 入口已删：本文件不再有"会说 v2 的线程"可借，
// `createStructureThread()` 拿到的是 v4 线程（对 v2 消息回 `invalid-input` ⇒ 本路超时后按
// 失败记账）。双跑窗口因此只剩"降级不会把宿主拖垮"这条价值——窗口关闭时整块删除。
// 与既有 `editor.worker` 同一条 `?worker` 路（vite 后缀），`worker.format` 仍是默认的 iife。
// 踩过的坑记在这里，别下一次再撞：`web-tree-sitter` 的 ESM 带两条 `ENVIRONMENT_IS_NODE`
// 才走到的动态 import（`fs/promises` / `module`），Rollup 只看语法 ⇒ worker 产物要多一枚
// chunk ⇒ iife 拒绝产出（`UMD and IIFE output formats are not supported for code-splitting
// builds`，实测 `pnpm --filter @kojo/app build` 当场失败）。解法在 `vite.config.ts` 的
// `stubNodeOnlyDynamicImports()`：把那两条动态 import 就地换成抛错的 promise——
// **不**抬全局 `worker.format`（那会连 Monaco 自己的 `editor.worker` 一起改成模块 worker，
// 一条实验特性不该动既有 worker 的加载方式），也**不**走 alias 钉桩（alias 生效但动态
// import 仍在，照样切 chunk）。
import { applyEdit, commonEdit } from './edit';
import { reportStructureDegradation } from './fallback';
import { createStructureThread } from './structure-pool';
import type { StructureLanguageRuntime } from './structure-runtime';
import {
  KOJO_STRUCTURE_PROTOCOL,
  isLegacyStructureReply,
  type KojoStructureCapability,
  type KojoStructureFold,
  type KojoStructureIndentRules,
  type KojoStructureRequest,
  type KojoStructureSyntaxFault,
  type KojoStructureToken,
} from './types';

/**
 * 主线程侧的 worker 代理（**主线程一次解析都不做**：这里只发文本、收数据）。
 *
 * ## 一份文档、一条线程
 *
 * worker 里只有一棵 `Tree`，所以代理只跟踪**当前被问到的那一份**文档：
 * 问到别的文档就换轨（旧文档退订、新文档整篇重解）。每份文档带一枚全局单调自增的
 * `seq`，worker 在内容回复里原样回显，对不上号的迟到回复一律丢弃——换轨瞬间旧文档
 * 的在途结果不许污染新文档（真实踩过：A 的 tokens 冒充 B 的结果被缓存上屏并滞留）。
 * 左右分屏同时开两份 `.kojo` 时会来回重解，代价是多解一次，这条边界写明而不是藏着。
 *
 * ## 等谁、等的是哪份文档（等待票）
 *
 * 取数（provider）等结果这件事按**票**登记：票上带它等的那一份文档与它自己的计时器。
 * 回话到达、换轨 / 停用、到点，三条出路都清计时器；到点那一支只按票上的文档判 `dead`
 * ——现读 `this.doc` 会把 A 的超时记到 B 头上（B 自己的结果随后到达也被拒掉）。
 *
 * ## 丢弃 ≠ 回落
 *
 * 跨文档对不上号、版本落后一版，都是**正常丢弃**（快速打字必然发生），只落 `console.debug`；
 * 进 `fallback.ts` 台账的只有真失败（协议不符 / wasm / 线程崩 / 超时停用 / 整档停用），
 * 因为台账的另一头是作者面的 error 通知。
 *
 * ## 装配期的门控
 *
 * `start()` 只发 `init`，**不发 parse**——worker 要 await 两枚 wasm 才算装配完成，
 * 装配前收到的解析请求会被它拒掉（曾经直接因此整档自杀）。故跟踪文档时若线程还没
 * `ready`，只记下 `pendingParse`，期间的内容变化也只更新本地快照；`ready` 一到就把
 * 暂存的 parse 带着最新全文补发出去。真失败类（协议形状不符 / wasm 载入失败 / 线程崩 /
 * 截断超限）的整档停用语义一个不动。
 *
 * ## 增量的口径
 *
 * `onDidChangeContent` 里可能有多段（多光标 / 粘贴）。这里不逐段翻译，而是拿
 * **代理自己留的上一版文本**与 `model.getValue()` 求一条保守编辑（`edit.ts`），
 * 缝完自检一次：缝出来的文本与模型现读的全文不等 ⇒ 立刻退回整篇重解（增量口径漂了
 * 最多贵一次，绝不能把错的树留在手上继续着色）。
 *
 * 另一侧（worker 里的 `engine.ts`）拿到的是**同一条编辑**：先 `tree.edit()` 把旧树推到位，
 * 再用**有界取字符回调**在新文本上重解，而不是把整篇新文本一次交出去（为什么：
 * 传整串时 web-tree-sitter 内部每次取字都 `text.slice(index)` 复制一遍文档尾巴，
 * 实测把整篇解的 p95 抬到 30 ms 级；口径与读数见 `tests/tree-sitter-parse.perf.test.ts`）。
 *
 * ## 回落的两档（都不碰保存，也不碰转译）
 *
 * - 整档（wasm / 解析 / 协议不符 / 线程崩 / 装配都没完成就超时）⇒ 终止 worker +
 *   `onFatal`，装配层据此拆掉全部 provider，作者回到只有词法层的状态；
 * - 单面（例如 folds 查询没写捕获）⇒ 那一面从此不再等（`dead`），另一面照旧。
 * 两档都经 `fallback.ts` **各说一次**，不随编辑重复。
 *
 * ## 第四条腿：结构残缺（TSIT2-D）是**推**的，不是**问**的
 *
 * 着色与折叠是 Monaco 主动来问（provider），所以有"等一等 + 超时停用"那套；结构残缺没有
 * 任何消费方在 await——worker 每解完一篇就回一条 `syntax`，代理收到就转交给上屏器
 * （`onSyntax`），换轨 / 停用 / 整档回落时转交一次"撤"（`onSyntaxClear`）。
 * 两个回调都在 `try/catch` 里调：上屏是呈现面的事，抛回来会把消息环打断（那是编辑链的邻居）。
 */

/** 一面最多等多久（线程卡住时不许把 provider 的 promise 挂到天荒地老） */
export const STRUCTURE_REQUEST_TIMEOUT_MS = 4_000;

/**
 * 一次取数最多追几轮"当前版本"的结果。
 *
 * 每一轮 = **一条回话**或**一次超时**（不空转），所以正常只有一轮；给 3 轮是给连打时
 * "回话到达与版本推进交错"留余量。打字不停时不把 provider 的 promise 无限挂在链上
 * （Monaco 那边看到的就是"这次还没结果"，屏上保持上一版，不会画错）。
 */
const FACET_READ_ROUNDS = 3;

export type StructureStatus = 'idle' | 'starting' | 'ready' | 'dead';

type FacetName = 'semantic' | 'folds';

/** 一条结果回话属于哪一面（过期丢弃时要用它说清"哪一面的一条没了"，不许再写三元表达式猜） */
function capabilityOfReply(type: 'semantic' | 'folds' | 'indent' | 'syntax'): KojoStructureCapability {
  return type === 'syntax' ? 'syntax' : type === 'indent' ? 'indent' : type;
}

interface FacetResult<T> {
  readonly version: number;
  readonly value: T;
}

interface TrackedDocument {
  readonly model: Monaco.editor.ITextModel;
  /** 跨文档隔离号（全局单调自增）：worker 内容回复原样回显，对不上号的回复整条丢 */
  readonly seq: number;
  /** 代理这一侧的文本快照（与 worker 那一侧逐字相等，靠同一条编辑维持） */
  text: string;
  version: number;
  /** 装配还没完成（status 非 ready）：不发 parse 也不发 change，等 ready 后补发最新全文 */
  pendingParse: boolean;
  readonly subscription: Monaco.IDisposable;
  semantic: FacetResult<readonly KojoStructureToken[]> | null;
  folds: FacetResult<readonly KojoStructureFold[]> | null;
  /** 结构残缺（TSIT2-D）：这一面**不等人问**——到货就推给上屏器，所以没有 `waitFor` 那一步 */
  syntax: FacetResult<readonly KojoStructureSyntaxFault[]> | null;
  /** 最近一次的截断标记（随每次 `syntax` 一起换） */
  syntaxTruncated: boolean;
  /** 已经停用的一面（等也等不来，别再白等；每次换轨重新计） */
  readonly dead: Record<FacetName, boolean>;
  /** 结构残缺这一面停用（错误恢复跑不动 / 扫描抛错 ⇒ 不再推、并把已画的撤下） */
  syntaxDead: boolean;
}

/**
 * 一次在飞的等待。票上带着**它等的那一份文档**：
 *
 * 超时回调只许按票上的文档判——曾经这里现读 `this.doc`，于是 A 文档的计时器在换到 B 之后
 * 才响，`dead` 打在 B 头上，B 自己的结果随后到达也被当成"这一面停了"拒掉。换轨 / 停用时
 * 按票上的文档结算（`abortWaits`），计时器当场清掉，不会 4s 后凭空再响一下。
 */
interface WaitTicket {
  readonly name: FacetName;
  readonly doc: TrackedDocument;
  /** `window.setTimeout` 的句柄（结票时清） */
  handle: number;
  /** 结票：清计时器 + 从两本账里摘掉 + 放行等待者（幂等） */
  settle: () => void;
}

export interface StructureClientV2Options {
  /** 这一门语言的结构层运行时（worker 入口 / 两枚 wasm；由 descriptor 按需交回） */
  readonly runtime: StructureLanguageRuntime;
  /** 超时读数（注入以便测试） */
  timeoutMs?: number;
  /** 整档停用时的通知（装配层在这里拆 provider） */
  onFatal?: (message: string) => void;
  /**
   * 结构残缺到货（TSIT2-D）。`providers.ts` 把它接给 `syntax-decorations.ts` 的上屏器；
   * 回调**不许抛**（上屏是呈现面的事，抛回来会把 worker 的消息环打断），
   * 装配层那边自己也 try/catch。
   */
  onSyntax?: (model: Monaco.editor.ITextModel, faults: readonly KojoStructureSyntaxFault[], truncated: boolean) => void;
  /** 结构残缺这一面撤下（换轨 / 停用 / 整档回落）：撤的是**那一份 model** 的波浪线 */
  onSyntaxClear?: (model: Monaco.editor.ITextModel) => void;
}

export class StructureClientV2 {
  private worker: Worker | null = null;
  private doc: TrackedDocument | null = null;
  private status: StructureStatus = 'idle';
  private latestIndent: FacetResult<KojoStructureIndentRules> | null = null;
  /** 按面分桶的等待者（回话到达时按面 `flush`） */
  private readonly waiters = new Map<FacetName, Set<WaitTicket>>();
  /** 全部在飞票（换轨 / 停用时按票上的文档结算：这是清计时器的唯一入口） */
  private readonly tickets = new Set<WaitTicket>();
  private readonly runtime: StructureLanguageRuntime;
  private readonly timeoutMs: number;
  private readonly onFatal: (message: string) => void;
  /** 文档隔离号的发生器（只增不减；worker 拿它回显，主线程拿它对号） */
  private docSeq = 0;
  private readonly onSyntax: (
    model: Monaco.editor.ITextModel,
    faults: readonly KojoStructureSyntaxFault[],
    truncated: boolean,
  ) => void;
  private readonly onSyntaxClear: (model: Monaco.editor.ITextModel) => void;

  constructor(options: StructureClientV2Options) {
    this.runtime = options.runtime;
    this.timeoutMs = options.timeoutMs ?? STRUCTURE_REQUEST_TIMEOUT_MS;
    this.onFatal = options.onFatal ?? (() => undefined);
    this.onSyntax = options.onSyntax ?? (() => undefined);
    this.onSyntaxClear = options.onSyntaxClear ?? (() => undefined);
  }

  get state(): StructureStatus {
    return this.status;
  }

  /** 最近一次结构缩进规则（没收到 / 三条腿全空 ⇒ null = 宿主一个字都不改） */
  get indent(): KojoStructureIndentRules | null {
    const rules = this.latestIndent?.value ?? null;
    if (!rules) return null;
    return rules.increasePatterns.length + rules.decreasePatterns.length + rules.enterPatterns.length === 0
      ? null
      : rules;
  }

  /** 起线程并投递 `init`；起不来（无 Worker 支持 / 构造抛错）当场整档停用 */
  start(): boolean {
    if (this.status !== 'idle') return this.status === 'starting' || this.status === 'ready';
    const request: KojoStructureRequest = {
      type: 'init',
      protocol: KOJO_STRUCTURE_PROTOCOL,
      wasmUrl: this.runtime.grammarWasmUrl,
      runtimeWasmUrl: this.runtime.runtimeWasmUrl,
    };
    try {
      // LAU-5：运行时不再自带 `createWorker`（线程由池出厂）⇒ 旧路回落到池的统一入口
      const worker = this.runtime.createWorker?.() ?? createStructureThread();
      worker.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
      worker.onerror = (event: ErrorEvent) =>
        this.fatal(`worker 线程报错：${event.message || '（无消息）'}`);
      this.worker = worker;
      this.status = 'starting';
      worker.postMessage(request);
      return true;
    } catch (error: unknown) {
      this.fatal(`worker 启动失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** 这一份文档的结构着色段；`null` = 拿不到 ⇒ 调用方什么都不画（词法层本来就是底） */
  async tokens(model: Monaco.editor.ITextModel): Promise<readonly KojoStructureToken[] | null> {
    const doc = this.track(model);
    if (doc === null || doc.dead.semantic) return null;
    const tokens = await this.awaitFresh(doc, 'semantic', () => doc.semantic);
    if (this.doc !== doc || doc.dead.semantic) return null;
    return tokens;
  }

  async foldingRanges(model: Monaco.editor.ITextModel): Promise<readonly KojoStructureFold[] | null> {
    const doc = this.track(model);
    if (doc === null || doc.dead.folds) return null;
    const folds = await this.awaitFresh(doc, 'folds', () => doc.folds);
    if (this.doc !== doc || doc.dead.folds) return null;
    return folds;
  }

  dispose(): void {
    this.releaseDoc();
    for (const name of ['semantic', 'folds'] as const) this.flush(name);
    const worker = this.worker;
    this.worker = null;
    this.status = 'idle';
    this.latestIndent = null;
    worker?.terminate();
  }

  /* -------------------------------- 内部 -------------------------------- */

  /** 换轨 / 保持跟踪当前文档；线程已死或模型已释放 ⇒ null（调用方什么都不画） */
  private track(model: Monaco.editor.ITextModel): TrackedDocument | null {
    if (this.status === 'dead' || model.isDisposed()) return null;
    if (this.doc !== null && this.doc.model === model && !model.isDisposed()) return this.doc;
    this.releaseDoc();
    if (!this.start()) return null;
    const text = model.getValue();
    const doc: TrackedDocument = {
      model,
      seq: ++this.docSeq,
      text,
      version: 1,
      // 装配没完成就先不发 parse（发了注定被 worker 拒）：等 ready 后补发，自然带上最新全文
      pendingParse: this.status !== 'ready',
      subscription: model.onDidChangeContent(() => this.onChanged()),
      semantic: null,
      folds: null,
      syntax: null,
      syntaxTruncated: false,
      dead: { semantic: false, folds: false },
      syntaxDead: false,
    };
    this.doc = doc;
    if (!doc.pendingParse) this.postParse(doc);
    return doc;
  }

  /** 整篇重解请求（doc 号 + 当前版本 + 当前快照全文） */
  private postParse(doc: TrackedDocument): void {
    this.post({ type: 'parse', doc: doc.seq, version: doc.version, text: doc.text });
  }

  private releaseDoc(): void {
    const doc = this.doc;
    if (doc === null) return;
    doc.subscription.dispose();
    // 换轨 / 停用：这一份文档的在飞票当场结掉（计时器一起清，见 `abortWaits`）
    this.abortWaits(doc);
    // 换轨 / 停用 = 这一份文档的结构波浪线到此为止（留着就是"波浪线指着已经不在眼前的内容"）
    this.safeSyntaxClear(doc.model);
    this.doc = null;
  }

  /** 回调不许把 worker 消息环 / 换轨流程打断（上屏是呈现面的事，失败只由台账说） */
  private safeSyntaxClear(model: Monaco.editor.ITextModel): void {
    try {
      this.onSyntaxClear(model);
    } catch {
      /* 什么都不做：撤装饰失败绝不该让线程或编辑链断掉 */
    }
  }

  private safeSyntax(model: Monaco.editor.ITextModel, faults: readonly KojoStructureSyntaxFault[], truncated: boolean): void {
    try {
      this.onSyntax(model, faults, truncated);
    } catch {
      /* 同上：上屏器抛回来也不许把这一条消息环打断 */
    }
  }

  /** 内容变化 → 一条保守编辑；缝不回去就整篇重解（口径漂了宁可贵一次） */
  private onChanged(): void {
    const doc = this.doc;
    if (doc === null || doc.model.isDisposed() || this.worker === null) return;
    const next = doc.model.getValue();
    if (next === doc.text) return;
    const version = doc.version + 1;
    doc.version = version;
    const previous = doc.text;
    doc.text = next;
    // 装配没完成：只留最新文本与版本，不发 change（worker 那侧的契约是 parse 必然先于
    // change）；ready 后补发的 parse 自带这份快照，中途的编辑自然并入
    if (doc.pendingParse) return;
    const edit = commonEdit(previous, next);
    if (applyEdit(previous, edit) !== next) {
      this.post({ type: 'parse', doc: doc.seq, version, text: next });
      return;
    }
    this.post({
      type: 'change',
      doc: doc.seq,
      version,
      start: edit.start,
      oldEnd: edit.oldEnd,
      newEnd: edit.newEnd,
      newText: edit.newText,
    });
  }

  private post(request: KojoStructureRequest): void {
    this.worker?.postMessage(request);
  }

  /**
   * 等这一面**当前版本**的结果；超时 = 这一面停用（装配都没完成时升级为整档停用）。
   *
   * 每一轮先看缓存：`FacetResult.version` 就是在这里被读的（此前它只写不读——于是缓存里有
   * 上一版结果时，Monaco 来取数会当场拿到**旧 tokens** 上屏；而新结果到达时又没有等待者，
   * 屏上就一直停在那份旧色上，直到下一次编辑）。版本落后一轮同样要走等待，兜底仍是同一个
   * 超时：等不到就不交旧数据（`null` = 这一面这次不顶上），绝不拿过期结构给新文本着色。
   *
   * 一轮 = 一条回话或一次超时，不空转；最多 `FACET_READ_ROUNDS` 轮（见该常量）。
   */
  private async awaitFresh<T>(
    doc: TrackedDocument,
    name: FacetName,
    read: () => FacetResult<T> | null,
  ): Promise<T | null> {
    for (let round = 0; round < FACET_READ_ROUNDS; round += 1) {
      const result = read();
      if (result !== null && result.version >= doc.version) return result.value;
      await this.waitFor(name, doc);
      if (this.doc !== doc || doc.dead[name]) return null;
    }
    return null;
  }

  /**
   * 挂一张等待票（票上带文档：见 {@link WaitTicket}）。
   *
   * 出票的三条出路都会清计时器并从两本账里摘掉：回话到达（`flush`）、换轨 / 停用
   * （`abortWaits`）、到点（本函数里的回调）。到点那一支只按**票上的文档**判：
   * 已经不是当前文档 ⇒ 什么都不判（换轨不是这一面失败），还是当前文档才落 `dead`。
   */
  private waitFor(name: FacetName, doc: TrackedDocument): Promise<void> {
    return new Promise<void>((resolve) => {
      const ticket: WaitTicket = {
        name,
        doc,
        handle: 0,
        settle: () => {
          window.clearTimeout(ticket.handle);
          this.tickets.delete(ticket);
          this.waiters.get(name)?.delete(ticket);
          resolve();
        },
      };
      ticket.handle = window.setTimeout(() => {
        this.tickets.delete(ticket);
        this.waiters.get(name)?.delete(ticket);
        this.expireWait(name, doc);
        resolve();
      }, this.timeoutMs);
      this.tickets.add(ticket);
      let bucket = this.waiters.get(name);
      if (!bucket) {
        bucket = new Set();
        this.waiters.set(name, bucket);
      }
      bucket.add(ticket);
    });
  }

  /**
   * 一张票到点了。三支按次序判：
   * 1. 装配始终没完成（status 非 ready）⇒ 线程本身不可用，整档停用（与哪份文档无关）；
   * 2. 此刻跟踪的已不是这张票的文档 ⇒ **什么都不判**（换轨是正常操作，不是这一面失败）；
   * 3. 否则这一面落 `dead`（别再白等）并进台账说一次——这条是真的回落，作者面该看见。
   */
  private expireWait(name: FacetName, doc: TrackedDocument): void {
    if (this.status !== 'ready') {
      this.fatal(`结构解析装配始终没有完成（${this.timeoutMs}ms 内无 ready/结果）⇒ 整档停用`);
      return;
    }
    if (this.doc !== doc) return;
    reportStructureDegradation({
      capability: name,
      stage: 'parse',
      message: `结构解析 ${this.timeoutMs}ms 内没有回话 ⇒ 这一面这次不顶上（下一份文档再试）`,
    });
    doc.dead[name] = true;
  }

  /** 换轨 / 停用：把这一份文档的在飞票当场结掉（不清计时器 = 4s 后凭空再响一下，还认错文档） */
  private abortWaits(doc: TrackedDocument): void {
    for (const ticket of [...this.tickets]) {
      if (ticket.doc === doc) ticket.settle();
    }
  }

  /** 放行某一面的全部等待者 */
  private flush(name: FacetName): void {
    const bucket = this.waiters.get(name);
    if (bucket === undefined || bucket.size === 0) return;
    for (const ticket of [...bucket]) ticket.settle();
  }

  private fatal(message: string): void {
    if (this.status === 'dead') return;
    this.status = 'dead';
    reportStructureDegradation({ capability: 'all', stage: 'worker', message });
    this.releaseDoc();
    this.flush('semantic');
    this.flush('folds');
    const worker = this.worker;
    this.worker = null;
    this.latestIndent = null;
    worker?.terminate();
    this.onFatal(message);
  }

  /** 装配完成那一刻：抬状态，并把暂存中的首解补发出去（此刻才带最新全文与版本） */
  private promoteToReady(): void {
    if (this.status !== 'starting') return;
    this.status = 'ready';
    const doc = this.doc;
    if (doc === null || !doc.pendingParse) return;
    doc.pendingParse = false;
    this.postParse(doc);
  }

  /**
   * **正常丢弃**（不是回落）：换轨后旧文档的迟到回复、快速打字时落后一版的回复，都属于
   * "我们主动不要它"。这两件事**每敲一次键都会发生**，若进 `fallback.ts` 台账，作者面就会
   * 收到一条「结构着色这次没顶上」的 error——那是真故障才该说的话（与静默同罪的另一面：
   * 把常态说成故障）。
   *
   * 故只落开发面：一行 `console.debug`，带上哪一面、哪一份文档、哪一版，供排查时序。
   * 真失败的几条路（协议不符 / wasm / 线程崩 / 超时停用 / worker 报错）一律照旧进台账。
   */
  private noteDiscarded(
    name: KojoStructureCapability,
    reason: string,
    doc: TrackedDocument | null,
  ): void {
    console.debug(
      `[kojo-structure] ${name}/parse 正常丢弃：${reason}（当前文档 ${doc?.seq ?? '无'}／版本 ${doc?.version ?? '无'}）`,
    );
  }

  private receive(data: unknown): void {
    if (!isLegacyStructureReply(data)) {
      this.fatal('worker 回传的消息形状不符协议 ⇒ 整档停用（不是解析慢，是两侧版本对不上）');
      return;
    }
    if (data.type === 'ready') {
      this.promoteToReady();
      return;
    }
    if (data.type === 'error') {
      if (data.capability === 'all') {
        this.fatal(data.message);
        return;
      }
      reportStructureDegradation({ capability: data.capability, stage: data.stage, message: data.message });
      const doc = this.doc;
      if (doc !== null) {
        if (data.capability === 'semantic' || data.capability === 'folds') {
          doc.dead[data.capability] = true;
          this.flush(data.capability);
        } else if (data.capability === 'syntax') {
          // 这一面停了：已经画出去的要先撤下（不许留着一层没人负责的波浪线）
          doc.syntaxDead = true;
          doc.syntax = null;
          this.safeSyntaxClear(doc.model);
        }
      }
      return;
    }
    this.promoteToReady();
    const doc = this.doc;
    if (doc === null || data.doc !== doc.seq) {
      this.noteDiscarded(
        capabilityOfReply(data.type),
        `收到文档 ${data.doc} 的结果而当前跟踪的是文档 ${doc?.seq ?? '无'} ⇒ 这条丢掉（旧文档的结构着到新文档上比不着色危险）`,
        doc,
      );
      return;
    }
    if (data.version < doc.version) {
      this.noteDiscarded(
        capabilityOfReply(data.type),
        `收到版本 ${data.version} 的结果而当前版本是 ${doc.version} ⇒ 这条丢掉（拿过期结构给新文本着色比不着色危险）`,
        doc,
      );
      return;
    }
    if (data.type === 'semantic') {
      doc.semantic = { version: data.version, value: data.tokens };
      this.flush('semantic');
      return;
    }
    if (data.type === 'folds') {
      doc.folds = { version: data.version, value: data.folds };
      this.flush('folds');
      return;
    }
    if (data.type === 'syntax') {
      if (doc.syntaxDead) return; // 这一面已经停过 ⇒ 不再推（台账也说过一次了）
      doc.syntax = { version: data.version, value: data.faults };
      doc.syntaxTruncated = data.truncated;
      this.safeSyntax(doc.model, data.faults, data.truncated);
      return;
    }
    this.latestIndent = { version: data.version, value: data.rules };
  }
}
