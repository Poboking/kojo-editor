/**
 * 可搬运任务（2026-10-16 装饰热路径批 · 2026-10-18 PS-11 抽取 offload 批）。
 *
 * ## 为什么这一条要搬
 *
 * `ui.editor.decorator`（id `erb-expr-syntax`）此前在**主线程同步**跑
 * `scanControlFlow`（全文控制流骨架扫描）——而本插件早就通过 `erb.parser` 服务
 * 拿到过 offload 版（`scanControlFlowOffloaded`），装饰路径一个没接。
 *
 * 2026-10-18 PS-11：**全量抽取**（`engine.run` 的主循环）此前只在片间让路、不换线程
 * ——`scanControlFlowOffloaded` 只把骨架扫描搬走了，`extractFunctionConditions`（谓词
 * 解析 / 比较式收集 / 依赖聚合，真实语料 49.3 万谓词）仍压在 UI 线程上（约 11.3 s 的
 * 背景 CPU 洪水）。本批把**单文件抽取整条链**（扫描 → 逐函数切片 → 谓词抽取 → 成形）
 * 做成一个纯函数任务 `condition.extractFile`：`text + 函数清单` 进、`FileBucket` 出。
 *
 * ## 为什么任务表要"造表时把扫描器交进来"
 *
 * 任务实现必须是**纯函数 + 纯数据载荷**（跨不过结构化克隆的函数不能上 wire），
 * 而"扫骨架"这件事的所有权在 **erb-parser**，本插件按铁律不许 cross-import 它
 * （`audit:decoupling` C 项）。故本模块把扫描器留成**参数**：装配层
 * （app 的 `compute-tasks.ts`，唯一可以同时看见两个插件的层）用 erb-parser 导出的
 * 那个同名纯函数把表填上。worker 侧与宿主侧拿到的是**同一份填好的表**，不会漂移。
 *
 * 语义标注（`variableSchema.lookup`）是唯一搬不动的依赖——它是函数。故任务侧不查
 * schema，由引擎在结果回到主线程后经 `applySchemaLookup` 补（与 `extractFunctionConditions`
 * 共用同一份口径，见 `./extract.ts`）。
 */
import type {
  ComputeTaskTable,
  ControlFlowStatement,
  EditorDecoratePayload,
  FunctionConditions,
  LineDecoration,
} from '@kojo/plugin-api';
import { collectExprSyntaxDecorations } from './decorator';
import { extractFunctionConditions } from './extract';
import type { FileBucket, FileStats } from './snapshot';

/**
 * 任务 kind：条件表达式语法波浪线整条链（骨架扫描 + 逐条件表达式诊断 + 成形）。
 *
 * kind 前缀沿用 `erb.`（这条波浪线管的是 ERB 方言正文），与 `erb-structure` 同族。
 */
export const EXPR_SYNTAX_DECORATIONS_TASK = 'erb.exprSyntaxDecorations';

/** 本装饰器的适用性判据（口径与改动前的 `decorate` 逐字一致：只有正文才谈表达式） */
function isExprBearingPath(path: string): boolean {
  return /\.(erb|erm)$/i.test(path);
}

/**
 * 表达式语法波浪线的**单一真源**：`decorate()`（就地回退）与任务实现共用它。
 *
 * 骨架扫描器由调用方给定——同一个 `collectExprSyntaxDecorations` 已经在
 * "扫描/诊断任一异常都当无发现"这条保守口径上写死了，这里不另立判据。
 */
export function exprSyntaxDecorations(
  { path, text }: EditorDecoratePayload,
  scanControlFlow: (text: string) => readonly ControlFlowStatement[],
): LineDecoration[] {
  if (!isExprBearingPath(path) || text.length === 0) return [];
  return collectExprSyntaxDecorations(text, scanControlFlow).map((d) => ({
    line: d.line,
    severity: 'warning' as const,
    message: d.message,
    code: d.code,
    // 列区间（additive）：内核已算好 1 基/UTF-16/半开；缺省即整行（旧宿主行为不变）
    ...(d.startColumn !== undefined && d.endColumn !== undefined
      ? { startColumn: d.startColumn, endColumn: d.endColumn }
      : {}),
  }));
}

/**
 * 任务 kind（PS-11）：**单文件抽取整条链**（骨架扫描 + 逐函数谓词抽取 + 桶成形）。
 *
 * 前缀 `condition.` 与服务键 `condition.extractor` 同族（装饰那条管 ERB 方言正文，走 `erb.`）。
 */
export const CONDITION_EXTRACT_FILE_TASK = 'condition.extractFile';

/** 载荷里的函数头（`ErbFile.functions` 的抽取所需字段——传数据不传函数） */
export interface ExtractFileFunction {
  normalizedName: string;
  startLine: number;
  endLine: number;
}

/**
 * 单文件抽取载荷：**纯数据**（可结构化克隆）。
 * `mtimeMs` / `size` 由引擎从本次索引带入（任务只把它们写进桶，不自行 stat）。
 */
export interface ExtractFilePayload {
  path: string;
  text: string;
  mtimeMs: number | null;
  size: number | null;
  functions: readonly ExtractFileFunction[];
}

/**
 * 单文件抽取结果（**内存形态**）：桶 + 两段**净 CPU** 耗时（worker 内 `performance.now` 计时）。
 *
 * 注意它**不是**跨线程那一份——通道走 `ExtractFileWire`（`conds` 以 JSON 文本回传，
 * 理由与读数见该接口头注）。本形态是纯函数 `extractFileBucket` 的产出，供
 * 内联回退、测试与剖面日志共用。
 *
 * 计时随结果回传是为了保住引擎分段剖面日志的形状（`扫描 Xms` / `抽取循环 Yms`）：
 * 搬进 worker 后主线程只能量到"通道往返"，量不到"扫描本身多慢"，而读数要区分的正是这两条。
 */
