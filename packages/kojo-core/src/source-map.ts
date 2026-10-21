/**
 * 产物 ↔ 源 的 source map（设计稿 §10.7）。
 *
 * 口径（写死，禁止各处另抄一套）：
 * - 产物位置 = **1 基行 / 1 基列，列按 UTF-16 码元**（与 `ast.ts` / Monaco 同口径）；
 * - 行级映射是底线（每一行产物都能查到源 span 或**显式 null**）；列级映射 additive：
 *   同一产物行内按列追加分段，查询时取"最后一个起点 ≤ 查询列"的分段，缺省回落行级；
 * - **不可映射 = null，不伪造**：纯生成行（`ENDIF`/包装骨架）显式登记 `kind: 'generated'` +
 *   `source: null`；没有登记的行查询结果也是 `line: null`，绝不拿邻居的行冒充自己；
 * - 模板 / 池展开**双向**：产物行同时登记调用处与定义处（`origins`），见 §10.7；
 * - 一个源行 → 多个产物行是常态（模板/池展开、`@原生`、折行）：每行各登记一次即可。
 *
 * 性能契约：
 * - `appendLine` **O(1)** 摊还、零对象分配（并行数组 push，行对象查询时才物化）；
 * - `appendSegment` O(1)（当前行）或 O(log n)（回填历史行）；
 * - `lookup` / `lineAt` **O(log n)**（行二分 + 分段二分）。
 *
 * 纯函数、零 IO：本模块不读盘、不认识 Monaco、不产生诊断（这是数据管道不是校验器）；
 * 违反追加契约（行号不升、`generated` 行带源、模板缺双向）一律抛错——**不静默**。
 */
import type { KojoPosition, KojoSpan } from './ast.js';
import { comparePositions } from './positions.js';

/** 产物行的来源类别（落盘/预览消费方可据此分档显示） */
export type SourceMapLineKind =
  /** 一行产物直接对应一行源（文本行、`?` 行、`@颜绘`…） */
  | 'source'
  /** 纯生成行：没有源，`source` 必须为 null */
  | 'generated'
  /** 模板展开：源指向调用处 + 模板定义处 */
  | 'template'
  /** 池展开：源指向调用处 + 池定义处 */
  | 'pool'
  /** `@原生` 逐行透传：源指向块体内对应的物理源行 */
  | 'native';

/** 模板/池展开的附加锚点：一个产物行同时能点回几处 */
export type SourceMapOriginKind = 'call-site' | 'template-definition' | 'pool-definition';

export interface SourceMapOrigin {
  readonly kind: SourceMapOriginKind;
  readonly span: KojoSpan;
}

/** 行级映射（查询时物化；不可映射行的 `source` 为 null） */
export interface SourceMapLine {
  readonly generatedLine: number;
  readonly kind: SourceMapLineKind;
  readonly source: KojoSpan | null;
  readonly origins: readonly SourceMapOrigin[];
}

/** 列级分段（additive；起点 1 基、UTF-16 码元） */
export interface SourceMapSegment {
  readonly generatedColumn: number;
  readonly source: KojoSpan | null;
}

export interface SourceMapLineInput {
  readonly generatedLine: number;
  readonly kind: SourceMapLineKind;
  readonly source: KojoSpan | null;
  readonly origins?: readonly SourceMapOrigin[];
}

export interface SourceMapSegmentInput {
  readonly generatedLine: number;
  readonly generatedColumn: number;
  /** null = 该列区间显式不可映射（不回落行级） */
  readonly source: KojoSpan | null;
}

/** 一次查询的完整答复：行级 + 命中的列级分段（都在，消费方自己选粒度） */
export interface SourceMapLookup {
  readonly generated: KojoPosition;
  /** 没有登记该产物行时为 null（显式不可映射，不是"查不到就猜"） */
  readonly line: SourceMapLine | null;
  /** 命中的列级分段（最近起点 ≤ 查询列）；没有列级登记时为 null */
  readonly segment: SourceMapSegment | null;
  /** 最细可用答案：分段源 > 行源 > null */
  readonly source: KojoSpan | null;
  readonly origins: readonly SourceMapOrigin[];
}

/** 只读查询面（`build()` 之后交给下游的形状；与 builder 共享同一份数组，零拷贝） */
export interface SourceMap {
  readonly lineCount: number;
  readonly segmentCount: number;
  lineAt(generatedLine: number): SourceMapLine | null;
  lookup(at: KojoPosition): SourceMapLookup;
  /**
   * 反向查询：源 span **逐字相等**的产物行（升序）。
   * 预览/回滚需要"源行 → 产物行"，但热路径只有正向；这里保持 O(n) 简单扫描，
   * 不维护第二份反向索引（避免两份真源漂移）。
   */
  generatedLinesFor(source: KojoSpan): readonly number[];
}

