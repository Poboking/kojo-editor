/**
 * ERB 结构层的资源装配点（两枚 wasm + 五份查询）。
 *
 * 与 `assets.ts` 同一形态：只有 worker / 运行时入口静态引用本文件，开关关着时主线程不碰。
 *
 * 查询分两类：
 * - **运行时面**（worker 真的跑）：`foldsQuery`（折叠）、`highlightsQuery`（语义 token）、
 *   `indentsQuery`（缩进规则）；
 * - **结构对照面**（不进 worker，供宿主配置 / 测试 / 工具读）：`bracketsQuery`（块配对与
 *   FORM 表达式括号）、`diagnosticsQuery`（ERROR / MISSING / 停用区的查询面表述）。
 *   前者的产物是 `erb-language.ts` 的括号配置与 `erb-diagnostics.ts` 的诊断映射；
 *   后者与运行时 `engine.ts::collectFaults` 是同一批判据的两种表述。
 *
 * `?url` / `?raw` 是 Vite 交付面：主线程的 `erb-runtime.ts` 与 worker 入口都从这里取，
 * 别在别处再 import 一次 `?raw`（两份字符串 = 两个会漂的真相）。
 */
import erbWasmUrl from '../../../../erb-syntax-tree/tree-sitter-erb.wasm?url';
import runtimeWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';
import bracketsQuery from '../../../../erb-syntax-tree/queries/brackets.scm?raw';
import diagnosticsQuery from '../../../../erb-syntax-tree/queries/diagnostics.scm?raw';
import foldsQuery from '../../../../erb-syntax-tree/queries/folds.scm?raw';
import highlightsQuery from '../../../../erb-syntax-tree/queries/highlights.scm?raw';
import indentsQuery from '../../../../erb-syntax-tree/queries/indents.scm?raw';

export const ERB_STRUCTURE_ASSETS = {
  erbWasmUrl,
  runtimeWasmUrl,
  foldsQuery,
  highlightsQuery,
  indentsQuery,
  bracketsQuery,
  diagnosticsQuery,
} as const;
