/**
 * 语义读数服务（冻结契约 v1 · 只读、注入式）。
 *
 * 把调试面那批**纯读语义能力**（定义 / 引用 / 诊断 / 悬停 / 补全 / 符号 / token /
 * 代码动作）服务化：判据（读数清单、入参 schema、裁剪口径）住本模块，取数腿由
 * `deps.readers` 注入。宿主 `host-bridge.ts` 只在启用 MCP 时**动态 import** 本模块，
 * 因此它不进 ps10 开机静态图；本模块也**不静态 import 任何 Monaco 运行时 / 调试宿主 /
 * 内核 / bridge**，避免把编辑器运行时拖进常驻路径。
 *
 * 与 `debug/install-debug.ts` 的关系：那边是「绑定焦点编辑器的调试面适配器」，本模块是
 * 「可注入的数据面」。判据同源（见 `slimLocations` / `slimDiagnostics` 的口径，
 * `*Page` 变体另带 total / truncated 截断账目——截断不静默），
 * `createDebugEditorAdapter()` 给出的薄适配器形态即调试面可委托的目标。
 */

export type McpTier = 'read' | 'edit' | 'privileged';

export type SemanticReadingName =
  | 'definitionAt'
  | 'referencesAt'
  | 'diagnostics'
  | 'hoverAt'
  | 'suggestAt'
  | 'documentSymbols'
  | 'tokens'
  | 'codeActionsAt';

export interface SemanticReadingSpec {
  readonly name: SemanticReadingName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly tier: McpTier;
  readonly annotations: { readonly readOnlyHint: boolean };
}

const POS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { line: { type: 'integer' }, column: { type: 'integer' } },
  required: ['line', 'column'],
};
const LINE_RANGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { lineFrom: { type: 'integer' }, lineTo: { type: 'integer' } },
};
const EMPTY_SCHEMA: Record<string, unknown> = { type: 'object' };

/** 8 条语义读数的公开清单（与 @kojo/mcp-host 的 SEMANTIC_TOOL_SPECS 逐项对齐）。 */
export const SEMANTIC_READING_SPECS: readonly SemanticReadingSpec[] = [
  { name: 'definitionAt', description: '转到定义（只读）', inputSchema: POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'referencesAt', description: '查找引用（只读）', inputSchema: POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'diagnostics', description: '当前文档诊断（只读）', inputSchema: EMPTY_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'hoverAt', description: '悬停信息（只读）', inputSchema: POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'suggestAt', description: '补全候选（只读）', inputSchema: POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'documentSymbols', description: '文档符号（只读）', inputSchema: EMPTY_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'tokens', description: '词法 token（只读）', inputSchema: LINE_RANGE_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'codeActionsAt', description: '可用代码动作（只读，绝不 apply）', inputSchema: POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
];

/* ----------------------------- 纯读裁剪（判据同源） ----------------------------- */

/**
 * 带截断账目的裁剪结果（不静默口径，与宿主面 slimMarkerList 同尺）：
 * `total` = 原始条目数（脏行也计），`truncated` = 呈现数 < 原始数（上限截断**或脏行丢弃**
 * 都算「没全呈现」——少给了就说少给了，绝不冒充完整）。
 */
export interface SlimPage<T> {
  readonly items: T[];
  readonly total: number;
  readonly truncated: boolean;
}

function pageOf<T>(items: T[], rawLength: number): SlimPage<T> {
  return { items, total: rawLength, truncated: rawLength > items.length };
}

/** 落点裁剪（带账）：filePath / line / column 三格「不编造」口径（行非正 / 路径空 ⇒ 丢弃）。 */
export function slimLocationsPage(raw: unknown, limit = 20): SlimPage<{ filePath: string; line: number; column: number }> {
  if (!Array.isArray(raw)) return pageOf([], 0);
  const out: { filePath: string; line: number; column: number }[] = [];
  for (const item of raw) {
    if (out.length >= limit) break;
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    const filePath = typeof r['filePath'] === 'string' ? r['filePath'] : typeof r['uri'] === 'string' ? r['uri'] : '';
    const line = typeof r['line'] === 'number' ? r['line'] : 0;
    if (!filePath || !Number.isFinite(line) || line <= 0) continue;
    out.push({ filePath, line, column: typeof r['column'] === 'number' ? r['column'] : 1 });
  }
  return pageOf(out, raw.length);
}

/** 诊断裁剪（带账）：message 单行归一 + 300 字符截断 + 上限（与调试面 slimDiagnostics 同尺）。 */
export function slimDiagnosticsPage(raw: unknown, limit = 200): SlimPage<{ message: string; line: number }> {
  if (!Array.isArray(raw)) return pageOf([], 0);
  const out: { message: string; line: number }[] = [];
  for (const item of raw) {
    if (out.length >= limit) break;
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    let message = typeof r['message'] === 'string' ? r['message'] : '';
    message = message.replace(/\s+/g, ' ').trim();
    if (message.length > 300) message = `${message.slice(0, 300)}…`;
    const line = typeof r['line'] === 'number' ? r['line'] : 1;
    out.push({ message, line });
  }
  return pageOf(out, raw.length);
}

/** 符号裁剪（带账）：name / kind / depth 三格，脏行跳过、上限保护。 */
export function slimSymbolsPage(raw: unknown, limit = 200): SlimPage<{ name: string; kind: string; depth: number }> {
  if (!Array.isArray(raw)) return pageOf([], 0);
  const out: { name: string; kind: string; depth: number }[] = [];
  for (const item of raw) {
    if (out.length >= limit) break;
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r['name'] !== 'string' || r['name'] === '') continue;
    out.push({ name: r['name'], kind: typeof r['kind'] === 'string' ? r['kind'] : '', depth: typeof r['depth'] === 'number' ? r['depth'] : 0 });
  }
  return pageOf(out, raw.length);
}

