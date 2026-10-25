/**
 * eraSQC 时机分野模板表（游戏知识 —— 只住本包）。
 *
 * 表层 DSL 的 `时机 <分野> <编号>：` 里作者只写分野关键字；「关键字 → 函数名」的映射
 * 是游戏知识，由本包以 `KojoFaceTable` 暴露给转译器（`kojo-sugar` 只消费不解释）。
 *
 * ## 证据（全部来自 `C:/game/eraSQC` 真盘路由 `ERB/EVENT_K/EVENT_K.ERB`）
 *
 * ```
 * :30   TRYCALLFORM KOJO_MESSAGE_COM_{NO:TARGET}_{CFLAG:209}
 * :86   TRYCALLFORM KOJO_MESSAGE_BEFORE_COM_{NO:TARGET}_{CFLAG:209}
 * :110  TRYCALLFORM KOJO_MESSAGE_AFTER_COM_{NO:TARGET}_{CFLAG:209}
 * :133  TRYCALLFORM KOJO_MESSAGE_PALAMCNG_{NO:TARGET}_{CFLAG:209}, LOCALS
 * :441  TRYCALLFORM COUNTER_KOJO_{NO:TARGET}_{CFLAG:209}, ARGS
 * :467  TRYCALLFORM KOJO_MESSAGE_MARKCNG_{NO:TARGET}_{CFLAG:209}, ARGS
 * :399  TRYCALLFORM KOJO_MESSAGE_SAMEN_AND_EXTACY_{NO:TARGET}_{CFLAG:209}
 * :422  TRYCALLFORM KOJO_MESSAGE_SHOOT_{NO:TARGET}_{CFLAG:209}
 * :513  TRYCALLFORM SELF_KOJO_K{NO:TARGET}_{CFLAG:209}, ARGS
 * :555  TRYCALLFORM DAILY_LIFE_DAYEV_{NO:TARGET}_{CFLAG:209}
 * :560  TRYCALLFORM DAILY_LIFE_MESSAGE_{NO:TARGET}_{CFLAG:209}
 * :568  TRYCALLFORM SINGLE_ENDING_K{NO:TARGET}_{CFLAG:209}
 * :72   TRYCALLFORM IS_SINGLE_ENDING_K{NO:ARG}_{CFLAG:ARG:209}（ENDING.ERB）
 * ```
 *
 * ## 尾号的口径（本表最容易写错的一格）
 *
 * `{i}` 在本作**不是指令号、不是事件号**，而是 `CFLAG:209` **口上模式**
 * （`EVENTTRAIN` 里逐角色让玩家选择 1/2/3…，`EVENT_K.ERB:577` 起）。
 * 指令号在函数体内 `IF SELECTCOM == n` 分派 ⇒ 所有面声明 `indexKind: 'literal'`，
 * 不查任何表；`instructionFaces` 也为空（见 `family-index.ts`）。
 *
 * 作者写 `时机 指令 2：` 表示「口上模式 2 的指令口上」；省略编号会被转译器拒绝
 * （模板含 `{i}` 且未声明 `autoIndex`），**不会静默生成一个引擎从不调用的名字**。
 *
 * ## 不收录的面（宁缺毋滥）
 *
 * `KOJO_EVENT_EXSTART_{no}_{n}` / `KOJO_AEGI_{no}_{n}_{m}` 一类场景辅助口上尾段
 * 是作者自定义的场景号，没有引擎键值语义，也不在 EVENT_K 主路由里 —— 继续用原生
 * ERB 写，不提供降糖模板。
 */
import type { KojoFaceTable } from '@kojo/plugin-api';

/** 构建 eraSQC 分野表（冻结纯数据，无 IO）。 */
export function createErasqcFaceTable(): KojoFaceTable {
  return {
    // 全表同一口径：尾号 = CFLAG:209 口上模式（不是指令号 / 事件号）
    slotSemantics: {
      index: {
        label: 'CFLAG:209 口上模式',
        detail: 'EVENTTRAIN 里逐角色选择的模式号，不是指令号',
      },
    },
    faces: {
      指令: { template: 'KOJO_MESSAGE_COM_{n}_{i}', indexKind: 'literal' },
      指令前: { template: 'KOJO_MESSAGE_BEFORE_COM_{n}_{i}', indexKind: 'literal' },
      指令后: { template: 'KOJO_MESSAGE_AFTER_COM_{n}_{i}', indexKind: 'literal' },
      参数变动: { template: 'KOJO_MESSAGE_PALAMCNG_{n}_{i}', indexKind: 'literal' },
      刻印: { template: 'KOJO_MESSAGE_MARKCNG_{n}_{i}', indexKind: 'literal' },
      射精: { template: 'KOJO_MESSAGE_SHOOT_{n}_{i}', indexKind: 'literal' },
      射精与绝顶: { template: 'KOJO_MESSAGE_SAMEN_AND_EXTACY_{n}_{i}', indexKind: 'literal' },
      口枷: { template: 'KOJO_MESSAGE_GAG_{n}_{i}', indexKind: 'literal' },
      口枷前: { template: 'KOJO_MESSAGE_BEFORE_GAG_{n}_{i}', indexKind: 'literal' },
      独白: { template: 'SELF_KOJO_K{n}_{i}', indexKind: 'literal' },
      客人: { template: 'GUEST_KOJO_K{n}_{i}', indexKind: 'literal' },
      计数器: { template: 'COUNTER_KOJO_{n}_{i}', indexKind: 'literal' },
      单结局: { template: 'SINGLE_ENDING_K{n}_{i}', indexKind: 'literal' },
      单结局判定: { template: 'IS_SINGLE_ENDING_K{n}_{i}', indexKind: 'literal' },
      日常对话: { template: 'DAILY_LIFE_MESSAGE_{n}_{i}', indexKind: 'literal' },
      日常事件: { template: 'DAILY_LIFE_DAYEV_{n}_{i}', indexKind: 'literal' },
      恋慕分支: { template: 'K{n}_KOJO2_{i}', indexKind: 'literal' },
    },
  };
}
