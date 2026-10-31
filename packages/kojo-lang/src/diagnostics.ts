/**
 * Kojo 2.0 **文档级诊断**的判据（B3 语言面收口最后一格，2026-10-30）。
 *
 * ## 这里回答什么
 *
 * "这份 2.0 正文此刻有哪些**逐行**问题"——单文件、随正文变化、要画成波浪线的东西。
 * 判据分三段，全部住在本文件：
 *
 * 1. **编译**：`compileKojoSource`（core 的纯函数；adapter / backend 由调用方按项目注入）；
 * 2. **落点归一**：core 诊断的 1 基 UTF-16 span → 契约可消费的行 / 列区间
 *    （越界夹回、缺 span 退文件头、零宽扩一格且不劈开代理对、跨行保留）；
 * 3. **失败口径**：编译入口抛错 = 这一轮"没有诊断"且**错误可见**（`error` 非空、行清空），
 *    绝不静默当成"这份文件干净"。
 *
 * ## 为什么判据在包、不在宿主（与 B3c–B3j 同一条纪律）
 *
 * 供方是 `@kojo/plugin-kojo-lang`（经槽 `ui.editor.decorator` 作答），插件看不见
 * `packages/app/src/**`。判据留在宿主，插件只能抄第二份；两份判据必然漂——这不只是风格问题：
 * 波浪线的条数 / 严重级 / 码 / 区间是作者判断"哪一行坏了"的唯一依据。
 *
 * ## 两条取数缝（同 `adapter-source` 的范式）
 *
 * 诊断要的**两面**（`GameAdapter` 事件目录 + `KojoEmitBackend` 落点形状）只在宿主组合根手里：
 * backend 工厂住在各游戏 adapter 包里，插件既不能 import 宿主，也不能跨插件 import。
 * 所以宿主在装配时登记一枚 `(filePath) => 两面` 的 getter，插件在**请求时**现取
 * （`kojo2SurfaceNow`）。零登记 ⇒ `null` ⇒ 供方如实报"没有 2.0 诊断面"（不猜、不借别家事实）。
 *
 * ## 与项目级诊断的界线
 *
 * 项目级（跨文件重名 / Layer / 接管 / 存储期）由宿主 `project-diagnostics` ＋
 * `kojo2-project-analysis` 在 `mountProjectScan` 里跑，判据不在本文件、也不经本文件——
 * 那一轮扫描给装饰贡献的载荷带 `bulk: true`，插件据此**弃权**（见插件侧 `diagnostics.ts`
 * 头注：`.kojo` 上 v1 糖线与 2.0 编译两份结论若同时进扫描轮，问题面板会双份计数）。
 *
 * 纯函数 / 纯数据：零 Monaco、零 React、零 IO；只依赖 `@kojo/kojo-core`。
 */
import type {
  GameAdapter,
  KojoDiagnostic,
  KojoEmitBackend,
  KojoSpan,
  SourceMap,
} from '@kojo/kojo-core';
import { clampColumn as coreClampColumn, clampLine as coreClampLine, compileKojoSource, createPositionIndex } from '@kojo/kojo-core';

/** 悬浮 / 问题面板里显示的来源标签（与 v1 的「结构解析」等标签并列时不撞名） */
export const KOJO2_DIAGNOSTIC_SOURCE = 'Kojo 2.0';

/** 槽 `ui.editor.decorator` 里本供方的稳定 id（宿主按它找"2.0 文档级诊断"这一家） */
export const KOJO2_DIAGNOSTICS_CONTRIBUTION_ID = 'kojo2-diagnostics';

/* ============================== 两面来源（宿主登记） ============================== */

/** 一份 2.0 诊断需要的**两面**：游戏事实（adapter）+ 产物形状（backend） */
export interface Kojo2DiagnosticSurface {
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
}

/**
 * 按文件路径取两面的 getter（`null` / `undefined` = 此刻这个项目没有 2.0 诊断面）。
 *
 * 参数是**文件路径**而不是 adapterId：文件级角色号（`charNo`）由宿主按路径从
 * `GameProject.charaIndex` 推，backend 工厂要它才能装配 `# 机` 事件头——这属于组合根的
 * "取数"，不是判据，所以不搬进本包。
 */
export type Kojo2SurfaceSource = (filePath: string) => Kojo2DiagnosticSurface | null | undefined;

/** 登记顺序 = 查询顺序的逆序（后登记的优先：最新装配的那一份才是当前的） */
const surfaceSources: Kojo2SurfaceSource[] = [];

/** 登记一枚 getter；返回**只撤自己**的注销函数（重复调用幂等）。 */
export function registerKojo2SurfaceSource(source: Kojo2SurfaceSource): () => void {
  surfaceSources.push(source);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const at = surfaceSources.lastIndexOf(source);
    if (at >= 0) surfaceSources.splice(at, 1);
  };
}

