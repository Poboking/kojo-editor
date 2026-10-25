/**
 * eraAkumaMaid 2.0 演出面（游戏事实 —— 只住本包）。
 *
 * **无真盘 · 证据等级 B**：2026-10-26 实测 `C:/game/eraAkumaMaid` 与
 * `D:/Game/eraAkumaMaid` 均不存在，本文件**不含任何真盘计数**；依据 = v1 源码
 * 的 `file:line`（`face-templates.ts`）。
 *
 * | 面 | 裁决 | 依据 |
 * | --- | --- | --- |
 * | 心形 | **null** | v1 源码无「四象限心形打印函数」证据 ⇒ 不声明 |
 * | 着色 | **声明** | 口上域 `SETCOLOR` 316 行（`face-templates.ts:282`）；`RESETCOLOR` / `0x` 按 Emuera 引擎口径（**无盘不单独计数**） |
 * | 颜绘 | **null** | v1 `face-templates.ts` 是「时机分野」模板，不给引擎调用与接收者实参；`MAIDFACE_K{n}` 是角色私有表情函数，不是通用 `@颜绘` 落点 |
 * | 选项 | **null** | AM 的选择 UI 是自定义 `@PRINT_SELECT`（`face-templates.ts:289` 引 `ERB/TRAIN/FUNCTION.ERB:273`），不是 PRINTBUTTON / INPUTS 落点 |
 *
 * 不声明 ≠ 忘了：`checkPresentation` 对未声明面报「当前 adapter 不支持」，
 * 这正是**可见降级**。声明一个没有落点的面才是撒谎（backend 会发射出不存在的指令）。
 */
import type { AdapterPresentation } from '@kojo/kojo-core';

export const ERAAKUMAMAID_PRESENTATION: AdapterPresentation = Object.freeze({
  heart: null,
  color: Object.freeze({
    setColor: 'SETCOLOR',
    resetColor: 'RESETCOLOR',
    hexPrefix: '0x',
  }),
  face: null,
  options: null,
});
