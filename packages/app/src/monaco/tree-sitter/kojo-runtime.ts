import { sugarEnterRulePatterns } from '@kojo/kojo-vocab/enter';
import { KOJO_STRUCTURE_ASSETS } from './assets';
import { KOJO_STRUCTURE_LEGEND, encodeStructureTokens } from './semantic';
import type { StructureLanguageRuntime } from './structure-runtime';

/**
 * `.kojo` 的结构层运行时（A4）：worker 入口、两枚 wasm 与三份查询都在这里汇合。
 *
 * 本模块**只被 `languages.ts` 的 `structure.load()` 动态取**——默认关着时它连同
 * `?worker` 与 `?url` 资源都不进主线程静态图（与收口前 `providers.ts` 动态取
 * `./client` 同一条纪律）。
 */
export const KOJO_STRUCTURE_RUNTIME: StructureLanguageRuntime = {
  runtimeWasmUrl: KOJO_STRUCTURE_ASSETS.runtimeWasmUrl,
  grammarWasmUrl: KOJO_STRUCTURE_ASSETS.kojoWasmUrl,
  semantic: {
    legend: KOJO_STRUCTURE_LEGEND,
    encode: encodeStructureTokens,
  },
  baseIndentPatterns: sugarEnterRulePatterns,
};
