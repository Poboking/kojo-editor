/**
 * @kojo/mcp-host —— 面向模型的能力面（冻结契约 v1；第三波：能力面真正够用 + 覆盖登记）。
 *
 * 这一层只做三件事：**定义契约类型**、**把三路能力来源装配成工具/资源/提示清单**、
 * **按会话授权把守调用**。它不监听 Tauri 事件、不 import app/bridge/kernel/其它插件，
 * 也不认识任何游戏语义——具体能力的数据源一律通过 `deps` 注入（宿主/路 A 的
 * `host-bridge.ts` 负责装配）。所有失败都抛结构化 `{code,message}`（铁律 4：不静默）。
 *
 * 第二波（路 B 覆盖补齐）新增，纪律：
 * - 补齐「没登记成命令」的功能一律以**工具**形式补在 `SUPPLEMENTAL_TOOL_SPECS`（不动 UI 组件、
 *   不给开机图加 import 边）；每个工具有面向模型的 description + 严格 inputSchema；
 *   危险动作 `tier:'privileged'` + `annotations.destructiveHint`。
 * - 不给 MCP 暴露任意目标路径参数：写类工具只收「项目根内相对路径」（`RELATIVE_PATH_SCHEMA`
 *   用 pattern 拒绝绝对路径 / 盘符 / `..` 逃逸），执行层还须按 approvedRoots 复核域。
 * - resources：新增「当前文档与光标」，并对命令清单 / 插件状态 / 校验 failedRules /
 *   活动文档做**可读性投影**；文本一律有截断上限 + 显式 `truncated` 标记（fail loud，不静默）。
 * - prompts：只提供**零游戏名词的领域工作流骨架 + 槽消费逻辑**；游戏相关知识只能由
 *   `mcp.prompt` 槽（`*-adapter` 贡献）注入，骨架绝不硬编码、也不编造领域知识。
 *
 * 第三波（路 B「能力面真正够用」+「外部客户端接入」）新增，纪律：
 * - 把「有真源可接」的只读缺口（Rust IO 原语 / 语义读数面 / 已有 resource 数据面）补成
 *   具名工具，全部走 `runSupplemental` 钩子；**没有真源的缺口宁可留在缺口清单并显式标注**
 *   （`MCP_DEFERRED_GAP_NOTES`），绝不造一个返回空串的假实现。
 * - `MCP_TOOL_GAP_MAP` 逐条登记「工具 → 真源缺口」，供盘点脚本做覆盖对拍；交叉校验 tool/gap
 *   真实存在，对不上就如实降级，不假绿。
 * - resources 文本一律有截断上限 + 显式 `truncated` 标记；prompts 骨架保持零游戏名词。
 *
 * 只依赖 `@kojo/plugin-api`（workspace 声明；本模块不引用其运行时，保持零耦合、
 * 便于注入假实现单测）。
 */

/* ------------------------------------------------------------------ *
 * 1. 冻结契约 v1 —— 逐字导出，不得改名
 * ------------------------------------------------------------------ */

export type McpTier = 'read' | 'edit' | 'privileged';

