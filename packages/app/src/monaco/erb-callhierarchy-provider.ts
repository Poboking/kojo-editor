import type * as Monaco from './entry';
import type { ErbFunction, ErbFunctionRef, ErbIndex, ErbReference } from '@kojo/plugin-api';
import {
  incomingCalls,
  outgoingCalls,
  resolveEnclosingFunction,
  type FunctionAtResolver,
} from './erb-call-hierarchy';
import { ERB_LANGUAGE_ID } from './erb-language';

/**
 * ERB **调用层级 provider**（ERB-CALLHIER，批次九）——把既有纯模型
 * `monaco/erb-call-hierarchy.ts` 包成 Monaco provider 形状，**两语言同权**：
 * `.kojo2` 有 `monaco/kojo2-callhierarchy.ts` 的同款形状，ERB 从此也有。
 *
 * ## 分层（**纯模型说了算，provider 只做坐标翻译**）
 *
 * 判定与收集**一行都不在这里重写**：
 * - 光标 → 包围函数：`resolveEnclosingFunction`（`functionAt` 优先、缺席退化同一份索引；
 *   口径与调用层级面板 `ui/CallHierarchyOverlay.tsx` **逐字同一条腿**）；
 * - 入边：`incomingCalls`（反向索引 `bySymbol` 的引用点 → 按调用者分组，`definition` 剔除、
 *   索引缝 fail-open）；
 * - 出边：`outgoingCalls`（同一张反向索引里 `kind === 'call'` 且落在函数区间内的点）。
 *
 * 本模块只做三件事：把 Monaco 的 model / position 换成 `(filePath, line)`；把
 * `ErbFunction` / `ErbFunctionRef` / `ErbReference` 换成 Monaco 的
 * item / range / `fromRanges`；把 provider 的三条腿接到那三个纯函数上。
 *
 * ## prepare 答什么（与面板同一把尺子）
 *
 * **`prepareCallHierarchy` 返回"光标所在的那个函数"**，不是"光标那一格被谁引用"。
 * 调用层级面板的入口参数就是 `{ filePath, line }`，它取的也是
 * `resolveEnclosingFunction`——provider 若另造"光标词 → 被调定义"的解析判据，立刻就是
 * 第二份语言事实（且会与面板对同一格给出两种答案）。所以：
 * - 函数声明头 / 名字段 / 函数体内任意一行 ⇒ 交回该函数；调用位交出**调用者**
 *   （要看被调者用转定义 F12，那条腿由 `ui.editor.languageService` 槽承担）；
 * - 不在任何函数体内（顶层代码 / 行号漂移）⇒ `null`（不猜、不夹取到邻近函数）；
 * - 索引未建 / 路径取不到 / 位置不可用 ⇒ `null`。
 *
 * ## Monaco 面（0.57 没有 CallHierarchy API）
 *
 * Monaco standalone（含 0.57.0）从未暴露 `registerCallHierarchyProvider`（取证见
 * `docs/PITFALLS.md` §83）。{@link installErbCallHierarchyProvider} **结构性探测**该注册位：
 * 在位就按正规 provider 注册；不在位就**零注册**并交回幂等句柄。{@link createErbCallHierarchyProvider}
 * 单独导出，宿主自建面板（overlay / devtools）可直接复用同一份实现，不必等上游 API
 * ——与 `kojo2-callhierarchy.ts` 的 `createKojo2CallHierarchyProvider` 同一形状。
 *
 * 安装器的第二参数是本 provider 的**数据源**（`currentIndex` / 可选的 `functionAt`）：
 * 没有数据源就不注册——一枚永远答空的 provider 只会让"这个功能突然没了"更难查。
 *
 * ## 失败面
 *
 * provider 内任何异常回空（prepare ⇒ `null`，入边 / 出边 ⇒ `[]`）：Monaco 会把 throw 吞成
 * "这个功能突然没了"，空结果才是它能读出的唯一形状。`null` 与 `[]` 的分工沿用 kojo2：
 * `null` = item 认不出 / 这一格不是函数，`[]` = 是，但没有边（或取数腿当场抛错）。
 *
 * ## 数据回传（**可序列化坐标，不缓存对象**）
 *
 * item 的 `data` 只有 `{ name, normalizedName, filePath, startLine, endLine }`：Monaco 会把
 * item 原样交给入边 / 出边查询（可能跨会话 / 从 JSON 还原），本层不持有 `ErbIndex` 对象
 * 引用，也不按名字重新解析文件——坐标就是全部事实。认不出（缺 `data` / 行列非法 /
 * 名字为空）⇒ `null`，不拿名字瞎猜。
 *
 * 路径比较只在"要不要用当前 model 的行宽补尾列"这一处用到，按 Windows 口径归一
 * （分隔符 + 大小写）；不参与任何语言判定。
 */

