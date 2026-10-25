/**
 * Kojo 2.0 的 **Monaco 语义着色 provider**（K2-TS-WORKER 批：主线程不再直接跑 wasm）。
 *
 * ## 数据链（每一条都只在自己的层里）
 *
 * `getKojo2WorkerClient()`（主线程薄客户端，`?worker` 懒建线程）→
 * `captures(text, version, oldTreeId?)`（worker 内 `parse` + highlights 查询，回纯数据
 * `{ captures, treeId }`）→ `capturesToTokenSpans(..., { lineCount, maxColumn })`
 * （0 基行列 → 1 基 Monaco 区间）→ 本文件的 {@link encodeKojo2SemanticTokens}
 * （5 元组 delta 编码）→ `{ data }`。
 *
 * 本文件**不碰 wasm**、不读查询、不懂 tree-sitter 节点、也不知道旧树长什么样：
 * 它只认 worker 回复里的 `treeId`。上一版把 `treeId` 交回去，worker 就能增量重解；
 * 本文件从不 `delete()` 树（树活在那条线程里，由 worker 的 LRU 收账）。
 *
 * ## legend 与主题：名字逐字对齐，不造第二套色板
 *
 * Monaco 的 standalone 主题服务用 `[tokenType, ...modifiers].join('.')` 去匹配主题规则
 * （`semanticTokensProviderStyling.js` 的 `_hashTable` 取 metadata 那一段）。所以 legend 里
 * 的 **tokenType 必须等于主题规则的 `token`**：本文件的 legend **直接用
 * `kojo2-language.ts` 的 `KOJO2_TOKEN.*` 值**（`kojo2.keyword` / `kojo2.speaker` …），
 * 而不是另起一套 `keyword` / `string`（那会与 v1 的语义类别撞名，还得再补一份映射）。
 * `kojo2-theme.ts` 的 `KOJO2_THEME_RULES` 已经是"档位 = 配色"的单一真源，本文件只引用，
 * 不重定义颜色；缺规则在 `kojo2-theme.ts` 模块加载期就会抛（`buildTokenMap`）。
 *
 * capture 名 → 档位那张表（{@link KOJO2_CAPTURE_TOKEN_TYPES}）是**唯一的翻译层**：
 * - 精确名优先；`@` 前缀容错去掉（`Query.captures()` 实际不带 `@`）；
 * - `none` / 空名 = "这一枚不上色"（tree-sitter 约定，tokenizer 也会再挡一次）；
 * - 未知 capture ⇒ 丢掉并 warn 一次（**不猜**：legend 之外没有颜色；将来查询加档时这里
 *   先告警，而不是静默把一条捕获染色成邻近档）。
 *
 * 取档理由（与 `queries/v2/highlights.scm` 的注释、Monarch 的分档逐档对齐）：
 * - `comment` → 注释；`keyword*` → 保留词族（`keyword.operator` 的 `续` 走运算符档，
 *   与 Monarch 的 `CONTINUATION_TAIL` 同族）；
 * - `label` / `function.call` → 声明档（`#` 后的名字 / `!` 的被调名，与 Monarch 的
 *   `declaration` 同义）；`punctuation.special`（旁白锚点 `>`）→ 锚点档；
 * - `string`（旁白正文 / 台词 / 表值三合一）→ 台词档；`string.special`（插值 + 行尾提示
 *   在查询里**有意合并**，见查询头注）→ 插值档；
 * - `variable`（说话人）→ 说话人档；`number` / `operator` / `embedded`（`@原生` 体）→
 *   各自一档。
 *
 * ## 增量与所有权（worker 侧）
 *
 * 缓存键是 **model 版本号 + worker 交回的 `treeId`**：同一版本重复问直接命中（Monaco 停笔 /
 * 滚动都会重问）；版本变了才把上一版 `treeId` 交给 worker，由它决定"文本没变就复用 /
 * 变了就增量重解 / 不认识就整篇重解"。同一个 provider 的请求仍然**串行**（`serialize` 队列）：
 * worker 只有一条 parser，而语义 provider 的并发只会让"哪一版上屏"变得不可预测。
 *
 * worker 不可用 / 超时 / 解析失败 / 查询缺席 ⇒ **返回空 tokens**（不着色），并 `warn` 一次；
 * 绝不抛进 Monaco、绝不写 markers（着色是只读呈现面，失败不该变成问题面板里的噪音）。
 * 失败那一版同样进缓存（同版本不反复重试），但 `treeId` 只在 worker 明确交回时才留
 * （查询失败但树已解出 ⇒ 下一版继续增量；解析失败 ⇒ 归零，下一版整篇重解）。
 *
 * ## 注册
 *
 * {@link installKojo2SemanticTokensProvider} 只给 `kojo2` 语言 id 注册，**无条件装配**
 * （K2-SURFACE-DEFAULT：着色是只读呈现面）。disposal 幂等：先撤 provider 注册，再丢本
 * provider 的缓存（worker 客户端是共享单例，**不**在这里 dispose）。
 */
