/**
 * era紅魔館 2.0 演出面（游戏事实 —— 只住本包）。
 *
 * **四项全 null** —— 这是本作与 eraTohoK / eraTW 最大的差异，逐面都有盘面裁决
 * （证据 = 2026-10-26 `D:/Game/eraKoumakan` 真盘读数）：
 *
 * | 面 | 裁决 | 依据 |
 * | --- | --- | --- |
 * | 心形 | **null** | 唯一 `HEART` 名函数 `MSG_HEART @ ERB/MSG_FUNC.ERB:7` 是 `#FUNCTIONS` 字符串函数 `RETURNF UNICODE(0x2764)`，不是四象限心形打印族；`CHK_HEART_BREAK_CLEAR @ ERB/EVENTTURNEND.ERB:482` 是判定函数 |
 * | 着色 | **null** | 口上域 `SETCOLOR` 0 / `RESETCOLOR` 0（规则：仅口上域 >0 才声明） |
 * | 颜绘 | **null** | v1 `face-templates.ts` 是「时机分野」模板，不给引擎调用与接收者实参 |
 * | 选项 | **null** | 口上域 `PRINTBUTTON` 0 / `INPUTS` 0（全树 40 / 7 只出现在核心，不构成作者落点） |
 *
 * 不声明 ≠ 忘了：`checkPresentation` 对未声明面报「当前 adapter 不支持」，
 * 这正是**可见降级**。声明一个没有落点的面才是撒谎（backend 会发射出不存在的指令）。
 */
import type { AdapterPresentation } from '@kojo/kojo-core';

export const ERAKOUMAKAN_PRESENTATION: AdapterPresentation = Object.freeze({
  heart: null,
  color: null,
  face: null,
  options: null,
});
