/**
 * Kojo 2.0 的**worker 侧**：tree-sitter 运行时、树缓存与三份查询都只活在这条线程里。
 *
 * ## 为什么搬进 worker
 *
 * batch-3 把 wasm 放在主线程（`kojo2-runtime.ts` 单例）：5,000 行文档的首解 ~36ms、增量 ~6ms，
 * 单看数字不大，但每一次重解都占着 UI 线程，且查询（highlights/folds）与解析共享同一条
 * 消息环。搬进 worker 之后主线程只剩"发文本、收纯数据"，最坏情况是着色晚一拍，不是编辑器卡住。
 *
 * ## 协议（真源在 `kojo2-worker-protocol.ts`）
 *
 * 一条请求 `{ id, type, text, version, oldTreeId? }` ⇒ 一条同 `id` 的回复。
 * 四种 `type` 分工：
 * - `parse`：首解 / 增量重解。`oldTreeId` 是上一次回复交出的树（增量基准）。
 * - `captures` / `folds` / `indents`：先保证有树（缓存命中且文本逐字相同 ⇒ 直接查；
 *   文本变了 ⇒ 先增量重解；不认识 ⇒ 整篇重解），再跑对应查询。
 *
 * ## 树的所有权（这条线程里唯一会 `delete()` 树的地方）
 *
 * - 缓存上限 `KOJO2_WORKER_MAX_TREES`（默认 8，LRU）：主线程超时丢弃的迟到结果最多让一棵树
 *   多活一会儿，不会无限涨；
 * - 增量重解的旧树：`runtime.parse` 之后立即 `delete()`（运行时头注：旧树已被 `tree.edit`
 *   改写过，不再当基准）；
 * - `dispose()`：删光缓存 + 释放运行时（运行时自身的 `dispose` 幂等；worker 线程被 terminate
 *   时 wasm 也会随线程回收，这条只是给优雅退出与测试兜底）。
 *
 * ## 纪律
 *
 * - 不 import Monaco / 宿主 UI / 插件包，也**不 import `kojo2-runtime.ts`**（那个模块带动态
 *   装载器，进了 worker 图就会切 chunk）：运行时由 `options.loadRuntime` 交进来，类型只从
 *   `kojo2-runtime-core.ts` 取；
 * - **永不抛**：任何一步出错都变成 `{ ok: false, reason, message }`；本地线程级未捕获异常由
 *   `startKojo2Worker` 的 `onerror` 兜一条 `id: 0`（主线程只会记一笔，不会拿它当任何请求的答案）；
 * - 查询各面独立降级：`folds` 查询能用就真跑；`indents` 查询的捕获由
 *   {@link indentRulesFromCaptures} 翻成宿主的 `KojoStructureIndentRules` 三条腿
 *   （`increase` / `decrease` / `enter`，`mergeIndentConfig` 直接可吃），**只有查询缺席 /
 *   编译失败**才回 `query-unavailable`——查询在、但这份文档没有开体行 ⇒ 三条腿全空（合法答案，
 *   宿主据此不重发语言配置）。
 */
import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import type { Kojo2Capture } from './kojo2-tokenizer';
import type {
  Kojo2QueryKind,
  Kojo2RuntimeFailure,
  Kojo2RuntimeResult,
  Kojo2TreeSitterRuntime,
} from './kojo2-runtime-core';
import type {
  StructureCaptureTable,
  StructureFacet,
  StructureFailureReason,
  StructureFoldTable,
  StructureIndentRules,
  StructureProtocolVersion,
  StructureReply,
  StructureRequest,
} from './protocol';
import { contentProblem, isStructureRequest, looksLikeLegacyStructureRequest } from './protocol';
import {
  isKojo2WorkerRequest,
  type Kojo2CapturesReply,
  type Kojo2FoldRange,
  type Kojo2FoldsReply,
  type Kojo2IndentRules,
  type Kojo2IndentsReply,
  type Kojo2ParseReply,
  type Kojo2WorkerFailure,
  type Kojo2WorkerFailureReason,
  type Kojo2WorkerQueryRequest,
  type Kojo2WorkerReply,
  type Kojo2WorkerRequest,
  type Kojo2WorkerRequestType,
} from './kojo2-worker-protocol';

/** 树缓存上限：正常编辑只用到 1 棵；8 棵给左右分屏 / 迟到请求留余量 */
export const KOJO2_WORKER_MAX_TREES = 8;
/**
 * 运行时装载最多试几次（本批）：一次 `fetch` / 解压 / 超时抖动不该把这条 worker 判死一辈子，
 * 但重试也只给一次——无限重试会在 wasm 起不来时把 CPU 打满。
 */
export const KOJO2_RUNTIME_LOAD_ATTEMPTS = 2;
/** 折叠区间上限：5k 行文档的 `block` 数量远小于此；病态文档不许把数组撑爆 */
export const KOJO2_WORKER_MAX_FOLDS = 4_000;

interface CachedTree {
  readonly tree: Tree;
  /** 这棵树对应的全文（查询请求拿它判断"能不能直接查"） */
  readonly text: string;
  readonly version: number;
}

