/**
 * ERB 结构层的资源装配点（两枚 wasm + 一份 folds 查询）。
 *
 * 与 `assets.ts` 同一形态：只有 worker 静态引用本文件，开关关着时主线程不碰这些资源。
 * ERB 首版**没有** semantic / indents 查询（BOARD ERB-TS-STRUCTURE：不做 semantic tokens），
 * 引擎把缺失的查询当"少一面"，不当装配失败。
 */
import erbWasmUrl from '../../../../erb-syntax-tree/tree-sitter-erb.wasm?url';
import runtimeWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';
import foldsQuery from '../../../../erb-syntax-tree/queries/folds.scm?raw';

export const ERB_STRUCTURE_ASSETS = {
  erbWasmUrl,
  runtimeWasmUrl,
  foldsQuery,
} as const;
