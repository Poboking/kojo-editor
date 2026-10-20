import { ERB_STRUCTURE_ASSETS } from './erb-assets';
import ErbWorker from './erb-ts.worker?worker';
import type { StructureLanguageRuntime } from './structure-runtime';

/**
 * ERB 的结构层运行时（ERB-TS-STRUCTURE）：独立 worker、独立 wasm、只供折叠。
 *
 * **没有 `semantic`**：首版不做 semantic tokens，`providers.ts` 因此不给 ERB 注册语义着色
 * provider（ERB 继续走既有词法层）；**没有 `baseIndentPatterns`**：ERB 不是缩进语言。
 * 本模块只被 `languages.ts` 的 `structure.load()` 动态取，默认关着时不进主线程静态图。
 */
export const ERB_STRUCTURE_RUNTIME: StructureLanguageRuntime = {
  runtimeWasmUrl: ERB_STRUCTURE_ASSETS.runtimeWasmUrl,
  grammarWasmUrl: ERB_STRUCTURE_ASSETS.erbWasmUrl,
  createWorker: () => new ErbWorker(),
};