export interface Kojo2WorkerEngineOptions {
  /**
   * 装载运行时（**必须**由调用方给：worker 入口传零动态 import 的 `createKojo2Runtime`，
   * 测试传 `getKojo2TreeSitterRuntime(realDeps)` 的包装）。引擎自己不 import
   * `kojo2-runtime.ts`——那个模块带动态 import，进了 worker 图就会切 chunk。
   */
  readonly loadRuntime: () => Promise<Kojo2RuntimeResult>;
  readonly maxTrees?: number;
}

export interface Kojo2WorkerEngine {
  /** 串行处理（一条 worker 只有一个 parser，消息环本来就不该交错） */
  handle(request: Kojo2WorkerRequest): Promise<Kojo2WorkerReply>;
  /**
   * 预热（LAU-1：v3 `open` 要 `loadMs` 与"装不上就早说"）：幂等地把运行时装起来。
   * 失败不进缓存（见 `loadRuntime` 的注释），所以下一次请求还会再试。
   */
  warmup(): Promise<Kojo2RuntimeResult>;
  /** `treeId` 对应的全文（v3 `parse{edit}` 在这条线程里缝文本用）；不认识 = null */
  treeText(treeId: string): string | null;
  /** 幂等：删缓存树 + 释放自己装载的运行时 */
  dispose(): void;
  readonly treeCount: number;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeDeleteTree(tree: Tree): void {
  try {
    tree.delete();
  } catch {
    /* 已被别处删除 / wasm 已卸载：没有可回收的 */
  }
}

function failure(
  id: number,
  type: Kojo2WorkerRequestType | undefined,
  reason: Kojo2WorkerFailureReason,
  message: string,
  treeId?: string,
): Kojo2WorkerFailure {
  return treeId === undefined
    ? { ok: false, id, type, reason, message }
    : { ok: false, id, type, reason, message, treeId };
}

/**
 * `@fold` 捕获 → 折叠区间（纯函数，便于单测）。
 *
 * 宿主约定（与 v1 逐字一致）：取捕获节点的 `startPosition.row .. endPosition.row`，
 * **只有 `endRow > startRow`** 才产生折叠；同一区间去重；按（起行升序、止行降序）排。
 */
export function foldsFromCaptures(
  captures: readonly Kojo2Capture[],
  maxFolds: number = KOJO2_WORKER_MAX_FOLDS,
): Kojo2FoldRange[] {
  const limit = Number.isFinite(maxFolds) && maxFolds >= 1 ? Math.trunc(maxFolds) : KOJO2_WORKER_MAX_FOLDS;
  const seen = new Set<string>();
  const out: Kojo2FoldRange[] = [];
  for (const capture of captures) {
    if (capture === null || typeof capture !== 'object' || capture.name !== 'fold') continue;
    const startRow = capture.startPosition?.row;
    const endRow = capture.endPosition?.row;
    if (typeof startRow !== 'number' || typeof endRow !== 'number') continue;
    if (!Number.isFinite(startRow) || !Number.isFinite(endRow)) continue;
    const from = Math.trunc(startRow);
    const to = Math.trunc(endRow);
    if (from < 0 || to <= from) continue;
    const key = `${from}:${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ startRow: from, endRow: to, kind: 'block' });
    if (out.length >= limit) break;
  }
  out.sort((a, b) => a.startRow - b.startRow || b.endRow - a.endRow);
  return out;
}

/** 缩进规则条数上限：词形家族只有十几枚，64 已经比现实宽一个量级（病态文档不许把数组撑爆） */
export const KOJO2_WORKER_MAX_INDENT_PATTERNS = 64;

/** 宿主契约里的捕获名（`queries/v2/indents.scm` 用的就是这三个 / 加 align；不新造词） */
const INDENT_INCREASE = 'indent.increase';
const INDENT_ENTER = 'indent.enter';
const INDENT_DECREASE = 'indent.decrease';
const INDENT_ALIGN = 'indent.align';

/** 行首空白集：与 core 词法器同一张表（半角空格 / Tab / 全角空格） */
const LEAD = '[ \\t\\u3000]';

/** 正则元字符转义（词形是 CJK，但保留转义以防词表扩展） */
function escapePatternSource(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 按物理行切（CRLF / CR / LF 都算；与 core `lex` 的行号同源） */
function splitTextLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * 捕获节点的**首行** → "行首锚 + 词形"的锚定正则源码（够用即止；`null` = 这一格没有规则）。
 *
 * 派生口径（`queries/v2/indents.scm` 头注里承诺的"kind → 档位表"在宿主侧的唯一实现）：
 * - `#` 声明头：`#` + 空白 + **词形**（表名 / 池名 / 模板名都不进规则）；
 * - `@` 调度头：`@` + 词形（`@算` / `@随机` / `@原生` …；实参不进规则）；
 * - `?`：行首锚点本身就是词形（`? 恋慕 >= 500` / `? 否` / `?否` 同一条；`!` 分支留着但
 *   本批查询不捕它——裸调用行与触发块头同形，见 `queries/v2/indents.scm` 头注）。
 *
 * 为什么不用"整行精确匹配"（v1 那条路）：块头行带实参，整行文本一换就失效；这里只取
 * **首个词形**，换表名 / 换条件 / 换实参都不改规则。词形从文档原文取，不在本文件手写词表
 * （2.0 词表真源在 core，worker 不引它——那会把糖词表拖进 worker 图）。
 */
function headPatternOf(line: string): string | null {
  const trimmed = line.replace(/^[ \t\u3000]+/, '');
  if (trimmed.length === 0) return null;
  const anchor = trimmed[0]!;
  if (anchor === '#') {
    const word = /^#[ \t\u3000]+(\S+)/.exec(trimmed);
    if (word === null) return null;
    return `^${LEAD}*#${LEAD}+${escapePatternSource(word[1]!)}(?:${LEAD}|$)`;
  }
  if (anchor === '@') {
    // 调度词后可以紧跟实参（`@函 名(...)`）：词形在空白 / 括注 / 逗号 / 冒号处截断
    const word = /^@([^\s(（,，:：]+)/.exec(trimmed);
    if (word === null) return null;
    return `^${LEAD}*@${escapePatternSource(word[1]!)}(?:${LEAD}|$)`;
  }
  // `?` / `!` 是行首锚点：2.0 里一行的首字符就是判据，后面紧跟什么都还是同一个锚点
  // （`? 否` / `?否` / `? 任意条件` 必须同一条规则）
  if (anchor === '?') return `^${LEAD}*\\?`;
  if (anchor === '!') return `^${LEAD}*!`;
  return null;
}

/**
 * `@indent.*` 捕获 → 宿主的缩进规则（纯函数，便于单测）。
 *
 * 三腿去向（与 `KojoStructureIndentRules` / `mergeIndentConfig` 逐字对齐）：
 * - `indent.increase` → `increasePatterns` **与** `enterPatterns`（回车 / 行中回车 / 粘贴都要抬
 *   一级；v1 糖侧的 `indentOnEnter` 与 `increaseIndentPattern` 也是同一批源码，口径一致）；
 * - `indent.enter` → `enterPatterns`（查询若显式给了这一档就用它；本批不重复捕获）；
 * - `indent.decrease` → `decreasePatterns`（2.0 没有收束记号，查询目前不捕获 ⇒ 恒空）；
 * - `indent.align` → **不翻译**：Monaco 的默认"新行沿用当前行缩进"就是同级；这一档是给
 *   nvim 式消费者的并列真源，硬塞进三腿只会多出一条错误规则。
 *
 * 失败方向是"少给规则"：坐标越界 / 首行取不到 / 不是开体形状 ⇒ 这一条跳过，不抛。
 */
export function indentRulesFromCaptures(
  captures: readonly Kojo2Capture[],
  text: string,
  maxPatterns: number = KOJO2_WORKER_MAX_INDENT_PATTERNS,
): Kojo2IndentRules {
  const limit =
    Number.isFinite(maxPatterns) && maxPatterns >= 1
      ? Math.trunc(maxPatterns)
      : KOJO2_WORKER_MAX_INDENT_PATTERNS;
  const empty: Kojo2IndentRules = { increasePatterns: [], decreasePatterns: [], enterPatterns: [] };
  if (typeof text !== 'string' || captures.length === 0) return empty;
  const lines = splitTextLines(text);
  const increase = new Set<string>();
  const enter = new Set<string>();
  const decrease = new Set<string>();
  for (const capture of captures) {
    if (capture === null || typeof capture !== 'object') continue;
    const name = capture.name;
    // 并列档（`indent.align`）是给 nvim 式消费者的真源：不投影到三腿，也不落到任何一条规则
    if (name === INDENT_ALIGN) continue;
    if (name !== INDENT_INCREASE && name !== INDENT_ENTER && name !== INDENT_DECREASE) continue;
    const start = capture.startPosition;
    const row = start?.row;
    if (typeof row !== 'number' || !Number.isFinite(row)) continue;
    const line = lines[Math.trunc(row)];
    if (line === undefined) continue;
    const column = typeof start?.column === 'number' && Number.isFinite(start.column) ? Math.trunc(start.column) : 0;
    const pattern = headPatternOf(line.slice(Math.max(0, column)));
    if (pattern === null) continue;
    if (name === INDENT_DECREASE) {
      if (decrease.size < limit) decrease.add(pattern);
      continue;
    }
    if (increase.size < limit) increase.add(pattern);
    if (enter.size < limit) enter.add(pattern);
  }
  return {
    increasePatterns: [...increase].sort(),
    decreasePatterns: [...decrease].sort(),
    enterPatterns: [...enter].sort(),
  };
}

/**
 * 造一条 worker 侧引擎（不起线程：消息环在 {@link startKojo2Worker}）。
 *
 * 运行时由 `options.loadRuntime` 交进来；引擎在 `dispose()` 时对它调 `dispose()`
 * （运行时自身的 `dispose` 幂等；worker 线程被 terminate 时 wasm 也会随线程回收）。
 */
export function createKojo2WorkerEngine(options: Kojo2WorkerEngineOptions): Kojo2WorkerEngine {
  const maxTrees = Number.isFinite(options.maxTrees) && (options.maxTrees ?? 0) >= 1
    ? Math.trunc(options.maxTrees as number)
    : KOJO2_WORKER_MAX_TREES;
  /** 插入序 = LRU 序（Map 保序；每次命中不额外搬，够用） */
  const trees = new Map<string, CachedTree>();
  let treeSeq = 0;
  let runtimePromise: Promise<Kojo2RuntimeResult> | null = null;
  let runtimeAttempts = 0;
  let runtime: Kojo2TreeSitterRuntime | null = null;
  let disposed = false;
  let queue: Promise<void> = Promise.resolve();

  /**
   * 装载运行时（**成功才缓存**）。
   *
   * 失败不进 `runtimePromise`：缓存住的失败等于"一次抖动 ⇒ 这条 worker 这一辈子都起不来"
   * （作者在一个文件里打字，worker 线程就一直活着，直到换文件 / 重开才重建）。故失败时清空
   * promise，下一次请求会再试一次；`KOJO2_RUNTIME_LOAD_ATTEMPTS` 是硬上限（不做无限重试：
   * wasm 真的起不来时，无限重试只会把 CPU 与网络打满）。第二次起仍失败就真的持续失败，
   * 且消息里写清"已重试一次仍失败"——台账上不能让人误以为是第一次抖。
   */
  const loadRuntime = (): Promise<Kojo2RuntimeResult> => {
    if (runtimePromise !== null) return runtimePromise;
    const attempt = runtimeAttempts + 1;
    runtimeAttempts = attempt;
    const giveUp = (result: Kojo2RuntimeFailure): Kojo2RuntimeResult => {
      if (attempt < KOJO2_RUNTIME_LOAD_ATTEMPTS) {
        runtimePromise = null; // 还有一次机会 ⇒ 别把这次失败钉在这一线程上
        return result;
      }
      return { ...result, message: `${result.message}（已重试一次仍失败）` };
    };
    runtimePromise = options.loadRuntime().then(
      (result) => {
        if (!result.ok) return giveUp(result);
        if (disposed) {
          // 装载在 dispose 之后才回来：当场释放，不给 wasm 留一条没人负责的引用
          result.runtime.dispose();
          return { ok: false, reason: 'disposed', message: '结构解析 worker 已释放 ⇒ 调用方降级到词法层' };
        }
        runtime = result.runtime;
        return result;
      },
      (error: unknown): Kojo2RuntimeResult =>
        giveUp({
          ok: false,
          reason: 'unavailable',
          message: `结构解析运行时装载抛错：${describeError(error)}`,
        }),
    );
    return runtimePromise;
  };

  const forget = (treeId: string): CachedTree | null => {
    const entry = trees.get(treeId);
    if (entry === undefined) return null;
    trees.delete(treeId);
    return entry;
  };

  const evict = (): void => {
    while (trees.size > maxTrees) {
      const oldest = trees.keys().next();
      if (oldest.done === true) return;
      const entry = forget(oldest.value);
      if (entry !== null) safeDeleteTree(entry.tree);
    }
  };

  const remember = (tree: Tree, text: string, version: number): string => {
    const treeId = `t${++treeSeq}`;
    trees.set(treeId, { tree, text, version });
    evict();
    return treeId;
  };

  /** 增量之后旧树已被 `tree.edit` 改写过：从缓存删掉并立即释放（运行时头注的所有权口径） */
  const dropAfterEdit = (treeId: string | undefined): void => {
    if (treeId === undefined) return;
    const entry = forget(treeId);
    if (entry !== null) safeDeleteTree(entry.tree);
  };

  interface ResolvedTree {
    readonly ok: true;
    readonly treeId: string;
    readonly root: SyntaxNode;
    readonly incremental: boolean;
    readonly reparsed: boolean;
    readonly runtime: Kojo2TreeSitterRuntime;
  }

  type ResolveResult = ResolvedTree | Kojo2WorkerFailure;

  /**
   * 把一条查询请求变成"一棵可查的树"：缓存命中且文本相同 ⇒ 不重解；
   * 文本变了 ⇒ 增量重解；树不认识 ⇒ 整篇重解。
   */
  const resolveTree = async (request: Kojo2WorkerQueryRequest): Promise<ResolveResult> => {
    const loaded = await loadRuntime();
    if (!loaded.ok) return failure(request.id, request.type, loaded.reason, loaded.message);
    const active = loaded.runtime;
    const cached = request.oldTreeId === undefined ? null : trees.get(request.oldTreeId) ?? null;
    if (cached !== null && cached.text === request.text) {
      return { ok: true, treeId: request.oldTreeId!, root: cached.tree.rootNode, incremental: false, reparsed: false, runtime: active };
    }
    const parsed = active.parse(request.text, cached?.tree ?? null);
    dropAfterEdit(request.oldTreeId);
    if (!parsed.ok) {
      return failure(request.id, request.type, parsed.reason, parsed.message);
    }
    const treeId = remember(parsed.tree, request.text, request.version);
    return {
      ok: true,
      treeId,
      root: parsed.rootNode,
      incremental: parsed.incremental,
      reparsed: true,
      runtime: active,
    };
  };

  const runParse = async (request: Extract<Kojo2WorkerRequest, { type: 'parse' }>): Promise<Kojo2WorkerReply> => {
    const loaded = await loadRuntime();
    if (!loaded.ok) return failure(request.id, 'parse', loaded.reason, loaded.message);
    const active = loaded.runtime;
    const previous = request.oldTreeId === undefined ? null : trees.get(request.oldTreeId) ?? null;
    const started = nowMs();
    const parsed = active.parse(request.text, previous?.tree ?? null);
    const parseMs = Math.max(0, nowMs() - started);
    dropAfterEdit(request.oldTreeId);
    if (!parsed.ok) return failure(request.id, 'parse', parsed.reason, parsed.message);
    const reply: Kojo2ParseReply = {
      ok: true,
      id: request.id,
      type: 'parse',
      version: request.version,
      treeId: remember(parsed.tree, request.text, request.version),
      incremental: parsed.incremental,
      changedRanges: parsed.changedRanges,
      textLength: parsed.textLength,
      parseMs,
      loadMs: active.initMs,
    };
    return reply;
  };

  const runQuery = async (request: Kojo2WorkerQueryRequest): Promise<Kojo2WorkerReply> => {
    const kind: Kojo2QueryKind = request.type === 'captures' ? 'highlights' : request.type;
    // indents 先看查询买没买：查询缺席 / 编译失败就不为一条注定 `query-unavailable` 的请求白解一棵树
    // （查询在时一定真跑——这份文档有没有开体行是另一回事，三条腿可能就是全空）。
    if (request.type === 'indents') {
      const loaded = await loadRuntime();
      if (!loaded.ok) return failure(request.id, 'indents', loaded.reason, loaded.message);
      const status = loaded.runtime.queryStatus('indents');
      if (!status.ok) return failure(request.id, 'indents', status.reason, status.message);
    }
    const resolved = await resolveTree(request);
    if (!resolved.ok) return resolved;
    const status = resolved.runtime.queryStatus(kind);
    if (!status.ok) return failure(request.id, request.type, status.reason, status.message, resolved.treeId);
    const started = nowMs();
    const captured = resolved.runtime.queryCaptures(resolved.root, kind);
    const queryMs = Math.max(0, nowMs() - started);
    if (!captured.ok) {
      return failure(request.id, request.type, captured.reason, captured.message, resolved.treeId);
    }
    const common = {
      ok: true as const,
      id: request.id,
      version: request.version,
      treeId: resolved.treeId,
      incremental: resolved.incremental,
      reparsed: resolved.reparsed,
      queryMs,
      loadMs: resolved.runtime.initMs,
    };
    if (request.type === 'captures') {
      const reply: Kojo2CapturesReply = { ...common, type: 'captures', captures: captured.captures };
      return reply;
    }
    if (request.type === 'folds') {
      const reply: Kojo2FoldsReply = {
        ...common,
        type: 'folds',
        folds: foldsFromCaptures(captured.captures),
      };
      return reply;
    }
    // indents：查询真的跑了 ⇒ 捕获翻成宿主的三条腿。查询在、但这份文档没有开体行 ⇒ 三条腿全空：
    // 那是合法答案（宿主 `mergeIndentConfig` 拿到空规则就不重发语言配置），不是"不可用"。
    const reply: Kojo2IndentsReply = {
      ...common,
      type: 'indents',
      rules: indentRulesFromCaptures(captured.captures, request.text),
    };
    return reply;
  };

  const dispatch = async (request: Kojo2WorkerRequest): Promise<Kojo2WorkerReply> => {
    if (disposed) {
      return failure(
        isKojo2WorkerRequest(request) ? request.id : 0,
        isKojo2WorkerRequest(request) ? request.type : undefined,
        'disposed',
        '结构解析 worker 已释放 ⇒ 调用方降级到词法层',
      );
    }
    if (!isKojo2WorkerRequest(request)) {
      return failure(0, undefined, 'invalid-input', 'worker 收到的请求形状不符协议（缺 id / type）');
    }
    if (typeof request.text !== 'string') {
      return failure(request.id, request.type, 'invalid-input', '请求的 text 不是字符串');
    }
    if (typeof request.version !== 'number' || !Number.isFinite(request.version)) {
      return failure(request.id, request.type, 'invalid-input', '请求的 version 不是有限数');
    }
    try {
      return request.type === 'parse' ? await runParse(request) : await runQuery(request);
    } catch (error) {
      return failure(request.id, request.type, 'crashed', `worker 处理请求时抛错：${describeError(error)}`);
    }
  };

  const handle = (request: Kojo2WorkerRequest): Promise<Kojo2WorkerReply> => {
    const run = queue.then(
      () => dispatch(request),
      () => dispatch(request),
    );
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    handle,
    warmup: () => loadRuntime(),
    treeText(treeId: string): string | null {
      return trees.get(treeId)?.text ?? null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of trees.values()) safeDeleteTree(entry.tree);
      trees.clear();
      // 运行时自己的 dispose 幂等；即使它是测试注入的共享单例，重复 dispose 也无副作用
      // （宿主侧 `disposeKojo2TreeSitterRuntime()` 之后再收一次账照旧成立）。
      runtime?.dispose();
      runtime = null;
    },
    get treeCount() {
      return trees.size;
    },
  };
}

/** worker 全局的窄投影（app 的 tsconfig 只挂 DOM lib，不挂 WebWorker lib） */
export interface Kojo2WorkerScope {
  postMessage(message: StructureReply): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

/** 协议环（LAU-1）：v3 请求进、v3 回话出；引擎仍是 v2 那一套内部请求，翻译只在这一层 */
export interface Kojo2ProtocolRing {
  handle(request: unknown): Promise<StructureReply>;
  dispose(): void;
}

/** 内部失败原因 → v3 的闭集（表外/近义项逐条对拍，不新造词） */
function protocolReasonOf(reason: Kojo2WorkerFailureReason): StructureFailureReason {
  switch (reason) {
    case 'unavailable':
      return 'unavailable';
    case 'timeout':
      return 'timeout';
    case 'disposed':
      return 'disposed';
    case 'invalid-input':
      return 'invalid-input';
    case 'parse-failed':
      return 'parse-failed';
    case 'crashed':
      return 'crashed';
    case 'protocol-error':
      return 'protocol-mismatch';
    // `query-unavailable`（没给那份查询 / 编译失败）与 `query-failed`（执行抛错）在 v3 是同一枚：
    // 都是"查询这一面没成"，代价（停哪一面）由宿主决定（D2）。
    default:
      return 'query-failed';
  }
}

/** 单面（v3 `StructureFacet`）↔ 内部查询类型 */
function queryTypeOf(facet: StructureFacet): 'captures' | 'folds' | 'indents' | null {
  if (facet === 'semantic') return 'captures';
  if (facet === 'folds') return 'folds';
  if (facet === 'indent') return 'indents';
  return null; // kojo2 这一族不产结构残缺（syntax 面由 v1 语言那条 worker 供）
}

/**
 * v3 协议环：把一条 `open` / `parse` 翻成若干次引擎调用，再把引擎的回话拼成**一条** v3 回话。
 *
 * ## 为什么翻译放在这一层而不是改引擎
 *
 * 引擎（`createKojo2WorkerEngine`）的请求语义是"一个 `type` 一个回答"，树缓存 / 增量 / 查询
 * 降级全挂在它身上，`tests/kojo2-worker.test.ts` 打的就是那条路。LAU-1 要的是**线上**协议合并
 * （一条请求一条回复、面合进 `facets`），不是把引擎拆了重写——翻译在环上，引擎一行不动。
 *
 * ## `want` 与真账
 *
 * kojo2 的三面各是一条查询（`captures` / `folds` / `indents`）。`want` 只点一面时环只发那一条
 * （查询那条路自己会解树，树在缓存里时直接查）；多点几面时先 `parse` 一次拿 `treeId`，
 * 再按 `treeId` 查——**宿主那边始终只走一个来回**（D3 的收益），worker 内部仍是三条查询。
 */
export function createKojo2ProtocolRing(
  engine: Kojo2WorkerEngine,
  protocol: StructureProtocolVersion = 3,
): Kojo2ProtocolRing {
  /** 预热一次（`open` 与首条 parse 都等它；失败不进缓存，下一次还会再试） */
  let warmed: Promise<Kojo2RuntimeResult> | null = null;
  const warm = (): Promise<Kojo2RuntimeResult> => {
    if (warmed === null) warmed = engine.warmup();
    return warmed;
  };

  const ok = (reply: StructureReply): StructureReply => reply;
  const failed = (id: number, kind: 'open' | 'parse' | undefined, reason: StructureFailureReason, message: string, treeId?: string): StructureReply =>
    treeId === undefined
      ? { ok: false, id, ...(kind === undefined ? {} : { kind }), reason, message }
      : { ok: false, id, ...(kind === undefined ? {} : { kind }), reason, message, treeId };

  /**
   * 捕获列表 → 扁平投影。
   *
   * LAU-6 起 `nodes` 字典**不再恒为 `['']`**：注入层要按节点类型认宿主节点
   * （descriptor 的 `injections.hostNode`），所以每条捕获的 `nodeIndex` 指向
   * `capture.nodeType`。字典去重方式与 `names` 同口径（去重后）。
   */
  const captureTable = (captures: readonly Kojo2Capture[]): StructureCaptureTable => {
    const names: string[] = [];
    const index = new Map<string, number>();
    const nodes: string[] = [];
    const nodeIndex = new Map<string, number>();
    const spans: number[] = [];
    for (const capture of captures) {
      let at = index.get(capture.name);
      if (at === undefined) {
        at = names.length;
        names.push(capture.name);
        index.set(capture.name, at);
      }
      const node = capture.nodeType ?? '';
      let nodeAt = nodeIndex.get(node);
      if (nodeAt === undefined) {
        nodeAt = nodes.length;
        nodes.push(node);
        nodeIndex.set(node, nodeAt);
      }
      spans.push(
        capture.startPosition.row,
        capture.startPosition.column,
        capture.endPosition.row,
        capture.endPosition.column,
        at,
        nodeAt,
      );
    }
    return { names, nodes, spans };
  };

  const handleParse = async (request: Extract<StructureRequest, { kind: 'parse' }>): Promise<StructureReply> => {
    const problem = contentProblem(request);
    if (problem !== null) return failed(request.id, 'parse', 'invalid-input', problem);
    if (request.includedRanges !== undefined) {
      // LAU-6 起区间路由子语言 worker（ERB）走；本 worker 是主树那一侧，不收区间。
      return failed(request.id, 'parse', 'invalid-input', '本 worker 不支持 includedRanges（主树恒按全文档解；注入子 parse 发给子语言 worker）');
    }
    const loaded = await warm();
    if (!loaded.ok) return failed(request.id, 'parse', protocolReasonOf(loaded.reason), loaded.message);

    let text: string;
    let baseTreeId = request.baseTreeId;
    if ('text' in request) {
      text = request.text;
    } else {
      const baseline = baseTreeId === undefined ? null : engine.treeText(baseTreeId);
      if (baseline === null) {
        // 基线树不认识：宿主手里有全文，改发整篇即可（不算故障）
        return failed(request.id, 'parse', 'parse-failed', `baseTreeId ${String(baseTreeId)} 不是本线程手上那棵树 ⇒ 请改发整篇 text`);
      }
      const edit = request.edit;
      text = baseline.slice(0, edit.start.offset) + edit.newText + baseline.slice(edit.oldEnd.offset);
    }

    // `want` 缺省 = 全带（§4.1）：kojo2 这一族不产 `syntax` 面（它由 v1 语言那条 worker 供），
    // 故这一面点名了也只会安静缺省——`queryTypeOf` 回 null 即"这一面这次没算"。
    const want: readonly StructureFacet[] = request.want ?? ['semantic', 'folds', 'indent', 'syntax'];
    const queryTypes = want.map(queryTypeOf).filter((type): type is 'captures' | 'folds' | 'indents' => type !== null);
    const parsers: { parseMs: number; queryMs: number; loadMs: number; treeId: string; incremental: boolean } = {
      parseMs: 0,
      queryMs: 0,
      loadMs: loaded.runtime.initMs,
      treeId: baseTreeId ?? '',
      incremental: baseTreeId !== undefined,
    };
    const facets: {
      semantic?: StructureCaptureTable;
      folds?: StructureFoldTable;
      indent?: StructureIndentRules;
    } = {};
    let treeIdForReply: string | undefined;

    // 一次只问一面：直接发那条查询（它自己会在需要时解树），省掉一条内部的 parse。
    if (queryTypes.length <= 1) {
      const only = queryTypes[0];
      if (only === undefined) {
        // 只要指标：解一条 `parse`（`want` 空数组 = 宿主只要树身份与耗时）
        const parsed = await engine.handle({ id: request.id, type: 'parse', text, version: request.version, oldTreeId: baseTreeId });
        if (!parsed.ok) return failed(request.id, 'parse', protocolReasonOf(parsed.reason), parsed.message, parsed.treeId);
        if (parsed.type !== 'parse') return failed(request.id, 'parse', 'protocol-mismatch', '内部回话形状不符（parse 请求回了别的 type）');
        parsers.parseMs = parsed.parseMs;
        parsers.treeId = parsed.treeId;
        parsers.incremental = parsed.incremental;
        treeIdForReply = parsed.treeId;
      } else {
        const queried = await engine.handle({ id: request.id, type: only, text, version: request.version, oldTreeId: baseTreeId });
        if (!queried.ok) return failed(request.id, 'parse', protocolReasonOf(queried.reason), queried.message, queried.treeId);
        if (queried.type !== only) return failed(request.id, 'parse', 'protocol-mismatch', `内部回话形状不符（${only} 请求回了 ${String(queried.type)}）`);
        parsers.queryMs += queried.queryMs;
        parsers.loadMs = queried.loadMs;
        parsers.treeId = queried.treeId;
        parsers.incremental = queried.incremental;
        treeIdForReply = queried.treeId;
        if (queried.type === 'captures') facets.semantic = captureTable(queried.captures);
        else if (queried.type === 'folds')
          facets.folds = { spans: queried.folds.flatMap((fold) => [fold.startRow, fold.endRow]) };
        else if (queried.type === 'indents') facets.indent = queried.rules;
      }
    } else {
      // 多点几面：先解一棵树，再按 treeId 查（树在缓存里、文本逐字相同 ⇒ 直接查）
      const parsed = await engine.handle({ id: request.id, type: 'parse', text, version: request.version, oldTreeId: baseTreeId });
      if (!parsed.ok) return failed(request.id, 'parse', protocolReasonOf(parsed.reason), parsed.message, parsed.treeId);
      if (parsed.type !== 'parse') return failed(request.id, 'parse', 'protocol-mismatch', '内部回话形状不符（parse 请求回了别的 type）');
      parsers.parseMs = parsed.parseMs;
      parsers.loadMs = parsed.loadMs;
      parsers.treeId = parsed.treeId;
      parsers.incremental = parsed.incremental;
      treeIdForReply = parsed.treeId;
      for (const type of queryTypes) {
        const queried = await engine.handle({ id: request.id, type, text, version: request.version, oldTreeId: parsed.treeId });
        if (!queried.ok) return failed(request.id, 'parse', protocolReasonOf(queried.reason), queried.message, queried.treeId ?? parsed.treeId);
        if (queried.type !== type) return failed(request.id, 'parse', 'protocol-mismatch', `内部回话形状不符（${type} 请求回了 ${String(queried.type)}）`);
        parsers.queryMs += queried.queryMs;
        if (queried.type === 'captures') facets.semantic = captureTable(queried.captures);
        else if (queried.type === 'folds') facets.folds = { spans: queried.folds.flatMap((fold) => [fold.startRow, fold.endRow]) };
        else if (queried.type === 'indents') facets.indent = queried.rules;
      }
    }

    return ok({
      ok: true,
      id: request.id,
      kind: 'parse',
      doc: request.doc,
      version: request.version,
      treeId: treeIdForReply ?? parsers.treeId,
      incremental: parsers.incremental,
      facets,
      metrics: { parseMs: parsers.parseMs, queryMs: parsers.queryMs, textLength: text.length },
    });
  };

  return {
    async handle(request: unknown): Promise<StructureReply> {
      if (!isStructureRequest(request)) {
        // 旧协议（v2）的 `captures` / `folds` / `indents` / `parse`：说清"对面还是旧形状"
        if (looksLikeLegacyStructureRequest(request)) {
          const id = (request as { id?: unknown }).id;
          return failed(
            typeof id === 'number' && Number.isFinite(id) ? id : 0,
            undefined,
            'protocol-mismatch',
            `收到旧协议（v2）消息（type=${String((request as { type?: unknown }).type)}）⇒ 这条 worker 只说 v3`,
          );
        }
        return failed(0, undefined, 'invalid-input', 'worker 收到的请求形状不符 v3 协议（缺 id / kind，或字段类型不对）');
      }
      if (request.kind === 'open') {
        if (request.protocol !== protocol) {
          return failed(
            request.id,
            'open',
            'protocol-mismatch',
            `协议版本不符（worker 认 ${protocol}，宿主发 ${request.protocol}）⇒ 宿主该降级到旧协议那条路`,
          );
        }
        const loaded = await warm();
        if (!loaded.ok) return failed(request.id, 'open', protocolReasonOf(loaded.reason), loaded.message);
        return { ok: true, id: request.id, kind: 'ready', protocol, loadMs: loaded.runtime.initMs };
      }
      try {
        return await handleParse(request);
      } catch (error: unknown) {
        return failed(request.id, 'parse', 'crashed', `worker 处理请求时抛错：${describeError(error)}`);
      }
    },
    dispose() {
      engine.dispose();
    },
  };
}

/**
 * 装消息环并返回引擎（worker 入口 `kojo2-ts.worker.ts` 只调这一句；测试可传自己的 scope）。
 *
 * 收件闸在 ring 里：形状不符的请求回 `invalid-input`（有 id 就带 id），旧形状回
 * `protocol-mismatch`——**不再一声不响**（LAU-1 之前这里直接 return，旧宿主只会看到超时）。
 * 回话失败（主线程已经 `terminate()`）在这里吞掉：线程下一刻就不归我们管了。
 *
 * `options.loadRuntime` 在生产入口里**必须**由静态资源装配（见 `kojo2-ts.worker.ts` 头注）：
 * worker 的 iife 产物不接受动态 import 切 chunk，资源必须由入口静态 import 后注入。
 */
export function startKojo2Worker(
  options: Kojo2WorkerEngineOptions,
  scope?: Kojo2WorkerScope,
): Kojo2WorkerEngine {
  const target = scope ?? (self as unknown as Kojo2WorkerScope);
  const engine = createKojo2WorkerEngine(options);
  const ring = createKojo2ProtocolRing(engine);
  target.onmessage = (event: MessageEvent<unknown>) => {
    void ring.handle(event.data).then(
      (reply) => {
        try {
          target.postMessage(reply);
        } catch {
          /* 主线程已经没了：worker 也会被 terminate，没有可补救的 */
        }
      },
      (error: unknown) => {
        try {
          target.postMessage({
            ok: false,
            id: 0,
            reason: 'crashed',
            message: `worker 回话链断了：${describeError(error)}`,
          });
        } catch {
          /* 同上 */
        }
      },
    );
  };
  target.onerror = (event: ErrorEvent) => {
    try {
      target.postMessage({
        ok: false,
        id: 0,
        reason: 'crashed',
        message: `worker 线程异常：${event.message || '（无消息）'}`,
      });
    } catch {
      /* 同上 */
    }
  };
  return engine;
}
