/**
 * eraTW 2.0 程序层开关（游戏事实 —— 只住本包）。
 *
 * 依据：设计稿 §9.1 —— program extension 由 adapter 的 `programFeatures` 声明；
 * eraTW 默认**全部开启**，并纳入 eraTW 验收线。关闭时 core 报
 * `core/feature/unsupported` 一类错误，不静默降级（§10.10）。
 */
import type { ProgramFeatures } from '../../../../kojo-core/src/adapter.js';

/** eraTW：六项全开（arrays / while / goto / recursion / foreach / repeat） */
export const ERATW_PROGRAM_FEATURES: ProgramFeatures = Object.freeze({
  arrays: true,
  while: true,
  goto: true,
  recursion: true,
  foreach: true,
  repeat: true,
});
