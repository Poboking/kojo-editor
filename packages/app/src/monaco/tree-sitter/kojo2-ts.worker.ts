/**
 * Kojo 2.0 结构解析 worker 的**入口**：静态装资源，再把消息环交给 `kojo2-worker.ts`。
 *
 * ## 为什么资源必须在这里**静态** import
 *
 * worker 产物是默认的 iife（`vite.config.ts` 刻意不动全局 `worker.format`，见
 * `stubNodeOnlyDynamicImports()` 的头注）。iife **不接受 code-splitting**：worker 里只要
 * 出现一条 `import('./kojo2-assets')` / `import('web-tree-sitter')`，Rollup 就会切出额外
 * chunk，`pnpm --filter @kojo/app build` 当场失败（v1 `client.ts` 头注记过同一条坑）。
 * 所以入口把两枚 wasm 的 `?url`、三份 `?raw` 与 `web-tree-sitter` 模块本身**静态**取进来，
 * 交给**零动态 import** 的 `kojo2-runtime-core.ts::createKojo2Runtime()`；
 * `kojo2-runtime.ts`（带动态装载器的主线程单例）因此不进 worker 模块图。
 *
 * 与 v1 的入口同形（`kojo-ts.worker.ts` 已在 LAU-5 并入 `structure.worker.ts` 的池路）：入口文件短到一眼看完；主线程侧
 * `kojo2-worker-runtime.ts` 用 `?worker` 把它变成一条独立线程。
 */
import * as WebTreeSitter from 'web-tree-sitter';
import { KOJO2_TREE_SITTER_ASSETS } from './kojo2-assets';
import { createKojo2Runtime } from './kojo2-runtime-core';
import { startKojo2Worker } from './kojo2-worker';

startKojo2Worker({
  loadRuntime: () => createKojo2Runtime(async () => WebTreeSitter, async () => KOJO2_TREE_SITTER_ASSETS),
});
