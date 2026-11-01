/**
 * kojo2 结构层的**池内后端**（LAU-5 收尾）。
 *
 * ## 为什么有这个文件
 *
 * kojo2 过去是自有 worker（`kojo2-ts.worker.ts` + `?worker`）：与池里那条 structure 线程
 * 各付一次 `Parser.init` 与文法装载。这里把**同一条协议环**（`createKojo2WorkerEngine` +
 * `createKojo2ProtocolRing`）挂进 `worker-bootstrap.ts` 的自定义槽后端——线程、号段
 * （`ready.docBase`）与 lifecycle 全由池管，kojo2 不再 `createWorker`。
 *
 * ## 为什么不走通用 `StructureEngine`
 *
 * 两套引擎的折叠 / 缩进语义有差（通用引擎吞尾随空行，kojo2 的 `@fold` 按捕获原样上报；
 * 缩进的派生规则也不同）。把 kojo2 换成通用引擎等于顺手改语义；走后端则解析路径**逐字不变**。
 *
 * ## 静态资源
 *
 * worker 产物是 iife（`vite.config.ts` 刻意不动 `worker.format`），不接受动态 import：
 * `web-tree-sitter` 与两枚 wasm / 三份查询都**静态**取，与旧入口 `kojo2-ts.worker.ts`
 * 同一装配形态（该入口本批删除）。
 */
import * as WebTreeSitter from 'web-tree-sitter';
import { KOJO2_TREE_SITTER_ASSETS } from './kojo2-assets';
import { createKojo2Runtime } from './kojo2-runtime-core';
import { createKojo2ProtocolRing, createKojo2WorkerEngine } from './kojo2-worker';
import { STRUCTURE_WORKER_PROTOCOL, type StructureSlotBackend } from './worker-bootstrap';

/**
 * 造一台挂在这个号段上的 kojo2 后端。
 *
 * `initialize()` 直接复用环的 `open`（协议校验 + 预热 + `loadMs` 的账都只有那一处）；
 * 回话里的 `docBase` 由池盖（`worker-bootstrap` 用自己的槽号段回 `ready`），这里只取成败。
 */
export function createKojo2PoolBackend(docBase: number): StructureSlotBackend {
  const engine = createKojo2WorkerEngine({
    loadRuntime: () => createKojo2Runtime(async () => WebTreeSitter, async () => KOJO2_TREE_SITTER_ASSETS),
  });
  const ring = createKojo2ProtocolRing(engine, STRUCTURE_WORKER_PROTOCOL, docBase);
  return {
    async initialize() {
      const reply = await ring.handle({
        id: 0,
        kind: 'open',
        protocol: STRUCTURE_WORKER_PROTOCOL,
        languageId: 'kojo2',
        runtimeWasmUrl: KOJO2_TREE_SITTER_ASSETS.runtimeWasmUrl,
        grammarWasmUrl: String(KOJO2_TREE_SITTER_ASSETS.grammarWasm),
      });
      if (reply.ok === true && reply.kind === 'ready') return { ok: true, loadMs: reply.loadMs };
      if (reply.ok === false) return { ok: false, reason: reply.reason, message: reply.message };
      return { ok: false, reason: 'crashed', message: 'kojo2 装配回话形状不符（open 没回 ready）' };
    },
    handle: (request) => ring.handle(request),
    dispose: () => ring.dispose(),
  };
}
