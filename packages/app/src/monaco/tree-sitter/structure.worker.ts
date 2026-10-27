/**
 * 结构解析 worker 入口（LAU-5：**一条线程承载多门语言**）。
 *
 * 与 v1/ERB 各自的入口（`kojo-ts.worker.ts` / `erb-ts.worker.ts`，本批删除）相比只多一件事：
 * 把**两门语言**的资源包一起交给 `startStructureWorker`。线程不按语言名分支——`open`
 * 带哪枚 `grammarWasmUrl` 就装哪门文法（懒装），`ready` 回一条 `docBase` 给宿主当路由键。
 *
 * ## 为什么两门的查询都要在这一个文件里
 *
 * worker 产物是默认的 iife（`vite.config.ts` 刻意不动全局 `worker.format`），iife 不接受
 * code-splitting ⇒ 资源只能**静态** import。代价是这条线程的产物里带两门语言的查询字符串
 * （合计数十 KB，远小于两枚文法 wasm），换来的是：**一个 `Parser.init`、一条线程**。
 *
 * 两门语言共用同一个 `runtimeWasmUrl`（`web-tree-sitter` 自己的运行时）——这正是
 * "共用 `Parser.init`"能成立的前提：同一份运行时模块只实例化一次。
 */
import { KOJO_STRUCTURE_ASSETS } from './assets';
import { ERB_STRUCTURE_ASSETS } from './erb-assets';
import { erbIndentPattern } from './erb-indent-patterns';
import { erbCaptureTier } from './erb-tiers';
import { startStructureWorker } from './worker-bootstrap';

startStructureWorker([
  {
    runtimeWasm: KOJO_STRUCTURE_ASSETS.runtimeWasmUrl,
    grammarWasm: KOJO_STRUCTURE_ASSETS.kojoWasmUrl,
    highlightsQuery: KOJO_STRUCTURE_ASSETS.highlightsQuery,
    foldsQuery: KOJO_STRUCTURE_ASSETS.foldsQuery,
    indentsQuery: KOJO_STRUCTURE_ASSETS.indentsQuery,
  },
  {
    runtimeWasm: ERB_STRUCTURE_ASSETS.runtimeWasmUrl,
    grammarWasm: ERB_STRUCTURE_ASSETS.erbWasmUrl,
    highlightsQuery: ERB_STRUCTURE_ASSETS.highlightsQuery,
    foldsQuery: ERB_STRUCTURE_ASSETS.foldsQuery,
    indentsQuery: ERB_STRUCTURE_ASSETS.indentsQuery,
    captureTier: erbCaptureTier,
    indentPattern: erbIndentPattern,
  },
]);
