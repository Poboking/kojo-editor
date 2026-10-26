/**
 * eratohoReverse 2.0 演出面（游戏事实 —— 只住本包）。
 *
 * 逐面按真盘读数裁决（2026-10-26 `C:/game/eratohoReverse`）：
 *
 * | 面 | 裁决 | 依据 |
 * | --- | --- | --- |
 * | 心形 | **null** | 口上域 `♥` 0 行；`@"` 4,149 处是行内字符串惯用法（`PRINTFORM @"…"`），不是心形打印函数，四象限（`w/l/dw/dl`）无任何变体 |
 * | 着色 | **声明** | 口上域 `SETCOLOR` 425 / `RESETCOLOR` 60 |
 * | 颜绘 | **null** | `PRINT_FACE` 全树 0 处 |
 * | 选项 | **声明（pending）** | 口上域 `PRINTBUTTON` 1 / `INPUTS` 2 / `RESULTS` 141——三项在口上域都有真语料，落点可声明 |
 */
import type { AdapterPresentation } from '@kojo/kojo-core';

/**
 * `@着色 0xRRGGBB` → `SETCOLOR` … `RESETCOLOR`。hex 字面量前缀 `0x`：
 * 语料里的取色指令以 `SETCOLOR 0x…` 为主力形（与 eraTW / eraAV 同引擎口径，
 * 这是引擎事实，不是抄它们的游戏事实）。
 */
const COLOR = Object.freeze({
  setColor: 'SETCOLOR',
  resetColor: 'RESETCOLOR',
  hexPrefix: '0x',
});

/**
 * `选项` 是 2.0 待定 API：adapter 只声明落点，core 使用时按 warning 处理。
 * `result: 'RESULTS'` 是按钮输入读回槽（口上域 141 处读回）。
 */
const OPTIONS = Object.freeze({
  status: 'pending' as const,
  button: 'PRINTBUTTON',
  input: 'INPUTS',
  result: 'RESULTS',
  maxPerScene: 1,
});

export const ERATOHOREVERSE_PRESENTATION: AdapterPresentation = Object.freeze({
  heart: null,
  color: COLOR,
  face: null,
  options: OPTIONS,
});
