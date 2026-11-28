/**
 * P3-9 · RNG 契约（eratw `specs/rng.md` 真值 → kojo 消费面）。
 *
 * 真值源（逐条带锚，手写契约——rng.md 是散文规约，无机器可读快照，本文件的
 * 每条事实都回指散文里的 C# 行号；改 eratw 引擎侧语义时两处同步）：
 *
 * 1. **默认 RNG = 自实现 SFMT19937**（类名 MTRandom 有误导性；MTRandom.cs:5-165，
 *    PARITY4=331998852 是 SFMT 特征值）。逐值一致所需的算法/状态清单见 rng.md §4
 *    （eratw 已复刻，kojo 编辑器侧不参与求值，不搬算法）。
 * 2. **RAND 族三路语义**（诊断判据的依据）：
 *    - `RAND:n` 伪变量：1.824 `VariableData.cs:846-851` n≤0 抛 CodeEE(RandArgIsNegative)；
 *      **snake 4.981 `VariableToken.cs:1413-1436` 改为钳制返回 0 + 首次告警**
 *      （eratw `VariableStore.kt random()` 逐字复刻：不消耗 RNG、按会话槽 once 告警）；
 *    - `RAND(min,max)` / `RAND(max)` 方法：1.824 `FunctionMethodCreator.cs:4063-4070`
 *      max≤min 抛（min==0 时 NegativeMaximum 分支）；**snake 4.981 `Creator.Method.cs:3824/:3848`
 *      统一为钳制返回下界 + 首次告警**（MaximumLowerThanMinimum 文案）；
 *    - CompatiRAND 配置（eramaker 兼容）：两代都不抛——0 返 0、负取绝对值、
 *      固定先取 `GetNextRand(32768)` 再取模（`VariableData.cs:856-876`）。配置态判不了，
 *      编辑器侧对 RAND 字面越界**只按缺省（CompatiRAND 关）口径判**，CompatiRAND
 *      开启时这些写法合法——诊断文案里写明这层前提。
 * 3. **UseNewRandom 漂移（rng.md §6）**：4.980 setting.json = false，4.981 随包 = true
 *    ⇒ 照抄上游配置时实际走 .NET 8 System.Random（xoshiro256\*\*），RANDOMIZE/INITRAND/
 *    DUMPRAND 全部失效、逐值一致失效。eratw 侧 TODO(verify) 由组长裁定；kojo 侧
 *    只记事实不做诊断（配置文件不在编辑器判据域）。
 * 4. **RANDDATA**：全局数组（624 状态字 + idx 游标，`VariableEvaluator.cs:117/:222-230`），
 *    随 global.sav 持久化；维度/尺寸真值已随 `ERB_ENGINE_NAMES` 进 P1-4 越界闸，不重复判。
 */

/** snake 方言（eratw 复刻的 4.981）RAND:n 钳 0 告警原话——eratw `ClampWarnings.kt` 逐字 */
export function snakeRandTokenClampMessage(bound: number): string {
  return `RAND不能指定0以下的值(${bound})（已钳制为 0，不再中断运行）`;
}

/** snake 方言 RAND(max) / RAND(min,max) max≤min 钳下界告警原话——eratw `ClampWarnings.kt` 逐字 */
export function snakeRandMethodClampMessage(max: number): string {
  return `函数RAND: 最大值被指定为小于或等于最小值的值(${max})（已钳制为下界，不再中断运行）`;
}

/** 两代引擎对同一段代码的行为分歧注（1.824 中断 / snake 告警钳制） */
export const RAND_DIALECT_NOTE =
  '——snake（4.981）引擎只首次告警并钳制继续跑；1.824（eramaker 原版）同一行会抛错中断。' +
  '另：CompatiRAND 配置开启时 RAND:0 合法（返回 0），本诊断按缺省口径（CompatiRAND 关）判。';
