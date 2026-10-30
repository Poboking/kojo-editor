import type * as Monaco from './entry';
import type {
  EditorCallHierarchyGroup,
  EditorCallHierarchyResult,
  EditorCallHierarchySymbol,
} from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from './erb-language';

/**
 * ERB **调用层级 provider**（ERB-CALLHIER，批次九；LAU-4 调用层级腿 2026-10-31 改薄）——
 * 把 `ui.editor.languageService` 槽的 `callHierarchy` 应答包成 Monaco provider 形状，
 * **两语言同权**：`.kojo2` 有 `@kojo/kojo-lang/call-hierarchy` 的同款形状，ERB 从此也有。
 *
 * ## 分层（**判据一枚都不在这里**）
 *
 * 判定与收集整块住 `@kojo/plugin-erb-parser`（`symbols.ts` 的调用层级段：入边剔
 * `definition`、出边只认 `kind === 'call'`、所属函数反查单源 `enclosingAt(...,'innermost')`），
 * 由供方经槽应答。本模块只剩三件事：
 * 1. **model / 位置 → 请求**（`path` / 正文 / 行，续问时换成上一轮 item 的节点）；
 * 2. **契约 → Monaco 形状**（`EditorCallHierarchySymbol` → item，`EditorCallHierarchySite` →
 *    区间，唯一的翻译点 {@link itemOf} / {@link callSiteRange}）；
 * 3. 注册位探测与幂等句柄。
 *
 * ## prepare 答什么（与面板同一把尺子）
 *
 * **`prepareCallHierarchy` 返回"光标所在的那个函数"**，不是"光标那一格被谁引用"。面板的
 * 入口参数就是 `{ filePath, line }`，供方取的也是同一个"行 → 函数"判据——provider 若另造
 * "光标词 → 被调定义"的解析，立刻就是第二份语言事实（且会与面板对同一格给出两种答案）。
 *
 * ## Monaco 面（0.57 没有 CallHierarchy API）
 *
 * Monaco standalone（含 0.57.0）从未暴露 `registerCallHierarchyProvider`（取证见
 * `docs/PITFALLS.md` §83）。{@link installErbCallHierarchyProvider} **结构性探测**该注册位：
 * 在位就按正规 provider 注册；不在位就**零注册**并交回幂等句柄。{@link createErbCallHierarchyProvider}
 * 单独导出，宿主自建面板（overlay / devtools）可直接复用同一份实现——与
 * `@kojo/kojo-lang/call-hierarchy` 的 `createKojo2CallHierarchyProvider` 同一形状。
 *
 * 安装器的第二参数是本 provider 的**取数口**（`ask`：生产装配点把它接到槽上，见
 * `ui/shell-overlays.ts` 的注入形态）：没有取数口就不注册——一枚永远答空的 provider
 * 只会让"这个功能突然没了"更难查。
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
 * item 原样交给入边 / 出边查询（可能跨会话 / 从 JSON 还原），本层不持有索引对象引用，
 * 也不按名字重新解析文件——坐标就是全部事实。认不出（缺 `data` / 行列非法 / 名字为空）
 * ⇒ `null`，不拿名字瞎猜。
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
 * 取数口（宿主注入；**软取、不抛**）：一次 `ui.editor.languageService` 的
 * `callHierarchy` 请求的整条腿（含"第一家作答的说了算"的裁决）。
 *
 * - `path`：请求文件（prepare = 当前 model 的路径；续问 = 上一轮 item 的路径）；
 * - `text`：当前 model 的正文，取不到 ⇒ `null`（契约允许省略：本能力只读项目索引）；
 * - `line`：1 基行号（续问时只作占位，供方按 `subject` 取边）；
 * - `subject`：续问节点；缺席 = 按位置求包围函数。
 *
 * 返回 `undefined` = 无人应答（插件缺席 / 弃权 / 判据抛错）。
 */
export type CallHierarchyAsk = (
  path: string,
  text: string | null,
  line: number,
  subject?: EditorCallHierarchySymbol,
) => EditorCallHierarchyResult | undefined;

/**
 * provider 的取数依赖（宿主注入；**软取、不抛**）。
 *
 * 只有一格：`ask`（判据住 `@kojo/plugin-erb-parser`，经槽应答）。没有第二格
 * "索引 / 通道"——那两格在被搬走时一并取消了：provider 不认识索引，也不需要认识。
 */
