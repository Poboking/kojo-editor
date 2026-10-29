/**
 * Kojo 2.0 诊断 → Monaco markers（K2-EDITOR-DIAGNOSTICS）。
 *
 * ## 定位
 *
 * core 产出的 {@link KojoDiagnostic} 已经带"1 基行 / 1 基列、UTF-16 码元"的半开区间
 * （`KojoSpan`，与 Monaco 同坐标系）。本文件只做三件事：
 *
 * 1. **调公共编译入口**：`compileKojoSource`（内部 `lex → parse → compileKojoFile`），
 *    拿回诊断；不读盘、不缓存、不碰 Monaco 运行时。
 * 2. **事实注入**：真实游戏事实（`GameAdapter`）与产物形状（`KojoEmitBackend`）必须由
 *    宿主成对注入；两者都省略时退到**诊断模式**（core 的 fixture adapter/backend）。
 *    诊断模式只适合"没有游戏事实也要看语法/结构错误"的场景（如未接线的早期预览）；
 *    正式编辑器应注入真实 adapter/backend，否则游戏事实面的诊断会按 fixture 判。
 * 3. **翻译成 `IMarkerData`**：severity / code / source / 区间一律在这里定；**落点安全**
 *    由纯函数完成（不依赖 model）：跨行保留、零宽扩成一格、越界夹回、缺 span 退到文件头。
 *
 * ## 为什么不碰 Monaco 实例
 *
 * 编译器与坐标换算都是纯逻辑，测试在 node 池里跑（起不来编辑器）。`monaco` 只以
 * `Pick<typeof Monaco, 'MarkerSeverity'>` 的形状传入，换算函数本身不调用任何编辑器 API。
 */

import type * as Monaco from './entry';
import type {
  GameAdapter,
  KojoDiagnostic,
  KojoEmitBackend,
  KojoSpan,
  SourceMap,
} from '@kojo/kojo-core';
import {
  FIXTURE_ADAPTER,
  FIXTURE_BACKEND,
  compileKojoSource,
} from '@kojo/kojo-core';

/** 悬浮 / 问题面板里显示的来源标签（与 v1 的 `结构解析` 等标签并列时不撞名） */
export const KOJO2_DIAGNOSTICS_SOURCE = 'Kojo 2.0';

/** 诊断入口的输入：源文本 + 文件身份（`filePath` 只做身份，core 不读盘） */
export interface Kojo2DiagnosticsInput {
  readonly source: string;
  readonly filePath: string;
}

/**
 * 编译入口的最小产物形状（默认实现是 core `compileKojoSource`；测试可注入替身）。
 *
 * `erb` / `sourceMap` 是**additive 可选项**（K2-EDITOR-MOUNT ①）：诊断链路本来就把它们
 * 算出来了（core `CompileKojoResult` 结构兼容），只是过去在这里被丢掉。填上它们，
 * 预览面板才能消费**同一次**编译的产物与 source map——两处各编译一次是两份不同源的
 * 结果，错位会静默跳到隔壁行。
 */
export interface Kojo2DiagnosticCompileResult {
  readonly diagnostics: readonly KojoDiagnostic[];
  /** 同一次编译的产物文本；省略 = 这个入口只提供诊断（预览不亮） */
  readonly erb?: string;
  /** 与 `erb` **同一次**编译的 source map；与 `erb` 成对出现 */
  readonly sourceMap?: SourceMap;
}

/** 一次编译里"预览真正要"的那两格（诊断结果自带的产物，K2-EDITOR-MOUNT ①） */
export interface Kojo2DiagnosticsArtifacts {
  /** 产物文本（core 成功口径：`lines.join('\n') + '\n'`；编译失败 = `''`） */
  readonly erb: string;
  /** 与 `erb` 同一次编译的 source map（`lineCount === splitKojoGeneratedLines(erb).length`） */
  readonly sourceMap: SourceMap;
}

/** 编译入口端口：source + filePath → 诊断（同步；异步由上层 sync 模块负责） */
export type Kojo2DiagnosticCompile = (
  input: Kojo2DiagnosticsInput,
) => Kojo2DiagnosticCompileResult;

/** marker 换算只需要 `MarkerSeverity` 这一格（避免把整个 Monaco 运行时拖进纯逻辑） */
export type Kojo2MarkerSeveritySource = Pick<typeof Monaco, 'MarkerSeverity'>;

