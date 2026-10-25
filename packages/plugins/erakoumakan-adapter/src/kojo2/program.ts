/**
 * era紅魔館 2.0 程序层开关（游戏事实 —— 只住本包）。
 *
 * 证据 = 2026-10-26 `D:/Game/eraKoumakan` 真盘读数（全树 `.ERB` + `.ERH`），逐项裁决：
 *
 * | 键 | 值 | 依据 |
 * | --- | --- | --- |
 * | `arrays` | true | `#DIMS` 259 处 |
 * | `while` | true | `WHILE` 31 处（少而真实） |
 * | `goto` | true | `GOTO` 416 处 |
 * | `repeat` | true | `REPEAT` 31 处 |
 * | `recursion` | **false** | 无自调用实证；`CALL` 34,520 是跨函数调用（子串口径），不是递归 |
 * | `foreach` | **false** | `@巡` 是 2.0 构造，本作零 2.0 语料；与 `foreachCollections: null` 一致 |
 */
import type { ProgramFeatures } from '@kojo/kojo-core';

export const ERAKOUMAKAN_PROGRAM_FEATURES: ProgramFeatures = Object.freeze({
  arrays: true,
  while: true,
  goto: true,
  recursion: false,
  foreach: false,
  repeat: true,
});
