/**
 * 多剧场单文件 lowering 的中间产物。
 *
 * 这是 M1 的 **unit 层**：每个 Theater 独立降糖出的 body / sourceMap / 隐藏槽。
 * 它不携带 canonical ID、最终引擎函数名或运行时分发结果——那些是 M2/M3 的事实。
 *
 * `theaterUnits` 存在**不等于**编译成功：`ok` 才是最终 ERB 是否生成的唯一标志。
 */
import type { KojoTheater } from '../ast.js';
import type { SourceMap } from '../source-map.js';
import type { KojoHiddenSlot } from './backend.js';

export interface TheaterLoweringUnit {
  readonly theater: KojoTheater;
  readonly body: readonly string[];
  readonly sourceMap: SourceMap;
  readonly slots: readonly KojoHiddenSlot[];
}

/**
 * theaterUnits 的完整性状态。
 *
 * - `not-applicable`：旧路径，unit 层不参与
 * - `complete`：所有 Theater 都成功降糖；ERB 仍可能因 M1 装配限制而不生成
 * - `discarded-syntax`：词法/解析/结构错误，unit 已全部丢弃
 * - `discarded-lowering`：sema/lowering/@织 错误，unit 已全部丢弃
 */
export type TheaterUnitsStatus =
  | 'not-applicable'
  | 'complete'
  | 'discarded-syntax'
  | 'discarded-lowering';