export interface SourceMapBuilder extends SourceMap {
  /** 追加一行（产物行号必须严格递增） */
  appendLine(input: SourceMapLineInput): void;
  /** 追加列级分段（同一产物行内列号必须严格递增） */
  appendSegment(input: SourceMapSegmentInput): void;
  /** 封口：返回只读视图（共享数组，零拷贝）；封口后 builder 再追加即抛错 */
  build(): SourceMap;
}

const EMPTY_ORIGINS: readonly SourceMapOrigin[] = Object.freeze([]);

const KIND_SET: ReadonlySet<SourceMapLineKind> = new Set<SourceMapLineKind>([
  'source',
  'generated',
  'template',
  'pool',
  'native',
]);

const ORIGIN_KIND_SET: ReadonlySet<SourceMapOriginKind> = new Set<SourceMapOriginKind>([
  'call-site',
  'template-definition',
  'pool-definition',
]);

function fail(message: string): never {
  throw new Error(`[source-map] ${message}`);
}

function assertPosition(at: KojoPosition, what: string): void {
  if (!Number.isInteger(at.line) || at.line < 1 || !Number.isInteger(at.column) || at.column < 1) {
    fail(`${what} 必须是 1 基行列的整数（收到 ${at.line}:${at.column}）`);
  }
}

function assertSpan(source: KojoSpan, what: string): void {
  assertPosition(source.start, `${what}.start`);
  assertPosition(source.end, `${what}.end`);
  if (comparePositions(source.start, source.end) > 0) {
    fail(`${what} 起点必须不晚于终点（收到 ${source.start.line}:${source.start.column}..${source.end.line}:${source.end.column}）`);
  }
}

function sameSpan(a: KojoSpan | null, b: KojoSpan | null): boolean {
  if (a === null || b === null) return a === b;
  return comparePositions(a.start, b.start) === 0 && comparePositions(a.end, b.end) === 0;
}

/** 每行的列级分段存储：并行数组（列号 / 源），追加零对象分配 */
interface SegmentStore {
  readonly columns: number[];
  readonly sources: (KojoSpan | null)[];
}

