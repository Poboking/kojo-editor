/**
 * Kojo 2.0 tree-sitter 运行时的**无装载器内核**（纯 wasm 装配 + 解析 + 查询）。
 *
 * ## 为什么从 `kojo2-runtime.ts` 拆出来
 *
 * worker 的产物是默认的 iife，不接受 code-splitting；而 `kojo2-runtime.ts` 的默认装载器
 * 里挂着 `import('web-tree-sitter')` / `import('./kojo2-assets')`（主线程懒加载的交付面）。
 * 只要 worker 模块图里出现这两条动态 import，Rollup 就会切 chunk，`pnpm --filter @kojo/app build`
 * 当场失败（v1 的 `client.ts` 头注记过同一条坑）。所以：
 *
 * - 本文件**零动态 import**：模块与资源都由调用方以函数形式交进来；
 * - worker 入口（`kojo2-ts.worker.ts`）静态 import 两枚 wasm / 三份查询 / `web-tree-sitter`，
 *   把 `() => module` 与 `() => assets` 传进来；
 * - 主线程侧的懒加载单例仍在 `kojo2-runtime.ts`（它才允许出现动态 import，且不在 worker 图里）。
 *
 * ## 失败面：一切都回 `{ ok: false, reason }`，不抛
 *
 * | reason | 什么时候 |
 * |---|---|
 * | `timeout` | 整个装载（模块 + 资源 + `Parser.init` + `Language.load` + 查询编译）超过 `timeoutMs`（默认 5s） |
 * | `unavailable` | 模块 / 资源 / `Parser.init` / `Language.load` / `new Parser` 任一步失败 |
 * | `invalid-input` | `parse` 收到非字符串；查询收到不像节点的对象 |
 * | `disposed` | 运行时已 `dispose()`，调用方应降级 |
 * | `parse-failed` | 解析器抛错或返回 `null`（wasm 状态可疑） |
 * | `query-unavailable` | 没给那份查询，或查询编译失败（**parse 仍可用**，只少那一面） |
 * | `query-failed` | 查询执行抛错（树/查询生命周期错位） |
 *
 * 超时之后迟到的运行时会在 `then` 里被 `dispose()` 掉，绝不泄漏一个没人管的 parser。
 *
 * ## 增量口径
 *
 * `parse(text, oldTree?)` 的旧树必须是**本运行时上一次 parse 交出去的那棵**：
 * 运行时只记得自己见过的树（`WeakMap<Tree, string>` 里挂着它对应的旧文本），
 * 拿旧文本与新文本做一次保守差分（`commonEdit`），把差分报给 `tree.edit` 后
 * `parse(newText, oldTree)`。**起点可能往前推**到最近一枚顶层节点的起点——这是 v1
 * 实测过的语法性质（块头会被后面的文本决定要不要吞下正文；只报真实区间会漂），
 * 口径与 `engine.ts` 的 `reparseStart` 同源。代价只是多解一枚节点，不改变结果。
 *
 * 旧树不认识（别的运行时 / 已 dispose / 卸载过）⇒ 老老实实整篇重解，不算失败。
 * `tree.edit` 或增量 parse 抛错 ⇒ 丢掉旧树再整篇重解一次（增量只是优化，结果必须对）；
 * 整篇也抛 ⇒ `parse-failed`，调用方降级。
 *
 * ## 所有权
 *
 * 运行时**不删除**调用方手里的树：`parse` 返回的 `tree` 由调用方 `delete()`；
 * 传进来的旧树在增量解之后已被 `tree.edit` 改写过，调用方也不该再拿它当"新树"用。
 * `dispose()` 只释放 parser 与查询，不碰任何树。
 */
import type * as WebTreeSitter from 'web-tree-sitter';
import { commonEdit, type StructureEdit } from './edit';
import type { Kojo2Capture } from './kojo2-tokenizer';

/** 默认装载超时：一次首屏懒加载不该比这更久；超时就降级，别拿编辑器干等 */
export const KOJO2_RUNTIME_TIMEOUT_MS = 5_000;

/** 向 wasm 取文本的段长（与 `engine.ts` 同一口径：别每次取字都复制文档尾巴） */
const READ_CHUNK = 4_096;

