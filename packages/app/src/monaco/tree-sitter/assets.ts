/**
 * `.kojo` 结构层的**资源装配点**（两枚 wasm + 三份查询）；ERB 的同形装配点在 `erb-assets.ts`。
 *
 * ## 为什么单独成文件
 *
 * WASM 经 Vite 交付是本批唯一被点名的风险面（`?url` 解析不出就是"整档打不开"）。
 * 把四枚 import 关在一个文件里，风险面就只有一处可读、可审、可一次改对；
 * 且**只有 worker 静态引用本文件**（`kojo-ts.worker.ts`），主线程的模块图里
 * 连字符串都没有——开关关着时这些资源一个字节都不进首屏。
 *
 * ## 两枚 wasm 各是谁的
 *
 * - `runtimeWasmUrl` = `web-tree-sitter` 自己的运行时（包内文件实名
 *   `web-tree-sitter.wasm`，0.27 起从 `tree-sitter.wasm` 改名；`Parser.init` 靠
 *   `locateFile` 找到它）；
 * - `kojoWasmUrl` = 语法层产出的 `.kojo` 语法（`@kojo/kojo-syntax-tree` 包根的
 *   `tree-sitter-kojo.wasm`，由语法批生成，本文件只引用、不生产）。
 *
 * 相对路径以**本文件**为锚（`packages/app/src/monaco/tree-sitter/` ⇒ 上四级到 `packages/`），
 * 跨包直取文件而不必给 app 加一条 workspace 依赖：加了就得跑 `pnpm install` 重解锁文件，
 * 那是全仓动作，不该由一条实验特性触发。
 *
 * ## CSP
 *
 * 当前 `tauri.conf.json` 的 CSP 为 `null`（不拦），故 worker 里 `fetch` wasm 与
 * `WebAssembly.instantiate` 都不需要额外许可。**若将来收紧 CSP**，须给 worker 所在
 * 页面补 `script-src 'wasm-unsafe-eval'`（WebAssembly 归到 eval 一类），并确认
 * `connect-src` 放过本地 asset 协议——这条依赖由本文件的 URL 交付方式决定，写在资源旁边最不容易漏。
 */
import kojoWasmUrl from '../../../../kojo-syntax-tree/tree-sitter-kojo.wasm?url';
import runtimeWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';
import foldsQuery from '../../../../kojo-syntax-tree/queries/folds.scm?raw';
import highlightsQuery from '../../../../kojo-syntax-tree/queries/highlights.scm?raw';
import indentsQuery from '../../../../kojo-syntax-tree/queries/indents.scm?raw';

export const KOJO_STRUCTURE_ASSETS = {
  kojoWasmUrl,
  runtimeWasmUrl,
  highlightsQuery,
  foldsQuery,
  indentsQuery,
} as const;
