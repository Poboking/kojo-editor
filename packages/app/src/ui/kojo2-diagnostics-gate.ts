/**
 * Kojo 2.0 诊断接线的**纯判据**（K2 batch-3）。
 *
 * 单独成文件的理由只有一条：`EditorPane.tsx` 是冲突热点，它只需要"这一份文件的波浪线
 * 归不归 2.0 管"这一个布尔，不该为了这个布尔把整条诊断链路（core 编译 + eraTW backend）
 * 静态拖进自己的模块图。判据本身零副作用、零 Monaco、node 可单测。
 *
 * 三处消费同一个答案：
 * - `EditorPane.refreshMarkers`：`true` ⇒ **让路**（v1 装饰轮不发布，否则它整档写空会把
 *   2.0 刚上账的问题抹掉——`.kojo2` 上 v1 装饰器本来就一条结果都没有）；
 * - `use-monaco-instance.ts`：`true` ⇒ 装诊断接线；
 * - `kojo2-problem-wiring.ts`：装的时候再判一次（导出的安装器可能被别的入口直接调用）。
 *
 * flag 关 ⇒ 恒 `false`，v1 行为逐字不变（不装监听、不让路、一个端口都不碰）。
 */
import { isKojo2CutoverEnabled } from './kojo2-flag';
import { isKojo2Path } from './kojo2-open';

/** flag 开没开（与语言面 / 主题同一口径：模块求值 / 实例装配那一刻读一次） */
export function kojo2DiagnosticsEnabled(): boolean {
  return isKojo2CutoverEnabled();
}

/**
 * 纯扩展名判据（**不读开关**）：只回答"这是不是 `.kojo2`"。
 *
 * 给热路径用（诊断接线在每次击键上判目标）：开关在装配那一刻已经读过一次，没必要每个
 * 事件再摸一次 localStorage。判据与 `languages.ts` 的 descriptor 同一条（最后一段扩展名、
 * 大小写不敏感）。
 */
export function isKojo2DiagnosticsPath(filePath: string): boolean {
  return isKojo2Path(filePath);
}

/**
 * 这一份文件的问题是否由 2.0 诊断链路**独占**。
 *
 * 判据 = flag 开 **且** 路径是 `.kojo2`（与 `languages.ts` 的 descriptor 同一条扩展名口径）。
 * 非 2.0 文件、flag 未开 ⇒ `false`，调用方照原样继续。
 */
export function kojo2OwnsDiagnostics(filePath: string): boolean {
  return kojo2DiagnosticsEnabled() && isKojo2DiagnosticsPath(filePath);
}
