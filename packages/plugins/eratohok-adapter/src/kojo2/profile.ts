/**
 * eratohoK 2.0 profile（游戏事实 —— 只住本包）。
 *
 * 全部数值 = 2026-10-26 `D:/Game/eratohok` 真盘读数：全树 2,482 份 `.ERB` +
 * 146 份 `.ERH`（合计 2,628 份源文件；头注「2628」是这一总量），口上域
 * `ERB/口上` 694 份 `.ERB` 另计。**没有一条抄 eraTW / eraFL / eraSQC**：
 * 取色 / 等待 / 随机 / 循环的占比逐项来自本作自己的盘面。
 *
 * 口径：设计稿 §10.2。profile 的值是 adapter 缺省，project/file profile 可覆盖。
 */
import type { AdapterProfile } from '@kojo/kojo-core';

export const ERATOHOK_PROFILE: AdapterProfile = Object.freeze({
  // 口上域 `SETCOLOR` 661 处 / `RESETCOLOR` 816 处（2026-10-26 读数）⇒ 作者自订色
  // 是真实在用的语言面，取色策略不替作者锁默认色。
  narrationColor: 'author',
  dialogueColor: 'author',
  // W 系打印等待：口上域 `PRINTFORMW` 169,082 处——等待是主流写法。
  waitDefault: 'wait',
  // D 系打印可用：口上域**独立** `PRINTFORMD` 3 处（不是 D+L 变体 `PRINTFORMDL`：
  // 本作 `PRINTFORMDL` 0 处，不能按子串把两者混记）。D 系忽略 SETCOLOR，
  // 上色必须落非 D 变体（引擎事实，由 backend 遵守）。
  colorMode: 'D',
  // `# 池` 缺省落 IF/ELSEIF/ELSE——本作口上以分支链为主，没有 SELECTCASE 优化承诺。
  poolStyle: 'if',
  // `@随机` 单行纯文本候选落 PRINTDATAL（口上域 469 处 > PRINTDATA 284 处）。
  randStyle: 'printdatal',
  // 细粒度开关逐项对应 `program.ts`（任何一项开而这里没列 ⇒ 装载自检 inconsistent）：
  //   functions：`CALL` 全树 32,167 / 口上 6,029；loops：`FOR` 全树 3,885 / 口上 130、
  //   `WHILE` 48；arrays：`#DIMS` 3,468；goto：`GOTO` 777；repeat：`REPEAT` 14。
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
