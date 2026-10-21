/**
 * Kojo 2.0 的 **Monaco 语义着色 provider**（K2-EDITOR-WIRE 批·第三条腿）。
 *
 * ## 数据链（每一条都只在自己的层里）
 *
 * `getKojo2TreeSitterRuntime()`（懒加载单例）→ `parse(text, oldTree)`（**增量**：按 model
 * 版本缓存旧树）→ `captures(rootNode)`（highlights 查询的纯数据投影）→
 * `capturesToTokenSpans(..., { lineCount, maxColumn })`（0 基行列 → 1 基 Monaco 区间）→
 * 本文件的 {@link encodeKojo2SemanticTokens}（5 元组 delta 编码）→ `{ data }`。
 *
 * 本文件**不碰 wasm**、不读查询、不懂 tree-sitter 节点：它只做"运行时产物 → Monaco 协议"
 * 的最后一段。资源只在 `kojo2-runtime.ts` 的默认装载器里动态 import（flag 关 / 没人要结构层
 * 时，`kojo2-assets.ts` 连字符串都不进主线程模块图）。
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
 * ## 增量与所有权
 *
 * 旧树按 **model 版本号**缓存（`WeakMap<model, { versionId, tree }>`）：同一版本重复问
 * 直接命中（Monaco 停笔 / 滚动都会重问）；版本变了才把旧树交给 `parse`。运行时的约定是
 * "旧树在增量解之后已被 `tree.edit` 改写过，不许再当新树用" ⇒ 拿到新树后**立即 delete
 * 旧树**，缓存里只留新树。同一个运行时只有一个 `Parser`，所以请求在 provider 内**串行**
 * （`serialize` 队列）：两个并发 parse 会把同一枚 parser 的增量状态踩乱。
 *
 * 运行时异常 / 装载失败 / 查询缺席 ⇒ **返回空 tokens**（不着色），并 `warn` 一次；
 * 绝不抛进 Monaco、绝不写 markers（着色是只读呈现面，失败不该变成问题面板里的噪音）。
 *
 * ## 注册
 *
 * {@link installKojo2SemanticTokensProvider} 只给 `kojo2` 语言 id 注册，**flag 关时零注册**
 * （调用点在 `ui/editor-global-providers.ts` 的既有 helper 序列里；本函数自身也再挡一次，
 * 因为它是导出的、可能被别的入口直接调用）。disposal 幂等：先撤 provider 注册，再释放
 * 本 provider 缓存过的每一棵树。
 */
