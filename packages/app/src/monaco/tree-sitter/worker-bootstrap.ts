/**
 * 结构解析 worker 的**通用协议环**（v4；一条线程可承载多门语言的引擎，资源由入口注入）。
 *
 * 线程本体只做四件事：收请求 → 按 **v4 协议**（`@kojo/kojo-core` 的 `structure-protocol.ts`）
 * 校验形状 / 版本 → 调 `engine.ts` 的 `StructureEngine` → 把引擎这一趟的四条面回话
 * **拼成一条 v4 回话** postMessage 出去（引擎只产 plain 数据，Node 对象绝不跨线程）。
 * 语言差异全部收在入口的 `StructureEngineAssets`（哪两枚 wasm、哪几份查询），这里不认语言名。
 *
 * ## v4 的口径（LAU-5：一条线程多台引擎）
 *
 * - **两条请求**：`open{protocol,…}`（握手）与 `parse{doc,version,text|edit,baseTreeId?,want?}`；
 * - **一条请求一条回复**：`ready` / `parse`（四面合进 `facets`）/ 失败（`ok:false{reason,message}`）；
 * - **`ready.docBase` 是路由键**：worker 按 `grammarWasmUrl` 建**一台引擎**并发给它一个
 *   `doc` 号段起点（第 k 台 = `k × 1,000,000`）；此后每条 `parse` 只用 `doc` 找引擎
 *   （`docBase ≤ doc` 的最大那台），宿主把 `doc` 写成 `docBase + 自己的序号`。
 *   ⇒ 一条线程可以同时服务 ERB 主文档、ERB 的 `@原生` 子解析与 `.kojo` 文档，
 *   `Parser.init` 只付一次、每门语言的文法按第一次 `open` 懒装。
 * - **版本闸**：`open.protocol` 与本 worker 认的号不符 ⇒ 立刻回 `protocol-mismatch`（**不加载 wasm**，
 *   也不拿旧形状硬解）。双跑窗口里宿主收到它就降级到旧 client（`client-v2.ts`）；
 * - **内容二选一**：`text` 与 `edit` 同给 / 都没给 ⇒ `invalid-input`（不猜哪个算数）；
 * - **`want` 缺省 = 全带**：点名的面才在 `facets` 里出现，缺的键 = 这一面这次没算。
 *
 * ## 引擎回话 → v4 回话的翻译（唯一一处）
 *
 * 引擎仍是"一面一条"的内部流（`semantic` / `folds` / `indent` / `syntax` / `error`），
 * 因为增量、窗口、缓存全部以面为单位（perf 池与等价闸打的就是这条流）。协议环在**一次请求内**
 * 把这批子回话收进缓冲区（按引擎分开收），结束后：
 * - 成功面 → `facets.<面>`；
 * - `capability: 'all'` 的 error → 整条失败（`reason` 按 `stage` 映射：wasm → `wasm-load-failed`、
 *   query → `query-failed`、其余 → `parse-failed`）；
 * - **单面** error → 该面**不进 `facets`**（"这一面这次没算"），原因写进 worker 的 `console.warn`
 *   ——v4 的失败回话没有 `capability` 这一格（D2 把"哪一面该降级"交给宿主），硬塞一个会让
 *   "一条请求一条回复"变成"一条请求两条回复"。
 *
 * ## 三条纪律（1、3 属于线程本体，2 属于引擎）
 *
 * 1. **不 import Monaco、不 import 宿主 UI、不从 `@kojo/kojo-core` 取任何值**（只取类型；
 *    取一个值会把那个包的桶拖进 worker 图）：协议闸在 `./protocol.ts`，里面同样是纯类型 import；
 * 2. **增量优先**：`parse{edit}` 走 `tree.edit()` + 有界取字符回调重解，整篇重解只发生在
 *    `parse{text}`、`baseTreeId` 不认识时宿主重发整篇、以及没有可用旧树时；
 * 3. **出错就报出去，不硬撑**：任何一步抛错都变成一条 v4 失败回话（带 `reason` 与 `message`）。
 *
 * ## 两条时序口径（线程本体这层）
 *
 * - **装配没完成不该自杀**：`open` 之后才 `await` 两枚 wasm，装配期间收到的 `parse{text}` 只暂存
 *   最新一条，`open→ready` 一到补解（`edit` 在装配前无基线可缝 ⇒ 回 `invalid-input`，宿主本来
 *   也门控着不发）；
 * - **`doc` 号原样过手**：请求带哪枚跨文档隔离号，回话就带回哪枚；worker 不解释它，
 *   对号与丢弃都在 `client.ts`（旧文档的在途结果不许冒充新文档的结果上屏）。
 *
 * ## 复用（LAU-5 的池）
 *
 * 线程被放回池里再被下一个客户端 `open` 时，同一 `docBase` 的那台引擎**原地复用**
 * （wasm 早装好了）⇒ `ready` 当场回、`loadMs` 记 0；新客户端的第一条 `parse{text}` 会把
 * 上一份文档的树整棵换掉（协议本来就允许）。
 */
