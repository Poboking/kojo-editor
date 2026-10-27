import type * as Monaco from '../entry';
// 与既有 `editor.worker` 同一条 `?worker` 路（vite 后缀），`worker.format` 仍是默认的 iife。
// 踩过的坑记在这里，别下一次再撞：`web-tree-sitter` 的 ESM 带两条 `ENVIRONMENT_IS_NODE`
// 才走到的动态 import（`fs/promises` / `module`），Rollup 只看语法 ⇒ worker 产物要多一枚
// chunk ⇒ iife 拒绝产出（`UMD and IIFE output formats are not supported for code-splitting
// builds`，实测 `pnpm --filter @kojo/app build` 当场失败）。解法在 `vite.config.ts` 的
// `stubNodeOnlyDynamicImports()`：把那两条动态 import 就地换成抛错的 promise——
// **不**抬全局 `worker.format`（那会连 Monaco 自己的 `editor.worker` 一起改成模块 worker，
// 一条实验特性不该动既有 worker 的加载方式），也**不**走 alias 钉桩（alias 生效但动态 import
// 仍在，照样切 chunk）。
import {
  STRUCTURE_BOOTSTRAP_TIMEOUT_MS,
  STRUCTURE_DEAD_AFTER_FAILURES,
  STRUCTURE_PROTOCOL_VERSION,
  STRUCTURE_TIMEOUT_MS,
  type StructureFailureReason,
  type StructureParseReply,
  type StructureRequest,
} from '@kojo/kojo-core';
import { applyEdit, commonEdit } from './edit';
import { reportStructureDegradation } from './fallback';
import { isStructureReply } from './protocol';
import type { StructureLanguageRuntime } from './structure-runtime';
import {
  tierForCapture,
  type KojoStructureFold,
  type KojoStructureIndentRules,
  type KojoStructureSyntaxFault,
  type KojoStructureToken,
} from './types';
import { StructureClientV2, type StructureClientV2Options, type StructureStatus } from './client-v2';

/**
 * 主线程侧的 worker 代理（**v3 薄壳**：这里只发请求、收回复、丢迟到、记账）。
 *
 * ## 一页纸的契约（真源 `packages/kojo-core/src/structure-protocol.ts`）
 *
 * 本类**不认识任何消息形状**——形状全在协议文件里，闸在 `./protocol.ts`。这里剩下的只有
 * 五件事（LAU-1 的 DoD 就是这五件）：
 *
 * 1. **握手**：`open{protocol:3}`；回 `ready{protocol}` 即装配完成。协议号不符（或对面回了一条
 *    看不懂的东西）⇒ **降级到旧路**（见下），不是整档哑火；
 * 2. **发请求**：`parse{doc,version,text}`（整篇：开文件 / 换轨 / 基线对不上时的兜底）
 *    或 `parse{doc,version,edit,baseTreeId}`（差集：每敲一键只发改动那一段）；
 * 3. **收回复**：一次回复带全部面（`facets`），按 `id` 配对、按 `doc` + `version` 对号；
 *    对不上号 = **正常丢弃**（只落 `console.debug`），不冒充、不着色；
 * 4. **丢弃迟到回复**：超时（稳态 4s / 引导期 8s）后把那条从待办表删掉，此后同 `id` 的回话一律丢；
 * 5. **失败账本**：连续 {@link STRUCTURE_DEAD_AFTER_FAILURES} 次失败判死——**ready 之前**判死
 *    整条通道（`onFatal`，装配层据此拆 provider，切设置项或换文档才重来）；**ready 之后**
 *    只死当前文档的那几面（换文档重计），与 §1 代价 2 的既有口径一致。
 *
 * ## 差集逻辑原样保留（v1.1 改口）
 *
 * 一次 content change 里可能有多段（多光标 / 粘贴）：这里不逐段翻译，而是拿**代理自己留的
 * 上一版文本**与 `model.getValue()` 求一条保守编辑（`edit.ts`），缝完自检一次——缝出来的
 * 文本与模型现读的全文不等 ⇒ 立刻退回整篇。发出去的是 `parse{edit, baseTreeId}`：
 * `baseTreeId` 是上一条回复交出的树；worker 说不认识（换过线程 / 上次没解成）⇒ 本类**当场
 * 重发整篇**，不把这一条记成失败（那是协议的正常兜底，不是故障）。
 *
 * ## 降级到旧路（双跑窗口的第二种形态）
 *
 * 抬协议号那一刻，新旧 worker 必须能并存：`open` 拒掉不符的一侧。本类收到
 * `protocol-mismatch`（或 `ready.protocol` 不符、或对面回了一条看不懂的消息）⇒ 当场把这条
 * 语言的结构层交给 `client-v2.ts`（LAU-1 之前的 client，逐字留档），并把在飞的调用**改问旧路**。
 * 作者面看到的是"照旧有结构着色"，不是"整档哑火"。手动回滚见 `StructureClientOptions.protocolMode`。
 *
 * ## 装配期的门控
 *
 * `start()` 只发 `open`，**不发 parse**——worker 要 await 两枚 wasm 才算装配完成。故跟踪文档时
 * 若还没 `ready`，只记下 `pendingParse`，期间的内容变化也只更新本地快照；`ready` 一到就把
 * 暂存的 parse 带着最新全文补发出去（曾经每次必现：主线程的 parse 注定先于 ready 到达）。
 *
 * ## 丢弃 ≠ 回落
 *
 * 跨文档对不上号、版本落后一版，都是**正常丢弃**（快速打字必然发生），只落 `console.debug`；
 * 进 `fallback.ts` 台账的只有真失败（协议不符 / wasm / 线程崩 / 超时判死 / 整档停用），
 * 因为台账的另一头是作者面的 error 通知。
 */

