/**
 * SourceMap 的可序列化纯数据投影（Contracts D4 / M2-P1）。
 *
 * 边界：
 * - 运行时 `SourceMap` 的接口、实现与查询语义**不变**；
 * - 本模块只做单向投影：`SourceMap` → 普通对象/数组，供 Project IR 序列化；
 * - 不把带方法的 `SourceMap` 实例塞进 Project IR，也不复用 incremental.ts 的私有并行数组；
 * - 显式不可映射仍保留 `source: null`，不伪造。
 */
import type { KojoSpan } from './ast.js';
import type {
  SourceMap,
  SourceMapLineKind,
  SourceMapOrigin,
  SourceMapSegment,
} from './source-map.js';

/** 当前 `SourceMapData` 投影格式版本；字段语义变化时递增。 */
export const SOURCE_MAP_DATA_VERSION = 1 as const;

/** 一行产物的纯数据投影。 */
export interface SourceMapLineData {
  readonly generatedLine: number;
  readonly kind: SourceMapLineKind;
  readonly source: KojoSpan | null;
  readonly origins: readonly SourceMapOrigin[];
  readonly segments: readonly SourceMapSegment[];
}

/** 可 JSON 序列化的 SourceMap 投影。 */
export interface SourceMapData {
  readonly version: number;
  readonly lineCount: number;
  readonly lines: readonly SourceMapLineData[];
}

function copySpan(span: KojoSpan): KojoSpan {
  return {
    start: { line: span.start.line, column: span.start.column },
    end: { line: span.end.line, column: span.end.column },
  };
}

function copyOrigins(origins: readonly SourceMapOrigin[]): readonly SourceMapOrigin[] {
  return origins.map((origin) => ({ kind: origin.kind, span: copySpan(origin.span) }));
}

function copySegment(segment: SourceMapSegment): SourceMapSegment {
  return {
    generatedLine: segment.generatedLine,
    generatedColumn: segment.generatedColumn,
    startColumn: segment.startColumn,
    endColumn: segment.endColumn,
    source: segment.source === null ? null : copySpan(segment.source),
    kind: segment.kind,
    origins: copyOrigins(segment.origins),
  };
}

/**
 * 把运行时 SourceMap 投影为纯数据。
 *
 * 逐行读取 `lineAt`，确保结果与运行时查询面一致；`lineCount` 必须等于实际行数，
 * 行号从 1 起严格递增。投影后不共享可变数组/对象引用。
 */
export function toSourceMapData(map: SourceMap): SourceMapData {
  const lines: SourceMapLineData[] = [];
  for (let generatedLine = 1; generatedLine <= map.lineCount; generatedLine++) {
    const line = map.lineAt(generatedLine);
    if (line === null) {
      throw new Error(`[source-map-data] SourceMap 登记了 lineCount=${map.lineCount}，但 lineAt(${generatedLine}) 为 null`);
    }
    if (line.generatedLine !== generatedLine) {
      throw new Error(
        `[source-map-data] SourceMap 行号不连续：期望 ${generatedLine}，收到 ${line.generatedLine}`,
      );
    }
    lines.push({
      generatedLine: line.generatedLine,
      kind: line.kind,
      source: line.source === null ? null : copySpan(line.source),
      origins: copyOrigins(line.origins),
      segments: (line.segments ?? []).map(copySegment),
    });
  }

  if (lines.length !== map.lineCount) {
    throw new Error(`[source-map-data] lineCount 不一致：map=${map.lineCount}，投影=${lines.length}`);
  }

  return {
    version: SOURCE_MAP_DATA_VERSION,
    lineCount: lines.length,
    lines,
  };
}