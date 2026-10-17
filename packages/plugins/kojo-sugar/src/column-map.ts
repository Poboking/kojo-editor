/**
 * 列级源映射（S6 批）——**产物行+列 ↔ 源行+列** 的区段构造与查询。
 *
 * 列口径（与 Monaco / JS 字符串索引逐字一致，全链不得改口径）：
 * - 列 **1 基**，宽度按 **UTF-16 码元** 计（`String.prototype.length` / `slice` 的口径）；
 *   中文与全角标点 = 1 码元，emoji（代理对）= 2 码元——**不是码点数**；
 * - 产物缩进是 `\t`（规范 §5.3），一个制表符在模型里就是 **1 码元**，
 *   所以 `产物列 = 缩进层级 + 段内偏移 + 1` 直接成立，与显示宽度无关。
 *
 * 为什么在**生成时**记列、而不是事后从产物回推：产物里不存在源列的任何痕迹
 * （`PRINTFORMW` 前缀长度、降糖改写、折行合并都会打乱对齐），从文本反推等于猜；
 * 生成时调用方手里同时有「源偏移」和「产物偏移」两条坐标，记一条区段是**零推断**。
 *
 * 保守口径（铁律「宁缺勿编」）：只记**逐码元恒等**区段（源切片与产物切片逐码元相等，
 * 由 `buildColumnRuns` 就地校验，校验不过该段直接丢弃）。降糖改写的区段不记 ⇒ 查询
 * 落进空洞时按「就近夹紧」回落到同一产物行的映射，回落不到才给行级结果。
 */

import type { SugarColumnRun, SugarPosition, SugarSourceMapEntry, SugarTranspileResult } from '@kojo/plugin-api';
import { logicalPosition, type SourceLineView } from './lexer';

export type { SourceLineView } from './lexer';

/**
 * 生成时交给 `Emitter` 的区段规格。
 * 两侧偏移均为 0 基码元：产物侧相对**未加缩进**的行文本，源侧相对**逻辑全文**（含首行缩进）。
 */
export interface RunSpec {
  /** 产物侧：段起点在行文本（未加缩进）里的 0 基码元偏移 */
  generatedOffset: number;
  /** 段宽（码元数）；源侧同宽（恒等区段的定义） */
  length: number;
  /** 源侧：段起点在逻辑全文里的 0 基码元偏移 */
  sourceOffset: number;
}

/** 空区段（少分配一点数组；也是"该行没有可信列"的统一返回值） */
export const NO_RUNS: readonly RunSpec[] = [];

/* ============================== 产物行 → 源映射条目索引（PS-8） ============================== */

/**
 * `sourceMap` 的**按结果对象记忆**的两级索引：
 * - `exact`：`generatedLine → 首条匹配条目`（与 `Array.prototype.find` 逐字同语义）；
 * - `ordered`：按 `generatedLine` 升序的稳定拷贝（与 `[...map].sort(...)` 同序）。
 *
 * 用途：语言服务每轮（滚动即重请求）会对同一结果问几十~几百次行级查找，
 * 线性 `find` 在 3,000 行产物上每次 ~2–17 µs；索引一次建、WeakMap 随结果回收。
 * 结果对象被契约定义为**只读共享**（`service.ts` 缓存那节），故记忆安全。
 */
export interface SourceMapIndex {
  readonly exact: ReadonlyMap<number, SugarSourceMapEntry>;
  readonly ordered: readonly SugarSourceMapEntry[];
}

const sourceMapIndexCache = new WeakMap<SugarTranspileResult, SourceMapIndex>();

export function sourceMapIndex(result: SugarTranspileResult): SourceMapIndex {
  let index = sourceMapIndexCache.get(result);
  if (index === undefined) {
    const exact = new Map<number, SugarSourceMapEntry>();
    for (const entry of result.sourceMap) {
      if (!exact.has(entry.generatedLine)) exact.set(entry.generatedLine, entry);
    }
    index = {
      exact,
      ordered: [...result.sourceMap].sort((a, b) => a.generatedLine - b.generatedLine),
    };
    sourceMapIndexCache.set(result, index);
  }
  return index;
}

/** 整段逐码元恒等的区段规格（原生直通 / 注释：产物文本 = 源文本切片） */
export function verbatimSpec(sourceOffset: number, length: number): RunSpec[] {
  return length > 0 ? [{ generatedOffset: 0, length, sourceOffset }] : [];
}

/**
 * 取区段与「源窗口 `[srcFrom, srcTo)`」的交集，再平移到产物坐标（窗口起点 ⇔ `genBase`）。
 *
 * 生成常在文本体两侧**剥字**（`你：` 前缀、心形剥引号）或**加字**（`PRINTFORMW `、
 * `CALL HPH_PRINT(@"`）：先裁掉窗口外的部分再整体平移，两段都保持逐码元恒等——
 * 平移 + 裁剪是唯一允许的坐标换算，不做任何"猜对齐"。
 */
export function clipAndShift(specs: readonly RunSpec[], srcFrom: number, srcTo: number, genBase: number): RunSpec[] {
  if (specs.length === 0 || srcTo <= srcFrom || genBase < 0) return [];
  const out: RunSpec[] = [];
  for (const s of specs) {
    const lo = Math.max(s.generatedOffset, srcFrom);
    const hi = Math.min(s.generatedOffset + s.length, srcTo);
    if (hi <= lo) continue;
    out.push({
      generatedOffset: genBase + (lo - srcFrom),
      length: hi - lo,
      sourceOffset: s.sourceOffset + (lo - s.generatedOffset),
    });
  }
  return out;
}

