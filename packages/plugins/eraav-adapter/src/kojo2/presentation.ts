/**
 * eraAV 2.0 演出面（游戏事实 —— 只住本包）。
 *
 * 逐面按真盘读数裁决（2026-10-26 `C:/game/eraAV`）：
 *
 * | 面 | 裁决 | 依据 |
 * | --- | --- | --- |
 * | 心形 | **null** | 口上域 `@"` 0 处、`♥` 0 行；全树 `@"` 5 处都在系统侧，四象限（`w/l/dw/dl`）无任何变体 |
 * | 着色 | **声明** | 全树 `SETCOLOR` 590 / `RESETCOLOR` 581（口上域 0——引擎机制在，作者侧暂不用） |
 * | 颜绘 | **null** | `PRINT_FACE` 全树 0 处 |
 * | 选项 | **声明（pending）** | `PRINTBUTTON` 3 / `INPUTS` 27 / `RESULTS` 322——全在口上域外，落点可声明、状态按待定走 |
 */
import type { AdapterPresentation } from '@kojo/kojo-core';

/**
 * `@着色 0xRRGGBB` → `SETCOLOR` … `RESETCOLOR`。hex 字面量前缀 `0x`：
 * 语料里的取色指令以 `SETCOLOR 0x…` 为主力形（与 eraTW / eratohok 同引擎口径，
 * 这是引擎事实，不是抄它们的游戏事实）。
 */
const COLOR = Object.freeze({
  setColor: 'SETCOLOR',
  resetColor: 'RESETCOLOR',
  hexPrefix: '0x',
});

/**
 * `选项` 是 2.0 待定 API：adapter 只声明落点，core 使用时按 warning 处理。
 * `result: 'RESULTS'` 是按钮输入读回槽（全树 322 处读回）。
 */
const OPTIONS = Object.freeze({
  status: 'pending' as const,
  button: 'PRINTBUTTON',
  input: 'INPUTS',
  result: 'RESULTS',
  maxPerScene: 1,
});

export const ERAAV_PRESENTATION: AdapterPresentation = Object.freeze({
  heart: null,
  color: COLOR,
  face: null,
  options: OPTIONS,
});
