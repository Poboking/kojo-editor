/**
 * `@原生` 注入的**宿主侧执行器**（LAU-6 / 设计稿 §4.6，D14）。
 *
 * ## 这一层做什么、不做什么
 *
 * 做三件事，每件都只有一处：
 * 1. **认宿主节点**：主树的捕获表里 `nodeType` 命中 descriptor `injections[].hostNode` 的，
 *    换算成"体内区间"（{@link injectionHostNodes} / {@link planInjectionRanges}）；
 * 2. **转发子 parse**：向子语言（descriptor 的 `languageId`）的结构 worker 发一条
 *    `parse{text, includedRanges, want:['semantic','folds']}`——坐标天然是主文档绝对坐标
 *    （web-tree-sitter 的 `ParseOptions.includedRanges` 契约），**不平移、不截串**；
 * 3. **交回纯数据**：子树 tokens（带档位名）与折叠区间。合并（覆盖主树 `role.raw`）在
 *    宿主语言自己的 provider 里做——本文件不知道 kojo2 的 token 名，也不知道 ERB 的档位表。
 *
 * 不做：文法内嵌（D14 明令零文法改动）、递归注入（`@原生` 里不再出现 kojo）、缩进/残缺面
 * 的子树合并（本批只写着色与折叠；缩进本来由主树的围栏规则供，残缺面留在主树）。
 *
 * ## 区间口径**写死**（LAU-6a `tools/inject-probe.mjs` 的判决，别自己发明）
 *
 * 体内区间 = **体首行第 0 列 → 体末行行尾含换行**；体直达文档尾且末行无换行时，按宿主
 * `parseStructureText` 的同一口径**补一枚虚拟换行**（输入变成 `text + '\n'`，区间尾取新长度）。
 * 探针的 8 语境 × 5 取法只认这一条（④）：①原始区间丢末行收束词、②只补末行换行起点不在
 * 第 0 列、③差"EOF 补虚拟换行"一口气、⑤任意字节切让 `skip_block` 解体。
 * 坐标一律 **UTF-16 码元**（与 Monaco / tree-sitter 的 index 同口径；探针含代理对语境
 * UTF-16=26 / UTF-8=54 仍 0 错位）。
 *
 * ## 零请求与失败面
 *
 * - **没有宿主节点 = 一个字节都不发**：运行时只在这条路真的被调用时才 `load()` 子语言的
 *   结构运行时（ERB wasm ~1 MB），`disposeInjectionClients()` 由宿主装配层收账；
 * - **子树失败不拖垮主树**：本文件只回 `{ok:false}`，由调用方落
 *   `core/injection/child-failed`（warning，见 `kojo-core/src/diagnostics.ts`）并保留主树的
 *   原文着色。主树的四面不受任何影响——这里连主树的回话都不碰。
 */
import {
  STRUCTURE_BOOTSTRAP_TIMEOUT_MS,
  STRUCTURE_PROTOCOL_VERSION,
  STRUCTURE_TIMEOUT_MS,
} from '@kojo/kojo-core';
import type { StructureLanguageRuntime, InjectionSpec } from './structure-runtime';
import { acquireStructureThread, type StructureThreadLease } from './structure-pool';
import type { StructureCaptureTable, StructureParseReply, StructureRange, StructureRequest } from './protocol';
import { isStructureReply } from './protocol';
import { tierForCapture, type KojoStructureFold, type KojoStructureToken } from './types';

/* ============================== 宿主节点与区间 ============================== */

/** 主树里一枚**注入宿主节点**（0 基行 / 列；节点类型名只用于对账，不参与区间计算） */
export interface InjectionHost {
  /** 子语言 id（descriptor 的 `injections[].languageId`） */
  readonly languageId: string;
  /** 主树节点名（descriptor 的 `injections[].hostNode`）——宿主不硬编码任何节点名 */
  readonly hostNode: string;
  readonly startRow: number;
  readonly startColumn: number;
  readonly endRow: number;
  readonly endColumn: number;
}

/**
 * 一次注入的区间计划：喂给子 worker 的输入（可能带虚拟换行）与绝对区间
 */
