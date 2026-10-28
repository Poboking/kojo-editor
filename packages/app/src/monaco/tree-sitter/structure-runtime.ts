import type * as Monaco from '../entry';
import type { BaseIndentPatterns } from './indent';
import type { StructureEncodeResult, StructureGeometry } from './semantic';
import type { KojoStructureSyntaxFault, KojoStructureToken } from './types';

/** 一门语言结构层可用的**着色面**（legend 与编码器同源，宿主不按语言名挑配色表） */
export interface StructureSemanticFacet {
  readonly legend: Monaco.languages.SemanticTokensLegend;
  encode(tokens: readonly KojoStructureToken[], geometry: StructureGeometry): StructureEncodeResult;
}

/**
 * 编码结果里**真的没涂上**的段数（宿主据此决定要不要报回落；判据只此一处）。
 *
 * `droppedEmpty` **不算**：它记的是"这一行本来就没字可涂"（空行、行尾零宽），是常态而不是
 * 降级。混进判据的代价实测过——2026-10-25，ERB 每个文件都因此报一条"结构着色这次没顶上"，
 * 而屏上一段没少（成因见 `erb-semantic.ts::splitErbStructureTokens` 的"下一行第 0 列"）。
 */
export function lostStructureSpans(result: StructureEncodeResult): number {
  return result.droppedRows + result.droppedWide + result.droppedOverlaps;
}

/**
 * 结构残缺（CST 的 ERROR / MISSING）的**上屏上下文**（LAU-3 / 设计稿 §4.3）。
 *
 * 与设计稿草稿的差量（一行记账）：草稿写的是 `presentSyntax(faults, truncated)`，
 * 但 client 的回调本来就是 `(model, faults, truncated)`，而落 marker 还要 monaco 本体
 * ⇒ 这一格必须带上 `monaco` 与 `model`，否则运行时只能自己 import 宿主（那就把
 * "宿主零语言知识"换成"语言层反向依赖宿主"，方向更糟）。
 */
export interface StructureSyntaxContext {
  readonly monaco: typeof Monaco;
  readonly model: Monaco.editor.ITextModel;
  readonly faults: readonly KojoStructureSyntaxFault[];
  /** 捕获数撞到上限被截过（上屏时要如实说，不许把"截断"画成"没错"） */
  readonly truncated: boolean;
}

/** 撤下上屏（换轨 / 停用 / 关文件）的上下文：同一枚 model，没有 faults */
export interface StructureSyntaxClearContext {
  readonly monaco: typeof Monaco;
  readonly model: Monaco.editor.ITextModel;
}

/**
 * 一条**注入关系**（LAU-6 / 设计稿 §4.6，D14）：主树里的某个节点，体内是另一门语言的源码。
 *
 * 是**数据，不是 `if`**：宿主只按这张表认节点（`hostNode` 原样比对捕获表的节点类型），
 * 再把区间转发给 `languageId` 那门语言的结构 worker（`includedRanges`，坐标天然对齐）。
 * 置空这一格 = 回到"整块不透明"（本批的回滚点）。
 */
export interface InjectionSpec {
  /** 主树里的节点名（由语言自己的声明面写死；宿主只做等值比较，不认识任何具体节点） */
  readonly hostNode: string;
  /** 子语言 id（Monaco 语言 id；宿主据此从 descriptor 注册表取它的结构运行时） */
  readonly languageId: string;
}

/**
 * 一门语言的**结构层运行时**（A4 语言无关化）。
 *
 * 由 `LanguageDescriptor.structure.load()` 按需交回：worker 入口、wasm 与查询资源只在
 * 这门语言第一次真正启用叠层时进入主线程模块图——默认关着时一个字节都不加载。
 *
 * 面由运行时自己声明：
 * - `semantic` 缺省 = 这门语言**不做结构着色**（ERB 首版就是如此，只做折叠 / 残缺 / 缩进）；
 * - `baseIndentPatterns` 缺省 = 不与任何既有回车规则合并，只发结构层自己的规则；
 * - `presentSyntax` / `clearSyntax` 缺省 = 走宿主那枚通用上屏器（`syntax-decorations.ts`）。
 *   **补掉的就是 `providers.ts` 里那两处 `if (languageId === ERB_LANGUAGE_ID)`**：宿主不再
 *   知道"哪门语言用哪套文案"，只调用运行时给的这一枚（LAU-3 的 DoD：providers 里零语言 id）。
 *
 * 折叠与结构残缺不需要声明：worker 协议对所有语言一致，查询没写捕获时由
 * `client.ts` 把那一面标 `dead` 并各说一次。
 */
export interface StructureLanguageRuntime {
  readonly runtimeWasmUrl: string;
  readonly grammarWasmUrl: string;
  /**
   * **注入点（可选）**：自带造线程的函数（测试的假 worker / 回滚到"每语言一条线程"）。
   *
   * 缺省 = 走 `structure-pool.ts` 的池（LAU-5：一条线程按 `grammarWasmUrl` 承载多门语言，
   * `Parser.init` 只付一次）。**生产运行时不再提供这一格**——池是唯一的出线程口。
   */
  readonly createWorker?: () => Worker;
  readonly semantic?: StructureSemanticFacet;
  readonly baseIndentPatterns?: () => BaseIndentPatterns;
  /**
   * 宿主节点注入声明（LAU-6）。**置空 = 这门语言不做注入**（也是本批的回滚点）。
   *
   * kojo2 今天不用 `structure`（它的结构面走自己的 worker），它的注入声明住在语言模块
   * `kojo2-language.ts` 的 `KOJO2_INJECTIONS`；这一格留给将来走通用叠层的语言。
   */
  readonly injections?: readonly InjectionSpec[];
  /**
   * 捕获名（+ 节点类型）→ 档位名（**宿主侧**的配色判据；LAU-1 的 D4 口径）。
   *
   * v3 起 worker 只回**捕获的扁平投影**（查到了哪些捕获 / 节点 / 行列），翻成哪一档由宿主决定：
   * 缺省 = `types.ts::tierForCapture`（`.kojo` v1 那张表），ERB 交 `erbCaptureTier`
   * （`erb-tiers.ts` 是两侧共用的同一张表——worker 侧过去拿它做同一件事，现在只有宿主用）。
   * 返回 `undefined` = 这枚捕获有意不着色（如 ERB 的 `@none`）；`null` = 表外（不着色并说一次）。
   */
  readonly captureTier?: (capture: string, nodeType: string) => string | null | undefined;
  /** 结构残缺上屏（缺省 = 宿主通用上屏器） */
  readonly presentSyntax?: (context: StructureSyntaxContext) => void;
  /** 撤下结构残缺（缺省 = 宿主通用上屏器的 clear） */
  readonly clearSyntax?: (context: StructureSyntaxClearContext) => void;
}
