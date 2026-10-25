/**
 * eraSQC 2.0 profile（游戏事实 —— 只住本包）。
 *
 * 全部数值 = 2026-10-26 `D:/Game/eraSQC` 真盘读数（351 份 `.ERB` 全树；
 * 口上域 `ERB/EVENT_K` 111 份另计）。**没有一条抄 eraTW / eraFL**：
 * 本作是简体汉化魔改版（`_返`），打印/取色/循环的占比与两作都不同。
 *
 * 口径：设计稿 §10.2。profile 的值是 adapter 缺省，project/file profile 可覆盖。
 */
import type { AdapterProfile } from '@kojo/kojo-core';

export const ERASQC_PROFILE: AdapterProfile = Object.freeze({
  // 口上域 `SETCOLOR` 135 处 / `RESETCOLOR` 130 处（全树 519 / 431）⇒ 作者自订色
  // 是真实在用的语言面，取色策略不替作者锁默认色。
  narrationColor: 'author',
  dialogueColor: 'author',
  // W 系打印等待：`PRINTFORMW` 全树 220,649 处（口上域 213,542）。
  waitDefault: 'wait',
  // D 系打印可用：D+L 变体 `PRINTFORMDL` 55 处（独立 `PRINTFORMD` 0——不能按
  // 子串计数把 D+L 误记成 D，故这里按「D 系实形存在」判定）。
  // D 系忽略 SETCOLOR：上色必须落非 D 变体（引擎事实，由 backend 遵守）。
  colorMode: 'D',
  // `# 池` 缺省落 IF/ELSEIF/ELSE；语料 `SELECTCASE` 3,416 处只是等值优化（§7.1），
  // 不是 profile 开关。
  poolStyle: 'if',
  // `@随机` 单行纯文本候选落 PRINTDATA（12 处；PRINTDATAL 6 处为次形）。
  randStyle: 'printdata',
  // 细粒度开关逐项对应 `program.ts`（任何一项开而这里没列 ⇒ 装载自检 inconsistent）：
  //   functions：CALL 133,008 · loops：FOR 256,669 / WHILE 7 · arrays：`#DIMS` 96 ·
  //   goto：GOTO 247 · repeat：REPEAT 31。
  // recursion / foreach **不在列**：本作零实证（见 program.ts 逐项裁决）。
  features: Object.freeze([
    'program',
    'functions',
    'loops',
    'arrays',
    'goto',
    'repeat',
  ] as const),
});