import type {
  StructureFacet,
  StructureFailureReason,
  StructureParseReply,
  StructureProtocolVersion,
  StructureRange,
  StructureReply,
  StructureRequest,
} from './protocol';
import { contentProblem, isStructureRequest, looksLikeLegacyStructureRequest } from './protocol';
import { StructureEngine, captureTableOf, type StructureEngineAssets } from './engine';
import type { KojoStructureReply } from './types';

/**
 * 本 worker 认的协议号。
 *
 * **不**从 `@kojo/kojo-core` 取那个值（理由见文件头纪律 1）：这里钉一枚字面量，并用 core 那个常量的**类型**兜住——core 抬号而这里没跟上，这行当场编译不过（不是一句注释约定）。
 */
const PROTOCOL: StructureProtocolVersion = 4;

/**
 * 每条通道的 `doc` 号段宽度（v4 路由用）：第 k 台引擎的 `docBase = k × 本值`。
 * 一百万足够一个客户端一辈子换文件的次数，也让"docBase ≤ doc"这条判据一眼可读。
 */
const CHANNEL_STRIDE = 1_000_000;

/** worker 全局的窄投影（app 的 tsconfig 只挂 DOM lib，不挂 WebWorker lib，故在此声明用到的三件） */
interface WorkerScope {
  postMessage(message: StructureReply): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

/** 引擎那一条 error 回话 → v4 的失败原因（闭集里最近的那一枚；不新造词） */
function reasonOfStage(stage: string): StructureFailureReason {
  if (stage === 'wasm') return 'wasm-load-failed';
  if (stage === 'query') return 'query-failed';
  if (stage === 'worker') return 'crashed';
  return 'parse-failed';
}

/** 一份装配期暂存的首解（同一台引擎只留最新一条整篇） */
interface StagedParse {
  readonly doc: number;
  readonly version: number;
  readonly text: string;
  readonly want: readonly StructureFacet[] | undefined;
  readonly includedRanges: readonly StructureRange[] | undefined;
}

/** 一台引擎在**这一条线程里**的全部状态（key 用来找"同一门语言的那台"） */
class EngineSlot {
  readonly engine: StructureEngine;
  /** 引擎装配键：`grammarWasmUrl`（同一门语言第二次 `open` 认这一格） */
  readonly key: string;
  /** 本客户端的 `doc` 号段起点（路由键；缺省 0） */
  docBase: number;
  openId: number | null = null;
  collected: KojoStructureReply[] = [];
  staged: StagedParse | null = null;
  opening = false;

