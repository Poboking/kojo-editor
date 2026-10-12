/**
 * 超大文件降级（2026-10-12「内核优化」批；目标 = 超长文件打开/滚动/编辑丝滑）。
 *
 * ## 为什么需要
 *
 * 本插件的贡献都是**整篇文档量级**的分析：`sugar.lift.liftSuggest` 要先做控制流
 * 扫描（`scanControlFlow`）+ 逐条条件表达式解析（`parseExpression`），再对候选做
 * round-trip 转译自证。实测（Node v22.22.2，真实语料，见
 * `docs/PERF-REVIEW-2026-10-11.md` §7.6）：
 *
 * | 文件 | 行数 | `liftSuggest` |
 * |---|---|---|
 * | `AUTO_AEGI.ERB` | 284 | 4 ms |
 * | `M_KOJO_K40_コマンド.ERB` | 21,967 | 70 ms |
 * | `M_KOJO_K58_1_日常系コマンド.ERB` | 52,602 | **231 ms** |
 *
 * 而我们这个插件有三处入口，其中**两处是框架/宿主自动触发**的：
 *
 * 1. `ui.editor.liftPreview` → 宿主接成 Monaco **折叠范围供给器**：Monaco 在文件
 *    打开时就会把整篇文档的折叠范围要一遍（内容变化后再要），即"打开超长 ERB 卡
 *    一下"的**主因**；
 * 2. `ui.editor.codeAction` → Monaco 的 💡 可用性探测会在光标/选区变化时调用
 *    provider，同样是自动触发；
 * 3. 面板（`ui.panel`）→ 打开面板时自动扫一次（用户显式打开的界面）。
 *
 * ## 策略
 *
 * 超过 `LIFT_MAX_LINES` 行时：
 *
 * - **自动路径**（折叠加号 / 💡 可用性探测 / 面板自动扫描）→ **不扫描**；
 * - **显式路径**（面板「重新扫描」按钮）→ 仍然工作（用户主动要，代价自担）；
 * - 降级**必须可见**（内核铁律「不静默」）：面板显示专门说明态，控制台每文件告警一次。
 *
 * 阈值对"代价"取整：≥5000 行的文件在 2,317 个真实口上文件里占 **6.0%**（138 个），
 * 但正是体感最痛的那部分；≤5000 行的扫描代价 ≤ 约 30 ms，可接受。
 */

/** 升糖扫描的最大文件行数（超过即走降级路径；需要时可调） */
export const LIFT_MAX_LINES = 5000;

export interface LiftScanBudget {
  /** 是否因体量跳过整篇扫描 */
  readonly skip: boolean;
  /** 面向作者的中文说明（`skip === true` 时给；否则 null） */
  readonly reason: string | null;
}

/**
 * 依据行数决定是否跳过整篇升糖扫描（**纯函数**）。
 *
 * `lineCount === undefined`（契约 additive 的缺省态）= 体量未知 → **不降级**
 * （保守取向：行为与旧版一致，绝不因拿不到信息而悄悄少给结果）。
 */
export function liftScanBudget(lineCount: number | undefined, maxLines: number = LIFT_MAX_LINES): LiftScanBudget {
  if (lineCount === undefined || lineCount <= maxLines) return { skip: false, reason: null };
  return {
    skip: true,
    reason: `该文件 ${lineCount} 行，超过 ${maxLines} 行上限——已跳过整篇升糖扫描以保证打开与滚动流畅。要看候选请点「重新扫描」（按需执行，会有一瞬卡顿）。`,
  };
}

/** 数行数（不 split，避免为超长文本再分配一个数组） */
export function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
