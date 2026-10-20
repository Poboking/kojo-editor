import type * as Monaco from '../entry';
import type { BaseIndentPatterns } from './indent';
import type { StructureEncodeResult, StructureGeometry } from './semantic';
import type { KojoStructureToken } from './types';

/** 一门语言结构层可用的**着色面**（legend 与编码器同源，宿主不按语言名挑配色表） */
export interface StructureSemanticFacet {
  readonly legend: Monaco.languages.SemanticTokensLegend;
  encode(tokens: readonly KojoStructureToken[], geometry: StructureGeometry): StructureEncodeResult;
}

/**
 * 一门语言的**结构层运行时**（A4 语言无关化）。
 *
 * 由 `LanguageDescriptor.structure.load()` 按需交回：worker 入口、wasm 与查询资源只在
 * 这门语言第一次真正启用叠层时进入主线程模块图——默认关着时一个字节都不加载。
 *
 * 面由运行时自己声明：
 * - `semantic` 缺省 = 这门语言**不做结构着色**（ERB 首版就是如此，只做折叠 / 残缺 / 缩进）；
 * - `baseIndentPatterns` 缺省 = 不与任何既有回车规则合并，只发结构层自己的规则。
 *
 * 折叠与结构残缺不需要声明：worker 协议对所有语言一致，查询没写捕获时由
 * `client.ts` 把那一面标 `dead` 并各说一次。
 */
export interface StructureLanguageRuntime {
  readonly runtimeWasmUrl: string;
  readonly grammarWasmUrl: string;
  /** 每次调用新建一条线程（一条线程只持有一棵 CST） */
  readonly createWorker: () => Worker;
  readonly semantic?: StructureSemanticFacet;
  readonly baseIndentPatterns?: () => BaseIndentPatterns;
}
