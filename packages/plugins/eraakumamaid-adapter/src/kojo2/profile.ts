/**
 * eraAkumaMaid 2.0 profile（游戏事实 —— 只住本包）。
 *
 * **无真盘 · 证据等级 B**：2026-10-26 实测 `C:/game/eraAkumaMaid` 与
 * `D:/Game/eraAkumaMaid` 均不存在，本文件**不含任何真盘计数**；全部依据 =
 * v1 源码的 `file:line` 与测试夹具（`conventions.test.ts`）。换盘 / 换魔改后
 * 这些缺省值应按新盘复核，不当作永久事实。
 *
 * 口径：profile 是 adapter 缺省，project / file profile 可覆盖。
 */
import type { AdapterProfile } from '@kojo/kojo-core';

export const ERAAKUMAMAID_PROFILE: AdapterProfile = Object.freeze({
  // 口上域 `SETCOLOR` 316 行（`face-templates.ts:282`）：作者自己取色，且取的是
  // 角色气氛色 / `DEF_COLOR` 组合 ⇒ 旁白与台词两轴都落 'author'，不替作者锁默认色。
  narrationColor: 'author',
  dialogueColor: 'author',
  // W 系打印是本作真实形态：`conventions.test.ts:193` 的真实语料模板行即 `PRINTFORMDW`。
  waitDefault: 'wait',
  // D 系打印可用：同一夹具（`PRINTFORMDW`）是 D + W 组合写法。
  colorMode: 'D',
  // `face-templates.ts:20-21`「事件 / 计数器」函数体 `SELECTCASE ARGS` 分派、
  // 指令在单函数内 `IF SELECTCOM == n` 分派；`conventions.test.ts:249-250`
  // 明写「AM 主流形态：单函数 + SELECTCASE」⇒ 池缺省走 SELECTCASE。
  poolStyle: 'selectcase',
  /*
   * 随机文本走基础库 `TEXTR`（`library-table.ts:91`，口上域 9,920 调用点），
   * **无 `PRINTDATA` 语料实证**（本包 v1 源码里没有独立的 PRINTDATA/PRINTDATAL 计数）。
   * 三选一里取引擎通用缺省 `printdata`：这是**引擎口径的缺省**，不声称语料实证。
   */
  randStyle: 'printdata',
  /*
   * 细粒度开关逐项对应 `program.ts`（开而这里没列 ⇒ 装载自检 inconsistent）：
   * arrays / while / goto / repeat 开，recursion / foreach 关。
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