export interface McpSessionScope {
  sessionId: string;
  clientId: string;
  tier: McpTier;
  approvedRoots: readonly string[];
  approvedTools: readonly string[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  tier: McpTier;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  run(args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown>;
}

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
  read(scope: McpSessionScope): Promise<{ contents: { uri: string; text: string }[] }>;
}

export interface McpPrompt {
  name: string;
  description: string;
  arguments?: readonly { name: string; required?: boolean }[];
  render(
    args: Record<string, unknown>,
    scope: McpSessionScope,
  ): Promise<{ messages: { role: 'user' | 'assistant'; content: { type: 'text'; text: string } }[] }>;
}

export interface McpCapabilityRegistry {
  listTools(scope: McpSessionScope): readonly McpTool[];
  listResources(): readonly McpResource[];
  listPrompts(): readonly McpPrompt[];
  callTool(name: string, args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown>;
  readResource(uri: string, scope: McpSessionScope): Promise<unknown>;
  getPrompt(name: string, args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown>;
}

/* ------------------------------------------------------------------ *
 * 2. 结构化错误（{code,message}，可 JSON 化回给 MCP 客户端）
 * ------------------------------------------------------------------ */

export type McpErrorCode =
  | 'UNKNOWN_TOOL'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGS'
  | 'TOOL_EXECUTION_FAILED'
  | 'NOT_WIRED'
  | 'WRITE_DISABLED'
  | 'UNKNOWN_RESOURCE'
  | 'RESOURCE_UNAVAILABLE'
  | 'UNKNOWN_PROMPT'
  | 'MISSING_PROMPT_ARGUMENT'
  | 'PROMPT_RENDER_FAILED';

/** 结构化失败：既能被 `catch` 当 Error，也能 `JSON.stringify` 成 `{code,message}`。 */
export class McpFailure extends Error {
  readonly code: McpErrorCode;
  constructor(code: McpErrorCode, message: string) {
    super(message);
    this.name = 'McpFailure';
    this.code = code;
  }
  toJSON(): { code: McpErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

export function isMcpFailure(value: unknown): value is McpFailure {
  return value instanceof McpFailure;
}

/* ------------------------------------------------------------------ *
 * 3. 最小 inputSchema 校验器（自己写，零外部依赖）
 *
 * 刻意只认 JSON Schema 的一个小子集：`type` / `required` / `properties` /
 * `items` / `enum` / `minimum` / `maximum` / `pattern` / `minLength` / `maxLength`。
 * 不认识的关键字一律忽略（不因"没实现校验"而误拒合法入参），只拒绝**明确违反**
 * 已声明约束的取值。`pattern` 编译失败时同样忽略（不误拒），但合法 pattern 会真正
 * 生效——写类工具的「项目内相对路径」约束就靠它兜住。
 * ------------------------------------------------------------------ */

export interface SchemaValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(expected: string, v: unknown): boolean {
  switch (expected) {
    case 'object':
      return isPlainObject(v);
    case 'array':
      return Array.isArray(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    default:
      return true; // 不认识的 type 名不拦
  }
}

/** 结构化校验：返回全部违反项（不提前退出），便于一次报清楚。 */
export function validateAgainstSchema(schema: Record<string, unknown>, value: unknown): SchemaValidation {
  const errors: string[] = [];
  if (!isPlainObject(schema)) return { valid: true, errors };

  const walk = (s: Record<string, unknown>, v: unknown, path: string): void => {
    const expected = s['type'];
    if (typeof expected === 'string' && !typeMatches(expected, v)) {
      errors.push(`${path || '$'}: 期望 ${expected}，实得 ${typeOf(v)}`);
      return; // 类型都不对，不再下钻，避免级联噪声
    }
    if (Array.isArray(s['enum'])) {
      const allowed = s['enum'] as readonly unknown[];
      if (!allowed.some((e) => e === v)) errors.push(`${path || '$'}: 取值不在 enum 白名单内`);
    }
    if (typeof s['minimum'] === 'number' && typeof v === 'number' && v < (s['minimum'] as number)) {
      errors.push(`${path || '$'}: 小于 minimum`);
    }
    if (typeof s['maximum'] === 'number' && typeof v === 'number' && v > (s['maximum'] as number)) {
      errors.push(`${path || '$'}: 大于 maximum`);
    }
    if (typeof v === 'string') {
      if (typeof s['pattern'] === 'string') {
        let re: RegExp | null = null;
        try {
          re = new RegExp(s['pattern'] as string);
        } catch {
          re = null; // 非法 pattern 不误拒
        }
        if (re && !re.test(v)) errors.push(`${path || '$'}: 不匹配 pattern ${String(s['pattern'])}`);
      }
      if (typeof s['minLength'] === 'number' && v.length < (s['minLength'] as number)) {
        errors.push(`${path || '$'}: 短于 minLength`);
      }
      if (typeof s['maxLength'] === 'number' && v.length > (s['maxLength'] as number)) {
        errors.push(`${path || '$'}: 长于 maxLength`);
      }
    }
    if (isPlainObject(v)) {
      const required = s['required'];
      if (Array.isArray(required)) {
        for (const key of required) {
          if (typeof key === 'string' && !(key in v)) errors.push(`${path || '$'}: 缺必填字段 ${key}`);
        }
      }
      const properties = s['properties'];
      if (isPlainObject(properties)) {
        for (const [key, sub] of Object.entries(properties)) {
          if (key in v && isPlainObject(sub)) walk(sub, v[key], path ? `${path}.${key}` : key);
        }
      }
    }
    if (Array.isArray(v) && isPlainObject(s['items'])) {
      v.forEach((item, i) => walk(s['items'] as Record<string, unknown>, item, `${path || '$'}[${i}]`));
    }
  };

  walk(schema, value, '$');
  return { valid: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ *
 * 4. deps 形状（由本包定义；全部可选 / 可注入假实现）
 * ------------------------------------------------------------------ */

/** 统一读数腿签名：args + scope 进、任意可 JSON 化的结果出。 */
export type McpReaderFn = (
  args: Record<string, unknown>,
  scope: McpSessionScope,
) => Promise<unknown> | unknown;

/** ① 命令面板登记命令（宿主把 buildCommandRegistry 的结果投影成这一形状）。 */
export interface McpCommandSource {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly argsSchema?: Record<string, unknown>;
  readonly tier?: McpTier;
  run(args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown> | unknown;
}

/** ② 语义读数服务的 8 条纯读腿（见 app/src/mcp/semantic-service.ts）。 */
export interface McpSemanticReaders {
  definitionAt: McpReaderFn;
  referencesAt: McpReaderFn;
  diagnostics: McpReaderFn;
  hoverAt: McpReaderFn;
  suggestAt: McpReaderFn;
  documentSymbols: McpReaderFn;
  tokens: McpReaderFn;
  codeActionsAt: McpReaderFn;
}

/** ③ kernel IO 的只读能力（项目信息 / 文件树 / 全文检索）。 */
export interface McpKernelIo {
  projectInfo: McpReaderFn;
  fileTree: McpReaderFn;
  searchAll: McpReaderFn;
}

/** `mcp.prompt` 槽贡献投影成的领域知识片段（游戏知识只由 *-adapter 经槽注入）。 */
export interface McpPromptSlotFragment {
  /** 槽名（与骨架 `slots` 对齐）。 */
  readonly name: string;
  /** adapter 注入的领域知识文本；骨架只做搬运，不解释、不编造。 */
  readonly text: string;
  /** 来源标识（哪个 adapter），仅用于可读性标注。 */
  readonly source?: string;
}

export interface McpHostDeps {
  /** 命令面板登记命令 */
  readonly commands?: readonly McpCommandSource[];
  /** 语义读数（逐腿可缺席；缺席的腿仍列进工具，但调用时报 NOT_WIRED，可见不静默） */
  readonly semantic?: Partial<McpSemanticReaders>;
  /** kernel IO 只读能力 */
  readonly kernelIo?: Partial<McpKernelIo>;
  /** 内置 resource 的数据源：按 uri 供数；缺席 ⇒ read 报 RESOURCE_UNAVAILABLE */
  readonly readResourceData?: (uri: string, scope: McpSessionScope) => Promise<unknown> | unknown;
  /** 追加 / 覆盖 resource（同 uri 覆盖内置项） */
  readonly resources?: readonly McpResource[];
  /** mcp.prompt 槽贡献投影成的提示清单 */
  readonly prompts?: readonly McpPrompt[];
  /** 补齐功能（全工程检索 / quickfix / 文件树增删改 / diff / 状态回放 / 预览）的执行钩子 */
  readonly runSupplemental?: (name: string, args: Record<string, unknown>, scope: McpSessionScope) => Promise<unknown> | unknown;
  /**
   * `mcp.prompt` 槽贡献的领域片段。**提供该字段（哪怕是空数组）即把内置零游戏名词的
   * 领域工作流骨架并入 prompts 清单**；缺席时 prompts 只含 `prompts`，保持第一波行为不变。
   */
  readonly promptSlots?: readonly McpPromptSlotFragment[];
}

/* ------------------------------------------------------------------ *
 * 5. 工具/资源清单常量（可导出对拍；结构与第一波逐项同形，便于盘点脚本按源码锚解析）
 * ------------------------------------------------------------------ */

/** 危险工具名单（冻结契约 v1）：命中即 'privileged'，路 C 默认不进 tools/list。 */
export const DANGEROUS_TOOL_PATTERNS: readonly RegExp[] = [
  /^launcher_/,
  /^market_/,
  /^open_url_external$/,
  /^export_file$/,
  /^remove_/,
  /^rename_path$/,
];

export function isDangerousTool(name: string): boolean {
  return DANGEROUS_TOOL_PATTERNS.some((re) => re.test(name));
}

interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly tier: McpTier;
  readonly annotations?: McpTool['annotations'];
  readonly method?: keyof McpSemanticReaders | keyof McpKernelIo;
}

const POS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { line: { type: 'integer' }, column: { type: 'integer' } },
  required: ['line', 'column'],
};

/**
 * 写类工具的路径入参：**不暴露任意目标路径**。
 * - `pattern` 拒绝盘符开头（`C:`）、绝对路径分隔符开头、以及任何 `..` 段；
 * - 执行层（`runSupplemental` / headless）还须把相对路径 resolve 到 approvedRoots 内并拒绝域外。
 */
const RELATIVE_PATH_SCHEMA: Record<string, unknown> = {
  type: 'string',
  minLength: 1,
  maxLength: 512,
  pattern: '^(?![A-Za-z]:)(?![\\\\/])(?!.*(?:^|[\\\\/])\\.\\.(?:[\\\\/]|$)).+$',
  description:
    'Project-root-relative path only. Absolute paths, drive-letter paths and ".." traversal are rejected by schema; the execution layer additionally resolves against approvedRoots and refuses any out-of-domain target (ADR-0003).',
};

/**
 * 分页入参的通用 schema 片段（B1 批：**只加可选入参，不加新工具名**）。
 * 定义必须早于下面几张工具表——表是模块级 const，`export const` 对象若定义在其后会在
 * 模块初始化时撞 TDZ（ReferenceError），只有函数声明可以后置。
 */
export const PAGE_CURSOR_SCHEMA_PROPS: Record<string, unknown> = {
  limit: {
    type: 'integer',
    minimum: 1,
    description: "Page size for this enumeration (defaults to this surface's existing cap; the cap is never widened).",
  },
  cursor: {
    type: 'string',
    minLength: 10,
    maxLength: 32,
    pattern: '^[0-9a-f]{8}:\\d{1,10}$',
    description:
      "Opaque cursor copied verbatim from the previous response's nextCursor. Omit for the first page. If the underlying data changed mid-paging the cursor is rejected-by-flag: the response carries changedDuringPaging:true and restarts from the head, so pages must NOT be spliced with earlier ones.",
  },
};

/** 分页返回体的完整性账字段说明（供各面 description 复用，口径统一）。 */
export const PAGE_ACCOUNT_NOTE =
  'Every page carries the completeness account {total (spelled `textLength` on text surfaces), offset, limit, truncated, hasMore, nextCursor, fingerprint}; pass nextCursor back verbatim for the next page. changedDuringPaging:true means the snapshot changed mid-paging, so that page restarts from the head and must not be spliced with earlier pages.';

/** 语义读数服务 → 8 枚只读工具（tier 'read' + readOnlyHint）。
 *
 * 分页游标批（B1）：列举面（diagnostics / documentSymbols）补 **可选** `limit` + `cursor`，
 * 单页上限取该面今天已有的硬闸（DIAGNOSTIC_LIMIT / SYMBOL_LIMIT＝200），不放宽；
 * 真·零参面（projectInfo）不再用裸 `{type:'object'}` 兜底，改成严格空对象（拒绝任何入参）。
 * `semantic.tokens` 原本就有 `lineFrom`/`lineTo` 窗口，本批保持其形状不动（它是本批的形状参照）。
 */
const PAGE_PROPS = PAGE_CURSOR_SCHEMA_PROPS;

/** 严格零参入参形状：诚实声明「不收任何入参」，由零参闸逐个登记（见 NO_ARG_TOOLS 测试）。 */
const STRICT_NO_ARG_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

export const SEMANTIC_TOOL_SPECS: readonly ToolSpec[] = [
  { name: 'semantic.definitionAt', method: 'definitionAt', description: '转到定义（只读）', inputSchema: POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'semantic.referencesAt', method: 'referencesAt', description: '查找引用（只读）', inputSchema: POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  {
    name: 'semantic.diagnostics',
    method: 'diagnostics',
    description: `当前文档诊断（只读）。列举面：单页上限 200（与旧硬闸同尺，未放宽），零参调用＝第一页、行为与旧版逐字一致。${PAGE_ACCOUNT_NOTE}`,
    inputSchema: { type: 'object', properties: { ...PAGE_PROPS } },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  { name: 'semantic.hoverAt', method: 'hoverAt', description: '悬停信息（只读）', inputSchema: POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'semantic.suggestAt', method: 'suggestAt', description: '补全候选（只读）', inputSchema: POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  {
    name: 'semantic.documentSymbols',
    method: 'documentSymbols',
    description: `文档符号（只读）。列举面：单页上限 200（与旧硬闸同尺，未放宽），零参调用＝第一页、行为与旧版逐字一致。${PAGE_ACCOUNT_NOTE}`,
    inputSchema: { type: 'object', properties: { ...PAGE_PROPS } },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  { name: 'semantic.tokens', method: 'tokens', description: '词法 token（只读）', inputSchema: { type: 'object', properties: { lineFrom: { type: 'integer' }, lineTo: { type: 'integer' } } }, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'semantic.codeActionsAt', method: 'codeActionsAt', description: '可用代码动作（只读，绝不 apply）', inputSchema: POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
];

/** kernel IO → 3 枚只读工具。`fs.tree` 是本批补游标的列举面；`project.info` 是真零参面。 */
export const KERNEL_IO_TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'project.info',
    method: 'projectInfo',
    description: '当前项目信息（只读）：一次性摘要，无列举面、不收任何入参（严格空对象）。',
    inputSchema: STRICT_NO_ARG_SCHEMA,
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fs.tree',
    method: 'fileTree',
    description: `项目文件树（只读）。列举面：单页上限沿用本面已有的 maxEntries 上限（未放宽），零参调用＝第一页、行为与旧版逐字一致。${PAGE_ACCOUNT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        maxDepth: { type: 'integer', minimum: 0, maximum: 16, description: 'Recursion depth cap (default 6).' },
        maxEntries: { type: 'integer', minimum: 1, maximum: 5000, description: 'Page size (default 500; the pre-existing cap, never widened).' },
        ...PAGE_PROPS,
      },
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search.all',
    method: 'searchAll',
    description: `全工程检索（只读）。命中列表按 limit+cursor 分页；引擎自身封顶时显式给 knownTotal:false（不硬编假 total）。${PAGE_ACCOUNT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, ...PAGE_PROPS },
      required: ['query'],
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
];

/**
 * 补齐「没登记成命令」的功能（最小登记）；危险的一律 'privileged' + destructiveHint。
 * 每条 description 面向模型：说明用途 / 入参 / 返回 / 副作用 / 只读或危险提示 / 路径约束。
 */
export const SUPPLEMENTAL_TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'workspace.searchAll',
    description:
      'Search the whole project for a text query and return file/line hits. Read-only: never mutates files. Use `query` for the case-insensitive substring, optional `scope` to restrict to source files, `maxResults`/`limit` to size a page and `cursor` to resume the next one. Returns {hits:[{path,line,preview}], total, truncated} plus the page account. Honesty note: the search engine itself has a hard hit wall (5000); when the engine reports it overflowed, this surface answers `knownTotal:false` and `engineTruncated:true` instead of pretending the union of pages equals the true match count — narrow the query or page the files with fs.readFile. ' +
      PAGE_ACCOUNT_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 512, description: 'Substring to find (case-insensitive).' },
        scope: { type: 'string', enum: ['all', 'sources'], description: 'Restrict to source files or search all files (default all).' },
        maxResults: { type: 'integer', minimum: 1, maximum: 200, description: 'Page size (default 50; the pre-existing cap, never widened).' },
        ...PAGE_PROPS,
      },
      required: ['query'],
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'problems.quickFix',
    description:
      'Apply ONE quick-fix action that was previously listed by problems.diagnostics / semantic.codeActionsAt. Mutates document content (edit tier). Pass the exact `actionId` from that read-only listing plus a 1-based `line`/`column`. Never invent an action id; never apply a fix before inspecting it. Runs only inside authorized roots.',
    inputSchema: {
      type: 'object',
      properties: {
        actionId: { type: 'string', minLength: 1, maxLength: 256, description: 'Id copied verbatim from a read-only code-action/diagnostic listing.' },
        line: { type: 'integer', minimum: 1, description: '1-based line of the finding.' },
        column: { type: 'integer', minimum: 1, description: '1-based column of the finding.' },
      },
      required: ['actionId', 'line', 'column'],
    },
    tier: 'edit',
    annotations: { idempotentHint: false },
  },
  {
    name: 'problems.diagnostics',
    description:
      'List current problems-panel diagnostics for the active document/project. Read-only. Returns {items:[{message,line,severity,source?}], total, truncated} plus the page account. This surface pages: `maxResults`/`limit` size a page and `cursor` resumes it, so every finding is enumerable. Inspect available actions before proposing any problems.quickFix; a `truncated:true` result means more pages exist (or that you must narrow the query) — never assume completeness. ' +
      PAGE_ACCOUNT_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size (default 200; the pre-existing cap, never widened).' },
        ...PAGE_PROPS,
      },
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fileTree.create',
    description:
      'Create a new file or directory inside the authorized project root. `relPath` MUST be a project-root-relative path (schema rejects absolute paths, drive letters and ".."); the execution layer resolves it against approvedRoots and refuses out-of-domain targets. Mutates the filesystem, does NOT overwrite an existing entry.',
    inputSchema: {
      type: 'object',
      properties: {
        relPath: RELATIVE_PATH_SCHEMA,
        kind: { type: 'string', enum: ['file', 'directory'], description: 'What to create.' },
        content: { type: 'string', maxLength: 1_000_000, description: 'Initial file content (file only).' },
      },
      required: ['relPath', 'kind'],
    },
    tier: 'edit',
    annotations: { idempotentHint: false },
  },
  {
    name: 'fileTree.update',
    description:
      'Overwrite the full text content of an existing file inside the authorized project root. `relPath` is project-root-relative (schema + approvedRoots domain check). This REPLACES the whole content. For a targeted in-document edit use `problems.quickFix` (wired since 2026-11-06: it applies ONE listed code action inside the editor model as a single undo step, does not write to disk) — this tool is the whole-file path. Idempotent for identical `content`. Mutates the filesystem. Refuses (WRITE_DISABLED) when the session-approved roots or the kernel write domain do not cover the target.',
    inputSchema: {
      type: 'object',
      properties: {
        relPath: RELATIVE_PATH_SCHEMA,
        content: { type: 'string', maxLength: 1_000_000, description: 'Full replacement text.' },
      },
      required: ['relPath', 'content'],
    },
    tier: 'edit',
    annotations: { idempotentHint: true },
  },
  {
    name: 'fileTree.remove',
    description:
      'Delete a file or directory inside the authorized project root. PRIVILEGED + destructive: requires per-tool approval (approvedTools) in this session. `relPath` is project-root-relative and domain-checked against approvedRoots. Irreversible from the model perspective; use only after an explicit, itemized approval.',
    inputSchema: {
      type: 'object',
      properties: {
        relPath: RELATIVE_PATH_SCHEMA,
        recursive: { type: 'boolean', description: 'Allow removing a non-empty directory (default false).' },
      },
      required: ['relPath'],
    },
    tier: 'privileged',
    annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false },
  },
  {
    name: 'fileTree.rename',
    description:
      'Rename/move an entry inside the authorized project root. PRIVILEGED + destructive: requires per-tool approval. Both `from` and `to` are project-root-relative and domain-checked against approvedRoots; any out-of-domain target is refused. Read the entry first; this changes the path others may reference.',
    inputSchema: {
      type: 'object',
      properties: { from: RELATIVE_PATH_SCHEMA, to: RELATIVE_PATH_SCHEMA },
      required: ['from', 'to'],
    },
    tier: 'privileged',
    annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false },
  },
  {
    name: 'diff.compare',
    description:
      'Compute a structured diff between two document versions (working buffer vs last snapshot, or two project-root-relative files). Read-only; never writes. Returns {hunks:[...], truncated}. Use `mode` to select the comparison; `left`/`right` are optional relative paths for file-vs-file.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['working-vs-snapshot', 'file-vs-file'], description: 'Which two versions to compare.' },
        left: RELATIVE_PATH_SCHEMA,
        right: RELATIVE_PATH_SCHEMA,
      },
      required: ['mode'],
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'state.replay',
    description:
      'Read a recorded state-replay snapshot / step list. Read-only: does NOT mutate live editor state. Use `step` to select a recorded index and `maxEvents` to cap the event list. Returns {steps:[...], total, truncated}.',
    inputSchema: {
      type: 'object',
      properties: {
        step: { type: 'integer', minimum: 0, description: 'Recorded step index (0-based, default latest).' },
        maxEvents: { type: 'integer', minimum: 1, maximum: 500, description: 'Cap on returned events (default 100).' },
      },
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'preview.document',
    description:
      'Render a neutral, structured preview of a document (2.0 surface) WITHOUT executing any domain logic. Read-only: the preview is a projection, never a write. `relPath` is project-root-relative; `maxLines` caps output. Returns {blocks:[...], truncated}. Domain-specific rendering knowledge is supplied by adapters via mcp.prompt slots, never hardcoded here.',
    inputSchema: {
      type: 'object',
      properties: {
        relPath: RELATIVE_PATH_SCHEMA,
        maxLines: { type: 'integer', minimum: 1, maximum: 2000, description: 'Cap on previewed lines (default 200).' },
      },
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },

  /* ---- 第三波（路 B 能力面真正够用）：把「有真源可接」的只读缺口补成具名工具 ----
   * 全部走 runSupplemental 钩子（宿主注入真源）；宿主未接线 ⇒ NOT_WIRED 可见，
   * 绝不返回空串兜底。真源：Rust IO 原语 / 语义读数面 / 已有 resource 数据面。
   * 每条 description 面向模型，写清用途 / 入参 / 返回 / 只读 / 截断 / 路径约束。
   */
  {
    name: 'commands.list',
    description:
      'List the commands registered in the command palette (id / title / description / tier). Read-only. Same data source as the kojo://project/commands resource, but this surface pages: `maxResults` (or `limit`) sizes a page and `cursor` from the previous response resumes it, so every registered command is enumerable — `total` is the full count and `hasMore`/`nextCursor` say how to get the rest. ' +
      PAGE_ACCOUNT_NOTE +
      ' Discover real ids here before calling any command; never invent a command id.',
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size (default 200; the pre-existing cap, never widened).' },
        ...PAGE_PROPS,
      },
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'document.active',
    description:
      'Read the active document text and cursor position as a read-only projection. Same data source as the kojo://project/active-document resource, but this surface pages: `offset` (0-based character offset) + `length` (alias `maxChars`) address a sub-range, and `cursor` from the previous response resumes exactly where it ended — `textLength` is the FULL length, so concatenating pages reproduces the buffer character-for-character. Page size: default 8000, max 65000 characters (the host sanitizer cuts any untrusted string at 65536, so pages are kept under that gate rather than reported-then-trimmed). ' +
      PAGE_ACCOUNT_NOTE +
      ' Read-first: do not infer any text beyond what is returned.',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0, description: '0-based character offset of the window start (default 0).' },
        length: { type: 'integer', minimum: 1, maximum: 65_000, description: 'Characters in this page (default 8000, max 65000).' },
        maxChars: { type: 'integer', minimum: 1, maximum: 65_000, description: 'Legacy alias of `length`; values above 65000 are clamped down to the host gate.' },
        ...PAGE_PROPS,
      },
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fs.readFile',
    description:
      'Read the text content of one file inside the authorized project root (read-only), page by page. `relPath` MUST be a project-root-relative path — the schema rejects absolute paths, drive letters and ".." traversal, and the execution layer re-checks it against approvedRoots. Backed by the Rust read_file_bytes primitive: the whole file is decoded host-side, this tool returns ONE window. Use `offset` (0-based character offset) + `length` (alias `maxChars`, kept for backwards compatibility) to address a sub-range; a plain `cursor` from the previous page is equivalent and self-checking. ' +
      'Completeness: `textLength` is the FULL character length of the file; `hasMore` says whether characters remain after this page; `nextCursor` resumes exactly where this page ended, so concatenating pages reproduces the file character-for-character. If the file changed between pages the response carries `changedDuringPaging:true` and restarts from offset 0 — do not splice that page with earlier ones. ' +
      'Page size is gated: default 24000 characters, maximum 65000 characters (`length` is clamped). The 65000 ceiling is not a convenience — the host sanitizer cuts any single untrusted string at 65536 characters, so a larger page would have been silently re-truncated after this tool reported its account. Never writes to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        relPath: RELATIVE_PATH_SCHEMA,
        offset: { type: 'integer', minimum: 0, description: '0-based character offset of the window start (default 0). Ignored (treated as head-restart) when a cursor is given.' },
        length: { type: 'integer', minimum: 1, maximum: 65_000, description: 'Characters to return in this page (default 24000, max 65000 — see the host string gate).' },
        maxChars: { type: 'integer', minimum: 1, maximum: 65_000, description: 'Legacy alias of `length`. Values above 65000 are clamped down to the host gate, not up.' },
        ...PAGE_PROPS,
      },
      required: ['relPath'],
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fs.stat',
    description:
      'Query metadata (existence, kind, size, modification time) for one path inside the authorized project root (read-only). `relPath` is project-root-relative and domain-checked against approvedRoots; out-of-domain targets are refused. Backed by the Rust stat_file / path_exists primitives. Never writes to disk and never follows a path outside the approved roots.',
    inputSchema: {
      type: 'object',
      properties: { relPath: RELATIVE_PATH_SCHEMA },
      required: ['relPath'],
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'io.listDir',
    description:
      'List the direct children of one directory inside the authorized project root (read-only). `relPath` is optional (defaults to the project root) and must be project-root-relative; `maxEntries` / `limit` size a page and `cursor` resumes the next one, so a large directory is fully enumerable; `maxDepth` bounds recursion and the result carries an explicit `truncated` flag. Backed by the Rust list_dir / walk_dir primitives. Use it to confirm a relative path exists before any write. Never writes to disk. ' +
      PAGE_ACCOUNT_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        relPath: RELATIVE_PATH_SCHEMA,
        maxEntries: { type: 'integer', minimum: 1, maximum: 5000, description: 'Page size (default 500; the pre-existing cap, never widened).' },
        maxDepth: { type: 'integer', minimum: 0, maximum: 16, description: 'Recursion depth cap (default 1).' },
        ...PAGE_PROPS,
      },
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'io.workspaceRoots',
    description:
      'List the workspace roots registered for the current session (read-only). Backed by the Rust workspace_roots primitive. `maxResults`/`limit` size a page and `cursor` resumes it; the list carries `total` + `hasMore` so it is fully enumerable. Use this to learn the legitimate domain for subsequent relative paths; it never grants write access outside approvedRoots and never mutates state.',
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', minimum: 1, maximum: 200, description: 'Page size (default 50; the pre-existing cap, never widened).' },
        ...PAGE_PROPS,
      },
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'editor.info',
    description:
      'Read editor/runtime metadata (read-only): which surface is active, document counts, and capability flags. Backed by the semantic `info` read. `section` narrows the projection; the result carries an explicit `truncated` flag. A read-only information surface — it never changes editor state and never invents values that the source did not report.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['all', 'editor', 'document'], description: 'Which metadata section to project (default all).' },
        maxResults: { type: 'integer', minimum: 1, maximum: 500, description: 'Cap on returned fields (default 200).' },
      },
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'editor.selfCheck',
    description:
      'Run a read-only self-check of the language/validation layer and return its findings (rule / message / severity). Backed by the semantic `selfCheck` read. `maxResults`/`limit` size a page and `cursor` resumes it, so every finding is enumerable; the result carries an explicit `truncated` flag. It is a diagnostic projection, never a fix and never a write; do not treat it as an authorization to edit. ' +
      PAGE_ACCOUNT_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size (default 200; the pre-existing cap, never widened).' },
        ...PAGE_PROPS,
      },
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lang.foldingRanges',
    description:
      'Return folding ranges for the active document (read-only). Backed by the semantic `foldingRanges` read. `lineFrom` / `lineTo` restrict the window and `maxRanges` caps the result with an explicit `truncated` flag. A structural projection only — it never edits the document and never applies any domain rule.',
    inputSchema: {
      type: 'object',
      properties: {
        lineFrom: { type: 'integer', minimum: 0, description: '0-based first line of the window.' },
        lineTo: { type: 'integer', minimum: 0, description: '0-based last line of the window.' },
        maxRanges: { type: 'integer', minimum: 1, maximum: 2000, description: 'Cap on returned ranges (default 500).' },
      },
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lang.highlightsAt',
    description:
      'Return document highlights for the symbol at a 1-based line/column (read-only). Backed by the semantic `highlightsAt` read. Returns the matched ranges without mutating the document. Use the read-only result to understand symbol usage before proposing any edit; never apply a change from this call.',
    inputSchema: POS_SCHEMA,
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lang.signatureAt',
    description:
      'Return signature help at a 1-based line/column (read-only). Backed by the semantic `signatureAt` read. Returns candidate signatures / active parameter without mutating the document. Domain wording, if any, comes only through mcp.prompt slots; this tool reports the raw language-service output.',
    inputSchema: POS_SCHEMA,
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lang.markers',
    description:
      'Return the current marker set for the active document (read-only). Backed by the semantic `markers` read. `maxResults`/`limit` size a page and `cursor` resumes it, so the full marker set is enumerable; the result carries an explicit `truncated` flag. This is a read-only problem/decoration projection — it never clears or edits a marker and never fabricates a finding. ' +
      PAGE_ACCOUNT_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size (default 200; the pre-existing cap, never widened).' },
        ...PAGE_PROPS,
      },
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },

  /* ---- 第四波（LaneF，2026-11-06）：11 条 cheap-read 逐条判性后登记 6 枚只读具名工具 ----
   * 全部按只读档登记并带 readOnlyHint:true，走 runSupplemental 钩子（宿主注入真源）；缺真源 ⇒ NOT_WIRED 可见。
   * 另 5 条刻意不登记（理由见 MCP_DEFERRED_GAP_NOTES 与 commit 回执）：
   *   read_file_bytes_raw / read_files_raw（ipc::Response 二进制帧，无模型可调用的结构化数据面）、
   *   updater_relaunch / debug.type（非只读动作）、debug.actions（真源对 MCP 注入面不可达）。
   */
  {
    name: 'app.dataDir',
    description:
      'Read the application data directory path as a plain string (read-only, no arguments). Backed by the Rust app_data_dir primitive. Informational only: it does NOT grant read/write access outside approvedRoots, does not list or touch any file, and must never be used as a write target. Single path string, no truncation.',
    // 诚实零参契约：显式拒绝任何入参，不用空 {type:'object'} 兜底（见 mcp-host.test.ts 的 schema 闸）。
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'codec.encodeString',
    description:
      'Encode a text string into bytes with a named character encoding and return the result as base64 (read-only, pure conversion, no IO). `encoding` is a fixed whitelist (utf-8, utf-8-bom, shift_jis, gbk, gb18030, big5, utf-16le, utf-16be); unsupported characters produce a visible error, never a silent replacement. Backed by the Rust encode_string primitive. Returns {encoding, charLength, base64}. Never writes a file; persisting bytes is a separate authorized edit tool.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: 1_000_000, description: 'Text to encode.' },
        encoding: { type: 'string', enum: ['utf-8', 'utf-8-bom', 'shift_jis', 'gbk', 'gb18030', 'big5', 'utf-16le', 'utf-16be'], description: 'Target encoding (fixed whitelist).' },
      },
      required: ['text', 'encoding'],
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fs.pathExists',
    description:
      'Check whether one path exists inside the authorized project root (read-only). `relPath` MUST be a project-root-relative path — the schema rejects absolute paths, drive letters and ".." traversal, and the execution layer resolves it against approvedRoots and refuses any out-of-domain target. Backed by the Rust path_exists primitive. Returns {path, exists} with the real filesystem answer; never writes to disk.',
    inputSchema: {
      type: 'object',
      properties: { relPath: RELATIVE_PATH_SCHEMA },
      required: ['relPath'],
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fs.statFiles',
    description:
      'Batch-query metadata (existence, size, modification time) for several paths inside the authorized project root (read-only). `relPaths` is an array of project-root-relative paths; EACH is schema-checked and resolved against approvedRoots, and any out-of-domain target is refused. `maxResults` caps the returned items with an explicit `truncated` flag; input order is preserved. Backed by the Rust stat_files primitive — a missing file yields exists:false with null size/mtimeMs (never a fabricated zero). Read-only; never writes to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        relPaths: { type: 'array', items: RELATIVE_PATH_SCHEMA, minItems: 1, maxItems: 200, description: 'Project-root-relative paths (each domain-checked).' },
        maxResults: { type: 'integer', minimum: 1, maximum: 200, description: 'Cap on returned stat items (default 200).' },
      },
      required: ['relPaths'],
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lang.lensesAt',
    description:
      'Return code lenses for the active document (read-only). Backed by the codeLensProvider registry through the same read-only provider collection used by lang.highlightsAt / lang.foldingRanges. `provideCodeLenses` is a whole-document call; an optional 1-based `line` filters to lenses whose range covers that line. Results are raw provider output: each item reports its range and, when the provider already supplied a command, its title/commandId; MCP does NOT call resolveCodeLens, so an item with no command is reported with resolved:false, never fabricated. `maxResults` caps the list with an explicit `truncated` flag; `providers`/`answered` keep the three-state account. Never applies a command or edits the document.',
    inputSchema: {
      type: 'object',
      properties: {
        line: { type: 'integer', minimum: 1, description: 'Optional 1-based line filter.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 200, description: 'Cap on returned lenses (default 30).' },
      },
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lang.selectionRangesAt',
    description:
      'Return selection-range (smart-expand) chains for a 1-based line/column (read-only). Backed by the selectionRangeProvider registry through the same read-only provider collection used by lang.highlightsAt. Each chain is reported in the provider-supplied order (near to far) as a list of ranges; MCP does NOT do the UI merge/sort/dedup post-processing. `maxChains` caps the list with an explicit `truncated` flag; `providers`/`answered` keep the three-state account. A projection only — never changes the selection or edits the document.',
    inputSchema: {
      type: 'object',
      properties: {
        line: { type: 'integer', minimum: 1 },
        column: { type: 'integer', minimum: 1 },
        maxChains: { type: 'integer', minimum: 1, maximum: 200, description: 'Cap on returned chains (default 8).' },
      },
      required: ['line', 'column'],
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },

  /* ---- 第五波（LaneH，2026-11-06）：Wave4 #4 判性落地 ----
   * 判性落地：editor.openDocument / editor.revealPosition 两枚 edit 档工具刻意不登记，
   * 证据逐条如下；只读 editor.cursor 单独记账。
   * 按铁律 4「缺席=NOT_WIRED、截断=truncated 可见、真源不存在=不登记（绝不挂空串假实现）」：
   * 这两枚名字不进 SUPPLEMENTAL_TOOL_SPECS、不进 MCP_TOOL_GAP_MAP、不进真源腿表，
   * 只作为显式缺口留在 MCP_DEFERRED_GAP_NOTES 的 Wave4 #4 条目；runSupplemental 仍保留
   * 前置兜底，对任何误调抛可见 NOT_WIRED（绝不假成功）。
   * 判性结论（逐条证据见 commit 回执）：宿主没有可从 MCP 注入面安全复用、且能诚实回报
   * 执行结果的「打开项目内文件 / 把光标定位到行列」真源——
   *   · editor.revealLocation（App.tsx:1379）是唯一真实的打开+定位通道，但它是
   *     fire-and-forget 事件：无 ack / 无落地确认；落地走 React setState 异步重渲染；
   *     routeOpenPath（App.tsx:1750）只过 .kojo2 入口闸、不校验路径是否在项目根内；
   *     订阅者只在 App 组件挂载（GUI 运行时）存在。发射后回报「已打开」= 推断 / 假成功，
   *     回报「已发射意图（未确认）」= 把无确认副作用包装成具名工具 —— 都不诚实。
   *   · EditorCommandContext（slots-types.ts:399）只读投影，无 open / reveal 句柄；
   *     McpRealSourceHost（real-sources.ts:1008）只有三个只读 getter；
   *     CommandEntry.run（commands.ts:138 / ProjectView.tsx:790）忽略 args、返回 void、
   *     gotoLine 经 editor.action.request 触发 Monaco 交互式输入框；
   *     editor-pane-registry 全是纯读登记簿（openModelAcrossGroups 只查已开 model 不打开）；
   *     file-tree-ops + 内核 io.readText(read_file_bytes) 是读内容通道，不打开 GUI 文档。
   * 不写盘、不开放任意目标路径；写盘仍只经第四张表 approvedRoots × 内核 writablePaths 双闸。
   * editor.cursor 是分开记账的只读读数加法（真源 = 焦点编辑器 getPosition），不冒充写工具。
   * 本注释刻意不写规格字面量，避免干扰盘点脚本对规格块的正则解析。
   */
  // 与上面缺口判性分开记账：这是安全的只读读数加法（真源 = 焦点编辑器 getPosition，
  // 与 document.active / editor.info 同源），不是打开 / 定位写工具，绝不拿来冒充写能力。
  {
    name: 'editor.cursor',
    description:
      'Read the caret position of the active editor (read-only). Returns {path, language, line, column, lineCount} for the focused document; the 1-based cursor comes from the focused editor, not the model. No arguments, no side effects: never moves the caret and never opens a file. Backed by the same read-only workspace source as document.active / editor.info. When no editor is focused the call fails with a visible NOT_WIRED (never a fabricated {line:1,column:1}). This is a READ tool, deliberately separate from the editor.openDocument / editor.revealPosition NOT_WIRED gap.',
    // 诚实零参契约：显式拒绝任何入参，不用空 {type:'object'} 兜底（见 mcp-host.test.ts 的 schema 闸）。
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },


  /* ---- Wave4 余项⑤（LaneL，2026-11-06）：长任务 progress = ADR-0013 P5「Tasks over MCP」 ----
   * 判性落地（逐条证据见 real-sources-tasks.ts 模块头与 commit 回执）：只登记**三件套齐备**的族
   * ——进度有真源、取消有真源、状态可查询。目前两族：
   *   · search —— 进度真源 = 壳层 `kojo:search-progress`（按文件数与时间双条件节流、按 searchId
   *     认领），取消真源 = `cancel_search`（同一 cancelled 集合，检索线程逐文件读），
   *     完成态由 `search_text` 返回值收口；
   *   · validation —— 启动/终态真源 = 内核 `convention.linter` 的 run/report，取消真源 =
   *     ConventionRunOptions.signal（引擎只在文件单元间隙看这颗闸），**运行中没有逐单元进度回调**
   *     ⇒ progress 显式 known:false + reason，只有终态那一轮由引擎陈述 incomplete（事后读数）。
   * 刻意不登记：索引构建（无取消位 + 会改写 GUI 在用的全局索引）、导出（对话框即授权、无进度无取消、
   * 任务参数绝不允许变成可选落点）；启动器任务表三件套齐全但另有主人与第三张表 ⇒ 本批不并表，
   * 缺席事实在 kojo://tasks 的 notIncluded[] 里可见（不静默）。
   * 传输形态纪律：MCP 端点是无状态单请求 HTTP，**进度契约＝轮询读**（tasks.status / kojo://tasks）；
   * 本批不把 capabilities 的 resources.subscribe 抬成 true，也不伪造 notification。
   * 落盘边界：两族都不写项目目录（校验快照走内核既有 storage 命名空间），roots 只由项目载荷投影，
   * 不接受调用方给的绝对路径 ⇒ 不新建任何写通道。
   * 本注释刻意不写规格字面量，避免干扰盘点脚本对规格块的正则解析。
   */
  {
    name: 'tasks.start',
    description:
      'Register one long operation as a queryable, cancellable task instead of a single blocking tools/call. kind "search" runs the same native project-wide search the shell runs (throttled progress frames feed done/total/matchCount); kind "validation" starts one convention-linter round, which has NO live per-unit progress (progress.known:false, done/total stay null - never 0%) and only reports incomplete{unitsDone,unitsTotal} at the end. Returns the task view immediately WITHOUT awaiting it: {taskId, status, progress, cancelRequested}. Poll with tasks.status or read the kojo://tasks resource - this endpoint is request/response, the server never pushes. Bounded by design: at most 2 running tasks per session and 32 table rows with lazy retention; over capacity the call fails visibly with RESOURCE_UNAVAILABLE instead of queueing. Roots come from the open project contract only (no path arguments), and neither kind writes to the project. Export and index building are deliberately NOT registered as tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['search', 'validation'],
          description: 'Which long operation to model as a task (default: search).',
        },
        query: { type: 'string', minLength: 1, maxLength: 512, description: 'search kind only: case-insensitive substring to find.' },
        scope: {
          type: 'string',
          enum: ['all', 'sources'],
          description: 'search kind only: scan the project root (all) or the contract source dirs (sources).',
        },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'search kind only: hit cap handed to the shell (default 200, values are clamped).',
        },
        force: { type: 'boolean', description: 'validation kind only: bypass the snapshot cache and re-check every unit.' },
      },
    },
    tier: 'edit',
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  {
    name: 'tasks.status',
    description:
      'Poll one task started by tasks.start inside THIS session (read-only, zero side effects). Returns {taskId, kind, status, progress{known, phase, done, total, percent, frames, lastFrameAgeMs}, cancelRequested, cancelApplied, result}. progress.done/total are null before the first throttled frame and stay null when the operation has no live progress source (progress.known:false plus the reason) - null means "not reported", NOT 0% and NOT "nothing is happening"; readings between frames keep the last frame with its age. The stored result projection is bounded and carries an explicit truncated flag. An unknown id, a recycled row (retention is 10 minutes; reloading the editor page clears the whole table) or another session\'s task all fail visibly with RESOURCE_UNAVAILABLE - never an empty frame. Poll, do not subscribe: the transport does not push progress.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 128, description: 'The id returned by tasks.start.' },
      },
      required: ['taskId'],
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'tasks.cancel',
    description:
      'Request cancellation of one task in THIS session. Cancellation is a REQUEST, not an acknowledgement: a search task forwards the shell cancel for its own search id (the worker checks the flag between files and reports cancelled in the final result), a validation task sets this run\'s abort signal - and if the round merged with one the GUI already started, this task\'s flag does not apply. Read tasks.status for the fact: status "cancelled" with cancelApplied:true; cancelApplied:false states honestly that it finished first. A task already in a terminal state returns idempotently with alreadyFinished:true (no error, and no claim of having cancelled something); a missing cancel primitive fails visibly with NOT_WIRED instead of pretending success. Never touches files, the write domains or the export dialog.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 128, description: 'The id returned by tasks.start.' },
      },
      required: ['taskId'],
    },
    tier: 'edit',
    annotations: { readOnlyHint: false, idempotentHint: true },
  },

  /* ---- B3 批（LaneO，2026-11-06）：编辑器写 / 光标副作用 5 枚具名工具（tier 'edit'）----
   * 真源 = debug/install-debug.ts 已实现并测过的同一批腿（回读核对 / normalizeCursorTarget /
   * editorReadOnly），执行体见 app `mcp/editor-write-legs.ts`（ioTools 腿表）。差别只在：MCP 面
   * 按 paneId 显式反查实例，**没有「当前聚焦」这个语义**；只读实例的内容写两枚显式拒绝。
   * 五枚都只改 Monaco 模型：`saved:false` 恒定如实回报，磁盘写仍是 fileTree.update +
   * 第四张表双闸那条唯一法定通道（铁律 5/6/7：本批零新增写盘通道）。
   */
  {
    name: 'editor.setValue',
    description:
      'Replace the ENTIRE text of one open document in the editor model (edit tier, mutating). `paneId` is required — this tool has no notion of a "focused" editor, so pass the id reported by document.active / editor.info. Coordinates are irrelevant here: `text` is the whole new content. The call verifies the change by reading the model back: an unchanged or refused write fails with [E_EDITOR_APPLY_UNVERIFIED] instead of reporting success. A read-only editor is refused outright ([E_EDITOR_READ_ONLY], PERMISSION_DENIED). This mutates the in-memory model ONLY — the reply always carries saved:false, disk bytes are untouched; persisting goes through fileTree.update under the approvedRoots x writablePaths double gate. Undo is not recorded for a whole-model setValue; use editor.type for a single undo step.',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: { type: 'string', minLength: 1, maxLength: 128, description: 'Editor pane id copied from document.active / editor.info (required, no "focused editor" fallback).' },
        text: { type: 'string', maxLength: 4_000_000, description: 'Complete new document content (the whole model is replaced).' },
      },
      required: ['paneId', 'text'],
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { idempotentHint: false },
  },
  {
    name: 'editor.type',
    description:
      'Insert `text` at the current caret of one open document, the way typing does (edit tier, mutating). `paneId` is required (no "focused editor" semantics on this surface). Runs through Monaco executeEdits, so it is ONE undo step (Ctrl+Z once) and moves the caret. The result is verified by reading the model back: a refused or no-op insertion fails with [E_EDITOR_APPLY_UNVERIFIED] rather than pretending success. A read-only editor is refused outright ([E_EDITOR_READ_ONLY], PERMISSION_DENIED). Model-only: the reply always carries saved:false and the real dirty flag; nothing is written to disk (persisting is fileTree.update under the double gate).',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: { type: 'string', minLength: 1, maxLength: 128, description: 'Editor pane id (required).' },
        text: { type: 'string', minLength: 1, maxLength: 200_000, description: 'Text to insert at the caret (not truncated).' },
      },
      required: ['paneId', 'text'],
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { idempotentHint: false },
  },
  {
    name: 'editor.setCursor',
    description:
      'Move the caret of one open editor pane to a 1-based `line` / `column` (edit tier: it changes user-visible editor state, so a read session must not be able to move the caret). `paneId` is required — there is no "focused editor" fallback. Coordinates are validated strictly 1-based positive integers by the same normalizer the debug surface uses; dirty values (0-based, fractional, missing line) fail with INVALID_ARGS instead of silently landing elsewhere. Out-of-document lines are refused, not clamped. The reply reports both `requested` and the read-back `cursor` plus a `clamped` flag, so a clamp by Monaco is visible rather than a false "it moved". Content is untouched: dirty/contentChanged stay honest and saved:false always holds (no disk write).',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: { type: 'string', minLength: 1, maxLength: 128, description: 'Editor pane id (required).' },
        line: { type: 'integer', minimum: 1, description: '1-based target line.' },
        column: { type: 'integer', minimum: 1, description: '1-based target column (omitted = line start, column 1).' },
      },
      required: ['paneId', 'line'],
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { idempotentHint: true },
  },
  {
    name: 'editor.setSelection',
    description:
      'Set the selection range of one open editor pane with 1-based `startLine`/`startColumn`/`endLine`/`endColumn` (edit tier — user-visible editor state, not a read operation). `paneId` is required (no "focused editor" semantics). Dirty or 0-based coordinates fail with INVALID_ARGS; `endLine` must be >= `startLine`; lines beyond the document are refused, while columns beyond the line end are clamped to the line end and reported in the `clamped` flag with the read-back `selection`. Content is not modified (contentChanged:false) and nothing is persisted: the reply always carries saved:false plus the model dirty flag.',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: { type: 'string', minLength: 1, maxLength: 128, description: 'Editor pane id (required).' },
        startLine: { type: 'integer', minimum: 1, description: '1-based selection start line.' },
        startColumn: { type: 'integer', minimum: 1, description: '1-based selection start column.' },
        endLine: { type: 'integer', minimum: 1, description: '1-based selection end line (>= startLine).' },
        endColumn: { type: 'integer', minimum: 1, description: '1-based selection end column (clamped to the line end; the clamp is reported).' },
      },
      required: ['paneId', 'startLine', 'startColumn', 'endLine', 'endColumn'],
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { idempotentHint: true },
  },
  {
    name: 'editor.revealLine',
    description:
      'Scroll one open editor pane so a 1-based `line` is visible (edit tier: viewport state the user sees, so it is not exposed to read sessions). `paneId` is required — this surface has no "focused editor". `reveal` selects the alignment: "center", "top" (near top) or "nearest" (default, minimal scrolling); there is no invented "bottom" variant. A line beyond the document is clamped to the last line and the clamp is reported explicitly (requestedLine vs revealedLine). The viewport method failing is reported as an error instead of a silent success. No content change and no disk write: contentChanged:false and saved:false always hold.',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: { type: 'string', minLength: 1, maxLength: 128, description: 'Editor pane id (required).' },
        line: { type: 'integer', minimum: 1, description: '1-based line to reveal (clamped to the last line; the clamp is reported).' },
        reveal: { type: 'string', enum: ['center', 'top', 'nearest'], description: 'Alignment variant (default nearest).' },
      },
      required: ['paneId', 'line'],
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { idempotentHint: true },
  },
];

