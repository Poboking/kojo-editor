/**
 * Kojo 2.0 的**结构捕获预取**（B3 语义收口，2026-10-30）：把结构 worker 的 `captures` 提前
 * 算好，缓存成供方**同步**取用的快照。
 *
 * ## 为什么不在 provider 里等
 *
 * 结构化着色的"这段语法是什么角色"只有结构 worker 算得出（`queries/v2/highlights.scm`），
 * 而 `ui.editor.languageService` 槽的 `provide(request)` **是同步的**——worker 的事实塞不进去。
 * 本批起着色改走共享收口（`kojo-semantic-tokens.ts` 那一枚 provider，kojo2 由 descriptor 的
 * `slotServices: ['semanticToken']` 点名），供方是插件 `kojo2-semanticTokens`；本文件只做三件事
 * （与 B3h 折叠 `kojo2-folding.ts` 逐条同形）：
 *
 * 1. **预取**：model 打开 / 内容变更（防抖）时问一次 worker，整篇只问一次；
 * 2. **缓存**：键 = model 身份 + **版本号**（同版本重复问直接命中；版本变了才把上一版
 *    `treeId` 交回 worker 增量重解）。`WeakMap` 键，模型释放后自然可回收；
 * 3. **交快照**：请求构造时（{@link kojo2SemanticCapturesFor}）把**这一版**的捕获快照递进
 *    `EditorSemanticTokenRequest.captures`，供方负责翻译与裁剪。
 *
 * 快照里的坐标是**契约坐标**（1 基；0→1 换算由 `@kojo/kojo-lang/semantic` 的
 * `kojo2ContractCaptures` 一处完成），名字仍是**捕获名录**（翻译归供方）。
 *
 * ## 缓存未命中 ⇒ 空结果，绝不异步等待
 *
 * 槽内不许 await（供方是纯同步插件），所以 provider 被问而快照还没到 ⇒ 这一轮交空、
 * 并把预取踢进后台；**下一版内容变化 / 下一次预取后可见**（Monaco 在停笔与滚动时都会重问）。
 *
 * ## 失败面：一律空快照，绝不抛
 *
 * worker 不可用 / 超时 / 崩溃 / `highlights.scm` 缺席（`query-unavailable`）⇒ 存**空快照**并
 * `warn` 一次（同一 reason 只刷一条）。着色是只读呈现面：失败不该变成问题面板里的噪音，
 * 也不该让编辑器抛异常。失败若带 `treeId`（查询失败但树已解出）仍留着，下一版继续增量。
 *
 * ## 插件缺席（停用 / 卸载）时宿主怎么降级
 *
 * **宿主不降级成"自己判"**：B3 语义收口之后，"捕获 → 颜色"只剩插件里那一个供方
 * （判据在 `@kojo/kojo-lang/semantic`）。插件缺席 ⇒ 槽里零贡献 ⇒ 共享 provider 交空
 * ⇒ kojo2 只剩 Monarch 词法色（关键字 / 字符串 / 数字照旧，结构角色色消失），编辑器
 * 不抛、不卡。本文件的预取器照常跑——它只产事实快照，**一个 token 都不产**；可见信号
 * 是内核的插件清单（inactive 必须可见），本层不另造第二套告警。
 *
 * ## `@原生` 注入（LAU-6）
 *
 * 子树捕获（`origin: 'injection'`）与主树捕获**同一份快照**：宿主节点账由本文件那一趟写
 * （`rememberInjectionHosts`），子 parse 与折叠面共用同一趟（`runInjectionForModel` 的
 * model+版本缓存）；子树失败只落一条 `core/injection/child-failed`，主树捕获一字不动。
 * "子树在自己覆盖列上优先"由供方按 `origin` 裁（`@kojo/kojo-lang/semantic`）。
 *
 * ## 缩进规则（K2-INDENT-WIRE）
 *
 * 捕获成功 = worker 可用 ⇒ 顺手把 `indents` 查询的规则写进语言配置（同一枚客户端、
 * 同一棵树；`installKojo2IndentConfigFromWorker` 的句柄由 {@link installKojo2SemanticCaptures}
 * 持有）。安装器不再注册任何 Monaco provider。
 */
