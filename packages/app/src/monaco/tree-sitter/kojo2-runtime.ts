/**
 * Kojo 2.0 的 tree-sitter **wasm 运行时**（懒加载单例 + 可判别的失败面）。
 *
 * ## 为什么是单例，且只在这一层碰 wasm
 *
 * `web-tree-sitter` 的 `Parser.init()` 是**进程级**的（wasm 模块装一次，后续 `init` 直接返回
 * 同一个模块，连 `locateFile` 都只认第一次），所以运行时天然只能有一份。做成单例之后：
 * 并发调用共享同一条 `Promise`（第二个调用方 `===` 第一个，不会各fetch一遍 47KB wasm），
 * `dispose()` 之后下一次调用才重新装载。`kojo2-language.ts` / Monarch 那一路完全不知道这里。
 *
 * ## 装载策略
 *
 * 1. `kojo2-assets.ts` 里是 Vite 的 `?url`（两枚 wasm）与 `?raw`（highlights 查询）。
 *    **只有本模块的默认装载器动态 `import()` 它**——flag 关着 / 没人要结构层时，
 *    这些资源连字符串都不进主线程模块图（与 v1 `kojo-runtime.ts` 同一条纪律）。
 * 2. 两枚 wasm 各是谁的：`runtimeWasmUrl` = `web-tree-sitter` 自己的运行时
 *    （0.27 包内实名 `web-tree-sitter.wasm`，`Parser.init({locateFile})` 找它）；
 *    `grammarWasm` = `@kojo/kojo-syntax-tree` 包根的 `tree-sitter-kojo2.wasm`（47,116 B）。
 * 3. Node 侧（测试 / 无 Vite）：把**文件路径**当 `runtimeWasmUrl` 传进来即可——
 *    Emscripten 在 Node 下走 `fs.readFileSync`；语法 wasm 直接喂 `Uint8Array` 或路径，
 *    `Language.load` 在 Node 下同样走 `fs`，**不联网**。
 *
 * ## 失败面：一切都回 `{ ok: false, reason }`，不抛
 *
 * | reason | 什么时候 |
 * |---|---|
 * | `timeout` | 整个装载（模块 import + 资源 + `Parser.init` + `Language.load` + 查询编译）超过 `timeoutMs`（默认 5s） |
 * | `unavailable` | 模块 import / 资源解析 / `Parser.init` / `Language.load` / `new Parser` 任一步失败（含 wasm 文件缺失） |
 * | `invalid-input` | `parse` 收到非字符串；`captures` 收到不像节点的对象 |
 * | `disposed` | 运行时已 `dispose()`，调用方应降级到词法层/只读 |
 * | `parse-failed` | 解析器抛错或返回 `null`（wasm 状态可疑，调用方降级） |
 * | `query-unavailable` | 没给 highlights 查询，或查询编译失败（**parse 仍可用**，只少着色面） |
 * | `query-failed` | 查询执行抛错（树/查询生命周期错位） |
 *
 * 超时那条尤其要"按时返回"：装载失败的承诺可能永远不 settle（网络挂起），
 * 所以超时之后迟到的运行时会在 `then` 里被 `dispose()` 掉，绝不泄漏一个没人管的 parser。
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

/** 运行时需要的资源：两枚 wasm + 一份 highlights 查询（查询可选 = 没有着色面） */
export interface Kojo2RuntimeAssets {
  readonly runtimeWasmUrl: string;
  readonly grammarWasm: string | Uint8Array;
  readonly highlightsQuery?: string;
}

/**
 * 依赖注入缝（测试用；生产走默认装载器）。
 * `loadAssets` 覆盖资源来源、`loadModule` 覆盖 `web-tree-sitter` 模块本身。
 */
export interface Kojo2RuntimeDeps {
  readonly loadModule?: () => Promise<Kojo2TreeSitterModule>;
  readonly loadAssets?: () => Promise<Kojo2RuntimeAssets>;
  /** 装载总超时（毫秒），缺省 {@link KOJO2_RUNTIME_TIMEOUT_MS} */
  readonly timeoutMs?: number;
}

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

/** 一门 2.0 文档可用的运行时；`parse` / `captures` 永不抛未捕获异常 */
export interface Kojo2TreeSitterRuntime {
  /** 从第一次 get 到 ready 的墙钟毫秒（读数用，不含调用方排队） */
  readonly initMs: number;
  parse(text: string, oldTree?: WebTreeSitter.Tree | null): Kojo2ParseResult;
  captures(root: WebTreeSitter.Node): Kojo2CaptureResult;
  /** 幂等；释放 parser 与查询。调用方手里的树不归这里管 */
  dispose(): void;
}

export type Kojo2RuntimeResult =
  | { readonly ok: true; readonly runtime: Kojo2TreeSitterRuntime }
  | Kojo2RuntimeFailure;