/**
 * 工具 → 真源缺口登记（供 `tools/mcp-inventory.mjs` 静态解析做覆盖对拍；不参与运行时）。
 * 每项一行纯字面量：`tool` 是工具名，`gap` 是盘点缺口清单里的名字，`source` 指明缺口所在真源。
 * `source:'tool-surface'` 的工具是为「与 headless 只读面同形」登记的能力，不对应具体缺口。
 * 盘点脚本会交叉校验：tool 必须在 *_TOOL_SPECS 清单里、gap 必须在真实缺口里——
 * 对不上就如实降级为「未覆盖」，绝不假绿（铁律 4：不静默、不伪造读数）。
 */
export const MCP_TOOL_GAP_MAP: readonly {
  readonly tool: string;
  readonly gap: string;
  readonly source: 'rust' | 'debug' | 'tool-surface';
}[] = [
  { tool: 'semantic.definitionAt', gap: 'definitionAt', source: 'debug' },
  { tool: 'semantic.referencesAt', gap: 'referencesAt', source: 'debug' },
  { tool: 'semantic.diagnostics', gap: 'diagnostics', source: 'debug' },
  { tool: 'semantic.hoverAt', gap: 'hoverAt', source: 'debug' },
  { tool: 'semantic.suggestAt', gap: 'suggestAt', source: 'debug' },
  { tool: 'semantic.documentSymbols', gap: 'documentSymbols', source: 'debug' },
  { tool: 'semantic.tokens', gap: 'tokens', source: 'debug' },
  { tool: 'semantic.codeActionsAt', gap: 'codeActionsAt', source: 'debug' },
  { tool: 'fs.tree', gap: 'walk_dir', source: 'rust' },
  { tool: 'search.all', gap: 'search_text', source: 'rust' },
  { tool: 'workspace.searchAll', gap: 'search_text', source: 'rust' },
  { tool: 'problems.diagnostics', gap: 'diagnostics', source: 'debug' },
  // 写腿批（2026-11-06）：fileTree.create / fileTree.update 执行体已接线（app real-sources-io.ts
  // 走内核 io 写原语 createFileExclusive/writeText，双闸＝第四张表 approvedRoots + 内核写允许域；
  // 内核写域拒绝 ⇒ WRITE_DISABLED）。本两行保留为**覆盖声明**（create_file_exclusive /
  // write_file_bytes 经具名工具覆盖，不再是「需宿主接线」的剩余缺口），数据结构形状不变。
  { tool: 'fileTree.create', gap: 'create_file_exclusive', source: 'rust' },
  { tool: 'fileTree.update', gap: 'write_file_bytes', source: 'rust' },
  // fileTree.remove / fileTree.rename 执行体同样已接线（privileged：第四张表 approvedRoots
  // × 内核写允许域双闸，逐闸拒绝显式报错）——写腿读数 wired 5 / NOT_WIRED 0。
  { tool: 'fileTree.remove', gap: 'remove_file', source: 'rust' },
  { tool: 'fileTree.rename', gap: 'rename_path', source: 'rust' },
  { tool: 'commands.list', gap: 'commands', source: 'tool-surface' },
  { tool: 'document.active', gap: 'active-document', source: 'tool-surface' },
  { tool: 'fs.readFile', gap: 'read_file_bytes', source: 'rust' },
  { tool: 'fs.stat', gap: 'stat_file', source: 'rust' },
  { tool: 'io.listDir', gap: 'list_dir', source: 'rust' },
  { tool: 'io.workspaceRoots', gap: 'workspace_roots', source: 'rust' },
  { tool: 'editor.info', gap: 'info', source: 'debug' },
  { tool: 'editor.selfCheck', gap: 'selfCheck', source: 'debug' },
  { tool: 'lang.foldingRanges', gap: 'foldingRanges', source: 'debug' },
  { tool: 'lang.highlightsAt', gap: 'highlightsAt', source: 'debug' },
  { tool: 'lang.signatureAt', gap: 'signatureAt', source: 'debug' },
  { tool: 'lang.markers', gap: 'markers', source: 'debug' },
  // 第四波（LaneF，2026-11-06）：11 条 cheap-read 逐条判性后登记 6 枚只读具名工具。
  // debug 类 gap 名不带 debug. 前缀（盘点脚本 gapSets.debug 口径）；另 5 条刻意不登记，见回执。
  { tool: 'app.dataDir', gap: 'app_data_dir', source: 'rust' },
  { tool: 'codec.encodeString', gap: 'encode_string', source: 'rust' },
  { tool: 'fs.pathExists', gap: 'path_exists', source: 'rust' },
  { tool: 'fs.statFiles', gap: 'stat_files', source: 'rust' },
  { tool: 'lang.lensesAt', gap: 'lensesAt', source: 'debug' },
  { tool: 'lang.selectionRangesAt', gap: 'selectionRangesAt', source: 'debug' },
  // Wave4 余项⑤（LaneL）：长任务面的两条 Rust 真源。tasks.start 的检索 kind 就是同一条
  // search_text（进度帧 / 取消都按同一 searchId 认领，缺口早由 search.all 覆盖 ⇒ 不改 wired 计数）；
  // tasks.cancel 的取消真源是 cancel_search —— 它此前作为「写/授权/UI 之外的生命周期原语」留在
  // 剩余缺口里，本批起它由具名工具覆盖（诚实降级 deferred 计数，不是凭空宣布覆盖）。
  { tool: 'tasks.start', gap: 'search_text', source: 'rust' },
  { tool: 'tasks.cancel', gap: 'cancel_search', source: 'rust' },
  // B3 批（LaneO，2026-11-06）：编辑器写 / 光标副作用五枚登记为具名 edit 工具，真源同调试面
  // （install-debug.ts 的 applySetValue / applyTypedEdit / normalizeCursorTarget / editorReadOnly），
  // 执行腿见 app `mcp/editor-write-legs.ts`（ioTools 腿表）。`debug:format` 刻意留在缺口里
  // （异步 provider 通道 + 长度读数，本期不登记，不挂半截实现）。
  { tool: 'editor.setValue', gap: 'setValue', source: 'debug' },
  { tool: 'editor.type', gap: 'type', source: 'debug' },
  { tool: 'editor.setCursor', gap: 'setCursor', source: 'debug' },
  { tool: 'editor.setSelection', gap: 'setSelection', source: 'debug' },
  { tool: 'editor.revealLine', gap: 'revealLine', source: 'debug' },
];

