/**
 * Kojo 2.0 结构解析 worker 的**线上协议**（worker 侧 `kojo2-worker.ts` 与主线程侧
 * `kojo2-worker-runtime.ts` 共用这一份，杜绝第二套字段名）。
 *
 * ## 一条请求 = 一枚 `id`，一条回复 = 同一枚 `id`
 *
 * 与 v1 `types.ts` 的"按 type 分消息 + doc 号隔离"不同，2.0 的协议是**请求-响应配对**：
 * 主线程每发一条带全局单调 `id`，worker 回的每一条都原样带回。超时（默认 2s）后主线程
 * 把该 `id` 从待办表里删掉，**此后迟到的同号回复直接丢**——迟到结果不许改已定的答案。
 *
 * `type` 只有四种：`parse`（首解 / 增量重解）、`captures`（highlights）、`folds`、`indents`。
 * 后三种都带 `text`：worker 侧的树缓存以 `oldTreeId` 为准——
 * - 给了**已缓存**且文本逐字相同的树 ⇒ 直接跑查询（`reparsed: false`）；
 * - 给了已缓存的树但文本变了 ⇒ 先按增量重解（`incremental: true`），再查（`reparsed: true`）；
 * - 树不认识 / 没给 ⇒ 整篇重解一棵（`incremental: false`, `reparsed: true`）。
 *
 * 查询请求的口径（命名沿用任务书）：`oldTreeId` = "要查的那棵已解树"。`parse` 里它同样是
 * "增量基准"，两种语义由 `type` 决定，不是同一棵树的两种叫法。
 *
 * ## 失败一律是数据，不是异常
 *
 * worker 任何一步出错都回 `{ ok: false, reason, message }`（`treeId?` 可选：查询失败但树
 * 已经解出来了，要把它交回主线程，下一版才能继续增量）。主线程因为本进程建不出 worker /
 * worker 崩了 / 超时 / 已 dispose 时，同样回 `{ ok: false, reason }`，调用方按 reason 降级。
 *
 * 坐标口径：行号 **0 基**（tree-sitter 原生），与 v1 `KojoStructureFold` 一致；列号只在
 * capture 里出现（也是 0 基）。主线程的 Monaco 1 基转换只发生在 `kojo2-tokenizer.ts`。
 */
import type { STRUCTURE_BOOTSTRAP_TIMEOUT_MS as CORE_BOOTSTRAP, STRUCTURE_TIMEOUT_MS as CORE_TIMEOUT } from '@kojo/kojo-core';
import type { Kojo2Capture } from './kojo2-tokenizer';
import type { Kojo2EditRange } from './kojo2-runtime-core';

/**
 * 稳态单请求超时（**LAU-1 起与 v1 同一档**）：§4.1 把两套超时并成一档，取 4s 而不是
 * kojo2 原来的 2s——稳态的代价函数不对称（多等两秒只让作者晚看到颜色，错判一次却让这一面
 * 消失到换文档为止）。常量本身留在 `structure-protocol.ts`，这里只是本族的老名字。
 */
export const KOJO2_WORKER_TIMEOUT_MS: typeof CORE_TIMEOUT = 4_000;

/**
 * 引导期超时（worker 还没回过任何一条时）：首条请求要等 worker 里 `Parser.init` +
 * `Language.load` + 查询编译。真机 ~0.2s，CI 4 核冷启动可能 1s+，2s 不够安全；
 * 引导完成后立即回到 {@link KOJO2_WORKER_TIMEOUT_MS}。LAU-1 起这一格直接取共享常量。
 */
export const KOJO2_WORKER_BOOTSTRAP_TIMEOUT_MS: typeof CORE_BOOTSTRAP = 8_000;

export type Kojo2WorkerRequestType = 'parse' | 'captures' | 'folds' | 'indents';

export type Kojo2WorkerFailureReason =
  | 'unavailable'
  | 'timeout'
  | 'disposed'
  | 'invalid-input'
  | 'parse-failed'
  | 'query-unavailable'
  | 'query-failed'
  | 'protocol-error'
  | 'crashed';

export interface Kojo2WorkerRequestBase {
  /** 全局单调请求号（主线程分配，worker 原样回显） */
  readonly id: number;
  /** 主线程的文档版本号（原样回显；主线程只用来对账，不解释语义） */
  readonly version: number;
  /** 要解析 / 查询的全文（整篇交出去；增量在 worker 侧按旧树做） */
  readonly text: string;
}

export interface Kojo2WorkerParseRequest extends Kojo2WorkerRequestBase {
  readonly type: 'parse';
  /** 上一次 `parse` 回复交出的树（增量基准）；缺省 / 不认识 ⇒ 整篇重解 */
  readonly oldTreeId?: string;
}