export interface ErbCallHierarchyDeps {
  ask: CallHierarchyAsk;
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

/** 一次 provider 调用的模型事实（只用于**尾列**翻译；判定一律不读它）。 */
interface ModelContext {
  /** 整篇源文；取不到 ⇒ `null`（不猜行宽） */
  readonly source: string | null;
  /** model 背后的文件路径；取不到 ⇒ `null` */
  readonly path: string | null;
  /** 按物理行切好的源文（`source === null` ⇒ `null`） */
  readonly lines: readonly string[] | null;
}

/** 无注册位 / 无取数口时交回的句柄（调用方照常 `dispose()`，什么也不会发生） */
const NOOP_DISPOSABLE: Monaco.IDisposable = { dispose: () => undefined };

/**
 * 零参工厂的缺省取数口（**没有供方**）：三条腿一律回空。
 *
 * 只服务"先占住形状"的调用方（宿主面板在取数口接线之前拿一份可传的 provider）；
 * 真实面板必须自己注入 `ask`，否则它看到的永远是"没有调用关系"。
 */
const NO_ASK_DEPS: ErbCallHierarchyDeps = { ask: () => undefined };

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
function nameStartOf(fact: EditorCallHierarchySymbol): number {
  const column = fact.nameColumn;
  return typeof column === 'number' && Number.isInteger(column) && column >= 1 ? column : 1;
}

/**
 * 名字段终点列（半开）：起点 + 名字长度。
 *
 * 名字长度按**原样**（`symbol.name`）计——索引里名字就是源文那一段（大小写归一不改长度），
 * UTF-16 码元与 Monaco 列同单位。
 */
function nameEndOf(fact: EditorCallHierarchySymbol, startColumn: number): number {
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
function rangeEndColumn(fact: EditorCallHierarchySymbol, startColumn: number, ctx: ModelContext): number {
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

/** 可调用体 → item（**唯一**翻译点）。 */
function itemOf(fact: EditorCallHierarchySymbol, ctx: ModelContext): ErbCallHierarchyItem {
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
 * 契约的 `column` / `endColumn` 与 Monaco 列**同单位**（1 基 UTF-16 码元、尾列不含端点），
 * 所以这里没有第二套坐标换算。
 */
function callSiteRange(site: { readonly line: number; readonly column: number; readonly endColumn: number }): ErbCallHierarchyRange {
  const startColumn = site.column >= 1 ? site.column : 1;
  return {
    startLine: site.line,
    startColumn,
    endLine: site.line,
    endColumn: site.endColumn > startColumn ? site.endColumn : startColumn,
  };
}

/** 一组调用点 → 区间列表（保持供方给的行→列序，不排序、不去重：判据已定序） */
function groupRanges(group: EditorCallHierarchyGroup): ErbCallHierarchyRange[] {
  return group.sites.map(callSiteRange);
}

/**
 * item 的 `data` 校验（Monaco 会把 item 原样传回来；它可能来自旧版本 / 别的文件 / 手工构造）。
 * 认不出 ⇒ `null`（调用方回 `null`，不拿名字瞎猜）。
 */
function dataOf(item: ErbCallHierarchyItem | null | undefined): EditorCallHierarchySymbol | null {
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

/** 软取一次应答（取数口缺席 / 抛错 ⇒ `undefined`） */
function askOf(
  deps: ErbCallHierarchyDeps,
  path: string,
  text: string | null,
  line: number,
  subject?: EditorCallHierarchySymbol,
): EditorCallHierarchyResult | undefined {
  try {
    return deps.ask(path, text, line, subject);
  } catch {
    return undefined;
  }
}

/* ============================== provider ============================== */

/**
 * 创建 ERB 调用层级 provider（导出给宿主自建面板 / 未来上游 API 共用；
 * **不依赖 Monaco 运行时**）。
 *
 * `deps` 缺席 ⇒ 无取数口（三条腿回空，见 {@link NO_ASK_DEPS}）：那是给"先占形状"的
 * 调用方留的口子，**真实面板必须注入 `ask`**——与安装器"无取数口不注册"同一条纪律
 * （一枚永远答空的 provider 不该被误读成"这个文件没有调用关系"）。
 *
 * 三条腿都自带 try/catch：任何一条抛错只让**那一轮**回空（prepare ⇒ `null`，
 * 入边 / 出边 ⇒ `[]`），不把异常送进 Monaco 的吞异常通道。
 */
export function createErbCallHierarchyProvider(
  deps: ErbCallHierarchyDeps = NO_ASK_DEPS,
): ErbCallHierarchyProvider {
  return {
    displayName: 'erb',
    prepareCallHierarchy(model, position) {
      if (!isUsablePosition(position)) return null;
      const ctx = contextOf(model);
      if (ctx.source === null || ctx.path === null) return null;
      try {
        const result = askOf(deps, ctx.path, ctx.source, position.lineNumber);
        const subject = result?.subject ?? null;
        return subject === null ? null : [itemOf(subject, ctx)];
      } catch {
        return null;
      }
    },
    provideCallHierarchyIncomingCalls(model, item) {
      const subject = dataOf(item);
      if (subject === null) return null;
      const ctx = contextOf(model);
      if (ctx.source === null) return [];
      try {
        const result = askOf(deps, subject.filePath, ctx.source, subject.startLine, subject);
        return (result?.incoming ?? []).map((group) => ({
          from: itemOf(group.symbol, ctx),
          fromRanges: groupRanges(group),
        }));
      } catch {
        return [];
      }
    },
    provideCallHierarchyOutgoingCalls(model, item) {
      const subject = dataOf(item);
      if (subject === null) return null;
      const ctx = contextOf(model);
      if (ctx.source === null) return [];
      try {
        const result = askOf(deps, subject.filePath, ctx.source, subject.startLine, subject);
        return (result?.outgoing ?? []).map((group) => ({
          to: itemOf(group.symbol, ctx),
          fromRanges: groupRanges(group),
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
 * - **无取数口**（`deps` 缺席）⇒ 空操作（**零注册**）：一枚永远答空的 provider 只会把
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