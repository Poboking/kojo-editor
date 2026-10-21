/**
 * 源坐标折回**物理行列** —— 全仓唯一实现（core 侧；v1 转译器经 `@kojo/kojo-core` 再导出同一份）。
 *
 * 为什么在 core：`@原生` 去缩进后的视图坐标（行内偏移、去缩进列）与物理源坐标不是同一套，
 * 诊断与 source map 都必须落回物理行列才有用。此前这份逻辑只在 v1（插件包）里；core 不能
 * import 插件包（单向依赖），所以**搬到 core**、v1 侧改为再导出/调用——只搬一份，禁止第二实现。
 *
 * 坐标口径（写死，全链不得改）：
 * - 行、列均 **1 基**；列按 **UTF-16 码元**计（`String.prototype.length` 口径：中文/全角标点 = 1，
 *   emoji（代理对）= 2，**不是码点**）；
 * - 一行由多个**物理段**拼成（折行 `\` 续接、或 `@原生` 去缩进视图）时，`FoldSegment` 记
 *   「段首在视图文本里的 0 基偏移 + 段首所在的物理行/列」，折回 = 找段 + 段内逐码元平移；
 * - **越界夹取**：列 < 1 夹到视图行首（偏移 0）；列越过视图文本末尾夹到**末尾之后**
 *   （偏移 = 文本长度，即"行尾之后"位置）；**绝不抛错、绝不回落到首行起点**——列映射是查询，
 *   宁可给保守值也不静默失败；
 * - 未折行（单段）/ 不是视图行首（续接物理行）⇒ **原样返回**：此时视图坐标与物理坐标逐字相等，
 *   再折一次也不走样（幂等）。
 *
 * 纯函数、零 IO、零依赖（只读 `KojoPosition` 的形状）：本模块不读盘、不认识 Monaco、不产诊断。
 */
import type { KojoPosition } from '../ast.js';

/**
 * 视图文本的一段来自哪个物理行。
 *
 * 段按下标**升序**、`offset` 严格递增；段 `i` 覆盖 `[offset_i, offset_{i+1})`（末段到文本末尾）。
 */
export interface FoldSegment {
  /** 该段起点在**视图文本**里的 0 基码元偏移 */
  readonly offset: number;
  /** 该段所属物理行（1 基） */
  readonly line: number;
  /** 该段首字符在物理行里的列（1 基；UTF-16 码元） */
  readonly column: number;
}

/**
 * 一行的**视图**：视图文本 + 它由哪些物理段拼成。
 *
 * 两种来源共用同一形状：
 * - v1 折行：`text` = 合并折行后的逻辑全文（含首行缩进），段 = 各条物理行；
 * - core `@原生` 去缩进：`text` = 去基准缩进后的行文本，段 = 单段（列 = 该行物理起点列）。
 */
export interface SourceLineView {
  /** 视图全文（行内不含换行） */
  readonly text: string;
  /** 物理段（升序；未折行/去缩进 = 单段） */
  readonly segments: readonly FoldSegment[];
}

/**
 * 视图内 1 基列 → 0 基码元偏移（**越界夹取唯一入口**）。
 *
 * 口径：`column < 1` ⇒ 0；`column - 1 > textLength` ⇒ `textLength`；其余原样减一。
 */
export function clampLogicalOffset(column: number, textLength: number): number {
  const limit = Math.max(0, Math.trunc(textLength) || 0);
  const offset = Math.trunc(column) - 1;
  if (!Number.isFinite(offset)) return 0;
  return Math.min(Math.max(offset, 0), limit);
}

/**
 * 视图偏移（0 基码元）→ 物理源位置（1 基列）。越界按末段夹紧，绝不抛错。
 *
 * `segments` 为空（不该发生）时退化为 `{line: 1, column: 1 + offset}`——与旧实现逐字同口径，
 * 宁可给保守值也不抛错（列映射是查询）。
 */
export function logicalPosition(segments: readonly FoldSegment[], offset: number): KojoPosition {
  let seg = segments[0] ?? { offset: 0, line: 1, column: 1 };
  for (const s of segments) {
    if (s.offset > offset) break;
    seg = s;
  }
  return { line: seg.line, column: seg.column + Math.max(0, offset - seg.offset) };
}

/**
 * **视图坐标 → 物理行列**（诊断/source map「折回物理行」的唯一入口；§10.7 / §4.13）。
 *
 * - 入参 `position.line` 是**视图行首的物理行号**，`position.column` 是该视图行全文里的
 *   1 基列（含行首缩进）⇒ 视图偏移 = `column - 1`；
 * - 越界夹取见 `clampLogicalOffset`（行首 / 行尾之后，不抛错、不回落到首行起点）；
 * - 该行**不是**视图行首（= 物理续接行）、或该视图行**未折行**（单段）⇒ **原样返回**。
 *
 * 幂等性：对已经是物理坐标的位置再折一次结果不变（首段内的列原样映射回自身；
 * 续接行没有自己的视图 ⇒ 落进"原样返回"那一支）。
 */
export function foldPositionToPhysical(
  views: ReadonlyMap<number, SourceLineView>,
  position: KojoPosition,
): KojoPosition {
  const view = views.get(position.line);
  if (view === undefined || view.segments.length <= 1) return position;
  return logicalPosition(view.segments, clampLogicalOffset(position.column, view.text.length));
}

/**
 * **去缩进视图坐标 → 物理行列**（`@原生` 专用；单段视图也要折）。
 *
 * 与 `foldPositionToPhysical` 的差别只有一条：视图是**单段也折**（去缩进的行首列 > 1，
 * 不折就等于把"去缩进后列"当物理列）。越界夹取与段内平移共用同一套口径。
 */
export function foldDedentedPosition(view: SourceLineView, position: KojoPosition): KojoPosition {
  return logicalPosition(view.segments, clampLogicalOffset(position.column, view.text.length));
}

/**
 * 造一条**去缩进行视图**：视图文本 = 去基准缩进后的行文本，物理段 = 单段，起点列 = 该行
 * 第一个内容字符在物理行里的列（1 基，UTF-16 码元）。
 *
 * `startColumn` 非法（非有限数 / < 1）时夹到 1：这是内部契约的兜底，不产诊断（宁缺勿编，
 * 但绝不让坐标换算抛错）。
 */
export function nativeLineView(line: number, startColumn: number, text: string): SourceLineView {
  const column = Number.isFinite(startColumn) ? Math.max(1, Math.trunc(startColumn)) : 1;
  return { text, segments: [{ offset: 0, line, column }] };
}
