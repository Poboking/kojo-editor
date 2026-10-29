/**
 * Kojo 2.0 端到端编译入口（C2 完结点）：一个 `KojoFile` → 产物 ERB + source map + 诊断。
 *
 * 定位（设计稿 §1.1 / §16.2）：
 * - core 内部：按 `scenes` 顺序降糖；`# 对照表` / `# 池` / `# 模` 在**引用点展开**；
 *   `@织` 走事件目录校验 + 事件头装配；`# 机` 走 `backend.wrapMachine`；
 *   source map 每行登记（含模板/池双向 origins、`# 机` 包装事件头 origin）。
 * - 外注边界：`adapter`（游戏事实：事件目录）与 `backend`（产物形状）都由调用方注入；
 *   本模块**纯函数、零 IO、零 Monaco、零游戏名词**。
 * - fail-closed：任何 error → `ok:false`、`erb:''`、`sourceMap.lineCount===0`
 *   （不产半成品字节/映射）。
 */
import type { KojoFile } from './ast.js';
import type { GameAdapter } from './adapter.js';
import type { DiagnosticSink, KojoDiagnostic } from './diagnostics.js';
import type { KojoEmitBackend, KojoHiddenSlot } from './lower/backend.js';
import { runCompile } from './lower/expand/index.js';
import type { RunCompileResult } from './lower/expand/index.js';
import { parseSource } from './parser.js';
import type { SourceMap } from './source-map.js';

export interface CompileKojoFileOptions {
  /** 游戏事实（事件目录 / profile / presentation） */
  readonly adapter: GameAdapter;
  /** 产物形状（PRINT 变体 / HPH / 着色 / 随机落点 / 织入 / `# 机` 包装）；由宿主或 adapter 注入 */
  readonly backend: KojoEmitBackend;
  /** 当前 `# 视` 目标（池内裸引号默认说话人）；缺省从文件的 `# 视` 声明取 */
  readonly view?: string | null;
  /** 源文本（预分配行数估算） */
  readonly sourceText: string;
  /** 预分配行数（大文件传入估算值） */
  readonly estimatedLines?: number;
  /** 外部诊断收集器（多文件共用时传入） */
  readonly sink?: DiagnosticSink;
}

export interface CompileKojoResult {
  readonly ok: boolean;
  /** 产物文本；`ok === false` 时恒为 `''`（fail-closed，不产半成品字节） */
  readonly erb: string;
  readonly sourceMap: SourceMap;
  readonly diagnostics: readonly KojoDiagnostic[];
  /** 本文件用到的隐藏槽（去重、稳定序；装配层据此发声明） */
  readonly slots: readonly KojoHiddenSlot[];
}

/**
 * 编译一个 2.0 源文件（题面主入口）。
 *
 * 口径：成功产物 `lines.join('\n') + '\n'`（空产物 = `''`），
 * `sourceMap.lineCount === erb 行数`；任何 error ⇒ `erb:''` + 空 source map。
 */
export function compileKojoFile(file: KojoFile, options: CompileKojoFileOptions): CompileKojoResult {
  const result: RunCompileResult = runCompile(file, {
    adapter: options.adapter,
    backend: options.backend,
    view: options.view,
    sourceText: options.sourceText,
    estimatedLines: options.estimatedLines,
    sink: options.sink,
  });
  return { ok: result.ok, erb: result.erb, sourceMap: result.sourceMap, diagnostics: result.diagnostics, slots: result.slots };
}

/** 源码文本入口（宿主/服务层便捷通道：内部 = lex → parse → compileKojoFile） */
export interface CompileKojoSourceInput {
  /** 2.0 源文本 */
  readonly source: string;
  /** 只给宿主做身份/日志：core 不读盘、不进诊断（诊断不带文件身份） */
  readonly filePath?: string;
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
  readonly view?: string | null;
  readonly estimatedLines?: number;
  readonly sink?: DiagnosticSink;
}

export interface CompileKojoSourceResult extends CompileKojoResult {
  /** lex→parse 的树（预览/调试用；与编译同一份，零拷贝） */
  readonly file: KojoFile;
}

/** 编译一段 2.0 源码文本（解析诊断自动并入；不读盘） */
export function compileKojoSource(input: CompileKojoSourceInput): CompileKojoSourceResult {
  const file = parseSource(input.source);
  const result = compileKojoFile(file, {
    adapter: input.adapter,
    backend: input.backend,
    view: input.view,
    sourceText: input.source,
    estimatedLines: input.estimatedLines,
    sink: input.sink,
  });
  return { ...result, file };
}