import type * as Monaco from './entry';
import { KOJO2_LANGUAGE_ID, KOJO2_TOKEN, type Kojo2TokenName } from './kojo2-language';
import { KOJO2_THEME_TOKEN_MAP } from './kojo2-theme';
import {
  installKojo2IndentConfigFromWorker,
  type Kojo2IndentConfigHandle,
  type Kojo2IndentRulesSource,
} from './kojo2-indent';
import {
  capturesToTokenSpans,
  type Kojo2Capture,
  type Kojo2TokenSpan,
} from './tree-sitter/kojo2-tokenizer';
import type { Kojo2CapturesReply, Kojo2WorkerResult } from './tree-sitter/kojo2-worker-protocol';

/* ============================== capture 名 → 档位 ============================== */

/**
 * tree-sitter capture 名 → `KOJO2_TOKEN` 档位（**唯一翻译层**）。
 *
 * 键是 `queries/v2/highlights.scm` 里出现过的捕获名（不带 `@`）。查询加档而这里没加时
 * provider 会丢掉那一条并 warn 一次——测试用查询文件的捕获集合与这张表对拍，防静默漂移。
 */
export const KOJO2_CAPTURE_TOKEN_TYPES: Readonly<Record<string, Kojo2TokenName>> = Object.freeze({
  comment: KOJO2_TOKEN.comment,
  keyword: KOJO2_TOKEN.keyword,
  'keyword.control': KOJO2_TOKEN.keyword,
  'keyword.function': KOJO2_TOKEN.keyword,
  'keyword.directive': KOJO2_TOKEN.keyword,
  'keyword.operator': KOJO2_TOKEN.operator,
  label: KOJO2_TOKEN.declaration,
  'function.call': KOJO2_TOKEN.declaration,
  'punctuation.special': KOJO2_TOKEN.anchor,
  string: KOJO2_TOKEN.speech,
  'string.special': KOJO2_TOKEN.interp,
  variable: KOJO2_TOKEN.speaker,
  number: KOJO2_TOKEN.number,
  operator: KOJO2_TOKEN.operator,
  embedded: KOJO2_TOKEN.raw,
});

/**
 * legend 的 tokenTypes：capture 表里**实际用到的档位**（声明序 = 首次出现序，稳定可断言）。
 *
 * 不做 `Object.values(KOJO2_TOKEN)` 全量：legend 是"provider 可能发什么"的声明，未映射的档
 * 放进来只是噪音；而"每个值都必须是主题规则"由类型（`Kojo2TokenName`）与下面的模块加载
 * 期自检双重保证。
 */
export const KOJO2_SEMANTIC_TOKEN_TYPES: readonly Kojo2TokenName[] = Object.freeze([
  ...new Set(Object.values(KOJO2_CAPTURE_TOKEN_TYPES)),
]);

/** 每个 legend 档位都必须在 `kojo2-theme.ts` 的派生表里（缺一格是接线错误，加载期就红） */
function assertLegendHasThemeRules(): void {
  for (const token of KOJO2_SEMANTIC_TOKEN_TYPES) {
    if (KOJO2_THEME_TOKEN_MAP[token] === undefined) {
      throw new Error(`[kojo2-semantic] legend 档位「${token}」在 kojo2-theme 里没有主题规则`);
    }
  }
}
assertLegendHasThemeRules();

