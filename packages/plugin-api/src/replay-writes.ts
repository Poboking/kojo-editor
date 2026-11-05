/**
 * 回放的「未建模写」事实（2026-11-05 状态回放可用性批；additive）。
 *
 * 回放只按**函数入口时刻的存档**求值，不执行函数体里对游戏状态的写
 * （`CFLAG:2 += 10` / `SETBIT` / `INPUT` 之后的 `RESULT` 等）。
 * 这类写的存在会让「入口值判出来的结论」与真实运行结果不同形——所以引擎把
 * **写点行**交回给消费方，由面板给结论打「近似」标记，而不是让作者自己猜。
 *
 * 本文件**只放类型**（零值导出）：它经 `@kojo/plugin-api` 的 `export type` 面
 * 对外，`import type` 会被擦除，所以不把文件拽进开机图（PS-10 字节闸）。
 * 判据（哪些行算未建模写）住插件侧（`state-replay`），契约只描述事实形状。
 */
/**
 * 一条写点事实的**类别**（2026-11-05 边界批；additive）：
 * - `assign`：变量族赋值（`CFLAG:2 += 1` / `TFLAG' = 1` …）——写点确定，值算不出；
 * - `instruction`：引擎写指令（`SETBIT` / `INPUT` / `VARSET` / `EQUIP` …）；
 * - `call`：函数调用行（`CALL` / `CALLFORM` / `TRYCALL*`）——**被调段可能写状态**，
 *   本层不展开（跨函数传播不在近似回放的射程内）；`text` 是调用行原文；
 * - `jump`：`GOTO` / `JUMP` ——**可达性未建模**（跳转后的写点/早退是否执行，
 *   静态判不出）；只在"该函数里确实有需要判可达性的写/返回"时才报，避免刷屏。
 *
 * 消费方按类别分桶呈现（确定写点 vs 不确定面），不要把 `call` / `jump` 说成
 * "这行写了状态"。
 */
export type ReplayWriteKind = 'assign' | 'instruction' | 'call' | 'jump';

export interface ReplayWrite {
  /** 写点行（1 基，与 `PredicateReplay.line` 同坐标系） */
  line: number;
  /** 该行原文（去行内注释；给作者定位用，不做二次解析） */
  text: string;
  /** 类别（缺省 = `assign`，旧数据兼容） */
  kind?: ReplayWriteKind;
  /**
   * 仅 `kind === 'call'`：**静态可解析**的被调函数名（`CALL FOO(...)` 的 `FOO`）。
   * 动态调用（`CALLFORM` / 实参拼出来的目标）没有这个字段 ⇒ 目标不可知。
   */
  target?: string;
  /**
   * 仅 `kind === 'call'` 且 `target` 可解析时：**被调段里可证明的写点数**（引擎做跨函数
   * 传播：**最多两层**——被调段自身的 assign/instruction + 它自己的静态调用目标里的写；
   * 用环检测与"每次回放 30 个被调函数"预算封顶）。缺省 = 没查/查不到/超预算（**不可当成 0**）；
   * `0` = 查过、被调段（含其一层嵌套调用）没有可证明的写。消费方据此把"这行调用会写状态"
   * 与"这行调用可能写"分开说。
   */
  calleeWrites?: number;
}