/** 一面最多等多久（与协议里的稳态预算同一格；旧名保留，桩测试按这个名字打） */
export const STRUCTURE_REQUEST_TIMEOUT_MS = STRUCTURE_TIMEOUT_MS;

/** 一次取数最多追几轮"当前版本"的结果（每轮 = 一条回话或一次超时，不空转） */
const FACET_READ_ROUNDS = 3;

export type { StructureStatus };

type FacetName = 'semantic' | 'folds';

interface FacetResult<T> {
  readonly version: number;
  readonly value: T;
}

interface TrackedDocument {
  readonly model: Monaco.editor.ITextModel;
  /** 跨文档隔离号（全局单调自增）：回话原样带回，对不上号的整条丢 */
  readonly seq: number;
  /** 代理这一侧的文本快照（与 worker 那一侧逐字相等，靠同一条编辑维持） */
  text: string;
  version: number;
  /** 装配还没完成：不发 parse，等 `ready` 后补发最新全文 */
  pendingParse: boolean;
  /** 上一次回复交出的树（差集请求的基线；`null` = 还没解过） */
  baseTreeId: string | null;
  readonly subscription: Monaco.IDisposable;
  semantic: FacetResult<readonly KojoStructureToken[]> | null;
  folds: FacetResult<readonly KojoStructureFold[]> | null;
  /** 已经停用的一面（等也等不来，别再白等；每次换轨重新计） */
  readonly dead: Record<FacetName, boolean>;
  /** 结构残缺这一面停用（换轨 / 停用后不再推） */
  syntaxDead: boolean;
  /** 连续失败次数（成功一条回复即清零；到阈值判死，见文件头第 5 条） */
  failures: number;
}

/** 一张等待票：等的是**哪一份文档**（换轨 / 停用时按票结算，计时器当场清） */
interface WaitTicket {
  readonly doc: TrackedDocument;
  handle: number;
  settle: () => void;
}

/** 一条在飞请求（超时后连 `id` 一起从表里删掉，此后的同号回话一律丢） */
interface PendingParse {
  readonly doc: TrackedDocument;
  readonly version: number;
  /** 这条是差集请求（`baseTreeId` 不认识时重发整篇，不计失败） */
  readonly fromEdit: boolean;
  timer: number;
}