import type * as Monaco from './entry';
import type { EditorSemanticCapture } from '@kojo/plugin-api';
import { kojo2ContractCaptures } from '@kojo/kojo-lang/semantic';
import { KOJO2_INJECTIONS, KOJO2_LANGUAGE_ID } from './kojo2-language';
import { reportStructureDegradation } from './tree-sitter/fallback';
import {
  installKojo2IndentConfigFromWorker,
  type Kojo2IndentConfigHandle,
  type Kojo2IndentRulesSource,
} from './kojo2-indent';
import type { Kojo2Capture } from './tree-sitter/kojo2-tokenizer';
import type {
  Kojo2CapturesReply,
  Kojo2WorkerResult,
} from './tree-sitter/kojo2-worker-protocol';
import type { InjectionSpec } from './tree-sitter/structure-runtime';
import type { InjectionHost, InjectionOutcome, InjectionRunRequest } from './tree-sitter/injection';
import type { KojoStructureToken } from './tree-sitter/types';

/** 空快照（"这一版没有结构色"；不 new 数组，消费方只读） */
const EMPTY_CAPTURES: readonly EditorSemanticCapture[] = Object.freeze([]);

/**
 * 本文件对 worker 客户端的最小依赖面（结构类型：真 `Kojo2WorkerClient` 与测试替身都满足）。
 * 只要一个 `captures`：树怎么解、查询怎么跑，全在 worker 里。
 */
export interface Kojo2SemanticWorkerClient {
  captures(text: string, version: number, oldTreeId?: string): Promise<Kojo2WorkerResult<Kojo2CapturesReply>>;
}

/** 一次性告警表（同一 reason 只刷一条；与 `kojo2-folding.ts` 同纪律） */
const warned = new Set<string>();

function warnOnce(warn: (message: string) => void, key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  warn(message);
}

/** 依赖注入缝（测试用；生产全部走缺省） */
export interface Kojo2SemanticCapturesDeps {
  /**
   * 取 worker 客户端（缺省 = 动态 import `kojo2-worker-runtime` 的单例）。
   * 动态 import 让**主线程静态图里连薄客户端都不出现**：没人要结构层时，
   * `?worker` 入口与协议模块一个字节都不装载。
   */
  readonly getClient?: () => Kojo2SemanticWorkerClient | Promise<Kojo2SemanticWorkerClient>;
  /** 告警出口（缺省 `console.warn`；测试可收账） */
  readonly warn?: (message: string) => void;
  /** `@原生` 注入声明（LAU-6；缺省 `KOJO2_INJECTIONS`）。空数组 = 不合并子树捕获。 */
  readonly injections?: readonly InjectionSpec[];
  /**
   * 子 parse 的执行器（测试注入缝；缺省 = **动态** import `./tree-sitter/injection`）。
   * 动态的理由只有一条：开机静态图有硬上限（`ps10-eager-graph.test.ts`），而注入器只在
   * 真有 `@原生` 时才需要。
   */
  readonly runInjection?: (model: Monaco.editor.ITextModel, request: InjectionRunRequest) => Promise<InjectionOutcome>;
}

/** 缺省客户端：懒到第一次真预取才把 worker 模块拉进来 */
async function defaultWorkerClient(): Promise<Kojo2SemanticWorkerClient> {
  const module = await import('./tree-sitter/kojo2-worker-runtime');
  return module.getKojo2WorkerClient();
}

/** 缺省注入执行器：**动态**取注入模块（静态图上限，理由同上） */
async function defaultRunInjection(
  model: Monaco.editor.ITextModel,
  request: InjectionRunRequest,
): Promise<InjectionOutcome> {
  const module = await import('./tree-sitter/injection');
  module.rememberInjectionHosts(model, request.version, request.hosts);
  return module.runInjectionForModel(model, request);
}

/** 一版快照（缓存条目；`versionId` 对不上 = 陈旧，不许交给请求） */
interface SnapshotEntry {
  readonly versionId: number;
  /** worker 交回的树号（下一版的增量基准；`null` = 上次失败且 worker 没交出可用的树） */
  readonly treeId: string | null;
  readonly captures: readonly EditorSemanticCapture[];
  /** 快照是否覆盖整篇（失败 / 查询缺席 ⇒ `false`；供方只按"缺席 = 空"作答） */
  readonly complete: boolean;
}

