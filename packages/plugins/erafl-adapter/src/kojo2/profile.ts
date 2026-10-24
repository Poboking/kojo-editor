/**
 * eraFL 2.0 profile（游戏事实 —— 只住本包）。
 *
 * 口径：契约 §10.2。profile 的值是 **adapter 缺省**，project/file profile 可以
 * 覆盖；core 不内置任何一条。
 *
 * 证据（2026-10-24，D:/Game/erafl）：
 * - `colorMode: 'D'`：D 系打印（`PRINTFORMD` 一族）全树 481 处在用 ⇒ D 变体可用；
 *   但 D 系忽略 `SETCOLOR`，上色必须走非 D 变体（v1 codegen 同口径）。
 * - `waitDefault: 'wait'`：Emuera W 系打印等待；无 `续` 时按它（引擎通用缺省）。
 * - `narrationColor` / `dialogueColor`：eraFL 的取色事实在 **XML 属性**里
 *   （`kojoPlace` / `priority` / `emotion` 一族，见 v1 `preview/conditions.ts`
 *   的白名单），ERB 语句层没有作者色可声明 ⇒ 按"作者色"缺省，由工程侧决定。
 * - `poolStyle: 'if'` / `randStyle: 'printdata'`：Emuera 通用落点缺省
 *   （eraTW 同口径）；eraFL 的 `# 池` / `@随机` 语料为零，落点形状后续批核。
 *
 * `features` 与 `programFeatures` 必须自洽（契约自检：任一程序层开关为 true 时
 * `program` 必须在列）——eraFL 六项里 `foreach` 关闭（无 `@巡` 语料），故不列。
 */
import type { AdapterProfile } from '@kojo/kojo-core';

export const ERAFL_PROFILE: AdapterProfile = Object.freeze({
  narrationColor: 'author',
  dialogueColor: 'author',
  waitDefault: 'wait',
  colorMode: 'D',
  poolStyle: 'if',
  randStyle: 'printdata',
  features: Object.freeze([
    'program',
    'functions',
    'loops',
    'arrays',
    'goto',
    'recursion',
    'repeat',
  ] as const),
});