export interface StructureClientOptions {
  /** 这一门语言的结构层运行时（worker 入口 / 两枚 wasm；由 descriptor 按需交回） */
  readonly runtime: StructureLanguageRuntime;
  /** 语言 id（只进 `open.languageId`：worker 侧日志与自证用，不做分支） */
  readonly languageId?: string;
  /** 稳态单请求预算（缺省 {@link STRUCTURE_TIMEOUT_MS}） */
  readonly timeoutMs?: number;
  /** 引导期预算（worker 还没回过任何一条；缺省 {@link STRUCTURE_BOOTSTRAP_TIMEOUT_MS}） */
  readonly bootstrapTimeoutMs?: number;
  /**
   * 协议档位（双跑窗口的手动回滚开关）：
   * - `'auto'`（缺省）= 先说 v3，握手被拒 / 对面形状不符就降级到 v2（自动双跑）；
   * - `'legacy'` = 一个字节的 v3 都不发，直接走 `client-v2.ts`（等价于 LAU-1 之前的行为）。
   */
  readonly protocolMode?: 'auto' | 'legacy';
  /** 整档停用时的通知（装配层在这里拆 provider） */
  onFatal?: (message: string) => void;
  /** 结构残缺到货（上屏器；回调不许抛） */
  onSyntax?: (model: Monaco.editor.ITextModel, faults: readonly KojoStructureSyntaxFault[], truncated: boolean) => void;
  /** 结构残缺这一面撤下（换轨 / 停用 / 整档回落） */
  onSyntaxClear?: (model: Monaco.editor.ITextModel) => void;
}

type V2Options = StructureClientV2Options;

export class StructureClient {
  private worker: Worker | null = null;
  private status: StructureStatus = 'idle';
  private doc: TrackedDocument | null = null;
  private latestIndent: FacetResult<KojoStructureIndentRules> | null = null;
  private readonly tickets = new Set<WaitTicket>();
  private readonly pending = new Map<number, PendingParse>();
  private readonly options: StructureClientOptions;
  private readonly runtime: StructureLanguageRuntime;
  private readonly timeoutMs: number;
  private readonly bootstrapTimeoutMs: number;
  private readonly onFatal: (message: string) => void;
  private readonly onSyntax: (
    model: Monaco.editor.ITextModel,
    faults: readonly KojoStructureSyntaxFault[],
    truncated: boolean,
  ) => void;
  private readonly onSyntaxClear: (model: Monaco.editor.ITextModel) => void;
  /** 文档隔离号的发生器（只增不减） */
  private docSeq = 0;
  private nextId = 1;
  /** 回过话没有（决定用哪一档预算；与 kojo2 同口径） */
  private answered = false;
  /** 迟到 / 对不上号的回话条数（诊断用） */
  private lateReplies = 0;
  /** 还没有文档可归属的失败次数（`parse` 之外的那几类；装配期判死用） */
  private channelFailures = 0;
  /** 降级目标（一旦非 null，这条语言的结构层就由旧 client 说话） */
  private fallback: StructureClientV2 | null = null;
  /** 引导期的 `open` 计时器（装配期唯一一条请求；到点 = 对面不认 v3 或装不上） */
  private openTimer: number | null = null;

  constructor(options: StructureClientOptions) {
    this.options = options;
    this.runtime = options.runtime;
    this.timeoutMs = options.timeoutMs ?? STRUCTURE_TIMEOUT_MS;
    this.bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? STRUCTURE_BOOTSTRAP_TIMEOUT_MS;
    this.onFatal = options.onFatal ?? (() => undefined);
    this.onSyntax = options.onSyntax ?? (() => undefined);
    this.onSyntaxClear = options.onSyntaxClear ?? (() => undefined);
    if (options.protocolMode === 'legacy') this.adoptLegacy('调用方选了 protocolMode: legacy（手动回滚）');
  }

  /**
   * 降级目标（读一次就走 getter：直接读 `this.fallback` 会被上一行的 `!== null` 收窄成
   * `never`，TypeScript 不知道 `await` 之后它可能变了）。
   */
  private get legacy(): StructureClientV2 | null {
    return this.fallback;
  }

  get state(): StructureStatus {
    const legacy = this.legacy;
    return legacy !== null ? legacy.state : this.status;
  }

  /** 迟到 / 对不上号的回话条数（诊断用；不参与判据） */
  get discardedReplies(): number {
    return this.lateReplies;
  }

  /** 最近一次结构缩进规则（没收到 / 三条腿全空 ⇒ null = 宿主一个字都不改） */
  get indent(): KojoStructureIndentRules | null {
    const legacy = this.legacy;
    if (legacy !== null) return legacy.indent;
    const rules = this.latestIndent?.value ?? null;
    if (!rules) return null;
    return rules.increasePatterns.length + rules.decreasePatterns.length + rules.enterPatterns.length === 0
      ? null
      : rules;
  }

