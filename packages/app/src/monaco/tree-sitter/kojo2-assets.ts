/**
 * Kojo 2.0 结构层的**资源装配点**（两枚 wasm + 三份查询）；v1 的同形装配点在 `assets.ts`。
 *
 * ## 谁 import 本文件
 *
 * - **worker 入口**（`kojo2-ts.worker.ts`）**静态** import：worker 的 iife 产物不接受动态
 *   import 切 chunk，资源必须由入口静态取进来再注入 `createKojo2Runtime()`；
 * - 主线程的懒加载单例（`kojo2-runtime.ts`）**动态** import：flag 关着 / 没人要结构层时，
 *   这些资源连字符串都不进主线程模块图（v1 `kojo-runtime.ts` 同纪律）。
 *
 * `?url` / `?raw` 是 Vite 交付面（也是本批唯一被点名的构建风险），把五枚 import 关在一个
 * 文件里，风险面只有一处可读可审。
 *
 * ## 两枚 wasm 各是谁的
 *
 * - `runtimeWasmUrl` = `web-tree-sitter` 自己的运行时（0.27 包内实名 `web-tree-sitter.wasm`，
 *   `Parser.init({ locateFile })` 靠它找到）；
 * - `grammarWasm` = 2.0 语法层产出的 `tree-sitter-kojo2.wasm`（47,116 B，由
 *   `tools/build-v2.mjs` 生成，本文件只引用、不生产）。
 *
 * 相对路径以**本文件**为锚（`packages/app/src/monaco/tree-sitter/` ⇒ 上四级到 `packages/`），
 * 跨包直取文件而不给 app 加一条 workspace 依赖：加依赖要跑 `pnpm install` 重解锁文件，
 * 那是全仓动作，不该由一条实验特性触发。
 *
 * ## CSP
 *
 * 当前 `tauri.conf.json` 的 CSP 为 `null`（不拦），worker / 主线程里 `fetch` wasm 与
 * `WebAssembly.instantiate` 都不需要额外许可。**若将来收紧 CSP**，须给页面补
 * `script-src 'wasm-unsafe-eval'`（WebAssembly 归到 eval 一类）并让 `connect-src` 放过
 * 本地 asset 协议——这条依赖由本文件的 URL 交付方式决定，写在资源旁边最不容易漏。
 */
import grammarWasmUrl from '../../../../kojo-syntax-tree/tree-sitter-kojo2.wasm?url';
import runtimeWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';
import foldsQuery from '../../../../kojo-syntax-tree/queries/v2/folds.scm?raw';
import highlightsQuery from '../../../../kojo-syntax-tree/queries/v2/highlights.scm?raw';
import indentsQuery from '../../../../kojo-syntax-tree/queries/v2/indents.scm?raw';
import type { Kojo2RuntimeAssets } from './kojo2-runtime-core';

export const KOJO2_TREE_SITTER_ASSETS: Kojo2RuntimeAssets = {
  runtimeWasmUrl,
  grammarWasm: grammarWasmUrl,
  highlightsQuery,
  foldsQuery,
  indentsQuery,
} as const;