/** `import('web-tree-sitter')` 的模块形状（测试可注入替身来模拟装载失败 / 挂起） */
export type Kojo2TreeSitterModule = typeof import('web-tree-sitter');

/**
 * 运行时需要的资源：两枚 wasm + 三份查询（查询各自可选 = 缺哪份就少哪一面，parse 不受影响）。
 *
 * `foldsQuery` / `indentsQuery` 是本批 additive 加上的：2.0 的 `queries/v2/` 里三份都在，
 * 折叠那一面真的有捕获（`(block) @fold`），缩进那一面**刻意零捕获**（见 `indents.scm` 头注），
 * 两者都交给 worker 侧判定，而不是在这里按文件名猜。
 */
export interface Kojo2RuntimeAssets {
  readonly runtimeWasmUrl: string;
  readonly grammarWasm: string | Uint8Array;
  readonly highlightsQuery?: string;
  readonly foldsQuery?: string;
  readonly indentsQuery?: string;
}

/** 运行时编译的三份查询（名字与 `queries/v2/*.scm` 一一对应） */
export type Kojo2QueryKind = 'highlights' | 'folds' | 'indents';

export type Kojo2RuntimeFailureReason =
  | 'timeout'
  | 'unavailable'
  | 'invalid-input'
  | 'disposed'
  | 'parse-failed'
  | 'query-unavailable'
  | 'query-failed';

export interface Kojo2RuntimeFailure {
  readonly ok: false;
  readonly reason: Kojo2RuntimeFailureReason;
  readonly message: string;
}

/** 一次编辑（旧/新两侧端点都带；`startIndex` 可能比真实编辑更早，见文件头） */
export interface Kojo2EditRange {
  readonly startIndex: number;
  readonly oldEndIndex: number;
  readonly newEndIndex: number;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly oldEndPosition: { readonly row: number; readonly column: number };
  readonly newEndPosition: { readonly row: number; readonly column: number };
}

export interface Kojo2ParseSuccess {
  readonly ok: true;
  readonly tree: WebTreeSitter.Tree;
  readonly rootNode: WebTreeSitter.Node;
  /** 这一趟有没有用上旧树（整篇重解 = false） */
  readonly incremental: boolean;
  /** 增量时的脏区间（保守：起点可能被推到上一枚顶层节点）；整篇解 = 空数组 */
  readonly changedRanges: readonly Kojo2EditRange[];
  readonly textLength: number;
}

export type Kojo2ParseResult = Kojo2ParseSuccess | Kojo2RuntimeFailure;

export interface Kojo2CaptureSuccess {
  readonly ok: true;
  /** 纯数据投影：Node 句柄不过这道缝（与 v1 worker 协议"Node 不跨线程"同一条纪律） */
  readonly captures: readonly Kojo2Capture[];
}

export type Kojo2CaptureResult = Kojo2CaptureSuccess | Kojo2RuntimeFailure;

/** 一份查询的可用性（查询买了没有 / 编译成功没有；不碰树） */
export type Kojo2QueryStatus = { readonly ok: true } | Kojo2RuntimeFailure;

/** 一门 2.0 文档可用的运行时；`parse` / `captures` 永不抛未捕获异常 */
export interface Kojo2TreeSitterRuntime {
  /** 从第一次 get 到 ready 的墙钟毫秒（读数用，不含调用方排队） */
  readonly initMs: number;
  parse(text: string, oldTree?: WebTreeSitter.Tree | null): Kojo2ParseResult;
  /** highlights 查询（v1 消费方的既有入口；等价于 `queryCaptures(root, 'highlights')`） */
  captures(root: WebTreeSitter.Node): Kojo2CaptureResult;
  /** 任意一份已编译查询的可用性（worker 用它决定 folds 真跑还是报 `query-unavailable`） */
  queryStatus(kind: Kojo2QueryKind): Kojo2QueryStatus;
  /** 在指定树上跑任意一份查询；坐标与捕获名原样（纯数据投影） */
  queryCaptures(root: WebTreeSitter.Node, kind: Kojo2QueryKind): Kojo2CaptureResult;
  /** 幂等；释放 parser 与三份查询。调用方手里的树不归这里管 */
  dispose(): void;
}

