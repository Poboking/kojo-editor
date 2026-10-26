/**
 * eratohoReverse 2.0 profile（游戏事实 —— 只住本包）。
 *
 * 全部数值 = 2026-10-26 `C:/game/eratohoReverse` 真盘读数（受管 `ERB/` 890 份
 * `.ERB` + 17 份 `.ERH`；口上域 `ERB/口上/` 633 份另计）。**没有一条抄
 * eraTW / eratohok / eraSQC**：取色 / 等待 / 随机 / 循环的占比逐项来自本作自己的盘面。
 *
 * 口径：设计稿 §10.2。profile 的值是 adapter 缺省，project/file profile 可覆盖。
 */
import type { AdapterProfile } from '@kojo/kojo-core';

export const ERATOHOREVERSE_PROFILE: AdapterProfile = Object.freeze({
  // 口上域 `SETCOLOR` 425 处 / `RESETCOLOR` 60 处（2026-10-26 读数）⇒ 作者自订色
  // 是真实在用的语言面，取色策略不替作者锁默认色。
  narrationColor: 'author',
  dialogueColor: 'author',
  // W 系打印等待：口上域 `PRINTFORMW` 67,984 处——等待是绝对主流写法。
  waitDefault: 'wait',
  // D 系打印可用：口上域**独立** `PRINTFORMD` 223 处（另有 DL 变体 `PRINTFORMDL`
  // 1,866 处，两者分开数、不按子串混记）。D 系忽略 SETCOLOR，上色必须落非 D
  // 变体（引擎事实，由 backend 遵守）。
  colorMode: 'D',
  // `# 池` 缺省落 IF/ELSEIF/ELSE——`PRINTDATA` 族全树只有 3 处（PRINTDATA 2 /
  // PRINTDATAL 1），池语法在本作近乎不存在，不存在 SELECTCASE 优化承诺。
  poolStyle: 'if',
  // `@随机` 单行纯文本候选落 PRINTDATA（全树 2 处 > PRINTDATAL 1 处；两者都少，
  // 按多数落 printdata，不抄 eratohok 的 printdatal）。
  randStyle: 'printdata',
  // 细粒度开关逐项对应 `program.ts`（任何一项开而这里没列 ⇒ 装载自检 inconsistent）：
  //   functions：`CALL` 全树 25,379 / 口上 19,655；loops：`FOR` 全树 275 / 口上 13、
  //   `WHILE` 25；arrays：`#DIMS` 306；goto：`GOTO` 276；repeat：`REPEAT` 5。
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