  constructor(assets: StructureEngineAssets, key: string, docBase: number, emit: (message: KojoStructureReply) => void) {
    this.engine = new StructureEngine({ assets, emit });
    this.key = key;
    this.docBase = docBase;
  }
}

/**
 * 起一条结构化线程。`assets` 只描述"哪两枚 wasm、哪几份查询"——语言名不在这里出现。
 *
 * 两种形态：
 * - **单份**（探针 / 单语言 worker）：`startStructureWorker(assets)`，`open` 的 `grammarWasmUrl`
 *   只要不是别的样子，就都用这一份（与 v3 行为逐字相同）；
 * - **多份**（LAU-5 的池）：`startStructureWorker([erbAssets, kojoAssets])`，按
 *   `open.grammarWasmUrl` 挑那一份，挑不到才判 `wasm-load-failed`（不猜"那就用第一份"）。
 *
 * 返回引擎本体（生产入口不看它）：量数探针与协议表测试要 `dispose()` 掉引擎才收得干净
 * （原生内存由引擎持有，线程被 terminate 时随线程回收，进程内驱动时没有那条兜底）。
 */
/** 线程句柄（探针 / 协议表测试拿它收账）：`dispose()` 把这条线程上的所有引擎都释放掉 */
export interface StructureWorkerHandle {
  dispose(): void;
}

export function startStructureWorker(assets: StructureEngineAssets | readonly StructureEngineAssets[]): StructureWorkerHandle {
  const scope = self as unknown as WorkerScope;
  const bundles: readonly StructureEngineAssets[] = Array.isArray(assets)
    ? (assets as readonly StructureEngineAssets[])
    : [assets as StructureEngineAssets];
  /** 默认包（单份形态下任何文法都用它；多份形态下缺省 = 第一份，只在只注册一份时用） */
  const bundleFor = (grammarWasmUrl: string): StructureEngineAssets | null => {
    if (bundles.length === 1) return bundles[0]!;
    return bundles.find((bundle) => bundle.grammarWasm === grammarWasmUrl) ?? null;
  };

  /** `docBase` → 槽（同一个 docBase 只会有一台；重开走复用） */
  const slots = new Map<number, EngineSlot>();
  /** `grammarWasmUrl` → 已经发出去的 docBase（同一门语言第二次 `open` 认这一格 ⇒ 原地复用） */
  const channels = new Map<string, number>();
  /**
   * 下一台引擎的通道序号（**只增不减**）。
   *
   * 不用 `channels.size` 推 `docBase`：装配失败会把一条通道从表里摘掉，`size` 退回一位，
   * 下一门语言就会拿到**已经发出去过**的号段、把上一台引擎的槽覆盖掉（docBase 是 Map 的键）。
   */
  let nextChannel = 0;

  const post = (message: StructureReply): void => {
    try {
      scope.postMessage(message);
    } catch {
      /* 主线程已经没了：worker 下一刻就被 terminate，没有可补救的 */
    }
  };

  const fail = (id: number, kind: 'open' | 'parse' | undefined, reason: StructureFailureReason, message: string): void => {
    post({ ok: false, id, ...(kind === undefined ? {} : { kind }), reason, message });
  };

  /** 按 `doc` 找引擎：`docBase ≤ doc` 的最大那台；一枚槽都没有 / doc 比所有 docBase 都小 ⇒ 取最小那台 */
  const slotForDoc = (doc: number): EngineSlot | null => {
    let best: EngineSlot | null = null;
    let smallest: EngineSlot | null = null;
    for (const slot of slots.values()) {
      if (smallest === null || slot.docBase < smallest.docBase) smallest = slot;
      if (slot.docBase <= doc && (best === null || slot.docBase > best.docBase)) best = slot;
    }
    return best ?? smallest;
  };

  /** 把这一趟收上来的子回话拼成一条 v4 回话（成功面进 `facets`，整档 error 变失败） */
  const assemble = (slot: EngineSlot, request: { id: number; doc: number; version: number }, incremental: boolean, textLength: number): void => {
    const sub = slot.collected;
    slot.collected = [];
    const hard = sub.find((message) => message.type === 'error' && message.capability === 'all');
    if (hard !== undefined && hard.type === 'error') {
      fail(request.id, 'parse', reasonOfStage(hard.stage), hard.message);
      return;
    }
    // 单面 error：这一面这次没算（v4 的失败回话没有"哪一面"这一格），原因留在 worker 控制台。
    for (const message of sub) {
      if (message.type === 'error') console.warn(`[kojo-structure] ${message.capability}/${message.stage}：${message.message}`);
    }
    const semantic = sub.find((message) => message.type === 'semantic');
    const folds = sub.find((message) => message.type === 'folds');
    const indent = sub.find((message) => message.type === 'indent');
    const syntax = sub.find((message) => message.type === 'syntax');
    const timings = slot.engine.lastTimings;
    const reply: StructureParseReply = {
      ok: true,
      id: request.id,
      kind: 'parse',
      doc: request.doc,
      version: request.version,
      // 每次解成一棵就换一枚树身份：宿主拿它当下一条 `parse{edit}` 的 `baseTreeId`
      treeId: slot.engine.treeId ?? '',
      incremental,
      facets: {
        ...(semantic !== undefined && semantic.type === 'semantic'
          ? { semantic: semantic.table ?? captureTableOf(semantic.tokens) }
          : {}),
        ...(folds !== undefined && folds.type === 'folds'
          ? { folds: { spans: folds.folds.flatMap((fold) => [fold.startRow, fold.endRow]) } }
          : {}),
        ...(indent !== undefined && indent.type === 'indent' ? { indent: indent.rules } : {}),
        ...(syntax !== undefined && syntax.type === 'syntax'
          ? { syntax: { faults: syntax.faults, truncated: syntax.truncated } }
          : {}),
      },
      metrics: { parseMs: timings.parseMs, queryMs: timings.queryMs, textLength },
    };
    post(reply);
  };

  /** 装配完成后要做的两件事：回 `ready`（或补发暂存的首解） */
  const settleOpen = (slot: EngineSlot): void => {
    slot.opening = false;
    if (!slot.engine.initialized) {
      const hard = slot.collected.find((message) => message.type === 'error');
      slot.collected = [];
      fail(
        slot.openId ?? 0,
        'open',
        hard !== undefined && hard.type === 'error' ? reasonOfStage(hard.stage) : 'wasm-load-failed',
        hard !== undefined && hard.type === 'error' ? hard.message : '结构解析装配失败',
      );
      // 装不起来就别留在槽里：下一次 `open` 重新来一遍（否则这条线程永远是坏的）
      slots.delete(slot.docBase);
      channels.delete(slot.key);
      return;
    }
    slot.collected = [];
    post({
      ok: true,
      id: slot.openId ?? 0,
      kind: 'ready',
      protocol: PROTOCOL,
      loadMs: slot.engine.loadMs,
      docBase: slot.docBase,
    });
    // 装配期间暂存过的首解在这里补上（纵深：正常流里宿主门控会等 ready 才发 parse，
    // 这条只接住"没等 ready 就发"的调用方，别让它白等）
    const pending = slot.staged;
    slot.staged = null;
    if (pending !== null) {
      slot.collected = [];
      slot.engine.parse(pending.doc, pending.version, pending.text, pending.want, pending.includedRanges);
      assemble(slot, { id: 0, doc: pending.doc, version: pending.version }, false, pending.text.length);
    }
  };

  const runParse = (request: Extract<StructureRequest, { kind: 'parse' }>): void => {
    const problem = contentProblem(request);
    if (problem !== null) {
      fail(request.id, 'parse', 'invalid-input', problem);
      return;
    }
    const slot = slotForDoc(request.doc);
    if (slot === null) {
      fail(request.id, 'parse', 'invalid-input', `收到 doc=${request.doc} 的 parse 但这条线程还没有任何 open`);
      return;
    }
    if (slot.opening) {
      if ('text' in request) {
        slot.staged = {
          doc: request.doc,
          version: request.version,
          text: request.text,
          want: request.want,
          includedRanges: request.includedRanges,
        };
        return;
      }
      fail(request.id, 'parse', 'invalid-input', '装配还没完成，增量请求没有基线文本可缝 ⇒ 请改发整篇 text');
      return;
    }
    slot.collected = [];
    if ('includedRanges' in request && request.includedRanges !== undefined) {
      // LAU-6：区间只接"整篇 text"（输入仍是全文档，选区只是限定解哪几段）。
      // `edit` + 区间没有定义过的语义（差集把旧树推过去之后区间该落在哪一版上？），
      // 不猜：判非法，让调用方改用整篇。
      if (!('text' in request)) {
        fail(request.id, 'parse', 'invalid-input', 'includedRanges 只接整篇 text（edit + 区间没有定义过的语义）⇒ 请改发整篇');
        return;
      }
      if (request.includedRanges.length === 0) {
        fail(request.id, 'parse', 'invalid-input', 'includedRanges 是空数组（一个字节都不解）⇒ 这是调用方的错，不静默按全文档解');
        return;
      }
    }
    const want = request.want;
    if ('text' in request) {
      slot.engine.parse(request.doc, request.version, request.text, want, request.includedRanges);
      assemble(slot, request, false, request.text.length);
      return;
    }
    const edit = request.edit;
    if (request.baseTreeId !== undefined && request.baseTreeId !== slot.engine.treeId) {
      // 基线树不认识（换过线程 / 上一次解没成）：宿主该改发整篇（client 收到这条会重发一次）
      slot.collected = [];
      fail(request.id, 'parse', 'parse-failed', `baseTreeId ${request.baseTreeId} 不是本线程手上那棵树 ⇒ 请改发整篇 text`);
      return;
    }
    if (slot.engine.treeId === null) {
      slot.collected = [];
      fail(request.id, 'parse', 'parse-failed', '还没有任何可增量的基线树 ⇒ 请改发整篇 text');
      return;
    }
    const nextLength = Math.max(0, slot.engine.text.length - (edit.oldEnd.offset - edit.start.offset) + edit.newText.length);
    slot.engine.change({ type: 'change', doc: request.doc, version: request.version, start: edit.start, oldEnd: edit.oldEnd, newEnd: edit.newEnd, newText: edit.newText }, want);
    assemble(slot, request, true, nextLength);
  };

  const runOpen = (request: Extract<StructureRequest, { kind: 'open' }>): void => {
    if (request.protocol !== PROTOCOL) {
      fail(
        request.id,
        'open',
        'protocol-mismatch',
        `协议版本不符（worker 认 ${PROTOCOL}，宿主发 ${request.protocol}）⇒ 宿主该降级到旧协议那条路`,
      );
      return;
    }
    const key = request.grammarWasmUrl;
    const knownBase = channels.get(key);
    if (knownBase !== undefined) {
      const existing = slots.get(knownBase);
      if (existing !== undefined) {
        // **复用手上的那台**（池里的线程 / 同一门语言的第二个客户端）：
        // 装配早就完成 ⇒ 当场回 ready，`loadMs` 记 0；还在装就等 settleOpen 统一回。
        existing.openId = request.id;
        existing.staged = null;
        if (existing.engine.initialized) {
          post({ ok: true, id: request.id, kind: 'ready', protocol: PROTOCOL, loadMs: 0, docBase: existing.docBase });
        }
        return;
      }
      channels.delete(key); // 槽已经因为装配失败被摘掉了：这一门重新开一条通道
    }
    const bundle = bundleFor(key);
    if (bundle === null) {
      fail(
        request.id,
        'open',
        'wasm-load-failed',
        `这条线程没有登记 ${key} 这门语言的资源 ⇒ 宿主该另起一条线程（别猜"那就用第一份"）`,
      );
      return;
    }
    const docBase = nextChannel * CHANNEL_STRIDE;
    nextChannel += 1;
    channels.set(key, docBase);
    // 引擎构造时不 emit（回话只在 parse / init 期间进来），所以先声明后赋值是安全的
    let slot!: EngineSlot;
    slot = new EngineSlot(bundle, key, docBase, (message) => slot.collected.push(message));
    slots.set(docBase, slot);
    slot.openId = request.id;
    slot.opening = true;
    void slot.engine.init().then(() => settleOpen(slot));
  };

  scope.onmessage = (event: MessageEvent<unknown>) => {
    const request: unknown = event.data;
    if (!isStructureRequest(request)) {
      // 旧协议（v1 / v3 的 `init` / `parse` / `change`）：说清"对面还是旧形状"，而不是一声不响
      if (looksLikeLegacyStructureRequest(request)) {
        const id = (request as { id?: unknown }).id;
        fail(
          typeof id === 'number' && Number.isFinite(id) ? id : 0,
          undefined,
          'protocol-mismatch',
          `收到旧协议（v1 / kojo2）消息（type=${String((request as { type?: unknown }).type)}）⇒ 这条 worker 只说 v4`,
        );
        return;
      }
      fail(0, undefined, 'invalid-input', 'worker 收到的请求形状不符 v4 协议（缺 id / kind，或字段类型不对）');
      return;
    }
    if (request.kind === 'open') {
      runOpen(request);
      return;
    }
    runParse(request);
  };

  scope.onerror = (event: ErrorEvent) => {
    // 线程级未捕获异常：能说话就说，说不出去由宿主的超时 / 崩溃判据兜住
    fail(0, undefined, 'crashed', `worker 线程异常：${event.message}`);
  };

  // 句柄：探针 / 协议表测试要拿它 `dispose()`（多台引擎一起收账）
  return {
    dispose() {
      for (const slot of slots.values()) slot.engine.dispose();
      slots.clear();
    },
  };
}
