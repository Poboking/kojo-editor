/**
 * 产物 ↔ 源 的 source map（设计稿 §10.7）。
 *
 * 口径（写死，禁止各处另抄一套）：
 * - 产物位置 = **1 基行 / 1 基列，列按 UTF-16 码元**（与 `ast.ts` / Monaco 同口径）；
 * - 行级映射是底线（每一行产物都能查到源 span 或**显式 null**）；列级映射 additive：
 *   同一产物行内按列追加**半开区间**分段 `[startColumn, endColumn)`，查询取覆盖该列的段
 *   （`segmentAt`），空档回落行级；旧式点锚点（没有终点）语义不变（取"最后一个起点 ≤ 查询列"）；
 * - **不可映射 = null，不伪造**：纯生成行（`ENDIF`/包装骨架）显式登记 `kind: 'generated'` +
 *   `source: null`；没有登记的行查询结果也是 `line: null`，绝不拿邻居的行冒充自己；
 * - 模板 / 池展开**双向**：产物行同时登记调用处与定义处（`origins`），见 §10.7；
 * - 一个源行 → 多个产物行是常态（模板/池展开、`@原生`、折行）：每行各登记一次即可。
 *
 * 性能契约：
 * - `appendLine` **O(1)** 摊还、零对象分配（并行数组 push，行对象查询时才物化）；
 * - `appendSegment` O(1)（当前行）或 O(log n)（回填历史行）；
 * - `lookup` / `lineAt` / `segmentAt` **O(log n)**（行二分 + 分段二分）；
 * - `segmentsInRange` O(log n + 命中行数 + 命中段数)，不扫全表（只走已登记行）。
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
  /**
   * 该行的列级分段（升序、区间互不重叠；只看行级字段的旧消费方可以完全不读它）。
   * **没有列级分段时本字段缺席**（不是空数组）——"有没有更细的事实"一眼可辨。
   */
  readonly segments?: readonly SourceMapSegment[];
}

/**
 * 列级分段（additive；1 基行、1 基列、列按 UTF-16 码元）。
 *
 * 口径（写死）：
 * - 区间**半开** `[startColumn, endColumn)`：`column === startColumn` 命中，
 *   `column === endColumn` 不命中；
 * - `endColumn === null` = 开放到行尾，专供"旧式点锚点"（`appendSegment` 没给终点）：
 *   此时查询语义与旧版"取最后一个起点 ≤ 查询列"完全一致，旧行为零变化；
 * - `startColumn` 是正式名，`generatedColumn` 是**既有字段名的别名**（两者恒等），
 *   保留它是为了让只读 `generatedColumn` 的既有消费方（宿主反查）零改动；
 * - `kind` 缺省继承所属行的行级 `kind`；`origins` 缺省继承行级 `origins`；
 * - 同一行内的分段按 `startColumn` 严格递增、**区间不重叠**（允许留空档 = 该列段无列级事实，
 *   查询回落行级）。
 */
export interface SourceMapSegment {
  /** 所属产物行（1 基） */
  readonly generatedLine: number;
  /** 起点列 = `startColumn` 的既有别名（恒等，勿单独赋值） */
  readonly generatedColumn: number;
  /** 起点列（1 基、UTF-16；含） */
  readonly startColumn: number;
  /** 半开终点列（排他）；null = 开放到行尾（旧式点锚点口径） */
  readonly endColumn: number | null;
  /** null = 该列区间显式不可映射（不回落行级） */
  readonly source: KojoSpan | null;
  /** 分段类别（缺省 = 行级 kind） */
  readonly kind: SourceMapLineKind;
  /** 分段锚点（缺省 = 行级 origins）；模板/池分段自带调用处 + 定义处 */
  readonly origins: readonly SourceMapOrigin[];
}

export interface SourceMapLineInput {
  readonly generatedLine: number;
  readonly kind: SourceMapLineKind;
  readonly source: KojoSpan | null;
  readonly origins?: readonly SourceMapOrigin[];
}

export interface SourceMapSegmentInput {
  readonly generatedLine: number;
  /** 起点列（1 基、UTF-16；含） */
  readonly generatedColumn: number;
  /** null = 该列区间显式不可映射（不回落行级） */
  readonly source: KojoSpan | null;
  /** 半开终点列（排他）；缺省 = 开放到行尾（旧式点锚点）。给了就必须 > 起点 */
  readonly endColumn?: number;
  /** 分段类别；缺省继承行级 kind */
  readonly kind?: SourceMapLineKind;
  /** 分段锚点；缺省继承行级 origins。kind = template/pool 时必须自带双向锚点 */
  readonly origins?: readonly SourceMapOrigin[];
}