export interface InjectionRangePlan {
  /** 子 parse 的输入：`text`，或体直达 EOF 且无末行换行时的 `text + '\n'` */
  readonly input: string;
  readonly ranges: readonly StructureRange[];
}

/** UTF-16 行首表（`\n` 切行；`\r\n` 的 `\r` 留在上一行里，与 tree-sitter 的 column 口径一致） */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 行列 → index（行越界夹到文末，列越界夹到行尾） */
function indexAt(starts: readonly number[], text: string, row: number, column: number): number {
  if (row < 0) return 0;
  if (row >= starts.length) return text.length;
  const lineStart = starts[row]!;
  const lineEnd = row + 1 < starts.length ? starts[row + 1]! - 1 : text.length;
  return Math.min(lineStart + Math.max(0, column), lineEnd);
}

/** index → 行号（二分；`starts` 升序） */
function rowAt(starts: readonly number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** index → 行列（落在哪一行就取那一行，列 = index − 行首；越界索引夹到末行） */
function pointAt(starts: readonly number[], index: number): { row: number; column: number } {
  const row = rowAt(starts, index);
  return { row, column: index - starts[row]! };
}

/**
 * 把宿主节点换算成**写死的注入区间**（§4.6 / LAU-6a ④；见文件头）。
 *
 * 一段宿主节点可能起在栏头行末的零宽缩进记号上（围栏块的体容器就是这样），
 * 所以先做一次"若起点正好压在换行符上，就退到下一行"的对齐，再取该行第 0 列。
 * 末行取 `endIndex − 1` 所在行，区间收在**那一行的换行之后**（EOF 无换行 ⇒ 补虚拟换行）。
 *
 * 返回空 `ranges` = 这段宿主节点没有可解的行（空体 / 坐标坏），调用方按"不注入"处理。
 */
export function planInjectionRanges(text: string, hosts: readonly InjectionHost[]): InjectionRangePlan {
  const starts = lineStarts(text);
  const raw: Array<{ start: number; end: number }> = [];
  let virtualNewline = false;
  for (const host of hosts) {
    const rawStart = indexAt(starts, text, host.startRow, host.startColumn);
    let start = rawStart;
    // 体首行：起点压在换行上 ⇒ 从下一行第 0 列起（探针 ④ 的第一条对齐）
    if (text.charCodeAt(start) === 10) start += 1;
    const startRow = rowAt(starts, Math.min(start, Math.max(0, text.length - 1)));
    start = starts[startRow]!;
    const rawEnd = indexAt(starts, text, host.endRow, host.endColumn);
    if (rawEnd <= start) continue; // 空体 / 坐标倒置：没有可解的行
    const lastRow = rowAt(starts, Math.max(start, rawEnd - 1));
    // 收在末行的换行之后（含换行）；文末无换行 ⇒ 记一笔虚拟换行，后面统一补
    let end = lastRow + 1 < starts.length ? starts[lastRow + 1]! : text.length;
    if (end >= text.length && text.length > 0 && text.charCodeAt(text.length - 1) !== 10) {
      virtualNewline = true;
      end = text.length + 1;
    }
    raw.push({ start, end });
  }
  if (raw.length === 0) return { input: text, ranges: [] };
  const input = virtualNewline ? `${text}\n` : text;
  const inputStarts = virtualNewline ? lineStarts(input) : starts;
  const seen = new Set<string>();
  const ranges: StructureRange[] = [];
  for (const range of raw) {
    const key = `${range.start}:${range.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranges.push({
      startIndex: range.start,
      endIndex: range.end,
      startPosition: pointAt(inputStarts, range.start),
      endPosition: pointAt(inputStarts, range.end),
    });
  }
  ranges.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex);
  return { input, ranges };
}

/* ============================== 子 worker 客户端 ============================== */

/** 本文件对 `Worker` 的最小依赖面（浏览器 Worker 与测试替身都满足） */
export interface InjectionWorkerLike {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

interface InjectionFailure {
  readonly ok: false;
  readonly reason: string;
  readonly message: string;
}

interface ChildParseSuccess {
  readonly ok: true;
  readonly tokens: readonly KojoStructureToken[];
  readonly folds: readonly KojoStructureFold[];
}

type ChildParseResult = ChildParseSuccess | InjectionFailure;

interface PendingChildParse {
  readonly resolve: (result: ChildParseResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 子语言 worker 的**最小 v3 客户端**（一条线程一棵树，永远只发 `parse{text,includedRanges}`）。
 *
 * 为什么不复用 `client.ts`：那个客户端按"一份文档一条线程 + 差集增量"设计，而注入的输入
 * 可能是 `text + 虚拟换行`（与 model 文本不同）、请求又必须带 `includedRanges`（差集路没有
 * 这条语义）。借用它会把"模型文本 = 发送文本"这条不变量弄坏。本类只做三件：
 * `open` 握手 → `parse` → 按 `id` 收面；失败一律是数据。
 */
class InjectionWorkerClient {
  private worker: InjectionWorkerLike | null = null;
  private state: 'idle' | 'starting' | 'ready' | 'dead' = 'idle';
  private nextId = 1;
  private answered = false;
  private readonly pending = new Map<number, PendingChildParse>();
  private readonly readyWaiters: Array<(ok: boolean) => void> = [];
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly runtime: StructureLanguageRuntime;
  private readonly languageId: string;
  /** 池租约（LAU-5）：子解析线程也是从同一只池里借的 */
  private lease: StructureThreadLease | null = null;
  /** 这条通道的 `doc` 号段起点（`ready.docBase`）——**必须用**，否则 doc 0 会落到别人那台引擎 */
  private docBase = 0;
  /** 线程还能不能还回池子（fail 之后不能） */
  private reusable = true;

  constructor(runtime: StructureLanguageRuntime, languageId: string) {
    this.runtime = runtime;
    this.languageId = languageId;
  }

  get status(): 'idle' | 'starting' | 'ready' | 'dead' {
    return this.state;
  }

  /** 幂等 `open`；返回 false = 这条子通道从此不可用 */
  start(): Promise<boolean> {
    if (this.state === 'ready') return Promise.resolve(true);
    if (this.state === 'dead') return Promise.resolve(false);
    if (this.state === 'starting') {
      return new Promise<boolean>((resolve) => this.readyWaiters.push(resolve));
    }
    let worker: InjectionWorkerLike;
    try {
      // LAU-5：子解析线程同样从池里借（与主文档共用一条线程时，`Parser.init` 只付一次）
      const lease = acquireStructureThread(this.runtime);
      this.lease = lease;
      worker = lease.worker as unknown as InjectionWorkerLike;
    } catch (error: unknown) {
      this.fail(`子语言 worker 启动失败：${describeError(error)}`);
      return Promise.resolve(false);
    }
    worker.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
    worker.onerror = (event: ErrorEvent) => this.fail(`子语言 worker 线程报错：${event.message || '（无消息）'}`);
    this.worker = worker;
    this.state = 'starting';
    const started = new Promise<boolean>((resolve) => this.readyWaiters.push(resolve));
    try {
      worker.postMessage({
        id: this.nextId++,
        kind: 'open',
        protocol: STRUCTURE_PROTOCOL_VERSION,
        languageId: this.languageId,
        runtimeWasmUrl: this.runtime.runtimeWasmUrl,
        grammarWasmUrl: this.runtime.grammarWasmUrl,
      } satisfies StructureRequest);
    } catch (error: unknown) {
      this.fail(`子语言 worker 投递失败：${describeError(error)}`);
      return Promise.resolve(false);
    }
    this.openTimer = setTimeout(() => {
      this.openTimer = null;
      if (this.state === 'starting' && !this.answered) {
        this.fail(`${STRUCTURE_BOOTSTRAP_TIMEOUT_MS}ms 内子语言 worker 没有回话（装配未完成）`);
      }
    }, STRUCTURE_BOOTSTRAP_TIMEOUT_MS);
    return started;
  }

  /** 发一条带区间的 parse；失败回 `{ok:false}`（**永不 reject**） */
  parse(input: string, version: number, ranges: readonly StructureRange[]): Promise<ChildParseResult> {
    return this.start().then((ok) => {
      if (!ok) {
        return { ok: false, reason: 'unavailable', message: '子语言 worker 不可用（启动失败 / 已死）' } satisfies InjectionFailure;
      }
      const worker = this.worker;
      if (worker === null) {
        return { ok: false, reason: 'unavailable', message: '子语言 worker 已释放' } satisfies InjectionFailure;
      }
      const id = this.nextId++;
      const budget = this.answered ? STRUCTURE_TIMEOUT_MS : STRUCTURE_BOOTSTRAP_TIMEOUT_MS;
      return new Promise<ChildParseResult>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          resolve({
            ok: false,
            reason: 'timeout',
            message: `子语言 worker 在 ${budget}ms 内没有回话（请求 #${id}）`,
          });
        }, budget);
        this.pending.set(id, { resolve, timer });
        const request: StructureRequest = {
          id,
          kind: 'parse',
          // 通道号段起点 + 本客户端固定序号 0：不同客户端落在不同号段，worker 据此找引擎
          doc: this.docBase,
          version,
          text: input,
          want: ['semantic', 'folds'],
          includedRanges: ranges,
        };
        try {
          worker.postMessage(request);
        } catch (error: unknown) {
          this.pending.delete(id);
          clearTimeout(timer);
          this.fail(`子语言 worker 投递失败：${describeError(error)}`);
          resolve({ ok: false, reason: 'crashed', message: '子语言 worker 投递失败' });
        }
      });
    });
  }

  dispose(): void {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.clearOpenTimer();
    this.settleAll({ ok: false, reason: 'disposed', message: '注入子客户端已释放' });
    this.resolveReady(false);
    const worker = this.worker;
    this.worker = null;
    this.docBase = 0;
    // LAU-5：好线程还回池子，坏线程直接杀（`terminate` 在已死线程上会抛，收账不改变结论）
    this.lease?.release(this.reusable && worker !== null);
    this.lease = null;
  }

  /* ------------------------------ 内部 ------------------------------ */

  private receive(data: unknown): void {
    if (!isStructureReply(data)) {
      this.fail('子语言 worker 回传的消息形状不符 v3 协议（两侧版本对不上）');
      return;
    }
    if (data.ok === false) {
      if (data.reason === 'protocol-mismatch') {
        this.fail(`子语言 open 握手被拒：${data.message}`);
        return;
      }
      const pending = this.pending.get(data.id);
      if (pending === undefined) return; // 迟到 / 无主的失败：不改任何已定的答案
      this.pending.delete(data.id);
      clearTimeout(pending.timer);
      this.answered = true;
      pending.resolve({ ok: false, reason: data.reason, message: data.message });
      return;
    }
    if (data.kind === 'ready') {
      if (data.protocol !== STRUCTURE_PROTOCOL_VERSION) {
        this.fail(`子语言 worker 认的协议是 ${data.protocol}（本宿主说 ${STRUCTURE_PROTOCOL_VERSION}）`);
        return;
      }
      this.docBase = data.docBase;
      this.answered = true;
      this.state = 'ready';
      this.clearOpenTimer();
      this.resolveReady(true);
      return;
    }
    const pending = this.pending.get(data.id);
    if (pending === undefined) return;
    this.pending.delete(data.id);
    clearTimeout(pending.timer);
    this.answered = true;
    pending.resolve(this.facetsOf(data));
  }

  /** v3 回话 → 子树 tokens / folds（语义面缺席 = 这次子解析没顶上） */
  private facetsOf(reply: StructureParseReply): ChildParseResult {
    const table = reply.facets.semantic;
    if (table === undefined) {
      return {
        ok: false,
        reason: 'query-failed',
        message: '子语言 worker 没回 semantic 面（查询不可用 / 这一趟没算）',
      };
    }
    const folds: KojoStructureFold[] = [];
    const spans = reply.facets.folds?.spans ?? [];
    for (let i = 0; i + 1 < spans.length; i += 2) folds.push({ startRow: spans[i]!, endRow: spans[i + 1]! });
    return { ok: true, tokens: this.tokensOf(table), folds };
  }

  /** 扁平捕获表 → 宿主 token（档位表由子语言运行时声明；表外丢弃） */
  private tokensOf(table: StructureCaptureTable): KojoStructureToken[] {
    const mapTier = this.runtime.captureTier ?? tierForCapture;
    const tokens: KojoStructureToken[] = [];
    const spans = table.spans;
    for (let i = 0; i + 5 < spans.length; i += 6) {
      const name = table.names[spans[i + 4]!] ?? '';
      const node = table.nodes[spans[i + 5]!] ?? '';
      const tier = mapTier(name, node);
      if (tier === undefined) continue; // 子语言明说"这枚捕获不供着色"
      if (tier === null) continue; // 表外：宿主侧没有这一档，安静丢弃（不猜邻近档）
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

  private fail(message: string): void {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.clearOpenTimer();
    this.settleAll({ ok: false, reason: 'unavailable', message });
    this.resolveReady(false);
    const worker = this.worker;
    this.worker = null;
    this.reusable = false; // 坏线程：不还池子
    this.lease?.release(false);
    this.lease = null;
  }

  private settleAll(result: ChildParseResult): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.resolve(result);
    }
  }

  private resolveReady(ok: boolean): void {
    const waiters = this.readyWaiters.splice(0);
    for (const resolve of waiters) {
      try {
        resolve(ok);
      } catch {
        /* 等待者自己抛错不许把客户端带下水 */
      }
    }
  }

  private clearOpenTimer(): void {
    if (this.openTimer === null) return;
    clearTimeout(this.openTimer);
    this.openTimer = null;
  }
}