/**
 * 刻意不补成工具的缺口类别（显式标注，铁律 4：不静默）。
 * 这些缺口没有「模型可安全调用的数据面」，或属危险 / 写 / UI 动作，故留在盘点缺口清单里，
 * 绝不造一个返回空串的假实现。盘点脚本会把这些类别连同每条剩余缺口的原因一起输出。
 */
export const MCP_DEFERRED_GAP_NOTES: readonly { readonly scope: string; readonly reason: string }[] = [
  { scope: 'launcher_* / market_* / open_url_external / export_file / remove_* / rename_path', reason: '危险工具（privileged）：默认不进 tools/list，须宿主经第四张表逐会话批准，annotations 不可信。' },
  { scope: 'mcp_* 会话控制 / 审计', reason: '宿主线协议与第四张表内建命令，不作为模型可调用工具。' },
  { scope: 'choose_* / pick_* / show_in_folder 等原生对话框', reason: '面向人的 UI 交互，无模型可调用的数据面。' },
  { scope: 'format（编辑器写副作用 · B3 批后仅剩这一条）', reason: '编辑器写/光标副作用一族里 revealLine / setCursor / setSelection / setValue（含 type）已于 B3 批登记为具名 edit 工具（editor.* 五枚，真源 = debug/install-debug.ts 的实现腿）；format 仍留缺口：它是异步 provider 通道（editor.action.formatDocument.run + 前后长度读数），本期刻意不登记半截实现，绝不挂空串假成功。' },
  { scope: 'ui.* 槽贡献（面板 / 装饰 / 语言服务注册）', reason: '纯 UI / 注册贡献，无独立数据面；领域知识只经 mcp.prompt 槽注入。' },
  { scope: '其余未登记只读原语', reason: '真源存在但本波未登记为具名工具：保留在缺口清单，宿主后续按需补，绝不挂空串假实现。' },
  { scope: 'LaneF 第四波刻意不登记的 5 条 cheap-read', reason: 'read_file_bytes_raw / read_files_raw：ipc::Response 二进制帧（前端拿 ArrayBuffer / 自定义帧），是开项目热路径性能通道，无面向模型的结构化只读数据面，且 read_files_raw 收任意 paths 数组，不登记以免暴露任意目标路径参数（项目根内文本读已由 fs.readFile 覆盖）；updater_relaunch=app.restart() 重启动作、debug.type=applyTypedEdit 编辑器输入动作，均非只读；debug.actions 真源 focusedCtx().editorRef.current.getSupportedActions() 对 MCP 注入面不可达，绝不挂空数组假实现。' },
  { scope: 'Wave4 #4 · editor.openDocument / editor.revealPosition（LaneH 判性，显式 NOT_WIRED 判据）', reason: '宿主无可从 MCP 注入面安全复用、且能诚实回报结果的打开文档 / 定位光标真源。逐条不可复用：editor.revealLocation（App.tsx:1379）是 fire-and-forget 事件，无 ack / 无落地确认 / 落地走 React setState 异步重渲染 / routeOpenPath 不校验项目根域 / 订阅者只在 GUI 挂载时存在，发射后回报已打开即假成功；EditorCommandContext（slots-types.ts:399）只读投影无句柄；McpRealSourceHost（real-sources.ts:1008）仅三个只读 getter；CommandEntry.run（commands.ts:138 / ProjectView.tsx:790）忽略 args 且返回 void，gotoLine 经 editor.action.request 触发 Monaco 交互输入框；editor-pane-registry 全为纯读登记簿，openModelAcrossGroups 只查已开 model 而不打开；file-tree-ops 与内核 io.readText(read_file_bytes) 只读文件内容，不打开 GUI 文档也不定位光标。两枚 edit 档工具按铁律刻意不登记（真源不存在 ⇒ 不登记 + 显式缺口，绝不挂空串假实现），既不进工具清单也不进覆盖登记；runSupplemental 前置兜底仍对任何误调抛可见 NOT_WIRED，绝不 emit 无确认事件冒充成功；写盘仍只经第四张表 approvedRoots × 内核 writablePaths 双闸。只读 editor.cursor 是分开记账的加法，绝不冒充写工具。' },
];