/** 二分：最后一个 `key <= target` 的下标；没有时 -1 */
function lastAtOrBefore(keys: readonly number[], target: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const key = keys[mid]!;
    if (key <= target) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** 二分：第一个 `key >= target` 的下标；没有时 keys.length */
function firstAtOrAfter(keys: readonly number[], target: number): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface LookupView {
  readonly lineCount: number;
  readonly segmentCount: number;
  lineAt(generatedLine: number): SourceMapLine | null;
  lookup(at: KojoPosition): SourceMapLookup;
  generatedLinesFor(source: KojoSpan): readonly number[];
}

export function createSourceMapBuilder(): SourceMapBuilder {
  /** 并行数组：行号 / 类别 / 源 / 附加锚点（undefined = 无） */
  const lines: number[] = [];
  const kinds: SourceMapLineKind[] = [];
  const sources: (KojoSpan | null)[] = [];
  const originsOf: (readonly SourceMapOrigin[] | undefined)[] = [];
  const segmentsByLine = new Map<number, SegmentStore>();
  let segmentCount = 0;
  let lastLine = 0;
  let built = false;

  const ensureOpen = (): void => {
    if (built) fail('已 build() 封口，不能再追加（source map 是单向数据流）');
  };

  const lineIndex = (generatedLine: number): number => {
    const at = lastAtOrBefore(lines, generatedLine);
    return at >= 0 && lines[at] === generatedLine ? at : -1;
  };

  const materializeLine = (index: number): SourceMapLine => ({
    generatedLine: lines[index]!,
    kind: kinds[index]!,
    source: sources[index]!,
    origins: originsOf[index] ?? EMPTY_ORIGINS,
  });

  const lookup = (at: KojoPosition): SourceMapLookup => {
    assertPosition(at, '查询位置');
    const index = lineIndex(at.line);
    if (index < 0) {
      return { generated: at, line: null, segment: null, source: null, origins: EMPTY_ORIGINS };
    }
    const line = materializeLine(index);
    const store = segmentsByLine.get(at.line);
    if (store === undefined) {
      return { generated: at, line, segment: null, source: line.source, origins: line.origins };
    }
    const segIndex = lastAtOrBefore(store.columns, at.column);
    if (segIndex < 0) {
      return { generated: at, line, segment: null, source: line.source, origins: line.origins };
    }
    const segment: SourceMapSegment = {
      generatedColumn: store.columns[segIndex]!,
      source: store.sources[segIndex]!,
    };
    return { generated: at, line, segment, source: segment.source, origins: line.origins };
  };

  const view: LookupView = {
    get lineCount() {
      return lines.length;
    },
    get segmentCount() {
      return segmentCount;
    },
    lineAt(generatedLine: number): SourceMapLine | null {
      assertPosition({ line: generatedLine, column: 1 }, '产物行号');
      const index = lineIndex(generatedLine);
      return index < 0 ? null : materializeLine(index);
    },
    lookup,
    generatedLinesFor(source: KojoSpan): readonly number[] {
      assertSpan(source, '反向查询的源 span');
      const found: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = materializeLine(i);
        const store = segmentsByLine.get(line.generatedLine);
        let hit = sameSpan(line.source, source);
        if (!hit && store !== undefined) {
          for (const segmentSource of store.sources) {
            if (sameSpan(segmentSource, source)) {
              hit = true;
              break;
            }
          }
        }
        if (hit) found.push(line.generatedLine);
      }
      return found;
    },
  };

  const builder: SourceMapBuilder = {
    get lineCount() {
      return lines.length;
    },
    get segmentCount() {
      return segmentCount;
    },
    lineAt: view.lineAt,
    lookup: view.lookup,
    generatedLinesFor: view.generatedLinesFor,
    appendLine(input: SourceMapLineInput): void {
      ensureOpen();
      if (!Number.isInteger(input.generatedLine) || input.generatedLine < 1) {
        fail(`产物行号必须是 ≥1 的整数（收到 ${input.generatedLine}）`);
      }
      if (input.generatedLine <= lastLine) {
        fail(`产物行号必须严格递增（上一行 ${lastLine}，本次 ${input.generatedLine}）`);
      }
      if (!KIND_SET.has(input.kind)) fail(`未知的映射类别：${String(input.kind)}`);
      const origins = input.origins ?? EMPTY_ORIGINS;
      for (const origin of origins) {
        if (!ORIGIN_KIND_SET.has(origin.kind)) fail(`未知的锚点类别：${String(origin.kind)}`);
        assertSpan(origin.span, `锚点 ${origin.kind}`);
      }
      if (input.source === null) {
        if (input.kind !== 'generated') {
          fail(`行 ${input.generatedLine}：只有 generated 行允许 source=null（不可映射要显式登记，不能拿别的行冒充）`);
        }
        if (origins.length > 0) fail(`行 ${input.generatedLine}：generated 行不能带锚点`);
      } else {
        if (input.kind === 'generated') {
          fail(`行 ${input.generatedLine}：generated 行不能带源 span（不可映射就是不可映射）`);
        }
        assertSpan(input.source, `行 ${input.generatedLine} 的源 span`);
      }
      if (input.kind === 'template') {
        if (!origins.some((o) => o.kind === 'call-site') || !origins.some((o) => o.kind === 'template-definition')) {
          fail(`行 ${input.generatedLine}：模板展开必须同时登记 call-site 与 template-definition 锚点（§10.7 双向）`);
        }
      }
      if (input.kind === 'pool') {
        if (!origins.some((o) => o.kind === 'call-site') || !origins.some((o) => o.kind === 'pool-definition')) {
          fail(`行 ${input.generatedLine}：池展开必须同时登记 call-site 与 pool-definition 锚点（§10.7 双向）`);
        }
      }
      lines.push(input.generatedLine);
      kinds.push(input.kind);
      sources.push(input.source);
      originsOf.push(origins.length > 0 ? origins : undefined);
      lastLine = input.generatedLine;
    },
    appendSegment(input: SourceMapSegmentInput): void {
      ensureOpen();
      assertPosition({ line: input.generatedLine, column: input.generatedColumn }, '列级分段起点');
      // 流式发射时几乎总是"当前最后一行"：O(1) 快路；回填历史行才付 O(log n) 二分。
      const lastIndex = lines.length - 1;
      const lineAlreadyRegistered =
        (lastIndex >= 0 && lines[lastIndex] === input.generatedLine) || lineIndex(input.generatedLine) >= 0;
      if (!lineAlreadyRegistered) {
        fail(`行 ${input.generatedLine} 尚未登记，列级分段必须先有行级映射`);
      }
      if (input.source !== null) assertSpan(input.source, `行 ${input.generatedLine} 列级分段的源 span`);
      let store = segmentsByLine.get(input.generatedLine);
      if (store === undefined) {
        store = { columns: [], sources: [] };
        segmentsByLine.set(input.generatedLine, store);
      }
      const lastColumn = store.columns.length === 0 ? 0 : store.columns[store.columns.length - 1]!;
      if (input.generatedColumn <= lastColumn) {
        fail(`行 ${input.generatedLine}：列级分段起点必须严格递增（上一段 ${lastColumn}，本次 ${input.generatedColumn}）`);
      }
      store.columns.push(input.generatedColumn);
      store.sources.push(input.source);
      segmentCount++;
    },
    build(): SourceMap {
      ensureOpen();
      built = true;
      return view;
    },
  };

  return builder;
}

/** 便捷判定：位置是否落在 span 内（半开区间；诊断/跳转共用口径） */
export function sourceSpanContains(span: KojoSpan, at: KojoPosition): boolean {
  return comparePositions(span.start, at) <= 0 && comparePositions(at, span.end) < 0;
}

/** 二分工具导出给同一层的冷路径（预览/诊断聚合）复用，避免第三份实现 */
export const sourceMapSearch = { firstAtOrAfter, lastAtOrBefore } as const;
