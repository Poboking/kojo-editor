/**
 * eraAV 2.0 profile（游戏事实 —— 只住本包）。
 *
 * 全部数值 = 2026-10-26 `C:/game/eraAV` 真盘读数（受管 `ERB/` 468 份 `.ERB` + 3 份 `.ERH`；
 * 口上域 `ERB/Lines/` 17 份另计）。**没有一条抄 eraTW / eratohok / eraSQC**：取色 / 等待 /
 * 随机 / 循环的占比逐项来自本作自己的盘面。
 *
 * 口径：设计稿 §10.2。profile 的值是 adapter 缺省，project/file profile 可覆盖。
 */
import type { AdapterProfile } from '@kojo/kojo-core';

export const ERAAV_PROFILE: AdapterProfile = Object.freeze({
  // 口上域 `SETCOLOR` 0 处 / `RESETCOLOR` 0 处（2026-10-26 读数）⇒ 本作口上作者不订色，
  // 取色策略按引擎默认走（全树 SETCOLOR 590 处都在口上域外的系统侧）。
  narrationColor: 'default',
  dialogueColor: 'default',
  // W 系打印等待：口上域 `PRINTFORMW` 7,612 处——等待是绝对主流写法。
  waitDefault: 'wait',
  // D 系打印全树 0 处（`PRINTFORMD` 0 / `PRINTFORMDL` 0，不是 DL 变体子串混记）。
  colorMode: 'plain',
  // `# 池` 缺省落 IF/ELSEIF/ELSE——本作口上以分支链为主。
  poolStyle: 'if',
  // `@随机` 落 SELECTCASE：全树 `PRINTDATA`/`PRINTDATAL` 均 0 处，而 `SELECTCASE`
  // 全树 19 处（口上域 0）——DATAL 族零实证，选有实证的那条通道。
  randStyle: 'rand-selectcase',
  // 细粒度开关逐项对应 `program.ts`（任何一项开而这里没列 ⇒ 装载自检 inconsistent）：
  //   functions：`CALL` 全树 2,630 / 口上 51；loops：`GOTO` 全树 1,007 / 口上 3、
  //   `WHILE` 9；arrays：`#DIMS` 9；repeat：`REPEAT` 516。
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
