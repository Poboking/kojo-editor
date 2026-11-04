/**
 * @kojo/mcp-host —— 面向模型的能力面（冻结契约 v1）。
 *
 * 这一层只做三件事：**定义契约类型**、**把三路能力来源装配成工具/资源/提示清单**、
 * **按会话授权把守调用**。它不监听 Tauri 事件、不 import app/bridge/kernel/其它插件，
 * 也不认识任何游戏语义——具体能力的数据源一律通过 `deps` 注入（宿主/路 A 的
 * `host-bridge.ts` 负责装配）。所有失败都抛结构化 `{code,message}`（铁律 4：不静默）。
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
 * `items` / `enum` / `minimum` / `maximum`。不认识的关键字一律忽略（不因
 * "没实现校验" 而误拒合法入参），只拒绝**明确违反**已声明约束的取值。
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

export interface McpHostDeps {
  /** 命令面板登记命令 */
  readonly commands?: readonly McpCommandSource[];
  /** 语义读数（逐腿可缺席；缺席的腿仍列进工具，但调用时报 NOT_WIRED，可见不静默） */
  readonly semantic?: Partial<McpSemanticReaders>;
  /** kernel IO 只读能力 */
  readonly kernelIo?: Partial<McpKernelIo>;
  /** 内置 7 项 resource 的数据源：按 uri 供数；缺席 ⇒ read 报 RESOURCE_UNAVAILABLE */
  readonly readResourceData?: (uri: string, scope: McpSessionScope) => Promise<unknown> | unknown;
  /** 追加 / 覆盖 resource（同 uri 覆盖内置项） */
  readonly resources?: readonly McpResource[];
  /** mcp.prompt 槽贡献投影成的提示清单 */
  readonly prompts?: readonly McpPrompt[];
  /** 补齐功能（全工程检索 / quickfix / 文件树增删改 / diff / 状态回放 / 预览）的执行钩子 */
  readonly runSupplemental?: (name: string, args: Record<string, unknown>, scope: McpSessionScope) => Promise<unknown> | unknown;
}

/* ------------------------------------------------------------------ *
 * 5. 工具/资源清单常量（可导出对拍）
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

/** 补齐未登记成命令的功能（最小登记）；危险的一律 'privileged'。 */
export const SUPPLEMENTAL_TOOL_SPECS: readonly ToolSpec[] = [
  { name: 'workspace.searchAll', description: '全工程检索', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'problems.quickFix', description: '问题面板快速修复（执行修复动作）', inputSchema: { type: 'object' }, tier: 'edit' },
  { name: 'fileTree.create', description: '文件树新建', inputSchema: { type: 'object' }, tier: 'edit' },
  { name: 'fileTree.remove', description: '文件树删除（危险）', inputSchema: { type: 'object' }, tier: 'privileged', annotations: { destructiveHint: true } },
  { name: 'fileTree.rename', description: '文件树改名（危险）', inputSchema: { type: 'object' }, tier: 'privileged', annotations: { destructiveHint: true } },
  { name: 'diff.compare', description: '差异对比（只读）', inputSchema: { type: 'object' }, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'state.replay', description: '状态回放（只读）', inputSchema: { type: 'object' }, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'preview.document', description: '文档预览（2.0 面，只读）', inputSchema: { type: 'object' }, tier: 'read', annotations: { readOnlyHint: true } },
];

/** 内置 7 项 resource（≥6 的硬要求；插件状态要求 inactive 可见、含 missing[]）。 */
export interface McpResourceSpec {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType?: string;
}

export const MCP_RESOURCE_SPECS: readonly McpResourceSpec[] = [
  { uri: 'kojo://project/snapshot', name: '项目快照', description: '当前项目的一屏聚合快照', mimeType: 'application/json' },
  { uri: 'kojo://project/file-tree', name: '文件树', description: '项目根内文件树', mimeType: 'application/json' },
  { uri: 'kojo://project/diagnostics', name: '诊断', description: '当前诊断读数', mimeType: 'application/json' },
  { uri: 'kojo://project/validation-failures', name: '校验失败规则', description: '校验 report.failedRules', mimeType: 'application/json' },
  { uri: 'kojo://project/commands', name: '命令清单', description: '命令面板注册表清单', mimeType: 'application/json' },
  { uri: 'kojo://project/plugins', name: '插件状态', description: '插件状态（inactive 必须可见，含 missing[]）', mimeType: 'application/json' },
  { uri: 'kojo://project/events', name: '事件环形缓冲', description: '内核事件环形缓冲最近记录', mimeType: 'application/json' },
];

/* ------------------------------------------------------------------ *
 * 6. 装配 helper
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
 * 7. registry 工厂
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
      return { contents: [{ uri: spec.uri, text: toText(data) }] };
    },
  }));
  const resources: McpResource[] = [...builtinResources];
  for (const extra of deps.resources ?? []) {
    const at = resources.findIndex((r) => r.uri === extra.uri);
    if (at >= 0) resources[at] = extra;
    else resources.push(extra);
  }
  const resourceByUri = new Map(resources.map((r) => [r.uri, r]));

  const prompts = deps.prompts ?? [];
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