/** 落点裁剪：{@link slimLocationsPage} 的 items 投影（兼容冻结形状，行为不变）。 */
export function slimLocations(raw: unknown, limit = 20): { filePath: string; line: number; column: number }[] {
  return slimLocationsPage(raw, limit).items;
}

/** 诊断裁剪：{@link slimDiagnosticsPage} 的 items 投影（兼容冻结形状，行为不变）。 */
export function slimDiagnostics(raw: unknown, limit = 200): { message: string; line: number }[] {
  return slimDiagnosticsPage(raw, limit).items;
}

/** 符号裁剪：{@link slimSymbolsPage} 的 items 投影（兼容冻结形状，行为不变）。 */
export function slimSymbols(raw: unknown, limit = 200): { name: string; kind: string; depth: number }[] {
  return slimSymbolsPage(raw, limit).items;
}

/* ----------------------------- 结构化失败 ----------------------------- */

export class SemanticFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SemanticFailure';
    this.code = code;
  }
  toJSON(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}

/**
 * 结构化失败的最小 Duck 型：自带字符串 `code` + `{code,message}` 序列化口径。
 * `SemanticFailure` 与宿主侧 `McpFailure`（@kojo/mcp-host）皆此形——本模块零依赖、
 * 不 import 它，靠形状识别（铁律 4：取数腿抛出的 NOT_WIRED / RESOURCE_UNAVAILABLE
 * 等两态语义必须原样到调用方，不得在此洗码成 READ_FAILED）。
 */
function isStructuredFailure(err: unknown): boolean {
  if (err instanceof SemanticFailure) return true;
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; toJSON?: unknown };
  return typeof e.code === 'string' && typeof e.toJSON === 'function';
}

/* ----------------------------- 注入式服务 ----------------------------- */

export type SemanticReader = (args: Record<string, unknown>) => Promise<unknown> | unknown;

export interface SemanticServiceDeps {
  /** 逐腿注入；缺席的腿仍列进清单，但调用时报 NOT_WIRED（可见、不静默）。 */
  readonly readers: Partial<Record<SemanticReadingName, SemanticReader>>;
}

export interface SemanticService {
  readonly specs: readonly SemanticReadingSpec[];
  read(name: string, args: Record<string, unknown>): Promise<unknown>;
}

function isValidName(name: string): name is SemanticReadingName {
  return SEMANTIC_READING_SPECS.some((s) => s.name === name);
}

/** 轻量入参校验：位置读数要求正整数 line/column；其余不设硬约束。 */
function assertArgs(name: SemanticReadingName, args: Record<string, unknown>): void {
  const spec = SEMANTIC_READING_SPECS.find((s) => s.name === name);
  if (!spec || !spec.inputSchema['required']) return;
  const required = spec.inputSchema['required'] as readonly string[];
  for (const key of required) {
    const v = args[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      throw new SemanticFailure('INVALID_ARGS', `读数 ${name} 的 ${key} 须为正整数`);
    }
  }
}

export function createSemanticService(deps: SemanticServiceDeps): SemanticService {
  const readers = deps.readers;
  return {
    specs: SEMANTIC_READING_SPECS,
    async read(name, args) {
      if (!isValidName(name)) throw new SemanticFailure('UNKNOWN_READING', `未知语义读数：${name}`);
      const input = args ?? {};
      assertArgs(name, input);
      const reader = readers[name];
      if (!reader) throw new SemanticFailure('NOT_WIRED', `语义读数 ${name} 未注入取数腿（不静默、不伪造读数）`);
      try {
        return await reader(input);
      } catch (err) {
        // 结构化失败（SemanticFailure / 宿主 McpFailure 等同形者）**原样透传**：
        // 「服务缺席 / 无活动编辑器」（NOT_WIRED）与「读数失败」（READ_FAILED）是两态，
        // 洗码会让上层把缺线误报成执行失败（不静默、不混态）。
        if (isStructuredFailure(err)) throw err;
        throw new SemanticFailure('READ_FAILED', `读数 ${name} 失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/* ----------------------------- 调试面薄适配器 ----------------------------- */

/** 调试面 `editor.*` 语义读数的薄适配器形态（委托给服务，不含任何取数实现）。 */
export interface DebugSemanticEditor {
  definitionAt(line: number, column: number): Promise<unknown>;
  referencesAt(line: number, column: number): Promise<unknown>;
  diagnostics(): Promise<unknown>;
  hoverAt(line: number, column: number): Promise<unknown>;
  suggestAt(line: number, column: number): Promise<unknown>;
  documentSymbols(): Promise<unknown>;
  tokens(lineFrom: number, lineTo: number): Promise<unknown>;
  codeActionsAt(line: number, column: number): Promise<unknown>;
}

export function createDebugEditorAdapter(service: SemanticService): DebugSemanticEditor {
  const at = (name: SemanticReadingName, line: number, column: number) =>
    service.read(name, { line, column });
  return {
    definitionAt: (line, column) => at('definitionAt', line, column),
    referencesAt: (line, column) => at('referencesAt', line, column),
    diagnostics: () => service.read('diagnostics', {}),
    hoverAt: (line, column) => at('hoverAt', line, column),
    suggestAt: (line, column) => at('suggestAt', line, column),
    documentSymbols: () => service.read('documentSymbols', {}),
    tokens: (lineFrom, lineTo) => service.read('tokens', { lineFrom, lineTo }),
    codeActionsAt: (line, column) => at('codeActionsAt', line, column),
  };
}