/** 交给 Monaco 的 legend（`tokenModifiers` 留空：本链只发表情档，不做修饰位） */
export const KOJO2_SEMANTIC_TOKEN_LEGEND: Monaco.languages.SemanticTokensLegend = Object.freeze({
  tokenTypes: [...KOJO2_SEMANTIC_TOKEN_TYPES],
  tokenModifiers: [],
});

/** tokenType → legend 下标（`-1` = 不在 legend，编码时丢掉） */
const TOKEN_TYPE_INDEX: ReadonlyMap<string, number> = new Map(
  KOJO2_SEMANTIC_TOKEN_TYPES.map((token, index) => [token, index]),
);

/* ============================== capture → tokenType ============================== */

/** 一次性告警表（同一 reason / 同一 capture 名只刷一条；与 v1 provider 同纪律） */
const warned = new Set<string>();

function warnOnce(warn: (message: string) => void, key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  warn(message);
}

/** 去掉捕获名可能带的 `@` 前缀（`Query.captures()` 实际不带；这里容错） */
function bareCaptureName(name: string): string {
  return name.startsWith('@') ? name.slice(1) : name;
}

/**
 * capture 名 → 档位；`null` = 这一条不上色（`none` / 空名），`undefined` = legend 之外
 * （调用方负责"丢掉 + 告警一次"）。
 */
function tokenTypeOfCapture(name: string): Kojo2TokenName | null | undefined {
  const bare = bareCaptureName(name);
  if (bare === '' || bare === 'none') return null;
  return KOJO2_CAPTURE_TOKEN_TYPES[bare];
}

/**
 * 把运行时交出的捕获列表翻译成 tokenizer 认识的 `Kojo2Capture[]`（`name` = 档位）。
 *
 * 纯函数、不抛：结构坏掉的条目直接丢（tokenizer 还会再做一次越界/几何判据）。
 * `onUnknown` 只用来做"一次一条"的告警，测试可传空实现。
 */
export function mapKojo2Captures(
  captures: readonly Kojo2Capture[] | null | undefined,
  onUnknown?: (name: string) => void,
): Kojo2Capture[] {
  if (!Array.isArray(captures)) return [];
  const out: Kojo2Capture[] = [];
  for (const capture of captures) {
    if (capture === null || typeof capture !== 'object') continue;
    const name = typeof capture.name === 'string' ? capture.name : '';
    const tokenType = tokenTypeOfCapture(name);
    if (tokenType === null) continue;
    if (tokenType === undefined) {
      onUnknown?.(bareCaptureName(name));
      continue;
    }
    out.push({
      name: tokenType,
      startPosition: capture.startPosition,
      endPosition: capture.endPosition,
    });
  }
  return out;
}

/* ============================== 5 元组编码 ============================== */

/**
 * 区间 → Monaco `SemanticTokens.data`（每 token 五个 `uint32`：
 * `deltaLine` / `deltaStart` / `length` / `tokenType` / `tokenModifiers`）。
 *
 * 编码口径与 Monaco 的 `toMultilineTokens2` 对齐（取证
 * `semanticTokensProviderStyling.js`：`lastLineNumber = 1`、`lastStartCharacter = 0`）：
 * - **绝对分量是 0 基**：首 token 与换行后的 token 写 `line - 1` / `startColumn - 1`
 *   （解码器把 `deltaLine` 加到 `lastLineNumber = 1` 上、把 `deltaCharacter` 当 0 基字符位）；
 * - **同行增量**（`deltaLine === 0` 时）是相对上一 token 起始列的差——两点之差与基数无关，
 *   照旧用 1 基相减；
 * - 必须按 (行, 起始列) 升序（tokenizer 已保证，这里再排一次防御直接调用方）；
 * - 同行重叠保留先到的（Monaco 按到达顺序覆盖；重叠只会让颜色画错而不是消失）；
 * - 零宽区间、legend 之外的类型不进数据。
 *
 * 旧版头注把"首 token 的 `deltaLine` 是 1 基绝对行"当成 Monaco 的口径写死，真机结果是
 * 整篇结构色**下移一行**（2026-10-26 坐标错位批）；自写解码器与编码器同为 1 基，闸一直绿。
 */