/* ============================== 公共形状 ============================== */

/** 1 基半开区间（`endColumn` = 尾后一列；与 Monaco `IRange` / 索引同口径）。 */
export interface ErbCallHierarchyRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/**
 * item 的 `data`（Monaco / LSP 的 item 会把它原样回传给入边 / 出边查询）。
 *
 * 全部是**可序列化的坐标事实**：函数名、归一化名、文件、定义行区间。
 * 回传时按这些坐标直接喂纯模型（入边只要归一化名，出边只要定义区间），
 * 不需要在本层重新解析源文。
 */
export interface ErbCallHierarchyData {
  readonly name: string;
  readonly normalizedName: string;
  readonly filePath: string;
  /** 定义行（`@` 行，1 基） */
  readonly startLine: number;
  /** 函数体结束行（1 基，含） */
  readonly endLine: number;
}

/**
 * 一枚 ERB 函数的 item。
 *
 * `kind` 恒为 `'function'`（Monaco 的 `SymbolKind.Function` 翻译留给 wiring 那一层）：
 * ERB 只有函数是可调用体，没有第二种节点。
 */
export interface ErbCallHierarchyItem {
  readonly name: string;
  readonly kind: 'function';
  /** 函数定义整段区间（`@` 行到函数体末行） */
  readonly range: ErbCallHierarchyRange;
  /** 名字段（客户端跳过来时选中的那一段） */
  readonly selectionRange: ErbCallHierarchyRange;
  readonly data: ErbCallHierarchyData;
}

/** 一条入边：`from` = 调用者函数，`fromRanges` = 调用者体内的调用点。 */
export interface ErbIncomingCall {
  readonly from: ErbCallHierarchyItem;
  readonly fromRanges: readonly ErbCallHierarchyRange[];
}

/** 一条出边：`to` = 被调函数，`fromRanges` = **本 item** 体内的调用点（LSP 同名字段）。 */
export interface ErbOutgoingCall {
  readonly to: ErbCallHierarchyItem;
  readonly fromRanges: readonly ErbCallHierarchyRange[];
}

/**
 * provider 的数据源（宿主注入；**软取、不抛**）。
 *
 * - `currentIndex`：当前 ERB 索引；未建 / 服务缺席 ⇒ `null`（宿主那侧是
 *   `ui/editor-global-providers.ts` 的 `erbParserIndex()` 同一枚软取）；
 * - `functionAt`：解析器"行 → 函数"通道；`null` / 缺席 ⇒ 纯模型退化到索引自扫
 *   （三态语义见 `erb-call-hierarchy.ts` 的 `FunctionAtResolver`）。
 */
export interface ErbCallHierarchyDeps {
  currentIndex(): ErbIndex | null;
  functionAt?: FunctionAtResolver | null;
}

/** 调用层级 provider 的形状（Monaco 0.57 没有对应接口；见模块头「Monaco 面」）。 */
export interface ErbCallHierarchyProvider {
  readonly displayName: string;
  prepareCallHierarchy(
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
  ): ErbCallHierarchyItem[] | null;
  provideCallHierarchyIncomingCalls(
    model: Monaco.editor.ITextModel,
    item: ErbCallHierarchyItem,
  ): ErbIncomingCall[] | null;
  provideCallHierarchyOutgoingCalls(
    model: Monaco.editor.ITextModel,
    item: ErbCallHierarchyItem,
  ): ErbOutgoingCall[] | null;
}

/* ============================== 内部形状 ============================== */

/** 一个可调用声明的最小事实（`ErbFunction` 与 `ErbFunctionRef` 的公共面）。 */
type CallableFact = ErbFunction | ErbFunctionRef;

/** 一次 provider 调用的模型事实（只用于**尾列**翻译；判定一律不读它）。 */
interface ModelContext {
  /** 整篇源文；取不到 ⇒ `null`（不猜行宽） */
  readonly source: string | null;
  /** model 背后的文件路径；取不到 ⇒ `null` */
  readonly path: string | null;
  /** 按物理行切好的源文（`source === null` ⇒ `null`） */
  readonly lines: readonly string[] | null;
}

