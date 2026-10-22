/**
 * ERB 结构解析 worker 入口：交出 ERB 的语法 wasm 与三份运行时查询，消息环在 `worker-bootstrap.ts`。
 *
 * 两条语言派生规则也在这里注入（引擎不认语言名，见 `StructureEngineAssets`）：
 * - `captureTier`：`highlights.scm` 的捕获 → ERB 自己的档位表（主线程图里没有这张表）；
 * - `indentPattern`：缩进捕获 → 关键字行首锚（不把整行原文写成一次性规则）。
 */
import { ERB_STRUCTURE_ASSETS } from './erb-assets';
import { erbIndentPattern } from './erb-indent-patterns';
import { erbCaptureTier } from './erb-tiers';
import { startStructureWorker } from './worker-bootstrap';

startStructureWorker({
  runtimeWasm: ERB_STRUCTURE_ASSETS.runtimeWasmUrl,
  grammarWasm: ERB_STRUCTURE_ASSETS.erbWasmUrl,
  foldsQuery: ERB_STRUCTURE_ASSETS.foldsQuery,
  highlightsQuery: ERB_STRUCTURE_ASSETS.highlightsQuery,
  indentsQuery: ERB_STRUCTURE_ASSETS.indentsQuery,
  captureTier: erbCaptureTier,
  indentPattern: erbIndentPattern,
});