export interface ExtractFileResult {
  bucket: FileBucket;
  scanMs: number;
  extractMs: number;
}

/**
 * **通道回传形态**（`condition.extractFile` 唯一跨线程的那一份）：`conds` 换成 JSON 文本。
 *
 * `bucket.conds` 是深对象图（99k 函数 / 165k 依赖），结构化克隆**按对象数计价**，与消息条数无关
 * （§3.2 已证伪合批）。同形载荷页内实测：对象图克隆 1,232ms / `JSON.parse` 293ms；真机这条通道
 * 合计 2.8s / 4,273 条消息（P0-2 的 A 块）。紧凑元组留给"`JSON.parse` 仍占 >200ms"时再说。
 */
export interface ExtractFileWire {
  mtimeMs: number | null;
  size: number | null;
  stats: FileStats;
  /** `FunctionConditions[]` 的 JSON 文本（worker 内 stringify；`schema` 尚未标注，见 `extractFileBucket`） */
  condsJson: string;
  scanMs: number;
  extractMs: number;
}

/**
 * 内存形态 → 通道形态（worker 侧那一步 `stringify`，成本记在通道一侧、不计入 `extractMs`——
 * 分段剖面日志里"抽取循环"仍只量抽取本身）。
 */
export function toWireResult(r: ExtractFileResult): ExtractFileWire {
  return {
    mtimeMs: r.bucket.mtimeMs,
    size: r.bucket.size,
    stats: r.bucket.stats,
    condsJson: JSON.stringify(r.bucket.conds),
    scanMs: r.scanMs,
    extractMs: r.extractMs,
  };
}

/** 通道形态 → 内存桶（主线程在这一行付掉唯一那笔 `JSON.parse`） */
export function decodeBucket(w: ExtractFileWire): FileBucket {
  return {
    mtimeMs: w.mtimeMs,
    size: w.size,
    stats: w.stats,
    conds: JSON.parse(w.condsJson) as FunctionConditions[],
  };
}

/** 毫秒表针（与 engine 同口径；`Date.now()` 在逐文件计时上会全读成 0） */
const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

/**
 * 单文件抽取链的**单一真源**：扫描 → 两指针切片 → 逐函数 `extractFunctionConditions` → 桶成形。
 *
 * 语义与 PS-11 改前的 `engine.run` 主循环逐条一致（同一套切片边界、统计口径、空桶规则）。
 * 骨架扫描器由装配层给定（同 `conditionExtractorTasks` 的理由）。
 * **不查 schema**：`lookup` 是函数、搬不动，由调用方在主线程用 `applySchemaLookup` 补。
 */
export function extractFileBucket(
  payload: ExtractFilePayload,
  scanControlFlow: (text: string) => readonly ControlFlowStatement[],
): ExtractFileResult {
  const s0 = nowMs();
  const stmts = scanControlFlow(payload.text);
  const scanMs = nowMs() - s0;

  const e0 = nowMs();
  const st: FileStats = { functions: 0, functionsWithDeps: 0, predicates: 0, unparsed: 0, dependencies: 0 };
  const conds: FunctionConditions[] = [];
  // `{`…`}` 多行条件需要原始行补全（骨架扫描只有单行视野）；EOL 归一与扫描器同口径
  const lines = payload.text.replace(/\r\n?/g, '\n').split('\n');
  // 两指针切片：stmts 与 functions 均按行号升序；stmts 为空时循环自然不执行，
  // 但仍要留一个空桶 —— 否则这个文件每次开项目都被判"没缓存"而白读白扫一遍
  let cursor = 0;
  for (const fn of payload.functions) {
    while (cursor < stmts.length && stmts[cursor]!.line < fn.startLine) cursor++;
    const slice: ControlFlowStatement[] = [];
    for (let j = cursor; j < stmts.length && stmts[j]!.line <= fn.endLine; j++) {
      slice.push(stmts[j]!);
    }
    st.functions++;
    const cond = extractFunctionConditions(
      { normalizedName: fn.normalizedName, filePath: payload.path, startLine: fn.startLine },
      slice,
      // endLine 供文本内联三元（`\@…?…#…\@`）划界：函数体区间外的一律不算本函数
      { lines, endLine: fn.endLine },
    );
    if (cond) {
      conds.push(cond);
      st.predicates += cond.predicateCount;
      st.unparsed += cond.unparsedCount;
      st.dependencies += cond.dependencies.length;
      if (cond.dependencies.length > 0) st.functionsWithDeps++;
    }
  }
  return {
    bucket: { mtimeMs: payload.mtimeMs, size: payload.size, stats: st, conds },
    scanMs,
    extractMs: nowMs() - e0,
  };
}

/**
 * 本插件的可搬运任务表（装配层用 erb-parser 的 `scanControlFlow` 填；
 * 宿主侧 `registerTask` 与 worker 侧共用这一份，理由见文件头注）。
 */
export function conditionExtractorTasks(
  scanControlFlow: (text: string) => readonly ControlFlowStatement[],
): ComputeTaskTable {
  return {
    [EXPR_SYNTAX_DECORATIONS_TASK]: ((payload: EditorDecoratePayload): LineDecoration[] =>
      exprSyntaxDecorations(payload, scanControlFlow)) as never,
    [CONDITION_EXTRACT_FILE_TASK]: ((payload: ExtractFilePayload): ExtractFileWire =>
      toWireResult(extractFileBucket(payload, scanControlFlow))) as never,
  };
}
