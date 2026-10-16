/**
 * 控制流与预处理行的中文显示形（**任务线 ZH-C**）。
 *
 * 覆盖面（认得出就翻，认不出返回 `null`，**绝不原样返回**）：
 * - 块：`IF` / `ELSEIF` / `ELSE` / `ENDIF` / `SIF`；`SELECTCASE` / `CASE` / `CASEELSE` / `ENDSELECT`；
 * - 循环：`FOR … NEXT` / `WHILE … WEND` / `REPEAT … REND` / `DO … LOOP`（糖层不做循环**语法**，
 *   但**显示**不许留 ERB ⇒ 本层负责给出可读形）；
 * - 跳转与出口：`GOTO` / `JUMP` / `CALLJUMP` / `$标签` / `BREAK` / `CONTINUE` / `RESTART` / `CATCH`；
 * - 预处理行：`#DIM` / `#DIMS` / `#GLOBAL` / `#LOCALSIZE` / `#LOCALSSIZE` / `#FUNCTION` /
 *   `#FUNCTIONS` / `#SFUNCTION` / `#XFUNCTION` / `#TESTMEMORY` 等。
 *
 * 条件表达式里的中文化**不在本层**：走 `native-display/passes.ts` 注入的 `lookup`
 * （族头别名）与既有 `expression.ts` 的反向口径，别在这里重抄第二份判据。
 */

import type { NativeDisplayInput } from './types';

/** ZH-C 的入口（签名由 lead 钉死，禁止改名或加参） */
export function renderControlLine(input: NativeDisplayInput): string | null {
  void input;
  return null;
}
