/**
 * eraSQC 2.0 演出面（游戏事实 —— 只住本包）。
 *
 * 逐面按真盘读数裁决（2026-10-26 `D:/Game/eraSQC`）：
 *
 * | 面 | 裁决 | 依据 |
 * | --- | --- | --- |
 * | 心形 | **null** | `HEARTMARK` 一族确在（口上域 1,382 处），但只有 `_W` / `_L` / `_E` 三个变体（`ERB/TRAIN/FUNCTION_SQ.ERB:5310` 起）；2.0 四象限要 `w/l/dw/dl`，本作无 `DW/DL` 变体 ⇒ 声明会落出引擎不存在的函数，宁缺勿错 |
 * | 着色 | **声明** | `SETCOLOR` 口上域 135 / 全树 519；`RESETCOLOR` 130 / 431 |
 * | 颜绘 | **null** | `PRINT_FACE` 全树 0 处 |
 * | 选项 | **null** | `PRINTBUTTON` 79 / `INPUTS` 8 全在系统菜单域；口上域 0 处 |
 */
import type { AdapterPresentation } from '@kojo/kojo-core';

/**
 * `@着色 0xRRGGBB` → `SETCOLOR` … `RESETCOLOR`。hex 字面量前缀 `0x`：
 * 语料里的取色指令以 `SETCOLOR 0x…` 为主力形（与 eraTW / eraFL 同引擎口径，
 * 这是引擎事实，不是抄它们的游戏事实）。
 */
const COLOR = Object.freeze({
  setColor: 'SETCOLOR',
  resetColor: 'RESETCOLOR',
  hexPrefix: '0x',
});

export const ERASQC_PRESENTATION: AdapterPresentation = Object.freeze({
  heart: null,
  color: COLOR,
  face: null,
  options: null,
});
