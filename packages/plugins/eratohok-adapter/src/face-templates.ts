/**
 * eratohoK 时机分野模板表（游戏知识 —— 只住本包）。
 *
 * 表层 DSL 的 `时机 <分野> [编号]：` 里作者只写分野关键字；「关键字 → 函数名」的映射
 * 是游戏知识，由本包以 `KojoFaceTable` 暴露给转译器（`kojo-sugar` 只消费不解释）。
 *
 * ## 证据（全部来自 `ERB/口上/_KOJO_SYSTEM.ERB` 的真盘路由，114 条 CALLFORM）
 *
 * ```
 * :120  TRYCALLFORM KOJO_TRAIN_START_K{LOCAL:5}                     → 训练开始
 * :153  TRYCALLFORM KOJO_TRAIN_END_K{LOCAL:5}                       → 训练结束
 * :80   TRYCCALLFORM KOJO_EXIST_K{ARG:0}                            → 存在判定
 * :193  TRYCALLFORM KOJO_COM_BEFORE_K{LOCAL:5}                      → 指令前
 * :196  TRYCALLFORM KOJO_COM_BEFORE_TARGET_K{LOCAL:5}               → 指令前·对象侧
 * :377  TRYCALLFORM KOJO_COM_K{LOCAL:5}                             → 指令
 * :380  TRYCALLFORM KOJO_COM_TARGET_K{LOCAL:5}                      → 指令·对象侧
 * :561  TRYCALLFORM KOJO_COM_AFTER_K{LOCAL:5}                       → 指令后
 * :740  TRYCALLFORM KOJO_EVENT_K{LOCAL:5}(ARG:1)                    → 事件
 * :774  TRYCALLFORM KOJO_SINGLE_ENDING_K{LOCAL:5}                   → 单结局
 * :803  TRYCALLFORM KOJO_DEAD_ENDING_K{LOCAL:5}                     → 死亡结局
 * ```
 *
 * ## 关键差异：**没有「一条指令一个函数」的模板**
 *
 * 分派器只按目标号拼 `KOJO_COM_K{n}`，具体指令在函数体内用 `SELECTCASE SELECTCOM`
 * 展开（真盘 `KOJO_COM` 面 75 处、`KOJO_COM_TARGET` 109 处，都不是按指令号铺开的）
 * ⇒ 本表所有 face 的模板**只带 `{n}`**，不声明 `instructionFaces`。
 * 作者写 `时机 指令 300：` 会被糖层按「该面不吃编号」报错，而不是生成一个引擎从不
 * 调用的 `KOJO_COM_K1_300`——**fail-closed 优于看起来对**。
 *
 * ## 不收录的面（宁缺毋滥）
 *
 * `KOJO_DAILY_K{n}_{事件名}` 的编号位是**事件名**（`NAUGHTY_MAIDEN` 这类字符串），
 * 不是整数序号，且同一事件还有 `_RATE` / `_DECISION` / `_GENRE` 四件套；
 * `KOJO_*_%KOJO_STATE()%_K{n}` 的状态段（A1…D）由运行时 `FLAG:調教モード` 决定；
 * `_{CFLAG:(n):2999}` 的尾段是**每角色口上号**。这三族的名字都不是单模板能生成的，
 * 继续用原生 ERB 写。
 */

import type { KojoFaceTable } from '@kojo/plugin-api';

/** 构建 eratohoK 分野表（冻结纯数据，无 IO）。 */
export function createTohokFaceTable(): KojoFaceTable {
  return {
    faces: {
      训练开始: { template: 'KOJO_TRAIN_START_K{n}' },
      训练结束: { template: 'KOJO_TRAIN_END_K{n}' },
      存在判定: { template: 'KOJO_EXIST_K{n}' },
      指令前: { template: 'KOJO_COM_BEFORE_K{n}' },
      指令前对象: { template: 'KOJO_COM_BEFORE_TARGET_K{n}' },
      指令: { template: 'KOJO_COM_K{n}' },
      指令对象: { template: 'KOJO_COM_TARGET_K{n}' },
      指令后: { template: 'KOJO_COM_AFTER_K{n}' },
      事件: { template: 'KOJO_EVENT_K{n}' },
      单结局: { template: 'KOJO_SINGLE_ENDING_K{n}' },
      死亡结局: { template: 'KOJO_DEAD_ENDING_K{n}' },
    },
  };
}