export function encodeKojo2SemanticTokens(
  spans: readonly Kojo2TokenSpan[],
  tokenTypes: readonly string[] = KOJO2_SEMANTIC_TOKEN_TYPES,
): Uint32Array {
  const index = tokenTypes === KOJO2_SEMANTIC_TOKEN_TYPES
    ? TOKEN_TYPE_INDEX
    : new Map(tokenTypes.map((token, at) => [token, at]));
  const sorted = [...spans].sort(
    (a, b) =>
      a.line - b.line ||
      a.startColumn - b.startColumn ||
      b.endColumn - a.endColumn ||
      (a.tokenType < b.tokenType ? -1 : a.tokenType > b.tokenType ? 1 : 0),
  );
  const out: number[] = [];
  let previousLine = 0;
  let previousStart = 0;
  let lastEndOnLine = 0;
  for (const span of sorted) {
    if (!Number.isFinite(span.line) || !Number.isFinite(span.startColumn) || !Number.isFinite(span.endColumn)) {
      continue;
    }
    const length = Math.trunc(span.endColumn) - Math.trunc(span.startColumn);
    if (length <= 0) continue;
    const typeIndex = index.get(span.tokenType);
    if (typeIndex === undefined) continue;
    const line = Math.trunc(span.line);
    const startColumn = Math.trunc(span.startColumn);
    if (line === previousLine && startColumn < lastEndOnLine) continue;
    const first = out.length === 0;
    const sameLine = !first && line === previousLine;
    out.push(
      // 绝对分量必须 0 基（见头注）；同行增量与基无关。
      first ? line - 1 : line - previousLine,
      sameLine ? startColumn - previousStart : startColumn - 1,
      length,
      typeIndex,
      0,
    );
    previousLine = line;
    previousStart = startColumn;
    lastEndOnLine = startColumn + length;
  }
  const data = new Uint32Array(out.length);
  for (let i = 0; i < out.length; i++) data[i] = out[i]!;
  return data;
}

/* ============================== provider ============================== */

/**
 * 本 provider 对 worker 客户端的最小依赖面（结构类型：真 `Kojo2WorkerClient` 与测试替身都满足）。
 * 只要一个 `captures`：`parse` 由 worker 在查询请求内部按 `oldTreeId` 决定怎么做。
 */
export interface Kojo2SemanticWorkerClient {
  captures(text: string, version: number, oldTreeId?: string): Promise<Kojo2WorkerResult<Kojo2CapturesReply>>;
}

/** 依赖注入缝（测试用；生产全部走缺省） */
export interface Kojo2SemanticProviderDeps {
  /**
   * 取 worker 客户端（缺省 = 动态 import `kojo2-worker-runtime` 的单例）。
   * 动态 import 让**主线程静态图里连薄客户端都不出现**：没人要结构层时，
   * `?worker` 入口与协议模块一个字节都不装载。
   */
  readonly getClient?: () => Kojo2SemanticWorkerClient | Promise<Kojo2SemanticWorkerClient>;
  /** 告警出口（缺省 `console.warn`；测试可收账） */
  readonly warn?: (message: string) => void;
  /**
   * **结构规则 → 语言配置**的挂点（K2-INDENT-WIRE）：每一轮**捕获成功**之后同步调一次。
   *
   * 为什么挂在这里：Monaco 没有"缩进规则 provider"接口，规则只能写进语言配置；而宿主手里
   * 唯一"每篇都过一遍、且已经证明 worker 可用"的位置就是本 provider 的成功分支（model +
   * 版本号都在手上）。省缺 = 不挂（`createKojo2SemanticTokensProvider` 的直接调用方零改动）；
   * 生产由 {@link installKojo2SemanticTokensProvider} 接到
   * `installKojo2IndentConfigFromWorker` 上。
   */
  readonly syncIndentConfig?: (model: Monaco.editor.ITextModel, treeId?: string) => void;
}