import type * as Monaco from './entry';
import type { Tree } from 'web-tree-sitter';
import { KOJO2_LANGUAGE_ID, KOJO2_TOKEN, type Kojo2TokenName } from './kojo2-language';
import { KOJO2_THEME_TOKEN_MAP } from './kojo2-theme';
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';
import {
  capturesToTokenSpans,
  type Kojo2Capture,
  type Kojo2TokenSpan,
} from './tree-sitter/kojo2-tokenizer';
import {
  getKojo2TreeSitterRuntime,
  type Kojo2RuntimeResult,
  type Kojo2TreeSitterRuntime,
} from './tree-sitter/kojo2-runtime';

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
 * 编码口径与 Monaco 的 `toMultilineTokens2` 逐字对齐（取证
 * `semanticTokensProviderStyling.js`：`lastLineNumber = 1`、`lastStartCharacter = 0`）：
 * - **首 token** 的 `deltaLine` 是 1 基绝对行、`deltaStart` 是 1 基绝对列；
 * - 换行时 `deltaStart` 取绝对列；同一行时取相对上一 token 起始列的差；
 * - 必须按 (行, 起始列) 升序（tokenizer 已保证，这里再排一次防御直接调用方）；
 * - 同行重叠保留先到的（Monaco 按到达顺序覆盖；重叠只会让颜色画错而不是消失）；
 * - 零宽区间、legend 之外的类型不进数据。
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
    out.push(
      line - previousLine,
      line === previousLine ? startColumn - previousStart : startColumn,
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

/** 依赖注入缝（测试用；生产全部走缺省） */
export interface Kojo2SemanticProviderDeps {
  /** 取运行时（缺省 = `kojo2-runtime` 的懒加载单例；测试注入假运行时） */
  readonly getRuntime?: () => Promise<Kojo2RuntimeResult>;
  /** 告警出口（缺省 `console.warn`；测试可收账） */
  readonly warn?: (message: string) => void;
}

/** provider + 它自己的资源账（Monaco 的 provider 接口没有 dispose 位） */
export interface Kojo2SemanticProviderHandle {
  readonly provider: Monaco.languages.DocumentSemanticTokensProvider;
  /** 幂等：释放缓存过的每一棵语法树（运行时单例不归这里管） */
  dispose(): void;
}

interface ModelCacheEntry {
  readonly versionId: number;
  /** 上一次 parse 交出的树（下次增量的基准；`null` = 上次失败 / 还没解过） */
  readonly tree: Tree | null;
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
  const getRuntime = deps.getRuntime ?? (() => getKojo2TreeSitterRuntime());
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  /** model → 上一趟的树与结果（`WeakMap`：标签关掉、model 释放后自然可回收） */
  let cache = new WeakMap<Monaco.editor.ITextModel, ModelCacheEntry>();
  /** 缓存里所有树的硬引用账（`WeakMap` 不可遍历，dispose 时要逐棵 delete） */
  const trees = new Set<Tree>();
  /** 同一运行时只有一个 parser ⇒ 请求串行（并发 parse 会踩增量状态） */
  let tail: Promise<void> = Promise.resolve();
  let disposed = false;

  const releaseTree = (tree: Tree): void => {
    trees.delete(tree);
    try {
      tree.delete();
    } catch {
      /* 已被别处删除 / wasm 已卸载：没有可回收的 */
    }
  };

  const forget = (model: Monaco.editor.ITextModel): void => {
    const entry = cache.get(model);
    if (entry?.tree) releaseTree(entry.tree);
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
    const runtimeResult = await getRuntime();
    if (disposed) return EMPTY_DATA;
    if (!runtimeResult.ok) {
      warnOnce(
        warn,
        `runtime:${runtimeResult.reason}`,
        `[kojo2-semantic] 结构解析运行时不可用（${runtimeResult.reason}）：${runtimeResult.message} ⇒ 本轮不着色`,
      );
      return EMPTY_DATA;
    }
    if (model.isDisposed()) {
      forget(model);
      return EMPTY_DATA;
    }
    const runtime: Kojo2TreeSitterRuntime = runtimeResult.runtime;
    const versionId = model.getVersionId();
    const cached = cache.get(model);
    if (cached?.versionId === versionId) return cached.tokens;

    const text = model.getValue();
    const previous = cached?.tree ?? null;
    const parsed = runtime.parse(text, previous);
    // 旧树在增量解之后已被 `tree.edit` 改写过（运行时头注的所有权口径）：不再当新树用，
    // 也不留着——它是这一份 model 上一版本才配拥有的东西。解析失败同样丢（状态可疑）。
    if (previous !== null && (!parsed.ok || parsed.tree !== previous)) releaseTree(previous);
    if (!parsed.ok) {
      warnOnce(
        warn,
        `parse:${parsed.reason}`,
        `[kojo2-semantic] 结构解析失败（${parsed.reason}）：${parsed.message} ⇒ 本轮不着色`,
      );
      cache.set(model, { versionId, tree: null, tokens: EMPTY_DATA });
      return EMPTY_DATA;
    }
    trees.add(parsed.tree);
    const captured = runtime.captures(parsed.rootNode);
    if (!captured.ok) {
      warnOnce(
        warn,
        `captures:${captured.reason}`,
        `[kojo2-semantic] highlights 查询不可用（${captured.reason}）：${captured.message} ⇒ 本轮不着色`,
      );
      cache.set(model, { versionId, tree: parsed.tree, tokens: EMPTY_DATA });
      return EMPTY_DATA;
    }
    const spans = capturesToTokenSpans(
      mapKojo2Captures(captured.captures, (name) =>
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
    cache.set(model, { versionId, tree: parsed.tree, tokens });
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
      for (const tree of [...trees]) releaseTree(tree);
      trees.clear();
      cache = new WeakMap();
    },
  };
}

/**
 * 为 `kojo2` 语言注册语义着色 provider（**flag 关 = 零注册**）。
 *
 * 返回的 disposable 幂等：撤掉 Monaco 注册，再释放 provider 缓存的树（运行时单例留给
 * 结构层其它腿用，不在这里 dispose）。
 */
export function installKojo2SemanticTokensProvider(
  monaco: typeof Monaco,
  deps: Kojo2SemanticProviderDeps = {},
): Monaco.IDisposable {
  if (!isKojo2CutoverEnabled()) {
    return { dispose: () => undefined };
  }
  const handle = createKojo2SemanticTokensProvider(deps);
  let registration: Monaco.IDisposable;
  try {
    registration = monaco.languages.registerDocumentSemanticTokensProvider(
      KOJO2_LANGUAGE_ID,
      handle.provider,
    );
  } catch (error) {
    // 注册失败 = 这一枚根本没挂上；把 provider 自己的账先收了再外抛，
    // 由 `ensureGlobalProviders` 的"全有或全无"统一回滚（错误不许在这里吞掉）。
    handle.dispose();
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
        handle.dispose();
      }
    },
  };
}