  /** 起线程并投递 `open`；起不来（无 Worker 支持 / 构造抛错）当场整档停用 */
  start(): boolean {
    const legacy = this.legacy;
    if (legacy !== null) return legacy.start();
    if (this.status !== 'idle') return this.status === 'starting' || this.status === 'ready';
    const request: StructureRequest = {
      id: this.nextId++,
      kind: 'open',
      protocol: STRUCTURE_PROTOCOL_VERSION,
      languageId: this.options.languageId ?? 'unknown',
      runtimeWasmUrl: this.runtime.runtimeWasmUrl,
      grammarWasmUrl: this.runtime.grammarWasmUrl,
    };
    try {
      const worker = this.runtime.createWorker();
      worker.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
      worker.onerror = (event: ErrorEvent) =>
        this.fatal(`worker 线程报错：${event.message || '（无消息）'}`);
      this.worker = worker;
      this.status = 'starting';
      worker.postMessage(request);
      this.armOpenTimer();
      return true;
    } catch (error: unknown) {
      this.fatal(`worker 启动失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** 这一份文档的结构着色段；`null` = 拿不到 ⇒ 调用方什么都不画（词法层本来就是底） */
  async tokens(model: Monaco.editor.ITextModel): Promise<readonly KojoStructureToken[] | null> {
    const early = this.legacy;
    if (early !== null) return early.tokens(model);
    const doc = this.track(model);
    if (doc === null || doc.dead.semantic) return null;
    const tokens = await this.awaitFresh<readonly KojoStructureToken[]>(doc, 'semantic');
    // 在飞的这一趟里可能刚降级：当场改问旧路（否则这一屏要等到下一次击键才有色）
    const legacy = this.legacy;
    if (legacy !== null) return legacy.tokens(model);
    if (this.doc !== doc || doc.dead.semantic) return null;
    return tokens;
  }

  async foldingRanges(model: Monaco.editor.ITextModel): Promise<readonly KojoStructureFold[] | null> {
    const early = this.legacy;
    if (early !== null) return early.foldingRanges(model);
    const doc = this.track(model);
    if (doc === null || doc.dead.folds) return null;
    const folds = await this.awaitFresh<readonly KojoStructureFold[]>(doc, 'folds');
    const legacy = this.legacy;
    if (legacy !== null) return legacy.foldingRanges(model);
    if (this.doc !== doc || doc.dead.folds) return null;
    return folds;
  }

  dispose(): void {
    this.clearOpenTimer();
    this.releaseDoc();
    this.settleAll();
    const worker = this.worker;
    this.worker = null;
    for (const entry of this.pending.values()) window.clearTimeout(entry.timer);
    this.pending.clear();
    this.status = 'idle';
    this.latestIndent = null;
    worker?.terminate();
    const fallback = this.fallback;
    this.fallback = null;
    fallback?.dispose();
  }

  /* -------------------------------- 内部 -------------------------------- */

  /**
   * 降级到旧 client（v2）：**双跑窗口的第二条腿**。
   *
   * 只有一条纪律：降级本身不许再抛、也不许把作者面变成"结构层没了"——旧 client 会从这个
   * 时刻起接手当前文档（下一次 `tokens()` / `foldingRanges()` 直接问它）。
   */
  private adoptLegacy(why: string): void {
    if (this.fallback !== null) return;
    this.clearOpenTimer();
    console.debug(`[kojo-structure] v3 通道交给旧路（v2）：${why}`);
    const options: V2Options = {
      runtime: this.runtime,
      timeoutMs: this.timeoutMs,
      onFatal: this.onFatal,
      onSyntax: this.onSyntax,
      onSyntaxClear: this.onSyntaxClear,
    };
    this.releaseDoc();
    this.settleAll();
    for (const entry of this.pending.values()) window.clearTimeout(entry.timer);
    this.pending.clear();
    const worker = this.worker;
    this.worker = null;
    if (this.status !== 'dead') this.status = 'ready';
    worker?.terminate();
    this.fallback = new StructureClientV2(options);
    this.fallback.start();
  }

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
      // 装配没完成就先不发 parse（发了注定被拒）：等 ready 后补发，自然带上最新全文
      pendingParse: this.status !== 'ready',
      baseTreeId: null,
      subscription: model.onDidChangeContent(() => this.onChanged()),
      semantic: null,
      folds: null,
      dead: { semantic: false, folds: false },
      syntaxDead: false,
      failures: 0,
    };
    this.doc = doc;
    if (!doc.pendingParse) this.postParse(doc);
    return doc;
  }

  /** 整篇请求（`doc` 号 + 当前版本 + 当前快照全文） */
  private postParse(doc: TrackedDocument): void {
    this.post({
      id: this.nextId++,
      kind: 'parse',
      doc: doc.seq,
      version: doc.version,
      text: doc.text,
    }, doc, false);
  }

  private releaseDoc(): void {
    const doc = this.doc;
    if (doc === null) return;
    doc.subscription.dispose();
    this.abortWaits(doc);
    for (const [id, entry] of [...this.pending]) {
      if (entry.doc !== doc) continue;
      window.clearTimeout(entry.timer);
      this.pending.delete(id);
    }
    // 换轨 = 这一份文档的结构波浪线到此为止（留着就是"波浪线指着已经不在眼前的内容"）
    this.safeSyntaxClear(doc.model);
    this.doc = null;
  }

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
    // 装配没完成：只留最新文本与版本，不发请求；ready 后补发的整篇自带这份快照
    if (doc.pendingParse) return;
    const edit = commonEdit(previous, next);
    if (applyEdit(previous, edit) !== next || doc.baseTreeId === null) {
      this.postParse(doc);
      return;
    }
    this.post(
      {
        id: this.nextId++,
        kind: 'parse',
        doc: doc.seq,
        version,
        edit,
        baseTreeId: doc.baseTreeId,
      },
      doc,
      true,
    );
  }

  private post(request: StructureRequest, doc: TrackedDocument, fromEdit: boolean): void {
    const worker = this.worker;
    if (worker === null) return;
    if (request.kind !== 'parse') {
      worker.postMessage(request);
      return;
    }
    const budget = this.answered ? this.timeoutMs : this.bootstrapTimeoutMs;
    const timer = window.setTimeout(() => {
      this.pending.delete(request.id);
      this.noteFailure(doc, 'timeout', `结构解析 ${budget}ms 内没有回话（请求 #${request.id}）`);
    }, budget);
    this.pending.set(request.id, { doc, version: request.version, fromEdit, timer });
    try {
      worker.postMessage(request);
    } catch (error: unknown) {
      window.clearTimeout(timer);
      this.pending.delete(request.id);
      this.fatal(`worker 投递失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 等这一面**当前版本**的结果；超时 = 这一面这次不顶上（并发失败会累计到判死）。
   *
   * 每一轮先看缓存（版本落后就继续等），兜底是同一个"等回话或超时"：等不到就不交旧数据
   * （`null` = 这一面这次不顶上），绝不拿过期结构给新文本着色。
   */
  private async awaitFresh<T>(doc: TrackedDocument, name: FacetName): Promise<T | null> {
    for (let round = 0; round < FACET_READ_ROUNDS; round += 1) {
      const result = name === 'semantic' ? (doc.semantic as FacetResult<T> | null) : (doc.folds as FacetResult<T> | null);
      if (result !== null && result.version >= doc.version) return result.value;
      const timedOut = await this.waitFor(doc);
      if (this.doc !== doc || doc.dead[name] || this.status === 'dead') return null;
      if (this.legacy !== null) return null;
      if (timedOut) return null;
      // 票是被"别的面到货"放行的：这一面仍然没数据 ⇒ 这次不顶上，别再空转一轮
      const again = name === 'semantic' ? doc.semantic : doc.folds;
      if (again === null || again.version < doc.version) return null;
    }
    return null;
  }

  /**
   * 挂一张等待票（票上带文档：回话到达 / 换轨 / 停用 / 到点，四条出路都清计时器）。
   *
   * 返回值 = **这张票是到点放行的**（不是被回话放行的）。到点这一支记一次失败：
   * 与请求计时器**互斥**——一条在飞的请求到点会先把票放行（`resolve(false)`），
   * 于是同一次等待里只有一处记账（{@link awaitFresh} 每条等待只走一张票）。
   */
  private waitFor(doc: TrackedDocument): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const budget = this.answered ? this.timeoutMs : this.bootstrapTimeoutMs;
      const ticket: WaitTicket = {
        doc,
        handle: 0,
        settle: () => {
          window.clearTimeout(ticket.handle);
          this.tickets.delete(ticket);
          resolve(false);
        },
      };
      ticket.handle = window.setTimeout(() => {
        this.tickets.delete(ticket);
        this.noteFailure(doc, 'timeout', `结构解析 ${budget}ms 内没有回话（这一面这次不顶上）`);
        resolve(true);
      }, budget);
      this.tickets.add(ticket);
    });
  }

  /** 放行等着这份文档的全部票 */
  private flush(doc: TrackedDocument): void {
    for (const ticket of [...this.tickets]) if (ticket.doc === doc) ticket.settle();
  }

  private settleAll(): void {
    for (const ticket of [...this.tickets]) ticket.settle();
  }

  private abortWaits(doc: TrackedDocument): void {
    this.flush(doc);
  }

  /**
   * 失败账本（v3 的 `ok:false` / 超时 / 形状不符都走这里）。
   *
   * 口径（§1 代价 2）：
   * - **ready 之前**：通道本身不可用 ⇒ 累计到阈值判死**整档**（`onFatal`，装配层拆 provider；
   *   作者切 tree-sitter 设置项或换文档前不再重来）；
   * - **ready 之后**：只死**当前文档**那几面（换文档重计），另一份文档照旧能问。
   *
   * 判死之前每一条都进 `fallback.ts` 台账（真的回落，作者面该看见一次）；判死时补一条 `all`。
   */
  private noteFailure(doc: TrackedDocument | null, reason: StructureFailureReason, message: string): void {
    if (this.fallback !== null || this.status === 'dead') return;
    const before = this.status !== 'ready';
    if (doc !== null) doc.failures += 1;
    else this.channelFailures += 1;
    const failures = doc !== null ? doc.failures : this.channelFailures;
    if (failures < STRUCTURE_DEAD_AFTER_FAILURES) {
      if (before) {
        // 装配期的单次慢不惊动作者面（那只是"还没好"），但账照记：连着 3 次就判死
        console.debug(`[kojo-structure] 装配期失败 ${failures}/${STRUCTURE_DEAD_AFTER_FAILURES}：${message}`);
      } else {
        reportStructureDegradation({
          capability: 'semantic',
          stage: stageOf(reason),
          message: `${message}（连续 ${failures}/${STRUCTURE_DEAD_AFTER_FAILURES}；到阈值这一份文档的结构层就不再等）`,
        });
      }
      if (doc !== null) this.flush(doc);
      return;
    }
    if (before) {
      // ready 之前判死 = 整档（`fatal` 自己会说一条 `all`）
      this.fatal(`${message}（装配期连续 ${STRUCTURE_DEAD_AFTER_FAILURES} 次失败）`);
      return;
    }
    doc!.dead.semantic = true;
    doc!.dead.folds = true;
    doc!.syntaxDead = true;
    this.safeSyntaxClear(doc!.model);
    reportStructureDegradation({
      capability: 'semantic',
      stage: stageOf(reason),
      message: `${message} ⇒ 这一份文档的结构层不再等（换文档重计；装配层与设置项不受影响）`,
    });
    this.flush(doc!);
  }

  private fatal(message: string): void {
    if (this.status === 'dead') return;
    this.clearOpenTimer();
    this.status = 'dead';
    reportStructureDegradation({ capability: 'all', stage: 'worker', message });
    this.releaseDoc();
    this.settleAll();
    for (const entry of this.pending.values()) window.clearTimeout(entry.timer);
    this.pending.clear();
    const worker = this.worker;
    this.worker = null;
    this.latestIndent = null;
    worker?.terminate();
    this.onFatal(message);
  }

  /** 挂上引导期的 `open` 计时器（到点 = 对面不认 v3 / 装不上，见 {@link onOpenTimeout}） */
  private armOpenTimer(): void {
    this.clearOpenTimer();
    this.openTimer = window.setTimeout(() => this.onOpenTimeout(), this.bootstrapTimeoutMs);
  }

  private clearOpenTimer(): void {
    if (this.openTimer === null) return;
    window.clearTimeout(this.openTimer);
    this.openTimer = null;
  }

  /**
   * 装配期一条回话都没有（`open` 到点）。两支：
   *
   * 1. **还能试旧路**（双跑窗口）⇒ 当场交给 `client-v2.ts`——旧 worker 不认识 `open`，
   *    它只会静默丢掉，于是"没有回话"就是"对面还是旧形状"的**唯一**可观测信号；
   * 2. **旧路也用过了**（或本来就是 `protocolMode: 'legacy'`）⇒ 整档停用。
   *
   * 为什么这里不像稳态那样攒 3 次：装配期只有一条请求（`open`），重复它不会得到新信息，
   * 而"装配始终不完成"本身就是判据（v2 那条路在同一格上是第一次超时就整档停用）。
   */
  private onOpenTimeout(): void {
    this.openTimer = null;
    if (this.status !== 'starting' || this.answered) return;
    const legacy = this.legacy;
    if (legacy === null) {
      this.adoptLegacy(`${this.bootstrapTimeoutMs}ms 内装配没有任何回话（对面多半是旧 worker，它不认识 open）`);
      return;
    }
    this.fatal(`结构解析装配始终没有完成（${this.bootstrapTimeoutMs}ms 内无 ready）⇒ 整档停用`);
  }

  /** 装配完成那一刻：抬状态，并把暂存中的首解补发出去（此刻才带最新全文与版本） */
  private promoteToReady(): void {
    if (this.status !== 'starting') return;
    this.clearOpenTimer();
    this.status = 'ready';
    const doc = this.doc;
    if (doc === null || !doc.pendingParse) return;
    doc.pendingParse = false;
    this.postParse(doc);
  }

  /** 正常丢弃（不是回落）：只落开发面一行，供排查时序 */
  private noteDiscarded(what: string, doc: TrackedDocument | null): void {
    this.lateReplies += 1;
    console.debug(
      `[kojo-structure] ${what}/parse 正常丢弃（当前文档 ${doc?.seq ?? '无'}／版本 ${doc?.version ?? '无'}）`,
    );
  }

  /** 收件闸 → 分派（v3 只有 `ready` / `parse` 两条成功路，失败一律 `ok:false`） */
  private receive(data: unknown): void {
    if (!isStructureReply(data)) {
      if (this.status === 'starting' || !this.answered) {
        // 对面回了一条听不懂的东西：最省事的解释就是"两侧版本对不上" ⇒ 交给旧路（双跑窗口）
        this.adoptLegacy('worker 回传的消息形状不符 v3 协议（多半是对面还是旧 worker）');
        return;
      }
      this.fatal('worker 回传的消息形状不符协议 ⇒ 整档停用（不是解析慢，是两侧版本对不上）');
      return;
    }
    if (data.ok === false) {
      if (data.reason === 'protocol-mismatch') {
        this.adoptLegacy(`open 握手被拒：${data.message}`);
        return;
      }
      const doc = this.doc;
      if (doc !== null && data.reason === 'parse-failed') {
        const retry = [...this.pending.values()].some((entry) => entry.doc === doc && entry.fromEdit);
        if (retry) {
          // 基线树不认识 = 差集口径的正常兜底（不是故障）：当场重发整篇，且不记失败
          for (const [id, entry] of [...this.pending]) {
            if (entry.doc !== doc || !entry.fromEdit) continue;
            window.clearTimeout(entry.timer);
            this.pending.delete(id);
          }
          this.postParse(doc);
          return;
        }
      }
      for (const [id, entry] of [...this.pending]) {
        if (entry.doc !== doc) continue;
        window.clearTimeout(entry.timer);
        this.pending.delete(id);
      }
      this.noteFailure(doc, data.reason, `worker 报 ${data.reason}：${data.message}`);
      return;
    }
    this.answered = true;
    if (data.kind === 'ready') {
      if (data.protocol !== STRUCTURE_PROTOCOL_VERSION) {
        this.adoptLegacy(`worker 认的协议是 ${data.protocol}（本宿主说 ${STRUCTURE_PROTOCOL_VERSION}）`);
        return;
      }
      this.promoteToReady();
      return;
    }
    this.promoteToReady();
    this.acceptParse(data);
  }

  private acceptParse(reply: StructureParseReply): void {
    const entry = this.pending.get(reply.id);
    if (entry === undefined) {
      this.noteDiscarded(`回话 #${reply.id} 不在待办表里`, this.doc);
      return;
    }
    window.clearTimeout(entry.timer);
    this.pending.delete(reply.id);
    const doc = entry.doc;
    if (this.doc !== doc) {
      this.noteDiscarded(`收到文档 ${reply.doc} 的结果而当前跟踪的是文档 ${this.doc?.seq ?? '无'}`, this.doc);
      return;
    }
    if (reply.doc !== doc.seq) {
      this.noteDiscarded(`收到文档 ${reply.doc} 的结果而当前跟踪的是文档 ${doc.seq}`, doc);
      return;
    }
    if (reply.version < doc.version) {
      this.noteDiscarded(`收到版本 ${reply.version} 的结果而当前版本是 ${doc.version}`, doc);
      return;
    }
    doc.failures = 0;
    if (reply.treeId.length > 0) doc.baseTreeId = reply.treeId;
    const facets = reply.facets;
    if (facets.semantic !== undefined) {
      doc.semantic = { version: reply.version, value: this.tokensOf(facets.semantic) };
    } else if (!doc.dead.semantic) {
      this.markFacetMissing(doc, 'semantic');
    }
    if (facets.folds !== undefined) {
      const spans = facets.folds.spans;
      const folds: KojoStructureFold[] = [];
      for (let i = 0; i + 1 < spans.length; i += 2) folds.push({ startRow: spans[i]!, endRow: spans[i + 1]! });
      doc.folds = { version: reply.version, value: folds };
    } else if (!doc.dead.folds) {
      this.markFacetMissing(doc, 'folds');
    }
    if (facets.indent !== undefined) this.latestIndent = { version: reply.version, value: facets.indent };
    if (facets.syntax !== undefined && !doc.syntaxDead) {
      this.safeSyntax(doc.model, facets.syntax.faults, facets.syntax.truncated);
    }
    this.flush(doc);
  }

  /**
   * 请求了这一面而回话里没有它 ⇒ 这一面这次没算（查询不可用 / 编译失败 / 这一趟没算）。
   *
   * 判**停用**而不是"再等一轮"：worker 缺一面是确定性的，多等一轮只是把 4s 的等待重来一遍。
   * 说一次（台账去重），并注明原因在 worker 控制台（v3 的失败回话没有"哪一面"这一格）。
   */
  private markFacetMissing(doc: TrackedDocument, name: FacetName): void {
    doc.dead[name] = true;
    reportStructureDegradation({
      capability: name,
      stage: 'query',
      message: `这一面这次没回结果（查询不可用或编译失败，原因见 worker 控制台）⇒ 这一面已退回原来的做法`,
    });
    this.flush(doc);
  }

  /**
   * 扁平捕获表 → 宿主 token（**用户 2026-10-27 的 D4 口径**：worker 只说查到什么，
   * 翻成哪一档由宿主决定）。
   *
   * 档位表与 worker 侧同源（`runtime.captureTier` 缺省 = `types.ts::tierForCapture`），
   * 表外捕获不着色并说一次——绝不挑个"最像的"凑数。
   */
  private tokensOf(table: NonNullable<StructureParseReply['facets']['semantic']>): KojoStructureToken[] {
    const mapTier = this.runtime.captureTier ?? tierForCapture;
    const tokens: KojoStructureToken[] = [];
    const spans = table.spans;
    for (let i = 0; i + 5 < spans.length; i += 6) {
      const name = table.names[spans[i + 4]!] ?? '';
      const node = table.nodes[spans[i + 5]!] ?? '';
      const tier = mapTier(name, node);
      if (tier === undefined) continue; // 语言入口明说"这枚捕获不供着色"
      if (tier === null) {
        this.warnUnmapped(name);
        continue;
      }
      tokens.push({
        startRow: spans[i]!,
        startCol: spans[i + 1]!,
        endRow: spans[i + 2]!,
        endCol: spans[i + 3]!,
        tier,
        capture: name,
        node,
      });
    }
    return tokens;
  }

  private readonly warnedCaptures = new Set<string>();

  private warnUnmapped(capture: string): void {
    if (this.warnedCaptures.has(capture)) return;
    this.warnedCaptures.add(capture);
    reportStructureDegradation({
      capability: 'semantic',
      stage: 'query',
      message: `highlights 查询里的捕获 @${capture} 没有档位映射 ⇒ 该类节点不着色（在档位表里登记，或从查询里删掉）`,
      partial: true,
    });
  }
}

/** 失败原因 → 台账的阶段（作者面文案按阶段翻人话，见 `fallback.ts`） */
function stageOf(reason: StructureFailureReason): 'wasm' | 'parse' | 'query' | 'worker' {
  if (reason === 'wasm-load-failed') return 'wasm';
  if (reason === 'query-failed') return 'query';
  if (reason === 'crashed' || reason === 'unavailable' || reason === 'disposed') return 'worker';
  return 'parse';
}
