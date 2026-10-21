/**
 * Kojo 2.0 转译服务（`kojo-sugar` 的开发期**并存**入口；不抢 v1 的 `sugar.transpile` 键）。
 *
 * ## 定位
 *
 * v1 的 `.kojo` 管线（lexer/parser/codegen/lift/…）保持原样零改动；2.0 管线全部住在
 * `@kojo/kojo-core`（core 零游戏知识），本模块只做**装配 + 守卫**：
 *
 * ```
 * source ──parseSource──▶ KojoFile ──lowerFile(backend)──▶ lines + SourceMap + diagnostics
 *                                                              │
 *                                     fail-closed 收口 ◀───────┘
 * ```
 *
 * 游戏事实（`GameAdapter`）与引擎落点（`KojoEmitBackend`）**一律由调用方注入**——
 * 本包不 import 任何 adapter 插件、不 import kernel（解耦审计 B/C 项）。
 *
 * ## 三条硬契约（服务层再加一道，不信任上游）
 *
 * 1. **error ⇒ 0 字节**：`diagnostics` 里只要有一条 `severity === 'error'`，返回的
 *    `erb` 必须是空串、`sourceMap` 必须是空映射。上游若违约（error 还给了字节），
 *    本层**抛错**而不是静默放行——半成品 ERB 会直接进游戏目录，这是写坏作者工程的那一类。
 * 2. **`ok` 与诊断同源**：`ok === !hasError`，不接受上游自报不一致（同上，抛错）。
 * 3. **纯函数**：同 (source, deps) 输出逐字节相同；不读盘、不缓存、不碰 Monaco/时间/随机。
 *
 * ## 替换点（已切到 core 官方入口）
 *
 * 默认编译 = core 的 `compileKojoSource`（内部 `lex → parse → compileKojoFile`：表/池/模板
 * 引用点展开、`@织` 事件头装配、`# 机` 包装、source map 每行登记全在 core）。服务层只做
 * 装配与守卫，**不重实现任何编译逻辑**；{@link Kojo2CompileFn} 端口仍可注入替身/未来版本。
 *
 * ## 产物口径（golden 按字节钉）
 *
 * 由 core 定义并在此复述：成功产物 `lines.join('\n') + '\n'`；空文件（只有声明/注释）
 * ⇒ `erb === ''` 且 `ok === true`（"没有可打印正文"不是错误）；`sourceMap.lineCount`
 * 等于产物行数；任何 error ⇒ `erb === ''` + 空 source map。
 */
import type {
  GameAdapter,
  KojoDiagnostic,
  KojoEmitBackend,
  SourceMap,
} from '@kojo/kojo-core';
import { compileKojoSource, createSourceMapBuilder } from '@kojo/kojo-core';

/** 一次转译的输入（纯文本；`filePath` 只进诊断/映射元信息，绝不读盘） */
export interface Kojo2TranspileInput {
  readonly source: string;
  readonly filePath: string;
}

/** 交给编译入口的完整请求（adapter/backend 由服务装配注入） */
export interface Kojo2CompileRequest extends Kojo2TranspileInput {
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
  /** 预分配产物行数（大文件可省一次扩容；缺省按源行数估） */
  readonly estimatedLines?: number;
}

/** 编译入口的产物（core `compileKojoFile` 的公共形状；`ok=false` ⇒ `erb === ''`） */
export interface Kojo2CompileResult {
  readonly ok: boolean;
  readonly erb: string;
  readonly sourceMap: SourceMap;
  readonly diagnostics: readonly KojoDiagnostic[];
}

/** 编译入口端口（缺省 = 本模块的 core 装配；测试/宿主可注入替身） */
export type Kojo2CompileFn = (request: Kojo2CompileRequest) => Kojo2CompileResult;

/** 服务依赖：adapter/backend 一次注入；编译入口可替换（见 {@link Kojo2CompileFn}） */
export interface Kojo2TranspileDeps {
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
  /**
   * 编译入口（可选）。缺省 = core 的 `compileKojoSource`（官方端到端入口）。
   * 传替身即可单测服务编排/违约收口，或临时替换编译实现。
   */
  readonly compile?: Kojo2CompileFn;
}

/**
 * 转译服务（纯函数面）。
 *
 * 返回 `Kojo2CompileResult`：`ok=false` 时 `erb` 恒为空串、`sourceMap` 恒为空映射，
 * 调用方据此**不得**落盘。
 */
