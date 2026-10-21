/**
 * eraTW `# 表` 等值分派的**引擎块数据**（游戏/引擎事实 —— 只住 adapter）。
 *
 * 权威依据：设计稿 §6.3（"落点不是新运行时：优先等值分派或 IF 链"）、§16.2 C2.5，
 * 以及语料实证（eraTW 口上 46,446 个分派块，主力形态就是"判别式 + CASE 值档 + 兜底档"）。
 *
 * 为什么不写进 `presentation.ts`：那张表是**演出面**（心形/着色/颜绘/选项），
 * 表分派是**程序层块语法**，生命周期与消费方都不同（只有 `table-emit.ts` 读它）。
 * 为什么单独一份而不是散写在 emitter 里：`table-emit.ts` 是唯一的使用方，
 * 但字面量集中在这里，本包任何地方都不许再写第二份（换引擎只改本文件）。
 *
 * 纯数据、深冻结、零 IO。
 */

/** 等值分派的块形状（引擎关键字 + 排版事实） */
export interface TableDispatchPresentation {
  /** 块头（判别式跟在后面） */
  readonly selectCase: string;
  /** 一档（值跟在后面） */
  readonly case: string;
  /** 兜底档（不带值） */
  readonly caseElse: string;
  /** 块尾 */
  readonly endSelect: string;
  /** 一级缩进（档头一层、档内正文再一层） */
  readonly indent: string;
  /**
   * 计划**没有** `否` 臂时怎么收尾：
   * - `omit`：不写兜底档（少两行，语义等价——没有兜底就没有兜底分支）；
   * - `empty`：写一个空兜底档（显式留位，便于作者/工具后补）。
   * eraTW 取 `omit`（语料主流，空 `CASE ELSE` 只会白占一行）。
   */
  readonly missingDefault: 'omit' | 'empty';
}

/** eraTW 的等值分派块数据（module 装载时冻结一次） */
export const ERATW_TABLE_DISPATCH: TableDispatchPresentation = Object.freeze({
  selectCase: 'SELECTCASE',
  case: 'CASE',
  caseElse: 'CASE ELSE',
  endSelect: 'ENDSELECT',
  indent: '    ',
  missingDefault: 'omit',
});