/** 内置 resource（≥6 的硬要求；「当前文档与光标」是第一波后的加法，Wave4 余项⑤再加 `kojo://tasks`）。 */
export interface McpResourceSpec {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType?: string;
}

export const MCP_RESOURCE_SPECS: readonly McpResourceSpec[] = [
  { uri: 'kojo://project/snapshot', name: '项目快照', description: '当前项目的一屏聚合快照', mimeType: 'application/json' },
  { uri: 'kojo://project/file-tree', name: '文件树', description: '项目根内文件树', mimeType: 'application/json' },
  { uri: 'kojo://project/diagnostics', name: '诊断', description: '当前诊断读数（投影为可读列表 + truncated 标记）', mimeType: 'application/json' },
  { uri: 'kojo://project/validation-failures', name: '校验失败规则', description: '校验 report.failedRules（投影为可读列表 + truncated 标记）', mimeType: 'application/json' },
  { uri: 'kojo://project/commands', name: '命令清单', description: '命令面板注册表清单（投影为可读列表 + truncated 标记）', mimeType: 'application/json' },
  { uri: 'kojo://project/plugins', name: '插件状态', description: '插件状态（inactive 必须可见，含 missing[]；投影 + truncated 标记）', mimeType: 'application/json' },
  { uri: 'kojo://project/events', name: '事件环形缓冲', description: '内核事件环形缓冲最近记录', mimeType: 'application/json' },
  { uri: 'kojo://project/active-document', name: '当前文档与光标', description: 'Active document text and cursor position（投影 + 截断上限 + truncated 标记）', mimeType: 'application/json' },
  // Wave4 余项⑤（LaneL）：长任务表（新条目，与上面 8 条并列，老条目语义零改动）。
  { uri: 'kojo://tasks', name: '长任务表', description: '本会话长任务清单：状态 / 进度账 / 取消位 / 有界终态投影 + notIncluded[] 缺席任务族逐条原因（轮询面，服务端不推送）', mimeType: 'application/json' },
];