export interface Kojo2TranspileService {
  transpile(input: Kojo2TranspileInput): Kojo2CompileResult;
}

/** 空行式 source map：error/空产物时用它兜底（`lineCount === 0`，不伪造映射） */
const EMPTY_SOURCE_MAP: SourceMap = createSourceMapBuilder().build();

/**
 * 默认编译入口：core 的 `compileKojoSource`（源码 → `KojoFile` → 编译器）。
 *
 * 只搬运字段，不改写诊断文案/顺序（core 是唯一真源）；`filePath` 作为宿主身份透传，
 * core 承诺不读盘、不进诊断（诊断里的文件身份由宿主按调用点拼）。
 */
function defaultCompile(request: Kojo2CompileRequest): Kojo2CompileResult {
  const compiled = compileKojoSource({
    source: request.source,
    filePath: request.filePath,
    adapter: request.adapter,
    backend: request.backend,
    estimatedLines: request.estimatedLines,
  });
  return {
    ok: compiled.ok,
    erb: compiled.erb,
    sourceMap: compiled.sourceMap,
    diagnostics: compiled.diagnostics,
  };
}

/** 输入形状守卫（TypeError = 调用方 bug；不静默把 `undefined` 当空源编译） */
function assertInput(input: Kojo2TranspileInput): void {
  if (typeof input.source !== 'string') {
    throw new TypeError('Kojo2 转译输入 source 必须是字符串');
  }
  if (typeof input.filePath !== 'string' || input.filePath.trim().length === 0) {
    throw new TypeError('Kojo2 转译输入 filePath 不能为空（诊断与 source map 的元信息依赖它）');
  }
}

/**
 * 服务层收口：把上游结果**归一**成可落盘的形状。
 *
 * - 上游违约（error 却有字节 / `ok` 与诊断不一致 / 字段类型不对）⇒ 抛错（fail-visible）；
 * - error ⇒ 强制 `erb:''` + 空 sourceMap（宁可不产，也不把半成品给落盘链路）；
 * - 无 error ⇒ 原样透传（诊断顺序/内容由 core 负责，本层不改写）。
 */
function normalizeResult(raw: Kojo2CompileResult): Kojo2CompileResult {
  if (typeof raw.erb !== 'string') {
    throw new TypeError('Kojo2 编译结果 erb 必须是字符串');
  }
  if (!Array.isArray(raw.diagnostics)) {
    throw new TypeError('Kojo2 编译结果 diagnostics 必须是数组');
  }
  const hasError = raw.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  if (raw.ok !== !hasError) {
    throw new Error(
      `Kojo2 编译结果自相矛盾：ok=${String(raw.ok)} 但诊断${hasError ? '含' : '不含'} error——` +
        '服务层拒绝把它交给落盘链路（ok 与 diagnostics 必须同源）。',
    );
  }
  if (hasError) {
    if (raw.erb.length > 0) {
      throw new Error(
        `Kojo2 编译结果违约：诊断含 error 却产出了 ${raw.erb.length} 字符产物——` +
          '半成品 ERB 不许离开服务层（fail-closed：error ⇒ 0 字节）。',
      );
    }
    return { ok: false, erb: '', sourceMap: EMPTY_SOURCE_MAP, diagnostics: raw.diagnostics };
  }
  return { ok: true, erb: raw.erb, sourceMap: raw.sourceMap, diagnostics: raw.diagnostics };
}

/**
 * 创建 2.0 转译服务（**纯函数、零 IO**）。
 *
 * ```ts
 * const service = createKojo2TranspileService({
 *   adapter: FIXTURE_ADAPTER,   // 由宿主/适配层注入真实 adapter
 *   backend: FIXTURE_BACKEND,   // eraTW backend 住 eratw-adapter，不在本包
 * });
 * const { ok, erb, sourceMap, diagnostics } = service.transpile({ source, filePath });
 * ```
 *
 * `ok === false`（任一 error 诊断）时 `erb === ''`——调用方不得落盘。
 */
export function createKojo2TranspileService(deps: Kojo2TranspileDeps): Kojo2TranspileService {
  const compile: Kojo2CompileFn = deps.compile ?? defaultCompile;
  return {
    transpile(input: Kojo2TranspileInput): Kojo2CompileResult {
      assertInput(input);
      const raw = compile({
        source: input.source,
        filePath: input.filePath,
        adapter: deps.adapter,
        backend: deps.backend,
      });
      return normalizeResult(raw);
    },
  };
}