/** 预取器：**只做预取与缓存**，不注册、不翻译 Monaco 形状 */
export interface Kojo2SemanticCapturesCache {
  /**
   * 同步取**这一版**的快照；陈旧 / 未命中 ⇒ `undefined`，顺带把预取踢进后台（不等待）。
   *
   * 非 kojo2 模型在这里早退（`prefetch` 的语言门）——共享 provider 对 ERB / kojo1 也会问，
   * 不能因为"被问了一次"就让 kojo2 的 worker 去解一份 ERB。
   */
  snapshotFor(model: Monaco.editor.ITextModel): {
    readonly captures: readonly EditorSemanticCapture[];
    readonly complete: boolean;
  } | undefined;
  /** 显式预取（模型事件 / 测试用）。同版本同一份在飞时复用同一个 promise，不重发请求。 */
  prefetch(model: Monaco.editor.ITextModel): Promise<void>;
  /** 丢掉一份 model 的缓存（model 释放时调；幂等） */
  forget(model: Monaco.editor.ITextModel): void;
  /** 幂等：丢弃全部缓存，之后的 `prefetch` 变空操作（在飞的那次结果也不再落账） */
  dispose(): void;
}

/* ============================== 注入宿主节点 ============================== */

function isInjectionPoint(point: { readonly row: number; readonly column: number }): boolean {
  return (
    Number.isInteger(point.row) &&
    Number.isInteger(point.column) &&
    point.row >= 0 &&
    point.column >= 0
  );
}

/**
 * 从主树捕获里挑出**注入宿主节点**（纯函数；descriptor 的 `injections` 是数据，这里是唯一消费者）。
 *
 * 只认精确节点名：`nodeType` 缺失 / 空串 / 不在表里 ⇒ 跳过（旧回复或测试替身不带节点类型时
 * 宁可不注入，也不按捕获名猜）。同一节点被多条捕获命中只算一次（键 = 语言 + 类型 + 四点）。
 * 宿主不出现任何具体节点名——它只住在 `kojo2-language.ts` 的声明里。
 */
