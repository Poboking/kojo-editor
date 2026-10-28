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
  type StructureFacet,
  type StructureFailureReason,
  type StructureParseReply,
  type StructureRequest,
} from '@kojo/kojo-core';
import { applyEdit, countNewlines, editFromChanges } from './edit';
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
import { acquireStructureThread, type StructureThreadLease } from './structure-pool';

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
 * ## 增量编辑（v1.1 的差集 → 2026-10-28 的事件驱动）
 *
 * 一次 content change 里可能有多段（多光标 / 粘贴）：这里不逐段翻译，而是把它们并成**一条**
 * 保守编辑（`edit.ts` 的 `editFromChanges`）。旧口径是拿代理自己留的上一版文本与
 * `model.getValue()` 求差集——**每次击键一遍全文**，1.36 MB 实测 10.7 ms，全落在主线程的
 * 输入路径上。现在直接吃事件给的 `rangeOffset / rangeLength / text / 行列`（O(改动数)，
 * 与文档长度无关），用 `applyEdit`（SlicedString，实测 0.01 ms）推进本地快照；"这一版对不对"
 * 的自检从"缝出来的全文 == `getValue()`"换成 **O(1) 的行数对账**（`doc.lines` vs
 * `model.getLineCount()`），对不上就退回整篇。
 *
 * 发出去的是 `parse{edit, baseTreeId}`：`baseTreeId` 是上一条回复交出的树；worker 说不认识
 * （换过线程 / 上次没解成）⇒ 本类**当场重发整篇**，不把这一条记成失败（那是协议的正常兜底，
 * 不是故障）。
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

/**
 * 首帧分层（R8，2026-10-28）：**能折叠 → 有颜色 → 其余**，一拍一条请求。
 *
 * 为什么必须分拍：worker 是"一条请求一条回话"（`worker-bootstrap.ts::assemble` 把这一趟要的
 * 几面拼进同一条 `facets`）⇒ 一条回话里，折叠的到达时刻被**排在它前面的查询**顶着，
 * 而且是**这一拍里最慢那一面**说了算。
 *
 * 24,197 行真语料（ERB 语法 `M_KOJO_K139_日常系コマンド.ERB`）、每轮新引擎、同机 A/B 中位：
 *
 * | 时序 | 折叠到 | 着色到 | 整趟 |
 * |---|---|---|---|
 * | 一条回话（R8 前） | **392.0 ms** | 392.0 ms | 392.0 ms |
 * | 三条拍（本实现） | **186.4 ms** | **245.1 ms** | 364.4 ms |
 *
 * 拍序的三条理由：
 * - 第一拍**只折叠**：它是"文件能不能收起块"的可用性，也是四面里最便宜的一面；缩进不跟着——
 *   它在 ERB 语法上有真捕获（`erb-syntax-tree/queries/indents.scm` 的 `@indent.begin` 一族），
 *   塞进来实测 +46 ms，把首帧挤出判据档；
 * - 第二拍**只语义**：着色单独一拍比"语义+残缺"一起走**早 108 ms**（353 → 245）——回话要等
 *   这一拍里所有面算完才发出去，所以"最不挡路的"必须排在最后；
 * - 第三拍 `indent` + `syntax`：回车规则与波浪线，都不挡前面两件事。缩进到货由
 *   {@link StructureClientOptions.onIndent} 当场落到语言配置上（否则第一次回车吃基底规则）。
 *
 * 代价：每一拍都要把全文再投一次（`parse` 的 `text` 是必填格）。852 KB 一次 postMessage 是
 * 亚毫秒级；第二、三拍在 worker 侧**不重解**——文本一字未变，树还是那棵树
 * （`engine.ts::parse` 头注那条闸）。
 */
const FRAME_BEATS: readonly (readonly StructureFacet[])[] = [['folds'], ['semantic'], ['indent', 'syntax']];

/** `want` 缺省（= 全带）展开成的全集（只用于按拍过滤，顺序无关） */
const ALL_FACETS: readonly StructureFacet[] = ['semantic', 'folds', 'indent', 'syntax'];

