/**
 * `kojo-core/sema` 自有 barrel（K2-SEMA-TYPES）。
 *
 * 语义检查层对外只有两个公共面：
 * - `types.ts`：值类型格与可赋值判定（纯数据）；
 * - `check.ts`：`checkKojoFile(file, ctx)` → `{ diagnostics, symbols }`。
 *
 * 本包**不并入** `src/index.ts`：接线（宿主/compile/项目层消费）由批次收口统一改公共入口，
 * 本模块先以自有 barrel 交付，避免并行批次争用同一文件。
 */
export * from './types.js';
export * from './check.js';
