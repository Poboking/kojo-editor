import { ERB_STRUCTURE_ASSETS } from './erb-assets';
import ErbWorker from './erb-ts.worker?worker';
import { erbBaseIndentPatterns } from './erb-indent';
import { ERB_SEMANTIC_FACET } from './erb-semantic';
import type { StructureLanguageRuntime } from './structure-runtime';

/**
 * ERB 的结构层运行时（ERB-TS-FULL）：独立 worker、独立 wasm，供四面——
 * **折叠 + 语义着色 + 缩进 + 结构诊断**。
 *
 * - 折叠 / 结构诊断：worker 协议对所有语言一致（`folds.scm` 的 `@fold`、CST 的 ERROR/MISSING），
 *   这里不需要额外声明；
 * - 语义着色：`semantic` 面 = `erb-semantic.ts`（ERB 自己的档位表与编码器；查询是
 *   `highlights.scm`）。`providers.ts` 看到这面就会给 ERB 注册
 *   `DocumentSemanticTokensProvider`，没数据时那枚 provider 回 `null`，让名字分色应答；
 * - 缩进：`baseIndentPatterns` 接 `erb-enter.ts` 的既有层级（基底三格 + `SIF` / 注释两格），
 *   worker 的 `indents.scm` 再把结构规则合并上去——**加法，不替换**既有回车手感。
 *
 * 默认关：整条叠层由 `ui/tree-sitter-pref.ts`（`kojo.ui.treeSitter.v1`，缺省关）控制；
 * 关着时本模块（连同 `?worker`、`?url`、`?raw`）不进主线程静态图，一个 provider 都不注册。
 */
export const ERB_STRUCTURE_RUNTIME: StructureLanguageRuntime = {
  runtimeWasmUrl: ERB_STRUCTURE_ASSETS.runtimeWasmUrl,
  grammarWasmUrl: ERB_STRUCTURE_ASSETS.erbWasmUrl,
  createWorker: () => new ErbWorker(),
  semantic: ERB_SEMANTIC_FACET,
  baseIndentPatterns: erbBaseIndentPatterns,
};