/* ------------------------------------------------------------------ *
 * 6. resource 可读性：截断上限 + 显式 truncated 标记（fail loud，不静默）
 * ------------------------------------------------------------------ */

/** 单个 resource 文本的总上限（字符）；超限必须显式标注，绝不悄悄截掉。 */
export const RESOURCE_TEXT_LIMIT = 24_000;
/** 列表类 resource 的单次条数上限。 */
export const RESOURCE_ITEM_LIMIT = 200;
/** 活动文档正文上限（留出余量，避免投影 JSON 再触发外层截断）。 */
const DOCUMENT_TEXT_CAP = 8_000;

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function asFinite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [];
}

/**
 * 文本总闸：`text` 超过 `cap` 时**不静默截断**，而是返回一个结构化 JSON envelope，
 * 顶层带 `truncated:true` + `cap` + `originalLength` + `preview` + 处置 `hint`。
 * 模型读到 `truncated:true` 就知道要缩小范围 / 分页，而不是误把预览当全文。
 */
export function truncateResourceText(text: string, cap = RESOURCE_TEXT_LIMIT): { text: string; truncated: boolean } {
  const src = typeof text === 'string' ? text : String(text ?? '');
  if (src.length <= cap) return { text: src, truncated: false };
  const envelope = {
    truncated: true,
    cap,
    originalLength: src.length,
    preview: src.slice(0, cap),
    hint: RESOURCE_TRUNCATION_HINT,
  };
  return { text: JSON.stringify(envelope, null, 2), truncated: true };
}

/**
 * 截断时的「去哪拿完整」指针：resources 面按 MCP 协议只有 `uri` 入参、自身无法翻页，
 * 所以显式把客户端引到**带游标的工具面**（同数据源）。分页取舍写死在这一处，见本批回执。
 */
function pagingPointer(truncated: boolean, tool: string, unit = 'items'): Record<string, unknown> {
  return truncated
    ? { hasMore: true, pageableVia: 'tool', pageTool: tool, pageUnit: unit, pageHint: `This resource view is capped; call ${tool} with limit+cursor to enumerate all ${unit}.` }
    : { hasMore: false };
}