/* ============================== 运行时装载与客户端池 ============================== */

/** 按语言 id 取子语言的结构运行时（缺省 = descriptor 注册表；取不到 `/` 没声明 ⇒ null） */
export type InjectionRuntimeLoader = (languageId: string) => Promise<StructureLanguageRuntime | null>;

/** 缺省装载器：动态 import 注册表（不在静态图里拖上任何语言资源） */
const defaultRuntimeLoader: InjectionRuntimeLoader = async (languageId) => {
  const { descriptorForLanguageId } = await import('../language-registry');
  const descriptor = descriptorForLanguageId(languageId);
  if (descriptor === undefined || descriptor === null || descriptor.structure === undefined) return null;
  return descriptor.structure.load();
};

/** 一条子通道的账（key = 语言 id；运行时换了就重开） */
const clients = new Map<string, { readonly runtime: StructureLanguageRuntime; readonly client: InjectionWorkerClient }>();

function clientFor(languageId: string, runtime: StructureLanguageRuntime): InjectionWorkerClient {
  const existing = clients.get(languageId);
  if (existing !== undefined && existing.runtime === runtime) return existing.client;
  existing?.client.dispose();
  const client = new InjectionWorkerClient(runtime, languageId);
  clients.set(languageId, { runtime, client });
  return client;
}

