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
export interface ReplayWrite {
  /** 写点行（1 基，与 `PredicateReplay.line` 同坐标系） */
  line: number;
  /** 该行原文（去行内注释；给作者定位用，不做二次解析） */
  text: string;
}