export interface Kojo2DiagnosticsOptions {
  /** Monaco 的 severity 表（宿主传真实例；测试传同形状替身） */
  readonly monaco: Kojo2MarkerSeveritySource;
  /** 游戏事实；与 `backend` 成对出现 */
  readonly adapter?: GameAdapter;
  /** 产物形状；与 `adapter` 成对出现 */
  readonly backend?: KojoEmitBackend;
  /** 替换编译入口（测试 / 未来 worker）；给出时忽略 adapter/backend */
  readonly compile?: Kojo2DiagnosticCompile;
  /** 当前 `# 视角` 目标（缺省 = 文件里的 `# 视角` 声明） */
  readonly view?: string | null;
  /** 大文件预分配产物行数 */
  readonly estimatedLines?: number;
}

/** 一次诊断的完整结果：原始诊断 + 已翻译的 markers + 失败读数 */
export interface Kojo2DiagnosticsResult {
  readonly filePath: string;
  readonly diagnostics: readonly KojoDiagnostic[];
  readonly markers: readonly Monaco.editor.IMarkerData[];
  /**
   * 同一次编译的产物 + source map（K2-EDITOR-MOUNT ①；`null` = 这一轮没有可预览的产物）。
   *
   * **可省略**：注入的编译入口只答诊断（旧替身 / 未来的纯诊断 worker）时不提供，
   * 消费方按"没有产物"处理。本服务自己产出的结果总是显式给 `null` 或对象。
   */
  readonly artifacts?: Kojo2DiagnosticsArtifacts | null;
  /**
   * **方言体检**的结论（LAU-D2；`undefined` = 这一轮没跑体检 / 方言未绑定）。
   *
   * 与 `diagnostics` / `markers` **分家**：体检是按 `(码, 方言)` 聚合的清单（§5.5 呈现纪律），
   * 不产波浪线、不进 `errorCount`——它回答"这个工程有哪些方言面不成立"，而波浪线回答
   * "这一行为什么红"。上屏走问题面板的汇总行（`ui/kojo2-problem-wiring.ts`）。
   */
  readonly lint?: {
    readonly dialect: string;
    readonly diagnostics: readonly KojoDiagnostic[];
  };
  /** 编译入口抛错时的消息（`null` = 编译入口正常返回；不是诊断） */
  readonly error: string | null;
  readonly errorCount: number;
  readonly warningCount: number;
  /** 无 error 诊断且编译入口未抛错 */
  readonly ok: boolean;
}

export interface Kojo2DiagnosticsService {
  diagnose(input: Kojo2DiagnosticsInput): Kojo2DiagnosticsResult;
}

interface ResolvedFacts {
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
}

/** 未注入编译入口时：adapter/backend 必须成对；都缺省 = 诊断模式（fixture） */
function resolveFacts(options: Kojo2DiagnosticsOptions): ResolvedFacts {
  if (options.adapter !== undefined && options.backend !== undefined) {
    return { adapter: options.adapter, backend: options.backend };
  }
  if (options.adapter !== undefined || options.backend !== undefined) {
    throw new TypeError(
      'Kojo 2.0 诊断：adapter 与 backend 必须成对注入（缺一就无法判断游戏事实）；' +
        '两者都省略时走诊断模式（fixture）。',
    );
  }
  return { adapter: FIXTURE_ADAPTER, backend: FIXTURE_BACKEND };
}

function resolveCompile(options: Kojo2DiagnosticsOptions): Kojo2DiagnosticCompile {
  if (options.compile !== undefined) return options.compile;
  const facts = resolveFacts(options);
  return (input) =>
    compileKojoSource({
      source: input.source,
      filePath: input.filePath,
      adapter: facts.adapter,
      backend: facts.backend,
      view: options.view,
      estimatedLines: options.estimatedLines,
    });
}

function assertInput(input: Kojo2DiagnosticsInput): void {
  if (typeof input.source !== 'string') {
    throw new TypeError('Kojo 2.0 诊断输入 source 必须是字符串');
  }
  if (typeof input.filePath !== 'string' || input.filePath.trim().length === 0) {
    throw new TypeError('Kojo 2.0 诊断输入 filePath 不能为空（诊断身份依赖它）');
  }
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

function countSeverity(
  diagnostics: readonly KojoDiagnostic[],
  severity: KojoDiagnostic['severity'],
): number {
  let count = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === severity) count += 1;
  }
  return count;
}

