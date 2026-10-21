/**
 * 产物缓冲区：**每行 O(1) 追加、预分配、零重复 toString**。
 *
 * 设计取舍（性能）：
 * - 行数组按估算行数**预分配**，追加 = `lines[count++] = text`（不 `push` 到洞数组、不 `concat`）；
 * - source map 与行数组**同一次追加**完成（并行数组，O(1) 摊还，查询时才物化行对象）；
 * - 不提供 `toString()` / `join()` 包装：拼字符串是消费方的事，缓冲区只交数组——
 *   "零重复 toString" 靠 API 形状保证（想重复也没有入口）；
 * - `finish()` 把数组截到真实长度并封口 source map：之后任何追加都抛错（单向数据流）。
 */
import type { KojoSpan } from '../ast.js';
import type { DiagnosticSink } from '../diagnostics.js';
import type {
  SourceMap,
  SourceMapLineKind,
  SourceMapOrigin,
  SourceMapSegmentSpec,
} from '../source-map.js';
import { createSourceMapBuilder } from '../source-map.js';
import type { EmitResult } from './backend.js';
import { isEmitFailure } from './backend.js';

export interface EmitMapping {
  readonly source: KojoSpan | null;
  /** 缺省：有源 → 'source'，无源 → 'generated' */
  readonly kind?: SourceMapLineKind;
  readonly origins?: readonly SourceMapOrigin[];
  /**
   * 随行一起登记的**列级分段**（additive；列相对该产物行）。
   * `endColumn` 缺省时按该行文本的码元宽度补成 `行宽 + 1`（排他）——这里知道行文本，
   * 所以调用方只需要给"从第几列起"；空行没有可覆盖的列，规格被跳过（不造 [1,1) 空段）。
   */
  readonly segments?: readonly SourceMapSegmentSpec[];
}

export interface EmitFinish {
  readonly lines: readonly string[];
  readonly sourceMap: SourceMap;
}

export interface EmitBuffer {
  readonly lineCount: number;
  /** 追加一行（带映射） */
  push(line: string, mapping: EmitMapping): void;
  /** 追加一次 backend 发射结果：0/1/多行 / fail-closed（诊断原样收下，**不产字节**） */
  pushEmitted(result: EmitResult, mapping: EmitMapping, sink: DiagnosticSink): void;
  /** 列级细化（additive；`generatedLine` 必须已 push 过） */
  segment(generatedLine: number, generatedColumn: number, source: KojoSpan | null): void;
  /** 已写入的行（`finish()` 前是预分配数组的只读视图，长度 = lineCount） */
  readonly lines: readonly string[];
  finish(): EmitFinish;
}

export function createEmitBuffer(estimatedLines = 256): EmitBuffer {
  const capacity = Math.max(8, Math.trunc(estimatedLines) || 8);
  const lines = new Array<string>(capacity);
  const map = createSourceMapBuilder();
  let count = 0;
  let finished: EmitFinish | null = null;

  const ensureOpen = (): void => {
    if (finished !== null) throw new Error('[lower] 缓冲区已 finish()，不能再追加（单向数据流）');
  };

  const push = (line: string, mapping: EmitMapping): void => {
    ensureOpen();
    const generatedLine = count + 1;
    const kind = mapping.kind ?? (mapping.source === null ? 'generated' : 'source');
    lines[count] = line;
    count++;
    map.appendLine({
      generatedLine,
      kind,
      source: mapping.source,
      ...(mapping.origins === undefined ? {} : { origins: mapping.origins }),
    });
    const specs = mapping.segments;
    if (specs === undefined || specs.length === 0) return;
    for (const spec of specs) {
      // 终点缺省 = 该行全部码元（`line.length` 是 UTF-16 码元数，与 source map 列口径一致）
      const endColumn = spec.endColumn ?? line.length + 1;
      if (endColumn <= spec.startColumn) continue; // 空行 / 零宽规格：没有可覆盖的列，不造空段
      map.appendSegment({
        generatedLine,
        generatedColumn: spec.startColumn,
        source: spec.source,
        endColumn,
        ...(spec.kind === undefined ? {} : { kind: spec.kind }),
        ...(spec.origins === undefined ? {} : { origins: spec.origins }),
      });
    }
  };

  const pushEmitted = (result: EmitResult, mapping: EmitMapping, sink: DiagnosticSink): void => {
    if (result === null) return;
    if (typeof result === 'string') {
      push(result, mapping);
      return;
    }
    if (isEmitFailure(result)) {
      for (const diagnostic of result.diagnostics) sink.report(diagnostic);
      return;
    }
    // 多行：每行都指向同一源（模板/池展开的一源多产物就是这个形状）
    for (const line of result) push(line, mapping);
  };

  const finish = (): EmitFinish => {
    if (finished !== null) return finished;
    if (count < lines.length) lines.length = count;
    finished = { lines, sourceMap: map.build() };
    return finished;
  };

  return {
    get lineCount() {
      return count;
    },
    get lines() {
      return lines;
    },
    push,
    pushEmitted,
    segment(generatedLine: number, generatedColumn: number, source: KojoSpan | null): void {
      ensureOpen();
      map.appendSegment({ generatedLine, generatedColumn, source });
    },
    finish,
  };
}