/** 收掉全部子通道（宿主装配层 / 测试复位用；幂等） */
export function disposeInjectionClients(): void {
  for (const entry of clients.values()) entry.client.dispose();
  clients.clear();
}

/* ============================== 一次注入 ============================== */

export interface InjectionRunRequest {
  readonly text: string;
  readonly version: number;
  readonly specs: readonly InjectionSpec[];
  readonly hosts: readonly InjectionHost[];
  /** 子语言运行时装载（测试注入；缺省走 descriptor 注册表） */
  readonly loadRuntime?: InjectionRuntimeLoader;
}

export type InjectionOutcome =
  | {
      readonly ok: true;
      /** 子树 tokens（**主文档绝对坐标**，0 基行列；档位名来自子语言运行时） */
      readonly tokens: readonly KojoStructureToken[];
      readonly folds: readonly KojoStructureFold[];
      /** 这次真正发出去的区间（宿主合并时按它裁主树原文） */
      readonly ranges: readonly StructureRange[];
      /** 子 parse 的输入（可能与 `text` 差一枚虚拟换行） */
      readonly input: string;
    }
  | InjectionFailure;

const EMPTY_OK: Extract<InjectionOutcome, { readonly ok: true }> = {
  ok: true,
  tokens: [],
  folds: [],
  ranges: [],
  input: '',
};

