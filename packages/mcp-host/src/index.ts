/**
 * @kojo/mcp-host —— 面向模型的能力面（冻结契约 v1；第二波：能力覆盖补齐 + 可读性 + 槽骨架）。
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

/** 语义读数服务 → 8 枚只读工具（tier 'read' + readOnlyHint）。 */
export const SEMANTIC_TOOL_SPECS: readonly ToolSpec[] = [
  { name: 'semantic.definitionAt', method: 'definitionAt', description: '转到定义（只读）', inputSchema: POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'semantic.referencesAt', method: 'referencesAt', description: '查找引用（只读）', inputSchema: POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'semantic.diagnostics', method: 'diagnostics', description: '当前文档诊断（只读）', inputSchema: { type: 'object' }, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'semantic.hoverAt', method: 'hoverAt', description: '悬停信息（只读）', inputSchema: POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'semantic.suggestAt', method: 'suggestAt', description: '补全候选（只读）', inputSchema: POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'semantic.documentSymbols', method: 'documentSymbols', description: '文档符号（只读）', inputSchema: { type: 'object' }, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'semantic.tokens', method: 'tokens', description: '词法 token（只读）', inputSchema: { type: 'object', properties: { lineFrom: { type: 'integer' }, lineTo: { type: 'integer' } } }, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'semantic.codeActionsAt', method: 'codeActionsAt', description: '可用代码动作（只读，绝不 apply）', inputSchema: POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
];

/** kernel IO → 3 枚只读工具。 */
export const KERNEL_IO_TOOL_SPECS: readonly ToolSpec[] = [
  { name: 'project.info', method: 'projectInfo', description: '当前项目信息（只读）', inputSchema: { type: 'object' }, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'fs.tree', method: 'fileTree', description: '项目文件树（只读）', inputSchema: { type: 'object' }, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'search.all', method: 'searchAll', description: '全工程检索（只读）', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, tier: 'read', annotations: { readOnlyHint: true } },
];

/**
 * 补齐「没登记成命令」的功能（最小登记）；危险的一律 'privileged' + destructiveHint。
 * 每条 description 面向模型：说明用途 / 入参 / 返回 / 副作用 / 只读或危险提示 / 路径约束。
 */
export const SUPPLEMENTAL_TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'workspace.searchAll',
    description:
      'Search the whole project for a text query and return file/line hits. Read-only: never mutates files. Use `query` for the case-insensitive substring, optional `scope` to restrict to source files, `maxResults` to cap the hit list. Returns {hits:[{path,line,preview}], total, truncated}.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 512, description: 'Substring to find (case-insensitive).' },
        scope: { type: 'string', enum: ['all', 'sources'], description: 'Restrict to source files or search all files (default all).' },
        maxResults: { type: 'integer', minimum: 1, maximum: 200, description: 'Cap on returned hits (default 50).' },
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
      'List current problems-panel diagnostics for the active document/project. Read-only. Returns {items:[{message,line,severity,source?}], total, truncated}. Inspect available actions before proposing any problems.quickFix; a `truncated:true` result means you must narrow the query, not assume completeness.',
    inputSchema: {
      type: 'object',
      properties: { maxResults: { type: 'integer', minimum: 1, maximum: 500, description: 'Cap on returned diagnostics (default 200).' } },
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
      'Overwrite the full text content of an existing file inside the authorized project root. `relPath` is project-root-relative (schema + approvedRoots domain check). This REPLACES the whole content; prefer problems.quickFix for targeted edits. Idempotent for identical `content`. Mutates the filesystem.',
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
];

/** 内置 8 项 resource（≥6 的硬要求；新增「当前文档与光标」，其余保持第一波 URI）。 */
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
    hint: 'Resource text exceeded the cap and was truncated. Narrow the query / read a specific sub-range; do NOT assume the preview is the complete content.',
  };
  return { text: JSON.stringify(envelope, null, 2), truncated: true };
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
  return { commands, total: items.length, truncated };
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
  return { diagnostics, total: items.length, truncated };
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