/**
 * 此刻这份文件的两面（没有登记 / getter 抛错 / 形状不对 ⇒ `null`）。
 *
 * **不缓存**、**不按项目过滤**：两者都归调用方——项目开闭会换人，缓存会把上一个项目的
 * 事实带过来；"这份请求是不是当前项目的活"要看请求自带的项目身份。
 */
export function kojo2SurfaceNow(filePath: string): Kojo2DiagnosticSurface | null {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  for (let index = surfaceSources.length - 1; index >= 0; index--) {
    const source = surfaceSources[index]!;
    let surface: Kojo2DiagnosticSurface | null | undefined;
    try {
      surface = source(filePath);
    } catch {
      continue; // 这一枚取不出（组合根正在重建等）⇒ 问下一枚，不把异常带出去
    }
    if (surface === null || surface === undefined) continue;
    if (typeof surface !== 'object') continue;
    if (typeof surface.adapter !== 'object' || surface.adapter === null) continue;
    if (typeof surface.backend !== 'object' || surface.backend === null) continue;
    return surface;
  }
  return null;
}

/** 当前登记了几枚（观测面：测试钉"注销不留登记"） */
export function kojo2SurfaceSourceCount(): number {
  return surfaceSources.length;
}

/* ============================== 诊断 → 行（落点归一） ============================== */

/**
 * 一条文档级诊断的**最终落点**（1 基行 / 1 基列、UTF-16 码元、半开区间）。
 *
 * 形状刻意与 `@kojo/plugin-api` 的 `LineDecoration` 同构（含跨行 `endLine`），但本包
 * **不 import 契约**（包的依赖白名单只有 core / vocab / sdk）：翻译成槽形状是插件那一侧的事。
 */
export interface Kojo2DiagnosticRow {
  /** 1 基起始行 */
  readonly line: number;
  /** 1 基起始列（含） */
  readonly startColumn: number;
  /** 1 基结束行（`> line` 即跨行诊断；Monaco marker 原生支持） */
  readonly endLine: number;
  /** 1 基结束列（**不含**） */
  readonly endColumn: number;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly code: string;
}

/** 文档级诊断要的全部结果（宿主据此翻译 markers / 问题面板行 / 预览产物） */
export interface Kojo2DocumentDiagnosticsResult {
  readonly filePath: string;
  readonly rows: readonly Kojo2DiagnosticRow[];
  /** core 的原始诊断（方言体检要按码筛，所以原样交出去，不让调用方从行反推） */
  readonly diagnostics: readonly KojoDiagnostic[];
  /** 同一次编译的产物与 source map（成对；`null` = 这一轮没有可预览的字节） */
  readonly artifacts: Kojo2DocumentArtifacts | null;
  /** 编译入口抛错时的消息（`null` = 正常返回；不是诊断） */
  readonly error: string | null;
  readonly errorCount: number;
  readonly warningCount: number;
  /** 无 error 诊断且编译入口未抛错 */
  readonly ok: boolean;
}

/** 产物 + 与它**同一次**编译的 source map */
export interface Kojo2DocumentArtifacts {
  /** 产物文本（core 成功口径：`lines.join('\n') + '\n'`；编译失败 = `''`） */
  readonly erb: string;
  /** 与 `erb` 同一次编译的 source map（`lineCount === splitKojo2GeneratedLines(erb).length`） */
  readonly sourceMap: SourceMap;
}

/** 诊断入口的输入：源文本 + 文件身份（`filePath` 只做身份，core 不读盘） */
export interface Kojo2DocumentDiagnosticsInput {
  readonly source: string;
  /** 文件身份（诊断条目不带路径；宿主按它入账） */
  readonly filePath: string;
  /** 游戏事实（与 `backend` 成对注入） */
  readonly adapter: GameAdapter;
  /** 产物形状（与 `adapter` 成对注入） */
  readonly backend: KojoEmitBackend;
  /** 当前 `# 视角` 目标（缺省 = 文件里的 `# 视角` 声明） */
  readonly view?: string | null;
  /** 大文件预分配产物行数 */
  readonly estimatedLines?: number;
}

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
 *
 * **行首表 / 行宽 / 夹取的实现全在 core**（`@kojo/kojo-core` 的 `createPositionIndex`、
 * `clampLine`、`clampColumn`，POS-UTIL 收口）：本函数只是"按行取码元"这一层薄外衣，
 * 不再自建第二份行首表。
 */
function createSourceLineIndex(source: string): SourceLineIndex {
  const index = createPositionIndex(source);
  return {
    lineCount: index.lineCount,
    clampLine(value) {
      return coreClampLine(value, index.lineCount);
    },
    lineMaxColumn(line) {
      return index.lineMaxColumn(line);
    },
    charCodeAt(line, column) {
      if (column < 1) return -1;
      const at = coreClampLine(line, index.lineCount);
      if (column > index.lineWidth(at)) return -1;
      return source.charCodeAt(index.lineStart(at) + column - 1);
    },
  };
}

