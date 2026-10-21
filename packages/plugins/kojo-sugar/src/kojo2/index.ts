/**
 * `kojo-sugar` 的 Kojo 2.0 并存层（开发期）：只做 core 管线的装配与守卫。
 *
 * 分层纪律：
 * - 本目录只依赖 `@kojo/plugin-api` 与本包 v1 代码之外**唯一新增依赖** `@kojo/kojo-core`；
 * - **不** import 任何 adapter 插件、不 import kernel（解耦审计 B/C 项）；
 * - v1 的 `.kojo` 管线（`src/*.ts`）零改动；2.0 走新导出，不抢 `sugar.transpile` 键。
 */
export {
  createKojo2TranspileService,
  type Kojo2CompileFn,
  type Kojo2CompileRequest,
  type Kojo2CompileResult,
  type Kojo2TranspileDeps,
  type Kojo2TranspileInput,
  type Kojo2TranspileService,
} from './service.js';
