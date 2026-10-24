/**
 * eraFL 2.0 程序层开关（游戏事实 —— 只住本包）。
 *
 * 依据：设计稿 §9.1 —— program extension 由 adapter 的 `programFeatures` 声明；
 * 关闭时 core 报 `core/feature/unsupported` 一类错误，不静默降级（§10.10）。
 *
 * **逐项按真盘读数裁决**（交接文档要求"六项逐项核"，eraTW 的六项全开是 eraTW
 * 验收线的选择，不是 eraFL 的事实）。全部计数 = 2026-10-24 `D:/Game/erafl`
 * 全树 `.ERB` 行首精确匹配：
 *
 * | 键 | 值 | 依据 |
 * | --- | --- | --- |
 * | `arrays` | true | 数组声明形实测在用：`#DIMS SAVEDATA CHARADATA CLOTH, CLOTH_PART_NUM`（`variable-schema.ts` 收编的"数组声明"形） |
 * | `while` | true | `WHILE` 行首 123 处 |
 * | `goto` | true | `GOTO` 行首 77 处 |
 * | `repeat` | true | `REPEAT` 行首 4 处（少而真实：引擎循环构造在语料里出现） |
 * | `recursion` | **false** | 无自调用实证——口上域 `CALL KOJO_*` 1,165 处是跨函数调用，不是递归；未测到 ⇒ 不开（fail-visible：作者写递归会得到 unsupported，而不是一个没人验证过的"能"） |
 * | `foreach` | **false** | `@巡` 是 2.0 构造，eraFL 零 2.0 语料；与 `foreachCollections: null` 保持一致（见 `index.ts` 该字段注释） |
 *
 * `recursion` / `foreach` 待入口 D 有真语料/验收线后逐项翻 true——翻之前
 * 按现在的值 fail-visible，不预埋。
 */
import type { ProgramFeatures } from '@kojo/kojo-core';

/** eraFL：arrays / while / goto / repeat 开；recursion / foreach 关（逐项依据见头注） */
export const ERAFL_PROGRAM_FEATURES: ProgramFeatures = Object.freeze({
  arrays: true,
  while: true,
  goto: true,
  recursion: false,
  foreach: false,
  repeat: true,
});