/** 失败话术（调用方把它连同 `core/injection/child-failed` 一起上账） */
function failure(reason: string, message: string): InjectionFailure {
  return { ok: false, reason, message };
}

/**
 * 按宿主节点向子语言发一次 parse，交回子树数据。
 *
 * 多条宿主节点（多段 `@原生`）**并成一条请求**（`includedRanges` 支持多段，坐标天然对齐）；
 * 不同子语言各发各的。任何一步失败都只回 `{ok:false}`，**不抛**。
 */
export async function runInjection(request: InjectionRunRequest): Promise<InjectionOutcome> {
  const { text, version, specs, hosts } = request;
  if (specs.length === 0 || hosts.length === 0) return { ...EMPTY_OK, input: text };
  const loadRuntime = request.loadRuntime ?? defaultRuntimeLoader;
  const byLanguage = new Map<string, InjectionHost[]>();
  for (const host of hosts) {
    const bucket = byLanguage.get(host.languageId);
    if (bucket === undefined) byLanguage.set(host.languageId, [host]);
    else bucket.push(host);
  }
  const tokens: KojoStructureToken[] = [];
  const folds: KojoStructureFold[] = [];
  const ranges: StructureRange[] = [];
  let input = text;
  for (const [languageId, languageHosts] of byLanguage) {
    let runtime: StructureLanguageRuntime | null;
    try {
      runtime = await loadRuntime(languageId);
    } catch (error: unknown) {
      return failure('unavailable', `子语言「${languageId}」的结构运行时装载失败：${describeError(error)}`);
    }
    if (runtime === null) {
      return failure('unavailable', `子语言「${languageId}」没有声明结构运行时（descriptor.structure 缺席）⇒ 这块保持原文`);
    }
    const plan = planInjectionRanges(text, languageHosts);
    if (plan.ranges.length === 0) continue; // 宿主节点都在空行上：这一段没有可解的内容
    const result = await clientFor(languageId, runtime).parse(plan.input, version, plan.ranges);
    if (!result.ok) return result;
    tokens.push(...result.tokens);
    folds.push(...result.folds);
    ranges.push(...plan.ranges);
    input = plan.input;
  }
  return { ok: true, tokens, folds, ranges, input };
}