/**
 * 恒等区段：产物里原样出现的这段文本，其源位置从 `searchFrom` 起在逻辑全文里定位
 * （定位不到 ⇒ 不记；再由 `buildColumnRuns` 逐码元校验兜底）。
 */
export function identitySpec(viewText: string, needle: string, searchFrom: number, generatedOffset: number): RunSpec[] {
  if (needle.length === 0) return [];
  const at = viewText.indexOf(needle, Math.max(0, searchFrom));
  return at < 0 ? [] : [{ generatedOffset, length: needle.length, sourceOffset: at }];
}

/**
 * 区段规格 → 契约区段（逐段校验 + 按折行段切分）。
 *
 * 校验：产物切片必须与源切片**逐码元相等**，否则该段丢弃（宁缺勿编）。
 * 切分：源范围跨折行边界时拆成多条，各自落到**自己的物理行与列**。
 */
export function buildColumnRuns(
  specs: readonly RunSpec[],
  bodyText: string,
  indent: number,
  sourceLine: number,
  view: SourceLineView | undefined,
): SugarColumnRun[] {
  if (!view || specs.length === 0 || bodyText.length === 0) return [];
  const out: SugarColumnRun[] = [];
  for (const spec of specs) {
    // `bo` 在**未加缩进**的行文本里定位并校验；产物列再叠 `indent`（1 TAB = 1 码元）
    let bo = spec.generatedOffset;
    let s = spec.sourceOffset;
    let left = spec.length;
    if (bo < 0 || s < 0 || left <= 0 || bo + left > bodyText.length || s + left > view.text.length) continue;
    let seg = 0;
    while (left > 0) {
      const cur = view.segments[Math.min(seg, view.segments.length - 1)]!;
      const nxt = view.segments[seg + 1];
      const cap = nxt ? nxt.offset - s : Number.POSITIVE_INFINITY;
      if (cap <= 0) {
        seg++;
        continue;
      }
      const take = Math.min(left, cap);
      if (view.text.slice(s, s + take) === bodyText.slice(bo, bo + take)) {
        out.push({
          generatedColumn: bo + indent + 1,
          length: take,
          source: logicalPosition(view.segments, s),
        });
      }
      bo += take;
      s += take;
      left -= take;
      if (nxt && s >= nxt.offset) seg++;
    }
  }
  return mergeAdjacent(out);
}

/** 相邻且两侧都连续的段合并（折行边界处产物列源列同时跳变 ⇒ 不相邻，合不上） */
function mergeAdjacent(runs: readonly SugarColumnRun[]): SugarColumnRun[] {
  const out: SugarColumnRun[] = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.source.line === r.source.line &&
      prev.generatedColumn + prev.length === r.generatedColumn &&
      prev.source.column + prev.length === r.source.column
    ) {
      out[out.length - 1] = { ...prev, length: prev.length + r.length };
      continue;
    }
    out.push(r);
  }
  return out;
}

/** 段尾的源位置（半开区间末端；越界列由消费端按 Monaco 口径夹紧） */
function runEndSource(run: SugarColumnRun): SugarPosition {
  return { line: run.source.line, column: run.source.column + run.length };
}

/**
 * 产物列 → 源列（区内逐码元平移；区内之外按「就近夹紧」，同距优先取前一段尾）。
 *
 * 前提：`entry.sourceLine !== null`（纯生成行由调用方先返回 null，不进这里）。
 * 该行**无区段** = 降糖改写行 ⇒ 退化为行级口径（列 1），与不传列时逐字一致。
 */
export function sourceColumnOfEntry(entry: SugarSourceMapEntry, generatedColumn: number): SugarPosition | null {
  if (entry.sourceLine === null) return null;
  const runs = entry.runs;
  if (!runs || runs.length === 0) return { line: entry.sourceLine, column: entry.span?.start.column ?? 1 };
  const col = Math.max(1, generatedColumn);
  let prev: SugarColumnRun | undefined;
  for (const run of runs) {
    const start = run.generatedColumn;
    const end = start + run.length;
    if (col >= start && col < end) {
      return { line: run.source.line, column: run.source.column + (col - start) };
    }
    if (col < start) {
      if (!prev) return { line: run.source.line, column: run.source.column }; // 列在首段之前：产物前缀 → 首段源起点
      return col - endIn(prev) <= start - col ? runEndSource(prev) : run.source;
    }
    prev = run;
  }
  return runEndSource(runs[runs.length - 1]!); // 列越过末段（行尾之后）：夹到末段源尾
}

/** 已消费到的产物列（段尾，1 基半开） */
function endIn(run: SugarColumnRun): number {
  return run.generatedColumn + run.length;
}

/**
 * 源列 → 产物位置（`runs` 的正向索引，往返自证用）。
 * 命中多个取**产物行最小、段最靠前**者；源位置落在无区段的改写区 → null（不猜）。
 */
export function generatedPositionOf(result: SugarTranspileResult, source: SugarPosition): SugarPosition | null {
  let best: SugarPosition | null = null;
  for (const entry of result.sourceMap) {
    for (const run of entry.runs ?? []) {
      if (run.source.line !== source.line) continue;
      const delta = source.column - run.source.column;
      if (delta < 0 || delta >= run.length) continue;
      const hit = { line: entry.generatedLine, column: run.generatedColumn + delta };
      if (!best || hit.line < best.line || (hit.line === best.line && hit.column < best.column)) best = hit;
    }
  }
  return best;
}
