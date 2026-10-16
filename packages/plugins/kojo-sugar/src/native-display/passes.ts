/**
 * 原生行本地化的**装配点**（顺序 = 优先级；本文件是全中系列唯一的 pass 清单）。
 *
 * 消费方是投影（`kojo-sugar/src/project.ts`）：它今天对认不出的行走 `native()`
 * （`text: ''` ⇒ 宿主原样透传整行 ERB）。**改造方向**（ZH-P 线）：
 *
 * ```
 * native 行 → localizeNativeLine(...)
 *   ├─ 认得出  → 中文显示形（行内可残留英文记号）
 *   └─ 认不出  → 显式兜底显示（"工具未识别 + 原文"），**不得**静默透传
 * ```
 *
 * 两条硬尺子分开记，别混成一团：
 * - **红线**：`isVerbatimNativeLine` 命中数 = 0（一整行原样 ERB，绝对不许有）；
 * - **质量线**：未识别兜底行数 → 越低越好（这是"还在读 ERB"的真实残留，允许非零但必须可数）。
 *
 * 新增 pass 只在数组**尾部追加**（前面的优先命中，别重排、别删）。
 */

import { renderControlLine } from './control';
import { renderStatementLine } from './statement';
import type { NativeDisplayInput, NativeDisplayPass } from './types';

export const NATIVE_DISPLAY_PASSES: readonly NativeDisplayPass[] = [renderControlLine, renderStatementLine];

/**
 * 一行原生 ERB → 作者可读形；`null` = 全部 pass 都认不出（调用方必须给显式兜底）。
 *
 * 认不出**不报错**：本层的输入是任意语料，报错就等于让预览整页挂掉（铁律：降级要显式，
 * 不是崩溃）。"不许静默原样放行"由这里的结构保证——pass 若把入参行原样返回，一律视为 `null`。
 */
export function localizeNativeLine(input: NativeDisplayInput): string | null {
  for (const pass of NATIVE_DISPLAY_PASSES) {
    const rendered = pass(input);
    if (rendered !== null && rendered !== input.content) return rendered;
  }
  return null;
}

export type { NativeDisplayInput, NativeDisplayLookup, NativeDisplayPass } from './types';
export { isVerbatimNativeLine, countVerbatimNativeLines } from './types';