/**
 * 行内列级分段的**声明**形态（列相对该产物行，不写行号）：
 * 给"一次追加整行 + 它的分段"这类批量形状复用（`EmitMapping.segments`）。
 * `endColumn` 缺省时由追加方按该行文本的码元宽度补成 `行宽 + 1`（排他）。
 */
export interface SourceMapSegmentSpec {
  readonly startColumn: number;
  readonly endColumn?: number;
  readonly source: KojoSpan | null;
  readonly kind?: SourceMapLineKind;
  readonly origins?: readonly SourceMapOrigin[];
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
   * 列级：命中该列的分段（半开区间 `[startColumn, endColumn)`）。
   *
   * 未登记的行 / 该行没有列级分段 / 列落在分段空档上 = **显式 `null`**（不借邻居分段冒充）。
   * 越界列不 clamp（与 `lookup` 同口径：调用方给 1 基列即可，`column < 1` 直接抛错）。
   */
  segmentAt(generatedLine: number, column: number): SourceMapSegment | null;
  /**
   * 列级：与**生成侧**区间 `[start, end)` 相交的分段（按产物行升序、行内列升序）。
   *
   * - 端点必须是 1 基位置（否则抛错）；`end < start` → 空数组（反序区间没有语义）；
   * - `end === start` 按点查询处理（返回覆盖该点的分段）；
   * - 只回列级事实；行级映射仍走 `lineAt`（两档粒度分开给，消费方自己选）。
   */
  segmentsInRange(start: KojoPosition, end: KojoPosition): readonly SourceMapSegment[];
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
  /** 追加列级分段（同一产物行内起点严格递增、区间不重叠；`endColumn` 缺省 = 开放到行尾） */
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

/** 每行的列级分段存储：并行数组（列号 / 源 / 终点 / 类别 / 锚点），追加零对象分配 */
interface SegmentStore {
  readonly columns: number[];
  readonly sources: (KojoSpan | null)[];
  /** 显式半开终点；undefined = 未给（开放到下一段起点，末段开放到行尾） */
  readonly ends: (number | undefined)[];
  /** undefined = 继承行级 kind */
  readonly kinds: (SourceMapLineKind | undefined)[];
  /** undefined = 继承行级 origins */
  readonly origins: (readonly SourceMapOrigin[] | undefined)[];
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
  segmentAt(generatedLine: number, column: number): SourceMapSegment | null;
  segmentsInRange(start: KojoPosition, end: KojoPosition): readonly SourceMapSegment[];
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

  /** 分段的半开终点：显式终点 > 下一段起点 > null（开放到行尾） */
  const segmentEnd = (store: SegmentStore, segIndex: number): number | null => {
    const explicit = store.ends[segIndex];
    if (explicit !== undefined) return explicit;
    const next = store.columns[segIndex + 1];
    return next === undefined ? null : next;
  };

  /** 分段物化：`startColumn` 与旧名 `generatedColumn` 同值（唯一构造点，避免两处真源） */
  const materializeSegment = (index: number, store: SegmentStore, segIndex: number): SourceMapSegment => {
    const start = store.columns[segIndex]!;
    const kind = store.kinds[segIndex] ?? kinds[index]!;
    const origins = store.origins[segIndex] ?? originsOf[index] ?? EMPTY_ORIGINS;
    return {
      generatedLine: lines[index]!,
      generatedColumn: start,
      startColumn: start,
      endColumn: segmentEnd(store, segIndex),
      source: store.sources[segIndex]!,
      kind,
      origins,
    };
  };

  const materializeLine = (index: number): SourceMapLine => {
    const line: SourceMapLine = {
      generatedLine: lines[index]!,
      kind: kinds[index]!,
      source: sources[index]!,
      origins: originsOf[index] ?? EMPTY_ORIGINS,
    };
    const store = segmentsByLine.get(line.generatedLine);
    if (store === undefined) return line;
    const segments: SourceMapSegment[] = [];
    for (let segIndex = 0; segIndex < store.columns.length; segIndex++) {
      segments.push(materializeSegment(index, store, segIndex));
    }
    return { ...line, segments };
  };