export function injectionHostNodes(
  specs: readonly InjectionSpec[],
  captures: readonly Kojo2Capture[] | null | undefined,
): InjectionHost[] {
  if (specs.length === 0 || !Array.isArray(captures) || captures.length === 0) return [];
  const byNode = new Map<string, InjectionSpec>();
  for (const spec of specs) byNode.set(spec.hostNode, spec);
  const out: InjectionHost[] = [];
  const seen = new Set<string>();
  for (const capture of captures) {
    const nodeType = capture.nodeType ?? '';
    const spec = byNode.get(nodeType);
    if (spec === undefined) continue;
    const start = capture.startPosition;
    const end = capture.endPosition;
    if (!isInjectionPoint(start) || !isInjectionPoint(end)) continue;
    const key = `${spec.languageId}\u0000${nodeType}\u0000${start.row}:${start.column}:${end.row}:${end.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      languageId: spec.languageId,
      hostNode: nodeType,
      startRow: start.row,
      startColumn: start.column,
      endRow: end.row,
      endColumn: end.column,
    });
  }
  return out;
}

/**
 * 子树失败的那一条可见账（LAU-6 DoD 3）：`warn` 一次 + 回落台账里带 **`core/injection/child-failed`**。
 * 两处同时发不是重复：`warn` 是开发面（同一 reason 只刷一条），台账是作者面通知与机器对账的唯一通路。
 */
function reportInjectionFailure(warn: (message: string) => void, reason: string, message: string): void {
  warnOnce(
    warn,
    `injection:${reason}`,
    `[kojo2-semantic] 注入子解析不可用（${reason}）：${message} ⇒ 这一块仍按原文显示，其余照常`,
  );
  reportStructureDegradation({
    capability: 'semantic',
    stage: 'parse',
    message: `@原生 体内的子解析这次没顶上（${reason}）：${message}`,
    code: 'core/injection/child-failed',
  });
}

/** 子语言 token（0 基四点 + 捕获名）→ 契约捕获（1 基；名字仍是子语言的捕获名录） */
function injectedCapturesOf(tokens: readonly KojoStructureToken[]): EditorSemanticCapture[] {
  const raw: Kojo2Capture[] = [];
  for (const token of tokens) {
    raw.push({
      name: token.capture ?? '',
      startPosition: { row: token.startRow, column: token.startCol },
      endPosition: { row: token.endRow, column: token.endCol },
    });
  }
  return kojo2ContractCaptures(raw, 'injection');
}

/* ============================== 预取器 ============================== */

/**
 * 造一个预取器（不注册、不挂监听；驱动见 {@link installKojo2SemanticCaptures}）。
 *
 * 失败面全部收在内部：任何异常都落空快照，调用方永远看不到 throw。
 */
export function createKojo2SemanticCapturesCache(
  deps: Kojo2SemanticCapturesDeps = {},
  indentSync?: (model: Monaco.editor.ITextModel, treeId?: string) => void,
): Kojo2SemanticCapturesCache {
  const getClient = deps.getClient ?? defaultWorkerClient;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const injectionSpecs = deps.injections ?? KOJO2_INJECTIONS;
  const runInjection = deps.runInjection ?? defaultRunInjection;
  /** model → 上一版的树号与快照（`WeakMap`：标签关掉、model 释放后自然可回收） */
  let cache = new WeakMap<Monaco.editor.ITextModel, SnapshotEntry>();
  /** model → 在飞的那一次（同版本复用；版本变了就换人） */
  let inflight = new WeakMap<Monaco.editor.ITextModel, { versionId: number; promise: Promise<void> }>();
  let disposed = false;

  const compute = async (model: Monaco.editor.ITextModel, versionId: number): Promise<void> => {
    const cached = cache.get(model);
    if (model.isDisposed()) {
      cache.delete(model);
      return;
    }
    const text = model.getValue();
    const store = (
      treeId: string | null,
      captures: readonly EditorSemanticCapture[] | null,
      complete: boolean,
    ): void => {
      if (disposed || model.isDisposed()) {
        if (model.isDisposed()) cache.delete(model);
        return;
      }
      cache.set(model, {
        versionId,
        treeId,
        captures: captures ?? EMPTY_CAPTURES,
        complete,
      });
    };

    let client: Kojo2SemanticWorkerClient;
    try {
      client = await getClient();
    } catch (error: unknown) {
      warnOnce(
        warn,
        'client:load',
        `[kojo2-semantic] 结构客户端装载失败（本轮不着色）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      store(null, null, false);
      return;
    }
    if (disposed) return;
    let result: Kojo2WorkerResult<Kojo2CapturesReply>;
    try {
      result = await client.captures(text, versionId, cached?.treeId ?? undefined);
    } catch (error: unknown) {
      // 最后一道兜底：client 自己抛（而不是回 `ok:false`）时也不许穿到模型事件循环里。
      warnOnce(
        warn,
        'client:throw',
        `[kojo2-semantic] 结构客户端抛错（本轮不着色）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      store(null, null, false);
      return;
    }
    if (disposed) return;
    if (!result.ok) {
      warnOnce(
        warn,
        `worker:${result.reason}`,
        `[kojo2-semantic] 结构解析不可用（${result.reason}）：${result.message} ⇒ 本轮不着色`,
      );
      // worker 明确交回了树号（查询失败但树已解出）⇒ 下一版继续增量；否则归零。
      store(result.treeId ?? null, null, false);
      return;
    }

    const mainCaptures = kojo2ContractCaptures(result.value.captures);
    const hostNodes = injectionHostNodes(injectionSpecs, result.value.captures);
    let injected: EditorSemanticCapture[] = [];
    // LAU-6：有宿主节点才解子树（没有 `@原生` 的文件零额外请求，更不碰 ERB wasm）。
    // 失败只落一条 `core/injection/child-failed` 并保留主树捕获——主树四面一行不动。
    if (hostNodes.length > 0) {
      try {
        const outcome = await runInjection(model, {
          text,
          version: versionId,
          specs: injectionSpecs,
          hosts: hostNodes,
        });
        if (disposed) return;
        if (model.isDisposed()) {
          cache.delete(model);
          return;
        }
        if (!outcome.ok) {
          reportInjectionFailure(warn, outcome.reason, outcome.message);
        } else if (outcome.tokens.length > 0) {
          injected = injectedCapturesOf(outcome.tokens);
        }
      } catch (error: unknown) {
        // 注入器自己抛错 = 与"子树失败"同一结局：不拖垮主树，只记一条可见的码
        reportInjectionFailure(
          warn,
          'internal',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    store(result.value.treeId, [...mainCaptures, ...injected], true);
    // K2-INDENT-WIRE：捕获成功 = worker 可用 ⇒ 顺手问一次 `indents` 并把规则写进语言配置。
    // 交回 `treeId`：同一棵树上再跑一次查询，worker 不必为这条请求重解（文本逐字相同）。
    try {
      indentSync?.(model, result.value.treeId);
    } catch {
      /* 缩进配置是增强层：挂点自己炸了不该影响着色 */
    }
  };

  const prefetch = (model: Monaco.editor.ITextModel): Promise<void> => {
    if (disposed || model.isDisposed()) return Promise.resolve();
    // 只认 2.0：共享 provider 对 ERB / kojo1 也会问，别让 kojo2 的 worker 去解别人的文本。
    if (model.getLanguageId() !== KOJO2_LANGUAGE_ID) return Promise.resolve();
    const versionId = model.getVersionId();
    const hit = cache.get(model);
    if (hit !== undefined && hit.versionId === versionId) return Promise.resolve();
    const running = inflight.get(model);
    if (running !== undefined && running.versionId === versionId) return running.promise;
    const promise = compute(model, versionId)
      .catch((error: unknown) => {
        // `compute` 内部已逐段降级；走到这里说明是缓存层的意外（取文 / 取行数）。
        warnOnce(
          warn,
          `internal:${error instanceof Error ? error.message : String(error)}`,
          `[kojo2-semantic] 预取内部异常（本轮不着色，编辑器不受影响）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        const current = inflight.get(model);
        if (current !== undefined && current.promise === promise) inflight.delete(model);
      });
    inflight.set(model, { versionId, promise });
    return promise;
  };

  return {
    snapshotFor(model) {
      if (disposed || model.isDisposed()) return undefined;
      const hit = cache.get(model);
      if (hit !== undefined && hit.versionId === model.getVersionId()) {
        return { captures: hit.captures, complete: hit.complete };
      }
      // 未命中 / 陈旧：这一轮答空，预取踢进后台（下一次被问、下一版内容变化后可见）。
      void prefetch(model);
      return undefined;
    },
    prefetch,
    forget(model) {
      cache.delete(model);
      inflight.delete(model);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cache = new WeakMap();
      inflight = new WeakMap();
    },
  };
}

