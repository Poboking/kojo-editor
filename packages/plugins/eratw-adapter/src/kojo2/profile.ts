/**
 * eraTW 2.0 profile（游戏事实 —— 只住本包）。
 *
 * 口径：设计稿 §10.2 / 附录 B.4。profile 的值是 **adapter 缺省**，project/file
 * profile 可以覆盖；core 不内置任何一条。
 *
 * 覆盖怎么进落点（K2-ADAPTER-PROFILE）：`profile-resolve.ts::resolveEratwProfile()`
 * （纯函数，三层：本文件的缺省 → `adapterProfile` 声明映射 → 调用方生效覆盖），
 * backend 在工厂里合成一次并冻进实例。本文件**只放缺省值**，不放覆盖逻辑。
 *
 * 证据：
 * - `narrationColor` / `dialogueColor`：旧 `旁白色` / `口上色` 迁到这里（§4.7）；
 *   eraTW 缺省按"作者色"，由工程 profile 决定实际取色。
 * - `colorMode: 'D'`：语料里 `PRINTFORMDW` / `PRINTFORMDL` 一类 D 系打印可用；
 *   但 D 系忽略 `SETCOLOR`，自机台词必须落非 D 变体（v1 codegen 同口径）。
 * - `waitDefault: 'wait'`：eraTW 的 W 系打印等待；无 `续` 时按它。
 * - `poolStyle: 'if'`：`# 池` 落 `IF / ELSEIF / ELSE`（B.5）；`selectcase` 只是
 *   等值优化，由编译器按 §7.1 条件决定。
 * - `randStyle: 'printdata'`：`@随机` 的单行纯文本候选落 `PRINTDATA / DATAFORM`；
 *   多行/副作用候选由编译器强制 `rand-selectcase`（§8.4）。
 */
import type { AdapterProfile } from '../../../../kojo-core/src/adapter.js';

export const ERATW_PROFILE: AdapterProfile = Object.freeze({
  narrationColor: 'author',
  dialogueColor: 'author',
  waitDefault: 'wait',
  colorMode: 'D',
  poolStyle: 'if',
  randStyle: 'printdata',
  // eraTW 默认全开 program 层（§9.1：eraTW adapter 默认全部开启并纳入验收线）
  features: Object.freeze([
    'program',
    'functions',
    'loops',
    'arrays',
    'goto',
    'recursion',
    'foreach',
    'repeat',
  ] as const),
});
