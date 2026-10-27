/**
 * 结构解析 worker 的**通用协议环**（每门语言一条线程，资源由入口注入）。
 *
 * 线程本体只做四件事：收请求 → 按 **v3 协议**（`@kojo/kojo-core` 的 `structure-protocol.ts`）
 * 校验形状 / 版本 → 调 `engine.ts` 的 `StructureEngine` → 把引擎这一趟的四条面回话
 * **拼成一条 v3 回话** postMessage 出去（引擎只产 plain 数据，Node 对象绝不跨线程）。
 * 语言差异全部收在入口的 `StructureEngineAssets`（哪两枚 wasm、哪几份查询），这里不认语言名。
 *
 * ## v3 的口径（LAU-1）
 *
 * - **两条请求**：`open{protocol,…}`（握手）与 `parse{doc,version,text|edit,baseTreeId?,want?}`；
 * - **一条请求一条回复**：`ready` / `parse`（四面合进 `facets`）/ 失败（`ok:false{reason,message}`）；
 * - **版本闸**：`open.protocol` 与本 worker 认的号不符 ⇒ 立刻回 `protocol-mismatch`（**不加载 wasm**，
 *   也不拿旧形状硬解）。双跑窗口里宿主收到它就降级到旧 client（`client-v2.ts`）；
 * - **内容二选一**：`text` 与 `edit` 同给 / 都没给 ⇒ `invalid-input`（不猜哪个算数）；
 * - **`want` 缺省 = 全带**：点名的面才在 `facets` 里出现，缺的键 = 这一面这次没算。
 *
 * ## 引擎回话 → v3 回话的翻译（唯一一处）
 *
 * 引擎仍是"一面一条"的内部流（`semantic` / `folds` / `indent` / `syntax` / `error`），
 * 因为增量、窗口、缓存全部以面为单位（perf 池与等价闸打的就是这条流）。协议环在**一次请求内**
 * 把这批子回话收进缓冲区，结束后：
 * - 成功面 → `facets.<面>`；
 * - `capability: 'all'` 的 error → 整条失败（`reason` 按 `stage` 映射：wasm → `wasm-load-failed`、
 *   query → `query-failed`、其余 → `parse-failed`）；
 * - **单面** error → 该面**不进 `facets`**（"这一面这次没算"），原因写进 worker 的 `console.warn`
 *   ——v3 的失败回话没有 `capability` 这一格（D2 把"哪一面该降级"交给宿主），硬塞一个会让
 *   "一条请求一条回复"变成"一条请求两条回复"。
 *
 * ## 三条纪律（1、3 属于线程本体，2 属于引擎）
 *
 * 1. **不 import Monaco、不 import 宿主 UI、不从 `@kojo/kojo-core` 取任何值**（只取类型；
 *    取一个值会把那个包的桶拖进 worker 图）：协议闸在 `./protocol.ts`，里面同样是纯类型 import；
 * 2. **增量优先**：`parse{edit}` 走 `tree.edit()` + 有界取字符回调重解，整篇重解只发生在
 *    `parse{text}`、`baseTreeId` 不认识时宿主重发整篇、以及没有可用旧树时；
 * 3. **出错就报出去，不硬撑**：任何一步抛错都变成一条 v3 失败回话（带 `reason` 与 `message`）。
 *
 * ## 两条时序口径（线程本体这层）
 *
 * - **装配没完成不该自杀**：`open` 之后才 `await` 两枚 wasm，装配期间收到的 `parse{text}` 只暂存
 *   最新一条，`open→ready` 一到补解（`edit` 在装配前无基线可缝 ⇒ 回 `invalid-input`，宿主本来
 *   也门控着不发）；
 * - **`doc` 号原样过手**：请求带哪枚跨文档隔离号，回话就带回哪枚；worker 不解释它，
 *   对号与丢弃都在 `client.ts`（旧文档的在途结果不许冒充新文档的结果上屏）。
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
 * **不**从 `@kojo/kojo-core` 取那个值（理由见文件头纪律 1）：这里钉一枚字面量，并用
 * core 那个常量的**类型**兜住——core 抬号而这里没跟上，这行当场编译不过（不是一句注释约定）。
 */