/* ============================== 装配：全局那一枚 ============================== */

/**
 * 当前生效的预取器（组合根挂一枚；`null` = 没装，着色腿照旧走"没有快照 ⇒ 空"）。
 *
 * 为什么是模块单例而不是参数一路传：请求构造点在 `ui/editor-global-providers.ts` 的
 * `readSemanticTokenSpans`（共享收口那一枚 provider 的回调），它拿不到组合根的局部变量。
 */
let activeCache: Kojo2SemanticCapturesCache | null = null;

/**
 * 装一枚全局预取器（装配点调一次；返回的句柄把账收干净）。
 *
 * **本函数不注册任何 provider**：着色的注册在 `kojo-semantic-tokens.ts` 的共享收口
 * （按 descriptor 铺语言，kojo2 由 `slotServices: ['semanticToken']` 点名）。模型事件的驱动在
 * 装配点那一段 2.0 模型监听里（与项目索引 / 折叠同一处）。
 *
 * 它同时持有 **K2-INDENT-WIRE** 的句柄：捕获成功 = worker 可用 ⇒ 顺手把缩进规则写进语言配置
 * （与旧 `installKojo2SemanticTokensProvider` 同一挂点，只是不再顺带注册 provider）。
 */
export function installKojo2SemanticCaptures(
  monaco: typeof Monaco,
  deps: Kojo2SemanticCapturesDeps = {},
): Monaco.IDisposable {
  const semanticGetClient = deps.getClient;
  const indentConfig: Kojo2IndentConfigHandle = installKojo2IndentConfigFromWorker(monaco, {
    ...(semanticGetClient === undefined
      ? {}
      : { getClient: async (): Promise<Kojo2IndentRulesSource> => (await semanticGetClient()) as Kojo2IndentRulesSource }),
    ...(deps.warn === undefined ? {} : { warn: deps.warn }),
  });
  const cache = createKojo2SemanticCapturesCache(deps, (model, treeId) => {
    void indentConfig.request(model, treeId);
  });
  const previous = activeCache;
  activeCache = cache;
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (activeCache === cache) activeCache = previous;
      try {
        cache.dispose();
      } finally {
        indentConfig.dispose();
      }
    },
  };
}

/**
 * **预取口**（模型事件驱动用）：打开 / 改动后踢一次，不等待、不抛。
 *
 * 只认 2.0 model（判定在 `prefetch` 里，装配点不需要第二份名单）。
 */
export function prefetchKojo2SemanticCaptures(model: Monaco.editor.ITextModel): void {
  const cache = activeCache;
  if (cache === null) return;
  void cache.prefetch(model);
}

/**
 * **请求构造点**用的取快照口：这一版有快照就给，否则 `undefined`（并踢一次预取）。
 *
 * 没装预取器（测试 / 旧装配）⇒ `undefined`：着色腿答空，一切照旧。
 */
export function kojo2SemanticCapturesFor(
  model: Monaco.editor.ITextModel,
): { readonly captures: readonly EditorSemanticCapture[]; readonly complete: boolean } | undefined {
  const cache = activeCache;
  if (cache === null) return undefined;
  return cache.snapshotFor(model);
}