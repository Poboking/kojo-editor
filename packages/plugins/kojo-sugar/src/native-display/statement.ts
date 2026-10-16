/**
 * 赋值 / 调用 / 输出行的中文显示形（**任务线 ZH-S**）。
 *
 * 覆盖面（认得出就翻，认不出返回 `null`，**绝不原样返回**）：
 * - 赋值：`<族头>[:作用域][:索引] = 值`（`+= -= *= /=` 同形）——族头经 `lookup.familyAlias`
 *   换成中文别名（`TFLAG:193 = 1` → `时标:193 = 1`）；查不到别名就保留族头原名，**但整行仍必须
 *   是中文形**（`RESULT` / `LOCAL` 这类语言层槽位给中文显示名）；
 * - 调用：`CALL` / `CALLL` / `CALLFORM` / `TRYCALL` / `TRYCALLFORM` / `TRYJUMP`；
 * - 位原语：`SETBIT` / `CLEARBIT` / `INVERTBIT`；
 * - 输出族：`PRINT` / `PRINTL` / `PRINTW` / `PRINTV` / `PRINTVL` / `PRINTFORM*` / `PRINTDATA*` /
 *   `PRINTSINGLE*`（已有台词投影的形态**不要重复接管**，只补 `native()` 落到的那些变体）；
 * - 排版与等待：`SETCOLOR` / `RESETCOLOR` / `FONTBOLD` / `FONTITALIC` / `FONTSIZE` / `CLEARLINE` /
 *   `FORCEWAIT` / `WAIT` / `DRAWLINE` / `BAR` / `BARL` / `REDRAW`；
 * - 输入：`INPUT` / `INPUTS` / `PRINTBUTTON` / `PRINTBUTTONC`。
 *
 * 与 ZH-C 的分工：**本层只管"非块、非预处理"的行**；两条 pass 不许互相 import。
 */

import type { NativeDisplayInput } from './types';

/** ZH-S 的入口（签名由 lead 钉死，禁止改名或加参） */
export function renderStatementLine(input: NativeDisplayInput): string | null {
  void input;
  return null;
}