/** 当前文档内容与光标 → 可读投影（正文按上限截断并显式标记）。 */
export function slimActiveDocument(raw: unknown, cap = DOCUMENT_TEXT_CAP): Record<string, unknown> {
  const obj = isPlainObject(raw) ? raw : {};
  const text = asString(obj['text'], asString(obj['content']));
  const cursorRaw = obj['cursor'];
  const cursor = isPlainObject(cursorRaw)
    ? { line: asFinite(cursorRaw['line'], 1), column: asFinite(cursorRaw['column'], 1) }
    : { line: 1, column: 1, inferred: true };
  const truncated = text.length > cap;
  const warnings: string[] = [];
  if (!('text' in obj) && !('content' in obj)) warnings.push('源数据缺 text/content（显式标注，不静默）');
  if (!isPlainObject(cursorRaw)) warnings.push('源数据缺 cursor（回退 {line:1,column:1} 并标记 inferred）');
  return {
    path: asString(obj['path'], asString(obj['uri'])),
    language: asString(obj['language']),
    cursor,
    text: truncated ? text.slice(0, cap) : text,
    textLength: text.length,
    truncated,
    ...pagingPointer(truncated, 'document.active', 'characters'),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** 命令清单 → 可读投影（条数上限 + truncated）。 */
export function slimCommandList(raw: unknown, cap = RESOURCE_ITEM_LIMIT): Record<string, unknown> {
  const items = Array.isArray(raw)
    ? asArray(raw)
    : isPlainObject(raw) && Array.isArray(raw['commands'])
      ? asArray(raw['commands'])
      : [];
  const truncated = items.length > cap;
  const commands = items.slice(0, cap).map((it) => {
    const o = isPlainObject(it) ? it : {};
    return {
      id: asString(o['id'], asString(o['name'])),
      title: asString(o['title'], asString(o['id'])),
      description: asString(o['description']),
      tier: asString(o['tier']),
    };
  });
  return { commands, total: items.length, truncated, ...pagingPointer(truncated, 'commands.list') };
}

/** 诊断列表 → 可读投影（条数上限 + truncated）。 */
export function slimDiagnosticList(raw: unknown, cap = RESOURCE_ITEM_LIMIT): Record<string, unknown> {
  const items = Array.isArray(raw)
    ? asArray(raw)
    : isPlainObject(raw) && Array.isArray(raw['items'])
      ? asArray(raw['items'])
      : isPlainObject(raw) && Array.isArray(raw['diagnostics'])
        ? asArray(raw['diagnostics'])
        : [];
  const truncated = items.length > cap;
  const diagnostics = items.slice(0, cap).map((it) => {
    const o = isPlainObject(it) ? it : {};
    return { message: asString(o['message']), line: asFinite(o['line'], 1), severity: asString(o['severity']), source: asString(o['source']) };
  });
  return { diagnostics, total: items.length, truncated, ...pagingPointer(truncated, 'problems.diagnostics') };
}

/** 插件状态 → 可读投影：inactive 必可见、每项含 missing[]；缺字段显式 warnings（不静默）。 */
export function slimPluginStatus(raw: unknown, cap = RESOURCE_ITEM_LIMIT): Record<string, unknown> {
  const obj = isPlainObject(raw) ? raw : {};
  const warnings: string[] = [];
  const takeArray = (key: string): unknown[] => {
    const v = obj[key];
    if (Array.isArray(v)) return asArray(v);
    warnings.push(v === undefined ? `源数据缺字段 ${key}（显式补空数组，不静默）` : `源数据字段 ${key} 不是数组（显式补空数组，不静默）`);
    return [];
  };
  const active = takeArray('active');
  const inactive = takeArray('inactive');
  const missing = takeArray('missing');
  const truncated = active.length > cap || inactive.length > cap || missing.length > cap;
  const inactiveSlim = inactive.slice(0, cap).map((it) => {
    const o = isPlainObject(it) ? it : { id: String(it) };
    const m = o['missing'];
    return { ...o, missing: Array.isArray(m) ? m : [] };
  });
  return {
    active: active.slice(0, cap),
    inactive: inactiveSlim,
    missing: missing.slice(0, cap),
    total: { active: active.length, inactive: inactive.length, missing: missing.length },
    truncated,
    ...(truncated
      ? {
          hasMore: true,
          pageableVia: 'none',
          pageNote:
            'No paginated tool exists for plugin status (this batch adds optional arguments only, no new tool names). Items beyond the cap are NOT enumerable from this surface — say so explicitly rather than assuming the list is complete.',
        }
      : { hasMore: false }),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** 校验 report.failedRules → 可读投影（兼容 raw / raw.report / raw.failedRules / 直接数组）。 */
export function slimValidationFailures(raw: unknown, cap = RESOURCE_ITEM_LIMIT): Record<string, unknown> {
  const sources: unknown[] = [raw];
  if (isPlainObject(raw) && isPlainObject(raw['report'])) sources.push(raw['report']);
  let rules: unknown[] = [];
  let found = false;
  for (const s of sources) {
    if (isPlainObject(s) && Array.isArray(s['failedRules'])) {
      rules = asArray(s['failedRules']);
      found = true;
      break;
    }
  }
  if (!found && Array.isArray(raw)) {
    rules = asArray(raw);
    found = true;
  }
  const truncated = rules.length > cap;
  const failedRules = rules.slice(0, cap).map((it) => {
    const o = isPlainObject(it) ? it : { rule: String(it) };
    return { rule: asString(o['rule'], asString(o['id'])), message: asString(o['message']), severity: asString(o['severity']) };
  });
  return {
    failedRules,
    total: rules.length,
    truncated,
    ...pagingPointer(truncated, 'editor.selfCheck'),
    ...(found ? {} : { warnings: ['report.failedRules 缺席（显式标注，不静默）'] }),
  };
}

/** 按 uri 分派可读性投影；未登记 uri 原样返回（仍会过总闸截断）。 */
export function slimResourceData(uri: string, data: unknown): unknown {
  switch (uri) {
    case 'kojo://project/active-document':
      return slimActiveDocument(data);
    case 'kojo://project/commands':
      return slimCommandList(data);
    case 'kojo://project/plugins':
      return slimPluginStatus(data);
    case 'kojo://project/validation-failures':
      return slimValidationFailures(data);
    case 'kojo://project/diagnostics':
      return slimDiagnosticList(data);
    default:
      return data;
  }
}

/* ------------------------------------------------------------------ *
 * 6b. 分页游标核心（B1「分页游标批」，2026-11-06）
 *
 * 一句话定位：把「截断型」读数面变成「分页型」，让外部 AI **能完整枚举**。
 *
 * 游标形状 = `指纹:下标`（列举面下标＝条目序号，文本面下标＝字符偏移）：
 * - 每次取页都对**当前全量快照**算一个 FNV-1a 指纹（列举面按稳定 key、文本面按正文），
 *   并把它编进 `nextCursor`；
 * - 下一页带着该游标进来时先复算指纹：
 *   ① 指纹相同 ⇒ 快照没变，按下标切是**可自证的**（全页并集 == 全集，无重无漏）；
 *   ② 指纹不同 ⇒ 翻页期间被并发编辑 / 外部写盘改过，**绝不按旧下标盲切**（那正是漏条 /
 *     重复的成因）。此处选择「显式出声 + 从新快照头部整页重发」：返回 `changedDuringPaging:true`
 *     并给出新快照的第 0 页。客户端据此知道「本页不可与旧页拼接」，且无需重启会话就能继续；
 *     不做静默重排、不做假装连续。
 * - 游标形态不合法 ⇒ `INVALID_ARGS`（fail loud，不静默当成第一页）。
 *
 * 完整性账（每页必带）：`total` + `hasMore` + `nextCursor` + `offset` + `truncated`
 * （`truncated` 口径不变＝「本次没把全量都呈现」）；取不到全量的面（如引擎自身封顶的检索）
 * 显式给 `knownTotal:false`，不硬编一个假 total。
 *
 * 页大小闸仍是闸：`limit` 一律 clamp 到「该面今天已有的上限」，本批不抬高任何体积闸。
 * ------------------------------------------------------------------ */

/** 分页入参 `limit` 的通用下限（1 条一页也要能出，否则游标死锁）。 */
export const PAGE_LIMIT_MIN = 1;

/** FNV-1a 32 位滚动指纹（列举面按 key 序列、文本面按正文；8 位十六进制）。 */
export function pageFingerprint(parts: readonly string[]): string {
  let h = (0x811c9dc5 ^ parts.length) >>> 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      h = (h ^ part.charCodeAt(i)) >>> 0;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h = (h ^ 0x1f) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 游标 = `指纹:下标`（下标＝下一页的起点；文本面＝字符偏移）。 */
export function encodePageCursor(fingerprint: string, index: number): string {
  return `${fingerprint}:${index}`;
}

const CURSOR_RE = /^([0-9a-f]{8}):(\d{1,10})$/;

/** 解析游标；形态不合法（含非字符串）返回 null，由调用方决定出声口径。 */
export function decodePageCursor(cursor: unknown): { readonly fingerprint: string; readonly index: number } | null {
  if (typeof cursor !== 'string') return null;
  const m = CURSOR_RE.exec(cursor);
  if (!m) return null;
  const index = Number(m[2]);
  if (!Number.isFinite(index)) return null;
  return { fingerprint: m[1] as string, index };
}

/** 分页入参里 `limit` 可复用的旧名（各面历史口径不一，游标是新能力，旧参数零改动）。 */
const PAGE_SIZE_ARG_ALIASES = ['limit', 'length', 'maxChars', 'maxResults', 'maxEntries', 'maxRanges', 'maxEvents', 'maxLines'] as const;

function clampPositiveInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.min(Math.max(min, n), max);
}

function pageSizeOf(args: Record<string, unknown>, defaultLimit: number, maxLimit: number): number {
  for (const alias of PAGE_SIZE_ARG_ALIASES) {
    const v = args[alias];
    if (typeof v === 'number' && Number.isFinite(v)) return clampPositiveInt(v, defaultLimit, PAGE_LIMIT_MIN, maxLimit);
  }
  return clampPositiveInt(undefined, defaultLimit, PAGE_LIMIT_MIN, maxLimit);
}

/** 游标给了但形状不对 ⇒ 显式报错（绝不静默退回第一页冒充连续）。导出给 app 侧手写分页腿复用。 */
export function assertCursorShape(args: Record<string, unknown>): void {
  const raw = args['cursor'];
  if (raw === undefined || raw === null) return;
  if (decodePageCursor(raw) === null) {
    throw new McpFailure(
      'INVALID_ARGS',
      `cursor 形状不合法（期望 \`指纹:下标\`，且必须是上一页 nextCursor 的原样回传）：${String(raw).slice(0, 64)}`,
    );
  }
}

/**
 * 取页参数（给「先要窗口再取数」的腿用，如检索：引擎的 `maxResults` 取决于 offset+limit）。
 * 游标优先于裸 `offset`；游标形状不合法显式报错，绝不静默当第一页。
 */
export function pageParamsFor(
  args: Record<string, unknown>,
  opts: { readonly defaultLimit: number; readonly maxLimit: number },
): { readonly limit: number; readonly offset: number; readonly hasCursor: boolean } {
  assertCursorShape(args);
  const limit = pageSizeOf(args, opts.defaultLimit, opts.maxLimit);
  const decoded = decodePageCursor(args['cursor']);
  if (decoded) return { limit, offset: Math.max(0, decoded.index), hasCursor: true };
  const raw = args['offset'];
  const offset = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  return { limit, offset, hasCursor: false };
}

export interface PageEnvelope {
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly truncated: boolean;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly fingerprint: string;
  readonly changedDuringPaging?: true;
}

/**
 * 列举面分页：`items` 必须是**当前全量**（不是已截断的片段），`keyOf` 给每条的稳定 key。
 * 返回体自带完整性账；`changedDuringPaging` 出现时 `items` 是新快照的第 0 页。
 */
export function paginateByCursor<T>(
  items: readonly T[],
  keyOf: (item: T, index: number) => string,
  args: Record<string, unknown>,
  opts: { readonly defaultLimit: number; readonly maxLimit: number },
): { readonly page: readonly T[]; readonly offset: number; readonly limit: number; readonly total: number; readonly truncated: boolean; readonly hasMore: boolean; readonly nextCursor: string | null; readonly fingerprint: string; readonly changedDuringPaging?: true } {
  assertCursorShape(args);
  const limit = pageSizeOf(args, opts.defaultLimit, opts.maxLimit);
  const fingerprint = pageFingerprint(items.map((it, i) => keyOf(it, i)));
  const decoded = decodePageCursor(args['cursor']);
  let offset = 0;
  let changed: true | undefined;
  if (decoded) {
    if (decoded.fingerprint === fingerprint) {
      if (decoded.index > items.length) {
        throw new McpFailure(
          'INVALID_ARGS',
          `cursor 下标越界：${decoded.index} > 全集 ${items.length} 条。cursor 必须是上一页 nextCursor 的原样回传，` +
            '不得自行推算或改写；请省略 cursor 从第 0 页重翻。',
        );
      }
      offset = decoded.index;
    } else {
      changed = true;
      offset = 0;
    }
  }
  const page = items.slice(offset, offset + limit);
  const next = offset + page.length;
  const hasMore = next < items.length;
  const envelope: PageEnvelope = {
    offset,
    limit,
    total: items.length,
    truncated: page.length < items.length,
    hasMore,
    nextCursor: hasMore ? encodePageCursor(fingerprint, next) : null,
    fingerprint,
  };
  return {
    page,
    ...envelope,
    ...(changed === true ? { changedDuringPaging: true as const } : {}),
  };
}

/**
 * 文本面分页（`fs.readFile` / `document.active`）：游标下标＝字符偏移。
 * 单页字符上限 `maxLimit` 由调用方按**宿主不可信串闸**给（见 app 侧 `MCP_PAGE_TEXT_MAX`），
 * 保证 JS 报出去的账不会在 Rust 转发时被再切一刀（否则「逐页拼接==全文」会在边界上假）。
 */
export function paginateText(
  text: string,
  args: Record<string, unknown>,
  opts: { readonly defaultLimit: number; readonly maxLimit: number },
): { readonly page: string; readonly offset: number; readonly limit: number; readonly total: number; readonly truncated: boolean; readonly hasMore: boolean; readonly nextCursor: string | null; readonly fingerprint: string; readonly changedDuringPaging?: true } {
  assertCursorShape(args);
  const limit = pageSizeOf(args, opts.defaultLimit, opts.maxLimit);
  const fingerprint = pageFingerprint([text]);
  const decoded = decodePageCursor(args['cursor']);
  let offset = 0;
  let changed: true | undefined;
  if (decoded) {
    if (decoded.fingerprint === fingerprint) {
      if (decoded.index > text.length) {
        throw new McpFailure(
          'INVALID_ARGS',
          `cursor 下标越界：${decoded.index} > 正文 ${text.length} 字符。cursor 必须是上一页 nextCursor 的原样回传，` +
            '不得自行推算或改写；请省略 cursor 从第 0 页重翻。',
        );
      }
      offset = decoded.index;
    } else {
      changed = true;
      offset = 0;
    }
  } else if (args['offset'] !== undefined && args['offset'] !== null) {
    // 裸 `offset`（无游标）＝调用方自己指定窗口起点：没有快照指纹可比对，因此**不做连续性保证**，
    // 只做长度夹取；账目里 `cursor` 缺席如实体现（`hasMore`/`nextCursor` 仍自洽，从该偏移往下翻页）。
    const wanted = Math.floor(Number(args['offset']));
    offset = Number.isFinite(wanted) ? Math.min(Math.max(0, wanted), text.length) : 0;
  }
  const page = text.slice(offset, offset + limit);
  const next = offset + page.length;
  const hasMore = next < text.length;
  return {
    page,
    offset,
    limit,
    total: text.length,
    truncated: page.length < text.length,
    hasMore,
    nextCursor: hasMore ? encodePageCursor(fingerprint, next) : null,
    fingerprint,
    ...(changed === true ? { changedDuringPaging: true as const } : {}),
  };
}

/** 截断型 resource 文本的诚实提示：指向**真正存在**的带游标工具面。 */
export const RESOURCE_TRUNCATION_HINT =
  'Resource text exceeded the cap and was truncated. This resource surface is uri-only (MCP resources/read takes no arguments), so it cannot page itself: use the paginated tools instead — fs.readFile/document.active with offset+limit (or cursor) for document text, commands.list / fs.tree / io.listDir / problems.diagnostics / semantic.diagnostics / semantic.documentSymbols with limit+cursor for lists, and re-read with a narrower query. Do NOT assume the preview is the complete content.';

/** 分页游标批：文本面单页上限由宿主不可信串闸决定（见 app 侧 `MCP_PAGE_TEXT_MAX`）。 */
export const HOST_UNTRUSTED_STRING_GATE = 64 * 1024;

/* ------------------------------------------------------------------ *
 * 7. prompts：零游戏名词的领域工作流骨架 + mcp.prompt 槽消费逻辑
 *
 * 骨架只给「读优先 / 校验 / 复核」的工作流结构与具名槽位；任何游戏 / 领域知识
 * 都由 `mcp.prompt` 槽（`*-adapter` 贡献）以片段形式注入 `{{slot:xxx}}`。
 * 槽缺失时渲染成**显式可读占位**（fail loud），骨架绝不编造领域知识。
 * ------------------------------------------------------------------ */

export interface McpPromptSkeletonSpec {
  readonly name: string;
  readonly description: string;
  readonly arguments: readonly { name: string; required?: boolean }[];
  /** 工作流骨架文本：`{{arg}}` 为参数槽，`{{slot:xxx}}` 为 adapter 注入的领域知识槽。 */
  readonly template: string;
  /** 本骨架消费的 mcp.prompt 领域槽名。 */
  readonly slots: readonly string[];
}

export const MCP_PROMPT_SKELETON_SPECS: readonly McpPromptSkeletonSpec[] = [
  {
    name: 'workflow.triage-diagnostics',
    description:
      'Domain-agnostic workflow: inspect the active document, read diagnostics, choose the smallest fix, then re-validate. Domain-specific rules are injected through mcp.prompt slots by adapters, never hardcoded.',
    arguments: [{ name: 'focus', required: false }],
    slots: ['domain_context', 'domain_rules'],
    template: [
      'You assist inside a structured editor through a read-first tool surface.',
      'Goal: triage diagnostics for {{focus}}.',
      'Steps:',
      '1. Read resources (active document, diagnostics, validation failures) BEFORE proposing any edit.',
      '2. Inspect available quick fixes via read-only listings; never invent an action id.',
      '3. Propose the smallest edit for the highest-severity finding. Request explicit itemized approval for any destructive/privileged action.',
      '4. Re-read diagnostics afterwards and report what changed. If a result has truncated=true, narrow the query instead of assuming completeness.',
      'Domain context (mcp.prompt slot):',
      '{{slot:domain_context}}',
      'Domain rules (mcp.prompt slot):',
      '{{slot:domain_rules}}',
    ].join('\n'),
  },
  {
    name: 'workflow.author-review',
    description:
      'Domain-agnostic workflow: author/review a document, compare a diff, preview, and replay state to confirm the result. Domain knowledge comes only from mcp.prompt slots.',
    arguments: [{ name: 'target', required: false }],
    slots: ['domain_context', 'domain_vocabulary'],
    template: [
      'You assist inside a structured editor through a read-first tool surface.',
      'Goal: author and review {{target}}.',
      'Steps:',
      '1. Read the command list and active document to learn what the surface offers.',
      '2. Draft the change as a projection; use diff.compare (read-only) to see exactly what would change.',
      '3. Use preview.document and state.replay (read-only) to confirm the projection without mutating live state.',
      '4. Only then propose an edit inside authorized roots. Any domain wording must come from the injected slots, not from assumptions.',
      'Domain context (mcp.prompt slot):',
      '{{slot:domain_context}}',
      'Domain vocabulary (mcp.prompt slot):',
      '{{slot:domain_vocabulary}}',
    ].join('\n'),
  },
  {
    name: 'workflow.safe-refactor',
    description:
      'Domain-agnostic workflow: plan a refactor by reading structure first, apply only approved minimal edits, then re-read diagnostics and a diff to verify no unintended change.',
    arguments: [{ name: 'scope', required: false }],
    slots: ['domain_context'],
    template: [
      'You assist inside a structured editor through a read-first tool surface.',
      'Goal: plan a safe refactor of {{scope}}.',
      'Steps:',
      '1. Read document symbols and references (read-only) to map every affected site.',
      '2. Enumerate the smallest edits; classify each as read / edit / privileged. Never bundle a destructive action without explicit approval.',
      '3. After an edit, re-read diagnostics and diff.compare; a truncated result must be narrowed, not assumed complete.',
      '4. Report residual findings honestly (fail loud).',
      'Domain context (mcp.prompt slot):',
      '{{slot:domain_context}}',
    ].join('\n'),
  },
];

/** `mcp.prompt` 槽贡献的最小读取形状（宿主把 SlotMap['mcp.prompt'] 贡献投影成这一形状）。 */
export interface McpPromptSlotContributionLike {
  readonly name: string;
  render(args: Record<string, unknown>):
    | Promise<{ messages: readonly { readonly content: { readonly text: string } }[] }>
    | { messages: readonly { readonly content: { readonly text: string } }[] };
}

/**
 * 槽消费：把 `mcp.prompt` 槽贡献 render 出的文本收集成领域片段，供骨架按槽名注入。
 * 这是「游戏知识只能由 *-adapter 注入」的唯一入口——骨架自身不含任何领域事实。
 */
export async function collectPromptSlotFragments(
  contributions: readonly McpPromptSlotContributionLike[],
  args: Record<string, unknown> = {},
): Promise<McpPromptSlotFragment[]> {
  const out: McpPromptSlotFragment[] = [];
  for (const c of contributions ?? []) {
    const rendered = await c.render(args);
    const text = (rendered.messages ?? [])
      .map((m) => (m && typeof m.content?.text === 'string' ? m.content.text : ''))
      .filter(Boolean)
      .join('\n');
    out.push({ name: c.name, text, source: c.name });
  }
  return out;
}

/**
 * 渲染骨架：`{{arg}}` 用入参填，`{{slot:name}}` 用片段填。
 * 参数缺席 / 槽未注入 → **显式可读占位**（不静默、绝不编造领域知识）。
 */
export function renderSkeleton(
  spec: McpPromptSkeletonSpec,
  args: Record<string, unknown>,
  fragments: readonly McpPromptSlotFragment[] = [],
): { messages: { role: 'user'; content: { type: 'text'; text: string } }[] } {
  const byName = new Map(fragments.map((f) => [f.name, f.text]));
  const text = spec.template.replace(/\{\{([^}]+)\}\}/g, (_match: string, key: string): string => {
    const k = key.trim();
    if (k.startsWith('slot:')) {
      const slot = k.slice(5);
      const value = byName.get(slot);
      return value !== undefined && value !== ''
        ? value
        : `[领域槽未注入: ${slot}（adapter 未通过 mcp.prompt 提供；骨架不编造领域知识）]`;
    }
    const value = args[k];
    return value === undefined || value === null || value === ''
      ? `[未提供参数: ${k}]`
      : String(value);
  });
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}

/** 把骨架 + 槽片段装配成可直接喂给 registry 的 `McpPrompt[]`。 */
export function createSkeletonPrompts(fragments: readonly McpPromptSlotFragment[] = []): McpPrompt[] {
  return MCP_PROMPT_SKELETON_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    arguments: spec.arguments,
    render: async (args: Record<string, unknown>) => renderSkeleton(spec, args, fragments),
  }));
}

