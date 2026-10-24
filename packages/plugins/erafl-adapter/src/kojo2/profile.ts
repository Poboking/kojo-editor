/**
 * eraFL 2.0 profile（游戏事实 —— 只住本包）。
 *
 * 口径：设计稿 §10.2。profile 的值是 **adapter 缺省**，project/file profile
 * 可以覆盖；core 不内置任何一条。
 *
 * **交接文档说"可按 Emuera 缺省、取色/等待在 XML 属性里"——真盘读数修正了这个
 * 假设**：eraFL 的 ERB 壳函数里 `SETCOLOR` 1,932 处（口上域 134 处）、
 * `RESETCOLOR` 841 处、`PRINTFORMD` 481 处、`PRINTFORMW`（与 D 合计）24,047 处。
 * 取色与等待在 ERB 侧是真实在用的语言面，按实测声明，不按假设。
 *
 * 全部数值 = 2026-10-24 `D:/Game/erafl` 真盘读数。
 */
import type { AdapterProfile } from '@kojo/kojo-core';

export const ERAFL_PROFILE: AdapterProfile = Object.freeze({
  // 作者色：语料里作者大量使用 SETCOLOR 自订色（1,932 处）⇒ 取色策略不能
  // 替作者锁"默认色"（§4.7 明确不默认默认色）。
  narrationColor: 'author',
  dialogueColor: 'author',
  // W 系打印等待：PRINTFORMW 系 24,047 处，无 `续` 时按等待。
  waitDefault: 'wait',
  // D 系打印可用（PRINTFORMD 481 处）；但 D 系忽略 SETCOLOR，自机台词必须落
  // 非 D 变体（与 eraTW v1 codegen 同口径——这是引擎事实，不是 eraTW 私有）。
  colorMode: 'D',
  // `# 池` 缺省落 IF/ELSEIF/ELSE；语料 SELECTCASE 3,087 处证明引擎侧等值分派
  // 可用，但 selectcase 只是编译器在等值可证时的优化（§7.1），不是 profile 开关。
  poolStyle: 'if',
  // `@随机` 的单行纯文本候选落 PRINTDATA/DATAFORM（语料 404 处）；
  // 多行/副作用候选由编译器强制 rand-selectcase（§8.4）。
  randStyle: 'printdata',
  // extension 白名单：只列 eraFL 实测在用的程序层面（与 `program.ts` 的细粒度
  // 开关逐项对应，任何一项开而这里没列 ⇒ 装载自检 inconsistent）：
  //   program（细粒度有开）· functions（CALL 遍地）· loops（FOR 2,357 /
  //   WHILE 123）· arrays（`#DIMS SAVEDATA …, 尺寸` 数组声明形，variable-schema
  //   实测收编）· goto（77 处）· repeat（4 处）。
  // recursion / foreach **不在列**：无实证（见 `program.ts` 逐项裁决）。
  features: Object.freeze([
    'program',
    'functions',
    'loops',
    'arrays',
    'goto',
    'repeat',
  ] as const),
});