  const segmentOnRegisteredLine = (index: number, column: number): SourceMapSegment | null => {
    const store = segmentsByLine.get(lines[index]!);
    if (store === undefined) return null;
    const segIndex = lastAtOrBefore(store.columns, column);
    if (segIndex < 0) return null;
    const end = segmentEnd(store, segIndex);
    // 半开区间：column === end 不命中（空档 = 该列没有列级事实，不是"最近一段的延伸"）
    if (end !== null && column >= end) return null;
    return materializeSegment(index, store, segIndex);
  };

  const segmentAt = (generatedLine: number, column: number): SourceMapSegment | null => {
    assertPosition({ line: generatedLine, column }, '列级分段查询位置');
    const index = lineIndex(generatedLine);
    return index < 0 ? null : segmentOnRegisteredLine(index, column);
  };

  const lookup = (at: KojoPosition): SourceMapLookup => {
    assertPosition(at, '查询位置');
    const index = lineIndex(at.line);
    if (index < 0) {
      return { generated: at, line: null, segment: null, source: null, origins: EMPTY_ORIGINS };
    }
    const line = materializeLine(index);
    const segment = segmentOnRegisteredLine(index, at.column);
    if (segment === null) {
      return { generated: at, line, segment: null, source: line.source, origins: line.origins };
    }
    return { generated: at, line, segment, source: segment.source, origins: segment.origins };
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
    segmentAt,
    segmentsInRange(start: KojoPosition, end: KojoPosition): readonly SourceMapSegment[] {
      assertPosition(start, '列级区间起点');
      assertPosition(end, '列级区间终点');
      if (comparePositions(end, start) < 0) return [];
      // 反序 = 没有语义（空）；零宽 = 点查询（同 `sourceSpanContains` 的半开口径）
      const zeroWidth = comparePositions(start, end) === 0;
      const found: SourceMapSegment[] = [];
      // 只扫"已登记且落在行区间内"的行：未登记的行本来就没有分段
      for (let i = firstAtOrAfter(lines, start.line); i < lines.length; i++) {
        const generatedLine = lines[i]!;
        if (generatedLine > end.line) break;
        const store = segmentsByLine.get(generatedLine);
        if (store === undefined) continue;
        const columnFrom = generatedLine === start.line ? start.column : 1;
        const columnTo = generatedLine === end.line ? end.column : Number.POSITIVE_INFINITY;
        for (let segIndex = 0; segIndex < store.columns.length; segIndex++) {
          const segStart = store.columns[segIndex]!;
          const segEnd = segmentEnd(store, segIndex) ?? Number.POSITIVE_INFINITY;
          const hit = zeroWidth
            ? segStart <= columnFrom && columnFrom < segEnd
            : segStart < columnTo && segEnd > columnFrom;
          if (hit) found.push(materializeSegment(i, store, segIndex));
        }
      }
      return found;
    },
    generatedLinesFor(source: KojoSpan): readonly number[] {
      assertSpan(source, '反向查询的源 span');
      const found: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        const store = segmentsByLine.get(lines[i]!);
        let hit = sameSpan(sources[i]!, source);
        if (!hit && store !== undefined) {
          for (const segmentSource of store.sources) {
            if (sameSpan(segmentSource, source)) {
              hit = true;
              break;
            }
          }
        }
        if (hit) found.push(lines[i]!);
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
    segmentAt: view.segmentAt,
    segmentsInRange: view.segmentsInRange,
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
      const rowIndex = lineIndex(input.generatedLine);
      if (input.source !== null) assertSpan(input.source, `行 ${input.generatedLine} 列级分段的源 span`);
      if (input.kind !== undefined && !KIND_SET.has(input.kind)) {
        fail(`行 ${input.generatedLine}：未知的分段类别 ${String(input.kind)}`);
      }
      if (input.origins !== undefined) {
        for (const origin of input.origins) {
          if (!ORIGIN_KIND_SET.has(origin.kind)) fail(`未知的锚点类别：${String(origin.kind)}`);
          assertSpan(origin.span, `分段锚点 ${origin.kind}`);
        }
      }
      // 有效类别 / 有效锚点 = 分段自带的，缺省继承行级（与物化口径一致，不另立一套）
      const kind = input.kind ?? kinds[rowIndex]!;
      const origins = input.origins ?? originsOf[rowIndex] ?? EMPTY_ORIGINS;
      if (kind === 'template') {
        if (!origins.some((o) => o.kind === 'call-site') || !origins.some((o) => o.kind === 'template-definition')) {
          fail(`行 ${input.generatedLine}：模板展开的列级分段也必须同时登记 call-site 与 template-definition 锚点（§10.7 双向）`);
        }
      }
      if (kind === 'pool') {
        if (!origins.some((o) => o.kind === 'call-site') || !origins.some((o) => o.kind === 'pool-definition')) {
          fail(`行 ${input.generatedLine}：池展开的列级分段也必须同时登记 call-site 与 pool-definition 锚点（§10.7 双向）`);
        }
      }
      if (input.endColumn !== undefined) {
        if (!Number.isInteger(input.endColumn) || input.endColumn <= input.generatedColumn) {
          fail(
            `行 ${input.generatedLine}：列级分段终点必须是 > 起点（${input.generatedColumn}）的整数，且为排他终点（收到 ${String(input.endColumn)}）`,
          );
        }
      }
      let store = segmentsByLine.get(input.generatedLine);
      if (store === undefined) {
        store = { columns: [], sources: [], ends: [], kinds: [], origins: [] };
        segmentsByLine.set(input.generatedLine, store);
      }
      const lastColumn = store.columns.length === 0 ? 0 : store.columns[store.columns.length - 1]!;
      if (input.generatedColumn <= lastColumn) {
        fail(`行 ${input.generatedLine}：列级分段起点必须严格递增（上一段 ${lastColumn}，本次 ${input.generatedColumn}）`);
      }
      // 区间不许重叠：上一段给了显式终点时，本次起点必须 ≥ 它（相等 = 紧邻，允许）
      const lastSegIndex = store.columns.length - 1;
      if (lastSegIndex >= 0) {
        const previousEnd = segmentEnd(store, lastSegIndex);
        if (previousEnd !== null && input.generatedColumn < previousEnd) {
          fail(
            `行 ${input.generatedLine}：列级分段区间不许重叠（上一段终点 ${previousEnd}，本次起点 ${input.generatedColumn}）`,
          );
        }
      }
      store.columns.push(input.generatedColumn);
      store.sources.push(input.source);
      store.ends.push(input.endColumn ?? undefined);
      store.kinds.push(input.kind);
      store.origins.push(input.origins);
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

/**
 * 行级 + 列级**整体**复制到另一个 builder（行号可重编）。
 *
 * 包装事件头 / 伴生函数 / 展开子缓冲把行搬进父缓冲时都要走它：只搬行级字段会**静默丢掉**
 * 列级分段（模板/池展开的调用处锚点就没了）。`mapped === null`（该行未登记）按既有的
 * "缺失 = generated" 口径落一行，不伪造源。
 */
export function copySourceMapLine(
  target: Pick<SourceMapBuilder, 'appendLine' | 'appendSegment'>,
  generatedLine: number,
  mapped: SourceMapLine | null,
): void {
  if (mapped === null || mapped.source === null) {
    target.appendLine({ generatedLine, kind: 'generated', source: null });
    return;
  }
  target.appendLine({
    generatedLine,
    kind: mapped.kind,
    source: mapped.source,
    ...(mapped.origins.length === 0 ? {} : { origins: mapped.origins }),
  });
  for (const spec of segmentSpecsOf(mapped) ?? []) {
    target.appendSegment({
      generatedLine,
      generatedColumn: spec.startColumn,
      source: spec.source,
      ...(spec.endColumn === undefined ? {} : { endColumn: spec.endColumn }),
      ...(spec.kind === undefined ? {} : { kind: spec.kind }),
      ...(spec.origins === undefined ? {} : { origins: spec.origins }),
    });
  }
}

/** `SourceMapLine.segments` → 可复用的声明形态（搬行时用）；没有列级分段 = undefined */
export function segmentSpecsOf(line: SourceMapLine): readonly SourceMapSegmentSpec[] | undefined {
  const segments = line.segments;
  if (segments === undefined) return undefined;
  return segments.map((segment) => ({
    startColumn: segment.startColumn,
    ...(segment.endColumn === null ? {} : { endColumn: segment.endColumn }),
    source: segment.source,
    kind: segment.kind,
    origins: segment.origins,
  }));
}

/** 二分工具导出给同一层的冷路径（预览/诊断聚合）复用，避免第三份实现 */
export const sourceMapSearch = { firstAtOrAfter, lastAtOrBefore } as const;