export interface Kojo2WorkerQueryRequest extends Kojo2WorkerRequestBase {
  readonly type: 'captures' | 'folds' | 'indents';
  /** 已经 `parse` 过的那棵树；缺省 / 不认识 ⇒ 按 `text` 解一棵再查 */
  readonly oldTreeId?: string;
}

export type Kojo2WorkerRequest = Kojo2WorkerParseRequest | Kojo2WorkerQueryRequest;

/** 一枚折叠区间（0 基行；`endRow > startRow` 才算折叠，与 v1 宿主约定一致） */
export interface Kojo2FoldRange {
  readonly startRow: number;
  readonly endRow: number;
  readonly kind?: string;
}

/** 缩进规则（与 v1 `KojoStructureIndentRules` 同形；2.0 本批恒不可用，形状留着是为了协议稳定） */
export interface Kojo2IndentRules {
  readonly increasePatterns: readonly string[];
  readonly decreasePatterns: readonly string[];
  readonly enterPatterns: readonly string[];
}

export interface Kojo2WorkerFailure {
  readonly ok: false;
  readonly id: number;
  readonly type?: Kojo2WorkerRequestType;
  readonly reason: Kojo2WorkerFailureReason;
  readonly message: string;
  /** 查询失败但树已解出：交回给主线程，下一版继续增量（parse 失败没有这一格） */
  readonly treeId?: string;
}

export interface Kojo2ParseReply {
  readonly ok: true;
  readonly id: number;
  readonly type: 'parse';
  readonly version: number;
  readonly treeId: string;
  readonly incremental: boolean;
  readonly changedRanges: readonly Kojo2EditRange[];
  readonly textLength: number;
  /** worker 侧这一次 parse 的墙钟（不含 wasm 装载） */
  readonly parseMs: number;
  /** worker 侧运行时装载的墙钟（`initMs`；引导期读数） */
  readonly loadMs: number;
}

export interface Kojo2CapturesReply {
  readonly ok: true;
  readonly id: number;
  readonly type: 'captures';
  readonly version: number;
  readonly treeId: string;
  readonly captures: readonly Kojo2Capture[];
  readonly incremental: boolean;
  readonly reparsed: boolean;
  readonly queryMs: number;
  readonly loadMs: number;
}

export interface Kojo2FoldsReply {
  readonly ok: true;
  readonly id: number;
  readonly type: 'folds';
  readonly version: number;
  readonly treeId: string;
  readonly folds: readonly Kojo2FoldRange[];
  readonly incremental: boolean;
  readonly reparsed: boolean;
  readonly queryMs: number;
  readonly loadMs: number;
}

export interface Kojo2IndentsReply {
  readonly ok: true;
  readonly id: number;
  readonly type: 'indents';
  readonly version: number;
  readonly treeId: string;
  readonly rules: Kojo2IndentRules;
  readonly incremental: boolean;
  readonly reparsed: boolean;
  readonly queryMs: number;
  readonly loadMs: number;
}

export type Kojo2WorkerReply =
  | Kojo2ParseReply
  | Kojo2CapturesReply
  | Kojo2FoldsReply
  | Kojo2IndentsReply
  | Kojo2WorkerFailure;

/** 主线程侧一条请求的结局（成功回报文本身，失败给可判别 reason；**永不 reject**） */
export type Kojo2WorkerResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: Kojo2WorkerFailureReason;
      readonly message: string;
      /** 见 {@link Kojo2WorkerFailure.treeId} */
      readonly treeId?: string;
    };

/** worker 入口的收件闸：形状不对的就算了（没有可回的 id，回一条 `id:0` 只会制造噪音） */
export function isKojo2WorkerRequest(value: unknown): value is Kojo2WorkerRequest {
  if (value === null || typeof value !== 'object') return false;
  const request = value as Partial<Kojo2WorkerRequest>;
  if (typeof request.id !== 'number' || !Number.isFinite(request.id)) return false;
  if (typeof request.type !== 'string') return false;
  if (!['parse', 'captures', 'folds', 'indents'].includes(request.type)) return false;
  return true;
}

/** 主线程侧的回件闸：`ok` 必须是布尔、`id` 必须是有限数；其余字段由各分支自己看 */
export function isKojo2WorkerReply(value: unknown): value is Kojo2WorkerReply {
  if (value === null || typeof value !== 'object') return false;
  const reply = value as Partial<Kojo2WorkerReply>;
  if (typeof reply.id !== 'number' || !Number.isFinite(reply.id)) return false;
  return typeof reply.ok === 'boolean';
}