/**
 * 创建一个诊断服务（纯函数面：同输入同输出；不读盘、不缓存）。
 *
 * ```ts
 * const diagnostics = createKojo2Diagnostics({ monaco, adapter, backend });
 * const result = diagnostics.diagnose({ source, filePath });
 * monaco.editor.setModelMarkers(model, owner, [...result.markers]);
 * ```
 */
export function createKojo2Diagnostics(
  options: Kojo2DiagnosticsOptions,
): Kojo2DiagnosticsService {
  const compile = resolveCompile(options);
  return {
    diagnose(input) {
      assertInput(input);
      let diagnostics: readonly KojoDiagnostic[] = [];
      let markers: readonly Monaco.editor.IMarkerData[] = [];
      let artifacts: Kojo2DiagnosticsArtifacts | null = null;
      let error: string | null = null;
      try {
        const compiled = compile(input);
        if (!Array.isArray(compiled.diagnostics)) {
          throw new TypeError('Kojo 2.0 诊断：编译入口返回的 diagnostics 必须是数组');
        }
        diagnostics = compiled.diagnostics;
        markers = kojo2DiagnosticsToMarkers(options.monaco, diagnostics, input.source);
        // 一次编译两处消费（K2-EDITOR-MOUNT ①）：产物与 source map 只在**同一支编译入口**
        // 里成对出现，缺一半就当没有（不拿上一轮的 map 配这一轮的产物）。
        if (typeof compiled.erb === 'string' && compiled.sourceMap !== undefined) {
          artifacts = { erb: compiled.erb, sourceMap: compiled.sourceMap };
        }
      } catch (thrown) {
        // 编译入口抛错不是"没有诊断"：保留 error 读数，markers 清空（上层据此清旧波浪线）；
        // 产物同样作废（半成品字节不许进预览）。
        error = messageOf(thrown);
        diagnostics = [];
        markers = [];
        artifacts = null;
      }
      const errorCount = countSeverity(diagnostics, 'error');
      return {
        filePath: input.filePath,
        diagnostics,
        markers,
        artifacts,
        error,
        errorCount,
        warningCount: countSeverity(diagnostics, 'warning'),
        ok: error === null && errorCount === 0,
      };
    },
  };
}

/** 一次性便捷入口（无状态调用；同一份 source 反复调用请用 {@link createKojo2Diagnostics}） */
export function diagnoseKojo2Source(
  input: Kojo2DiagnosticsInput,
  options: Kojo2DiagnosticsOptions,
): Kojo2DiagnosticsResult {
  return createKojo2Diagnostics(options).diagnose(input);
}

/* ============================== 诊断 → markers ============================== */

interface SourceLineIndex {
  readonly lineCount: number;
  clampLine(value: number): number;
  lineMaxColumn(line: number): number;
  charCodeAt(line: number, column: number): number;
}

/**
 * 源文本行索引（1 基行 / 1 基列，UTF-16 码元）。
 *
 * 与 Monaco 的 model 坐标口径一致：列 = 码元数 + 1（行尾光标位）；CRLF 的 `\r` 不计入
 * 行宽（Monaco 模型内换行被归一成 `\n`，源文本可能仍是 CRLF，落点必须同一口径）。
 */
function createSourceLineIndex(source: string): SourceLineIndex {
  const lineStarts: number[] = [0];
  for (let offset = 0; offset < source.length; offset += 1) {
    if (source.charCodeAt(offset) === 10) lineStarts.push(offset + 1);
  }
  const lineCount = lineStarts.length;
  const startOf = (line: number): number => lineStarts[line - 1] ?? 0;
  const endOf = (line: number): number => {
    const nextStart = lineStarts[line];
    const rawEnd = nextStart === undefined ? source.length : nextStart - 1;
    if (rawEnd > startOf(line) && source.charCodeAt(rawEnd - 1) === 13) return rawEnd - 1;
    return rawEnd;
  };
  return {
    lineCount,
    clampLine(value) {
      const line = Number.isFinite(value) ? Math.trunc(value) : 1;
      return Math.min(Math.max(1, line), lineCount);
    },
    lineMaxColumn(line) {
      return Math.max(1, endOf(line) - startOf(line) + 1);
    },
    charCodeAt(line, column) {
      if (column < 1) return -1;
      const offset = startOf(line) + column - 1;
      if (offset >= endOf(line)) return -1;
      return source.charCodeAt(offset);
    },
  };
}

function clampColumn(index: SourceLineIndex, line: number, value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(1, Math.trunc(value)), index.lineMaxColumn(line));
}