export type Kojo2RuntimeResult =
  | { readonly ok: true; readonly runtime: Kojo2TreeSitterRuntime }
  | Kojo2RuntimeFailure;

/* ------------------------------- 装载 ------------------------------- */

function normalizeTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.trunc(value)
    : KOJO2_RUNTIME_TIMEOUT_MS;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeType(value: unknown): string {
  return value === null ? 'null' : typeof value;
}

function failure(reason: Kojo2RuntimeFailureReason, message: string): Kojo2RuntimeFailure {
  return { ok: false, reason, message };
}

/** 一份查询的编译结果（`query === null` + `error === null` = 调用方压根没给这份资源） */
interface CompiledQuery {
  readonly query: WebTreeSitter.Query | null;
  readonly error: string | null;
}

function compileQuery(
  module: Kojo2TreeSitterModule,
  language: WebTreeSitter.Language,
  source: string | undefined,
): CompiledQuery {
  if (source === undefined) return { query: null, error: null };
  try {
    return { query: new module.Query(language, source), error: null };
  } catch (error) {
    // 查询坏了只少那一面，parse 仍应可用（不把整档打成不可用）
    return { query: null, error: describeError(error) };
  }
}

/**
 * 从"模块 + 资源"装配一份运行时（**零动态 import**：两条来源都由调用方给函数）。
 *
 * - worker 入口：静态 import 后传 `() => module` / `() => assets`；
 * - 主线程懒加载单例（`kojo2-runtime.ts`）：传动态 import 的包装；
 * - 测试：传读文件的资源 + `import('web-tree-sitter')` 替身。
 *
 * 装载全程受 `timeoutMs` 约束（含两个 loader 的耗时）；超时后迟到的运行时会自毁。
 */
