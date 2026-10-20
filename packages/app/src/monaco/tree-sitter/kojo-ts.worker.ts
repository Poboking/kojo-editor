/**
 * `.kojo` 结构解析 worker 入口：只交出 Kojo 的两枚 wasm + 三份查询，消息环在 `worker-bootstrap.ts`。
 * 主线程永不解析（CST 与查询只活在这一条线程里）。
 */
import { KOJO_STRUCTURE_ASSETS } from './assets';
import { startStructureWorker } from './worker-bootstrap';

startStructureWorker({
  runtimeWasm: KOJO_STRUCTURE_ASSETS.runtimeWasmUrl,
  grammarWasm: KOJO_STRUCTURE_ASSETS.kojoWasmUrl,
  highlightsQuery: KOJO_STRUCTURE_ASSETS.highlightsQuery,
  foldsQuery: KOJO_STRUCTURE_ASSETS.foldsQuery,
  indentsQuery: KOJO_STRUCTURE_ASSETS.indentsQuery,
});
