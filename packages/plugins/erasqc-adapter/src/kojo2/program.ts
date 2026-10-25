/**
 * eraSQC 2.0 程序层开关（游戏事实 —— 只住本包）。
 *
 * 逐项按真盘读数裁决（2026-10-26 `D:/Game/eraSQC` 全树 `.ERB` 精确匹配）：
 *
 * | 键 | 值 | 依据 |
 * | --- | --- | --- |
 * | `arrays` | true | `#DIMS` 96 处 |
 * | `while` | true | `WHILE` 7 处（少而真实） |
 * | `goto` | true | `GOTO` 247 处 |
 * | `repeat` | true | `REPEAT` 31 处 |
 * | `recursion` | **false** | 无自调用实证；`CALL` 133,008 处是跨函数调用，不是递归 |
 * | `foreach` | **false** | `@巡` 是 2.0 构造，本作零 2.0 语料；与 `foreachCollections: null` 一致 |
 */
import type { ProgramFeatures } from '@kojo/kojo-core';

export const ERASQC_PROGRAM_FEATURES: ProgramFeatures = Object.freeze({
  arrays: true,
  while: true,
  goto: true,
  recursion: false,
  foreach: false,
  repeat: true,
});
