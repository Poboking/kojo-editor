/**
 * eraAkumaMaid 2.0 程序层开关（游戏事实 —— 只住本包）。
 *
 * **无真盘 · 证据等级 B**：2026-10-26 实测 `C:/game/eraAkumaMaid` 与
 * `D:/Game/eraAkumaMaid` 均不存在，本文件**不含任何真盘计数**。`while` / `goto` /
 * `repeat` 是 **Emuera 1824+v18 引擎能力**（`constants.ts:5` 钉了引擎身份），v1 没有
 * 逐项语料计数 ⇒ 按引擎能力开，证据等级 B、如实标注。
 *
 * | 键 | 值 | 依据 |
 * | --- | --- | --- |
 * | `arrays` | true | `#DIMS SAVEDATA` 夹具（`tests/variable-schema.test.ts:127`）+ ERH 自定变量（`variable-schema.ts` 头注） |
 * | `while` | true | Emuera 1824+v18 引擎能力（本包无逐项计数） |
 * | `goto` | true | 同上 |
 * | `repeat` | true | 同上 |
 * | `recursion` | **false** | 无自调用实证 |
 * | `foreach` | **false** | `@巡` 是 2.0 构造，本作零 2.0 语料；与 `foreachCollections: null` 一致 |
 */
import type { ProgramFeatures } from '@kojo/kojo-core';

export const ERAAKUMAMAID_PROGRAM_FEATURES: ProgramFeatures = Object.freeze({
  arrays: true,
  while: true,
  goto: true,
  recursion: false,
  foreach: false,
  repeat: true,
});