interface NormalizedMarkerSpan {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 零宽诊断（起点 == 终点）扩成一格：Monaco 对零宽 marker 不画波浪线，问题面板里也难点回。
 *
 * 扩宽不切断代理对：落在低代理上时向左含住高代理；落在高代理上时向右含住低代理。
 * 行尾（列 = 行宽 + 1）向左扩；空行无处可扩，保留 `[1, 1]`（坐标仍合法）。
 */
function widenZeroWidth(index: SourceLineIndex, span: NormalizedMarkerSpan): NormalizedMarkerSpan {
  const { startLine, startColumn } = span;
  const maxColumn = index.lineMaxColumn(startLine);
  if (maxColumn <= 1) {
    return { startLine, startColumn: 1, endLine: startLine, endColumn: 1 };
  }
  if (startColumn < maxColumn) {
    const code = index.charCodeAt(startLine, startColumn);
    if (isLowSurrogate(code) && startColumn > 1) {
      return {
        startLine,
        startColumn: startColumn - 1,
        endLine: startLine,
        endColumn: startColumn + 1,
      };
    }
    if (isHighSurrogate(code) && isLowSurrogate(index.charCodeAt(startLine, startColumn + 1))) {
      return { startLine, startColumn, endLine: startLine, endColumn: startColumn + 2 };
    }
    return { startLine, startColumn, endLine: startLine, endColumn: startColumn + 1 };
  }
  const lastColumn = maxColumn - 1;
  const lastCode = index.charCodeAt(startLine, lastColumn);
  if (isLowSurrogate(lastCode) && lastColumn > 1) {
    return { startLine, startColumn: lastColumn - 1, endLine: startLine, endColumn: maxColumn };
  }
  return { startLine, startColumn: Math.max(1, lastColumn), endLine: startLine, endColumn: maxColumn };
}

/**
 * 把 core span 收进模型现实：
 *
 * - 缺 span / 逆序 / 越界 ⇒ 夹到合法范围（缺 span 退到文件头）；
 * - 跨行保留（Monaco 支持多行 marker），但终点必须严格晚于起点；
 * - 同行零宽 ⇒ {@link widenZeroWidth} 扩一格。
 */
function normalizeSpan(span: KojoSpan | null, index: SourceLineIndex): NormalizedMarkerSpan {
  if (span === null) {
    return widenZeroWidth(index, {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
    });
  }
  const startLine = index.clampLine(span.start.line);
  let endLine = index.clampLine(span.end.line);
  const startColumn = clampColumn(index, startLine, span.start.column);
  let endColumn = clampColumn(index, endLine, span.end.column);
  if (endLine < startLine || (endLine === startLine && endColumn < startColumn)) {
    endLine = startLine;
    endColumn = startColumn;
  }
  const normalized: NormalizedMarkerSpan = {
    startLine,
    startColumn,
    endLine,
    endColumn,
  };
  if (startLine === endLine && startColumn === endColumn) {
    return widenZeroWidth(index, normalized);
  }
  return normalized;
}

function markerSeverity(
  monaco: Kojo2MarkerSeveritySource,
  severity: KojoDiagnostic['severity'],
): Monaco.MarkerSeverity {
  // 只认 core 的两档；意外的 severity 一律按 error（fail-visible，不静默降级成提示）
  return severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error;
}

/**
 * `KojoDiagnostic[]` → Monaco markers。
 *
 * 坐标只在这里换一次：core 的 1 基 UTF-16 span 已是 Monaco 口径，**不做** 0/1 基加减；
 * 只做越界夹取、零宽扩格与代理对保护。`code` 原样进 marker（快速修复 / 问题面板按它归组），
 * `source` 固定为 {@link KOJO2_DIAGNOSTICS_SOURCE}（"这条是哪一层说的"）。
 */
export function kojo2DiagnosticsToMarkers(
  monaco: Kojo2MarkerSeveritySource,
  diagnostics: readonly KojoDiagnostic[],
  sourceText: string,
): Monaco.editor.IMarkerData[] {
  const index = createSourceLineIndex(sourceText);
  return diagnostics.map((diagnostic) => {
    const span = normalizeSpan(diagnostic.span, index);
    return {
      severity: markerSeverity(monaco, diagnostic.severity),
      message: diagnostic.message,
      code: diagnostic.code,
      source: KOJO2_DIAGNOSTICS_SOURCE,
      startLineNumber: span.startLine,
      startColumn: span.startColumn,
      endLineNumber: span.endLine,
      endColumn: span.endColumn,
    };
  });
}