export async function createKojo2Runtime(
  loadModule: () => Promise<Kojo2TreeSitterModule>,
  loadAssets: () => Promise<Kojo2RuntimeAssets>,
  options: { readonly timeoutMs?: number } = {},
): Promise<Kojo2RuntimeResult> {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const started = nowMs();
  const work = (async (): Promise<Kojo2TreeSitterRuntime> => {
    const module = await loadModule();
    const assets = await loadAssets();
    await module.Parser.init({ locateFile: () => assets.runtimeWasmUrl });
    const language = await module.Language.load(assets.grammarWasm);
    const parser = new module.Parser();
    try {
      parser.setLanguage(language);
    } catch (error) {
      parser.delete();
      throw error;
    }
    // 三份查询**各自**编译、各自记账：坏了一份只少那一面（parse 仍可用），
    // 不让一张 .scm 的语法错把整个结构层打成 unavailable。
    const compiled = {
      highlights: compileQuery(module, language, assets.highlightsQuery),
      folds: compileQuery(module, language, assets.foldsQuery),
      indents: compileQuery(module, language, assets.indentsQuery),
    };
    return buildRuntime({
      Edit: module.Edit,
      parser,
      compiled,
      initMs: Math.max(0, nowMs() - started),
    });
  })();

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guarded = work.then(
    (runtime): Kojo2RuntimeResult => {
      if (timedOut) {
        runtime.dispose();
        return failure('timeout', `结构解析运行时装载超过 ${timeoutMs} ms ⇒ 调用方降级`);
      }
      return { ok: true, runtime };
    },
    (error): Kojo2RuntimeResult =>
      failure('unavailable', `结构解析运行时装载失败：${describeError(error)} ⇒ 调用方降级`),
  );
  const deadline = new Promise<Kojo2RuntimeResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(failure('timeout', `结构解析运行时装载超过 ${timeoutMs} ms ⇒ 调用方降级`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([guarded, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/* ------------------------------- 运行时本体 ------------------------------- */

interface BuildRuntimeInput {
  readonly Edit: Kojo2TreeSitterModule['Edit'];
  readonly parser: WebTreeSitter.Parser;
  readonly compiled: Readonly<Record<Kojo2QueryKind, CompiledQuery>>;
  readonly initMs: number;
}

const QUERY_LABEL: Readonly<Record<Kojo2QueryKind, string>> = {
  highlights: 'highlights',
  folds: 'folds',
  indents: 'indents',
};

function buildRuntime(input: BuildRuntimeInput): Kojo2TreeSitterRuntime {
  const { Edit, parser, initMs } = input;
  const compiled: Record<Kojo2QueryKind, CompiledQuery> = {
    highlights: input.compiled.highlights,
    folds: input.compiled.folds,
    indents: input.compiled.indents,
  };
  const oldTexts = new WeakMap<WebTreeSitter.Tree, string>();
  let disposed = false;

  /** 整篇重解（首解 / 旧树不认识 / 增量失败后的重对齐） */
  const parseFull = (text: string): Kojo2ParseResult => {
    let next: WebTreeSitter.Tree | null;
    try {
      next = parser.parse(reader(text), null);
    } catch (error) {
      return failure('parse-failed', `整篇解析抛错：${describeError(error)} ⇒ 调用方降级`);
    }
    if (next === null) {
      return failure('parse-failed', '解析器没有产出语法树（语言未装配成功）⇒ 调用方降级');
    }
    oldTexts.set(next, text);
    return {
      ok: true,
      tree: next,
      rootNode: next.rootNode,
      incremental: false,
      changedRanges: [],
      textLength: text.length,
    };
  };

  const parse = (text: string, oldTree: WebTreeSitter.Tree | null = null): Kojo2ParseResult => {
    if (disposed) return failure('disposed', '结构解析运行时已释放 ⇒ 调用方降级到词法层');
    if (typeof text !== 'string') {
      return failure('invalid-input', `parse 只接受字符串（收到 ${describeType(text)}）`);
    }
    const oldText = oldTree === null || typeof oldTree !== 'object' ? undefined : oldTexts.get(oldTree);
    if (oldTree === null || oldText === undefined) return parseFull(text);

    const edit = commonEdit(oldText, text);
    const reparse = reparseStart(oldTree.rootNode, oldText, edit);
    const applied: Kojo2EditRange = {
      startIndex: reparse.index,
      oldEndIndex: edit.oldEnd.offset,
      newEndIndex: edit.newEnd.offset,
      startPosition: { row: reparse.row, column: reparse.column },
      oldEndPosition: { row: edit.oldEnd.row, column: edit.oldEnd.column },
      newEndPosition: { row: edit.newEnd.row, column: edit.newEnd.column },
    };
    try {
      oldTree.edit(
        new Edit({
          startIndex: applied.startIndex,
          oldEndIndex: applied.oldEndIndex,
          newEndIndex: applied.newEndIndex,
          startPosition: applied.startPosition,
          oldEndPosition: applied.oldEndPosition,
          newEndPosition: applied.newEndPosition,
        }),
      );
    } catch {
      // 旧树已被别处改坏 / 删掉：不再把它当旧树，整篇重解（增量只是优化）
      oldTexts.delete(oldTree);
      return parseFull(text);
    }

    let next: WebTreeSitter.Tree | null;
    try {
      next = parser.parse(reader(text), oldTree);
    } catch {
      oldTexts.delete(oldTree);
      return parseFull(text);
    }
    if (next === null) {
      oldTexts.delete(oldTree);
      return failure('parse-failed', '增量解析没有产出语法树（旧树已丢弃）⇒ 调用方降级');
    }
    // 旧树已经被 `tree.edit` 改写过，它不再是"上一次 parse 的结果"：同一棵树不许再当
    // 下一次增量的基准（否则会拿旧文本做差分 ⇒ 静默错位）。删掉记录，再拿它来就是整篇重解。
    oldTexts.delete(oldTree);
    oldTexts.set(next, text);
    return {
      ok: true,
      tree: next,
      rootNode: next.rootNode,
      incremental: true,
      changedRanges: [applied],
      textLength: text.length,
    };
  };

  const queryStatus = (kind: Kojo2QueryKind): Kojo2QueryStatus => {
    if (disposed) return failure('disposed', '结构解析运行时已释放 ⇒ 调用方降级到词法层');
    const entry = compiled[kind];
    if (entry.query !== null) return { ok: true };
    const label = QUERY_LABEL[kind];
    return failure(
      'query-unavailable',
      entry.error === null
        ? `没有提供 ${label} 查询 ⇒ 这一档不走结构层`
        : `${label} 查询编译失败：${entry.error} ⇒ 这一档不走结构层`,
    );
  };

  const queryCaptures = (root: WebTreeSitter.Node, kind: Kojo2QueryKind): Kojo2CaptureResult => {
    const status = queryStatus(kind);
    if (!status.ok) return status;
    const query = compiled[kind].query;
    if (query === null) return failure('query-unavailable', `${QUERY_LABEL[kind]} 查询不可用`);
    if (root === null || typeof root !== 'object' || typeof (root as { walk?: unknown }).walk !== 'function') {
      return failure('invalid-input', `captures 只接受语法树节点（收到 ${describeType(root)}）`);
    }
    let found: WebTreeSitter.QueryCapture[];
    try {
      found = query.captures(root);
    } catch (error) {
      return failure('query-failed', `${QUERY_LABEL[kind]} 查询执行失败：${describeError(error)}`);
    }
    const out: Kojo2Capture[] = [];
    for (const capture of found) {
      const node = capture.node;
      out.push({
        name: capture.name,
        startPosition: { row: node.startPosition.row, column: node.startPosition.column },
        endPosition: { row: node.endPosition.row, column: node.endPosition.column },
      });
    }
    return { ok: true, captures: out };
  };

  /** v1 消费方的既有入口：语义着色只吃 highlights 那一份 */
  const captures = (root: WebTreeSitter.Node): Kojo2CaptureResult => queryCaptures(root, 'highlights');

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const kind of ['highlights', 'folds', 'indents'] as const) {
      const entry = compiled[kind];
      if (entry.query === null) continue;
      try {
        entry.query.delete();
      } catch {
        /* 已删过 / wasm 已卸载：没有可回收的 */
      }
      compiled[kind] = { query: null, error: entry.error };
    }
    try {
      parser.delete();
    } catch {
      /* 同上 */
    }
  };

  return { initMs, parse, captures, queryStatus, queryCaptures, dispose };
}

/* ------------------------------- 增量起点 ------------------------------- */

interface ReparseStart {
  readonly index: number;
  readonly row: number;
  readonly column: number;
}

/**
 * 报给 `tree.edit` 的编辑起点：真实起点，或在"编辑落在顶层边界上"时**往前推**到最近一枚
 * 还可能被这次改动接长的顶层节点。口径与 `engine.ts::reparseStart` 同源（那边有实测：
 * 不推时增量会漂成"块头不吞正文"的形状；这里不重复贴读数，只沿用结论）。
 */
function reparseStart(root: WebTreeSitter.Node, text: string, edit: StructureEdit): ReparseStart {
  const exact: ReparseStart = { index: edit.start.offset, row: edit.start.row, column: edit.start.column };
  if (edit.start.offset <= 0) return exact;
  const node = topLevelAncestor(root, edit.start.offset - 1);
  // 编辑落在顶层节点内部（或定位落空）⇒ 不推：那一枚节点自己会被重解
  if (node === null || node.endIndex > edit.start.offset) return exact;
  let current = node;
  for (;;) {
    if (!isBlankRange(text, current.startIndex, current.endIndex)) break;
    const previous = current.previousSibling;
    if (previous === null) break; // 一路到文首都是空白
    current = previous;
  }
  return { index: current.startIndex, row: current.startPosition.row, column: current.startPosition.column };
}

/** 包含这个码元偏移的**根的孩子**（上溯到只剩一层）；偏移落在根的空白里 ⇒ null */
function topLevelAncestor(root: WebTreeSitter.Node, index: number): WebTreeSitter.Node | null {
  const node = root.descendantForIndex(index);
  if (node === null) return null;
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (parent === null) return null; // 这一枚就是根 ⇒ 改动落在根自己的范围里
    if (parent.parent === null) return current; // 父就是根 ⇒ 这一枚是顶层孩子
    current = parent;
  }
}

function isBlankChar(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\u3000' || ch === '\f' || ch === '\r';
}

/** `[from, to)` 是否全空白（换行算空白：本语法每条换行都由 `blank_line` 单独认领） */
function isBlankRange(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const ch = text[i]!;
    if (ch === '\n') continue;
    if (!isBlankChar(ch)) return false;
  }
  return true;
}

/** 有界取字符回调：每次只给一段，不让 wasm 把文档尾巴整段复制走 */
function reader(text: string): (index: number) => string {
  return (index: number): string => text.slice(index, index + READ_CHUNK);
}