/* ------------------------------------------------------------------ *
 * 8. 装配 helper
 * ------------------------------------------------------------------ */

/**
 * 命令面板 id → 面向模型的 `tier`。**一律 `privileged`（fail-closed）**：
 *
 * - 命令面板注册的是「面向人的 UI 动作」（写盘 / 另存为 / 原生对话框 / 启动器 /
 *   编辑器写 / 光标与布局副作用），没有独立数据面；ADR-0013 决策 1 与盘点脚本的
 *   deferred 归因都把这一类归为「首期不默认暴露」。
 * - `isDangerousTool` 只认 `launcher_` / `export_file` / `remove_` 等**下划线**形状，
 *   认不出 `workbench.saveAll` / `launcher.openInstances` 这类点号 id；若沿用
 *   `commandToTool` 的缺省 `'edit'`，`tier=edit` 会话就能看见并执行这些动作，
 *   绕过「危险工具默认缺席、逐工具逐会话批准」。
 * - 因此宿主不替用户判断「哪条 UI 动作安全」，统一归 privileged：不进 `tools/list`，
 *   `tools/call` 须在 `scope.approvedTools` 里精确命中。命令作者自报的 `tier` 只许收紧、
 *   不许放宽（与 Rust 侧「annotations 不可信、tier 由宿主裁决」同口径）。
 * - 零游戏名词：只按 id 形状判据，不认领域语义；`declared` 的收紧分支为将来
 *   按显式白名单放开个别纯只读动作留扩展点，当前 inferred 已是最高档。
 *
 * 本函数供宿主（app 侧生产真源登记）调用；`commandToTool` 的缺省行为保持不变。
 */
const TIER_RANK: Readonly<Record<McpTier, number>> = { read: 0, edit: 1, privileged: 2 };

export function classifyCommandTier(id: string, declared?: McpTier): McpTier {
  const inferred: McpTier = 'privileged';
  if (isDangerousTool(id)) return inferred; // 冻结危险名单是显式红线，不接受任何放宽
  if (declared === undefined) return inferred;
  return TIER_RANK[declared] > TIER_RANK[inferred] ? declared : inferred;
}

/** 命令 → 工具：name=id、description=description??title、inputSchema=argsSchema??{}、tier 缺省 'edit'；危险名强制 privileged。 */
export function commandToTool(cmd: McpCommandSource): McpTool {
  const tier: McpTier = isDangerousTool(cmd.id) ? 'privileged' : (cmd.tier ?? 'edit');
  return {
    name: cmd.id,
    description: cmd.description ?? cmd.title,
    inputSchema: cmd.argsSchema ?? {},
    tier,
    run: async (args, scope) => cmd.run(args, scope),
  };
}

function notWired(what: string): McpReaderFn {
  return () => {
    throw new McpFailure('NOT_WIRED', `能力「${what}」未接线：宿主未提供数据源（不静默、不伪造读数）`);
  };
}

function specToTool(spec: ToolSpec, run: McpReaderFn): McpTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    tier: spec.tier,
    ...(spec.annotations ? { annotations: spec.annotations } : {}),
    run: async (args, scope) => run(args, scope),
  };
}

function toText(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data ?? null, null, 2);
}

function dedupeByName(tools: readonly McpTool[]): McpTool[] {
  const seen = new Set<string>();
  const out: McpTool[] = [];
  for (const t of tools) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    out.push(t);
  }
  return out;
}

/** tier 授权判据：只读恒开；privileged 必须显式在 approvedTools；edit 需 edit/privileged 会话。 */
export function tierAllowed(tool: McpTool, scope: McpSessionScope): { allowed: boolean; reason?: string } {
  if (tool.tier === 'privileged') {
    return scope.approvedTools.includes(tool.name)
      ? { allowed: true }
      : { allowed: false, reason: `特权工具 ${tool.name} 未在本会话 approvedTools 中显式批准` };
  }
  if (tool.tier === 'edit' && scope.tier === 'read') {
    return { allowed: false, reason: `只读会话不可调用编辑工具 ${tool.name}` };
  }
  return { allowed: true };
}

/* ------------------------------------------------------------------ *
 * 9. registry 工厂
 * ------------------------------------------------------------------ */

export function createMcpCapabilityRegistry(deps: McpHostDeps): McpCapabilityRegistry {
  const semantic = deps.semantic ?? {};
  const kernelIo = deps.kernelIo ?? {};

  const semanticTools = SEMANTIC_TOOL_SPECS.map((spec) => {
    const method = spec.method as keyof McpSemanticReaders;
    return specToTool(spec, semantic[method] ?? notWired(spec.name));
  });
  const kernelTools = KERNEL_IO_TOOL_SPECS.map((spec) => {
    const method = spec.method as keyof McpKernelIo;
    return specToTool(spec, kernelIo[method] ?? notWired(spec.name));
  });
  const supplementalTools = SUPPLEMENTAL_TOOL_SPECS.map((spec) =>
    specToTool(
      spec,
      deps.runSupplemental
        ? (args, scope) => deps.runSupplemental!(spec.name, args, scope)
        : notWired(spec.name),
    ),
  );
  const commandTools = (deps.commands ?? []).map(commandToTool);
  // 命令来源优先（同 name 时命令登记覆盖内置规格），其后三路。
  const allTools = dedupeByName([...commandTools, ...semanticTools, ...kernelTools, ...supplementalTools]);
  const toolByName = new Map(allTools.map((t) => [t.name, t]));

  const builtinResources: readonly McpResource[] = MCP_RESOURCE_SPECS.map((spec) => ({
    uri: spec.uri,
    name: spec.name,
    description: spec.description,
    ...(spec.mimeType ? { mimeType: spec.mimeType } : {}),
    read: async (scope: McpSessionScope) => {
      if (!deps.readResourceData) {
        throw new McpFailure('RESOURCE_UNAVAILABLE', `resource ${spec.uri} 未提供数据源（不静默）`);
      }
      const data = await deps.readResourceData(spec.uri, scope);
      // 可读性投影（列表/正文带自己的 truncated 标记）→ 文本化 → 总闸截断（带显式 truncated）。
      const projected = slimResourceData(spec.uri, data);
      const { text } = truncateResourceText(toText(projected));
      return { contents: [{ uri: spec.uri, text }] };
    },
  }));
  const resources: McpResource[] = [...builtinResources];
  for (const extra of deps.resources ?? []) {
    const at = resources.findIndex((r) => r.uri === extra.uri);
    if (at >= 0) resources[at] = extra;
    else resources.push(extra);
  }
  const resourceByUri = new Map(resources.map((r) => [r.uri, r]));

  // 骨架仅在宿主显式提供 promptSlots（含空数组）时并入；缺省行为与第一波逐字一致。
  const skeletonPrompts = deps.promptSlots === undefined ? [] : createSkeletonPrompts(deps.promptSlots);
  const prompts: McpPrompt[] = [...skeletonPrompts, ...(deps.prompts ?? [])];
  const promptByName = new Map(prompts.map((p) => [p.name, p]));

  return {
    listTools(scope) {
      return allTools.filter((t) => tierAllowed(t, scope).allowed);
    },

    listResources() {
      return resources;
    },

    listPrompts() {
      return prompts;
    },

    async callTool(name, args, scope) {
      const tool = toolByName.get(name);
      if (!tool) throw new McpFailure('UNKNOWN_TOOL', `未知工具：${name}`);
      const gate = tierAllowed(tool, scope);
      if (!gate.allowed) throw new McpFailure('PERMISSION_DENIED', gate.reason ?? `越权调用 ${name}`);
      const input = args ?? {};
      const check = validateAgainstSchema(tool.inputSchema, input);
      if (!check.valid) {
        throw new McpFailure('INVALID_ARGS', `工具 ${name} 入参不合法：${check.errors.join('；')}`);
      }
      try {
        return await tool.run(input, scope);
      } catch (err) {
        if (isMcpFailure(err)) throw err; // 结构化失败原样透出（NOT_WIRED 等）
        throw new McpFailure('TOOL_EXECUTION_FAILED', `工具 ${name} 执行失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async readResource(uri, scope) {
      const resource = resourceByUri.get(uri);
      if (!resource) throw new McpFailure('UNKNOWN_RESOURCE', `未知资源：${uri}`);
      try {
        return await resource.read(scope);
      } catch (err) {
        if (isMcpFailure(err)) throw err;
        throw new McpFailure('RESOURCE_UNAVAILABLE', `资源 ${uri} 读取失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async getPrompt(name, args, scope) {
      const prompt = promptByName.get(name);
      if (!prompt) throw new McpFailure('UNKNOWN_PROMPT', `未知提示：${name}`);
      const input = args ?? {};
      for (const a of prompt.arguments ?? []) {
        if (a.required && !(a.name in input)) {
          throw new McpFailure('MISSING_PROMPT_ARGUMENT', `提示 ${name} 缺必填参数：${a.name}`);
        }
      }
      try {
        return await prompt.render(input, scope);
      } catch (err) {
        if (isMcpFailure(err)) throw err;
        throw new McpFailure('PROMPT_RENDER_FAILED', `提示 ${name} 渲染失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