/** 列夹取（规则在 core `clampColumn`：非有限 / 越界都落到该行合法列，不抛错） */
function clampColumn(index: SourceLineIndex, line: number, value: number): number {
  return coreClampColumn(value, index.lineMaxColumn(line));
}

interface NormalizedRowSpan {
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
function widenZeroWidth(index: SourceLineIndex, span: NormalizedRowSpan): NormalizedRowSpan {
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
 * 把 core span 收进源文本的现实：
 *
 * - 缺 span / 逆序 / 越界 ⇒ 夹到合法范围（缺 span 退到文件头）；
 * - 跨行保留（Monaco 支持多行 marker），但终点必须严格晚于起点；
 * - 同行零宽 ⇒ {@link widenZeroWidth} 扩一格。
 */
function normalizeSpan(span: KojoSpan | null, index: SourceLineIndex): NormalizedRowSpan {
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
  const normalized: NormalizedRowSpan = { startLine, startColumn, endLine, endColumn };
  if (startLine === endLine && startColumn === endColumn) {
    return widenZeroWidth(index, normalized);
  }
  return normalized;
}

/**
 * `KojoDiagnostic[]` → 契约落点行。
 *
 * 坐标只在这里换一次：core 的 1 基 UTF-16 span 已是 Monaco 口径，**不做** 0/1 基加减；
 * 只做越界夹取、零宽扩格与代理对保护。严重级只认 core 的两档；意外值按 `error`
 * （fail-visible，不静默降级成提示）。
 *
 * 方言诊断（`core/dialect/*`）并进同一批波浪线时也走这里——同一把尺子量两次，
 * 两处区间才会逐字相同。
 */
export function kojo2RowsOfDiagnostics(
  diagnostics: readonly KojoDiagnostic[],
  sourceText: string,
): Kojo2DiagnosticRow[] {
  const index = createSourceLineIndex(sourceText);
  return diagnostics.map((diagnostic) => {
    const span = normalizeSpan(diagnostic.span, index);
    return {
      line: span.startLine,
      startColumn: span.startColumn,
      endLine: span.endLine,
      endColumn: span.endColumn,
      severity: diagnostic.severity === 'warning' ? 'warning' : 'error',
      message: diagnostic.message,
      code: diagnostic.code,
    };
  });
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
 * 跑一轮**文档级诊断**（纯函数面：同输入同输出；不读盘、不缓存）。
 *
 * 失败口径与 K2-EDITOR-DIAGNOSTICS 逐字一致：编译入口抛错 ⇒ `error` 非空、`rows` /
 * `diagnostics` 清空、`artifacts` 作废（半成品字节不许进预览），上层据此把"没有诊断"
 * 说出口（铁律 4）；不把异常压成"零诊断"。
 */
export function kojo2DocumentDiagnostics(
  input: Kojo2DocumentDiagnosticsInput,
): Kojo2DocumentDiagnosticsResult {
  if (typeof input.source !== 'string') {
    throw new TypeError('Kojo 2.0 诊断输入 source 必须是字符串');
  }
  if (typeof input.filePath !== 'string' || input.filePath.trim().length === 0) {
    throw new TypeError('Kojo 2.0 诊断输入 filePath 不能为空（诊断身份依赖它）');
  }
  let diagnostics: readonly KojoDiagnostic[] = [];
  let rows: readonly Kojo2DiagnosticRow[] = [];
  let artifacts: Kojo2DocumentArtifacts | null = null;
  let error: string | null = null;
  try {
    const compiled = compileKojoSource({
      source: input.source,
      filePath: input.filePath,
      adapter: input.adapter,
      backend: input.backend,
      view: input.view,
      estimatedLines: input.estimatedLines,
    });
    if (!Array.isArray(compiled.diagnostics)) {
      throw new TypeError('Kojo 2.0 诊断：编译入口返回的 diagnostics 必须是数组');
    }
    diagnostics = compiled.diagnostics;
    rows = kojo2RowsOfDiagnostics(diagnostics, input.source);
    // 一次编译两处消费：产物与 source map 只在**同一支编译入口**里成对出现，
    // 缺一半就当没有（不拿上一轮的 map 配这一轮的产物）。
    if (typeof compiled.erb === 'string' && compiled.sourceMap !== undefined) {
      artifacts = { erb: compiled.erb, sourceMap: compiled.sourceMap };
    }
  } catch (thrown) {
    error = messageOf(thrown);
    diagnostics = [];
    rows = [];
    artifacts = null;
  }
  const errorCount = countSeverity(diagnostics, 'error');
  return {
    filePath: input.filePath,
    rows,
    diagnostics,
    artifacts,
    error,
    errorCount,
    warningCount: countSeverity(diagnostics, 'warning'),
    ok: error === null && errorCount === 0,
  };
}