/**
 * eraFL 2.0 程序层开关（游戏事实 —— 只住本包）。
 *
 * 依据：契约 §9.1 —— program extension 由 adapter 的 `programFeatures` 声明；
 * 关闭时 core 报对应的 unsupported 诊断码（不静默降级，§10.10）。
 *
 * 真盘普查（2026-10-24，D:/Game/erafl，2,027 份 ERB 单趟扫描行首关键字计数；
 * 源端构造名 = core `PROGRAM_FEATURE_SYNTAX`）：
 *
 * | 键 | 源端构造 | eraFL 实测 | 判定 |
 * | --- | --- | --- | --- |
 * | `arrays` | `数组 [ ]` | 154 处 `#DIMS 名, N` 数组声明（`#DIMS TAGS, 5` 等） | true |
 * | `while` | `@循` | 123 处 `WHILE` | true |
 * | `goto` | `@标 / @跳` | 77 处 `GOTO` | true |
 * | `recursion` | `@函 递归` | 225 处 `CALLF` + 63 处 `TRYCALLF`（递归安全调用变体在用） | true |
 * | `foreach` | `@巡` | 0 —— 2.0 构造，eraFL 无语料 | false |
 * | `repeat` | `@复` | 4 处 `REPEAT n` 块 + 4 处配对的 `REND`（`QUEST_19_街角.ERB:1412` `REPEAT 3` + 缩进体） | true |
 *
 * `repeat` 的块结构是 eraFL 引擎（EmueraFL）自带的循环块（REPEAT/REND 配对，
 * 数量相等）；`@复` 落点形状归入口 D 的 backend，本表只声明能力。
 */
import type { ProgramFeatures } from '@kojo/kojo-core';

/** eraFL：六项里五项开（foreach 关——无 `@巡` 语料，开了就是假声明） */
export const ERAFL_PROGRAM_FEATURES: ProgramFeatures = Object.freeze({
  arrays: true,
  while: true,
  goto: true,
  recursion: true,
  foreach: false,
  repeat: true,
});
