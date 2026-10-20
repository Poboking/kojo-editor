/**
 * ERB 结构解析 worker 入口：交出 ERB 的语法 wasm 与 folds 查询，消息环在 `worker-bootstrap.ts`。
 * 首版只供折叠（无 semantic / indent），主线程侧由 `ERB_STRUCTURE_RUNTIME.semantic` 缺席表达。
 */
import { ERB_STRUCTURE_ASSETS } from './erb-assets';
import { startStructureWorker } from './worker-bootstrap';

startStructureWorker({
  runtimeWasm: ERB_STRUCTURE_ASSETS.runtimeWasmUrl,
  grammarWasm: ERB_STRUCTURE_ASSETS.erbWasmUrl,
  foldsQuery: ERB_STRUCTURE_ASSETS.foldsQuery,
});