/** 无注册位 / 无数据源时交回的句柄（调用方照常 `dispose()`，什么也不会发生） */
const NOOP_DISPOSABLE: Monaco.IDisposable = { dispose: () => undefined };

/**
 * 零参工厂的缺省数据源（**没有索引**）：三条腿一律回空。
 *
 * 只服务"先占住形状"的调用方（宿主面板在索引接线之前拿一份可传的 provider）；
 * 真实面板必须自己注入 `currentIndex`，否则它看到的永远是"没有调用关系"。
 */
const NO_INDEX_DEPS: ErbCallHierarchyDeps = { currentIndex: () => null };

/* ============================== 小工具 ============================== */

/** 路径比较键（Windows 分隔符 + 大小写不敏感；只服务尾列翻译，不参与语义） */
function pathKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/** 取整篇源文；取不到（模型已释放 / 桩 model）⇒ `null`（provider 给空结果） */
function sourceOf(model: Monaco.editor.ITextModel): string | null {
  try {
    if (typeof model.isDisposed === 'function' && model.isDisposed()) return null;
    const text = model.getValue();
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** model 的文件路径（`fsPath` 回落 `path`；桩 model 没有 uri ⇒ `null`） */
function filePathOf(model: Monaco.editor.ITextModel): string | null {
  try {
    const uri = (model as { uri?: { fsPath?: unknown; path?: unknown } }).uri;
    if (uri === null || typeof uri !== 'object') return null;
    if (typeof uri.fsPath === 'string' && uri.fsPath.length > 0) return uri.fsPath;
    if (typeof uri.path === 'string' && uri.path.length > 0) return uri.path;
    return null;
  } catch {
    return null;
  }
}

/** 一次调用把 model 读成 (路径, 源文, 行表)；任何一步失败只影响尾列，不影响判定。 */
function contextOf(model: Monaco.editor.ITextModel): ModelContext {
  const source = sourceOf(model);
  return {
    source,
    path: filePathOf(model),
    lines: source === null ? null : source.split(/\r\n|\r|\n/),
  };
}

/** 位点是否可用于查询（正整数行列；NaN / 0 / 负数一律落空） */
function isUsablePosition(position: Monaco.Position | null | undefined): boolean {
  if (position === null || position === undefined) return false;
  return (
    Number.isInteger(position.lineNumber) &&
    Number.isInteger(position.column) &&
    position.lineNumber >= 1 &&
    position.column >= 1
  );
}

/** 名字段起点列：索引给了 `nameColumn` 就用它；缺席 ⇒ 行首（**不猜缩进**） */
function nameStartOf(fact: CallableFact): number {
  const column = fact.nameColumn;
  return typeof column === 'number' && Number.isInteger(column) && column >= 1 ? column : 1;
}

/**
 * 名字段终点列（半开）：起点 + 名字长度。
 *
 * 名字长度按**原样**（`ErbFunction.name` / `ErbFunctionRef.name`）计——索引里名字就是
 * 源文那一段（大小写归一不改长度），UTF-16 码元与 Monaco 列同单位。
 */
function nameEndOf(fact: CallableFact, startColumn: number): number {
  return startColumn + Math.max(fact.name.length, 1);
}

/**
 * 函数整段区间的尾列。
 *
 * - 当前 model 就是这个文件：用该末行的行宽（`length + 1`）——**只翻译，不解析**；
 * - 跨文件（或源文取不到）：单行函数退化成名字段终点，多行函数取末行行首（`1`）。
 *   Monaco 的区间只需要能包住 `selectionRange`，跨文件行宽本来就不在这份 model 里，
 *   不拿一个好听的数字冒充。
 */
function rangeEndColumn(fact: CallableFact, startColumn: number, ctx: ModelContext): number {
  const selectionEnd = nameEndOf(fact, startColumn);
  let endColumn: number;
  if (ctx.lines !== null && ctx.path !== null && pathKey(ctx.path) === pathKey(fact.filePath)) {
    const line = ctx.lines[fact.endLine - 1];
    endColumn = typeof line === 'string' ? line.length + 1 : 1;
  } else {
    endColumn = 1;
  }
  // 单行函数的区间不得不落在同一行上：至少包住名字段，否则区间比 selectionRange 还短
  return fact.endLine === fact.startLine ? Math.max(endColumn, selectionEnd) : Math.max(endColumn, 1);
}

/** 可调用事实 → item（**唯一**翻译点）。 */
function itemOf(fact: CallableFact, ctx: ModelContext): ErbCallHierarchyItem {
  const startColumn = nameStartOf(fact);
  return {
    name: fact.name,
    kind: 'function',
    range: {
      startLine: fact.startLine,
      startColumn,
      endLine: fact.endLine,
      endColumn: rangeEndColumn(fact, startColumn, ctx),
    },
    selectionRange: {
      startLine: fact.startLine,
      startColumn,
      endLine: fact.startLine,
      endColumn: nameEndOf(fact, startColumn),
    },
    data: {
      name: fact.name,
      normalizedName: fact.normalizedName,
      filePath: fact.filePath,
      startLine: fact.startLine,
      endLine: fact.endLine,
    },
  };
}

/**
 * 一处调用点 → Monaco 区间（恒等搬运 1 基半开坐标；坏列只夹到合法下界，不改行）。
 *
 * `ErbReference` 的 `column` / `endColumn` 与 Monaco 列**同单位**（1 基 UTF-16 码元、
 * 尾列不含端点），所以这里没有第二套坐标换算。
 */
function callSiteRange(site: ErbReference): ErbCallHierarchyRange {
  const startColumn = site.column >= 1 ? site.column : 1;
  return {
    startLine: site.line,
    startColumn,
    endLine: site.line,
    endColumn: site.endColumn > startColumn ? site.endColumn : startColumn,
  };
}

/** 一组调用点 → 区间列表（保持索引给的行→列序，不排序、不去重：纯模型已经定序） */
function callSiteRanges(sites: readonly ErbReference[]): ErbCallHierarchyRange[] {
  return sites.map(callSiteRange);
}

/**
 * item 的 `data` 校验（Monaco 会把 item 原样传回来；它可能来自旧版本 / 别的文件 / 手工构造）。
 * 认不出 ⇒ `null`（调用方回 `null`，不拿名字瞎猜）。
 */
function dataOf(item: ErbCallHierarchyItem | null | undefined): ErbCallHierarchyData | null {
  if (item === null || item === undefined || typeof item !== 'object') return null;
  const raw: unknown = (item as { data?: unknown }).data;
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const name = data.name;
  const normalizedName = data.normalizedName;
  const filePath = data.filePath;
  const startLine = data.startLine;
  const endLine = data.endLine;
  if (typeof name !== 'string' || name.length === 0) return null;
  if (typeof normalizedName !== 'string' || normalizedName.length === 0) return null;
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  if (!Number.isInteger(startLine) || (startLine as number) < 1) return null;
  if (!Number.isInteger(endLine) || (endLine as number) < (startLine as number)) return null;
  return {
    name,
    normalizedName,
    filePath,
    startLine: startLine as number,
    endLine: endLine as number,
  };
}

/** 软取当前索引（服务缺席 / 通道抛错 ⇒ `null`） */
function currentIndexOf(deps: ErbCallHierarchyDeps): ErbIndex | null {
  try {
    return deps.currentIndex() ?? null;
  } catch {
    return null;
  }
}

/** 软取解析器通道（缺席 / 非函数 ⇒ `null`；通道自身抛错由纯模型兜底） */
function functionAtOf(deps: ErbCallHierarchyDeps): FunctionAtResolver | null {
  const resolver = deps.functionAt;
  return typeof resolver === 'function' ? resolver : null;
}

/* ============================== provider ============================== */

/**
 * 创建 ERB 调用层级 provider（导出给宿主自建面板 / 未来上游 API 共用；
 * **不依赖 Monaco 运行时**）。
 *
 * `deps` 缺席 ⇒ 无数据源（三条腿回空，见 {@link NO_INDEX_DEPS}）：那是给"先占形状"的
 * 调用方留的口子，**真实面板必须注入 `currentIndex`**——与安装器"无数据源不注册"
 * 同一条纪律（一枚永远答空的 provider 不该被误读成"这个文件没有调用关系"）。
 *
 * 三条腿都自带 try/catch：任何一条抛错只让**那一轮**回空（prepare ⇒ `null`，
 * 入边 / 出边 ⇒ `[]`），不把异常送进 Monaco 的吞异常通道。
 */
export function createErbCallHierarchyProvider(
  deps: ErbCallHierarchyDeps = NO_INDEX_DEPS,
): ErbCallHierarchyProvider {
  return {
    displayName: 'erb',
    prepareCallHierarchy(model, position) {
      if (!isUsablePosition(position)) return null;
      const ctx = contextOf(model);
      if (ctx.source === null || ctx.path === null) return null;
      const index = currentIndexOf(deps);
      if (index === null) return null;
      try {
        const target = resolveEnclosingFunction(
          index,
          functionAtOf(deps),
          ctx.path,
          position.lineNumber,
        );
        return target === undefined ? null : [itemOf(target, ctx)];
      } catch {
        return null;
      }
    },
    provideCallHierarchyIncomingCalls(model, item) {
      const data = dataOf(item);
      if (data === null) return null;
      const index = currentIndexOf(deps);
      if (index === null) return [];
      const ctx = contextOf(model);
      if (ctx.source === null) return [];
      try {
        return incomingCalls(index, functionAtOf(deps), data.normalizedName).map((group) => ({
          from: itemOf(group.caller, ctx),
          fromRanges: callSiteRanges(group.sites),
        }));
      } catch {
        return [];
      }
    },
    provideCallHierarchyOutgoingCalls(model, item) {
      const data = dataOf(item);
      if (data === null) return null;
      const index = currentIndexOf(deps);
      if (index === null) return [];
      const ctx = contextOf(model);
      if (ctx.source === null) return [];
      try {
        return outgoingCalls(index, data).map((group) => ({
          to: itemOf(group.callee, ctx),
          fromRanges: callSiteRanges(group.sites),
        }));
      } catch {
        return [];
      }
    },
  };
}

/* ============================== 安装 ============================== */

/**
 * `monaco.languages` 上的 CallHierarchy 注册位（**结构性探测**）：
 * 0.57 没有它（PITFALLS §83），上游将来加上就自动接上，本文件不写死版本判断。
 */
interface CallHierarchyRegistrar {
  readonly registerCallHierarchyProvider: (
    selector: string,
    provider: ErbCallHierarchyProvider,
  ) => Monaco.IDisposable;
}

function callHierarchyRegistrarOf(monaco: typeof Monaco): CallHierarchyRegistrar | null {
  const languages: unknown = (monaco as unknown as { languages?: unknown }).languages;
  if (languages === null || languages === undefined || typeof languages !== 'object') return null;
  const register = (languages as { registerCallHierarchyProvider?: unknown })
    .registerCallHierarchyProvider;
  if (typeof register !== 'function') return null;
  const callable = register as (
    this: unknown,
    selector: string,
    provider: ErbCallHierarchyProvider,
  ) => Monaco.IDisposable;
  return {
    registerCallHierarchyProvider: (selector, provider) =>
      callable.call(languages, selector, provider),
  };
}

/**
 * 为 ERB 注册调用层级 provider，返回**幂等** disposable。
 *
 * - **无数据源**（`deps` 缺席）⇒ 空操作（**零注册**）：一枚永远答空的 provider 只会把
 *   "没接线"伪装成"这个文件没有调用关系"；
 * - Monaco 0.57 没有 `registerCallHierarchyProvider`（PITFALLS §83）⇒ **零注册**并交回
 *   幂等句柄：宿主用 {@link createErbCallHierarchyProvider} 走自建面板，两者同一份实现；
 * - 只挂 `ERB_LANGUAGE_ID`（方言族 `.erb` / `.erm` / `.erh` 都由这一枚收；2.0 侧没有
 *   注册器，宿主面板直接拿 `createKojo2CallHierarchyProvider`，两门语言不重不漏）；
 * - 注册抛错原样外抛（只有一枚注册，没有半成品要回滚；宿主那侧的"全有或全无"才有东西可撤）；
 * - `dispose` 幂等；注册句柄的 `dispose` 抛错也吞掉（一枚撤不掉不许把卸载链带崩，
 *   错误也没有第二个消费者）。
 */
export function installErbCallHierarchyProvider(
  monaco: typeof Monaco,
  deps?: ErbCallHierarchyDeps,
): Monaco.IDisposable {
  if (deps === undefined) return NOOP_DISPOSABLE;
  const registrar = callHierarchyRegistrarOf(monaco);
  if (registrar === null) return NOOP_DISPOSABLE;

  const registration = registrar.registerCallHierarchyProvider(
    ERB_LANGUAGE_ID,
    createErbCallHierarchyProvider(deps),
  );
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        registration.dispose();
      } catch {
        /* 幂等 + 不抛：见函数头注 */
      }
    },
  };
}