/** 这一份文档的拍序：按 `want` 滤掉不要的面，再去掉空拍（空表 = 一拍都不发） */
function frameBeats(want: readonly StructureFacet[] | undefined): readonly (readonly StructureFacet[])[] {
  const wish = want ?? ALL_FACETS;
  return FRAME_BEATS.map((beat) => beat.filter((facet) => wish.includes(facet))).filter((beat) => beat.length > 0);
}

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
  /** 快照的行数（与 `model.getLineCount()` 比，是增量口径的廉价自检，见 `onChanged`） */
  lines: number;
  version: number;
  /**
   * 这一份文档要哪几面（`undefined` = 全部）。**由装配层判定**（体量档 / 语言声明），
   * 客户端只负责把它带进每一条 `parse` 请求——worker 侧据此跳过没人消费的查询。
   */
  readonly want: readonly StructureFacet[] | undefined;
  /**
   * 还没发出去的拍（`[]` = 没有下一拍了，见 {@link FRAME_BEATS}）。
   *
   * 它的另一个职责是给 {@link StructureClient.awaitFresh} 看："这一面还没到 ≠ 这次没有"——
   * 拍还在飞时语义那面必须继续等，不许因为折叠先到就交回 null（那会让这一屏没颜色，
   * 而 Monaco 要等到下一次内容变化才会再问一次）。
   */
  beats: readonly (readonly StructureFacet[])[];
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
  /** 这一条要了哪几面（缺省 = 全部）——回话里缺一面时，只有"要过"才算它没来 */
  readonly want: readonly StructureFacet[] | undefined;
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
  /**
   * 这一份文档要哪几面（缺省 = 全部）。装配层按**体量档 / 语言声明**回答；客户端不算这件事。
   *
   * 存在的理由：worker 的 `parse` 在 `want` 缺省时会把四面全查一遍。大文件上语义那一面
   * 本来就不供（`providers.ts` 的体量闸），全查只是白烧——24,197 行 ERB 实测
   * 365 ms（四面）vs 299 ms（折叠+缩进+残缺），差 66 ms，与文档长度同阶。
   */
  readonly facetsFor?: (model: Monaco.editor.ITextModel) => readonly StructureFacet[] | undefined;
  /**
   * 结构缩进规则到货（`indent` 这一面归在**第二拍**，见 {@link FIRST_BEAT}）。
   *
   * 装配层在这里把它落到语言配置上（`providers.ts::syncIndentConfig`）——第一拍不等这一面，
   * 所以"折叠先上"之后必须有个地方把回车规则补进去；不然作者开大文件后第一次回车会吃基底规则。
   */
  readonly onIndent?: (model: Monaco.editor.ITextModel) => void;
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
  /** 缩进规则到货（第二拍）——缺省什么都不做（只有装配层知道该往哪份语言配置上写） */
  private readonly onIndent: (model: Monaco.editor.ITextModel) => void;
  /** 文档隔离号的发生器（只增不减） */
  private docSeq = 0;
  /** 池租约（LAU-5）；`dispose()` 时还回池子而不是杀线程 */
  private lease: StructureThreadLease | null = null;
  /** 这条通道的 `doc` 号段起点（`ready.docBase`；单引擎 worker 回 0） */
  private docBase = 0;
  /** 线程还能不能还回池子（`fatal` 之后不能：那具线程已经不可信） */
  private reusable = true;
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
    this.onIndent = options.onIndent ?? (() => undefined);
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
      // LAU-5：从池里**借**线程（同一运行时下复用上一具，`Parser.init` 与已装文法都不重付）
      const lease = acquireStructureThread(this.runtime);
      this.lease = lease;
      const worker = lease.worker;
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
    this.docBase = 0;
    // LAU-5：好线程还回池子（下次开 = `ready{loadMs:0}`），坏线程（fatal 过）直接杀
    this.lease?.release(this.reusable && worker !== null);
    this.lease = null;
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
    // 协议不符 / 对面还是旧 worker ⇒ 这具线程不进池（它说的不是本版协议），当场收掉
    this.reusable = false;
    if (this.lease !== null) {
      this.lease.release(false);
      this.lease = null;
    } else {
      worker?.terminate();
    }
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
      lines: model.getLineCount(),
      version: 1,
      want: this.options.facetsFor?.(model),
      // 后续拍由前一拍的回话触发（见 `acceptParse`）；这里先清空
      beats: [],
      // 装配没完成就先不发 parse（发了注定被拒）：等 ready 后补发，自然带上最新全文
      pendingParse: this.status !== 'ready',
      baseTreeId: null,
      subscription: model.onDidChangeContent((event) => this.onChanged(event)),
      semantic: null,
      folds: null,
      dead: { semantic: false, folds: false },
      syntaxDead: false,
      failures: 0,
    };
    this.doc = doc;
    // 开文件走两拍：折叠先上（R8）
    if (!doc.pendingParse) this.postParse(doc, doc.want, true);
    return doc;
  }

  /**
  /**
   * 线上真正发的 `doc` 号 = 通道号段起点 + 本客户端自己的序号（LAU-5 / v4）。
   *
   * worker 只认 `doc`（它按 `docBase ≤ doc` 找引擎），所以两个客户端的序号撞在一起也没关系
   * ——只要 `docBase` 不同，号段就不重叠。回话比对用同一个函数，两侧不会各算各的。
   */
  private docIdOf(doc: TrackedDocument): number {
    return this.docBase + doc.seq;
  }

  /**
   * 整篇请求（`doc` 号 + 当前版本 + 当前快照全文）。
   *
   * `staged` = 走首帧分层的拍序（{@link FRAME_BEATS}）：这一条只发第一拍，其余的排进
   * `doc.beats`，由 `acceptParse` 在每条回话之后依次发出去。
   *
   * 其余路径（改动兜底 / 基线树对不上时的重发）**一拍到底**：那时作者已经在打字，
   * 折叠早就在屏幕上了，再分拍只是白付投递钱。
   */
  private postParse(doc: TrackedDocument, want: readonly StructureFacet[] | undefined = doc.want, staged = false): void {
    if (!staged) {
      doc.beats = [];
      this.postParseRequest(doc, want);
      return;
    }
    const beats = frameBeats(want);
    doc.beats = beats.slice(1);
    const first = beats[0];
    if (first === undefined) return; // 一面都不要（`want: []`）⇒ 一条都不发
    this.postParseRequest(doc, first);
  }

  /** 发一条整篇 `parse`（`doc.beats` 里还剩几拍决定"缺面算不算没来"，见 `acceptParse`） */
  private postParseRequest(doc: TrackedDocument, want: readonly StructureFacet[] | undefined): void {
    this.post({
      id: this.nextId++,
      kind: 'parse',
      doc: this.docIdOf(doc),
      version: doc.version,
      text: doc.text,
      ...(want === undefined ? {} : { want }),
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

  /**
   * 内容变化 → 一条保守编辑（**事件路**，2026-10-28）。
   *
   * ## 为什么不再每击键读全文
   *
   * 旧口径是 `model.getValue()` 取全文、再与上一版做前后缀差集（`commonEdit`）。1.36 MB /
   * 24,197 行真语料实测 **10.7 ms/击键**，全落在主线程的输入路径上；而 Monaco 的
   * `onDidChangeContent` 已经把"哪一段被换成了什么"给全了（`rangeOffset` / `rangeLength` /
   * `text` / 行列）⇒ 拼一条编辑是 O(改动数)，`applyEdit` 走 SlicedString 实测 **0.01 ms**。
   *
   * ## 自检换成"行数对账"
   *
   * 旧口径的自检是"缝出来的文本 == `getValue()`"——那要一遍全文，正是要省掉的东西。
   * 这里改对**行数**：各段 `range` 给出去掉了几行、`text` 给回插入了几行，增量维护一份
   * `doc.lines`，每次事件后与 `model.getLineCount()`（O(1)）对一次。行数对不上 ⇒ 快照与
   * 模型已经分叉，当场退回整篇重解——判据一样硬，代价与文档长度无关。
   *
   * ## 什么时候退回整篇
   *
   * - `isFlush`（`setValue` / 撤销越界整个换掉）：`changes` 的语义在这里没有保证；
   * - 事件形状不认（重叠 / 顺序认不出 / 越界，`editFromChanges` 返回 null）；
   * - 行数对账不符；
   * - 还没拿到基线树（`baseTreeId === null`）——增量没有可推的旧树。
   */
  private onChanged(event?: Monaco.editor.IModelContentChangedEvent): void {
    const doc = this.doc;
    if (doc === null || doc.model.isDisposed() || this.worker === null) return;
    const version = doc.version + 1;
    doc.version = version;
    if (event !== undefined && !event.isFlush) {
      const edit = editFromChanges(doc.text, event.changes);
      if (edit !== null) {
        let lineDelta = 0;
        for (const change of event.changes) {
          lineDelta += countNewlines(change.text) - (change.range.endLineNumber - change.range.startLineNumber);
        }
        const next = applyEdit(doc.text, edit);
        const lines = doc.lines + lineDelta;
        if (lines === doc.model.getLineCount()) {
          doc.text = next;
          doc.lines = lines;
          if (doc.pendingParse) return; // 装配没完成：只留最新快照，ready 后补发整篇
          if (doc.baseTreeId === null) {
            this.postParse(doc);
            return;
          }
          // 差集回话带全部面 ⇒ 后面的拍没有存在的理由了（否则会多几条同版本的整篇请求）
          doc.beats = [];
          this.post(
            {
              id: this.nextId++,
              kind: 'parse',
              doc: doc.seq,
              version,
              edit,
              baseTreeId: doc.baseTreeId,
              ...(doc.want === undefined ? {} : { want: doc.want }),
            },
            doc,
            true,
          );
          return;
        }
      }
    }
    // 兜底：整篇重解（换文本 / 事件形状不认 / 行数对不上 / 没有基线树）
    doc.text = doc.model.getValue();
    doc.lines = doc.model.getLineCount();
    if (doc.pendingParse) return;
    this.postParse(doc);
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
      // 到点 ⇒ 后面的拍跟着作废：它们的触发条件是"上一条回话"，而那条已经不会来了。
      // 不作废的话，等票会因为 `doc.beats` 非空而多追一轮（多付一份超时、多记一次失败）。
      doc.beats = [];
      this.noteFailure(doc, 'timeout', `结构解析 ${budget}ms 内没有回话（请求 #${request.id}）`);
    }, budget);
    this.pending.set(request.id, {
      doc,
      version: request.version,
      fromEdit,
      want: request.want,
      timer,
    });
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
      // 票是被"别的面到货"放行的（不是这一面本身）。两条出路：
      // - 这一面其实已经到了（同一份**回话**里带来的面一起落库）⇒ 落给下一轮的轮首判据，
      //   那里是唯一出口；
      // - 还没到 ⇒ 看有没有拍在飞：**有就再等一轮**（首帧分层：折叠先到、语义后到），
      //   没有就这次真不顶上，别再空转（round 数只是保险丝）。
      const again = name === 'semantic' ? doc.semantic : doc.folds;
      const arrived = again !== null && again.version >= doc.version;
      if (!arrived && doc.beats.length === 0) return null;
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
    this.reusable = false; // 这具线程已经不可信：不还池子，直接杀
    this.lease?.release(false);
    this.lease = null;
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
    // 装配完成后补发的那一条也是"开文件的第一帧" ⇒ 走拍序（折叠先上）
    this.postParse(doc, doc.want, true);
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
      // LAU-5：这条通道的 doc 号段起点（单引擎 worker 回 0）；本客户端所有 parse 都从它起算
      this.docBase = data.docBase;
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
    if (reply.doc !== this.docIdOf(doc)) {
      this.noteDiscarded(`收到文档 ${reply.doc} 的结果而当前跟踪的是文档 ${this.docIdOf(doc)}`, doc);
      return;
    }
    if (reply.version < doc.version) {
      this.noteDiscarded(`收到版本 ${reply.version} 的结果而当前版本是 ${doc.version}`, doc);
      return;
    }
    doc.failures = 0;
    if (reply.treeId.length > 0) doc.baseTreeId = reply.treeId;
    const facets = reply.facets;
    /**
     * 这一面"等不来了"吗（判死 = 别再等，也别每屏重来一遍）。
     *
     * 三档，缺一不可：
     * - **这份文档压根没要它**（体量档把语义摘掉的那一档）⇒ 现在就可以判：它不会随别的
     *   请求补上；
     * - **这一拍没要它**（首帧分层：折叠那一拍没问语义）⇒ 不是它没来，是压根没问；
     * - **要了却没来，而且后面也没有哪一拍会再要它** ⇒ 查询不可用 / 编译失败（原因见 worker
     *   控制台）。反面就是**不许**在这里判死：后面那一拍还要它，就得等那一条回话。
     */
    const missing = (name: StructureFacet): boolean => {
      if (doc.want !== undefined && !doc.want.includes(name)) return true;
      if (entry.want !== undefined && !entry.want.includes(name)) return false;
      return !doc.beats.some((beat) => beat.includes(name));
    };
    if (facets.semantic !== undefined) {
      doc.semantic = { version: reply.version, value: this.tokensOf(facets.semantic) };
    } else if (!doc.dead.semantic && missing('semantic')) {
      this.markFacetMissing(doc, 'semantic');
    }
    if (facets.folds !== undefined) {
      const spans = facets.folds.spans;
      const folds: KojoStructureFold[] = [];
      for (let i = 0; i + 1 < spans.length; i += 2) folds.push({ startRow: spans[i]!, endRow: spans[i + 1]! });
      doc.folds = { version: reply.version, value: folds };
    } else if (!doc.dead.folds && missing('folds')) {
      this.markFacetMissing(doc, 'folds');
    }
    if (facets.indent !== undefined) {
      this.latestIndent = { version: reply.version, value: facets.indent };
      // 第二拍才到的缩进：第一拍没等它 ⇒ 在这里当场落到语言配置上（否则第一次回车吃基底规则）
      try {
        this.onIndent(doc.model);
      } catch {
        /* 上屏器抛回来也不许把这一条消息环打断（与 `onSyntax` 同一条纪律） */
      }
    }
    if (facets.syntax !== undefined && !doc.syntaxDead) {
      this.safeSyntax(doc.model, facets.syntax.faults, facets.syntax.truncated);
    }
    this.flush(doc);
    // 下一拍：这一拍的产物已经上桌（上面刚 flush 完等着它的票）⇒ 接着问下一条
    const next = doc.beats[0];
    if (next !== undefined) {
      doc.beats = doc.beats.slice(1);
      if (this.doc === doc && !doc.model.isDisposed()) this.postParseRequest(doc, next);
    }
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