let pendingRuntime: Promise<Kojo2RuntimeResult> | null = null;

/**
 * 取（必要时装载）**唯一**的 2.0 tree-sitter 运行时。
 *
 * - 并发调用共享同一条 Promise（普通函数而非 `async`：`===` 成立，异步函数会另包一层）；
 * - 成功与失败都会被记住：失败之后编辑器按 `reason` 降级，需要重试时先
 *   `disposeKojo2TreeSitterRuntime()`（例如作者手动打开结构层）；
 * - `deps` 只在**第一次**调用（真正创建）时生效，后续调用忽略，避免单例被不同资源半路改写。
 */
export function getKojo2TreeSitterRuntime(deps: Kojo2RuntimeDeps = {}): Promise<Kojo2RuntimeResult> {
  if (pendingRuntime !== null) return pendingRuntime;
  pendingRuntime = createRuntime(deps);
  return pendingRuntime;
}

/**
 * 丢掉当前单例（无论已就绪、失败还是在途）。返回的 Promise 在**已就绪**的运行时
 * 真正 `dispose()` 之后 resolve；在途的那条会在迟到后自己 dispose（不会重新装回来）。
 */
export function disposeKojo2TreeSitterRuntime(): Promise<void> {
  const current = pendingRuntime;
  pendingRuntime = null;
  if (current === null) return Promise.resolve();
  return current.then(
    (result) => {
      if (result.ok) result.runtime.dispose();
    },
    () => {
      /* 失败结果没有资源可放 */
    },
  );
}

/* ------------------------------- 装载 ------------------------------- */

async function loadWebTreeSitter(): Promise<Kojo2TreeSitterModule> {
  return import('web-tree-sitter');
}

async function loadV2Assets(): Promise<Kojo2RuntimeAssets> {
  const assets = await import('./kojo2-assets');
  return assets.KOJO2_TREE_SITTER_ASSETS;
}

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

async function createRuntime(deps: Kojo2RuntimeDeps): Promise<Kojo2RuntimeResult> {
  const timeoutMs = normalizeTimeout(deps.timeoutMs);
  const started = nowMs();
  const work = (async (): Promise<Kojo2TreeSitterRuntime> => {
    const module = await (deps.loadModule ?? loadWebTreeSitter)();
    const assets = await (deps.loadAssets ?? loadV2Assets)();
    await module.Parser.init({ locateFile: () => assets.runtimeWasmUrl });
    const language = await module.Language.load(assets.grammarWasm);
    const parser = new module.Parser();
    try {
      parser.setLanguage(language);
    } catch (error) {
      parser.delete();
      throw error;
    }
    let query: WebTreeSitter.Query | null = null;
    let queryError: string | null = null;
    if (assets.highlightsQuery !== undefined) {
      try {
        query = new module.Query(language, assets.highlightsQuery);
      } catch (error) {
        // 查询坏了只少着色面，parse 仍应可用（不把整档打成不可用）
        queryError = describeError(error);
      }
    }
    return buildRuntime({
      Edit: module.Edit,
      parser,
      query,
      queryError,
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
  readonly query: WebTreeSitter.Query | null;
  readonly queryError: string | null;
  readonly initMs: number;
}

function buildRuntime(input: BuildRuntimeInput): Kojo2TreeSitterRuntime {
  const { Edit, parser, initMs } = input;
  let highlightsQuery = input.query;
  const queryError = input.queryError;
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

  const captures = (root: WebTreeSitter.Node): Kojo2CaptureResult => {
    if (disposed) return failure('disposed', '结构解析运行时已释放 ⇒ 调用方降级到词法层');
    if (highlightsQuery === null) {
      return failure(
        'query-unavailable',
        queryError === null
          ? '没有提供 highlights 查询 ⇒ 这一档不走结构着色'
          : `highlights 查询编译失败：${queryError} ⇒ 这一档不走结构着色`,
      );
    }
    if (root === null || typeof root !== 'object' || typeof (root as { walk?: unknown }).walk !== 'function') {
      return failure('invalid-input', `captures 只接受语法树节点（收到 ${describeType(root)}）`);
    }
    let found: WebTreeSitter.QueryCapture[];
    try {
      found = highlightsQuery.captures(root);
    } catch (error) {
      return failure('query-failed', `highlights 查询执行失败：${describeError(error)}`);
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

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (highlightsQuery !== null) {
      try {
        highlightsQuery.delete();
      } catch {
        /* 已删过 / wasm 已卸载：没有可回收的 */
      }
      highlightsQuery = null;
    }
    try {
      parser.delete();
    } catch {
      /* 同上 */
    }
  };

  return { initMs, parse, captures, dispose };
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