/* ============================== 按 model 复用（provider 之间共享一次子 parse） ============================== */

interface HostPlanEntry {
  readonly version: number;
  readonly hosts: readonly InjectionHost[];
}

let hostPlans = new WeakMap<object, HostPlanEntry>();
let runs = new WeakMap<object, { readonly version: number; readonly promise: Promise<InjectionOutcome> }>();

/** 记下"这份 model 这一版有哪些宿主节点"（语义 provider 拿到捕获时记一次） */
export function rememberInjectionHosts(model: object, version: number, hosts: readonly InjectionHost[]): void {
  hostPlans.set(model, { version, hosts });
}

/** 取回同一份 model 同一版的宿主节点（折叠 provider 用；对不上 = null，不猜） */
export function recallInjectionHosts(model: object, version: number): readonly InjectionHost[] | null {
  const entry = hostPlans.get(model);
  return entry !== undefined && entry.version === version ? entry.hosts : null;
}

/**
 * 同一份 model 同一版**只解一次子树**：语义 provider 先到就先解，折叠 provider 后到直接拿
 * 同一张 promise（失败也照样复用——同一版不反复重试，与 provider 自己的版本缓存同纪律）。
 */
export function runInjectionForModel(
  model: object,
  request: InjectionRunRequest,
): Promise<InjectionOutcome> {
  const cached = runs.get(model);
  if (cached !== undefined && cached.version === request.version) return cached.promise;
  const promise = runInjection(request);
  runs.set(model, { version: request.version, promise });
  return promise;
}

/** 测试 / 换轨复位：丢掉宿主节点账与子树结果账（子通道另由 `disposeInjectionClients` 收） */
export function resetInjectionState(): void {
  // WeakMap 没有 clear：换成新表（旧表随 model 释放）
  hostPlans = new WeakMap();
  runs = new WeakMap();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
