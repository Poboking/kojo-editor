/**
 * era紅魔館 2.0 profile（游戏事实 —— 只住本包）。
 *
 * **证据 = 2026-10-26 `D:/Game/eraKoumakan` 真盘读数**（全部数值）：全树 403 份 `.ERB`
 * （`ERB/` 子树，含口上 64 份）+ 5 份 `.ERH`；口上域 `ERB/口上` 单独计数。
 * 没有一条从 eraTW / eraFL / eraTohoK 抄 —— 本作与它们最刺眼的差异就是
 * 「作者根本不取色」，照抄 `author` 会凭空要求糖层产出一条没人写过的着色指令。
 *
 * 口径：设计稿 §10.2。profile 是 adapter 缺省，project / file profile 可覆盖。
 */
import type { AdapterProfile } from '@kojo/kojo-core';

export const ERAKOUMAKAN_PROFILE: AdapterProfile = Object.freeze({
  // 口上域 `SETCOLOR` 0 处 / `RESETCOLOR` 0 处 ⇒ 两轴都落 'default'（不替作者锁色）。
  narrationColor: 'default',
  dialogueColor: 'default',
  // W 系打印是主流：口上域 `PRINTFORMW` 5,182 处。
  waitDefault: 'wait',
  // D 系不可用：全树与口上域独立 `PRINTFORMD` 均 0 处（本作没有 D 系打印变体）。
  colorMode: 'plain',
  // `# 池` 缺省落 IF/ELSEIF/ELSE：本作没有 SELECTCASE 优化承诺。
  poolStyle: 'if',
  // `@随机` 单行纯文本候选落 PRINTDATAL：口上域 3,782 处，独立 `PRINTDATA` 仅 239 处。
  randStyle: 'printdatal',
  /*
   * 细粒度开关逐项对应 `program.ts`（开而这里没列 ⇒ 装载自检 inconsistent）：
   * `CALL` 全树 34,520（子串口径，含 CALLFORM 一族）、`FOR` 57,363（同口径，含 FORM
   * 一族）；语句级实证：`WHILE` 31 / `#DIMS` 259 / `GOTO` 416 / `REPEAT` 31。
   * recursion / foreach **不在列**：本作零实证（见 program.ts 逐项裁决）。
   */
  features: Object.freeze([
    'program',
    'functions',
    'loops',
    'arrays',
    'goto',
    'repeat',
  ] as const),
});