const PROTOCOL: StructureProtocolVersion = 3;

/** worker 全局的窄投影（app 的 tsconfig 只挂 DOM lib，不挂 WebWorker lib，故在此声明用到的三件） */
interface WorkerScope {
  postMessage(message: StructureReply): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

/** 引擎那一条 error 回话 → v3 的失败原因（闭集里最近的那一枚；不新造词） */
function reasonOfStage(stage: string): StructureFailureReason {
  if (stage === 'wasm') return 'wasm-load-failed';
  if (stage === 'query') return 'query-failed';
  if (stage === 'worker') return 'crashed';
  return 'parse-failed';
}

/**
 * 起一条结构化线程。`assets` 只描述"哪两枚 wasm、哪几份查询"——语言名不在这里出现。
 *
 * 返回引擎本体（生产入口不看它）：量数探针与协议表测试要 `dispose()` 掉引擎才收得干净
 * （原生内存由引擎持有，线程被 terminate 时随线程回收，进程内驱动时没有那条兜底）。
 */
export function startStructureWorker(assets: StructureEngineAssets): StructureEngine {
  const scope = self as unknown as WorkerScope;
  /** 一次请求内引擎的子回话（v3 要一条请求一条回复；见文件头的翻译口径） */
  let collected: KojoStructureReply[] = [];
  const engine = new StructureEngine({
    assets,
    emit: (message) => collected.push(message),
  });

  /** 装配完成前收到的首解请求（只留最新一条的整篇；见文件头"两条时序口径"） */
  let staged: {
    doc: number;
    version: number;
    text: string;
    want: readonly StructureFacet[] | undefined;
    includedRanges: readonly StructureRange[] | undefined;
  } | null = null;
  /** `open` 的 id（`ready` 要回同一枚；没握过手就是 null） */
  let openId: number | null = null;
  /** 已经在装 wasm 了（重复的 `open` 只补一枚 ready，不再装第二遍） */
  let opening = false;

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

  /** 把这一趟收上来的子回话拼成一条 v3 回话（成功面进 `facets`，整档 error 变失败） */
  const assemble = (
    request: { id: number; doc: number; version: number },
    incremental: boolean,
    textLength: number,
  ): void => {
    const sub = collected;
    collected = [];
    const hard = sub.find((message) => message.type === 'error' && message.capability === 'all');
    if (hard !== undefined && hard.type === 'error') {
      fail(request.id, 'parse', reasonOfStage(hard.stage), hard.message);
      return;
    }
    // 单面 error：这一面这次没算（v3 的失败回话没有"哪一面"这一格），原因留在 worker 控制台。
    for (const message of sub) {
      if (message.type === 'error') console.warn(`[kojo-structure] ${message.capability}/${message.stage}：${message.message}`);
    }
    const semantic = sub.find((message) => message.type === 'semantic');
    const folds = sub.find((message) => message.type === 'folds');
    const indent = sub.find((message) => message.type === 'indent');
    const syntax = sub.find((message) => message.type === 'syntax');
    const timings = engine.lastTimings;
    const reply: StructureParseReply = {
      ok: true,
      id: request.id,
      kind: 'parse',
      doc: request.doc,
      version: request.version,
      // 每次解成一棵就换一枚树身份：宿主拿它当下一条 `parse{edit}` 的 `baseTreeId`
      treeId: engine.treeId ?? '',
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

  const runParse = (request: Extract<StructureRequest, { kind: 'parse' }>): void => {
    const problem = contentProblem(request);
    if (problem !== null) {
      fail(request.id, 'parse', 'invalid-input', problem);
      return;
    }
    collected = [];
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
      engine.parse(request.doc, request.version, request.text, want, request.includedRanges);
      assemble(request, false, request.text.length);
      return;
    }
    const edit = request.edit;
    if (request.baseTreeId !== undefined && request.baseTreeId !== engine.treeId) {
      // 基线树不认识（worker 换过 / 上一次解没成）：宿主该改发整篇（client 收到这条会重发一次）
      collected = [];
      fail(request.id, 'parse', 'parse-failed', `baseTreeId ${request.baseTreeId} 不是本线程手上那棵树 ⇒ 请改发整篇 text`);
      return;
    }
    if (engine.treeId === null) {
      collected = [];
      fail(request.id, 'parse', 'parse-failed', '还没有任何可增量的基线树 ⇒ 请改发整篇 text');
      return;
    }
    const nextLength = Math.max(0, engine.text.length - (edit.oldEnd.offset - edit.start.offset) + edit.newText.length);
    engine.change({ type: 'change', doc: request.doc, version: request.version, start: edit.start, oldEnd: edit.oldEnd, newEnd: edit.newEnd, newText: edit.newText }, want);
    assemble(request, true, nextLength);
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
    openId = request.id;
    if (engine.initialized || opening) return; // 重复握手：ready 在装载完成时统一补发
    opening = true;
    collected = [];
    void engine.init().then((ok) => {
      opening = false;
      if (!ok) {
        const hard = collected.find((message) => message.type === 'error');
        collected = [];
        fail(
          openId ?? request.id,
          'open',
          hard !== undefined && hard.type === 'error' ? reasonOfStage(hard.stage) : 'wasm-load-failed',
          hard !== undefined && hard.type === 'error' ? hard.message : '结构解析装配失败',
        );
        return;
      }
      collected = [];
      post({ ok: true, id: openId ?? request.id, kind: 'ready', protocol: PROTOCOL, loadMs: engine.loadMs });
      // 装配期间暂存过的首解在这里补上（纵深：正常流里宿主门控会等 ready 才发 parse，
      // 这条只接住"没等 ready 就发"的调用方，别让它白等）
      const pending = staged;
      staged = null;
      if (pending !== null) {
        collected = [];
        engine.parse(pending.doc, pending.version, pending.text, pending.want, pending.includedRanges);
        assemble({ id: 0, doc: pending.doc, version: pending.version }, false, pending.text.length);
      }
    });
  };

  scope.onmessage = (event: MessageEvent<unknown>) => {
    const request: unknown = event.data;
    if (!isStructureRequest(request)) {
      // 旧协议（v2）的 `init` / `parse` / `change`：说清"对面还是旧形状"，而不是一声不响
      if (looksLikeLegacyStructureRequest(request)) {
        const id = (request as { id?: unknown }).id;
        fail(
          typeof id === 'number' && Number.isFinite(id) ? id : 0,
          undefined,
          'protocol-mismatch',
          `收到旧协议（v2）消息（type=${String((request as { type?: unknown }).type)}）⇒ 这条 worker 只说 v3`,
        );
        return;
      }
      fail(0, undefined, 'invalid-input', 'worker 收到的请求形状不符 v3 协议（缺 id / kind，或字段类型不对）');
      return;
    }
    if (request.kind === 'open') {
      runOpen(request);
      return;
    }
    // 内容二选一在**暂存之前**就判：装配期收到一条 `text` + `edit` 同给 / 都没给的请求，
    // 既不能悄悄按 text 解（那等于替作者猜了哪个算数），也不能当增量拒（它根本不是增量）。
    const problem = contentProblem(request);
    if (problem !== null) {
      fail(request.id, 'parse', 'invalid-input', problem);
      return;
    }
    if (!engine.initialized) {
      // 装配没完成：整篇请求存最新一条（后来者覆盖），`ready` 一到补解；增量请求没有基线 ⇒ 拒绝。
      if ('text' in request) {
        staged = {
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
    runParse(request);
  };

  scope.onerror = (event: ErrorEvent) => {
    // 线程级未捕获异常：能说话就说，说不出去由宿主的超时 / 崩溃判据兜住
    fail(0, undefined, 'crashed', `worker 线程异常：${event.message}`);
  };
  return engine;
}