/** 缺省客户端：懒到第一次真着色才把 worker 模块拉进来 */
async function defaultWorkerClient(): Promise<Kojo2SemanticWorkerClient> {
  const module = await import('./tree-sitter/kojo2-worker-runtime');
  return module.getKojo2WorkerClient();
}

/** provider + 它自己的资源账（Monaco 的 provider 接口没有 dispose 位） */
export interface Kojo2SemanticProviderHandle {
  readonly provider: Monaco.languages.DocumentSemanticTokensProvider;
  /** 幂等：丢掉本 provider 的版本缓存（worker 客户端是共享单例，不归这里管） */
  dispose(): void;
}

interface ModelCacheEntry {
  readonly versionId: number;
  /** worker 交回的树号（下一版的增量基准；`null` = 上次失败且 worker 没交出可用的树） */
  readonly treeId: string | null;
  readonly tokens: Uint32Array;
}

const EMPTY_DATA = new Uint32Array(0);

/**
 * 造一个 2.0 语义 token provider（不注册；注册见
 * {@link installKojo2SemanticTokensProvider}）。
 *
 * 失败面全部收在内部：任何异常都回空 tokens，调用方（Monaco）永远看不到 throw。
 */
export function createKojo2SemanticTokensProvider(
  deps: Kojo2SemanticProviderDeps = {},
): Kojo2SemanticProviderHandle {
  const getClient = deps.getClient ?? defaultWorkerClient;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const syncIndentConfig = deps.syncIndentConfig ?? (() => undefined);
  /** model → 上一版的树号与结果（`WeakMap`：标签关掉、model 释放后自然可回收） */
  let cache = new WeakMap<Monaco.editor.ITextModel, ModelCacheEntry>();
  /** worker 只有一条 parser ⇒ 请求串行（并发只会让"哪一版上屏"不可预测） */
  let tail: Promise<void> = Promise.resolve();
  let disposed = false;

  const forget = (model: Monaco.editor.ITextModel): void => {
    cache.delete(model);
  };

  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const compute = async (model: Monaco.editor.ITextModel): Promise<Uint32Array> => {
    if (disposed) return EMPTY_DATA;
    const versionId = model.getVersionId();
    const cached = cache.get(model);
    if (cached?.versionId === versionId) return cached.tokens;
    if (model.isDisposed()) {
      forget(model);
      return EMPTY_DATA;
    }

    const text = model.getValue();
    const client = await getClient();
    if (disposed) return EMPTY_DATA;
    const result = await client.captures(text, versionId, cached?.treeId ?? undefined);
    if (disposed) return EMPTY_DATA;
    if (model.isDisposed()) {
      forget(model);
      return EMPTY_DATA;
    }
    if (!result.ok) {
      warnOnce(
        warn,
        `worker:${result.reason}`,
        `[kojo2-semantic] 结构解析不可用（${result.reason}）：${result.message} ⇒ 本轮不着色`,
      );
      // worker 明确交回了树号（查询失败但树已解出）⇒ 下一版继续增量；否则归零。
      cache.set(model, { versionId, treeId: result.treeId ?? null, tokens: EMPTY_DATA });
      return EMPTY_DATA;
    }
    const spans = capturesToTokenSpans(
      mapKojo2Captures(result.value.captures, (name) =>
        warnOnce(
          warn,
          `capture:${name}`,
          `[kojo2-semantic] capture「@${name}」不在 KOJO2_CAPTURE_TOKEN_TYPES 里 ⇒ 这一条不着色；` +
            '要么给它补档位，要么删掉这条捕获',
        ),
      ),
      {
        lineCount: model.getLineCount(),
        maxColumn: (line) => model.getLineMaxColumn(line),
      },
    );
    const tokens = encodeKojo2SemanticTokens(spans);
    cache.set(model, { versionId, treeId: result.value.treeId, tokens });
    // K2-INDENT-WIRE：捕获成功 = worker 可用 ⇒ 顺手问一次 `indents` 并把规则写进语言配置。
    // 失败面天然是"零改动"（worker 不可用时这条链根本走不到这里），且同步器自己再按
    // "同一 model 同一版本只问一次 / 规则指纹不变不重写"兜一层。交回 `treeId`：同一棵树
    // 上再跑一次查询，worker 不必为这条请求重解（文本逐字相同）。
    try {
      syncIndentConfig(model, result.value.treeId);
    } catch {
      /* 缩进配置是增强层：挂点自己炸了不该影响着色 */
    }
    return tokens;
  };

  const provider: Monaco.languages.DocumentSemanticTokensProvider = {
    getLegend: () => KOJO2_SEMANTIC_TOKEN_LEGEND,
    provideDocumentSemanticTokens(model) {
      if (disposed || model.isDisposed()) return { data: EMPTY_DATA };
      return serialize(() => compute(model)).then(
        (data) => ({ data }),
        (error: unknown) => {
          // 最后一道兜底：compute 内部已逐段降级，走到这里说明是编码/缓存层的意外。
          warnOnce(
            warn,
            `internal:${error instanceof Error ? error.message : String(error)}`,
            `[kojo2-semantic] 着色内部异常（本轮不着色，编辑器不受影响）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return { data: EMPTY_DATA };
        },
      );
    },
    releaseDocumentSemanticTokens: () => undefined,
  };

  return {
    provider,
    dispose() {
      if (disposed) return;
      disposed = true;
      cache = new WeakMap();
    },
  };
}

/**
 * 为 `kojo2` 语言注册语义着色 provider（**无条件**：着色是只读呈现面，与切流阶段无关）。
 *
 * 本安装器同时是 **K2-INDENT-WIRE 的宿主挂点**：它持有
 * `installKojo2IndentConfigFromWorker(...)` 的句柄，并把 `syncIndentConfig` 注入 provider
 * ——于是"结构规则进语言配置"这件事与"结构着色"共用同一个 model / 版本号 / worker 客户端，
 * 不新开挂点、也不在 `editor-global-providers.ts` 里多一行。缩进规则同样是语言面
 * （K2-SURFACE-DEFAULT：改缓冲的回车缩进算语言面），两者一起无条件挂。
 *
 * 返回的 disposable 幂等：撤掉 Monaco 注册 → 丢 provider 的版本缓存 → 撤掉本层写过的语言
 * 配置（worker 客户端是共享单例，留给其它结构层消费方，不在这里 dispose）。
 */
export function installKojo2SemanticTokensProvider(
  monaco: typeof Monaco,
  deps: Kojo2SemanticProviderDeps = {},
): Monaco.IDisposable {
  // 语言配置的账：**只有这一枚**（Monaco 没有缩进 provider 接口，规则只能写进语言配置）
  const semanticGetClient = deps.getClient;
  const indentConfig: Kojo2IndentConfigHandle = installKojo2IndentConfigFromWorker(monaco, {
    // 结构面与语义面共用同一枚 worker 客户端（真客户端上两张查询都在）；`indents` 是
    // 可选面，替身没有时同步器取"零改动"（见 `Kojo2IndentRulesSource`），不是发空规则。
    ...(semanticGetClient === undefined
      ? {}
      : { getClient: async (): Promise<Kojo2IndentRulesSource> => (await semanticGetClient()) as Kojo2IndentRulesSource }),
    ...(deps.warn === undefined ? {} : { warn: deps.warn }),
  });
  const handle = createKojo2SemanticTokensProvider({
    ...deps,
    syncIndentConfig: (model, treeId) => {
      void indentConfig.request(model, treeId);
      deps.syncIndentConfig?.(model, treeId);
    },
  });
  let registration: Monaco.IDisposable;
  try {
    registration = monaco.languages.registerDocumentSemanticTokensProvider(
      KOJO2_LANGUAGE_ID,
      handle.provider,
    );
  } catch (error) {
    // 注册失败 = 这一枚根本没挂上；把两枚自己的账先收了再外抛，
    // 由 `ensureGlobalProviders` 的"全有或全无"统一回滚（错误不许在这里吞掉）。
    handle.dispose();
    indentConfig.dispose();
    throw error;
  }
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        registration.dispose();
      } finally {
        try {
          handle.dispose();
        } finally {
          indentConfig.dispose();
        }
      }
    },
  };
}
